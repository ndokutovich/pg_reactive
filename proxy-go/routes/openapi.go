// Package routes — OpenAPI 3.0 auto-generation from the PostgreSQL catalog.
package routes

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"pgstack-proxy-go/rest"
)

// OpenAPISpec returns an http.HandlerFunc that serves an auto-generated
// OpenAPI 3.0 JSON specification built from the live catalog metadata.
//
// The spec is rebuilt on every request so it always reflects the latest
// catalog state (after POST /api/catalog/refresh).
func OpenAPISpec(catalog *rest.Catalog) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tables := catalog.ListTables("")

		// Sort tables by schema.name for deterministic output.
		sort.Slice(tables, func(i, j int) bool {
			ki := tables[i].Schema + "." + tables[i].Name
			kj := tables[j].Schema + "." + tables[j].Name
			return ki < kj
		})

		spec := buildOpenAPISpec(tables)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		_ = enc.Encode(spec)
	}
}

// buildOpenAPISpec assembles the complete OpenAPI 3.0 document.
func buildOpenAPISpec(tables []*rest.TableMeta) map[string]any {
	paths := make(map[string]any)
	schemas := make(map[string]any)

	for _, tm := range tables {
		schemaKey := tm.Name
		if tm.Schema != "public" {
			schemaKey = tm.Schema + "__" + tm.Name
		}
		schemaRef := "#/components/schemas/" + schemaKey

		// Build per-table component schema.
		schemas[schemaKey] = buildTableSchema(tm)

		// Build per-table CRUD paths.
		path := "/rest/v1/" + tm.Name
		if tm.Schema != "public" {
			path = "/rest/v1/" + tm.Schema + "__" + tm.Name
		}
		paths[path] = buildTablePathItem(tm, schemaRef)
	}

	// RPC path (generic template).
	paths["/rest/v1/rpc/{function}"] = buildRPCPathItem()

	return map[string]any{
		"openapi": "3.0.3",
		"info": map[string]any{
			"title":       "pgStack REST API",
			"version":     "1.0.0",
			"description": "Auto-generated from PostgreSQL catalog",
		},
		"paths": paths,
		"components": map[string]any{
			"schemas":         schemas,
			"securitySchemes": buildSecuritySchemes(),
		},
		"security": []any{
			map[string]any{"BearerAuth": []any{}},
			map[string]any{"ApiKeyAuth": []any{}},
		},
	}
}

// buildSecuritySchemes returns the OpenAPI securitySchemes component.
func buildSecuritySchemes() map[string]any {
	return map[string]any{
		"BearerAuth": map[string]any{
			"type":         "http",
			"scheme":       "bearer",
			"bearerFormat": "JWT",
			"description":  "JWT access token",
		},
		"ApiKeyAuth": map[string]any{
			"type":        "apiKey",
			"in":          "header",
			"name":        "apikey",
			"description": "API key for anonymous or service-role access",
		},
	}
}

// buildTableSchema generates an OpenAPI schema object for a table.
func buildTableSchema(tm *rest.TableMeta) map[string]any {
	properties := make(map[string]any)
	var required []string

	for _, col := range tm.Columns {
		prop := pgTypeToOpenAPI(col.PGType)
		properties[col.Name] = prop

		// A column is required for inserts if it is NOT NULL and has no default.
		if !col.IsNullable && !col.HasDefault {
			required = append(required, col.Name)
		}
	}

	schema := map[string]any{
		"type":       "object",
		"properties": properties,
	}
	if len(required) > 0 {
		sort.Strings(required)
		schema["required"] = required
	}
	return schema
}

// pgTypeToOpenAPI maps a PostgreSQL type name to an OpenAPI property schema.
func pgTypeToOpenAPI(pgType string) map[string]any {
	// Handle array types: _typename -> array of the element type.
	if strings.HasPrefix(pgType, "_") {
		elemType := pgType[1:]
		elemSchema := pgTypeToOpenAPI(elemType)
		return map[string]any{
			"type":  "array",
			"items": elemSchema,
		}
	}

	switch pgType {
	// Integer types.
	case "int2", "int4", "serial":
		return map[string]any{"type": "integer"}
	case "int8", "bigserial":
		return map[string]any{"type": "integer", "format": "int64"}

	// Floating-point / numeric.
	case "float4", "float8", "numeric":
		return map[string]any{"type": "number"}

	// Boolean.
	case "bool":
		return map[string]any{"type": "boolean"}

	// String types.
	case "text", "varchar", "bpchar", "char", "name":
		return map[string]any{"type": "string"}
	case "uuid":
		return map[string]any{"type": "string", "format": "uuid"}
	case "timestamptz", "timestamp":
		return map[string]any{"type": "string", "format": "date-time"}
	case "date":
		return map[string]any{"type": "string", "format": "date"}
	case "time", "timetz":
		return map[string]any{"type": "string", "format": "time"}

	// Binary.
	case "bytea":
		return map[string]any{"type": "string", "format": "byte"}

	// JSON types — represented as free-form objects.
	case "jsonb", "json":
		return map[string]any{}

	default:
		return map[string]any{"type": "string"}
	}
}

// buildTablePathItem builds the OpenAPI path item for a single table,
// covering GET, POST, PATCH, DELETE.
func buildTablePathItem(tm *rest.TableMeta, schemaRef string) map[string]any {
	filterParams := buildFilterParameters(tm)

	return map[string]any{
		"get":    buildGetOperation(tm, schemaRef, filterParams),
		"post":   buildPostOperation(tm, schemaRef),
		"patch":  buildPatchOperation(tm, schemaRef, filterParams),
		"delete": buildDeleteOperation(tm, schemaRef, filterParams),
	}
}

// buildFilterParameters creates common query parameter definitions for
// PostgREST-style column filters.
func buildFilterParameters(tm *rest.TableMeta) []any {
	params := []any{
		map[string]any{
			"name":        "select",
			"in":          "query",
			"required":    false,
			"description": "Columns to return (comma-separated). Supports embedding: relation(*)",
			"schema":      map[string]any{"type": "string"},
		},
		map[string]any{
			"name":        "order",
			"in":          "query",
			"required":    false,
			"description": "Ordering: column.asc or column.desc (comma-separated)",
			"schema":      map[string]any{"type": "string"},
		},
		map[string]any{
			"name":        "limit",
			"in":          "query",
			"required":    false,
			"description": "Maximum number of rows to return",
			"schema":      map[string]any{"type": "integer"},
		},
		map[string]any{
			"name":        "offset",
			"in":          "query",
			"required":    false,
			"description": "Number of rows to skip before returning results",
			"schema":      map[string]any{"type": "integer"},
		},
	}

	// Add one parameter per column documenting filter operators.
	for _, col := range tm.Columns {
		params = append(params, map[string]any{
			"name":     col.Name,
			"in":       "query",
			"required": false,
			"description": "Filter on " + col.Name +
				". Format: operator.value. Operators: eq, neq, gt, gte, lt, lte, like, ilike, is, in, cs, cd, fts. " +
				"Prefix with not. to negate.",
			"schema": map[string]any{"type": "string"},
		})
	}

	return params
}

// buildGetOperation creates the GET operation for a table.
func buildGetOperation(tm *rest.TableMeta, schemaRef string, filterParams []any) map[string]any {
	return map[string]any{
		"summary":     "List " + tm.Name + " rows",
		"operationId": "list_" + tm.Name,
		"tags":        []any{tm.Name},
		"parameters":  filterParams,
		"responses": map[string]any{
			"200": map[string]any{
				"description": "Rows matching the query",
				"content": map[string]any{
					"application/json": map[string]any{
						"schema": map[string]any{
							"type":  "array",
							"items": map[string]any{"$ref": schemaRef},
						},
					},
				},
			},
			"400": errorResponse("Invalid query parameters"),
			"401": errorResponse("Authentication required"),
			"404": errorResponse("Table not found"),
		},
	}
}

// buildPostOperation creates the POST (insert) operation for a table.
func buildPostOperation(tm *rest.TableMeta, schemaRef string) map[string]any {
	return map[string]any{
		"summary":     "Insert into " + tm.Name,
		"operationId": "insert_" + tm.Name,
		"tags":        []any{tm.Name},
		"parameters": []any{
			map[string]any{
				"name":        "Prefer",
				"in":          "header",
				"required":    false,
				"description": "Set to return=minimal to skip returning the inserted row(s)",
				"schema":      map[string]any{"type": "string", "enum": []any{"return=minimal", "return=representation"}},
			},
		},
		"requestBody": map[string]any{
			"required": true,
			"content": map[string]any{
				"application/json": map[string]any{
					"schema": map[string]any{
						"oneOf": []any{
							map[string]any{"$ref": schemaRef},
							map[string]any{
								"type":  "array",
								"items": map[string]any{"$ref": schemaRef},
							},
						},
					},
				},
			},
		},
		"responses": map[string]any{
			"201": map[string]any{
				"description": "Created",
				"content": map[string]any{
					"application/json": map[string]any{
						"schema": map[string]any{
							"oneOf": []any{
								map[string]any{"$ref": schemaRef},
								map[string]any{
									"type":  "array",
									"items": map[string]any{"$ref": schemaRef},
								},
							},
						},
					},
				},
			},
			"400": errorResponse("Invalid request body"),
			"401": errorResponse("Authentication required"),
			"404": errorResponse("Table not found"),
			"409": errorResponse("Duplicate value violates unique constraint"),
		},
	}
}

// buildPatchOperation creates the PATCH (update) operation for a table.
func buildPatchOperation(tm *rest.TableMeta, schemaRef string, filterParams []any) map[string]any {
	return map[string]any{
		"summary":     "Update " + tm.Name + " rows",
		"operationId": "update_" + tm.Name,
		"tags":        []any{tm.Name},
		"parameters":  filterParams,
		"requestBody": map[string]any{
			"required":    true,
			"description": "Fields to update",
			"content": map[string]any{
				"application/json": map[string]any{
					"schema": map[string]any{"$ref": schemaRef},
				},
			},
		},
		"responses": map[string]any{
			"200": map[string]any{
				"description": "Updated rows",
				"content": map[string]any{
					"application/json": map[string]any{
						"schema": map[string]any{
							"type":  "array",
							"items": map[string]any{"$ref": schemaRef},
						},
					},
				},
			},
			"400": errorResponse("Invalid request or missing filter"),
			"401": errorResponse("Authentication required"),
			"404": errorResponse("Table not found"),
		},
	}
}

// buildDeleteOperation creates the DELETE operation for a table.
func buildDeleteOperation(tm *rest.TableMeta, schemaRef string, filterParams []any) map[string]any {
	return map[string]any{
		"summary":     "Delete " + tm.Name + " rows",
		"operationId": "delete_" + tm.Name,
		"tags":        []any{tm.Name},
		"parameters":  filterParams,
		"responses": map[string]any{
			"200": map[string]any{
				"description": "Deleted rows",
				"content": map[string]any{
					"application/json": map[string]any{
						"schema": map[string]any{
							"type":  "array",
							"items": map[string]any{"$ref": schemaRef},
						},
					},
				},
			},
			"400": errorResponse("Invalid request or missing filter"),
			"401": errorResponse("Authentication required"),
			"404": errorResponse("Table not found"),
		},
	}
}

// buildRPCPathItem builds the OpenAPI path item for the generic RPC endpoint.
func buildRPCPathItem() map[string]any {
	fnParam := map[string]any{
		"name":        "function",
		"in":          "path",
		"required":    true,
		"description": "Name of the PostgreSQL function to call",
		"schema":      map[string]any{"type": "string"},
	}

	return map[string]any{
		"get": map[string]any{
			"summary":     "Call a PostgreSQL function (params via query string)",
			"operationId": "rpc_get",
			"tags":        []any{"rpc"},
			"parameters":  []any{fnParam},
			"responses": map[string]any{
				"200": map[string]any{
					"description": "Function result",
					"content": map[string]any{
						"application/json": map[string]any{
							"schema": map[string]any{},
						},
					},
				},
				"400": errorResponse("Invalid function call"),
				"401": errorResponse("Authentication required"),
				"404": errorResponse("Function not found"),
			},
		},
		"post": map[string]any{
			"summary":     "Call a PostgreSQL function (params via JSON body)",
			"operationId": "rpc_post",
			"tags":        []any{"rpc"},
			"parameters":  []any{fnParam},
			"requestBody": map[string]any{
				"required": false,
				"content": map[string]any{
					"application/json": map[string]any{
						"schema": map[string]any{
							"type":        "object",
							"description": "Function parameters as key-value pairs",
						},
					},
				},
			},
			"responses": map[string]any{
				"200": map[string]any{
					"description": "Function result",
					"content": map[string]any{
						"application/json": map[string]any{
							"schema": map[string]any{},
						},
					},
				},
				"400": errorResponse("Invalid function call"),
				"401": errorResponse("Authentication required"),
				"404": errorResponse("Function not found"),
			},
		},
	}
}

// errorResponse builds a standard OpenAPI error response object.
func errorResponse(description string) map[string]any {
	return map[string]any{
		"description": description,
		"content": map[string]any{
			"application/json": map[string]any{
				"schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"error": map[string]any{"type": "string"},
					},
				},
			},
		},
	}
}
