//! Protection-password verifiers for saved SQL folders and connection groups.
//!
//! New verifiers are Argon2id PHC strings (`$argon2id$...`) minted here with a
//! per-item random salt. The verifier stays inside the local persistence
//! layer: clients send the plaintext password to a command and receive
//! matched / mismatched back, so a stored verifier never travels to a
//! frontend payload.
//!
//! Two formats written by earlier builds are still accepted and lazily
//! upgraded to Argon2 after a successful match:
//! - `pbkdf2-sha256$<iterations>$<salt-b64>$<hash-b64>` (PBKDF2-HMAC-SHA256,
//!   standard base64 with padding), written by earlier web builds, and
//! - a bare 64-char hex SHA-256 digest of `"dbx-connection-group:" + password`,
//!   the original unsalted format.

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use sha2::{Digest, Sha256};

const LEGACY_PBKDF2_PREFIX: &str = "pbkdf2-sha256$";
const LEGACY_SHA256_DOMAIN_PREFIX: &str = "dbx-connection-group:";
const SHA256_OUTPUT_BYTES: usize = 32;
const SHA256_BLOCK_BYTES: usize = 64;

/// Outcome of checking a plaintext password against a stored verifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtectionPasswordCheck {
    /// The password matches a verifier that already uses the current format.
    Matched,
    /// The password matches a legacy verifier. Callers should persist
    /// `upgraded_hash`; it is absent only when re-hashing unexpectedly failed.
    MatchedLegacy { upgraded_hash: Option<String> },
    /// The password does not match the stored verifier.
    Mismatch,
}

/// Mint a fresh verifier for `password` with a random per-item salt.
pub fn hash_protection_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| format!("Failed to hash protection password: {error}"))
}

/// Check a plaintext password against a stored verifier, dispatching on the
/// stored format first. The stored string must not be fed to
/// `PasswordHash::new` blindly: the old `pbkdf2-sha256$...` value parses as a
/// generic PHC string and would fail every Argon2 verification.
pub fn check_protection_password(password: &str, stored: &str) -> ProtectionPasswordCheck {
    if stored.starts_with("$argon2") {
        return match PasswordHash::new(stored) {
            Ok(parsed) if Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok() => {
                ProtectionPasswordCheck::Matched
            }
            _ => ProtectionPasswordCheck::Mismatch,
        };
    }
    let matched_legacy = if let Some(body) = stored.strip_prefix(LEGACY_PBKDF2_PREFIX) {
        verify_legacy_pbkdf2(password, body)
    } else {
        verify_legacy_sha256(password, stored)
    };
    if matched_legacy {
        ProtectionPasswordCheck::MatchedLegacy { upgraded_hash: hash_protection_password(password).ok() }
    } else {
        ProtectionPasswordCheck::Mismatch
    }
}

/// `pbkdf2-sha256$<iterations>$<salt-b64>$<hash-b64>` written by earlier web
/// builds (PBKDF2-HMAC-SHA256); the verifier length picks the derived key
/// length.
fn verify_legacy_pbkdf2(password: &str, body: &str) -> bool {
    let mut parts = body.split('$');
    let (Some(iterations), Some(salt_b64), Some(hash_b64), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let Ok(iterations) = iterations.parse::<u32>() else { return false };
    if iterations == 0 {
        return false;
    }
    let Ok(salt) = BASE64_STANDARD.decode(salt_b64) else { return false };
    let Ok(expected) = BASE64_STANDARD.decode(hash_b64) else { return false };
    if salt.is_empty() || expected.is_empty() {
        return false;
    }
    let derived = pbkdf2_hmac_sha256(password.as_bytes(), &salt, iterations, expected.len());
    constant_time_eq(&derived, &expected)
}

/// Legacy unsalted SHA-256 of `"dbx-connection-group:" + password`, stored as
/// a bare 64-char hex string.
fn verify_legacy_sha256(password: &str, stored: &str) -> bool {
    let Some(expected) = decode_hex_32(stored) else { return false };
    let mut hasher = Sha256::new();
    hasher.update(LEGACY_SHA256_DOMAIN_PREFIX.as_bytes());
    hasher.update(password.as_bytes());
    let digest = hasher.finalize();
    constant_time_eq(digest.as_slice(), &expected)
}

fn decode_hex_32(value: &str) -> Option<[u8; SHA256_OUTPUT_BYTES]> {
    if value.len() != SHA256_OUTPUT_BYTES * 2 {
        return None;
    }
    let mut output = [0u8; SHA256_OUTPUT_BYTES];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(value.get(index * 2..index * 2 + 2)?, 16).ok()?;
    }
    Some(output)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// PBKDF2-HMAC-SHA256 (RFC 8018). Hand-rolled because the workspace carries no
/// `pbkdf2`/`hmac` crate; only used to verify legacy verifiers.
fn pbkdf2_hmac_sha256(password: &[u8], salt: &[u8], iterations: u32, key_bytes: usize) -> Vec<u8> {
    let block_count = key_bytes.div_ceil(SHA256_OUTPUT_BYTES);
    let mut derived = Vec::with_capacity(block_count * SHA256_OUTPUT_BYTES);
    for block in 1..=block_count as u32 {
        let mut salt_block = salt.to_vec();
        salt_block.extend_from_slice(&block.to_be_bytes());
        let mut u = hmac_sha256(password, &salt_block);
        let mut accumulator = u;
        for _ in 1..iterations {
            u = hmac_sha256(password, &u);
            for (slot, byte) in accumulator.iter_mut().zip(u.iter()) {
                *slot ^= *byte;
            }
        }
        derived.extend_from_slice(&accumulator);
    }
    derived.truncate(key_bytes);
    derived
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; SHA256_OUTPUT_BYTES] {
    let mut key_block = [0u8; SHA256_BLOCK_BYTES];
    if key.len() > SHA256_BLOCK_BYTES {
        key_block[..SHA256_OUTPUT_BYTES].copy_from_slice(&Sha256::digest(key));
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(key_block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(key_block.map(|byte| byte ^ 0x5c));
    outer.update(inner_digest);
    outer.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn hex_to_bytes(value: &str) -> Vec<u8> {
        (0..value.len() / 2).map(|index| u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap()).collect()
    }

    #[test]
    fn pbkdf2_hmac_sha256_matches_rfc7914_vectors() {
        // RFC 7914 §11: P="password", S="salt", c=1, dkLen=32.
        assert_eq!(
            to_hex(&pbkdf2_hmac_sha256(b"password", b"salt", 1, 32)),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
        // RFC 7914 §11: P="password", S="salt", c=4096, dkLen=32.
        assert_eq!(
            to_hex(&pbkdf2_hmac_sha256(b"password", b"salt", 4096, 32)),
            "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"
        );
        // A multi-block derivation keeps the leading block identical and pads
        // out to the requested length.
        let long = pbkdf2_hmac_sha256(b"password", b"salt", 1, 64);
        assert_eq!(long.len(), 64);
        assert_eq!(&long[..32], &pbkdf2_hmac_sha256(b"password", b"salt", 1, 32)[..]);
    }

    #[test]
    fn argon2_roundtrip_and_rejection() {
        let verifier = hash_protection_password("s3cret").unwrap();
        assert!(verifier.starts_with("$argon2"));
        assert_eq!(check_protection_password("s3cret", &verifier), ProtectionPasswordCheck::Matched);
        assert_eq!(check_protection_password("wrong", &verifier), ProtectionPasswordCheck::Mismatch);
    }

    #[test]
    fn legacy_pbkdf2_verifier_matches_and_reports_upgrade() {
        // RFC 7914 c=1 vector, encoded the way earlier web builds stored it.
        let salt = BASE64_STANDARD.encode(b"salt");
        let digest = hex_to_bytes("120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b");
        let stored = format!("pbkdf2-sha256$1${salt}${}", BASE64_STANDARD.encode(&digest));
        match check_protection_password("password", &stored) {
            ProtectionPasswordCheck::MatchedLegacy { upgraded_hash: Some(upgraded) } => {
                assert!(upgraded.starts_with("$argon2"));
                assert_eq!(check_protection_password("password", &upgraded), ProtectionPasswordCheck::Matched);
            }
            other => panic!("expected a legacy match, got {other:?}"),
        }
        assert_eq!(check_protection_password("wrong", &stored), ProtectionPasswordCheck::Mismatch);
        // Malformed bodies must never match.
        assert_eq!(
            check_protection_password("password", "pbkdf2-sha256$0$c2FsdA==$aGFzaA=="),
            ProtectionPasswordCheck::Mismatch
        );
        assert_eq!(
            check_protection_password("password", "pbkdf2-sha256$abc$c2FsdA==$aGFzaA=="),
            ProtectionPasswordCheck::Mismatch
        );
        assert_eq!(
            check_protection_password("password", "pbkdf2-sha256$1$c2FsdA=="),
            ProtectionPasswordCheck::Mismatch
        );
    }

    #[test]
    fn legacy_sha256_verifier_matches_domain_prefixed_digest() {
        let digest = Sha256::digest(b"dbx-connection-group:hunter2");
        let stored = to_hex(&digest);
        assert!(matches!(
            check_protection_password("hunter2", &stored),
            ProtectionPasswordCheck::MatchedLegacy { upgraded_hash: Some(_) }
        ));
        assert_eq!(check_protection_password("hunter3", &stored), ProtectionPasswordCheck::Mismatch);
        // Non-hex and wrong-length values are mismatches, not errors.
        assert_eq!(check_protection_password("hunter2", "not-a-hex"), ProtectionPasswordCheck::Mismatch);
        assert_eq!(check_protection_password("hunter2", &"0".repeat(64)), ProtectionPasswordCheck::Mismatch);
    }
}
