use axum::extract::{OriginalUri, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use sqlx::Row;

use crate::error::AppError;
use crate::middleware::rls::{rls_transaction, RequestClaims};
use crate::rest::embed::{self, ResolvedEmbed};
use crate::rest::filter::RestQuery;
use crate::rest::query_builder;
use crate::state::AppState;

/// GET /rest/v1/{table} — Select rows with filters, ordering, pagination, embedding.
pub async fn select_rows(
    State(state): State<AppState>,
    Path(table_name): Path<String>,
    claims: RequestClaims,
    uri: OriginalUri,
) -> Result<impl IntoResponse, AppError> {
    let table = state
        .catalog
        .get_table(&table_name)
        .await
        .ok_or_else(|| AppError::NotFound(format!("table '{table_name}' not found")))?;

    let query = RestQuery::parse(uri.0.query())?;

    // Parse and resolve embeds from ?select=*,relation(cols)
    let embed_requests = embed::parse_embeds(query.select.as_deref());
    let mut resolved_embeds: Vec<ResolvedEmbed> = Vec::new();
    for er in &embed_requests {
        resolved_embeds.push(embed::resolve_embed(&state.catalog, &table, er).await?);
    }

    if resolved_embeds.is_empty() {
        let built = query_builder::build_select(&table, &query)?;
        let mut tx = rls_transaction(&state.pg_pool, &claims).await?;
        let rows = execute_select_json(&mut tx, &built).await?;
        tx.commit().await?;
        Ok(Json(rows))
    } else {
        // For embeds, force SELECT * in the base CTE so FK columns are available
        // for lateral joins. User column selection is applied in the outer query.
        let user_columns = query.select.clone();
        let mut base_query = query;
        base_query.select = None; // None = SELECT *
        let built = query_builder::build_select(&table, &base_query)?;
        let mut tx = rls_transaction(&state.pg_pool, &claims).await?;
        let rows = execute_select_with_embeds(
            &mut tx,
            &built,
            &table,
            &resolved_embeds,
            user_columns.as_deref(),
        )
        .await?;
        tx.commit().await?;
        Ok(Json(rows))
    }
}

/// POST /rest/v1/{table} — Insert row(s).
pub async fn insert_rows(
    State(state): State<AppState>,
    Path(table_name): Path<String>,
    claims: RequestClaims,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<impl IntoResponse, AppError> {
    let table = state
        .catalog
        .get_table(&table_name)
        .await
        .ok_or_else(|| AppError::NotFound(format!("table '{table_name}' not found")))?;

    let built = query_builder::build_insert(&table, &body)?;

    let mut tx = rls_transaction(&state.pg_pool, &claims).await?;

    let rows = execute_dml_json(&mut tx, &built).await?;

    tx.commit().await?;

    // Prefer: return=representation (default) vs return=minimal
    let prefer = headers
        .get("prefer")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("return=representation");

    if prefer.contains("return=minimal") {
        Ok((StatusCode::CREATED, Json(serde_json::Value::Null)).into_response())
    } else {
        // Return single object if single insert, array if bulk
        match body {
            serde_json::Value::Array(_) => {
                Ok((StatusCode::CREATED, Json(serde_json::Value::Array(rows))).into_response())
            }
            _ => {
                let single = rows.into_iter().next().unwrap_or(serde_json::Value::Null);
                Ok((StatusCode::CREATED, Json(single)).into_response())
            }
        }
    }
}

/// PATCH /rest/v1/{table} — Update rows matching filters.
pub async fn update_rows(
    State(state): State<AppState>,
    Path(table_name): Path<String>,
    claims: RequestClaims,
    uri: OriginalUri,
    Json(body): Json<serde_json::Value>,
) -> Result<impl IntoResponse, AppError> {
    let table = state
        .catalog
        .get_table(&table_name)
        .await
        .ok_or_else(|| AppError::NotFound(format!("table '{table_name}' not found")))?;

    let query = RestQuery::parse(uri.0.query())?;
    let built = query_builder::build_update(&table, &body, &query)?;

    let mut tx = rls_transaction(&state.pg_pool, &claims).await?;

    let rows = execute_dml_json(&mut tx, &built).await?;

    tx.commit().await?;

    Ok(Json(serde_json::Value::Array(rows)))
}

/// DELETE /rest/v1/{table} — Delete rows matching filters.
pub async fn delete_rows(
    State(state): State<AppState>,
    Path(table_name): Path<String>,
    claims: RequestClaims,
    uri: OriginalUri,
) -> Result<impl IntoResponse, AppError> {
    let table = state
        .catalog
        .get_table(&table_name)
        .await
        .ok_or_else(|| AppError::NotFound(format!("table '{table_name}' not found")))?;

    let query = RestQuery::parse(uri.0.query())?;
    let built = query_builder::build_delete(&table, &query)?;

    let mut tx = rls_transaction(&state.pg_pool, &claims).await?;

    let rows = execute_dml_json(&mut tx, &built).await?;

    tx.commit().await?;

    Ok(Json(serde_json::Value::Array(rows)))
}

/// Execute a SELECT query and return rows as JSON values.
async fn execute_select_json(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    built: &query_builder::BuiltQuery,
) -> Result<Vec<serde_json::Value>, AppError> {
    // Wrap SELECT in row_to_json for JSON output
    let wrapped = format!("SELECT row_to_json(t) AS data FROM ({}) t", built.sql);

    let mut q = sqlx::query(&wrapped);
    for param in &built.params {
        q = q.bind(param);
    }

    let rows = q.fetch_all(&mut **tx).await?;

    Ok(rows
        .iter()
        .map(|row| row.get::<serde_json::Value, _>("data"))
        .collect())
}

/// Execute a SELECT with resource embedding (lateral subqueries for FK joins).
/// Supports nested/transitive embeds via recursive lateral subquery generation.
async fn execute_select_with_embeds(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    built: &query_builder::BuiltQuery,
    _parent: &crate::rest::catalog::TableMeta,
    embeds: &[ResolvedEmbed],
    user_columns: Option<&str>,
) -> Result<Vec<serde_json::Value>, AppError> {
    // Build a query that includes lateral subqueries for each embed.
    // Strategy: wrap the base query in a CTE, then select from it with
    // lateral subqueries that produce JSON arrays/objects for each embed.
    // Nested embeds are handled recursively inside build_lateral_sql.

    let parent_alias = "base";
    let mut lateral_selects: Vec<String> = Vec::new();
    let mut lateral_joins: Vec<String> = Vec::new();

    // Global counter ensures unique aliases across all nesting levels.
    let mut global_counter: usize = 0;

    for emb in embeds {
        let (select_expr, join_clause) =
            embed::build_lateral_sql(emb, parent_alias, &mut global_counter);
        lateral_selects.push(select_expr);
        lateral_joins.push(join_clause);
    }

    // Build final query:
    // WITH base AS (SELECT * FROM table WHERE ...)
    // SELECT row_to_json(combined) AS data FROM (
    //   SELECT base.col1, base.col2, _e0.data AS comments, _e1.data AS author
    //   FROM base
    //   LEFT JOIN LATERAL (...) _e0 ON true
    //   LEFT JOIN LATERAL (...) _e1 ON true
    // ) combined
    let embed_cols = lateral_selects.join(", ");
    let joins = lateral_joins.join(" ");

    // Determine which parent columns to include in the outer SELECT.
    // If user specified columns (not * and not just embeds), list them explicitly.
    let parent_cols = match user_columns {
        Some(sel) => {
            // Parse the select string to get non-embed columns
            let cols: Vec<String> = query_builder::split_select(sel)
                .into_iter()
                .filter(|c| !c.contains('(') && c != "*")
                .collect();
            if cols.is_empty() {
                // User had * or only embeds -> select all parent columns
                format!("{parent_alias}.*")
            } else {
                cols.iter()
                    .map(|c| format!("{}.{}", parent_alias, query_builder::quote_ident(c)))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        }
        None => format!("{parent_alias}.*"),
    };

    let sql = format!(
        "WITH {pa} AS ({base_sql}) \
         SELECT row_to_json(combined) AS data FROM (\
            SELECT {parent_cols}, {embed_cols} FROM {pa} {joins}\
         ) combined",
        pa = parent_alias,
        base_sql = built.sql,
        parent_cols = parent_cols,
        embed_cols = embed_cols,
        joins = joins,
    );

    let mut q = sqlx::query(&sql);
    for param in &built.params {
        q = q.bind(param);
    }

    let rows = q.fetch_all(&mut **tx).await?;

    Ok(rows
        .iter()
        .map(|row| row.get::<serde_json::Value, _>("data"))
        .collect())
}

/// Execute a DML query (INSERT/UPDATE/DELETE with RETURNING *) and return rows as JSON.
async fn execute_dml_json(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    built: &query_builder::BuiltQuery,
) -> Result<Vec<serde_json::Value>, AppError> {
    // For DML with RETURNING, use a CTE to get JSON output
    let wrapped = format!(
        "WITH result AS ({}) SELECT row_to_json(result) AS data FROM result",
        built.sql
    );

    let mut q = sqlx::query(&wrapped);
    for param in &built.params {
        q = q.bind(param);
    }

    let rows = q.fetch_all(&mut **tx).await?;

    Ok(rows
        .iter()
        .map(|row| row.get::<serde_json::Value, _>("data"))
        .collect())
}
