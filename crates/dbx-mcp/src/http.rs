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

/// HTTP-only wrapper: all protocol requests retain their admission permit
/// until the operation finishes and are canceled at the authenticated deadline.
/// Stdio behavior and the core DBX permission gates remain unchanged.
struct BoundedHttpService(DbxMcpServer);

impl rmcp::Service<rmcp::RoleServer> for BoundedHttpService {
    async fn handle_request(
        &self,
        request: rmcp::model::ClientRequest,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<rmcp::model::ServerResult, rmcp::ErrorData> {
        let lease = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<crate::http_auth::HttpRequestDeadline>())
            .cloned()
            .ok_or_else(|| rmcp::ErrorData::internal_error("Missing authenticated HTTP request context", None))?;
        let cancellation = context.ct.clone();
        tokio::select! {
            result = rmcp::Service::handle_request(&self.0, request, context) => result,
            _ = cancellation.cancelled() => Err(rmcp::ErrorData::internal_error("MCP request cancelled", None)),
            _ = tokio::time::sleep_until(lease.deadline) => Err(rmcp::ErrorData::internal_error("Authenticated HTTP request deadline expired", None)),
        }
    }

    async fn handle_notification(
        &self,
        notification: rmcp::model::ClientNotification,
        context: rmcp::service::NotificationContext<rmcp::RoleServer>,
    ) -> Result<(), rmcp::ErrorData> {
        rmcp::Service::handle_notification(&self.0, notification, context).await
    }

    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::Service::get_info(&self.0)
    }
}

/// Builds a protected Streamable HTTP MCP router for embedding in an existing
/// HTTP server. The embedded host remains responsible for choosing the public
/// listener and lifecycle; this router only owns the `/mcp` protocol route.
pub fn streamable_http_router(
    backend: Arc<dyn DbxBackend>,
    path: &str,
    auth: HttpAuth,
    allowed_hosts: Vec<String>,
    web_mode: bool,
) -> Result<Router, String> {
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
) -> Result<Router, String> {
    auth.set_allowed_hosts(allowed_hosts.clone())?;
    // Web settings update the shared policy without rebuilding the router.
    // Keep rmcp's existing checks for the standalone server.
    let mut rmcp_config = if web_mode {
        StreamableHttpServerConfig::default().disable_allowed_hosts().disable_allowed_origins()
    } else {
        StreamableHttpServerConfig::default().with_allowed_hosts(allowed_hosts).disable_allowed_origins()
    };
    if let Some(cancellation) = cancellation {
        rmcp_config = rmcp_config.with_cancellation_token(cancellation);
    }
    // Tie bookkeeping expiry/rotation to physical SDK cleanup, including
    // transaction rollback and pending handler cancellation. A weak reference
    // ensures the maintenance task ends when the router is dropped.
    auth.attach_manager(&session_manager);
    let cleanup_manager = Arc::downgrade(&session_manager);
    let cleanup_auth = auth.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            interval.tick().await;
            let Some(manager) = cleanup_manager.upgrade() else {
                break;
            };
            cleanup_auth.reap_sessions(&manager).await;
        }
    });
    let server_backend = backend.clone();
    let scope = McpScope::from_env();
    let service: StreamableHttpService<BoundedHttpService, LocalSessionManager> = StreamableHttpService::new(
        move || {
            Ok(BoundedHttpService(DbxMcpServer::with_runtime_options(server_backend.clone(), scope.clone(), web_mode)))
        },
        session_manager,
        rmcp_config,
    );

    // The authentication middleware and CORS response must use the same
    // predicate. In particular, loopback desktop mode permits localhost
    // browser origins without requiring users to enumerate every development
    // port, while remote mode still requires exact configured origins.
    let cors_auth = auth.clone();
    let oauth = auth.oauth();
    let router =
        Router::new().nest_service(path, service).layer(middleware::from_fn_with_state(auth, authorize_request));
    let router = if let Some(oauth) = oauth {
        let metadata = oauth.metadata();
        // Discovery is public; it contains only operator-provided URLs/scopes.
        router.route(oauth.metadata_path(), get(move || async move { axum::Json(metadata) }))
    } else {
        router
    };
    Ok(router.layer(
        CorsLayer::new()
            .allow_origin(AllowOrigin::predicate(move |origin, _| {
                origin.to_str().is_ok_and(|origin| cors_auth.origin_is_allowed(origin))
            }))
            .allow_methods([Method::GET, Method::POST, Method::DELETE])
            .allow_headers(Any)
            .expose_headers([
                axum::http::HeaderName::from_static("mcp-session-id"),
                axum::http::HeaderName::from_static("mcp-protocol-version"),
                axum::http::header::WWW_AUTHENTICATE,
            ]),
    ))
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
    )
    .map_err(io::Error::other)?;
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
        read_only: bool,
        slow_load: Arc<std::sync::atomic::AtomicBool>,
        running_load: Arc<AtomicUsize>,
        connection: ConnectionConfig,
        sql: Arc<std::sync::Mutex<Vec<String>>>,
        disconnects: Arc<AtomicUsize>,
    }

    impl HttpTestBackend {
        fn new() -> Self {
            Self {
                read_only: false,
                slow_load: Default::default(),
                running_load: Default::default(),
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
            Ok(McpGlobalPolicy { read_only: self.read_only, allow_dangerous_sql: true, ..Default::default() })
        }

        async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
            if self.slow_load.load(Ordering::SeqCst) {
                struct Running(Arc<AtomicUsize>);
                impl Drop for Running {
                    fn drop(&mut self) {
                        self.0.fetch_sub(1, Ordering::SeqCst);
                    }
                }
                self.running_load.fetch_add(1, Ordering::SeqCst);
                let _running = Running(self.running_load.clone());
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            }
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
        )
        .unwrap();
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
    #[tokio::test]
    async fn oauth_http_discovery_authorization_isolation_limits_and_read_only() {
        use crate::oauth::test_issuer::issuer;
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let issuer = issuer();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut backend = HttpTestBackend::new();
        backend.read_only = true;
        let backend = Arc::new(backend);
        let manager = Arc::new(LocalSessionManager::default());
        let cancellation = CancellationToken::new();
        let auth = HttpAuth::new_oauth(issuer.verifier(), vec![address.to_string()], vec![]).unwrap();
        let router = build_streamable_http_router(
            backend.clone(),
            "/mcp",
            auth.clone(),
            vec![address.to_string()],
            false,
            Some(cancellation.child_token()),
            manager.clone(),
        )
        .unwrap();
        let stop = cancellation.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).with_graceful_shutdown(async move { stop.cancelled().await }).await.unwrap();
        });
        let base = format!("http://{address}");
        let url = format!("{base}/mcp");
        let http = reqwest::Client::new();
        let discovery = http.get(format!("{base}/.well-known/oauth-protected-resource/mcp")).send().await.unwrap();
        assert_eq!(discovery.status(), 200);
        assert_eq!(discovery.json::<Value>().await.unwrap()["resource"], "https://dbx.example.test/mcp");
        for token in [None, Some("wrong".to_owned())] {
            let mut request = http.post(&url);
            if let Some(token) = token {
                request = request.bearer_auth(token);
            }
            let response = request.body("{}").send().await.unwrap();
            assert_eq!(response.status(), 401);
            assert!(response.headers()["www-authenticate"].to_str().unwrap().contains("resource_metadata="));
        }
        for field in ["iss", "aud", "exp"] {
            let mut claims = issuer.claims("owner");
            claims[field] = if field == "exp" { json!(1) } else { json!("https://wrong.example.test") };
            assert_eq!(
                http.post(&url).bearer_auth(issuer.sign(&claims)).body("{}").send().await.unwrap().status(),
                401
            );
        }
        assert_eq!(
            http.post(&url).bearer_auth(issuer.token("uninvited")).body("{}").send().await.unwrap().status(),
            403
        );
        let mut no_scope = issuer.claims("owner");
        no_scope["scope"] = json!("openid");
        let denied = http.post(&url).bearer_auth(issuer.sign(&no_scope)).body("{}").send().await.unwrap();
        assert_eq!(denied.status(), 403);
        assert!(denied.headers()["www-authenticate"].to_str().unwrap().contains("insufficient_scope"));
        let token = issuer.token("owner");
        let client = ()
            .serve(StreamableHttpClientTransport::from_config(
                StreamableHttpClientTransportConfig::with_uri(url.clone()).auth_header(token.clone()),
            ))
            .await
            .unwrap();
        assert!(!client.list_all_tools().await.unwrap().is_empty());
        let listed = client.call_tool(CallToolRequestParams::new("dbx_list_connections")).await.unwrap();
        assert_ne!(listed.is_error, Some(true));
        let blocked = client
            .call_tool(
                CallToolRequestParams::new("dbx_execute_query").with_arguments(
                    serde_json::from_value(
                        json!({"connection_id":"mysql", "database":"app", "sql":"DELETE FROM important"}),
                    )
                    .unwrap(),
                ),
            )
            .await
            .unwrap();
        assert_eq!(blocked.is_error, Some(true));
        assert!(backend.sql.lock().unwrap().is_empty());
        let id = manager.sessions.read().await.keys().next().unwrap().to_string();
        let list = json!({"jsonrpc":"2.0","id":42,"method":"tools/list","params":{}});
        let response = http
            .post(&url)
            .bearer_auth(issuer.token("second-owner"))
            .header("mcp-session-id", &id)
            .header("accept", "application/json, text/event-stream")
            .json(&list)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 403);
        assert_eq!(
            http.delete(&url)
                .bearer_auth(issuer.token("second-owner"))
                .header("mcp-session-id", &id)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            http.post(&url)
                .bearer_auth(&token)
                .header("origin", "https://evil.example.test")
                .json(&list)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            http.post(&url)
                .bearer_auth(&token)
                .header("host", "evil.example.test")
                .json(&list)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            http.post(&url).bearer_auth(&token).body("x".repeat(1024 * 1024 + 1)).send().await.unwrap().status(),
            413
        );
        // A short-lived SSE token must expire without killing concurrent
        // work authenticated with a fresh token for the same owner/session.
        let mut short_claims = issuer.claims("owner");
        short_claims["exp"] = json!(jsonwebtoken::get_current_timestamp() + 2);
        let short_token = issuer.sign(&short_claims);
        let short_stream = http
            .get(&url)
            .bearer_auth(&short_token)
            .header("mcp-session-id", &id)
            .header("accept", "text/event-stream")
            .send()
            .await
            .unwrap();
        assert_eq!(short_stream.status(), 200);
        tokio::time::timeout(std::time::Duration::from_secs(3), short_stream.bytes()).await.unwrap().unwrap();
        assert!(!client.list_all_tools().await.unwrap().is_empty());

        // The operation itself is dropped at expiry, not merely its HTTP body.
        backend.slow_load.store(true, Ordering::SeqCst);
        let mut short_claims = issuer.claims("owner");
        short_claims["exp"] = json!(jsonwebtoken::get_current_timestamp() + 2);
        let short_token = issuer.sign(&short_claims);
        let slow_call = http
            .post(&url)
            .bearer_auth(&short_token)
            .header("mcp-session-id", &id)
            .header("accept", "application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","id":81,"method":"tools/call","params":{"name":"dbx_list_connections"}}))
            .send()
            .await
            .unwrap();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), slow_call.bytes()).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while backend.running_load.load(Ordering::SeqCst) != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("expired tool operation must drop its backend future");
        backend.slow_load.store(false, Ordering::SeqCst);
        assert!(!client.list_all_tools().await.unwrap().is_empty());

        // SDK orphan/TTL cleanup removes physical sessions as well as bindings.
        let (orphan, _transport) = manager.create_session().await.unwrap();
        auth.reap_sessions(&manager).await;
        assert!(!manager.has_session(&orphan).await.unwrap());
        assert_eq!(
            http.delete(&url).bearer_auth(&token).header("mcp-session-id", &id).send().await.unwrap().status(),
            202
        );
        assert_eq!(
            http.post(&url)
                .bearer_auth(&token)
                .header("mcp-session-id", &id)
                .json(&list)
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        let replacement = ()
            .serve(StreamableHttpClientTransport::from_config(
                StreamableHttpClientTransportConfig::with_uri(url.clone()).auth_header(token.clone()),
            ))
            .await
            .unwrap();
        let replacement_id = manager.sessions.read().await.keys().next().unwrap().to_string();
        auth.expire_session_for_test(&replacement_id);
        auth.reap_sessions(&manager).await;
        assert!(manager.sessions.read().await.is_empty());
        drop(replacement);
        drop(client);
        cancellation.cancel();
        task.await.unwrap();
    }
}
