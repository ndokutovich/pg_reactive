//! JWKS-based `id_token` verification — Rust mirror of
//! `proxy-go/auth/idtoken.go` (audit F3, rounds 13–15).
//!
//! Apple, Microsoft and generic OIDC return the user's identity inside an
//! `id_token` JWT rather than (or in addition to) a userinfo endpoint. We
//! fetch the provider's JWKS, resolve the signing key by `kid`, verify the
//! RS*/ES* signature, and check `iss` / `aud` / `exp` before trusting the
//! `email` claim. The caller still gates on the returned `email_verified`.
//!
//! Design notes (kept faithful to the Go reference):
//!   - per-`jwks_uri` in-memory cache with a 24h TTL; on `kid` miss the cache
//!     is refetched exactly once (key rotation) before failing closed.
//!   - RS256/384/512 and ES256/384/512 are accepted. HS* is intentionally
//!     refused — the classic JWT alg-confusion footgun.
//!   - `iss` is checked via a caller-supplied predicate (Microsoft's "common"
//!     tenant rewrites `iss` per-user, so a literal match is impossible).
//!   - `aud` matches a string OR a member of a string array (RFC 7519).
//!   - `exp` is required and validated with zero leeway (golang-jwt v5 default).

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::Value;

use crate::error::AppError;

const JWKS_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Algorithms permitted for an `id_token`. HS* is deliberately excluded (the
/// alg-confusion footgun). Go also lists ES512, but jsonwebtoken/ring does not
/// implement P-521 ECDSA; no real OIDC provider signs id_tokens with ES512
/// (Apple uses ES256, Google/Microsoft RS256), so the practical set is identical.
const ALLOWED_ALGS: [Algorithm; 5] = [
    Algorithm::RS256,
    Algorithm::RS384,
    Algorithm::RS512,
    Algorithm::ES256,
    Algorithm::ES384,
];

/// One JWK from a provider's JWKS document — only the fields we consume.
#[derive(Clone, Deserialize)]
struct Jwk {
    kty: Option<String>,
    kid: Option<String>,
    #[serde(default)]
    n: Option<String>,
    #[serde(default)]
    e: Option<String>,
    #[serde(default)]
    x: Option<String>,
    #[serde(default)]
    y: Option<String>,
}

#[derive(Deserialize)]
struct JwksDoc {
    keys: Vec<Jwk>,
}

struct CachedJwks {
    fetched_at: Instant,
    keys: HashMap<String, Jwk>, // kid -> jwk
}

fn jwks_cache() -> &'static RwLock<HashMap<String, CachedJwks>> {
    static CACHE: OnceLock<RwLock<HashMap<String, CachedJwks>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Shared HTTP client for JWKS fetches. 10s timeout mirrors the Go proxy's
/// `oauthHTTPClient` so a stalling provider cannot pin a callback task.
fn jwks_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("build JWKS http client")
    })
}

/// Caller-supplied predicate deciding whether a token's `iss` is acceptable.
/// `issuer_equals` for single-tenant providers (Apple, OIDC); a prefix/suffix
/// check for multi-tenant ones (Microsoft "common").
pub fn issuer_equals(want: &str) -> impl Fn(&str) -> bool + '_ {
    move |iss: &str| iss == want
}

/// Verify a provider `id_token` end-to-end, fetching+caching the JWKS as
/// needed. Returns `(email, email_verified)` on success.
pub async fn verify_id_token(
    id_token: &str,
    jwks_uri: &str,
    valid_issuer: impl Fn(&str) -> bool,
    expected_aud: &str,
) -> Result<(String, bool), AppError> {
    let header = decode_header(id_token)
        .map_err(|e| AppError::Unauthorized(format!("id_token header: {e}")))?;
    let kid = header
        .kid
        .clone()
        .ok_or_else(|| AppError::Unauthorized("id_token missing kid header".into()))?;

    // Fast path: a fresh cache entry that already holds this kid.
    if let Some(keys) = cache_get_fresh_with_kid(jwks_uri, &kid) {
        return verify_with_keys(id_token, &keys, valid_issuer, expected_aud);
    }

    // Slow path: (re)fetch the JWKS exactly once. This covers both a stale
    // cache and an unknown kid (provider key rotation), mirroring the single
    // refresh the Go keyfunc performs before giving up.
    let keys = fetch_jwks(jwks_uri).await?;
    cache_put(jwks_uri, &keys);
    verify_with_keys(id_token, &keys, valid_issuer, expected_aud)
}

/// Core verification against an already-resolved `kid -> Jwk` map. Pure and
/// network-free, so the unit tests exercise it directly (mirror `idtoken_test.go`).
fn verify_with_keys(
    id_token: &str,
    keys: &HashMap<String, Jwk>,
    valid_issuer: impl Fn(&str) -> bool,
    expected_aud: &str,
) -> Result<(String, bool), AppError> {
    let header = decode_header(id_token)
        .map_err(|e| AppError::Unauthorized(format!("id_token header: {e}")))?;

    // alg-confusion guard: refuse anything outside RS*/ES* (notably HS*).
    if !ALLOWED_ALGS.contains(&header.alg) {
        return Err(AppError::Unauthorized(format!(
            "disallowed id_token alg {:?}",
            header.alg
        )));
    }
    let kid = header
        .kid
        .ok_or_else(|| AppError::Unauthorized("id_token missing kid header".into()))?;
    let jwk = keys
        .get(&kid)
        .ok_or_else(|| AppError::Unauthorized(format!("kid {kid:?} not in JWKS")))?;
    let key = jwk_to_decoding_key(jwk)?;

    // Validate against exactly the header alg (already proven to be in
    // ALLOWED_ALGS above, so HS* is excluded). jsonwebtoken requires every entry
    // in `validation.algorithms` to match the single resolved key's family, so a
    // mixed RS*/ES* list is rejected — narrowing to the one alg is both correct
    // and keeps the family check meaningful (an ES256 header against an RSA kid
    // still fails).
    let mut validation = Validation::new(header.alg);
    // Require exp explicitly (mirror Go's WithExpirationRequired): a token with
    // no expiry must be refused, not treated as "forever valid".
    validation.set_required_spec_claims(&["exp"]);
    validation.validate_exp = true;
    // iss + aud are validated manually below (predicate iss, string-or-array
    // aud) so jsonwebtoken's exact-set checks are turned off here.
    validation.validate_aud = false;
    // golang-jwt v5 enforces exp with zero clock-skew leeway; match it.
    validation.leeway = 0;

    #[derive(Deserialize)]
    struct IdClaims {
        iss: Option<String>,
        email: Option<String>,
        #[serde(default)]
        email_verified: Option<Value>,
        #[serde(default)]
        aud: Option<Value>,
    }

    let data = decode::<IdClaims>(id_token, &key, &validation)
        .map_err(|e| AppError::Unauthorized(format!("verify id_token: {e}")))?;
    let claims = data.claims;

    let iss = claims.iss.unwrap_or_default();
    if iss.is_empty() || !valid_issuer(&iss) {
        return Err(AppError::Unauthorized(format!("iss rejected: {iss:?}")));
    }
    if !aud_matches(claims.aud.as_ref(), expected_aud) {
        return Err(AppError::Unauthorized(format!(
            "aud does not contain {expected_aud:?}"
        )));
    }

    let email = claims
        .email
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Unauthorized("email claim missing or empty".into()))?;
    Ok((email, claim_true(claims.email_verified.as_ref())))
}

/// Build a `DecodingKey` from a JWK's public components (RSA `n`/`e` or EC
/// `x`/`y`). All values are already base64url per the JWK spec, which is the
/// exact form `from_rsa_components` / `from_ec_components` expect.
fn jwk_to_decoding_key(j: &Jwk) -> Result<DecodingKey, AppError> {
    match j.kty.as_deref() {
        Some("RSA") => {
            let n =
                j.n.as_deref()
                    .ok_or_else(|| AppError::Unauthorized("RSA JWK missing n".into()))?;
            let e =
                j.e.as_deref()
                    .ok_or_else(|| AppError::Unauthorized("RSA JWK missing e".into()))?;
            DecodingKey::from_rsa_components(n, e)
                .map_err(|err| AppError::Unauthorized(format!("bad RSA JWK: {err}")))
        }
        Some("EC") => {
            let x =
                j.x.as_deref()
                    .ok_or_else(|| AppError::Unauthorized("EC JWK missing x".into()))?;
            let y =
                j.y.as_deref()
                    .ok_or_else(|| AppError::Unauthorized("EC JWK missing y".into()))?;
            DecodingKey::from_ec_components(x, y)
                .map_err(|err| AppError::Unauthorized(format!("bad EC JWK: {err}")))
        }
        other => Err(AppError::Unauthorized(format!(
            "unsupported JWK kty {other:?}"
        ))),
    }
}

async fn fetch_jwks(jwks_uri: &str) -> Result<HashMap<String, Jwk>, AppError> {
    let resp = jwks_client()
        .get(jwks_uri)
        .header("Accept", "application/json")
        .header("User-Agent", "pgstack-proxy/1.0")
        .send()
        .await
        .map_err(|e| AppError::ServiceUnavailable(format!("fetch JWKS {jwks_uri}: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::ServiceUnavailable(format!(
            "JWKS {jwks_uri} returned {}",
            resp.status()
        )));
    }
    let doc: JwksDoc = resp
        .json()
        .await
        .map_err(|e| AppError::ServiceUnavailable(format!("parse JWKS {jwks_uri}: {e}")))?;

    let mut map = HashMap::with_capacity(doc.keys.len());
    for k in doc.keys {
        let Some(kid) = k.kid.clone().filter(|s| !s.is_empty()) else {
            continue;
        };
        // Keep only keys we can actually turn into a verifier.
        if jwk_to_decoding_key(&k).is_ok() {
            map.insert(kid, k);
        }
    }
    if map.is_empty() {
        return Err(AppError::ServiceUnavailable(
            "JWKS contained no usable keys".into(),
        ));
    }
    Ok(map)
}

fn cache_get_fresh_with_kid(jwks_uri: &str, kid: &str) -> Option<HashMap<String, Jwk>> {
    let cache = jwks_cache().read().ok()?;
    let entry = cache.get(jwks_uri)?;
    if entry.fetched_at.elapsed() < JWKS_TTL && entry.keys.contains_key(kid) {
        Some(entry.keys.clone())
    } else {
        None
    }
}

fn cache_put(jwks_uri: &str, keys: &HashMap<String, Jwk>) {
    if let Ok(mut cache) = jwks_cache().write() {
        cache.insert(
            jwks_uri.to_string(),
            CachedJwks {
                fetched_at: Instant::now(),
                keys: keys.clone(),
            },
        );
    }
}

/// Normalise the bool/string forms of an `email_verified` claim. OIDC requires
/// a bool but real providers occasionally send the string `"true"`.
pub(crate) fn claim_true(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// `aud` accepts both the string and string-array shapes RFC 7519 permits.
fn aud_matches(c: Option<&Value>, want: &str) -> bool {
    match c {
        Some(Value::String(s)) => s == want,
        Some(Value::Array(arr)) => arr.iter().any(|v| v.as_str() == Some(want)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    // P-256 test key (PKCS#8 PEM) + its public point (base64url x/y), generated
    // offline with openssl. The JWK below advertises exactly this key under
    // "test-kid"; a second key signs the wrong-signature case.
    const K1_PKCS8: &str = "-----BEGIN PRIVATE KEY-----\n\
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgx+Y5pHGNC/FW/ggt\n\
4hRpvz7D/AYjtDw2j6iTVa6wQeihRANCAAQqA81Nv/hrVENyqlTuNbNw5Ir+rSLb\n\
CX0AJpCEgyAJlemdUUcsPKtKsKHKThLWWXLOCdEyU5ta0EEooXsC/k5n\n\
-----END PRIVATE KEY-----\n";
    const K1_X: &str = "KgPNTb_4a1RDcqpU7jWzcOSK_q0i2wl9ACaQhIMgCZU";
    const K1_Y: &str = "6Z1RRyw8q0qwocpOEtZZcs4J0TJTm1rQQSihewL-Tmc";

    const K2_PKCS8: &str = "-----BEGIN PRIVATE KEY-----\n\
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJHV/H1rKI2hS/ku4\n\
6qgbFkpI3Tu4DgR7WBPHjZaMCLChRANCAAT0Xemqe/xeWZUK3up+DwRW9z70lzNV\n\
baAJKQEwi8no4mmYgkPmGGvVcIIVfZPM6SF9pr294DKrU2Nj9MH7pDyY\n\
-----END PRIVATE KEY-----\n";

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    fn test_keys() -> HashMap<String, Jwk> {
        let mut m = HashMap::new();
        m.insert(
            "test-kid".to_string(),
            Jwk {
                kty: Some("EC".into()),
                kid: Some("test-kid".into()),
                n: None,
                e: None,
                x: Some(K1_X.into()),
                y: Some(K1_Y.into()),
            },
        );
        m
    }

    fn sign_es256(pkcs8_pem: &str, kid: &str, claims: &Value) -> String {
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(kid.to_string());
        let key = EncodingKey::from_ec_pem(pkcs8_pem.as_bytes()).expect("load EC key");
        encode(&header, claims, &key).expect("sign ES256")
    }

    #[test]
    fn happy_path_verifies_and_reads_email() {
        let token = sign_es256(
            K1_PKCS8,
            "test-kid",
            &json!({
                "iss": "https://idp.test",
                "aud": "pgstack-client",
                "exp": now() + 300,
                "email": "user@example.com",
                "email_verified": true,
            }),
        );
        let (email, verified) = verify_with_keys(
            &token,
            &test_keys(),
            issuer_equals("https://idp.test"),
            "pgstack-client",
        )
        .expect("verify");
        assert_eq!(email, "user@example.com");
        assert!(verified);
    }

    #[test]
    fn missing_exp_rejected() {
        let token = sign_es256(
            K1_PKCS8,
            "test-kid",
            &json!({
                "iss": "https://idp.test",
                "aud": "pgstack-client",
                "email": "u@example.com",
                "email_verified": true,
            }),
        );
        assert!(verify_with_keys(
            &token,
            &test_keys(),
            issuer_equals("https://idp.test"),
            "pgstack-client"
        )
        .is_err());
    }

    #[test]
    fn expired_exp_rejected() {
        let token = sign_es256(
            K1_PKCS8,
            "test-kid",
            &json!({
                "iss": "https://idp.test",
                "aud": "pgstack-client",
                "exp": now() - 60,
                "email": "u@example.com",
                "email_verified": true,
            }),
        );
        assert!(verify_with_keys(
            &token,
            &test_keys(),
            issuer_equals("https://idp.test"),
            "pgstack-client"
        )
        .is_err());
    }

    #[test]
    fn wrong_iss_rejected() {
        let token = sign_es256(
            K1_PKCS8,
            "test-kid",
            &json!({
                "iss": "https://attacker.test",
                "aud": "pgstack-client",
                "exp": now() + 300,
                "email": "u@example.com",
                "email_verified": true,
            }),
        );
        assert!(verify_with_keys(
            &token,
            &test_keys(),
            issuer_equals("https://idp.test"),
            "pgstack-client"
        )
        .is_err());
    }

    #[test]
    fn wrong_aud_rejected() {
        let token = sign_es256(
            K1_PKCS8,
            "test-kid",
            &json!({
                "iss": "https://idp.test",
                "aud": "different-client",
                "exp": now() + 300,
                "email": "u@example.com",
                "email_verified": true,
            }),
        );
        assert!(verify_with_keys(
            &token,
            &test_keys(),
            issuer_equals("https://idp.test"),
            "pgstack-client"
        )
        .is_err());
    }

    #[test]
    fn aud_array_match_accepted() {
        let token = sign_es256(
            K1_PKCS8,
            "test-kid",
            &json!({
                "iss": "https://idp.test",
                "aud": ["other-client", "pgstack-client", "third"],
                "exp": now() + 300,
                "email": "u@example.com",
                "email_verified": true,
            }),
        );
        assert!(verify_with_keys(
            &token,
            &test_keys(),
            issuer_equals("https://idp.test"),
            "pgstack-client"
        )
        .is_ok());
    }

    #[test]
    fn wrong_signature_rejected() {
        // Signed with K2 but the JWKS advertises K1 under the same kid.
        let token = sign_es256(
            K2_PKCS8,
            "test-kid",
            &json!({
                "iss": "https://idp.test",
                "aud": "pgstack-client",
                "exp": now() + 300,
                "email": "u@example.com",
                "email_verified": true,
            }),
        );
        assert!(verify_with_keys(
            &token,
            &test_keys(),
            issuer_equals("https://idp.test"),
            "pgstack-client"
        )
        .is_err());
    }

    #[test]
    fn unknown_kid_rejected() {
        let token = sign_es256(
            K1_PKCS8,
            "kid-not-in-jwks",
            &json!({
                "iss": "https://idp.test",
                "aud": "pgstack-client",
                "exp": now() + 300,
                "email": "u@example.com",
                "email_verified": true,
            }),
        );
        assert!(verify_with_keys(
            &token,
            &test_keys(),
            issuer_equals("https://idp.test"),
            "pgstack-client"
        )
        .is_err());
    }

    #[test]
    fn hs256_alg_confusion_rejected() {
        // Classic alg-confusion: HS256 token reusing the advertised kid. Must be
        // refused before the JWKS public key is ever treated as an HMAC secret.
        let mut header = Header::new(Algorithm::HS256);
        header.kid = Some("test-kid".into());
        let token = encode(
            &header,
            &json!({
                "iss": "https://idp.test",
                "aud": "pgstack-client",
                "exp": now() + 300,
                "email": "u@example.com",
                "email_verified": true,
            }),
            &EncodingKey::from_secret(b"any-secret"),
        )
        .unwrap();
        assert!(verify_with_keys(
            &token,
            &test_keys(),
            issuer_equals("https://idp.test"),
            "pgstack-client"
        )
        .is_err());
    }

    #[test]
    fn email_verified_false_is_propagated() {
        let token = sign_es256(
            K1_PKCS8,
            "test-kid",
            &json!({
                "iss": "https://idp.test",
                "aud": "pgstack-client",
                "exp": now() + 300,
                "email": "u@example.com",
                "email_verified": false,
            }),
        );
        let (_, verified) = verify_with_keys(
            &token,
            &test_keys(),
            issuer_equals("https://idp.test"),
            "pgstack-client",
        )
        .unwrap();
        assert!(!verified);
    }

    #[test]
    fn aud_matches_shapes() {
        assert!(aud_matches(Some(&json!("a")), "a"));
        assert!(!aud_matches(Some(&json!("a")), "b"));
        assert!(aud_matches(Some(&json!(["x", "a", "y"])), "a"));
        assert!(!aud_matches(Some(&json!(["x", "y"])), "a"));
        assert!(!aud_matches(None, "a"));
    }

    #[test]
    fn claim_true_shapes() {
        assert!(claim_true(Some(&json!(true))));
        assert!(!claim_true(Some(&json!(false))));
        assert!(claim_true(Some(&json!("true"))));
        assert!(claim_true(Some(&json!("TRUE"))));
        assert!(!claim_true(Some(&json!("false"))));
        assert!(!claim_true(Some(&json!(1))));
        assert!(!claim_true(None));
    }
}
