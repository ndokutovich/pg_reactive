use axum::extract::{Query, State};
use axum::response::{IntoResponse, Redirect};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use crate::auth::routes::{base64_url_encode, generate_token_pair};
use crate::error::AppError;
use crate::state::AppState;

// ---------- Constants ----------

const DEFAULT_SITE_URL: &str = "http://127.0.0.1:3000";

// Google OAuth endpoints
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";

// GitHub OAuth endpoints
const GITHUB_AUTH_URL: &str = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL: &str = "https://api.github.com/user";
const GITHUB_EMAILS_URL: &str = "https://api.github.com/user/emails";

// ---------- Query parameter types ----------

#[derive(Deserialize)]
pub struct AuthorizeParams {
    provider: String,
}

#[derive(Deserialize)]
pub struct CallbackParams {
    code: String,
    state: String,
}

// ---------- Provider response types ----------

#[derive(Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
}

#[derive(Deserialize)]
struct GoogleUserInfo {
    email: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct GitHubTokenResponse {
    access_token: String,
}

#[derive(Deserialize)]
struct GitHubUser {
    email: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct GitHubEmail {
    email: String,
    primary: bool,
    verified: bool,
}

// ---------- Helpers ----------

fn site_url(config: &crate::config::Config) -> String {
    config
        .site_url
        .clone()
        .unwrap_or_else(|| DEFAULT_SITE_URL.to_string())
}

fn error_redirect(site: &str, error: &str, description: &str) -> Redirect {
    let fragment = format!(
        "error={}&error_description={}",
        urlencoding::encode(error),
        urlencoding::encode(description)
    );
    Redirect::temporary(&format!("{}#{}", site, fragment))
}

fn generate_csrf_state() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    let bytes: Vec<u8> = (0..32).map(|_| rng.random()).collect();
    base64_url_encode(&bytes)
}

fn generate_code_verifier() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    let bytes: Vec<u8> = (0..32).map(|_| rng.random()).collect();
    base64_url_encode(&bytes)
}

fn compute_code_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    base64_url_encode(&hash)
}

// ---------- GET /auth/v1/authorize ----------

pub async fn authorize(
    State(state): State<AppState>,
    Query(params): Query<AuthorizeParams>,
) -> Result<impl IntoResponse, AppError> {
    let site = site_url(&state.config);
    let callback_uri = format!("{}/auth/v1/callback", site);
    let csrf_state = generate_csrf_state();
    let code_verifier = generate_code_verifier();
    let code_challenge = compute_code_challenge(&code_verifier);

    // Store session in DB for state validation + PKCE
    sqlx::query(
        "INSERT INTO pgstack.oauth_sessions (state, code_verifier, provider)
         VALUES ($1, $2, $3)",
    )
    .bind(&csrf_state)
    .bind(&code_verifier)
    .bind(&params.provider)
    .execute(&state.pg_pool)
    .await?;

    match params.provider.as_str() {
        "google" => {
            let client_id = state.config.google_client_id.as_ref().ok_or_else(|| {
                AppError::BadRequest("Google OAuth is not configured".into())
            })?;

            let url = format!(
                "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
                GOOGLE_AUTH_URL,
                urlencoding::encode(client_id),
                urlencoding::encode(&callback_uri),
                urlencoding::encode("openid email profile"),
                urlencoding::encode(&csrf_state),
                urlencoding::encode(&code_challenge),
            );

            info!(provider = "google", "OAuth authorize redirect");
            Ok(Redirect::temporary(&url))
        }
        "github" => {
            let client_id = state.config.github_client_id.as_ref().ok_or_else(|| {
                AppError::BadRequest("GitHub OAuth is not configured".into())
            })?;

            let url = format!(
                "{}?client_id={}&redirect_uri={}&scope={}&state={}",
                GITHUB_AUTH_URL,
                urlencoding::encode(client_id),
                urlencoding::encode(&callback_uri),
                urlencoding::encode("user:email"),
                urlencoding::encode(&csrf_state),
            );

            info!(provider = "github", "OAuth authorize redirect");
            Ok(Redirect::temporary(&url))
        }
        other => Err(AppError::BadRequest(format!(
            "unsupported OAuth provider: {}",
            other
        ))),
    }
}

// ---------- GET /auth/v1/callback ----------

pub async fn callback(
    State(state): State<AppState>,
    Query(params): Query<CallbackParams>,
) -> impl IntoResponse {
    let site = site_url(&state.config);

    // Delegate to inner function so we can map errors to redirects
    match callback_inner(&state, &params, &site).await {
        Ok(redirect) => redirect,
        Err(e) => {
            warn!(error = ?e, "OAuth callback failed");
            let description = match e {
                AppError::BadRequest(ref msg)
                | AppError::Unauthorized(ref msg)
                | AppError::Internal(ref msg)
                | AppError::NotFound(ref msg)
                | AppError::Forbidden(ref msg)
                | AppError::Conflict(ref msg)
                | AppError::TooManyRequests(ref msg) => msg.clone(),
            };
            error_redirect(&site, "server_error", &description)
        }
    }
}

async fn callback_inner(
    state: &AppState,
    params: &CallbackParams,
    site: &str,
) -> Result<Redirect, AppError> {
    let secret = state.config.jwt_secret.as_ref().ok_or_else(|| {
        AppError::Internal("JWT_SECRET not configured".into())
    })?;

    // Validate state parameter and retrieve PKCE verifier (one-time use)
    let session = sqlx::query_as::<_, (String, String)>(
        "DELETE FROM pgstack.oauth_sessions
         WHERE state = $1 AND expires_at > now()
         RETURNING code_verifier, provider",
    )
    .bind(&params.state)
    .fetch_optional(&state.pg_pool)
    .await?;

    let (code_verifier, provider) = session.ok_or_else(|| {
        AppError::Unauthorized("invalid or expired OAuth state".into())
    })?;

    // Exchange code for access token and fetch user info
    let (email, name, provider) = match provider.as_str() {
        "google" => exchange_google(state, &params.code, site, Some(&code_verifier)).await?,
        "github" => exchange_github(state, &params.code, site).await?,
        other => {
            return Err(AppError::BadRequest(format!(
                "unsupported provider: {}",
                other
            )))
        }
    };

    let user_meta = serde_json::json!({
        "full_name": name.unwrap_or_default(),
        "provider": provider,
    });

    // Upsert user: insert or update existing
    let row = sqlx::query_as::<_, (String, String, String, String, String)>(
        r#"
        INSERT INTO pgstack.users (email, encrypted_password, provider, providers, raw_user_meta, email_confirmed_at)
        VALUES ($1, NULL, $2, ARRAY[$2]::text[], $3, now())
        ON CONFLICT (email) DO UPDATE
            SET providers = (
                    SELECT array_agg(DISTINCT p)
                    FROM unnest(pgstack.users.providers || ARRAY[$2]::text[]) AS p
                ),
                raw_user_meta = pgstack.users.raw_user_meta || $3,
                updated_at = now(),
                email_confirmed_at = COALESCE(pgstack.users.email_confirmed_at, now())
        RETURNING id::text, email, role, created_at::text, updated_at::text
        "#,
    )
    .bind(&email)
    .bind(&provider)
    .bind(&user_meta)
    .fetch_one(&state.pg_pool)
    .await?;

    let (user_id, user_email, role, _created_at, _updated_at) = row;

    // Generate token pair
    let (access_token, refresh_token) =
        generate_token_pair(state, secret, &user_id, &user_email, &role, None).await?;

    // Redirect with tokens in fragment (Supabase-compatible)
    let fragment = format!(
        "access_token={}&refresh_token={}&token_type=bearer&expires_in=3600",
        urlencoding::encode(&access_token),
        urlencoding::encode(&refresh_token),
    );

    info!(
        provider = %provider,
        email = %user_email,
        "OAuth login successful"
    );

    Ok(Redirect::temporary(&format!("{}#{}", site, fragment)))
}

// ---------- Google exchange ----------

async fn exchange_google(
    state: &AppState,
    code: &str,
    site: &str,
    code_verifier: Option<&str>,
) -> Result<(String, Option<String>, String), AppError> {
    let client_id = state.config.google_client_id.as_ref().ok_or_else(|| {
        AppError::Internal("GOOGLE_CLIENT_ID not configured".into())
    })?;
    let client_secret = state.config.google_client_secret.as_ref().ok_or_else(|| {
        AppError::Internal("GOOGLE_CLIENT_SECRET not configured".into())
    })?;

    let callback_uri = format!("{}/auth/v1/callback", site);

    let http = reqwest::Client::new();

    // Exchange code for access token (with PKCE code_verifier)
    let mut form_params = vec![
        ("code", code),
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("redirect_uri", callback_uri.as_str()),
        ("grant_type", "authorization_code"),
    ];
    let verifier_owned;
    if let Some(v) = code_verifier {
        verifier_owned = v.to_string();
        form_params.push(("code_verifier", verifier_owned.as_str()));
    }

    let token_resp = http
        .post(GOOGLE_TOKEN_URL)
        .form(&form_params)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Google token exchange failed: {}", e)))?;

    if !token_resp.status().is_success() {
        let body = token_resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Google token exchange returned error: {}",
            body
        )));
    }

    let token_data: GoogleTokenResponse = token_resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Google token parse failed: {}", e)))?;

    // Fetch user info
    let userinfo_resp = http
        .get(GOOGLE_USERINFO_URL)
        .bearer_auth(&token_data.access_token)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Google userinfo fetch failed: {}", e)))?;

    if !userinfo_resp.status().is_success() {
        let body = userinfo_resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Google userinfo returned error: {}",
            body
        )));
    }

    let user_info: GoogleUserInfo = userinfo_resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Google userinfo parse failed: {}", e)))?;

    Ok((user_info.email, user_info.name, "google".to_string()))
}

// ---------- GitHub exchange ----------

async fn exchange_github(
    state: &AppState,
    code: &str,
    site: &str,
) -> Result<(String, Option<String>, String), AppError> {
    let client_id = state.config.github_client_id.as_ref().ok_or_else(|| {
        AppError::Internal("GITHUB_CLIENT_ID not configured".into())
    })?;
    let client_secret = state.config.github_client_secret.as_ref().ok_or_else(|| {
        AppError::Internal("GITHUB_CLIENT_SECRET not configured".into())
    })?;

    let callback_uri = format!("{}/auth/v1/callback", site);

    let http = reqwest::Client::new();

    // Exchange code for access token
    let token_resp = http
        .post(GITHUB_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("code", code),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri", callback_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("GitHub token exchange failed: {}", e)))?;

    if !token_resp.status().is_success() {
        let body = token_resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "GitHub token exchange returned error: {}",
            body
        )));
    }

    let token_data: GitHubTokenResponse = token_resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("GitHub token parse failed: {}", e)))?;

    // Fetch user profile
    let user_resp = http
        .get(GITHUB_USER_URL)
        .header("User-Agent", "pgstack-proxy")
        .bearer_auth(&token_data.access_token)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("GitHub user fetch failed: {}", e)))?;

    if !user_resp.status().is_success() {
        let body = user_resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "GitHub user API returned error: {}",
            body
        )));
    }

    let github_user: GitHubUser = user_resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("GitHub user parse failed: {}", e)))?;

    // GitHub may not include email in the user profile if it's private.
    // In that case, fetch from the emails endpoint.
    let email = if let Some(email) = github_user.email {
        email
    } else {
        let emails_resp = http
            .get(GITHUB_EMAILS_URL)
            .header("User-Agent", "pgstack-proxy")
            .bearer_auth(&token_data.access_token)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("GitHub emails fetch failed: {}", e)))?;

        if !emails_resp.status().is_success() {
            let body = emails_resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "GitHub emails API returned error: {}",
                body
            )));
        }

        let emails: Vec<GitHubEmail> = emails_resp
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("GitHub emails parse failed: {}", e)))?;

        // Prefer primary + verified email
        emails
            .iter()
            .find(|e| e.primary && e.verified)
            .or_else(|| emails.iter().find(|e| e.verified))
            .or_else(|| emails.first())
            .map(|e| e.email.clone())
            .ok_or_else(|| {
                AppError::Internal("no email found on GitHub account".into())
            })?
    };

    Ok((email, github_user.name, "github".to_string()))
}
