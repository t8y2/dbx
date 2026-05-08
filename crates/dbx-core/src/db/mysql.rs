use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use rust_decimal::Decimal;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::{Column, Executor, Row, TypeInfo, ValueRef};
use std::time::{Duration, Instant};

use crate::types::{ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo, TriggerInfo};

fn quote_value(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn get_str(row: &MySqlRow, idx: usize) -> String {
    row.try_get::<String, _>(idx)
        .or_else(|_| row.try_get::<Vec<u8>, _>(idx).map(|b| String::from_utf8_lossy(&b).to_string()))
        .unwrap_or_default()
}

fn get_str_by_name(row: &MySqlRow, name: &str) -> String {
    row.try_get::<String, _>(name)
        .or_else(|_| row.try_get::<Vec<u8>, _>(name).map(|b| String::from_utf8_lossy(&b).to_string()))
        .unwrap_or_default()
}

fn get_opt_str(row: &MySqlRow, name: &str) -> Option<String> {
    row.try_get::<Option<String>, _>(name).ok().flatten().or_else(|| {
        row.try_get::<Option<Vec<u8>>, _>(name).ok().flatten().map(|b| String::from_utf8_lossy(&b).to_string())
    })
}

fn numeric_metadata_u64_to_i32(value: Option<u64>) -> Option<i32> {
    value.and_then(|v| i32::try_from(v).ok())
}

fn numeric_metadata_i64_to_i32(value: Option<i64>) -> Option<i32> {
    value.and_then(|v| i32::try_from(v).ok())
}

fn numeric_metadata_str_to_i32(value: Option<String>) -> Option<i32> {
    value.and_then(|v| v.parse::<i64>().ok()).and_then(|v| i32::try_from(v).ok())
}

fn get_opt_i32(row: &MySqlRow, name: &str) -> Option<i32> {
    if row.try_get_raw(name).map(|v| v.is_null()).unwrap_or(true) {
        return None;
    }

    row.try_get::<Option<i32>, _>(name)
        .ok()
        .flatten()
        .or_else(|| numeric_metadata_i64_to_i32(row.try_get::<Option<i64>, _>(name).ok().flatten()))
        .or_else(|| numeric_metadata_u64_to_i32(row.try_get::<Option<u64>, _>(name).ok().flatten()))
        .or_else(|| numeric_metadata_str_to_i32(row.try_get::<Option<String>, _>(name).ok().flatten()))
        .or_else(|| {
            row.try_get::<Option<Vec<u8>>, _>(name)
                .ok()
                .flatten()
                .and_then(|b| String::from_utf8(b).ok())
                .and_then(|v| numeric_metadata_str_to_i32(Some(v)))
        })
}

fn mysql_temporal_to_json_value(row: &MySqlRow, idx: usize) -> Option<serde_json::Value> {
    if let Ok(v) = row.try_get::<NaiveDateTime, _>(idx) {
        return Some(serde_json::Value::String(v.to_string()));
    }
    if let Ok(v) = row.try_get::<DateTime<Utc>, _>(idx) {
        return Some(serde_json::Value::String(v.to_rfc3339()));
    }
    if let Ok(v) = row.try_get::<NaiveDate, _>(idx) {
        return Some(serde_json::Value::String(v.to_string()));
    }
    if let Ok(v) = row.try_get::<NaiveTime, _>(idx) {
        return Some(serde_json::Value::String(v.to_string()));
    }
    None
}

fn mysql_value_to_json(row: &MySqlRow, idx: usize, type_name: &str) -> serde_json::Value {
    if row.try_get_raw(idx).map(|v| v.is_null()).unwrap_or(true) {
        return serde_json::Value::Null;
    }

    let upper_type = type_name.to_uppercase();

    if upper_type == "JSON" {
        if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) {
            return serde_json::Value::String(v.to_string());
        }
        if let Ok(v) = row.try_get::<String, _>(idx) {
            return serde_json::Value::String(v);
        }
        return serde_json::Value::Null;
    }

    if upper_type == "BOOLEAN" {
        // MySQL BOOLEAN is an alias for TINYINT(1); display as integer
        return row
            .try_get::<i8, _>(idx)
            .map(|v| serde_json::Value::Number((v as i64).into()))
            .or_else(|_| row.try_get::<bool, _>(idx).map(|v| serde_json::Value::Number((v as i64).into())))
            .unwrap_or(serde_json::Value::Null);
    }

    if upper_type.contains("BIGINT") {
        return row
            .try_get::<i64, _>(idx)
            .map(|v| serde_json::Value::String(v.to_string()))
            .or_else(|_| row.try_get::<u64, _>(idx).map(|v| serde_json::Value::String(v.to_string())))
            .unwrap_or(serde_json::Value::Null);
    }

    if upper_type == "DECIMAL" {
        return row
            .try_get::<Decimal, _>(idx)
            .map(|v: Decimal| serde_json::Value::String(v.to_string()))
            .unwrap_or(serde_json::Value::Null);
    }

    if upper_type.starts_with("DATETIME")
        || upper_type.starts_with("TIMESTAMP")
        || upper_type == "DATE"
        || upper_type == "TIME"
        || upper_type.starts_with("TIME(")
    {
        if let Some(v) = mysql_temporal_to_json_value(row, idx) {
            return v;
        }
    }

    row.try_get::<String, _>(idx)
        .map(serde_json::Value::String)
        .or_else(|_| row.try_get::<i64, _>(idx).map(super::safe_i64_to_json))
        .or_else(|_| row.try_get::<u64, _>(idx).map(super::safe_u64_to_json))
        .or_else(|_| {
            row.try_get::<f64, _>(idx).map(|v| {
                serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
            })
        })
        .or_else(|_| row.try_get::<bool, _>(idx).map(serde_json::Value::Bool))
        .or_else(|_| {
            row.try_get::<Vec<u8>, _>(idx).map(|b| serde_json::Value::String(String::from_utf8_lossy(&b).to_string()))
        })
        .or_else(|e| mysql_temporal_to_json_value(row, idx).ok_or(e))
        .unwrap_or(serde_json::Value::Null)
}

pub async fn connect(url: &str) -> Result<MySqlPool, String> {
    super::with_connection_timeout("MySQL", async {
        MySqlPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(super::connection_timeout())
            .idle_timeout(Duration::from_secs(300))
            .connect(url)
            .await
            .map_err(|e| format!("MySQL connection failed: {e}"))
    })
    .await
}

pub async fn connect_bare(url: &str) -> Result<MySqlPool, String> {
    let options: sqlx::mysql::MySqlConnectOptions =
        url.parse().map_err(|e: sqlx::Error| format!("Invalid MySQL URL: {e}"))?;
    let options = options.no_engine_substitution(false).set_names(false).pipes_as_concat(false).timezone(None);
    super::with_connection_timeout("MySQL", async {
        MySqlPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(super::connection_timeout())
            .idle_timeout(Duration::from_secs(300))
            .connect_with(options)
            .await
            .map_err(|e| format!("MySQL connection failed: {e}"))
    })
    .await
}

pub async fn list_databases(pool: &MySqlPool) -> Result<Vec<DatabaseInfo>, String> {
    let rows: Vec<MySqlRow> = sqlx::raw_sql("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(rows.iter().map(|row| DatabaseInfo { name: get_str(row, 0) }).collect())
}

pub async fn list_tables(pool: &MySqlPool, database: &str) -> Result<Vec<TableInfo>, String> {
    let sql = format!(
        "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = {} ORDER BY TABLE_NAME",
        quote_value(database),
    );
    let rows: Vec<MySqlRow> = sqlx::raw_sql(&sql).fetch_all(pool).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: get_str_by_name(row, "TABLE_NAME"),
            table_type: get_str_by_name(row, "TABLE_TYPE"),
            comment: row.try_get::<String, _>("TABLE_COMMENT").ok().filter(|s| !s.is_empty()),
        })
        .collect())
}

pub async fn get_columns(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let sql = format!(
        "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.EXTRA, c.COLUMN_COMMENT, \
         CASE WHEN kcu.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK, \
         c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.CHARACTER_MAXIMUM_LENGTH \
         FROM information_schema.COLUMNS c \
         LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu \
           ON c.TABLE_SCHEMA = kcu.TABLE_SCHEMA \
           AND c.TABLE_NAME = kcu.TABLE_NAME \
           AND c.COLUMN_NAME = kcu.COLUMN_NAME \
           AND kcu.CONSTRAINT_NAME = 'PRIMARY' \
         WHERE c.TABLE_SCHEMA = {} AND c.TABLE_NAME = {} \
         ORDER BY c.ORDINAL_POSITION",
        quote_value(database),
        quote_value(table),
    );
    let rows: Vec<MySqlRow> = sqlx::raw_sql(&sql).fetch_all(pool).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ColumnInfo {
            name: get_str_by_name(row, "COLUMN_NAME"),
            data_type: get_str_by_name(row, "COLUMN_TYPE"),
            is_nullable: get_str_by_name(row, "IS_NULLABLE") == "YES",
            column_default: get_opt_str(row, "COLUMN_DEFAULT"),
            is_primary_key: row.get::<i32, _>("IS_PK") == 1,
            extra: get_opt_str(row, "EXTRA"),
            comment: get_opt_str(row, "COLUMN_COMMENT").filter(|s| !s.is_empty()),
            numeric_precision: get_opt_i32(row, "NUMERIC_PRECISION"),
            numeric_scale: get_opt_i32(row, "NUMERIC_SCALE"),
            character_maximum_length: get_opt_i32(row, "CHARACTER_MAXIMUM_LENGTH"),
        })
        .collect())
}

pub async fn execute_query(pool: &MySqlPool, sql: &str, bare: bool) -> Result<QueryResult, String> {
    let start = Instant::now();
    let trimmed = sql.trim().to_uppercase();

    if trimmed.starts_with("SELECT")
        || trimmed.starts_with("SHOW")
        || trimmed.starts_with("DESCRIBE")
        || trimmed.starts_with("EXPLAIN")
    {
        if bare {
            let rows: Vec<MySqlRow> = sqlx::raw_sql(sql).fetch_all(pool).await.map_err(|e| e.to_string())?;

            let (columns, column_types) = if let Some(first) = rows.first() {
                let cols: Vec<String> = first.columns().iter().map(|c| c.name().to_string()).collect();
                let types: Vec<String> = first.columns().iter().map(|c| c.type_info().name().to_string()).collect();
                (cols, types)
            } else {
                (vec![], vec![])
            };

            let result_rows: Vec<Vec<serde_json::Value>> = rows
                .iter()
                .map(|row| {
                    (0..row.len())
                        .map(|i| mysql_value_to_json(row, i, column_types.get(i).map(String::as_str).unwrap_or("")))
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
            let desc = pool.describe(sql).await.map_err(|e| e.to_string())?;
            let columns: Vec<String> = desc.columns().iter().map(|c| c.name().to_string()).collect();
            let column_types: Vec<String> = desc.columns().iter().map(|c| c.type_info().name().to_string()).collect();

            let rows: Vec<MySqlRow> = sqlx::query(sql).fetch_all(pool).await.map_err(|e| e.to_string())?;

            let result_rows: Vec<Vec<serde_json::Value>> = rows
                .iter()
                .map(|row| {
                    (0..row.len())
                        .map(|i| mysql_value_to_json(row, i, column_types.get(i).map(String::as_str).unwrap_or("")))
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
        }
    } else {
        let result = sqlx::raw_sql(sql).execute(pool).await.map_err(|e| e.to_string())?;

        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: result.rows_affected(),
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
        })
    }
}

pub async fn list_indexes(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let sql = format!(
        "SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns, \
         MIN(NON_UNIQUE) = 0 AS is_unique, INDEX_NAME = 'PRIMARY' AS is_primary, \
         INDEX_TYPE \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} \
         GROUP BY INDEX_NAME, INDEX_TYPE \
         ORDER BY INDEX_NAME",
        quote_value(database),
        quote_value(table),
    );
    let rows: Vec<MySqlRow> = sqlx::raw_sql(&sql).fetch_all(pool).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let cols_str = get_str_by_name(row, "columns");
            IndexInfo {
                name: get_str_by_name(row, "INDEX_NAME"),
                columns: cols_str.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect(),
                is_unique: row.get::<bool, _>("is_unique"),
                is_primary: row.get::<bool, _>("is_primary"),
                filter: None,
                index_type: Some(get_str_by_name(row, "INDEX_TYPE")),
                included_columns: None,
                comment: None,
            }
        })
        .collect())
}

pub async fn list_foreign_keys(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let sql = format!(
        "SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME, \
         kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME \
         FROM information_schema.KEY_COLUMN_USAGE kcu \
         WHERE kcu.TABLE_SCHEMA = {} AND kcu.TABLE_NAME = {} \
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL \
         ORDER BY kcu.CONSTRAINT_NAME",
        quote_value(database),
        quote_value(table),
    );
    let rows: Vec<MySqlRow> = sqlx::raw_sql(&sql).fetch_all(pool).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ForeignKeyInfo {
            name: get_str_by_name(row, "CONSTRAINT_NAME"),
            column: get_str_by_name(row, "COLUMN_NAME"),
            ref_table: get_str_by_name(row, "REFERENCED_TABLE_NAME"),
            ref_column: get_str_by_name(row, "REFERENCED_COLUMN_NAME"),
        })
        .collect())
}

pub async fn list_triggers(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let sql = format!(
        "SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING \
         FROM information_schema.TRIGGERS \
         WHERE TRIGGER_SCHEMA = {} AND EVENT_OBJECT_TABLE = {} \
         ORDER BY TRIGGER_NAME",
        quote_value(database),
        quote_value(table),
    );
    let rows: Vec<MySqlRow> = sqlx::raw_sql(&sql).fetch_all(pool).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TriggerInfo {
            name: get_str_by_name(row, "TRIGGER_NAME"),
            event: get_str_by_name(row, "EVENT_MANIPULATION"),
            timing: get_str_by_name(row, "ACTION_TIMING"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_metadata_accepts_unsigned_information_schema_values() {
        assert_eq!(numeric_metadata_u64_to_i32(Some(65)), Some(65));
    }

    #[test]
    fn numeric_metadata_ignores_values_outside_frontend_range() {
        assert_eq!(numeric_metadata_u64_to_i32(Some(i32::MAX as u64 + 1)), None);
        assert_eq!(numeric_metadata_u64_to_i32(None), None);
    }
}
