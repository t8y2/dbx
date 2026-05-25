use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use futures::StreamExt;
use mysql_async::consts::ColumnType;
use mysql_async::prelude::*;
use rust_decimal::Decimal;
use std::borrow::Cow;
use std::collections::HashSet;
use std::time::Duration;
use std::time::Instant;

use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ObjectInfo, QueryResult, TableInfo, TriggerInfo,
};

pub type MySqlPool = mysql_async::Pool;

fn quote_value(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn row_get<T, I>(row: &mysql_async::Row, index: I) -> Option<T>
where
    T: mysql_async::prelude::FromValue,
    I: mysql_async::prelude::ColumnIndex,
{
    row.get_opt::<T, I>(index).and_then(|result| result.ok())
}

fn get_str(row: &mysql_async::Row, idx: usize) -> String {
    row_get::<String, _>(row, idx)
        .or_else(|| row_get::<Vec<u8>, _>(row, idx).map(|b| String::from_utf8_lossy(&b).to_string()))
        .unwrap_or_default()
}

fn get_str_by_name(row: &mysql_async::Row, name: &str) -> String {
    row_get::<String, _>(row, name)
        .or_else(|| row_get::<Vec<u8>, _>(row, name).map(|b| String::from_utf8_lossy(&b).to_string()))
        .unwrap_or_default()
}

fn get_opt_str(row: &mysql_async::Row, name: &str) -> Option<String> {
    row_get::<String, _>(row, name)
        .or_else(|| row_get::<Vec<u8>, _>(row, name).map(|b| String::from_utf8_lossy(&b).to_string()))
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

fn get_opt_i32(row: &mysql_async::Row, name: &str) -> Option<i32> {
    row_get::<i32, _>(row, name)
        .or_else(|| numeric_metadata_i64_to_i32(row_get::<i64, _>(row, name)))
        .or_else(|| numeric_metadata_u64_to_i32(row_get::<u64, _>(row, name)))
        .or_else(|| numeric_metadata_str_to_i32(row_get::<String, _>(row, name)))
        .or_else(|| {
            row_get::<Vec<u8>, _>(row, name)
                .and_then(|b| String::from_utf8(b).ok())
                .and_then(|v| numeric_metadata_str_to_i32(Some(v)))
        })
}

#[cfg(test)]
fn mysql_datetime_to_string(value: NaiveDateTime) -> String {
    value.to_string()
}

#[cfg(test)]
fn is_mysql_lossless_integer_type(type_name: &str) -> bool {
    let upper_type = type_name.to_uppercase();
    upper_type.contains("BIGINT") || upper_type.contains("LARGEINT")
}

fn is_lossless_integer_column(column: &mysql_async::Column) -> bool {
    matches!(column.column_type(), ColumnType::MYSQL_TYPE_LONGLONG | ColumnType::MYSQL_TYPE_NEWDECIMAL)
}

fn mysql_value_to_json(row: &mysql_async::Row, idx: usize) -> serde_json::Value {
    let Some(column) = row.columns_ref().get(idx) else {
        return serde_json::Value::Null;
    };

    let Some(value) = row.as_ref(idx) else {
        return serde_json::Value::Null;
    };
    if matches!(value, mysql_async::Value::NULL) {
        return serde_json::Value::Null;
    }

    match column.column_type() {
        ColumnType::MYSQL_TYPE_JSON => {
            if let Some(v) = row_get::<String, _>(row, idx) {
                return serde_json::Value::String(v);
            }
        }
        ColumnType::MYSQL_TYPE_DECIMAL | ColumnType::MYSQL_TYPE_NEWDECIMAL | ColumnType::MYSQL_TYPE_LONGLONG => {
            if is_lossless_integer_column(column) {
                return row
                    .get_opt::<String, usize>(idx)
                    .and_then(|result| result.ok())
                    .map(serde_json::Value::String)
                    .or_else(|| {
                        row_get::<Decimal, _>(row, idx).map(|v: Decimal| serde_json::Value::String(v.to_string()))
                    })
                    .or_else(|| row_get::<i64, _>(row, idx).map(|v| serde_json::Value::String(v.to_string())))
                    .or_else(|| row_get::<u64, _>(row, idx).map(|v| serde_json::Value::String(v.to_string())))
                    .or_else(|| {
                        row_get::<Vec<u8>, _>(row, idx)
                            .map(|b| serde_json::Value::String(String::from_utf8_lossy(&b).to_string()))
                    })
                    .unwrap_or(serde_json::Value::Null);
            }
            return row
                .get_opt::<Decimal, usize>(idx)
                .and_then(|result| result.ok())
                .map(|v: Decimal| serde_json::Value::String(v.to_string()))
                .unwrap_or(serde_json::Value::Null);
        }
        ColumnType::MYSQL_TYPE_TIMESTAMP
        | ColumnType::MYSQL_TYPE_TIMESTAMP2
        | ColumnType::MYSQL_TYPE_DATETIME
        | ColumnType::MYSQL_TYPE_DATETIME2
        | ColumnType::MYSQL_TYPE_DATE
        | ColumnType::MYSQL_TYPE_TIME
        | ColumnType::MYSQL_TYPE_TIME2
        | ColumnType::MYSQL_TYPE_NEWDATE => {
            if let Some(v) = row_get::<NaiveDateTime, _>(row, idx) {
                return serde_json::Value::String(v.to_string());
            }
            if let Some(v) = row_get::<NaiveDate, _>(row, idx) {
                return serde_json::Value::String(v.to_string());
            }
            if let Some(v) = row_get::<NaiveTime, _>(row, idx) {
                return serde_json::Value::String(v.to_string());
            }
        }
        _ => {}
    }

    row_get::<String, _>(row, idx)
        .map(serde_json::Value::String)
        .or_else(|| row_get::<i64, _>(row, idx).map(super::safe_i64_to_json))
        .or_else(|| row_get::<u64, _>(row, idx).map(super::safe_u64_to_json))
        .or_else(|| row_get::<i32, _>(row, idx).map(|v| serde_json::Value::Number(v.into())))
        .or_else(|| row_get::<i16, _>(row, idx).map(|v| serde_json::Value::Number(v.into())))
        .or_else(|| {
            row_get::<f64, _>(row, idx).map(|v| {
                serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
            })
        })
        .or_else(|| row_get::<bool, _>(row, idx).map(serde_json::Value::Bool))
        .or_else(|| {
            row_get::<Vec<u8>, _>(row, idx).map(|b| serde_json::Value::String(String::from_utf8_lossy(&b).to_string()))
        })
        .unwrap_or(serde_json::Value::Null)
}

pub async fn connect(url: &str) -> Result<MySqlPool, String> {
    let pool = create_pool(url)?;
    let result = verify_pool_connection(&pool).await;

    if let Err(ref e) = result {
        if mysql_error_should_retry_without_ssl(e) {
            if let Some(fallback_url) = ssl_fallback_url(url) {
                log::info!("SSL handshake failed, retrying with ssl-mode=disabled");
                let fallback_pool = create_pool(&fallback_url)?;
                return match verify_pool_connection(&fallback_pool).await {
                    Ok(()) => Ok(fallback_pool),
                    Err(e) => Err(e),
                };
            }
        }
    }

    result.map(|_| pool)
}

fn create_pool(url: &str) -> Result<MySqlPool, String> {
    let opts = mysql_async::Opts::from_url(&mysql_async_url(url)).map_err(|e| format!("Invalid MySQL URL: {e}"))?;
    let pool_opts = mysql_async::PoolOpts::new()
        .with_constraints(mysql_async::PoolConstraints::new(1, 5).unwrap())
        .with_inactive_connection_ttl(Duration::from_secs(300));
    let builder = mysql_async::OptsBuilder::from_opts(opts).stmt_cache_size(0).pool_opts(Some(pool_opts));
    Ok(MySqlPool::new(builder))
}

async fn verify_pool_connection(pool: &MySqlPool) -> Result<(), String> {
    super::with_connection_timeout("MySQL", async {
        let mut conn = pool.get_conn().await.map_err(|e| format!("MySQL connection failed: {e}"))?;
        conn.ping().await.map_err(|e| format!("MySQL ping failed: {e}"))?;
        Ok(())
    })
    .await
}

fn mysql_error_should_retry_without_ssl(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("handshakefailure")
        || error.contains("handshake")
        || error.contains("tls connection")
        || error.contains("server closed session")
}

fn mysql_error_should_retry_with_text_protocol(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    (lower.contains("1105") && lower.contains("hy000"))
        || lower.contains("prepared statement protocol")
        || lower.contains("this command is not supported in the prepared statement protocol yet")
}

fn ssl_fallback_url(url: &str) -> Option<String> {
    if url.contains("ssl-mode=preferred") {
        Some(url.replace("ssl-mode=preferred", "ssl-mode=disabled"))
    } else if !url.contains("ssl-mode=") {
        let sep = if url.contains('?') { "&" } else { "?" };
        Some(format!("{url}{sep}ssl-mode=disabled"))
    } else {
        None
    }
}

fn mysql_async_url(url: &str) -> Cow<'_, str> {
    let Some((base, query)) = url.split_once('?') else {
        return Cow::Borrowed(url);
    };

    let filtered: Vec<&str> = query
        .split('&')
        .filter(|segment| {
            let segment = segment.trim();
            !segment.is_empty()
                && !segment.starts_with("ssl-mode=")
                && !segment.starts_with("charset=")
                && !segment.starts_with("time_zone=")
                && !segment.starts_with("time-zone=")
        })
        .collect();

    if filtered.len() == query.split('&').filter(|segment| !segment.trim().is_empty()).count() {
        Cow::Borrowed(url)
    } else if filtered.is_empty() {
        Cow::Owned(base.to_string())
    } else {
        Cow::Owned(format!("{base}?{}", filtered.join("&")))
    }
}

pub async fn connect_bare(url: &str) -> Result<MySqlPool, String> {
    let pool = create_pool(url)?;
    verify_pool_connection(&pool).await.map(|_| pool)
}

pub async fn list_databases(pool: &MySqlPool) -> Result<Vec<DatabaseInfo>, String> {
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn
        .query_iter(
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA \
             WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') \
             ORDER BY SCHEMA_NAME",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    Ok(rows.iter().map(|row| DatabaseInfo { name: get_str(row, 0) }).collect())
}

pub async fn list_tables(pool: &MySqlPool, database: &str) -> Result<Vec<TableInfo>, String> {
    let sql = format!(
        "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = {} ORDER BY TABLE_NAME",
        quote_value(database),
    );
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: get_str_by_name(row, "TABLE_NAME"),
            table_type: get_str_by_name(row, "TABLE_TYPE"),
            comment: get_opt_str(row, "TABLE_COMMENT").filter(|s| !s.is_empty()),
        })
        .collect())
}

fn list_tables_objects_sql(database: &str) -> String {
    format!(
        "SELECT TABLE_NAME AS object_name, \
           CASE WHEN TABLE_TYPE = 'VIEW' THEN 'VIEW' ELSE 'TABLE' END AS object_type, \
           TABLE_COMMENT AS object_comment, \
           CREATE_TIME AS created_at, \
           UPDATE_TIME AS updated_at, \
           CASE WHEN TABLE_TYPE = 'VIEW' THEN 1 ELSE 0 END AS sort_order \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = {db} \
         ORDER BY sort_order, object_name",
        db = quote_value(database),
    )
}

fn list_routines_sql(database: &str) -> String {
    format!(
        "SELECT ROUTINE_NAME AS object_name, ROUTINE_TYPE AS object_type, NULL AS object_comment, \
           NULL AS created_at, NULL AS updated_at, \
           CASE WHEN ROUTINE_TYPE = 'PROCEDURE' THEN 2 ELSE 3 END AS sort_order \
         FROM information_schema.ROUTINES \
         WHERE ROUTINE_SCHEMA = {db} AND ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION') \
         ORDER BY sort_order, object_name",
        db = quote_value(database),
    )
}

fn row_to_object(row: &mysql_async::Row, database: &str) -> ObjectInfo {
    ObjectInfo {
        name: get_str_by_name(row, "object_name"),
        object_type: get_str_by_name(row, "object_type"),
        schema: Some(database.to_string()),
        comment: get_opt_str(row, "object_comment").filter(|s| !s.is_empty()),
        created_at: get_opt_str(row, "created_at"),
        updated_at: get_opt_str(row, "updated_at"),
    }
}

pub async fn list_objects(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectInfo>, String> {
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;

    let tables_sql = list_tables_objects_sql(database);
    let result = conn.query_iter(&tables_sql).await.map_err(|e| e.to_string())?;
    let table_rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let mut objects: Vec<ObjectInfo> = table_rows.iter().map(|row| row_to_object(row, database)).collect();

    // Routines are queried separately: some MySQL-compatible servers (sharding proxies,
    // OceanBase/TiDB variants, restricted accounts) reject information_schema.ROUTINES with
    // ER_UNKNOWN_ERROR (1105). Degrading gracefully keeps tables/views usable.
    let routines_sql = list_routines_sql(database);
    match conn.query_iter(&routines_sql).await {
        Ok(result) => match result.collect_and_drop::<mysql_async::Row>().await {
            Ok(routine_rows) => {
                objects.extend(routine_rows.iter().map(|row| row_to_object(row, database)));
            }
            Err(e) => {
                log::warn!("Skipping routines for database `{}` in object browser: {}", database, e);
            }
        },
        Err(e) => {
            log::warn!("Skipping routines for database `{}` in object browser: {}", database, e);
        }
    }

    Ok(objects)
}

fn columns_sql(database: &str, table: &str) -> String {
    format!(
        "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.EXTRA, c.COLUMN_COMMENT, \
         c.COLUMN_KEY, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.CHARACTER_MAXIMUM_LENGTH \
         FROM information_schema.COLUMNS c \
         WHERE c.TABLE_SCHEMA = {} AND c.TABLE_NAME = {} \
         ORDER BY c.ORDINAL_POSITION",
        quote_value(database),
        quote_value(table),
    )
}

fn primary_key_columns_sql(database: &str, table: &str) -> String {
    format!(
        "SELECT COLUMN_NAME \
         FROM information_schema.KEY_COLUMN_USAGE \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} AND CONSTRAINT_NAME = 'PRIMARY' \
         ORDER BY ORDINAL_POSITION",
        quote_value(database),
        quote_value(table),
    )
}

fn is_primary_key_column(primary_key_columns: &HashSet<String>, name: &str, column_key: &str) -> bool {
    primary_key_columns.contains(name) || column_key.eq_ignore_ascii_case("PRI")
}

pub async fn get_columns(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let pk_sql = primary_key_columns_sql(database, table);
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&pk_sql).await.map_err(|e| e.to_string())?;
    let pk_rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let primary_key_columns: HashSet<String> = pk_rows.iter().map(|row| get_str_by_name(row, "COLUMN_NAME")).collect();
    drop(conn);

    let sql = columns_sql(database, table);
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let name = get_str_by_name(row, "COLUMN_NAME");
            let column_key = get_str_by_name(row, "COLUMN_KEY");
            ColumnInfo {
                is_primary_key: is_primary_key_column(&primary_key_columns, &name, &column_key),
                name,
                data_type: get_str_by_name(row, "COLUMN_TYPE"),
                is_nullable: get_str_by_name(row, "IS_NULLABLE") == "YES",
                column_default: get_opt_str(row, "COLUMN_DEFAULT"),
                extra: get_opt_str(row, "EXTRA"),
                comment: get_opt_str(row, "COLUMN_COMMENT").filter(|s| !s.is_empty()),
                numeric_precision: get_opt_i32(row, "NUMERIC_PRECISION"),
                numeric_scale: get_opt_i32(row, "NUMERIC_SCALE"),
                character_maximum_length: get_opt_i32(row, "CHARACTER_MAXIMUM_LENGTH"),
            }
        })
        .collect())
}

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(crate::query::MAX_ROWS).max(1)
}

async fn execute_result_set_with_text_protocol(
    pool: &MySqlPool,
    sql: &str,
    row_limit: usize,
    start: Instant,
) -> Result<QueryResult, String> {
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let mut result = conn.query_iter(sql).await.map_err(|e| e.to_string())?;
    let columns: Vec<String> = result.columns_ref().iter().map(|c| c.name_str().to_string()).collect();

    let mut result_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut stream = result
        .stream::<mysql_async::Row>()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Empty result set stream".to_string())?;

    while let Some(row) = stream.next().await {
        let row = row.map_err(|e| e.to_string())?;
        let values: Vec<serde_json::Value> = (0..row.len()).map(|i| mysql_value_to_json(&row, i)).collect();
        result_rows.push(values);
        if result_rows.len() > row_limit {
            break;
        }
    }

    let truncated = result_rows.len() > row_limit;
    if truncated {
        result_rows.truncate(row_limit);
    }

    Ok(QueryResult {
        columns,
        rows: result_rows,
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        session_id: None,
        has_more: false,
    })
}

async fn execute_result_set_with_prepared_protocol(
    pool: &MySqlPool,
    sql: &str,
    row_limit: usize,
    start: Instant,
) -> Result<QueryResult, String> {
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let mut result = conn.exec_iter(sql, ()).await.map_err(|e| e.to_string())?;
    let columns: Vec<String> = result.columns_ref().iter().map(|c| c.name_str().to_string()).collect();

    let mut result_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut stream = result
        .stream::<mysql_async::Row>()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Empty result set stream".to_string())?;

    while let Some(row) = stream.next().await {
        let row = row.map_err(|e| e.to_string())?;
        let values: Vec<serde_json::Value> = (0..row.len()).map(|i| mysql_value_to_json(&row, i)).collect();
        result_rows.push(values);
        if result_rows.len() > row_limit {
            break;
        }
    }

    let truncated = result_rows.len() > row_limit;
    if truncated {
        result_rows.truncate(row_limit);
    }

    Ok(QueryResult {
        columns,
        rows: result_rows,
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        session_id: None,
        has_more: false,
    })
}

pub async fn execute_query(pool: &MySqlPool, sql: &str, bare: bool) -> Result<QueryResult, String> {
    execute_query_with_max_rows(pool, sql, bare, None).await
}

pub async fn execute_query_with_max_rows(
    pool: &MySqlPool,
    sql: &str,
    bare: bool,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let row_limit = query_result_row_limit(max_rows);

    if is_result_set_query(sql) {
        if bare || requires_text_protocol_query(sql) {
            execute_result_set_with_text_protocol(pool, sql, row_limit, start).await
        } else {
            match execute_result_set_with_prepared_protocol(pool, sql, row_limit, start).await {
                Ok(result) => Ok(result),
                Err(err) if mysql_error_should_retry_with_text_protocol(&err) => {
                    execute_result_set_with_text_protocol(pool, sql, row_limit, start).await
                }
                Err(err) => Err(err),
            }
        }
    } else {
        let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
        let result = conn.query_iter(sql).await.map_err(|e| e.to_string())?;
        let affected_rows = result.affected_rows();
        result.drop_result().await.map_err(|e| e.to_string())?;

        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

fn is_result_set_query(sql: &str) -> bool {
    starts_with_executable_sql_keyword(sql, &["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH"])
}

fn requires_text_protocol_query(sql: &str) -> bool {
    if !starts_with_executable_sql_keyword(sql, &["SHOW"]) {
        return false;
    }

    let tokens =
        sql.trim().trim_end_matches(';').split_whitespace().map(|token| token.to_ascii_lowercase()).collect::<Vec<_>>();
    if tokens.len() >= 2 && tokens[0] == "show" && tokens[1] == "grants" {
        return true;
    }

    matches!(
        tokens.iter().map(String::as_str).collect::<Vec<_>>().as_slice(),
        ["show", "processlist"]
            | ["show", "full", "processlist"]
            | ["show", "slave", "status"]
            | ["show", "replica", "status"]
    )
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
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let cols_str = get_str_by_name(row, "columns");
            IndexInfo {
                name: get_str_by_name(row, "INDEX_NAME"),
                columns: cols_str.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect(),
                is_unique: row.get::<bool, &str>("is_unique").unwrap_or(false),
                is_primary: row.get::<bool, &str>("is_primary").unwrap_or(false),
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
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

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
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

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
    fn mysql_with_queries_are_treated_as_result_sets() {
        let sql = "WITH RECURSIVE org_tree AS (SELECT 1 AS id) SELECT id FROM org_tree";
        assert!(is_result_set_query(sql));
    }

    #[test]
    fn numeric_metadata_accepts_unsigned_information_schema_values() {
        assert_eq!(numeric_metadata_u64_to_i32(Some(65)), Some(65));
    }

    #[test]
    fn numeric_metadata_ignores_values_outside_frontend_range() {
        assert_eq!(numeric_metadata_u64_to_i32(Some(i32::MAX as u64 + 1)), None);
        assert_eq!(numeric_metadata_u64_to_i32(None), None);
    }

    #[test]
    fn mysql_list_tables_objects_sql_includes_timestamps() {
        let sql = list_tables_objects_sql("app");

        assert!(sql.contains("information_schema.TABLES"));
        assert!(!sql.contains("information_schema.ROUTINES"));
        assert!(!sql.contains("UNION"));
        assert!(sql.contains("CREATE_TIME"));
        assert!(sql.contains("UPDATE_TIME"));
    }

    #[test]
    fn mysql_list_routines_sql_is_independent_of_tables() {
        let sql = list_routines_sql("app");

        assert!(sql.contains("information_schema.ROUTINES"));
        assert!(!sql.contains("information_schema.TABLES"));
        assert!(!sql.contains("UNION"));
        assert!(sql.contains("'PROCEDURE'"));
        assert!(sql.contains("'FUNCTION'"));
        assert!(!sql.contains("LAST_ALTERED"));
        assert!(!sql.contains("CREATED AS created_at"));
    }

    #[test]
    fn mysql_columns_sql_avoids_information_schema_join_collation() {
        let sql = columns_sql("app", "users");

        assert!(!sql.contains("COLLATE"));
        assert!(!sql.contains("KEY_COLUMN_USAGE"));
        assert!(sql.contains("information_schema.COLUMNS"));
    }

    #[test]
    fn mysql_primary_key_columns_sql_reads_key_column_usage_separately() {
        let sql = primary_key_columns_sql("app", "users");

        assert!(!sql.contains("COLLATE"));
        assert!(sql.contains("information_schema.KEY_COLUMN_USAGE"));
        assert!(sql.contains("CONSTRAINT_NAME = 'PRIMARY'"));
    }

    #[test]
    fn mysql_columns_sql_selects_column_key_for_starrocks_primary_fallback() {
        let sql = columns_sql("app", "users");

        assert!(sql.contains("c.COLUMN_KEY"));
    }

    #[test]
    fn mysql_largeint_uses_lossless_integer_decoding() {
        assert!(is_mysql_lossless_integer_type("LARGEINT"));
    }

    #[test]
    fn mysql_column_key_marks_primary_when_key_column_usage_is_unavailable() {
        let primary_key_columns = HashSet::new();

        assert!(is_primary_key_column(&primary_key_columns, "id", "PRI"));
    }

    #[test]
    fn mysql_management_show_queries_use_text_protocol() {
        assert!(requires_text_protocol_query("SHOW PROCESSLIST"));
        assert!(requires_text_protocol_query("show full processlist"));
        assert!(requires_text_protocol_query("SHOW SLAVE STATUS"));
        assert!(requires_text_protocol_query("show replica status"));
        assert!(requires_text_protocol_query("SHOW GRANTS"));
        assert!(requires_text_protocol_query("SHOW GRANTS FOR 'repl'@'%'"));
        assert!(!requires_text_protocol_query("SHOW TABLES"));
        assert!(!requires_text_protocol_query("SELECT * FROM users"));
    }

    #[test]
    fn mysql_tls_session_close_errors_retry_without_ssl() {
        let error = "MySQL connection failed: error communicating with database: \
            encountered error while attempting to establish a TLS connection: \
            server closed session with no notification";

        assert!(mysql_error_should_retry_without_ssl(error));
    }

    #[test]
    fn mysql_unknown_error_can_retry_with_text_protocol() {
        let error = "error returned from database: 1105 (HY000): Unknown error";

        assert!(mysql_error_should_retry_with_text_protocol(error));
    }

    #[test]
    fn mysql_datetime_utc_values_display_without_rfc3339_offset() {
        let value = NaiveDateTime::new(
            NaiveDate::from_ymd_opt(2026, 5, 12).unwrap(),
            NaiveTime::from_hms_opt(0, 0, 0).unwrap(),
        );

        assert_eq!(mysql_datetime_to_string(value), "2026-05-12 00:00:00");
    }

    #[tokio::test]
    #[ignore = "requires remote MariaDB with ed25519 user"]
    async fn test_ed25519_auth() {
        let url = "mysql://edtest:test123@172.26.128.159:20026/testdb";
        let pool = super::connect(url).await.expect("connect with ed25519");
        let mut conn = pool.get_conn().await.expect("get connection");
        conn.ping().await.expect("ping");
        let _ = conn.disconnect().await;
        let _ = pool.disconnect().await;
    }
}
