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
        ),
    )
    .await
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
pub async fn document_insert_document(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    doc_json: String,
    routing: Option<String>,
) -> Result<String, String> {
    ensure_connection_writable(&state, &connection_id, "Insert").await?;
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
) -> Result<u64, String> {
    ensure_connection_writable(&state, &connection_id, "Delete").await?;
    dbx_core::document_ops::delete_document_core(
        &state,
        &connection_id,
        &database,
        &collection,
        &id,
        routing.as_deref(),
    )
    .await
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
