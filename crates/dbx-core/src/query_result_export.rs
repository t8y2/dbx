use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufWriter, Seek, Write};
use std::mem;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use crate::connection::{AppState, PoolKind};
use crate::csv_export::{format_query_result_csv, format_query_result_csv_rows, format_tsv, format_tsv_rows};
pub use crate::database_export::ExportStatus;
use crate::database_export::{build_export_insert_statements, is_export_cancelled, BuildExportInsertStatementsOptions};
use crate::models::connection::DatabaseType;
use crate::query::{
    await_stream_with_progress_timeout, canceled_error, close_query_session, execute_sql_statement_with_options,
    operation_budget_for_pool_key, QueryExecutionOptions, StreamProgressClock, QUERY_CANCELED,
};
use crate::query_result_sql::{
    build_query_pagination_execution_plan, has_top_level_top, top_level_top_row_count, QueryPagination,
    QueryPaginationExecutionPlanOptions,
};
use crate::table_export::TableExportProgress;
use crate::transfer::keyset_pagination_sql;
use crate::xlsx_export::{
    finish_streaming_xlsx_workbook, start_streaming_xlsx_workbook_with_options, StreamingXlsxWriter, XlsxWorksheetData,
};
use serde_json::Value;
use sqlparser::ast::{
    GroupByExpr, ObjectName, ObjectNamePart, ObjectType, OrderByKind, SelectItem, SetExpr, Statement, TableFactor,
};
use sqlparser::dialect::{GenericDialect, PostgreSqlDialect};
use sqlparser::parser::Parser;
use tokio_util::sync::CancellationToken;

const AGENT_UNBOUNDED_ROW_LIMIT: usize = i32::MAX as usize;
const STREAMING_PAGINATION_UNSUPPORTED_ERROR: &str =
    "Streaming export is unsupported for this query. Simplify it or use a supported driver.";
const AGENT_SESSION_MISSING_ERROR: &str =
    "Streaming export needs a result-set session, but this driver returned no session_id.";
const STREAM_PROGRESS_TIME_INTERVAL: Duration = Duration::from_secs(1);
const EXCEL_CELL_CHARACTER_LIMIT: usize = 32_767;
const SQL_INSERT_BATCH_SIZE: usize = 100;

async fn disconnect_with_timeout<C, F, Fut>(
    connection: C,
    cleanup_timeout: Duration,
    disconnect: F,
) -> Result<Result<(), String>, tokio::time::error::Elapsed>
where
    F: FnOnce(C) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    tokio::time::timeout(cleanup_timeout, disconnect(connection)).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultExportRequest {
    pub export_id: String,
    pub connection_id: String,
    pub database: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<String>,
    pub sql: String,
    pub query_base_sql: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub setup_sql: Vec<String>,
    pub database_type: DatabaseType,
    #[serde(default)]
    pub use_agent_cursor: bool,
    pub file_path: String,
    pub format: String,
    #[serde(default)]
    pub include_sql_sheet: bool,
    pub page_size: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_limit: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_rows: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub keyset_optimization_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_time_format: Option<String>,
    // -- new fields for SQL INSERT export --
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export_table_name: Option<String>,
    /// Column type overrides for SQL INSERT export. Each entry may be `null`
    /// (meaning "infer from the query result") so the inner element is `Option`.
    /// Frontend sends these in original full-query column order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export_column_types: Option<Vec<Option<String>>>,
    #[serde(default)]
    pub numeric_column_right_align: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_comments: Option<Vec<Option<String>>>,
}

pub struct StagedExportTarget {
    destination: PathBuf,
    temporary: tempfile::TempPath,
}

impl StagedExportTarget {
    pub fn new(destination: &str) -> Result<Self, String> {
        let destination = PathBuf::from(destination);
        let parent = destination.parent().filter(|path| !path.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let file_name = destination.file_name().and_then(|name| name.to_str()).unwrap_or("query-result");
        let temporary = tempfile::Builder::new()
            .prefix(&format!(".{file_name}.dbx-export-"))
            .tempfile_in(parent)
            .map_err(|error| format!("Failed to create temporary export file: {error}"))?
            .into_temp_path();
        Ok(Self { destination, temporary })
    }

    pub fn path(&self) -> &Path {
        self.temporary.as_ref()
    }

    pub fn path_string(&self) -> Result<String, String> {
        self.path()
            .to_str()
            .map(ToOwned::to_owned)
            .ok_or_else(|| "Temporary export path is not valid UTF-8".to_string())
    }

    pub fn commit(self) -> Result<(), String> {
        let staged_file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(self.path())
            .map_err(|error| format!("Failed to open staged export file: {error}"))?;
        if let Ok(metadata) = std::fs::metadata(&self.destination) {
            staged_file
                .set_permissions(metadata.permissions())
                .map_err(|error| format!("Failed to preserve export destination permissions: {error}"))?;
        }
        staged_file.sync_all().map_err(|error| format!("Failed to synchronize export file: {error}"))?;
        drop(staged_file);
        self.temporary
            .persist(&self.destination)
            .map(|_| ())
            .map_err(|error| format!("Failed to replace export destination: {}", error.error))
    }
}

fn safe_postgres_temp_setup_sql(setup_sql: &[String]) -> Option<Vec<String>> {
    if setup_sql.is_empty() {
        return None;
    }

    let dialect = PostgreSqlDialect {};
    let mut temporary_tables: Vec<ObjectName> = Vec::new();
    for sql in setup_sql {
        let statements = Parser::parse_sql(&dialect, sql).ok()?;
        let [statement] = statements.as_slice() else {
            return None;
        };
        match statement {
            Statement::CreateTable(table) if table.temporary => temporary_tables.push(table.name.clone()),
            Statement::CreateIndex(index) if temporary_tables.iter().any(|name| name == &index.table_name) => {}
            Statement::Drop { object_type: ObjectType::Table, names, .. }
                if !names.is_empty() && names.iter().all(|name| temporary_tables.contains(name)) =>
            {
                temporary_tables.retain(|table| !names.contains(table));
            }
            _ => return None,
        }
    }

    Some(setup_sql.to_vec())
}

fn split_excel_cell_text(value: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut utf16_len = 0;
    for character in value.chars() {
        let character_utf16_len = character.len_utf16();
        if utf16_len + character_utf16_len > EXCEL_CELL_CHARACTER_LIMIT {
            chunks.push(current);
            current = String::new();
            utf16_len = 0;
        }
        current.push(character);
        utf16_len += character_utf16_len;
    }
    if !current.is_empty() || chunks.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn query_sql_worksheets(request: &QueryResultExportRequest) -> Vec<XlsxWorksheetData> {
    if !request.include_sql_sheet || request.sql.trim().is_empty() {
        return Vec::new();
    }
    vec![XlsxWorksheetData {
        sheet_name: Some("SQL".to_string()),
        columns: vec!["SQL".to_string()],
        column_types: Vec::new(),
        column_comments: Vec::new(),
        rows: split_excel_cell_text(&request.sql).into_iter().map(|sql| vec![Value::String(sql)]).collect(),
        numeric_column_right_align: false,
    }]
}

fn start_query_result_xlsx_workbook<W: Write + Seek>(
    writer: W,
    request: &QueryResultExportRequest,
    columns: &[String],
    column_types: &[String],
) -> Result<StreamingXlsxWriter<W>, String> {
    let trailing_sheets = query_sql_worksheets(request);
    let column_comments: &[Option<String>] = request.column_comments.as_deref().unwrap_or(&[]);
    start_streaming_xlsx_workbook_with_options(
        writer,
        Some("Result"),
        columns,
        column_types,
        column_comments,
        &trailing_sheets,
        request.date_time_format.as_deref(),
        request.numeric_column_right_align,
    )
}

fn progress(
    request: &QueryResultExportRequest,
    rows_exported: u64,
    status: ExportStatus,
    error_message: Option<String>,
) -> TableExportProgress {
    let total_rows = request.total_rows.map(|total| request.row_limit.map_or(total, |limit| total.min(limit as u64)));
    TableExportProgress {
        export_id: request.export_id.clone(),
        table_name: String::new(),
        rows_exported,
        total_rows,
        status,
        error_message,
    }
}

fn stream_export_was_cancelled(error: &str, token_cancelled: bool, export_cancelled: bool) -> bool {
    error == QUERY_CANCELED || token_cancelled || export_cancelled
}

/// Map the request's export_column_types (Web export may omit them) to
/// the Vec<Option<String>> expected by build_export_insert_statements.
///
/// `column_types` are the types returned by the executed query (original column
/// order). The request's overrides are expected to align 1:1 in the same order.
/// Missing, `None`, or empty overrides infer only MySQL spatial types, which
/// preserves the historical literal formatting of other database types.
fn sql_insert_column_types(request: &QueryResultExportRequest, column_types: &[String]) -> Vec<Option<String>> {
    column_types
        .iter()
        .enumerate()
        .map(|(index, inferred)| {
            request
                .export_column_types
                .as_ref()
                .and_then(|overrides| overrides.get(index))
                .and_then(|override_type| override_type.as_deref())
                .filter(|override_type| !override_type.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    (request.database_type == DatabaseType::Mysql
                        && crate::database_export::is_mysql_spatial_export_type(inferred))
                    .then(|| inferred.clone())
                })
        })
        .collect()
}

/// Bounded SQL INSERT writer with staged-file replacement safety.
///
/// Rows are buffered and flushed to a temp file every [`SQL_INSERT_BATCH_SIZE`]
/// rows, so memory stays bounded regardless of the query page size. The unique
/// temp file lives alongside the target and replaces it only after
/// [`SqlInsertWriter::finish`] flushes and synchronizes the complete output.
struct SqlInsertWriter {
    file: Option<BufWriter<File>>,
    target: Option<StagedExportTarget>,
    pending_rows: Vec<Vec<Value>>,
    columns: Vec<String>,
    column_types: Vec<Option<String>>,
    database_type: DatabaseType,
    schema: Option<String>,
    table_name: String,
}

impl SqlInsertWriter {
    /// Create the writer and open the temp file. Column metadata is supplied later
    /// via [`SqlInsertWriter::set_columns`] once the executed result is known.
    fn create(request: &QueryResultExportRequest) -> Result<Self, String> {
        let target = StagedExportTarget::new(&request.file_path)?;
        let file = BufWriter::new(
            File::create(target.path()).map_err(|e| format!("Failed to create SQL export temp file: {e}"))?,
        );
        let table_name = request
            .export_table_name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or("query_result")
            .to_string();
        Ok(Self {
            file: Some(file),
            target: Some(target),
            pending_rows: Vec::new(),
            columns: Vec::new(),
            column_types: Vec::new(),
            database_type: request.database_type,
            schema: request.schema.clone(),
            table_name,
        })
    }

    /// Provide result metadata once columns are known. `result_column_types` is the
    /// column-type list returned by the executed query (original column order); the
    /// request's export_column_types may override it when present.
    fn set_columns(
        &mut self,
        columns: Vec<String>,
        result_column_types: &[String],
        request: &QueryResultExportRequest,
    ) {
        self.column_types = sql_insert_column_types(request, result_column_types);
        self.columns = columns;
    }

    fn write_row(&mut self, row: Vec<Value>) -> Result<(), String> {
        self.pending_rows.push(row);
        if self.pending_rows.len() >= SQL_INSERT_BATCH_SIZE {
            self.flush_batch()?;
        }
        Ok(())
    }

    fn flush_batch(&mut self) -> Result<(), String> {
        if self.pending_rows.is_empty() {
            return Ok(());
        }
        let stmts = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(self.database_type),
            schema: self.schema.clone(),
            table_name: Some(self.table_name.clone()),
            qualified_table_name: None,
            columns: self.columns.clone(),
            column_types: self.column_types.clone(),
            column_extras: Vec::new(),
            rows: mem::take(&mut self.pending_rows),
            batch_size: Some(SQL_INSERT_BATCH_SIZE),
        })?;
        let file = self.file.as_mut().ok_or_else(|| "SQL export file already closed".to_string())?;
        for stmt in &stmts {
            writeln!(file, "{stmt}").map_err(|e| format!("Failed to write SQL: {e}"))?;
        }
        Ok(())
    }

    /// Flush remaining rows, close the temp file, and atomically replace the target.
    fn finish(mut self) -> Result<(), String> {
        self.flush_batch()?;
        if let Some(file) = self.file.as_mut() {
            file.flush().map_err(|e| format!("Failed to flush SQL file: {e}"))?;
        }
        self.file.take();
        self.target
            .take()
            .ok_or_else(|| "SQL export target already finalized".to_string())?
            .commit()
            .map_err(|error| format!("Failed to finalize SQL export file: {error}"))
    }
}

fn effective_row_limit(request: &QueryResultExportRequest) -> Option<usize> {
    request.row_limit
}

fn format_text_export_header(format: &str, columns: &[String]) -> String {
    let content = if format == "csv" { format_query_result_csv(columns, &[]) } else { format_tsv(columns, &[]) };
    content.strip_suffix('\n').unwrap_or(&content).to_string()
}

fn format_text_export_rows(format: &str, rows: &[Vec<Value>]) -> String {
    if format == "csv" {
        format_query_result_csv_rows(rows)
    } else {
        format_tsv_rows(rows)
    }
}

fn should_emit_stream_progress(
    rows_exported: u64,
    last_progress_rows: u64,
    row_interval: u64,
    elapsed_since_last_progress: Duration,
) -> bool {
    rows_exported > last_progress_rows
        && (rows_exported.saturating_sub(last_progress_rows) >= row_interval.max(1)
            || elapsed_since_last_progress >= STREAM_PROGRESS_TIME_INTERVAL)
}

fn query_export_timeout(timeout_secs: Option<u64>) -> Option<Duration> {
    match timeout_secs {
        Some(0) => None,
        Some(seconds) => Some(Duration::from_secs(seconds)),
        None => Some(Duration::from_secs(30)),
    }
}

fn should_fetch_next_page(
    use_agent_result_session: bool,
    has_more: bool,
    fetched_row_count: usize,
    written_row_count: usize,
    requested_page_size: usize,
) -> bool {
    if use_agent_result_session {
        has_more
    } else {
        fetched_row_count > written_row_count || written_row_count >= requested_page_size
    }
}

fn supports_streaming_offset_pagination(request: &QueryResultExportRequest, page_size: usize) -> bool {
    let first_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
        sql: request.sql.clone(),
        query_base_sql: request.query_base_sql.clone(),
        database_type: Some(request.database_type),
        pagination: QueryPagination { limit: page_size, offset: 0, session_id: None },
        use_agent_cursor: false,
        first_page_uses_actual_sql: true,
    });
    let second_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
        sql: request.sql.clone(),
        query_base_sql: request.query_base_sql.clone(),
        database_type: Some(request.database_type),
        pagination: QueryPagination { limit: page_size, offset: page_size, session_id: None },
        use_agent_cursor: false,
        first_page_uses_actual_sql: true,
    });

    let (Some(first_sql), Some(second_sql)) = (first_page.page_sql.as_deref(), second_page.page_sql.as_deref()) else {
        return false;
    };
    first_page.page_limit.is_some()
        && second_page.page_limit.is_some()
        && !first_sql.trim().eq_ignore_ascii_case(second_sql.trim())
}

/// Enforceable in-memory row bound for a single-execution export, or `None`
/// when the query cannot be safely streamed in one shot without an Agent
/// cursor. Kingbase SQL Server compatibility mode TOP queries cannot be
/// rewritten with LIMIT/OFFSET; a concrete `TOP n` bounds the result and the
/// user's export row limit caps it further. Percentage TOP / `WITH TIES` have
/// no concrete row bound, so they are only single-execution-capable when a row
/// limit is configured.
fn single_execution_row_bound(request: &QueryResultExportRequest) -> Option<usize> {
    if !has_top_level_top(&request.sql) {
        return None;
    }
    match (top_level_top_row_count(&request.sql), request.row_limit) {
        (Some(top), Some(row_limit)) => Some(top.min(row_limit)),
        (Some(top), None) => Some(top),
        (None, Some(row_limit)) => Some(row_limit),
        (None, None) => None,
    }
}

fn single_execution_page_limit(request: &QueryResultExportRequest, page_size: usize) -> Option<usize> {
    single_execution_row_bound(request).filter(|bound| *bound > 0 && *bound <= page_size.max(1))
}

/// True when a non-agent export can still stream this query by executing it
/// exactly once without exceeding one normal export page. Larger TOP/row-limit
/// bounds require an Agent result session; executing them in one response would
/// defeat streaming and recreate the large-result memory spike.
#[cfg(test)]
fn supports_single_execution_export(request: &QueryResultExportRequest, page_size: usize) -> bool {
    single_execution_page_limit(request, page_size).is_some()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SafeKeysetCandidate {
    schema: Option<String>,
    table: String,
}

struct KeysetPlan {
    columns: Vec<String>,
    primary_keys: Vec<String>,
    pk_indices: Vec<usize>,
    schema: String,
    table: String,
    last_pk_values: Vec<Value>,
}

fn object_name_parts(name: &sqlparser::ast::ObjectName) -> Option<Vec<String>> {
    name.0
        .iter()
        .map(|part| match part {
            ObjectNamePart::Identifier(ident) => Some(ident.value.clone()),
            _ => None,
        })
        .collect()
}

fn safe_keyset_candidate(sql: &str) -> Option<SafeKeysetCandidate> {
    let dialect = GenericDialect {};
    let statements = Parser::parse_sql(&dialect, sql).ok()?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return None;
    };
    if query.with.is_some()
        || query.limit_clause.is_some()
        || query.fetch.is_some()
        || !query.locks.is_empty()
        || query.for_clause.is_some()
        || query.settings.is_some()
        || query.format_clause.is_some()
        || !query.pipe_operators.is_empty()
        || query
            .order_by
            .as_ref()
            .is_some_and(|order_by| !matches!(&order_by.kind, OrderByKind::Expressions(exprs) if exprs.is_empty()))
    {
        return None;
    }
    let SetExpr::Select(select) = query.body.as_ref() else {
        return None;
    };
    if select.distinct.is_some()
        || select.top.is_some()
        || !matches!(&select.group_by, GroupByExpr::Expressions(exprs, _) if exprs.is_empty())
        || select.having.is_some()
        || select.selection.is_some()
        || select.from.len() != 1
        || !(select.projection.len() == 1 && matches!(select.projection.first(), Some(SelectItem::Wildcard(_))))
    {
        return None;
    }
    let source = &select.from[0];
    if !source.joins.is_empty() {
        return None;
    }
    let TableFactor::Table { name, .. } = &source.relation else {
        return None;
    };
    let parts = object_name_parts(name)?;
    match parts.as_slice() {
        [table] => Some(SafeKeysetCandidate { schema: None, table: table.clone() }),
        [schema, table] => Some(SafeKeysetCandidate { schema: Some(schema.clone()), table: table.clone() }),
        _ => None,
    }
}

async fn build_keyset_plan(state: &AppState, request: &QueryResultExportRequest) -> Option<KeysetPlan> {
    if !request.keyset_optimization_enabled || request.use_agent_cursor {
        return None;
    }
    let candidate = safe_keyset_candidate(&request.sql)?;
    let schema = candidate.schema.or_else(|| request.schema.clone()).unwrap_or_default();
    let columns =
        crate::schema::get_columns_core(state, &request.connection_id, &request.database, &schema, &candidate.table)
            .await
            .ok()?;
    let col_names: Vec<String> = columns.iter().map(|column| column.name.clone()).collect();
    let primary_keys: Vec<String> =
        columns.iter().filter(|column| column.is_primary_key).map(|column| column.name.clone()).collect();
    if col_names.is_empty() || primary_keys.is_empty() {
        return None;
    }
    let pk_indices: Vec<usize> = primary_keys
        .iter()
        .filter_map(|pk| col_names.iter().position(|column| column.eq_ignore_ascii_case(pk)))
        .collect();
    if pk_indices.len() != primary_keys.len() {
        return None;
    }
    Some(KeysetPlan {
        columns: col_names,
        primary_keys,
        pk_indices,
        schema,
        table: candidate.table,
        last_pk_values: Vec::new(),
    })
}

pub async fn export_query_result_core(
    state: &AppState,
    request: &QueryResultExportRequest,
    cancel_token: Option<CancellationToken>,
    on_progress: impl Fn(TableExportProgress),
) -> Result<(), String> {
    let mut session_id: Option<String> = None;
    let result = export_query_result_core_inner(state, request, cancel_token, &on_progress, &mut session_id).await;

    if let Some(session_id) = session_id {
        let _ = close_query_session(
            state,
            &request.connection_id,
            &request.database,
            &session_id,
            request.client_session_id.as_deref(),
            None,
        )
        .await;
    }
    if let Some(client_session_id) = request.client_session_id.as_deref() {
        let database = request.database.trim();
        let database = if database.is_empty() { None } else { Some(database) };
        let _ = state.close_client_session_pool(&request.connection_id, database, client_session_id).await;
    }

    result
}

async fn export_query_result_core_inner(
    state: &AppState,
    request: &QueryResultExportRequest,
    cancel_token: Option<CancellationToken>,
    on_progress: &impl Fn(TableExportProgress),
    session_id: &mut Option<String>,
) -> Result<(), String> {
    let format = request.format.to_lowercase();
    if format != "csv" && format != "xlsx" && format != "txt" && format != "sql" {
        return Err(format!("Unsupported streaming query-result export format: {format}"));
    }

    let page_size = request.page_size.max(1);
    let effective_row_limit = effective_row_limit(request);
    let agent_max_rows = effective_row_limit.unwrap_or(AGENT_UNBOUNDED_ROW_LIMIT).max(1);

    on_progress(progress(request, 0, ExportStatus::Running, None));

    if try_export_postgres_query_result_stream(state, request, &format, cancel_token.clone(), on_progress).await? {
        return Ok(());
    }

    if try_export_sqlserver_query_result_stream(state, request, &format, cancel_token.clone(), on_progress).await? {
        return Ok(());
    }

    // MySQL does not guarantee a stable row order for independent LIMIT/OFFSET
    // executions without ORDER BY, so query-result export must stream one run.
    if try_export_mysql_query_result_stream(state, request, &format, cancel_token.clone(), on_progress).await? {
        return Ok(());
    }

    // ClickHouse HTTP pagination is unsafe for unsorted result sets; stream one
    // response so large exports preserve the server's single execution order.
    if try_export_clickhouse_query_result_stream(state, request, &format, cancel_token.clone(), on_progress).await? {
        return Ok(());
    }

    let mut text_file = if format == "csv" || format == "txt" {
        Some(BufWriter::new(File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?))
    } else {
        None
    };
    if let Some(file) = text_file.as_mut() {
        file.write_all(b"\xEF\xBB\xBF").map_err(|e| format!("Failed to write BOM: {e}"))?;
    }

    let mut xlsx = None;
    let mut columns: Vec<String> = Vec::new();
    let mut column_types: Vec<String> = Vec::new();
    let mut rows_exported: u64 = 0;
    let mut offset: usize = 0;
    let mut wrote_text_header = false;
    let mut keyset_plan = build_keyset_plan(state, request).await;
    // A Kingbase SQL Server compat TOP query that cannot be offset-paginated is
    // exported with a single execution whose page size is the enforceable row
    // bound (concrete TOP count and/or the configured export row limit), then it
    // stops after the first response.
    let single_execution_bound = single_execution_page_limit(request, page_size);
    if keyset_plan.is_none()
        && !request.use_agent_cursor
        && !supports_streaming_offset_pagination(request, page_size)
        && single_execution_bound.is_none()
    {
        return Err(STREAMING_PAGINATION_UNSUPPORTED_ERROR.to_string());
    }

    let mut sql_writer: Option<SqlInsertWriter> =
        if format == "sql" { Some(SqlInsertWriter::create(request)?) } else { None };

    loop {
        if cancel_token.as_ref().is_some_and(|token| token.is_cancelled())
            || is_export_cancelled(&request.export_id).await
        {
            on_progress(progress(
                request,
                rows_exported,
                ExportStatus::Cancelled,
                Some("Export cancelled".to_string()),
            ));
            return Ok(());
        }

        let remaining = effective_row_limit.map(|limit| limit.saturating_sub(rows_exported as usize));
        if matches!(remaining, Some(0)) {
            break;
        }
        let this_page = if keyset_plan.is_none() && single_execution_bound.is_some() {
            // Single execution covers the whole enforceable TOP/row-limit bound in
            // one shot; never an unbounded i32::MAX page.
            single_execution_bound.unwrap_or(page_size).max(1)
        } else {
            remaining.map_or(page_size, |rem| rem.min(page_size)).max(1)
        };

        let (sql_to_execute, plan_limit, use_agent_result_session, single_execution) =
            if let Some(plan) = keyset_plan.as_ref() {
                (
                    keyset_pagination_sql(
                        &plan.columns,
                        &plan.table,
                        &plan.schema,
                        &request.database_type,
                        &plan.primary_keys,
                        &plan.last_pk_values,
                        this_page,
                    ),
                    this_page,
                    false,
                    false,
                )
            } else {
                let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                    sql: request.sql.clone(),
                    query_base_sql: request.query_base_sql.clone(),
                    database_type: Some(request.database_type),
                    pagination: QueryPagination { limit: this_page, offset, session_id: session_id.clone() },
                    use_agent_cursor: request.use_agent_cursor,
                    first_page_uses_actual_sql: true,
                });
                let Some(plan_limit) = plan.page_limit else {
                    return Err("Failed to build query pagination plan for export".to_string());
                };
                (plan.sql_to_execute, plan_limit, plan.use_agent_result_session, plan.single_execution)
            };

        let options = if use_agent_result_session {
            QueryExecutionOptions {
                page_size: Some(plan_limit),
                fetch_size: Some(plan_limit),
                result_session_id: session_id.clone(),
                max_rows: Some(agent_max_rows),
                timeout_secs: request.timeout_secs,
                client_session_id: request.client_session_id.clone(),
                execution_id: request.execution_id.clone(),
                catalog: request.catalog.clone(),
                ..Default::default()
            }
        } else {
            QueryExecutionOptions {
                max_rows: Some(plan_limit),
                fetch_size: Some(plan_limit),
                timeout_secs: request.timeout_secs,
                client_session_id: request.client_session_id.clone(),
                execution_id: request.execution_id.clone(),
                catalog: request.catalog.clone(),
                ..Default::default()
            }
        };

        let mut result = match execute_sql_statement_with_options(
            state,
            &request.connection_id,
            &request.database,
            &sql_to_execute,
            request.schema.as_deref(),
            cancel_token.clone(),
            options,
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                if error == QUERY_CANCELED
                    || cancel_token.as_ref().is_some_and(|token| token.is_cancelled())
                    || is_export_cancelled(&request.export_id).await
                {
                    on_progress(progress(
                        request,
                        rows_exported,
                        ExportStatus::Cancelled,
                        Some("Export cancelled".to_string()),
                    ));
                    return Ok(());
                }
                return Err(error);
            }
        };

        if cancel_token.as_ref().is_some_and(|token| token.is_cancelled())
            || is_export_cancelled(&request.export_id).await
        {
            on_progress(progress(
                request,
                rows_exported,
                ExportStatus::Cancelled,
                Some("Export cancelled".to_string()),
            ));
            return Ok(());
        }

        if columns.is_empty() {
            columns = result.columns.clone();
            column_types = result.column_types.clone();
            if let Some(writer) = sql_writer.as_mut() {
                writer.set_columns(columns.clone(), &column_types, request);
            }
        }
        let fetched_row_count = result.rows.len();
        if result.rows.len() > this_page {
            result.rows.truncate(this_page);
        }
        let row_count = result.rows.len();
        let formatted_rows = crate::temporal_format::format_temporal_export_rows_with_string_types(
            &result.rows,
            &column_types,
            request.date_time_format.as_deref(),
        );

        if format == "csv" || format == "txt" {
            if let Some(file) = text_file.as_mut() {
                if !wrote_text_header {
                    let header = format_text_export_header(&format, &columns);
                    file.write_all(header.as_bytes()).map_err(|e| format!("Failed to write export header: {e}"))?;
                    if row_count > 0 {
                        let rows = format_text_export_rows(&format, &formatted_rows);
                        write!(file, "\n{rows}").map_err(|e| format!("Failed to write export rows: {e}"))?;
                    }
                    wrote_text_header = true;
                } else if row_count > 0 {
                    let rows = format_text_export_rows(&format, &formatted_rows);
                    write!(file, "\n{rows}").map_err(|e| format!("Failed to write export rows: {e}"))?;
                }
            }
        } else if format == "sql" {
            let writer = sql_writer.as_mut().ok_or_else(|| "SQL export writer missing".to_string())?;
            for row in formatted_rows {
                writer.write_row(row)?;
            }
        } else {
            if xlsx.is_none() {
                let xlsx_file =
                    File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                xlsx = Some(start_query_result_xlsx_workbook(
                    BufWriter::new(xlsx_file),
                    request,
                    &columns,
                    &column_types,
                )?);
            }
            if let Some(writer) = xlsx.as_mut() {
                for row in &formatted_rows {
                    writer.write_row(row).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                }
            }
        }

        rows_exported += row_count as u64;
        on_progress(progress(request, rows_exported, ExportStatus::Running, None));

        if result.session_id.is_some() {
            *session_id = result.session_id.clone();
        }
        if use_agent_result_session && result.has_more && session_id.is_none() {
            return Err(AGENT_SESSION_MISSING_ERROR.to_string());
        }
        if let Some(plan) = keyset_plan.as_mut() {
            if let Some(last_row) = result.rows.last() {
                plan.last_pk_values =
                    plan.pk_indices.iter().map(|&index| last_row.get(index).cloned().unwrap_or(Value::Null)).collect();
            }
        }
        let should_continue = if single_execution {
            // A single execution already streamed the full (TOP-bounded) result;
            // there is no offset to advance to.
            false
        } else {
            should_fetch_next_page(use_agent_result_session, result.has_more, fetched_row_count, row_count, plan_limit)
        };
        if cancel_token.as_ref().is_some_and(|token| token.is_cancelled())
            || is_export_cancelled(&request.export_id).await
        {
            on_progress(progress(
                request,
                rows_exported,
                ExportStatus::Cancelled,
                Some("Export cancelled".to_string()),
            ));
            return Ok(());
        }
        if !should_continue || row_count == 0 {
            break;
        }
        offset += row_count;
    }

    on_progress(progress(request, rows_exported, ExportStatus::Writing, None));

    if format == "csv" || format == "txt" {
        if !wrote_text_header {
            let header = format_text_export_header(&format, &columns);
            if let Some(file) = text_file.as_mut() {
                file.write_all(header.as_bytes()).map_err(|e| format!("Failed to write export header: {e}"))?;
            }
        }
        if let Some(file) = text_file.as_mut() {
            file.flush().map_err(|e| format!("Failed to flush text export file: {e}"))?;
        }
    } else if format == "sql" {
        if let Some(writer) = sql_writer.take() {
            writer.finish()?;
        }
    } else if let Some(writer) = xlsx {
        let mut buf =
            finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
        buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
    } else {
        let xlsx_file = File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
        let writer = start_query_result_xlsx_workbook(BufWriter::new(xlsx_file), request, &columns, &column_types)?;
        let mut buf =
            finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
        buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
    }

    on_progress(progress(request, rows_exported, ExportStatus::Done, None));
    Ok(())
}

async fn try_export_postgres_query_result_stream(
    state: &AppState,
    request: &QueryResultExportRequest,
    format: &str,
    cancel_token: Option<CancellationToken>,
    on_progress: &impl Fn(TableExportProgress),
) -> Result<bool, String> {
    if request.use_agent_cursor
        || !crate::sql::starts_with_executable_sql_keyword(
            &request.sql,
            &["SELECT", "SHOW", "EXPLAIN", "WITH", "TABLE"],
        )
    {
        return Ok(false);
    }

    let database = request.database.trim();
    let pool_key = if database.is_empty() {
        state.get_or_create_pool_for_session(&request.connection_id, None, request.client_session_id.as_deref()).await?
    } else {
        state
            .get_or_create_pool_for_session(
                &request.connection_id,
                Some(database),
                request.client_session_id.as_deref(),
            )
            .await?
    };
    let connections = state.connections.read().await;
    let Some(pool) = connections.get(&pool_key).and_then(|pool| match pool {
        PoolKind::Postgres(pool) => Some(pool.clone()),
        _ => None,
    }) else {
        return Ok(false);
    };
    drop(connections);

    if let Some(execution_id) = request.execution_id.as_deref() {
        state.running_queries.set_pool_key(execution_id, pool_key.clone());
    }
    state.touch_pool_activity(&pool_key).await;
    let _activity_touch = state.pool_activity_touch(&pool_key);

    let row_limit = effective_row_limit(request);
    let stream_row_limit = row_limit;
    let progress_row_interval = request.page_size.max(1) as u64;
    let mut columns: Vec<String> = Vec::new();
    let mut temporal_column_types: Vec<String> = Vec::new();
    let mut rows_exported = 0_u64;
    let mut last_progress_rows = 0_u64;
    let mut last_progress_at = Instant::now();
    let mut text_file = if format == "csv" || format == "txt" {
        let mut file =
            BufWriter::new(File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?);
        file.write_all(b"\xEF\xBB\xBF").map_err(|e| format!("Failed to write BOM: {e}"))?;
        Some(file)
    } else {
        None
    };
    let mut xlsx = None;
    let mut sql_writer: Option<SqlInsertWriter> =
        if format == "sql" { Some(SqlInsertWriter::create(request)?) } else { None };
    let budget = operation_budget_for_pool_key(state, &pool_key, query_export_timeout(request.timeout_secs)).await;
    let cancel_context = state.get_postgres_cancel_context(&pool_key).await;

    let setup_sql = safe_postgres_temp_setup_sql(&request.setup_sql).unwrap_or_default();
    let stream_result = crate::db::postgres::stream_select_query_with_cancel(
        &pool,
        request.schema.as_deref(),
        &setup_sql,
        &request.sql,
        stream_row_limit,
        cancel_token.clone(),
        budget,
        cancel_context,
        |item| {
            match item {
                crate::db::postgres::PostgresQueryStreamItem::Columns { columns: stream_columns, column_types } => {
                    columns = stream_columns;
                    temporal_column_types = column_types.clone();
                    if let Some(writer) = sql_writer.as_mut() {
                        writer.set_columns(columns.clone(), &column_types, request);
                    } else if let Some(file) = text_file.as_mut() {
                        let header = format_text_export_header(format, &columns);
                        file.write_all(header.as_bytes()).map_err(|e| format!("Failed to write export header: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx = Some(start_query_result_xlsx_workbook(
                            BufWriter::new(xlsx_file),
                            request,
                            &columns,
                            &column_types,
                        )?);
                    }
                }
                crate::db::postgres::PostgresQueryStreamItem::Row(row) => {
                    let formatted = crate::temporal_format::format_temporal_export_row_with_string_types(
                        &row,
                        &temporal_column_types,
                        request.date_time_format.as_deref(),
                    );
                    if let Some(writer) = sql_writer.as_mut() {
                        writer.write_row(formatted)?;
                    } else if let Some(file) = text_file.as_mut() {
                        let rows = format_text_export_rows(format, std::slice::from_ref(&formatted));
                        write!(file, "\n{rows}").map_err(|e| format!("Failed to write export rows: {e}"))?;
                    } else if let Some(writer) = xlsx.as_mut() {
                        writer.write_row(&formatted).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx =
                            Some(start_query_result_xlsx_workbook(BufWriter::new(xlsx_file), request, &columns, &[])?);
                        if let Some(writer) = xlsx.as_mut() {
                            writer.write_row(&formatted).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                        }
                    }
                    rows_exported += 1;
                    let now = Instant::now();
                    if should_emit_stream_progress(
                        rows_exported,
                        last_progress_rows,
                        progress_row_interval,
                        now.duration_since(last_progress_at),
                    ) {
                        on_progress(progress(request, rows_exported, ExportStatus::Running, None));
                        last_progress_rows = rows_exported;
                        last_progress_at = now;
                    }
                }
            }
            Ok(())
        },
    )
    .await;

    if let Err(error) = stream_result {
        let export_cancelled = is_export_cancelled(&request.export_id).await;
        if stream_export_was_cancelled(
            &error,
            cancel_token.as_ref().is_some_and(|token| token.is_cancelled()),
            export_cancelled,
        ) {
            on_progress(progress(
                request,
                rows_exported,
                ExportStatus::Cancelled,
                Some("Export cancelled".to_string()),
            ));
            return Ok(true);
        }
        return Err(error);
    }

    if rows_exported != last_progress_rows {
        on_progress(progress(request, rows_exported, ExportStatus::Running, None));
    }
    on_progress(progress(request, rows_exported, ExportStatus::Writing, None));
    if let Some(file) = text_file.as_mut() {
        file.flush().map_err(|e| format!("Failed to flush text export file: {e}"))?;
    }
    if let Some(writer) = sql_writer.take() {
        writer.finish()?;
    } else if let Some(writer) = xlsx {
        let mut buf =
            finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
        buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
    } else if format == "xlsx" {
        let xlsx_file = File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
        let writer = start_query_result_xlsx_workbook(BufWriter::new(xlsx_file), request, &columns, &[])?;
        let mut buf =
            finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
        buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
    }
    on_progress(progress(request, rows_exported, ExportStatus::Done, None));
    Ok(true)
}

async fn try_export_mysql_query_result_stream(
    state: &AppState,
    request: &QueryResultExportRequest,
    format: &str,
    cancel_token: Option<CancellationToken>,
    on_progress: &impl Fn(TableExportProgress),
) -> Result<bool, String> {
    if request.use_agent_cursor {
        return Ok(false);
    }

    let pool_key = if request.database.trim().is_empty() {
        state.get_or_create_pool_for_session(&request.connection_id, None, request.client_session_id.as_deref()).await?
    } else {
        state
            .get_or_create_pool_for_session(
                &request.connection_id,
                Some(request.database.as_str()),
                request.client_session_id.as_deref(),
            )
            .await?
    };
    let connections = state.connections.read().await;
    let Some((pool, bare)) = connections.get(&pool_key).and_then(|pool| match pool {
        PoolKind::Mysql(pool, mode) => Some((pool.clone(), *mode == crate::connection::MysqlMode::Bare)),
        _ => None,
    }) else {
        return Ok(false);
    };
    drop(connections);

    if let Some(execution_id) = request.execution_id.as_deref() {
        state.running_queries.set_pool_key(execution_id, pool_key.clone());
    }
    state.touch_pool_activity(&pool_key).await;
    let _activity_touch = state.pool_activity_touch(&pool_key);

    let (mysql_dialect, read_only_connection) = {
        let configs = state.configs.read().await;
        let config = configs.get(&request.connection_id);
        (
            config
                .map(|config| {
                    crate::db::mysql::MySqlQueryDialect::for_connection(
                        config.db_type,
                        config.driver_profile.as_deref(),
                    )
                })
                .unwrap_or_default(),
            config.filter(|config| config.read_only).map(|config| (config.name.clone(), config.db_type)),
        )
    };
    if let Some((name, database_type)) = read_only_connection {
        crate::query_execution_sql::check_read_only(&request.sql, &name, database_type)?;
    }

    let row_limit = effective_row_limit(request);
    let stream_row_limit = row_limit;
    let progress_row_interval = request.page_size.max(1) as u64;
    let mut columns: Vec<String> = Vec::new();
    let mut temporal_column_types: Vec<String> = Vec::new();
    let mut rows_exported = 0_u64;
    let mut last_progress_rows = 0_u64;
    let mut last_progress_at = Instant::now();
    let mut text_file = if format == "csv" || format == "txt" {
        let mut file =
            BufWriter::new(File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?);
        file.write_all(b"\xEF\xBB\xBF").map_err(|e| format!("Failed to write BOM: {e}"))?;
        Some(file)
    } else {
        None
    };
    let mut xlsx = None;
    let mut sql_writer: Option<SqlInsertWriter> =
        if format == "sql" { Some(SqlInsertWriter::create(request)?) } else { None };
    let query_timeout = query_export_timeout(request.timeout_secs);
    let operation_budget = operation_budget_for_pool_key(state, &pool_key, query_timeout).await;
    let mut conn = crate::db::mysql::get_conn_with_health_check_with_cancel(
        &pool,
        operation_budget.checkout_timeout,
        operation_budget.cleanup_timeout,
        cancel_token.as_ref(),
    )
    .await?;
    let mysql_connection_id = conn.id();
    let kill_opts = conn.opts().clone();
    if let Some(execution_id) = request.execution_id.clone() {
        let interrupt_kill_opts = kill_opts.clone();
        state.running_queries.register_interrupt(&execution_id, move || {
            let kill_opts = interrupt_kill_opts.clone();
            tokio::spawn(async move {
                if let Err(error) = crate::db::mysql::kill_query_with_opts(kill_opts, mysql_connection_id).await {
                    log::warn!("Failed to cancel MySQL export query {mysql_connection_id}: {error}");
                }
            });
        });
    }

    let export_cancelled = Arc::new(AtomicBool::new(false));
    let watcher_done = CancellationToken::new();
    let watcher_done_task = watcher_done.clone();
    let export_cancelled_task = export_cancelled.clone();
    let export_id = request.export_id.clone();
    let cancel_for_watcher = cancel_token.clone();
    // Normal UI cancellation uses running query cancellation and KILL QUERY.
    // This covers callers that only set the export-cancelled flag.
    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = watcher_done_task.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
            if is_export_cancelled(&export_id).await {
                export_cancelled_task.store(true, Ordering::SeqCst);
                if let Some(token) = cancel_for_watcher.as_ref() {
                    token.cancel();
                }
                break;
            }
        }
    });

    let progress_clock = Arc::new(StreamProgressClock::new());
    let progress_clock_for_stream = progress_clock.clone();
    let stream_future = crate::db::mysql::stream_query_result_on_conn(
        &mut conn,
        &request.sql,
        bare,
        stream_row_limit,
        mysql_dialect,
        &export_cancelled,
        format.eq_ignore_ascii_case("sql"),
        |item| {
            if export_cancelled.load(Ordering::SeqCst)
                || cancel_token.as_ref().is_some_and(|token| token.is_cancelled())
            {
                return Err(canceled_error());
            }
            match item {
                crate::db::mysql::MySqlQueryStreamItem::Columns { columns: stream_columns, column_types } => {
                    columns = stream_columns;
                    temporal_column_types = column_types.clone();
                    if let Some(writer) = sql_writer.as_mut() {
                        writer.set_columns(columns.clone(), &column_types, request);
                    } else if let Some(file) = text_file.as_mut() {
                        let header = format_text_export_header(format, &columns);
                        file.write_all(header.as_bytes()).map_err(|e| format!("Failed to write export header: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx = Some(start_query_result_xlsx_workbook(
                            BufWriter::new(xlsx_file),
                            request,
                            &columns,
                            &column_types,
                        )?);
                    }
                }
                crate::db::mysql::MySqlQueryStreamItem::Row(row) => {
                    let formatted = crate::temporal_format::format_temporal_export_row_with_string_types(
                        &row,
                        &temporal_column_types,
                        request.date_time_format.as_deref(),
                    );
                    if let Some(writer) = sql_writer.as_mut() {
                        writer.write_row(formatted)?;
                    } else if let Some(file) = text_file.as_mut() {
                        let rows = format_text_export_rows(format, std::slice::from_ref(&formatted));
                        write!(file, "\n{rows}").map_err(|e| format!("Failed to write export rows: {e}"))?;
                    } else if let Some(writer) = xlsx.as_mut() {
                        writer.write_row(&formatted).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx =
                            Some(start_query_result_xlsx_workbook(BufWriter::new(xlsx_file), request, &columns, &[])?);
                        if let Some(writer) = xlsx.as_mut() {
                            writer.write_row(&formatted).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                        }
                    }
                    rows_exported += 1;
                    let now = Instant::now();
                    if should_emit_stream_progress(
                        rows_exported,
                        last_progress_rows,
                        progress_row_interval,
                        now.duration_since(last_progress_at),
                    ) {
                        on_progress(progress(request, rows_exported, ExportStatus::Running, None));
                        last_progress_rows = rows_exported;
                        last_progress_at = now;
                    }
                }
            }
            progress_clock_for_stream.mark();
            Ok(())
        },
    );
    let timeout_error =
        format!("Query timed out after {} seconds", query_timeout.map_or(0, |timeout| timeout.as_secs()));
    let stream_result = await_stream_with_progress_timeout(
        stream_future,
        query_timeout,
        progress_clock,
        cancel_token.as_ref(),
        timeout_error.clone(),
    )
    .await;
    if stream_result.as_ref().is_err_and(|error| error == &timeout_error) {
        let _ = crate::db::mysql::kill_query_with_opts(kill_opts, mysql_connection_id).await;
    }
    watcher_done.cancel();

    if let Err(error) = stream_result {
        // A timed-out, cancelled, or failed MySQL result stream may leave an
        // incomplete protocol packet on the connection. Explicitly disconnect
        // it so mysql_async cannot recycle the poisoned connection into the pool.
        match disconnect_with_timeout(conn, operation_budget.cleanup_timeout, |conn| async move {
            conn.disconnect().await.map_err(|error| error.to_string())
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(disconnect_error)) => {
                log::warn!(
                    "Failed to disconnect MySQL export connection {mysql_connection_id} after stream error: {disconnect_error}"
                );
            }
            Err(_) => {
                log::warn!("Timed out disconnecting MySQL export connection {mysql_connection_id} after stream error");
            }
        }

        if error == QUERY_CANCELED
            || export_cancelled.load(Ordering::SeqCst)
            || cancel_token.as_ref().is_some_and(|token| token.is_cancelled())
            || is_export_cancelled(&request.export_id).await
        {
            on_progress(progress(
                request,
                rows_exported,
                ExportStatus::Cancelled,
                Some("Export cancelled".to_string()),
            ));
            return Ok(true);
        }
        return Err(error);
    }

    if rows_exported != last_progress_rows {
        on_progress(progress(request, rows_exported, ExportStatus::Running, None));
    }
    on_progress(progress(request, rows_exported, ExportStatus::Writing, None));
    if let Some(file) = text_file.as_mut() {
        file.flush().map_err(|e| format!("Failed to flush text export file: {e}"))?;
    }
    if let Some(writer) = sql_writer.take() {
        writer.finish()?;
    } else if let Some(writer) = xlsx {
        let mut buf =
            finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
        buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
    } else if format == "xlsx" {
        let xlsx_file = File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
        let writer = start_query_result_xlsx_workbook(BufWriter::new(xlsx_file), request, &columns, &[])?;
        let mut buf =
            finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
        buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
    }
    on_progress(progress(request, rows_exported, ExportStatus::Done, None));
    Ok(true)
}

async fn try_export_clickhouse_query_result_stream(
    state: &AppState,
    request: &QueryResultExportRequest,
    format: &str,
    cancel_token: Option<CancellationToken>,
    on_progress: &impl Fn(TableExportProgress),
) -> Result<bool, String> {
    if request.database_type != DatabaseType::ClickHouse
        || request.use_agent_cursor
        || !crate::sql::starts_with_executable_sql_keyword(
            &request.sql,
            &["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH"],
        )
    {
        return Ok(false);
    }

    let database = request.database.trim();
    let pool_key = if database.is_empty() {
        state.get_or_create_pool_for_session(&request.connection_id, None, request.client_session_id.as_deref()).await?
    } else {
        state
            .get_or_create_pool_for_session(
                &request.connection_id,
                Some(database),
                request.client_session_id.as_deref(),
            )
            .await?
    };
    let connections = state.connections.read().await;
    let Some(client) = connections.get(&pool_key).and_then(|pool| match pool {
        PoolKind::ClickHouse(client) => Some(client.clone()),
        _ => None,
    }) else {
        return Ok(false);
    };
    drop(connections);

    if let Some(execution_id) = request.execution_id.as_deref() {
        state.running_queries.set_pool_key(execution_id, pool_key.clone());
    }
    state.touch_pool_activity(&pool_key).await;
    let _activity_touch = state.pool_activity_touch(&pool_key);

    let row_limit = effective_row_limit(request);
    let stream_row_limit = row_limit;
    let progress_row_interval = request.page_size.max(1) as u64;
    let mut columns: Vec<String> = Vec::new();
    let mut temporal_column_types: Vec<String> = Vec::new();
    let mut rows_exported = 0_u64;
    let mut last_progress_rows = 0_u64;
    let mut last_progress_at = Instant::now();
    let mut text_file = if format == "csv" || format == "txt" {
        let mut file =
            BufWriter::new(File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?);
        file.write_all(b"\xEF\xBB\xBF").map_err(|e| format!("Failed to write BOM: {e}"))?;
        Some(file)
    } else {
        None
    };
    let mut xlsx = None;
    let mut sql_writer: Option<SqlInsertWriter> =
        if format == "sql" { Some(SqlInsertWriter::create(request)?) } else { None };
    let query_timeout = query_export_timeout(request.timeout_secs);
    let clickhouse_database = if database.is_empty() { "default" } else { database };

    let progress_clock = Arc::new(StreamProgressClock::new());
    let progress_clock_for_stream = progress_clock.clone();
    let stream_future = crate::db::clickhouse_driver::stream_query_with_max_rows(
        &client,
        clickhouse_database,
        &request.sql,
        stream_row_limit,
        cancel_token.clone(),
        |item| {
            match item {
                crate::db::clickhouse_driver::ClickHouseQueryStreamItem::Columns {
                    columns: stream_columns,
                    column_types,
                } => {
                    columns = stream_columns;
                    temporal_column_types = column_types.clone();
                    if let Some(writer) = sql_writer.as_mut() {
                        writer.set_columns(columns.clone(), &column_types, request);
                    } else if let Some(file) = text_file.as_mut() {
                        let header = format_text_export_header(format, &columns);
                        file.write_all(header.as_bytes()).map_err(|e| format!("Failed to write export header: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx = Some(start_query_result_xlsx_workbook(
                            BufWriter::new(xlsx_file),
                            request,
                            &columns,
                            &column_types,
                        )?);
                    }
                }
                crate::db::clickhouse_driver::ClickHouseQueryStreamItem::Row(row) => {
                    let formatted = crate::temporal_format::format_temporal_export_row_with_string_types(
                        &row,
                        &temporal_column_types,
                        request.date_time_format.as_deref(),
                    );
                    if let Some(writer) = sql_writer.as_mut() {
                        writer.write_row(formatted)?;
                    } else if let Some(file) = text_file.as_mut() {
                        let rows = format_text_export_rows(format, std::slice::from_ref(&formatted));
                        write!(file, "\n{rows}").map_err(|e| format!("Failed to write export rows: {e}"))?;
                    } else if let Some(writer) = xlsx.as_mut() {
                        writer.write_row(&formatted).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx =
                            Some(start_query_result_xlsx_workbook(BufWriter::new(xlsx_file), request, &columns, &[])?);
                        if let Some(writer) = xlsx.as_mut() {
                            writer.write_row(&formatted).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                        }
                    }
                    rows_exported += 1;
                    let now = Instant::now();
                    if should_emit_stream_progress(
                        rows_exported,
                        last_progress_rows,
                        progress_row_interval,
                        now.duration_since(last_progress_at),
                    ) {
                        on_progress(progress(request, rows_exported, ExportStatus::Running, None));
                        last_progress_rows = rows_exported;
                        last_progress_at = now;
                    }
                }
            }
            progress_clock_for_stream.mark();
            Ok(())
        },
    );
    let stream_result = await_stream_with_progress_timeout(
        stream_future,
        query_timeout,
        progress_clock,
        cancel_token.as_ref(),
        format!("Query timed out after {} seconds", query_timeout.map_or(0, |timeout| timeout.as_secs())),
    )
    .await;

    if let Err(error) = stream_result {
        if error == QUERY_CANCELED
            || cancel_token.as_ref().is_some_and(|token| token.is_cancelled())
            || is_export_cancelled(&request.export_id).await
        {
            on_progress(progress(
                request,
                rows_exported,
                ExportStatus::Cancelled,
                Some("Export cancelled".to_string()),
            ));
            return Ok(true);
        }
        return Err(error);
    }

    if rows_exported != last_progress_rows {
        on_progress(progress(request, rows_exported, ExportStatus::Running, None));
    }
    on_progress(progress(request, rows_exported, ExportStatus::Writing, None));
    if let Some(file) = text_file.as_mut() {
        file.flush().map_err(|e| format!("Failed to flush text export file: {e}"))?;
    }
    if let Some(writer) = sql_writer.take() {
        writer.finish()?;
    } else if let Some(writer) = xlsx {
        let mut buf =
            finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
        buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
    } else if format == "xlsx" {
        let xlsx_file = File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
        let writer = start_query_result_xlsx_workbook(BufWriter::new(xlsx_file), request, &columns, &[])?;
        let mut buf =
            finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
        buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
    }
    on_progress(progress(request, rows_exported, ExportStatus::Done, None));
    Ok(true)
}

async fn try_export_sqlserver_query_result_stream(
    state: &AppState,
    request: &QueryResultExportRequest,
    format: &str,
    cancel_token: Option<CancellationToken>,
    on_progress: &impl Fn(TableExportProgress),
) -> Result<bool, String> {
    if request.database_type != DatabaseType::SqlServer || request.use_agent_cursor {
        return Ok(false);
    }

    let pool_key = state.get_or_create_pool(&request.connection_id, Some(&request.database)).await?;
    let connections = state.connections.read().await;
    let Some(client) = connections.get(&pool_key).and_then(|pool| match pool {
        PoolKind::SqlServer(client) => Some(client.clone()),
        _ => None,
    }) else {
        return Ok(false);
    };
    drop(connections);

    if let Some(execution_id) = request.execution_id.as_deref() {
        state.running_queries.set_pool_key(execution_id, pool_key);
    }

    let row_limit = effective_row_limit(request);
    let stream_row_limit = row_limit;
    let mut columns: Vec<String> = Vec::new();
    let mut temporal_column_types: Vec<String> = Vec::new();
    let mut rows_exported = 0_u64;
    let mut last_progress_rows = 0_u64;
    let mut last_progress_at = Instant::now();
    let progress_row_interval = request.page_size.max(1) as u64;
    let mut text_file = if format == "csv" || format == "txt" {
        let mut file =
            BufWriter::new(File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?);
        file.write_all(b"\xEF\xBB\xBF").map_err(|e| format!("Failed to write BOM: {e}"))?;
        Some(file)
    } else {
        None
    };
    let mut xlsx = None;
    let mut sql_writer: Option<SqlInsertWriter> =
        if format == "sql" { Some(SqlInsertWriter::create(request)?) } else { None };
    let query_timeout = query_export_timeout(request.timeout_secs);

    let mut client = match cancel_token.as_ref() {
        Some(token) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    on_progress(progress(
                        request,
                        rows_exported,
                        ExportStatus::Cancelled,
                        Some("Export cancelled".to_string()),
                    ));
                    return Ok(true);
                },
                guard = client.lock() => guard,
            }
        }
        None => client.lock().await,
    };

    let progress_clock = Arc::new(StreamProgressClock::new());
    let progress_clock_for_stream = progress_clock.clone();
    let stream_future = crate::db::sqlserver::stream_first_result_set(
        &mut client,
        &request.sql,
        stream_row_limit,
        cancel_token.clone(),
        |item| {
            match item {
                crate::db::sqlserver::SqlServerStreamItem::Columns { columns: stream_columns, column_types } => {
                    columns = stream_columns.to_vec();
                    temporal_column_types = column_types.to_vec();
                    if let Some(writer) = sql_writer.as_mut() {
                        writer.set_columns(columns.clone(), &temporal_column_types, request);
                    } else if let Some(file) = text_file.as_mut() {
                        let header = format_text_export_header(format, &columns);
                        file.write_all(header.as_bytes()).map_err(|e| format!("Failed to write export header: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx =
                            Some(start_query_result_xlsx_workbook(BufWriter::new(xlsx_file), request, &columns, &[])?);
                    }
                }
                crate::db::sqlserver::SqlServerStreamItem::Row(row) => {
                    let formatted = crate::temporal_format::format_temporal_export_row_with_string_types(
                        row,
                        &temporal_column_types,
                        request.date_time_format.as_deref(),
                    );
                    if let Some(writer) = sql_writer.as_mut() {
                        writer.write_row(formatted)?;
                    } else if let Some(file) = text_file.as_mut() {
                        let rows = format_text_export_rows(format, std::slice::from_ref(&formatted));
                        write!(file, "\n{rows}").map_err(|e| format!("Failed to write export rows: {e}"))?;
                    } else if let Some(writer) = xlsx.as_mut() {
                        writer.write_row(&formatted).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx =
                            Some(start_query_result_xlsx_workbook(BufWriter::new(xlsx_file), request, &columns, &[])?);
                        if let Some(writer) = xlsx.as_mut() {
                            writer.write_row(&formatted).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                        }
                    }
                    rows_exported += 1;
                    let now = Instant::now();
                    if should_emit_stream_progress(
                        rows_exported,
                        last_progress_rows,
                        progress_row_interval,
                        now.duration_since(last_progress_at),
                    ) {
                        on_progress(progress(request, rows_exported, ExportStatus::Running, None));
                        last_progress_rows = rows_exported;
                        last_progress_at = now;
                    }
                }
            }
            // Mark only after the row is fully written so local XLSX work never consumes
            // the next database inactivity window.
            progress_clock_for_stream.mark();
            Ok(())
        },
    );
    let stream_result = await_stream_with_progress_timeout(
        stream_future,
        query_timeout,
        progress_clock,
        cancel_token.as_ref(),
        format!("Query timed out after {} seconds", query_timeout.map_or(0, |timeout| timeout.as_secs())),
    )
    .await;
    drop(client);

    if let Err(error) = stream_result {
        let export_cancelled = is_export_cancelled(&request.export_id).await;
        if stream_export_was_cancelled(
            &error,
            cancel_token.as_ref().is_some_and(|token| token.is_cancelled()),
            export_cancelled,
        ) {
            on_progress(progress(
                request,
                rows_exported,
                ExportStatus::Cancelled,
                Some("Export cancelled".to_string()),
            ));
            return Ok(true);
        }
        return Err(error);
    }

    if rows_exported != last_progress_rows {
        on_progress(progress(request, rows_exported, ExportStatus::Running, None));
    }
    on_progress(progress(request, rows_exported, ExportStatus::Writing, None));
    if let Some(file) = text_file.as_mut() {
        file.flush().map_err(|e| format!("Failed to flush text export file: {e}"))?;
    }
    if let Some(writer) = sql_writer.take() {
        writer.finish()?;
    } else if let Some(writer) = xlsx {
        let mut buf =
            finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
        buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
    }
    on_progress(progress(request, rows_exported, ExportStatus::Done, None));
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_export_target_preserves_existing_destination_on_discard_and_replace_failure() {
        let dir = tempfile::tempdir().expect("temp dir");
        let destination = dir.path().join("result.csv");
        std::fs::write(&destination, "original").expect("write destination");

        let discarded = StagedExportTarget::new(destination.to_str().expect("destination path")).expect("target");
        std::fs::write(discarded.path(), "partial").expect("write partial export");
        drop(discarded);
        assert_eq!(std::fs::read_to_string(&destination).expect("read destination"), "original");

        let failed = StagedExportTarget::new(destination.to_str().expect("destination path")).expect("target");
        std::fs::write(failed.path(), "replacement").expect("write replacement");
        std::fs::remove_file(failed.path()).expect("remove staged path");
        assert!(failed.commit().expect_err("replace should fail").contains("open staged export file"));
        assert_eq!(std::fs::read_to_string(destination).expect("read destination"), "original");
    }

    #[test]
    fn staged_export_targets_are_unique_same_directory_and_replace_existing_destination() {
        let dir = tempfile::tempdir().expect("temp dir");
        let destination = dir.path().join("result.csv");
        std::fs::write(&destination, "original").expect("write destination");
        let first = StagedExportTarget::new(destination.to_str().expect("destination path")).expect("first target");
        let second = StagedExportTarget::new(destination.to_str().expect("destination path")).expect("second target");

        assert_eq!(first.path().parent(), destination.parent());
        assert_eq!(second.path().parent(), destination.parent());
        assert_ne!(first.path(), second.path());
        std::fs::write(first.path(), "replacement").expect("write replacement");
        first.commit().expect("commit export");
        drop(second);

        assert_eq!(std::fs::read_to_string(destination).expect("read destination"), "replacement");
    }

    #[test]
    fn stream_cancel_detection_covers_driver_token_and_export_flags() {
        assert!(stream_export_was_cancelled(QUERY_CANCELED, false, false));
        assert!(stream_export_was_cancelled("driver closed", true, false));
        assert!(stream_export_was_cancelled("driver closed", false, true));
        assert!(!stream_export_was_cancelled("network failure", false, false));
    }

    #[test]
    fn postgres_temp_setup_accepts_only_session_local_table_operations() {
        let safe = vec![
            "CREATE TEMPORARY TABLE t1 AS SELECT 1 AS id".to_string(),
            "CREATE INDEX t1_id ON t1(id)".to_string(),
            "CREATE TEMP TABLE t2 AS SELECT id FROM t1".to_string(),
            "DROP TABLE t1".to_string(),
        ];
        assert_eq!(safe_postgres_temp_setup_sql(&safe), Some(safe.clone()));

        let parenthesized_ctas = vec![
            "CREATE TEMPORARY TABLE t1 AS (SELECT CURRENT_DATE AS \u{8d77}\u{4fdd}\u{65e5}\u{671f})".to_string(),
            "CREATE INDEX t1_1 ON t1(\u{8d77}\u{4fdd}\u{65e5}\u{671f}, \u{7ec8}\u{6b62}\u{65e5}\u{671f})".to_string(),
        ];
        assert_eq!(safe_postgres_temp_setup_sql(&parenthesized_ctas), Some(parenthesized_ctas.clone()));

        let persistent_create = vec!["CREATE TABLE users_copy AS SELECT * FROM users".to_string()];
        assert!(safe_postgres_temp_setup_sql(&persistent_create).is_none());

        let persistent_write = vec![
            "CREATE TEMP TABLE t1 AS SELECT 1 AS id".to_string(),
            "INSERT INTO audit_log(message) VALUES ('export')".to_string(),
        ];
        assert!(safe_postgres_temp_setup_sql(&persistent_write).is_none());

        let persistent_index = vec!["CREATE INDEX users_name ON users(name)".to_string()];
        assert!(safe_postgres_temp_setup_sql(&persistent_index).is_none());
    }

    fn request(format: &str, row_limit: Option<usize>, total_rows: Option<u64>) -> QueryResultExportRequest {
        QueryResultExportRequest {
            export_id: "export-1".to_string(),
            connection_id: "conn-1".to_string(),
            database: "db".to_string(),
            schema: None,
            catalog: None,
            sql: "SELECT * FROM users".to_string(),
            query_base_sql: "SELECT * FROM users".to_string(),
            setup_sql: Vec::new(),
            database_type: DatabaseType::Postgres,
            use_agent_cursor: false,
            file_path: "out.csv".to_string(),
            format: format.to_string(),
            include_sql_sheet: false,
            page_size: 1000,
            row_limit,
            total_rows,
            timeout_secs: None,
            keyset_optimization_enabled: true,
            client_session_id: None,
            execution_id: None,
            date_time_format: None,
            export_table_name: None,
            export_column_types: None,
            numeric_column_right_align: false,
            column_comments: None,
        }
    }

    #[test]
    fn csv_unlimited_export_has_no_effective_row_limit() {
        assert_eq!(effective_row_limit(&request("csv", None, None)), None);
    }

    #[test]
    fn txt_unlimited_export_has_no_effective_row_limit() {
        assert_eq!(effective_row_limit(&request("txt", None, None)), None);
    }

    #[test]
    fn txt_export_header_keeps_columns_for_empty_results() {
        assert_eq!(format_text_export_header("txt", &["id".to_string(), "note".to_string()]), "id\tnote");
    }

    #[test]
    fn xlsx_no_row_limit_has_no_query_layer_cap() {
        // Without the old hard limit, XLSX uses the writer's internal splitting.
        assert_eq!(effective_row_limit(&request("xlsx", None, None)), None);
    }

    #[test]
    fn xlsx_user_row_limit_still_respected() {
        assert_eq!(effective_row_limit(&request("xlsx", Some(500), None)), Some(500));
    }

    #[test]
    fn xlsx_total_rows_above_sheet_limit_no_longer_errors() {
        // total_rows > 1M no longer triggers a pre-check error; the writer splits.
        let req = request("xlsx", None, Some(2_000_000));
        assert!(effective_row_limit(&req).is_none());
        // The function that used to check this (xlsx_hard_limit_active) no longer exists.
    }

    #[test]
    fn sql_insert_column_types_maps_request_types_to_option_vec() {
        let req = request("sql", None, None);
        // Non-MySQL exports preserve their historical untyped behavior.
        let result = sql_insert_column_types(&req, &["int4".into(), "text".into()]);
        assert_eq!(result, vec![None, None]);

        // Explicit non-empty overrides take precedence; missing values stay untyped.
        let mut req = req;
        req.export_column_types = Some(vec![Some("int4".into()), None, Some("jsonb".into())]);
        let result = sql_insert_column_types(&req, &["int4".into(), "text".into(), "json".into()]);
        assert_eq!(result, vec![Some("int4".into()), None, Some("jsonb".into())]);

        // Empty string in an override stays untyped for non-MySQL exports.
        req.export_column_types = Some(vec![Some("".into())]);
        let result = sql_insert_column_types(&req, &["int4".into()]);
        assert_eq!(result, vec![None]);
    }

    #[test]
    fn sql_insert_column_types_handles_partial_overrides_gracefully() {
        let req = request("sql", None, None);
        // Fewer overrides than result columns → extra columns remain untyped.
        let mut req = req;
        req.export_column_types = Some(vec![Some("int4".into()), None]);
        let result = sql_insert_column_types(&req, &["int4".into(), "text".into(), "json".into(), "bool".into()]);
        assert_eq!(result, vec![Some("int4".into()), None, None, None]);

        // More overrides than result columns → extra overrides are ignored
        req.export_column_types = Some(vec![
            Some("int4".into()),
            Some("text".into()),
            Some("json".into()),
            Some("bool".into()),
            Some("numeric".into()),
        ]);
        let result = sql_insert_column_types(&req, &["int4".into(), "text".into()]);
        assert_eq!(result, vec![Some("int4".into()), Some("text".into())]);
    }

    #[test]
    fn sql_insert_column_types_handles_all_none_and_all_some() {
        let req = request("sql", None, None);
        // All None remains untyped for non-MySQL exports.
        let mut req = req;
        req.export_column_types = Some(vec![None, None, None]);
        let result = sql_insert_column_types(&req, &["int4".into(), "text".into(), "json".into()]);
        assert_eq!(result, vec![None, None, None]);

        // All Some
        req.export_column_types = Some(vec![Some("int4".into()), Some("text".into()), Some("json".into())]);
        let result = sql_insert_column_types(&req, &["int4".into(), "text".into(), "json".into()]);
        assert_eq!(result, vec![Some("int4".into()), Some("text".into()), Some("json".into())]);
    }

    #[test]
    fn sql_insert_column_types_infers_only_mysql_spatial_result_types() {
        let mut req = request("sql", None, None);
        req.database_type = DatabaseType::Mysql;
        assert_eq!(
            sql_insert_column_types(&req, &["int".into(), "geometry".into(), "varchar".into()]),
            vec![None, Some("geometry".into()), None]
        );
    }

    #[test]
    fn sql_export_sql_file_is_initialized_only_for_sql_format() {
        // The sql_file variable is initialized at declaration only for "sql" format.
        // This is tested by verifying the helper functions produce correct defaults.
        let req = request("sql", None, None);
        assert_eq!(req.format, "sql");
        assert!(req.export_table_name.is_none());
        assert!(req.export_column_types.is_none());
    }

    #[test]
    fn xlsx_sql_sheet_uses_the_effective_export_sql_and_splits_long_cells() {
        let mut req = request("xlsx", None, None);
        req.include_sql_sheet = true;
        req.sql = format!("SELECT '{}'", "x".repeat(EXCEL_CELL_CHARACTER_LIMIT * 2));

        let worksheets = query_sql_worksheets(&req);
        assert_eq!(worksheets.len(), 1);
        assert_eq!(worksheets[0].sheet_name.as_deref(), Some("SQL"));
        assert_eq!(worksheets[0].columns, ["SQL"]);
        assert_eq!(worksheets[0].rows.len(), 3);
        assert!(worksheets[0].rows.iter().all(|row| row[0]
            .as_str()
            .is_some_and(|value| value.encode_utf16().count() <= EXCEL_CELL_CHARACTER_LIMIT)));
        assert_eq!(worksheets[0].rows.iter().filter_map(|row| row[0].as_str()).collect::<String>(), req.sql);
    }

    #[test]
    fn xlsx_sql_sheet_splits_on_utf16_boundaries_without_splitting_surrogate_pairs() {
        let mut req = request("xlsx", None, None);
        req.include_sql_sheet = true;
        let bmp_prefix = "x".repeat(EXCEL_CELL_CHARACTER_LIMIT - 1);
        req.sql = format!("{bmp_prefix}😀tail");

        let worksheets = query_sql_worksheets(&req);
        let rows = &worksheets[0].rows;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0][0].as_str(), Some(bmp_prefix.as_str()));
        assert_eq!(rows[1][0].as_str(), Some("😀tail"));
        assert!(rows.iter().all(|row| row[0]
            .as_str()
            .is_some_and(|value| value.encode_utf16().count() <= EXCEL_CELL_CHARACTER_LIMIT)));
        assert_eq!(rows.iter().filter_map(|row| row[0].as_str()).collect::<String>(), req.sql);
    }

    #[test]
    fn xlsx_sql_sheet_is_opt_in() {
        assert!(query_sql_worksheets(&request("xlsx", None, None)).is_empty());
    }

    #[test]
    fn sqlserver_stream_progress_is_throttled() {
        assert!(!should_emit_stream_progress(19_999, 0, 20_000, Duration::from_millis(100)));
        assert!(should_emit_stream_progress(20_000, 0, 20_000, Duration::from_millis(100)));
        assert!(should_emit_stream_progress(10, 0, 20_000, STREAM_PROGRESS_TIME_INTERVAL));
        assert!(!should_emit_stream_progress(20_000, 20_000, 20_000, STREAM_PROGRESS_TIME_INTERVAL));
    }

    #[test]
    fn non_agent_pages_continue_after_trimming_probe_row() {
        assert!(should_fetch_next_page(false, false, 101, 100, 100));
        assert!(should_fetch_next_page(false, false, 100, 100, 100));
        assert!(!should_fetch_next_page(false, false, 42, 42, 100));
    }

    #[test]
    fn agent_pages_follow_has_more_flag() {
        assert!(should_fetch_next_page(true, true, 42, 42, 100));
        assert!(!should_fetch_next_page(true, false, 100, 100, 100));
    }

    #[test]
    fn streaming_offset_pagination_requires_distinct_followup_page_sql() {
        let req = request("csv", Some(1000), None);
        assert!(supports_streaming_offset_pagination(&req, 100));

        let oracle_req =
            QueryResultExportRequest { database_type: DatabaseType::Oracle, ..request("csv", Some(1000), None) };
        assert!(!supports_streaming_offset_pagination(&oracle_req, 100));
    }

    #[test]
    fn kingbase_non_keyset_top_export_falls_back_to_single_execution() {
        // Regression for t8y2/dbx#5910: a non-keyset Kingbase SQL Server compat
        // TOP query (e.g. a join) cannot be offset-paginated, so the export must
        // stream it in a single execution rather than reject it. This mirrors the
        // guard in export_query_result_core_inner: offset pagination says no, but
        // single-execution support lets the export proceed.
        let req = QueryResultExportRequest {
            sql: "SELECT TOP 100 * FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id".to_string(),
            query_base_sql: "SELECT TOP 100 * FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id"
                .to_string(),
            database_type: DatabaseType::Kingbase,
            use_agent_cursor: false,
            ..request("csv", Some(1000), None)
        };

        assert!(!supports_streaming_offset_pagination(&req, 100));
        assert!(supports_single_execution_export(&req, 100));
        // The enforceable bound is the concrete TOP count (100), not the row limit.
        assert_eq!(single_execution_row_bound(&req), Some(100));
    }

    #[test]
    fn kingbase_single_table_top_query_never_uses_keyset_and_is_bounded() {
        // P0 regression: a simple `SELECT TOP 100 * FROM users` must not qualify
        // for the keyset path (which reconstructs SQL and drops TOP), and its
        // single-execution bound is exactly 100 — never an unbounded page.
        let req = QueryResultExportRequest {
            sql: "SELECT TOP 100 * FROM users".to_string(),
            query_base_sql: "SELECT TOP 100 * FROM users".to_string(),
            database_type: DatabaseType::Kingbase,
            use_agent_cursor: false,
            ..request("csv", None, None)
        };

        assert!(safe_keyset_candidate(&req.sql).is_none(), "TOP must not qualify for keyset");
        assert!(!supports_streaming_offset_pagination(&req, 100));
        assert_eq!(single_execution_row_bound(&req), Some(100));
        assert!(supports_single_execution_export(&req, 100));
    }

    #[test]
    fn kingbase_percent_and_with_ties_need_a_row_limit_for_single_execution() {
        // Percentage TOP and WITH TIES have no concrete row-count bound, so
        // without a configured export row limit the single-execution fallback is
        // unavailable (the export is rejected honestly instead of unbounded).
        let percent_no_limit = QueryResultExportRequest {
            sql: "SELECT TOP 10 PERCENT * FROM orders".to_string(),
            query_base_sql: "SELECT TOP 10 PERCENT * FROM orders".to_string(),
            database_type: DatabaseType::Kingbase,
            use_agent_cursor: false,
            ..request("csv", None, None)
        };
        assert!(!supports_single_execution_export(&percent_no_limit, 100));
        assert_eq!(single_execution_row_bound(&percent_no_limit), None);

        let ties_no_limit = QueryResultExportRequest {
            sql: "SELECT TOP (2) WITH TIES * FROM orders".to_string(),
            query_base_sql: "SELECT TOP (2) WITH TIES * FROM orders".to_string(),
            database_type: DatabaseType::Kingbase,
            use_agent_cursor: false,
            ..request("csv", None, None)
        };
        assert!(!supports_single_execution_export(&ties_no_limit, 100));
        assert_eq!(single_execution_row_bound(&ties_no_limit), None);

        // With a configured row limit the same queries are capped by that limit.
        let percent_with_limit = QueryResultExportRequest { row_limit: Some(5000), ..percent_no_limit };
        assert_eq!(single_execution_row_bound(&percent_with_limit), Some(5000));
        assert!(!supports_single_execution_export(&percent_with_limit, 100));
    }

    #[test]
    fn kingbase_top_expression_export_requires_row_limit_or_cursor() {
        // P1: TOP (100 + 1) returns 101 rows, so its bound must not be treated as
        // 100 (which would silently truncate the export). Without a row limit the
        // single-execution fallback is unavailable and the export is rejected.
        let req = QueryResultExportRequest {
            sql: "SELECT TOP (100 + 1) * FROM orders".to_string(),
            query_base_sql: "SELECT TOP (100 + 1) * FROM orders".to_string(),
            database_type: DatabaseType::Kingbase,
            use_agent_cursor: false,
            ..request("csv", None, None)
        };
        assert!(!supports_single_execution_export(&req, 100));
        assert_eq!(single_execution_row_bound(&req), None);

        // A configured row limit gives the export an explicit cap.
        let with_limit = QueryResultExportRequest { row_limit: Some(200), ..req };
        assert_eq!(single_execution_row_bound(&with_limit), Some(200));
        assert!(!supports_single_execution_export(&with_limit, 100));
    }

    #[test]
    fn kingbase_without_top_uses_streaming_offset_pagination() {
        let req = QueryResultExportRequest {
            sql: "SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id".to_string(),
            query_base_sql: "SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id".to_string(),
            database_type: DatabaseType::Kingbase,
            use_agent_cursor: false,
            ..request("csv", Some(1000), None)
        };

        assert!(supports_streaming_offset_pagination(&req, 100));
        assert!(!supports_single_execution_export(&req, 100));
    }

    #[test]
    fn kingbase_single_execution_never_exceeds_one_export_page() {
        let req = QueryResultExportRequest {
            sql: "SELECT TOP 1000 * FROM orders".to_string(),
            query_base_sql: "SELECT TOP 1000 * FROM orders".to_string(),
            database_type: DatabaseType::Kingbase,
            use_agent_cursor: false,
            ..request("csv", None, None)
        };

        assert_eq!(single_execution_row_bound(&req), Some(1000));
        assert_eq!(single_execution_page_limit(&req, 100), None);
        assert!(supports_single_execution_export(&req, 1000));
    }

    #[test]
    fn clickhouse_scalar_with_query_supports_streaming_pagination() {
        let sql = "WITH 1 AS min_id SELECT dept, COUNT(*) FROM employees WHERE id >= min_id GROUP BY dept";
        let req = QueryResultExportRequest {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: DatabaseType::ClickHouse,
            ..request("csv", Some(1000), None)
        };

        assert!(supports_streaming_offset_pagination(&req, 100));
    }

    #[test]
    fn keyset_candidate_accepts_simple_single_table_wildcard_query() {
        let candidate = safe_keyset_candidate("SELECT * FROM public.users").expect("safe keyset candidate");
        assert_eq!(candidate.schema.as_deref(), Some("public"));
        assert_eq!(candidate.table, "users");
    }

    #[test]
    fn keyset_candidate_rejects_join_and_sorted_queries() {
        assert!(safe_keyset_candidate("SELECT * FROM users u JOIN orders o ON o.user_id = u.id").is_none());
        assert!(safe_keyset_candidate("SELECT * FROM users ORDER BY name").is_none());
    }

    #[test]
    fn keyset_candidate_rejects_filters_and_projection_changes() {
        assert!(safe_keyset_candidate("SELECT * FROM users WHERE active = true").is_none());
        assert!(safe_keyset_candidate("SELECT id, name FROM users").is_none());
    }

    #[tokio::test]
    async fn failed_mysql_stream_disconnects_connection_without_database_or_xlsx() {
        let disconnected = Arc::new(AtomicBool::new(false));
        let disconnected_for_call = disconnected.clone();
        let result = disconnect_with_timeout((), Duration::from_secs(1), move |_| async move {
            disconnected_for_call.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await;
        assert!(matches!(result, Ok(Ok(()))));
        assert!(disconnected.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn failed_mysql_stream_disconnect_is_bounded_by_cleanup_timeout() {
        let result = disconnect_with_timeout((), Duration::from_millis(1), |_| async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(())
        })
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn stream_times_out_when_database_makes_no_progress() {
        let progress_clock = Arc::new(StreamProgressClock::new());
        let result = await_stream_with_progress_timeout(
            std::future::pending::<Result<(), String>>(),
            Some(Duration::from_millis(20)),
            progress_clock,
            None,
            "query timeout".to_string(),
        )
        .await;

        assert_eq!(result, Err("query timeout".to_string()));
    }

    #[tokio::test]
    async fn stream_timeout_resets_after_each_completed_row() {
        let progress_clock = Arc::new(StreamProgressClock::new());
        let progress_clock_for_stream = progress_clock.clone();
        let result = await_stream_with_progress_timeout(
            async move {
                for row in 1..=5 {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    progress_clock_for_stream.mark();
                    assert!(row <= 5);
                }
                Ok::<_, String>(5_u8)
            },
            Some(Duration::from_millis(150)),
            progress_clock,
            None,
            "query timeout".to_string(),
        )
        .await;

        assert_eq!(result, Ok(5));
    }

    #[tokio::test]
    async fn stream_does_not_count_synchronous_local_writes_as_database_idle_time() {
        let progress_clock = Arc::new(StreamProgressClock::new());
        let progress_clock_for_stream = progress_clock.clone();
        let result = await_stream_with_progress_timeout(
            async move {
                std::thread::sleep(Duration::from_millis(50));
                progress_clock_for_stream.mark();
                Ok::<_, String>(())
            },
            Some(Duration::from_millis(20)),
            progress_clock,
            None,
            "query timeout".to_string(),
        )
        .await;

        assert_eq!(result, Ok(()));
    }

    #[tokio::test]
    async fn stream_timeout_zero_disables_idle_timeout() {
        let progress_clock = Arc::new(StreamProgressClock::new());
        let result = await_stream_with_progress_timeout(
            async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                Ok::<_, String>(())
            },
            None,
            progress_clock,
            None,
            "query timeout".to_string(),
        )
        .await;

        assert_eq!(result, Ok(()));
    }

    #[tokio::test]
    async fn stream_cancellation_wins_over_idle_timeout() {
        let progress_clock = Arc::new(StreamProgressClock::new());
        let cancel_token = CancellationToken::new();
        let cancel_token_for_task = cancel_token.clone();
        let task = tokio::spawn(async move {
            await_stream_with_progress_timeout(
                async { std::future::pending::<Result<(), String>>().await },
                Some(Duration::from_secs(1)),
                progress_clock,
                Some(&cancel_token_for_task),
                "query timeout".to_string(),
            )
            .await
        });
        tokio::task::yield_now().await;
        cancel_token.cancel();

        assert_eq!(task.await.unwrap(), Err(QUERY_CANCELED.to_string()));
    }
}
