package realtime

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"pgstack-proxy-go/secrets"
)

// Webhook represents a registered webhook from pgstack.webhooks.
type Webhook struct {
	ID        string   `json:"id"`
	URL       string   `json:"url"`
	Events    []string `json:"events"`     // e.g. ["INSERT", "UPDATE", "DELETE"]
	TableName string   `json:"table_name"` // e.g. "orders" or "*" for all
	Secret    string   `json:"secret"`
	Active    bool     `json:"active"`
	CreatedAt string   `json:"created_at"`
}

// WebhookManager loads webhooks from DB and delivers payloads.
type WebhookManager struct {
	pool     *pgxpool.Pool
	secrets  *secrets.Box // decrypts pgstack.webhooks.secret_encrypted at refresh
	mu       sync.RWMutex
	webhooks []Webhook
	client   *http.Client
}

// NewWebhookManager creates a WebhookManager with a hardened HTTP client
// (see newWebhookHTTPClient — refuses redirects, refuses TCP connections
// to non-public IPs, has request/response timeouts).
//
// secretBox decrypts the at-rest webhook signing secret. nil is allowed
// (matches the pattern in functions.NewFunctionsCatalog) — rows with a
// non-nil secret_encrypted will load with empty Secret and a WARN log,
// so misconfiguration is loud but not fatal.
func NewWebhookManager(pool *pgxpool.Pool, secretBox *secrets.Box) *WebhookManager {
	return &WebhookManager{
		pool:    pool,
		secrets: secretBox,
		client:  newWebhookHTTPClient(),
	}
}

// Refresh reloads all active webhooks from the database.
func (wm *WebhookManager) Refresh(ctx context.Context) error {
	rows, err := wm.pool.Query(ctx,
		`SELECT id::text, url, events, table_name, secret_encrypted, active, created_at
		 FROM pgstack.webhooks WHERE active = true`)
	if err != nil {
		return fmt.Errorf("webhooks refresh: %w", err)
	}
	defer rows.Close()

	var hooks []Webhook
	var dropped int
	for rows.Next() {
		var wh Webhook
		var createdAt time.Time
		var secretEnc []byte
		if err := rows.Scan(&wh.ID, &wh.URL, &wh.Events, &wh.TableName, &secretEnc, &wh.Active, &createdAt); err != nil {
			return fmt.Errorf("webhooks scan: %w", err)
		}
		wh.CreatedAt = createdAt.Format(time.RFC3339)

		// Decrypt the at-rest secret into in-memory plaintext for HMAC
		// signing. Symmetric with CreateWebhook's fail-closed posture
		// (audit follow-up to F1, round 8): rather than degrade to
		// unsigned delivery when SECRETS_ENCRYPTION_KEY is missing,
		// rotated, or the ciphertext is tampered, drop the row from
		// the in-memory cache. Receivers that require a signature would
		// have rejected an unsigned POST anyway; loud refusal beats
		// silent integrity loss.
		if len(secretEnc) > 0 {
			plain, derr := wm.secrets.Decrypt(secretEnc)
			if derr != nil {
				log.Warn().Err(derr).Str("id", wh.ID).
					Msg("webhooks refresh: secret_encrypted present but cannot be decrypted; dropping (set SECRETS_ENCRYPTION_KEY or re-create the webhook)")
				dropped++
				continue
			}
			wh.Secret = string(plain)
		}

		// Refresh-time SSRF guard. CreateWebhook already validates URLs,
		// but rows inserted directly via SQL, restored from a backup, or
		// imported via migration would bypass that check. Drop unsafe
		// URLs from the in-memory cache so deliverWithRetry never sees
		// them. (Audit follow-up to F5, 2026-05.)
		if _, verr := ValidateWebhookURL(wh.URL); verr != nil {
			log.Warn().Str("id", wh.ID).Str("url", wh.URL).Err(verr).
				Msg("webhooks refresh: dropping row with unsafe URL")
			dropped++
			continue
		}

		hooks = append(hooks, wh)
	}

	wm.mu.Lock()
	wm.webhooks = hooks
	wm.mu.Unlock()

	log.Info().Int("count", len(hooks)).Int("dropped", dropped).Msg("webhooks refreshed")
	return nil
}

// WebhookPayload is the payload sent to webhook endpoints.
type WebhookPayload struct {
	Event     string          `json:"event"`
	Table     string          `json:"table"`
	Record    json.RawMessage `json:"record,omitempty"`
	OldRecord json.RawMessage `json:"old_record,omitempty"`
}

// DeliverFromWebhookNotify parses a 'pgstack_webhooks' NOTIFY payload — emitted
// by the pgstack.webhook_notify() trigger — and delivers it to every matching
// registered webhook. Called from the listener loop for that channel.
//
// This replaces the earlier attempt to derive webhooks from the 'pgr'
// live-query delta stream: those deltas carry no table name and only fire when
// a live query happens to be subscribed, so they could never drive webhooks
// correctly. The dedicated trigger emits {table, event, record, old_record}.
func (wm *WebhookManager) DeliverFromWebhookNotify(payload string) {
	var ev struct {
		Table     string          `json:"table"`
		Event     string          `json:"event"`
		Record    json.RawMessage `json:"record"`
		OldRecord json.RawMessage `json:"old_record"`
		Oversized bool            `json:"oversized"`
	}
	if err := json.Unmarshal([]byte(payload), &ev); err != nil {
		log.Warn().Str("payload", payload).Err(err).Msg("webhooks: invalid NOTIFY payload")
		return
	}
	if ev.Table == "" || ev.Event == "" {
		return
	}
	if ev.Oversized {
		log.Warn().Str("table", ev.Table).Str("event", ev.Event).
			Msg("webhooks: row exceeded NOTIFY size limit — delivered without record body")
	}

	wm.mu.RLock()
	hooks := make([]Webhook, len(wm.webhooks))
	copy(hooks, wm.webhooks)
	wm.mu.RUnlock()

	for _, wh := range hooks {
		if !wh.Active {
			continue
		}
		if !matchesEvent(wh.Events, ev.Event) {
			continue
		}
		if wh.TableName != "*" && !strings.EqualFold(wh.TableName, ev.Table) {
			continue
		}
		wp := WebhookPayload{
			Event:     ev.Event,
			Table:     ev.Table,
			Record:    nilIfJSONNull(ev.Record),
			OldRecord: nilIfJSONNull(ev.OldRecord),
		}
		// Deliver async with retry.
		go wm.deliverWithRetry(wh, wp)
	}
}

// nilIfJSONNull returns nil for an absent or literal-null json.RawMessage so
// that WebhookPayload's omitempty tags drop the field instead of emitting
// "record":null.
func nilIfJSONNull(r json.RawMessage) json.RawMessage {
	if len(r) == 0 || string(r) == "null" {
		return nil
	}
	return r
}

func matchesEvent(events []string, event string) bool {
	for _, e := range events {
		if strings.EqualFold(e, event) || e == "*" {
			return true
		}
	}
	return false
}

// deliverWithRetry sends the webhook payload with 3 attempts and exponential backoff.
func (wm *WebhookManager) deliverWithRetry(wh Webhook, wp WebhookPayload) {
	body, err := json.Marshal(wp)
	if err != nil {
		log.Error().Err(err).Str("webhook_id", wh.ID).Msg("webhook: marshal payload")
		return
	}

	delays := []time.Duration{0, 1 * time.Second, 4 * time.Second, 16 * time.Second}

	for attempt := 0; attempt < 3; attempt++ {
		if delays[attempt] > 0 {
			time.Sleep(delays[attempt])
		}

		err := wm.deliver(wh, body)
		if err == nil {
			log.Debug().Str("webhook_id", wh.ID).Str("url", wh.URL).Int("attempt", attempt+1).Msg("webhook delivered")
			return
		}

		log.Warn().Err(err).Str("webhook_id", wh.ID).Str("url", wh.URL).Int("attempt", attempt+1).Msg("webhook delivery failed")
	}

	log.Error().Str("webhook_id", wh.ID).Str("url", wh.URL).Msg("webhook delivery failed after 3 attempts")
}

func (wm *WebhookManager) deliver(wh Webhook, body []byte) error {
	req, err := http.NewRequest(http.MethodPost, wh.URL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "pgstack-webhooks/1.0")

	// HMAC-SHA256 signature
	if wh.Secret != "" {
		mac := hmac.New(sha256.New, []byte(wh.Secret))
		mac.Write(body)
		sig := hex.EncodeToString(mac.Sum(nil))
		req.Header.Set("X-Webhook-Signature", "sha256="+sig)
	}

	resp, err := wm.client.Do(req)
	if err != nil {
		return fmt.Errorf("POST %s: %w", wh.URL, err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body) // drain body

	if resp.StatusCode >= 300 {
		return fmt.Errorf("POST %s returned %d", wh.URL, resp.StatusCode)
	}
	return nil
}
