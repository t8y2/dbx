use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, State, Window};

use super::connection::AppState;
use super::workspace_tab_recovery::merge_recovered_tabs;
use super::workspace_window_hit_test::{topmost_workspace_window_at, WindowHitBox};

const TRANSFER_LIFETIME: Duration = Duration::from_secs(30);
const MAX_PENDING_TRANSFERS: usize = 32;

pub(crate) fn is_workspace_window(label: &str) -> bool {
    label.starts_with("dbx-tab-") && !label.starts_with("dbx-tab-drag-preview")
}

fn is_tab_window(label: &str) -> bool {
    label == "main" || is_workspace_window(label)
}

#[derive(Deserialize)]
pub struct WorkspaceWindowPoint {
    x: i32,
    y: i32,
}

#[tauri::command]
pub fn workspace_window_at(app: AppHandle, point: WorkspaceWindowPoint) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::ptr::null_mut;
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetTopWindow, GetWindow, GetWindowRect, IsIconic, IsWindowVisible, GW_HWNDNEXT,
        };

        let mut workspace_labels = HashMap::new();
        for (label, window) in app.webview_windows().into_iter().filter(|(label, _)| is_tab_window(label)) {
            let handle =
                window.hwnd().map_err(|error| format!("Failed to inspect workspace window {label}: {error}"))?;
            workspace_labels.insert(handle.0 as isize, label);
        }
        let preview_handle = app
            .get_webview_window("dbx-tab-drag-preview")
            .map(|window| {
                window
                    .hwnd()
                    .map(|handle| handle.0 as isize)
                    .map_err(|error| format!("Failed to inspect tab drag preview: {error}"))
            })
            .transpose()?;
        let mut windows_in_z_order = Vec::new();
        let mut handle = unsafe { GetTopWindow(null_mut()) };
        while !handle.is_null() {
            let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            if unsafe { IsWindowVisible(handle) } != 0 && unsafe { GetWindowRect(handle, &mut rect) } != 0 {
                windows_in_z_order.push(WindowHitBox {
                    handle: handle as isize,
                    visible: true,
                    minimized: unsafe { IsIconic(handle) } != 0,
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                });
            }
            handle = unsafe { GetWindow(handle, GW_HWNDNEXT) };
        }
        return Ok(topmost_workspace_window_at(
            (point.x, point.y),
            &windows_in_z_order,
            &workspace_labels,
            preview_handle,
        ));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, point);
        Ok(None)
    }
}

struct Transfer {
    source: String,
    target: String,
    payload: Value,
    status: &'static str,
    receiving: bool,
    started: Instant,
}

impl Transfer {
    // 提交和取消在同一锁内裁决，避免接收迟到后源窗口已经恢复标签。
    fn settle(&mut self, commit: bool) -> &'static str {
        if self.status == "pending" {
            self.status = if commit && self.started.elapsed() < TRANSFER_LIFETIME { "committed" } else { "cancelled" };
        }
        self.status
    }
}

fn can_offer_transfer(transfers: &HashMap<String, Transfer>, id: &str) -> bool {
    !transfers.contains_key(id)
        && transfers.values().filter(|transfer| transfer.status == "pending").count() < MAX_PENDING_TRANSFERS
}

fn acknowledge_committed_transfer(
    transfers: &mut HashMap<String, Transfer>,
    id: &str,
    caller: &str,
) -> Result<&'static str, String> {
    let transfer = transfers.get(id).ok_or_else(|| "Tab transfer expired or unavailable".to_string())?;
    if caller != transfer.source || transfer.status != "committed" {
        return Err("Only the source can acknowledge a committed tab transfer".into());
    }
    let status = transfer.status;
    transfers.remove(id);
    Ok(status)
}

#[derive(Default)]
pub struct WorkspaceTabsState {
    transfers: Mutex<HashMap<String, Transfer>>,
    initializing: Mutex<HashSet<String>>,
    // 同时串行化子窗口快照的读改写与主窗口恢复后的清理。
    recovered: tokio::sync::Mutex<HashSet<String>>,
}

#[tauri::command]
pub fn workspace_tab_transfer(
    app: AppHandle,
    window: Window,
    state: State<'_, WorkspaceTabsState>,
    operation: String,
    id: String,
    target: Option<String>,
    payload: Option<Value>,
) -> Result<Value, String> {
    let caller = window.label();
    if !is_tab_window(caller) {
        return Err("This window cannot transfer workspace tabs".into());
    }
    let mut transfers = state.transfers.lock().map_err(|_| "Tab transfer state unavailable")?;
    transfers.retain(|_, transfer| transfer.started.elapsed() < TRANSFER_LIFETIME * 4);
    if operation == "offer" {
        if !can_offer_transfer(&transfers, &id) {
            return Err("Tab transfer already exists or too many transfers are pending".into());
        }
        let target =
            target.filter(|target| is_tab_window(target) && target != caller).ok_or("Invalid target window")?;
        let payload = payload
            .filter(|value| value.get("tabId").and_then(Value::as_str).is_some())
            .ok_or("Invalid tab handoff")?;
        if target == format!("dbx-tab-{id}") {
            state.initializing.lock().map_err(|_| "Workspace startup state unavailable")?.insert(target.clone());
        }
        transfers.insert(
            id,
            Transfer {
                source: caller.into(),
                target,
                payload,
                status: "pending",
                receiving: false,
                started: Instant::now(),
            },
        );
        return Ok(json!("pending"));
    }
    if operation == "ack" {
        return Ok(json!(acknowledge_committed_transfer(&mut transfers, &id, caller)?));
    }
    let transfer = transfers.get_mut(&id).ok_or("Tab transfer expired or unavailable")?;
    if caller != transfer.source && caller != transfer.target {
        return Err("Tab transfer belongs to another window".into());
    }
    if transfer.started.elapsed() >= TRANSFER_LIFETIME {
        transfer.settle(false);
    }
    match operation.as_str() {
        "inspect" => Ok(json!({
            "source": transfer.source, "target": transfer.target, "status": transfer.status,
            "tabId": transfer.payload.get("tabId"),
            "title": transfer.payload.get("tab").and_then(|tab| tab.get("title")),
        })),
        "retry" if caller == transfer.target && transfer.status == "cancelled" && !transfer.receiving => {
            if app.get_webview_window(&transfer.source).is_none() {
                return Err("The source window is no longer available".into());
            }
            app.emit_to(transfer.source.as_str(), "dbx:workspace-tab-retry", json!({ "id": id }))
                .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "read" if caller == transfer.target => {
            if transfer.status != "pending" {
                return Ok(Value::Null);
            }
            // 开始接收后由已注册的前端关闭流程负责，禁止在落盘/回滚中途销毁窗口。
            state.initializing.lock().map_err(|_| "Workspace startup state unavailable")?.remove(caller);
            transfer.receiving = true;
            Ok(transfer.payload.clone())
        }
        "release" if caller == transfer.target => {
            transfer.receiving = false;
            Ok(Value::Null)
        }
        "commit" if caller == transfer.target => {
            let status = transfer.settle(true);
            if status == "committed" {
                state.initializing.lock().map_err(|_| "Workspace startup state unavailable")?.remove(caller);
            }
            Ok(json!(status))
        }
        "reject" if caller == transfer.target => Ok(json!(transfer.settle(false))),
        "cancel" if caller == transfer.source => Ok(json!(transfer.settle(false))),
        "status" => Ok(json!(transfer.status)),
        _ => Err("Unsupported tab transfer operation".into()),
    }
}

pub(crate) fn request_workspace_close(window: &Window) {
    // 初始化尚未接收标签时也必须能关闭；不能依赖尚未注册的前端监听器。
    if cancel_initial_transfer(window) {
        let _ = window.destroy();
        return;
    }
    let _ = window.emit_to(window.label(), "dbx-workspace-close-requested", window.label());
}

fn cancel_initial_transfer(window: &Window) -> bool {
    cancel_initial_transfer_in_state(&window.state::<WorkspaceTabsState>(), window.label())
}

fn cancel_initial_transfer_in_state(state: &WorkspaceTabsState, label: &str) -> bool {
    let Some(id) = label.strip_prefix("dbx-tab-") else { return false };
    let Ok(mut transfers) = state.transfers.lock() else { return false };
    let Ok(mut initializing) = state.initializing.lock() else { return false };
    if !initializing.remove(label) {
        return false;
    }
    if let Some(transfer) = transfers.get_mut(id) {
        transfer.settle(false);
    }
    true
}

pub(crate) fn forget_workspace_window(window: &Window) {
    if let Ok(mut initializing) = window.state::<WorkspaceTabsState>().initializing.lock() {
        initializing.remove(window.label());
    }
}

#[tauri::command]
pub fn close_workspace_startup(window: Window) -> Result<(), String> {
    if !is_workspace_window(window.label()) {
        return Err("Only a workspace child window can be closed here".into());
    }
    request_workspace_close(&window);
    Ok(())
}

#[tauri::command]
pub fn complete_workspace_window_close(window: Window) -> Result<(), String> {
    // 不销毁或替换 main，也不更改应用级退出与托盘职责。
    if !is_workspace_window(window.label()) {
        return Err("Only a workspace child window can be closed here".into());
    }
    window.destroy().map_err(|error| error.to_string())
}

fn snapshot_key(base_key: &str) -> String {
    format!("{base_key}_workspace_windows")
}

async fn load_snapshots(state: &AppState, base_key: &str) -> Result<Map<String, Value>, String> {
    Ok(state
        .storage
        .load_open_tabs_state_with_key(&snapshot_key(base_key))
        .await?
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default())
}

pub(crate) fn collect_result_cache_keys(value: &Value, keys: &mut HashSet<String>) {
    match value {
        Value::Object(object) => {
            if let Some(key) = object.get("resultCacheKey").and_then(Value::as_str) {
                keys.insert(key.to_owned());
            }
            for nested in object.values() {
                collect_result_cache_keys(nested, keys);
            }
        }
        Value::Array(values) => {
            for nested in values {
                collect_result_cache_keys(nested, keys);
            }
        }
        _ => {}
    }
}

pub(crate) async fn protected_result_cache_keys(app: &AppHandle, state: &AppState) -> Result<HashSet<String>, String> {
    let workspace = app.state::<WorkspaceTabsState>();
    let _guard = workspace.recovered.lock().await;
    let mut keys = HashSet::new();
    // 关闭但尚未回收的子窗口快照，也仍然是可恢复结果的有效引用。
    let snapshots = load_snapshots(state, super::app_settings::open_tabs_state_key(cfg!(debug_assertions))).await?;
    collect_result_cache_keys(&Value::Object(snapshots), &mut keys);
    let detached = super::app_settings::load_detached_tabs_map(state).await?;
    collect_result_cache_keys(&Value::Object(detached), &mut keys);
    let transfers = workspace.transfers.lock().map_err(|_| "Tab transfer state unavailable")?;
    for transfer in transfers.values().filter(|transfer| transfer.status != "cancelled") {
        collect_result_cache_keys(&transfer.payload, &mut keys);
    }
    Ok(keys)
}

pub(crate) async fn load_window_tabs(
    app: &AppHandle,
    window: &Window,
    state: &AppState,
    base_key: &str,
) -> Result<Option<Value>, String> {
    let workspace_state = app.state::<WorkspaceTabsState>();
    let mut recovered = workspace_state.recovered.lock().await;
    let snapshots = load_snapshots(state, base_key).await?;
    if is_workspace_window(window.label()) {
        return Ok(snapshots.get(window.label()).cloned());
    }
    let original = state.storage.load_open_tabs_state_with_key(base_key).await?;
    if window.label() != "main" {
        return Ok(original);
    }
    let mut merged = original.clone().unwrap_or(Value::Null);
    for (label, payload) in snapshots {
        if is_workspace_window(&label) && app.get_webview_window(&label).is_none() {
            merge_recovered_tabs(&mut merged, &payload);
            recovered.insert(label);
        }
    }
    Ok(if merged.is_null() { original } else { Some(merged) })
}

pub(crate) async fn save_window_tabs(
    app: &AppHandle,
    window: &Window,
    state: &AppState,
    base_key: &str,
    payload: &Value,
) -> Result<(), String> {
    let workspace_state = app.state::<WorkspaceTabsState>();
    let mut recovered = workspace_state.recovered.lock().await;
    if is_workspace_window(window.label()) {
        let mut snapshots = load_snapshots(state, base_key).await?;
        snapshots.insert(window.label().into(), payload.clone());
        return state.storage.save_open_tabs_state_with_key(&snapshot_key(base_key), &Value::Object(snapshots)).await;
    }
    state.storage.save_open_tabs_state_with_key(base_key, payload).await?;
    // 必须先保存恢复后的主窗口，再删除旧子窗口快照；写入失败时保留恢复来源。
    if window.label() == "main" && !recovered.is_empty() {
        let mut snapshots = load_snapshots(state, base_key).await?;
        for label in recovered.iter() {
            if app.get_webview_window(label).is_none() {
                snapshots.remove(label);
            }
        }
        state.storage.save_open_tabs_state_with_key(&snapshot_key(base_key), &Value::Object(snapshots)).await?;
        recovered.clear();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> Transfer {
        Transfer {
            source: "main".into(),
            target: "dbx-tab-test".into(),
            payload: Value::Null,
            status: "pending",
            receiving: false,
            started: Instant::now(),
        }
    }

    #[test]
    fn cancellation_and_commit_cannot_reverse_each_other() {
        let mut cancelled = pending();
        assert_eq!(cancelled.settle(false), "cancelled");
        assert_eq!(cancelled.settle(true), "cancelled");
        let mut committed = pending();
        assert_eq!(committed.settle(true), "committed");
        assert_eq!(committed.settle(false), "committed");
    }

    #[test]
    fn recent_terminal_transfers_do_not_consume_pending_transfer_capacity() {
        let mut transfers = HashMap::new();
        for index in 0..MAX_PENDING_TRANSFERS {
            let mut transfer = pending();
            transfer.status = "committed";
            transfers.insert(format!("committed-{index}"), transfer);
        }

        assert!(can_offer_transfer(&transfers, "next"));
        transfers.insert("pending".into(), pending());
        assert!(!can_offer_transfer(&transfers, "next"));
        assert!(!can_offer_transfer(&transfers, "pending"));
    }

    #[test]
    fn only_source_can_acknowledge_and_remove_a_committed_transfer() {
        let mut transfer = pending();
        transfer.status = "committed";
        let mut transfers = HashMap::from([("done".to_string(), transfer)]);

        assert!(acknowledge_committed_transfer(&mut transfers, "done", "dbx-tab-test").is_err());
        assert!(transfers.contains_key("done"));
        assert_eq!(acknowledge_committed_transfer(&mut transfers, "done", "main").unwrap(), "committed");
        assert!(!transfers.contains_key("done"));
    }

    #[test]
    fn loading_window_can_cancel_before_frontend_listeners_exist() {
        let state = WorkspaceTabsState::default();
        state.transfers.lock().unwrap().insert("test".into(), pending());
        state.initializing.lock().unwrap().insert("dbx-tab-test".into());
        assert!(cancel_initial_transfer_in_state(&state, "dbx-tab-test"));
        assert_eq!(state.transfers.lock().unwrap().get("test").unwrap().status, "cancelled");
        assert!(!cancel_initial_transfer_in_state(&state, "dbx-tab-test"));
    }

    #[test]
    fn expired_startup_still_closes_but_receiving_window_uses_normal_close() {
        let state = WorkspaceTabsState::default();
        state.initializing.lock().unwrap().insert("dbx-tab-expired".into());
        assert!(cancel_initial_transfer_in_state(&state, "dbx-tab-expired"));
        state.transfers.lock().unwrap().insert("test".into(), pending());
        assert!(!cancel_initial_transfer_in_state(&state, "dbx-tab-test"));
        assert_eq!(state.transfers.lock().unwrap().get("test").unwrap().status, "pending");
        assert!(!cancel_initial_transfer_in_state(&state, "main"));
    }

    #[test]
    fn late_target_cannot_commit() {
        let mut expired = pending();
        expired.started = Instant::now() - TRANSFER_LIFETIME;
        assert_eq!(expired.settle(true), "cancelled");
    }

    #[test]
    fn window_roles_exclude_previews_plugins_and_upstream_detached_tabs() {
        assert!(is_tab_window("main"));
        assert!(is_workspace_window("dbx-tab-example"));
        for label in ["main", "dbx-tab-drag-preview", "plugin-floating-example", "detached-tab-example"] {
            assert!(!is_workspace_window(label));
        }
    }

    #[test]
    fn cache_references_include_child_tabs_result_runs_and_inflight_handoffs() {
        let mut keys = HashSet::new();
        collect_result_cache_keys(
            &json!({
                "dbx-tab-one": { "tabs": [{ "resultCacheKey": "tab-result", "resultRuns": [
                    { "resultCacheKey": "run-result" }, { "resultCacheKey": null }
                ] }] },
                "handoff": { "resultCacheKey": "transfer-result", "tab": { "resultCacheKey": "tab-result" } }
            }),
            &mut keys,
        );
        assert_eq!(keys, HashSet::from(["tab-result".into(), "run-result".into(), "transfer-result".into()]));
    }
}
