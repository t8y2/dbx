use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use dbx_core::saved_sql::{SavedSqlFile, SavedSqlFolder, SavedSqlLibrary};

use crate::error::AppError;
use crate::state::WebState;

pub async fn load_saved_sql_library(State(state): State<Arc<WebState>>) -> Result<Json<SavedSqlLibrary>, AppError> {
    let library = state.app.storage.load_saved_sql_library().await.map_err(AppError)?;
    Ok(Json(library))
}

pub async fn save_saved_sql_folder(
    State(state): State<Arc<WebState>>,
    Json(folder): Json<SavedSqlFolder>,
) -> Result<Json<SavedSqlFolder>, AppError> {
    state.app.storage.save_saved_sql_folder(&folder).await.map_err(AppError)?;
    Ok(Json(folder))
}

pub async fn delete_saved_sql_folder(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_saved_sql_folder(&id).await.map_err(AppError)?;
    Ok(Json(()))
}

pub async fn save_saved_sql_file(
    State(state): State<Arc<WebState>>,
    Json(file): Json<SavedSqlFile>,
) -> Result<Json<SavedSqlFile>, AppError> {
    state.app.storage.save_saved_sql_file(&file).await.map_err(AppError)?;
    Ok(Json(file))
}

pub async fn delete_saved_sql_file(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_saved_sql_file(&id).await.map_err(AppError)?;
    Ok(Json(()))
}
