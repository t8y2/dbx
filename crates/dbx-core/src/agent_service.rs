use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::agent_catalog;
use crate::agent_manager::{
    AgentDriverInfo, AgentManager, AgentRegistry, InstalledDriver, JavaRuntimeMode, DEFAULT_JRE_KEY,
};

const REGISTRY_PATH: &str = "https://github.com/t8y2/dbx-agents/releases/latest/download/agent-registry.json";
const REGISTRY_R2_PATH: &str = "agents/agent-registry.json";

static REGISTRY_CACHE: std::sync::LazyLock<tokio::sync::Mutex<Option<(std::time::Instant, AgentRegistry)>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));

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
            let installed = am.is_driver_installed(key);
            let local = local_state.installed_drivers.get(key);
            let remote = registry.and_then(|r| r.drivers.get(key));
            let jre_key = remote
                .map(|r| r.jre.clone())
                .or_else(|| local.map(|l| l.jre.clone()))
                .unwrap_or_else(|| DEFAULT_JRE_KEY.to_string());
            let remote_jre_version = registry.and_then(|r| r.resolve_jre(&jre_key)).map(|j| &j.version);
            let local_jre_version = installed_jre_version(&local_state, &jre_key);
            let jre_update_available = installed
                && use_managed_jre
                && (!am.is_jre_installed(&jre_key)
                    || remote_jre_version.is_some_and(|version| local_jre_version != Some(version)));
            AgentDriverInfo {
                db_type: key.to_string(),
                label: label.to_string(),
                version: remote.map(|r| r.version.clone()).unwrap_or_default(),
                size: remote.map(|r| r.jar.size).unwrap_or(0),
                installed,
                installed_version: local.map(|l| l.version.clone()),
                update_available: match (local, remote) {
                    (Some(l), Some(r)) => l.version != r.version || jre_update_available,
                    _ => false,
                },
                jre: jre_key.clone(),
                jre_installed: am.is_jre_installed(&jre_key),
            }
        })
        .collect()
}

fn installed_jre_version<'a>(state: &'a crate::agent_manager::AgentState, jre_key: &str) -> Option<&'a String> {
    state
        .jre_versions
        .get(jre_key)
        .or_else(|| (jre_key == DEFAULT_JRE_KEY).then_some(state.jre_version.as_ref()).flatten())
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
    let relative = PathBuf::from("..").join("dbx-agents").join(db_type).join("build").join("libs").join(&jar_name);
    let nested = PathBuf::from("dbx-agents").join(db_type).join("build").join("libs").join(&jar_name);
    vec![relative, nested]
}

pub fn find_local_agent_jar(db_type: &str) -> Option<PathBuf> {
    local_agent_jar_candidates(db_type).into_iter().find(|path| path.exists())
}

pub fn install_local_agent(am: &AgentManager, db_type: &str, source: PathBuf) -> Result<(), String> {
    let jar_path = am.driver_jar_path(db_type);
    let parent = jar_path.parent().ok_or_else(|| format!("Invalid driver path: {}", jar_path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    std::fs::copy(&source, &jar_path).map_err(|e| format!("Failed to copy local agent jar: {e}"))?;

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
    {
        let cache = REGISTRY_CACHE.lock().await;
        if let Some((ts, registry)) = cache.as_ref() {
            if ts.elapsed() < std::time::Duration::from_secs(300) {
                return Ok(registry.clone());
            }
        }
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {err}"))?;
    let resp = crate::race_download(&client, REGISTRY_PATH, REGISTRY_R2_PATH, "dbx-agent-manager")
        .await
        .map_err(|err| format!("Failed to fetch agent registry: {err}"))?;
    let registry: AgentRegistry = resp.json().await.map_err(|err| format!("Failed to parse registry: {err}"))?;
    *REGISTRY_CACHE.lock().await = Some((std::time::Instant::now(), registry.clone()));
    Ok(registry)
}

pub async fn invalidate_registry_cache() {
    *REGISTRY_CACHE.lock().await = None;
}

pub async fn install_agent_driver(
    am: &AgentManager,
    db_type: &str,
    progress: impl Fn(AgentProgressEvent),
) -> Result<(), String> {
    install_agent_driver_with_batch(am, db_type, &progress, None, None).await
}

pub async fn upgrade_all_agent_drivers(
    am: &AgentManager,
    progress: impl Fn(AgentProgressEvent),
) -> Result<UpgradeAllAgentDriversResult, String> {
    let registry = fetch_registry().await?;
    let agents = build_agent_list(am, Some(&registry));
    let updatable: Vec<&AgentDriverInfo> = agents.iter().filter(|agent| agent.update_available).collect();
    let total = updatable.len() as u32;
    let mut result = UpgradeAllAgentDriversResult::default();

    for (index, agent) in updatable.iter().enumerate() {
        match install_agent_driver_from_registry(
            am,
            &registry,
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
    let jre_dir = am.jre_dir(jre_key);
    if jre_dir.exists() {
        std::fs::remove_dir_all(&jre_dir).map_err(|err| format!("Failed to remove JRE: {err}"))?;
    }
    let mut local_state = am.load_state();
    local_state.jre_versions.remove(jre_key);
    am.save_state(&local_state)?;
    am.stop_daemons().await;
    Ok(())
}

pub async fn reinstall_agent_jre(
    am: &AgentManager,
    jre_key: &str,
    progress: impl Fn(AgentProgressEvent),
) -> Result<(), String> {
    let registry = fetch_registry().await?;
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
        &platform_jre.url,
        &github_url_to_r2_path(&platform_jre.url, "jre"),
        &jre_archive,
        platform_jre.size,
        None,
        None,
        None,
    )
    .await?;
    let jre_dir = am.jre_dir(jre_key);
    if jre_dir.exists() {
        std::fs::remove_dir_all(&jre_dir).map_err(|err| format!("Failed to remove old JRE: {err}"))?;
    }
    extract_tar_gz(&jre_archive, &jre_dir)?;
    std::fs::remove_file(&jre_archive).ok();
    let mut local_state = am.load_state();
    local_state.jre_versions.insert(jre_key.to_string(), jre_info.version.clone());
    am.save_state(&local_state)?;
    am.stop_daemons().await;
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
    progress: &impl Fn(AgentProgressEvent),
    current: Option<u32>,
    total_drivers: Option<u32>,
) -> Result<(), String> {
    match fetch_registry().await {
        Ok(registry) => {
            install_agent_driver_from_registry(am, &registry, db_type, progress, current, total_drivers).await
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

async fn install_agent_driver_from_registry(
    am: &AgentManager,
    registry: &AgentRegistry,
    db_type: &str,
    progress: &impl Fn(AgentProgressEvent),
    current: Option<u32>,
    total_drivers: Option<u32>,
) -> Result<(), String> {
    let Some(driver) = registry.drivers.get(db_type) else {
        if let Some(local_jar) = find_local_agent_jar(db_type) {
            install_local_agent(am, db_type, local_jar)?;
            am.stop_daemon_by_key(db_type).await;
            progress(AgentProgressEvent::step("done"));
            return Ok(());
        }
        return Err(format!("Unknown driver type: {db_type}"));
    };
    let jre_key = &driver.jre;
    let needs_jre = jre_needs_install(am, registry, jre_key);

    if needs_jre {
        let jre_info =
            registry.resolve_jre(jre_key).ok_or_else(|| format!("No JRE definition for version: {jre_key}"))?;
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
            &platform_jre.url,
            &github_url_to_r2_path(&platform_jre.url, "jre"),
            &jre_archive,
            platform_jre.size,
            Some(db_type),
            current,
            total_drivers,
        )
        .await?;
        progress(AgentProgressEvent::transfer("jre-extract", 0, 0).with_batch(Some(db_type), current, total_drivers));
        let jre_dir = am.jre_dir(jre_key);
        if jre_dir.exists() {
            std::fs::remove_dir_all(&jre_dir).map_err(|err| format!("Failed to remove old JRE: {err}"))?;
        }
        extract_tar_gz(&jre_archive, &jre_dir)?;
        std::fs::remove_file(&jre_archive).ok();
    }

    let jar_path = am.driver_jar_path(db_type);
    progress(AgentProgressEvent::transfer("driver", 0, driver.jar.size).with_batch(
        Some(db_type),
        current,
        total_drivers,
    ));
    download_with_progress(
        am,
        progress,
        "driver",
        &driver.jar.url,
        &github_url_to_r2_path(&driver.jar.url, "driver"),
        &jar_path,
        driver.jar.size,
        Some(db_type),
        current,
        total_drivers,
    )
    .await?;

    let mut local_state = am.load_state();
    if let Some(jre_info) = registry.resolve_jre(jre_key) {
        local_state.jre_versions.insert(jre_key.clone(), jre_info.version.clone());
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
    progress(AgentProgressEvent::step("done"));
    Ok(())
}

async fn download_with_progress(
    am: &AgentManager,
    progress: &impl Fn(AgentProgressEvent),
    step: &str,
    url: &str,
    r2_path: &str,
    dest: &std::path::Path,
    total_size: u64,
    db_type: Option<&str>,
    current: Option<u32>,
    total_drivers: Option<u32>,
) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let tmp = download_temp_path(dest);
    let cache_path = cached_download_path(am, url, total_size, dest);
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
    let mut resp = crate::race_download(&client, url, r2_path, "dbx-agent-manager")
        .await
        .map_err(|err| format!("Failed to download {url}: {err}"))?;
    let content_length = resp.content_length().unwrap_or(total_size);
    let mut file = std::fs::File::create(&tmp).map_err(|err| format!("Failed to create temp file: {err}"))?;
    let mut downloaded = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|err| format!("Download stream error: {err}"))? {
        std::io::Write::write_all(&mut file, &chunk).map_err(|err| format!("Failed to write chunk: {err}"))?;
        downloaded += chunk.len() as u64;
        progress(AgentProgressEvent::transfer(step, downloaded, content_length).with_batch(
            db_type,
            current,
            total_drivers,
        ));
    }
    std::io::Write::flush(&mut file).map_err(|err| format!("Failed to flush temp file: {err}"))?;
    drop(file);
    if let Some(parent) = cache_path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            log::warn!("Failed to create agent download cache directory: {err}");
        } else if let Err(err) = std::fs::copy(&tmp, &cache_path) {
            log::warn!("Failed to cache agent download: {err}");
        }
    }
    replace_download(&tmp, dest)
}

fn cached_download_path(am: &AgentManager, url: &str, total_size: u64, dest: &std::path::Path) -> std::path::PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    total_size.hash(&mut hasher);
    let hash = hasher.finish();
    let file_name = dest.file_name().and_then(|name| name.to_str()).unwrap_or("download");
    am.download_cache_dir().join(format!("{hash:016x}-{file_name}"))
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

    let driver_entries: Vec<(String, String)> = (0..archive.len())
        .filter_map(|i| {
            let entry = archive.by_index(i).ok()?;
            let name = entry.name().to_string();
            if name.starts_with("drivers/") && name.ends_with(".jar") {
                let db_type = extract_db_type_from_filename(&name)?;
                Some((db_type, name))
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
        if jre_dir.exists() {
            std::fs::remove_dir_all(&jre_dir).ok();
        }
        extract_tar_gz(&tmp_archive, &jre_dir)?;
        std::fs::remove_file(&tmp_archive).ok();

        if let Some(ver) = jre_version {
            local_state.jre_versions.insert(jre_key.clone(), ver);
        }
        result.jre_installed.push(jre_key.clone());
    }

    for (db_type, entry_name) in &driver_entries {
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

        let jar_path = am.driver_jar_path(db_type);
        if let Some(parent) = jar_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut entry = archive.by_name(entry_name).map_err(|e| format!("Failed to read {entry_name}: {e}"))?;
        let mut out = std::fs::File::create(&jar_path).map_err(|e| format!("Failed to write driver JAR: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Failed to copy driver JAR: {e}"))?;

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
    let rest = filename.strip_prefix("jre-")?;
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

fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let status = std::process::Command::new("tar")
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
