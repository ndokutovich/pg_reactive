use crate::auth::jwt::{self, Claims};
use crate::auth::keys::{constant_time_eq, is_service_role};
use crate::auth::password;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

// ---------- Request / Response types ----------

#[derive(Deserialize)]
pub struct SignupRequest {
    email: String,
    password: String,
    #[serde(default)]
    data: Option<serde_json::Value>,
}

#[derive(Deserialize)]
pub struct TokenRequest {
    grant_type: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateUserRequest {
    #[serde(default)]
    data: Option<serde_json::Value>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

#[derive(Serialize)]
struct AuthResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
    refresh_token: String,
    user: UserResponse,
}

#[derive(Serialize)]
struct UserResponse {
    id: String,
    email: String,
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_metadata: Option<serde_json::Value>,
    created_at: String,
    updated_at: String,
}

// ---------- Handlers ----------

/// POST /auth/v1/signup
pub async fn signup(
    State(state): State<AppState>,
    Json(body): Json<SignupRequest>,
) -> Result<Response, AppError> {
    let secret = state
        .config
        .jwt_secret
        .as_ref()
        .ok_or_else(|| AppError::Internal("JWT_SECRET not configured".into()))?;

    // Normalize email: trim whitespace and lowercase
    let email = body.email.trim().to_lowercase();

    // Validate input
    if !is_valid_email(&email) {
        return Err(AppError::BadRequest("invalid email".into()));
    }
    if body.password.len() < 8 {
        return Err(AppError::BadRequest(
            "password must be at least 8 characters".into(),
        ));
    }
    if body.password.len() > 256 {
        return Err(AppError::BadRequest(
            "password must be at most 256 characters".into(),
        ));
    }

    // Check if user already exists
    let existing =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pgstack.users WHERE email = $1")
            .bind(&email)
            .fetch_one(&state.admin_pool)
            .await?;

    if existing > 0 {
        return Err(AppError::Conflict("user already registered".into()));
    }

    // Hash password (CPU-intensive, run in blocking task)
    let pwd = body.password.clone();
    let hash = tokio::task::spawn_blocking(move || password::hash_password(&pwd))
        .await
        .map_err(|e| AppError::Internal(format!("hash task failed: {e}")))?
        .map_err(AppError::Internal)?;

    let user_meta = body.data.unwrap_or(serde_json::json!({}));

    if state.config.require_email_verification {
        // Insert user WITHOUT confirming email
        let row = sqlx::query_as::<_, (String, String, String, String, String, serde_json::Value, serde_json::Value)>(
            "INSERT INTO pgstack.users (email, encrypted_password, raw_user_meta)
             VALUES ($1, $2, $3)
             RETURNING id::text, email, role, created_at::text, updated_at::text, raw_user_meta, raw_app_meta",
        )
        .bind(&email)
        .bind(&hash)
        .bind(&user_meta)
        .fetch_one(&state.admin_pool)
        .await?;

        let (user_id, _user_email, _role, _created_at, _updated_at, _raw_user_meta, _raw_app_meta) =
            row;

        // Generate verification token and store it
        let verify_token = generate_token();
        sqlx::query(
            "INSERT INTO pgstack.email_tokens (user_id, token, token_type, expires_at)
             VALUES ($1::uuid, $2, 'email_verification', now() + interval '24 hours')",
        )
        .bind(&user_id)
        .bind(&verify_token)
        .execute(&state.admin_pool)
        .await?;

        // Send verification email
        let site_url = state
            .config
            .site_url
            .as_deref()
            .unwrap_or("http://127.0.0.1:3000");
        let html = verify_email_html(site_url, &verify_token);
        if let Err(e) = state.mailer.send(&email, "Verify your email", &html).await {
            tracing::warn!("Failed to send verification email to {email}: {e}");
        }

        Ok((
            StatusCode::CREATED,
            Json(serde_json::json!({
                "message": "Check your email to confirm your account"
            })),
        )
            .into_response())
    } else {
        // Insert user with email confirmed immediately
        let row = sqlx::query_as::<_, (String, String, String, String, String, serde_json::Value, serde_json::Value)>(
            "INSERT INTO pgstack.users (email, encrypted_password, raw_user_meta, email_confirmed_at)
             VALUES ($1, $2, $3, now())
             RETURNING id::text, email, role, created_at::text, updated_at::text, raw_user_meta, raw_app_meta",
        )
        .bind(&email)
        .bind(&hash)
        .bind(&user_meta)
        .fetch_one(&state.admin_pool)
        .await?;

        let (user_id, user_email, role, created_at, updated_at, raw_user_meta, raw_app_meta) = row;

        // Generate tokens (new family)
        let (access_token, refresh_token) =
            generate_token_pair(&state, secret, &user_id, &user_email, &role, None).await?;

        Ok((
            StatusCode::CREATED,
            Json(AuthResponse {
                access_token,
                token_type: "bearer".into(),
                expires_in: state.config.access_token_expiry_secs,
                refresh_token,
                user: UserResponse {
                    id: user_id,
                    email: user_email,
                    role,
                    user_metadata: Some(raw_user_meta),
                    app_metadata: Some(raw_app_meta),
                    created_at,
                    updated_at,
                },
            }),
        )
            .into_response())
    }
}

/// POST /auth/v1/token
pub async fn token(
    State(state): State<AppState>,
    Json(body): Json<TokenRequest>,
) -> Result<impl IntoResponse, AppError> {
    let secret = state
        .config
        .jwt_secret
        .clone()
        .ok_or_else(|| AppError::Internal("JWT_SECRET not configured".into()))?;

    match body.grant_type.as_str() {
        "password" => token_password(state, &secret, body).await,
        "refresh_token" => token_refresh(state, &secret, body).await,
        _ => Err(AppError::BadRequest(format!(
            "unsupported grant_type: {}",
            body.grant_type
        ))),
    }
}

async fn token_password(
    state: AppState,
    secret: &str,
    body: TokenRequest,
) -> Result<(StatusCode, Json<AuthResponse>), AppError> {
    let email = body
        .email
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("email is required".into()))?;
    let pwd = body
        .password
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("password is required".into()))?;

    // Fetch user
    let user = sqlx::query_as::<_, (String, String, String, Option<String>, String, String, serde_json::Value, serde_json::Value)>(
        "SELECT id::text, email, role, encrypted_password, created_at::text, updated_at::text, raw_user_meta, raw_app_meta
         FROM pgstack.users WHERE email = $1",
    )
    .bind(email)
    .fetch_optional(&state.admin_pool)
    .await?;

    let (
        user_id,
        user_email,
        role,
        encrypted_password,
        created_at,
        updated_at,
        raw_user_meta,
        raw_app_meta,
    ) = user.ok_or_else(|| AppError::Unauthorized("invalid login credentials".into()))?;

    let hash = encrypted_password
        .ok_or_else(|| AppError::Unauthorized("invalid login credentials".into()))?;

    // Verify password (CPU-intensive)
    let pwd_owned = pwd.to_string();
    let hash_owned = hash.clone();
    let valid =
        tokio::task::spawn_blocking(move || password::verify_password(&pwd_owned, &hash_owned))
            .await
            .map_err(|e| AppError::Internal(format!("verify task failed: {e}")))?
            .map_err(AppError::Internal)?;

    if !valid {
        return Err(AppError::Unauthorized("invalid login credentials".into()));
    }

    // Generate tokens (new family)
    let (access_token, refresh_token) =
        generate_token_pair(&state, secret, &user_id, &user_email, &role, None).await?;

    Ok((
        StatusCode::OK,
        Json(AuthResponse {
            access_token,
            token_type: "bearer".into(),
            expires_in: state.config.access_token_expiry_secs,
            refresh_token,
            user: UserResponse {
                id: user_id,
                email: user_email,
                role,
                user_metadata: Some(raw_user_meta),
                app_metadata: Some(raw_app_meta),
                created_at,
                updated_at,
            },
        }),
    ))
}

async fn token_refresh(
    state: AppState,
    secret: &str,
    body: TokenRequest,
) -> Result<(StatusCode, Json<AuthResponse>), AppError> {
    let refresh = body
        .refresh_token
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("refresh_token is required".into()))?;

    // Find refresh token (including revoked, for reuse detection)
    let token_row = sqlx::query_as::<_, (i64, String, bool, Option<String>)>(
        "SELECT id, user_id::text, revoked, family_id::text FROM pgstack.refresh_tokens
         WHERE token = $1 AND expires_at > now()",
    )
    .bind(refresh)
    .fetch_optional(&state.admin_pool)
    .await?;

    let (token_id, user_id, revoked, family_id) = token_row
        .ok_or_else(|| AppError::Unauthorized("invalid or expired refresh token".into()))?;

    // Token reuse detection: if already revoked, this indicates a breach
    if revoked {
        if let Some(ref fid) = family_id {
            sqlx::query(
                "UPDATE pgstack.refresh_tokens SET revoked = true WHERE family_id = $1::uuid",
            )
            .bind(fid)
            .execute(&state.admin_pool)
            .await?;
        }
        tracing::warn!(
            family_id = ?family_id,
            "refresh token reuse detected — entire family revoked"
        );
        return Err(AppError::Unauthorized("refresh token already used".into()));
    }

    // Wrap revoke + new token insert in a single transaction
    let mut tx = state.admin_pool.begin().await?;

    // Revoke the old refresh token (rotation)
    sqlx::query("UPDATE pgstack.refresh_tokens SET revoked = true WHERE id = $1")
        .bind(token_id)
        .execute(&mut *tx)
        .await?;

    // Fetch user
    let user = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            serde_json::Value,
            serde_json::Value,
        ),
    >(
        "SELECT email, role, created_at::text, updated_at::text, raw_user_meta, raw_app_meta
         FROM pgstack.users WHERE id = $1::uuid",
    )
    .bind(&user_id)
    .fetch_one(&mut *tx)
    .await?;

    let (email, role, created_at, updated_at, raw_user_meta, raw_app_meta) = user;

    // Generate new token pair (same family for reuse detection) within transaction
    let (access_token, new_refresh_token) = generate_token_pair_tx(
        &mut tx,
        &state,
        secret,
        &user_id,
        &email,
        &role,
        family_id.as_deref(),
    )
    .await?;

    tx.commit().await?;

    Ok((
        StatusCode::OK,
        Json(AuthResponse {
            access_token,
            token_type: "bearer".into(),
            expires_in: state.config.access_token_expiry_secs,
            refresh_token: new_refresh_token,
            user: UserResponse {
                id: user_id,
                email,
                role,
                user_metadata: Some(raw_user_meta),
                app_metadata: Some(raw_app_meta),
                created_at,
                updated_at,
            },
        }),
    ))
}

/// GET /auth/v1/user — get current user from JWT
pub async fn get_user(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let claims = extract_claims_from_headers(&state, &headers)?;

    let user = sqlx::query_as::<_, (String, String, String, String, String, serde_json::Value, serde_json::Value)>(
        "SELECT id::text, email, role, created_at::text, updated_at::text, raw_user_meta, raw_app_meta
         FROM pgstack.users WHERE id = $1::uuid",
    )
    .bind(&claims.sub)
    .fetch_optional(&state.admin_pool)
    .await?;

    let (id, email, role, created_at, updated_at, raw_user_meta, raw_app_meta) =
        user.ok_or_else(|| AppError::NotFound("user not found".into()))?;

    Ok(Json(UserResponse {
        id,
        email,
        role,
        user_metadata: Some(raw_user_meta),
        app_metadata: Some(raw_app_meta),
        created_at,
        updated_at,
    }))
}

/// PATCH /auth/v1/user — update user metadata or password
pub async fn update_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UpdateUserRequest>,
) -> Result<impl IntoResponse, AppError> {
    let claims = extract_claims_from_headers(&state, &headers)?;

    // Update metadata if provided
    if let Some(data) = &body.data {
        sqlx::query(
            "UPDATE pgstack.users SET raw_user_meta = raw_user_meta || $1, updated_at = now()
             WHERE id = $2::uuid",
        )
        .bind(data)
        .bind(&claims.sub)
        .execute(&state.admin_pool)
        .await?;
    }

    // Update email if provided
    if let Some(email) = &body.email {
        if !is_valid_email(email) {
            return Err(AppError::BadRequest("invalid email".into()));
        }
        sqlx::query("UPDATE pgstack.users SET email = $1, updated_at = now() WHERE id = $2::uuid")
            .bind(email)
            .bind(&claims.sub)
            .execute(&state.admin_pool)
            .await?;
    }

    // Update password if provided
    if let Some(pwd) = &body.password {
        if pwd.len() < 8 {
            return Err(AppError::BadRequest(
                "password must be at least 8 characters".into(),
            ));
        }
        if pwd.len() > 256 {
            return Err(AppError::BadRequest(
                "password must be at most 256 characters".into(),
            ));
        }
        let pwd_owned = pwd.clone();
        let hash = tokio::task::spawn_blocking(move || password::hash_password(&pwd_owned))
            .await
            .map_err(|e| AppError::Internal(format!("hash task failed: {e}")))?
            .map_err(AppError::Internal)?;

        sqlx::query(
            "UPDATE pgstack.users SET encrypted_password = $1, updated_at = now()
             WHERE id = $2::uuid",
        )
        .bind(&hash)
        .bind(&claims.sub)
        .execute(&state.admin_pool)
        .await?;
    }

    // Return updated user
    let user = sqlx::query_as::<_, (String, String, String, String, String, serde_json::Value, serde_json::Value)>(
        "SELECT id::text, email, role, created_at::text, updated_at::text, raw_user_meta, raw_app_meta
         FROM pgstack.users WHERE id = $1::uuid",
    )
    .bind(&claims.sub)
    .fetch_one(&state.admin_pool)
    .await?;

    let (id, email, role, created_at, updated_at, raw_user_meta, raw_app_meta) = user;

    Ok(Json(UserResponse {
        id,
        email,
        role,
        user_metadata: Some(raw_user_meta),
        app_metadata: Some(raw_app_meta),
        created_at,
        updated_at,
    }))
}

/// POST /auth/v1/logout — revoke refresh token
pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let claims = extract_claims_from_headers(&state, &headers)?;

    // Revoke all refresh tokens for this user
    sqlx::query(
        "UPDATE pgstack.refresh_tokens SET revoked = true WHERE user_id = $1::uuid AND NOT revoked",
    )
    .bind(&claims.sub)
    .execute(&state.admin_pool)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

// ---------- Helpers ----------

/// Validate an email address: non-empty local part, non-empty domain with at
/// least one dot, total length <= 254.
fn is_valid_email(email: &str) -> bool {
    if email.len() > 254 {
        return false;
    }
    match email.split_once('@') {
        Some((local, domain)) => !local.is_empty() && !domain.is_empty() && domain.contains('.'),
        None => false,
    }
}

/// Extract and validate JWT claims from request headers.
fn extract_claims_from_headers(state: &AppState, headers: &HeaderMap) -> Result<Claims, AppError> {
    let secret = state
        .config
        .jwt_secret
        .as_ref()
        .ok_or_else(|| AppError::Internal("JWT_SECRET not configured".into()))?;

    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    let token = jwt::extract_token_from_header(auth_header, None, None)
        .ok_or_else(|| AppError::Unauthorized("missing authorization header".into()))?;

    // Check if it's the anon key (not a JWT) — constant-time comparison
    if let Some(ref anon_key) = state.config.anon_key {
        if constant_time_eq(&token, anon_key) {
            return Err(AppError::Unauthorized(
                "anon key cannot access user endpoints".into(),
            ));
        }
    }

    jwt::validate_token(&token, secret).map_err(AppError::Unauthorized)
}

/// Generate access token + refresh token pair.
/// If `family_id` is Some, the new refresh token inherits the family (rotation).
/// If None, a new family is created (fresh login).
pub(crate) async fn generate_token_pair(
    state: &AppState,
    secret: &str,
    user_id: &str,
    email: &str,
    role: &str,
    family_id: Option<&str>,
) -> Result<(String, String), AppError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let claims = Claims {
        sub: user_id.to_string(),
        role: role.to_string(),
        email: Some(email.to_string()),
        iat: Some(now),
        exp: Some(now + state.config.access_token_expiry_secs),
    };

    let access_token = jwt::generate_token(&claims, secret).map_err(AppError::Internal)?;

    // Generate opaque refresh token
    let refresh_token = generate_refresh_token();

    // Store refresh token in DB (inherit family_id for rotation, or create new)
    sqlx::query(
        "INSERT INTO pgstack.refresh_tokens (token, user_id, family_id, expires_at)
         VALUES ($1, $2::uuid, COALESCE($3::uuid, gen_random_uuid()), now() + $4 * interval '1 day')",
    )
    .bind(&refresh_token)
    .bind(user_id)
    .bind(family_id)
    .bind(state.config.refresh_token_expiry_days)
    .execute(&state.admin_pool)
    .await?;

    Ok((access_token, refresh_token))
}

/// Like `generate_token_pair`, but executes the INSERT within an existing transaction.
async fn generate_token_pair_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    state: &AppState,
    secret: &str,
    user_id: &str,
    email: &str,
    role: &str,
    family_id: Option<&str>,
) -> Result<(String, String), AppError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let claims = Claims {
        sub: user_id.to_string(),
        role: role.to_string(),
        email: Some(email.to_string()),
        iat: Some(now),
        exp: Some(now + state.config.access_token_expiry_secs),
    };

    let access_token = jwt::generate_token(&claims, secret).map_err(AppError::Internal)?;

    let refresh_token = generate_refresh_token();

    sqlx::query(
        "INSERT INTO pgstack.refresh_tokens (token, user_id, family_id, expires_at)
         VALUES ($1, $2::uuid, COALESCE($3::uuid, gen_random_uuid()), now() + $4 * interval '1 day')",
    )
    .bind(&refresh_token)
    .bind(user_id)
    .bind(family_id)
    .bind(state.config.refresh_token_expiry_days)
    .execute(&mut **tx)
    .await?;

    Ok((access_token, refresh_token))
}

pub(crate) fn generate_refresh_token() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    let bytes: Vec<u8> = (0..32).map(|_| rng.random()).collect();
    base64_url_encode(&bytes)
}

pub(crate) fn base64_url_encode(data: &[u8]) -> String {
    use base64ct::{Base64UrlUnpadded, Encoding};
    Base64UrlUnpadded::encode_string(data)
}

// ---------- Token generation ----------

/// Generate a cryptographically random hex token (32 bytes = 64 hex chars).
fn generate_token() -> String {
    use std::fmt::Write;
    let bytes: [u8; 32] = rand::random();
    let mut s = String::with_capacity(64);
    for b in bytes {
        write!(s, "{b:02x}").unwrap();
    }
    s
}

// ---------- Email template helpers ----------

fn reset_email_html(site_url: &str, token: &str) -> String {
    format!(
        "<p>Hi,</p>\
         <p>You requested a password reset. Click the link below (expires in 1 hour):</p>\
         <p><a href=\"{site_url}/auth/v1/recover/confirm?token={token}\">Reset Password</a></p>\
         <p>If you didn't request this, ignore this email.</p>"
    )
}

fn magic_link_email_html(site_url: &str, token: &str) -> String {
    format!(
        "<p>Hi,</p>\
         <p>Click the link below to sign in (expires in 15 minutes):</p>\
         <p><a href=\"{site_url}/auth/v1/magiclink/verify?token={token}\">Sign In</a></p>\
         <p>If you didn't request this, ignore this email.</p>"
    )
}

fn verify_email_html(site_url: &str, token: &str) -> String {
    format!(
        "<p>Hi,</p>\
         <p>Please verify your email address:</p>\
         <p><a href=\"{site_url}/auth/v1/verify?token={token}\">Verify Email</a></p>"
    )
}

// ---------- Password recovery ----------

#[derive(Deserialize)]
pub struct RecoverRequest {
    pub email: String,
}

/// POST /auth/v1/recover — send password reset email
pub async fn recover(
    State(state): State<AppState>,
    Json(body): Json<RecoverRequest>,
) -> Result<impl IntoResponse, AppError> {
    let site_url = state
        .config
        .site_url
        .as_deref()
        .unwrap_or("http://127.0.0.1:3000");

    // Look up user — do not reveal whether the email exists
    let row = sqlx::query_as::<_, (String,)>("SELECT id::text FROM pgstack.users WHERE email = $1")
        .bind(&body.email)
        .fetch_optional(&state.admin_pool)
        .await?;

    if let Some((user_id,)) = row {
        let token = generate_token();

        sqlx::query(
            "INSERT INTO pgstack.email_tokens (user_id, token, token_type, expires_at)
             VALUES ($1::uuid, $2, 'recovery', now() + interval '1 hour')",
        )
        .bind(&user_id)
        .bind(&token)
        .execute(&state.admin_pool)
        .await?;

        let html = reset_email_html(site_url, &token);
        if let Err(e) = state
            .mailer
            .send(&body.email, "Reset your password", &html)
            .await
        {
            tracing::warn!("Failed to send reset email to {}: {e}", body.email);
        }
    }

    Ok(Json(serde_json::json!({
        "message": "If this email exists, a reset link has been sent"
    })))
}

#[derive(Deserialize)]
pub struct RecoverConfirmRequest {
    pub token: String,
    pub password: String,
}

/// POST /auth/v1/recover/confirm — verify reset token and set new password
pub async fn recover_confirm(
    State(state): State<AppState>,
    Json(body): Json<RecoverConfirmRequest>,
) -> Result<impl IntoResponse, AppError> {
    if body.password.len() < 8 {
        return Err(AppError::BadRequest(
            "password must be at least 8 characters".into(),
        ));
    }
    if body.password.len() > 256 {
        return Err(AppError::BadRequest(
            "password must be at most 256 characters".into(),
        ));
    }

    // Look up the reset token
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT id::text, user_id::text FROM pgstack.email_tokens
         WHERE token = $1
           AND token_type = 'recovery'
           AND used_at IS NULL
           AND expires_at > now()",
    )
    .bind(&body.token)
    .fetch_optional(&state.admin_pool)
    .await?;

    let (token_id, user_id) =
        row.ok_or_else(|| AppError::BadRequest("Invalid or expired reset token".into()))?;

    // Hash new password
    let pwd = body.password.clone();
    let hash = tokio::task::spawn_blocking(move || password::hash_password(&pwd))
        .await
        .map_err(|e| AppError::Internal(format!("hash task failed: {e}")))?
        .map_err(AppError::Internal)?;

    // Wrap password update + token mark-used in a single transaction
    let mut tx = state.admin_pool.begin().await?;

    // Update password
    sqlx::query(
        "UPDATE pgstack.users SET encrypted_password = $1, updated_at = now()
         WHERE id = $2::uuid",
    )
    .bind(&hash)
    .bind(&user_id)
    .execute(&mut *tx)
    .await?;

    // Mark token used
    sqlx::query("UPDATE pgstack.email_tokens SET used_at = now() WHERE id = $1::uuid")
        .bind(&token_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(Json(serde_json::json!({ "message": "Password updated" })))
}

// ---------- Magic link ----------

#[derive(Deserialize)]
pub struct MagiclinkRequest {
    pub email: String,
}

/// POST /auth/v1/magiclink — send magic link (creates passwordless user if needed)
pub async fn magiclink(
    State(state): State<AppState>,
    Json(body): Json<MagiclinkRequest>,
) -> Result<impl IntoResponse, AppError> {
    if !is_valid_email(&body.email) {
        return Err(AppError::BadRequest("invalid email".into()));
    }

    let site_url = state
        .config
        .site_url
        .as_deref()
        .unwrap_or("http://127.0.0.1:3000");

    // Look up user; create passwordless user if not found
    let user_id: String = {
        let existing =
            sqlx::query_as::<_, (String,)>("SELECT id::text FROM pgstack.users WHERE email = $1")
                .bind(&body.email)
                .fetch_optional(&state.admin_pool)
                .await?;

        if let Some((id,)) = existing {
            id
        } else {
            let row = sqlx::query_as::<_, (String,)>(
                "INSERT INTO pgstack.users (email, provider, providers, email_confirmed_at)
                 VALUES ($1, 'magic_link', '{magic_link}', now())
                 RETURNING id::text",
            )
            .bind(&body.email)
            .fetch_one(&state.admin_pool)
            .await?;
            row.0
        }
    };

    let token = generate_token();

    sqlx::query(
        "INSERT INTO pgstack.email_tokens (user_id, token, token_type, expires_at)
         VALUES ($1::uuid, $2, 'magiclink', now() + interval '15 minutes')",
    )
    .bind(&user_id)
    .bind(&token)
    .execute(&state.admin_pool)
    .await?;

    let html = magic_link_email_html(site_url, &token);
    if let Err(e) = state
        .mailer
        .send(&body.email, "Your sign-in link", &html)
        .await
    {
        tracing::warn!("Failed to send magic link email to {}: {e}", body.email);
    }

    Ok(Json(serde_json::json!({ "message": "Magic link sent" })))
}

#[derive(Deserialize)]
pub struct MagiclinkVerifyParams {
    pub token: String,
}

/// GET /auth/v1/magiclink/verify?token=xxx — verify magic link and issue JWT
pub async fn magiclink_verify(
    State(state): State<AppState>,
    Query(params): Query<MagiclinkVerifyParams>,
) -> Result<impl IntoResponse, AppError> {
    let site_url = state
        .config
        .site_url
        .as_deref()
        .unwrap_or("http://127.0.0.1:3000");

    let secret = match state.config.jwt_secret.as_ref() {
        Some(s) => s.clone(),
        None => {
            let redirect_url = format!("{site_url}#error=jwt_not_configured");
            return Ok(Redirect::to(&redirect_url).into_response());
        }
    };

    // Look up token
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT id::text, user_id::text FROM pgstack.email_tokens
         WHERE token = $1
           AND token_type = 'magiclink'
           AND used_at IS NULL
           AND expires_at > now()",
    )
    .bind(&params.token)
    .fetch_optional(&state.admin_pool)
    .await?;

    let (token_id, user_id) = match row {
        Some(r) => r,
        None => {
            let redirect_url = format!("{site_url}#error=invalid_magic_link");
            return Ok(Redirect::to(&redirect_url).into_response());
        }
    };

    // Fetch user
    let user = sqlx::query_as::<_, (String, String, String, String, String)>(
        "SELECT email, role, created_at::text, updated_at::text, id::text
         FROM pgstack.users WHERE id = $1::uuid",
    )
    .bind(&user_id)
    .fetch_one(&state.admin_pool)
    .await?;

    let (email, role, _created_at, _updated_at, uid) = user;

    // Mark token used and confirm email (clicking the link proves email ownership)
    sqlx::query("UPDATE pgstack.email_tokens SET used_at = now() WHERE id = $1::uuid")
        .bind(&token_id)
        .execute(&state.admin_pool)
        .await?;

    sqlx::query(
        "UPDATE pgstack.users SET email_confirmed_at = COALESCE(email_confirmed_at, now()), updated_at = now()
         WHERE id = $1::uuid",
    )
    .bind(&user_id)
    .execute(&state.admin_pool)
    .await?;

    // Create session + token pair
    let (access_token, refresh_token) =
        generate_token_pair(&state, &secret, &uid, &email, &role, None).await?;

    let redirect_url = format!(
        "{}#access_token={}&refresh_token={}",
        site_url,
        urlencoding::encode(&access_token),
        urlencoding::encode(&refresh_token),
    );

    Ok(Redirect::to(&redirect_url).into_response())
}

// ---------- Email verification ----------

#[derive(Deserialize)]
pub struct VerifyEmailParams {
    pub token: String,
}

/// GET /auth/v1/verify?token=xxx — verify email address
pub async fn verify_email(
    State(state): State<AppState>,
    Query(params): Query<VerifyEmailParams>,
) -> Result<impl IntoResponse, AppError> {
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT id::text, user_id::text FROM pgstack.email_tokens
         WHERE token = $1
           AND token_type = 'email_verification'
           AND used_at IS NULL
           AND expires_at > now()",
    )
    .bind(&params.token)
    .fetch_optional(&state.admin_pool)
    .await?;

    let (token_id, user_id) =
        row.ok_or_else(|| AppError::BadRequest("Invalid or expired verification token".into()))?;

    sqlx::query(
        "UPDATE pgstack.users SET email_confirmed_at = now(), updated_at = now()
         WHERE id = $1::uuid",
    )
    .bind(&user_id)
    .execute(&state.admin_pool)
    .await?;

    sqlx::query("UPDATE pgstack.email_tokens SET used_at = now() WHERE id = $1::uuid")
        .bind(&token_id)
        .execute(&state.admin_pool)
        .await?;

    Ok(Json(serde_json::json!({ "message": "Email verified" })))
}

// ---------- Admin endpoints ----------

#[derive(Deserialize)]
pub struct AdminListParams {
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

#[derive(Serialize)]
struct AdminUserRow {
    id: String,
    email: String,
    role: String,
    created_at: String,
    email_confirmed_at: Option<String>,
}

/// GET /auth/v1/admin/users — list users (service_role only)
pub async fn admin_list_users(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<AdminListParams>,
) -> Result<impl IntoResponse, AppError> {
    let srk = state
        .config
        .service_role_key
        .as_deref()
        .ok_or_else(|| AppError::Internal("SERVICE_ROLE_KEY not configured".into()))?;
    if !is_service_role(&headers, srk) {
        return Err(AppError::Forbidden("service_role key required".into()));
    }

    let page_size = params.page_size.unwrap_or(50).clamp(1, 1000);
    let page = params.page.unwrap_or(0).max(0);
    let offset = page * page_size;

    let rows = sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
        "SELECT id::text, email, role, created_at::text, email_confirmed_at::text
         FROM pgstack.users
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2",
    )
    .bind(page_size)
    .bind(offset)
    .fetch_all(&state.admin_pool)
    .await?;

    let users: Vec<AdminUserRow> = rows
        .into_iter()
        .map(
            |(id, email, role, created_at, email_confirmed_at)| AdminUserRow {
                id,
                email,
                role,
                created_at,
                email_confirmed_at,
            },
        )
        .collect();

    Ok(Json(users))
}

/// DELETE /auth/v1/admin/users/:id — delete user (service_role only)
pub async fn admin_delete_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(user_id): axum::extract::Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let srk = state
        .config
        .service_role_key
        .as_deref()
        .ok_or_else(|| AppError::Internal("SERVICE_ROLE_KEY not configured".into()))?;
    if !is_service_role(&headers, srk) {
        return Err(AppError::Forbidden("service_role key required".into()));
    }

    // Validate that the path parameter is a valid UUID
    if uuid::Uuid::parse_str(&user_id).is_err() {
        return Err(AppError::BadRequest("invalid user id".into()));
    }

    let result = sqlx::query("DELETE FROM pgstack.users WHERE id = $1::uuid")
        .bind(&user_id)
        .execute(&state.admin_pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("user not found".into()));
    }

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct AdminCreateUserRequest {
    pub email: String,
    pub password: Option<String>,
    pub role: Option<String>,
    pub email_confirm: Option<bool>,
}

/// POST /auth/v1/admin/users — create user (service_role only)
pub async fn admin_create_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AdminCreateUserRequest>,
) -> Result<impl IntoResponse, AppError> {
    let srk = state
        .config
        .service_role_key
        .as_deref()
        .ok_or_else(|| AppError::Internal("SERVICE_ROLE_KEY not configured".into()))?;
    if !is_service_role(&headers, srk) {
        return Err(AppError::Forbidden("service_role key required".into()));
    }

    if !is_valid_email(&body.email) {
        return Err(AppError::BadRequest("invalid email".into()));
    }

    let hash: Option<String> = if let Some(pwd) = body.password {
        if pwd.len() < 8 {
            return Err(AppError::BadRequest(
                "password must be at least 8 characters".into(),
            ));
        }
        if pwd.len() > 256 {
            return Err(AppError::BadRequest(
                "password must be at most 256 characters".into(),
            ));
        }
        let h = tokio::task::spawn_blocking(move || password::hash_password(&pwd))
            .await
            .map_err(|e| AppError::Internal(format!("hash task failed: {e}")))?
            .map_err(AppError::Internal)?;
        Some(h)
    } else {
        None
    };

    let role = body.role.as_deref().unwrap_or("authenticated");
    let email_confirm = body.email_confirm.unwrap_or(false);

    let row = sqlx::query_as::<_, (String, String, String, String, String)>(
        "INSERT INTO pgstack.users (email, encrypted_password, role, email_confirmed_at)
         VALUES ($1, $2, $3, CASE WHEN $4 THEN now() ELSE NULL END)
         RETURNING id::text, email, role, created_at::text, updated_at::text",
    )
    .bind(&body.email)
    .bind(&hash)
    .bind(role)
    .bind(email_confirm)
    .fetch_one(&state.admin_pool)
    .await?;

    let (id, email, user_role, created_at, updated_at) = row;

    Ok((
        StatusCode::CREATED,
        Json(UserResponse {
            id,
            email,
            role: user_role,
            user_metadata: Some(serde_json::json!({})),
            app_metadata: Some(serde_json::json!({})),
            created_at,
            updated_at,
        }),
    ))
}
