//! Cloud-sync task executor: uploads the dbx sync snapshot (settings +
//! optionally secrets, encrypted per the stored passphrase) to a
//! **files-plugin connection** on a schedule. The transfer rides the files
//! plugin's sidecar surface (`files/write`, `files/mkdir`) over the generic
//! invoke channel — the same one the path picker uses — so the storage is
//! whatever the selected files connection points at (WebDAV, S3, SFTP, …)
//! and the connection's credentials never leave the host process (ADR §10).

use std::sync::Arc;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use serde_json::json;

use super::super::{
    artifacts::TaskArtifact,
    executor::{TaskExecutionContext, TaskExecutionResult, TaskExecutor},
    models::{TaskDefinition, TaskProviderType},
    TaskError,
};
use crate::connection::AppState;
use crate::persistence::cloud_sync::{build_sync_snapshot_with_selection, SyncExportOptions};

pub const CLOUD_SYNC_PROVIDER_ID: &str = "dbx.cloud-sync";

/// Frozen trigger of the builtin provider: one upload shape today.
pub const CLOUD_SYNC_TRIGGER_ID: &str = "upload";

/// Snapshot file name inside `remoteDir`. Stable by design: every run
/// overwrites the same object, mirroring the single-remote snapshot the
/// settings-side sync always wrote.
pub const SNAPSHOT_FILE_NAME: &str = "dbx-sync.json";

/// The task's provider settings. Mirrors the settings-side snapshot sync,
/// minus anything secret: the files connection carries its own credentials
/// (resolved server-side from the stored connection), and the sync-secrets
/// passphrase is resolved from the host store at run time (ADR §10).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
#[derive(Default)]
pub struct CloudSyncTaskConfig {
    /// The files-plugin connection the snapshot is written through. Required.
    #[serde(default)]
    pub files_connection_id: String,
    /// Target directory on that connection. Required; created on demand.
    #[serde(default)]
    pub remote_dir: String,
    pub include_secrets: bool,
    /// Accepted for forward compatibility; the selection is taken from the
    /// saved snapshot-backup selection at run time so the task follows what
    /// the user configured in settings.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub selection: Option<crate::persistence::cloud_sync::SyncSelection>,
    /// Editor settings blob synced along with the snapshot, as the settings
    /// side passes them today.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub editor_settings: Option<serde_json::Value>,
}

impl CloudSyncTaskConfig {
    fn from_task(task: &TaskDefinition) -> Result<Self, TaskError> {
        serde_json::from_value(
            serde_json::to_value(&task.config).map_err(|error| TaskError::invalid_config(error.to_string()))?,
        )
        .map_err(|error| TaskError::invalid_config(format!("Invalid cloud-sync task config: {error}")))
    }

    /// `<dir>/dbx-sync.json` with the trailing slash normalized away.
    fn snapshot_path(&self) -> String {
        let dir = self.remote_dir.trim().trim_end_matches('/');
        format!("{dir}/{SNAPSHOT_FILE_NAME}")
    }
}

pub struct CloudSyncTaskExecutor {
    state: Arc<AppState>,
}

impl CloudSyncTaskExecutor {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    /// Resolves the configured files connection. The connection decides the
    /// owning plugin (its sidecar serves `files/*`), so nothing here may
    /// hardcode a plugin id.
    /// Returns `(owning plugin id, display name)` of the configured files
    /// connection.
    async fn resolve_connection(&self, config: &CloudSyncTaskConfig) -> Result<(String, String), TaskError> {
        let connection_id = config.files_connection_id.trim();
        if connection_id.is_empty() {
            return Err(TaskError::invalid_config("The cloud-sync task needs a files connection."));
        }
        if config.remote_dir.trim().is_empty() {
            return Err(TaskError::invalid_config("The cloud-sync task needs a storage directory."));
        }
        self.state
            .storage
            .load_connections()
            .await
            .map_err(|error| TaskError::unavailable(format!("Cannot read stored connections: {error}")))?
            .into_iter()
            .find(|connection| connection.id == connection_id)
            .filter(|connection| !connection.plugin_id.as_deref().unwrap_or_default().trim().is_empty())
            .map(|connection| (connection.plugin_id.clone().unwrap_or_default(), connection.name))
            .ok_or_else(|| TaskError::connection_missing(format!("Connection {connection_id} was not found")))
    }

    async fn build_snapshot_bytes(&self, config: &CloudSyncTaskConfig) -> Result<Vec<u8>, TaskError> {
        let passphrase = crate::persistence::cloud_sync::resolve_webdav_sync_secrets_passphrase(&self.state.storage)
            .await
            .unwrap_or(None);
        let snapshot = build_sync_snapshot_with_selection(
            &self.state.storage,
            env!("CARGO_PKG_VERSION"),
            config.editor_settings.clone(),
            SyncExportOptions {
                include_secrets: config.include_secrets,
                sync_passphrase: passphrase.as_deref(),
                include_ai_secrets: config.include_secrets,
                include_tunnel_secrets: config.include_secrets,
                include_plugin_secrets: config.include_secrets,
            },
            config.selection.as_ref(),
            Some(&self.state.plugins),
        )
        .await
        .map_err(TaskError::unavailable)?;
        serde_json::to_vec(&snapshot)
            .map_err(|error| TaskError::invalid_config(format!("Cannot serialize snapshot: {error}")))
    }

    async fn invoke_files(
        &self,
        plugin_id: &str,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, TaskError> {
        self.state
            .plugin_host
            .invoke(plugin_id, method, params, None, Some(std::time::Duration::from_secs(300)))
            .await
            .map_err(TaskError::unavailable)
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
        self.resolve_connection(&config).await?;
        Ok(())
    }

    async fn execute(&self, context: TaskExecutionContext) -> Result<TaskExecutionResult, TaskError> {
        let task = context.task.clone();
        let config = CloudSyncTaskConfig::from_task(&task)?;
        let (plugin_id, connection_name) = self.resolve_connection(&config).await?;
        let connection_id = config.files_connection_id.trim().to_owned();
        let mut logger = context.logger.clone();
        let _ = logger.system(&format!(
            "Uploading config snapshot to {} → {}/{}",
            connection_name,
            config.remote_dir.trim(),
            super::super::providers::cloud_sync::SNAPSHOT_FILE_NAME
        ));

        let outcome = tokio::select! {
            _ = context.cancellation.cancelled() => {
                let _ = logger.system("Sync cancelled before the upload finished");
                return Err(TaskError::new(crate::scheduler::TaskErrorKind::Retryable, "timeout", "Sync cancelled"));
            }
            outcome = async {
                // Hydrate the connection server-side (secrets stay in this
                // process); the sidecar's binding registry then serves the
                // write by connection id alone.
                self.state
                    .get_or_create_pool(&connection_id, None)
                    .await
                    .map_err(|error| TaskError::connection_missing(format!("Cannot open connection {connection_id}: {error}")))?;
                let bytes = self.build_snapshot_bytes(&config).await?;
                // Best effort: an existing directory makes mkdir fail — the
                // write below is the real gate.
                let _ = self
                    .invoke_files(&plugin_id, "files/mkdir", json!({ "connectionId": connection_id, "path": config.remote_dir.trim() }))
                    .await;
                self.invoke_files(
                    &plugin_id,
                    "files/write",
                    json!({
                        "connectionId": connection_id,
                        "path": config.snapshot_path(),
                        "dataBase64": BASE64.encode(bytes),
                    }),
                )
                .await
            } => outcome,
        };
        outcome?;

        let line = format!(
            "Snapshot uploaded: {}/{}",
            config.remote_dir.trim(),
            super::super::providers::cloud_sync::SNAPSHOT_FILE_NAME
        );
        let _ = logger.system(&line);
        Ok(TaskExecutionResult {
            success: true,
            exit_code: None,
            message: Some(line),
            artifacts: Vec::<TaskArtifact>::new(),
        })
    }
}
