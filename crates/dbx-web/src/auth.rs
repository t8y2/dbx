use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::StreamExt;
use serde::{Deserialize, Serialize};

use crate::state::{LoginRateLimit, SessionInfo, WebState};

#[derive(Deserialize)]
pub struct LoginRequest {
    /// Optional for backwards compatibility: old clients send only a
    /// password, which maps to the default "admin" account.
    pub username: Option<String>,
    pub password: String,
}

#[derive(Deserialize)]
pub struct SetupRequest {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub password: String,
    /// Admins may grant the new account admin rights too (default: no).
    pub is_admin: Option<bool>,
}

#[derive(Deserialize)]
pub struct ResetPasswordRequest {
    pub password: String,
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    /// Optional: must name the session's own account when given. Other
    /// accounts are reset through the admin user-management endpoint instead.
    pub username: Option<String>,
    pub old_password: String,
    pub new_password: String,
}

#[derive(Serialize)]
pub struct AuthCheckResponse {
    pub authenticated: bool,
    pub required: bool,
    pub setup_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// True when the signed-in account may manage user accounts.
    pub is_admin: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    /// True for host-provided env accounts, which cannot be managed here.
    pub managed_by_env: bool,
    /// Env accounts always count as admin (they are host-provisioned).
    pub is_admin: bool,
}

const MAX_ATTEMPTS: u32 = 5;
const LOCKOUT_SECS: u64 = 60;
const DEFAULT_USERNAME: &str = "admin";
/// Minimum length for passwords set through any endpoint. Existing shorter
/// passwords keep working; the policy applies when a password is set.
const MIN_PASSWORD_LEN: usize = 8;
/// How often the background sweeper drops idle-expired sessions.
const SESSION_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

fn session_cookie_path(state: &WebState) -> &str {
    state.public_base_path.as_str()
}

fn session_cookie(state: &WebState, token: &str) -> String {
    let secure = if state.cookie_secure { "; Secure" } else { "" };
    format!("dbx_session={token}; Path={}; HttpOnly; SameSite=Lax{secure}", session_cookie_path(state))
}

fn expired_session_cookie(state: &WebState) -> String {
    let secure = if state.cookie_secure { "; Secure" } else { "" };
    format!("dbx_session=; Path={}; HttpOnly; SameSite=Lax; Max-Age=0{secure}", session_cookie_path(state))
}

/// Resolves a session token to its username, enforcing the optional idle
/// timeout: expired sessions are dropped (with their credential scope), live
/// sessions have their activity timestamp refreshed.
async fn lookup_session(state: &WebState, token: &str) -> Option<String> {
    let mut sessions = state.sessions.write().await;
    let info = sessions.get_mut(token)?;
    if let Some(timeout) = state.session_idle_timeout {
        if info.last_active.elapsed() > timeout {
            sessions.remove(token);
            drop(sessions);
            state.app.session_credentials.clear_owner(token);
            return None;
        }
        info.last_active = std::time::Instant::now();
    }
    Some(info.username.clone())
}

fn hash_password(password: &str) -> Result<String, StatusCode> {
    let salt = SaltString::generate(&mut OsRng);
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .to_string())
}

fn verify_password(password: &str, hash: &str) -> bool {
    let parsed_hash = match PasswordHash::new(hash) {
        Ok(h) => h,
        Err(_) => return false,
    };
    Argon2::default().verify_password(password.as_bytes(), &parsed_hash).is_ok()
}

/// Argon2 hash of a fixed throwaway password. Unknown usernames verify against
/// it so they take the same code path (and time) as real accounts — the login
/// response time must not reveal whether an account exists.
fn dummy_password_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash_password("dbx-timing-parity-dummy").expect("hash dummy password"))
}

fn password_too_short(password: &str) -> bool {
    password.chars().count() < MIN_PASSWORD_LEN
}

fn password_too_short_response() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error": format!("Password must be at least {MIN_PASSWORD_LEN} characters")})),
    )
        .into_response()
}

/// Source address of the current request, when present. The server is started
/// with `into_make_service_with_connect_info`, so this is always set in
/// production; unit tests calling handlers directly get `None`.
pub struct ClientIp(Option<std::net::IpAddr>);

impl<S> axum::extract::FromRequestParts<S> for ClientIp
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut axum::http::request::Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Self(parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|info| info.0.ip())))
    }
}

/// Rate-limit bucket for failed authentication, keyed per account and source
/// IP: an attacker only ever locks out their own address, not the account for
/// everyone else. Behind a reverse proxy all clients share the proxy's
/// address, which degrades this to per-account (the previous behavior).
/// Folding is ASCII-only, matching how usernames compare (`COLLATE NOCASE` /
/// `eq_ignore_ascii_case`), so distinct non-ASCII usernames never share a bucket.
fn rate_limit_key(username: &str, client_ip: Option<std::net::IpAddr>) -> String {
    match client_ip {
        Some(ip) => format!("{}|{ip}", username.to_ascii_lowercase()),
        None => format!("{}|unknown", username.to_ascii_lowercase()),
    }
}

/// Remaining lockout seconds when this key is currently locked.
async fn lockout_remaining(state: &WebState, key: &str) -> Option<u64> {
    let limits = state.login_rate_limit.lock().await;
    let locked_until = limits.get(key).and_then(|limit| limit.locked_until)?;
    let now = std::time::Instant::now();
    (locked_until > now).then(|| (locked_until - now).as_secs().max(1))
}

fn lockout_response(remaining: u64) -> Response {
    (StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({"error": format!("Please try again in {remaining}s")})))
        .into_response()
}

/// Counts a failed authentication attempt and locks the key after
/// MAX_ATTEMPTS. Unknown usernames count too, so a 429 response never
/// confirms that an account exists.
async fn record_auth_failure(state: &WebState, key: &str) {
    let mut limits = state.login_rate_limit.lock().await;
    // Keep the map bounded when attackers spray unknown usernames/addresses:
    // drop entries that are neither locked nor mid-count before inserting.
    if !limits.contains_key(key) && limits.len() >= 4096 {
        let now = std::time::Instant::now();
        limits.retain(|_, limit| limit.locked_until.is_some_and(|locked_until| locked_until > now));
        if limits.len() >= 4096 {
            // Still full of actively-locked keys: skip tracking this failure
            // rather than growing the map without bound. The login itself is
            // still verified (and rejected) as usual.
            return;
        }
    }
    let limit = limits.entry(key.to_string()).or_insert_with(|| LoginRateLimit { fail_count: 0, locked_until: None });
    limit.fail_count += 1;
    if limit.fail_count >= MAX_ATTEMPTS {
        limit.locked_until = Some(std::time::Instant::now() + std::time::Duration::from_secs(LOCKOUT_SECS));
        limit.fail_count = 0;
    }
}

fn normalize_username(username: Option<&str>) -> String {
    username.map(str::trim).filter(|u| !u.is_empty()).unwrap_or(DEFAULT_USERNAME).to_string()
}

/// True when at least one account (env-provided or in the users table) exists.
async fn has_any_account(state: &WebState) -> bool {
    !state.bootstrap_users.is_empty() || *state.has_db_users.read().await
}

/// Resolve the Argon2 hash for a username: env-provided accounts win over DB users.
async fn resolve_user_hash(state: &WebState, username: &str) -> Option<String> {
    // Match bootstrap accounts case-insensitively, consistent with DB users
    // (UNIQUE ... COLLATE NOCASE) and the duplicate check in create_user.
    if let Some((_, hash)) = state.bootstrap_users.iter().find(|(u, _)| u.eq_ignore_ascii_case(username)) {
        return Some(hash.clone());
    }
    state.app.storage.load_user_by_username(username).await.ok().flatten().map(|u| u.password_hash)
}

/// Env-provisioned accounts are host-superusers; DB users are admins when
/// their row carries the admin flag.
async fn is_admin_username(state: &WebState, username: &str) -> bool {
    if state.bootstrap_users.keys().any(|u| u.eq_ignore_ascii_case(username)) {
        return true;
    }
    state.app.storage.load_user_by_username(username).await.ok().flatten().is_some_and(|u| u.is_admin)
}

/// Username owning the session token in these headers, if the session is valid.
async fn session_username(state: &WebState, headers: &axum::http::HeaderMap) -> Option<String> {
    let token = session_token_from_headers(headers)?;
    lookup_session(state, &token).await
}

/// Gate for user-management endpoints: a valid session whose account is an
/// admin. Returns the session's username on success.
async fn require_admin_session(state: &WebState, headers: &axum::http::HeaderMap) -> Result<String, StatusCode> {
    let username = session_username(state, headers).await.ok_or(StatusCode::UNAUTHORIZED)?;
    if !is_admin_username(state, &username).await {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(username)
}

/// Drops every session of `username` except `keep_token` (the session that
/// just proved the old password, so the acting user is not logged out).
async fn drop_sessions_for_user(state: &WebState, username: &str, keep_token: Option<&str>) {
    // Sessions store the username as typed at login, whose casing may differ
    // from the account name (usernames match case-insensitively).
    let dropped: Vec<String> = {
        let sessions = state.sessions.read().await;
        sessions
            .iter()
            .filter(|(token, info)| info.username.eq_ignore_ascii_case(username) && Some(token.as_str()) != keep_token)
            .map(|(token, _)| token.clone())
            .collect()
    };
    if dropped.is_empty() {
        return;
    }
    {
        let mut sessions = state.sessions.write().await;
        for token in &dropped {
            sessions.remove(token);
        }
    }
    // Dropped sessions lose their per-session saved-password scope, same as logout.
    for token in &dropped {
        state.app.session_credentials.clear_owner(token);
    }
}

pub async fn login(
    State(state): State<Arc<WebState>>,
    client_ip: ClientIp,
    Json(body): Json<LoginRequest>,
) -> Result<Response, StatusCode> {
    if !has_any_account(&state).await {
        // No account configured yet — the client will proceed to setup.
        return Ok((StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response());
    }

    let username = normalize_username(body.username.as_deref());
    let limit_key = rate_limit_key(&username, client_ip.0);
    if let Some(remaining) = lockout_remaining(&state, &limit_key).await {
        return Ok(lockout_response(remaining));
    }

    // Unknown usernames verify against a dummy hash so the response time does
    // not reveal whether the account exists.
    let hash = resolve_user_hash(&state, &username).await;
    let verified = match hash.as_deref() {
        Some(hash) => verify_password(&body.password, hash),
        None => {
            verify_password(&body.password, dummy_password_hash());
            false
        }
    };

    if !verified {
        record_auth_failure(&state, &limit_key).await;
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Success — reset this key's failure count.
    state.login_rate_limit.lock().await.remove(&limit_key);

    let token = uuid::Uuid::new_v4().to_string();
    state.sessions.write().await.insert(token.clone(), SessionInfo::new(username));

    let cookie = session_cookie(&state, &token);
    Ok((StatusCode::OK, [("set-cookie", cookie.as_str())], Json(serde_json::json!({"ok": true}))).into_response())
}

pub async fn setup(State(state): State<Arc<WebState>>, Json(body): Json<SetupRequest>) -> Result<Response, StatusCode> {
    if state.password_disabled {
        return Err(StatusCode::FORBIDDEN);
    }

    // Only allow setup when no account exists yet
    if has_any_account(&state).await {
        return Err(StatusCode::FORBIDDEN);
    }

    let username = body.username.trim().to_string();
    if username.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if password_too_short(&body.password) {
        return Ok(password_too_short_response());
    }

    let hash = hash_password(&body.password)?;

    // Atomically claim the first account: a concurrent setup that loses the
    // race sees a non-empty users table and is forbidden. The first account
    // becomes the admin.
    let created = state
        .app
        .storage
        .create_first_user_if_empty(&username, &hash)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if created.is_none() {
        return Err(StatusCode::FORBIDDEN);
    }
    *state.has_db_users.write().await = true;

    // Auto-login: create session
    let token = uuid::Uuid::new_v4().to_string();
    state.sessions.write().await.insert(token.clone(), SessionInfo::new(username));

    let cookie = session_cookie(&state, &token);
    Ok((StatusCode::OK, [("set-cookie", cookie.as_str())], Json(serde_json::json!({"ok": true}))).into_response())
}

pub async fn check(State(state): State<Arc<WebState>>, req: Request<axum::body::Body>) -> Json<AuthCheckResponse> {
    if state.password_disabled {
        return Json(AuthCheckResponse {
            authenticated: true,
            required: false,
            setup_required: false,
            username: None,
            is_admin: false,
        });
    }
    if !has_any_account(&state).await {
        return Json(AuthCheckResponse {
            authenticated: false,
            required: false,
            setup_required: true,
            username: None,
            is_admin: false,
        });
    }
    let username = match extract_session_token(&req) {
        Some(token) => lookup_session(&state, &token).await,
        None => None,
    };
    let is_admin = match username.as_deref() {
        Some(username) => is_admin_username(&state, username).await,
        None => false,
    };
    Json(AuthCheckResponse {
        authenticated: username.is_some(),
        required: true,
        setup_required: false,
        username,
        is_admin,
    })
}

pub async fn change_password(
    State(state): State<Arc<WebState>>,
    req: Request<axum::body::Body>,
) -> Result<Response, StatusCode> {
    let session_token = extract_session_token(&req);
    let client_ip = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|info| info.0.ip());
    let session_user = match session_token.as_deref() {
        Some(token) => lookup_session(&state, token).await,
        None => None,
    };
    let body: ChangePasswordRequest = match axum::body::to_bytes(req.into_body(), 1024 * 16).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| StatusCode::BAD_REQUEST)?,
        Err(_) => return Err(StatusCode::BAD_REQUEST),
    };

    // Defense in depth: the middleware already requires a session for this
    // route, but the handler must not depend on that alone.
    let Some(session_user) = session_user else {
        return Err(StatusCode::UNAUTHORIZED);
    };

    // Self-service only: the target account is always the session's account.
    // Other accounts are reset through the admin user-management endpoint.
    if body
        .username
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .is_some_and(|requested| !requested.eq_ignore_ascii_case(&session_user))
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let username = session_user;

    if password_too_short(&body.new_password) {
        return Ok(password_too_short_response());
    }

    // Env-provided accounts are managed by the host, not through the UI.
    if state.bootstrap_users.keys().any(|u| u.eq_ignore_ascii_case(&username)) {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "This account's password is managed via environment variables"})),
        )
            .into_response());
    }

    // Failed old-password checks share the login lockout (per account + source
    // IP), so this endpoint cannot be used as an unthrottled brute-force oracle.
    let limit_key = rate_limit_key(&username, client_ip);
    if let Some(remaining) = lockout_remaining(&state, &limit_key).await {
        return Ok(lockout_response(remaining));
    }

    let user = match state
        .app
        .storage
        .load_user_by_username(&username)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        Some(u) => u,
        // The account was deleted mid-session: keep timing parity and count
        // the failure rather than revealing the account is gone.
        None => {
            verify_password(&body.old_password, dummy_password_hash());
            record_auth_failure(&state, &limit_key).await;
            return Err(StatusCode::UNAUTHORIZED);
        }
    };

    if !verify_password(&body.old_password, &user.password_hash) {
        record_auth_failure(&state, &limit_key).await;
        return Err(StatusCode::UNAUTHORIZED);
    }
    state.login_rate_limit.lock().await.remove(&limit_key);

    let new_hash = hash_password(&body.new_password)?;
    state.app.storage.update_user_password(user.id, &new_hash).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Revoke all other sessions of this account so a stolen or stale session
    // dies with the old password. The acting session proved the old password
    // and stays signed in.
    drop_sessions_for_user(&state, &user.username, session_token.as_deref()).await;

    Ok((StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response())
}

pub async fn list_users(
    State(state): State<Arc<WebState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<UserSummary>>, StatusCode> {
    require_admin_session(&state, &headers).await?;
    let db_users = state.app.storage.list_users().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut users: Vec<UserSummary> = db_users
        .into_iter()
        // An env-provisioned account shadows a same-named DB row for login and
        // admin checks; listing both would show a dead duplicate whose reset/
        // delete buttons change nothing the login path would ever use.
        .filter(|u| !state.bootstrap_users.keys().any(|env| env.eq_ignore_ascii_case(&u.username)))
        .map(|u| UserSummary {
            id: Some(u.id),
            username: u.username,
            created_at: Some(u.created_at),
            managed_by_env: false,
            is_admin: u.is_admin,
        })
        .collect();
    for username in state.bootstrap_users.keys() {
        users.push(UserSummary {
            id: None,
            username: username.clone(),
            created_at: None,
            managed_by_env: true,
            is_admin: true,
        });
    }
    users.sort_by_key(|u| u.username.to_lowercase());
    Ok(Json(users))
}

pub async fn create_user(
    State(state): State<Arc<WebState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<CreateUserRequest>,
) -> Result<Response, StatusCode> {
    require_admin_session(&state, &headers).await?;
    let username = body.username.trim().to_string();
    if username.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if password_too_short(&body.password) {
        return Ok(password_too_short_response());
    }
    if state.bootstrap_users.keys().any(|u| u.eq_ignore_ascii_case(&username)) {
        return Ok(
            (StatusCode::CONFLICT, Json(serde_json::json!({"error": "Username already exists"}))).into_response()
        );
    }
    if state
        .app
        .storage
        .load_user_by_username(&username)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some()
    {
        return Ok(
            (StatusCode::CONFLICT, Json(serde_json::json!({"error": "Username already exists"}))).into_response()
        );
    }

    let hash = hash_password(&body.password)?;
    state.app.storage.create_user(&username, &hash, body.is_admin == Some(true)).await.map_err(|e| {
        // Lost a concurrent create race: the UNIQUE constraint is the
        // final arbiter of the duplicate check above.
        if e.contains("UNIQUE constraint failed") {
            StatusCode::CONFLICT
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    })?;
    *state.has_db_users.write().await = true;

    Ok((StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response())
}

pub async fn delete_user(
    State(state): State<Arc<WebState>>,
    Path(id): Path<i64>,
    req: Request<axum::body::Body>,
) -> Result<Response, StatusCode> {
    let session_user = require_admin_session(&state, req.headers()).await?;

    let users = state.app.storage.list_users().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(target) = users.iter().find(|u| u.id == id) else {
        return Err(StatusCode::NOT_FOUND);
    };

    if session_user.eq_ignore_ascii_case(&target.username) {
        return Ok((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "You cannot delete your own account"})))
            .into_response());
    }

    let username = target.username.clone();
    // Env-provisioned accounts are always admins and never stored in the users
    // table, so the last-DB-admin guard only applies when no env account exists.
    let allow_delete_last_admin = !state.bootstrap_users.is_empty();
    // Atomic: the delete only happens while another account remains, so
    // concurrent deletions cannot remove the last account.
    match state
        .app
        .storage
        .delete_user_if_not_last(id, allow_delete_last_admin)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        dbx_core::storage::DeleteUserResult::Deleted { remaining } => {
            *state.has_db_users.write().await = remaining > 0;
            drop_sessions_for_user(&state, &username, None).await;
            Ok((StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response())
        }
        dbx_core::storage::DeleteUserResult::LastUser => {
            Ok((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Cannot delete the last user account"})))
                .into_response())
        }
        dbx_core::storage::DeleteUserResult::LastAdmin => {
            Ok((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Cannot delete the last admin account"})))
                .into_response())
        }
        dbx_core::storage::DeleteUserResult::NotFound => Err(StatusCode::NOT_FOUND),
    }
}

pub async fn reset_user_password(
    State(state): State<Arc<WebState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<ResetPasswordRequest>,
) -> Result<Response, StatusCode> {
    require_admin_session(&state, &headers).await?;
    if password_too_short(&body.password) {
        return Ok(password_too_short_response());
    }

    let users = state.app.storage.list_users().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(target) = users.iter().find(|u| u.id == id) else {
        return Err(StatusCode::NOT_FOUND);
    };

    let hash = hash_password(&body.password)?;
    state.app.storage.update_user_password(id, &hash).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Keep the acting admin's own session alive when the target is a different
    // account; all of the target account's sessions are revoked.
    let keep = session_token_from_headers(&headers);
    drop_sessions_for_user(&state, &target.username, keep.as_deref()).await;

    Ok((StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response())
}

pub async fn logout(State(state): State<Arc<WebState>>, req: Request<axum::body::Body>) -> Response {
    if let Some(token) = extract_session_token(&req) {
        state.sessions.write().await.remove(&token);
        // 登出只清除当前登录会话的临时密码，不影响其他会话与桌面端凭据。
        state.app.session_credentials.clear_owner(&token);
    }
    let cookie = expired_session_cookie(&state);
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

/// Refreshes a live session's activity timestamp. Never resurrects a session
/// that is already gone (logout, password change, sweep).
async fn touch_session(state: &WebState, token: &str) -> bool {
    let mut sessions = state.sessions.write().await;
    match sessions.get_mut(token) {
        Some(info) => {
            info.last_active = std::time::Instant::now();
            true
        }
        None => false,
    }
}

/// Keeps a session active while a long-lived connection (SSE stream,
/// WebSocket) is open: refreshes its activity timestamp periodically and
/// aborts the refresh task when dropped, i.e. when the connection closes.
pub(crate) struct SessionKeepAlive {
    task: tokio::task::JoinHandle<()>,
}

impl SessionKeepAlive {
    pub(crate) fn spawn(state: &Arc<WebState>, token: String) -> Option<Self> {
        let timeout = state.session_idle_timeout?;
        // Refresh comfortably inside the idle window.
        let tick = (timeout / 2).clamp(std::time::Duration::from_millis(10), SESSION_SWEEP_INTERVAL);
        let state = state.clone();
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(tick);
            loop {
                interval.tick().await;
                if !touch_session(&state, &token).await {
                    break;
                }
            }
        });
        Some(Self { task })
    }
}

impl Drop for SessionKeepAlive {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// An open SSE stream means the client is still active: keep the session's
/// activity timestamp fresh for the lifetime of the stream instead of letting
/// it idle-expire silently mid-connection. Non-stream responses pass through.
fn keep_session_alive_for_stream(state: &Arc<WebState>, token: String, response: Response) -> Response {
    let is_event_stream = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    if !is_event_stream {
        return response;
    }
    let Some(keep_alive) = SessionKeepAlive::spawn(state, token) else {
        return response;
    };
    // The guard travels with the response body: when the connection closes and
    // the body stream is dropped, the keep-alive task stops with it.
    let (parts, body) = response.into_parts();
    let stream = body.into_data_stream().map(move |chunk| {
        let _keep_alive = &keep_alive;
        chunk
    });
    Response::from_parts(parts, axum::body::Body::from_stream(stream))
}

/// Builds a session keep-alive for long-lived connections the middleware
/// cannot wrap (WebSocket upgrades). The handler holds the returned guard for
/// the connection's lifetime. `None` when no session cookie is present or no
/// idle timeout is configured.
pub(crate) fn session_keep_alive_from_headers(
    state: &Arc<WebState>,
    headers: &axum::http::HeaderMap,
) -> Option<SessionKeepAlive> {
    let token = session_token_from_headers(headers)?;
    SessionKeepAlive::spawn(state, token)
}

/// Removes idle-expired sessions (and their credential scope), keeping the
/// session map bounded even for expired tokens that are never presented again.
async fn sweep_expired_sessions(state: &WebState) {
    let Some(timeout) = state.session_idle_timeout else {
        return;
    };
    let expired: Vec<String> = {
        let sessions = state.sessions.read().await;
        sessions
            .iter()
            .filter(|(_, info)| info.last_active.elapsed() > timeout)
            .map(|(token, _)| token.clone())
            .collect()
    };
    if expired.is_empty() {
        return;
    }
    {
        let mut sessions = state.sessions.write().await;
        for token in &expired {
            sessions.remove(token);
        }
    }
    for token in &expired {
        state.app.session_credentials.clear_owner(token);
    }
}

/// Background task sweeping idle-expired sessions once a minute. Spawned by
/// the web server at startup; a no-op while no idle timeout is configured.
pub fn spawn_session_sweeper(state: Arc<WebState>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SESSION_SWEEP_INTERVAL);
        loop {
            interval.tick().await;
            sweep_expired_sessions(&state).await;
        }
    })
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

fn middleware_api_path_suffix<'a>(path: &'a str, public_base_path: &str) -> Option<&'a str> {
    if let Some(suffix) = api_path_suffix(path, public_base_path) {
        return Some(suffix);
    }

    let base = public_base_path.trim_end_matches('/');
    if !base.is_empty() && base != "/" && path.strip_prefix(base).is_some() {
        return None;
    }

    path.strip_prefix('/').filter(|suffix| !suffix.is_empty())
}

pub async fn auth_middleware(
    State(state): State<Arc<WebState>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    // Only these auth endpoints are reachable without a session. Everything
    // else under auth/ (change-password, user management) requires login.
    const PUBLIC_AUTH_PATHS: &[&str] = &["auth/login", "auth/check", "auth/setup", "auth/logout"];
    let api_suffix = middleware_api_path_suffix(req.uri().path(), &state.public_base_path);
    if api_suffix.is_some_and(|suffix| PUBLIC_AUTH_PATHS.contains(&suffix)) {
        return next.run(req).await;
    }

    // Non-API requests (static files) are always accessible.
    if api_suffix.is_none() {
        return next.run(req).await;
    }

    if state.password_disabled {
        return next.run(req).await;
    }

    if !has_any_account(&state).await {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    // Check session token
    let token = extract_session_token(&req);
    if let Some(token) = token {
        if lookup_session(&state, &token).await.is_some() {
            // 在下游处理器及其 await 到的池创建路径上注入当前登录会话的 owner 作用域，
            // 使 save_password=false 连接的临时密码按会话隔离（见 SessionCredentialStore）。
            let owner = token.clone();
            let response =
                dbx_core::session_credentials::with_credential_owner(Some(owner), async move { next.run(req).await })
                    .await;
            return keep_session_alive_for_stream(&state, token, response);
        }
    }

    StatusCode::UNAUTHORIZED.into_response()
}

#[cfg(test)]
mod tests {
    use super::{
        api_path_suffix, auth_middleware, change_password, check, create_user, delete_user, hash_password, list_users,
        login, logout, middleware_api_path_suffix, rate_limit_key, record_auth_failure, reset_user_password,
        session_keep_alive_from_headers, setup, sweep_expired_sessions, touch_session, ClientIp, CreateUserRequest,
        LoginRequest, ResetPasswordRequest, SetupRequest,
    };
    use crate::state::WebState;
    use axum::body::Body;
    use axum::extract::{Path, State};
    use axum::http::{HeaderMap, Request, StatusCode};
    use axum::Json;
    use dbx_core::connection::AppState;
    use dbx_core::storage::Storage;
    use std::sync::Arc;

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

    async fn test_state() -> (Arc<WebState>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbx-web-auth-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("dbx.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        (Arc::new(WebState::for_tests(app, dir.clone())), dir)
    }

    fn login_body(username: Option<&str>, password: &str) -> Json<LoginRequest> {
        Json(LoginRequest { username: username.map(|u| u.to_string()), password: password.to_string() })
    }

    async fn login_token(state: &Arc<WebState>, username: Option<&str>, password: &str) -> String {
        let res = login(State(state.clone()), ClientIp(None), login_body(username, password)).await.unwrap();
        let cookie = res
            .headers()
            .get("set-cookie")
            .and_then(|v| v.to_str().ok())
            .expect("login should set a session cookie")
            .to_string();
        cookie.strip_prefix("dbx_session=").unwrap().split(';').next().unwrap().to_string()
    }

    fn auth_headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("cookie", format!("dbx_session={token}").parse().unwrap());
        headers
    }

    async fn add_user(state: &Arc<WebState>, username: &str, password: &str, is_admin: bool) -> i64 {
        state.app.storage.create_user(username, &hash_password(password).unwrap(), is_admin).await.unwrap()
    }

    #[tokio::test]
    async fn setup_creates_first_user_and_rejects_second_setup() {
        let (state, dir) = test_state().await;

        // Fresh state reports setup_required.
        let req = Request::builder().body(Body::empty()).unwrap();
        let res = check(State(state.clone()), req).await;
        assert!(res.setup_required);
        assert!(!res.authenticated);

        let res = setup(
            State(state.clone()),
            Json(SetupRequest { username: "admin".to_string(), password: "secret-password".to_string() }),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(state.app.storage.count_users().await.unwrap(), 1);
        assert!(*state.has_db_users.read().await);

        // The first account is the admin, and its session reports as such.
        let admin = state.app.storage.load_user_by_username("admin").await.unwrap().unwrap();
        assert!(admin.is_admin);
        let cookie = res.headers().get("set-cookie").unwrap().to_str().unwrap().to_string();
        let token = cookie.strip_prefix("dbx_session=").unwrap().split(';').next().unwrap();
        let req = Request::builder().header("cookie", format!("dbx_session={token}")).body(Body::empty()).unwrap();
        let res = check(State(state.clone()), req).await;
        assert!(res.authenticated);
        assert!(res.is_admin);

        // Second setup attempt is forbidden.
        let err = setup(
            State(state.clone()),
            Json(SetupRequest { username: "other".to_string(), password: "secret".to_string() }),
        )
        .await
        .unwrap_err();
        assert_eq!(err, StatusCode::FORBIDDEN);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn setup_is_atomic_under_concurrency() {
        let (state, dir) = test_state().await;

        // Concurrent first-run setups must create exactly one account.
        let mut tasks = Vec::new();
        for index in 0..8 {
            let state = state.clone();
            tasks.push(tokio::spawn(async move {
                setup(
                    State(state),
                    Json(SetupRequest { username: format!("user-{index}"), password: "secret-password".to_string() }),
                )
                .await
            }));
        }
        let mut ok = 0;
        let mut forbidden = 0;
        for task in tasks {
            match task.await.unwrap() {
                Ok(res) => {
                    assert_eq!(res.status(), StatusCode::OK);
                    ok += 1;
                }
                Err(status) => {
                    assert_eq!(status, StatusCode::FORBIDDEN);
                    forbidden += 1;
                }
            }
        }
        assert_eq!(ok, 1);
        assert_eq!(forbidden, 7);
        assert_eq!(state.app.storage.count_users().await.unwrap(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn login_with_username_and_password_only_default() {
        let (state, dir) = test_state().await;
        add_user(&state, "admin", "secret", true).await;
        add_user(&state, "alice", "wonderland", false).await;
        *state.has_db_users.write().await = true;

        // Wrong password is rejected.
        let err = login(State(state.clone()), ClientIp(None), login_body(Some("alice"), "wrong")).await.unwrap_err();
        assert_eq!(err, StatusCode::UNAUTHORIZED);

        // Unknown user is rejected.
        let err = login(State(state.clone()), ClientIp(None), login_body(Some("nobody"), "secret")).await.unwrap_err();
        assert_eq!(err, StatusCode::UNAUTHORIZED);

        // Password-only login maps to the default "admin" account.
        let token = login_token(&state, None, "secret").await;
        assert_eq!(state.sessions.read().await.get(&token).map(|info| info.username.as_str()), Some("admin"));

        // Named user login works.
        let token = login_token(&state, Some("alice"), "wonderland").await;
        assert_eq!(state.sessions.read().await.get(&token).map(|info| info.username.as_str()), Some("alice"));

        // check reports the session's username and admin flag.
        let req = Request::builder().header("cookie", format!("dbx_session={token}")).body(Body::empty()).unwrap();
        let res = check(State(state.clone()), req).await;
        assert!(res.authenticated);
        assert_eq!(res.username.as_deref(), Some("alice"));
        assert!(!res.is_admin);

        let admin_token = login_token(&state, None, "secret").await;
        let req =
            Request::builder().header("cookie", format!("dbx_session={admin_token}")).body(Body::empty()).unwrap();
        let res = check(State(state.clone()), req).await;
        assert!(res.is_admin);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn change_password_updates_db_user() {
        let (state, dir) = test_state().await;
        add_user(&state, "admin", "old-password", true).await;
        *state.has_db_users.write().await = true;
        let token = login_token(&state, None, "old-password").await;

        let body =
            serde_json::to_string(&serde_json::json!({"old_password": "old-password", "new_password": "new-password"}))
                .unwrap();
        let req = Request::builder().header("cookie", format!("dbx_session={token}")).body(Body::from(body)).unwrap();
        let res = change_password(State(state.clone()), req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        // Old password no longer works, new one does.
        assert!(login(State(state.clone()), ClientIp(None), login_body(None, "old-password")).await.is_err());
        login_token(&state, None, "new-password").await;

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn change_password_revokes_other_sessions() {
        let (state, dir) = test_state().await;
        add_user(&state, "admin", "old-password", true).await;
        *state.has_db_users.write().await = true;
        let current = login_token(&state, None, "old-password").await;
        let other = login_token(&state, None, "old-password").await;

        let body =
            serde_json::to_string(&serde_json::json!({"old_password": "old-password", "new_password": "new-password"}))
                .unwrap();
        let req = Request::builder().header("cookie", format!("dbx_session={current}")).body(Body::from(body)).unwrap();
        let res = change_password(State(state.clone()), req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        // The acting session stays signed in; every other session of the
        // account is revoked.
        assert!(state.sessions.read().await.contains_key(&current));
        assert!(!state.sessions.read().await.contains_key(&other));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn env_bootstrap_user_login_and_change_password_rejected() {
        let (state, dir) = test_state().await;
        let mut bootstrap = state.bootstrap_users.clone();
        bootstrap.insert("hostadmin".to_string(), hash_password("envpw").unwrap());
        // Rebuild state with bootstrap users (for_tests creates an empty map).
        let state = {
            let mut s = WebState::for_tests(state.app.clone(), dir.clone());
            s.bootstrap_users = bootstrap;
            Arc::new(s)
        };

        let token = login_token(&state, Some("hostadmin"), "envpw").await;
        assert_eq!(state.sessions.read().await.get(&token).map(|info| info.username.as_str()), Some("hostadmin"));

        // Env accounts cannot change their password through the API.
        let body =
            serde_json::to_string(&serde_json::json!({"old_password": "envpw", "new_password": "new-password-1"}))
                .unwrap();
        let req = Request::builder().header("cookie", format!("dbx_session={token}")).body(Body::from(body)).unwrap();
        let res = change_password(State(state.clone()), req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn env_bootstrap_user_login_is_case_insensitive() {
        let (state, dir) = test_state().await;
        let state = {
            let mut s = WebState::for_tests(state.app.clone(), dir.clone());
            s.bootstrap_users.insert("HostAdmin".to_string(), hash_password("envpw").unwrap());
            Arc::new(s)
        };

        // Logging in with a different casing works, like DB-backed accounts.
        let token = login_token(&state, Some("hostadmin"), "envpw").await;
        assert_eq!(state.sessions.read().await.get(&token).map(|info| info.username.as_str()), Some("hostadmin"));

        // The account is still recognized as env-managed: password changes are rejected.
        let body =
            serde_json::to_string(&serde_json::json!({"old_password": "envpw", "new_password": "new-password-1"}))
                .unwrap();
        let req = Request::builder().header("cookie", format!("dbx_session={token}")).body(Body::from(body)).unwrap();
        let res = change_password(State(state.clone()), req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn delete_user_drops_sessions_regardless_of_login_casing() {
        let (state, dir) = test_state().await;
        add_user(&state, "admin", "secret", true).await;
        add_user(&state, "alice", "wonderland", false).await;
        *state.has_db_users.write().await = true;
        let admin_token = login_token(&state, None, "secret").await;

        // Alice logged in with different casing than her stored username.
        let alice_token = login_token(&state, Some("ALICE"), "wonderland").await;

        let users = state.app.storage.list_users().await.unwrap();
        let alice_id = users.iter().find(|u| u.username == "alice").unwrap().id;
        let req =
            Request::builder().header("cookie", format!("dbx_session={admin_token}")).body(Body::empty()).unwrap();
        let res = delete_user(State(state.clone()), Path(alice_id), req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(!state.sessions.read().await.contains_key(&alice_token));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn create_and_delete_user_guards() {
        let (state, dir) = test_state().await;
        add_user(&state, "admin", "secret", true).await;
        *state.has_db_users.write().await = true;
        let admin_token = login_token(&state, None, "secret").await;

        // Duplicate username is rejected (case-insensitive).
        let res = create_user(
            State(state.clone()),
            auth_headers(&admin_token),
            Json(CreateUserRequest {
                username: "ADMIN".to_string(),
                password: "duplicate-password".to_string(),
                is_admin: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT);

        let res = create_user(
            State(state.clone()),
            auth_headers(&admin_token),
            Json(CreateUserRequest {
                username: "bob".to_string(),
                password: "bob-password-1".to_string(),
                is_admin: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        // Admin-created accounts are non-admins.
        assert!(!state.app.storage.load_user_by_username("bob").await.unwrap().unwrap().is_admin);

        let users = state.app.storage.list_users().await.unwrap();
        let admin_id = users.iter().find(|u| u.username == "admin").unwrap().id;
        let bob_id = users.iter().find(|u| u.username == "bob").unwrap().id;

        // Deleting your own account is refused.
        let req =
            Request::builder().header("cookie", format!("dbx_session={admin_token}")).body(Body::empty()).unwrap();
        let res = delete_user(State(state.clone()), Path(admin_id), req).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        // Deleting another user works and drops their sessions.
        let bob_token = login_token(&state, Some("bob"), "bob-password-1").await;
        let req =
            Request::builder().header("cookie", format!("dbx_session={admin_token}")).body(Body::empty()).unwrap();
        let res = delete_user(State(state.clone()), Path(bob_id), req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(!state.sessions.read().await.contains_key(&bob_token));
        assert_eq!(state.app.storage.count_users().await.unwrap(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn middleware_protects_user_management_but_not_login() {
        use axum::routing::{get, post};
        use tower::ServiceExt;

        let (state, dir) = test_state().await;
        add_user(&state, "admin", "secret", true).await;
        *state.has_db_users.write().await = true;

        let app = axum::Router::new()
            .route("/api/auth/users", get(list_users))
            .route("/api/auth/login", post(login))
            .layer(axum::middleware::from_fn_with_state(state.clone(), auth_middleware))
            .with_state(state.clone());

        // User management requires a session.
        let res =
            app.clone().oneshot(Request::builder().uri("/api/auth/users").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        // Login stays reachable without a session.
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"admin","password":"secret"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let cookie = res.headers().get("set-cookie").unwrap().to_str().unwrap().to_string();
        let token = cookie.strip_prefix("dbx_session=").unwrap().split(';').next().unwrap();

        // With a session, user management is allowed.
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/auth/users")
                    .header("cookie", format!("dbx_session={token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn user_management_requires_admin() {
        let (state, dir) = test_state().await;
        let admin_id = add_user(&state, "admin", "secret", true).await;
        add_user(&state, "alice", "wonderland", false).await;
        *state.has_db_users.write().await = true;
        let alice_token = login_token(&state, Some("alice"), "wonderland").await;
        let admin_token = login_token(&state, None, "secret").await;

        // A signed-in non-admin is forbidden from every management endpoint.
        let err = list_users(State(state.clone()), auth_headers(&alice_token)).await.unwrap_err();
        assert_eq!(err, StatusCode::FORBIDDEN);

        let err = create_user(
            State(state.clone()),
            auth_headers(&alice_token),
            Json(CreateUserRequest { username: "mallory".to_string(), password: "pw".to_string(), is_admin: None }),
        )
        .await
        .unwrap_err();
        assert_eq!(err, StatusCode::FORBIDDEN);

        let req =
            Request::builder().header("cookie", format!("dbx_session={alice_token}")).body(Body::empty()).unwrap();
        let err = delete_user(State(state.clone()), Path(admin_id), req).await.unwrap_err();
        assert_eq!(err, StatusCode::FORBIDDEN);

        let err = reset_user_password(
            State(state.clone()),
            auth_headers(&alice_token),
            Path(admin_id),
            Json(ResetPasswordRequest { password: "hacked".to_string() }),
        )
        .await
        .unwrap_err();
        assert_eq!(err, StatusCode::FORBIDDEN);

        // No session at all is unauthorized.
        let err = list_users(State(state.clone()), HeaderMap::new()).await.unwrap_err();
        assert_eq!(err, StatusCode::UNAUTHORIZED);

        // The admin passes, and sees both accounts with their roles.
        let users = list_users(State(state.clone()), auth_headers(&admin_token)).await.unwrap().0;
        assert_eq!(users.len(), 2);
        assert!(users.iter().find(|u| u.username == "admin").unwrap().is_admin);
        assert!(!users.iter().find(|u| u.username == "alice").unwrap().is_admin);

        // Nothing changed: alice's attempts had no effect.
        assert_eq!(state.app.storage.count_users().await.unwrap(), 2);
        login_token(&state, None, "secret").await;

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn reset_user_password_requires_admin_and_revokes_sessions() {
        let (state, dir) = test_state().await;
        let admin_id = add_user(&state, "admin", "secret", true).await;
        let alice_id = add_user(&state, "alice", "wonderland", false).await;
        *state.has_db_users.write().await = true;

        // Cross-account reset by a signed-in non-admin is forbidden and the
        // target's password stays unchanged.
        let alice_token = login_token(&state, Some("alice"), "wonderland").await;
        let err = reset_user_password(
            State(state.clone()),
            auth_headers(&alice_token),
            Path(admin_id),
            Json(ResetPasswordRequest { password: "hacked".to_string() }),
        )
        .await
        .unwrap_err();
        assert_eq!(err, StatusCode::FORBIDDEN);
        assert!(login(State(state.clone()), ClientIp(None), login_body(None, "hacked")).await.is_err());
        login_token(&state, None, "secret").await;

        // An admin reset works, revokes the target's sessions, and keeps the
        // acting admin's own session alive.
        let admin_token = login_token(&state, None, "secret").await;
        let res = reset_user_password(
            State(state.clone()),
            auth_headers(&admin_token),
            Path(alice_id),
            Json(ResetPasswordRequest { password: "reset-pw".to_string() }),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(!state.sessions.read().await.contains_key(&alice_token));
        assert!(state.sessions.read().await.contains_key(&admin_token));
        assert!(login(State(state.clone()), ClientIp(None), login_body(Some("alice"), "wonderland")).await.is_err());
        login_token(&state, Some("alice"), "reset-pw").await;

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn delete_user_is_atomic_under_concurrency() {
        let (state, dir) = test_state().await;
        // An env-provisioned admin can delete any DB account (never itself).
        let state = {
            let mut s = WebState::for_tests(state.app.clone(), dir.clone());
            s.bootstrap_users.insert("hostadmin".to_string(), hash_password("envpw").unwrap());
            Arc::new(s)
        };
        let first_id = add_user(&state, "first", "pw", false).await;
        let second_id = add_user(&state, "second", "pw", false).await;
        *state.has_db_users.write().await = true;
        let token = login_token(&state, Some("hostadmin"), "envpw").await;

        // Concurrently deleting the last two accounts must keep exactly one.
        let mut tasks = Vec::new();
        for id in [first_id, second_id] {
            let state = state.clone();
            let token = token.clone();
            tasks.push(tokio::spawn(async move {
                let req =
                    Request::builder().header("cookie", format!("dbx_session={token}")).body(Body::empty()).unwrap();
                delete_user(State(state), Path(id), req).await.unwrap().status()
            }));
        }
        let mut ok = 0;
        let mut rejected = 0;
        for task in tasks {
            match task.await.unwrap() {
                StatusCode::OK => ok += 1,
                StatusCode::BAD_REQUEST => rejected += 1,
                status => panic!("unexpected status {status}"),
            }
        }
        assert_eq!(ok, 1);
        assert_eq!(rejected, 1);
        assert_eq!(state.app.storage.count_users().await.unwrap(), 1);
        assert!(*state.has_db_users.read().await);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn login_rate_limit_is_per_username() {
        let (state, dir) = test_state().await;
        add_user(&state, "admin", "secret", true).await;
        add_user(&state, "alice", "wonderland", false).await;
        *state.has_db_users.write().await = true;

        // Lock alice out with repeated failures.
        for _ in 0..5 {
            let err =
                login(State(state.clone()), ClientIp(None), login_body(Some("alice"), "wrong")).await.unwrap_err();
            assert_eq!(err, StatusCode::UNAUTHORIZED);
        }
        // Alice is now rate-limited, even with the right password.
        let res = login(State(state.clone()), ClientIp(None), login_body(Some("alice"), "wonderland")).await.unwrap();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);

        // Other accounts are unaffected by her lockout.
        login_token(&state, None, "secret").await;

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn session_cookie_secure_flag_is_deployer_opt_in() {
        let (state, dir) = test_state().await;
        add_user(&state, "admin", "secret", true).await;
        *state.has_db_users.write().await = true;

        // Default: no Secure attribute (plain-HTTP self-hosting keeps working).
        let res = login(State(state.clone()), ClientIp(None), login_body(None, "secret")).await.unwrap();
        let cookie = res.headers().get("set-cookie").unwrap().to_str().unwrap().to_string();
        assert!(!cookie.contains("Secure"));
        assert!(cookie.contains("SameSite=Lax"));

        // Opt-in: Secure is set on both the session and the clearing cookie.
        let state = {
            let mut s = WebState::for_tests(state.app.clone(), dir.clone());
            s.cookie_secure = true;
            Arc::new(s)
        };
        *state.has_db_users.write().await = true;
        let res = login(State(state.clone()), ClientIp(None), login_body(None, "secret")).await.unwrap();
        let cookie = res.headers().get("set-cookie").unwrap().to_str().unwrap().to_string();
        assert!(cookie.contains("; Secure"));

        let req = Request::builder().header("cookie", cookie).body(Body::empty()).unwrap();
        let res = logout(State(state.clone()), req).await;
        let cleared = res.headers().get("set-cookie").unwrap().to_str().unwrap().to_string();
        assert!(cleared.contains("; Secure"));
        assert!(cleared.contains("SameSite=Lax"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn sessions_expire_after_configured_idle_timeout() {
        let (state, dir) = test_state().await;
        let state = {
            let mut s = WebState::for_tests(state.app.clone(), dir.clone());
            s.session_idle_timeout = Some(std::time::Duration::from_millis(50));
            Arc::new(s)
        };
        add_user(&state, "admin", "secret", true).await;
        *state.has_db_users.write().await = true;
        let token = login_token(&state, None, "secret").await;

        // An active session authenticates and refreshes its activity timestamp.
        let before = state.sessions.read().await.get(&token).unwrap().last_active;
        let req = Request::builder().header("cookie", format!("dbx_session={token}")).body(Body::empty()).unwrap();
        let res = check(State(state.clone()), req).await;
        assert!(res.authenticated);
        assert!(state.sessions.read().await.get(&token).unwrap().last_active >= before);

        // Idle past the timeout: the session is dropped and no longer authenticates.
        state.sessions.write().await.get_mut(&token).unwrap().last_active =
            std::time::Instant::now() - std::time::Duration::from_secs(60);
        let req = Request::builder().header("cookie", format!("dbx_session={token}")).body(Body::empty()).unwrap();
        let res = check(State(state.clone()), req).await;
        assert!(!res.authenticated);
        assert!(!state.sessions.read().await.contains_key(&token));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn admin_can_create_admin_and_admins_can_delete_each_other() {
        let (state, dir) = test_state().await;
        add_user(&state, "admin", "secret", true).await;
        add_user(&state, "alice", "wonderland", false).await;
        *state.has_db_users.write().await = true;
        let admin_token = login_token(&state, None, "secret").await;

        // Admins may grant admin rights to new accounts.
        let res = create_user(
            State(state.clone()),
            auth_headers(&admin_token),
            Json(CreateUserRequest {
                username: "bob".to_string(),
                password: "bob-password-1".to_string(),
                is_admin: Some(true),
            }),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(state.app.storage.load_user_by_username("bob").await.unwrap().unwrap().is_admin);

        // The new admin can use the management endpoints.
        let bob_token = login_token(&state, Some("bob"), "bob-password-1").await;
        let users = list_users(State(state.clone()), auth_headers(&bob_token)).await.unwrap().0;
        assert_eq!(users.len(), 3);

        // With two admins present, one may delete the other.
        let users = state.app.storage.list_users().await.unwrap();
        let admin_id = users.iter().find(|u| u.username == "admin").unwrap().id;
        let req = Request::builder().header("cookie", format!("dbx_session={bob_token}")).body(Body::empty()).unwrap();
        let res = delete_user(State(state.clone()), Path(admin_id), req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn change_password_requires_session_and_own_account() {
        let (state, dir) = test_state().await;
        add_user(&state, "admin", "admin-password", true).await;
        add_user(&state, "alice", "alice-password", false).await;
        *state.has_db_users.write().await = true;
        let alice_token = login_token(&state, Some("alice"), "alice-password").await;

        // No session at all: unauthorized (defense in depth below the middleware).
        let body = serde_json::to_string(
            &serde_json::json!({"old_password": "alice-password", "new_password": "new-password-1"}),
        )
        .unwrap();
        let req = Request::builder().body(Body::from(body)).unwrap();
        let err = change_password(State(state.clone()), req).await.unwrap_err();
        assert_eq!(err, StatusCode::UNAUTHORIZED);

        // Another account may not be targeted, even with its old password known.
        let body = serde_json::to_string(
            &serde_json::json!({"username": "admin", "old_password": "admin-password", "new_password": "hacked-123"}),
        )
        .unwrap();
        let req =
            Request::builder().header("cookie", format!("dbx_session={alice_token}")).body(Body::from(body)).unwrap();
        let err = change_password(State(state.clone()), req).await.unwrap_err();
        assert_eq!(err, StatusCode::FORBIDDEN);
        // Untouched: the admin's password still works.
        login_token(&state, None, "admin-password").await;

        // Self-service with the username spelled in a different casing works.
        let body =
            serde_json::to_string(&serde_json::json!({"username": "ALICE", "old_password": "alice-password", "new_password": "new-password-1"}))
                .unwrap();
        let req =
            Request::builder().header("cookie", format!("dbx_session={alice_token}")).body(Body::from(body)).unwrap();
        let res = change_password(State(state.clone()), req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        login_token(&state, Some("alice"), "new-password-1").await;

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn change_password_failures_share_the_login_lockout() {
        let (state, dir) = test_state().await;
        add_user(&state, "admin", "admin-password", true).await;
        *state.has_db_users.write().await = true;
        let token = login_token(&state, None, "admin-password").await;

        // Five wrong old passwords trip the same lockout as failed logins.
        for _ in 0..5 {
            let body =
                serde_json::to_string(&serde_json::json!({"old_password": "wrong", "new_password": "new-password-1"}))
                    .unwrap();
            let req =
                Request::builder().header("cookie", format!("dbx_session={token}")).body(Body::from(body)).unwrap();
            let err = change_password(State(state.clone()), req).await.unwrap_err();
            assert_eq!(err, StatusCode::UNAUTHORIZED);
        }
        // Even the correct old password is rate-limited now ...
        let body = serde_json::to_string(
            &serde_json::json!({"old_password": "admin-password", "new_password": "new-password-1"}),
        )
        .unwrap();
        let req = Request::builder().header("cookie", format!("dbx_session={token}")).body(Body::from(body)).unwrap();
        let res = change_password(State(state.clone()), req).await.unwrap();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        // ... and login for the same account from the same address is locked too
        // (unit-level calls share the "unknown" source-IP bucket).
        let res = login(State(state.clone()), ClientIp(None), login_body(None, "admin-password")).await.unwrap();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn login_lockout_is_scoped_to_source_ip() {
        let (state, dir) = test_state().await;
        add_user(&state, "admin", "admin-password", true).await;
        *state.has_db_users.write().await = true;
        let attacker: std::net::SocketAddr = "203.0.113.1:10000".parse().unwrap();
        let admin_ip: std::net::SocketAddr = "192.0.2.5:20000".parse().unwrap();

        // The attacker locks out "admin" from their own address only.
        for _ in 0..5 {
            let err = login(State(state.clone()), ClientIp(Some(attacker.ip())), login_body(None, "wrong"))
                .await
                .unwrap_err();
            assert_eq!(err, StatusCode::UNAUTHORIZED);
        }
        let res = login(State(state.clone()), ClientIp(Some(attacker.ip())), login_body(None, "admin-password"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);

        // The same account stays reachable from the admin's own address.
        let res = login(State(state.clone()), ClientIp(Some(admin_ip.ip())), login_body(None, "admin-password"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn login_unknown_user_fails_like_a_wrong_password() {
        let (state, dir) = test_state().await;
        add_user(&state, "admin", "admin-password", true).await;
        *state.has_db_users.write().await = true;

        // Unknown account: the same 401 as a wrong password, and repeated
        // attempts lock the sprayed name too — a 429 never confirms existence.
        let err = login(State(state.clone()), ClientIp(None), login_body(Some("ghost"), "whatever")).await.unwrap_err();
        assert_eq!(err, StatusCode::UNAUTHORIZED);
        for _ in 0..4 {
            login(State(state.clone()), ClientIp(None), login_body(Some("ghost"), "whatever")).await.unwrap_err();
        }
        let res = login(State(state.clone()), ClientIp(None), login_body(Some("ghost"), "whatever")).await.unwrap();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn list_users_hides_db_rows_shadowed_by_env_accounts() {
        let (state, dir) = test_state().await;
        let state = {
            let mut s = WebState::for_tests(state.app.clone(), dir.clone());
            s.bootstrap_users.insert("HostAdmin".to_string(), hash_password("env-password").unwrap());
            Arc::new(s)
        };
        // A DB row with the same name (different casing) predates the env account.
        add_user(&state, "hostadmin", "db-password", true).await;
        add_user(&state, "alice", "alice-password", false).await;
        *state.has_db_users.write().await = true;
        let token = login_token(&state, Some("hostadmin"), "env-password").await;

        let users = list_users(State(state.clone()), auth_headers(&token)).await.unwrap().0;
        // Only the env entry shows for this username; the shadowed DB row is hidden.
        assert_eq!(users.len(), 2);
        let env_entry = users.iter().find(|u| u.username == "HostAdmin").unwrap();
        assert!(env_entry.managed_by_env);
        assert!(env_entry.is_admin);
        assert!(users.iter().any(|u| u.username == "alice"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn password_policy_requires_a_minimum_length() {
        let (state, dir) = test_state().await;

        // First-run setup rejects short passwords.
        let res = setup(
            State(state.clone()),
            Json(SetupRequest { username: "admin".to_string(), password: "short".to_string() }),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        let res = setup(
            State(state.clone()),
            Json(SetupRequest { username: "admin".to_string(), password: "admin-password".to_string() }),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let admin_token = login_token(&state, None, "admin-password").await;

        // Admin user creation rejects short passwords.
        let res = create_user(
            State(state.clone()),
            auth_headers(&admin_token),
            Json(CreateUserRequest { username: "bob".to_string(), password: "short".to_string(), is_admin: None }),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        let res = create_user(
            State(state.clone()),
            auth_headers(&admin_token),
            Json(CreateUserRequest {
                username: "bob".to_string(),
                password: "bob-password-1".to_string(),
                is_admin: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bob_id = state.app.storage.list_users().await.unwrap().iter().find(|u| u.username == "bob").unwrap().id;

        // Admin resets reject short passwords.
        let res = reset_user_password(
            State(state.clone()),
            auth_headers(&admin_token),
            Path(bob_id),
            Json(ResetPasswordRequest { password: "short".to_string() }),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        // Self-service changes reject short new passwords.
        let body =
            serde_json::to_string(&serde_json::json!({"old_password": "admin-password", "new_password": "short"}))
                .unwrap();
        let req =
            Request::builder().header("cookie", format!("dbx_session={admin_token}")).body(Body::from(body)).unwrap();
        let res = change_password(State(state.clone()), req).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn sweep_expired_sessions_removes_only_idle_expired_sessions() {
        let (state, dir) = test_state().await;
        let state = {
            let mut s = WebState::for_tests(state.app.clone(), dir.clone());
            s.session_idle_timeout = Some(std::time::Duration::from_secs(60));
            Arc::new(s)
        };
        add_user(&state, "admin", "admin-password", true).await;
        *state.has_db_users.write().await = true;
        let active = login_token(&state, None, "admin-password").await;
        let idle = login_token(&state, None, "admin-password").await;
        state.sessions.write().await.get_mut(&idle).unwrap().last_active =
            std::time::Instant::now() - std::time::Duration::from_secs(120);

        sweep_expired_sessions(&state).await;
        assert!(state.sessions.read().await.contains_key(&active));
        assert!(!state.sessions.read().await.contains_key(&idle));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn touch_session_refreshes_but_never_resurrects() {
        let (state, dir) = test_state().await;
        add_user(&state, "admin", "admin-password", true).await;
        *state.has_db_users.write().await = true;
        let token = login_token(&state, None, "admin-password").await;
        state.sessions.write().await.get_mut(&token).unwrap().last_active =
            std::time::Instant::now() - std::time::Duration::from_secs(120);

        assert!(touch_session(&state, &token).await);
        let last_active = state.sessions.read().await.get(&token).unwrap().last_active;
        assert!(last_active.elapsed() < std::time::Duration::from_secs(5));

        assert!(!touch_session(&state, "no-such-token").await);
        assert!(!state.sessions.read().await.contains_key("no-such-token"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn open_sse_stream_keeps_session_active() {
        use axum::response::sse::{Event, Sse};
        use axum::routing::get;
        use tower::ServiceExt;

        let (state, dir) = test_state().await;
        let state = {
            let mut s = WebState::for_tests(state.app.clone(), dir.clone());
            s.session_idle_timeout = Some(std::time::Duration::from_millis(100));
            Arc::new(s)
        };
        add_user(&state, "admin", "admin-password", true).await;
        *state.has_db_users.write().await = true;
        let token = login_token(&state, None, "admin-password").await;

        let app = axum::Router::new()
            .route(
                "/api/stream",
                get(|| async { Sse::new(futures::stream::pending::<Result<Event, std::convert::Infallible>>()) }),
            )
            .layer(axum::middleware::from_fn_with_state(state.clone(), auth_middleware))
            .with_state(state.clone());

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/stream")
                    .header("cookie", format!("dbx_session={token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(res.headers().get("content-type").unwrap().to_str().unwrap().starts_with("text/event-stream"));

        // While the stream response is held open, the idle window lapses
        // several times without the session expiring.
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        let last_active = state.sessions.read().await.get(&token).unwrap().last_active;
        assert!(last_active.elapsed() < std::time::Duration::from_millis(300));

        // Closing the stream stops the keep-alive: no further refreshes land.
        drop(res);
        let last_active = state.sessions.read().await.get(&token).unwrap().last_active;
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        assert_eq!(state.sessions.read().await.get(&token).unwrap().last_active, last_active);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rate_limit_key_folds_ascii_only_like_account_matching() {
        // ASCII case variants of one account share a bucket ...
        assert_eq!(rate_limit_key("ADMIN", None), rate_limit_key("admin", None));
        // ... while distinct non-ASCII usernames never do (account matching is
        // ASCII-only too: UNIQUE ... COLLATE NOCASE / eq_ignore_ascii_case).
        assert_ne!(rate_limit_key("ÄDMIN", None), rate_limit_key("ädmin", None));
        // The source address separates buckets.
        let ip: std::net::IpAddr = "203.0.113.1".parse().unwrap();
        assert_ne!(rate_limit_key("admin", Some(ip)), rate_limit_key("admin", None));
    }

    #[tokio::test]
    async fn session_keep_alive_from_headers_refreshes_while_held() {
        let (state, dir) = test_state().await;
        let state = {
            let mut s = WebState::for_tests(state.app.clone(), dir.clone());
            s.session_idle_timeout = Some(std::time::Duration::from_millis(100));
            Arc::new(s)
        };
        add_user(&state, "admin", "admin-password", true).await;
        *state.has_db_users.write().await = true;
        let token = login_token(&state, None, "admin-password").await;

        // No session cookie, no guard.
        assert!(session_keep_alive_from_headers(&state, &HeaderMap::new()).is_none());

        let guard = session_keep_alive_from_headers(&state, &auth_headers(&token)).expect("keep-alive guard");
        state.sessions.write().await.get_mut(&token).unwrap().last_active =
            std::time::Instant::now() - std::time::Duration::from_secs(120);
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let last_active = state.sessions.read().await.get(&token).unwrap().last_active;
        assert!(last_active.elapsed() < std::time::Duration::from_secs(1));

        // Dropping the guard (connection closed) stops refreshing.
        drop(guard);
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let last_active = state.sessions.read().await.get(&token).unwrap().last_active;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(state.sessions.read().await.get(&token).unwrap().last_active, last_active);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn rate_limit_map_stays_bounded_under_lockout_spray() {
        let (state, dir) = test_state().await;

        // Fill the map with actively-locked entries.
        {
            let mut limits = state.login_rate_limit.lock().await;
            for index in 0..4096 {
                limits.insert(
                    format!("user-{index}|unknown"),
                    crate::state::LoginRateLimit {
                        fail_count: 0,
                        locked_until: Some(std::time::Instant::now() + std::time::Duration::from_secs(60)),
                    },
                );
            }
        }

        // A failure for a brand-new key is not tracked beyond the cap.
        record_auth_failure(&state, "sprayed|unknown").await;
        let limits = state.login_rate_limit.lock().await;
        assert_eq!(limits.len(), 4096);
        assert!(!limits.contains_key("sprayed|unknown"));

        std::fs::remove_dir_all(&dir).ok();
    }
}
