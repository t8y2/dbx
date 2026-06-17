use std::sync::Arc;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::db;

#[tauri::command]
pub async fn list_databases(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<db::DatabaseInfo>, String> {
    dbx_core::schema::list_databases_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn list_schemas(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    dbx_core::schema::list_schemas_core(&state, &connection_id, &database).await
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    filter: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<Vec<String>>,
) -> Result<Vec<db::TableInfo>, String> {
    dbx_core::schema::list_tables_core(
        &state,
        &connection_id,
        &database,
        &schema,
        filter.as_deref(),
        limit,
        offset,
        object_types.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn list_objects(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<db::ObjectInfo>, String> {
    dbx_core::schema::list_objects_core(&state, &connection_id, &database, &schema).await
}

#[tauri::command]
pub async fn list_completion_objects(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<db::ObjectInfo>, String> {
    dbx_core::schema::list_completion_objects_core(&state, &connection_id, &database, &schema).await
}

#[tauri::command]
pub async fn get_object_source(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    name: String,
    object_type: db::ObjectSourceKind,
) -> Result<db::ObjectSource, String> {
    dbx_core::schema::get_object_source_core(&state, &connection_id, &database, &schema, &name, object_type).await
}

#[tauri::command]
pub async fn get_columns(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::ColumnInfo>, String> {
    dbx_core::schema::get_columns_core(&state, &connection_id, &database, &schema, &table).await
}

#[tauri::command]
pub async fn list_indexes(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::IndexInfo>, String> {
    dbx_core::schema::list_indexes_core(&state, &connection_id, &database, &schema, &table).await
}

#[tauri::command]
pub async fn list_foreign_keys(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    dbx_core::schema::list_foreign_keys_core(&state, &connection_id, &database, &schema, &table).await
}

#[tauri::command]
pub async fn list_triggers(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::TriggerInfo>, String> {
    dbx_core::schema::list_triggers_core(&state, &connection_id, &database, &schema, &table).await
}

#[tauri::command]
pub async fn get_table_ddl(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
    object_type: Option<db::ObjectSourceKind>,
) -> Result<String, String> {
    dbx_core::schema::get_table_ddl_core(&state, &connection_id, &database, &schema, &table, object_type).await
}

#[tauri::command]
pub async fn list_functions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<db::FunctionInfo>, String> {
    dbx_core::schema::list_functions_core(&state, &connection_id, &database, &schema).await
}

#[tauri::command]
pub async fn list_sequences(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    with_last_values: bool,
) -> Result<Vec<db::SequenceInfo>, String> {
    dbx_core::schema::list_sequences_core(&state, &connection_id, &database, &schema, with_last_values).await
}

#[tauri::command]
pub async fn list_rules(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<db::RuleInfo>, String> {
    dbx_core::schema::list_rules_core(&state, &connection_id, &database, &schema).await
}

#[tauri::command]
pub async fn list_owners(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<db::OwnerInfo>, String> {
    dbx_core::schema::list_owners_core(&state, &connection_id, &database, &schema).await
}
