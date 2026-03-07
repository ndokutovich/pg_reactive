package main

import (
	"context"
	"crypto/tls"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
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
)

func main() {
	// Structured JSON logging via zerolog.
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	if os.Getenv("LOG_PRETTY") == "1" {
		log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr})
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
		log.Warn().Msg("ENABLE_SQL_ENDPOINT=true — /api/sql accepts unauthenticated requests (disable in production!)")
	}
	if len(cfg.AllowedOrigins) == 0 {
		log.Warn().Msg("ALLOWED_ORIGINS not set — CORS is permissive (set to restrict in production)")
	}

	// Build PG connection pool.
	pool, err := buildPool(cfg.DatabaseURL, cfg.PGPoolMaxConns, cfg.PGPoolMinConns, cfg.PGPoolMaxConnIdleTime)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to connect to PostgreSQL")
	}
	defer pool.Close()
	log.Info().Msg("PG connection pool ready")

	state := NewAppState(cfg, pool)

	// Kick off the dedicated PG LISTEN connection in a background goroutine.
	go realtime.ListenLoop(
		cfg.DatabaseURL,
		state.Hub,
		&state.PGConnected,
		cfg.PGReconnectMaxBackoff,
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
	tlsSrv := &http.Server{
		Addr:         cfg.HTTPSAddr,
		Handler:      handler,
		TLSConfig:    m.TLSConfig(),
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

// buildPool creates a pgxpool.Pool for request-handler use.
func buildPool(dbURL string, maxConns, minConns int32, maxIdleTime time.Duration) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	poolCfg.MaxConns = maxConns
	poolCfg.MinConns = minConns
	poolCfg.MaxConnIdleTime = maxIdleTime
	return pgxpool.NewWithConfig(context.Background(), poolCfg)
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
		Pool:                     state.Pool,
		JWTSecret:                state.Config.JWTSecret,
		AnonKey:                  state.Config.AnonKey,
		ServiceRoleKey:           state.Config.ServiceRoleKey,
		AccessTokenExpirySecs:    state.Config.AccessTokenExpirySecs,
		RefreshTokenExpiryDays:   state.Config.RefreshTokenExpiryDays,
		Mailer:                   state.Mailer,
		RequireEmailVerification: state.Config.RequireEmailVerification,
		SiteURL:                  state.Config.SiteURL,
		GoogleClientID:           state.Config.GoogleClientID,
		GoogleClientSecret:       state.Config.GoogleClientSecret,
		GitHubClientID:           state.Config.GitHubClientID,
		GitHubClientSecret:       state.Config.GitHubClientSecret,
	}

	// Load REST catalog (already allocated in state; refresh from DB here).
	if err := state.Catalog.Refresh(context.Background(), state.Pool); err != nil {
		log.Warn().Err(err).Msg("initial catalog load failed — REST endpoints may return 404 until refreshed")
	} else {
		log.Info().Msg("REST catalog loaded")
	}
	restDeps := &rest.RestDeps{
		Pool:    state.Pool,
		Catalog: state.Catalog,
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
	r.Use(chiMiddleware.RealIP)
	if state.Config.GzipLevel > 0 {
		r.Use(chiMiddleware.Compress(state.Config.GzipLevel))
	}
	r.Use(appMiddleware.CORSMiddleware(state.Config.AllowedOrigins))

	// ── Studio SPA (relaxed CSP) ──────────────────────────────────────────
	r.Group(func(r chi.Router) {
		r.Use(appMiddleware.StudioSecurityHeaders)
		r.Get("/studio", routes.StudioRedirect)
		r.Handle("/studio/*", routes.StudioSPA(state.Config.StudioDir))
	})

	// ── Docs site (Docusaurus static) ─────────────────────────────────────
	r.Get("/docs", routes.DocsRedirect)
	r.Handle("/docs/*", routes.DocsSite(state.Config.DocsDir))

	// ── API routes (strict CSP, body size limit) ──────────────────────────
	r.Group(func(r chi.Router) {
		r.Use(appMiddleware.SecurityHeaders)
		r.Use(appMiddleware.BodyLimit(state.Config.MaxBodySize))

		// Health
		r.Get("/health", routes.Health(&state.PGConnected))

		// WebSocket — live query subscription
		r.Get("/ws/{queryID}", realtime.WSHandler(
			rlsCfg,
			state.Pool,
			state.Hub,
			state.WSSemaphore,
			state.Config.BroadcastCapacity,
		))

		// ── Auth routes ───────────────────────────────────────────────────
		// Rate-limited auth endpoints (signup + token are brute-force targets).
		r.Group(func(r chi.Router) {
			r.Use(state.RateLimiter.Middleware)
			r.Post("/auth/v1/signup", auth.Signup(authDeps))
			r.Post("/auth/v1/token", auth.Token(authDeps))
		})

		// Non-rate-limited auth endpoints.
		r.Get("/auth/v1/user", auth.GetUser(authDeps))
		r.Patch("/auth/v1/user", auth.UpdateUser(authDeps))
		r.Post("/auth/v1/logout", auth.Logout(authDeps))
		r.Post("/auth/v1/recover", auth.Recover(authDeps))
		r.Post("/auth/v1/recover/confirm", auth.RecoverConfirm(authDeps))
		r.Get("/auth/v1/verify", auth.VerifyEmail(authDeps))
		r.Post("/auth/v1/magiclink", auth.Magiclink(authDeps))
		r.Get("/auth/v1/magiclink/verify", auth.MagiclinkVerify(authDeps))

		// Admin
		r.Get("/auth/v1/admin/users", auth.AdminListUsers(authDeps))
		r.Post("/auth/v1/admin/users", auth.AdminCreateUser(authDeps))
		r.Delete("/auth/v1/admin/users/{id}", auth.AdminDeleteUser(authDeps))

		// OAuth
		r.Get("/auth/v1/authorize", auth.Authorize(authDeps))
		r.Get("/auth/v1/callback", auth.Callback(authDeps))

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
		r.Get("/rest/v1/rls-debug", routes.RLSDebug(state.Pool, rlsCfg))

		// Table CRUD
		r.Get("/rest/v1/{table}", rest.Select(restDeps))
		r.Post("/rest/v1/{table}", rest.Insert(restDeps))
		r.Patch("/rest/v1/{table}", rest.Update(restDeps))
		r.Delete("/rest/v1/{table}", rest.Delete(restDeps))

		// ── Dev / demo routes ─────────────────────────────────────────────
		r.Post("/api/sql", routes.SQL(state.Pool, routes.SQLConfig{
			EnableSQLEndpoint: state.Config.EnableSQLEndpoint,
			ServiceRoleKey:    state.Config.ServiceRoleKey,
			RLS:               rlsCfg,
			CatalogRefreshFn: func() error {
				return state.Catalog.Refresh(context.Background(), state.Pool)
			},
		}))

		r.Post("/api/demo", routes.Demo(
			state.Pool,
			state.Config.EnableSQLEndpoint,
			state.Config.ServiceRoleKey,
		))

		r.Post("/api/catalog/refresh", routes.CatalogRefresh(
			state.Pool,
			rlsCfg,
			func(pool *pgxpool.Pool) error {
				return state.Catalog.Refresh(context.Background(), pool)
			},
		))
	})

	// ── Storage routes (own group — no BodyLimit, handler uses MaxBytesReader) ──
	r.Group(func(r chi.Router) {
		r.Use(appMiddleware.SecurityHeaders)

		storageDeps := &routes.StorageDeps{
			Pool: state.Pool,
			ResolveClaims: func(r *http.Request) (appMiddleware.RequestClaims, error) {
				return appMiddleware.ResolveClaims(r, rlsCfg)
			},
			MaxFileSize: state.Config.MaxFileSize,
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
	fnCatalog := functions.NewFunctionsCatalog()
	if err := fnCatalog.Refresh(context.Background(), state.Pool); err != nil {
		log.Warn().Err(err).Msg("initial edge functions catalog load failed — functions may return 404 until refreshed")
	} else {
		log.Info().Msg("edge functions catalog loaded")
	}
	fnDeps := &functions.FunctionsDeps{
		Pool: state.Pool,
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
		Catalog:     fnCatalog,
		DatabaseURL: state.Config.DatabaseURL,
	}

	// Auto-refresh the functions catalog via NOTIFY whenever a function is
	// deployed, updated, or deleted (trigger fires pg_notify('pgstack_fn_changed')).
	fnCatalog.StartAutoRefresh(context.Background(), state.Config.DatabaseURL, state.Pool, nil)
	r.Group(func(r chi.Router) {
		r.Use(appMiddleware.SecurityHeaders)
		r.Get("/functions/v1/", functions.List(fnDeps))
		r.Post("/functions/v1/_refresh", functions.Refresh(fnDeps))
		r.Get("/functions/v1/{name}", functions.InvokeGet(fnDeps))
		r.Post("/functions/v1/{name}", functions.Invoke(fnDeps))
	})

	// ── User SPA / static files (lowest priority, catch-all) ─────────
	if state.Config.PublicDir != "" {
		if info, err := os.Stat(state.Config.PublicDir); err == nil && info.IsDir() {
			publicHandler := appMiddleware.PublicSecurityHeaders(
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

