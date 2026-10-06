//! Cloud-sync task executor (ADR §8 shape): runs the configured WebDAV
//! snapshot upload as a scheduler task, replacing the renderer-side
//! `useWebDavAutoUpload` interval that stopped whenever the window closed.
//! The task config carries the WebDAV connection and the sync selection so
//! the run is fully described by the task, never by UI-local state.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;

use super::super::{
    artifacts::TaskArtifact,
    executor::{TaskExecutionContext, TaskExecutionResult, TaskExecutor},
    models::{TaskDefinition, TaskProviderType},
    TaskError,
};
use crate::connection::AppState;
use crate::persistence::cloud_sync::{
    build_sync_snapshot_with_selection, SyncExportOptions, WebDavClient, WebDavConfig,
};

pub const CLOUD_SYNC_PROVIDER_ID: &str = "dbx.cloud-sync";

/// Frozen trigger of the builtin provider: one upload shape today.
pub const CLOUD_SYNC_TRIGGER_ID: &str = "upload";

/// The task's provider settings. Mirrors what the renderer passes to
/// `webdav_sync_upload`, minus anything secret (the stored WebDAV password and
/// the sync-secrets passphrase are resolved from the host stores at run time,
/// never read from the task config — ADR §10).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CloudSyncTaskConfig {
    #[serde(default = "default_webdav")]
    pub webdav: WebDavConfig,
    pub include_secrets: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<crate::persistence::cloud_sync::SyncSelection>,
    /// Editor settings blob synced along with the snapshot, as the renderer
    /// passes them today.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor_settings: Option<serde_json::Value>,
}

fn default_webdav() -> WebDavConfig {
    WebDavConfig { endpoint: String::new(), username: None, password: None, remote_path: None }
}

impl Default for CloudSyncTaskConfig {
    fn default() -> Self {
        Self { webdav: default_webdav(), include_secrets: false, selection: None, editor_settings: None }
    }
}

impl CloudSyncTaskConfig {
    fn from_task(task: &TaskDefinition) -> Result<Self, TaskError> {
        serde_json::from_value(
            serde_json::to_value(&task.config).map_err(|error| TaskError::invalid_config(error.to_string()))?,
        )
        .map_err(|error| TaskError::invalid_config(format!("Invalid cloud-sync task config: {error}")))
    }
}

pub struct CloudSyncTaskExecutor {
    state: Arc<AppState>,
}

impl CloudSyncTaskExecutor {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    async fn run_upload(
        &self,
        config: &CloudSyncTaskConfig,
        include_secrets: bool,
    ) -> Result<crate::persistence::cloud_sync::WebDavSyncSummary, String> {
        let mut webdav = config.webdav.clone();
        // The password lives in the secret store; resolve it here exactly like
        // the Tauri command does (never from the task config — ADR §10).
        crate::persistence::cloud_sync::resolve_webdav_password(&self.state.storage, &mut webdav).await?;
        let passphrase = crate::persistence::cloud_sync::resolve_webdav_sync_secrets_passphrase(&self.state.storage)
            .await
            .unwrap_or(None);
        let snapshot = build_sync_snapshot_with_selection(
            &self.state.storage,
            env!("CARGO_PKG_VERSION"),
            config.editor_settings.clone(),
            SyncExportOptions {
                include_secrets,
                sync_passphrase: passphrase.as_deref(),
                include_ai_secrets: include_secrets,
                include_tunnel_secrets: include_secrets,
                include_plugin_secrets: include_secrets,
            },
            config.selection.as_ref(),
            Some(&self.state.plugins),
        )
        .await?;
        WebDavClient::new(webdav).put_snapshot(&snapshot).await
    }
}

#[async_trait]
impl TaskExecutor for CloudSyncTaskExecutor {
    async fn validate(&self, task: &TaskDefinition) -> Result<(), TaskError> {
        if task.provider_type != TaskProviderType::Builtin {
            return Err(TaskError::invalid_config(format!(
                "Builtin executor cannot run {:?} provider {}",
                task.provider_type, task.provider_id
            )));
        }
        let config = CloudSyncTaskConfig::from_task(task)?;
        if config.webdav.endpoint.trim().is_empty() {
            return Err(TaskError::invalid_config("The cloud-sync task needs a WebDAV endpoint."));
        }
        Ok(())
    }

    async fn execute(&self, context: TaskExecutionContext) -> Result<TaskExecutionResult, TaskError> {
        let task = context.task.clone();
        let config = CloudSyncTaskConfig::from_task(&task)?;
        let mut logger = context.logger.clone();
        let _ = logger.system(&format!("Uploading snapshot to {}", config.webdav.endpoint));

        let outcome = tokio::select! {
            _ = context.cancellation.cancelled() => {
                let _ = logger.system("Sync cancelled before the upload finished");
                return Err(TaskError::new(crate::scheduler::TaskErrorKind::Retryable, "timeout", "Sync cancelled"));
            }
            outcome = self.run_upload(&config, config.include_secrets) => outcome,
        };
        let summary = outcome.map_err(TaskError::unavailable)?;

        let line = format!("Snapshot uploaded: {} bytes → {}", summary.bytes, summary.remote_path);
        let _ = logger.system(&line);
        Ok(TaskExecutionResult {
            success: true,
            exit_code: None,
            message: Some(line),
            artifacts: Vec::<TaskArtifact>::new(),
        })
    }
}
