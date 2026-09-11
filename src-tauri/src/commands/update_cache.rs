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

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| e.to_string())?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())
}

pub(super) fn commit(root: &Path, record: &CacheRecord, bytes: &[u8]) -> Result<(), String> {
    let metadata = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    if metadata.len() > 4 * 1024 * 1024 || bytes.len() > 512 * 1024 * 1024 {
        return Err("Cached update exceeds size limits.".into());
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let staging = root.join(format!("partial-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        write_synced(&staging.join("package"), bytes)?;
        write_synced(&staging.join("metadata.json"), &metadata)?;
        #[cfg(unix)]
        fs::File::open(&staging).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())?;
        fs::rename(&staging, root.join("ready")).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        fs::File::open(root).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.file_type().is_file() || metadata.len() > limit {
        return Err("Invalid cached update file.".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
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
        Err(e) => return Err(e.to_string()),
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
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name().to_string_lossy().starts_with("partial-") {
            if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
            } else {
                fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

pub(super) fn discard(root: &Path) -> Result<(), String> {
    let ready = root.join("ready");
    let result = if fs::symlink_metadata(&ready).is_ok_and(|m| !m.file_type().is_dir()) {
        fs::remove_file(ready)
    } else {
        fs::remove_dir_all(ready)
    };
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub(super) fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_cache_dir().map(|p| p.join("signed-update-v1")).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(commit(&root, &record, b"replacement").is_err());
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
