//! Web 权限管理 API 集成测试：真实 handler、认证中间件与 HTTP 服务。

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::post;
use axum::Router;
use dbx_core::connection::AppState;
use dbx_core::models::connection::ConnectionConfig;
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

async fn spawn_admin_app(password_disabled: bool) -> TestApp {
    let dir = std::env::temp_dir().join(format!("dbx-admin-tests-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("dbx.db")).await.unwrap();
    let app = Arc::new(AppState::new(storage));
    let mut web_state = WebState::for_tests(app, dir);
    web_state.password_disabled = password_disabled;
    let state = Arc::new(web_state);
    let api = crate::add_admin_routes(Router::new().route("/auth/login", post(crate::auth::login)))
        .layer(axum::middleware::from_fn_with_state(state.clone(), crate::access_gate::access_gate_middleware))
        .layer(axum::middleware::from_fn_with_state(state.clone(), crate::auth::auth_middleware))
        .with_state(state.clone());
    let router = Router::new()
        .nest("/api", api)
        .layer(axum::middleware::from_fn_with_state(state.clone(), crate::blacklist::ip_blacklist_middleware));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    TestApp { base, state }
}

async fn seed_user(app: &TestApp, username: &str, password: &str, is_admin: bool) -> i64 {
    let hash = crate::auth::hash_password(password).unwrap();
    app.storage().create_user(username, &hash, None, None, is_admin).await.unwrap()
}

async fn login_token(app: &TestApp, username: &str, password: &str) -> String {
    let response = reqwest::Client::new()
        .post(format!("{}/api/auth/login", app.base))
        .json(&json!({"username": username, "password": password}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    response
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .trim()
        .strip_prefix("dbx_session=")
        .unwrap()
        .to_string()
}

async fn request_json(
    app: &TestApp,
    method: reqwest::Method,
    path: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> (reqwest::StatusCode, Value) {
    let client = reqwest::Client::new();
    let mut request = client.request(method, format!("{}{path}", app.base));
    if let Some(token) = token {
        request = request.header("cookie", format!("dbx_session={token}"));
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.unwrap();
    let status = response.status();
    let body = response.json().await.unwrap();
    (status, body)
}

async fn get_json(app: &TestApp, path: &str, token: Option<&str>) -> (reqwest::StatusCode, Value) {
    request_json(app, reqwest::Method::GET, path, token, None).await
}

async fn post_json(app: &TestApp, path: &str, token: &str, body: &Value) -> (reqwest::StatusCode, Value) {
    request_json(app, reqwest::Method::POST, path, Some(token), Some(body)).await
}

async fn put_json(app: &TestApp, path: &str, token: &str, body: &Value) -> (reqwest::StatusCode, Value) {
    request_json(app, reqwest::Method::PUT, path, Some(token), Some(body)).await
}

async fn delete_json(app: &TestApp, path: &str, token: &str) -> (reqwest::StatusCode, Value) {
    request_json(app, reqwest::Method::DELETE, path, Some(token), None).await
}

#[tokio::test]
async fn admin_gating_rejects_non_admin_and_disabled_user_system() {
    let app = spawn_admin_app(false).await;
    seed_user(&app, "member", "member-password", false).await;
    let token = login_token(&app, "member", "member-password").await;

    let (status, body) = get_json(&app, "/api/admin/users", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN);
    assert_eq!(body, json!({"error": "admin_required"}));

    let disabled = spawn_admin_app(true).await;
    let (status, body) = get_json(&disabled, "/api/admin/users", None).await;
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN);
    assert_eq!(body, json!({"error": "user_system_disabled"}));
}

#[tokio::test]
async fn user_crud_round_trip_returns_the_frontend_contract() {
    let app = spawn_admin_app(false).await;
    seed_user(&app, "admin", "admin-password", true).await;
    let token = login_token(&app, "admin", "admin-password").await;
    let department_id = app.storage().create_department("Engineering", 10).await.unwrap();
    let role_id = app
        .storage()
        .create_role(
            "reader",
            Some("Read access"),
            r#"["query.read"]"#,
            r#"{"allowed_group_ids":[],"allowed_connection_ids":[]}"#,
        )
        .await
        .unwrap();

    let (status, created) = post_json(
        &app,
        "/api/admin/users",
        &token,
        &json!({
            "username": "Alice.Dev",
            "password": "alice-password",
            "display_name": "Alice",
            "department_id": department_id,
            "role_ids": [role_id],
            "is_admin": false
        }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::CREATED);
    let user_id = created["id"].as_i64().unwrap();
    assert_eq!(created["username"], json!("alice.dev"));
    assert_eq!(created["department_name"], json!("Engineering"));
    assert_eq!(created["status"], json!(1));
    assert_eq!(created["roles"], json!([{"id": role_id, "name": "reader"}]));
    for field in ["password_updated_at", "created_at", "updated_at"] {
        assert!(created[field].as_i64().unwrap() > 0, "missing {field}: {created}");
    }

    let (status, users) = get_json(&app, "/api/admin/users", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert!(users.as_array().unwrap().iter().any(|user| user["id"] == json!(user_id)));

    let (status, updated) = put_json(
        &app,
        &format!("/api/admin/users/{user_id}"),
        &token,
        &json!({"display_name": "Alice Updated", "department_id": null, "role_ids": []}),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(updated["display_name"], json!("Alice Updated"));
    assert_eq!(updated["department_id"], Value::Null);
    assert_eq!(updated["roles"], json!([]));

    let (status, body) = post_json(
        &app,
        &format!("/api/admin/users/{user_id}/reset-password"),
        &token,
        &json!({"new_password": "alice-new-password"}),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body, json!({"ok": true}));
    assert!(app.storage().get_user_by_id(user_id).await.unwrap().unwrap().must_change_password);

    let (status, body) = delete_json(&app, &format!("/api/admin/users/{user_id}"), &token).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body, json!({"ok": true}));
    assert!(app.storage().get_user_by_id(user_id).await.unwrap().is_none());
}

#[tokio::test]
async fn self_forbidden_blocks_delete_disable_and_admin_demotion() {
    let app = spawn_admin_app(false).await;
    let admin_id = seed_user(&app, "admin", "admin-password", true).await;
    let token = login_token(&app, "admin", "admin-password").await;

    let (status, body) = delete_json(&app, &format!("/api/admin/users/{admin_id}"), &token).await;
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN);
    assert_eq!(body["error"], json!("self_forbidden"));

    for patch in [json!({"status": 0}), json!({"is_admin": false})] {
        let (status, body) = put_json(&app, &format!("/api/admin/users/{admin_id}"), &token, &patch).await;
        assert_eq!(status, reqwest::StatusCode::FORBIDDEN);
        assert_eq!(body["error"], json!("self_forbidden"));
    }
}

#[tokio::test]
async fn department_delete_reports_in_use() {
    let app = spawn_admin_app(false).await;
    seed_user(&app, "admin", "admin-password", true).await;
    let token = login_token(&app, "admin", "admin-password").await;
    let (status, department) =
        post_json(&app, "/api/admin/departments", &token, &json!({"name": "Platform", "sort": 2})).await;
    assert_eq!(status, reqwest::StatusCode::CREATED);
    let department_id = department["id"].as_i64().unwrap();
    app.storage()
        .create_user(
            "member",
            &crate::auth::hash_password("member-password").unwrap(),
            None,
            Some(department_id),
            false,
        )
        .await
        .unwrap();

    let (status, body) = delete_json(&app, &format!("/api/admin/departments/{department_id}"), &token).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    assert_eq!(body, json!({"error": "in_use"}));
}

#[tokio::test]
async fn role_delete_reports_in_use_and_role_json_round_trips() {
    let app = spawn_admin_app(false).await;
    seed_user(&app, "admin", "admin-password", true).await;
    let token = login_token(&app, "admin", "admin-password").await;
    let (status, role) = post_json(
        &app,
        "/api/admin/roles",
        &token,
        &json!({
            "name": "analyst",
            "description": "Analyst role",
            "permissions": ["query.read", "export.data"],
            "scope": {"allowed_group_ids": ["group-a"], "allowed_connection_ids": ["conn-b"]}
        }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::CREATED);
    assert_eq!(role["permissions"], json!(["query.read", "export.data"]));
    assert_eq!(role["scope"]["allowed_group_ids"], json!(["group-a"]));
    let role_id = role["id"].as_i64().unwrap();
    let member_id = seed_user(&app, "member", "member-password", false).await;
    app.storage().set_user_roles(member_id, &[role_id]).await.unwrap();

    let (status, body) = delete_json(&app, &format!("/api/admin/roles/{role_id}"), &token).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    assert_eq!(body, json!({"error": "in_use"}));
}

#[tokio::test]
async fn user_blacklist_reload_evicts_all_matching_sessions() {
    let app = spawn_admin_app(false).await;
    seed_user(&app, "admin", "admin-password", true).await;
    seed_user(&app, "victim", "victim-password", false).await;
    let admin_token = login_token(&app, "admin", "admin-password").await;
    let victim_token_a = login_token(&app, "victim", "victim-password").await;
    let victim_token_b = login_token(&app, "victim", "victim-password").await;
    assert!(app.state.sessions.read().await.contains_key(&victim_token_a));
    assert!(app.state.sessions.read().await.contains_key(&victim_token_b));

    let (status, entry) = post_json(
        &app,
        "/api/admin/blacklist",
        &admin_token,
        &json!({"kind": "user", "value": "Victim", "reason": "policy"}),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::CREATED);
    assert_eq!(entry["kind"], json!("user"));
    assert_eq!(entry["value"], json!("victim"));
    assert_eq!(entry["created_by"], json!("admin"));
    assert!(app.state.blacklist.is_user_blacklisted("victim"));
    let sessions = app.state.sessions.read().await;
    assert!(!sessions.contains_key(&victim_token_a));
    assert!(!sessions.contains_key(&victim_token_b));
    assert!(sessions.contains_key(&admin_token));
}

#[tokio::test]
async fn scope_tree_contains_nested_groups_and_ungrouped_connections() {
    let app = spawn_admin_app(false).await;
    seed_user(&app, "admin", "admin-password", true).await;
    let token = login_token(&app, "admin", "admin-password").await;
    let connections: Vec<ConnectionConfig> = serde_json::from_value(json!([
        {
            "id": "conn-a", "name": "Connection A", "db_type": "mysql", "host": "127.0.0.1",
            "port": 3306, "username": "root", "password": ""
        },
        {
            "id": "conn-b", "name": "Connection B", "db_type": "mysql", "host": "127.0.0.1",
            "port": 3306, "username": "root", "password": ""
        },
        {
            "id": "conn-c", "name": "Connection C", "db_type": "mysql", "host": "127.0.0.1",
            "port": 3306, "username": "root", "password": ""
        }
    ]))
    .unwrap();
    app.storage().save_connections(&connections).await.unwrap();
    app.storage()
        .save_sidebar_layout(&json!({
            "groups": [
                {"id": "group-a", "name": "Group A"},
                {"id": "group-nested", "name": "Nested"}
            ],
            "order": [
                {"type": "group", "id": "group-a", "children": [
                    {"type": "connection", "id": "conn-a"},
                    {"type": "group", "id": "group-nested", "children": [
                        {"type": "connection", "id": "conn-b"}
                    ]}
                ]},
                {"type": "connection", "id": "conn-c"}
            ]
        }))
        .await
        .unwrap();

    let (status, body) = get_json(&app, "/api/admin/scope-tree", Some(&token)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body["nodes"][0]["type"], json!("group"));
    assert_eq!(body["nodes"][0]["id"], json!("group-a"));
    assert_eq!(body["nodes"][0]["children"][0], json!({"type": "connection", "id": "conn-a", "name": "Connection A"}));
    assert_eq!(body["nodes"][0]["children"][1]["type"], json!("group"));
    assert_eq!(body["nodes"][0]["children"][1]["children"][0]["id"], json!("conn-b"));
    assert_eq!(body["ungrouped"], json!([{"type": "connection", "id": "conn-c", "name": "Connection C"}]));
}
