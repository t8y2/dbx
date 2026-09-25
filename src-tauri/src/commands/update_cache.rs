//! A single committed update. The directory rename is the commit point; partial writes are never read.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadedUpdate {
    pub cache_id: String,
    pub version: String,
    pub portable_mode: bool,
    pub release_url: String,
    pub release_notes: String,
    pub downloaded_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct CacheRecord {
    pub schema_version: u32,
    pub package_kind: String,
    pub package_length: u64,
    pub package_sha256: String,
    pub info: DownloadedUpdate,
    pub os: String,
    pub arch: String,
    pub manifest: Option<serde_json::Value>,
    pub signature: Option<String>,
}

/// Update failures must be diagnosable from a user screenshot, so every cache
/// error names the step and the exact path instead of a bare OS error.
fn context(action: &str, path: &Path, error: impl std::fmt::Display) -> String {
    format!("{action} ({}): {error}", path.display())
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| context("Failed to create the DBX update cache file", path, error))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| context("Failed to write the DBX update cache file", path, error))
}

pub(super) fn commit(root: &Path, record: &CacheRecord, bytes: &[u8]) -> Result<(), String> {
    let metadata = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    if metadata.len() > 4 * 1024 * 1024 || bytes.len() > 512 * 1024 * 1024 {
        return Err("Cached update exceeds size limits.".into());
    }
    fs::create_dir_all(root)
        .map_err(|error| context("Failed to create the DBX update cache directory", root, error))?;
    let staging = root.join(format!("partial-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging)
        .map_err(|error| context("Failed to create the DBX update cache staging directory", &staging, error))?;
    let result = (|| {
        write_synced(&staging.join("package"), bytes)?;
        write_synced(&staging.join("metadata.json"), &metadata)?;
        #[cfg(unix)]
        fs::File::open(&staging).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())?;
        let ready = root.join("ready");
        // Windows cannot rename onto an existing directory: `fs::rename` fails with
        // `os error 5` when `ready` is still present from an earlier attempt. Clear
        // it first so the commit is idempotent and does not need a manual retry.
        discard(root)?;
        fs::rename(&staging, &ready)
            .map_err(|error| context("Failed to finalize the DBX update cache", &ready, error))?;
        #[cfg(unix)]
        fs::File::open(root).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

/// A cache that a security tool or a permission rule blocks is otherwise only
/// discovered mid-download, where it surfaces as a misleading download error.
pub(super) fn ensure_writable(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root)
        .map_err(|error| context("Failed to create the DBX update cache directory", root, error))?;
    let probe = root.join(format!("probe-{}", uuid::Uuid::new_v4()));
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
        .map_err(|error| context("The DBX update cache directory is not writable", root, error))?;
    fs::remove_file(&probe)
        .map_err(|error| context("Failed to clean up the DBX update cache probe file", &probe, error))?;
    Ok(())
}

pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| context("Failed to inspect the DBX update cache file", path, error))?;
    if !metadata.file_type().is_file() || metadata.len() > limit {
        return Err("Invalid cached update file.".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| context("Failed to open the DBX update cache file", path, error))?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| context("Failed to read the DBX update cache file", path, error))?;
    if bytes.len() as u64 > limit {
        return Err("Cached update file exceeds limit.".into());
    }
    Ok(bytes)
}

pub(super) fn read(root: &Path) -> Result<Option<(CacheRecord, Vec<u8>)>, String> {
    let ready = root.join("ready");
    let metadata = match fs::symlink_metadata(&ready) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(context("Failed to inspect the DBX update cache", &ready, e)),
    };
    if !metadata.file_type().is_dir() {
        return Err("Invalid cached update directory.".into());
    }
    let record: CacheRecord = serde_json::from_slice(&read_bounded(&ready.join("metadata.json"), 4 * 1024 * 1024)?)
        .map_err(|e| e.to_string())?;
    if record.schema_version != 1 {
        return Err("Unsupported cached update schema.".into());
    }
    let bytes = read_bounded(&ready.join("package"), 512 * 1024 * 1024)?;
    if record.package_length != bytes.len() as u64 || record.package_sha256 != digest(&bytes) {
        return Err("Cached update package is corrupt.".into());
    }
    Ok(Some((record, bytes)))
}

/// Only called while the updater state is idle and exclusively locked.
pub(super) fn cleanup_partial(root: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(context("Failed to read the DBX update cache directory", root, e)),
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| context("Failed to enumerate the DBX update cache directory", root, error))?;
        if entry.file_name().to_string_lossy().starts_with("partial-") {
            let path = entry.path();
            let action = "Failed to remove an incomplete DBX update cache entry";
            if entry.file_type().map_err(|error| context(action, &path, error))?.is_dir() {
                fs::remove_dir_all(&path).map_err(|error| context(action, &path, error))?;
            } else {
                fs::remove_file(&path).map_err(|error| context(action, &path, error))?;
            }
        }
    }
    Ok(())
}

pub(super) fn discard(root: &Path) -> Result<(), String> {
    let ready = root.join("ready");
    let result = if fs::symlink_metadata(&ready).is_ok_and(|m| !m.file_type().is_dir()) {
        fs::remove_file(&ready)
    } else {
        fs::remove_dir_all(&ready)
    };
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(context("Failed to clear the previous DBX update cache", &ready, e)),
    }
}

pub(super) fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_cache_dir().map(|p| p.join("signed-update-v1")).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // User screenshots only carry the message, so a cache failure has to name
    // the step and the exact path to be actionable.
    #[test]
    fn cache_errors_name_the_step_and_the_path() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::write(&root, b"not a directory").unwrap();
        let error = ensure_writable(&root).unwrap_err();
        assert!(error.contains("update cache"), "{error}");
        assert!(error.contains(&root.display().to_string()), "{error}");
        fs::remove_file(&root).unwrap();
    }

    #[test]
    fn writable_cache_passes_the_preflight_without_leftovers() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        ensure_writable(&root).unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_without_deleting_its_target() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep"), b"unchanged").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("ready")).unwrap();
        assert!(read(&root).is_err());
        discard(&root).unwrap();
        assert!(outside.join("keep").exists());
        fs::remove_dir_all(root).unwrap();
    }

    // A leftover `ready` from an earlier attempt is invisible to `ensure_writable`,
    // yet Windows cannot rename onto an existing directory, so commit must clear it.
    #[test]
    fn commit_replaces_a_leftover_ready_directory_without_a_manual_retry() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let stale = root.join("ready");
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join("package"), b"previous attempt").unwrap();
        let record = CacheRecord {
            schema_version: 1,
            package_kind: "test".into(),
            package_length: 7,
            package_sha256: digest(b"payload"),
            info: DownloadedUpdate {
                cache_id: "test".into(),
                version: "99.0.0".into(),
                portable_mode: false,
                release_url: String::new(),
                release_notes: String::new(),
                downloaded_at: 1,
            },
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            manifest: None,
            signature: None,
        };
        commit(&root, &record, b"payload").unwrap();
        assert_eq!(read(&root).unwrap().unwrap().1, b"payload");
        assert_eq!(fs::read(stale.join("package")).unwrap(), b"payload");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incomplete_writes_are_invisible_and_commit_roundtrips() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("partial-abandoned")).unwrap();
        assert!(read(&root).unwrap().is_none());
        let record = CacheRecord {
            schema_version: 1,
            package_kind: "test".into(),
            package_length: 14,
            package_sha256: digest(b"signed payload"),
            info: DownloadedUpdate {
                cache_id: "test".into(),
                version: "99.0.0".into(),
                portable_mode: false,
                release_url: String::new(),
                release_notes: String::new(),
                downloaded_at: 1,
            },
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            manifest: None,
            signature: None,
        };
        commit(&root, &record, b"signed payload").unwrap();
        assert_eq!(read(&root).unwrap().unwrap().1, b"signed payload");
        commit(&root, &record, b"replacement").unwrap();
        fs::write(root.join("ready/package"), b"changed payload").unwrap();
        assert!(read(&root).unwrap_err().contains("corrupt"));
        fs::write(root.join("ready/package"), b"signed payload").unwrap();
        let mut wrong_schema = record.clone();
        wrong_schema.schema_version = 99;
        fs::write(root.join("ready/metadata.json"), serde_json::to_vec(&wrong_schema).unwrap()).unwrap();
        assert!(read(&root).unwrap_err().contains("schema"));
        fs::write(root.join("ready/metadata.json"), b"truncated").unwrap();
        assert!(read(&root).is_err());
        discard(&root).unwrap();
        assert!(read(&root).unwrap().is_none());
        cleanup_partial(&root).unwrap();
        assert!(!root.join("partial-abandoned").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
