use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use crate::connection::{AppState, PoolKind};
use crate::csv_export::{format_query_result_csv, format_query_result_csv_rows};
use crate::database_export::is_export_cancelled;
pub use crate::database_export::ExportStatus;
use crate::models::connection::DatabaseType;
use crate::query::{
    canceled_error, close_query_session, execute_sql_statement_with_options, operation_budget_for_pool_key,
    QueryExecutionOptions, QUERY_CANCELED,
};
use crate::query_result_sql::{
    build_query_pagination_execution_plan, QueryPagination, QueryPaginationExecutionPlanOptions,
};
use crate::table_export::TableExportProgress;
use crate::transfer::keyset_pagination_sql;
use crate::xlsx_export::{finish_streaming_xlsx_workbook, start_streaming_xlsx_workbook};
use serde_json::Value;
use sqlparser::ast::{GroupByExpr, ObjectNamePart, OrderByKind, SelectItem, SetExpr, Statement, TableFactor};
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::Parser;
use tokio_util::sync::CancellationToken;

const AGENT_UNBOUNDED_ROW_LIMIT: usize = i32::MAX as usize;
pub const XLSX_MAX_DATA_ROWS: usize = 1_048_575;
const XLSX_ROW_LIMIT_ERROR: &str = "XLSX 最多支持 1,048,575 行数据，请改用 CSV 导出完整结果。";
const STREAMING_PAGINATION_UNSUPPORTED_ERROR: &str = "当前查询暂不支持流式导出，请简化查询或使用受支持的驱动。";
const AGENT_SESSION_MISSING_ERROR: &str = "查询结果流式导出需要驱动返回结果集会话，但当前驱动未返回 session_id。";
const STREAM_PROGRESS_TIME_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultExportRequest {
    pub export_id: String,
    pub connection_id: String,
    pub database: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub sql: String,
    pub query_base_sql: String,
    pub database_type: DatabaseType,
    #[serde(default)]
    pub use_agent_cursor: bool,
    pub file_path: String,
    pub format: String,
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
}

fn progress(
    request: &QueryResultExportRequest,
    rows_exported: u64,
    status: ExportStatus,
    error_message: Option<String>,
) -> TableExportProgress {
    let total_rows = request.total_rows.map(|total| {
        let format = request.format.to_lowercase();
        let limit = effective_row_limit(&format, request);
        limit.map_or(total, |limit| total.min(limit as u64))
    });
    TableExportProgress {
        export_id: request.export_id.clone(),
        table_name: String::new(),
        rows_exported,
        total_rows,
        status,
        error_message,
    }
}

fn effective_row_limit(format: &str, request: &QueryResultExportRequest) -> Option<usize> {
    if format == "xlsx" {
        Some(request.row_limit.map_or(XLSX_MAX_DATA_ROWS, |limit| limit.min(XLSX_MAX_DATA_ROWS)))
    } else {
        request.row_limit
    }
}

fn xlsx_hard_limit_active(format: &str, request: &QueryResultExportRequest) -> bool {
    format == "xlsx" && request.row_limit.map_or(true, |limit| limit > XLSX_MAX_DATA_ROWS)
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
    if format != "csv" && format != "xlsx" {
        return Err(format!("Unsupported streaming query-result export format: {format}"));
    }

    let page_size = request.page_size.max(1);
    let effective_row_limit = effective_row_limit(&format, request);
    let xlsx_hard_limit_active = xlsx_hard_limit_active(&format, request);
    if xlsx_hard_limit_active && request.total_rows.is_some_and(|total| total > XLSX_MAX_DATA_ROWS as u64) {
        return Err(XLSX_ROW_LIMIT_ERROR.to_string());
    }

    let agent_max_rows = if xlsx_hard_limit_active {
        XLSX_MAX_DATA_ROWS + 1
    } else {
        effective_row_limit.unwrap_or(AGENT_UNBOUNDED_ROW_LIMIT)
    }
    .max(1);

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

    let mut csv_file = if format == "csv" {
        Some(BufWriter::new(File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?))
    } else {
        None
    };
    if let Some(file) = csv_file.as_mut() {
        file.write_all(b"\xEF\xBB\xBF").map_err(|e| format!("Failed to write BOM: {e}"))?;
    }

    let mut xlsx = None;
    let mut columns: Vec<String> = Vec::new();
    let mut rows_exported: u64 = 0;
    let mut offset: usize = 0;
    let mut wrote_csv_header = false;
    let mut keyset_plan = build_keyset_plan(state, request).await;
    if keyset_plan.is_none() && !request.use_agent_cursor && !supports_streaming_offset_pagination(request, page_size) {
        return Err(STREAMING_PAGINATION_UNSUPPORTED_ERROR.to_string());
    }

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
        let this_page = remaining.map_or(page_size, |rem| rem.min(page_size)).max(1);
        let fetch_limit = if xlsx_hard_limit_active && remaining.is_some_and(|rem| rem <= page_size) {
            this_page.saturating_add(1)
        } else {
            this_page
        };

        let (sql_to_execute, plan_limit, use_agent_result_session) = if let Some(plan) = keyset_plan.as_ref() {
            (
                keyset_pagination_sql(
                    &plan.columns,
                    &plan.table,
                    &plan.schema,
                    &request.database_type,
                    &plan.primary_keys,
                    &plan.last_pk_values,
                    fetch_limit,
                ),
                fetch_limit,
                false,
            )
        } else {
            let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                sql: request.sql.clone(),
                query_base_sql: request.query_base_sql.clone(),
                database_type: Some(request.database_type),
                pagination: QueryPagination { limit: fetch_limit, offset, session_id: session_id.clone() },
                use_agent_cursor: request.use_agent_cursor,
                first_page_uses_actual_sql: true,
            });
            let Some(plan_limit) = plan.page_limit else {
                return Err("Failed to build query pagination plan for export".to_string());
            };
            (plan.sql_to_execute, plan_limit, plan.use_agent_result_session)
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
                ..Default::default()
            }
        } else {
            QueryExecutionOptions {
                max_rows: Some(plan_limit),
                fetch_size: Some(plan_limit),
                timeout_secs: request.timeout_secs,
                client_session_id: request.client_session_id.clone(),
                execution_id: request.execution_id.clone(),
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
        }
        let fetched_row_count = result.rows.len();
        if xlsx_hard_limit_active {
            let remaining_rows = XLSX_MAX_DATA_ROWS.saturating_sub(rows_exported as usize);
            if fetched_row_count > remaining_rows {
                return Err(XLSX_ROW_LIMIT_ERROR.to_string());
            }
        }
        if result.rows.len() > this_page {
            result.rows.truncate(this_page);
        }
        let row_count = result.rows.len();

        if format == "csv" {
            if let Some(file) = csv_file.as_mut() {
                if !wrote_csv_header {
                    let csv = format_query_result_csv(&columns, &result.rows);
                    file.write_all(csv.as_bytes()).map_err(|e| format!("Failed to write CSV: {e}"))?;
                    wrote_csv_header = true;
                } else if row_count > 0 {
                    let rows_csv = format_query_result_csv_rows(&result.rows);
                    write!(file, "\n{rows_csv}").map_err(|e| format!("Failed to write CSV rows: {e}"))?;
                }
            }
        } else {
            if xlsx.is_none() {
                let xlsx_file =
                    File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                xlsx = Some(start_streaming_xlsx_workbook(BufWriter::new(xlsx_file), Some("Result"), &columns)?);
            }
            if let Some(writer) = xlsx.as_mut() {
                for row in &result.rows {
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
        let should_continue =
            should_fetch_next_page(use_agent_result_session, result.has_more, fetched_row_count, row_count, plan_limit);
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

    if format == "csv" {
        if !wrote_csv_header {
            let csv = format_query_result_csv(&columns, &[]);
            if let Some(file) = csv_file.as_mut() {
                file.write_all(csv.as_bytes()).map_err(|e| format!("Failed to write CSV: {e}"))?;
            }
        }
        if let Some(file) = csv_file.as_mut() {
            file.flush().map_err(|e| format!("Failed to flush CSV file: {e}"))?;
        }
    } else if let Some(writer) = xlsx {
        let mut buf =
            finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
        buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
    } else {
        let xlsx_file = File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
        let writer = start_streaming_xlsx_workbook(BufWriter::new(xlsx_file), Some("Result"), &columns)?;
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

    let xlsx_hard_limit_active = xlsx_hard_limit_active(format, request);
    let row_limit = effective_row_limit(format, request);
    let stream_row_limit =
        if xlsx_hard_limit_active { row_limit.map(|limit| limit.saturating_add(1)) } else { row_limit };
    let progress_row_interval = request.page_size.max(1) as u64;
    let mut columns: Vec<String> = Vec::new();
    let mut rows_exported = 0_u64;
    let mut last_progress_rows = 0_u64;
    let mut last_progress_at = Instant::now();
    let mut csv_file = if format == "csv" {
        let mut file =
            BufWriter::new(File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?);
        file.write_all(b"\xEF\xBB\xBF").map_err(|e| format!("Failed to write BOM: {e}"))?;
        Some(file)
    } else {
        None
    };
    let mut xlsx = None;
    let budget = operation_budget_for_pool_key(state, &pool_key, query_export_timeout(request.timeout_secs)).await;
    let cancel_context = state.get_postgres_cancel_context(&pool_key).await;

    crate::db::postgres::stream_select_query_with_cancel(
        &pool,
        request.schema.as_deref(),
        &request.sql,
        stream_row_limit,
        cancel_token,
        budget,
        cancel_context,
        |item| {
            match item {
                crate::db::postgres::PostgresQueryStreamItem::Columns { columns: stream_columns, .. } => {
                    columns = stream_columns;
                    if let Some(file) = csv_file.as_mut() {
                        let csv = format_query_result_csv(&columns, &[]);
                        let header = csv.strip_suffix('\n').unwrap_or(&csv);
                        file.write_all(header.as_bytes()).map_err(|e| format!("Failed to write CSV: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx =
                            Some(start_streaming_xlsx_workbook(BufWriter::new(xlsx_file), Some("Result"), &columns)?);
                    }
                }
                crate::db::postgres::PostgresQueryStreamItem::Row(row) => {
                    if xlsx_hard_limit_active && rows_exported as usize >= XLSX_MAX_DATA_ROWS {
                        return Err(XLSX_ROW_LIMIT_ERROR.to_string());
                    }
                    if let Some(file) = csv_file.as_mut() {
                        let rows_csv = format_query_result_csv_rows(std::slice::from_ref(&row));
                        write!(file, "\n{rows_csv}").map_err(|e| format!("Failed to write CSV rows: {e}"))?;
                    } else if let Some(writer) = xlsx.as_mut() {
                        writer.write_row(&row).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx =
                            Some(start_streaming_xlsx_workbook(BufWriter::new(xlsx_file), Some("Result"), &columns)?);
                        if let Some(writer) = xlsx.as_mut() {
                            writer.write_row(&row).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
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
    .await?;

    if rows_exported != last_progress_rows {
        on_progress(progress(request, rows_exported, ExportStatus::Running, None));
    }
    on_progress(progress(request, rows_exported, ExportStatus::Writing, None));
    if let Some(file) = csv_file.as_mut() {
        file.flush().map_err(|e| format!("Failed to flush CSV file: {e}"))?;
    }
    if let Some(writer) = xlsx {
        let mut buf =
            finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
        buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
    } else if format == "xlsx" {
        let xlsx_file = File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
        let writer = start_streaming_xlsx_workbook(BufWriter::new(xlsx_file), Some("Result"), &columns)?;
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

    let (mysql_dialect, read_only_connection_name) = {
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
            config.filter(|config| config.read_only).map(|config| config.name.clone()),
        )
    };
    if let Some(name) = read_only_connection_name {
        crate::query_execution_sql::check_read_only(&request.sql, &name)?;
    }

    let xlsx_hard_limit_active = xlsx_hard_limit_active(format, request);
    let row_limit = effective_row_limit(format, request);
    let stream_row_limit =
        if xlsx_hard_limit_active { row_limit.map(|limit| limit.saturating_add(1)) } else { row_limit };
    let progress_row_interval = request.page_size.max(1) as u64;
    let mut columns: Vec<String> = Vec::new();
    let mut rows_exported = 0_u64;
    let mut last_progress_rows = 0_u64;
    let mut last_progress_at = Instant::now();
    let mut csv_file = if format == "csv" {
        let mut file =
            BufWriter::new(File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?);
        file.write_all(b"\xEF\xBB\xBF").map_err(|e| format!("Failed to write BOM: {e}"))?;
        Some(file)
    } else {
        None
    };
    let mut xlsx = None;
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

    let stream_future = crate::db::mysql::stream_query_result_on_conn(
        &mut conn,
        &request.sql,
        bare,
        stream_row_limit,
        mysql_dialect,
        &export_cancelled,
        |item| {
            if export_cancelled.load(Ordering::SeqCst)
                || cancel_token.as_ref().is_some_and(|token| token.is_cancelled())
            {
                return Err(canceled_error());
            }
            match item {
                crate::db::mysql::MySqlQueryStreamItem::Columns { columns: stream_columns, .. } => {
                    columns = stream_columns;
                    if let Some(file) = csv_file.as_mut() {
                        let csv = format_query_result_csv(&columns, &[]);
                        let header = csv.strip_suffix('\n').unwrap_or(&csv);
                        file.write_all(header.as_bytes()).map_err(|e| format!("Failed to write CSV: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx =
                            Some(start_streaming_xlsx_workbook(BufWriter::new(xlsx_file), Some("Result"), &columns)?);
                    }
                }
                crate::db::mysql::MySqlQueryStreamItem::Row(row) => {
                    if xlsx_hard_limit_active && rows_exported as usize >= XLSX_MAX_DATA_ROWS {
                        return Err(XLSX_ROW_LIMIT_ERROR.to_string());
                    }
                    if let Some(file) = csv_file.as_mut() {
                        let rows_csv = format_query_result_csv_rows(std::slice::from_ref(&row));
                        write!(file, "\n{rows_csv}").map_err(|e| format!("Failed to write CSV rows: {e}"))?;
                    } else if let Some(writer) = xlsx.as_mut() {
                        writer.write_row(&row).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx =
                            Some(start_streaming_xlsx_workbook(BufWriter::new(xlsx_file), Some("Result"), &columns)?);
                        if let Some(writer) = xlsx.as_mut() {
                            writer.write_row(&row).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
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
    );
    let stream_result = match query_timeout {
        Some(timeout) => match tokio::time::timeout(timeout, stream_future).await {
            Ok(result) => result,
            Err(_) => {
                let _ = crate::db::mysql::kill_query_with_opts(kill_opts, mysql_connection_id).await;
                Err(format!("Query timed out after {} seconds", timeout.as_secs()))
            }
        },
        None => stream_future.await,
    };
    watcher_done.cancel();

    if let Err(error) = stream_result {
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
    if let Some(file) = csv_file.as_mut() {
        file.flush().map_err(|e| format!("Failed to flush CSV file: {e}"))?;
    }
    if let Some(writer) = xlsx {
        let mut buf =
            finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
        buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
    } else if format == "xlsx" {
        let xlsx_file = File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
        let writer = start_streaming_xlsx_workbook(BufWriter::new(xlsx_file), Some("Result"), &columns)?;
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

    let xlsx_hard_limit_active = xlsx_hard_limit_active(format, request);
    let row_limit = effective_row_limit(format, request);
    let stream_row_limit =
        if xlsx_hard_limit_active { row_limit.map(|limit| limit.saturating_add(1)) } else { row_limit };
    let progress_row_interval = request.page_size.max(1) as u64;
    let mut columns: Vec<String> = Vec::new();
    let mut rows_exported = 0_u64;
    let mut last_progress_rows = 0_u64;
    let mut last_progress_at = Instant::now();
    let mut csv_file = if format == "csv" {
        let mut file =
            BufWriter::new(File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?);
        file.write_all(b"\xEF\xBB\xBF").map_err(|e| format!("Failed to write BOM: {e}"))?;
        Some(file)
    } else {
        None
    };
    let mut xlsx = None;
    let clickhouse_database = if database.is_empty() { "default" } else { database };

    let stream_future = crate::db::clickhouse_driver::stream_query_with_max_rows(
        &client,
        clickhouse_database,
        &request.sql,
        stream_row_limit,
        cancel_token.clone(),
        |item| {
            match item {
                crate::db::clickhouse_driver::ClickHouseQueryStreamItem::Columns {
                    columns: stream_columns, ..
                } => {
                    columns = stream_columns;
                    if let Some(file) = csv_file.as_mut() {
                        let csv = format_query_result_csv(&columns, &[]);
                        let header = csv.strip_suffix('\n').unwrap_or(&csv);
                        file.write_all(header.as_bytes()).map_err(|e| format!("Failed to write CSV: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx =
                            Some(start_streaming_xlsx_workbook(BufWriter::new(xlsx_file), Some("Result"), &columns)?);
                    }
                }
                crate::db::clickhouse_driver::ClickHouseQueryStreamItem::Row(row) => {
                    if xlsx_hard_limit_active && rows_exported as usize >= XLSX_MAX_DATA_ROWS {
                        return Err(XLSX_ROW_LIMIT_ERROR.to_string());
                    }
                    if let Some(file) = csv_file.as_mut() {
                        let rows_csv = format_query_result_csv_rows(std::slice::from_ref(&row));
                        write!(file, "\n{rows_csv}").map_err(|e| format!("Failed to write CSV rows: {e}"))?;
                    } else if let Some(writer) = xlsx.as_mut() {
                        writer.write_row(&row).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx =
                            Some(start_streaming_xlsx_workbook(BufWriter::new(xlsx_file), Some("Result"), &columns)?);
                        if let Some(writer) = xlsx.as_mut() {
                            writer.write_row(&row).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
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
    );
    let stream_result = match query_export_timeout(request.timeout_secs) {
        Some(timeout) => match tokio::time::timeout(timeout, stream_future).await {
            Ok(result) => result,
            Err(_) => Err(format!("Query timed out after {} seconds", timeout.as_secs())),
        },
        None => stream_future.await,
    };

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
    if let Some(file) = csv_file.as_mut() {
        file.flush().map_err(|e| format!("Failed to flush CSV file: {e}"))?;
    }
    if let Some(writer) = xlsx {
        let mut buf =
            finish_streaming_xlsx_workbook(writer).map_err(|e| format!("Failed to finalize XLSX file: {e}"))?;
        buf.flush().map_err(|e| format!("Failed to flush XLSX file: {e}"))?;
    } else if format == "xlsx" {
        let xlsx_file = File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
        let writer = start_streaming_xlsx_workbook(BufWriter::new(xlsx_file), Some("Result"), &columns)?;
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

    let xlsx_hard_limit_active = xlsx_hard_limit_active(format, request);
    let row_limit = effective_row_limit(format, request);
    let stream_row_limit =
        if xlsx_hard_limit_active { row_limit.map(|limit| limit.saturating_add(1)) } else { row_limit };
    let mut columns: Vec<String> = Vec::new();
    let mut rows_exported = 0_u64;
    let mut last_progress_rows = 0_u64;
    let mut last_progress_at = Instant::now();
    let progress_row_interval = request.page_size.max(1) as u64;
    let mut csv_file = if format == "csv" {
        let mut file =
            BufWriter::new(File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?);
        file.write_all(b"\xEF\xBB\xBF").map_err(|e| format!("Failed to write BOM: {e}"))?;
        Some(file)
    } else {
        None
    };
    let mut xlsx = None;

    let mut client = match cancel_token.as_ref() {
        Some(token) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => return Err(canceled_error()),
                guard = client.lock() => guard,
            }
        }
        None => client.lock().await,
    };

    let stream_future = crate::db::sqlserver::stream_first_result_set(
        &mut client,
        &request.sql,
        stream_row_limit,
        cancel_token.clone(),
        |item| {
            match item {
                crate::db::sqlserver::SqlServerStreamItem::Columns(stream_columns) => {
                    columns = stream_columns.to_vec();
                    if let Some(file) = csv_file.as_mut() {
                        let csv = format_query_result_csv(&columns, &[]);
                        let header = csv.strip_suffix('\n').unwrap_or(&csv);
                        file.write_all(header.as_bytes()).map_err(|e| format!("Failed to write CSV: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx =
                            Some(start_streaming_xlsx_workbook(BufWriter::new(xlsx_file), Some("Result"), &columns)?);
                    }
                }
                crate::db::sqlserver::SqlServerStreamItem::Row(row) => {
                    if xlsx_hard_limit_active && rows_exported as usize >= XLSX_MAX_DATA_ROWS {
                        return Err(XLSX_ROW_LIMIT_ERROR.to_string());
                    }
                    if let Some(file) = csv_file.as_mut() {
                        let rows_csv = format_query_result_csv_rows(&[row.to_vec()]);
                        write!(file, "\n{rows_csv}").map_err(|e| format!("Failed to write CSV rows: {e}"))?;
                    } else if let Some(writer) = xlsx.as_mut() {
                        writer.write_row(row).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
                    } else {
                        let xlsx_file =
                            File::create(&request.file_path).map_err(|e| format!("Failed to create XLSX file: {e}"))?;
                        xlsx =
                            Some(start_streaming_xlsx_workbook(BufWriter::new(xlsx_file), Some("Result"), &columns)?);
                        if let Some(writer) = xlsx.as_mut() {
                            writer.write_row(row).map_err(|e| format!("Failed to write XLSX row: {e}"))?;
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
    );
    match query_export_timeout(request.timeout_secs) {
        Some(timeout) => tokio::time::timeout(timeout, stream_future)
            .await
            .map_err(|_| format!("Query timed out after {} seconds", timeout.as_secs()))??,
        None => stream_future.await?,
    };
    drop(client);

    if rows_exported != last_progress_rows {
        on_progress(progress(request, rows_exported, ExportStatus::Running, None));
    }
    on_progress(progress(request, rows_exported, ExportStatus::Writing, None));
    if let Some(file) = csv_file.as_mut() {
        file.flush().map_err(|e| format!("Failed to flush CSV file: {e}"))?;
    }
    if let Some(writer) = xlsx {
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

    fn request(format: &str, row_limit: Option<usize>, total_rows: Option<u64>) -> QueryResultExportRequest {
        QueryResultExportRequest {
            export_id: "export-1".to_string(),
            connection_id: "conn-1".to_string(),
            database: "db".to_string(),
            schema: None,
            sql: "SELECT * FROM users".to_string(),
            query_base_sql: "SELECT * FROM users".to_string(),
            database_type: DatabaseType::Postgres,
            use_agent_cursor: false,
            file_path: "out.csv".to_string(),
            format: format.to_string(),
            page_size: 1000,
            row_limit,
            total_rows,
            timeout_secs: None,
            keyset_optimization_enabled: true,
            client_session_id: None,
            execution_id: None,
        }
    }

    #[test]
    fn csv_unlimited_export_has_no_effective_row_limit() {
        assert_eq!(effective_row_limit("csv", &request("csv", None, None)), None);
    }

    #[test]
    fn xlsx_unlimited_export_uses_excel_hard_limit() {
        assert_eq!(effective_row_limit("xlsx", &request("xlsx", None, None)), Some(XLSX_MAX_DATA_ROWS));
    }

    #[test]
    fn xlsx_row_limit_caps_to_excel_hard_limit() {
        assert_eq!(
            effective_row_limit("xlsx", &request("xlsx", Some(XLSX_MAX_DATA_ROWS + 10), None)),
            Some(XLSX_MAX_DATA_ROWS)
        );
    }

    #[test]
    fn xlsx_known_total_above_hard_limit_errors_before_export() {
        let req = request("xlsx", None, Some(XLSX_MAX_DATA_ROWS as u64 + 1));
        assert!(xlsx_hard_limit_active("xlsx", &req));
        assert!(req.total_rows.is_some_and(|total| total > XLSX_MAX_DATA_ROWS as u64));
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
}
