//! OAuth resource-server validation. Authorization and consent belong to an
//! existing OAuth 2.1 provider; DBX never issues tokens or handles login secrets.
use std::{collections::HashSet, fs, path::Path, sync::Arc};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OAuthConfig {
    pub issuer: String,
    pub resource: String,
    pub jwks_file: String,
    pub allowed_subjects: Vec<String>,
    pub required_scope: String,
}

/// Contains only public verification keys and configuration. Deliberately not
/// Debug: never accidentally expose decoded claims through request diagnostics.
#[derive(Clone)]
pub struct OAuthVerifier {
    inner: Arc<Verifier>,
}

struct Verifier {
    issuer: String,
    resource: String,
    keys: JwkSet,
    subjects: HashSet<String>,
    scope: String,
    challenge: String,
    metadata_path: String,
}

#[derive(Deserialize)]
struct Claims {
    exp: u64,
    sub: String,
    #[serde(default)]
    scope: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OAuthError {
    InvalidToken,
    Forbidden,
    InsufficientScope,
}

#[derive(Clone)]
pub struct OAuthPrincipal {
    pub subject: String,
    pub expires_at: u64,
}

#[derive(Clone, Serialize)]
pub struct ProtectedResourceMetadata {
    pub resource: String,
    pub authorization_servers: Vec<String>,
    pub scopes_supported: Vec<String>,
    pub bearer_methods_supported: Vec<String>,
}

impl OAuthVerifier {
    pub fn from_file(path: &Path, mcp_path: &str) -> Result<Self, String> {
        let bytes = read_bounded(path, 64 * 1024)?;
        let mut config: OAuthConfig =
            serde_json::from_slice(&bytes).map_err(|_| "invalid DBX OAuth configuration JSON".to_string())?;
        // Relative key paths are relative to the configuration, not the CWD.
        if Path::new(&config.jwks_file).is_relative() {
            config.jwks_file =
                path.parent().unwrap_or_else(|| Path::new(".")).join(&config.jwks_file).to_string_lossy().into_owned();
        }
        let keys = read_bounded(Path::new(&config.jwks_file), 256 * 1024)?;
        Self::new(config, &keys, mcp_path)
    }

    pub fn new(config: OAuthConfig, jwks: &[u8], mcp_path: &str) -> Result<Self, String> {
        if jwks.len() > 256 * 1024 {
            return Err("public JWKS exceeds size limit".into());
        }
        validate_https_url(&config.issuer)?;
        let resource = validate_https_url(&config.resource)?;
        if resource.path() != mcp_path {
            return Err("OAuth resource URL path must match DBX_MCP_HTTP_PATH".into());
        }
        if config.allowed_subjects.is_empty()
            || config.allowed_subjects.iter().any(|s| s.trim().is_empty() || s.len() > 512)
        {
            return Err("OAuth allowed_subjects must explicitly identify at least one profile owner".into());
        }
        if config.required_scope.is_empty()
            || !config
                .required_scope
                .bytes()
                .all(|b| b == 0x21 || (0x23..=0x5b).contains(&b) || (0x5d..=0x7e).contains(&b))
        {
            return Err("OAuth required_scope must be one valid nonempty OAuth scope".into());
        }
        let raw: serde_json::Value = serde_json::from_slice(jwks).map_err(|_| "invalid public JWKS JSON")?;
        let raw_keys = raw.get("keys").and_then(|v| v.as_array()).ok_or("public JWKS requires keys")?;
        if raw_keys.is_empty() || raw_keys.len() > 32 {
            return Err("public JWKS must contain 1 to 32 keys".into());
        }
        let mut ids = HashSet::new();
        for key in raw_keys {
            if ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].iter().any(|name| key.get(name).is_some()) {
                return Err("JWKS must contain public verification keys only".into());
            }
            if key["kty"] != "RSA" || key["alg"] != "RS256" || key["use"] != "sig" {
                return Err("every JWKS key must declare kty=RSA, alg=RS256, use=sig".into());
            }
            if key.get("key_ops").is_some_and(|ops| {
                ops.as_array().is_none_or(|ops| ops.is_empty() || ops.iter().any(|op| op != "verify"))
            }) {
                return Err("JWKS key_ops must allow verification only".into());
            }
            let modulus =
                key["n"].as_str().and_then(|n| URL_SAFE_NO_PAD.decode(n).ok()).ok_or("invalid RSA modulus")?;
            if modulus.len() < 256 || modulus.len() > 1024 || modulus[0] < 128 {
                return Err("RSA verification keys must be 2048 to 8192 bits".into());
            }
            let kid = key["kid"].as_str().filter(|v| !v.is_empty() && v.len() <= 128).ok_or("JWKS key requires kid")?;
            if !ids.insert(kid) {
                return Err("duplicate JWKS kid".into());
            }
        }
        let keys: JwkSet = serde_json::from_value(raw).map_err(|_| "invalid public JWKS")?;
        for key in &keys.keys {
            DecodingKey::from_jwk(key).map_err(|_| "invalid RSA public verification key")?;
        }
        let metadata_path = format!("/.well-known/oauth-protected-resource{}", resource.path());
        let mut metadata_url = resource.clone();
        metadata_url.set_path(&metadata_path);
        let challenge = format!("Bearer resource_metadata=\"{}\", scope=\"{}\"", metadata_url, config.required_scope);
        Ok(Self {
            inner: Arc::new(Verifier {
                // Preserve exact configured issuer. A trailing slash is significant.
                issuer: config.issuer,
                resource: config.resource,
                keys,
                subjects: config.allowed_subjects.into_iter().collect(),
                scope: config.required_scope,
                challenge,
                metadata_path,
            }),
        })
    }

    pub fn verify(&self, token: &str) -> Result<OAuthPrincipal, OAuthError> {
        if token.len() > 16 * 1024 {
            return Err(OAuthError::InvalidToken);
        }
        let encoded_header = token.split('.').next().ok_or(OAuthError::InvalidToken)?;
        let raw_header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded_header).map_err(|_| OAuthError::InvalidToken)?)
                .map_err(|_| OAuthError::InvalidToken)?;
        // No critical JOSE extensions are implemented. Never silently ignore one.
        if raw_header.get("crit").is_some_and(|v| v.as_array().is_none_or(|items| !items.is_empty()))
            || raw_header.get("b64").is_some_and(|v| v != true)
        {
            return Err(OAuthError::InvalidToken);
        }
        let header = decode_header(token).map_err(|_| OAuthError::InvalidToken)?;
        if header.alg != Algorithm::RS256 {
            return Err(OAuthError::InvalidToken);
        }
        let kid = header.kid.as_deref().filter(|v| !v.is_empty()).ok_or(OAuthError::InvalidToken)?;
        let key = self.inner.keys.find(kid).ok_or(OAuthError::InvalidToken)?;
        let key = DecodingKey::from_jwk(key).map_err(|_| OAuthError::InvalidToken)?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.inner.issuer]);
        validation.set_audience(&[&self.inner.resource]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.validate_nbf = true;
        validation.leeway = 0;
        let claims = decode::<Claims>(token, &key, &validation).map_err(|_| OAuthError::InvalidToken)?.claims;
        if !self.inner.subjects.contains(&claims.sub) {
            return Err(OAuthError::Forbidden);
        }
        if !claims.scope.split_ascii_whitespace().any(|scope| scope == self.inner.scope) {
            return Err(OAuthError::InsufficientScope);
        }
        Ok(OAuthPrincipal { subject: claims.sub, expires_at: claims.exp })
    }

    pub fn metadata(&self) -> ProtectedResourceMetadata {
        ProtectedResourceMetadata {
            resource: self.inner.resource.clone(),
            authorization_servers: vec![self.inner.issuer.clone()],
            scopes_supported: vec![self.inner.scope.clone()],
            bearer_methods_supported: vec!["header".into()],
        }
    }
    pub fn metadata_path(&self) -> &str {
        &self.inner.metadata_path
    }
    pub fn challenge(&self) -> &str {
        &self.inner.challenge
    }
    pub fn resource_host(&self) -> String {
        Url::parse(&self.inner.resource).expect("validated resource URL").authority().to_owned()
    }
}

fn validate_https_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "OAuth URLs must be absolute HTTPS URLs")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || value.contains(['"', '\\'])
        || value.chars().any(char::is_whitespace)
    {
        return Err("OAuth URLs must be HTTPS without credentials, query, or fragment".into());
    }
    Ok(url)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let file = fs::File::open(path).map_err(|_| "unable to open OAuth configuration or public JWKS")?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|_| "unable to read OAuth configuration or public JWKS")?;
    if bytes.len() as u64 > limit {
        return Err("OAuth configuration or public JWKS exceeds size limit".into());
    }
    Ok(bytes)
}

#[cfg(test)]
pub(crate) mod test_issuer {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use jsonwebtoken::{encode, EncodingKey, Header};
    use rsa::{pkcs8::EncodePrivateKey, traits::PublicKeyParts, RsaPrivateKey};
    use serde_json::{json, Value};
    use std::sync::OnceLock;

    pub struct TestIssuer {
        pub jwks: Vec<u8>,
        key: EncodingKey,
    }
    pub fn issuer() -> &'static TestIssuer {
        static ISSUER: OnceLock<TestIssuer> = OnceLock::new();
        ISSUER.get_or_init(|| {
            // Ephemeral test-only signing key. Never persisted or shipped.
            let key = RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048).unwrap();
            let jwks = serde_json::to_vec(&json!({"keys":[{
                "kty":"RSA", "alg":"RS256", "use":"sig", "kid":"synthetic-test",
                "n":URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()),
                "e":URL_SAFE_NO_PAD.encode(key.e().to_bytes_be())
            }]}))
            .unwrap();
            let pem = key.to_pkcs8_pem(Default::default()).unwrap();
            TestIssuer { jwks, key: EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap() }
        })
    }
    impl TestIssuer {
        pub fn config(&self) -> OAuthConfig {
            OAuthConfig {
                issuer: "https://issuer.example.test/tenant".into(),
                resource: "https://dbx.example.test/mcp".into(),
                jwks_file: "unused-public-jwks.json".into(),
                allowed_subjects: vec!["owner".into(), "second-owner".into()],
                required_scope: "dbx:mcp".into(),
            }
        }
        pub fn verifier(&self) -> OAuthVerifier {
            OAuthVerifier::new(self.config(), &self.jwks, "/mcp").unwrap()
        }
        pub fn claims(&self, subject: &str) -> Value {
            let now = jsonwebtoken::get_current_timestamp();
            json!({"iss":self.config().issuer, "aud":self.config().resource,
                "sub":subject, "scope":"dbx:mcp", "exp":now+300, "nbf":now-1})
        }
        pub fn sign(&self, claims: &Value) -> String {
            let mut header = Header::new(Algorithm::RS256);
            header.kid = Some("synthetic-test".into());
            header.typ = Some("at+jwt".into());
            encode(&header, claims, &self.key).unwrap()
        }
        pub fn token(&self, subject: &str) -> String {
            self.sign(&self.claims(subject))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{test_issuer::issuer, *};
    use serde_json::json;

    #[test]
    fn validates_signature_claims_scope_and_explicit_profile_owner() {
        let issuer = issuer();
        let verifier = issuer.verifier();
        assert_eq!(verifier.verify(&issuer.token("owner")).unwrap().subject, "owner");
        for (field, value) in [
            ("iss", json!("https://wrong.example.test")),
            ("aud", json!("https://other.example.test/mcp")),
            ("sub", json!("uninvited")),
            ("scope", json!("openid profile")),
            ("exp", json!(jsonwebtoken::get_current_timestamp() - 1)),
            ("nbf", json!(jsonwebtoken::get_current_timestamp() + 300)),
        ] {
            let mut claims = issuer.claims("owner");
            claims[field] = value;
            assert!(verifier.verify(&issuer.sign(&claims)).is_err(), "accepted invalid {field}");
        }
        for field in ["iss", "aud", "sub", "scope", "exp"] {
            let mut claims = issuer.claims("owner");
            claims.as_object_mut().unwrap().remove(field);
            assert!(verifier.verify(&issuer.sign(&claims)).is_err(), "accepted missing {field}");
        }
        let mut token = issuer.token("owner").into_bytes();
        let last = token.len() - 10;
        token[last] = if token[last] == b'A' { b'B' } else { b'A' };
        assert!(verifier.verify(std::str::from_utf8(&token).unwrap()).is_err());
        assert!(verifier.verify("not-a-token").is_err());
        assert!(verifier.verify(&"a".repeat(16 * 1024 + 1)).is_err());
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &issuer.claims("owner"),
            &jsonwebtoken::EncodingKey::from_secret(b"synthetic-only"),
        )
        .unwrap();
        assert!(verifier.verify(&token).is_err());
    }

    #[test]
    fn rejects_unsafe_configuration_and_private_keys() {
        let issuer = issuer();
        let mut config = issuer.config();
        config.issuer = "http://issuer.example.test".into();
        assert!(OAuthVerifier::new(config, &issuer.jwks, "/mcp").is_err());
        let mut config = issuer.config();
        config.allowed_subjects.clear();
        assert!(OAuthVerifier::new(config, &issuer.jwks, "/mcp").is_err());
        let mut config = issuer.config();
        config.resource = "https://dbx.example.test/other".into();
        assert!(OAuthVerifier::new(config, &issuer.jwks, "/mcp").is_err());
        let mut keys: serde_json::Value = serde_json::from_slice(&issuer.jwks).unwrap();
        keys["keys"][0]["d"] = json!("never-load-private-material");
        assert!(OAuthVerifier::new(issuer.config(), &serde_json::to_vec(&keys).unwrap(), "/mcp").is_err());
    }

    #[test]
    fn publishes_resource_metadata_without_profile_or_claims() {
        let verifier = issuer().verifier();
        let metadata = serde_json::to_value(verifier.metadata()).unwrap();
        assert_eq!(metadata["resource"], "https://dbx.example.test/mcp");
        assert_eq!(metadata["authorization_servers"][0], "https://issuer.example.test/tenant");
        assert_eq!(verifier.metadata_path(), "/.well-known/oauth-protected-resource/mcp");
        assert!(!metadata.to_string().contains("owner"));
        assert!(!metadata.to_string().contains("jwks"));
        assert!(verifier.challenge().contains("https://dbx.example.test/.well-known/oauth-protected-resource/mcp"));
    }
}
