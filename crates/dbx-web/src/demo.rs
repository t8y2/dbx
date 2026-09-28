//! `DBX_DEMO_MODE` 守卫：面向公网演示部署封锁会改变服务器状态、或让服务器向
//! 任意端点发起连接的入口。默认关闭，行为与常规部署完全一致。
//!
//! 封锁面分两类：
//! 1. `demo_mode_gate` 中间件按路径拦截：凭据改写（auth/setup、cloud-sync、AI
//!    供应商配置）、插件/JDBC/驱动安装（sidecar 原生进程 = 远程代码执行）、纯
//!    探测端点（connection/test*、mq/nacos test-connection、tunnel-profiles/test
//!    —— body 携带完整连接配置，等于 SSRF）。
//! 2. `connection/connect` 不整体封锁（演示访客必须能连上预置连接），改为
//!    `ensure_demo_connect_allowed`：请求体里的连接 id 必须已保存，且端点身份
//!    与保存值一致，防止伪造 body 把服务器拨向任意主机。

use std::sync::Arc;

use axum::extract::State;
use axum::http::{Method, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use dbx_core::connection::{connection_configs_session_credentials_compatible, AppState};
use dbx_core::models::connection::ConnectionConfig;

use crate::auth::middleware_api_path_suffix;
use crate::state::WebState;

pub(crate) const DEMO_CONNECT_REJECTED: &str = "Demo mode only allows connecting to the pre-configured connections";

pub fn demo_mode_from_env() -> bool {
    demo_mode_from_env_value(std::env::var("DBX_DEMO_MODE").ok().as_deref())
}

pub fn demo_mode_from_env_value(value: Option<&str>) -> bool {
    value.map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on")).unwrap_or(false)
}

/// 无论方法一律拦截的路径（对应路由本身只注册了这一种方法）。
const BLOCKED_EXACT: &[&str] = &[
    // 访客不得抢先设置或改写演示实例口令
    "auth/setup",
    "auth/change-password",
    // 纯探测端点：body 携带完整连接配置，服务器会拨向任意主机
    "connection/test",
    "connection/test-info",
    "connection/test-ssh-tunnel",
    "mq/test-connection",
    "nacos/test-connection",
    "tunnel-profiles/test",
    // 演示连接清单只读：整表覆盖会互删，新增等于 SSRF
    "connection/save",
    "connection/mcp/add",
    "connection/mcp/duplicate",
    "connection/mcp/remove",
    "tunnel-profiles/save",
    // 已存连接凭据解密出口
    "app-settings/config/decrypt",
    // 演示实例不得开放可访问全部连接的 MCP bearer token
    "app-settings/mcp-http",
    "app-settings/mcp-http/rotate-token",
    // 读取服务器本地 ~/.ssh/config
    "ssh/config-hosts",
    // 插件数据访问授权写入（插件读取已存连接数据的许可）
    "plugin/data/grant",
];

/// 非 GET 请求整族拦截的前缀：插件/JDBC/驱动安装与运行时控制、云同步外发通道。
/// GET 保持放行（商店浏览、已装列表、安装进度）。
const BLOCKED_MUTATING_PREFIXES: &[&str] = &["plugins/", "jdbc/", "agents/", "cloud-sync/"];

/// AI 供应商配置写入与按配置外呼的端点（无配置时本就不可用，一并封锁防止访客
/// 自带 key 配置后把服务器当外呼跳板）。会话、取消与只读 GET 不受影响。
const BLOCKED_AI_EXACT: &[&str] = &[
    "ai/config",
    "ai/provider-config",
    "ai/configs",
    "ai/default-config",
    "ai/config-item",
    "ai/chat-selection",
    "ai/complete",
    "ai/stream",
    "ai/agent-stream",
    "ai/test-connection",
    "ai/models",
    "ai/model-effort",
    // 允许内置 AI 调用插件工具的开关；预览会拉起插件 sidecar
    "ai/plugin-tools/plugins",
    "ai/plugin-tools/preview",
];

pub(crate) fn is_demo_blocked(method: &Method, suffix: &str) -> bool {
    if BLOCKED_EXACT.contains(&suffix) {
        return true;
    }
    if method != Method::GET {
        if BLOCKED_MUTATING_PREFIXES.iter().any(|prefix| suffix.starts_with(prefix)) {
            return true;
        }
        // DELETE /ai/config/{config_id}
        if suffix.starts_with("ai/config/") {
            return true;
        }
    }
    method != Method::GET && BLOCKED_AI_EXACT.contains(&suffix)
}

pub async fn demo_mode_gate(
    State(state): State<Arc<WebState>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    if state.demo_mode {
        let suffix = middleware_api_path_suffix(request.uri().path(), &state.public_base_path);
        if suffix.is_some_and(|suffix| is_demo_blocked(request.method(), suffix)) {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "code": "DEMO_MODE_DISABLED",
                    "message": "This operation is disabled in demo mode"
                })),
            )
                .into_response();
        }
    }
    next.run(request).await
}

/// 演示模式下 `/connection/connect` 的准入：连接必须已保存，且请求体的端点身份
/// 与保存值一致（忽略密码与当前选库）。凭据解析仍走原路径，存储里的预置连接
/// 密码照常生效。
pub(crate) async fn ensure_demo_connect_allowed(app: &AppState, config: &ConnectionConfig) -> Result<(), String> {
    let stored = app
        .storage
        .load_connections()
        .await
        .map_err(|error| format!("Failed to load connections: {error}"))?
        .into_iter()
        .find(|stored| stored.id == config.id);
    match stored {
        Some(stored) if demo_connect_endpoint_matches(&stored, config) => Ok(()),
        _ => Err(DEMO_CONNECT_REJECTED.to_string()),
    }
}

fn demo_connect_endpoint_matches(stored: &ConnectionConfig, requested: &ConnectionConfig) -> bool {
    let mut stored = stored.clone();
    let mut requested = requested.clone();
    // 密码以存储为准、选库是会话级选择，两者不参与端点身份比较。
    stored.save_password = false;
    requested.save_password = false;
    stored.password.clear();
    requested.password.clear();
    stored.database = None;
    requested.database = None;
    connection_configs_session_credentials_compatible(&stored, &requested)
}

#[cfg(test)]
mod tests {
    use super::{
        demo_connect_endpoint_matches, demo_mode_from_env_value, ensure_demo_connect_allowed, is_demo_blocked,
    };
    use axum::http::Method;
    use dbx_core::models::connection::ConnectionConfig;

    fn config(json: serde_json::Value) -> ConnectionConfig {
        serde_json::from_value(json).unwrap()
    }

    fn stored_config() -> ConnectionConfig {
        config(serde_json::json!({
            "id": "demo-pg",
            "name": "Demo PostgreSQL",
            "db_type": "postgres",
            "host": "demo-postgres",
            "port": 5432,
            "username": "demo",
            "password": "stored-secret",
            "database": "dvdrental",
            "save_password": true
        }))
    }

    #[test]
    fn demo_env_flag_accepts_common_truthy_spellings_only() {
        for value in ["1", "true", "TRUE", " Yes ", "on"] {
            assert!(demo_mode_from_env_value(Some(value)), "expected truthy: {value}");
        }
        for value in [None, Some(""), Some("0"), Some("false"), Some("off"), Some("demo")] {
            assert!(!demo_mode_from_env_value(value), "expected falsy: {value:?}");
        }
    }

    #[test]
    fn demo_gate_blocks_credential_plugin_and_probe_routes() {
        let blocked = [
            (Method::POST, "auth/setup"),
            (Method::POST, "auth/change-password"),
            (Method::POST, "connection/test"),
            (Method::POST, "connection/test-info"),
            (Method::POST, "connection/test-ssh-tunnel"),
            (Method::POST, "connection/save"),
            (Method::POST, "connection/mcp/add"),
            (Method::POST, "mq/test-connection"),
            (Method::POST, "nacos/test-connection"),
            (Method::POST, "tunnel-profiles/test"),
            (Method::POST, "tunnel-profiles/save"),
            (Method::POST, "app-settings/config/decrypt"),
            (Method::GET, "ssh/config-hosts"),
            (Method::POST, "plugins/install"),
            (Method::POST, "plugins/marketplace/install"),
            (Method::POST, "plugins/uninstall"),
            (Method::POST, "plugins/trusted-keys/save"),
            (Method::POST, "plugins/filesystem/write"),
            (Method::POST, "jdbc/plugin/install"),
            (Method::POST, "jdbc/plugin/install-local"),
            (Method::DELETE, "jdbc/drivers/maven/bundle-1"),
            (Method::POST, "agents/install"),
            (Method::POST, "agents/import-offline"),
            (Method::POST, "agents/runtime/stop"),
            (Method::POST, "cloud-sync/webdav/upload"),
            (Method::POST, "cloud-sync/snippet/save-token"),
            (Method::POST, "ai/config"),
            (Method::POST, "ai/provider-config"),
            (Method::POST, "ai/stream"),
            (Method::POST, "ai/test-connection"),
            (Method::DELETE, "ai/config/cfg-1"),
        ];
        for (method, suffix) in blocked {
            assert!(is_demo_blocked(&method, suffix), "expected blocked: {method} {suffix}");
        }
    }

    #[test]
    fn demo_gate_keeps_readonly_and_demo_core_routes_open() {
        let allowed = [
            (Method::GET, "connection/list"),
            (Method::POST, "connection/connect"),
            (Method::POST, "connection/disconnect"),
            (Method::POST, "query/execute"),
            (Method::POST, "query/cancel"),
            (Method::GET, "plugins"),
            (Method::GET, "plugins/marketplace/catalogs"),
            (Method::GET, "agents/installed"),
            (Method::GET, "agents/progress/op-1"),
            (Method::POST, "history/save"),
            (Method::DELETE, "history/entry-1"),
            (Method::POST, "saved-sql"),
            (Method::POST, "ai/conversation"),
            (Method::POST, "ai/cancel-stream"),
            (Method::GET, "ai/config"),
            (Method::POST, "app-settings/mcp-policy"),
            (Method::POST, "plugin/table-metadata"),
            (Method::POST, "migration/start"),
            (Method::POST, "database-backups"),
            (Method::POST, "schema/cache"),
            (Method::DELETE, "schema/cache-prefix"),
            (Method::POST, "redis/set-string"),
            (Method::POST, "mongo/find-documents"),
            (Method::POST, "consul/txn"),
            (Method::POST, "export/table"),
            (Method::POST, "import/preview"),
        ];
        for (method, suffix) in allowed {
            assert!(!is_demo_blocked(&method, suffix), "expected allowed: {method} {suffix}");
        }
    }

    #[test]
    fn demo_connect_endpoint_match_ignores_password_and_selected_database() {
        let stored = stored_config();
        let requested = config(serde_json::json!({
            "id": "demo-pg",
            "name": "Demo PostgreSQL",
            "db_type": "postgres",
            "host": "demo-postgres",
            "port": 5432,
            "username": "demo",
            "password": "",
            "database": "postgres",
            "save_password": true
        }));
        assert!(demo_connect_endpoint_matches(&stored, &requested));
    }

    #[test]
    fn demo_connect_endpoint_match_rejects_endpoint_and_transport_changes() {
        let stored = stored_config();

        let hijacked_host = config(serde_json::json!({
            "id": "demo-pg",
            "name": "Demo PostgreSQL",
            "db_type": "postgres",
            "host": "internal-bastion",
            "port": 5432,
            "username": "demo",
            "password": ""
        }));
        assert!(!demo_connect_endpoint_matches(&stored, &hijacked_host));

        let mut smuggled_tunnel = stored_config();
        smuggled_tunnel.password.clear();
        smuggled_tunnel.transport_layers = vec![serde_json::from_value(serde_json::json!({
            "type": "ssh",
            "id": "smuggled",
            "enabled": true,
            "host": "internal-bastion",
            "port": 22,
            "user": "root"
        }))
        .unwrap()];
        assert!(!demo_connect_endpoint_matches(&stored, &smuggled_tunnel));
    }

    #[tokio::test]
    async fn demo_connect_guard_requires_a_pool_equivalent_stored_connection() {
        let directory = tempfile::tempdir().unwrap();
        let storage =
            dbx_core::persistence::test_storage::open_unmigrated(&directory.path().join("dbx.db")).await.unwrap();
        let app = std::sync::Arc::new(dbx_core::connection::AppState::new(storage));

        let unknown = stored_config();
        let error = ensure_demo_connect_allowed(&app, &unknown).await.unwrap_err();
        assert_eq!(error, super::DEMO_CONNECT_REJECTED);

        app.storage.save_connections(&[stored_config()]).await.unwrap();

        let mut tampered = stored_config();
        tampered.host = "evil.example.com".to_string();
        assert_eq!(ensure_demo_connect_allowed(&app, &tampered).await.unwrap_err(), super::DEMO_CONNECT_REJECTED);

        let mut legitimate = stored_config();
        legitimate.password.clear();
        legitimate.database = Some("postgres".to_string());
        ensure_demo_connect_allowed(&app, &legitimate).await.unwrap();
    }

    #[tokio::test]
    async fn demo_gate_returns_forbidden_only_when_enabled() {
        use axum::routing::{get, post};

        let directory = tempfile::tempdir().unwrap();
        let storage =
            dbx_core::persistence::test_storage::open_unmigrated(&directory.path().join("dbx.db")).await.unwrap();
        let app = std::sync::Arc::new(dbx_core::connection::AppState::new(storage));
        let state = {
            let mut web_state = crate::state::WebState::for_tests(app, directory.path().to_path_buf());
            web_state.demo_mode = true;
            std::sync::Arc::new(web_state)
        };
        let router = axum::Router::new()
            .route("/api/plugins/install", post(|| async { "install" }))
            .route("/api/connection/list", get(|| async { "connections" }))
            .layer(axum::middleware::from_fn_with_state(state.clone(), super::demo_mode_gate));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();

        let blocked = client.post(format!("http://{address}/api/plugins/install")).send().await.unwrap();
        assert_eq!(blocked.status(), reqwest::StatusCode::FORBIDDEN);
        let payload = blocked.json::<serde_json::Value>().await.unwrap();
        assert_eq!(payload["code"], "DEMO_MODE_DISABLED");
        assert_eq!(payload["message"], "This operation is disabled in demo mode");

        let allowed = client.get(format!("http://{address}/api/connection/list")).send().await.unwrap();
        assert_eq!(allowed.status(), reqwest::StatusCode::OK);
        assert_eq!(allowed.text().await.unwrap(), "connections");

        server.abort();

        // 关闭开关后同一中间件直接放行。
        let app = std::sync::Arc::new(dbx_core::connection::AppState::new(
            dbx_core::persistence::test_storage::open_unmigrated(&directory.path().join("dbx.db")).await.unwrap(),
        ));
        let state = std::sync::Arc::new(crate::state::WebState::for_tests(app, directory.path().to_path_buf()));
        let router = axum::Router::new()
            .route("/api/plugins/install", post(|| async { "install" }))
            .layer(axum::middleware::from_fn_with_state(state, super::demo_mode_gate));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let response = client.post(format!("http://{address}/api/plugins/install")).send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "install");
        server.abort();
    }
}
