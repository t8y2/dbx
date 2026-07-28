use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use dbx_core::db::hbase_driver::{HBasePutRowInput, HBaseRow, HBaseScanResult, HBaseTableSchema};
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

async fn ensure_writable(
    app: &dbx_core::connection::AppState,
    connection_id: &str,
    action: &str,
) -> Result<(), AppError> {
    if let Some(name) = dbx_core::query::connection_readonly_name(app, connection_id).await {
        return Err(AppError::from(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. {} blocked.",
            name, action
        )));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseTableRequest {
    pub connection_id: String,
    pub namespace: String,
    pub table: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseScanRequest {
    pub connection_id: String,
    pub namespace: String,
    pub table: String,
    pub row_key_prefix: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseRowRequest {
    pub connection_id: String,
    pub namespace: String,
    pub table: String,
    pub row_key: String,
    pub row_key_encoding: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HBasePutRowRequest {
    pub connection_id: String,
    pub namespace: String,
    pub table: String,
    pub input: HBasePutRowInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseCreateTableRequest {
    pub connection_id: String,
    pub namespace: String,
    pub table: String,
    pub column_families: Vec<String>,
}

pub async fn get_table_schema(
    State(state): State<Arc<WebState>>,
    Json(request): Json<HBaseTableRequest>,
) -> Result<Json<HBaseTableSchema>, AppError> {
    let result = dbx_core::hbase_ops::get_table_schema_core(
        &state.app,
        &request.connection_id,
        &request.namespace,
        &request.table,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn scan_rows(
    State(state): State<Arc<WebState>>,
    Json(request): Json<HBaseScanRequest>,
) -> Result<Json<HBaseScanResult>, AppError> {
    let result = dbx_core::hbase_ops::scan_rows_core(
        &state.app,
        &request.connection_id,
        &request.namespace,
        &request.table,
        request.row_key_prefix.as_deref(),
        request.limit.unwrap_or(100),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get_row(
    State(state): State<Arc<WebState>>,
    Json(request): Json<HBaseRowRequest>,
) -> Result<Json<Option<HBaseRow>>, AppError> {
    let result = dbx_core::hbase_ops::get_row_core(
        &state.app,
        &request.connection_id,
        &request.namespace,
        &request.table,
        &request.row_key,
        request.row_key_encoding.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn put_row(
    State(state): State<Arc<WebState>>,
    Json(request): Json<HBasePutRowRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &request.connection_id, "Write HBase row").await?;
    dbx_core::hbase_ops::put_row_core(
        &state.app,
        &request.connection_id,
        &request.namespace,
        &request.table,
        &request.input,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn delete_row(
    State(state): State<Arc<WebState>>,
    Json(request): Json<HBaseRowRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &request.connection_id, "Delete HBase row").await?;
    dbx_core::hbase_ops::delete_row_core(
        &state.app,
        &request.connection_id,
        &request.namespace,
        &request.table,
        &request.row_key,
        request.row_key_encoding.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn create_table(
    State(state): State<Arc<WebState>>,
    Json(request): Json<HBaseCreateTableRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &request.connection_id, "Create HBase table").await?;
    dbx_core::hbase_ops::create_table_core(
        &state.app,
        &request.connection_id,
        &request.namespace,
        &request.table,
        &request.column_families,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn delete_table(
    State(state): State<Arc<WebState>>,
    Json(request): Json<HBaseTableRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &request.connection_id, "Delete HBase table").await?;
    dbx_core::hbase_ops::delete_table_core(&state.app, &request.connection_id, &request.namespace, &request.table)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}
