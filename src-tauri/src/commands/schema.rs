use std::sync::Arc;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::db;

#[tauri::command]
pub fn list_databases(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<Vec<db::DatabaseInfo>, String> {
    tauri::async_runtime::block_on(async move { dbx_core::schema::list_databases_core(&state, &connection_id).await })
}

#[tauri::command]
pub fn list_schemas(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::block_on(async move {
        dbx_core::schema::list_schemas_core(&state, &connection_id, &database).await
    })
}

#[tauri::command]
pub fn list_tables(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    filter: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<db::TableInfo>, String> {
    tauri::async_runtime::block_on(async move {
        dbx_core::schema::list_tables_core(&state, &connection_id, &database, &schema, filter.as_deref(), limit).await
    })
}

#[tauri::command]
pub fn list_objects(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    object_types: Option<Vec<String>>,
) -> Result<Vec<db::ObjectInfo>, String> {
    tauri::async_runtime::block_on(async move {
        dbx_core::schema::list_objects_core(&state, &connection_id, &database, &schema, object_types).await
    })
}

#[tauri::command]
pub fn list_completion_objects(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<db::ObjectInfo>, String> {
    tauri::async_runtime::block_on(async move {
        dbx_core::schema::list_completion_objects_core(&state, &connection_id, &database, &schema).await
    })
}

#[tauri::command]
pub fn get_object_source(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    name: String,
    object_type: db::ObjectSourceKind,
) -> Result<db::ObjectSource, String> {
    tauri::async_runtime::block_on(async move {
        dbx_core::schema::get_object_source_core(&state, &connection_id, &database, &schema, &name, object_type).await
    })
}

#[tauri::command]
pub fn get_columns(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::ColumnInfo>, String> {
    tauri::async_runtime::block_on(async move {
        dbx_core::schema::get_columns_core(&state, &connection_id, &database, &schema, &table).await
    })
}

#[tauri::command]
pub fn list_indexes(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::IndexInfo>, String> {
    tauri::async_runtime::block_on(async move {
        dbx_core::schema::list_indexes_core(&state, &connection_id, &database, &schema, &table).await
    })
}

#[tauri::command]
pub fn list_foreign_keys(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    tauri::async_runtime::block_on(async move {
        dbx_core::schema::list_foreign_keys_core(&state, &connection_id, &database, &schema, &table).await
    })
}

#[tauri::command]
pub fn list_triggers(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::TriggerInfo>, String> {
    tauri::async_runtime::block_on(async move {
        dbx_core::schema::list_triggers_core(&state, &connection_id, &database, &schema, &table).await
    })
}

#[tauri::command]
pub fn get_table_ddl(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<String, String> {
    tauri::async_runtime::block_on(async move {
        dbx_core::schema::get_table_ddl_core(&state, &connection_id, &database, &schema, &table).await
    })
}
