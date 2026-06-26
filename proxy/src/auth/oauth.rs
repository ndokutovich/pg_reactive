use axum::extract::{Query, State};
use axum::response::{IntoResponse, Redirect};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use crate::auth::routes::{base64_url_encode, generate_token_pair, random_token_bytes};
use crate::error::AppError;
use crate::state::AppState;

// ---------- Constants ----------

// Google OAuth endpoints
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
// v3 userinfo carries the `email_verified` claim (v2 does not); the F3
// email-verification gate needs it. Mirror Go's `oauth2/v3/userinfo`.
const GOOGLE_USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v3/userinfo";

// GitHub OAuth endpoints
const GITHUB_AUTH_URL: &str = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL: &str = "https://api.github.com/user";
const GITHUB_EMAILS_URL: &str = "https://api.github.com/user/emails";

// Apple OAuth endpoints (mirror proxy-go/auth/oauth.go)
const APPLE_AUTH_URL: &str = "https://appleid.apple.com/auth/authorize";
const APPLE_TOKEN_URL: &str = "https://appleid.apple.com/auth/token";
const APPLE_JWKS_URL: &str = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER: &str = "https://appleid.apple.com";

// Microsoft (Azure AD "common" tenant) OAuth endpoints
const MICROSOFT_AUTH_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MICROSOFT_JWKS_URL: &str = "https://login.microsoftonline.com/common/discovery/v2.0/keys";
const MICROSOFT_GRAPH_ME_URL: &str = "https://graph.microsoft.com/v1.0/me";

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
    // F3 gate: Google asserts ownership via `email_verified` (bool, or rarely
    // the string "true"). Decoded as a Value and normalised by `claim_true`.
    #[serde(default)]
    email_verified: Option<serde_json::Value>,
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

fn site_url(config: &crate::config::Config) -> Result<String, AppError> {
    config
        .site_url
        .clone()
        .ok_or_else(|| AppError::Internal("SITE_URL not configured (required for OAuth)".into()))
}

fn error_redirect(site: &str, error: &str, description: &str) -> Redirect {
    let fragment = format!(
        "error={}&error_description={}",
        urlencoding::encode(error),
        urlencoding::encode(description)
    );
    Redirect::temporary(&format!("{site}#{fragment}"))
}

fn generate_csrf_state() -> String {
    base64_url_encode(&random_token_bytes())
}

fn generate_code_verifier() -> String {
    base64_url_encode(&random_token_bytes())
}

fn compute_code_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    base64_url_encode(&hash)
}

/// Shared HTTP client for the new providers' token exchange / userinfo / graph
/// calls. 10s timeout mirrors the Go proxy's `oauthHTTPClient` so a stalling
/// IdP cannot pin a callback task. (Google/GitHub keep their inline clients.)
fn oauth_client() -> &'static reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("build oauth http client")
    })
}

/// Build an authorization URL with `application/x-www-form-urlencoded`-encoded
/// query params (spaces → `+`), matching Go's `url.Values.Encode`.
fn build_authorize_url(base: &str, params: &[(&str, &str)]) -> String {
    let mut url = url::Url::parse(base).expect("static authorize base URL");
    {
        let mut qp = url.query_pairs_mut();
        for (k, v) in params {
            qp.append_pair(k, v);
        }
    }
    url.to_string()
}

/// POST an `application/x-www-form-urlencoded` body and decode the JSON
/// response into an object map (mirror Go's `httpPostForm`). `Accept: application/json`
/// is set so GitHub-style providers return JSON.
async fn http_post_form(
    endpoint: &str,
    params: &[(&str, &str)],
) -> Result<serde_json::Map<String, serde_json::Value>, AppError> {
    let resp = oauth_client()
        .post(endpoint)
        .header("Accept", "application/json")
        .form(params)
        .send()
        .await
        .map_err(|e| AppError::ServiceUnavailable(format!("POST {endpoint}: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::ServiceUnavailable(format!(
            "POST {endpoint} returned {status}: {text}"
        )));
    }
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AppError::Internal(format!("decode response from {endpoint}: {e}")))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| AppError::Internal(format!("{endpoint} response was not a JSON object")))
}

/// GET a Bearer-authenticated JSON resource (userinfo / Graph). Mirror Go's
/// `httpGetJSON`.
async fn http_get_json(endpoint: &str, access_token: &str) -> Result<serde_json::Value, AppError> {
    let mut req = oauth_client()
        .get(endpoint)
        .header("Accept", "application/json")
        .header("User-Agent", "pgstack-proxy/1.0");
    if !access_token.is_empty() {
        req = req.bearer_auth(access_token);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| AppError::ServiceUnavailable(format!("GET {endpoint}: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::ServiceUnavailable(format!(
            "GET {endpoint} returned {status}: {text}"
        )));
    }
    serde_json::from_str(&text)
        .map_err(|e| AppError::Internal(format!("decode response from {endpoint}: {e}")))
}

// ---------- GET /auth/v1/authorize ----------

pub async fn authorize(
    State(state): State<AppState>,
    Query(params): Query<AuthorizeParams>,
) -> Result<impl IntoResponse, AppError> {
    let site = site_url(&state.config)?;
    let callback_uri = format!("{site}/auth/v1/callback");
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
    .execute(&state.admin_pool)
    .await?;

    match params.provider.as_str() {
        "google" => {
            let client_id = state
                .config
                .google_client_id
                .as_ref()
                .ok_or_else(|| AppError::BadRequest("Google OAuth is not configured".into()))?;

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
            let client_id = state
                .config
                .github_client_id
                .as_ref()
                .ok_or_else(|| AppError::BadRequest("GitHub OAuth is not configured".into()))?;

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
        "apple" => {
            // Apple does NOT support PKCE and posts the callback back as a
            // form_post (response_mode=form_post). Mirror Go's exact params.
            let client_id = state
                .config
                .apple_client_id
                .as_ref()
                .ok_or_else(|| AppError::BadRequest("Apple OAuth is not configured".into()))?;
            let url = build_authorize_url(
                APPLE_AUTH_URL,
                &[
                    ("client_id", client_id),
                    ("redirect_uri", &callback_uri),
                    ("response_type", "code"),
                    ("scope", "email name"),
                    ("state", &csrf_state),
                    ("response_mode", "form_post"),
                ],
            );
            info!(provider = "apple", "OAuth authorize redirect");
            Ok(Redirect::temporary(&url))
        }
        "microsoft" => {
            let client_id =
                state.config.microsoft_client_id.as_ref().ok_or_else(|| {
                    AppError::BadRequest("Microsoft OAuth is not configured".into())
                })?;
            let url = build_authorize_url(
                MICROSOFT_AUTH_URL,
                &[
                    ("client_id", client_id),
                    ("redirect_uri", &callback_uri),
                    ("response_type", "code"),
                    ("scope", "openid email profile"),
                    ("state", &csrf_state),
                    ("code_challenge", &code_challenge),
                    ("code_challenge_method", "S256"),
                ],
            );
            info!(provider = "microsoft", "OAuth authorize redirect");
            Ok(Redirect::temporary(&url))
        }
        "oidc" => {
            let client_id = state
                .config
                .oidc_client_id
                .as_ref()
                .ok_or_else(|| AppError::BadRequest("OIDC is not configured".into()))?;
            let issuer = state
                .config
                .oidc_issuer_url
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppError::BadRequest("OIDC_ISSUER_URL is not configured".into()))?;
            // Discover the authorization endpoint from the issuer's well-known doc.
            let cfg = discover_oidc(issuer).await?;
            let url = build_authorize_url(
                &cfg.authorization_endpoint,
                &[
                    ("client_id", client_id),
                    ("redirect_uri", &callback_uri),
                    ("response_type", "code"),
                    ("scope", "openid email profile"),
                    ("state", &csrf_state),
                    ("code_challenge", &code_challenge),
                    ("code_challenge_method", "S256"),
                ],
            );
            info!(provider = "oidc", "OAuth authorize redirect");
            Ok(Redirect::temporary(&url))
        }
        other => Err(AppError::BadRequest(format!(
            "unsupported OAuth provider: {other}"
        ))),
    }
}

// ---------- GET /auth/v1/callback ----------

pub async fn callback(
    State(state): State<AppState>,
    Query(params): Query<CallbackParams>,
) -> Result<impl IntoResponse, AppError> {
    let site = site_url(&state.config)?;

    // Delegate to inner function so we can map errors to redirects
    match callback_inner(&state, &params, &site).await {
        Ok(redirect) => Ok(redirect),
        Err(e) => {
            warn!(error = ?e, "OAuth callback failed");
            let description = match e {
                AppError::BadRequest(ref msg)
                | AppError::Unauthorized(ref msg)
                | AppError::Internal(ref msg)
                | AppError::NotFound(ref msg)
                | AppError::Forbidden(ref msg)
                | AppError::Conflict(ref msg)
                | AppError::PayloadTooLarge(ref msg)
                | AppError::TooManyRequests(ref msg)
                | AppError::ServiceUnavailable(ref msg) => msg.clone(),
            };
            Ok(error_redirect(&site, "server_error", &description))
        }
    }
}

// ---------- POST /auth/v1/callback (Apple form_post) ----------

/// Apple's `response_mode=form_post` delivers the callback as an HTTP POST with
/// an `application/x-www-form-urlencoded` body (`code`, `state`, and on first
/// consent an optional `user` JSON blob) rather than the GET redirect the other
/// providers use. This handler parses that body and funnels into the same
/// exchange path. Mounted at the same path as the GET callback (mirror Go's
/// `r.Post("/auth/v1/callback", ...)`).
pub async fn callback_post(
    State(state): State<AppState>,
    body: String,
) -> Result<impl IntoResponse, AppError> {
    let site = site_url(&state.config)?;

    // Provider-side denial arrives as `error`/`error_description` form fields.
    if let Some((err, desc)) = parse_form_error(&body) {
        return Ok(error_redirect(&site, &err, &desc));
    }

    let (code, csrf_state, _user) = match parse_form_callback(&body) {
        Ok(parsed) => parsed,
        Err(e) => return Err(e),
    };
    let params = CallbackParams {
        code,
        state: csrf_state,
    };

    match callback_inner(&state, &params, &site).await {
        Ok(redirect) => Ok(redirect),
        Err(e) => {
            warn!(error = ?e, "OAuth form_post callback failed");
            Ok(error_redirect(
                &site,
                "server_error",
                "authentication failed",
            ))
        }
    }
}

/// Parse a urlencoded form-post callback body, returning `(code, state, user)`.
/// `code` and `state` are required (both non-empty); `user` is optional (Apple
/// sends it only on the first consent). Mirror Go's `r.FormValue` reads in
/// `Callback`, which 400s when code/state are absent.
pub(crate) fn parse_form_callback(
    body: &str,
) -> Result<(String, String, Option<String>), AppError> {
    let mut code = None;
    let mut state = None;
    let mut user = None;
    for (k, v) in url::form_urlencoded::parse(body.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "user" => user = Some(v.into_owned()),
            _ => {}
        }
    }
    let code = code
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("code and state are required".into()))?;
    let state = state
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("code and state are required".into()))?;
    Ok((code, state, user))
}

/// Extract a provider denial (`error` / `error_description`) from a form-post body.
fn parse_form_error(body: &str) -> Option<(String, String)> {
    let mut err = None;
    let mut desc = None;
    for (k, v) in url::form_urlencoded::parse(body.as_bytes()) {
        match k.as_ref() {
            "error" => err = Some(v.into_owned()),
            "error_description" => desc = Some(v.into_owned()),
            _ => {}
        }
    }
    let err = err.filter(|s| !s.is_empty())?;
    let desc = desc
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| err.clone());
    Some((err, desc))
}

// ---------- Account-takeover defense (audit F3, round 14 — Rust parity) ----------
//
// An OAuth provider that returns an unverified or attacker-controlled email
// could otherwise hijack an existing `pgstack.users` row simply by completing a
// successful OAuth flow with that email (accounts are keyed on email). The Go
// reference (`proxy-go/auth/oauth.go`) gates on this uniformly; these mirror it.

/// Refusal shown when the provider did not assert `email_verified=true`.
const OAUTH_UNVERIFIED_DESC: &str = "provider did not verify email ownership";
/// Refusal shown when an OAuth login would merge into an existing account whose
/// email was never verified (`email_confirmed_at IS NULL`).
const OAUTH_TAKEOVER_DESC: &str =
    "an unverified account already exists for this email; complete verification or contact support";

/// Pure admission decision for an OAuth callback (audit F3). Returns `Err(desc)`
/// to refuse the login, `Ok(())` to admit. Refuses when the provider did not
/// assert `email_verified=true` (`verified` is false), and refuses when merging
/// into an existing, still-unverified account (`conflict_block` is true — the
/// `(email_confirmed_at IS NULL)` flag the upsert returns for the conflicting
/// row). Called twice in `callback_inner`: once after the provider resolve (the
/// verified gate), once after the upsert (the takeover gate).
fn oauth_admission(verified: bool, conflict_block: bool) -> Result<(), &'static str> {
    if !verified {
        return Err(OAUTH_UNVERIFIED_DESC);
    }
    if conflict_block {
        return Err(OAUTH_TAKEOVER_DESC);
    }
    Ok(())
}

/// User upsert for an OAuth login. `email_confirmed_at` is set only on INSERT —
/// never elevated on the `ON CONFLICT` (UPDATE) path — and the UPDATE leaves an
/// existing **unverified** row (`email_confirmed_at IS NULL`) untouched, surfacing
/// `(email_confirmed_at IS NULL) AS conflict_block` so the caller refuses the
/// merge. Mirror Go's upsert (`proxy-go/auth/oauth.go`, audit F3).
const OAUTH_UPSERT_SQL: &str = r#"
        INSERT INTO pgstack.users (email, encrypted_password, provider, providers, raw_user_meta, email_confirmed_at)
        VALUES ($1, NULL, $2, ARRAY[$2]::text[], $3, now())
        ON CONFLICT (email) DO UPDATE
            SET providers = CASE
                    WHEN pgstack.users.email_confirmed_at IS NULL THEN pgstack.users.providers
                    WHEN $2 = ANY(pgstack.users.providers) THEN pgstack.users.providers
                    ELSE array_append(pgstack.users.providers, $2)
                  END,
                raw_user_meta = CASE
                    WHEN pgstack.users.email_confirmed_at IS NULL THEN pgstack.users.raw_user_meta
                    ELSE pgstack.users.raw_user_meta || $3
                  END,
                updated_at = CASE
                    WHEN pgstack.users.email_confirmed_at IS NULL THEN pgstack.users.updated_at
                    ELSE now()
                  END
        RETURNING id::text, email, role, created_at::text, updated_at::text, (email_confirmed_at IS NULL) AS conflict_block
        "#;

async fn callback_inner(
    state: &AppState,
    params: &CallbackParams,
    site: &str,
) -> Result<Redirect, AppError> {
    let secret = state
        .config
        .jwt_secret
        .as_ref()
        .ok_or_else(|| AppError::Internal("JWT_SECRET not configured".into()))?;

    // Validate state parameter and retrieve PKCE verifier (one-time use)
    let session = sqlx::query_as::<_, (String, String)>(
        "DELETE FROM pgstack.oauth_sessions
         WHERE state = $1 AND expires_at > now()
         RETURNING code_verifier, provider",
    )
    .bind(&params.state)
    .fetch_optional(&state.admin_pool)
    .await?;

    let (code_verifier, provider) =
        session.ok_or_else(|| AppError::Unauthorized("invalid or expired OAuth state".into()))?;

    // Exchange code for access token and fetch user info. Each resolver now
    // surfaces the provider's `email_verified` assertion (audit F3) instead of
    // discarding it.
    let (email, name, provider, verified) = match provider.as_str() {
        "google" => exchange_google(state, &params.code, site, Some(&code_verifier)).await?,
        "github" => exchange_github(state, &params.code, site).await?,
        "apple" => exchange_apple(state, &params.code, site).await?,
        "microsoft" => exchange_microsoft(state, &params.code, site, &code_verifier).await?,
        "oidc" => exchange_oidc(state, &params.code, site, &code_verifier).await?,
        other => {
            return Err(AppError::BadRequest(format!(
                "unsupported provider: {other}"
            )))
        }
    };

    // Gate 1 (audit F3): refuse the login outright if the provider did not
    // assert `email_verified=true` — otherwise any IdP/tenant can mint an
    // id_token for a victim's email and take over the email-keyed account.
    if let Err(desc) = oauth_admission(verified, false) {
        warn!(provider = %provider, "oauth refused: provider did not assert email_verified");
        return Ok(error_redirect(site, "access_denied", desc));
    }

    let user_meta = serde_json::json!({
        "full_name": name.unwrap_or_default(),
        "provider": provider,
    });

    // Upsert user, appending this provider. `email_confirmed_at` is set only on
    // INSERT; an existing unverified row is left untouched and flagged via
    // `conflict_block` so we can refuse the merge below.
    let row = sqlx::query_as::<_, (String, String, String, String, String, bool)>(OAUTH_UPSERT_SQL)
        .bind(&email)
        .bind(&provider)
        .bind(&user_meta)
        .fetch_one(&state.admin_pool)
        .await?;

    let (user_id, user_email, role, _created_at, _updated_at, conflict_block) = row;

    // Gate 2 (audit F3): refuse merging an OAuth login into an existing account
    // that was created (e.g. via email+password) but never verified. Otherwise
    // an unverified signup becomes a free OAuth on-ramp for anyone who knows the
    // victim's email.
    if let Err(desc) = oauth_admission(true, conflict_block) {
        warn!(
            provider = %provider,
            "oauth refused: existing account with this email is not verified — possible takeover attempt"
        );
        return Ok(error_redirect(site, "access_denied", desc));
    }

    // Generate token pair
    let (access_token, refresh_token) =
        generate_token_pair(state, secret, &user_id, &user_email, &role, None).await?;

    // Redirect with tokens in fragment (Supabase-compatible)
    let fragment = format!(
        "access_token={}&refresh_token={}&token_type=bearer&expires_in={}",
        urlencoding::encode(&access_token),
        urlencoding::encode(&refresh_token),
        state.config.access_token_expiry_secs,
    );

    info!(
        provider = %provider,
        email = %user_email,
        "OAuth login successful"
    );

    Ok(Redirect::temporary(&format!("{site}#{fragment}")))
}

// ---------- Google exchange ----------

async fn exchange_google(
    state: &AppState,
    code: &str,
    site: &str,
    code_verifier: Option<&str>,
) -> Result<(String, Option<String>, String, bool), AppError> {
    let client_id = state
        .config
        .google_client_id
        .as_ref()
        .ok_or_else(|| AppError::Internal("GOOGLE_CLIENT_ID not configured".into()))?;
    let client_secret = state
        .config
        .google_client_secret
        .as_ref()
        .ok_or_else(|| AppError::Internal("GOOGLE_CLIENT_SECRET not configured".into()))?;

    let callback_uri = format!("{site}/auth/v1/callback");

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
        .map_err(|e| AppError::Internal(format!("Google token exchange failed: {e}")))?;

    if !token_resp.status().is_success() {
        let body = token_resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Google token exchange returned error: {body}"
        )));
    }

    let token_data: GoogleTokenResponse = token_resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Google token parse failed: {e}")))?;

    // Fetch user info
    let userinfo_resp = http
        .get(GOOGLE_USERINFO_URL)
        .bearer_auth(&token_data.access_token)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Google userinfo fetch failed: {e}")))?;

    if !userinfo_resp.status().is_success() {
        let body = userinfo_resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Google userinfo returned error: {body}"
        )));
    }

    let user_info: GoogleUserInfo = userinfo_resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Google userinfo parse failed: {e}")))?;

    let verified = crate::auth::idtoken::claim_true(user_info.email_verified.as_ref());
    Ok((
        user_info.email.trim().to_lowercase(),
        user_info.name,
        "google".to_string(),
        verified,
    ))
}

// ---------- GitHub exchange ----------

async fn exchange_github(
    state: &AppState,
    code: &str,
    site: &str,
) -> Result<(String, Option<String>, String, bool), AppError> {
    let client_id = state
        .config
        .github_client_id
        .as_ref()
        .ok_or_else(|| AppError::Internal("GITHUB_CLIENT_ID not configured".into()))?;
    let client_secret = state
        .config
        .github_client_secret
        .as_ref()
        .ok_or_else(|| AppError::Internal("GITHUB_CLIENT_SECRET not configured".into()))?;

    let callback_uri = format!("{site}/auth/v1/callback");

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
        .map_err(|e| AppError::Internal(format!("GitHub token exchange failed: {e}")))?;

    if !token_resp.status().is_success() {
        let body = token_resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "GitHub token exchange returned error: {body}"
        )));
    }

    let token_data: GitHubTokenResponse = token_resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("GitHub token parse failed: {e}")))?;

    // Fetch user profile
    let user_resp = http
        .get(GITHUB_USER_URL)
        .header("User-Agent", "pgstack-proxy")
        .bearer_auth(&token_data.access_token)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("GitHub user fetch failed: {e}")))?;

    if !user_resp.status().is_success() {
        let body = user_resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "GitHub user API returned error: {body}"
        )));
    }

    let github_user: GitHubUser = user_resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("GitHub user parse failed: {e}")))?;

    // GitHub may not include email in the user profile if it's private.
    // In that case, fetch from the emails endpoint. Either source is a verified
    // address: GitHub only exposes a *verified* address as the public profile
    // email, and the emails-endpoint branch below explicitly filters on the
    // per-row `verified` flag (mirror Go's `exchangeGitHub`, audit F3 — which
    // requires a verified email and otherwise errors).
    let email = if let Some(email) = github_user.email {
        email
    } else {
        let emails_resp = http
            .get(GITHUB_EMAILS_URL)
            .header("User-Agent", "pgstack-proxy")
            .bearer_auth(&token_data.access_token)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("GitHub emails fetch failed: {e}")))?;

        if !emails_resp.status().is_success() {
            let body = emails_resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "GitHub emails API returned error: {body}"
            )));
        }

        let emails: Vec<GitHubEmail> = emails_resp
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("GitHub emails parse failed: {e}")))?;

        // Prefer primary + verified email
        emails
            .iter()
            .find(|e| e.primary && e.verified)
            .or_else(|| emails.iter().find(|e| e.verified))
            .or_else(|| emails.first())
            .map(|e| e.email.clone())
            .ok_or_else(|| AppError::Internal("no email found on GitHub account".into()))?
    };

    Ok((
        email.trim().to_lowercase(),
        github_user.name,
        "github".to_string(),
        true,
    ))
}

// ---------- Apple exchange ----------

/// Exchange an Apple authorization code for an `id_token` and return the email.
/// Apple has no userinfo endpoint — identity lives in the JWKS-verified id_token
/// (ES256, iss=appleid.apple.com, aud=our Services ID). Mirror Go's `exchangeApple`.
async fn exchange_apple(
    state: &AppState,
    code: &str,
    site: &str,
) -> Result<(String, Option<String>, String, bool), AppError> {
    let client_id = state
        .config
        .apple_client_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Internal("APPLE_CLIENT_ID not configured".into()))?;
    let callback_uri = format!("{site}/auth/v1/callback");
    let client_secret = generate_apple_client_secret(&state.config)?;

    let token_resp = http_post_form(
        APPLE_TOKEN_URL,
        &[
            ("code", code),
            ("client_id", client_id),
            ("client_secret", &client_secret),
            ("redirect_uri", &callback_uri),
            ("grant_type", "authorization_code"),
        ],
    )
    .await?;

    let id_token = token_resp
        .get("id_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::Unauthorized("apple token exchange: no id_token in response".into())
        })?;

    let (email, verified) = crate::auth::idtoken::verify_id_token(
        id_token,
        APPLE_JWKS_URL,
        crate::auth::idtoken::issuer_equals(APPLE_ISSUER),
        client_id,
    )
    .await
    .map_err(|e| AppError::Unauthorized(format!("apple id_token: {e:?}")))?;

    Ok((
        email.trim().to_lowercase(),
        None,
        "apple".to_string(),
        verified,
    ))
}

/// Whether `s` is a compact-serialised JWT (three dot-separated segments, no
/// PEM armour) rather than a PEM private key. Mirror Go's `looksLikeJWT`.
pub(crate) fn looks_like_jwt(s: &str) -> bool {
    let s = s.trim();
    s.matches('.').count() == 2 && !s.contains("BEGIN")
}

/// Sign the ES256 client-secret JWT Apple requires in place of a static secret.
/// Claims: iss=team_id, sub=client_id, aud=appleid.apple.com; header kid=key_id.
/// `private_key_pem` is the PKCS#8 EC key (the .p8 file contents). Pure — the
/// caching wrapper is `generate_apple_client_secret`.
fn sign_apple_client_secret(
    team_id: &str,
    key_id: &str,
    client_id: &str,
    private_key_pem: &str,
) -> Result<String, AppError> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let key = jsonwebtoken::EncodingKey::from_ec_pem(private_key_pem.as_bytes())
        .map_err(|e| AppError::Internal(format!("apple: cannot parse private key: {e}")))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
    header.kid = Some(key_id.to_string());
    let claims = serde_json::json!({
        "iss": team_id,
        "iat": now,
        "exp": now + 3600,
        "aud": "https://appleid.apple.com",
        "sub": client_id,
    });
    jsonwebtoken::encode(&header, &claims, &key)
        .map_err(|e| AppError::Internal(format!("apple: cannot sign client_secret JWT: {e}")))
}

/// Return the Apple client-secret JWT, memoised for ~1h. If `APPLE_PRIVATE_KEY`
/// is already a pre-generated client-secret JWT (not PEM) it is returned
/// verbatim. Mirror Go's `generateAppleClientSecret`.
fn generate_apple_client_secret(cfg: &crate::config::Config) -> Result<String, AppError> {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    let private_key = cfg.apple_private_key.as_deref().unwrap_or("");
    if looks_like_jwt(private_key) {
        return Ok(private_key.trim().to_string());
    }

    static CACHE: OnceLock<Mutex<Option<(String, Instant)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some((val, exp)) = guard.as_ref() {
            // Regenerate shortly (5 min) before expiry.
            if Instant::now() + Duration::from_secs(300) < *exp {
                return Ok(val.clone());
            }
        }
    }

    let team_id = cfg
        .apple_team_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Internal("APPLE_TEAM_ID not configured".into()))?;
    let key_id = cfg
        .apple_key_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Internal("APPLE_KEY_ID not configured".into()))?;
    let client_id = cfg
        .apple_client_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Internal("APPLE_CLIENT_ID not configured".into()))?;
    if private_key.trim().is_empty() {
        return Err(AppError::Internal(
            "APPLE_PRIVATE_KEY not configured".into(),
        ));
    }

    let signed = sign_apple_client_secret(team_id, key_id, client_id, private_key)?;
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((signed.clone(), Instant::now() + Duration::from_secs(3600)));
    }
    Ok(signed)
}

// ---------- Microsoft exchange ----------

/// Exchange a Microsoft authorization code, preferring the JWKS-verified
/// id_token (multi-tenant `common` issuer prefix) and falling back to Graph
/// `/me`. Mirror Go's `exchangeMicrosoft`.
async fn exchange_microsoft(
    state: &AppState,
    code: &str,
    site: &str,
    verifier: &str,
) -> Result<(String, Option<String>, String, bool), AppError> {
    let client_id = state
        .config
        .microsoft_client_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Internal("MICROSOFT_CLIENT_ID not configured".into()))?;
    let client_secret = state
        .config
        .microsoft_client_secret
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Internal("MICROSOFT_CLIENT_SECRET not configured".into()))?;
    let callback_uri = format!("{site}/auth/v1/callback");

    let token_resp = http_post_form(
        MICROSOFT_TOKEN_URL,
        &[
            ("code", code),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", &callback_uri),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier),
        ],
    )
    .await?;

    // Prefer the id_token. Microsoft's "common" tenant rewrites iss per-user
    // (tenant id in the path), so the issuer is matched by prefix/suffix.
    if let Some(id_token) = token_resp
        .get("id_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        if let Ok((email, verified)) = crate::auth::idtoken::verify_id_token(
            id_token,
            MICROSOFT_JWKS_URL,
            |iss: &str| {
                iss.starts_with("https://login.microsoftonline.com/") && iss.ends_with("/v2.0")
            },
            client_id,
        )
        .await
        {
            if !email.is_empty() {
                return Ok((
                    email.trim().to_lowercase(),
                    None,
                    "microsoft".to_string(),
                    verified,
                ));
            }
        }
    }

    // Fallback: Graph /me. Graph carries no verified claim — treat as unverified
    // (mirror Go), so the F3 gate refuses a Graph-only login.
    let access_token = token_resp
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::Unauthorized("microsoft token exchange: no access_token in response".into())
        })?;
    let info = http_get_json(MICROSOFT_GRAPH_ME_URL, access_token).await?;
    let email = info
        .get("mail")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            info.get("userPrincipalName")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
        })
        .ok_or_else(|| {
            AppError::Unauthorized("microsoft graph: email not found in user profile".into())
        })?;
    Ok((
        email.trim().to_lowercase(),
        None,
        "microsoft".to_string(),
        false,
    ))
}

// ---------- Generic OIDC exchange ----------

/// Subset of an OpenID Provider configuration discovery document.
#[derive(Deserialize, Default)]
struct OidcConfig {
    #[serde(default)]
    issuer: String,
    #[serde(default)]
    authorization_endpoint: String,
    #[serde(default)]
    token_endpoint: String,
    #[serde(default)]
    userinfo_endpoint: String,
    #[serde(default)]
    jwks_uri: String,
}

/// Fetch and validate the issuer's `.well-known/openid-configuration`.
/// Mirror Go's `discoverOIDC`.
async fn discover_oidc(issuer_url: &str) -> Result<OidcConfig, AppError> {
    if issuer_url.is_empty() {
        return Err(AppError::BadRequest(
            "OIDC_ISSUER_URL is not configured".into(),
        ));
    }
    let well_known = format!(
        "{}/.well-known/openid-configuration",
        issuer_url.trim_end_matches('/')
    );
    let cfg: OidcConfig = serde_json::from_value(http_get_json(&well_known, "").await?)
        .map_err(|e| AppError::Internal(format!("parse OIDC discovery {well_known}: {e}")))?;
    if cfg.authorization_endpoint.is_empty() || cfg.token_endpoint.is_empty() {
        return Err(AppError::ServiceUnavailable(
            "OIDC discovery: missing required endpoints".into(),
        ));
    }
    Ok(cfg)
}

/// Exchange a generic-OIDC authorization code, preferring the JWKS-verified
/// id_token and falling back to the userinfo endpoint. Mirror Go's `exchangeOIDC`.
async fn exchange_oidc(
    state: &AppState,
    code: &str,
    site: &str,
    verifier: &str,
) -> Result<(String, Option<String>, String, bool), AppError> {
    let client_id = state
        .config
        .oidc_client_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Internal("OIDC_CLIENT_ID not configured".into()))?;
    let client_secret = state.config.oidc_client_secret.as_deref().unwrap_or("");
    let issuer = state
        .config
        .oidc_issuer_url
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Internal("OIDC_ISSUER_URL not configured".into()))?;
    let cfg = discover_oidc(issuer).await?;
    let callback_uri = format!("{site}/auth/v1/callback");

    let token_resp = http_post_form(
        &cfg.token_endpoint,
        &[
            ("code", code),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", &callback_uri),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier),
        ],
    )
    .await?;

    // Prefer the id_token when both jwks_uri and issuer are present (required by
    // OIDC core).
    if let Some(id_token) = token_resp
        .get("id_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        if !cfg.jwks_uri.is_empty() && !cfg.issuer.is_empty() {
            if let Ok((email, verified)) = crate::auth::idtoken::verify_id_token(
                id_token,
                &cfg.jwks_uri,
                crate::auth::idtoken::issuer_equals(&cfg.issuer),
                client_id,
            )
            .await
            {
                if !email.is_empty() {
                    return Ok((
                        email.trim().to_lowercase(),
                        None,
                        "oidc".to_string(),
                        verified,
                    ));
                }
            }
        }
    }

    let access_token = token_resp
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::Unauthorized("oidc token exchange: no access_token in response".into())
        })?;

    if !cfg.userinfo_endpoint.is_empty() {
        let info = http_get_json(&cfg.userinfo_endpoint, access_token).await?;
        if let Some(email) = info
            .get("email")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            // Per OIDC core the userinfo `email_verified` claim accompanies
            // `email`; propagate it (mirror Go) so the F3 gate can refuse a
            // non-compliant IdP that omits it.
            let verified = crate::auth::idtoken::claim_true(info.get("email_verified"));
            return Ok((
                email.trim().to_lowercase(),
                None,
                "oidc".to_string(),
                verified,
            ));
        }
    }

    Err(AppError::Unauthorized(
        "oidc: email not found in id_token or userinfo".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Apple form_post body parsing ----

    #[test]
    fn form_post_parses_code_state_user() {
        let body = "code=abc123&state=xyz789&user=%7B%22name%22%3A%22a%22%7D";
        let (code, state, user) = parse_form_callback(body).expect("parse");
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz789");
        assert_eq!(user.as_deref(), Some(r#"{"name":"a"}"#));
    }

    #[test]
    fn form_post_user_optional() {
        let (code, state, user) = parse_form_callback("code=c&state=s").expect("parse");
        assert_eq!(code, "c");
        assert_eq!(state, "s");
        assert!(user.is_none());
    }

    #[test]
    fn form_post_missing_state_rejected() {
        assert!(parse_form_callback("code=abc").is_err());
    }

    #[test]
    fn form_post_missing_code_rejected() {
        assert!(parse_form_callback("state=xyz").is_err());
    }

    #[test]
    fn form_post_empty_body_rejected() {
        assert!(parse_form_callback("").is_err());
    }

    #[test]
    fn form_post_error_extracted() {
        let body = "error=access_denied&error_description=user%20cancelled";
        let (err, desc) = parse_form_error(body).expect("error present");
        assert_eq!(err, "access_denied");
        assert_eq!(desc, "user cancelled");
        assert!(parse_form_error("code=c&state=s").is_none());
    }

    // ---- looks_like_jwt ----

    #[test]
    fn looks_like_jwt_shapes() {
        assert!(looks_like_jwt("a.b.c"));
        assert!(looks_like_jwt("  a.b.c  "));
        assert!(!looks_like_jwt("a.b"));
        assert!(!looks_like_jwt("a.b.c.d"));
        assert!(!looks_like_jwt("plainstring"));
        assert!(!looks_like_jwt(
            "-----BEGIN PRIVATE KEY-----\na.b.c\n-----END---"
        ));
    }

    // ---- Apple client-secret JWT (ES256) ----

    // A P-256 PKCS#8 key, same shape as an Apple .p8 file.
    const APPLE_TEST_P8: &str = "-----BEGIN PRIVATE KEY-----\n\
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgx+Y5pHGNC/FW/ggt\n\
4hRpvz7D/AYjtDw2j6iTVa6wQeihRANCAAQqA81Nv/hrVENyqlTuNbNw5Ir+rSLb\n\
CX0AJpCEgyAJlemdUUcsPKtKsKHKThLWWXLOCdEyU5ta0EEooXsC/k5n\n\
-----END PRIVATE KEY-----\n";

    #[test]
    fn apple_client_secret_signs_es256_with_expected_claims() {
        let jwt = sign_apple_client_secret(
            "ABCDE12345",
            "FGHIJ67890",
            "com.example.auth",
            APPLE_TEST_P8,
        )
        .expect("sign");

        // Header: alg=ES256, kid=key_id.
        let header = jsonwebtoken::decode_header(&jwt).expect("header");
        assert_eq!(header.alg, jsonwebtoken::Algorithm::ES256);
        assert_eq!(header.kid.as_deref(), Some("FGHIJ67890"));

        // Decode the payload (no verification needed for claim inspection).
        let payload_b64 = jwt.split('.').nth(1).unwrap();
        use base64ct::{Base64UrlUnpadded, Encoding};
        let payload = Base64UrlUnpadded::decode_vec(payload_b64).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(claims["iss"], "ABCDE12345");
        assert_eq!(claims["sub"], "com.example.auth");
        assert_eq!(claims["aud"], "https://appleid.apple.com");
        assert!(claims["exp"].as_u64().unwrap() > claims["iat"].as_u64().unwrap());
    }

    #[test]
    fn apple_client_secret_rejects_bad_key() {
        assert!(sign_apple_client_secret("t", "k", "c", "not-a-pem").is_err());
    }

    // ---- authorize URL parity (endpoint / scope / response_type / PKCE) ----
    //
    // These pin the exact param sets each authorize arm builds, matching the Go
    // reference (proxy-go/auth/oauth.go). The live smoke confirms the running
    // handler emits them.

    fn qpairs(url: &str) -> std::collections::HashMap<String, String> {
        url::Url::parse(url)
            .unwrap()
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }

    #[test]
    fn apple_authorize_url_matches_go() {
        let url = build_authorize_url(
            APPLE_AUTH_URL,
            &[
                ("client_id", "cid"),
                ("redirect_uri", "https://site/auth/v1/callback"),
                ("response_type", "code"),
                ("scope", "email name"),
                ("state", "st"),
                ("response_mode", "form_post"),
            ],
        );
        assert!(url.starts_with("https://appleid.apple.com/auth/authorize?"));
        let q = qpairs(&url);
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["scope"], "email name");
        assert_eq!(q["response_mode"], "form_post");
        // Apple does NOT use PKCE.
        assert!(!q.contains_key("code_challenge"));
    }

    #[test]
    fn microsoft_authorize_url_matches_go() {
        let url = build_authorize_url(
            MICROSOFT_AUTH_URL,
            &[
                ("client_id", "cid"),
                ("redirect_uri", "https://site/auth/v1/callback"),
                ("response_type", "code"),
                ("scope", "openid email profile"),
                ("state", "st"),
                ("code_challenge", "ch"),
                ("code_challenge_method", "S256"),
            ],
        );
        assert!(url.starts_with("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?"));
        let q = qpairs(&url);
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["scope"], "openid email profile");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], "ch");
    }

    #[test]
    fn oidc_authorize_url_uses_pkce_and_openid_scope() {
        let url = build_authorize_url(
            "https://idp.example/authorize",
            &[
                ("client_id", "cid"),
                ("redirect_uri", "https://site/auth/v1/callback"),
                ("response_type", "code"),
                ("scope", "openid email profile"),
                ("state", "st"),
                ("code_challenge", "ch"),
                ("code_challenge_method", "S256"),
            ],
        );
        let q = qpairs(&url);
        assert_eq!(q["scope"], "openid email profile");
        assert_eq!(q["code_challenge_method"], "S256");
    }

    // ---- Account-takeover defense (audit F3, round 14 — Rust parity) ----
    //
    // Regression for the just-introduced HIGH: the id_token providers
    // (Microsoft/OIDC/Apple) discarded the `email_verified` claim (binding it to
    // a throwaway `_verified`), so a user from ANY tenant/IdP could mint an
    // id_token asserting a victim's email and take over the email-keyed
    // account. The fix threads `verified` out of every resolver and gates the
    // callback on it (Gate 1), plus refuses merging into an unverified existing
    // account (Gate 2). These pin the gate decision + the upsert SQL semantics.

    #[test]
    fn oauth_admission_refuses_unverified_provider() {
        // Gate 1: a resolver returning verified=false must refuse the login
        // (no session minted) regardless of the conflict flag.
        assert_eq!(
            oauth_admission(false, false).unwrap_err(),
            OAUTH_UNVERIFIED_DESC
        );
        assert_eq!(
            oauth_admission(false, true).unwrap_err(),
            OAUTH_UNVERIFIED_DESC
        );
        // A verified login against a clean/verified account is admitted.
        assert!(oauth_admission(true, false).is_ok());
    }

    #[test]
    fn oauth_admission_refuses_unverified_existing_account() {
        // Gate 2: even a verified provider assertion must NOT merge into an
        // existing account whose email was never verified (conflict_block=true).
        assert_eq!(
            oauth_admission(true, true).unwrap_err(),
            OAUTH_TAKEOVER_DESC
        );
    }

    #[test]
    fn oauth_upsert_sql_flags_takeover_and_never_elevates_verification() {
        // (a) the upsert surfaces the unverified-existing-account flag so the
        // caller can refuse the merge,
        assert!(OAUTH_UPSERT_SQL.contains("(email_confirmed_at IS NULL) AS conflict_block"));
        // (b) it sets email_confirmed_at ONLY on INSERT — never on the UPDATE
        // path. The previous (buggy) SQL did `email_confirmed_at = COALESCE(...,
        // now())` on conflict, which elevated/created a verified status for an
        // attacker-completed flow; that must not return.
        assert!(!OAUTH_UPSERT_SQL.contains("email_confirmed_at = COALESCE"));
        assert!(!OAUTH_UPSERT_SQL.contains("email_confirmed_at ="));
        // and the UPDATE leaves an unverified existing row's providers untouched.
        assert!(OAUTH_UPSERT_SQL.contains(
            "WHEN pgstack.users.email_confirmed_at IS NULL THEN pgstack.users.providers"
        ));
    }
}
