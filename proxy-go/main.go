package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"golang.org/x/crypto/acme/autocert"

	"pgstack-proxy-go/auth"
	"pgstack-proxy-go/functions"
	appMiddleware "pgstack-proxy-go/middleware"
	"pgstack-proxy-go/realtime"
	"pgstack-proxy-go/rest"
	"pgstack-proxy-go/routes"
	"pgstack-proxy-go/secrets"
)

func main() {
	// Structured JSON logging via zerolog.
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	if os.Getenv("LOG_PRETTY") == "1" {
		log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr})
	}
	if lvl := os.Getenv("LOG_LEVEL"); lvl != "" {
		if parsed, err := zerolog.ParseLevel(strings.ToLower(lvl)); err == nil {
			zerolog.SetGlobalLevel(parsed)
		} else {
			log.Warn().Str("LOG_LEVEL", lvl).Msg("invalid LOG_LEVEL — expected trace/debug/info/warn/error/fatal/panic; using default")
		}
	}

	cfg := FromEnv()

	if errs := cfg.Validate(); len(errs) > 0 {
		for _, e := range errs {
			log.Error().Msg(e)
		}
		log.Fatal().Msg("configuration errors — fix the above before starting")
	}

	if cfg.JWTSecret != "" {
		log.Info().Msg("JWT authentication enabled")
	} else {
		log.Warn().Msg("JWT_SECRET not set — authentication disabled")
	}
	if cfg.EnableSQLEndpoint {
		log.Warn().Msg("ENABLE_SQL_ENDPOINT=true — /api/sql endpoint mounted (still requires service_role; never enable on a public host without strict network/auth controls)")
	}
	if cfg.RequireAuthenticatedWS {
		log.Info().Msg("REQUIRE_AUTHENTICATED_WS=true — anon-key WS subscriptions rejected; JWT required")
	} else if cfg.JWTSecret != "" && cfg.AnonKey != "" {
		log.Warn().Msg("REQUIRE_AUTHENTICATED_WS=false — anon key can open live-query WS for any query_id; set true to require JWT")
	}
	switch {
	case len(cfg.AllowedOrigins) > 0:
		log.Info().Strs("origins", cfg.AllowedOrigins).Msg("CORS / WS origin: restricted")
	case cfg.AllowPermissiveCORS:
		log.Warn().Msg("ALLOW_PERMISSIVE_CORS=true with empty ALLOWED_ORIGINS — any origin can connect (DEV ONLY; set ALLOWED_ORIGINS in production)")
	default:
		log.Info().Msg("ALLOWED_ORIGINS empty and ALLOW_PERMISSIVE_CORS=false — CORS strict (same-origin only); set one of them to allow cross-origin clients")
	}

	// Build PG connection pool.
	pool, err := buildPool(cfg.DatabaseURL, cfg.PGPoolMaxConns, cfg.PGPoolMinConns, cfg.PGPoolMaxConnIdleTime)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to connect to PostgreSQL")
	}
	defer pool.Close()
	log.Info().Msg("PG connection pool ready (data plane — RLS-bound)")

	// Admin pool: same DSN, but every connection assumes service_role. Trusted
	// backend operations that do not SET ROLE themselves (auth, catalog
	// introspection, SQL endpoint, edge-fn catalog, realtime gate) run on this
	// pool instead of relying on a superuser connection (gemini audit P2).
	// The admin pool prefers ADMIN_DATABASE_URL (the authenticator_admin login
	// role, member of service_role). When unset it falls back to DATABASE_URL —
	// the legacy single-role model, where authenticator itself is a member of
	// service_role. Splitting the two login roles (finding 6) means a data-plane
	// compromise (data pool = authenticator, NOT a member of service_role) cannot
	// SET ROLE service_role even after RESET ROLE.
	adminDSN := cfg.AdminDatabaseURL
	if adminDSN == "" {
		adminDSN = cfg.DatabaseURL
	}
	adminPool, err := buildPoolAs("service_role", adminDSN, cfg.PGPoolMaxConns, cfg.PGPoolMinConns, cfg.PGPoolMaxConnIdleTime)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to build admin (service_role) pool")
	}
	defer adminPool.Close()
	log.Info().Msg("PG admin pool ready (service_role)")

	// Initialize secret box from SECRETS_ENCRYPTION_KEY env. Nil when unset —
	// features that need encryption (edge function env vars, webhook signing
	// secrets) degrade fail-closed at use-time rather than refusing to boot.
	secretBox, err := secrets.New(cfg.SecretsEncryptionKey)
	if err != nil {
		log.Fatal().Err(err).Msg("SECRETS_ENCRYPTION_KEY invalid")
	}
	if secretBox == nil {
		log.Info().Msg("SECRETS_ENCRYPTION_KEY unset — edge function env vars and webhook signing secrets cannot be decrypted; CreateWebhook will refuse non-empty secrets and Refresh will drop encrypted-secret webhooks")
	} else {
		log.Info().Msg("SECRETS_ENCRYPTION_KEY loaded — at-rest secret encryption enabled (edge function env vars, webhook signing secrets)")
	}

	state := NewAppState(cfg, pool, adminPool, secretBox)

	// Verify the finding-6 two-login-role split before serving traffic: the data
	// pool must NOT be able to reach service_role, and the admin pool MUST be
	// able to assume it. A broken split (e.g. the cutover REVOKE was skipped, or
	// ADMIN_DATABASE_URL is missing/wrong) is fatal in production rather than
	// silently booting an insecure or non-functional admin plane (gemini audit
	// R4-1 / R4-2).
	verifyPoolRoles(context.Background(), cfg.PgstackEnv == "production", pool, adminPool)

	// Start rate limiter cleanup goroutine (H5: prevent unbounded memory growth).
	cleanupCtx, cleanupCancel := context.WithCancel(context.Background())
	defer cleanupCancel()
	go state.RateLimiter.StartCleanup(cleanupCtx)
	go state.AnonymousLimiter.StartCleanup(cleanupCtx)

	// Start expired-token reaper for pgstack.email_tokens and
	// pgstack.refresh_tokens (L3: stale rows would accumulate forever).
	go auth.StartExpiredTokenCleanup(cleanupCtx, state.AdminPool)

	// Admin-pool health prober (gemini audit R4-2): keep state.AdminConnected
	// fresh so /health degrades if the admin pool stops being able to assume
	// service_role at runtime (e.g. the admin role's password is rotated).
	state.AdminConnected.Store(true)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-cleanupCtx.Done():
				return
			case <-ticker.C:
			}
			pctx, pcancel := context.WithTimeout(context.Background(), 5*time.Second)
			var role string
			err := state.AdminPool.QueryRow(pctx, "SELECT current_user").Scan(&role)
			pcancel()
			state.AdminConnected.Store(err == nil && role == "service_role")
		}
	}()

	// One-shot orphan sweep for disk-backend storage (audit F1 round 19):
	// removes .pgstack-upload-* / .pgstack-backup-* files left behind by
	// uploads killed mid-flight. Runs only when STORAGE_BACKEND=disk.
	// minAge=10m keeps a generous safety margin so a slow in-flight
	// upload is never mistaken for an orphan.
	if cfg.StorageBackend == "disk" && cfg.StorageDir != "" {
		go routes.SweepDiskOrphans(cfg.StorageDir, 10*time.Minute)
	}

	// Load webhooks from DB before starting listener.
	if err := state.WebhookManager.Refresh(context.Background()); err != nil {
		log.Warn().Err(err).Msg("initial webhook load failed — webhooks will retry on next refresh")
	}

	// Kick off the dedicated PG LISTEN connection in a background goroutine.
	go realtime.ListenLoop(
		cfg.DatabaseURL,
		state.Hub,
		&state.PGConnected,
		cfg.PGReconnectMaxBackoff,
		state.WebhookManager,
		cfg.NotifyChannel,
	)

	// Build and start the HTTP server.
	r := buildRouter(state)

	// Graceful shutdown on SIGINT / SIGTERM.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	var servers []*http.Server

	switch cfg.TLSMode {
	case "auto":
		servers = startAutoTLS(cfg, r)
	case "manual":
		servers = startManualTLS(cfg, r)
	default: // "off"
		servers = startPlainHTTP(cfg, r)
	}

	<-quit
	log.Info().Msg("shutdown signal received")

	ctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()

	for _, srv := range servers {
		if err := srv.Shutdown(ctx); err != nil {
			log.Error().Err(err).Msg("graceful shutdown failed")
		}
	}
	log.Info().Msg("shutdown complete")
}

// startPlainHTTP starts a single HTTP server (TLS_MODE=off).
func startPlainHTTP(cfg Config, handler http.Handler) []*http.Server {
	srv := &http.Server{
		Addr:         cfg.ListenAddr,
		Handler:      handler,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		IdleTimeout:  cfg.IdleTimeout,
	}
	go func() {
		log.Info().
			Str("addr", cfg.ListenAddr).
			Msg("pgstack listening (HTTP)")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server error")
		}
	}()
	return []*http.Server{srv}
}

// startAutoTLS starts HTTPS with automatic Let's Encrypt certificates (TLS_MODE=auto).
// Also starts an HTTP server on port 80 for ACME HTTP-01 challenges and HTTP→HTTPS redirect.
func startAutoTLS(cfg Config, handler http.Handler) []*http.Server {
	m := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(cfg.TLSDomains...),
		Cache:      autocert.DirCache(cfg.TLSCertDir),
	}
	if cfg.TLSACMEEmail != "" {
		m.Email = cfg.TLSACMEEmail
	}

	// HTTPS server
	tlsCfg := m.TLSConfig()
	tlsCfg.MinVersion = tls.VersionTLS12
	tlsSrv := &http.Server{
		Addr:         cfg.HTTPSAddr,
		Handler:      handler,
		TLSConfig:    tlsCfg,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		IdleTimeout:  cfg.IdleTimeout,
	}
	go func() {
		log.Info().
			Str("addr", cfg.HTTPSAddr).
			Str("domains", strings.Join(cfg.TLSDomains, ", ")).
			Msg("pgstack listening (HTTPS auto-TLS)")
		if err := tlsSrv.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("HTTPS server error")
		}
	}()

	// HTTP server for ACME challenges + redirect to HTTPS
	httpSrv := &http.Server{
		Addr:         cfg.HTTPAddr,
		Handler:      m.HTTPHandler(httpToHTTPSRedirect()),
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		IdleTimeout:  cfg.IdleTimeout,
	}
	go func() {
		log.Info().
			Str("addr", cfg.HTTPAddr).
			Msg("pgstack listening (HTTP → HTTPS redirect + ACME)")
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("HTTP redirect server error")
		}
	}()

	return []*http.Server{tlsSrv, httpSrv}
}

// startManualTLS starts HTTPS with user-provided certificate files (TLS_MODE=manual).
func startManualTLS(cfg Config, handler http.Handler) []*http.Server {
	cert, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to load TLS certificate")
	}

	tlsSrv := &http.Server{
		Addr:    cfg.HTTPSAddr,
		Handler: handler,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		},
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		IdleTimeout:  cfg.IdleTimeout,
	}
	go func() {
		log.Info().
			Str("addr", cfg.HTTPSAddr).
			Str("cert", cfg.TLSCertFile).
			Msg("pgstack listening (HTTPS manual TLS)")
		if err := tlsSrv.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("HTTPS server error")
		}
	}()

	return []*http.Server{tlsSrv}
}

// httpToHTTPSRedirect returns a handler that 301-redirects all HTTP requests to HTTPS.
func httpToHTTPSRedirect() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := "https://" + r.Host + r.URL.RequestURI()
		http.Redirect(w, r, target, http.StatusMovedPermanently)
	})
}

// buildPool creates a pgxpool.Pool for the RLS-bound data plane.
func buildPool(dbURL string, maxConns, minConns int32, maxIdleTime time.Duration) (*pgxpool.Pool, error) {
	return buildPoolAs("", dbURL, maxConns, minConns, maxIdleTime)
}

// buildPoolAs creates a pool that, when assumeRole is non-empty, runs
// `SET ROLE <assumeRole>` on every new connection — so the whole pool operates
// as that role for its lifetime. This is how the proxy connects as the powerless
// `authenticator` role yet still performs trusted backend work: the admin pool
// assumes service_role at connect time (gemini audit P2). assumeRole is a fixed
// internal constant, but it is identifier-quoted regardless.
func buildPoolAs(assumeRole, dbURL string, maxConns, minConns int32, maxIdleTime time.Duration) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	poolCfg.MaxConns = maxConns
	poolCfg.MinConns = minConns
	poolCfg.MaxConnIdleTime = maxIdleTime
	if assumeRole != "" {
		setRole := "SET ROLE " + pgx.Identifier{assumeRole}.Sanitize()
		poolCfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
			_, err := c.Exec(ctx, setRole)
			return err
		}
	}
	return pgxpool.NewWithConfig(context.Background(), poolCfg)
}

// verifyPoolRoles checks the finding-6 two-login-role split at startup. The data
// pool's login role must NOT be a member of service_role (so a data-plane
// compromise cannot RESET ROLE + SET ROLE service_role), and the admin pool must
// successfully assume service_role (its AfterConnect SET ROLE works). A violation
// is fatal in production; otherwise it is a warning. This is a runtime check, so
// it catches an incomplete cutover (REVOKE skipped) and a missing/wrong
// ADMIN_DATABASE_URL even when the config-level validator passed.
func verifyPoolRoles(ctx context.Context, production bool, dataPool, adminPool *pgxpool.Pool) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	report := func(msg string) {
		if production {
			log.Fatal().Msg(msg) // exits the process
		}
		log.Warn().Msg(msg + " (PGSTACK_ENV != production — warning only; FATAL in production)")
	}

	// checkLoginRole verifies a pool's session_user (the LOGIN role) is safe to
	// connect as: it carries NONE of the dangerous role attributes, and it is a
	// (transitive) member of ONLY the roles in `allowed`. Each gap below is a real
	// bypass of the "powerless until SET ROLE" model:
	//   - SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB: a RESET ROLE hands back full
	//     privileges even if the membership/effective-role checks pass (R5-1).
	//   - INHERIT: the role holds its members' privileges with NO SET ROLE at all
	//     (a data role that INHERITs `authenticated` reads RLS tables directly).
	//   - REPLICATION: can stream out the whole database via replication.
	//   - membership in a dangerous predefined role (pg_execute_server_program →
	//     COPY ... TO PROGRAM, pg_read_all_data → RLS bypass) or in service_role on
	//     the data plane is an escalation path the attribute checks miss (R6-1).
	checkLoginRole := func(pool *pgxpool.Pool, label string, allowed []string) {
		allowedSet := make(map[string]bool, len(allowed))
		for _, a := range allowed {
			allowedSet[a] = true
		}

		var su string
		var super, bypassrls, createrole, createdb, inherit, replication bool
		if err := pool.QueryRow(ctx,
			"SELECT session_user, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolreplication FROM pg_roles WHERE rolname = session_user").
			Scan(&su, &super, &bypassrls, &createrole, &createdb, &inherit, &replication); err != nil {
			report(label + ": cannot read login-role attributes at startup: " + err.Error())
			return
		}
		var bad []string
		for _, a := range []struct {
			on   bool
			name string
		}{
			{super, "SUPERUSER"}, {bypassrls, "BYPASSRLS"}, {createrole, "CREATEROLE"},
			{createdb, "CREATEDB"}, {inherit, "INHERIT"}, {replication, "REPLICATION"},
		} {
			if a.on {
				bad = append(bad, a.name)
			}
		}
		if len(bad) > 0 {
			report(fmt.Sprintf("%s login role %q has dangerous attribute(s) [%s] — proxy login roles must be NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION so privileges are never held or inherited without an explicit SET ROLE", label, su, strings.Join(bad, ",")))
		}

		// Transitive membership allowlist.
		rows, err := pool.Query(ctx,
			"SELECT r.rolname FROM pg_roles r WHERE r.rolname <> session_user AND pg_has_role(session_user, r.oid, 'MEMBER')")
		if err != nil {
			report(label + ": cannot read role memberships at startup: " + err.Error())
			return
		}
		var unexpected []string
		actual := map[string]bool{}
		for rows.Next() {
			var m string
			if err := rows.Scan(&m); err != nil {
				report(label + ": error scanning role membership row: " + err.Error())
				return
			}
			actual[m] = true
			if !allowedSet[m] {
				unexpected = append(unexpected, m)
			}
		}
		rows.Close()
		if rerr := rows.Err(); rerr != nil {
			report(label + ": error reading role memberships: " + rerr.Error())
			return
		}
		if len(unexpected) > 0 {
			report(fmt.Sprintf("%s login role %q is a member of unexpected role(s) [%s] — it must belong only to [%s]; a membership in e.g. service_role, pg_execute_server_program, or pg_read_all_data is an escalation path", label, su, strings.Join(unexpected, ","), strings.Join(allowed, ",")))
		}

		// Required memberships PRESENT. The allowlist above bounds the membership set
		// from above (no extras); this bounds it from below (no gaps). The proxy SET
		// ROLEs into every allowed role, so it must actually be a member of each that
		// EXISTS — a missing one is not an escalation but a "healthy" startup that
		// breaks at runtime (the data role cannot SET ROLE authenticated, so those
		// requests 500) (gemini audit R11-2).
		var missing, absent []string
		for _, target := range allowed {
			var texists bool
			if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1)", target).Scan(&texists); err != nil {
				report(label + ": cannot check required membership " + target + " at startup: " + err.Error())
				return
			}
			if !texists {
				absent = append(absent, target)
			} else if !actual[target] {
				missing = append(missing, target)
			}
		}
		if len(absent) > 0 {
			report(fmt.Sprintf("%s required SET ROLE target role(s) do not exist [%s] — the pgStack core roles (anon/authenticated/service_role) must be bootstrapped before the proxy connects; for standalone pg_reactive WITHOUT pgStack run with PGSTACK_ENV=development (absent roles are fatal only in production) (gemini audit R12-2)", label, strings.Join(absent, ",")))
		}
		if len(missing) > 0 {
			report(fmt.Sprintf("%s login role %q is NOT a member of required role(s) [%s] — it must be a member of every role it SET ROLEs into ([%s]); without it those requests fail at runtime though startup looked healthy (gemini audit R11-2)", label, su, strings.Join(missing, ","), strings.Join(allowed, ",")))
		}

		// No direct privileges: the login role must own no objects and hold no
		// direct ACL grants. NOINHERIT drops privileges inherited via membership,
		// but a DIRECT grant (GRANT SELECT ON pgstack.users TO <role>) or object
		// ownership applies whenever the role is current — including after a
		// RESET ROLE — so a "powerless" login role must have none (gemini audit
		// R7-1). pg_shdepend records a role's ownership ('o') and ACL ('a')
		// dependencies across all databases; pg_roles (not pg_authid) is used to
		// resolve the OID so the query works as a non-superuser.
		var directDeps int
		if err := pool.QueryRow(ctx,
			"SELECT count(*) FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = session_user) AND deptype IN ('o','a')").
			Scan(&directDeps); err != nil {
			report(label + ": cannot check direct privileges/ownership at startup: " + err.Error())
			return
		}
		if directDeps > 0 {
			report(fmt.Sprintf("%s login role %q owns objects or holds direct ACL grants (%d object dependency/ies) — a proxy login role must be powerless so a RESET ROLE grants nothing (gemini audit R7-1); REVOKE its grants and reassign any owned objects", label, su, directDeps))
		}

		// Membership EDGE options. The allowlist above bounds WHICH roles are
		// reachable; pg_auth_members also carries per-grant options that bound HOW
		// each membership behaves, and those are NOT covered by the role attributes
		// or the allowlist (gemini audit R8):
		//   - inherit_option=true (PG16 per-membership, overrides the role's
		//     rolinherit): the login role holds its member's privileges with NO
		//     SET ROLE — a NOINHERIT data role that is granted `authenticated WITH
		//     INHERIT TRUE` reads RLS tables ambiently, defeating the whole
		//     "powerless until SET ROLE" model (R8-1);
		//   - admin_option=true: the login role can GRANT the membership to other
		//     roles without holding CREATEROLE — a delegation/persistence path,
		//     and on the admin plane it can hand out service_role (R8-2);
		//   - set_option=false: the proxy can never assume the role via SET LOCAL
		//     ROLE, so per-request RLS is broken — fail closed at boot.
		// Healthy bootstrap grants are plain (admin=f, inherit=f, set=t). The
		// inherit_option/set_option columns are PG16+; on older servers rolinherit
		// (checked above) governs inheritance and SET ROLE is always permitted, so
		// only admin_option is read.
		var verNum int
		if err := pool.QueryRow(ctx, "SELECT current_setting('server_version_num')::int").Scan(&verNum); err != nil {
			report(label + ": cannot read server version at startup: " + err.Error())
			return
		}
		edgeSQL := "SELECT r.rolname, m.admin_option, false, true FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = session_user)"
		if verNum >= 160000 {
			edgeSQL = "SELECT r.rolname, m.admin_option, m.inherit_option, m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = session_user)"
		}
		erows, err := pool.Query(ctx, edgeSQL)
		if err != nil {
			report(label + ": cannot read membership edge options at startup: " + err.Error())
			return
		}
		var unsafeEdges []string
		for erows.Next() {
			var roleName string
			var adminOpt, inheritOpt, setOpt bool
			if err := erows.Scan(&roleName, &adminOpt, &inheritOpt, &setOpt); err != nil {
				report(label + ": error scanning membership edge row: " + err.Error())
				return
			}
			var flags []string
			if adminOpt {
				flags = append(flags, "ADMIN OPTION")
			}
			if inheritOpt {
				flags = append(flags, "INHERIT TRUE")
			}
			if !setOpt {
				flags = append(flags, "SET FALSE")
			}
			if len(flags) > 0 {
				unsafeEdges = append(unsafeEdges, fmt.Sprintf("%s: %s", roleName, strings.Join(flags, "+")))
			}
		}
		erows.Close()
		if rerr := erows.Err(); rerr != nil {
			report(label + ": error reading membership edge options: " + rerr.Error())
			return
		}
		if len(unsafeEdges) > 0 {
			report(fmt.Sprintf("%s login role %q has membership grant(s) with unsafe options [%s] — every grant to a proxy login role must be plain so privileges need an explicit SET ROLE (NO INHERIT, even per-membership on PG16), cannot be re-delegated (NO ADMIN OPTION), and can actually be assumed (WITH SET); re-issue as plain GRANT (gemini audit R8-1/R8-2)", label, su, strings.Join(unsafeEdges, "; ")))
		}

		// Reachable roles must be TERMINAL. The edge-option check above only
		// inspects session_user's DIRECT edges. A direct edge can be safe (e.g.
		// authenticator -> anon, f/f/t) while a reachable role carries its OWN
		// unsafe outgoing edge: `anon` granted `authenticated WITH INHERIT TRUE`
		// means a request that SET ROLEs anon ambiently gains authenticated's
		// privileges — a transitive bypass the direct check never sees (gemini
		// audit R9-1). The transitive allowlist already confines the reachable
		// set to anon/authenticated (data) / service_role (admin); those base
		// privilege roles MUST be members of nothing, so the graph below
		// session_user is flat and no transitive edge can exist. Requiring them
		// terminal closes the whole class without per-edge option logic.
		trows, err := pool.Query(ctx,
			"SELECT r.rolname FROM pg_roles r WHERE r.rolname <> session_user AND pg_has_role(session_user, r.oid, 'MEMBER') AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)")
		if err != nil {
			report(label + ": cannot check transitive role memberships at startup: " + err.Error())
			return
		}
		var nonTerminal []string
		for trows.Next() {
			var m string
			if err := trows.Scan(&m); err != nil {
				report(label + ": error scanning reachable-role row: " + err.Error())
				return
			}
			nonTerminal = append(nonTerminal, m)
		}
		trows.Close()
		if rerr := trows.Err(); rerr != nil {
			report(label + ": error checking transitive memberships: " + rerr.Error())
			return
		}
		if len(nonTerminal) > 0 {
			report(fmt.Sprintf("%s login role %q can reach role(s) [%s] that are themselves members of other roles — anon/authenticated/service_role must be TERMINAL (members of nothing) so a SET ROLE cannot pick up ambient privileges or delegation through a transitive edge the direct-edge check does not see (gemini audit R9-1)", label, su, strings.Join(nonTerminal, ",")))
		}

		// Target-role profile. The proxy SET ROLEs INTO the allowlisted roles per
		// request, so THEIR attributes and ownership are part of the trust boundary,
		// not just the login role's (gemini audit R10). anon/authenticated are
		// RLS-SUBJECT roles: NOSUPERUSER, NOBYPASSRLS (a BYPASSRLS authenticated
		// reads deny-all tables), NOLOGIN (no password foothold), and they must OWN
		// nothing — a table's owner bypasses its RLS unless FORCE ROW LEVEL SECURITY.
		// service_role is the trusted backend role, BYPASSRLS BY DESIGN (invariant
		// 22) but still NOSUPERUSER / NOLOGIN. None may hold CREATEROLE/CREATEDB/
		// REPLICATION. Absent target roles (standalone pg_reactive, no pgStack core)
		// are skipped.
		var targetBad []string
		for _, target := range allowed {
			var texists bool
			if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1)", target).Scan(&texists); err != nil {
				report(label + ": cannot check target role " + target + " at startup: " + err.Error())
				return
			}
			if !texists {
				continue
			}
			var tsuper, tbypass, tcrole, tcdb, trepl, tlogin bool
			if err := pool.QueryRow(ctx,
				"SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = $1", target).
				Scan(&tsuper, &tbypass, &tcrole, &tcdb, &trepl, &tlogin); err != nil {
				report(label + ": cannot read target role attributes for " + target + ": " + err.Error())
				return
			}
			bypassOK := target == "service_role"
			for _, a := range []struct {
				on   bool
				name string
			}{
				{tsuper, "SUPERUSER"}, {tbypass && !bypassOK, "BYPASSRLS"}, {bypassOK && !tbypass, "NOBYPASSRLS"},
				{tcrole, "CREATEROLE"}, {tcdb, "CREATEDB"}, {trepl, "REPLICATION"}, {tlogin, "LOGIN"},
			} {
				if a.on {
					targetBad = append(targetBad, target+":"+a.name)
				}
			}
			if !bypassOK { // RLS-subject role must own nothing (an owner bypasses RLS)
				var owned int
				// Fail CLOSED on a query error: a transient failure must not let the
				// proxy boot assuming the role owns nothing (gemini audit R11-1).
				if err := pool.QueryRow(ctx,
					"SELECT count(*) FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = $1) AND deptype = 'o'", target).
					Scan(&owned); err != nil {
					report(label + ": cannot check target role ownership for " + target + ": " + err.Error())
					return
				} else if owned > 0 {
					targetBad = append(targetBad, fmt.Sprintf("%s:owns %d object(s)", target, owned))
				}
			}
		}
		if len(targetBad) > 0 {
			report(fmt.Sprintf("%s SET ROLE target role(s) have an unexpected privilege profile [%s] — anon/authenticated must be NOSUPERUSER NOBYPASSRLS NOLOGIN and own nothing (an owner bypasses RLS); service_role must be BYPASSRLS (admin contract) but NOSUPERUSER NOLOGIN; the proxy assumes these roles per request (gemini audit R10-1/R10-2/R11-3)", label, strings.Join(targetBad, ", ")))
		}

		if len(bad) == 0 && len(unexpected) == 0 && directDeps == 0 && len(unsafeEdges) == 0 && len(nonTerminal) == 0 && len(missing) == 0 && len(absent) == 0 && len(targetBad) == 0 {
			log.Info().Str("pool", label).Str("role", su).Msg("login role verified: non-privileged, NOINHERIT, no direct grants/ownership, allowlisted+terminal memberships, target roles have the expected profile")
		}
	}

	// Data plane: member of ONLY anon + authenticated (so it cannot reach
	// service_role / BYPASSRLS, directly or transitively).
	checkLoginRole(dataPool, "data pool", []string{"anon", "authenticated"})

	// Admin plane: member of ONLY service_role, AND its connections actually
	// assume it (AfterConnect SET ROLE makes current_user = service_role while
	// session_user stays the unprivileged login role).
	checkLoginRole(adminPool, "admin pool", []string{"service_role"})
	var adminCurrent string
	if err := adminPool.QueryRow(ctx, "SELECT current_user").Scan(&adminCurrent); err != nil {
		report("admin pool: cannot assume service_role at connect (is ADMIN_DATABASE_URL the authenticator_admin role, and can it assume service_role?): " + err.Error())
	} else if adminCurrent != "service_role" {
		report(fmt.Sprintf("admin pool effective role is %q, expected service_role — ADMIN_DATABASE_URL must point at a role that assumes service_role", adminCurrent))
	}
}

// buildRouter assembles the chi router with all middleware and route handlers.
// The structure mirrors the Rust proxy's build_router function:
//   - Studio SPA routes (relaxed CSP)
//   - API routes with strict CSP, body limit, security headers
//   - CORS applied to the outer router (covers both)
func buildRouter(state *AppState) http.Handler {
	rlsCfg := appMiddleware.RLSConfig{
		JWTSecret:      state.Config.JWTSecret,
		AnonKey:        state.Config.AnonKey,
		ServiceRoleKey: state.Config.ServiceRoleKey,
	}

	authDeps := &auth.Deps{
		Pool:                     state.AdminPool,
		JWTSecret:                state.Config.JWTSecret,
		AnonKey:                  state.Config.AnonKey,
		ServiceRoleKey:           state.Config.ServiceRoleKey,
		AccessTokenExpirySecs:    state.Config.AccessTokenExpirySecs,
		RefreshTokenExpiryDays:   state.Config.RefreshTokenExpiryDays,
		AllowAnonymousSignin:     state.Config.AllowAnonymousSignin,
		AnonymousJWTTTLSecs:      state.Config.AnonymousJWTTTLSecs,
		Mailer:                   state.Mailer,
		RequireEmailVerification: state.Config.RequireEmailVerification,
		EmailEnabled:             state.Config.EmailEnabled,
		SiteURL:                  state.Config.SiteURL,
		GoogleClientID:           state.Config.GoogleClientID,
		GoogleClientSecret:       state.Config.GoogleClientSecret,
		GitHubClientID:           state.Config.GitHubClientID,
		GitHubClientSecret:       state.Config.GitHubClientSecret,
		AppleClientID:            state.Config.AppleClientID,
		AppleTeamID:              state.Config.AppleTeamID,
		AppleKeyID:               state.Config.AppleKeyID,
		ApplePrivateKey:          state.Config.ApplePrivateKey,
		MicrosoftClientID:        state.Config.MicrosoftClientID,
		MicrosoftClientSecret:    state.Config.MicrosoftClientSecret,
		OIDCClientID:             state.Config.OIDCClientID,
		OIDCClientSecret:         state.Config.OIDCClientSecret,
		OIDCIssuerURL:            state.Config.OIDCIssuerURL,
	}

	// Load REST catalog (already allocated in state; refresh from DB here).
	if err := state.Catalog.Refresh(context.Background(), state.AdminPool); err != nil {
		log.Warn().Err(err).Msg("initial catalog load failed — REST endpoints may return 404 until refreshed")
	} else {
		log.Info().Msg("REST catalog loaded")
	}
	restDeps := &rest.RestDeps{
		Pool:      state.Pool,
		AdminPool: state.AdminPool,
		Catalog:   state.Catalog,
		ResolveClaims: func(r *http.Request) (*rest.RequestClaims, error) {
			claims, err := appMiddleware.ResolveClaims(r, rlsCfg)
			if err != nil {
				return nil, err
			}
			return &rest.RequestClaims{
				Role:       claims.Role,
				Sub:        claims.Sub,
				Email:      claims.Email,
				ClaimsJSON: claims.ClaimsJSON,
			}, nil
		},
	}

	r := chi.NewRouter()

	// Global middleware
	r.Use(chiMiddleware.RequestID)
	// NOTE: chiMiddleware.RealIP is intentionally NOT used — it rewrites
	// r.RemoteAddr from True-Client-IP / X-Real-IP / first-XFF with no
	// trusted-proxy check, which defeats every downstream security gate
	// that reads RemoteAddr (rate limiter, WS per-IP cap, HSTS isHTTPS).
	// Audit round 25 (HIGH). Our own appMiddleware.realIP() is
	// TrustedProxies-aware and is consulted directly by the rate limiter
	// and the WS limiter; the underlying r.RemoteAddr stays authentic
	// for the HSTS XFP gate.
	if state.Config.GzipLevel > 0 {
		r.Use(chiMiddleware.Compress(state.Config.GzipLevel))
	}
	r.Use(appMiddleware.CORSMiddleware(state.Config.AllowedOrigins, state.Config.AllowPermissiveCORS))
	// HSTS self-gates per-request via r.TLS / X-Forwarded-Proto so the header
	// also fires when this proxy runs HTTP behind a TLS-terminating reverse
	// proxy (umbrella nginx, Cloudflare). Plain HTTP requests are skipped
	// inside the middleware. X-Forwarded-Proto is only honoured when the
	// immediate connection comes from a configured TRUSTED_PROXIES IP —
	// without that gate a directly-exposed proxy could be tricked into
	// HSTS-preload poisoning. Preload is opt-in (HSTS_PRELOAD env, default
	// off) because hstspreload.org submission is a one-way ticket.
	r.Use(appMiddleware.HSTSHeaders(appMiddleware.HSTSConfig{
		TrustedProxies: state.Config.TrustedProxies,
		MaxAge:         state.Config.HSTSMaxAgeSeconds,
		Preload:        state.Config.HSTSPreload,
	}))

	// ── Studio SPA (relaxed CSP) ──────────────────────────────────────────
	r.Group(func(r chi.Router) {
		r.Use(appMiddleware.StudioSecurityHeaders)
		r.Get("/studio", routes.StudioRedirect)
		r.Handle("/studio/*", routes.StudioSPA(state.Config.StudioDir))
	})

	// ── Docs site (Docusaurus static) ─────────────────────────────────────
	r.Get("/docs", routes.DocsRedirect)
	r.Handle("/docs/*", routes.DocsSite(state.Config.DocsDir))

	// ── Sidecar routes (SIDECAR_ROUTES) ───────────────────────────────────
	// Registered before the static handler on purpose: PublicDir is installed
	// as chi's NotFound, so an unrouted prefix does not 404 — it answers 200
	// with index.html, and a caller expecting a WebSocket sees a successful
	// HTTP response instead of an upgrade. Whoever added the route would have
	// no way to tell it was never wired.
	for _, route := range state.Config.SidecarRoutes {
		h := route.Handler()
		r.Handle(route.Prefix, h)
		r.Handle(route.Prefix+"/*", h)
		log.Info().Str("prefix", route.Prefix).Str("upstream", route.Upstream.String()).Msg("sidecar route")
	}

	// ── API routes (strict CSP, body size limit) ──────────────────────────
	r.Group(func(r chi.Router) {
		r.Use(appMiddleware.SecurityHeaders)
		r.Use(appMiddleware.BodyLimit(state.Config.MaxBodySize))

		// Health
		r.Get("/health", routes.Health(&state.PGConnected, &state.AdminConnected))

		// WebSocket routes — wrapped in a per-IP connection limiter so a
		// single client cannot exhaust the WSSemaphore. The limiter
		// increments only on successful hijack (i.e. real upgrades) and
		// decrements on conn close, so failed handshakes don't leak slots.
		wsLimiter := appMiddleware.NewWSConnLimiter(state.Config.WSMaxPerIP, state.Config.TrustedProxies)
		r.Group(func(r chi.Router) {
			r.Use(wsLimiter.Middleware)
			// Live query subscription — the only route that actually
			// hijacks the connection. Presence is a plain HTTP read and
			// must NOT be in this group (audit F3 round 22: clients at
			// the WS cap would otherwise get 429 on presence reads too,
			// even though presence doesn't consume a slot).
			r.Get("/ws/{queryID}", realtime.WSHandler(
				rlsCfg,
				state.AdminPool,
				state.Hub,
				state.WSSemaphore,
				state.Config.BroadcastCapacity,
				state.Config.AllowedOrigins,
				state.Config.AllowPermissiveCORS,
				state.Config.RequireAuthenticatedWS,
			))
		})

		// Presence — HTTP endpoint for current presence state. Same auth +
		// audience gate as the WSHandler upgrade path so this isn't a
		// side channel into private rooms. Outside the wsLimiter group
		// because presence reads don't consume a WebSocket slot.
		r.Get("/ws/_presence/{channel}", realtime.PresenceHandler(
			rlsCfg, state.AdminPool, state.Hub, state.Config.RequireAuthenticatedWS,
		))

		// ── Auth routes ───────────────────────────────────────────────────
		// Rate-limited auth endpoints (brute-force and email-bombing targets).
		// /auth/v1/anonymous lives in its own bucket because it mints a
		// stateless throw-away JWT with no DB write and no email send —
		// the threat model allows generous limits for public guest-token
		// demos. See state.AnonymousLimiter / ANONYMOUS_RATE_LIMIT.
		r.Group(func(r chi.Router) {
			r.Use(state.RateLimiter.Middleware)
			r.Post("/auth/v1/signup", auth.Signup(authDeps))
			r.Post("/auth/v1/token", auth.Token(authDeps))
			r.Post("/auth/v1/recover", auth.Recover(authDeps))
			r.Post("/auth/v1/recover/confirm", auth.RecoverConfirm(authDeps))
			r.Post("/auth/v1/magiclink", auth.Magiclink(authDeps))
		})
		r.Group(func(r chi.Router) {
			r.Use(state.AnonymousLimiter.Middleware)
			r.Post("/auth/v1/anonymous", auth.Anonymous(authDeps))
		})

		// Non-rate-limited auth endpoints.
		r.Get("/auth/v1/user", auth.GetUser(authDeps))
		r.Patch("/auth/v1/user", auth.UpdateUser(authDeps))
		r.Post("/auth/v1/logout", auth.Logout(authDeps))
		r.Get("/auth/v1/verify", auth.VerifyEmail(authDeps))
		r.Get("/auth/v1/magiclink/verify", auth.MagiclinkVerify(authDeps))

		// Admin
		r.Get("/auth/v1/admin/users", auth.AdminListUsers(authDeps))
		r.Post("/auth/v1/admin/users", auth.AdminCreateUser(authDeps))
		r.Delete("/auth/v1/admin/users/{id}", auth.AdminDeleteUser(authDeps))

		// OAuth
		r.Get("/auth/v1/authorize", auth.Authorize(authDeps))
		r.Get("/auth/v1/callback", auth.Callback(authDeps))
		r.Post("/auth/v1/callback", auth.Callback(authDeps)) // Apple uses form_post

		// ── REST API (PostgREST-compatible CRUD) ──────────────────────────
		// RPC must be registered before the generic {table} routes to avoid
		// chi's greedy matching catching "rpc" as a table name.
		r.Get("/rest/v1/rpc/{function}", rest.RPCGet(restDeps))
		r.Post("/rest/v1/rpc/{function}", rest.RPCPost(restDeps))

		// OpenAPI spec (must be before {table} wildcard)
		r.Get("/rest/v1", routes.OpenAPISpec(state.Catalog))
		r.Get("/rest/v1/", routes.OpenAPISpec(state.Catalog))

		// Batch transactions (must be before {table} wildcard)
		r.Post("/rest/v1/batch", rest.Batch(restDeps, state.Config.MaxBatchOperations))

		// RLS debug
		// rls-debug is service_role-only, and the data pool's authenticator role
		// can no longer SET LOCAL ROLE service_role (finding 6) — run it on the
		// admin pool (authenticator_admin) like the other service_role paths.
		r.Get("/rest/v1/rls-debug", routes.RLSDebug(state.AdminPool, rlsCfg))

		// Webhooks CRUD (must be before {table} wildcard)
		// Webhook CRUD is service_role-gated at the HTTP layer and writes
		// pgstack.webhooks + installs triggers with no per-request SET ROLE —
		// it runs on the admin (service_role) pool, not the RLS data plane.
		webhookDeps := &routes.WebhookDeps{
			Pool: state.AdminPool,
			ResolveClaims: func(r *http.Request) (appMiddleware.RequestClaims, error) {
				return appMiddleware.ResolveClaims(r, rlsCfg)
			},
			WebhookManager: state.WebhookManager,
			SecretBox:      state.SecretBox,
		}
		r.Post("/rest/v1/webhooks", routes.CreateWebhook(webhookDeps))
		r.Get("/rest/v1/webhooks", routes.ListWebhooks(webhookDeps))
		r.Delete("/rest/v1/webhooks/{id}", routes.DeleteWebhook(webhookDeps))

		// Table CRUD
		r.Get("/rest/v1/{table}", rest.Select(restDeps))
		r.Post("/rest/v1/{table}", rest.Insert(restDeps))
		r.Patch("/rest/v1/{table}", rest.Update(restDeps))
		r.Delete("/rest/v1/{table}", rest.Delete(restDeps))

		// ── Dev / demo routes ─────────────────────────────────────────────
		// /api/sql is mounted only when ENABLE_SQL_ENDPOINT=true. The
		// handler also requires service_role, so the flag is two-layer
		// defence: even a leaked SERVICE_ROLE_KEY cannot reach SQL
		// execution unless the operator explicitly opted in at boot.
		if state.Config.EnableSQLEndpoint {
			r.Post("/api/sql", routes.SQL(state.AdminPool, routes.SQLConfig{
				EnableSQLEndpoint: state.Config.EnableSQLEndpoint,
				ServiceRoleKey:    state.Config.ServiceRoleKey,
				RLS:               rlsCfg,
				CatalogRefreshFn: func() error {
					return state.Catalog.Refresh(context.Background(), state.AdminPool)
				},
			}))
		}

		// /api/demo mutates demo tables — only mount when explicitly enabled
		// or a service_role key is configured (in which case the handler still
		// requires that key on every request).
		if state.Config.EnableDemoEndpoint || state.Config.ServiceRoleKey != "" {
			// Demo mutates seed tables in public with no SET ROLE; it is
			// service_role-key gated and runs on the admin pool (service_role
			// holds GRANT ALL on public tables).
			r.Post("/api/demo", routes.Demo(
				state.AdminPool,
				state.Config.EnableDemoEndpoint,
				state.Config.ServiceRoleKey,
			))
		}

		r.Post("/api/catalog/refresh", routes.CatalogRefresh(
			state.AdminPool,
			rlsCfg,
			func(pool *pgxpool.Pool) error {
				return state.Catalog.Refresh(context.Background(), pool)
			},
		))
	})

	// ── Storage routes (own group — no BodyLimit, handler uses MaxBytesReader) ──
	r.Group(func(r chi.Router) {
		r.Use(appMiddleware.SecurityHeaders)

		// Storage enforces bucket/object ownership in the handler + owner-locked
		// upsert SQL (not PG RLS), so it runs on the admin (service_role) pool.
		// service_role has BYPASSRLS + explicit DML grants on the storage tables.
		storageDeps := &routes.StorageDeps{
			Pool: state.AdminPool,
			ResolveClaims: func(r *http.Request) (appMiddleware.RequestClaims, error) {
				return appMiddleware.ResolveClaims(r, rlsCfg)
			},
			MaxFileSize:    state.Config.MaxFileSize,
			StorageBackend: state.Config.StorageBackend,
			StorageDir:     state.Config.StorageDir,
		}
		r.Route("/storage/v1", func(r chi.Router) {
			r.Post("/bucket", routes.CreateBucket(storageDeps))
			r.Get("/bucket", routes.ListBuckets(storageDeps))
			r.Delete("/bucket/{bucketId}", routes.DeleteBucket(storageDeps))
			r.Post("/object/{bucket}/*", routes.UploadObject(storageDeps))
			r.Get("/object/list/{bucket}", routes.ListObjects(storageDeps))
			r.Get("/object/{bucket}/*", routes.DownloadObject(storageDeps))
			r.Delete("/object/{bucket}/*", routes.DeleteObject(storageDeps))
		})
	})

	// ── Edge Functions routes (/functions/v1/) ───────────────────────────
	fnCatalog := functions.NewFunctionsCatalog(state.SecretBox)
	if err := fnCatalog.Refresh(context.Background(), state.AdminPool); err != nil {
		log.Warn().Err(err).Msg("initial edge functions catalog load failed — functions may return 404 until refreshed")
	} else {
		log.Info().Msg("edge functions catalog loaded")
	}
	fnDeps := &functions.FunctionsDeps{
		Pool:      state.Pool,
		AdminPool: state.AdminPool,
		ResolveClaims: func(r *http.Request) (*rest.RequestClaims, error) {
			claims, err := appMiddleware.ResolveClaims(r, rlsCfg)
			if err != nil {
				return nil, err
			}
			return &rest.RequestClaims{
				Role:       claims.Role,
				Sub:        claims.Sub,
				Email:      claims.Email,
				ClaimsJSON: claims.ClaimsJSON,
			}, nil
		},
		Catalog:        fnCatalog,
		DatabaseURL:    state.Config.DatabaseURL,
		EdgeRuntimeURL: state.Config.EdgeRuntimeURL,
		EdgeFnTimeout:  state.Config.EdgeFnTimeout,
	}

	// Auto-refresh the functions catalog via NOTIFY whenever a function is
	// deployed, updated, or deleted (trigger fires pg_notify('pgstack_fn_changed')).
	fnCatalog.StartAutoRefresh(context.Background(), state.Config.DatabaseURL, state.AdminPool, nil)
	r.Group(func(r chi.Router) {
		r.Use(appMiddleware.SecurityHeaders)
		r.Use(appMiddleware.BodyLimit(state.Config.MaxBodySize))
		r.Use(appMiddleware.EdgeFnTiming)
		r.Get("/functions/v1/", functions.List(fnDeps))
		r.Post("/functions/v1/_refresh", functions.Refresh(fnDeps))
		// Edge-runtime readiness probe. Registered as a literal path so it takes
		// precedence over the {name} wildcard — without this it fell through to
		// InvokeGet as a function literally named "_health" and the dedicated,
		// deadline-bounded handler was never reached (gemini audit P3).
		r.Get("/functions/v1/_health", functions.DenoHealth(fnDeps))
		r.Get("/functions/v1/{name}", functions.InvokeGet(fnDeps))
		r.Post("/functions/v1/{name}", functions.Invoke(fnDeps))
	})

	// ── User SPA / static files (lowest priority, catch-all) ─────────
	if state.Config.PublicDir != "" {
		if info, err := os.Stat(state.Config.PublicDir); err == nil && info.IsDir() {
			publicHandler := appMiddleware.PublicSecurityHeaders(state.Config.PublicAllowInlineScripts)(
				routes.PublicSPA(state.Config.PublicDir),
			)
			r.NotFound(publicHandler.ServeHTTP)
			log.Info().Str("dir", state.Config.PublicDir).Msg("serving user static files")
		}
	}

	return r
}

// notImplemented returns a handler that responds 501 Not Implemented for routes
// whose backing package (auth, rest) has not yet been fully ported.
func notImplemented(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotImplemented, name+" not yet implemented")
	}
}
