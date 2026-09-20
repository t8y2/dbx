use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::mq::types::{MqTokenIssueRequest, MqTokenSigningAlgorithm, MqTokenSigningConfig};

#[derive(Debug, Clone)]
pub struct SignedPulsarToken {
    pub token: String,
    pub fingerprint: String,
    pub expires_at_unix: Option<i64>,
}

#[derive(Debug, Serialize)]
struct PulsarTokenClaims<'a> {
    sub: &'a str,
    iat: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    exp: Option<i64>,
}

pub fn sign_pulsar_token(
    config: &MqTokenSigningConfig,
    req: &MqTokenIssueRequest,
    now_unix: i64,
) -> Result<SignedPulsarToken, String> {
    let subject = req.subject.trim();
    if subject.is_empty() {
        return Err("Token subject is required".to_string());
    }

    // Validate subject format
    if subject.len() > 256 {
        return Err("Token subject exceeds maximum length of 256 characters".to_string());
    }

    // Pulsar typically accepts alphanumeric characters plus common separators
    // Allow: letters, digits, hyphen, underscore, dot, @
    if !subject.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '@')) {
        return Err(format!(
            "Token subject contains invalid characters. Only alphanumeric, '-', '_', '.', and '@' are allowed. Got: {}",
            subject
        ));
    }

    let key = config.key.trim();
    if key.is_empty() {
        return Err("Token signing key is required".to_string());
    }

    let expires_at_unix = match req.expires_in_seconds {
        Some(seconds) if seconds <= 0 => return Err("Token expiry must be greater than zero seconds".to_string()),
        Some(seconds) => Some(now_unix.saturating_add(seconds)),
        None => None,
    };
    let claims = PulsarTokenClaims { sub: subject, iat: now_unix, exp: expires_at_unix };
    let algorithm = jwt_algorithm(config.algorithm);
    let header = Header::new(algorithm);
    let encoding_key = encoding_key(config.algorithm, key)?;
    let token = encode(&header, &claims, &encoding_key).map_err(|err| format!("Failed to sign Pulsar token: {err}"))?;
    let fingerprint = token_fingerprint(&token);

    Ok(SignedPulsarToken { token, fingerprint, expires_at_unix })
}

pub fn token_fingerprint(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    format!("sha256:{}", hex_lower(&digest))
}

fn jwt_algorithm(algorithm: MqTokenSigningAlgorithm) -> Algorithm {
    match algorithm {
        MqTokenSigningAlgorithm::Hs256 => Algorithm::HS256,
        MqTokenSigningAlgorithm::Rs256 => Algorithm::RS256,
    }
}

fn encoding_key(algorithm: MqTokenSigningAlgorithm, key: &str) -> Result<EncodingKey, String> {
    match algorithm {
        MqTokenSigningAlgorithm::Hs256 => Ok(EncodingKey::from_secret(key.as_bytes())),
        MqTokenSigningAlgorithm::Rs256 => {
            let normalized = normalize_rsa_key_material(key)?;
            EncodingKey::from_rsa_pem(normalized.as_bytes()).map_err(|err| format!("Invalid RS256 private key: {err}"))
        }
    }
}

fn normalize_rsa_key_material(key: &str) -> Result<String, String> {
    // If already in PEM format, return as-is
    if key.contains("-----BEGIN") {
        return Ok(key.to_string());
    }

    // Try to decode as base64
    match BASE64.decode(key.as_bytes()) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|e| {
            format!(
                "RSA key appears to be base64-encoded but decodes to invalid UTF-8: {}. \
                 Please provide the key in PEM format (with -----BEGIN/END headers) or as valid base64.",
                e
            )
        }),
        Err(e) => Err(format!(
            "RSA key is not in PEM format and failed to decode as base64: {}. \
             Please provide the key in PEM format (with -----BEGIN RSA PRIVATE KEY----- headers) \
             or as valid base64-encoded data.",
            e
        )),
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
