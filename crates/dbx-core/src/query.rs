#[cfg(feature = "duckdb-bundled")]
use chrono::{DateTime, Duration as ChronoDuration, NaiveDate, NaiveDateTime, NaiveTime, Utc};
#[cfg(feature = "duckdb-bundled")]
use duckdb::types::{TimeUnit, Value, ValueRef};
use mysql_async::prelude::Queryable;
use sqlparser::ast::{visit_relations_mut, Ident, ObjectName, ObjectNamePart, ObjectType, Statement};
use sqlparser::dialect::{GenericDialect, PostgreSqlDialect};
use sqlparser::parser::Parser;
use std::collections::HashSet;
use std::future::Future;
use std::ops::ControlFlow;
use std::time::Duration;
#[cfg(feature = "duckdb-bundled")]
use tokio::task::JoinHandle;
#[cfg(feature = "duckdb-bundled")]
use tokio::time::sleep;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::connection::{AppState, PoolKind};
use crate::database_capabilities;
use crate::db;
use crate::models::connection::DatabaseType;
#[cfg(feature = "duckdb-bundled")]
use crate::sql::starts_with_duckdb_result_sql_keyword;
use crate::sql::{split_sql_batches, split_sql_statements};

pub const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_ROWS: usize = 10000;
pub const QUERY_CANCELED: &str = "Query canceled";
#[cfg(feature = "duckdb-bundled")]
const DUCKDB_INTERRUPT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolErrorAction {
    Keep,
    Discard,
    ReconnectAndRetry,
}

/// Check read-only protection for a connection, blocking write SQL statements.
/// Only clones the connection name when read-only mode is active, avoiding
/// unnecessary allocations otherwise.
/// Uses config_for_pool_key to correctly resolve configs when pool_key includes
/// a database suffix (e.g., "prod:app" → config stored under "prod").
pub async fn check_read_only_for_connection(state: &AppState, pool_key: &str, sql: &str) -> Result<(), String> {
    let conn_name = {
        let configs = state.configs.read().await;
        crate::connection::config_for_pool_key(pool_key, &configs).filter(|c| c.read_only).map(|c| c.name.clone())
    };
    if let Some(name) = conn_name {
        crate::query_execution_sql::check_read_only(sql, &name)?;
    }
    Ok(())
}

/// Check read-only protection for a connection across multiple SQL statements.
pub async fn check_read_only_for_connection_multi(
    state: &AppState,
    pool_key: &str,
    statements: &[impl AsRef<str>],
) -> Result<(), String> {
    let conn_name = {
        let configs = state.configs.read().await;
        crate::connection::config_for_pool_key(pool_key, &configs).filter(|c| c.read_only).map(|c| c.name.clone())
    };
    if let Some(name) = conn_name {
        for sql in statements {
            crate::query_execution_sql::check_read_only(sql.as_ref(), &name)?;
        }
    }
    Ok(())
}

/// Check whether a connection has read-only mode enabled, returning the connection name if so.
/// This uses connection_id directly (not pool_key), so it is safe to call at command entry points
/// before any pool key is constructed.
pub async fn connection_readonly_name(state: &AppState, connection_id: &str) -> Option<String> {
    state.configs.read().await.get(connection_id).filter(|c| c.read_only).map(|c| c.name.clone())
}

async fn connection_is_mongodb(state: &AppState, connection_id: &str) -> bool {
    let configs = state.configs.read().await;
    configs.get(connection_id).is_some_and(|config| config.db_type == DatabaseType::MongoDb)
}

async fn connection_database_type(state: &AppState, connection_id: &str) -> Option<DatabaseType> {
    let configs = state.configs.read().await;
    configs.get(connection_id).map(|config| config.db_type)
}

async fn connection_mysql_query_dialect(state: &AppState, connection_id: &str) -> db::mysql::MySqlQueryDialect {
    let configs = state.configs.read().await;
    configs
        .get(connection_id)
        .map(|config| db::mysql::MySqlQueryDialect::for_connection(config.db_type, config.driver_profile.as_deref()))
        .unwrap_or_default()
}

async fn connection_database_type_for_pool_key(state: &AppState, pool_key: &str) -> Option<DatabaseType> {
    let configs = state.configs.read().await;
    configs
        .iter()
        .filter(|(connection_id, _)| {
            pool_key.strip_prefix(connection_id.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with(':'))
        })
        .max_by_key(|(connection_id, _)| connection_id.len())
        .map(|(_, config)| config.db_type)
}

fn schema_for_execution_context(db_type: Option<DatabaseType>, schema: Option<&str>) -> Option<&str> {
    if matches!(db_type, Some(DatabaseType::Iris)) {
        None
    } else {
        schema
    }
}

fn sql_for_execution_context(db_type: Option<DatabaseType>, sql: &str, schema: Option<&str>) -> String {
    if matches!(db_type, Some(DatabaseType::Iris)) {
        if let Some(schema) = schema.map(str::trim).filter(|schema| !schema.is_empty()) {
            return qualify_iris_unqualified_dml(sql, schema).unwrap_or_else(|| sql.to_string());
        }
    }
    sql.to_string()
}

fn qualify_iris_unqualified_dml(sql: &str, schema: &str) -> Option<String> {
    let dialect = GenericDialect {};
    let mut statements = Parser::parse_sql(&dialect, sql).ok()?;
    if statements.is_empty() {
        return None;
    }

    let mut changed = false;
    for statement in &mut statements {
        if !iris_statement_uses_schema_search_path(statement) {
            continue;
        }
        let cte_names = iris_statement_cte_names(statement);
        let _ = visit_relations_mut(statement, |name| {
            if qualify_iris_relation_name(name, schema, &cte_names) {
                changed = true;
            }
            ControlFlow::<()>::Continue(())
        });
    }

    changed.then(|| statements.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "))
}

fn iris_statement_uses_schema_search_path(statement: &Statement) -> bool {
    matches!(
        statement,
        Statement::Query(_)
            | Statement::Insert(_)
            | Statement::Update(_)
            | Statement::Delete(_)
            | Statement::Truncate(_)
    )
}

fn qualify_iris_relation_name(name: &mut ObjectName, schema: &str, cte_names: &HashSet<String>) -> bool {
    let [ObjectNamePart::Identifier(table)] = name.0.as_slice() else {
        return false;
    };
    if cte_names.contains(&table.value.to_ascii_uppercase()) {
        return false;
    }

    let table = table.clone();
    name.0 = vec![ObjectNamePart::Identifier(Ident::with_quote('"', schema)), ObjectNamePart::Identifier(table)];
    true
}

fn iris_statement_cte_names(statement: &Statement) -> HashSet<String> {
    let mut names = HashSet::new();
    collect_iris_statement_cte_names(statement, &mut names);
    names
}

fn collect_iris_statement_cte_names(statement: &Statement, names: &mut HashSet<String>) {
    match statement {
        Statement::Query(query) => collect_iris_query_cte_names(query, names),
        Statement::Insert(insert) => {
            if let Some(source) = &insert.source {
                collect_iris_query_cte_names(source, names);
            }
        }
        _ => {}
    }
}

fn collect_iris_query_cte_names(query: &sqlparser::ast::Query, names: &mut HashSet<String>) {
    if let Some(with) = &query.with {
        for cte in &with.cte_tables {
            names.insert(cte.alias.name.value.to_ascii_uppercase());
            collect_iris_query_cte_names(&cte.query, names);
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct QueryExecutionOptions {
    pub max_rows: Option<usize>,
    pub fetch_size: Option<usize>,
    pub page_size: Option<usize>,
    pub result_session_id: Option<String>,
    pub client_session_id: Option<String>,
    /// Query timeout in seconds. `None` uses the default (30s).
    /// `Some(0)` disables the timeout entirely.
    pub timeout_secs: Option<u64>,
    pub execution_id: Option<String>,
}

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(MAX_ROWS).max(1)
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_execute(con: &duckdb::Connection, sql: &str) -> Result<db::QueryResult, String> {
    duckdb_execute_with_max_rows(con, sql, None)
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_value_to_json(row: &duckdb::Row<'_>, idx: usize) -> serde_json::Value {
    let Ok(value_ref) = row.get_ref(idx) else {
        return serde_json::Value::Null;
    };
    match value_ref {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Boolean(b) => serde_json::Value::Bool(b),
        ValueRef::TinyInt(i) => serde_json::Value::Number((i as i64).into()),
        ValueRef::SmallInt(i) => serde_json::Value::Number((i as i64).into()),
        ValueRef::Int(i) => serde_json::Value::Number((i as i64).into()),
        ValueRef::BigInt(i) => serde_json::Value::Number(i.into()),
        ValueRef::HugeInt(i) => serde_json::Value::String(i.to_string()),
        ValueRef::UTinyInt(i) => serde_json::Value::Number((i as u64).into()),
        ValueRef::USmallInt(i) => serde_json::Value::Number((i as u64).into()),
        ValueRef::UInt(i) => serde_json::Value::Number((i as u64).into()),
        ValueRef::UBigInt(i) => serde_json::Value::Number(i.into()),
        ValueRef::Float(f) => {
            serde_json::Number::from_f64(f as f64).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        ValueRef::Double(f) => {
            serde_json::Number::from_f64(f).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        ValueRef::Decimal(d) => serde_json::Value::String(d.to_string()),
        ValueRef::Date32(days) => {
            duckdb_date32_to_string(days).map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
        }
        ValueRef::Time64(unit, value) => {
            duckdb_time64_to_string(unit, value).map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
        }
        ValueRef::Timestamp(unit, value) => {
            duckdb_timestamp_to_string(unit, value).map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
        }
        ValueRef::Text(bytes) => std::str::from_utf8(bytes)
            .map(|s| serde_json::Value::String(s.to_string()))
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Blob(bytes) => {
            let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
            serde_json::Value::String(format!("\\x{hex}"))
        }
        ValueRef::Interval { months, days, nanos } => {
            serde_json::Value::String(duckdb_interval_to_string(months, days, nanos))
        }
        ValueRef::List(..)
        | ValueRef::Array(..)
        | ValueRef::Struct(..)
        | ValueRef::Map(..)
        | ValueRef::Enum(..)
        | ValueRef::Union(..) => duckdb_owned_value_to_json(&value_ref.to_owned()),
    }
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_owned_value_to_json(value: &Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Boolean(b) => serde_json::Value::Bool(*b),
        Value::TinyInt(i) => serde_json::Value::Number((*i as i64).into()),
        Value::SmallInt(i) => serde_json::Value::Number((*i as i64).into()),
        Value::Int(i) => serde_json::Value::Number((*i as i64).into()),
        Value::BigInt(i) => serde_json::Value::Number((*i).into()),
        Value::HugeInt(i) => serde_json::Value::String(i.to_string()),
        Value::UTinyInt(i) => serde_json::Value::Number((*i as u64).into()),
        Value::USmallInt(i) => serde_json::Value::Number((*i as u64).into()),
        Value::UInt(i) => serde_json::Value::Number((*i as u64).into()),
        Value::UBigInt(i) => serde_json::Value::Number((*i).into()),
        Value::Float(f) => {
            serde_json::Number::from_f64(*f as f64).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        Value::Double(f) => {
            serde_json::Number::from_f64(*f).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        Value::Decimal(d) => serde_json::Value::String(d.to_string()),
        Value::Timestamp(unit, value) => {
            duckdb_timestamp_to_string(*unit, *value).map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
        }
        Value::Text(text) | Value::Enum(text) => serde_json::Value::String(text.clone()),
        Value::Blob(bytes) => {
            let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
            serde_json::Value::String(format!("\\x{hex}"))
        }
        Value::Date32(days) => {
            duckdb_date32_to_string(*days).map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
        }
        Value::Time64(unit, value) => {
            duckdb_time64_to_string(*unit, *value).map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
        }
        Value::Interval { months, days, nanos } => {
            serde_json::Value::String(duckdb_interval_to_string(*months, *days, *nanos))
        }
        Value::List(values) | Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(duckdb_owned_value_to_json).collect())
        }
        Value::Struct(entries) => serde_json::Value::Object(
            entries.iter().map(|(key, value)| (key.clone(), duckdb_owned_value_to_json(value))).collect(),
        ),
        Value::Map(entries) => serde_json::Value::Array(
            entries
                .iter()
                .map(|(key, value)| {
                    serde_json::json!({
                        "key": duckdb_owned_value_to_json(key),
                        "value": duckdb_owned_value_to_json(value),
                    })
                })
                .collect(),
        ),
        Value::Union(value) => duckdb_owned_value_to_json(value),
    }
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_interval_to_string(months: i32, days: i32, nanos: i64) -> String {
    let mut parts = Vec::new();
    if months != 0 {
        let years = months / 12;
        let rem = months % 12;
        if years != 0 {
            parts.push(format!("{} year{}", years, if years.abs() != 1 { "s" } else { "" }));
        }
        if rem != 0 {
            parts.push(format!("{} mon{}", rem, if rem.abs() != 1 { "s" } else { "" }));
        }
    }
    if days != 0 {
        parts.push(format!("{} day{}", days, if days.abs() != 1 { "s" } else { "" }));
    }
    if nanos != 0 {
        let total_secs = nanos / 1_000_000_000;
        let hours = total_secs / 3600;
        let mins = (total_secs % 3600) / 60;
        let secs = total_secs % 60;
        let sub_nanos = (nanos % 1_000_000_000).unsigned_abs();
        if sub_nanos > 0 {
            parts.push(format!(
                "{:02}:{:02}:{:02}.{}",
                hours,
                mins,
                secs,
                format_temporal_without_empty_fraction(format!("0.{:09}", sub_nanos)).trim_start_matches("0.")
            ));
        } else {
            parts.push(format!("{:02}:{:02}:{:02}", hours, mins, secs));
        }
    }
    if parts.is_empty() {
        "00:00:00".to_string()
    } else {
        parts.join(" ")
    }
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_date32_to_string(days: i32) -> Option<String> {
    let epoch = NaiveDate::from_ymd_opt(1970, 1, 1)?;
    epoch.checked_add_signed(ChronoDuration::days(i64::from(days))).map(|date| date.to_string())
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_time64_to_string(unit: TimeUnit, value: i64) -> Option<String> {
    let nanos = duckdb_time_unit_to_nanos(unit, value)?;
    let seconds = nanos.div_euclid(1_000_000_000);
    let nanos_remainder = nanos.rem_euclid(1_000_000_000) as u32;
    if !(0..86_400).contains(&seconds) {
        return None;
    }
    let time = NaiveTime::from_num_seconds_from_midnight_opt(seconds as u32, nanos_remainder)?;
    Some(format_temporal_without_empty_fraction(time.to_string()))
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_timestamp_to_string(unit: TimeUnit, value: i64) -> Option<String> {
    let nanos = duckdb_time_unit_to_nanos(unit, value)?;
    let seconds = nanos.div_euclid(1_000_000_000);
    let nanos_remainder = nanos.rem_euclid(1_000_000_000) as u32;
    let dt: DateTime<Utc> = DateTime::from_timestamp(seconds, nanos_remainder)?;
    Some(format_naive_datetime(dt.naive_utc()))
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_time_unit_to_nanos(unit: TimeUnit, value: i64) -> Option<i64> {
    match unit {
        TimeUnit::Second => value.checked_mul(1_000_000_000),
        TimeUnit::Millisecond => value.checked_mul(1_000_000),
        TimeUnit::Microsecond => value.checked_mul(1_000),
        TimeUnit::Nanosecond => Some(value),
    }
}

#[cfg(feature = "duckdb-bundled")]
fn format_naive_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%d %H:%M:%S").to_string()
    } else {
        format_temporal_without_empty_fraction(value.to_string())
    }
}

#[cfg(feature = "duckdb-bundled")]
fn format_temporal_without_empty_fraction(value: String) -> String {
    if !value.contains('.') {
        return value;
    }
    let trimmed = value.trim_end_matches('0').trim_end_matches('.');
    trimmed.to_string()
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_execute_with_max_rows(
    con: &duckdb::Connection,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<db::QueryResult, String> {
    let start = std::time::Instant::now();
    let row_limit = query_result_row_limit(max_rows);

    if starts_with_duckdb_result_sql_keyword(sql) {
        let mut stmt = con.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let stmt_ref = rows.as_ref().ok_or("DuckDB statement unavailable")?;
        let col_count = stmt_ref.column_count();
        let columns: Vec<String> = (0..col_count)
            .map(|i| stmt_ref.column_name(i).map(|s| s.to_string()).unwrap_or_else(|_| "?".to_string()))
            .collect();

        let mut result_rows = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let vals: Vec<serde_json::Value> = (0..col_count).map(|i| duckdb_value_to_json(row, i)).collect();
            result_rows.push(vals);
            if result_rows.len() > row_limit {
                break;
            }
        }

        let truncated = result_rows.len() > row_limit;
        if truncated {
            result_rows.truncate(row_limit);
        }
        Ok(db::QueryResult {
            columns,
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: result_rows,
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated,
            session_id: None,
            has_more: false,
        })
    } else {
        let affected = con.execute(sql, []).map_err(|e| e.to_string())?;
        Ok(db::QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![],
            affected_rows: affected as u64,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

#[cfg(feature = "duckdb-bundled")]
async fn wait_for_duckdb_task_with_interrupt(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
    interrupt_handle: std::sync::Arc<duckdb::InterruptHandle>,
    mut task: JoinHandle<Result<db::QueryResult, String>>,
) -> Result<db::QueryResult, String> {
    match (cancel_token, timeout_duration) {
        (Some(token), Some(duration)) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    interrupt_handle.interrupt();
                    drain_interrupted_duckdb_task(&mut task).await;
                    Err(canceled_error())
                }
                result = &mut task => result.map_err(|e| e.to_string())?,
                _ = sleep(duration) => {
                    interrupt_handle.interrupt();
                    drain_interrupted_duckdb_task(&mut task).await;
                    Err(timeout_error())
                }
            }
        }
        (Some(token), None) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    interrupt_handle.interrupt();
                    drain_interrupted_duckdb_task(&mut task).await;
                    Err(canceled_error())
                }
                result = &mut task => result.map_err(|e| e.to_string())?,
            }
        }
        (None, Some(duration)) => {
            tokio::select! {
                result = &mut task => result.map_err(|e| e.to_string())?,
                _ = sleep(duration) => {
                    interrupt_handle.interrupt();
                    drain_interrupted_duckdb_task(&mut task).await;
                    Err(timeout_error())
                }
            }
        }
        (None, None) => task.await.map_err(|e| e.to_string())?,
    }
}

#[cfg(feature = "duckdb-bundled")]
async fn drain_interrupted_duckdb_task(task: &mut JoinHandle<Result<db::QueryResult, String>>) {
    let _ = timeout(DUCKDB_INTERRUPT_DRAIN_TIMEOUT, task).await;
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_execute_for_database(
    con: &duckdb::Connection,
    attached_names: &[String],
    database: Option<&str>,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<db::QueryResult, String> {
    if let Some(database) = database.map(str::trim).filter(|database| !database.is_empty()) {
        let catalog = if database == "main" {
            crate::schema::duckdb_primary_catalog(con, attached_names)?
        } else {
            database.to_string()
        };
        con.execute_batch(&format!("USE {}", duckdb_quote_ident(&catalog))).map_err(|e| e.to_string())?;
    }
    duckdb_execute_with_max_rows(con, sql, max_rows)
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub fn truncate_result(result: db::QueryResult) -> db::QueryResult {
    truncate_result_with_max_rows(result, None)
}

pub fn truncate_result_with_max_rows(mut result: db::QueryResult, max_rows: Option<usize>) -> db::QueryResult {
    let row_limit = query_result_row_limit(max_rows);
    if result.rows.len() > row_limit {
        result.rows.truncate(row_limit);
        result.truncated = true;
    }
    result
}

fn normalize_query_result_for_js(mut result: db::QueryResult) -> db::QueryResult {
    result.rows = result.rows.into_iter().map(|row| row.into_iter().map(db::json_value_for_js).collect()).collect();
    result
}

pub fn agent_execute_query_params(
    sql: &str,
    database: Option<&str>,
    schema: Option<&str>,
    options: QueryExecutionOptions,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "sql": sql,
        "maxRows": options.max_rows.unwrap_or(MAX_ROWS),
    });
    if let Some(database) = database.map(str::trim).filter(|database| !database.is_empty()) {
        params["database"] = serde_json::json!(database);
    }
    if let Some(schema) = schema {
        params["schema"] = serde_json::json!(schema);
    }
    if let Some(fetch_size) = options.fetch_size {
        params["fetchSize"] = serde_json::json!(fetch_size);
    }
    if let Some(timeout_secs) = options.timeout_secs {
        params["timeoutSecs"] = serde_json::json!(timeout_secs);
    }
    params
}

pub fn agent_execute_query_page_params(
    sql: &str,
    database: Option<&str>,
    schema: Option<&str>,
    options: QueryExecutionOptions,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "sql": sql,
        "pageSize": options.page_size.unwrap_or(MAX_ROWS),
        "maxRows": options.max_rows.unwrap_or(MAX_ROWS),
    });
    if let Some(database) = database.map(str::trim).filter(|database| !database.is_empty()) {
        params["database"] = serde_json::json!(database);
    }
    if let Some(schema) = schema {
        params["schema"] = serde_json::json!(schema);
    }
    if let Some(fetch_size) = options.fetch_size {
        params["fetchSize"] = serde_json::json!(fetch_size);
    }
    if let Some(timeout_secs) = options.timeout_secs {
        params["timeoutSecs"] = serde_json::json!(timeout_secs);
    }
    params
}

pub fn agent_fetch_query_page_params(session_id: &str, page_size: usize) -> serde_json::Value {
    serde_json::json!({
        "sessionId": session_id,
        "pageSize": page_size,
    })
}

pub fn agent_close_query_session_params(session_id: &str) -> serde_json::Value {
    serde_json::json!({
        "sessionId": session_id,
    })
}

pub fn is_connection_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    if is_dbx_query_timeout_error(&lower) || is_agent_rpc_timeout_error(&lower) {
        return false;
    }
    lower.contains("connection")
        || lower.contains("broken pipe")
        || lower.contains("reset by peer")
        || lower.contains("timed out")
        || lower.contains("closed")
        || lower.contains("关闭的连接")
        || lower.contains("连接已关闭")
        || lower.contains("eof")
        || lower.contains("i/o error")
        || lower.contains("not connected")
        || lower.contains("end-of-file")
        || lower.contains("idle")
        || lower.contains("agent stdin not available")
        || lower.contains("agent stdout not available")
        || lower.contains("failed to write to agent stdin")
        || lower.contains("failed to flush agent stdin")
        || lower.contains("communicating with the server")
        || is_os_connection_error(&lower)
}

fn is_dbx_query_timeout_error(lower: &str) -> bool {
    lower.starts_with("query timed out after ")
}

fn is_agent_rpc_timeout_error(lower: &str) -> bool {
    lower.starts_with("agent rpc call timed out ")
}

fn should_discard_agent_pool_after_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    is_dbx_query_timeout_error(&lower)
        || is_agent_rpc_timeout_error(&lower)
        || lower.contains("agent stdin not available")
        || lower.contains("agent stdout not available")
        || lower.contains("failed to write to agent stdin")
        || lower.contains("failed to flush agent stdin")
        || lower.contains("agent rpc task failed")
}

pub fn pool_error_action(db_type: Option<DatabaseType>, err: &str) -> PoolErrorAction {
    let lower = err.to_lowercase();
    if db::sqlserver::is_driver_panic_error(err)
        || (db_type == Some(DatabaseType::SqlServer) && is_dbx_query_timeout_error(&lower))
        || (db_type.is_some_and(|db_type| database_capabilities::is_agent_type(&db_type))
            && should_discard_agent_pool_after_error(err)
            && !is_connection_error(err))
    {
        return PoolErrorAction::Discard;
    }

    if is_connection_error(err) {
        PoolErrorAction::ReconnectAndRetry
    } else {
        PoolErrorAction::Keep
    }
}

pub fn should_discard_pool_after_error(db_type: Option<DatabaseType>, err: &str) -> bool {
    matches!(pool_error_action(db_type, err), PoolErrorAction::Discard | PoolErrorAction::ReconnectAndRetry)
}

fn is_os_connection_error(lower: &str) -> bool {
    let os_error_codes = ["10053", "10054", "10057", "10058", "10060", "10061"];
    if let Some(pos) = lower.find("os error ") {
        let after = &lower[pos + 9..];
        let code: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        return os_error_codes.contains(&code.as_str());
    }
    false
}

pub fn timeout_error() -> String {
    format!("Query timed out after {} seconds", QUERY_TIMEOUT.as_secs())
}

pub fn canceled_error() -> String {
    QUERY_CANCELED.to_string()
}

pub fn is_canceled(cancel_token: &Option<CancellationToken>) -> bool {
    cancel_token.as_ref().map(|token| token.is_cancelled()).unwrap_or(false)
}

pub async fn wait_for_query<F>(cancel_token: Option<CancellationToken>, future: F) -> Result<db::QueryResult, String>
where
    F: Future<Output = Result<db::QueryResult, String>>,
{
    wait_for_query_with_timeout(cancel_token, QUERY_TIMEOUT, future).await
}

pub async fn wait_for_query_with_timeout<F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Duration,
    future: F,
) -> Result<db::QueryResult, String>
where
    F: Future<Output = Result<db::QueryResult, String>>,
{
    if let Some(token) = cancel_token {
        tokio::select! {
            biased;
            _ = token.cancelled() => Err(canceled_error()),
            result = timeout(timeout_duration, future) => result.map_err(|_| timeout_error())?,
        }
    } else {
        timeout(timeout_duration, future).await.map_err(|_| timeout_error())?
    }
}

/// Like `wait_for_query_with_timeout` but with an optional timeout.
/// `None` means no timeout (only cancellation can stop the query).
pub async fn wait_for_query_opt<F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
    future: F,
) -> Result<db::QueryResult, String>
where
    F: Future<Output = Result<db::QueryResult, String>>,
{
    match timeout_duration {
        Some(d) => wait_for_query_with_timeout(cancel_token, d, future).await,
        None => match cancel_token {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => Err(canceled_error()),
                    result = future => result,
                }
            }
            None => future.await,
        },
    }
}

fn resolve_query_timeout(timeout_secs: Option<u64>) -> Option<Duration> {
    match timeout_secs {
        Some(0) => None,
        Some(n) => Some(Duration::from_secs(n)),
        None => Some(QUERY_TIMEOUT),
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn do_execute(
    state: &AppState,
    pool_key: &str,
    mysql_dialect: db::mysql::MySqlQueryDialect,
    database: Option<&str>,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, String> {
    if let Some(execution_id) = options.execution_id.as_deref() {
        state.running_queries.set_pool_key(execution_id, pool_key.to_string());
    }
    state.touch_pool_activity(pool_key).await;
    let _activity_touch = state.pool_activity_touch(pool_key);

    let query_timeout = resolve_query_timeout(options.timeout_secs);
    let (_duckdb_attached_names, conn_name_if_readonly) = {
        let configs = state.configs.read().await;
        let config = crate::connection::config_for_pool_key(pool_key, &configs);
        let attached = config
            .map(|c| c.attached_databases.iter().map(|db| db.name.clone()).collect::<Vec<_>>())
            .unwrap_or_default();
        let conn_name = config.filter(|c| c.read_only).map(|c| c.name.clone());
        (attached, conn_name)
    };
    if let Some(name) = conn_name_if_readonly {
        crate::query_execution_sql::check_read_only(sql, &name)?;
    }
    let pool_db_type = connection_database_type_for_pool_key(state, pool_key).await;
    let connections = state.connections.read().await;
    let pool = connections.get(pool_key).ok_or("Connection not found")?;

    let result = match pool {
        #[cfg(feature = "duckdb-bundled")]
        PoolKind::DuckDb(con) => {
            let con = con.clone();
            let interrupt_handle = con.lock().map_err(|e| e.to_string())?.interrupt_handle();
            if let Some(ref execution_id) = options.execution_id {
                let cancel_interrupt_handle = interrupt_handle.clone();
                state.running_queries.register_interrupt(execution_id, move || {
                    cancel_interrupt_handle.interrupt();
                });
            }
            let sql = sql.to_string();
            let database = database.map(str::to_string);
            let attached_names = _duckdb_attached_names;
            let max_rows = options.max_rows;
            drop(connections);
            let task = tokio::task::spawn_blocking(move || {
                let con = con.lock().map_err(|e| e.to_string())?;
                duckdb_execute_for_database(&con, &attached_names, database.as_deref(), &sql, max_rows)
            });
            wait_for_duckdb_task_with_interrupt(cancel_token, query_timeout, interrupt_handle, task).await
        }
        #[cfg(not(feature = "duckdb-bundled"))]
        PoolKind::DuckDb(_) => {
            return Err("DuckDB support is not compiled in this build".to_string());
        }
        PoolKind::Mysql(p, mode) => {
            let p = p.clone();
            let bare = *mode == crate::connection::MysqlMode::Bare;
            let max_rows = options.max_rows;
            drop(connections);
            let mut conn = db::mysql::get_conn_with_health_check(&p).await?;
            let connection_id = conn.id();
            if let Some(ref execution_id) = options.execution_id {
                let kill_opts = conn.opts().clone();
                state.running_queries.register_interrupt(execution_id, move || {
                    let kill_opts = kill_opts.clone();
                    tokio::spawn(async move {
                        if let Err(error) = db::mysql::kill_query_with_opts(kill_opts, connection_id).await {
                            log::warn!("Failed to cancel MySQL query {connection_id}: {error}");
                        }
                    });
                });
            }
            wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::mysql::execute_query_on_conn_with_max_rows(&mut conn, sql, bare, max_rows, mysql_dialect),
            )
            .await
        }
        PoolKind::Postgres(p) => {
            let p = p.clone();
            let schema = schema.map(|s| s.to_string());
            let max_rows = options.max_rows;
            let query_timeout = query_timeout;
            drop(connections);
            if let Some(schema) = schema {
                db::postgres::execute_query_with_schema_and_max_rows_and_cancel(
                    &p,
                    &schema,
                    sql,
                    max_rows,
                    cancel_token,
                    query_timeout,
                )
                .await
            } else {
                db::postgres::execute_query_with_max_rows_and_cancel(&p, sql, max_rows, cancel_token, query_timeout)
                    .await
            }
        }
        PoolKind::Sqlite(p) => {
            let p = p.clone();
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query_opt(cancel_token, query_timeout, db::sqlite::execute_query_with_max_rows(&p, sql, max_rows))
                .await
        }
        PoolKind::Rqlite(client) => {
            let client = client.clone();
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::rqlite_driver::execute_query_with_max_rows(&client, sql, max_rows),
            )
            .await
        }
        PoolKind::Turso(client) => {
            let client = client.clone();
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::turso_driver::execute_query_with_max_rows(&client, sql, max_rows),
            )
            .await
        }
        PoolKind::ClickHouse(client) => {
            let client = client.clone();
            let database = pool_key.split(':').nth(1).unwrap_or("default").to_string();
            let max_rows = options.max_rows;
            drop(connections);
            let result = wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::clickhouse_driver::execute_query_with_max_rows(&client, &database, sql, max_rows),
            )
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows));
            if matches!(result.as_ref(), Err(err) if should_discard_pool_after_error(pool_db_type, err)) {
                state.remove_pool_by_key(pool_key).await;
            }
            result
        }
        PoolKind::SqlServer(client) => {
            let client = client.clone();
            let max_rows = options.max_rows;
            drop(connections);
            let mut client = match cancel_token.as_ref() {
                Some(token) => tokio::select! {
                    biased;
                    _ = token.cancelled() => return Err(canceled_error()),
                    guard = client.lock() => guard,
                },
                None => client.lock().await,
            };
            let result = wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::sqlserver::execute_query_with_max_rows(&mut client, sql, max_rows),
            )
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows));
            drop(client);
            if matches!(result.as_ref(), Err(err) if should_discard_pool_after_error(pool_db_type, err)) {
                state.remove_pool_by_key(pool_key).await;
            }
            result
        }
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            let sql = sql.to_string();
            let max_rows = options.max_rows;
            drop(connections);
            let result = wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::elasticsearch_driver::execute_rest_query(&client, &sql),
            )
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows));
            if matches!(result.as_ref(), Err(err) if should_discard_pool_after_error(pool_db_type, err)) {
                state.remove_pool_by_key(pool_key).await;
            }
            result
        }
        PoolKind::VectorDb(client) => {
            let client = client.clone();
            let sql = sql.to_string();
            let max_rows = options.max_rows;
            drop(connections);
            let result =
                wait_for_query_opt(cancel_token, query_timeout, db::vector_driver::execute_rest_query(&client, &sql))
                    .await
                    .map(|result| truncate_result_with_max_rows(result, max_rows));
            if matches!(result.as_ref(), Err(err) if should_discard_pool_after_error(pool_db_type, err)) {
                state.remove_pool_by_key(pool_key).await;
            }
            result
        }
        PoolKind::Redis(_) => Err("Use Redis-specific commands".to_string()),
        PoolKind::MongoDb(_) => Err("Use MongoDB-specific commands".to_string()),
        PoolKind::MessageQueue => Err("Use Message Queue-specific commands".to_string()),
        PoolKind::Nacos => Err("Use Nacos-specific commands".to_string()),
        PoolKind::InfluxDb(client) => {
            let client = client.clone();
            let database = pool_key.split(':').nth(1).unwrap_or("default").to_string();
            let max_rows = options.max_rows;
            drop(connections);
            let result = wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::influxdb_driver::execute_query(&client, &database, sql),
            )
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows));
            if matches!(result.as_ref(), Err(err) if should_discard_pool_after_error(pool_db_type, err)) {
                state.remove_pool_by_key(pool_key).await;
            }
            result
        }
        PoolKind::Agent(client) => {
            let client = client.clone();
            let sql = sql_for_execution_context(pool_db_type, sql, schema);
            let database = database.map(|s| s.to_string());
            let schema = schema_for_execution_context(pool_db_type, schema).map(|s| s.to_string());
            let max_rows = options.max_rows;
            let rpc_timeout = query_timeout;
            drop(connections);
            if is_canceled(&cancel_token) {
                return Err(canceled_error());
            }
            let cancel_for_agent = cancel_token.clone();
            let result = async move {
                let mut client = match cancel_for_agent.as_ref() {
                    Some(token) => {
                        tokio::select! {
                            biased;
                            _ = token.cancelled() => return Err(canceled_error()),
                            guard = client.lock() => guard,
                        }
                    }
                    None => client.lock().await,
                };
                if let Some(session_id) = options.result_session_id.as_deref() {
                    let params = agent_fetch_query_page_params(session_id, options.page_size.unwrap_or(MAX_ROWS));
                    client.fetch_query_page_with_timeout_and_cancel(params, rpc_timeout, cancel_for_agent.clone()).await
                } else if options.page_size.is_some() {
                    let params = agent_execute_query_page_params(&sql, database.as_deref(), schema.as_deref(), options);
                    client
                        .execute_query_page_with_timeout_and_cancel(params, rpc_timeout, cancel_for_agent.clone())
                        .await
                } else {
                    let params = agent_execute_query_params(&sql, database.as_deref(), schema.as_deref(), options);
                    client.execute_query_with_timeout_and_cancel(params, rpc_timeout, cancel_for_agent.clone()).await
                }
            }
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows));
            if matches!(result.as_ref(), Err(err) if err == QUERY_CANCELED) {
                state.remove_pool_by_key(pool_key).await;
            }
            if matches!(result.as_ref(), Err(err) if should_discard_pool_after_error(pool_db_type, err)) {
                state.remove_pool_by_key(pool_key).await;
            }
            result
        }
        #[cfg(feature = "duckdb-bundled")]
        PoolKind::ExternalTabular(ext_pool) => {
            if !starts_with_duckdb_result_sql_keyword(sql) {
                return Err("External data sources are read-only. Only SELECT queries are supported.".to_string());
            }
            let con = ext_pool.cache.clone();
            let interrupt_handle = con.lock().map_err(|e| e.to_string())?.interrupt_handle();
            if let Some(ref execution_id) = options.execution_id {
                let cancel_interrupt_handle = interrupt_handle.clone();
                state.running_queries.register_interrupt(execution_id, move || {
                    cancel_interrupt_handle.interrupt();
                });
            }
            let sql = sql.to_string();
            let max_rows = options.max_rows;
            drop(connections);
            let task = tokio::task::spawn_blocking(move || {
                let con = con.lock().map_err(|e| e.to_string())?;
                duckdb_execute_with_max_rows(&con, &sql, max_rows)
            });
            wait_for_duckdb_task_with_interrupt(cancel_token, query_timeout, interrupt_handle, task).await
        }
        #[cfg(not(feature = "duckdb-bundled"))]
        PoolKind::ExternalTabular(_) => {
            Err("External data sources require DuckDB support. Rebuild with default features.".to_string())
        }
        PoolKind::ExternalDriver { config, session, .. } => {
            let config = config.clone();
            let session = session.clone();
            let sql = sql.to_string();
            let schema = schema.map(str::to_string);
            let database = database.unwrap_or_else(|| config.effective_database().unwrap_or("")).to_string();
            let max_rows = options.max_rows;
            let plugin_timeout = query_timeout;
            drop(connections);
            wait_for_query_opt(cancel_token, query_timeout, async move {
                if let Some(session_id) = options.result_session_id.as_deref() {
                    let params = external_driver_fetch_query_page_params(
                        config.as_ref(),
                        session_id,
                        options.page_size.unwrap_or(MAX_ROWS),
                    );
                    session.invoke_with_timeout::<db::QueryResult>("fetchQueryPage", params, plugin_timeout).await
                } else if options.page_size.is_some() {
                    let params =
                        external_driver_query_params(config.as_ref(), &sql, &database, schema.as_deref(), &options);
                    session.invoke_with_timeout::<db::QueryResult>("executeQueryPage", params, plugin_timeout).await
                } else {
                    let params =
                        external_driver_query_params(config.as_ref(), &sql, &database, schema.as_deref(), &options);
                    session.invoke_with_timeout::<db::QueryResult>("executeQuery", params, plugin_timeout).await
                }
            })
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows))
        }
    };
    result.map(normalize_query_result_for_js)
}

fn external_driver_query_params(
    config: &crate::models::connection::ConnectionConfig,
    sql: &str,
    database: &str,
    schema: Option<&str>,
    options: &QueryExecutionOptions,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "connection": config,
        "sql": sql,
        "database": database,
        "schema": schema,
        "maxRows": options.max_rows.unwrap_or(MAX_ROWS),
    });
    if let Some(fetch_size) = options.fetch_size {
        params["fetchSize"] = serde_json::json!(fetch_size);
    }
    if let Some(timeout_secs) = options.timeout_secs {
        params["timeoutSecs"] = serde_json::json!(timeout_secs);
    }
    if let Some(page_size) = options.page_size {
        params["pageSize"] = serde_json::json!(page_size);
    }
    params
}

fn external_driver_fetch_query_page_params(
    config: &crate::models::connection::ConnectionConfig,
    session_id: &str,
    page_size: usize,
) -> serde_json::Value {
    serde_json::json!({
        "connection": config,
        "sessionId": session_id,
        "pageSize": page_size,
    })
}

pub async fn execute_sql_statement(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
) -> Result<db::QueryResult, String> {
    execute_sql_statement_with_options(
        state,
        connection_id,
        database,
        sql,
        schema,
        cancel_token,
        QueryExecutionOptions::default(),
    )
    .await
}

pub async fn execute_sql_statement_with_options(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, String> {
    // MongoDB connections use shell-style commands dispatched through the
    // frontend parser. Queries that fall through to the generic SQL executor
    // (e.g. typos) must be rejected before any pool/key creation so that
    // session-scoped pools do not leak MongoDB Clients and SSH tunnels.
    if connection_is_mongodb(state, connection_id).await {
        return Err("Use MongoDB-specific commands".to_string());
    }

    let db_type = connection_database_type(state, connection_id).await;
    let has_executable_sql = db_type.map_or_else(
        || crate::sql::has_executable_sql(sql),
        |db_type| crate::sql::has_executable_sql_for_database(sql, db_type),
    );
    if !has_executable_sql {
        return Ok(empty_query_result(0));
    }

    if let Some(target_database) = postgres_drop_database_target(db_type, sql) {
        return execute_postgres_drop_database(state, connection_id, &target_database, sql, cancel_token, options)
            .await;
    }

    // When a query tab has a client session, keep even database-less execution
    // on that tab-scoped pool so connection-level state (for example MySQL @vars)
    // survives across runs.
    let pool_key = if database.is_empty() {
        state.get_or_create_pool_for_session(connection_id, None, options.client_session_id.as_deref()).await?
    } else {
        state
            .get_or_create_pool_for_session(connection_id, Some(database), options.client_session_id.as_deref())
            .await?
    };

    if is_canceled(&cancel_token) {
        return Err(canceled_error());
    }

    let mysql_dialect = connection_mysql_query_dialect(state, connection_id).await;
    let result =
        do_execute(state, &pool_key, mysql_dialect, Some(database), sql, schema, cancel_token.clone(), options.clone())
            .await;

    match &result {
        Err(e)
            if pool_error_action(db_type, e) == PoolErrorAction::ReconnectAndRetry && !is_canceled(&cancel_token) =>
        {
            let db_opt = if database.is_empty() { None } else { Some(database) };
            let new_key =
                state.reconnect_pool_for_session(connection_id, db_opt, options.client_session_id.as_deref()).await?;
            do_execute(state, &new_key, mysql_dialect, Some(database), sql, schema, cancel_token, options).await
        }
        _ => result,
    }
}

async fn execute_postgres_drop_database(
    state: &AppState,
    connection_id: &str,
    target_database: &str,
    sql: &str,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, String> {
    state.close_database_pool(connection_id, Some(target_database)).await?;

    let admin_database = postgres_drop_database_admin_database(target_database);
    let pool_key = state
        .get_or_create_pool_for_session(connection_id, Some(admin_database), options.client_session_id.as_deref())
        .await?;
    if let Some(execution_id) = options.execution_id.as_deref() {
        state.running_queries.set_pool_key(execution_id, pool_key.clone());
    }
    state.touch_pool_activity(&pool_key).await;
    let _activity_touch = state.pool_activity_touch(pool_key.as_str());

    if is_canceled(&cancel_token) {
        return Err(canceled_error());
    }

    check_read_only_for_connection(state, &pool_key, sql).await?;
    let pool = {
        let connections = state.connections.read().await;
        match connections.get(&pool_key) {
            Some(PoolKind::Postgres(pool)) => pool.clone(),
            Some(_) => return Err("DROP DATABASE reconnect did not create a PostgreSQL connection".to_string()),
            None => return Err("Connection not found".to_string()),
        }
    };

    let query_timeout = resolve_query_timeout(options.timeout_secs);
    let max_rows = options.max_rows;
    wait_for_query_opt(cancel_token, query_timeout, async {
        db::postgres::terminate_current_user_database_backends(&pool, target_database).await?;
        db::postgres::execute_query_with_max_rows(&pool, sql, max_rows).await
    })
    .await
}

fn postgres_drop_database_target(db_type: Option<DatabaseType>, sql: &str) -> Option<String> {
    if db_type != Some(DatabaseType::Postgres) {
        return None;
    }
    parse_drop_database_target(sql)
}

fn postgres_drop_database_admin_database(target_database: &str) -> &'static str {
    if target_database.eq_ignore_ascii_case("postgres") {
        "template1"
    } else {
        "postgres"
    }
}

fn parse_drop_database_target(sql: &str) -> Option<String> {
    let dialect = PostgreSqlDialect {};
    let statements = Parser::parse_sql(&dialect, sql).ok()?;
    let [Statement::Drop { object_type, names, .. }] = statements.as_slice() else {
        return None;
    };
    if *object_type != ObjectType::Database || names.len() != 1 {
        return None;
    }

    let parts = &names[0].0;
    if parts.len() != 1 {
        return None;
    }
    parts[0].as_ident().map(|ident| ident.value.clone())
}

pub async fn close_query_session(
    state: &AppState,
    connection_id: &str,
    database: &str,
    session_id: &str,
    client_session_id: Option<&str>,
) -> Result<bool, String> {
    let pool_key = if database.is_empty() {
        state.get_or_create_pool_for_session(connection_id, None, client_session_id).await?
    } else {
        state.get_or_create_pool_for_session(connection_id, Some(database), client_session_id).await?
    };

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Connection not found")?;
    match pool {
        PoolKind::Agent(client) => {
            let client = client.clone();
            drop(connections);
            let mut client = client.lock().await;
            client.close_query_session(session_id).await
        }
        PoolKind::ExternalDriver { config, session, .. } => {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            let params = external_driver_fetch_query_page_params(config.as_ref(), session_id, 1);
            session
                .invoke::<serde_json::Value>("closeQuerySession", params)
                .await
                .map(|value| value.get("ok").and_then(|ok| ok.as_bool()).unwrap_or(false))
        }
        _ => Ok(false),
    }
}

pub async fn execute_multi_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
) -> Result<Vec<db::QueryResult>, String> {
    execute_multi_core_with_options(
        state,
        connection_id,
        database,
        sql,
        schema,
        cancel_token,
        QueryExecutionOptions::default(),
    )
    .await
}

pub async fn execute_multi_core_with_options(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<Vec<db::QueryResult>, String> {
    // Reject MongoDB queries that fall through to the generic executor.
    if connection_is_mongodb(state, connection_id).await {
        return Err("Use MongoDB-specific commands".to_string());
    }

    let pool_key = if database.is_empty() {
        state.get_or_create_pool_for_session(connection_id, None, options.client_session_id.as_deref()).await?
    } else {
        state
            .get_or_create_pool_for_session(connection_id, Some(database), options.client_session_id.as_deref())
            .await?
    };
    if let Some(execution_id) = options.execution_id.as_deref() {
        state.running_queries.set_pool_key(execution_id, pool_key.clone());
    }
    state.touch_pool_activity(&pool_key).await;
    let _activity_touch = state.pool_activity_touch(pool_key.as_str());

    let is_sqlserver = {
        let connections = state.connections.read().await;
        matches!(connections.get(&pool_key), Some(PoolKind::SqlServer(_)))
    };

    if is_sqlserver {
        return execute_multi_sqlserver(state, &pool_key, sql, cancel_token, options).await;
    }

    let is_turso = {
        let configs = state.configs.read().await;
        configs.get(connection_id).is_some_and(|c| c.db_type == DatabaseType::Turso)
    };

    // Turso sends all statements in one HTTP pipeline for transactional integrity.
    if is_turso {
        let result =
            execute_sql_statement_with_options(state, connection_id, database, sql, schema, cancel_token, options)
                .await?;
        return Ok(vec![result]);
    }

    let db_type = connection_database_type(state, connection_id).await;
    let statements = db_type.map_or_else(
        || split_sql_statements(sql),
        |db_type| crate::sql::split_sql_statements_for_database(sql, db_type),
    );
    if statements.is_empty() {
        return Ok(vec![empty_query_result(0)]);
    }

    let mysql_pool = {
        let connections = state.connections.read().await;
        match connections.get(&pool_key) {
            Some(PoolKind::Mysql(pool, mode)) => Some((pool.clone(), *mode)),
            _ => None,
        }
    };

    if statements.len() <= 1 {
        let single_sql = statements.into_iter().next().unwrap_or_default();
        let result = execute_sql_statement_with_options(
            state,
            connection_id,
            database,
            &single_sql,
            schema,
            cancel_token,
            options,
        )
        .await?;
        return Ok(vec![result]);
    }

    if let Some((pool, mode)) = mysql_pool {
        // Read-only check for MySQL batch path
        check_read_only_for_connection_multi(state, &pool_key, &statements).await?;
        let mysql_dialect = connection_mysql_query_dialect(state, connection_id).await;
        return execute_multi_mysql(&pool, mode, mysql_dialect, &statements, cancel_token, options).await;
    }

    let mut results = Vec::with_capacity(statements.len());
    for stmt in &statements {
        if is_canceled(&cancel_token) {
            results.push(error_query_result(canceled_error()));
            break;
        }
        match execute_sql_statement_with_options(
            state,
            connection_id,
            database,
            stmt,
            schema,
            cancel_token.clone(),
            options.clone(),
        )
        .await
        {
            Ok(r) => results.push(r),
            Err(e) => {
                results.push(error_query_result(e));
            }
        }
    }

    Ok(results)
}

async fn execute_multi_mysql(
    pool: &db::mysql::MySqlPool,
    mode: crate::connection::MysqlMode,
    dialect: db::mysql::MySqlQueryDialect,
    statements: &[String],
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<Vec<db::QueryResult>, String> {
    let query_timeout = resolve_query_timeout(options.timeout_secs);
    let bare = mode == crate::connection::MysqlMode::Bare;
    let max_rows = options.max_rows;
    let mut conn = match db::mysql::get_conn_with_health_check(pool).await {
        Ok(conn) => conn,
        Err(err) => return Ok(vec![error_query_result(err)]),
    };
    let mut results = Vec::with_capacity(statements.len());

    for stmt in statements {
        if is_canceled(&cancel_token) {
            results.push(error_query_result(canceled_error()));
            break;
        }

        match wait_for_query_opt(
            cancel_token.clone(),
            query_timeout,
            db::mysql::execute_query_on_conn_with_max_rows(&mut conn, stmt, bare, max_rows, dialect),
        )
        .await
        {
            Ok(result) => results.push(result),
            Err(err) => results.push(error_query_result(err)),
        }
    }

    Ok(results)
}

fn error_query_result(message: String) -> db::QueryResult {
    db::QueryResult {
        columns: vec!["Error".to_string()],
        column_types: Vec::new(),
        column_sortables: vec![],
        rows: vec![vec![serde_json::Value::String(message)]],
        affected_rows: 0,
        execution_time_ms: 0,
        truncated: false,
        session_id: None,
        has_more: false,
    }
}

fn empty_query_result(execution_time_ms: u128) -> db::QueryResult {
    db::QueryResult {
        columns: vec![],
        column_types: Vec::new(),
        column_sortables: vec![],
        rows: vec![],
        affected_rows: 0,
        execution_time_ms,
        truncated: false,
        session_id: None,
        has_more: false,
    }
}

async fn execute_multi_sqlserver(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<Vec<db::QueryResult>, String> {
    let batches = split_sql_batches(sql);

    // Read-only check for SQL Server batch path
    check_read_only_for_connection_multi(state, pool_key, &batches).await?;
    let mut all_results = Vec::new();
    let max_rows = options.max_rows;

    for batch in &batches {
        if is_canceled(&cancel_token) {
            all_results.push(db::QueryResult {
                columns: vec!["Error".to_string()],
                column_types: Vec::new(),
                column_sortables: vec![],
                rows: vec![vec![serde_json::Value::String(canceled_error())]],
                affected_rows: 0,
                execution_time_ms: 0,
                truncated: false,
                session_id: None,
                has_more: false,
            });
            break;
        }

        let connections = state.connections.read().await;
        let pool = connections.get(pool_key).ok_or("Connection not found")?;
        let client = match pool {
            PoolKind::SqlServer(c) => c.clone(),
            _ => return Err("Expected SQL Server connection".to_string()),
        };
        drop(connections);

        let mut client = match cancel_token.as_ref() {
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => return Err(canceled_error()),
                guard = client.lock() => guard,
            },
            None => client.lock().await,
        };

        let result = db::sqlserver::execute_batch_with_max_rows(&mut client, batch, max_rows).await;
        drop(client);

        match result {
            Ok(results) => all_results.extend(results),
            Err(e) => {
                let action = pool_error_action(Some(DatabaseType::SqlServer), &e);
                all_results.push(db::QueryResult {
                    columns: vec!["Error".to_string()],
                    column_types: Vec::new(),
                    column_sortables: vec![],
                    rows: vec![vec![serde_json::Value::String(e)]],
                    affected_rows: 0,
                    execution_time_ms: 0,
                    truncated: false,
                    session_id: None,
                    has_more: false,
                });
                if matches!(action, PoolErrorAction::Discard | PoolErrorAction::ReconnectAndRetry) {
                    state.remove_pool_by_key(pool_key).await;
                    break;
                }
            }
        }
    }

    if all_results.is_empty() {
        all_results.push(db::QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
        });
    }

    Ok(all_results)
}

pub async fn execute_statements(
    state: &AppState,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
    timeout_secs: Option<u64>,
) -> Result<db::QueryResult, String> {
    let pool_key = if database.is_empty() {
        connection_id.to_string()
    } else {
        state.get_or_create_pool(connection_id, Some(database)).await?
    };

    let mut total_affected: u64 = 0;
    let start = std::time::Instant::now();
    let mysql_dialect = connection_mysql_query_dialect(state, connection_id).await;

    for (i, sql) in statements.iter().enumerate() {
        match do_execute(
            state,
            &pool_key,
            mysql_dialect,
            Some(database),
            sql,
            schema,
            None,
            QueryExecutionOptions { timeout_secs, ..Default::default() },
        )
        .await
        {
            Ok(result) => {
                total_affected += result.affected_rows;
            }
            Err(e) => {
                match pool_error_action(connection_database_type(state, connection_id).await, &e) {
                    PoolErrorAction::ReconnectAndRetry => {
                        let db_opt = if database.is_empty() { None } else { Some(database) };
                        let _ = state.reconnect_pool(connection_id, db_opt).await;
                    }
                    PoolErrorAction::Discard => {
                        let _ = state.remove_pool_by_key(&pool_key).await;
                    }
                    PoolErrorAction::Keep => {}
                }
                return Err(format!(
                    "Statement {} failed: {}. Previous {} statement(s) may have been committed.",
                    i + 1,
                    e,
                    i
                ));
            }
        }
    }

    Ok(db::QueryResult {
        columns: vec![],
        column_types: Vec::new(),
        column_sortables: vec![],
        rows: vec![],
        affected_rows: total_affected,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
    })
}

/// Execute multiple SQL statements within a single transaction.
/// For pooled drivers (Postgres/MySQL), uses the driver transaction API.
/// For SQLite and already-single-connection drivers (ClickHouse/SqlServer/Agent),
/// uses explicit BEGIN/COMMIT/ROLLBACK on the shared connection.
/// For databases that don't support explicit transactions (Redis, MongoDB, Oracle),
/// executes statements sequentially without transaction.
/// If BEGIN fails, returns an error instead of silently falling back to auto-commit.
pub async fn execute_statements_in_transaction(
    state: &AppState,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
) -> Result<db::QueryResult, String> {
    let pool_key = if database.is_empty() {
        connection_id.to_string()
    } else {
        state.get_or_create_pool(connection_id, Some(database)).await?
    };

    // Read-only check: intercept all transaction paths before dispatching
    check_read_only_for_connection_multi(state, &pool_key, statements).await?;

    let start = std::time::Instant::now();

    // Clone the pool handle within the lock, then drop it before any async work.
    let path = {
        let conns = state.connections.read().await;
        conns.get(&pool_key).map(|p| match p {
            PoolKind::Postgres(pg) => TxPath::Pg(pg.clone()),
            PoolKind::Mysql(mp, _mode) => TxPath::Mysql(mp.clone(), false),
            PoolKind::Sqlite(sq) => TxPath::Sqlite(sq.clone()),
            PoolKind::ClickHouse(_)
            | PoolKind::Rqlite(_)
            | PoolKind::Turso(_)
            | PoolKind::SqlServer(_)
            | PoolKind::Agent(_) => TxPath::Explicit,
            PoolKind::MessageQueue | PoolKind::Nacos => TxPath::None,
            #[cfg(feature = "duckdb-bundled")]
            PoolKind::DuckDb(_)
            | PoolKind::Redis(_)
            | PoolKind::MongoDb(_)
            | PoolKind::Elasticsearch(_)
            | PoolKind::VectorDb(_)
            | PoolKind::InfluxDb(_)
            | PoolKind::ExternalTabular(_)
            | PoolKind::ExternalDriver { .. } => TxPath::None,
            #[cfg(not(feature = "duckdb-bundled"))]
            PoolKind::DuckDb(_)
            | PoolKind::Redis(_)
            | PoolKind::MongoDb(_)
            | PoolKind::Elasticsearch(_)
            | PoolKind::VectorDb(_)
            | PoolKind::InfluxDb(_)
            | PoolKind::ExternalTabular(_)
            | PoolKind::ExternalDriver { .. } => TxPath::None,
        })
    };

    match path {
        Some(TxPath::Pg(pool)) => exec_tx_pg_inner(pool, statements, schema, start).await,
        Some(TxPath::Mysql(pool, _bare)) => exec_tx_mysql_inner(pool, statements, start).await,
        Some(TxPath::Sqlite(pool)) => exec_tx_sqlite_inner(pool, statements, start).await,
        Some(TxPath::Explicit) => {
            let mysql_dialect = connection_mysql_query_dialect(state, connection_id).await;
            exec_tx_explicit_inner(state, &pool_key, mysql_dialect, Some(database), statements, schema, start).await
        }
        Some(TxPath::None) => {
            let mysql_dialect = connection_mysql_query_dialect(state, connection_id).await;
            exec_tx_none_inner(state, &pool_key, mysql_dialect, Some(database), statements, schema, start).await
        }
        None => Err("Connection not found for transaction".to_string()),
    }
}

/// Owned pool variants for safe dispatch across async boundaries.
enum TxPath {
    Pg(deadpool_postgres::Pool),
    Mysql(mysql_async::Pool, bool),
    Sqlite(db::sqlite::SqliteHandle),
    Explicit,
    None,
}

// Each of these acquires a dedicated connection and runs all statements within
// BEGIN ... COMMIT/ROLLBACK, guaranteeing a single physical connection.

async fn exec_tx_pg_inner(
    pool: deadpool_postgres::Pool,
    statements: &[String],
    schema: Option<&str>,
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    let mut client = pool.get().await.map_err(|e| format!("Failed to acquire connection: {}", e))?;
    let had_schema = schema.is_some();
    if let Some(s) = schema {
        client
            .execute(&format!("SET search_path TO {}", db::postgres::pg_quote_ident(s)), &[])
            .await
            .map_err(|e| format!("SET search_path failed: {}", e))?;
    }
    let tx_result = exec_tx_pg_statements(&mut client, statements).await;

    // Always reset search_path so the connection is clean when returned to the pool
    if had_schema {
        let _ = client.execute("RESET search_path", &[]).await;
    }

    match tx_result {
        Ok(total_affected) => Ok(db::QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![],
            affected_rows: total_affected,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        }),
        Err(e) => Err(e),
    }
}

async fn exec_tx_pg_statements(client: &mut deadpool_postgres::Client, statements: &[String]) -> Result<u64, String> {
    let tx = client.transaction().await.map_err(|e| format!("Failed to begin transaction: {}", e))?;
    let mut total_affected: u64 = 0;
    for (i, sql) in statements.iter().enumerate() {
        match tx.execute(sql, &[]).await {
            Ok(affected) => total_affected += affected,
            Err(e) => {
                // Transaction auto-rollbacks on drop
                return Err(format!("Statement {} failed: {}", i + 1, e));
            }
        }
    }
    tx.commit().await.map_err(|e| format!("COMMIT failed: {}", e))?;
    Ok(total_affected)
}

async fn exec_tx_mysql_inner(
    pool: mysql_async::Pool,
    statements: &[String],
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    let mut conn = db::mysql::get_conn_with_health_check(&pool).await?;
    conn.query_drop("START TRANSACTION").await.map_err(|e| format!("Failed to begin transaction: {}", e))?;
    let mut total_affected: u64 = 0;
    for (i, sql) in statements.iter().enumerate() {
        match conn.query_iter(sql).await {
            Ok(result) => total_affected += result.affected_rows(),
            Err(e) => {
                let _ = conn.query_drop("ROLLBACK").await;
                return Err(format!("Statement {} failed: {}", i + 1, e));
            }
        }
    }
    conn.query_drop("COMMIT").await.map_err(|e| format!("COMMIT failed: {}", e))?;
    Ok(db::QueryResult {
        columns: vec![],
        column_types: Vec::new(),
        column_sortables: vec![],
        rows: vec![],
        affected_rows: total_affected,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
    })
}

async fn exec_tx_sqlite_inner(
    pool: db::sqlite::SqliteHandle,
    statements: &[String],
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    let statements = statements.to_vec();
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            conn.execute_batch("BEGIN").map_err(|e| format!("Failed to begin transaction: {}", e))?;
            let mut total_affected: u64 = 0;
            for (i, sql) in statements.iter().enumerate() {
                match conn.execute_batch(sql) {
                    Ok(_) => total_affected += conn.changes(),
                    Err(e) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(format!("Statement {} failed: {}", i + 1, e));
                    }
                }
            }
            conn.execute_batch("COMMIT").map_err(|e| format!("COMMIT failed: {}", e))?;
            Ok(db::QueryResult {
                columns: vec![],
                column_types: Vec::new(),
                column_sortables: vec![],
                rows: vec![],
                affected_rows: total_affected,
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
                session_id: None,
                has_more: false,
            })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn exec_tx_explicit_inner(
    state: &AppState,
    pool_key: &str,
    mysql_dialect: db::mysql::MySqlQueryDialect,
    database: Option<&str>,
    statements: &[String],
    schema: Option<&str>,
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    let conns = state.connections.read().await;
    if let Some(crate::connection::PoolKind::Agent(client)) = conns.get(pool_key) {
        let db_type = connection_database_type_for_pool_key(state, pool_key).await;
        let execution_schema = schema_for_execution_context(db_type, schema);
        let rewritten_statements;
        let statements = if matches!(db_type, Some(DatabaseType::Iris)) {
            rewritten_statements =
                statements.iter().map(|sql| sql_for_execution_context(db_type, sql, schema)).collect::<Vec<_>>();
            rewritten_statements.as_slice()
        } else {
            statements
        };
        let mut client = client.lock().await;
        let result: db::QueryResult = client.execute_transaction(database, statements, execution_schema).await?;
        return Ok(db::QueryResult { execution_time_ms: start.elapsed().as_millis(), ..result });
    }
    drop(conns);

    do_execute(
        state,
        pool_key,
        mysql_dialect,
        database,
        "BEGIN TRANSACTION",
        schema,
        None,
        QueryExecutionOptions::default(),
    )
    .await
    .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    let mut total_affected: u64 = 0;
    for (i, sql) in statements.iter().enumerate() {
        match do_execute(state, pool_key, mysql_dialect, database, sql, schema, None, QueryExecutionOptions::default())
            .await
        {
            Ok(result) => {
                total_affected += result.affected_rows;
            }
            Err(e) => {
                if let Err(rb_err) = do_execute(
                    state,
                    pool_key,
                    mysql_dialect,
                    database,
                    "ROLLBACK",
                    schema,
                    None,
                    QueryExecutionOptions::default(),
                )
                .await
                {
                    log::error!("ROLLBACK failed after statement {} error: {}", i + 1, rb_err);
                }
                return Err(format!("Statement {} failed: {}", i + 1, e));
            }
        }
    }

    do_execute(state, pool_key, mysql_dialect, database, "COMMIT", schema, None, QueryExecutionOptions::default())
        .await
        .map_err(|e| format!("COMMIT failed: {}", e))?;

    Ok(db::QueryResult {
        columns: vec![],
        column_types: Vec::new(),
        column_sortables: vec![],
        rows: vec![],
        affected_rows: total_affected,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
    })
}

async fn exec_tx_none_inner(
    state: &AppState,
    pool_key: &str,
    mysql_dialect: db::mysql::MySqlQueryDialect,
    database: Option<&str>,
    statements: &[String],
    schema: Option<&str>,
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    let mut total_affected: u64 = 0;
    for (i, sql) in statements.iter().enumerate() {
        log::info!("[query][tx-none:statement:start] index={} sql={}", i + 1, sql);
        match do_execute(state, pool_key, mysql_dialect, database, sql, schema, None, QueryExecutionOptions::default())
            .await
        {
            Ok(result) => {
                total_affected += result.affected_rows;
                log::info!("[query][tx-none:statement:done] index={} affected_rows={}", i + 1, result.affected_rows);
            }
            Err(e) => {
                log::warn!("Statement {} failed (no transaction support): {}", i + 1, e);
                return Err(format!(
                    "Statement {} failed: {}. No transaction support for this database type.",
                    i + 1,
                    e
                ));
            }
        }
    }

    Ok(db::QueryResult {
        columns: vec![],
        column_types: Vec::new(),
        column_sortables: vec![],
        rows: vec![],
        affected_rows: total_affected,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::{default_redis_key_separator, ConnectionConfig, DatabaseType};

    #[tokio::test]
    async fn wait_for_query_returns_cancelled_when_token_is_cancelled() {
        let token = CancellationToken::new();
        token.cancel();

        let result = wait_for_query(Some(token), async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(db::QueryResult {
                columns: vec![],
                column_types: Vec::new(),
                column_sortables: vec![],
                rows: vec![],
                affected_rows: 0,
                execution_time_ms: 0,
                truncated: false,
                session_id: None,
                has_more: false,
            })
        })
        .await;

        assert_eq!(result.unwrap_err(), QUERY_CANCELED);
    }

    #[tokio::test]
    async fn wait_for_query_without_token_still_times_out() {
        let result = wait_for_query_with_timeout(None, Duration::from_millis(10), async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok(db::QueryResult {
                columns: vec![],
                column_types: Vec::new(),
                column_sortables: vec![],
                rows: vec![],
                affected_rows: 0,
                execution_time_ms: 0,
                truncated: false,
                session_id: None,
                has_more: false,
            })
        })
        .await;

        assert_eq!(result.unwrap_err(), timeout_error());
    }

    #[cfg(feature = "duckdb-bundled")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn duckdb_timeout_interrupts_running_task_and_releases_connection() {
        let con = std::sync::Arc::new(std::sync::Mutex::new(duckdb::Connection::open_in_memory().unwrap()));
        let interrupt_handle = con.lock().unwrap().interrupt_handle();
        let running_con = con.clone();
        let task = tokio::task::spawn_blocking(move || {
            let con = running_con.lock().map_err(|e| e.to_string())?;
            duckdb_execute_with_max_rows(&con, "SELECT sum(sin(i::DOUBLE)) FROM range(10000000000) tbl(i)", None)
        });

        let result =
            wait_for_duckdb_task_with_interrupt(None, Some(Duration::from_millis(10)), interrupt_handle, task).await;

        assert_eq!(result.unwrap_err(), timeout_error());

        let follow_con = con.clone();
        let follow_up = timeout(
            Duration::from_secs(5),
            tokio::task::spawn_blocking(move || {
                let con = follow_con.lock().map_err(|e| e.to_string())?;
                duckdb_execute_with_max_rows(&con, "SELECT 1", None)
            }),
        )
        .await
        .expect("DuckDB connection should be released after timeout")
        .expect("follow-up task should not panic")
        .expect("follow-up query should succeed");

        assert_eq!(follow_up.rows, vec![vec![serde_json::json!(1)]]);
    }

    #[test]
    fn is_connection_error_detects_english_messages() {
        assert!(is_connection_error("connection reset"));
        assert!(is_connection_error("broken pipe"));
        assert!(is_connection_error("reset by peer"));
        assert!(is_connection_error("Connection timed out"));
        assert!(is_connection_error("socket closed"));
        assert!(is_connection_error("unexpected eof"));
        assert!(is_connection_error("Error occurred while creating a new object: error communicating with the server"));
    }

    #[test]
    fn is_connection_error_detects_oracle_idle_timeout() {
        assert!(is_connection_error("ORA-02396: exceeded maximum idle time, please connect again"));
        assert!(is_connection_error(
            "Agent RPC error (-32603): ORA-02396: exceeded maximum idle time, please connect again"
        ));
        assert!(is_connection_error("ORA-03113: end-of-file on communication channel"));
        assert!(is_connection_error("ORA-03114: not connected to Oracle"));
        assert!(is_connection_error("ORA-03135: connection lost contact"));
        assert!(is_connection_error("Agent RPC error (-1): java.sql.SQLRecoverableException: 关闭的连接"));
        assert!(is_connection_error("java.sql.SQLRecoverableException: 连接已关闭"));
    }

    #[test]
    fn is_connection_error_detects_localized_io_errors() {
        assert!(is_connection_error("I/O error: 远程主机强迫关闭了一个现有的连接。 (os error 10054)"));
        assert!(is_connection_error(
            "I/O error: 由于连接方在一段时间后没有正确答复或连接的主机没有反应，连接尝试失败。 (os error 10060)"
        ));
    }

    #[test]
    fn is_connection_error_detects_os_error_codes() {
        assert!(is_connection_error("os error 10053"));
        assert!(is_connection_error("os error 10054"));
        assert!(is_connection_error("os error 10060"));
        assert!(is_connection_error("os error 10061"));
    }

    #[test]
    fn is_connection_error_rejects_non_connection_errors() {
        assert!(!is_connection_error("Query timed out after 30 seconds"));
        assert!(!is_connection_error("ORA-00942: table or view does not exist"));
        assert!(!is_connection_error("syntax error at position 5"));
        assert!(!is_connection_error("os error 13"));
    }

    #[test]
    fn pool_error_action_discards_sqlserver_driver_panic_without_retry() {
        let err = format!("{} the current client will be rebuilt.", db::sqlserver::SQLSERVER_DRIVER_PANIC_ERROR_PREFIX);

        assert_eq!(pool_error_action(Some(DatabaseType::SqlServer), &err), PoolErrorAction::Discard);
        assert!(should_discard_pool_after_error(Some(DatabaseType::SqlServer), &err));
        assert!(!is_connection_error(&err));
    }

    #[test]
    fn pool_error_action_discards_sqlserver_timeout_without_retry() {
        let err = "Query timed out after 30 seconds";

        assert_eq!(pool_error_action(Some(DatabaseType::SqlServer), err), PoolErrorAction::Discard);
        assert_eq!(pool_error_action(Some(DatabaseType::Mysql), err), PoolErrorAction::Keep);
    }

    #[test]
    fn pool_error_action_reconnects_connection_errors() {
        let err = "connection reset by peer";

        assert_eq!(pool_error_action(Some(DatabaseType::SqlServer), err), PoolErrorAction::ReconnectAndRetry);
        assert_eq!(pool_error_action(Some(DatabaseType::Postgres), err), PoolErrorAction::ReconnectAndRetry);
    }

    #[cfg(feature = "duckdb-bundled")]
    #[test]
    fn duckdb_execute_preserves_double_precision() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        let result = duckdb_execute(
            &con,
            "SELECT 12.34567::DOUBLE AS sample, 0.5::DOUBLE AS half, 99.99::DOUBLE AS price, 1.0::DOUBLE AS one",
        )
        .expect("execute double query");

        assert_eq!(result.columns, vec!["sample", "half", "price", "one"]);
        let row = &result.rows[0];
        assert_eq!(row[0], serde_json::json!(12.34567));
        assert_eq!(row[1], serde_json::json!(0.5));
        assert_eq!(row[2], serde_json::json!(99.99));
        assert_eq!(row[3], serde_json::json!(1.0));
    }

    #[cfg(feature = "duckdb-bundled")]
    #[test]
    fn duckdb_execute_create_insert_select_double() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        con.execute_batch("CREATE TABLE tmp1 (tmp_double DOUBLE)").expect("create table");
        con.execute_batch("INSERT INTO tmp1 VALUES (45.678), (12.345), (99.999)").expect("insert");

        let result = duckdb_execute(&con, "SELECT tmp_double FROM tmp1 ORDER BY tmp_double").expect("select doubles");

        assert_eq!(result.rows.len(), 3);
        assert_eq!(result.rows[0][0], serde_json::json!(12.345));
        assert_eq!(result.rows[1][0], serde_json::json!(45.678));
        assert_eq!(result.rows[2][0], serde_json::json!(99.999));
    }

    #[cfg(feature = "duckdb-bundled")]
    #[test]
    fn duckdb_execute_returns_rows_for_from_first_query() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        con.execute_batch("CREATE TABLE users (id INTEGER, name VARCHAR)").expect("create table");
        con.execute_batch("INSERT INTO users VALUES (2, 'Grace'), (1, 'Ada')").expect("insert");

        let result = duckdb_execute(&con, "FROM users ORDER BY id").expect("execute from-first query");

        assert_eq!(result.columns, vec!["id", "name"]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0], vec![serde_json::json!(1), serde_json::json!("Ada")]);
        assert_eq!(result.rows[1], vec![serde_json::json!(2), serde_json::json!("Grace")]);
    }

    #[cfg(feature = "duckdb-bundled")]
    #[test]
    fn duckdb_execute_returns_rows_for_summarize_query() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        con.execute_batch("CREATE TABLE metrics (value INTEGER)").expect("create table");
        con.execute_batch("INSERT INTO metrics VALUES (1), (2), (NULL)").expect("insert");

        let result = duckdb_execute(&con, "SUMMARIZE metrics").expect("execute summarize query");

        assert!(!result.columns.is_empty());
        assert!(!result.rows.is_empty());
    }

    #[cfg(feature = "duckdb-bundled")]
    #[test]
    fn duckdb_execute_handles_various_types() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        let result = duckdb_execute(
            &con,
            "SELECT 42 AS int_val, true AS bool_val, 'hello' AS text_val, 3.14::FLOAT AS float_val, 123456789012345::BIGINT AS big_val",
        )
        .expect("execute mixed types query");

        let row = &result.rows[0];
        assert_eq!(row[0], serde_json::json!(42));
        assert_eq!(row[1], serde_json::json!(true));
        assert_eq!(row[2], serde_json::Value::String("hello".to_string()));
        assert!(row[3].is_number());
        assert_eq!(row[4], serde_json::json!(123456789012345_i64));
    }

    #[cfg(feature = "duckdb-bundled")]
    #[test]
    fn duckdb_execute_returns_list_values_as_json_arrays() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        let result = duckdb_execute(&con, "SELECT ['a','b','c','d'];").expect("execute list query");

        assert_eq!(result.rows, vec![vec![serde_json::json!(["a", "b", "c", "d"])]]);
    }

    #[cfg(feature = "duckdb-bundled")]
    #[test]
    fn duckdb_execute_preserves_nulls_inside_list_values() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        let result = duckdb_execute(&con, "SELECT [1, NULL, 3] AS items;").expect("execute nullable list query");

        assert_eq!(result.columns, vec!["items"]);
        assert_eq!(result.rows, vec![vec![serde_json::json!([1, null, 3])]]);
    }

    #[cfg(feature = "duckdb-bundled")]
    #[test]
    fn duckdb_execute_returns_nested_complex_values_as_json() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        let result = duckdb_execute(
            &con,
            "SELECT {'name': 'Ada', 'scores': [10, 20]} AS profile, MAP(['x', 'y'], [1, 2]) AS lookup, [1, 2, 3]::INTEGER[3] AS fixed_items",
        )
        .expect("execute complex values query");

        assert_eq!(result.columns, vec!["profile", "lookup", "fixed_items"]);
        assert_eq!(
            result.rows,
            vec![vec![
                serde_json::json!({ "name": "Ada", "scores": [10, 20] }),
                serde_json::json!([
                    { "key": "x", "value": 1 },
                    { "key": "y", "value": 2 },
                ]),
                serde_json::json!([1, 2, 3]),
            ]]
        );
    }

    #[cfg(feature = "duckdb-bundled")]
    #[test]
    fn duckdb_execute_formats_temporal_values_by_column_type() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        let result = duckdb_execute(
            &con,
            "SELECT DATE '2026-05-14' AS d, TIME '16:58:15' AS t, TIMESTAMP '2026-05-14 16:58:15.0' AS ts, NULL::TIMESTAMP AS nts",
        )
        .expect("execute temporal query");

        assert_eq!(result.columns, vec!["d", "t", "ts", "nts"]);
        assert_eq!(
            result.rows,
            vec![vec![
                serde_json::Value::String("2026-05-14".to_string()),
                serde_json::Value::String("16:58:15".to_string()),
                serde_json::Value::String("2026-05-14 16:58:15".to_string()),
                serde_json::Value::Null,
            ]]
        );
    }

    #[test]
    fn external_driver_query_params_include_database_and_schema_context() {
        let config = ConnectionConfig {
            id: "jdbc-1".to_string(),
            name: "JDBC".to_string(),
            db_type: DatabaseType::Jdbc,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: "localhost".to_string(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            attached_databases: Vec::new(),
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 0,
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: Some("jdbc:h2:mem:test".to_string()),
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: default_redis_key_separator(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
        };

        let params = external_driver_query_params(
            &config,
            "SELECT * FROM events",
            "analytics",
            Some("app"),
            &QueryExecutionOptions {
                max_rows: Some(500),
                fetch_size: Some(250),
                timeout_secs: Some(600),
                ..Default::default()
            },
        );

        assert_eq!(params["connection"]["id"], "jdbc-1");
        assert_eq!(params["sql"], "SELECT * FROM events");
        assert_eq!(params["database"], "analytics");
        assert_eq!(params["schema"], "app");
        assert_eq!(params["maxRows"], 500);
        assert_eq!(params["fetchSize"], 250);
        assert_eq!(params["timeoutSecs"], 600);
    }

    #[test]
    fn agent_execute_query_params_include_row_and_fetch_limits() {
        let params = agent_execute_query_params(
            "SELECT * FROM events",
            Some("analytics"),
            Some("app"),
            QueryExecutionOptions {
                max_rows: Some(500),
                fetch_size: Some(250),
                timeout_secs: Some(600),
                ..Default::default()
            },
        );

        assert_eq!(params["sql"], "SELECT * FROM events");
        assert_eq!(params["database"], "analytics");
        assert_eq!(params["schema"], "app");
        assert_eq!(params["maxRows"], 500);
        assert_eq!(params["fetchSize"], 250);
        assert_eq!(params["timeoutSecs"], 600);
    }

    #[test]
    fn iris_execution_context_omits_schema() {
        assert_eq!(schema_for_execution_context(Some(DatabaseType::Iris), Some("SQLUser")), None);
        assert_eq!(schema_for_execution_context(Some(DatabaseType::Oracle), Some("APP")), Some("APP"));
        assert_eq!(schema_for_execution_context(None, Some("APP")), Some("APP"));
    }

    #[test]
    fn iris_execution_context_qualifies_unqualified_dml_tables() {
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Iris), "SELECT * FROM TABLES", Some("INFORMATION_SCHEMA")),
            "SELECT * FROM \"INFORMATION_SCHEMA\".TABLES"
        );
        let qualified_join = sql_for_execution_context(
            Some(DatabaseType::Iris),
            "SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id",
            Some("Sales"),
        );
        assert!(qualified_join.contains("FROM \"Sales\".orders"));
        assert!(qualified_join.contains("JOIN \"Sales\".customers"));
        assert!(qualified_join.contains("c.id = o.customer_id"));
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Iris), "SELECT * FROM INFORMATION_SCHEMA.TABLES", Some("APP")),
            "SELECT * FROM INFORMATION_SCHEMA.TABLES"
        );
    }

    #[test]
    fn iris_execution_context_qualifies_nested_dml_tables_but_not_ctes() {
        assert_eq!(
            sql_for_execution_context(
                Some(DatabaseType::Iris),
                "WITH recent AS (SELECT * FROM events) SELECT * FROM recent WHERE EXISTS (SELECT 1 FROM audits)",
                Some("APP")
            ),
            "WITH recent AS (SELECT * FROM \"APP\".events) SELECT * FROM recent WHERE EXISTS (SELECT 1 FROM \"APP\".audits)"
        );
        assert_eq!(
            sql_for_execution_context(
                Some(DatabaseType::Iris),
                "INSERT INTO events SELECT * FROM staging_events",
                Some("APP")
            ),
            "INSERT INTO \"APP\".events SELECT * FROM \"APP\".staging_events"
        );
        assert_eq!(
            sql_for_execution_context(
                Some(DatabaseType::Iris),
                "UPDATE events SET status = 'done' WHERE id IN (SELECT event_id FROM audit_events)",
                Some("APP")
            ),
            "UPDATE \"APP\".events SET status = 'done' WHERE id IN (SELECT event_id FROM \"APP\".audit_events)"
        );
    }

    #[test]
    fn iris_execution_context_leaves_ddl_and_unparseable_sql_unchanged() {
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Iris), "CREATE TABLE events (id INT)", Some("APP")),
            "CREATE TABLE events (id INT)"
        );
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Iris), "SELECT %ID FROM", Some("APP")),
            "SELECT %ID FROM"
        );
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Postgres), "SELECT * FROM events", Some("APP")),
            "SELECT * FROM events"
        );
    }

    #[test]
    fn parses_postgres_drop_database_target() {
        assert_eq!(parse_drop_database_target("DROP DATABASE vaultwarden;"), Some("vaultwarden".to_string()));
        assert_eq!(parse_drop_database_target("drop database if exists \"app db\";"), Some("app db".to_string()));
        assert_eq!(
            parse_drop_database_target("/*x*/ DROP DATABASE \"app\"\"db\" -- trailing\n;"),
            Some("app\"db".to_string())
        );
    }

    #[test]
    fn ignores_non_single_drop_database_statements() {
        assert_eq!(parse_drop_database_target("DROP TABLE vaultwarden;"), None);
        assert_eq!(parse_drop_database_target("DROP DATABASE vaultwarden; SELECT 1;"), None);
        assert_eq!(parse_drop_database_target("DROP DATABASE 123bad;"), None);
    }

    #[test]
    fn chooses_safe_postgres_drop_database_admin_database() {
        assert_eq!(postgres_drop_database_admin_database("vaultwarden"), "postgres");
        assert_eq!(postgres_drop_database_admin_database("postgres"), "template1");
    }

    #[test]
    fn agent_execute_query_params_default_to_safety_row_limit() {
        let params = agent_execute_query_params("SELECT * FROM events", None, None, QueryExecutionOptions::default());

        assert_eq!(params["sql"], "SELECT * FROM events");
        assert!(params.get("database").is_none());
        assert!(params.get("schema").is_none());
        assert_eq!(params["maxRows"], MAX_ROWS);
        assert!(params.get("fetchSize").is_none());
        assert!(params.get("timeoutSecs").is_none());
    }

    #[test]
    fn agent_execute_query_page_params_include_page_fetch_and_safety_limits() {
        let params = agent_execute_query_page_params(
            "SELECT * FROM events",
            Some("analytics"),
            Some("app"),
            QueryExecutionOptions {
                page_size: Some(500),
                fetch_size: Some(250),
                timeout_secs: Some(600),
                ..Default::default()
            },
        );

        assert_eq!(params["sql"], "SELECT * FROM events");
        assert_eq!(params["database"], "analytics");
        assert_eq!(params["schema"], "app");
        assert_eq!(params["pageSize"], 500);
        assert_eq!(params["fetchSize"], 250);
        assert_eq!(params["timeoutSecs"], 600);
        assert_eq!(params["maxRows"], MAX_ROWS);
    }

    #[test]
    fn agent_fetch_query_page_params_include_session_and_page_size() {
        let params = agent_fetch_query_page_params("session-1", 500);

        assert_eq!(params["sessionId"], "session-1");
        assert_eq!(params["pageSize"], 500);
    }

    #[test]
    fn agent_close_query_session_params_include_session() {
        let params = agent_close_query_session_params("session-1");

        assert_eq!(params["sessionId"], "session-1");
    }

    #[test]
    fn agent_timeout_discards_pool_but_does_not_retry_same_query() {
        assert!(should_discard_agent_pool_after_error("Query timed out after 30 seconds"));
        assert!(should_discard_agent_pool_after_error("Agent RPC call timed out (30s)"));
        assert!(!is_connection_error("Agent RPC call timed out (30s)"));
        assert_eq!(
            pool_error_action(Some(DatabaseType::Oracle), "Agent RPC call timed out (30s)"),
            PoolErrorAction::Discard
        );
    }

    #[test]
    fn unavailable_agent_pipes_are_reconnectable_errors() {
        assert!(should_discard_agent_pool_after_error("Agent stdin not available"));
        assert!(should_discard_agent_pool_after_error("Agent stdout not available"));
        assert!(is_connection_error("Agent stdin not available"));
        assert!(is_connection_error("Agent stdout not available"));
        assert_eq!(
            pool_error_action(Some(DatabaseType::Oracle), "Agent stdin not available"),
            PoolErrorAction::ReconnectAndRetry
        );
    }

    #[test]
    fn query_results_convert_unsafe_json_integers_to_strings_for_js() {
        let result = db::QueryResult {
            columns: vec!["id".to_string(), "nested".to_string()],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![vec![
                serde_json::json!(2_041_797_190_226_354_178_i64),
                serde_json::json!([1, 2_041_797_190_226_354_178_i64]),
            ]],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
        };

        let normalized = normalize_query_result_for_js(result);

        assert_eq!(normalized.rows[0][0], serde_json::json!("2041797190226354178"));
        assert_eq!(normalized.rows[0][1], serde_json::json!([1, "2041797190226354178"]));
    }
}
