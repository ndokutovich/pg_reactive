use std::fmt;
use std::net::SocketAddr;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    /// Admin-plane DSN (authenticator_admin login role, member of service_role).
    /// Falls back to database_url when unset (legacy single-role). The proxy runs
    /// two pools so a data-plane compromise cannot reach service_role.
    pub admin_database_url: String,
    /// Deployment posture. Defaults to "production" (fail-secure) — verifyPoolRoles
    /// is fatal in production, a warning otherwise.
    pub pgstack_env: String,
    pub listen_addr: SocketAddr,
    pub jwt_secret: Option<String>,
    pub anon_key: Option<String>,
    pub service_role_key: Option<String>,
    pub max_connections: usize,
    // OAuth providers
    pub google_client_id: Option<String>,
    pub google_client_secret: Option<String>,
    pub github_client_id: Option<String>,
    pub github_client_secret: Option<String>,
    pub site_url: Option<String>,
    pub auth_rate_limit: usize,
    pub auth_rate_window_secs: u64,
    pub access_token_expiry_secs: u64,
    pub refresh_token_expiry_days: i64,
    pub broadcast_capacity: usize,
    pub max_body_size: usize,
    pub pg_reconnect_max_backoff_secs: u64,
    /// Allow /api/sql without service_role auth (dev/tutorial only).
    pub enable_sql_endpoint: bool,
    /// Comma-separated allowed origins for CORS, or None for permissive (dev mode).
    pub allowed_origins: Option<String>,
    /// Explicit opt-in to reflect any Origin (dev). Fatal in production.
    pub allow_permissive_cors: bool,
    /// Comma-separated trusted reverse-proxy IPs. Forwarded headers (XFF) are
    /// honoured ONLY from these; without it the kernel RemoteAddr is used (INV 4).
    pub trusted_proxies: Option<String>,
    /// Reject anon-key WebSocket subscriptions when true (require a JWT).
    pub require_authenticated_ws: bool,
    /// Add HSTS `preload` directive (irreversible — opt-in only).
    pub hsts_preload: bool,
    /// SMTP_FROM address for outbound email.
    pub smtp_from: String,
    /// When true, users must verify email before logging in.
    pub require_email_verification: bool,
    /// Master switch for email-based flows. When false, no SMTP is required and
    /// the email routes return 503 (see Go Config.EmailEnabled).
    pub email_enabled: bool,
    /// SMTP host (empty = not configured).
    pub smtp_host: String,
    /// SMTP username (empty = not configured).
    pub smtp_user: String,
    /// SMTP password (empty = not configured).
    pub smtp_pass: String,
}

impl Config {
    pub fn from_env() -> Self {
        let database_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://postgres:postgres@db:5432/app".into());

        // Admin pool DSN; falls back to the data DSN (legacy single-role).
        let admin_database_url =
            std::env::var("ADMIN_DATABASE_URL").unwrap_or_else(|_| database_url.clone());

        // Fail-secure: unset/empty PGSTACK_ENV means production.
        let pgstack_env = std::env::var("PGSTACK_ENV")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "production".into())
            .to_lowercase();

        let listen_addr: SocketAddr = std::env::var("LISTEN_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8080".into())
            .parse()
            .expect("invalid LISTEN_ADDR");

        let jwt_secret = std::env::var("JWT_SECRET").ok().filter(|s| !s.is_empty());
        if let Some(ref s) = jwt_secret {
            if s.len() < 32 {
                panic!(
                    "JWT_SECRET must be at least 32 characters (got {}). \
                     Use a cryptographically random string for security.",
                    s.len()
                );
            }
        }
        let anon_key = std::env::var("ANON_KEY").ok().filter(|s| !s.is_empty());
        let service_role_key = std::env::var("SERVICE_ROLE_KEY")
            .ok()
            .filter(|s| !s.is_empty());

        let max_connections: usize = std::env::var("MAX_CONNECTIONS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(10000);

        let google_client_id = std::env::var("GOOGLE_CLIENT_ID")
            .ok()
            .filter(|s| !s.is_empty());
        let google_client_secret = std::env::var("GOOGLE_CLIENT_SECRET")
            .ok()
            .filter(|s| !s.is_empty());
        let github_client_id = std::env::var("GITHUB_CLIENT_ID")
            .ok()
            .filter(|s| !s.is_empty());
        let github_client_secret = std::env::var("GITHUB_CLIENT_SECRET")
            .ok()
            .filter(|s| !s.is_empty());
        let site_url = std::env::var("SITE_URL").ok().filter(|s| !s.is_empty());

        let auth_rate_limit: usize = std::env::var("AUTH_RATE_LIMIT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30); // 30 requests per window

        let auth_rate_window_secs: u64 = std::env::var("AUTH_RATE_WINDOW")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(60); // 60 second window

        let access_token_expiry_secs: u64 = std::env::var("ACCESS_TOKEN_EXPIRY_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3600); // 1 hour

        let refresh_token_expiry_days: i64 = std::env::var("REFRESH_TOKEN_EXPIRY_DAYS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30); // 30 days

        let broadcast_capacity: usize = std::env::var("BROADCAST_CAPACITY")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1024);

        let max_body_size: usize = std::env::var("MAX_BODY_SIZE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1024 * 1024); // 1 MB

        let pg_reconnect_max_backoff_secs: u64 = std::env::var("PG_RECONNECT_MAX_BACKOFF")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30); // 30 seconds

        let enable_sql_endpoint = std::env::var("ENABLE_SQL_ENDPOINT")
            .ok()
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        let allowed_origins = std::env::var("ALLOWED_ORIGINS")
            .ok()
            .filter(|s| !s.is_empty());

        let smtp_from =
            std::env::var("SMTP_FROM").unwrap_or_else(|_| "noreply@pgstack.local".to_string());

        let require_email_verification = std::env::var("REQUIRE_EMAIL_VERIFICATION")
            .ok()
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        let bool_env = |key: &str, def: bool| {
            std::env::var(key)
                .ok()
                .map(|v| v == "true" || v == "1")
                .unwrap_or(def)
        };
        let allow_permissive_cors = bool_env("ALLOW_PERMISSIVE_CORS", false);
        let trusted_proxies = std::env::var("TRUSTED_PROXIES")
            .ok()
            .filter(|s| !s.is_empty());
        let require_authenticated_ws = bool_env("REQUIRE_AUTHENTICATED_WS", false);
        let hsts_preload = bool_env("HSTS_PRELOAD", false);
        let email_enabled = bool_env("EMAIL_ENABLED", true);
        let smtp_host = std::env::var("SMTP_HOST").unwrap_or_default();
        let smtp_user = std::env::var("SMTP_USER").unwrap_or_default();
        let smtp_pass = std::env::var("SMTP_PASS").unwrap_or_default();

        Self {
            database_url,
            admin_database_url,
            pgstack_env,
            listen_addr,
            jwt_secret,
            anon_key,
            service_role_key,
            max_connections,
            google_client_id,
            google_client_secret,
            github_client_id,
            github_client_secret,
            site_url,
            auth_rate_limit,
            auth_rate_window_secs,
            access_token_expiry_secs,
            refresh_token_expiry_days,
            broadcast_capacity,
            max_body_size,
            pg_reconnect_max_backoff_secs,
            enable_sql_endpoint,
            allowed_origins,
            allow_permissive_cors,
            trusted_proxies,
            require_authenticated_ws,
            hsts_preload,
            smtp_from,
            require_email_verification,
            email_enabled,
            smtp_host,
            smtp_user,
            smtp_pass,
        }
    }

    /// Returns placeholder check: a publicly-known dev/example secret value.
    fn is_placeholder_secret(s: &str) -> bool {
        let l = s.to_lowercase();
        [
            "dev-only",
            "change-me",
            "changeme",
            "placeholder",
            "replace-me",
        ]
        .iter()
        .any(|bad| l.contains(bad))
    }

    /// Validate the configuration. Returns a list of problems. In
    /// PGSTACK_ENV=production these are fatal (the caller aborts startup);
    /// otherwise they are warnings. Mirrors the Go proxy's Config.Validate.
    pub fn validate(&self) -> Vec<String> {
        let mut errs = Vec::new();
        if self.pgstack_env != "production" {
            return errs;
        }
        // secrets present, not placeholders, opaque keys long enough
        match &self.jwt_secret {
            None => errs.push("PGSTACK_ENV=production: JWT_SECRET is required".into()),
            Some(s) if Self::is_placeholder_secret(s) => errs.push(
                "PGSTACK_ENV=production: JWT_SECRET is a publicly-known placeholder — generate a real key".into(),
            ),
            _ => {}
        }
        for (name, key) in [
            ("ANON_KEY", &self.anon_key),
            ("SERVICE_ROLE_KEY", &self.service_role_key),
        ] {
            match key {
                None => errs.push(format!("PGSTACK_ENV=production: {name} is required")),
                Some(s) if Self::is_placeholder_secret(s) => errs
                    .push(format!("PGSTACK_ENV=production: {name} is a publicly-known placeholder — generate a real key")),
                Some(s) if s.len() < 32 => errs.push(format!(
                    "PGSTACK_ENV=production: {name} is too short ({} chars, need 32+)",
                    s.len()
                )),
                _ => {}
            }
        }
        if self.enable_sql_endpoint {
            errs.push("PGSTACK_ENV=production: ENABLE_SQL_ENDPOINT=true is unsafe — raw SQL must not be network-reachable".into());
        }
        if self.allow_permissive_cors {
            errs.push("PGSTACK_ENV=production: ALLOW_PERMISSIVE_CORS=true reflects any Origin — set ALLOWED_ORIGINS instead".into());
        }
        if !self.require_authenticated_ws {
            errs.push("PGSTACK_ENV=production: REQUIRE_AUTHENTICATED_WS=false lets anon-key holders open any live-query WS — set it true".into());
        }
        // All three SMTP vars are required when email is enabled — a host alone
        // makes Mailer::from_env fall back to LOGGING the email body (token-bearing
        // reset / magic-link / verification URLs). Mirror Go Config.Validate.
        if self.email_enabled
            && (self.smtp_host.is_empty() || self.smtp_user.is_empty() || self.smtp_pass.is_empty())
        {
            errs.push("PGSTACK_ENV=production: SMTP_HOST, SMTP_USER and SMTP_PASS are required when email is enabled — configure SMTP, or set EMAIL_ENABLED=false for an email-free (e.g. OAuth-only) deployment".into());
        }
        if self.require_email_verification && !self.email_enabled {
            errs.push(
                "REQUIRE_EMAIL_VERIFICATION=true is incompatible with EMAIL_ENABLED=false".into(),
            );
        }
        errs
    }
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("database_url", &"[REDACTED]")
            .field("admin_database_url", &"[REDACTED]")
            .field("pgstack_env", &self.pgstack_env)
            .field("listen_addr", &self.listen_addr)
            .field(
                "jwt_secret",
                &self.jwt_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .field("anon_key", &self.anon_key.as_ref().map(|_| "[REDACTED]"))
            .field(
                "service_role_key",
                &self.service_role_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field("max_connections", &self.max_connections)
            .field("google_client_id", &self.google_client_id)
            .field(
                "google_client_secret",
                &self.google_client_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .field("github_client_id", &self.github_client_id)
            .field(
                "github_client_secret",
                &self.github_client_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .field("site_url", &self.site_url)
            .field("auth_rate_limit", &self.auth_rate_limit)
            .field("auth_rate_window_secs", &self.auth_rate_window_secs)
            .field("access_token_expiry_secs", &self.access_token_expiry_secs)
            .field("refresh_token_expiry_days", &self.refresh_token_expiry_days)
            .field("broadcast_capacity", &self.broadcast_capacity)
            .field("max_body_size", &self.max_body_size)
            .field(
                "pg_reconnect_max_backoff_secs",
                &self.pg_reconnect_max_backoff_secs,
            )
            .field("enable_sql_endpoint", &self.enable_sql_endpoint)
            .field("allowed_origins", &self.allowed_origins)
            .field("smtp_from", &self.smtp_from)
            .field(
                "require_email_verification",
                &self.require_email_verification,
            )
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A production Config that passes validate() with email disabled.
    fn valid_prod() -> Config {
        let key = "x".repeat(40); // ≥32, not a placeholder
        Config {
            database_url: "postgres://a@db/x".into(),
            admin_database_url: "postgres://a@db/x".into(),
            pgstack_env: "production".into(),
            listen_addr: "0.0.0.0:8080".parse().unwrap(),
            jwt_secret: Some(key.clone()),
            anon_key: Some(key.clone()),
            service_role_key: Some(key),
            max_connections: 10000,
            google_client_id: None,
            google_client_secret: None,
            github_client_id: None,
            github_client_secret: None,
            site_url: None,
            auth_rate_limit: 30,
            auth_rate_window_secs: 60,
            access_token_expiry_secs: 3600,
            refresh_token_expiry_days: 30,
            broadcast_capacity: 1024,
            max_body_size: 1024 * 1024,
            pg_reconnect_max_backoff_secs: 30,
            enable_sql_endpoint: false,
            allowed_origins: Some("https://app.example.com".into()),
            allow_permissive_cors: false,
            trusted_proxies: None,
            require_authenticated_ws: true,
            hsts_preload: false,
            smtp_from: "noreply@x".into(),
            require_email_verification: false,
            email_enabled: false,
            smtp_host: String::new(),
            smtp_user: String::new(),
            smtp_pass: String::new(),
        }
    }

    #[test]
    fn prod_baseline_is_clean() {
        assert!(valid_prod().validate().is_empty());
    }

    // Regression (codex P1): EMAIL_ENABLED=true with only SMTP_HOST passed
    // validation, then Mailer::from_env fell back to LOGGING the token-bearing
    // email body. All three SMTP vars must be required.
    #[test]
    fn email_enabled_with_host_only_is_rejected() {
        let mut c = valid_prod();
        c.email_enabled = true;
        c.smtp_host = "smtp.example.com".into(); // user + pass still empty
        let errs = c.validate();
        assert!(
            errs.iter()
                .any(|e| e.contains("SMTP_HOST, SMTP_USER and SMTP_PASS")),
            "host-only SMTP must fail production validation, got: {errs:?}"
        );
    }

    #[test]
    fn email_enabled_with_full_smtp_is_ok() {
        let mut c = valid_prod();
        c.email_enabled = true;
        c.smtp_host = "smtp.example.com".into();
        c.smtp_user = "u".into();
        c.smtp_pass = "p".into();
        assert!(
            !c.validate().iter().any(|e| e.contains("SMTP")),
            "full SMTP config must pass: {:?}",
            c.validate()
        );
    }

    #[test]
    fn email_disabled_needs_no_smtp() {
        let mut c = valid_prod();
        c.email_enabled = false;
        c.smtp_host = String::new();
        assert!(!c.validate().iter().any(|e| e.contains("SMTP")));
    }
}
