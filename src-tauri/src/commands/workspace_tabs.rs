use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, State, Window};

use super::connection::AppState;

const TRANSFER_LIFETIME: Duration = Duration::from_secs(30);

pub(crate) fn is_workspace_window(label: &str) -> bool {
    label.starts_with("dbx-tab-") && !label.starts_with("dbx-tab-drag-preview")
}

fn is_tab_window(label: &str) -> bool {
    label == "main" || is_workspace_window(label)
}

struct Transfer {
    source: String,
    target: String,
    payload: Value,
    status: &'static str,
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

#[derive(Default)]
pub struct WorkspaceTabsState {
    transfers: Mutex<HashMap<String, Transfer>>,
    // 同时串行化子窗口快照的读改写与主窗口恢复后的清理。
    recovered: tokio::sync::Mutex<HashSet<String>>,
}

#[tauri::command]
pub fn workspace_tab_transfer(
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
        if transfers.contains_key(&id) || transfers.len() >= 32 {
            return Err("Tab transfer already exists or too many transfers are pending".into());
        }
        let target =
            target.filter(|target| is_tab_window(target) && target != caller).ok_or("Invalid target window")?;
        let payload = payload
            .filter(|value| value.get("tabId").and_then(Value::as_str).is_some())
            .ok_or("Invalid tab handoff")?;
        transfers.insert(
            id,
            Transfer { source: caller.into(), target, payload, status: "pending", started: Instant::now() },
        );
        return Ok(json!("pending"));
    }
    let transfer = transfers.get_mut(&id).ok_or("Tab transfer expired or unavailable")?;
    if caller != transfer.source && caller != transfer.target {
        return Err("Tab transfer belongs to another window".into());
    }
    if transfer.started.elapsed() >= TRANSFER_LIFETIME {
        transfer.settle(false);
    }
    match operation.as_str() {
        "read" if caller == transfer.target => {
            if transfer.status != "pending" {
                return Ok(Value::Null);
            }
            Ok(transfer.payload.clone())
        }
        "commit" if caller == transfer.target => Ok(json!(transfer.settle(true))),
        "reject" if caller == transfer.target => Ok(json!(transfer.settle(false))),
        "cancel" if caller == transfer.source => Ok(json!(transfer.settle(false))),
        "status" => Ok(json!(transfer.status)),
        _ => Err("Unsupported tab transfer operation".into()),
    }
}

pub(crate) fn request_workspace_close(window: &Window) {
    let _ = window.emit_to(window.label(), "dbx-workspace-close-requested", window.label());
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

fn merge_recovered_tabs(main: &mut Value, child: &Value) {
    let Some(child_tabs) = child.get("tabs").and_then(Value::as_array) else {
        return;
    };
    if !main.is_object() {
        *main = json!({ "tabs": [], "activeTabId": null });
    }
    if !main.get("tabs").is_some_and(Value::is_array) {
        main["tabs"] = json!([]);
    }
    let tabs = main["tabs"].as_array_mut().unwrap();
    for tab in child_tabs {
        let Some(id) = tab.get("id").and_then(Value::as_str) else {
            continue;
        };
        if let Some(index) = tabs.iter().position(|item| item.get("id").and_then(Value::as_str) == Some(id)) {
            tabs[index] = tab.clone();
        } else {
            tabs.push(tab.clone());
        }
    }
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
    fn recovery_preserves_main_layout_and_deduplicates_tabs() {
        let mut main = json!({ "tabs": [{"id":"a", "sql":"old"}], "groups": [{"id":"main"}] });
        merge_recovered_tabs(&mut main, &json!({"tabs":[{"id":"a","sql":"new"},{"id":"b"}]}));
        assert_eq!(main["tabs"].as_array().unwrap().len(), 2);
        assert_eq!(main["tabs"][0]["sql"], "new");
        assert_eq!(main["groups"][0]["id"], "main");
    }
}
