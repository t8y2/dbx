//! Directory handles: a session-scoped, user-consented directory grant that a
//! plugin can silently enumerate, read, and write within. The canonical root
//! never leaves the Rust side — every access is gated by an opaque uuid and
//! owner check — and writes use atomic temp+rename so a failed save never
//! leaves the previous contents truncated.
//!
//! Mirroring the file-handle model, the canonical root is frozen at
//! `open_folder` time and re-validated on every subsequent call: if the OS
//! path was replaced (symlink swap, external rename), the grant is refused
//! immediately. Every relative path is lexically validated (no absolute paths,
//! no `..` components) and then canonicalized through its nearest existing
//! ancestor so symlinks inside the grant cannot escape it.

use std::collections::HashMap;
use std::fs::{create_dir_all, read_dir, read_to_string, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use uuid::Uuid;

use super::PluginFileState;

/// Bounds the synchronous expansion walk, matching the drop-folder cap.
const MAX_FOLDER_ENTRIES: usize = 2000;
const MAX_FOLDER_DEPTH: usize = 8;
/// Per-plugin record of recently granted project folders, stored as
/// `plugin-data/<plugin-id>/recent-folders.json`. Only canonical paths that the
/// user confirmed in the native picker are recorded, so plugins can surface a
/// recent list and pre-target the picker via `default_path`.
const RECENT_FOLDERS_FILE: &str = "recent-folders.json";
/// Keeps the dropdown short while covering day-to-day project switching.
const MAX_RECENT_FOLDERS: usize = 10;

/// Display entry for a recent project (name plus absolute path).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentFolderMeta {
    pub(crate) name: String,
    pub(crate) path: String,
}

/// Location of the recent-folders file.
fn recent_folders_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RECENT_FOLDERS_FILE)
}

/// Reads the recorded paths; a missing or corrupt file means an empty list and
/// never blocks granting a new folder.
fn load_recent_folders(data_dir: &Path) -> Vec<PathBuf> {
    let Ok(raw) = std::fs::read(recent_folders_path(data_dir)) else {
        return Vec::new();
    };
    serde_json::from_slice::<Vec<String>>(&raw).unwrap_or_default().into_iter().map(PathBuf::from).collect()
}

/// Atomically replaces the list (temp file + fsync + rename) so a crash cannot
/// corrupt the previous history.
fn write_recent_folders(data_dir: &Path, paths: &[PathBuf]) -> Result<(), String> {
    create_dir_all(data_dir).map_err(|error| format!("cannot create plugin data directory: {error}"))?;
    let encoded = serde_json::to_vec(&paths.iter().map(|path| path.to_string_lossy().into_owned()).collect::<Vec<_>>())
        .map_err(|error| format!("cannot encode recent folders: {error}"))?;
    let target = recent_folders_path(data_dir);
    let temp = format!("{}.tmp", target.to_string_lossy());
    {
        let mut file =
            File::create(&temp).map_err(|error| format!("cannot create recent folders temp file: {error}"))?;
        file.write_all(&encoded).map_err(|error| format!("cannot write recent folders: {error}"))?;
        file.sync_all().map_err(|error| format!("cannot flush recent folders: {error}"))?;
    }
    std::fs::rename(&temp, &target).map_err(|error| format!("cannot replace recent folders: {error}"))
}

/// Records one user consent (canonical path), deduplicated and capped.
/// Only a successful native-picker selection calls this, so the renderer can
/// never add a grant on its own.
pub(super) fn remember_recent_folder(data_dir: &Path, root: &Path) {
    let mut paths = load_recent_folders(data_dir);
    paths.retain(|item| item != root);
    paths.insert(0, root.to_path_buf());
    paths.truncate(MAX_RECENT_FOLDERS);
    // History is a convenience: a failed write must not fail the grant.
    let _ = write_recent_folders(data_dir, &paths);
}

/// Whether the path was previously granted to this plugin; the only ticket
/// accepted by the dialog-free reopen command.
pub(super) fn is_recent_folder(data_dir: &Path, canonical: &Path) -> bool {
    load_recent_folders(data_dir).iter().any(|item| item == canonical)
}

/// Lists recent projects, dropping folders that were deleted or moved.
pub(crate) fn recent_folder_metas(data_dir: &Path) -> Vec<RecentFolderMeta> {
    let stored = load_recent_folders(data_dir);
    let before = stored.len();
    let kept: Vec<PathBuf> = stored.into_iter().filter(|path| path.is_dir()).collect();
    if kept.len() != before {
        let _ = write_recent_folders(data_dir, &kept);
    }
    kept.into_iter()
        .map(|path| RecentFolderMeta {
            name: path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| "project".to_string()),
            path: path.to_string_lossy().into_owned(),
        })
        .collect()
}

/// One granted directory. `root` is canonical and **frozen** at
/// `open_folder` time. Subsequent operations re-canonicalize the same OS path
/// before each call and refuse when it has diverged (symlink swap / replace).
#[derive(Clone)]
pub(crate) struct OpenFolder {
    /// Canonical absolute path captured at `open_folder`. Immutable.
    root: PathBuf,
    plugin_id: String,
    read_only: bool,
}

/// Wire shape for the handle metadata returned by `pickFolder` / `openFolderPath`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderHandleMeta {
    pub(crate) folder_handle_id: String,
    pub(crate) name: String,
    /// Canonical absolute path. Returned so plugin UIs can label recent
    /// projects and reopen them after a restart; access stays grant-gated.
    pub(crate) path: String,
}

/// One directory entry on the wire.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderEntry {
    pub(crate) name: String,
    pub(crate) relative_path: String,
    pub(crate) kind: String, // "file" | "directory"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) modified_at: Option<u64>,
}

/// Recursive listing result; `truncated` mirrors the drop-expansion contract.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderListResult {
    pub(crate) entries: Vec<FolderEntry>,
    pub(crate) truncated: bool,
}

/// Registers `root` as a folder handle for `plugin_id`. The caller must have
/// obtained consent already (a native picker); this function only validates
/// and records it. The canonical root is frozen here and never re-derived
/// from the OS path afterwards.
pub(super) fn open_folder(
    state: &PluginFileState,
    plugin_id: &str,
    root: &Path,
    read_only: bool,
) -> Result<FolderHandleMeta, String> {
    if plugin_id.trim().is_empty() {
        return Err("plugin id is required".to_string());
    }
    let canonical = root.canonicalize().map_err(|error| format!("cannot resolve folder path: {error}"))?;
    let meta = std::fs::metadata(&canonical).map_err(|error| format!("folder is not accessible: {error}"))?;
    if !meta.is_dir() {
        return Err("path is not a directory".to_string());
    }
    let name = canonical.file_name().and_then(|value| value.to_str()).unwrap_or("project").to_string();
    let path = canonical.to_string_lossy().into_owned();
    let folder_handle_id = Uuid::new_v4().to_string();
    let mut folders = state.folders.lock().map_err(|_| "plugin folder registry poisoned".to_string())?;
    folders
        .insert(folder_handle_id.clone(), OpenFolder { root: canonical, plugin_id: plugin_id.to_string(), read_only });
    Ok(FolderHandleMeta { folder_handle_id, name, path })
}

/// Looks up a handle and enforces plugin ownership. Callers **must** invoke
/// [`check_root_unchanged`] on the result before doing any filesystem work so
/// a replaced grant root (symlink swap / rename) is refused before a single
/// byte is read or written.
fn lookup<'a>(
    folders: &'a HashMap<String, OpenFolder>,
    plugin_id: &str,
    folder_handle_id: &str,
) -> Result<&'a OpenFolder, String> {
    let entry = folders.get(folder_handle_id).ok_or_else(|| "unknown plugin folder handle".to_string())?;
    if entry.plugin_id != plugin_id {
        log::warn!("plugin folder handle belongs to another plugin (caller: {plugin_id})");
        return Err("unknown plugin folder handle".to_string());
    }
    Ok(entry)
}

/// Verifies that the frozen canonical root is still reachable and identical to
/// what `open_folder` captured. A grant root swapped with a symlink or renamed
/// out from under us means the consent anchor is gone — refuse immediately.
fn check_root_unchanged(open: &OpenFolder) -> Result<PathBuf, String> {
    let current = open.root.canonicalize().map_err(|_| "granted folder is no longer accessible".to_string())?;
    if current != open.root {
        log::warn!("plugin folder: grant root was replaced (was {}, now {})", open.root.display(), current.display());
        return Err("granted folder was modified on disk".to_string());
    }
    Ok(current)
}

/// Joins `relative` onto the grant root after lexical validation.
/// Rejects absolute paths, `..` components, and platform prefixes, so the
/// result is always lexically under the root; callers still canonicalize to
/// defeat symlink escapes.
fn join_under_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    // Convert any '/' separators (the cross-platform bridge contract) to the
    // host's native MAIN_SEPARATOR before PathBuf sees it.
    let rel = PathBuf::from(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    if rel.is_absolute() {
        return Err("absolute paths are not allowed".to_string());
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => return Err("relative path resolves outside grant".to_string()),
            Component::RootDir | Component::Prefix(_) => return Err("absolute paths are not allowed".to_string()),
        }
    }
    Ok(root.join(rel))
}

/// Canonicalizes the nearest existing ancestor of `path` and rebuilds the
/// remaining (not-yet-created) suffix, then verifies the result stays under
/// `canonical_root`. Used for writes where the target may not exist yet.
fn resolve_allowing_missing(path: &Path, canonical_root: &Path) -> Result<PathBuf, String> {
    let mut probe = path;
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let existing = loop {
        if probe.exists() {
            break probe.to_path_buf();
        }
        let name = probe.file_name().ok_or_else(|| "relative path resolves outside grant".to_string())?;
        missing.push(name.to_os_string());
        probe = probe.parent().ok_or_else(|| "relative path resolves outside grant".to_string())?;
    };
    let canonical_existing = existing.canonicalize().map_err(|_| "cannot resolve path".to_string())?;
    if !canonical_existing.starts_with(canonical_root) {
        log::warn!(
            "plugin folder: escape attempt rejected near {}",
            missing.last().and_then(|name| name.to_str()).unwrap_or("<unknown>")
        );
        return Err("relative path resolves outside grant".to_string());
    }
    let mut rebuilt = canonical_existing;
    for segment in missing.iter().rev() {
        rebuilt.push(segment);
    }
    Ok(rebuilt)
}

/// Resolves a relative path to a canonical absolute path inside the grant.
///
/// The caller must have already called [`check_root_unchanged`] on the
/// [`OpenFolder`] — this function trusts the root that was validated there.
fn resolve_relative(canonical_root: &Path, relative: &str) -> Result<PathBuf, String> {
    let joined = join_under_root(canonical_root, relative)?;
    if joined.exists() {
        let canonical = joined.canonicalize().map_err(|_| "cannot resolve path".to_string())?;
        if !canonical.starts_with(canonical_root) {
            log::warn!("plugin folder: escape attempt rejected");
            return Err("relative path resolves outside grant".to_string());
        }
        Ok(canonical)
    } else {
        resolve_allowing_missing(&joined, canonical_root)
    }
}

/// Recursively lists entries under a granted folder handle. Dot-entries are
/// skipped (same policy as drop expansion) and ordering is deterministic.
pub(super) fn folder_list(
    state: &PluginFileState,
    plugin_id: &str,
    folder_handle_id: &str,
    sub_path: Option<&str>,
    extensions: Option<&[String]>,
) -> Result<FolderListResult, String> {
    let (canonical_root, read_only) = {
        let folders = state.folders.lock().map_err(|_| "plugin folder registry poisoned".to_string())?;
        let open = lookup(&folders, plugin_id, folder_handle_id)?;
        let root = check_root_unchanged(open)?;
        (root, open.read_only)
    };
    let start = match sub_path {
        Some(path) if !path.trim().is_empty() => resolve_relative(&canonical_root, path)?,
        _ => canonical_root.clone(),
    };
    if !start.is_dir() {
        return Err("subpath is not a directory".to_string());
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    walk_dir(&start, &canonical_root, 0, &mut entries, &mut truncated, extensions)?;
    // read-only has no effect on listing, but keep the contract explicit.
    let _ = read_only;
    Ok(FolderListResult { entries, truncated })
}

/// Depth-first walk; directory entries are emitted before their children so
/// the plugin can rebuild the tree from a flat list.
fn walk_dir(
    dir: &Path,
    root: &Path,
    depth: usize,
    out: &mut Vec<FolderEntry>,
    truncated: &mut bool,
    extensions: Option<&[String]>,
) -> Result<(), String> {
    if depth > MAX_FOLDER_DEPTH {
        *truncated = true;
        return Ok(());
    }
    let read = read_dir(dir).map_err(|_| "cannot list directory".to_string())?;
    let mut children: Vec<std::fs::DirEntry> = Vec::new();
    for entry in read {
        let entry = entry.map_err(|_| "cannot read directory entry".to_string())?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        children.push(entry);
    }
    children.sort_by_key(|entry| entry.file_name());
    for entry in children {
        if out.len() >= MAX_FOLDER_ENTRIES {
            *truncated = true;
            return Ok(());
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative_path = entry
            .path()
            .strip_prefix(root)
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());
        if meta.is_dir() {
            out.push(FolderEntry { name, relative_path, kind: "directory".to_string(), size: None, modified_at: None });
            walk_dir(&entry.path(), root, depth + 1, out, truncated, extensions)?;
        } else if meta.is_file() {
            if let Some(wanted) = extensions {
                // Case-insensitive extension match on the path's extension.
                let ext = entry.path().extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase);
                let matched = ext.is_some_and(|ext| wanted.iter().any(|item| item.eq_ignore_ascii_case(&ext)));
                if !matched {
                    continue;
                }
            }
            let modified_at = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64);
            out.push(FolderEntry {
                name,
                relative_path,
                kind: "file".to_string(),
                size: Some(meta.len()),
                modified_at,
            });
        }
        // Symlinks and special files are skipped, matching drop expansion.
    }
    Ok(())
}

/// Reads a file inside a granted folder as UTF-8 text.
pub(super) fn folder_read_text(
    state: &PluginFileState,
    plugin_id: &str,
    folder_handle_id: &str,
    relative_path: &str,
) -> Result<String, String> {
    let canonical_root = {
        let folders = state.folders.lock().map_err(|_| "plugin folder registry poisoned".to_string())?;
        let open = lookup(&folders, plugin_id, folder_handle_id)?;
        check_root_unchanged(open)?
    };
    let absolute = resolve_relative(&canonical_root, relative_path)?;
    let meta = std::fs::metadata(&absolute).map_err(|_| "cannot stat file".to_string())?;
    if !meta.is_file() {
        return Err("path is not a file".to_string());
    }
    read_to_string(&absolute).map_err(|_| "cannot read file".to_string())
}

/// Shared write path: validates the target, creates parents, and returns the
/// canonical absolute path the caller should atomically replace.
fn prepare_write_target(
    state: &PluginFileState,
    plugin_id: &str,
    folder_handle_id: &str,
    relative_path: &str,
    create: bool,
) -> Result<PathBuf, String> {
    let (canonical_root, read_only) = {
        let folders = state.folders.lock().map_err(|_| "plugin folder registry poisoned".to_string())?;
        let open = lookup(&folders, plugin_id, folder_handle_id)?;
        let root = check_root_unchanged(open)?;
        (root, open.read_only)
    };
    if read_only {
        return Err("folder handle is read-only".to_string());
    }
    let target = resolve_relative(&canonical_root, relative_path)?;
    if target.is_dir() {
        return Err("path points to a directory".to_string());
    }
    if !create && !target.exists() {
        return Err("target file does not exist".to_string());
    }
    Ok(target)
}

/// Atomically writes `bytes` to `target` via a temp file on the same volume,
/// fsync, and rename. A crash or write failure at any point leaves the
/// previous contents intact — no mid-write truncation, no partial file.
fn write_file_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        create_dir_all(parent).map_err(|error| format!("cannot create parent directory: {error}"))?;
    }
    // Temp file in the same directory so rename stays within one filesystem
    // (the only thing that makes rename truly atomic).
    let suffix = Uuid::new_v4();
    let temp =
        target.with_extension(format!("{}.tmp.{suffix}", target.extension().and_then(|s| s.to_str()).unwrap_or("")));
    {
        let mut file = File::create(&temp).map_err(|_| "cannot create temp file".to_string())?;
        file.write_all(bytes).map_err(|_| "cannot write temp file".to_string())?;
        file.sync_all().map_err(|_| "cannot flush temp file".to_string())?;
    }
    std::fs::rename(&temp, target).map_err(|_| "cannot replace file".to_string())?;
    Ok(())
}

/// Writes UTF-8 text inside a granted folder via atomic replace.
pub(super) fn folder_write_text(
    state: &PluginFileState,
    plugin_id: &str,
    folder_handle_id: &str,
    relative_path: &str,
    content: &str,
    create: bool,
) -> Result<(), String> {
    let target = prepare_write_target(state, plugin_id, folder_handle_id, relative_path, create)?;
    write_file_atomic(&target, content.as_bytes())
}

/// Writes raw bytes inside a granted folder via atomic replace (PNG / XLSX
/// exports).
pub(super) fn folder_write_bytes(
    state: &PluginFileState,
    plugin_id: &str,
    folder_handle_id: &str,
    relative_path: &str,
    bytes: &[u8],
    create: bool,
) -> Result<(), String> {
    let target = prepare_write_target(state, plugin_id, folder_handle_id, relative_path, create)?;
    write_file_atomic(&target, bytes)
}

/// Releases one folder handle owned by `plugin_id`.
pub(super) fn close_folder(state: &PluginFileState, plugin_id: &str, folder_handle_id: &str) -> Result<(), String> {
    let mut folders = state.folders.lock().map_err(|_| "plugin folder registry poisoned".to_string())?;
    lookup(&folders, plugin_id, folder_handle_id)?;
    folders.remove(folder_handle_id);
    Ok(())
}

/// Sweeps every folder handle owned by one plugin (called on uninstall).
pub(crate) fn close_all_plugin_folders(state: &PluginFileState, plugin_id: &str) -> usize {
    let Ok(mut folders) = state.folders.lock() else {
        return 0;
    };
    let before = folders.len();
    folders.retain(|_, entry| entry.plugin_id != plugin_id);
    let closed = before - folders.len();
    if closed > 0 {
        log::info!("plugin folder sweep reclaimed {closed} entries for plugin \"{plugin_id}\"");
    }
    closed
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "io.dbx.test";
    const OTHER: &str = "io.dbx.other";

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("dbx-plugin-folder-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    #[test]
    fn open_folder_registers_handle() {
        let dir = temp_dir("open");
        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).expect("open folder");
        assert_eq!(meta.name, dir.file_name().unwrap().to_str().unwrap());
        let folders = state.folders.lock().unwrap();
        let entry = folders.get(&meta.folder_handle_id).expect("registered");
        assert_eq!(entry.plugin_id, OWNER);
        assert!(!entry.read_only);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_walks_recursively_and_filters_extensions() {
        let dir = temp_dir("list");
        std::fs::create_dir_all(dir.join("nested/deeper")).unwrap();
        std::fs::write(dir.join("a.erm"), "A").unwrap();
        std::fs::write(dir.join("b.txt"), "B").unwrap();
        std::fs::write(dir.join("nested/c.ERM"), "C").unwrap();
        std::fs::write(dir.join("nested/deeper/d.erm"), "D").unwrap();
        std::fs::write(dir.join(".hidden.erm"), "skip").unwrap();

        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();

        let all = folder_list(&state, OWNER, &meta.folder_handle_id, None, None).unwrap();
        assert!(!all.truncated);
        let names: Vec<&str> = all.entries.iter().map(|entry| entry.name.as_str()).collect();
        // Directories are emitted before their children; dot-entries are skipped.
        assert_eq!(names, vec!["a.erm", "b.txt", "nested", "c.ERM", "deeper", "d.erm"]);

        let filtered = folder_list(&state, OWNER, &meta.folder_handle_id, None, Some(&["erm".to_string()])).unwrap();
        let names: Vec<&str> = filtered.entries.iter().map(|entry| entry.name.as_str()).collect();
        assert!(names.contains(&"a.erm"));
        assert!(names.contains(&"c.ERM"), "extension match must be case-insensitive");
        assert!(names.contains(&"d.erm"));
        assert!(!names.contains(&"b.txt"));
        // Directories survive the filter so the tree keeps its shape.
        assert!(names.contains(&"nested"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_and_write_roundtrip() {
        let dir = temp_dir("rw");
        std::fs::write(dir.join("core.erm"), "old content").unwrap();
        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();

        let text = folder_read_text(&state, OWNER, &meta.folder_handle_id, "core.erm").unwrap();
        assert_eq!(text, "old content");

        folder_write_text(&state, OWNER, &meta.folder_handle_id, "core.erm", "new", true).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("core.erm")).unwrap(), "new");

        // Missing parents are created for export-style writes.
        folder_write_text(&state, OWNER, &meta.folder_handle_id, "db/nested/core.sql", "SELECT 1", true)
            .expect("write into new directory");
        assert_eq!(std::fs::read_to_string(dir.join("db/nested/core.sql")).unwrap(), "SELECT 1");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn traversal_and_absolute_paths_are_rejected() {
        let dir = temp_dir("escape");
        std::fs::write(dir.join("inside.erm"), "inside").unwrap();
        let outside = std::env::temp_dir().join(format!("dbx-plugin-outside-{}", std::process::id()));
        std::fs::write(&outside, "secret").unwrap();

        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();

        let escape = folder_read_text(&state, OWNER, &meta.folder_handle_id, "../outside.erm");
        assert!(escape.is_err(), "parent-dir traversal must be rejected");

        let absolute = folder_read_text(&state, OWNER, &meta.folder_handle_id, "/etc/passwd");
        assert!(absolute.is_err(), "absolute paths must be rejected");

        let escape_write = folder_write_text(&state, OWNER, &meta.folder_handle_id, "../evil.txt", "x", true);
        assert!(escape_write.is_err(), "traversal writes must be rejected");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    #[cfg(unix)]
    fn symlink_escape_is_rejected() {
        // 授权目录内部的 symlink 指向外部 → resolve_relative 会 canonicalize
        // symlink 目标，发现它在 grant root 外 → 拒绝。
        let dir = temp_dir("sym-escape");
        let outside = std::env::temp_dir().join(format!("dbx-plugin-sym-outside-{}", std::process::id()));
        std::fs::write(&outside, "secret-bytes").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("escape-link")).unwrap();

        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();

        let read_through_symlink = folder_read_text(&state, OWNER, &meta.folder_handle_id, "escape-link");
        assert!(read_through_symlink.is_err(), "reading through a symlink outside the grant must be rejected");

        let write_through_symlink =
            folder_write_text(&state, OWNER, &meta.folder_handle_id, "escape-link", "hacked", true);
        assert!(write_through_symlink.is_err(), "writing through a symlink outside the grant must be rejected");
        // 原文件完好
        assert_eq!(std::fs::read(&outside).unwrap(), b"secret-bytes", "external file was never touched");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    #[cfg(unix)]
    fn replaced_grant_root_is_refused() {
        // 授权目录被整体替换成指向外部的 symlink → check_root_unchanged
        // 检测到 canonical path 变化 → 所有操作立即拒绝。
        let dir = temp_dir("root-replace");
        std::fs::write(dir.join("keep.erm"), "original").unwrap();
        let replacement = std::env::temp_dir().join(format!("dbx-plugin-root-replaced-target-{}", std::process::id()));
        std::fs::create_dir_all(&replacement).unwrap();

        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();

        // 用户把授权目录 mv 走，换成 symlink 指向别处。
        std::fs::rename(&dir, dir.with_extension("moved")).unwrap();
        std::os::unix::fs::symlink(&replacement, &dir).unwrap();

        let read_after_replace = folder_read_text(&state, OWNER, &meta.folder_handle_id, "anything");
        assert!(read_after_replace.is_err(), "a replaced grant root must refuse reads");
        let list_after_replace = folder_list(&state, OWNER, &meta.folder_handle_id, None, None);
        assert!(list_after_replace.is_err(), "a replaced grant root must refuse listing");
        let write_after_replace = folder_write_text(&state, OWNER, &meta.folder_handle_id, "hacked.txt", "x", true);
        assert!(write_after_replace.is_err(), "a replaced grant root must refuse writes");

        // 恢复清理
        let _ = std::fs::remove_file(&dir);
        let _ = std::fs::rename(dir.with_extension("moved"), &dir);
        let _ = std::fs::remove_dir_all(&replacement);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_atomic_write_preserves_original_file() {
        // 无法模拟磁盘满，但可以模拟权限问题：让目标父目录变只读 →
        // write 创建 temp 文件失败 → rename 不会执行 → 原文件完好。
        //
        // 在 macOS/Linux 上用 chmod 去掉写权限；Windows 跳过（权限模型不同）。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = temp_dir("atomic-fail");
            let file = dir.join("precious.erm");
            std::fs::write(&file, "precious original content").unwrap();

            let state = PluginFileState::default();
            let meta = open_folder(&state, OWNER, &dir, false).unwrap();

            // 让父目录只读 → create_dir_all 和 File::create 都会失败。
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

            let result = folder_write_text(
                &state,
                OWNER,
                &meta.folder_handle_id,
                "precious.erm",
                "new content that must NOT survive",
                true,
            );
            assert!(result.is_err(), "write must fail on read-only parent");

            // 父目录恢复可写后读取 → 原文件完好。
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            let preserved = std::fs::read_to_string(&file).unwrap();
            assert_eq!(preserved, "precious original content", "original file must survive a failed write");

            let _ = std::fs::remove_dir_all(&dir);
        }
        #[cfg(not(unix))]
        {
            // Windows: atomic write still exercised by the roundtrip test above.
        }
    }

    #[test]
    fn other_plugins_cannot_use_or_close_handles() {
        let dir = temp_dir("owner");
        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();

        assert!(folder_list(&state, OTHER, &meta.folder_handle_id, None, None).is_err());
        assert!(folder_read_text(&state, OTHER, &meta.folder_handle_id, "").is_err());
        assert!(folder_write_text(&state, OTHER, &meta.folder_handle_id, "x.txt", "y", true).is_err());
        assert!(close_folder(&state, OTHER, &meta.folder_handle_id).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_only_grants_reject_writes() {
        let dir = temp_dir("readonly");
        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, true).unwrap();

        assert!(folder_write_text(&state, OWNER, &meta.folder_handle_id, "a.txt", "x", true).is_err());
        assert!(folder_list(&state, OWNER, &meta.folder_handle_id, None, None).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweep_only_closes_owned_handles() {
        let mine = temp_dir("sweep-mine");
        let theirs = temp_dir("sweep-theirs");
        let state = PluginFileState::default();
        let mine_meta = open_folder(&state, OWNER, &mine, false).unwrap();
        let theirs_meta = open_folder(&state, OTHER, &theirs, false).unwrap();

        assert_eq!(close_all_plugin_folders(&state, OWNER), 1);
        assert!(folder_list(&state, OWNER, &mine_meta.folder_handle_id, None, None).is_err());
        assert!(folder_list(&state, OTHER, &theirs_meta.folder_handle_id, None, None).is_ok());

        let _ = std::fs::remove_dir_all(&mine);
        let _ = std::fs::remove_dir_all(&theirs);
    }

    #[test]
    fn recent_folders_dedupe_and_cap() {
        let data = temp_dir("recent-data");
        let dirs: Vec<PathBuf> = (0..12)
            .map(|index| {
                let dir = data.join(format!("project-{index}"));
                std::fs::create_dir_all(&dir).unwrap();
                dir
            })
            .collect();
        for dir in &dirs {
            remember_recent_folder(&data, dir);
        }
        // Re-granting an older folder moves it back to the front instead of duplicating.
        remember_recent_folder(&data, &dirs[2]);
        let metas = recent_folder_metas(&data);
        assert_eq!(metas.len(), MAX_RECENT_FOLDERS);
        assert_eq!(metas[0].path, dirs[2].to_string_lossy());

        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn recent_folders_drop_missing_directories() {
        let data = temp_dir("recent-missing");
        let alive = data.join("alive");
        let gone = data.join("gone");
        std::fs::create_dir_all(&alive).unwrap();
        std::fs::create_dir_all(&gone).unwrap();
        remember_recent_folder(&data, &alive);
        remember_recent_folder(&data, &gone);
        std::fs::remove_dir_all(&gone).unwrap();

        let metas = recent_folder_metas(&data);
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].name, "alive");

        let _ = std::fs::remove_dir_all(&data);
    }
}
