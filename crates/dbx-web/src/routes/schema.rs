use std::future::Future;
use std::sync::Arc;

use crate::error::AppError;
use crate::state::WebState;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
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
    pub current_schema: Option<String>,
    pub include_postgres_access: Option<bool>,
    pub portable: Option<bool>,
    pub execution_id: Option<String>,
    pub identity_mode: Option<dbx_core::schema::MetadataIdentityMode>,
    pub exact_identity: Option<bool>,
    pub page_table_roots: Option<bool>,
    pub separate_indexes: Option<bool>,
    pub explicit_owner: Option<String>,
}

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

pub async fn list_xugu_tablespaces(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<Vec<dbx_core::db::XuguTablespaceInfo>>, AppError> {
    let result = dbx_core::schema::list_xugu_tablespaces_core(&state.app, &q.connection_id, q.database.as_deref())
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

pub async fn get_mysql_table_auto_increment(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<Option<String>>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::get_mysql_table_auto_increment_core(&state.app, &q.connection_id, database, table)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
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
    if q.exact_identity.unwrap_or(false) {
        let result = dbx_core::schema::exact_metadata::tables(
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
        .map_err(AppError::from)?;
        return Ok(Json(serde_json::to_value(result).map_err(|error| AppError::from(error.to_string()))?));
    }
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
    } else if q.page_table_roots.unwrap_or(false) {
        dbx_core::schema::list_table_roots_page_core(
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
    let database = q.database.unwrap_or_default();
    let schema = q.schema.unwrap_or_default();
    let connection_id = q.connection_id;
    let filter = q.filter;
    let catalog = q.catalog;
    let execution_id = q.execution_id;
    let object_types = q.object_types.as_ref().map(|value| {
        value.split(',').map(str::trim).filter(|value| !value.is_empty()).map(str::to_string).collect::<Vec<_>>()
    });
    let table_name_filter = q
        .table_name_filter
        .as_deref()
        .and_then(|value| serde_json::from_str::<dbx_core::schema::TableNameFilter>(value).ok());
    let result = run_cancellable(&state, execution_id, async {
        if q.exact_identity.unwrap_or(false) {
            return dbx_core::schema::exact_metadata::objects(
                &state.app,
                &connection_id,
                &database,
                &schema,
                filter.as_deref(),
                q.limit,
                q.offset,
                object_types.as_deref(),
                table_name_filter.as_ref(),
            )
            .await;
        }
        if let Some(catalog) = external_doris_catalog(&state, &connection_id, catalog.as_deref()).await {
            let tables = dbx_core::schema::list_doris_catalog_tables_core(
                &state.app,
                &connection_id,
                &catalog,
                &database,
                filter.as_deref(),
                q.limit,
                q.offset,
                object_types.as_deref(),
                table_name_filter.as_ref(),
            )
            .await?;
            Ok(tables
                .into_iter()
                .map(|table| dbx_core::db::ObjectInfo {
                    name: table.name,
                    object_type: table.table_type,
                    schema: Some(database.clone()),
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
                .collect::<Vec<_>>())
        } else {
            dbx_core::schema::list_objects_core_with_options(
                &state.app,
                &connection_id,
                &database,
                &schema,
                filter.as_deref(),
                q.limit,
                q.offset,
                object_types.as_deref(),
                table_name_filter.as_ref(),
                &dbx_core::schema::MetadataReadOptions { identity_mode: q.identity_mode, catalog },
            )
            .await
        }
    })
    .await?;
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
    let result = dbx_core::schema::get_object_source_core_with_options(
        &state.app,
        &q.connection_id,
        database,
        schema,
        name,
        object_type,
        q.signature.as_deref(),
        q.relation_name.as_deref(),
        &dbx_core::schema::MetadataReadOptions { identity_mode: q.identity_mode, catalog: q.catalog },
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get_event_info(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<dbx_core::db::MysqlEventInfo>, AppError> {
    let result = dbx_core::schema::get_event_info_core(
        &state.app,
        &q.connection_id,
        q.database.as_deref().unwrap_or(""),
        q.schema.as_deref().unwrap_or(""),
        q.table.as_deref().unwrap_or(""),
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

pub async fn verify_oracle_type_data(
    State(state): State<Arc<WebState>>,
    Json(input): Json<dbx_core::db::OracleTypeDataRequest>,
) -> Result<Json<dbx_core::db::OracleTypeDataResult>, AppError> {
    Ok(Json(dbx_core::schema::verify_oracle_type_data_core(&state.app, input).await?))
}

pub async fn prepare_oracle_type_evolution(
    State(state): State<Arc<WebState>>,
    Json(input): Json<dbx_core::db::OracleTypeEvolutionRequest>,
) -> Result<Json<dbx_core::db::OracleTypeEvolutionManifest>, AppError> {
    Ok(Json(dbx_core::schema::prepare_oracle_type_evolution_core(&state.app, input).await?))
}

pub async fn get_oracle_type_management_snapshot(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<dbx_core::db::OracleTypeManagementSnapshot>, AppError> {
    let result = dbx_core::schema::get_oracle_type_management_snapshot_core(
        &state.app,
        &q.connection_id,
        q.database.as_deref().unwrap_or(""),
        q.schema.as_deref().unwrap_or(""),
        q.table.as_deref().unwrap_or(""),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn read_oracle_type_management_snapshot(
    State(state): State<Arc<WebState>>,
    Json(request): Json<dbx_core::db::OracleTypeManagementSnapshotRequest>,
) -> Result<Json<dbx_core::db::OracleTypeManagementSnapshot>, AppError> {
    let target = request.target;
    let result = dbx_core::schema::get_oracle_type_management_snapshot_with_objects_core(
        &state.app,
        &target.connection_id,
        &target.database,
        &target.owner,
        &target.name,
        &request.known_objects,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub(crate) use dbx_core::object_cache::object_metadata_cache_prefix;
use dbx_core::object_cache::{metadata_cache_segment, OBJECT_METADATA_CACHE_PREFIX};

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

fn should_cache_columns(client_session_id: Option<&str>, current_schema: Option<&str>) -> bool {
    client_session_id.is_none() && current_schema.is_none()
}

pub async fn get_plugin_table_metadata(
    State(state): State<Arc<WebState>>,
    Json(request): Json<dbx_core::schema::plugin_metadata::PluginTableContext>,
) -> Result<Json<dbx_core::schema::plugin_metadata::PluginTableMetadata>, AppError> {
    let result =
        dbx_core::schema::plugin_metadata::get_table_metadata(&state.app, request).await.map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_columns(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    // Exact reads revalidate the current process contract and never reuse a
    // persisted ordinary/synonym-resolved snapshot as an editing baseline.
    if q.exact_identity.unwrap_or(false) {
        let result = dbx_core::schema::exact_metadata::columns(
            &state.app,
            &q.connection_id,
            database,
            schema,
            table,
            q.client_session_id.as_deref(),
        )
        .await
        .map_err(AppError::from)?;
        return Ok(Json(serde_json::to_value(result).map_err(|error| AppError::from(error.to_string()))?));
    }
    let catalog = external_doris_catalog(&state, &q.connection_id, q.catalog.as_deref()).await;
    let load_columns = || async {
        if let Some(catalog) = catalog.as_deref() {
            dbx_core::schema::get_doris_catalog_columns_core(&state.app, &q.connection_id, catalog, database, table)
                .await
                .map_err(AppError::from)
        } else {
            dbx_core::schema::get_columns_core_for_session_in_context(
                &state.app,
                &q.connection_id,
                database,
                schema,
                table,
                q.client_session_id.as_deref(),
                q.current_schema.as_deref(),
            )
            .await
            .map_err(AppError::from)
        }
    };
    let result = if should_cache_columns(q.client_session_id.as_deref(), q.current_schema.as_deref()) {
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
    if q.exact_identity.unwrap_or(false) {
        let result = dbx_core::schema::exact_metadata::indexes(&state.app, &q.connection_id, database, schema, table)
            .await
            .map_err(AppError::from)?;
        return Ok(Json(serde_json::to_value(result).map_err(|error| AppError::from(error.to_string()))?));
    }
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

pub async fn list_reference_key_columns(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<Vec<String>>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let catalog = external_doris_catalog(&state, &q.connection_id, q.catalog.as_deref()).await;
    let indexes = if let Some(catalog) = catalog.as_deref() {
        dbx_core::schema::list_doris_catalog_indexes_core(&state.app, &q.connection_id, catalog, database, table)
            .await
            .map_err(AppError::from)?
    } else {
        dbx_core::schema::list_indexes_core(&state.app, &q.connection_id, database, schema, table)
            .await
            .map_err(AppError::from)?
    };
    Ok(Json(dbx_core::schema::reference_key_columns_from_indexes(&indexes)))
}

pub async fn list_reference_keys(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<Vec<dbx_core::schema::ReferenceKeyInfo>>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let catalog = external_doris_catalog(&state, &q.connection_id, q.catalog.as_deref()).await;
    let indexes = if let Some(catalog) = catalog.as_deref() {
        dbx_core::schema::list_doris_catalog_indexes_core(&state.app, &q.connection_id, catalog, database, table)
            .await
            .map_err(AppError::from)?
    } else {
        dbx_core::schema::list_indexes_core(&state.app, &q.connection_id, database, schema, table)
            .await
            .map_err(AppError::from)?
    };
    Ok(Json(dbx_core::schema::reference_keys_from_indexes(&indexes)))
}

pub async fn list_foreign_keys(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    if q.exact_identity.unwrap_or(false) {
        let result =
            dbx_core::schema::exact_metadata::foreign_keys(&state.app, &q.connection_id, database, schema, table)
                .await
                .map_err(AppError::from)?;
        return Ok(Json(serde_json::to_value(result).map_err(|error| AppError::from(error.to_string()))?));
    }
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

pub async fn list_foreign_keys_for_database(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = run_cancellable(
        &state,
        q.execution_id,
        dbx_core::schema::list_foreign_keys_for_database_core(&state.app, &q.connection_id, database, schema),
    )
    .await?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn get_table_comment(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<Option<String>>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = if q.exact_identity.unwrap_or(false) {
        dbx_core::schema::exact_metadata::comment(&state.app, &q.connection_id, database, schema, table).await
    } else if let Some(catalog) = external_doris_catalog(&state, &q.connection_id, q.catalog.as_deref()).await {
        dbx_core::schema::get_doris_catalog_table_comment_core(&state.app, &q.connection_id, &catalog, database, table)
            .await
    } else {
        dbx_core::schema::get_table_comment_core(&state.app, &q.connection_id, database, schema, table).await
    }
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_triggers(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = if q.exact_identity.unwrap_or(false) {
        dbx_core::schema::exact_metadata::triggers(&state.app, &q.connection_id, database, schema, table)
            .await
            .map_err(AppError::from)?
    } else if let Some(catalog) = external_doris_catalog(&state, &q.connection_id, q.catalog.as_deref()).await {
        dbx_core::schema::list_doris_catalog_triggers_core(&state.app, &q.connection_id, &catalog, database, table)
            .await
            .map_err(AppError::from)?
    } else {
        dbx_core::schema::list_triggers_core_with_options(
            &state.app,
            &q.connection_id,
            database,
            schema,
            table,
            &dbx_core::schema::MetadataReadOptions { identity_mode: q.identity_mode, catalog: q.catalog },
        )
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
    let _ = q.catalog.as_deref();
    let result = if q.exact_identity.unwrap_or(false) {
        dbx_core::schema::exact_metadata::constraints(&state.app, &q.connection_id, database, schema, table).await
    } else {
        dbx_core::schema::list_constraints_core(&state.app, &q.connection_id, database, schema, table).await
    }
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

pub async fn get_table_partition_status(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<dbx_core::schema::TablePartitionStatus>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    dbx_core::schema::table_partition_status_core(&state.app, &q.connection_id, database, schema, table)
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn get_table_partitioning(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<dbx_core::db::PgTablePartitioning>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    dbx_core::schema::get_table_partitioning_core(&state.app, &q.connection_id, database, schema, table)
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn list_invalid_indexes(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<Vec<String>>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    dbx_core::schema::list_invalid_indexes_core(&state.app, &q.connection_id, database, schema, table)
        .await
        .map(Json)
        .map_err(AppError::from)
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
    let separate_indexes = q.separate_indexes.unwrap_or(false) && q.object_type.is_none();
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = if q.exact_identity.unwrap_or(false) {
        dbx_core::schema::exact_metadata::ddl(
            &state.app,
            &q.connection_id,
            database,
            schema,
            table,
            q.object_type,
            q.portable.unwrap_or(false),
        )
        .await
        .map_err(AppError::from)?
    } else if let Some(catalog) = external_doris_catalog(&state, &q.connection_id, q.catalog.as_deref()).await {
        dbx_core::schema::get_doris_catalog_table_ddl_core(&state.app, &q.connection_id, &catalog, database, table)
            .await
            .map_err(AppError::from)?
    } else if q.portable.unwrap_or(false) {
        dbx_core::schema::get_table_export_ddl_core(
            &state.app,
            &q.connection_id,
            database,
            schema,
            table,
            q.object_type,
        )
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
    let result = if separate_indexes {
        dbx_core::schema::separate_table_ddl_indexes_core(
            &state.app,
            &q.connection_id,
            database,
            schema,
            table,
            &result,
            q.explicit_owner.as_deref().or_else(|| q.exact_identity.unwrap_or(false).then_some(schema)),
        )
        .await
        .map_err(AppError::from)?
    } else {
        result
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
pub struct RoutineSnapshotQuery {
    #[serde(flatten)]
    scope: SchemaQuery,
    selected_routines: Option<String>,
    object_kinds: Option<String>,
    selected_objects: Option<String>,
}

pub async fn load_schema_diff_routines(
    State(state): State<Arc<WebState>>,
    Query(query): Query<RoutineSnapshotQuery>,
) -> Result<Json<dbx_core::schema::oracle_routines::RoutineSnapshot>, AppError> {
    let selected_routines = query
        .selected_routines
        .as_deref()
        .map(serde_json::from_str::<Vec<String>>)
        .transpose()
        .map_err(|error| AppError::from(format!("Invalid selected routine names: {error}")))?;
    let q = query.scope;
    let object_kinds = query
        .object_kinds
        .as_deref()
        .map(serde_json::from_str::<Vec<dbx_core::db::ObjectSourceKind>>)
        .transpose()
        .map_err(|error| AppError::from(format!("Invalid program object kinds: {error}")))?;
    let selected_objects = query
        .selected_objects
        .as_deref()
        .map(serde_json::from_str::<Vec<dbx_core::schema::oracle_routines::RoutineSelection>>)
        .transpose()
        .map_err(|error| AppError::from(format!("Invalid selected program identities: {error}")))?;
    let snapshot = dbx_core::schema::oracle_routines::load_schema_diff_routines_with_options_core(
        &state.app,
        &q.connection_id,
        q.database.as_deref().unwrap_or(""),
        q.schema.as_deref().unwrap_or(""),
        dbx_core::schema::oracle_routines::RoutineReadOptions { object_kinds, selected_objects, selected_routines },
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(snapshot))
}

pub async fn prepare_oracle_routine_save(
    State(state): State<Arc<WebState>>,
    Json(input): Json<dbx_core::schema::oracle_routines::OracleRoutineSaveInput>,
) -> Result<Json<dbx_core::schema::oracle_routines::RoutineOperationRecord>, AppError> {
    dbx_core::schema::oracle_routines::prepare_oracle_routine_save_core(&state.app, input)
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn prepare_oracle_routine_plan(
    State(state): State<Arc<WebState>>,
    Json(input): Json<dbx_core::schema::oracle_routines::OracleRoutinePlanInput>,
) -> Result<Json<dbx_core::schema::oracle_routines::OracleRoutinePlan>, AppError> {
    dbx_core::schema::oracle_routines::prepare_oracle_routine_plan_core(&state.app, input)
        .await
        .map(Json)
        .map_err(AppError::from)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRecoveryRequest {
    operation_id: String,
}

pub async fn prepare_oracle_routine_recovery(
    State(state): State<Arc<WebState>>,
    Json(request): Json<RoutineRecoveryRequest>,
) -> Result<Json<dbx_core::schema::oracle_routines::OracleRoutinePlan>, AppError> {
    dbx_core::schema::oracle_routines::prepare_oracle_routine_recovery_core(&state.app, &request.operation_id)
        .await
        .map(Json)
        .map_err(AppError::from)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteRoutineOperationRequest {
    operation_id: String,
    approved_sql: String,
}

pub async fn execute_oracle_routine_operation(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(request): Json<ExecuteRoutineOperationRequest>,
) -> Result<Json<dbx_core::schema::oracle_routines::RoutineOperationRecord>, AppError> {
    let original = state
        .app
        .routine_operations
        .observe(&request.operation_id)
        .operation
        .ok_or_else(|| AppError::from("Original routine operation is unavailable; do not replay"))?;
    let database = super::mcp_policy::ensure_sql(
        &state,
        &headers,
        &original.target.connection_id,
        &original.target.database,
        &request.approved_sql,
        false,
    )
    .await?;
    if database != original.target.database {
        return Err(AppError::from("Routine operation cannot switch its approved target database"));
    }
    dbx_core::schema::oracle_routines::execute_oracle_routine_operation_core(
        state.app.clone(),
        request.operation_id,
        request.approved_sql,
    )
    .await
    .map(Json)
    .map_err(AppError::from)
}

#[derive(Deserialize)]
pub struct RoutineOperationQuery {
    operation_id: String,
    #[serde(default)]
    refresh_readback: bool,
}

pub async fn observe_oracle_routine_operation(
    State(state): State<Arc<WebState>>,
    Query(query): Query<RoutineOperationQuery>,
) -> Json<dbx_core::schema::oracle_routines::RoutineOperationObservation> {
    Json(
        dbx_core::schema::oracle_routines::observe_oracle_routine_operation_core(
            &state.app,
            &query.operation_id,
            query.refresh_readback,
        )
        .await,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineOperationReferences {
    retain_operation_ids: Vec<String>,
    release_operation_ids: Vec<String>,
}

pub async fn update_oracle_routine_operation_references(
    State(state): State<Arc<WebState>>,
    Json(input): Json<RoutineOperationReferences>,
) -> Result<Json<()>, AppError> {
    state
        .app
        .routine_operations
        .update_references(&input.retain_operation_ids, &input.release_operation_ids)
        .map_err(AppError::from)?;
    Ok(Json(()))
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

pub async fn get_table_owner(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::get_table_owner_core(&state.app, &q.connection_id, database, schema, table)
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

pub async fn list_event_triggers(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_event_triggers_core(&state.app, &q.connection_id, database)
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
    fn database_metadata_cache_prefix_covers_backend_object_facets() {
        let prefix = object_metadata_cache_prefix("conn:1", "db% name");
        let key = metadata_cache_key("conn:1", "db% name", "public", "users", None, "backend-columns");

        assert_eq!(prefix, "object-meta:v1:conn%3A1:db%25%20name:");
        assert!(key.starts_with(&prefix));
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
        assert!(should_cache_columns(None, None));
        assert!(!should_cache_columns(Some("oracle-session"), None));
        assert!(!should_cache_columns(Some(""), None));
    }

    #[test]
    fn current_schema_columns_bypass_cache_without_changing_explicit_schema() {
        let query: SchemaQuery = serde_json::from_value(serde_json::json!({
            "connection_id": "ob", "database": "LOGIN", "schema": "", "table": "ORDERS_ALIAS",
            "current_schema": "SelectedOwner"
        }))
        .unwrap();
        assert_eq!(query.schema.as_deref(), Some(""));
        assert_eq!(query.current_schema.as_deref(), Some("SelectedOwner"));
        assert!(!should_cache_columns(query.client_session_id.as_deref(), query.current_schema.as_deref()));
    }

    #[test]
    fn invalid_cache_payloads_are_treated_as_misses() {
        assert_eq!(decode_metadata_cache::<Vec<String>>(serde_json::json!({ "unexpected": true })), None);
    }
}
