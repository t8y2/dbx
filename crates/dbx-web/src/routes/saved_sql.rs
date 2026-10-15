use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use dbx_core::saved_sql::{SavedSqlFile, SavedSqlFolder, SavedSqlLibrary};
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

pub async fn load_saved_sql_library(State(state): State<Arc<WebState>>) -> Result<Json<SavedSqlLibrary>, AppError> {
    let library = state.app.storage.load_saved_sql_library_summary().await.map_err(AppError::from)?;
    Ok(Json(library))
}

pub async fn load_saved_sql_file(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<Option<SavedSqlFile>>, AppError> {
    let file = state.app.storage.load_saved_sql_file(&id).await.map_err(AppError::from)?;
    Ok(Json(file))
}

pub async fn save_saved_sql_folder(
    State(state): State<Arc<WebState>>,
    Json(folder): Json<SavedSqlFolder>,
) -> Result<Json<SavedSqlFolder>, AppError> {
    state.app.storage.save_saved_sql_folder(&folder).await.map_err(AppError::from)?;
    Ok(Json(folder))
}

pub async fn delete_saved_sql_folder(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_saved_sql_folder(&id).await.map_err(AppError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearFolderPasswordRequest {
    pub login_password: String,
}

/// Clear a SQL library folder's protection password. Requires a live session
/// plus the application's login password — the recovery path for a forgotten
/// folder password (settings → security → clear protection passwords).
pub async fn clear_saved_sql_folder_password(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    Json(body): Json<ClearFolderPasswordRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    crate::auth::verify_login_password(&state, &body.login_password).await?;
    let folder = state.app.storage.get_saved_sql_folder(&id).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if folder.is_none() {
        return Err(StatusCode::NOT_FOUND);
    }
    state.app.storage.clear_saved_sql_folder_password(&id).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPasswordRequest {
    pub password: String,
}

/// Set (or replace) a SQL library folder's protection password. The verifier
/// is minted server-side; the plaintext never touches persistent storage.
pub async fn set_saved_sql_folder_password(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    Json(body): Json<FolderPasswordRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let verifier = dbx_core::persistence::protection_password::hash_protection_password(&body.password)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let updated = state
        .app
        .storage
        .set_saved_sql_folder_password(&id, &verifier)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !updated {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Verify a SQL library folder's protection password. Answers
/// `{ ok: true | false }` so the stored verifier never leaves the server.
pub async fn verify_saved_sql_folder_password(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    Json(body): Json<FolderPasswordRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let matched = state
        .app
        .storage
        .verify_saved_sql_folder_password(&id, &body.password)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "ok": matched })))
}

pub async fn save_saved_sql_file(
    State(state): State<Arc<WebState>>,
    Json(file): Json<SavedSqlFile>,
) -> Result<Json<SavedSqlFile>, AppError> {
    state.app.storage.save_saved_sql_file(&file).await.map_err(AppError::from)?;
    Ok(Json(file))
}

pub async fn delete_saved_sql_file(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_saved_sql_file(&id).await.map_err(AppError::from)?;
    Ok(Json(()))
}
