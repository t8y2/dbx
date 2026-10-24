//! OIDC client for DBX Web authentication.
//!
//! Implements Authorization Code Flow with PKCE (RFC 7636), automatic IdP
//! discovery, JWKS-based id_token verification, and a CEL-based admission
//! gatekeeper.
//!
//! Admission Gatekeeper:
//! - `DBX_OIDC_ADMISSION_EXPR` — a CEL expression evaluated against the user's
//!   merged claims (`claims` variable, type `map<string, dyn>`).
//!   * Returns a `bool` (true = admitted as "Admin", false = rejected).
//!   * Returns a non-empty `string` (admitted with that role value).
//!   * Returns an empty `string` or `null` = rejected.
//! - If the variable is not set, any user successfully authenticated by the IdP
//!   is admitted with role "Admin" (matches current single-user password behaviour).
//! - `DBX_OIDC_ALLOWED_DOMAINS` — optional comma-separated email domain filter
//!   applied *before* the CEL expression.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use base64::Engine;
use cel::{Context, Program, Value};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::RwLock;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// OIDC runtime configuration read from environment variables.
#[derive(Debug, Clone)]
pub struct OidcConfig {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    /// Full public URL of this DBX instance, e.g. "https://dbx.example.com" (no trailing slash).
    pub public_url: String,
    /// Space-separated OAuth scopes (default: "openid profile email").
    pub scopes: String,
    /// Pre-compiled CEL program, if `DBX_OIDC_ADMISSION_EXPR` was set.
    pub admission_program: Option<Arc<Program>>,
    /// Allowed email domains (e.g. ["example.com"]).
    pub allowed_domains: Vec<String>,
    /// If true, force OIDC-only mode and ignore any configured password.
    pub disable_password: bool,
    /// Label shown on the "Sign in with SSO" button.
    pub button_label: String,
    /// If true, emit `Secure` on the session cookie.
    pub cookie_secure: bool,
}

impl OidcConfig {
    /// Load configuration from environment variables.  
    /// Returns `None` if `DBX_OIDC_ISSUER` is not set (OIDC is disabled).
    /// Returns an `Err` if required variables are missing or the CEL expression fails to compile.
    pub fn from_env() -> Result<Option<Self>, String> {
        let issuer = match std::env::var("DBX_OIDC_ISSUER") {
            Ok(v) if !v.trim().is_empty() => v.trim().trim_end_matches('/').to_string(),
            _ => return Ok(None),
        };

        let client_id = std::env::var("DBX_OIDC_CLIENT_ID")
            .map_err(|_| "DBX_OIDC_CLIENT_ID is required when DBX_OIDC_ISSUER is set".to_string())?;
        if client_id.trim().is_empty() {
            return Err("DBX_OIDC_CLIENT_ID must not be empty".to_string());
        }

        let client_secret = std::env::var("DBX_OIDC_CLIENT_SECRET").ok().filter(|s| !s.trim().is_empty());

        let public_url = std::env::var("DBX_PUBLIC_URL")
            .map_err(|_| "DBX_PUBLIC_URL is required when DBX_OIDC_ISSUER is set".to_string())?;
        if public_url.trim().is_empty() {
            return Err("DBX_PUBLIC_URL must not be empty".to_string());
        }
        let public_url = public_url.trim().trim_end_matches('/').to_string();

        let scopes =
            std::env::var("DBX_OIDC_SCOPES").unwrap_or_else(|_| "openid profile email".to_string()).trim().to_string();

        // Parse and compile CEL admission expression if provided
        let admission_program = match std::env::var("DBX_OIDC_ADMISSION_EXPR") {
            Ok(expr) if !expr.trim().is_empty() => {
                let prog = Program::compile(expr.trim())
                    .map_err(|e| format!("DBX_OIDC_ADMISSION_EXPR is not a valid CEL expression: {e}"))?;
                Some(Arc::new(prog))
            }
            _ => None,
        };

        let allowed_domains = std::env::var("DBX_OIDC_ALLOWED_DOMAINS")
            .ok()
            .into_iter()
            .flat_map(|v| {
                v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_lowercase).collect::<Vec<_>>()
            })
            .collect();

        let disable_password = std::env::var("DBX_OIDC_DISABLE_PASSWORD")
            .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(false);

        let button_label = std::env::var("DBX_OIDC_BUTTON_LABEL")
            .unwrap_or_else(|_| "Sign in with SSO".to_string())
            .trim()
            .to_string();

        // Auto-detect Secure cookie: set if public_url is HTTPS, unless explicit override
        let cookie_secure = std::env::var("DBX_COOKIE_SECURE")
            .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or_else(|_| public_url.starts_with("https://"));

        Ok(Some(OidcConfig {
            issuer,
            client_id,
            client_secret,
            public_url,
            scopes,
            admission_program,
            allowed_domains,
            disable_password,
            button_label,
            cookie_secure,
        }))
    }

    /// Redirect URI sent to the IdP, derived from `public_url`.
    pub fn redirect_uri(&self) -> String {
        format!("{}/api/auth/oidc/callback", self.public_url)
    }
}

// ---------------------------------------------------------------------------
// IdP discovery document
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct DiscoveryDocument {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub jwks_uri: String,
    pub userinfo_endpoint: Option<String>,
    pub end_session_endpoint: Option<String>,
}

// ---------------------------------------------------------------------------
// JWKS key cache
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct JwksCache {
    keys: HashMap<String, DecodingKey>,
    fetched_at: Option<SystemTime>,
}

impl JwksCache {
    /// Returns true if the cache should be refreshed (older than 5 minutes or empty).
    fn is_stale(&self) -> bool {
        match self.fetched_at {
            None => true,
            Some(t) => SystemTime::now().duration_since(t).unwrap_or(Duration::ZERO) > Duration::from_secs(300),
        }
    }
}

// ---------------------------------------------------------------------------
// Pending OIDC state (PKCE + nonce)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PendingOidcState {
    pub code_verifier: String,
    pub nonce: String,
    pub expires_at: SystemTime,
}

// ---------------------------------------------------------------------------
// OIDC errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum OidcError {
    /// Misconfiguration or unexpected IdP response
    Internal(String),
    /// Access rejected by admission policy
    AccessDenied(String),
    /// CEL expression evaluation failure
    EvaluationFailed(String),
}

impl std::fmt::Display for OidcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Internal(s) => write!(f, "{s}"),
            Self::AccessDenied(s) => write!(f, "Access denied: {s}"),
            Self::EvaluationFailed(s) => write!(f, "Admission expression failed: {s}"),
        }
    }
}

// ---------------------------------------------------------------------------
// OidcService
// ---------------------------------------------------------------------------

pub struct OidcService {
    pub config: OidcConfig,
    pub discovery: DiscoveryDocument,
    jwks: RwLock<JwksCache>,
    pending_states: RwLock<HashMap<String, PendingOidcState>>,
}

impl OidcService {
    /// Perform discovery and create the service.
    pub async fn from_config(config: OidcConfig) -> Result<Self, String> {
        let discovery = fetch_discovery(&config.issuer).await.map_err(|e| format!("OIDC discovery failed: {e}"))?;

        // Verify issuer matches
        if discovery.issuer.trim_end_matches('/') != config.issuer {
            return Err(format!("OIDC issuer mismatch: expected '{}', got '{}'", config.issuer, discovery.issuer));
        }

        Ok(Self {
            config,
            discovery,
            jwks: RwLock::new(JwksCache::default()),
            pending_states: RwLock::new(HashMap::new()),
        })
    }

    // -----------------------------------------------------------------------
    // PKCE helpers
    // -----------------------------------------------------------------------

    /// Generate a PKCE pair and store the pending state.  
    /// Returns `(state, authorization_url)`.
    pub async fn begin_auth(&self) -> Result<(String, String), OidcError> {
        let state = random_url_safe(32);
        let nonce = random_url_safe(32);
        let code_verifier = random_url_safe(32);
        let code_challenge = pkce_challenge(&code_verifier);

        let pending = PendingOidcState {
            code_verifier: code_verifier.clone(),
            nonce: nonce.clone(),
            expires_at: SystemTime::now() + Duration::from_secs(600),
        };

        // Evict expired states
        {
            let mut guard = self.pending_states.write().await;
            let now = SystemTime::now();
            guard.retain(|_, v| v.expires_at > now);
            guard.insert(state.clone(), pending);
        }

        let redirect_uri = self.config.redirect_uri();
        let params = form_urlencoded(&[
            ("response_type", "code"),
            ("client_id", &self.config.client_id),
            ("redirect_uri", &redirect_uri),
            ("scope", &self.config.scopes),
            ("state", &state),
            ("nonce", &nonce),
            ("code_challenge", &code_challenge),
            ("code_challenge_method", "S256"),
        ]);

        let auth_url = format!("{}?{}", self.discovery.authorization_endpoint, params.finish());
        Ok((state, auth_url))
    }

    /// Look up a pending state by its opaque `state` value, removing it.
    pub async fn take_pending_state(&self, state: &str) -> Option<PendingOidcState> {
        let mut guard = self.pending_states.write().await;
        let pending = guard.remove(state)?;
        if pending.expires_at < SystemTime::now() {
            return None; // expired
        }
        Some(pending)
    }

    // -----------------------------------------------------------------------
    // Token exchange & verification
    // -----------------------------------------------------------------------

    /// Exchange the authorization code for tokens, verify the id_token, and
    /// evaluate the admission policy.
    ///
    /// Returns `(role, claims_json)` on success.
    pub async fn exchange_and_verify(
        &self,
        code: &str,
        pending: &PendingOidcState,
    ) -> Result<(String, serde_json::Value), OidcError> {
        let redirect_uri = self.config.redirect_uri();

        // 1. Exchange code for tokens
        let tokens = exchange_code(
            &self.discovery.token_endpoint,
            &self.config.client_id,
            self.config.client_secret.as_deref(),
            code,
            &pending.code_verifier,
            &redirect_uri,
        )
        .await
        .map_err(|e| OidcError::Internal(format!("Token exchange failed: {e}")))?;

        // 2. Verify id_token
        let mut claims: serde_json::Value = self
            .verify_id_token(&tokens.id_token, &pending.nonce)
            .await
            .map_err(|e| OidcError::Internal(e.to_string()))?;

        // 3. Merge userinfo if email is absent
        if claims.get("email").and_then(|v| v.as_str()).is_none() {
            if let Some(userinfo_endpoint) = &self.discovery.userinfo_endpoint {
                if let Ok(userinfo) = fetch_userinfo(userinfo_endpoint, &tokens.access_token).await {
                    if let serde_json::Value::Object(ui) = userinfo {
                        if let serde_json::Value::Object(c) = &mut claims {
                            for (k, v) in ui {
                                c.entry(k).or_insert(v);
                            }
                        }
                    }
                }
            }
        }

        // 4. Evaluate admission policy
        let role = evaluate_admission(&claims, self.config.admission_program.as_deref(), &self.config.allowed_domains)?;

        Ok((role, claims))
    }

    // -----------------------------------------------------------------------
    // JWT / JWKS verification
    // -----------------------------------------------------------------------

    async fn verify_id_token(&self, id_token: &str, expected_nonce: &str) -> Result<serde_json::Value, String> {
        let header = decode_header(id_token).map_err(|e| format!("Failed to parse id_token header: {e}"))?;
        let kid = header.kid.as_deref().unwrap_or("");

        let decoding_key = self.get_decoding_key(kid).await?;

        let mut validation = Validation::new(match header.alg {
            jsonwebtoken::Algorithm::RS256 => Algorithm::RS256,
            jsonwebtoken::Algorithm::RS384 => Algorithm::RS384,
            jsonwebtoken::Algorithm::RS512 => Algorithm::RS512,
            jsonwebtoken::Algorithm::ES256 => Algorithm::ES256,
            jsonwebtoken::Algorithm::ES384 => Algorithm::ES384,
            a => return Err(format!("Unsupported id_token algorithm: {a:?}")),
        });
        validation.set_audience(&[&self.config.client_id]);
        validation.set_issuer(&[&self.config.issuer]);

        let token_data = decode::<serde_json::Value>(id_token, &decoding_key, &validation)
            .map_err(|e| format!("id_token verification failed: {e}"))?;

        let claims = token_data.claims;

        // Verify nonce
        if let Some(nonce_in_token) = claims.get("nonce").and_then(|v| v.as_str()) {
            if nonce_in_token != expected_nonce {
                return Err("id_token nonce mismatch".to_string());
            }
        } else {
            return Err("id_token is missing nonce claim".to_string());
        }

        Ok(claims)
    }

    async fn get_decoding_key(&self, kid: &str) -> Result<DecodingKey, String> {
        // Try from cache first
        {
            let guard = self.jwks.read().await;
            if !guard.is_stale() {
                if let Some(key) = guard.keys.get(kid) {
                    return Ok(key.clone());
                }
            }
        }

        // Re-fetch JWKS
        let raw_jwks = reqwest::Client::new()
            .get(&self.discovery.jwks_uri)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| format!("JWKS fetch failed: {e}"))?
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("JWKS parse failed: {e}"))?;

        let mut new_keys = HashMap::new();
        if let Some(keys) = raw_jwks.get("keys").and_then(|v| v.as_array()) {
            for key_val in keys {
                if let Ok(key) = build_decoding_key(key_val) {
                    let key_kid = key_val.get("kid").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    new_keys.insert(key_kid, key);
                }
            }
        }

        let mut guard = self.jwks.write().await;
        guard.keys = new_keys;
        guard.fetched_at = Some(SystemTime::now());

        guard.keys.get(kid).cloned().ok_or_else(|| format!("No JWKS key found for kid '{kid}'"))
    }
}

// ---------------------------------------------------------------------------
// CEL Admission Evaluation
// ---------------------------------------------------------------------------

/// Evaluate the admission policy against merged OIDC claims.
///
/// - If a CEL program is provided: evaluate it and interpret the result.
///   * `bool true` → Admitted as "Admin".
///   * `bool false` → Rejected.
///   * Non-empty string → Admitted with that role.
///   * Empty string → Rejected.
/// - If no program: check allowed_domains (if set) then default-admit as "Admin".
pub fn evaluate_admission(
    claims: &serde_json::Value,
    program: Option<&Program>,
    allowed_domains: &[String],
) -> Result<String, OidcError> {
    // Domain filter (quick short-circuit before CEL)
    if !allowed_domains.is_empty() {
        let email = claims.get("email").and_then(|v| v.as_str()).unwrap_or("");
        let email_lower = email.to_lowercase();
        let allowed = allowed_domains.iter().any(|domain| email_lower.ends_with(&format!("@{domain}")));
        if !allowed {
            return Err(OidcError::AccessDenied(format!("Email '{email}' is not from a permitted domain")));
        }
    }

    let Some(prog) = program else {
        // No expression configured: all authenticated IdP users are admitted as Admin
        return Ok("Admin".to_string());
    };

    // Build CEL context: expose claims as the "claims" variable
    let mut context = Context::default();
    context
        .add_variable("claims", claims)
        .map_err(|e| OidcError::EvaluationFailed(format!("Failed to convert claims to CEL value: {e}")))?;

    let result =
        prog.execute(&context).map_err(|e| OidcError::EvaluationFailed(format!("CEL execution error: {e}")))?;

    match result {
        Value::Bool(true) => Ok("Admin".to_string()),
        Value::Bool(false) => Err(OidcError::AccessDenied("Admission expression returned false".to_string())),
        Value::String(role) => {
            let role = role.trim().to_string();
            if role.is_empty() {
                Err(OidcError::AccessDenied("Admission expression returned empty role".to_string()))
            } else {
                Ok(role)
            }
        }
        other => Err(OidcError::EvaluationFailed(format!(
            "Admission expression must return a bool or string, got: {other:?}"
        ))),
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async fn fetch_discovery(issuer: &str) -> Result<DiscoveryDocument, String> {
    let url = format!("{issuer}/.well-known/openid-configuration");
    reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Discovery request failed: {e}"))?
        .json::<DiscoveryDocument>()
        .await
        .map_err(|e| format!("Discovery response parse failed: {e}"))
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    id_token: String,
}

async fn exchange_code(
    token_endpoint: &str,
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let mut body = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
        ("code_verifier", code_verifier),
    ];
    if let Some(secret) = client_secret {
        body.push(("client_secret", secret));
    }

    let resp = reqwest::Client::new()
        .post(token_endpoint)
        .timeout(Duration::from_secs(15))
        .form(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Token endpoint returned error: {text}"));
    }

    resp.json::<TokenResponse>().await.map_err(|e| e.to_string())
}

async fn fetch_userinfo(userinfo_endpoint: &str, access_token: &str) -> Result<serde_json::Value, String> {
    reqwest::Client::new()
        .get(userinfo_endpoint)
        .bearer_auth(access_token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Crypto utilities
// ---------------------------------------------------------------------------

/// Generate `n` random bytes and encode as URL-safe base64 (no padding).
fn random_url_safe(n: usize) -> String {
    use argon2::password_hash::rand_core::OsRng;
    use argon2::password_hash::rand_core::RngCore;
    let mut bytes = vec![0u8; n];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Compute PKCE S256 code challenge: BASE64URL(SHA256(verifier)).
fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash)
}

/// Tiny URL-encoded form builder.
fn form_urlencoded(pairs: &[(&str, &str)]) -> url_encode::Encoder {
    let mut enc = url_encode::Encoder::new();
    for (k, v) in pairs {
        enc.append(k, v);
    }
    enc
}

/// Build a `DecodingKey` from a JWKS key JSON object (RSA or EC keys supported).
fn build_decoding_key(key: &serde_json::Value) -> Result<DecodingKey, String> {
    let kty = key.get("kty").and_then(|v| v.as_str()).unwrap_or("");
    match kty {
        "RSA" => {
            let n = key.get("n").and_then(|v| v.as_str()).ok_or("JWKS RSA key missing 'n'")?;
            let e = key.get("e").and_then(|v| v.as_str()).ok_or("JWKS RSA key missing 'e'")?;
            DecodingKey::from_rsa_components(n, e).map_err(|err| format!("Failed to build RSA decoding key: {err}"))
        }
        "EC" => {
            let x = key.get("x").and_then(|v| v.as_str()).ok_or("JWKS EC key missing 'x'")?;
            let y = key.get("y").and_then(|v| v.as_str()).ok_or("JWKS EC key missing 'y'")?;
            DecodingKey::from_ec_components(x, y).map_err(|err| format!("Failed to build EC decoding key: {err}"))
        }
        other => Err(format!("Unsupported JWKS key type: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Minimal URL encoder (avoids pulling in a heavy dep)
// ---------------------------------------------------------------------------

mod url_encode {
    pub struct Encoder(String);

    impl Encoder {
        pub fn new() -> Self {
            Self(String::new())
        }
        pub fn append(&mut self, key: &str, value: &str) {
            if !self.0.is_empty() {
                self.0.push('&');
            }
            self.push_encoded(key);
            self.0.push('=');
            self.push_encoded(value);
        }
        fn push_encoded(&mut self, s: &str) {
            for byte in s.bytes() {
                match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        self.0.push(byte as char);
                    }
                    other => {
                        self.0.push_str(&format!("%{other:02X}"));
                    }
                }
            }
        }
        pub fn finish(&self) -> &str {
            &self.0
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_claims(extra: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "sub": "user-123",
            "email": "alice@example.com",
        })
        .as_object_mut()
        .map(|base| {
            if let serde_json::Value::Object(ex) = extra {
                base.extend(ex);
            }
            serde_json::Value::Object(base.clone())
        })
        .unwrap()
    }

    #[test]
    fn no_program_no_domains_admits_everyone_as_admin() {
        let claims = make_claims(serde_json::json!({}));
        let role = evaluate_admission(&claims, None, &[]).unwrap();
        assert_eq!(role, "Admin");
    }

    #[test]
    fn domain_filter_admits_matching_email() {
        let claims = make_claims(serde_json::json!({ "email": "alice@example.com" }));
        let role = evaluate_admission(&claims, None, &["example.com".to_string()]).unwrap();
        assert_eq!(role, "Admin");
    }

    #[test]
    fn domain_filter_rejects_non_matching_email() {
        let claims = make_claims(serde_json::json!({ "email": "alice@evil.com" }));
        let err = evaluate_admission(&claims, None, &["example.com".to_string()]).unwrap_err();
        assert!(matches!(err, OidcError::AccessDenied(_)));
    }

    #[test]
    fn cel_bool_true_admits_as_admin() {
        let prog = Program::compile("claims.email == 'alice@example.com'").unwrap();
        let claims = make_claims(serde_json::json!({ "email": "alice@example.com" }));
        let role = evaluate_admission(&claims, Some(&prog), &[]).unwrap();
        assert_eq!(role, "Admin");
    }

    #[test]
    fn cel_bool_false_rejects() {
        let prog = Program::compile("claims.email == 'alice@example.com'").unwrap();
        let claims = make_claims(serde_json::json!({ "email": "eve@evil.com" }));
        let err = evaluate_admission(&claims, Some(&prog), &[]).unwrap_err();
        assert!(matches!(err, OidcError::AccessDenied(_)));
    }

    #[test]
    fn cel_string_role_admitted() {
        let expr = r#"
            "admin" in claims.roles ? "Admin" :
            "editor" in claims.roles ? "Editor" :
            ""
        "#;
        let prog = Program::compile(expr).unwrap();

        let claims_admin = serde_json::json!({ "sub": "u1", "email": "a@b.com", "roles": ["admin"] });
        assert_eq!(evaluate_admission(&claims_admin, Some(&prog), &[]).unwrap(), "Admin");

        let claims_editor = serde_json::json!({ "sub": "u2", "email": "a@b.com", "roles": ["editor"] });
        assert_eq!(evaluate_admission(&claims_editor, Some(&prog), &[]).unwrap(), "Editor");

        let claims_none = serde_json::json!({ "sub": "u3", "email": "a@b.com", "roles": ["viewer"] });
        let err = evaluate_admission(&claims_none, Some(&prog), &[]).unwrap_err();
        assert!(matches!(err, OidcError::AccessDenied(_)));
    }

    #[test]
    fn pkce_challenge_is_base64url_sha256() {
        // RFC 7636 appendix B test vector
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(pkce_challenge(verifier), expected);
    }
}
