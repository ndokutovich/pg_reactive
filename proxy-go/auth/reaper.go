package auth

import (
	"context"
	"math/rand"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// reaperInterval is how often the guest reaper wakes. Each wake is jittered
// ±10% so multiple proxy replicas do not thundering-herd the same DELETE.
const reaperInterval = 6 * time.Hour

// StartAnonymousReaper deletes never-upgraded guest accounts that have gone
// quiet. Opt-in (ANONYMOUS_ACCOUNT_TTL_DAYS > 0) because the delete cascades
// through the operator's own FK ON DELETE choices — destructive cleanup must
// be a deployment decision, not a default.
//
// A row is reaped only when ALL hold:
//   - providers = {anonymous}: the account was never upgraded. An upgraded
//     account (email/OAuth attached) is permanent and NEVER reaped, no matter
//     how stale — reaping it would destroy a real user (INV-B's flip is the
//     guard: any attach grows providers).
//   - updated_at is older than the TTL: no auth-side activity.
//   - no live refresh token: nothing can silently resurrect the session. A
//     guest who comes back inside their refresh window is untouched.
//
// Runs on the ADMIN pool (service_role) — RLS on pgstack.users does not grant
// anyone DELETE; this is proxy plumbing, mirrored from the token reaper model.
func StartAnonymousReaper(ctx context.Context, adminPool *pgxpool.Pool, ttlDays int) {
	if ttlDays <= 0 {
		return
	}
	go func() {
		for {
			jitter := time.Duration((rand.Float64()*0.2 - 0.1) * float64(reaperInterval))
			select {
			case <-ctx.Done():
				return
			case <-time.After(reaperInterval + jitter):
			}

			tag, err := adminPool.Exec(ctx, `
				DELETE FROM pgstack.users u
				WHERE u.providers = ARRAY['anonymous']
				  AND u.updated_at < now() - make_interval(days => $1)
				  AND NOT EXISTS (
				        SELECT 1 FROM pgstack.refresh_tokens rt
				        WHERE rt.user_id = u.id
				          AND NOT rt.revoked
				          AND rt.expires_at > now()
				  )
			`, ttlDays)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				log.Error().Err(err).Msg("anonymous reaper: delete failed")
				continue
			}
			if n := tag.RowsAffected(); n > 0 {
				log.Info().Int64("deleted", n).Int("ttl_days", ttlDays).
					Msg("anonymous reaper: stale guest accounts removed")
			}
		}
	}()
}
