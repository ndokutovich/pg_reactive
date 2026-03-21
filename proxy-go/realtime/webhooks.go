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
)

// Webhook represents a registered webhook from pgstack.webhooks.
type Webhook struct {
	ID        string   `json:"id"`
	URL       string   `json:"url"`
	Events    []string `json:"events"`    // e.g. ["INSERT", "UPDATE", "DELETE"]
	TableName string   `json:"table_name"` // e.g. "orders" or "*" for all
	Secret    string   `json:"secret"`
	Active    bool     `json:"active"`
	CreatedAt string   `json:"created_at"`
}

// WebhookManager loads webhooks from DB and delivers payloads.
type WebhookManager struct {
	pool     *pgxpool.Pool
	mu       sync.RWMutex
	webhooks []Webhook
	client   *http.Client
}

// NewWebhookManager creates a WebhookManager with reasonable HTTP timeouts.
func NewWebhookManager(pool *pgxpool.Pool) *WebhookManager {
	return &WebhookManager{
		pool: pool,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// Refresh reloads all active webhooks from the database.
func (wm *WebhookManager) Refresh(ctx context.Context) error {
	rows, err := wm.pool.Query(ctx,
		`SELECT id::text, url, events, table_name, secret, active, created_at
		 FROM pgstack.webhooks WHERE active = true`)
	if err != nil {
		return fmt.Errorf("webhooks refresh: %w", err)
	}
	defer rows.Close()

	var hooks []Webhook
	for rows.Next() {
		var wh Webhook
		var createdAt time.Time
		if err := rows.Scan(&wh.ID, &wh.URL, &wh.Events, &wh.TableName, &wh.Secret, &wh.Active, &createdAt); err != nil {
			return fmt.Errorf("webhooks scan: %w", err)
		}
		wh.CreatedAt = createdAt.Format(time.RFC3339)
		hooks = append(hooks, wh)
	}

	wm.mu.Lock()
	wm.webhooks = hooks
	wm.mu.Unlock()

	log.Info().Int("count", len(hooks)).Msg("webhooks refreshed")
	return nil
}

// WebhookPayload is the payload sent to webhook endpoints.
type WebhookPayload struct {
	Event     string          `json:"event"`
	Table     string          `json:"table"`
	Record    json.RawMessage `json:"record,omitempty"`
	OldRecord json.RawMessage `json:"old_record,omitempty"`
}

// DeliverFromNotify parses a NOTIFY payload and delivers to matching webhooks.
// Called after hub.Broadcast in the listener loop.
func (wm *WebhookManager) DeliverFromNotify(payload string) {
	// Parse the delta payload to extract table and event info
	var delta struct {
		QueryID  string            `json:"query_id"`
		Inserted []json.RawMessage `json:"inserted"`
		Deleted  []json.RawMessage `json:"deleted"`
		Type     string            `json:"type"`
		Table    string            `json:"table"`
	}
	if err := json.Unmarshal([]byte(payload), &delta); err != nil {
		return // not a valid delta payload
	}

	// Skip overflow/subscribed messages
	if delta.Type == "overflow" || delta.Type == "subscribed" {
		return
	}

	// Determine event type and table from the delta content
	tableName := delta.Table
	if tableName == "" {
		// Try to extract table from query_id (common pattern: table_hash)
		return // Can't determine table — skip webhook delivery
	}

	wm.mu.RLock()
	hooks := make([]Webhook, len(wm.webhooks))
	copy(hooks, wm.webhooks)
	wm.mu.RUnlock()

	if len(hooks) == 0 {
		return
	}

	// Determine events
	var events []string
	if len(delta.Inserted) > 0 && len(delta.Deleted) > 0 {
		events = append(events, "UPDATE")
	} else if len(delta.Inserted) > 0 {
		events = append(events, "INSERT")
	} else if len(delta.Deleted) > 0 {
		events = append(events, "DELETE")
	}

	for _, event := range events {
		for _, wh := range hooks {
			if !wh.Active {
				continue
			}
			if !matchesEvent(wh.Events, event) {
				continue
			}
			if wh.TableName != "*" && !strings.EqualFold(wh.TableName, tableName) {
				continue
			}

			// Build payload
			wp := WebhookPayload{
				Event: event,
				Table: tableName,
			}
			if len(delta.Inserted) > 0 {
				wp.Record = delta.Inserted[0]
			}
			if len(delta.Deleted) > 0 {
				wp.OldRecord = delta.Deleted[0]
			}

			// Deliver async with retry
			go wm.deliverWithRetry(wh, wp)
		}
	}
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
