//! Startup verification of the proxy's PostgreSQL login roles (SECURITY.md
//! invariants 22 & 24). Mirrors the Go proxy's `verifyPoolRoles`.
//!
//! The proxy must connect with two powerless login roles, never the superuser:
//!   - the DATA pool's login role (`authenticator`) is a member of `anon`/
//!     `authenticated` ONLY — NOT `service_role` — so a data-plane compromise
//!     cannot RESET ROLE back to a role that bypasses RLS;
//!   - the ADMIN pool's login role (`authenticator_admin`) is a member of
//!     `service_role`, and its connections actually assume it (the `SET ROLE
//!     service_role` AfterConnect must succeed).
//!
//! Both login roles must be non-privileged: not SUPERUSER / BYPASSRLS /
//! CREATEROLE / CREATEDB / REPLICATION / INHERIT.
//!
//! FATAL in `PGSTACK_ENV=production`; a warning otherwise (dev / standalone).
//!
//! NOTE (partial parity): this ports the load-bearing core of the Go check
//! (attributes + membership allowlist + the service_role boundary + admin
//! assumption). The Go proxy additionally checks per-edge grant options
//! (ADMIN/INHERIT/SET), terminal-role membership, direct ACL grants / object
//! ownership, and the target-role attribute profiles — not yet ported here.

use sqlx::{PgPool, Row};
use tracing::{error, info, warn};

use crate::config::Config;

pub async fn verify_pool_roles(data: &PgPool, admin: &PgPool, config: &Config) {
    let fatal = config.pgstack_env == "production";
    let mut problems: Vec<String> = Vec::new();

    // --- data pool: powerless login role, member of anon/authenticated only ---
    match check_login_role(data, &["anon", "authenticated"]).await {
        Ok(ps) => problems.extend(ps.into_iter().map(|p| format!("data pool: {p}"))),
        Err(e) => problems.push(format!("data pool: role check failed: {e}")),
    }
    // The data login role must NOT be able to assume service_role (directly or
    // transitively) — that is the whole point of the data/admin split.
    match member_of_service_role(data).await {
        Ok(true) => problems.push(
            "data pool: login role can assume service_role (a data-plane compromise could RESET ROLE to service_role and bypass RLS) — point ADMIN_DATABASE_URL at a separate authenticator_admin role and revoke service_role from the data role"
                .into(),
        ),
        Ok(false) => {}
        Err(e) => problems.push(format!("data pool: service_role membership check failed: {e}")),
    }

    // --- admin pool: non-privileged login role that assumes service_role ---
    match check_login_role(admin, &["service_role"]).await {
        Ok(ps) => problems.extend(ps.into_iter().map(|p| format!("admin pool: {p}"))),
        Err(e) => problems.push(format!("admin pool: role check failed: {e}")),
    }
    match current_user(admin).await {
        Ok(u) if u == "service_role" => {}
        Ok(u) => problems.push(format!(
            "admin pool: connections do not assume service_role (current_user={u}) — the SET ROLE service_role AfterConnect did not take; check ADMIN_DATABASE_URL / authenticator_admin membership"
        )),
        Err(e) => problems.push(format!("admin pool: current_user check failed: {e}")),
    }

    if problems.is_empty() {
        info!("verifyPoolRoles: data + admin pool roles OK (non-superuser, correct membership, admin assumes service_role)");
        return;
    }
    for p in &problems {
        if fatal {
            error!("verifyPoolRoles: {p}");
        } else {
            warn!("verifyPoolRoles: {p}");
        }
    }
    if fatal {
        panic!(
            "verifyPoolRoles failed in PGSTACK_ENV=production with {} problem(s) — refusing to start with an unsafe DB role",
            problems.len()
        );
    }
    warn!(
        "verifyPoolRoles: {} problem(s) — continuing because PGSTACK_ENV != production",
        problems.len()
    );
}

/// Check the LOGIN role (session_user) attributes are non-privileged, and that
/// every role it is a direct member of is in `allow`.
async fn check_login_role(pool: &PgPool, allow: &[&str]) -> Result<Vec<String>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit, \
                session_user::text AS login \
         FROM pg_roles WHERE rolname = session_user",
    )
    .fetch_one(pool)
    .await?;

    let mut problems = Vec::new();
    let login: String = row.get("login");
    for (attr, label) in [
        ("rolsuper", "SUPERUSER"),
        ("rolbypassrls", "BYPASSRLS"),
        ("rolcreaterole", "CREATEROLE"),
        ("rolcreatedb", "CREATEDB"),
        ("rolreplication", "REPLICATION"),
        ("rolinherit", "INHERIT"),
    ] {
        if row.get::<bool, _>(attr) {
            problems.push(format!(
                "login role '{login}' has {label} (must be off for a powerless proxy role)"
            ));
        }
    }

    let memberships = sqlx::query(
        "SELECT r.rolname AS name FROM pg_auth_members m \
         JOIN pg_roles r ON r.oid = m.roleid \
         JOIN pg_roles l ON l.oid = m.member \
         WHERE l.rolname = session_user",
    )
    .fetch_all(pool)
    .await?;
    for m in memberships {
        let name: String = m.get("name");
        if !allow.contains(&name.as_str()) {
            problems.push(format!(
                "login role '{login}' is a member of '{name}', not in the allowlist {allow:?}"
            ));
        }
    }
    Ok(problems)
}

async fn member_of_service_role(pool: &PgPool) -> Result<bool, sqlx::Error> {
    let row = sqlx::query("SELECT pg_has_role(session_user, 'service_role', 'MEMBER') AS m")
        .fetch_one(pool)
        .await?;
    Ok(row.get("m"))
}

async fn current_user(pool: &PgPool) -> Result<String, sqlx::Error> {
    let row = sqlx::query("SELECT current_user::text AS u")
        .fetch_one(pool)
        .await?;
    Ok(row.get("u"))
}
