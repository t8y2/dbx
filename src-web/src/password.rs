use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use rand::rngs::OsRng;

/// Hashes a password using Argon2id.
///
/// # Arguments
/// * `password` - The plaintext password to hash
///
/// # Returns
/// Argon2 password hash string
pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();

    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| format!("Password hashing failed: {e}"))
}

/// Verifies a password against a hash.
///
/// # Arguments
/// * `password` - The plaintext password to verify
/// * `hash` - The Argon2 password hash to verify against
///
/// # Returns
/// true if password matches, false otherwise
pub fn verify_password(password: &str, hash: &str) -> Result<bool, String> {
    let parsed_hash = PasswordHash::new(hash).map_err(|e| format!("Invalid password hash: {e}"))?;

    let argon2 = Argon2::default();
    match argon2.verify_password(password.as_bytes(), &parsed_hash) {
        Ok(()) => Ok(true),
        Err(argon2::password_hash::Error::Password) => Ok(false),
        Err(e) => Err(format!("Password verification failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_and_verify() {
        let password = "my-secure-password";
        let hash = hash_password(password).expect("Hashing failed");

        let result = verify_password(password, &hash).expect("Verification failed");
        assert!(result);
    }

    #[test]
    fn test_wrong_password_fails() {
        let password = "my-secure-password";
        let hash = hash_password(password).expect("Hashing failed");

        let result = verify_password("wrong-password", &hash).expect("Verification failed");
        assert!(!result);
    }

    #[test]
    fn test_different_hashes_for_same_password() {
        let password = "my-secure-password";
        let hash1 = hash_password(password).expect("Hashing failed");
        let hash2 = hash_password(password).expect("Hashing failed");

        // Hashes should be different due to random salt
        assert_ne!(hash1, hash2);

        // But both should verify
        assert!(verify_password(password, &hash1).expect("Verification failed"));
        assert!(verify_password(password, &hash2).expect("Verification failed"));
    }
}
