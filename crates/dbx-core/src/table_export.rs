use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

use crate::connection::MysqlMode;
use crate::connection::{task_client_session_id, AppState, PoolKind};
use crate::csv_export::{escape_csv, format_csv, format_tsv, format_tsv_rows, value_to_csv_text};
pub use crate::database_export::ExportStatus;
use crate::database_export::{build_export_insert_statements, is_export_cancelled, BuildExportInsertStatementsOptions};
use crate::db::agent_driver::AgentTableReadStartParams;
use crate::models::connection::DatabaseType;
use crate::transfer::{
    count_sql_with_where, execute_read_on_pool, execute_read_on_pool_with_max_rows, keyset_pagination_sql,
    pagination_sql_with_filter_order, qualified_table, quote_identifier,
};
use crate::types::QueryResult;
use crate::xlsx_export::{finish_streaming_xlsx_workbook, start_streaming_xlsx_workbook};

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
    rows.iter()
        .map(|row| row.iter().map(|cell| escape_csv(&value_to_csv_text(cell))).collect::<Vec<_>>().join(","))
        .collect::<Vec<_>>()
        .join("\n")
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

async fn pool_is_agent(state: &AppState, pool_key: &str) -> bool {
    let connections = state.connections.read().await;
    matches!(connections.get(pool_key), Some(PoolKind::Agent(_)))
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
    table_read_session_id: &mut Option<String>,
    table_read_attempted: &mut bool,
    table_read_completed: &mut bool,
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
        });
    }

    if !*table_read_attempted && pool_is_agent(state, pool_key).await {
        *table_read_attempted = true;
        let sql = table_cursor_sql(request, db_type, col_names, primary_keys);
        let max_rows = request.row_limit.unwrap_or(i32::MAX as usize);
        let params = AgentTableReadStartParams {
            sql,
            database: Some(request.database.clone()),
            schema: request.schema.clone(),
            page_size: active_batch_size,
            max_rows,
            fetch_size: Some(active_batch_size),
        };
        let connections = state.connections.read().await;
        let Some(PoolKind::Agent(client)) = connections.get(pool_key) else {
            drop(connections);
            return fetch_paginated_table_export_batch(
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
            .await;
        };
        let client = client.clone();
        drop(connections);
        let mut client = client.lock().await;
        match client.start_table_read::<QueryResult>(params).await {
            Ok(result) => {
                *table_read_session_id = result.session_id.clone();
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

    if let Some(session_id) = table_read_session_id.as_deref() {
        let connections = state.connections.read().await;
        let Some(PoolKind::Agent(client)) = connections.get(pool_key) else {
            return Err("Table read session requires an agent connection".to_string());
        };
        let client = client.clone();
        drop(connections);
        let mut client = client.lock().await;
        return match client.fetch_table_read_page::<QueryResult>(session_id, active_batch_size).await {
            Ok(result) => {
                *table_read_session_id = result.session_id.clone().or_else(|| Some(session_id.to_string()));
                if !result.has_more {
                    *table_read_session_id = None;
                    *table_read_completed = true;
                }
                Ok(result)
            }
            Err(error) => {
                let _ = client.close_table_read_session::<bool>(session_id).await;
                *table_read_session_id = None;
                Err(error)
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

async fn close_table_read_session_if_open(
    state: &AppState,
    pool_key: &str,
    table_read_session_id: &mut Option<String>,
) {
    let Some(session_id) = table_read_session_id.take() else {
        return;
    };
    let connections = state.connections.read().await;
    let Some(PoolKind::Agent(client)) = connections.get(pool_key) else {
        return;
    };
    let client = client.clone();
    drop(connections);
    let mut client = client.lock().await;
    let _ = client.close_table_read_session::<bool>(&session_id).await;
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
) -> Result<bool, String> {
    let sql = table_cursor_sql(request, db_type, col_names, primary_keys);
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_token = CancellationToken::new();
    let cancel_watcher =
        tokio::spawn(start_export_cancel_watcher(request.export_id.clone(), cancelled.clone(), cancel_token.clone()));
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
                    let row_csv = format_csv_rows(&[row.to_vec()]);
                    write!(file, "\n{row_csv}").map_err(|e| format!("Failed to write CSV rows: {e}"))?;
                    rows_exported += 1;
                    if rows_exported % progress_interval == 0 {
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
                    let row_tsv = format_tsv_rows(&[row.to_vec()]);
                    write!(file, "\n{row_tsv}").map_err(|e| format!("Failed to write TXT rows: {e}"))?;
                    rows_exported += 1;
                    if rows_exported % progress_interval == 0 {
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
            let column_types = export_column_types(request);
            let xlsx_file =
                std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
            let mut writer = start_streaming_xlsx_workbook(
                BufWriter::new(xlsx_file),
                Some(&request.table_name),
                col_names,
                &column_types,
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
                    writer.write_row(row).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                    rows_exported += 1;
                    if rows_exported % progress_interval == 0 {
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
                    write_json_row_object(&mut file, col_names, row)?;
                    is_first_row = false;
                    rows_exported += 1;
                    if rows_exported % progress_interval == 0 {
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
                    let rows_markdown = format_markdown_rows(&[row.to_vec()]);
                    if !rows_markdown.is_empty() {
                        if wrote_rows {
                            file.write_all(b"\n").map_err(|e| format!("Failed to write Markdown: {e}"))?;
                        }
                        file.write_all(rows_markdown.as_bytes())
                            .map_err(|e| format!("Failed to write Markdown: {e}"))?;
                        wrote_rows = true;
                    }
                    rows_exported += 1;
                    if rows_exported % progress_interval == 0 {
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
                    if rows_exported % progress_interval == 0 {
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

    cancel_watcher.abort();

    match stream_result {
        Ok(false) => Ok(false),
        Ok(true) => {
            if rows_exported % progress_interval != 0 {
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
        let primary_keys = request.primary_keys.clone().unwrap_or_default();
        let column_types = request.column_types.clone().unwrap_or_default();
        (requested_columns.clone(), column_types, Vec::new(), primary_keys)
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
        match execute_read_on_pool(state, &pool_key, &count_query).await {
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
    let mut table_read_session_id: Option<String> = None;
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
                    close_table_read_session_if_open(state, &pool_key, &mut table_read_session_id).await;
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
                    &mut table_read_session_id,
                    &mut table_read_attempted,
                    &mut table_read_completed,
                )
                .await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                if is_first_batch {
                    // First batch: write header + rows via format_csv
                    let csv_content = format_csv(&col_names, &result.rows);
                    file.write_all(csv_content.as_bytes()).map_err(|e| format!("Failed to write CSV: {e}"))?;
                    is_first_batch = false;
                } else {
                    // Subsequent batches: write rows only (prepend newline for separation)
                    let rows_csv = format_csv_rows(&result.rows);
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
                    close_table_read_session_if_open(state, &pool_key, &mut table_read_session_id).await;
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
                    &mut table_read_session_id,
                    &mut table_read_attempted,
                    &mut table_read_completed,
                )
                .await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                if is_first_batch {
                    let rows_tsv = format_tsv_rows(&result.rows);
                    write!(file, "\n{rows_tsv}").map_err(|e| format!("Failed to write TXT rows: {e}"))?;
                    is_first_batch = false;
                } else {
                    let rows_tsv = format_tsv_rows(&result.rows);
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
            let column_types = export_column_types(request);
            // Create a dedicated file handle for the streaming XLSX writer
            // instead of cloning the outer BufWriter's handle.  This avoids
            // sharing a file descriptor between two independent buffers.
            let xlsx_file =
                std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
            let mut writer = start_streaming_xlsx_workbook(
                BufWriter::new(xlsx_file),
                Some(&request.table_name),
                &col_names,
                &column_types,
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
                    close_table_read_session_if_open(state, &pool_key, &mut table_read_session_id).await;
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
                    &mut table_read_session_id,
                    &mut table_read_attempted,
                    &mut table_read_completed,
                )
                .await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                for row in &result.rows {
                    writer.write_row(row).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
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
                    close_table_read_session_if_open(state, &pool_key, &mut table_read_session_id).await;
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
                    &mut table_read_session_id,
                    &mut table_read_attempted,
                    &mut table_read_completed,
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
                    write_json_row_object(&mut file, &col_names, row)?;
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
                    close_table_read_session_if_open(state, &pool_key, &mut table_read_session_id).await;
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
                    &mut table_read_session_id,
                    &mut table_read_attempted,
                    &mut table_read_completed,
                )
                .await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                let rows_markdown = format_markdown_rows(&result.rows);
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
                    close_table_read_session_if_open(state, &pool_key, &mut table_read_session_id).await;
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
                    &mut table_read_session_id,
                    &mut table_read_attempted,
                    &mut table_read_completed,
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

    close_table_read_session_if_open(state, &pool_key, &mut table_read_session_id).await;
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
    use crate::xlsx_export::{build_xlsx_workbook, XlsxWorksheetData};
    use serde_json::json;
    use std::io::Read;

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
    fn agent_table_read_unsupported_detects_old_agent_errors() {
        assert!(is_agent_table_read_unsupported("Agent RPC error (-1): unknown method: start_table_read"));
        assert!(is_agent_table_read_unsupported("Agent RPC error (-32601): Method not found"));
        assert!(!is_agent_table_read_unsupported("ORA-00933: SQL command not properly ended"));
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
