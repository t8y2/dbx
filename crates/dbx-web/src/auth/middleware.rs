//! Auth middleware and session sweeping.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ConnectInfo;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::Json;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use dbx_auth::{AuthIdentity, SessionRecord};

use crate::auth::cookies::{extract_session_token, middleware_api_path_suffix, session_cookie};
use crate::state::WebState;

/// Well-known names of proxy-injected identity headers. Regardless of trust, they are stripped before
/// reaching downstream handlers — auto-login only uses the snapshot captured before stripping (defense in depth).
const PROXY_IDENTITY_HEADERS: &[&str] = &["x-forwarded-user", "x-forwarded-email", "x-forwarded-groups", "x-forwarded-display-name"];

/// Identity context attached to authenticated requests (request extensions).
/// Admin endpoints use it for the admin-role check.
#[derive(Clone, Debug)]
pub struct AuthContext {
    pub user_id: String,
    pub role: dbx_auth::UserRole,
}

impl From<&SessionRecord> for AuthContext {
    fn from(record: &SessionRecord) -> Self {
        Self { user_id: record.user_id.clone(), role: record.role }
    }
}

fn client_ip_of(req: &Request<axum::body::Body>) -> IpAddr {
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip())
        .unwrap_or_else(|| IpAddr::V4(Ipv4Addr::LOCALHOST))
}

/// Captures and strips proxy identity headers, returning the pre-strip snapshot.
fn capture_and_strip_proxy_headers(req: &mut Request<axum::body::Body>) -> HeaderMap {
    let mut captured = HeaderMap::new();
    for name in PROXY_IDENTITY_HEADERS {
        while let Some(value) = req.headers_mut().remove(*name) {
            if let Ok(name_owned) = axum::http::HeaderName::from_bytes(name.as_bytes()) {
                captured.append(name_owned, value);
            }
        }
    }
    captured
}

/// Tries auto-login through every proxy-kind provider.
async fn proxy_identity(state: &WebState, client_ip: IpAddr, captured: &HeaderMap) -> Option<AuthIdentity> {
    for provider in state.auth_registry.list() {
        if provider.kind() != dbx_auth::AuthProviderKind::ProxyHeader {
            continue;
        }
        if let Some(identity) = provider.authenticate_proxy(client_ip, captured).await {
            return Some(identity);
        }
    }
    None
}

/// Proxy identity → user record (JIT provisioning + disabled check) → new session.
async fn proxy_login(state: &WebState, identity: AuthIdentity) -> Result<(SessionRecord, String), StatusCode> {
    let user = state.auth_users.get_or_provision(&identity).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if user.disabled {
        return Err(StatusCode::FORBIDDEN);
    }
    let record = state.sessions.create(&user).await;
    let cookie = session_cookie(state, &record.token);
    Ok((record, cookie))
}

pub async fn auth_middleware(State(state): State<Arc<WebState>>, mut req: Request<axum::body::Body>, next: Next) -> Response {
    // Unauthenticated passthrough: pre-login bootstrap endpoints (login/setup/captcha/providers) and
    // OIDC authorize/callback. change-password and logout require a session:
    // change-password must not become an unauthenticated online password oracle.
    // `/api/auth/check` has its own branch below: it must stay reachable without a session, but a
    // trusted-proxy identity has to be honored on it too (the SPA bootstrap decides between the
    // login page and the app from this response).
    let api_suffix = middleware_api_path_suffix(req.uri().path(), &state.public_base_path);
    if api_suffix.is_some_and(|suffix| {
        matches!(suffix, "auth/login" | "auth/setup" | "auth/captcha" | "auth/providers")
            || suffix.starts_with("auth/oidc/")
    }) {
        return next.run(req).await;
    }
    if api_suffix == Some("auth/check") {
        return auth_check_with_proxy_identity(State(state), req, next).await;
    }

    // Non-API requests (static files) always pass through.
    if api_suffix.is_none() {
        return next.run(req).await;
    }

    if state.password_disabled {
        return next.run(req).await;
    }

    let client_ip = client_ip_of(&req);
    // Proxy identity headers are always stripped before reaching downstream; auto-login uses the pre-strip snapshot.
    let proxy_headers = capture_and_strip_proxy_headers(&mut req);

    // Check session token
    let token = extract_session_token(&req);
    if let Some(token) = token {
        if let Some(record) = state.sessions.get(&token).await {
            // Injects the current session's owner scope into downstream handlers and the pool
            // creation paths they await, so temporary passwords of save_password=false connections stay
            // session-isolated (see SessionCredentialStore).
            req.extensions_mut().insert(AuthContext::from(&record));
            let owner = record.token;
            return dbx_core::session_credentials::with_credential_owner(Some(owner), async move { next.run(req).await }).await;
        }
    }

    // Proxy-header auto-login: trusted proxy identity + no valid session → silently create one (disabled in demo mode).
    if !state.demo_mode {
        if let Some(identity) = proxy_identity(&state, client_ip, &proxy_headers).await {
            match proxy_login(&state, identity).await {
                Ok((record, cookie)) => {
                    req.extensions_mut().insert(AuthContext::from(&record));
                    let owner = record.token.clone();
                    let mut response = dbx_core::session_credentials::with_credential_owner(Some(owner), async move { next.run(req).await }).await;
                    if let Ok(value) = cookie.parse() {
                        response.headers_mut().append(axum::http::header::SET_COOKIE, value);
                    }
                    return response;
                }
                Err(status) => return status.into_response(),
            }
        }
    }

    StatusCode::UNAUTHORIZED.into_response()
}

/// `/api/auth/check` with proxy-auto-login support. A valid session wins (the handler resolves it
/// from the cookie); otherwise a trusted-proxy identity logs in right here and the response carries
/// the fresh session directly — the check handler itself would re-report it as unauthenticated
/// because the just-created cookie is only visible to the browser after the response. Without any
/// identity the plain check handler answers (200, `authenticated:false`), identity headers stripped.
async fn auth_check_with_proxy_identity(
    State(state): State<Arc<WebState>>,
    mut req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    if let Some(token) = extract_session_token(&req) {
        if let Some(record) = state.sessions.get(&token).await {
            req.extensions_mut().insert(AuthContext::from(&record));
            let owner = record.token;
            return dbx_core::session_credentials::with_credential_owner(Some(owner), async move { next.run(req).await }).await;
        }
    }
    if state.demo_mode {
        return next.run(req).await;
    }
    let client_ip = client_ip_of(&req);
    let proxy_headers = capture_and_strip_proxy_headers(&mut req);
    if let Some(identity) = proxy_identity(&state, client_ip, &proxy_headers).await {
        match proxy_login(&state, identity).await {
            Ok((record, cookie)) => {
                let providers = crate::auth::handlers::provider_infos(&state).await;
                let mut response = Json(crate::auth::handlers::AuthCheckResponse {
                    authenticated: true,
                    required: true,
                    setup_required: false,
                    providers,
                    user: Some(record.user_summary()),
                })
                .into_response();
                if let Ok(value) = cookie.parse() {
                    response.headers_mut().append(axum::http::header::SET_COOKIE, value);
                }
                return response;
            }
            Err(status) => return status.into_response(),
        }
    }
    next.run(req).await
}

/// Periodically sweeps expired sessions (only meaningful when `DBX_WEB_SESSION_TTL_SECS` is set).
pub(crate) fn start_session_sweeper(state: &Arc<WebState>) {
    let store = state.sessions.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let swept = store.sweep_expired().await;
            if swept > 0 {
                log::info!("Swept {swept} expired web session(s)");
            }
        }
    });
}
