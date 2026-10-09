use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use dbx_core::cloud_sync::{
    apply_sync_snapshot_with_selection, build_sync_snapshot_with_selection, describe_sync_snapshot,
    ApplySnapshotOptions, ApplySnapshotSummary, SyncExportOptions, SyncSelection, SyncSnapshot, SyncSnapshotCatalog,
};
use dbx_core::connection::AppState;
use dbx_core::storage::DesktopSettings;
use serde::{Deserialize, Serialize};
use tauri::State;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const LOCAL_BACKUP_FORMAT: &str = "dbx-local-backup";
const LOCAL_BACKUP_FORMAT_VERSION: u32 = 1;
const MANIFEST_ENTRY: &str = "manifest.json";
const SNAPSHOT_ENTRY: &str = "snapshot.json";
const MAX_SNAPSHOT_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalBackupManifest {
    format: String,
    format_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackupExportSummary {
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackupImportResult {
    pub editor_settings: Option<serde_json::Value>,
    pub desktop_settings: DesktopSettings,
    pub apply_summary: ApplySnapshotSummary,
}

#[tauri::command]
pub async fn local_backup_export(
    state: State<'_, Arc<AppState>>,
    path: String,
    editor_settings: Option<serde_json::Value>,
    secrets_passphrase: Option<String>,
    selection: SyncSelection,
) -> Result<LocalBackupExportSummary, String> {
    let include_secrets = selection.include_secrets;
    let snapshot = build_sync_snapshot_with_selection(
        &state.storage,
        env!("CARGO_PKG_VERSION"),
        editor_settings,
        SyncExportOptions {
            include_secrets,
            sync_passphrase: secrets_passphrase.as_deref(),
            include_ai_secrets: include_secrets,
            include_tunnel_secrets: include_secrets,
            include_plugin_secrets: include_secrets,
        },
        Some(&selection),
        Some(&state.plugins),
    )
    .await?;

    tauri::async_runtime::spawn_blocking(move || write_local_backup(Path::new(&path), &snapshot))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_backup_inspect(
    path: String,
    secrets_passphrase: Option<String>,
) -> Result<SyncSnapshotCatalog, String> {
    let snapshot = tauri::async_runtime::spawn_blocking(move || read_local_backup(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())??;
    describe_sync_snapshot(&snapshot, secrets_passphrase.as_deref())
}

#[tauri::command]
pub async fn local_backup_import(
    state: State<'_, Arc<AppState>>,
    path: String,
    secrets_passphrase: Option<String>,
    restore_secrets: bool,
    selection: SyncSelection,
) -> Result<LocalBackupImportResult, String> {
    let snapshot = tauri::async_runtime::spawn_blocking(move || read_local_backup(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())??;
    let apply_summary = apply_sync_snapshot_with_selection(
        &state.storage,
        &snapshot,
        ApplySnapshotOptions { secrets_passphrase: secrets_passphrase.as_deref(), restore_secrets },
        Some(&selection),
        Some(&state.plugins),
    )
    .await?;

    Ok(LocalBackupImportResult {
        editor_settings: state.storage.load_editor_settings().await?,
        desktop_settings: state.storage.load_desktop_settings().await?,
        apply_summary,
    })
}

fn write_local_backup(path: &Path, snapshot: &SyncSnapshot) -> Result<LocalBackupExportSummary, String> {
    let manifest =
        LocalBackupManifest { format: LOCAL_BACKUP_FORMAT.to_string(), format_version: LOCAL_BACKUP_FORMAT_VERSION };
    let manifest_bytes = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
    let snapshot_bytes = serde_json::to_vec(snapshot).map_err(|error| error.to_string())?;
    if snapshot_bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err("Local backup snapshot exceeds the 128 MiB limit.".to_string());
    }

    let temporary_path = temporary_backup_path(path)?;
    let mut open_options = OpenOptions::new();
    open_options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_options.mode(0o600);
    }
    let file =
        open_options.open(&temporary_path).map_err(|error| format!("Cannot create temporary local backup: {error}"))?;
    let bytes = match write_backup_archive(file, &manifest_bytes, &snapshot_bytes) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }
    };
    if let Err(error) = replace_backup_file(&temporary_path, path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!("Cannot finalize local backup: {error}"));
    }

    Ok(LocalBackupExportSummary { bytes })
}

fn write_backup_archive(file: File, manifest_bytes: &[u8], snapshot_bytes: &[u8]) -> Result<u64, String> {
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).unix_permissions(0o600);
    archive.start_file(MANIFEST_ENTRY, options).map_err(|error| error.to_string())?;
    archive.write_all(manifest_bytes).map_err(|error| error.to_string())?;
    archive.start_file(SNAPSHOT_ENTRY, options).map_err(|error| error.to_string())?;
    archive.write_all(snapshot_bytes).map_err(|error| error.to_string())?;
    let file = archive.finish().map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    let bytes = file.metadata().map_err(|error| error.to_string())?.len();
    Ok(bytes)
}

fn temporary_backup_path(path: &Path) -> Result<PathBuf, String> {
    let file_name = path.file_name().ok_or_else(|| "Local backup path has no filename.".to_string())?;
    let mut temporary_name = std::ffi::OsString::from(".");
    temporary_name.push(file_name);
    temporary_name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    Ok(path.with_file_name(temporary_name))
}

#[cfg(not(target_os = "windows"))]
fn replace_backup_file(temporary_path: &Path, path: &Path) -> io::Result<()> {
    fs::rename(temporary_path, path)
}

#[cfg(target_os = "windows")]
fn replace_backup_file(temporary_path: &Path, path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};

    let temporary_path: Vec<u16> = temporary_path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let result = unsafe {
        MoveFileExW(temporary_path.as_ptr(), path.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn read_local_backup(path: &Path) -> Result<SyncSnapshot, String> {
    let file = File::open(path).map_err(|error| format!("Cannot open local backup: {error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("Invalid DBX backup ZIP: {error}"))?;
    if archive.len() != 2 {
        return Err("Invalid DBX backup ZIP: expected exactly two entries.".to_string());
    }

    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let name = archive.by_index(index).map_err(|error| error.to_string())?.name().to_string();
        if !matches!(name.as_str(), MANIFEST_ENTRY | SNAPSHOT_ENTRY) || !names.insert(name) {
            return Err("Invalid DBX backup ZIP: unexpected or duplicate entry.".to_string());
        }
    }

    let manifest_bytes = read_bounded_entry(&mut archive, MANIFEST_ENTRY, 1024 * 1024)?;
    let manifest: LocalBackupManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|error| format!("Invalid DBX backup manifest: {error}"))?;
    if manifest.format != LOCAL_BACKUP_FORMAT || manifest.format_version != LOCAL_BACKUP_FORMAT_VERSION {
        return Err("Unsupported DBX local backup format.".to_string());
    }

    let snapshot_bytes = read_bounded_entry(&mut archive, SNAPSHOT_ENTRY, MAX_SNAPSHOT_BYTES)?;
    serde_json::from_slice(&snapshot_bytes).map_err(|error| format!("Invalid DBX backup snapshot: {error}"))
}

fn read_bounded_entry<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let mut entry = archive.by_name(name).map_err(|error| error.to_string())?;
    if entry.size() > max_bytes {
        return Err(format!("DBX backup entry '{name}' exceeds its size limit."));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.by_ref().take(max_bytes + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("DBX backup entry '{name}' exceeds its size limit."));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_backup_replaces_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("backup.dbx-backup");
        let temporary = directory.path().join(".backup.dbx-backup.staged.tmp");
        fs::write(&destination, b"previous backup").unwrap();
        fs::write(&temporary, b"completed backup").unwrap();

        replace_backup_file(&temporary, &destination).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"completed backup");
        assert!(!temporary.exists());
    }

    #[test]
    fn failed_backup_replacement_preserves_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("backup.dbx-backup");
        let missing_temporary = directory.path().join(".missing.staged.tmp");
        fs::write(&destination, b"previous backup").unwrap();

        assert!(replace_backup_file(&missing_temporary, &destination).is_err());

        assert_eq!(fs::read(&destination).unwrap(), b"previous backup");
    }
}
