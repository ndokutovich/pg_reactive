use std::fmt;
use std::net::SocketAddr;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
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
    /// SMTP_FROM address for outbound email.
    pub smtp_from: String,
    /// When true, users must verify email before logging in.
    pub require_email_verification: bool,
}

impl Config {
    pub fn from_env() -> Self {
        let database_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://postgres:postgres@db:5432/app".into());

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
        let service_role_key = std::env::var("SERVICE_ROLE_KEY").ok().filter(|s| !s.is_empty());

        let max_connections: usize = std::env::var("MAX_CONNECTIONS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(10000);

        let google_client_id = std::env::var("GOOGLE_CLIENT_ID").ok().filter(|s| !s.is_empty());
        let google_client_secret = std::env::var("GOOGLE_CLIENT_SECRET").ok().filter(|s| !s.is_empty());
        let github_client_id = std::env::var("GITHUB_CLIENT_ID").ok().filter(|s| !s.is_empty());
        let github_client_secret = std::env::var("GITHUB_CLIENT_SECRET").ok().filter(|s| !s.is_empty());
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

        let smtp_from = std::env::var("SMTP_FROM")
            .unwrap_or_else(|_| "noreply@pgstack.local".to_string());

        let require_email_verification = std::env::var("REQUIRE_EMAIL_VERIFICATION")
            .ok()
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        Self {
            database_url,
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
            smtp_from,
            require_email_verification,
        }
    }
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("database_url", &"[REDACTED]")
            .field("listen_addr", &self.listen_addr)
            .field("jwt_secret", &self.jwt_secret.as_ref().map(|_| "[REDACTED]"))
            .field("anon_key", &self.anon_key.as_ref().map(|_| "[REDACTED]"))
            .field("service_role_key", &self.service_role_key.as_ref().map(|_| "[REDACTED]"))
            .field("max_connections", &self.max_connections)
            .field("google_client_id", &self.google_client_id)
            .field("google_client_secret", &self.google_client_secret.as_ref().map(|_| "[REDACTED]"))
            .field("github_client_id", &self.github_client_id)
            .field("github_client_secret", &self.github_client_secret.as_ref().map(|_| "[REDACTED]"))
            .field("site_url", &self.site_url)
            .field("auth_rate_limit", &self.auth_rate_limit)
            .field("auth_rate_window_secs", &self.auth_rate_window_secs)
            .field("access_token_expiry_secs", &self.access_token_expiry_secs)
            .field("refresh_token_expiry_days", &self.refresh_token_expiry_days)
            .field("broadcast_capacity", &self.broadcast_capacity)
            .field("max_body_size", &self.max_body_size)
            .field("pg_reconnect_max_backoff_secs", &self.pg_reconnect_max_backoff_secs)
            .field("enable_sql_endpoint", &self.enable_sql_endpoint)
            .field("allowed_origins", &self.allowed_origins)
            .field("smtp_from", &self.smtp_from)
            .field("require_email_verification", &self.require_email_verification)
            .finish()
    }
}
