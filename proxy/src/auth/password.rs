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
}
