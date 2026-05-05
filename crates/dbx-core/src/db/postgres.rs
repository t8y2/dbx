use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use rust_decimal::Decimal;
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Column, Executor, Row, TypeInfo, ValueRef};
use std::time::{Duration, Instant};

use crate::types::{ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo, TriggerInfo};

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

    if upper == "JSON" || upper == "JSONB" {
        if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) {
            return v;
        }
        if let Ok(v) = row.try_get::<String, _>(idx) {
            return serde_json::from_str::<serde_json::Value>(&v).unwrap_or(serde_json::Value::String(v));
        }
        return serde_json::Value::Null;
    }

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
        "SELECT a.attname AS column_name, \
         format_type(a.atttypid, a.atttypmod) AS full_type, \
         NOT a.attnotnull AS is_nullable, \
         pg_get_expr(ad.adbin, ad.adrelid) AS column_default, \
         EXISTS ( \
           SELECT 1 FROM pg_constraint co \
           JOIN pg_index i ON i.indrelid = co.conrelid AND co.conindid = i.indexrelid \
           WHERE co.conrelid = a.attrelid AND co.contype = 'p' \
           AND a.attnum = ANY(i.indkey) \
         ) AS is_pk, \
         col_description(a.attrelid, a.attnum) AS column_comment, \
         CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 \
           THEN ((a.atttypmod - 4) >> 16) & 65535 ELSE NULL END AS numeric_precision, \
         CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 \
           THEN (a.atttypmod - 4) & 65535 ELSE NULL END AS numeric_scale, \
         CASE WHEN t.typname IN ('varchar', 'bpchar') AND a.atttypmod > 0 \
           THEN a.atttypmod - 4 ELSE NULL END AS character_maximum_length \
         FROM pg_attribute a \
         JOIN pg_type t ON t.oid = a.atttypid \
         LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
         WHERE a.attrelid = ($1 || '.' || $2)::regclass \
         AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let full_type = row.get::<Option<String>, _>("full_type").unwrap_or_default();
            ColumnInfo {
                name: row.get::<String, _>("column_name"),
                data_type: full_type,
                is_nullable: row.get::<bool, _>("is_nullable"),
                column_default: row.get::<Option<String>, _>("column_default"),
                is_primary_key: row.get::<bool, _>("is_pk"),
                extra: None,
                comment: row.get::<Option<String>, _>("column_comment"),
                numeric_precision: row.get::<Option<i32>, _>("numeric_precision"),
                numeric_scale: row.get::<Option<i32>, _>("numeric_scale"),
                character_maximum_length: row.get::<Option<i32>, _>("character_maximum_length"),
            }
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
        let rows: Vec<PgRow> = sqlx::query(sql)
            .persistent(false)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

        let (columns, column_types): (Vec<String>, Vec<String>) = if let Some(first) = rows.first() {
            let cols = first.columns();
            (
                cols.iter().map(|c| c.name().to_string()).collect(),
                cols.iter().map(|c| c.type_info().name().to_string()).collect(),
            )
        } else {
            let desc = pool.describe(sql).await.map_err(|e| e.to_string())?;
            (
                desc.columns().iter().map(|c| c.name().to_string()).collect(),
                desc.columns().iter().map(|c| c.type_info().name().to_string()).collect(),
            )
        };

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
         array_agg(COALESCE(a.attname, pg_get_indexdef(ix.indexrelid, k.n::int, true)) ORDER BY k.n) AS columns, \
         ix.indisunique AS is_unique, \
         ix.indisprimary AS is_primary, \
         pg_get_expr(ix.indpred, ix.indrelid) AS filter_expr, \
         am.amname AS index_type, \
         ix.indnkeyatts AS nkeyatts, \
         ix.indkey AS indkey, \
         obj_description(i.oid, 'pg_class') AS index_comment \
         FROM pg_index ix \
         JOIN pg_class t ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         JOIN pg_am am ON am.oid = i.relam \
         JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n) ON true \
         LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum AND k.attnum > 0 \
         WHERE n.nspname = $1 AND t.relname = $2 \
         GROUP BY i.relname, i.oid, ix.indisunique, ix.indisprimary, ix.indpred, ix.indrelid, am.amname, ix.indnkeyatts, ix.indkey \
         ORDER BY i.relname",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let all_cols: Vec<String> = row.get::<Vec<String>, _>("columns");
            let nkeyatts = row.get::<Option<i16>, _>("nkeyatts").unwrap_or(all_cols.len() as i16) as usize;
            let key_cols = all_cols[..nkeyatts].to_vec();
            let included = if nkeyatts < all_cols.len() { all_cols[nkeyatts..].to_vec() } else { vec![] };
            IndexInfo {
                name: row.get::<String, _>("index_name"),
                columns: key_cols,
                is_unique: row.get::<bool, _>("is_unique"),
                is_primary: row.get::<bool, _>("is_primary"),
                filter: row.get::<Option<String>, _>("filter_expr"),
                index_type: row.get::<Option<String>, _>("index_type"),
                included_columns: if included.is_empty() { None } else { Some(included) },
                comment: row.get::<Option<String>, _>("index_comment"),
            }
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
