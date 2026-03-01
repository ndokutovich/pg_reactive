package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
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
// channels (sync.Map keyed by query_id → chan string).
//
// The loop applies exponential back-off on failures: 1s → 2s → 4s → … up to
// maxBackoff. On clean exit (context cancelled) it returns immediately.
func ListenLoop(dbURL string, channels *sync.Map, connected *atomic.Bool, maxBackoff time.Duration) {
	backoff := time.Second
	for {
		connected.Store(false)
		if err := listenOnce(context.Background(), dbURL, channels, connected); err != nil {
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
func listenOnce(ctx context.Context, dbURL string, channels *sync.Map, connected *atomic.Bool) error {
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)

	if _, err = conn.Exec(ctx, "LISTEN pgr"); err != nil {
		return err
	}
	connected.Store(true)
	log.Info().Msg("connected to PG, listening on channel 'pgr'")

	for {
		notification, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}

		payload := notification.Payload

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

		if v, ok := channels.Load(msg.QueryID); ok {
			ch := v.(chan string)
			// Non-blocking send: if the channel is full, drain one item
			// and push an overflow notification so the client knows to
			// refetch the full snapshot.
			select {
			case ch <- payload:
			default:
				// Channel full — drain the oldest message to make room.
				// Since listenOnce is the sole writer to this channel,
				// the slot freed by the drain is guaranteed to be available.
				select {
				case <-ch:
				default:
				}
				overflow := fmt.Sprintf(
					`{"type":"overflow","query_id":%q,"fetch":true}`,
					msg.QueryID,
				)
				ch <- overflow
			}
		}
	}
}
