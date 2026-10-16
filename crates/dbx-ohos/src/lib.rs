//! HarmonyOS host shim for the DBX Web server.
//!
//! The ArkTS side loads this cdylib through Node-API and calls `dbx_ohos_start`
//! once, before the ArkWeb view points at the loopback server.

use std::ffi::{c_char, CStr};
use std::sync::OnceLock;

static STARTED: OnceLock<i32> = OnceLock::new();

fn read_cstr(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let text = unsafe { CStr::from_ptr(ptr) }.to_str().ok()?;
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// Resolves the MCP bearer token, creating and persisting one on first start.
fn ensure_mcp_token(data_dir: &std::path::Path) -> std::io::Result<String> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join("mcp-token.txt");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() && !trimmed.chars().any(char::is_whitespace) {
            return Ok(trimmed.to_string());
        }
    }
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    std::fs::write(&path, &token)?;
    Ok(token)
}

/// Enables the Web MCP endpoint with a deployment token.
///
/// The settings UI only manages tokens when password authentication is on, and a
/// loopback deployment disables the password gate, so the shim owns the token.
fn enable_web_mcp(data_dir: Option<std::path::PathBuf>) {
    if std::env::var("DBX_WEB_MCP_TOKEN").is_ok() || std::env::var("DBX_WEB_MCP_TOKEN_FILE").is_ok() {
        return;
    }
    let token = match data_dir.as_deref() {
        Some(dir) => match ensure_mcp_token(dir) {
            Ok(token) => {
                eprintln!("dbx-ohos: MCP token file {}/mcp-token.txt", dir.display());
                token
            }
            Err(error) => {
                eprintln!("dbx-ohos: failed to persist the MCP token: {error}");
                return;
            }
        },
        None => {
            eprintln!("dbx-ohos: no data dir, using an in-memory MCP token");
            format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
        }
    };
    std::env::set_var("DBX_WEB_MCP_TOKEN", &token);
    std::env::set_var("DBX_WEB_MCP_ALLOWED_HOSTS", "127.0.0.1,localhost");
    std::env::set_var(
        "DBX_WEB_MCP_ALLOWED_ORIGINS",
        "http://127.0.0.1:4224,http://localhost:4224,http://127.0.0.1:5224,http://localhost:5224",
    );
    eprintln!("dbx-ohos: web MCP enabled for loopback hosts, token {token}");
}

/// Start the DBX Web server on a dedicated thread.
///
/// Returns 0 when the server thread was spawned, 1 when it was already started
/// and 2 when the thread could not be created. `port` <= 0 keeps DBX_PORT or the
/// upstream default; null path arguments keep the current environment.
#[no_mangle]
pub extern "C" fn dbx_ohos_start(port: i32, data_dir: *const c_char, static_dir: *const c_char) -> i32 {
    if STARTED.get().is_some() {
        return 1;
    }
    if port > 0 {
        std::env::set_var("DBX_PORT", port.to_string());
    }
    if let Some(dir) = read_cstr(data_dir) {
        std::env::set_var("DBX_DATA_DIR", dir);
    }
    if let Some(dir) = read_cstr(static_dir) {
        std::env::set_var("DBX_STATIC_DIR", dir);
    }
    // Loopback-only by default: the shell on the device is the trusted client and
    // the tablet must never expose an unauthenticated SQL endpoint to its network.
    if std::env::var("DBX_BIND_ADDR").is_err() {
        std::env::set_var("DBX_BIND_ADDR", "127.0.0.1");
    }
    let loopback_only = std::env::var("DBX_BIND_ADDR")
        .map(|value| {
            let value = value.trim().to_string();
            value.starts_with("127.") || value == "::1"
        })
        .unwrap_or(true);
    // The password gate exists for listeners reachable from the network, so keep
    // it enabled whenever the bind address is not loopback.
    if loopback_only && std::env::var("DBX_DISABLE_PASSWORD").is_err() {
        std::env::set_var("DBX_DISABLE_PASSWORD", "1");
    }
    let data_dir = std::env::var("DBX_DATA_DIR").ok().filter(|dir| !dir.is_empty()).map(std::path::PathBuf::from);
    enable_web_mcp(data_dir);
    let _ = STARTED.set(0);
    match std::thread::Builder::new().name("dbx-web-server".to_string()).spawn(|| {
        let _ = dbx_web::run_server();
    }) {
        Ok(_) => 0,
        Err(error) => {
            eprintln!("dbx-ohos: failed to spawn server thread: {error}");
            2
        }
    }
}

/// Probe used by ArkTS to confirm the module and the linked server are present.
#[no_mangle]
pub extern "C" fn dbx_ohos_probe() -> i32 {
    1
}
