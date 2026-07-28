use crate::connection::{AppState, PoolKind};
use crate::db::hbase_driver::{self, HBasePutRowInput, HBaseRow, HBaseScanResult, HBaseTableSchema};

async fn client(state: &AppState, connection_id: &str) -> Result<hbase_driver::HBaseClient, String> {
    let pool_key = state.get_or_create_pool(connection_id, None).await?;
    let connections = state.connections.read().await;
    match connections.get(&pool_key) {
        Some(PoolKind::HBase(client)) => Ok(client.clone()),
        _ => Err("Not an HBase connection".to_string()),
    }
}

pub async fn get_table_schema_core(
    state: &AppState,
    connection_id: &str,
    namespace: &str,
    table: &str,
) -> Result<HBaseTableSchema, String> {
    hbase_driver::get_table_schema(&client(state, connection_id).await?, namespace, table).await
}

pub async fn scan_rows_core(
    state: &AppState,
    connection_id: &str,
    namespace: &str,
    table: &str,
    row_key_prefix: Option<&str>,
    limit: usize,
) -> Result<HBaseScanResult, String> {
    hbase_driver::scan_rows(&client(state, connection_id).await?, namespace, table, row_key_prefix, limit).await
}

pub async fn get_row_core(
    state: &AppState,
    connection_id: &str,
    namespace: &str,
    table: &str,
    row_key: &str,
    row_key_encoding: Option<&str>,
) -> Result<Option<HBaseRow>, String> {
    hbase_driver::get_row(&client(state, connection_id).await?, namespace, table, row_key, row_key_encoding).await
}

pub async fn put_row_core(
    state: &AppState,
    connection_id: &str,
    namespace: &str,
    table: &str,
    input: &HBasePutRowInput,
) -> Result<(), String> {
    hbase_driver::put_row(&client(state, connection_id).await?, namespace, table, input).await
}

pub async fn delete_row_core(
    state: &AppState,
    connection_id: &str,
    namespace: &str,
    table: &str,
    row_key: &str,
    row_key_encoding: Option<&str>,
) -> Result<(), String> {
    hbase_driver::delete_row(&client(state, connection_id).await?, namespace, table, row_key, row_key_encoding).await
}

pub async fn create_table_core(
    state: &AppState,
    connection_id: &str,
    namespace: &str,
    table: &str,
    column_families: &[String],
) -> Result<(), String> {
    hbase_driver::create_table(&client(state, connection_id).await?, namespace, table, column_families).await
}

pub async fn delete_table_core(
    state: &AppState,
    connection_id: &str,
    namespace: &str,
    table: &str,
) -> Result<(), String> {
    hbase_driver::delete_table(&client(state, connection_id).await?, namespace, table).await
}
