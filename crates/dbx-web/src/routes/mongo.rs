use std::future::Future;
use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoParseShellCommandRequest {
    source: String,
}

pub async fn parse_shell_command(
    Json(req): Json<MongoParseShellCommandRequest>,
) -> Result<Json<dbx_core::mongo_shell::MongoCommand>, AppError> {
    dbx_core::mongo_shell::parse(&req.source).map(Json).map_err(AppError::from)
}

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
            _ = token.cancelled() => Err(AppError::from(dbx_core::query::canceled_error())),
            result = future => result.map_err(AppError::from),
        }
    } else {
        future.await.map_err(AppError::from)
    }
}

/// Check if a connection is read-only and return an error if so.
async fn ensure_writable(
    app: &dbx_core::connection::AppState,
    connection_id: &str,
    action: &str,
) -> Result<(), AppError> {
    if let Some(name) = dbx_core::query::connection_readonly_name(app, connection_id).await {
        return Err(AppError::from(format!(
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
pub struct MongoRenameCollectionRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub new_name: String,
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
pub struct MongoFindOneRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub filter: Option<String>,
    pub projection: Option<String>,
    pub options: Option<String>,
    pub execution_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoCountRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub filter: Option<String>,
    pub mode: Option<String>,
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
pub struct MongoCollectionStatsRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub scale: Option<serde_json::Number>,
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
    pub options_json: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDistinctRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub field: String,
    pub filter: Option<String>,
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
    pub options_json: Option<String>,
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
pub struct MongoFindOneAndUpdateRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub filter_json: String,
    pub update_json: String,
    pub options_json: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoFindOneAndReplaceRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub filter_json: String,
    pub replacement_json: String,
    pub options_json: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoFindOneAndDeleteRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub filter_json: String,
    pub options_json: Option<String>,
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
    headers: HeaderMap,
    Json(req): Json<MongoConnectionRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result =
        dbx_core::mongo_ops::mongo_list_databases_core(&state.app, &req.connection_id).await.map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_collections(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoCollectionRequest>,
) -> Result<Json<Vec<dbx_core::document_ops::CollectionInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mongo_ops::mongo_list_collections_core(&state.app, &req.connection_id, &req.database)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorCollectionDetailRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
}

pub async fn vector_collection_detail(
    State(state): State<Arc<WebState>>,
    Json(req): Json<VectorCollectionDetailRequest>,
) -> Result<Json<dbx_core::db::vector_driver::CollectionInfo>, AppError> {
    let result = dbx_core::schema::get_vector_collection_detail_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn create_database(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoCollectionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Create database").await?;
    dbx_core::mongo_ops::mongo_create_database_core(&state.app, &req.connection_id, &req.database)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn drop_database(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoCollectionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Drop database").await?;
    dbx_core::mongo_ops::mongo_drop_database_core(&state.app, &req.connection_id, &req.database)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn drop_collection(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoCollectionNameRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, &req.database, "Drop collection")
        .await?;
    ensure_writable(&state.app, &req.connection_id, "Drop collection").await?;
    dbx_core::mongo_ops::mongo_drop_collection_core(&state.app, &req.connection_id, &req.database, &req.collection)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn rename_collection(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoRenameCollectionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, &req.database, "Rename collection")
        .await?;
    ensure_writable(&state.app, &req.connection_id, "Rename collection").await?;
    dbx_core::mongo_ops::mongo_rename_collection_core(
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

pub async fn find_documents(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoFindRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
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
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn find_one(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MongoFindOneRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = run_cancellable(
        &state,
        req.execution_id,
        dbx_core::mongo_ops::mongo_find_one_core(
            &state.app,
            &req.connection_id,
            &req.database,
            &req.collection,
            req.filter.as_deref(),
            req.projection.as_deref(),
            req.options.as_deref(),
        ),
    )
    .await?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn count_documents(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoCountRequest>,
) -> Result<Json<u64>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = run_cancellable(
        &state,
        req.execution_id,
        dbx_core::mongo_ops::mongo_count_documents_core(
            &state.app,
            &req.connection_id,
            &req.database,
            &req.collection,
            req.filter.as_deref(),
            req.mode.as_deref(),
        ),
    )
    .await?;
    Ok(Json(result))
}

pub async fn server_version(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoServerVersionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = run_cancellable(
        &state,
        req.execution_id.clone(),
        dbx_core::mongo_ops::mongo_server_version_core(&state.app, &req.connection_id, &req.database),
    )
    .await?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn collection_stats(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoCollectionStatsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = run_cancellable(
        &state,
        req.execution_id.clone(),
        dbx_core::mongo_ops::mongo_collection_stats_core(
            &state.app,
            &req.connection_id,
            &req.database,
            &req.collection,
            req.scale,
        ),
    )
    .await?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn aggregate_documents(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoAggregateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    if super::mcp_policy::mongo_pipeline_has_write_stage(&req.pipeline_json) {
        super::mcp_policy::ensure_dangerous_write(
            &state,
            &headers,
            &req.connection_id,
            &req.database,
            "MongoDB aggregate write",
        )
        .await?;
        super::mcp_policy::ensure_mongo_pipeline_target(
            &state,
            &headers,
            &req.connection_id,
            &req.database,
            &req.pipeline_json,
        )
        .await?;
    }
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
            req.options_json.as_deref(),
        ),
    )
    .await?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn distinct(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoDistinctRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = run_cancellable(
        &state,
        req.execution_id.clone(),
        dbx_core::mongo_ops::mongo_distinct_core(
            &state.app,
            &req.connection_id,
            &req.database,
            &req.collection,
            &req.field,
            req.filter.as_deref(),
        ),
    )
    .await?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn create_index(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoCreateIndexRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, &req.database, "Create index")
        .await?;
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
    .map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "name": name })))
}

pub async fn drop_indexes(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoDropIndexesRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, &req.database, "Drop indexes")
        .await?;
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
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
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
        None,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn insert_documents(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoInsertDocumentsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, &req.database, "Insert").await?;
    ensure_writable(&state.app, &req.connection_id, "Insert").await?;
    let result = dbx_core::mongo_ops::mongo_insert_documents_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.docs_json,
    )
    .await
    .map_err(AppError::from)?;
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
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn update_documents(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoUpdateDocumentsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    if super::mcp_policy::mongo_filter_is_effectively_unbounded(&req.filter_json) {
        super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, &req.database, "Update")
            .await?;
    } else {
        super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, &req.database, "Update").await?;
    }
    ensure_writable(&state.app, &req.connection_id, "Update").await?;
    let result = dbx_core::mongo_ops::mongo_update_documents_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.filter_json,
        &req.update_json,
        req.many,
        req.options_json.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "affected_rows": result })))
}

pub async fn find_one_and_update(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoFindOneAndUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_find_one_write_policy(&state, &headers, &req.connection_id, &req.database, &req.filter_json, "Update")
        .await?;
    ensure_writable(&state.app, &req.connection_id, "Update").await?;
    let result = dbx_core::mongo_ops::mongo_find_one_and_update_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.filter_json,
        &req.update_json,
        req.options_json.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn find_one_and_replace(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoFindOneAndReplaceRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_find_one_write_policy(&state, &headers, &req.connection_id, &req.database, &req.filter_json, "Replace")
        .await?;
    ensure_writable(&state.app, &req.connection_id, "Update").await?;
    let result = dbx_core::mongo_ops::mongo_find_one_and_replace_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.filter_json,
        &req.replacement_json,
        req.options_json.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn find_one_and_delete(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoFindOneAndDeleteRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_find_one_write_policy(&state, &headers, &req.connection_id, &req.database, &req.filter_json, "Delete")
        .await?;
    ensure_writable(&state.app, &req.connection_id, "Delete").await?;
    let result = dbx_core::mongo_ops::mongo_find_one_and_delete_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.filter_json,
        req.options_json.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
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
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn delete_documents(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<MongoDeleteDocumentsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    if super::mcp_policy::mongo_filter_is_effectively_unbounded(&req.filter_json) {
        super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, &req.database, "Delete")
            .await?;
    } else {
        super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, &req.database, "Delete").await?;
    }
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
    .map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "affected_rows": result })))
}

async fn ensure_find_one_write_policy(
    state: &Arc<WebState>,
    headers: &HeaderMap,
    connection_id: &str,
    database: &str,
    filter_json: &str,
    action: &str,
) -> Result<(), AppError> {
    if super::mcp_policy::mongo_filter_is_effectively_unbounded(filter_json) {
        super::mcp_policy::ensure_dangerous_write(state, headers, connection_id, database, action).await
    } else {
        super::mcp_policy::ensure_write(state, headers, connection_id, database, action).await
    }
}

#[cfg(test)]
mod tests {
    use super::ensure_find_one_write_policy;
    use crate::state::{LoginRateLimit, WebState};
    use axum::http::{HeaderMap, HeaderValue};
    use dbx_core::connection::AppState;
    use dbx_core::models::connection::ConnectionConfig;
    use dbx_core::storage::{McpGlobalPolicy, Storage};
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use tokio::sync::{Mutex, RwLock};

    fn mongo_config(is_production: bool) -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "mongo-policy-test",
            "name": "Mongo policy test",
            "db_type": "mongodb",
            "host": "localhost",
            "port": 27017,
            "username": "tester",
            "password": "",
            "database": "app",
            "is_production": is_production
        }))
        .unwrap()
    }

    async fn test_web_state() -> (Arc<WebState>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbx-web-mongo-policy-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        let state = Arc::new(WebState {
            app,
            data_dir: dir.clone(),
            public_base_path: "/".to_string(),
            password_disabled: false,
            password_hash: RwLock::new(None),
            sessions: RwLock::new(HashSet::new()),
            sse_channels: RwLock::new(HashMap::new()),
            table_import_channels: RwLock::new(HashMap::new()),
            sql_file_executions: RwLock::new(HashMap::new()),
            login_rate_limit: Mutex::new(LoginRateLimit { fail_count: 0, locked_until: None }),
            export_files: RwLock::new(HashMap::new()),
        });
        (state, dir)
    }

    fn mcp_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-dbx-mcp-request", HeaderValue::from_static("1"));
        headers
    }

    #[tokio::test]
    async fn find_one_writes_recheck_policy_filter_production_and_allowlist() {
        let (state, dir) = test_web_state().await;
        let connection = mongo_config(false);
        state.app.storage.save_connections(std::slice::from_ref(&connection)).await.unwrap();
        let headers = mcp_headers();
        let writable_policy = McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: false,
            allowed_connection_ids: Some(vec![connection.id.clone()]),
        };
        state.app.storage.save_mcp_global_policy(&writable_policy).await.unwrap();

        assert!(ensure_find_one_write_policy(&state, &headers, &connection.id, "app", r#"{"_id":1}"#, "Update")
            .await
            .is_ok());

        state
            .app
            .storage
            .save_mcp_global_policy(&McpGlobalPolicy { read_only: true, ..writable_policy.clone() })
            .await
            .unwrap();
        let revoked = ensure_find_one_write_policy(&state, &headers, &connection.id, "app", r#"{"_id":1}"#, "Update")
            .await
            .unwrap_err();
        assert!(revoked.message.starts_with("MCP_READ_ONLY:"), "{}", revoked.message);

        state.app.storage.save_mcp_global_policy(&writable_policy).await.unwrap();
        let empty_filter =
            ensure_find_one_write_policy(&state, &headers, &connection.id, "app", "{}", "Delete").await.unwrap_err();
        assert!(empty_filter.message.starts_with("SQL_BLOCKED:"), "{}", empty_filter.message);

        state
            .app
            .storage
            .save_mcp_global_policy(&McpGlobalPolicy { allow_dangerous_sql: true, ..writable_policy.clone() })
            .await
            .unwrap();
        assert!(ensure_find_one_write_policy(&state, &headers, &connection.id, "app", "{}", "Replace").await.is_ok());

        state.app.storage.save_connections(&[mongo_config(true)]).await.unwrap();
        let production =
            ensure_find_one_write_policy(&state, &headers, &connection.id, "app", r#"{"_id":1}"#, "Update")
                .await
                .unwrap_err();
        assert!(production.message.starts_with("PRODUCTION_DATABASE_READ_ONLY:"), "{}", production.message);

        state.app.storage.save_connections(std::slice::from_ref(&connection)).await.unwrap();
        state
            .app
            .storage
            .save_mcp_global_policy(&McpGlobalPolicy {
                read_only: false,
                allow_dangerous_sql: true,
                allowed_connection_ids: Some(vec!["different-connection".to_string()]),
            })
            .await
            .unwrap();
        let allowlist = ensure_find_one_write_policy(&state, &headers, &connection.id, "app", r#"{"_id":1}"#, "Delete")
            .await
            .unwrap_err();
        assert!(allowlist.message.starts_with("CONNECTION_OUT_OF_SCOPE:"), "{}", allowlist.message);

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
}
