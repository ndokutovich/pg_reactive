package realtime

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// ListenLoop is an infinite reconnect loop that keeps a dedicated PG
// connection listening on the 'pgr' NOTIFY channel.
//
// On each NOTIFY payload it parses the JSON, extracts the query_id and
// forwards the raw payload string to the matching broadcast channel in
// the Hub, which fans the payload out to all per-subscriber channels.
//
// The loop applies exponential back-off on failures: 1s → 2s → 4s → … up to
// maxBackoff. On clean exit (context cancelled) it returns immediately.
func ListenLoop(dbURL string, hub *Hub, connected *atomic.Bool, maxBackoff time.Duration, webhookMgr *WebhookManager) {
	backoff := time.Second
	for {
		connected.Store(false)
		if err := listenOnce(context.Background(), dbURL, hub, connected, webhookMgr); err != nil {
			log.Error().Err(err).Dur("retry_in", backoff).Msg("PG listener error, reconnecting")
		} else {
			log.Info().Msg("PG listener exited normally, reconnecting")
			backoff = time.Second // reset on clean exit
		}
		connected.Store(false)
		time.Sleep(backoff)
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// listenOnce opens a dedicated PG connection, executes LISTEN pgr and pumps
// notifications until an error occurs or the context is cancelled.
func listenOnce(ctx context.Context, dbURL string, hub *Hub, connected *atomic.Bool, webhookMgr *WebhookManager) error {
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)

	if _, err = conn.Exec(ctx, "LISTEN pgr"); err != nil {
		return err
	}
	// Webhooks ride a dedicated channel fed by the pgstack.webhook_notify()
	// trigger — separate from the 'pgr' live-query delta stream.
	if _, err = conn.Exec(ctx, "LISTEN pgstack_webhooks"); err != nil {
		return err
	}
	connected.Store(true)
	log.Info().Msg("connected to PG, listening on channels 'pgr' and 'pgstack_webhooks'")

	for {
		notification, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}

		payload := notification.Payload

		// Webhook trigger events: {table, event, record, old_record}.
		if notification.Channel == "pgstack_webhooks" {
			if webhookMgr != nil {
				webhookMgr.DeliverFromWebhookNotify(payload)
			}
			continue
		}

		// 'pgr' channel: live-query delta — fan out to WebSocket subscribers.
		var msg struct {
			QueryID string `json:"query_id"`
		}
		if err := json.Unmarshal([]byte(payload), &msg); err != nil {
			log.Warn().Str("payload", payload).Err(err).Msg("invalid JSON from PG NOTIFY")
			continue
		}
		if msg.QueryID == "" {
			log.Warn().Str("payload", payload).Msg("NOTIFY payload missing query_id")
			continue
		}

		hub.Broadcast(msg.QueryID, payload)
	}
}
