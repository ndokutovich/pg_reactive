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
// connection listening on the configured live-query NOTIFY channel
// (notifyChannel, default 'pgr' — must match the extension's
// pg_reactive.notify_channel GUC).
//
// On each NOTIFY payload it parses the JSON, extracts the query_id and
// forwards the raw payload string to the matching broadcast channel in
// the Hub, which fans the payload out to all per-subscriber channels.
//
// The loop applies exponential back-off on failures: 1s → 2s → 4s → … up to
// maxBackoff. On clean exit (context cancelled) it returns immediately.
func ListenLoop(dbURL string, hub *Hub, connected *atomic.Bool, maxBackoff time.Duration, webhookMgr *WebhookManager, notifyChannel string) {
	backoff := time.Second
	for {
		connected.Store(false)
		if err := listenOnce(context.Background(), dbURL, hub, connected, webhookMgr, notifyChannel); err != nil {
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

// listenOnce opens a dedicated PG connection, executes LISTEN on the configured
// live-query channel (notifyChannel) plus the webhook channel, and pumps
// notifications until an error occurs or the context is cancelled.
func listenOnce(ctx context.Context, dbURL string, hub *Hub, connected *atomic.Bool, webhookMgr *WebhookManager, notifyChannel string) error {
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)

	// notifyChannel is validated as a PG identifier at config load; Sanitize
	// double-quotes it so the channel name PG reports back round-trips exactly
	// (case-preserving) to the comparison below.
	if _, err = conn.Exec(ctx, "LISTEN "+pgx.Identifier{notifyChannel}.Sanitize()); err != nil {
		return err
	}
	// Webhooks ride a dedicated channel fed by the pgstack.webhook_notify()
	// trigger — separate from the live-query delta stream.
	if _, err = conn.Exec(ctx, "LISTEN pgstack_webhooks"); err != nil {
		return err
	}
	connected.Store(true)
	log.Info().Str("channel", notifyChannel).Msg("connected to PG, listening on live-query channel and 'pgstack_webhooks'")

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

		// Anything that is not the configured live-query channel is unexpected
		// (we only LISTEN on notifyChannel + pgstack_webhooks). Drop it loudly
		// rather than misroute it as a delta.
		if notification.Channel != notifyChannel {
			log.Warn().Str("channel", notification.Channel).Msg("NOTIFY on unexpected channel, ignoring")
			continue
		}

		// The live-query channel carries two kinds of message, both stamped with the
		// subscription generation by the extension (round 39 batch-2):
		//   - {"type":"resubscribed","query_id":...,"gen":N} — a subscribe or
		//     unsubscribe bumped the generation. Revoke every connection bound to
		//     an older generation so stale clients reconnect and rebind the new
		//     epoch (liveness; the data boundary is the generation match below).
		//   - everything else — a live-query delta/overflow/invalidated payload
		//     carrying the "gen" of the shmem entry it was computed from. It is
		//     delivered ONLY to connections bound to that exact generation, so a
		//     delta produced from a re-registered (new-epoch) query — even one
		//     emitted in the non-transactional window before the subscribe
		//     commits — never reaches an old-epoch connection (F-ORDER).
		var msg struct {
			Type    string `json:"type"`
			QueryID string `json:"query_id"`
			Gen     int64  `json:"gen"`
		}
		if err := json.Unmarshal([]byte(payload), &msg); err != nil {
			log.Warn().Str("payload", payload).Err(err).Msg("invalid JSON from PG NOTIFY")
			continue
		}
		if msg.QueryID == "" {
			log.Warn().Str("payload", payload).Msg("NOTIFY payload missing query_id")
			continue
		}

		if msg.Type == "resubscribed" {
			hub.RevokeStale(msg.QueryID, msg.Gen)
			continue
		}
		hub.BroadcastGen(msg.QueryID, payload, msg.Gen)
	}
}
