use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dbx_sqlite_worker::{WorkerBody, WorkerOp, WorkerRequest, WorkerResponse};
use russh::client::Handle;
use russh::ChannelMsg;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex as AsyncMutex;

use crate::agent_manager::{AgentManager, SQLITE_WORKER_DRIVER_KEY};
use crate::db::ssh_prompt::{self, SshPromptAnswer, SshPromptKind, SshPromptRequest};
use crate::db::ssh_tunnel::{self, SshClient, TunnelManager};
use crate::models::connection::{ConnectionConfig, DatabaseType, SshTunnelConfig, TransportLayerConfig};
use crate::types::QueryResult;

const WORKER_PATH_ENV: &str = "DBX_SQLITE_WORKER_PATH";
const DEFAULT_PERSIST_DIR: &str = "~/.cache/dbx/sqlite-worker";
const CONSENT_FILE_NAME: &str = "sqlite-worker-consent.json";
const SQLITE_WORKER_MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
static SQLITE_SSH_RUNTIME_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn sqlite_worker_chain_id(connection_id: &str) -> String {
    format!("{connection_id}:sqlite-worker")
}

pub fn enable_sqlite_ssh_runtime(_app_version: impl Into<String>) {
    SQLITE_SSH_RUNTIME_ENABLED.store(true, Ordering::SeqCst);
}

pub fn sqlite_ssh_runtime_enabled() -> bool {
    SQLITE_SSH_RUNTIME_ENABLED.load(Ordering::SeqCst)
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

fn sqlite_worker_placement(config: &ConnectionConfig) -> SqliteWorkerPlacement {
    match url_param(config.url_params.as_deref(), "dbx_sqlite_worker").as_deref() {
        Some("persist") => SqliteWorkerPlacement::Persist,
        Some("preplaced") => SqliteWorkerPlacement::Preplaced,
        _ => SqliteWorkerPlacement::Session,
    }
}

fn removes_remote_worker_on_disconnect(placement: SqliteWorkerPlacement) -> bool {
    matches!(placement, SqliteWorkerPlacement::Session)
}

fn session_worker_path(connection_id: &str, digest: &str) -> String {
    format!("{DEFAULT_PERSIST_DIR}/session-{connection_id}-{digest}")
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
    ssh_session: Option<Arc<Handle<SshClient>>>,
    /// Session placement only: delete this uploaded file after the worker exits.
    remove_remote_path: Option<String>,
}

enum WorkerIo {
    #[allow(dead_code)]
    Process {
        child: Box<Child>,
        stdin: Box<ChildStdin>,
        stdout: Box<BufReader<tokio::process::ChildStdout>>,
    },
    Ssh {
        stream: BufReader<DynStream>,
    },
    Closed,
}

impl SqliteWorkerClient {
    pub async fn query(&self, sql: &str, max_rows: Option<usize>) -> Result<QueryResult, String> {
        match self.roundtrip(WorkerOp::Query { sql: sql.to_string(), max_rows }).await? {
            WorkerBody::Ok { columns, column_types, rows, affected_rows, truncated, .. } => Ok(QueryResult {
                columns: columns.unwrap_or_default(),
                column_types: column_types.unwrap_or_default(),
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

    pub async fn backup_to_local_path(&self, dest: &Path) -> Result<(), String> {
        let session = self.ssh_session().await?;
        let remote = remote_xfer_path(session.as_ref()).await?;
        let transfer = async {
            self.backup(&remote).await?;
            ssh_download_file(session.as_ref(), &remote, dest).await
        }
        .await;
        if transfer.is_ok() {
            let _ = ssh_remove_file(session.as_ref(), &remote).await;
        }
        transfer
    }

    pub async fn restore_from_local_path(&self, src: &Path) -> Result<(), String> {
        let session = self.ssh_session().await?;
        let remote = remote_xfer_path(session.as_ref()).await?;
        let transfer = async {
            ssh_upload_file(session.as_ref(), src, &remote).await?;
            self.restore(&remote).await
        }
        .await;
        let _ = ssh_remove_file(session.as_ref(), &remote).await;
        transfer
    }

    async fn ssh_session(&self) -> Result<Arc<Handle<SshClient>>, String> {
        self.ssh_session.clone().ok_or_else(|| "SQLite worker file transfer requires an SSH session".to_string())
    }

    pub async fn shutdown(&self) {
        self.close_io().await;
        self.remove_uploaded_session_worker_best_effort().await;
    }

    async fn close_io(&self) {
        let previous = {
            let mut io = self.io.lock().await;
            std::mem::replace(&mut *io, WorkerIo::Closed)
        };
        match previous {
            WorkerIo::Ssh { mut stream } => {
                let _ = stream.get_mut().shutdown().await;
            }
            WorkerIo::Process { mut child, .. } => {
                let _ = child.start_kill();
            }
            WorkerIo::Closed => {}
        }
    }

    async fn remove_uploaded_session_worker_best_effort(&self) {
        let Some(path) = self.remove_remote_path.as_deref() else {
            return;
        };
        let Some(session) = self.ssh_session.as_ref() else {
            return;
        };
        remove_uploaded_session_worker(session.as_ref(), path).await;
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
            WorkerIo::Closed => Err("SQLite worker session is closed".to_string()),
            WorkerIo::Ssh { stream, .. } => {
                stream.write_all(&encoded).await.map_err(|e| e.to_string())?;
                stream.flush().await.map_err(|e| e.to_string())?;
                parse_response(id, &read_jsonl_line(stream).await?)
            }
        }
    }
}

impl Drop for SqliteWorkerClient {
    fn drop(&mut self) {
        if let Ok(mut io) = self.io.try_lock() {
            match std::mem::replace(&mut *io, WorkerIo::Closed) {
                WorkerIo::Process { mut child, .. } => {
                    let _ = child.start_kill();
                }
                WorkerIo::Ssh { stream } => drop(stream),
                WorkerIo::Closed => {}
            }
        }
        let Some(path) = self.remove_remote_path.take() else {
            return;
        };
        let Some(session) = self.ssh_session.take() else {
            return;
        };
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                remove_uploaded_session_worker(session.as_ref(), &path).await;
            });
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

async fn read_jsonl_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<String, String> {
    let mut line = Vec::new();
    loop {
        let buf = reader.fill_buf().await.map_err(|e| format!("SQLite worker closed the SSH session: {e}"))?;
        if buf.is_empty() {
            return Err("SQLite worker closed the SSH session".to_string());
        }
        if let Some(newline) = buf.iter().position(|&byte| byte == b'\n') {
            if line.len() + newline > SQLITE_WORKER_MAX_RESPONSE_BYTES {
                return Err("SQLite worker response exceeded 16 MiB".to_string());
            }
            line.extend_from_slice(&buf[..=newline]);
            reader.consume(newline + 1);
            break;
        }
        if line.len() + buf.len() > SQLITE_WORKER_MAX_RESPONSE_BYTES {
            return Err("SQLite worker response exceeded 16 MiB".to_string());
        }
        let consumed = buf.len();
        line.extend_from_slice(buf);
        reader.consume(consumed);
    }
    Ok(String::from_utf8_lossy(&line).into_owned())
}

pub async fn connect_sqlite_worker(
    tunnels: &TunnelManager,
    agent_manager: &AgentManager,
    data_dir: &Path,
    connection_id: &str,
    config: &ConnectionConfig,
    transport_layers: &[TransportLayerConfig],
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

    let hops = ssh_hops(transport_layers)?;
    let chain_id = (hops.len() > 1).then(|| sqlite_worker_chain_id(connection_id));
    let db_path = config.host.trim();
    if db_path.is_empty() {
        return Err("Remote SQLite path is empty".to_string());
    }
    if !Path::new(db_path).is_absolute() && !db_path.starts_with("~/") {
        return Err("Remote SQLite path must be an absolute path on the final SSH hop".to_string());
    }
    validate_remote_path(db_path)?;

    let placement = sqlite_worker_placement(config);
    let remove_remote_on_close = removes_remote_worker_on_disconnect(placement);
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

    let platform = remote_linux_platform(&session).await?;
    if std::env::var_os(WORKER_PATH_ENV).is_none() && !agent_manager.driver_native_installed(SQLITE_WORKER_DRIVER_KEY) {
        crate::agent_service::ensure_sqlite_worker_driver_ready(agent_manager).await?;
    }
    let local_worker = resolve_local_worker(agent_manager, &platform).await?;
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
        SqliteWorkerPlacement::Session => expand_home(&session_worker_path(connection_id, &digest)),
    };

    let expanded_db = expand_home(db_path);
    let session = Arc::new(session);
    let start_worker = async {
        ensure_remote_sqlite_file_exists(session.as_ref(), &expanded_db).await?;
        if placement != SqliteWorkerPlacement::Preplaced {
            ensure_worker_consent(data_dir, &identity, &remote_path, &digest).await?;
            upload_worker(session.as_ref(), &remote_path, &local_worker.bytes).await?;
        }
        verify_remote_digest(session.as_ref(), &remote_path, &digest).await?;
        let channel = session.channel_open_session().await.map_err(|e| format!("SSH session channel failed: {e}"))?;
        channel
            .exec(true, format!("exec {}", shell_quote(&remote_path)))
            .await
            .map_err(|e| format!("failed to start SQLite worker: {e}"))?;
        let stream: DynStream = Box::pin(channel.into_stream());
        let client = SqliteWorkerClient {
            io: AsyncMutex::new(WorkerIo::Ssh { stream: BufReader::new(stream) }),
            next_id: AtomicU64::new(1),
            ssh_session: Some(Arc::clone(&session)),
            remove_remote_path: remove_remote_on_close.then(|| remote_path.clone()),
        };
        client.open_database(&expanded_db).await?;
        Ok(client)
    };
    match start_worker.await {
        Ok(client) => Ok(Arc::new(client)),
        Err(error) => {
            if remove_remote_on_close {
                remove_uploaded_session_worker(session.as_ref(), &remote_path).await;
            }
            if let Some(chain_id) = chain_id.as_deref() {
                tunnels.stop_tunnel(chain_id).await;
            }
            Err(error)
        }
    }
}

struct LocalWorker {
    bytes: Vec<u8>,
    digest: String,
}

async fn resolve_local_worker(agent_manager: &AgentManager, platform: &str) -> Result<LocalWorker, String> {
    if let Ok(path) = std::env::var(WORKER_PATH_ENV) {
        let bytes = tokio::fs::read(&path).await.map_err(|e| format!("failed to read {WORKER_PATH_ENV}: {e}"))?;
        return Ok(LocalWorker { digest: sha256_hex(&bytes), bytes });
    }
    let path = agent_manager.driver_native_platform_path(SQLITE_WORKER_DRIVER_KEY, platform);
    if path.is_file() {
        let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
        return Ok(LocalWorker { digest: sha256_hex(&bytes), bytes });
    }
    Err(format!(
        "{SQLITE_WORKER_DRIVER_KEY} driver is not installed. Please install it from the Driver Manager or set {WORKER_PATH_ENV}."
    ))
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
    let chain_id = sqlite_worker_chain_id(connection_id);
    let local_port = tunnels.start_chain(&chain_id, &hops[..hops.len() - 1], &last.host, last.port).await?;
    match ssh_tunnel::connect_and_authenticate(
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
    {
        Ok(session) => Ok(session),
        Err(error) => {
            tunnels.stop_tunnel(&chain_id).await;
            Err(error)
        }
    }
}

async fn remote_linux_platform(session: &Handle<SshClient>) -> Result<String, String> {
    linux_platform_from_uname(ssh_capture(session, "uname -m").await?.trim())
}

async fn ensure_remote_sqlite_file_exists(session: &Handle<SshClient>, path: &str) -> Result<(), String> {
    let output = ssh_capture(session, &remote_sqlite_exists_command(path)).await?;
    remote_sqlite_exists_from_output(path, &output)
}

fn remote_sqlite_exists_command(path: &str) -> String {
    format!("test -f {} && echo ok", shell_quote(path))
}

fn remote_sqlite_exists_from_output(path: &str, output: &str) -> Result<(), String> {
    if output.trim() == "ok" {
        Ok(())
    } else {
        Err(format!("File does not exist: {path}"))
    }
}

fn linux_platform_from_uname(machine: &str) -> Result<String, String> {
    match machine {
        "x86_64" | "amd64" => Ok("linux-x64".to_string()),
        "aarch64" | "arm64" => Ok("linux-aarch64".to_string()),
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

async fn remote_xfer_path(session: &Handle<SshClient>) -> Result<String, String> {
    let home = ssh_capture(session, "printf %s \"$HOME\"").await?;
    let home = home.trim().trim_end_matches('/');
    if home.is_empty() {
        return Err("Remote HOME is empty".to_string());
    }
    let parent = format!("{}/.cache/dbx/sqlite-worker", home);
    ssh_capture(session, &format!("mkdir -p {}", shell_quote(&parent))).await?;
    Ok(format!("{parent}/xfer-{}", uuid::Uuid::new_v4()))
}

async fn ssh_download_file(session: &Handle<SshClient>, remote: &str, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
    }
    let mut channel = session.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.exec(true, format!("cat {}", shell_quote(remote))).await.map_err(|e| e.to_string())?;
    let mut file =
        tokio::fs::File::create(dest).await.map_err(|e| format!("failed to create local backup file: {e}"))?;
    let copied = {
        let mut stream = channel.make_reader();
        tokio::io::copy(&mut stream, &mut file).await.map_err(|e| format!("failed to download SQLite backup: {e}"))?
    };
    file.flush().await.map_err(|e| e.to_string())?;
    let mut exit_status = None;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::ExitStatus { exit_status: status }) => exit_status = Some(status),
            Some(ChannelMsg::Close) | None => break,
            Some(ChannelMsg::Eof | ChannelMsg::Data { .. } | ChannelMsg::ExtendedData { .. }) => {}
            Some(_) => {}
        }
    }
    validate_remote_download(copied, exit_status)
}

async fn ssh_upload_file(session: &Handle<SshClient>, src: &Path, remote: &str) -> Result<(), String> {
    let quoted = shell_quote(remote);
    let command = format!("mkdir -p \"$(dirname {quoted})\" && cat > {quoted}.part && mv {quoted}.part {quoted}");
    let mut file = tokio::fs::File::open(src).await.map_err(|e| format!("failed to read local restore file: {e}"))?;
    ssh_exec_with_stdin(session, command, &mut file).await
}

async fn ssh_remove_file(session: &Handle<SshClient>, path: &str) -> Result<(), String> {
    ssh_capture(session, &format!("rm -f {}", shell_quote(path))).await?;
    Ok(())
}

fn empty_cache_dirs_to_remove(worker_path: &str) -> Vec<String> {
    let path = Path::new(worker_path.trim_end_matches('/'));
    let Some(sqlite_worker_dir) = path.parent() else {
        return Vec::new();
    };
    if sqlite_worker_dir.file_name().is_none_or(|name| name != "sqlite-worker") {
        return Vec::new();
    }
    let mut dirs = vec![sqlite_worker_dir.to_string_lossy().into_owned()];
    if let Some(dbx_dir) = sqlite_worker_dir.parent() {
        if dbx_dir.file_name().is_some_and(|name| name == "dbx") {
            dirs.push(dbx_dir.to_string_lossy().into_owned());
        }
    }
    dirs
}

fn remove_session_worker_command(path: &str) -> String {
    let mut command = format!("rm -f {}", shell_quote(path));
    for dir in empty_cache_dirs_to_remove(path) {
        command.push_str("; rmdir ");
        command.push_str(&shell_quote(&dir));
        command.push_str(" 2>/dev/null");
    }
    command
}

async fn remove_uploaded_session_worker(session: &Handle<SshClient>, path: &str) {
    if let Err(err) = ssh_capture(session, &remove_session_worker_command(path)).await {
        log::warn!("Failed to remove session SQLite worker at {path}: {err}");
    }
}

async fn upload_worker(session: &Handle<SshClient>, dest: &str, bytes: &[u8]) -> Result<(), String> {
    let quoted = shell_quote(dest);
    let command =
        format!("mkdir -p \"$(dirname {quoted})\" && cat > {quoted}.part && chmod 700 {quoted}.part && mv {quoted}.part {quoted}");
    ssh_exec_with_stdin(session, command, bytes).await
}

async fn ssh_exec_with_stdin<R: tokio::io::AsyncRead + Unpin>(
    session: &Handle<SshClient>,
    command: String,
    stdin: R,
) -> Result<(), String> {
    let mut channel = session.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.exec(true, command).await.map_err(|e| e.to_string())?;
    channel.data(stdin).await.map_err(|e| e.to_string())?;
    channel.eof().await.map_err(|e| e.to_string())?;
    let mut exit_status = None;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::ExitStatus { exit_status: status }) => exit_status = Some(status),
            Some(ChannelMsg::Close) | None => break,
            Some(ChannelMsg::Eof | ChannelMsg::Data { .. } | ChannelMsg::ExtendedData { .. }) => {}
            Some(_) => {}
        }
    }
    remote_exec_status(exit_status)
}

fn remote_exec_status(exit_status: Option<u32>) -> Result<(), String> {
    match exit_status {
        Some(0) => Ok(()),
        Some(code) => Err(format!("remote command exited with status {code}")),
        None => Err("remote command closed without an exit status".to_string()),
    }
}

fn validate_remote_download(copied: u64, exit_status: Option<u32>) -> Result<(), String> {
    // Check exit status first: a failed `cat` with empty output is better
    // explained by the nonzero status than by the emptiness it caused.
    remote_exec_status(exit_status)?;
    if copied == 0 {
        return Err("Downloaded SQLite backup was empty".to_string());
    }
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

fn ssh_hops(layers: &[TransportLayerConfig]) -> Result<Vec<SshTunnelConfig>, String> {
    let hops = layers
        .iter()
        .map(|layer| match layer {
            TransportLayerConfig::Ssh(ssh) => {
                let ssh = crate::ssh_config::resolve_ssh_tunnel_config(ssh);
                if ssh.host.trim().is_empty() {
                    return Err("SSH host is required.".to_string());
                }
                Ok(ssh)
            }
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
    fn session_placement_removes_worker_on_disconnect() {
        assert!(removes_remote_worker_on_disconnect(SqliteWorkerPlacement::Session));
        assert!(!removes_remote_worker_on_disconnect(SqliteWorkerPlacement::Persist));
        assert!(!removes_remote_worker_on_disconnect(SqliteWorkerPlacement::Preplaced));
        assert_eq!(session_worker_path("conn-1", "abc123"), "~/.cache/dbx/sqlite-worker/session-conn-1-abc123");
        assert_eq!(
            empty_cache_dirs_to_remove("/home/u/.cache/dbx/sqlite-worker/session-conn-1-abc123"),
            vec!["/home/u/.cache/dbx/sqlite-worker".to_string(), "/home/u/.cache/dbx".to_string()]
        );
        assert!(empty_cache_dirs_to_remove("/opt/dbx/dbx-sqlite-worker").is_empty());
        assert!(remove_session_worker_command("/home/u/.cache/dbx/sqlite-worker/session-conn-1-abc123")
            .contains("rmdir '/home/u/.cache/dbx/sqlite-worker' 2>/dev/null; rmdir '/home/u/.cache/dbx' 2>/dev/null"));
    }

    #[test]
    fn maps_remote_uname_to_agent_linux_platforms() {
        assert_eq!(linux_platform_from_uname("x86_64").unwrap(), "linux-x64");
        assert_eq!(linux_platform_from_uname("amd64").unwrap(), "linux-x64");
        assert_eq!(linux_platform_from_uname("aarch64").unwrap(), "linux-aarch64");
        assert_eq!(linux_platform_from_uname("arm64").unwrap(), "linux-aarch64");
        assert!(linux_platform_from_uname("ppc64le").unwrap_err().contains("ppc64le"));
    }

    #[test]
    fn sqlite_worker_chain_id_is_distinct_from_connection_id() {
        assert_eq!(sqlite_worker_chain_id("conn-1"), "conn-1:sqlite-worker");
    }

    #[test]
    fn remote_download_requires_a_successful_non_empty_transfer() {
        assert!(validate_remote_download(1, Some(0)).is_ok());
        assert!(validate_remote_download(1, Some(1)).unwrap_err().contains("status 1"));
        assert!(validate_remote_download(1, None).unwrap_err().contains("without an exit status"));
        assert!(validate_remote_download(0, Some(0)).unwrap_err().contains("was empty"));
    }

    #[test]
    fn remote_sqlite_exists_requires_a_regular_file() {
        assert_eq!(remote_sqlite_exists_command("/remote/data/app.db"), "test -f '/remote/data/app.db' && echo ok");
        assert!(remote_sqlite_exists_from_output("/remote/data/app.db", "ok\n").is_ok());
        let error = remote_sqlite_exists_from_output("/remote/data/app.db", "").unwrap_err();
        assert!(error.contains("File does not exist"), "{error}");
    }

    #[tokio::test]
    async fn read_jsonl_line_stops_at_newline_and_enforces_size_cap() {
        let mut reader = BufReader::new(&b"{\"id\":1}\nleftover"[..]);
        let line = read_jsonl_line(&mut reader).await.unwrap();
        assert_eq!(line, "{\"id\":1}\n");

        let mut oversized = vec![b'a'; SQLITE_WORKER_MAX_RESPONSE_BYTES + 1];
        oversized.push(b'\n');
        let mut reader = BufReader::new(oversized.as_slice());
        let error = read_jsonl_line(&mut reader).await.unwrap_err();
        assert!(error.contains("16 MiB"), "{error}");
    }

    #[test]
    fn remote_sqlite_requires_ssh() {
        let config = empty_config();
        assert!(!sqlite_ssh_worker_requested(&config));
    }

    #[test]
    fn ssh_hops_uses_resolved_layers_instead_of_profile_stubs() {
        let hops = ssh_hops(&[ssh_layer("203.0.113.10", "testuser")]).unwrap();
        assert_eq!(hops.len(), 1);
        assert_eq!(hops[0].host, "203.0.113.10");
        assert_eq!(hops[0].user, "testuser");
    }

    #[test]
    fn ssh_hops_rejects_unresolved_profile_stubs() {
        let error = ssh_hops(&[ssh_layer("", "")]).unwrap_err();
        assert!(error.contains("SSH host is required"), "{error}");
    }

    #[test]
    fn ssh_hops_rejects_non_ssh_layers() {
        let layer = serde_json::from_value(serde_json::json!({
            "type": "proxy",
            "id": "proxy-1",
            "enabled": true,
            "host": "203.0.113.10",
            "port": 1080
        }))
        .unwrap();
        let error = ssh_hops(&[layer]).unwrap_err();
        assert!(error.contains("proxy or HTTP"), "{error}");
    }

    fn ssh_layer(host: &str, user: &str) -> TransportLayerConfig {
        serde_json::from_value(serde_json::json!({
            "type": "ssh",
            "id": "hop-1",
            "enabled": true,
            "host": host,
            "port": 22,
            "user": user
        }))
        .unwrap()
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
