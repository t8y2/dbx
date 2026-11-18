//! Session cookie and path helpers.

use axum::http::{HeaderMap, Request};

/// `Secure` is opt-in: LAN/HTTP deployments would otherwise never receive the cookie back;
/// DBX_WEB_COOKIE_SECURE=1。
pub(crate) fn cookie_secure_enabled() -> bool {
    static SECURE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *SECURE.get_or_init(|| matches!(std::env::var("DBX_WEB_COOKIE_SECURE").ok().as_deref(), Some("1") | Some("true")))
}

pub(crate) fn session_cookie_path(state: &crate::state::WebState) -> &str {
    state.public_base_path.as_str()
}

pub(crate) fn session_cookie(state: &crate::state::WebState, token: &str) -> String {
    let secure = if cookie_secure_enabled() { "; Secure" } else { "" };
    format!("dbx_session={token}; Path={}; HttpOnly; SameSite=Lax{secure}", session_cookie_path(state))
}

/// Cookie-clearing header used on logout.
pub(crate) fn clear_session_cookie(state: &crate::state::WebState) -> String {
    format!("dbx_session=; Path={}; HttpOnly; Max-Age=0", session_cookie_path(state))
}

/// Extracts the `dbx_session` cookie value from the request.
pub fn session_token_from_headers(headers: &HeaderMap) -> Option<String> {
    let cookie_header = headers.get("cookie")?.to_str().ok()?;
    for pair in cookie_header.split(';') {
        let pair = pair.trim();
        if let Some(value) = pair.strip_prefix("dbx_session=") {
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

pub(crate) fn extract_session_token<B>(req: &Request<B>) -> Option<String> {
    session_token_from_headers(req.headers())
}

/// The suffix after `/api/`; non-API paths return `None` (static files bypass the middleware).
/// Handles prefixes mounted under `DBX_PUBLIC_BASE_PATH` behind reverse proxies.
pub(crate) fn api_path_suffix<'a>(path: &'a str, public_base_path: &str) -> Option<&'a str> {
    if let Some(suffix) = path.strip_prefix("/api/") {
        return Some(suffix);
    }
    let base = public_base_path.trim_end_matches('/');
    if base.is_empty() || base == "/" {
        return None;
    }
    path.strip_prefix(base)?.strip_prefix("/api/")
}

/// Path normalization for middleware: inside nested routers `req.uri()` lacks the `/api` prefix.
pub(crate) fn middleware_api_path_suffix<'a>(path: &'a str, public_base_path: &str) -> Option<&'a str> {
    if let Some(suffix) = api_path_suffix(path, public_base_path) {
        return Some(suffix);
    }

    let base = public_base_path.trim_end_matches('/');
    if !base.is_empty() && base != "/" && path.strip_prefix(base).is_some() {
        return None;
    }

    path.strip_prefix('/').filter(|suffix| !suffix.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{api_path_suffix, middleware_api_path_suffix};

    #[test]
    fn api_path_suffix_handles_root_api_paths() {
        assert_eq!(api_path_suffix("/api/auth/check", "/"), Some("auth/check"));
        assert_eq!(api_path_suffix("/api/query/execute", "/"), Some("query/execute"));
        assert_eq!(api_path_suffix("/dbx/api/auth/check", "/"), None);
    }

    #[test]
    fn api_path_suffix_handles_mounted_api_paths() {
        assert_eq!(api_path_suffix("/dbx/api/auth/check", "/dbx"), Some("auth/check"));
        assert_eq!(api_path_suffix("/tools/dbx/api/query/execute", "/tools/dbx"), Some("query/execute"));
        assert_eq!(api_path_suffix("/dbx/login", "/dbx"), None);
    }

    #[test]
    fn middleware_api_path_suffix_handles_nested_router_paths() {
        assert_eq!(middleware_api_path_suffix("/auth/check", "/"), Some("auth/check"));
        assert_eq!(middleware_api_path_suffix("/connection/list", "/"), Some("connection/list"));
        assert_eq!(middleware_api_path_suffix("/api/connection/list", "/"), Some("connection/list"));
        assert_eq!(middleware_api_path_suffix("/dbx/api/connection/list", "/dbx"), Some("connection/list"));
        assert_eq!(middleware_api_path_suffix("/dbx/login", "/dbx"), None);
    }
}
