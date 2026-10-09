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
    http_principals::PrincipalStates,
    runtime::HttpRuntimeConfig,
    server::{PendingSalesforceWrites, PluginToolsMode, SALESFORCE_WRITE_CONFIRM_TTL},
    DbxBackend, DbxMcpServer, McpScope, McpSessionStore,
};

/// HTTP-only wrapper: all protocol requests retain their admission permit
/// until the operation finishes and are canceled at the authenticated deadline.
/// Stdio behavior and the core DBX permission gates remain unchanged.
struct BoundedHttpService { template: DbxMcpServer, principals: Arc<PrincipalStates> }

impl BoundedHttpService {
    async fn bounded_request<T, F, Fut>(
        &self,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
        dispatch: F,
    ) -> Result<T, rmcp::ErrorData>
    where
        T: Send,
        F: FnOnce(DbxMcpServer, rmcp::service::RequestContext<rmcp::RoleServer>) -> Fut + Send,
        Fut: std::future::Future<Output = Result<T, rmcp::ErrorData>> + Send,
    {
        let lease = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<crate::http_auth::HttpRequestDeadline>())
            .cloned()
            .ok_or_else(|| rmcp::ErrorData::internal_error("Missing authenticated HTTP request context", None))?;
        let principal = self.principals.acquire(&lease.principal)?;
        let cancellation = context.ct.clone();
        if lease.deadline <= tokio::time::Instant::now() || lease.session_cancellation.is_cancelled() {
            return Err(rmcp::ErrorData::internal_error("Authenticated HTTP session expired", None));
        }
        tokio::select! {
            biased;
            _ = principal.cancellation.cancelled() => Err(rmcp::ErrorData::internal_error("Authenticated principal state closed", None)),
            _ = lease.session_cancellation.cancelled() => Err(rmcp::ErrorData::internal_error("Authenticated HTTP session closed", None)),
            _ = cancellation.cancelled() => Err(rmcp::ErrorData::internal_error("MCP request cancelled", None)),
            _ = tokio::time::sleep_until(lease.deadline) => Err(rmcp::ErrorData::internal_error("Authenticated HTTP request deadline expired", None)),
            result = dispatch(principal.server.clone(), context) => result,
        }
    }

    async fn bounded_notification<F, Fut>(
        &self,
        context: rmcp::service::NotificationContext<rmcp::RoleServer>,
        dispatch: F,
    )
    where
        F: FnOnce(DbxMcpServer, rmcp::service::NotificationContext<rmcp::RoleServer>) -> Fut + Send,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let Some(deadline) = context.extensions.get::<axum::http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<crate::http_auth::HttpRequestDeadline>()).cloned() else {
            return;
        };
        let Ok(principal) = self.principals.acquire(&deadline.principal) else { return; };
        tokio::select! {
            biased;
            _ = principal.cancellation.cancelled() => {},
            _ = deadline.session_cancellation.cancelled() => {},
            _ = tokio::time::sleep_until(deadline.deadline) => {},
            _ = dispatch(principal.server.clone(), context) => {},
        }
    }
}

// Keep SDK protocol negotiation/dispatch in its ServerHandler implementation.
// Every application request still enters the same lease and deadline boundary.
macro_rules! bounded_request_method {
    ($method:ident, $input:ty, $output:ty) => {
        async fn $method(&self, request: $input, context: rmcp::service::RequestContext<rmcp::RoleServer>) -> Result<$output, rmcp::ErrorData> {
            self.bounded_request(context, move |server, context| async move {
                rmcp::ServerHandler::$method(&server, request, context).await
            }).await
        }
    };
    ($method:ident => $output:ty) => {
        async fn $method(&self, context: rmcp::service::RequestContext<rmcp::RoleServer>) -> Result<$output, rmcp::ErrorData> {
            self.bounded_request(context, |server, context| async move {
                rmcp::ServerHandler::$method(&server, context).await
            }).await
        }
    };
}

macro_rules! bounded_notification_method {
    ($method:ident, $input:ty) => {
        async fn $method(&self, notification: $input, context: rmcp::service::NotificationContext<rmcp::RoleServer>) {
            self.bounded_notification(context, move |server, context| async move {
                rmcp::ServerHandler::$method(&server, notification, context).await
            }).await;
        }
    };
    ($method:ident) => {
        async fn $method(&self, context: rmcp::service::NotificationContext<rmcp::RoleServer>) {
            self.bounded_notification(context, |server, context| async move {
                rmcp::ServerHandler::$method(&server, context).await
            }).await;
        }
    };
}

#[allow(deprecated)] // Preserve the SDK's legacy-only subscribe/unsubscribe gates.
impl rmcp::ServerHandler for BoundedHttpService {
    bounded_request_method!(ping => ());
    bounded_request_method!(discover => rmcp::model::DiscoverResult);
    bounded_request_method!(initialize, rmcp::model::InitializeRequestParams, rmcp::model::InitializeResult);
    bounded_request_method!(complete, rmcp::model::CompleteRequestParams, rmcp::model::CompleteResult);
    bounded_request_method!(set_level, rmcp::model::SetLevelRequestParams, ());
    bounded_request_method!(get_prompt, rmcp::model::GetPromptRequestParams, rmcp::model::GetPromptResponse);
    bounded_request_method!(list_prompts, Option<rmcp::model::PaginatedRequestParams>, rmcp::model::ListPromptsResult);
    bounded_request_method!(list_resources, Option<rmcp::model::PaginatedRequestParams>, rmcp::model::ListResourcesResult);
    bounded_request_method!(list_resource_templates, Option<rmcp::model::PaginatedRequestParams>, rmcp::model::ListResourceTemplatesResult);
    bounded_request_method!(read_resource, rmcp::model::ReadResourceRequestParams, rmcp::model::ReadResourceResponse);
    bounded_request_method!(subscribe, rmcp::model::SubscribeRequestParams, ());
    bounded_request_method!(unsubscribe, rmcp::model::UnsubscribeRequestParams, ());
    bounded_request_method!(call_tool, rmcp::model::CallToolRequestParams, rmcp::model::CallToolResponse);
    bounded_request_method!(list_tools, Option<rmcp::model::PaginatedRequestParams>, rmcp::model::ListToolsResult);
    bounded_request_method!(on_custom_request, rmcp::model::CustomRequest, rmcp::model::CustomResult);
    bounded_request_method!(get_task, rmcp::model::GetTaskParams, rmcp::model::GetTaskResult);
    bounded_request_method!(update_task, rmcp::model::UpdateTaskParams, ());
    bounded_request_method!(cancel_task, rmcp::model::CancelTaskParams, ());
    bounded_notification_method!(on_cancelled, rmcp::model::CancelledNotificationParam);
    bounded_notification_method!(on_progress, rmcp::model::ProgressNotificationParam);
    bounded_notification_method!(on_custom_notification, rmcp::model::CustomNotification);
    bounded_notification_method!(on_initialized);
    bounded_notification_method!(on_roots_list_changed);

    fn get_tool(&self, name: &str) -> Option<rmcp::model::Tool> {
        rmcp::ServerHandler::get_tool(&self.template, name)
    }

    fn supported_protocol_versions(&self) -> std::borrow::Cow<'static, [rmcp::model::ProtocolVersion]> {
        rmcp::ServerHandler::supported_protocol_versions(&self.template)
    }

    fn get_info(&self) -> rmcp::model::ServerConfig {
        rmcp::ServerHandler::get_info(&self.template)
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
    let principals = PrincipalStates::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::from_env(), web_mode));
    build_streamable_http_router(backend, path, auth, allowed_hosts, web_mode, None, Arc::new(http_session_manager()), principals)
}

fn http_session_manager() -> LocalSessionManager {
    let mut manager = LocalSessionManager::default();
    // Avoid an unbounded aggregate of recently completed large query results.
    // Late POST-response replay is deliberately unsupported; live SSE remains.
    manager.session_config.completed_cache_ttl = std::time::Duration::ZERO;
    manager.session_config.init_timeout = Some(std::time::Duration::from_secs(5));
    manager
}

fn build_streamable_http_router(
    backend: Arc<dyn DbxBackend>,
    path: &str,
    auth: HttpAuth,
    allowed_hosts: Vec<String>,
    web_mode: bool,
    cancellation: Option<CancellationToken>,
    session_manager: Arc<LocalSessionManager>,
    principals: Arc<PrincipalStates>,
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
    let cleanup_principals = principals.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            interval.tick().await;
            let Some(manager) = cleanup_manager.upgrade() else {
                cleanup_principals.shutdown().await;
                break;
            };
            cleanup_auth.reap_sessions(&manager).await;
            cleanup_principals.reap().await;
        }
    });
    let server_backend = backend.clone();
    let scope = McpScope::from_env();
    let plugin_tools_mode = PluginToolsMode::from_env();
    // Both legacy and stateless factories dispatch every request through the
    // authenticated principal partition, never endpoint-wide mutable state.
    let service: StreamableHttpService<BoundedHttpService, LocalSessionManager> = StreamableHttpService::new(
        move || {
            Ok(BoundedHttpService {
                template: DbxMcpServer::with_shared_state(server_backend.clone(), scope.clone(), web_mode,
                    plugin_tools_mode, McpSessionStore::new(), PendingSalesforceWrites::new(SALESFORCE_WRITE_CONFIRM_TTL)),
                principals: principals.clone(),
            })
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
    let session_manager = Arc::new(http_session_manager());
    let principals = PrincipalStates::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::from_env(), false));
    let mcp_router = build_streamable_http_router(
        backend.clone(),
        &config.path,
        config.auth,
        config.allowed_hosts,
        false,
        Some(cancellation.child_token()),
        session_manager.clone(),
        principals.clone(),
    )
    .map_err(io::Error::other)?;
    let router = Router::new().route("/healthz", get(health)).route("/readyz", get(health)).merge(mcp_router);

    eprintln!("DBX MCP Streamable HTTP listening on http://{}{}", config.bind_addr, config.path);

    let stopping = cancellation.clone();
    let shutdown_principals = principals.clone();
    let principal_shutdown = tokio::spawn(async move {
        stopping.cancelled().await;
        shutdown_principals.shutdown().await;
    });
    let signal = cancellation.clone();
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            signal.cancelled().await;
        })
        .await;
    cancellation.cancel();
    close_http_sessions_bounded(&session_manager, &principals).await;
    // The bounded drain above already waited for these same owners. If a
    // backend is stuck, detach this waiter without aborting its cleanup.
    drop(principal_shutdown);
    result
}

/// Cancel principal handlers before closing transports, then roll back all
/// remaining inner sessions only after their in-flight handler leases drain.
async fn close_http_sessions_bounded(
    session_manager: &Arc<LocalSessionManager>,
    principals: &Arc<PrincipalStates>,
) {
    let owners = principals.clone();
    let cleanup_owners = tokio::spawn(async move { owners.shutdown().await });
    let cleanup = async {
        let session_ids = session_manager.sessions.read().await.keys().cloned().collect::<Vec<_>>();
        for session_id in session_ids {
            let _ = session_manager.close_session(&session_id).await;
        }
    };
    if tokio::time::timeout(std::time::Duration::from_secs(10), cleanup).await.is_err() {
        log::warn!("Timed out draining MCP HTTP protocol sessions during shutdown");
    }
    // Dropping a timed-out JoinHandle detaches cleanup: its retiring owners
    // continue holding their capacity slots until physical disposal finishes.
    if tokio::time::timeout(std::time::Duration::from_secs(10), cleanup_owners).await.is_err() {
        log::warn!("Timed out draining MCP HTTP principal state during shutdown; cleanup continues");
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
        transport::{
            streamable_http_client::StreamableHttpClientTransportConfig,
            streamable_http_server::session::local::SessionConfig, StreamableHttpClientTransport,
        },
        ClientLifecycleMode, ClientServiceExt,
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
        keep_alive: std::time::Duration,
    ) -> (String, Arc<LocalSessionManager>, Arc<PrincipalStates>, CancellationToken, tokio::task::JoinHandle<()>) {
        // A single default provider avoids the "No rustls crypto provider is
        // configured" panic when tests build reqwest clients in workspace
        // builds where multiple rustls crypto features are present; the
        // install is idempotent, so subsequent calls are no-ops.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut session_config = SessionConfig::default();
        session_config.keep_alive = Some(keep_alive);
        session_config.completed_cache_ttl = std::time::Duration::ZERO;
        let mut local_manager = http_session_manager();
        local_manager.session_config = session_config;
        let manager = Arc::new(local_manager);
        let cancellation = CancellationToken::new();
        let principals = PrincipalStates::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::from_env(), false));
        let router = build_streamable_http_router(
            backend.clone(),
            "/mcp",
            HttpAuth::new("http-test-token".to_string(), Vec::<String>::new(), true).unwrap(),
            vec![address.to_string()],
            false,
            Some(cancellation.child_token()),
            manager.clone(),
            principals.clone(),
        )
        .unwrap();
        let shutdown = cancellation.clone();
        let shutdown_manager = manager.clone();
        let shutdown_principals = principals.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await
                .unwrap();
            close_http_sessions_bounded(&shutdown_manager, &shutdown_principals).await;
        });
        (format!("http://{address}/mcp"), manager, principals, cancellation, task)
    }

    async fn open_active_transaction(url: &str) -> (rmcp::service::RunningService<rmcp::RoleClient, ()>, String) {
        let transport = StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(url.to_string()).auth_header("http-test-token"),
        );
        let client = ().serve(transport).await.unwrap();
        let session_id = begin_active_transaction(&client).await;
        (client, session_id)
    }

    async fn begin_active_transaction(client: &rmcp::service::RunningService<rmcp::RoleClient, ()>) -> String {
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
        assert_ne!(opened.is_error, Some(true), "open session failed: {opened:?}");
        let session_id = opened.structured_content.unwrap()["session_id"].as_str().unwrap().to_string();
        let begun = client
            .call_tool(
                CallToolRequestParams::new("dbx_begin_transaction")
                    .with_arguments(serde_json::from_value(json!({"session_id": session_id.clone()})).unwrap()),
            )
            .await
            .unwrap();
        assert_ne!(begun.is_error, Some(true), "begin transaction failed: {begun:?}");
        session_id
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

    /// Ending the HTTP transport session must still be possible without
    /// touching the stateful session the agent opened on it: HTTP DELETE is a
    /// transport-level operation, and a stateless `2026-07-28` agent has no
    /// transport session at all.
    #[tokio::test]
    async fn authenticated_http_delete_keeps_the_stateful_session_until_it_is_closed() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, manager, _sessions, cancellation, server_task) =
            start_http_test_server(backend.clone(), std::time::Duration::from_secs(30)).await;
        let (client, inner_session_id) = open_active_transaction(&url).await;
        let outer_session_id = manager.sessions.read().await.keys().next().unwrap().to_string();

        let response = reqwest::Client::new()
            .delete(&url)
            .bearer_auth("http-test-token")
            .header("mcp-session-id", outer_session_id)
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success(), "DELETE returned {}", response.status());
        assert_eq!(backend.disconnects.load(Ordering::SeqCst), 0);

        close_inner_session(&client, &inner_session_id).await;
        wait_for_disposal(&backend).await;

        drop(client);
        cancellation.cancel();
        server_task.await.unwrap();
    }

    /// The transport idle timeout reclaims the protocol session, not the
    /// stateful session an agent opened through it.
    #[tokio::test]
    async fn http_inactivity_expiry_reclaims_the_transport_session() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, manager, _sessions, cancellation, server_task) =
            start_http_test_server(backend.clone(), std::time::Duration::from_millis(500)).await;
        let (client, inner_session_id) = open_active_transaction(&url).await;

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !manager.sessions.read().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("expired outer HTTP session must be removed");
        assert_eq!(backend.disconnects.load(Ordering::SeqCst), 0);

        close_inner_session(&client, &inner_session_id).await;
        wait_for_disposal(&backend).await;

        drop(client);
        cancellation.cancel();
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn transient_http_connections_preserve_one_outer_session() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, manager, _sessions, cancellation, server_task) =
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
        assert_eq!(backend.disconnects.load(Ordering::SeqCst), 0);

        close_inner_session(&client, &inner_session_id).await;
        wait_for_disposal(&backend).await;
        drop(client);
        cancellation.cancel();
        server_task.await.unwrap();
    }

    /// The same endpoint must serve both protocol generations: a legacy agent
    /// gets the stateful `initialize` handshake and a session id, while a modern
    /// agent gets stateless discovery on `2026-07-28` with no session at all.
    #[tokio::test]
    async fn http_serves_stateful_legacy_and_stateless_2026_agents() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, manager, _sessions, cancellation, server_task) =
            start_http_test_server(backend.clone(), std::time::Duration::from_secs(30)).await;

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
        assert_eq!(manager.sessions.read().await.len(), 1, "legacy agents keep a stateful session");

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
        assert_eq!(manager.sessions.read().await.len(), 1, "2026-07-28 discovery stays stateless");

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
        assert_eq!(manager.sessions.read().await.len(), 0, "both agents released their transport state");
    }

    /// `2026-07-28` has no protocol-level session, so every request arrives at a
    /// freshly built `DbxMcpServer`. A session handle minted by one request must
    /// therefore still resolve in the next one, otherwise transactions silently
    /// break for modern agents while still working for legacy ones.
    #[tokio::test]
    async fn stateless_2026_requests_share_db_session_state() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, _manager, _sessions, cancellation, server_task) =
            start_http_test_server(backend.clone(), std::time::Duration::from_secs(30)).await;

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
        let (url, _manager, _sessions, cancellation, server_task) =
            start_http_test_server(backend.clone(), std::time::Duration::from_secs(30)).await;
        let (client, _) = open_active_transaction(&url).await;

        cancellation.cancel();
        server_task.await.unwrap();
        wait_for_disposal(&backend).await;
        drop(client);
    }
    #[tokio::test]
    async fn idle_sse_streams_do_not_starve_tools_or_session_cleanup() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, manager, _principals, cancellation, server_task) =
            start_http_test_server(backend.clone(), std::time::Duration::from_secs(30)).await;
        let (client, inner_session_id) = open_active_transaction(&url).await;
        let id = manager.sessions.read().await.keys().next().unwrap().to_string();
        let http = reqwest::Client::new();
        let mut streams = Vec::new();
        // Keep all GET bodies open, including rmcp's shadow streams. These
        // carry notifications, not executing SQL, and must not consume the
        // operation budget or force an existing transaction to be discarded.
        let mut rejected = None;
        for _ in 0..33 {
            let stream = http
                .get(&url)
                .bearer_auth("http-test-token")
                .header("mcp-session-id", &id)
                .header("accept", "text/event-stream")
                .send()
                .await
                .unwrap();
            if stream.status() == 429 {
                rejected = Some(stream);
                break;
            }
            assert_eq!(stream.status(), 200);
            streams.push(stream);
        }
        // The SDK client owns one common GET; the raw client fills the rest.
        assert!((31..=32).contains(&streams.len()));
        let excess = rejected.expect("SSE connections must remain bounded");
        for _ in 0..80 {
            let listed = client.call_tool(CallToolRequestParams::new("dbx_list_connections")).await.unwrap();
            assert_ne!(listed.is_error, Some(true));
        }
        let query = client
            .call_tool(
                CallToolRequestParams::new("dbx_execute_query").with_arguments(
                    serde_json::from_value(json!({
                        "connection_id": "mysql",
                        "database": "app",
                        "session_id": inner_session_id.clone(),
                        "sql": "SELECT 1"
                    }))
                    .unwrap(),
                ),
            )
            .await
            .unwrap();
        assert_ne!(query.is_error, Some(true));
        assert_eq!(query.structured_content.as_ref().unwrap()["transaction_state"], "active");
        assert_eq!(excess.text().await.unwrap(), "MCP SSE stream limit reached");
        assert_eq!(backend.disconnects.load(Ordering::SeqCst), 0);
        assert!(!backend.sql.lock().unwrap().iter().any(|sql| sql == "ROLLBACK"));
        assert_eq!(manager.sessions.read().await.len(), 1);
        close_inner_session(&client, &inner_session_id).await;
        let response =
            http.delete(&url).bearer_auth("http-test-token").header("mcp-session-id", &id).send().await.unwrap();
        assert_eq!(response.status(), 202);
        wait_for_disposal(&backend).await;
        for stream in streams {
            tokio::time::timeout(std::time::Duration::from_secs(2), stream.bytes()).await.unwrap().unwrap();
        }
        drop(client);
        cancellation.cancel();
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn oauth_http_principals_isolate_inner_sessions_and_cleanup() {
        use crate::oauth::test_issuer::issuer;

        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let issuer = issuer();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let backend = Arc::new(HttpTestBackend::new());
        let manager = Arc::new(http_session_manager());
        let principals = PrincipalStates::new(DbxMcpServer::with_runtime_options(
            backend.clone(),
            McpScope::from_env(),
            false,
        ));
        let cancellation = CancellationToken::new();
        let router = build_streamable_http_router(
            backend.clone(),
            "/mcp",
            HttpAuth::new_oauth(issuer.verifier(), vec![address.to_string()], vec![]).unwrap(),
            vec![address.to_string()],
            false,
            Some(cancellation.child_token()),
            manager.clone(),
            principals.clone(),
        )
        .unwrap();
        let stop = cancellation.clone();
        let shutdown_manager = manager.clone();
        let shutdown_principals = principals.clone();
        let server_task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move { stop.cancelled().await })
                .await
                .unwrap();
            close_http_sessions_bounded(&shutdown_manager, &shutdown_principals).await;
        });
        let url = format!("http://{address}/mcp");
        let owner_token = issuer.token("owner");
        let owner_legacy = ()
            .serve(StreamableHttpClientTransport::from_config(
                StreamableHttpClientTransportConfig::with_uri(url.clone()).auth_header(owner_token.clone()),
            ))
            .await
            .expect("owner A legacy initialize");
        let session_id = begin_active_transaction(&owner_legacy).await;

        // Owner B uses its own valid HTTP transport session and also the
        // sessionless modern protocol. Neither route may resolve A's handle.
        let other_legacy = ()
            .serve(StreamableHttpClientTransport::from_config(
                StreamableHttpClientTransportConfig::with_uri(url.clone()).auth_header(issuer.token("second-owner")),
            ))
            .await
            .expect("owner B legacy initialize");
        let other_modern = ClientServiceExt::serve_with_lifecycle(
            (),
            StreamableHttpClientTransport::from_config(
                StreamableHttpClientTransportConfig::with_uri(url.clone()).auth_header(issuer.token("second-owner")),
            ),
            ClientLifecycleMode::Discover { preferred_versions: vec![ProtocolVersion::V_2026_07_28] },
        )
        .await
        .expect("owner B modern discover");
        assert_eq!(other_legacy.peer_info().unwrap().protocol_version, ProtocolVersion::V_2025_11_25);
        assert_eq!(other_modern.peer_info().unwrap().protocol_version, ProtocolVersion::V_2026_07_28);
        assert_eq!(manager.sessions.read().await.len(), 2, "owners have distinct legacy transport sessions");
        for (generation, client) in [("legacy", &other_legacy), ("modern", &other_modern)] {
            for (tool, arguments) in [
                (
                    "dbx_execute_query",
                    json!({"connection_id": "mysql", "database": "app", "session_id": session_id, "sql": "SELECT 1"}),
                ),
                ("dbx_commit_transaction", json!({"session_id": session_id})),
                ("dbx_close_session", json!({"session_id": session_id})),
            ] {
                let rejected = client
                    .call_tool(CallToolRequestParams::new(tool).with_arguments(serde_json::from_value(arguments).unwrap()))
                    .await
                    .unwrap();
                assert_eq!(rejected.is_error, Some(true), "owner B {generation} {tool} resolved A's session");
                assert!(
                    rejected.content[0].as_text().unwrap().text.contains("SESSION_NOT_FOUND"),
                    "owner B {generation} {tool}: {rejected:?}"
                );
            }
        }
        assert_eq!(backend.disconnects.load(Ordering::SeqCst), 0, "B must not close A's backend owner");
        assert!(backend.sql.lock().unwrap().iter().all(|sql| sql != "SELECT 1" && sql != "COMMIT" && sql != "ROLLBACK"));

        // A refreshed JWT is a different credential for the same (iss, sub).
        // A new stateless client must resume the original legacy transaction.
        let mut refreshed_claims = issuer.claims("owner");
        refreshed_claims["jti"] = json!("refreshed-owner-token");
        refreshed_claims["exp"] = json!(jsonwebtoken::get_current_timestamp() + 600);
        let refreshed_token = issuer.sign(&refreshed_claims);
        assert_ne!(owner_token, refreshed_token);
        let owner_modern = ClientServiceExt::serve_with_lifecycle(
            (),
            StreamableHttpClientTransport::from_config(
                StreamableHttpClientTransportConfig::with_uri(url).auth_header(refreshed_token),
            ),
            ClientLifecycleMode::Discover { preferred_versions: vec![ProtocolVersion::V_2026_07_28] },
        )
        .await
        .expect("owner A refreshed modern discover");
        let query = owner_modern
            .call_tool(
                CallToolRequestParams::new("dbx_execute_query").with_arguments(
                    serde_json::from_value(json!({
                        "connection_id": "mysql", "database": "app", "session_id": session_id, "sql": "SELECT 1"
                    }))
                    .unwrap(),
                ),
            )
            .await
            .unwrap();
        assert_ne!(query.is_error, Some(true), "refreshed owner A lost its transaction: {query:?}");
        assert_eq!(query.structured_content.as_ref().unwrap()["transaction_state"], "active");
        assert_eq!(backend.sql.lock().unwrap().iter().filter(|sql| *sql == "SELECT 1").count(), 1);

        // Reaping an idle principal must dispose the actual transaction owner,
        // even while its legacy transport object still exists.
        principals.expire_all_for_test().await;
        principals.reap().await;
        wait_for_disposal(&backend).await;
        assert_eq!(backend.sql.lock().unwrap().iter().filter(|sql| *sql == "ROLLBACK").count(), 1);
        for client in [&owner_legacy, &owner_modern] {
            let expired = client
                .call_tool(
                    CallToolRequestParams::new("dbx_commit_transaction")
                        .with_arguments(serde_json::from_value(json!({"session_id": session_id})).unwrap()),
                )
                .await
                .unwrap();
            assert_eq!(expired.is_error, Some(true));
            assert!(expired.content[0].as_text().unwrap().text.contains("SESSION_NOT_FOUND"));
        }

        // The replacement principal can open new state. Shutdown must clean
        // that second transaction too, rather than only the expired registry.
        let disconnected_after_reap = backend.disconnects.load(Ordering::SeqCst);
        let replacement_id = begin_active_transaction(&owner_modern).await;
        assert_ne!(session_id, replacement_id);
        assert_eq!(backend.sql.lock().unwrap().iter().filter(|sql| *sql == "ROLLBACK").count(), 1);
        cancellation.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(5), server_task)
            .await
            .expect("HTTP shutdown must complete")
            .unwrap();
        assert_eq!(backend.sql.lock().unwrap().iter().filter(|sql| *sql == "ROLLBACK").count(), 2);
        assert!(backend.disconnects.load(Ordering::SeqCst) > disconnected_after_reap);
        assert!(!backend.sql.lock().unwrap().iter().any(|sql| sql == "COMMIT"));
        assert!(manager.sessions.read().await.is_empty());
        drop((owner_legacy, owner_modern, other_legacy, other_modern));
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
        let manager = Arc::new(http_session_manager());
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
            PrincipalStates::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::from_env(), false)),
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
        backend.slow_load.store(true, Ordering::SeqCst);
        let abandoned = http
            .post(&url)
            .bearer_auth(&token)
            .header("mcp-session-id", &id)
            .header("accept", "application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","id":82,"method":"tools/call","params":{"name":"dbx_list_connections"}}))
            .send()
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while backend.running_load.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(abandoned);
        assert_eq!(
            http.delete(&url).bearer_auth(&token).header("mcp-session-id", &id).send().await.unwrap().status(),
            202
        );
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while backend.running_load.load(Ordering::SeqCst) != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("DELETE must cancel a disconnected in-flight operation");
        backend.slow_load.store(false, Ordering::SeqCst);

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
