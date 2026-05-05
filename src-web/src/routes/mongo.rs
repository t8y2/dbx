use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoConnectionRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoCollectionRequest {
    pub connection_id: String,
    pub database: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoFindRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub skip: Option<u64>,
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoInsertRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub doc_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoUpdateRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub id: String,
    pub doc_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDeleteRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub id: String,
}

pub async fn list_databases(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoConnectionRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    let result = dbx_core::mongo_ops::mongo_list_databases_core(&state.app, &req.connection_id)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn list_collections(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoCollectionRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    let result = dbx_core::mongo_ops::mongo_list_collections_core(
        &state.app,
        &req.connection_id,
        &req.database,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn find_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoFindRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::mongo_ops::mongo_find_documents_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        req.skip.unwrap_or(0),
        req.limit.unwrap_or(50),
    )
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn insert_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoInsertRequest>,
) -> Result<Json<String>, AppError> {
    let result = dbx_core::mongo_ops::mongo_insert_document_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.doc_json,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn update_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoUpdateRequest>,
) -> Result<Json<u64>, AppError> {
    let result = dbx_core::mongo_ops::mongo_update_document_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.id,
        &req.doc_json,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn delete_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoDeleteRequest>,
) -> Result<Json<u64>, AppError> {
    let result = dbx_core::mongo_ops::mongo_delete_document_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.id,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(result))
}
