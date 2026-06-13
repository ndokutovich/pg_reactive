package rest

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// Select handles GET /rest/v1/{table}.
//
// Supports:
//   - ?select=col1,col2,relation(*)  — column + embed selection
//   - ?col=op.value                  — PostgREST filters
//   - ?order=col.asc                 — ordering
//   - ?limit=N&offset=M              — pagination
//   - Prefer: count=exact|planned|estimated  — total count via Content-Range
func Select(d *RestDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tableName := chi.URLParam(r, "table")

		tm := d.Catalog.GetTable(tableName)
		if tm == nil {
			log.Warn().Str("table", tableName).Msg("select: relation not found")
			writeJSONError(w, http.StatusNotFound, "relation not found")
			return
		}

		q, err := ParseQuery(r.URL.RawQuery)
		if err != nil {
			log.Warn().Err(err).Msg("select: invalid query parameters")
			writeJSONError(w, http.StatusBadRequest, "invalid query parameters")
			return
		}

		// Parse Prefer header for count mode.
		prefer := r.Header.Get("Prefer")
		if strings.Contains(prefer, "count=exact") {
			q.Count = "exact"
		} else if strings.Contains(prefer, "count=planned") {
			q.Count = "planned"
		} else if strings.Contains(prefer, "count=estimated") {
			q.Count = "estimated"
		}

		// Parse embed requests out of ?select.
		plainCols, embedReqs := ParseEmbeds(q.Select)

		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		tx, err := beginRLSTx(r.Context(), d.poolFor(claims.Role), claims)
		if err != nil {
			log.Error().Err(err).Msg("select: begin RLS transaction")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}
		defer tx.Rollback(r.Context())

		var result json.RawMessage

		if len(embedReqs) == 0 {
			// Simple path: no embeds.
			bq, err := BuildSelect(tm, q, plainCols)
			if err != nil {
				log.Warn().Err(err).Str("table", tableName).Msg("select: query build failed")
				writeJSONError(w, http.StatusBadRequest, "unknown column in request")
				return
			}
			wrappedSQL := `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) AS data FROM (` +
				bq.SQL + `) t`
			row := tx.QueryRow(r.Context(), wrappedSQL, bq.Params...)
			if err := row.Scan(&result); err != nil {
				status, msg := pgHTTPStatus(err)
				writeJSONError(w, status, msg)
				return
			}
		} else {
			// Embed path.
			resolvedEmbeds := make([]ResolvedEmbed, 0, len(embedReqs))
			for _, req := range embedReqs {
				re, err := ResolveEmbed(d.Catalog, tm, req, 0)
				if err != nil {
					log.Warn().Err(err).Str("table", tableName).Msg("select: embed resolution failed")
					writeJSONError(w, http.StatusBadRequest, "invalid embed in request")
					return
				}
				resolvedEmbeds = append(resolvedEmbeds, *re)
			}

			// For ManyToOne embeds the lateral join references FK columns in the
			// base CTE.  If the user didn't select those columns explicitly we
			// must add them to the base query — but keep plainCols as the
			// user-visible projection so they don't appear in the response.
			baseCols := plainCols
			if extras := collectJoinCols(resolvedEmbeds, plainCols); len(extras) > 0 {
				baseCols = make([]string, len(plainCols)+len(extras))
				copy(baseCols, plainCols)
				copy(baseCols[len(plainCols):], extras)
			}

			bq, err := BuildSelect(tm, q, baseCols)
			if err != nil {
				log.Warn().Err(err).Str("table", tableName).Msg("select: query build failed")
				writeJSONError(w, http.StatusBadRequest, "unknown column in request")
				return
			}

			result, err = ExecuteSelectWithEmbeds(r.Context(), tx, bq, tm, resolvedEmbeds, plainCols)
			if err != nil {
				status, msg := pgHTTPStatus(err)
				writeJSONError(w, status, msg)
				return
			}
		}

		// Count returned rows from the JSON array.
		returned := countJSONArrayItems(result)

		// Execute count query if requested.
		var totalCount int64 = -1
		if q.Count != "" {
			totalCount, err = executeCount(r, tx, tm, q, plainCols)
			if err != nil {
				log.Warn().Err(err).Str("table", tableName).Msg("select: count query failed")
				// Non-fatal: proceed without count.
				totalCount = -1
			}
		}

		if err := tx.Commit(r.Context()); err != nil {
			log.Error().Err(err).Msg("select: commit")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		// Set Content-Range header.
		offset := 0
		if q.Offset != nil {
			offset = *q.Offset
		}
		w.Header().Set("Content-Range", formatContentRange(offset, returned, totalCount))

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result)
	}
}

// explainRowsRe matches "rows=N" in EXPLAIN output.
var explainRowsRe = regexp.MustCompile(`rows=(\d+)`)

// executeCount runs the appropriate count query based on q.Count mode.
func executeCount(r *http.Request, tx pgx.Tx, tm *TableMeta, q *RestQuery, plainCols []string) (int64, error) {
	ctx := r.Context()

	switch q.Count {
	case "exact":
		cq, err := BuildCount(tm, q, plainCols)
		if err != nil {
			return 0, err
		}
		var count int64
		if err := tx.QueryRow(ctx, cq.SQL, cq.Params...).Scan(&count); err != nil {
			return 0, err
		}
		return count, nil

	case "planned", "estimated":
		eq, err := BuildCountEstimate(tm, q, plainCols)
		if err != nil {
			return 0, err
		}
		rows, err := tx.Query(ctx, eq.SQL, eq.Params...)
		if err != nil {
			return 0, err
		}
		defer rows.Close()

		// Parse the first line of EXPLAIN output for rows=N.
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				continue
			}
			if m := explainRowsRe.FindStringSubmatch(line); len(m) > 1 {
				n, _ := strconv.ParseInt(m[1], 10, 64)
				return n, nil
			}
		}
		return 0, fmt.Errorf("could not parse EXPLAIN output")

	default:
		return 0, fmt.Errorf("unknown count mode: %s", q.Count)
	}
}

// countJSONArrayItems returns the number of top-level items in a JSON array.
// Returns 0 for empty arrays or non-array input.
func countJSONArrayItems(data json.RawMessage) int {
	var items []json.RawMessage
	if json.Unmarshal(data, &items) != nil {
		return 0
	}
	return len(items)
}

// formatContentRange produces the Content-Range header value.
//
// PostgREST format:
//   - With count:    "0-4/100"
//   - Without count: "0-4/*"
//   - Empty result:  "*/100" or "*/*"
func formatContentRange(offset, returned int, totalCount int64) string {
	total := "*"
	if totalCount >= 0 {
		total = strconv.FormatInt(totalCount, 10)
	}
	if returned == 0 {
		return "*/" + total
	}
	return fmt.Sprintf("%d-%d/%s", offset, offset+returned-1, total)
}

// Insert handles POST /rest/v1/{table}.
//
// Accepts a JSON object (single row) or a JSON array (bulk insert).
// Returns 201 with the inserted row(s) as JSON.
// If the "Prefer: return=minimal" header is set, returns 201 with no body.
func Insert(d *RestDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tableName := chi.URLParam(r, "table")

		tm := d.Catalog.GetTable(tableName)
		if tm == nil {
			log.Warn().Str("table", tableName).Msg("insert: relation not found")
			writeJSONError(w, http.StatusNotFound, "relation not found")
			return
		}

		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "cannot read body")
			return
		}

		minimal := strings.Contains(r.Header.Get("Prefer"), "return=minimal")

		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		tx, err := beginRLSTx(r.Context(), d.poolFor(claims.Role), claims)
		if err != nil {
			log.Error().Err(err).Msg("insert: begin RLS transaction")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}
		defer tx.Rollback(r.Context())

		// Detect whether body is an array or a single object.
		trimmed := strings.TrimSpace(string(bodyBytes))
		isArray := strings.HasPrefix(trimmed, "[")

		if isArray {
			var rows []map[string]any
			if err := json.Unmarshal(bodyBytes, &rows); err != nil {
				writeJSONError(w, http.StatusBadRequest, "invalid JSON array body")
				return
			}
			if len(rows) == 0 {
				if minimal {
					w.WriteHeader(http.StatusCreated)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				_, _ = w.Write([]byte("[]"))
				return
			}

			bq, err := BuildBulkInsert(tm, rows)
			if err != nil {
				log.Warn().Err(err).Str("table", tableName).Msg("insert: query build failed")
				writeJSONError(w, http.StatusBadRequest, "unknown column in request")
				return
			}

			var raw json.RawMessage
			dbRow := tx.QueryRow(r.Context(), bq.SQL, bq.Params...)
			if err := dbRow.Scan(&raw); err != nil {
				status, msg := pgHTTPStatus(err)
				writeJSONError(w, status, msg)
				return
			}

			if err := tx.Commit(r.Context()); err != nil {
				log.Error().Err(err).Msg("insert: commit")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}

			if minimal {
				w.WriteHeader(http.StatusCreated)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write(raw)
			return
		}

		// Single object.
		var row map[string]any
		if err := json.Unmarshal(bodyBytes, &row); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}

		bq, err := BuildInsert(tm, row)
		if err != nil {
			log.Warn().Err(err).Str("table", tableName).Msg("insert: query build failed")
			writeJSONError(w, http.StatusBadRequest, "unknown column in request")
			return
		}

		var raw json.RawMessage
		dbRow := tx.QueryRow(r.Context(), bq.SQL, bq.Params...)
		if err := dbRow.Scan(&raw); err != nil {
			status, msg := pgHTTPStatus(err)
			writeJSONError(w, status, msg)
			return
		}

		if err := tx.Commit(r.Context()); err != nil {
			log.Error().Err(err).Msg("insert: commit")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		if minimal {
			w.WriteHeader(http.StatusCreated)
			return
		}

		// Unwrap the json_agg array to a single object for single-row inserts.
		var arr []json.RawMessage
		if json.Unmarshal(raw, &arr) == nil && len(arr) == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write(arr[0])
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(raw)
	}
}

// Update handles PATCH /rest/v1/{table}.
//
// Requires at least one filter to avoid accidental full-table updates.
// Returns 200 with the updated rows as a JSON array.
func Update(d *RestDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tableName := chi.URLParam(r, "table")

		tm := d.Catalog.GetTable(tableName)
		if tm == nil {
			log.Warn().Str("table", tableName).Msg("update: relation not found")
			writeJSONError(w, http.StatusNotFound, "relation not found")
			return
		}

		q, err := ParseQuery(r.URL.RawQuery)
		if err != nil {
			log.Warn().Err(err).Msg("update: invalid query parameters")
			writeJSONError(w, http.StatusBadRequest, "invalid query parameters")
			return
		}
		if len(q.Filters) == 0 {
			writeJSONError(w, http.StatusBadRequest, "update requires at least one filter")
			return
		}

		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "cannot read body")
			return
		}
		var body map[string]any
		if err := json.Unmarshal(bodyBytes, &body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}

		bq, err := BuildUpdate(tm, body, q)
		if err != nil {
			log.Warn().Err(err).Str("table", tableName).Msg("update: query build failed")
			writeJSONError(w, http.StatusBadRequest, "unknown column in request")
			return
		}

		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		tx, err := beginRLSTx(r.Context(), d.poolFor(claims.Role), claims)
		if err != nil {
			log.Error().Err(err).Msg("update: begin RLS transaction")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}
		defer tx.Rollback(r.Context())

		var result json.RawMessage
		row := tx.QueryRow(r.Context(), bq.SQL, bq.Params...)
		if err := row.Scan(&result); err != nil {
			// Do NOT log bq.Params: update payloads can contain PII (emails,
			// addresses, free-form text). The SQL skeleton (without bound
			// values) is already in the error chain via pgx.PgError; if you
			// need to reproduce the query, enable LOG_LEVEL=debug temporarily
			// in a controlled environment rather than baking PII into logs.
			log.Error().Err(err).Str("table", tableName).Msg("update: query error")
			status, msg := pgHTTPStatus(err)
			writeJSONError(w, status, msg)
			return
		}

		if err := tx.Commit(r.Context()); err != nil {
			log.Error().Err(err).Msg("update: commit")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result)
	}
}

// Delete handles DELETE /rest/v1/{table}.
//
// Requires at least one filter to avoid accidental full-table deletes.
// Returns 200 with the deleted rows as a JSON array.
func Delete(d *RestDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tableName := chi.URLParam(r, "table")

		tm := d.Catalog.GetTable(tableName)
		if tm == nil {
			log.Warn().Str("table", tableName).Msg("delete: relation not found")
			writeJSONError(w, http.StatusNotFound, "relation not found")
			return
		}

		q, err := ParseQuery(r.URL.RawQuery)
		if err != nil {
			log.Warn().Err(err).Msg("delete: invalid query parameters")
			writeJSONError(w, http.StatusBadRequest, "invalid query parameters")
			return
		}
		if len(q.Filters) == 0 {
			writeJSONError(w, http.StatusBadRequest, "delete requires at least one filter")
			return
		}

		bq, err := BuildDelete(tm, q)
		if err != nil {
			log.Warn().Err(err).Str("table", tableName).Msg("delete: query build failed")
			writeJSONError(w, http.StatusBadRequest, "unknown column in request")
			return
		}

		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		tx, err := beginRLSTx(r.Context(), d.poolFor(claims.Role), claims)
		if err != nil {
			log.Error().Err(err).Msg("delete: begin RLS transaction")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}
		defer tx.Rollback(r.Context())

		var result json.RawMessage
		row := tx.QueryRow(r.Context(), bq.SQL, bq.Params...)
		if err := row.Scan(&result); err != nil {
			status, msg := pgHTTPStatus(err)
			writeJSONError(w, status, msg)
			return
		}

		if err := tx.Commit(r.Context()); err != nil {
			log.Error().Err(err).Msg("delete: commit")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result)
	}
}
