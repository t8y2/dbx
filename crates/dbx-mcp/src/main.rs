use std::sync::Arc;

use dbx_mcp::{
    http::serve_streamable_http, with_legacy_discovery_fallback, DbxBackend, DbxMcpServer, LocalBackend, McpTransport,
    RuntimeConfig, UnavailableBackend, WebBackend,
};
use rmcp::ServiceExt;

mod credentials;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args_os().nth(1).is_some_and(|argument| argument == "--version") {
        println!("dbx-mcp {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if std::env::args_os().nth(1).is_some_and(|argument| argument == "--authorize-keychain") {
        if std::env::args_os().len() != 2 {
            return Err("Usage: dbx-mcp --authorize-keychain".into());
        }
        credentials::authorize_keychain()?;
        println!("DBX Keychain access authorized. Restart your MCP client.");
        return Ok(());
    }
    run_noninteractive(run())
}

fn run_noninteractive(
    future: impl std::future::Future<Output = Result<(), Box<dyn std::error::Error>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    // This process-wide policy belongs only to the standalone binary and must
    // outlive the runtime, including credential reads during task shutdown.
    let _credential_guard = credentials::disable_background_interaction().map_err(std::io::Error::other)?;
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(future)
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    // Diagnostics (plugin-tool discovery, bridge fallbacks) go to stderr,
    // which is safe under the stdio transport. RUST_LOG controls the level;
    // warnings are on by default so silent degradation stays visible.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let runtime = RuntimeConfig::from_environment_and_args()?;
    let backend: Arc<dyn DbxBackend> = if let Ok(base_url) = std::env::var("DBX_WEB_URL") {
        Arc::new(
            WebBackend::new(base_url, std::env::var("DBX_WEB_PASSWORD").unwrap_or_default())
                .map_err(std::io::Error::other)?,
        )
    } else {
        let db_path = dbx_mcp::paths::storage_db_path().map_err(std::io::Error::other)?;
        match LocalBackend::open(&db_path).await {
            Ok(local) => Arc::new(local),
            // Returning here would close stdout before the transport starts, so the
            // client sees only EOF and this message stays on stderr. Serve the
            // reason instead: every request fails closed and carries it.
            Err(error) => {
                let reason = credentials::startup_error(error);
                eprintln!("Error: {reason}");
                Arc::new(UnavailableBackend::new(reason))
            }
        }
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

#[cfg(all(test, target_os = "macos", feature = "os-keyring"))]
mod tests {
    use super::*;
    use security_framework::os::macos::keychain::SecKeychain;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct ShutdownProbe(Arc<AtomicBool>);

    impl Drop for ShutdownProbe {
        fn drop(&mut self) {
            self.0.store(matches!(SecKeychain::user_interaction_allowed(), Ok(false)), Ordering::SeqCst);
        }
    }

    #[test]
    fn background_interaction_is_disabled_through_runtime_shutdown() {
        let original = SecKeychain::user_interaction_allowed().unwrap();
        let shutdown_was_noninteractive = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&shutdown_was_noninteractive);
        run_noninteractive(async move {
            assert!(!SecKeychain::user_interaction_allowed().unwrap());
            let (started, ready) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let _probe = ShutdownProbe(observed);
                started.send(()).unwrap();
                std::future::pending::<()>().await;
            });
            ready.await.unwrap();
            Ok(())
        })
        .unwrap();
        assert!(shutdown_was_noninteractive.load(Ordering::SeqCst));
        assert_eq!(SecKeychain::user_interaction_allowed().unwrap(), original);
    }
}
