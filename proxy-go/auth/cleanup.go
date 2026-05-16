package auth

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// StartExpiredTokenCleanup runs a background goroutine that periodically deletes
// expired rows from pgstack.email_tokens and pgstack.refresh_tokens. The
// expires_at TTL on each table already prevents the proxy from accepting an
// expired token, but rows accumulate forever otherwise — every signup adds an
// email-verification row, every password-reset request adds another, and
// abandoned sessions leave refresh-token rows behind. Closes audit finding
// L3.
//
// Cadence is intentionally low (hourly): the volume of stale rows grows
// linearly with active users and a few extra rows in the table have no
// security or correctness implications. The goroutine exits when ctx is
// cancelled.
func StartExpiredTokenCleanup(ctx context.Context, pool *pgxpool.Pool) {
	const interval = time.Hour
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// Run once at startup so a long-running process recovers backlog without
	// waiting an hour after a redeploy.
	cleanupExpiredTokens(ctx, pool)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cleanupExpiredTokens(ctx, pool)
		}
	}
}

func cleanupExpiredTokens(ctx context.Context, pool *pgxpool.Pool) {
	// Hold the cleanup tightly bounded — even on a giant table this should
	// finish in milliseconds because expires_at is indexed.
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	emailRes, err := pool.Exec(cctx,
		`DELETE FROM pgstack.email_tokens WHERE expires_at < now()`)
	if err != nil {
		log.Warn().Err(err).Msg("auth cleanup: delete expired email_tokens failed")
	}

	// Also reap refresh tokens that have been revoked OR are past expiry.
	// Revoked rows are kept briefly so a stolen-token replay can be detected,
	// but past the original expiry there's no reason to retain them.
	refreshRes, err := pool.Exec(cctx,
		`DELETE FROM pgstack.refresh_tokens WHERE expires_at < now() OR (revoked = true AND expires_at < now() - interval '7 days')`)
	if err != nil {
		log.Warn().Err(err).Msg("auth cleanup: delete expired refresh_tokens failed")
	}

	if emailRes.RowsAffected() > 0 || refreshRes.RowsAffected() > 0 {
		log.Debug().
			Int64("email_tokens", emailRes.RowsAffected()).
			Int64("refresh_tokens", refreshRes.RowsAffected()).
			Msg("auth cleanup: expired tokens purged")
	}
}
