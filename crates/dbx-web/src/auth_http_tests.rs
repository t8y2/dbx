//! Web 多用户认证集成测试：真实 handler + auth_middleware + IP 黑名单门 +
//! `axum::serve`（带 `ConnectInfo`），覆盖任务契约的全部场景。
//!
//! 覆盖：登录成功/密码错/禁用/限流/黑名单、check 响应全字段、setup 建首管
//! 与 already_initialized、change-password 成功与旧密码错、密码过期推导
//! （直接改库模拟时间）、must_change_password 403 门、未初始化 403 门、
//! 会话销毁与 logout。

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use dbx_core::connection::AppState;
use dbx_core::persistence::access_control::{
    ALL_PERMISSIONS, BLACKLIST_KIND_IP, BLACKLIST_KIND_USER, PASSWORD_MAX_AGE_SECS,
};
use serde_json::{json, Value};

use crate::state::WebState;

struct TestApp {
    base: String,
    state: Arc<WebState>,
    db_path: std::path::PathBuf,
}

impl TestApp {
    fn storage(&self) -> &dbx_core::storage::Storage {
        &self.state.app.storage
    }
}

/// 组装与生产一致的中间件顺序（IP 黑名单最外层 -> auth_middleware）。
async fn spawn_auth_app() -> TestApp {
    spawn_auth_app_with(false).await
}

/// 同 [`spawn_auth_app`]，但可指定 `DBX_DISABLE_PASSWORD=1` 的关闭模式。
async fn spawn_auth_app_with(password_disabled: bool) -> TestApp {
    let dir = std::env::temp_dir().join(format!("dbx-auth-tests-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("dbx.db");
    let storage = dbx_core::persistence::test_storage::open(&db_path).await.unwrap();
    let app = Arc::new(AppState::new(storage));
    let mut web_state = WebState::for_tests(app, dir);
    web_state.password_disabled = password_disabled;
    let state = Arc::new(web_state);
    // 与生产一致的组装结构（main.rs）：auth_middleware 只挂在 /api 嵌套
    // 内层（静态资源不经过它）；IP 黑名单门挂在全站最外层（覆盖静态与
    // API）。内层中间件看到的路径已剥去 /api 前缀（如 /auth/login）。
    let api = Router::new()
        .route("/auth/login", post(crate::auth::login))
        .route("/auth/check", get(crate::auth::check))
        .route("/auth/setup", post(crate::auth::setup))
        .route("/auth/change-password", post(crate::auth::change_password))
        .route("/auth/logout", post(crate::auth::logout))
        // 业务 API 代表：返回 JSON（放行时 get_json 可解析；被门拦截时
        // 中间件的错误响应同样为 JSON）。
        .route("/ping", get(|| async { axum::Json(json!({ "pong": true })) }))
        .route("/connection/list", get(|| async { "connections" }))
        .route("/migration/status", get(|| async { "status" }))
        .layer(axum::middleware::from_fn_with_state(state.clone(), crate::auth::auth_middleware))
        .with_state(state.clone());
    let router = Router::new()
        .nest("/api", api)
        // 静态资源（外层，不经过 auth_middleware——与生产 fallback 一致）。
        .route("/login", get(|| async { "login page" }))
        .layer(axum::middleware::from_fn_with_state(state.clone(), crate::blacklist::ip_blacklist_middleware));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    TestApp { base, state, db_path }
}

fn argon_hash(password: &str) -> String {
    use argon2::password_hash::{rand_core::OsRng, SaltString};
    use argon2::{Argon2, PasswordHasher};
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default().hash_password(password.as_bytes(), &salt).expect("argon2 hash").to_string()
}

async fn seed_user(app: &TestApp, username: &str, password: &str, is_admin: bool) -> i64 {
    app.storage().create_user(username, &argon_hash(password), None, None, is_admin).await.unwrap()
}

async fn login(app: &TestApp, username: &str, password: &str) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("{}/api/auth/login", app.base))
        .json(&json!({ "username": username, "password": password }))
        .send()
        .await
        .unwrap()
}

async fn get_json(app: &TestApp, path: &str, token: Option<&str>) -> (reqwest::StatusCode, Value) {
    let mut request = reqwest::Client::new().get(format!("{}{path}", app.base));
    if let Some(token) = token {
        request = request.header("cookie", format!("dbx_session={token}"));
    }
    let response = request.send().await.unwrap();
    let status = response.status();
    (status, response.json().await.unwrap())
}

/// 仅取响应状态（用于断言无 JSON body 的响应，如中间件的裸 401）。
async fn get_status(app: &TestApp, path: &str, token: Option<&str>) -> reqwest::StatusCode {
    let mut request = reqwest::Client::new().get(format!("{}{path}", app.base));
    if let Some(token) = token {
        request = request.header("cookie", format!("dbx_session={token}"));
    }
    request.send().await.unwrap().status()
}

fn session_token_of(response: &reqwest::Response) -> String {
    let set_cookie = response.headers().get("set-cookie").expect("login must set a session cookie").to_str().unwrap();
    let token = set_cookie.split(';').next().unwrap().trim().strip_prefix("dbx_session=").expect("dbx_session cookie");
    assert!(set_cookie.contains("HttpOnly"), "cookie must be HttpOnly: {set_cookie}");
    assert!(set_cookie.contains("SameSite=Lax"), "cookie must be SameSite=Lax: {set_cookie}");
    assert!(set_cookie.contains("Path=/"), "cookie must be scoped to the base path: {set_cookie}");
    token.to_string()
}

/// 直接改库覆盖 `password_updated_at`（模拟时间流逝触发 90 天过期门）。
fn overwrite_password_updated_at(app: &TestApp, username: &str, updated_at: i64) {
    let conn = rusqlite::Connection::open(&app.db_path).unwrap();
    conn.execute(
        "UPDATE users SET password_updated_at = ?1 WHERE username = ?2",
        rusqlite::params![updated_at, username],
    )
    .unwrap();
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}

#[tokio::test]
async fn password_disabled_keeps_legacy_open_access_behavior() {
    // DBX_DISABLE_PASSWORD=1：业务 API 无需会话直接放行（回归：admin gating
    // 不得在中间件层拦截非 admin 路径）；check 上报 disabled 形状。
    let app = spawn_auth_app_with(true).await;

    let (status, body) = get_json(&app, "/api/ping", None).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body["pong"], json!(true));

    let (status, body) = get_json(&app, "/api/auth/check", None).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body["authenticated"], json!(true));
    assert_eq!(body["required"], json!(false));
    assert_eq!(body["user"], json!(null));

    assert_eq!(get_status(&app, "/api/connection/list", None).await, reqwest::StatusCode::OK);
}

#[tokio::test]
async fn setup_bootstraps_first_admin_and_check_reports_full_contract() {
    let app = spawn_auth_app().await;

    // 未初始化：check 报 setup_required，无用户上下文。
    let (status, body) = get_json(&app, "/api/auth/check", None).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body["authenticated"], json!(false));
    assert_eq!(body["required"], json!(true));
    assert_eq!(body["setup_required"], json!(true));
    assert_eq!(body["user"], json!(null));
    assert_eq!(body["permissions"], json!([]));
    assert_eq!(body["must_change_password"], json!(false));
    assert_eq!(body["password_expires_in_days"], json!(null));

    // 弱密码 / 非法用户名被拒。
    let weak = reqwest::Client::new()
        .post(format!("{}/api/auth/setup", app.base))
        .json(&json!({ "username": "admin", "password": "12345" }))
        .send()
        .await
        .unwrap();
    assert_eq!(weak.status(), reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(weak.json::<Value>().await.unwrap()["error"], json!("weak_password"));
    let bad_username = reqwest::Client::new()
        .post(format!("{}/api/auth/setup", app.base))
        .json(&json!({ "username": "非法 名字!", "password": "secret1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_username.status(), reqwest::StatusCode::BAD_REQUEST);

    // setup 创建首个管理员：200 + 完整形状 + Set-Cookie。
    let response = reqwest::Client::new()
        .post(format!("{}/api/auth/setup", app.base))
        .json(&json!({ "username": "admin", "password": "secret1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let token = session_token_of(&response);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["authenticated"], json!(true));
    assert_eq!(body["required"], json!(true));
    assert_eq!(body["setup_required"], json!(false));
    assert_eq!(body["user"]["username"], json!("admin"));
    assert_eq!(body["user"]["display_name"], json!(null));
    assert_eq!(body["user"]["is_admin"], json!(true));
    assert_eq!(body["user"]["department_name"], json!(null));
    assert_eq!(body["user"]["roles"], json!([]));
    assert_eq!(body["permissions"], json!(ALL_PERMISSIONS.iter().collect::<Vec<_>>()));
    assert_eq!(body["must_change_password"], json!(false));
    assert_eq!(body["password_expires_in_days"], json!(90));

    // 再次 setup：409 already_initialized。
    let again = reqwest::Client::new()
        .post(format!("{}/api/auth/setup", app.base))
        .json(&json!({ "username": "other", "password": "secret1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(again.json::<Value>().await.unwrap()["error"], json!("already_initialized"));

    // 带 cookie 的 check：完整已认证状态；不带 cookie 回到未认证（但不再需要 setup）。
    let (status, body) = get_json(&app, "/api/auth/check", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body["authenticated"], json!(true));
    assert_eq!(body["user"]["username"], json!("admin"));
    let (_, body) = get_json(&app, "/api/auth/check", None).await;
    assert_eq!(body["authenticated"], json!(false));
    assert_eq!(body["setup_required"], json!(false));
}

#[tokio::test]
async fn login_outcomes_cover_success_mismatch_missing_and_disabled() {
    let app = spawn_auth_app().await;
    seed_user(&app, "eve", "eve-password", false).await;
    seed_user(&app, "admin", "admin-password", true).await;

    // 成功：普通用户（无角色）-> 空权限列表。
    let response = login(&app, "eve", "eve-password").await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let token = session_token_of(&response);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["authenticated"], json!(true));
    assert_eq!(body["user"]["username"], json!("eve"));
    assert_eq!(body["user"]["is_admin"], json!(false));
    assert_eq!(body["permissions"], json!([]));

    // 用户名大写规范化后精确匹配。
    let upper = login(&app, "EVE", "eve-password").await;
    assert_eq!(upper.status(), reqwest::StatusCode::OK);

    // 密码错误 / 用户不存在：401 invalid_credentials。
    let wrong = login(&app, "eve", "wrong-password").await;
    assert_eq!(wrong.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(wrong.json::<Value>().await.unwrap()["error"], json!("invalid_credentials"));
    let missing = login(&app, "nobody", "whatever1").await;
    assert_eq!(missing.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(missing.json::<Value>().await.unwrap()["error"], json!("invalid_credentials"));

    // 禁用用户：401 user_disabled。
    app.storage().update_user_status(1, false).await.unwrap();
    let disabled = login(&app, "eve", "eve-password").await;
    assert_eq!(disabled.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(disabled.json::<Value>().await.unwrap()["error"], json!("user_disabled"));
    app.storage().update_user_status(1, true).await.unwrap();

    // 已签发会话保持可用（禁用未发生时的会话）。
    let (status, _) = get_json(&app, "/api/auth/check", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
}

#[tokio::test]
async fn login_rate_limit_locks_after_five_failures_per_username_and_ip() {
    let app = spawn_auth_app().await;
    seed_user(&app, "eve", "eve-password", false).await;
    seed_user(&app, "admin", "admin-password", true).await;

    // 5 次失败后第 6 次 429（同 username + ip）。
    for _ in 0..5 {
        let response = login(&app, "eve", "wrong-password").await;
        assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    }
    let locked = login(&app, "eve", "eve-password").await;
    assert_eq!(locked.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(locked.json::<Value>().await.unwrap()["error"], json!("rate_limited"));

    // 其他 username 不受该组合的锁定影响。
    let admin = login(&app, "admin", "admin-password").await;
    assert_eq!(admin.status(), reqwest::StatusCode::OK);
}

#[tokio::test]
async fn blacklist_blocks_login_by_username_and_all_requests_by_ip() {
    let app = spawn_auth_app().await;
    seed_user(&app, "eve", "eve-password", false).await;

    // 用户名黑名单：403 blacklisted。
    app.storage().add_blacklist(BLACKLIST_KIND_USER, "eve", Some("abuse"), Some("admin")).await.unwrap();
    app.state.blacklist.reload(app.storage()).await.unwrap();
    let response = login(&app, "eve", "eve-password").await;
    assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
    assert_eq!(response.json::<Value>().await.unwrap()["error"], json!("blacklisted"));

    // IP 黑名单（测试客户端固定走 127.0.0.1）：全部请求 403，含 auth 端点。
    app.storage().add_blacklist(BLACKLIST_KIND_IP, "127.0.0.1", Some("scan"), Some("admin")).await.unwrap();
    app.state.blacklist.reload(app.storage()).await.unwrap();
    let login_response = login(&app, "eve", "eve-password").await;
    assert_eq!(login_response.status(), reqwest::StatusCode::FORBIDDEN);
    assert_eq!(login_response.json::<Value>().await.unwrap()["error"], json!("ip_blacklisted"));
    let (status, body) = get_json(&app, "/api/auth/check", None).await;
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN);
    assert_eq!(body["error"], json!("ip_blacklisted"));

    // 静态资源同样被 IP 门拦截（对全部请求生效）。
    let static_response = reqwest::Client::new().get(format!("{}/login", app.base)).send().await.unwrap();
    assert_eq!(static_response.status(), reqwest::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn change_password_requires_old_password_and_accepts_strong_new_one() {
    let app = spawn_auth_app().await;
    seed_user(&app, "eve", "old-password", false).await;
    let token = session_token_of(&login(&app, "eve", "old-password").await);

    let client = reqwest::Client::new();
    let url = format!("{}/api/auth/change-password", app.base);

    // 旧密码错误：401 invalid_credentials。
    let wrong = client
        .post(&url)
        .header("cookie", format!("dbx_session={token}"))
        .json(&json!({ "old_password": "not-the-old-one", "new_password": "new-password-1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(wrong.json::<Value>().await.unwrap()["error"], json!("invalid_credentials"));

    // 新密码过短：400 weak_password。
    let weak = client
        .post(&url)
        .header("cookie", format!("dbx_session={token}"))
        .json(&json!({ "old_password": "old-password", "new_password": "12345" }))
        .send()
        .await
        .unwrap();
    assert_eq!(weak.status(), reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(weak.json::<Value>().await.unwrap()["error"], json!("weak_password"));

    // 成功：{"ok":true}，旧密码失效、新密码可登录。
    let ok = client
        .post(&url)
        .header("cookie", format!("dbx_session={token}"))
        .json(&json!({ "old_password": "old-password", "new_password": "new-password-1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), reqwest::StatusCode::OK);
    assert_eq!(ok.json::<Value>().await.unwrap(), json!({ "ok": true }));

    let stale = login(&app, "eve", "old-password").await;
    assert_eq!(stale.status(), reqwest::StatusCode::UNAUTHORIZED);
    let fresh = login(&app, "eve", "new-password-1").await;
    assert_eq!(fresh.status(), reqwest::StatusCode::OK);
    let body: Value = fresh.json().await.unwrap();
    // 新密码重置有效期与 must_change_password。
    assert_eq!(body["must_change_password"], json!(false));
    assert_eq!(body["password_expires_in_days"], json!(90));
}

#[tokio::test]
async fn must_change_password_flag_gates_business_apis_but_not_auth() {
    let app = spawn_auth_app().await;
    let user_id = seed_user(&app, "dave", "dave-password", false).await;
    let token = session_token_of(&login(&app, "dave", "dave-password").await);

    // 正常状态：业务 API 放行。
    let (status, _) = get_json(&app, "/api/ping", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);

    // 置 must_change_password：登录本身可用、auth 端点可用，但业务 API 403。
    app.storage().set_must_change_password(user_id, true).await.unwrap();
    let (status, body) = get_json(&app, "/api/auth/check", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body["must_change_password"], json!(true));
    let (status, body) = get_json(&app, "/api/ping", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN);
    assert_eq!(body["error"], json!("password_change_required"));

    // 修改密码后门解除。
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/api/auth/change-password", app.base))
        .header("cookie", format!("dbx_session={token}"))
        .json(&json!({ "old_password": "dave-password", "new_password": "dave-new-pass" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let (status, _) = get_json(&app, "/api/ping", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
}

#[tokio::test]
async fn password_expiry_derivation_and_gate_use_the_ninety_day_window() {
    let app = spawn_auth_app().await;
    seed_user(&app, "frank", "frank-password", false).await;

    // 剩余约 1 天：expires_in_days = 1，尚未过期。
    let now = now_secs();
    overwrite_password_updated_at(&app, "frank", now - PASSWORD_MAX_AGE_SECS + 86_400);
    let response = login(&app, "frank", "frank-password").await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let token = session_token_of(&response);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["password_expires_in_days"], json!(1));
    assert_eq!(body["must_change_password"], json!(false));
    let (status, _) = get_json(&app, "/api/ping", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);

    // 过期 1 天：expires_in_days = 0、must_change_password = true、业务 API 403。
    overwrite_password_updated_at(&app, "frank", now - PASSWORD_MAX_AGE_SECS - 86_400);
    let (status, body) = get_json(&app, "/api/auth/check", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body["password_expires_in_days"], json!(0));
    assert_eq!(body["must_change_password"], json!(true));
    let (status, body) = get_json(&app, "/api/ping", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN);
    assert_eq!(body["error"], json!("password_change_required"));
}

#[tokio::test]
async fn uninitialized_system_returns_setup_required_except_exempt_paths() {
    let app = spawn_auth_app().await;
    let client = reqwest::Client::new();

    // 业务 API：403 setup_required。
    let response = client.get(format!("{}/api/connection/list", app.base)).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
    assert_eq!(response.json::<Value>().await.unwrap()["error"], json!("setup_required"));

    // auth 端点与迁移向导豁免端点放行。
    let (status, _) = get_json(&app, "/api/auth/check", None).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    for path in ["/api/migration/status", "/api/ping"] {
        let response = client.get(format!("{}{path}", app.base)).send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK, "{path} must stay accessible");
    }

    // 静态资源放行。
    let response = client.get(format!("{}/login", app.base)).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);

    // 初始化后：未带会话的请求回到普通 401。
    seed_user(&app, "admin", "admin-password", true).await;
    let response = client.get(format!("{}/api/connection/list", app.base)).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn logout_destroys_the_session() {
    let app = spawn_auth_app().await;
    seed_user(&app, "eve", "eve-password", false).await;
    let token = session_token_of(&login(&app, "eve", "eve-password").await);

    let (status, _) = get_json(&app, "/api/ping", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);

    let response = reqwest::Client::new()
        .post(format!("{}/api/auth/logout", app.base))
        .header("cookie", format!("dbx_session={token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    // 清除 cookie 的 Set-Cookie 指令。
    let set_cookie = response.headers().get("set-cookie").unwrap().to_str().unwrap();
    assert!(set_cookie.contains("Max-Age=0"), "logout must clear the cookie: {set_cookie}");

    // 中间件的裸 401 无 JSON body（沿用原版响应形状），只断言状态码。
    assert_eq!(get_status(&app, "/api/ping", Some(&token)).await, reqwest::StatusCode::UNAUTHORIZED);
    let (_, body) = get_json(&app, "/api/auth/check", Some(&token)).await;
    assert_eq!(body["authenticated"], json!(false));
}

#[tokio::test]
async fn disabled_user_sessions_are_destroyed_on_the_next_request() {
    let app = spawn_auth_app().await;
    let user_id = seed_user(&app, "eve", "eve-password", false).await;
    let token = session_token_of(&login(&app, "eve", "eve-password").await);

    let (status, _) = get_json(&app, "/api/ping", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);

    // 禁用后：下一次请求销毁会话并返回 401；check 同步回到未认证。
    app.storage().update_user_status(user_id, false).await.unwrap();
    // 中间件的裸 401 无 JSON body（沿用原版响应形状），只断言状态码。
    assert_eq!(get_status(&app, "/api/ping", Some(&token)).await, reqwest::StatusCode::UNAUTHORIZED);
    let (_, body) = get_json(&app, "/api/auth/check", Some(&token)).await;
    assert_eq!(body["authenticated"], json!(false));
    let sessions = app.state.sessions.read().await;
    assert!(!sessions.contains_key(&token), "session must be destroyed");
}
