use crate::error::AppError;
use crate::rest::catalog::TableMeta;
use crate::rest::filter::{Filter, FilterOp, RestQuery};

/// Built SQL query with parameter values.
pub struct BuiltQuery {
    pub sql: String,
    pub params: Vec<String>,
}

/// Build a SELECT query from RestQuery + TableMeta.
pub fn build_select(table: &TableMeta, query: &RestQuery) -> Result<BuiltQuery, AppError> {
    let mut params: Vec<String> = Vec::new();

    // SELECT columns
    let columns = resolve_columns(table, query.select.as_deref())?;
    let select_clause = if columns.is_empty() {
        "*".to_string()
    } else {
        columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ")
    };

    // FROM
    let from_clause = format!("{}.{}", quote_ident(&table.schema), quote_ident(&table.name));

    // WHERE
    let where_clause = build_where(&query.filters, &mut params, table)?;

    // ORDER BY
    let order_clause = build_order(&query.order)?;

    // LIMIT / OFFSET
    let mut sql = format!("SELECT {} FROM {}", select_clause, from_clause);

    if !where_clause.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_clause);
    }

    if !order_clause.is_empty() {
        sql.push_str(" ORDER BY ");
        sql.push_str(&order_clause);
    }

    // LIMIT/OFFSET are safe to inline (already validated as i64)
    if let Some(limit) = query.limit {
        sql.push_str(&format!(" LIMIT {}", limit));
    }

    if let Some(offset) = query.offset {
        sql.push_str(&format!(" OFFSET {}", offset));
    }

    Ok(BuiltQuery { sql, params })
}

/// Build an INSERT query from a JSON body. Returns the query + params.
pub fn build_insert(
    table: &TableMeta,
    body: &serde_json::Value,
) -> Result<BuiltQuery, AppError> {
    let rows = match body {
        serde_json::Value::Array(arr) => arr.clone(),
        serde_json::Value::Object(_) => vec![body.clone()],
        _ => return Err(AppError::BadRequest("body must be object or array".into())),
    };

    if rows.is_empty() {
        return Err(AppError::BadRequest("empty body".into()));
    }

    // Use first row's keys as columns
    let first = rows[0]
        .as_object()
        .ok_or_else(|| AppError::BadRequest("each row must be an object".into()))?;

    let col_names: Vec<String> = first.keys().cloned().collect();

    // Validate columns exist
    for col in &col_names {
        validate_column(table, col)?;
    }

    let mut params: Vec<String> = Vec::new();
    let mut value_groups: Vec<String> = Vec::new();

    // Get PG types for each column
    let col_types: Vec<&str> = col_names
        .iter()
        .map(|c| {
            table
                .columns
                .iter()
                .find(|tc| tc.name == *c)
                .map(|tc| tc.pg_type.as_str())
                .unwrap_or("text")
        })
        .collect();

    for row in &rows {
        let obj = row
            .as_object()
            .ok_or_else(|| AppError::BadRequest("each row must be an object".into()))?;

        let mut placeholders = Vec::new();
        for (i, col) in col_names.iter().enumerate() {
            let val = obj.get(col).unwrap_or(&serde_json::Value::Null);
            params.push(json_to_pg_param(val));
            placeholders.push(format!("${}::{}", params.len(), safe_pg_type(col_types[i])));
        }
        value_groups.push(format!("({})", placeholders.join(", ")));
    }

    let from_clause = format!("{}.{}", quote_ident(&table.schema), quote_ident(&table.name));
    let col_list = col_names
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        "INSERT INTO {} ({}) VALUES {} RETURNING *",
        from_clause,
        col_list,
        value_groups.join(", ")
    );

    Ok(BuiltQuery { sql, params })
}

/// Build an UPDATE query.
pub fn build_update(
    table: &TableMeta,
    body: &serde_json::Value,
    query: &RestQuery,
) -> Result<BuiltQuery, AppError> {
    let obj = body
        .as_object()
        .ok_or_else(|| AppError::BadRequest("body must be an object".into()))?;

    if obj.is_empty() {
        return Err(AppError::BadRequest("empty update body".into()));
    }

    let mut params: Vec<String> = Vec::new();
    let mut set_clauses: Vec<String> = Vec::new();

    for (col, val) in obj {
        validate_column(table, col)?;
        let pg_type = table
            .columns
            .iter()
            .find(|c| c.name == *col)
            .map(|c| c.pg_type.as_str())
            .unwrap_or("text");
        params.push(json_to_pg_param(val));
        set_clauses.push(format!("{} = ${}::{}", quote_ident(col), params.len(), safe_pg_type(pg_type)));
    }

    let from_clause = format!("{}.{}", quote_ident(&table.schema), quote_ident(&table.name));
    let where_clause = build_where(&query.filters, &mut params, table)?;

    if where_clause.is_empty() {
        return Err(AppError::BadRequest(
            "UPDATE requires at least one filter (safety: prevents full-table updates)".into(),
        ));
    }

    let sql = format!(
        "UPDATE {} SET {} WHERE {} RETURNING *",
        from_clause,
        set_clauses.join(", "),
        where_clause
    );

    Ok(BuiltQuery { sql, params })
}

/// Build a DELETE query.
pub fn build_delete(table: &TableMeta, query: &RestQuery) -> Result<BuiltQuery, AppError> {
    let mut params: Vec<String> = Vec::new();
    let from_clause = format!("{}.{}", quote_ident(&table.schema), quote_ident(&table.name));
    let where_clause = build_where(&query.filters, &mut params, table)?;

    if where_clause.is_empty() {
        return Err(AppError::BadRequest(
            "DELETE requires at least one filter (safety: prevents full-table deletes)".into(),
        ));
    }

    let sql = format!(
        "DELETE FROM {} WHERE {} RETURNING *",
        from_clause, where_clause
    );

    Ok(BuiltQuery { sql, params })
}

/// Validate a pg_type string before interpolation into SQL.
/// Only allows alphanumeric, underscore, space, brackets, parentheses, dots, commas.
/// Returns "text" as safe fallback for any invalid type.
fn safe_pg_type(pg_type: &str) -> &str {
    if pg_type
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || " _[].(),".contains(c))
    {
        pg_type
    } else {
        "text"
    }
}

// ---- Internal helpers ----

fn resolve_columns(table: &TableMeta, select: Option<&str>) -> Result<Vec<String>, AppError> {
    match select {
        None | Some("*") => Ok(Vec::new()), // * = all columns
        Some(s) => {
            let cols = split_select(s);
            let mut has_star = false;
            for col in &cols {
                // Skip embedded relations (e.g., "posts(id,title)")
                if col.contains('(') {
                    continue;
                }
                // Skip wildcard (used alongside embeds like "select=*,posts(id)")
                if col == "*" {
                    has_star = true;
                    continue;
                }
                validate_column(table, col)?;
            }
            // If there was a *, return empty (= all columns)
            if has_star {
                Ok(Vec::new())
            } else {
                Ok(cols
                    .into_iter()
                    .filter(|c| !c.contains('('))
                    .collect())
            }
        }
    }
}

/// Split a select string by commas, respecting parentheses nesting.
/// "id,title,posts(id,title),name" → ["id", "title", "posts(id,title)", "name"]
pub fn split_select(s: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut depth = 0;

    for ch in s.chars() {
        match ch {
            '(' => {
                depth += 1;
                current.push(ch);
            }
            ')' => {
                depth -= 1;
                current.push(ch);
            }
            ',' if depth == 0 => {
                let trimmed = current.trim().to_string();
                if !trimmed.is_empty() {
                    result.push(trimmed);
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }

    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        result.push(trimmed);
    }

    result
}

fn validate_column(table: &TableMeta, col: &str) -> Result<(), AppError> {
    if !table.columns.iter().any(|c| c.name == col) {
        return Err(AppError::BadRequest(format!(
            "column '{}' not found in table '{}'",
            col, table.name
        )));
    }
    Ok(())
}

fn build_where(
    filters: &[Filter],
    params: &mut Vec<String>,
    table: &TableMeta,
) -> Result<String, AppError> {
    let mut conditions: Vec<String> = Vec::new();

    for f in filters {
        validate_column(table, &f.column)?;

        // Get PG type for casting
        let pg_type = table
            .columns
            .iter()
            .find(|c| c.name == f.column)
            .map(|c| c.pg_type.as_str())
            .unwrap_or("text");

        let condition = match f.operator {
            FilterOp::Is => {
                // IS NULL / IS NOT NULL / IS TRUE / IS FALSE
                let is_val = match f.value.to_lowercase().as_str() {
                    "null" => "NULL",
                    "true" => "TRUE",
                    "false" => "FALSE",
                    _ => {
                        return Err(AppError::BadRequest(format!(
                            "is operator requires null, true, or false; got '{}'",
                            f.value
                        )))
                    }
                };
                if f.negate {
                    format!("{} IS NOT {}", quote_ident(&f.column), is_val)
                } else {
                    format!("{} IS {}", quote_ident(&f.column), is_val)
                }
            }
            FilterOp::In => {
                // value is "(val1,val2,val3)"
                let inner = f
                    .value
                    .strip_prefix('(')
                    .and_then(|s| s.strip_suffix(')'))
                    .ok_or_else(|| {
                        AppError::BadRequest(format!(
                            "in operator requires (val1,val2,...); got '{}'",
                            f.value
                        ))
                    })?;

                let values: Vec<&str> = inner.split(',').collect();
                let mut placeholders = Vec::new();
                for v in values {
                    params.push(v.to_string());
                    placeholders.push(format!("${}::{}", params.len(), safe_pg_type(pg_type)));
                }

                let in_list = placeholders.join(", ");
                if f.negate {
                    format!("{} NOT IN ({})", quote_ident(&f.column), in_list)
                } else {
                    format!("{} IN ({})", quote_ident(&f.column), in_list)
                }
            }
            FilterOp::Like | FilterOp::Ilike => {
                // Convert PostgREST wildcards: * -> %
                let pg_pattern = f.value.replace('*', "%");
                params.push(pg_pattern);
                let op = f.operator.sql_op();
                if f.negate {
                    format!("{} NOT {} ${}", quote_ident(&f.column), op, params.len())
                } else {
                    format!("{} {} ${}", quote_ident(&f.column), op, params.len())
                }
            }
            _ => {
                params.push(f.value.clone());
                let cast = format!("${}::{}", params.len(), safe_pg_type(pg_type));
                let op = f.operator.sql_op();
                if f.negate {
                    format!("NOT ({} {} {})", quote_ident(&f.column), op, cast)
                } else {
                    format!("{} {} {}", quote_ident(&f.column), op, cast)
                }
            }
        };

        conditions.push(condition);
    }

    Ok(conditions.join(" AND "))
}

fn build_order(orders: &[super::filter::OrderClause]) -> Result<String, AppError> {
    if orders.is_empty() {
        return Ok(String::new());
    }

    let parts: Vec<String> = orders
        .iter()
        .map(|o| {
            let mut s = quote_ident(&o.column);
            s.push_str(if o.ascending { " ASC" } else { " DESC" });
            if let Some(nf) = o.nulls_first {
                s.push_str(if nf { " NULLS FIRST" } else { " NULLS LAST" });
            }
            s
        })
        .collect();

    Ok(parts.join(", "))
}

/// Indicates if a param value should be treated as SQL NULL.
fn is_null_param(val: &serde_json::Value) -> bool {
    val.is_null()
}

fn json_to_pg_param(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        // JSON objects/arrays: serialize to JSON string
        _ => val.to_string(),
    }
}

/// Quote a SQL identifier to prevent injection.
pub fn quote_ident(name: &str) -> String {
    // Double any internal quotes and wrap in double quotes
    format!("\"{}\"", name.replace('"', "\"\""))
}
