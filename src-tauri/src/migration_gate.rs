use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub struct MigrationGate {
    ready: AtomicBool,
    changed: tokio::sync::Notify,
}
impl MigrationGate {
    pub fn new(ready: bool) -> Self {
        Self { ready: AtomicBool::new(ready), changed: tokio::sync::Notify::new() }
    }
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }
    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::Release);
        self.changed.notify_waiters();
    }
    pub async fn wait(&self) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_ready() {
                return;
            }
            notified.await;
        }
    }
}
pub fn allowed_command(command: &str) -> bool {
    matches!(
        command,
        "migration_status"
            | "migration_start"
            | "migration_retry"
            | "migration_cleanup_backups"
            | "mark_frontend_ready"
            | "show_main_window"
            | "quit_app"
            | "confirm_exit"
            | "complete_app_close"
            | "reveal_path_in_file_manager"
            | "get_platform"
            | "set_app_locale"
    )
}
/// Wrap the actual invoke dispatcher so direct IPC calls cannot bypass the startup UI.
/// Missing state is denied as well: no business command can run before setup completes.
pub fn guard_handler<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let ready = invoke.message.state_ref().try_get::<Arc<MigrationGate>>().is_some_and(|gate| gate.is_ready());
        if !ready && !allowed_command(invoke.message.command()) {
            invoke.resolver.reject("DATA_MIGRATION_REQUIRED");
            return true;
        }
        handler(invoke)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gate_denies_business_commands() {
        for command in ["load_connections", "webdav_sync_upload", "load_ai_config", "plugin_invoke", "migration_fake"] {
            assert!(!allowed_command(command));
        }
        assert!(allowed_command("migration_start"));
        assert!(allowed_command("reveal_path_in_file_manager"));
    }
    #[test]
    fn invoke_dispatch_rejects_business_commands_until_ready() {
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets};
        let gate = Arc::new(MigrationGate::new(false));
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let command_calls = calls.clone();
        let app = mock_builder()
            .manage(gate.clone())
            .invoke_handler(guard_handler(move |invoke| {
                command_calls.fetch_add(1, Ordering::SeqCst);
                invoke.resolver.resolve("dispatched");
                true
            }))
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let request = |command: &str| tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
            body: tauri::ipc::InvokeBody::default(),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        };
        for command in ["load_connections", "plugin_invoke", "webdav_sync_upload"] {
            assert_eq!(
                get_ipc_response(&webview, request(command)).unwrap_err(),
                serde_json::json!("DATA_MIGRATION_REQUIRED")
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(get_ipc_response(&webview, request("migration_status")).is_ok());
        // Cleanup is guarded by the storage layer (it only succeeds after a
        // successful migration), so the startup gate must allow the command
        // through while the wizard is still visible.
        assert!(get_ipc_response(&webview, request("migration_cleanup_backups")).is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        gate.set_ready(true);
        assert!(get_ipc_response(&webview, request("load_connections")).is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }
    #[tokio::test]
    async fn wait_releases_only_after_ready() {
        let gate = MigrationGate::new(false);
        assert!(!gate.is_ready());
        gate.set_ready(true);
        gate.wait().await;
    }
}
