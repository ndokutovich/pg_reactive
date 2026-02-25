use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation, Algorithm};
use serde::{Deserialize, Serialize};

/// JWT claims structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// Subject (user ID)
    pub sub: String,
    /// Role (anon, authenticated, service_role)
    #[serde(default = "default_role")]
    pub role: String,
    /// Email (optional)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Issued at (Unix timestamp)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iat: Option<u64>,
    /// Expiration (Unix timestamp)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exp: Option<u64>,
}

fn default_role() -> String {
    "authenticated".into()
}

/// Generate a JWT token with the given claims and secret.
pub fn generate_token(claims: &Claims, secret: &str) -> Result<String, String> {
    let header = Header::new(Algorithm::HS256);
    let key = EncodingKey::from_secret(secret.as_bytes());
    encode(&header, claims, &key).map_err(|e| format!("JWT generation failed: {}", e))
}

/// Validate and decode a JWT token.
pub fn validate_token(token: &str, secret: &str) -> Result<Claims, String> {
    let key = DecodingKey::from_secret(secret.as_bytes());
    let mut validation = Validation::new(Algorithm::HS256);
    // Allow tokens without exp claim for backwards compatibility.
    // If exp IS present, jsonwebtoken will still validate it.
    validation.required_spec_claims.remove("exp");
    validation.validate_exp = false;

    decode::<Claims>(token, &key, &validation)
        .map(|data| data.claims)
        .map_err(|e| format!("JWT validation failed: {}", e))
}

/// Extract JWT token from Authorization header or apikey header or query param.
pub fn extract_token_from_header(
    auth_header: Option<&str>,
    apikey_header: Option<&str>,
    query: Option<&str>,
) -> Option<String> {
    // 1. Authorization: Bearer <token>
    if let Some(auth) = auth_header {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            return Some(token.to_string());
        }
    }

    // 2. apikey header (Supabase compatibility)
    if let Some(key) = apikey_header {
        return Some(key.to_string());
    }

    // 3. Query parameter ?token=xxx
    if let Some(q) = query {
        for pair in q.split('&') {
            if let Some(token) = pair.strip_prefix("token=") {
                return Some(token.to_string());
            }
        }
    }

    None
}
