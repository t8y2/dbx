use std::{io, sync::Arc};

use axum::{http::Method, middleware, routing::get, Router};
use rmcp::transport::{
    streamable_http_server::{session::never::NeverSessionManager, tower::StreamableHttpService},
    StreamableHttpServerConfig,
};
use tokio_util::sync::CancellationToken;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::{
    diagnostics::health,
    http_auth::{authorize_request, HttpAuth},
    runtime::HttpRuntimeConfig,
    server::{PendingSalesforceWrites, PluginToolsMode, SALESFORCE_WRITE_CONFIRM_TTL},
    DbxBackend, DbxMcpServer, McpScope, McpSessionStore,
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
) -> Result<Router, String> {
    build_streamable_http_router(
        backend,
        path,
        auth,
        allowed_hosts,
        web_mode,
        None,
        Default::default(),
        McpSessionStore::new(),
        PendingSalesforceWrites::new(SALESFORCE_WRITE_CONFIRM_TTL),
    )
}

fn build_streamable_http_router(
    backend: Arc<dyn DbxBackend>,
    path: &str,
    auth: HttpAuth,
    allowed_hosts: Vec<String>,
    web_mode: bool,
    cancellation: Option<CancellationToken>,
    session_manager: Arc<NeverSessionManager>,
    sessions: Arc<McpSessionStore>,
    pending_salesforce_writes: Arc<PendingSalesforceWrites>,
) -> Result<Router, String> {
    auth.set_allowed_hosts(allowed_hosts.clone())?;
    // Web settings update the shared policy without rebuilding the router.
    // Keep rmcp's existing checks for the standalone server.
    let mut rmcp_config = if web_mode {
        StreamableHttpServerConfig::default().disable_allowed_hosts().disable_allowed_origins()
    } else {
        StreamableHttpServerConfig::default().with_allowed_hosts(allowed_hosts)
    };
    if let Some(cancellation) = cancellation {
        rmcp_config = rmcp_config.with_cancellation_token(cancellation);
    }
    // The transport keeps no session, for any protocol generation. rmcp would
    // otherwise hand a client an `Mcp-Session-Id` on `initialize` and answer
    // `404 Not Found: Session not found` once its idle window dropped that
    // session, which a client that reconnects after a longer pause reports as
    // `Streamable HTTP error: Error POSTing to endpoint: Not Found: Session not
    // found` and never recovers from (see #11640). A client that declares the
    // version per request is already exempt; this extends the same stateless
    // treatment to pre-`2026-07-28` clients. DBX's own stateful sessions are
    // unaffected: they are explicit `dbx_open_session` handles carried in tool
    // arguments, not transport sessions.
    rmcp_config = rmcp_config.with_legacy_session_mode(false);
    let server_backend = backend.clone();
    let scope = McpScope::from_env();
    let plugin_tools_mode = PluginToolsMode::from_env();
    // Stateless requests, tool-schema discovery, and session restoration each
    // call the factory again. Session and pending-write state belongs to the
    // endpoint, not to one instance, so a request can still find the DBX session
    // an earlier request opened.
    let service: StreamableHttpService<DbxMcpServer, NeverSessionManager> = StreamableHttpService::new(
        move || {
            Ok(DbxMcpServer::with_shared_state(
                server_backend.clone(),
                scope.clone(),
                web_mode,
                plugin_tools_mode,
                sessions.clone(),
                pending_salesforce_writes.clone(),
            ))
        },
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
    Ok(router.layer(
        CorsLayer::new()
            .allow_origin(AllowOrigin::predicate(move |origin, _| {
                origin.to_str().is_ok_and(|origin| cors_auth.origin_is_allowed(origin))
            }))
            // Every request is served statelessly, so `GET` and `DELETE` are
            // answered with 405 and must not be advertised to browser clients.
            .allow_methods([Method::POST])
            .allow_headers(Any),
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
    let session_manager = Arc::new(NeverSessionManager::default());
    let sessions = McpSessionStore::new();
    let pending_salesforce_writes = PendingSalesforceWrites::new(SALESFORCE_WRITE_CONFIRM_TTL);
    let mcp_router = build_streamable_http_router(
        backend.clone(),
        &config.path,
        config.auth,
        config.allowed_hosts,
        false,
        Some(cancellation.child_token()),
        session_manager.clone(),
        sessions.clone(),
        pending_salesforce_writes,
    )
    .map_err(io::Error::other)?;
    let router = Router::new().route("/healthz", get(health)).route("/readyz", get(health)).merge(mcp_router);

    eprintln!("DBX MCP Streamable HTTP listening on http://{}{}", config.bind_addr, config.path);

    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            cancellation.cancelled().await;
        })
        .await;
    close_http_sessions_bounded(&backend, &sessions).await;
    result
}

/// Roll back the DBX sessions the endpoint still holds.
///
/// There are no transport sessions to drain: the endpoint serves every request
/// statelessly. A DBX session outlives the request that opened it because it
/// lives on the endpoint-wide store, so shutdown releases it explicitly rather
/// than leaving it to the idle TTL.
async fn close_http_sessions_bounded(backend: &Arc<dyn DbxBackend>, sessions: &Arc<McpSessionStore>) {
    let cleanup = async {
        let leftover = sessions.take_all_active().await;
        if !leftover.is_empty() {
            let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::from_env(), false);
            server.close_backend_sessions_best_effort(leftover).await;
        }
    };
    if tokio::time::timeout(std::time::Duration::from_secs(10), cleanup).await.is_err() {
        log::warn!("Timed out draining MCP HTTP sessions during shutdown");
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
        model::{CallToolRequestParams, ProtocolVersion},
        service::ServiceExt,
        transport::{streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport},
        ClientLifecycleMode, ClientServiceExt,
    };
    use serde_json::{json, Value};

    use super::*;
    use crate::{
        backend::DbxBackend,
        server::{PendingSalesforceWrites, SALESFORCE_WRITE_CONFIRM_TTL},
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

        /// Model the pool release a real backend performs: the rollback itself
        /// comes from the transaction owner the session carries, and the
        /// disconnect counter records that the pinned pool was disposed.
        async fn close_client_session(
            &self,
            _connection_id: &str,
            _database: &str,
            _client_session_id: &str,
        ) -> Result<bool, String> {
            self.disconnects.fetch_add(1, Ordering::SeqCst);
            Ok(true)
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
    ) -> (String, Arc<McpSessionStore>, CancellationToken, tokio::task::JoinHandle<()>) {
        // A single default provider avoids the "No rustls crypto provider is
        // configured" panic when tests build reqwest clients in workspace
        // builds where multiple rustls crypto features are present; the
        // install is idempotent, so subsequent calls are no-ops.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let cancellation = CancellationToken::new();
        let sessions = McpSessionStore::new();
        let router = build_streamable_http_router(
            backend.clone(),
            "/mcp",
            HttpAuth::new("http-test-token".to_string(), Vec::<String>::new(), true).unwrap(),
            vec![address.to_string()],
            false,
            Some(cancellation.child_token()),
            Arc::new(NeverSessionManager::default()),
            sessions.clone(),
            PendingSalesforceWrites::new(SALESFORCE_WRITE_CONFIRM_TTL),
        )
        .unwrap();
        let shutdown = cancellation.clone();
        let shutdown_sessions = sessions.clone();
        let shutdown_backend: Arc<dyn DbxBackend> = backend;
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await
                .unwrap();
            close_http_sessions_bounded(&shutdown_backend, &shutdown_sessions).await;
        });
        (format!("http://{address}/mcp"), sessions, cancellation, task)
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

    /// Wait until the backend connection the session pinned was rolled back and
    /// disposed. Sessions are reclaimed by an explicit `dbx_close_session`, the
    /// idle TTL, or server shutdown, so every caller triggers one of those
    /// first; ending the HTTP transport session deliberately does not.
    async fn wait_for_disposal(backend: &HttpTestBackend) {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if backend.disconnects.load(Ordering::SeqCst) >= 1
                    && backend.sql.lock().unwrap().iter().any(|sql| sql == "ROLLBACK")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("session cleanup must roll back and disconnect the owner");
    }

    /// Close the stateful session the client opened by its own id.
    async fn close_inner_session(client: &rmcp::service::RunningService<rmcp::RoleClient, ()>, session_id: &str) {
        let closed = client
            .call_tool(
                CallToolRequestParams::new("dbx_close_session")
                    .with_arguments(serde_json::from_value(json!({ "session_id": session_id })).unwrap()),
            )
            .await
            .unwrap();
        assert_ne!(closed.is_error, Some(true), "close session failed: {closed:?}");
    }

    /// The endpoint offers no transport session to end, so it does not accept
    /// the legacy session-management verbs at all. A client that used to send
    /// `DELETE` now sees `405` with an explicit `Allow`, instead of silently
    /// having a session closed behind its back.
    #[tokio::test]
    async fn transport_session_management_verbs_are_not_accepted() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, _sessions, cancellation, server_task) = start_http_test_server(backend.clone()).await;
        let (client, inner_session_id) = open_active_transaction(&url).await;

        for method in [reqwest::Method::GET, reqwest::Method::DELETE] {
            let response = reqwest::Client::new()
                .request(method.clone(), &url)
                .bearer_auth("http-test-token")
                .header("mcp-session-id", "00000000-dead-beef-0000-000000000000")
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                reqwest::StatusCode::METHOD_NOT_ALLOWED,
                "{method} must be rejected on a stateless endpoint"
            );
            let allow =
                response.headers().get("allow").and_then(|value| value.to_str().ok()).unwrap_or_default().to_string();
            assert!(allow.contains("POST"), "{method} Allow header was {allow:?}");
        }

        // The DBX session the agent opened is independent of the transport and
        // keeps working after those rejected verbs.
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

        close_inner_session(&client, &inner_session_id).await;
        wait_for_disposal(&backend).await;
        drop(client);
        cancellation.cancel();
        server_task.await.unwrap();
    }

    /// The endpoint never hands out a session, for any protocol generation, so
    /// there is no server-side session that a client could later find missing.
    #[tokio::test]
    async fn no_protocol_generation_receives_a_session_id() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, _sessions, cancellation, server_task) = start_http_test_server(backend.clone()).await;

        let initialize = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "legacy", "version": "0" }
            }
        });
        let response = reqwest::Client::new()
            .post(&url)
            .bearer_auth("http-test-token")
            .header("accept", "application/json, text/event-stream")
            .json(&initialize)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert!(!response.headers().contains_key("mcp-session-id"), "a stateless endpoint must not issue a session id");

        // Reusing a stale session id on a later request is ignored rather than
        // answered with `404 Session not found`.
        let list_tools = serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} });
        let response = reqwest::Client::new()
            .post(&url)
            .bearer_auth("http-test-token")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-session-id", "00000000-dead-beef-0000-000000000000")
            .json(&list_tools)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::OK,
            "a stale session id must not turn into 404 Session not found"
        );
        let body = response.text().await.unwrap();
        assert!(body.contains("dbx_list_connections"), "tools/list did not answer: {body}");

        cancellation.cancel();
        server_task.await.unwrap();
    }

    /// The same endpoint must serve both protocol generations. They differ only
    /// in how they hand over the protocol version: a legacy agent runs the
    /// `initialize` handshake, a modern one carries `2026-07-28` metadata per
    /// request. Neither gets a transport session.
    #[tokio::test]
    async fn http_serves_both_protocol_generations_without_sessions() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, _sessions, cancellation, server_task) = start_http_test_server(backend.clone()).await;

        let legacy = ()
            .serve(StreamableHttpClientTransport::from_config(
                StreamableHttpClientTransportConfig::with_uri(url.clone()).auth_header("http-test-token"),
            ))
            .await
            .expect("legacy initialize client");
        let legacy_info = legacy.peer_info().expect("legacy initialize info");
        assert_eq!(legacy_info.protocol_version, ProtocolVersion::V_2025_11_25);
        let listed = legacy.list_all_tools().await.expect("legacy tools/list");
        assert!(!listed.is_empty());

        // `Discover` mode never sends `initialize`, so this only succeeds if the
        // server answers `server/discover` for the modern lifecycle.
        let modern = ClientServiceExt::serve_with_lifecycle(
            (),
            StreamableHttpClientTransport::from_config(
                StreamableHttpClientTransportConfig::with_uri(url.clone()).auth_header("http-test-token"),
            ),
            ClientLifecycleMode::Discover { preferred_versions: vec![ProtocolVersion::V_2026_07_28] },
        )
        .await
        .expect("modern discover client");
        let modern_info = modern.peer_info().expect("discover info");
        assert_eq!(modern_info.protocol_version, ProtocolVersion::V_2026_07_28);
        let modern_tools = modern.list_all_tools().await.expect("modern tools/list");
        assert!(!modern_tools.is_empty());

        for (client, is_modern) in [(&legacy, false), (&modern, true)] {
            for (method, result) in [
                ("tools/list", serde_json::to_value(client.list_tools(None).await.unwrap()).unwrap()),
                ("resources/list", serde_json::to_value(client.list_resources(None).await.unwrap()).unwrap()),
                (
                    "resources/templates/list",
                    serde_json::to_value(client.list_resource_templates(None).await.unwrap()).unwrap(),
                ),
            ] {
                if is_modern {
                    assert_eq!(result["resultType"], "complete", "{method}");
                    assert_eq!(result["ttlMs"], 0, "{method}");
                    assert_eq!(result["cacheScope"], "private", "{method}");
                } else {
                    for field in ["resultType", "ttlMs", "cacheScope"] {
                        assert!(result.get(field).is_none(), "legacy {method} unexpectedly includes {field}");
                    }
                }
            }
        }

        let _ = legacy.cancel().await;
        let _ = modern.cancel().await;
        cancellation.cancel();
        server_task.await.unwrap();
    }

    /// `2026-07-28` has no protocol-level session, so every request arrives at a
    /// freshly built `DbxMcpServer`. A session handle minted by one request must
    /// therefore still resolve in the next one, otherwise transactions silently
    /// break for modern agents while still working for legacy ones.
    #[tokio::test]
    async fn stateless_2026_requests_share_db_session_state() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, _sessions, cancellation, server_task) = start_http_test_server(backend.clone()).await;

        let modern = ClientServiceExt::serve_with_lifecycle(
            (),
            StreamableHttpClientTransport::from_config(
                StreamableHttpClientTransportConfig::with_uri(url).auth_header("http-test-token"),
            ),
            ClientLifecycleMode::Discover { preferred_versions: vec![ProtocolVersion::V_2026_07_28] },
        )
        .await
        .expect("modern discover client");

        let opened = modern
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
        assert_ne!(opened.is_error, Some(true), "open session failed: {opened:?}");
        let session_id = opened.structured_content.as_ref().unwrap()["session_id"].as_str().unwrap().to_string();

        let begun = modern
            .call_tool(
                CallToolRequestParams::new("dbx_begin_transaction")
                    .with_arguments(serde_json::from_value(json!({ "session_id": session_id.clone() })).unwrap()),
            )
            .await
            .unwrap();
        assert_ne!(begun.is_error, Some(true), "begin transaction failed: {begun:?}");

        // A separate HTTP request (and therefore a separate server instance)
        // must find the session opened two requests ago.
        let query = modern
            .call_tool(
                CallToolRequestParams::new("dbx_execute_query").with_arguments(
                    serde_json::from_value(json!({
                        "connection_id": "mysql",
                        "database": "app",
                        "session_id": session_id,
                        "sql": "SELECT 1"
                    }))
                    .unwrap(),
                ),
            )
            .await
            .unwrap();
        assert_ne!(query.is_error, Some(true), "query on shared session failed: {query:?}");
        assert_eq!(query.structured_content.as_ref().unwrap()["transaction_state"], "active");

        let _ = modern.cancel().await;
        cancellation.cancel();
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn http_service_shutdown_rolls_back_and_disconnects_inner_owner() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, _sessions, cancellation, server_task) = start_http_test_server(backend.clone()).await;
        let (client, _) = open_active_transaction(&url).await;

        cancellation.cancel();
        server_task.await.unwrap();
        wait_for_disposal(&backend).await;
        drop(client);
    }
}
