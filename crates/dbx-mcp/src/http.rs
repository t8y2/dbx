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
    http_principals::PrincipalStates,
    runtime::HttpRuntimeConfig,
    server::{PendingSalesforceWrites, PluginToolsMode, SALESFORCE_WRITE_CONFIRM_TTL},
    DbxBackend, DbxMcpServer, McpScope, McpSessionStore,
};

/// HTTP-only wrapper: all protocol requests retain their admission permit
/// until the operation finishes and are canceled at the authenticated deadline.
/// Stdio behavior and the core DBX permission gates remain unchanged.
struct BoundedHttpService {
    template: DbxMcpServer,
    principals: Arc<PrincipalStates>,
}

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
        let cancellation = context.ct.clone();
        if lease.deadline <= tokio::time::Instant::now() || lease.policy_cancellation.is_cancelled() {
            return Err(rmcp::ErrorData::internal_error("Authenticated HTTP request expired", None));
        }
        let principal = self.principals.acquire(&lease.principal)?;
        tokio::select! {
            biased;
            _ = principal.cancellation.cancelled() => Err(rmcp::ErrorData::internal_error("Authenticated principal state closed", None)),
            _ = lease.policy_cancellation.cancelled() => Err(rmcp::ErrorData::internal_error("Authenticated HTTP policy changed", None)),
            _ = cancellation.cancelled() => Err(rmcp::ErrorData::internal_error("MCP request cancelled", None)),
            _ = tokio::time::sleep_until(lease.deadline) => Err(rmcp::ErrorData::internal_error("Authenticated HTTP request deadline expired", None)),
            result = dispatch(principal.server.clone(), context) => result,
        }
    }

    async fn bounded_notification<F, Fut>(
        &self,
        context: rmcp::service::NotificationContext<rmcp::RoleServer>,
        dispatch: F,
    ) where
        F: FnOnce(DbxMcpServer, rmcp::service::NotificationContext<rmcp::RoleServer>) -> Fut + Send,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let Some(deadline) = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<crate::http_auth::HttpRequestDeadline>())
            .cloned()
        else {
            return;
        };
        let Ok(principal) = self.principals.acquire(&deadline.principal) else {
            return;
        };
        tokio::select! {
            biased;
            _ = principal.cancellation.cancelled() => {},
            _ = deadline.policy_cancellation.cancelled() => {},
            _ = tokio::time::sleep_until(deadline.deadline) => {},
            _ = dispatch(principal.server.clone(), context) => {},
        }
    }
}

// Keep SDK protocol negotiation/dispatch in its ServerHandler implementation.
// Every application request still enters the same lease and deadline boundary.
macro_rules! bounded_request_method {
    ($method:ident, $input:ty, $output:ty) => {
        async fn $method(
            &self,
            request: $input,
            context: rmcp::service::RequestContext<rmcp::RoleServer>,
        ) -> Result<$output, rmcp::ErrorData> {
            self.bounded_request(context, move |server, context| async move {
                rmcp::ServerHandler::$method(&server, request, context).await
            })
            .await
        }
    };
    ($method:ident => $output:ty) => {
        async fn $method(
            &self,
            context: rmcp::service::RequestContext<rmcp::RoleServer>,
        ) -> Result<$output, rmcp::ErrorData> {
            self.bounded_request(context, |server, context| async move {
                rmcp::ServerHandler::$method(&server, context).await
            })
            .await
        }
    };
}

macro_rules! bounded_notification_method {
    ($method:ident, $input:ty) => {
        async fn $method(&self, notification: $input, context: rmcp::service::NotificationContext<rmcp::RoleServer>) {
            self.bounded_notification(context, move |server, context| async move {
                rmcp::ServerHandler::$method(&server, notification, context).await
            })
            .await;
        }
    };
    ($method:ident) => {
        async fn $method(&self, context: rmcp::service::NotificationContext<rmcp::RoleServer>) {
            self.bounded_notification(context, |server, context| async move {
                rmcp::ServerHandler::$method(&server, context).await
            })
            .await;
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
    bounded_request_method!(
        list_resources,
        Option<rmcp::model::PaginatedRequestParams>,
        rmcp::model::ListResourcesResult
    );
    bounded_request_method!(
        list_resource_templates,
        Option<rmcp::model::PaginatedRequestParams>,
        rmcp::model::ListResourceTemplatesResult
    );
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
    let principals =
        PrincipalStates::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::from_env(), web_mode));
    build_streamable_http_router(
        backend,
        path,
        auth,
        allowed_hosts,
        web_mode,
        None,
        Arc::new(http_session_manager()),
        principals,
    )
}

fn http_session_manager() -> NeverSessionManager {
    NeverSessionManager::default()
}

fn build_streamable_http_router(
    backend: Arc<dyn DbxBackend>,
    path: &str,
    auth: HttpAuth,
    allowed_hosts: Vec<String>,
    web_mode: bool,
    cancellation: Option<CancellationToken>,
    session_manager: Arc<NeverSessionManager>,
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
    // Never issue transport session IDs, including to legacy clients. Explicit
    // DBX handles survive requests in their authenticated principal partition.
    rmcp_config = rmcp_config.with_legacy_session_mode(false);
    // Maintenance must not keep an abandoned embedded router alive. When its
    // last service releases the manager, drain principal leases and roll back
    // their DBX state instead of leaving it to the idle TTL.
    let cleanup_manager = Arc::downgrade(&session_manager);
    let cleanup_principals = principals.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            interval.tick().await;
            if cleanup_manager.upgrade().is_none() {
                cleanup_principals.shutdown().await;
                break;
            }
            cleanup_principals.reap().await;
        }
    });
    let server_backend = backend.clone();
    let scope = McpScope::from_env();
    let plugin_tools_mode = PluginToolsMode::from_env();
    // Both legacy and stateless factories dispatch every request through the
    // authenticated principal partition, never endpoint-wide mutable state.
    let service: StreamableHttpService<BoundedHttpService, NeverSessionManager> = StreamableHttpService::new(
        move || {
            Ok(BoundedHttpService {
                template: DbxMcpServer::with_shared_state(
                    server_backend.clone(),
                    scope.clone(),
                    web_mode,
                    plugin_tools_mode,
                    McpSessionStore::new(),
                    PendingSalesforceWrites::new(SALESFORCE_WRITE_CONFIRM_TTL),
                ),
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
            .allow_methods([Method::POST])
            .allow_headers(Any)
            .expose_headers([
                axum::http::HeaderName::from_static("mcp-protocol-version"),
                axum::http::header::WWW_AUTHENTICATE,
            ]),
    ))
}

/// Serves a stateless rmcp Streamable HTTP endpoint. DBX session state is
/// partitioned by authenticated principal, while the backend remains shared
/// and every request is authorized before rmcp sees it.
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
    let principals =
        PrincipalStates::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::from_env(), false));
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
    close_http_sessions_bounded(&principals).await;
    // The bounded drain above already waited for these same owners. If a
    // backend is stuck, detach this waiter without aborting its cleanup.
    drop(principal_shutdown);
    result
}

/// Cancel principal handlers, then roll back their DBX sessions only after
/// all in-flight leases drain. A timeout detaches cleanup; retiring owners keep
/// their capacity slots until physical disposal finishes.
async fn close_http_sessions_bounded(principals: &Arc<PrincipalStates>) {
    let owners = principals.clone();
    let cleanup = tokio::spawn(async move { owners.shutdown().await });
    if tokio::time::timeout(std::time::Duration::from_secs(10), cleanup).await.is_err() {
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
        transport::{streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport},
        ClientLifecycleMode, ClientServiceExt,
    };
    use serde_json::{json, Value};

    use super::*;
    use crate::{
        backend::DbxBackend,
        transaction::{
            TransactionIo, TransactionIoError, TransactionIoSuccess, TransactionOwner, TransactionOwnerConfig,
        },
    };

    struct HttpTestIo {
        running_sql: Arc<AtomicUsize>,
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
            if sql == "SELECT SLOW" {
                struct RunningSql(Arc<AtomicUsize>);
                impl Drop for RunningSql {
                    fn drop(&mut self) {
                        self.0.fetch_sub(1, Ordering::SeqCst);
                    }
                }
                self.running_sql.fetch_add(1, Ordering::SeqCst);
                let _running = RunningSql(self.running_sql.clone());
                futures::future::pending::<()>().await;
            }
            match sql {
                "START TRANSACTION" => self.in_transaction = true,
                "COMMIT" | "ROLLBACK" => self.in_transaction = false,
                _ => {}
            }
            Ok(TransactionIoSuccess {
                result: dbx_core::db::QueryResult {
                    columns: Vec::new(),
                    column_types: Vec::new(),
                    deferred_large_value_cells: Vec::new(),
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
        running_sql: Arc<AtomicUsize>,
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
                running_sql: Default::default(),
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
                HttpTestIo {
                    running_sql: self.running_sql.clone(),
                    sql: self.sql.clone(),
                    disconnects: self.disconnects.clone(),
                    in_transaction: false,
                },
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
    ) -> (String, Arc<PrincipalStates>, CancellationToken, tokio::task::JoinHandle<()>) {
        // Idempotent even when workspace dependencies enable multiple providers.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let cancellation = CancellationToken::new();
        let principals =
            PrincipalStates::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::from_env(), false));
        let router = build_streamable_http_router(
            backend.clone(),
            "/mcp",
            HttpAuth::new("http-test-token".to_string(), Vec::<String>::new(), true).unwrap(),
            vec![address.to_string()],
            false,
            Some(cancellation.child_token()),
            Arc::new(http_session_manager()),
            principals.clone(),
        )
        .unwrap();
        let shutdown = cancellation.clone();
        let shutdown_principals = principals.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await
                .unwrap();
            close_http_sessions_bounded(&shutdown_principals).await;
        });
        (format!("http://{address}/mcp"), principals, cancellation, task)
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

    /// The endpoint offers no transport session to end, so it does not accept
    /// the legacy session-management verbs at all. A client that used to send
    /// `DELETE` now sees `405` with an explicit `Allow`, instead of silently
    /// having a session closed behind its back.
    #[tokio::test]
    async fn transport_session_management_verbs_are_not_accepted() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, _principals, cancellation, server_task) = start_http_test_server(backend.clone()).await;
        let (client, inner_session_id) = open_active_transaction(&url).await;
        let preflight = reqwest::Client::new()
            .request(reqwest::Method::OPTIONS, &url)
            .header("origin", "http://localhost:12345")
            .header("access-control-request-method", "POST")
            .header("access-control-request-headers", "authorization,content-type")
            .send()
            .await
            .unwrap();
        assert!(preflight.status().is_success());
        assert_eq!(preflight.headers()["access-control-allow-methods"], "POST");
        assert_eq!(preflight.headers()["access-control-allow-origin"], "http://localhost:12345");

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
        let (url, _principals, cancellation, server_task) = start_http_test_server(backend.clone()).await;

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
        let (url, _principals, cancellation, server_task) = start_http_test_server(backend.clone()).await;

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
        let (url, _principals, cancellation, server_task) = start_http_test_server(backend.clone()).await;

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
        let (url, _principals, cancellation, server_task) = start_http_test_server(backend.clone()).await;
        let (client, _) = open_active_transaction(&url).await;

        cancellation.cancel();
        server_task.await.unwrap();
        wait_for_disposal(&backend).await;
        drop(client);
    }
    #[tokio::test]
    async fn rejected_transport_verbs_do_not_starve_tools_or_discard_transactions() {
        let backend = Arc::new(HttpTestBackend::new());
        let (url, _principals, cancellation, server_task) = start_http_test_server(backend.clone()).await;
        let (client, inner_session_id) = open_active_transaction(&url).await;
        let http = reqwest::Client::new();
        for index in 0..80 {
            let method = if index % 2 == 0 { reqwest::Method::GET } else { reqwest::Method::DELETE };
            let response = http
                .request(method, &url)
                .bearer_auth("http-test-token")
                .header("mcp-session-id", "stale-legacy-session")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 405);
            assert_eq!(response.headers()["allow"], "POST");
            let listed = client.call_tool(CallToolRequestParams::new("dbx_list_connections")).await.unwrap();
            assert_ne!(listed.is_error, Some(true));
        }
        let query = client
            .call_tool(
                CallToolRequestParams::new("dbx_execute_query").with_arguments(
                    serde_json::from_value(json!({ "connection_id": "mysql", "database": "app",
                "session_id": inner_session_id, "sql": "SELECT 1" }))
                    .unwrap(),
                ),
            )
            .await
            .unwrap();
        assert_ne!(query.is_error, Some(true));
        assert_eq!(query.structured_content.as_ref().unwrap()["transaction_state"], "active");
        assert_eq!(backend.disconnects.load(Ordering::SeqCst), 0);
        assert!(!backend.sql.lock().unwrap().iter().any(|sql| sql == "ROLLBACK"));
        close_inner_session(&client, &inner_session_id).await;
        wait_for_disposal(&backend).await;
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
        let principals =
            PrincipalStates::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::from_env(), false));
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
        let shutdown_principals = principals.clone();
        let server_task = tokio::spawn(async move {
            axum::serve(listener, router).with_graceful_shutdown(async move { stop.cancelled().await }).await.unwrap();
            close_http_sessions_bounded(&shutdown_principals).await;
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

        // Owner B uses both protocol generations. Neither request path may
        // resolve A's handle, with or without an obsolete transport ID.
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
        for (generation, client) in [("legacy", &other_legacy), ("modern", &other_modern)] {
            for (tool, arguments) in [
                (
                    "dbx_execute_query",
                    json!({"connection_id": "mysql", "database": "app", "session_id": session_id, "sql": "SELECT 1"}),
                ),
                ("dbx_begin_transaction", json!({"session_id": session_id})),
                ("dbx_commit_transaction", json!({"session_id": session_id})),
                ("dbx_rollback_transaction", json!({"session_id": session_id})),
                ("dbx_close_session", json!({"session_id": session_id})),
            ] {
                let rejected = client
                    .call_tool(
                        CallToolRequestParams::new(tool).with_arguments(serde_json::from_value(arguments).unwrap()),
                    )
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
        assert!(backend
            .sql
            .lock()
            .unwrap()
            .iter()
            .all(|sql| sql != "SELECT 1" && sql != "COMMIT" && sql != "ROLLBACK"));

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
        // even while the client that opened it still exists.
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
        let id = "stale-legacy-session";
        let list = json!({"jsonrpc":"2.0","id":42,"method":"tools/list","params":{}});
        let response = http
            .post(&url)
            .bearer_auth(issuer.token("second-owner"))
            .header("mcp-session-id", id)
            .header("accept", "application/json, text/event-stream")
            .json(&list)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "legacy transport ID carries no principal authority");
        assert_eq!(
            http.delete(&url)
                .bearer_auth(issuer.token("second-owner"))
                .header("mcp-session-id", id)
                .send()
                .await
                .unwrap()
                .status(),
            405
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
        // The operation itself is dropped at expiry, not merely its HTTP body.
        backend.slow_load.store(true, Ordering::SeqCst);
        let mut short_claims = issuer.claims("owner");
        short_claims["exp"] = json!(jsonwebtoken::get_current_timestamp() + 2);
        let short_token = issuer.sign(&short_claims);
        let slow_call = http
            .post(&url)
            .bearer_auth(&short_token)
            .header("mcp-session-id", id)
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

        // Dropping a stateless POST response must cancel its SDK handler.
        backend.slow_load.store(true, Ordering::SeqCst);
        let abandoned = http
            .post(&url)
            .bearer_auth(&token)
            .header("mcp-session-id", id)
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
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while backend.running_load.load(Ordering::SeqCst) != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropping POST must cancel its in-flight operation without DELETE");
        backend.slow_load.store(false, Ordering::SeqCst);

        let recovered = http
            .post(&url)
            .bearer_auth(&token)
            .header("mcp-session-id", id)
            .header("accept", "application/json, text/event-stream")
            .json(&list)
            .send()
            .await
            .unwrap();
        assert_eq!(recovered.status(), 200, "old transport IDs must never require session restoration");
        assert!(recovered.text().await.unwrap().contains("dbx_list_connections"));
        drop(client);
        cancellation.cancel();
        task.await.unwrap();
    }
    #[tokio::test]
    async fn policy_rotation_and_shutdown_cancel_stateless_handlers_and_preserve_rollback() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let backend = Arc::new(HttpTestBackend::new());
        let auth = HttpAuth::new_with_hosts(Some("http-test-token".into()), [address.to_string()], [], false).unwrap();
        let stop = CancellationToken::new();
        let server_task = tokio::spawn(serve_streamable_http_on_listener(
            backend.clone(),
            HttpRuntimeConfig::new(address, "/mcp".into(), auth.clone(), vec![address.to_string()]),
            stop.clone(),
            listener,
        ));
        let url = format!("http://{address}/mcp");
        let (client, session_id) = open_active_transaction(&url).await;
        let http = reqwest::Client::new();
        let slow_body = json!({"jsonrpc":"2.0","id":81,"method":"tools/call","params":{"name":"dbx_list_connections"}});
        backend.slow_load.store(true, Ordering::SeqCst);
        let slow = http
            .post(&url)
            .bearer_auth("http-test-token")
            .header("accept", "application/json, text/event-stream")
            .json(&slow_body)
            .send()
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while backend.running_load.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        auth.reconfigure(Some("http-test-token".into()), [address.to_string()], []).unwrap();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), slow.bytes()).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while backend.running_load.load(Ordering::SeqCst) != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("policy rotation must cancel SDK operations, not only close response bodies");
        backend.slow_load.store(false, Ordering::SeqCst);
        // Rotation revokes in-flight authorization, not the DBX handle owned by
        // the same freshly authenticated principal on a later request.
        let query = client
            .call_tool(
                CallToolRequestParams::new("dbx_execute_query").with_arguments(
                    serde_json::from_value(
                        json!({"connection_id":"mysql","database":"app","session_id":session_id,"sql":"SELECT 1"}),
                    )
                    .unwrap(),
                ),
            )
            .await
            .unwrap();
        assert_ne!(query.is_error, Some(true));
        assert_eq!(query.structured_content.as_ref().unwrap()["transaction_state"], "active");
        backend.slow_load.store(true, Ordering::SeqCst);
        let slow = http
            .post(&url)
            .bearer_auth("http-test-token")
            .header("accept", "application/json, text/event-stream")
            .json(&slow_body)
            .send()
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while backend.running_load.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        stop.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(3), server_task).await.unwrap().unwrap().unwrap();
        assert_eq!(backend.running_load.load(Ordering::SeqCst), 0);
        wait_for_disposal(&backend).await;
        assert_eq!(backend.sql.lock().unwrap().iter().filter(|sql| *sql == "ROLLBACK").count(), 1);
        drop((slow, client));
    }
    #[tokio::test]
    async fn oauth_expiry_cancels_active_sql_and_disposes_its_uncertain_transaction() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let issuer = crate::oauth::test_issuer::issuer();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let backend = Arc::new(HttpTestBackend::new());
        let auth = HttpAuth::new_oauth(issuer.verifier(), vec![address.to_string()], vec![]).unwrap();
        let stop = CancellationToken::new();
        let server_task = tokio::spawn(serve_streamable_http_on_listener(
            backend.clone(),
            HttpRuntimeConfig::new(address, "/mcp".into(), auth, vec![address.to_string()]),
            stop.clone(),
            listener,
        ));
        let url = format!("http://{address}/mcp");
        let client = ()
            .serve(StreamableHttpClientTransport::from_config(
                StreamableHttpClientTransportConfig::with_uri(url.clone()).auth_header(issuer.token("owner")),
            ))
            .await
            .unwrap();
        let session_id = begin_active_transaction(&client).await;
        let mut claims = issuer.claims("owner");
        claims["exp"] = json!(jsonwebtoken::get_current_timestamp() + 3);
        let slow = reqwest::Client::new()
            .post(&url)
            .bearer_auth(issuer.sign(&claims))
            .header("accept", "application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","id":77,"method":"tools/call","params":{
                "name":"dbx_execute_query","arguments":{
                    "connection_id":"mysql","database":"app","session_id":session_id,"sql":"SELECT SLOW"
                }
            }}))
            .send()
            .await
            .unwrap();
        assert_eq!(slow.status(), 200);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while backend.running_sql.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("synthetic SQL must begin before token expiry");
        let _ = tokio::time::timeout(std::time::Duration::from_secs(4), slow.bytes()).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while backend.disconnects.load(Ordering::SeqCst) == 0 || backend.running_sql.load(Ordering::SeqCst) != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("expiry must discard the connection whose SQL result is now uncertain");
        // A cancelled command taints its connection. The owner closes it rather
        // than issuing further SQL on an unknown protocol/transaction state.
        assert_eq!(backend.sql.lock().unwrap().iter().filter(|sql| *sql == "ROLLBACK").count(), 0);
        let commit = client
            .call_tool(
                CallToolRequestParams::new("dbx_commit_transaction")
                    .with_arguments(serde_json::from_value(json!({"session_id":session_id})).unwrap()),
            )
            .await
            .unwrap();
        assert_eq!(commit.is_error, Some(true), "an expired SQL operation must never later commit");
        assert!(!backend.sql.lock().unwrap().iter().any(|sql| sql == "COMMIT"));
        // A fresh credential for the same principal remains usable; expiration
        // must not cancel the entire principal partition or unrelated requests.
        let _replacement = begin_active_transaction(&client).await;
        stop.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(3), server_task).await.unwrap().unwrap().unwrap();
        assert_eq!(backend.sql.lock().unwrap().iter().filter(|sql| *sql == "ROLLBACK").count(), 1);
        drop(client);
    }
    #[tokio::test]
    async fn both_stateless_protocol_generations_cancel_disconnected_handlers_and_release_permits() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let backend = Arc::new(HttpTestBackend::new());
        let auth = HttpAuth::new_with_hosts(Some("http-test-token".into()), [address.to_string()], [], false).unwrap();
        let stop = CancellationToken::new();
        let server_task = tokio::spawn(serve_streamable_http_on_listener(
            backend.clone(),
            HttpRuntimeConfig::new(address, "/mcp".into(), auth.clone(), vec![address.to_string()]),
            stop.clone(),
            listener,
        ));
        for version in ["2025-11-25", "2026-07-28"] {
            backend.slow_load.store(true, Ordering::SeqCst);
            let mut params = json!({"name":"dbx_list_connections"});
            if version == "2026-07-28" {
                params["_meta"] = json!({
                    "io.modelcontextprotocol/protocolVersion": version,
                    "io.modelcontextprotocol/clientCapabilities": {},
                    "io.modelcontextprotocol/clientInfo": {"name":"disconnect-test","version":"0"}
                });
            }
            let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":params}).to_string();
            let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
            socket.write_all(format!(
                "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer http-test-token\r\nMCP-Protocol-Version: {version}\r\nMcp-Method: tools/call\r\nMcp-Name: dbx_list_connections\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()
            ).as_bytes()).await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while backend.running_load.load(Ordering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("both SDK protocol paths must actually dispatch the handler");
            assert_eq!(auth.available_request_permits_for_test(), 31);
            // Legacy has already opened a POST SSE response; modern waits for
            // its first message. Disconnect must cancel either ownership path.
            drop(socket);
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while backend.running_load.load(Ordering::SeqCst) != 0
                    || auth.available_request_permits_for_test() != 32
                {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("disconnect must drop the real SDK handler and its admission permit");
        }
        stop.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(3), server_task).await.unwrap().unwrap().unwrap();
    }
    #[tokio::test]
    async fn independent_post_cancellation_notifications_match_upstream_stateless_semantics() {
        use tokio::io::AsyncWriteExt;
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let issuer = crate::oauth::test_issuer::issuer();
        for (protected, version) in
            [(false, "2025-11-25"), (false, "2026-07-28"), (true, "2025-11-25"), (true, "2026-07-28")]
        {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let backend = Arc::new(HttpTestBackend::new());
            backend.slow_load.store(true, Ordering::SeqCst);
            let auth = HttpAuth::new_oauth(issuer.verifier(), vec![address.to_string()], vec![]).unwrap();
            let stop = CancellationToken::new();
            let router = if protected {
                build_streamable_http_router(
                    backend.clone(),
                    "/mcp",
                    auth.clone(),
                    vec![address.to_string()],
                    false,
                    Some(stop.child_token()),
                    Arc::new(NeverSessionManager::default()),
                    PrincipalStates::new(DbxMcpServer::with_runtime_options(
                        backend.clone(),
                        McpScope::from_env(),
                        false,
                    )),
                )
                .unwrap()
            } else {
                // Exercise the upstream transport itself, without DBX's auth or
                // bounded wrapper, to pin the SDK's independent-POST contract.
                let service_backend = backend.clone();
                let service = StreamableHttpService::new(
                    move || {
                        Ok(DbxMcpServer::with_runtime_options(service_backend.clone(), McpScope::from_env(), false))
                    },
                    Arc::new(NeverSessionManager::default()),
                    StreamableHttpServerConfig::default()
                        .with_legacy_session_mode(false)
                        .with_allowed_hosts(vec![address.to_string()])
                        .with_cancellation_token(stop.child_token()),
                );
                Router::new().nest_service("/mcp", service)
            };
            let shutdown = stop.clone();
            let server_task = tokio::spawn(async move {
                axum::serve(listener, router)
                    .with_graceful_shutdown(async move { shutdown.cancelled().await })
                    .await
                    .unwrap();
            });
            let url = format!("http://{address}/mcp");
            let http = reqwest::Client::new();
            let mut params = json!({"name":"dbx_list_connections"});
            if version == "2026-07-28" {
                params["_meta"] = json!({
                    "io.modelcontextprotocol/protocolVersion": version,
                    "io.modelcontextprotocol/clientCapabilities": {},
                    "io.modelcontextprotocol/clientInfo": {"name":"cancel-test","version":"0"}
                });
            }
            let body = json!({"jsonrpc":"2.0","id":91,"method":"tools/call","params":params}).to_string();
            let mut running = tokio::net::TcpStream::connect(address).await.unwrap();
            let token = issuer.token("owner");
            running.write_all(format!(
                "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nMCP-Protocol-Version: {version}\r\nMcp-Method: tools/call\r\nMcp-Name: dbx_list_connections\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()
            ).as_bytes()).await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while backend.running_load.load(Ordering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            for subject in ["owner", "second-owner"] {
                let accepted = http
                    .post(&url)
                    .bearer_auth(issuer.token(subject))
                    .header("mcp-protocol-version", version)
                    .header("mcp-method", "notifications/cancelled")
                    .header("accept", "application/json, text/event-stream")
                    .json(&json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":91}}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(accepted.status(), 202);
                accepted.bytes().await.unwrap();
                assert!(tokio::time::timeout(std::time::Duration::from_millis(50), async {
                    while backend.running_load.load(Ordering::SeqCst) != 0 { tokio::task::yield_now().await; }
                }).await.is_err(), "an independent POST is acknowledged, not routed to another stateless request (protected={protected}, version={version}, subject={subject})");
            }
            // Actual cancellation is scoped to the owning POST's disconnect,
            // token deadline, policy generation, or server shutdown. A 202 from
            // notifications/cancelled is not evidence that another task ended.
            drop(running);
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while backend.running_load.load(Ordering::SeqCst) != 0
                    || (protected && auth.available_request_permits_for_test() != 32)
                {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            stop.cancel();
            tokio::time::timeout(std::time::Duration::from_secs(3), server_task).await.unwrap().unwrap();
        }
    }
}
