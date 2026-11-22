use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, EventTarget, Manager};

struct QuitRequest {
    id: String,
    approved: HashSet<String>,
    pending: String,
}

#[derive(Default)]
pub(crate) struct WorkspaceSessionState {
    quit: Mutex<Option<QuitRequest>>,
    ready: Mutex<HashSet<String>>,
}

impl WorkspaceSessionState {
    pub fn set_ready(&self, label: &str, ready: bool) {
        let mut windows = self.ready.lock().unwrap_or_else(|error| error.into_inner());
        if ready {
            windows.insert(label.to_string());
        } else {
            windows.remove(label);
        }
    }

    pub fn is_ready(&self, label: &str) -> bool {
        self.ready.lock().unwrap_or_else(|error| error.into_inner()).contains(label)
    }

    pub fn any_ready(&self) -> bool {
        !self.ready.lock().unwrap_or_else(|error| error.into_inner()).is_empty()
    }

    pub fn begin(&self, preferred: &str) -> (String, String) {
        let mut quit = self.quit.lock().unwrap_or_else(|error| error.into_inner());
        let request = quit.get_or_insert_with(|| QuitRequest {
            id: uuid::Uuid::new_v4().to_string(),
            approved: HashSet::new(),
            pending: preferred.to_string(),
        });
        (request.id.clone(), request.pending.clone())
    }

    pub fn approve(
        &self,
        label: &str,
        request_id: Option<&str>,
        live_labels: &[String],
    ) -> Result<Option<(String, String)>, String> {
        if request_id.is_none() {
            self.begin(label);
        }
        let mut quit = self.quit.lock().unwrap_or_else(|error| error.into_inner());
        let request = quit.as_mut().ok_or("The app quit request was cancelled")?;
        if request_id.is_some_and(|id| id != request.id) || request.pending != label {
            return Err("The app quit request is no longer current".to_string());
        }
        request.approved.insert(label.to_string());
        if let Some(next) = live_labels.iter().find(|label| !request.approved.contains(*label)) {
            request.pending = next.clone();
            return Ok(Some((request.id.clone(), next.clone())));
        }
        Ok(None)
    }

    pub fn cancel(&self, request_id: Option<&str>) -> bool {
        let mut quit = self.quit.lock().unwrap_or_else(|error| error.into_inner());
        if quit.as_ref().is_some_and(|request| request_id.is_none_or(|id| id == request.id)) {
            *quit = None;
            return true;
        }
        false
    }

    pub fn pending_for(&self, label: &str) -> Option<String> {
        self.quit
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .filter(|request| request.pending == label)
            .map(|request| request.id.clone())
    }
}

pub(crate) fn is_quit_workspace(label: &str) -> bool {
    crate::is_workspace_window_label(label) || label.starts_with("detached-tab-")
}

pub(crate) fn quit_window_labels(app: &AppHandle) -> Vec<String> {
    let mut labels: Vec<_> = app.webview_windows().into_keys().filter(|label| is_quit_workspace(label)).collect();
    labels.sort();
    labels
}

pub(crate) fn send_quit_request<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = app.emit_to(
            EventTarget::webview_window(label),
            "dbx-app-close-requested",
            serde_json::json!({ "target": "quit", "windowLabel": label, "quitRequestId": id }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_waits_for_every_window_and_rejects_stale_approval_after_cancel() {
        let state = WorkspaceSessionState::default();
        let labels = vec!["main".to_string(), "dbx-tab-a".to_string(), "dbx-tab-b".to_string()];
        let (id, _) = state.begin("main");
        assert_eq!(state.approve("main", Some(&id), &labels).unwrap(), Some((id.clone(), "dbx-tab-a".to_string())));
        assert!(state.cancel(Some(&id)));
        assert!(state.approve("dbx-tab-a", Some(&id), &labels).is_err());
        let (next_id, _) = state.begin("dbx-tab-a");
        assert_ne!(id, next_id);
        assert!(state.approve("dbx-tab-a", Some(&next_id), &labels).unwrap().is_some());
        assert!(state.approve("main", Some(&next_id), &labels).unwrap().is_some());
        assert_eq!(state.approve("dbx-tab-b", Some(&next_id), &labels).unwrap(), None);
    }

    #[test]
    fn quit_includes_legacy_detached_windows_and_excludes_previews_and_widgets() {
        assert!(is_quit_workspace("main"));
        assert!(is_quit_workspace("dbx-tab-a"));
        assert!(is_quit_workspace("detached-tab-a"));
        assert!(!is_quit_workspace("dbx-tab-drag-preview"));
        assert!(!is_quit_workspace("plugin-floating-a"));
    }

    #[test]
    fn reloading_one_window_does_not_bypass_other_windows_quit_guards() {
        let state = WorkspaceSessionState::default();
        state.set_ready("main", true);
        state.set_ready("dbx-tab-a", true);
        state.set_ready("main", false);
        assert!(state.any_ready());
        assert!(state.is_ready("dbx-tab-a"));
        state.set_ready("dbx-tab-a", false);
        assert!(!state.any_ready());
    }
}
