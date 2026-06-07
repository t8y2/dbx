use axum::Json;
use dbx_core::update;

use crate::error::AppError;

pub async fn get_version() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }))
}

pub async fn check_for_updates() -> Result<Json<serde_json::Value>, AppError> {
    let release = update::fetch_latest_release().await.map_err(AppError)?;
    let info = update::build_update_info(release, env!("CARGO_PKG_VERSION"));
    Ok(Json(serde_json::to_value(info).map_err(|e| AppError(e.to_string()))?))
}
