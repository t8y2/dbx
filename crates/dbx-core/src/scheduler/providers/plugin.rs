//! Plugin task executor (ADR §22–§36): routes a scheduler run to the plugin
//! that declared the `task-provider` contribution, over the frozen `task/*`
//! RPC contract. One executor instance serves every plugin provider — the
//! provider id in the task definition decides which plugin and contribution
//! handle it, so no per-plugin registration exists anywhere (the
//! "no `if provider == io.dbx.ssh.tasks`" rule, plan §511).
//!
//! Connections: `state.get_or_create_pool` opens (or reuses) the plugin
//! connection exactly like every other host surface; its lifecycle params are
//! injected into the `task/execute` request as `runtime`, so the provider sees
//! the same connection view the rest of the host sees — with secrets already
//! hydrated by `load_connections`.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use super::super::{
    artifacts::TaskArtifact,
    executor::{TaskExecutionContext, TaskExecutionResult, TaskExecutor},
    models::{TaskDefinition, TaskProviderType},
    TaskError,
};
use crate::connection::{AppState, PoolKind};

/// Generous default when the task declares no timeout: `task/execute` may run
/// a long command, but an unattended run still must not hang the engine slot
/// forever.
const DEFAULT_TASK_TIMEOUT: Duration = Duration::from_secs(60 * 60);

pub struct PluginTaskExecutor {
    state: Arc<AppState>,
}

impl PluginTaskExecutor {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    fn split_provider(task: &TaskDefinition) -> Result<(String, String), TaskError> {
        let plugin_id = task
            .target
            .plugin_id
            .clone()
            .or_else(|| {
                task.provider_id
                    .split('.')
                    .next()
                    .map(|first| format!("{first}.{}", task.provider_id.split('.').nth(1).unwrap_or_default()))
            })
            .unwrap_or_default();
        if plugin_id.is_empty() {
            return Err(TaskError::provider_not_found(format!("Task {} does not name its plugin", task.id)));
        }
        Ok((plugin_id, task.provider_id.clone()))
    }

    async fn ensure_connection(&self, task: &TaskDefinition) -> Result<Option<serde_json::Value>, TaskError> {
        let Some(connection_id) = task.target.connection_id.clone().filter(|id| !id.is_empty()) else {
            return Ok(None);
        };
        self.state.get_or_create_pool(&connection_id, None).await.map_err(|error| {
            TaskError::connection_missing(format!("Cannot open connection {connection_id}: {error}"))
        })?;
        let lifecycle = self
            .state
            .with_connection_pools(|pools| {
                pools.values().find_map(|pool| match pool {
                    PoolKind::PluginConnection(handle)
                        if handle.connection_id == connection_id && handle.is_running() =>
                    {
                        Some(handle.lifecycle_params().clone())
                    }
                    _ => None,
                })
            })
            .await;
        Ok(lifecycle)
    }

    fn run_request(
        task: &TaskDefinition,
        context: &TaskExecutionContext,
        runtime: Option<serde_json::Value>,
    ) -> Result<dbx_plugin_runtime::plugins::PluginTaskRunRequest, TaskError> {
        use dbx_plugin_runtime::plugins::{PluginTaskRunRef, PluginTaskRunRequest, PluginTaskRunTask};
        let trigger_id = task
            .config
            .get("__triggerId")
            .and_then(|value| value.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| task.provider_id.clone());
        Ok(PluginTaskRunRequest {
            task: PluginTaskRunTask {
                task_id: task.id.clone(),
                run_id: context.run.id.clone(),
                trigger_id,
                connection_id: task.target.connection_id.clone(),
                config_version: task.config_version.max(1) as u32,
                config: serde_json::to_value(&task.config)
                    .map_err(|error| TaskError::invalid_config(error.to_string()))?,
            },
            run: PluginTaskRunRef { run_id: context.run.id.clone(), attempt: context.run.attempt.max(1) as u64 },
            connection: None,
            runtime,
        })
    }
}

#[async_trait]
impl TaskExecutor for PluginTaskExecutor {
    async fn validate(&self, task: &TaskDefinition) -> Result<(), TaskError> {
        if task.provider_type != TaskProviderType::Plugin {
            return Err(TaskError::invalid_config(format!(
                "Plugin executor cannot run {:?} provider {}",
                task.provider_type, task.provider_id
            )));
        }
        let (plugin_id, provider_id) = Self::split_provider(task)?;
        // resolve_task_provider rejects uninstalled / incompatible plugins and
        // undeclared providers, which is exactly the validate contract.
        self.state
            .plugin_host
            .resolve_task_provider(&plugin_id, &provider_id)
            .map_err(|error| TaskError::provider_not_found(error))?;
        // Optionally ask the provider itself (task/validate) — failures there
        // are config problems, surfaced with their own message.
        let _ = self.ensure_connection(task).await?;
        Ok(())
    }

    async fn execute(&self, context: TaskExecutionContext) -> Result<TaskExecutionResult, TaskError> {
        let task = context.task.clone();
        let (plugin_id, provider_id) = Self::split_provider(&task)?;
        let runtime = self.ensure_connection(&task).await?;
        let request = Self::run_request(&task, &context, runtime)?;
        let timeout = task
            .execution
            .timeout_seconds
            .filter(|seconds| *seconds > 0)
            .map(|seconds| Duration::from_secs(seconds))
            .unwrap_or(DEFAULT_TASK_TIMEOUT);

        let mut logger = context.logger.clone();
        let _ = logger.system(&format!("Dispatching task/execute to {plugin_id}/{provider_id}"));
        let result = tokio::select! {
            _ = context.cancellation.cancelled() => {
                let _ = logger.system("Run cancelled before the plugin answered");
                return Err(TaskError::new(crate::scheduler::TaskErrorKind::Retryable, "timeout", "Run cancelled"));
            }
            outcome = self.state.plugin_host.execute_task(&plugin_id, &provider_id, request, Some(timeout)) => outcome,
        }
        .map_err(|error| TaskError::invalid_config(error))?;

        let status_line = match (&result.message, result.success) {
            (Some(message), true) => format!("Run succeeded: {message}"),
            (Some(message), false) => format!("Run failed: {message}"),
            (None, true) => "Run succeeded".to_owned(),
            (None, false) => "Run failed".to_owned(),
        };
        let _ = logger.append(if result.success { "info" } else { "error" }, "stdout", &status_line);

        Ok(TaskExecutionResult {
            success: result.success,
            exit_code: result.exit_code,
            message: result.message,
            artifacts: result
                .artifacts
                .into_iter()
                .map(|artifact| TaskArtifact {
                    name: artifact.name,
                    uri: artifact.uri,
                    content_type: None,
                    size: artifact.size,
                    checksum: None,
                })
                .collect(),
        })
    }
}
