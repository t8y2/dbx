//! Salesforce OAuth flows (spec §2, milestone M2).
//!
//! Three grant paths, all against `{loginBase}/services/oauth2/*`:
//! - **Authorization Code + PKCE** ([`authorize_with_browser`]) — desktop app;
//!   opens the system browser, catches the redirect on a fixed localhost port
//!   (same shape as `mongo_oidc.rs`, own port so both flows can coexist).
//! - **Device Flow** ([`device_authorization_request`] + [`device_poll`]) —
//!   works in web mode too: the backend never opens a browser, the frontend
//!   shows the user code and drives the polling loop.
//! - **Refresh** ([`refresh_access_token`]) — used by the driver on 401 and
//!   available for explicit re-auth without a browser.
//! - **Username-password (ROPC)** ([`password_grant_token`]) — deprecated by
//!   Salesforce but common in corporate orgs; no refresh token is issued, so
//!   the driver replays the login on 401 ([`SfRefreshMethod`]).
//!
//! The Connected App is bring-your-own for now (decision D1): users register
//! one in their org with callback URL [`SALESFORCE_OAUTH_REDIRECT_URI`] and
//! PKCE enabled. A bundled client id can be slotted into the defaults later
//! without changing any of this module's API.

use std::{
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex,
};

/// Redirect URI users must register in their Salesforce Connected App.
pub const SALESFORCE_OAUTH_REDIRECT_URI: &str = "http://localhost:27098/callback";
const OAUTH_CALLBACK_ADDRESS: &str = "127.0.0.1:27098";
const OAUTH_CALLBACK_PATH: &str = "/callback";
/// Browser flows block the calling command until the user finishes login;
/// keep the same budget as the MongoDB OIDC precedent.
pub const SALESFORCE_OAUTH_BROWSER_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CALLBACK_REQUEST_BYTES: usize = 16 * 1024;
/// `refresh_token` = offline access (survives session expiry), `api` = data
/// access. Users can narrow permissions per Connected App policy.
const OAUTH_SCOPES: &str = "refresh_token api";
/// Salesforce's device-flow grant type (it predates RFC 8628 and uses its own
/// string for both the initial request and the poll).
const DEVICE_GRANT_TYPE: &str = "device_code";
/// Poll floor; Salesforce recommends 5s and answers `slow_down` otherwise.
const MIN_DEVICE_POLL_INTERVAL_SECS: u64 = 5;

pub type SfBrowserOpener = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// Which Salesforce login host to authorize against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SfLoginEnvironment {
    #[default]
    Production,
    Sandbox,
    /// Custom My Domain / proxy host supplied via [`SfOauthParams::login_url`].
    Custom,
}

/// Everything needed to run any of the three flows. Mirrors the
/// `external_config.auth` object persisted with the connection (camelCase).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SfOauthParams {
    pub environment: SfLoginEnvironment,
    /// Only for [`SfLoginEnvironment::Custom`].
    pub login_url: Option<String>,
    pub client_id: String,
    /// Optional: only confidential Connected Apps need it (PKCE public apps
    /// must leave it empty).
    pub client_secret: Option<String>,
}

/// Token bundle returned to the caller. `instance_url` is what the connection
/// `host` field should be set to (org-specific, e.g. My Domain).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SfTokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub instance_url: String,
}

/// Result of [`refresh_access_token`]. Salesforce echoes `instance_url` on
/// refresh; when it does not (older behavior) callers keep their known URL.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SfRefreshedToken {
    pub access_token: String,
    /// Present only when Salesforce rotated it; otherwise keep the old one.
    pub refresh_token: Option<String>,
    pub instance_url: Option<String>,
}

/// Device-flow kickoff response; the frontend shows `user_code` +
/// `verification_uri` and polls every `interval_secs`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SfDeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval_secs: u64,
    pub expires_in_secs: u64,
}

/// One device-flow poll result (frontend drives the loop so it can cancel).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SfDevicePoll {
    /// Not decided yet; wait `interval_secs` (already includes `slow_down`
    /// backoff) and poll again.
    Pending {
        interval_secs: u64,
    },
    Success {
        token: SfTokenSet,
    },
    Expired,
    Denied {
        reason: Option<String>,
    },
}

#[derive(Clone, Copy)]
enum EndpointPolicy {
    HttpsOnly,
    #[cfg(test)]
    AllowLoopbackHttp,
}

impl EndpointPolicy {
    fn parse_url(self, value: &str, description: &str) -> Result<Url, String> {
        let url = Url::parse(value).map_err(|err| oauth_error(format!("invalid {description}: {err}")))?;
        if url.scheme() == "https" {
            return Ok(url);
        }
        #[cfg(test)]
        if matches!(self, Self::AllowLoopbackHttp)
            && url.scheme() == "http"
            && url.host_str().is_some_and(|host| {
                host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
            })
        {
            return Ok(url);
        }
        Err(oauth_error(format!("{description} must use HTTPS")))
    }
}

/// Distinct from a transport error: OAuth-protocol refusals (device polling
/// especially) are expected states, not failures.
#[derive(Debug)]
enum TokenEndpointError {
    Oauth { error: String, description: Option<String> },
    Other(String),
}

fn oauth_error(message: impl Into<String>) -> String {
    format!("Salesforce OAuth failed: {}", message.into())
}

fn browser_flow_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Resolve the login host for the flow. Custom hosts must be https and are
/// normalized (no trailing slash, no path/query).
pub fn login_base_url(params: &SfOauthParams) -> Result<String, String> {
    login_base_url_with_policy(params, EndpointPolicy::HttpsOnly)
}

/// Same as [`login_base_url`], but the caller's endpoint policy decides whether a
/// custom login URL may be loopback HTTP — test builds only, so the mock OAuth
/// server the tests run is reachable while production stays HTTPS-only.
fn login_base_url_with_policy(params: &SfOauthParams, policy: EndpointPolicy) -> Result<String, String> {
    let base = match params.environment {
        SfLoginEnvironment::Production => "https://login.salesforce.com".to_string(),
        SfLoginEnvironment::Sandbox => "https://test.salesforce.com".to_string(),
        SfLoginEnvironment::Custom => {
            let raw = params.login_url.as_deref().unwrap_or("").trim().trim_end_matches('/');
            if raw.is_empty() {
                return Err(oauth_error("custom login URL is required for the 'custom' environment"));
            }
            let url = if raw.starts_with("http://") || raw.starts_with("https://") {
                raw.to_string()
            } else {
                format!("https://{raw}")
            };
            let parsed = policy.parse_url(&url, "custom login URL")?;
            format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or_default())
                + &parsed.port().map(|port| format!(":{port}")).unwrap_or_default()
        }
    };
    if params.client_id.trim().is_empty() {
        return Err(oauth_error("client ID is required (create a Connected App with PKCE enabled)"));
    }
    Ok(base)
}

fn random_url_safe_value() -> String {
    let first = uuid::Uuid::new_v4();
    let second = uuid::Uuid::new_v4();
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(first.as_bytes());
    bytes[16..].copy_from_slice(second.as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn s256_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn token_endpoint(base: &str) -> String {
    format!("{base}/services/oauth2/token")
}

fn authorize_endpoint(base: &str) -> String {
    format!("{base}/services/oauth2/authorize")
}

fn build_authorize_url(
    params: &SfOauthParams,
    state: &str,
    code_challenge: &str,
    policy: EndpointPolicy,
) -> Result<Url, String> {
    let base = login_base_url_with_policy(params, policy)?;
    let mut url = policy.parse_url(&authorize_endpoint(&base), "authorization endpoint")?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", params.client_id.trim())
        .append_pair("redirect_uri", SALESFORCE_OAUTH_REDIRECT_URI)
        .append_pair("scope", OAUTH_SCOPES)
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256");
    Ok(url)
}

async fn write_callback_response(stream: &mut tokio::net::TcpStream, success: bool) {
    let (status, title, body) = if success {
        (
            "200 OK",
            "Salesforce authorization received",
            "DBX received the authorization response. Return to DBX to finish saving the connection.",
        )
    } else {
        (
            "400 Bad Request",
            "Authorization failed",
            "DBX could not complete the Salesforce authorization. Return to DBX for details.",
        )
    };
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title><style>body{{font-family:system-ui,sans-serif;margin:48px;color:#202124}}h1{{font-size:22px}}</style></head><body><h1>{title}</h1><p>{body}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[derive(Debug)]
struct AuthorizationCallback {
    code: String,
    state: String,
}

fn parse_callback_target(target: &str) -> Result<AuthorizationCallback, String> {
    let url = Url::parse(&format!("http://localhost{target}")).map_err(|err| format!("invalid callback URL: {err}"))?;
    if url.path() != OAUTH_CALLBACK_PATH {
        return Err("unexpected callback path".to_string());
    }
    let mut code = None;
    let mut state = None;
    let mut provider_error = None;
    let mut provider_error_description = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => provider_error = Some(value.into_owned()),
            "error_description" => provider_error_description = Some(value.into_owned()),
            _ => {}
        }
    }
    if let Some(error) = provider_error {
        let detail = provider_error_description.map(|description| format!(": {description}")).unwrap_or_default();
        return Err(format!("Salesforce returned {error}{detail}"));
    }
    Ok(AuthorizationCallback {
        code: code.ok_or_else(|| "callback did not include an authorization code".to_string())?,
        state: state.ok_or_else(|| "callback did not include state".to_string())?,
    })
}

async fn wait_for_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    'requests: loop {
        let (mut stream, _) =
            listener.accept().await.map_err(|err| oauth_error(format!("callback listener failed: {err}")))?;
        let mut buffer = Vec::with_capacity(1024);
        loop {
            if buffer.len() == MAX_CALLBACK_REQUEST_BYTES {
                write_callback_response(&mut stream, false).await;
                continue 'requests;
            }
            let mut chunk = [0_u8; 1024];
            let remaining = MAX_CALLBACK_REQUEST_BYTES - buffer.len();
            let read_len = remaining.min(chunk.len());
            let bytes_read = match stream.read(&mut chunk[..read_len]).await {
                Ok(bytes_read) => bytes_read,
                Err(_) => {
                    write_callback_response(&mut stream, false).await;
                    continue 'requests;
                }
            };
            if bytes_read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..bytes_read]);
            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let request = String::from_utf8_lossy(&buffer);
        let target = request.lines().next().and_then(|line| line.split_whitespace().nth(1)).map(str::to_owned);
        let Some(target) = target else {
            write_callback_response(&mut stream, false).await;
            continue;
        };
        let callback = match parse_callback_target(&target) {
            Ok(callback) => callback,
            Err(_) => {
                write_callback_response(&mut stream, false).await;
                continue;
            }
        };
        if callback.state != expected_state {
            write_callback_response(&mut stream, false).await;
            continue;
        }
        write_callback_response(&mut stream, true).await;
        return Ok(callback.code);
    }
}

/// POST the token endpoint and split transport failures from OAuth refusals.
async fn post_token_form(
    params: &SfOauthParams,
    form: &[(&str, &str)],
    policy: EndpointPolicy,
) -> Result<Value, TokenEndpointError> {
    let base = login_base_url_with_policy(params, policy).map_err(TokenEndpointError::Other)?;
    let endpoint = policy.parse_url(&token_endpoint(&base), "token endpoint").map_err(TokenEndpointError::Other)?;
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|err| TokenEndpointError::Other(oauth_error(format!("failed to create HTTP client: {err}"))))?;
    let response = client
        .post(endpoint)
        .form(form)
        .send()
        .await
        .map_err(|err| TokenEndpointError::Other(oauth_error(format!("token request failed: {err}"))))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(value);
    }
    let error = value.get("error").and_then(Value::as_str).unwrap_or_default().to_string();
    if !error.is_empty() {
        return Err(TokenEndpointError::Oauth {
            description: value.get("error_description").and_then(Value::as_str).map(str::to_string),
            error,
        });
    }
    let detail = body.chars().take(300).collect::<String>();
    Err(TokenEndpointError::Other(oauth_error(format!("token endpoint returned HTTP {status}: {detail}"))))
}

fn token_set_from_value(value: &Value, require_instance_url: bool) -> Result<SfTokenSet, String> {
    let access_token = value.get("access_token").and_then(Value::as_str).unwrap_or_default().to_string();
    if access_token.is_empty() {
        return Err(oauth_error("token response did not include an access token"));
    }
    let instance_url =
        value.get("instance_url").and_then(Value::as_str).unwrap_or_default().trim().trim_end_matches('/').to_string();
    if require_instance_url && instance_url.is_empty() {
        return Err(oauth_error("token response did not include an instance URL"));
    }
    Ok(SfTokenSet {
        access_token,
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .map(str::to_string),
        instance_url,
    })
}

fn client_secret_pair(params: &SfOauthParams) -> Option<String> {
    params.client_secret.as_deref().map(str::trim).filter(|secret| !secret.is_empty()).map(str::to_string)
}

/// Authorization Code + PKCE via the system browser (desktop only).
///
/// Blocks until the user completes login, denies it, or 5 minutes pass. Only
/// one browser flow may run at a time (shared lock with nothing else — Mongo
/// OIDC keeps its own).
pub async fn authorize_with_browser(params: &SfOauthParams, opener: &SfBrowserOpener) -> Result<SfTokenSet, String> {
    authorize_with_browser_policy(params, opener, EndpointPolicy::HttpsOnly).await
}

async fn authorize_with_browser_policy(
    params: &SfOauthParams,
    opener: &SfBrowserOpener,
    policy: EndpointPolicy,
) -> Result<SfTokenSet, String> {
    let deadline = Instant::now() + SALESFORCE_OAUTH_BROWSER_TIMEOUT;
    let remaining = || {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(oauth_error("browser authorization timed out"));
        }
        Ok(remaining)
    };

    let _flow_guard = tokio::time::timeout(remaining()?, browser_flow_lock().lock())
        .await
        .map_err(|_| oauth_error("browser authorization timed out"))?;
    let listener = TcpListener::bind(OAUTH_CALLBACK_ADDRESS)
        .await
        .map_err(|err| oauth_error(format!("cannot listen on {SALESFORCE_OAUTH_REDIRECT_URI}: {err}")))?;

    let state = random_url_safe_value();
    let verifier = random_url_safe_value();
    let authorize_url = build_authorize_url(params, &state, &s256_challenge(&verifier), policy)?;
    opener(authorize_url.as_str())?;

    let code = tokio::time::timeout(remaining()?, wait_for_callback(listener, &state))
        .await
        .map_err(|_| oauth_error("browser authorization timed out"))??;

    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "authorization_code"),
        ("client_id", params.client_id.trim()),
        ("code", code.as_str()),
        ("redirect_uri", SALESFORCE_OAUTH_REDIRECT_URI),
        ("code_verifier", verifier.as_str()),
    ];
    let client_secret = client_secret_pair(params);
    if let Some(secret) = client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    let value = post_token_form(params, &form, policy).await.map_err(token_error_to_string)?;
    token_set_from_value(&value, true)
}

/// Kick off the device flow. Salesforce returns a short `user_code` the user
/// enters at `verification_uri` on any device.
pub async fn device_authorization_request(params: &SfOauthParams) -> Result<SfDeviceAuthorization, String> {
    device_authorization_request_policy(params, EndpointPolicy::HttpsOnly).await
}

async fn device_authorization_request_policy(
    params: &SfOauthParams,
    policy: EndpointPolicy,
) -> Result<SfDeviceAuthorization, String> {
    let form = [("grant_type", DEVICE_GRANT_TYPE), ("client_id", params.client_id.trim()), ("scope", OAUTH_SCOPES)];
    let value = post_token_form(params, &form, policy).await.map_err(token_error_to_string)?;
    let required = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string)
            .ok_or_else(|| oauth_error(format!("device authorization response missing '{key}'")))
    };
    let interval = value.get("interval").and_then(Value::as_u64).unwrap_or(MIN_DEVICE_POLL_INTERVAL_SECS);
    Ok(SfDeviceAuthorization {
        device_code: required("device_code")?,
        user_code: required("user_code")?,
        verification_uri: required("verification_uri")?,
        interval_secs: interval.max(MIN_DEVICE_POLL_INTERVAL_SECS),
        expires_in_secs: value.get("expires_in").and_then(Value::as_u64).unwrap_or(600),
    })
}

/// One device-flow poll. Never returns `Pending` errors for
/// `authorization_pending` / `slow_down` — those are normal states.
pub async fn device_poll(
    params: &SfOauthParams,
    device_code: &str,
    interval_secs: u64,
) -> Result<SfDevicePoll, String> {
    device_poll_policy(params, device_code, interval_secs, EndpointPolicy::HttpsOnly).await
}

async fn device_poll_policy(
    params: &SfOauthParams,
    device_code: &str,
    interval_secs: u64,
    policy: EndpointPolicy,
) -> Result<SfDevicePoll, String> {
    let current_interval = interval_secs.max(MIN_DEVICE_POLL_INTERVAL_SECS);
    let form = [("grant_type", DEVICE_GRANT_TYPE), ("client_id", params.client_id.trim()), ("code", device_code)];
    match post_token_form(params, &form, policy).await {
        Ok(value) => {
            let token = token_set_from_value(&value, true)?;
            Ok(SfDevicePoll::Success { token })
        }
        Err(TokenEndpointError::Oauth { error, description }) => match error.as_str() {
            "authorization_pending" => Ok(SfDevicePoll::Pending { interval_secs: current_interval }),
            "slow_down" => Ok(SfDevicePoll::Pending { interval_secs: current_interval + 5 }),
            "expired_token" | "expired_device_code" => Ok(SfDevicePoll::Expired),
            "access_denied" => Ok(SfDevicePoll::Denied { reason: description }),
            other => Err(oauth_error(format!(
                "device authorization refused ({other}){}",
                description.map(|detail| format!(": {detail}")).unwrap_or_default()
            ))),
        },
        Err(TokenEndpointError::Other(message)) => Err(message),
    }
}

/// Exchange a stored refresh token for a fresh access token. Used by the
/// driver on 401 and by the UI for explicit re-auth.
pub async fn refresh_access_token(params: &SfOauthParams, refresh_token: &str) -> Result<SfRefreshedToken, String> {
    refresh_access_token_policy(params, refresh_token, EndpointPolicy::HttpsOnly).await
}

async fn refresh_access_token_policy(
    params: &SfOauthParams,
    refresh_token: &str,
    policy: EndpointPolicy,
) -> Result<SfRefreshedToken, String> {
    if refresh_token.trim().is_empty() {
        return Err(oauth_error("refresh token is empty"));
    }
    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "refresh_token"),
        ("client_id", params.client_id.trim()),
        ("refresh_token", refresh_token.trim()),
    ];
    let client_secret = client_secret_pair(params);
    if let Some(secret) = client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    let value = post_token_form(params, &form, policy).await.map_err(token_error_to_string)?;
    let access_token = value.get("access_token").and_then(Value::as_str).unwrap_or_default().to_string();
    if access_token.is_empty() {
        return Err(oauth_error("refresh response did not include an access token"));
    }
    Ok(SfRefreshedToken {
        access_token,
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty() && *token != refresh_token.trim())
            .map(str::to_string),
        instance_url: value
            .get("instance_url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(|url| url.trim_end_matches('/').to_string()),
    })
}

fn token_error_to_string(error: TokenEndpointError) -> String {
    match error {
        TokenEndpointError::Oauth { error, description } => {
            oauth_error(format!("{error}{}", description.map(|detail| format!(" ({detail})")).unwrap_or_default()))
        }
        TokenEndpointError::Other(message) => message,
    }
}

/// Username-password flow (ROPC). Deprecated by Salesforce but still enabled
/// on many orgs via Session Settings → "Permit users to exchange
/// username–password credentials for an access token", and the grant many
/// corporate integrations already rely on. Issues **no refresh token** — the
/// driver re-runs this grant with the stored credentials when the session
/// expires instead.
pub async fn password_grant_token(
    params: &SfOauthParams,
    username: &str,
    password: &str,
) -> Result<SfTokenSet, String> {
    password_grant_token_policy(params, username, password, EndpointPolicy::HttpsOnly).await
}

async fn password_grant_token_policy(
    params: &SfOauthParams,
    username: &str,
    password: &str,
    policy: EndpointPolicy,
) -> Result<SfTokenSet, String> {
    if username.trim().is_empty() || password.is_empty() {
        return Err(oauth_error("username and password are required"));
    }
    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "password"),
        ("client_id", params.client_id.trim()),
        ("username", username.trim()),
        ("password", password),
        ("format", "json"),
    ];
    let client_secret = client_secret_pair(params);
    if let Some(secret) = client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    let value = post_token_form(params, &form, policy).await.map_err(|error| match error {
        TokenEndpointError::Oauth { error, description } => oauth_error(format!(
            "{error}{} — check the username (sandbox users end with the sandbox name, e.g. user@example.com.qas1), \
             the password (append your security token if your IP is not trusted), and that the org permits the \
             username-password flow (Session Settings). MFA-enforced users cannot use this grant.",
            description.map(|detail| format!(" ({detail})")).unwrap_or_default()
        )),
        TokenEndpointError::Other(message) => message,
    })?;
    token_set_from_value(&value, true)
}

/// How a saved connection re-authenticates when its access token expires.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SfRefreshMethod {
    /// OAuth flows: exchange the stored refresh token.
    RefreshToken(String),
    /// Username-password flow: Salesforce issues no refresh token, so the
    /// driver replays the login with the stored credentials.
    Password { username: String, password: String },
}

/// Parse the `external_config.auth` object a saved Salesforce connection
/// carries (values hydrated from the secret store by dbx-core). Returns
/// `None` when no automatic re-auth is configured (pasted-token mode).
pub fn oauth_params_from_external_config(external_config: Option<&Value>) -> Option<(SfOauthParams, SfRefreshMethod)> {
    let auth = external_config?.get("auth")?;
    let client_id = auth.get("clientId").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    if client_id.is_empty() {
        return None;
    }
    let text = |key: &str| auth.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let mode = text("mode");
    let refresh_token = text("refreshToken");
    let method = if mode == "password" {
        let username = text("username");
        let password = auth.get("password").and_then(Value::as_str).unwrap_or_default().to_string();
        if username.is_empty() || password.is_empty() {
            return None;
        }
        SfRefreshMethod::Password { username, password }
    } else if !refresh_token.is_empty() {
        SfRefreshMethod::RefreshToken(refresh_token)
    } else {
        return None;
    };
    let environment = match text("environment").as_str() {
        "sandbox" => SfLoginEnvironment::Sandbox,
        "custom" => SfLoginEnvironment::Custom,
        _ => SfLoginEnvironment::Production,
    };
    let login_url = text("loginUrl");
    let client_secret = text("clientSecret");
    let params = SfOauthParams {
        environment,
        login_url: (!login_url.is_empty()).then_some(login_url),
        client_id,
        client_secret: (!client_secret.is_empty()).then_some(client_secret),
    };
    Some((params, method))
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        sync::{Arc, Mutex as StdMutex},
        time::Duration,
    };

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        task::JoinHandle,
    };

    use super::*;

    fn params(login_base: &str) -> SfOauthParams {
        SfOauthParams {
            environment: SfLoginEnvironment::Custom,
            login_url: Some(login_base.to_string()),
            client_id: "dbx-connected-app".to_string(),
            client_secret: None,
        }
    }

    async fn read_http_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        loop {
            let mut chunk = [0_u8; 1024];
            let read = AsyncReadExt::read(stream, &mut chunk).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        String::from_utf8(request).unwrap()
    }

    async fn write_json_response(stream: &mut tokio::net::TcpStream, body: &str) {
        // Salesforce answers OAuth refusals (`invalid_grant`, `authorization_pending`, …)
        // with HTTP 400 plus an `error` body, and `post_token_form` branches on the
        // status — so the mock has to reproduce that instead of always saying 200.
        let is_oauth_error = serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|value| value.get("error").and_then(Value::as_str).map(|error| !error.is_empty()))
            .unwrap_or(false);
        let status = if is_oauth_error { "400 Bad Request" } else { "200 OK" };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    }

    /// Mock OAuth server: every POST to /services/oauth2/token is recorded and
    /// answered by the shared queue of JSON bodies (or the default token body).
    async fn start_mock_oauth_server(responses: Vec<String>) -> (String, Arc<StdMutex<Vec<String>>>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let server_requests = requests.clone();
        let task = tokio::spawn(async move {
            let mut responses = responses;
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { break };
                let request = read_http_request(&mut stream).await;
                server_requests.lock().unwrap().push(request.clone());
                let body = if responses.is_empty() {
                    r#"{"access_token":"token","refresh_token":"refresh","instance_url":"https://acme.my.salesforce.com/"}"#
                        .to_string()
                } else {
                    responses.remove(0)
                };
                write_json_response(&mut stream, &body).await;
            }
        });
        (base, requests, task)
    }

    #[test]
    fn login_base_url_resolves_environments() {
        let production = SfOauthParams { client_id: "c".into(), ..Default::default() };
        assert_eq!(login_base_url(&production).unwrap(), "https://login.salesforce.com");
        let sandbox =
            SfOauthParams { environment: SfLoginEnvironment::Sandbox, client_id: "c".into(), ..Default::default() };
        assert_eq!(login_base_url(&sandbox).unwrap(), "https://test.salesforce.com");
        let custom = params("https://acme.my.salesforce.com/");
        assert_eq!(login_base_url(&custom).unwrap(), "https://acme.my.salesforce.com");
        // missing client id
        let missing = SfOauthParams::default();
        assert!(login_base_url(&missing).unwrap_err().contains("client ID is required"));
        // custom without url
        let no_url =
            SfOauthParams { environment: SfLoginEnvironment::Custom, client_id: "c".into(), ..Default::default() };
        assert!(login_base_url(&no_url).is_err());
        // non-https custom
        let insecure = params("http://acme.my.salesforce.com");
        assert!(login_base_url(&insecure).unwrap_err().contains("HTTPS"));
    }

    #[test]
    fn authorize_url_carries_pkce_state_and_scopes() {
        let url = build_authorize_url(
            &params("https://acme.my.salesforce.com"),
            "expected-state",
            "challenge",
            EndpointPolicy::HttpsOnly,
        )
        .unwrap();
        assert_eq!(url.as_str().split('?').next().unwrap(), "https://acme.my.salesforce.com/services/oauth2/authorize");
        let query = url.query_pairs().collect::<std::collections::HashMap<_, _>>();
        let param = |key: &str| query.get(key).map(|value| value.as_ref());
        assert_eq!(param("response_type"), Some("code"));
        assert_eq!(param("redirect_uri"), Some(SALESFORCE_OAUTH_REDIRECT_URI));
        assert_eq!(param("code_challenge_method"), Some("S256"));
        assert_eq!(param("state"), Some("expected-state"));
        assert_eq!(param("scope"), Some(OAUTH_SCOPES));
        assert!(!query.get("client_id").unwrap().is_empty());
        // production authorize url hits login.salesforce.com even when the org
        // instance is a my-domain host
        let production = SfOauthParams { client_id: "c".into(), ..Default::default() };
        let url = build_authorize_url(&production, "s", "ch", EndpointPolicy::HttpsOnly).unwrap();
        assert!(url.as_str().starts_with("https://login.salesforce.com/services/oauth2/authorize?"));
    }

    #[test]
    fn s256_challenge_matches_rfc_example() {
        // RFC 7636 Appendix B test vector.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(s256_challenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn callback_requires_code_and_state() {
        let callback = parse_callback_target("/callback?code=abc&state=xyz").unwrap();
        assert_eq!(callback.code, "abc");
        assert_eq!(callback.state, "xyz");
        assert!(parse_callback_target("/redirect?code=abc&state=xyz").is_err());
        assert!(parse_callback_target("/callback?error=access_denied&error_description=user+cancelled")
            .unwrap_err()
            .contains("access_denied: user cancelled"));
    }

    #[tokio::test]
    async fn callback_ignores_invalid_requests_until_matching_state() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let callback = tokio::spawn(wait_for_callback(listener, "expected-state"));

        for target in ["/callback?code=wrong&state=wrong-state", "/callback?error=access_denied"] {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream
                .write_all(format!("GET {target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").as_bytes())
                .await
                .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).await.unwrap();
            assert!(response.starts_with("HTTP/1.1 400 Bad Request"));
        }

        let mut stream = TcpStream::connect(address).await.unwrap();
        stream
            .write_all(b"GET /callback?code=valid-code&state=expected-state HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert_eq!(callback.await.unwrap().unwrap(), "valid-code");
    }

    #[tokio::test]
    async fn browser_flow_exchanges_pkce_code_for_tokens() {
        let (base, requests, server) = start_mock_oauth_server(Vec::new()).await;
        let opened = Arc::new(StdMutex::new(None));
        let captured = opened.clone();
        let opener: SfBrowserOpener = Arc::new(move |url| {
            let parsed = Url::parse(url).unwrap();
            let state = parsed.query_pairs().find_map(|(k, v)| (k == "state").then(|| v.into_owned())).unwrap();
            *captured.lock().unwrap() = Some(parsed);
            std::thread::spawn(move || {
                let mut stream = std::net::TcpStream::connect("127.0.0.1:27098").unwrap();
                write!(stream, "GET /callback?code=auth-code&state={state}").unwrap();
                std::thread::sleep(Duration::from_millis(10));
                write!(stream, " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
                let mut response = String::new();
                stream.read_to_string(&mut response).unwrap();
                assert!(response.starts_with("HTTP/1.1 200 OK"));
            });
            Ok(())
        });

        let tokens =
            authorize_with_browser_policy(&params(&base), &opener, EndpointPolicy::AllowLoopbackHttp).await.unwrap();
        server.abort();

        assert_eq!(tokens.access_token, "token");
        assert_eq!(tokens.refresh_token.as_deref(), Some("refresh"));
        assert_eq!(tokens.instance_url, "https://acme.my.salesforce.com");
        let authorize_url = opened.lock().unwrap().clone().unwrap();
        assert!(authorize_url.query_pairs().find(|(k, _)| k == "code_challenge").unwrap().1.len() > 20);
        let recorded = requests.lock().unwrap();
        assert!(recorded[0].contains("grant_type=authorization_code"));
        assert!(recorded[0].contains("code=auth-code"));
        assert!(recorded[0].contains("code_verifier="));
        assert!(!recorded[0].contains("client_secret"));
    }

    #[tokio::test]
    async fn confidential_app_sends_client_secret() {
        let (base, requests, server) = start_mock_oauth_server(Vec::new()).await;
        let opener: SfBrowserOpener = Arc::new(move |url| {
            let parsed = Url::parse(url).unwrap();
            let state = parsed.query_pairs().find_map(|(k, v)| (k == "state").then(|| v.into_owned())).unwrap();
            std::thread::spawn(move || {
                let mut stream = std::net::TcpStream::connect("127.0.0.1:27098").unwrap();
                write!(
                    stream,
                    "GET /callback?code=c&state={state} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
                let mut response = String::new();
                let _ = stream.read_to_string(&mut response);
            });
            Ok(())
        });
        let mut confidential = params(&base);
        confidential.client_secret = Some("app-secret".to_string());
        let _ = authorize_with_browser_policy(&confidential, &opener, EndpointPolicy::AllowLoopbackHttp).await.unwrap();
        server.abort();
        assert!(requests.lock().unwrap()[0].contains("client_secret=app-secret"));
    }

    #[tokio::test]
    async fn device_flow_start_and_poll_states() {
        let (base, requests, server) = start_mock_oauth_server(vec![
            r#"{"device_code":"dev-code","user_code":"ABCD-1234","verification_uri":"https://login.salesforce.com/setup/connect","interval":5,"expires_in":600}"#.to_string(),
            r#"{"error":"authorization_pending"}"#.to_string(),
            r#"{"error":"slow_down"}"#.to_string(),
            r#"{"error":"access_denied","error_description":"user said no"}"#.to_string(),
            r#"{"error":"expired_token"}"#.to_string(),
            r#"{"access_token":"device-token","refresh_token":"device-refresh","instance_url":"https://acme.my.salesforce.com"}"#.to_string(),
        ])
        .await;
        let p = params(&base);
        let policy = EndpointPolicy::AllowLoopbackHttp;

        let auth = device_authorization_request_policy(&p, policy).await.unwrap();
        assert_eq!(auth.user_code, "ABCD-1234");
        assert_eq!(auth.device_code, "dev-code");
        assert_eq!(auth.interval_secs, 5);
        assert!(auth.verification_uri.starts_with("https://"));

        assert!(matches!(
            device_poll_policy(&p, "dev-code", 5, policy).await.unwrap(),
            SfDevicePoll::Pending { interval_secs: 5 }
        ));
        assert!(matches!(
            device_poll_policy(&p, "dev-code", 5, policy).await.unwrap(),
            SfDevicePoll::Pending { interval_secs: 10 }
        ));
        match device_poll_policy(&p, "dev-code", 5, policy).await.unwrap() {
            SfDevicePoll::Denied { reason } => assert_eq!(reason.as_deref(), Some("user said no")),
            other => panic!("expected denied, got {other:?}"),
        }
        assert!(matches!(device_poll_policy(&p, "dev-code", 5, policy).await.unwrap(), SfDevicePoll::Expired));
        match device_poll_policy(&p, "dev-code", 5, policy).await.unwrap() {
            SfDevicePoll::Success { token } => {
                assert_eq!(token.access_token, "device-token");
                assert_eq!(token.refresh_token.as_deref(), Some("device-refresh"));
            }
            other => panic!("expected success, got {other:?}"),
        }
        server.abort();
        // device grant uses Salesforce's own grant_type string on both calls
        let recorded = requests.lock().unwrap();
        assert!(recorded[0].contains("grant_type=device_code"));
        assert!(recorded[1].contains("code=dev-code"));
    }

    #[tokio::test]
    async fn refresh_returns_tokens_and_detects_rotation() {
        let (base, requests, server) = start_mock_oauth_server(vec![
            // unchanged refresh token + trailing-slash instance url
            r#"{"access_token":"fresh","refresh_token":"old-refresh","instance_url":"https://acme.my.salesforce.com/"}"#.to_string(),
            // rotated refresh token, no instance url
            r#"{"access_token":"fresh2","refresh_token":"rotated"}"#.to_string(),
        ])
        .await;
        let p = params(&base);
        let policy = EndpointPolicy::AllowLoopbackHttp;

        let first = refresh_access_token_policy(&p, "old-refresh", policy).await.unwrap();
        assert_eq!(first.access_token, "fresh");
        assert_eq!(first.refresh_token, None, "unchanged refresh token must not be reported as rotated");
        assert_eq!(first.instance_url.as_deref(), Some("https://acme.my.salesforce.com"));

        let second = refresh_access_token_policy(&p, "old-refresh", policy).await.unwrap();
        assert_eq!(second.access_token, "fresh2");
        assert_eq!(second.refresh_token.as_deref(), Some("rotated"));
        assert_eq!(second.instance_url, None);

        server.abort();
        // Copy the recorded body out so the MutexGuard drops before the next await.
        let first_request = requests.lock().unwrap()[0].clone();
        assert!(first_request.contains("grant_type=refresh_token"));
        assert!(first_request.contains("refresh_token=old-refresh"));

        assert!(refresh_access_token_policy(&p, "  ", policy).await.unwrap_err().contains("refresh token is empty"));
    }

    #[tokio::test]
    async fn oauth_protocol_errors_surface_description() {
        let (base, _requests, server) = start_mock_oauth_server(vec![
            r#"{"error":"invalid_grant","error_description":"expired access/refresh user"}"#.to_string(),
        ])
        .await;
        let err = refresh_access_token_policy(&params(&base), "whatever", EndpointPolicy::AllowLoopbackHttp)
            .await
            .unwrap_err();
        server.abort();
        assert!(err.contains("invalid_grant"), "{err}");
        assert!(err.contains("expired access/refresh user"), "{err}");
    }

    #[test]
    fn external_config_auth_round_trips_into_params() {
        let config = serde_json::json!({
            "apiVersion": "v62.0",
            "auth": {
                "environment": "sandbox",
                "clientId": "3MVG9xxx",
                "clientSecret": "secret",
                "refreshToken": "refresh-abc"
            }
        });
        let (params, method) = oauth_params_from_external_config(Some(&config)).unwrap();
        assert_eq!(method, SfRefreshMethod::RefreshToken("refresh-abc".to_string()));
        assert_eq!(params.environment, SfLoginEnvironment::Sandbox);
        assert_eq!(params.client_id, "3MVG9xxx");
        assert_eq!(params.client_secret.as_deref(), Some("secret"));
        // missing refresh token => no oauth context (manual token connection)
        let manual = serde_json::json!({ "auth": { "clientId": "x" } });
        assert!(oauth_params_from_external_config(Some(&manual)).is_none());
        assert!(oauth_params_from_external_config(None).is_none());
        // custom environment keeps loginUrl
        let custom = serde_json::json!({
            "auth": { "environment": "custom", "loginUrl": "https://acme.my.salesforce.com", "clientId": "c", "refreshToken": "r" }
        });
        let (params, _) = oauth_params_from_external_config(Some(&custom)).unwrap();
        assert_eq!(params.environment, SfLoginEnvironment::Custom);
        assert_eq!(params.login_url.as_deref(), Some("https://acme.my.salesforce.com"));
    }

    #[test]
    fn external_config_auth_parses_password_mode() {
        let config = serde_json::json!({
            "auth": {
                "mode": "password",
                "environment": "sandbox",
                "clientId": "3MVG9xxx",
                "clientSecret": "secret",
                "username": "user@example.com.qas1",
                "password": "pw+securitytoken"
            }
        });
        let (params, method) = oauth_params_from_external_config(Some(&config)).unwrap();
        assert_eq!(params.environment, SfLoginEnvironment::Sandbox);
        assert_eq!(
            method,
            SfRefreshMethod::Password { username: "user@example.com.qas1".into(), password: "pw+securitytoken".into() }
        );
        // password mode without stored password (scrubbed, not yet hydrated) => no context
        let missing_pw = serde_json::json!({
            "auth": { "mode": "password", "clientId": "c", "username": "u" }
        });
        assert!(oauth_params_from_external_config(Some(&missing_pw)).is_none());
        // explicit mode:password wins over a leftover refreshToken
        let hybrid = serde_json::json!({
            "auth": { "mode": "password", "clientId": "c", "username": "u", "password": "p", "refreshToken": "r" }
        });
        let (_, method) = oauth_params_from_external_config(Some(&hybrid)).unwrap();
        assert!(matches!(method, SfRefreshMethod::Password { .. }));
    }

    #[tokio::test]
    async fn password_grant_posts_ropc_form_and_returns_tokens() {
        let (base, requests, server) = start_mock_oauth_server(vec![
            r#"{"access_token":"ropc-token","instance_url":"https://acme--qas1.sandbox.my.salesforce.com/","id":"https://test.salesforce.com/id/00D/005"}"#.to_string(),
        ])
        .await;
        let mut p = params(&base);
        p.client_secret = Some("app-secret".to_string());
        let tokens =
            password_grant_token_policy(&p, "user@example.com.qas1", "pw+token", EndpointPolicy::AllowLoopbackHttp)
                .await
                .unwrap();
        server.abort();
        assert_eq!(tokens.access_token, "ropc-token");
        assert_eq!(tokens.refresh_token, None, "ROPC issues no refresh token");
        assert_eq!(tokens.instance_url, "https://acme--qas1.sandbox.my.salesforce.com");
        // Copy the recorded body out so the MutexGuard drops before the next await.
        let first_request = requests.lock().unwrap()[0].clone();
        assert!(first_request.contains("grant_type=password"));
        assert!(first_request.contains("client_secret=app-secret"));
        assert!(first_request.contains("format=json"));
        // password is form-encoded, '+' must not leak as a space separator
        assert!(first_request.contains("pw%2Btoken"), "{first_request}");

        assert!(password_grant_token_policy(&p, "", "x", EndpointPolicy::AllowLoopbackHttp)
            .await
            .unwrap_err()
            .contains("username and password are required"));
    }

    #[tokio::test]
    async fn password_grant_invalid_grant_error_lists_common_causes() {
        let (base, _requests, server) = start_mock_oauth_server(vec![
            r#"{"error":"invalid_grant","description":"authentication failure"}"#.to_string(),
        ])
        .await;
        let err =
            password_grant_token_policy(&params(&base), "u", "p", EndpointPolicy::AllowLoopbackHttp).await.unwrap_err();
        server.abort();
        assert!(err.contains("invalid_grant"), "{err}");
        assert!(err.contains("security token"), "{err}");
        assert!(err.contains("MFA"), "{err}");
    }
}
