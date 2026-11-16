//! Persistent key-value storage for plugin workbench UIs.
//!
//! The workbench sandbox runs with an opaque origin, so `localStorage` and
//! friends throw there and a plugin UI has nowhere of its own to keep state.
//! These commands give every plugin a small JSON-backed store inside its own
//! `plugin-data/<id>` directory — the same tree the sidecar receives as
//! `DBX_PLUGIN_DATA_DIR` — without touching the application database.
//!
//! Every call carries the caller's plugin id; the workbench-host TS layer is
//! the only caller of these commands, and the id selects a per-plugin
//! directory, so one plugin can neither read nor shape another plugin's
//! entries. Values are arbitrary JSON documents; both per-value and per-store
//! size caps keep this a UI-state store — bulk data belongs to the sidecar.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::State;

use super::connection::AppState;

/// File backing one plugin's UI store, inside its `plugin-data/<id>` directory.
const UI_STORAGE_FILE: &str = "ui-storage.json";
/// Sibling name a corrupt store is moved aside to before starting fresh.
const CORRUPT_SUFFIX: &str = ".corrupt";
/// Upper bound for one serialized value: UI state, not a blob store.
pub const MAX_PLUGIN_STORAGE_VALUE_BYTES: usize = 256 * 1024;
/// Upper bound for the whole serialized store.
pub const MAX_PLUGIN_STORAGE_TOTAL_BYTES: usize = 1024 * 1024;
/// Upper bound for the number of distinct keys.
pub const MAX_PLUGIN_STORAGE_KEYS: usize = 1024;
const MAX_PLUGIN_ID_CHARS: usize = 128;
const MAX_STORAGE_KEY_CHARS: usize = 256;

/// Serializes read-modify-write cycles across calls. Tauri runs async commands
/// on a thread pool, so two workbench tabs of one plugin could otherwise race
/// a set() against another set() and lose an update.
#[derive(Default)]
pub struct PluginUiStorageState {
    lock: Arc<Mutex<()>>,
}

impl PluginUiStorageState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Reject ids that could escape the per-plugin directory. Mirrors the
/// manifest identifier pattern (`^[a-z0-9][a-z0-9._-]*$`): with no path
/// separators and an alphanumeric lead, `join(plugin_id)` is always a single
/// fresh directory component.
fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    let mut chars = plugin_id.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return Err("plugin id is invalid".to_string()),
    }
    if plugin_id.len() > MAX_PLUGIN_ID_CHARS
        || !chars.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err("plugin id is invalid".to_string());
    }
    Ok(())
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.chars().count() > MAX_STORAGE_KEY_CHARS || key.chars().any(char::is_control) {
        return Err("storage key is invalid".to_string());
    }
    Ok(())
}

fn storage_file(data_dir: &Path) -> PathBuf {
    data_dir.join(UI_STORAGE_FILE)
}

/// Reads one plugin's entries. A missing file is an empty store; a file that
/// does not parse is moved aside (`.corrupt`, replacing any earlier one) so a
/// truncated write heals on the next call while the damaged bytes stay
/// recoverable by hand instead of being silently destroyed.
fn load_entries(data_dir: &Path) -> Result<serde_json::Map<String, Value>, String> {
    let path = storage_file(data_dir);
    let contents = match std::fs::read(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::Map::new()),
        Err(error) => return Err(format!("cannot read plugin UI storage: {error}")),
    };
    match serde_json::from_slice::<Value>(&contents) {
        Ok(Value::Object(map)) => Ok(map),
        _ => {
            std::fs::rename(&path, format!("{}{}", path.to_string_lossy(), CORRUPT_SUFFIX))
                .map_err(|error| format!("cannot move corrupt plugin UI storage aside: {error}"))?;
            Ok(serde_json::Map::new())
        }
    }
}

/// Atomically replaces the store: write a temp sibling, fsync, rename over the
/// target. A crash mid-write leaves the old store intact.
fn save_entries(data_dir: &Path, entries: &serde_json::Map<String, Value>) -> Result<(), String> {
    let bytes = serde_json::to_vec(&Value::Object(entries.clone()))
        .map_err(|error| format!("cannot encode plugin UI storage: {error}"))?;
    if bytes.len() > MAX_PLUGIN_STORAGE_TOTAL_BYTES {
        return Err(format!("plugin UI storage exceeds {MAX_PLUGIN_STORAGE_TOTAL_BYTES} bytes"));
    }
    std::fs::create_dir_all(data_dir).map_err(|error| format!("cannot create plugin data directory: {error}"))?;
    let path = storage_file(data_dir);
    let temp = format!("{}.tmp", path.to_string_lossy());
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp)
            .map_err(|error| format!("cannot create plugin UI storage temp file: {error}"))?;
        file.write_all(&bytes).map_err(|error| format!("cannot write plugin UI storage: {error}"))?;
        file.sync_all().map_err(|error| format!("cannot flush plugin UI storage: {error}"))?;
    }
    std::fs::rename(&temp, &path).map_err(|error| format!("cannot replace plugin UI storage: {error}"))
}

pub fn get_ui_storage_entry(data_dir: &Path, key: &str) -> Result<Option<Value>, String> {
    validate_key(key)?;
    Ok(load_entries(data_dir)?.get(key).cloned())
}

pub fn set_ui_storage_entry(data_dir: &Path, key: &str, value: Value) -> Result<(), String> {
    validate_key(key)?;
    let encoded =
        serde_json::to_vec(&value).map_err(|error| format!("cannot encode plugin UI storage value: {error}"))?;
    if encoded.len() > MAX_PLUGIN_STORAGE_VALUE_BYTES {
        return Err(format!("plugin UI storage value exceeds {MAX_PLUGIN_STORAGE_VALUE_BYTES} bytes"));
    }
    let mut entries = load_entries(data_dir)?;
    if !entries.contains_key(key) && entries.len() >= MAX_PLUGIN_STORAGE_KEYS {
        return Err(format!("plugin UI storage exceeds {MAX_PLUGIN_STORAGE_KEYS} keys"));
    }
    entries.insert(key.to_string(), value);
    save_entries(data_dir, &entries)
}

pub fn delete_ui_storage_entry(data_dir: &Path, key: &str) -> Result<(), String> {
    validate_key(key)?;
    let mut entries = load_entries(data_dir)?;
    if entries.remove(key).is_some() {
        return save_entries(data_dir, &entries);
    }
    Ok(())
}

fn data_dir(registry: &dbx_core::plugins::PluginRegistry, plugin_id: &str) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;
    Ok(registry.plugin_data_dir(plugin_id))
}

#[tauri::command]
pub async fn plugin_ui_storage_get(
    state: State<'_, Arc<AppState>>,
    storage: State<'_, PluginUiStorageState>,
    plugin_id: String,
    key: String,
) -> Result<Option<Value>, String> {
    let dir = data_dir(&state.plugins, &plugin_id)?;
    let lock = storage.lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "plugin UI storage lock poisoned".to_string())?;
        get_ui_storage_entry(&dir, &key)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn plugin_ui_storage_set(
    state: State<'_, Arc<AppState>>,
    storage: State<'_, PluginUiStorageState>,
    plugin_id: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    let dir = data_dir(&state.plugins, &plugin_id)?;
    let lock = storage.lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "plugin UI storage lock poisoned".to_string())?;
        set_ui_storage_entry(&dir, &key, value)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn plugin_ui_storage_delete(
    state: State<'_, Arc<AppState>>,
    storage: State<'_, PluginUiStorageState>,
    plugin_id: String,
    key: String,
) -> Result<(), String> {
    let dir = data_dir(&state.plugins, &plugin_id)?;
    let lock = storage.lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "plugin UI storage lock poisoned".to_string())?;
        delete_ui_storage_entry(&dir, &key)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dbx-plugin-storage-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn set_get_delete_roundtrip() {
        let dir = temp_dir("roundtrip");
        assert_eq!(get_ui_storage_entry(&dir, "theme").unwrap(), None);
        set_ui_storage_entry(&dir, "theme", json!({ "mode": "dark", "tabs": [1, 2] })).unwrap();
        assert_eq!(get_ui_storage_entry(&dir, "theme").unwrap(), Some(json!({ "mode": "dark", "tabs": [1, 2] })));

        set_ui_storage_entry(&dir, "lastPath", json!("s3://bucket/prefix")).unwrap();
        delete_ui_storage_entry(&dir, "theme").unwrap();
        assert_eq!(get_ui_storage_entry(&dir, "theme").unwrap(), None);
        assert_eq!(get_ui_storage_entry(&dir, "lastPath").unwrap(), Some(json!("s3://bucket/prefix")));

        // Deleting the last key leaves a valid empty store behind.
        delete_ui_storage_entry(&dir, "lastPath").unwrap();
        let raw: Value = serde_json::from_slice(&std::fs::read(storage_file(&dir)).unwrap()).unwrap();
        assert_eq!(raw, json!({}));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stores_are_isolated_per_directory() {
        let root = temp_dir("isolation");
        let one = root.join("io.dbx.one");
        let two = root.join("io.dbx.two");
        set_ui_storage_entry(&one, "secret", json!("one")).unwrap();
        set_ui_storage_entry(&two, "secret", json!("two")).unwrap();
        assert_eq!(get_ui_storage_entry(&one, "secret").unwrap(), Some(json!("one")));
        assert_eq!(get_ui_storage_entry(&two, "secret").unwrap(), Some(json!("two")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_store_is_moved_aside_and_heals() {
        let dir = temp_dir("corrupt");
        std::fs::write(storage_file(&dir), b"{ not json").unwrap();
        assert_eq!(get_ui_storage_entry(&dir, "key").unwrap(), None);
        assert!(std::fs::read(format!("{}{}", storage_file(&dir).to_string_lossy(), CORRUPT_SUFFIX)).is_ok());
        set_ui_storage_entry(&dir, "key", json!("fresh")).unwrap();
        assert_eq!(get_ui_storage_entry(&dir, "key").unwrap(), Some(json!("fresh")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_oversized_values_and_total_store() {
        let dir = temp_dir("caps");
        let big = "x".repeat(MAX_PLUGIN_STORAGE_VALUE_BYTES + 1);
        assert!(set_ui_storage_entry(&dir, "big", json!(big)).is_err());

        let chunk = "y".repeat(64 * 1024);
        // Fifteen chunks stay under the 1 MiB total cap; the sixteenth trips it.
        for index in 0..15 {
            set_ui_storage_entry(&dir, &format!("chunk{index}"), json!(chunk)).unwrap();
        }
        let error = set_ui_storage_entry(&dir, "overflow", json!(chunk)).unwrap_err();
        assert!(error.contains("exceeds"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_invalid_keys_and_plugin_ids() {
        let dir = temp_dir("validation");
        for key in [String::new(), "x".repeat(257), "bad\u{1}key".to_string()] {
            assert!(set_ui_storage_entry(&dir, &key, json!(1)).is_err(), "key {key:?} must be rejected");
        }
        assert!(get_ui_storage_entry(&dir, "ok").is_ok());

        let registry = dbx_core::plugins::PluginRegistry::new(PathBuf::from("/data/plugins"));
        for plugin_id in ["", "  ", "../escape", "io.dbx/other", ".hidden", "..", "a..b/../c", "UPPER.case", "sp ace"] {
            assert!(data_dir(&registry, plugin_id).is_err(), "plugin id {plugin_id:?} must be rejected");
        }
        assert_eq!(
            data_dir(&registry, "io.github.t8y2.s3").unwrap(),
            PathBuf::from("/data/plugin-data/io.github.t8y2.s3")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
