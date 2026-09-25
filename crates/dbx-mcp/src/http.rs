use std::{io, sync::Arc};

use axum::{http::Method, middleware, routing::get, Router};
use rmcp::transport::{
    streamable_http_server::{
        session::{local::LocalSessionManager, SessionManager},
        tower::StreamableHttpService,
    },
    StreamableHttpServerConfig,
};
use tokio_util::sync::CancellationToken;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::{
    diagnostics::health,
    http_auth::{authorize_request, HttpAuth},
    runtime::HttpRuntimeConfig,
    DbxBackend, DbxMcpServer, McpScope,
};

/// Builds a protected Streamable HTTP MCP router for embedding in an existing
/// HTTP server. The embedded host remains responsible for choosing the public
/// listener and lifecycle; this router only owns the `/mcp` protocol route.
pub fn streamable_http_router(
    backend: Arc<dyn DbxBackend>,
    path: &str,
    auth: HttpAuth,
    allowed_hosts: Vec<String>,
    web_mode: bool,
) -> Router {
    build_streamable_http_router(backend, path, auth, allowed_hosts, web_mode, None, Default::default())
}

fn build_streamable_http_router(
    backend: Arc<dyn DbxBackend>,
    path: &str,
    auth: HttpAuth,
    allowed_hosts: Vec<String>,
    web_mode: bool,
    cancellation: Option<CancellationToken>,
    session_manager: Arc<LocalSessionManager>,
) -> Router {
    let mut rmcp_config = StreamableHttpServerConfig::default().with_allowed_hosts(allowed_hosts);
    if let Some(cancellation) = cancellation {
        rmcp_config = rmcp_config.with_cancellation_token(cancellation);
    }
    let server_backend = backend.clone();
    let scope = McpScope::from_env();
    let service: StreamableHttpService<DbxMcpServer, LocalSessionManager> = StreamableHttpService::new(
        move || Ok(DbxMcpServer::with_runtime_options(server_backend.clone(), scope.clone(), web_mode)),
        session_manager,
        rmcp_config,
    );

    // The authentication middleware and CORS response must use the same
    // predicate. In particular, loopback desktop mode permits localhost
    // browser origins without requiring users to enumerate every development
    // port, while remote mode still requires exact configured origins.
    let cors_auth = auth.clone();
    let router =
        Router::new().nest_service(path, service).layer(middleware::from_fn_with_state(auth, authorize_request));
    router.layer(
        CorsLayer::new()
            .allow_origin(AllowOrigin::predicate(move |origin, _| {
                origin.to_str().is_ok_and(|origin| cors_auth.origin_is_allowed(origin))
            }))
            .allow_methods([Method::GET, Method::POST, Method::DELETE])
            .allow_headers(Any),
    )
}

/// Serves one stateful rmcp Streamable HTTP endpoint. Every MCP protocol
/// session receives a fresh `DbxMcpServer`, while the database backend remains
/// shared and all authorization happens before rmcp sees a request.
pub async fn serve_streamable_http(backend: Arc<dyn DbxBackend>, config: HttpRuntimeConfig) -> io::Result<()> {
    let cancellation = CancellationToken::new();
    let shutdown = cancellation.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown.cancel();
    });
    serve_streamable_http_with_shutdown(backend, config, cancellation).await
}

/// Serves the HTTP transport until `cancellation` is cancelled. Embedding
/// hosts use this variant so their own lifecycle controls shutdown instead of
/// relying on a process-wide Ctrl-C handler.
pub async fn serve_streamable_http_with_shutdown(
    backend: Arc<dyn DbxBackend>,
    config: HttpRuntimeConfig,
    cancellation: CancellationToken,
) -> io::Result<()> {
    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    serve_streamable_http_on_listener(backend, config, cancellation, listener).await
}

/// Variant for hosts that must bind synchronously before reporting the server
/// as healthy (for example, DBX Desktop settings UI).
pub async fn serve_streamable_http_on_listener(
    backend: Arc<dyn DbxBackend>,
    config: HttpRuntimeConfig,
    cancellation: CancellationToken,
    listener: tokio::net::TcpListener,
) -> io::Result<()> {
    let session_manager = Arc::new(LocalSessionManager::default());
    let mcp_router = build_streamable_http_router(
        backend,
        &config.path,
        config.auth,
        config.allowed_hosts,
        false,
        Some(cancellation.child_token()),
        session_manager.clone(),
    );
    let router = Router::new().route("/healthz", get(health)).route("/readyz", get(health)).merge(mcp_router);

    eprintln!("DBX MCP Streamable HTTP listening on http://{}{}", config.bind_addr, config.path);

    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            cancellation.cancelled().await;
        })
        .await;
    close_local_sessions_bounded(&session_manager).await;
    result
}

async fn close_local_sessions_bounded(session_manager: &Arc<LocalSessionManager>) {
    let session_ids = session_manager.sessions.read().await.keys().cloned().collect::<Vec<_>>();
    let cleanup = async {
        for session_id in session_ids {
            let _ = session_manager.close_session(&session_id).await;
        }
    };
    if tokio::time::timeout(std::time::Duration::from_secs(10), cleanup).await.is_err() {
        log::warn!("Timed out draining MCP HTTP protocol sessions during shutdown");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use dbx_core::{
        agent_events::ToolResult, agent_tools::AgentSqlPermissions, models::connection::ConnectionConfig,
        storage::McpGlobalPolicy,
    };
    use rmcp::{
        model::CallToolRequestParams,
        service::ServiceExt,
        transport::{
            streamable_http_client::StreamableHttpClientTransportConfig,
            streamable_http_server::session::local::SessionConfig, StreamableHttpClientTransport,
        },
    };
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;
    use crate::{
        backend::DbxBackend,
        transaction::{
            TransactionIo, TransactionIoError, TransactionIoSuccess, TransactionOwner, TransactionOwnerConfig,
        },
    };

    struct HttpTestIo {
        sql: Arc<std::sync::Mutex<Vec<String>>>,
        disconnects: Arc<AtomicUsize>,
        in_transaction: bool,
    }

    #[async_trait]
    impl TransactionIo for HttpTestIo {
        async fn execute(
            &mut self,
            sql: &str,
            _max_rows: Option<usize>,
        ) -> Result<TransactionIoSuccess, TransactionIoError> {
            self.sql.lock().unwrap().push(sql.to_string());
            match sql {
                "START TRANSACTION" => self.in_transaction = true,
                "COMMIT" | "ROLLBACK" => self.in_transaction = false,
                _ => {}
            }
            Ok(TransactionIoSuccess {
                result: dbx_core::db::QueryResult {
                    columns: Vec::new(),
                    column_types: Vec::new(),
                    column_sortables: Vec::new(),
                    spatial_columns: Vec::new(),
                    spatial_values: Vec::new(),
                    rows: Vec::new(),
                    affected_rows: 0,
                    execution_time_ms: 0,
                    server_execute_time_us: None,
                    query_timings_ms: None,
                    truncated: false,
                    session_id: None,
                    has_more: false,
                    elasticsearch_raw_body: None,
                    messages: Vec::new(),
                },
                in_transaction: self.in_transaction,
            })
        }

        async fn ping_in_transaction(&mut self) -> Result<bool, TransactionIoError> {
            Ok(self.in_transaction)
        }

        async fn disconnect(&mut self) {
            self.disconnects.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct HttpTestBackend {
        connection: ConnectionConfig,
        sql: Arc<std::sync::Mutex<Vec<String>>>,
        disconnects: Arc<AtomicUsize>,
    }

    impl HttpTestBackend {
        fn new() -> Self {
            Self {
                connection: serde_json::from_value(json!({
                    "id": "mysql",
                    "name": "mysql",
                    "db_type": "mysql",
                    "host": "",
                    "port": 3306,
                    "username": "",
                    "password": "",
                    "database": "app",
                    "ssl": false
                }))
                .unwrap(),
                sql: Arc::new(std::sync::Mutex::new(Vec::new())),
                disconnects: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    #[async_trait]
    impl DbxBackend for HttpTestBackend {
        async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
            Ok(McpGlobalPolicy { read_only: false, allow_dangerous_sql: true, ..Default::default() })
        }

        async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
            Ok(vec![self.connection.clone()])
        }

        async fn execute_agent_tool(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            tool_name: &str,
            _arguments: Value,
            _permissions: AgentSqlPermissions,
        ) -> ToolResult {
            ToolResult {
                tool_call_id: "http-test".to_string(),
                tool_name: tool_name.to_string(),
                content: "unused".to_string(),
                is_error: false,
                explain_data: None,
            }
        }

        async fn open_transaction_owner(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            _client_session_id: &str,
        ) -> Result<Arc<TransactionOwner>, String> {
            Ok(TransactionOwner::spawn(
                HttpTestIo { sql: self.sql.clone(), disconnects: self.disconnects.clone(), in_transaction: false },
                TransactionOwnerConfig { cleanup_timeout: std::time::Duration::from_millis(50), ..Default::default() },
            ))
        }

        async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
            Ok(config)
        }
        async fn duplicate_connection_for_mcp(
            &self,
            _source_id: &str,
            _copy_id: &str,
            _copy_name: &str,
        ) -> Result<ConnectionConfig, String> {
            Err("unused".to_string())
        }
        async fn remove_connection_for_mcp(&self, _connection_id: &str) -> Result<bool, String> {
            Ok(false)
        }
    }

    async fn start_http_test_server(
        backend: Arc<HttpTestBackend>,
        keep_alive: std::time::Duration,
    ) -> (String, Arc<LocalSessionManager>, CancellationToken, tokio::task::JoinHandle<()>) {
        // A single default provider avoids the "No rustls crypto provider is
        // configured" panic when tests build reqwest clients in workspace
        // builds where multiple rustls crypto features are present; the
        // install is idempotent, so subsequent calls are no-ops.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut session_config = SessionConfig::default();
        session_config.keep_alive = Some(keep_alive);
        let mut local_manager = LocalSessionManager::default();
        local_manager.session_config = session_config;
        let manager = Arc::new(local_manager);
        let cancellation = CancellationToken::new();
        let router = build_streamable_http_router(
            backend,
            "/mcp",
            HttpAuth::new("http-test-token".to_string(), Vec::<String>::new(), true).unwrap(),
            vec![address.to_string()],
            false,
            Some(cancellation.child_token()),
            manager.clone(),
        );
        let shutdown = cancellation.clone();
        let shutdown_manager = manager.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await
                .unwrap();
            close_local_sessions_bounded(&shutdown_manager).await;
        });
        (format!("http://{address}/mcp"), manager, cancellation, task)
    }

    async fn open_active_transaction(url: &str) -> (rmcp::service::RunningService<rmcp::RoleClient, ()>, String) {
        let transport = StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(url.to_string()).auth_header("http-test-token"),
        );
        let client = ().serve(transport).await.unwrap();
        let opened = client
            .call_tool(
                CallToolRequestParams::new("dbx_open_session").with_arguments(
                    serde_json::from_value(json!({
                        "connection_id": "mysql",
                        "database": "app",
                        "enable_transactions": true
                    }))
                    .unwrap(),
                ),
            )
            .await
            .unwrap();
        let session_id = opened.structured_content.unwrap()["session_id"].as_str().unwrap().to_string();
        let begun = client
            .call_tool(
                CallToolRequestParams::new("dbx_begin_transaction")
                    .with_arguments(serde_json::from_value(json!({"session_id": session_id.clone()})).unwrap()),
            )
            .await
            .unwrap();
        assert_ne!(begun.is_error, Some(true));
        (client, session_id)
    }

    async fn wait_for_disposal(backend: &HttpTestBackend) {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if backend.disconnects.load(Ordering::SeqCst) == 1
                    && backend.sql.lock().unwrap().iter().any(|sql| sql == "ROLLBACK")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("HTTP session cleanup must roll back and disconnect the owner");
    }

    async fn open_and_drop_raw_sse(url: &str, outer_session_id: &str) {
        let parsed = url::Url::parse(url).unwrap();
        let host = parsed.host_str().unwrap();
        let port = parsed.port_or_known_default().unwrap();
        let mut stream = tokio::net::TcpStream::connect((host, port)).await.unwrap();
        let path = match parsed.query() {
            Some(query) => format!("{}?{query}", parsed.path()),
            None => parsed.path().to_string(),
        };
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Bearer http-test-token\r\nAccept: text/event-stream\r\nMcp-Session-Id: {outer_session_id}\r\nMcp-Protocol-Version: 2025-06-18\r\nConnection: keep-alive\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();

        let headers = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            let mut response = Vec::new();
            let mut buffer = [0_u8; 1024];
            loop {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0, "raw SSE connection closed before HTTP headers");
                response.extend_from_slice(&buffer[..read]);
                if response.windows(4).any(|window| window == b"\r\n\r\n") {
                    break response;
                }
                assert!(response.len() <= 16 * 1024, "raw SSE response headers exceeded 16 KiB");
            }
        })
        .await
        .expect("raw SSE GET must return HTTP headers");
        let headers = std::str::from_utf8(&headers).unwrap();
        assert!(headers.starts_with("HTTP/1.1 200 "), "raw SSE GET did not return HTTP 200: {headers}");
        assert!(headers.to_ascii_lowercase().contains("content-type: text/event-stream"));

        drop(stream);
    }

    #[tokio::test]
    async fn authenticated_http_delete_rolls_back_and_disconnects_inner_owner() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, manager, cancellation, server_task) =
            start_http_test_server(backend.clone(), std::time::Duration::from_secs(30)).await;
        let (client, _) = open_active_transaction(&url).await;
        let outer_session_id = manager.sessions.read().await.keys().next().unwrap().to_string();

        let response = reqwest::Client::new()
            .delete(&url)
            .bearer_auth("http-test-token")
            .header("mcp-session-id", outer_session_id)
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success(), "DELETE returned {}", response.status());
        wait_for_disposal(&backend).await;

        drop(client);
        cancellation.cancel();
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn http_inactivity_expiry_rolls_back_and_disconnects_inner_owner() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, manager, cancellation, server_task) =
            start_http_test_server(backend.clone(), std::time::Duration::from_millis(500)).await;
        let (client, _) = open_active_transaction(&url).await;

        wait_for_disposal(&backend).await;
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !manager.sessions.read().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("expired outer HTTP session must be removed");

        drop(client);
        cancellation.cancel();
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn transient_http_connections_preserve_one_outer_session() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, manager, cancellation, server_task) =
            start_http_test_server(backend.clone(), std::time::Duration::from_secs(30)).await;
        let (client, inner_session_id) = open_active_transaction(&url).await;
        let outer_session_id = manager.sessions.read().await.keys().next().unwrap().to_string();

        open_and_drop_raw_sse(&url, &outer_session_id).await;

        let query = client
            .call_tool(
                CallToolRequestParams::new("dbx_execute_query").with_arguments(
                    serde_json::from_value(json!({
                        "connection_id": "mysql",
                        "database": "app",
                        "session_id": inner_session_id,
                        "sql": "SELECT 1"
                    }))
                    .unwrap(),
                ),
            )
            .await
            .unwrap();
        assert_ne!(query.is_error, Some(true));
        assert_eq!(query.structured_content.as_ref().unwrap()["transaction_state"], "active");
        assert_eq!(manager.sessions.read().await.len(), 1);
        assert_eq!(backend.disconnects.load(Ordering::SeqCst), 0);
        assert!(!backend.sql.lock().unwrap().iter().any(|sql| sql == "ROLLBACK"));

        let response = reqwest::Client::new()
            .delete(&url)
            .bearer_auth("http-test-token")
            .header("mcp-session-id", outer_session_id)
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        wait_for_disposal(&backend).await;
        drop(client);
        cancellation.cancel();
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn http_service_shutdown_rolls_back_and_disconnects_inner_owner() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, _manager, cancellation, server_task) =
            start_http_test_server(backend.clone(), std::time::Duration::from_secs(30)).await;
        let (client, _) = open_active_transaction(&url).await;

        cancellation.cancel();
        server_task.await.unwrap();
        wait_for_disposal(&backend).await;
        drop(client);
    }
}
