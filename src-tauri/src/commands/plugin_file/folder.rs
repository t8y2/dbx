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
use std::fs::{create_dir_all, read_dir, read_to_string, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::PluginFileState;

/// Bounds the synchronous expansion walk, matching the drop-folder cap.
const MAX_FOLDER_ENTRIES: usize = 2000;
const MAX_FOLDER_DEPTH: usize = 8;
/// Per-plugin record of recently granted project folders, stored as
/// `plugin-data/<plugin-id>/recent-folders.json`. Only canonical paths that the
/// user confirmed in the native picker are recorded; plugins see the opaque
/// `id` instead of the path.
const RECENT_FOLDERS_FILE: &str = "recent-folders.json";
/// Keeps the dropdown short while covering day-to-day project switching.
const MAX_RECENT_FOLDERS: usize = 10;

/// Stable identity of a directory. A canonical path string alone cannot tell
/// two directories that occupy the same path apart; Unix uses (device, inode)
/// and Windows uses (volume serial, file index) to anchor a consent to the
/// actual directory the user picked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct DirIdentity {
    a: u64,
    b: u64,
}

fn identity_from(meta: &std::fs::Metadata) -> DirIdentity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        DirIdentity { a: meta.dev(), b: meta.ino() }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        DirIdentity { a: meta.volume_serial_number().unwrap_or(0) as u64, b: meta.file_index() }
    }
    #[cfg(not(any(unix, windows)))]
    {
        DirIdentity { a: 0, b: 0 }
    }
}

/// Reads a directory identity without following links. Both a symlink and a
/// non-directory are refused: the consent anchor must be a real directory.
fn dir_identity(path: &Path) -> Result<DirIdentity, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| "cannot inspect directory".to_string())?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("path is not a real directory".to_string());
    }
    Ok(identity_from(&meta))
}

/// Persisted recent grant. The canonical `path` stays in the host: plugins only
/// receive `id`, so a path can never become a reusable credential. `identity`
/// binds the consent to the directory that was actually selected; records
/// written before this field existed have `None` and require re-consent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecentFolderRecord {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) path: String,
    #[serde(default)]
    pub(super) read_only: bool,
    #[serde(default)]
    pub(super) identity: Option<DirIdentity>,
}

/// Plugin-facing entry for a recent project: opaque id, display name and a
/// masked label for the dropdown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentFolderMeta {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) label: String,
    /// True when the recorded directory identity no longer matches (or the
    /// record predates identity tracking). The plugin must call `pickFolder`
    /// with this id as `defaultRef` to obtain fresh consent.
    pub(crate) needs_confirmation: bool,
}

/// Display-only label derived from the canonical path: the home directory is
/// collapsed to `~`, and paths outside home keep their last six segments so
/// sibling projects stay distinguishable. It exists for plugin UIs only; it is
/// never used for filesystem access, and the real path never leaves the host.
pub(super) fn display_label(path: &Path) -> String {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    if let Some(home) = home {
        if let Ok(rest) = path.strip_prefix(&home) {
            let rest = rest.to_string_lossy().replace('\\', "/");
            return if rest.is_empty() { "~".to_string() } else { format!("~/{rest}") };
        }
    }
    let mut segments: Vec<String> = Vec::new();
    for component in path.components() {
        if let std::path::Component::Normal(value) = component {
            segments.push(value.to_string_lossy().into_owned());
        }
    }
    // Outside home the volume/root is hidden but enough trailing segments are
    // kept for a plausible label, e.g. `…/Files/code/db/demo/models/v2`.
    let start = segments.len().saturating_sub(6);
    format!("…/{}", segments[start..].join("/"))
}

/// Location of the recent-folders file.
fn recent_folders_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RECENT_FOLDERS_FILE)
}

/// Display name for a granted root (its last path segment).
fn folder_display_name(path: &Path) -> String {
    path.file_name().map(|value| value.to_string_lossy().into_owned()).unwrap_or_else(|| "project".to_string())
}

/// Reads the recorded grants. A missing or corrupt file means an empty list and
/// never blocks granting a new folder. Legacy files holding plain path strings
/// are upgraded and written back immediately, so the generated ids stay stable
/// across restarts (a regenerated id would break `openFolderRef`).
fn load_recent_folders(data_dir: &Path) -> Vec<RecentFolderRecord> {
    let Ok(raw) = std::fs::read(recent_folders_path(data_dir)) else {
        return Vec::new();
    };
    if let Ok(records) = serde_json::from_slice::<Vec<RecentFolderRecord>>(&raw) {
        return records;
    }
    let migrated: Vec<RecentFolderRecord> = serde_json::from_slice::<Vec<String>>(&raw)
        .unwrap_or_default()
        .into_iter()
        .map(|path| RecentFolderRecord {
            id: Uuid::new_v4().to_string(),
            name: folder_display_name(Path::new(&path)),
            path,
            read_only: false,
            identity: None,
        })
        .collect();
    if !migrated.is_empty() {
        let _ = write_recent_folders(data_dir, &migrated);
    }
    migrated
}

/// Atomically replaces the list (temp file + fsync + rename) so a crash cannot
/// corrupt the previous history.
fn write_recent_folders(data_dir: &Path, records: &[RecentFolderRecord]) -> Result<(), String> {
    create_dir_all(data_dir).map_err(|error| format!("cannot create plugin data directory: {error}"))?;
    let encoded = serde_json::to_vec(records).map_err(|error| format!("cannot encode recent folders: {error}"))?;
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

/// Records one user consent (canonical path), deduplicated and capped, and
/// returns the stable opaque id for it. Only a successful native-picker
/// selection calls this, so the renderer can never add a grant on its own.
pub(super) fn remember_recent_folder(data_dir: &Path, root: &Path, read_only: bool) -> String {
    let mut records = load_recent_folders(data_dir);
    let canonical = root.to_string_lossy().into_owned();
    let existing = records.iter().find(|record| record.path == canonical).cloned();
    let id = existing.as_ref().map(|record| record.id.clone()).unwrap_or_else(|| Uuid::new_v4().to_string());
    let name = existing.map(|record| record.name).unwrap_or_else(|| folder_display_name(root));
    records.retain(|record| record.path != canonical);
    // Anchor the consent to the directory the user just confirmed. An
    // inaccessible directory gets `None` and will require re-consent later.
    let identity = dir_identity(root).ok();
    records.insert(0, RecentFolderRecord { id: id.clone(), name, path: canonical, read_only, identity });
    records.truncate(MAX_RECENT_FOLDERS);
    // History is a convenience: a failed write must not fail the grant.
    let _ = write_recent_folders(data_dir, &records);
    id
}

/// Moves an existing record to the front without recomputing or overwriting
/// its identity. `openFolderRef` uses this after verification so a race during
/// the reorder cannot re-anchor the grant to a different directory.
pub(super) fn touch_recent_folder(data_dir: &Path, id: &str) {
    let mut records = load_recent_folders(data_dir);
    if let Some(index) = records.iter().position(|record| record.id == id) {
        let record = records.remove(index);
        records.insert(0, record);
        let _ = write_recent_folders(data_dir, &records);
    }
}

/// Resolves an opaque id to a recorded grant; callers validate the directory
/// still exists before opening it.
pub(super) fn find_recent_folder(data_dir: &Path, id: &str) -> Option<RecentFolderRecord> {
    load_recent_folders(data_dir).into_iter().find(|record| record.id == id)
}

fn grant_identity_matches(record: &RecentFolderRecord) -> bool {
    let Some(expected) = record.identity else {
        return false;
    };
    dir_identity(Path::new(&record.path)).map(|actual| actual == expected).unwrap_or(false)
}

/// Why a persisted grant cannot be reopened silently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RecentGrantError {
    /// The id is not in this plugin's history.
    Missing,
    /// The directory was replaced, became a link, or the record predates
    /// identity tracking; native re-consent is required.
    NeedsConfirmation,
}

/// Verifies that a persisted grant still points at the exact directory the
/// user consented to before any handle is issued. Kept free of Tauri types so
/// the identity rules are directly unit-testable.
pub(super) fn verify_recent_grant(
    data_dir: &Path,
    id: &str,
) -> Result<(RecentFolderRecord, PathBuf, DirIdentity), RecentGrantError> {
    let record = find_recent_folder(data_dir, id).ok_or(RecentGrantError::Missing)?;
    let expected = record.identity.ok_or(RecentGrantError::NeedsConfirmation)?;
    let actual = dir_identity(Path::new(&record.path)).map_err(|_| RecentGrantError::NeedsConfirmation)?;
    if actual != expected {
        return Err(RecentGrantError::NeedsConfirmation);
    }
    let path = PathBuf::from(&record.path);
    Ok((record, path, actual))
}

/// Lists recent projects, dropping folders that were deleted or moved.
pub(crate) fn recent_folder_metas(data_dir: &Path) -> Vec<RecentFolderMeta> {
    let mut stored = load_recent_folders(data_dir);
    let before = stored.len();
    stored.retain(|record| Path::new(&record.path).is_dir());
    if stored.len() != before {
        let _ = write_recent_folders(data_dir, &stored);
    }
    stored
        .into_iter()
        .map(|record| {
            let needs_confirmation = !grant_identity_matches(&record);
            RecentFolderMeta {
                label: display_label(Path::new(&record.path)),
                id: record.id,
                name: record.name,
                needs_confirmation,
            }
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
    /// Identity of the directory behind `root` at consent time. Immutable.
    identity: DirIdentity,
    plugin_id: String,
    read_only: bool,
}

/// Wire shape for the handle metadata returned by `pickFolder` / `openFolderRef`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderHandleMeta {
    pub(crate) folder_handle_id: String,
    pub(crate) name: String,
    /// Opaque id of the persisted recent-grant record. It is the only value a
    /// plugin can hand back to reopen the folder; the absolute path stays here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) id: Option<String>,
    /// Masked path label for the plugin's UI (see `display_label`).
    pub(crate) label: String,
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
    open_folder_impl(state, plugin_id, root, None, read_only)
}

/// Opens a folder whose identity was already checked by `verify_recent_grant`.
/// Refusing a mismatch here closes the gap between verifying a persisted grant
/// and issuing the session handle.
pub(super) fn open_folder_with_identity(
    state: &PluginFileState,
    plugin_id: &str,
    root: &Path,
    expected: DirIdentity,
    read_only: bool,
) -> Result<FolderHandleMeta, String> {
    open_folder_impl(state, plugin_id, root, Some(expected), read_only)
}

fn open_folder_impl(
    state: &PluginFileState,
    plugin_id: &str,
    root: &Path,
    expected: Option<DirIdentity>,
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
    let identity = dir_identity(&canonical)?;
    if expected.is_some_and(|expected| expected != identity) {
        log::warn!("plugin folder: persisted grant changed between verification and open");
        return Err("granted folder was modified on disk".to_string());
    }
    let name = canonical.file_name().and_then(|value| value.to_str()).unwrap_or("project").to_string();
    let label = display_label(&canonical);
    let folder_handle_id = Uuid::new_v4().to_string();
    let mut folders = state.folders.lock().map_err(|_| "plugin folder registry poisoned".to_string())?;
    folders.insert(
        folder_handle_id.clone(),
        OpenFolder { root: canonical, identity, plugin_id: plugin_id.to_string(), read_only },
    );
    Ok(FolderHandleMeta { folder_handle_id, name, id: None, label })
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
    let meta =
        std::fs::symlink_metadata(&open.root).map_err(|_| "granted folder is no longer accessible".to_string())?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        log::warn!("plugin folder: grant root is no longer a real directory");
        return Err("granted folder was modified on disk".to_string());
    }
    if identity_from(&meta) != open.identity {
        log::warn!("plugin folder: grant root identity changed at {}", open.root.display());
        return Err("granted folder was modified on disk".to_string());
    }
    // `root` is already canonical and was just verified without following
    // links; re-canonicalizing would reintroduce the symlink race.
    Ok(open.root.clone())
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

/// Walks every component below `root` using `symlink_metadata` (no-follow).
/// Parent components must be real directories; the final component may be a
/// regular file or missing, but a symlink is rejected at any position.
/// Encountering a missing component means the rest of the suffix is missing
/// too, so there is nothing left to inspect.
fn assert_no_symlink_components(root: &Path, candidate: &Path) -> Result<(), String> {
    let relative = candidate.strip_prefix(root).map_err(|_| "relative path resolves outside grant".to_string())?;
    let components: Vec<_> = relative.components().collect();
    let mut current = root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        if matches!(component, Component::CurDir) {
            continue;
        }
        current.push(component);
        let is_leaf = index + 1 == components.len();
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                log::warn!("plugin folder: symlink component rejected at {}", current.display());
                return Err("path crosses a symbolic link inside the grant".to_string());
            }
            Ok(meta) if !is_leaf && !meta.is_dir() => {
                return Err("path component is not a directory".to_string());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err("cannot inspect path".to_string()),
        }
    }
    Ok(())
}

/// Creates missing parent directories one level at a time. `create_dir` never
/// follows a link, and an already-existing component is re-checked with
/// `symlink_metadata` before it is accepted as a safe parent.
fn create_dirs_verified(root: &Path, parent: &Path) -> Result<(), String> {
    let relative = parent.strip_prefix(root).map_err(|_| "relative path resolves outside grant".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if matches!(component, Component::CurDir) {
            continue;
        }
        current.push(component);
        match std::fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let meta = std::fs::symlink_metadata(&current).map_err(|_| "cannot inspect path".to_string())?;
                if meta.file_type().is_symlink() || !meta.is_dir() {
                    return Err("path crosses a symbolic link inside the grant".to_string());
                }
            }
            Err(_) => return Err("cannot create parent directory".to_string()),
        }
    }
    Ok(())
}

/// Opens a writable file without following a symlink at the final component.
/// `O_NOFOLLOW` closes the Unix race between the metadata walk and the open;
/// non-Unix platforms rely on the preceding no-follow walk.
fn open_no_follow(path: &Path, truncate: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(truncate);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(::libc::O_NOFOLLOW);
    }
    #[cfg(not(unix))]
    {
        if std::fs::symlink_metadata(path).map(|meta| meta.file_type().is_symlink()).unwrap_or(false) {
            return Err("target is a symbolic link".to_string());
        }
    }
    options.open(path).map_err(|error| format!("cannot open target file: {error}"))
}

/// Canonicalizes the nearest existing ancestor of `path` and rebuilds the
/// remaining (not-yet-created) suffix, then verifies the result stays under
/// `canonical_root`. Every probe uses `symlink_metadata`: a dangling symlink
/// is "present" as a link and is rejected instead of being treated as a
/// missing segment that can be recreated by `create_dir_all`.
fn resolve_allowing_missing(path: &Path, canonical_root: &Path) -> Result<PathBuf, String> {
    let mut probe = path;
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let existing = loop {
        match std::fs::symlink_metadata(probe) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    log::warn!("plugin folder: symlink component rejected near {}", probe.display());
                    return Err("path crosses a symbolic link inside the grant".to_string());
                }
                break probe.to_path_buf();
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = probe.file_name().ok_or_else(|| "relative path resolves outside grant".to_string())?;
                missing.push(name.to_os_string());
                probe = probe.parent().ok_or_else(|| "relative path resolves outside grant".to_string())?;
            }
            Err(_) => return Err("cannot resolve path".to_string()),
        }
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
    assert_no_symlink_components(canonical_root, &rebuilt)?;
    Ok(rebuilt)
}

/// Resolves a relative path to a canonical absolute path inside the grant.
///
/// The caller must have already called [`check_root_unchanged`] on the
/// [`OpenFolder`] — this function trusts the root that was validated there.
fn resolve_relative(canonical_root: &Path, relative: &str) -> Result<PathBuf, String> {
    let joined = join_under_root(canonical_root, relative)?;
    // Single no-follow choke point shared by reads, listings and writes: a
    // link at any position (including a dangling one) is rejected before
    // canonicalize can resolve it away.
    assert_no_symlink_components(canonical_root, &joined)?;
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

/// Resolves a readable regular file inside the grant and returns it together
/// with its metadata. Containment is validated before the path is handed back,
/// so callers can gate a large read before loading any bytes.
fn resolve_readable_file(
    state: &PluginFileState,
    plugin_id: &str,
    folder_handle_id: &str,
    relative_path: &str,
) -> Result<(PathBuf, std::fs::Metadata), String> {
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
    Ok((absolute, meta))
}

/// Returns the byte size of a readable file without loading it, so the command
/// layer can ask the user before reading a large file.
pub(super) fn folder_file_size(
    state: &PluginFileState,
    plugin_id: &str,
    folder_handle_id: &str,
    relative_path: &str,
) -> Result<u64, String> {
    Ok(resolve_readable_file(state, plugin_id, folder_handle_id, relative_path)?.1.len())
}

/// Reads a file inside a granted folder as UTF-8 text.
pub(super) fn folder_read_text(
    state: &PluginFileState,
    plugin_id: &str,
    folder_handle_id: &str,
    relative_path: &str,
) -> Result<String, String> {
    let (absolute, _) = resolve_readable_file(state, plugin_id, folder_handle_id, relative_path)?;
    read_to_string(&absolute).map_err(|_| "cannot read file".to_string())
}

/// Reads a file inside a granted folder as raw bytes. The command layer asks
/// the user to confirm before loading files above its large-read threshold.
pub(super) fn folder_read_binary(
    state: &PluginFileState,
    plugin_id: &str,
    folder_handle_id: &str,
    relative_path: &str,
) -> Result<Vec<u8>, String> {
    let (absolute, _) = resolve_readable_file(state, plugin_id, folder_handle_id, relative_path)?;
    std::fs::read(&absolute).map_err(|_| "cannot read file".to_string())
}

/// Resolves a file inside a granted folder to its canonical absolute path,
/// for handing to other openers without exposing the grant root.
pub(super) fn folder_resolve_entry(
    state: &PluginFileState,
    plugin_id: &str,
    folder_handle_id: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let canonical_root = {
        let folders = state.folders.lock().map_err(|_| "plugin folder registry poisoned".to_string())?;
        let open = lookup(&folders, plugin_id, folder_handle_id)?;
        check_root_unchanged(open)?
    };
    let absolute = resolve_relative(&canonical_root, relative_path)?;
    if !absolute.exists() {
        return Err("path does not exist".to_string());
    }
    Ok(absolute)
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
    // Parents were only inspected, not created. Create them one level at a
    // time so a link cannot appear between the walk and the directory creation.
    if let Some(parent) = target.parent() {
        create_dirs_verified(&canonical_root, parent)?;
    }
    Ok(target)
}

/// Atomically writes `bytes` to `target` via a temp file on the same volume,
/// fsync, and rename. A crash or write failure at any point leaves the
/// previous contents intact — no mid-write truncation, no partial file.
fn write_file_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    // Temp file in the same directory so rename stays within one filesystem
    // (the only thing that makes rename truly atomic). `create_new` refuses a
    // pre-planted link at the temp path instead of following it; `rename`
    // replaces the target entry itself, so it never follows a target link.
    let suffix = Uuid::new_v4();
    let temp =
        target.with_extension(format!("{}.tmp.{suffix}", target.extension().and_then(|s| s.to_str()).unwrap_or("")));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| "cannot create temp file".to_string())?;
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

/// Appends one chunk of a large binary export at `offset`.
///
/// Large exports (PNG/XLSX) do not fit in a single bridge request, so the plugin
/// uploads them in chunks: `offset == 0` truncates the target first, later chunks
/// append in order, and the file is complete once the last chunk lands. Only
/// whole-file writes use atomic replacement; chunked writes go straight to the
/// file so the process never holds multiple copies in memory.
pub(super) fn folder_write_bytes_chunk(
    state: &PluginFileState,
    plugin_id: &str,
    folder_handle_id: &str,
    relative_path: &str,
    bytes: &[u8],
    create: bool,
    offset: u64,
) -> Result<(), String> {
    let target = prepare_write_target(state, plugin_id, folder_handle_id, relative_path, create)?;
    // Truncation is explicit: only the first chunk (offset 0) clears the file, later chunks keep existing bytes.
    let mut file = open_no_follow(&target, false)?;
    if offset == 0 {
        // Truncate the previous contents on the first chunk so a shorter export cannot leave a stale tail.
        file.set_len(0).map_err(|error| format!("cannot truncate target file: {error}"))?;
    }
    file.seek(SeekFrom::Start(offset)).map_err(|error| format!("cannot seek target file: {error}"))?;
    file.write_all(bytes).map_err(|error| format!("cannot write target file: {error}"))?;
    Ok(())
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
    fn file_size_reports_bytes_without_reading() {
        let dir = temp_dir("size");
        std::fs::write(dir.join("data.bin"), vec![0u8; 64]).unwrap();
        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();

        assert_eq!(folder_file_size(&state, OWNER, &meta.folder_handle_id, "data.bin").unwrap(), 64);
        // Same containment and ownership gates as an actual read.
        assert!(folder_file_size(&state, OWNER, &meta.folder_handle_id, "../escape").is_err());
        assert!(folder_file_size(&state, OTHER, &meta.folder_handle_id, "data.bin").is_err());
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
    fn chunked_binary_write_truncates_then_appends() {
        let dir = temp_dir("chunk");
        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();

        // The first chunk truncates and writes at offset 0; later chunks append in order.
        folder_write_bytes_chunk(&state, OWNER, &meta.folder_handle_id, "out/big.png", b"hello ", true, 0).unwrap();
        folder_write_bytes_chunk(&state, OWNER, &meta.folder_handle_id, "out/big.png", b"world", false, 6).unwrap();
        assert_eq!(std::fs::read(dir.join("out/big.png")).unwrap(), b"hello world");

        // Rewriting shorter content from offset 0 must truncate instead of keeping the previous tail.
        folder_write_bytes_chunk(&state, OWNER, &meta.folder_handle_id, "out/big.png", b"hi", true, 0).unwrap();
        assert_eq!(std::fs::read(dir.join("out/big.png")).unwrap(), b"hi");

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
    fn dangling_symlink_parent_rejects_text_write() {
        let dir = temp_dir("dangling-parent-text");
        let outside = std::env::temp_dir().join(format!("dbx-plugin-dangling-outside-text-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();

        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();
        let result = folder_write_text(&state, OWNER, &meta.folder_handle_id, "link/a/b.txt", "hacked", true);
        assert!(result.is_err(), "writing below a dangling symlink must be refused");
        assert!(!outside.exists(), "the symlink target must not be created");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    #[cfg(unix)]
    fn dangling_symlink_parent_rejects_chunked_write() {
        let dir = temp_dir("dangling-parent-chunk");
        let outside = std::env::temp_dir().join(format!("dbx-plugin-dangling-outside-chunk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();

        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();
        // Both chunks pass create=true: with create=false the later chunk would
        // fail simply because the target is missing and the test would pass
        // even with the symlink bug still present.
        let first = folder_write_bytes_chunk(&state, OWNER, &meta.folder_handle_id, "link/a/b.bin", b"hello ", true, 0);
        assert!(first.is_err(), "the first chunk below a dangling symlink must be refused");
        let rest = folder_write_bytes_chunk(&state, OWNER, &meta.folder_handle_id, "link/a/b.bin", b"world", true, 6);
        assert!(rest.is_err(), "a later chunk below a dangling symlink must be refused");
        assert!(!outside.exists(), "the symlink target must not be created");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    #[cfg(unix)]
    fn symlink_file_target_rejects_write() {
        let dir = temp_dir("symlink-file-target");
        let outside = std::env::temp_dir().join(format!("dbx-plugin-symlink-file-outside-{}", std::process::id()));
        std::fs::write(&outside, "original").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("victim.txt")).unwrap();

        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();
        let atomic = folder_write_text(&state, OWNER, &meta.folder_handle_id, "victim.txt", "hacked", true);
        assert!(atomic.is_err(), "atomic writes must not follow a symlink target");
        let chunk = folder_write_bytes_chunk(&state, OWNER, &meta.folder_handle_id, "victim.txt", b"hacked", true, 0);
        assert!(chunk.is_err(), "chunked writes must not follow a symlink target");
        assert_eq!(std::fs::read(&outside).unwrap(), b"original", "external file must remain untouched");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    #[cfg(unix)]
    fn symlink_intermediate_component_rejected() {
        let dir = temp_dir("symlink-intermediate");
        let inside = dir.join("real");
        std::fs::create_dir_all(&inside).unwrap();
        std::os::unix::fs::symlink(&inside, dir.join("alias")).unwrap();

        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();
        let result = folder_write_text(&state, OWNER, &meta.folder_handle_id, "alias/x.txt", "hacked", true);
        assert!(result.is_err(), "an in-grant symlink component must be refused even without escape");
        assert!(!inside.join("x.txt").exists(), "the symlink target directory must not be written to");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(unix)]
    fn folder_list_does_not_follow_symlinked_directories() {
        let dir = temp_dir("list-symlink");
        let outside = std::env::temp_dir().join(format!("dbx-plugin-list-symlink-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(outside.join("nested")).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("escape")).unwrap();

        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();
        let listed = folder_list(&state, OWNER, &meta.folder_handle_id, None, None).unwrap();
        let names: Vec<&str> = listed.entries.iter().map(|entry| entry.name.as_str()).collect();
        assert!(!names.contains(&"secret.txt"), "listing must not follow a symlinked directory");
        assert!(!names.contains(&"escape"), "symlink entries must be skipped");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
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
    fn closed_handle_rejects_further_operations() {
        let dir = temp_dir("closed");
        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();
        folder_write_text(&state, OWNER, &meta.folder_handle_id, "a.txt", "x", true).unwrap();

        close_folder(&state, OWNER, &meta.folder_handle_id).unwrap();

        // Revoking the grant must invalidate every operation on the old handle.
        assert!(folder_read_text(&state, OWNER, &meta.folder_handle_id, "a.txt").is_err());
        assert!(folder_write_text(&state, OWNER, &meta.folder_handle_id, "a.txt", "y", true).is_err());
        assert!(folder_list(&state, OWNER, &meta.folder_handle_id, None, None).is_err());
        assert!(folder_file_size(&state, OWNER, &meta.folder_handle_id, "a.txt").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_recent_folders_migrate_to_stable_ids() {
        let data = temp_dir("recent-migrate");
        let granted = temp_dir("recent-migrate-target");
        let legacy = serde_json::to_vec(&vec![granted.to_string_lossy().into_owned()]).unwrap();
        std::fs::write(recent_folders_path(&data), legacy).unwrap();

        let first = recent_folder_metas(&data);
        assert_eq!(first.len(), 1);
        // The legacy list is upgraded on disk immediately, so a restart (which
        // re-reads the file) keeps the same opaque id and `openFolderRef` works.
        let second = recent_folder_metas(&data);
        assert_eq!(second[0].id, first[0].id);
        // A legacy record has no identity to compare against, so it must ask
        // for native re-consent instead of silently re-granting access.
        assert!(second[0].needs_confirmation);
        assert_eq!(verify_recent_grant(&data, &second[0].id).unwrap_err(), RecentGrantError::NeedsConfirmation);
        assert!(find_recent_folder(&data, &second[0].id).is_some());

        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&granted);
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
            remember_recent_folder(&data, dir, false);
        }
        // Re-granting an older folder moves it back to the front instead of duplicating.
        let kept_id = remember_recent_folder(&data, &dirs[2], false);
        let metas = recent_folder_metas(&data);
        assert_eq!(metas.len(), MAX_RECENT_FOLDERS);
        assert_eq!(metas[0].id, kept_id);
        assert_eq!(metas[0].name, "project-2");
        // The label is the masked display form, not a real absolute path.
        assert!(metas[0].label.ends_with("project-2"));
        assert!(metas[0].label.starts_with("…/") || metas[0].label.starts_with("~/"));
        // The opaque id resolves back to the recorded directory, and no path is
        // exposed on the plugin-facing entry.
        assert_eq!(find_recent_folder(&data, &kept_id).unwrap().path, dirs[2].to_string_lossy());

        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn recent_folders_drop_missing_directories() {
        let data = temp_dir("recent-missing");
        let alive = data.join("alive");
        let gone = data.join("gone");
        std::fs::create_dir_all(&alive).unwrap();
        std::fs::create_dir_all(&gone).unwrap();
        remember_recent_folder(&data, &alive, false);
        remember_recent_folder(&data, &gone, false);
        std::fs::remove_dir_all(&gone).unwrap();

        let metas = recent_folder_metas(&data);
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].name, "alive");

        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    #[cfg(unix)]
    fn same_path_replacement_rejects_live_handle() {
        let dir = temp_dir("identity-live");
        std::fs::write(dir.join("keep.erm"), "original").unwrap();
        let moved = dir.with_extension("moved");
        let _ = std::fs::remove_dir_all(&moved);

        let state = PluginFileState::default();
        let meta = open_folder(&state, OWNER, &dir, false).unwrap();

        // Same canonical path, different directory instance.
        std::fs::rename(&dir, &moved).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("keep.erm"), "replacement").unwrap();

        let expected = "granted folder was modified on disk";
        assert_eq!(folder_read_text(&state, OWNER, &meta.folder_handle_id, "keep.erm").unwrap_err(), expected);
        assert!(folder_list(&state, OWNER, &meta.folder_handle_id, None, None).is_err());
        assert!(folder_file_size(&state, OWNER, &meta.folder_handle_id, "keep.erm").is_err());
        assert!(folder_write_text(&state, OWNER, &meta.folder_handle_id, "hacked.txt", "x", true).is_err());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&moved);
    }

    #[test]
    #[cfg(unix)]
    fn persisted_grant_rejects_replaced_directory() {
        let data = temp_dir("identity-data");
        let dir = temp_dir("identity-persisted");
        let id = remember_recent_folder(&data, &dir, false);
        assert!(verify_recent_grant(&data, &id).is_ok());

        let moved = dir.with_extension("moved");
        let _ = std::fs::remove_dir_all(&moved);
        std::fs::rename(&dir, &moved).unwrap();
        std::fs::create_dir_all(&dir).unwrap();

        assert_eq!(verify_recent_grant(&data, &id).unwrap_err(), RecentGrantError::NeedsConfirmation);
        let metas = recent_folder_metas(&data);
        assert_eq!(metas.len(), 1);
        assert!(metas[0].needs_confirmation, "a replaced directory must require re-consent");

        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&moved);
    }

    #[test]
    #[cfg(unix)]
    fn persisted_grant_rejects_symlink_replacement() {
        let data = temp_dir("identity-symlink-data");
        let dir = temp_dir("identity-symlink-target");
        let id = remember_recent_folder(&data, &dir, false);
        assert!(verify_recent_grant(&data, &id).is_ok());

        let moved = dir.with_extension("moved");
        let _ = std::fs::remove_dir_all(&moved);
        std::fs::rename(&dir, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &dir).unwrap();

        // symlink_metadata sees the link itself and refuses it, even though the
        // link points at the original directory.
        assert_eq!(verify_recent_grant(&data, &id).unwrap_err(), RecentGrantError::NeedsConfirmation);
        assert!(recent_folder_metas(&data)[0].needs_confirmation);

        let _ = std::fs::remove_file(&dir);
        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&moved);
    }

    #[test]
    fn legacy_record_without_identity_requires_consent() {
        let data = temp_dir("identity-legacy-data");
        let dir = temp_dir("identity-legacy-target");
        let legacy = serde_json::json!([{
            "id": "legacy-id",
            "name": "legacy-target",
            "path": dir.to_string_lossy().into_owned(),
        }]);
        std::fs::write(recent_folders_path(&data), serde_json::to_vec(&legacy).unwrap()).unwrap();

        assert_eq!(verify_recent_grant(&data, "legacy-id").unwrap_err(), RecentGrantError::NeedsConfirmation);
        assert!(recent_folder_metas(&data)[0].needs_confirmation);

        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
