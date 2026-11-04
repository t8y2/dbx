use std::sync::Arc;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::state::WebState;

#[derive(Deserialize)]
pub struct LoginRequest {
    pub password: String,
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub old_password: String,
    pub new_password: String,
}

#[derive(Serialize)]
pub struct AuthCheckResponse {
    pub authenticated: bool,
    pub required: bool,
    pub setup_required: bool,
}

const MAX_ATTEMPTS: u32 = 5;
const LOCKOUT_SECS: u64 = 60;

#[derive(Clone)]
pub struct TrustedHeaderAuth {
    header: HeaderName,
    token_digest: [u8; 32],
}

impl TrustedHeaderAuth {
    pub fn from_values(
        enabled: Option<&str>,
        header: Option<&str>,
        token: Option<&str>,
    ) -> Result<Option<Self>, String> {
        let enabled = match enabled.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            None | Some("") | Some("0" | "false" | "no" | "off") => false,
            Some("1" | "true" | "yes" | "on") => true,
            Some(value) => return Err(format!("DBX_WEB_TRUSTED_AUTH_ENABLED has invalid value: {value}")),
        };
        if !enabled {
            return Ok(None);
        }

        let header = header.map(str::trim).filter(|value| !value.is_empty()).ok_or_else(|| {
            "DBX_WEB_TRUSTED_AUTH_HEADER is required when trusted Header authentication is enabled".to_string()
        })?;
        let header = HeaderName::from_bytes(header.as_bytes())
            .map_err(|_| "DBX_WEB_TRUSTED_AUTH_HEADER is not a valid HTTP header name".to_string())?;
        let token = token.filter(|value| !value.is_empty()).ok_or_else(|| {
            "DBX_WEB_TRUSTED_AUTH_TOKEN is required when trusted Header authentication is enabled".to_string()
        })?;
        let token = HeaderValue::from_str(token)
            .map_err(|_| "DBX_WEB_TRUSTED_AUTH_TOKEN is not a valid HTTP header value".to_string())?;

        Ok(Some(Self { header, token_digest: Sha256::digest(token.as_bytes()).into() }))
    }

    pub fn header_name(&self) -> &HeaderName {
        &self.header
    }

    pub fn matches(&self, headers: &HeaderMap) -> bool {
        let Some(value) = headers.get(&self.header) else {
            return false;
        };
        let candidate: [u8; 32] = Sha256::digest(value.as_bytes()).into();
        self.token_digest.iter().zip(candidate).fold(0_u8, |diff, (expected, actual)| diff | (expected ^ actual)) == 0
    }
}

fn session_cookie_path(state: &WebState) -> &str {
    state.public_base_path.as_str()
}

/// `Secure` is opt-in: LAN/HTTP deployments would otherwise never receive the
/// session cookie back. Reverse-proxy TLS deployments set DBX_WEB_COOKIE_SECURE=1.
fn cookie_secure_enabled() -> bool {
    static SECURE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *SECURE.get_or_init(|| matches!(std::env::var("DBX_WEB_COOKIE_SECURE").ok().as_deref(), Some("1") | Some("true")))
}

pub(crate) fn session_cookie(state: &WebState, token: &str) -> String {
    let secure = if cookie_secure_enabled() { "; Secure" } else { "" };
    format!("dbx_session={token}; Path={}; HttpOnly; SameSite=Lax{secure}", session_cookie_path(state))
}

fn api_path_suffix<'a>(path: &'a str, public_base_path: &str) -> Option<&'a str> {
    if let Some(suffix) = path.strip_prefix("/api/") {
        return Some(suffix);
    }
    let base = public_base_path.trim_end_matches('/');
    if base.is_empty() || base == "/" {
        return None;
    }
    path.strip_prefix(base)?.strip_prefix("/api/")
}

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

pub async fn login(State(state): State<Arc<WebState>>, Json(body): Json<LoginRequest>) -> Result<Response, StatusCode> {
    let hash_guard = state.password_hash.read().await;
    let hash_str = match hash_guard.as_deref() {
        // No password configured: nothing to authenticate against. Answer
        // explicitly instead of an ok:true that reads as "authenticated" —
        // the API remains locked by the middleware until setup completes.
        Some(h) => h.to_string(),
        None => {
            return Ok((StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "setup_required"}))).into_response());
        }
    };
    drop(hash_guard);

    // Check rate limit
    {
        let rl = state.login_rate_limit.lock().await;
        if let Some(locked_until) = rl.locked_until {
            if locked_until > std::time::Instant::now() {
                let remaining = (locked_until - std::time::Instant::now()).as_secs();
                return Ok((
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(serde_json::json!({"error": format!("Please try again in {remaining}s")})),
                )
                    .into_response());
            }
        }
    }

    let parsed_hash = PasswordHash::new(&hash_str).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if Argon2::default().verify_password(body.password.as_bytes(), &parsed_hash).is_err() {
        let mut rl = state.login_rate_limit.lock().await;
        rl.fail_count += 1;
        if rl.fail_count >= MAX_ATTEMPTS {
            rl.locked_until = Some(std::time::Instant::now() + std::time::Duration::from_secs(LOCKOUT_SECS));
            rl.fail_count = 0;
        }
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Success — reset rate limit
    {
        let mut rl = state.login_rate_limit.lock().await;
        rl.fail_count = 0;
        rl.locked_until = None;
    }

    let token = uuid::Uuid::new_v4().to_string();
    state.sessions.write().await.insert(token.clone());

    let cookie = session_cookie(&state, &token);
    Ok((StatusCode::OK, [("set-cookie", cookie.as_str())], Json(serde_json::json!({"ok": true}))).into_response())
}

pub async fn setup(State(state): State<Arc<WebState>>, Json(body): Json<LoginRequest>) -> Result<Response, StatusCode> {
    if state.password_disabled {
        return Err(StatusCode::FORBIDDEN);
    }

    // Only allow setup when no password is configured
    if state.password_hash.read().await.is_some() {
        return Err(StatusCode::FORBIDDEN);
    }

    if body.password.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(body.password.as_bytes(), &salt)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .to_string();

    // Save to database
    state.app.storage.save_password_hash(&hash).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Update in-memory state
    *state.password_hash.write().await = Some(hash);
    if state.migration_ready.load(std::sync::atomic::Ordering::Acquire) {
        if let Err(error) = state.web_mcp.reload(&state.app.storage, true).await {
            log::error!("Web MCP remained disabled after password setup: {error}");
        }
    }

    // Auto-login: create session
    let token = uuid::Uuid::new_v4().to_string();
    state.sessions.write().await.insert(token.clone());

    let cookie = session_cookie(&state, &token);
    Ok((StatusCode::OK, [("set-cookie", cookie.as_str())], Json(serde_json::json!({"ok": true}))).into_response())
}

pub async fn check(State(state): State<Arc<WebState>>, req: Request<axum::body::Body>) -> Json<AuthCheckResponse> {
    if state.password_disabled {
        return Json(AuthCheckResponse { authenticated: true, required: false, setup_required: false });
    }
    let has_password = state.password_hash.read().await.is_some();
    if has_password && valid_session_token(&state, req.headers()).await.is_some() {
        return Json(AuthCheckResponse { authenticated: true, required: true, setup_required: false });
    }
    if state.trusted_header_auth.as_ref().is_some_and(|auth| auth.matches(req.headers())) {
        return Json(AuthCheckResponse { authenticated: true, required: false, setup_required: false });
    }
    Json(AuthCheckResponse { authenticated: false, required: has_password, setup_required: !has_password })
}

pub async fn change_password(
    State(state): State<Arc<WebState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<Response, StatusCode> {
    // Session-bound: this endpoint used to sit outside the auth middleware,
    // giving unauthenticated callers an unlimited online guess at the admin
    // password with none of login's lockout. It now requires a live session
    // (defense in depth — the middleware gates it too) and, after a successful
    // change, revokes every OTHER session so a stolen old cookie cannot survive
    // a credential rotation.
    let current_token = session_token_from_headers(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    if !state.sessions.read().await.contains(&current_token) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let hash_guard = state.password_hash.read().await;
    let hash_str = match hash_guard.as_deref() {
        Some(h) => h.to_string(),
        None => return Err(StatusCode::BAD_REQUEST),
    };
    drop(hash_guard);

    if body.new_password.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let parsed_hash = PasswordHash::new(&hash_str).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if Argon2::default().verify_password(body.old_password.as_bytes(), &parsed_hash).is_err() {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let salt = SaltString::generate(&mut OsRng);
    let new_hash = Argon2::default()
        .hash_password(body.new_password.as_bytes(), &salt)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .to_string();

    state.app.storage.save_password_hash(&new_hash).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    *state.password_hash.write().await = Some(new_hash);

    // Rotation revokes sibling sessions; only the caller stays logged in.
    {
        let mut sessions = state.sessions.write().await;
        for token in sessions.iter().filter(|token| **token != current_token) {
            dbx_core::query::pl_debug::pl_debug_revoke_web_owner_core(&state.app, token);
        }
        sessions.retain(|token| *token == current_token);
    }

    Ok((StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response())
}

pub async fn logout(State(state): State<Arc<WebState>>, req: Request<axum::body::Body>) -> Response {
    if let Some(token) = extract_session_token(&req) {
        {
            let mut sessions = state.sessions.write().await;
            sessions.remove(&token);
            dbx_core::query::pl_debug::pl_debug_revoke_web_owner_core(&state.app, &token);
        }
        // 登出只清除当前登录会话的临时密码，不影响其他会话与桌面端凭据。
        state.app.session_credentials.clear_owner(&token);
    }
    let cookie = format!("dbx_session=; Path={}; HttpOnly; Max-Age=0", session_cookie_path(&state));
    (StatusCode::OK, [("set-cookie", cookie.as_str())], Json(serde_json::json!({"ok": true}))).into_response()
}

pub fn session_token_from_headers(headers: &axum::http::HeaderMap) -> Option<String> {
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

fn extract_session_token<B>(req: &Request<B>) -> Option<String> {
    session_token_from_headers(req.headers())
}

async fn valid_session_token(state: &WebState, headers: &HeaderMap) -> Option<String> {
    let token = session_token_from_headers(headers)?;
    state.sessions.read().await.contains(&token).then_some(token)
}

pub async fn auth_middleware(
    State(state): State<Arc<WebState>>,
    mut req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    // Login, setup, and the auth status check handle unauthenticated requests.
    let api_suffix = middleware_api_path_suffix(req.uri().path(), &state.public_base_path);
    if api_suffix.is_some_and(|suffix| matches!(suffix, "auth/login" | "auth/setup" | "auth/check")) {
        return next.run(req).await;
    }

    // Non-API requests (static files) are always accessible.
    if api_suffix.is_none() {
        return next.run(req).await;
    }

    if state.password_disabled {
        return next.run(req).await;
    }

    let has_password = state.password_hash.read().await.is_some();
    if has_password {
        if let Some(owner) = valid_session_token(&state, req.headers()).await {
            // 在下游处理器及其 await 到的池创建路径上注入当前登录会话的 owner 作用域，
            // 使 save_password=false 连接的临时密码按会话隔离（见 SessionCredentialStore）。
            return dbx_core::session_credentials::with_credential_owner(
                Some(owner),
                async move { next.run(req).await },
            )
            .await;
        }
    }

    if state.trusted_header_auth.as_ref().is_some_and(|auth| auth.matches(req.headers())) {
        // The only cookie DBX consumes is dbx_session. Do not let an invalid
        // session cookie select a downstream credential scope.
        req.headers_mut().remove(axum::http::header::COOKIE);
        return next.run(req).await;
    }

    StatusCode::UNAUTHORIZED.into_response()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::http::{HeaderMap, StatusCode};
    use axum::middleware;
    use axum::routing::get;
    use axum::Router;
    use tokio::sync::RwLock;

    use super::{
        api_path_suffix, auth_middleware, check, middleware_api_path_suffix, session_token_from_headers,
        TrustedHeaderAuth,
    };
    use crate::state::WebState;

    #[test]
    fn trusted_header_auth_parses_and_matches_exact_values() {
        assert!(TrustedHeaderAuth::from_values(None, None, None).unwrap().is_none());
        assert!(TrustedHeaderAuth::from_values(Some("off"), Some("bad header"), None).unwrap().is_none());
        assert!(TrustedHeaderAuth::from_values(Some("maybe"), None, None).is_err());
        assert!(TrustedHeaderAuth::from_values(Some("true"), None, Some("secret")).is_err());
        assert!(TrustedHeaderAuth::from_values(Some("true"), Some("bad header"), Some("secret")).is_err());
        assert!(TrustedHeaderAuth::from_values(Some("true"), Some("X-Auth"), None).is_err());

        let auth = TrustedHeaderAuth::from_values(Some("yes"), Some("X-Auth"), Some("secret")).unwrap().unwrap();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-auth", "secret".parse().unwrap());
        assert!(auth.matches(&headers));
        headers.insert("x-auth", "wrong".parse().unwrap());
        assert!(!auth.matches(&headers));
    }

    #[tokio::test]
    async fn trusted_header_auth_falls_back_after_session_auth() {
        let directory = tempfile::tempdir().unwrap();
        let storage = dbx_core::persistence::test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
        let mut state =
            WebState::for_tests(Arc::new(dbx_core::connection::AppState::new(storage)), directory.path().to_path_buf());
        state.trusted_header_auth =
            TrustedHeaderAuth::from_values(Some("true"), Some("X-Forwarded-Dbx-Auth"), Some("proxy-secret")).unwrap();
        state.password_hash = RwLock::new(Some("configured".to_string()));
        state.sessions.write().await.insert("legacy-session".to_string());
        let state = Arc::new(state);
        let router = Router::new()
            .route("/auth/check", get(check))
            .route(
                "/private",
                get(|headers: HeaderMap| async move {
                    let owner = dbx_core::session_credentials::current_credential_owner();
                    assert_eq!(owner, session_token_from_headers(&headers));
                    owner.unwrap_or_default()
                }),
            )
            .layer(middleware::from_fn_with_state(state.clone(), auth_middleware))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();

        let check_response = client
            .get(format!("http://{address}/auth/check"))
            .header("X-Forwarded-Dbx-Auth", "proxy-secret")
            .send()
            .await
            .unwrap();
        let check_body: serde_json::Value = check_response.json().await.unwrap();
        assert_eq!(
            check_body,
            serde_json::json!({
                "authenticated": true,
                "required": false,
                "setup_required": false
            })
        );

        let check_body: serde_json::Value = client
            .get(format!("http://{address}/auth/check"))
            .header("X-Forwarded-Dbx-Auth", "proxy-secret")
            .header("cookie", "dbx_session=legacy-session")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(check_body, serde_json::json!({ "authenticated": true, "required": true, "setup_required": false }));

        for (header, cookie, expected_owner) in [
            ("proxy-secret", "", Some("")),
            ("proxy-secret", "dbx_session=expired", Some("")),
            ("proxy-secret", "dbx_session=legacy-session", Some("legacy-session")),
            ("wrong", "dbx_session=legacy-session", Some("legacy-session")),
            ("wrong", "dbx_session=expired", None),
        ] {
            let response = client
                .get(format!("http://{address}/private"))
                .header("X-Forwarded-Dbx-Auth", header)
                .header("cookie", cookie)
                .send()
                .await
                .unwrap();
            if let Some(owner) = expected_owner {
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(response.text().await.unwrap(), owner);
            } else {
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            }
        }

        server.abort();
    }

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
    pub(crate) fn middleware_api_path_suffix_handles_nested_router_paths() {
        assert_eq!(middleware_api_path_suffix("/auth/check", "/"), Some("auth/check"));
        assert_eq!(middleware_api_path_suffix("/connection/list", "/"), Some("connection/list"));
        assert_eq!(middleware_api_path_suffix("/api/connection/list", "/"), Some("connection/list"));
        assert_eq!(middleware_api_path_suffix("/dbx/api/connection/list", "/dbx"), Some("connection/list"));
        assert_eq!(middleware_api_path_suffix("/dbx/login", "/dbx"), None);
    }
}
