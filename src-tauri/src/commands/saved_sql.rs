use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::{
    collections::{HashMap, HashSet},
    io::ErrorKind,
};

use sha2::{Digest, Sha256};
use tauri::State;

use dbx_core::connection::AppState;
use dbx_core::saved_sql::{SavedSqlFile, SavedSqlFolder, SavedSqlLibrary};

#[derive(Clone)]
pub struct SavedSqlStorageState {
    pub data_dir: PathBuf,
}

const SYNC_MANIFEST_FILE: &str = ".dbx-sql-library-sync.json";
const SYNC_MANIFEST_VERSION: u32 = 1;

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

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedSqlSyncManifest {
    version: u32,
    files: Vec<SavedSqlSyncManifestFile>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedSqlSyncManifestFile {
    path: String,
    sha256: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacySavedSqlSyncManifest {
    files: Vec<String>,
}

struct PreviousSyncManifest {
    exists: bool,
    files: Vec<SavedSqlSyncManifestFile>,
}

#[tauri::command]
pub async fn load_saved_sql_library(state: State<'_, Arc<AppState>>) -> Result<SavedSqlLibrary, String> {
    state.storage.load_saved_sql_library_summary().await
}

#[tauri::command]
pub async fn load_saved_sql_files_for_sync(state: State<'_, Arc<AppState>>) -> Result<Vec<SavedSqlFile>, String> {
    state.storage.load_saved_sql_files_for_sync().await
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
    let previous_manifest = load_previous_sync_manifest(&sync_root)?;

    let previous_by_path =
        previous_manifest.files.iter().map(|file| (file.path.as_str(), file)).collect::<HashMap<_, _>>();
    let reusable_paths = previous_by_path.keys().copied().collect::<HashSet<_>>();
    let mut planned_paths = HashSet::new();
    let mut planned_files = Vec::with_capacity(entries.len());
    for entry in entries {
        let mut relative_dir = PathBuf::new();
        if let Some(folder_name) = entry.folder_name.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
            for segment in folder_name.split('/') {
                let segment = segment.trim();
                if !segment.is_empty() {
                    relative_dir.push(sanitize_file_segment(segment));
                }
            }
        }

        let file_name = ensure_sql_extension(&sanitize_file_segment(&entry.file_name));
        let relative =
            unique_sync_relative_path(&sync_root, &relative_dir, &file_name, &reusable_paths, &planned_paths);
        let path = relative.to_string_lossy().replace('\\', "/");
        planned_paths.insert(path.clone());
        planned_files
            .push((SavedSqlSyncManifestFile { path, sha256: sha256_hex(entry.sql.as_bytes()) }, entry.sql.as_bytes()));
    }

    let unchanged = previous_manifest.exists
        && previous_manifest.files.len() == planned_files.len()
        && planned_files.iter().all(|(planned, _)| {
            previous_by_path
                .get(planned.path.as_str())
                .is_some_and(|previous| previous.sha256.eq_ignore_ascii_case(&planned.sha256))
        });
    if unchanged {
        return Ok(());
    }

    let planned_by_path = planned_files.iter().map(|(file, _)| (file.path.as_str(), file)).collect::<HashMap<_, _>>();
    verify_previous_sync_files(
        &sync_root,
        previous_manifest.files.iter().filter(|previous| {
            planned_by_path
                .get(previous.path.as_str())
                .is_none_or(|planned| !previous.sha256.eq_ignore_ascii_case(&planned.sha256))
        }),
    )?;

    for (planned, _) in &planned_files {
        if previous_by_path.contains_key(planned.path.as_str()) {
            continue;
        }
        let relative = normalized_relative_path(&planned.path).expect("planned sync paths are normalized");
        match std::fs::symlink_metadata(sync_root.join(relative)) {
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Ok(_) => return Err(sync_conflict(&planned.path, "an unmanaged path appeared during synchronization")),
            Err(error) => {
                return Err(sync_conflict(&planned.path, &format!("target path cannot be inspected: {error}")))
            }
        }
    }

    let manifest = SavedSqlSyncManifest {
        version: SYNC_MANIFEST_VERSION,
        files: planned_files
            .iter()
            .map(|(file, _)| SavedSqlSyncManifestFile { path: file.path.clone(), sha256: file.sha256.clone() })
            .collect(),
    };
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;

    std::fs::create_dir_all(&sync_root).map_err(|e| e.to_string())?;

    for (planned, contents) in &planned_files {
        if previous_by_path
            .get(planned.path.as_str())
            .is_some_and(|previous| previous.sha256.eq_ignore_ascii_case(&planned.sha256))
        {
            continue;
        }
        let relative = normalized_relative_path(&planned.path).expect("planned sync paths are normalized");
        let file_path = sync_root.join(relative);
        write_sync_file(&file_path, contents, previous_by_path.contains_key(planned.path.as_str()))?;
    }

    remove_stale_sync_files(&sync_root, &previous_manifest.files, &planned_paths)?;
    write_sync_manifest(&sync_root, manifest_json.as_bytes())
}

fn load_previous_sync_manifest(target_dir: &Path) -> Result<PreviousSyncManifest, String> {
    let manifest_path = target_dir.join(SYNC_MANIFEST_FILE);
    let raw = match std::fs::read_to_string(&manifest_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(PreviousSyncManifest { exists: false, files: Vec::new() });
        }
        Err(error) => return Err(format!("Failed to read saved SQL sync manifest: {error}")),
    };

    if let Ok(manifest) = serde_json::from_str::<SavedSqlSyncManifest>(&raw) {
        if manifest.version != SYNC_MANIFEST_VERSION {
            return Err(format!("Unsupported saved SQL sync manifest version: {}", manifest.version));
        }
        validate_manifest_files(&manifest.files)?;
        return Ok(PreviousSyncManifest { exists: true, files: manifest.files });
    }

    if let Ok(manifest) = serde_json::from_str::<LegacySavedSqlSyncManifest>(&raw) {
        if manifest.files.is_empty() {
            return Ok(PreviousSyncManifest { exists: true, files: Vec::new() });
        }
        let path = manifest.files.first().expect("legacy manifest is not empty");
        return Err(format!("Saved SQL sync conflict for '{path}': the existing manifest has no content fingerprint"));
    }

    Err("Invalid saved SQL sync manifest; no files were changed".to_string())
}

fn validate_manifest_files(files: &[SavedSqlSyncManifestFile]) -> Result<(), String> {
    let mut paths = HashSet::new();
    for file in files {
        if normalized_relative_path(&file.path).is_none() {
            return Err(format!("Invalid saved SQL sync manifest path: '{}'", file.path));
        }
        if !paths.insert(&file.path) {
            return Err(format!("Duplicate saved SQL sync manifest path: '{}'", file.path));
        }
        if file.sha256.len() != 64 || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("Invalid saved SQL sync fingerprint for '{}'", file.path));
        }
    }
    Ok(())
}

fn verify_previous_sync_files<'a>(
    target_dir: &Path,
    files: impl IntoIterator<Item = &'a SavedSqlSyncManifestFile>,
) -> Result<(), String> {
    for file in files {
        let relative = normalized_relative_path(&file.path).expect("manifest paths were validated");
        let file_path = target_dir.join(relative);
        let metadata = std::fs::symlink_metadata(&file_path)
            .map_err(|error| sync_conflict(&file.path, &format!("managed file is unavailable: {error}")))?;
        if !metadata.file_type().is_file() {
            return Err(sync_conflict(&file.path, "managed path is no longer a regular file"));
        }
        let contents = std::fs::read(&file_path)
            .map_err(|error| sync_conflict(&file.path, &format!("managed file cannot be read: {error}")))?;
        if !sha256_hex(&contents).eq_ignore_ascii_case(&file.sha256) {
            return Err(sync_conflict(&file.path, "managed file was edited outside DBX"));
        }
    }
    Ok(())
}

fn remove_stale_sync_files(
    target_dir: &Path,
    files: &[SavedSqlSyncManifestFile],
    planned_paths: &HashSet<String>,
) -> Result<(), String> {
    for file in files {
        if planned_paths.contains(&file.path) {
            continue;
        }
        let relative = normalized_relative_path(&file.path).expect("manifest paths were validated");
        let file_path = target_dir.join(relative);
        std::fs::remove_file(&file_path).map_err(|e| e.to_string())?;
        remove_empty_parent_dirs(target_dir, file_path.parent());
    }
    Ok(())
}

fn normalized_relative_path(relative: &str) -> Option<PathBuf> {
    if relative.is_empty() || relative.contains('\\') {
        return None;
    }
    let mut path = PathBuf::new();
    for segment in relative.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return None;
        }
        path.push(segment);
    }
    if path.components().all(|component| matches!(component, std::path::Component::Normal(_))) {
        Some(path)
    } else {
        None
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sync_conflict(path: &str, reason: &str) -> String {
    format!("Saved SQL sync conflict for '{path}': {reason}; no files were changed")
}

fn write_sync_file(file_path: &Path, contents: &[u8], replace: bool) -> Result<(), String> {
    let parent = file_path.parent().ok_or_else(|| "Saved SQL sync target has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary_path = parent.join(format!(".dbx-sql-sync.{}.tmp", uuid::Uuid::new_v4()));
    if let Err(error) = std::fs::write(&temporary_path, contents) {
        return Err(error.to_string());
    }

    #[cfg(target_os = "windows")]
    if replace {
        if let Err(error) = std::fs::remove_file(file_path) {
            let _ = std::fs::remove_file(&temporary_path);
            return Err(error.to_string());
        }
    }

    #[cfg(not(target_os = "windows"))]
    let _ = replace;

    if let Err(error) = std::fs::rename(&temporary_path, file_path) {
        let _ = std::fs::remove_file(temporary_path);
        return Err(error.to_string());
    }
    Ok(())
}

fn write_sync_manifest(target_dir: &Path, contents: &[u8]) -> Result<(), String> {
    let manifest_path = target_dir.join(SYNC_MANIFEST_FILE);
    let temporary_path = target_dir.join(format!(".{SYNC_MANIFEST_FILE}.{}.tmp", uuid::Uuid::new_v4()));
    if let Err(error) = std::fs::write(&temporary_path, contents) {
        return Err(error.to_string());
    }

    #[cfg(target_os = "windows")]
    if manifest_path.exists() {
        if let Err(error) = std::fs::remove_file(&manifest_path) {
            let _ = std::fs::remove_file(&temporary_path);
            return Err(error.to_string());
        }
    }

    if let Err(error) = std::fs::rename(&temporary_path, manifest_path) {
        let _ = std::fs::remove_file(temporary_path);
        return Err(error.to_string());
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

fn unique_sync_relative_path(
    sync_root: &Path,
    relative_dir: &Path,
    file_name: &str,
    reusable_paths: &HashSet<&str>,
    planned_paths: &HashSet<String>,
) -> PathBuf {
    let base = file_name.strip_suffix(".sql").unwrap_or(file_name);
    let mut counter = 1;
    loop {
        let candidate = if counter == 1 {
            relative_dir.join(file_name)
        } else {
            relative_dir.join(format!("{base} ({counter}).sql"))
        };
        let relative = candidate.to_string_lossy().replace('\\', "/");
        if !planned_paths.contains(&relative)
            && (reusable_paths.contains(relative.as_str()) || !sync_root.join(&candidate).exists())
        {
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

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let task_tmp = std::env::var_os("DBX_TEST_TMP_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
            let path = task_tmp.join(format!("dbx-saved-sql-{name}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn entry(sql: &str) -> SavedSqlSyncEntry {
        SavedSqlSyncEntry {
            folder_name: Some("reports".to_string()),
            file_name: "daily".to_string(),
            sql: sql.to_string(),
        }
    }

    fn named_entry(file_name: &str, sql: &str) -> SavedSqlSyncEntry {
        SavedSqlSyncEntry {
            folder_name: Some("reports".to_string()),
            file_name: file_name.to_string(),
            sql: sql.to_string(),
        }
    }

    fn sync_root(target: &TestDirectory) -> PathBuf {
        target.0.join("dbx-sql-library")
    }

    #[test]
    fn writes_fingerprinted_manifest_and_cleanly_resyncs() {
        let target = TestDirectory::new("clean-resync");
        sync_saved_sql_directory_blocking(&target.0, &[entry("SELECT 1;")]).unwrap();

        let root = sync_root(&target);
        let manifest: SavedSqlSyncManifest =
            serde_json::from_slice(&std::fs::read(root.join(SYNC_MANIFEST_FILE)).unwrap()).unwrap();
        assert_eq!(manifest.version, SYNC_MANIFEST_VERSION);
        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].path, "reports/daily.sql");
        assert_eq!(manifest.files[0].sha256, sha256_hex(b"SELECT 1;"));

        sync_saved_sql_directory_blocking(&target.0, &[entry("SELECT 2;")]).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("reports/daily.sql")).unwrap(), "SELECT 2;");
        assert!(!root.join("reports/daily (2).sql").exists());
    }

    #[test]
    fn unchanged_large_sync_keeps_managed_file_identity() {
        let target = TestDirectory::new("unchanged-identity");
        let entries = (0..128)
            .map(|index| named_entry(&format!("query-{index}"), &format!("SELECT {index};")))
            .collect::<Vec<_>>();
        sync_saved_sql_directory_blocking(&target.0, &entries).unwrap();

        let managed_file = sync_root(&target).join("reports/query-64.sql");
        let hard_link = target.0.join("daily-hard-link.sql");
        std::fs::hard_link(&managed_file, &hard_link).unwrap();

        sync_saved_sql_directory_blocking(&target.0, &entries).unwrap();
        std::fs::write(&hard_link, "SELECT 'same inode';").unwrap();

        assert_eq!(std::fs::read_to_string(managed_file).unwrap(), "SELECT 'same inode';");
    }

    #[test]
    fn writes_only_new_and_changed_managed_files() {
        let target = TestDirectory::new("incremental-write");
        sync_saved_sql_directory_blocking(
            &target.0,
            &[named_entry("daily", "SELECT 1;"), named_entry("weekly", "SELECT 7;")],
        )
        .unwrap();

        let root = sync_root(&target);
        let unchanged_file = root.join("reports/weekly.sql");
        let hard_link = target.0.join("weekly-hard-link.sql");
        std::fs::hard_link(&unchanged_file, &hard_link).unwrap();

        sync_saved_sql_directory_blocking(
            &target.0,
            &[
                named_entry("daily", "SELECT 2;"),
                named_entry("weekly", "SELECT 7;"),
                named_entry("monthly", "SELECT 30;"),
            ],
        )
        .unwrap();

        assert_eq!(std::fs::read_to_string(root.join("reports/daily.sql")).unwrap(), "SELECT 2;");
        assert_eq!(std::fs::read_to_string(root.join("reports/monthly.sql")).unwrap(), "SELECT 30;");
        std::fs::write(&hard_link, "SELECT 'same weekly inode';").unwrap();
        assert_eq!(std::fs::read_to_string(unchanged_file).unwrap(), "SELECT 'same weekly inode';");
    }

    #[test]
    fn move_rename_and_delete_remove_only_stale_managed_paths() {
        let target = TestDirectory::new("move-rename-delete");
        sync_saved_sql_directory_blocking(
            &target.0,
            &[named_entry("daily", "SELECT 1;"), named_entry("weekly", "SELECT 7;")],
        )
        .unwrap();

        let root = sync_root(&target);
        let unmanaged_file = root.join("reports/notes.txt");
        std::fs::write(&unmanaged_file, "keep me").unwrap();
        let moved = SavedSqlSyncEntry {
            folder_name: Some("archive".to_string()),
            file_name: "renamed".to_string(),
            sql: "SELECT 1;".to_string(),
        };

        sync_saved_sql_directory_blocking(&target.0, &[moved]).unwrap();

        assert!(!root.join("reports/daily.sql").exists());
        assert!(!root.join("reports/weekly.sql").exists());
        assert_eq!(std::fs::read_to_string(root.join("archive/renamed.sql")).unwrap(), "SELECT 1;");
        assert_eq!(std::fs::read_to_string(unmanaged_file).unwrap(), "keep me");
        let manifest: SavedSqlSyncManifest =
            serde_json::from_slice(&std::fs::read(root.join(SYNC_MANIFEST_FILE)).unwrap()).unwrap();
        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].path, "archive/renamed.sql");
    }

    #[test]
    fn rejects_external_edits_before_overwriting_managed_files() {
        let target = TestDirectory::new("external-edit");
        sync_saved_sql_directory_blocking(&target.0, &[entry("SELECT 1;")]).unwrap();

        let managed_file = target.0.join("dbx-sql-library/reports/daily.sql");
        std::fs::write(&managed_file, "SELECT 'edited outside DBX';").unwrap();

        let error = sync_saved_sql_directory_blocking(&target.0, &[entry("SELECT 2;")]).unwrap_err();
        assert!(error.contains("reports/daily.sql"), "unexpected error: {error}");
        assert_eq!(std::fs::read_to_string(managed_file).unwrap(), "SELECT 'edited outside DBX';");
    }

    #[test]
    fn unchanged_external_edit_is_left_untouched_until_dbx_needs_the_path() {
        let target = TestDirectory::new("external-edit-unchanged");
        sync_saved_sql_directory_blocking(&target.0, &[entry("SELECT 1;")]).unwrap();

        let managed_file = target.0.join("dbx-sql-library/reports/daily.sql");
        std::fs::write(&managed_file, "SELECT 'edited outside DBX';").unwrap();

        sync_saved_sql_directory_blocking(&target.0, &[entry("SELECT 1;")]).unwrap();
        assert_eq!(std::fs::read_to_string(&managed_file).unwrap(), "SELECT 'edited outside DBX';");

        let error = sync_saved_sql_directory_blocking(&target.0, &[entry("SELECT 2;")]).unwrap_err();
        assert!(error.contains("managed file was edited outside DBX"), "unexpected error: {error}");
        assert_eq!(std::fs::read_to_string(managed_file).unwrap(), "SELECT 'edited outside DBX';");
    }

    #[test]
    fn rejects_missing_managed_file_without_changing_siblings() {
        let target = TestDirectory::new("external-delete");
        sync_saved_sql_directory_blocking(
            &target.0,
            &[named_entry("daily", "SELECT 1;"), named_entry("weekly", "SELECT 7;")],
        )
        .unwrap();

        let root = sync_root(&target);
        let missing_file = root.join("reports/daily.sql");
        let sibling_file = root.join("reports/weekly.sql");
        let manifest_before = std::fs::read(root.join(SYNC_MANIFEST_FILE)).unwrap();
        std::fs::remove_file(&missing_file).unwrap();

        let error = sync_saved_sql_directory_blocking(
            &target.0,
            &[named_entry("daily", "SELECT 2;"), named_entry("weekly", "SELECT 8;")],
        )
        .unwrap_err();
        assert!(error.contains("reports/daily.sql"), "unexpected error: {error}");
        assert!(!missing_file.exists());
        assert_eq!(std::fs::read_to_string(sibling_file).unwrap(), "SELECT 7;");
        assert_eq!(std::fs::read(root.join(SYNC_MANIFEST_FILE)).unwrap(), manifest_before);
    }

    #[test]
    fn rejects_managed_file_replaced_with_directory() {
        let target = TestDirectory::new("external-replacement");
        sync_saved_sql_directory_blocking(&target.0, &[entry("SELECT 1;")]).unwrap();

        let managed_path = sync_root(&target).join("reports/daily.sql");
        std::fs::remove_file(&managed_path).unwrap();
        std::fs::create_dir(&managed_path).unwrap();

        let error = sync_saved_sql_directory_blocking(&target.0, &[entry("SELECT 2;")]).unwrap_err();
        assert!(error.contains("reports/daily.sql"), "unexpected error: {error}");
        assert!(managed_path.is_dir());
    }

    #[test]
    fn leaves_unmanaged_files_untouched() {
        let target = TestDirectory::new("unmanaged");
        sync_saved_sql_directory_blocking(&target.0, &[entry("SELECT 1;")]).unwrap();

        let unmanaged_file = sync_root(&target).join("notes.txt");
        std::fs::write(&unmanaged_file, "keep me").unwrap();
        sync_saved_sql_directory_blocking(&target.0, &[entry("SELECT 2;")]).unwrap();

        assert_eq!(std::fs::read_to_string(unmanaged_file).unwrap(), "keep me");
    }

    #[test]
    fn rejects_legacy_manifest_without_deleting_unverified_files() {
        let target = TestDirectory::new("legacy-manifest");
        let root = sync_root(&target);
        std::fs::create_dir_all(root.join("reports")).unwrap();
        let managed_file = root.join("reports/daily.sql");
        std::fs::write(&managed_file, "SELECT 'legacy';").unwrap();
        let manifest_path = root.join(SYNC_MANIFEST_FILE);
        let legacy_manifest = br#"{"files":["reports/daily.sql"]}"#;
        std::fs::write(&manifest_path, legacy_manifest).unwrap();

        let error = sync_saved_sql_directory_blocking(&target.0, &[entry("SELECT 2;")]).unwrap_err();
        assert!(error.contains("no content fingerprint"), "unexpected error: {error}");
        assert_eq!(std::fs::read_to_string(managed_file).unwrap(), "SELECT 'legacy';");
        assert_eq!(std::fs::read(manifest_path).unwrap(), legacy_manifest);
    }

    #[test]
    fn rejects_malformed_manifest_without_changing_files() {
        let target = TestDirectory::new("malformed-manifest");
        let root = sync_root(&target);
        std::fs::create_dir_all(root.join("reports")).unwrap();
        let managed_file = root.join("reports/daily.sql");
        std::fs::write(&managed_file, "SELECT 'unknown';").unwrap();
        let manifest_path = root.join(SYNC_MANIFEST_FILE);
        std::fs::write(&manifest_path, b"not json").unwrap();

        let error = sync_saved_sql_directory_blocking(&target.0, &[entry("SELECT 2;")]).unwrap_err();
        assert!(error.contains("Invalid saved SQL sync manifest"), "unexpected error: {error}");
        assert_eq!(std::fs::read_to_string(managed_file).unwrap(), "SELECT 'unknown';");
        assert_eq!(std::fs::read(manifest_path).unwrap(), b"not json");
    }

    #[test]
    fn failed_manifest_publish_does_not_leave_a_false_manifest() {
        let target = TestDirectory::new("manifest-publish");
        let root = sync_root(&target);
        std::fs::create_dir_all(root.join(SYNC_MANIFEST_FILE)).unwrap();

        let error = write_sync_manifest(&root, br#"{"version":1,"files":[]}"#).unwrap_err();
        assert!(!error.is_empty());
        assert!(root.join(SYNC_MANIFEST_FILE).is_dir());
        let temporary_files = std::fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary_files, 0);
    }

    #[test]
    fn failed_managed_file_publish_keeps_destination_and_cleans_temporary_file() {
        let target = TestDirectory::new("managed-file-publish");
        let destination = target.0.join("daily.sql");
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(destination.join("keep.txt"), "keep me").unwrap();

        let error = write_sync_file(&destination, b"SELECT 2;", true).unwrap_err();
        assert!(!error.is_empty());
        assert_eq!(std::fs::read_to_string(destination.join("keep.txt")).unwrap(), "keep me");
        let temporary_files = std::fs::read_dir(&target.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with(".dbx-sql-sync.") && name.ends_with(".tmp")
            })
            .count();
        assert_eq!(temporary_files, 0);
    }
}
