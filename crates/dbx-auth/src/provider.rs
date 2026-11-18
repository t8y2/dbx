//! Unified authentication provider contract.

use std::fmt;
use std::net::IpAddr;

use async_trait::async_trait;
use http::HeaderMap;
use serde::{Deserialize, Serialize};

use crate::identity::AuthIdentity;

/// Provider kind. The login page uses it to render a form or an SSO button.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthProviderKind {
    Local,
    Ldap,
    Oidc,
    HttpCallback,
    ProxyHeader,
}

impl AuthProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthProviderKind::Local => "local",
            AuthProviderKind::Ldap => "ldap",
            AuthProviderKind::Oidc => "oidc",
            AuthProviderKind::HttpCallback => "http_callback",
            AuthProviderKind::ProxyHeader => "proxy_header",
        }
    }
}

/// Login interaction mode.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoginMode {
    /// In-site form: username (possibly optional) + password.
    Form,
    /// Redirect to the IdP, then complete via callback.
    Redirect,
    /// Reverse-proxy-injected identity headers; no interaction needed.
    Proxy,
}

/// Login-page provider description (shared by `GET /api/auth/providers` and `auth/check`).
///
/// `requires_username` is computed by the upper layer from the account layout (see `form_requires_username`):
/// with a single local account the legacy password-only experience is preserved.
#[derive(Debug, Serialize)]
pub struct ProviderInfo {
    pub id: String,
    pub kind: AuthProviderKind,
    pub label: String,
    /// `"form"` | `"redirect"` | `"proxy"`。
    pub mode: &'static str,
    pub requires_username: bool,
}

impl LoginMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            LoginMode::Form => "form",
            LoginMode::Redirect => "redirect",
            LoginMode::Proxy => "proxy",
        }
    }
}

/// Form credentials (Local/Ldap/HttpCallback). An empty `username` lets the provider
/// decide the semantics (e.g. the local single-account path needs no username).
#[derive(Clone, Debug, Default)]
pub struct FormCredentials {
    pub username: Option<String>,
    pub password: String,
}

/// Whether a form provider needs a username input. LDAP/callback always locate the
/// account by username; local only needs it with multiple accounts.
pub fn form_requires_username(kind: AuthProviderKind, local_user_count: usize) -> bool {
    match kind {
        AuthProviderKind::Local => local_user_count > 1,
        AuthProviderKind::Ldap | AuthProviderKind::HttpCallback => true,
        AuthProviderKind::Oidc | AuthProviderKind::ProxyHeader => false,
    }
}

/// Outcome of starting an OIDC authorization redirect.
#[derive(Debug)]
pub struct RedirectInit {
    /// Full IdP authorization URL (state/PKCE/nonce already included).
    pub authorization_url: String,
}

/// Outcome of the OIDC callback: the identity plus the `next` carried from the
#[derive(Debug)]
pub struct RedirectOutcome {
    pub identity: AuthIdentity,
    pub next: Option<String>,
}

impl From<AuthIdentity> for RedirectOutcome {
    fn from(identity: AuthIdentity) -> Self {
        Self { identity, next: None }
    }
}

/// Normalized extraction of OIDC callback query parameters.
#[derive(Debug, Default, Clone, serde::Deserialize)]
pub struct CallbackParams {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// Authentication errors. Collapsed at the HTTP layer to avoid leaking internals to unauthenticated callers.
#[derive(Debug)]
pub enum AuthError {
    /// Wrong credentials or unknown account (presented as the same error).
    InvalidCredentials,
    /// The account is disabled.
    UserDisabled,
    /// The login rate-limit lockout tripped.
    RateLimited { retry_after_secs: u64 },
    /// The provider is currently unavailable (upstream unreachable, etc.).
    ProviderUnavailable(String),
    /// The provider configuration is incomplete or invalid.
    Configuration(String),
    /// The login requires a username (e.g. several local accounts exist) but none was supplied.
    UsernameRequired,
    /// The provider does not support the requested operation (e.g. OIDC on the form path).
    Unsupported,
    /// The upstream returned an unparsable identity.
    BadIdentity(String),
    /// Any other internal error.
    Internal(String),
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthError::InvalidCredentials => write!(f, "invalid credentials"),
            AuthError::UserDisabled => write!(f, "user disabled"),
            AuthError::RateLimited { retry_after_secs } => write!(f, "rate limited, retry in {retry_after_secs}s"),
            AuthError::ProviderUnavailable(message) => write!(f, "auth provider unavailable: {message}"),
            AuthError::Configuration(message) => write!(f, "auth provider misconfigured: {message}"),
            AuthError::UsernameRequired => write!(f, "username required"),
            AuthError::Unsupported => write!(f, "operation unsupported by provider"),
            AuthError::BadIdentity(message) => write!(f, "unparsable identity from provider: {message}"),
            AuthError::Internal(message) => write!(f, "auth internal error: {message}"),
        }
    }
}

impl std::error::Error for AuthError {}

/// Unified auth-provider contract. Mode-specific methods have default
/// implementations (returning `AuthError::Unsupported`); implementations override per `login_mode`.
#[async_trait]
pub trait AuthProvider: Send + Sync {
    /// Provider id (login requests route by it; the local provider is fixed to `local`).
    fn id(&self) -> &str;
    fn kind(&self) -> AuthProviderKind;
    fn label(&self) -> &str;
    fn login_mode(&self) -> LoginMode;

    /// Externally visible origin override (redirect_uri precedence: provider config >
    /// DBX_PUBLIC_URL > request-header derivation).
    fn public_url(&self) -> Option<&str> {
        None
    }

    /// Form authentication (Local/Ldap/HttpCallback).
    async fn authenticate(&self, _input: &FormCredentials) -> Result<AuthIdentity, AuthError> {
        Err(AuthError::Unsupported)
    }

    /// Proxy-header authentication (ProxyHeader). `None` means the request carries no trustworthy identity.
    async fn authenticate_proxy(&self, _client_ip: IpAddr, _headers: &HeaderMap) -> Option<AuthIdentity> {
        None
    }

    /// Start an OIDC authorization redirect (resolve discovery / generate state+PKCE).
    async fn begin_redirect(&self, _redirect_uri: &str, _next: Option<&str>) -> Result<RedirectInit, AuthError> {
        Err(AuthError::Unsupported)
    }

    /// Handle the OIDC callback and produce the identity (including the `next` target from the start).
    async fn complete_redirect(&self, _query: &CallbackParams, _redirect_uri: &str) -> Result<RedirectOutcome, AuthError> {
        Err(AuthError::Unsupported)
    }

    /// Logout hook (proxy providers record a grace period to stop proxy SSO from instantly re-logging-in).
    async fn on_logout(&self, _username: &str) {}

    /// RP-initiated logout: the IdP end-session URL the browser should be sent to after the
    /// local session is destroyed, so the IdP-side SSO session does not silently re-login on
    /// the next authorize round-trip. `None` = no IdP session to end (form/proxy providers).
    /// `post_logout_redirect` is the absolute app URL the IdP sends the browser back to; the
    /// caller derives it from the public origin (provider public_url > DBX_PUBLIC_URL > request
    /// headers). Failures resolve to `None` — logout must not break because discovery is down.
    async fn end_session_url(&self, _post_logout_redirect: &str) -> Option<String> {
        None
    }

    /// Admin-side connectivity test.
    async fn test(&self) -> Result<(), AuthError> {
        Ok(())
    }
}
