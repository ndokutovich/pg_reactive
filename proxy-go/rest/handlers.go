package rest

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog/log"
)

// Select handles GET /rest/v1/{table}.
//
// Supports:
//   - ?select=col1,col2,relation(*)  — column + embed selection
//   - ?col=op.value                  — PostgREST filters
//   - ?order=col.asc                 — ordering
//   - ?limit=N&offset=M              — pagination
func Select(d *RestDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tableName := chi.URLParam(r, "table")

		tm := d.Catalog.GetTable(tableName)
		if tm == nil {
			writeJSONError(w, http.StatusNotFound, "table not found: "+tableName)
			return
		}

		q, err := ParseQuery(r.URL.RawQuery)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid query parameters: "+err.Error())
			return
		}

		// Parse embed requests out of ?select.
		plainCols, embedReqs := ParseEmbeds(q.Select)

		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		tx, err := beginRLSTx(r.Context(), d.Pool, claims)
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
				writeJSONError(w, http.StatusBadRequest, err.Error())
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
					writeJSONError(w, http.StatusBadRequest, "embed error: "+err.Error())
					return
				}
				resolvedEmbeds = append(resolvedEmbeds, *re)
			}

			bq, err := BuildSelect(tm, q, plainCols)
			if err != nil {
				writeJSONError(w, http.StatusBadRequest, err.Error())
				return
			}

			result, err = ExecuteSelectWithEmbeds(r.Context(), tx, bq, tm, resolvedEmbeds, plainCols)
			if err != nil {
				status, msg := pgHTTPStatus(err)
				writeJSONError(w, status, msg)
				return
			}
		}

		if err := tx.Commit(r.Context()); err != nil {
			log.Error().Err(err).Msg("select: commit")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result)
	}
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
			writeJSONError(w, http.StatusNotFound, "table not found: "+tableName)
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

		tx, err := beginRLSTx(r.Context(), d.Pool, claims)
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
				writeJSONError(w, http.StatusBadRequest, err.Error())
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
			writeJSONError(w, http.StatusBadRequest, err.Error())
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
			writeJSONError(w, http.StatusNotFound, "table not found: "+tableName)
			return
		}

		q, err := ParseQuery(r.URL.RawQuery)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid query parameters: "+err.Error())
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
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}

		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		tx, err := beginRLSTx(r.Context(), d.Pool, claims)
		if err != nil {
			log.Error().Err(err).Msg("update: begin RLS transaction")
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
			writeJSONError(w, http.StatusNotFound, "table not found: "+tableName)
			return
		}

		q, err := ParseQuery(r.URL.RawQuery)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid query parameters: "+err.Error())
			return
		}
		if len(q.Filters) == 0 {
			writeJSONError(w, http.StatusBadRequest, "delete requires at least one filter")
			return
		}

		bq, err := BuildDelete(tm, q)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}

		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		tx, err := beginRLSTx(r.Context(), d.Pool, claims)
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
