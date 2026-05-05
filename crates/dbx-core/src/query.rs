use std::future::Future;
use std::time::Duration;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::sql::split_sql_statements;

pub const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_ROWS: usize = 10000;
pub const QUERY_CANCELED: &str = "Query canceled";

pub fn duckdb_execute(con: &duckdb::Connection, sql: &str) -> Result<db::QueryResult, String> {
    let start = std::time::Instant::now();
    let trimmed = sql.trim().to_uppercase();

    if trimmed.starts_with("SELECT") || trimmed.starts_with("SHOW") || trimmed.starts_with("DESCRIBE")
        || trimmed.starts_with("EXPLAIN") || trimmed.starts_with("WITH") || trimmed.starts_with("PRAGMA")
    {
        let mut stmt = con.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let stmt_ref = rows.as_ref().ok_or("DuckDB statement unavailable")?;
        let col_count = stmt_ref.column_count();
        let columns: Vec<String> = (0..col_count)
            .map(|i| stmt_ref.column_name(i).map(|s| s.to_string()).unwrap_or_else(|_| "?".to_string()))
            .collect();

        let mut result_rows = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if result_rows.len() >= MAX_ROWS { break; }
            let vals: Vec<serde_json::Value> = (0..col_count).map(|i| {
                row.get::<_, String>(i)
                    .map(serde_json::Value::String)
                    .or_else(|_| row.get::<_, i64>(i).map(|v| serde_json::Value::Number(v.into())))
                    .or_else(|_| row.get::<_, f64>(i).map(|v| {
                        serde_json::Number::from_f64(v)
                            .map(serde_json::Value::Number)
                            .unwrap_or(serde_json::Value::Null)
                    }))
                    .or_else(|_| row.get::<_, bool>(i).map(serde_json::Value::Bool))
                    .unwrap_or(serde_json::Value::Null)
            }).collect();
            result_rows.push(vals);
        }

        let truncated = result_rows.len() >= MAX_ROWS;
        Ok(db::QueryResult { columns, rows: result_rows, affected_rows: 0, execution_time_ms: start.elapsed().as_millis(), truncated })
    } else {
        let affected = con.execute(sql, []).map_err(|e| e.to_string())?;
        Ok(db::QueryResult { columns: vec![], rows: vec![], affected_rows: affected as u64, execution_time_ms: start.elapsed().as_millis(), truncated: false })
    }
}

pub fn truncate_result(mut result: db::QueryResult) -> db::QueryResult {
    if result.rows.len() > MAX_ROWS {
        result.rows.truncate(MAX_ROWS);
        result.truncated = true;
    }
    result
}

pub fn is_connection_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("connection")
        || lower.contains("broken pipe")
        || lower.contains("reset by peer")
        || lower.contains("timed out")
        || lower.contains("closed")
        || lower.contains("eof")
}

pub fn timeout_error() -> String {
    format!("Query timed out after {} seconds", QUERY_TIMEOUT.as_secs())
}

pub fn canceled_error() -> String {
    QUERY_CANCELED.to_string()
}

pub fn is_canceled(cancel_token: &Option<CancellationToken>) -> bool {
    cancel_token
        .as_ref()
        .map(|token| token.is_cancelled())
        .unwrap_or(false)
}

pub async fn wait_for_query<F>(
    cancel_token: Option<CancellationToken>,
    future: F,
) -> Result<db::QueryResult, String>
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
        timeout(timeout_duration, future)
            .await
            .map_err(|_| timeout_error())?
    }
}

pub async fn do_execute(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    cancel_token: Option<CancellationToken>,
) -> Result<db::QueryResult, String> {
    let connections = state.connections.lock().await;
    let pool = connections.get(pool_key).ok_or("Connection not found")?;

    match pool {
        PoolKind::DuckDb(con) => {
            let con = con.clone();
            let sql = sql.to_string();
            drop(connections);
            wait_for_query(cancel_token, async move {
                let task = tokio::task::spawn_blocking(move || {
                    let con = con.lock().map_err(|e| e.to_string())?;
                    duckdb_execute(&con, &sql)
                });
                task.await.map_err(|e| e.to_string())?
            })
            .await
        }
        PoolKind::Mysql(p, bare) => {
            let p = p.clone();
            let bare = *bare;
            drop(connections);
            wait_for_query(cancel_token, db::mysql::execute_query(&p, sql, bare))
                .await
                .map(truncate_result)
        }
        PoolKind::Postgres(p) => {
            let p = p.clone();
            drop(connections);
            wait_for_query(cancel_token, db::postgres::execute_query(&p, sql))
                .await
                .map(truncate_result)
        }
        PoolKind::Sqlite(p) => {
            let p = p.clone();
            drop(connections);
            wait_for_query(cancel_token, db::sqlite::execute_query(&p, sql))
                .await
                .map(truncate_result)
        }
        PoolKind::ClickHouse(client) => {
            let client = client.clone();
            let database = pool_key.split(':').nth(1).unwrap_or("default").to_string();
            drop(connections);
            wait_for_query(cancel_token, db::clickhouse_driver::execute_query(&client, &database, sql))
                .await
                .map(truncate_result)
        }
        PoolKind::SqlServer(client) => {
            let client = client.clone();
            drop(connections);
            let mut client = match cancel_token.as_ref() {
                Some(token) => tokio::select! {
                    biased;
                    _ = token.cancelled() => return Err(canceled_error()),
                    guard = client.lock() => guard,
                },
                None => client.lock().await,
            };
            wait_for_query(cancel_token, db::sqlserver::execute_query(&mut client, sql))
                .await
                .map(truncate_result)
        }
        PoolKind::Oracle(client) => {
            let client = client.clone();
            drop(connections);
            let client = match cancel_token.as_ref() {
                Some(token) => tokio::select! {
                    biased;
                    _ = token.cancelled() => return Err(canceled_error()),
                    guard = client.lock() => guard,
                },
                None => client.lock().await,
            };
            wait_for_query(cancel_token, db::oracle_driver::execute_query(&*client, sql))
                .await
                .map(truncate_result)
        }
        PoolKind::Elasticsearch(_) => Err("Use document browser for Elasticsearch".to_string()),
        PoolKind::Redis(_) => Err("Use Redis-specific commands".to_string()),
        PoolKind::MongoDb(_) => Err("Use MongoDB-specific commands".to_string()),
    }
}

pub async fn execute_sql_statement(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    cancel_token: Option<CancellationToken>,
) -> Result<db::QueryResult, String> {
    let pool_key = if database.is_empty() {
        connection_id.to_string()
    } else {
        state.get_or_create_pool(connection_id, Some(database)).await?
    };

    if is_canceled(&cancel_token) {
        return Err(canceled_error());
    }

    let result = do_execute(state, &pool_key, sql, cancel_token.clone()).await;

    match &result {
        Err(e) if is_connection_error(e) && !is_canceled(&cancel_token) => {
            let db_opt = if database.is_empty() { None } else { Some(database) };
            let new_key = state.reconnect_pool(connection_id, db_opt).await?;
            do_execute(state, &new_key, sql, cancel_token).await
        }
        _ => result,
    }
}

pub async fn execute_multi_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    cancel_token: Option<CancellationToken>,
) -> Result<Vec<db::QueryResult>, String> {
    let statements = split_sql_statements(sql);
    if statements.len() <= 1 {
        let single_sql = statements.into_iter().next().unwrap_or_default();
        let result = execute_sql_statement(
            state, connection_id, database, &single_sql, cancel_token,
        ).await?;
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
            });
            break;
        }
        match execute_sql_statement(
            state, connection_id, database, stmt, cancel_token.clone(),
        ).await {
            Ok(r) => results.push(r),
            Err(e) => {
                results.push(db::QueryResult {
                    columns: vec!["Error".to_string()],
                    rows: vec![vec![serde_json::Value::String(e)]],
                    affected_rows: 0,
                    execution_time_ms: 0,
                    truncated: false,
                });
            }
        }
    }

    Ok(results)
}

pub async fn execute_statements(
    state: &AppState,
    connection_id: &str,
    database: &str,
    statements: &[String],
) -> Result<db::QueryResult, String> {
    let pool_key = if database.is_empty() {
        connection_id.to_string()
    } else {
        state.get_or_create_pool(connection_id, Some(database)).await?
    };

    let mut total_affected: u64 = 0;
    let start = std::time::Instant::now();

    for (i, sql) in statements.iter().enumerate() {
        match do_execute(state, &pool_key, sql, None).await {
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
                    i + 1, e, i
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
            })
        })
        .await;

        assert_eq!(result.unwrap_err(), timeout_error());
    }
}
