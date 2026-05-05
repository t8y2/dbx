use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Executor, Row};
use std::time::{Duration, Instant};

use crate::types::{ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo, TriggerInfo};

pub async fn connect_path(path: &str) -> Result<SqlitePool, String> {
    let mut options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);

    if is_network_path(path) {
        options = options.vfs("unix-nolock");
    }

    SqlitePoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .idle_timeout(Duration::from_secs(300))
        .connect_with(options)
        .await
        .map_err(|e| format!("SQLite connection failed: {e}"))
}

fn is_network_path(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//") || path.contains("wsl.localhost") || path.contains("wsl$")
}

pub async fn list_databases(_pool: &SqlitePool) -> Result<Vec<DatabaseInfo>, String> {
    Ok(vec![DatabaseInfo { name: "main".to_string() }])
}

pub async fn list_tables(pool: &SqlitePool, _schema: &str) -> Result<Vec<TableInfo>, String> {
    let rows: Vec<SqliteRow> = sqlx::query(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let t: String = row.get("type");
            TableInfo {
                name: row.get::<String, _>("name"),
                table_type: if t == "view" { "VIEW".to_string() } else { "BASE TABLE".to_string() },
            }
        })
        .collect())
}

pub async fn get_columns(pool: &SqlitePool, _schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let rows: Vec<SqliteRow> = sqlx::query(&format!("PRAGMA table_info(\"{}\")", table))
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ColumnInfo {
            name: row.get::<String, _>("name"),
            data_type: row.get::<String, _>("type"),
            is_nullable: row.get::<i32, _>("notnull") == 0,
            column_default: row.get::<Option<String>, _>("dflt_value"),
            is_primary_key: row.get::<i32, _>("pk") > 0,
            extra: None, comment: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
        })
        .collect())
}

pub async fn list_indexes(pool: &SqlitePool, _schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let safe_table = table.replace('"', "\"\"");
    let idx_rows: Vec<SqliteRow> = sqlx::query(&format!("PRAGMA index_list(\"{safe_table}\")"))
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    let mut indexes = Vec::new();
    for idx_row in &idx_rows {
        let name: String = idx_row.get("name");
        let is_unique: bool = idx_row.get::<i32, _>("unique") != 0;
        let origin: String = idx_row.get::<String, _>("origin");
        let is_primary = origin == "pk";

        let safe_name = name.replace('"', "\"\"");
        let col_rows: Vec<SqliteRow> = sqlx::query(&format!("PRAGMA index_info(\"{safe_name}\")"))
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

        let columns: Vec<String> = col_rows.iter().map(|r| r.get::<String, _>("name")).collect();

        indexes.push(IndexInfo {
            name,
            columns,
            is_unique,
            is_primary,
            filter: None,
            index_type: None,
            included_columns: None,
            comment: None,
        });
    }
    Ok(indexes)
}

pub async fn list_foreign_keys(pool: &SqlitePool, _schema: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let rows: Vec<SqliteRow> = sqlx::query(&format!("PRAGMA foreign_key_list(\"{}\")", table))
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ForeignKeyInfo {
            name: format!("fk_{}", row.get::<i32, _>("id")),
            column: row.get::<String, _>("from"),
            ref_table: row.get::<String, _>("table"),
            ref_column: row.get::<String, _>("to"),
        })
        .collect())
}

pub async fn list_triggers(pool: &SqlitePool, _schema: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let rows: Vec<SqliteRow> = sqlx::query(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
    )
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let sql_text: String = row.get::<Option<String>, _>("sql").unwrap_or_default();
            let upper = sql_text.to_uppercase();
            let timing = if upper.contains("BEFORE") { "BEFORE" } else if upper.contains("AFTER") { "AFTER" } else { "INSTEAD OF" };
            let event = if upper.contains("INSERT") { "INSERT" } else if upper.contains("UPDATE") { "UPDATE" } else { "DELETE" };
            TriggerInfo {
                name: row.get::<String, _>("name"),
                event: event.to_string(),
                timing: timing.to_string(),
            }
        })
        .collect())
}

pub async fn execute_query(pool: &SqlitePool, sql: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let trimmed = sql.trim().to_uppercase();

    if trimmed.starts_with("SELECT")
        || trimmed.starts_with("PRAGMA")
        || trimmed.starts_with("EXPLAIN")
        || trimmed.starts_with("WITH")
    {
        let desc = pool.describe(sql).await.map_err(|e| e.to_string())?;
        let columns: Vec<String> = desc.columns().iter().map(|c| c.name().to_string()).collect();

        let rows: Vec<SqliteRow> = sqlx::query(sql)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

        let result_rows: Vec<Vec<serde_json::Value>> = rows
            .iter()
            .map(|row| {
                (0..row.len())
                    .map(|i| {
                        row.try_get::<String, _>(i)
                            .map(serde_json::Value::String)
                            .or_else(|_| row.try_get::<i64, _>(i).map(|v| serde_json::Value::Number(v.into())))
                            .or_else(|_| row.try_get::<f64, _>(i).map(|v| {
                                serde_json::Number::from_f64(v)
                                    .map(serde_json::Value::Number)
                                    .unwrap_or(serde_json::Value::Null)
                            }))
                            .or_else(|_| row.try_get::<bool, _>(i).map(serde_json::Value::Bool))
                            .unwrap_or(serde_json::Value::Null)
                    })
                    .collect()
            })
            .collect();

        Ok(QueryResult {
            columns,
            rows: result_rows,
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
        })
    } else {
        let result = sqlx::query(sql)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;

        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: result.rows_affected(),
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
        })
    }
}
