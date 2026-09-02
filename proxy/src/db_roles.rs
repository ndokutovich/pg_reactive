//! Startup verification of the proxy's PostgreSQL login roles (SECURITY.md
//! invariants 22 & 24). Mirrors the Go proxy's `verifyPoolRoles` (main.go) at
//! FULL parity — every dimension the Go reference checks is enforced here, and a
//! variant that the Go startup check rejects is rejected here too.
//!
//! The proxy must connect with two powerless login roles, never the superuser:
//!   - the DATA pool's login role (`authenticator`) is a (transitive) member of
//!     `anon`/`authenticated` ONLY — NOT `service_role` — so a data-plane
//!     compromise cannot RESET ROLE back to a role that bypasses RLS;
//!   - the ADMIN pool's login role (`authenticator_admin`) is a (transitive)
//!     member of `service_role` ONLY, and its connections actually assume it (the
//!     `SET ROLE service_role` AfterConnect must succeed).
//!
//! Each login role is verified across ALL of the following (gemini R5–R12):
//!   R5  — non-privileged ATTRIBUTES: NOSUPERUSER NOBYPASSRLS NOCREATEROLE
//!         NOCREATEDB NOINHERIT NOREPLICATION;
//!   R6  — TRANSITIVE membership allowlist (pg_has_role, not direct-edge): the
//!         role may reach only its allowlisted peers, so service_role reached via
//!         an intermediate role — or a dangerous predefined role like
//!         pg_execute_server_program / pg_read_all_data — is caught;
//!   R7  — no DIRECT ACL grants and no object OWNERSHIP (pg_shdepend deptype
//!         'o'/'a'): a direct grant or owned object applies whenever the role is
//!         current, even after RESET ROLE, even under NOINHERIT;
//!   R8  — per-edge GRANT OPTIONS (PG16 per-membership): every allowlisted edge
//!         must be admin_option=f, inherit_option=f, set_option=t (WITH ADMIN
//!         OPTION / WITH INHERIT TRUE / WITH SET FALSE are all rejected);
//!   R9  — reachable allowlisted roles must be TERMINAL (members of nothing), so a
//!         transitive edge between allowlisted roles (e.g. anon -> authenticated
//!         WITH INHERIT TRUE) cannot grant ambient privilege after SET ROLE;
//!   R10 — TARGET-role profiles: anon/authenticated must be NOSUPERUSER
//!         NOBYPASSRLS NOLOGIN and own no objects; service_role must be BYPASSRLS
//!         (admin contract, invariant 22) but NOSUPERUSER NOLOGIN;
//!   R11 — REQUIRED memberships PRESENT: the login role must actually be a member
//!         of every allowlisted role that exists (a missing one is a false-healthy
//!         boot that 500s at runtime);
//!   R12 — ABSENT required target roles are FATAL in production (standalone
//!         pg_reactive without the pgStack core is the explicit
//!         PGSTACK_ENV=development escape → warning).
//!
//! FATAL in `PGSTACK_ENV=production`; a warning otherwise (dev / standalone).

use std::collections::HashSet;

use sqlx::{PgPool, Row};
use tracing::{error, info, warn};

use crate::config::Config;

pub async fn verify_pool_roles(data: &PgPool, admin: &PgPool, config: &Config) {
    let fatal = config.pgstack_env == "production";
    let mut problems: Vec<String> = Vec::new();

    // --- data pool: powerless login role, member of anon/authenticated only ---
    match check_login_role(data, &["anon", "authenticated", "anonymous"]).await {
        Ok(ps) => problems.extend(ps.into_iter().map(|p| format!("data pool: {p}"))),
        Err(e) => problems.push(format!("data pool: role check failed: {e}")),
    }
    // The data login role must NOT be able to assume service_role (directly or
    // transitively) — that is the whole point of the data/admin split. (The
    // transitive allowlist above already catches this; kept as an explicit,
    // unambiguous belt-and-suspenders boundary check.)
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
        info!("verifyPoolRoles: data + admin pool roles OK (non-superuser, NOINHERIT, no direct grants/ownership, allowlisted+terminal memberships with safe edge options, target roles have the expected profile, admin assumes service_role)");
        return;
    }
    for p in &problems {
        if fatal {
            error!("verifyPoolRoles: {p}");
        } else {
            warn!("verifyPoolRoles: {p} (PGSTACK_ENV != production — warning only; FATAL in production)");
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

/// Verify the LOGIN role (session_user) across every dimension the Go
/// `checkLoginRole` covers, parameterised by the transitive membership allowlist
/// (`allow`). Returns a list of problems (the caller prefixes the pool label).
async fn check_login_role(pool: &PgPool, allow: &[&str]) -> Result<Vec<String>, sqlx::Error> {
    let mut problems = Vec::new();

    // --- R5: non-privileged login-role attributes -------------------------------
    // Go: SELECT session_user, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
    //     rolinherit, rolreplication FROM pg_roles WHERE rolname = session_user
    let row = sqlx::query(
        "SELECT session_user::text AS login, rolsuper, rolbypassrls, rolcreaterole, \
                rolcreatedb, rolinherit, rolreplication \
         FROM pg_roles WHERE rolname = session_user",
    )
    .fetch_one(pool)
    .await?;
    let login: String = row.get("login");
    let mut bad: Vec<&str> = Vec::new();
    for (attr, label) in [
        ("rolsuper", "SUPERUSER"),
        ("rolbypassrls", "BYPASSRLS"),
        ("rolcreaterole", "CREATEROLE"),
        ("rolcreatedb", "CREATEDB"),
        ("rolinherit", "INHERIT"),
        ("rolreplication", "REPLICATION"),
    ] {
        if row.get::<bool, _>(attr) {
            bad.push(label);
        }
    }
    if !bad.is_empty() {
        problems.push(format!(
            "login role '{login}' has dangerous attribute(s) [{}] — proxy login roles must be NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION so privileges are never held or inherited without an explicit SET ROLE",
            bad.join(",")
        ));
    }

    // --- R6: transitive membership allowlist ------------------------------------
    // Go: SELECT r.rolname FROM pg_roles r
    //     WHERE r.rolname <> session_user AND pg_has_role(session_user, r.oid, 'MEMBER')
    let mrows = sqlx::query(
        "SELECT r.rolname AS name FROM pg_roles r \
         WHERE r.rolname <> session_user AND pg_has_role(session_user, r.oid, 'MEMBER')",
    )
    .fetch_all(pool)
    .await?;
    let mut actual: HashSet<String> = HashSet::new();
    let mut unexpected: Vec<String> = Vec::new();
    for mr in &mrows {
        let name: String = mr.get("name");
        if !allow.contains(&name.as_str()) {
            unexpected.push(name.clone());
        }
        actual.insert(name);
    }
    if !unexpected.is_empty() {
        problems.push(format!(
            "login role '{login}' is a member of unexpected role(s) [{}] — it must belong only to [{}]; a membership in e.g. service_role, pg_execute_server_program, or pg_read_all_data is an escalation path",
            unexpected.join(","),
            allow.join(",")
        ));
    }

    // --- R11/R12: required memberships present / absent target roles ------------
    // Go: per allowed target, EXISTS check then actual-membership check.
    let mut missing: Vec<String> = Vec::new();
    let mut absent: Vec<String> = Vec::new();
    for target in allow {
        let exists: bool =
            sqlx::query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1) AS e")
                .bind(*target)
                .fetch_one(pool)
                .await?
                .get("e");
        if !exists {
            absent.push((*target).to_string());
        } else if !actual.contains(*target) {
            missing.push((*target).to_string());
        }
    }
    if !absent.is_empty() {
        problems.push(format!(
            "required SET ROLE target role(s) do not exist [{}] — the pgStack core roles (anon/authenticated/service_role) must be bootstrapped before the proxy connects; for standalone pg_reactive WITHOUT pgStack run with PGSTACK_ENV=development (absent roles are fatal only in production) (gemini audit R12-2)",
            absent.join(",")
        ));
    }
    if !missing.is_empty() {
        problems.push(format!(
            "login role '{login}' is NOT a member of required role(s) [{}] — it must be a member of every role it SET ROLEs into ([{}]); without it those requests fail at runtime though startup looked healthy (gemini audit R11-2)",
            missing.join(","),
            allow.join(",")
        ));
    }

    // --- R7: no direct ACL grants / object ownership ----------------------------
    // Go: SELECT count(*) FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass
    //     AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = session_user)
    //     AND deptype IN ('o','a')
    let direct_deps: i64 = sqlx::query(
        "SELECT count(*) AS c FROM pg_shdepend \
         WHERE refclassid = 'pg_authid'::regclass \
           AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = session_user) \
           AND deptype IN ('o','a')",
    )
    .fetch_one(pool)
    .await?
    .get("c");
    if direct_deps > 0 {
        problems.push(format!(
            "login role '{login}' owns objects or holds direct ACL grants ({direct_deps} object dependency/ies) — a proxy login role must be powerless so a RESET ROLE grants nothing (gemini audit R7-1); REVOKE its grants and reassign any owned objects"
        ));
    }

    // --- R8: membership EDGE options --------------------------------------------
    // Go: version-gated. PG16+ reads admin_option/inherit_option/set_option;
    //     older servers only have admin_option (rolinherit governs inheritance and
    //     SET ROLE is always permitted).
    let ver: i32 = sqlx::query("SELECT current_setting('server_version_num')::int AS v")
        .fetch_one(pool)
        .await?
        .get("v");
    let edge_sql = if ver >= 160000 {
        "SELECT r.rolname AS name, m.admin_option AS ao, m.inherit_option AS io, m.set_option AS so \
         FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid \
         WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = session_user)"
    } else {
        "SELECT r.rolname AS name, m.admin_option AS ao, false AS io, true AS so \
         FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid \
         WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = session_user)"
    };
    let erows = sqlx::query(edge_sql).fetch_all(pool).await?;
    let mut unsafe_edges: Vec<String> = Vec::new();
    for er in &erows {
        let name: String = er.get("name");
        let admin_opt: bool = er.get("ao");
        let inherit_opt: bool = er.get("io");
        let set_opt: bool = er.get("so");
        let mut flags: Vec<&str> = Vec::new();
        if admin_opt {
            flags.push("ADMIN OPTION");
        }
        if inherit_opt {
            flags.push("INHERIT TRUE");
        }
        if !set_opt {
            flags.push("SET FALSE");
        }
        if !flags.is_empty() {
            unsafe_edges.push(format!("{name}: {}", flags.join("+")));
        }
    }
    if !unsafe_edges.is_empty() {
        problems.push(format!(
            "login role '{login}' has membership grant(s) with unsafe options [{}] — every grant to a proxy login role must be plain so privileges need an explicit SET ROLE (NO INHERIT, even per-membership on PG16), cannot be re-delegated (NO ADMIN OPTION), and can actually be assumed (WITH SET); re-issue as plain GRANT (gemini audit R8-1/R8-2)",
            unsafe_edges.join("; ")
        ));
    }

    // --- R9: reachable roles must be TERMINAL -----------------------------------
    // Go: SELECT r.rolname FROM pg_roles r WHERE r.rolname <> session_user
    //     AND pg_has_role(session_user, r.oid, 'MEMBER')
    //     AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
    let trows = sqlx::query(
        "SELECT r.rolname AS name FROM pg_roles r \
         WHERE r.rolname <> session_user AND pg_has_role(session_user, r.oid, 'MEMBER') \
           AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)",
    )
    .fetch_all(pool)
    .await?;
    let non_terminal: Vec<String> = trows.iter().map(|r| r.get::<String, _>("name")).collect();
    if !non_terminal.is_empty() {
        problems.push(format!(
            "login role '{login}' can reach role(s) [{}] that are themselves members of other roles — anon/authenticated/service_role must be TERMINAL (members of nothing) so a SET ROLE cannot pick up ambient privileges or delegation through a transitive edge the direct-edge check does not see (gemini audit R9-1)",
            non_terminal.join(",")
        ));
    }

    // --- R10: target-role profiles ----------------------------------------------
    // Go: per allowed target that EXISTS, validate attributes + (for RLS-subject
    //     roles) object ownership. service_role may be BYPASSRLS by design.
    let mut target_bad: Vec<String> = Vec::new();
    for target in allow {
        let exists: bool =
            sqlx::query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1) AS e")
                .bind(*target)
                .fetch_one(pool)
                .await?
                .get("e");
        if !exists {
            continue;
        }
        let trow = sqlx::query(
            "SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin \
             FROM pg_roles WHERE rolname = $1",
        )
        .bind(*target)
        .fetch_one(pool)
        .await?;
        let tsuper: bool = trow.get("rolsuper");
        let tbypass: bool = trow.get("rolbypassrls");
        let tcrole: bool = trow.get("rolcreaterole");
        let tcdb: bool = trow.get("rolcreatedb");
        let trepl: bool = trow.get("rolreplication");
        let tlogin: bool = trow.get("rolcanlogin");
        let bypass_ok = *target == "service_role";
        for (on, name) in [
            (tsuper, "SUPERUSER"),
            (tbypass && !bypass_ok, "BYPASSRLS"),
            (bypass_ok && !tbypass, "NOBYPASSRLS"),
            (tcrole, "CREATEROLE"),
            (tcdb, "CREATEDB"),
            (trepl, "REPLICATION"),
            (tlogin, "LOGIN"),
        ] {
            if on {
                target_bad.push(format!("{target}:{name}"));
            }
        }
        if !bypass_ok {
            // RLS-subject role must own nothing (an owner bypasses its table's RLS).
            // Fail CLOSED on a query error (gemini audit R11-1).
            let owned: i64 = sqlx::query(
                "SELECT count(*) AS c FROM pg_shdepend \
                 WHERE refclassid = 'pg_authid'::regclass \
                   AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = $1) AND deptype = 'o'",
            )
            .bind(*target)
            .fetch_one(pool)
            .await?
            .get("c");
            if owned > 0 {
                target_bad.push(format!("{target}:owns {owned} object(s)"));
            }
        }
    }
    if !target_bad.is_empty() {
        problems.push(format!(
            "SET ROLE target role(s) have an unexpected privilege profile [{}] — anon/authenticated must be NOSUPERUSER NOBYPASSRLS NOLOGIN and own nothing (an owner bypasses RLS); service_role must be BYPASSRLS (admin contract) but NOSUPERUSER NOLOGIN; the proxy assumes these roles per request (gemini audit R10-1/R10-2/R11-3)",
            target_bad.join(", ")
        ));
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
