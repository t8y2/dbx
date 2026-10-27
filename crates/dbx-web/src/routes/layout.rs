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
    /// Raw layout text the caller read before transforming it. Only consulted
    /// when `conditional` is set; `None` then means "the row must still be
    /// absent", which is different from a plain unconditional write.
    #[serde(default)]
    pub expected: Option<String>,
    #[serde(default)]
    pub conditional: bool,
}

#[derive(serde::Serialize)]
pub struct SaveLayoutResponse {
    pub applied: bool,
}

pub async fn save_sidebar_layout(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveLayoutRequest>,
) -> Result<Json<SaveLayoutResponse>, AppError> {
    let applied = if body.conditional {
        state
            .app
            .storage
            .replace_sidebar_layout_if_unchanged(body.expected.as_deref(), &body.layout)
            .await
            .map_err(AppError::from)?
    } else {
        state.app.storage.save_sidebar_layout(&body.layout).await.map_err(AppError::from)?;
        true
    };
    Ok(Json(SaveLayoutResponse { applied }))
}

pub async fn load_sidebar_layout(State(state): State<Arc<WebState>>) -> Result<Json<serde_json::Value>, AppError> {
    let layout = state.app.storage.load_sidebar_layout().await.map_err(AppError::from)?;
    Ok(Json(layout.unwrap_or(serde_json::json!(null))))
}

#[derive(serde::Serialize)]
pub struct RawLayoutResponse {
    pub layout: serde_json::Value,
    /// The stored text, byte for byte. Callers that write conditionally have to
    /// echo it back: comparing against a re-serialized copy fails on any layout
    /// that was migrated from the legacy file with its original whitespace.
    pub raw: Option<String>,
}

pub async fn load_sidebar_layout_raw(State(state): State<Arc<WebState>>) -> Result<Json<RawLayoutResponse>, AppError> {
    let raw = state.app.storage.load_sidebar_layout_raw().await.map_err(AppError::from)?;
    let layout = match raw.as_deref() {
        Some(text) => serde_json::from_str::<serde_json::Value>(text)
            .map_err(|error| AppError::from(format!("Invalid sidebar layout JSON: {error}")))?,
        None => serde_json::json!(null),
    };
    Ok(Json(RawLayoutResponse { layout, raw }))
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
