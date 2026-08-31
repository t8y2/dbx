use std::future::Future;
use std::sync::Arc;

use axum::extract::{Multipart, State};
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
            _ = token.cancelled() => Err(AppError::from(dbx_core::query::canceled_error())),
            result = future => result.map_err(AppError::from),
        }
    } else {
        future.await.map_err(AppError::from)
    }
}

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
pub struct DocumentListDatabasesRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentListCollectionsRequest {
    pub connection_id: String,
    pub database: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFindRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub skip: Option<u64>,
    pub limit: Option<i64>,
    pub filter: Option<String>,
    pub projection: Option<String>,
    pub sort: Option<String>,
    pub collation: Option<String>,
    pub cursor: Option<String>,
    #[serde(default)]
    pub cursor_pagination: bool,
    pub execution_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCountRequest {
    pub connection_id: String,
    pub collection: String,
    pub filter: Option<String>,
    pub execution_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamoDbDescribeTableRequest {
    pub connection_id: String,
    pub table: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElasticsearchCountDocumentsRequest {
    pub connection_id: String,
    pub index: String,
    pub filter: Option<String>,
    pub execution_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElasticsearchIndexRequest {
    pub connection_id: String,
    pub index: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElasticsearchIndexMetadataRequest {
    pub connection_id: String,
    pub index: String,
    pub kind: dbx_core::document_ops::ElasticsearchIndexMetadataKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInsertRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub doc_json: String,
    pub routing: Option<String>,
    pub preserve_bson_types: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUpdateRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub id: String,
    pub doc_json: String,
    pub routing: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDeleteRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub id: String,
    pub routing: Option<String>,
    pub document_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchBatchSaveRequest {
    pub connection_id: String,
    pub collection: String,
    pub updates: Vec<dbx_core::db::meilisearch_driver::MeilisearchDocumentUpdate>,
    pub delete_ids: Vec<String>,
    pub inserts: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchSearchRequest {
    pub connection_id: String,
    pub index: String,
    pub q: Option<String>,
    pub filter: Option<String>,
    pub sort: Option<String>,
    pub limit: u64,
    pub offset: u64,
    pub hybrid_embedder: Option<String>,
    pub hybrid_semantic_ratio: Option<f64>,
    pub show_ranking_score: Option<bool>,
    pub ranking_score_threshold: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchDocumentPageRequest {
    pub connection_id: String,
    pub index: String,
    pub filter: Option<String>,
    pub sort: Option<String>,
    pub limit: u64,
    pub offset: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchIndexRequest {
    pub connection_id: String,
    pub index: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchDocumentGetRequest {
    pub connection_id: String,
    pub index: String,
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchSettingsUpdateRequest {
    pub connection_id: String,
    pub index: String,
    pub settings: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchConnectionRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchKeyListRequest {
    pub connection_id: String,
    pub offset: Option<u64>,
    pub limit: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchKeyRequest {
    pub connection_id: String,
    pub uid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchKeyCreateRequest {
    pub connection_id: String,
    pub input: dbx_core::db::meilisearch_driver::MeilisearchKeyCreateInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchKeyUpdateRequest {
    pub connection_id: String,
    pub uid: String,
    pub input: dbx_core::db::meilisearch_driver::MeilisearchKeyUpdateInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchTaskListRequest {
    pub connection_id: String,
    pub input: dbx_core::db::meilisearch_driver::MeilisearchTaskListInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchTaskRequest {
    pub connection_id: String,
    pub uid: u64,
    pub expected_index_uid: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchTaskMutationRequest {
    pub connection_id: String,
    pub selector: dbx_core::db::meilisearch_driver::MeilisearchTaskSelector,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFsBucketRequest {
    pub connection_id: String,
    pub database: String,
    pub bucket: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFsFileListRequest {
    pub connection_id: String,
    pub database: String,
    pub bucket: String,
    pub filter: Option<String>,
    pub sort: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFsBucketListRequest {
    pub connection_id: String,
    pub database: String,
    pub filter: Option<String>,
    pub sort: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFsDownloadRequest {
    pub connection_id: String,
    pub database: String,
    pub bucket: String,
    pub file_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFsFileDeleteRequest {
    pub connection_id: String,
    pub database: String,
    pub bucket: String,
    pub file_id: String,
}

pub async fn list_databases(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentListDatabasesRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    let result =
        dbx_core::document_ops::list_databases_core(&state.app, &req.connection_id).await.map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_collections(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentListCollectionsRequest>,
) -> Result<Json<Vec<dbx_core::document_ops::CollectionInfo>>, AppError> {
    let result = dbx_core::document_ops::list_collections_core(&state.app, &req.connection_id, &req.database)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn find_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentFindRequest>,
) -> Result<Json<dbx_core::db::document_result::DocumentQueryResult>, AppError> {
    let result = run_cancellable(
        &state,
        req.execution_id,
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
            req.collation.as_deref(),
            req.cursor.as_deref(),
            req.cursor_pagination,
        ),
    )
    .await?;
    Ok(Json(result))
}

pub async fn count_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentCountRequest>,
) -> Result<Json<u64>, AppError> {
    let result = run_cancellable(
        &state,
        req.execution_id,
        dbx_core::document_ops::count_document_store_documents_core(
            &state.app,
            &req.connection_id,
            &req.collection,
            req.filter.as_deref(),
        ),
    )
    .await?;
    Ok(Json(result))
}

pub async fn describe_dynamodb_table(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DynamoDbDescribeTableRequest>,
) -> Result<Json<dbx_core::db::dynamodb_driver::DynamoDbTableDescription>, AppError> {
    let result = dbx_core::document_ops::describe_dynamodb_table_core(&state.app, &req.connection_id, &req.table)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn elasticsearch_count_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ElasticsearchCountDocumentsRequest>,
) -> Result<Json<u64>, AppError> {
    let result = run_cancellable(
        &state,
        req.execution_id,
        dbx_core::document_ops::count_elasticsearch_documents_core(
            &state.app,
            &req.connection_id,
            &req.index,
            req.filter.as_deref(),
        ),
    )
    .await?;
    Ok(Json(result))
}

pub async fn elasticsearch_get_index_metadata(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ElasticsearchIndexMetadataRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::document_ops::elasticsearch_get_index_metadata_core(
        &state.app,
        &req.connection_id,
        &req.index,
        req.kind,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn elasticsearch_delete_all_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ElasticsearchIndexRequest>,
) -> Result<Json<dbx_core::db::elasticsearch_driver::ElasticsearchDeleteByQueryResult>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete all documents").await?;
    let result =
        dbx_core::document_ops::elasticsearch_delete_all_documents_core(&state.app, &req.connection_id, &req.index)
            .await
            .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn insert_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentInsertRequest>,
) -> Result<Json<String>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Insert").await?;
    let result = if req.preserve_bson_types.unwrap_or(false) {
        dbx_core::document_ops::insert_document_preserving_bson_types_core(
            &state.app,
            &req.connection_id,
            &req.database,
            &req.collection,
            &req.doc_json,
            req.routing.as_deref(),
        )
        .await
    } else {
        dbx_core::document_ops::insert_document_core(
            &state.app,
            &req.connection_id,
            &req.database,
            &req.collection,
            &req.doc_json,
            req.routing.as_deref(),
        )
        .await
    }
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn update_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentUpdateRequest>,
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

pub async fn delete_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentDeleteRequest>,
) -> Result<Json<u64>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete").await?;
    let result = dbx_core::document_ops::delete_document_core_with_type(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.id,
        req.routing.as_deref(),
        req.document_type.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn save_meilisearch_batch(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchBatchSaveRequest>,
) -> Result<Json<u64>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Save").await?;
    let result = dbx_core::document_ops::save_meilisearch_document_batch_core(
        &state.app,
        &req.connection_id,
        &req.collection,
        &req.updates,
        &req.delete_ids,
        &req.inserts,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_search(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchSearchRequest>,
) -> Result<Json<dbx_core::db::meilisearch_driver::MeilisearchSearchResult>, AppError> {
    let result = dbx_core::document_ops::meilisearch_search_documents_core(
        &state.app,
        &req.connection_id,
        &req.index,
        req.q.as_deref(),
        req.filter.as_deref(),
        req.sort.as_deref(),
        req.limit,
        req.offset,
        req.hybrid_embedder.as_deref(),
        req.hybrid_semantic_ratio,
        req.show_ranking_score.unwrap_or(false),
        req.ranking_score_threshold,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_fetch_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchDocumentPageRequest>,
) -> Result<Json<dbx_core::db::meilisearch_driver::MeilisearchDocumentPage>, AppError> {
    let result = dbx_core::document_ops::meilisearch_fetch_document_page_core(
        &state.app,
        &req.connection_id,
        &req.index,
        req.filter.as_deref(),
        req.sort.as_deref(),
        req.limit,
        req.offset,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_get_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchDocumentGetRequest>,
) -> Result<Json<String>, AppError> {
    let result =
        dbx_core::document_ops::meilisearch_get_document_core(&state.app, &req.connection_id, &req.index, &req.id)
            .await
            .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_get_settings(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchIndexRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result =
        dbx_core::document_ops::meilisearch_get_index_settings_core(&state.app, &req.connection_id, &req.index)
            .await
            .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_update_settings(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchSettingsUpdateRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Update settings").await?;
    dbx_core::document_ops::meilisearch_update_index_settings_core(
        &state.app,
        &req.connection_id,
        &req.index,
        &req.settings,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn meilisearch_get_stats(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchIndexRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::document_ops::meilisearch_get_index_stats_core(&state.app, &req.connection_id, &req.index)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_get_overview(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchIndexRequest>,
) -> Result<Json<dbx_core::db::meilisearch_driver::MeilisearchIndexOverview>, AppError> {
    let result =
        dbx_core::document_ops::meilisearch_get_index_overview_core(&state.app, &req.connection_id, &req.index)
            .await
            .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_delete_index(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchIndexRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete index").await?;
    dbx_core::document_ops::meilisearch_delete_index_core(&state.app, &req.connection_id, &req.index)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn meilisearch_delete_all_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchIndexRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete all documents").await?;
    dbx_core::document_ops::meilisearch_delete_all_documents_core(&state.app, &req.connection_id, &req.index)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn meilisearch_get_system_overview(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchConnectionRequest>,
) -> Result<Json<dbx_core::db::meilisearch_driver::MeilisearchSystemOverview>, AppError> {
    let result = dbx_core::document_ops::meilisearch_get_system_overview_core(&state.app, &req.connection_id)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_list_keys(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchKeyListRequest>,
) -> Result<Json<dbx_core::db::meilisearch_driver::MeilisearchKeyPage>, AppError> {
    let result = dbx_core::document_ops::meilisearch_list_keys_core(
        &state.app,
        &req.connection_id,
        req.offset.unwrap_or(0),
        req.limit.unwrap_or(20),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_get_key(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchKeyRequest>,
) -> Result<Json<dbx_core::db::meilisearch_driver::MeilisearchKeyListItem>, AppError> {
    let result = dbx_core::document_ops::meilisearch_get_key_core(&state.app, &req.connection_id, &req.uid)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_create_key(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchKeyCreateRequest>,
) -> Result<Json<dbx_core::db::meilisearch_driver::MeilisearchCreatedKey>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Create API key").await?;
    let result = dbx_core::document_ops::meilisearch_create_key_core(&state.app, &req.connection_id, &req.input)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_update_key(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchKeyUpdateRequest>,
) -> Result<Json<dbx_core::db::meilisearch_driver::MeilisearchKeyListItem>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Update API key").await?;
    let result =
        dbx_core::document_ops::meilisearch_update_key_core(&state.app, &req.connection_id, &req.uid, &req.input)
            .await
            .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_delete_key(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchKeyRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete API key").await?;
    dbx_core::document_ops::meilisearch_delete_key_core(&state.app, &req.connection_id, &req.uid)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn meilisearch_get_tasks(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchTaskListRequest>,
) -> Result<Json<dbx_core::db::meilisearch_driver::MeilisearchTaskPage>, AppError> {
    let result = dbx_core::document_ops::meilisearch_get_tasks_core(
        &state.app,
        &req.connection_id,
        &req.input.selector,
        req.input.from,
        req.input.limit.unwrap_or(20),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_get_task(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchTaskRequest>,
) -> Result<Json<dbx_core::db::meilisearch_driver::MeilisearchTask>, AppError> {
    let result = dbx_core::document_ops::meilisearch_get_task_core(
        &state.app,
        &req.connection_id,
        req.uid,
        req.expected_index_uid.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_cancel_tasks(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchTaskMutationRequest>,
) -> Result<Json<dbx_core::db::meilisearch_driver::MeilisearchEnqueuedTaskSummary>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Cancel tasks").await?;
    let result = dbx_core::document_ops::meilisearch_cancel_tasks_core(&state.app, &req.connection_id, &req.selector)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn meilisearch_delete_tasks(
    State(state): State<Arc<WebState>>,
    Json(req): Json<MeilisearchTaskMutationRequest>,
) -> Result<Json<dbx_core::db::meilisearch_driver::MeilisearchEnqueuedTaskSummary>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete tasks").await?;
    let result = dbx_core::document_ops::meilisearch_delete_tasks_core(&state.app, &req.connection_id, &req.selector)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_gridfs_files(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GridFsFileListRequest>,
) -> Result<Json<Vec<dbx_core::document_ops::MongoGridFsFileInfo>>, AppError> {
    let result = dbx_core::document_ops::list_gridfs_files_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.bucket,
        req.filter.as_deref(),
        req.sort.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_gridfs_buckets(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GridFsBucketListRequest>,
) -> Result<Json<Vec<dbx_core::document_ops::MongoGridFsBucketInfo>>, AppError> {
    let result = dbx_core::document_ops::list_gridfs_buckets_core(
        &state.app,
        &req.connection_id,
        &req.database,
        req.filter.as_deref(),
        req.sort.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn create_gridfs_bucket(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GridFsBucketRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Create GridFS bucket").await?;
    dbx_core::document_ops::create_gridfs_bucket_core(&state.app, &req.connection_id, &req.database, &req.bucket)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn delete_gridfs_bucket(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GridFsBucketRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete GridFS bucket").await?;
    dbx_core::document_ops::delete_gridfs_bucket_core(&state.app, &req.connection_id, &req.database, &req.bucket)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn download_gridfs_file(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GridFsDownloadRequest>,
) -> Result<Json<Vec<u8>>, AppError> {
    let result = dbx_core::document_ops::download_gridfs_file_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.bucket,
        &req.file_id,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn upload_gridfs_file(
    State(state): State<Arc<WebState>>,
    mut multipart: Multipart,
) -> Result<Json<String>, AppError> {
    let mut connection_id: Option<String> = None;
    let mut database: Option<String> = None;
    let mut bucket: Option<String> = None;
    let mut file_name: Option<String> = None;
    let mut content_type: Option<String> = None;
    let mut file_bytes: Option<Vec<u8>> = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| AppError::from(e.to_string()))? {
        let name = field.name().unwrap_or_default().to_string();
        match name.as_str() {
            "connectionId" => connection_id = Some(field.text().await.map_err(|e| AppError::from(e.to_string()))?),
            "database" => database = Some(field.text().await.map_err(|e| AppError::from(e.to_string()))?),
            "bucket" => bucket = Some(field.text().await.map_err(|e| AppError::from(e.to_string()))?),
            "fileName" => file_name = Some(field.text().await.map_err(|e| AppError::from(e.to_string()))?),
            "contentType" => content_type = Some(field.text().await.map_err(|e| AppError::from(e.to_string()))?),
            "file" => {
                if file_name.is_none() {
                    file_name = field.file_name().map(str::to_string);
                }
                if content_type.is_none() {
                    content_type = field.content_type().map(str::to_string);
                }
                file_bytes = Some(field.bytes().await.map_err(|e| AppError::from(e.to_string()))?.to_vec());
            }
            _ => {
                let _ = field.bytes().await;
            }
        }
    }

    let connection_id = connection_id.ok_or_else(|| AppError::from("Missing connectionId".to_string()))?;
    let database = database.ok_or_else(|| AppError::from("Missing database".to_string()))?;
    let bucket = bucket.ok_or_else(|| AppError::from("Missing bucket".to_string()))?;
    let file_name = file_name.ok_or_else(|| AppError::from("Missing fileName".to_string()))?;
    let file_bytes = file_bytes.ok_or_else(|| AppError::from("No file uploaded".to_string()))?;

    ensure_writable(&state.app, &connection_id, "Upload GridFS file").await?;
    let result = dbx_core::document_ops::upload_gridfs_file_core(
        &state.app,
        &connection_id,
        &database,
        &bucket,
        &file_name,
        &file_bytes,
        content_type.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn delete_gridfs_file(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GridFsFileDeleteRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete GridFS file").await?;
    dbx_core::document_ops::delete_gridfs_file_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.bucket,
        &req.file_id,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(()))
}
