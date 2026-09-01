use std::future::Future;
use std::sync::Arc;
use tauri::State;

use crate::commands::connection::{ensure_connection_writable, AppState};
use dbx_core::db::document_result::DocumentQueryResult;
use dbx_core::document_ops::CollectionInfo;

pub(crate) async fn run_cancellable<T, F>(
    state: &Arc<AppState>,
    execution_id: Option<String>,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    let registered_query =
        execution_id.as_ref().filter(|id| !id.trim().is_empty()).map(|id| state.running_queries.register(id.clone()));
    if let Some(query) = registered_query.as_ref() {
        let token = query.token();
        tokio::select! {
            biased;
            _ = token.cancelled() => Err(dbx_core::query::canceled_error()),
            result = future => result,
        }
    } else {
        future.await
    }
}

#[tauri::command]
pub async fn document_list_databases(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<String>, String> {
    dbx_core::document_ops::list_databases_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn document_list_collections(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<Vec<CollectionInfo>, String> {
    dbx_core::document_ops::list_collections_core(&state, &connection_id, &database).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn document_find_documents(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    skip: u64,
    limit: i64,
    filter: Option<String>,
    projection: Option<String>,
    sort: Option<String>,
    collation: Option<String>,
    cursor: Option<String>,
    cursor_pagination: Option<bool>,
    execution_id: Option<String>,
) -> Result<DocumentQueryResult, String> {
    let app = state.inner().clone();
    run_cancellable(
        &app,
        execution_id,
        dbx_core::document_ops::find_documents_core(
            &app,
            &connection_id,
            &database,
            &collection,
            skip,
            limit,
            filter.as_deref(),
            projection.as_deref(),
            sort.as_deref(),
            collation.as_deref(),
            cursor.as_deref(),
            cursor_pagination.unwrap_or(false),
        ),
    )
    .await
}

#[tauri::command]
pub async fn document_count_documents(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    collection: String,
    filter: Option<String>,
    execution_id: Option<String>,
) -> Result<u64, String> {
    let app = state.inner().clone();
    run_cancellable(
        &app,
        execution_id,
        dbx_core::document_ops::count_document_store_documents_core(
            &app,
            &connection_id,
            &collection,
            filter.as_deref(),
        ),
    )
    .await
}

#[tauri::command]
pub async fn dynamodb_describe_table(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    table: String,
) -> Result<dbx_core::db::dynamodb_driver::DynamoDbTableDescription, String> {
    dbx_core::document_ops::describe_dynamodb_table_core(&state, &connection_id, &table).await
}

#[tauri::command]
pub async fn elasticsearch_count_documents(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    index: String,
    filter: Option<String>,
    execution_id: Option<String>,
) -> Result<u64, String> {
    let app = state.inner().clone();
    run_cancellable(
        &app,
        execution_id,
        dbx_core::document_ops::count_elasticsearch_documents_core(&app, &connection_id, &index, filter.as_deref()),
    )
    .await
}

#[tauri::command]
pub async fn elasticsearch_get_index_metadata(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    index: String,
    kind: dbx_core::document_ops::ElasticsearchIndexMetadataKind,
) -> Result<serde_json::Value, String> {
    dbx_core::document_ops::elasticsearch_get_index_metadata_core(&state, &connection_id, &index, kind).await
}

#[tauri::command]
pub async fn elasticsearch_delete_all_documents(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    index: String,
) -> Result<dbx_core::db::elasticsearch_driver::ElasticsearchDeleteByQueryResult, String> {
    ensure_connection_writable(&state, &connection_id, "Delete all documents").await?;
    dbx_core::document_ops::elasticsearch_delete_all_documents_core(&state, &connection_id, &index).await
}

#[tauri::command]
pub async fn document_insert_document(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    doc_json: String,
    routing: Option<String>,
    preserve_bson_types: Option<bool>,
) -> Result<String, String> {
    ensure_connection_writable(&state, &connection_id, "Insert").await?;
    if preserve_bson_types.unwrap_or(false) {
        dbx_core::document_ops::insert_document_preserving_bson_types_core(
            &state,
            &connection_id,
            &database,
            &collection,
            &doc_json,
            routing.as_deref(),
        )
        .await
    } else {
        dbx_core::document_ops::insert_document_core(
            &state,
            &connection_id,
            &database,
            &collection,
            &doc_json,
            routing.as_deref(),
        )
        .await
    }
}

#[tauri::command]
pub async fn document_update_document(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    id: String,
    doc_json: String,
    routing: Option<String>,
) -> Result<u64, String> {
    ensure_connection_writable(&state, &connection_id, "Update").await?;
    dbx_core::document_ops::update_document_core(
        &state,
        &connection_id,
        &database,
        &collection,
        &id,
        &doc_json,
        routing.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn document_delete_document(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    id: String,
    routing: Option<String>,
    document_type: Option<String>,
) -> Result<u64, String> {
    ensure_connection_writable(&state, &connection_id, "Delete").await?;
    dbx_core::document_ops::delete_document_core_with_type(
        &state,
        &connection_id,
        &database,
        &collection,
        &id,
        routing.as_deref(),
        document_type.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn document_save_meilisearch_batch(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    collection: String,
    updates: Vec<dbx_core::db::meilisearch_driver::MeilisearchDocumentUpdate>,
    delete_ids: Vec<String>,
    inserts: Vec<String>,
) -> Result<u64, String> {
    ensure_connection_writable(&state, &connection_id, "Save").await?;
    dbx_core::document_ops::save_meilisearch_document_batch_core(
        &state,
        &connection_id,
        &collection,
        &updates,
        &delete_ids,
        &inserts,
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn meilisearch_search_documents(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    index: String,
    q: Option<String>,
    filter: Option<String>,
    sort: Option<String>,
    limit: u64,
    offset: u64,
    hybrid_embedder: Option<String>,
    hybrid_semantic_ratio: Option<f64>,
    show_ranking_score: Option<bool>,
    ranking_score_threshold: Option<f64>,
) -> Result<dbx_core::db::meilisearch_driver::MeilisearchSearchResult, String> {
    dbx_core::document_ops::meilisearch_search_documents_core(
        &state,
        &connection_id,
        &index,
        q.as_deref(),
        filter.as_deref(),
        sort.as_deref(),
        limit,
        offset,
        hybrid_embedder.as_deref(),
        hybrid_semantic_ratio,
        show_ranking_score.unwrap_or(false),
        ranking_score_threshold,
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn meilisearch_fetch_documents(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    index: String,
    filter: Option<String>,
    sort: Option<String>,
    limit: u64,
    offset: u64,
) -> Result<dbx_core::db::meilisearch_driver::MeilisearchDocumentPage, String> {
    dbx_core::document_ops::meilisearch_fetch_document_page_core(
        &state,
        &connection_id,
        &index,
        filter.as_deref(),
        sort.as_deref(),
        limit,
        offset,
    )
    .await
}

#[tauri::command]
pub async fn meilisearch_get_document(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    index: String,
    id: String,
) -> Result<String, String> {
    dbx_core::document_ops::meilisearch_get_document_core(&state, &connection_id, &index, &id).await
}

#[tauri::command]
pub async fn meilisearch_get_index_settings(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    index: String,
) -> Result<serde_json::Value, String> {
    dbx_core::document_ops::meilisearch_get_index_settings_core(&state, &connection_id, &index).await
}

#[tauri::command]
pub async fn meilisearch_update_index_settings(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    index: String,
    settings: serde_json::Value,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Update settings").await?;
    dbx_core::document_ops::meilisearch_update_index_settings_core(&state, &connection_id, &index, &settings).await
}

#[tauri::command]
pub async fn meilisearch_get_index_stats(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    index: String,
) -> Result<serde_json::Value, String> {
    dbx_core::document_ops::meilisearch_get_index_stats_core(&state, &connection_id, &index).await
}

#[tauri::command]
pub async fn meilisearch_get_index_overview(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    index: String,
) -> Result<dbx_core::db::meilisearch_driver::MeilisearchIndexOverview, String> {
    dbx_core::document_ops::meilisearch_get_index_overview_core(&state, &connection_id, &index).await
}

#[tauri::command]
pub async fn meilisearch_delete_index(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    index: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Delete index").await?;
    dbx_core::document_ops::meilisearch_delete_index_core(&state, &connection_id, &index).await
}

#[tauri::command]
pub async fn meilisearch_delete_all_documents(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    index: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Delete all documents").await?;
    dbx_core::document_ops::meilisearch_delete_all_documents_core(&state, &connection_id, &index).await
}

#[tauri::command]
pub async fn meilisearch_get_system_overview(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<dbx_core::db::meilisearch_driver::MeilisearchSystemOverview, String> {
    dbx_core::document_ops::meilisearch_get_system_overview_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn meilisearch_list_keys(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    offset: u64,
    limit: u64,
) -> Result<dbx_core::db::meilisearch_driver::MeilisearchKeyPage, String> {
    dbx_core::document_ops::meilisearch_list_keys_core(&state, &connection_id, offset, limit).await
}

#[tauri::command]
pub async fn meilisearch_get_key(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    uid: String,
) -> Result<dbx_core::db::meilisearch_driver::MeilisearchKeyListItem, String> {
    dbx_core::document_ops::meilisearch_get_key_core(&state, &connection_id, &uid).await
}

#[tauri::command]
pub async fn meilisearch_create_key(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    input: dbx_core::db::meilisearch_driver::MeilisearchKeyCreateInput,
) -> Result<dbx_core::db::meilisearch_driver::MeilisearchCreatedKey, String> {
    ensure_connection_writable(&state, &connection_id, "Create API key").await?;
    dbx_core::document_ops::meilisearch_create_key_core(&state, &connection_id, &input).await
}

#[tauri::command]
pub async fn meilisearch_update_key(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    uid: String,
    input: dbx_core::db::meilisearch_driver::MeilisearchKeyUpdateInput,
) -> Result<dbx_core::db::meilisearch_driver::MeilisearchKeyListItem, String> {
    ensure_connection_writable(&state, &connection_id, "Update API key").await?;
    dbx_core::document_ops::meilisearch_update_key_core(&state, &connection_id, &uid, &input).await
}

#[tauri::command]
pub async fn meilisearch_delete_key(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    uid: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Delete API key").await?;
    dbx_core::document_ops::meilisearch_delete_key_core(&state, &connection_id, &uid).await
}

#[tauri::command]
pub async fn meilisearch_get_tasks(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    input: dbx_core::db::meilisearch_driver::MeilisearchTaskListInput,
) -> Result<dbx_core::db::meilisearch_driver::MeilisearchTaskPage, String> {
    dbx_core::document_ops::meilisearch_get_tasks_core(
        &state,
        &connection_id,
        &input.selector,
        input.from,
        input.limit.unwrap_or(20),
    )
    .await
}

#[tauri::command]
pub async fn meilisearch_get_task(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    uid: u64,
    expected_index_uid: Option<String>,
) -> Result<dbx_core::db::meilisearch_driver::MeilisearchTask, String> {
    dbx_core::document_ops::meilisearch_get_task_core(&state, &connection_id, uid, expected_index_uid.as_deref()).await
}

#[tauri::command]
pub async fn meilisearch_cancel_tasks(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    selector: dbx_core::db::meilisearch_driver::MeilisearchTaskSelector,
) -> Result<dbx_core::db::meilisearch_driver::MeilisearchEnqueuedTaskSummary, String> {
    ensure_connection_writable(&state, &connection_id, "Cancel tasks").await?;
    dbx_core::document_ops::meilisearch_cancel_tasks_core(&state, &connection_id, &selector).await
}

#[tauri::command]
pub async fn meilisearch_delete_tasks(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    selector: dbx_core::db::meilisearch_driver::MeilisearchTaskSelector,
) -> Result<dbx_core::db::meilisearch_driver::MeilisearchEnqueuedTaskSummary, String> {
    ensure_connection_writable(&state, &connection_id, "Delete tasks").await?;
    dbx_core::document_ops::meilisearch_delete_tasks_core(&state, &connection_id, &selector).await
}

#[tauri::command]
pub async fn document_list_gridfs_buckets(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    filter: Option<String>,
    sort: Option<String>,
) -> Result<Vec<dbx_core::document_ops::MongoGridFsBucketInfo>, String> {
    dbx_core::document_ops::list_gridfs_buckets_core(
        &state,
        &connection_id,
        &database,
        filter.as_deref(),
        sort.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn document_create_gridfs_bucket(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    bucket: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Create GridFS bucket").await?;
    dbx_core::document_ops::create_gridfs_bucket_core(&state, &connection_id, &database, &bucket).await
}

#[tauri::command]
pub async fn document_delete_gridfs_bucket(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    bucket: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Delete GridFS bucket").await?;
    dbx_core::document_ops::delete_gridfs_bucket_core(&state, &connection_id, &database, &bucket).await
}

#[tauri::command]
pub async fn document_list_gridfs_files(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    bucket: String,
    filter: Option<String>,
    sort: Option<String>,
) -> Result<Vec<dbx_core::document_ops::MongoGridFsFileInfo>, String> {
    dbx_core::document_ops::list_gridfs_files_core(
        &state,
        &connection_id,
        &database,
        &bucket,
        filter.as_deref(),
        sort.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn document_download_gridfs_file(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    bucket: String,
    file_id: String,
) -> Result<Vec<u8>, String> {
    dbx_core::document_ops::download_gridfs_file_core(&state, &connection_id, &database, &bucket, &file_id).await
}

#[tauri::command]
pub async fn document_upload_gridfs_file(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    bucket: String,
    file_name: String,
    data: Vec<u8>,
    content_type: Option<String>,
) -> Result<String, String> {
    ensure_connection_writable(&state, &connection_id, "Upload GridFS file").await?;
    dbx_core::document_ops::upload_gridfs_file_core(
        &state,
        &connection_id,
        &database,
        &bucket,
        &file_name,
        &data,
        content_type.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn document_delete_gridfs_file(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    bucket: String,
    file_id: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Delete GridFS file").await?;
    dbx_core::document_ops::delete_gridfs_file_core(&state, &connection_id, &database, &bucket, &file_id).await
}
