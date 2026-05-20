use chrono::{DateTime, Duration as ChronoDuration, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use duckdb::types::{TimeUnit, ValueRef};
use std::future::Future;
use std::time::Duration;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::sql::{split_sql_batches, split_sql_statements, starts_with_executable_sql_keyword};

pub const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_ROWS: usize = 10000;
pub const QUERY_CANCELED: &str = "Query canceled";

#[derive(Clone, Debug, Default)]
pub struct QueryExecutionOptions {
    pub max_rows: Option<usize>,
    pub fetch_size: Option<usize>,
    pub page_size: Option<usize>,
    pub result_session_id: Option<String>,
}

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(MAX_ROWS).max(1)
}

pub fn duckdb_execute(con: &duckdb::Connection, sql: &str) -> Result<db::QueryResult, String> {
    duckdb_execute_with_max_rows(con, sql, None)
}

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
        _ => row.get::<_, String>(idx).map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
    }
}

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

fn duckdb_date32_to_string(days: i32) -> Option<String> {
    let epoch = NaiveDate::from_ymd_opt(1970, 1, 1)?;
    epoch.checked_add_signed(ChronoDuration::days(i64::from(days))).map(|date| date.to_string())
}

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

fn duckdb_timestamp_to_string(unit: TimeUnit, value: i64) -> Option<String> {
    let nanos = duckdb_time_unit_to_nanos(unit, value)?;
    let seconds = nanos.div_euclid(1_000_000_000);
    let nanos_remainder = nanos.rem_euclid(1_000_000_000) as u32;
    let dt: DateTime<Utc> = DateTime::from_timestamp(seconds, nanos_remainder)?;
    Some(format_naive_datetime(dt.naive_utc()))
}

fn duckdb_time_unit_to_nanos(unit: TimeUnit, value: i64) -> Option<i64> {
    match unit {
        TimeUnit::Second => value.checked_mul(1_000_000_000),
        TimeUnit::Millisecond => value.checked_mul(1_000_000),
        TimeUnit::Microsecond => value.checked_mul(1_000),
        TimeUnit::Nanosecond => Some(value),
    }
}

fn format_naive_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%d %H:%M:%S").to_string()
    } else {
        format_temporal_without_empty_fraction(value.to_string())
    }
}

fn format_temporal_without_empty_fraction(value: String) -> String {
    if !value.contains('.') {
        return value;
    }
    let trimmed = value.trim_end_matches('0').trim_end_matches('.');
    trimmed.to_string()
}

pub fn duckdb_execute_with_max_rows(
    con: &duckdb::Connection,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<db::QueryResult, String> {
    let start = std::time::Instant::now();
    let row_limit = query_result_row_limit(max_rows);

    if starts_with_executable_sql_keyword(sql, &["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH", "PRAGMA"]) {
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
            rows: vec![],
            affected_rows: affected as u64,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

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

pub fn agent_execute_query_params(
    sql: &str,
    schema: Option<&str>,
    options: QueryExecutionOptions,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "sql": sql,
        "maxRows": options.max_rows.unwrap_or(MAX_ROWS),
    });
    if let Some(schema) = schema {
        params["schema"] = serde_json::json!(schema);
    }
    if let Some(fetch_size) = options.fetch_size {
        params["fetchSize"] = serde_json::json!(fetch_size);
    }
    params
}

pub fn agent_execute_query_page_params(
    sql: &str,
    schema: Option<&str>,
    options: QueryExecutionOptions,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "sql": sql,
        "pageSize": options.page_size.unwrap_or(MAX_ROWS),
        "maxRows": options.max_rows.unwrap_or(MAX_ROWS),
    });
    if let Some(schema) = schema {
        params["schema"] = serde_json::json!(schema);
    }
    if let Some(fetch_size) = options.fetch_size {
        params["fetchSize"] = serde_json::json!(fetch_size);
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
    lower.contains("connection")
        || lower.contains("broken pipe")
        || lower.contains("reset by peer")
        || lower.contains("timed out")
        || lower.contains("closed")
        || lower.contains("eof")
        || lower.contains("i/o error")
        || is_os_connection_error(&lower)
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

pub async fn do_execute(
    state: &AppState,
    pool_key: &str,
    database: Option<&str>,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, String> {
    let duckdb_attached_names = state
        .configs
        .read()
        .await
        .get(pool_key)
        .map(|config| config.attached_databases.iter().map(|database| database.name.clone()).collect::<Vec<_>>())
        .unwrap_or_default();
    let connections = state.connections.read().await;
    let pool = connections.get(pool_key).ok_or("Connection not found")?;

    match pool {
        PoolKind::DuckDb(con) => {
            let con = con.clone();
            let sql = sql.to_string();
            let database = database.map(str::to_string);
            let attached_names = duckdb_attached_names;
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query(cancel_token, async move {
                let task = tokio::task::spawn_blocking(move || {
                    let con = con.lock().map_err(|e| e.to_string())?;
                    duckdb_execute_for_database(&con, &attached_names, database.as_deref(), &sql, max_rows)
                });
                task.await.map_err(|e| e.to_string())?
            })
            .await
        }
        PoolKind::Mysql(p, mode) => {
            let p = p.clone();
            let bare = *mode == crate::connection::MysqlMode::Bare;
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query(cancel_token, db::mysql::execute_query_with_max_rows(&p, sql, bare, max_rows)).await
        }
        PoolKind::Postgres(p) => {
            let p = p.clone();
            let schema = schema.map(|s| s.to_string());
            let max_rows = options.max_rows;
            drop(connections);
            if let Some(schema) = schema {
                wait_for_query(
                    cancel_token,
                    db::postgres::execute_query_with_schema_and_max_rows(&p, &schema, sql, max_rows),
                )
                .await
            } else {
                wait_for_query(cancel_token, db::postgres::execute_query_with_max_rows(&p, sql, max_rows)).await
            }
        }
        PoolKind::Sqlite(p) => {
            let p = p.clone();
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query(cancel_token, db::sqlite::execute_query_with_max_rows(&p, sql, max_rows)).await
        }
        PoolKind::ClickHouse(client) => {
            let client = client.clone();
            let database = pool_key.split(':').nth(1).unwrap_or("default").to_string();
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query(
                cancel_token,
                db::clickhouse_driver::execute_query_with_max_rows(&client, &database, sql, max_rows),
            )
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows))
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
            wait_for_query(cancel_token, db::sqlserver::execute_query_with_max_rows(&mut client, sql, max_rows))
                .await
                .map(|result| truncate_result_with_max_rows(result, max_rows))
        }
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            let sql = sql.to_string();
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query(cancel_token, db::elasticsearch_driver::execute_rest_query(&client, &sql))
                .await
                .map(|result| truncate_result_with_max_rows(result, max_rows))
        }
        PoolKind::Redis(_) => Err("Use Redis-specific commands".to_string()),
        PoolKind::MongoDb(_) => Err("Use MongoDB-specific commands".to_string()),
        PoolKind::Agent(client) => {
            let client = client.clone();
            let sql = sql.to_string();
            let schema = schema.map(|s| s.to_string());
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query(cancel_token, async move {
                let mut client = client.lock().await;
                if let Some(session_id) = options.result_session_id.as_deref() {
                    let params = agent_fetch_query_page_params(session_id, options.page_size.unwrap_or(MAX_ROWS));
                    client.fetch_query_page(params).await
                } else if options.page_size.is_some() {
                    let params = agent_execute_query_page_params(&sql, schema.as_deref(), options);
                    client.execute_query_page(params).await
                } else {
                    let params = agent_execute_query_params(&sql, schema.as_deref(), options);
                    client.execute_query(params).await
                }
            })
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows))
        }
        PoolKind::ExternalTabular(ext_pool) => {
            if !starts_with_executable_sql_keyword(sql, &["SELECT", "WITH", "SHOW", "DESCRIBE", "EXPLAIN", "PRAGMA"]) {
                return Err("External data sources are read-only. Only SELECT queries are supported.".to_string());
            }
            let con = ext_pool.cache.clone();
            let sql = sql.to_string();
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query(cancel_token, async move {
                let task = tokio::task::spawn_blocking(move || {
                    let con = con.lock().map_err(|e| e.to_string())?;
                    duckdb_execute_with_max_rows(&con, &sql, max_rows)
                });
                task.await.map_err(|e| e.to_string())?
            })
            .await
        }
        PoolKind::ExternalDriver { config, session, .. } => {
            let config = config.clone();
            let session = session.clone();
            let sql = sql.to_string();
            let schema = schema.map(str::to_string);
            let database = config.effective_database().unwrap_or("").to_string();
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query(cancel_token, async move {
                let params = external_driver_query_params(&config, &sql, &database, schema.as_deref());
                session.invoke::<db::QueryResult>("executeQuery", params).await
            })
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows))
        }
    }
}

fn external_driver_query_params(
    config: &crate::models::connection::ConnectionConfig,
    sql: &str,
    database: &str,
    schema: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "connection": config,
        "sql": sql,
        "database": database,
        "schema": schema,
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
    let pool_key = if database.is_empty() {
        connection_id.to_string()
    } else {
        state.get_or_create_pool(connection_id, Some(database)).await?
    };

    if is_canceled(&cancel_token) {
        return Err(canceled_error());
    }

    let result = do_execute(state, &pool_key, Some(database), sql, schema, cancel_token.clone(), options.clone()).await;

    match &result {
        Err(e) if is_connection_error(e) && !is_canceled(&cancel_token) => {
            let db_opt = if database.is_empty() { None } else { Some(database) };
            let new_key = state.reconnect_pool(connection_id, db_opt).await?;
            do_execute(state, &new_key, Some(database), sql, schema, cancel_token, options).await
        }
        _ => result,
    }
}

pub async fn close_query_session(
    state: &AppState,
    connection_id: &str,
    database: &str,
    session_id: &str,
) -> Result<bool, String> {
    let pool_key = if database.is_empty() {
        connection_id.to_string()
    } else {
        state.get_or_create_pool(connection_id, Some(database)).await?
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
    let pool_key = if database.is_empty() {
        connection_id.to_string()
    } else {
        state.get_or_create_pool(connection_id, Some(database)).await?
    };

    let is_sqlserver = {
        let connections = state.connections.read().await;
        matches!(connections.get(&pool_key), Some(PoolKind::SqlServer(_)))
    };

    if is_sqlserver {
        return execute_multi_sqlserver(state, &pool_key, sql, cancel_token, options).await;
    }

    let statements = split_sql_statements(sql);
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

    let mut results = Vec::with_capacity(statements.len());
    for stmt in &statements {
        if is_canceled(&cancel_token) {
            results.push(db::QueryResult {
                columns: vec!["Error".to_string()],
                rows: vec![vec![serde_json::Value::String(canceled_error())]],
                affected_rows: 0,
                execution_time_ms: 0,
                truncated: false,
                session_id: None,
                has_more: false,
            });
            break;
        }
        match execute_sql_statement(state, connection_id, database, stmt, schema, cancel_token.clone()).await {
            Ok(r) => results.push(r),
            Err(e) => {
                results.push(db::QueryResult {
                    columns: vec!["Error".to_string()],
                    rows: vec![vec![serde_json::Value::String(e)]],
                    affected_rows: 0,
                    execution_time_ms: 0,
                    truncated: false,
                    session_id: None,
                    has_more: false,
                });
            }
        }
    }

    Ok(results)
}

async fn execute_multi_sqlserver(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<Vec<db::QueryResult>, String> {
    let batches = split_sql_batches(sql);
    let mut all_results = Vec::new();
    let max_rows = options.max_rows;

    for batch in &batches {
        if is_canceled(&cancel_token) {
            all_results.push(db::QueryResult {
                columns: vec!["Error".to_string()],
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

        match db::sqlserver::execute_batch_with_max_rows(&mut client, batch, max_rows).await {
            Ok(results) => all_results.extend(results),
            Err(e) => {
                all_results.push(db::QueryResult {
                    columns: vec!["Error".to_string()],
                    rows: vec![vec![serde_json::Value::String(e)]],
                    affected_rows: 0,
                    execution_time_ms: 0,
                    truncated: false,
                    session_id: None,
                    has_more: false,
                });
            }
        }
    }

    if all_results.is_empty() {
        all_results.push(db::QueryResult {
            columns: vec![],
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
) -> Result<db::QueryResult, String> {
    let pool_key = if database.is_empty() {
        connection_id.to_string()
    } else {
        state.get_or_create_pool(connection_id, Some(database)).await?
    };

    let mut total_affected: u64 = 0;
    let start = std::time::Instant::now();

    for (i, sql) in statements.iter().enumerate() {
        match do_execute(state, &pool_key, Some(database), sql, schema, None, QueryExecutionOptions::default()).await {
            Ok(result) => {
                total_affected += result.affected_rows;
            }
            Err(e) => {
                if is_connection_error(&e) {
                    let db_opt = if database.is_empty() { None } else { Some(database) };
                    let _ = state.reconnect_pool(connection_id, db_opt).await;
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
        rows: vec![],
        affected_rows: total_affected,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
    })
}

/// Execute multiple SQL statements within a single transaction.
/// For sqlx-based pools (Postgres/MySQL/SQLite), uses the Transaction API to
/// guarantee all statements run on the same physical connection.
/// For custom drivers (ClickHouse/SqlServer/Agent), uses explicit
/// BEGIN/COMMIT/ROLLBACK on the already-single-connection client.
/// For databases that don't support explicit transactions (Redis, MongoDB, Oracle),
/// executes statements sequentially without transaction.
/// If BEGIN fails, returns an error — no silent fallback to auto-commit.
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

    let start = std::time::Instant::now();

    // Clone the pool handle within the lock, then drop it before any async work.
    let path = {
        let conns = state.connections.read().await;
        conns.get(&pool_key).map(|p| match p {
            PoolKind::Postgres(pg) => TxPath::Pg(pg.clone()),
            PoolKind::Mysql(mp, _mode) => TxPath::Mysql(mp.clone(), false),
            PoolKind::Sqlite(sq) => TxPath::Sqlite(sq.clone()),
            PoolKind::ClickHouse(_) | PoolKind::SqlServer(_) | PoolKind::Agent(_) => TxPath::Explicit,
            PoolKind::DuckDb(_)
            | PoolKind::Redis(_)
            | PoolKind::MongoDb(_)
            | PoolKind::Elasticsearch(_)
            | PoolKind::ExternalTabular(_)
            | PoolKind::ExternalDriver { .. } => TxPath::None,
        })
    };

    match path {
        Some(TxPath::Pg(pool)) => exec_tx_pg_inner(pool, statements, schema, start).await,
        Some(TxPath::Mysql(pool, _bare)) => exec_tx_mysql_inner(pool, statements, start).await,
        Some(TxPath::Sqlite(pool)) => exec_tx_sqlite_inner(pool, statements, start).await,
        Some(TxPath::Explicit) => exec_tx_explicit_inner(state, &pool_key, statements, schema, start).await,
        Some(TxPath::None) => exec_tx_none_inner(state, &pool_key, statements, schema, start).await,
        None => Err("Connection not found for transaction".to_string()),
    }
}

/// Owned pool variants for safe dispatch across async boundaries.
enum TxPath {
    Pg(sqlx::postgres::PgPool),
    Mysql(sqlx::mysql::MySqlPool, bool),
    Sqlite(sqlx::sqlite::SqlitePool),
    Explicit,
    None,
}

// Each of these acquires a dedicated connection and runs all statements within
// BEGIN ... COMMIT/ROLLBACK, guaranteeing a single physical connection.
// This avoids sqlx::Transaction<T> which has Send/lifetime incompatibility with Tauri macro.

async fn exec_tx_pg_inner(
    pool: sqlx::postgres::PgPool,
    statements: &[String],
    schema: Option<&str>,
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    let mut conn = pool.acquire().await.map_err(|e| format!("Failed to acquire connection: {}", e))?;
    // Set schema first
    if let Some(s) = schema {
        let sp = format!("SET search_path TO \"{}\", public", s);
        sqlx::query(&sp).execute(&mut *conn).await.map_err(|e| format!("SET search_path failed: {}", e))?;
    }
    sqlx::query("BEGIN").execute(&mut *conn).await.map_err(|e| format!("Failed to begin transaction: {}", e))?;
    let mut total_affected: u64 = 0;
    for (i, sql) in statements.iter().enumerate() {
        match sqlx::query(sql).execute(&mut *conn).await {
            Ok(r) => total_affected += r.rows_affected(),
            Err(e) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(format!("Statement {} failed: {}", i + 1, e));
            }
        }
    }
    sqlx::query("COMMIT").execute(&mut *conn).await.map_err(|e| format!("COMMIT failed: {}", e))?;
    Ok(db::QueryResult {
        columns: vec![],
        rows: vec![],
        affected_rows: total_affected,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
    })
}

async fn exec_tx_mysql_inner(
    pool: sqlx::mysql::MySqlPool,
    statements: &[String],
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    let statements = statements.to_vec();
    tokio::task::spawn_blocking(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("Failed to start MySQL transaction runtime: {}", e))?
            .block_on(exec_tx_mysql_raw_inner(pool, statements, start))
    })
    .await
    .map_err(|e| format!("MySQL transaction task failed: {}", e))?
}

async fn exec_tx_mysql_raw_inner(
    pool: sqlx::mysql::MySqlPool,
    statements: Vec<String>,
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    let mut conn = pool.acquire().await.map_err(|e| format!("Failed to acquire connection: {}", e))?;
    sqlx::raw_sql("START TRANSACTION")
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;
    let mut total_affected: u64 = 0;
    for (i, sql) in statements.iter().enumerate() {
        match sqlx::raw_sql(sql).execute(&mut *conn).await {
            Ok(r) => total_affected += r.rows_affected(),
            Err(e) => {
                let _ = sqlx::raw_sql("ROLLBACK").execute(&mut *conn).await;
                return Err(format!("Statement {} failed: {}", i + 1, e));
            }
        }
    }
    sqlx::raw_sql("COMMIT").execute(&mut *conn).await.map_err(|e| format!("COMMIT failed: {}", e))?;
    Ok(db::QueryResult {
        columns: vec![],
        rows: vec![],
        affected_rows: total_affected,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
    })
}

async fn exec_tx_sqlite_inner(
    pool: sqlx::sqlite::SqlitePool,
    statements: &[String],
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    let mut conn = pool.acquire().await.map_err(|e| format!("Failed to acquire connection: {}", e))?;
    sqlx::query("BEGIN").execute(&mut *conn).await.map_err(|e| format!("Failed to begin transaction: {}", e))?;
    let mut total_affected: u64 = 0;
    for (i, sql) in statements.iter().enumerate() {
        match sqlx::query(sql).execute(&mut *conn).await {
            Ok(r) => total_affected += r.rows_affected(),
            Err(e) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(format!("Statement {} failed: {}", i + 1, e));
            }
        }
    }
    sqlx::query("COMMIT").execute(&mut *conn).await.map_err(|e| format!("COMMIT failed: {}", e))?;
    Ok(db::QueryResult {
        columns: vec![],
        rows: vec![],
        affected_rows: total_affected,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
    })
}

async fn exec_tx_explicit_inner(
    state: &AppState,
    pool_key: &str,
    statements: &[String],
    schema: Option<&str>,
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    let conns = state.connections.read().await;
    if let Some(crate::connection::PoolKind::Agent(client)) = conns.get(pool_key) {
        let mut client = client.lock().await;
        let result: db::QueryResult = client.execute_transaction(statements, schema).await?;
        return Ok(db::QueryResult { execution_time_ms: start.elapsed().as_millis(), ..result });
    }
    drop(conns);

    do_execute(state, pool_key, None, "BEGIN TRANSACTION", schema, None, QueryExecutionOptions::default())
        .await
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    let mut total_affected: u64 = 0;
    for (i, sql) in statements.iter().enumerate() {
        match do_execute(state, pool_key, None, sql, schema, None, QueryExecutionOptions::default()).await {
            Ok(result) => {
                total_affected += result.affected_rows;
            }
            Err(e) => {
                if let Err(rb_err) =
                    do_execute(state, pool_key, None, "ROLLBACK", schema, None, QueryExecutionOptions::default()).await
                {
                    log::error!("ROLLBACK failed after statement {} error: {}", i + 1, rb_err);
                }
                return Err(format!("Statement {} failed: {}", i + 1, e));
            }
        }
    }

    do_execute(state, pool_key, None, "COMMIT", schema, None, QueryExecutionOptions::default())
        .await
        .map_err(|e| format!("COMMIT failed: {}", e))?;

    Ok(db::QueryResult {
        columns: vec![],
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
    statements: &[String],
    schema: Option<&str>,
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    let mut total_affected: u64 = 0;
    for (i, sql) in statements.iter().enumerate() {
        log::info!("[query][tx-none:statement:start] index={} sql={}", i + 1, sql);
        match do_execute(state, pool_key, None, sql, schema, None, QueryExecutionOptions::default()).await {
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
    use crate::models::connection::{ConnectionConfig, DatabaseType, ProxyType};

    #[tokio::test]
    async fn wait_for_query_returns_cancelled_when_token_is_cancelled() {
        let token = CancellationToken::new();
        token.cancel();

        let result = wait_for_query(Some(token), async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(db::QueryResult {
                columns: vec![],
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

    #[test]
    fn is_connection_error_detects_english_messages() {
        assert!(is_connection_error("connection reset"));
        assert!(is_connection_error("broken pipe"));
        assert!(is_connection_error("reset by peer"));
        assert!(is_connection_error("Connection timed out"));
        assert!(is_connection_error("socket closed"));
        assert!(is_connection_error("unexpected eof"));
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
        assert!(!is_connection_error("ORA-00942: table or view does not exist"));
        assert!(!is_connection_error("syntax error at position 5"));
        assert!(!is_connection_error("os error 13"));
    }

    #[test]
    fn duckdb_execute_preserves_double_precision() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        let result = duckdb_execute(
            &con,
            "SELECT 3.14159::DOUBLE AS pi, 0.5::DOUBLE AS half, 99.99::DOUBLE AS price, 1.0::DOUBLE AS one",
        )
        .expect("execute double query");

        assert_eq!(result.columns, vec!["pi", "half", "price", "one"]);
        let row = &result.rows[0];
        assert_eq!(row[0], serde_json::json!(3.14159));
        assert_eq!(row[1], serde_json::json!(0.5));
        assert_eq!(row[2], serde_json::json!(99.99));
        assert_eq!(row[3], serde_json::json!(1.0));
    }

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
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_user: String::new(),
            ssh_password: String::new(),
            ssh_key_path: String::new(),
            ssh_key_passphrase: String::new(),
            ssh_expose_lan: false,
            ssh_connect_timeout_secs: 5,
            proxy_enabled: false,
            proxy_type: ProxyType::Socks5,
            proxy_host: String::new(),
            proxy_port: 1080,
            proxy_username: String::new(),
            proxy_password: String::new(),
            ssl: false,
            sysdba: false,
            oracle_connection_type: None,
            connection_string: Some("jdbc:h2:mem:test".to_string()),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
        };

        let params = external_driver_query_params(&config, "SELECT * FROM events", "analytics", Some("app"));

        assert_eq!(params["connection"]["id"], "jdbc-1");
        assert_eq!(params["sql"], "SELECT * FROM events");
        assert_eq!(params["database"], "analytics");
        assert_eq!(params["schema"], "app");
    }

    #[test]
    fn agent_execute_query_params_include_row_and_fetch_limits() {
        let params = agent_execute_query_params(
            "SELECT * FROM events",
            Some("app"),
            QueryExecutionOptions { max_rows: Some(500), fetch_size: Some(250), ..Default::default() },
        );

        assert_eq!(params["sql"], "SELECT * FROM events");
        assert_eq!(params["schema"], "app");
        assert_eq!(params["maxRows"], 500);
        assert_eq!(params["fetchSize"], 250);
    }

    #[test]
    fn agent_execute_query_params_default_to_safety_row_limit() {
        let params = agent_execute_query_params("SELECT * FROM events", None, QueryExecutionOptions::default());

        assert_eq!(params["sql"], "SELECT * FROM events");
        assert!(params.get("schema").is_none());
        assert_eq!(params["maxRows"], MAX_ROWS);
        assert!(params.get("fetchSize").is_none());
    }

    #[test]
    fn agent_execute_query_page_params_include_page_fetch_and_safety_limits() {
        let params = agent_execute_query_page_params(
            "SELECT * FROM events",
            Some("app"),
            QueryExecutionOptions { page_size: Some(500), fetch_size: Some(250), ..Default::default() },
        );

        assert_eq!(params["sql"], "SELECT * FROM events");
        assert_eq!(params["schema"], "app");
        assert_eq!(params["pageSize"], 500);
        assert_eq!(params["fetchSize"], 250);
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
}
