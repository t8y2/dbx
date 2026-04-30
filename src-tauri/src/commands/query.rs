use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tokio::time::timeout;

use crate::commands::connection::{AppState, PoolKind};
use crate::db;

const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ROWS: usize = 10000;

fn duckdb_execute(con: &duckdb::Connection, sql: &str) -> Result<db::QueryResult, String> {
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

fn truncate_result(mut result: db::QueryResult) -> db::QueryResult {
    if result.rows.len() > MAX_ROWS {
        result.rows.truncate(MAX_ROWS);
        result.truncated = true;
    }
    result
}

fn is_connection_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("connection")
        || lower.contains("broken pipe")
        || lower.contains("reset by peer")
        || lower.contains("timed out")
        || lower.contains("closed")
        || lower.contains("eof")
}

async fn do_execute(
    state: &AppState,
    pool_key: &str,
    sql: &str,
) -> Result<db::QueryResult, String> {
    let connections = state.connections.lock().await;
    let pool = connections.get(pool_key).ok_or("Connection not found")?;

    match pool {
        PoolKind::DuckDb(con) => {
            let con = con.clone();
            let sql = sql.to_string();
            drop(connections);
            let task = tokio::task::spawn_blocking(move || {
                let con = con.lock().map_err(|e| e.to_string())?;
                duckdb_execute(&con, &sql)
            });
            timeout(QUERY_TIMEOUT, task)
                .await
                .map_err(|_| format!("Query timed out after {} seconds", QUERY_TIMEOUT.as_secs()))?
                .map_err(|e| e.to_string())?
        }
        PoolKind::Mysql(p) => {
            let p = p.clone();
            drop(connections);
            timeout(QUERY_TIMEOUT, db::mysql::execute_query(&p, sql))
                .await
                .map_err(|_| format!("Query timed out after {} seconds", QUERY_TIMEOUT.as_secs()))?
                .map(truncate_result)
        }
        PoolKind::Postgres(p) => {
            let p = p.clone();
            drop(connections);
            timeout(QUERY_TIMEOUT, db::postgres::execute_query(&p, sql))
                .await
                .map_err(|_| format!("Query timed out after {} seconds", QUERY_TIMEOUT.as_secs()))?
                .map(truncate_result)
        }
        PoolKind::Sqlite(p) => {
            let p = p.clone();
            drop(connections);
            timeout(QUERY_TIMEOUT, db::sqlite::execute_query(&p, sql))
                .await
                .map_err(|_| format!("Query timed out after {} seconds", QUERY_TIMEOUT.as_secs()))?
                .map(truncate_result)
        }
        PoolKind::ClickHouse(client) => {
            let client = client.clone();
            let database = pool_key.split(':').nth(1).unwrap_or("default").to_string();
            drop(connections);
            timeout(QUERY_TIMEOUT, db::clickhouse_driver::execute_query(&client, &database, sql))
                .await
                .map_err(|_| format!("Query timed out after {} seconds", QUERY_TIMEOUT.as_secs()))?
                .map(truncate_result)
        }
        PoolKind::SqlServer(client) => {
            let client = client.clone();
            drop(connections);
            let mut client = client.lock().await;
            timeout(QUERY_TIMEOUT, db::sqlserver::execute_query(&mut client, sql))
                .await
                .map_err(|_| format!("Query timed out after {} seconds", QUERY_TIMEOUT.as_secs()))?
                .map(truncate_result)
        }
        PoolKind::Oracle(client) => {
            let client = client.clone();
            drop(connections);
            let client = client.lock().await;
            timeout(QUERY_TIMEOUT, db::oracle_driver::execute_query(&*client, sql))
                .await
                .map_err(|_| format!("Query timed out after {} seconds", QUERY_TIMEOUT.as_secs()))?
                .map(truncate_result)
        }
        PoolKind::Elasticsearch(_) => Err("Use document browser for Elasticsearch".to_string()),
        PoolKind::Redis(_) => Err("Use Redis-specific commands".to_string()),
        PoolKind::MongoDb(_) => Err("Use MongoDB-specific commands".to_string()),
    }
}

#[tauri::command]
pub async fn execute_query(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    sql: String,
) -> Result<db::QueryResult, String> {
    let pool_key = if database.is_empty() {
        connection_id.clone()
    } else {
        state.get_or_create_pool(&connection_id, Some(&database)).await?
    };

    let result = do_execute(&state, &pool_key, &sql).await;

    match &result {
        Err(e) if is_connection_error(e) => {
            let db_opt = if database.is_empty() { None } else { Some(database.as_str()) };
            let new_key = state.reconnect_pool(&connection_id, db_opt).await?;
            do_execute(&state, &new_key, &sql).await
        }
        _ => result,
    }
}

#[tauri::command]
pub async fn execute_batch(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    statements: Vec<String>,
) -> Result<db::QueryResult, String> {
    let pool_key = if database.is_empty() {
        connection_id.clone()
    } else {
        state.get_or_create_pool(&connection_id, Some(&database)).await?
    };

    let mut total_affected: u64 = 0;
    let start = std::time::Instant::now();

    for (i, sql) in statements.iter().enumerate() {
        match do_execute(&state, &pool_key, sql).await {
            Ok(result) => {
                total_affected += result.affected_rows;
            }
            Err(e) => {
                if is_connection_error(&e) {
                    let db_opt = if database.is_empty() { None } else { Some(database.as_str()) };
                    let _ = state.reconnect_pool(&connection_id, db_opt).await;
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
