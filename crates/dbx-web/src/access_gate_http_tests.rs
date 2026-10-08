//! T4 权限执行层集成测试：真实 `axum::serve`（带 `ConnectInfo`），
//! 中间件链与生产一致（auth_middleware 外层 -> access_gate_middleware 内层）。
//!
//! 覆盖：每个权限族代表端点的 403 / 放行、query 语句分类（query.read +
//! query.write）、连接 scope（connection/list 过滤脱敏、layout/sidebar 过滤、
//! connection_forbidden）、admin 全可见含密码、DBX_DISABLE_PASSWORD 旁路。
//! 路径->权限映射的纯函数单测在 `access_gate.rs` 模块内。

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use dbx_core::connection::AppState;
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::persistence::access_control::ALL_PERMISSIONS;
use serde_json::{json, Value};

use crate::state::WebState;

struct TestApp {
    base: String,
    state: Arc<WebState>,
}

impl TestApp {
    fn storage(&self) -> &dbx_core::storage::Storage {
        &self.state.app.storage
    }
}

/// 组装与生产一致的中间件顺序（main.rs）：auth_middleware 先执行，
/// access_gate_middleware 在其后（/api 嵌套内层链末端）。
async fn spawn_gate_app() -> TestApp {
    spawn_gate_app_with(false).await
}

/// 同 [`spawn_gate_app`]，但可指定 `DBX_DISABLE_PASSWORD=1` 的关闭模式。
async fn spawn_gate_app_with(password_disabled: bool) -> TestApp {
    let dir = std::env::temp_dir().join(format!("dbx-access-gate-tests-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("dbx.db");
    let storage = dbx_core::persistence::test_storage::open(&db_path).await.unwrap();
    let app = Arc::new(AppState::new(storage));
    let mut web_state = WebState::for_tests(app, dir);
    web_state.password_disabled = password_disabled;
    let state = Arc::new(web_state);
    let api = Router::new()
        .route("/auth/login", post(crate::auth::login))
        // 真实 handler：连接列表过滤脱敏 / sidebar 过滤 / query 语句分类 +
        // 连接可见范围守卫（handler 入口）。
        .route("/connection/list", get(crate::routes::connection::load_connections))
        .route("/layout/sidebar", get(crate::routes::layout::load_sidebar_layout))
        .route("/query/execute", post(crate::routes::query::execute_query))
        // 其余权限族代表端点：403 在中间件层拦截（到不了 handler），放行时
        // mock 返回 200（业务层语义与本任务无关）。
        .route("/connection/save", post(mock_ok))
        .route("/transfer/start", post(mock_ok))
        .route("/sql-file/execute", post(mock_ok))
        .route("/schema-diff/prepare", post(mock_ok))
        .route("/data-compare/from-tables", post(mock_ok))
        .route("/database-backups", post(mock_ok))
        .route("/import/execute", post(mock_ok))
        .route("/export/database", post(mock_ok))
        .route("/redis/flush-db", post(mock_ok))
        .route("/mongo/drop-database", post(mock_ok))
        .layer(axum::middleware::from_fn_with_state(state.clone(), crate::access_gate::access_gate_middleware))
        .layer(axum::middleware::from_fn_with_state(state.clone(), crate::auth::auth_middleware))
        .with_state(state.clone());
    let router = Router::new()
        .nest("/api", api)
        .route("/login", get(|| async { "login page" }))
        .layer(axum::middleware::from_fn_with_state(state.clone(), crate::blacklist::ip_blacklist_middleware));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    TestApp { base, state }
}

async fn mock_ok() -> axum::Json<Value> {
    axum::Json(json!({ "ok": true }))
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

/// 建角色并返回 id；permissions 为权限 key 列表，scope 指定可见分组 / 连接。
async fn seed_role(
    app: &TestApp,
    name: &str,
    permissions: &[&str],
    group_ids: &[&str],
    connection_ids: &[&str],
) -> i64 {
    let permissions_json = serde_json::to_string(permissions).unwrap();
    let scope_json = json!({
        "allowed_group_ids": group_ids,
        "allowed_connection_ids": connection_ids,
    })
    .to_string();
    app.storage().create_role(name, None, &permissions_json, &scope_json).await.unwrap()
}

async fn seed_user_with_role(app: &TestApp, username: &str, password: &str, role_id: i64) -> i64 {
    let user_id = seed_user(app, username, password, false).await;
    app.storage().set_user_roles(user_id, &[role_id]).await.unwrap();
    user_id
}

async fn login_token(app: &TestApp, username: &str, password: &str) -> String {
    let response = reqwest::Client::new()
        .post(format!("{}/api/auth/login", app.base))
        .json(&json!({ "username": username, "password": password }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK, "login of {username} must succeed");
    let set_cookie = response.headers().get("set-cookie").expect("login must set a session cookie").to_str().unwrap();
    set_cookie.split(';').next().unwrap().trim().strip_prefix("dbx_session=").expect("dbx_session cookie").to_string()
}

async fn post_json(app: &TestApp, path: &str, token: Option<&str>, body: &Value) -> (reqwest::StatusCode, Value) {
    let mut request = reqwest::Client::new().post(format!("{}{path}", app.base));
    if let Some(token) = token {
        request = request.header("cookie", format!("dbx_session={token}"));
    }
    let response = request.json(body).send().await.unwrap();
    let status = response.status();
    (status, response.json().await.unwrap())
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

async fn post_status(app: &TestApp, path: &str, token: Option<&str>, body: &Value) -> reqwest::StatusCode {
    let mut request = reqwest::Client::new().post(format!("{}{path}", app.base));
    if let Some(token) = token {
        request = request.header("cookie", format!("dbx_session={token}"));
    }
    request.json(body).send().await.unwrap().status()
}

/// 两个分组各挂一个连接（带密码），供 scope 测试使用；分组归属经
/// sidebar 布局解析（与生产存储一致）。
async fn seed_grouped_connections(app: &TestApp) {
    let configs: Vec<ConnectionConfig> = serde_json::from_value(json!([
        {
            "id": "conn-a",
            "name": "Connection A",
            "db_type": "mysql",
            "host": "127.0.0.1",
            "port": 3306,
            "username": "root",
            "password": "secret-a"
        },
        {
            "id": "conn-b",
            "name": "Connection B",
            "db_type": "mysql",
            "host": "127.0.0.2",
            "port": 3306,
            "username": "root",
            "password": "secret-b"
        },
    ]))
    .expect("deserialize test connection configs");
    app.storage().save_connections(&configs).await.unwrap();
    let layout = json!({
        "groups": [
            { "id": "group-a", "name": "Group A" },
            { "id": "group-b", "name": "Group B" },
        ],
        "order": [
            { "type": "group", "id": "group-a", "children": [
                { "type": "connection", "id": "conn-a" },
            ]},
            { "type": "group", "id": "group-b", "children": [
                { "type": "connection", "id": "conn-b" },
            ]},
        ],
    });
    app.storage().save_sidebar_layout(&layout).await.unwrap();
}

fn assert_not_access_denied(status: reqwest::StatusCode, body: &Value, context: &str) {
    assert_ne!(status, reqwest::StatusCode::FORBIDDEN, "{context} must not be 403: {status}");
    assert_ne!(body["error"], json!("permission_denied"), "{context}: {body}");
    assert_ne!(body["error"], json!("connection_forbidden"), "{context}: {body}");
}

#[tokio::test]
async fn permission_families_gate_unprivileged_and_pass_full_role_and_admin() {
    let app = spawn_gate_app().await;
    // eve：无角色（无任何权限）；bob：全部权限；admin：管理员。
    seed_user(&app, "eve", "eve-password", false).await;
    let full_role = seed_role(&app, "full", &ALL_PERMISSIONS, &[], &[]).await;
    seed_user_with_role(&app, "bob", "bob-password", full_role).await;
    seed_user(&app, "admin", "admin-password", true).await;

    let eve_token = login_token(&app, "eve", "eve-password").await;
    let bob_token = login_token(&app, "bob", "bob-password").await;
    let admin_token = login_token(&app, "admin", "admin-password").await;

    let families: &[(&str, &str)] = &[
        ("/api/connection/save", "connection.manage"),
        ("/api/transfer/start", "transfer"),
        ("/api/sql-file/execute", "sqlfile.execute"),
        ("/api/schema-diff/prepare", "schema.compare"),
        ("/api/data-compare/from-tables", "data.compare"),
        ("/api/database-backups", "backup.restore"),
        ("/api/import/execute", "import.data"),
        ("/api/export/database", "export.data"),
        ("/api/redis/flush-db", "query.write"),
        ("/api/mongo/drop-database", "query.write"),
    ];
    for (path, permission) in families {
        // 无权限用户：403 permission_denied（含缺失 key）。
        let (status, body) = post_json(&app, path, Some(&eve_token), &json!({})).await;
        assert_eq!(status, reqwest::StatusCode::FORBIDDEN, "{path}");
        assert_eq!(body["error"], json!("permission_denied"), "{path}: {body}");
        assert_eq!(body["permission"], json!(*permission), "{path}: {body}");

        // 全权限用户与管理员：放行（mock handler 200）。
        let (status, body) = post_json(&app, path, Some(&bob_token), &json!({})).await;
        assert_eq!(status, reqwest::StatusCode::OK, "{path}");
        assert_eq!(body["ok"], json!(true), "{path}");
        let (status, body) = post_json(&app, path, Some(&admin_token), &json!({})).await;
        assert_eq!(status, reqwest::StatusCode::OK, "{path}");
        assert_eq!(body["ok"], json!(true), "{path}");
    }

    // query.read：中间件层 403（语句在 body 内，反序列化晚于中间件）。
    let (status, body) = post_json(&app, "/api/query/execute", Some(&eve_token), &json!({})).await;
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN);
    assert_eq!(body["error"], json!("permission_denied"));
    assert_eq!(body["permission"], json!("query.read"));

    // 全权限用户：通过 query.read 门后落到业务层（连接不存在的业务错误可接受）。
    let (status, body) = post_json(
        &app,
        "/api/query/execute",
        Some(&bob_token),
        &json!({ "connectionId": "conn-missing", "database": "db", "sql": "SELECT 1" }),
    )
    .await;
    assert_not_access_denied(status, &body, "full-role query execute");

    // 未认证依旧由外层 auth 拦截 401。
    let status = post_status(&app, "/api/transfer/start", None, &json!({})).await;
    assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn query_statement_classification_requires_write_permission_for_write_verbs() {
    let app = spawn_gate_app().await;
    // reader：仅 query.read（scope 未配置 = 全连接可见）；writer：读 + 写。
    let reader_role = seed_role(&app, "reader", &["query.read"], &[], &[]).await;
    let writer_role = seed_role(&app, "writer", &["query.read", "query.write"], &[], &[]).await;
    seed_user_with_role(&app, "reader", "reader-password", reader_role).await;
    seed_user_with_role(&app, "writer", "writer-password", writer_role).await;
    let reader_token = login_token(&app, "reader", "reader-password").await;
    let writer_token = login_token(&app, "writer", "writer-password").await;

    // SELECT：通过权限门，落到业务层（连接不存在的业务错误可接受）。
    let (status, body) = execute_query_on(&app, &reader_token, "SELECT 1").await;
    assert_not_access_denied(status, &body, "reader SELECT");

    // UPDATE / DELETE / DDL：只有 query.read 的用户 -> 403 query.write。
    for sql in ["UPDATE t SET a = 1", "DELETE FROM t", "DROP TABLE t"] {
        let (status, body) = execute_query_on(&app, &reader_token, sql).await;
        assert_eq!(status, reqwest::StatusCode::FORBIDDEN, "{sql}");
        assert_eq!(body["error"], json!("permission_denied"), "{sql}: {body}");
        assert_eq!(body["permission"], json!("query.write"), "{sql}: {body}");
    }

    // 多语句脚本混入写句：任一写句即要求 query.write。
    let (status, body) = execute_query_on(&app, &reader_token, "SELECT 1; UPDATE t SET a = 1").await;
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN);
    assert_eq!(body["error"], json!("permission_denied"));
    assert_eq!(body["permission"], json!("query.write"));
    let (status, body) = execute_query_on(&app, &reader_token, "SELECT 1; SELECT 2").await;
    assert_not_access_denied(status, &body, "reader pure-read script");

    // 有 query.write 的用户：写语句通过权限门，落到业务层。
    let (status, body) = execute_query_on(&app, &writer_token, "UPDATE t SET a = 1").await;
    assert_not_access_denied(status, &body, "writer UPDATE");
}

/// 对 /api/query/execute 发起一次执行（连接 id 任意：scope 全开时直达语句分类）。
async fn execute_query_on(app: &TestApp, token: &str, sql: &str) -> (reqwest::StatusCode, Value) {
    post_json(
        app,
        "/api/query/execute",
        Some(token),
        &json!({ "connectionId": "conn-any", "database": "db", "sql": sql }),
    )
    .await
}

#[tokio::test]
async fn connection_scope_filters_lists_sidebar_and_gates_foreign_connections() {
    let app = spawn_gate_app().await;
    seed_grouped_connections(&app).await;
    seed_user(&app, "admin", "admin-password", true).await;
    // alice：query.read + 只勾选分组 A（该分组下全部连接可见）。
    let group_a_role = seed_role(&app, "group-a-only", &["query.read"], &["group-a"], &[]).await;
    seed_user_with_role(&app, "alice", "alice-password", group_a_role).await;
    let alice_token = login_token(&app, "alice", "alice-password").await;
    let admin_token = login_token(&app, "admin", "admin-password").await;

    // connection/list：仅见分组 A 的连接，且无 connection.manage 时密码被抹除。
    let (status, body) = get_json(&app, "/api/connection/list", Some(&alice_token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    let connections = body.as_array().expect("connection list must be an array");
    assert_eq!(connections.len(), 1, "only group-a connection must be visible: {body}");
    assert_eq!(connections[0]["id"], json!("conn-a"));
    assert_eq!(connections[0]["password"], json!(""), "password must be redacted: {body}");

    // layout/sidebar：只剩分组 A（groups 元数据同步裁剪）。
    let (status, body) = get_json(&app, "/api/layout/sidebar", Some(&alice_token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    let order = body["order"].as_array().expect("sidebar order must be an array");
    assert_eq!(order.len(), 1, "only group-a must remain: {body}");
    assert_eq!(order[0]["id"], json!("group-a"));
    let children = order[0]["children"].as_array().unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(children[0]["id"], json!("conn-a"));
    assert_eq!(body["groups"].as_array().unwrap().len(), 1);

    // 对分组 B 的连接执行查询：403 connection_forbidden（含连接 id）。
    let (status, body) = post_json(
        &app,
        "/api/query/execute",
        Some(&alice_token),
        &json!({ "connectionId": "conn-b", "database": "db", "sql": "SELECT 1" }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN);
    assert_eq!(body["error"], json!("connection_forbidden"));
    assert_eq!(body["connectionId"], json!("conn-b"));

    // 对可见连接执行 SELECT：通过权限门与 scope 门（业务层错误可接受）。
    let (status, body) = post_json(
        &app,
        "/api/query/execute",
        Some(&alice_token),
        &json!({ "connectionId": "conn-a", "database": "db", "sql": "SELECT 1" }),
    )
    .await;
    assert_not_access_denied(status, &body, "alice SELECT on visible connection");

    // admin：全连接可见且密码原样返回；sidebar 完整。
    let (status, body) = get_json(&app, "/api/connection/list", Some(&admin_token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    let connections = body.as_array().unwrap();
    assert_eq!(connections.len(), 2, "admin must see all connections: {body}");
    let conn_a = connections.iter().find(|config| config["id"] == json!("conn-a")).unwrap();
    assert_eq!(conn_a["password"], json!("secret-a"), "admin must see the stored password");
    let conn_b = connections.iter().find(|config| config["id"] == json!("conn-b")).unwrap();
    assert_eq!(conn_b["password"], json!("secret-b"));
    let (status, body) = get_json(&app, "/api/layout/sidebar", Some(&admin_token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body["order"].as_array().unwrap().len(), 2, "admin sidebar must be complete: {body}");
}

#[tokio::test]
async fn password_disabled_bypasses_access_gate_entirely() {
    let app = spawn_gate_app_with(true).await;

    // 未认证直接命中被映射的写端点：整体旁路（mock handler 200）。
    let (status, body) = post_json(&app, "/api/transfer/start", None, &json!({})).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body["ok"], json!(true));
    let (status, body) = post_json(&app, "/api/redis/flush-db", None, &json!({})).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body["ok"], json!(true));
}
