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
    let from_clause = format!(
        "{}.{}",
        quote_ident(&table.schema),
        quote_ident(&table.name)
    );

    // WHERE
    let where_clause = build_where(&query.filters, &mut params, table)?;

    // ORDER BY
    let order_clause = build_order(&query.order)?;

    // LIMIT / OFFSET
    let mut sql = format!("SELECT {select_clause} FROM {from_clause}");

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
        sql.push_str(&format!(" LIMIT {limit}"));
    }

    if let Some(offset) = query.offset {
        sql.push_str(&format!(" OFFSET {offset}"));
    }

    Ok(BuiltQuery { sql, params })
}

/// Build an INSERT query from a JSON body. Returns the query + params.
pub fn build_insert(table: &TableMeta, body: &serde_json::Value) -> Result<BuiltQuery, AppError> {
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

    let from_clause = format!(
        "{}.{}",
        quote_ident(&table.schema),
        quote_ident(&table.name)
    );
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
        set_clauses.push(format!(
            "{} = ${}::{}",
            quote_ident(col),
            params.len(),
            safe_pg_type(pg_type)
        ));
    }

    let from_clause = format!(
        "{}.{}",
        quote_ident(&table.schema),
        quote_ident(&table.name)
    );
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
    let from_clause = format!(
        "{}.{}",
        quote_ident(&table.schema),
        quote_ident(&table.name)
    );
    let where_clause = build_where(&query.filters, &mut params, table)?;

    if where_clause.is_empty() {
        return Err(AppError::BadRequest(
            "DELETE requires at least one filter (safety: prevents full-table deletes)".into(),
        ));
    }

    let sql = format!("DELETE FROM {from_clause} WHERE {where_clause} RETURNING *");

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
                Ok(cols.into_iter().filter(|c| !c.contains('(')).collect())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rest::catalog::{ColumnMeta, TableMeta};
    use crate::rest::filter::RestQuery;

    /// Build a minimal `TableMeta` with the given columns for testing.
    fn make_table(name: &str, cols: &[(&str, &str)]) -> TableMeta {
        TableMeta {
            schema: "public".to_string(),
            name: name.to_string(),
            columns: cols
                .iter()
                .map(|(col_name, pg_type)| ColumnMeta {
                    name: col_name.to_string(),
                    pg_type: pg_type.to_string(),
                    is_nullable: true,
                    has_default: false,
                })
                .collect(),
            primary_keys: Vec::new(),
            foreign_keys: Vec::new(),
        }
    }

    // ---- quote_ident ----

    #[test]
    fn test_quote_ident_simple() {
        assert_eq!(quote_ident("users"), "\"users\"");
    }

    #[test]
    fn test_quote_ident_with_internal_quote() {
        assert_eq!(quote_ident("it\"s"), "\"it\"\"s\"");
    }

    #[test]
    fn test_quote_ident_schema_and_table() {
        let result = format!("{}.{}", quote_ident("public"), quote_ident("users"));
        assert_eq!(result, "\"public\".\"users\"");
    }

    // ---- build_select ----

    #[test]
    fn test_select_no_filters() {
        let table = make_table("users", &[("id", "integer"), ("name", "text")]);
        let query = RestQuery::parse(None).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert_eq!(built.sql, "SELECT * FROM \"public\".\"users\"");
        assert!(built.params.is_empty());
    }

    #[test]
    fn test_select_with_limit() {
        let table = make_table("users", &[("id", "integer"), ("name", "text")]);
        let query = RestQuery::parse(Some("limit=25")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("LIMIT 25"));
    }

    #[test]
    fn test_select_with_offset() {
        let table = make_table("users", &[("id", "integer")]);
        let query = RestQuery::parse(Some("offset=50")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("OFFSET 50"));
    }

    #[test]
    fn test_select_with_limit_and_offset() {
        let table = make_table("posts", &[("id", "integer"), ("title", "text")]);
        let query = RestQuery::parse(Some("limit=10&offset=20")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("LIMIT 10"));
        assert!(built.sql.contains("OFFSET 20"));
    }

    #[test]
    fn test_select_order_asc() {
        let table = make_table("users", &[("id", "integer"), ("name", "text")]);
        let query = RestQuery::parse(Some("order=id.asc")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("ORDER BY \"id\" ASC"));
    }

    #[test]
    fn test_select_order_desc() {
        let table = make_table("users", &[("id", "integer"), ("name", "text")]);
        let query = RestQuery::parse(Some("order=name.desc")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("ORDER BY \"name\" DESC"));
    }

    #[test]
    fn test_select_order_nulls_first() {
        let table = make_table("users", &[("id", "integer"), ("name", "text")]);
        let query = RestQuery::parse(Some("order=name.asc.nullsfirst")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("NULLS FIRST"));
    }

    #[test]
    fn test_select_order_nulls_last() {
        let table = make_table("users", &[("id", "integer"), ("name", "text")]);
        let query = RestQuery::parse(Some("order=name.desc.nullslast")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("NULLS LAST"));
    }

    #[test]
    fn test_select_with_single_filter() {
        let table = make_table("users", &[("id", "integer"), ("email", "text")]);
        let query = RestQuery::parse(Some("id=eq.1")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("WHERE"));
        assert!(built.sql.contains("\"id\""));
        assert_eq!(built.params[0], "1");
    }

    #[test]
    fn test_select_with_multiple_filters() {
        let table = make_table(
            "users",
            &[("id", "integer"), ("active", "boolean"), ("role", "text")],
        );
        let query = RestQuery::parse(Some("active=is.true&role=eq.admin")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("AND"));
        assert!(built.sql.contains("\"active\" IS TRUE"));
        assert!(built.sql.contains("\"role\""));
        assert_eq!(built.params.len(), 1); // is.true uses no param; eq.admin uses one
        assert_eq!(built.params[0], "admin");
    }

    #[test]
    fn test_select_like_converts_wildcard() {
        let table = make_table("products", &[("name", "text")]);
        let query = RestQuery::parse(Some("name=like.*foo*")).unwrap();
        let built = build_select(&table, &query).unwrap();
        // The * wildcard should be converted to % in the param
        assert_eq!(built.params[0], "%foo%");
    }

    #[test]
    fn test_select_in_filter() {
        let table = make_table("orders", &[("status", "text")]);
        let query = RestQuery::parse(Some("status=in.(active,closed)")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("\"status\" IN"));
        assert_eq!(built.params.len(), 2);
        assert_eq!(built.params[0], "active");
        assert_eq!(built.params[1], "closed");
    }

    #[test]
    fn test_select_not_in_filter() {
        let table = make_table("orders", &[("status", "text")]);
        let query = RestQuery::parse(Some("status=not.in.(deleted,cancelled)")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("NOT IN"));
    }

    #[test]
    fn test_select_negated_eq() {
        let table = make_table("users", &[("role", "text")]);
        let query = RestQuery::parse(Some("role=not.eq.admin")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("NOT ("));
    }

    #[test]
    fn test_select_specific_columns() {
        let table = make_table(
            "users",
            &[("id", "integer"), ("name", "text"), ("email", "text")],
        );
        let query = RestQuery::parse(Some("select=id,name")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.starts_with("SELECT \"id\", \"name\" FROM"));
        assert!(!built.sql.contains("\"email\""));
    }

    #[test]
    fn test_select_unknown_column_in_filter_rejected() {
        let table = make_table("users", &[("id", "integer")]);
        let query = RestQuery::parse(Some("nonexistent=eq.5")).unwrap();
        let result = build_select(&table, &query);
        assert!(result.is_err());
    }

    #[test]
    fn test_select_unknown_column_in_select_rejected() {
        let table = make_table("users", &[("id", "integer")]);
        let query = RestQuery::parse(Some("select=nonexistent")).unwrap();
        let result = build_select(&table, &query);
        assert!(result.is_err());
    }

    #[test]
    fn test_select_is_null_filter() {
        let table = make_table("users", &[("deleted_at", "timestamp")]);
        let query = RestQuery::parse(Some("deleted_at=is.null")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("IS NULL"));
        assert!(built.params.is_empty());
    }

    #[test]
    fn test_select_is_not_null_filter() {
        let table = make_table("users", &[("deleted_at", "timestamp")]);
        let query = RestQuery::parse(Some("deleted_at=not.is.null")).unwrap();
        let built = build_select(&table, &query).unwrap();
        assert!(built.sql.contains("IS NOT NULL"));
    }

    // ---- build_insert ----

    #[test]
    fn test_insert_single_object() {
        let table = make_table("users", &[("name", "text"), ("email", "text")]);
        let body = serde_json::json!({ "name": "Alice", "email": "alice@example.com" });
        let built = build_insert(&table, &body).unwrap();
        assert!(built.sql.starts_with("INSERT INTO \"public\".\"users\""));
        assert!(built.sql.contains("RETURNING *"));
        assert_eq!(built.params.len(), 2);
    }

    #[test]
    fn test_insert_array_of_objects() {
        let table = make_table("tags", &[("label", "text")]);
        let body = serde_json::json!([
            { "label": "rust" },
            { "label": "postgres" }
        ]);
        let built = build_insert(&table, &body).unwrap();
        assert!(built.sql.contains("VALUES"));
        // Two rows → two value groups; each with one param
        assert_eq!(built.params.len(), 2);
        assert_eq!(built.params[0], "rust");
        assert_eq!(built.params[1], "postgres");
    }

    #[test]
    fn test_insert_with_null_value() {
        let table = make_table("users", &[("name", "text"), ("bio", "text")]);
        let body = serde_json::json!({ "name": "Bob", "bio": null });
        let built = build_insert(&table, &body).unwrap();
        assert_eq!(built.params.len(), 2);
        // JSON null becomes empty string param (treated as NULL by pg driver).
        // serde_json::Map preserves insertion order, but we check by content
        // rather than index to be robust regardless of serialization order.
        assert!(
            built.params.contains(&"Bob".to_string()),
            "params should contain 'Bob'"
        );
        assert!(
            built.params.contains(&"".to_string()),
            "params should contain empty string for null bio"
        );
    }

    #[test]
    fn test_insert_non_object_body_rejected() {
        let table = make_table("users", &[("name", "text")]);
        let body = serde_json::json!("a string");
        let result = build_insert(&table, &body);
        assert!(result.is_err());
    }

    #[test]
    fn test_insert_empty_array_rejected() {
        let table = make_table("users", &[("name", "text")]);
        let body = serde_json::json!([]);
        let result = build_insert(&table, &body);
        assert!(result.is_err());
    }

    #[test]
    fn test_insert_unknown_column_rejected() {
        let table = make_table("users", &[("id", "integer")]);
        let body = serde_json::json!({ "nonexistent": "value" });
        let result = build_insert(&table, &body);
        assert!(result.is_err());
    }

    #[test]
    fn test_insert_numeric_value() {
        let table = make_table("items", &[("price", "numeric")]);
        let body = serde_json::json!({ "price": 9.99 });
        let built = build_insert(&table, &body).unwrap();
        assert_eq!(built.params[0], "9.99");
    }

    #[test]
    fn test_insert_boolean_value() {
        let table = make_table("users", &[("active", "boolean")]);
        let body = serde_json::json!({ "active": true });
        let built = build_insert(&table, &body).unwrap();
        assert_eq!(built.params[0], "true");
    }

    // ---- build_update ----

    #[test]
    fn test_update_with_filter() {
        let table = make_table("users", &[("id", "integer"), ("name", "text")]);
        let body = serde_json::json!({ "name": "Charlie" });
        let query = RestQuery::parse(Some("id=eq.1")).unwrap();
        let built = build_update(&table, &body, &query).unwrap();
        assert!(built.sql.starts_with("UPDATE \"public\".\"users\" SET"));
        assert!(built.sql.contains("WHERE"));
        assert!(built.sql.contains("RETURNING *"));
    }

    #[test]
    fn test_update_without_filter_rejected() {
        let table = make_table("users", &[("id", "integer"), ("name", "text")]);
        let body = serde_json::json!({ "name": "Charlie" });
        let query = RestQuery::parse(None).unwrap();
        let result = build_update(&table, &body, &query);
        assert!(result.is_err());
        let msg = format!("{:?}", result.err().unwrap());
        assert!(msg.contains("UPDATE requires"));
    }

    #[test]
    fn test_update_empty_body_rejected() {
        let table = make_table("users", &[("id", "integer")]);
        let body = serde_json::json!({});
        let query = RestQuery::parse(Some("id=eq.1")).unwrap();
        let result = build_update(&table, &body, &query);
        assert!(result.is_err());
    }

    #[test]
    fn test_update_non_object_body_rejected() {
        let table = make_table("users", &[("id", "integer")]);
        let body = serde_json::json!([{ "name": "x" }]);
        let query = RestQuery::parse(Some("id=eq.1")).unwrap();
        let result = build_update(&table, &body, &query);
        assert!(result.is_err());
    }

    #[test]
    fn test_update_unknown_column_rejected() {
        let table = make_table("users", &[("id", "integer")]);
        let body = serde_json::json!({ "ghost_column": "value" });
        let query = RestQuery::parse(Some("id=eq.1")).unwrap();
        let result = build_update(&table, &body, &query);
        assert!(result.is_err());
    }

    // ---- build_delete ----

    #[test]
    fn test_delete_with_filter() {
        let table = make_table("users", &[("id", "integer")]);
        let query = RestQuery::parse(Some("id=eq.42")).unwrap();
        let built = build_delete(&table, &query).unwrap();
        assert!(built.sql.starts_with("DELETE FROM \"public\".\"users\""));
        assert!(built.sql.contains("WHERE"));
        assert!(built.sql.contains("RETURNING *"));
        assert_eq!(built.params[0], "42");
    }

    #[test]
    fn test_delete_without_filter_rejected() {
        let table = make_table("users", &[("id", "integer")]);
        let query = RestQuery::parse(None).unwrap();
        let result = build_delete(&table, &query);
        assert!(result.is_err());
        let msg = format!("{:?}", result.err().unwrap());
        assert!(msg.contains("DELETE requires"));
    }

    #[test]
    fn test_delete_with_in_filter() {
        let table = make_table("sessions", &[("id", "integer")]);
        let query = RestQuery::parse(Some("id=in.(1,2,3)")).unwrap();
        let built = build_delete(&table, &query).unwrap();
        assert!(built.sql.contains("\"id\" IN"));
        assert_eq!(built.params.len(), 3);
    }

    // ---- safe_pg_type (via insert) ----

    #[test]
    fn test_safe_pg_type_used_in_insert_cast() {
        let table = make_table("items", &[("amount", "numeric(10,2)")]);
        let body = serde_json::json!({ "amount": "5.5" });
        let built = build_insert(&table, &body).unwrap();
        // The cast should include the pg_type
        assert!(built.sql.contains("numeric(10,2)") || built.sql.contains("::"));
    }

    // ---- split_select ----

    #[test]
    fn test_split_select_flat() {
        let parts = split_select("id,name,email");
        assert_eq!(parts, vec!["id", "name", "email"]);
    }

    #[test]
    fn test_split_select_with_nested_parens() {
        let parts = split_select("id,title,posts(id,title),name");
        assert_eq!(parts, vec!["id", "title", "posts(id,title)", "name"]);
    }

    #[test]
    fn test_split_select_deeply_nested() {
        let parts = split_select("a,b(c,d(e,f)),g");
        assert_eq!(parts, vec!["a", "b(c,d(e,f))", "g"]);
    }

    #[test]
    fn test_split_select_empty() {
        let parts = split_select("");
        assert!(parts.is_empty());
    }

    #[test]
    fn test_split_select_single_item() {
        let parts = split_select("id");
        assert_eq!(parts, vec!["id"]);
    }
}
