//! Eager plugin-file handles: the shared 64-slot registry that backs native
//! dialog picks and save streams, plus the chunked read/write/close protocol
//! over both eager handles and lazily-registered drop entries.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use uuid::Uuid;

use super::drop::register_dropped_file;
use super::{
    file_identity, guess_content_type, OpenFile, PluginFileHandle, PluginFileReadChunk, PluginFileState,
    PluginFileWriteResult, MAX_CHUNK_BYTES, MAX_OPEN_HANDLES, SAVE_CHUNK_BYTES,
};

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
pub(super) fn open_plugin_file(
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
        Ok(PluginFileHandle {
            handle_id,
            name,
            size,
            content_type: guess_content_type(path),
            write,
            relative_path: String::new(),
        })
    })
}

pub(super) fn read_plugin_file_chunk(
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
    // Eager handles (dialog picks, save handles) live in the handle registry;
    // drop entries live in the metadata registry and open just-in-time.
    let eager = state.handles.lock().map_err(|_| "plugin file registry poisoned".to_string())?.contains_key(handle_id);
    if eager {
        return with_handles(state, |handles| {
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
        });
    }
    read_dropped_file_chunk(state, plugin_id, handle_id, offset, requested)
}

/// Streaming read of a lazily-registered drop entry: the fd exists only for
/// this chunk, so plugins can stream multi-gigabyte files while the registry
/// stays empty between reads.
fn read_dropped_file_chunk(
    state: &PluginFileState,
    plugin_id: &str,
    handle_id: &str,
    offset: u64,
    requested: usize,
) -> Result<PluginFileReadChunk, String> {
    let entry = {
        let dropped = state.dropped_files.lock().map_err(|_| "plugin file registry poisoned".to_string())?;
        let entry = dropped.get(handle_id).ok_or_else(|| "unknown plugin file handle".to_string())?;
        if entry.owner != plugin_id {
            // Same indistinguishable-from-missing convention as the eager registry.
            log::warn!("plugin file entry belongs to another plugin (caller: {plugin_id})");
            return Err("unknown plugin file handle".to_string());
        }
        entry.clone()
    };
    let mut file = File::open(&entry.path).map_err(|error| format!("cannot open file: {error}"))?;
    // fstat the OPEN fd (no path race): the file on disk must still be the
    // one the drop granted, not a path that was swapped out afterwards.
    let opened = file.metadata().map_err(|error| format!("cannot stat file: {error}"))?;
    if let Some((dev, ino)) = entry.identity {
        if file_identity(&opened) != Some((dev, ino)) {
            log::warn!("plugin drop: file behind a granted entry was replaced since the drop (plugin: {plugin_id})");
            return Err("file changed since the drop was granted".to_string());
        }
    }
    // Size is taken at read time: the file may have changed since the drop,
    // and bounds must match what is actually on disk.
    let size = opened.len();
    if offset > size {
        return Err("read offset beyond end of file".to_string());
    }
    file.seek(SeekFrom::Start(offset)).map_err(|error| format!("seek failed: {error}"))?;
    let remaining = (size - offset) as usize;
    let mut buffer = vec![0u8; requested.min(remaining).clamp(1, MAX_CHUNK_BYTES)];
    let read = file.read(&mut buffer).map_err(|error| format!("read failed: {error}"))?;
    buffer.truncate(read);
    let eof = offset + read as u64 >= size;
    Ok(PluginFileReadChunk { data_base64: BASE64.encode(&buffer), length: read, eof })
}

pub(super) fn write_plugin_file_chunk(
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

/// Host-side sweep: closes every eager handle and retires every drop entry
/// owned by one plugin. Workbench teardown and plugin stop/uninstall call this
/// so a crashed or sloppy renderer path cannot pin the shared 64-slot registry
/// (or accumulate drop metadata) until process exit. Returns how many entries
/// were reclaimed.
pub fn close_all_plugin_files(state: &PluginFileState, plugin_id: &str) -> usize {
    let mut closed = 0;
    if let Ok(mut handles) = state.handles.lock() {
        let stale: Vec<String> =
            handles.iter().filter(|(_, entry)| entry.owner == plugin_id).map(|(id, _)| id.clone()).collect();
        for id in stale {
            if let Some(entry) = handles.remove(&id) {
                // Best-effort flush for write handles; the sweep runs at
                // teardown, where a failed fsync has no one left to report to.
                if entry.write {
                    let _ = entry.file.sync_all();
                }
                closed += 1;
            }
        }
    }
    if let Ok(mut dropped) = state.dropped_files.lock() {
        let before = dropped.len();
        dropped.retain(|_, entry| entry.owner != plugin_id);
        closed += before - dropped.len();
    }
    if closed > 0 {
        log::info!("plugin file sweep reclaimed {closed} entries for plugin \"{plugin_id}\"");
    }
    closed
}
// No `plugin_file_close_all` command on purpose: an owner-wide sweep kills
// every workbench instance of that plugin, so it is reserved for Rust-side
// lifecycle paths (stop/uninstall). Renderer teardown closes its own handles
// precisely, by id.

/// Close a handle. Write handles are flushed to disk before dropping; the
/// bytes were already handed to the OS through `write_all`, so failure here
/// means the OS could not flush — surfaced to the plugin as an error. Drop
/// entries have no fd: closing just retires the metadata entry.
pub(super) fn close_plugin_file(state: &PluginFileState, plugin_id: &str, handle_id: &str) -> Result<(), String> {
    // Probe the registries by key, not by matching error strings: the string
    // is the plugin-facing wire contract and must stay free to change without
    // silently rerouting closes.
    let has_eager =
        state.handles.lock().map_err(|_| "plugin file registry poisoned".to_string())?.contains_key(handle_id);
    if has_eager {
        return with_handles(state, |handles| {
            {
                let entry = owned_handle(handles, plugin_id, handle_id)?;
                if entry.write {
                    entry.file.sync_all().map_err(|error| format!("flush failed: {error}"))?;
                }
            }
            handles.remove(handle_id).map(|_| ()).ok_or_else(|| "unknown plugin file handle".to_string())
        });
    }
    let mut dropped = state.dropped_files.lock().map_err(|_| "plugin file registry poisoned".to_string())?;
    match dropped.get(handle_id) {
        Some(entry) if entry.owner == plugin_id => {
            dropped.remove(handle_id);
            Ok(())
        }
        Some(_) => {
            log::warn!("plugin file entry belongs to another plugin (caller: {plugin_id})");
            Err("unknown plugin file handle".to_string())
        }
        None => Err("unknown plugin file handle".to_string()),
    }
}

/// Opens a picked file for reading: an eager handle while the shared registry
/// has room, otherwise a lazily-opened drop-style entry. Picking 100 photos
/// must deliver 100 handles — a full registry downgrades the mode, it never
/// silently drops files the user selected.
pub(super) fn open_read_handle_or_lazy(
    state: &PluginFileState,
    plugin_id: &str,
    path: &Path,
) -> Result<PluginFileHandle, String> {
    let registry_full =
        state.handles.lock().map_err(|_| "plugin file registry poisoned".to_string())?.len() >= MAX_OPEN_HANDLES;
    if registry_full {
        let metadata = std::fs::metadata(path).map_err(|error| format!("cannot stat file: {error}"))?;
        let size = metadata.len();
        return register_dropped_file(state, plugin_id, path, "", size, file_identity(&metadata));
    }
    open_plugin_file(state, plugin_id, &path.to_string_lossy(), false)
}
