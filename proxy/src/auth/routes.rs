use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use crate::auth::jwt::{self, Claims};
use crate::auth::password;
use crate::error::AppError;
use crate::state::AppState;

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

// ---------- Constants ----------

const ACCESS_TOKEN_EXPIRY_SECS: u64 = 3600; // 1 hour
const REFRESH_TOKEN_EXPIRY_DAYS: i64 = 30;

// ---------- Handlers ----------

/// POST /auth/v1/signup
pub async fn signup(
    State(state): State<AppState>,
    Json(body): Json<SignupRequest>,
) -> Result<impl IntoResponse, AppError> {
    let secret = state.config.jwt_secret.as_ref().ok_or_else(|| {
        AppError::Internal("JWT_SECRET not configured".into())
    })?;

    // Validate input
    if body.email.is_empty() || !body.email.contains('@') {
        return Err(AppError::BadRequest("invalid email".into()));
    }
    if body.password.len() < 6 {
        return Err(AppError::BadRequest(
            "password must be at least 6 characters".into(),
        ));
    }

    // Check if user already exists
    let existing = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pgstack.users WHERE email = $1",
    )
    .bind(&body.email)
    .fetch_one(&state.pg_pool)
    .await?;

    if existing > 0 {
        return Err(AppError::Conflict("user already registered".into()));
    }

    // Hash password (CPU-intensive, run in blocking task)
    let pwd = body.password.clone();
    let hash = tokio::task::spawn_blocking(move || password::hash_password(&pwd))
        .await
        .map_err(|e| AppError::Internal(format!("hash task failed: {}", e)))?
        .map_err(AppError::Internal)?;

    // Insert user
    let user_meta = body.data.unwrap_or(serde_json::json!({}));
    let row = sqlx::query_as::<_, (String, String, String, String, String, serde_json::Value, serde_json::Value)>(
        "INSERT INTO pgstack.users (email, encrypted_password, raw_user_meta, email_confirmed_at)
         VALUES ($1, $2, $3, now())
         RETURNING id::text, email, role, created_at::text, updated_at::text, raw_user_meta, raw_app_meta",
    )
    .bind(&body.email)
    .bind(&hash)
    .bind(&user_meta)
    .fetch_one(&state.pg_pool)
    .await?;

    let (user_id, email, role, created_at, updated_at, raw_user_meta, raw_app_meta) = row;

    // Generate tokens (new family)
    let (access_token, refresh_token) =
        generate_token_pair(&state, secret, &user_id, &email, &role, None).await?;

    Ok((
        StatusCode::CREATED,
        Json(AuthResponse {
            access_token,
            token_type: "bearer".into(),
            expires_in: ACCESS_TOKEN_EXPIRY_SECS,
            refresh_token,
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

/// POST /auth/v1/token
pub async fn token(
    State(state): State<AppState>,
    Json(body): Json<TokenRequest>,
) -> Result<impl IntoResponse, AppError> {
    let secret = state.config.jwt_secret.clone().ok_or_else(|| {
        AppError::Internal("JWT_SECRET not configured".into())
    })?;

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
    let email = body.email.as_deref().ok_or_else(|| {
        AppError::BadRequest("email is required".into())
    })?;
    let pwd = body.password.as_deref().ok_or_else(|| {
        AppError::BadRequest("password is required".into())
    })?;

    // Fetch user
    let user = sqlx::query_as::<_, (String, String, String, Option<String>, String, String, serde_json::Value, serde_json::Value)>(
        "SELECT id::text, email, role, encrypted_password, created_at::text, updated_at::text, raw_user_meta, raw_app_meta
         FROM pgstack.users WHERE email = $1",
    )
    .bind(email)
    .fetch_optional(&state.pg_pool)
    .await?;

    let (user_id, user_email, role, encrypted_password, created_at, updated_at, raw_user_meta, raw_app_meta) =
        user.ok_or_else(|| AppError::Unauthorized("invalid login credentials".into()))?;

    let hash = encrypted_password.ok_or_else(|| {
        AppError::Unauthorized("invalid login credentials".into())
    })?;

    // Verify password (CPU-intensive)
    let pwd_owned = pwd.to_string();
    let hash_owned = hash.clone();
    let valid = tokio::task::spawn_blocking(move || {
        password::verify_password(&pwd_owned, &hash_owned)
    })
    .await
    .map_err(|e| AppError::Internal(format!("verify task failed: {}", e)))?
    .map_err(AppError::Internal)?;

    if !valid {
        return Err(AppError::Unauthorized(
            "invalid login credentials".into(),
        ));
    }

    // Generate tokens (new family)
    let (access_token, refresh_token) =
        generate_token_pair(&state, secret, &user_id, &user_email, &role, None).await?;

    Ok((
        StatusCode::OK,
        Json(AuthResponse {
            access_token,
            token_type: "bearer".into(),
            expires_in: ACCESS_TOKEN_EXPIRY_SECS,
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
    let refresh = body.refresh_token.as_deref().ok_or_else(|| {
        AppError::BadRequest("refresh_token is required".into())
    })?;

    // Find refresh token (including revoked, for reuse detection)
    let token_row = sqlx::query_as::<_, (i64, String, bool, Option<String>)>(
        "SELECT id, user_id::text, revoked, family_id::text FROM pgstack.refresh_tokens
         WHERE token = $1 AND expires_at > now()",
    )
    .bind(refresh)
    .fetch_optional(&state.pg_pool)
    .await?;

    let (token_id, user_id, revoked, family_id) = token_row.ok_or_else(|| {
        AppError::Unauthorized("invalid or expired refresh token".into())
    })?;

    // Token reuse detection: if already revoked, this indicates a breach
    if revoked {
        if let Some(ref fid) = family_id {
            sqlx::query(
                "UPDATE pgstack.refresh_tokens SET revoked = true WHERE family_id = $1::uuid",
            )
            .bind(fid)
            .execute(&state.pg_pool)
            .await?;
        }
        tracing::warn!(
            family_id = ?family_id,
            "refresh token reuse detected — entire family revoked"
        );
        return Err(AppError::Unauthorized(
            "refresh token already used".into(),
        ));
    }

    // Revoke the old refresh token (rotation)
    sqlx::query("UPDATE pgstack.refresh_tokens SET revoked = true WHERE id = $1")
        .bind(token_id)
        .execute(&state.pg_pool)
        .await?;

    // Fetch user
    let user = sqlx::query_as::<_, (String, String, String, String, serde_json::Value, serde_json::Value)>(
        "SELECT email, role, created_at::text, updated_at::text, raw_user_meta, raw_app_meta
         FROM pgstack.users WHERE id = $1::uuid",
    )
    .bind(&user_id)
    .fetch_one(&state.pg_pool)
    .await?;

    let (email, role, created_at, updated_at, raw_user_meta, raw_app_meta) = user;

    // Generate new token pair (same family for reuse detection)
    let (access_token, new_refresh_token) =
        generate_token_pair(&state, secret, &user_id, &email, &role, family_id.as_deref()).await?;

    Ok((
        StatusCode::OK,
        Json(AuthResponse {
            access_token,
            token_type: "bearer".into(),
            expires_in: ACCESS_TOKEN_EXPIRY_SECS,
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
    .fetch_optional(&state.pg_pool)
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
        .execute(&state.pg_pool)
        .await?;
    }

    // Update email if provided
    if let Some(email) = &body.email {
        if email.is_empty() || !email.contains('@') {
            return Err(AppError::BadRequest("invalid email".into()));
        }
        sqlx::query(
            "UPDATE pgstack.users SET email = $1, updated_at = now() WHERE id = $2::uuid",
        )
        .bind(email)
        .bind(&claims.sub)
        .execute(&state.pg_pool)
        .await?;
    }

    // Update password if provided
    if let Some(pwd) = &body.password {
        if pwd.len() < 6 {
            return Err(AppError::BadRequest(
                "password must be at least 6 characters".into(),
            ));
        }
        let pwd_owned = pwd.clone();
        let hash = tokio::task::spawn_blocking(move || password::hash_password(&pwd_owned))
            .await
            .map_err(|e| AppError::Internal(format!("hash task failed: {}", e)))?
            .map_err(AppError::Internal)?;

        sqlx::query(
            "UPDATE pgstack.users SET encrypted_password = $1, updated_at = now()
             WHERE id = $2::uuid",
        )
        .bind(&hash)
        .bind(&claims.sub)
        .execute(&state.pg_pool)
        .await?;
    }

    // Return updated user
    let user = sqlx::query_as::<_, (String, String, String, String, String, serde_json::Value, serde_json::Value)>(
        "SELECT id::text, email, role, created_at::text, updated_at::text, raw_user_meta, raw_app_meta
         FROM pgstack.users WHERE id = $1::uuid",
    )
    .bind(&claims.sub)
    .fetch_one(&state.pg_pool)
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
    .execute(&state.pg_pool)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

// ---------- Helpers ----------

/// Extract and validate JWT claims from request headers.
fn extract_claims_from_headers(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Claims, AppError> {
    let secret = state.config.jwt_secret.as_ref().ok_or_else(|| {
        AppError::Internal("JWT_SECRET not configured".into())
    })?;

    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    let token = jwt::extract_token_from_header(auth_header, None, None)
        .ok_or_else(|| AppError::Unauthorized("missing authorization header".into()))?;

    // Check if it's the anon key (not a JWT)
    if let Some(ref anon_key) = state.config.anon_key {
        if token == *anon_key {
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
        exp: Some(now + ACCESS_TOKEN_EXPIRY_SECS),
    };

    let access_token =
        jwt::generate_token(&claims, secret).map_err(AppError::Internal)?;

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
    .bind(REFRESH_TOKEN_EXPIRY_DAYS)
    .execute(&state.pg_pool)
    .await?;

    Ok((access_token, refresh_token))
}

pub(crate) fn generate_refresh_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..32).map(|_| rng.gen()).collect();
    base64_url_encode(&bytes)
}

pub(crate) fn base64_url_encode(data: &[u8]) -> String {
    use base64ct::{Base64UrlUnpadded, Encoding};
    Base64UrlUnpadded::encode_string(data)
}
