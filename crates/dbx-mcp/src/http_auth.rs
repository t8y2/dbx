use std::{
    collections::HashSet,
    net::Ipv6Addr,
    sync::{Arc, RwLock},
    time::Duration,
};

use crate::oauth::{OAuthError, OAuthVerifier};
use axum::{
    extract::{Request, State},
    http::{header, HeaderValue, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
};
use futures::StreamExt;
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use url::Url;

const MAX_BODY: usize = 1024 * 1024;

/// Authentication and browser-origin policy for the Streamable HTTP endpoint.
/// The token is intentionally not `Debug` and is never exposed by diagnostics.
#[derive(Clone)]
pub struct HttpAuth {
    config: Arc<RwLock<HttpAuthConfig>>,
    requests: Arc<Semaphore>,
    controls: Arc<Semaphore>,
    uploads: Arc<Semaphore>,
}

#[derive(Clone)]
struct HttpAuthConfig {
    // Captured under the same lock as authentication, so policy rotation also
    // revokes requests still reading bodies, dispatching, or streaming replies.
    generation: CancellationToken,
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
            generation: CancellationToken::new(),
            token: validate_token(token)?.map(|token| Arc::from(token.into_bytes())),
            oauth: None,
            allowed_hosts: normalize_hosts(allowed_hosts)?,
            allowed_origins: normalize_origins(allowed_origins)?,
            allow_loopback_origins,
        };
        Ok(Self {
            config: Arc::new(RwLock::new(config)),
            requests: Arc::new(Semaphore::new(32)),
            controls: Arc::new(Semaphore::new(8)),
            uploads: Arc::new(Semaphore::new(40)),
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
            generation: CancellationToken::new(),
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
        let mut config = self.config.write().unwrap_or_else(|error| error.into_inner());
        // Replacement and revocation share the policy lock. A request cannot
        // authenticate against the old policy and then capture the new token.
        config.generation.cancel();
        *config = next;
        Ok(())
    }

    pub fn set_allowed_hosts(&self, allowed_hosts: impl IntoIterator<Item = String>) -> Result<(), String> {
        let allowed_hosts = normalize_hosts(allowed_hosts)?;
        let mut config = self.config.write().unwrap_or_else(|error| error.into_inner());
        if config.allowed_hosts != allowed_hosts {
            config.generation.cancel();
            config.generation = CancellationToken::new();
            config.allowed_hosts = allowed_hosts;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn available_request_permits_for_test(&self) -> usize {
        self.requests.available_permits()
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
    let (principal, deadline, policy_cancellation) = {
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
        let (principal, deadline) = match &config.oauth {
            Some(oauth) => match oauth.verify(token) {
                Ok(principal) => {
                    let Some(remaining) = std::time::UNIX_EPOCH
                        .checked_add(Duration::from_secs(principal.expires_at))
                        .and_then(|expiration| expiration.duration_since(std::time::SystemTime::now()).ok())
                    else {
                        return unauthorized(Some(oauth));
                    };
                    (
                        format!(
                            "oauth:{:x}",
                            Sha256::digest(
                                serde_json::to_vec(&(principal.issuer, principal.subject))
                                    .expect("string tuple serializes")
                            )
                        ),
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
        };
        (principal, deadline, config.generation.clone())
    };

    // Obsolete transport IDs are never credentials or DBX handle selectors.
    // Accept well-formed IDs for reconnecting clients, then remove the header
    // before rmcp routing. Ambiguous or malformed headers still fail closed.
    if request.headers().get_all("mcp-session-id").iter().count() > 1 {
        return forbidden();
    }
    if let Some(value) = request.headers().get("mcp-session-id") {
        if !value.to_str().is_ok_and(|value| {
            !value.is_empty() && value.len() <= 256 && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        }) {
            return forbidden();
        }
    }
    request.headers_mut().remove("mcp-session-id");
    if method != axum::http::Method::POST {
        return (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response();
    }
    // Bound body-reader concurrency independently from response streams so
    // cancellation notifications can still be read when all streams are busy.
    let control = {
        let _upload = match auth.uploads.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => return capacity_exceeded("uploads", 40, "MCP upload limit reached"),
        };
        let (parts, body) = request.into_parts();
        let body_deadline = deadline.min(tokio::time::Instant::now() + Duration::from_secs(5));
        let bytes = tokio::select! {
            biased;
            _ = policy_cancellation.cancelled() => return (StatusCode::REQUEST_TIMEOUT, "MCP policy changed").into_response(),
            result = tokio::time::timeout_at(body_deadline, axum::body::to_bytes(body, MAX_BODY)) => match result {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(_)) => return (StatusCode::PAYLOAD_TOO_LARGE, "MCP body limit exceeded").into_response(),
                Err(_) => return (StatusCode::REQUEST_TIMEOUT, "MCP body read timed out").into_response(),
            },
        };
        let control = serde_json::from_slice::<serde_json::Value>(&bytes).is_ok_and(|body| {
            body.get("method").and_then(|m| m.as_str()) == Some("notifications/cancelled") && body.get("id").is_none()
        });
        request = Request::from_parts(parts, axum::body::Body::from(bytes));
        control
    };
    // Cancellation notifications retain a reserved receive budget even when
    // POST operations are busy. The stateless SDK acknowledges these without
    // routing them to other POSTs; actual request cancellation is driven by its
    // disconnect, deadline, policy generation, or shutdown. Each operation keeps
    // its permit through the handler and response, including POST SSE replies.
    let (semaphore, budget, limit, message) = if control {
        (&auth.controls, "controls", 8, "MCP request limit reached")
    } else {
        (&auth.requests, "requests", 32, "MCP request limit reached")
    };
    let request_permit = match semaphore.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return capacity_exceeded(budget, limit, message),
    };
    // Never forward a bearer secret into SDK request Parts/handler extensions.
    request.headers_mut().remove(header::AUTHORIZATION);
    let request_permit = Arc::new(request_permit);
    request.extensions_mut().insert(HttpRequestDeadline {
        principal: principal.clone(),
        deadline,
        _permit: request_permit.clone(),
        policy_cancellation: policy_cancellation.clone(),
    });
    if deadline <= tokio::time::Instant::now() || policy_cancellation.is_cancelled() {
        return (StatusCode::REQUEST_TIMEOUT, "MCP authenticated request expired").into_response();
    }
    let response = tokio::select! {
        biased;
        _ = policy_cancellation.cancelled() => return (StatusCode::REQUEST_TIMEOUT, "MCP policy changed").into_response(),
        result = tokio::time::timeout_at(deadline, next.run(request)) => match result {
            Ok(response) => response,
            Err(_) => return (StatusCode::REQUEST_TIMEOUT, "MCP request deadline exceeded").into_response(),
        },
    };
    // Never log Authorization, raw URLs, bodies, subjects, or database secrets.
    log::info!(target: "dbx_mcp::audit", "MCP HTTP authenticated: method={method} status={}", response.status());
    let (parts, body) = response.into_parts();
    // The owned permit lives through the response stream, not just header
    // production. Deadline also bounds SSE connections after token expiry.
    let stream = futures::stream::unfold((body.into_data_stream(), request_permit), move |(mut stream, permit)| {
        let cancellation = policy_cancellation.clone();
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
    pub principal: String,
    pub deadline: tokio::time::Instant,
    pub _permit: Arc<OwnedSemaphorePermit>,
    pub policy_cancellation: tokio_util::sync::CancellationToken,
}

fn capacity_exceeded(budget: &'static str, limit: usize, message: &'static str) -> Response {
    // Rejections happen before the normal response audit. Record only the
    // exhausted resource, never an owner, session ID, token, URL, or body.
    log::warn!(target: "dbx_mcp::audit", "MCP HTTP admission rejected: budget={budget} limit={limit} status=429");
    (StatusCode::TOO_MANY_REQUESTS, message).into_response()
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
    async fn auth_test_server(
        auth: HttpAuth,
    ) -> (String, Arc<std::sync::atomic::AtomicUsize>, tokio_util::sync::CancellationToken, tokio::task::JoinHandle<()>)
    {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        auth.set_allowed_hosts([address.to_string()]).unwrap();
        let running = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let route_running = running.clone();
        let route = axum::Router::new()
            .route(
                "/mcp",
                axum::routing::any(move |request: Request| {
                    let running = route_running.clone();
                    async move {
                        assert!(
                            request.headers().get(header::AUTHORIZATION).is_none(),
                            "bearer must not reach SDK Parts"
                        );
                        assert!(
                            request.headers().get("mcp-session-id").is_none(),
                            "legacy transport IDs must not reach SDK Parts"
                        );
                        assert!(request.extensions().get::<HttpRequestDeadline>().is_some());
                        if request.headers().contains_key("x-wait-dispatch") {
                            struct Running(Arc<std::sync::atomic::AtomicUsize>);
                            impl Drop for Running {
                                fn drop(&mut self) {
                                    self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                                }
                            }
                            running.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            let _running = Running(running);
                            futures::future::pending::<()>().await;
                        }
                        if request.headers().contains_key("x-hold-response") {
                            let stream = futures::stream::once(async {
                                Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"data: test\n\n"))
                            })
                            .chain(futures::stream::pending());
                            return Response::new(axum::body::Body::from_stream(stream));
                        }
                        Response::new(axum::body::Body::empty())
                    }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(auth, authorize_request));
        let stop = tokio_util::sync::CancellationToken::new();
        let shutdown = stop.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, route)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await
                .unwrap();
        });
        (format!("http://{address}/mcp"), running, stop, task)
    }

    fn synthetic_auth() -> HttpAuth {
        HttpAuth::new_with_hosts(Some("synthetic-token".into()), [], [], false).unwrap()
    }

    async fn wait_for(condition: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !condition() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("bounded resources must be released promptly");
    }

    async fn partial_body(url: &str) -> tokio::net::TcpStream {
        use tokio::io::AsyncWriteExt;
        let authority = url.strip_prefix("http://").unwrap().strip_suffix("/mcp").unwrap();
        let mut socket = tokio::net::TcpStream::connect(authority).await.unwrap();
        socket.write_all(format!("POST /mcp HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer synthetic-token\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{").as_bytes()).await.unwrap();
        socket
    }

    #[tokio::test]
    async fn post_response_and_control_budgets_are_independent_and_drop_releases_permits() {
        let auth = synthetic_auth();
        let (url, _running, stop, task) = auth_test_server(auth.clone()).await;
        let http = reqwest::Client::new();
        let mut responses = Vec::new();
        // No session handshake or shared initialize lock is necessary. A
        // well-formed obsolete transport ID is ignored and stripped downstream.
        for index in 0..32 {
            let mut request = http.post(&url).bearer_auth("synthetic-token").header("x-hold-response", "1");
            if index % 2 == 0 {
                request = request.header("mcp-session-id", "stale-legacy-session");
            }
            let response = request.body("{}").send().await.unwrap();
            assert_eq!(response.status(), 200);
            responses.push(response);
        }
        assert_eq!(auth.requests.available_permits(), 0);
        assert_eq!(http.post(&url).bearer_auth("synthetic-token").body("{}").send().await.unwrap().status(), 429);
        let cancelled = r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}"#;
        let mut controls = Vec::new();
        for _ in 0..8 {
            let response = http
                .post(&url)
                .bearer_auth("synthetic-token")
                .header("x-hold-response", "1")
                .body(cancelled)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            controls.push(response);
        }
        assert_eq!(auth.controls.available_permits(), 0);
        assert_eq!(http.post(&url).bearer_auth("synthetic-token").body(cancelled).send().await.unwrap().status(), 429);
        // Unsupported transport-management verbs consume neither scarce budget.
        for method in [reqwest::Method::GET, reqwest::Method::DELETE] {
            let response = http.request(method, &url).bearer_auth("synthetic-token").send().await.unwrap();
            assert_eq!(response.status(), 405);
            assert_eq!(response.headers()["allow"], "POST");
        }
        drop(responses.pop());
        wait_for(|| auth.requests.available_permits() == 1).await;
        assert_eq!(auth.controls.available_permits(), 0);
        let replacement = http
            .post(&url)
            .bearer_auth("synthetic-token")
            .header("x-hold-response", "1")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(replacement.status(), 200);
        responses.push(replacement);
        drop(controls.pop());
        wait_for(|| auth.controls.available_permits() == 1).await;
        assert_eq!(auth.requests.available_permits(), 0);
        drop((responses, controls));
        wait_for(|| auth.requests.available_permits() == 32 && auth.controls.available_permits() == 8).await;
        stop.cancel();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn policy_generation_revokes_pending_dispatch_body_and_response_without_transport_sessions() {
        use tokio::io::AsyncBufReadExt;
        let auth = synthetic_auth();
        let (url, running, stop, task) = auth_test_server(auth.clone()).await;
        let http = reqwest::Client::new();
        let response = http
            .post(&url)
            .bearer_auth("synthetic-token")
            .header("x-hold-response", "1")
            .body("{}")
            .send()
            .await
            .unwrap();
        let dispatch = tokio::spawn({
            let url = url.clone();
            let http = http.clone();
            async move {
                http.post(url)
                    .bearer_auth("synthetic-token")
                    .header("x-wait-dispatch", "1")
                    .body("{}")
                    .send()
                    .await
                    .unwrap()
            }
        });
        wait_for(|| running.load(std::sync::atomic::Ordering::SeqCst) == 1).await;
        // One slow no-SID request must not serialize unrelated no-SID requests.
        let independent = tokio::time::timeout(
            Duration::from_secs(1),
            http.post(&url).bearer_auth("synthetic-token").body("{}").send(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(independent.status(), 200);
        let body = partial_body(&url).await;
        wait_for(|| auth.uploads.available_permits() == 39).await;
        auth.reconfigure(Some("synthetic-token".into()), [], []).unwrap();
        assert_eq!(tokio::time::timeout(Duration::from_secs(1), dispatch).await.unwrap().unwrap().status(), 408);
        tokio::time::timeout(Duration::from_secs(1), response.bytes()).await.unwrap().unwrap();
        let mut body_reply = String::new();
        let mut reader = tokio::io::BufReader::new(body);
        tokio::time::timeout(Duration::from_secs(1), reader.read_line(&mut body_reply)).await.unwrap().unwrap();
        assert!(body_reply.starts_with("HTTP/1.1 408"), "{body_reply}");
        drop(reader);
        wait_for(|| {
            running.load(std::sync::atomic::Ordering::SeqCst) == 0
                && auth.uploads.available_permits() == 40
                && auth.requests.available_permits() == 32
        })
        .await;
        assert_eq!(http.post(&url).bearer_auth("synthetic-token").body("{}").send().await.unwrap().status(), 200);
        stop.cancel();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn body_readers_are_bounded_and_released_on_disconnect_and_rotation() {
        let auth = synthetic_auth();
        let (url, _running, stop, task) = auth_test_server(auth.clone()).await;
        let mut readers = Vec::new();
        for count in 1..=40 {
            readers.push(partial_body(&url).await);
            wait_for(|| auth.uploads.available_permits() == 40 - count).await;
        }
        assert_eq!(auth.requests.available_permits(), 32);
        let http = reqwest::Client::new();
        assert_eq!(http.post(&url).bearer_auth("synthetic-token").body("{}").send().await.unwrap().status(), 429);
        drop(readers.pop());
        wait_for(|| auth.uploads.available_permits() == 1).await;
        assert_eq!(http.post(&url).bearer_auth("synthetic-token").body("{}").send().await.unwrap().status(), 200);
        auth.reconfigure(Some("synthetic-token".into()), [], []).unwrap();
        wait_for(|| auth.uploads.available_permits() == 40).await;
        drop(readers);
        stop.cancel();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn stateless_headers_are_revalidated_and_malformed_transport_ids_fail_closed() {
        let auth =
            HttpAuth::new_with_hosts(Some("synthetic-token".into()), [], ["https://client.example.test".into()], false)
                .unwrap();
        let (url, _running, stop, task) = auth_test_server(auth.clone()).await;
        let http = reqwest::Client::new();
        for value in ["".to_owned(), "bad session".into(), "bad\tsession".into(), "x".repeat(257)] {
            assert_eq!(
                http.post(&url)
                    .bearer_auth("synthetic-token")
                    .header("mcp-session-id", value)
                    .body("{}")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                403
            );
        }
        for name in ["mcp-session-id", "authorization", "host", "origin"] {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer synthetic-token"));
            let value = match name {
                "authorization" => "Bearer synthetic-token",
                "origin" => "https://client.example.test",
                "host" => url.strip_prefix("http://").unwrap().strip_suffix("/mcp").unwrap(),
                _ => "stale-legacy-session",
            };
            let name = axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap();
            headers.remove(&name);
            headers.append(name.clone(), HeaderValue::from_str(value).unwrap());
            headers.append(name, HeaderValue::from_str(value).unwrap());
            assert_eq!(http.post(&url).headers(headers).body("{}").send().await.unwrap().status(), 403);
        }
        assert_eq!(
            http.post(&url)
                .bearer_auth("wrong")
                .header("mcp-session-id", "known-legacy")
                .body("{}")
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            http.post(&url)
                .bearer_auth("synthetic-token")
                .body("x".repeat(MAX_BODY + 1))
                .send()
                .await
                .unwrap()
                .status(),
            413
        );
        assert_eq!(auth.requests.available_permits(), 32);
        assert_eq!(auth.uploads.available_permits(), 40);
        stop.cancel();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn oauth_expiry_ends_only_its_post_response_and_releases_the_permit() {
        let issuer = crate::oauth::test_issuer::issuer();
        let auth = HttpAuth::new_oauth(issuer.verifier(), vec![], vec![]).unwrap();
        let (url, _running, stop, task) = auth_test_server(auth.clone()).await;
        let http = reqwest::Client::new();
        let mut claims = issuer.claims("owner");
        claims["exp"] = serde_json::json!(jsonwebtoken::get_current_timestamp() + 2);
        let expiring = http
            .post(&url)
            .bearer_auth(issuer.sign(&claims))
            .header("x-hold-response", "1")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(expiring.status(), 200);
        let fresh = http
            .post(&url)
            .bearer_auth(issuer.token("owner"))
            .header("x-hold-response", "1")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(fresh.status(), 200);
        assert_eq!(auth.requests.available_permits(), 30);
        tokio::time::timeout(Duration::from_secs(3), expiring.bytes()).await.unwrap().unwrap();
        wait_for(|| auth.requests.available_permits() == 31).await;
        drop(fresh);
        wait_for(|| auth.requests.available_permits() == 32).await;
        stop.cancel();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn policy_generation_revocation_is_durable_before_waiters_subscribe() {
        let auth = synthetic_auth();
        let previous = auth.config.read().unwrap().generation.clone();
        auth.reconfigure(Some("next-token".into()), ["next.example.test".into()], []).unwrap();
        let current = auth.config.read().unwrap().generation.clone();
        assert!(previous.is_cancelled(), "revocation cannot depend on a registered waiter");
        tokio::time::timeout(Duration::from_millis(10), previous.cancelled()).await.unwrap();
        assert!(!current.is_cancelled());
        assert!(!auth.token_matches("synthetic-token"));
        assert!(auth.token_matches("next-token"));
        // Invalid configuration must not revoke or partially replace live policy.
        assert!(auth.reconfigure(Some("bad token".into()), [], []).is_err());
        assert!(!current.is_cancelled());
        assert!(auth.token_matches("next-token"));
        // The host-only public update has the same atomic cancellation contract;
        // rebuilding a router with an unchanged host set must be harmless.
        auth.set_allowed_hosts(["next.example.test".into()]).unwrap();
        assert!(!current.is_cancelled());
        auth.set_allowed_hosts(["other.example.test".into()]).unwrap();
        assert!(current.is_cancelled());
        assert!(!auth.config.read().unwrap().generation.is_cancelled());
    }
}
