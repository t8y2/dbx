use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use dbx_core::connection::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Window};

/// 其他窗口读写过的结果在窗口存活期间保留；宁可延迟回收，也不误删未落盘的引用。
#[derive(Default)]
pub struct WindowResultCacheReferences(pub tokio::sync::Mutex<HashMap<String, HashSet<String>>>);

fn protect_other_windows(
    references: &mut HashMap<String, HashSet<String>>,
    caller: &str,
    live_windows: &HashSet<String>,
    keys: &mut HashSet<String>,
) {
    references.retain(|label, _| live_windows.contains(label));
    for (label, referenced) in references.iter() {
        if label != caller {
            keys.extend(referenced.iter().cloned());
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadTabRuntimeCacheResponse {
    pub key: String,
    pub payload_base64: String,
    pub row_count: i64,
    pub column_count: i64,
    pub byte_size: i64,
    pub updated_at: String,
    pub created_at: i64,
    pub last_accessed_at: i64,
    pub owner_id: Option<String>,
}

#[tauri::command]
pub async fn save_tab_runtime_cache(
    app: AppHandle,
    window: Window,
    state: State<'_, Arc<AppState>>,
    key: String,
    payload_base64: String,
    row_count: i64,
    column_count: i64,
    owner_id: Option<String>,
) -> Result<(), String> {
    let payload = BASE64.decode(payload_base64).map_err(|e| e.to_string())?;
    let references = app.state::<WindowResultCacheReferences>();
    let mut references = references.0.lock().await;
    state.storage.save_tab_runtime_cache(&key, payload, row_count, column_count, owner_id).await?;
    references.entry(window.label().into()).or_default().insert(key);
    Ok(())
}

#[tauri::command]
pub async fn load_tab_runtime_cache(
    app: AppHandle,
    window: Window,
    state: State<'_, Arc<AppState>>,
    key: String,
) -> Result<Option<LoadTabRuntimeCacheResponse>, String> {
    let references = app.state::<WindowResultCacheReferences>();
    let mut references = references.0.lock().await;
    let entry = state.storage.load_tab_runtime_cache(&key).await?;
    if entry.is_some() {
        references.entry(window.label().into()).or_default().insert(key);
    }
    Ok(entry.map(|entry| LoadTabRuntimeCacheResponse {
        key: entry.key,
        payload_base64: BASE64.encode(entry.payload),
        row_count: entry.row_count,
        column_count: entry.column_count,
        byte_size: entry.byte_size,
        updated_at: entry.updated_at,
        created_at: entry.created_at,
        last_accessed_at: entry.last_accessed_at,
        owner_id: entry.owner_id,
    }))
}

#[tauri::command]
pub async fn list_tab_runtime_cache_metadata(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<dbx_core::storage::TabRuntimeCacheMetadata>, String> {
    state.storage.list_tab_runtime_cache_metadata().await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneTabRuntimeCacheRequest {
    pub live_keys: Vec<String>,
    pub max_bytes: i64,
    pub orphan_grace_ms: i64,
    pub max_age_ms: Option<i64>,
}

#[tauri::command]
pub async fn prune_tab_runtime_cache(
    app: AppHandle,
    window: Window,
    state: State<'_, Arc<AppState>>,
    request: PruneTabRuntimeCacheRequest,
) -> Result<dbx_core::storage::TabRuntimeCachePruneResult, String> {
    // 与缓存读写串行，覆盖创建缓存到前端标签快照落盘之间的时间窗口。
    let references = app.state::<WindowResultCacheReferences>();
    let mut references = references.0.lock().await;
    let mut live_keys: HashSet<String> = request.live_keys.into_iter().collect();
    live_keys.extend(super::workspace_tabs::protected_result_cache_keys(&app, &state).await?);
    protect_other_windows(
        &mut references,
        window.label(),
        &app.webview_windows().into_keys().collect(),
        &mut live_keys,
    );
    state
        .storage
        .prune_tab_runtime_cache(
            live_keys.into_iter().collect(),
            request.max_bytes,
            request.orphan_grace_ms,
            request.max_age_ms,
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protects_live_children_without_pinning_closed_windows_or_stale_caller_keys() {
        let mut references = HashMap::from([
            ("main".into(), HashSet::from(["old-main".into()])),
            ("dbx-tab-child".into(), HashSet::from(["child-result".into()])),
            ("detached-tab-one".into(), HashSet::from(["detached-result".into()])),
            ("dbx-tab-closed".into(), HashSet::from(["closed-result".into()])),
        ]);
        let live = HashSet::from(["main".into(), "dbx-tab-child".into(), "detached-tab-one".into()]);
        let mut keys = HashSet::from(["current-main".into()]);
        protect_other_windows(&mut references, "main", &live, &mut keys);
        assert_eq!(keys, HashSet::from(["current-main".into(), "child-result".into(), "detached-result".into()]));
        assert!(!references.contains_key("dbx-tab-closed"));
    }
}

#[tauri::command]
pub async fn delete_tab_runtime_cache_owner(
    state: State<'_, Arc<AppState>>,
    owner_id: String,
) -> Result<usize, String> {
    state.storage.delete_tab_runtime_cache_owner(&owner_id).await
}

#[tauri::command]
pub async fn delete_tab_runtime_cache(state: State<'_, Arc<AppState>>, key: String) -> Result<(), String> {
    state.storage.delete_tab_runtime_cache(&key).await
}
