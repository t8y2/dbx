use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::{collections::HashSet, io::ErrorKind};

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
    verify_previous_sync_files(&sync_root, &previous_manifest.files)?;

    std::fs::create_dir_all(&sync_root).map_err(|e| e.to_string())?;
    if previous_manifest.exists {
        std::fs::remove_file(sync_root.join(SYNC_MANIFEST_FILE)).map_err(|e| e.to_string())?;
    }
    remove_previous_sync_files(&sync_root, &previous_manifest.files)?;

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
            written_files.push(SavedSqlSyncManifestFile {
                path: relative.to_string_lossy().replace('\\', "/"),
                sha256: sha256_hex(entry.sql.as_bytes()),
            });
        }
    }

    let manifest = SavedSqlSyncManifest { version: SYNC_MANIFEST_VERSION, files: written_files };
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
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

fn verify_previous_sync_files(target_dir: &Path, files: &[SavedSqlSyncManifestFile]) -> Result<(), String> {
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

fn remove_previous_sync_files(target_dir: &Path, files: &[SavedSqlSyncManifestFile]) -> Result<(), String> {
    for file in files {
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

fn write_sync_manifest(target_dir: &Path, contents: &[u8]) -> Result<(), String> {
    let manifest_path = target_dir.join(SYNC_MANIFEST_FILE);
    let temporary_path = target_dir.join(format!(".{SYNC_MANIFEST_FILE}.{}.tmp", uuid::Uuid::new_v4()));
    if let Err(error) = std::fs::write(&temporary_path, contents) {
        return Err(error.to_string());
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
}
