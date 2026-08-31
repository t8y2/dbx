use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorCollectionRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorDatabaseRequest {
    pub connection_id: String,
    pub database: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorRenameCollectionRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub new_name: String,
}

async fn ensure_writable(state: &WebState, connection_id: &str, action: &str) -> Result<(), AppError> {
    if let Some(name) = dbx_core::query::connection_readonly_name(&state.app, connection_id).await {
        return Err(AppError::from(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. {} blocked.",
            name, action
        )));
    }
    Ok(())
}

pub async fn collection_detail(
    State(state): State<Arc<WebState>>,
    Json(req): Json<VectorCollectionRequest>,
) -> Result<Json<dbx_core::db::vector_driver::CollectionInfo>, AppError> {
    dbx_core::schema::get_vector_collection_detail_core(&state.app, &req.connection_id, &req.database, &req.collection)
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn drop_database(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<VectorDatabaseRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, &req.database, "Drop database")
        .await?;
    ensure_writable(&state, &req.connection_id, "Drop database").await?;
    dbx_core::schema::drop_vector_database_core(&state.app, &req.connection_id, &req.database)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn drop_collection(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<VectorCollectionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, &req.database, "Drop collection")
        .await?;
    ensure_writable(&state, &req.connection_id, "Drop collection").await?;
    dbx_core::schema::drop_vector_collection_core(&state.app, &req.connection_id, &req.database, &req.collection)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn rename_collection(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<VectorRenameCollectionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, &req.database, "Rename collection")
        .await?;
    ensure_writable(&state, &req.connection_id, "Rename collection").await?;
    dbx_core::schema::rename_vector_collection_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.new_name,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
