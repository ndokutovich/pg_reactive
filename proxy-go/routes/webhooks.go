package routes

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"pgstack-proxy-go/middleware"
	"pgstack-proxy-go/realtime"
	"pgstack-proxy-go/secrets"
)

// WebhookDeps carries dependencies for webhook CRUD handlers.
type WebhookDeps struct {
	Pool           *pgxpool.Pool
	ResolveClaims  func(r *http.Request) (middleware.RequestClaims, error)
	WebhookManager *realtime.WebhookManager
	// SecretBox encrypts the webhook signing secret before it lands in
	// pgstack.webhooks.secret_encrypted. nil = no encryption available;
	// CreateWebhook refuses to store a non-empty secret in that case so
	// nobody silently writes plaintext to the table.
	SecretBox *secrets.Box
}

// CreateWebhook handles POST /rest/v1/webhooks.
// Restricted to service_role.
func CreateWebhook(d *WebhookDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		if claims.Role != "service_role" {
			writeJSONError(w, http.StatusForbidden, "webhook management requires service_role")
			return
		}

		var body struct {
			URL       string   `json:"url"`
			Events    []string `json:"events"`
			TableName string   `json:"table_name"`
			Secret    string   `json:"secret"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if body.URL == "" {
			writeJSONError(w, http.StatusBadRequest, "url is required")
			return
		}
		// SSRF guard. Even a privileged caller (compromised service_role
		// key / Studio with stolen storage) cannot point the webhook at
		// internal nodes, the cloud metadata server, or loopback.
		if _, verr := realtime.ValidateWebhookURL(body.URL); verr != nil {
			writeJSONError(w, http.StatusBadRequest, verr.Error())
			return
		}
		if len(body.Events) == 0 {
			body.Events = []string{"*"}
		}
		if body.TableName == "" {
			body.TableName = "*"
		}

		// Encrypt the signing secret before persisting. Empty secret =
		// unsigned webhook (some receivers accept). Non-empty without a
		// configured SECRETS_ENCRYPTION_KEY = refuse: storing plaintext
		// would re-open the F1 audit hole.
		var secretEnc []byte
		if body.Secret != "" {
			if d.SecretBox == nil {
				writeJSONError(w, http.StatusBadRequest,
					"webhook secret cannot be stored: SECRETS_ENCRYPTION_KEY is not configured")
				return
			}
			enc, encErr := d.SecretBox.Encrypt([]byte(body.Secret))
			if encErr != nil {
				log.Error().Err(encErr).Msg("webhooks: encrypt secret")
				writeJSONError(w, http.StatusInternalServerError, "internal error encrypting secret")
				return
			}
			secretEnc = enc
		}

		var id string
		var createdAt time.Time
		err = d.Pool.QueryRow(r.Context(),
			`INSERT INTO pgstack.webhooks (url, events, table_name, secret_encrypted)
			 VALUES ($1, $2, $3, $4)
			 RETURNING id::text, created_at`,
			body.URL, body.Events, body.TableName, secretEnc,
		).Scan(&id, &createdAt)
		if err != nil {
			log.Error().Err(err).Msg("webhooks: create")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		// Install the AFTER ROW trigger that feeds the 'pgstack_webhooks'
		// channel. A table_name of "*" is a wildcard matcher only — it cannot
		// install a trigger (PG has no "all tables" row trigger), so it relies
		// on the triggers installed by table-specific webhooks.
		if body.TableName != "*" {
			if _, err := d.Pool.Exec(r.Context(),
				`SELECT pgstack.enable_webhook_trigger($1::regclass)`, body.TableName); err != nil {
				log.Error().Err(err).Str("table", body.TableName).Msg("webhooks: enable trigger")
				// Roll back the orphan webhook row so we never have a webhook
				// with no trigger feeding it.
				_, _ = d.Pool.Exec(r.Context(), `DELETE FROM pgstack.webhooks WHERE id = $1::uuid`, id)
				writeJSONError(w, http.StatusBadRequest, "failed to install webhook trigger on table: "+body.TableName)
				return
			}
		}

		// Refresh webhook cache
		_ = d.WebhookManager.Refresh(r.Context())

		// Secret is returned in the create response ONCE — the only point
		// at which the caller can see it. ListWebhooks and any future
		// GetWebhook return the placeholder "(hidden)" so the secret never
		// flows back through the API or into Studio screenshots / logs.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":         id,
			"url":        body.URL,
			"events":     body.Events,
			"table_name": body.TableName,
			"secret":     body.Secret,
			"active":     true,
			"created_at": createdAt.Format(time.RFC3339),
		})
	}
}

// ListWebhooks handles GET /rest/v1/webhooks.
// Restricted to service_role.
func ListWebhooks(d *WebhookDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		if claims.Role != "service_role" {
			writeJSONError(w, http.StatusForbidden, "webhook management requires service_role")
			return
		}

		// The `secret` column is intentionally NOT selected — see
		// CreateWebhook for the contract: secrets are returned plaintext
		// exactly once at create, never on subsequent reads. The
		// "secret_set" flag tells callers whether the row has a
		// non-empty secret without revealing the value.
		rows, err := d.Pool.Query(r.Context(),
			`SELECT id::text, url, events, table_name, (secret_encrypted IS NOT NULL) AS secret_set, active, created_at
			 FROM pgstack.webhooks ORDER BY created_at`)
		if err != nil {
			log.Error().Err(err).Msg("webhooks: list")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}
		defer rows.Close()

		type webhookResp struct {
			ID        string   `json:"id"`
			URL       string   `json:"url"`
			Events    []string `json:"events"`
			TableName string   `json:"table_name"`
			SecretSet bool     `json:"secret_set"`
			Active    bool     `json:"active"`
			CreatedAt string   `json:"created_at"`
		}
		result := make([]webhookResp, 0)
		for rows.Next() {
			var wh webhookResp
			var createdAt time.Time
			if err := rows.Scan(&wh.ID, &wh.URL, &wh.Events, &wh.TableName, &wh.SecretSet, &wh.Active, &createdAt); err != nil {
				log.Error().Err(err).Msg("webhooks: scan")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
			wh.CreatedAt = createdAt.Format(time.RFC3339)
			result = append(result, wh)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	}
}

// DeleteWebhook handles DELETE /rest/v1/webhooks/{id}.
// Restricted to service_role.
func DeleteWebhook(d *WebhookDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		if claims.Role != "service_role" {
			writeJSONError(w, http.StatusForbidden, "webhook management requires service_role")
			return
		}

		webhookID := chi.URLParam(r, "id")
		if webhookID == "" {
			writeJSONError(w, http.StatusBadRequest, "webhook id is required")
			return
		}

		var deletedTable string
		err = d.Pool.QueryRow(r.Context(),
			`DELETE FROM pgstack.webhooks WHERE id = $1::uuid RETURNING table_name`,
			webhookID).Scan(&deletedTable)
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONError(w, http.StatusNotFound, "webhook not found")
			return
		}
		if err != nil {
			log.Error().Err(err).Msg("webhooks: delete")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		// Drop the per-table trigger once no active webhook references the
		// table anymore — otherwise it keeps emitting NOTIFY nobody consumes.
		if deletedTable != "*" {
			var remaining int
			if err := d.Pool.QueryRow(r.Context(),
				`SELECT count(*) FROM pgstack.webhooks WHERE table_name = $1 AND active = true`,
				deletedTable).Scan(&remaining); err != nil {
				log.Warn().Err(err).Str("table", deletedTable).Msg("webhooks: count remaining")
			} else if remaining == 0 {
				if _, err := d.Pool.Exec(r.Context(),
					`SELECT pgstack.disable_webhook_trigger($1::regclass)`, deletedTable); err != nil {
					log.Warn().Err(err).Str("table", deletedTable).Msg("webhooks: disable trigger")
				}
			}
		}

		// Refresh webhook cache
		_ = d.WebhookManager.Refresh(r.Context())

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "webhook deleted"})
	}
}
