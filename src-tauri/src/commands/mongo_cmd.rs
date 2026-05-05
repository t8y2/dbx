use std::sync::Arc;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::db::mongo_driver::MongoDocumentResult;

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
pub async fn mongo_find_documents(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    skip: u64,
    limit: i64,
) -> Result<MongoDocumentResult, String> {
    dbx_core::mongo_ops::mongo_find_documents_core(&state, &connection_id, &database, &collection, skip, limit).await
}

#[tauri::command]
pub async fn mongo_insert_document(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    doc_json: String,
) -> Result<String, String> {
    dbx_core::mongo_ops::mongo_insert_document_core(&state, &connection_id, &database, &collection, &doc_json).await
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
    dbx_core::mongo_ops::mongo_update_document_core(&state, &connection_id, &database, &collection, &id, &doc_json).await
}

#[tauri::command]
pub async fn mongo_delete_document(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    id: String,
) -> Result<u64, String> {
    dbx_core::mongo_ops::mongo_delete_document_core(&state, &connection_id, &database, &collection, &id).await
}
