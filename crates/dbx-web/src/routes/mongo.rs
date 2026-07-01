use std::future::Future;
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

async fn run_cancellable<T, F>(state: &Arc<WebState>, execution_id: Option<String>, future: F) -> Result<T, AppError>
where
    F: Future<Output = Result<T, String>>,
{
    let registered = execution_id
        .as_ref()
        .filter(|id| !id.trim().is_empty())
        .map(|id| state.app.running_queries.register(id.clone()));
    if let Some(query) = registered.as_ref() {
        let token = query.token();
        tokio::select! {
            biased;
            _ = token.cancelled() => Err(AppError(dbx_core::query::canceled_error())),
            result = future => result.map_err(AppError),
        }
    } else {
        future.await.map_err(AppError)
    }
}

/// Check if a connection is read-only and return an error if so.
async fn ensure_writable(
    app: &dbx_core::connection::AppState,
    connection_id: &str,
    action: &str,
) -> Result<(), AppError> {
    if let Some(name) = dbx_core::query::connection_readonly_name(app, connection_id).await {
        return Err(AppError(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. {} blocked.",
            name, action
        )));
    }
    Ok(())
}

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
pub struct MongoCollectionNameRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoFindRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub skip: Option<u64>,
    pub limit: Option<i64>,
    pub filter: Option<String>,
    pub projection: Option<String>,
    pub sort: Option<String>,
    pub execution_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoServerVersionRequest {
    pub connection_id: String,
    pub database: String,
    pub execution_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoAggregateRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub pipeline_json: String,
    pub max_rows: Option<usize>,
    pub execution_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoCreateIndexRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub keys_json: String,
    pub options_json: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDropIndexesRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub indexes_json: Option<String>,
    pub single: bool,
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
pub struct MongoInsertDocumentsRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub docs_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoUpdateDocumentsRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub filter_json: String,
    pub update_json: String,
    pub many: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDeleteDocumentsRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub filter_json: String,
    pub many: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoUpdateRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub id: String,
    pub doc_json: String,
    pub routing: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDeleteRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub id: String,
    pub routing: Option<String>,
}

pub async fn list_databases(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoConnectionRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    let result =
        dbx_core::mongo_ops::mongo_list_databases_core(&state.app, &req.connection_id).await.map_err(AppError)?;
    Ok(Json(result))
}

pub async fn list_collections(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoCollectionRequest>,
) -> Result<Json<Vec<dbx_core::document_ops::CollectionInfo>>, AppError> {
    let result = dbx_core::mongo_ops::mongo_list_collections_core(&state.app, &req.connection_id, &req.database)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn create_database(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoCollectionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Create database").await?;
    dbx_core::mongo_ops::mongo_create_database_core(&state.app, &req.connection_id, &req.database)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn drop_database(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoCollectionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Drop database").await?;
    dbx_core::mongo_ops::mongo_drop_database_core(&state.app, &req.connection_id, &req.database)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn drop_collection(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoCollectionNameRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Drop collection").await?;
    dbx_core::mongo_ops::mongo_drop_collection_core(&state.app, &req.connection_id, &req.database, &req.collection)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn find_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoFindRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = run_cancellable(
        &state,
        req.execution_id.clone(),
        dbx_core::document_ops::find_documents_core(
            &state.app,
            &req.connection_id,
            &req.database,
            &req.collection,
            req.skip.unwrap_or(0),
            req.limit.unwrap_or(50),
            req.filter.as_deref(),
            req.projection.as_deref(),
            req.sort.as_deref(),
        ),
    )
    .await?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn server_version(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoServerVersionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = run_cancellable(
        &state,
        req.execution_id.clone(),
        dbx_core::mongo_ops::mongo_server_version_core(&state.app, &req.connection_id, &req.database),
    )
    .await?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn aggregate_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoAggregateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = run_cancellable(
        &state,
        req.execution_id.clone(),
        dbx_core::mongo_ops::mongo_aggregate_documents_core(
            &state.app,
            &req.connection_id,
            &req.database,
            &req.collection,
            &req.pipeline_json,
            req.max_rows,
        ),
    )
    .await?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn create_index(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoCreateIndexRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Create index").await?;
    let name = dbx_core::mongo_ops::mongo_create_index_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.keys_json,
        req.options_json.as_deref(),
    )
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::json!({ "name": name })))
}

pub async fn drop_indexes(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoDropIndexesRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Drop indexes").await?;
    let result = dbx_core::mongo_ops::mongo_drop_indexes_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        req.indexes_json.as_deref(),
        req.single,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn insert_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoInsertRequest>,
) -> Result<Json<String>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Insert").await?;
    let result = dbx_core::document_ops::insert_document_core(
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

pub async fn insert_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoInsertDocumentsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Insert").await?;
    let result = dbx_core::mongo_ops::mongo_insert_documents_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.docs_json,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::json!({ "affected_rows": result })))
}

pub async fn update_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoUpdateRequest>,
) -> Result<Json<u64>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Update").await?;
    let result = dbx_core::document_ops::update_document_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.id,
        &req.doc_json,
        req.routing.as_deref(),
    )
    .await
    .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn update_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoUpdateDocumentsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Update").await?;
    let result = dbx_core::mongo_ops::mongo_update_documents_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.filter_json,
        &req.update_json,
        req.many,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::json!({ "affected_rows": result })))
}

pub async fn delete_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoDeleteRequest>,
) -> Result<Json<u64>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete").await?;
    let result = dbx_core::document_ops::delete_document_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.id,
        req.routing.as_deref(),
    )
    .await
    .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn delete_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoDeleteDocumentsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete").await?;
    let result = dbx_core::mongo_ops::mongo_delete_documents_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.filter_json,
        req.many,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::json!({ "affected_rows": result })))
}
