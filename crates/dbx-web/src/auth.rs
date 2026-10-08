//! Web 多用户认证端点与鉴权中间件。
//!
//! 数据层见 `dbx-core` 的 `persistence::access_control`（users / roles /
//! departments / user_roles / login_blacklist 表）。本模块职责：
//!
//! - `/api/auth/login`：`(username, ip)` 限流（5 次失败锁 60 秒）+ Argon2 校验
//!   + 会话签发；用户名小写规范化后精确匹配。
//! - `/api/auth/setup`：仅当用户表为空时创建首个管理员，否则 409。
//! - `/api/auth/check`：完整认证状态（用户、权限、密码有效期）。
//! - `/api/auth/change-password`：基于当前会话用户修改自己的密码。
//! - [`auth_middleware`]：会话校验 + 用户禁用/拉黑销毁 + `must_change_password`
//!   门 + request_context 注入。
//!
//! `DBX_DISABLE_PASSWORD=1`（`password_disabled`）时全部请求放行（无用户体系）；
//! 用户表为空且未禁用时非 auth API 返回 `403 setup_required`（迁移向导豁免
//! 端点除外，复用 `migration_gate` 的豁免清单）。

use std::net::SocketAddr;
use std::sync::Arc;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use dbx_core::persistence::access_control::{
    is_password_expired, normalize_username, password_expires_in_days, EffectivePermissions, UserRecord,
    ALL_PERMISSIONS,
};
use serde::{Deserialize, Serialize};

use crate::blacklist::client_ip;
use crate::request_context::{with_request_user, RequestUser};
use crate::state::{LoginRateLimitEntry, UserSession, WebState};

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct SetupRequest {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub old_password: String,
    pub new_password: String,
}

/// `/api/auth/check` 与 `/api/auth/login`（成功）共用的完整认证状态形状。
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct AuthCheckResponse {
    pub authenticated: bool,
    pub required: bool,
    pub setup_required: bool,
    pub user: Option<AuthUser>,
    pub permissions: Vec<String>,
    pub must_change_password: bool,
    pub password_expires_in_days: Option<i64>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct AuthUser {
    pub username: String,
    pub display_name: Option<String>,
    pub is_admin: bool,
    pub department_name: Option<String>,
    pub roles: Vec<String>,
}

const MAX_ATTEMPTS: u32 = 5;
const LOCKOUT_SECS: u64 = 60;
/// 新密码最短长度（setup 与 change-password 共用校验）。
const MIN_PASSWORD_LEN: usize = 6;

fn session_cookie_path(state: &WebState) -> &str {
    state.public_base_path.as_str()
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

/// `migration_gate` 豁免的非 auth 端点（数据安全迁移向导在用户体系之前可用）。
///
/// `auth/` 前缀由调用方单独判断。
pub(crate) fn migration_gate_exempt_path(suffix: &str) -> bool {
    matches!(suffix, "migration/status" | "migration/start" | "migration/retry" | "migration/cleanup-backups" | "ping")
}

fn error_response(status: StatusCode, code: &str) -> Response {
    (status, Json(serde_json::json!({"error": code}))).into_response()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}

pub(crate) fn hash_password(password: &str) -> Result<String, StatusCode> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
}

fn weak_password(password: &str) -> bool {
    password.chars().count() < MIN_PASSWORD_LEN
}

/// 限流 key：`username|ip`。
fn rate_limit_key(username: &str, ip: &str) -> String {
    format!("{username}|{ip}")
}

/// 检查并清理限流条目，返回该组合当前的锁定剩余秒数（0 表示未锁定）。
async fn rate_limit_remaining(state: &WebState, key: &str) -> u64 {
    let mut limits = state.login_rate_limit.lock().await;
    let now = std::time::Instant::now();
    // 只清理已过期的锁定条目（条目删除即重置计数）；未锁定的计数条目必须
    // 保留，否则失败次数永远累积不到阈值。
    limits.retain(|_, entry| match entry.locked_until {
        Some(until) => until > now,
        None => true,
    });
    match limits.get(key) {
        Some(entry) => match entry.locked_until {
            Some(until) if until > now => (until - now).as_secs().max(1),
            _ => 0,
        },
        None => 0,
    }
}

/// 记录一次登录失败；达到阈值时锁定该组合 60 秒。
async fn record_login_failure(state: &WebState, key: &str) {
    let mut limits = state.login_rate_limit.lock().await;
    let entry = limits.entry(key.to_string()).or_insert_with(LoginRateLimitEntry::fresh);
    entry.fail_count += 1;
    if entry.fail_count >= MAX_ATTEMPTS {
        entry.locked_until = Some(std::time::Instant::now() + std::time::Duration::from_secs(LOCKOUT_SECS));
        entry.fail_count = 0;
    }
}

/// 登录成功后清除该组合的失败计数。
async fn clear_login_failures(state: &WebState, key: &str) {
    state.login_rate_limit.lock().await.remove(key);
}

/// 会话签发：返回会话 token。
async fn create_session(state: &WebState, user: &UserRecord) -> String {
    let token = uuid::Uuid::new_v4().to_string();
    state.sessions.write().await.insert(
        token.clone(),
        UserSession { user_id: user.id, username: user.username.clone(), created_at: now_secs() as u64 },
    );
    token
}

fn session_cookie(token: &str, state: &WebState) -> String {
    format!("dbx_session={token}; Path={}; HttpOnly; SameSite=Lax", session_cookie_path(state))
}

/// 附加 Set-Cookie 后返回响应。
fn with_session_cookie(mut response: Response, token: &str, state: &WebState) -> Result<Response, StatusCode> {
    let cookie = session_cookie(token, state);
    let header_value = cookie.parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    response.headers_mut().insert("set-cookie", header_value);
    Ok(response)
}

/// `DBX_DISABLE_PASSWORD=1` 时的认证状态（无用户体系，恒为已认证）。
fn disabled_check_shape() -> AuthCheckResponse {
    AuthCheckResponse {
        authenticated: true,
        required: false,
        setup_required: false,
        user: None,
        permissions: Vec::new(),
        must_change_password: false,
        password_expires_in_days: None,
    }
}

/// 未认证时的认证状态。
async fn unauthenticated_shape(state: &WebState) -> AuthCheckResponse {
    AuthCheckResponse {
        authenticated: false,
        required: true,
        setup_required: is_setup_required(state).await,
        user: None,
        permissions: Vec::new(),
        must_change_password: false,
        password_expires_in_days: None,
    }
}

/// 已认证用户的完整认证状态（check 与 login 成功共用）。
async fn user_check_shape(state: &WebState, user: &UserRecord) -> AuthCheckResponse {
    let now = now_secs();
    let effective = state.effective_permissions(user).await.unwrap_or_default();
    AuthCheckResponse {
        authenticated: true,
        required: true,
        setup_required: false,
        user: Some(AuthUser {
            username: user.username.clone(),
            display_name: user.display_name.clone(),
            is_admin: user.is_admin,
            department_name: state.app.storage.department_name_by_id(user.department_id).await.ok().flatten(),
            roles: state.app.storage.role_names_of_user(user.id).await.unwrap_or_default(),
        }),
        permissions: permission_keys(user, &effective),
        must_change_password: user.must_change_password || is_password_expired(user.password_updated_at, now),
        password_expires_in_days: Some(password_expires_in_days(user.password_updated_at, now)),
    }
}

/// 权限 key 列表：管理员为 [`ALL_PERMISSIONS`] 全集，普通用户为角色并集
/// （排序去重，输出稳定）。
fn permission_keys(user: &UserRecord, effective: &EffectivePermissions) -> Vec<String> {
    if user.is_admin {
        return ALL_PERMISSIONS.iter().map(|key| key.to_string()).collect();
    }
    let mut keys: Vec<String> = effective.permissions.iter().cloned().collect();
    keys.sort();
    keys.dedup();
    keys
}

/// setup_required 判定：用户表为空。
///
/// 与 [`auth_middleware`] 的 setup 门（[`user_system_uninitialized`]）同判据：
/// 启动引导在监听前消费 `DBX_PASSWORD` env 与旧共享口令哈希（有任一来源
/// 即创建 admin，用户表非空），因此运行中"表空"必然意味着无任何可引导
/// 来源；此处不再读取进程 env（避免 check 行为随环境漂移、与中间件门
/// 不一致）。
async fn is_setup_required(state: &WebState) -> bool {
    if state.user_system_ready() {
        return false;
    }
    state.app.storage.count_users().await.unwrap_or(0) == 0
}

/// 用户表是否为空（`user_system_ready` 为 false 时查库兜底并回填标志）。
async fn user_system_uninitialized(state: &WebState) -> bool {
    if state.user_system_ready() {
        return false;
    }
    let count = state.app.storage.count_users().await.unwrap_or(0);
    if count > 0 {
        state.set_user_system_ready(true);
        return false;
    }
    true
}

pub async fn login(
    State(state): State<Arc<WebState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LoginRequest>,
) -> Result<Response, StatusCode> {
    if state.password_disabled {
        // 保持旧行为：禁用模式下登录无意义，直接回 200 的禁用状态形状。
        return Ok((StatusCode::OK, Json(disabled_check_shape())).into_response());
    }

    let username = body.username.trim().to_lowercase();
    let ip = client_ip(&headers, &addr, state.trust_proxy);
    let key = rate_limit_key(&username, &ip);

    if rate_limit_remaining(&state, &key).await > 0 {
        return Ok(error_response(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }

    if state.blacklist.is_user_blacklisted(&username) {
        return Ok(error_response(StatusCode::FORBIDDEN, "blacklisted"));
    }

    let user =
        state.app.storage.get_user_by_username(&username).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(user) = user else {
        record_login_failure(&state, &key).await;
        return Ok(error_response(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    };

    if !user.status {
        return Ok(error_response(StatusCode::UNAUTHORIZED, "user_disabled"));
    }

    if !verify_password(&body.password, &user.password_hash) {
        record_login_failure(&state, &key).await;
        return Ok(error_response(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }

    clear_login_failures(&state, &key).await;
    state.set_user_system_ready(true);

    let token = create_session(&state, &user).await;
    // 预热有效权限缓存（check 与后续 middleware 直接命中）。
    let _ = state.effective_permissions(&user).await;
    let response = Json(user_check_shape(&state, &user).await).into_response();
    with_session_cookie(response, &token, &state)
}

pub async fn setup(State(state): State<Arc<WebState>>, Json(body): Json<SetupRequest>) -> Result<Response, StatusCode> {
    if state.password_disabled {
        return Ok(error_response(StatusCode::FORBIDDEN, "user_system_disabled"));
    }
    if !user_system_uninitialized(&state).await {
        return Ok(error_response(StatusCode::CONFLICT, "already_initialized"));
    }

    let username = normalize_username(&body.username).map_err(|_| StatusCode::BAD_REQUEST)?;
    if weak_password(&body.password) {
        return Ok(error_response(StatusCode::BAD_REQUEST, "weak_password"));
    }

    let hash = hash_password(&body.password)?;
    let user_id = state
        .app
        .storage
        .create_user(&username, &hash, None, None, true)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    state.set_user_system_ready(true);

    // MCP 启用条件与旧"设置密码后启用"行为对齐（仅本实例认证已就绪时）。
    if state.migration_ready.load(std::sync::atomic::Ordering::Acquire) {
        if let Err(error) = state.web_mcp.reload(&state.app.storage, true).await {
            log::error!("Web MCP remained disabled after first admin setup: {error}");
        }
    }

    let user = state
        .app
        .storage
        .get_user_by_id(user_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    // 与旧 setup 一致：同步内存哈希，使"密码保护已启用"类判定立即生效。
    *state.password_hash.write().await = Some(user.password_hash.clone());

    let token = create_session(&state, &user).await;
    let response = Json(user_check_shape(&state, &user).await).into_response();
    with_session_cookie(response, &token, &state)
}

pub async fn check(State(state): State<Arc<WebState>>, headers: HeaderMap) -> Json<AuthCheckResponse> {
    Json(auth_check_shape(&state, &headers).await)
}

/// check 端点的核心逻辑：会话 token -> 用户 -> 完整状态；任一环节失败均回退
/// 到未认证形状。
async fn auth_check_shape(state: &WebState, headers: &HeaderMap) -> AuthCheckResponse {
    if state.password_disabled {
        return disabled_check_shape();
    }
    // 会话读锁不能跨 await（tokio RwLockReadGuard !Send），先克隆再释放。
    let session = match session_token_from_headers(headers) {
        Some(token) => state.sessions.read().await.get(&token).cloned(),
        None => None,
    };
    if let Some(session) = session {
        if let Ok(Some(user)) = state.app.storage.get_user_by_id(session.user_id).await {
            return user_check_shape(state, &user).await;
        }
    }
    unauthenticated_shape(state).await
}

pub async fn change_password(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<Response, StatusCode> {
    let token = session_token_from_headers(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let session = {
        let guard = state.sessions.read().await;
        let session = guard.get(&token).cloned();
        session
    };
    let Some(session) = session else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let user = state
        .app
        .storage
        .get_user_by_id(session.user_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    if weak_password(&body.new_password) {
        return Ok(error_response(StatusCode::BAD_REQUEST, "weak_password"));
    }
    if !verify_password(&body.old_password, &user.password_hash) {
        return Ok(error_response(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }
    let new_hash = hash_password(&body.new_password)?;
    state
        .app
        .storage
        .set_user_password(user.id, &new_hash, false)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // 同步内存哈希（admin 场景下与旧共享口令判定路径保持一致）。
    *state.password_hash.write().await = Some(new_hash);

    Ok((StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response())
}

pub async fn logout(State(state): State<Arc<WebState>>, req: Request<axum::body::Body>) -> Response {
    if let Some(token) = extract_session_token(&req) {
        state.sessions.write().await.remove(&token);
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

/// 销毁会话：移除 session 与该 owner 的临时凭据。
async fn destroy_session(state: &WebState, token: &str) {
    state.sessions.write().await.remove(token);
    state.app.session_credentials.clear_owner(token);
}

pub async fn auth_middleware(
    State(state): State<Arc<WebState>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    // Auth endpoints are always accessible.
    let api_suffix = middleware_api_path_suffix(req.uri().path(), &state.public_base_path);
    if api_suffix.is_some_and(|suffix| suffix.starts_with("auth/")) {
        return next.run(req).await;
    }

    // Non-API requests (static files) are always accessible.
    let Some(suffix) = api_suffix else {
        return next.run(req).await;
    };

    // DBX_DISABLE_PASSWORD=1：全放行（保持旧行为）；/api/admin/* 的
    // 403 user_system_disabled 由 T5 管理路由挂载时通过
    // WebState::admin_gating_response 判定，不在此处拦截。
    if state.password_disabled {
        return next.run(req).await;
    }

    // 用户表为空且未禁用：迁移向导豁免端点直接放行（此时不可能存在有效
    // 会话，不能再落入 token 校验），其余 API 一律进入 setup 流程。
    if user_system_uninitialized(&state).await {
        if migration_gate_exempt_path(suffix) {
            return next.run(req).await;
        }
        return error_response(StatusCode::FORBIDDEN, "setup_required");
    }

    // Check session token.
    let Some(token) = extract_session_token(&req) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(session) = state.sessions.read().await.get(&token).cloned() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let user = match state.app.storage.get_user_by_id(session.user_id).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            // 用户已被删除：销毁会话并按未认证处理。
            destroy_session(&state, &token).await;
            return StatusCode::UNAUTHORIZED.into_response();
        }
        Err(error) => {
            log::error!("auth middleware failed to load user {}: {error}", session.user_id);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    // 禁用用户或用户被拉黑：销毁会话。
    if !user.status || state.blacklist.is_user_blacklisted(&user.username) {
        destroy_session(&state, &token).await;
        return StatusCode::UNAUTHORIZED.into_response();
    }

    // must_change_password（含密码 90 天过期）：auth 端点已在上方放行，
    // 到达此处的一律是业务 API。
    if user.must_change_password || is_password_expired(user.password_updated_at, now_secs()) {
        return error_response(StatusCode::FORBIDDEN, "password_change_required");
    }

    let effective = match state.effective_permissions(&user).await {
        Ok(effective) => effective,
        Err(error) => {
            log::error!("auth middleware failed to compute permissions for {}: {error}", user.username);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let request_user = RequestUser {
        user_id: user.id,
        username: user.username.clone(),
        is_admin: user.is_admin,
        session_token: token.clone(),
        permissions: effective,
    };

    // 在下游处理器及其 await 到的池创建路径上注入当前登录会话的 owner 作用域，
    // 使 save_password=false 连接的临时密码按会话隔离（见 SessionCredentialStore）；
    // 同时注入请求级用户上下文供 T4/T5 权限判定使用。
    dbx_core::session_credentials::with_credential_owner(
        Some(token),
        with_request_user(request_user, async move { next.run(req).await }),
    )
    .await
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
    pub(crate) fn middleware_api_path_suffix_handles_nested_router_paths() {
        assert_eq!(middleware_api_path_suffix("/auth/check", "/"), Some("auth/check"));
        assert_eq!(middleware_api_path_suffix("/connection/list", "/"), Some("connection/list"));
        assert_eq!(middleware_api_path_suffix("/api/connection/list", "/"), Some("connection/list"));
        assert_eq!(middleware_api_path_suffix("/dbx/api/connection/list", "/dbx"), Some("connection/list"));
        assert_eq!(middleware_api_path_suffix("/dbx/login", "/dbx"), None);
    }

    #[test]
    fn migration_exempt_paths_cover_the_wizard_endpoints() {
        for path in ["migration/status", "migration/start", "migration/retry", "migration/cleanup-backups", "ping"] {
            assert!(super::migration_gate_exempt_path(path), "{path} should be exempt");
        }
        assert!(!super::migration_gate_exempt_path("connection/list"));
        assert!(!super::migration_gate_exempt_path("auth/check"));
    }

    #[test]
    fn weak_password_rejects_short_inputs() {
        assert!(super::weak_password(""));
        assert!(super::weak_password("12345"));
        assert!(!super::weak_password("123456"));
        assert!(!super::weak_password("long-enough-password"));
    }

    #[test]
    fn password_hashing_round_trip() {
        let hash = super::hash_password("round-trip-password").expect("hash");
        assert!(hash.starts_with("$argon2"));
        assert!(super::verify_password("round-trip-password", &hash));
        assert!(!super::verify_password("wrong-password", &hash));
        assert!(!super::verify_password("round-trip-password", "not-a-hash"));
    }
}
