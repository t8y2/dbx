use std::{
    collections::HashSet,
    sync::{Arc, RwLock},
};

use axum::{
    extract::{Request, State},
    http::{header, HeaderValue, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
};
use url::Url;

/// Authentication and browser-origin policy for the Streamable HTTP endpoint.
/// The token is intentionally not `Debug` and is never exposed by diagnostics.
#[derive(Clone)]
pub struct HttpAuth {
    config: Arc<RwLock<HttpAuthConfig>>,
}

#[derive(Clone)]
struct HttpAuthConfig {
    token: Option<Arc<[u8]>>,
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
            allowed_hosts: normalize_hosts(allowed_hosts)?,
            allowed_origins: normalize_origins(allowed_origins)?,
            allow_loopback_origins,
        };
        Ok(Self { config: Arc::new(RwLock::new(config)) })
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
            allowed_hosts: normalize_hosts(allowed_hosts)?,
            allowed_origins: normalize_origins(allowed_origins)?,
            allow_loopback_origins: self
                .config
                .read()
                .unwrap_or_else(|error| error.into_inner())
                .allow_loopback_origins,
        };
        *self.config.write().unwrap_or_else(|error| error.into_inner()) = next;
        Ok(())
    }

    pub fn set_allowed_hosts(&self, allowed_hosts: impl IntoIterator<Item = String>) -> Result<(), String> {
        let allowed_hosts = normalize_hosts(allowed_hosts)?;
        self.config.write().unwrap_or_else(|error| error.into_inner()).allowed_hosts = allowed_hosts;
        Ok(())
    }

    pub fn enabled(&self) -> bool {
        self.config.read().unwrap_or_else(|error| error.into_inner()).token.is_some()
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

pub async fn authorize_request(State(auth): State<HttpAuth>, request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    {
        let config = auth.config.read().unwrap_or_else(|error| error.into_inner());
        if config.token.is_none() {
            log::warn!(target: "dbx_mcp::audit", "MCP HTTP request rejected: method={method} path={path} reason=server-disabled");
            return not_found();
        }

        if let Some(origin) = request.headers().get(header::ORIGIN) {
            let origin = match origin.to_str() {
                Ok(origin) => origin,
                Err(_) => {
                    log::warn!(target: "dbx_mcp::audit", "MCP HTTP request rejected: method={method} path={path} reason=invalid-origin");
                    return forbidden();
                }
            };
            if !origin_is_allowed(&config, origin) {
                log::warn!(target: "dbx_mcp::audit", "MCP HTTP request rejected: method={method} path={path} origin={origin} reason=origin-not-allowed");
                return forbidden();
            }
        }

        if !host_is_allowed(&config, request.uri(), request.headers()) {
            log::warn!(target: "dbx_mcp::audit", "MCP HTTP request rejected: method={method} path={path} reason=host-not-allowed");
            return forbidden();
        }

        let Some(token) = bearer_token(request.headers().get(header::AUTHORIZATION)) else {
            log::warn!(target: "dbx_mcp::audit", "MCP HTTP request rejected: method={method} path={path} reason=missing-bearer-token");
            return unauthorized();
        };
        if !token_matches(&config, token) {
            log::warn!(target: "dbx_mcp::audit", "MCP HTTP request rejected: method={method} path={path} reason=invalid-bearer-token");
            return unauthorized();
        }
    }

    let response = next.run(request).await;
    log::info!(target: "dbx_mcp::audit", "MCP HTTP request authenticated: method={method} path={path} status={}", response.status());
    response
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

fn unauthorized() -> Response {
    let mut response = (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    response.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
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
    let authority =
        axum::http::uri::Authority::try_from(value.trim()).map_err(|_| format!("invalid allowed host: {value}"))?;
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
    }
}
