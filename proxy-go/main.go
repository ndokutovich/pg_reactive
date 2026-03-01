package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"pgstack-proxy-go/auth"
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
	pool, err := buildPool(cfg.DatabaseURL)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to connect to PostgreSQL")
	}
	defer pool.Close()
	log.Info().Msg("PG connection pool ready")

	state := NewAppState(cfg, pool)

	// Kick off the dedicated PG LISTEN connection in a background goroutine.
	go realtime.ListenLoop(
		cfg.DatabaseURL,
		&state.Channels,
		&state.PGConnected,
		cfg.PGReconnectMaxBackoff,
	)

	// Build and start the HTTP server.
	r := buildRouter(state)

	srv := &http.Server{
		Addr:         cfg.ListenAddr,
		Handler:      r,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Graceful shutdown on SIGINT / SIGTERM.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Info().
			Str("addr", cfg.ListenAddr).
			Int("max_connections", cfg.MaxConnections).
			Msg("pgstack-proxy-go listening")

		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server error")
		}
	}()

	<-quit
	log.Info().Msg("shutdown signal received")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Error().Err(err).Msg("graceful shutdown failed")
	}
	log.Info().Msg("shutdown complete")
}

// buildPool creates a pgxpool.Pool for request-handler use (max 50 connections).
func buildPool(dbURL string) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	poolCfg.MaxConns = 50
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

	// Build the REST dependency bundle.  The catalog is loaded once at startup;
	// callers can refresh it via POST /api/catalog/refresh (service_role only).
	catalog := rest.NewCatalog()
	if err := catalog.Refresh(context.Background(), state.Pool); err != nil {
		log.Warn().Err(err).Msg("initial catalog load failed — REST endpoints may return 404 until refreshed")
	} else {
		log.Info().Msg("REST catalog loaded")
	}
	restDeps := &rest.RestDeps{
		Pool:    state.Pool,
		Catalog: catalog,
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
	r.Use(appMiddleware.CORSMiddleware(state.Config.AllowedOrigins))

	// ── Studio SPA (relaxed CSP) ──────────────────────────────────────────
	r.Group(func(r chi.Router) {
		r.Use(appMiddleware.StudioSecurityHeaders)
		r.Get("/studio", routes.StudioRedirect)
		r.Handle("/studio/*", routes.StudioSPA(state.Config.StudioDir))
	})

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
			&state.Channels,
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
				return catalog.Refresh(context.Background(), state.Pool)
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
				return catalog.Refresh(context.Background(), pool)
			},
		))
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

