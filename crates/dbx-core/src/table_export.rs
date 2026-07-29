use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

use crate::connection::MysqlMode;
use crate::connection::{config_for_pool_key, task_client_session_id, AppState, PoolKind};
use crate::csv_export::{format_csv, format_tsv, format_tsv_rows, push_csv_text_value};
pub use crate::database_export::ExportStatus;
use crate::database_export::{
    build_export_insert_statements, is_export_cancelled, is_internal_export_column, BuildExportInsertStatementsOptions,
};
use crate::db::agent_driver::AgentTableReadStartParams;
use crate::models::connection::DatabaseType;
use crate::query::{close_query_session, execute_sql_statement_with_options, QueryExecutionOptions};
use crate::transfer::{
    count_sql_with_where, execute_read_on_pool, execute_read_on_pool_with_max_rows, keyset_pagination_sql,
    pagination_sql_with_filter_order, qualified_table, quote_identifier,
};
use crate::types::QueryResult;
use crate::xlsx_export::{finish_streaming_xlsx_workbook, start_streaming_xlsx_workbook_with_options};

const DEFAULT_BATCH_SIZE: usize = 10_000;
const SQL_INSERT_BATCH_SIZE: usize = 100;

pub fn table_export_client_session_id(export_id: &str) -> String {
    task_client_session_id("table-export", export_id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableExportRequest {
    pub export_id: String,
    pub connection_id: String,
    pub database: String,
    pub schema: Option<String>,
    pub table_name: String,
    pub file_path: String,
    /// "csv", "xlsx", "json", "markdown", "sql", or "txt"
    pub format: String,
    #[serde(default)]
    pub columns: Option<Vec<String>>,
    #[serde(default)]
    pub column_types: Option<Vec<Option<String>>>,
    #[serde(default)]
    pub primary_keys: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub where_input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_by: Option<String>,
    #[serde(default)]
    pub skip_count: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_size: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_limit: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_time_format: Option<String>,
    #[serde(default)]
    pub numeric_column_right_align: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableExportProgress {
    pub export_id: String,
    pub table_name: String,
    pub rows_exported: u64,
    pub total_rows: Option<u64>,
    pub status: ExportStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// Format rows as CSV text without a header row.
/// Used for streaming subsequent pagination batches.
fn format_csv_rows(rows: &[Vec<Value>]) -> String {
    // 注意：该无表头批次路径的 Null 输出为 ""（带引号空串），与查询结果导出
    // 及首批 format_csv 的裸空单元格语义不同，直写化必须保留该差异
    let mut out = String::with_capacity(crate::csv_export::estimated_rows_capacity(rows));
    for (row_index, row) in rows.iter().enumerate() {
        if row_index > 0 {
            out.push('\n');
        }
        for (cell_index, cell) in row.iter().enumerate() {
            if cell_index > 0 {
                out.push(',');
            }
            push_csv_text_value(&mut out, cell);
        }
    }
    out
}

fn export_column_types(request: &TableExportRequest) -> Vec<String> {
    request
        .column_types
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|column_type| column_type.clone().unwrap_or_default())
        .collect()
}

fn resolve_requested_export_columns(
    database_type: DatabaseType,
    columns: &[String],
    column_types: Option<&[Option<String>]>,
    primary_keys: Option<&[String]>,
) -> (Vec<String>, Vec<Option<String>>, Vec<String>) {
    let mut resolved_columns = Vec::with_capacity(columns.len());
    let mut resolved_column_types = column_types.map(|_| Vec::with_capacity(columns.len())).unwrap_or_default();

    // Filter names and their index-aligned type metadata together so the
    // fetched rows and later SQL literal formatting keep the same positions.
    for (index, column) in columns.iter().enumerate() {
        if is_internal_export_column(Some(database_type), column) {
            continue;
        }
        resolved_columns.push(column.clone());
        if let Some(column_types) = column_types {
            resolved_column_types.push(column_types.get(index).cloned().unwrap_or(None));
        }
    }

    let resolved_primary_keys = primary_keys
        .unwrap_or_default()
        .iter()
        .filter(|column| !is_internal_export_column(Some(database_type), column))
        .cloned()
        .collect();

    (resolved_columns, resolved_column_types, resolved_primary_keys)
}

fn write_json_row_object<W: Write>(writer: &mut W, columns: &[String], row: &[Value]) -> Result<(), String> {
    writer.write_all(b"{\n").map_err(|e| format!("Failed to write JSON: {e}"))?;
    let mut first = true;
    for (index, column) in columns.iter().enumerate() {
        let Some(value) = row.get(index) else {
            continue;
        };
        if !first {
            writer.write_all(b",\n").map_err(|e| format!("Failed to write JSON: {e}"))?;
        }
        writer.write_all(b"  ").map_err(|e| format!("Failed to write JSON: {e}"))?;
        serde_json::to_writer(&mut *writer, column).map_err(|e| format!("Failed to write JSON: {e}"))?;
        writer.write_all(b": ").map_err(|e| format!("Failed to write JSON: {e}"))?;
        serde_json::to_writer(&mut *writer, value).map_err(|e| format!("Failed to write JSON: {e}"))?;
        first = false;
    }
    writer.write_all(b"\n}").map_err(|e| format!("Failed to write JSON: {e}"))
}

fn display_cell(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn markdown_cell(value: &str) -> String {
    value.replace('|', "\\|").replace("\r\n", "<br>").replace('\n', "<br>")
}

fn format_markdown_header(columns: &[String]) -> String {
    let header = columns.iter().map(|column| markdown_cell(column)).collect::<Vec<_>>().join(" | ");
    let separator = columns.iter().map(|_| "---").collect::<Vec<_>>().join(" | ");
    format!("| {header} |\n| {separator} |\n")
}

fn format_markdown_rows(rows: &[Vec<Value>]) -> String {
    rows.iter()
        .map(|row| {
            let cells = row.iter().map(|cell| markdown_cell(&display_cell(cell))).collect::<Vec<_>>().join(" | ");
            format!("| {cells} |")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[allow(clippy::too_many_arguments)]
fn table_page_sql(
    request: &TableExportRequest,
    db_type: &DatabaseType,
    col_names: &[String],
    primary_keys: &[String],
    use_keyset: bool,
    last_pk_values: &[Value],
    offset: u64,
    batch_size: usize,
) -> String {
    if use_keyset {
        keyset_pagination_sql(
            col_names,
            &request.table_name,
            request.schema.as_deref().unwrap_or(""),
            db_type,
            primary_keys,
            last_pk_values,
            batch_size,
        )
    } else {
        pagination_sql_with_filter_order(
            col_names,
            &request.table_name,
            request.schema.as_deref().unwrap_or(""),
            db_type,
            offset,
            batch_size,
            request.where_input.as_deref(),
            request.order_by.as_deref(),
            primary_keys,
        )
    }
}

fn table_cursor_sql(
    request: &TableExportRequest,
    db_type: &DatabaseType,
    col_names: &[String],
    primary_keys: &[String],
) -> String {
    let full_table = qualified_table(&request.table_name, request.schema.as_deref().unwrap_or(""), db_type);
    let col_list = col_names.iter().map(|column| quote_identifier(column, db_type)).collect::<Vec<_>>().join(", ");
    let predicate = crate::sql_dialect::normalize_where_input(request.where_input.as_deref());
    let where_clause = if predicate.is_empty() { String::new() } else { format!(" WHERE ({predicate})") };
    let order_by = request
        .order_by
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            if primary_keys.is_empty() {
                None
            } else {
                Some(
                    primary_keys
                        .iter()
                        .map(|column| format!("{} ASC", quote_identifier(column, db_type)))
                        .collect::<Vec<_>>()
                        .join(", "),
                )
            }
        })
        .map(|value| format!(" ORDER BY {value}"))
        .unwrap_or_default();

    format!("SELECT {col_list} FROM {full_table}{where_clause}{order_by}")
}

fn is_agent_table_read_unsupported(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("unknown method") || lower.contains("method not found")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TableExportCursorKind {
    Agent,
    ExternalDriver,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum TableExportCursorSession {
    Agent(String),
    ExternalDriver(String),
}

async fn table_export_cursor_kind(state: &AppState, pool_key: &str) -> Option<TableExportCursorKind> {
    let connections = state.connections.read().await;
    match connections.get(pool_key) {
        Some(PoolKind::Agent(_)) => Some(TableExportCursorKind::Agent),
        Some(PoolKind::ExternalDriver { .. }) => Some(TableExportCursorKind::ExternalDriver),
        _ => None,
    }
}

async fn table_export_query_timeout_secs(state: &AppState, pool_key: &str) -> u64 {
    let configs = state.configs.read().await;
    config_for_pool_key(pool_key, &configs).map(|config| config.query_timeout_secs).unwrap_or(0)
}

async fn execute_external_driver_export_page(
    state: &AppState,
    pool_key: &str,
    request: &TableExportRequest,
    db_type: &DatabaseType,
    col_names: &[String],
    primary_keys: &[String],
    active_batch_size: usize,
    result_session_id: Option<String>,
    cancel_token: CancellationToken,
) -> Result<QueryResult, String> {
    let sql = table_cursor_sql(request, db_type, col_names, primary_keys);
    let max_rows = request.row_limit.unwrap_or(i32::MAX as usize).min(i32::MAX as usize).max(1);
    let timeout_secs = table_export_query_timeout_secs(state, pool_key).await;
    execute_sql_statement_with_options(
        state,
        &request.connection_id,
        &request.database,
        &sql,
        request.schema.as_deref(),
        Some(cancel_token),
        QueryExecutionOptions {
            max_rows: Some(max_rows),
            fetch_size: Some(active_batch_size),
            page_size: Some(active_batch_size),
            result_session_id,
            client_session_id: Some(table_export_client_session_id(&request.export_id)),
            timeout_secs: Some(timeout_secs),
            ..Default::default()
        },
    )
    .await
}

async fn execute_table_export_count(
    state: &AppState,
    pool_key: &str,
    request: &TableExportRequest,
    sql: &str,
    cancel_token: CancellationToken,
) -> Result<QueryResult, String> {
    if table_export_cursor_kind(state, pool_key).await != Some(TableExportCursorKind::ExternalDriver) {
        return execute_read_on_pool(state, pool_key, sql).await;
    }

    let timeout_secs = table_export_query_timeout_secs(state, pool_key).await;
    execute_sql_statement_with_options(
        state,
        &request.connection_id,
        &request.database,
        sql,
        request.schema.as_deref(),
        Some(cancel_token),
        QueryExecutionOptions {
            max_rows: Some(1),
            fetch_size: Some(1),
            client_session_id: Some(table_export_client_session_id(&request.export_id)),
            timeout_secs: Some(timeout_secs),
            ..Default::default()
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn fetch_table_export_batch(
    state: &AppState,
    pool_key: &str,
    request: &TableExportRequest,
    db_type: &DatabaseType,
    col_names: &[String],
    primary_keys: &[String],
    use_keyset: bool,
    last_pk_values: &[Value],
    offset: u64,
    active_batch_size: usize,
    cursor_session: &mut Option<TableExportCursorSession>,
    table_read_attempted: &mut bool,
    table_read_completed: &mut bool,
    cancel_token: CancellationToken,
) -> Result<QueryResult, String> {
    if *table_read_completed {
        return Ok(QueryResult {
            columns: col_names.to_vec(),
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            rows: Vec::new(),
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
        });
    }

    if !*table_read_attempted {
        match table_export_cursor_kind(state, pool_key).await {
            Some(TableExportCursorKind::Agent) => {
                *table_read_attempted = true;
                let sql = table_cursor_sql(request, db_type, col_names, primary_keys);
                let max_rows = request.row_limit.unwrap_or(i32::MAX as usize);
                let query_timeout = table_export_query_timeout_secs(state, pool_key).await;
                let params = AgentTableReadStartParams {
                    sql,
                    database: Some(request.database.clone()),
                    schema: request.schema.clone(),
                    page_size: active_batch_size,
                    max_rows,
                    fetch_size: Some(active_batch_size),
                    timeout_secs: (query_timeout > 0).then_some(query_timeout),
                };
                let connections = state.connections.read().await;
                let Some(PoolKind::Agent(client)) = connections.get(pool_key) else {
                    return Err("Agent table read requires an agent connection".to_string());
                };
                let client = client.clone();
                drop(connections);
                let mut client = client.lock().await;
                match client.start_table_read::<QueryResult>(params).await {
                    Ok(result) => {
                        *cursor_session = result.session_id.clone().map(TableExportCursorSession::Agent);
                        if result.session_id.is_none() && !result.has_more {
                            *table_read_completed = true;
                        }
                        return Ok(result);
                    }
                    Err(error) if is_agent_table_read_unsupported(&error) => {
                        log::debug!("Agent table-read cursor unsupported, falling back to paginated export: {error}");
                    }
                    Err(error) => return Err(error),
                }
            }
            Some(TableExportCursorKind::ExternalDriver) => {
                *table_read_attempted = true;
                let result = execute_external_driver_export_page(
                    state,
                    pool_key,
                    request,
                    db_type,
                    col_names,
                    primary_keys,
                    active_batch_size,
                    None,
                    cancel_token.clone(),
                )
                .await?;
                if result.has_more {
                    let session_id = result
                        .session_id
                        .clone()
                        .ok_or("JDBC export cursor did not return a session id for additional rows")?;
                    *cursor_session = Some(TableExportCursorSession::ExternalDriver(session_id));
                } else {
                    *table_read_completed = true;
                }
                return Ok(result);
            }
            None => {}
        }
    }

    if let Some(session) = cursor_session.clone() {
        return match session {
            TableExportCursorSession::Agent(session_id) => {
                let connections = state.connections.read().await;
                let Some(PoolKind::Agent(client)) = connections.get(pool_key) else {
                    return Err("Table read session requires an agent connection".to_string());
                };
                let client = client.clone();
                drop(connections);
                let mut client = client.lock().await;
                match client.fetch_table_read_page::<QueryResult>(&session_id, active_batch_size).await {
                    Ok(result) => {
                        *cursor_session =
                            result.session_id.clone().or(Some(session_id)).map(TableExportCursorSession::Agent);
                        if !result.has_more {
                            *cursor_session = None;
                            *table_read_completed = true;
                        }
                        Ok(result)
                    }
                    Err(error) => {
                        let _ = client.close_table_read_session::<bool>(&session_id).await;
                        *cursor_session = None;
                        Err(error)
                    }
                }
            }
            TableExportCursorSession::ExternalDriver(session_id) => {
                match execute_external_driver_export_page(
                    state,
                    pool_key,
                    request,
                    db_type,
                    col_names,
                    primary_keys,
                    active_batch_size,
                    Some(session_id.clone()),
                    cancel_token.clone(),
                )
                .await
                {
                    Ok(result) => {
                        if result.has_more {
                            let next_session_id = result.session_id.clone().unwrap_or(session_id);
                            *cursor_session = Some(TableExportCursorSession::ExternalDriver(next_session_id));
                        } else {
                            *cursor_session = None;
                            *table_read_completed = true;
                        }
                        Ok(result)
                    }
                    Err(error) => {
                        if cancel_token.is_cancelled() {
                            cursor_session.take();
                        } else {
                            close_table_export_cursor_if_open(state, pool_key, request, cursor_session).await;
                        }
                        Err(error)
                    }
                }
            }
        };
    }

    fetch_paginated_table_export_batch(
        state,
        pool_key,
        request,
        db_type,
        col_names,
        primary_keys,
        use_keyset,
        last_pk_values,
        offset,
        active_batch_size,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn fetch_paginated_table_export_batch(
    state: &AppState,
    pool_key: &str,
    request: &TableExportRequest,
    db_type: &DatabaseType,
    col_names: &[String],
    primary_keys: &[String],
    use_keyset: bool,
    last_pk_values: &[Value],
    offset: u64,
    active_batch_size: usize,
) -> Result<QueryResult, String> {
    let sql = table_page_sql(
        request,
        db_type,
        col_names,
        primary_keys,
        use_keyset,
        last_pk_values,
        offset,
        active_batch_size,
    );
    execute_read_on_pool_with_max_rows(state, pool_key, &sql, Some(active_batch_size)).await
}

async fn close_table_export_cursor_if_open(
    state: &AppState,
    pool_key: &str,
    request: &TableExportRequest,
    cursor_session: &mut Option<TableExportCursorSession>,
) {
    let Some(session) = cursor_session.take() else {
        return;
    };
    match session {
        TableExportCursorSession::Agent(session_id) => {
            let connections = state.connections.read().await;
            let Some(PoolKind::Agent(client)) = connections.get(pool_key) else {
                return;
            };
            let client = client.clone();
            drop(connections);
            let mut client = client.lock().await;
            let _ = client.close_table_read_session::<bool>(&session_id).await;
        }
        TableExportCursorSession::ExternalDriver(session_id) => {
            let client_session_id = table_export_client_session_id(&request.export_id);
            let _ = close_query_session(
                state,
                &request.connection_id,
                &request.database,
                &session_id,
                Some(&client_session_id),
                None,
            )
            .await;
        }
    }
}

async fn start_export_cancel_watcher(export_id: String, cancelled: Arc<AtomicBool>, token: CancellationToken) {
    loop {
        if is_export_cancelled(&export_id).await {
            cancelled.store(true, Ordering::SeqCst);
            token.cancel();
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn stream_native_table_rows(
    state: &AppState,
    pool_key: &str,
    db_type: &DatabaseType,
    sql: &str,
    row_limit: Option<usize>,
    cancelled: &AtomicBool,
    cancel_token: CancellationToken,
    on_row: impl FnMut(&[Value]) -> Result<(), String>,
) -> Result<bool, String> {
    let connections = state.connections.read().await;
    match connections.get(pool_key) {
        Some(PoolKind::Mysql(pool, mode)) => {
            let pool = pool.clone();
            let bare = *mode == MysqlMode::Bare;
            drop(connections);
            crate::db::mysql::stream_query_rows(
                &pool,
                sql,
                bare,
                row_limit,
                crate::db::mysql::MySqlQueryDialect::for_connection(*db_type, None),
                cancelled,
                on_row,
            )
            .await?;
            Ok(true)
        }
        Some(PoolKind::Postgres(pool)) => {
            let pool = pool.clone();
            drop(connections);
            crate::db::postgres::stream_query_rows(&pool, sql, row_limit, cancelled, on_row).await?;
            Ok(true)
        }
        Some(PoolKind::SqlServer(client)) => {
            let client = client.clone();
            drop(connections);
            let mut on_row = on_row;
            let mut client = client.lock().await;
            crate::db::sqlserver::stream_first_result_set(&mut client, sql, row_limit, Some(cancel_token), |item| {
                if let crate::db::sqlserver::SqlServerStreamItem::Row(row) = item {
                    on_row(row)?;
                }
                Ok(())
            })
            .await?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

#[allow(clippy::too_many_arguments)]
async fn try_export_native_table_stream(
    state: &AppState,
    pool_key: &str,
    request: &TableExportRequest,
    db_type: &DatabaseType,
    col_names: &[String],
    column_types: &[Option<String>],
    column_extras: &[Option<String>],
    primary_keys: &[String],
    total_rows: Option<u64>,
    row_limit: Option<usize>,
    batch_size: usize,
    on_progress: &impl Fn(TableExportProgress),
    cancelled: Arc<AtomicBool>,
    cancel_token: CancellationToken,
) -> Result<bool, String> {
    let sql = table_cursor_sql(request, db_type, col_names, primary_keys);
    let mut rows_exported = 0_u64;
    let progress_interval = batch_size.max(1) as u64;

    let stream_result = match request.format.to_lowercase().as_str() {
        "csv" => {
            let mut file = BufWriter::new(
                std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?,
            );
            file.write_all(b"\xEF\xBB\xBF").map_err(|e| format!("Failed to write BOM: {e}"))?;
            let header = format_csv(col_names, &[]);
            let header = header.strip_suffix('\n').unwrap_or(&header);
            file.write_all(header.as_bytes()).map_err(|e| format!("Failed to write CSV: {e}"))?;

            let result = stream_native_table_rows(
                state,
                pool_key,
                db_type,
                &sql,
                row_limit,
                &cancelled,
                cancel_token.clone(),
                |row| {
                    let formatted = crate::temporal_format::format_temporal_export_row(
                        row,
                        column_types,
                        request.date_time_format.as_deref(),
                    );
                    let row_csv = format_csv_rows(&[formatted]);
                    write!(file, "\n{row_csv}").map_err(|e| format!("Failed to write CSV rows: {e}"))?;
                    rows_exported += 1;
                    if rows_exported.is_multiple_of(progress_interval) {
                        on_progress(TableExportProgress {
                            export_id: request.export_id.clone(),
                            table_name: request.table_name.clone(),
                            rows_exported,
                            total_rows,
                            status: ExportStatus::Running,
                            error_message: None,
                        });
                    }
                    Ok(())
                },
            )
            .await;
            if result.is_ok() {
                file.flush().map_err(|e| format!("Failed to flush export file: {e}"))?;
            }
            result
        }
        "txt" => {
            let mut file = BufWriter::new(
                std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?,
            );
            let header = format_tsv(col_names, &[]);
            let header = header.strip_suffix('\n').unwrap_or(&header);
            file.write_all(header.as_bytes()).map_err(|e| format!("Failed to write TXT: {e}"))?;

            let result = stream_native_table_rows(
                state,
                pool_key,
                db_type,
                &sql,
                row_limit,
                &cancelled,
                cancel_token.clone(),
                |row| {
                    let formatted = crate::temporal_format::format_temporal_export_row(
                        row,
                        column_types,
                        request.date_time_format.as_deref(),
                    );
                    let row_tsv = format_tsv_rows(&[formatted]);
                    write!(file, "\n{row_tsv}").map_err(|e| format!("Failed to write TXT rows: {e}"))?;
                    rows_exported += 1;
                    if rows_exported.is_multiple_of(progress_interval) {
                        on_progress(TableExportProgress {
                            export_id: request.export_id.clone(),
                            table_name: request.table_name.clone(),
                            rows_exported,
                            total_rows,
                            status: ExportStatus::Running,
                            error_message: None,
                        });
                    }
                    Ok(())
                },
            )
            .await;
            if result.is_ok() {
                file.flush().map_err(|e| format!("Failed to flush export file: {e}"))?;
            }
            result
        }
        "xlsx" => {
            let xlsx_column_types = export_column_types(request);
            let xlsx_file =
                std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
            let mut writer = start_streaming_xlsx_workbook_with_options(
                BufWriter::new(xlsx_file),
                Some(&request.table_name),
                col_names,
                &xlsx_column_types,
                &[],
                request.date_time_format.as_deref(),
                request.numeric_column_right_align,
            )?;
            let result = stream_native_table_rows(
                state,
                pool_key,
                db_type,
                &sql,
                row_limit,
                &cancelled,
                cancel_token.clone(),
                |row| {
                    let formatted = crate::temporal_format::format_temporal_export_row(
                        row,
                        column_types,
                        request.date_time_format.as_deref(),
                    );
                    writer.write_row(&formatted).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                    rows_exported += 1;
                    if rows_exported.is_multiple_of(progress_interval) {
                        on_progress(TableExportProgress {
                            export_id: request.export_id.clone(),
                            table_name: request.table_name.clone(),
                            rows_exported,
                            total_rows,
                            status: ExportStatus::Running,
                            error_message: None,
                        });
                    }
                    Ok(())
                },
            )
            .await;
            if result.is_ok() {
                on_progress(TableExportProgress {
                    export_id: request.export_id.clone(),
                    table_name: request.table_name.clone(),
                    rows_exported,
                    total_rows,
                    status: ExportStatus::Writing,
                    error_message: None,
                });
                let mut xlsx_buf =
                    finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
                xlsx_buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
            }
            result
        }
        "json" => {
            let mut file = BufWriter::new(
                std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?,
            );
            file.write_all(b"[\n").map_err(|e| format!("Failed to write JSON: {e}"))?;
            let mut is_first_row = true;
            let result = stream_native_table_rows(
                state,
                pool_key,
                db_type,
                &sql,
                row_limit,
                &cancelled,
                cancel_token.clone(),
                |row| {
                    if !is_first_row {
                        file.write_all(b",\n").map_err(|e| format!("Failed to write JSON: {e}"))?;
                    }
                    let formatted = crate::temporal_format::format_temporal_export_row(
                        row,
                        column_types,
                        request.date_time_format.as_deref(),
                    );
                    write_json_row_object(&mut file, col_names, &formatted)?;
                    is_first_row = false;
                    rows_exported += 1;
                    if rows_exported.is_multiple_of(progress_interval) {
                        on_progress(TableExportProgress {
                            export_id: request.export_id.clone(),
                            table_name: request.table_name.clone(),
                            rows_exported,
                            total_rows,
                            status: ExportStatus::Running,
                            error_message: None,
                        });
                    }
                    Ok(())
                },
            )
            .await;
            if result.is_ok() {
                file.write_all(b"\n]\n").map_err(|e| format!("Failed to write JSON: {e}"))?;
                file.flush().map_err(|e| format!("Failed to flush export file: {e}"))?;
            }
            result
        }
        "markdown" | "md" => {
            let mut file = BufWriter::new(
                std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?,
            );
            file.write_all(format_markdown_header(col_names).as_bytes())
                .map_err(|e| format!("Failed to write Markdown: {e}"))?;
            let mut wrote_rows = false;
            let result = stream_native_table_rows(
                state,
                pool_key,
                db_type,
                &sql,
                row_limit,
                &cancelled,
                cancel_token.clone(),
                |row| {
                    let formatted = crate::temporal_format::format_temporal_export_row(
                        row,
                        column_types,
                        request.date_time_format.as_deref(),
                    );
                    let rows_markdown = format_markdown_rows(&[formatted]);
                    if !rows_markdown.is_empty() {
                        if wrote_rows {
                            file.write_all(b"\n").map_err(|e| format!("Failed to write Markdown: {e}"))?;
                        }
                        file.write_all(rows_markdown.as_bytes())
                            .map_err(|e| format!("Failed to write Markdown: {e}"))?;
                        wrote_rows = true;
                    }
                    rows_exported += 1;
                    if rows_exported.is_multiple_of(progress_interval) {
                        on_progress(TableExportProgress {
                            export_id: request.export_id.clone(),
                            table_name: request.table_name.clone(),
                            rows_exported,
                            total_rows,
                            status: ExportStatus::Running,
                            error_message: None,
                        });
                    }
                    Ok(())
                },
            )
            .await;
            if result.is_ok() {
                file.write_all(b"\n").map_err(|e| format!("Failed to write Markdown: {e}"))?;
                file.flush().map_err(|e| format!("Failed to flush export file: {e}"))?;
            }
            result
        }
        "sql" => {
            let mut file = BufWriter::new(
                std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?,
            );
            let mut pending_rows: Vec<Vec<Value>> = Vec::new();
            let mut wrote_statements = false;
            let mut flush_pending =
                |file: &mut BufWriter<std::fs::File>, pending_rows: &mut Vec<Vec<Value>>| -> Result<(), String> {
                    if pending_rows.is_empty() {
                        return Ok(());
                    }
                    let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
                        database_type: Some(*db_type),
                        schema: request.schema.clone(),
                        table_name: Some(request.table_name.clone()),
                        qualified_table_name: None,
                        columns: col_names.to_vec(),
                        column_types: column_types.to_vec(),
                        column_extras: column_extras.to_vec(),
                        rows: std::mem::take(pending_rows),
                        batch_size: Some(SQL_INSERT_BATCH_SIZE),
                    })?;
                    if !statements.is_empty() {
                        if wrote_statements {
                            file.write_all(b"\n").map_err(|e| format!("Failed to write SQL: {e}"))?;
                        }
                        file.write_all(statements.join("\n").as_bytes())
                            .map_err(|e| format!("Failed to write SQL: {e}"))?;
                        wrote_statements = true;
                    }
                    Ok(())
                };
            let result = stream_native_table_rows(
                state,
                pool_key,
                db_type,
                &sql,
                row_limit,
                &cancelled,
                cancel_token.clone(),
                |row| {
                    pending_rows.push(row.to_vec());
                    if pending_rows.len() >= SQL_INSERT_BATCH_SIZE {
                        flush_pending(&mut file, &mut pending_rows)?;
                    }
                    rows_exported += 1;
                    if rows_exported.is_multiple_of(progress_interval) {
                        on_progress(TableExportProgress {
                            export_id: request.export_id.clone(),
                            table_name: request.table_name.clone(),
                            rows_exported,
                            total_rows,
                            status: ExportStatus::Running,
                            error_message: None,
                        });
                    }
                    Ok(())
                },
            )
            .await;
            if result.is_ok() {
                flush_pending(&mut file, &mut pending_rows)?;
                if wrote_statements {
                    file.write_all(b"\n").map_err(|e| format!("Failed to write SQL: {e}"))?;
                }
                file.flush().map_err(|e| format!("Failed to flush export file: {e}"))?;
            }
            result
        }
        _ => Ok(false),
    };

    match stream_result {
        Ok(false) => Ok(false),
        Ok(true) => {
            if !rows_exported.is_multiple_of(progress_interval) {
                on_progress(TableExportProgress {
                    export_id: request.export_id.clone(),
                    table_name: request.table_name.clone(),
                    rows_exported,
                    total_rows,
                    status: ExportStatus::Running,
                    error_message: None,
                });
            }
            on_progress(TableExportProgress {
                export_id: request.export_id.clone(),
                table_name: request.table_name.clone(),
                rows_exported,
                total_rows,
                status: ExportStatus::Done,
                error_message: None,
            });
            Ok(true)
        }
        Err(error) if cancelled.load(Ordering::SeqCst) || error == crate::query::canceled_error() => {
            on_progress(TableExportProgress {
                export_id: request.export_id.clone(),
                table_name: request.table_name.clone(),
                rows_exported,
                total_rows,
                status: ExportStatus::Cancelled,
                error_message: Some("Export cancelled".to_string()),
            });
            Ok(true)
        }
        Err(error) => Err(error),
    }
}

fn next_export_batch_size(row_limit: Option<usize>, rows_exported: u64, batch_size: usize) -> Option<usize> {
    let remaining = row_limit.map(|limit| limit.saturating_sub(rows_exported as usize));
    if matches!(remaining, Some(0)) {
        return None;
    }
    Some(remaining.map_or(batch_size, |value| value.min(batch_size)).max(1))
}

pub async fn export_table_data_core(
    state: &AppState,
    request: &TableExportRequest,
    on_progress: impl Fn(TableExportProgress),
) -> Result<(), String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_token = CancellationToken::new();
    let cancel_watcher =
        tokio::spawn(start_export_cancel_watcher(request.export_id.clone(), cancelled.clone(), cancel_token.clone()));
    let last_rows_exported = std::sync::atomic::AtomicU64::new(0);
    let tracked_progress = |progress: TableExportProgress| {
        last_rows_exported.store(progress.rows_exported, Ordering::SeqCst);
        on_progress(progress);
    };
    let result =
        export_table_data_core_inner(state, request, &tracked_progress, cancelled.clone(), cancel_token.clone()).await;
    cancel_watcher.abort();
    let client_session_id = table_export_client_session_id(&request.export_id);
    let _ = state.close_client_session_pool(&request.connection_id, Some(&request.database), &client_session_id).await;
    match result {
        Err(error) if cancelled.load(Ordering::SeqCst) || error == crate::query::canceled_error() => {
            on_progress(TableExportProgress {
                export_id: request.export_id.clone(),
                table_name: request.table_name.clone(),
                rows_exported: last_rows_exported.load(Ordering::SeqCst),
                total_rows: None,
                status: ExportStatus::Cancelled,
                error_message: Some("Export cancelled".to_string()),
            });
            Ok(())
        }
        result => result,
    }
}

async fn export_table_data_core_inner(
    state: &AppState,
    request: &TableExportRequest,
    on_progress: &impl Fn(TableExportProgress),
    cancelled: Arc<AtomicBool>,
    cancel_token: CancellationToken,
) -> Result<(), String> {
    // 1. Get database type
    let db_type = state
        .configs
        .read()
        .await
        .get(&request.connection_id)
        .map(|c| c.db_type)
        .ok_or_else(|| format!("Connection config not found: {}", request.connection_id))?;

    // 2. Get pool
    let client_session_id = table_export_client_session_id(&request.export_id);
    let pool_key = state
        .get_or_create_pool_for_session(&request.connection_id, Some(&request.database), Some(&client_session_id))
        .await?;

    // 3. Resolve columns. Data grid exports can provide columns/primary keys
    // directly, which avoids expensive metadata round-trips on JDBC drivers.
    let requested_columns = request.columns.as_ref().filter(|columns| !columns.is_empty());
    let (col_names, column_types, column_extras, primary_keys) = if let Some(requested_columns) = requested_columns {
        let (col_names, column_types, primary_keys) = resolve_requested_export_columns(
            db_type,
            requested_columns,
            request.column_types.as_deref(),
            request.primary_keys.as_deref(),
        );
        (col_names, column_types, Vec::new(), primary_keys)
    } else {
        let columns = crate::schema::get_columns_core(
            state,
            &request.connection_id,
            &request.database,
            request.schema.as_deref().unwrap_or(""),
            &request.table_name,
        )
        .await?;
        let col_names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
        let column_types: Vec<Option<String>> = columns.iter().map(|c| Some(c.data_type.clone())).collect();
        let column_extras: Vec<Option<String>> = columns.iter().map(|c| c.extra.clone()).collect();
        let primary_keys: Vec<String> = columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.clone()).collect();
        (col_names, column_types, column_extras, primary_keys)
    };

    if col_names.is_empty() {
        return Err("No columns found for table".to_string());
    }

    // Use keyset pagination when all PKs are in the selected (filtered) columns.
    // This avoids the OFFSET performance penalty for large tables.
    // When no PK is available, falls back to offset-based pagination.
    let has_custom_filter_or_order = request.where_input.as_ref().is_some_and(|value| !value.trim().is_empty())
        || request.order_by.as_ref().is_some_and(|value| !value.trim().is_empty());
    let use_keyset =
        !has_custom_filter_or_order && !primary_keys.is_empty() && primary_keys.iter().all(|pk| col_names.contains(pk));

    // PK column indices within result rows (for extracting last-row values)
    let pk_indices: Vec<usize> = if use_keyset {
        primary_keys.iter().map(|pk| col_names.iter().position(|c| c == pk).unwrap()).collect()
    } else {
        Vec::new()
    };

    // 6. Get total row count for progress estimation when requested. Data
    // grid exports skip this by default because COUNT can be the slowest query
    // on large HANA/JDBC tables, especially with filters.
    let row_limit = request.row_limit;
    let total_rows = if request.skip_count {
        None
    } else {
        let count_query = count_sql_with_where(
            &request.table_name,
            request.schema.as_deref().unwrap_or(""),
            &db_type,
            request.where_input.as_deref(),
        );
        match execute_table_export_count(state, &pool_key, request, &count_query, cancel_token.clone()).await {
            Ok(result) => result
                .rows
                .first()
                .and_then(|r| r.first())
                .and_then(|v| match v {
                    Value::Number(n) => n.as_u64(),
                    Value::String(s) => s.parse::<u64>().ok(),
                    _ => None,
                })
                .map(|total| row_limit.map_or(total, |limit| total.min(limit as u64))),
            Err(_) => None,
        }
    };

    // 7. Emit initial Running progress
    on_progress(TableExportProgress {
        export_id: request.export_id.clone(),
        table_name: request.table_name.clone(),
        rows_exported: 0,
        total_rows,
        status: ExportStatus::Running,
        error_message: None,
    });

    if try_export_native_table_stream(
        state,
        &pool_key,
        request,
        &db_type,
        &col_names,
        &column_types,
        &column_extras,
        &primary_keys,
        total_rows,
        row_limit,
        request.batch_size.unwrap_or(DEFAULT_BATCH_SIZE).max(1),
        &on_progress,
        cancelled,
        cancel_token.clone(),
    )
    .await?
    {
        return Ok(());
    }

    // 8. Create output file
    let file = std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?;
    let mut file = BufWriter::new(file);

    let mut rows_exported: u64 = 0;
    let batch_size = request.batch_size.unwrap_or(DEFAULT_BATCH_SIZE).max(1);
    let mut offset: u64 = 0;
    let mut cursor_session: Option<TableExportCursorSession> = None;
    let mut table_read_attempted = false;
    let mut table_read_completed = false;

    // Track last primary key values for keyset pagination
    let mut last_pk_values: Vec<Value> = Vec::new();

    match request.format.to_lowercase().as_str() {
        "csv" => {
            // Write UTF-8 BOM
            file.write_all(b"\xEF\xBB\xBF").map_err(|e| format!("Failed to write BOM: {e}"))?;

            let mut is_first_batch = true;

            loop {
                // Check cancellation between batches
                if is_export_cancelled(&request.export_id).await {
                    on_progress(TableExportProgress {
                        export_id: request.export_id.clone(),
                        table_name: request.table_name.clone(),
                        rows_exported,
                        total_rows,
                        status: ExportStatus::Cancelled,
                        error_message: Some("Export cancelled".to_string()),
                    });
                    close_table_export_cursor_if_open(state, &pool_key, request, &mut cursor_session).await;
                    return Ok(());
                }

                let Some(active_batch_size) = next_export_batch_size(row_limit, rows_exported, batch_size) else {
                    break;
                };
                let result = fetch_table_export_batch(
                    state,
                    &pool_key,
                    request,
                    &db_type,
                    &col_names,
                    &primary_keys,
                    use_keyset,
                    &last_pk_values,
                    offset,
                    active_batch_size,
                    &mut cursor_session,
                    &mut table_read_attempted,
                    &mut table_read_completed,
                    cancel_token.clone(),
                )
                .await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }
                let formatted_rows = crate::temporal_format::format_temporal_export_rows(
                    &result.rows,
                    &column_types,
                    request.date_time_format.as_deref(),
                );

                if is_first_batch {
                    // First batch: write header + rows via format_csv
                    let csv_content = format_csv(&col_names, &formatted_rows);
                    file.write_all(csv_content.as_bytes()).map_err(|e| format!("Failed to write CSV: {e}"))?;
                    is_first_batch = false;
                } else {
                    // Subsequent batches: write rows only (prepend newline for separation)
                    let rows_csv = format_csv_rows(&formatted_rows);
                    if !rows_csv.is_empty() {
                        write!(file, "\n{rows_csv}").map_err(|e| format!("Failed to write CSV rows: {e}"))?;
                    }
                }

                rows_exported += row_count as u64;

                if use_keyset {
                    // Keyset pagination: track last PK values for next batch
                    if let Some(last_row) = result.rows.last() {
                        last_pk_values = pk_indices.iter().map(|&i| last_row[i].clone()).collect();
                    }
                } else {
                    offset += row_count as u64;
                }

                on_progress(TableExportProgress {
                    export_id: request.export_id.clone(),
                    table_name: request.table_name.clone(),
                    rows_exported,
                    total_rows,
                    status: ExportStatus::Running,
                    error_message: None,
                });

                if row_count < active_batch_size {
                    break;
                }
            }
        }
        "txt" => {
            let mut is_first_batch = true;
            let header = format_tsv(&col_names, &[]);
            let header = header.strip_suffix('\n').unwrap_or(&header);
            file.write_all(header.as_bytes()).map_err(|e| format!("Failed to write TXT: {e}"))?;

            loop {
                if is_export_cancelled(&request.export_id).await {
                    on_progress(TableExportProgress {
                        export_id: request.export_id.clone(),
                        table_name: request.table_name.clone(),
                        rows_exported,
                        total_rows,
                        status: ExportStatus::Cancelled,
                        error_message: Some("Export cancelled".to_string()),
                    });
                    close_table_export_cursor_if_open(state, &pool_key, request, &mut cursor_session).await;
                    return Ok(());
                }

                let Some(active_batch_size) = next_export_batch_size(row_limit, rows_exported, batch_size) else {
                    break;
                };
                let result = fetch_table_export_batch(
                    state,
                    &pool_key,
                    request,
                    &db_type,
                    &col_names,
                    &primary_keys,
                    use_keyset,
                    &last_pk_values,
                    offset,
                    active_batch_size,
                    &mut cursor_session,
                    &mut table_read_attempted,
                    &mut table_read_completed,
                    cancel_token.clone(),
                )
                .await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }
                let formatted_rows = crate::temporal_format::format_temporal_export_rows(
                    &result.rows,
                    &column_types,
                    request.date_time_format.as_deref(),
                );

                if is_first_batch {
                    let rows_tsv = format_tsv_rows(&formatted_rows);
                    write!(file, "\n{rows_tsv}").map_err(|e| format!("Failed to write TXT rows: {e}"))?;
                    is_first_batch = false;
                } else {
                    let rows_tsv = format_tsv_rows(&formatted_rows);
                    if !rows_tsv.is_empty() {
                        write!(file, "\n{rows_tsv}").map_err(|e| format!("Failed to write TXT rows: {e}"))?;
                    }
                }

                rows_exported += row_count as u64;

                if use_keyset {
                    if let Some(last_row) = result.rows.last() {
                        last_pk_values = pk_indices.iter().map(|&i| last_row[i].clone()).collect();
                    }
                } else {
                    offset += row_count as u64;
                }

                on_progress(TableExportProgress {
                    export_id: request.export_id.clone(),
                    table_name: request.table_name.clone(),
                    rows_exported,
                    total_rows,
                    status: ExportStatus::Running,
                    error_message: None,
                });

                if row_count < active_batch_size {
                    break;
                }
            }
        }
        "xlsx" => {
            let xlsx_column_types = export_column_types(request);
            // Create a dedicated file handle for the streaming XLSX writer
            // instead of cloning the outer BufWriter's handle.  This avoids
            // sharing a file descriptor between two independent buffers.
            let xlsx_file =
                std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
            let mut writer = start_streaming_xlsx_workbook_with_options(
                BufWriter::new(xlsx_file),
                Some(&request.table_name),
                &col_names,
                &xlsx_column_types,
                &[],
                request.date_time_format.as_deref(),
                request.numeric_column_right_align,
            )?;

            loop {
                // Check cancellation between batches
                if is_export_cancelled(&request.export_id).await {
                    on_progress(TableExportProgress {
                        export_id: request.export_id.clone(),
                        table_name: request.table_name.clone(),
                        rows_exported,
                        total_rows,
                        status: ExportStatus::Cancelled,
                        error_message: Some("Export cancelled".to_string()),
                    });
                    close_table_export_cursor_if_open(state, &pool_key, request, &mut cursor_session).await;
                    return Ok(());
                }

                let Some(active_batch_size) = next_export_batch_size(row_limit, rows_exported, batch_size) else {
                    break;
                };
                let result = fetch_table_export_batch(
                    state,
                    &pool_key,
                    request,
                    &db_type,
                    &col_names,
                    &primary_keys,
                    use_keyset,
                    &last_pk_values,
                    offset,
                    active_batch_size,
                    &mut cursor_session,
                    &mut table_read_attempted,
                    &mut table_read_completed,
                    cancel_token.clone(),
                )
                .await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                for row in &result.rows {
                    let formatted = crate::temporal_format::format_temporal_export_row(
                        row,
                        &column_types,
                        request.date_time_format.as_deref(),
                    );
                    writer.write_row(&formatted).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                }
                rows_exported += row_count as u64;

                if use_keyset {
                    // Keyset pagination: track last PK values for next batch
                    if let Some(last_row) = result.rows.last() {
                        last_pk_values = pk_indices.iter().map(|&i| last_row[i].clone()).collect();
                    }
                } else {
                    offset += row_count as u64;
                }

                on_progress(TableExportProgress {
                    export_id: request.export_id.clone(),
                    table_name: request.table_name.clone(),
                    rows_exported,
                    total_rows,
                    status: ExportStatus::Running,
                    error_message: None,
                });

                if row_count < active_batch_size {
                    break;
                }
            }

            // Emit Writing progress before building XLSX
            on_progress(TableExportProgress {
                export_id: request.export_id.clone(),
                table_name: request.table_name.clone(),
                rows_exported,
                total_rows,
                status: ExportStatus::Writing,
                error_message: None,
            });

            // Explicitly flush the XLSX writer's BufWriter so IO errors
            // (e.g. disk-full) are surfaced rather than silently swallowed
            // by Drop.
            let mut xlsx_buf =
                finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
            xlsx_buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
        }
        "json" => {
            file.write_all(b"[\n").map_err(|e| format!("Failed to write JSON: {e}"))?;
            let mut is_first_row = true;

            loop {
                if is_export_cancelled(&request.export_id).await {
                    on_progress(TableExportProgress {
                        export_id: request.export_id.clone(),
                        table_name: request.table_name.clone(),
                        rows_exported,
                        total_rows,
                        status: ExportStatus::Cancelled,
                        error_message: Some("Export cancelled".to_string()),
                    });
                    close_table_export_cursor_if_open(state, &pool_key, request, &mut cursor_session).await;
                    return Ok(());
                }

                let Some(active_batch_size) = next_export_batch_size(row_limit, rows_exported, batch_size) else {
                    break;
                };
                let result = fetch_table_export_batch(
                    state,
                    &pool_key,
                    request,
                    &db_type,
                    &col_names,
                    &primary_keys,
                    use_keyset,
                    &last_pk_values,
                    offset,
                    active_batch_size,
                    &mut cursor_session,
                    &mut table_read_attempted,
                    &mut table_read_completed,
                    cancel_token.clone(),
                )
                .await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                for row in &result.rows {
                    if !is_first_row {
                        file.write_all(b",\n").map_err(|e| format!("Failed to write JSON: {e}"))?;
                    }
                    let formatted = crate::temporal_format::format_temporal_export_row(
                        row,
                        &column_types,
                        request.date_time_format.as_deref(),
                    );
                    write_json_row_object(&mut file, &col_names, &formatted)?;
                    is_first_row = false;
                }

                rows_exported += row_count as u64;
                if use_keyset {
                    if let Some(last_row) = result.rows.last() {
                        last_pk_values = pk_indices.iter().map(|&i| last_row[i].clone()).collect();
                    }
                } else {
                    offset += row_count as u64;
                }

                on_progress(TableExportProgress {
                    export_id: request.export_id.clone(),
                    table_name: request.table_name.clone(),
                    rows_exported,
                    total_rows,
                    status: ExportStatus::Running,
                    error_message: None,
                });

                if row_count < active_batch_size {
                    break;
                }
            }

            file.write_all(b"\n]\n").map_err(|e| format!("Failed to write JSON: {e}"))?;
        }
        "markdown" | "md" => {
            file.write_all(format_markdown_header(&col_names).as_bytes())
                .map_err(|e| format!("Failed to write Markdown: {e}"))?;
            let mut wrote_rows = false;

            loop {
                if is_export_cancelled(&request.export_id).await {
                    on_progress(TableExportProgress {
                        export_id: request.export_id.clone(),
                        table_name: request.table_name.clone(),
                        rows_exported,
                        total_rows,
                        status: ExportStatus::Cancelled,
                        error_message: Some("Export cancelled".to_string()),
                    });
                    close_table_export_cursor_if_open(state, &pool_key, request, &mut cursor_session).await;
                    return Ok(());
                }

                let Some(active_batch_size) = next_export_batch_size(row_limit, rows_exported, batch_size) else {
                    break;
                };
                let result = fetch_table_export_batch(
                    state,
                    &pool_key,
                    request,
                    &db_type,
                    &col_names,
                    &primary_keys,
                    use_keyset,
                    &last_pk_values,
                    offset,
                    active_batch_size,
                    &mut cursor_session,
                    &mut table_read_attempted,
                    &mut table_read_completed,
                    cancel_token.clone(),
                )
                .await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                let formatted_rows = crate::temporal_format::format_temporal_export_rows(
                    &result.rows,
                    &column_types,
                    request.date_time_format.as_deref(),
                );
                let rows_markdown = format_markdown_rows(&formatted_rows);
                if !rows_markdown.is_empty() {
                    if wrote_rows {
                        file.write_all(b"\n").map_err(|e| format!("Failed to write Markdown: {e}"))?;
                    }
                    file.write_all(rows_markdown.as_bytes()).map_err(|e| format!("Failed to write Markdown: {e}"))?;
                    wrote_rows = true;
                }

                rows_exported += row_count as u64;
                if use_keyset {
                    if let Some(last_row) = result.rows.last() {
                        last_pk_values = pk_indices.iter().map(|&i| last_row[i].clone()).collect();
                    }
                } else {
                    offset += row_count as u64;
                }

                on_progress(TableExportProgress {
                    export_id: request.export_id.clone(),
                    table_name: request.table_name.clone(),
                    rows_exported,
                    total_rows,
                    status: ExportStatus::Running,
                    error_message: None,
                });

                if row_count < active_batch_size {
                    break;
                }
            }

            file.write_all(b"\n").map_err(|e| format!("Failed to write Markdown: {e}"))?;
        }
        "sql" => {
            let mut wrote_statements = false;

            loop {
                if is_export_cancelled(&request.export_id).await {
                    on_progress(TableExportProgress {
                        export_id: request.export_id.clone(),
                        table_name: request.table_name.clone(),
                        rows_exported,
                        total_rows,
                        status: ExportStatus::Cancelled,
                        error_message: Some("Export cancelled".to_string()),
                    });
                    close_table_export_cursor_if_open(state, &pool_key, request, &mut cursor_session).await;
                    return Ok(());
                }

                let Some(active_batch_size) = next_export_batch_size(row_limit, rows_exported, batch_size) else {
                    break;
                };
                let result = fetch_table_export_batch(
                    state,
                    &pool_key,
                    request,
                    &db_type,
                    &col_names,
                    &primary_keys,
                    use_keyset,
                    &last_pk_values,
                    offset,
                    active_batch_size,
                    &mut cursor_session,
                    &mut table_read_attempted,
                    &mut table_read_completed,
                    cancel_token.clone(),
                )
                .await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
                    database_type: Some(db_type),
                    schema: request.schema.clone(),
                    table_name: Some(request.table_name.clone()),
                    qualified_table_name: None,
                    columns: col_names.clone(),
                    column_types: column_types.clone(),
                    column_extras: column_extras.clone(),
                    rows: result.rows.clone(),
                    batch_size: Some(100),
                })?;
                if !statements.is_empty() {
                    if wrote_statements {
                        file.write_all(b"\n").map_err(|e| format!("Failed to write SQL: {e}"))?;
                    }
                    file.write_all(statements.join("\n").as_bytes())
                        .map_err(|e| format!("Failed to write SQL: {e}"))?;
                    wrote_statements = true;
                }

                rows_exported += row_count as u64;
                if use_keyset {
                    if let Some(last_row) = result.rows.last() {
                        last_pk_values = pk_indices.iter().map(|&i| last_row[i].clone()).collect();
                    }
                } else {
                    offset += row_count as u64;
                }

                on_progress(TableExportProgress {
                    export_id: request.export_id.clone(),
                    table_name: request.table_name.clone(),
                    rows_exported,
                    total_rows,
                    status: ExportStatus::Running,
                    error_message: None,
                });

                if row_count < active_batch_size {
                    break;
                }
            }

            if wrote_statements {
                file.write_all(b"\n").map_err(|e| format!("Failed to write SQL: {e}"))?;
            }
        }
        other => {
            return Err(format!("Unsupported export format: {other}"));
        }
    }

    close_table_export_cursor_if_open(state, &pool_key, request, &mut cursor_session).await;
    file.flush().map_err(|e| format!("Failed to flush export file: {e}"))?;

    // 8. Emit Done progress
    on_progress(TableExportProgress {
        export_id: request.export_id.clone(),
        table_name: request.table_name.clone(),
        rows_exported,
        total_rows,
        status: ExportStatus::Done,
        error_message: None,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database_export::{clear_export_cancelled, set_export_cancelled};
    #[cfg(unix)]
    use crate::models::connection::ConnectionConfig;
    #[cfg(unix)]
    use crate::plugins::{
        InstalledPlugin, PluginDriverManifest, PluginDriverSession, PluginManifest, PluginRuntimeEnv,
    };
    #[cfg(unix)]
    use crate::storage::Storage;
    use crate::xlsx_export::{build_xlsx_workbook, XlsxWorksheetData};
    use serde_json::json;
    use std::io::Read;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(unix)]
    struct ExternalDriverExportFixture {
        state: AppState,
        request: TableExportRequest,
        calls: std::path::PathBuf,
        output: std::path::PathBuf,
        dir: std::path::PathBuf,
    }

    #[cfg(unix)]
    async fn external_driver_export_fixture(
        rpc_body: &str,
        batch_size: usize,
        row_limit: Option<usize>,
        skip_count: bool,
    ) -> ExternalDriverExportFixture {
        let dir = std::env::temp_dir().join(format!("dbx-jdbc-table-export-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let executable = dir.join("plugin.sh");
        let calls = dir.join("calls.log");
        let script = format!(
            "#!/bin/sh\nCALLS='{}'\nwhile IFS= read -r line; do\n  id=$(printf '%s' \"$line\" | sed -E 's/.*\"id\":([0-9]+).*/\\1/')\n{}\ndone\n",
            calls.display(),
            rpc_body
        );
        std::fs::write(&executable, script).unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let plugin = InstalledPlugin {
            manifest: PluginManifest {
                id: "jdbc".to_string(),
                name: "JDBC".to_string(),
                version: "test".to_string(),
                protocol_version: 1,
                description: String::new(),
                executable: Some("plugin.sh".to_string()),
                drivers: vec![PluginDriverManifest {
                    id: "jdbc".to_string(),
                    label: "JDBC".to_string(),
                    kind: "external".to_string(),
                    database_type: Some("jdbc".to_string()),
                }],
            },
            path: dir.clone(),
        };
        let session = Arc::new(
            PluginDriverSession::start_for_test(plugin, "jdbc".to_string(), PluginRuntimeEnv::default())
                .await
                .expect("test JDBC plugin should start"),
        );
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id": "conn-1",
            "name": "JDBC",
            "db_type": "jdbc",
            "host": "",
            "port": 0,
            "username": "",
            "password": "",
            "database": "PUBLIC",
            "query_timeout_secs": 30
        }))
        .unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        state.configs.write().await.insert(config.id.clone(), config.clone());
        let export_id = format!("export-{}", uuid::Uuid::new_v4());
        let pool_key =
            format!("{}:session:{}", config.id, table_export_client_session_id(&export_id).replace(':', "_"));
        state.connections.write().await.insert(
            pool_key,
            PoolKind::ExternalDriver { driver_id: "jdbc".to_string(), config: Arc::new(config), session },
        );

        let output = dir.join("export.csv");
        let request = TableExportRequest {
            export_id,
            connection_id: "conn-1".to_string(),
            database: "PUBLIC".to_string(),
            schema: Some("PUBLIC".to_string()),
            table_name: "EXPORT_SAMPLE".to_string(),
            file_path: output.to_string_lossy().into_owned(),
            format: "csv".to_string(),
            columns: Some(vec!["id".to_string(), "name".to_string()]),
            column_types: Some(vec![Some("INTEGER".to_string()), Some("VARCHAR".to_string())]),
            primary_keys: Some(vec!["id".to_string()]),
            where_input: None,
            order_by: None,
            skip_count,
            batch_size: Some(batch_size),
            row_limit,
            date_time_format: None,
            numeric_column_right_align: false,
        };

        ExternalDriverExportFixture { state, request, calls, output, dir }
    }

    #[cfg(unix)]
    async fn run_external_driver_export(
        fixture: &ExternalDriverExportFixture,
    ) -> Result<Vec<TableExportProgress>, String> {
        let progress = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = progress.clone();
        let result = export_table_data_core(&fixture.state, &fixture.request, move |event| {
            captured.lock().unwrap().push(event);
        })
        .await;
        let events = progress.lock().unwrap().clone();
        result.map(|_| events)
    }

    #[cfg(unix)]
    async fn wait_for_external_driver_call(calls: &std::path::Path, expected: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if std::fs::read_to_string(calls).unwrap_or_default().lines().any(|line| line == expected) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for plugin call: {expected}"));
    }

    #[cfg(unix)]
    fn cleanup_external_driver_export_fixture(fixture: ExternalDriverExportFixture) {
        let _ = std::fs::remove_dir_all(fixture.dir);
    }

    /// Read and decompress a single entry from an in-memory XLSX (ZIP) buffer.
    fn read_zip_entry(bytes: &[u8], path: &str) -> String {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).expect("open xlsx as zip archive");
        let mut entry = archive.by_name(path).unwrap_or_else(|_| panic!("missing zip entry: {path}"));
        let mut content = String::new();
        entry.read_to_string(&mut content).expect("read zip entry");
        content
    }

    // -----------------------------------------------------------------------
    // Helper: check that two CSV strings are equivalent by splitting lines
    // -----------------------------------------------------------------------
    fn csv_lines_equal(actual: &str, expected: &str) -> bool {
        let actual_lines: Vec<&str> = actual.lines().collect();
        let expected_lines: Vec<&str> = expected.lines().collect();
        actual_lines == expected_lines
    }

    // -----------------------------------------------------------------------
    // format_csv_rows
    // -----------------------------------------------------------------------

    #[test]
    fn formats_csv_rows_with_multiple_columns() {
        let rows = vec![vec![json!(1), json!("Alice")], vec![json!(2), json!("Bob \"Builder\"")]];
        let out = format_csv_rows(&rows);
        assert!(csv_lines_equal(&out, "\"1\",\"Alice\"\n\"2\",\"Bob \"\"Builder\"\"\""));
    }

    #[test]
    fn formats_csv_rows_with_null_values() {
        let rows = vec![vec![json!(1), Value::Null, json!("active")], vec![json!(2), json!("some notes"), Value::Null]];
        let out = format_csv_rows(&rows);
        assert!(csv_lines_equal(&out, "\"1\",\"\",\"active\"\n\"2\",\"some notes\",\"\""));
    }

    #[test]
    fn formats_csv_rows_with_boolean_and_number_values() {
        let rows = vec![vec![json!(true), json!(2.75)], vec![json!(false), json!(-42)]];
        let out = format_csv_rows(&rows);
        assert!(csv_lines_equal(&out, "\"true\",\"2.75\"\n\"false\",\"-42\""));
    }

    #[test]
    fn formats_csv_rows_returns_empty_string_for_empty_rows() {
        let rows: Vec<Vec<Value>> = vec![];
        let out = format_csv_rows(&rows);
        assert_eq!(out, "");
    }

    #[test]
    fn formats_csv_rows_single_row() {
        let rows = vec![vec![json!("just"), json!("one")]];
        let out = format_csv_rows(&rows);
        assert_eq!(out, "\"just\",\"one\"");
    }

    // -----------------------------------------------------------------------
    // format_tsv (Navicat-style TXT export)
    // -----------------------------------------------------------------------

    #[test]
    fn formats_tsv_with_header_and_tab_separated_values() {
        let columns = vec!["id".to_string(), "name".to_string()];
        let rows = vec![vec![json!(1), json!("Alice")], vec![json!(2), json!("Bob")]];
        assert_eq!(format_tsv(&columns, &rows), "id\tname\n1\tAlice\n2\tBob");
    }

    #[test]
    fn formats_tsv_renders_null_as_empty() {
        let columns = vec!["id".to_string(), "note".to_string()];
        let rows = vec![vec![json!(1), Value::Null]];
        assert_eq!(format_tsv(&columns, &rows), "id\tnote\n1\t");
    }

    #[test]
    fn formats_tsv_quotes_fields_containing_tab_or_newline() {
        let columns = vec!["a".to_string(), "b".to_string()];
        let rows = vec![vec![json!("x\ty"), json!("line1\nline2")]];
        assert_eq!(format_tsv(&columns, &rows), "a\tb\n\"x\ty\"\t\"line1\nline2\"");
    }

    #[test]
    fn formats_tsv_escapes_embedded_quotes() {
        let columns = vec!["name".to_string()];
        let rows = vec![vec![json!(r#"Bob "Builder""#)]];
        assert_eq!(format_tsv(&columns, &rows), "name\n\"Bob \"\"Builder\"\"\"");
    }

    #[test]
    fn formats_tsv_rows_returns_empty_for_empty_rows() {
        let rows: Vec<Vec<Value>> = vec![];
        assert_eq!(format_tsv_rows(&rows), "");
    }

    #[test]
    fn export_batch_size_respects_row_limit_remaining_rows() {
        assert_eq!(next_export_batch_size(None, 12_000, 10_000), Some(10_000));
        assert_eq!(next_export_batch_size(Some(15_000), 0, 10_000), Some(10_000));
        assert_eq!(next_export_batch_size(Some(15_000), 10_000, 10_000), Some(5_000));
        assert_eq!(next_export_batch_size(Some(15_000), 15_000, 10_000), None);
    }

    #[test]
    fn oracle_table_cursor_sql_builds_single_ordered_select() {
        let request = TableExportRequest {
            export_id: "export-1".to_string(),
            connection_id: "conn-1".to_string(),
            database: "ORCL".to_string(),
            schema: Some("APP".to_string()),
            table_name: "events".to_string(),
            file_path: "events.csv".to_string(),
            format: "csv".to_string(),
            columns: None,
            column_types: None,
            primary_keys: None,
            where_input: Some("WHERE status = 'active'".to_string()),
            order_by: None,
            skip_count: false,
            batch_size: Some(500),
            row_limit: Some(1000),
            date_time_format: None,
            numeric_column_right_align: false,
        };

        let sql = table_cursor_sql(
            &request,
            &DatabaseType::Oracle,
            &[String::from("id"), String::from("status")],
            &[String::from("id")],
        );

        assert_eq!(
            sql,
            "SELECT \"id\", \"status\" FROM \"APP\".\"events\" WHERE (status = 'active') ORDER BY \"id\" ASC"
        );
        assert!(!sql.contains("OFFSET"));
        assert!(!sql.contains("FETCH NEXT"));
        assert!(!sql.contains("ROWNUM"));
    }

    #[test]
    fn oracle_requested_export_columns_omit_synthetic_rowid_and_keep_metadata_aligned() {
        let columns = vec!["__DBX_ROWID".to_string(), "ID".to_string(), "NAME".to_string()];
        let column_types = vec![Some("VARCHAR2".to_string()), Some("NUMBER".to_string()), Some("VARCHAR2".to_string())];
        let primary_keys = vec!["__DBX_ROWID".to_string()];

        let (columns, column_types, primary_keys) =
            resolve_requested_export_columns(DatabaseType::Oracle, &columns, Some(&column_types), Some(&primary_keys));

        assert_eq!(columns, vec!["ID", "NAME"]);
        assert_eq!(column_types, vec![Some("NUMBER".to_string()), Some("VARCHAR2".to_string())]);
        assert!(primary_keys.is_empty());

        let request = TableExportRequest {
            export_id: "export-rowid".to_string(),
            connection_id: "conn-1".to_string(),
            database: "ORCL".to_string(),
            schema: Some("APP".to_string()),
            table_name: "USERS".to_string(),
            file_path: "users.sql".to_string(),
            format: "sql".to_string(),
            columns: None,
            column_types: None,
            primary_keys: None,
            where_input: None,
            order_by: None,
            skip_count: false,
            batch_size: Some(100),
            row_limit: None,
            date_time_format: None,
            numeric_column_right_align: false,
        };
        let sql = table_cursor_sql(&request, &DatabaseType::Oracle, &columns, &primary_keys);
        assert_eq!(sql, "SELECT \"ID\", \"NAME\" FROM \"APP\".\"USERS\"");

        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Oracle),
            schema: request.schema,
            table_name: Some(request.table_name),
            qualified_table_name: None,
            columns,
            column_types,
            column_extras: Vec::new(),
            rows: vec![vec![json!(1), json!("Ada")]],
            batch_size: Some(100),
        })
        .unwrap();
        assert_eq!(statements, vec!["INSERT INTO \"APP\".\"USERS\" (\"ID\", \"NAME\") VALUES (1, 'Ada');"]);
    }

    #[test]
    fn requested_export_columns_preserve_regular_oracle_and_non_oracle_columns() {
        let oracle_columns = vec!["ROW_ID".to_string(), "NAME".to_string()];
        let (resolved_oracle, _, _) =
            resolve_requested_export_columns(DatabaseType::Oracle, &oracle_columns, None, None);
        assert_eq!(resolved_oracle, oracle_columns);

        let mysql_columns = vec!["__DBX_ROWID".to_string(), "name".to_string()];
        let (resolved_mysql, _, _) = resolve_requested_export_columns(DatabaseType::Mysql, &mysql_columns, None, None);
        assert_eq!(resolved_mysql, mysql_columns);
    }

    #[test]
    fn agent_table_read_unsupported_detects_old_agent_errors() {
        assert!(is_agent_table_read_unsupported("Agent RPC error (-1): unknown method: start_table_read"));
        assert!(is_agent_table_read_unsupported("Agent RPC error (-32601): Method not found"));
        assert!(!is_agent_table_read_unsupported("ORA-00933: SQL command not properly ended"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn external_driver_table_export_reads_all_cursor_pages() {
        let fixture = external_driver_export_fixture(
            r#"  case "$line" in
    *'"method":"executeQueryPage"'*)
      echo executeQueryPage >> "$CALLS"
      printf '{"id":%s,"result":{"columns":["id","name"],"rows":[[1,"Ada"],[2,"Grace"]],"affected_rows":0,"execution_time_ms":1,"session_id":"cursor-1","has_more":true}}\n' "$id"
      ;;
    *'"method":"fetchQueryPage"'*)
      echo fetchQueryPage >> "$CALLS"
      printf '{"id":%s,"result":{"columns":["id","name"],"rows":[[3,"Linus"]],"affected_rows":0,"execution_time_ms":1,"session_id":null,"has_more":false}}\n' "$id"
      ;;
    *'"method":"executeQuery"'*)
      echo executeQuery >> "$CALLS"
      printf '{"id":%s,"result":{"columns":["count"],"rows":[[3]],"affected_rows":0,"execution_time_ms":1}}\n' "$id"
      ;;
    *'"method":"closeQuerySession"'*)
      echo closeQuerySession >> "$CALLS"
      printf '{"id":%s,"result":{"ok":true}}\n' "$id"
      ;;
  esac"#,
            2,
            None,
            false,
        )
        .await;

        let progress = run_external_driver_export(&fixture).await.expect("multi-page JDBC export should succeed");
        let csv = std::fs::read_to_string(&fixture.output).unwrap();
        assert!(csv.contains("\"1\",\"Ada\""));
        assert!(csv.contains("\"2\",\"Grace\""));
        assert!(csv.contains("\"3\",\"Linus\""));
        assert_eq!(csv.matches("\"Ada\"").count(), 1);
        assert_eq!(
            std::fs::read_to_string(&fixture.calls).unwrap(),
            "executeQuery\nexecuteQueryPage\nfetchQueryPage\n"
        );
        assert_eq!(progress.last().and_then(|event| event.total_rows), Some(3));
        assert!(matches!(progress.last().map(|event| &event.status), Some(ExportStatus::Done)));
        assert!(fixture.state.connections.read().await.is_empty());

        cleanup_external_driver_export_fixture(fixture);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn external_driver_table_export_does_not_repeat_legacy_one_shot_results() {
        let fixture = external_driver_export_fixture(
            r#"  case "$line" in
    *'"method":"executeQueryPage"'*)
      echo executeQueryPage >> "$CALLS"
      printf '{"id":%s,"error":{"message":"Unsupported JDBC plugin method: executeQueryPage"}}\n' "$id"
      ;;
    *'"method":"executeQuery"'*)
      echo executeQuery >> "$CALLS"
      printf '{"id":%s,"result":{"columns":["id","name"],"rows":[[1,"Ada"],[2,"Grace"],[3,"Linus"]],"affected_rows":0,"execution_time_ms":1}}\n' "$id"
      ;;
  esac"#,
            2,
            None,
            true,
        )
        .await;

        run_external_driver_export(&fixture).await.expect("legacy JDBC export should succeed");
        let csv = std::fs::read_to_string(&fixture.output).unwrap();
        assert_eq!(csv.matches("\"Ada\"").count(), 1);
        assert_eq!(csv.matches("\"Grace\"").count(), 1);
        assert_eq!(csv.matches("\"Linus\"").count(), 1);
        assert_eq!(std::fs::read_to_string(&fixture.calls).unwrap(), "executeQueryPage\nexecuteQuery\n");

        cleanup_external_driver_export_fixture(fixture);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn external_driver_table_export_closes_cursor_at_row_limit() {
        let fixture = external_driver_export_fixture(
            r#"  case "$line" in
    *'"method":"executeQueryPage"'*)
      echo executeQueryPage >> "$CALLS"
      printf '{"id":%s,"result":{"columns":["id","name"],"rows":[[1,"Ada"]],"affected_rows":0,"execution_time_ms":1,"session_id":"cursor-1","has_more":true}}\n' "$id"
      ;;
    *'"method":"closeQuerySession"'*)
      echo closeQuerySession >> "$CALLS"
      printf '{"id":%s,"result":{"ok":true}}\n' "$id"
      ;;
  esac"#,
            1,
            Some(1),
            true,
        )
        .await;

        run_external_driver_export(&fixture).await.expect("row-limited JDBC export should succeed");
        assert_eq!(std::fs::read_to_string(&fixture.calls).unwrap(), "executeQueryPage\ncloseQuerySession\n");
        assert!(fixture.state.connections.read().await.is_empty());

        cleanup_external_driver_export_fixture(fixture);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn external_driver_table_export_closes_cursor_after_fetch_error() {
        let fixture = external_driver_export_fixture(
            r#"  case "$line" in
    *'"method":"executeQueryPage"'*)
      echo executeQueryPage >> "$CALLS"
      printf '{"id":%s,"result":{"columns":["id","name"],"rows":[[1,"Ada"],[2,"Grace"]],"affected_rows":0,"execution_time_ms":1,"session_id":"cursor-1","has_more":true}}\n' "$id"
      ;;
    *'"method":"fetchQueryPage"'*)
      echo fetchQueryPage >> "$CALLS"
      printf '{"id":%s,"error":{"message":"simulated fetch failure"}}\n' "$id"
      ;;
    *'"method":"closeQuerySession"'*)
      echo closeQuerySession >> "$CALLS"
      printf '{"id":%s,"result":{"ok":true}}\n' "$id"
      ;;
  esac"#,
            2,
            None,
            true,
        )
        .await;

        let error = run_external_driver_export(&fixture).await.expect_err("fetch errors must fail the export");
        assert!(error.starts_with("simulated fetch failure"));
        assert_eq!(
            std::fs::read_to_string(&fixture.calls).unwrap(),
            "executeQueryPage\nfetchQueryPage\ncloseQuerySession\n"
        );
        assert!(fixture.state.connections.read().await.is_empty());

        cleanup_external_driver_export_fixture(fixture);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn external_driver_table_export_cancels_blocked_execute() {
        let fixture = external_driver_export_fixture(
            r#"  case "$line" in
    *'"method":"executeQueryPage"'*)
      echo executeQueryPage >> "$CALLS"
      sleep 30
      ;;
  esac"#,
            2,
            None,
            true,
        )
        .await;

        let export = run_external_driver_export(&fixture);
        let cancel = async {
            wait_for_external_driver_call(&fixture.calls, "executeQueryPage").await;
            set_export_cancelled(&fixture.request.export_id).await;
            tokio::time::Instant::now()
        };
        let (result, cancel_requested_at) =
            tokio::time::timeout(Duration::from_secs(7), async { tokio::join!(export, cancel) })
                .await
                .expect("blocked JDBC execute should be interrupted promptly");
        let progress = result.expect("cancelled JDBC export should complete without an error");

        assert!(cancel_requested_at.elapsed() < Duration::from_secs(2));
        assert!(matches!(progress.last().map(|event| &event.status), Some(ExportStatus::Cancelled)));
        assert!(fixture.state.connections.read().await.is_empty());
        clear_export_cancelled(&fixture.request.export_id).await;
        cleanup_external_driver_export_fixture(fixture);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn external_driver_table_export_cancels_blocked_fetch() {
        let fixture = external_driver_export_fixture(
            r#"  case "$line" in
    *'"method":"executeQueryPage"'*)
      echo executeQueryPage >> "$CALLS"
      printf '{"id":%s,"result":{"columns":["id","name"],"rows":[[1,"Ada"],[2,"Grace"]],"affected_rows":0,"execution_time_ms":1,"session_id":"cursor-1","has_more":true}}\n' "$id"
      ;;
    *'"method":"fetchQueryPage"'*)
      echo fetchQueryPage >> "$CALLS"
      sleep 30
      ;;
  esac"#,
            2,
            None,
            true,
        )
        .await;

        let export = run_external_driver_export(&fixture);
        let cancel = async {
            wait_for_external_driver_call(&fixture.calls, "fetchQueryPage").await;
            set_export_cancelled(&fixture.request.export_id).await;
            tokio::time::Instant::now()
        };
        let (result, cancel_requested_at) =
            tokio::time::timeout(Duration::from_secs(7), async { tokio::join!(export, cancel) })
                .await
                .expect("blocked JDBC fetch should be interrupted promptly");
        let progress = result.expect("cancelled JDBC export should complete without an error");

        assert!(cancel_requested_at.elapsed() < Duration::from_secs(2));
        assert!(matches!(progress.last().map(|event| &event.status), Some(ExportStatus::Cancelled)));
        assert!(fixture.state.connections.read().await.is_empty());
        clear_export_cancelled(&fixture.request.export_id).await;
        cleanup_external_driver_export_fixture(fixture);
    }

    #[test]
    fn writes_json_row_without_allocating_object_map() {
        let mut out = Vec::new();
        write_json_row_object(
            &mut out,
            &["id".to_string(), "name".to_string(), "missing".to_string()],
            &[json!(1), json!("Ada")],
        )
        .unwrap();

        assert_eq!(String::from_utf8(out).unwrap(), "{\n  \"id\": 1,\n  \"name\": \"Ada\"\n}");
    }

    #[test]
    fn formats_csv_rows_escapes_embedded_commas_and_newlines() {
        let rows = vec![vec![json!("hello,world"), json!("line1\nline2")]];
        let out = format_csv_rows(&rows);
        assert!(out.contains("\"hello,world\""));
        assert!(out.contains("\"line1\nline2\""));
        let records: Vec<Vec<String>> = csv::ReaderBuilder::new()
            .has_headers(false)
            .from_reader(out.as_bytes())
            .records()
            .map(|record| record.unwrap().iter().map(str::to_string).collect())
            .collect();
        assert_eq!(records, vec![vec!["hello,world".to_string(), "line1\nline2".to_string()]]);
    }

    // -----------------------------------------------------------------------
    // Cancellation flow
    // -----------------------------------------------------------------------

    #[test]
    fn cancellation_set_and_cleared_correctly() {
        let export_id = "test-cancel-1";

        assert!(!poll_is_cancelled(export_id));
        block_on(set_export_cancelled(export_id));
        assert!(poll_is_cancelled(export_id));
        block_on(clear_export_cancelled(export_id));
        assert!(!poll_is_cancelled(export_id));
    }

    #[test]
    fn cancellation_is_id_scoped() {
        let id_a = "cancel-scope-a";
        let id_b = "cancel-scope-b";

        block_on(set_export_cancelled(id_a));
        assert!(poll_is_cancelled(id_a));
        assert!(!poll_is_cancelled(id_b));
        block_on(clear_export_cancelled(id_a));
    }

    // -----------------------------------------------------------------------
    // XLSX workbook integration
    // -----------------------------------------------------------------------

    #[test]
    fn builds_xlsx_workbook_with_table_export_data() {
        let data = XlsxWorksheetData {
            sheet_name: Some("employees".to_string()),
            columns: vec!["id".to_string(), "name".to_string(), "salary".to_string()],
            column_types: vec![],
            rows: vec![
                vec![json!(1), json!("Alice"), json!(75000.50)],
                vec![json!(2), json!("Bob"), json!(82000)],
                vec![json!(3), Value::Null, json!(0)],
            ],
            numeric_column_right_align: false,
        };
        let workbook = build_xlsx_workbook(&data).expect("XLSX build should succeed");

        assert_eq!(workbook[0], 0x50, "Should be a ZIP (PK) archive");
        assert_eq!(workbook[1], 0x4b);

        // Entries are Deflate-compressed; assert on their decompressed contents.
        let workbook_xml = read_zip_entry(&workbook, "xl/workbook.xml");
        let sheet = read_zip_entry(&workbook, "xl/worksheets/sheet1.xml");
        assert!(workbook_xml.contains("name=\"employees\""));
        assert!(sheet.contains("<v>75000.5</v>"));
        assert!(sheet.contains("Alice"));
    }

    // -----------------------------------------------------------------------
    // CSV header + rows (format_csv) — basic integration check
    // -----------------------------------------------------------------------

    #[test]
    fn format_csv_produces_header_and_rows() {
        let out = format_csv(
            &["col1".to_string(), "col2".to_string()],
            &[vec![json!("a"), json!("b")], vec![json!("c"), json!("d")]],
        );
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 3, "header + 2 data rows = 3 lines");
        assert_eq!(lines[0], "\"col1\",\"col2\"");
        assert_eq!(lines[1], "\"a\",\"b\"");
        assert_eq!(lines[2], "\"c\",\"d\"");
    }

    // -----------------------------------------------------------------------
    // Helpers for async cancellation in tests
    // -----------------------------------------------------------------------

    fn poll_is_cancelled(export_id: &str) -> bool {
        block_on(is_export_cancelled(export_id))
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Runtime::new().expect("create tokio runtime").block_on(future)
    }
}
