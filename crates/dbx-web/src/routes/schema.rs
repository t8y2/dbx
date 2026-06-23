use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

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
    pub object_types: Option<String>,
}

pub async fn list_databases(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::schema::list_databases_core(&state.app, &q.connection_id).await.map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn list_sqlserver_linked_servers(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result =
        dbx_core::schema::list_sqlserver_linked_servers_core(&state.app, &q.connection_id).await.map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn list_sqlserver_linked_server_catalogs(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let server = q.server.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_sqlserver_linked_server_catalogs_core(&state.app, &q.connection_id, server)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
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
            .map_err(AppError)?;
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
    .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn list_schemas(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<Vec<String>>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_schemas_core(&state.app, &q.connection_id, database).await.map_err(AppError)?;
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
    let result = dbx_core::schema::list_tables_core(
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
    .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn list_objects(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result =
        dbx_core::schema::list_objects_core(&state.app, &q.connection_id, database, schema).await.map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn list_object_statistics(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_object_statistics_core(&state.app, &q.connection_id, database, schema)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn list_completion_objects(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_completion_objects_core(&state.app, &q.connection_id, database, schema)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn completion_assistant_search(
    State(state): State<Arc<WebState>>,
    Json(request): Json<dbx_core::db::CompletionAssistantRequest>,
) -> Result<Json<dbx_core::db::CompletionAssistantResponse>, AppError> {
    let result = dbx_core::schema::completion_assistant_search_core(&state.app, request).await.map_err(AppError)?;
    Ok(Json(result))
}

pub async fn get_object_source(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<dbx_core::db::ObjectSource>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let name = q.table.as_deref().unwrap_or("");
    let object_type = q.object_type.ok_or_else(|| AppError("Missing object_type".to_string()))?;
    let result =
        dbx_core::schema::get_object_source_core(&state.app, &q.connection_id, database, schema, name, object_type)
            .await
            .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn list_columns(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::get_columns_core(&state.app, &q.connection_id, database, schema, table)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn list_indexes(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_indexes_core(&state.app, &q.connection_id, database, schema, table)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn list_foreign_keys(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_foreign_keys_core(&state.app, &q.connection_id, database, schema, table)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn list_triggers(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_triggers_core(&state.app, &q.connection_id, database, schema, table)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn get_ddl(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<String>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result =
        dbx_core::schema::get_table_ddl_core(&state.app, &q.connection_id, database, schema, table, q.object_type)
            .await
            .map_err(AppError)?;
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
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
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
    .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn list_rules(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result =
        dbx_core::schema::list_rules_core(&state.app, &q.connection_id, database, schema).await.map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn list_owners(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result =
        dbx_core::schema::list_owners_core(&state.app, &q.connection_id, database, schema).await.map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}
