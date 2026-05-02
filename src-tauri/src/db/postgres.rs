use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use rust_decimal::Decimal;
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Column, Executor, Row, TypeInfo, ValueRef};
use std::time::{Duration, Instant};

use super::{ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo, TriggerInfo};

fn pg_temporal_to_json_value(row: &PgRow, idx: usize) -> Option<serde_json::Value> {
    if let Ok(v) = row.try_get::<DateTime<Utc>, _>(idx) {
        return Some(serde_json::Value::String(v.to_rfc3339()));
    }
    if let Ok(v) = row.try_get::<NaiveDateTime, _>(idx) {
        return Some(serde_json::Value::String(v.to_string()));
    }
    if let Ok(v) = row.try_get::<NaiveDate, _>(idx) {
        return Some(serde_json::Value::String(v.to_string()));
    }
    if let Ok(v) = row.try_get::<NaiveTime, _>(idx) {
        return Some(serde_json::Value::String(v.to_string()));
    }
    None
}

fn pg_value_to_json(row: &PgRow, idx: usize, type_name: &str) -> serde_json::Value {
    if row.try_get_raw(idx).map(|v| v.is_null()).unwrap_or(true) {
        return serde_json::Value::Null;
    }

    let upper = type_name.to_uppercase();

    if upper == "BOOL" {
        return row
            .try_get::<bool, _>(idx)
            .map(serde_json::Value::Bool)
            .unwrap_or(serde_json::Value::Null);
    }

    if upper.contains("TIMESTAMP")
        || upper == "DATE"
        || upper == "TIME"
        || upper == "TIMETZ"
        || upper.contains("INTERVAL")
    {
        if let Some(v) = pg_temporal_to_json_value(row, idx) {
            return v;
        }
    }

    if upper == "NUMERIC" || upper == "DECIMAL" || upper == "MONEY" {
        return row
            .try_get::<Decimal, _>(idx)
            .map(|v: Decimal| serde_json::Value::String(v.to_string()))
            .unwrap_or(serde_json::Value::Null);
    }

    row.try_get::<String, _>(idx)
        .map(serde_json::Value::String)
        .or_else(|_| {
            row.try_get::<i64, _>(idx)
                .map(|v| serde_json::Value::Number(v.into()))
        })
        .or_else(|_| {
            row.try_get::<i32, _>(idx)
                .map(|v| serde_json::Value::Number(v.into()))
        })
        .or_else(|_| {
            row.try_get::<f64, _>(idx).map(|v| {
                serde_json::Number::from_f64(v)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null)
            })
        })
        .or_else(|_| row.try_get::<bool, _>(idx).map(serde_json::Value::Bool))
        .or_else(|e| pg_temporal_to_json_value(row, idx).ok_or(e))
        .unwrap_or(serde_json::Value::Null)
}

pub async fn connect(url: &str) -> Result<PgPool, String> {
    PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .idle_timeout(Duration::from_secs(300))
        .connect(url)
        .await
        .map_err(|e| format!("PostgreSQL connection failed: {e}"))
}

pub async fn list_databases(pool: &PgPool) -> Result<Vec<DatabaseInfo>, String> {
    let rows: Vec<PgRow> =
        sqlx::query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname")
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| DatabaseInfo {
            name: row.get::<String, _>("datname"),
        })
        .collect())
}

pub async fn list_tables(pool: &PgPool, schema: &str) -> Result<Vec<TableInfo>, String> {
    let rows: Vec<PgRow> = sqlx::query(
        "SELECT table_name, table_type FROM information_schema.tables \
         WHERE table_schema = $1 ORDER BY table_name",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: row.get::<String, _>("table_name"),
            table_type: row.get::<String, _>("table_type"),
        })
        .collect())
}

pub async fn list_schemas(pool: &PgPool) -> Result<Vec<String>, String> {
    let rows: Vec<PgRow> = sqlx::query(
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast') \
         AND schema_name NOT LIKE 'pg_toast_temp_%' \
         AND schema_name NOT LIKE 'pg_temp_%' \
         ORDER BY schema_name",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| row.get::<String, _>("schema_name"))
        .collect())
}

pub async fn get_columns(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let rows: Vec<PgRow> = sqlx::query(
        "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, \
         CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END AS is_pk, \
         col_description((c.table_schema || '.' || c.table_name)::regclass, c.ordinal_position) AS column_comment, \
         c.numeric_precision, c.numeric_scale \
         FROM information_schema.columns c \
         LEFT JOIN information_schema.key_column_usage kcu \
           ON c.table_schema = kcu.table_schema \
           AND c.table_name = kcu.table_name \
           AND c.column_name = kcu.column_name \
         LEFT JOIN information_schema.table_constraints tc \
           ON kcu.constraint_name = tc.constraint_name \
           AND kcu.table_schema = tc.table_schema \
           AND tc.constraint_type = 'PRIMARY KEY' \
         WHERE c.table_schema = $1 AND c.table_name = $2 \
         ORDER BY c.ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ColumnInfo {
            name: row.get::<String, _>("column_name"),
            data_type: row.get::<String, _>("data_type"),
            is_nullable: row.get::<String, _>("is_nullable") == "YES",
            column_default: row.get::<Option<String>, _>("column_default"),
            is_primary_key: row.get::<bool, _>("is_pk"),
            extra: None,
            comment: row.get::<Option<String>, _>("column_comment"),
            numeric_precision: row.get::<Option<i32>, _>("numeric_precision"),
            numeric_scale: row.get::<Option<i32>, _>("numeric_scale"),
        })
        .collect())
}

pub async fn execute_query(pool: &PgPool, sql: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let trimmed = sql.trim().to_uppercase();

    if trimmed.starts_with("SELECT")
        || trimmed.starts_with("SHOW")
        || trimmed.starts_with("EXPLAIN")
        || trimmed.starts_with("WITH")
        || trimmed.starts_with("TABLE")
    {
        let desc = pool.describe(sql).await.map_err(|e| e.to_string())?;
        let columns: Vec<String> = desc.columns().iter().map(|c| c.name().to_string()).collect();
        let column_types: Vec<String> = desc
            .columns()
            .iter()
            .map(|c| c.type_info().name().to_string())
            .collect();

        let rows: Vec<PgRow> = sqlx::query(sql)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

        let result_rows: Vec<Vec<serde_json::Value>> = rows
            .iter()
            .map(|row| {
                (0..row.len())
                    .map(|i| {
                        pg_value_to_json(
                            row,
                            i,
                            column_types.get(i).map(String::as_str).unwrap_or(""),
                        )
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

pub async fn list_indexes(pool: &PgPool, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let rows: Vec<PgRow> = sqlx::query(
        "SELECT i.relname AS index_name, \
         array_agg(a.attname ORDER BY k.n) AS columns, \
         ix.indisunique AS is_unique, \
         ix.indisprimary AS is_primary \
         FROM pg_index ix \
         JOIN pg_class t ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n) ON true \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum \
         WHERE n.nspname = $1 AND t.relname = $2 \
         GROUP BY i.relname, ix.indisunique, ix.indisprimary \
         ORDER BY i.relname",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| IndexInfo {
            name: row.get::<String, _>("index_name"),
            columns: row.get::<Vec<String>, _>("columns"),
            is_unique: row.get::<bool, _>("is_unique"),
            is_primary: row.get::<bool, _>("is_primary"),
        })
        .collect())
}

pub async fn list_foreign_keys(pool: &PgPool, schema: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let rows: Vec<PgRow> = sqlx::query(
        "SELECT kcu.constraint_name, kcu.column_name, \
         ccu.table_name AS ref_table, ccu.column_name AS ref_column \
         FROM information_schema.key_column_usage kcu \
         JOIN information_schema.referential_constraints rc \
           ON kcu.constraint_name = rc.constraint_name \
           AND kcu.constraint_schema = rc.constraint_schema \
         JOIN information_schema.constraint_column_usage ccu \
           ON rc.unique_constraint_name = ccu.constraint_name \
           AND rc.unique_constraint_schema = ccu.constraint_schema \
         WHERE kcu.table_schema = $1 AND kcu.table_name = $2 \
         ORDER BY kcu.constraint_name",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ForeignKeyInfo {
            name: row.get::<String, _>("constraint_name"),
            column: row.get::<String, _>("column_name"),
            ref_table: row.get::<String, _>("ref_table"),
            ref_column: row.get::<String, _>("ref_column"),
        })
        .collect())
}

pub async fn list_triggers(pool: &PgPool, schema: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let rows: Vec<PgRow> = sqlx::query(
        "SELECT trigger_name, event_manipulation, action_timing \
         FROM information_schema.triggers \
         WHERE trigger_schema = $1 AND event_object_table = $2 \
         ORDER BY trigger_name",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TriggerInfo {
            name: row.get::<String, _>("trigger_name"),
            event: row.get::<String, _>("event_manipulation"),
            timing: row.get::<String, _>("action_timing"),
        })
        .collect())
}
