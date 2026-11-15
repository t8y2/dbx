//! HTTP-callback authentication: the generic escape hatch for custom auth systems.
//!
//! Any login-style auth system (CAS, DingTalk/WeCom/Feishu QR, in-house SSO, SMS
//! gateways, ...) exposes a small adapter service; DBX POSTs the username/password
//! to it and accepts login on 2xx + identity JSON. Zero DBX-specific code; all auth logic lives outside.

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::identity::{map_role, AuthIdentity, UserRole};
use crate::provider::{AuthError, AuthProvider, AuthProviderKind, FormCredentials, LoginMode};

/// Shared-secret header carried by callback requests.
pub const SHARED_SECRET_HEADER: &str = "X-DBX-Auth-Secret";
/// Response size cap (a callback identity JSON should never be large).
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HttpCallbackConfig {
    /// Adapter service URL. DB-sourced config enforces `https://`; env/local tests may relax it.
    pub url: String,
    /// Shared secret (lets the service verify the request really comes from DBX). Sensitive:
    /// injected from the secret store for DB-sourced config.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_secret: Option<String>,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
    /// Default role when nothing in the role_map matches.
    #[serde(default)]
    pub default_role: Option<UserRole>,
    /// Group/role → DBX role mapping.
    #[serde(default)]
    pub role_map: HashMap<String, String>,
    /// Field paths into the response JSON (dot-separated); defaults to top-level
    /// `subject`/`username`/`display_name`/`email`/`groups`, or any shape (e.g. `user.id`).
    #[serde(default)]
    pub subject_path: Option<String>,
    #[serde(default)]
    pub username_path: Option<String>,
    #[serde(default)]
    pub display_name_path: Option<String>,
    #[serde(default)]
    pub email_path: Option<String>,
    #[serde(default)]
    pub groups_path: Option<String>,
}

fn default_timeout_secs() -> u64 {
    10
}

impl Default for HttpCallbackConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            shared_secret: None,
            timeout_secs: default_timeout_secs(),
            default_role: None,
            role_map: HashMap::new(),
            subject_path: None,
            username_path: None,
            display_name_path: None,
            email_path: None,
            groups_path: None,
        }
    }
}

/// HTTP-callback auth provider.
pub struct HttpCallbackProvider {
    id: String,
    config: HttpCallbackConfig,
    label: String,
    client: reqwest::Client,
}

impl HttpCallbackProvider {
    pub fn new(config: HttpCallbackConfig) -> Result<Self, AuthError> {
        Self::with_id(config, "http_callback")
    }

    /// Distinguishes multiple instances.
    pub fn with_id(config: HttpCallbackConfig, id: impl Into<String>) -> Result<Self, AuthError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_secs))
            // Credentials must never follow redirects elsewhere.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| AuthError::Configuration(format!("HTTP client build failed: {error}")))?;
        Ok(Self { id: id.into(), config, label: "HTTP Auth".to_string(), client })
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = label.into();
        self
    }

    /// Extracts a string by path; an unconfigured path falls back to the top-level standard field, then None.
    fn extract_string(body: &Value, path: &Option<String>, fallback: &str) -> Option<String> {
        let path = path.as_deref().unwrap_or(fallback);
        navigate(body, path).and_then(|value| value.as_str().map(str::to_string)).filter(|value| !value.is_empty())
    }

    fn extract_strings(body: &Value, path: &Option<String>) -> Vec<String> {
        let Some(path) = path.as_deref() else {
            // Default top-level `groups` array.
            return body.get("groups").and_then(Value::as_array).map(|values| {
                values.iter().filter_map(Value::as_str).map(str::to_string).collect()
            }).unwrap_or_default();
        };
        match navigate(body, path) {
            Some(Value::Array(values)) => values.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            Some(Value::String(value)) => vec![value.clone()],
            _ => Vec::new(),
        }
    }
}

#[async_trait]
impl AuthProvider for HttpCallbackProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn kind(&self) -> AuthProviderKind {
        AuthProviderKind::HttpCallback
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn login_mode(&self) -> LoginMode {
        LoginMode::Form
    }

    async fn authenticate(&self, input: &FormCredentials) -> Result<AuthIdentity, AuthError> {
        let username = input.username.as_deref().unwrap_or("").trim();
        if username.is_empty() {
            return Err(AuthError::InvalidCredentials);
        }

        let mut request = self
            .client
            .post(&self.config.url)
            .json(&serde_json::json!({ "username": username, "password": input.password }));
        if let Some(secret) = self.config.shared_secret.as_deref().filter(|secret| !secret.is_empty()) {
            request = request.header(SHARED_SECRET_HEADER, secret);
        }
        let response = request.send().await.map_err(|error| {
            // Network/timeout failures mean "auth service unavailable", distinct from a credential rejection.
            if error.is_timeout() {
                AuthError::ProviderUnavailable("auth callback timed out".to_string())
            } else {
                AuthError::ProviderUnavailable(format!("auth callback failed: {error}"))
            }
        })?;

        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(AuthError::InvalidCredentials);
        }
        if !status.is_success() {
            return Err(AuthError::ProviderUnavailable(format!("auth callback returned {status}")));
        }

        let bytes = response.bytes().await.map_err(|error| AuthError::ProviderUnavailable(format!("auth callback read failed: {error}")))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(AuthError::BadIdentity("auth callback response too large".to_string()));
        }
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|error| AuthError::BadIdentity(format!("auth callback returned invalid JSON: {error}")))?;

        let subject = Self::extract_string(&body, &self.config.subject_path, "subject").unwrap_or_else(|| username.to_string());
        let username = Self::extract_string(&body, &self.config.username_path, "username").unwrap_or_else(|| username.to_string());
        let groups = Self::extract_strings(&body, &self.config.groups_path);
        let role = map_role(&groups, &self.config.role_map, self.config.default_role.unwrap_or(UserRole::Member));

        Ok(AuthIdentity {
            provider_id: self.id.clone(),
            subject,
            username,
            display_name: Self::extract_string(&body, &self.config.display_name_path, "display_name"),
            email: Self::extract_string(&body, &self.config.email_path, "email"),
            groups,
            role,
        })
    }

    /// Connectivity test: the callback endpoint must be reachable and not 5xx. Credential checks happen only on real logins.
    async fn test(&self) -> Result<(), AuthError> {
        let mut request = self.client.post(&self.config.url).json(&serde_json::json!({ "ping": true }));
        if let Some(secret) = self.config.shared_secret.as_deref().filter(|secret| !secret.is_empty()) {
            request = request.header(SHARED_SECRET_HEADER, secret);
        }
        let response = request.send().await.map_err(|error| AuthError::ProviderUnavailable(format!("auth callback failed: {error}")))?;
        let status = response.status();
        if status.is_server_error() {
            return Err(AuthError::ProviderUnavailable(format!("auth callback returned {status}")));
        }
        Ok(())
    }
}

/// Dot-path lookup: object fields only, no array indexing (group paths take the whole group).
fn navigate<'a>(body: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = body;
    for segment in path.split('.') {
        current = current.get(segment)?;
    }
    Some(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::UserRole;
    use std::net::SocketAddr;
    use tokio::net::TcpListener;

    fn provider_at(url: &str) -> HttpCallbackProvider {
        let mut config = HttpCallbackConfig::default();
        config.url = url.to_string();
        config.shared_secret = Some("test-secret".to_string());
        config.role_map = HashMap::from([("ops-admin".to_string(), "admin".to_string())]);
        HttpCallbackProvider::new(config).unwrap()
    }

    async fn spawn_mock(status: u16, body: &'static str, seen_secret: std::sync::Arc<std::sync::Mutex<String>>) -> SocketAddr {
        use axum::{extract::State, http::HeaderMap, routing::post, Router};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(
                "/auth",
                post(
                    move |headers: HeaderMap, State(seen): State<std::sync::Arc<std::sync::Mutex<String>>>| async move {
                    if let Some(secret) = headers.get(SHARED_SECRET_HEADER) {
                        *seen.lock().unwrap() = secret.to_str().unwrap_or_default().to_string();
                    }
                        (axum::http::StatusCode::from_u16(status).unwrap(), body)
                    },
                ),
            )
            .with_state(seen_secret);
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        addr
    }

    #[tokio::test]
    async fn successful_callback_maps_identity() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let addr = spawn_mock(200, r#"{"subject":"u-777","username":"alice","display_name":"Alice","groups":["ops-admin"]}"#, seen.clone()).await;
        let provider = provider_at(&format!("http://{addr}/auth"));

        let identity = provider.authenticate(&FormCredentials { username: Some("alice".into()), password: "pw".into() }).await.unwrap();
        assert_eq!(identity.subject, "u-777");
        assert_eq!(identity.username, "alice");
        assert_eq!(identity.display_name.as_deref(), Some("Alice"));
        assert_eq!(identity.role, UserRole::Admin);
        assert_eq!(seen.lock().unwrap().as_str(), "test-secret");
    }

    #[tokio::test]
    async fn field_paths_follow_configured_shapes() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let addr = spawn_mock(200, r#"{"user":{"id":"u-1"},"name":"Bob"}"#, seen.clone()).await;
        let mut config = HttpCallbackConfig::default();
        config.url = format!("http://{addr}/auth");
        config.subject_path = Some("user.id".to_string());
        config.username_path = Some("name".to_string());
        let provider = HttpCallbackProvider::new(config).unwrap();

        let identity = provider.authenticate(&FormCredentials { username: Some("bob".into()), password: "pw".into() }).await.unwrap();
        assert_eq!(identity.subject, "u-1");
        assert_eq!(identity.username, "Bob");
    }

    #[tokio::test]
    async fn rejection_and_unavailable_are_distinguished() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let addr = spawn_mock(401, "{}", seen.clone()).await;
        let provider = provider_at(&format!("http://{addr}/auth"));
        let error = provider.authenticate(&FormCredentials { username: Some("a".into()), password: "b".into() }).await.unwrap_err();
        assert!(matches!(error, AuthError::InvalidCredentials));

        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let addr = spawn_mock(503, "busy", seen.clone()).await;
        let provider = provider_at(&format!("http://{addr}/auth"));
        let error = provider.authenticate(&FormCredentials { username: Some("a".into()), password: "b".into() }).await.unwrap_err();
        assert!(matches!(error, AuthError::ProviderUnavailable(_)));
    }

    #[test]
    fn navigate_walks_dotted_paths() {
        let body: Value = serde_json::json!({"a": {"b": {"c": "x"}}});
        assert_eq!(navigate(&body, "a.b.c").and_then(Value::as_str), Some("x"));
        assert!(navigate(&body, "a.b.z").is_none());
        assert!(navigate(&body, "a[0]").is_none());
    }
}
