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
    pub object_type: Option<dbx_core::db::ObjectSourceKind>,
}

pub async fn list_databases(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::schema::list_databases_core(&state.app, &q.connection_id).await.map_err(AppError)?;
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
    let result =
        dbx_core::schema::list_tables_core(&state.app, &q.connection_id, database, schema).await.map_err(AppError)?;
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
    let result = dbx_core::schema::get_table_ddl_core(&state.app, &q.connection_id, database, schema, table)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}
