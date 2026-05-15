package realtime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"pgstack-proxy-go/middleware"
)

// safeQueryIDRe matches only alphanumeric characters, underscores, and hyphens.
// Any query_id that doesn't match is rejected to prevent SQL injection via the
// dynamic table name in the snapshot query.
var safeQueryIDRe = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// WSHandler returns an http.HandlerFunc that upgrades HTTP to WebSocket and
// manages the live-query connection lifecycle.
//
// allowedOrigins controls WebSocket Origin header validation. When set, only
// requests whose Origin header matches one of the listed origins are accepted.
// When empty, behavior depends on allowPermissive:
//   - allowPermissive=true → all origins accepted (DEV ONLY)
//   - allowPermissive=false → cross-origin upgrades rejected; same-origin and
//     non-browser clients (no Origin header) accepted.
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
	hub *Hub,
	semaphore chan struct{},
	broadcastCapacity int,
	allowedOrigins []string,
	allowPermissive bool,
	requireAuthenticated bool,
) http.HandlerFunc {
	upgrader := websocket.Upgrader{
		HandshakeTimeout: 10 * time.Second,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if len(allowedOrigins) == 0 {
				if allowPermissive {
					return true // explicit dev override
				}
				// Strict default: accept only requests with no Origin (CLI / SSR /
				// server-to-server) or whose Origin matches the Host header (same-origin).
				if origin == "" {
					return true
				}
				return originMatchesHost(origin, r.Host)
			}
			for _, ao := range allowedOrigins {
				if origin == ao {
					return true
				}
			}
			return false
		},
	}

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
				if middleware.ConstantTimeEqExported(authHeader, "Bearer "+cfg.AnonKey) || middleware.ConstantTimeEqExported(apikeyParam, cfg.AnonKey) {
					isAnon = true
				}
			}

			// REQUIRE_AUTHENTICATED_WS: anon-key holders cannot subscribe — only
			// real JWTs (authenticated or service_role). Closes the "anon key +
			// guessable query_id = read-anyone's-live-query" vector.
			if isAnon && requireAuthenticated {
				writeWSError(w, http.StatusUnauthorized, "authenticated subscription required")
				return
			}

			if !isAnon {
				// Try to extract a JWT from Bearer header or ?token= query param.
				// Browsers cannot set custom headers on WebSocket upgrades, so
				// ?token= is the primary mechanism for authenticated WS connections.
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

				// Inject token into Authorization header so ResolveClaims can find it
				r.Header.Set("Authorization", "Bearer "+token)
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

		go handleWebSocket(conn, queryID, hub, pool, broadcastCapacity, semaphore)
	}
}

// handleWebSocket manages an established WebSocket connection. It runs in its
// own goroutine and releases the semaphore slot when it exits.
func handleWebSocket(
	conn *websocket.Conn,
	queryID string,
	hub *Hub,
	pool *pgxpool.Pool,
	broadcastCapacity int,
	semaphore chan struct{},
) {
	// Generate a unique client ID for presence tracking.
	clientID := generateClientID()

	// Subscribe first so the channel is registered before the defer runs.
	ch := hub.Subscribe(queryID, broadcastCapacity)
	defer func() {
		hub.PresenceLeave(queryID, clientID)
		conn.Close()
		<-semaphore // release connection slot
		hub.Unsubscribe(queryID, ch)
	}()

	// Register presence (empty initial state).
	hub.PresenceJoin(queryID, clientID, []byte("{}"))

	log.Info().Str("query_id", queryID).Str("client_id", clientID).Msg("WebSocket connected")

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

	// Send initial snapshot — skip for notify-mode subscriptions (no _snap_ table exists by design).
	mode := subscriptionMode(pool, queryID)
	if mode != "notify" {
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
	} else {
		log.Info().Str("query_id", queryID).Msg("notify-mode subscription: skipping snapshot fetch")
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
			log.Debug().Str("query_id", queryID).Int("type", mt).Int("len", len(data)).Msg("WS read pump: message received")
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
			case websocket.TextMessage:
				dispatchClientMessage(hub, queryID, clientID, msg.data)
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


// dispatchClientMessage routes a text frame received from a WS client.
//
// Server-deltas flow from the PG NOTIFY listener via Hub.Broadcast — clients
// must not be able to forge those events. We accept exactly two client
// message types:
//
//   - {"type":"presence","state":{...}}     → presence update (peer-state sync)
//   - {"type":"broadcast","payload":<any>}  → peer-to-peer broadcast, wrapped
//     server-side as {"type":"broadcast","from":<clientID>,"payload":<orig>}
//     so receivers cannot confuse it with a server delta.
//
// Anything else (unparseable, missing/unknown type, raw "{inserted:[...]}"
// shapes) is dropped at debug level. Extracted so the policy is testable
// without spinning up a real WebSocket.
func dispatchClientMessage(hub *Hub, queryID, clientID string, data []byte) {
	var typed struct {
		Type     string          `json:"type"`
		State    json.RawMessage `json:"state"`
		Payload  json.RawMessage `json:"payload"`
		ClientID string          `json:"client_id"`
	}
	if err := json.Unmarshal(data, &typed); err != nil {
		log.Debug().Str("query_id", queryID).Str("client_id", clientID).
			Int("bytes", len(data)).Msg("dropped client message: malformed JSON")
		return
	}
	switch typed.Type {
	case "presence":
		cid := typed.ClientID
		if cid == "" {
			cid = clientID
		}
		hub.PresenceUpdate(queryID, cid, typed.State)
	case "broadcast":
		envelope, _ := json.Marshal(map[string]any{
			"type":    "broadcast",
			"from":    clientID,
			"payload": typed.Payload,
		})
		hub.Broadcast(queryID, string(envelope))
	default:
		log.Debug().Str("query_id", queryID).Str("client_id", clientID).
			Str("type", typed.Type).Int("bytes", len(data)).
			Msg("dropped client message: unknown type")
	}
}

// originMatchesHost returns true when the request's Origin header points at
// the same host:port as the Host header — i.e. a same-origin WS upgrade. Used
// as the strict-mode fallback when ALLOWED_ORIGINS is empty.
func originMatchesHost(origin, host string) bool {
	// Origin = "scheme://host[:port]"; strip the scheme then compare host parts.
	i := strings.Index(origin, "://")
	if i < 0 {
		return false
	}
	return origin[i+3:] == host
}

// subscriptionMode returns the registered mode ("delta" or "notify") for a query_id.
// Returns "delta" on any error (safe default — delta-mode fetchSnapshot already swallows
// missing-table errors gracefully, so a wrong guess only costs one extra query).
func subscriptionMode(pool *pgxpool.Pool, queryID string) string {
	var mode string
	err := pool.QueryRow(context.Background(),
		`SELECT mode FROM pgr.get_subscriptions() WHERE query_id = $1`, queryID).Scan(&mode)
	if err != nil {
		log.Debug().Str("query_id", queryID).Err(err).Msg("subscription mode lookup failed; defaulting to delta")
		return "delta"
	}
	return mode
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

// generateClientID returns 16 random bytes hex-encoded as a unique client identifier.
func generateClientID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// PresenceHandler returns the current presence list for a channel.
// GET /ws/_presence/{channel}
func PresenceHandler(hub *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channel := chi.URLParam(r, "channel")
		if channel == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"channel is required"}`))
			return
		}

		presenceMap := hub.PresenceList(channel)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(presenceMap)
	}
}

// writeWSError writes a plain HTTP error before WebSocket upgrade. Once the
// connection is upgraded this is no longer possible.
func writeWSError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body, _ := json.Marshal(map[string]string{"error": msg})
	_, _ = w.Write(body)
}
