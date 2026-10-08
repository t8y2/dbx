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
    models::{TaskDefinition, TaskProviderType, TaskTarget},
    TaskError,
};
use crate::connection::{AppState, PoolKind};

/// Resolves the provider-local trigger id a plugin RPC expects.
///
/// The task's trigger identity is the full `<providerId>/<triggerId>` (ADR
/// §2.2, stored in `config.__triggerId` for multi-trigger providers), while a
/// manifest declares trigger `id`s local to the provider — `task/validate` and
/// `task/execute` match against those. Sending the full id made every
/// multi-trigger provider reject with "does not declare trigger". Providers
/// that never stored a key keep the legacy fallback (trigger id = provider
/// id).
fn local_trigger_id(task: &TaskDefinition) -> String {
    let stored = task.config.get("__triggerId").and_then(|value| value.as_str()).unwrap_or("");
    if stored.is_empty() {
        return task.provider_id.clone();
    }
    stored.strip_prefix(&format!("{}/", task.provider_id)).unwrap_or(stored).to_owned()
}

/// One dispatch slot per run: the primary connection first, then the extra
/// ids of a provider that declares `allow_multiple_connections`. The plugin
/// contract hands one `connectionId` per `task/execute`, so the host — not
/// the plugin — walks the list. `None` marks a connection-less provider; it
/// still gets exactly one dispatch. Empty ids and duplicates collapse away.
fn dispatch_targets(target: &TaskTarget, allows_multiple_connections: bool) -> Vec<Option<String>> {
    let mut slots: Vec<Option<String>> = Vec::new();
    if let Some(primary) = target.connection_id.as_deref().filter(|id| !id.trim().is_empty()) {
        slots.push(Some(primary.to_owned()));
    }
    if allows_multiple_connections {
        for id in &target.additional_connection_ids {
            let listed = slots.iter().any(|slot| slot.as_deref() == Some(id.as_str()));
            if !id.trim().is_empty() && !listed {
                slots.push(Some(id.clone()));
            }
        }
    }
    if slots.is_empty() {
        slots.push(None);
    }
    slots
}

/// Folds per-connection `task/execute` outcomes into the single run result the
/// engine consumes. One connection passes through untouched; a batch names
/// every failed connection in the summary. Dispatch errors (transport,
/// missing connection) abort the batch in `execute` before this runs — only
/// provider-reported failures (`success: false`) continue a batch.
fn combine_results(
    results: Vec<(Option<String>, dbx_plugin_runtime::plugins::PluginTaskExecuteResult)>,
) -> TaskExecutionResult {
    fn to_artifacts(artifacts: Vec<dbx_plugin_runtime::plugins::PluginTaskArtifact>) -> Vec<TaskArtifact> {
        artifacts
            .into_iter()
            .map(|artifact| TaskArtifact {
                name: artifact.name,
                uri: artifact.uri,
                content_type: None,
                size: artifact.size,
                checksum: None,
            })
            .collect()
    }
    if results.len() <= 1 {
        let (_, result) = results.into_iter().next().unwrap_or_else(|| {
            (
                None,
                dbx_plugin_runtime::plugins::PluginTaskExecuteResult {
                    success: false,
                    exit_code: None,
                    message: None,
                    artifacts: Vec::new(),
                },
            )
        });
        return TaskExecutionResult {
            success: result.success,
            exit_code: result.exit_code,
            message: result.message,
            artifacts: to_artifacts(result.artifacts),
        };
    }
    let total = results.len();
    let succeeded = results.iter().filter(|(_, result)| result.success).count();
    let success = succeeded == total;
    // The first non-zero exit code wins; a clean batch keeps the last code.
    let exit_code = results
        .iter()
        .find_map(|(_, result)| result.exit_code.filter(|code| *code != 0))
        .or_else(|| results.iter().rev().find_map(|(_, result)| result.exit_code));
    let message = if success {
        Some(format!("All {total} connections succeeded"))
    } else {
        let mut parts = vec![format!("{succeeded}/{total} connections succeeded")];
        for (connection, result) in &results {
            if result.success {
                continue;
            }
            let label = connection.clone().unwrap_or_else(|| "connection".to_owned());
            let detail: String = result.message.as_deref().unwrap_or("failed").chars().take(200).collect();
            parts.push(format!("{label}: {detail}"));
        }
        Some(parts.join("; "))
    };
    TaskExecutionResult {
        success,
        exit_code,
        message,
        artifacts: results.into_iter().flat_map(|(_, result)| to_artifacts(result.artifacts)).collect(),
    }
}

/// Connection ids a task's config references through the host-reserved
/// `options_action: "host/connections"` marker: that marker means the
/// select's options ARE host connections, so a non-empty config value names
/// one (or a plugin-reserved alias like the files tasks' `local`). The
/// executor must open every referenced connection before dispatch — the task
/// target alone misses config-level sides (e.g. a copy's destination).
fn config_connection_keys(
    contribution: Option<&dbx_plugin_runtime::plugins::PluginTaskProviderContribution>,
    trigger_id: &str,
) -> Vec<String> {
    let Some(contribution) = contribution else { return Vec::new() };
    contribution
        .triggers
        .iter()
        .find(|trigger| trigger.id == trigger_id)
        .map(|trigger| {
            trigger
                .fields
                .iter()
                .filter(|field| field.options_action.as_deref() == Some("host/connections"))
                .map(|field| field.key.clone())
                .collect()
        })
        .unwrap_or_default()
}

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

    async fn ensure_connection(&self, connection_id: Option<&str>) -> Result<Option<serde_json::Value>, TaskError> {
        let Some(connection_id) = connection_id.filter(|id| !id.trim().is_empty()) else {
            return Ok(None);
        };
        // A stored connection opens server-side (config hydrated, secrets stay
        // in this process). An id the host does not store is a plugin-reserved
        // alias (e.g. the files tasks' `local` plain-path side): forwarded
        // as-is with no lifecycle params — the plugin's binding either
        // synthesizes the connection or rejects the id, and no host state is
        // consulted or leaked either way.
        let stored = self
            .state
            .storage
            .load_connections()
            .await
            .map_err(|error| TaskError::connection_missing(format!("Cannot read stored connections: {error}")))?
            .iter()
            .any(|config| config.id == connection_id);
        if !stored {
            return Ok(None);
        }
        self.state.get_or_create_pool(connection_id, None).await.map_err(|error| {
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
        connection_id: Option<String>,
        config: serde_json::Value,
        runtime: Option<serde_json::Value>,
    ) -> Result<dbx_plugin_runtime::plugins::PluginTaskRunRequest, TaskError> {
        use dbx_plugin_runtime::plugins::{PluginTaskRunRef, PluginTaskRunRequest, PluginTaskRunTask};
        let trigger_id = local_trigger_id(task);
        Ok(PluginTaskRunRequest {
            task: PluginTaskRunTask {
                task_id: task.id.clone(),
                run_id: context.run.id.clone(),
                trigger_id,
                connection_id,
                config_version: task.config_version.max(1) as u32,
                config,
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
        let contribution = self
            .state
            .plugin_host
            .resolve_task_provider(&plugin_id, &provider_id)
            .map_err(|error| TaskError::provider_not_found(error))?;
        // Every bound connection must open, not just the primary one.
        for connection_id in dispatch_targets(&task.target, contribution.allow_multiple_connections) {
            self.ensure_connection(connection_id.as_deref()).await?;
        }
        // Config-referenced sides too (the files tasks' source/destination
        // select fields): a dead destination should fail at save, not at run.
        for key in config_connection_keys(Some(&contribution), &local_trigger_id(task)) {
            let Some(connection_id) =
                task.config.get(&key).and_then(serde_json::Value::as_str).filter(|id| !id.trim().is_empty())
            else {
                continue;
            };
            self.ensure_connection(Some(connection_id)).await?;
        }
        Ok(())
    }

    async fn execute(&self, context: TaskExecutionContext) -> Result<TaskExecutionResult, TaskError> {
        let task = context.task.clone();
        let (plugin_id, provider_id) = Self::split_provider(&task)?;
        let mut logger = context.logger.clone();
        let contribution = self.state.plugin_host.resolve_task_provider(&plugin_id, &provider_id).ok();
        let allows_multiple = contribution.as_ref().map(|entry| entry.allow_multiple_connections).unwrap_or(false);
        let slots = dispatch_targets(&task.target, allows_multiple);
        if contribution.is_some() && !allows_multiple && !task.target.additional_connection_ids.is_empty() {
            let _ = logger.system(&format!(
                "Ignoring {} additional connection(s): the provider allows a single connection",
                task.target.additional_connection_ids.len()
            ));
        }
        let timeout = task
            .execution
            .timeout_seconds
            .filter(|seconds| *seconds > 0)
            .map(|seconds| Duration::from_secs(seconds))
            .unwrap_or(DEFAULT_TASK_TIMEOUT);
        // Serialize once: a config that cannot serialize must fail before the
        // event pump below is spawned (its `?` could not abort the pump).
        let config =
            serde_json::to_value(&task.config).map_err(|error| TaskError::invalid_config(error.to_string()))?;
        // Config-level sides (e.g. a copy's destination connection) never
        // appear in the dispatch slots: open them here so the plugin's engine
        // holds every binding the task references. Stored ids open their pool,
        // plugin-reserved aliases pass through, and both reuse pools.
        for key in config_connection_keys(contribution.as_ref(), &local_trigger_id(&task)) {
            let Some(id) = task.config.get(&key).and_then(serde_json::Value::as_str).filter(|id| !id.trim().is_empty())
            else {
                continue;
            };
            self.ensure_connection(Some(id)).await?;
        }

        // Stream the plugin's fixed task events into this run's logger and
        // progress store: command output arrives as task/log events on the
        // host's plugin event bus, and without this pump the run log only ever
        // contains the dispatch/finish system lines. The pump ends when the
        // invoke settles and its receiver is dropped (aborted below).
        let mut task_events = self.state.plugin_host.subscribe_events();
        let pump_plugin_id = plugin_id.clone();
        let pump_task_id = task.id.clone();
        let pump_run_id = context.run.id.clone();
        let mut pump_logger = logger.clone();
        let progress = context.progress.clone();
        let pump = tokio::spawn(async move {
            loop {
                match task_events.recv().await {
                    Ok(event) if event.plugin_id == pump_plugin_id && event.method == "task/log" => {
                        let Ok(decoded) = dbx_plugin_runtime::plugins::decode_task_event(&event.method, &event.params)
                        else {
                            continue;
                        };
                        let dbx_plugin_runtime::plugins::PluginTaskEvent::Log(log) = decoded else { continue };
                        if log.task_id != pump_task_id || log.run_id != pump_run_id {
                            continue;
                        }
                        let stream = match log.stream {
                            dbx_plugin_runtime::plugins::PluginTaskStream::Stdout => "stdout",
                            dbx_plugin_runtime::plugins::PluginTaskStream::Stderr => "stderr",
                        };
                        let level = match log.level {
                            dbx_plugin_runtime::plugins::PluginTaskLogLevel::Debug => "debug",
                            dbx_plugin_runtime::plugins::PluginTaskLogLevel::Info => "info",
                            dbx_plugin_runtime::plugins::PluginTaskLogLevel::Warn => "warn",
                            dbx_plugin_runtime::plugins::PluginTaskLogLevel::Error => "error",
                        };
                        let _ = pump_logger.append(level, stream, &log.message);
                    }
                    Ok(event) if event.plugin_id == pump_plugin_id && event.method == "task/progress" => {
                        let Ok(decoded) = dbx_plugin_runtime::plugins::decode_task_event(&event.method, &event.params)
                        else {
                            continue;
                        };
                        let dbx_plugin_runtime::plugins::PluginTaskEvent::Progress(progress_event) = decoded else {
                            continue;
                        };
                        if progress_event.task_id != pump_task_id || progress_event.run_id != pump_run_id {
                            continue;
                        }
                        // The event's `current` is a human-readable label
                        // ("3 of 10 files"); TaskProgress.current is a count.
                        let _ = progress
                            .report(crate::scheduler::executor::TaskProgress {
                                percent: Some(progress_event.percent),
                                current: None,
                                total: progress_event.total,
                                label: progress_event.current,
                            })
                            .await;
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return,
                }
            }
        });

        // Walk every bound connection; the plugin answers one connection per
        // dispatch, so a multi-connection run is N dispatches under one run id.
        // A transport-level error aborts the remaining connections, a
        // provider-reported failure does not (combine_results names it).
        let total_slots = slots.len();
        let mut results = Vec::with_capacity(total_slots);
        for (index, connection_id) in slots.into_iter().enumerate() {
            // Every fallible step from here must abort the pump first: the
            // pump only ends when `execute` returns or aborts it.
            let runtime = match self.ensure_connection(connection_id.as_deref()).await {
                Ok(runtime) => runtime,
                Err(error) => {
                    pump.abort();
                    return Err(error);
                }
            };
            let request = Self::run_request(&task, &context, connection_id.clone(), config.clone(), runtime)?;
            let dispatch_line = match (&connection_id, total_slots > 1) {
                (Some(id), true) => {
                    format!(
                        "Dispatching task/execute to {plugin_id}/{provider_id} (connection {}/{}: {id})",
                        index + 1,
                        total_slots
                    )
                }
                _ => format!("Dispatching task/execute to {plugin_id}/{provider_id}"),
            };
            let _ = logger.system(&dispatch_line);
            let outcome = tokio::select! {
                _ = context.cancellation.cancelled() => {
                    pump.abort();
                    let _ = logger.system("Run cancelled before the plugin answered");
                    return Err(TaskError::new(crate::scheduler::TaskErrorKind::Retryable, "timeout", "Run cancelled"));
                }
                outcome = self.state.plugin_host.execute_task(&plugin_id, &provider_id, request, Some(timeout)) => outcome,
            }
            .map_err(|error| {
                pump.abort();
                TaskError::invalid_config(error)
            })?;
            results.push((connection_id, outcome));
        }
        pump.abort();

        let result = combine_results(results);
        let status_line = match (&result.message, result.success) {
            (Some(message), true) => format!("Run succeeded: {message}"),
            (Some(message), false) => format!("Run failed: {message}"),
            (None, true) => "Run succeeded".to_owned(),
            (None, false) => "Run failed".to_owned(),
        };
        let _ = logger.append(if result.success { "info" } else { "error" }, "stdout", &status_line);

        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::{combine_results, config_connection_keys, dispatch_targets, local_trigger_id, PluginTaskExecutor};
    use crate::scheduler::models::{TaskDefinition, TaskTarget};
    use dbx_plugin_runtime::plugins::{PluginTaskExecuteResult, PluginTaskProviderContribution};
    use std::sync::Arc;

    fn task_with_config(provider_id: &str, config: serde_json::Value) -> TaskDefinition {
        serde_json::from_value(serde_json::json!({
            "id": "task-1",
            "name": "t",
            "providerType": "plugin",
            "providerId": provider_id,
            "trigger": { "type": "manual" },
            "execution": { "mode": "run", "concurrency": "forbid", "misfire": "coalesce", "retry": { "maxAttempts": 1, "backoffSeconds": 0, "strategy": "fixed" } },
            "target": {},
            "configVersion": 1,
            "config": config,
            "enabled": false,
            "createdAt": "2026-10-06T00:00:00Z",
            "updatedAt": "2026-10-06T00:00:00Z",
            "version": 1
        }))
        .expect("task json")
    }

    fn target(primary: Option<&str>, additional: &[&str]) -> TaskTarget {
        TaskTarget {
            connection_id: primary.map(str::to_owned),
            additional_connection_ids: additional.iter().map(|id| id.to_string()).collect(),
            ..TaskTarget::default()
        }
    }

    fn executed(success: bool, exit_code: Option<i32>, message: Option<&str>) -> PluginTaskExecuteResult {
        serde_json::from_value(serde_json::json!({
            "success": success,
            "exitCode": exit_code,
            "message": message,
        }))
        .expect("execute result json")
    }

    #[test]
    fn strips_the_provider_prefix_from_the_stored_trigger_identity() {
        let task =
            task_with_config("io.dbx.ssh.tasks", serde_json::json!({ "__triggerId": "io.dbx.ssh.tasks/execute" }));
        assert_eq!(local_trigger_id(&task), "execute");
    }

    #[test]
    fn falls_back_to_the_provider_id_when_no_trigger_was_stored() {
        let task = task_with_config("io.dbx.ssh.tasks", serde_json::json!({}));
        assert_eq!(local_trigger_id(&task), "io.dbx.ssh.tasks");
    }

    #[test]
    fn keeps_an_already_local_trigger_id() {
        let task = task_with_config("io.dbx.ssh.tasks", serde_json::json!({ "__triggerId": "execute" }));
        assert_eq!(local_trigger_id(&task), "execute");
    }

    #[test]
    fn task_target_defaults_stay_valid() {
        let task = task_with_config("io.dbx.ssh.tasks", serde_json::json!({}));
        assert_eq!(task.target, TaskTarget::default());
    }

    #[tokio::test]
    async fn plugin_reserved_connection_aliases_pass_through_without_a_pool() {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
        let executor = PluginTaskExecutor::new(Arc::new(crate::connection::AppState::new(storage)));
        // The files tasks' reserved `local` side is not a stored connection:
        // it forwards to the plugin with no lifecycle params instead of
        // failing with connection_missing (the plugin's binding synthesizes
        // the local filesystem side itself).
        assert!(executor.ensure_connection(Some("local")).await.unwrap().is_none());
        assert!(executor.ensure_connection(None).await.unwrap().is_none());
        assert!(executor.ensure_connection(Some("   ")).await.unwrap().is_none());
    }

    fn files_like_provider() -> PluginTaskProviderContribution {
        serde_json::from_value(serde_json::json!({
            "id": "io.dbx.files.tasks",
            "label": "Files Tasks",
            "connection_providers": [],
            "allow_multiple_connections": true,
            "capabilities": ["run"],
            "triggers": [{
                "id": "copy",
                "label": "Copy",
                "mode": "run",
                "fields": [
                    { "key": "source_connection_id", "label": "Source", "type": "text", "options_action": "host/connections" },
                    { "key": "source_path", "label": "Source path", "type": "text" },
                    { "key": "destination_connection_id", "label": "Destination", "type": "text", "options_action": "host/connections" }
                ]
            }]
        }))
        .expect("files-like provider json")
    }

    #[test]
    fn config_connection_keys_follow_the_host_connections_marker() {
        // The marker names exactly the fields whose value is a host connection
        // id (or a plugin-reserved alias); other fields never open pools.
        assert_eq!(
            config_connection_keys(Some(&files_like_provider()), "copy"),
            vec!["source_connection_id".to_string(), "destination_connection_id".to_string()]
        );
        // A different trigger of the same provider has no marker fields here.
        assert!(config_connection_keys(Some(&files_like_provider()), "sync").is_empty());
        // An unresolved provider (uninstalled plugin) contributes nothing: the
        // dispatch itself fails with the provider error right after.
        assert!(config_connection_keys(None, "copy").is_empty());
    }

    #[test]
    fn dispatch_targets_orders_primary_then_additional_without_duplicates() {
        let slots = dispatch_targets(&target(Some("a"), &["b", "a", "", "b", "c"]), true);
        assert_eq!(slots, vec![Some("a".into()), Some("b".into()), Some("c".into())]);
    }

    #[test]
    fn dispatch_targets_drops_additional_ids_for_single_connection_providers() {
        let slots = dispatch_targets(&target(Some("a"), &["b", "c"]), false);
        assert_eq!(slots, vec![Some("a".into())]);
    }

    #[test]
    fn dispatch_targets_keeps_one_connection_less_slot() {
        assert_eq!(dispatch_targets(&target(None, &[]), true), vec![None]);
        assert_eq!(dispatch_targets(&target(Some(""), &[]), false), vec![None]);
    }

    #[test]
    fn combine_results_passes_a_single_connection_through() {
        let combined = combine_results(vec![(Some("a".into()), executed(true, Some(0), Some("done")))]);
        assert!(combined.success);
        assert_eq!(combined.exit_code, Some(0));
        assert_eq!(combined.message.as_deref(), Some("done"));
    }

    #[test]
    fn combine_results_reports_every_failed_connection_of_a_batch() {
        let combined = combine_results(vec![
            (Some("a".into()), executed(true, Some(0), Some("ok"))),
            (Some("b".into()), executed(false, Some(1), Some("command failed"))),
            (Some("c".into()), executed(false, None, None)),
        ]);
        assert!(!combined.success);
        assert_eq!(combined.exit_code, Some(1));
        let message = combined.message.expect("batch summary");
        assert!(message.contains("1/3 connections succeeded"), "{message}");
        assert!(message.contains("b: command failed"), "{message}");
        assert!(message.contains("c: failed"), "{message}");
        assert!(!message.contains("a:"), "{message}");
    }

    #[test]
    fn combine_results_reports_a_fully_successful_batch() {
        let combined = combine_results(vec![
            (Some("a".into()), executed(true, Some(0), None)),
            (Some("b".into()), executed(true, Some(0), Some("done"))),
        ]);
        assert!(combined.success);
        assert_eq!(combined.message.as_deref(), Some("All 2 connections succeeded"));
    }
}
