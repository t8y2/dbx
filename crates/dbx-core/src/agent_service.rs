use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::{stream, StreamExt};
use sha2::{Digest, Sha256};

use crate::agent_catalog;
use crate::agent_manager::{
    AgentDriverInfo, AgentInstallCancellation, AgentManager, AgentRegistry, ArtifactFormat, ArtifactInfo,
    InstalledDriver, JavaRuntimeMode, OperationLockHandle, DEFAULT_JRE_KEY, SQLITE_WORKER_DRIVER_KEY,
    SQLITE_WORKER_NATIVE_PLATFORMS,
};
use crate::DownloadSource;

/// Error returned when a user cancels an agent driver install/upgrade. The
/// frontend recognizes this substring to treat the outcome as "cancelled"
/// rather than a genuine failure.
pub const AGENT_DOWNLOAD_CANCELED_ERROR: &str = "Agent download canceled by user.";

/// Number of attempts to delete a JRE directory before giving up (Windows
/// experiences transient `ERROR_ACCESS_DENIED` when java.exe is still mapped
/// or anti-virus is scanning the archive). POSIX returns 1 — `unlink` of an
/// in-use file always succeeds.
const JRE_REMOVE_ATTEMPTS: usize = if cfg!(windows) { 6 } else { 1 };

/// Exponential-ish backoff between retries. Total wait ≈ 1.55s on Windows.
const JRE_REMOVE_BACKOFF_MS: &[u64] = &[50, 100, 200, 400, 400, 400];

/// Keep batch updates concurrent without allowing a large registry to exhaust
/// the download server, local disk, or the application's file descriptors.
const MAX_CONCURRENT_AGENT_UPDATES: usize = 4;

/// Delete an old JRE directory, retrying on Windows to cover the daemon-exit
/// and AV-scan release window. Returns the original `std::io::Error` when all
/// retries fail so callers can decide whether to fall back to rename-stash.
fn remove_jre_dir_with_retry(path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let mut last_err: Option<std::io::Error> = None;
    for i in 0..JRE_REMOVE_ATTEMPTS {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(err) => {
                log::warn!(
                    "remove_dir_all({}) attempt {}/{} failed: {err}",
                    path.display(),
                    i + 1,
                    JRE_REMOVE_ATTEMPTS
                );
                last_err = Some(err);
                if i + 1 < JRE_REMOVE_ATTEMPTS {
                    let delay_ms = JRE_REMOVE_BACKOFF_MS.get(i).copied().unwrap_or(400);
                    std::thread::sleep(Duration::from_millis(delay_ms));
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("remove_dir_all failed without an error")))
}

/// Render a friendly error message when the old JRE directory cannot be
/// replaced. On Windows, lists likely culprits (process holding java.exe,
/// AV scanning) and suggests restarting dbx; on POSIX returns a concise
/// message. The original OS error is appended in parentheses for support.
fn format_jre_dir_remove_error(path: &Path, os_err: &std::io::Error) -> String {
    if cfg!(windows) {
        format!(
            "Failed to remove the old JRE directory: {}\n\
             Possible causes:\n  \
             - a dbx Agent / java process still holds the directory\n  \
             - antivirus software is scanning it\n\
             Close any process that may hold the directory, or restart dbx and try again.\n\
             (original error: {os_err})",
            path.display()
        )
    } else {
        format!("Failed to remove the old JRE directory: {} (original error: {os_err})", path.display())
    }
}

/// Windows-only: rename the old JRE dir to a unique sibling so the install
/// can continue even when files inside are still mapped. Returns the stash
/// path so the caller can record it for later cleanup. On POSIX this is
/// unreachable (callers gate on `cfg(windows)` after a failed remove).
#[cfg(windows)]
fn stash_old_jre_dir(path: &Path) -> std::io::Result<PathBuf> {
    use std::time::SystemTime;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| std::io::Error::other("JRE directory has no file name"))?;
    let ts = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // uuid::Uuid::new_v4() is already a workspace dependency — use its short
    // form for a unique suffix without pulling in `rand`.
    let rand = uuid::Uuid::new_v4().simple().to_string();
    let stash = path.with_file_name(format!("{file_name}.old-{ts}-{rand}"));
    std::fs::rename(path, &stash)?;
    Ok(stash)
}

/// Replace an old JRE directory in-place: try retried `remove_dir_all` first;
/// on Windows fall back to rename-stash if removal fails. Returns the stash
/// path (Some) if the rename fallback was used so the caller can persist it
/// for startup cleanup, or None if the directory was deleted outright (or
/// did not exist).
fn replace_old_jre_dir(path: &Path) -> Result<Option<PathBuf>, String> {
    match remove_jre_dir_with_retry(path) {
        Ok(()) => Ok(None),
        Err(remove_err) => {
            #[cfg(windows)]
            {
                match stash_old_jre_dir(path) {
                    Ok(stash) => {
                        log::warn!("remove_dir_all failed, stashed old JRE at {} ({remove_err})", stash.display());
                        // The caller will persist this stash under
                        // state_lock after extraction succeeds.
                        Ok(Some(stash))
                    }
                    Err(rename_err) => {
                        log::warn!(
                            "remove_dir_all and rename both failed for {}: remove={remove_err}, rename={rename_err}",
                            path.display()
                        );
                        Err(format_jre_dir_remove_error(path, &remove_err))
                    }
                }
            }
            #[cfg(not(windows))]
            {
                Err(format_jre_dir_remove_error(path, &remove_err))
            }
        }
    }
}

const REGISTRY_PATH: &str = "https://github.com/t8y2/dbx/releases/download/agents-latest/agent-registry.json";
const REGISTRY_R2_PATH: &str = "agents/agent-registry.json";

static REGISTRY_CACHE: std::sync::LazyLock<
    tokio::sync::Mutex<std::collections::HashMap<DownloadSource, (std::time::Instant, AgentRegistry)>>,
> = std::sync::LazyLock::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct AgentProgressEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub step: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_drivers: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct AgentDriverUpdateIssue {
    pub db_type: String,
    pub error: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq, Default)]
pub struct UpgradeAllAgentDriversResult {
    pub upgraded: u32,
    /// Drivers whose install was aborted by a user cancel (either individually
    /// or via the batch-level cancel). These are reported separately from
    /// `failed` so the UI can show "cancelled" rather than "failed".
    pub cancelled: u32,
    pub failed: Vec<AgentDriverUpdateIssue>,
}

impl AgentProgressEvent {
    pub fn step(step: impl Into<String>) -> Self {
        Self {
            operation_id: None,
            step: step.into(),
            downloaded: None,
            total: None,
            db_type: None,
            current: None,
            total_drivers: None,
        }
    }

    pub fn transfer(step: impl Into<String>, downloaded: u64, total: u64) -> Self {
        Self { downloaded: Some(downloaded), total: Some(total), ..Self::step(step) }
    }

    pub fn with_batch(mut self, db_type: Option<&str>, current: Option<u32>, total_drivers: Option<u32>) -> Self {
        self.db_type = db_type.map(ToString::to_string);
        self.current = current;
        self.total_drivers = total_drivers;
        self
    }

    pub fn with_operation_id(mut self, operation_id: &str) -> Self {
        self.operation_id = Some(operation_id.to_string());
        self
    }
}

pub fn build_agent_list(am: &AgentManager, registry: Option<&AgentRegistry>) -> Vec<AgentDriverInfo> {
    let local_state = am.load_state();
    let use_managed_jre = local_state.java_runtime.mode == JavaRuntimeMode::Managed;
    agent_catalog::driver_store_entries()
        .map(|(key, label)| {
            let jar_valid = am.is_driver_jar_valid(key);
            let native_installed = am.driver_native_installed(key);
            let launch_config_installed = am.driver_launch_config_path(key).exists();
            let installed = jar_valid || native_installed || launch_config_installed;
            let local = local_state.installed_drivers.get(key);
            let remote = registry.and_then(|r| agent_registry_driver(r, key));
            let remote_requires_java_runtime = remote.is_some_and(remote_driver_requires_java_runtime);
            let requires_java_runtime = if installed {
                jar_valid && !native_installed && !launch_config_installed
            } else {
                remote_requires_java_runtime
            };
            let jre_key = remote
                .map(|r| r.jre.clone())
                .or_else(|| local.map(|l| l.jre.clone()))
                .unwrap_or_else(|| DEFAULT_JRE_KEY.to_string());
            let remote_jre_version = registry.and_then(|r| r.resolve_jre(&jre_key)).map(|j| &j.version);
            let local_jre_version = installed_jre_version(&local_state, &jre_key);
            let jre_update_available = installed
                && requires_java_runtime
                && use_managed_jre
                && (!am.is_jre_installed(&jre_key)
                    || remote_jre_version.is_some_and(|version| local_jre_version != Some(version)));
            AgentDriverInfo {
                db_type: key.to_string(),
                label: label.to_string(),
                version: remote.map(|r| r.version.clone()).unwrap_or_default(),
                size: remote.map(|driver| driver_download_size(key, driver)).unwrap_or(0),
                installed,
                installed_version: local.map(|l| l.version.clone()),
                update_available: match (local, remote) {
                    (Some(l), Some(r)) => l.version != r.version || jre_update_available,
                    _ => false,
                },
                requires_java_runtime,
                jre: jre_key.clone(),
                jre_installed: !requires_java_runtime || am.is_jre_installed(&jre_key),
            }
        })
        .collect()
}

fn usable_driver_jar(driver: &crate::agent_manager::DriverInfo) -> Option<&crate::agent_manager::ArtifactInfo> {
    driver.jar.as_ref().filter(|artifact| artifact.size > 0)
}

fn driver_download_artifact(driver: &crate::agent_manager::DriverInfo) -> Option<&crate::agent_manager::ArtifactInfo> {
    driver.native.get(AgentManager::current_platform()).or_else(|| usable_driver_jar(driver))
}

fn driver_download_size(db_type: &str, driver: &crate::agent_manager::DriverInfo) -> u64 {
    if AgentManager::is_sqlite_worker_driver(db_type) {
        return SQLITE_WORKER_NATIVE_PLATFORMS
            .iter()
            .filter_map(|platform| driver.native.get(*platform))
            .map(|artifact| artifact.size)
            .sum();
    }
    driver_download_artifact(driver).map(|artifact| artifact.size).unwrap_or(0)
}

fn remote_driver_requires_java_runtime(driver: &crate::agent_manager::DriverInfo) -> bool {
    usable_driver_jar(driver).is_some() && !driver.native.contains_key(AgentManager::current_platform())
}

fn installed_jre_version<'a>(state: &'a crate::agent_manager::AgentState, jre_key: &str) -> Option<&'a String> {
    state
        .jre_versions
        .get(jre_key)
        .or_else(|| (jre_key == DEFAULT_JRE_KEY).then_some(state.jre_version.as_ref()).flatten())
}

fn mark_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path).map_err(|err| err.to_string())?.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).map_err(|err| err.to_string())?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

pub fn jre_needs_install(am: &AgentManager, registry: &AgentRegistry, jre_key: &str) -> bool {
    let state = am.load_state();
    if state.java_runtime.mode != JavaRuntimeMode::Managed {
        return false;
    }
    if !am.is_jre_installed(jre_key) {
        return true;
    }
    registry.resolve_jre(jre_key).is_some_and(|jre| state.jre_versions.get(jre_key) != Some(&jre.version))
}

pub fn local_agent_jar_candidates(db_type: &str) -> Vec<PathBuf> {
    let jar_name = format!("dbx-agent-{db_type}.jar");
    let mut candidates = Vec::new();

    for agents_dir in local_agents_dir_candidates() {
        candidates.push(agent_driver_jar_path(&agents_dir, db_type, &jar_name));
        candidates.push(agent_legacy_jar_path(&agents_dir, db_type, &jar_name));
    }

    candidates
}

fn local_agents_dir_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("agents"), PathBuf::from("..").join("agents")];
    if let Some(workspace_root) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().and_then(|path| path.parent()) {
        candidates.push(workspace_root.join("agents"));
    }
    candidates.push(PathBuf::from("..").join("dbx-agents"));
    candidates.push(PathBuf::from("dbx-agents"));
    candidates
}

fn agent_driver_jar_path(agents_dir: &Path, db_type: &str, jar_name: &str) -> PathBuf {
    agents_dir.join("drivers").join(db_type).join("build").join("libs").join(jar_name)
}

fn agent_legacy_jar_path(agents_dir: &Path, db_type: &str, jar_name: &str) -> PathBuf {
    agents_dir.join(db_type).join("build").join("libs").join(jar_name)
}

pub fn find_local_agent_jar(db_type: &str) -> Option<PathBuf> {
    local_agent_jar_candidates(db_type).into_iter().find(|path| path.exists())
}

pub fn install_local_agent(am: &AgentManager, db_type: &str, source: PathBuf) -> Result<(), String> {
    install_local_agent_file(am, db_type, &source)?;
    am.mutate_state(|state| record_local_agent_install(state, db_type, DEFAULT_JRE_KEY))
}

fn install_local_agent_file(am: &AgentManager, db_type: &str, source: &Path) -> Result<(), String> {
    let jar_path = am.driver_jar_path(db_type);
    let parent = jar_path.parent().ok_or_else(|| format!("Invalid driver path: {}", jar_path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let staging_path = parent.join(format!(".agent-jar-import-{}", uuid::Uuid::new_v4()));
    std::fs::copy(source, &staging_path).map_err(|e| format!("Failed to copy local agent jar: {e}"))?;
    if !is_valid_agent_jar(&staging_path) {
        std::fs::remove_file(&staging_path).ok();
        return Err(format!("Local agent jar is invalid or corrupt: {}", source.display()));
    }
    replace_imported_agent_file(&staging_path, &jar_path)
}

fn record_local_agent_install(state: &mut crate::agent_manager::AgentState, db_type: &str, jre_key: &str) {
    state.installed_drivers.insert(
        db_type.to_string(),
        InstalledDriver {
            version: "0.1.0-local".to_string(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            jre: jre_key.to_string(),
        },
    );
}

fn is_valid_agent_jar(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return false;
    };
    let Ok(mut manifest) = archive.by_name("META-INF/MANIFEST.MF") else {
        return false;
    };
    let mut manifest_text = String::new();
    manifest.read_to_string(&mut manifest_text).is_ok() && manifest_text.contains("Main-Class:")
}

pub async fn fetch_registry() -> Result<AgentRegistry, String> {
    fetch_registry_from(DownloadSource::Official).await
}

pub async fn fetch_registry_from(source: DownloadSource) -> Result<AgentRegistry, String> {
    fetch_registry_from_claimed(source, &[]).await
}

/// Like `fetch_registry_from`, but the registry HTTP request AND the
/// response-body JSON parse are raced against the given cancellation tokens, so
/// a cancel fired during install/batch setup aborts promptly instead of waiting
/// for the 10s client timeout. Pass an empty slice to keep the non-cancellable
/// behavior.
pub async fn fetch_registry_from_claimed(
    source: DownloadSource,
    cancellations: &[&AgentInstallCancellation],
) -> Result<AgentRegistry, String> {
    let urls = source.download_candidate_urls(REGISTRY_PATH, REGISTRY_R2_PATH)?;
    fetch_registry_from_urls(source, &urls, cancellations).await
}

/// Core registry fetch over explicit candidate URLs (the URL seam lets tests
/// point at a localhost server). With a non-empty `cancellations` slice both the
/// HTTP request and the body parse are raced against cancellation.
async fn fetch_registry_from_urls(
    source: DownloadSource,
    urls: &[String],
    cancellations: &[&AgentInstallCancellation],
) -> Result<AgentRegistry, String> {
    // A pre-cancelled token must abort before any network attempt.
    if !cancellations.is_empty() && cancellations.iter().any(|token| token.is_cancelled()) {
        return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string());
    }
    {
        let cache = REGISTRY_CACHE.lock().await;
        if let Some((ts, registry)) = cache.get(&source) {
            if ts.elapsed() < std::time::Duration::from_secs(300) {
                return Ok(registry.clone());
            }
        }
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {err}"))?;
    let resp = open_download_response(&client, urls, "dbx-agent-manager", cancellations)
        .await
        .map_err(|err| format!("Failed to fetch agent registry: {err}"))?;
    // Race the body parse too: a stalled/partial body must not hold the
    // registry fetch hostage until the 10s client timeout.
    let registry: AgentRegistry = if cancellations.is_empty() {
        resp.json().await.map_err(|err| format!("Failed to parse registry: {err}"))?
    } else {
        tokio::select! {
            result = resp.json() => result.map_err(|err| format!("Failed to parse registry: {err}"))?,
            _ = first_cancellation(cancellations) => return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string()),
        }
    };
    REGISTRY_CACHE.lock().await.insert(source, (std::time::Instant::now(), registry.clone()));
    Ok(registry)
}

async fn open_download_response(
    client: &reqwest::Client,
    urls: &[String],
    user_agent: &str,
    cancellations: &[&AgentInstallCancellation],
) -> Result<reqwest::Response, String> {
    let mut errors = Vec::new();
    for url in urls {
        let request = client
            .get(url)
            .header(reqwest::header::USER_AGENT, user_agent)
            .header(reqwest::header::ACCEPT_ENCODING, "identity");
        // Race the request with cancellation: a stalled mirror that never
        // returns response headers must not hold the registry fetch hostage
        // until the 10s client timeout. Dropping the send future aborts it.
        let resp = if cancellations.is_empty() {
            match request.send().await {
                Ok(resp) => resp,
                Err(error) => {
                    errors.push(format!("{url}: {error}"));
                    continue;
                }
            }
        } else {
            tokio::select! {
                result = request.send() => match result {
                    Ok(resp) => resp,
                    Err(error) => {
                        errors.push(format!("{url}: {error}"));
                        continue;
                    }
                },
                _ = first_cancellation(cancellations) => return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string()),
            }
        };
        match resp.error_for_status() {
            Ok(resp) => return Ok(resp),
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    Err(errors.join("; "))
}

pub async fn invalidate_registry_cache() {
    REGISTRY_CACHE.lock().await.clear();
}

pub async fn install_agent_driver(
    am: &AgentManager,
    db_type: &str,
    progress: impl Fn(AgentProgressEvent),
) -> Result<(), String> {
    install_agent_driver_from(am, db_type, DownloadSource::Official, progress).await
}

/// Ensure both Linux worker binaries are available for remote SQLite over SSH.
///
/// Unlike a regular native Agent, this driver is selected by the remote SSH
/// host's architecture rather than by the desktop application's platform.
pub async fn ensure_sqlite_worker_driver_ready(am: &AgentManager) -> Result<(), String> {
    if am.driver_native_installed(SQLITE_WORKER_DRIVER_KEY) {
        return Ok(());
    }
    install_agent_driver(am, SQLITE_WORKER_DRIVER_KEY, |_| {}).await?;
    if am.driver_native_installed(SQLITE_WORKER_DRIVER_KEY) {
        Ok(())
    } else {
        Err("SQLite SSH worker installation completed without both Linux binaries".to_string())
    }
}

/// Like `install_agent_driver`, but using a command-scoped cancellation token
/// that was registered before any awaitable setup (blocker check, lock wait,
/// registry fetch) so a cancel fired during that window is observed.
pub async fn install_agent_driver_claimed(
    am: &AgentManager,
    db_type: &str,
    progress: impl Fn(AgentProgressEvent),
    cancellation: &Arc<AgentInstallCancellation>,
) -> Result<(), String> {
    install_agent_driver_from_claimed(am, db_type, DownloadSource::Official, progress, cancellation).await
}

pub async fn install_agent_driver_from(
    am: &AgentManager,
    db_type: &str,
    source: DownloadSource,
    progress: impl Fn(AgentProgressEvent),
) -> Result<(), String> {
    install_agent_driver_with_batch(am, db_type, source, &progress, None, None, None).await
}

/// Like `install_agent_driver_from`, but using a command-scoped cancellation
/// token registered before any awaitable setup. A cancel fired while waiting
/// on locks, blockers, or the registry fetch is observed instead of lost.
pub async fn install_agent_driver_from_claimed(
    am: &AgentManager,
    db_type: &str,
    source: DownloadSource,
    progress: impl Fn(AgentProgressEvent),
    cancellation: &Arc<AgentInstallCancellation>,
) -> Result<(), String> {
    install_agent_driver_with_batch(am, db_type, source, &progress, None, None, Some(cancellation)).await
}

/// Cancel an in-flight single driver install/update. `operation_id` targets the
/// exact install (a second same-db_type install registered under a different
/// operation id is unaffected). Also covers a driver inside a batch upgrade
/// when the batch's operation id is supplied. Missing keys are a no-op.
pub async fn cancel_agent_driver_install(
    am: &AgentManager,
    db_type: &str,
    operation_id: Option<&str>,
) -> Result<(), String> {
    if let Some(operation_id) = operation_id {
        am.cancel_install(&install_cancellation_key(operation_id)).await;
        am.cancel_install(&batch_driver_cancellation_key(operation_id, db_type)).await;
    }
    Ok(())
}

/// Cancel an in-flight batch upgrade, targeting the exact batch by its
/// operation id. Aborts every driver still downloading and stops scheduling
/// drivers that have not started yet.
pub async fn cancel_agent_batch_upgrade(am: &AgentManager, operation_id: Option<&str>) -> Result<(), String> {
    if let Some(operation_id) = operation_id {
        am.cancel_install(&batch_cancellation_key(operation_id)).await;
    }
    Ok(())
}

/// Cancellation-map key for a single install operation.
pub fn install_cancellation_key(operation_id: &str) -> String {
    format!("install:{operation_id}")
}

/// Cancellation-map key for a whole-batch upgrade operation.
pub fn batch_cancellation_key(operation_id: &str) -> String {
    format!("batch:{operation_id}")
}

/// Cancellation-map key for one driver inside a batch upgrade operation.
pub fn batch_driver_cancellation_key(operation_id: &str, db_type: &str) -> String {
    format!("batch:{operation_id}:{db_type}")
}

/// Ensure an already-selected fallback Agent can be launched, installing only
/// missing or invalid runtime artifacts. A usable installed driver is never
/// upgraded implicitly.
pub async fn ensure_agent_driver_ready(am: &AgentManager, db_type: &str) -> Result<(), String> {
    ensure_agent_driver_ready_from(am, db_type, DownloadSource::Official).await
}

async fn ensure_agent_driver_ready_from(
    am: &AgentManager,
    db_type: &str,
    source: DownloadSource,
) -> Result<(), String> {
    if agent_driver_runtime_readiness(am, db_type).is_ok() {
        return Ok(());
    }

    let _installation_guard = am.installation_operation_lock.read().await;
    let driver_lock = driver_operation_lock(am, db_type);
    let _driver_guard = driver_lock.lock().await;

    // Another fallback may have completed installation while this task waited.
    if agent_driver_runtime_readiness(am, db_type).is_ok() {
        return Ok(());
    }

    let registry = fetch_registry_from(source).await?;
    let progress = |_| {};
    if !am.is_driver_installed(db_type) {
        install_agent_driver_from_registry(am, &registry, source, db_type, &progress, None, None, &[]).await?;
    } else if am.driver_requires_java_runtime(db_type) {
        let state = am.load_state();
        let jre_key = state
            .installed_drivers
            .get(db_type)
            .map(|driver| driver.jre.as_str())
            .or_else(|| agent_registry_driver(&registry, db_type).map(|driver| driver.jre.as_str()))
            .unwrap_or(DEFAULT_JRE_KEY);
        ensure_jre_from_registry(am, &registry, source, jre_key, db_type, &progress, None, None, &[]).await?;
    }

    agent_driver_runtime_readiness(am, db_type)
}

fn agent_driver_runtime_readiness(am: &AgentManager, db_type: &str) -> Result<(), String> {
    let state = am.load_state();
    let jre_key = state.installed_drivers.get(db_type).map(|driver| driver.jre.as_str()).unwrap_or(DEFAULT_JRE_KEY);
    am.resolve_agent_launch_spec(&state, db_type, jre_key).map(|_| ())
}

pub async fn upgrade_all_agent_drivers(
    am: &AgentManager,
    progress: impl Fn(AgentProgressEvent),
) -> Result<UpgradeAllAgentDriversResult, String> {
    upgrade_all_agent_drivers_from(am, DownloadSource::Official, progress).await
}

pub async fn upgrade_all_agent_drivers_from(
    am: &AgentManager,
    source: DownloadSource,
    progress: impl Fn(AgentProgressEvent),
) -> Result<UpgradeAllAgentDriversResult, String> {
    let registry = fetch_registry_from(source).await?;
    upgrade_all_agent_drivers_with_registry(am, &registry, source, &progress, None, None).await
}

/// Like `upgrade_all_agent_drivers`, but using a command-scoped batch
/// cancellation token registered before the registry fetch + blocker check so a
/// cancel fired during that setup aborts the whole batch instead of being lost.
/// `operation_id` names the batch so per-driver cancellation targets the right
/// operation even when the same driver is installed concurrently elsewhere.
pub async fn upgrade_all_agent_drivers_claimed(
    am: &AgentManager,
    progress: impl Fn(AgentProgressEvent),
    batch_cancellation: &Arc<AgentInstallCancellation>,
    operation_id: &str,
) -> Result<UpgradeAllAgentDriversResult, String> {
    upgrade_all_agent_drivers_from_claimed(am, DownloadSource::Official, progress, batch_cancellation, operation_id)
        .await
}

pub async fn upgrade_all_agent_drivers_from_claimed(
    am: &AgentManager,
    source: DownloadSource,
    progress: impl Fn(AgentProgressEvent),
    batch_cancellation: &Arc<AgentInstallCancellation>,
    operation_id: &str,
) -> Result<UpgradeAllAgentDriversResult, String> {
    let registry = fetch_registry_from_claimed(source, &[batch_cancellation.as_ref()]).await?;
    upgrade_all_agent_drivers_with_registry(
        am,
        &registry,
        source,
        &progress,
        Some(batch_cancellation),
        Some(operation_id),
    )
    .await
}

async fn upgrade_all_agent_drivers_with_registry(
    am: &AgentManager,
    registry: &AgentRegistry,
    source: DownloadSource,
    progress: &impl Fn(AgentProgressEvent),
    batch_cancellation: Option<&Arc<AgentInstallCancellation>>,
    operation_id: Option<&str>,
) -> Result<UpgradeAllAgentDriversResult, String> {
    let agents = build_agent_list(am, Some(registry));
    let updatable: Vec<String> =
        agents.iter().filter(|agent| agent.update_available).map(|agent| agent.db_type.clone()).collect();
    let total = updatable.len() as u32;

    // Use the command-scoped batch token when one was registered before the
    // registry fetch + blocker check, so a cancel fired during that setup is
    // observed. Otherwise register a token owned by this call keyed by a fresh
    // operation id so it cannot collide with another in-flight operation.
    let owned_operation_id: Option<String> =
        if operation_id.is_some() { None } else { Some(uuid::Uuid::new_v4().to_string()) };
    let effective_operation_id: &str = owned_operation_id.as_deref().or(operation_id).unwrap_or_default();
    let owned_batch: Option<Arc<AgentInstallCancellation>> = if batch_cancellation.is_some() {
        None
    } else {
        Some(am.begin_install_cancellation(&batch_cancellation_key(effective_operation_id)).await)
    };
    let active_batch_arc: Arc<AgentInstallCancellation> = owned_batch
        .clone()
        .or_else(|| batch_cancellation.cloned())
        .expect("a batch cancellation token is always available");
    let active_batch: &AgentInstallCancellation = active_batch_arc.as_ref();
    if active_batch.is_cancelled() {
        if let Some(token) = owned_batch {
            am.finish_install_cancellation(&batch_cancellation_key(effective_operation_id), &token).await;
        }
        return Ok(UpgradeAllAgentDriversResult { cancelled: total, ..Default::default() });
    }

    // Register a per-driver token for every driver in the batch, keyed by the
    // batch operation id so per-driver cancels target this batch's driver even
    // when the same db_type is being installed concurrently elsewhere. The
    // batch token lets one click abort the whole upgrade; each driver token
    // lets the user cancel a single driver while the rest continue.
    let mut driver_cancellations = std::collections::HashMap::new();
    for db_type in &updatable {
        let key = batch_driver_cancellation_key(effective_operation_id, db_type);
        let token = am.begin_install_cancellation(&key).await;
        driver_cancellations.insert(db_type.clone(), token);
    }

    // Run independent driver installs concurrently, with a fixed upper bound
    // so a large registry cannot saturate download and file-system resources.
    let installs = updatable.into_iter().enumerate().map(|(index, db_type)| {
        let key = batch_driver_cancellation_key(effective_operation_id, &db_type);
        let token = driver_cancellations.remove(&db_type).expect("driver token registered");
        let batch_token = Arc::clone(&active_batch_arc);
        async move {
            let result = if batch_token.is_cancelled() {
                Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string())
            } else {
                install_agent_driver_from_registry_locked(
                    am,
                    registry,
                    source,
                    &db_type,
                    progress,
                    Some((index + 1) as u32),
                    Some(total),
                    // Observe BOTH the row token (per-driver cancel) and the
                    // batch token (cancel-all): a batch cancel must interrupt a
                    // driver whose download already started, not just one that
                    // is still waiting to begin.
                    &[&token, &batch_token],
                )
                .await
            };
            am.finish_install_cancellation(&key, &token).await;
            (db_type, result)
        }
    });

    let outcomes = stream::iter(installs).buffer_unordered(MAX_CONCURRENT_AGENT_UPDATES).collect::<Vec<_>>().await;
    if let Some(token) = owned_batch {
        am.finish_install_cancellation(&batch_cancellation_key(effective_operation_id), &token).await;
    }

    let mut result = UpgradeAllAgentDriversResult::default();
    for (db_type, outcome) in outcomes {
        match outcome {
            Ok(()) => result.upgraded += 1,
            Err(error) => {
                if is_cancelled_error(&error) {
                    result.cancelled += 1;
                } else {
                    log::warn!("Failed to update {} agent driver: {}", db_type, error);
                    result.failed.push(AgentDriverUpdateIssue { db_type, error });
                }
            }
        }
    }

    progress(AgentProgressEvent::step("all-done"));
    Ok(result)
}

fn is_cancelled_error(error: &str) -> bool {
    error.contains(AGENT_DOWNLOAD_CANCELED_ERROR)
}

async fn can_fallback_to_local_agent(
    _am: &AgentManager,
    _db_type: &str,
    cancellations: &[&AgentInstallCancellation],
) -> bool {
    !cancellations.iter().any(|token| token.is_cancelled())
}

fn driver_operation_lock<'a>(am: &'a AgentManager, db_type: &str) -> OperationLockHandle<'a> {
    let mut locks = am.driver_operation_locks.lock().expect("driver operation lock table poisoned");
    let lock = locks.entry(db_type.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone();
    OperationLockHandle::new(&am.driver_operation_locks, db_type, lock)
}

fn jre_operation_lock<'a>(am: &'a AgentManager, jre_key: &str) -> OperationLockHandle<'a> {
    let mut locks = am.jre_install_locks.lock().expect("JRE install lock table poisoned");
    let lock = locks.entry(jre_key.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone();
    OperationLockHandle::new(&am.jre_install_locks, jre_key, lock)
}

/// Future that resolves as soon as any cancellation token fires.
fn first_cancellation<'a>(
    cancellations: &'a [&'a AgentInstallCancellation],
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
    Box::pin(async move {
        let ((), _index, _rest) =
            futures::future::select_all(cancellations.iter().map(|token| Box::pin(token.cancelled()))).await;
    })
}

/// Acquire a per-driver/JRE operation lock, aborting promptly if any
/// cancellation token fires while the lock is held elsewhere. Without this
/// race a cancelled install would wait for the current lock holder to finish
/// before it could observe its token.
async fn lock_or_cancel<'a>(
    lock: &'a tokio::sync::Mutex<()>,
    cancellations: &'a [&'a AgentInstallCancellation],
) -> Result<tokio::sync::MutexGuard<'a, ()>, String> {
    if cancellations.is_empty() {
        return Ok(lock.lock().await);
    }
    tokio::select! {
        guard = lock.lock() => Ok(guard),
        _ = first_cancellation(cancellations) => Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string()),
    }
}

pub async fn uninstall_agent_driver(am: &AgentManager, db_type: &str) -> Result<(), String> {
    let _installation_guard = am.installation_operation_lock.read().await;
    {
        let driver_lock = driver_operation_lock(am, db_type);
        let _driver_guard = driver_lock.lock().await;
        prune_driver_download_cache(am, db_type)?;
        let jar_path = am.driver_jar_path(db_type);
        if jar_path.exists() {
            std::fs::remove_file(&jar_path).map_err(|err| err.to_string())?;
        }
        if let Some(driver_dir) = jar_path.parent() {
            if driver_dir.exists() {
                std::fs::remove_dir_all(driver_dir).map_err(|err| err.to_string())?;
            }
        }
        am.mutate_state(|state| state.installed_drivers.remove(db_type))?;
        am.stop_daemon_by_key(db_type).await;
    }
    Ok(())
}

pub fn clear_agent_download_cache(am: &AgentManager) -> Result<(), String> {
    remove_download_cache_entries(am, |_| true, "download cache")
}

pub async fn uninstall_agent_jre(am: &AgentManager, jre_key: &str) -> Result<(), String> {
    // Keep the dependency check and removal atomic with respect to driver
    // installs/uninstalls that may add or remove a dependency on this JRE.
    let _installation_guard = am.installation_operation_lock.write().await;
    {
        let jre_lock = jre_operation_lock(am, jre_key);
        let _jre_guard = jre_lock.lock().await;
        let local_state = am.load_state();
        let dependents: Vec<&str> = local_state
            .installed_drivers
            .keys()
            .filter(|db_type| am.installed_driver_jre_dependency(&local_state, db_type) == Some(jre_key))
            .map(|k| k.as_str())
            .collect();
        if !dependents.is_empty() {
            return Err(format!(
                "JRE {jre_key} is in use by drivers: {}. Uninstall them first.",
                dependents.join(", ")
            ));
        }
        // Stop daemons first so any java.exe holding the JRE files exits before
        // we try to remove the directory (Windows ERROR_ACCESS_DENIED otherwise).
        am.stop_daemons().await;
        let jre_dir = am.jre_dir(jre_key);
        if let Err(err) = remove_jre_dir_with_retry(&jre_dir) {
            return Err(format_jre_dir_remove_error(&jre_dir, &err));
        }
        am.mutate_state(|state| state.jre_versions.remove(jre_key))?;
    }
    Ok(())
}

pub async fn reinstall_agent_jre(
    am: &AgentManager,
    jre_key: &str,
    progress: impl Fn(AgentProgressEvent),
) -> Result<(), String> {
    reinstall_agent_jre_from(am, jre_key, DownloadSource::Official, progress).await
}

pub async fn reinstall_agent_jre_from(
    am: &AgentManager,
    jre_key: &str,
    source: DownloadSource,
    progress: impl Fn(AgentProgressEvent),
) -> Result<(), String> {
    // Replacing a JRE must not race a driver operation that is using or about
    // to persist a dependency on the same runtime.
    let _installation_guard = am.installation_operation_lock.write().await;
    let jre_lock = jre_operation_lock(am, jre_key);
    let _jre_guard = jre_lock.lock().await;
    let registry = fetch_registry_from(source).await?;
    let jre_info = registry.resolve_jre(jre_key).ok_or_else(|| format!("No JRE definition for version: {jre_key}"))?;
    let platform = AgentManager::current_platform();
    let platform_jre = jre_info
        .platforms
        .get(platform)
        .ok_or_else(|| format!("No JRE {jre_key} available for platform: {platform}"))?;
    let jre_archive = jre_archive_download_path(am, jre_key, platform_jre.format);
    download_with_progress(
        am,
        &progress,
        "jre",
        source,
        &platform_jre.url,
        &r2_path_with_cache_buster(&github_url_to_r2_path(&platform_jre.url, "jre"), &jre_info.version),
        &jre_archive,
        platform_jre.size,
        platform_jre.sha256.as_deref(),
        Some(CacheIdentity::Jre { key: jre_key, version: &jre_info.version }),
        None,
        None,
        None,
        &[],
    )
    .await?;
    let jre_dir = am.jre_dir(jre_key);
    // Stop daemons before deleting so java.exe processes release file
    // handles on Windows (Issue #1100). Falls back to a rename-stash if the
    // directory still cannot be removed.
    am.stop_daemons().await;
    let stash = replace_old_jre_dir(&jre_dir)?;
    persist_pending_jre_cleanup(am, stash.as_ref()).await?;
    extract_jre_archive(&jre_archive, &jre_dir, platform_jre.format)?;
    std::fs::remove_file(&jre_archive).ok();
    am.mutate_state(|state| state.jre_versions.insert(jre_key.to_string(), jre_info.version.clone()))?;
    cleanup_jre_download_cache_after_success(am, jre_key);
    progress(AgentProgressEvent::step("done"));
    Ok(())
}

pub async fn import_agents_from_zip(
    am: &AgentManager,
    zip_path: &Path,
    progress: impl Fn(AgentProgressEvent),
) -> Result<OfflineImportResult, String> {
    import_offline_zip(am, zip_path, |p| {
        progress(AgentProgressEvent {
            operation_id: None,
            step: p.step,
            downloaded: Some(p.current as u64),
            total: Some(p.total as u64),
            db_type: p.db_type,
            current: Some(p.current),
            total_drivers: Some(p.total),
        });
    })
    .await
}

pub fn inspect_offline_package(package_path: &Path) -> Result<OfflineImportPlan, String> {
    if is_tar_zstd_package(package_path) {
        inspect_tar_zstd_driver_package(package_path)
    } else {
        inspect_offline_zip(package_path)
    }
}

pub async fn import_agents_from_package(
    am: &AgentManager,
    package_path: &Path,
    progress: impl Fn(AgentProgressEvent),
) -> Result<OfflineImportResult, String> {
    if is_tar_zstd_package(package_path) {
        import_tar_zstd_driver_package(am, package_path, |event| {
            progress(AgentProgressEvent {
                operation_id: None,
                step: event.step,
                downloaded: Some(event.current as u64),
                total: Some(event.total as u64),
                db_type: event.db_type,
                current: Some(event.current),
                total_drivers: Some(event.total),
            });
        })
        .await
    } else {
        import_agents_from_zip(am, package_path, progress).await
    }
}

fn is_tar_zstd_package(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.to_ascii_lowercase().ends_with(".tar.zst"))
}

async fn install_agent_driver_with_batch(
    am: &AgentManager,
    db_type: &str,
    source: DownloadSource,
    progress: &impl Fn(AgentProgressEvent),
    current: Option<u32>,
    total_drivers: Option<u32>,
    cancellation: Option<&Arc<AgentInstallCancellation>>,
) -> Result<(), String> {
    let _installation_guard = am.installation_operation_lock.read().await;
    let driver_lock = driver_operation_lock(am, db_type);
    // A cancel that fires while the driver lock is held elsewhere must abort
    // promptly instead of waiting for the lock holder to finish.
    let owned_tokens;
    let command_tokens: &[&AgentInstallCancellation] = match cancellation {
        Some(token) => {
            owned_tokens = [token.as_ref()];
            &owned_tokens
        }
        None => &[],
    };
    let _driver_guard = lock_or_cancel(&driver_lock, command_tokens).await?;
    // Use the command-scoped token when one was registered before any awaitable
    // setup (blocker check, lock wait, registry fetch) so a cancel fired during
    // that window is observed here instead of being lost. Otherwise register a
    // token owned by this call keyed by a fresh operation id so two concurrent
    // installs of the same driver cannot replace each other's token.
    let owned_operation_id: Option<String> =
        if cancellation.is_some() { None } else { Some(uuid::Uuid::new_v4().to_string()) };
    let owned_cancellation: Option<Arc<AgentInstallCancellation>> = match owned_operation_id.as_deref() {
        Some(operation_id) => Some(am.begin_install_cancellation(&install_cancellation_key(operation_id)).await),
        None => None,
    };
    let active_cancellation: &AgentInstallCancellation = owned_cancellation
        .as_deref()
        .or_else(|| cancellation.map(|token| token.as_ref()))
        .expect("a cancellation token is always available");
    if active_cancellation.is_cancelled() {
        if let (Some(operation_id), Some(token)) = (owned_operation_id.as_deref(), owned_cancellation.as_ref()) {
            am.finish_install_cancellation(&install_cancellation_key(operation_id), token).await;
        }
        return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string());
    }

    let result = install_agent_driver_with_batch_unlocked(
        am,
        db_type,
        source,
        progress,
        current,
        total_drivers,
        &[active_cancellation],
    )
    .await;

    if let (Some(operation_id), Some(token)) = (owned_operation_id.as_deref(), owned_cancellation.as_ref()) {
        am.finish_install_cancellation(&install_cancellation_key(operation_id), token).await;
    }
    result
}

async fn install_agent_driver_from_registry_locked(
    am: &AgentManager,
    registry: &AgentRegistry,
    source: DownloadSource,
    db_type: &str,
    progress: &impl Fn(AgentProgressEvent),
    current: Option<u32>,
    total_drivers: Option<u32>,
    cancellations: &[&AgentInstallCancellation],
) -> Result<(), String> {
    let _installation_guard = am.installation_operation_lock.read().await;
    let driver_lock = driver_operation_lock(am, db_type);
    assert!(!cancellations.is_empty(), "batch driver cancellation token is always registered");
    // A cancelled batch row must not wait for the current lock holder to
    // finish before observing its cancellation tokens.
    let _driver_guard = lock_or_cancel(&driver_lock, cancellations).await?;
    install_agent_driver_from_registry(am, registry, source, db_type, progress, current, total_drivers, cancellations)
        .await
}

async fn install_agent_driver_with_batch_unlocked(
    am: &AgentManager,
    db_type: &str,
    source: DownloadSource,
    progress: &impl Fn(AgentProgressEvent),
    current: Option<u32>,
    total_drivers: Option<u32>,
    cancellations: &[&AgentInstallCancellation],
) -> Result<(), String> {
    match fetch_registry_from_claimed(source, cancellations).await {
        Ok(registry) => {
            match install_agent_driver_from_registry(
                am,
                &registry,
                source,
                db_type,
                progress,
                current,
                total_drivers,
                cancellations,
            )
            .await
            {
                Ok(()) => Ok(()),
                Err(registry_err) => {
                    // Cancellation is terminal, not a registry failure. Falling
                    // back here would install a bundled JAR after the user
                    // explicitly aborted the download.
                    if can_fallback_to_local_agent(am, db_type, cancellations).await {
                        if let Some(local_jar) = find_local_agent_jar(db_type) {
                            install_local_agent_with_registry_jre(
                                am,
                                &registry,
                                source,
                                db_type,
                                local_jar,
                                progress,
                                current,
                                total_drivers,
                                cancellations,
                            )
                            .await?;
                            return Ok(());
                        }
                    }
                    Err(registry_err)
                }
            }
        }
        Err(registry_err) => {
            // The registry fetch observes cancellation, so the cancel error
            // must not start the local fallback (the fallback guard refuses it
            // anyway because the same tokens are cancelled).
            if can_fallback_to_local_agent(am, db_type, cancellations).await {
                if let Some(local_jar) = find_local_agent_jar(db_type) {
                    install_local_agent(am, db_type, local_jar)?;
                    am.stop_daemon_by_key(db_type).await;
                    progress(AgentProgressEvent::step("done").with_batch(Some(db_type), current, total_drivers));
                    return Ok(());
                }
            }
            Err(registry_err)
        }
    }
}

async fn ensure_jre_from_registry(
    am: &AgentManager,
    registry: &AgentRegistry,
    source: DownloadSource,
    jre_key: &str,
    db_type: &str,
    progress: &impl Fn(AgentProgressEvent),
    current: Option<u32>,
    total_drivers: Option<u32>,
    cancellations: &[&AgentInstallCancellation],
) -> Result<(), String> {
    // Fast path: already installed — return immediately without acquiring the
    // per-JRE lock.  The lock is only needed when a download + extract may be
    // required.
    if !jre_needs_install(am, registry, jre_key) {
        return Ok(());
    }

    // Acquire (or create) the per-JRE-key mutex so that concurrent driver
    // installs sharing the same JRE download it exactly once.
    let lock = jre_operation_lock(am, jre_key);
    // A cancel that fires while another install holds the JRE lock must abort
    // promptly instead of waiting for the lock holder to finish.
    let _jre_guard = lock_or_cancel(&lock, cancellations).await?;

    // Double-check: the previous lock holder may have already installed.
    if !jre_needs_install(am, registry, jre_key) {
        return Ok(());
    }

    let jre_info = registry.resolve_jre(jre_key).ok_or_else(|| format!("No JRE definition for version: {jre_key}"))?;
    let platform = AgentManager::current_platform();
    let platform_jre = jre_info
        .platforms
        .get(platform)
        .ok_or_else(|| format!("No JRE {jre_key} available for platform: {platform}"))?;
    let jre_archive = jre_archive_download_path(am, jre_key, platform_jre.format);
    progress(AgentProgressEvent::transfer("jre", 0, platform_jre.size).with_batch(
        Some(db_type),
        current,
        total_drivers,
    ));
    download_with_progress(
        am,
        progress,
        "jre",
        source,
        &platform_jre.url,
        &r2_path_with_cache_buster(&github_url_to_r2_path(&platform_jre.url, "jre"), &jre_info.version),
        &jre_archive,
        platform_jre.size,
        platform_jre.sha256.as_deref(),
        Some(CacheIdentity::Jre { key: jre_key, version: &jre_info.version }),
        Some(db_type),
        current,
        total_drivers,
        cancellations,
    )
    .await?;
    // A cancel may have fired right after the download completed but before we
    // replace the JRE directory — don't leave a half-extracted runtime.
    if cancellations.iter().any(|token| token.is_cancelled()) {
        std::fs::remove_file(&jre_archive).ok();
        return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string());
    }
    progress(AgentProgressEvent::transfer("jre-extract", 0, 0).with_batch(Some(db_type), current, total_drivers));
    let jre_dir = am.jre_dir(jre_key);
    // Stop only daemons that use this JRE before replacing its directory
    // (Windows ERROR_ACCESS_DENIED, Issue #1100).  In a concurrent
    // upgrade-all this avoids killing unrelated daemons mid-install.
    stop_daemons_using_jre(am, jre_key).await;
    let stash = replace_old_jre_dir(&jre_dir)?;

    // Persist the stash path *before* extraction so that a crash during
    // archive extraction (or a process kill) doesn't leave the renamed-stash
    // directory as an orphan that never gets cleaned up.
    persist_pending_jre_cleanup(am, stash.as_ref()).await?;

    extract_jre_archive(&jre_archive, &jre_dir, platform_jre.format)?;
    std::fs::remove_file(&jre_archive).ok();
    cleanup_jre_download_cache_after_success(am, jre_key);

    // Persist the JRE version after extraction succeeds, while still holding
    // the per-JRE lock.  This guarantees the DCL in another task's
    // jre_needs_install() sees the installed version and skips download.
    am.mutate_state(|state| state.jre_versions.insert(jre_key.to_string(), jre_info.version.clone()))?;

    Ok(())
}

/// Stop daemons whose installed driver actually runs on `jre_key`.
async fn stop_daemons_using_jre(am: &AgentManager, jre_key: &str) {
    let state = am.load_state();
    let keys: Vec<String> = state
        .installed_drivers
        .keys()
        .filter(|db_type| am.installed_driver_jre_dependency(&state, db_type) == Some(jre_key))
        .cloned()
        .collect();
    for db_type in keys {
        am.stop_daemon_by_key(&db_type).await;
    }
}

/// Record a rename-stashed JRE before extraction so startup can clean it up
/// even if the process exits mid-install.
async fn persist_pending_jre_cleanup(am: &AgentManager, stash: Option<&PathBuf>) -> Result<(), String> {
    let Some(stash_path) = stash else {
        return Ok(());
    };

    am.mutate_state(|state| {
        if !state.pending_jre_cleanup.contains(stash_path) {
            state.pending_jre_cleanup.push(stash_path.clone());
        }
    })
}

async fn persist_local_agent_install_state(
    am: &AgentManager,
    db_type: &str,
    jre_key: &str,
    jre_version: Option<&str>,
) -> Result<(), String> {
    am.mutate_state(|state| {
        if let Some(version) = jre_version {
            state.jre_versions.insert(jre_key.to_string(), version.to_string());
        }
        record_local_agent_install(state, db_type, jre_key);
    })
}

fn ensure_local_agent_commit_allowed(cancellations: &[&AgentInstallCancellation]) -> Result<(), String> {
    if cancellations.iter().any(|token| token.is_cancelled()) {
        return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string());
    }
    Ok(())
}

async fn commit_local_agent_install(
    am: &AgentManager,
    db_type: &str,
    local_jar: &Path,
    jre_key: &str,
    jre_version: Option<&str>,
) -> Result<(), String> {
    install_local_agent_file(am, db_type, local_jar)?;
    persist_local_agent_install_state(am, db_type, jre_key, jre_version).await
}

async fn install_local_agent_with_registry_jre(
    am: &AgentManager,
    registry: &AgentRegistry,
    source: DownloadSource,
    db_type: &str,
    local_jar: PathBuf,
    progress: &impl Fn(AgentProgressEvent),
    current: Option<u32>,
    total_drivers: Option<u32>,
    cancellations: &[&AgentInstallCancellation],
) -> Result<(), String> {
    let jre_key = DEFAULT_JRE_KEY;
    if jre_needs_install(am, registry, jre_key) {
        ensure_jre_from_registry(
            am,
            registry,
            source,
            jre_key,
            db_type,
            progress,
            current,
            total_drivers,
            cancellations,
        )
        .await?;
    }
    ensure_local_agent_commit_allowed(cancellations)?;
    commit_local_agent_install(
        am,
        db_type,
        &local_jar,
        jre_key,
        registry.resolve_jre(jre_key).map(|jre| jre.version.as_str()),
    )
    .await?;
    am.stop_daemon_by_key(db_type).await;
    progress(AgentProgressEvent::step("done").with_batch(Some(db_type), current, total_drivers));
    Ok(())
}

async fn install_sqlite_worker_from_registry(
    am: &AgentManager,
    source: DownloadSource,
    db_type: &str,
    driver: &crate::agent_manager::DriverInfo,
    progress: &impl Fn(AgentProgressEvent),
    current: Option<u32>,
    total_drivers: Option<u32>,
    cancellations: &[&AgentInstallCancellation],
) -> Result<(), String> {
    let jre_key = &driver.jre;
    std::fs::create_dir_all(am.driver_dir(db_type))
        .map_err(|err| format!("Failed to create driver directory: {err}"))?;
    for platform in SQLITE_WORKER_NATIVE_PLATFORMS {
        let artifact = driver
            .native
            .get(*platform)
            .ok_or_else(|| format!("SQLite SSH worker registry is missing the {platform} native package"))?;
        let target_path = am.driver_native_platform_path(db_type, platform);
        let download_path = driver_artifact_download_path(&target_path, artifact.format);
        progress(AgentProgressEvent::transfer("driver", 0, artifact.size).with_batch(
            Some(db_type),
            current,
            total_drivers,
        ));
        download_with_progress(
            am,
            progress,
            "driver",
            source,
            &artifact.url,
            &r2_path_with_cache_buster(&github_url_to_r2_path(&artifact.url, "driver"), &driver.version),
            &download_path,
            artifact.size,
            artifact.sha256.as_deref(),
            Some(CacheIdentity::Driver { db_type, version: &driver.version }),
            Some(db_type),
            current,
            total_drivers,
            cancellations,
        )
        .await?;
        if cancellations.iter().any(|token| token.is_cancelled()) {
            std::fs::remove_file(&download_path).ok();
            return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string());
        }
        install_downloaded_driver_artifact(
            &download_path,
            &target_path,
            artifact.format,
            DriverArtifactKind::Native,
            db_type,
            &driver.version,
            Some(platform),
        )?;
        mark_executable(&target_path)?;
    }
    std::fs::remove_file(am.driver_jar_path(db_type)).ok();
    std::fs::remove_file(am.driver_native_path(db_type)).ok();
    am.mutate_state(|state| {
        state.installed_drivers.insert(
            db_type.to_string(),
            InstalledDriver {
                version: driver.version.clone(),
                installed_at: chrono::Utc::now().to_rfc3339(),
                jre: jre_key.clone(),
            },
        );
    })?;
    am.stop_daemon_by_key(db_type).await;
    cleanup_driver_download_cache_after_success(am, db_type);
    progress(AgentProgressEvent::step("done").with_batch(Some(db_type), current, total_drivers));
    Ok(())
}

async fn install_agent_driver_from_registry(
    am: &AgentManager,
    registry: &AgentRegistry,
    source: DownloadSource,
    db_type: &str,
    progress: &impl Fn(AgentProgressEvent),
    current: Option<u32>,
    total_drivers: Option<u32>,
    cancellations: &[&AgentInstallCancellation],
) -> Result<(), String> {
    let Some(driver) = agent_registry_driver(registry, db_type) else {
        if let Some(local_jar) = find_local_agent_jar(db_type) {
            install_local_agent_with_registry_jre(
                am,
                registry,
                source,
                db_type,
                local_jar,
                progress,
                current,
                total_drivers,
                cancellations,
            )
            .await?;
            return Ok(());
        }
        return Err(format!("Unknown driver type: {db_type}"));
    };
    if AgentManager::is_sqlite_worker_driver(db_type) {
        return install_sqlite_worker_from_registry(
            am,
            source,
            db_type,
            driver,
            progress,
            current,
            total_drivers,
            cancellations,
        )
        .await;
    }
    let jre_key = &driver.jre;
    let native_artifact = driver.native.get(AgentManager::current_platform());
    let jar_artifact = usable_driver_jar(driver);
    let requires_java_runtime = native_artifact.is_none();
    let needs_jre = requires_java_runtime && jre_needs_install(am, registry, jre_key);

    if needs_jre {
        ensure_jre_from_registry(
            am,
            registry,
            source,
            jre_key,
            db_type,
            progress,
            current,
            total_drivers,
            cancellations,
        )
        .await?;
    }

    let (artifact, target_path, is_native_artifact) = if let Some(native) = native_artifact {
        (native, am.driver_native_path(db_type), true)
    } else if let Some(jar) = jar_artifact {
        (jar, am.driver_jar_path(db_type), false)
    } else {
        return Err(format!("No driver artifact available for {db_type}"));
    };
    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("Failed to create driver directory: {err}"))?;
    }
    let artifact_kind = if is_native_artifact { DriverArtifactKind::Native } else { DriverArtifactKind::Jar };
    let download_path = driver_artifact_download_path(&target_path, artifact.format);
    progress(AgentProgressEvent::transfer("driver", 0, artifact.size).with_batch(
        Some(db_type),
        current,
        total_drivers,
    ));
    download_with_progress(
        am,
        progress,
        "driver",
        source,
        &artifact.url,
        &r2_path_with_cache_buster(&github_url_to_r2_path(&artifact.url, "driver"), &driver.version),
        &download_path,
        artifact.size,
        artifact.sha256.as_deref(),
        Some(CacheIdentity::Driver { db_type, version: &driver.version }),
        Some(db_type),
        current,
        total_drivers,
        cancellations,
    )
    .await?;
    // A cancel may have fired after the download completed but before the
    // artifact is moved into place — drop the partial artifact and bail.
    if cancellations.iter().any(|token| token.is_cancelled()) {
        std::fs::remove_file(&download_path).ok();
        return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string());
    }
    install_downloaded_driver_artifact(
        &download_path,
        &target_path,
        artifact.format,
        artifact_kind,
        db_type,
        &driver.version,
        is_native_artifact.then_some(AgentManager::current_platform()),
    )?;
    // Some drivers publish both a native agent and a legacy JAR fallback. Only
    // validate the artifact type that was actually installed.
    if is_native_artifact {
        mark_executable(&target_path)?;
        std::fs::remove_file(am.driver_jar_path(db_type)).ok();
    } else {
        if !am.is_driver_jar_valid(db_type) {
            std::fs::remove_file(&target_path).ok();
            return Err(format!("Downloaded driver jar is invalid or corrupt: {}", target_path.display()));
        }
        std::fs::remove_file(am.driver_native_path(db_type)).ok();
    }

    // The cancellation boundary is immediately before the staged artifact is
    // committed above. After that atomic replacement, treating a newly arrived
    // cancel as a rollback would delete a working driver and lose the prior
    // installation, so this completed install must persist normally.
    am.mutate_state(|state| {
        if requires_java_runtime {
            if let Some(jre_info) = registry.resolve_jre(jre_key) {
                state.jre_versions.insert(jre_key.clone(), jre_info.version.clone());
            }
        }
        state.installed_drivers.insert(
            db_type.to_string(),
            InstalledDriver {
                version: driver.version.clone(),
                installed_at: chrono::Utc::now().to_rfc3339(),
                jre: jre_key.clone(),
            },
        );
    })?;
    am.stop_daemon_by_key(db_type).await;
    cleanup_driver_download_cache_after_success(am, db_type);
    progress(AgentProgressEvent::step("done").with_batch(Some(db_type), current, total_drivers));
    Ok(())
}

fn driver_artifact_download_path(target_path: &Path, format: Option<ArtifactFormat>) -> PathBuf {
    let parent = target_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = target_path.file_name().and_then(|name| name.to_str()).unwrap_or("agent");
    match format {
        Some(ArtifactFormat::TarZstd) => parent.join(format!(".{file_name}.tar.zst")),
        // Keep raw artifacts out of the live driver path until the caller has
        // made its final cancellation check. The filename stays stable so an
        // existing download-cache entry remains reusable.
        None => parent.join(".staging").join(file_name),
    }
}

fn install_downloaded_driver_artifact(
    download_path: &Path,
    target_path: &Path,
    format: Option<ArtifactFormat>,
    artifact_kind: DriverArtifactKind,
    db_type: &str,
    expected_version: &str,
    native_platform: Option<&str>,
) -> Result<(), String> {
    let result = match format {
        None => replace_download(download_path, target_path),
        Some(ArtifactFormat::TarZstd) => install_driver_from_tar_zstd_package(
            download_path,
            target_path,
            artifact_kind,
            db_type,
            expected_version,
            native_platform,
        ),
    };
    if result.is_ok() {
        std::fs::remove_file(download_path).ok();
    }
    result
}

fn install_driver_from_tar_zstd_package(
    package_path: &Path,
    target_path: &Path,
    expected_kind: DriverArtifactKind,
    db_type: &str,
    expected_version: &str,
    native_platform: Option<&str>,
) -> Result<(), String> {
    let info = tar_zstd_driver_package_info(package_path)?;
    if info.db_type != db_type {
        return Err(format!("Driver package contains {}, expected {db_type}", info.db_type));
    }
    if info.version != expected_version {
        return Err(format!(
            "Driver package version mismatch for {db_type}: expected {expected_version}, got {}",
            info.version
        ));
    }
    if info.kind != expected_kind {
        return Err(format!(
            "Driver package artifact type mismatch for {db_type}: expected {}, got {}",
            expected_kind.label(),
            info.kind.label()
        ));
    }
    let parent = target_path.parent().ok_or_else(|| format!("Invalid driver path: {}", target_path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| format!("Failed to create driver directory: {error}"))?;
    let staging_path = parent.join(format!(".agent-package-{}", uuid::Uuid::new_v4()));
    let result = extract_tar_zstd_file(package_path, &info.entry_name, &staging_path, info.size).and_then(|_| {
        match info.kind {
            DriverArtifactKind::Jar if !is_valid_agent_jar(&staging_path) => {
                return Err(format!("Packaged driver jar is invalid or corrupt: {}", info.entry_name));
            }
            DriverArtifactKind::Native => {
                let platform = native_platform
                    .or(info.native_platform.as_deref())
                    .unwrap_or_else(|| AgentManager::current_platform());
                validate_native_agent_binary_for_platform(&staging_path, platform)?;
                mark_executable(&staging_path)?;
            }
            DriverArtifactKind::Jar => {}
        }
        replace_download(&staging_path, target_path)
    });
    if result.is_err() {
        std::fs::remove_file(&staging_path).ok();
    }
    result
}

fn read_registry_from_tar_zstd(package_path: &Path) -> Result<AgentRegistry, String> {
    const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;

    let file = std::fs::File::open(package_path).map_err(|error| format!("Failed to open driver package: {error}"))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|error| format!("Failed to open zstd driver package: {error}"))?;
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|error| format!("Invalid tar.zst driver package: {error}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("Invalid tar.zst driver package entry: {error}"))?;
        let path = entry.path().map_err(|error| format!("Invalid driver package path: {error}"))?;
        let name = safe_archive_entry_name(&path)?;
        if name != "agent-registry.json" {
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err("Driver package registry is not a regular file".to_string());
        }
        if entry.size() > MAX_REGISTRY_BYTES {
            return Err("Driver package registry is too large".to_string());
        }
        let mut json = String::new();
        entry.read_to_string(&mut json).map_err(|error| format!("Failed to read driver package registry: {error}"))?;
        return serde_json::from_str(&json).map_err(|error| format!("Invalid driver package registry: {error}"));
    }
    Err("agent-registry.json not found in the driver package".to_string())
}

fn extract_tar_zstd_file(
    package_path: &Path,
    expected_entry: &str,
    destination: &Path,
    expected_size: u64,
) -> Result<(), String> {
    let file = std::fs::File::open(package_path).map_err(|error| format!("Failed to open driver package: {error}"))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|error| format!("Failed to open zstd driver package: {error}"))?;
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|error| format!("Invalid tar.zst driver package: {error}"))?;
    let mut extracted = false;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("Invalid tar.zst driver package entry: {error}"))?;
        let path = entry.path().map_err(|error| format!("Invalid driver package path: {error}"))?;
        let name = safe_archive_entry_name(&path)?;
        if name == "agent-registry.json" || entry.header().entry_type().is_dir() {
            continue;
        }
        if name != expected_entry {
            return Err(format!("Unexpected file in driver package: {name}"));
        }
        if extracted || !entry.header().entry_type().is_file() {
            return Err(format!("Invalid driver package entry: {name}"));
        }
        let mut output =
            std::fs::File::create(destination).map_err(|error| format!("Failed to create staged driver: {error}"))?;
        let copied = std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Failed to extract driver package: {error}"))?;
        std::io::Write::flush(&mut output).map_err(|error| format!("Failed to flush staged driver: {error}"))?;
        if expected_size > 0 && copied != expected_size {
            return Err(format!("Packaged driver size mismatch: expected {expected_size} bytes, got {copied} bytes"));
        }
        extracted = true;
    }
    if extracted {
        Ok(())
    } else {
        Err(format!("Driver package entry not found: {expected_entry}"))
    }
}

fn safe_archive_entry_name(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => parts.push(value.to_string_lossy().into_owned()),
            std::path::Component::CurDir => {}
            _ => return Err(format!("Unsafe driver package path: {}", path.display())),
        }
    }
    if parts.is_empty() {
        return Err("Driver package contains an empty path".to_string());
    }
    Ok(parts.join("/"))
}

fn agent_registry_driver<'a>(
    registry: &'a AgentRegistry,
    db_type: &str,
) -> Option<&'a crate::agent_manager::DriverInfo> {
    registry.drivers.get(db_type)
}

#[allow(clippy::too_many_arguments)]
async fn download_with_progress(
    am: &AgentManager,
    progress: &impl Fn(AgentProgressEvent),
    step: &str,
    source: DownloadSource,
    url: &str,
    r2_path: &str,
    dest: &std::path::Path,
    total_size: u64,
    expected_sha256: Option<&str>,
    cache_identity: Option<CacheIdentity<'_>>,
    db_type: Option<&str>,
    current: Option<u32>,
    total_drivers: Option<u32>,
    cancellations: &[&AgentInstallCancellation],
) -> Result<(), String> {
    const DOWNLOAD_ATTEMPTS: usize = 4;
    let expected_sha256 = normalized_sha256(expected_sha256)?;
    // Observe the exact operation tokens threaded from the command layer: a
    // single install passes its own token; a batch passes BOTH the row token
    // and the batch token so a batch cancel-all interrupts a driver whose
    // download already started. An empty slice means "no cancellation" for the
    // offline/auto paths.
    let any_cancelled = || cancellations.iter().any(|token| token.is_cancelled());
    if any_cancelled() {
        return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string());
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let tmp = download_temp_path(dest);
    let tmp_source = download_source_path(&tmp);
    let cache_path = cached_download_path(am, url, total_size, expected_sha256, cache_identity, dest);
    prune_download_cache(am).ok();
    if cached_download_is_valid(am, &cache_path, total_size, expected_sha256) {
        if any_cancelled() {
            return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string());
        }
        std::fs::copy(&cache_path, &tmp).map_err(|err| format!("Failed to copy cached download: {err}"))?;
        progress(AgentProgressEvent::transfer(step, total_size, total_size).with_batch(
            db_type,
            current,
            total_drivers,
        ));
        return replace_download(&tmp, dest);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {err}"))?;
    let mut last_err = None;
    let mut completed = false;
    let mut rejected_sources = std::collections::HashSet::new();
    for attempt in 1..=DOWNLOAD_ATTEMPTS {
        if any_cancelled() {
            std::fs::remove_file(&tmp).ok();
            std::fs::remove_file(&tmp_source).ok();
            return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string());
        }
        let mut resume_from = std::fs::metadata(&tmp).map(|meta| meta.len()).unwrap_or(0);
        let resume_source = std::fs::read_to_string(&tmp_source).ok().map(|value| value.trim().to_string());
        if resume_from > 0 && resume_source.is_none() {
            std::fs::remove_file(&tmp).ok();
            resume_from = 0;
        }
        if total_size > 0 && resume_from > total_size {
            std::fs::remove_file(&tmp).ok();
            std::fs::remove_file(&tmp_source).ok();
            resume_from = 0;
        }
        if total_size > 0 && resume_from == total_size {
            match validate_artifact_integrity(&tmp, total_size, expected_sha256) {
                Ok(()) => {
                    progress(AgentProgressEvent::transfer(step, total_size, total_size).with_batch(
                        db_type,
                        current,
                        total_drivers,
                    ));
                    completed = true;
                    break;
                }
                Err(err) => {
                    if let Some(source_url) = resume_source {
                        rejected_sources.insert(source_url);
                    }
                    std::fs::remove_file(&tmp).ok();
                    std::fs::remove_file(&tmp_source).ok();
                    last_err = Some(err);
                    continue;
                }
            }
        }

        let (mut resp, resumed, source_url) = match open_agent_download_response(
            &client,
            source,
            url,
            r2_path,
            "dbx-agent-manager",
            resume_from,
            total_size,
            resume_source.as_deref(),
            &rejected_sources,
            cancellations,
        )
        .await
        {
            Ok(value) => value,
            Err(err) => {
                if resume_from > 0 {
                    std::fs::remove_file(&tmp).ok();
                    std::fs::remove_file(&tmp_source).ok();
                }
                last_err = Some(err);
                continue;
            }
        };
        let starting_size = if resumed { resume_from } else { 0 };
        let content_length = total_size.max(starting_size + resp.content_length().unwrap_or(0));
        let mut file = if resumed {
            std::fs::OpenOptions::new()
                .append(true)
                .open(&tmp)
                .map_err(|err| format!("Failed to open temp file for resume: {err}"))?
        } else {
            std::fs::File::create(&tmp).map_err(|err| format!("Failed to create temp file: {err}"))?
        };
        std::fs::write(&tmp_source, &source_url).map_err(|err| format!("Failed to write download source: {err}"))?;
        let mut downloaded = starting_size;
        let transfer_result = async {
            if cancellations.is_empty() {
                while let Some(chunk) = resp.chunk().await.map_err(|err| format!("Download stream error: {err}"))? {
                    std::io::Write::write_all(&mut file, &chunk)
                        .map_err(|err| format!("Failed to write chunk: {err}"))?;
                    downloaded += chunk.len() as u64;
                    progress(AgentProgressEvent::transfer(step, downloaded, content_length).with_batch(
                        db_type,
                        current,
                        total_drivers,
                    ));
                }
                return std::io::Write::flush(&mut file).map_err(|err| format!("Failed to flush temp file: {err}"));
            }
            // Cancellation tokens are registered: await the stream and every
            // cancel signal concurrently so any token (row-level or batch-level)
            // aborts mid-stream.
            loop {
                tokio::select! {
                    chunk = resp.chunk() => {
                        let chunk = chunk.map_err(|err| format!("Download stream error: {err}"))?;
                        match chunk {
                            Some(chunk) => {
                                std::io::Write::write_all(&mut file, &chunk)
                                    .map_err(|err| format!("Failed to write chunk: {err}"))?;
                                downloaded += chunk.len() as u64;
                                progress(AgentProgressEvent::transfer(step, downloaded, content_length)
                                    .with_batch(db_type, current, total_drivers));
                            }
                            None => break,
                        }
                    }
                    _ = first_cancellation(cancellations) => {
                        return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string());
                    }
                }
            }
            std::io::Write::flush(&mut file).map_err(|err| format!("Failed to flush temp file: {err}"))
        }
        .await;
        drop(file);

        if let Err(err) = transfer_result {
            if any_cancelled() {
                std::fs::remove_file(&tmp).ok();
                std::fs::remove_file(&tmp_source).ok();
                return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string());
            }
            last_err = Some(format!("{err} (attempt {attempt}/{DOWNLOAD_ATTEMPTS}, source {source_url})"));
            continue;
        }

        let actual_size = std::fs::metadata(&tmp).map(|meta| meta.len()).unwrap_or(0);
        if total_size == 0 || actual_size == total_size {
            match validate_artifact_integrity(&tmp, total_size, expected_sha256) {
                Ok(()) => {
                    completed = true;
                    break;
                }
                Err(err) => {
                    rejected_sources.insert(source_url.clone());
                    std::fs::remove_file(&tmp).ok();
                    std::fs::remove_file(&tmp_source).ok();
                    last_err = Some(format!("{err} (attempt {attempt}/{DOWNLOAD_ATTEMPTS}, source {source_url})"));
                    continue;
                }
            }
        }
        if actual_size > total_size {
            std::fs::remove_file(&tmp).ok();
            std::fs::remove_file(&tmp_source).ok();
        }
        last_err = Some(format!(
            "Downloaded {step} is incomplete: expected {total_size} bytes, got {actual_size} bytes (attempt {attempt}/{DOWNLOAD_ATTEMPTS}, source {source_url})"
        ));
    }
    if !completed {
        if any_cancelled() {
            std::fs::remove_file(&tmp).ok();
            std::fs::remove_file(&tmp_source).ok();
            return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string());
        }
        let actual_size = std::fs::metadata(&tmp).map(|meta| meta.len()).unwrap_or(0);
        return Err(last_err.unwrap_or_else(|| {
            format!("Downloaded {step} is incomplete: expected {total_size} bytes, got {actual_size} bytes")
        }));
    }
    std::fs::remove_file(&tmp_source).ok();
    if let Some(parent) = cache_path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            log::warn!("Failed to create agent download cache directory: {err}");
        } else if let Err(err) = std::fs::copy(&tmp, &cache_path) {
            log::warn!("Failed to cache agent download: {err}");
        }
    }
    replace_download(&tmp, dest)
}

async fn open_agent_download_response(
    client: &reqwest::Client,
    source: DownloadSource,
    github_url: &str,
    r2_path: &str,
    user_agent: &str,
    resume_from: u64,
    expected_size: u64,
    resume_source: Option<&str>,
    rejected_sources: &std::collections::HashSet<String>,
    cancellations: &[&AgentInstallCancellation],
) -> Result<(reqwest::Response, bool, String), String> {
    let mut errors = Vec::new();
    for candidate_url in source.download_candidate_urls(github_url, r2_path)? {
        if rejected_sources.contains(&candidate_url) {
            errors.push(format!("{candidate_url}: skipped after SHA-256 mismatch"));
            continue;
        }
        if resume_from > 0 && resume_source.is_some_and(|source| source != candidate_url) {
            continue;
        }
        let mut request = client
            .get(&candidate_url)
            .header(reqwest::header::USER_AGENT, user_agent)
            .header(reqwest::header::ACCEPT_ENCODING, "identity");
        if resume_from > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
        }
        // Race the request with cancellation: a stalled mirror that never
        // returns response headers must not hold the install hostage until
        // the 300s client timeout. Dropping the send future aborts it.
        let resp = if cancellations.is_empty() {
            match request.send().await {
                Ok(resp) => resp,
                Err(err) => {
                    errors.push(format!("{candidate_url}: {err}"));
                    continue;
                }
            }
        } else {
            tokio::select! {
                result = request.send() => match result {
                    Ok(resp) => resp,
                    Err(err) => {
                        errors.push(format!("{candidate_url}: {err}"));
                        continue;
                    }
                },
                _ = first_cancellation(cancellations) => return Err(AGENT_DOWNLOAD_CANCELED_ERROR.to_string()),
            }
        };
        let status = resp.status();
        if expected_size > 0 {
            let response_size = response_total_size(&resp, resume_from);
            if response_size != Some(expected_size) {
                let found = response_size.map_or_else(|| "unknown".to_string(), |size| size.to_string());
                errors.push(format!(
                    "{candidate_url}: artifact size mismatch, expected {expected_size} bytes, got {found} bytes"
                ));
                continue;
            }
        }
        if resume_from > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT {
            return Ok((resp, true, candidate_url));
        }
        if status.is_success() {
            return match resp.error_for_status() {
                Ok(resp) => Ok((resp, false, candidate_url)),
                Err(err) => Err(format!("{candidate_url}: {err}")),
            };
        }
        errors.push(format!("{candidate_url}: HTTP {status}"));
    }
    Err(format!("Failed to download artifact: {}", errors.join("; ")))
}

fn response_total_size(resp: &reqwest::Response, resume_from: u64) -> Option<u64> {
    if resp.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        return resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(content_range_total_size);
    }
    resp.content_length().map(|size| size + resume_from)
}

fn content_range_total_size(value: &str) -> Option<u64> {
    value.rsplit('/').next()?.parse().ok()
}

#[derive(Debug, Clone, Copy)]
enum CacheIdentity<'a> {
    Driver { db_type: &'a str, version: &'a str },
    Jre { key: &'a str, version: &'a str },
}

impl CacheIdentity<'_> {
    fn hash_key(self) -> String {
        match self {
            Self::Driver { db_type, version } => format!("driver:{db_type}:{version}"),
            Self::Jre { key, version } => format!("jre:{key}:{version}"),
        }
    }

    fn file_prefix(self) -> String {
        match self {
            Self::Driver { db_type, version } => {
                format!("driver-{}-{}", cache_file_token(db_type), cache_file_token(version))
            }
            Self::Jre { key, version } => format!("jre-{}-{}", cache_file_token(key), cache_file_token(version)),
        }
    }
}

fn cached_download_path(
    am: &AgentManager,
    url: &str,
    total_size: u64,
    expected_sha256: Option<&str>,
    cache_identity: Option<CacheIdentity<'_>>,
    dest: &std::path::Path,
) -> std::path::PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    total_size.hash(&mut hasher);
    expected_sha256.hash(&mut hasher);
    let identity_hash_key = cache_identity.map(CacheIdentity::hash_key);
    identity_hash_key.hash(&mut hasher);
    let hash = hasher.finish();
    let file_name = dest.file_name().and_then(|name| name.to_str()).unwrap_or("download");
    let prefix = cache_identity.map(CacheIdentity::file_prefix).unwrap_or_else(|| "download".to_string());
    am.download_cache_dir().join(format!("{prefix}-{hash:016x}-{file_name}"))
}

fn cached_download_is_valid(
    am: &AgentManager,
    path: &std::path::Path,
    expected_size: u64,
    expected_sha256: Option<&str>,
) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    if expected_size > 0 && meta.len() != expected_size {
        let _ = std::fs::remove_file(path);
        return false;
    }
    let max_age = std::time::Duration::from_secs(am.download_cache_max_age_days() * 24 * 60 * 60);
    if meta.modified().ok().and_then(|modified| modified.elapsed().ok()).is_some_and(|age| age > max_age) {
        let _ = std::fs::remove_file(path);
        return false;
    }
    if validate_artifact_integrity(path, expected_size, expected_sha256).is_err() {
        let _ = std::fs::remove_file(path);
        return false;
    }
    true
}

fn normalized_sha256(expected_sha256: Option<&str>) -> Result<Option<&str>, String> {
    let Some(expected_sha256) = expected_sha256.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if expected_sha256.len() != 64 || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid SHA-256 metadata for agent artifact".to_string());
    }
    Ok(Some(expected_sha256))
}

fn validate_artifact_integrity(path: &Path, expected_size: u64, expected_sha256: Option<&str>) -> Result<(), String> {
    let metadata = std::fs::metadata(path).map_err(|err| format!("Failed to inspect downloaded artifact: {err}"))?;
    if expected_size > 0 && metadata.len() != expected_size {
        return Err(format!(
            "Downloaded artifact size mismatch: expected {expected_size} bytes, got {} bytes",
            metadata.len()
        ));
    }
    let Some(expected_sha256) = expected_sha256 else {
        return Ok(());
    };
    let actual_sha256 = file_sha256(path)?;
    if actual_sha256.eq_ignore_ascii_case(expected_sha256) {
        return Ok(());
    }
    Err(format!("Downloaded artifact SHA-256 mismatch: expected {expected_sha256}, got {actual_sha256}"))
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|err| format!("Failed to hash downloaded artifact: {err}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|err| format!("Failed to hash downloaded artifact: {err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn prune_download_cache(am: &AgentManager) -> Result<(), String> {
    let cache_dir = am.download_cache_dir();
    let max_age = std::time::Duration::from_secs(am.download_cache_max_age_days() * 24 * 60 * 60);
    let Ok(entries) = std::fs::read_dir(&cache_dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.modified().ok().and_then(|modified| modified.elapsed().ok()).is_some_and(|age| age > max_age) {
            let _ = if meta.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
        }
    }
    Ok(())
}

fn prune_driver_download_cache(am: &AgentManager, db_type: &str) -> Result<(), String> {
    let prefix = format!("driver-{}-", cache_file_token(db_type));
    remove_download_cache_entries(am, |name| name.starts_with(&prefix), "cached driver download")
}

fn prune_jre_download_cache(am: &AgentManager, jre_key: &str) -> Result<(), String> {
    let prefix = format!("jre-{}-", cache_file_token(jre_key));
    remove_download_cache_entries(am, |name| name.starts_with(&prefix), "cached JRE download")
}

fn cleanup_driver_download_cache_after_success(am: &AgentManager, db_type: &str) {
    if let Err(err) = prune_driver_download_cache(am, db_type) {
        log::warn!("Failed to clean cached download for {db_type}: {err}");
    }
}

fn cleanup_jre_download_cache_after_success(am: &AgentManager, jre_key: &str) {
    if let Err(err) = prune_jre_download_cache(am, jre_key) {
        log::warn!("Failed to clean cached JRE download for {jre_key}: {err}");
    }
}

fn remove_download_cache_entries(
    am: &AgentManager,
    should_remove: impl Fn(&str) -> bool,
    context: &str,
) -> Result<(), String> {
    let cache_dir = am.download_cache_dir();
    let Ok(entries) = std::fs::read_dir(&cache_dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !should_remove(name) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|err| format!("Failed to remove {context}: {err}"))?;
        } else {
            std::fs::remove_file(&path).map_err(|err| format!("Failed to remove {context}: {err}"))?;
        }
    }
    Ok(())
}

fn cache_file_token(value: &str) -> String {
    let token = value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' { ch } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if token.is_empty() {
        "unknown".to_string()
    } else {
        token
    }
}

fn r2_path_with_cache_buster(r2_path: &str, version: &str) -> String {
    let separator = if r2_path.contains('?') { '&' } else { '?' };
    format!("{r2_path}{separator}v={}", cache_file_token(version))
}

pub fn github_url_to_r2_path(github_url: &str, category: &str) -> String {
    let filename = github_url.rsplit('/').next().unwrap_or(github_url);
    match category {
        "jre" => format!("agents/jre/{filename}"),
        "driver" => format!("agents/drivers/{filename}"),
        _ => format!("agents/{filename}"),
    }
}

pub fn ensure_driver_app_version(
    db_type: &str,
    driver: &crate::agent_manager::DriverInfo,
    current_version: &str,
) -> Result<(), String> {
    if is_app_version_compatible(&driver.min_app_version, current_version) {
        return Ok(());
    }
    Err(format!(
        "{db_type} driver {} requires DBX {} or newer. Current DBX version is {}.",
        driver.version, driver.min_app_version, current_version
    ))
}

pub fn is_app_version_compatible(min_app_version: &str, current_version: &str) -> bool {
    !crate::update::is_newer_version(min_app_version, current_version)
}

pub fn download_temp_path(dest: &std::path::Path) -> std::path::PathBuf {
    let file_name = dest.file_name().and_then(|name| name.to_str()).unwrap_or("download");
    dest.with_file_name(format!("{file_name}.download"))
}

fn download_source_path(tmp: &std::path::Path) -> std::path::PathBuf {
    tmp.with_extension(format!(
        "{}source",
        tmp.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!("{extension}."))
            .unwrap_or_default()
    ))
}

pub fn replace_download(tmp: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if dest.exists() {
        let backup = backup_path(dest);
        std::fs::rename(dest, &backup).map_err(|e| format!("Failed to back up existing file: {e}"))?;
        match std::fs::rename(tmp, dest) {
            Ok(()) => {
                std::fs::remove_file(&backup).ok();
                Ok(())
            }
            Err(err) => {
                let _ = std::fs::rename(&backup, dest);
                Err(format!("Failed to replace downloaded file: {err}"))
            }
        }
    } else {
        std::fs::rename(tmp, dest).map_err(|e| format!("Failed to move downloaded file into place: {e}"))
    }
}

fn backup_path(dest: &std::path::Path) -> std::path::PathBuf {
    let file_name = dest.file_name().and_then(|name| name.to_str()).unwrap_or("download");
    dest.with_file_name(format!("{file_name}.backup-{}", uuid::Uuid::new_v4()))
}

// ──────────── Offline import ────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct OfflineImportProgress {
    pub step: String,
    pub current: u32,
    pub total: u32,
    /// Display label for the current item (e.g. "MySQL", "JRE 21.0.12").
    pub label: String,
    /// The real database-type key (e.g. "mysql"), used by the frontend for
    /// per-driver progress routing. `None` for JRE-only steps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct OfflineImportResult {
    pub jre_installed: Vec<String>,
    pub drivers_installed: Vec<String>,
    pub drivers_skipped: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct OfflineImportPlan {
    pub driver_keys: Vec<String>,
    pub includes_jre: bool,
}

type OfflineJreEntry = (String, String, Option<ArtifactFormat>);
type OfflineDriverEntry = (String, String, bool);
type OfflineArchiveEntries = (Vec<OfflineJreEntry>, Vec<OfflineDriverEntry>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DriverArtifactKind {
    Jar,
    Native,
}

impl DriverArtifactKind {
    fn label(self) -> &'static str {
        match self {
            Self::Jar => "jar",
            Self::Native => "native",
        }
    }
}

#[derive(Debug, Clone)]
struct TarZstdDriverPackageInfo {
    db_type: String,
    version: String,
    jre: String,
    kind: DriverArtifactKind,
    native_platform: Option<String>,
    entry_name: String,
    size: u64,
}

fn inspect_tar_zstd_driver_package(package_path: &Path) -> Result<OfflineImportPlan, String> {
    let info = tar_zstd_driver_package_info(package_path)?;
    Ok(OfflineImportPlan { driver_keys: vec![info.db_type], includes_jre: false })
}

async fn import_tar_zstd_driver_package(
    am: &AgentManager,
    package_path: &Path,
    progress: impl Fn(OfflineImportProgress),
) -> Result<OfflineImportResult, String> {
    let _installation_guard = am.installation_operation_lock.write().await;
    let info = tar_zstd_driver_package_info(package_path)?;
    let mut result =
        OfflineImportResult { jre_installed: Vec::new(), drivers_installed: Vec::new(), drivers_skipped: Vec::new() };
    if let Some(installed) = am.load_state().installed_drivers.get(&info.db_type) {
        if installed.version != "0.1.0-local"
            && installed.version != "local"
            && !crate::update::is_newer_version(&info.version, &installed.version)
        {
            result.drivers_skipped.push(info.db_type);
            return Ok(result);
        }
    }

    progress(OfflineImportProgress {
        step: "driver".to_string(),
        current: 1,
        total: 1,
        label: agent_catalog::label_for_key(&info.db_type).unwrap_or(&info.db_type).to_string(),
        db_type: Some(info.db_type.clone()),
    });
    let target_path = match info.kind {
        DriverArtifactKind::Jar => am.driver_jar_path(&info.db_type),
        DriverArtifactKind::Native if AgentManager::is_sqlite_worker_driver(&info.db_type) => {
            let platform = info
                .native_platform
                .as_deref()
                .ok_or_else(|| "SQLite SSH worker package is missing its Linux platform".to_string())?;
            am.driver_native_platform_path(&info.db_type, platform)
        }
        DriverArtifactKind::Native => am.driver_native_path(&info.db_type),
    };
    install_driver_from_tar_zstd_package(
        package_path,
        &target_path,
        info.kind,
        &info.db_type,
        &info.version,
        info.native_platform.as_deref(),
    )?;
    match info.kind {
        DriverArtifactKind::Jar => {
            std::fs::remove_file(am.driver_native_path(&info.db_type)).ok();
        }
        DriverArtifactKind::Native => {
            std::fs::remove_file(am.driver_jar_path(&info.db_type)).ok();
        }
    }
    let record_install =
        !AgentManager::is_sqlite_worker_driver(&info.db_type) || am.driver_native_installed(&info.db_type);
    if record_install {
        am.mutate_state(|state| {
            state.installed_drivers.insert(
                info.db_type.clone(),
                InstalledDriver {
                    version: info.version.clone(),
                    installed_at: chrono::Utc::now().to_rfc3339(),
                    jre: info.jre.clone(),
                },
            );
        })?;
    }
    am.stop_daemon_by_key(&info.db_type).await;
    result.drivers_installed.push(info.db_type);
    Ok(result)
}

fn tar_zstd_driver_package_info(package_path: &Path) -> Result<TarZstdDriverPackageInfo, String> {
    let registry = read_registry_from_tar_zstd(package_path)?;
    if registry.drivers.len() != 1 {
        return Err("A tar.zst driver package must contain exactly one driver".to_string());
    }
    let (db_type, driver) = registry.drivers.iter().next().expect("checked one driver");
    validate_offline_driver_key(db_type)?;
    let current_platform = AgentManager::current_platform();
    let (native_platform, native_artifact) = if let Some(artifact) = driver.native.get(current_platform) {
        (Some(current_platform.to_string()), Some(artifact))
    } else if driver.native.len() == 1 {
        let (platform, artifact) = driver.native.iter().next().expect("checked one native platform");
        (Some(platform.clone()), Some(artifact))
    } else {
        (None, None)
    };
    let jar_artifact = usable_driver_jar(driver);
    let (kind, artifact) = match (native_artifact, jar_artifact) {
        (Some(_), Some(_)) => {
            return Err("A tar.zst driver package must contain exactly one driver artifact".to_string());
        }
        (Some(artifact), None) => (DriverArtifactKind::Native, artifact),
        (None, Some(artifact)) => (DriverArtifactKind::Jar, artifact),
        (None, None) if !driver.native.is_empty() => {
            return Err(format!("Driver package does not support platform: {current_platform}"));
        }
        (None, None) => return Err("A tar.zst driver package contains no driver artifact".to_string()),
    };
    if artifact.format.is_some() {
        return Err("Nested driver packages are not supported".to_string());
    }
    let artifact_filename = artifact
        .url
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("Invalid packaged driver URL: {}", artifact.url))?;
    let entry_name = format!("drivers/{artifact_filename}");
    validate_tar_zstd_package_entries(package_path, &entry_name, artifact.size)?;
    Ok(TarZstdDriverPackageInfo {
        db_type: db_type.clone(),
        version: driver.version.clone(),
        jre: driver.jre.clone(),
        kind,
        native_platform: native_platform.filter(|_| kind == DriverArtifactKind::Native),
        entry_name,
        size: artifact.size,
    })
}

fn validate_tar_zstd_package_entries(
    package_path: &Path,
    expected_entry: &str,
    expected_size: u64,
) -> Result<(), String> {
    let file = std::fs::File::open(package_path).map_err(|error| format!("Failed to open driver package: {error}"))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|error| format!("Failed to open zstd driver package: {error}"))?;
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|error| format!("Invalid tar.zst driver package: {error}"))?;
    let mut registry_seen = false;
    let mut driver_seen = false;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Invalid tar.zst driver package entry: {error}"))?;
        let path = entry.path().map_err(|error| format!("Invalid driver package path: {error}"))?;
        let name = safe_archive_entry_name(&path)?;
        if entry.header().entry_type().is_dir() {
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err(format!("Driver package contains a non-regular entry: {name}"));
        }
        match name.as_str() {
            "agent-registry.json" if !registry_seen => registry_seen = true,
            value if value == expected_entry && !driver_seen => {
                if expected_size > 0 && entry.size() != expected_size {
                    return Err(format!(
                        "Packaged driver size mismatch: expected {expected_size} bytes, got {} bytes",
                        entry.size()
                    ));
                }
                driver_seen = true;
            }
            _ => return Err(format!("Unexpected file in driver package: {name}")),
        }
    }
    if !registry_seen {
        return Err("agent-registry.json not found in the driver package".to_string());
    }
    if !driver_seen {
        return Err(format!("Driver package entry not found: {expected_entry}"));
    }
    Ok(())
}

pub fn inspect_offline_zip(zip_path: &Path) -> Result<OfflineImportPlan, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("Failed to open ZIP file: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP file: {e}"))?;
    let registry = read_registry_from_zip(&mut archive)?;
    let (jre_entries, driver_entries) = collect_offline_entries(&mut archive, &registry)?;
    validate_offline_zip_preflight(&mut archive, &registry, &jre_entries, &driver_entries)?;
    Ok(OfflineImportPlan {
        driver_keys: driver_entries.into_iter().map(|(db_type, _, _)| db_type).collect(),
        includes_jre: !jre_entries.is_empty(),
    })
}

pub async fn import_offline_zip(
    am: &AgentManager,
    zip_path: &Path,
    progress: impl Fn(OfflineImportProgress),
) -> Result<OfflineImportResult, String> {
    // Offline import can touch both JRE and driver directories — hold an
    // exclusive installation-operation lock so that concurrent driver installs,
    // JRE installs, Upgrade All, and uninstall operations are serialised.
    let _installation_guard = am.installation_operation_lock.write().await;

    let file = std::fs::File::open(zip_path).map_err(|e| format!("Failed to open ZIP file: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP file: {e}"))?;

    let registry = read_registry_from_zip(&mut archive)?;

    let platform = AgentManager::current_platform();
    let (jre_entries, driver_entries) = collect_offline_entries(&mut archive, &registry)?;

    let total = (jre_entries.len() + driver_entries.len()) as u32;
    if total == 0 {
        return Err(format!("Offline package contains no drivers compatible with platform: {platform}"));
    }
    validate_offline_zip_preflight(&mut archive, &registry, &jre_entries, &driver_entries)?;
    std::fs::create_dir_all(am.base_dir()).map_err(|e| format!("Failed to create agent directory: {e}"))?;
    validate_offline_driver_entries(am, &mut archive, &driver_entries)?;
    let mut local_state = am.load_state();
    let mut result =
        OfflineImportResult { jre_installed: Vec::new(), drivers_installed: Vec::new(), drivers_skipped: Vec::new() };
    let mut current: u32 = 0;

    for (jre_key, entry_name, format) in &jre_entries {
        current += 1;
        let jre_version = registry.resolve_jre(jre_key).map(|j| j.version.clone());
        let existing_version = local_state.jre_versions.get(jre_key);
        if am.is_jre_installed(jre_key) && existing_version == jre_version.as_ref() {
            continue;
        }

        progress(OfflineImportProgress {
            step: "jre-extract".into(),
            current,
            total,
            label: format!("JRE {jre_key}"),
            db_type: None,
        });

        let mut entry = archive.by_name(entry_name).map_err(|e| format!("Failed to read {entry_name}: {e}"))?;
        let tmp_archive = am.base_dir().join(format!("jre-offline-{jre_key}{}", jre_archive_suffix(*format)));
        {
            let mut out =
                std::fs::File::create(&tmp_archive).map_err(|e| format!("Failed to create temp file: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("Failed to extract JRE archive: {e}"))?;
        }

        let jre_dir = am.jre_dir(jre_key);
        let staging_dir = am.base_dir().join(format!(".jre-offline-import-{}", uuid::Uuid::new_v4()));
        if let Err(error) = extract_jre_archive(&tmp_archive, &staging_dir, *format) {
            std::fs::remove_dir_all(&staging_dir).ok();
            std::fs::remove_file(&tmp_archive).ok();
            return Err(error);
        }
        if !jre_dir_contains_java(&staging_dir) {
            std::fs::remove_dir_all(&staging_dir).ok();
            std::fs::remove_file(&tmp_archive).ok();
            return Err(format!("Offline JRE archive does not contain a Java executable: {entry_name}"));
        }
        let pending_cleanup = replace_imported_jre_dir(&staging_dir, &jre_dir)?;
        std::fs::remove_file(&tmp_archive).ok();
        if let Some(path) = pending_cleanup {
            local_state.pending_jre_cleanup.push(path);
        }

        if let Some(ver) = jre_version {
            local_state.jre_versions.insert(jre_key.clone(), ver);
        }
        result.jre_installed.push(jre_key.clone());
    }

    for (db_type, entry_name, is_native) in &driver_entries {
        current += 1;

        if let Some(remote_driver) = registry.drivers.get(db_type) {
            if let Some(installed) = local_state.installed_drivers.get(db_type) {
                if installed.version != "0.1.0-local"
                    && installed.version != "local"
                    && !crate::update::is_newer_version(&remote_driver.version, &installed.version)
                {
                    result.drivers_skipped.push(db_type.clone());
                    continue;
                }
            }
        }

        progress(OfflineImportProgress {
            step: "driver".into(),
            current,
            total,
            label: agent_catalog::label_for_key(db_type).unwrap_or(db_type).to_string(),
            db_type: Some(db_type.clone()),
        });

        let driver_path = if *is_native { am.driver_native_path(db_type) } else { am.driver_jar_path(db_type) };
        if let Some(parent) = driver_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut entry = archive.by_name(entry_name).map_err(|e| format!("Failed to read {entry_name}: {e}"))?;
        let parent = driver_path.parent().ok_or_else(|| format!("Invalid driver path: {}", driver_path.display()))?;
        let staging_path = parent.join(format!(".offline-agent-import-{}", uuid::Uuid::new_v4()));
        let mut out = std::fs::File::create(&staging_path).map_err(|e| format!("Failed to write driver: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Failed to copy driver: {e}"))?;
        drop(out);
        if *is_native {
            if let Err(error) = validate_native_agent_binary(&staging_path) {
                std::fs::remove_file(&staging_path).ok();
                return Err(error);
            }
            mark_executable(&staging_path)?;
        } else {
            // Validate the staged JAR before replacing a working driver so a
            // corrupt offline package cannot destroy the previous installation.
            if !is_valid_agent_jar(&staging_path) {
                std::fs::remove_file(&staging_path).ok();
                return Err(format!("Offline agent jar is invalid or corrupt: {entry_name}"));
            }
        }
        replace_imported_agent_file(&staging_path, &driver_path)?;
        if *is_native {
            std::fs::remove_file(am.driver_jar_path(db_type)).ok();
        } else {
            std::fs::remove_file(am.driver_native_path(db_type)).ok();
        }

        let version = registry.drivers.get(db_type).map(|d| d.version.clone()).unwrap_or_else(|| "local".to_string());
        let jre_key =
            registry.drivers.get(db_type).map(|d| d.jre.clone()).unwrap_or_else(|| DEFAULT_JRE_KEY.to_string());

        local_state.installed_drivers.insert(
            db_type.clone(),
            InstalledDriver { version, installed_at: chrono::Utc::now().to_rfc3339(), jre: jre_key },
        );
        result.drivers_installed.push(db_type.clone());
    }

    am.mutate_state(|state| {
        for jre_key in &result.jre_installed {
            if let Some(version) = local_state.jre_versions.get(jre_key) {
                state.jre_versions.insert(jre_key.clone(), version.clone());
            }
        }
        for path in &local_state.pending_jre_cleanup {
            if !state.pending_jre_cleanup.contains(path) {
                state.pending_jre_cleanup.push(path.clone());
            }
        }
        for db_type in &result.drivers_installed {
            if let Some(driver) = local_state.installed_drivers.get(db_type) {
                state.installed_drivers.insert(db_type.clone(), driver.clone());
            }
        }
    })?;
    Ok(result)
}

fn collect_offline_entries(
    archive: &mut zip::ZipArchive<std::fs::File>,
    registry: &AgentRegistry,
) -> Result<OfflineArchiveEntries, String> {
    let platform = AgentManager::current_platform();
    let mut jres = std::collections::BTreeMap::<String, (String, Option<ArtifactFormat>)>::new();
    let mut drivers = std::collections::BTreeMap::<String, (String, bool)>::new();

    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|e| format!("Failed to inspect ZIP entry: {e}"))?;
        let Some(path) = entry.enclosed_name() else {
            return Err(format!("Offline package contains an unsafe path: {}", entry.name()));
        };
        let name = path.to_string_lossy().replace('\\', "/");
        if name.starts_with("jre/") {
            let jre_format = if name.ends_with(".tar.zst") {
                Some(ArtifactFormat::TarZstd)
            } else if name.ends_with(".tar.gz") {
                None
            } else {
                continue;
            };
            let Some(jre_key) = jre_key_for_offline_entry(registry, platform, &name)
                .or_else(|| name.contains(platform).then(|| extract_jre_key_from_filename(&name)).flatten())
            else {
                continue;
            };
            validate_offline_identifier(&jre_key, "JRE")?;
            let replace = !jres.contains_key(&jre_key) || jre_format == Some(ArtifactFormat::TarZstd);
            if replace {
                jres.insert(jre_key, (name, jre_format));
            }
        } else if name.starts_with("drivers/") && name.ends_with(".jar") {
            let db_type = db_type_for_jar_offline_entry(registry, &name)
                .or_else(|| extract_db_type_from_filename(&name))
                .ok_or_else(|| format!("Unable to identify offline driver: {name}"))?;
            validate_offline_driver_key(&db_type)?;
            drivers.entry(db_type).or_insert((name, false));
        } else if name.starts_with("drivers/") {
            if let Some(db_type) = db_type_for_native_offline_entry(registry, platform, &name) {
                validate_offline_driver_key(&db_type)?;
                // Prefer the native artifact when a package contains both the
                // platform executable and a Java fallback for the same driver.
                drivers.insert(db_type, (name, true));
            }
        }
    }

    Ok((
        jres.into_iter().map(|(jre_key, (name, format))| (jre_key, name, format)).collect(),
        drivers.into_iter().map(|(db_type, (name, is_native))| (db_type, name, is_native)).collect(),
    ))
}

fn validate_offline_zip_preflight(
    archive: &mut zip::ZipArchive<std::fs::File>,
    registry: &AgentRegistry,
    jre_entries: &[OfflineJreEntry],
    driver_entries: &[OfflineDriverEntry],
) -> Result<(), String> {
    let platform = AgentManager::current_platform();
    let has_jre_artifact_metadata =
        registry.jre.iter().chain(registry.jres.values()).any(|jre| !jre.platforms.is_empty());
    let packaged_jres = jre_entries.iter().map(|(key, _, _)| key.as_str()).collect::<std::collections::BTreeSet<_>>();

    for (jre_key, entry_name, format) in jre_entries {
        if let Some(artifact) = registry.resolve_jre(jre_key).and_then(|jre| jre.platforms.get(platform)) {
            if artifact.format != *format {
                return Err(format!("Offline JRE {jre_key} archive format does not match its registry metadata"));
            }
            validate_offline_zip_artifact(archive, entry_name, artifact, &format!("JRE {jre_key}"))?;
        }
    }

    for (db_type, entry_name, is_native) in driver_entries {
        let Some(driver) = registry.drivers.get(db_type) else {
            // Older locally assembled ZIPs can identify a JAR solely from its
            // canonical filename. Preserve that import path when no registry
            // artifact metadata exists to validate.
            continue;
        };
        let artifact = if *is_native {
            driver.native.get(platform)
        } else {
            let jre_key = driver.jre.trim();
            if !jre_key.is_empty() {
                if let Some(jre) = registry.resolve_jre(jre_key) {
                    if !jre.platforms.is_empty() && !jre.platforms.contains_key(platform) {
                        return Err(format!(
                            "Offline Java driver {db_type} requires JRE {jre_key}, which does not support the current platform: {platform}"
                        ));
                    }
                    if !jre.platforms.is_empty() && !packaged_jres.contains(jre_key) {
                        return Err(format!(
                            "Offline Java driver {db_type} requires JRE {jre_key}, but the current-platform JRE artifact is missing"
                        ));
                    }
                } else if has_jre_artifact_metadata {
                    return Err(format!(
                        "Offline Java driver {db_type} requires JRE {jre_key}, but that JRE is missing from the package registry"
                    ));
                }
            }
            driver.jar.as_ref()
        };
        if let Some(artifact) = artifact {
            validate_offline_zip_artifact(archive, entry_name, artifact, &format!("driver {db_type}"))?;
        }
    }
    Ok(())
}

fn validate_offline_zip_artifact(
    archive: &mut zip::ZipArchive<std::fs::File>,
    entry_name: &str,
    artifact: &ArtifactInfo,
    label: &str,
) -> Result<(), String> {
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|error| format!("Failed to read offline {label} artifact {entry_name}: {error}"))?;
    if !entry.is_file() {
        return Err(format!("Offline {label} artifact is not a regular file: {entry_name}"));
    }
    if artifact.size > 0 && entry.size() != artifact.size {
        return Err(format!(
            "Offline {label} artifact size mismatch: expected {} bytes, got {} bytes",
            artifact.size,
            entry.size()
        ));
    }
    let Some(expected_sha256) = normalized_sha256(artifact.sha256.as_deref())? else {
        return Ok(());
    };
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = entry
            .read(&mut buffer)
            .map_err(|error| format!("Failed to hash offline {label} artifact {entry_name}: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let actual_sha256 = format!("{:x}", digest.finalize());
    if actual_sha256.eq_ignore_ascii_case(expected_sha256) {
        Ok(())
    } else {
        Err(format!("Offline {label} artifact SHA-256 mismatch: expected {expected_sha256}, got {actual_sha256}"))
    }
}

fn validate_offline_driver_entries(
    am: &AgentManager,
    archive: &mut zip::ZipArchive<std::fs::File>,
    driver_entries: &[OfflineDriverEntry],
) -> Result<(), String> {
    for (_, entry_name, is_native) in driver_entries {
        let staging_path = am.base_dir().join(format!(".offline-agent-validation-{}", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut entry = archive.by_name(entry_name).map_err(|e| format!("Failed to read {entry_name}: {e}"))?;
            let mut out = std::fs::File::create(&staging_path).map_err(|e| format!("Failed to write driver: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("Failed to copy driver: {e}"))?;
            drop(out);
            if *is_native {
                validate_native_agent_binary(&staging_path)
            } else if is_valid_agent_jar(&staging_path) {
                Ok(())
            } else {
                Err(format!("Offline agent jar is invalid or corrupt: {entry_name}"))
            }
        })();
        std::fs::remove_file(&staging_path).ok();
        result?;
    }
    Ok(())
}

fn validate_offline_driver_key(db_type: &str) -> Result<(), String> {
    validate_offline_identifier(db_type, "driver")?;
    if agent_catalog::label_for_key(db_type).is_none() {
        return Err(format!("Offline package contains an unknown driver type: {db_type}"));
    }
    Ok(())
}

fn validate_offline_identifier(value: &str, kind: &str) -> Result<(), String> {
    if value.is_empty()
        || matches!(value, "." | "..")
        || !value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
    {
        return Err(format!("Offline package contains an invalid {kind} identifier: {value}"));
    }
    Ok(())
}

fn read_registry_from_zip(archive: &mut zip::ZipArchive<std::fs::File>) -> Result<AgentRegistry, String> {
    let mut entry = archive
        .by_name("agent-registry.json")
        .map_err(|_| "agent-registry.json not found in the ZIP; not a valid offline driver package.".to_string())?;
    let mut buf = String::new();
    entry.read_to_string(&mut buf).map_err(|e| format!("Failed to read agent-registry.json: {e}"))?;
    serde_json::from_str(&buf).map_err(|e| format!("Invalid agent-registry.json: {e}"))
}

fn extract_jre_key_from_filename(name: &str) -> Option<String> {
    let filename = name.rsplit('/').next()?;
    let rest = filename.strip_prefix("dbx-jre-").or_else(|| filename.strip_prefix("jre-"))?;
    let key = rest.split('-').next()?;
    if key.is_empty() {
        return None;
    }
    Some(key.to_string())
}

fn jre_key_for_offline_entry(registry: &AgentRegistry, platform: &str, name: &str) -> Option<String> {
    let filename = name.rsplit('/').next()?;
    let registry_match = registry.jres.iter().find_map(|(key, jre)| {
        let artifact = jre.platforms.get(platform)?;
        (artifact.url.rsplit('/').next()? == filename).then(|| key.clone())
    });
    if registry_match.is_some() {
        return registry_match;
    }
    if registry.jres.is_empty() {
        let artifact = registry.jre.as_ref()?.platforms.get(platform)?;
        if artifact.url.rsplit('/').next()? == filename {
            return Some(DEFAULT_JRE_KEY.to_string());
        }
    }
    None
}

fn extract_db_type_from_filename(name: &str) -> Option<String> {
    let filename = name.rsplit('/').next()?;
    let rest = filename.strip_prefix("dbx-agent-")?;
    let db_type = rest.strip_suffix(".jar")?;
    if db_type.is_empty() {
        return None;
    }
    Some(db_type.to_string())
}

fn db_type_for_native_offline_entry(registry: &AgentRegistry, platform: &str, name: &str) -> Option<String> {
    let filename = name.rsplit('/').next()?;
    registry.drivers.iter().find_map(|(db_type, driver)| {
        let artifact = driver.native.get(platform)?;
        let artifact_filename = artifact.url.rsplit('/').next()?;
        (artifact_filename == filename).then(|| db_type.clone())
    })
}

fn db_type_for_jar_offline_entry(registry: &AgentRegistry, name: &str) -> Option<String> {
    let filename = name.rsplit('/').next()?;
    registry.drivers.iter().find_map(|(db_type, driver)| {
        let artifact = driver.jar.as_ref()?;
        let artifact_filename = artifact.url.rsplit('/').next()?;
        (artifact_filename == filename).then(|| db_type.clone())
    })
}

fn jre_archive_suffix(format: Option<ArtifactFormat>) -> &'static str {
    match format {
        Some(ArtifactFormat::TarZstd) => ".tar.zst",
        None => ".tar.gz",
    }
}

fn jre_archive_download_path(am: &AgentManager, jre_key: &str, format: Option<ArtifactFormat>) -> PathBuf {
    am.base_dir().join(format!("jre-{jre_key}-download{}", jre_archive_suffix(format)))
}

fn extract_jre_archive(archive: &Path, dest: &Path, format: Option<ArtifactFormat>) -> Result<(), String> {
    match format {
        Some(ArtifactFormat::TarZstd) => {
            let file = std::fs::File::open(archive).map_err(|e| format!("Failed to open JRE archive: {e}"))?;
            let decoder =
                zstd::stream::read::Decoder::new(file).map_err(|e| format!("Failed to open zstd JRE archive: {e}"))?;
            extract_jre_tar(tar::Archive::new(decoder), dest)
        }
        None => extract_tar_gz(archive, dest),
    }
}

fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Failed to open JRE archive: {e}"))?;
    let decoder = flate2::read::GzDecoder::new(file);
    extract_jre_tar(tar::Archive::new(decoder), dest)
}

fn extract_jre_tar<R: Read>(mut archive: tar::Archive<R>, dest: &Path) -> Result<(), String> {
    let parent = dest.parent().ok_or_else(|| format!("Invalid JRE destination: {}", dest.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create JRE directory: {e}"))?;

    let staging = tempfile::Builder::new()
        .prefix(".jre-extract-")
        .tempdir_in(parent)
        .map_err(|e| format!("Failed to create JRE extraction directory: {e}"))?;
    archive.unpack(staging.path()).map_err(|e| format!("Failed to extract JRE archive: {e}"))?;

    let mut roots = std::fs::read_dir(staging.path())
        .map_err(|e| format!("Failed to inspect extracted JRE archive: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to inspect extracted JRE archive: {e}"))?;
    if roots.len() != 1 {
        return Err("Invalid JRE archive: expected a single top-level directory".to_string());
    }

    let root = roots.pop().expect("root count checked above");
    if !root.file_type().map_err(|e| format!("Failed to inspect extracted JRE archive: {e}"))?.is_dir() {
        return Err("Invalid JRE archive: expected a top-level directory".to_string());
    }

    std::fs::create_dir_all(dest).map_err(|e| format!("Failed to create JRE directory: {e}"))?;
    for entry in std::fs::read_dir(root.path()).map_err(|e| format!("Failed to inspect extracted JRE archive: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to inspect extracted JRE archive: {e}"))?;
        std::fs::rename(entry.path(), dest.join(entry.file_name()))
            .map_err(|e| format!("Failed to install extracted JRE: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod jre_archive_tests {
    use super::*;
    use std::io::Cursor;

    fn append_file(
        builder: &mut tar::Builder<flate2::write::GzEncoder<std::fs::File>>,
        path: &str,
        data: &[u8],
        mode: u32,
    ) {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(mode);
        header.set_cksum();
        builder.append_data(&mut header, path, Cursor::new(data)).unwrap();
    }

    #[test]
    fn extracts_jre_archive_without_system_tools_and_strips_top_level_directory() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("jre.tar.gz");
        let encoder = flate2::write::GzEncoder::new(
            std::fs::File::create(&archive_path).unwrap(),
            flate2::Compression::default(),
        );
        let mut builder = tar::Builder::new(encoder);
        append_file(&mut builder, "jdk-21/bin/java", b"java", 0o755);
        append_file(&mut builder, "jdk-21/conf/release", b"JAVA_VERSION=21", 0o644);
        builder.into_inner().unwrap().finish().unwrap();

        let dest = temp.path().join("managed-jre");
        extract_tar_gz(&archive_path, &dest).unwrap();

        assert_eq!(std::fs::read(dest.join("bin/java")).unwrap(), b"java");
        assert_eq!(std::fs::read(dest.join("conf/release")).unwrap(), b"JAVA_VERSION=21");
        assert!(!dest.join("jdk-21").exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dest.join("bin/java")).unwrap().permissions().mode() & 0o777, 0o755);
        }
    }

    #[test]
    fn rejects_jre_archive_without_a_single_top_level_directory() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("jre.tar.gz");
        let encoder = flate2::write::GzEncoder::new(
            std::fs::File::create(&archive_path).unwrap(),
            flate2::Compression::default(),
        );
        let mut builder = tar::Builder::new(encoder);
        append_file(&mut builder, "jdk-21/bin/java", b"java", 0o755);
        append_file(&mut builder, "unexpected/readme.txt", b"unexpected", 0o644);
        builder.into_inner().unwrap().finish().unwrap();

        let error = extract_tar_gz(&archive_path, &temp.path().join("managed-jre")).unwrap_err();
        assert!(error.contains("single top-level directory"), "unexpected error: {error}");
    }
}

pub async fn import_agent_driver(am: &AgentManager, db_type: &str, source_path: &Path) -> Result<(), String> {
    // Manual imports replace the same artifact paths as downloads. Reuse the
    // install operation and per-driver locks so an import cannot race an
    // install, Upgrade All, or uninstall for this driver.
    let _installation_guard = am.installation_operation_lock.read().await;
    let driver_lock = driver_operation_lock(am, db_type);
    let _driver_guard = driver_lock.lock().await;

    if !source_path.is_file() {
        return Err(format!("File not found: {}", source_path.display()));
    }

    if source_path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("jar")) {
        install_local_agent(am, db_type, source_path.to_path_buf())?;
        std::fs::remove_file(am.driver_native_path(db_type)).ok();
        return Ok(());
    }

    validate_native_agent_binary(source_path)?;
    let native_path = am.driver_native_path(db_type);
    let parent = native_path.parent().ok_or_else(|| format!("Invalid driver path: {}", native_path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let staging_path = parent.join(format!(".agent-import-{}", uuid::Uuid::new_v4()));
    std::fs::copy(source_path, &staging_path).map_err(|e| format!("Failed to copy native agent: {e}"))?;
    mark_executable(&staging_path)?;
    replace_imported_agent_file(&staging_path, &native_path)?;
    std::fs::remove_file(am.driver_jar_path(db_type)).ok();

    am.mutate_state(|state| {
        state.installed_drivers.insert(
            db_type.to_string(),
            InstalledDriver {
                version: "0.1.0-local".to_string(),
                installed_at: chrono::Utc::now().to_rfc3339(),
                jre: DEFAULT_JRE_KEY.to_string(),
            },
        );
    })
}

pub async fn import_agent_jar(am: &AgentManager, db_type: &str, jar_path: &Path) -> Result<(), String> {
    import_agent_driver(am, db_type, jar_path).await
}

fn replace_imported_agent_file(staging_path: &Path, target_path: &Path) -> Result<(), String> {
    let backup_path = target_path.with_file_name(format!(
        ".{}-backup-{}",
        target_path.file_name().and_then(|name| name.to_str()).unwrap_or("agent"),
        uuid::Uuid::new_v4()
    ));
    let had_existing = target_path.exists();
    if had_existing {
        std::fs::rename(target_path, &backup_path).map_err(|e| format!("Failed to replace existing agent: {e}"))?;
    }
    if let Err(error) = std::fs::rename(staging_path, target_path) {
        if had_existing {
            let _ = std::fs::rename(&backup_path, target_path);
        }
        let _ = std::fs::remove_file(staging_path);
        return Err(format!("Failed to install agent: {error}"));
    }
    if had_existing {
        std::fs::remove_file(backup_path).ok();
    }
    Ok(())
}

fn replace_imported_jre_dir(staging_dir: &Path, target_dir: &Path) -> Result<Option<PathBuf>, String> {
    let backup_dir = target_dir.with_file_name(format!(
        ".{}-backup-{}",
        target_dir.file_name().and_then(|name| name.to_str()).unwrap_or("jre"),
        uuid::Uuid::new_v4()
    ));
    let had_existing = target_dir.exists();
    if had_existing {
        std::fs::rename(target_dir, &backup_dir).map_err(|error| {
            let _ = std::fs::remove_dir_all(staging_dir);
            format!("Failed to replace existing JRE: {error}")
        })?;
    }
    if let Err(error) = std::fs::rename(staging_dir, target_dir) {
        if had_existing {
            let _ = std::fs::rename(&backup_dir, target_dir);
        }
        let _ = std::fs::remove_dir_all(staging_dir);
        return Err(format!("Failed to install JRE: {error}"));
    }
    if had_existing && remove_jre_dir_with_retry(&backup_dir).is_err() {
        // The new runtime is already installed. Keep the old directory for
        // startup cleanup rather than turning a successful import into an error.
        return Ok(Some(backup_dir));
    }
    Ok(None)
}

fn jre_dir_contains_java(path: &Path) -> bool {
    let java_name = if cfg!(windows) { "java.exe" } else { "java" };
    path.join("bin").join(java_name).is_file()
        || path.join("Contents").join("Home").join("bin").join(java_name).is_file()
}

pub(crate) fn validate_native_agent_binary(path: &Path) -> Result<(), String> {
    validate_native_agent_binary_for_platform(path, AgentManager::current_platform())
}

pub(crate) fn validate_native_agent_binary_for_platform(path: &Path, platform: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("Failed to read native agent: {e}"))?;
    let mut magic = [0_u8; 4];
    file.read_exact(&mut magic).map_err(|e| format!("Failed to read native agent header: {e}"))?;
    let valid = match platform {
        "linux-x64" => is_elf_binary_for_machine(&mut file, &magic, 62),
        "linux-aarch64" => is_elf_binary_for_machine(&mut file, &magic, 183),
        "macos-x64" => is_macho_binary_for_cpu(&mut file, &magic, 0x0100_0007),
        "macos-aarch64" => is_macho_binary_for_cpu(&mut file, &magic, 0x0100_000c),
        "windows-x64" => is_windows_binary_for_machine(&mut file, &magic, 0x8664),
        "windows-aarch64" => is_windows_binary_for_machine(&mut file, &magic, 0xaa64),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("The selected file is not a {platform} native agent"))
    }
}

fn is_elf_binary_for_machine(file: &mut std::fs::File, magic: &[u8; 4], expected_machine: u16) -> bool {
    if magic != b"\x7fELF" || file.seek(SeekFrom::Start(4)).is_err() {
        return false;
    }
    let mut header = [0_u8; 16];
    if file.read_exact(&mut header).is_err() || header[0] != 2 {
        return false;
    }
    let machine = match header[1] {
        1 => u16::from_le_bytes([header[14], header[15]]),
        2 => u16::from_be_bytes([header[14], header[15]]),
        _ => return false,
    };
    machine == expected_machine
}

fn is_macho_binary_for_cpu(file: &mut std::fs::File, magic: &[u8; 4], expected: u32) -> bool {
    let thin_endian = match magic {
        [0xce, 0xfa, 0xed, 0xfe] | [0xcf, 0xfa, 0xed, 0xfe] => Some(true),
        [0xfe, 0xed, 0xfa, 0xce] | [0xfe, 0xed, 0xfa, 0xcf] => Some(false),
        _ => None,
    };
    if let Some(little_endian) = thin_endian {
        if file.seek(SeekFrom::Start(4)).is_err() {
            return false;
        }
        let mut cpu_type = [0_u8; 4];
        if file.read_exact(&mut cpu_type).is_err() {
            return false;
        }
        let cpu_type = if little_endian { u32::from_le_bytes(cpu_type) } else { u32::from_be_bytes(cpu_type) };
        return cpu_type == expected;
    }

    let (little_endian, arch_size) = match magic {
        [0xca, 0xfe, 0xba, 0xbe] => (false, 20_u64),
        [0xbe, 0xba, 0xfe, 0xca] => (true, 20_u64),
        [0xca, 0xfe, 0xba, 0xbf] => (false, 32_u64),
        [0xbf, 0xba, 0xfe, 0xca] => (true, 32_u64),
        _ => return false,
    };
    if file.seek(SeekFrom::Start(4)).is_err() {
        return false;
    }
    let mut count = [0_u8; 4];
    if file.read_exact(&mut count).is_err() {
        return false;
    }
    let count = if little_endian { u32::from_le_bytes(count) } else { u32::from_be_bytes(count) };
    // A real universal binary has only a handful of slices; cap the count so
    // a malformed header cannot trigger unbounded seeks during import.
    if count == 0 || count > 64 {
        return false;
    }
    for index in 0..count {
        if file.seek(SeekFrom::Start(8 + u64::from(index) * arch_size)).is_err() {
            return false;
        }
        let mut cpu_type = [0_u8; 4];
        if file.read_exact(&mut cpu_type).is_err() {
            return false;
        }
        let cpu_type = if little_endian { u32::from_le_bytes(cpu_type) } else { u32::from_be_bytes(cpu_type) };
        if cpu_type == expected {
            return true;
        }
    }
    false
}

fn is_windows_binary_for_machine(file: &mut std::fs::File, magic: &[u8; 4], expected_machine: u16) -> bool {
    if &magic[..2] != b"MZ" || file.seek(SeekFrom::Start(0x3c)).is_err() {
        return false;
    }
    let mut pe_offset = [0_u8; 4];
    if file.read_exact(&mut pe_offset).is_err()
        || file.seek(SeekFrom::Start(u32::from_le_bytes(pe_offset) as u64)).is_err()
    {
        return false;
    }
    let mut pe_header = [0_u8; 6];
    if file.read_exact(&mut pe_header).is_err() || &pe_header[..4] != b"PE\0\0" {
        return false;
    }
    let machine = u16::from_le_bytes([pe_header[4], pe_header[5]]);
    machine == expected_machine
}

// ──────────── Tests ────────────

#[cfg(test)]
mod agent_download_url_tests {
    use super::*;

    #[test]
    fn r2_cache_buster_uses_version_query() {
        assert_eq!(
            r2_path_with_cache_buster("agents/jre/dbx-jre-21-macos-x64.tar.gz", "21.0.11+7"),
            "agents/jre/dbx-jre-21-macos-x64.tar.gz?v=21.0.11-7"
        );
    }

    #[test]
    fn r2_cache_buster_preserves_existing_query() {
        assert_eq!(
            r2_path_with_cache_buster("agents/drivers/dbx-agent-h2.jar?mirror=r2", "0.5.33"),
            "agents/drivers/dbx-agent-h2.jar?mirror=r2&v=0.5.33"
        );
    }

    #[test]
    fn offline_jre_filename_parser_accepts_release_and_legacy_names() {
        assert_eq!(extract_jre_key_from_filename("jre/dbx-jre-21-macos-aarch64.tar.gz").as_deref(), Some("21"));
        assert_eq!(extract_jre_key_from_filename("jre/jre-21-macos-aarch64.tar.gz").as_deref(), Some("21"));
    }

    #[test]
    fn windows_native_header_validator_checks_cpu_architecture() {
        let path = std::env::temp_dir().join(format!("dbx-agent-pe-test-{}", uuid::Uuid::new_v4()));
        let expected_machine = if cfg!(target_arch = "aarch64") { 0xaa64_u16 } else { 0x8664_u16 };
        let wrong_machine = if expected_machine == 0xaa64 { 0x8664_u16 } else { 0xaa64_u16 };

        std::fs::write(&path, test_pe_binary(expected_machine)).unwrap();
        let mut file = std::fs::File::open(&path).unwrap();
        assert!(is_windows_binary_for_machine(&mut file, b"MZ\0\0", expected_machine));

        std::fs::write(&path, test_pe_binary(wrong_machine)).unwrap();
        let mut file = std::fs::File::open(&path).unwrap();
        assert!(!is_windows_binary_for_machine(&mut file, b"MZ\0\0", expected_machine));
        std::fs::remove_file(path).ok();
    }

    fn test_pe_binary(machine: u16) -> Vec<u8> {
        let mut bytes = vec![0_u8; 0x48];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&(0x40_u32).to_le_bytes());
        bytes[0x40..0x44].copy_from_slice(b"PE\0\0");
        bytes[0x44..0x46].copy_from_slice(&machine.to_le_bytes());
        bytes
    }
}

#[cfg(test)]
mod agent_registry_install_tests {
    use super::*;
    use crate::agent_manager::{ArtifactFormat, ArtifactInfo, DriverInfo, InstalledDriver, JavaRuntimeConfig, JreInfo};

    static ENSURE_AGENT_TEST_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
        std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

    fn test_manager(name: &str) -> AgentManager {
        let dir = std::env::temp_dir().join(format!("dbx-agent-registry-install-{name}-{}", uuid::Uuid::new_v4()));
        AgentManager::new_with_base_dir(dir)
    }

    #[test]
    fn driver_operation_lock_is_removed_after_last_handle_drops() {
        let manager = test_manager("driver-lock-cleanup");
        let lock = driver_operation_lock(&manager, "oracle");

        assert_eq!(manager.driver_operation_locks.lock().unwrap().len(), 1);
        drop(lock);
        assert!(manager.driver_operation_locks.lock().unwrap().is_empty());
    }

    #[test]
    fn jre_operation_lock_stays_until_all_handles_drop() {
        let manager = test_manager("jre-lock-cleanup");
        let first = jre_operation_lock(&manager, DEFAULT_JRE_KEY);
        let second = jre_operation_lock(&manager, DEFAULT_JRE_KEY);

        drop(first);
        assert_eq!(manager.jre_install_locks.lock().unwrap().len(), 1);
        drop(second);
        assert!(manager.jre_install_locks.lock().unwrap().is_empty());
    }

    fn write_test_agent_jar(path: &Path) {
        use std::io::Write;

        let file = std::fs::File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive.start_file("META-INF/MANIFEST.MF", zip::write::SimpleFileOptions::default()).unwrap();
        archive.write_all(b"Manifest-Version: 1.0\nMain-Class: com.dbx.Agent\n").unwrap();
        archive.finish().unwrap();
    }

    fn registry_with_native_and_legacy_jar(
        db_type: &str,
        version: &str,
        native_url: &str,
        native_size: u64,
    ) -> AgentRegistry {
        let mut drivers = std::collections::HashMap::new();
        drivers.insert(
            db_type.to_string(),
            DriverInfo {
                version: version.to_string(),
                label: db_type.to_string(),
                min_app_version: "0.1.0".to_string(),
                jre: DEFAULT_JRE_KEY.to_string(),
                jar: Some(ArtifactInfo {
                    url: format!("https://example.com/dbx-agent-{db_type}-legacy-placeholder.jar"),
                    sha256: None,
                    size: 0,
                    format: None,
                }),
                native: [(
                    AgentManager::current_platform().to_string(),
                    ArtifactInfo { url: native_url.to_string(), sha256: None, size: native_size, format: None },
                )]
                .into_iter()
                .collect(),
            },
        );
        AgentRegistry { jre: None, jres: std::collections::HashMap::new(), drivers }
    }

    fn registry_with_jar(db_type: &str, version: &str, url: &str, size: u64) -> AgentRegistry {
        let mut drivers = std::collections::HashMap::new();
        drivers.insert(
            db_type.to_string(),
            DriverInfo {
                version: version.to_string(),
                label: db_type.to_string(),
                min_app_version: "0.1.0".to_string(),
                jre: DEFAULT_JRE_KEY.to_string(),
                jar: Some(ArtifactInfo { url: url.to_string(), sha256: None, size, format: None }),
                native: std::collections::HashMap::new(),
            },
        );
        AgentRegistry { jre: None, jres: std::collections::HashMap::new(), drivers }
    }

    fn registry_with_jre_version(version: &str) -> AgentRegistry {
        AgentRegistry {
            jre: None,
            jres: [(
                DEFAULT_JRE_KEY.to_string(),
                JreInfo { version: version.to_string(), platforms: std::collections::HashMap::new() },
            )]
            .into_iter()
            .collect(),
            drivers: std::collections::HashMap::new(),
        }
    }

    fn write_cached_driver_download(
        am: &AgentManager,
        db_type: &str,
        version: &str,
        url: &str,
        dest: &Path,
        bytes: &[u8],
    ) -> PathBuf {
        let cache_path = cached_download_path(
            am,
            url,
            bytes.len() as u64,
            None,
            Some(CacheIdentity::Driver { db_type, version }),
            dest,
        );
        std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
        std::fs::write(&cache_path, bytes).unwrap();
        cache_path
    }

    fn current_platform_native_binary() -> Vec<u8> {
        if cfg!(windows) {
            let mut bytes = vec![0_u8; 0x48];
            bytes[..2].copy_from_slice(b"MZ");
            bytes[0x3c..0x40].copy_from_slice(&(0x40_u32).to_le_bytes());
            bytes[0x40..0x44].copy_from_slice(b"PE\0\0");
            let machine = if cfg!(target_arch = "aarch64") { 0xaa64_u16 } else { 0x8664_u16 };
            bytes[0x44..0x46].copy_from_slice(&machine.to_le_bytes());
            bytes
        } else if cfg!(target_os = "linux") {
            let mut bytes = vec![0_u8; 20];
            bytes[..4].copy_from_slice(b"\x7fELF");
            bytes[4] = 2;
            bytes[5] = 1;
            let machine = if cfg!(target_arch = "aarch64") { 183_u16 } else { 62_u16 };
            bytes[18..20].copy_from_slice(&machine.to_le_bytes());
            bytes
        } else if cfg!(target_os = "macos") {
            let mut bytes = vec![0xcf, 0xfa, 0xed, 0xfe];
            let cpu_type = if cfg!(target_arch = "aarch64") { 0x0100_000c_u32 } else { 0x0100_0007_u32 };
            bytes.extend_from_slice(&cpu_type.to_le_bytes());
            bytes
        } else {
            Vec::new()
        }
    }

    fn test_agent_jar() -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        {
            use std::io::Write;
            let mut archive = zip::ZipWriter::new(&mut bytes);
            archive.start_file("META-INF/MANIFEST.MF", zip::write::SimpleFileOptions::default()).unwrap();
            archive.write_all(b"Manifest-Version: 1.0\nMain-Class: com.dbx.Agent\n").unwrap();
            archive.finish().unwrap();
        }
        bytes.into_inner()
    }

    fn sha256_bytes(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn write_offline_zip(registry: &AgentRegistry, entries: &[(String, Vec<u8>)]) -> (tempfile::TempDir, PathBuf) {
        use std::io::Write;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("agents.zip");
        let file = std::fs::File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        archive.start_file("agent-registry.json", options).unwrap();
        archive.write_all(&serde_json::to_vec(registry).unwrap()).unwrap();
        for (name, bytes) in entries {
            archive.start_file(name, options).unwrap();
            archive.write_all(bytes).unwrap();
        }
        archive.finish().unwrap();
        (temp, path)
    }

    fn build_tar_zstd_driver_package(
        db_type: &str,
        version: &str,
        kind: DriverArtifactKind,
        driver_bytes: &[u8],
    ) -> Vec<u8> {
        let platform = AgentManager::current_platform();
        let (filename, artifact) = match kind {
            DriverArtifactKind::Jar => (
                format!("dbx-agent-{db_type}-{version}.jar"),
                serde_json::json!({
                    "jar": {
                        "url": format!("dbx-agent-{db_type}-{version}.jar"),
                        "size": driver_bytes.len()
                    }
                }),
            ),
            DriverArtifactKind::Native => {
                let extension = if platform.starts_with("windows-") { ".exe" } else { "" };
                let filename = format!("dbx-agent-{db_type}-{version}-{platform}{extension}");
                (
                    filename.clone(),
                    serde_json::json!({
                        "native": {
                            platform: {
                                "url": filename,
                                "size": driver_bytes.len()
                            }
                        }
                    }),
                )
            }
        };
        let mut driver = serde_json::json!({
            "version": version,
            "label": db_type,
            "min_app_version": "0.6.0",
            "jre": DEFAULT_JRE_KEY
        });
        driver.as_object_mut().unwrap().extend(artifact.as_object().unwrap().clone());
        let registry = serde_json::json!({
            "jres": {},
            "drivers": {
                db_type: driver
            }
        });
        let registry_bytes = registry.to_string().into_bytes();
        let encoder = zstd::stream::write::Encoder::new(Vec::new(), 3).unwrap();
        let mut archive = tar::Builder::new(encoder);

        let mut registry_header = tar::Header::new_gnu();
        registry_header.set_size(registry_bytes.len() as u64);
        registry_header.set_mode(0o644);
        registry_header.set_cksum();
        archive.append_data(&mut registry_header, "agent-registry.json", registry_bytes.as_slice()).unwrap();

        let mut driver_header = tar::Header::new_gnu();
        driver_header.set_size(driver_bytes.len() as u64);
        driver_header.set_mode(if kind == DriverArtifactKind::Native { 0o755 } else { 0o644 });
        driver_header.set_cksum();
        archive.append_data(&mut driver_header, format!("drivers/{filename}"), driver_bytes).unwrap();

        archive.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn managed_jre_content_revision_triggers_install() {
        let manager = test_manager("jre-content-revision");
        let java_path = manager.jre_java_path(DEFAULT_JRE_KEY);
        std::fs::create_dir_all(java_path.parent().unwrap()).unwrap();
        std::fs::write(&java_path, b"java").unwrap();

        let mut state = crate::agent_manager::AgentState::default();
        state.jre_versions.insert(DEFAULT_JRE_KEY.to_string(), "21.0.12+kerberos.1".to_string());
        manager.save_state(&state).unwrap();

        let registry = registry_with_jre_version("21.0.12+kerberos.ec.2");
        assert!(jre_needs_install(&manager, &registry, DEFAULT_JRE_KEY));

        state.jre_versions.insert(DEFAULT_JRE_KEY.to_string(), "21.0.12+kerberos.ec.2".to_string());
        manager.save_state(&state).unwrap();
        assert!(!jre_needs_install(&manager, &registry, DEFAULT_JRE_KEY));
    }

    fn install_jre(manager: &AgentManager) {
        let java_path = manager.jre_java_path(DEFAULT_JRE_KEY);
        std::fs::create_dir_all(java_path.parent().unwrap()).unwrap();
        std::fs::write(&java_path, b"java").unwrap();
        let mut state = manager.load_state();
        state.jre_versions.insert(DEFAULT_JRE_KEY.to_string(), "21.0.0".to_string());
        manager.save_state(&state).unwrap();
    }

    fn record_driver(manager: &AgentManager, db_type: &str) {
        let mut state = manager.load_state();
        state.installed_drivers.insert(
            db_type.to_string(),
            InstalledDriver {
                version: "1.0.0".to_string(),
                installed_at: "2026-01-01T00:00:00Z".to_string(),
                jre: DEFAULT_JRE_KEY.to_string(),
            },
        );
        manager.save_state(&state).unwrap();
    }

    #[tokio::test]
    async fn uninstall_jre_ignores_native_driver_dependents() {
        // A native (non-Java) driver still records the JRE key in its state
        // entry, but must not block uninstalling the JRE it never uses.
        let manager = test_manager("jre-uninstall-native-dependent");
        install_jre(&manager);
        std::fs::create_dir_all(manager.driver_dir("kafka")).unwrap();
        std::fs::write(manager.driver_native_path("kafka"), b"native-binary").unwrap();
        record_driver(&manager, "kafka");

        uninstall_agent_jre(&manager, DEFAULT_JRE_KEY).await.expect("native driver must not block JRE uninstall");
    }

    #[tokio::test]
    async fn uninstall_jre_blocked_by_jar_driver_dependent() {
        // A JAR (Java) driver genuinely depends on the JRE and must block the
        // uninstall so the driver keeps a runtime.
        let manager = test_manager("jre-uninstall-jar-dependent");
        install_jre(&manager);
        std::fs::create_dir_all(manager.driver_dir("mysql")).unwrap();
        std::fs::write(manager.driver_jar_path("mysql"), test_agent_jar()).unwrap();
        record_driver(&manager, "mysql");

        let err = uninstall_agent_jre(&manager, DEFAULT_JRE_KEY).await.expect_err("jar driver must block uninstall");
        assert!(err.contains("is in use by drivers"), "unexpected error: {err}");
        assert!(err.contains("mysql"), "expected dependent driver in error: {err}");
    }

    fn registry_with_jre(jre_key: &str, version: &str, url: &str, size: u64) -> AgentRegistry {
        AgentRegistry {
            jre: None,
            jres: [(
                jre_key.to_string(),
                JreInfo {
                    version: version.to_string(),
                    platforms: [(
                        AgentManager::current_platform().to_string(),
                        ArtifactInfo { url: url.to_string(), sha256: None, size, format: None },
                    )]
                    .into_iter()
                    .collect(),
                },
            )]
            .into_iter()
            .collect(),
            drivers: std::collections::HashMap::new(),
        }
    }

    fn build_jre_archive(am: &AgentManager, jre_key: &str) -> Vec<u8> {
        let archive_root = am.base_dir().join("jre-test-archive");
        let payload = archive_root.join("payload");
        let java_path = am.jre_java_path(jre_key);
        let relative_java_path = java_path.strip_prefix(am.jre_dir(jre_key)).unwrap();
        let java_path = payload.join(relative_java_path);
        std::fs::create_dir_all(java_path.parent().unwrap()).unwrap();
        std::fs::write(java_path, b"java").unwrap();
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        builder.append_dir_all("payload", &payload).unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn build_zstd_jre_archive(am: &AgentManager, jre_key: &str) -> Vec<u8> {
        let archive_root = am.base_dir().join("jre-zstd-test-archive");
        let payload = archive_root.join("payload");
        let java_path = am.jre_java_path(jre_key);
        let relative_java_path = java_path.strip_prefix(am.jre_dir(jre_key)).unwrap();
        let java_path = payload.join(relative_java_path);
        std::fs::create_dir_all(java_path.parent().unwrap()).unwrap();
        std::fs::write(java_path, b"java").unwrap();
        let encoder = zstd::stream::write::Encoder::new(Vec::new(), 3).unwrap();
        let mut builder = tar::Builder::new(encoder);
        builder.append_dir_all("payload", &payload).unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn write_cached_jre_download(
        am: &AgentManager,
        jre_key: &str,
        version: &str,
        url: &str,
        format: Option<ArtifactFormat>,
        expected_sha256: Option<&str>,
        archive: &[u8],
    ) {
        let dest = jre_archive_download_path(am, jre_key, format);
        let cache_path = cached_download_path(
            am,
            url,
            archive.len() as u64,
            expected_sha256,
            Some(CacheIdentity::Jre { key: jre_key, version }),
            &dest,
        );
        std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
        std::fs::write(cache_path, archive).unwrap();
    }

    async fn cache_test_registry(registry: AgentRegistry) {
        REGISTRY_CACHE.lock().await.insert(DownloadSource::Cnb, (std::time::Instant::now(), registry));
    }

    fn mongodb_registry_with_jre(
        driver_version: &str,
        driver_url: &str,
        driver_size: u64,
        jre_version: &str,
        jre_url: &str,
        jre_size: u64,
    ) -> AgentRegistry {
        let mut registry = registry_with_jar("mongodb", driver_version, driver_url, driver_size);
        registry.jres = registry_with_jre(DEFAULT_JRE_KEY, jre_version, jre_url, jre_size).jres;
        registry
    }

    #[tokio::test]
    async fn ensure_agent_runtime_installs_missing_driver_and_jre() {
        let _test_guard = ENSURE_AGENT_TEST_LOCK.lock().await;
        let manager = test_manager("ensure-missing-driver-and-jre");
        let driver_version = "0.1.47";
        let driver_url = "https://example.com/dbx-agent-mongodb.jar";
        let driver_bytes = test_agent_jar();
        let jre_version = "21.0.12";
        let jre_url = "https://example.com/dbx-jre.tar.gz";
        let jre_archive = build_jre_archive(&manager, DEFAULT_JRE_KEY);
        let registry = mongodb_registry_with_jre(
            driver_version,
            driver_url,
            driver_bytes.len() as u64,
            jre_version,
            jre_url,
            jre_archive.len() as u64,
        );
        write_cached_driver_download(
            &manager,
            "mongodb",
            driver_version,
            driver_url,
            &manager.driver_jar_path("mongodb"),
            &driver_bytes,
        );
        write_cached_jre_download(&manager, DEFAULT_JRE_KEY, jre_version, jre_url, None, None, &jre_archive);
        cache_test_registry(registry).await;

        ensure_agent_driver_ready_from(&manager, "mongodb", DownloadSource::Cnb).await.unwrap();

        assert!(manager.is_driver_jar_valid("mongodb"));
        assert!(manager.is_jre_installed(DEFAULT_JRE_KEY));
        let state = manager.load_state();
        assert_eq!(state.installed_drivers["mongodb"].version, driver_version);
        assert_eq!(state.jre_versions[DEFAULT_JRE_KEY], jre_version);
    }

    #[tokio::test]
    async fn ensure_agent_runtime_ready_fast_path_preserves_valid_old_driver() {
        let _test_guard = ENSURE_AGENT_TEST_LOCK.lock().await;
        let manager = test_manager("ensure-ready-old-driver");
        let driver_path = manager.driver_jar_path("mongodb");
        std::fs::create_dir_all(driver_path.parent().unwrap()).unwrap();
        let old_driver_bytes = test_agent_jar();
        std::fs::write(&driver_path, &old_driver_bytes).unwrap();
        install_jre(&manager);
        record_driver(&manager, "mongodb");

        let latest_version = "9.9.9";
        let latest_url = "https://example.com/dbx-agent-mongodb-latest.jar";
        let latest_driver_bytes = test_agent_jar();
        let cache_path = write_cached_driver_download(
            &manager,
            "mongodb",
            latest_version,
            latest_url,
            &driver_path,
            &latest_driver_bytes,
        );
        let registry_guard = REGISTRY_CACHE.lock().await;

        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            ensure_agent_driver_ready_from(&manager, "mongodb", DownloadSource::Cnb),
        )
        .await
        .expect("ready Agent path must not wait for the registry cache")
        .unwrap();
        drop(registry_guard);

        assert_eq!(std::fs::read(&driver_path).unwrap(), old_driver_bytes);
        assert_eq!(manager.load_state().installed_drivers["mongodb"].version, "1.0.0");
        assert!(cache_path.exists(), "ready fast path must not consume a pending driver download");
    }

    #[tokio::test]
    async fn ensure_agent_runtime_repairs_damaged_jre_without_upgrading_valid_driver() {
        let _test_guard = ENSURE_AGENT_TEST_LOCK.lock().await;
        let manager = test_manager("ensure-damaged-jre");
        let driver_path = manager.driver_jar_path("mongodb");
        std::fs::create_dir_all(driver_path.parent().unwrap()).unwrap();
        let old_driver_bytes = test_agent_jar();
        std::fs::write(&driver_path, &old_driver_bytes).unwrap();
        record_driver(&manager, "mongodb");
        let damaged_java = manager.jre_java_path(DEFAULT_JRE_KEY);
        std::fs::create_dir_all(&damaged_java).unwrap();

        let jre_version = "21.0.12";
        let jre_url = "https://example.com/dbx-jre.tar.gz";
        let jre_archive = build_jre_archive(&manager, DEFAULT_JRE_KEY);
        let registry = mongodb_registry_with_jre(
            "9.9.9",
            "https://example.com/dbx-agent-mongodb-latest.jar",
            test_agent_jar().len() as u64,
            jre_version,
            jre_url,
            jre_archive.len() as u64,
        );
        write_cached_jre_download(&manager, DEFAULT_JRE_KEY, jre_version, jre_url, None, None, &jre_archive);
        cache_test_registry(registry).await;

        ensure_agent_driver_ready_from(&manager, "mongodb", DownloadSource::Cnb).await.unwrap();

        assert!(manager.is_jre_installed(DEFAULT_JRE_KEY));
        assert_eq!(std::fs::read(&driver_path).unwrap(), old_driver_bytes);
        assert_eq!(manager.load_state().installed_drivers["mongodb"].version, "1.0.0");
    }

    #[tokio::test]
    async fn concurrent_ensure_agent_runtime_installs_once() {
        let _test_guard = ENSURE_AGENT_TEST_LOCK.lock().await;
        let manager = Arc::new(test_manager("ensure-concurrent-single-install"));
        let driver_version = "0.1.47";
        let driver_url = "https://example.com/dbx-agent-mongodb.jar";
        let driver_bytes = test_agent_jar();
        let jre_version = "21.0.12";
        let jre_url = "https://example.com/dbx-jre.tar.gz";
        let jre_archive = build_jre_archive(&manager, DEFAULT_JRE_KEY);
        let registry = mongodb_registry_with_jre(
            driver_version,
            driver_url,
            driver_bytes.len() as u64,
            jre_version,
            jre_url,
            jre_archive.len() as u64,
        );
        let driver_cache_path = write_cached_driver_download(
            &manager,
            "mongodb",
            driver_version,
            driver_url,
            &manager.driver_jar_path("mongodb"),
            &driver_bytes,
        );
        write_cached_jre_download(&manager, DEFAULT_JRE_KEY, jre_version, jre_url, None, None, &jre_archive);
        cache_test_registry(registry).await;

        let first = ensure_agent_driver_ready_from(&manager, "mongodb", DownloadSource::Cnb);
        let second = ensure_agent_driver_ready_from(&manager, "mongodb", DownloadSource::Cnb);
        let (first, second) = tokio::join!(first, second);

        first.unwrap();
        second.unwrap();
        assert!(manager.is_driver_jar_valid("mongodb"));
        assert!(manager.is_jre_installed(DEFAULT_JRE_KEY));
        assert!(!driver_cache_path.exists(), "the single successful install should consume the cached artifact");
    }

    #[tokio::test]
    async fn ensure_agent_runtime_propagates_corrupt_install_error() {
        let _test_guard = ENSURE_AGENT_TEST_LOCK.lock().await;
        let manager = test_manager("ensure-corrupt-install-error");
        manager
            .mutate_state(|state| {
                state.java_runtime = JavaRuntimeConfig { mode: JavaRuntimeMode::System, custom_java_path: None };
            })
            .unwrap();
        let driver_version = "0.1.47";
        let driver_url = "https://example.com/dbx-agent-mongodb.jar";
        let corrupt_driver = b"not-a-jar";
        let registry = registry_with_jar("mongodb", driver_version, driver_url, corrupt_driver.len() as u64);
        write_cached_driver_download(
            &manager,
            "mongodb",
            driver_version,
            driver_url,
            &manager.driver_jar_path("mongodb"),
            corrupt_driver,
        );
        cache_test_registry(registry).await;

        let error = ensure_agent_driver_ready_from(&manager, "mongodb", DownloadSource::Cnb)
            .await
            .expect_err("corrupt driver install must fail");

        assert!(error.contains("invalid or corrupt"), "unexpected error: {error}");
        assert!(!manager.load_state().installed_drivers.contains_key("mongodb"));
    }

    #[test]
    fn artifact_info_deserializes_sha256_metadata() {
        let expected_sha256 = "a".repeat(64);
        let artifact: ArtifactInfo = serde_json::from_value(serde_json::json!({
            "url": "https://example.com/artifact.tar.zst",
            "sha256": expected_sha256,
            "size": 4,
            "format": "tar_zstd"
        }))
        .unwrap();

        assert_eq!(artifact.sha256.as_deref(), Some(expected_sha256.as_str()));
    }

    #[test]
    fn cached_download_rejects_same_size_sha256_mismatch() {
        let manager = test_manager("cache-sha256-mismatch");
        let cache_path = manager.download_cache_dir().join("artifact.bin");
        std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
        std::fs::write(&cache_path, b"bad!").unwrap();
        let expected_sha256 = format!("{:x}", Sha256::digest(b"good"));

        assert!(!cached_download_is_valid(&manager, &cache_path, 4, Some(&expected_sha256)));
        assert!(!cache_path.exists());
    }

    #[test]
    fn cached_download_accepts_matching_sha256() {
        let manager = test_manager("cache-sha256-match");
        let cache_path = manager.download_cache_dir().join("artifact.bin");
        std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
        std::fs::write(&cache_path, b"good").unwrap();
        let expected_sha256 = format!("{:x}", Sha256::digest(b"good"));

        assert!(cached_download_is_valid(&manager, &cache_path, 4, Some(&expected_sha256)));
        assert!(cache_path.exists());
    }

    #[tokio::test]
    async fn registry_install_replaces_hive_legacy_jar_with_native_driver() {
        let manager = test_manager("hive-native-replaces-legacy-jar");
        let db_type = "hive";
        let version = "0.1.31";
        let native_url = "https://example.com/dbx-agent-hive";
        let native_bytes = b"native-agent";
        let registry = registry_with_native_and_legacy_jar(db_type, version, native_url, native_bytes.len() as u64);
        let native_path = manager.driver_native_path(db_type);
        std::fs::create_dir_all(manager.driver_dir(db_type)).unwrap();
        write_test_agent_jar(&manager.driver_jar_path(db_type));
        let cache_path =
            write_cached_driver_download(&manager, db_type, version, native_url, &native_path, native_bytes);
        let events = std::sync::Mutex::new(Vec::new());
        let progress = |event| events.lock().unwrap().push(event);

        install_agent_driver_from_registry(
            &manager,
            &registry,
            DownloadSource::Official,
            db_type,
            &progress,
            None,
            None,
            &[],
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read(&native_path).unwrap(), native_bytes);
        assert!(!cache_path.exists());
        assert!(!manager.driver_jar_path(db_type).exists());
        assert_eq!(manager.load_state().installed_drivers.get(db_type).unwrap().version, version);
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.step == "done" && event.db_type.as_deref() == Some(db_type)));
    }

    #[tokio::test]
    async fn registry_install_sqlite_worker_downloads_both_linux_platforms() {
        let manager = test_manager("sqlite-worker-both-linux-platforms");
        let db_type = "sqlite-worker";
        let version = "0.1.0";
        let x64_url = "https://example.com/dbx-agent-sqlite-worker-linux-x64";
        let arm_url = "https://example.com/dbx-agent-sqlite-worker-linux-aarch64";
        let x64_bytes = b"sqlite-worker-linux-x64";
        let arm_bytes = b"sqlite-worker-linux-aarch64";
        let mut native = std::collections::HashMap::new();
        native.insert(
            "linux-x64".to_string(),
            ArtifactInfo { url: x64_url.to_string(), sha256: None, size: x64_bytes.len() as u64, format: None },
        );
        native.insert(
            "linux-aarch64".to_string(),
            ArtifactInfo { url: arm_url.to_string(), sha256: None, size: arm_bytes.len() as u64, format: None },
        );
        let mut drivers = std::collections::HashMap::new();
        drivers.insert(
            db_type.to_string(),
            DriverInfo {
                version: version.to_string(),
                label: "SQLite SSH Worker".to_string(),
                min_app_version: "0.1.0".to_string(),
                jre: DEFAULT_JRE_KEY.to_string(),
                jar: Some(ArtifactInfo {
                    url: "https://example.com/dbx-agent-sqlite-worker-legacy-placeholder.jar".to_string(),
                    sha256: None,
                    size: 0,
                    format: None,
                }),
                native,
            },
        );
        let registry = AgentRegistry { jre: None, jres: std::collections::HashMap::new(), drivers };
        let x64_path = manager.driver_native_platform_path(db_type, "linux-x64");
        let arm_path = manager.driver_native_platform_path(db_type, "linux-aarch64");
        std::fs::create_dir_all(manager.driver_dir(db_type)).unwrap();
        write_cached_driver_download(&manager, db_type, version, x64_url, &x64_path, x64_bytes);
        write_cached_driver_download(&manager, db_type, version, arm_url, &arm_path, arm_bytes);
        let events = std::sync::Mutex::new(Vec::new());
        let progress = |event| events.lock().unwrap().push(event);

        install_agent_driver_from_registry(
            &manager,
            &registry,
            DownloadSource::Official,
            db_type,
            &progress,
            None,
            None,
            &[],
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read(&x64_path).unwrap(), x64_bytes);
        assert_eq!(std::fs::read(&arm_path).unwrap(), arm_bytes);
        assert!(manager.driver_native_installed(db_type));
        assert!(!manager.driver_native_path(db_type).exists());
        assert!(!manager.driver_jar_path(db_type).exists());
        assert!(!remote_driver_requires_java_runtime(registry.drivers.get(db_type).unwrap()));
        assert_eq!(
            driver_download_size(db_type, registry.drivers.get(db_type).unwrap()),
            (x64_bytes.len() + arm_bytes.len()) as u64
        );
        assert_eq!(manager.load_state().installed_drivers.get(db_type).unwrap().version, version);
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.step == "done" && event.db_type.as_deref() == Some(db_type)));
    }

    #[tokio::test]
    async fn registry_install_cancel_after_cached_download_preserves_existing_driver() {
        let manager = test_manager("cancel-after-cached-driver-download");
        let db_type = "mongodb";
        let old_version = "1.0.0";
        let new_version = "2.0.0";
        let url = "https://example.com/dbx-agent-mongodb.jar";
        // The old driver only needs to exist for this regression: use distinct
        // bytes so the assertion proves cancellation did not replace it.
        let old_bytes = b"previously-installed-driver".to_vec();
        let new_bytes = test_agent_jar();
        let target_path = manager.driver_jar_path(db_type);
        std::fs::create_dir_all(target_path.parent().unwrap()).unwrap();
        std::fs::write(&target_path, &old_bytes).unwrap();
        install_jre(&manager);
        record_driver(&manager, db_type);
        write_cached_driver_download(&manager, db_type, new_version, url, &target_path, &new_bytes);
        let registry = registry_with_jar(db_type, new_version, url, new_bytes.len() as u64);
        let cancellation = manager.begin_install_cancellation("cancel-after-cached-download").await;
        let progress_cancellation = Arc::clone(&cancellation);
        let progress = move |event: AgentProgressEvent| {
            if event.step == "driver" && event.downloaded == Some(new_bytes.len() as u64) {
                progress_cancellation.cancel();
            }
        };

        let error = install_agent_driver_from_registry(
            &manager,
            &registry,
            DownloadSource::Official,
            db_type,
            &progress,
            None,
            None,
            &[&cancellation],
        )
        .await
        .expect_err("cancellation after download completion must abort installation");

        assert!(error.contains(AGENT_DOWNLOAD_CANCELED_ERROR));
        assert_eq!(std::fs::read(&target_path).unwrap(), old_bytes);
        assert_eq!(manager.load_state().installed_drivers[db_type].version, old_version);
        assert!(!driver_artifact_download_path(&target_path, None).exists());
    }

    #[tokio::test]
    async fn registry_install_extracts_tar_zstd_native_driver_package() {
        let manager = test_manager("tar-zstd-native-package");
        let db_type = "duckdb";
        let version = "0.1.0";
        let package_url = "https://example.com/dbx-agent-duckdb.tar.zst";
        let native_bytes = current_platform_native_binary();
        let package_bytes = build_tar_zstd_driver_package(db_type, version, DriverArtifactKind::Native, &native_bytes);
        let mut registry =
            registry_with_native_and_legacy_jar(db_type, version, package_url, package_bytes.len() as u64);
        registry.drivers.get_mut(db_type).unwrap().native.get_mut(AgentManager::current_platform()).unwrap().format =
            Some(ArtifactFormat::TarZstd);
        let native_path = manager.driver_native_path(db_type);
        let package_path = driver_artifact_download_path(&native_path, Some(ArtifactFormat::TarZstd));
        let cache_path =
            write_cached_driver_download(&manager, db_type, version, package_url, &package_path, &package_bytes);
        let progress = |_| {};

        install_agent_driver_from_registry(
            &manager,
            &registry,
            DownloadSource::Official,
            db_type,
            &progress,
            None,
            None,
            &[],
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read(&native_path).unwrap(), native_bytes);
        assert!(!package_path.exists());
        assert!(!cache_path.exists());
        assert_eq!(manager.load_state().installed_drivers[db_type].version, version);
    }

    #[tokio::test]
    async fn registry_install_extracts_tar_zstd_java_driver_package() {
        let manager = test_manager("tar-zstd-java-package");
        let db_type = "dameng";
        let version = "0.2.0";
        let package_url = "https://example.com/dbx-agent-dameng.tar.zst";
        let jar_bytes = test_agent_jar();
        let package_bytes = build_tar_zstd_driver_package(db_type, version, DriverArtifactKind::Jar, &jar_bytes);
        let mut registry = registry_with_jar(db_type, version, package_url, package_bytes.len() as u64);
        registry.drivers.get_mut(db_type).unwrap().jar.as_mut().unwrap().format = Some(ArtifactFormat::TarZstd);
        manager
            .mutate_state(|state| {
                state.java_runtime = JavaRuntimeConfig { mode: JavaRuntimeMode::System, custom_java_path: None };
            })
            .unwrap();
        let jar_path = manager.driver_jar_path(db_type);
        let package_path = driver_artifact_download_path(&jar_path, Some(ArtifactFormat::TarZstd));
        let cache_path =
            write_cached_driver_download(&manager, db_type, version, package_url, &package_path, &package_bytes);
        let progress = |_| {};

        install_agent_driver_from_registry(
            &manager,
            &registry,
            DownloadSource::Official,
            db_type,
            &progress,
            None,
            None,
            &[],
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read(&jar_path).unwrap(), jar_bytes);
        assert!(!package_path.exists());
        assert!(!cache_path.exists());
        assert_eq!(manager.load_state().installed_drivers[db_type].version, version);
    }

    #[tokio::test]
    async fn batch_upgrade_preserves_successful_state_and_reports_independent_failure() {
        let manager = test_manager("batch-upgrade");
        let oracle_url = "https://example.com/dbx-agent-oracle";
        let dameng_url = "https://example.com/dbx-agent-dameng";
        let kingbase_url = "https://example.com/dbx-agent-kingbase.jar";
        let oracle_bytes = b"oracle-native-agent";
        let dameng_bytes = b"dameng-native-agent";
        let corrupt_jar = b"not-a-jar";

        let mut registry =
            registry_with_native_and_legacy_jar("oracle", "2.0.0", oracle_url, oracle_bytes.len() as u64);
        registry.drivers.extend(
            registry_with_native_and_legacy_jar("dameng", "2.0.0", dameng_url, dameng_bytes.len() as u64).drivers,
        );
        registry.drivers.extend(registry_with_jar("kingbase", "2.0.0", kingbase_url, corrupt_jar.len() as u64).drivers);

        let mut state = manager.load_state();
        state.java_runtime = JavaRuntimeConfig { mode: JavaRuntimeMode::System, custom_java_path: None };
        for (db_type, version) in [("oracle", "1.0.0"), ("dameng", "1.0.0"), ("kingbase", "1.0.0")] {
            state.installed_drivers.insert(
                db_type.to_string(),
                InstalledDriver {
                    version: version.to_string(),
                    installed_at: "2026-01-01T00:00:00Z".to_string(),
                    jre: DEFAULT_JRE_KEY.to_string(),
                },
            );
        }
        manager.save_state(&state).unwrap();

        write_cached_driver_download(
            &manager,
            "oracle",
            "2.0.0",
            oracle_url,
            &manager.driver_native_path("oracle"),
            oracle_bytes,
        );
        write_cached_driver_download(
            &manager,
            "dameng",
            "2.0.0",
            dameng_url,
            &manager.driver_native_path("dameng"),
            dameng_bytes,
        );
        write_cached_driver_download(
            &manager,
            "kingbase",
            "2.0.0",
            kingbase_url,
            &manager.driver_jar_path("kingbase"),
            corrupt_jar,
        );
        let events = std::sync::Mutex::new(Vec::new());
        let progress = |event| events.lock().unwrap().push(event);

        let result = upgrade_all_agent_drivers_with_registry(
            &manager,
            &registry,
            DownloadSource::Official,
            &progress,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.upgraded, 2);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].db_type, "kingbase");
        let state = manager.load_state();
        assert_eq!(state.installed_drivers["oracle"].version, "2.0.0");
        assert_eq!(state.installed_drivers["dameng"].version, "2.0.0");
        assert_eq!(state.installed_drivers["kingbase"].version, "1.0.0");
        assert_eq!(events.lock().unwrap().iter().filter(|event| event.step == "done").count(), 2);
    }

    #[tokio::test]
    async fn batch_cancel_all_aborts_in_flight_downloads_without_persisting() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let _test_guard = ENSURE_AGENT_TEST_LOCK.lock().await;
        let manager = std::sync::Arc::new(test_manager("batch-cancel-in-flight"));
        let db_type = "oracle";
        let version = "2.0.0";
        // Pad the native binary to a sizeable payload so the server can stream
        // it slowly and the download stays in-flight when cancel-all fires.
        let body_size = 256 * 1024usize;
        let mut native_bytes = current_platform_native_binary();
        native_bytes.resize(body_size, 0xAA);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let native_url = format!("http://{addr}/dbx-agent-oracle");
        let registry = registry_with_native_and_legacy_jar(db_type, version, &native_url, native_bytes.len() as u64);

        // Mark the driver installed at an older version so the batch considers
        // it updatable.
        let mut state = manager.load_state();
        state.java_runtime = JavaRuntimeConfig { mode: JavaRuntimeMode::System, custom_java_path: None };
        state.installed_drivers.insert(
            db_type.to_string(),
            InstalledDriver {
                version: "1.0.0".to_string(),
                installed_at: "2026-01-01T00:00:00Z".to_string(),
                jre: DEFAULT_JRE_KEY.to_string(),
            },
        );
        manager.save_state(&state).unwrap();

        // Slow server: serve the exact payload size slowly so the download is
        // still transferring when the batch cancel-all fires.
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {body_size}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n"
            );
            socket.write_all(header.as_bytes()).await.expect("write header");
            let chunk = vec![0xAAu8; 4096];
            for _ in 0..(body_size / 4096) {
                socket.write_all(&chunk).await.expect("write chunk");
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        });

        // Register the batch operation + shared batch token (as the command
        // layer does) and start the upgrade.
        let operation_id = "batch-op";
        let batch_token = manager.begin_install_cancellation(&batch_cancellation_key(operation_id)).await;
        let batch_token_task = Arc::clone(&batch_token);
        let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let started_progress = started.clone();
        let task_manager = Arc::clone(&manager);
        let mut batch_task = tokio::spawn(async move {
            upgrade_all_agent_drivers_with_registry(
                &task_manager,
                &registry,
                DownloadSource::Official,
                &|event| {
                    if event.step == "driver" && event.downloaded.unwrap_or(0) > 0 {
                        started_progress.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                },
                Some(&batch_token_task),
                Some(operation_id),
            )
            .await
        });

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        while !started.load(std::sync::atomic::Ordering::SeqCst) {
            if tokio::time::Instant::now() >= deadline {
                server.abort();
                if let Ok(joined) = tokio::time::timeout(std::time::Duration::from_secs(1), &mut batch_task).await {
                    panic!("batch download never started; batch finished with: {joined:?}");
                }
                batch_task.abort();
                panic!("batch download never started");
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        // Cancel-all must abort the already-transferring driver.
        cancel_agent_batch_upgrade(&manager, Some(operation_id)).await.unwrap();

        let result = tokio::time::timeout(std::time::Duration::from_secs(30), batch_task)
            .await
            .expect("batch did not finish after cancel-all")
            .expect("batch panicked")
            .expect("batch returned an unexpected error");
        server.abort();
        manager.finish_install_cancellation(&batch_cancellation_key(operation_id), &batch_token).await;

        assert_eq!(result.upgraded, 0);
        assert!(result.failed.is_empty(), "cancelled drivers must not be reported as failed: {:?}", result.failed);
        assert!(result.cancelled >= 1, "the in-flight driver must be reported cancelled, got {result:?}");
        // The pre-existing install is untouched: cancel-all must not persist the
        // new (in-flight) download as the installed version.
        assert_eq!(
            manager.load_state().installed_drivers.get(db_type).map(|driver| driver.version.as_str()),
            Some("1.0.0"),
            "batch cancel-all must not persist the cancelled download as installed"
        );
        assert!(
            !manager.driver_native_path(db_type).exists(),
            "cancelled download must not leave the driver artifact behind"
        );
        assert!(
            !download_temp_path(&manager.driver_native_path(db_type)).exists(),
            "cancelled download must clean up its temp file"
        );
    }

    #[tokio::test]
    async fn shared_jre_is_not_downloaded_again_after_the_first_install_persists_its_version() {
        let manager = test_manager("shared-jre-deduplication");
        let jre_key = DEFAULT_JRE_KEY;
        let version = "21.0.12";
        let url = "https://example.com/dbx-jre.tar.gz";
        let archive = build_jre_archive(&manager, jre_key);
        let registry = registry_with_jre(jre_key, version, url, archive.len() as u64);
        let events = std::sync::Mutex::new(Vec::new());
        let progress = |event| events.lock().unwrap().push(event);

        write_cached_jre_download(&manager, jre_key, version, url, None, None, &archive);
        ensure_jre_from_registry(
            &manager,
            &registry,
            DownloadSource::Official,
            jre_key,
            "oracle",
            &progress,
            Some(1),
            Some(2),
            &[],
        )
        .await
        .unwrap();

        // The successful install cleans its cache. Re-add it so the old
        // implementation fails deterministically by consuming it again.
        write_cached_jre_download(&manager, jre_key, version, url, None, None, &archive);
        ensure_jre_from_registry(
            &manager,
            &registry,
            DownloadSource::Official,
            jre_key,
            "dameng",
            &progress,
            Some(2),
            Some(2),
            &[],
        )
        .await
        .unwrap();

        assert_eq!(manager.load_state().jre_versions[jre_key], version);
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.step == "jre" && event.db_type.as_deref() == Some("oracle")));
        assert!(!events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.step == "jre" && event.db_type.as_deref() == Some("dameng")));
    }

    #[tokio::test]
    async fn managed_jre_install_extracts_tar_zstd_archive() {
        let manager = test_manager("managed-zstd-jre");
        let jre_key = DEFAULT_JRE_KEY;
        let version = "21.0.12";
        let url = "https://example.com/dbx-jre.tar.zst";
        let archive = build_zstd_jre_archive(&manager, jre_key);
        let expected_sha256 = format!("{:x}", Sha256::digest(&archive));
        let mut registry = registry_with_jre(jre_key, version, url, archive.len() as u64);
        let artifact =
            registry.jres.get_mut(jre_key).unwrap().platforms.get_mut(AgentManager::current_platform()).unwrap();
        artifact.format = Some(ArtifactFormat::TarZstd);
        artifact.sha256 = Some(expected_sha256.clone());
        write_cached_jre_download(
            &manager,
            jre_key,
            version,
            url,
            Some(ArtifactFormat::TarZstd),
            Some(&expected_sha256),
            &archive,
        );

        ensure_jre_from_registry(
            &manager,
            &registry,
            DownloadSource::Official,
            jre_key,
            "dameng",
            &|_| {},
            None,
            None,
            &[],
        )
        .await
        .unwrap();

        assert!(manager.is_jre_installed(jre_key));
        assert_eq!(manager.load_state().jre_versions[jre_key], version);
    }

    #[tokio::test]
    async fn stash_is_recorded_before_jre_extraction() {
        let manager = test_manager("stash-before-extract");
        let stash = manager.base_dir().join("jre-21.old-test");

        persist_pending_jre_cleanup(&manager, Some(&stash)).await.unwrap();

        assert_eq!(manager.load_state().pending_jre_cleanup, vec![stash]);
    }

    #[tokio::test]
    async fn local_fallback_cancel_before_commit_preserves_existing_driver() {
        let manager = test_manager("local-cancel-before-commit");
        let db_type = "oracle";
        let jar_path = manager.driver_jar_path(db_type);
        std::fs::create_dir_all(jar_path.parent().unwrap()).unwrap();
        std::fs::write(&jar_path, b"existing-driver").unwrap();
        manager.mutate_state(|state| record_local_agent_install(state, db_type, DEFAULT_JRE_KEY)).unwrap();
        let token = manager.begin_install_cancellation("local-cancel-before-commit").await;
        token.cancel();

        let error = ensure_local_agent_commit_allowed(&[&token]).expect_err("a pre-commit cancel must abort");

        assert!(error.contains(AGENT_DOWNLOAD_CANCELED_ERROR));
        assert_eq!(std::fs::read(&jar_path).unwrap(), b"existing-driver");
        assert!(manager.load_state().installed_drivers.contains_key(db_type));
    }

    #[tokio::test]
    async fn local_fallback_cancel_after_commit_boundary_persists_replacement() {
        let manager = test_manager("local-cancel-after-boundary");
        let db_type = "oracle";
        let jar_path = manager.driver_jar_path(db_type);
        std::fs::create_dir_all(jar_path.parent().unwrap()).unwrap();
        std::fs::write(&jar_path, b"existing-driver").unwrap();
        manager.mutate_state(|state| record_local_agent_install(state, db_type, DEFAULT_JRE_KEY)).unwrap();
        let source = manager.base_dir().join("replacement.jar");
        write_test_agent_jar(&source);
        let expected = std::fs::read(&source).unwrap();
        let token = manager.begin_install_cancellation("local-cancel-after-boundary").await;

        ensure_local_agent_commit_allowed(&[&token]).unwrap();
        token.cancel();
        commit_local_agent_install(&manager, db_type, &source, DEFAULT_JRE_KEY, Some("21.0.12")).await.unwrap();

        assert_eq!(std::fs::read(&jar_path).unwrap(), expected);
        let state = manager.load_state();
        assert_eq!(state.installed_drivers[db_type].version, "0.1.0-local");
        assert_eq!(state.jre_versions[DEFAULT_JRE_KEY], "21.0.12");
    }

    #[test]
    fn concurrent_local_agent_state_updates_preserve_each_driver() {
        let manager = test_manager("concurrent-local-agent-state");
        let start = std::sync::Arc::new(std::sync::Barrier::new(3));
        std::thread::scope(|scope| {
            for db_type in ["oracle", "dameng"] {
                let start = start.clone();
                let manager = &manager;
                scope.spawn(move || {
                    start.wait();
                    manager
                        .mutate_state(|state| {
                            state.jre_versions.insert(DEFAULT_JRE_KEY.to_string(), "21.0.12".to_string());
                            record_local_agent_install(state, db_type, DEFAULT_JRE_KEY);
                        })
                        .unwrap();
                });
            }
            start.wait();
        });

        let state = manager.load_state();
        assert!(state.installed_drivers.contains_key("oracle"));
        assert!(state.installed_drivers.contains_key("dameng"));
        assert_eq!(state.jre_versions[DEFAULT_JRE_KEY], "21.0.12");
    }

    #[tokio::test]
    async fn batch_registry_install_waits_for_an_existing_driver_operation() {
        let manager = test_manager("batch-driver-operation-lock");
        let db_type = "oracle";
        let version = "0.1.31";
        let native_url = "https://example.com/dbx-agent-oracle";
        let native_bytes = b"native-agent";
        let registry = registry_with_native_and_legacy_jar(db_type, version, native_url, native_bytes.len() as u64);
        write_cached_driver_download(
            &manager,
            db_type,
            version,
            native_url,
            &manager.driver_native_path(db_type),
            native_bytes,
        );
        let first_lock = driver_operation_lock(&manager, "oracle");
        let first_guard = first_lock.lock().await;
        let token = manager.begin_install_cancellation(&install_cancellation_key("batch-test")).await;
        let progress = |_| {};

        let blocked = tokio::time::timeout(std::time::Duration::from_millis(50), async {
            install_agent_driver_from_registry_locked(
                &manager,
                &registry,
                DownloadSource::Official,
                db_type,
                &progress,
                Some(1),
                Some(1),
                &[&token],
            )
            .await
        })
        .await;
        assert!(blocked.is_err(), "batch install entered while another operation owned the driver files");

        drop(first_guard);
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            install_agent_driver_from_registry_locked(
                &manager,
                &registry,
                DownloadSource::Official,
                db_type,
                &progress,
                Some(1),
                Some(1),
                &[&token],
            ),
        )
        .await
        .expect("batch install did not resume after the driver lock was released")
        .unwrap();
        assert_eq!(std::fs::read(manager.driver_native_path(db_type)).unwrap(), native_bytes);
    }

    #[tokio::test]
    async fn manual_import_waits_for_an_existing_driver_operation() {
        let manager = test_manager("manual-import-driver-operation-lock");
        let db_type = "h2";
        let source = manager.base_dir().join("dbx-agent-h2.jar");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        write_test_agent_jar(&source);
        let lock = driver_operation_lock(&manager, db_type);
        let first_guard = lock.lock().await;

        let blocked =
            tokio::time::timeout(std::time::Duration::from_millis(50), import_agent_driver(&manager, db_type, &source))
                .await;
        assert!(blocked.is_err(), "manual import entered while another operation owned the driver files");

        drop(first_guard);
        tokio::time::timeout(std::time::Duration::from_secs(1), import_agent_driver(&manager, db_type, &source))
            .await
            .expect("manual import did not resume after the driver lock was released")
            .unwrap();
        assert_eq!(std::fs::read(manager.driver_jar_path(db_type)).unwrap(), std::fs::read(source).unwrap());
    }

    #[tokio::test]
    async fn jre_exclusive_operation_waits_for_in_flight_driver_operation() {
        let manager = test_manager("jre-exclusive-operation-lock");
        let driver_guard = manager.installation_operation_lock.read().await;

        let blocked =
            tokio::time::timeout(std::time::Duration::from_millis(50), manager.installation_operation_lock.write())
                .await;
        assert!(blocked.is_err(), "JRE replacement entered before an in-flight driver operation completed");

        drop(driver_guard);
        let _jre_guard =
            tokio::time::timeout(std::time::Duration::from_secs(1), manager.installation_operation_lock.write())
                .await
                .expect("JRE replacement did not resume after driver operations completed");
    }

    #[tokio::test]
    async fn cancellation_token_lifecycle_is_scoped_and_removable() {
        let manager = test_manager("cancel-token-lifecycle");
        let token = manager.begin_install_cancellation("oracle").await;
        assert!(!token.is_cancelled());
        assert!(!manager.is_install_cancelled("oracle").await);

        manager.cancel_install("oracle").await;
        assert!(token.is_cancelled());
        assert!(manager.is_install_cancelled("oracle").await);

        manager.finish_install_cancellation("oracle", &token).await;
        assert!(!manager.is_install_cancelled("oracle").await);
    }

    #[tokio::test]
    async fn cancelled_install_never_enters_local_fallback() {
        let manager = test_manager("cancel-local-fallback");
        let token = manager.begin_install_cancellation("oracle").await;
        assert!(can_fallback_to_local_agent(&manager, "oracle", &[&token]).await);

        token.cancel();

        assert!(!can_fallback_to_local_agent(&manager, "oracle", &[&token]).await);
    }

    #[tokio::test]
    async fn finish_install_cancellation_keeps_a_fresh_token() {
        let manager = test_manager("cancel-token-fresh");
        let old_token = manager.begin_install_cancellation("oracle").await;
        old_token.cancel();
        // A new install replaces the cancelled token; finishing the OLD token
        // must not remove the fresh one (Arc::ptr_eq guard).
        let new_token = manager.begin_install_cancellation("oracle").await;
        assert!(!new_token.is_cancelled());
        manager.finish_install_cancellation("oracle", &old_token).await;
        assert!(!manager.is_install_cancelled("oracle").await);

        manager.cancel_install("oracle").await;
        assert!(new_token.is_cancelled());
        manager.finish_install_cancellation("oracle", &new_token).await;
        assert!(!manager.is_install_cancelled("oracle").await);
    }

    #[tokio::test]
    async fn download_with_progress_returns_cancelled_when_token_prefired() {
        let manager = test_manager("cancel-download-entry");
        let db_type = "oracle";
        let token = manager.begin_install_cancellation(db_type).await;
        token.cancel();
        let dest = manager.base_dir().join("downloads").join("oracle-agent");
        let error = download_with_progress(
            &manager,
            &|_| {},
            "driver",
            DownloadSource::Official,
            "https://example.com/dbx-agent-oracle",
            "agents/drivers/dbx-agent-oracle",
            &dest,
            100,
            None,
            None,
            Some(db_type),
            None,
            None,
            &[&token],
        )
        .await
        .expect_err("a pre-cancelled token must abort the download before any transfer");
        assert!(error.contains(AGENT_DOWNLOAD_CANCELED_ERROR), "unexpected error: {error}");
        assert!(!download_temp_path(&dest).exists());
        assert!(!dest.exists());
    }

    #[tokio::test]
    async fn download_with_progress_aborts_mid_stream_when_cancelled() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let manager = test_manager("cancel-mid-stream");
        let db_type = "oracle";
        let token = manager.begin_install_cancellation(db_type).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/slow-agent");

        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let body_size = 256 * 1024usize;
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {body_size}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n"
            );
            socket.write_all(header.as_bytes()).await.expect("write header");
            let chunk = vec![0xAAu8; 4096];
            for _ in 0..64 {
                socket.write_all(&chunk).await.expect("write chunk");
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        });

        let dest = manager.base_dir().join("downloads").join("oracle-agent");
        let dest_assert = dest.clone();
        let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let started_progress = started.clone();
        let token_for_task = Arc::clone(&token);
        let task = tokio::spawn(async move {
            download_with_progress(
                &manager,
                &|event| {
                    if event.step == "driver" && event.downloaded.unwrap_or(0) > 0 {
                        started_progress.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                },
                "driver",
                DownloadSource::Official,
                &url,
                "agents/drivers/dbx-agent-oracle",
                &dest,
                256 * 1024,
                None,
                None,
                Some(db_type),
                None,
                None,
                &[&token_for_task],
            )
            .await
        });

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while !started.load(std::sync::atomic::Ordering::SeqCst) {
            if tokio::time::Instant::now() >= deadline {
                server.abort();
                panic!("download never started (external mirror probe may have stalled)");
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        token.cancel();

        let result = tokio::time::timeout(std::time::Duration::from_secs(15), task)
            .await
            .expect("download task did not finish after cancel")
            .expect("download task panicked");
        server.abort();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains(AGENT_DOWNLOAD_CANCELED_ERROR));
        assert!(!download_temp_path(&dest_assert).exists());
        assert!(!dest_assert.exists());
    }

    #[test]
    fn cancelled_error_classification_distinguishes_user_cancel() {
        assert!(is_cancelled_error(AGENT_DOWNLOAD_CANCELED_ERROR));
        assert!(is_cancelled_error(&format!("prefix {AGENT_DOWNLOAD_CANCELED_ERROR} suffix")));
        assert!(!is_cancelled_error("Download failed: 404 Not Found"));
    }

    #[tokio::test]
    async fn cancel_during_driver_lock_wait_aborts_install_before_persist() {
        let manager = std::sync::Arc::new(test_manager("cancel-lock-wait"));
        let db_type = "oracle";
        // Command scope: the token is registered before any awaitable setup.
        let cancellation = manager.begin_install_cancellation(db_type).await;
        let cancel_handle = Arc::clone(&cancellation);
        // Hold the driver lock so the install blocks on it.
        let lock = driver_operation_lock(&manager, db_type);
        let _guard = lock.lock().await;

        let install_manager = Arc::clone(&manager);
        let install = tokio::spawn(async move {
            install_agent_driver_from_claimed(
                &install_manager,
                db_type,
                DownloadSource::Official,
                |_| {},
                &cancellation,
            )
            .await
        });
        // Let the install reach the lock wait, then cancel.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        cancel_handle.cancel();

        // The guard is still held: the install must observe its token and
        // return promptly instead of waiting for the lock holder to finish.
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), install)
            .await
            .expect("install task did not finish after cancel while the driver lock was still held")
            .expect("install task panicked");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains(AGENT_DOWNLOAD_CANCELED_ERROR));
        // Cancellation observed while waiting on the lock must never persist state.
        assert!(!manager.load_state().installed_drivers.contains_key(db_type));
        drop(_guard);
        drop(lock);
        assert!(manager.driver_operation_locks.lock().unwrap().is_empty());
        manager.finish_install_cancellation(db_type, &cancel_handle).await;
    }

    #[tokio::test]
    async fn cancelled_install_aborts_while_waiting_for_jre_lock() {
        let manager = std::sync::Arc::new(test_manager("cancel-jre-lock-wait"));
        let db_type = "oracle";
        let registry = registry_with_jre_version("21.0.12");
        let cancellation = manager.begin_install_cancellation(&install_cancellation_key("jre-lock-wait")).await;
        let cancel_handle = Arc::clone(&cancellation);
        // Hold the JRE lock so the install blocks on it before downloading.
        let lock = jre_operation_lock(&manager, DEFAULT_JRE_KEY);
        let _guard = lock.lock().await;

        let install_manager = Arc::clone(&manager);
        let install = tokio::spawn(async move {
            ensure_jre_from_registry(
                &install_manager,
                &registry,
                DownloadSource::Official,
                DEFAULT_JRE_KEY,
                db_type,
                &|_| {},
                None,
                None,
                &[&cancellation],
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        cancel_handle.cancel();

        // The guard is still held: the JRE wait must abort on the token
        // instead of waiting for the lock holder to finish.
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), install)
            .await
            .expect("JRE wait did not finish after cancel while the JRE lock was still held")
            .expect("JRE wait panicked");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains(AGENT_DOWNLOAD_CANCELED_ERROR));
        // Nothing must have been downloaded or persisted.
        assert!(!manager.jre_dir(DEFAULT_JRE_KEY).exists());
        assert!(manager.load_state().jre_versions.is_empty());
        drop(_guard);
        drop(lock);
        assert!(manager.jre_install_locks.lock().unwrap().is_empty());
        manager.finish_install_cancellation(&install_cancellation_key("jre-lock-wait"), &cancel_handle).await;
    }

    #[tokio::test]
    async fn download_with_progress_aborts_before_response_headers_when_cancelled() {
        use tokio::io::AsyncReadExt;
        let manager = test_manager("cancel-stalled-headers");
        let db_type = "oracle";
        let token = manager.begin_install_cancellation(db_type).await;
        // A mirror that accepts connections but never sends response headers -
        // without racing `request.send()` against cancellation the install
        // would hang here until the 300s client timeout.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/stalled-agent");
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                // Read the request, then never respond.
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let _ = socket.read(&mut buf).await;
            }
        });

        let dest = manager.base_dir().join("downloads").join("oracle-agent");
        let dest_assert = dest.clone();
        let token_for_task = Arc::clone(&token);
        let task = tokio::spawn(async move {
            download_with_progress(
                &manager,
                &|_| {},
                "driver",
                DownloadSource::Official,
                &url,
                "agents/drivers/dbx-agent-oracle",
                &dest,
                256 * 1024,
                None,
                None,
                Some(db_type),
                None,
                None,
                &[&token_for_task],
            )
            .await
        });
        // The request is now pending on the stalled mirror; cancel must abort
        // it long before the 300s timeout.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        token.cancel();

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("download did not abort after cancel while response headers were stalled")
            .expect("download task panicked");
        server.abort();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains(AGENT_DOWNLOAD_CANCELED_ERROR));
        assert!(!download_temp_path(&dest_assert).exists());
        assert!(!dest_assert.exists());
    }

    #[tokio::test]
    async fn fetch_registry_aborts_when_cancelled_while_request_stalled() {
        use tokio::io::AsyncReadExt;
        let _test_guard = ENSURE_AGENT_TEST_LOCK.lock().await;
        invalidate_registry_cache().await;
        let manager = test_manager("cancel-registry-stalled-headers");
        let token = manager.begin_install_cancellation("registry-fetch").await;
        // A registry mirror that accepts connections but never sends response
        // headers - without racing `request.send()` against cancellation the
        // registry fetch would hang until the 10s client timeout.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/stalled-registry.json");
        let server = tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            // Read the request, then never respond.
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let _ = socket.read(&mut buf).await;
        });

        let token_for_task = Arc::clone(&token);
        let task = tokio::spawn(async move {
            let urls = vec![url];
            fetch_registry_from_urls(DownloadSource::Official, &urls, &[token_for_task.as_ref()]).await
        });
        // The request is now pending on the stalled mirror; cancel must abort
        // it long before the 10s client timeout.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        token.cancel();

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("registry fetch did not abort after cancel while response headers were stalled")
            .expect("registry fetch task panicked");
        server.abort();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains(AGENT_DOWNLOAD_CANCELED_ERROR));
    }

    #[tokio::test]
    async fn fetch_registry_aborts_when_cancelled_while_body_stalled() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let _test_guard = ENSURE_AGENT_TEST_LOCK.lock().await;
        invalidate_registry_cache().await;
        let manager = test_manager("cancel-registry-stalled-body");
        let token = manager.begin_install_cancellation("registry-fetch").await;
        // A registry mirror that sends response headers plus a small partial
        // body, then stalls before satisfying Content-Length - without racing
        // `resp.json()` against cancellation the registry fetch would hang
        // until the 10s client timeout.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/partial-registry.json");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let header = "HTTP/1.1 200 OK\r\nContent-Length: 65536\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n";
            socket.write_all(header.as_bytes()).await.expect("write header");
            // A truncated JSON body: the client keeps waiting for the remaining
            // bytes to satisfy Content-Length.
            socket.write_all(b"{\"drivers\": {}}").await.expect("write partial body");
            let mut drain = [0u8; 1024];
            let _ = socket.read(&mut drain).await;
        });

        let token_for_task = Arc::clone(&token);
        let task = tokio::spawn(async move {
            let urls = vec![url];
            fetch_registry_from_urls(DownloadSource::Official, &urls, &[token_for_task.as_ref()]).await
        });
        // The body parse is now waiting on the stalled mirror; cancel must
        // abort it during parsing, not after the 10s client timeout.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        token.cancel();

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("registry fetch did not abort after cancel while the response body was stalled")
            .expect("registry fetch task panicked");
        server.abort();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains(AGENT_DOWNLOAD_CANCELED_ERROR));
    }

    #[tokio::test]
    async fn fetch_registry_precancelled_token_aborts_before_any_network_attempt() {
        let _test_guard = ENSURE_AGENT_TEST_LOCK.lock().await;
        invalidate_registry_cache().await;
        let manager = test_manager("cancel-registry-prefired");
        let token = manager.begin_install_cancellation("registry-fetch").await;
        token.cancel();

        // Point at a port that would refuse/never answer: the entry check must
        // abort before any network attempt, so the result is the cancel error,
        // not a connection/timeout error.
        let urls = vec!["http://127.0.0.1:1/stalled-registry.json".to_string()];
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fetch_registry_from_urls(DownloadSource::Official, &urls, &[token.as_ref()]),
        )
        .await
        .expect("pre-cancelled registry fetch must return immediately")
        .expect_err("pre-cancelled token must abort the registry fetch");
        assert!(result.contains(AGENT_DOWNLOAD_CANCELED_ERROR));
    }

    #[tokio::test]
    async fn concurrent_same_driver_installs_cancel_only_the_targeted_operation() {
        let _test_guard = ENSURE_AGENT_TEST_LOCK.lock().await;
        let manager = std::sync::Arc::new(test_manager("concurrent-same-driver-cancel"));
        let db_type = "oracle";
        let version = "0.1.31";
        let native_url = "https://example.com/dbx-agent-oracle";
        let native_bytes = b"native-agent";
        let registry = registry_with_native_and_legacy_jar(db_type, version, native_url, native_bytes.len() as u64);
        write_cached_driver_download(
            &manager,
            db_type,
            version,
            native_url,
            &manager.driver_native_path(db_type),
            native_bytes,
        );
        cache_test_registry(registry).await;

        // Two independent operations for the SAME driver, each with its own
        // operation id and therefore its own cancellation token.
        let op_a = "operation-a";
        let op_b = "operation-b";
        let token_a = manager.begin_install_cancellation(&install_cancellation_key(op_a)).await;
        let token_b = manager.begin_install_cancellation(&install_cancellation_key(op_b)).await;

        // Hold the driver lock so both installs block on it.
        let lock = driver_operation_lock(&manager, db_type);
        let _guard = lock.lock().await;

        let manager_a = Arc::clone(&manager);
        let manager_b = Arc::clone(&manager);
        let token_a_task = Arc::clone(&token_a);
        let token_b_task = Arc::clone(&token_b);
        let install_a = tokio::spawn(async move {
            install_agent_driver_from_claimed(&manager_a, db_type, DownloadSource::Cnb, |_| {}, &token_a_task).await
        });
        let install_b = tokio::spawn(async move {
            install_agent_driver_from_claimed(&manager_b, db_type, DownloadSource::Cnb, |_| {}, &token_b_task).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Cancel operation A only; operation B must be unaffected.
        cancel_agent_driver_install(&manager, db_type, Some(op_a)).await.unwrap();
        assert!(!token_b.is_cancelled(), "cancelling operation A must not cancel operation B");
        drop(_guard);

        let result_a = tokio::time::timeout(std::time::Duration::from_secs(5), install_a)
            .await
            .expect("install A did not finish after cancel")
            .expect("install A panicked");
        assert!(result_a.is_err());
        assert!(result_a.unwrap_err().contains(AGENT_DOWNLOAD_CANCELED_ERROR));

        let result_b = tokio::time::timeout(std::time::Duration::from_secs(5), install_b)
            .await
            .expect("install B did not finish")
            .expect("install B panicked");
        assert!(result_b.is_ok(), "operation A's cancel must not abort operation B: {:?}", result_b.err());

        // Only the completed operation B persists installed state.
        assert_eq!(manager.load_state().installed_drivers[db_type].version, version);
        manager.finish_install_cancellation(&install_cancellation_key(op_a), &token_a).await;
        manager.finish_install_cancellation(&install_cancellation_key(op_b), &token_b).await;
    }

    #[tokio::test]
    async fn registry_install_rejects_corrupt_downloaded_jar() {
        let manager = test_manager("corrupt-jar");
        let db_type = "h2";
        let version = "0.2.0";
        let jar_url = "https://example.com/dbx-agent-h2.jar";
        let jar_bytes = b"jar";
        let registry = registry_with_jar(db_type, version, jar_url, jar_bytes.len() as u64);
        let jar_path = manager.driver_jar_path(db_type);
        let cache_path = write_cached_driver_download(&manager, db_type, version, jar_url, &jar_path, jar_bytes);
        manager
            .save_state(&crate::agent_manager::AgentState {
                java_runtime: JavaRuntimeConfig { mode: JavaRuntimeMode::System, custom_java_path: None },
                ..Default::default()
            })
            .unwrap();
        let progress = |_| {};

        let err = install_agent_driver_from_registry(
            &manager,
            &registry,
            DownloadSource::Official,
            db_type,
            &progress,
            None,
            None,
            &[],
        )
        .await
        .unwrap_err();

        assert!(err.contains("invalid or corrupt"));
        assert!(cache_path.exists());
        assert!(!jar_path.exists());
        assert!(!manager.load_state().installed_drivers.contains_key(db_type));
    }

    #[tokio::test]
    async fn offline_zip_rejects_a_cross_platform_java_dependency_before_install_changes() {
        let platform = AgentManager::current_platform();
        let foreign_platform = if platform == "linux-x64" { "macos-x64" } else { "linux-x64" };
        let jre_key = "temurin-21";
        let jar_name = "dbx-agent-h2.jar";
        let jre_name = format!("dbx-jre-{jre_key}-{foreign_platform}.tar.gz");
        let jar_bytes = test_agent_jar();
        let jre_bytes = b"foreign-jre".to_vec();
        let registry = AgentRegistry {
            jre: None,
            jres: [(
                jre_key.to_string(),
                JreInfo {
                    version: "21.0.7".to_string(),
                    platforms: [(
                        foreign_platform.to_string(),
                        ArtifactInfo {
                            url: format!("offline://{jre_name}"),
                            sha256: Some(sha256_bytes(&jre_bytes)),
                            size: jre_bytes.len() as u64,
                            format: None,
                        },
                    )]
                    .into_iter()
                    .collect(),
                },
            )]
            .into_iter()
            .collect(),
            drivers: [(
                "h2".to_string(),
                DriverInfo {
                    version: "1.0.0".to_string(),
                    label: "H2".to_string(),
                    min_app_version: "0.1.0".to_string(),
                    jar: Some(ArtifactInfo {
                        url: format!("offline://{jar_name}"),
                        sha256: Some(sha256_bytes(&jar_bytes)),
                        size: jar_bytes.len() as u64,
                        format: None,
                    }),
                    native: std::collections::HashMap::new(),
                    jre: jre_key.to_string(),
                },
            )]
            .into_iter()
            .collect(),
        };
        let (_package_dir, package) = write_offline_zip(
            &registry,
            &[(format!("drivers/{jar_name}"), jar_bytes), (format!("jre/{jre_name}"), jre_bytes)],
        );

        let inspect_error = inspect_offline_zip(&package).unwrap_err();
        assert!(inspect_error.contains("does not support the current platform"), "unexpected error: {inspect_error}");

        let manager = test_manager("offline-cross-platform-java");
        let existing_jar = manager.driver_jar_path("h2");
        std::fs::create_dir_all(existing_jar.parent().unwrap()).unwrap();
        std::fs::write(&existing_jar, b"existing-driver").unwrap();
        manager
            .mutate_state(|state| {
                state.installed_drivers.insert(
                    "h2".to_string(),
                    InstalledDriver {
                        version: "9.9.9".to_string(),
                        installed_at: "before".to_string(),
                        jre: jre_key.to_string(),
                    },
                );
            })
            .unwrap();

        let import_error = import_offline_zip(&manager, &package, |_| {}).await.unwrap_err();
        assert!(import_error.contains("does not support the current platform"), "unexpected error: {import_error}");
        assert_eq!(std::fs::read(existing_jar).unwrap(), b"existing-driver");
        assert_eq!(manager.load_state().installed_drivers["h2"].version, "9.9.9");
        assert!(!manager.jre_dir(jre_key).exists());
    }

    #[test]
    fn offline_zip_rejects_a_java_dependency_missing_from_a_registry_with_jre_metadata() {
        let platform = AgentManager::current_platform();
        let jar_name = "dbx-agent-h2.jar";
        let jar_bytes = test_agent_jar();
        let unrelated_jre_name = format!("dbx-jre-temurin-17-{platform}.tar.gz");
        let unrelated_jre_bytes = b"unrelated-jre".to_vec();
        let registry = AgentRegistry {
            jre: None,
            jres: [(
                "temurin-17".to_string(),
                JreInfo {
                    version: "17.0.15".to_string(),
                    platforms: [(
                        platform.to_string(),
                        ArtifactInfo {
                            url: format!("offline://{unrelated_jre_name}"),
                            sha256: Some(sha256_bytes(&unrelated_jre_bytes)),
                            size: unrelated_jre_bytes.len() as u64,
                            format: None,
                        },
                    )]
                    .into_iter()
                    .collect(),
                },
            )]
            .into_iter()
            .collect(),
            drivers: [(
                "h2".to_string(),
                DriverInfo {
                    version: "1.0.0".to_string(),
                    label: "H2".to_string(),
                    min_app_version: "0.1.0".to_string(),
                    jar: Some(ArtifactInfo {
                        url: format!("offline://{jar_name}"),
                        sha256: Some(sha256_bytes(&jar_bytes)),
                        size: jar_bytes.len() as u64,
                        format: None,
                    }),
                    native: std::collections::HashMap::new(),
                    jre: "temurin-21".to_string(),
                },
            )]
            .into_iter()
            .collect(),
        };
        let (_package_dir, package) = write_offline_zip(
            &registry,
            &[(format!("drivers/{jar_name}"), jar_bytes), (format!("jre/{unrelated_jre_name}"), unrelated_jre_bytes)],
        );

        let error = inspect_offline_zip(&package).unwrap_err();
        assert!(error.contains("missing from the package registry"), "unexpected error: {error}");
    }

    #[test]
    fn offline_zip_rejects_registry_size_and_sha256_tampering() {
        let platform = AgentManager::current_platform();
        let entry_name = format!("dbx-agent-h2-{platform}");
        let original = b"native-bytes".to_vec();
        let tampered = b"native-byteS".to_vec();
        assert_eq!(original.len(), tampered.len());

        let registry_with = |size, sha256: String| AgentRegistry {
            jre: None,
            jres: std::collections::HashMap::new(),
            drivers: [(
                "h2".to_string(),
                DriverInfo {
                    version: "1.0.0".to_string(),
                    label: "H2".to_string(),
                    min_app_version: "0.1.0".to_string(),
                    jar: None,
                    native: [(
                        platform.to_string(),
                        ArtifactInfo {
                            url: format!("offline://{entry_name}"),
                            sha256: Some(sha256),
                            size,
                            format: None,
                        },
                    )]
                    .into_iter()
                    .collect(),
                    jre: DEFAULT_JRE_KEY.to_string(),
                },
            )]
            .into_iter()
            .collect(),
        };

        let size_registry = registry_with((original.len() + 1) as u64, sha256_bytes(&original));
        let (_size_dir, size_package) =
            write_offline_zip(&size_registry, &[(format!("drivers/{entry_name}"), original.clone())]);
        let size_error = inspect_offline_zip(&size_package).unwrap_err();
        assert!(size_error.contains("size mismatch"), "unexpected error: {size_error}");

        let sha_registry = registry_with(original.len() as u64, sha256_bytes(&original));
        let (_sha_dir, sha_package) = write_offline_zip(&sha_registry, &[(format!("drivers/{entry_name}"), tampered)]);
        let sha_error = inspect_offline_zip(&sha_package).unwrap_err();
        assert!(sha_error.contains("SHA-256 mismatch"), "unexpected error: {sha_error}");
    }

    #[test]
    fn offline_zip_resolves_a_hyphenated_jre_key_from_the_registry_basename() {
        let platform = AgentManager::current_platform();
        let jre_key = "temurin-21";
        let jar_name = "dbx-agent-h2.jar";
        let jre_name = format!("dbx-jre-{jre_key}-21.0.7-{platform}.tar.gz");
        let jar_bytes = test_agent_jar();
        let jre_bytes = b"current-jre".to_vec();
        let registry = AgentRegistry {
            jre: None,
            jres: [(
                jre_key.to_string(),
                JreInfo {
                    version: "21.0.7".to_string(),
                    platforms: [(
                        platform.to_string(),
                        ArtifactInfo {
                            url: format!("offline://{jre_name}"),
                            sha256: Some(sha256_bytes(&jre_bytes)),
                            size: jre_bytes.len() as u64,
                            format: None,
                        },
                    )]
                    .into_iter()
                    .collect(),
                },
            )]
            .into_iter()
            .collect(),
            drivers: [(
                "h2".to_string(),
                DriverInfo {
                    version: "1.0.0".to_string(),
                    label: "H2".to_string(),
                    min_app_version: "0.1.0".to_string(),
                    jar: Some(ArtifactInfo {
                        url: format!("offline://{jar_name}"),
                        sha256: Some(sha256_bytes(&jar_bytes)),
                        size: jar_bytes.len() as u64,
                        format: None,
                    }),
                    native: std::collections::HashMap::new(),
                    jre: jre_key.to_string(),
                },
            )]
            .into_iter()
            .collect(),
        };
        let (_package_dir, package) = write_offline_zip(
            &registry,
            &[(format!("drivers/{jar_name}"), jar_bytes), (format!("jre/{jre_name}"), jre_bytes)],
        );

        let plan = inspect_offline_zip(&package).unwrap();
        assert_eq!(plan.driver_keys, vec!["h2"]);
        assert!(plan.includes_jre);
    }

    #[test]
    fn offline_zip_keeps_legacy_jar_and_jre_entries_compatible_without_integrity_metadata() {
        let platform = AgentManager::current_platform();
        let jar_name = "dbx-agent-h2.jar";
        let jre_name = format!("jre-21-{platform}.tar.gz");
        let jar_bytes = test_agent_jar();
        let registry = registry_with_jar("h2", "1.0.0", &format!("offline://{jar_name}"), jar_bytes.len() as u64);
        let (_package_dir, package) = write_offline_zip(
            &registry,
            &[(format!("drivers/{jar_name}"), jar_bytes), (format!("jre/{jre_name}"), b"legacy-jre".to_vec())],
        );

        let plan = inspect_offline_zip(&package).unwrap();
        assert_eq!(plan.driver_keys, vec!["h2"]);
        assert!(plan.includes_jre);
    }

    #[tokio::test]
    async fn offline_import_exclusive_lock_waits_for_in_flight_driver_operation() {
        let manager = test_manager("offline-import-lock");
        // Simulate an in-flight driver operation holding a read lock.
        let driver_guard = manager.installation_operation_lock.read().await;
        // import_offline_zip acquires the write lock — it must wait.
        let blocked =
            tokio::time::timeout(std::time::Duration::from_millis(50), manager.installation_operation_lock.write())
                .await;
        assert!(blocked.is_err(), "offline import entered before an in-flight driver operation completed");

        drop(driver_guard);
        let _offline_guard =
            tokio::time::timeout(std::time::Duration::from_secs(1), manager.installation_operation_lock.write())
                .await
                .expect("offline import did not resume after driver operations completed");
    }
}

#[cfg(test)]
mod jre_dir_remove_tests {
    use super::*;

    fn unique_tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("dbx-jre-remove-{name}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn remove_returns_ok_when_path_missing() {
        let path = unique_tmp("missing");
        assert!(!path.exists());
        assert!(remove_jre_dir_with_retry(&path).is_ok());
    }

    #[test]
    fn remove_deletes_existing_dir() {
        let dir = unique_tmp("happy");
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::write(dir.join("bin").join("java"), b"x").unwrap();
        assert!(dir.exists());
        remove_jre_dir_with_retry(&dir).expect("happy path delete");
        assert!(!dir.exists());
    }

    #[test]
    fn windows_error_message_lists_root_causes_and_path() {
        let path = PathBuf::from("/tmp/dbx-jre-test");
        let err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "拒绝访问。 (os error 5)");
        let rendered = format_jre_dir_remove_error(&path, &err);
        assert!(rendered.contains(&path.display().to_string()), "missing path: {rendered}");
        assert!(rendered.contains("(original error:"), "missing original error wrapper: {rendered}");
        assert!(rendered.contains("拒绝访问"), "missing original error text: {rendered}");
        if cfg!(windows) {
            assert!(rendered.starts_with("Failed to remove the old JRE directory:"), "wrong prefix: {rendered}");
            assert!(rendered.contains("java process still holds the directory"), "missing process advice: {rendered}");
            assert!(rendered.contains("restart dbx and try again"), "missing restart advice: {rendered}");
        } else {
            // POSIX path: short form, no Windows-specific advice.
            assert!(rendered.contains("Failed to remove the old JRE directory"));
            assert!(!rendered.contains("antivirus"));
        }
    }

    #[test]
    #[cfg(windows)]
    fn stash_old_jre_dir_renames_and_is_unique() {
        let base = unique_tmp("stash-unique");
        std::fs::create_dir_all(&base).unwrap();
        let jre_a = base.join("jre-21");
        std::fs::create_dir_all(&jre_a).unwrap();
        let stash_a = stash_old_jre_dir(&jre_a).expect("first stash");
        assert!(stash_a.exists(), "stash dir should exist after rename");
        assert!(!jre_a.exists(), "original dir should be gone after rename");

        // Recreate original and stash again — name must differ.
        std::fs::create_dir_all(&jre_a).unwrap();
        let stash_b = stash_old_jre_dir(&jre_a).expect("second stash");
        assert_ne!(stash_a, stash_b, "stash names must be unique across calls");

        // Cleanup.
        let _ = std::fs::remove_dir_all(&base);
    }
}
