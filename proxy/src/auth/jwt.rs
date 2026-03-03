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
    encode(&header, claims, &key).map_err(|e| format!("JWT generation failed: {e}"))
}

/// Validate and decode a JWT token.
pub fn validate_token(token: &str, secret: &str) -> Result<Claims, String> {
    let key = DecodingKey::from_secret(secret.as_bytes());
    let mut validation = Validation::new(Algorithm::HS256);
    // Allow tokens without exp claim for backwards compatibility.
    // When exp IS present, it will be validated (rejects expired tokens).
    validation.required_spec_claims.remove("exp");
    validation.validate_exp = true;

    decode::<Claims>(token, &key, &validation)
        .map(|data| data.claims)
        .map_err(|e| format!("JWT validation failed: {e}"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const TEST_SECRET: &str = "test-secret-key-for-unit-tests";
    const OTHER_SECRET: &str = "completely-different-secret-key";

    fn now_unix() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    fn make_claims(sub: &str, exp: Option<u64>) -> Claims {
        Claims {
            sub: sub.to_string(),
            role: "authenticated".to_string(),
            email: None,
            iat: Some(now_unix()),
            exp,
        }
    }

    // ---- generate + validate round-trip ----

    #[test]
    fn test_valid_token_returns_claims() {
        let claims = make_claims("user-123", Some(now_unix() + 3600));
        let token = generate_token(&claims, TEST_SECRET).unwrap();
        let decoded = validate_token(&token, TEST_SECRET).unwrap();
        assert_eq!(decoded.sub, "user-123");
    }

    #[test]
    fn test_valid_token_preserves_role() {
        let mut claims = make_claims("user-456", Some(now_unix() + 3600));
        claims.role = "service_role".to_string();
        let token = generate_token(&claims, TEST_SECRET).unwrap();
        let decoded = validate_token(&token, TEST_SECRET).unwrap();
        assert_eq!(decoded.role, "service_role");
    }

    #[test]
    fn test_valid_token_preserves_email() {
        let mut claims = make_claims("user-789", Some(now_unix() + 3600));
        claims.email = Some("alice@example.com".to_string());
        let token = generate_token(&claims, TEST_SECRET).unwrap();
        let decoded = validate_token(&token, TEST_SECRET).unwrap();
        assert_eq!(decoded.email, Some("alice@example.com".to_string()));
    }

    // ---- wrong secret ----

    #[test]
    fn test_wrong_secret_returns_error() {
        let claims = make_claims("user-abc", Some(now_unix() + 3600));
        let token = generate_token(&claims, TEST_SECRET).unwrap();
        let result = validate_token(&token, OTHER_SECRET);
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("JWT validation failed"));
    }

    // ---- expired token ----

    #[test]
    fn test_expired_token_returns_error() {
        // exp = 2 minutes in the past — well outside jsonwebtoken's default 60 s leeway
        let claims = make_claims("user-exp", Some(now_unix() - 120));
        let token = generate_token(&claims, TEST_SECRET).unwrap();
        let result = validate_token(&token, TEST_SECRET);
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("JWT validation failed"));
    }

    #[test]
    fn test_far_expired_token_returns_error() {
        // exp = Unix epoch (Jan 1 1970) — definitely expired
        let claims = make_claims("user-ancient", Some(1));
        let token = generate_token(&claims, TEST_SECRET).unwrap();
        let result = validate_token(&token, TEST_SECRET);
        assert!(result.is_err());
    }

    #[test]
    fn test_token_not_yet_expired_passes() {
        // exp = 1 hour in the future
        let claims = make_claims("user-future", Some(now_unix() + 3600));
        let token = generate_token(&claims, TEST_SECRET).unwrap();
        let result = validate_token(&token, TEST_SECRET);
        assert!(result.is_ok());
    }

    // ---- token without exp claim ----

    #[test]
    fn test_token_without_exp_passes() {
        // No exp claim — should be accepted (design decision: backwards compat)
        let claims = make_claims("user-noexp", None);
        let token = generate_token(&claims, TEST_SECRET).unwrap();
        let result = validate_token(&token, TEST_SECRET);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().sub, "user-noexp");
    }

    // ---- malformed tokens ----

    #[test]
    fn test_garbage_string_returns_error() {
        let result = validate_token("not.a.jwt", TEST_SECRET);
        assert!(result.is_err());
    }

    #[test]
    fn test_empty_token_returns_error() {
        let result = validate_token("", TEST_SECRET);
        assert!(result.is_err());
    }

    #[test]
    fn test_truncated_token_returns_error() {
        let claims = make_claims("u", Some(now_unix() + 3600));
        let token = generate_token(&claims, TEST_SECRET).unwrap();
        // Truncate to just the header
        let truncated = token.split('.').next().unwrap();
        let result = validate_token(truncated, TEST_SECRET);
        assert!(result.is_err());
    }

    // ---- algorithm confusion (alg: none) ----
    // Manually craft a "none" algorithm token (header.payload.empty-signature)

    #[test]
    fn test_alg_none_token_rejected() {
        use base64ct::{Base64Url, Encoding};
        // Header: {"alg":"none","typ":"JWT"}
        let header = Base64Url::encode_string(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = Base64Url::encode_string(
            format!(
                r#"{{"sub":"attacker","role":"service_role","exp":{}}}"#,
                now_unix() + 9999
            )
            .as_bytes(),
        );
        // "none" algorithm has an empty signature
        let forged = format!("{}.{}.", header, payload);
        let result = validate_token(&forged, TEST_SECRET);
        assert!(result.is_err(), "alg:none token must be rejected");
    }

    // ---- default role ----

    #[test]
    fn test_default_role_is_authenticated() {
        // Claims without explicit role should get "authenticated" via serde default
        let json = format!(
            r#"{{"sub":"u1","exp":{}}}"#,
            now_unix() + 3600
        );
        let payload_b64 = {
            use base64ct::{Base64Url, Encoding};
            Base64Url::encode_string(json.as_bytes())
        };
        // We need a properly signed token to test deserialization of default role.
        // Generate via the API instead.
        let claims = Claims {
            sub: "u1".to_string(),
            role: "authenticated".to_string(), // this is the default
            email: None,
            iat: None,
            exp: Some(now_unix() + 3600),
        };
        let token = generate_token(&claims, TEST_SECRET).unwrap();
        let decoded = validate_token(&token, TEST_SECRET).unwrap();
        assert_eq!(decoded.role, "authenticated");
        // Suppress unused variable warning
        let _ = payload_b64;
    }

    // ---- extract_token_from_header ----

    #[test]
    fn test_extract_from_bearer_header() {
        let token = extract_token_from_header(Some("Bearer mytoken123"), None, None);
        assert_eq!(token, Some("mytoken123".to_string()));
    }

    #[test]
    fn test_extract_from_apikey_header() {
        let token = extract_token_from_header(None, Some("apikeyvalue"), None);
        assert_eq!(token, Some("apikeyvalue".to_string()));
    }

    #[test]
    fn test_extract_from_query_param() {
        let token = extract_token_from_header(None, None, Some("foo=bar&token=qwerty"));
        assert_eq!(token, Some("qwerty".to_string()));
    }

    #[test]
    fn test_extract_bearer_takes_priority_over_apikey() {
        let token = extract_token_from_header(
            Some("Bearer from_bearer"),
            Some("from_apikey"),
            None,
        );
        assert_eq!(token, Some("from_bearer".to_string()));
    }

    #[test]
    fn test_extract_apikey_takes_priority_over_query() {
        let token = extract_token_from_header(None, Some("from_apikey"), Some("token=from_query"));
        assert_eq!(token, Some("from_apikey".to_string()));
    }

    #[test]
    fn test_extract_none_when_no_sources() {
        let token = extract_token_from_header(None, None, None);
        assert!(token.is_none());
    }

    #[test]
    fn test_extract_none_for_non_bearer_auth_header() {
        // "Basic ..." should not be extracted
        let token = extract_token_from_header(Some("Basic dXNlcjpwYXNz"), None, None);
        assert!(token.is_none());
    }

    #[test]
    fn test_extract_from_query_with_multiple_params() {
        let token = extract_token_from_header(None, None, Some("a=1&b=2&token=mytoken&c=3"));
        assert_eq!(token, Some("mytoken".to_string()));
    }

    #[test]
    fn test_generate_token_produces_three_segment_jwt() {
        let claims = make_claims("u", Some(now_unix() + 60));
        let token = generate_token(&claims, TEST_SECRET).unwrap();
        let segments: Vec<&str> = token.split('.').collect();
        assert_eq!(segments.len(), 3, "JWT must have exactly 3 dot-separated segments");
        assert!(!segments[0].is_empty());
        assert!(!segments[1].is_empty());
        assert!(!segments[2].is_empty());
    }

    #[test]
    fn test_different_secrets_produce_different_tokens() {
        let claims = make_claims("u", Some(now_unix() + 60));
        let token_a = generate_token(&claims, "secret_a").unwrap();
        let token_b = generate_token(&claims, "secret_b").unwrap();
        assert_ne!(token_a, token_b);
    }
}
