use std::sync::Arc;

use dbx_core::db::hbase_driver::{HBasePutRowInput, HBaseRow, HBaseScanResult, HBaseTableSchema};
use tauri::State;

use crate::commands::connection::{ensure_connection_writable, AppState};

#[tauri::command]
pub async fn hbase_get_table_schema(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    namespace: String,
    table: String,
) -> Result<HBaseTableSchema, String> {
    dbx_core::hbase_ops::get_table_schema_core(&state, &connection_id, &namespace, &table).await
}

#[tauri::command]
pub async fn hbase_scan_rows(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    namespace: String,
    table: String,
    row_key_prefix: Option<String>,
    limit: usize,
) -> Result<HBaseScanResult, String> {
    dbx_core::hbase_ops::scan_rows_core(&state, &connection_id, &namespace, &table, row_key_prefix.as_deref(), limit)
        .await
}

#[tauri::command]
pub async fn hbase_get_row(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    namespace: String,
    table: String,
    row_key: String,
    row_key_encoding: Option<String>,
) -> Result<Option<HBaseRow>, String> {
    dbx_core::hbase_ops::get_row_core(&state, &connection_id, &namespace, &table, &row_key, row_key_encoding.as_deref())
        .await
}

#[tauri::command]
pub async fn hbase_put_row(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    namespace: String,
    table: String,
    input: HBasePutRowInput,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Write HBase row").await?;
    dbx_core::hbase_ops::put_row_core(&state, &connection_id, &namespace, &table, &input).await
}

#[tauri::command]
pub async fn hbase_delete_row(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    namespace: String,
    table: String,
    row_key: String,
    row_key_encoding: Option<String>,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Delete HBase row").await?;
    dbx_core::hbase_ops::delete_row_core(
        &state,
        &connection_id,
        &namespace,
        &table,
        &row_key,
        row_key_encoding.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn hbase_create_table(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    namespace: String,
    table: String,
    column_families: Vec<String>,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Create HBase table").await?;
    dbx_core::hbase_ops::create_table_core(&state, &connection_id, &namespace, &table, &column_families).await
}

#[tauri::command]
pub async fn hbase_delete_table(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    namespace: String,
    table: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Delete HBase table").await?;
    dbx_core::hbase_ops::delete_table_core(&state, &connection_id, &namespace, &table).await
}
