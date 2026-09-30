//! Streaming local-file access for plugin workbench bridges.
//!
//! Plugin sandboxes run with an opaque origin, so they can neither read local
//! files dropped onto the window nor stream multi-gigabyte transfers through a
//! one-shot IPC. Handles are opened through this registry, and every path
//! enters it through a Rust-anchored consent channel — never a path string the
//! renderer merely claims:
//! - `plugin_file_pick_files` / `plugin_file_save_as` open the native dialog
//!   on the Rust side and return handles for exactly what the user picked;
//! - OS drops are captured by the native drag-drop pipeline
//!   ([`tauri::Builder::on_window_event`]) and registered per webview, and
//!   `plugin_file_open_dropped` only accepts paths that this webview actually
//!   received, consuming the grant on use; a dropped folder expands to the
//!   regular files it contains, so the plugin gets files, not the folder.
//!   Drop entries are lazily opened: the grant registers metadata only, and
//!   the fd exists just for the duration of each chunk read, so a folder of
//!   any practical size cannot exhaust the handle registry.
//!
//! Every handle is owned by the plugin that opened it: all operations carry the
//! caller's plugin id and are rejected unless it matches, and ids come from
//! uuid v4 so a malicious plugin cannot enumerate another plugin's handles.

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

/// Mirrors the bridge binary cap: one read/write chunk never exceeds it.
pub const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// Chunk size advertised to plugins for `beginSave` writes: comfortably below
/// the 2 MiB bridge payload limit after base64 inflation.
pub const SAVE_CHUNK_BYTES: usize = 1024 * 1024;

const MAX_OPEN_HANDLES: usize = 64;

/// A dropped folder expands to at most this many contained files. Entries are
/// metadata-only (no fd, no registry slot), so the cap only bounds the
/// synchronous expansion walk and the filedrop message size, not handles.
const MAX_DROP_FOLDER_FILES: usize = 2000;
/// Recursion guard for the folder expansion walk; deeper trees are ignored.
const MAX_DROP_FOLDER_DEPTH: usize = 8;
/// Total lazy drop entries alive at once, across plugins: metadata is cheap
/// but not free, and an unbounded session of large folder drops should fail
/// loudly at the door instead of growing forever.
const MAX_DROPPED_FILES: usize = 10_000;
/// A drop grant expires. Consent is anchored to the drop event: a path from a
/// drag that happened minutes ago must not open in a renderer that never saw
/// it. Generous enough for the immediate open flow, including slow
/// network-volume expansion.
const GRANT_TTL: Duration = Duration::from_secs(60);

struct OpenFile {
    file: File,
    write: bool,
    size: u64,
    owner: String,
}

/// A drop-granted file held as metadata only: opened just-in-time for each
/// chunk read, so it never occupies a slot in the 64-handle registry.
#[derive(Clone)]
struct DroppedFile {
    path: std::path::PathBuf,
    owner: String,
    /// Platform file identity (dev, ino) captured at registration. Reads
    /// fstat the opened file and refuse on mismatch, so a path that was
    /// swapped out after the drop cannot be read through the grant. `None`
    /// where the platform has no stable id.
    identity: Option<(u64, u64)>,
}

/// One outstanding drop grant: the OS delivered this path to the webview, and
/// the renderer may claim exactly one open attempt for it within the TTL.
struct DroppedGrant {
    path: String,
    granted_at: Instant,
}

/// Identity of the file a grant points at, from resolved (follows symlinks)
/// metadata — the same resolution a later read performs.
#[cfg(unix)]
fn file_identity(metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn file_identity(_metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    None
}

#[derive(Default)]
pub struct PluginFileState {
    handles: Mutex<HashMap<String, OpenFile>>,
    /// Drop-granted files waiting to be read. Metadata only: reads open the
    /// path on demand and never hold a persistent fd.
    dropped_files: Mutex<HashMap<String, DroppedFile>>,
    /// Local paths the native drag-drop pipeline delivered to each webview,
    /// waiting to be claimed by `plugin_file_open_dropped`. Registered only by
    /// the window-event hook (one grant per dropped path — file or folder),
    /// consumed on open; a claimed folder expands to its contained files.
    /// Grants expire (see `GRANT_TTL`): a drop authorizes the immediate open
    /// flow, not a renderer claim at any future time.
    dropped_paths: Mutex<HashMap<String, Vec<DroppedGrant>>>,
}

impl PluginFileState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records the files the native drop pipeline just delivered to a webview.
    /// Expired grants for the same webview are retired on the way in.
    pub fn register_dropped_paths(&self, webview_label: &str, paths: Vec<String>) {
        if paths.is_empty() {
            return;
        }
        let now = Instant::now();
        if let Ok(mut dropped) = self.dropped_paths.lock() {
            let entries = dropped.entry(webview_label.to_string()).or_default();
            entries.retain(|grant| now.duration_since(grant.granted_at) <= GRANT_TTL);
            entries.extend(paths.into_iter().map(|path| DroppedGrant { path, granted_at: now }));
        }
    }

    /// Claims a dropped path for opening: one dropped path authorizes exactly
    /// one open attempt, in the webview that received it, within the grant
    /// TTL. A folder grant expands to several handles but is still one
    /// attempt.
    fn consume_dropped_path(&self, webview_label: &str, path: &str) -> bool {
        let Ok(mut dropped) = self.dropped_paths.lock() else {
            return false;
        };
        let Some(entries) = dropped.get_mut(webview_label) else {
            return false;
        };
        let now = Instant::now();
        if let Some(position) =
            entries.iter().position(|grant| grant.path == path && now.duration_since(grant.granted_at) <= GRANT_TTL)
        {
            entries.remove(position);
            if entries.is_empty() {
                dropped.remove(webview_label);
            }
            true
        } else {
            // Opportunistically retire whatever expired here, so stale grants
            // never outlive the page that earned them.
            entries.retain(|grant| now.duration_since(grant.granted_at) <= GRANT_TTL);
            if entries.is_empty() {
                dropped.remove(webview_label);
            }
            false
        }
    }

    /// Drops every outstanding grant for a webview. Called when the window is
    /// destroyed: a page that no longer exists must not leave authorization
    /// behind for a future renderer to claim.
    pub fn clear_dropped_paths(&self, webview_label: &str) {
        if let Ok(mut dropped) = self.dropped_paths.lock() {
            dropped.remove(webview_label);
        }
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
    /// Only for files expanded out of a dropped folder: path relative to the
    /// dropped folder root, '/'-separated. Empty otherwise (dialog picks,
    /// top-level dropped files), and omitted from the JSON to keep the
    /// dialog-era payload shape unchanged.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    relative_path: String,
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

/// The wire result of one OS drop: which files were handed over, whether the
/// delivery was cut short by an expansion cap, and an id that groups the
/// entries of this drop together. `truncated` makes partial delivery a
/// protocol-level fact the plugin can surface, not a host-log footnote;
/// `dropId` gives cancellation and progress bookkeeping a grouping key.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFilesResult {
    drop_id: String,
    files: Vec<PluginFileHandle>,
    #[serde(default)]
    truncated: bool,
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

mod drop;
mod registry;

use drop::open_dropped_plugin_files;
pub use registry::close_all_plugin_files;
use registry::{
    close_plugin_file, open_plugin_file, open_read_handle_or_lazy, read_plugin_file_chunk, write_plugin_file_chunk,
};

#[tauri::command]
pub async fn plugin_file_open_dropped(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    paths: Vec<String>,
) -> DroppedFilesResult {
    // Folder expansion reads up to thousands of directory entries — latency
    // that reaches seconds on network volumes — so it must leave the main
    // thread instead of freezing the whole window mid-drop.
    let webview_label = webview.label().to_string();
    let expanded = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PluginFileState>();
        open_dropped_plugin_files(state.inner(), &webview_label, &plugin_id, &paths)
    })
    .await;
    match expanded {
        Ok(result) => result,
        Err(error) => {
            log::error!("plugin_file_open_dropped expansion task failed: {error}");
            DroppedFilesResult { drop_id: Uuid::new_v4().to_string(), files: Vec::new(), truncated: false }
        }
    }
}

/// Opens the native open dialog on the Rust side and returns read handles for
/// exactly the files the user picked. The renderer never sees the paths and
/// cannot pass its own: user consent happens inside this command.
#[tauri::command]
pub async fn plugin_file_pick_files(
    app: tauri::AppHandle,
    state: State<'_, PluginFileState>,
    plugin_id: String,
    multiple: Option<bool>,
) -> Result<Vec<PluginFileHandle>, String> {
    if plugin_id.trim().is_empty() {
        return Err("plugin id is required".to_string());
    }
    let picked = if multiple == Some(true) {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.dialog().file().pick_files(move |paths| {
            let _ = sender.send(paths);
        });
        receiver.await.map_err(|error| error.to_string())?
    } else {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.dialog().file().pick_file(move |path| {
            let _ = sender.send(path);
        });
        receiver.await.map_err(|error| error.to_string())?.map(|path| vec![path])
    };
    let mut handles = Vec::new();
    for path in picked.into_iter().flatten() {
        let Ok(path) = path.into_path() else { continue };
        match open_read_handle_or_lazy(&state, &plugin_id, &path) {
            Ok(handle) => handles.push(handle),
            Err(error) => log::warn!("plugin file pick: cannot open {}: {error}", path.display()),
        }
    }
    Ok(handles)
}

/// Opens the native save dialog on the Rust side and returns a write handle
/// for the path the user confirmed. The renderer only controls the suggested
/// file name: the dialog itself is the consent, and the path never round-trips
/// through renderer-controlled arguments.
#[tauri::command]
pub async fn plugin_file_save_as(
    app: tauri::AppHandle,
    state: State<'_, PluginFileState>,
    plugin_id: String,
    default_file_name: Option<String>,
) -> Result<Option<PluginFileHandle>, String> {
    if plugin_id.trim().is_empty() {
        return Err("plugin id is required".to_string());
    }
    // The name comes from the plugin; keep it a bare file name.
    let file_name = default_file_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.rsplit(['/', '\\']).next().unwrap_or("download.bin").to_string());
    let mut dialog = app.dialog().file();
    if let Some(name) = &file_name {
        dialog = dialog.set_file_name(name);
    }
    let extension = file_name
        .as_deref()
        .and_then(|name| Path::new(name).extension())
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase());
    if let Some(extension) = &extension {
        dialog = dialog.add_filter(extension.to_ascii_uppercase(), &[extension.as_str()]);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.save_file(move |path| {
        let _ = sender.send(path);
    });
    let chosen = receiver.await.map_err(|error| error.to_string())?;
    let Some(chosen) = chosen else { return Ok(None) };
    let path = chosen.into_path().map_err(|error| error.to_string())?;
    open_plugin_file(&state, &plugin_id, &path.to_string_lossy(), true).map(Some)
}

// Chunk IO (open+seek+read for lazy entries, 8 MiB reads, fsync on close)
// is disk latency, not bookkeeping — on network volumes a single chunk can
// take hundreds of milliseconds. These commands are async and run their body
// on the blocking pool so a streaming transfer never freezes the UI thread.
#[tauri::command]
pub async fn plugin_file_read(
    app: tauri::AppHandle,
    plugin_id: String,
    handle_id: String,
    offset: u64,
    length: Option<u32>,
) -> Result<PluginFileReadChunk, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PluginFileState>();
        read_plugin_file_chunk(state.inner(), &plugin_id, &handle_id, offset, length)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn plugin_file_write(
    app: tauri::AppHandle,
    plugin_id: String,
    handle_id: String,
    offset: u64,
    data_base64: String,
) -> Result<PluginFileWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PluginFileState>();
        write_plugin_file_chunk(state.inner(), &plugin_id, &handle_id, offset, &data_base64)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn plugin_file_close(app: tauri::AppHandle, plugin_id: String, handle_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PluginFileState>();
        close_plugin_file(state.inner(), &plugin_id, &handle_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

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
    fn dropped_paths_gate_the_open_command() {
        let path = temp_file("dropped.bin", b"dropped");
        let state = PluginFileState::new();
        // A path the renderer merely claims is rejected.
        let handles = open_dropped_plugin_files(&state, "main", OWNER, &[path.to_string_lossy().into_owned()]).files;
        assert!(handles.is_empty(), "renderer-claimed paths get no handles");
        // A path granted to a DIFFERENT webview is rejected for this one.
        state.register_dropped_paths("other-window", vec![path.to_string_lossy().into_owned()]);
        assert!(open_dropped_plugin_files(&state, "main", OWNER, &[path.to_string_lossy().into_owned()])
            .files
            .is_empty());
        // The granting webview can open exactly once.
        state.register_dropped_paths("main", vec![path.to_string_lossy().into_owned()]);
        let handles = open_dropped_plugin_files(&state, "main", OWNER, &[path.to_string_lossy().into_owned()]).files;
        assert_eq!(handles.len(), 1);
        assert_eq!(handles[0].relative_path, "", "a top-level dropped file carries no folder-relative path");
        let chunk = read_plugin_file_chunk(&state, OWNER, &handles[0].handle_id, 0, None).expect("read");
        assert_eq!(BASE64.decode(chunk.data_base64).unwrap(), b"dropped");
        close_plugin_file(&state, OWNER, &handles[0].handle_id).expect("close");
        assert!(
            open_dropped_plugin_files(&state, "main", OWNER, &[path.to_string_lossy().into_owned()]).files.is_empty(),
            "the drop grant is consumed after one open"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn dropped_folder_expands_to_its_files() {
        let root = std::env::temp_dir().join(format!("dbx-plugin-folder-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("nested/deeper")).expect("mkdir");
        std::fs::write(root.join("b.txt"), b"second").expect("write");
        std::fs::write(root.join("a.txt"), b"first").expect("write");
        std::fs::write(root.join("nested/c.txt"), b"third").expect("write");
        std::fs::write(root.join("nested/deeper/d.txt"), b"fourth").expect("write");
        // A symlink inside the dropped folder must not widen the grant: the
        // walk skips it, so nothing outside the folder is ever handed over.
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", root.join("link.txt")).expect("symlink");

        let state = PluginFileState::new();
        state.register_dropped_paths("main", vec![root.to_string_lossy().into_owned()]);
        let result = open_dropped_plugin_files(&state, "main", OWNER, &[root.to_string_lossy().into_owned()]);
        let handles = &result.files;
        assert!(!result.truncated, "a small folder is delivered in full");
        let names: Vec<&str> = handles.iter().map(|handle| handle.name.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "b.txt", "c.txt", "d.txt"], "sorted walk, symlinks skipped");
        // Nested entries carry their structure under the dropped folder's own
        // name, so plugins can rebuild the dragged tree and two identically
        // named files under different dropped roots stay distinguishable.
        let root_name = root.file_name().and_then(|value| value.to_str()).unwrap().to_string();
        let relatives: Vec<String> = handles.iter().map(|handle| handle.relative_path.clone()).collect();
        assert_eq!(
            relatives,
            vec![
                format!("{root_name}/a.txt"),
                format!("{root_name}/b.txt"),
                format!("{root_name}/nested/c.txt"),
                format!("{root_name}/nested/deeper/d.txt")
            ]
        );
        let chunk = read_plugin_file_chunk(&state, OWNER, &handles[0].handle_id, 0, None).expect("read");
        assert_eq!(BASE64.decode(chunk.data_base64).unwrap(), b"first");
        for handle in handles {
            close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dropped_entries_stream_reads_without_holding_handles() {
        let root = std::env::temp_dir().join(format!("dbx-plugin-lazy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("mkdir");
        // More files than the eager handle registry could ever hold: laziness
        // is what makes a folder of this size deliverable at all.
        let file_count = MAX_OPEN_HANDLES + 20;
        for index in 0..file_count {
            std::fs::write(root.join(format!("part{index:03}.bin")), format!("payload-{index}")).expect("write");
        }
        let state = PluginFileState::new();
        state.register_dropped_paths("main", vec![root.to_string_lossy().into_owned()]);
        let handles = open_dropped_plugin_files(&state, "main", OWNER, &[root.to_string_lossy().into_owned()]).files;
        assert_eq!(handles.len(), file_count, "metadata-only expansion is not bounded by the handle registry");
        assert_eq!(state.handles.lock().unwrap().len(), 0, "no fd is taken until a read happens");

        // Streaming: chunks read across separate calls land exactly where the
        // offsets say, with eof only on the tail.
        let target = handles.iter().find(|handle| handle.name == "part042.bin").expect("entry");
        let payload = format!("payload-42");
        let head = read_plugin_file_chunk(&state, OWNER, &target.handle_id, 0, Some(4)).expect("read head");
        assert_eq!(BASE64.decode(head.data_base64).unwrap(), b"payl");
        assert!(!head.eof);
        let tail = read_plugin_file_chunk(&state, OWNER, &target.handle_id, 4, Some(64)).expect("read tail");
        assert_eq!(BASE64.decode(tail.data_base64).unwrap(), payload[4..].as_bytes());
        assert!(tail.eof, "a lazily-opened file reports eof at its true end");
        assert_eq!(state.handles.lock().unwrap().len(), 0, "the fd is released between reads");

        close_plugin_file(&state, OWNER, &target.handle_id).expect("close");
        assert!(
            read_plugin_file_chunk(&state, OWNER, &target.handle_id, 0, None).is_err(),
            "closed entry rejects reads"
        );
        for handle in &handles {
            let _ = close_plugin_file(&state, OWNER, &handle.handle_id);
        }
        assert_eq!(state.dropped_files.lock().unwrap().len(), 0, "close retires every metadata entry");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dropped_entry_reads_and_closes_reject_other_plugins() {
        let path = temp_file("lazy-owned.bin", b"secret");
        let state = PluginFileState::new();
        state.register_dropped_paths("main", vec![path.to_string_lossy().into_owned()]);
        let handle = open_dropped_plugin_files(&state, "main", OWNER, &[path.to_string_lossy().into_owned()]).files;
        assert_eq!(handle.len(), 1);
        let handle_id = handle[0].handle_id.clone();

        let foreign_read = read_plugin_file_chunk(&state, OTHER, &handle_id, 0, None).unwrap_err();
        assert_eq!(foreign_read, "unknown plugin file handle");
        let foreign_close = close_plugin_file(&state, OTHER, &handle_id).unwrap_err();
        assert_eq!(foreign_close, "unknown plugin file handle");
        assert!(
            read_plugin_file_chunk(&state, OWNER, &handle_id, 0, None).is_ok(),
            "the entry survives foreign probes"
        );

        close_plugin_file(&state, OWNER, &handle_id).expect("close");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn dropped_folder_expansion_is_capped() {
        let root = std::env::temp_dir().join(format!("dbx-plugin-folder-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("mkdir");
        for index in 0..(MAX_DROP_FOLDER_FILES + 8) {
            std::fs::write(root.join(format!("f{index:03}.txt")), b"x").expect("write");
        }
        let state = PluginFileState::new();
        state.register_dropped_paths("main", vec![root.to_string_lossy().into_owned()]);
        let result = open_dropped_plugin_files(&state, "main", OWNER, &[root.to_string_lossy().into_owned()]);
        assert_eq!(result.files.len(), MAX_DROP_FOLDER_FILES, "expansion stops at the cap");
        assert!(result.truncated, "partial delivery is visible on the wire, not just the host log");
        for handle in &result.files {
            close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dropped_folder_alias_is_not_expanded_but_a_file_alias_reads() {
        let root = std::env::temp_dir().join(format!("dbx-plugin-alias-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("real")).expect("mkdir");
        std::fs::write(root.join("real/inside.txt"), b"inside").expect("write");
        let outside_dir = std::env::temp_dir().join(format!("dbx-plugin-alias-target-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside_dir);
        std::fs::create_dir_all(&outside_dir).expect("mkdir");
        std::fs::write(outside_dir.join("secret.txt"), b"secret").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_dir, root.join("alias")).expect("symlink");

        let state = PluginFileState::new();
        state.register_dropped_paths("main", vec![root.to_string_lossy().into_owned()]);
        let handles = open_dropped_plugin_files(&state, "main", OWNER, &[root.to_string_lossy().into_owned()]).files;
        // The folder-internal alias is skipped by the walk; nothing outside
        // the dropped folder is ever granted, even nested one level down.
        let names: Vec<&str> = handles.iter().map(|handle| handle.name.as_str()).collect();
        assert_eq!(names, vec!["inside.txt"], "internal alias never widens the grant");
        for handle in &handles {
            close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        }

        // A top-level alias to a folder is not expanded either.
        let mut top_grant = vec![outside_dir.to_string_lossy().into_owned()];
        #[cfg(unix)]
        {
            let alias_path = root.join("alias").to_string_lossy().into_owned();
            state.register_dropped_paths("main", vec![alias_path.clone()]);
            top_grant.push(alias_path);
        }
        let handles = open_dropped_plugin_files(&state, "main", OWNER, &top_grant).files;
        assert!(
            !handles.iter().any(|handle| handle.name == "secret.txt"),
            "a dropped folder alias must not grant its target tree"
        );
        for handle in &handles {
            close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        }

        // A top-level alias to a FILE stays one bounded entry (unix only: it
        // is the platform where the alias scenario is testable).
        #[cfg(unix)]
        {
            let file_alias = root.join("file-alias.txt");
            std::os::unix::fs::symlink(root.join("real/inside.txt"), &file_alias).expect("symlink");
            state.register_dropped_paths("main", vec![file_alias.to_string_lossy().into_owned()]);
            let handles =
                open_dropped_plugin_files(&state, "main", OWNER, &[file_alias.to_string_lossy().into_owned()]).files;
            assert_eq!(handles.len(), 1, "a dropped file alias is one entry");
            let chunk =
                read_plugin_file_chunk(&state, OWNER, &handles[0].handle_id, 0, None).expect("read through alias");
            assert_eq!(BASE64.decode(chunk.data_base64).unwrap(), b"inside");
            close_plugin_file(&state, OWNER, &handles[0].handle_id).expect("close");
        }

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }

    #[test]
    fn dropped_folder_depth_truncation_stops_the_walk() {
        let root = std::env::temp_dir().join(format!("dbx-plugin-deep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mut level = root.clone();
        for index in 0..(MAX_DROP_FOLDER_DEPTH + 3) {
            level = level.join(format!("d{index}"));
            std::fs::create_dir_all(&level).expect("mkdir");
            std::fs::write(level.join("f.txt"), b"x").expect("write");
        }
        let state = PluginFileState::new();
        state.register_dropped_paths("main", vec![root.to_string_lossy().into_owned()]);
        let result = open_dropped_plugin_files(&state, "main", OWNER, &[root.to_string_lossy().into_owned()]);
        // The walk enters directories at depths 1..=MAX_DROP_FOLDER_DEPTH, so
        // MAX-1 nested files are collected and everything below is cut off —
        // with the cutoff visible on the wire.
        assert_eq!(result.files.len(), MAX_DROP_FOLDER_DEPTH - 1, "the walk stops at the depth floor");
        assert!(result.truncated, "depth truncation is visible on the wire too");
        for handle in &result.files {
            close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn close_all_sweeps_handles_and_drop_entries_by_owner() {
        let eager = temp_file("sweep-eager.bin", b"eager");
        let dropped = temp_file("sweep-dropped.bin", b"dropped");
        let state = PluginFileState::new();
        let eager_handle =
            open_plugin_file(&state, OWNER, eager.to_string_lossy().as_ref(), false).expect("open eager");
        state.register_dropped_paths("main", vec![dropped.to_string_lossy().into_owned()]);
        let drop_handle =
            open_dropped_plugin_files(&state, "main", OWNER, &[dropped.to_string_lossy().into_owned()]).files;
        assert_eq!(drop_handle.len(), 1);

        // Another plugin's entries must survive the sweep.
        let other_file = temp_file("sweep-other.bin", b"other");
        let other_handle =
            open_plugin_file(&state, OTHER, other_file.to_string_lossy().as_ref(), false).expect("open other");

        let closed = close_all_plugin_files(&state, OWNER);
        assert_eq!(closed, 2, "one eager handle plus one drop entry");
        assert!(read_plugin_file_chunk(&state, OWNER, &eager_handle.handle_id, 0, None).is_err());
        assert!(read_plugin_file_chunk(&state, OWNER, &drop_handle[0].handle_id, 0, None).is_err());
        assert!(
            read_plugin_file_chunk(&state, OTHER, &other_handle.handle_id, 0, None).is_ok(),
            "other plugins are untouched"
        );

        assert_eq!(close_all_plugin_files(&state, OWNER), 0, "a second sweep finds nothing");
        close_plugin_file(&state, OTHER, &other_handle.handle_id).expect("close other");
        for path in [eager, dropped, other_file] {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn a_mixed_drop_delivers_every_openable_path() {
        let folder = std::env::temp_dir().join(format!("dbx-plugin-mixed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).expect("mkdir");
        std::fs::write(folder.join("in.txt"), b"in").expect("write");
        let file = temp_file("mixed.bin", b"single");
        let stale = std::env::temp_dir().join(format!("dbx-plugin-gone-{}.bin", std::process::id()));

        let state = PluginFileState::new();
        state.register_dropped_paths(
            "main",
            vec![
                file.to_string_lossy().into_owned(),
                folder.to_string_lossy().into_owned(),
                stale.to_string_lossy().into_owned(),
            ],
        );
        let handles = open_dropped_plugin_files(
            &state,
            "main",
            OWNER,
            &[
                file.to_string_lossy().into_owned(),
                folder.to_string_lossy().into_owned(),
                stale.to_string_lossy().into_owned(),
            ],
        )
        .files;
        let names: Vec<&str> = handles.iter().map(|handle| handle.name.as_str()).collect();
        assert!(
            names.len() == 2 && names[0].ends_with("mixed.bin") && names[1] == "in.txt",
            "the stale path is skipped, the rest delivered: {names:?}"
        );
        for handle in &handles {
            close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        }
        let _ = std::fs::remove_file(file);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn pick_falls_back_to_lazy_entries_when_the_handle_registry_is_full() {
        let state = PluginFileState::new();
        // Fill the shared eager registry to its cap with another plugin's
        // handles: a big pick in this state must still deliver every file.
        for index in 0..MAX_OPEN_HANDLES {
            let filler = temp_file(&format!("filler{index}.bin"), b"f");
            let handle =
                open_plugin_file(&state, OTHER, filler.to_string_lossy().as_ref(), false).expect("fill registry");
            drop(handle);
            let _ = std::fs::remove_file(filler);
        }
        let picked = temp_file("over-quota.bin", b"picked");
        let handle = open_read_handle_or_lazy(&state, OWNER, &picked).expect("deliver despite full registry");
        assert_eq!(state.handles.lock().unwrap().len(), MAX_OPEN_HANDLES, "no eager slot was taken");
        let chunk = read_plugin_file_chunk(&state, OWNER, &handle.handle_id, 0, None).expect("read the lazy entry");
        assert_eq!(BASE64.decode(chunk.data_base64).unwrap(), b"picked");
        assert_eq!(handle.relative_path, "", "dialog picks carry no folder-relative path");
        close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        let _ = std::fs::remove_file(picked);
    }

    #[test]
    fn cleared_grants_cannot_be_claimed_afterwards() {
        let path = temp_file("grant-clear.bin", b"x");
        let state = PluginFileState::new();
        state.register_dropped_paths("main", vec![path.to_string_lossy().into_owned()]);
        // Window destruction retires the webview's outstanding grants: a
        // later renderer must not be able to claim a pre-reload drop.
        state.clear_dropped_paths("main");
        let result = open_dropped_plugin_files(&state, "main", OWNER, &[path.to_string_lossy().into_owned()]);
        assert!(result.files.is_empty(), "retired grants mint no handles");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn expired_grants_cannot_be_claimed() {
        let path = temp_file("grant-ttl.bin", b"x");
        let state = PluginFileState::new();
        state.register_dropped_paths("main", vec![path.to_string_lossy().into_owned()]);
        // Backdate the grant past the TTL, as if the drag happened a minute ago.
        {
            let mut dropped = state.dropped_paths.lock().unwrap();
            let entries = dropped.get_mut("main").expect("grant entries");
            for grant in entries.iter_mut() {
                grant.granted_at = Instant::now() - (GRANT_TTL + Duration::from_secs(1));
            }
        }
        let result = open_dropped_plugin_files(&state, "main", OWNER, &[path.to_string_lossy().into_owned()]);
        assert!(result.files.is_empty(), "an expired grant mints no handles");
        // The consume attempt also retired the expired entry outright.
        assert!(state.dropped_paths.lock().unwrap().get("main").is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_swapped_out_file_is_refused_at_read_time() {
        let path = temp_file("toctou.bin", b"original");
        let state = PluginFileState::new();
        state.register_dropped_paths("main", vec![path.to_string_lossy().into_owned()]);
        let handles = open_dropped_plugin_files(&state, "main", OWNER, &[path.to_string_lossy().into_owned()]).files;
        assert_eq!(handles.len(), 1);

        // Replace the file at the same path with a NEW file (delete + create
        // → new inode): the grant pinned the ORIGINAL file. (An in-place
        // rewrite keeps the inode and is correctly still readable.)
        std::fs::remove_file(&path).expect("remove");
        std::fs::write(&path, b"swapped").expect("recreate");
        let error = read_plugin_file_chunk(&state, OWNER, &handles[0].handle_id, 0, None).unwrap_err();
        #[cfg(unix)]
        assert_eq!(error, "file changed since the drop was granted", "{error}");
        #[cfg(not(unix))]
        let _ = error;

        close_plugin_file(&state, OWNER, &handles[0].handle_id).expect("close");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn dropped_folder_walk_skips_dotfiles() {
        let root = std::env::temp_dir().join(format!("dbx-plugin-dotfiles-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".git/objects/ab")).expect("mkdir");
        std::fs::write(root.join(".git/objects/ab/cd"), b"git").expect("write");
        std::fs::write(root.join(".hidden"), b"dot").expect("write");
        std::fs::write(root.join("visible.txt"), b"seen").expect("write");

        let state = PluginFileState::new();
        state.register_dropped_paths("main", vec![root.to_string_lossy().into_owned()]);
        let handles = open_dropped_plugin_files(&state, "main", OWNER, &[root.to_string_lossy().into_owned()]).files;
        let names: Vec<&str> = handles.iter().map(|handle| handle.name.as_str()).collect();
        assert_eq!(names, vec!["visible.txt"], "dotfiles and dot-directories are not user payload");
        for handle in &handles {
            close_plugin_file(&state, OWNER, &handle.handle_id).expect("close");
        }
        let _ = std::fs::remove_dir_all(&root);
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
