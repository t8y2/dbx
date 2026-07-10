use std::sync::Arc;

use tauri::{Emitter, State};

use dbx_core::agent_manager::{AgentDriverInfo, DriverStoreUsage, JavaRuntimeConfig, JavaRuntimeMode, DEFAULT_JRE_KEY};
use dbx_core::agent_service::{
    build_agent_list, clear_agent_download_cache, fetch_registry, import_agent_jar,
    import_agents_from_zip as import_agents_from_zip_core, install_agent_driver, invalidate_registry_cache,
    reinstall_agent_jre, uninstall_agent_driver, uninstall_agent_jre, upgrade_all_agent_drivers, AgentProgressEvent,
    UpgradeAllAgentDriversResult,
};
use dbx_core::connection::AppState;
use dbx_core::driver_runtime::DriverRuntimeSummary;

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
pub async fn list_installed_agents(state: State<'_, Arc<AppState>>) -> Result<Vec<AgentDriverInfo>, String> {
    let registry = fetch_registry().await.ok();
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
) -> Result<(), String> {
    ensure_no_agent_update_blockers(state.inner().as_ref(), std::slice::from_ref(&db_type)).await?;
    let app_handle = app.clone();
    install_agent_driver(&state.agent_manager, &db_type, move |event| emit_agent_progress(&app_handle, event)).await
}

#[tauri::command]
pub async fn upgrade_all_agents(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<UpgradeAllAgentDriversResult, String> {
    let registry = fetch_registry().await?;
    let agents = build_agent_list(&state.agent_manager, Some(&registry));
    let updatable: Vec<String> =
        agents.iter().filter(|agent| agent.update_available).map(|agent| agent.db_type.clone()).collect();
    ensure_no_agent_update_blockers(state.inner().as_ref(), &updatable).await?;
    let app_handle = app.clone();
    upgrade_all_agent_drivers(&state.agent_manager, move |event| emit_agent_progress(&app_handle, event)).await
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

    let mut local_state = am.load_state();
    local_state.java_runtime = config.clone();
    am.save_state(&local_state)?;
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
) -> Result<u32, String> {
    let am = &state.agent_manager;
    let zip_path = std::path::PathBuf::from(&path);
    let app_handle = app.clone();
    let result = import_agents_from_zip_core(am, &zip_path, |event| emit_agent_progress(&app_handle, event))?;
    let count = result.drivers_installed.len() as u32;
    emit_agent_progress(&app, AgentProgressEvent::step("done"));
    Ok(count)
}

#[tauri::command]
pub async fn import_agent_jar_cmd(
    state: State<'_, Arc<AppState>>,
    db_type: String,
    path: String,
) -> Result<(), String> {
    import_agent_jar(&state.agent_manager, &db_type, std::path::Path::new(&path))
}

#[tauri::command]
pub async fn reinstall_jre(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    jre_key: Option<String>,
) -> Result<(), String> {
    let key = jre_key.as_deref().unwrap_or(DEFAULT_JRE_KEY);
    let app_handle = app.clone();
    reinstall_agent_jre(&state.agent_manager, key, move |event| emit_agent_progress(&app_handle, event)).await
}

fn emit_agent_progress(app: &tauri::AppHandle, event: AgentProgressEvent) {
    let _ = app.emit("agent-install-progress", event);
}

async fn ensure_no_agent_update_blockers(state: &AppState, db_types: &[String]) -> Result<(), String> {
    let blockers = agent_update_blockers(state, db_types).await;
    if blockers.is_empty() {
        return Ok(());
    }
    let labels = blockers.into_iter().map(|blocker| blocker.label).collect::<Vec<_>>().join(", ");
    Err(format!("请先关闭以下数据库连接后再更新驱动: {labels}"))
}

async fn agent_update_blockers(state: &AppState, db_types: &[String]) -> Vec<AgentUpdateBlocker> {
    let candidate_keys: std::collections::HashSet<&str> = db_types.iter().map(String::as_str).collect();
    if candidate_keys.is_empty() {
        return Vec::new();
    }
    let active_keys = state.active_agent_driver_keys().await;
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
