use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dbx_sqlite_worker::{WorkerBody, WorkerOp, WorkerRequest, WorkerResponse};
use russh::client::Handle;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex as AsyncMutex;

use crate::db::ssh_prompt::{self, SshPromptAnswer, SshPromptKind, SshPromptRequest};
use crate::db::ssh_tunnel::{self, SshClient, TunnelManager};
use crate::models::connection::{ConnectionConfig, DatabaseType, SshTunnelConfig, TransportLayerConfig};
use crate::types::QueryResult;
use crate::{download_candidate_urls, CNB_RELEASE_DOWNLOAD_PREFIX, GITHUB_RELEASE_DOWNLOAD_PREFIX};

const WORKER_PATH_ENV: &str = "DBX_SQLITE_WORKER_PATH";
const DEFAULT_PERSIST_DIR: &str = "~/.cache/dbx/sqlite-worker";
const CONSENT_FILE_NAME: &str = "sqlite-worker-consent.json";
static SQLITE_SSH_RUNTIME_ENABLED: AtomicBool = AtomicBool::new(false);
static SQLITE_SSH_APP_VERSION: Mutex<String> = Mutex::new(String::new());

pub fn enable_sqlite_ssh_runtime(app_version: impl Into<String>) {
    SQLITE_SSH_RUNTIME_ENABLED.store(true, Ordering::SeqCst);
    *SQLITE_SSH_APP_VERSION.lock().expect("sqlite ssh app version lock") = app_version.into();
}

pub fn sqlite_ssh_runtime_enabled() -> bool {
    SQLITE_SSH_RUNTIME_ENABLED.load(Ordering::SeqCst)
}

fn runtime_app_version() -> String {
    let version = SQLITE_SSH_APP_VERSION.lock().expect("sqlite ssh app version lock");
    if version.is_empty() {
        env!("CARGO_PKG_VERSION").to_string()
    } else {
        version.clone()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqliteWorkerPlacement {
    Session,
    Persist,
    Preplaced,
}

pub fn sqlite_ssh_worker_requested(config: &ConnectionConfig) -> bool {
    config.db_type == DatabaseType::Sqlite && config.has_effective_ssh_tunnels()
}

pub fn sqlite_worker_placement(config: &ConnectionConfig) -> SqliteWorkerPlacement {
    match url_param(config.url_params.as_deref(), "dbx_sqlite_worker").as_deref() {
        Some("persist") => SqliteWorkerPlacement::Persist,
        Some("preplaced") => SqliteWorkerPlacement::Preplaced,
        _ => SqliteWorkerPlacement::Session,
    }
}

pub fn sqlite_worker_remote_path(config: &ConnectionConfig) -> String {
    url_param(config.url_params.as_deref(), "dbx_sqlite_worker_path").unwrap_or_default()
}

fn url_param(params: Option<&str>, key: &str) -> Option<String> {
    params?.trim().trim_start_matches('?').split('&').find_map(|part| {
        let (raw_key, raw_value) = part.split_once('=')?;
        (raw_key == key).then(|| {
            percent_encoding::percent_decode_str(&raw_value.replace('+', " ")).decode_utf8_lossy().into_owned()
        })
    })
}

trait WorkerStream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T> WorkerStream for T where T: AsyncRead + AsyncWrite + Send + Unpin {}
type DynStream = Pin<Box<dyn WorkerStream>>;

pub struct SqliteWorkerClient {
    io: AsyncMutex<WorkerIo>,
    next_id: AtomicU64,
}

enum WorkerIo {
    #[allow(dead_code)]
    Process {
        child: Child,
        stdin: ChildStdin,
        stdout: BufReader<tokio::process::ChildStdout>,
    },
    Ssh {
        _session: Handle<SshClient>,
        stream: DynStream,
    },
}

impl SqliteWorkerClient {
    pub async fn query(&self, sql: &str, max_rows: Option<usize>) -> Result<QueryResult, String> {
        match self.roundtrip(WorkerOp::Query { sql: sql.to_string(), max_rows }).await? {
            WorkerBody::Ok { columns, rows, affected_rows, truncated, .. } => Ok(QueryResult {
                columns: columns.unwrap_or_default(),
                column_types: Vec::new(),
                column_sortables: vec![],
                spatial_columns: vec![],
                spatial_values: vec![],
                rows: rows.unwrap_or_default(),
                affected_rows: affected_rows.unwrap_or(0),
                execution_time_ms: 0,
                truncated: truncated.unwrap_or(false),
                session_id: None,
                has_more: false,
                elasticsearch_raw_body: None,
                messages: Vec::new(),
            }),
            WorkerBody::Err { error } => Err(error),
        }
    }

    pub async fn backup(&self, dest: &str) -> Result<(), String> {
        match self.roundtrip(WorkerOp::Backup { dest: dest.to_string() }).await? {
            WorkerBody::Ok { .. } => Ok(()),
            WorkerBody::Err { error } => Err(error),
        }
    }

    pub async fn restore(&self, src: &str) -> Result<(), String> {
        match self.roundtrip(WorkerOp::Restore { src: src.to_string() }).await? {
            WorkerBody::Ok { .. } => Ok(()),
            WorkerBody::Err { error } => Err(error),
        }
    }

    async fn open_database(&self, path: &str) -> Result<(), String> {
        match self.roundtrip(WorkerOp::Open { path: path.to_string() }).await? {
            WorkerBody::Ok { .. } => Ok(()),
            WorkerBody::Err { error } => Err(error),
        }
    }

    async fn roundtrip(&self, op: WorkerOp) -> Result<WorkerBody, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut encoded = serde_json::to_vec(&WorkerRequest { id, op }).map_err(|e| e.to_string())?;
        encoded.push(b'\n');
        let mut io = self.io.lock().await;
        match &mut *io {
            WorkerIo::Process { stdin, stdout, .. } => {
                stdin.write_all(&encoded).await.map_err(|e| e.to_string())?;
                stdin.flush().await.map_err(|e| e.to_string())?;
                let mut line = String::new();
                stdout.read_line(&mut line).await.map_err(|e| e.to_string())?;
                parse_response(id, &line)
            }
            WorkerIo::Ssh { stream, .. } => {
                stream.write_all(&encoded).await.map_err(|e| e.to_string())?;
                stream.flush().await.map_err(|e| e.to_string())?;
                let mut line = Vec::new();
                loop {
                    let mut byte = [0u8; 1];
                    stream
                        .read_exact(&mut byte)
                        .await
                        .map_err(|e| format!("SQLite worker closed the SSH session: {e}"))?;
                    if byte[0] == b'\n' {
                        break;
                    }
                    line.push(byte[0]);
                    if line.len() > 16 * 1024 * 1024 {
                        return Err("SQLite worker response exceeded 16 MiB".to_string());
                    }
                }
                parse_response(id, &String::from_utf8_lossy(&line))
            }
        }
    }
}

impl Drop for SqliteWorkerClient {
    fn drop(&mut self) {
        if let Ok(mut io) = self.io.try_lock() {
            if let WorkerIo::Process { child, .. } = &mut *io {
                let _ = child.start_kill();
            }
        }
    }
}

fn parse_response(id: u64, line: &str) -> Result<WorkerBody, String> {
    let response: WorkerResponse =
        serde_json::from_str(line.trim()).map_err(|e| format!("invalid worker response: {e}"))?;
    if response.id != id {
        return Err(format!("SQLite worker response id {} did not match {id}", response.id));
    }
    Ok(response.body)
}

pub async fn connect_sqlite_worker(
    tunnels: &TunnelManager,
    data_dir: &Path,
    connection_id: &str,
    config: &ConnectionConfig,
) -> Result<Arc<SqliteWorkerClient>, String> {
    if !sqlite_ssh_runtime_enabled() {
        return Err("Remote SQLite over SSH is only available in the DBX Desktop app".to_string());
    }
    if !config.password.is_empty() {
        return Err("Remote SQLite over SSH does not support SQLCipher in v1".to_string());
    }
    if sqlite_has_extensions(config.url_params.as_deref()) {
        return Err("Remote SQLite over SSH does not support loadable extensions in v1".to_string());
    }
    if !config.attached_databases.is_empty() {
        return Err("Remote SQLite over SSH does not support attached databases in v1".to_string());
    }

    let hops = ssh_hops(config)?;
    let db_path = config.host.trim();
    if db_path.is_empty() {
        return Err("Remote SQLite path is empty".to_string());
    }
    if !Path::new(db_path).is_absolute() && !db_path.starts_with("~/") {
        return Err("Remote SQLite path must be an absolute path on the final SSH hop".to_string());
    }
    validate_remote_path(db_path)?;

    let placement = sqlite_worker_placement(config);
    let configured_path = sqlite_worker_remote_path(config);
    let session = open_final_hop_session(tunnels, connection_id, &hops).await?;
    let remote_home = ssh_capture(&session, "printf %s \"$HOME\"").await?;
    let expand_home = |path: &str| {
        if let Some(rest) = path.strip_prefix("~/") {
            format!("{}/{}", remote_home.trim_end_matches('/'), rest)
        } else if path == "~" {
            remote_home.clone()
        } else {
            path.to_string()
        }
    };

    let arch = remote_linux_arch(&session).await?;
    let local_worker = resolve_local_worker(data_dir, &runtime_app_version(), &arch).await?;
    let digest = local_worker.digest.clone();
    let identity = hop_identity(hops.last().ok_or("SSH hop list is empty")?);

    let remote_path = match placement {
        SqliteWorkerPlacement::Preplaced => {
            if configured_path.trim().is_empty() {
                return Err("Pre-placed SQLite worker path is required".to_string());
            }
            validate_remote_path(&configured_path)?;
            expand_home(&configured_path)
        }
        SqliteWorkerPlacement::Persist => {
            let path = if configured_path.trim().is_empty() {
                format!("{DEFAULT_PERSIST_DIR}/{digest}")
            } else {
                validate_remote_path(&configured_path)?;
                configured_path
            };
            expand_home(&path)
        }
        SqliteWorkerPlacement::Session => {
            expand_home(&format!("{DEFAULT_PERSIST_DIR}/session-{connection_id}-{digest}"))
        }
    };

    if placement != SqliteWorkerPlacement::Preplaced {
        ensure_worker_consent(data_dir, &identity, &remote_path, &digest).await?;
        upload_worker(&session, &remote_path, &local_worker.bytes).await?;
    }
    verify_remote_digest(&session, &remote_path, &digest).await?;

    let channel = session.channel_open_session().await.map_err(|e| format!("SSH session channel failed: {e}"))?;
    channel
        .exec(true, format!("exec {}", shell_quote(&remote_path)))
        .await
        .map_err(|e| format!("failed to start SQLite worker: {e}"))?;
    let stream: DynStream = Box::pin(channel.into_stream());
    let client = SqliteWorkerClient {
        io: AsyncMutex::new(WorkerIo::Ssh { _session: session, stream }),
        next_id: AtomicU64::new(1),
    };
    client.open_database(&expand_home(db_path)).await?;
    Ok(Arc::new(client))
}

struct LocalWorker {
    bytes: Vec<u8>,
    digest: String,
}

async fn resolve_local_worker(data_dir: &Path, app_version: &str, arch: &str) -> Result<LocalWorker, String> {
    if let Ok(path) = std::env::var(WORKER_PATH_ENV) {
        let bytes = tokio::fs::read(&path).await.map_err(|e| format!("failed to read {WORKER_PATH_ENV}: {e}"))?;
        return Ok(LocalWorker { digest: sha256_hex(&bytes), bytes });
    }
    let cache_dir = data_dir.join("sqlite-worker");
    tokio::fs::create_dir_all(&cache_dir).await.map_err(|e| e.to_string())?;
    let artifact = format!("dbx-sqlite-worker-linux-{arch}");
    let cache_path = cache_dir.join(&artifact);
    if cache_path.is_file() {
        let bytes = tokio::fs::read(&cache_path).await.map_err(|e| e.to_string())?;
        return Ok(LocalWorker { digest: sha256_hex(&bytes), bytes });
    }
    let tag = if app_version.starts_with('v') { app_version.to_string() } else { format!("v{app_version}") };
    let github = format!("{GITHUB_RELEASE_DOWNLOAD_PREFIX}{tag}/{artifact}");
    let r2_path = format!("releases/{tag}/{artifact}");
    let mut urls = download_candidate_urls(&github, &r2_path);
    urls.push(format!("{CNB_RELEASE_DOWNLOAD_PREFIX}{tag}/{artifact}"));
    let mut last_error = "no download URL".to_string();
    for url in urls {
        match download_worker(&url).await {
            Ok(bytes) => {
                if bytes.len() as u64 > 5 * 1024 * 1024 {
                    return Err("Downloaded SQLite worker exceeds the 5 MiB budget".to_string());
                }
                tokio::fs::write(&cache_path, &bytes).await.map_err(|e| e.to_string())?;
                return Ok(LocalWorker { digest: sha256_hex(&bytes), bytes });
            }
            Err(error) => last_error = error,
        }
    }
    Err(format!(
        "Could not fetch the SQLite worker for this DBX version ({last_error}). Set {WORKER_PATH_ENV} or use a pre-placed worker path."
    ))
}

async fn download_worker(url: &str) -> Result<Vec<u8>, String> {
    let response = reqwest::get(url).await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("{url} returned {}", response.status()));
    }
    response.bytes().await.map(|bytes| bytes.to_vec()).map_err(|e| e.to_string())
}

async fn ensure_worker_consent(data_dir: &Path, identity: &str, dest: &str, digest: &str) -> Result<(), String> {
    if consent_remembered(data_dir, identity, digest) {
        return Ok(());
    }
    let hostport = identity.rsplit_once('@').map(|(_, value)| value).unwrap_or(identity);
    let (host, port) = hostport.rsplit_once(':').unwrap_or((hostport, "22"));
    let request = SshPromptRequest {
        id: uuid::Uuid::new_v4().to_string(),
        kind: SshPromptKind::WorkerUploadConsent,
        host: host.to_string(),
        port: port.parse().unwrap_or(22),
        key_type: Some("sha256".to_string()),
        fingerprint: Some(digest.to_string()),
        prompt: Some(dest.to_string()),
        echo: false,
    };
    let Some(rx) = ssh_prompt::request_ssh_prompt(request) else {
        return Err("Uploading a SQLite worker requires explicit consent in the Desktop UI".to_string());
    };
    match tokio::time::timeout(Duration::from_secs(300), rx).await {
        Ok(Ok(SshPromptAnswer::Accept { remember })) => {
            if remember {
                remember_consent(data_dir, identity, digest);
            }
            Ok(())
        }
        Ok(Ok(SshPromptAnswer::Reject)) => Err("SQLite worker upload was declined".to_string()),
        Ok(Ok(_)) => Err("SQLite worker upload received an invalid response".to_string()),
        Ok(Err(_)) => Err("SQLite worker upload prompt was dismissed".to_string()),
        Err(_) => Err("SQLite worker upload prompt timed out".to_string()),
    }
}

fn consent_file(data_dir: &Path) -> PathBuf {
    data_dir.join(CONSENT_FILE_NAME)
}

fn consent_remembered(data_dir: &Path, identity: &str, digest: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(consent_file(data_dir)) else {
        return false;
    };
    let Ok(entries) = serde_json::from_str::<HashSet<String>>(&text) else {
        return false;
    };
    entries.contains(&format!("{identity}|{digest}"))
}

fn remember_consent(data_dir: &Path, identity: &str, digest: &str) {
    let path = consent_file(data_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut entries = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<HashSet<String>>(&text).ok())
        .unwrap_or_default();
    entries.insert(format!("{identity}|{digest}"));
    let _ = std::fs::write(path, serde_json::to_vec_pretty(&entries).unwrap_or_default());
}

async fn open_final_hop_session(
    tunnels: &TunnelManager,
    connection_id: &str,
    hops: &[SshTunnelConfig],
) -> Result<Handle<SshClient>, String> {
    let last = hops.last().ok_or("SSH hop list is empty")?;
    if hops.len() == 1 {
        return ssh_tunnel::connect_and_authenticate(
            &last.host,
            last.port,
            &last.host,
            last.port,
            &last.user,
            &last.password,
            &last.key_path,
            &last.key_passphrase,
            last.use_ssh_agent,
            &last.ssh_agent_sock_path,
            &last.auth_method,
            ssh_tunnel::effective_hop_timeout(last),
            tunnels.known_hosts_path(),
        )
        .await;
    }
    let local_port = tunnels
        .start_chain(&format!("{connection_id}:sqlite-worker"), &hops[..hops.len() - 1], &last.host, last.port)
        .await?;
    ssh_tunnel::connect_and_authenticate(
        "127.0.0.1",
        local_port,
        &last.host,
        last.port,
        &last.user,
        &last.password,
        &last.key_path,
        &last.key_passphrase,
        last.use_ssh_agent,
        &last.ssh_agent_sock_path,
        &last.auth_method,
        ssh_tunnel::effective_hop_timeout(last),
        tunnels.known_hosts_path(),
    )
    .await
}

async fn remote_linux_arch(session: &Handle<SshClient>) -> Result<String, String> {
    let machine = ssh_capture(session, "uname -m").await?;
    match machine.trim() {
        "x86_64" | "amd64" => Ok("amd64".to_string()),
        "aarch64" | "arm64" => Ok("arm64".to_string()),
        other => Err(format!("Remote SQLite over SSH supports Linux amd64/arm64 only, found {other}")),
    }
}

async fn ssh_capture(session: &Handle<SshClient>, command: &str) -> Result<String, String> {
    let channel = session.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.exec(true, command).await.map_err(|e| e.to_string())?;
    let mut stream = channel.into_stream();
    let mut out = String::new();
    stream.read_to_string(&mut out).await.map_err(|e| e.to_string())?;
    Ok(out)
}

async fn upload_worker(session: &Handle<SshClient>, dest: &str, bytes: &[u8]) -> Result<(), String> {
    let quoted = shell_quote(dest);
    let command =
        format!("mkdir -p \"$(dirname {quoted})\" && cat > {quoted}.part && chmod 700 {quoted}.part && mv {quoted}.part {quoted}");
    let channel = session.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.exec(true, command).await.map_err(|e| e.to_string())?;
    let mut stream = channel.into_stream();
    stream.write_all(bytes).await.map_err(|e| e.to_string())?;
    stream.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn verify_remote_digest(session: &Handle<SshClient>, path: &str, digest: &str) -> Result<(), String> {
    let command = format!("sha256sum {} | awk '{{print $1}}'", shell_quote(path));
    let remote = ssh_capture(session, &command).await?;
    let remote = remote.trim();
    if remote != digest {
        return Err(format!("Remote SQLite worker digest {remote} does not match {digest}"));
    }
    Ok(())
}

fn ssh_hops(config: &ConnectionConfig) -> Result<Vec<SshTunnelConfig>, String> {
    let hops = config
        .effective_transport_layers()
        .into_iter()
        .map(|layer| match layer {
            TransportLayerConfig::Ssh(ssh) => Ok(ssh),
            _ => Err("Remote SQLite over SSH does not support proxy or HTTP tunnel layers".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if hops.is_empty() {
        return Err("Remote SQLite requires at least one SSH hop".to_string());
    }
    Ok(hops)
}

fn hop_identity(hop: &SshTunnelConfig) -> String {
    format!("{}@{}:{}", hop.user, hop.host, hop.port)
}

fn sqlite_has_extensions(params: Option<&str>) -> bool {
    crate::db::sqlite::sqlite_extension_specs_from_url_params(params).into_iter().any(|spec| !spec.path.is_empty())
}

fn validate_remote_path(path: &str) -> Result<(), String> {
    if path.contains('\0') || path.contains('\n') || path.contains('\r') {
        return Err("Remote path contains invalid characters".to_string());
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_placement_is_session() {
        let mut config = empty_config();
        assert_eq!(sqlite_worker_placement(&config), SqliteWorkerPlacement::Session);
        config.url_params = Some("dbx_sqlite_worker=persist".into());
        assert_eq!(sqlite_worker_placement(&config), SqliteWorkerPlacement::Persist);
        config.url_params = Some("dbx_sqlite_worker=preplaced&dbx_sqlite_worker_path=%2Fopt%2Fworker".into());
        assert_eq!(sqlite_worker_placement(&config), SqliteWorkerPlacement::Preplaced);
        assert_eq!(sqlite_worker_remote_path(&config), "/opt/worker");
    }

    #[test]
    fn remote_sqlite_requires_ssh() {
        let config = empty_config();
        assert!(!sqlite_ssh_worker_requested(&config));
    }

    fn empty_config() -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "n",
            "db_type": "sqlite",
            "host": "/tmp/a.db",
            "port": 0,
            "username": "",
            "password": ""
        }))
        .unwrap()
    }
}
