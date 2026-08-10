use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::{State, Window};
use tauri_plugin_dialog::DialogExt;

const TRANSFER_CHUNK_BYTES: usize = 256 * 1024;
const MAX_TRANSFER_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_HANDLES_PER_WORKBENCH: usize = 32;
const HANDLE_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Default)]
pub struct PluginFileTransferState {
    handles: Arc<Mutex<HashMap<String, TransferHandle>>>,
}

struct TransferHandle {
    plugin_id: String,
    workbench_id: String,
    last_access: Instant,
    kind: TransferHandleKind,
}

enum TransferHandleKind {
    Source(SourceHandle),
    Target(TargetHandle),
}

struct SourceHandle {
    path: PathBuf,
    size: u64,
}

struct TargetHandle {
    path: PathBuf,
    temporary_path: PathBuf,
    backup_path: PathBuf,
    expected_size: Option<u64>,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFileTransferSource {
    handle_id: String,
    name: String,
    size: u64,
    content_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFileTransferRead {
    data_base64: String,
    length: usize,
    eof: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFileTransferTarget {
    handle_id: String,
    chunk_bytes: usize,
}

impl PluginFileTransferState {
    fn cleanup_expired(&self) {
        let expired = {
            let mut handles = self.handles.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let expired_ids = handles
                .iter()
                .filter_map(|(id, handle)| (handle.last_access.elapsed() >= HANDLE_IDLE_TIMEOUT).then_some(id.clone()))
                .collect::<Vec<_>>();
            expired_ids.into_iter().filter_map(|id| handles.remove(&id)).collect::<Vec<_>>()
        };
        for handle in expired {
            cleanup_handle(handle);
        }
    }

    fn register_sources(
        &self,
        plugin_id: &str,
        workbench_id: &str,
        paths: Vec<PathBuf>,
    ) -> Result<Vec<PluginFileTransferSource>, String> {
        validate_owner(plugin_id, workbench_id)?;
        self.cleanup_expired();
        let sources = paths
            .into_iter()
            .filter_map(|path| {
                let metadata = fs::metadata(&path).ok()?;
                if !metadata.is_file() || metadata.len() > MAX_TRANSFER_BYTES {
                    return None;
                }
                let name = path.file_name()?.to_string_lossy().into_owned();
                Some((path, name, metadata.len()))
            })
            .collect::<Vec<_>>();

        let mut handles = self.handles.lock().map_err(|_| "Plugin file transfer state is unavailable")?;
        let existing = handles
            .values()
            .filter(|handle| handle.plugin_id == plugin_id && handle.workbench_id == workbench_id)
            .count();
        if existing + sources.len() > MAX_HANDLES_PER_WORKBENCH {
            return Err(format!("Plugin workbenches are limited to {MAX_HANDLES_PER_WORKBENCH} file handles"));
        }

        let mut registered = Vec::with_capacity(sources.len());
        for (path, name, size) in sources {
            let handle_id = new_handle_id();
            let content_type = "application/octet-stream".to_string();
            handles.insert(
                handle_id.clone(),
                TransferHandle {
                    plugin_id: plugin_id.to_string(),
                    workbench_id: workbench_id.to_string(),
                    last_access: Instant::now(),
                    kind: TransferHandleKind::Source(SourceHandle { path, size }),
                },
            );
            registered.push(PluginFileTransferSource { handle_id, name, size, content_type });
        }
        Ok(registered)
    }

    fn register_target(
        &self,
        plugin_id: &str,
        workbench_id: &str,
        path: PathBuf,
        expected_size: Option<u64>,
    ) -> Result<PluginFileTransferTarget, String> {
        validate_owner(plugin_id, workbench_id)?;
        if expected_size.is_some_and(|size| size > MAX_TRANSFER_BYTES) {
            return Err("File transfers are limited to 16 GiB".to_string());
        }
        self.cleanup_expired();
        let mut handles = self.handles.lock().map_err(|_| "Plugin file transfer state is unavailable")?;
        let existing = handles
            .values()
            .filter(|handle| handle.plugin_id == plugin_id && handle.workbench_id == workbench_id)
            .count();
        if existing >= MAX_HANDLES_PER_WORKBENCH {
            return Err(format!("Plugin workbenches are limited to {MAX_HANDLES_PER_WORKBENCH} file handles"));
        }

        let handle_id = new_handle_id();
        let (temporary_path, backup_path) = transfer_paths(&path, &handle_id)?;
        if backup_path.exists() {
            fs::remove_file(&backup_path)
                .map_err(|error| format!("Failed to remove stale download backup: {error}"))?;
        }
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
            .map_err(|error| format!("Failed to create download temporary file: {error}"))?;
        handles.insert(
            handle_id.clone(),
            TransferHandle {
                plugin_id: plugin_id.to_string(),
                workbench_id: workbench_id.to_string(),
                last_access: Instant::now(),
                kind: TransferHandleKind::Target(TargetHandle {
                    path,
                    temporary_path,
                    backup_path,
                    expected_size,
                    size: 0,
                }),
            },
        );
        Ok(PluginFileTransferTarget { handle_id, chunk_bytes: TRANSFER_CHUNK_BYTES })
    }

    fn remove_owned(&self, plugin_id: &str, workbench_id: &str, handle_id: &str) -> Result<TransferHandle, String> {
        validate_owner(plugin_id, workbench_id)?;
        validate_handle_id(handle_id)?;
        self.cleanup_expired();
        let mut handles = self.handles.lock().map_err(|_| "Plugin file transfer state is unavailable")?;
        let owned = handles
            .get(handle_id)
            .is_some_and(|handle| handle.plugin_id == plugin_id && handle.workbench_id == workbench_id);
        if !owned {
            return Err("File transfer handle is invalid, expired, or belongs to another workbench".to_string());
        }
        handles.remove(handle_id).ok_or_else(|| "File transfer handle is invalid or expired".to_string())
    }

    pub fn cleanup_workbench(&self, plugin_id: &str, workbench_id: &str) {
        let removed = {
            let mut handles = self.handles.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let ids = handles
                .iter()
                .filter_map(|(id, handle)| {
                    (handle.plugin_id == plugin_id && handle.workbench_id == workbench_id).then_some(id.clone())
                })
                .collect::<Vec<_>>();
            ids.into_iter().filter_map(|id| handles.remove(&id)).collect::<Vec<_>>()
        };
        for handle in removed {
            cleanup_handle(handle);
        }
    }

    pub fn cleanup_all(&self) {
        let removed = {
            let mut handles = self.handles.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            handles.drain().map(|(_, handle)| handle).collect::<Vec<_>>()
        };
        for handle in removed {
            cleanup_handle(handle);
        }
    }
}

pub fn start_plugin_file_transfer_sweeper(state: PluginFileTransferState) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            state.cleanup_expired();
        }
    });
}

#[tauri::command]
pub async fn pick_plugin_file_transfer_sources(
    window: Window,
    state: State<'_, PluginFileTransferState>,
    plugin_id: String,
    workbench_id: String,
    multiple: bool,
) -> Result<Vec<PluginFileTransferSource>, String> {
    validate_owner(&plugin_id, &workbench_id)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let dialog = window.dialog().file();
    if multiple {
        dialog.pick_files(move |paths| {
            let _ = sender.send(paths.unwrap_or_default());
        });
    } else {
        dialog.pick_file(move |path| {
            let _ = sender.send(path.into_iter().collect());
        });
    }
    let paths = receiver
        .await
        .map_err(|_| "File picker closed unexpectedly".to_string())?
        .into_iter()
        .map(|path| path.into_path().map_err(|error| format!("Failed to resolve selected file path: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    state.register_sources(&plugin_id, &workbench_id, paths)
}

#[tauri::command]
pub async fn register_dropped_plugin_file_transfer_sources(
    state: State<'_, PluginFileTransferState>,
    plugin_id: String,
    workbench_id: String,
    paths: Vec<String>,
) -> Result<Vec<PluginFileTransferSource>, String> {
    state.register_sources(&plugin_id, &workbench_id, paths.into_iter().map(PathBuf::from).collect())
}

#[tauri::command]
pub async fn read_plugin_file_transfer_source(
    state: State<'_, PluginFileTransferState>,
    plugin_id: String,
    workbench_id: String,
    handle_id: String,
    offset: u64,
    length: usize,
) -> Result<PluginFileTransferRead, String> {
    validate_owner(&plugin_id, &workbench_id)?;
    validate_handle_id(&handle_id)?;
    if length == 0 || length > TRANSFER_CHUNK_BYTES {
        return Err(format!("File transfer reads are limited to {TRANSFER_CHUNK_BYTES} bytes"));
    }
    state.cleanup_expired();
    let (path, size) = {
        let mut handles = state.handles.lock().map_err(|_| "Plugin file transfer state is unavailable")?;
        let handle = handles
            .get_mut(&handle_id)
            .filter(|handle| handle.plugin_id == plugin_id && handle.workbench_id == workbench_id)
            .ok_or("File transfer handle is invalid, expired, or belongs to another workbench")?;
        let TransferHandleKind::Source(source) = &handle.kind else {
            return Err("File transfer handle is not a readable source".to_string());
        };
        if offset > source.size {
            return Err(format!("File transfer offset {offset} exceeds source size {}", source.size));
        }
        handle.last_access = Instant::now();
        (source.path.clone(), source.size)
    };
    let mut file =
        OpenOptions::new().read(true).open(&path).map_err(|error| format!("Failed to open selected file: {error}"))?;
    file.seek(SeekFrom::Start(offset)).map_err(|error| format!("Failed to seek selected file: {error}"))?;
    let mut bytes = vec![0; length.min((size - offset) as usize)];
    file.read_exact(&mut bytes).map_err(|error| format!("Failed to read selected file: {error}"))?;
    Ok(PluginFileTransferRead {
        data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        length: bytes.len(),
        eof: offset + bytes.len() as u64 >= size,
    })
}

#[tauri::command]
pub async fn begin_plugin_file_transfer_target(
    window: Window,
    state: State<'_, PluginFileTransferState>,
    plugin_id: String,
    workbench_id: String,
    name: String,
    expected_size: Option<u64>,
) -> Result<Option<PluginFileTransferTarget>, String> {
    validate_owner(&plugin_id, &workbench_id)?;
    validate_download_name(&name)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window.dialog().file().set_file_name(name).save_file(move |path| {
        let _ = sender.send(path);
    });
    let Some(path) = receiver.await.map_err(|_| "Save dialog closed unexpectedly".to_string())? else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|error| format!("Failed to resolve download target: {error}"))?;
    state.register_target(&plugin_id, &workbench_id, path, expected_size).map(Some)
}

#[tauri::command]
pub async fn write_plugin_file_transfer_target(
    state: State<'_, PluginFileTransferState>,
    plugin_id: String,
    workbench_id: String,
    handle_id: String,
    offset: u64,
    data_base64: String,
) -> Result<u64, String> {
    write_target(&state, &plugin_id, &workbench_id, &handle_id, offset, &data_base64)
}

fn write_target(
    state: &PluginFileTransferState,
    plugin_id: &str,
    workbench_id: &str,
    handle_id: &str,
    offset: u64,
    data_base64: &str,
) -> Result<u64, String> {
    validate_owner(plugin_id, workbench_id)?;
    validate_handle_id(handle_id)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("Invalid download data: {error}"))?;
    if bytes.len() > TRANSFER_CHUNK_BYTES {
        return Err(format!("File transfer writes are limited to {TRANSFER_CHUNK_BYTES} bytes"));
    }
    state.cleanup_expired();
    let mut handles = state.handles.lock().map_err(|_| "Plugin file transfer state is unavailable")?;
    let handle = handles
        .get_mut(handle_id)
        .filter(|handle| handle.plugin_id == plugin_id && handle.workbench_id == workbench_id)
        .ok_or("File transfer handle is invalid, expired, or belongs to another workbench")?;
    let TransferHandleKind::Target(target) = &mut handle.kind else {
        return Err("File transfer handle is not a writable target".to_string());
    };
    if target.size != offset {
        return Err(format!("File transfer offset {offset} does not match expected offset {}", target.size));
    }
    let next_offset = offset.checked_add(bytes.len() as u64).ok_or("File transfer size overflow")?;
    if next_offset > MAX_TRANSFER_BYTES {
        return Err("File transfers are limited to 16 GiB".to_string());
    }
    if target.expected_size.is_some_and(|size| next_offset > size) {
        return Err("File transfer write exceeds the declared size".to_string());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .open(&target.temporary_path)
        .map_err(|error| format!("Failed to open download temporary file: {error}"))?;
    let current_size = file.metadata().map_err(|error| error.to_string())?.len();
    if current_size != offset {
        return Err(format!("Download temporary file size {current_size} does not match offset {offset}"));
    }
    file.seek(SeekFrom::Start(offset)).map_err(|error| format!("Failed to seek download temporary file: {error}"))?;
    file.write_all(&bytes).map_err(|error| format!("Failed to write download temporary file: {error}"))?;
    file.flush().map_err(|error| format!("Failed to flush download temporary file: {error}"))?;
    target.size = next_offset;
    handle.last_access = Instant::now();
    Ok(next_offset)
}

#[tauri::command]
pub async fn finish_plugin_file_transfer_target(
    state: State<'_, PluginFileTransferState>,
    plugin_id: String,
    workbench_id: String,
    handle_id: String,
) -> Result<(), String> {
    finish_target(&state, &plugin_id, &workbench_id, &handle_id)
}

fn finish_target(
    state: &PluginFileTransferState,
    plugin_id: &str,
    workbench_id: &str,
    handle_id: &str,
) -> Result<(), String> {
    let handle = state.remove_owned(plugin_id, workbench_id, handle_id)?;
    let TransferHandleKind::Target(target) = handle.kind else {
        return Err("File transfer handle is not a writable target".to_string());
    };
    if target.expected_size.is_some_and(|size| target.size != size) {
        cleanup_target(&target);
        return Err(format!(
            "File transfer is incomplete: received {} of {} bytes",
            target.size,
            target.expected_size.unwrap_or_default()
        ));
    }
    commit_target(target)
}

#[tauri::command]
pub async fn release_plugin_file_transfer_handle(
    state: State<'_, PluginFileTransferState>,
    plugin_id: String,
    workbench_id: String,
    handle_id: String,
) -> Result<(), String> {
    let handle = state.remove_owned(&plugin_id, &workbench_id, &handle_id)?;
    cleanup_handle(handle);
    Ok(())
}

#[tauri::command]
pub async fn dispose_plugin_file_transfer_workbench(
    state: State<'_, PluginFileTransferState>,
    plugin_id: String,
    workbench_id: String,
) -> Result<(), String> {
    validate_owner(&plugin_id, &workbench_id)?;
    state.cleanup_workbench(&plugin_id, &workbench_id);
    Ok(())
}

fn transfer_paths(target: &Path, handle_id: &str) -> Result<(PathBuf, PathBuf), String> {
    validate_handle_id(handle_id)?;
    let file_name = target.file_name().ok_or("Download target must be a file")?.to_string_lossy();
    let parent = target.parent().ok_or("Download target must have a parent directory")?;
    Ok((
        parent.join(format!("{file_name}.dbx-{handle_id}.part")),
        parent.join(format!("{file_name}.dbx-{handle_id}.backup")),
    ))
}

fn commit_target(target: TargetHandle) -> Result<(), String> {
    let target_existed = target.path.exists();
    if target_existed {
        if target.backup_path.exists() {
            fs::remove_file(&target.backup_path)
                .map_err(|error| format!("Failed to clear download backup: {error}"))?;
        }
        fs::rename(&target.path, &target.backup_path)
            .map_err(|error| format!("Failed to back up existing download target: {error}"))?;
    }
    if let Err(error) = fs::rename(&target.temporary_path, &target.path) {
        if target_existed {
            let _ = fs::rename(&target.backup_path, &target.path);
        }
        let _ = fs::remove_file(&target.temporary_path);
        return Err(format!("Failed to commit downloaded file: {error}"));
    }
    if target_existed {
        let _ = fs::remove_file(&target.backup_path);
    }
    Ok(())
}

fn cleanup_target(target: &TargetHandle) {
    let _ = fs::remove_file(&target.temporary_path);
    if target.backup_path.exists() {
        if target.path.exists() {
            let _ = fs::remove_file(&target.backup_path);
        } else {
            let _ = fs::rename(&target.backup_path, &target.path);
        }
    }
}

fn cleanup_handle(handle: TransferHandle) {
    if let TransferHandleKind::Target(target) = handle.kind {
        cleanup_target(&target);
    }
}

fn validate_owner(plugin_id: &str, workbench_id: &str) -> Result<(), String> {
    if plugin_id.is_empty()
        || plugin_id.len() > 128
        || !plugin_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err("Plugin file transfer pluginId is invalid".to_string());
    }
    if workbench_id.is_empty()
        || workbench_id.len() > 128
        || !workbench_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b':' | b'-' | b'_'))
    {
        return Err("Plugin file transfer workbenchId is invalid".to_string());
    }
    Ok(())
}

fn validate_handle_id(handle_id: &str) -> Result<(), String> {
    if handle_id.len() < 16
        || handle_id.len() > 64
        || !handle_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid plugin file transfer handle".to_string());
    }
    Ok(())
}

fn validate_download_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 255
        || name.chars().any(|character| {
            character.is_control() || matches!(character, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
    {
        return Err("Download file name is invalid".to_string());
    }
    Ok(())
}

fn new_handle_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with_source(root: &Path) -> (PluginFileTransferState, PluginFileTransferSource) {
        let path = root.join("source.bin");
        fs::write(&path, b"source").unwrap();
        let state = PluginFileTransferState::default();
        let source = state.register_sources("io.dbx.test", "workbench-1", vec![path]).unwrap().remove(0);
        (state, source)
    }

    #[test]
    fn isolates_handles_by_plugin_and_workbench() {
        let root = tempfile::tempdir().unwrap();
        let (state, source) = state_with_source(root.path());

        assert!(state.remove_owned("io.dbx.other", "workbench-1", &source.handle_id).is_err());
        assert!(state.remove_owned("io.dbx.test", "workbench-2", &source.handle_id).is_err());
        assert!(state.remove_owned("io.dbx.test", "workbench-1", &source.handle_id).is_ok());
    }

    #[test]
    fn atomically_replaces_a_desktop_target() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("target.bin");
        fs::write(&path, b"old").unwrap();
        let state = PluginFileTransferState::default();
        let target = state.register_target("io.dbx.test", "workbench-1", path.clone(), Some(3)).unwrap();
        let handle = state.remove_owned("io.dbx.test", "workbench-1", &target.handle_id).unwrap();
        let TransferHandleKind::Target(mut target) = handle.kind else {
            panic!("expected target");
        };
        fs::write(&target.temporary_path, b"new").unwrap();
        target.size = 3;
        commit_target(target).unwrap();
        assert_eq!(fs::read(path).unwrap(), b"new");
    }

    #[test]
    fn rejects_untrusted_owner_and_handle_shapes() {
        assert!(validate_owner("../plugin", "workbench-1").is_err());
        assert!(validate_owner("io.dbx.test", "../workbench").is_err());
        assert!(transfer_paths(Path::new("target.bin"), "../escape").is_err());
    }

    #[test]
    fn enforces_offsets_chunk_limits_and_single_finish() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("target.bin");
        let state = PluginFileTransferState::default();
        let target = state.register_target("io.dbx.test", "workbench-1", path.clone(), Some(3)).unwrap();
        let data = base64::engine::general_purpose::STANDARD.encode(b"new");

        assert!(write_target(&state, "io.dbx.test", "workbench-1", &target.handle_id, 1, &data).is_err());
        assert_eq!(write_target(&state, "io.dbx.test", "workbench-1", &target.handle_id, 0, &data).unwrap(), 3);
        finish_target(&state, "io.dbx.test", "workbench-1", &target.handle_id).unwrap();
        assert_eq!(fs::read(path).unwrap(), b"new");
        assert!(finish_target(&state, "io.dbx.test", "workbench-1", &target.handle_id).is_err());

        let too_large = base64::engine::general_purpose::STANDARD.encode(vec![0_u8; TRANSFER_CHUNK_BYTES + 1]);
        let target = state.register_target("io.dbx.test", "workbench-1", root.path().join("large.bin"), None).unwrap();
        assert!(write_target(&state, "io.dbx.test", "workbench-1", &target.handle_id, 0, &too_large).is_err());
        state.cleanup_all();
    }

    #[test]
    fn expires_idle_handles_and_removes_temporary_files() {
        let root = tempfile::tempdir().unwrap();
        let state = PluginFileTransferState::default();
        let target = state.register_target("io.dbx.test", "workbench-1", root.path().join("target.bin"), None).unwrap();
        let temporary_path = {
            let mut handles = state.handles.lock().unwrap();
            let handle = handles.get_mut(&target.handle_id).unwrap();
            handle.last_access = Instant::now() - HANDLE_IDLE_TIMEOUT - Duration::from_secs(1);
            let TransferHandleKind::Target(target) = &handle.kind else {
                panic!("expected target");
            };
            target.temporary_path.clone()
        };
        assert!(temporary_path.exists());
        state.cleanup_expired();
        assert!(!temporary_path.exists());
        assert!(state.remove_owned("io.dbx.test", "workbench-1", &target.handle_id).is_err());
    }
}
