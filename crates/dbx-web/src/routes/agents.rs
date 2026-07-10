use std::sync::Arc;

use axum::extract::{Multipart, Path, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use dbx_core::agent_manager::{
    AgentDriverInfo, AgentState, DriverStoreUsage, JavaRuntimeConfig, JavaRuntimeMode, DEFAULT_JRE_KEY,
};
use dbx_core::agent_service::{
    build_agent_list, clear_agent_download_cache, fetch_registry,
    import_agents_from_zip as import_agents_from_zip_core, install_agent_driver, invalidate_registry_cache,
    reinstall_agent_jre, uninstall_agent_driver, uninstall_agent_jre, upgrade_all_agent_drivers, AgentProgressEvent,
};
use dbx_core::driver_runtime::DriverRuntimeSummary;
use futures::Stream;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::broadcast;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTypeRequest {
    pub db_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JreRequest {
    pub jre_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaRuntimeRequest {
    pub config: JavaRuntimeConfig,
}

pub async fn list_installed_agents_local(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<AgentDriverInfo>>, AppError> {
    Ok(Json(build_agent_list(&state.app.agent_manager, None)))
}

pub async fn list_installed_agents(State(state): State<Arc<WebState>>) -> Result<Json<Vec<AgentDriverInfo>>, AppError> {
    let registry = fetch_registry().await.ok();
    Ok(Json(build_agent_list(&state.app.agent_manager, registry.as_ref())))
}

pub async fn is_agent_installed(
    State(state): State<Arc<WebState>>,
    Path(db_type): Path<String>,
) -> Result<Json<bool>, AppError> {
    Ok(Json(state.app.agent_manager.is_driver_installed(&db_type)))
}

pub async fn get_driver_store_usage(State(state): State<Arc<WebState>>) -> Result<Json<DriverStoreUsage>, AppError> {
    Ok(Json(state.app.agent_manager.collect_driver_store_usage(state.app.plugins.root_dir())))
}

pub async fn clear_driver_download_cache(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, AppError> {
    clear_agent_download_cache(&state.app.agent_manager).map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn get_driver_runtime_summary(
    State(state): State<Arc<WebState>>,
) -> Result<Json<DriverRuntimeSummary>, AppError> {
    Ok(Json(dbx_core::driver_runtime::collect_driver_runtime_summary(&state.app).await))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverRuntimeRequest {
    pub runtime_id: String,
}

pub async fn stop_driver_runtime(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DriverRuntimeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    dbx_core::driver_runtime::stop_driver_runtime(&state.app, &req.runtime_id).await.map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn restart_driver_runtime(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DriverRuntimeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    dbx_core::driver_runtime::restart_driver_runtime(&state.app, &req.runtime_id).await.map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn install_agent(
    State(state): State<Arc<WebState>>,
    Json(req): Json<AgentTypeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_no_agent_update_blockers(&state.app, std::slice::from_ref(&req.db_type)).await.map_err(AppError)?;
    let tx = progress_sender(&state, "global").await;
    install_agent_driver(&state.app.agent_manager, &req.db_type, |event| send_progress_event(&tx, event))
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn upgrade_all_agents(State(state): State<Arc<WebState>>) -> Result<Json<serde_json::Value>, AppError> {
    let registry = fetch_registry().await.map_err(AppError)?;
    let agents = build_agent_list(&state.app.agent_manager, Some(&registry));
    let updatable: Vec<String> =
        agents.iter().filter(|agent| agent.update_available).map(|agent| agent.db_type.clone()).collect();
    ensure_no_agent_update_blockers(&state.app, &updatable).await.map_err(AppError)?;
    let tx = progress_sender(&state, "global").await;
    let result = upgrade_all_agent_drivers(&state.app.agent_manager, |event| send_progress_event(&tx, event))
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|err| AppError(err.to_string()))?))
}

pub async fn uninstall_agent(
    State(state): State<Arc<WebState>>,
    Json(req): Json<AgentTypeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    uninstall_agent_driver(&state.app.agent_manager, &req.db_type).await.map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn get_agent_java_runtime_config(
    State(state): State<Arc<WebState>>,
) -> Result<Json<JavaRuntimeConfig>, AppError> {
    Ok(Json(state.app.agent_manager.load_state().java_runtime))
}

pub async fn set_agent_java_runtime_config(
    State(state): State<Arc<WebState>>,
    Json(req): Json<JavaRuntimeRequest>,
) -> Result<Json<JavaRuntimeConfig>, AppError> {
    let am = &state.app.agent_manager;
    let mut config = req.config;
    if config.mode == JavaRuntimeMode::Custom || config.mode == JavaRuntimeMode::System {
        let candidate_state = AgentState { java_runtime: config.clone(), ..am.load_state() };
        let resolved = am.resolve_java_runtime(&candidate_state, DEFAULT_JRE_KEY).map_err(AppError)?;
        if config.mode == JavaRuntimeMode::Custom {
            config.custom_java_path = Some(resolved.to_string_lossy().to_string());
        }
    }
    if config.mode != JavaRuntimeMode::Custom {
        config.custom_java_path = None;
    }

    let mut local_state = am.load_state();
    local_state.java_runtime = config.clone();
    am.save_state(&local_state).map_err(AppError)?;
    am.stop_daemons().await;
    Ok(Json(config))
}

pub async fn invalidate_agent_registry_cache() -> Result<Json<serde_json::Value>, AppError> {
    invalidate_registry_cache().await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn import_agents_from_zip(
    State(state): State<Arc<WebState>>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let tmp_dir = state.data_dir.join("tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|err| AppError(err.to_string()))?;

    if let Some(field) = multipart.next_field().await.map_err(|err| AppError(err.to_string()))? {
        let file_name = field.file_name().unwrap_or("offline-drivers.zip").to_string();
        if !file_name.to_ascii_lowercase().ends_with(".zip") {
            return Err(AppError("Offline driver package must be a .zip file".to_string()));
        }

        let zip_path = tmp_dir.join(format!("agent-offline-{}.zip", uuid::Uuid::new_v4()));
        let mut upload = tokio::fs::File::create(&zip_path).await.map_err(|err| AppError(err.to_string()))?;
        let mut field = field;
        while let Some(chunk) = field.chunk().await.map_err(|err| AppError(err.to_string()))? {
            upload.write_all(&chunk).await.map_err(|err| AppError(err.to_string()))?;
        }
        upload.flush().await.map_err(|err| AppError(err.to_string()))?;
        drop(upload);

        let tx = progress_sender(&state, "global").await;
        let result =
            import_agents_from_zip_core(&state.app.agent_manager, &zip_path, |event| send_progress_event(&tx, event))
                .map_err(AppError);
        let _ = std::fs::remove_file(&zip_path);

        let result = result?;
        send_progress_event(&tx, AgentProgressEvent::step("done"));
        return Ok(Json(serde_json::json!({ "count": result.drivers_installed.len() as u32 })));
    }

    Err(AppError("No file uploaded".to_string()))
}

pub async fn import_agent_jar(
    State(state): State<Arc<WebState>>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut db_type: Option<String> = None;
    let mut jar_data: Option<Vec<u8>> = None;
    let mut jar_name = String::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name == "dbType" {
            db_type = Some(field.text().await.map_err(|e| AppError(e.to_string()))?);
        } else if name == "file" {
            jar_name = field.file_name().unwrap_or("driver.jar").to_string();
            if !jar_name.to_lowercase().ends_with(".jar") {
                return Err(AppError("Only .jar files can be imported".to_string()));
            }
            jar_data = Some(field.bytes().await.map_err(|e| AppError(e.to_string()))?.to_vec());
        }
    }

    let db_type = db_type.ok_or_else(|| AppError("Missing dbType field".to_string()))?;
    let data = jar_data.ok_or_else(|| AppError("No file uploaded".to_string()))?;

    let temp_dir = state.app.plugins.root_dir().join("jar_upload_tmp");
    std::fs::create_dir_all(&temp_dir).map_err(|e| AppError(e.to_string()))?;
    let tmp_path = temp_dir.join(&jar_name);
    std::fs::write(&tmp_path, &data).map_err(|e| AppError(e.to_string()))?;

    dbx_core::agent_service::import_agent_jar(&state.app.agent_manager, &db_type, &tmp_path).map_err(AppError::from)?;
    let _ = std::fs::remove_file(&tmp_path);
    Ok(Json(serde_json::json!({ "success": true })))
}

pub async fn reinstall_jre(
    State(state): State<Arc<WebState>>,
    Json(req): Json<JreRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let tx = progress_sender(&state, "global").await;
    reinstall_agent_jre(&state.app.agent_manager, req.jre_key.as_deref().unwrap_or(DEFAULT_JRE_KEY), |event| {
        send_progress_event(&tx, event);
    })
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn uninstall_jre(
    State(state): State<Arc<WebState>>,
    Json(req): Json<JreRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let key = req.jre_key.as_deref().unwrap_or(DEFAULT_JRE_KEY);
    uninstall_agent_jre(&state.app.agent_manager, key).await.map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn agent_progress(
    State(state): State<Arc<WebState>>,
    Path(operation_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let tx = progress_sender(&state, &operation_id).await;
    Ok(crate::sse::sse_from_channel(tx.subscribe()))
}

async fn progress_sender(state: &WebState, operation_id: &str) -> broadcast::Sender<String> {
    let mut channels = state.sse_channels.write().await;
    channels
        .entry(format!("agent-install-progress:{operation_id}"))
        .or_insert_with(|| {
            let (tx, _) = broadcast::channel::<String>(256);
            tx
        })
        .clone()
}

fn send_progress_event(tx: &broadcast::Sender<String>, event: AgentProgressEvent) {
    if let Ok(payload) = serde_json::to_string(&event) {
        let _ = tx.send(payload);
    }
}

async fn ensure_no_agent_update_blockers(
    state: &dbx_core::connection::AppState,
    db_types: &[String],
) -> Result<(), String> {
    let candidate_keys: std::collections::HashSet<&str> = db_types.iter().map(String::as_str).collect();
    if candidate_keys.is_empty() {
        return Ok(());
    }
    let mut blockers = state
        .active_agent_driver_keys()
        .await
        .into_iter()
        .filter(|key| candidate_keys.contains(key.as_str()))
        .map(|key| dbx_core::agent_catalog::label_for_key(&key).unwrap_or(&key).to_string())
        .collect::<Vec<_>>();
    blockers.sort();
    if blockers.is_empty() {
        Ok(())
    } else {
        Err(format!("请先关闭以下数据库连接后再更新驱动: {}", blockers.join(", ")))
    }
}
