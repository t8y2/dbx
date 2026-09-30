use std::{
    collections::{HashMap, HashSet},
    net::Ipv6Addr,
    sync::{Arc, Mutex, RwLock, Weak},
    time::{Duration, Instant},
};

use crate::oauth::{OAuthError, OAuthVerifier};
use axum::{
    extract::{Request, State},
    http::{header, HeaderValue, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
};
use futures::StreamExt;
use rmcp::transport::streamable_http_server::session::{local::LocalSessionManager, SessionManager};
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use url::Url;

const MAX_BODY: usize = 1024 * 1024;
const SESSION_TTL: Duration = Duration::from_secs(15 * 60);

struct SessionBinding {
    principal: String,
    created: Instant,
    _slot: OwnedSemaphorePermit,
    invalidated: bool,
    cancellation: tokio_util::sync::CancellationToken,
}

impl Drop for SessionBinding {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

/// Authentication and browser-origin policy for the Streamable HTTP endpoint.
/// The token is intentionally not `Debug` and is never exposed by diagnostics.
#[derive(Clone)]
pub struct HttpAuth {
    config: Arc<RwLock<HttpAuthConfig>>,
    sessions: Arc<Mutex<HashMap<String, SessionBinding>>>,
    slots: Arc<Semaphore>,
    requests: Arc<Semaphore>,
    controls: Arc<Semaphore>,
    uploads: Arc<Semaphore>,
    initialize: Arc<tokio::sync::Mutex<()>>,
    manager: Arc<RwLock<Weak<LocalSessionManager>>>,
}

#[derive(Clone)]
struct HttpAuthConfig {
    token: Option<Arc<[u8]>>,
    oauth: Option<OAuthVerifier>,
    allowed_hosts: Vec<HostRule>,
    allowed_origins: HashSet<String>,
    allow_loopback_origins: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct HostRule {
    host: String,
    port: Option<u16>,
}

impl HttpAuth {
    pub fn new(
        token: String,
        allowed_origins: impl IntoIterator<Item = String>,
        allow_loopback_origins: bool,
    ) -> Result<Self, String> {
        Self::new_with_hosts(Some(token), Vec::<String>::new(), allowed_origins, allow_loopback_origins)
    }

    pub fn new_with_hosts(
        token: Option<String>,
        allowed_hosts: impl IntoIterator<Item = String>,
        allowed_origins: impl IntoIterator<Item = String>,
        allow_loopback_origins: bool,
    ) -> Result<Self, String> {
        let config = HttpAuthConfig {
            token: validate_token(token)?.map(|token| Arc::from(token.into_bytes())),
            oauth: None,
            allowed_hosts: normalize_hosts(allowed_hosts)?,
            allowed_origins: normalize_origins(allowed_origins)?,
            allow_loopback_origins,
        };
        Ok(Self {
            config: Arc::new(RwLock::new(config)),
            sessions: Default::default(),
            slots: Arc::new(Semaphore::new(64)),
            requests: Arc::new(Semaphore::new(32)),
            controls: Arc::new(Semaphore::new(8)),
            uploads: Arc::new(Semaphore::new(40)),
            initialize: Default::default(),
            manager: Default::default(),
        })
    }

    pub fn new_oauth(
        oauth: OAuthVerifier,
        allowed_hosts: Vec<String>,
        allowed_origins: Vec<String>,
    ) -> Result<Self, String> {
        let auth = Self::new_with_hosts(None, allowed_hosts, allowed_origins, false)?;
        auth.config.write().unwrap_or_else(|e| e.into_inner()).oauth = Some(oauth);
        Ok(auth)
    }

    pub fn oauth(&self) -> Option<OAuthVerifier> {
        self.config.read().unwrap_or_else(|e| e.into_inner()).oauth.clone()
    }

    /// Replaces the live bearer token and request-origin/host policy. The
    /// shared lock lets embedded Web MCP rotate credentials without rebuilding
    /// the Axum router or dropping existing application state.
    pub fn reconfigure(
        &self,
        token: Option<String>,
        allowed_hosts: impl IntoIterator<Item = String>,
        allowed_origins: impl IntoIterator<Item = String>,
    ) -> Result<(), String> {
        let next = HttpAuthConfig {
            token: validate_token(token)?.map(|token| Arc::from(token.into_bytes())),
            oauth: None,
            allowed_hosts: normalize_hosts(allowed_hosts)?,
            allowed_origins: normalize_origins(allowed_origins)?,
            allow_loopback_origins: self
                .config
                .read()
                .unwrap_or_else(|error| error.into_inner())
                .allow_loopback_origins,
        };
        *self.config.write().unwrap_or_else(|error| error.into_inner()) = next;
        for binding in self.sessions.lock().unwrap_or_else(|e| e.into_inner()).values_mut() {
            binding.invalidated = true;
            binding.cancellation.cancel();
        }
        Ok(())
    }

    pub(crate) fn attach_manager(&self, manager: &Arc<LocalSessionManager>) {
        *self.manager.write().unwrap_or_else(|e| e.into_inner()) = Arc::downgrade(manager);
    }

    pub(crate) async fn reap_sessions(&self, manager: &Arc<LocalSessionManager>) {
        let _initialization = self.initialize.lock().await;
        self.reap_sessions_locked(manager).await;
    }

    async fn reap_sessions_locked(&self, manager: &Arc<LocalSessionManager>) {
        let live: HashSet<String> = manager.sessions.read().await.keys().map(ToString::to_string).collect();
        let close = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            // SDK idle/DELETE/shutdown cleanup also releases ownership slots.
            sessions.retain(|id, _| live.contains(id));
            live.iter()
                .filter(|id| {
                    sessions
                        .get(*id)
                        .is_none_or(|binding| binding.invalidated || binding.created.elapsed() >= SESSION_TTL)
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        // Unowned sessions include initialize responses whose caller vanished
        // before registration. Initialization and this scan share one lock.
        for id in close {
            let _ = tokio::time::timeout(Duration::from_secs(10), manager.close_session(&id.clone().into())).await;
            self.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        }
    }

    #[cfg(test)]
    pub(crate) fn expire_session_for_test(&self, id: &str) {
        self.sessions.lock().unwrap().get_mut(id).unwrap().created = Instant::now() - SESSION_TTL;
    }

    pub fn set_allowed_hosts(&self, allowed_hosts: impl IntoIterator<Item = String>) -> Result<(), String> {
        let allowed_hosts = normalize_hosts(allowed_hosts)?;
        self.config.write().unwrap_or_else(|error| error.into_inner()).allowed_hosts = allowed_hosts;
        Ok(())
    }

    pub fn enabled(&self) -> bool {
        let config = self.config.read().unwrap_or_else(|error| error.into_inner());
        config.token.is_some() || config.oauth.is_some()
    }

    #[cfg(test)]
    fn token_matches(&self, candidate: &str) -> bool {
        let config = self.config.read().unwrap_or_else(|error| error.into_inner());
        token_matches(&config, candidate)
    }

    pub fn origin_is_allowed(&self, origin: &str) -> bool {
        let config = self.config.read().unwrap_or_else(|error| error.into_inner());
        origin_is_allowed(&config, origin)
    }

    #[cfg(test)]
    fn host_is_allowed(&self, uri: &Uri, headers: &axum::http::HeaderMap) -> bool {
        let config = self.config.read().unwrap_or_else(|error| error.into_inner());
        host_is_allowed(&config, uri, headers)
    }
}

fn token_matches(config: &HttpAuthConfig, candidate: &str) -> bool {
    let Some(token) = config.token.as_ref() else {
        return false;
    };
    let candidate = candidate.as_bytes();
    if candidate.len() != token.len() {
        return false;
    }

    // Keep comparison work independent of the first mismatching byte.
    let difference =
        token.iter().zip(candidate).fold(0_u8, |difference, (expected, actual)| difference | (expected ^ actual));
    difference == 0
}

fn origin_is_allowed(config: &HttpAuthConfig, origin: &str) -> bool {
    let Ok(origin) = normalize_origin(origin) else {
        return false;
    };
    config.allowed_origins.contains(&origin) || (config.allow_loopback_origins && origin_is_loopback(&origin))
}

fn host_is_allowed(config: &HttpAuthConfig, uri: &Uri, headers: &axum::http::HeaderMap) -> bool {
    let authority = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .or_else(|| uri.authority().map(|authority| authority.as_str()));
    let Some(authority) = authority.and_then(|value| parse_host_rule(value).ok()) else {
        return false;
    };
    config.allowed_hosts.is_empty()
        || config.allowed_hosts.iter().any(|allowed| {
            allowed.host == authority.host && allowed.port.is_none_or(|port| authority.port == Some(port))
        })
}

pub async fn authorize_request(State(auth): State<HttpAuth>, mut request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let (principal, deadline) = {
        let config = auth.config.read().unwrap_or_else(|error| error.into_inner());
        if config.token.is_none() && config.oauth.is_none() {
            return not_found();
        }
        for name in [header::ORIGIN, header::HOST, header::AUTHORIZATION] {
            if request.headers().get_all(name).iter().count() > 1 {
                return forbidden();
            }
        }
        if let Some(origin) = request.headers().get(header::ORIGIN) {
            if !origin.to_str().is_ok_and(|origin| origin_is_allowed(&config, origin)) {
                return forbidden();
            }
        }
        if !host_is_allowed(&config, request.uri(), request.headers()) {
            return forbidden();
        }
        let Some(token) = bearer_token(request.headers().get(header::AUTHORIZATION)) else {
            return unauthorized(config.oauth.as_ref());
        };
        match &config.oauth {
            Some(oauth) => match oauth.verify(token) {
                Ok(principal) => {
                    let Some(remaining) = std::time::UNIX_EPOCH
                        .checked_add(Duration::from_secs(principal.expires_at))
                        .and_then(|expiration| expiration.duration_since(std::time::SystemTime::now()).ok())
                    else {
                        return unauthorized(Some(oauth));
                    };
                    (
                        format!("oauth:{}", principal.subject),
                        tokio::time::Instant::now() + remaining.min(Duration::from_secs(300)),
                    )
                }
                Err(OAuthError::InvalidToken) => return unauthorized(Some(oauth)),
                Err(OAuthError::Forbidden) => return forbidden(),
                Err(OAuthError::InsufficientScope) => {
                    let mut response = forbidden();
                    let challenge = format!("{}, error=\"insufficient_scope\"", oauth.challenge());
                    if let Ok(value) = HeaderValue::from_str(&challenge) {
                        response.headers_mut().insert(header::WWW_AUTHENTICATE, value);
                    }
                    return response;
                }
            },
            None if token_matches(&config, token) => (
                format!("bearer:{:x}", Sha256::digest(token.as_bytes())),
                tokio::time::Instant::now() + Duration::from_secs(300),
            ),
            None => return unauthorized(None),
        }
    };

    // A session ID is routing state, never an authentication credential.
    // Revalidate the bearer and bind the session to its authenticated owner on
    // EVERY POST, GET, and DELETE, including SSE reconnects.
    if request.headers().get_all("mcp-session-id").iter().count() > 1 {
        return forbidden();
    }
    let session_id = match request.headers().get("mcp-session-id") {
        Some(value) => match value.to_str() {
            Ok(value) if !value.is_empty() && value.len() <= 256 => Some(value.to_owned()),
            _ => return forbidden(),
        },
        None => None,
    };
    // Bound body-reader concurrency independently from response streams so
    // cancellation notifications can still be read when all streams are busy.
    let mut control = method == axum::http::Method::DELETE;
    if method == axum::http::Method::POST {
        let _upload = match auth.uploads.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => return (StatusCode::TOO_MANY_REQUESTS, "MCP upload limit reached").into_response(),
        };
        let (parts, body) = request.into_parts();
        let body_deadline = deadline.min(tokio::time::Instant::now() + Duration::from_secs(5));
        let bytes = match tokio::time::timeout_at(body_deadline, axum::body::to_bytes(body, MAX_BODY)).await {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(_)) => return (StatusCode::PAYLOAD_TOO_LARGE, "MCP body limit exceeded").into_response(),
            Err(_) => return (StatusCode::REQUEST_TIMEOUT, "MCP body read timed out").into_response(),
        };
        control = serde_json::from_slice::<serde_json::Value>(&bytes).is_ok_and(|body| {
            body.get("method").and_then(|m| m.as_str()) == Some("notifications/cancelled") && body.get("id").is_none()
        });
        request = Request::from_parts(parts, axum::body::Body::from(bytes));
    }
    let semaphore = if control { &auth.controls } else { &auth.requests };
    let request_permit = match semaphore.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return (StatusCode::TOO_MANY_REQUESTS, "MCP request limit reached").into_response(),
    };
    // Never forward a bearer secret into SDK request Parts/handler extensions.
    request.headers_mut().remove(header::AUTHORIZATION);
    let request_permit = Arc::new(request_permit);
    let _initialization = if session_id.is_none() {
        match tokio::time::timeout_at(deadline, auth.initialize.lock()).await {
            Ok(guard) => Some(guard),
            Err(_) => return (StatusCode::REQUEST_TIMEOUT, "MCP initialization timed out").into_response(),
        }
    } else {
        None
    };
    if _initialization.is_some() {
        let manager = auth.manager.read().unwrap_or_else(|e| e.into_inner()).upgrade();
        if let Some(manager) = manager {
            auth.reap_sessions_locked(&manager).await;
        }
    }
    let (slot, session_cancellation, session_remaining) = {
        let sessions = auth.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(id) = &session_id {
            match sessions.get(id) {
                Some(binding) if binding.principal != principal => return forbidden(),
                Some(binding) if !binding.invalidated && binding.created.elapsed() < SESSION_TTL => {
                    (None, binding.cancellation.clone(), SESSION_TTL.saturating_sub(binding.created.elapsed()))
                }
                _ => return not_found(),
            }
        } else {
            match auth.slots.clone().try_acquire_owned() {
                Ok(slot) => (Some(slot), tokio_util::sync::CancellationToken::new(), SESSION_TTL),
                Err(_) => return (StatusCode::TOO_MANY_REQUESTS, "MCP session limit reached").into_response(),
            }
        }
    };
    let deadline = deadline.min(tokio::time::Instant::now() + session_remaining);
    request.extensions_mut().insert(HttpRequestDeadline {
        deadline,
        _permit: request_permit.clone(),
        session_cancellation: session_cancellation.clone(),
    });
    if deadline <= tokio::time::Instant::now() || session_cancellation.is_cancelled() {
        return (StatusCode::REQUEST_TIMEOUT, "MCP authenticated request expired").into_response();
    }
    let response = match tokio::time::timeout_at(deadline, next.run(request)).await {
        Ok(response) => response,
        Err(_) => return (StatusCode::REQUEST_TIMEOUT, "MCP request deadline exceeded").into_response(),
    };
    if response.status().is_success() {
        let mut sessions = auth.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if method == axum::http::Method::DELETE {
            if let Some(id) = session_id {
                sessions.remove(&id);
            }
        } else if let (Some(slot), Some(id)) = (slot, response.headers().get("mcp-session-id")) {
            if let Ok(id) = id.to_str() {
                sessions.insert(
                    id.to_owned(),
                    SessionBinding {
                        principal,
                        created: Instant::now(),
                        _slot: slot,
                        invalidated: false,
                        cancellation: session_cancellation.clone(),
                    },
                );
            }
        }
    }
    // Never log Authorization, raw URLs, bodies, subjects, or database secrets.
    log::info!(target: "dbx_mcp::audit", "MCP HTTP authenticated: method={method} status={}", response.status());
    let (parts, body) = response.into_parts();
    // The owned permit lives through the response stream, not just header
    // production. Deadline also bounds SSE connections after token expiry.
    let stream = futures::stream::unfold((body.into_data_stream(), request_permit), move |(mut stream, permit)| {
        let cancellation = session_cancellation.clone();
        async move {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => None,
                _ = tokio::time::sleep_until(deadline) => None,
                item = stream.next() => item.map(|item| (item, (stream, permit))),
            }
        }
    });
    Response::from_parts(parts, axum::body::Body::from_stream(stream))
}

#[derive(Clone)]
pub(crate) struct HttpRequestDeadline {
    pub deadline: tokio::time::Instant,
    pub _permit: Arc<OwnedSemaphorePermit>,
    pub session_cancellation: tokio_util::sync::CancellationToken,
}

fn bearer_token(value: Option<&HeaderValue>) -> Option<&str> {
    let value = value?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() && !token.contains(char::is_whitespace))
        .then_some(token)
}

fn normalize_origin(origin: &str) -> Result<String, String> {
    let url = Url::parse(origin).map_err(|_| format!("invalid allowed origin: {origin}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!("allowed origin must be an HTTP(S) origin without a path: {origin}"));
    }
    Ok(url.origin().ascii_serialization())
}

fn origin_is_loopback(origin: &str) -> bool {
    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    match url.host_str() {
        Some("localhost") => true,
        Some(host) => host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()),
        None => false,
    }
}

fn unauthorized(oauth: Option<&OAuthVerifier>) -> Response {
    let mut response = (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    let challenge = oauth.map_or("Bearer", OAuthVerifier::challenge);
    if let Ok(value) = HeaderValue::from_str(challenge) {
        response.headers_mut().insert(header::WWW_AUTHENTICATE, value);
    }
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, "Forbidden").into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "Not Found").into_response()
}

fn validate_token(token: Option<String>) -> Result<Option<String>, String> {
    token
        .map(|token| {
            let token = token.trim().to_string();
            if token.is_empty() || token.contains(char::is_whitespace) {
                return Err("MCP HTTP bearer token must be non-empty and contain no whitespace".into());
            }
            Ok(token)
        })
        .transpose()
}

fn normalize_origins(origins: impl IntoIterator<Item = String>) -> Result<HashSet<String>, String> {
    origins.into_iter().map(|origin| normalize_origin(&origin)).collect()
}

fn normalize_hosts(hosts: impl IntoIterator<Item = String>) -> Result<Vec<HostRule>, String> {
    hosts.into_iter().map(|host| parse_host_rule(&host)).collect()
}

fn parse_host_rule(value: &str) -> Result<HostRule, String> {
    let value = value.trim();
    // `Authority` requires IPv6 literals to use URI brackets (`[::1]`), while
    // the loopback defaults and settings UI naturally expose the bare form
    // (`::1`). Normalize that form before parsing so loopback HTTP services do
    // not fail immediately during startup.
    let normalized = if value.parse::<Ipv6Addr>().is_ok() { format!("[{value}]") } else { value.to_string() };
    let authority = axum::http::uri::Authority::try_from(normalized.as_str())
        .map_err(|_| format!("invalid allowed host: {value}"))?;
    if value.contains('@') {
        return Err(format!("invalid allowed host: {value}"));
    }
    let host = authority.host().to_ascii_lowercase();
    if host.is_empty() {
        return Err(format!("invalid allowed host: {value}"));
    }
    Ok(HostRule { host, port: authority.port_u16() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_rotation_rejects_old_token_and_updates_hosts_and_origins() {
        let auth = HttpAuth::new_with_hosts(
            Some("old-token".to_string()),
            ["dbx.example.test:4224".to_string()],
            ["https://client.example.test".to_string()],
            false,
        )
        .unwrap();
        let route_auth = auth.clone();
        let uri: Uri = "/mcp".parse().unwrap();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("dbx.example.test:4224"));
        assert!(route_auth.token_matches("old-token"));
        assert!(route_auth.host_is_allowed(&uri, &headers));
        assert!(route_auth.origin_is_allowed("https://client.example.test"));

        auth.reconfigure(
            Some("new-token".to_string()),
            ["new.example.test:443".to_string()],
            ["https://new-client.example.test".to_string()],
        )
        .unwrap();
        assert!(!route_auth.token_matches("old-token"));
        assert!(route_auth.token_matches("new-token"));
        assert!(!route_auth.host_is_allowed(&uri, &headers));
        assert!(!route_auth.origin_is_allowed("https://client.example.test"));

        auth.reconfigure(None, Vec::<String>::new(), Vec::<String>::new()).unwrap();
        assert!(!route_auth.enabled());
        assert!(!route_auth.token_matches("new-token"));
    }

    #[test]
    fn host_validation_requires_exact_port_when_configured() {
        let auth = HttpAuth::new_with_hosts(
            Some("token".to_string()),
            ["192.168.0.77:4224".to_string()],
            Vec::<String>::new(),
            false,
        )
        .unwrap();
        let uri: Uri = "/mcp".parse().unwrap();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("192.168.0.77:4224"));
        assert!(auth.host_is_allowed(&uri, &headers));
        headers.insert(header::HOST, HeaderValue::from_static("192.168.0.77:5225"));
        assert!(!auth.host_is_allowed(&uri, &headers));
        assert!(parse_host_rule("https://dbx.example.test").is_err());
        assert!(parse_host_rule("user@dbx.example.test:4224").is_err());
        assert!(parse_host_rule("[::1]").is_ok());
    }

    #[test]
    fn bare_ipv6_loopback_host_is_normalized_for_uri_authority_parsing() {
        let auth = HttpAuth::new_with_hosts(Some("token".to_string()), ["::1".to_string()], Vec::<String>::new(), true)
            .unwrap();
        let uri: Uri = "/mcp".parse().unwrap();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("[::1]"));
        assert!(auth.host_is_allowed(&uri, &headers));
    }
    #[tokio::test]
    async fn stream_permits_are_held_and_cancellation_has_reserved_capacity() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let auth = HttpAuth::new_with_hosts(Some("synthetic-token".into()), [address.to_string()], [], false).unwrap();
        let route = axum::Router::new()
            .route(
                "/mcp",
                axum::routing::any(|request: Request| async move {
                    assert!(
                        request.headers().get(header::AUTHORIZATION).is_none(),
                        "bearer must not reach handler Parts"
                    );
                    assert!(request.extensions().get::<HttpRequestDeadline>().is_some());
                    if request.method() == axum::http::Method::GET {
                        let stream = futures::stream::once(async {
                            Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"data: test\n\n"))
                        })
                        .chain(futures::stream::pending());
                        return Response::new(axum::body::Body::from_stream(stream));
                    }
                    let mut response = Response::new(axum::body::Body::empty());
                    response.headers_mut().insert("mcp-session-id", HeaderValue::from_static("synthetic-session"));
                    response
                }),
            )
            .layer(axum::middleware::from_fn_with_state(auth.clone(), authorize_request));
        let stop = tokio_util::sync::CancellationToken::new();
        let shutdown = stop.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, route)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await
                .unwrap();
        });
        let url = format!("http://{address}/mcp");
        let client = reqwest::Client::new();
        client.post(&url).bearer_auth("synthetic-token").body("{}").send().await.unwrap().bytes().await.unwrap();
        let mut streams = Vec::new();
        for _ in 0..32 {
            let response = client
                .get(&url)
                .bearer_auth("synthetic-token")
                .header("mcp-session-id", "synthetic-session")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            streams.push(response);
        }
        assert_eq!(auth.requests.available_permits(), 0);
        assert_eq!(
            client
                .get(&url)
                .bearer_auth("synthetic-token")
                .header("mcp-session-id", "synthetic-session")
                .send()
                .await
                .unwrap()
                .status(),
            429
        );
        assert_eq!(
            client
                .post(&url)
                .bearer_auth("synthetic-token")
                .header("mcp-session-id", "synthetic-session")
                .body(r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}"#)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        assert_eq!(
            client
                .delete(&url)
                .bearer_auth("synthetic-token")
                .header("mcp-session-id", "synthetic-session")
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        drop(streams);
        tokio::time::timeout(Duration::from_secs(2), async {
            while auth.requests.available_permits() < 32 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropped streams must release all request permits");
        stop.cancel();
        task.await.unwrap();
    }
}
