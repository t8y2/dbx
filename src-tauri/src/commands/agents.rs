use std::sync::Arc;

use tauri::{Emitter, State};

use dbx_core::agent_manager::{AgentDriverInfo, DriverStoreUsage, JavaRuntimeConfig, JavaRuntimeMode, DEFAULT_JRE_KEY};
use dbx_core::agent_offline_export::{
    export_agents_offline as export_agents_offline_core,
    preview_agent_offline_export as preview_agent_offline_export_core, AgentOfflineExportPreview,
    AgentOfflineExportResult,
};
use dbx_core::agent_service::{
    batch_cancellation_key, build_agent_list, cancel_agent_batch_upgrade, cancel_agent_driver_install,
    clear_agent_download_cache, fetch_registry_from, fetch_registry_from_claimed, import_agent_driver,
    import_agents_from_package as import_agents_from_package_core, inspect_offline_package,
    install_agent_driver_from_claimed, install_cancellation_key, invalidate_registry_cache, reinstall_agent_jre_from,
    uninstall_agent_driver, uninstall_agent_jre, upgrade_all_agent_drivers_from_claimed, AgentProgressEvent,
    OfflineImportPlan, UpgradeAllAgentDriversResult,
};
use dbx_core::connection::AppState;
use dbx_core::driver_runtime::DriverRuntimeSummary;
use dbx_core::DownloadSource;

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentUpdateBlocker {
    pub db_type: String,
    pub label: String,
}

#[tauri::command]
pub async fn list_installed_agents_local(state: State<'_, Arc<AppState>>) -> Result<Vec<AgentDriverInfo>, String> {
    Ok(build_agent_list(&state.agent_manager, None))
}

#[tauri::command]
pub async fn list_installed_agents(
    state: State<'_, Arc<AppState>>,
    source: Option<DownloadSource>,
) -> Result<Vec<AgentDriverInfo>, String> {
    let registry = fetch_registry_from(source.unwrap_or_default()).await.ok();
    Ok(build_agent_list(&state.agent_manager, registry.as_ref()))
}

#[tauri::command]
pub async fn is_agent_installed(state: State<'_, Arc<AppState>>, db_type: String) -> Result<bool, String> {
    Ok(state.agent_manager.is_driver_installed(&db_type))
}

#[tauri::command]
pub async fn get_driver_store_usage(state: State<'_, Arc<AppState>>) -> Result<DriverStoreUsage, String> {
    Ok(state.agent_manager.collect_driver_store_usage(state.plugins.root_dir()))
}

#[tauri::command]
pub async fn clear_driver_download_cache(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    clear_agent_download_cache(&state.agent_manager)
}

#[tauri::command]
pub async fn get_driver_runtime_summary(state: State<'_, Arc<AppState>>) -> Result<DriverRuntimeSummary, String> {
    Ok(dbx_core::driver_runtime::collect_driver_runtime_summary(state.inner().as_ref()).await)
}

#[tauri::command]
pub async fn stop_driver_runtime(state: State<'_, Arc<AppState>>, runtime_id: String) -> Result<(), String> {
    dbx_core::driver_runtime::stop_driver_runtime(state.inner().as_ref(), &runtime_id).await
}

#[tauri::command]
pub async fn restart_driver_runtime(state: State<'_, Arc<AppState>>, runtime_id: String) -> Result<(), String> {
    dbx_core::driver_runtime::restart_driver_runtime(state.inner().as_ref(), &runtime_id).await
}

#[tauri::command]
pub async fn install_agent(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    db_type: String,
    source: Option<DownloadSource>,
    operation_id: Option<String>,
) -> Result<(), String> {
    // Resolve the operation id first, then register the cancellation token
    // under it BEFORE any awaitable setup (blocker check, lock wait, registry
    // fetch) so a cancel fired while the UI shows the modal is observed by this
    // exact install instead of being silently lost or crossing into a second
    // same-driver install.
    let operation_id = operation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let cancellation = state.agent_manager.begin_install_cancellation(&install_cancellation_key(&operation_id)).await;
    let result = async {
        ensure_no_agent_update_blockers(state.inner().as_ref(), std::slice::from_ref(&db_type)).await?;
        let app_handle = app.clone();
        let progress_operation_id = operation_id.clone();
        install_agent_driver_from_claimed(
            &state.agent_manager,
            &db_type,
            source.unwrap_or_default(),
            move |event| emit_agent_progress(&app_handle, &progress_operation_id, event),
            &cancellation,
        )
        .await
    }
    .await;
    state.agent_manager.finish_install_cancellation(&install_cancellation_key(&operation_id), &cancellation).await;
    result
}

#[tauri::command]
pub async fn upgrade_all_agents(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    source: Option<DownloadSource>,
    operation_id: Option<String>,
) -> Result<UpgradeAllAgentDriversResult, String> {
    let source = source.unwrap_or_default();
    // Resolve the batch operation id first, then register the batch token under
    // it BEFORE the registry fetch + blocker check so a cancel fired while the
    // batch is still setting up aborts it instead of being lost.
    let operation_id = operation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let cancellation = state.agent_manager.begin_install_cancellation(&batch_cancellation_key(&operation_id)).await;
    let result = async {
        let registry = fetch_registry_from_claimed(source, &[cancellation.as_ref()]).await?;
        let agents = build_agent_list(&state.agent_manager, Some(&registry));
        let updatable: Vec<String> =
            agents.iter().filter(|agent| agent.update_available).map(|agent| agent.db_type.clone()).collect();
        ensure_no_agent_update_blockers(state.inner().as_ref(), &updatable).await?;
        let app_handle = app.clone();
        let progress_operation_id = operation_id.clone();
        upgrade_all_agent_drivers_from_claimed(
            &state.agent_manager,
            source,
            move |event| emit_agent_progress(&app_handle, &progress_operation_id, event),
            &cancellation,
            &operation_id,
        )
        .await
    }
    .await;
    state.agent_manager.finish_install_cancellation(&batch_cancellation_key(&operation_id), &cancellation).await;
    result
}

#[tauri::command]
pub async fn cancel_agent_install(
    state: State<'_, Arc<AppState>>,
    db_type: String,
    operation_id: Option<String>,
) -> Result<(), String> {
    cancel_agent_driver_install(&state.agent_manager, &db_type, operation_id.as_deref()).await
}

#[tauri::command]
pub async fn cancel_agent_upgrade_all(
    state: State<'_, Arc<AppState>>,
    operation_id: Option<String>,
) -> Result<(), String> {
    cancel_agent_batch_upgrade(&state.agent_manager, operation_id.as_deref()).await
}

#[tauri::command]
pub async fn check_agent_update_blockers(
    state: State<'_, Arc<AppState>>,
    db_types: Vec<String>,
) -> Result<Vec<AgentUpdateBlocker>, String> {
    Ok(agent_update_blockers(state.inner().as_ref(), &db_types).await)
}

#[tauri::command]
pub async fn uninstall_agent(state: State<'_, Arc<AppState>>, db_type: String) -> Result<(), String> {
    ensure_no_agent_update_blockers(state.inner().as_ref(), std::slice::from_ref(&db_type)).await?;
    uninstall_agent_driver(&state.agent_manager, &db_type).await
}

#[tauri::command]
pub async fn check_jre_installed(state: State<'_, Arc<AppState>>, jre_key: Option<String>) -> Result<bool, String> {
    let key = jre_key.as_deref().unwrap_or(DEFAULT_JRE_KEY);
    Ok(state.agent_manager.is_jre_installed(key))
}

#[tauri::command]
pub async fn get_agent_java_runtime_config(state: State<'_, Arc<AppState>>) -> Result<JavaRuntimeConfig, String> {
    Ok(state.agent_manager.load_state().java_runtime)
}

#[tauri::command]
pub async fn set_agent_java_runtime_config(
    state: State<'_, Arc<AppState>>,
    mut config: JavaRuntimeConfig,
) -> Result<JavaRuntimeConfig, String> {
    let am = &state.agent_manager;
    if config.mode == JavaRuntimeMode::Custom || config.mode == JavaRuntimeMode::System {
        let candidate_state = dbx_core::agent_manager::AgentState { java_runtime: config.clone(), ..am.load_state() };
        let resolved = am.resolve_java_runtime(&candidate_state, DEFAULT_JRE_KEY)?;
        if config.mode == JavaRuntimeMode::Custom {
            config.custom_java_path = Some(resolved.to_string_lossy().to_string());
        }
    }
    if config.mode != JavaRuntimeMode::Custom {
        config.custom_java_path = None;
    }

    am.mutate_state(|local_state| local_state.java_runtime = config.clone())?;
    am.stop_daemons().await;
    Ok(config)
}

#[tauri::command]
pub async fn uninstall_jre(state: State<'_, Arc<AppState>>, jre_key: String) -> Result<(), String> {
    uninstall_agent_jre(&state.agent_manager, &jre_key).await
}

#[tauri::command]
pub async fn invalidate_agent_registry_cache() -> Result<(), String> {
    invalidate_registry_cache().await;
    Ok(())
}

#[tauri::command]
pub async fn import_agents_from_zip(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    path: String,
    operation_id: Option<String>,
) -> Result<u32, String> {
    let am = &state.agent_manager;
    let package_path = std::path::PathBuf::from(&path);
    let plan = inspect_offline_package(&package_path)?;
    ensure_no_offline_import_blockers(state.inner().as_ref(), &plan).await?;
    let app_handle = app.clone();
    let operation_id = operation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let result = import_agents_from_package_core(am, &package_path, |event| {
        emit_agent_progress(&app_handle, &operation_id, event)
    })
    .await?;
    dbx_core::jdbc::import_offline_jdbc_payload(state.plugins.root_dir(), &package_path)?;
    let count = result.drivers_installed.len() as u32;
    emit_agent_progress(&app, &operation_id, AgentProgressEvent::step("done"));
    Ok(count)
}

#[tauri::command]
pub async fn preview_agent_offline_export(
    state: State<'_, Arc<AppState>>,
) -> Result<AgentOfflineExportPreview, String> {
    let state = Arc::clone(state.inner());
    run_blocking_agent_task("Failed to prepare the offline Agent export preview", move || {
        Ok(preview_agent_offline_export_core(&state.agent_manager))
    })
    .await
}

#[tauri::command]
pub async fn export_agents_offline(
    state: State<'_, Arc<AppState>>,
    path: String,
    driver_keys: Vec<String>,
) -> Result<AgentOfflineExportResult, String> {
    let state = Arc::clone(state.inner());
    run_blocking_agent_task("Failed to run the offline Agent export task", move || {
        export_agents_offline_core(&state.agent_manager, std::path::Path::new(&path), &driver_keys)
    })
    .await
}

async fn run_blocking_agent_task<T, F>(context: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task).await.map_err(|error| format!("{context}: {error}"))?
}

#[tauri::command]
pub async fn import_agent_driver_cmd(
    state: State<'_, Arc<AppState>>,
    db_type: String,
    path: String,
) -> Result<(), String> {
    ensure_no_agent_update_blockers(state.inner().as_ref(), std::slice::from_ref(&db_type)).await?;
    import_agent_driver(&state.agent_manager, &db_type, std::path::Path::new(&path)).await
}

#[tauri::command]
pub async fn import_agent_jar_cmd(
    state: State<'_, Arc<AppState>>,
    db_type: String,
    path: String,
) -> Result<(), String> {
    ensure_no_agent_update_blockers(state.inner().as_ref(), std::slice::from_ref(&db_type)).await?;
    import_agent_driver(&state.agent_manager, &db_type, std::path::Path::new(&path)).await
}

#[tauri::command]
pub async fn reinstall_jre(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    jre_key: Option<String>,
    source: Option<DownloadSource>,
    operation_id: Option<String>,
) -> Result<(), String> {
    let key = jre_key.as_deref().unwrap_or(DEFAULT_JRE_KEY);
    let app_handle = app.clone();
    let operation_id = operation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    reinstall_agent_jre_from(&state.agent_manager, key, source.unwrap_or_default(), move |event| {
        emit_agent_progress(&app_handle, &operation_id, event)
    })
    .await
}

fn emit_agent_progress(app: &tauri::AppHandle, operation_id: &str, event: AgentProgressEvent) {
    let _ = app.emit("agent-install-progress", event.with_operation_id(operation_id));
}

async fn ensure_no_agent_update_blockers(state: &AppState, db_types: &[String]) -> Result<(), String> {
    let blockers = update_blockers_from_keys(state.prepare_agent_driver_updates(db_types).await, db_types);
    if blockers.is_empty() {
        return Ok(());
    }
    let labels = blockers.into_iter().map(|blocker| blocker.label).collect::<Vec<_>>().join(", ");
    Err(format!("Close these database connections before updating drivers: {labels}"))
}

async fn ensure_no_offline_import_blockers(state: &AppState, plan: &OfflineImportPlan) -> Result<(), String> {
    let mut driver_keys = plan.driver_keys.clone();
    if plan.includes_jre {
        // Replacing a managed JRE affects every running Java Agent, so include
        // all active runtimes in the same connection-aware update preflight.
        driver_keys.extend(state.agent_manager.active_daemon_keys().await);
        driver_keys.extend(state.active_agent_connection_driver_keys().await);
        driver_keys.sort();
        driver_keys.dedup();
    }
    ensure_no_agent_update_blockers(state, &driver_keys).await
}

async fn agent_update_blockers(state: &AppState, db_types: &[String]) -> Vec<AgentUpdateBlocker> {
    update_blockers_from_keys(state.active_agent_connection_driver_keys().await, db_types)
}

fn update_blockers_from_keys(
    active_keys: std::collections::HashSet<String>,
    db_types: &[String],
) -> Vec<AgentUpdateBlocker> {
    let candidate_keys: std::collections::HashSet<&str> = db_types.iter().map(String::as_str).collect();
    if candidate_keys.is_empty() {
        return Vec::new();
    }
    let mut blockers = active_keys
        .into_iter()
        .filter(|key| candidate_keys.contains(key.as_str()))
        .map(|db_type| AgentUpdateBlocker {
            label: dbx_core::agent_catalog::label_for_key(&db_type).unwrap_or(&db_type).to_string(),
            db_type,
        })
        .collect::<Vec<_>>();
    blockers.sort_by(|left, right| left.label.cmp(&right.label));
    blockers
}

#[cfg(test)]
mod tests {
    use super::run_blocking_agent_task;

    #[tokio::test]
    async fn blocking_agent_task_returns_successful_value() {
        let result = run_blocking_agent_task("agent task failed", || Ok::<_, String>(42)).await;

        assert_eq!(result.unwrap(), 42);
    }

    #[tokio::test]
    async fn blocking_agent_task_preserves_core_error() {
        let result = run_blocking_agent_task("agent task failed", || Err::<(), _>("core failure".to_string())).await;

        assert_eq!(result.unwrap_err(), "core failure");
    }

    #[tokio::test]
    async fn blocking_agent_task_maps_join_error_with_context() {
        let result = run_blocking_agent_task("agent task failed", || -> Result<(), String> {
            panic!("worker panic");
        })
        .await;

        let error = result.unwrap_err();
        assert!(error.starts_with("agent task failed:"), "unexpected error: {error}");
        assert!(error.contains("panicked"), "unexpected error: {error}");
    }
}
