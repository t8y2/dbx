//! OS-drop consent and expansion: grant bookkeeping (via `PluginFileState`),
//! the bounded folder walk, and lazy registration of dropped files.

use std::path::Path;

use uuid::Uuid;

use super::{
    file_identity, guess_content_type, DroppedFile, DroppedFilesResult, PluginFileHandle, PluginFileState,
    MAX_DROPPED_FILES, MAX_DROP_FOLDER_DEPTH, MAX_DROP_FOLDER_FILES, MAX_DROP_PATHS,
};

/// One regular file collected from a drop: absolute path, '/'-separated path
/// relative to the dropped root, size in bytes, and platform file identity.
type CollectedDropFile = (std::path::PathBuf, String, u64, Option<(u64, u64)>);

/// The command-level gate for `plugin_file_open_dropped`: after the dialog flows moved
/// to Rust, the only renderer path into this registry is the OS drop flow, so
/// a path alone is never consent — the native drag-drop pipeline must have
/// delivered it to THIS webview. A granted folder expands to the regular
/// files it contains (bounded walk, symlinks never followed), so the plugin
/// receives entries for files even when the user dragged a whole folder.
/// Entries are metadata only — each file is opened just-in-time for its
/// first chunk read, so a huge folder burns no fds and no registry slots.
/// Write handles are dialog-only: a path string is not authorization to
/// create or truncate a file.
///
/// Individual paths are skipped with a host-log warning instead of failing
/// the whole call: a mixed drop (folder + file, or one stale path) still
/// delivers everything that is legitimately openable.
pub(super) fn open_dropped_plugin_files(
    state: &PluginFileState,
    webview_label: &str,
    plugin_id: &str,
    paths: &[String],
) -> DroppedFilesResult {
    let drop_id = Uuid::new_v4().to_string();
    if plugin_id.trim().is_empty() {
        log::warn!("plugin_file_open_dropped requires a plugin id");
        return DroppedFilesResult { drop_id, files: Vec::new(), truncated: false };
    }
    // The claim list length is renderer input even though each claim must
    // still match a native-drop grant: cap it so one open call cannot make
    // the host scan grants and emit warn lines without bound. Excess claims
    // surface as partial delivery, like every other cap.
    let mut truncated = false;
    let claimed: &[String] = if paths.len() > MAX_DROP_PATHS {
        log::warn!(
            "plugin_file_open_dropped got {} claimed paths for plugin \"{plugin_id}\"; only the first {MAX_DROP_PATHS} were processed",
            paths.len()
        );
        truncated = true;
        &paths[..MAX_DROP_PATHS]
    } else {
        paths
    };
    let mut handles = Vec::new();
    for path in claimed {
        if !state.consume_dropped_path(webview_label, path) {
            // Indistinguishable from a vanished path to the caller; the host log is
            // where a probe attempt can be told apart from a stale drop grant.
            log::warn!("plugin_file_open_dropped rejected a path the drop pipeline did not grant to webview \"{webview_label}\" (plugin: {plugin_id})");
            continue;
        }
        let path = Path::new(path);
        // The relative paths of a folder's files start with the folder's own
        // name, so a mixed drop of two folders stays unambiguous: two roots
        // with an identically named file produce distinct paths.
        let root_name =
            path.file_name().and_then(|value| value.to_str()).map(|name| name.to_string()).unwrap_or_default();
        // symlink_metadata first: what the OS delivered decides policy, not
        // whatever the path happens to resolve to.
        let contained: Vec<CollectedDropFile> = match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_symlink() => {
                // A dropped alias must not widen the grant to an unintended
                // subtree: a symlinked folder is never expanded, a symlinked
                // file stays the single bounded entry the user aimed at.
                match std::fs::metadata(path) {
                    Ok(target) if target.is_dir() => {
                        log::warn!(
                            "dropped folder alias {} is not expanded (symlinks are never followed)",
                            path.display()
                        );
                        Vec::new()
                    }
                    Ok(target) => vec![(path.to_path_buf(), String::new(), target.len(), file_identity(&target))],
                    Err(error) => {
                        log::warn!("dropped path {} vanished before it could be opened: {error}", path.display());
                        Vec::new()
                    }
                }
            }
            Ok(metadata) if metadata.is_dir() => {
                let mut files = Vec::new();
                let mut count_truncated = false;
                let mut depth_truncated = false;
                collect_folder_files(path, path, 0, &mut files, &mut count_truncated, &mut depth_truncated);
                if count_truncated {
                    log::warn!("dropped folder {} holds more than {MAX_DROP_FOLDER_FILES} files; only the first {MAX_DROP_FOLDER_FILES} were handed to plugin \"{plugin_id}\"", path.display());
                }
                if depth_truncated {
                    log::warn!("dropped folder {} has content deeper than {MAX_DROP_FOLDER_DEPTH} levels; deeper files were not handed to plugin \"{plugin_id}\"", path.display());
                }
                if count_truncated || depth_truncated {
                    truncated = true;
                }
                if files.is_empty() {
                    log::warn!(
                        "dropped folder {} contains no regular files for plugin \"{plugin_id}\"",
                        path.display()
                    );
                }
                // Re-anchor the walk's root-relative paths under the dropped
                // folder's own name (see root_name above).
                files
                    .into_iter()
                    .map(|(file_path, relative, size, identity)| {
                        let prefixed =
                            if relative.is_empty() { root_name.clone() } else { format!("{root_name}/{relative}") };
                        (file_path, prefixed, size, identity)
                    })
                    .collect()
            }
            Ok(metadata) => vec![(path.to_path_buf(), String::new(), metadata.len(), file_identity(&metadata))],
            Err(error) => {
                log::warn!("dropped path {} vanished before it could be opened: {error}", path.display());
                Vec::new()
            }
        };
        for (file_path, relative_path, size, identity) in contained {
            match register_dropped_file(state, plugin_id, &file_path, &relative_path, size, identity) {
                Ok(handle) => handles.push(handle),
                Err(error) => log::warn!("plugin drop: cannot register {}: {error}", file_path.display()),
            }
        }
    }
    DroppedFilesResult { drop_id, files: handles, truncated }
}

/// Registers one drop-granted file as a lazily-opened metadata entry and
/// returns its wire handle. No fd is taken here; the size comes from the
/// expansion walk (or the single-path stat), so no second stat is needed.
pub(super) fn register_dropped_file(
    state: &PluginFileState,
    plugin_id: &str,
    path: &Path,
    relative_path: &str,
    size: u64,
    identity: Option<(u64, u64)>,
) -> Result<PluginFileHandle, String> {
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("download.bin").to_string();
    let handle_id = Uuid::new_v4().to_string();
    let content_type = guess_content_type(path);
    let entry = DroppedFile { path: path.to_path_buf(), owner: plugin_id.to_string(), identity };
    let handle = PluginFileHandle {
        handle_id: handle_id.clone(),
        name,
        size,
        content_type,
        write: false,
        relative_path: relative_path.to_string(),
    };
    let mut dropped = state.dropped_files.lock().map_err(|_| "plugin file registry poisoned".to_string())?;
    if dropped.len() >= MAX_DROPPED_FILES {
        return Err(format!("too many dropped file entries (max {MAX_DROPPED_FILES})"));
    }
    dropped.insert(handle_id, entry);
    Ok(handle)
}

/// Bounded expansion of a dropped folder to the regular files inside it.
/// Symlinks are never followed, so a dropped folder cannot pull in paths
/// outside itself, and cycles cannot hang the walk. Dotfiles and
/// dot-directories (.git, .DS_Store, ...) are host/SCM bookkeeping, not user
/// payload, and are skipped — a code repo must not burn the expansion cap on
/// .git/objects. Output is sorted so the plugin sees a stable order for the
/// same folder contents; each entry carries its path relative to the folder
/// root, its size, and its file identity. The flags report WHY collection
/// stopped: more files than the cap, or content below the depth floor — both
/// are surfaced to the host log so partial delivery is never silent.
fn collect_folder_files(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<CollectedDropFile>,
    count_truncated: &mut bool,
    depth_truncated: &mut bool,
) {
    if out.len() >= MAX_DROP_FOLDER_FILES {
        *count_truncated = true;
        return;
    }
    if depth >= MAX_DROP_FOLDER_DEPTH {
        *depth_truncated = true;
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<std::path::PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    children.sort();
    for child in children {
        if out.len() >= MAX_DROP_FOLDER_FILES {
            *count_truncated = true;
            return;
        }
        if child.file_name().and_then(|name| name.to_str()).map(|name| name.starts_with('.')).unwrap_or(false) {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(&child) else { continue };
        if metadata.is_symlink() {
            continue;
        }
        // '/'-separated relative path regardless of platform separator, so a
        // plugin can rebuild the dragged structure portably.
        let relative = child
            .strip_prefix(root)
            .map(|relative| {
                relative
                    .components()
                    .map(|component| component.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_default();
        if metadata.is_dir() {
            collect_folder_files(root, &child, depth + 1, out, count_truncated, depth_truncated);
            if *count_truncated {
                return;
            }
        } else if metadata.is_file() {
            out.push((child, relative, metadata.len(), file_identity(&metadata)));
        }
    }
}
