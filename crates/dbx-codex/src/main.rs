use dbx_codex::{
    gateway::Gateway,
    runtime::{default_data_dir, ensure_runtime, read_token},
};
use rmcp::ServiceExt;
use std::{path::PathBuf, process::ExitCode};

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag] if flag == "--version" => {
            println!("dbx-codex {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        [flag] if flag == "--help" || flag == "-h" => {
            println!("dbx-codex [--version | --help]\n\nStart the local DBX workbench and serve MCP over stdio.\nDBX_CODEX_DATA_DIR overrides the dedicated user data directory (absolute path only).");
            return ExitCode::SUCCESS;
        }
        [] => {}
        _ => {
            eprintln!("Unknown arguments; use dbx-codex --help");
            return ExitCode::from(2);
        }
    }
    match serve().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("DBX Codex: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn serve() -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let web_binary = executable.parent().ok_or("Cannot locate plugin binaries")?.join(if cfg!(windows) {
        "dbx-web.exe"
    } else {
        "dbx-web"
    });
    let data_dir = match std::env::var_os("DBX_CODEX_DATA_DIR") {
        Some(value) => PathBuf::from(value),
        None => default_data_dir()?,
    };
    if !data_dir.is_absolute() {
        return Err("DBX_CODEX_DATA_DIR must be an absolute path".into());
    }
    let handle = ensure_runtime(&data_dir, &web_binary).await?;
    let gateway = std::sync::Arc::new(Gateway::new(handle, read_token(&data_dir)?));
    let service = gateway
        .clone()
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|_| "MCP stdio initialization failed".to_string())?;
    let result = service.waiting().await.map_err(|_| "MCP stdio service failed".to_string());
    gateway.shutdown().await?;
    result?;
    Ok(())
}
