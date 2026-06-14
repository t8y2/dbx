use std::future::Future;
use std::sync::Arc;
use tauri::State;

use crate::commands::connection::{ensure_connection_writable, AppState};
use dbx_core::db::mongo_driver::MongoDocumentResult;

async fn run_cancellable<T, F>(state: &Arc<AppState>, execution_id: Option<String>, future: F) -> Result<T, String>
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
pub async fn mongo_list_databases(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<String>, String> {
    dbx_core::mongo_ops::mongo_list_databases_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn mongo_list_collections(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    dbx_core::mongo_ops::mongo_list_collections_core(&state, &connection_id, &database).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mongo_find_documents(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    skip: u64,
    limit: i64,
    filter: Option<String>,
    sort: Option<String>,
    execution_id: Option<String>,
) -> Result<MongoDocumentResult, String> {
    let app = state.inner().clone();
    run_cancellable(
        &app,
        execution_id,
        dbx_core::mongo_ops::mongo_find_documents_core(
            &app,
            &connection_id,
            &database,
            &collection,
            skip,
            limit,
            filter.as_deref(),
            sort.as_deref(),
        ),
    )
    .await
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
    sort: Option<String>,
    execution_id: Option<String>,
) -> Result<MongoDocumentResult, String> {
    let app = state.inner().clone();
    run_cancellable(
        &app,
        execution_id,
        dbx_core::mongo_ops::document_find_documents_core(
            &app,
            &connection_id,
            &database,
            &collection,
            skip,
            limit,
            filter.as_deref(),
            sort.as_deref(),
        ),
    )
    .await
}

#[tauri::command]
pub async fn mongo_aggregate_documents(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    pipeline_json: String,
    max_rows: Option<usize>,
    execution_id: Option<String>,
) -> Result<MongoDocumentResult, String> {
    let app = state.inner().clone();
    run_cancellable(
        &app,
        execution_id,
        dbx_core::mongo_ops::mongo_aggregate_documents_core(
            &app,
            &connection_id,
            &database,
            &collection,
            &pipeline_json,
            max_rows,
        ),
    )
    .await
}

#[tauri::command]
pub async fn mongo_insert_document(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    doc_json: String,
) -> Result<String, String> {
    ensure_connection_writable(&state, &connection_id, "Insert").await?;
    dbx_core::mongo_ops::mongo_insert_document_core(&state, &connection_id, &database, &collection, &doc_json).await
}

#[tauri::command]
pub async fn mongo_insert_documents(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    docs_json: String,
) -> Result<u64, String> {
    ensure_connection_writable(&state, &connection_id, "Insert").await?;
    dbx_core::mongo_ops::mongo_insert_documents_core(&state, &connection_id, &database, &collection, &docs_json).await
}

#[tauri::command]
pub async fn mongo_update_document(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    id: String,
    doc_json: String,
) -> Result<u64, String> {
    ensure_connection_writable(&state, &connection_id, "Update").await?;
    dbx_core::mongo_ops::mongo_update_document_core(&state, &connection_id, &database, &collection, &id, &doc_json)
        .await
}

#[tauri::command]
pub async fn mongo_update_documents(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    filter_json: String,
    update_json: String,
    many: bool,
) -> Result<u64, String> {
    ensure_connection_writable(&state, &connection_id, "Update").await?;
    dbx_core::mongo_ops::mongo_update_documents_core(
        &state,
        &connection_id,
        &database,
        &collection,
        &filter_json,
        &update_json,
        many,
    )
    .await
}

#[tauri::command]
pub async fn mongo_delete_document(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    id: String,
) -> Result<u64, String> {
    ensure_connection_writable(&state, &connection_id, "Delete").await?;
    dbx_core::mongo_ops::mongo_delete_document_core(&state, &connection_id, &database, &collection, &id).await
}

#[tauri::command]
pub async fn mongo_delete_documents(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    filter_json: String,
    many: bool,
) -> Result<u64, String> {
    ensure_connection_writable(&state, &connection_id, "Delete").await?;
    dbx_core::mongo_ops::mongo_delete_documents_core(&state, &connection_id, &database, &collection, &filter_json, many)
        .await
}
