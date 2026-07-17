use std::sync::Arc;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::db;

/// Resolve a non-internal catalog for dispatch to the Doris multi-catalog path.
/// Thin wrapper around the shared dbx-core resolver so the Tauri and HTTP
/// backends stay in sync.
async fn external_doris_catalog(state: &AppState, connection_id: &str, catalog: Option<&str>) -> Option<String> {
    dbx_core::schema::resolve_external_doris_catalog(state, connection_id, catalog).await
}

#[tauri::command]
pub async fn list_databases(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<db::DatabaseInfo>, String> {
    dbx_core::schema::list_databases_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn list_doris_catalogs(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<db::CatalogInfo>, String> {
    dbx_core::schema::list_doris_catalogs_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn list_doris_catalog_databases(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    catalog: String,
) -> Result<Vec<db::DatabaseInfo>, String> {
    dbx_core::schema::list_doris_catalog_databases_core(&state, &connection_id, &catalog).await
}

#[tauri::command]
pub async fn list_sqlserver_linked_servers(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<db::LinkedServerInfo>, String> {
    dbx_core::schema::list_sqlserver_linked_servers_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn list_sqlserver_linked_server_catalogs(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    server: String,
) -> Result<Vec<db::DatabaseInfo>, String> {
    dbx_core::schema::list_sqlserver_linked_server_catalogs_core(&state, &connection_id, &server).await
}

#[tauri::command]
pub async fn list_sqlserver_linked_server_schemas(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    server: String,
    catalog: String,
) -> Result<Vec<String>, String> {
    dbx_core::schema::list_sqlserver_linked_server_schemas_core(&state, &connection_id, &server, &catalog).await
}

#[tauri::command]
pub async fn list_sqlserver_linked_server_tables(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    server: String,
    catalog: String,
    schema: String,
    filter: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<db::TableInfo>, String> {
    dbx_core::schema::list_sqlserver_linked_server_tables_core(
        &state,
        &connection_id,
        &server,
        &catalog,
        &schema,
        filter.as_deref(),
        limit,
        offset,
    )
    .await
}

#[tauri::command]
pub async fn list_schemas(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    apply_visible_filter: Option<bool>,
) -> Result<Vec<String>, String> {
    dbx_core::schema::list_schemas_core_with_visible_filter(
        &state,
        &connection_id,
        &database,
        apply_visible_filter.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn list_schema_infos(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<Vec<db::SchemaInfo>, String> {
    dbx_core::schema::list_schema_infos_core(&state, &connection_id, &database).await
}

#[tauri::command]
pub async fn list_data_types(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    dbx_core::schema::list_data_types_core(&state, &connection_id, &database).await
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
    catalog: Option<String>,
) -> Result<Vec<db::TableInfo>, String> {
    if let Some(catalog) = external_doris_catalog(&state, &connection_id, catalog.as_deref()).await {
        return dbx_core::schema::list_doris_catalog_tables_core(
            &state,
            &connection_id,
            &catalog,
            &database,
            filter.as_deref(),
            limit,
            offset,
            object_types.as_deref(),
        )
        .await;
    }
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
pub async fn get_table_comment(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
    catalog: Option<String>,
) -> Result<Option<String>, String> {
    if let Some(catalog) = external_doris_catalog(&state, &connection_id, catalog.as_deref()).await {
        return dbx_core::schema::get_doris_catalog_table_comment_core(
            &state,
            &connection_id,
            &catalog,
            &database,
            &table,
        )
        .await;
    }
    dbx_core::schema::get_table_comment_core(&state, &connection_id, &database, &schema, &table).await
}

#[tauri::command]
pub async fn list_objects(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    filter: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<Vec<String>>,
    catalog: Option<String>,
) -> Result<Vec<db::ObjectInfo>, String> {
    if let Some(catalog) = external_doris_catalog(&state, &connection_id, catalog.as_deref()).await {
        let tables = dbx_core::schema::list_doris_catalog_tables_core(
            &state,
            &connection_id,
            &catalog,
            &database,
            filter.as_deref(),
            limit,
            offset,
            object_types.as_deref(),
        )
        .await?;
        return Ok(tables
            .into_iter()
            .map(|table| db::ObjectInfo {
                name: table.name,
                object_type: table.table_type,
                schema: Some(database.clone()),
                valid: None,
                signature: None,
                comment: table.comment,
                created_at: None,
                updated_at: None,
                parent_schema: table.parent_schema,
                parent_name: table.parent_name,
            })
            .collect());
    }
    dbx_core::schema::list_objects_core(
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
pub async fn list_object_statistics(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<db::ObjectStatistics>, String> {
    dbx_core::schema::list_object_statistics_core(&state, &connection_id, &database, &schema).await
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
pub async fn completion_assistant_search(
    state: State<'_, Arc<AppState>>,
    request: db::CompletionAssistantRequest,
) -> Result<db::CompletionAssistantResponse, String> {
    dbx_core::schema::completion_assistant_search_core(&state, request).await
}

#[tauri::command]
pub async fn get_object_source(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    name: String,
    object_type: db::ObjectSourceKind,
    signature: Option<String>,
) -> Result<db::ObjectSource, String> {
    dbx_core::schema::get_object_source_core(
        &state,
        &connection_id,
        &database,
        &schema,
        &name,
        object_type,
        signature.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn get_columns(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
    catalog: Option<String>,
) -> Result<Vec<db::ColumnInfo>, String> {
    if let Some(catalog) = external_doris_catalog(&state, &connection_id, catalog.as_deref()).await {
        return dbx_core::schema::get_doris_catalog_columns_core(&state, &connection_id, &catalog, &database, &table)
            .await;
    }
    dbx_core::schema::get_columns_core(&state, &connection_id, &database, &schema, &table).await
}

#[tauri::command]
pub async fn list_indexes(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
    catalog: Option<String>,
) -> Result<Vec<db::IndexInfo>, String> {
    if let Some(catalog) = external_doris_catalog(&state, &connection_id, catalog.as_deref()).await {
        return dbx_core::schema::list_doris_catalog_indexes_core(&state, &connection_id, &catalog, &database, &table)
            .await;
    }
    dbx_core::schema::list_indexes_core(&state, &connection_id, &database, &schema, &table).await
}

#[tauri::command]
pub async fn list_foreign_keys(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
    catalog: Option<String>,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    if let Some(catalog) = external_doris_catalog(&state, &connection_id, catalog.as_deref()).await {
        return dbx_core::schema::list_doris_catalog_foreign_keys_core(
            &state,
            &connection_id,
            &catalog,
            &database,
            &table,
        )
        .await;
    }
    dbx_core::schema::list_foreign_keys_core(&state, &connection_id, &database, &schema, &table).await
}

#[tauri::command]
pub async fn list_triggers(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
    catalog: Option<String>,
) -> Result<Vec<db::TriggerInfo>, String> {
    if let Some(catalog) = external_doris_catalog(&state, &connection_id, catalog.as_deref()).await {
        return dbx_core::schema::list_doris_catalog_triggers_core(&state, &connection_id, &catalog, &database, &table)
            .await;
    }
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
    catalog: Option<String>,
) -> Result<String, String> {
    if let Some(catalog) = external_doris_catalog(&state, &connection_id, catalog.as_deref()).await {
        return dbx_core::schema::get_doris_catalog_table_ddl_core(&state, &connection_id, &catalog, &database, &table)
            .await;
    }
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

#[tauri::command]
pub async fn list_extensions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<db::ExtensionInfo>, String> {
    dbx_core::schema::list_extensions_core(&state, &connection_id, &database, &schema).await
}

#[tauri::command]
pub async fn list_available_extensions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<Vec<db::ExtensionInfo>, String> {
    dbx_core::schema::list_available_extensions_core(&state, &connection_id, &database).await
}
