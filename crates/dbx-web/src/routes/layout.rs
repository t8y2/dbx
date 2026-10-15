use std::sync::Arc;

use axum::extract::Path;
use axum::extract::State;
use axum::http::StatusCode;
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

pub async fn load_sidebar_layout(State(state): State<Arc<WebState>>) -> Result<Json<serde_json::Value>, AppError> {
    // Client-facing projection: stored protection-password verifiers are
    // replaced by plain hasPassword flags and never sent to the frontend.
    let layout = state.app.storage.load_sidebar_layout_for_client().await.map_err(AppError::from)?;
    Ok(Json(layout.unwrap_or(serde_json::json!(null))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearGroupPasswordRequest {
    pub login_password: String,
}

/// Clear a connection group's protection password inside the persisted
/// sidebar layout. Same login-password gate as the folder clear endpoint.
pub async fn clear_connection_group_password(
    State(state): State<Arc<WebState>>,
    Path(group_id): Path<String>,
    Json(body): Json<ClearGroupPasswordRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    crate::auth::verify_login_password(&state, &body.login_password).await?;
    let cleared = state
        .app
        .storage
        .clear_connection_group_password(&group_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !cleared {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPasswordRequest {
    pub password: String,
}

/// Set (or replace) a connection group's protection password. The verifier is
/// minted server-side; the plaintext never touches persistent storage.
pub async fn set_connection_group_password(
    State(state): State<Arc<WebState>>,
    Path(group_id): Path<String>,
    Json(body): Json<GroupPasswordRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let verifier = dbx_core::persistence::protection_password::hash_protection_password(&body.password)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let updated = state
        .app
        .storage
        .set_connection_group_password(&group_id, &verifier)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !updated {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Verify a connection group's protection password. Answers
/// `{ ok: true | false }` so the stored verifier never leaves the server.
pub async fn verify_connection_group_password(
    State(state): State<Arc<WebState>>,
    Path(group_id): Path<String>,
    Json(body): Json<GroupPasswordRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let matched = state
        .app
        .storage
        .verify_connection_group_password(&group_id, &body.password)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "ok": matched })))
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
