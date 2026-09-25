use std::{collections::HashSet, sync::Arc};

use axum::{
    extract::{Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use url::Url;

/// Authentication and browser-origin policy for the Streamable HTTP endpoint.
/// The token is intentionally not `Debug` and is never exposed by diagnostics.
#[derive(Clone)]
pub struct HttpAuth {
    token: Arc<[u8]>,
    allowed_origins: HashSet<String>,
    allow_loopback_origins: bool,
}

impl HttpAuth {
    pub fn new(
        token: String,
        allowed_origins: impl IntoIterator<Item = String>,
        allow_loopback_origins: bool,
    ) -> Result<Self, String> {
        if token.trim().is_empty() || token.contains(char::is_whitespace) {
            return Err("MCP HTTP bearer token must be non-empty and contain no whitespace".into());
        }

        let mut normalized_origins = HashSet::new();
        for origin in allowed_origins {
            normalized_origins.insert(normalize_origin(&origin)?);
        }

        Ok(Self { token: Arc::from(token.into_bytes()), allowed_origins: normalized_origins, allow_loopback_origins })
    }

    fn token_matches(&self, candidate: &str) -> bool {
        let candidate = candidate.as_bytes();
        if candidate.len() != self.token.len() {
            return false;
        }

        // Keep comparison work independent of the first mismatching byte.
        let difference = self
            .token
            .iter()
            .zip(candidate)
            .fold(0_u8, |difference, (expected, actual)| difference | (expected ^ actual));
        difference == 0
    }

    pub fn origin_is_allowed(&self, origin: &str) -> bool {
        let Ok(origin) = normalize_origin(origin) else {
            return false;
        };
        if self.allowed_origins.contains(&origin) {
            return true;
        }
        self.allow_loopback_origins && origin_is_loopback(&origin)
    }
}

pub async fn authorize_request(State(auth): State<HttpAuth>, request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        let origin = match origin.to_str() {
            Ok(origin) => origin,
            Err(_) => {
                log::warn!(target: "dbx_mcp::audit", "MCP HTTP request rejected: method={method} path={path} reason=invalid-origin");
                return forbidden();
            }
        };
        if !auth.origin_is_allowed(origin) {
            log::warn!(target: "dbx_mcp::audit", "MCP HTTP request rejected: method={method} path={path} origin={origin} reason=origin-not-allowed");
            return forbidden();
        }
    }

    let Some(token) = bearer_token(request.headers().get(header::AUTHORIZATION)) else {
        log::warn!(target: "dbx_mcp::audit", "MCP HTTP request rejected: method={method} path={path} reason=missing-bearer-token");
        return unauthorized();
    };
    if !auth.token_matches(token) {
        log::warn!(target: "dbx_mcp::audit", "MCP HTTP request rejected: method={method} path={path} reason=invalid-bearer-token");
        return unauthorized();
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
