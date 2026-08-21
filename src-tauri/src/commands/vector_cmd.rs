use std::sync::Arc;

use tauri::State;

use crate::commands::connection::{ensure_connection_writable, AppState};

#[tauri::command]
pub async fn vector_collection_detail(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
) -> Result<dbx_core::db::vector_driver::CollectionInfo, String> {
    dbx_core::schema::get_vector_collection_detail_core(&state, &connection_id, &database, &collection).await
}

#[tauri::command]
pub async fn vector_drop_database(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Drop database").await?;
    dbx_core::schema::drop_vector_database_core(&state, &connection_id, &database).await
}

#[tauri::command]
pub async fn vector_drop_collection(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Drop collection").await?;
    dbx_core::schema::drop_vector_collection_core(&state, &connection_id, &database, &collection).await
}

#[tauri::command]
pub async fn vector_rename_collection(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    collection: String,
    new_name: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Rename collection").await?;
    dbx_core::schema::rename_vector_collection_core(&state, &connection_id, &database, &collection, &new_name).await
}
