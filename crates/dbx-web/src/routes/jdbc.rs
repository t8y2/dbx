use std::sync::Arc;

use axum::extract::{Multipart, Path, State};
use axum::Json;
use dbx_core::agent_service::AgentProgressEvent;
use dbx_core::jdbc::{
    self, JdbcDriverInfo, JdbcLocalBundleInfo, JdbcMavenBundleInfo, JdbcMavenInstallRequest, JdbcPluginStatus,
};
use dbx_core::plugins::PluginRuntimeEnv;
use tokio::sync::broadcast;

use crate::error::AppError;
use crate::state::WebState;

// ---- JDBC Drivers ----

pub async fn list_jdbc_drivers(State(state): State<Arc<WebState>>) -> Result<Json<Vec<JdbcDriverInfo>>, AppError> {
    let root = state.app.plugins.root_dir();
    Ok(Json(jdbc::list_jdbc_drivers(root).map_err(AppError::internal)?))
}

pub async fn list_jdbc_maven_bundles(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<JdbcMavenBundleInfo>>, AppError> {
    let root = state.app.plugins.root_dir();
    Ok(Json(jdbc::list_jdbc_maven_bundles(root).map_err(AppError::internal)?))
}

pub async fn list_jdbc_local_bundles(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<JdbcLocalBundleInfo>>, AppError> {
    let root = state.app.plugins.root_dir();
    Ok(Json(jdbc::list_jdbc_local_bundles(root).map_err(AppError::internal)?))
}

pub async fn install_jdbc_driver_from_maven(
    State(state): State<Arc<WebState>>,
    Json(req): Json<JdbcMavenInstallRequest>,
) -> Result<Json<Vec<JdbcDriverInfo>>, AppError> {
    let root = state.app.plugins.root_dir();
    Ok(Json(
        jdbc::install_jdbc_driver_from_maven(root, req, PluginRuntimeEnv::default())
            .await
            .map_err(AppError::internal)?,
    ))
}

pub async fn install_prestosql_jdbc_driver(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<JdbcDriverInfo>>, AppError> {
    let root = state.app.plugins.root_dir();
    Ok(Json(jdbc::install_prestosql_jdbc_driver(root).await.map_err(AppError::internal)?))
}

pub async fn import_jdbc_drivers(
    State(state): State<Arc<WebState>>,
    mut multipart: Multipart,
) -> Result<Json<Vec<JdbcDriverInfo>>, AppError> {
    let root = state.app.plugins.root_dir();
    let upload_dir = root.join("jdbc").join("upload_tmp").join(uuid::Uuid::new_v4().simple().to_string());
    std::fs::create_dir_all(&upload_dir).map_err(|e| AppError::internal(e.to_string()))?;

    let mut imported = Vec::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        let file_name = field.file_name().unwrap_or("driver.jar").to_string();
        if !file_name.to_lowercase().ends_with(".jar") {
            return Err(AppError::bad_request("Only .jar files can be imported"));
        }
        let data = field.bytes().await.map_err(|e| AppError::internal(e.to_string()))?;
        let target = jdbc::unique_target_path(&upload_dir, &file_name);
        std::fs::write(&target, &data).map_err(|e| AppError::internal(e.to_string()))?;
        imported.push(target);
    }
    if imported.is_empty() {
        let _ = std::fs::remove_dir_all(&upload_dir);
        return Err(AppError::bad_request("No file uploaded"));
    }
    let paths = imported.iter().map(|path| path.to_string_lossy().to_string()).collect::<Vec<_>>();
    let result = jdbc::import_jdbc_drivers(root, &paths).map(Json).map_err(AppError::internal);
    let _ = std::fs::remove_dir_all(&upload_dir);
    result
}

pub async fn delete_jdbc_driver(
    State(state): State<Arc<WebState>>,
    Path(name): Path<String>,
) -> Result<Json<Vec<JdbcDriverInfo>>, AppError> {
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err(AppError::bad_request("Invalid driver name"));
    }
    let root = state.app.plugins.root_dir();
    let driver_path = root.join("jdbc").join("drivers").join(&name);
    let path_str = driver_path.to_string_lossy().to_string();
    Ok(Json(jdbc::delete_jdbc_driver(root, &path_str).map_err(AppError::internal)?))
}

pub async fn delete_jdbc_maven_bundle(
    State(state): State<Arc<WebState>>,
    Path(bundle_id): Path<String>,
) -> Result<Json<Vec<JdbcDriverInfo>>, AppError> {
    let root = state.app.plugins.root_dir();
    Ok(Json(jdbc::delete_jdbc_maven_bundle(root, &bundle_id).map_err(AppError::internal)?))
}

pub async fn delete_jdbc_local_bundle(
    State(state): State<Arc<WebState>>,
    Path(bundle_id): Path<String>,
) -> Result<Json<Vec<JdbcDriverInfo>>, AppError> {
    let root = state.app.plugins.root_dir();
    Ok(Json(jdbc::delete_jdbc_local_bundle(root, &bundle_id).map_err(AppError::internal)?))
}

// ---- JDBC Plugin ----

pub async fn get_jdbc_plugin_status(State(state): State<Arc<WebState>>) -> Result<Json<JdbcPluginStatus>, AppError> {
    let root = state.app.plugins.root_dir();
    Ok(Json(jdbc::get_jdbc_plugin_status(root).await.map_err(AppError::internal)?))
}

pub async fn install_jdbc_plugin(State(state): State<Arc<WebState>>) -> Result<Json<JdbcPluginStatus>, AppError> {
    let root = state.app.plugins.root_dir();
    let tx = progress_sender(&state, "global").await;
    Ok(Json(
        jdbc::install_jdbc_plugin_with_progress(root, |event| send_progress_event(&tx, event))
            .await
            .map_err(AppError::internal)?,
    ))
}

pub async fn install_jdbc_plugin_local(
    State(state): State<Arc<WebState>>,
    mut multipart: Multipart,
) -> Result<Json<JdbcPluginStatus>, AppError> {
    let root = state.app.plugins.root_dir();
    let temp_dir = root.join("jdbc").with_extension("upload_tmp");
    std::fs::create_dir_all(&temp_dir).map_err(|e| AppError::internal(e.to_string()))?;

    if let Ok(Some(field)) = multipart.next_field().await {
        let file_name = field.file_name().unwrap_or("plugin.zip").to_string();
        if !file_name.to_lowercase().ends_with(".zip") {
            return Err(AppError::bad_request("Only .zip files can be imported for JDBC plugin"));
        }
        let data = field.bytes().await.map_err(|e| AppError::internal(e.to_string()))?;
        let tmp_path = temp_dir.join(&file_name);
        std::fs::write(&tmp_path, &data).map_err(|e| AppError::internal(e.to_string()))?;
        let result =
            jdbc::install_jdbc_plugin_from_file(root, &tmp_path.to_string_lossy()).await.map_err(AppError::internal)?;
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Ok(Json(result));
    }

    Err(AppError::bad_request("No file uploaded"))
}

pub async fn uninstall_jdbc_plugin(State(state): State<Arc<WebState>>) -> Result<Json<JdbcPluginStatus>, AppError> {
    let root = state.app.plugins.root_dir();
    Ok(Json(jdbc::uninstall_jdbc_plugin(root).map_err(AppError::internal)?))
}

// ---- System Fonts ----

pub async fn list_system_fonts() -> Result<Json<Vec<String>>, AppError> {
    Ok(Json(jdbc::list_system_fonts()))
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
