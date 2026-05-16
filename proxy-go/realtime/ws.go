package realtime

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
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

		// Claims captured from auth so the audience check below can match
		// against the JWT payload. Defaults to anon when no JWT secret is set
		// (auth disabled in dev).
		var claims middleware.RequestClaims
		var isAnon bool

		// Auth: mirror the Rust ws_handler logic — check JWT/service_role when
		// a JWT secret is configured.
		if cfg.JWTSecret != "" {
			authHeader := r.Header.Get("Authorization")
			apikeyParam := r.URL.Query().Get("apikey")

			// Check anon key — via Authorization header or ?apikey= query param.
			// WebSocket connections from browsers cannot set custom headers, so
			// ?apikey= is the primary mechanism for browser-based auth.
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

			if isAnon {
				claims = middleware.RequestClaims{Role: "anon"}
			} else {
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
				resolved, err := middleware.ResolveClaims(r, cfg)
				if err != nil || resolved.Role == "" {
					writeWSError(w, http.StatusUnauthorized, "authentication required")
					return
				}
				claims = resolved
			}
		}

		// Audience enforcement (since 2026-05, finding F1; hardened to
		// fail-closed after the F2 review). A subscription registered with
		// a non-NULL audience JSON is only deliverable to a JWT whose
		// claims satisfy that predicate. service_role bypasses; anon is
		// always rejected when audience is set (even if
		// REQUIRE_AUTHENTICATED_WS=false).
		//
		// Metadata lookup is fail-closed: an unknown subscription returns
		// 404, and any DB error (permission denied, connection failure)
		// returns 503. Earlier code defaulted to ("delta", "") on error,
		// which silently disabled audience enforcement.
		mode, audience, metaErr := subscriptionMeta(pool, queryID)
		if metaErr != nil {
			if errors.Is(metaErr, ErrSubscriptionNotFound) {
				writeWSError(w, http.StatusNotFound, "subscription not found")
			} else {
				writeWSError(w, http.StatusServiceUnavailable, "subscription metadata unavailable")
			}
			return
		}
		if audience != "" && claims.Role != "service_role" {
			if isAnon {
				writeWSError(w, http.StatusForbidden, "subscription requires an authenticated JWT")
				return
			}
			if !claimsSatisfyAudience(audience, claims.ClaimsJSON) {
				writeWSError(w, http.StatusForbidden, "JWT claims do not satisfy subscription audience")
				return
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

		go handleWebSocket(conn, queryID, mode, hub, pool, broadcastCapacity, semaphore)
	}
}

// handleWebSocket manages an established WebSocket connection. It runs in its
// own goroutine and releases the semaphore slot when it exits. `mode` is the
// subscription mode ("delta" or "notify") resolved in the handshake phase;
// passed through so we don't re-query the catalog.
func handleWebSocket(
	conn *websocket.Conn,
	queryID string,
	mode string,
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

// ErrSubscriptionNotFound is returned by subscriptionMeta when no row exists
// in pgr.get_subscriptions() for the given query_id and the id does not match
// the ad-hoc public-channel prefix convention.
var ErrSubscriptionNotFound = errors.New("subscription not found")

// channelPrefixes lists query_id prefixes that are treated as ad-hoc public
// broadcast / presence channels — they don't need a pre-registered row in
// pgr.get_subscriptions(). Use audience binding (server-registered) for any
// channel that should be private.
var channelPrefixes = []string{"_channel_", "_presence_"}

// isAdHocChannel reports whether a query_id is allowed to connect without
// a pre-registered pgr subscription. Pulled out for unit testing.
func isAdHocChannel(queryID string) bool {
	for _, p := range channelPrefixes {
		if strings.HasPrefix(queryID, p) {
			return true
		}
	}
	return false
}

// subscriptionMeta returns the registered mode and audience for a query_id.
//
//   - mode is "delta" or "notify".
//   - audience is the raw JSON string of the audience constraint, or "" when
//     the subscription is public (NULL audience).
//
// Failure modes (since the 2026-05 audit closed the previous fail-open
// vector — silently returning ("delta", "") on any DB error meant an
// audience-bound subscription could become unprotected if the proxy's
// EXECUTE grant on pgr.get_subscriptions was revoked or the DB blipped):
//
//   - pgx.ErrNoRows + query_id matches an ad-hoc channel prefix
//     → mode="delta", audience="", err=nil. Public ad-hoc channel.
//   - pgx.ErrNoRows otherwise → err = ErrSubscriptionNotFound.
//     Caller responds 404; we DO NOT silently treat as public.
//   - Any other error (permission denied, connection failure, timeout)
//     → err surfaced as-is. Caller responds 503; we DO NOT silently
//     treat as public.
func subscriptionMeta(pool *pgxpool.Pool, queryID string) (mode, audience string, err error) {
	var aud *string
	err = pool.QueryRow(context.Background(),
		`SELECT mode, audience::text FROM pgr.get_subscriptions() WHERE query_id = $1`,
		queryID).Scan(&mode, &aud)
	if err == nil {
		if aud != nil {
			audience = *aud
		}
		return mode, audience, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		if isAdHocChannel(queryID) {
			return "delta", "", nil
		}
		return "", "", ErrSubscriptionNotFound
	}
	// Permission denied, connection failure, etc — surface to caller so it
	// returns 503 instead of accepting the WS upgrade unprotected.
	log.Warn().Str("query_id", queryID).Err(err).
		Msg("subscription metadata lookup failed; rejecting WS to fail closed")
	return "", "", fmt.Errorf("subscription metadata lookup: %w", err)
}

// claimsSatisfyAudience returns true when every key in the audience JSON
// matches the corresponding claim in claimsJSON.
//
// Semantics:
//   - audience is a flat JSON object: {"sub":"42","role":"authenticated"}
//   - For each key in audience, the same key must exist in claimsJSON and
//     stringified values must compare equal. Numbers / bools / strings are
//     coerced via JSON marshalling so {"sub":42} matches {"sub":42} and
//     {"sub":"42"} matches {"sub":"42"} but {"sub":42} does NOT match
//     {"sub":"42"}. Pick a consistent encoding when issuing JWTs.
//   - Empty audience ("") is treated as no constraint and returns true.
//   - Malformed JSON on either side fails closed: returns false.
func claimsSatisfyAudience(audience, claimsJSON string) bool {
	if audience == "" {
		return true
	}
	var aud map[string]json.RawMessage
	if err := json.Unmarshal([]byte(audience), &aud); err != nil {
		log.Warn().Err(err).Str("audience", audience).Msg("audience JSON unparseable; failing closed")
		return false
	}
	var claims map[string]json.RawMessage
	if claimsJSON == "" {
		return false
	}
	if err := json.Unmarshal([]byte(claimsJSON), &claims); err != nil {
		log.Warn().Err(err).Msg("claims JSON unparseable; failing closed")
		return false
	}
	for k, wantRaw := range aud {
		gotRaw, ok := claims[k]
		if !ok {
			return false
		}
		// Byte-compare normalised forms — json.RawMessage preserves the
		// original token text, so {"sub":"42"} != {"sub":42}.
		if string(bytes.TrimSpace(gotRaw)) != string(bytes.TrimSpace(wantRaw)) {
			return false
		}
	}
	return true
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
