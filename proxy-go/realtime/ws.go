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
		mode, audience, gen, metaErr := subscriptionMeta(pool, queryID)
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

		go handleWebSocket(conn, queryID, mode, gen, hub, pool, broadcastCapacity, semaphore)
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
	gen int64,
	hub *Hub,
	pool *pgxpool.Pool,
	broadcastCapacity int,
	semaphore chan struct{},
) {
	// Generate a unique client ID for presence tracking.
	clientID := generateClientID()

	// Hard cap incoming frame size. Without this, a hostile client can
	// send arbitrarily large frames; gorilla/websocket would buffer them
	// in memory before our switch ever sees them. 64 KiB covers the
	// largest legitimate presence/broadcast payloads we expect.
	// (Audit finding F4, 2026-05.)
	conn.SetReadLimit(maxWSMessageBytes)

	// Per-connection token-bucket rate limit. 100 messages / sec sustained,
	// short burst of 20. Caught misbehaving clients are disconnected; the
	// semaphore slot is released by the defer below.
	bucket := newRateBucket(wsMsgRate, wsMsgBurst)

	// Subscribe first so the channel is registered before the defer runs. The
	// connection is bound to the generation it authorized against: a later
	// re-registration (new generation) revokes it via Hub.RevokeStale, and only
	// same-generation peers receive its presence/broadcast (round 39 batch-2).
	sub := hub.Subscribe(queryID, broadcastCapacity, gen)
	defer func() {
		hub.PresenceLeave(queryID, clientID, gen)
		conn.Close()
		<-semaphore // release connection slot
		hub.Unsubscribe(queryID, sub)
	}()

	// Register presence (empty initial state).
	hub.PresenceJoin(queryID, clientID, []byte("{}"), gen)

	log.Info().Str("query_id", queryID).Str("client_id", clientID).Msg("WebSocket connected")

	// write mutex: gorilla/websocket requires serialised writes.
	var wmu sync.Mutex

	safeSend := func(msgType int, data []byte) error {
		wmu.Lock()
		defer wmu.Unlock()
		// Bound the write so a wedged socket cannot pin this goroutine past a
		// revoke (round 39 batch-2 F-LIVENESS). A timed-out write returns an
		// error the caller treats as a disconnect.
		_ = conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
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

	// Send initial snapshot — skip notify-mode (no _snap_ table by design) and
	// ad-hoc channels (no catalog row / no snapshot). The snapshot and the
	// generation it belongs to are read ATOMICALLY in one transaction: if a
	// re-registration landed during connect the generation no longer matches
	// `gen` and we close instead of shipping rows from a generation this
	// connection never authorized — closing the snapshot TOCTOU. Fail closed on
	// any lookup error (round 39 batch-2 F3 / F-B). The client reconnects.
	if mode != "notify" && !isAdHocChannel(queryID) {
		rows, ok, err := snapshotForGeneration(pool, queryID, gen)
		if err != nil {
			log.Info().Str("query_id", queryID).Err(err).Msg("snapshot unverifiable; closing connection")
			return
		}
		if !ok {
			log.Info().Str("query_id", queryID).Msg("generation changed before snapshot; closing connection")
			return
		}
		// A re-registration may have revoked this connection between the snapshot
		// read and here (RevokeStale runs off the listener goroutine). Do not ship
		// even old-epoch rows to a revoked socket — re-check before sending
		// (round 39 batch-2 snapshot TOCTOU, defense-in-depth).
		if sub.revoked() {
			log.Info().Str("query_id", queryID).Msg("revoked before snapshot send; closing connection")
			return
		}
		if len(rows) > 0 {
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
	} else if mode == "notify" && !isAdHocChannel(queryID) {
		// Notify-mode ships no rows, so there is no snapshot to bind the
		// generation to — but the same register-after-RevokeStale race applies:
		// if a re-registration bumped the generation between the handshake read
		// and hub.Subscribe above, the revoke sweep may have already passed,
		// leaving this stale connection in the list to receive the new epoch's
		// invalidation pings. Re-validate and close on mismatch (round 39
		// batch-2 F1/F2, notify path). Fail closed on lookup error.
		if ok, err := generationMatches(pool, queryID, gen); err != nil {
			log.Info().Str("query_id", queryID).Err(err).Msg("notify generation unverifiable; closing connection")
			return
		} else if !ok {
			log.Info().Str("query_id", queryID).Msg("generation changed before notify subscribe; closing connection")
			return
		}
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
		case <-sub.revoke:
			// The subscription was re-registered under an audience this
			// connection no longer satisfies (round 39 F1) — disconnect so the
			// client must reconnect and re-authorize.
			log.Info().Str("query_id", queryID).Msg("audience changed; revoking WebSocket")
			return

		case payload, ok := <-sub.ch:
			if !ok {
				// Channel was closed (should not happen, but handle gracefully).
				return
			}
			// A revoke that arrived while this payload sat in the buffer must win
			// over draining it (round 39 F-A): select picks pseudo-randomly when
			// both cases are ready, so an authorized-when-queued delta could
			// otherwise be delivered after access was pulled. Never deliver once
			// revoked.
			select {
			case <-sub.revoke:
				return
			default:
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
				if !bucket.allow() {
					log.Warn().Str("query_id", queryID).Str("client_id", clientID).
						Msg("WS client exceeded message rate limit — disconnecting")
					return
				}
				dispatchClientMessage(hub, queryID, clientID, msg.data, gen)
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
func dispatchClientMessage(hub *Hub, queryID, clientID string, data []byte, gen int64) {
	// In-package safety net for direct test calls bypassing SetReadLimit.
	if len(data) > maxWSMessageBytes {
		log.Warn().Str("query_id", queryID).Str("client_id", clientID).
			Int("bytes", len(data)).Msg("dropped client message: oversize")
		return
	}
	var typed struct {
		Type    string          `json:"type"`
		State   json.RawMessage `json:"state"`
		Payload json.RawMessage `json:"payload"`
		// Note: client_id from the frame is INTENTIONALLY unused — the
		// server uses its handshake-generated id to prevent presence
		// spoofing across peers.
	}
	if err := json.Unmarshal(data, &typed); err != nil {
		log.Debug().Str("query_id", queryID).Str("client_id", clientID).
			Int("bytes", len(data)).Msg("dropped client message: malformed JSON")
		return
	}
	switch typed.Type {
	case "presence":
		// Always identify presence by the server-generated clientID. The
		// client cannot overwrite another peer's state by sending a
		// custom client_id in the frame (5th-pass review, 2026-05).
		// Routed to the sender's generation so a stale peer never sees it
		// (round 39 batch-2 F2).
		hub.PresenceUpdate(queryID, clientID, typed.State, gen)
	case "broadcast":
		envelope, _ := json.Marshal(map[string]any{
			"type":    "broadcast",
			"from":    clientID,
			"payload": typed.Payload,
		})
		hub.BroadcastGen(queryID, string(envelope), gen)
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
// in the pgr.persisted_subscriptions catalog for the given query_id and the id
// does not match the ad-hoc public-channel prefix convention.
var ErrSubscriptionNotFound = errors.New("subscription not found")

// channelPrefixes lists query_id prefixes that are treated as ad-hoc public
// broadcast / presence channels — they don't need a pre-registered row in
// the pgr.persisted_subscriptions catalog. Use audience binding
// (server-registered) for any channel that should be private.
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
// The source is the transactional pgr.subscription_meta (round 37 F1), so an
// uncommitted or rolled-back re-subscribe in another session never leaks into
// the gate.
//
// Failure modes (since the 2026-05 audit closed the previous fail-open
// vector — silently returning ("delta", "") on any DB error meant an
// audience-bound subscription could become unprotected if the proxy's
// EXECUTE grant on the lookup function was revoked or the DB blipped):
//
//   - pgx.ErrNoRows + query_id matches an ad-hoc channel prefix
//     → mode="delta", audience="", err=nil. Public ad-hoc channel.
//   - pgx.ErrNoRows otherwise → err = ErrSubscriptionNotFound.
//     Caller responds 404; we DO NOT silently treat as public.
//   - Any other error (permission denied, connection failure, timeout)
//     → err surfaced as-is. Caller responds 503; we DO NOT silently
//     treat as public.
func subscriptionMeta(pool *pgxpool.Pool, queryID string) (mode, audience string, generation int64, err error) {
	if pool == nil {
		// Nil pool only happens in tests. Treat like "not found" so the
		// ad-hoc channel prefix bypass still works in test harnesses
		// that don't spin up Postgres; production code never gets here.
		if isAdHocChannel(queryID) {
			return "delta", "", 0, nil
		}
		return "", "", 0, ErrSubscriptionNotFound
	}
	var aud *string
	// Round 37 F1: read the audience/mode/generation gate from the TRANSACTIONAL
	// catalog (pgr.subscription_meta over pgr.persisted_subscriptions), NOT from
	// pgr.get_subscriptions() which reads the non-transactional shmem hash. The
	// generation binds the connection so a later re-registration revokes it
	// (round 39 batch-2). The catalog read sees only committed rows.
	err = pool.QueryRow(context.Background(),
		`SELECT mode, audience::text, generation FROM pgr.subscription_meta($1)`,
		queryID).Scan(&mode, &aud, &generation)
	if err == nil {
		if aud != nil {
			audience = *aud
		}
		return mode, audience, generation, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		if isAdHocChannel(queryID) {
			return "delta", "", 0, nil
		}
		return "", "", 0, ErrSubscriptionNotFound
	}
	// Permission denied, connection failure, etc — surface to caller so it
	// returns 503 instead of accepting the WS upgrade unprotected.
	log.Warn().Str("query_id", queryID).Err(err).
		Msg("subscription metadata lookup failed; rejecting WS to fail closed")
	return "", "", 0, fmt.Errorf("subscription metadata lookup: %w", err)
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
//     This is the public signal — a SQL NULL audience, rendered as "" by the
//     gate. It is the ONLY way to be public.
//   - A non-NULL audience that carries no predicates (jsonb 'null' or '{}', or
//     any value that unmarshals to an empty object) fails closed: the
//     registrant signalled intent to restrict but gave nothing to check, so we
//     refuse rather than admit every authenticated JWT (round 37 F5).
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
	// Non-NULL but predicate-less audience (jsonb 'null' -> nil map, '{}' ->
	// empty map): the loop below would be vacuously satisfied and admit any
	// JWT. That defeats the intent of setting an audience at all. Public
	// subscriptions use a SQL NULL audience (handled above as ""); a non-NULL
	// audience with zero keys is a misconfiguration and must fail closed.
	if len(aud) == 0 {
		log.Warn().Str("audience", audience).
			Msg("audience has no predicates; failing closed (use a NULL audience for public)")
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

// snapshotForGeneration reads the current generation AND the snapshot rows for
// queryID in ONE read-only transaction, so the audience the connection
// authorized against and the rows it receives belong to the same generation —
// closing the snapshot TOCTOU (round 39 batch-2 F3). It returns the rows only
// if the subscription's current generation still equals boundGen; otherwise
// ok=false (a re-registration landed during connect, so the connection must
// close). A no-row / transient error returns a non-nil err so the caller fails
// closed.
func snapshotForGeneration(pool *pgxpool.Pool, queryID string, boundGen int64) (rows []json.RawMessage, ok bool, err error) {
	if pool == nil || !safeQueryIDRe.MatchString(queryID) {
		return nil, false, nil
	}
	ctx := context.Background()
	// RepeatableRead so the generation check and the row read observe ONE MVCC
	// snapshot. Under READ COMMITTED (the default) each statement takes a fresh
	// snapshot, so a re-subscribe committing between the two would let the gen
	// check pass on the OLD generation while the rows are read from the NEW one
	// (round 39 batch-2 snapshot TOCTOU, HIGH).
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)

	// Take ACCESS SHARE on the snapshot table up front. A re-subscribe rebuilds
	// it under ACCESS EXCLUSIVE in the SAME transaction that bumps the
	// generation (pgr.subscribe → pgr_snapshot_drop), so holding this lock blocks
	// that re-subscribe from committing until we have read BOTH the generation
	// and the rows — the gen check can never pass on an epoch whose rows are
	// about to be swapped out. If the re-subscribe already committed, this lock
	// resolves to the rebuilt table and the gen check below then sees the new
	// generation and closes. If the table is gone (unsubscribed / mid-rebuild)
	// the LOCK errors and we fail closed. query_id validated by safeQueryIDRe.
	if _, err = tx.Exec(ctx, `LOCK TABLE pgr."_snap_`+queryID+`" IN ACCESS SHARE MODE`); err != nil {
		return nil, false, err
	}

	var curGen int64
	if err = tx.QueryRow(ctx, `SELECT generation FROM pgr.subscription_meta($1)`, queryID).Scan(&curGen); err != nil {
		return nil, false, err // no row (unsubscribed mid-connect) or transient → fail closed
	}
	if curGen != boundGen {
		return nil, false, nil // re-registered during connect → close, do not ship rows
	}

	// query_id already validated by safeQueryIDRe above.
	r, err := tx.Query(ctx, `SELECT row_to_json(t) AS doc FROM pgr."_snap_`+queryID+`" t`)
	if err != nil {
		return nil, false, err
	}
	defer r.Close()
	for r.Next() {
		var raw json.RawMessage
		if err := r.Scan(&raw); err != nil {
			continue
		}
		rows = append(rows, raw)
	}
	return rows, true, r.Err()
}

// generationMatches reports whether the subscription's current generation still
// equals boundGen. The notify-mode path ships no snapshot, so it cannot use
// snapshotForGeneration to detect a re-registration that landed AFTER the
// RevokeStale sweep had already passed this connection by (register-after-sweep
// race). It calls this instead and closes on mismatch — giving notify-mode the
// same generation guard the delta path gets atomically with its snapshot
// (round 39 batch-2 F1/F2, notify path). A missing row (unsubscribed mid-
// connect) or transient error fails closed.
func generationMatches(pool *pgxpool.Pool, queryID string, boundGen int64) (bool, error) {
	if pool == nil {
		return true, nil // test harness without PG; ad-hoc/test path
	}
	var curGen int64
	err := pool.QueryRow(context.Background(),
		`SELECT generation FROM pgr.subscription_meta($1)`, queryID).Scan(&curGen)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil // unsubscribed mid-connect → close
		}
		return false, err // transient → fail closed
	}
	return curGen == boundGen, nil
}

// generateClientID returns 16 random bytes hex-encoded as a unique client identifier.
func generateClientID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// PresenceHandler returns the current presence list for a channel.
// GET /ws/_presence/{channel}
//
// Runs the SAME auth + audience gate as WSHandler. Before the 6th-pass
// audit this endpoint was an unauthenticated side channel: an attacker
// who knew (or guessed) a private channel name could read its presence
// state via HTTP, bypassing the WebSocket-side audience enforcement.
//
//   - cfg.JWTSecret == ""  → auth disabled, accept (mirrors dev WS path)
//   - anon-key + REQUIRE_AUTHENTICATED_WS → 401
//   - JWT path → ResolveClaims; required when not anon
//   - subscriptionMeta is then consulted: an audience-bound entry
//     refuses anon and any JWT whose claims don't satisfy the predicate
//   - service_role always bypasses
func PresenceHandler(cfg middleware.RLSConfig, pool *pgxpool.Pool, hub *Hub, requireAuthenticated bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channel := chi.URLParam(r, "channel")
		if channel == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"channel is required"}`))
			return
		}

		// Auth — same shape as WSHandler so the HTTP and WS surfaces
		// stay in lockstep. claims is populated for both anon and JWT
		// paths so the audience matcher below has something to test.
		var claims middleware.RequestClaims
		var isAnon bool
		if cfg.JWTSecret != "" {
			authHeader := r.Header.Get("Authorization")
			apikeyParam := r.URL.Query().Get("apikey")
			if cfg.AnonKey != "" {
				if middleware.ConstantTimeEqExported(authHeader, "Bearer "+cfg.AnonKey) ||
					middleware.ConstantTimeEqExported(apikeyParam, cfg.AnonKey) {
					isAnon = true
				}
			}
			if isAnon && requireAuthenticated {
				writeJSONStatus(w, http.StatusUnauthorized, "authenticated presence read required")
				return
			}
			if isAnon {
				claims = middleware.RequestClaims{Role: "anon"}
			} else {
				var token string
				if len(authHeader) > 7 && authHeader[:7] == "Bearer " {
					token = authHeader[7:]
				}
				if token == "" {
					token = r.URL.Query().Get("token")
				}
				if token == "" {
					writeJSONStatus(w, http.StatusUnauthorized, "authentication required")
					return
				}
				r.Header.Set("Authorization", "Bearer "+token)
				resolved, err := middleware.ResolveClaims(r, cfg)
				if err != nil || resolved.Role == "" {
					writeJSONStatus(w, http.StatusUnauthorized, "authentication required")
					return
				}
				claims = resolved
			}
		}

		// Audience gate — identical policy to WSHandler. Closes the
		// "presence map is readable by knowing the channel name" hole.
		_, audience, currentGen, metaErr := subscriptionMeta(pool, channel)
		if metaErr != nil {
			if errors.Is(metaErr, ErrSubscriptionNotFound) {
				writeJSONStatus(w, http.StatusNotFound, "channel not found")
			} else {
				writeJSONStatus(w, http.StatusServiceUnavailable, "channel metadata unavailable")
			}
			return
		}
		if status, msg := gatePresenceAccess(audience, isAnon, claims); status != 0 {
			writeJSONStatus(w, status, msg)
			return
		}

		// Restrict to the current committed generation: a reader authorized for
		// this epoch must not see presence written by a connection of another
		// epoch (round 39 batch-2 gen-ordering audit).
		presenceMap := hub.PresenceList(channel, currentGen)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(presenceMap)
	}
}

// writeJSONStatus is a small helper used by the presence HTTP handler.
func writeJSONStatus(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"error":"` + msg + `"}`))
}

// gatePresenceAccess is the pure decision function shared by PresenceHandler
// and (potentially) future presence endpoints. Returns (0, "") to allow,
// or (status, msg) to refuse. Extracted so the policy matrix is unit-
// testable without spinning up a real DB or HTTP server.
//
//	audience == ""        → public; allow whether anon or authed.
//	claims.Role == "service_role" → always allow (admin bypass).
//	audience non-empty + isAnon → 403 (anon never satisfies an audience).
//	audience non-empty + JWT match → allow.
//	audience non-empty + JWT mismatch → 403.
func gatePresenceAccess(audience string, isAnon bool, claims middleware.RequestClaims) (int, string) {
	if audience == "" {
		return 0, ""
	}
	if claims.Role == "service_role" {
		return 0, ""
	}
	if isAnon {
		return http.StatusForbidden, "channel requires an authenticated JWT"
	}
	if !claimsSatisfyAudience(audience, claims.ClaimsJSON) {
		return http.StatusForbidden, "JWT claims do not satisfy channel audience"
	}
	return 0, ""
}

// writeWSError writes a plain HTTP error before WebSocket upgrade. Once the
// connection is upgraded this is no longer possible.
func writeWSError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body, _ := json.Marshal(map[string]string{"error": msg})
	_, _ = w.Write(body)
}
