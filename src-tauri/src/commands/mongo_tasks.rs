use std::{path::Path, sync::Arc, time::Duration};
use dbx_core::{connection::AppState, mongo_tasks::{MongoTaskCommand, MongoTaskService}};
use tokio_util::sync::CancellationToken;

pub struct MongoTasksState {
    service: MongoTaskService,
    stop: CancellationToken,
    worker: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl MongoTasksState {
    /// Runs on the backend runtime, regardless of which UI dialogs are open.
    pub fn new(state: Arc<AppState>, data_dir: &Path) -> Self {
        let service = MongoTaskService::new(state, data_dir);
        let stop = CancellationToken::new();
        let worker = service.start(stop.clone());
        Self { service, stop, worker: tokio::sync::Mutex::new(Some(worker)) }
    }
    pub async fn shutdown(&self) {
        self.stop.cancel();
        if let Some(worker) = self.worker.lock().await.take() {
            if tokio::time::timeout(Duration::from_secs(5), worker).await.is_err() { log::warn!("[mongo-tasks] worker shutdown timed out; recovery will mark any unfinished run interrupted"); }
        }
    }
}

#[tauri::command]
pub async fn mongo_task_command(state: tauri::State<'_, MongoTasksState>, command: MongoTaskCommand) -> Result<serde_json::Value, String> {
    state.service.command(command).await
}
