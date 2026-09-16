use std::{
    collections::VecDeque,
    fs,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use dbx_core::{connection::AppState, storage::McpHttpServerSettings};
use dbx_mcp::{serve_streamable_http_on_listener, DbxBackend, HttpAuth, HttpRuntimeConfig, LocalBackend};
use serde::Serialize;
use tauri::State;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const TOKEN_FILE_NAME: &str = "mcp-http-token";

/// Owns the optional in-process Streamable HTTP server. It is intentionally
/// separate from `AppState`: this is desktop runtime state, not database data.
pub struct McpHttpServerState {
    data_dir: PathBuf,
    /// Serializes lifecycle operations. In particular, a settings save must
    /// finish shutting down the old listener before it binds the replacement.
    operation_lock: tokio::sync::Mutex<()>,
    server: Mutex<Option<RunningServer>>,
    diagnostics: Arc<Mutex<McpHttpServerDiagnostics>>,
    supervisor: Mutex<Option<HealthSupervisor>>,
    next_supervisor_id: AtomicU64,
}

struct RunningServer {
    settings: McpHttpServerSettings,
    cancellation: CancellationToken,
    task: tauri::async_runtime::JoinHandle<()>,
}

struct HealthSupervisor {
    id: u64,
    cancellation: CancellationToken,
}

#[derive(Default)]
struct McpHttpServerDiagnostics {
    last_error: Option<String>,
    logs: VecDeque<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHttpServerStatus {
    pub enabled: bool,
    pub running: bool,
    pub endpoint: Option<String>,
    /// Returned only to the local desktop renderer so the user can copy the
    /// credential into an MCP client. It is never persisted in app settings.
    pub access_token: Option<String>,
    pub last_error: Option<String>,
    pub recent_logs: Vec<String>,
}

impl McpHttpServerState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            operation_lock: tokio::sync::Mutex::new(()),
            server: Mutex::new(None),
            diagnostics: Arc::new(Mutex::new(McpHttpServerDiagnostics::default())),
            supervisor: Mutex::new(None),
            next_supervisor_id: AtomicU64::new(1),
        }
    }

    fn token_path(&self) -> PathBuf {
        self.data_dir.join(TOKEN_FILE_NAME)
    }

    fn rotate_token(&self) -> Result<(), String> {
        let path = self.token_path();
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("failed to rotate MCP HTTP token: {error}")),
        }
    }

    fn load_or_create_token(&self) -> Result<String, String> {
        let path = self.token_path();
        if let Ok(token) = fs::read_to_string(&path) {
            let token = token.trim().to_string();
            if !token.is_empty() {
                return Ok(token);
            }
        }

        fs::create_dir_all(&self.data_dir).map_err(|error| format!("failed to create MCP token directory: {error}"))?;
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        fs::write(&path, &token).map_err(|error| format!("failed to save MCP HTTP token: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("failed to protect MCP HTTP token: {error}"))?;
        }
        Ok(token)
    }

    fn status(&self, settings: &McpHttpServerSettings) -> McpHttpServerStatus {
        let mut server = self.server.lock().unwrap_or_else(|error| error.into_inner());
        let running = server.as_ref().is_some_and(|server| !server.task.inner().is_finished());
        if !running {
            *server = None;
        }
        let endpoint = settings.enabled.then(|| endpoint_for_settings(settings)).flatten();
        let access_token = settings.enabled.then(|| self.load_or_create_token()).transpose().ok().flatten();
        let diagnostics = self.diagnostics.lock().unwrap_or_else(|error| error.into_inner());
        McpHttpServerStatus {
            enabled: settings.enabled,
            running,
            endpoint,
            access_token,
            last_error: diagnostics.last_error.clone(),
            recent_logs: diagnostics.logs.iter().cloned().collect(),
        }
    }

    fn record_error(&self, error: String) {
        let mut diagnostics = self.diagnostics.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        diagnostics.last_error = Some(error.clone());
        push_log(&mut diagnostics, format!("ERROR {error}"));
    }

    fn cancel_health_supervisor(&self) {
        let supervisor = self.supervisor.lock().unwrap_or_else(|error| error.into_inner()).take();
        if let Some(supervisor) = supervisor {
            supervisor.cancellation.cancel();
        }
    }

    fn claim_health_supervisor(&self) -> Option<(u64, CancellationToken)> {
        let mut supervisor = self.supervisor.lock().unwrap_or_else(|error| error.into_inner());
        if supervisor.is_some() {
            return None;
        }
        let id = self.next_supervisor_id.fetch_add(1, Ordering::Relaxed);
        let cancellation = CancellationToken::new();
        *supervisor = Some(HealthSupervisor { id, cancellation: cancellation.clone() });
        Some((id, cancellation))
    }

    fn release_health_supervisor(&self, id: u64) {
        let mut supervisor = self.supervisor.lock().unwrap_or_else(|error| error.into_inner());
        if supervisor.as_ref().is_some_and(|supervisor| supervisor.id == id) {
            *supervisor = None;
        }
    }

    async fn stop_locked(&self) {
        let running_server = {
            let mut server = self.server.lock().unwrap_or_else(|error| error.into_inner());
            server.take()
        };
        if let Some(server) = running_server {
            server.cancellation.cancel();
            // The listener lives inside the Axum task. Cancelling and waiting
            // for that task ensures the socket is actually released before a
            // replacement listener tries to bind the same address and port.
            let mut task = server.task;
            if tokio::time::timeout(std::time::Duration::from_secs(3), &mut task).await.is_err() {
                task.abort();
                let _ = task.await;
            }
        }
    }

    async fn stop(&self) {
        let _operation = self.operation_lock.lock().await;
        self.stop_locked().await;
    }

    async fn start(&self, app_state: Arc<AppState>, settings: &McpHttpServerSettings) -> Result<(), String> {
        let _operation = self.operation_lock.lock().await;
        let config = self.runtime_config(settings)?;
        let previous_settings = self
            .server
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|server| server.settings.clone());
        match self.start_with_config_locked(app_state.clone(), settings, config).await {
            Ok(()) => Ok(()),
            Err(error) => {
                if let Some(previous_settings) = previous_settings {
                    match self.runtime_config(&previous_settings).map(|config| (previous_settings, config)) {
                        Ok((previous_settings, config)) => {
                            if let Err(restore_error) =
                                self.start_with_config_locked(app_state, &previous_settings, config).await
                            {
                                return Err(format!("{error}; additionally failed to restore the previous MCP HTTP service: {restore_error}"));
                            }
                        }
                        Err(restore_error) => {
                            return Err(format!("{error}; additionally failed to restore the previous MCP HTTP service: {restore_error}"));
                        }
                    }
                }
                Err(error)
            }
        }
    }

    fn runtime_config(&self, settings: &McpHttpServerSettings) -> Result<HttpRuntimeConfig, String> {
        validate_settings(settings)?;
        let token = self.load_or_create_token()?;
        let ip = settings.host.parse::<IpAddr>().map_err(|_| "MCP HTTP host must be an IP address".to_string())?;
        let bind_addr = SocketAddr::new(ip, settings.port);
        let allowed_hosts = if ip.is_loopback() {
            vec!["localhost".to_string(), "127.0.0.1".to_string(), "::1".to_string()]
        } else {
            settings.allowed_hosts.clone()
        };
        let auth = HttpAuth::new(token, settings.allowed_origins.clone(), ip.is_loopback())?;
        Ok(HttpRuntimeConfig::new(bind_addr, settings.path.clone(), auth, allowed_hosts))
    }

    async fn start_with_config_locked(
        &self,
        app_state: Arc<AppState>,
        settings: &McpHttpServerSettings,
        config: HttpRuntimeConfig,
    ) -> Result<(), String> {
        self.stop_locked().await;
        // Bind before we claim success in the UI. This makes an occupied port
        // or an invalid socket setup a synchronous settings error instead of
        // a misleading short-lived "running" status.
        let bind_addr = config.bind_addr();
        let listener = tokio::net::TcpListener::bind(bind_addr)
            .await
            .map_err(|error| format!("failed to bind MCP HTTP service at {bind_addr}: {error}"))?;
        let cancellation = CancellationToken::new();
        let diagnostics = self.diagnostics.clone();
        let backend: Arc<dyn DbxBackend> = Arc::new(LocalBackend::from_app_state(app_state, self.data_dir.clone()));
        let shutdown = cancellation.clone();
        let task = tauri::async_runtime::spawn(async move {
            let result = serve_streamable_http_on_listener(backend, config, shutdown.clone(), listener).await;
            if let Err(error) = result {
                let mut diagnostics = diagnostics.lock().unwrap_or_else(|error| error.into_inner());
                let message = format!("MCP HTTP service stopped unexpectedly: {error}");
                diagnostics.last_error = Some(message.clone());
                push_log(&mut diagnostics, format!("ERROR {message}"));
            } else if !shutdown.is_cancelled() {
                let mut diagnostics = diagnostics.lock().unwrap_or_else(|error| error.into_inner());
                let message = "MCP HTTP service stopped unexpectedly".to_string();
                diagnostics.last_error = Some(message.clone());
                push_log(&mut diagnostics, format!("ERROR {message}"));
            }
        });
        *self.server.lock().unwrap_or_else(|error| error.into_inner()) =
            Some(RunningServer { settings: settings.clone(), cancellation, task });
        {
            let mut diagnostics = self.diagnostics.lock().unwrap_or_else(|error| error.into_inner());
            diagnostics.last_error = None;
            push_log(&mut diagnostics, "MCP HTTP service started".to_string());
        }
        Ok(())
    }
}

fn endpoint_for_settings(settings: &McpHttpServerSettings) -> Option<String> {
    let host = settings.host.trim();
    let authority = match host {
        "0.0.0.0" | "::" => format_client_authority(
            settings.allowed_hosts.first().map(|host| host.trim()).filter(|host| !host.is_empty())?,
            settings.port,
        ),
        host if host.contains(':') => format!("[{host}]:{}", settings.port),
        host => format!("{host}:{}", settings.port),
    };
    Some(format!("http://{authority}{}", settings.path))
}

fn format_client_authority(authority: &str, port: u16) -> String {
    if authority.starts_with('[') {
        return if authority.rsplit_once(':').is_some_and(|(_, port)| port.parse::<u16>().is_ok()) {
            authority.to_string()
        } else {
            format!("{authority}:{port}")
        };
    }
    if let Ok(ip) = authority.parse::<IpAddr>() {
        return if ip.is_ipv6() { format!("[{authority}]:{port}") } else { format!("{authority}:{port}") };
    }
    if authority.rsplit_once(':').is_some_and(|(_, port)| port.parse::<u16>().is_ok()) {
        authority.to_string()
    } else {
        format!("{authority}:{port}")
    }
}

fn push_log(diagnostics: &mut McpHttpServerDiagnostics, line: String) {
    const MAX_LOG_LINES: usize = 100;
    diagnostics.logs.push_back(line);
    while diagnostics.logs.len() > MAX_LOG_LINES {
        diagnostics.logs.pop_front();
    }
}

impl Drop for McpHttpServerState {
    fn drop(&mut self) {
        if let Some(supervisor) = self.supervisor.get_mut().unwrap_or_else(|error| error.into_inner()).take() {
            supervisor.cancellation.cancel();
        }
        if let Some(server) = self.server.get_mut().unwrap_or_else(|error| error.into_inner()).take() {
            server.cancellation.cancel();
            server.task.abort();
        }
    }
}

fn validate_settings(settings: &McpHttpServerSettings) -> Result<(), String> {
    let ip = settings.host.parse::<IpAddr>().map_err(|_| "MCP HTTP host must be an IP address".to_string())?;
    if settings.port == 0 {
        return Err("MCP HTTP port must be between 1 and 65535".to_string());
    }
    if settings.path == "/"
        || !settings.path.starts_with('/')
        || settings.path.ends_with('/')
        || settings.path.contains('?')
        || settings.path.contains('#')
    {
        return Err("MCP HTTP path must be an absolute path such as /mcp".to_string());
    }
    if !ip.is_loopback() {
        if !settings.allow_remote {
            return Err("non-loopback MCP HTTP binding requires remote access to be explicitly enabled".to_string());
        }
        if settings.allowed_hosts.is_empty() || settings.allowed_origins.is_empty() {
            return Err("remote MCP HTTP binding requires allowed hosts and allowed origins".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn load_mcp_http_server_settings(state: State<'_, Arc<AppState>>) -> Result<McpHttpServerSettings, String> {
    state.storage.load_mcp_http_server_settings().await
}

#[tauri::command]
pub async fn save_mcp_http_server_settings(
    settings: McpHttpServerSettings,
    state: State<'_, Arc<AppState>>,
    service: State<'_, Arc<McpHttpServerState>>,
) -> Result<McpHttpServerStatus, String> {
    let previous_settings = state.storage.load_mcp_http_server_settings().await?;
    if settings.enabled {
        service.start(state.inner().clone(), &settings).await?;
    } else {
        service.stop().await;
    }
    if let Err(error) = state.storage.save_mcp_http_server_settings(&settings).await {
        let restore_result = if previous_settings.enabled {
            service.start(state.inner().clone(), &previous_settings).await
        } else {
            service.stop().await;
            Ok(())
        };
        if let Err(restore_error) = restore_result {
            return Err(format!(
                "{error}; additionally failed to restore the previous MCP HTTP service: {restore_error}"
            ));
        }
        return Err(error);
    }
    if settings.enabled {
        spawn_health_supervisor(state.inner().clone(), service.inner().clone());
    } else {
        service.cancel_health_supervisor();
    }
    Ok(service.status(&settings))
}

#[tauri::command]
pub async fn mcp_http_server_status(
    state: State<'_, Arc<AppState>>,
    service: State<'_, Arc<McpHttpServerState>>,
) -> Result<McpHttpServerStatus, String> {
    let settings = state.storage.load_mcp_http_server_settings().await?;
    let status = service.status(&settings);
    if settings.enabled && !status.running {
        if let Err(error) = service.start(state.inner().clone(), &settings).await {
            service.record_error(format!("automatic restart failed: {error}"));
        }
    }
    Ok(service.status(&settings))
}

#[tauri::command]
pub async fn rotate_mcp_http_server_token(
    state: State<'_, Arc<AppState>>,
    service: State<'_, Arc<McpHttpServerState>>,
) -> Result<McpHttpServerStatus, String> {
    let settings = state.storage.load_mcp_http_server_settings().await?;
    service.rotate_token()?;
    if settings.enabled {
        service.start(state.inner().clone(), &settings).await?;
    }
    Ok(service.status(&settings))
}

pub async fn start_if_enabled(state: Arc<AppState>, service: Arc<McpHttpServerState>) {
    match state.storage.load_mcp_http_server_settings().await {
        Ok(settings) if settings.enabled => {
            if let Err(error) = service.start(state.clone(), &settings).await {
                log::warn!("Failed to restore MCP HTTP service: {error}");
                service.record_error(format!("failed to restore MCP HTTP service: {error}"));
            }
            spawn_health_supervisor(state, service);
        }
        Ok(_) => {}
        Err(error) => log::warn!("Failed to load MCP HTTP settings: {error}"),
    }
}

/// The service is optional, but once a user explicitly enables it it should
/// not require opening Settings to recover from a transient child-process
/// failure. The supervisor deliberately lives only in the desktop process:
/// Web deployments are managed by their container/process supervisor instead.
fn spawn_health_supervisor(state: Arc<AppState>, service: Arc<McpHttpServerState>) {
    let Some((supervisor_id, cancellation)) = service.claim_health_supervisor() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(15)) => {}
            }
            let settings = match state.storage.load_mcp_http_server_settings().await {
                Ok(settings) => settings,
                Err(error) => {
                    service.record_error(format!("MCP HTTP health supervisor could not load settings: {error}"));
                    continue;
                }
            };
            if !settings.enabled {
                break;
            }
            if !service.status(&settings).running {
                if let Err(error) = service.start(state.clone(), &settings).await {
                    service.record_error(format!("automatic restart failed: {error}"));
                }
            }
        }
        service.release_health_supervisor(supervisor_id);
    });
}

#[cfg(test)]
mod tests {
    use super::{endpoint_for_settings, McpHttpServerState};
    use dbx_core::storage::McpHttpServerSettings;

    #[test]
    fn endpoint_uses_a_client_reachable_authority() {
        let settings = McpHttpServerSettings {
            enabled: true,
            host: "0.0.0.0".to_string(),
            port: 5225,
            path: "/mcp".to_string(),
            allow_remote: true,
            allowed_hosts: vec!["mcp.example.test:5225".to_string()],
            allowed_origins: vec!["https://client.example.test".to_string()],
        };
        assert_eq!(endpoint_for_settings(&settings).as_deref(), Some("http://mcp.example.test:5225/mcp"));

        let hostname_without_port =
            McpHttpServerSettings { allowed_hosts: vec!["mcp.example.test".to_string()], ..settings.clone() };
        assert_eq!(endpoint_for_settings(&hostname_without_port).as_deref(), Some("http://mcp.example.test:5225/mcp"));

        let remote_ipv6 = McpHttpServerSettings { allowed_hosts: vec!["2001:db8::1".to_string()], ..settings.clone() };
        assert_eq!(endpoint_for_settings(&remote_ipv6).as_deref(), Some("http://[2001:db8::1]:5225/mcp"));

        let ipv6 =
            McpHttpServerSettings { host: "::1".to_string(), allow_remote: false, allowed_hosts: vec![], ..settings };
        assert_eq!(endpoint_for_settings(&ipv6).as_deref(), Some("http://[::1]:5225/mcp"));
    }

    #[test]
    fn cancelled_supervisor_cannot_clear_a_replacement() {
        let service = McpHttpServerState::new(std::env::temp_dir());
        let (first_id, _) = service.claim_health_supervisor().expect("first supervisor");
        service.cancel_health_supervisor();
        let (second_id, _) = service.claim_health_supervisor().expect("replacement supervisor");

        service.release_health_supervisor(first_id);
        assert_ne!(first_id, second_id);
        assert!(service.claim_health_supervisor().is_none());
    }
}
