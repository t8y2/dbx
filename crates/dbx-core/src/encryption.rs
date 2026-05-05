use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::Rng;

/// Encryption key size (256 bits for AES-256)
const KEY_SIZE: usize = 32;
/// Nonce size for AES-GCM (96 bits)
const NONCE_SIZE: usize = 12;

/// Encrypts a secret using AES-256-GCM with a derived key.
///
/// # Arguments
/// * `secret` - The plaintext secret to encrypt
/// * `master_key` - The master encryption key (should be at least 32 bytes)
///
/// # Returns
/// Base64-encoded ciphertext with nonce prepended
pub fn encrypt_secret(secret: &str, master_key: &[u8]) -> Result<String, String> {
    if secret.is_empty() {
        return Ok(String::new());
    }

    // Derive a consistent key from master key
    let key = derive_key(master_key)?;

    // Generate random nonce
    let mut rng = rand::thread_rng();
    let mut nonce_bytes = [0u8; NONCE_SIZE];
    rng.fill(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    // Create cipher
    let cipher = Aes256Gcm::new(&key);

    // Encrypt
    let ciphertext = cipher
        .encrypt(nonce, Payload::from(secret.as_bytes()))
        .map_err(|e| format!("Encryption failed: {e}"))?;

    // Combine nonce + ciphertext and encode
    let mut encrypted = nonce_bytes.to_vec();
    encrypted.extend_from_slice(&ciphertext);

    Ok(STANDARD.encode(&encrypted))
}

/// Decrypts a secret encrypted with `encrypt_secret`.
///
/// # Arguments
/// * `encrypted` - Base64-encoded ciphertext with nonce prepended
/// * `master_key` - The master encryption key (must match the one used for encryption)
///
/// # Returns
/// Decrypted plaintext secret
pub fn decrypt_secret(encrypted: &str, master_key: &[u8]) -> Result<String, String> {
    if encrypted.is_empty() {
        return Ok(String::new());
    }

    // Decode from base64
    let encrypted_bytes = STANDARD.decode(encrypted).map_err(|e| format!("Base64 decode failed: {e}"))?;

    if encrypted_bytes.len() < NONCE_SIZE {
        return Err("Encrypted data too short".to_string());
    }

    // Extract nonce and ciphertext
    let (nonce_bytes, ciphertext) = encrypted_bytes.split_at(NONCE_SIZE);
    let nonce = Nonce::from_slice(nonce_bytes);

    // Derive key
    let key = derive_key(master_key)?;

    // Create cipher
    let cipher = Aes256Gcm::new(&key);

    // Decrypt
    let plaintext = cipher
        .decrypt(nonce, Payload::from(ciphertext))
        .map_err(|e| format!("Decryption failed: {e}"))?;

    String::from_utf8(plaintext).map_err(|e| format!("UTF-8 decode failed: {e}"))
}

/// Derives a consistent encryption key from a master key using SHA-256.
fn derive_key(master_key: &[u8]) -> Result<aes_gcm::Key<Aes256Gcm>, String> {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(master_key);
    let hash = hasher.finalize();

    Ok(*aes_gcm::Key::<Aes256Gcm>::from_slice(&hash[..KEY_SIZE]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt() {
        let secret = "my-secret-password";
        let master_key = b"my-master-key-for-encryption";

        let encrypted = encrypt_secret(secret, master_key).expect("Encryption failed");
        assert!(!encrypted.is_empty());
        assert_ne!(encrypted, secret);

        let decrypted = decrypt_secret(&encrypted, master_key).expect("Decryption failed");
        assert_eq!(decrypted, secret);
    }

    #[test]
    fn test_empty_secret() {
        let master_key = b"my-master-key";
        let encrypted = encrypt_secret("", master_key).expect("Encryption failed");
        assert_eq!(encrypted, "");

        let decrypted = decrypt_secret("", master_key).expect("Decryption failed");
        assert_eq!(decrypted, "");
    }

    #[test]
    fn test_wrong_key_fails() {
        let secret = "my-secret";
        let key1 = b"key1";
        let key2 = b"key2";

        let encrypted = encrypt_secret(secret, key1).expect("Encryption failed");
        let result = decrypt_secret(&encrypted, key2);
        assert!(result.is_err());
    }
}
