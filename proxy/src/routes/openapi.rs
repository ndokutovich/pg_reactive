//! OpenAPI 3.0 auto-generation from the PostgreSQL catalog.
//!
//! Port of Go `routes/openapi.go`. Served on both `/rest/v1` and `/rest/v1/`,
//! the spec is rebuilt on every request so it always reflects the latest
//! catalog state (after `POST /api/catalog/refresh`). No auth gate — mirrors
//! Go, where `OpenAPISpec` lives in the SecurityHeaders group but performs no
//! role check.

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Map, Value};

use crate::rest::catalog::TableMeta;
use crate::state::AppState;

/// GET `/rest/v1` and `/rest/v1/` — serve the auto-generated OpenAPI 3.0 doc.
pub async fn openapi_spec(State(state): State<AppState>) -> Response {
    let mut tables = state.catalog.list_tables("").await;
    // Deterministic output: sort by schema.name (mirror Go's sort.Slice).
    tables.sort_by(|a, b| {
        let ka = format!("{}.{}", a.schema, a.name);
        let kb = format!("{}.{}", b.schema, b.name);
        ka.cmp(&kb)
    });

    let spec = build_openapi_spec(&tables);
    // Pretty-print with 2-space indent to mirror Go's json.Encoder.SetIndent.
    let body = serde_json::to_string_pretty(&spec).unwrap_or_else(|_| "{}".to_string());
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        body,
    )
        .into_response()
}

/// Schema/path key for a table: bare name for `public`, `schema__name` otherwise
/// (mirror Go).
fn schema_key(tm: &TableMeta) -> String {
    if tm.schema == "public" {
        tm.name.clone()
    } else {
        format!("{}__{}", tm.schema, tm.name)
    }
}

/// Assemble the complete OpenAPI 3.0 document.
fn build_openapi_spec(tables: &[TableMeta]) -> Value {
    let mut paths = Map::new();
    let mut schemas = Map::new();

    for tm in tables {
        let key = schema_key(tm);
        let schema_ref = format!("#/components/schemas/{key}");

        schemas.insert(key.clone(), build_table_schema(tm));
        let path = format!("/rest/v1/{key}");
        paths.insert(path, build_table_path_item(tm, &schema_ref));
    }

    // RPC path (generic template).
    paths.insert("/rest/v1/rpc/{function}".to_string(), build_rpc_path_item());

    json!({
        "openapi": "3.0.3",
        "info": {
            "title": "pgStack REST API",
            "version": "1.0.0",
            "description": "Auto-generated from PostgreSQL catalog",
        },
        "paths": Value::Object(paths),
        "components": {
            "schemas": Value::Object(schemas),
            "securitySchemes": build_security_schemes(),
        },
        "security": [
            { "BearerAuth": [] },
            { "ApiKeyAuth": [] },
        ],
    })
}

fn build_security_schemes() -> Value {
    json!({
        "BearerAuth": {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "JWT",
            "description": "JWT access token",
        },
        "ApiKeyAuth": {
            "type": "apiKey",
            "in": "header",
            "name": "apikey",
            "description": "API key for anonymous or service-role access",
        },
    })
}

/// Generate an OpenAPI schema object for a table.
fn build_table_schema(tm: &TableMeta) -> Value {
    let mut properties = Map::new();
    let mut required: Vec<String> = Vec::new();

    for col in &tm.columns {
        properties.insert(col.name.clone(), pg_type_to_openapi(&col.pg_type));
        // Required for inserts when NOT NULL and no default (mirror Go).
        if !col.is_nullable && !col.has_default {
            required.push(col.name.clone());
        }
    }

    let mut schema = Map::new();
    schema.insert("type".to_string(), json!("object"));
    schema.insert("properties".to_string(), Value::Object(properties));
    if !required.is_empty() {
        required.sort();
        schema.insert("required".to_string(), json!(required));
    }
    Value::Object(schema)
}

/// Map a PostgreSQL type name to an OpenAPI property schema. Accepts both the
/// `format_type()` display names this catalog stores (e.g. `character varying`,
/// `timestamp with time zone`, `integer[]`) and the short `pg_type.typname`
/// forms Go uses (e.g. `int4`, `timestamptz`, `_int4`), so the structure
/// matches Go regardless of the catalog's type-name flavour.
fn pg_type_to_openapi(pg_type: &str) -> Value {
    let t = pg_type.trim();
    // Array types: `integer[]` (format_type) or `_int4` (typname).
    if let Some(elem) = t.strip_suffix("[]") {
        return json!({ "type": "array", "items": pg_type_to_openapi(elem.trim()) });
    }
    if let Some(elem) = t.strip_prefix('_') {
        return json!({ "type": "array", "items": pg_type_to_openapi(elem) });
    }
    // Strip any precision/length suffix: `character varying(255)` -> `character varying`,
    // `numeric(10,2)` -> `numeric`.
    let base = t.split('(').next().unwrap_or(t).trim();

    match base {
        // Integers.
        "smallint" | "integer" | "int2" | "int4" | "serial" => json!({ "type": "integer" }),
        "bigint" | "int8" | "bigserial" => json!({ "type": "integer", "format": "int64" }),
        // Floating-point / numeric.
        "real" | "double precision" | "numeric" | "decimal" | "float4" | "float8" => {
            json!({ "type": "number" })
        }
        // Boolean.
        "boolean" | "bool" => json!({ "type": "boolean" }),
        // String types.
        "text" | "character varying" | "character" | "varchar" | "bpchar" | "char" | "name" => {
            json!({ "type": "string" })
        }
        "uuid" => json!({ "type": "string", "format": "uuid" }),
        "timestamp with time zone"
        | "timestamp without time zone"
        | "timestamptz"
        | "timestamp" => json!({ "type": "string", "format": "date-time" }),
        "date" => json!({ "type": "string", "format": "date" }),
        "time without time zone" | "time with time zone" | "time" | "timetz" => {
            json!({ "type": "string", "format": "time" })
        }
        // Binary.
        "bytea" => json!({ "type": "string", "format": "byte" }),
        // JSON types — free-form objects.
        "jsonb" | "json" => json!({}),
        _ => json!({ "type": "string" }),
    }
}

fn build_table_path_item(tm: &TableMeta, schema_ref: &str) -> Value {
    let filter_params = build_filter_parameters(tm);
    json!({
        "get": build_get_operation(tm, schema_ref, &filter_params),
        "post": build_post_operation(tm, schema_ref),
        "patch": build_patch_operation(tm, schema_ref, &filter_params),
        "delete": build_delete_operation(tm, schema_ref, &filter_params),
    })
}

fn build_filter_parameters(tm: &TableMeta) -> Vec<Value> {
    let mut params = vec![
        json!({
            "name": "select",
            "in": "query",
            "required": false,
            "description": "Columns to return (comma-separated). Supports embedding: relation(*)",
            "schema": { "type": "string" },
        }),
        json!({
            "name": "order",
            "in": "query",
            "required": false,
            "description": "Ordering: column.asc or column.desc (comma-separated)",
            "schema": { "type": "string" },
        }),
        json!({
            "name": "limit",
            "in": "query",
            "required": false,
            "description": "Maximum number of rows to return",
            "schema": { "type": "integer" },
        }),
        json!({
            "name": "offset",
            "in": "query",
            "required": false,
            "description": "Number of rows to skip before returning results",
            "schema": { "type": "integer" },
        }),
    ];

    for col in &tm.columns {
        params.push(json!({
            "name": col.name,
            "in": "query",
            "required": false,
            "description": format!(
                "Filter on {}. Format: operator.value. Operators: eq, neq, gt, gte, lt, lte, like, ilike, is, in, cs, cd, fts. Prefix with not. to negate.",
                col.name
            ),
            "schema": { "type": "string" },
        }));
    }

    params
}

fn build_get_operation(tm: &TableMeta, schema_ref: &str, filter_params: &[Value]) -> Value {
    json!({
        "summary": format!("List {} rows", tm.name),
        "operationId": format!("list_{}", tm.name),
        "tags": [tm.name],
        "parameters": filter_params,
        "responses": {
            "200": {
                "description": "Rows matching the query",
                "content": {
                    "application/json": {
                        "schema": { "type": "array", "items": { "$ref": schema_ref } },
                    },
                },
            },
            "400": error_response("Invalid query parameters"),
            "401": error_response("Authentication required"),
            "404": error_response("Table not found"),
        },
    })
}

fn build_post_operation(tm: &TableMeta, schema_ref: &str) -> Value {
    json!({
        "summary": format!("Insert into {}", tm.name),
        "operationId": format!("insert_{}", tm.name),
        "tags": [tm.name],
        "parameters": [
            {
                "name": "Prefer",
                "in": "header",
                "required": false,
                "description": "Set to return=minimal to skip returning the inserted row(s)",
                "schema": { "type": "string", "enum": ["return=minimal", "return=representation"] },
            }
        ],
        "requestBody": {
            "required": true,
            "content": {
                "application/json": {
                    "schema": {
                        "oneOf": [
                            { "$ref": schema_ref },
                            { "type": "array", "items": { "$ref": schema_ref } },
                        ],
                    },
                },
            },
        },
        "responses": {
            "201": {
                "description": "Created",
                "content": {
                    "application/json": {
                        "schema": {
                            "oneOf": [
                                { "$ref": schema_ref },
                                { "type": "array", "items": { "$ref": schema_ref } },
                            ],
                        },
                    },
                },
            },
            "400": error_response("Invalid request body"),
            "401": error_response("Authentication required"),
            "404": error_response("Table not found"),
            "409": error_response("Duplicate value violates unique constraint"),
        },
    })
}

fn build_patch_operation(tm: &TableMeta, schema_ref: &str, filter_params: &[Value]) -> Value {
    json!({
        "summary": format!("Update {} rows", tm.name),
        "operationId": format!("update_{}", tm.name),
        "tags": [tm.name],
        "parameters": filter_params,
        "requestBody": {
            "required": true,
            "description": "Fields to update",
            "content": {
                "application/json": {
                    "schema": { "$ref": schema_ref },
                },
            },
        },
        "responses": {
            "200": {
                "description": "Updated rows",
                "content": {
                    "application/json": {
                        "schema": { "type": "array", "items": { "$ref": schema_ref } },
                    },
                },
            },
            "400": error_response("Invalid request or missing filter"),
            "401": error_response("Authentication required"),
            "404": error_response("Table not found"),
        },
    })
}

fn build_delete_operation(tm: &TableMeta, schema_ref: &str, filter_params: &[Value]) -> Value {
    json!({
        "summary": format!("Delete {} rows", tm.name),
        "operationId": format!("delete_{}", tm.name),
        "tags": [tm.name],
        "parameters": filter_params,
        "responses": {
            "200": {
                "description": "Deleted rows",
                "content": {
                    "application/json": {
                        "schema": { "type": "array", "items": { "$ref": schema_ref } },
                    },
                },
            },
            "400": error_response("Invalid request or missing filter"),
            "401": error_response("Authentication required"),
            "404": error_response("Table not found"),
        },
    })
}

fn build_rpc_path_item() -> Value {
    let fn_param = json!({
        "name": "function",
        "in": "path",
        "required": true,
        "description": "Name of the PostgreSQL function to call",
        "schema": { "type": "string" },
    });

    json!({
        "get": {
            "summary": "Call a PostgreSQL function (params via query string)",
            "operationId": "rpc_get",
            "tags": ["rpc"],
            "parameters": [fn_param],
            "responses": {
                "200": {
                    "description": "Function result",
                    "content": { "application/json": { "schema": {} } },
                },
                "400": error_response("Invalid function call"),
                "401": error_response("Authentication required"),
                "404": error_response("Function not found"),
            },
        },
        "post": {
            "summary": "Call a PostgreSQL function (params via JSON body)",
            "operationId": "rpc_post",
            "tags": ["rpc"],
            "parameters": [fn_param],
            "requestBody": {
                "required": false,
                "content": {
                    "application/json": {
                        "schema": {
                            "type": "object",
                            "description": "Function parameters as key-value pairs",
                        },
                    },
                },
            },
            "responses": {
                "200": {
                    "description": "Function result",
                    "content": { "application/json": { "schema": {} } },
                },
                "400": error_response("Invalid function call"),
                "401": error_response("Authentication required"),
                "404": error_response("Function not found"),
            },
        },
    })
}

fn error_response(description: &str) -> Value {
    json!({
        "description": description,
        "content": {
            "application/json": {
                "schema": {
                    "type": "object",
                    "properties": { "error": { "type": "string" } },
                },
            },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rest::catalog::ColumnMeta;

    fn col(name: &str, pg_type: &str, nullable: bool, has_default: bool) -> ColumnMeta {
        ColumnMeta {
            name: name.to_string(),
            pg_type: pg_type.to_string(),
            is_nullable: nullable,
            has_default,
        }
    }

    fn sample_table() -> TableMeta {
        TableMeta {
            schema: "public".to_string(),
            name: "todos".to_string(),
            columns: vec![
                col("id", "integer", false, true),  // PK w/ default -> not required
                col("title", "text", false, false), // NOT NULL, no default -> required
                col("done", "boolean", true, false), // nullable -> not required
            ],
            primary_keys: vec!["id".to_string()],
            foreign_keys: Vec::new(),
        }
    }

    #[test]
    fn spec_top_level_shape() {
        let spec = build_openapi_spec(&[sample_table()]);
        assert_eq!(spec["openapi"], "3.0.3");
        assert_eq!(spec["info"]["title"], "pgStack REST API");
        assert_eq!(spec["info"]["version"], "1.0.0");
        // CRUD path for the table + RPC path.
        assert!(spec["paths"]["/rest/v1/todos"].is_object());
        assert!(spec["paths"]["/rest/v1/rpc/{function}"].is_object());
        // Component schema present + security schemes.
        assert!(spec["components"]["schemas"]["todos"].is_object());
        assert!(spec["components"]["securitySchemes"]["BearerAuth"].is_object());
        assert!(spec["components"]["securitySchemes"]["ApiKeyAuth"].is_object());
    }

    #[test]
    fn table_schema_required_only_notnull_without_default() {
        let schema = build_table_schema(&sample_table());
        let required = schema["required"].as_array().unwrap();
        // Only `title` is NOT NULL with no default.
        assert_eq!(required.len(), 1);
        assert_eq!(required[0], "title");
        assert_eq!(schema["properties"]["id"]["type"], "integer");
        assert_eq!(schema["properties"]["done"]["type"], "boolean");
    }

    #[test]
    fn path_item_has_all_crud_verbs() {
        let item = build_table_path_item(&sample_table(), "#/components/schemas/todos");
        for verb in ["get", "post", "patch", "delete"] {
            assert!(item[verb].is_object(), "missing verb {verb}");
        }
    }

    #[test]
    fn pg_type_mapping_format_type_and_typname() {
        // format_type display names
        assert_eq!(pg_type_to_openapi("integer"), json!({"type":"integer"}));
        assert_eq!(
            pg_type_to_openapi("bigint"),
            json!({"type":"integer","format":"int64"})
        );
        assert_eq!(
            pg_type_to_openapi("character varying(255)"),
            json!({"type":"string"})
        );
        assert_eq!(
            pg_type_to_openapi("timestamp with time zone"),
            json!({"type":"string","format":"date-time"})
        );
        assert_eq!(
            pg_type_to_openapi("uuid"),
            json!({"type":"string","format":"uuid"})
        );
        assert_eq!(pg_type_to_openapi("jsonb"), json!({}));
        // array forms
        assert_eq!(
            pg_type_to_openapi("integer[]"),
            json!({"type":"array","items":{"type":"integer"}})
        );
        assert_eq!(
            pg_type_to_openapi("_int4"),
            json!({"type":"array","items":{"type":"integer"}})
        );
        assert_eq!(
            pg_type_to_openapi("_int8"),
            json!({"type":"array","items":{"type":"integer","format":"int64"}})
        );
        // short typname forms (Go-style)
        assert_eq!(pg_type_to_openapi("int4"), json!({"type":"integer"}));
        assert_eq!(
            pg_type_to_openapi("timestamptz"),
            json!({"type":"string","format":"date-time"})
        );
    }

    #[test]
    fn non_public_schema_uses_double_underscore_key() {
        let mut tm = sample_table();
        tm.schema = "app".to_string();
        assert_eq!(schema_key(&tm), "app__todos");
        let spec = build_openapi_spec(&[tm]);
        assert!(spec["paths"]["/rest/v1/app__todos"].is_object());
        assert!(spec["components"]["schemas"]["app__todos"].is_object());
    }
}
