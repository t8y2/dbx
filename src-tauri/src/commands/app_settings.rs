use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use dbx_core::storage::DesktopSettings;
use tauri::{AppHandle, Manager, State};

use super::connection::AppState;
use crate::{apply_debug_log_level, apply_desktop_settings};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DriverStoreMigrationResult {
    pub driver_store_dir: Option<String>,
    pub plugin_store_dir: Option<String>,
    pub agent_store_dir: Option<String>,
    pub plugins_dir: String,
    pub agents_dir: String,
    pub migrated_plugins: bool,
    pub migrated_agents: bool,
}

#[tauri::command]
pub async fn load_desktop_settings(state: State<'_, Arc<AppState>>) -> Result<DesktopSettings, String> {
    state.storage.load_desktop_settings().await
}

#[tauri::command]
pub async fn save_desktop_settings(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    settings: DesktopSettings,
) -> Result<(), String> {
    state.storage.save_desktop_settings(&settings).await?;
    apply_debug_log_level(settings.debug_logging_enabled);
    if let Err(err) = apply_desktop_settings(&app, &settings) {
        eprintln!("Failed to apply desktop settings: {err}");
    }
    Ok(())
}

#[tauri::command]
pub async fn load_pinned_tree_node_ids(state: State<'_, Arc<AppState>>) -> Result<Vec<String>, String> {
    state.storage.load_pinned_tree_node_ids().await
}

#[tauri::command]
pub async fn save_pinned_tree_node_ids(state: State<'_, Arc<AppState>>, ids: Vec<String>) -> Result<(), String> {
    state.storage.save_pinned_tree_node_ids(&ids).await
}

#[tauri::command]
pub async fn load_native_debug_logs(app: AppHandle) -> Result<String, String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || load_native_debug_logs_from_dir(log_dir))
        .await
        .map_err(|err| err.to_string())?
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DriverStorePathInfo {
    pub driver_store_dir: Option<String>,
    pub plugin_store_dir: Option<String>,
    pub agent_store_dir: Option<String>,
    pub plugins_dir: String,
    pub agents_dir: String,
}

#[tauri::command]
pub async fn get_driver_store_path(state: State<'_, Arc<AppState>>) -> Result<DriverStorePathInfo, String> {
    let settings = state.storage.load_desktop_settings().await.unwrap_or_default();
    Ok(DriverStorePathInfo {
        driver_store_dir: settings.driver_store_dir,
        plugin_store_dir: settings.plugin_store_dir,
        agent_store_dir: settings.agent_store_dir,
        plugins_dir: state.plugins.root_dir().to_string_lossy().to_string(),
        agents_dir: state.agent_manager.base_dir().to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn set_driver_store_dir(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    new_dir: Option<String>,
) -> Result<DriverStoreMigrationResult, String> {
    let new_dir = normalize_store_dir(new_dir);
    let current_plugins_dir = state.plugins.root_dir().to_path_buf();
    let current_agents_dir = state.agent_manager.base_dir().clone();
    let (target_plugins_dir, target_agents_dir) = match new_dir.as_ref() {
        Some(dir) => {
            let driver_base = PathBuf::from(dir);
            (driver_base.join("plugins"), driver_base.join("agents"))
        }
        None => default_store_dirs(&app)?,
    };

    state.agent_manager.stop_daemons().await;
    let migrated_plugins = migrate_store_directory(&current_plugins_dir, &target_plugins_dir)?;
    let migrated_agents = migrate_store_directory(&current_agents_dir, &target_agents_dir)?;

    let mut settings = state.storage.load_desktop_settings().await.unwrap_or_default();
    settings.driver_store_dir = new_dir.clone();
    settings.plugin_store_dir = None;
    settings.agent_store_dir = None;
    state.storage.save_desktop_settings(&settings).await?;

    Ok(driver_store_migration_result(
        settings,
        &target_plugins_dir,
        &target_agents_dir,
        migrated_plugins,
        migrated_agents,
    ))
}

#[tauri::command]
pub async fn set_plugin_store_dir(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    new_dir: Option<String>,
) -> Result<DriverStoreMigrationResult, String> {
    let new_dir = normalize_store_dir(new_dir);
    let current_plugins_dir = state.plugins.root_dir().to_path_buf();
    let current_agents_dir = state.agent_manager.base_dir().clone();
    let target_plugins_dir = match new_dir.as_ref() {
        Some(dir) => PathBuf::from(dir),
        None => default_plugin_store_dir(&app)?,
    };

    let migrated_plugins = migrate_store_directory(&current_plugins_dir, &target_plugins_dir)?;

    let mut settings = state.storage.load_desktop_settings().await.unwrap_or_default();
    convert_legacy_driver_store(&mut settings, &current_plugins_dir, &current_agents_dir);
    settings.plugin_store_dir = new_dir;
    state.storage.save_desktop_settings(&settings).await?;

    Ok(driver_store_migration_result(settings, &target_plugins_dir, &current_agents_dir, migrated_plugins, false))
}

#[tauri::command]
pub async fn set_agent_store_dir(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    new_dir: Option<String>,
) -> Result<DriverStoreMigrationResult, String> {
    let new_dir = normalize_store_dir(new_dir);
    let current_plugins_dir = state.plugins.root_dir().to_path_buf();
    let current_agents_dir = state.agent_manager.base_dir().clone();
    let target_agents_dir = match new_dir.as_ref() {
        Some(dir) => PathBuf::from(dir),
        None => default_agent_store_dir(&app)?,
    };

    state.agent_manager.stop_daemons().await;
    let migrated_agents = migrate_store_directory(&current_agents_dir, &target_agents_dir)?;

    let mut settings = state.storage.load_desktop_settings().await.unwrap_or_default();
    convert_legacy_driver_store(&mut settings, &current_plugins_dir, &current_agents_dir);
    settings.agent_store_dir = new_dir;
    state.storage.save_desktop_settings(&settings).await?;

    Ok(driver_store_migration_result(settings, &current_plugins_dir, &target_agents_dir, false, migrated_agents))
}

fn normalize_store_dir(dir: Option<String>) -> Option<String> {
    dir.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn default_store_dirs(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    Ok((default_plugin_store_dir(app)?, default_agent_store_dir(app)?))
}

fn default_plugin_store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let default_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(crate::data_dir::resolve_data_dir_with_mode(default_data_dir).data_dir.join("plugins"))
}

fn default_agent_store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let default_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let data_dir_resolution = crate::data_dir::resolve_data_dir_with_mode(default_data_dir);
    Ok(if data_dir_resolution.uses_custom_data_dir() {
        data_dir_resolution.data_dir.join("agents")
    } else {
        dbx_core::connection::default_agent_dir()
    })
}

pub(crate) fn resolve_driver_store_dirs_from_settings(
    settings: &DesktopSettings,
    data_dir: &Path,
    default_agent_dir: Option<PathBuf>,
) -> (PathBuf, Option<PathBuf>) {
    let legacy_driver_base =
        settings.driver_store_dir.as_ref().filter(|value| !value.trim().is_empty()).map(PathBuf::from);
    let plugin_dir = settings
        .plugin_store_dir
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| legacy_driver_base.as_ref().map(|base| base.join("plugins")))
        .unwrap_or_else(|| data_dir.join("plugins"));
    let agent_dir = settings
        .agent_store_dir
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| legacy_driver_base.as_ref().map(|base| base.join("agents")))
        .or(default_agent_dir);

    (plugin_dir, agent_dir)
}

fn convert_legacy_driver_store(settings: &mut DesktopSettings, current_plugins_dir: &Path, current_agents_dir: &Path) {
    if settings.driver_store_dir.is_none() {
        return;
    }
    if settings.plugin_store_dir.is_none() {
        settings.plugin_store_dir = Some(current_plugins_dir.to_string_lossy().to_string());
    }
    if settings.agent_store_dir.is_none() {
        settings.agent_store_dir = Some(current_agents_dir.to_string_lossy().to_string());
    }
    settings.driver_store_dir = None;
}

fn driver_store_migration_result(
    settings: DesktopSettings,
    plugins_dir: &Path,
    agents_dir: &Path,
    migrated_plugins: bool,
    migrated_agents: bool,
) -> DriverStoreMigrationResult {
    DriverStoreMigrationResult {
        driver_store_dir: settings.driver_store_dir,
        plugin_store_dir: settings.plugin_store_dir,
        agent_store_dir: settings.agent_store_dir,
        plugins_dir: plugins_dir.to_string_lossy().to_string(),
        agents_dir: agents_dir.to_string_lossy().to_string(),
        migrated_plugins,
        migrated_agents,
    }
}

fn migrate_store_directory(current_dir: &Path, target_dir: &Path) -> Result<bool, String> {
    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed to create directory {}: {e}", target_dir.display()))?;
    let target_canonical =
        target_dir.canonicalize().map_err(|e| format!("Invalid path {}: {e}", target_dir.display()))?;

    if !current_dir.exists() {
        return Ok(false);
    }

    let current_canonical =
        current_dir.canonicalize().map_err(|e| format!("Invalid path {}: {e}", current_dir.display()))?;
    if current_canonical == target_canonical {
        return Ok(false);
    }
    if target_canonical.starts_with(&current_canonical) {
        return Err(format!(
            "Target directory {} cannot be inside current directory {}",
            target_dir.display(),
            current_dir.display()
        ));
    }
    if target_dir_has_entries(target_dir)? {
        return Err(format!(
            "Target directory {} is not empty. Please choose an empty directory or remove the existing data first.",
            target_dir.display()
        ));
    }

    migrate_directory(current_dir, target_dir)?;
    verify_migration(current_dir, target_dir)?;
    if let Err(err) = std::fs::remove_dir_all(current_dir) {
        log::warn!("Failed to remove old driver store dir {}: {err}", current_dir.display());
    }
    Ok(true)
}

fn target_dir_has_entries(dir: &Path) -> Result<bool, String> {
    let mut entries = std::fs::read_dir(dir).map_err(|e| format!("Failed to read {}: {e}", dir.display()))?;
    Ok(entries.next().transpose().map_err(|e| e.to_string())?.is_some())
}

/// Recursively copy a directory to a new location.
fn migrate_directory(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("Failed to create {}: {e}", dst.display()))?;
    copy_dir_recursive(src, dst)
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("Failed to create {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("Failed to read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Failed to copy {} to {}: {e}", src_path.display(), dst_path.display()))?;
        }
    }
    Ok(())
}

/// Verify that the migrated directory has the same file count and total size.
fn verify_migration(src: &Path, dst: &Path) -> Result<(), String> {
    let src_info = count_files_recursive(src)?;
    let dst_info = count_files_recursive(dst)?;
    if src_info.count != dst_info.count || src_info.total_size != dst_info.total_size {
        // Rollback: remove the incomplete destination
        let _ = std::fs::remove_dir_all(dst);
        return Err(format!(
            "Migration verification failed: source had {} files ({} bytes), destination has {} files ({} bytes)",
            src_info.count, src_info.total_size, dst_info.count, dst_info.total_size
        ));
    }
    Ok(())
}

struct DirStats {
    count: usize,
    total_size: u64,
}

fn count_files_recursive(dir: &std::path::Path) -> Result<DirStats, String> {
    let mut count = 0usize;
    let mut total_size = 0u64;
    fn walk(dir: &std::path::Path, count: &mut usize, total_size: &mut u64) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, count, total_size)?;
            } else {
                *count += 1;
                *total_size += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
        Ok(())
    }
    walk(dir, &mut count, &mut total_size)?;
    Ok(DirStats { count, total_size })
}

fn load_native_debug_logs_from_dir(log_dir: PathBuf) -> Result<String, String> {
    const MAX_FILES: usize = 6;
    const MAX_FILE_BYTES: u64 = 512 * 1024;
    if !log_dir.exists() {
        return Ok(format!("Native log dir does not exist yet: {}", log_dir.display()));
    }
    let mut files = std::fs::read_dir(&log_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            let modified = metadata.modified().ok()?;
            Some((path, modified, metadata.len()))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(_, modified, _)| *modified);
    files.reverse();

    let mut output = String::new();
    output.push_str(&format!("Native log dir: {}\n", log_dir.display()));
    for (path, _, len) in files.into_iter().take(MAX_FILES) {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("unknown");
        output.push_str(&format!("\n===== {name} =====\n"));
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let start = if len > MAX_FILE_BYTES { bytes.len().saturating_sub(MAX_FILE_BYTES as usize) } else { 0 };
        if start > 0 {
            output.push_str("[truncated to last 512 KiB]\n");
        }
        output.push_str(&String::from_utf8_lossy(&bytes[start..]));
        output.push('\n');
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{driver_store_migration_result, resolve_driver_store_dirs_from_settings, DesktopSettings};
    use std::path::PathBuf;

    #[test]
    fn plugin_store_result_uses_selected_directory_without_agent_prefix() {
        let settings = DesktopSettings {
            plugin_store_dir: Some(path("D:/develop/DBX")),
            agent_store_dir: Some(path("D:/develop/DBX/agents")),
            ..Default::default()
        };
        let plugins_dir = PathBuf::from(path("D:/develop/DBX"));
        let agents_dir = PathBuf::from(path("D:/develop/DBX/agents"));

        let result = driver_store_migration_result(settings, &plugins_dir, &agents_dir, true, false);

        assert_eq!(result.plugin_store_dir.as_deref(), Some(path("D:/develop/DBX").as_str()));
        assert_eq!(result.plugins_dir, path("D:/develop/DBX"));
        assert_eq!(result.agents_dir, path("D:/develop/DBX/agents"));
        assert!(!result.plugins_dir.contains(&path("agents/com.dbx.app/plugins")));
    }

    #[test]
    fn legacy_driver_store_result_keeps_plugins_and_agents_as_siblings() {
        let settings = DesktopSettings { driver_store_dir: Some(path("D:/develop/DBX")), ..Default::default() };
        let plugins_dir = PathBuf::from(path("D:/develop/DBX/plugins"));
        let agents_dir = PathBuf::from(path("D:/develop/DBX/agents"));

        let result = driver_store_migration_result(settings, &plugins_dir, &agents_dir, true, true);

        assert_eq!(result.driver_store_dir.as_deref(), Some(path("D:/develop/DBX").as_str()));
        assert_eq!(result.plugins_dir, path("D:/develop/DBX/plugins"));
        assert_eq!(result.agents_dir, path("D:/develop/DBX/agents"));
    }

    #[test]
    fn resolves_separate_plugin_store_dir_as_exact_selected_dir() {
        let settings = DesktopSettings {
            driver_store_dir: Some(path("D:/legacy-base")),
            plugin_store_dir: Some(path("D:/develop/DBX")),
            agent_store_dir: Some(path("D:/develop/DBX/agents")),
            ..Default::default()
        };

        let (plugins_dir, agents_dir) = resolve_driver_store_dirs_from_settings(
            &settings,
            &PathBuf::from(path("C:/Users/lenovo/AppData/Roaming/com.dbx.app")),
            Some(PathBuf::from(path("C:/Users/lenovo/.dbx/agents"))),
        );

        assert_eq!(plugins_dir, PathBuf::from(path("D:/develop/DBX")));
        assert_eq!(agents_dir, Some(PathBuf::from(path("D:/develop/DBX/agents"))));
    }

    #[test]
    fn resolves_legacy_driver_store_dir_to_sibling_plugins_and_agents() {
        let settings = DesktopSettings { driver_store_dir: Some(path("D:/develop/DBX")), ..Default::default() };

        let (plugins_dir, agents_dir) = resolve_driver_store_dirs_from_settings(
            &settings,
            &PathBuf::from(path("C:/Users/lenovo/AppData/Roaming/com.dbx.app")),
            Some(PathBuf::from(path("C:/Users/lenovo/.dbx/agents"))),
        );

        assert_eq!(plugins_dir, PathBuf::from(path("D:/develop/DBX/plugins")));
        assert_eq!(agents_dir, Some(PathBuf::from(path("D:/develop/DBX/agents"))));
    }

    fn path(value: &str) -> String {
        value.replace('/', std::path::MAIN_SEPARATOR_STR)
    }
}
