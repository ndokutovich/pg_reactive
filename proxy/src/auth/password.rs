use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2, Params,
};

/// Hash a password using argon2id with OWASP-recommended parameters.
/// Parameters: 19 MiB memory, 2 iterations, 1 parallelism.
pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let params = Params::new(19 * 1024, 2, 1, None)
        .map_err(|e| format!("argon2 params error: {}", e))?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);

    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| format!("password hash error: {}", e))
}

/// Verify a password against an argon2id hash.
pub fn verify_password(password: &str, hash: &str) -> Result<bool, String> {
    let parsed_hash =
        PasswordHash::new(hash).map_err(|e| format!("invalid hash format: {}", e))?;

    match Argon2::default().verify_password(password.as_bytes(), &parsed_hash) {
        Ok(()) => Ok(true),
        Err(argon2::password_hash::Error::Password) => Ok(false),
        Err(e) => Err(format!("password verify error: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_and_verify() {
        let hash = hash_password("my_secret_password").unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password("my_secret_password", &hash).unwrap());
        assert!(!verify_password("wrong_password", &hash).unwrap());
    }

    // ---- hash format ----

    #[test]
    fn test_hash_starts_with_argon2id_prefix() {
        let hash = hash_password("password123").unwrap();
        assert!(
            hash.starts_with("$argon2id$"),
            "hash must use argon2id algorithm; got: {}",
            &hash[..20.min(hash.len())]
        );
    }

    #[test]
    fn test_hash_contains_version_and_params() {
        let hash = hash_password("testpass").unwrap();
        // A standard argon2id PHC string includes v= and m=, t=, p= segments
        assert!(hash.contains("v="), "hash must include version; got: {}", hash);
        assert!(hash.contains("m="), "hash must include memory param; got: {}", hash);
        assert!(hash.contains("t="), "hash must include time param; got: {}", hash);
        assert!(hash.contains("p="), "hash must include parallelism param; got: {}", hash);
    }

    // ---- salted: different each call ----

    #[test]
    fn test_hash_is_different_each_call() {
        let hash1 = hash_password("same_password").unwrap();
        let hash2 = hash_password("same_password").unwrap();
        assert_ne!(
            hash1, hash2,
            "two hashes of the same password must differ (salt randomness)"
        );
    }

    // ---- correct password verifies ----

    #[test]
    fn test_correct_password_verifies_true() {
        let pw = "correct_horse_battery_staple";
        let hash = hash_password(pw).unwrap();
        let ok = verify_password(pw, &hash).unwrap();
        assert!(ok);
    }

    // ---- wrong password does not verify ----

    #[test]
    fn test_wrong_password_verifies_false() {
        let hash = hash_password("real_password").unwrap();
        let ok = verify_password("wrong_password", &hash).unwrap();
        assert!(!ok);
    }

    #[test]
    fn test_empty_password_not_equal_to_nonempty() {
        let hash = hash_password("nonempty").unwrap();
        let ok = verify_password("", &hash).unwrap();
        assert!(!ok);
    }

    #[test]
    fn test_empty_password_can_be_hashed_and_verified() {
        let hash = hash_password("").unwrap();
        assert!(verify_password("", &hash).unwrap());
        assert!(!verify_password("notempty", &hash).unwrap());
    }

    // ---- unicode / special chars ----

    #[test]
    fn test_unicode_password() {
        let pw = "p@ssw0rd-with-unicode-\u{1F600}";
        let hash = hash_password(pw).unwrap();
        assert!(verify_password(pw, &hash).unwrap());
        assert!(!verify_password("p@ssw0rd-with-unicode-X", &hash).unwrap());
    }

    #[test]
    fn test_long_password() {
        let pw = "a".repeat(512);
        let hash = hash_password(&pw).unwrap();
        assert!(verify_password(&pw, &hash).unwrap());
        // One char shorter must not match
        let wrong = "a".repeat(511);
        assert!(!verify_password(&wrong, &hash).unwrap());
    }

    // ---- invalid hash format ----

    #[test]
    fn test_verify_against_garbage_hash_returns_error() {
        let result = verify_password("password", "not-a-valid-hash-string");
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("invalid hash format"));
    }

    #[test]
    fn test_verify_against_empty_hash_returns_error() {
        let result = verify_password("password", "");
        assert!(result.is_err());
    }

    // ---- cross-hash independence ----

    #[test]
    fn test_hash_of_a_does_not_verify_b() {
        let hash_a = hash_password("password_a").unwrap();
        let hash_b = hash_password("password_b").unwrap();
        assert!(!verify_password("password_a", &hash_b).unwrap());
        assert!(!verify_password("password_b", &hash_a).unwrap());
    }
}
