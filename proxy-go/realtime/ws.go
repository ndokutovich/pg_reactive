package realtime

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"pgstack-proxy-go/middleware"
)

var upgrader = websocket.Upgrader{
	HandshakeTimeout: 10 * time.Second,
	CheckOrigin: func(r *http.Request) bool {
		// Origin checking is handled by the CORS middleware on the outer router.
		return true
	},
}

// safeQueryIDRe matches only alphanumeric characters, underscores, and hyphens.
// Any query_id that doesn't match is rejected to prevent SQL injection via the
// dynamic table name in the snapshot query.
var safeQueryIDRe = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// WSHandler returns an http.HandlerFunc that upgrades HTTP to WebSocket and
// manages the live-query connection lifecycle.
//
// Lifecycle:
//  1. Resolve auth claims (honours JWT, service_role key, anon key).
//  2. Acquire WSSemaphore slot (503 if exhausted).
//  3. Upgrade to WebSocket.
//  4. Send welcome message: {"type":"subscribed","query_id":"<id>"}
//  5. Fetch initial snapshot from pgr._snap_<query_id> and send it.
//  6. Pump broadcast channel → WebSocket until disconnection.
func WSHandler(
	cfg middleware.RLSConfig,
	pool *pgxpool.Pool,
	channels *sync.Map,
	semaphore chan struct{},
	broadcastCapacity int,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		queryID := chi.URLParam(r, "queryID")
		if queryID == "" {
			http.Error(w, `{"error":"missing query_id"}`, http.StatusBadRequest)
			return
		}

		// Auth: mirror the Rust ws_handler logic — check JWT/service_role when
		// a JWT secret is configured.
		if cfg.JWTSecret != "" {
			authHeader := r.Header.Get("Authorization")
			apikeyParam := r.URL.Query().Get("apikey")

			// Check anon key — via Authorization header or ?apikey= query param.
			// WebSocket connections from browsers cannot set custom headers, so
			// ?apikey= is the primary mechanism for browser-based auth.
			var isAnon bool
			if cfg.AnonKey != "" {
				if authHeader == "Bearer "+cfg.AnonKey || apikeyParam == cfg.AnonKey {
					isAnon = true
				}
			}

			if !isAnon {
				// Try to extract and validate a JWT from Bearer or ?token= param.
				var token string
				if len(authHeader) > 7 && authHeader[:7] == "Bearer " {
					token = authHeader[7:]
				}
				if token == "" {
					token = r.URL.Query().Get("token")
				}
				if token == "" {
					writeWSError(w, http.StatusUnauthorized, "authentication required")
					return
				}

				claims, err := middleware.ResolveClaims(r, cfg)
				if err != nil || claims.Role == "" {
					writeWSError(w, http.StatusUnauthorized, "authentication required")
					return
				}
			}
		}

		// Acquire semaphore slot (non-blocking).
		select {
		case semaphore <- struct{}{}:
		default:
			writeWSError(w, http.StatusServiceUnavailable, "too many WebSocket connections")
			return
		}

		// Upgrade to WebSocket.
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			// upgrader.Upgrade already wrote the HTTP error response.
			<-semaphore
			log.Warn().Err(err).Msg("WebSocket upgrade failed")
			return
		}

		go handleWebSocket(conn, queryID, channels, pool, broadcastCapacity, semaphore)
	}
}

// handleWebSocket manages an established WebSocket connection. It runs in its
// own goroutine and releases the semaphore slot when it exits.
func handleWebSocket(
	conn *websocket.Conn,
	queryID string,
	channels *sync.Map,
	pool *pgxpool.Pool,
	broadcastCapacity int,
	semaphore chan struct{},
) {
	defer func() {
		conn.Close()
		<-semaphore // release connection slot
		cleanupChannel(queryID, channels)
	}()

	log.Info().Str("query_id", queryID).Msg("WebSocket connected")

	// Get or create broadcast channel for this query_id.
	ch := getOrCreateChannel(queryID, channels, broadcastCapacity)

	// write mutex: gorilla/websocket requires serialised writes.
	var wmu sync.Mutex

	safeSend := func(msgType int, data []byte) error {
		wmu.Lock()
		defer wmu.Unlock()
		return conn.WriteMessage(msgType, data)
	}

	// Send welcome message.
	welcome, _ := json.Marshal(map[string]string{
		"type":     "subscribed",
		"query_id": queryID,
	})
	if err := safeSend(websocket.TextMessage, welcome); err != nil {
		log.Error().Err(err).Msg("failed to send welcome")
		return
	}

	// Send initial snapshot.
	if rows, err := fetchSnapshot(pool, queryID); err == nil && len(rows) > 0 {
		snap, _ := json.Marshal(map[string]any{
			"query_id": queryID,
			"inserted": rows,
			"deleted":  []any{},
		})
		if err := safeSend(websocket.TextMessage, snap); err != nil {
			log.Error().Err(err).Msg("failed to send snapshot")
			return
		}
		log.Info().Str("query_id", queryID).Int("rows", len(rows)).Msg("sent initial snapshot")
	}

	// Incoming WS message pump (in a goroutine so we can select on it).
	wsMessages := make(chan wsMessage, 8)
	go func() {
		defer close(wsMessages)
		for {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				wsMessages <- wsMessage{err: err}
				return
			}
			wsMessages <- wsMessage{msgType: mt, data: data}
		}
	}()

	// Main event loop.
	for {
		select {
		case payload, ok := <-ch:
			if !ok {
				// Channel was closed (should not happen, but handle gracefully).
				return
			}
			if err := safeSend(websocket.TextMessage, []byte(payload)); err != nil {
				log.Info().Str("query_id", queryID).Err(err).Msg("WebSocket send error")
				return
			}

		case msg, ok := <-wsMessages:
			if !ok || msg.err != nil {
				if msg.err != nil {
					log.Info().Str("query_id", queryID).Err(msg.err).Msg("WebSocket read error")
				}
				return
			}
			switch msg.msgType {
			case websocket.CloseMessage:
				log.Info().Str("query_id", queryID).Msg("WebSocket disconnected (close frame)")
				return
			case websocket.PingMessage:
				wmu.Lock()
				_ = conn.WriteMessage(websocket.PongMessage, msg.data)
				wmu.Unlock()
			}
		}
	}
}

type wsMessage struct {
	msgType int
	data    []byte
	err     error
}

// getOrCreateChannel returns an existing broadcast channel for queryID or
// creates a new one with the given capacity. Uses sync.Map.LoadOrStore for
// safe concurrent creation.
func getOrCreateChannel(queryID string, channels *sync.Map, capacity int) chan string {
	ch := make(chan string, capacity)
	actual, _ := channels.LoadOrStore(queryID, ch)
	return actual.(chan string)
}

// cleanupChannel removes the broadcast channel for queryID from channels if
// no goroutines are blocked on it (best-effort; channels may be recreated).
func cleanupChannel(queryID string, channels *sync.Map) {
	// We cannot know the receiver count with a plain channel, so we only remove
	// the channel if it still refers to the same instance we stored (i.e. no
	// concurrent replacement has happened). For simplicity we always remove —
	// the next subscriber will simply create a fresh channel.
	channels.Delete(queryID)
	log.Info().Str("query_id", queryID).Msg("removed broadcast channel")
}

// fetchSnapshot queries pgr._snap_<queryID> and returns rows as JSON objects.
func fetchSnapshot(pool *pgxpool.Pool, queryID string) ([]json.RawMessage, error) {
	if !safeQueryIDRe.MatchString(queryID) {
		return nil, nil
	}

	// Use double-quote escaping for the identifier (query_id already validated above).
	safeID := queryID // already validated: alphanumeric + _ + -
	sql := `SELECT row_to_json(t) AS doc FROM pgr."_snap_` + safeID + `" t`

	rows, err := pool.Query(context.Background(), sql)
	if err != nil {
		log.Debug().Str("query_id", queryID).Err(err).Msg("snapshot fetch failed")
		return nil, err
	}
	defer rows.Close()

	var result []json.RawMessage
	for rows.Next() {
		var raw json.RawMessage
		if err := rows.Scan(&raw); err != nil {
			continue
		}
		result = append(result, raw)
	}
	return result, rows.Err()
}

// writeWSError writes a plain HTTP error before WebSocket upgrade. Once the
// connection is upgraded this is no longer possible.
func writeWSError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body, _ := json.Marshal(map[string]string{"error": msg})
	_, _ = w.Write(body)
}
