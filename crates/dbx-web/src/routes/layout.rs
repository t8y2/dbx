use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLayoutRequest {
    pub layout: serde_json::Value,
}

pub async fn save_sidebar_layout(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveLayoutRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_sidebar_layout(&body.layout).await.map_err(AppError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionalSaveLayoutRequest {
    pub layout: serde_json::Value,
    /// The layout the caller read. `null` means "the row must still be absent".
    #[serde(default)]
    pub expected: Option<serde_json::Value>,
}

#[derive(serde::Serialize)]
pub struct ConditionalSaveLayoutResponse {
    pub saved: bool,
}

/// Compare-and-swap save used by MCP group moves. The desktop's plain
/// `POST /layout/sidebar` keeps its last-writer-wins behavior.
pub async fn replace_sidebar_layout_if_unchanged(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConditionalSaveLayoutRequest>,
) -> Result<Json<ConditionalSaveLayoutResponse>, AppError> {
    let saved = state
        .app
        .storage
        .replace_sidebar_layout_if_unchanged(body.expected.as_ref(), &body.layout)
        .await
        .map_err(AppError::from)?;
    Ok(Json(ConditionalSaveLayoutResponse { saved }))
}

pub async fn load_sidebar_layout(State(state): State<Arc<WebState>>) -> Result<Json<serde_json::Value>, AppError> {
    let layout = state.app.storage.load_sidebar_layout().await.map_err(AppError::from)?;
    Ok(Json(layout.unwrap_or(serde_json::json!(null))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTableVGroupsRequest {
    pub scope_key: String,
    pub layout: serde_json::Value,
}

pub async fn save_table_vgroups(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveTableVGroupsRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_table_vgroups(&body.scope_key, &body.layout).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn load_table_vgroups(State(state): State<Arc<WebState>>) -> Result<Json<serde_json::Value>, AppError> {
    let layouts = state.app.storage.load_table_vgroups().await.map_err(AppError::from)?;
    Ok(Json(layouts))
}

pub async fn delete_table_vgroups_for_connection(
    State(state): State<Arc<WebState>>,
    axum::extract::Path(connection_id): axum::extract::Path<String>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_table_vgroups_for_connection(&connection_id).await.map_err(AppError::from)?;
    Ok(Json(()))
}
