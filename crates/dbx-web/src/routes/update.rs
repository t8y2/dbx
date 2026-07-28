use axum::{extract::Query, Json};
use dbx_core::{changelog, update};

use crate::error::AppError;

pub async fn get_version() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }))
}

#[derive(serde::Deserialize)]
pub struct UpdateCheckParams {
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub source: Option<dbx_core::DownloadSource>,
}

pub async fn check_for_updates(Query(params): Query<UpdateCheckParams>) -> Result<Json<serde_json::Value>, AppError> {
    let locale = params.locale.unwrap_or_else(|| "zh-CN".to_string());
    let release =
        update::fetch_latest_release(&locale, params.source.unwrap_or_default()).await.map_err(AppError::from)?;
    let info = update::build_update_info(release, env!("CARGO_PKG_VERSION"));
    Ok(Json(serde_json::to_value(info).map_err(|e| AppError::from(e.to_string()))?))
}

#[derive(serde::Deserialize)]
pub struct ChangelogParams {
    #[serde(default)]
    pub lang: Option<String>,
}

pub async fn fetch_changelog(
    Query(params): Query<ChangelogParams>,
) -> Result<Json<changelog::ChangelogData>, AppError> {
    let lang = params.lang.unwrap_or_else(|| "en".to_string());
    let data = changelog::fetch_changelog(&lang).await.map_err(AppError::from)?;
    Ok(Json(data))
}
