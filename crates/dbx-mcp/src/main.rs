use std::sync::Arc;

use dbx_mcp::{
    http::serve_streamable_http, with_legacy_discovery_fallback, DbxBackend, DbxMcpServer, LocalBackend, McpTransport,
    RuntimeConfig, WebBackend,
};
use rmcp::ServiceExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = RuntimeConfig::from_environment_and_args()?;
    let backend: Arc<dyn DbxBackend> = if let Ok(base_url) = std::env::var("DBX_WEB_URL") {
        Arc::new(
            WebBackend::new(
                base_url,
                std::env::var("DBX_WEB_PASSWORD").unwrap_or_default(),
                std::env::var("DBX_WEB_USERNAME").ok(),
            )
            .map_err(std::io::Error::other)?,
        )
    } else {
        let db_path = dbx_mcp::paths::storage_db_path().map_err(std::io::Error::other)?;
        Arc::new(LocalBackend::open(&db_path).await.map_err(std::io::Error::other)?)
    };
    match runtime.transport {
        McpTransport::Stdio => {
            let transport = with_legacy_discovery_fallback(rmcp::transport::stdio());
            let service = DbxMcpServer::new(backend).serve(transport).await?;
            service.waiting().await?;
            Ok(())
        }
        McpTransport::StreamableHttp => {
            let http = runtime.http.ok_or_else(|| std::io::Error::other("missing HTTP MCP runtime configuration"))?;
            serve_streamable_http(backend, http).await?;
            Ok(())
        }
    }
}
