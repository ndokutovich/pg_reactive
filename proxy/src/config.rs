use std::net::SocketAddr;

#[derive(Clone, Debug)]
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
        }
    }
}
