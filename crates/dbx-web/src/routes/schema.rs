use std::future::Future;
use std::sync::Arc;

use crate::error::AppError;
use crate::state::WebState;
use axum::extract::{Query, State};
use axum::Json;
use dbx_core::connection::AppState;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct SchemaQuery {
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: Option<String>,
    pub server: Option<String>,
    pub catalog: Option<String>,
    pub filter: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub object_type: Option<dbx_core::db::ObjectSourceKind>,
    pub signature: Option<String>,
    pub relation_name: Option<String>,
    pub object_types: Option<String>,
    pub table_name_filter: Option<String>,
    pub apply_visible_filter: Option<bool>,
    pub client_session_id: Option<String>,
    pub include_postgres_access: Option<bool>,
}

#[derive(Deserialize)]
pub struct DatabaseStorageRequest {
    pub connection_id: String,
    pub databases: Vec<String>,
}

pub async fn list_databases(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::schema::list_databases_core(&state.app, &q.connection_id).await.map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_database_metadata(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result =
        dbx_core::schema::list_database_metadata_core(&state.app, &q.connection_id).await.map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_database_storage(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DatabaseStorageRequest>,
) -> Result<Json<Vec<dbx_core::db::DatabaseStorageInfo>>, AppError> {
    let result = dbx_core::schema::list_database_storage_core(&state.app, &request.connection_id, &request.databases)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get_sqlserver_completion_context(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<dbx_core::db::sqlserver::SqlServerCompletionContext>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let result = dbx_core::schema::get_sqlserver_completion_context_core(&state.app, &q.connection_id, database)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

/// Resolve a non-internal catalog for dispatch to the Doris multi-catalog path.
async fn external_doris_catalog(state: &Arc<WebState>, connection_id: &str, catalog: Option<&str>) -> Option<String> {
    dbx_core::schema::resolve_external_doris_catalog(&state.app, connection_id, catalog).await
}

pub async fn list_doris_catalogs(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result =
        dbx_core::schema::list_doris_catalogs_core(&state.app, &q.connection_id).await.map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_doris_catalog_databases(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let catalog = q.catalog.as_deref().unwrap_or("internal");
    let result = dbx_core::schema::list_doris_catalog_databases_core(&state.app, &q.connection_id, catalog)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_sqlserver_linked_servers(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::schema::list_sqlserver_linked_servers_core(&state.app, &q.connection_id)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_sqlserver_linked_server_catalogs(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let server = q.server.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_sqlserver_linked_server_catalogs_core(&state.app, &q.connection_id, server)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_sqlserver_linked_server_schemas(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<Vec<String>>, AppError> {
    let server = q.server.as_deref().unwrap_or("");
    let catalog = q.catalog.as_deref().unwrap_or("");
    let result =
        dbx_core::schema::list_sqlserver_linked_server_schemas_core(&state.app, &q.connection_id, server, catalog)
            .await
            .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_sqlserver_linked_server_tables(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let server = q.server.as_deref().unwrap_or("");
    let catalog = q.catalog.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_sqlserver_linked_server_tables_core(
        &state.app,
        &q.connection_id,
        server,
        catalog,
        schema,
        q.filter.as_deref(),
        q.limit,
        q.offset,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn get_sqlserver_column_metadata(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result =
        dbx_core::schema::get_sqlserver_column_metadata_core(&state.app, &q.connection_id, database, schema, table)
            .await
            .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_schemas(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<Vec<String>>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_schemas_core_with_visible_filter(
        &state.app,
        &q.connection_id,
        database,
        q.apply_visible_filter.unwrap_or(false),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_tables(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let object_types = q.object_types.as_ref().map(|value| {
        value.split(',').map(str::trim).filter(|value| !value.is_empty()).map(str::to_string).collect::<Vec<_>>()
    });
    let table_name_filter = q
        .table_name_filter
        .as_deref()
        .and_then(|value| serde_json::from_str::<dbx_core::schema::TableNameFilter>(value).ok());
    let result = if let Some(catalog) = external_doris_catalog(&state, &q.connection_id, q.catalog.as_deref()).await {
        dbx_core::schema::list_doris_catalog_tables_core(
            &state.app,
            &q.connection_id,
            &catalog,
            database,
            q.filter.as_deref(),
            q.limit,
            q.offset,
            object_types.as_deref(),
            table_name_filter.as_ref(),
        )
        .await
        .map_err(AppError::from)?
    } else {
        dbx_core::schema::list_tables_core(
            &state.app,
            &q.connection_id,
            database,
            schema,
            q.filter.as_deref(),
            q.limit,
            q.offset,
            object_types.as_deref(),
            table_name_filter.as_ref(),
        )
        .await
        .map_err(AppError::from)?
    };
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_objects(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let object_types = q.object_types.as_ref().map(|value| {
        value.split(',').map(str::trim).filter(|value| !value.is_empty()).map(str::to_string).collect::<Vec<_>>()
    });
    let result = if let Some(catalog) = external_doris_catalog(&state, &q.connection_id, q.catalog.as_deref()).await {
        let tables = dbx_core::schema::list_doris_catalog_tables_core(
            &state.app,
            &q.connection_id,
            &catalog,
            database,
            q.filter.as_deref(),
            q.limit,
            q.offset,
            object_types.as_deref(),
            None,
        )
        .await
        .map_err(AppError::from)?;
        tables
            .into_iter()
            .map(|table| dbx_core::db::ObjectInfo {
                name: table.name,
                object_type: table.table_type,
                schema: Some(database.to_string()),
                valid: None,
                signature: None,
                custom_type_kind: None,
                has_members: None,
                comment: table.comment,
                created_at: None,
                updated_at: None,
                parent_schema: table.parent_schema,
                parent_name: table.parent_name,
                trigger: None,
                xugu_type_members_expandable: None,
            })
            .collect::<Vec<_>>()
    } else {
        dbx_core::schema::list_objects_core(
            &state.app,
            &q.connection_id,
            database,
            schema,
            q.filter.as_deref(),
            q.limit,
            q.offset,
            object_types.as_deref(),
        )
        .await
        .map_err(AppError::from)?
    };
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_object_statistics(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_object_statistics_core(&state.app, &q.connection_id, database, schema)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_completion_objects(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_completion_objects_core(&state.app, &q.connection_id, database, schema)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn completion_assistant_search(
    State(state): State<Arc<WebState>>,
    Json(request): Json<dbx_core::db::CompletionAssistantRequest>,
) -> Result<Json<dbx_core::db::CompletionAssistantResponse>, AppError> {
    let result =
        dbx_core::schema::completion_assistant_search_core(&state.app, request).await.map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get_object_source(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<dbx_core::db::ObjectSource>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let name = q.table.as_deref().unwrap_or("");
    let object_type = q.object_type.ok_or_else(|| AppError::from("Missing object_type".to_string()))?;
    let result = dbx_core::schema::get_object_source_core(
        &state.app,
        &q.connection_id,
        database,
        schema,
        name,
        object_type,
        q.signature.as_deref(),
        q.relation_name.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get_custom_type_details(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<dbx_core::db::CustomTypeDetails>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let name = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::get_custom_type_details_core(&state.app, &q.connection_id, database, schema, name)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

const OBJECT_METADATA_CACHE_PREFIX: &str = "object-meta:v1";

fn metadata_cache_segment(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                encoded.push(byte as char)
            }
            _ => {
                encoded.push('%');
                encoded.push(HEX[(byte >> 4) as usize] as char);
                encoded.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
    }
    encoded
}

fn metadata_cache_key(
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    catalog: Option<&str>,
    facet: &str,
) -> String {
    [
        OBJECT_METADATA_CACHE_PREFIX.to_string(),
        metadata_cache_segment(connection_id),
        metadata_cache_segment(database),
        metadata_cache_segment(schema),
        metadata_cache_segment(table),
        metadata_cache_segment(catalog.unwrap_or("")),
        facet.to_string(),
        String::new(),
    ]
    .join(":")
}

fn decode_metadata_cache<T: DeserializeOwned>(value: serde_json::Value) -> Option<T> {
    serde_json::from_value(value).ok()
}

async fn cached_metadata<T, F, Fut>(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    catalog: Option<&str>,
    facet: &str,
    loader: F,
) -> Result<T, AppError>
where
    T: Serialize + DeserializeOwned,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, AppError>>,
{
    let key = metadata_cache_key(connection_id, database, schema, table, catalog, facet);
    if let Ok(Some(cached)) = state.storage.load_schema_cache(&key).await {
        if let Some(value) = decode_metadata_cache(cached) {
            return Ok(value);
        }
    }
    let value = loader().await?;
    if let Ok(encoded) = serde_json::to_value(&value) {
        let _ = state.storage.save_schema_cache(&key, &encoded).await;
    }
    Ok(value)
}

fn should_cache_columns(client_session_id: Option<&str>) -> bool {
    client_session_id.is_none()
}

pub async fn list_columns(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let catalog = external_doris_catalog(&state, &q.connection_id, q.catalog.as_deref()).await;
    let load_columns = || async {
        if let Some(catalog) = catalog.as_deref() {
            dbx_core::schema::get_doris_catalog_columns_core(&state.app, &q.connection_id, catalog, database, table)
                .await
                .map_err(AppError::from)
        } else {
            dbx_core::schema::get_columns_core_for_session(
                &state.app,
                &q.connection_id,
                database,
                schema,
                table,
                q.client_session_id.as_deref(),
            )
            .await
            .map_err(AppError::from)
        }
    };
    let result = if should_cache_columns(q.client_session_id.as_deref()) {
        cached_metadata(
            &state.app,
            &q.connection_id,
            database,
            schema,
            table,
            catalog.as_deref(),
            "backend-columns",
            load_columns,
        )
        .await?
    } else {
        load_columns().await?
    };
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn get_all_columns(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::get_all_columns_core(&state.app, &q.connection_id, database, schema)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_data_types(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let result =
        dbx_core::schema::list_data_types_core(&state.app, &q.connection_id, database).await.map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_indexes(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let catalog = external_doris_catalog(&state, &q.connection_id, q.catalog.as_deref()).await;
    let result = cached_metadata(
        &state.app,
        &q.connection_id,
        database,
        schema,
        table,
        catalog.as_deref(),
        "backend-indexes",
        || async {
            if let Some(catalog) = catalog.as_deref() {
                dbx_core::schema::list_doris_catalog_indexes_core(
                    &state.app,
                    &q.connection_id,
                    catalog,
                    database,
                    table,
                )
                .await
                .map_err(AppError::from)
            } else {
                dbx_core::schema::list_indexes_core(&state.app, &q.connection_id, database, schema, table)
                    .await
                    .map_err(AppError::from)
            }
        },
    )
    .await?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_foreign_keys(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let catalog = external_doris_catalog(&state, &q.connection_id, q.catalog.as_deref()).await;
    let result = cached_metadata(
        &state.app,
        &q.connection_id,
        database,
        schema,
        table,
        catalog.as_deref(),
        "backend-foreign-keys",
        || async {
            if let Some(catalog) = catalog.as_deref() {
                dbx_core::schema::list_doris_catalog_foreign_keys_core(
                    &state.app,
                    &q.connection_id,
                    catalog,
                    database,
                    table,
                )
                .await
                .map_err(AppError::from)
            } else {
                dbx_core::schema::list_foreign_keys_core(&state.app, &q.connection_id, database, schema, table)
                    .await
                    .map_err(AppError::from)
            }
        },
    )
    .await?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_triggers(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = if let Some(catalog) = external_doris_catalog(&state, &q.connection_id, q.catalog.as_deref()).await {
        dbx_core::schema::list_doris_catalog_triggers_core(&state.app, &q.connection_id, &catalog, database, table)
            .await
            .map_err(AppError::from)?
    } else {
        dbx_core::schema::list_triggers_core(&state.app, &q.connection_id, database, schema, table)
            .await
            .map_err(AppError::from)?
    };
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_constraints(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_constraints_core(&state.app, &q.connection_id, database, schema, table)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_partitions(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_partitions_core(&state.app, &q.connection_id, database, schema, table)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_subpartitions(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_subpartitions_core(&state.app, &q.connection_id, database, schema, table)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn get_ddl(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<String>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = if let Some(catalog) = external_doris_catalog(&state, &q.connection_id, q.catalog.as_deref()).await {
        dbx_core::schema::get_doris_catalog_table_ddl_core(&state.app, &q.connection_id, &catalog, database, table)
            .await
            .map_err(AppError::from)?
    } else if q.include_postgres_access.unwrap_or(false) {
        dbx_core::schema::get_table_display_ddl_core(
            &state.app,
            &q.connection_id,
            database,
            schema,
            table,
            q.object_type,
        )
        .await
        .map_err(AppError::from)?
    } else {
        dbx_core::schema::get_table_ddl_core(&state.app, &q.connection_id, database, schema, table, q.object_type)
            .await
            .map_err(AppError::from)?
    };
    Ok(Json(result))
}

pub async fn list_functions(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_functions_core(&state.app, &q.connection_id, database, schema)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

#[derive(Deserialize)]
pub struct SequenceQuery {
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub with_last_values: Option<bool>,
}

pub async fn list_sequences(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SequenceQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_sequences_core(
        &state.app,
        &q.connection_id,
        database,
        schema,
        q.with_last_values.unwrap_or(false),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_rules(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_rules_core(&state.app, &q.connection_id, database, schema)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_owners(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_owners_core(&state.app, &q.connection_id, database, schema)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_extensions(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_extensions_core(&state.app, &q.connection_id, database, q.schema.as_deref())
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_available_extensions(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_available_extensions_core(&state.app, &q.connection_id, database)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_cache_keys_match_table_invalidation_prefixes() {
        let key = metadata_cache_key("conn:1", "db% name", "sch/ema", "表:名", Some("ice:berg"), "backend-columns");

        assert_eq!(
            key,
            "object-meta:v1:conn%3A1:db%25%20name:sch%2Fema:%E8%A1%A8%3A%E5%90%8D:ice%3Aberg:backend-columns:"
        );
        assert!(key.starts_with("object-meta:v1:conn%3A1:db%25%20name:sch%2Fema:%E8%A1%A8%3A%E5%90%8D:"));
    }

    #[test]
    fn metadata_cache_keys_isolate_catalogs_and_facets() {
        let iceberg_columns = metadata_cache_key("c1", "sales", "", "orders", Some("iceberg"), "backend-columns");
        let hive_columns = metadata_cache_key("c1", "sales", "", "orders", Some("hive"), "backend-columns");
        let iceberg_indexes = metadata_cache_key("c1", "sales", "", "orders", Some("iceberg"), "backend-indexes");
        let internal_columns = metadata_cache_key("c1", "sales", "", "orders", None, "backend-columns");

        assert_ne!(iceberg_columns, hive_columns);
        assert_ne!(iceberg_columns, iceberg_indexes);
        assert_eq!(internal_columns, "object-meta:v1:c1:sales::orders::backend-columns:");
    }

    #[test]
    fn session_scoped_columns_bypass_persistent_cache() {
        assert!(should_cache_columns(None));
        assert!(!should_cache_columns(Some("oracle-session")));
        assert!(!should_cache_columns(Some("")));
    }

    #[test]
    fn invalid_cache_payloads_are_treated_as_misses() {
        assert_eq!(decode_metadata_cache::<Vec<String>>(serde_json::json!({ "unexpected": true })), None);
    }
}
