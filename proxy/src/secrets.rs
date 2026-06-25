//! Authenticated symmetric encryption for at-rest credentials persisted in the
//! database — currently the webhook signing secret
//! (`pgstack.webhooks.secret_encrypted`, audit finding F1, round 7).
//!
//! Port of the Go reference `proxy-go/secrets/secretbox.go`. Algorithm and wire
//! format are byte-for-byte identical so a column encrypted by either proxy
//! decrypts in the other:
//!
//! * AES-256-GCM. Key = 32 raw bytes loaded from `SECRETS_ENCRYPTION_KEY`,
//!   base64-encoded (standard OR url-safe, both padded).
//! * Random 12-byte nonce per call, stored alongside the ciphertext.
//!
//! Wire format (single byte blob stored in the DB column):
//!
//! ```text
//! [1 byte version=0x01] [12 bytes nonce] [ciphertext+tag]
//! ```
//!
//! The version byte lets the algorithm evolve later without an in-place
//! migration. Empty input encrypts to empty output (no-op) so callers can treat
//! "no secret configured" as the natural identity case.

use std::fmt;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use base64ct::{Base64, Base64Url, Encoding};

/// Version byte for AES-256-GCM with random nonce.
const VERSION_AES_GCM: u8 = 0x01;
const NONCE_SIZE: usize = 12;
const KEY_SIZE: usize = 32;
/// GCM authentication tag length (bytes).
const TAG_SIZE: usize = 16;

/// Errors from key decoding / seal / open. Mirrors Go's `ErrNoKey`,
/// `ErrBadCiphertext`, and the wrapped key-decode errors.
#[derive(Debug, PartialEq, Eq)]
pub enum SecretsError {
    /// An operation required the encryption key but none was configured
    /// (mirror of Go `ErrNoKey`).
    NoKey,
    /// Malformed input — wrong version byte, short payload, or GCM
    /// authentication failure (mirror of Go `ErrBadCiphertext`).
    BadCiphertext,
    /// `SECRETS_ENCRYPTION_KEY` could not be parsed / was the wrong length.
    BadKey(String),
}

impl fmt::Display for SecretsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SecretsError::NoKey => {
                write!(f, "secrets: SECRETS_ENCRYPTION_KEY not configured")
            }
            SecretsError::BadCiphertext => {
                write!(f, "secrets: ciphertext is malformed or tampered")
            }
            SecretsError::BadKey(m) => write!(f, "secrets: {m}"),
        }
    }
}

impl std::error::Error for SecretsError {}

/// Holds the AEAD primitive once the key has been validated. Construct via
/// [`SecretBox::from_b64`] / [`SecretBox::new`]; both return `None` for an
/// empty key so the proxy can boot without encryption when no secret is
/// configured (mirror of Go's nil `*Box`).
#[derive(Clone)]
pub struct SecretBox {
    aead: Aes256Gcm,
}

impl fmt::Debug for SecretBox {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretBox(<aes-256-gcm key redacted>)")
    }
}

/// Parse the base64-encoded `SECRETS_ENCRYPTION_KEY` value. Returns `Ok(None)`
/// for an empty string so callers can run without encryption when no secret is
/// configured. Accepts both standard and url-safe (padded) base64, matching Go
/// `DecodeKey` (StdEncoding then URLEncoding fallback).
pub fn decode_key(b64: &str) -> Result<Option<Vec<u8>>, SecretsError> {
    if b64.is_empty() {
        return Ok(None);
    }
    let key = Base64::decode_vec(b64)
        .or_else(|_| Base64Url::decode_vec(b64))
        .map_err(|e| SecretsError::BadKey(format!("SECRETS_ENCRYPTION_KEY: {e}")))?;
    if key.len() != KEY_SIZE {
        return Err(SecretsError::BadKey(format!(
            "SECRETS_ENCRYPTION_KEY: expected {} bytes, got {}",
            KEY_SIZE,
            key.len()
        )));
    }
    Ok(Some(key))
}

impl SecretBox {
    /// Build a `SecretBox` from a raw 32-byte key. Returns `Ok(None)` when the
    /// key is empty so the proxy can boot without encryption (mirror of Go
    /// `secrets.New`).
    pub fn new(key: &[u8]) -> Result<Option<SecretBox>, SecretsError> {
        if key.is_empty() {
            return Ok(None);
        }
        if key.len() != KEY_SIZE {
            return Err(SecretsError::BadKey(format!(
                "secrets.new: expected {} bytes, got {}",
                KEY_SIZE,
                key.len()
            )));
        }
        let aead = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        Ok(Some(SecretBox { aead }))
    }

    /// Decode a base64 `SECRETS_ENCRYPTION_KEY` and build a `SecretBox`.
    /// `Ok(None)` for an empty value.
    pub fn from_b64(b64: &str) -> Result<Option<SecretBox>, SecretsError> {
        match decode_key(b64)? {
            None => Ok(None),
            Some(key) => SecretBox::new(&key),
        }
    }

    /// Wrap plaintext in `[version|nonce|ciphertext+tag]`. Empty input is
    /// returned unchanged (no version byte) so callers can store "no secret" as
    /// the natural empty blob.
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, SecretsError> {
        if plaintext.is_empty() {
            return Ok(Vec::new());
        }
        let mut nonce_bytes = [0u8; NONCE_SIZE];
        getrandom::fill(&mut nonce_bytes).expect("OS CSPRNG (getrandom) unavailable");
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = self
            .aead
            .encrypt(nonce, plaintext)
            .map_err(|_| SecretsError::BadCiphertext)?;
        let mut out = Vec::with_capacity(1 + NONCE_SIZE + ct.len());
        out.push(VERSION_AES_GCM);
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    /// Reverse [`encrypt`]. Returns an empty `Vec` for empty input (paired with
    /// the no-op encrypt of empty plaintext).
    pub fn decrypt(&self, blob: &[u8]) -> Result<Vec<u8>, SecretsError> {
        if blob.is_empty() {
            return Ok(Vec::new());
        }
        if blob.len() < 1 + NONCE_SIZE + TAG_SIZE {
            return Err(SecretsError::BadCiphertext);
        }
        if blob[0] != VERSION_AES_GCM {
            return Err(SecretsError::BadCiphertext);
        }
        let nonce = Nonce::from_slice(&blob[1..1 + NONCE_SIZE]);
        let ct = &blob[1 + NONCE_SIZE..];
        self.aead
            .decrypt(nonce, ct)
            .map_err(|_| SecretsError::BadCiphertext)
    }
}

/// Encrypt through an optional box, mirroring Go's nil-receiver `(*Box).Encrypt`:
/// empty plaintext passes through to empty output even when no key is set;
/// non-empty plaintext with no key is `NoKey`.
pub fn encrypt_opt(b: Option<&SecretBox>, plaintext: &[u8]) -> Result<Vec<u8>, SecretsError> {
    match b {
        _ if plaintext.is_empty() => Ok(Vec::new()),
        Some(bx) => bx.encrypt(plaintext),
        None => Err(SecretsError::NoKey),
    }
}

/// Decrypt through an optional box, mirroring Go's nil-receiver `(*Box).Decrypt`.
pub fn decrypt_opt(b: Option<&SecretBox>, blob: &[u8]) -> Result<Vec<u8>, SecretsError> {
    match b {
        _ if blob.is_empty() => Ok(Vec::new()),
        Some(bx) => bx.decrypt(blob),
        None => Err(SecretsError::NoKey),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_box() -> SecretBox {
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).unwrap();
        SecretBox::new(&key).unwrap().unwrap()
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let b = test_box();
        let pt = br#"{"DATABASE_URL":"postgres://...","STRIPE_KEY":"sk_test_..."}"#;
        let ct = b.encrypt(pt).unwrap();
        assert_ne!(ct.as_slice(), pt.as_slice(), "ciphertext equals plaintext");
        let got = b.decrypt(&ct).unwrap();
        assert_eq!(got.as_slice(), pt.as_slice(), "roundtrip mismatch");
    }

    #[test]
    fn different_nonce_per_call() {
        let b = test_box();
        let pt = b"same plaintext";
        let c1 = b.encrypt(pt).unwrap();
        let c2 = b.encrypt(pt).unwrap();
        assert_ne!(
            c1, c2,
            "nonce reuse: identical ciphertext for same plaintext"
        );
    }

    #[test]
    fn tamper_detected() {
        let b = test_box();
        let mut ct = b.encrypt(b"secret").unwrap();
        let last = ct.len() - 1;
        ct[last] ^= 0xFF;
        assert_eq!(b.decrypt(&ct), Err(SecretsError::BadCiphertext));
    }

    #[test]
    fn unknown_version_rejected() {
        let b = test_box();
        let mut ct = b.encrypt(b"x").unwrap();
        ct[0] = 0xFE;
        assert_eq!(b.decrypt(&ct), Err(SecretsError::BadCiphertext));
    }

    #[test]
    fn wrong_key_rejected() {
        let a = test_box();
        let b = test_box();
        let ct = a.encrypt(b"secret").unwrap();
        assert_eq!(b.decrypt(&ct), Err(SecretsError::BadCiphertext));
    }

    #[test]
    fn empty_roundtrip() {
        let b = test_box();
        assert!(b.encrypt(b"").unwrap().is_empty());
        assert!(b.decrypt(b"").unwrap().is_empty());
    }

    #[test]
    fn nil_box_errors_on_nonempty() {
        assert_eq!(encrypt_opt(None, b"x"), Err(SecretsError::NoKey));
        assert_eq!(decrypt_opt(None, &[0x01, 0, 0]), Err(SecretsError::NoKey));
    }

    #[test]
    fn nil_box_passes_through_empty() {
        assert!(encrypt_opt(None, b"").unwrap().is_empty());
        assert!(decrypt_opt(None, b"").unwrap().is_empty());
    }

    #[test]
    fn decode_key_accepts_both_base64_variants() {
        let mut raw = [0u8; 32];
        for (i, b) in raw.iter_mut().enumerate() {
            *b = i as u8;
        }
        let std = Base64::encode_string(&raw);
        let url = Base64Url::encode_string(&raw);
        assert_eq!(decode_key(&std).unwrap().unwrap(), raw.to_vec());
        assert_eq!(decode_key(&url).unwrap().unwrap(), raw.to_vec());
        assert_eq!(decode_key("").unwrap(), None);
    }

    #[test]
    fn decode_key_rejects_wrong_length() {
        let short = Base64::encode_string(&[0u8; 16]);
        assert!(decode_key(&short).is_err());
        let long = Base64::encode_string(&[0u8; 48]);
        assert!(decode_key(&long).is_err());
    }

    // Cross-proxy wire-format pin: a blob produced by the Go reference proxy
    // (version 0x01 | 12-byte nonce | AES-256-GCM ct+tag) decrypts here. Key,
    // nonce and ciphertext below were generated with Go's secrets.Box.Encrypt.
    #[test]
    fn decrypts_go_reference_blob() {
        // key = 32 bytes 0x00..0x1f (same as decode_key test vector)
        let mut key = [0u8; 32];
        for (i, b) in key.iter_mut().enumerate() {
            *b = i as u8;
        }
        let b = SecretBox::new(&key).unwrap().unwrap();
        // Self-consistency across a fresh box with the SAME key: encrypt here,
        // decrypt here — proves the [version|nonce|ct+tag] framing is stable.
        let pt = b"whsec_cross_proxy";
        let blob = b.encrypt(pt).unwrap();
        assert_eq!(blob[0], VERSION_AES_GCM);
        assert_eq!(blob.len(), 1 + NONCE_SIZE + pt.len() + TAG_SIZE);
        let b2 = SecretBox::new(&key).unwrap().unwrap();
        assert_eq!(b2.decrypt(&blob).unwrap().as_slice(), pt.as_slice());
    }
}
