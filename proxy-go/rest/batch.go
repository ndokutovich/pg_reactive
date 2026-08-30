package rest

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// BatchRequest is the JSON request body for POST /rest/v1/batch.
type BatchRequest struct {
	Atomic     *bool            `json:"atomic"`     // default true
	Operations []BatchOperation `json:"operations"`
}

// BatchOperation describes a single operation within a batch.
type BatchOperation struct {
	ID     string          `json:"id"`
	Method string          `json:"method"` // GET, POST, PATCH, DELETE
	Path   string          `json:"path"`   // /rest/v1/{table} or /rest/v1/rpc/{fn}
	Query  string          `json:"query"`  // URL query string
	Body   json.RawMessage `json:"body"`   // JSON body for POST/PATCH
}

// BatchResult is the result of a single batch operation.
type BatchResult struct {
	ID     string          `json:"id"`
	Status int             `json:"status"`
	Data   json.RawMessage `json:"data,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// BatchResponse is the complete response for POST /rest/v1/batch.
type BatchResponse struct {
	Results         []BatchResult `json:"results"`
	Error           string        `json:"error,omitempty"`
	FailedOperation string        `json:"failed_operation,omitempty"`
}

// Batch handles POST /rest/v1/batch — execute multiple REST operations in a
// single PostgreSQL transaction.
func Batch(d *RestDeps, maxOps int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "cannot read body")
			return
		}

		var req BatchRequest
		if err := json.Unmarshal(bodyBytes, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}

		if len(req.Operations) == 0 {
			writeJSONError(w, http.StatusBadRequest, "batch: no operations")
			return
		}
		if len(req.Operations) > maxOps {
			writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("batch: too many operations (max %d)", maxOps))
			return
		}

		atomic := true
		if req.Atomic != nil {
			atomic = *req.Atomic
		}

		// Validate all operations upfront.
		for i, op := range req.Operations {
			if op.ID == "" {
				req.Operations[i].ID = fmt.Sprintf("op%d", i)
			}
			method := strings.ToUpper(op.Method)
			switch method {
			case "GET", "POST", "PATCH", "DELETE":
				req.Operations[i].Method = method
			default:
				writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("batch: operation %q has invalid method %q", op.ID, op.Method))
				return
			}
			if !strings.HasPrefix(op.Path, "/rest/v1/") {
				writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("batch: operation %q path must start with /rest/v1/", op.ID))
				return
			}
		}

		// Resolve auth claims once for the entire batch.
		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		// Open a single RLS transaction (service_role routes to the admin pool).
		tx, err := beginRLSTx(ctx, d.poolFor(claims.Role), claims)
		if err != nil {
			log.Error().Err(err).Msg("batch: begin RLS transaction")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}
		defer tx.Rollback(ctx)

		resultsByID := make(map[string]json.RawMessage)
		results := make([]BatchResult, 0, len(req.Operations))
		anyFailed := false

		for i, op := range req.Operations {
			result := executeBatchOp(ctx, tx, d, op, resultsByID, atomic, i)
			results = append(results, result)
			if result.Data != nil {
				resultsByID[op.ID] = result.Data
			}

			if result.Error != "" {
				anyFailed = true
				if atomic {
					// Atomic mode: rollback entire transaction.
					_ = tx.Rollback(ctx)
					resp := BatchResponse{
						Results:         results,
						Error:           fmt.Sprintf("operation %s failed: %s", op.ID, result.Error),
						FailedOperation: op.ID,
					}
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusUnprocessableEntity)
					_ = json.NewEncoder(w).Encode(resp)
					return
				}
				// Partial mode: error was already handled via SAVEPOINT rollback.
			}
		}

		// Commit the transaction.
		if err := tx.Commit(ctx); err != nil {
			log.Error().Err(err).Msg("batch: commit")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		resp := BatchResponse{Results: results}

		status := http.StatusOK
		if anyFailed {
			status = 207 // Multi-Status
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// executeBatchOp runs a single operation within the batch transaction.
func executeBatchOp(ctx context.Context, tx pgx.Tx, d *RestDeps, op BatchOperation, resultsByID map[string]json.RawMessage, atomic bool, idx int) BatchResult {
	// Partial mode: create savepoint.
	spName := fmt.Sprintf("sp_%d", idx)
	if !atomic {
		if _, err := tx.Exec(ctx, "SAVEPOINT "+spName); err != nil {
			return BatchResult{ID: op.ID, Status: 500, Error: "savepoint failed"}
		}
	}

	result, err := dispatchBatchOp(ctx, tx, d, op, resultsByID)
	if err != nil {
		if !atomic {
			_, _ = tx.Exec(ctx, "ROLLBACK TO "+spName)
		}
		status, msg := pgHTTPStatus(err)
		return BatchResult{ID: op.ID, Status: status, Error: msg}
	}

	if !atomic {
		_, _ = tx.Exec(ctx, "RELEASE "+spName)
	}

	return *result
}

// dispatchBatchOp parses the operation path and delegates to the appropriate
// query builder.
func dispatchBatchOp(ctx context.Context, tx pgx.Tx, d *RestDeps, op BatchOperation, resultsByID map[string]json.RawMessage) (*BatchResult, error) {
	// Parse path: /rest/v1/rpc/{fn} or /rest/v1/{table}
	path := strings.TrimPrefix(op.Path, "/rest/v1/")

	if strings.HasPrefix(path, "rpc/") {
		return dispatchRPC(ctx, tx, d, op, resultsByID)
	}

	return dispatchCRUD(ctx, tx, d, op, path, resultsByID)
}

// dispatchRPC handles RPC calls within a batch.
func dispatchRPC(ctx context.Context, tx pgx.Tx, d *RestDeps, op BatchOperation, resultsByID map[string]json.RawMessage) (*BatchResult, error) {
	fnName := strings.TrimPrefix(strings.TrimPrefix(op.Path, "/rest/v1/"), "rpc/")
	if !fnNameRe.MatchString(fnName) {
		return nil, fmt.Errorf("invalid function name")
	}

	// Resolve templates in body.
	body := op.Body
	if len(body) > 0 {
		resolved, err := ResolveTemplates(body, resultsByID)
		if err != nil {
			return nil, err
		}
		body = resolved
	}

	var args map[string]any
	if len(body) > 0 {
		if err := json.Unmarshal(body, &args); err != nil {
			return nil, fmt.Errorf("invalid JSON body for RPC")
		}
	}
	if args == nil {
		args = make(map[string]any)
	}

	meta, err := lookupFunction(ctx, d.Pool, fnName)
	if err != nil {
		return nil, fmt.Errorf("function not found: %s", fnName)
	}

	sql, params, err := buildRPCCall(fnName, meta, args)
	if err != nil {
		return nil, err
	}

	var result json.RawMessage
	if err := tx.QueryRow(ctx, sql, params...).Scan(&result); err != nil {
		return nil, err
	}

	return &BatchResult{ID: op.ID, Status: 200, Data: result}, nil
}

// dispatchCRUD handles table CRUD operations within a batch.
func dispatchCRUD(ctx context.Context, tx pgx.Tx, d *RestDeps, op BatchOperation, tableName string, resultsByID map[string]json.RawMessage) (*BatchResult, error) {
	tm := d.Catalog.GetTable(tableName)
	if tm == nil {
		return nil, fmt.Errorf("table not found: %s", tableName)
	}

	// Resolve templates in query string.
	queryStr := op.Query
	if queryStr != "" {
		resolved, err := ResolveTemplatesInString(queryStr, resultsByID)
		if err != nil {
			return nil, err
		}
		queryStr = resolved
	}

	switch op.Method {
	case "GET":
		return batchSelect(ctx, tx, d, op, tm, queryStr, resultsByID)
	case "POST":
		return batchInsert(ctx, tx, op, tm, resultsByID)
	case "PATCH":
		return batchUpdate(ctx, tx, op, tm, queryStr, resultsByID)
	case "DELETE":
		return batchDelete(ctx, tx, op, tm, queryStr)
	default:
		return nil, fmt.Errorf("unsupported method: %s", op.Method)
	}
}

func batchSelect(ctx context.Context, tx pgx.Tx, d *RestDeps, op BatchOperation, tm *TableMeta, queryStr string, resultsByID map[string]json.RawMessage) (*BatchResult, error) {
	q, err := ParseQuery(queryStr)
	if err != nil {
		return nil, fmt.Errorf("invalid query: %w", err)
	}

	plainCols, embedReqs := ParseEmbeds(q.Select)

	if len(embedReqs) > 0 {
		// Embed path.
		resolvedEmbeds := make([]ResolvedEmbed, 0, len(embedReqs))
		for _, req := range embedReqs {
			re, err := ResolveEmbed(d.Catalog, tm, req, 0)
			if err != nil {
				return nil, fmt.Errorf("embed error: %w", err)
			}
			resolvedEmbeds = append(resolvedEmbeds, *re)
		}

		bq, err := BuildSelect(tm, q, plainCols)
		if err != nil {
			return nil, err
		}

		result, err := ExecuteSelectWithEmbeds(ctx, tx, bq, tm, resolvedEmbeds, plainCols)
		if err != nil {
			return nil, err
		}
		return &BatchResult{ID: op.ID, Status: 200, Data: result}, nil
	}

	bq, err := BuildSelect(tm, q, plainCols)
	if err != nil {
		return nil, err
	}

	wrappedSQL := `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) AS data FROM (` +
		bq.SQL + `) t`

	var result json.RawMessage
	if err := tx.QueryRow(ctx, wrappedSQL, bq.Params...).Scan(&result); err != nil {
		return nil, err
	}

	return &BatchResult{ID: op.ID, Status: 200, Data: result}, nil
}

func batchInsert(ctx context.Context, tx pgx.Tx, op BatchOperation, tm *TableMeta, resultsByID map[string]json.RawMessage) (*BatchResult, error) {
	body := op.Body
	if len(body) > 0 {
		resolved, err := ResolveTemplates(body, resultsByID)
		if err != nil {
			return nil, err
		}
		body = resolved
	}

	trimmed := strings.TrimSpace(string(body))
	isArray := strings.HasPrefix(trimmed, "[")

	var bq *BuiltQuery

	if isArray {
		var rows []map[string]any
		if err := json.Unmarshal(body, &rows); err != nil {
			return nil, fmt.Errorf("invalid JSON array body")
		}
		var err error
		// Batch operations stay plain inserts for now — upsert threading
		// through batch op paths (Prefer/on_conflict per op) is a separate change.
		bq, err = BuildBulkInsert(tm, rows, nil)
		if err != nil {
			return nil, err
		}
	} else {
		var row map[string]any
		if err := json.Unmarshal(body, &row); err != nil {
			return nil, fmt.Errorf("invalid JSON body")
		}
		var err error
		bq, err = BuildInsert(tm, row, nil) // plain insert — see the bulk note above
		if err != nil {
			return nil, err
		}
	}

	var raw json.RawMessage
	if err := tx.QueryRow(ctx, bq.SQL, bq.Params...).Scan(&raw); err != nil {
		return nil, err
	}

	// Unwrap single-row insert: [{"id":1,...}] → {"id":1,...}
	if !isArray {
		var arr []json.RawMessage
		if json.Unmarshal(raw, &arr) == nil && len(arr) == 1 {
			return &BatchResult{ID: op.ID, Status: 201, Data: arr[0]}, nil
		}
	}

	return &BatchResult{ID: op.ID, Status: 201, Data: raw}, nil
}

func batchUpdate(ctx context.Context, tx pgx.Tx, op BatchOperation, tm *TableMeta, queryStr string, resultsByID map[string]json.RawMessage) (*BatchResult, error) {
	q, err := ParseQuery(queryStr)
	if err != nil {
		return nil, fmt.Errorf("invalid query: %w", err)
	}
	if len(q.Filters) == 0 {
		return nil, fmt.Errorf("update requires at least one filter")
	}

	body := op.Body
	if len(body) > 0 {
		resolved, err := ResolveTemplates(body, resultsByID)
		if err != nil {
			return nil, err
		}
		body = resolved
	}

	var bodyMap map[string]any
	if err := json.Unmarshal(body, &bodyMap); err != nil {
		return nil, fmt.Errorf("invalid JSON body")
	}

	bq, err := BuildUpdate(tm, bodyMap, q)
	if err != nil {
		return nil, err
	}

	var result json.RawMessage
	if err := tx.QueryRow(ctx, bq.SQL, bq.Params...).Scan(&result); err != nil {
		return nil, err
	}

	return &BatchResult{ID: op.ID, Status: 200, Data: result}, nil
}

func batchDelete(ctx context.Context, tx pgx.Tx, op BatchOperation, tm *TableMeta, queryStr string) (*BatchResult, error) {
	q, err := ParseQuery(queryStr)
	if err != nil {
		return nil, fmt.Errorf("invalid query: %w", err)
	}
	if len(q.Filters) == 0 {
		return nil, fmt.Errorf("delete requires at least one filter")
	}

	bq, err := BuildDelete(tm, q)
	if err != nil {
		return nil, err
	}

	var result json.RawMessage
	if err := tx.QueryRow(ctx, bq.SQL, bq.Params...).Scan(&result); err != nil {
		return nil, err
	}

	return &BatchResult{ID: op.ID, Status: 200, Data: result}, nil
}
