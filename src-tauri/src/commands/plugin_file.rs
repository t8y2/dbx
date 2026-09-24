//! Streaming local-file access for plugin workbench bridges.
//!
//! Plugin sandboxes run with an opaque origin, so they can neither read local
//! files dropped onto the window nor stream multi-gigabyte transfers through a
//! one-shot IPC. The workbench host opens handles through this registry after
//! the user picked the file in a native dialog or dropped it onto the plugin's
//! workbench area — both are explicit user consent, and every open goes through
//! the workbench-host TS layer, which is the only caller of these commands.
//!
//! Every handle is owned by the plugin that opened it: all operations carry the
//! caller's plugin id and are rejected unless it matches, and ids come from
//! uuid v4 so a malicious plugin cannot enumerate another plugin's handles.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

/// Mirrors the bridge binary cap: one read/write chunk never exceeds it.
pub const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// Chunk size advertised to plugins for `beginSave` writes: comfortably below
/// the 2 MiB bridge payload limit after base64 inflation.
pub const SAVE_CHUNK_BYTES: usize = 1024 * 1024;

const MAX_OPEN_HANDLES: usize = 64;

struct OpenFile {
    file: File,
    write: bool,
    size: u64,
    owner: String,
}

#[derive(Default)]
pub struct PluginFileState {
    handles: Mutex<HashMap<String, OpenFile>>,
}

impl PluginFileState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFileHandle {
    /// Opaque handle id, carried as a UUID string on the wire — the same
    /// convention as `downloadId`. It must never be a JSON number: ids are
    /// parsed as doubles in every JS layer, and a u64 loses precision above
    /// `Number.MAX_SAFE_INTEGER`, which silently corrupted ids and failed
    /// every bridge read/write with "unknown plugin file handle".
    handle_id: String,
    name: String,
    size: u64,
    content_type: String,
    write: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFileReadChunk {
    data_base64: String,
    length: usize,
    eof: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFileWriteResult {
    written: usize,
    next_offset: u64,
}

/// Content type is best-effort from the extension; plugins only use it for
/// display and dialog filters, so unknown types stay generic.
fn guess_content_type(path: &Path) -> String {
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        "mp3" => "audio/mpeg",
        "mp4" | "m4v" => "video/mp4",
        "sql" => "application/sql",
        "pem" | "key" => "application/x-pem-file",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn with_handles<T>(
    state: &PluginFileState,
    body: impl FnOnce(&mut HashMap<String, OpenFile>) -> Result<T, String>,
) -> Result<T, String> {
    let mut handles = state.handles.lock().map_err(|_| "plugin file registry poisoned".to_string())?;
    body(&mut handles)
}

fn owned_handle<'a>(
    handles: &'a mut HashMap<String, OpenFile>,
    plugin_id: &str,
    handle_id: &str,
) -> Result<&'a mut OpenFile, String> {
    let entry = handles.get_mut(handle_id).ok_or_else(|| "unknown plugin file handle".to_string())?;
    if entry.owner != plugin_id {
        // Response stays indistinguishable from a missing handle: a plugin must
        // not learn that another plugin's handle ids exist. The host log is the
        // one place the two cases can be told apart when debugging.
        log::warn!("plugin file handle belongs to another plugin (caller: {plugin_id})");
        return Err("unknown plugin file handle".to_string());
    }
    Ok(entry)
}

/// Open a local file for the plugin bridge. `write` handles truncate existing
/// content (the path comes from the native save dialog, where the user already
/// confirmed overwriting); they may not exist yet.
pub fn open_plugin_file(
    state: &PluginFileState,
    plugin_id: &str,
    path: &str,
    write: bool,
) -> Result<PluginFileHandle, String> {
    if plugin_id.trim().is_empty() {
        return Err("plugin id is required".to_string());
    }
    let path = Path::new(path);
    let metadata = std::fs::metadata(path);
    if let Ok(metadata) = &metadata {
        if !write && metadata.is_dir() {
            return Err("path is a directory".to_string());
        }
    }
    let file = if write {
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .map_err(|error| format!("cannot open file for writing: {error}"))?
    } else {
        File::open(path).map_err(|error| format!("cannot open file: {error}"))?
    };
    let size = match &metadata {
        Ok(metadata) if !write => metadata.len(),
        _ => 0,
    };
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("download.bin").to_string();

    with_handles(state, |handles| {
        if handles.len() >= MAX_OPEN_HANDLES {
            return Err(format!("too many open plugin file handles (max {MAX_OPEN_HANDLES})"));
        }
        // Unguessable id: a plugin that can only reach its own bridge must not
        // be able to walk the registry by trying sequential ids. Same wire
        // convention as downloadId: uuid v4, carried as a string so no JS
        // layer can lose precision on it.
        let handle_id = Uuid::new_v4().to_string();
        handles.insert(handle_id.clone(), OpenFile { file, write, size, owner: plugin_id.to_string() });
        Ok(PluginFileHandle { handle_id, name, size, content_type: guess_content_type(path), write })
    })
}

pub fn read_plugin_file_chunk(
    state: &PluginFileState,
    plugin_id: &str,
    handle_id: &str,
    offset: u64,
    length: Option<u32>,
) -> Result<PluginFileReadChunk, String> {
    let requested = length.unwrap_or(SAVE_CHUNK_BYTES as u32) as usize;
    if requested == 0 {
        return Err("read length must be positive".to_string());
    }
    with_handles(state, |handles| {
        let entry = owned_handle(handles, plugin_id, handle_id)?;
        if entry.write {
            return Err("handle is write-only".to_string());
        }
        if offset > entry.size {
            return Err("read offset beyond end of file".to_string());
        }
        entry.file.seek(SeekFrom::Start(offset)).map_err(|error| format!("seek failed: {error}"))?;
        let remaining = (entry.size - offset) as usize;
        let mut buffer = vec![0u8; requested.min(remaining).clamp(1, MAX_CHUNK_BYTES)];
        let read = entry.file.read(&mut buffer).map_err(|error| format!("read failed: {error}"))?;
        buffer.truncate(read);
        let eof = offset + read as u64 >= entry.size;
        Ok(PluginFileReadChunk { data_base64: BASE64.encode(&buffer), length: read, eof })
    })
}

pub fn write_plugin_file_chunk(
    state: &PluginFileState,
    plugin_id: &str,
    handle_id: &str,
    offset: u64,
    data_base64: &str,
) -> Result<PluginFileWriteResult, String> {
    if data_base64.len() > MAX_CHUNK_BYTES * 4 / 3 + 4 {
        return Err(format!("write chunk exceeds {MAX_CHUNK_BYTES} bytes"));
    }
    let bytes = BASE64.decode(data_base64.as_bytes()).map_err(|error| format!("invalid base64 payload: {error}"))?;
    with_handles(state, |handles| {
        let entry = owned_handle(handles, plugin_id, handle_id)?;
        if !entry.write {
            return Err("handle is read-only".to_string());
        }
        entry.file.seek(SeekFrom::Start(offset)).map_err(|error| format!("seek failed: {error}"))?;
        entry.file.write_all(&bytes).map_err(|error| format!("write failed: {error}"))?;
        Ok(PluginFileWriteResult { written: bytes.len(), next_offset: offset + bytes.len() as u64 })
    })
}

/// Close a handle. Write handles are flushed to disk before dropping; the
/// bytes were already handed to the OS through `write_all`, so failure here
/// means the OS could not flush — surfaced to the plugin as an error.
pub fn close_plugin_file(state: &PluginFileState, plugin_id: &str, handle_id: &str) -> Result<(), String> {
    with_handles(state, |handles| {
        {
            let entry = owned_handle(handles, plugin_id, handle_id)?;
            if entry.write {
                entry.file.sync_all().map_err(|error| format!("flush failed: {error}"))?;
            }
        }
        handles.remove(handle_id).map(|_| ()).ok_or_else(|| "unknown plugin file handle".to_string())
    })
}

#[tauri::command]
pub fn plugin_file_open(
    state: State<'_, PluginFileState>,
    plugin_id: String,
    path: String,
    write: Option<bool>,
) -> Result<PluginFileHandle, String> {
    open_plugin_file(&state, &plugin_id, &path, write == Some(true))
}

#[tauri::command]
pub fn plugin_file_read(
    state: State<'_, PluginFileState>,
    plugin_id: String,
    handle_id: String,
    offset: u64,
    length: Option<u32>,
) -> Result<PluginFileReadChunk, String> {
    read_plugin_file_chunk(&state, &plugin_id, &handle_id, offset, length)
}

#[tauri::command]
pub fn plugin_file_write(
    state: State<'_, PluginFileState>,
    plugin_id: String,
    handle_id: String,
    offset: u64,
    data_base64: String,
) -> Result<PluginFileWriteResult, String> {
    write_plugin_file_chunk(&state, &plugin_id, &handle_id, offset, &data_base64)
}

#[tauri::command]
pub fn plugin_file_close(
    state: State<'_, PluginFileState>,
    plugin_id: String,
    handle_id: String,
) -> Result<(), String> {
    close_plugin_file(&state, &plugin_id, &handle_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "io.dbx.sample";
    const OTHER: &str = "io.dbx.other";

    fn temp_file(name: &str, contents: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("dbx-plugin-file-{}-{name}", std::process::id()));
        std::fs::write(&path, contents).expect("write temp file");
        path
    }

    #[test]
    fn open_read_and_close_roundtrip() {
        let path = temp_file("roundtrip.bin", b"hello plugin bridge");
        let state = PluginFileState::new();
        let handle = open_plugin_file(&state, OWNER, path.to_string_lossy().as_ref(), false).expect("open");
        assert_eq!(handle.size, 19);
        assert_eq!(handle.name, path.file_name().and_then(|value| value.to_str()).unwrap());
        assert!(!handle.write);
        assert_eq!(handle.content_type, "application/octet-stream");

        let chunk = read_plugin_file_chunk(&state, OWNER, &handle.handle_id, 6, Some(6)).expect("read");
        assert_eq!(BASE64.decode(chunk.data_base64).unwrap(), b"plugin");
        assert!(!chunk.eof);
        let tail = read_plugin_file_chunk(&state, OWNER, &handle.handle_id, 13, Some(64)).expect("read tail");
        assert_eq!(BASE64.decode(tail.data_base64).unwrap(), b"bridge");
        assert!(tail.eof);

        close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        assert!(read_plugin_file_chunk(&state, OWNER, &handle.handle_id, 0, None).is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn handles_reject_other_plugins() {
        let path = temp_file("ownership.bin", b"secret");
        let state = PluginFileState::new();
        let handle = open_plugin_file(&state, OWNER, path.to_string_lossy().as_ref(), false).expect("open");

        let foreign_read = read_plugin_file_chunk(&state, OTHER, &handle.handle_id, 0, None).unwrap_err();
        assert_eq!(foreign_read, "unknown plugin file handle");
        let foreign_write =
            write_plugin_file_chunk(&state, OTHER, &handle.handle_id, 0, &BASE64.encode(b"x")).unwrap_err();
        assert_eq!(foreign_write, "unknown plugin file handle");
        let foreign_close = close_plugin_file(&state, OTHER, &handle.handle_id).unwrap_err();
        assert_eq!(foreign_close, "unknown plugin file handle");
        assert!(read_plugin_file_chunk(&state, OWNER, &handle.handle_id, 0, None).is_ok());

        close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn write_handle_truncates_and_persists() {
        let path = temp_file("write.bin", b"stale contents");
        let state = PluginFileState::new();
        let handle = open_plugin_file(&state, OWNER, path.to_string_lossy().as_ref(), true).expect("open write");
        assert!(handle.write);
        assert_eq!(handle.size, 0);
        assert!(
            read_plugin_file_chunk(&state, OWNER, &handle.handle_id, 0, None).is_err(),
            "write handles reject reads"
        );

        let written =
            write_plugin_file_chunk(&state, OWNER, &handle.handle_id, 0, &BASE64.encode(b"fresh")).expect("write");
        assert_eq!(written.written, 5);
        assert_eq!(written.next_offset, 5);
        close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");

        assert_eq!(std::fs::read(&path).unwrap(), b"fresh");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn write_handle_can_target_a_file_that_does_not_exist_yet() {
        let path = std::env::temp_dir().join(format!("dbx-plugin-file-{}-new.bin", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let state = PluginFileState::new();
        let handle = open_plugin_file(&state, OWNER, path.to_string_lossy().as_ref(), true).expect("open write");
        write_plugin_file_chunk(&state, OWNER, &handle.handle_id, 0, &BASE64.encode(b"data")).expect("write");
        close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        assert_eq!(std::fs::read(&path).unwrap(), b"data");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_directory_unknown_handles_and_missing_plugin_id() {
        let state = PluginFileState::new();
        let error =
            open_plugin_file(&state, OWNER, std::env::temp_dir().to_string_lossy().as_ref(), false).unwrap_err();
        assert!(error.contains("directory"));
        assert!(open_plugin_file(&state, "  ", std::env::temp_dir().to_string_lossy().as_ref(), false).is_err());
        assert!(read_plugin_file_chunk(&state, OWNER, "00000000-0000-4000-8000-000000000099", 0, None).is_err());
        assert!(close_plugin_file(&state, OWNER, "00000000-0000-4000-8000-000000000099").is_err());
    }

    #[test]
    fn read_rejects_offset_beyond_size() {
        let path = temp_file("bounds.bin", b"abc");
        let state = PluginFileState::new();
        let handle = open_plugin_file(&state, OWNER, path.to_string_lossy().as_ref(), false).expect("open");
        assert!(read_plugin_file_chunk(&state, OWNER, &handle.handle_id, 4, None).is_err());
        let at_end = read_plugin_file_chunk(&state, OWNER, &handle.handle_id, 3, None).expect("read at eof");
        assert!(at_end.eof);
        assert_eq!(at_end.length, 0);
        close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn content_type_is_guessed_from_extension() {
        let mut path = temp_file("ctype.svg", b"<svg/>");
        let state = PluginFileState::new();
        let handle = open_plugin_file(&state, OWNER, path.to_string_lossy().as_ref(), false).expect("open");
        assert_eq!(handle.content_type, "image/svg+xml");
        close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        let _ = std::fs::remove_file(&path);

        path.set_extension("weird");
        std::fs::write(&path, b"x").unwrap();
        let handle = open_plugin_file(&state, OWNER, path.to_string_lossy().as_ref(), false).expect("open");
        assert_eq!(handle.content_type, "application/octet-stream");
        close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn handle_id_follows_the_uuid_string_wire_convention() {
        // Handle ids ride the bridge as opaque strings, same as downloadId.
        // The old wire format serialized a u64 JSON number: ids above
        // Number.MAX_SAFE_INTEGER were rounded by every JS layer, so the host
        // looked a fresh handle up under a different key and failed every
        // read/write with "unknown plugin file handle".
        let path = temp_file("wire-uuid.bin", b"payload");
        let state = PluginFileState::new();
        let handle = open_plugin_file(&state, OWNER, path.to_string_lossy().as_ref(), false).expect("open");
        let wire_json = serde_json::to_string(&handle.handle_id).expect("serialize id");
        assert_eq!(wire_json, format!("\"{}\"", handle.handle_id), "the wire id is a JSON string, never a number");
        let parsed = uuid::Uuid::parse_str(&handle.handle_id).expect("id parses as uuid, like downloadId");
        assert_eq!(parsed.to_string(), handle.handle_id);

        // The exact string the host sent back must hit the same registry key.
        let chunk = read_plugin_file_chunk(&state, OWNER, &handle.handle_id, 0, None).expect("read via wire id");
        assert_eq!(BASE64.decode(chunk.data_base64).unwrap(), b"payload");
        close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        let _ = std::fs::remove_file(path);
    }
}
