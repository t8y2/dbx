use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::net::TcpListener;
use url::Url;
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
const START_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeHandle {
    pub base_url: Url,
    pub version: String,
    pub instance_id: String,
}

pub fn default_data_dir() -> Result<PathBuf> {
    dirs::data_local_dir()
        .map(|dir| dir.join("com.dbx.codex"))
        .ok_or_else(|| "Cannot determine the user's local data directory".into())
}

fn private_dir(path: &Path) -> Result<()> {
    // Refuse symlink components before opening credentials or persistent storage.
    for ancestor in path.ancestors() {
        if let Ok(meta) = std::fs::symlink_metadata(ancestor) {
            if meta.file_type().is_symlink() {
                return Err("Codex data directory must not traverse symlinks".into());
            }
        }
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|e| format!("Cannot create Codex data directory: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err("Codex data directory must belong to the current user".into());
        }
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn private_file(path: &Path, create: bool) -> Result<File> {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("Codex runtime files must be regular files, not symlinks".into());
        }
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|e| format!("Cannot open private Codex runtime file: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if meta.uid() != unsafe { libc::geteuid() } || meta.nlink() != 1 || meta.permissions().mode() & 0o077 != 0 {
            return Err("Codex runtime files must belong to the current user and have mode 0600".into());
        }
    }
    Ok(file)
}

pub fn read_token(data_dir: &Path) -> Result<String> {
    let mut token = String::new();
    private_file(&data_dir.join("mcp-token"), false)?
        .take(1024)
        .read_to_string(&mut token)
        .map_err(|e| e.to_string())?;
    if token.len() < 32 || token.len() > 512 || token.bytes().any(|c| c.is_ascii_whitespace() || c.is_ascii_control()) {
        return Err("Invalid private Codex runtime credential".into());
    }
    Ok(token)
}

/// Held by dbx-web for its entire lifetime; dropping it releases the OS lock.
pub struct ServiceLease {
    _lock: File,
    data_dir: PathBuf,
    handle: RuntimeHandle,
    pub listener: Option<TcpListener>,
}

impl ServiceLease {
    pub async fn acquire(data_dir: &Path) -> Result<Self> {
        private_dir(data_dir)?;
        let lock = private_file(&data_dir.join("runtime.lock"), true)?;
        lock.try_lock_exclusive().map_err(|_| "A Codex workbench already owns this data directory".to_string())?;
        let token_path = data_dir.join("mcp-token");
        if !token_path.try_exists().map_err(|e| e.to_string())? {
            let mut file = private_file(&token_path, true)?;
            file.write_all(format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()).as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }
        read_token(data_dir)?;
        let listener =
            TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("Cannot bind Codex loopback listener: {e}"))?;
        let handle = RuntimeHandle {
            base_url: format!("http://{}/", listener.local_addr().map_err(|e| e.to_string())?)
                .parse()
                .map_err(|e: url::ParseError| e.to_string())?,
            version: env!("CARGO_PKG_VERSION").into(),
            instance_id: Uuid::new_v4().to_string(),
        };
        Ok(Self { _lock: lock, data_dir: data_dir.to_path_buf(), handle, listener: Some(listener) })
    }

    pub fn handle(&self) -> RuntimeHandle {
        self.handle.clone()
    }
    pub fn token(&self) -> Result<String> {
        read_token(&self.data_dir)
    }
    pub fn take_listener(&mut self) -> Result<TcpListener> {
        self.listener.take().ok_or_else(|| "Codex listener already taken".into())
    }
    pub fn publish(&self) -> Result<()> {
        let path = self.data_dir.join(format!("runtime-{}.tmp", self.handle.instance_id));
        let mut file = private_file(&path, true)?;
        file.write_all(&serde_json::to_vec(&self.handle).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&path, self.data_dir.join("runtime.json")).map_err(|e| e.to_string())
    }
}

impl Drop for ServiceLease {
    fn drop(&mut self) {
        // Remove only our registration while still owning the runtime lock.
        if let Ok(handle) = read_registry(&self.data_dir) {
            if handle.instance_id == self.handle.instance_id {
                let _ = std::fs::remove_file(self.data_dir.join("runtime.json"));
            }
        }
    }
}

fn read_registry(data_dir: &Path) -> Result<RuntimeHandle> {
    let mut bytes = Vec::new();
    private_file(&data_dir.join("runtime.json"), false)?
        .take(8192)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let handle: RuntimeHandle =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid Codex runtime registration".to_string())?;
    let url = &handle.base_url;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || Uuid::parse_str(&handle.instance_id).is_err()
    {
        return Err("Invalid Codex runtime endpoint; expected a private loopback instance".into());
    }
    Ok(handle)
}

async fn authenticated_status(data_dir: &Path) -> Result<RuntimeHandle> {
    let expected = read_registry(data_dir)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(expected.base_url.join("_codex/status").map_err(|e| e.to_string())?)
        .bearer_auth(read_token(data_dir)?)
        .send()
        .await
        .map_err(|_| "Could not reach authenticated Codex workbench".to_string())?;
    if !response.status().is_success() {
        return Err("Could not verify authenticated Codex workbench".into());
    }
    let actual: RuntimeHandle =
        response.json().await.map_err(|_| "Invalid authenticated Codex status response".to_string())?;
    if actual != expected {
        return Err("Authenticated Codex workbench identity does not match its registration".into());
    }
    if actual.version != env!("CARGO_PKG_VERSION") {
        return Err(
            "Codex workbench version differs from the plugin; stop the existing workbench before upgrading".into()
        );
    }
    Ok(actual)
}

fn runtime_running(data_dir: &Path) -> Result<bool> {
    let lock = private_file(&data_dir.join("runtime.lock"), true)?;
    match lock.try_lock_exclusive() {
        Ok(()) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(true),
        Err(error) => Err(format!("Cannot check Codex runtime lock: {error}")),
    }
}

pub async fn ensure_runtime(data_dir: &Path, web_binary: &Path) -> Result<RuntimeHandle> {
    private_dir(data_dir)?;
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    let startup_lock = private_file(&data_dir.join("startup.lock"), true)?;
    loop {
        match startup_lock.try_lock_exclusive() {
            Ok(()) => break,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if tokio::time::Instant::now() >= deadline {
                    return Err("Timed out waiting for Codex workbench startup lock".into());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(error) => return Err(format!("Cannot lock Codex startup: {error}")),
        }
    }
    if runtime_running(data_dir)? {
        return authenticated_status(data_dir).await;
    }
    if !web_binary.is_file() {
        return Err("Plugin dbx-web binary is missing; reinstall the complete plugin package".into());
    }
    let mut command = tokio::process::Command::new(web_binary);
    // Inherited DBX overrides must not redirect storage, disable auth or load external UI.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("DBX_") {
            command.env_remove(key);
        }
    }
    command
        .arg("--codex")
        .env("DBX_DATA_DIR", data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(private_file(&data_dir.join("workbench.log"), true)?));
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000 | 0x00000008);
    }
    let mut child = command.spawn().map_err(|e| format!("Cannot start plugin dbx-web: {e}"))?;
    let mut status_error = "Codex workbench has not registered yet".to_string();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!("Plugin dbx-web exited during startup ({status}); inspect the private workbench.log"));
        }
        if runtime_running(data_dir)? {
            match authenticated_status(data_dir).await {
                Ok(handle) => {
                    tokio::spawn(async move {
                        let _ = child.wait().await;
                    });
                    return Ok(handle);
                }
                Err(error) => status_error = error,
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("Codex workbench startup timed out after 30 seconds: {status_error}"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
