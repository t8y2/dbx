use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

use dbx_core::connection::AppState;
use dbx_core::saved_sql::{SavedSqlFile, SavedSqlFolder, SavedSqlLibrary};

#[derive(Clone)]
pub struct SavedSqlStorageState {
    pub data_dir: PathBuf,
}

const SYNC_MANIFEST_FILE: &str = ".dbx-sql-library-sync.json";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSqlSyncEntry {
    pub folder_name: Option<String>,
    pub file_name: String,
    pub sql: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSqlSyncRequest {
    pub target_dir: String,
    pub entries: Vec<SavedSqlSyncEntry>,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SavedSqlSyncManifest {
    files: Vec<String>,
}

#[tauri::command]
pub async fn load_saved_sql_library(state: State<'_, Arc<AppState>>) -> Result<SavedSqlLibrary, String> {
    state.storage.load_saved_sql_library_summary().await
}

#[tauri::command]
pub async fn load_saved_sql_file(state: State<'_, Arc<AppState>>, id: String) -> Result<Option<SavedSqlFile>, String> {
    state.storage.load_saved_sql_file(&id).await
}

#[tauri::command]
pub async fn save_saved_sql_folder(
    state: State<'_, Arc<AppState>>,
    folder: SavedSqlFolder,
) -> Result<SavedSqlFolder, String> {
    state.storage.save_saved_sql_folder(&folder).await?;
    Ok(folder)
}

#[tauri::command]
pub async fn delete_saved_sql_folder(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_saved_sql_folder(&id).await
}

#[tauri::command]
pub async fn save_saved_sql_file(state: State<'_, Arc<AppState>>, file: SavedSqlFile) -> Result<SavedSqlFile, String> {
    state.storage.save_saved_sql_file(&file).await?;
    Ok(file)
}

#[tauri::command]
pub async fn delete_saved_sql_file(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_saved_sql_file(&id).await
}

#[tauri::command]
pub async fn saved_sql_storage_dir(state: State<'_, SavedSqlStorageState>) -> Result<String, String> {
    Ok(state.data_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn open_saved_sql_storage_dir(
    state: State<'_, SavedSqlStorageState>,
    dir: Option<String>,
) -> Result<(), String> {
    let target_dir = dir
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.data_dir.clone());
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    open_path(&target_dir)
}

#[tauri::command]
pub async fn sync_saved_sql_directory(request: SavedSqlSyncRequest) -> Result<(), String> {
    let target_dir = PathBuf::from(request.target_dir.trim());
    if target_dir.as_os_str().is_empty() {
        return Err("Target directory is empty".to_string());
    }
    tokio::task::spawn_blocking(move || sync_saved_sql_directory_blocking(&target_dir, &request.entries))
        .await
        .map_err(|e| e.to_string())?
}

fn sync_saved_sql_directory_blocking(target_dir: &Path, entries: &[SavedSqlSyncEntry]) -> Result<(), String> {
    let sync_root = target_dir.join("dbx-sql-library");
    std::fs::create_dir_all(&sync_root).map_err(|e| e.to_string())?;
    remove_previous_sync_files(&sync_root)?;

    let mut written_files = Vec::new();
    for entry in entries {
        let mut file_dir = sync_root.to_path_buf();
        if let Some(folder_name) = entry.folder_name.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
            for segment in folder_name.split('/') {
                let segment = segment.trim();
                if !segment.is_empty() {
                    file_dir.push(sanitize_file_segment(segment));
                }
            }
        }
        std::fs::create_dir_all(&file_dir).map_err(|e| e.to_string())?;

        let file_name = ensure_sql_extension(&sanitize_file_segment(&entry.file_name));
        let file_path = unique_file_path(&file_dir, &file_name);
        std::fs::write(&file_path, &entry.sql).map_err(|e| e.to_string())?;
        if let Ok(relative) = file_path.strip_prefix(&sync_root) {
            written_files.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }

    let manifest = SavedSqlSyncManifest { files: written_files };
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(sync_root.join(SYNC_MANIFEST_FILE), manifest_json).map_err(|e| e.to_string())?;
    Ok(())
}

fn remove_previous_sync_files(target_dir: &Path) -> Result<(), String> {
    let manifest_path = target_dir.join(SYNC_MANIFEST_FILE);
    let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
        return Ok(());
    };
    let manifest = serde_json::from_str::<SavedSqlSyncManifest>(&raw).unwrap_or_default();
    for relative in manifest.files {
        let file_path = target_dir.join(relative);
        if file_path.is_file() {
            std::fs::remove_file(&file_path).map_err(|e| e.to_string())?;
            remove_empty_parent_dirs(target_dir, file_path.parent());
        }
    }
    Ok(())
}

fn remove_empty_parent_dirs(root: &Path, parent: Option<&Path>) {
    let Some(dir) = parent else {
        return;
    };
    if dir == root {
        return;
    }
    if std::fs::remove_dir(dir).is_ok() {
        remove_empty_parent_dirs(root, dir.parent());
    }
}

fn sanitize_file_segment(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if sanitized.is_empty() {
        "untitled".to_string()
    } else {
        sanitized
    }
}

fn ensure_sql_extension(name: &str) -> String {
    if name.to_lowercase().ends_with(".sql") {
        name.to_string()
    } else {
        format!("{name}.sql")
    }
}

fn unique_file_path(dir: &Path, file_name: &str) -> PathBuf {
    let mut candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let base = file_name.strip_suffix(".sql").unwrap_or(file_name);
    let mut counter = 2;
    loop {
        candidate = dir.join(format!("{base} ({counter}).sql"));
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = dbx_core::process::new_std_command("open");
        command.arg(path);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = dbx_core::process::new_std_command("explorer");
        command.arg(path);
        command
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = dbx_core::process::new_std_command("xdg-open");
        command.arg(path);
        command
    };

    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}
