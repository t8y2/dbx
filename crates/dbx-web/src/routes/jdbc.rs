use std::sync::Arc;

use axum::extract::{Multipart, Path, State};
use axum::Json;
use dbx_core::jdbc::{self, JdbcDriverInfo, JdbcPluginStatus};

use crate::error::AppError;
use crate::state::WebState;

// ---- JDBC Drivers ----

pub async fn list_jdbc_drivers(State(state): State<Arc<WebState>>) -> Result<Json<Vec<JdbcDriverInfo>>, AppError> {
    let root = state.app.plugins.root_dir();
    Ok(Json(jdbc::list_jdbc_drivers(root).map_err(AppError::internal)?))
}

pub async fn import_jdbc_drivers(
    State(state): State<Arc<WebState>>,
    mut multipart: Multipart,
) -> Result<Json<Vec<JdbcDriverInfo>>, AppError> {
    let root = state.app.plugins.root_dir();
    let drivers_dir = root.join("jdbc").join("drivers");
    std::fs::create_dir_all(&drivers_dir).map_err(|e| AppError::internal(e.to_string()))?;

    let mut imported = Vec::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        let file_name = field.file_name().unwrap_or("driver.jar").to_string();
        if !file_name.to_lowercase().ends_with(".jar") {
            return Err(AppError::bad_request("Only .jar files can be imported"));
        }
        let data = field.bytes().await.map_err(|e| AppError::internal(e.to_string()))?;
        let target = jdbc::unique_target_path(&drivers_dir, &file_name);
        std::fs::write(&target, &data).map_err(|e| AppError::internal(e.to_string()))?;
        imported.push(target);
    }

    jdbc::list_jdbc_drivers(root).map(Json).map_err(AppError::internal)
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

// ---- JDBC Plugin ----

pub async fn get_jdbc_plugin_status(State(state): State<Arc<WebState>>) -> Result<Json<JdbcPluginStatus>, AppError> {
    let root = state.app.plugins.root_dir();
    Ok(Json(jdbc::get_jdbc_plugin_status(root).await.map_err(AppError::internal)?))
}

pub async fn install_jdbc_plugin(State(state): State<Arc<WebState>>) -> Result<Json<JdbcPluginStatus>, AppError> {
    let root = state.app.plugins.root_dir();
    Ok(Json(jdbc::install_jdbc_plugin(root).await.map_err(AppError::internal)?))
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
