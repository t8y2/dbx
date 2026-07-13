use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::agent_catalog;
use crate::agent_manager::{
    AgentDriverInfo, AgentManager, AgentRegistry, InstalledDriver, JavaRuntimeMode, DEFAULT_JRE_KEY,
};
use crate::DownloadSource;

/// Number of attempts to delete a JRE directory before giving up (Windows
/// experiences transient `ERROR_ACCESS_DENIED` when java.exe is still mapped
/// or anti-virus is scanning the archive). POSIX returns 1 — `unlink` of an
/// in-use file always succeeds.
const JRE_REMOVE_ATTEMPTS: usize = if cfg!(windows) { 6 } else { 1 };

/// Exponential-ish backoff between retries. Total wait ≈ 1.55s on Windows.
const JRE_REMOVE_BACKOFF_MS: &[u64] = &[50, 100, 200, 400, 400, 400];

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

/// Render a friendly Chinese error message when the old JRE directory cannot
/// be replaced. On Windows, lists likely culprits (process holding java.exe,
/// AV scanning) and suggests restarting dbx; on POSIX returns a concise
/// message. The original OS error is appended in parentheses for support.
fn format_jre_dir_remove_error(path: &Path, os_err: &std::io::Error) -> String {
    if cfg!(windows) {
        format!(
            "无法删除旧的 JRE 目录：{}\n\
             可能的原因：\n  \
             - 仍有 dbx Agent / java 进程占用该目录\n  \
             - 防病毒软件正在扫描\n\
             请关闭可能持有该目录的进程，或重启 dbx 后重试。\n\
             （原始错误：{os_err}）",
            path.display()
        )
    } else {
        format!("无法删除旧的 JRE 目录：{}（原始错误：{os_err}）", path.display())
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
fn replace_old_jre_dir(am: &AgentManager, path: &Path) -> Result<Option<PathBuf>, String> {
    match remove_jre_dir_with_retry(path) {
        Ok(()) => Ok(None),
        Err(remove_err) => {
            #[cfg(windows)]
            {
                match stash_old_jre_dir(path) {
                    Ok(stash) => {
                        log::warn!("remove_dir_all failed, stashed old JRE at {} ({remove_err})", stash.display());
                        // Persist immediately so a crash before extraction
                        // still leaves the stash recorded for cleanup.
                        let mut state = am.load_state();
                        state.pending_jre_cleanup.push(stash.clone());
                        if let Err(save_err) = am.save_state(&state) {
                            log::warn!("Failed to persist pending_jre_cleanup: {save_err}");
                        }
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
                let _ = am; // silence unused warning on POSIX
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
    pub failed: Vec<AgentDriverUpdateIssue>,
}

impl AgentProgressEvent {
    pub fn step(step: impl Into<String>) -> Self {
        Self { step: step.into(), downloaded: None, total: None, db_type: None, current: None, total_drivers: None }
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
}

pub fn build_agent_list(am: &AgentManager, registry: Option<&AgentRegistry>) -> Vec<AgentDriverInfo> {
    let local_state = am.load_state();
    let use_managed_jre = local_state.java_runtime.mode == JavaRuntimeMode::Managed;
    agent_catalog::driver_store_entries()
        .map(|(key, label)| {
            let jar_valid = am.is_driver_jar_valid(key);
            let native_installed = am.driver_native_path(key).exists();
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
                size: remote.and_then(driver_download_artifact).map(|artifact| artifact.size).unwrap_or(0),
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

fn driver_download_artifact(driver: &crate::agent_manager::DriverInfo) -> Option<&crate::agent_manager::ArtifactInfo> {
    driver.native.get(AgentManager::current_platform()).or(driver.jar.as_ref())
}

fn remote_driver_requires_java_runtime(driver: &crate::agent_manager::DriverInfo) -> bool {
    driver.jar.is_some() && !driver.native.contains_key(AgentManager::current_platform())
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
    let jar_path = am.driver_jar_path(db_type);
    let parent = jar_path.parent().ok_or_else(|| format!("Invalid driver path: {}", jar_path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    std::fs::copy(&source, &jar_path).map_err(|e| format!("Failed to copy local agent jar: {e}"))?;
    if !am.is_driver_jar_valid(db_type) {
        std::fs::remove_file(&jar_path).ok();
        return Err(format!("Local agent jar is invalid or corrupt: {}", source.display()));
    }

    let mut local_state = am.load_state();
    local_state.installed_drivers.insert(
        db_type.to_string(),
        InstalledDriver {
            version: "0.1.0-local".to_string(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            jre: DEFAULT_JRE_KEY.to_string(),
        },
    );
    am.save_state(&local_state)
}

pub async fn fetch_registry() -> Result<AgentRegistry, String> {
    fetch_registry_from(DownloadSource::Official).await
}

pub async fn fetch_registry_from(source: DownloadSource) -> Result<AgentRegistry, String> {
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
    let resp = open_download_response(&client, source, REGISTRY_PATH, REGISTRY_R2_PATH, "dbx-agent-manager")
        .await
        .map_err(|err| format!("Failed to fetch agent registry: {err}"))?;
    let registry: AgentRegistry = resp.json().await.map_err(|err| format!("Failed to parse registry: {err}"))?;
    REGISTRY_CACHE.lock().await.insert(source, (std::time::Instant::now(), registry.clone()));
    Ok(registry)
}

async fn open_download_response(
    client: &reqwest::Client,
    source: DownloadSource,
    github_url: &str,
    r2_path: &str,
    user_agent: &str,
) -> Result<reqwest::Response, String> {
    let mut errors = Vec::new();
    for url in source.download_candidate_urls(github_url, r2_path)? {
        match client
            .get(&url)
            .header(reqwest::header::USER_AGENT, user_agent)
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .and_then(|response| response.error_for_status())
        {
            Ok(response) => return Ok(response),
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

pub async fn install_agent_driver_from(
    am: &AgentManager,
    db_type: &str,
    source: DownloadSource,
    progress: impl Fn(AgentProgressEvent),
) -> Result<(), String> {
    install_agent_driver_with_batch(am, db_type, source, &progress, None, None).await
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
    let agents = build_agent_list(am, Some(&registry));
    let updatable: Vec<&AgentDriverInfo> = agents.iter().filter(|agent| agent.update_available).collect();
    let total = updatable.len() as u32;
    let mut result = UpgradeAllAgentDriversResult::default();

    for (index, agent) in updatable.iter().enumerate() {
        match install_agent_driver_from_registry(
            am,
            &registry,
            source,
            &agent.db_type,
            &progress,
            Some((index + 1) as u32),
            Some(total),
        )
        .await
        {
            Ok(()) => result.upgraded += 1,
            Err(error) => {
                log::warn!("Failed to update {} agent driver: {}", agent.db_type, error);
                result.failed.push(AgentDriverUpdateIssue { db_type: agent.db_type.clone(), error });
            }
        }
    }

    progress(AgentProgressEvent::step("all-done"));
    Ok(result)
}

pub async fn uninstall_agent_driver(am: &AgentManager, db_type: &str) -> Result<(), String> {
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
    let mut local_state = am.load_state();
    local_state.installed_drivers.remove(db_type);
    am.save_state(&local_state)?;
    am.stop_daemon_by_key(db_type).await;
    Ok(())
}

pub fn clear_agent_download_cache(am: &AgentManager) -> Result<(), String> {
    remove_download_cache_entries(am, |_| true, "download cache")
}

pub async fn uninstall_agent_jre(am: &AgentManager, jre_key: &str) -> Result<(), String> {
    let local_state = am.load_state();
    let dependents: Vec<&str> = local_state
        .installed_drivers
        .iter()
        .filter(|(_, driver)| driver.jre == jre_key)
        .map(|(k, _)| k.as_str())
        .collect();
    if !dependents.is_empty() {
        return Err(format!("JRE {} 正在被以下驱动使用: {}，请先卸载这些驱动", jre_key, dependents.join(", ")));
    }
    // Stop daemons first so any java.exe holding the JRE files exits before
    // we try to remove the directory (Windows ERROR_ACCESS_DENIED otherwise).
    am.stop_daemons().await;
    let jre_dir = am.jre_dir(jre_key);
    if let Err(err) = remove_jre_dir_with_retry(&jre_dir) {
        return Err(format_jre_dir_remove_error(&jre_dir, &err));
    }
    let mut local_state = am.load_state();
    local_state.jre_versions.remove(jre_key);
    am.save_state(&local_state)?;
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
    let registry = fetch_registry_from(source).await?;
    let jre_info = registry.resolve_jre(jre_key).ok_or_else(|| format!("No JRE definition for version: {jre_key}"))?;
    let platform = AgentManager::current_platform();
    let platform_jre = jre_info
        .platforms
        .get(platform)
        .ok_or_else(|| format!("No JRE {jre_key} available for platform: {platform}"))?;
    let jre_archive = am.base_dir().join("jre-download.tar.gz");
    download_with_progress(
        am,
        &progress,
        "jre",
        source,
        &platform_jre.url,
        &r2_path_with_cache_buster(&github_url_to_r2_path(&platform_jre.url, "jre"), &jre_info.version),
        &jre_archive,
        platform_jre.size,
        Some(CacheIdentity::Jre { key: jre_key, version: &jre_info.version }),
        None,
        None,
        None,
    )
    .await?;
    let jre_dir = am.jre_dir(jre_key);
    // Stop daemons before deleting so java.exe processes release file
    // handles on Windows (Issue #1100). Falls back to a rename-stash if the
    // directory still cannot be removed.
    am.stop_daemons().await;
    replace_old_jre_dir(am, &jre_dir)?;
    extract_tar_gz(&jre_archive, &jre_dir)?;
    std::fs::remove_file(&jre_archive).ok();
    let mut local_state = am.load_state();
    local_state.jre_versions.insert(jre_key.to_string(), jre_info.version.clone());
    am.save_state(&local_state)?;
    cleanup_jre_download_cache_after_success(am, jre_key);
    progress(AgentProgressEvent::step("done"));
    Ok(())
}

pub fn import_agents_from_zip(
    am: &AgentManager,
    zip_path: &Path,
    progress: impl Fn(AgentProgressEvent),
) -> Result<OfflineImportResult, String> {
    import_offline_zip(am, zip_path, |p| {
        progress(AgentProgressEvent {
            step: p.step,
            downloaded: Some(p.current as u64),
            total: Some(p.total as u64),
            db_type: Some(p.label),
            current: Some(p.current),
            total_drivers: Some(p.total),
        });
    })
}

async fn install_agent_driver_with_batch(
    am: &AgentManager,
    db_type: &str,
    source: DownloadSource,
    progress: &impl Fn(AgentProgressEvent),
    current: Option<u32>,
    total_drivers: Option<u32>,
) -> Result<(), String> {
    match fetch_registry_from(source).await {
        Ok(registry) => {
            match install_agent_driver_from_registry(am, &registry, source, db_type, progress, current, total_drivers)
                .await
            {
                Ok(()) => Ok(()),
                Err(registry_err) => {
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
                        )
                        .await?;
                        return Ok(());
                    }
                    Err(registry_err)
                }
            }
        }
        Err(registry_err) => {
            if let Some(local_jar) = find_local_agent_jar(db_type) {
                install_local_agent(am, db_type, local_jar)?;
                am.stop_daemon_by_key(db_type).await;
                progress(AgentProgressEvent::step("done"));
                return Ok(());
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
) -> Result<(), String> {
    let jre_info = registry.resolve_jre(jre_key).ok_or_else(|| format!("No JRE definition for version: {jre_key}"))?;
    let platform = AgentManager::current_platform();
    let platform_jre = jre_info
        .platforms
        .get(platform)
        .ok_or_else(|| format!("No JRE {jre_key} available for platform: {platform}"))?;
    let jre_archive = am.base_dir().join("jre-download.tar.gz");
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
        Some(CacheIdentity::Jre { key: jre_key, version: &jre_info.version }),
        Some(db_type),
        current,
        total_drivers,
    )
    .await?;
    progress(AgentProgressEvent::transfer("jre-extract", 0, 0).with_batch(Some(db_type), current, total_drivers));
    let jre_dir = am.jre_dir(jre_key);
    // Stop daemons first (Windows ERROR_ACCESS_DENIED, Issue #1100).
    am.stop_daemons().await;
    replace_old_jre_dir(am, &jre_dir)?;
    extract_tar_gz(&jre_archive, &jre_dir)?;
    std::fs::remove_file(&jre_archive).ok();
    cleanup_jre_download_cache_after_success(am, jre_key);
    Ok(())
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
) -> Result<(), String> {
    let jre_key = DEFAULT_JRE_KEY;
    if jre_needs_install(am, registry, jre_key) {
        ensure_jre_from_registry(am, registry, source, jre_key, db_type, progress, current, total_drivers).await?;
    }
    install_local_agent(am, db_type, local_jar)?;
    if let Some(jre_info) = registry.resolve_jre(jre_key) {
        let mut local_state = am.load_state();
        local_state.jre_versions.insert(jre_key.to_string(), jre_info.version.clone());
        am.save_state(&local_state)?;
    }
    am.stop_daemon_by_key(db_type).await;
    progress(AgentProgressEvent::step("done"));
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
            )
            .await?;
            return Ok(());
        }
        return Err(format!("Unknown driver type: {db_type}"));
    };
    let jre_key = &driver.jre;
    let native_artifact = driver.native.get(AgentManager::current_platform());
    let jar_artifact = driver.jar.as_ref();
    let requires_java_runtime = native_artifact.is_none();
    let needs_jre = requires_java_runtime && jre_needs_install(am, registry, jre_key);

    if needs_jre {
        ensure_jre_from_registry(am, registry, source, jre_key, db_type, progress, current, total_drivers).await?;
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
        &target_path,
        artifact.size,
        Some(CacheIdentity::Driver { db_type, version: &driver.version }),
        Some(db_type),
        current,
        total_drivers,
    )
    .await?;
    // Some drivers publish both a native agent and a legacy JAR fallback. Only
    // validate the artifact type that was actually installed.
    if !is_native_artifact && !am.is_driver_jar_valid(db_type) {
        std::fs::remove_file(&target_path).ok();
        return Err(format!("Downloaded driver jar is invalid or corrupt: {}", target_path.display()));
    }
    if is_native_artifact {
        mark_executable(&target_path)?;
        std::fs::remove_file(am.driver_jar_path(db_type)).ok();
    } else {
        std::fs::remove_file(am.driver_native_path(db_type)).ok();
    }

    let mut local_state = am.load_state();
    if requires_java_runtime {
        if let Some(jre_info) = registry.resolve_jre(jre_key) {
            local_state.jre_versions.insert(jre_key.clone(), jre_info.version.clone());
        }
    }
    local_state.installed_drivers.insert(
        db_type.to_string(),
        InstalledDriver {
            version: driver.version.clone(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            jre: jre_key.clone(),
        },
    );
    am.save_state(&local_state)?;
    am.stop_daemon_by_key(db_type).await;
    cleanup_driver_download_cache_after_success(am, db_type);
    progress(AgentProgressEvent::step("done"));
    Ok(())
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
    cache_identity: Option<CacheIdentity<'_>>,
    db_type: Option<&str>,
    current: Option<u32>,
    total_drivers: Option<u32>,
) -> Result<(), String> {
    const DOWNLOAD_ATTEMPTS: usize = 4;

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let tmp = download_temp_path(dest);
    let tmp_source = download_source_path(&tmp);
    let cache_path = cached_download_path(am, url, total_size, cache_identity, dest);
    prune_download_cache(am).ok();
    if cached_download_is_valid(am, &cache_path, total_size) {
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
    for attempt in 1..=DOWNLOAD_ATTEMPTS {
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
            progress(AgentProgressEvent::transfer(step, total_size, total_size).with_batch(
                db_type,
                current,
                total_drivers,
            ));
            completed = true;
            break;
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
            while let Some(chunk) = resp.chunk().await.map_err(|err| format!("Download stream error: {err}"))? {
                std::io::Write::write_all(&mut file, &chunk).map_err(|err| format!("Failed to write chunk: {err}"))?;
                downloaded += chunk.len() as u64;
                progress(AgentProgressEvent::transfer(step, downloaded, content_length).with_batch(
                    db_type,
                    current,
                    total_drivers,
                ));
            }
            std::io::Write::flush(&mut file).map_err(|err| format!("Failed to flush temp file: {err}"))
        }
        .await;
        drop(file);

        if let Err(err) = transfer_result {
            last_err = Some(format!("{err} (attempt {attempt}/{DOWNLOAD_ATTEMPTS}, source {source_url})"));
            continue;
        }

        let actual_size = std::fs::metadata(&tmp).map(|meta| meta.len()).unwrap_or(0);
        if total_size == 0 || actual_size == total_size {
            completed = true;
            break;
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
) -> Result<(reqwest::Response, bool, String), String> {
    let mut errors = Vec::new();
    for candidate_url in source.download_candidate_urls(github_url, r2_path)? {
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
        let resp = match request.send().await {
            Ok(resp) => resp,
            Err(err) => {
                errors.push(format!("{candidate_url}: {err}"));
                continue;
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
    cache_identity: Option<CacheIdentity<'_>>,
    dest: &std::path::Path,
) -> std::path::PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    total_size.hash(&mut hasher);
    let identity_hash_key = cache_identity.map(CacheIdentity::hash_key);
    identity_hash_key.hash(&mut hasher);
    let hash = hasher.finish();
    let file_name = dest.file_name().and_then(|name| name.to_str()).unwrap_or("download");
    let prefix = cache_identity.map(CacheIdentity::file_prefix).unwrap_or_else(|| "download".to_string());
    am.download_cache_dir().join(format!("{prefix}-{hash:016x}-{file_name}"))
}

fn cached_download_is_valid(am: &AgentManager, path: &std::path::Path, expected_size: u64) -> bool {
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
    true
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
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct OfflineImportResult {
    pub jre_installed: Vec<String>,
    pub drivers_installed: Vec<String>,
    pub drivers_skipped: Vec<String>,
}

pub fn import_offline_zip(
    am: &AgentManager,
    zip_path: &Path,
    progress: impl Fn(OfflineImportProgress),
) -> Result<OfflineImportResult, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("Failed to open ZIP file: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP file: {e}"))?;

    let registry = read_registry_from_zip(&mut archive)?;

    let platform = AgentManager::current_platform();
    std::fs::create_dir_all(am.base_dir()).map_err(|e| format!("Failed to create agent directory: {e}"))?;
    let mut local_state = am.load_state();
    let mut result =
        OfflineImportResult { jre_installed: Vec::new(), drivers_installed: Vec::new(), drivers_skipped: Vec::new() };

    let jre_entries: Vec<(String, String)> = (0..archive.len())
        .filter_map(|i| {
            let entry = archive.by_index(i).ok()?;
            let name = entry.name().to_string();
            if name.starts_with("jre/") && name.ends_with(".tar.gz") && name.contains(platform) {
                let jre_key = extract_jre_key_from_filename(&name)?;
                Some((jre_key, name))
            } else {
                None
            }
        })
        .collect();

    let driver_entries: Vec<(String, String, bool)> = (0..archive.len())
        .filter_map(|i| {
            let entry = archive.by_index(i).ok()?;
            let name = entry.name().to_string();
            if name.starts_with("drivers/") && name.ends_with(".jar") {
                let db_type = extract_db_type_from_filename(&name)?;
                Some((db_type, name, false))
            } else if name.starts_with("drivers/") {
                let db_type = db_type_for_native_offline_entry(&registry, platform, &name)?;
                Some((db_type, name, true))
            } else {
                None
            }
        })
        .collect();

    let total = (jre_entries.len() + driver_entries.len()) as u32;
    let mut current: u32 = 0;

    for (jre_key, entry_name) in &jre_entries {
        current += 1;
        let jre_version = registry.resolve_jre(jre_key).map(|j| j.version.clone());
        let existing_version = local_state.jre_versions.get(jre_key);
        if am.is_jre_installed(jre_key) && existing_version == jre_version.as_ref() {
            continue;
        }

        progress(OfflineImportProgress { step: "jre-extract".into(), current, total, label: format!("JRE {jre_key}") });

        let mut entry = archive.by_name(entry_name).map_err(|e| format!("Failed to read {entry_name}: {e}"))?;
        let tmp_archive = am.base_dir().join(format!("jre-offline-{jre_key}.tar.gz"));
        {
            let mut out =
                std::fs::File::create(&tmp_archive).map_err(|e| format!("Failed to create temp file: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("Failed to extract JRE archive: {e}"))?;
        }

        let jre_dir = am.jre_dir(jre_key);
        // Daemons cannot be stopped from a sync function safely; the retry +
        // Windows rename fallback in replace_old_jre_dir still handles a
        // locked directory. Daemon shutdown for the foreground install paths
        // happens in `reinstall_agent_jre` and `install_agent_driver_*`.
        replace_old_jre_dir(am, &jre_dir)?;
        extract_tar_gz(&tmp_archive, &jre_dir)?;
        std::fs::remove_file(&tmp_archive).ok();

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
        });

        let driver_path = if *is_native { am.driver_native_path(db_type) } else { am.driver_jar_path(db_type) };
        if let Some(parent) = driver_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut entry = archive.by_name(entry_name).map_err(|e| format!("Failed to read {entry_name}: {e}"))?;
        let mut out = std::fs::File::create(&driver_path).map_err(|e| format!("Failed to write driver: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Failed to copy driver: {e}"))?;
        if *is_native {
            mark_executable(&driver_path)?;
            std::fs::remove_file(am.driver_jar_path(db_type)).ok();
        } else {
            // Offline bundles are user-supplied; reject corrupt JARs before state says the driver is installed.
            if !am.is_driver_jar_valid(db_type) {
                std::fs::remove_file(&driver_path).ok();
                return Err(format!("Offline agent jar is invalid or corrupt: {entry_name}"));
            }
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

    am.save_state(&local_state)?;
    Ok(result)
}

fn read_registry_from_zip(archive: &mut zip::ZipArchive<std::fs::File>) -> Result<AgentRegistry, String> {
    let mut entry = archive
        .by_name("agent-registry.json")
        .map_err(|_| "ZIP 文件中未找到 agent-registry.json，请确认这是有效的离线驱动包".to_string())?;
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

fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let status = crate::process::new_std_command("tar")
        .args(["xzf", &archive.to_string_lossy(), "-C", &dest.to_string_lossy(), "--strip-components=1"])
        .status()
        .map_err(|e| format!("Failed to extract archive: {e}"))?;
    if !status.success() {
        return Err("Failed to extract JRE archive".to_string());
    }
    Ok(())
}

pub fn import_agent_jar(am: &AgentManager, db_type: &str, jar_path: &Path) -> Result<(), String> {
    if !jar_path.exists() {
        return Err(format!("File not found: {}", jar_path.display()));
    }
    install_local_agent(am, db_type, jar_path.to_path_buf())
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
}

#[cfg(test)]
mod agent_registry_install_tests {
    use super::*;
    use crate::agent_manager::{ArtifactInfo, DriverInfo, JavaRuntimeConfig};

    fn test_manager(name: &str) -> AgentManager {
        let dir = std::env::temp_dir().join(format!("dbx-agent-registry-install-{name}-{}", uuid::Uuid::new_v4()));
        AgentManager::new_with_base_dir(dir)
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
                    size: 0,
                }),
                native: [(
                    AgentManager::current_platform().to_string(),
                    ArtifactInfo { url: native_url.to_string(), size: native_size },
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
                jar: Some(ArtifactInfo { url: url.to_string(), size }),
                native: std::collections::HashMap::new(),
            },
        );
        AgentRegistry { jre: None, jres: std::collections::HashMap::new(), drivers }
    }

    fn write_cached_driver_download(
        am: &AgentManager,
        db_type: &str,
        version: &str,
        url: &str,
        dest: &Path,
        bytes: &[u8],
    ) -> PathBuf {
        let cache_path =
            cached_download_path(am, url, bytes.len() as u64, Some(CacheIdentity::Driver { db_type, version }), dest);
        std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
        std::fs::write(&cache_path, bytes).unwrap();
        cache_path
    }

    #[tokio::test]
    async fn registry_install_accepts_native_driver_with_legacy_jar_fallback() {
        let manager = test_manager("native-with-jar-fallback");
        let db_type = "oracle";
        let version = "0.1.31";
        let native_url = "https://example.com/dbx-agent-oracle";
        let native_bytes = b"native-agent";
        let registry = registry_with_native_and_legacy_jar(db_type, version, native_url, native_bytes.len() as u64);
        let native_path = manager.driver_native_path(db_type);
        let cache_path =
            write_cached_driver_download(&manager, db_type, version, native_url, &native_path, native_bytes);
        let progress = |_| {};

        install_agent_driver_from_registry(
            &manager,
            &registry,
            DownloadSource::Official,
            db_type,
            &progress,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read(&native_path).unwrap(), native_bytes);
        assert!(!cache_path.exists());
        assert!(!manager.driver_jar_path(db_type).exists());
        assert_eq!(manager.load_state().installed_drivers.get(db_type).unwrap().version, version);
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
        )
        .await
        .unwrap_err();

        assert!(err.contains("invalid or corrupt"));
        assert!(cache_path.exists());
        assert!(!jar_path.exists());
        assert!(!manager.load_state().installed_drivers.contains_key(db_type));
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
        assert!(rendered.contains("（原始错误："), "missing original error wrapper: {rendered}");
        assert!(rendered.contains("拒绝访问"), "missing original error text: {rendered}");
        if cfg!(windows) {
            assert!(rendered.starts_with("无法删除旧的 JRE 目录："), "wrong prefix: {rendered}");
            assert!(rendered.contains("Agent / java 进程占用"), "missing process advice: {rendered}");
            assert!(rendered.contains("重启 dbx 后重试"), "missing restart advice: {rendered}");
        } else {
            // POSIX path: short form, no Windows-specific advice.
            assert!(rendered.contains("无法删除旧的 JRE 目录"));
            assert!(!rendered.contains("防病毒"));
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
