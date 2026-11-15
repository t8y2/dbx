//! Generic OIDC / OAuth2 Authorization Code authentication (Keycloak / Auth0 / Casdoor /
//! authsvr or any IdP implementing OIDC endpoints).
//!
//! Security design: Authorization Code + PKCE(S256) + state + nonce all enabled;
//! the id_token is verified locally against JWKS (RS256, cached jwks_uri, forced refresh on
//! unknown kid for key rotation); iss/aud/exp/nonce are validated. No unsigned response field is trusted.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine as _};
use jsonwebtoken::{DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::identity::{map_role, AuthIdentity, UserRole};
use crate::provider::{AuthError, AuthProvider, AuthProviderKind, CallbackParams, FormCredentials, LoginMode, RedirectInit, RedirectOutcome};

/// Lifetime of a callback state (replay-protection window).
const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
/// Capacity cap for pending states.
const PENDING_MAX: usize = 256;
/// JWKS cache lifetime; an unknown kid forces one immediate refresh (key rotation).
const JWKS_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OidcProviderConfig {
    /// Issuer address (used for discovery and iss validation; trailing slashes are normalized).
    pub issuer: String,
    /// Optional externally visible origin (for redirect_uri derivation behind proxies);
    /// defaults to DBX_PUBLIC_URL or request-header derivation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_url: Option<String>,
    pub client_id: String,
    /// Client secret for confidential clients. Sensitive: injected from the secret store for DB-sourced config.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    /// Optional endpoint overrides; discovery is used by default. Accommodates IdPs that implement only part of OIDC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jwks_uri: Option<String>,
    /// IdP end-session endpoint (RP-initiated logout); discovery is used by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_session_endpoint: Option<String>,
    #[serde(default = "default_scopes")]
    pub scopes: Vec<String>,
    /// Username claim (default chain: preferred_username → email → sub).
    #[serde(default)]
    pub username_claim: Option<String>,
    /// Groups/roles claim (default `groups`; custom IdPs like authsvr can use `roles`).
    #[serde(default)]
    pub groups_claim: Option<String>,
    #[serde(default)]
    pub role_map: HashMap<String, String>,
    #[serde(default)]
    pub default_role: Option<UserRole>,
    /// The `prompt` parameter of the authorization request (e.g. `none` for silent embedding).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
}

fn default_scopes() -> Vec<String> {
    vec!["openid".to_string(), "profile".to_string(), "email".to_string()]
}
fn default_timeout_secs() -> u64 {
    10
}

impl Default for OidcProviderConfig {
    fn default() -> Self {
        Self {
            issuer: String::new(),
            public_url: None,
            client_id: String::new(),
            client_secret: None,
            authorization_endpoint: None,
            token_endpoint: None,
            jwks_uri: None,
            end_session_endpoint: None,
            scopes: default_scopes(),
            username_claim: None,
            groups_claim: None,
            role_map: HashMap::new(),
            default_role: None,
            prompt: None,
            timeout_secs: default_timeout_secs(),
        }
    }
}

/// Discovery document (only the endpoints we use).
#[derive(Debug, Clone, Deserialize)]
struct OidcDiscoveryDocument {
    authorization_endpoint: Option<String>,
    token_endpoint: Option<String>,
    jwks_uri: Option<String>,
    end_session_endpoint: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct OidcJwk {
    kid: Option<String>,
    kty: Option<String>,
    n: Option<String>,
    #[serde(rename = "e")]
    exponent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OidcClaims {
    iss: Option<String>,
    sub: Option<String>,
    aud: Option<Value>,
    exp: Option<i64>,
    nonce: Option<String>,
    #[serde(flatten)]
    extra: HashMap<String, Value>,
}

/// Pending authorization: state → (PKCE verifier, nonce, next).
#[derive(Clone)]
struct PendingAuthorization {
    code_verifier: String,
    nonce: String,
    next: Option<String>,
    created_at: Instant,
}

/// OIDC provider. Pending state/PKCE items live inside the instance (bounded + TTL).
pub struct OidcAuthProvider {
    id: String,
    config: OidcProviderConfig,
    label: String,
    client: reqwest::Client,
    /// Discovery cache (endpoint set, issuer-normalized).
    endpoints: Mutex<Option<(OidcEndpoints, Instant)>>,
    /// JWKS cache: kid → DecodingKey.
    jwks: Mutex<Option<(HashMap<String, Arc<DecodingKey>>, Instant)>>,
    pending: Mutex<HashMap<String, PendingAuthorization>>,
}

#[derive(Debug, Clone)]
struct OidcEndpoints {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: Option<String>,
    end_session_endpoint: Option<String>,
}

impl OidcAuthProvider {
    pub fn new(config: OidcProviderConfig) -> Result<Self, AuthError> {
        Self::with_id(config, "oidc")
    }

    pub fn with_id(config: OidcProviderConfig, id: impl Into<String>) -> Result<Self, AuthError> {
        if config.issuer.trim().is_empty() {
            return Err(AuthError::Configuration("issuer is required".to_string()));
        }
        if config.client_id.trim().is_empty() {
            return Err(AuthError::Configuration("client_id is required".to_string()));
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()
            .map_err(|error| AuthError::Configuration(format!("HTTP client build failed: {error}")))?;
        Ok(Self {
            id: id.into(),
            config,
            label: "SSO".to_string(),
            client,
            endpoints: Mutex::new(None),
            jwks: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
        })
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = label.into();
        self
    }

    fn issuer_normalized(&self) -> String {
        self.config.issuer.trim().trim_end_matches('/').to_string()
    }

    /// Resolves authorization/token/jwks endpoints: explicit config wins, otherwise cached discovery.
    async fn resolve_endpoints(&self) -> Result<OidcEndpoints, AuthError> {
        if let (Some(authorization), Some(token)) = (self.config.authorization_endpoint.clone(), self.config.token_endpoint.clone()) {
            return Ok(OidcEndpoints {
                authorization_endpoint: authorization,
                token_endpoint: token,
                jwks_uri: self.config.jwks_uri.clone(),
                end_session_endpoint: self.config.end_session_endpoint.clone(),
            });
        }
        {
            let cached = self.endpoints.lock().await;
            if let Some((endpoints, fetched_at)) = cached.as_ref() {
                if fetched_at.elapsed() < JWKS_TTL {
                    return Ok(endpoints.clone());
                }
            }
        }
        let discovery_url = format!("{}/.well-known/openid-configuration", self.issuer_normalized());
        let response = self
            .client
            .get(&discovery_url)
            .send()
            .await
            .map_err(|error| AuthError::ProviderUnavailable(format!("OIDC discovery failed: {error}")))?;
        if !response.status().is_success() {
            return Err(AuthError::ProviderUnavailable(format!("OIDC discovery returned {}", response.status())));
        }
        let document: OidcDiscoveryDocument = response
            .json()
            .await
            .map_err(|error| AuthError::BadIdentity(format!("OIDC discovery document invalid: {error}")))?;
        let endpoints = OidcEndpoints {
            authorization_endpoint: document
                .authorization_endpoint
                .or_else(|| self.config.authorization_endpoint.clone())
                .ok_or_else(|| AuthError::Configuration("OIDC discovery missing authorization_endpoint".to_string()))?,
            token_endpoint: document
                .token_endpoint
                .or_else(|| self.config.token_endpoint.clone())
                .ok_or_else(|| AuthError::Configuration("OIDC discovery missing token_endpoint".to_string()))?,
            jwks_uri: document.jwks_uri.or_else(|| self.config.jwks_uri.clone()),
            end_session_endpoint: document.end_session_endpoint.or_else(|| self.config.end_session_endpoint.clone()),
        };
        *self.endpoints.lock().await = Some((endpoints.clone(), Instant::now()));
        Ok(endpoints)
    }

    /// Fetches the verification key: cached keys are used directly; an unknown kid forces one refresh.
    async fn decoding_key(&self, kid: &str, jwks_uri: &str) -> Result<Arc<DecodingKey>, AuthError> {
        {
            let cached = self.jwks.lock().await;
            if let Some((keys, fetched_at)) = cached.as_ref() {
                if fetched_at.elapsed() < JWKS_TTL {
                    if let Some(key) = keys.get(kid) {
                        return Ok(key.clone());
                    }
                }
            }
        }
        let keys = self.fetch_jwks(jwks_uri).await?;
        let key = keys.get(kid).cloned().ok_or_else(|| AuthError::BadIdentity(format!("JWKS has no kid {kid}")))?;
        *self.jwks.lock().await = Some((keys, Instant::now()));
        Ok(key)
    }

    async fn fetch_jwks(&self, jwks_uri: &str) -> Result<HashMap<String, Arc<DecodingKey>>, AuthError> {
        let response = self
            .client
            .get(jwks_uri)
            .send()
            .await
            .map_err(|error| AuthError::ProviderUnavailable(format!("JWKS fetch failed: {error}")))?;
        if !response.status().is_success() {
            return Err(AuthError::ProviderUnavailable(format!("JWKS fetch returned {}", response.status())));
        }
        let document: Value = response
            .json()
            .await
            .map_err(|error| AuthError::BadIdentity(format!("JWKS document invalid: {error}")))?;
        let mut keys = HashMap::new();
        for item in document.get("keys").and_then(Value::as_array).into_iter().flatten() {
            let jwk: OidcJwk = match serde_json::from_value(item.clone()) {
                Ok(jwk) => jwk,
                Err(_) => continue,
            };
            if jwk.kty.as_deref() != Some("RSA") {
                continue;
            }
            let (Some(n), Some(e)) = (jwk.n, jwk.exponent) else { continue };
            let kid = jwk.kid.unwrap_or_default();
            match DecodingKey::from_rsa_components(&n, &e) {
                Ok(key) => {
                    keys.insert(kid, Arc::new(key));
                }
                Err(error) => log::warn!("skipping unusable JWK {kid}: {error}"),
            }
        }
        if keys.is_empty() {
            return Err(AuthError::BadIdentity("JWKS contains no RSA key".to_string()));
        }
        Ok(keys)
    }

    /// Verifies the id_token and extracts claims (RS256 + iss/aud/exp/nonce).
    async fn verify_id_token(&self, id_token: &str, expected_nonce: &str, endpoints: &OidcEndpoints) -> Result<OidcClaims, AuthError> {
        let header = jsonwebtoken::decode_header(id_token).map_err(|error| AuthError::BadIdentity(format!("id_token header invalid: {error}")))?;
        if header.alg != jsonwebtoken::Algorithm::RS256 {
            return Err(AuthError::BadIdentity(format!("unsupported id_token algorithm {:?}", header.alg)));
        }
        let kid = header.kid.ok_or_else(|| AuthError::BadIdentity("id_token header missing kid".to_string()))?;
        let jwks_uri = endpoints
            .jwks_uri
            .clone()
            .or_else(|| self.config.jwks_uri.clone())
            .ok_or_else(|| AuthError::Configuration("jwks_uri is required (via discovery or config)".to_string()))?;
        let key = self.decoding_key(&kid, &jwks_uri).await?;

        let mut validation = Validation::new(jsonwebtoken::Algorithm::RS256);
        validation.validate_exp = true;
        validation.validate_aud = true;
        validation.set_audience(&[&self.config.client_id]);
        validation.set_issuer(&[&self.issuer_normalized()]);
        validation.leeway = 60;
        let data = jsonwebtoken::decode::<OidcClaims>(id_token, &key, &validation)
            .map_err(|error| AuthError::BadIdentity(format!("id_token rejected: {error}")))?;
        let claims = data.claims;
        if claims.nonce.as_deref() != Some(expected_nonce) {
            return Err(AuthError::BadIdentity("id_token nonce mismatch".to_string()));
        }
        Ok(claims)
    }

    fn claims_to_identity(&self, claims: &OidcClaims) -> Result<AuthIdentity, AuthError> {
        let subject = claims
            .sub
            .clone()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AuthError::BadIdentity("id_token missing sub".to_string()))?;
        // Username fallback chain: explicit claim → preferred_username → email → sub.
        let mut username: Option<String> = None;
        for claim in [
            self.config.username_claim.as_deref().map(str::to_string),
            Some("preferred_username".to_string()),
            Some("email".to_string()),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(value) = claims.extra.get(&claim).and_then(Value::as_str).filter(|value| !value.is_empty()) {
                username = Some(value.to_string());
                break;
            }
        }
        let username = username.unwrap_or_else(|| subject.clone());
        let email = claims.extra.get("email").and_then(Value::as_str).map(str::to_string);
        let display_name = claims
            .extra
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| email.clone());
        let groups_claim = self.config.groups_claim.clone().unwrap_or_else(|| "groups".to_string());
        let groups: Vec<String> = match claims.extra.get(&groups_claim) {
            Some(Value::Array(values)) => values.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            Some(Value::String(value)) => vec![value.clone()],
            _ => Vec::new(),
        };
        let role = map_role(&groups, &self.config.role_map, self.config.default_role.unwrap_or(UserRole::Member));
        Ok(AuthIdentity {
            provider_id: self.id.clone(),
            subject,
            username,
            display_name,
            email,
            groups,
            role,
        })
    }
}

#[async_trait]
impl AuthProvider for OidcAuthProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn kind(&self) -> AuthProviderKind {
        AuthProviderKind::Oidc
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn login_mode(&self) -> LoginMode {
        LoginMode::Redirect
    }

    fn public_url(&self) -> Option<&str> {
        self.config.public_url.as_deref()
    }

    async fn authenticate(&self, _input: &FormCredentials) -> Result<AuthIdentity, AuthError> {
        Err(AuthError::Unsupported)
    }

    async fn begin_redirect(&self, redirect_uri: &str, next: Option<&str>) -> Result<RedirectInit, AuthError> {
        let endpoints = self.resolve_endpoints().await?;

        let state = uuid::Uuid::new_v4().simple().to_string();
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        // PKCE verifier: 96 URL-safe characters (RFC 7636 allows 43-128).
        let code_verifier: String = (0..3).map(|_| uuid::Uuid::new_v4().simple().to_string()).collect();
        let challenge = B64URL.encode(Sha256::digest(code_verifier.as_bytes()));

        {
            let mut pending = self.pending.lock().await;
            let now = Instant::now();
            // Bounded: drop expired first; if still over the cap, clear everything (sacrificing a few pending items in an extreme case).
            pending.retain(|_, item| now.duration_since(item.created_at) < PENDING_TTL);
            if pending.len() >= PENDING_MAX {
                pending.clear();
            }
            pending.insert(
                state.clone(),
                PendingAuthorization { code_verifier, nonce: nonce.clone(), next: next.map(str::to_string), created_at: now },
            );
        }

        let url = format!(
            "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&nonce={}&code_challenge={}&code_challenge_method=S256",
            endpoints.authorization_endpoint,
            urlencode(&self.config.client_id),
            urlencode(redirect_uri),
            urlencode(&self.config.scopes.join(" ")),
            urlencode(&state),
            urlencode(&nonce),
            urlencode(&challenge),
        );
        let mut url = url;
        if let Some(prompt) = self.config.prompt.as_deref().filter(|value| !value.is_empty()) {
            url.push_str(&format!("&prompt={}", urlencode(prompt)));
        }
        Ok(RedirectInit { authorization_url: url })
    }

    async fn complete_redirect(&self, query: &CallbackParams, redirect_uri: &str) -> Result<RedirectOutcome, AuthError> {
        if let Some(error) = query.error.as_deref().filter(|value| !value.is_empty()) {
            let description = query.error_description.as_deref().unwrap_or("");
            return Err(AuthError::BadIdentity(format!("oidc error {error}: {description}")));
        }
        let state = query.state.as_deref().filter(|value| !value.is_empty()).ok_or_else(|| AuthError::InvalidCredentials)?;
        let code = query.code.as_deref().filter(|value| !value.is_empty()).ok_or_else(|| AuthError::InvalidCredentials)?;

        let pending = {
            let mut pending = self.pending.lock().await;
            let item = pending.remove(state).ok_or(AuthError::InvalidCredentials)?;
            if Instant::now().duration_since(item.created_at) >= PENDING_TTL {
                return Err(AuthError::InvalidCredentials);
            }
            item
        };

        let endpoints = self.resolve_endpoints().await?;
        let mut form = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", self.config.client_id.as_str()),
            ("code_verifier", pending.code_verifier.as_str()),
        ];
        let mut request = self.client.post(&endpoints.token_endpoint);
        if let Some(secret) = self.config.client_secret.as_deref().filter(|secret| !secret.is_empty()) {
            request = request.basic_auth(&self.config.client_id, Some(secret));
        } else {
            form.push(("client_id", self.config.client_id.as_str()));
        }
        let response = request.form(&form).send().await.map_err(|error| AuthError::ProviderUnavailable(format!("token exchange failed: {error}")))?;
        if !response.status().is_success() {
            return Err(AuthError::ProviderUnavailable(format!("token exchange returned {}", response.status())));
        }
        let token_response: Value = response
            .json()
            .await
            .map_err(|error| AuthError::BadIdentity(format!("token response invalid: {error}")))?;
        let id_token = token_response
            .get("id_token")
            .and_then(Value::as_str)
            .ok_or_else(|| AuthError::BadIdentity("token response missing id_token".to_string()))?;

        let claims = self.verify_id_token(id_token, &pending.nonce, &endpoints).await?;
        let identity = self.claims_to_identity(&claims)?;
        Ok(RedirectOutcome { identity, next: pending.next })
    }

    /// RP-initiated logout: `client_id` + `post_logout_redirect_uri` on the IdP's
    /// end-session endpoint (discovery or explicit config). No `id_token_hint` — without
    /// it a strict IdP shows its own confirmation page, which is still a real logout.
    async fn end_session_url(&self, post_logout_redirect: &str) -> Option<String> {
        let endpoints = match self.resolve_endpoints().await {
            Ok(endpoints) => endpoints,
            Err(error) => {
                log::warn!("OIDC end-session lookup failed; skipping IdP logout: {error}");
                return None;
            }
        };
        let end_session = endpoints.end_session_endpoint?;
        let mut url = format!("{}?client_id={}", end_session, urlencode(&self.config.client_id));
        if !post_logout_redirect.is_empty() {
            url.push_str("&post_logout_redirect_uri=");
            url.push_str(&urlencode(post_logout_redirect));
        }
        Some(url)
    }

    /// Connectivity test: discovery must be reachable and contain the required endpoints.
    async fn test(&self) -> Result<(), AuthError> {
        self.resolve_endpoints().await.map(|_| ())
    }
}

fn urlencode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => encoded.push(byte as char),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}
