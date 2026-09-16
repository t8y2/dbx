use std::{io, sync::Arc};

use axum::{http::Method, middleware, routing::get, Router};
use rmcp::transport::{
    streamable_http_server::{session::local::LocalSessionManager, tower::StreamableHttpService},
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
    build_streamable_http_router(backend, path, auth, allowed_hosts, web_mode, None)
}

fn build_streamable_http_router(
    backend: Arc<dyn DbxBackend>,
    path: &str,
    auth: HttpAuth,
    allowed_hosts: Vec<String>,
    web_mode: bool,
    cancellation: Option<CancellationToken>,
) -> Router {
    let mut rmcp_config = StreamableHttpServerConfig::default().with_allowed_hosts(allowed_hosts);
    if let Some(cancellation) = cancellation {
        rmcp_config = rmcp_config.with_cancellation_token(cancellation);
    }
    let server_backend = backend.clone();
    let scope = McpScope::from_env();
    let service: StreamableHttpService<DbxMcpServer, LocalSessionManager> = StreamableHttpService::new(
        move || Ok(DbxMcpServer::with_runtime_options(server_backend.clone(), scope.clone(), web_mode)),
        Default::default(),
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
    let mcp_router = build_streamable_http_router(
        backend,
        &config.path,
        config.auth,
        config.allowed_hosts,
        false,
        Some(cancellation.child_token()),
    );
    let router = Router::new().route("/healthz", get(health)).route("/readyz", get(health)).merge(mcp_router);

    eprintln!("DBX MCP Streamable HTTP listening on http://{}{}", config.bind_addr, config.path);

    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            cancellation.cancelled().await;
        })
        .await
}
