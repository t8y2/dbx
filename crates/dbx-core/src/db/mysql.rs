use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use futures::StreamExt;
use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::prelude::*;
use percent_encoding::percent_decode_str;
use rust_decimal::Decimal;
use sqlparser::ast::Statement;
use sqlparser::dialect::MySqlDialect;
use sqlparser::parser::Parser;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
#[cfg(test)]
use std::future::Future;
use std::ops::Deref;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::models::connection::{
    is_mysql_jdbc_tls_param, mysql_jdbc_tls_mode, ConnectionConfig, DatabaseConnectionInfo, DatabaseType,
    MysqlJdbcTlsMode,
};
use crate::schema::{table_name_filter_matches, TableNameFilter};
use crate::sql::{starts_with_executable_sql_keyword, starts_with_executable_sql_keyword_for_database};
use crate::types::{
    ColumnInfo, CompletionAssistantCandidate, CompletionAssistantCandidateKind, CompletionAssistantMatchMode,
    CompletionAssistantObjectKind, CompletionAssistantRequest, CompletionAssistantResponse, DatabaseInfo,
    ForeignKeyInfo, IndexInfo, LargeValueCell, ObjectInfo, ObjectStatistics, QueryMessage, QueryResult,
    SpatialColumnBuilder, TableInfo, TriggerInfo,
};

use super::file_validator::validate_file_path;
use crate::mysql_event_sql::MysqlEventInfo;

/// DBX-owned MySQL pool handle. The driver does not expose its configured
/// maximum, so retain that value beside the driver pool for checkout phase
/// classification instead of guessing it from aggregate metrics.
#[derive(Debug, Clone)]
pub struct MySqlPool {
    inner: mysql_async::Pool,
    max_connections: usize,
}

impl MySqlPool {
    pub(crate) fn new<O>(opts: O, max_connections: usize) -> Self
    where
        mysql_async::Opts: TryFrom<O>,
        <mysql_async::Opts as TryFrom<O>>::Error: std::error::Error,
    {
        Self { inner: mysql_async::Pool::new(opts), max_connections: max_connections.max(1) }
    }

    pub async fn disconnect(self) -> Result<(), mysql_async::Error> {
        self.inner.disconnect().await
    }

    /// Returns whether both handles refer to the same underlying pool
    /// generation. Pool options are not an identity: a reconnect creates a new
    /// pool with identical options, and a late health probe for the old pool
    /// must not be allowed to remove that replacement from routing.
    pub(crate) fn is_same_pool(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.inner.metrics(), &other.inner.metrics())
    }
}

impl Deref for MySqlPool {
    type Target = mysql_async::Pool;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

#[doc(hidden)]
pub trait MySqlPoolAccess {
    fn driver_pool(&self) -> &mysql_async::Pool;
    fn checkout_max_connections(&self) -> Option<usize>;
}

pub async fn get_event_info<P: MySqlPoolAccess + ?Sized>(
    pool: &P,
    database: &str,
    name: &str,
) -> Result<MysqlEventInfo, String> {
    let mut conn = get_conn_with_health_check(pool).await?;
    let sql = format!(
        "SELECT EVENT_SCHEMA, EVENT_NAME, DEFINER, TIME_ZONE, EVENT_TYPE, EXECUTE_AT, INTERVAL_VALUE, INTERVAL_FIELD, STARTS, ENDS, STATUS, ON_COMPLETION, EVENT_COMMENT, EVENT_DEFINITION, CREATED, LAST_ALTERED, LAST_EXECUTED FROM information_schema.EVENTS WHERE EVENT_SCHEMA = {} AND EVENT_NAME = {} LIMIT 1",
        quote_value(database), quote_value(name)
    );
    let row = conn
        .query_first::<mysql_async::Row, _>(sql)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("MySQL event not found: {database}.{name}"))?;
    Ok(MysqlEventInfo {
        schema: get_str_by_name(&row, "EVENT_SCHEMA"),
        name: get_str_by_name(&row, "EVENT_NAME"),
        definer: get_opt_str(&row, "DEFINER"),
        time_zone: get_opt_str(&row, "TIME_ZONE"),
        event_type: get_opt_str(&row, "EVENT_TYPE"),
        execute_at: get_opt_str(&row, "EXECUTE_AT"),
        interval_value: get_opt_str(&row, "INTERVAL_VALUE"),
        interval_field: get_opt_str(&row, "INTERVAL_FIELD"),
        starts: get_opt_str(&row, "STARTS"),
        ends: get_opt_str(&row, "ENDS"),
        status: get_opt_str(&row, "STATUS"),
        on_completion: get_opt_str(&row, "ON_COMPLETION"),
        comment: get_opt_str(&row, "EVENT_COMMENT"),
        event_body: get_opt_str(&row, "EVENT_DEFINITION"),
        event_definition: get_opt_str(&row, "EVENT_DEFINITION"),
        created_at: get_opt_str(&row, "CREATED"),
        updated_at: get_opt_str(&row, "LAST_ALTERED"),
        last_executed: get_opt_str(&row, "LAST_EXECUTED"),
        source: None,
    })
}

impl MySqlPoolAccess for MySqlPool {
    fn driver_pool(&self) -> &mysql_async::Pool {
        &self.inner
    }

    fn checkout_max_connections(&self) -> Option<usize> {
        Some(self.max_connections)
    }
}

impl MySqlPoolAccess for mysql_async::Pool {
    fn driver_pool(&self) -> &mysql_async::Pool {
        self
    }

    fn checkout_max_connections(&self) -> Option<usize> {
        None
    }
}
const MYSQL_TCP_KEEPALIVE_MS: u32 = 30_000;
const MYSQL_SQL_PACKET_MARGIN_MAX_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MySqlCatalogDialect {
    Doris,
    StarRocks,
}

pub(crate) fn mysql_catalog_dialect(
    db_type: DatabaseType,
    driver_profile: Option<&str>,
) -> Option<MySqlCatalogDialect> {
    if super::doris::is_profile(&db_type, driver_profile) {
        Some(MySqlCatalogDialect::Doris)
    } else if super::starrocks::is_profile(&db_type, driver_profile) {
        Some(MySqlCatalogDialect::StarRocks)
    } else {
        None
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct MySqlQueryDialect {
    supports_admin_show_results: bool,
}

#[derive(Debug)]
pub struct MySqlQueryResult {
    pub result: QueryResult,
    pub large_value_cells: Vec<LargeValueCell>,
}

impl MySqlQueryResult {
    fn exact(result: QueryResult) -> Self {
        Self { result, large_value_cells: Vec::new() }
    }
}

const MYSQL_RESULT_CELL_PREVIEW_MIN_BYTES: usize = 256;
const MYSQL_RESULT_CELL_PREVIEW_MAX_BYTES: usize = 8 * 1024;

impl MySqlQueryDialect {
    pub fn for_connection(db_type: DatabaseType, driver_profile: Option<&str>) -> Self {
        Self {
            supports_admin_show_results: super::doris::is_profile(&db_type, driver_profile)
                || super::starrocks::is_profile(&db_type, driver_profile)
                || super::manticoresearch::is_profile(&db_type, driver_profile)
                || super::tidb::is_profile(&db_type, driver_profile),
        }
    }
}

pub enum MySqlQueryStreamItem {
    Columns { columns: Vec<String>, column_types: Vec<String> },
    Row(Vec<serde_json::Value>),
}

pub(super) fn quote_value(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

pub(super) fn quote_identifier(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

fn quote_table_ref(database: &str, table: &str) -> String {
    if database.trim().is_empty() {
        quote_identifier(table)
    } else {
        format!("{}.{}", quote_identifier(database), quote_identifier(table))
    }
}

fn row_get<T, I>(row: &mysql_async::Row, index: I) -> Option<T>
where
    T: mysql_async::prelude::FromValue,
    I: mysql_async::prelude::ColumnIndex,
{
    row.get_opt::<T, I>(index).and_then(|result| result.ok())
}

fn first_column_value<T>(row: &mysql_async::Row) -> Option<T>
where
    T: mysql_async::prelude::FromValue,
{
    row_get(row, 0)
}

async fn query_first_column<T>(conn: &mut mysql_async::Conn, sql: &str) -> Result<Option<T>, mysql_async::Error>
where
    T: mysql_async::prelude::FromValue,
{
    // Some MySQL-compatible servers return extra columns for scalar queries.
    // Convert only column zero so mysql_async does not panic on the row width.
    let row = conn.query_first::<mysql_async::Row, _>(sql).await?;
    Ok(row.as_ref().and_then(first_column_value))
}

/// 字节转 String：合法 UTF-8（绝大多数场景）时直接复用入参缓冲零拷贝，
/// 仅在非法序列时退化为 lossy 替换。from_utf8_lossy(&b).to_string() 即使
/// 对合法输入也会多一次分配+拷贝。
pub(super) fn bytes_to_string_lossy(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|err| String::from_utf8_lossy(err.as_bytes()).into_owned())
}

pub(super) fn get_str(row: &mysql_async::Row, idx: usize) -> String {
    row_get::<String, _>(row, idx)
        .or_else(|| row_get::<Vec<u8>, _>(row, idx).map(bytes_to_string_lossy))
        .unwrap_or_default()
}

pub(super) fn get_str_by_name(row: &mysql_async::Row, name: &str) -> String {
    row_get::<String, _>(row, name)
        .or_else(|| row_get::<Vec<u8>, _>(row, name).map(bytes_to_string_lossy))
        .unwrap_or_default()
}

pub(super) fn get_opt_str(row: &mysql_async::Row, name: &str) -> Option<String> {
    row_get::<String, _>(row, name).or_else(|| row_get::<Vec<u8>, _>(row, name).map(bytes_to_string_lossy))
}

/// First non-empty string value among the named columns (e.g. Doris `CatalogName`
/// vs StarRocks `Catalog`). Returns an empty string when none of the columns
/// are present or all are empty.
pub(super) fn first_nonempty_str_by_name(row: &mysql_async::Row, names: &[&str]) -> String {
    for name in names {
        let value = get_str_by_name(row, name);
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

fn nonblank(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

async fn query_first_nonblank_string(conn: &mut mysql_async::Conn, sql: &str) -> Option<String> {
    // MySQL reports nullable metadata such as TABLE_COLLATION as NULL for views.
    // Reading it as String makes mysql_async panic during row conversion.
    match query_first_column::<String>(conn, sql).await {
        Ok(value) => value.and_then(nonblank),
        Err(error) => {
            log::debug!("Failed to read optional MySQL database information with `{sql}`: {error}");
            None
        }
    }
}

pub async fn database_connection_info(
    pool: &MySqlPool,
    product_name: impl Into<String>,
) -> Result<DatabaseConnectionInfo, String> {
    let product_name = nonblank(product_name.into()).unwrap_or_else(|| "MySQL".to_string());
    let mut conn = get_conn_with_health_check(pool).await?;

    Ok(DatabaseConnectionInfo {
        product_name: Some(product_name),
        product_version: query_first_nonblank_string(&mut conn, "SELECT VERSION()").await,
        current_database: query_first_nonblank_string(&mut conn, "SELECT COALESCE(DATABASE(), '')").await,
        server_comment: query_first_nonblank_string(&mut conn, "SELECT @@version_comment").await,
        server_charset: query_first_nonblank_string(&mut conn, "SELECT @@character_set_server").await,
        server_collation: query_first_nonblank_string(&mut conn, "SELECT @@collation_server").await,
        ..DatabaseConnectionInfo::default()
    })
}

pub fn protocol_product_name(config: &ConnectionConfig) -> String {
    config.driver_label.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string).unwrap_or_else(
        || match config.db_type {
            DatabaseType::Doris => "Doris".to_string(),
            DatabaseType::StarRocks => "StarRocks".to_string(),
            DatabaseType::ManticoreSearch => "Manticore Search".to_string(),
            _ => "MySQL".to_string(),
        },
    )
}

fn get_opt_metadata_string(row: &mysql_async::Row, name: &str) -> Option<String> {
    get_opt_str(row, name)
        .or_else(|| row_get::<NaiveDateTime, _>(row, name).map(|value| value.to_string()))
        .or_else(|| row_get::<NaiveDate, _>(row, name).map(|value| value.to_string()))
        .or_else(|| row_get::<NaiveTime, _>(row, name).map(|value| value.to_string()))
}

fn get_opt_unsigned_metadata_string(row: &mysql_async::Row, name: &str) -> Option<String> {
    row_get::<u64, _>(row, name)
        .map(|value| value.to_string())
        .or_else(|| {
            row_get::<i64, _>(row, name).and_then(|value| u64::try_from(value).ok()).map(|value| value.to_string())
        })
        .or_else(|| {
            get_opt_str(row, name)
                .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
                .and_then(|value| value.parse::<u64>().ok().map(|parsed| parsed.to_string()))
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

fn get_opt_i64(row: &mysql_async::Row, name: &str) -> Option<i64> {
    row_get::<i64, _>(row, name)
        .or_else(|| row_get::<u64, _>(row, name).and_then(|value| i64::try_from(value).ok()))
        .or_else(|| row_get::<String, _>(row, name).and_then(|value| value.parse::<i64>().ok()))
        .or_else(|| {
            row_get::<Vec<u8>, _>(row, name)
                .and_then(|b| String::from_utf8(b).ok())
                .and_then(|value| value.parse::<i64>().ok())
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

fn is_mysql_binary_charset(column: &mysql_async::Column) -> bool {
    column.character_set() == 63
}

fn is_mysql_blob_column(column: &mysql_async::Column) -> bool {
    is_mysql_binary_charset(column)
        && matches!(
            column.column_type(),
            ColumnType::MYSQL_TYPE_BLOB
                | ColumnType::MYSQL_TYPE_LONG_BLOB
                | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
                | ColumnType::MYSQL_TYPE_TINY_BLOB
        )
}

fn is_mysql_binary_string_column(column: &mysql_async::Column) -> bool {
    let is_string = matches!(
        column.column_type(),
        ColumnType::MYSQL_TYPE_STRING | ColumnType::MYSQL_TYPE_VAR_STRING | ColumnType::MYSQL_TYPE_VARCHAR
    );
    if !is_string {
        return false;
    }

    if is_mysql_binary_charset(column) {
        return true;
    }

    // ShardingSphere Proxy 5.3.0 rewrites BINARY/VARBINARY result metadata to
    // utf8mb4 CHAR/VARCHAR, but preserves BINARY_FLAG and adds UNSIGNED_FLAG
    // to every string column. A real text column with a binary collation can
    // carry BINARY_FLAG, so require both flags to avoid converting it to Hex.
    let flags = column.flags();
    flags.contains(ColumnFlags::BINARY_FLAG) && flags.contains(ColumnFlags::UNSIGNED_FLAG)
}

fn mysql_blob_preview(bytes: &[u8], label: &str) -> serde_json::Value {
    if label == "BLOB" {
        return super::binary_value_to_json(bytes);
    }
    serde_json::Value::String(format!("({label}) {} bytes", bytes.len()))
}

fn mysql_bit_value_to_string(bytes: &[u8], column: &mysql_async::Column) -> String {
    let bit_len = column.column_length();
    if bit_len > 1 {
        let total_bits = bytes.len() * 8;
        let mut bits = String::with_capacity(total_bits);
        for byte in bytes {
            bits.push_str(&format!("{byte:08b}"));
        }
        let start = bits.len().saturating_sub(bit_len as usize);
        return bits[start..].to_string();
    }

    let val = bytes.iter().fold(0u64, |acc, &b| (acc << 8) | b as u64);
    val.to_string()
}

fn mysql_bytes_to_json(bytes: Vec<u8>, column: &mysql_async::Column) -> serde_json::Value {
    if is_mysql_blob_column(column) {
        return mysql_blob_preview(&bytes, "BLOB");
    }
    if is_mysql_binary_string_column(column) {
        return super::binary_value_to_json(&bytes);
    }
    serde_json::Value::String(bytes_to_string_lossy(bytes))
}

/// Map a MySQL column to a user-facing type name for the result-grid header.
/// Returns the bare lowercase type name (no length/precision/signedness), which
/// is enough for display; unknown variants fall back to a lowercased debug name.
///
/// MySQL's wire protocol uses the same `MYSQL_TYPE_*BLOB` codes for TEXT and BLOB
/// families. Binary charset (63) means BLOB; any other charset means TEXT. Value
/// decoding already follows that rule — the header type must match, or TEXT
/// columns flash as `blob` until table metadata arrives.
pub(crate) fn mysql_column_type_name(column: &mysql_async::Column) -> String {
    use mysql_async::consts::ColumnType::*;
    let ty = column.column_type();
    let flags = column.flags();
    let binary = is_mysql_binary_charset(column);
    match ty {
        MYSQL_TYPE_TINY => "tinyint",
        MYSQL_TYPE_SHORT => "smallint",
        MYSQL_TYPE_INT24 => "mediumint",
        MYSQL_TYPE_LONG => "int",
        MYSQL_TYPE_LONGLONG => "bigint",
        MYSQL_TYPE_FLOAT => "float",
        MYSQL_TYPE_DOUBLE => "double",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "decimal",
        MYSQL_TYPE_BIT => "bit",
        MYSQL_TYPE_YEAR => "year",
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "date",
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "time",
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "datetime",
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "timestamp",
        MYSQL_TYPE_JSON => "json",
        MYSQL_TYPE_ENUM => "enum",
        MYSQL_TYPE_SET => "set",
        MYSQL_TYPE_TINY_BLOB => {
            if binary {
                "tinyblob"
            } else {
                "tinytext"
            }
        }
        MYSQL_TYPE_MEDIUM_BLOB => {
            if binary {
                "mediumblob"
            } else {
                "mediumtext"
            }
        }
        MYSQL_TYPE_LONG_BLOB => {
            if binary {
                "longblob"
            } else {
                "longtext"
            }
        }
        MYSQL_TYPE_BLOB => {
            if binary {
                "blob"
            } else {
                "text"
            }
        }
        MYSQL_TYPE_VARCHAR | MYSQL_TYPE_VAR_STRING => {
            if is_mysql_binary_string_column(column) {
                "varbinary"
            } else {
                "varchar"
            }
        }
        MYSQL_TYPE_STRING => {
            // MySQL reports ENUM/SET result columns as STRING plus a flag,
            // rather than using the dedicated protocol type codes.
            if flags.contains(mysql_async::consts::ColumnFlags::ENUM_FLAG) {
                "enum"
            } else if flags.contains(mysql_async::consts::ColumnFlags::SET_FLAG) {
                "set"
            } else if is_mysql_binary_string_column(column) {
                "binary"
            } else {
                "char"
            }
        }
        MYSQL_TYPE_GEOMETRY => "geometry",
        MYSQL_TYPE_NULL => "null",
        other => return format!("{:?}", other).to_lowercase(),
    }
    .to_string()
}

pub(crate) fn mysql_value_to_json(row: &mysql_async::Row, idx: usize) -> serde_json::Value {
    let Some(column) = row.columns_ref().get(idx) else {
        return serde_json::Value::Null;
    };

    let Some(value) = row.as_ref(idx) else {
        return serde_json::Value::Null;
    };
    if matches!(value, mysql_async::Value::NULL) {
        return serde_json::Value::Null;
    }

    if is_mysql_binary_string_column(column) {
        return row_get::<Vec<u8>, _>(row, idx)
            .map(|bytes| mysql_bytes_to_json(bytes, column))
            .unwrap_or(serde_json::Value::Null);
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
                    .or_else(|| row_get::<Vec<u8>, _>(row, idx).map(|bytes| mysql_bytes_to_json(bytes, column)))
                    .unwrap_or(serde_json::Value::Null);
            }
            return row
                .get_opt::<Decimal, usize>(idx)
                .and_then(|result| result.ok())
                .map(|v: Decimal| serde_json::Value::String(v.to_string()))
                .unwrap_or(serde_json::Value::Null);
        }
        ColumnType::MYSQL_TYPE_BIT => {
            return row_get::<Vec<u8>, _>(row, idx)
                .map(|bytes| serde_json::Value::String(mysql_bit_value_to_string(&bytes, column)))
                .unwrap_or(serde_json::Value::Null);
        }
        ColumnType::MYSQL_TYPE_BLOB
        | ColumnType::MYSQL_TYPE_LONG_BLOB
        | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
        | ColumnType::MYSQL_TYPE_TINY_BLOB
        | ColumnType::MYSQL_TYPE_GEOMETRY => {
            return row_get::<Vec<u8>, _>(row, idx)
                .map(|bytes| {
                    if matches!(column.column_type(), ColumnType::MYSQL_TYPE_GEOMETRY) {
                        decode_mysql_geometry(&bytes)
                            .map(|geometry| geometry.wkt)
                            .map(serde_json::Value::String)
                            .unwrap_or_else(|| super::binary_value_to_json(&bytes))
                    } else {
                        mysql_bytes_to_json(bytes, column)
                    }
                })
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
            if let Some(value) = mysql_temporal_value_to_json(
                column.column_type(),
                row_get::<NaiveDateTime, _>(row, idx),
                row_get::<NaiveDate, _>(row, idx),
                row_get::<NaiveTime, _>(row, idx),
            ) {
                return value;
            }
        }
        _ => {}
    }

    row_get::<String, _>(row, idx)
        .map(|s| serde_json::Value::String(fix_potential_double_encoding(&s)))
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
        .or_else(|| row_get::<Vec<u8>, _>(row, idx).map(|bytes| mysql_bytes_to_json(bytes, column)))
        .unwrap_or(serde_json::Value::Null)
}

fn bytes_to_upper_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0F) as usize] as char);
    }
    output
}

// Native MySQL geometry values normally begin with a four-byte little-endian
// SRID prefix. A bare WKB value can have 0 or 1 at byte four as well, so only
// treat that prefix as present when the remaining bytes parse as WKB.
fn mysql_geometry_wkb_parts(bytes: &[u8]) -> Option<(&[u8], u32)> {
    if bytes.len() >= 5 && matches!(bytes[4], 0 | 1) {
        let prefix: [u8; 4] = bytes[..4].try_into().ok()?;
        if super::wkb::decode_wkb_geometry(&bytes[4..]).is_some() {
            return Some((&bytes[4..], u32::from_le_bytes(prefix)));
        }
    }
    super::wkb::decode_wkb_geometry(bytes).map(|_| (bytes, 0))
}

fn mysql_geometry_to_export_marker(bytes: &[u8]) -> Option<String> {
    let (wkb, srid) = mysql_geometry_wkb_parts(bytes)?;
    Some(format!("DBX_WKB:{srid}:{}", bytes_to_upper_hex(wkb)))
}

fn mysql_value_to_json_for_export(
    row: &mysql_async::Row,
    idx: usize,
    spatial_as_wkb: bool,
) -> Result<serde_json::Value, String> {
    if !spatial_as_wkb
        || !row.columns_ref().get(idx).is_some_and(|column| column.column_type() == ColumnType::MYSQL_TYPE_GEOMETRY)
    {
        return Ok(mysql_value_to_json(row, idx));
    }
    let Some(bytes) = row_get::<Vec<u8>, _>(row, idx) else {
        return Ok(mysql_value_to_json(row, idx));
    };
    mysql_geometry_to_export_marker(&bytes)
        .map(serde_json::Value::String)
        .ok_or_else(|| "Cannot export MySQL geometry value as WKB".to_string())
}

fn decode_mysql_geometry(bytes: &[u8]) -> Option<super::wkb::DecodedGeometry> {
    let (wkb, srid) = mysql_geometry_wkb_parts(bytes)?;
    let mut geometry = super::wkb::decode_wkb_geometry(wkb)?;
    if geometry.srid.is_none() {
        geometry.srid = (srid != 0).then_some(srid);
    }
    Some(geometry)
}

fn mysql_spatial_column_builder(columns: &[mysql_async::Column]) -> SpatialColumnBuilder {
    SpatialColumnBuilder::new(
        columns
            .iter()
            .enumerate()
            .filter_map(|(index, column)| (column.column_type() == ColumnType::MYSQL_TYPE_GEOMETRY).then_some(index)),
    )
}

fn mysql_result_cell_preview_bytes(
    max_result_bytes: usize,
    row_limit: usize,
    columns: &[mysql_async::Column],
) -> usize {
    let serialized_column_weight = columns
        .iter()
        .map(
            |column| {
                if is_mysql_blob_column(column) || is_mysql_binary_string_column(column) {
                    2usize
                } else {
                    1usize
                }
            },
        )
        .sum::<usize>()
        .max(1);
    max_result_bytes
        .checked_div(row_limit.max(1))
        .and_then(|per_row| per_row.checked_div(serialized_column_weight))
        .unwrap_or(MYSQL_RESULT_CELL_PREVIEW_MIN_BYTES)
        .clamp(MYSQL_RESULT_CELL_PREVIEW_MIN_BYTES, MYSQL_RESULT_CELL_PREVIEW_MAX_BYTES)
}

fn mysql_column_can_use_bounded_preview(column: &mysql_async::Column) -> bool {
    match column.column_type() {
        ColumnType::MYSQL_TYPE_JSON
        | ColumnType::MYSQL_TYPE_BLOB
        | ColumnType::MYSQL_TYPE_LONG_BLOB
        | ColumnType::MYSQL_TYPE_MEDIUM_BLOB => true,
        ColumnType::MYSQL_TYPE_TINY_BLOB => false,
        ColumnType::MYSQL_TYPE_STRING | ColumnType::MYSQL_TYPE_VAR_STRING | ColumnType::MYSQL_TYPE_VARCHAR => {
            column.column_length() > 8 * 1024
        }
        _ => false,
    }
}

fn mysql_bounded_value_preview(
    row: &mysql_async::Row,
    index: usize,
    preview_bytes: usize,
    protected_indexes: &HashSet<usize>,
) -> Option<(serde_json::Value, usize)> {
    if protected_indexes.contains(&index) {
        return None;
    }
    let column = row.columns_ref().get(index)?;
    if !mysql_column_can_use_bounded_preview(column) {
        return None;
    }
    let mysql_async::Value::Bytes(bytes) = row.as_ref(index)? else {
        return None;
    };
    if bytes.len() <= preview_bytes {
        return None;
    }

    let binary = is_mysql_binary_charset(column) || is_mysql_binary_string_column(column);
    let end = if binary {
        preview_bytes.min(bytes.len())
    } else {
        let mut end = preview_bytes.min(bytes.len());
        while end > 0 && std::str::from_utf8(&bytes[..end]).is_err() {
            end -= 1;
        }
        end
    };
    let mut value = if binary {
        mysql_bytes_to_json(bytes[..end].to_vec(), column)
    } else {
        let text = String::from_utf8_lossy(&bytes[..end]);
        serde_json::Value::String(fix_potential_double_encoding(&text))
    };
    if let serde_json::Value::String(text) = &mut value {
        text.push_str("...");
    }
    Some((value, bytes.len()))
}

fn mysql_result_protected_column_indexes(
    columns: &[mysql_async::Column],
    protected_columns: &[String],
) -> HashSet<usize> {
    let protected: HashSet<String> = protected_columns.iter().map(|column| column.to_ascii_lowercase()).collect();
    let mut indexes = columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| {
            (column.flags().contains(ColumnFlags::PRI_KEY_FLAG)
                || protected.contains(&column.name_str().to_ascii_lowercase()))
            .then_some(index)
        })
        .collect::<HashSet<_>>();
    for (index, column) in columns.iter().enumerate() {
        if column.name_str().to_ascii_uppercase().starts_with(crate::sql_dialect::DBX_LARGE_VALUE_BYTES_COLUMN_PREFIX) {
            indexes.insert(index);
            if index > 0 {
                indexes.insert(index - 1);
            }
        }
    }
    indexes
}

fn mysql_row_to_json_with_srids(
    row: &mysql_async::Row,
    spatial_columns: &mut SpatialColumnBuilder,
) -> (Vec<serde_json::Value>, Vec<Option<u32>>) {
    let mut srids = vec![None; row.len()];
    let values = (0..row.len())
        .map(|idx| {
            let is_geometry = row
                .columns_ref()
                .get(idx)
                .is_some_and(|column| column.column_type() == ColumnType::MYSQL_TYPE_GEOMETRY);
            if !is_geometry {
                return mysql_value_to_json(row, idx);
            }
            let Some(bytes) = row_get::<Vec<u8>, _>(row, idx) else {
                spatial_columns.observe(idx, None);
                return serde_json::Value::Null;
            };
            match decode_mysql_geometry(&bytes) {
                Some(geometry) => {
                    spatial_columns.observe(idx, geometry.srid);
                    srids[idx] = geometry.srid;
                    serde_json::Value::String(geometry.wkt)
                }
                None => {
                    spatial_columns.observe(idx, None);
                    super::binary_value_to_json(&bytes)
                }
            }
        })
        .collect();
    (values, srids)
}

fn mysql_row_to_json_with_srids_and_previews(
    row: &mysql_async::Row,
    spatial_columns: &mut SpatialColumnBuilder,
    row_index: usize,
    preview_bytes: Option<usize>,
    protected_indexes: &HashSet<usize>,
) -> (Vec<serde_json::Value>, Vec<Option<u32>>, Vec<LargeValueCell>) {
    let mut srids = vec![None; row.len()];
    let mut large_value_cells = Vec::new();
    let values = (0..row.len())
        .map(|index| {
            let is_geometry = row
                .columns_ref()
                .get(index)
                .is_some_and(|column| column.column_type() == ColumnType::MYSQL_TYPE_GEOMETRY);
            if is_geometry {
                let Some(bytes) = row_get::<Vec<u8>, _>(row, index) else {
                    spatial_columns.observe(index, None);
                    return serde_json::Value::Null;
                };
                return match decode_mysql_geometry(&bytes) {
                    Some(geometry) => {
                        spatial_columns.observe(index, geometry.srid);
                        srids[index] = geometry.srid;
                        serde_json::Value::String(geometry.wkt)
                    }
                    None => {
                        spatial_columns.observe(index, None);
                        super::binary_value_to_json(&bytes)
                    }
                };
            }

            if let Some((preview, original_bytes)) =
                preview_bytes.and_then(|limit| mysql_bounded_value_preview(row, index, limit, protected_indexes))
            {
                large_value_cells.push(LargeValueCell { row_index, column_index: index, original_bytes });
                return preview;
            }
            mysql_value_to_json(row, index)
        })
        .collect();
    (values, srids, large_value_cells)
}

fn mysql_temporal_value_to_json(
    column_type: ColumnType,
    datetime: Option<NaiveDateTime>,
    date: Option<NaiveDate>,
    time: Option<NaiveTime>,
) -> Option<serde_json::Value> {
    let value = match column_type {
        ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE => {
            date.map(|value| value.to_string()).or_else(|| datetime.map(|value| value.date().to_string()))?
        }
        ColumnType::MYSQL_TYPE_TIME | ColumnType::MYSQL_TYPE_TIME2 => time.map(|value| value.to_string())?,
        ColumnType::MYSQL_TYPE_TIMESTAMP
        | ColumnType::MYSQL_TYPE_TIMESTAMP2
        | ColumnType::MYSQL_TYPE_DATETIME
        | ColumnType::MYSQL_TYPE_DATETIME2 => datetime
            .map(|value| value.to_string())
            .or_else(|| date.map(|value| value.to_string()))
            .or_else(|| time.map(|value| value.to_string()))?,
        _ => return None,
    };
    Some(serde_json::Value::String(value))
}

pub async fn connect(url: &str, fallback_timeout: Duration) -> Result<MySqlPool, String> {
    connect_with_ca_cert(url, None, fallback_timeout).await
}

pub async fn connect_with_ca_cert(
    url: &str,
    ca_cert_path: Option<&str>,
    fallback_timeout: Duration,
) -> Result<MySqlPool, String> {
    connect_with_ca_cert_and_pool_limit(url, ca_cert_path, fallback_timeout, 10).await
}

pub async fn connect_with_ca_cert_and_pool_limit(
    url: &str,
    ca_cert_path: Option<&str>,
    fallback_timeout: Duration,
    max_connections: usize,
) -> Result<MySqlPool, String> {
    connect_with_ca_cert_pool_limit_and_idle(url, ca_cert_path, fallback_timeout, max_connections, None).await
}

pub async fn connect_with_ca_cert_pool_limit_and_idle(
    url: &str,
    ca_cert_path: Option<&str>,
    fallback_timeout: Duration,
    max_connections: usize,
    idle_timeout_secs: Option<u64>,
) -> Result<MySqlPool, String> {
    connect_with_ca_cert_pool_limit_idle_and_setup(
        url,
        ca_cert_path,
        fallback_timeout,
        max_connections,
        idle_timeout_secs,
        &[],
    )
    .await
}

pub async fn connect_with_ca_cert_pool_limit_idle_and_setup(
    url: &str,
    ca_cert_path: Option<&str>,
    fallback_timeout: Duration,
    max_connections: usize,
    idle_timeout_secs: Option<u64>,
    extra_setup_queries: &[String],
) -> Result<MySqlPool, String> {
    connect_with_ca_cert_pool_limit_idle_and_setup_database(
        url,
        ca_cert_path,
        fallback_timeout,
        max_connections,
        idle_timeout_secs,
        None,
        extra_setup_queries,
    )
    .await
}

pub async fn connect_with_ca_cert_pool_limit_idle_and_setup_database(
    url: &str,
    ca_cert_path: Option<&str>,
    fallback_timeout: Duration,
    max_connections: usize,
    idle_timeout_secs: Option<u64>,
    setup_database: Option<&str>,
    extra_setup_queries: &[String],
) -> Result<MySqlPool, String> {
    connect_with_ca_cert_pool_limit_idle_setup_database_with_mode(
        url,
        ca_cert_path,
        fallback_timeout,
        max_connections,
        idle_timeout_secs,
        setup_database,
        extra_setup_queries,
        MySqlSetupMode::Standard,
    )
    .await
}

pub async fn connect_compatible_with_ca_cert_pool_limit_idle_and_setup(
    url: &str,
    ca_cert_path: Option<&str>,
    fallback_timeout: Duration,
    max_connections: usize,
    idle_timeout_secs: Option<u64>,
    extra_setup_queries: &[String],
) -> Result<MySqlPool, String> {
    connect_compatible_with_ca_cert_pool_limit_idle_and_setup_database(
        url,
        ca_cert_path,
        fallback_timeout,
        max_connections,
        idle_timeout_secs,
        None,
        extra_setup_queries,
    )
    .await
}

pub async fn connect_compatible_with_ca_cert_pool_limit_idle_and_setup_database(
    url: &str,
    ca_cert_path: Option<&str>,
    fallback_timeout: Duration,
    max_connections: usize,
    idle_timeout_secs: Option<u64>,
    setup_database: Option<&str>,
    extra_setup_queries: &[String],
) -> Result<MySqlPool, String> {
    connect_with_ca_cert_pool_limit_idle_setup_database_with_mode(
        url,
        ca_cert_path,
        fallback_timeout,
        max_connections,
        idle_timeout_secs,
        setup_database,
        extra_setup_queries,
        MySqlSetupMode::Compatible,
    )
    .await
}

async fn connect_with_ca_cert_pool_limit_idle_setup_database_with_mode(
    url: &str,
    ca_cert_path: Option<&str>,
    fallback_timeout: Duration,
    max_connections: usize,
    idle_timeout_secs: Option<u64>,
    setup_database: Option<&str>,
    extra_setup_queries: &[String],
    setup_mode: MySqlSetupMode,
) -> Result<MySqlPool, String> {
    let timeout = super::parse_connect_timeout_with_fallback(url, fallback_timeout);
    let mut retry_url = url.to_string();
    let mut retry_ca_cert_path = ca_cert_path;
    let mut result = connect_pool_attempt(
        url,
        ca_cert_path,
        timeout,
        max_connections,
        idle_timeout_secs,
        setup_database,
        extra_setup_queries,
        setup_mode,
        MySqlEofMode::Deprecate,
    )
    .await;

    if result.as_ref().err().is_some_and(|error| mysql_error_should_retry_without_ssl(error)) {
        if let Some(fallback_url) = ssl_fallback_url(url) {
            log::info!("SSL handshake failed, retrying with ssl-mode=disabled");
            retry_url = fallback_url;
            retry_ca_cert_path = None;
            result = connect_pool_attempt(
                &retry_url,
                None,
                timeout,
                max_connections,
                idle_timeout_secs,
                setup_database,
                extra_setup_queries,
                setup_mode,
                MySqlEofMode::Deprecate,
            )
            .await;
        }
    }

    if result.as_ref().err().is_some_and(|error| mysql_error_should_retry_with_legacy_eof(error)) {
        log::info!("MySQL proxy returned legacy EOF packets; retrying with CLIENT_DEPRECATE_EOF disabled");
        return connect_pool_attempt(
            &retry_url,
            retry_ca_cert_path,
            timeout,
            max_connections,
            idle_timeout_secs,
            setup_database,
            extra_setup_queries,
            setup_mode,
            MySqlEofMode::Legacy,
        )
        .await;
    }

    result
}

#[allow(clippy::too_many_arguments)]
async fn connect_pool_attempt(
    url: &str,
    ca_cert_path: Option<&str>,
    timeout: Duration,
    max_connections: usize,
    idle_timeout_secs: Option<u64>,
    setup_database: Option<&str>,
    extra_setup_queries: &[String],
    setup_mode: MySqlSetupMode,
    eof_mode: MySqlEofMode,
) -> Result<MySqlPool, String> {
    let result = connect_pool_attempt_with_keepalive(
        url,
        ca_cert_path,
        timeout,
        max_connections,
        idle_timeout_secs,
        setup_database,
        extra_setup_queries,
        setup_mode,
        eof_mode,
        MySqlTcpKeepaliveMode::Enabled,
    )
    .await;
    if result.as_ref().err().is_some_and(|error| mysql_error_should_retry_without_tcp_keepalive(error)) {
        log::info!("MySQL connection returned EBADF; retrying with TCP keepalive disabled");
        return connect_pool_attempt_with_keepalive(
            url,
            ca_cert_path,
            timeout,
            max_connections,
            idle_timeout_secs,
            setup_database,
            extra_setup_queries,
            setup_mode,
            eof_mode,
            MySqlTcpKeepaliveMode::Disabled,
        )
        .await;
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn connect_pool_attempt_with_keepalive(
    url: &str,
    ca_cert_path: Option<&str>,
    timeout: Duration,
    max_connections: usize,
    idle_timeout_secs: Option<u64>,
    setup_database: Option<&str>,
    extra_setup_queries: &[String],
    setup_mode: MySqlSetupMode,
    eof_mode: MySqlEofMode,
    tcp_keepalive_mode: MySqlTcpKeepaliveMode,
) -> Result<MySqlPool, String> {
    let pool = create_pool(
        url,
        ca_cert_path,
        max_connections,
        idle_timeout_secs,
        setup_database,
        extra_setup_queries,
        setup_mode,
        eof_mode,
        tcp_keepalive_mode,
    )?;
    verify_pool_connection_with_setup_fallback(
        pool,
        timeout,
        url,
        ca_cert_path,
        max_connections,
        idle_timeout_secs,
        setup_database,
        extra_setup_queries,
        setup_mode,
        eof_mode,
        tcp_keepalive_mode,
    )
    .await
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct MySqlTlsFiles {
    sslcert: Option<String>,
    sslkey: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MySqlSetupMode {
    Standard,
    Compatible,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MySqlEofMode {
    Deprecate,
    Legacy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MySqlTcpKeepaliveMode {
    Enabled,
    Disabled,
}

impl MySqlEofMode {
    fn deprecate_eof(self) -> bool {
        self == Self::Deprecate
    }
}

impl MySqlTcpKeepaliveMode {
    fn duration(self) -> Option<Duration> {
        match self {
            Self::Enabled => Some(Duration::from_millis(u64::from(MYSQL_TCP_KEEPALIVE_MS))),
            Self::Disabled => None,
        }
    }
}

const MYSQL_GROUP_CONCAT_MAX_LEN: u64 = 1_048_576;

impl MySqlSetupMode {
    fn group_concat_max_len_query(self) -> Option<String> {
        match self {
            Self::Standard => Some(format!("SET SESSION group_concat_max_len = {MYSQL_GROUP_CONCAT_MAX_LEN}")),
            Self::Compatible => None,
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn verify_pool_connection_with_setup_fallback(
    pool: MySqlPool,
    timeout: Duration,
    url: &str,
    ca_cert_path: Option<&str>,
    max_connections: usize,
    idle_timeout_secs: Option<u64>,
    setup_database: Option<&str>,
    extra_setup_queries: &[String],
    setup_mode: MySqlSetupMode,
    eof_mode: MySqlEofMode,
    tcp_keepalive_mode: MySqlTcpKeepaliveMode,
) -> Result<MySqlPool, String> {
    match verify_pool_connection(&pool, timeout).await {
        Ok(()) => Ok(pool),
        Err(err) => {
            let Some(fallback_mode) = mysql_group_concat_setup_fallback_mode(setup_mode, &err) else {
                return Err(err);
            };
            log::info!(
                "MySQL server rejected optional group_concat_max_len setup; retrying with {fallback_mode:?} mode"
            );
            let fallback_pool = create_pool(
                url,
                ca_cert_path,
                max_connections,
                idle_timeout_secs,
                setup_database,
                extra_setup_queries,
                fallback_mode,
                eof_mode,
                tcp_keepalive_mode,
            )?;
            verify_pool_connection(&fallback_pool, timeout).await.map(|_| fallback_pool)
        }
    }
}

fn mysql_group_concat_setup_fallback_mode(setup_mode: MySqlSetupMode, error: &str) -> Option<MySqlSetupMode> {
    if setup_mode != MySqlSetupMode::Standard {
        return None;
    }

    let lower = error.to_ascii_lowercase();
    let setup_query_rejected = lower.contains("1193")
        || lower.contains("unknown system variable")
        || lower.contains("syntax error")
        || lower.contains("not supported");
    let sphinxql_setup_query_rejected = lower.contains("sphinxql")
        && lower.contains("only 0 and 1 could be used as boolean values")
        && lower.contains(&format!("near '{MYSQL_GROUP_CONCAT_MAX_LEN}'"));
    // Some MySQL gateways omit the variable name and report session-variable
    // changes as a forbidden global-variable operation.
    let gateway_session_variable_rejected =
        lower.contains("error 10192 (hy000)") && lower.contains("set global variables is forbidden");
    if (lower.contains("group_concat_max_len") && setup_query_rejected)
        || sphinxql_setup_query_rejected
        || gateway_session_variable_rejected
    {
        return Some(MySqlSetupMode::Compatible);
    }

    None
}

fn create_pool(
    url: &str,
    ca_cert_path: Option<&str>,
    max_connections: usize,
    idle_timeout_secs: Option<u64>,
    setup_database: Option<&str>,
    extra_setup_queries: &[String],
    setup_mode: MySqlSetupMode,
    eof_mode: MySqlEofMode,
    tcp_keepalive_mode: MySqlTcpKeepaliveMode,
) -> Result<MySqlPool, String> {
    let tls_url = mysql_tls_url(url)?;
    let local_infile_paths = mysql_local_infile_paths(&tls_url.url);
    let opts =
        mysql_async::Opts::from_url(&mysql_async_url(&tls_url.url)).map_err(|e| format!("Invalid MySQL URL: {e}"))?;
    let tcp_host = mysql_async_tcp_host(opts.ip_or_hostname()).to_string();
    let base_ssl_opts = opts.ssl_opts().cloned();
    let max_connections = max_connections.max(1);
    // Single-connection pools (max_connections == 1) are client session pools that
    // must preserve session state (e.g. TEMPORARY TABLEs) across queries.
    // Disable COM_RESET_CONNECTION for these pools to avoid clearing that state.
    let inactive_ttl =
        idle_timeout_secs.filter(|&s| s >= 30).map(Duration::from_secs).unwrap_or(Duration::from_secs(300));
    let pool_opts = mysql_async::PoolOpts::new()
        .with_constraints(mysql_async::PoolConstraints::new(1, max_connections).unwrap())
        .with_inactive_connection_ttl(inactive_ttl)
        .with_reset_connection(max_connections > 1);
    let setup_queries = match (setup_database, setup_mode) {
        (Some(database), MySqlSetupMode::Standard) => {
            mysql_setup_queries_for_database(url, Some(database), extra_setup_queries)
        }
        (None, MySqlSetupMode::Standard) => mysql_setup_queries(url, extra_setup_queries),
        (Some(database), MySqlSetupMode::Compatible) => {
            mysql_setup_queries_for_database_with_mode(url, Some(database), extra_setup_queries, setup_mode)
        }
        (None, MySqlSetupMode::Compatible) => mysql_setup_queries_with_mode(url, extra_setup_queries, setup_mode),
    };
    let mut builder = mysql_async::OptsBuilder::from_opts(opts)
        .ip_or_hostname(tcp_host)
        .stmt_cache_size(0)
        .prefer_socket(false)
        .pool_opts(Some(pool_opts))
        .tcp_keepalive(tcp_keepalive_mode.duration())
        .deprecate_eof(eof_mode.deprecate_eof())
        .setup(setup_queries);
    if let Some(ssl_opts) = mysql_ssl_opts(base_ssl_opts, url, ca_cert_path, &tls_url.files)? {
        builder = builder.ssl_opts(ssl_opts);
    }
    if !local_infile_paths.is_empty() {
        // LOCAL INFILE lets the server request a client-side file. Restrict it
        // to paths explicitly supplied by the user instead of enabling arbitrary reads.
        builder = builder.local_infile_handler(Some(mysql_async::WhiteListFsHandler::new(local_infile_paths)));
    }
    Ok(MySqlPool::new(builder, max_connections))
}

fn mysql_async_tcp_host(host: &str) -> &str {
    if let Some(inner) = host.strip_prefix('[').and_then(|value| value.strip_suffix(']')) {
        // mysql_async preserves IPv6 brackets when converting URL opts into an
        // OptsBuilder, but the builder TCP path resolves host strings directly.
        if inner.parse::<std::net::Ipv6Addr>().is_ok() {
            return inner;
        }
    }
    host
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MySqlTlsUrl {
    url: String,
    files: MySqlTlsFiles,
}

fn mysql_tls_url(url: &str) -> Result<MySqlTlsUrl, String> {
    let Some(query_start) = url.find('?') else {
        return Ok(MySqlTlsUrl { url: url.to_string(), files: MySqlTlsFiles::default() });
    };

    let prefix = &url[..query_start];
    let suffix = &url[query_start + 1..];
    let (query_string, fragment) = suffix.split_once('#').map_or((suffix, ""), |(query, fragment)| (query, fragment));
    let mut files = MySqlTlsFiles::default();
    let mut kept_params = Vec::new();

    for param in query_string.split('&') {
        if param.is_empty() {
            continue;
        }

        let Some((key, value)) = param.split_once('=') else {
            kept_params.push(param.to_string());
            continue;
        };

        if mysql_tls_file_param_is(key, "cert") || mysql_tls_file_param_is(key, "key") {
            let decoded = percent_decode_str(value)
                .decode_utf8()
                .map_err(|_| format!("Invalid URL encoding in {key}"))?
                .into_owned();
            validate_file_path(&decoded, |_| false).map_err(|e| format!("{key}: {e}"))?;

            if mysql_tls_file_param_is(key, "cert") {
                files.sslcert = Some(decoded);
            } else {
                files.sslkey = Some(decoded);
            }
        } else {
            kept_params.push(param.to_string());
        }
    }

    let mut sanitized_url = prefix.to_string();
    if !kept_params.is_empty() {
        sanitized_url.push('?');
        sanitized_url.push_str(&kept_params.join("&"));
    }
    if !fragment.is_empty() {
        sanitized_url.push('#');
        sanitized_url.push_str(fragment);
    }

    Ok(MySqlTlsUrl { url: sanitized_url, files })
}

fn mysql_tls_file_param_is(key: &str, target: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
    normalized == format!("ssl{target}")
}

fn mysql_ssl_opts(
    base_ssl_opts: Option<mysql_async::SslOpts>,
    url: &str,
    ca_cert_path: Option<&str>,
    files: &MySqlTlsFiles,
) -> Result<Option<mysql_async::SslOpts>, String> {
    let ca_cert_path = ca_cert_path.map(str::trim).filter(|path| !path.is_empty());
    let has_client_identity = files.sslcert.as_deref().is_some() || files.sslkey.as_deref().is_some();
    if !mysql_url_attempts_ssl(url) && !has_client_identity {
        return Ok(None);
    }

    let mut ssl_opts = base_ssl_opts.unwrap_or_default();
    if let Some(ca_cert_path) = ca_cert_path.filter(|_| mysql_url_attempts_ssl(url) || has_client_identity) {
        ssl_opts = ssl_opts.with_root_certs(vec![PathBuf::from(ca_cert_path).into()]);
        if !mysql_url_verifies_identity(url) {
            ssl_opts = ssl_opts.with_danger_skip_domain_validation(true);
        }
    }

    match (files.sslcert.as_deref(), files.sslkey.as_deref()) {
        (Some(cert_path), Some(key_path)) => {
            ssl_opts = ssl_opts.with_client_identity(Some(mysql_async::ClientIdentity::new(
                PathBuf::from(cert_path).into(),
                PathBuf::from(key_path).into(),
            )));
        }
        (Some(_), None) => return Err("MySQL ssl-cert requires ssl-key".to_string()),
        (None, Some(_)) => return Err("MySQL ssl-key requires ssl-cert".to_string()),
        (None, None) => {}
    }

    Ok(Some(ssl_opts))
}

fn mysql_setup_queries(url: &str, extra_setup_queries: &[String]) -> Vec<String> {
    mysql_setup_queries_with_mode(url, extra_setup_queries, MySqlSetupMode::Standard)
}

fn mysql_setup_queries_for_database(
    url: &str,
    setup_database: Option<&str>,
    extra_setup_queries: &[String],
) -> Vec<String> {
    mysql_setup_queries_for_database_with_mode(url, setup_database, extra_setup_queries, MySqlSetupMode::Standard)
}

fn mysql_setup_queries_with_mode(url: &str, extra_setup_queries: &[String], setup_mode: MySqlSetupMode) -> Vec<String> {
    mysql_setup_queries_for_database_with_mode(url, None, extra_setup_queries, setup_mode)
}

fn mysql_setup_queries_for_database_with_mode(
    url: &str,
    setup_database: Option<&str>,
    extra_setup_queries: &[String],
    setup_mode: MySqlSetupMode,
) -> Vec<String> {
    let charset = mysql_connection_charset(url).unwrap_or("utf8mb4");
    let database = setup_database.map(ToOwned::to_owned).or_else(|| mysql_connection_database(url));
    let mut queries = Vec::new();
    if let Some(database) = database.as_deref() {
        queries.push(format!("USE {}", quote_identifier(database)));
    }
    if let Some(time_zone) = mysql_connection_time_zone(url) {
        queries.push(format!("SET time_zone = {}", quote_value(&time_zone)));
    }
    if let Some(session_variables) = mysql_connection_session_variables(url) {
        queries.push(session_variables);
    }
    queries.push(format!("SET NAMES {charset}"));
    // MySQL defaults group_concat_max_len to 1024, which silently truncates
    // GROUP_CONCAT results. Skip it for MySQL protocol-compatible databases
    // such as old StarRocks versions that reject unknown MySQL variables.
    if let Some(query) = setup_mode.group_concat_max_len_query() {
        queries.push(query);
    }
    queries.extend(extra_setup_queries.iter().cloned());
    queries
}

fn catalog_switch_query(dialect: MySqlCatalogDialect, catalog: &str) -> String {
    let catalog = quote_identifier(catalog);
    match dialect {
        MySqlCatalogDialect::Doris => format!("SWITCH {catalog}"),
        MySqlCatalogDialect::StarRocks => format!("SET CATALOG {catalog}"),
    }
}

pub(crate) fn catalog_setup_query_for_url(dialect: MySqlCatalogDialect, url: &str) -> Option<String> {
    mysql_connection_catalog(url).map(|catalog| catalog_switch_query(dialect, &catalog))
}

pub(crate) fn catalog_database_context_queries(
    dialect: Option<MySqlCatalogDialect>,
    catalog: Option<&str>,
    database: &str,
) -> Result<Vec<String>, String> {
    let Some(catalog) = catalog.filter(|value| !value.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    let dialect = dialect.ok_or("Catalog selection is only supported for Doris and StarRocks")?;
    let mut queries = Vec::with_capacity(2);
    queries.push(catalog_switch_query(dialect, catalog));
    if !database.trim().is_empty() {
        queries.push(format!("USE {}", quote_identifier(database)));
    }
    Ok(queries)
}

pub(crate) async fn apply_catalog_database_context(
    conn: &mut mysql_async::Conn,
    dialect: Option<MySqlCatalogDialect>,
    catalog: Option<&str>,
    database: &str,
) -> Result<(), String> {
    for query in catalog_database_context_queries(dialect, catalog, database)? {
        conn.query_drop(&query).await.map_err(|error| format!("Failed to select query catalog/database: {error}"))?;
    }
    Ok(())
}

fn should_enable_explicit_timestamp_defaults(sql: &str) -> bool {
    if !starts_with_executable_sql_keyword(sql, &["CREATE", "ALTER"]) {
        return false;
    }
    let lower = sql.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    lower.contains("timestamp") && lower.contains("default null")
}

fn explicit_timestamp_defaults_sql(enabled: bool) -> &'static str {
    if enabled {
        "SET SESSION explicit_defaults_for_timestamp = ON"
    } else {
        "SET SESSION explicit_defaults_for_timestamp = OFF"
    }
}

async fn enable_explicit_timestamp_defaults_for_query(conn: &mut mysql_async::Conn, sql: &str) -> Option<bool> {
    if !should_enable_explicit_timestamp_defaults(sql) {
        return None;
    }

    let previous = match query_first_column::<u8>(conn, "SELECT @@SESSION.explicit_defaults_for_timestamp").await {
        Ok(Some(value)) => value != 0,
        Ok(None) => {
            log::debug!("Skipping MySQL explicit timestamp defaults compatibility setting: variable was empty");
            return None;
        }
        Err(err) => {
            log::debug!("Skipping MySQL explicit timestamp defaults compatibility setting: {err}");
            return None;
        }
    };

    if previous {
        return None;
    }

    if let Err(err) = conn.query_drop(explicit_timestamp_defaults_sql(true)).await {
        log::debug!("Skipping MySQL explicit timestamp defaults compatibility setting: {err}");
        return None;
    }

    Some(previous)
}

async fn restore_explicit_timestamp_defaults_for_query(conn: &mut mysql_async::Conn, previous: Option<bool>) {
    if let Some(previous) = previous {
        if let Err(err) = conn.query_drop(explicit_timestamp_defaults_sql(previous)).await {
            log::warn!("Failed to restore MySQL explicit timestamp defaults session setting: {err}");
        }
    }
}

fn mysql_connection_charset(url: &str) -> Option<&str> {
    let (_, query) = url.split_once('?')?;
    query.split('&').find_map(|segment| {
        let (key, value) = segment.split_once('=')?;
        if !key.eq_ignore_ascii_case("charset") {
            return None;
        }
        let value = value.trim();
        is_safe_mysql_charset_name(value).then_some(value)
    })
}

fn mysql_connection_database(url: &str) -> Option<String> {
    let rest = url.strip_prefix("mysql://")?;
    let (_, path_and_query) = rest.split_once('/')?;
    let path = path_and_query.split(['?', '#']).next().unwrap_or(path_and_query);
    let database = path.trim_start_matches('/').split('/').next().unwrap_or("").trim();
    if database.is_empty() {
        return None;
    }
    percent_decode_str(database).decode_utf8().ok().map(|value| value.into_owned())
}

/// Extracts an opt-in `catalog=<name>` URL parameter. dbx strips it from the
/// URL before handing it to mysql_async (see `is_dbx_handled_mysql_url_param`)
/// and emits the database-specific catalog switch during connection setup.
/// This is how StarRocks/Doris connections reach an external catalog such as Paimon.
fn mysql_connection_catalog(url: &str) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    let query = query.split('#').next().unwrap_or(query);
    query.split('&').find_map(|segment| {
        let (key, value) = segment.split_once('=')?;
        if !key.eq_ignore_ascii_case("catalog") {
            return None;
        }
        let value = value.trim();
        if value.is_empty() {
            return None;
        }
        percent_decode_str(value).decode_utf8().ok().map(|value| value.into_owned())
    })
}

fn mysql_connection_session_variables(url: &str) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    let query = query.split('#').next().unwrap_or(query);
    let value = query.split('&').find_map(|segment| {
        let (key, value) = segment.split_once('=')?;
        percent_decode_str(key).decode_utf8().ok().filter(|key| key.eq_ignore_ascii_case("sessionVariables"))?;
        percent_decode_str(value).decode_utf8().ok().map(|value| value.into_owned())
    })?;
    let assignments = split_mysql_session_variables(&value);
    if assignments.is_empty() {
        return None;
    }

    // Match Connector/J: separators inside strings or expressions are preserved,
    // while system variables receive SESSION and user variables keep their @ prefix.
    Some(format!(
        "SET {}",
        assignments
            .into_iter()
            .map(|assignment| {
                if assignment.starts_with('@') {
                    assignment
                } else {
                    format!("SESSION {assignment}")
                }
            })
            .collect::<Vec<_>>()
            .join(",")
    ))
}

fn mysql_local_infile_paths(url: &str) -> Vec<PathBuf> {
    let Some((_, query)) = url.split_once('?') else {
        return Vec::new();
    };
    let query = query.split('#').next().unwrap_or(query);
    query
        .split('&')
        .filter_map(|segment| {
            let (key, value) = segment.split_once('=')?;
            percent_decode_str(key).decode_utf8().ok().filter(|key| key.eq_ignore_ascii_case("localInfilePath"))?;
            let path = percent_decode_str(value).decode_utf8().ok()?.trim().to_string();
            (!path.is_empty()).then(|| PathBuf::from(path))
        })
        .collect()
}

fn split_mysql_session_variables(value: &str) -> Vec<String> {
    let chars: Vec<char> = value.chars().collect();
    let mut assignments = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut parenthesis_depth = 0usize;
    let mut index = 0usize;

    while index < chars.len() {
        let ch = chars[index];
        if let Some(active_quote) = quote {
            current.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == active_quote {
                if chars.get(index + 1) == Some(&active_quote) {
                    current.push(active_quote);
                    index += 1;
                } else {
                    quote = None;
                }
            }
            index += 1;
            continue;
        }

        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                current.push(ch);
            }
            '(' => {
                parenthesis_depth += 1;
                current.push(ch);
            }
            ')' => {
                parenthesis_depth = parenthesis_depth.saturating_sub(1);
                current.push(ch);
            }
            ',' | ';' if parenthesis_depth == 0 => {
                let assignment = current.trim();
                if !assignment.is_empty() {
                    assignments.push(assignment.to_string());
                }
                current.clear();
            }
            _ => current.push(ch),
        }
        index += 1;
    }

    let assignment = current.trim();
    if !assignment.is_empty() {
        assignments.push(assignment.to_string());
    }
    assignments
}

fn is_safe_mysql_charset_name(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn mysql_connection_time_zone(url: &str) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    let mut jdbc_time_zone: Option<String> = None;
    let mut go_location: Option<String> = None;

    for segment in query.split('&') {
        let Some((raw_key, raw_value)) = segment.split_once('=') else {
            continue;
        };
        let key = percent_decode_str(raw_key).decode_utf8_lossy();
        let value = percent_decode_str(raw_value).decode_utf8_lossy().trim().to_string();
        if value.is_empty() {
            continue;
        }

        if key.eq_ignore_ascii_case("time_zone")
            || key.eq_ignore_ascii_case("time-zone")
            || key.eq_ignore_ascii_case("timezone")
        {
            if let Some(value) = normalize_mysql_time_zone_value(&value) {
                return Some(value);
            }
        } else if key.eq_ignore_ascii_case("connectionTimeZone") || key.eq_ignore_ascii_case("serverTimezone") {
            if jdbc_time_zone.is_none() {
                jdbc_time_zone = normalize_mysql_time_zone_value(&value);
            }
        } else if key.eq_ignore_ascii_case("loc") && go_location.is_none() {
            go_location = normalize_mysql_time_zone_value(&value);
        }
    }

    jdbc_time_zone.or(go_location)
}

fn normalize_mysql_time_zone_value(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value.eq_ignore_ascii_case("local") {
        return Some(local_mysql_time_zone_offset());
    }
    if value.eq_ignore_ascii_case("utc") || value.eq_ignore_ascii_case("z") {
        return Some("+00:00".to_string());
    }
    if value.eq_ignore_ascii_case("system") {
        return Some("SYSTEM".to_string());
    }
    if let Some(offset) = normalize_mysql_time_zone_offset(value) {
        return Some(offset);
    }
    if let Some(offset_part) = value
        .strip_prefix("GMT")
        .or_else(|| value.strip_prefix("gmt"))
        .or_else(|| value.strip_prefix("UTC"))
        .or_else(|| value.strip_prefix("utc"))
    {
        if let Some(offset) = normalize_mysql_time_zone_offset(offset_part) {
            return Some(offset);
        }
    }
    is_safe_mysql_time_zone_name(value).then(|| value.to_string())
}

fn normalize_mysql_time_zone_offset(value: &str) -> Option<String> {
    let value = value.trim();
    let (sign, rest) = match value.as_bytes().first().copied()? {
        b'+' => ('+', &value[1..]),
        b'-' => ('-', &value[1..]),
        _ => return None,
    };
    let (hours, minutes) =
        if let Some((hours, minutes)) = rest.split_once(':') { (hours, minutes) } else { (rest, "0") };
    if hours.is_empty() || hours.len() > 2 || minutes.is_empty() || minutes.len() > 2 {
        return None;
    }
    let hours = hours.parse::<u8>().ok()?;
    let minutes = minutes.parse::<u8>().ok()?;
    if hours > 14 || minutes > 59 || (hours == 14 && minutes != 0) {
        return None;
    }
    Some(format!("{sign}{hours:02}:{minutes:02}"))
}

fn local_mysql_time_zone_offset() -> String {
    let seconds = chrono::Local::now().offset().local_minus_utc();
    let sign = if seconds < 0 { '-' } else { '+' };
    let seconds = seconds.abs();
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    format!("{sign}{hours:02}:{minutes:02}")
}

fn is_safe_mysql_time_zone_name(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b'+' | b':'))
}

async fn verify_pool_connection(pool: &MySqlPool, timeout: Duration) -> Result<(), String> {
    super::with_connection_timeout("MySQL", timeout, async {
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
        // Some older MySQL proxies report a failed preferred-TLS probe as a
        // protocol packet error instead of a TLS handshake error.
        || error.contains("packet out of order")
        // Some MySQL-compatible servers report a preferred-TLS attempt as a
        // normal server error instead of a TLS handshake error.
        || (error.contains("client asked for ssl") && error.contains("server does not have this capability"))
}

fn mysql_error_should_retry_with_legacy_eof(error: &str) -> bool {
    error.to_ascii_lowercase().contains("packets out of sync")
}

fn mysql_error_should_retry_without_tcp_keepalive(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("bad file descriptor") && error.contains("os error 9")
}

fn mysql_error_should_retry_with_text_protocol(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    (lower.contains("1105") && lower.contains("hy000"))
        || (lower.contains("1615") && lower.contains("re-prepared"))
        || lower.contains("com_stmt_prepare")
        || lower.contains("can't parse")
        || lower.contains("buf doesn't have enough data")
        || lower.contains("prepared statement protocol")
        || lower.contains("this command is not supported in the prepared statement protocol yet")
}

fn ssl_fallback_url(url: &str) -> Option<String> {
    if mysql_url_requires_ssl(url) {
        return None;
    }

    let (base_url, fragment) = url.split_once('#').map_or((url, ""), |(base, fragment)| (base, fragment));
    let Some(query_start) = base_url.find('?') else {
        let mut fallback = format!("{base_url}?ssl-mode=disabled");
        if !fragment.is_empty() {
            fallback.push('#');
            fallback.push_str(fragment);
        }
        return Some(fallback);
    };
    let prefix = &base_url[..query_start];
    let query_string = &base_url[query_start + 1..];
    let mut changed = false;
    let mut kept_params = Vec::new();

    for param in query_string.split('&') {
        if param.is_empty() {
            continue;
        }
        let Some((key, value)) = param.split_once('=') else {
            kept_params.push(param.to_string());
            continue;
        };
        if (key.eq_ignore_ascii_case("ssl-mode") || key.eq_ignore_ascii_case("sslmode"))
            && matches!(value.to_ascii_lowercase().replace('-', "_").as_str(), "preferred" | "prefer")
        {
            if !changed {
                kept_params.push("ssl-mode=disabled".to_string());
            }
            changed = true;
        } else {
            kept_params.push(param.to_string());
        }
    }

    if !changed
        && !kept_params.iter().any(|part| {
            part.split_once('=')
                .is_some_and(|(key, _)| key.eq_ignore_ascii_case("ssl-mode") || key.eq_ignore_ascii_case("sslmode"))
        })
    {
        kept_params.push("ssl-mode=disabled".to_string());
        changed = true;
    }

    if changed {
        let mut fallback = prefix.to_string();
        if !kept_params.is_empty() {
            fallback.push('?');
            fallback.push_str(&kept_params.join("&"));
        }
        if !fragment.is_empty() {
            fallback.push('#');
            fallback.push_str(fragment);
        }
        Some(fallback)
    } else {
        None
    }
}

fn mysql_url_requires_ssl(url: &str) -> bool {
    let Some((_, query)) = url.split_once('?') else {
        return false;
    };
    let query = query.split('#').next().unwrap_or(query);
    let has_native_tls_param = query.split('&').any(|segment| {
        let key = segment.split_once('=').map(|(key, _)| key).unwrap_or(segment).trim();
        key.eq_ignore_ascii_case("ssl-mode")
            || key.eq_ignore_ascii_case("sslmode")
            || key.eq_ignore_ascii_case("require_ssl")
    });
    let native_requires_ssl = query.split('&').any(|segment| {
        let Some((key, value)) = segment.split_once('=') else {
            return false;
        };
        let key = key.trim();
        let value = value.trim();
        (key.eq_ignore_ascii_case("require_ssl") && value.eq_ignore_ascii_case("true"))
            || mysql_tls_file_param_is(key, "cert")
            || mysql_tls_file_param_is(key, "key")
            || ((key.eq_ignore_ascii_case("ssl-mode") || key.eq_ignore_ascii_case("sslmode"))
                && matches!(
                    value.to_ascii_lowercase().replace('-', "_").as_str(),
                    "required" | "require" | "verify_ca" | "verify_identity"
                ))
    });
    native_requires_ssl
        || (!has_native_tls_param
            && matches!(
                mysql_jdbc_tls_mode(Some(query)),
                Some(MysqlJdbcTlsMode::Required | MysqlJdbcTlsMode::VerifyCa)
            ))
}

fn mysql_url_attempts_ssl(url: &str) -> bool {
    if mysql_url_requires_ssl(url) {
        return true;
    }

    let Some((_, query)) = url.split_once('?') else {
        return false;
    };
    let query = query.split('#').next().unwrap_or(query);
    let has_native_tls_param = query.split('&').any(|segment| {
        let key = segment.split_once('=').map(|(key, _)| key).unwrap_or(segment).trim();
        key.eq_ignore_ascii_case("ssl-mode")
            || key.eq_ignore_ascii_case("sslmode")
            || key.eq_ignore_ascii_case("require_ssl")
    });
    let native_attempts_ssl = query.split('&').any(|segment| {
        let Some((key, value)) = segment.split_once('=') else {
            return false;
        };
        let key = key.trim();
        let value = value.trim();
        (key.eq_ignore_ascii_case("ssl-mode") || key.eq_ignore_ascii_case("sslmode"))
            && matches!(value.to_ascii_lowercase().replace('-', "_").as_str(), "preferred" | "prefer")
    });
    native_attempts_ssl
        || (!has_native_tls_param
            && matches!(
                mysql_jdbc_tls_mode(Some(query)),
                Some(MysqlJdbcTlsMode::Preferred | MysqlJdbcTlsMode::Required | MysqlJdbcTlsMode::VerifyCa)
            ))
}

fn mysql_url_verifies_identity(url: &str) -> bool {
    let Some((_, query)) = url.split_once('?') else {
        return false;
    };
    query.split('&').any(|segment| {
        let Some((key, value)) = segment.split_once('=') else {
            return false;
        };
        let key = key.trim();
        let value = value.trim();
        (key.eq_ignore_ascii_case("verify_identity") && value.eq_ignore_ascii_case("true"))
            || ((key.eq_ignore_ascii_case("ssl-mode") || key.eq_ignore_ascii_case("sslmode"))
                && matches!(value.to_ascii_lowercase().replace('-', "_").as_str(), "verify_identity"))
    })
}

fn is_jdbc_param(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "useunicode"
            | "characterencoding"
            | "zerodatetimebehavior"
            | "usessl"
            | "servertimezone"
            | "allowpublickeyretrieval"
            | "autoreconnect"
            | "maxreconnects"
            | "uselegacydatetimecode"
            | "usecompression"
            | "cacheprepstmts"
            | "useserverprepstmts"
            | "useconfigs"
            | "usecursorfetch"
            | "defaultfetchsize"
            | "usejdbccomplianttimezoneshift"
            | "usesspscompatibletimezoneshift"
            | "failoverreadonly"
            | "maxallowedpacket"
            | "tinyint1isbit"
            | "transformedbitisboolean"
            | "yearisdatetype"
            | "createdatabaseifnotexist"
            | "allowmultiqueries"
            | "noaccesstoprocedurebodies"
            | "nullcatalogmeanscurrent"
            | "nullnamepatternmatchesall"
            | "dumponqueriesexception"
            | "enablequerytimeouts"
            | "useinformationschema"
            | "gatherperfmetrics"
            | "reportmetricsintervalmillis"
            | "maxquerysizetolog"
            | "packetdebugbuffersize"
            | "usenanosforelapsedtime"
            | "slowquerythresholdmillis"
            | "autoslowlog"
            | "explainslowqueries"
            | "resultsetsizethreshold"
            | "nettimeoutforstreamingresults"
            | "useusageadvisor"
            | "uselocalsessionstate"
            | "rewritebatchedstatements"
            | "prepstmtcachesqllimit"
            | "prepstmtcachesize"
    )
}

fn is_dbx_handled_mysql_url_param(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "charset"
            | "catalog"
            | "time_zone"
            | "time-zone"
            | "timezone"
            | "connect_timeout"
            | "connecttimeout"
            | "parsetime"
            | "loc"
            | "connectiontimezone"
            | "servertimezone"
            | "forceconnectiontimezonetosession"
            | "sessionvariables"
            | "localinfilepath"
    )
}

fn is_mysql_cleartext_password_param(key: &str) -> bool {
    matches!(key.to_ascii_lowercase().as_str(), "allowcleartextpasswords" | "enable_cleartext_plugin")
}

fn mysql_url_param_value_is_true(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on")
}

/// Strips the database path from a `mysql://[user[:pass]@]host[:port][/path]`
/// URL, returning only the scheme and authority. Used so mysql_async does not
/// send the database as the schema during the MySQL handshake (StarRocks would
/// reject an external-catalog database before the catalog switch runs in setup).
fn strip_mysql_url_path(base: &str) -> &str {
    let Some(rest) = base.strip_prefix("mysql://") else {
        return base;
    };
    match rest.find('/') {
        Some(idx) => &base[.."mysql://".len() + idx],
        None => base,
    }
}

fn mysql_async_url(url: &str) -> Cow<'_, str> {
    let Some((base, query)) = url.split_once('?') else {
        return Cow::Borrowed(url);
    };

    let original_count = query.split('&').filter(|segment| !segment.trim().is_empty()).count();
    let mut filtered: Vec<String> = Vec::new();
    let mut changed = false;
    let mut has_catalog = false;
    let mut enable_cleartext_plugin = false;
    let has_native_tls_param = query.split('&').any(|segment| {
        let key = segment.split_once('=').map(|(key, _)| key).unwrap_or(segment).trim();
        key.eq_ignore_ascii_case("ssl-mode")
            || key.eq_ignore_ascii_case("sslmode")
            || key.eq_ignore_ascii_case("require_ssl")
    });
    let jdbc_tls_mode = mysql_jdbc_tls_mode(Some(query));
    for segment in query.split('&') {
        let segment = segment.trim();
        if segment.is_empty() {
            changed = true;
            continue;
        }

        let Some((key, value)) = segment.split_once('=') else {
            filtered.push(segment.to_string());
            continue;
        };
        if key.eq_ignore_ascii_case("catalog") {
            has_catalog = true;
        }
        if is_mysql_cleartext_password_param(key) {
            changed = true;
            enable_cleartext_plugin |= mysql_url_param_value_is_true(value);
            continue;
        }
        if is_mysql_jdbc_tls_param(key) {
            changed = true;
            continue;
        }
        if is_dbx_handled_mysql_url_param(key) {
            changed = true;
            continue;
        }
        if key.eq_ignore_ascii_case("ssl-mode") || key.eq_ignore_ascii_case("sslmode") {
            changed = true;
            match value.to_ascii_lowercase().replace('-', "_").as_str() {
                "disabled" | "disable" => filtered.push("require_ssl=false".to_string()),
                "preferred" | "prefer" => {
                    filtered.push("require_ssl=true".to_string());
                    filtered.push("verify_ca=false".to_string());
                    filtered.push("verify_identity=false".to_string());
                }
                "required" | "require" => {
                    filtered.push("require_ssl=true".to_string());
                    filtered.push("verify_ca=false".to_string());
                    filtered.push("verify_identity=false".to_string());
                }
                "verify_ca" => {
                    filtered.push("require_ssl=true".to_string());
                    filtered.push("verify_identity=false".to_string());
                }
                "verify_identity" => filtered.push("require_ssl=true".to_string()),
                _ => {}
            }
            continue;
        }
        if is_jdbc_param(key) {
            changed = true;
            continue;
        }
        filtered.push(segment.to_string());
    }
    if !has_native_tls_param {
        match jdbc_tls_mode {
            Some(MysqlJdbcTlsMode::Disabled) => filtered.push("require_ssl=false".to_string()),
            Some(MysqlJdbcTlsMode::Preferred | MysqlJdbcTlsMode::Required) => {
                filtered.push("require_ssl=true".to_string());
                filtered.push("verify_ca=false".to_string());
                filtered.push("verify_identity=false".to_string());
            }
            Some(MysqlJdbcTlsMode::VerifyCa) => {
                filtered.push("require_ssl=true".to_string());
                filtered.push("verify_ca=true".to_string());
                filtered.push("verify_identity=false".to_string());
            }
            None => {}
        }
    }
    if enable_cleartext_plugin {
        filtered.push("enable_cleartext_plugin=true".to_string());
    }

    // When a catalog is configured, the database in the URL path must not be
    // sent as the schema during the MySQL handshake. Strip the path so mysql_async
    // connects without a default schema; the database is selected via setup queries.
    let base = if has_catalog { strip_mysql_url_path(base) } else { base };

    if !changed && filtered.len() == original_count && !has_catalog {
        Cow::Borrowed(url)
    } else if filtered.is_empty() {
        Cow::Owned(base.to_string())
    } else {
        Cow::Owned(format!("{base}?{}", filtered.join("&")))
    }
}

pub async fn connect_bare(url: &str, fallback_timeout: Duration) -> Result<MySqlPool, String> {
    connect_bare_with_pool_limit(url, fallback_timeout, 3).await
}

pub async fn connect_bare_with_pool_limit(
    url: &str,
    fallback_timeout: Duration,
    max_connections: usize,
) -> Result<MySqlPool, String> {
    connect_bare_with_pool_limit_and_setup(url, fallback_timeout, max_connections, &[]).await
}

pub async fn connect_bare_with_pool_limit_and_setup(
    url: &str,
    fallback_timeout: Duration,
    max_connections: usize,
    extra_setup_queries: &[String],
) -> Result<MySqlPool, String> {
    connect_bare_with_pool_limit_and_setup_database(url, fallback_timeout, max_connections, None, extra_setup_queries)
        .await
}

pub async fn connect_bare_with_pool_limit_and_setup_database(
    url: &str,
    fallback_timeout: Duration,
    max_connections: usize,
    setup_database: Option<&str>,
    extra_setup_queries: &[String],
) -> Result<MySqlPool, String> {
    let timeout = super::parse_connect_timeout_with_fallback(url, fallback_timeout);
    let result = connect_pool_attempt(
        url,
        None,
        timeout,
        max_connections,
        None,
        setup_database,
        extra_setup_queries,
        MySqlSetupMode::Compatible,
        MySqlEofMode::Deprecate,
    )
    .await;
    if result.as_ref().err().is_some_and(|error| mysql_error_should_retry_with_legacy_eof(error)) {
        log::info!(
            "MySQL proxy returned legacy EOF packets; retrying bare connection with CLIENT_DEPRECATE_EOF disabled"
        );
        return connect_pool_attempt(
            url,
            None,
            timeout,
            max_connections,
            None,
            setup_database,
            extra_setup_queries,
            MySqlSetupMode::Compatible,
            MySqlEofMode::Legacy,
        )
        .await;
    }
    result
}

const SHOW_DATABASES_SQL: &str = "SHOW DATABASES";
const INFORMATION_SCHEMA_DATABASES_SQL: &str =
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME";
const DATABASE_METADATA_SQL: &str = "SELECT s.SCHEMA_NAME, \
            s.DEFAULT_CHARACTER_SET_NAME, \
            s.DEFAULT_COLLATION_NAME, \
            SUM(COALESCE(t.DATA_LENGTH, 0) + COALESCE(t.INDEX_LENGTH, 0)) AS SIZE_BYTES \
     FROM information_schema.SCHEMATA s \
     LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME \
     GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME \
     ORDER BY s.SCHEMA_NAME";
const DATABASE_LIST_QUERY_PLAN: [(&str, bool); 2] =
    [(SHOW_DATABASES_SQL, true), (INFORMATION_SCHEMA_DATABASES_SQL, false)];

pub async fn list_databases(pool: &MySqlPool) -> Result<Vec<DatabaseInfo>, String> {
    list_databases_with_timeout(pool, super::connection_timeout()).await
}

pub async fn list_databases_with_timeout(pool: &MySqlPool, timeout: Duration) -> Result<Vec<DatabaseInfo>, String> {
    let [(primary_sql, primary_catalogless), (fallback_sql, fallback_catalogless)] = DATABASE_LIST_QUERY_PLAN;
    match list_databases_with_query(pool, primary_sql, primary_catalogless, timeout).await {
        Ok(databases) => Ok(databases),
        Err(err) => {
            log::debug!("Falling back to information_schema.SCHEMATA after SHOW DATABASES failed: {err}");
            list_databases_with_query(pool, fallback_sql, fallback_catalogless, timeout).await
        }
    }
}

pub async fn list_database_metadata(pool: &MySqlPool) -> Result<Vec<DatabaseInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = match conn.query_iter(DATABASE_METADATA_SQL).await {
        Ok(result) => result,
        Err(error) => {
            log::debug!("Falling back to database names after metadata query failed: {error}");
            drop(conn);
            return list_databases(pool).await;
        }
    };
    let rows: Vec<mysql_async::Row> = match result.collect_and_drop().await {
        Ok(rows) => rows,
        Err(error) => {
            log::debug!("Falling back to database names after metadata query failed: {error}");
            drop(conn);
            return list_databases(pool).await;
        }
    };
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = get_str(row, 0).trim().to_string();
            (!name.is_empty()).then_some(DatabaseInfo {
                name,
                size_bytes: get_opt_i64(row, "SIZE_BYTES"),
                default_charset: get_opt_str(row, "DEFAULT_CHARACTER_SET_NAME")
                    .filter(|value| !value.trim().is_empty()),
                default_collation: get_opt_str(row, "DEFAULT_COLLATION_NAME").filter(|value| !value.trim().is_empty()),
                ..Default::default()
            })
        })
        .collect())
}

async fn list_databases_with_query(
    pool: &MySqlPool,
    sql: &str,
    include_catalogless_when_blank: bool,
    timeout: Duration,
) -> Result<Vec<DatabaseInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, timeout).await?;
    let result = conn.query_iter(sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    Ok(database_infos_from_names(rows.iter().map(|row| get_str(row, 0)), include_catalogless_when_blank))
}

pub async fn list_databases_show(pool: &MySqlPool) -> Result<Vec<DatabaseInfo>, String> {
    list_databases_show_with_timeout(pool, super::connection_timeout()).await
}

pub async fn list_databases_show_with_timeout(
    pool: &MySqlPool,
    timeout: Duration,
) -> Result<Vec<DatabaseInfo>, String> {
    list_databases_with_query(pool, SHOW_DATABASES_SQL, true, timeout).await
}

pub(super) fn database_infos_from_names(
    names: impl IntoIterator<Item = String>,
    include_catalogless_when_blank: bool,
) -> Vec<DatabaseInfo> {
    let mut saw_row = false;
    let mut databases: Vec<DatabaseInfo> = names
        .into_iter()
        .filter_map(|name| {
            saw_row = true;
            let name = name.trim().to_string();
            (!name.is_empty()).then_some(DatabaseInfo { name, ..Default::default() })
        })
        .collect();
    databases.sort_by(|a, b| a.name.cmp(&b.name));
    if databases.is_empty() && saw_row && include_catalogless_when_blank {
        return vec![DatabaseInfo { name: String::new(), ..Default::default() }];
    }
    databases
}

pub async fn list_tables(pool: &MySqlPool, database: &str) -> Result<Vec<TableInfo>, String> {
    list_tables_filtered(pool, database, None, None, None, None, None).await
}

fn normalize_mysql_table_type(table_type: &str) -> String {
    let trimmed = table_type.trim();
    if trimmed.is_empty() {
        return "TABLE".to_string();
    }
    if trimmed.eq_ignore_ascii_case("VIEW") || trimmed.eq_ignore_ascii_case("SYSTEM VIEW") {
        return "VIEW".to_string();
    }
    trimmed.to_string()
}

pub async fn list_tables_filtered(
    pool: &MySqlPool,
    database: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
    table_name_filter: Option<&TableNameFilter>,
) -> Result<Vec<TableInfo>, String> {
    let sql = list_tables_sql(database, filter, limit, offset, object_types, table_name_filter);
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = match conn.query_iter(&sql).await {
        Ok(result) => result,
        Err(err) => {
            log::debug!(
                "Falling back to SHOW TABLES for database `{database}` after information_schema.TABLES failed: {err}"
            );
            return list_tables_show_filtered(pool, database, filter).await.map(|tables| {
                filter_list_tables_fallback(tables, filter, limit, offset, object_types, table_name_filter)
            });
        }
    };
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    let tables: Vec<TableInfo> = rows
        .iter()
        .filter_map(|row| {
            let name = get_str_by_name(row, "TABLE_NAME").trim().to_string();
            (!name.is_empty()).then_some(TableInfo {
                name,
                table_type: normalize_mysql_table_type(&get_str_by_name(row, "TABLE_TYPE")),
                comment: get_opt_str(row, "TABLE_COMMENT")
                    .map(|s| fix_potential_double_encoding(&s))
                    .filter(|s| !s.is_empty()),
                parent_schema: None,
                parent_name: None,
            })
        })
        .collect();

    if tables.is_empty() {
        log::debug!("Falling back to SHOW TABLES for database `{database}` after information_schema.TABLES returned no named tables");
        return list_tables_show_filtered(pool, database, filter)
            .await
            .map(|tables| filter_list_tables_fallback(tables, filter, limit, offset, object_types, table_name_filter));
    }

    Ok(tables)
}

fn filter_list_tables_fallback(
    tables: Vec<TableInfo>,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
    table_name_filter: Option<&TableNameFilter>,
) -> Vec<TableInfo> {
    let filter = filter.unwrap_or("").trim();
    let normalized_object_types: Vec<String> = object_types
        .unwrap_or(&[])
        .iter()
        .map(|object_type| object_type.to_ascii_uppercase().replace(' ', "_"))
        .collect();
    let wants_table =
        normalized_object_types.is_empty() || normalized_object_types.iter().any(|object_type| object_type == "TABLE");
    let wants_view =
        normalized_object_types.is_empty() || normalized_object_types.iter().any(|object_type| object_type == "VIEW");

    tables
        .into_iter()
        .filter(|table| {
            crate::sql::contains_or_fuzzy_match(&table.name, filter)
                || table.comment.as_deref().is_some_and(|comment| crate::sql::contains_or_fuzzy_match(comment, filter))
        })
        .filter(|table| table_name_filter_matches(&table.name, table_name_filter))
        .filter(|table| if table.table_type.eq_ignore_ascii_case("VIEW") { wants_view } else { wants_table })
        .skip(offset.unwrap_or(0))
        .take(limit.unwrap_or(usize::MAX))
        .collect()
}

fn list_tables_sql(
    database: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
    table_name_filter: Option<&TableNameFilter>,
) -> String {
    let mut sql = format!(
        "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = {}",
        quote_value(database),
    );
    if let Some(object_types) = object_types.filter(|object_types| !object_types.is_empty()) {
        let wants_table = object_types
            .iter()
            .map(|object_type| object_type.to_ascii_uppercase().replace(' ', "_"))
            .any(|object_type| object_type == "TABLE");
        let wants_view = object_types
            .iter()
            .map(|object_type| object_type.to_ascii_uppercase().replace(' ', "_"))
            .any(|object_type| object_type == "VIEW");
        match (wants_table, wants_view) {
            (true, false) => sql.push_str(" AND TABLE_TYPE NOT IN ('VIEW', 'SYSTEM VIEW')"),
            (false, true) => sql.push_str(" AND TABLE_TYPE IN ('VIEW', 'SYSTEM VIEW')"),
            (false, false) => sql.push_str(" AND 1 = 0"),
            (true, true) => {}
        }
    }
    if let Some(filter) = filter.map(str::trim).filter(|filter| !filter.is_empty()) {
        let escaped = filter.to_ascii_lowercase().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let pattern = format!("%{}%", escaped);
        if crate::sql::fuzzy_filter_enabled(filter) {
            let fuzzy_pattern = crate::sql::fuzzy_like_pattern_with_escape(&filter.to_ascii_lowercase(), |value| {
                value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
            });
            sql.push_str(&format!(
                " AND (LOWER(TABLE_NAME) LIKE {} ESCAPE '\\\\' OR LOWER(TABLE_COMMENT) LIKE {} ESCAPE '\\\\' OR LOWER(TABLE_NAME) LIKE {} ESCAPE '\\\\' OR LOWER(TABLE_COMMENT) LIKE {} ESCAPE '\\\\')",
                quote_value(&pattern),
                quote_value(&pattern),
                quote_value(&fuzzy_pattern),
                quote_value(&fuzzy_pattern)
            ));
        } else {
            sql.push_str(&format!(
                " AND (LOWER(TABLE_NAME) LIKE {} ESCAPE '\\\\' OR LOWER(TABLE_COMMENT) LIKE {} ESCAPE '\\\\')",
                quote_value(&pattern),
                quote_value(&pattern)
            ));
        }
    }
    append_table_name_filter_sql(&mut sql, table_name_filter);
    sql.push_str(" ORDER BY TABLE_NAME");
    if let Some(limit) = limit {
        sql.push_str(&format!(" LIMIT {}", limit));
    }
    if let Some(offset) = offset.filter(|offset| *offset > 0) {
        sql.push_str(&format!(" OFFSET {}", offset));
    }
    sql
}

fn quote_table_name_like_pattern(pattern: &str) -> String {
    quote_value(&pattern.trim().to_ascii_lowercase())
}

fn append_table_name_filter_sql(sql: &mut String, filter: Option<&TableNameFilter>) {
    let Some(filter) = filter.filter(|filter| !filter.is_empty()) else {
        return;
    };
    let include_patterns: Vec<&str> =
        filter.include_patterns.iter().map(|pattern| pattern.trim()).filter(|pattern| !pattern.is_empty()).collect();
    let exclude_patterns: Vec<&str> =
        filter.exclude_patterns.iter().map(|pattern| pattern.trim()).filter(|pattern| !pattern.is_empty()).collect();
    if !include_patterns.is_empty() {
        let clauses = include_patterns
            .iter()
            .map(|pattern| format!("LOWER(TABLE_NAME) LIKE {} ESCAPE '\\\\'", quote_table_name_like_pattern(pattern)))
            .collect::<Vec<_>>()
            .join(" OR ");
        sql.push_str(&format!(" AND ({clauses})"));
    }
    for pattern in exclude_patterns {
        sql.push_str(&format!(
            " AND LOWER(TABLE_NAME) NOT LIKE {} ESCAPE '\\\\'",
            quote_table_name_like_pattern(pattern)
        ));
    }
}

pub async fn completion_assistant_search(
    pool: &MySqlPool,
    request: &CompletionAssistantRequest,
) -> Result<CompletionAssistantResponse, String> {
    let database = request.schema.as_deref().filter(|schema| !schema.trim().is_empty()).unwrap_or(&request.database);
    let limit = request.max_results.unwrap_or(100).clamp(1, 1000);
    let kinds = if request.object_kinds.is_empty() {
        vec![CompletionAssistantObjectKind::Table, CompletionAssistantObjectKind::View]
    } else {
        request.object_kinds.clone()
    };
    let pattern = mysql_completion_like_pattern(&request.mask, request.match_mode.as_ref());
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let mut candidates = Vec::new();

    if kinds
        .iter()
        .any(|kind| matches!(kind, CompletionAssistantObjectKind::Database | CompletionAssistantObjectKind::Schema))
    {
        let sql = mysql_completion_schemas_sql(&pattern, limit.saturating_sub(candidates.len()));
        let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
        let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
        for row in rows {
            let schema_name = get_str_by_name(&row, "schema_name");
            candidates.push(CompletionAssistantCandidate {
                name: schema_name.clone(),
                kind: CompletionAssistantCandidateKind::Schema,
                database: Some(schema_name.clone()),
                schema: Some(schema_name),
                parent_schema: None,
                parent_name: None,
                comment: None,
                data_type: None,
                signature: None,
            });
        }
    }

    if candidates.len() < limit && kinds.iter().any(CompletionAssistantObjectKind::is_table_like) {
        let sql = mysql_completion_tables_sql(database, &pattern, &kinds, limit.saturating_sub(candidates.len()));
        let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
        let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
        for row in rows {
            let table_type = get_str_by_name(&row, "table_type");
            candidates.push(CompletionAssistantCandidate {
                name: get_str_by_name(&row, "object_name"),
                kind: if table_type.eq_ignore_ascii_case("VIEW") {
                    CompletionAssistantCandidateKind::View
                } else {
                    CompletionAssistantCandidateKind::Table
                },
                database: Some(database.to_string()),
                schema: Some(database.to_string()),
                parent_schema: None,
                parent_name: None,
                comment: get_opt_str(&row, "object_comment")
                    .map(|s| fix_potential_double_encoding(&s))
                    .filter(|s| !s.is_empty()),
                data_type: None,
                signature: None,
            });
        }
    }

    if candidates.len() < limit && kinds.iter().any(CompletionAssistantObjectKind::is_routine_like) {
        let sql = mysql_completion_routines_sql(database, &pattern, &kinds, limit.saturating_sub(candidates.len()));
        let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
        let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
        for row in rows {
            let routine_type = get_str_by_name(&row, "routine_type");
            candidates.push(CompletionAssistantCandidate {
                name: get_str_by_name(&row, "object_name"),
                kind: if routine_type.eq_ignore_ascii_case("PROCEDURE") {
                    CompletionAssistantCandidateKind::Procedure
                } else {
                    CompletionAssistantCandidateKind::Function
                },
                database: Some(database.to_string()),
                schema: Some(database.to_string()),
                parent_schema: None,
                parent_name: None,
                comment: get_opt_str(&row, "object_comment")
                    .map(|s| fix_potential_double_encoding(&s))
                    .filter(|s| !s.is_empty()),
                data_type: get_opt_str(&row, "data_type"),
                signature: None,
            });
        }
    }

    if candidates.len() < limit && kinds.iter().any(|kind| matches!(kind, CompletionAssistantObjectKind::Column)) {
        if let Some(table) = request.parent_name.as_deref().filter(|table| !table.trim().is_empty()) {
            let sql = mysql_completion_columns_sql(database, table, &pattern, limit.saturating_sub(candidates.len()));
            let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
            let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
            for row in rows {
                candidates.push(CompletionAssistantCandidate {
                    name: get_str_by_name(&row, "object_name"),
                    kind: CompletionAssistantCandidateKind::Column,
                    database: Some(database.to_string()),
                    schema: Some(database.to_string()),
                    parent_schema: Some(database.to_string()),
                    parent_name: Some(table.to_string()),
                    comment: get_opt_str(&row, "object_comment")
                        .map(|s| fix_potential_double_encoding(&s))
                        .filter(|s| !s.is_empty()),
                    data_type: Some(get_str_by_name(&row, "data_type")),
                    signature: None,
                });
            }
        }
    }

    Ok(CompletionAssistantResponse { incomplete: candidates.len() >= limit, candidates, fallback_used: false })
}

fn mysql_completion_schemas_sql(pattern: &str, limit: usize) -> String {
    format!(
        "SELECT SCHEMA_NAME AS schema_name \
         FROM information_schema.SCHEMATA \
         WHERE SCHEMA_NAME LIKE {} ESCAPE '\\\\' \
         ORDER BY SCHEMA_NAME LIMIT {}",
        quote_value(pattern),
        limit,
    )
}

fn mysql_completion_tables_sql(
    database: &str,
    pattern: &str,
    kinds: &[CompletionAssistantObjectKind],
    limit: usize,
) -> String {
    let table_types = mysql_completion_table_types(kinds);
    format!(
        "SELECT TABLE_NAME AS object_name, TABLE_TYPE AS table_type, TABLE_COMMENT AS object_comment \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = {db} AND TABLE_NAME LIKE {pattern} ESCAPE '\\\\' AND TABLE_TYPE IN ({table_types}) \
         ORDER BY TABLE_NAME LIMIT {limit}",
        db = quote_value(database),
        pattern = quote_value(pattern),
        table_types = table_types,
        limit = limit,
    )
}

fn mysql_completion_routines_sql(
    database: &str,
    pattern: &str,
    kinds: &[CompletionAssistantObjectKind],
    limit: usize,
) -> String {
    let routine_types = mysql_completion_routine_types(kinds);
    format!(
        "SELECT ROUTINE_NAME AS object_name, ROUTINE_TYPE AS routine_type, ROUTINE_COMMENT AS object_comment, DATA_TYPE AS data_type \
         FROM information_schema.ROUTINES \
         WHERE ROUTINE_SCHEMA = {db} AND ROUTINE_NAME LIKE {pattern} ESCAPE '\\\\' AND ROUTINE_TYPE IN ({routine_types}) \
         ORDER BY ROUTINE_NAME LIMIT {limit}",
        db = quote_value(database),
        pattern = quote_value(pattern),
        routine_types = routine_types,
        limit = limit,
    )
}

fn mysql_completion_columns_sql(database: &str, table: &str, pattern: &str, limit: usize) -> String {
    format!(
        "SELECT COLUMN_NAME AS object_name, COLUMN_TYPE AS data_type, COLUMN_COMMENT AS object_comment \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = {db} AND TABLE_NAME = {table} AND COLUMN_NAME LIKE {pattern} ESCAPE '\\\\' \
         ORDER BY ORDINAL_POSITION LIMIT {limit}",
        db = quote_value(database),
        table = quote_value(table),
        pattern = quote_value(pattern),
        limit = limit,
    )
}

fn mysql_completion_table_types(kinds: &[CompletionAssistantObjectKind]) -> String {
    let mut types = Vec::new();
    if kinds.iter().any(|kind| matches!(kind, CompletionAssistantObjectKind::Table)) {
        types.push("'BASE TABLE'");
        types.push("'SYSTEM VERSIONED'");
    }
    if kinds.iter().any(|kind| matches!(kind, CompletionAssistantObjectKind::View)) {
        types.push("'VIEW'");
    }
    if types.is_empty() {
        "'BASE TABLE','VIEW'".to_string()
    } else {
        types.join(",")
    }
}

fn mysql_completion_routine_types(kinds: &[CompletionAssistantObjectKind]) -> String {
    let mut types = Vec::new();
    if kinds
        .iter()
        .any(|kind| matches!(kind, CompletionAssistantObjectKind::Procedure | CompletionAssistantObjectKind::Routine))
    {
        types.push("'PROCEDURE'");
    }
    if kinds
        .iter()
        .any(|kind| matches!(kind, CompletionAssistantObjectKind::Function | CompletionAssistantObjectKind::Routine))
    {
        types.push("'FUNCTION'");
    }
    if types.is_empty() {
        "'PROCEDURE','FUNCTION'".to_string()
    } else {
        types.join(",")
    }
}

fn mysql_completion_like_pattern(value: &str, mode: Option<&CompletionAssistantMatchMode>) -> String {
    if value.trim().is_empty() || value == "%" {
        return "%".to_string();
    }
    let escaped = value.trim().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    match mode.unwrap_or(&CompletionAssistantMatchMode::Prefix) {
        CompletionAssistantMatchMode::Prefix => format!("{escaped}%"),
        CompletionAssistantMatchMode::Contains => format!("%{escaped}%"),
    }
}

fn table_comment_sql(database: &str, table: &str) -> String {
    format!(
        "SELECT TABLE_COMMENT \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} AND TABLE_TYPE <> 'VIEW' \
         LIMIT 1",
        quote_value(database),
        quote_value(table),
    )
}

pub async fn get_table_comment(pool: &MySqlPool, database: &str, table: &str) -> Result<Option<String>, String> {
    let sql = table_comment_sql(database, table);
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    Ok(rows
        .first()
        .and_then(|row| get_opt_str(row, "TABLE_COMMENT"))
        .map(|s| fix_potential_double_encoding(&s))
        .filter(|s| !s.is_empty()))
}

#[derive(Clone, Debug, Default)]
pub(super) struct TableStatusMeta {
    comment: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    auto_increment: Option<String>,
}

const MYSQL_FRESH_TABLE_STATUS_SESSION_SQL: &str = "/*!80000 SET SESSION information_schema_stats_expiry = 0 */";

async fn list_table_status_show(pool: &MySqlPool, database: &str) -> Result<HashMap<String, TableStatusMeta>, String> {
    query_table_status_show(pool, database, None).await
}

async fn list_table_status_show_filtered(
    pool: &MySqlPool,
    database: &str,
    filter: Option<&str>,
) -> Result<HashMap<String, TableStatusMeta>, String> {
    match query_table_status_show(pool, database, filter).await {
        Ok(status) => Ok(status),
        Err(filtered_err) => {
            log::debug!(
                "Falling back to unfiltered SHOW TABLE STATUS for database `{database}` after filtered SHOW failed: {filtered_err}"
            );
            query_table_status_show(pool, database, None)
                .await
                .map(|status| filter_table_status_fallback(status, filter))
        }
    }
}

async fn query_table_status_show(
    pool: &MySqlPool,
    database: &str,
    filter: Option<&str>,
) -> Result<HashMap<String, TableStatusMeta>, String> {
    let sql = show_table_status_sql(database, filter);
    query_table_status_sql(pool, &sql).await
}

async fn query_table_status_sql(pool: &MySqlPool, sql: &str) -> Result<HashMap<String, TableStatusMeta>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    query_table_status_sql_with_conn(&mut conn, sql).await
}

async fn query_table_status_sql_with_conn(
    conn: &mut mysql_async::Conn,
    sql: &str,
) -> Result<HashMap<String, TableStatusMeta>, String> {
    let result = conn.query_iter(sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| {
            (
                get_str_by_name(row, "Name"),
                TableStatusMeta {
                    comment: get_opt_metadata_string(row, "Comment")
                        .map(|s| fix_potential_double_encoding(&s))
                        .filter(|s| !s.is_empty()),
                    created_at: get_opt_metadata_string(row, "Create_time"),
                    updated_at: get_opt_metadata_string(row, "Update_time"),
                    auto_increment: get_opt_unsigned_metadata_string(row, "Auto_increment"),
                },
            )
        })
        .filter(|(name, _)| !name.is_empty())
        .collect())
}

pub async fn get_table_auto_increment(pool: &MySqlPool, database: &str, table: &str) -> Result<Option<String>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    // MySQL 8 caches SHOW TABLE STATUS statistics by default, including the
    // counter after ALTER TABLE. The version comment is a no-op on MySQL 5.7.
    if let Err(error) = conn.query_drop(MYSQL_FRESH_TABLE_STATUS_SESSION_SQL).await {
        log::debug!("Failed to disable cached MySQL table statistics before reading AUTO_INCREMENT: {error}");
    }
    let status = query_table_status_sql_with_conn(&mut conn, &show_table_status_exact_sql(database, table)).await?;
    Ok(status.into_values().next().and_then(|meta| meta.auto_increment))
}

fn filter_table_status_fallback(
    status: HashMap<String, TableStatusMeta>,
    filter: Option<&str>,
) -> HashMap<String, TableStatusMeta> {
    let filter = filter.unwrap_or("").trim();
    status
        .into_iter()
        .filter(|(name, meta)| {
            crate::sql::contains_or_fuzzy_match(name, filter)
                || meta.comment.as_deref().is_some_and(|comment| crate::sql::contains_or_fuzzy_match(comment, filter))
        })
        .collect()
}

async fn list_table_names_show(pool: &MySqlPool, database: &str) -> Result<Vec<TableInfo>, String> {
    list_table_names_show_filtered(pool, database, None, &[]).await
}

fn logical_show_full_tables_sql(database: &str) -> String {
    if database.trim().is_empty() {
        "SHOW FULL TABLES".to_string()
    } else {
        format!("SHOW FULL TABLES FROM {}", quote_identifier(database))
    }
}

fn table_infos_from_show_rows(rows: &[mysql_async::Row]) -> Vec<TableInfo> {
    let mut tables = rows
        .iter()
        .filter_map(|row| {
            let name = get_str(row, 0).trim().to_string();
            if name.is_empty() {
                return None;
            }
            let table_type = normalize_mysql_table_type(&get_str(row, 1));
            Some(TableInfo { name, table_type, comment: None, parent_schema: None, parent_name: None })
        })
        .collect::<Vec<_>>();
    tables.sort_by(|a, b| a.name.cmp(&b.name));
    tables
}

pub async fn list_logical_tables_show(pool: &MySqlPool, database: &str) -> Result<Vec<TableInfo>, String> {
    // Proxy logical names are authoritative here. Do not add SHOW TABLE STATUS: this hot
    // path must replace the information_schema lookup with one metadata request.
    let sql = logical_show_full_tables_sql(database);
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = conn.query_iter(&sql).await.map_err(|error| error.to_string())?;
    let rows = result.collect_and_drop::<mysql_async::Row>().await.map_err(|error| error.to_string())?;
    Ok(table_infos_from_show_rows(&rows))
}

async fn list_logical_table_objects_show_filtered(
    pool: &MySqlPool,
    database: &str,
    object_types: Option<&[String]>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<ObjectInfo>, String> {
    let tables = list_logical_tables_show(pool, database).await?;
    Ok(filter_table_objects_fallback(
        table_infos_to_objects(tables, &HashMap::new(), database),
        object_types,
        limit,
        offset,
    ))
}

async fn list_table_names_show_filtered(
    pool: &MySqlPool,
    database: &str,
    filter: Option<&str>,
    exact_names: &[String],
) -> Result<Vec<TableInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    list_table_names_show_filtered_with_conn(&mut conn, database, filter, exact_names).await
}

pub(super) async fn list_table_names_show_filtered_with_conn(
    conn: &mut mysql_async::Conn,
    database: &str,
    filter: Option<&str>,
    exact_names: &[String],
) -> Result<Vec<TableInfo>, String> {
    let mut last_error = None;
    let mut rows = None;
    for attempt in show_tables_query_attempts(database, filter, exact_names) {
        match conn.query_iter(&attempt.sql).await {
            Ok(result) => match result.collect_and_drop::<mysql_async::Row>().await {
                Ok(result_rows) => {
                    rows = Some(result_rows);
                    break;
                }
                Err(err) => last_error = Some(err.to_string()),
            },
            Err(err) => {
                if attempt.server_filtered {
                    log::debug!(
                        "Filtered SHOW TABLES is unsupported for database `{database}`; trying a compatible SHOW form: {err}"
                    );
                }
                last_error = Some(err.to_string());
            }
        }
    }
    let rows = rows.ok_or_else(|| last_error.unwrap_or_else(|| "SHOW TABLES returned no result".to_string()))?;
    Ok(table_infos_from_show_rows(&rows))
}

struct ShowTablesQueryAttempt {
    sql: String,
    server_filtered: bool,
}

fn show_tables_query_attempts(
    database: &str,
    filter: Option<&str>,
    exact_names: &[String],
) -> Vec<ShowTablesQueryAttempt> {
    // DBeaver-style server filtering is preferred for large schemas, but some
    // MySQL proxies only implement bare SHOW TABLES forms.
    let filtered_full = show_tables_filtered_sql(database, true, filter, exact_names);
    let filtered_plain = show_tables_filtered_sql(database, false, filter, exact_names);
    let unfiltered_full = show_tables_filtered_sql(database, true, None, &[]);
    let unfiltered_plain = show_tables_filtered_sql(database, false, None, &[]);
    let has_server_filter = filtered_full != unfiltered_full;
    let mut attempts = Vec::with_capacity(if has_server_filter { 4 } else { 2 });
    if has_server_filter {
        attempts.push(ShowTablesQueryAttempt { sql: filtered_full, server_filtered: true });
        attempts.push(ShowTablesQueryAttempt { sql: filtered_plain, server_filtered: true });
    }
    attempts.push(ShowTablesQueryAttempt { sql: unfiltered_full, server_filtered: false });
    attempts.push(ShowTablesQueryAttempt { sql: unfiltered_plain, server_filtered: false });
    attempts
}

fn show_tables_filtered_sql(database: &str, full: bool, filter: Option<&str>, exact_names: &[String]) -> String {
    let prefix = if full { "SHOW FULL TABLES" } else { "SHOW TABLES" };
    let mut sql = if database.trim().is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix} FROM {}", quote_identifier(database))
    };
    let conditions = show_tables_filter_conditions(database, filter, exact_names);
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" OR "));
    }
    sql
}

fn show_table_status_sql(database: &str, filter: Option<&str>) -> String {
    let mut sql = if database.trim().is_empty() {
        "SHOW TABLE STATUS".to_string()
    } else {
        format!("SHOW TABLE STATUS FROM {}", quote_identifier(database))
    };
    if let Some(filter) = filter.map(str::trim).filter(|filter| !filter.is_empty()) {
        let patterns = mysql_fallback_like_patterns(filter);
        let conditions = patterns
            .iter()
            .flat_map(|pattern| {
                [
                    format!("Name LIKE {} ESCAPE '\\\\'", quote_value(pattern)),
                    format!("Comment LIKE {} ESCAPE '\\\\'", quote_value(pattern)),
                ]
            })
            .collect::<Vec<_>>();
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" OR "));
    }
    sql
}

fn show_table_status_exact_sql(database: &str, table: &str) -> String {
    let prefix = if database.trim().is_empty() {
        "SHOW TABLE STATUS".to_string()
    } else {
        format!("SHOW TABLE STATUS FROM {}", quote_identifier(database))
    };
    format!("{prefix} WHERE Name = {}", quote_value(table))
}

fn show_tables_filter_conditions(database: &str, filter: Option<&str>, exact_names: &[String]) -> Vec<String> {
    if database.trim().is_empty() {
        // Catalogless services do not expose a stable Tables_in_<db> column name.
        // Preserve the existing compatible SHOW syntax; local filtering still
        // guarantees correctness for these uncommon endpoints.
        return Vec::new();
    }
    let table_name_column = quote_identifier(&format!("Tables_in_{database}"));
    let mut conditions = filter
        .map(str::trim)
        .filter(|filter| !filter.is_empty())
        .into_iter()
        .flat_map(mysql_fallback_like_patterns)
        .map(|pattern| format!("{table_name_column} LIKE {} ESCAPE '\\\\'", quote_value(&pattern)))
        .collect::<Vec<_>>();
    conditions.extend(exact_names.iter().map(|name| format!("{table_name_column} = {}", quote_value(name))));
    conditions
}

fn mysql_fallback_like_patterns(filter: &str) -> Vec<String> {
    let escaped = filter.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let mut patterns = vec![format!("%{escaped}%")];
    if crate::sql::fuzzy_filter_enabled(filter) {
        patterns.push(crate::sql::fuzzy_like_pattern_with_escape(filter, |value| {
            value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
        }));
    }
    patterns
}

pub(super) async fn list_tables_show_with_status(
    pool: &MySqlPool,
    database: &str,
) -> Result<(Vec<TableInfo>, HashMap<String, TableStatusMeta>), String> {
    let (tables, status) = tokio::join!(list_table_names_show(pool, database), list_table_status_show(pool, database));
    let mut tables = tables?;
    let status = match status {
        Ok(status) => status,
        Err(err) => {
            log::warn!("Skipping table status for database `{}`: {}", database, err);
            HashMap::new()
        }
    };
    for table in &mut tables {
        if let Some(meta) = status.get(&table.name) {
            table.comment = meta.comment.clone();
        }
    }
    Ok((tables, status))
}

async fn list_tables_show_filtered(
    pool: &MySqlPool,
    database: &str,
    filter: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    if filter.is_none_or(|filter| filter.trim().is_empty()) {
        return list_tables_show(pool, database).await;
    }

    let status = match list_table_status_show_filtered(pool, database, filter).await {
        Ok(status) => status,
        Err(err) => {
            log::warn!("Skipping filtered table status for database `{}`: {}", database, err);
            HashMap::new()
        }
    };
    let exact_names = status.keys().cloned().collect::<Vec<_>>();
    // DBeaver also uses SHOW FULL TABLES with server-side WHERE/LIKE filtering.
    // Keeping the filter on the SHOW query avoids turning a normal empty search
    // into an unbounded scan while preserving TABLE/VIEW classification.
    let mut tables = list_table_names_show_filtered(pool, database, filter, &exact_names).await?;
    for table in &mut tables {
        if let Some(meta) = status.get(&table.name) {
            table.comment = meta.comment.clone();
        }
    }
    Ok(tables)
}

pub async fn list_tables_show(pool: &MySqlPool, database: &str) -> Result<Vec<TableInfo>, String> {
    list_tables_show_with_status(pool, database).await.map(|(tables, _)| tables)
}

fn requested_object_type(object_types: Option<&[String]>, object_type: &str) -> bool {
    object_types.is_none_or(|types| {
        types.is_empty() || types.iter().any(|candidate| candidate.eq_ignore_ascii_case(object_type))
    })
}

fn wants_table_objects(object_types: Option<&[String]>) -> bool {
    requested_object_type(object_types, "TABLE") || requested_object_type(object_types, "VIEW")
}

fn wants_routine_objects(object_types: Option<&[String]>) -> bool {
    requested_object_type(object_types, "PROCEDURE") || requested_object_type(object_types, "FUNCTION")
}

fn wants_trigger_objects(object_types: Option<&[String]>) -> bool {
    requested_object_type(object_types, "TRIGGER")
}

fn wants_event_objects(object_types: Option<&[String]>) -> bool {
    requested_object_type(object_types, "EVENT")
}

fn sql_pagination(limit: Option<usize>, offset: Option<usize>) -> String {
    limit.map_or_else(String::new, |limit| format!(" LIMIT {limit} OFFSET {}", offset.unwrap_or(0)))
}

fn list_tables_objects_sql(
    database: &str,
    object_types: Option<&[String]>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> String {
    let wants_tables = requested_object_type(object_types, "TABLE");
    let wants_views = requested_object_type(object_types, "VIEW");
    let type_filter = match (wants_tables, wants_views) {
        (true, false) => " AND TABLE_TYPE NOT IN ('VIEW', 'SYSTEM VIEW')",
        (false, true) => " AND TABLE_TYPE IN ('VIEW', 'SYSTEM VIEW')",
        _ => "",
    };
    format!(
        "SELECT TABLE_NAME AS object_name, \
           CASE WHEN TABLE_TYPE IN ('VIEW', 'SYSTEM VIEW') THEN 'VIEW' ELSE 'TABLE' END AS object_type, \
           TABLE_COMMENT AS object_comment, \
           CREATE_TIME AS created_at, \
           UPDATE_TIME AS updated_at, \
           NULL AS parent_schema, NULL AS parent_name, \
           CASE WHEN TABLE_TYPE IN ('VIEW', 'SYSTEM VIEW') THEN 1 ELSE 0 END AS sort_order \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = {db}{type_filter} \
         ORDER BY sort_order, object_name{pagination}",
        db = quote_value(database),
        pagination = sql_pagination(limit, offset),
    )
}

fn list_routines_sql(
    database: &str,
    object_types: Option<&[String]>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> String {
    list_routines_sql_for_query(database, object_types, limit, offset, RoutineMetadataQuery::Timestamps)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RoutineMetadataQuery {
    Timestamps,
    Legacy,
}

fn routine_metadata_queries() -> [RoutineMetadataQuery; 2] {
    [RoutineMetadataQuery::Timestamps, RoutineMetadataQuery::Legacy]
}

fn list_routines_sql_for_query(
    database: &str,
    object_types: Option<&[String]>,
    limit: Option<usize>,
    offset: Option<usize>,
    query: RoutineMetadataQuery,
) -> String {
    let routine_types = [
        ("PROCEDURE", requested_object_type(object_types, "PROCEDURE")),
        ("FUNCTION", requested_object_type(object_types, "FUNCTION")),
    ]
    .into_iter()
    .filter_map(|(routine_type, requested)| requested.then_some(format!("'{}'", routine_type)))
    .collect::<Vec<_>>()
    .join(", ");
    let timestamps = match query {
        RoutineMetadataQuery::Timestamps => "CREATED AS created_at, LAST_ALTERED AS updated_at",
        RoutineMetadataQuery::Legacy => "NULL AS created_at, NULL AS updated_at",
    };
    format!(
        "SELECT ROUTINE_NAME AS object_name, ROUTINE_TYPE AS object_type, NULL AS object_comment, \
           {timestamps}, \
           NULL AS parent_schema, NULL AS parent_name, \
           CASE WHEN ROUTINE_TYPE = 'PROCEDURE' THEN 2 ELSE 3 END AS sort_order \
         FROM information_schema.ROUTINES \
         WHERE ROUTINE_SCHEMA = {db} AND ROUTINE_TYPE IN ({routine_types}) \
         ORDER BY sort_order, object_name{pagination}",
        db = quote_value(database),
        pagination = sql_pagination(limit, offset),
    )
}

async fn query_routine_rows(
    conn: &mut mysql_async::Conn,
    database: &str,
    object_types: Option<&[String]>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<mysql_async::Row>, String> {
    let mut last_error = None;
    for query in routine_metadata_queries() {
        let sql = match query {
            RoutineMetadataQuery::Timestamps => list_routines_sql(database, object_types, limit, offset),
            RoutineMetadataQuery::Legacy => {
                list_routines_sql_for_query(database, object_types, limit, offset, RoutineMetadataQuery::Legacy)
            }
        };
        let result = match conn.query_iter(&sql).await {
            Ok(result) => result.collect_and_drop::<mysql_async::Row>().await,
            Err(error) => Err(error),
        };
        match result {
            Ok(rows) => return Ok(rows),
            Err(error) => {
                if query == RoutineMetadataQuery::Timestamps {
                    log::debug!(
                        "Routine timestamps are unavailable for database `{database}`; retrying legacy metadata: {error}"
                    );
                }
                last_error = Some(error.to_string());
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "Routine metadata returned no result".to_string()))
}

fn list_completion_triggers_sql(database: &str) -> String {
    format!(
        "SELECT TRIGGER_NAME AS object_name, 'TRIGGER' AS object_type, NULL AS object_comment, \
           CREATED AS created_at, NULL AS updated_at, \
           TRIGGER_SCHEMA AS parent_schema, EVENT_OBJECT_TABLE AS parent_name, \
           4 AS sort_order \
         FROM information_schema.TRIGGERS \
         WHERE TRIGGER_SCHEMA = {db} \
         ORDER BY object_name",
        db = quote_value(database),
    )
}

fn row_to_object(row: &mysql_async::Row, database: &str) -> ObjectInfo {
    ObjectInfo {
        name: get_str_by_name(row, "object_name"),
        object_type: get_str_by_name(row, "object_type"),
        schema: Some(database.to_string()),
        valid: None,
        signature: None,
        custom_type_kind: None,
        has_members: None,
        comment: get_opt_str(row, "object_comment")
            .map(|s| fix_potential_double_encoding(&s))
            .filter(|s| !s.is_empty()),
        created_at: get_opt_str(row, "created_at"),
        updated_at: get_opt_str(row, "updated_at"),
        parent_schema: get_opt_str(row, "parent_schema"),
        parent_name: get_opt_str(row, "parent_name"),
        trigger: None,
        xugu_type_members_expandable: None,
    }
}

fn list_triggers_objects_sql(database: &str) -> String {
    format!(
        "SELECT TRIGGER_NAME AS object_name, 'TRIGGER' AS object_type, NULL AS object_comment, \
           CREATED AS created_at, NULL AS updated_at, \
           TRIGGER_SCHEMA AS parent_schema, EVENT_OBJECT_TABLE AS parent_name, \
           5 AS sort_order \
         FROM information_schema.TRIGGERS \
         WHERE TRIGGER_SCHEMA = {} \
         ORDER BY object_name",
        quote_value(database)
    )
}

fn list_events_objects_sql(database: &str) -> String {
    format!(
        "SELECT EVENT_NAME AS object_name, 'EVENT' AS object_type, NULL AS object_comment, \
           CREATED AS created_at, LAST_ALTERED AS updated_at, \
           EVENT_SCHEMA AS parent_schema, NULL AS parent_name, \
           6 AS sort_order \
         FROM information_schema.EVENTS \
         WHERE EVENT_SCHEMA = {} \
         ORDER BY object_name",
        quote_value(database)
    )
}

pub struct PagedObjectList {
    pub objects: Vec<ObjectInfo>,
    pub paging_applied: bool,
}

fn object_query_supports_paging(object_types: Option<&[String]>) -> bool {
    let Some(object_types) = object_types.filter(|types| !types.is_empty()) else {
        return false;
    };
    let uses_table_source = object_types
        .iter()
        .any(|object_type| object_type.eq_ignore_ascii_case("TABLE") || object_type.eq_ignore_ascii_case("VIEW"));
    let uses_routine_source = object_types.iter().any(|object_type| {
        object_type.eq_ignore_ascii_case("PROCEDURE") || object_type.eq_ignore_ascii_case("FUNCTION")
    });
    let all_types_supported = object_types.iter().all(|object_type| {
        object_type.eq_ignore_ascii_case("TABLE")
            || object_type.eq_ignore_ascii_case("VIEW")
            || object_type.eq_ignore_ascii_case("PROCEDURE")
            || object_type.eq_ignore_ascii_case("FUNCTION")
    });
    all_types_supported && uses_table_source != uses_routine_source
}

fn logical_table_supplemental_types(object_types: Option<&[String]>) -> Vec<String> {
    ["PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"]
        .into_iter()
        .filter(|object_type| requested_object_type(object_types, object_type))
        .map(str::to_string)
        .collect()
}

pub async fn list_objects(
    pool: &MySqlPool,
    database: &str,
    object_types: Option<&[String]>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<PagedObjectList, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let wants_tables = wants_table_objects(object_types);
    let wants_routines = wants_routine_objects(object_types);
    let paging_applied = limit.is_some() && object_query_supports_paging(object_types);
    let (query_limit, query_offset) = if paging_applied { (limit, offset) } else { (None, None) };
    let mut objects = Vec::new();

    if wants_tables {
        let tables_sql = list_tables_objects_sql(database, object_types, query_limit, query_offset);
        let table_rows = match conn.query_iter(&tables_sql).await {
            Ok(result) => match result.collect_and_drop::<mysql_async::Row>().await {
                Ok(rows) if !rows.is_empty() => Some(rows),
                Ok(_) => {
                    log::debug!(
                        "Falling back to SHOW TABLES for object browser database `{database}` after information_schema.TABLES returned no named tables"
                    );
                    None
                }
                Err(err) => {
                    log::debug!(
                        "Falling back to SHOW TABLES for object browser database `{database}` after information_schema.TABLES rows failed: {err}"
                    );
                    None
                }
            },
            Err(err) => {
                log::debug!(
                    "Falling back to SHOW TABLES for object browser database `{database}` after information_schema.TABLES failed: {err}"
                );
                None
            }
        };
        if let Some(table_rows) = table_rows {
            objects.extend(table_rows.iter().map(|row| row_to_object(row, database)));
        } else {
            drop(conn);
            objects.extend(
                list_table_objects_show_filtered(pool, database, object_types, query_limit, query_offset).await?,
            );
            if !wants_routines {
                return Ok(PagedObjectList { objects, paging_applied });
            }
            conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
        }
    }

    // Routines are queried separately: some MySQL-compatible servers (sharding proxies,
    // OceanBase/TiDB variants, restricted accounts) reject information_schema.ROUTINES with
    // ER_UNKNOWN_ERROR (1105). Degrading gracefully keeps tables/views usable.
    if wants_routines {
        match query_routine_rows(&mut conn, database, object_types, query_limit, query_offset).await {
            Ok(routine_rows) => {
                objects.extend(routine_rows.iter().map(|row| row_to_object(row, database)));
            }
            Err(e) => {
                log::warn!("Skipping routines for database `{}` in object browser: {}", database, e);
            }
        }
    }

    if wants_trigger_objects(object_types) {
        let triggers_sql = list_triggers_objects_sql(database);
        match conn.query_iter(&triggers_sql).await {
            Ok(result) => match result.collect_and_drop::<mysql_async::Row>().await {
                Ok(trigger_rows) => {
                    objects.extend(trigger_rows.iter().map(|row| row_to_object(row, database)));
                }
                Err(e) => {
                    log::warn!("Skipping triggers for database `{}` in object browser: {}", database, e);
                }
            },
            Err(e) => {
                log::warn!("Skipping triggers for database `{}` in object browser: {}", database, e);
            }
        }
    }

    if wants_event_objects(object_types) {
        let events_sql = list_events_objects_sql(database);
        match conn.query_iter(&events_sql).await {
            Ok(result) => match result.collect_and_drop::<mysql_async::Row>().await {
                Ok(event_rows) => {
                    objects.extend(event_rows.iter().map(|row| row_to_object(row, database)));
                }
                Err(e) => {
                    log::warn!("Skipping events for database `{}` in object browser: {}", database, e);
                }
            },
            Err(e) => {
                log::warn!("Skipping events for database `{}` in object browser: {}", database, e);
            }
        }
    }

    Ok(PagedObjectList { objects, paging_applied })
}

pub async fn list_objects_with_logical_tables(
    pool: &MySqlPool,
    database: &str,
    object_types: Option<&[String]>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<PagedObjectList, String> {
    if !wants_table_objects(object_types) {
        return list_objects(pool, database, object_types, limit, offset).await;
    }

    let paging_applied = limit.is_some() && object_query_supports_paging(object_types);
    let (query_limit, query_offset) = if paging_applied { (limit, offset) } else { (None, None) };
    let mut objects =
        list_logical_table_objects_show_filtered(pool, database, object_types, query_limit, query_offset).await?;
    let supplemental_types = logical_table_supplemental_types(object_types);
    if !supplemental_types.is_empty() {
        objects.extend(list_objects(pool, database, Some(&supplemental_types), None, None).await?.objects);
    }

    Ok(PagedObjectList { objects, paging_applied })
}

pub async fn list_object_statistics(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectStatistics>, String> {
    let sql = format!(
        "SELECT TABLE_NAME, TABLE_ROWS, COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS TOTAL_BYTES \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = {} AND TABLE_TYPE <> 'VIEW' \
         ORDER BY TABLE_NAME",
        quote_value(database),
    );
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = get_str_by_name(row, "TABLE_NAME").trim().to_string();
            (!name.is_empty()).then_some(ObjectStatistics {
                name,
                schema: Some(database.to_string()),
                estimated_rows: get_opt_i64(row, "TABLE_ROWS"),
                total_bytes: get_opt_i64(row, "TOTAL_BYTES"),
            })
        })
        .collect())
}

pub async fn list_table_objects_show(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectInfo>, String> {
    let (tables, routines) =
        tokio::join!(list_tables_show_with_status(pool, database), list_routine_objects(pool, database));
    let (tables, status) = tables?;
    let mut objects = table_infos_to_objects(tables, &status, database);

    match routines {
        Ok(routines) => objects.extend(routines),
        Err(err) => log::warn!("Skipping routines for database `{}` in object browser: {}", database, err),
    }

    Ok(objects)
}

async fn list_table_objects_show_filtered(
    pool: &MySqlPool,
    database: &str,
    object_types: Option<&[String]>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<ObjectInfo>, String> {
    let (tables, status) = list_tables_show_with_status(pool, database).await?;
    Ok(filter_table_objects_fallback(table_infos_to_objects(tables, &status, database), object_types, limit, offset))
}

fn filter_table_objects_fallback(
    objects: Vec<ObjectInfo>,
    object_types: Option<&[String]>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Vec<ObjectInfo> {
    let wants_table = requested_object_type(object_types, "TABLE");
    let wants_view = requested_object_type(object_types, "VIEW");
    objects
        .into_iter()
        .filter(|object| if object.object_type.eq_ignore_ascii_case("VIEW") { wants_view } else { wants_table })
        .skip(offset.unwrap_or(0))
        .take(limit.unwrap_or(usize::MAX))
        .collect()
}

pub(super) fn table_infos_to_objects(
    tables: Vec<TableInfo>,
    status: &HashMap<String, TableStatusMeta>,
    database: &str,
) -> Vec<ObjectInfo> {
    tables
        .into_iter()
        .map(|table| {
            let meta = status.get(&table.name);
            ObjectInfo {
                name: table.name,
                object_type: if table.table_type.eq_ignore_ascii_case("MATERIALIZED_VIEW") {
                    "MATERIALIZED_VIEW"
                } else if table.table_type.eq_ignore_ascii_case("VIEW") {
                    "VIEW"
                } else {
                    "TABLE"
                }
                .to_string(),
                schema: Some(database.to_string()),
                valid: None,
                signature: None,
                custom_type_kind: None,
                has_members: None,
                comment: table.comment,
                created_at: meta.and_then(|meta| meta.created_at.clone()),
                updated_at: meta.and_then(|meta| meta.updated_at.clone()),
                parent_schema: table.parent_schema,
                parent_name: table.parent_name,
                trigger: None,
                xugu_type_members_expandable: None,
            }
        })
        .collect()
}

pub(super) async fn list_routine_objects(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let rows = query_routine_rows(&mut conn, database, None, None, None).await?;
    Ok(rows.iter().map(|row| row_to_object(row, database)).collect())
}

pub async fn list_completion_objects(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let mut objects = Vec::new();

    match query_routine_rows(&mut conn, database, None, None, None).await {
        Ok(rows) => objects.extend(rows.iter().map(|row| row_to_object(row, database))),
        Err(e) => log::warn!("Skipping routines for completion in database `{}`: {}", database, e),
    }

    let triggers_sql = list_completion_triggers_sql(database);
    match conn.query_iter(&triggers_sql).await {
        Ok(result) => match result.collect_and_drop::<mysql_async::Row>().await {
            Ok(rows) => objects.extend(rows.iter().map(|row| row_to_object(row, database))),
            Err(e) => log::warn!("Skipping triggers for completion in database `{}`: {}", database, e),
        },
        Err(e) => log::warn!("Skipping triggers for completion in database `{}`: {}", database, e),
    }

    Ok(objects)
}

fn columns_sql(database: &str, table: &str) -> String {
    // Query only information_schema.COLUMNS and fetch TABLE_COLLATION separately via
    // `table_collation_sql`. A LEFT JOIN onto information_schema.TABLES triggers a
    // catastrophic plan on MySQL 5.7 (observed ~8s vs ~1ms without the join), because 5.7's
    // TABLES metadata is materialized per-query with poor predicate pushdown. The separate
    // lookup matches the `get_columns_show` fallback path and keeps results identical.
    format!(
        "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, \
         COLUMN_COMMENT, COLUMN_KEY, NUMERIC_PRECISION, NUMERIC_SCALE, CHARACTER_MAXIMUM_LENGTH, \
         CHARACTER_SET_NAME, COLLATION_NAME \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} \
         ORDER BY ORDINAL_POSITION",
        quote_value(database),
        quote_value(table),
    )
}

fn generation_expressions_sql(database: &str, table: &str) -> String {
    format!(
        "SELECT COLUMN_NAME, GENERATION_EXPRESSION \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} \
         AND GENERATION_EXPRESSION IS NOT NULL AND GENERATION_EXPRESSION <> '' \
         ORDER BY ORDINAL_POSITION",
        quote_value(database),
        quote_value(table),
    )
}

fn mysql_generated_column_storage(extra: &str) -> Option<&'static str> {
    let normalized = extra.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    if normalized.contains("virtual generated") {
        Some("VIRTUAL")
    } else if normalized.contains("stored generated") {
        Some("STORED")
    } else if normalized.contains("persistent generated") {
        Some("PERSISTENT")
    } else {
        None
    }
}

fn mysql_generated_column_extra(extra: &str, expression: &str) -> Option<String> {
    let storage = mysql_generated_column_storage(extra)?;
    let expression = expression.trim();
    if expression.is_empty() {
        return None;
    }
    Some(format!("GENERATED ALWAYS AS ({expression}) {storage}"))
}

async fn enrich_mysql_generated_column_expressions(
    conn: &mut mysql_async::Conn,
    database: &str,
    table: &str,
    columns: &mut [ColumnInfo],
) {
    if database.trim().is_empty()
        || !columns
            .iter()
            .any(|column| column.extra.as_deref().is_some_and(|extra| mysql_generated_column_storage(extra).is_some()))
    {
        return;
    }

    let sql = generation_expressions_sql(database, table);
    let rows = match conn.query_iter(&sql).await {
        Ok(result) => match result.collect_and_drop::<mysql_async::Row>().await {
            Ok(rows) => rows,
            Err(error) => {
                log::debug!("Failed to collect MySQL generated-column expressions with `{sql}`: {error}");
                return;
            }
        },
        Err(error) => {
            log::debug!("Failed to read MySQL generated-column expressions with `{sql}`: {error}");
            return;
        }
    };
    let expressions = rows
        .iter()
        .filter_map(|row| {
            let name = get_str_by_name(row, "COLUMN_NAME");
            let expression = get_str_by_name(row, "GENERATION_EXPRESSION");
            (!name.is_empty() && !expression.trim().is_empty()).then_some((name, expression))
        })
        .collect::<HashMap<_, _>>();

    apply_mysql_generated_column_expressions(columns, &expressions);
}

fn apply_mysql_generated_column_expressions(columns: &mut [ColumnInfo], expressions: &HashMap<String, String>) {
    for column in columns {
        let Some(expression) = expressions.get(&column.name) else {
            continue;
        };
        let Some(extra) = column.extra.as_deref() else {
            continue;
        };
        if let Some(generated_extra) = mysql_generated_column_extra(extra, expression) {
            column.extra = Some(generated_extra);
        }
    }
}

fn table_collation_sql(database: &str, table: &str) -> String {
    format!(
        "SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} LIMIT 1",
        quote_value(database),
        quote_value(table),
    )
}

fn normalize_mysql_column_charset_metadata(columns: &mut [ColumnInfo], table_collation: Option<&str>) {
    let Some(table_collation) = table_collation.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    for column in columns {
        if column.collation.as_deref().is_some_and(|value| value.eq_ignore_ascii_case(table_collation)) {
            // MySQL reports effective values and does not preserve whether an
            // equivalent table-default collation was explicitly written.
            column.character_set = None;
            column.collation = None;
        }
    }
}

/// Attempt to reverse CP1252→UTF-8 double-encoding.
///
/// When Chinese text is written to MySQL through a connection with the wrong
/// charset (e.g. latin1/CP1252), each byte of the correct UTF-8 representation
/// is stored as a separate CP1252 character, then re-encoded as UTF-8 on read.
///
/// Example: "主键" → UTF-8 bytes [E4 B8 BB E9 94 AE]
///   → each byte → CP1252 char → UTF-8 re-encoded → garbled text
///   → reversal: map each char back to its CP1252 byte, decode as UTF-8
pub(crate) fn fix_potential_double_encoding(s: &str) -> String {
    // Map each character to its CP1252 byte value
    let mut bytes = Vec::with_capacity(s.len());
    for c in s.chars() {
        let byte = match c as u32 {
            // Characters in CP1252 that differ from Latin-1 (0x80-0x9F range)
            0x20AC => 0x80, // €
            0x201A => 0x82, // ‚
            0x0192 => 0x83, // ƒ
            0x201E => 0x84, // „
            0x2026 => 0x85, // …
            0x2020 => 0x86, // †
            0x2021 => 0x87, // ‡
            0x02C6 => 0x88, // ˆ
            0x2030 => 0x89, // ‰
            0x0160 => 0x8A, // Š
            0x2039 => 0x8B, // ‹
            0x0152 => 0x8C, // Œ
            0x017D => 0x8E, // Ž
            0x2018 => 0x91, // '
            0x2019 => 0x92, // '
            0x201C => 0x93, // " left double quotation mark
            0x201D => 0x94, // " right double quotation mark
            0x2022 => 0x95, // •
            0x2013 => 0x96, // –
            0x2014 => 0x97, // —
            0x02DC => 0x98, // ˜
            0x2122 => 0x99, // ™
            0x0161 => 0x9A, // š
            0x203A => 0x9B, // ›
            0x0153 => 0x9C, // œ
            0x017E => 0x9E, // ž
            0x0178 => 0x9F, // Ÿ
            v if v <= 0xFF => v as u8,
            _ => return s.to_string(), // contains non-Latin1 char, skip
        };
        bytes.push(byte);
    }

    // Try decoding the bytes as UTF-8
    match String::from_utf8(bytes) {
        Ok(decoded) => {
            // Only use the decoded version if it actually contains
            // multi-byte UTF-8 characters (CJK, etc. > U+00FF),
            // confirming the reversal was successful
            if decoded.chars().any(|c| c > '\u{00FF}') {
                decoded
            } else {
                s.to_string()
            }
        }
        Err(_) => s.to_string(),
    }
}

fn parse_mysql_enum_values(column_type: &str) -> Option<Vec<String>> {
    let trimmed = column_type.trim();
    if !trimmed.get(..5)?.eq_ignore_ascii_case("enum(") || !trimmed.ends_with(')') {
        return None;
    }

    let inner = &trimmed[5..trimmed.len() - 1];
    let mut chars = inner.chars().peekable();
    let mut values = Vec::new();

    loop {
        while matches!(chars.peek(), Some(c) if c.is_whitespace()) {
            chars.next();
        }
        match chars.next() {
            Some('\'') => {}
            None if values.is_empty() => return Some(values),
            _ => return None,
        }

        let mut value = String::new();
        loop {
            match chars.next() {
                Some('\'') => {
                    if matches!(chars.peek(), Some('\'')) {
                        chars.next();
                        value.push('\'');
                    } else {
                        break;
                    }
                }
                Some('\\') => match chars.next() {
                    Some('0') => value.push('\0'),
                    Some('b') => value.push('\u{0008}'),
                    Some('n') => value.push('\n'),
                    Some('r') => value.push('\r'),
                    Some('t') => value.push('\t'),
                    Some('Z') => value.push('\u{001A}'),
                    Some(c @ ('\\' | '\'' | '"')) => value.push(c),
                    Some(c) => value.push(c),
                    None => return None,
                },
                Some(c) => value.push(c),
                None => return None,
            }
        }
        values.push(value);

        while matches!(chars.peek(), Some(c) if c.is_whitespace()) {
            chars.next();
        }
        match chars.next() {
            Some(',') => continue,
            None => return Some(values),
            _ => return None,
        }
    }
}

pub async fn get_columns<P>(pool: &P, database: &str, table: &str) -> Result<Vec<ColumnInfo>, String>
where
    P: MySqlPoolAccess + ?Sized,
{
    let sql = columns_sql(database, table);
    let mut conn = get_conn_with_health_check(pool).await?;
    let result = match conn.query_iter(&sql).await {
        Ok(result) => result,
        Err(err) => {
            log::debug!(
                "Falling back to SHOW COLUMNS for `{database}`.`{table}` after information_schema.COLUMNS failed: {err}"
            );
            return get_columns_show(pool, database, table).await;
        }
    };
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    // When database is empty the COLUMNS query returns no rows, so the
    // function falls through to get_columns_show and this code path is
    // never reached.  Skip the collation lookup to avoid a pointless query.
    let table_collation = if database.trim().is_empty() {
        None
    } else {
        query_first_nonblank_string(&mut conn, &table_collation_sql(database, table)).await
    };
    let mut columns: Vec<ColumnInfo> = rows
        .iter()
        .filter_map(|row| {
            let name = get_str_by_name(row, "COLUMN_NAME").trim().to_string();
            if name.is_empty() {
                return None;
            }
            let column_key = get_str_by_name(row, "COLUMN_KEY");
            let data_type = get_str_by_name(row, "DATA_TYPE");
            let column_type = get_str_by_name(row, "COLUMN_TYPE");
            let enum_values = if data_type.eq_ignore_ascii_case("enum") {
                // MySQL exposes enum literals only through COLUMN_TYPE. Parse the SQL literal
                // syntax in Rust so empty values, quotes, and backslash escapes survive intact.
                parse_mysql_enum_values(&column_type)
            } else {
                None
            };
            Some(ColumnInfo {
                is_primary_key: column_key.eq_ignore_ascii_case("PRI"),
                is_unique: column_key.eq_ignore_ascii_case("UNI"),
                name,
                data_type: column_type,
                resolved_schema: None,
                is_nullable: get_str_by_name(row, "IS_NULLABLE") == "YES",
                column_default: get_opt_str(row, "COLUMN_DEFAULT"),
                extra: get_opt_str(row, "EXTRA"),
                comment: get_opt_str(row, "COLUMN_COMMENT")
                    .map(|s| fix_potential_double_encoding(&s))
                    .filter(|s| !s.is_empty()),
                numeric_precision: get_opt_i32(row, "NUMERIC_PRECISION"),
                numeric_scale: get_opt_i32(row, "NUMERIC_SCALE"),
                character_maximum_length: get_opt_i32(row, "CHARACTER_MAXIMUM_LENGTH"),
                enum_values,
                character_set: get_opt_str(row, "CHARACTER_SET_NAME").filter(|s| !s.is_empty()),
                collation: get_opt_str(row, "COLLATION_NAME").filter(|s| !s.is_empty()),
            })
        })
        .collect();

    if columns.is_empty() {
        log::debug!(
            "Falling back to SHOW COLUMNS for `{database}`.`{table}` after information_schema.COLUMNS returned no named columns"
        );
        return get_columns_show(pool, database, table).await;
    }

    enrich_mysql_generated_column_expressions(&mut conn, database, table, &mut columns).await;
    normalize_mysql_column_charset_metadata(&mut columns, table_collation.as_deref());
    Ok(columns)
}

pub async fn get_columns_show<P>(pool: &P, database: &str, table: &str) -> Result<Vec<ColumnInfo>, String>
where
    P: MySqlPoolAccess + ?Sized,
{
    let sql = show_columns_sql(database, table, true);
    let mut conn = get_conn_with_health_check(pool).await?;
    let rows: Vec<mysql_async::Row> = match conn.query_iter(&sql).await {
        Ok(result) => result.collect_and_drop().await.map_err(|e| e.to_string())?,
        Err(_) => {
            let sql = show_columns_sql(database, table, false);
            let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
            result.collect_and_drop().await.map_err(|e| e.to_string())?
        }
    };
    let table_collation = if database.trim().is_empty() {
        None
    } else {
        query_first_nonblank_string(&mut conn, &table_collation_sql(database, table)).await
    };
    let mut columns: Vec<ColumnInfo> = rows
        .iter()
        .filter_map(|row| {
            let name = get_str_by_name(row, "Field").trim().to_string();
            if name.is_empty() {
                return None;
            }
            let key = get_str_by_name(row, "Key");
            let collation = get_opt_str(row, "Collation").filter(|s| !s.is_empty());
            Some(ColumnInfo {
                name,
                data_type: get_str_by_name(row, "Type"),
                resolved_schema: None,
                is_nullable: get_str_by_name(row, "Null").eq_ignore_ascii_case("YES"),
                column_default: get_opt_str(row, "Default"),
                is_primary_key: key.eq_ignore_ascii_case("PRI"),
                is_unique: key.eq_ignore_ascii_case("UNI"),
                extra: get_opt_str(row, "Extra"),
                comment: get_opt_str(row, "Comment")
                    .map(|s| fix_potential_double_encoding(&s))
                    .filter(|s| !s.is_empty()),
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
                enum_values: None,
                character_set: collation
                    .as_deref()
                    .and_then(|c| c.split_once('_').map(|(charset, _)| charset.to_string()))
                    .filter(|s| !s.is_empty()),
                collation,
            })
        })
        .collect();
    enrich_mysql_generated_column_expressions(&mut conn, database, table, &mut columns).await;
    normalize_mysql_column_charset_metadata(&mut columns, table_collation.as_deref());
    Ok(columns)
}

fn show_columns_sql(database: &str, table: &str, full: bool) -> String {
    let prefix = if full { "SHOW FULL COLUMNS FROM" } else { "SHOW COLUMNS FROM" };
    if database.trim().is_empty() {
        format!("{prefix} {}", quote_identifier(table))
    } else {
        format!("{prefix} {}.{}", quote_identifier(database), quote_identifier(table))
    }
}

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(crate::query::MAX_ROWS).max(1)
}

fn should_collect_text_result_set(sql: &str, row_limit: usize, max_rows: Option<usize>) -> bool {
    max_rows.is_some_and(|_| mysql_top_level_limit(sql).is_some_and(|limit| limit <= row_limit))
}

fn mysql_top_level_limit(sql: &str) -> Option<usize> {
    let sql = sql.trim().trim_end_matches(';');
    let bytes = sql.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;

    while i < bytes.len() {
        i = skip_sql_whitespace_and_comments(bytes, i);
        if i >= bytes.len() {
            break;
        }

        let ch = bytes[i];
        if matches!(ch, b'\'' | b'"' | b'`') {
            i = skip_mysql_quoted(sql, i, ch);
            continue;
        }
        if ch == b'(' {
            depth += 1;
            i += 1;
            continue;
        }
        if ch == b')' {
            depth = depth.saturating_sub(1);
            i += 1;
            continue;
        }
        if depth == 0 && mysql_keyword_at(sql, i, "LIMIT") {
            return parse_mysql_limit_value(sql, i + "LIMIT".len());
        }
        // Move to next byte, but ensure we stay on a UTF-8 boundary
        i += 1;
        while i < bytes.len() && !sql.is_char_boundary(i) {
            i += 1;
        }
    }

    None
}

fn parse_mysql_limit_value(sql: &str, start: usize) -> Option<usize> {
    let bytes = sql.as_bytes();
    let mut i = skip_sql_whitespace_and_comments(bytes, start);
    let first = parse_usize_token(sql, &mut i)?;
    i = skip_sql_whitespace_and_comments(bytes, i);

    if i < bytes.len() && bytes[i] == b',' {
        i = skip_sql_whitespace_and_comments(bytes, i + 1);
        return parse_usize_token(sql, &mut i);
    }

    Some(first)
}

fn parse_usize_token(sql: &str, i: &mut usize) -> Option<usize> {
    let bytes = sql.as_bytes();
    let start = *i;
    while *i < bytes.len() && bytes[*i].is_ascii_digit() {
        *i += 1;
    }
    if *i == start {
        return None;
    }
    // Ensure the slice is valid UTF-8 before parsing
    std::str::from_utf8(&bytes[start..*i]).ok()?.parse().ok()
}

pub(super) fn mysql_keyword_at(sql: &str, i: usize, keyword: &str) -> bool {
    let end = i + keyword.len();
    if end > sql.len() {
        return false;
    }
    // Ensure indices are on UTF-8 boundaries before slicing
    if !sql.is_char_boundary(i) || !sql.is_char_boundary(end) {
        return false;
    }
    sql[i..end].eq_ignore_ascii_case(keyword)
        && (i == 0 || !is_mysql_identifier_byte(sql.as_bytes()[i - 1]))
        && (end == sql.len() || !is_mysql_identifier_byte(sql.as_bytes()[end]))
}

pub(super) fn is_mysql_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$')
}

pub(super) fn skip_mysql_quoted(sql: &str, start: usize, quote: u8) -> usize {
    let bytes = sql.as_bytes();
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == quote {
            if i + 1 < bytes.len() && bytes[i + 1] == quote {
                i += 2;
                continue;
            }
            return i + 1;
        }
        if quote == b'\'' && bytes[i] == b'\\' {
            i = (i + 2).min(bytes.len());
            continue;
        }
        i += 1;
    }
    bytes.len()
}

/// Get a connection from the pool with a health check. If the connection is dead
/// (e.g. after app was backgrounded), it tries again with a fresh connection.
pub async fn get_conn_with_health_check<P>(pool: &P) -> Result<mysql_async::Conn, String>
where
    P: MySqlPoolAccess + ?Sized,
{
    get_conn_with_health_check_with_timeout(pool, super::connection_timeout()).await
}

pub async fn get_conn_with_health_check_with_timeout<P>(
    pool: &P,
    timeout: Duration,
) -> Result<mysql_async::Conn, String>
where
    P: MySqlPoolAccess + ?Sized,
{
    get_conn_with_health_check_with_cancel(pool, timeout, timeout, None).await
}

pub async fn get_conn_with_health_check_with_cancel<P>(
    pool: &P,
    timeout: Duration,
    cleanup_timeout: Duration,
    cancel_token: Option<&CancellationToken>,
) -> Result<mysql_async::Conn, String>
where
    P: MySqlPoolAccess + ?Sized,
{
    let start = Instant::now();
    let mut conn = get_conn_with_timeout_and_cancel(pool, timeout, cancel_token).await?;
    match ping_conn_with_timeout_and_cancel(&mut conn, timeout, cancel_token).await {
        Ok(()) => {
            log::debug!(
                "[db:health.check:done] elapsed_ms={} timeout_ms={}",
                start.elapsed().as_millis(),
                timeout.as_millis()
            );
            Ok(conn)
        }
        Err(err) if err == crate::query::QUERY_CANCELED => {
            let _ = tokio::time::timeout(cleanup_timeout, conn.disconnect()).await;
            Err(err)
        }
        Err(err) => {
            log::warn!(
                "[db:health.check:error] elapsed_ms={} timeout_ms={} error={}; retrying",
                start.elapsed().as_millis(),
                timeout.as_millis(),
                err
            );
            let _ = tokio::time::timeout(cleanup_timeout, conn.disconnect()).await;
            let mut conn = get_conn_with_timeout_and_cancel(pool, timeout, cancel_token).await?;
            if let Err(err) = ping_conn_with_timeout_and_cancel(&mut conn, timeout, cancel_token).await {
                if err == crate::query::QUERY_CANCELED {
                    let _ = tokio::time::timeout(cleanup_timeout, conn.disconnect()).await;
                }
                return Err(err);
            }
            log::info!(
                "[db:health.check:recovered] elapsed_ms={} timeout_ms={}",
                start.elapsed().as_millis(),
                timeout.as_millis()
            );
            Ok(conn)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MysqlCheckoutSnapshot {
    pub(crate) connection_count: usize,
    pub(crate) connections_in_pool: usize,
    pub(crate) max_connections: usize,
}

pub(crate) type MysqlCheckoutStage = super::PoolCheckoutStage;

pub(crate) fn classify_mysql_checkout_stage(snapshot: MysqlCheckoutSnapshot) -> MysqlCheckoutStage {
    if snapshot.connections_in_pool > 0 {
        MysqlCheckoutStage::Recycle
    } else if snapshot.connection_count < snapshot.max_connections {
        MysqlCheckoutStage::Create
    } else {
        MysqlCheckoutStage::Wait
    }
}

fn mysql_checkout_snapshot<P>(pool: &P, max_connections: usize) -> MysqlCheckoutSnapshot
where
    P: MySqlPoolAccess + ?Sized,
{
    let metrics = pool.driver_pool().metrics();
    use std::sync::atomic::Ordering;
    MysqlCheckoutSnapshot {
        connection_count: metrics.connection_count.load(Ordering::Relaxed),
        connections_in_pool: metrics.connections_in_pool.load(Ordering::Relaxed),
        max_connections,
    }
}

pub(crate) async fn checkout_mysql_conn<P>(
    pool: &P,
    timeout: Duration,
) -> Result<mysql_async::Conn, super::PoolCheckoutError>
where
    P: MySqlPoolAccess + ?Sized,
{
    // Capture the phase before entering the driver future. The phase is tied
    // to this checkout's capacity decision, not to a later aggregate metric
    // snapshot that may already include another request.
    let stage = pool.checkout_max_connections().map_or(MysqlCheckoutStage::Unknown, |max_connections| {
        classify_mysql_checkout_stage(mysql_checkout_snapshot(pool, max_connections))
    });
    match tokio::time::timeout(timeout, pool.driver_pool().get_conn()).await {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(error)) => Err(super::PoolCheckoutError::Failed { database: "MySQL", stage, detail: error.to_string() }),
        Err(_) => Err(super::PoolCheckoutError::Timeout { database: "MySQL", stage, timeout }),
    }
}

async fn get_conn_with_timeout_and_cancel<P>(
    pool: &P,
    timeout: Duration,
    cancel_token: Option<&CancellationToken>,
) -> Result<mysql_async::Conn, String>
where
    P: MySqlPoolAccess + ?Sized,
{
    let get_future = async { checkout_mysql_conn(pool, timeout).await.map_err(|error| error.to_string()) };

    match cancel_token {
        Some(token) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => Err(crate::query::canceled_error()),
                result = get_future => result,
            }
        }
        None => get_future.await,
    }
}

pub async fn get_conn_with_timeout<P>(pool: &P, timeout: Duration) -> Result<mysql_async::Conn, String>
where
    P: MySqlPoolAccess + ?Sized,
{
    checkout_mysql_conn(pool, timeout).await.map_err(|error| error.to_string())
}

#[cfg(test)]
async fn connection_result_with_timeout<T, F>(timeout: Duration, future: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    tokio::time::timeout(timeout, future).await.map_err(|_| "MySQL get connection timed out".to_string())?
}

async fn ping_conn_with_timeout_and_cancel(
    conn: &mut mysql_async::Conn,
    timeout: Duration,
    cancel_token: Option<&CancellationToken>,
) -> Result<(), String> {
    let ping_future = async {
        tokio::time::timeout(timeout, conn.ping())
            .await
            .map_err(|_| "MySQL ping timed out".to_string())?
            .map_err(|e| e.to_string())
    };

    match cancel_token {
        Some(token) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => Err(crate::query::canceled_error()),
                result = ping_future => result,
            }
        }
        None => ping_future.await,
    }
}

/// Maps `SHOW WARNINGS` rows (`Level`, `Code`, `Message`) to query messages.
fn mysql_warning_rows_to_messages(rows: Vec<(String, u16, String)>) -> Vec<QueryMessage> {
    rows.into_iter()
        .map(|(level, code, message)| QueryMessage {
            severity: level,
            code: Some(code.to_string()),
            message,
            detail: None,
            hint: None,
        })
        .collect()
}

/// Maps a non-empty OK-packet info string (e.g. `Records: 3 Duplicates: 0
/// Warnings: 1`) to an INFO query message.
fn mysql_info_message(info: &str) -> Option<QueryMessage> {
    let info = info.trim();
    if info.is_empty() {
        return None;
    }
    Some(QueryMessage { severity: "INFO".to_string(), code: None, message: info.to_string(), detail: None, hint: None })
}

fn mysql_warnings_fallback_message(warnings: u16) -> QueryMessage {
    QueryMessage {
        severity: "Warning".to_string(),
        code: None,
        message: format!("{warnings} warning(s)"),
        detail: None,
        hint: None,
    }
}

/// Builds the message list from an OK-packet info string plus the outcome of a
/// `SHOW WARNINGS` query: `None` when the query failed (MySQL-compatible
/// proxies such as Doris/StarRocks may not support it), `Some(rows)` with its
/// rows otherwise. An empty successful result still falls back to the
/// count-only message so a nonzero warning count is never silently dropped.
fn mysql_server_messages_from_warnings(
    info: &str,
    warnings: u16,
    warning_rows: Option<Vec<(String, u16, String)>>,
) -> Vec<QueryMessage> {
    let mut messages: Vec<QueryMessage> = mysql_info_message(info).into_iter().collect();
    if warnings == 0 {
        return messages;
    }
    match warning_rows {
        Some(rows) if !rows.is_empty() => messages.extend(mysql_warning_rows_to_messages(rows)),
        _ => messages.push(mysql_warnings_fallback_message(warnings)),
    }
    messages
}

/// Best-effort collection of server messages for a finished statement: the
/// OK-packet info string plus `SHOW WARNINGS` output when the server reported
/// warnings. `SHOW WARNINGS` runs on the same connection; all errors are
/// swallowed (MySQL-compatible proxies such as Doris/StarRocks may not support
/// it) and fall back to a count-only message.
async fn collect_mysql_server_messages(conn: &mut mysql_async::Conn, warnings: u16, info: &str) -> Vec<QueryMessage> {
    let warning_rows = if warnings == 0 {
        None
    } else {
        match conn.query_iter("SHOW WARNINGS").await {
            Ok(result) => match result.try_collect_and_drop::<(String, u16, String)>().await {
                Ok(rows) => rows.into_iter().collect::<Result<Vec<_>, _>>().ok(),
                Err(_) => None,
            },
            Err(_) => None,
        }
    };
    mysql_server_messages_from_warnings(info, warnings, warning_rows)
}

async fn execute_result_set_with_text_protocol_on_conn(
    conn: &mut mysql_async::Conn,
    sql: &str,
    row_limit: usize,
    max_rows: Option<usize>,
    max_result_bytes: Option<usize>,
    result_key_columns: &[String],
    diagnostic_trace_id: Option<&str>,
    start: Instant,
) -> Result<MySqlQueryResult, String> {
    let diagnostics_enabled = diagnostic_trace_id.is_some() && log::log_enabled!(log::Level::Info);
    let dispatch_started_at = diagnostics_enabled.then(Instant::now);
    let mut result = conn.query_iter(sql).await.map_err(|e| e.to_string())?;
    let dispatch_ms = dispatch_started_at.map_or(0, |started_at| started_at.elapsed().as_millis());
    if !advance_to_result_set_with_columns(&mut result).await? {
        let affected_rows = result.affected_rows();
        let warnings = result.warnings();
        let info = result.info().into_owned();
        drop(result);
        let messages = collect_mysql_server_messages(conn, warnings, &info).await;
        return Ok(MySqlQueryResult::exact(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![],
            affected_rows,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages,
        }));
    }
    let columns: Vec<String> = result.columns_ref().iter().map(|c| c.name_str().to_string()).collect();
    let column_types: Vec<String> = result.columns_ref().iter().map(mysql_column_type_name).collect();
    let mut spatial_columns = mysql_spatial_column_builder(result.columns_ref());
    let preview_bytes =
        max_result_bytes.map(|max_bytes| mysql_result_cell_preview_bytes(max_bytes, row_limit, result.columns_ref()));
    let protected_indexes = mysql_result_protected_column_indexes(result.columns_ref(), result_key_columns);

    if max_result_bytes.is_none() && should_collect_text_result_set(sql, row_limit, max_rows) {
        let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
        // collect_and_drop consumed the result; warnings/info now reflect the
        // trailing EOF/OK packet of the finished result set.
        let warnings = conn.get_warnings();
        let info = conn.info().into_owned();
        let messages = collect_mysql_server_messages(conn, warnings, &info).await;
        let truncated = rows.len() > row_limit;
        let mut spatial_values = Vec::new();
        let result_rows = rows
            .iter()
            .take(row_limit)
            .map(|row| {
                let (values, srids) = mysql_row_to_json_with_srids(row, &mut spatial_columns);
                spatial_values.push(srids);
                values
            })
            .collect();

        return Ok(MySqlQueryResult::exact(QueryResult {
            columns,
            column_types,
            column_sortables: vec![],
            spatial_columns: spatial_columns.finish(),
            spatial_values,
            rows: result_rows,
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages,
        }));
    }

    let mut result_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut spatial_values: Vec<Vec<Option<u32>>> = Vec::new();
    let mut large_value_cells = Vec::new();
    let mut truncated = false;
    let mut row_read_time = Duration::ZERO;
    let mut row_convert_time = Duration::ZERO;
    let mut stream = result
        .stream::<mysql_async::Row>()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Empty result set stream".to_string())?;

    loop {
        let read_started_at = diagnostics_enabled.then(Instant::now);
        let next_row = stream.next().await;
        if let Some(started_at) = read_started_at {
            row_read_time += started_at.elapsed();
        }
        let Some(row) = next_row else { break };
        let row = row.map_err(|e| e.to_string())?;
        if result_rows.len() >= row_limit {
            truncated = true;
            break;
        }
        let row_index = result_rows.len();
        let convert_started_at = diagnostics_enabled.then(Instant::now);
        let (values, srids, mut row_large_values) = mysql_row_to_json_with_srids_and_previews(
            &row,
            &mut spatial_columns,
            row_index,
            preview_bytes,
            &protected_indexes,
        );
        result_rows.push(values);
        spatial_values.push(srids);
        large_value_cells.append(&mut row_large_values);
        if let Some(started_at) = convert_started_at {
            row_convert_time += started_at.elapsed();
        }
    }
    drop(stream);

    // A truncated stream broke out of the row loop before this result set's
    // terminator packet arrived, so `result.warnings()`/`result.info()` still
    // hold the previous statement's values; skip capture instead of reporting
    // stale messages.
    let finalize_started_at = diagnostics_enabled.then(Instant::now);
    let messages = if truncated {
        drop(result);
        Vec::new()
    } else {
        let warnings = result.warnings();
        let info = result.info().into_owned();
        drop(result);
        collect_mysql_server_messages(conn, warnings, &info).await
    };
    if diagnostics_enabled {
        log::info!(
            "[query][mysql-result] trace_id={} protocol=text dispatch_ms={} row_read_ms={} row_convert_ms={} finalize_ms={} rows={} columns={} truncated={} preview_cells={}",
            diagnostic_trace_id.unwrap_or("none"),
            dispatch_ms,
            row_read_time.as_millis(),
            row_convert_time.as_millis(),
            finalize_started_at.map_or(0, |started_at| started_at.elapsed().as_millis()),
            result_rows.len(),
            columns.len(),
            truncated,
            large_value_cells.len()
        );
    }

    Ok(MySqlQueryResult {
        result: QueryResult {
            columns,
            column_types,
            column_sortables: vec![],
            spatial_columns: spatial_columns.finish(),
            spatial_values,
            rows: result_rows,
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages,
        },
        large_value_cells,
    })
}

async fn execute_result_sets_with_text_protocol_on_conn(
    conn: &mut mysql_async::Conn,
    sql: &str,
    row_limit: usize,
    max_rows: Option<usize>,
    max_result_bytes: Option<usize>,
    result_key_columns: &[String],
    diagnostic_trace_id: Option<&str>,
    start: Instant,
) -> Result<Vec<MySqlQueryResult>, String> {
    // Per-set warnings/info read after each `collect()` are only accurate when
    // the connection negotiated CLIENT_DEPRECATE_EOF: with legacy EOF packets
    // the next result set's column-definition EOF clobbers the previous OK
    // state, and a following column-less statement's OK packet would be
    // misattributed to the wrong set. mysql_async does not expose the
    // negotiated capability publicly, so gate on the client-side
    // `deprecate_eof` option requested when the pool was built (DBX disables
    // it automatically when a proxy only speaks legacy EOF). When disabled,
    // per-set messages stay empty and only the final SHOW WARNINGS attachment
    // on the last result set reports warnings.
    let capture_per_set_messages = conn.opts().deprecate_eof();
    let diagnostics_enabled = diagnostic_trace_id.is_some() && log::log_enabled!(log::Level::Info);
    let dispatch_started_at = diagnostics_enabled.then(Instant::now);
    let mut result = conn.query_iter(sql).await.map_err(|e| e.to_string())?;
    let dispatch_ms = dispatch_started_at.map_or(0, |started_at| started_at.elapsed().as_millis());
    let mut results: Vec<MySqlQueryResult> = Vec::new();
    let mut result_set_warnings: Vec<u16> = Vec::new();
    let mut row_read_time = Duration::ZERO;
    let mut row_convert_time = Duration::ZERO;

    while advance_to_result_set_with_columns(&mut result).await? {
        let columns: Vec<String> = result.columns_ref().iter().map(|c| c.name_str().to_string()).collect();
        let column_types: Vec<String> = result.columns_ref().iter().map(mysql_column_type_name).collect();
        let mut spatial_columns = mysql_spatial_column_builder(result.columns_ref());
        let mut spatial_values = Vec::new();
        let mut large_value_cells = Vec::new();
        let mut truncated = false;
        let preview_bytes = max_result_bytes
            .map(|max_bytes| mysql_result_cell_preview_bytes(max_bytes, row_limit, result.columns_ref()));
        let protected_indexes = mysql_result_protected_column_indexes(result.columns_ref(), result_key_columns);

        let rows = if max_result_bytes.is_none() && should_collect_text_result_set(sql, row_limit, max_rows) {
            let read_started_at = diagnostics_enabled.then(Instant::now);
            let rows: Vec<mysql_async::Row> = result.collect().await.map_err(|e| e.to_string())?;
            if let Some(started_at) = read_started_at {
                row_read_time += started_at.elapsed();
            }
            truncated = rows.len() > row_limit;
            let convert_started_at = diagnostics_enabled.then(Instant::now);
            let converted_rows = rows
                .iter()
                .take(row_limit)
                .map(|row| {
                    let (values, srids) = mysql_row_to_json_with_srids(row, &mut spatial_columns);
                    spatial_values.push(srids);
                    values
                })
                .collect::<Vec<_>>();
            if let Some(started_at) = convert_started_at {
                row_convert_time += started_at.elapsed();
            }
            converted_rows
        } else {
            let mut rows = Vec::new();
            let mut stream = result
                .stream::<mysql_async::Row>()
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Empty result set stream".to_string())?;

            loop {
                let read_started_at = diagnostics_enabled.then(Instant::now);
                let next_row = stream.next().await;
                if let Some(started_at) = read_started_at {
                    row_read_time += started_at.elapsed();
                }
                let Some(row) = next_row else { break };
                let row = row.map_err(|e| e.to_string())?;
                if rows.len() < row_limit {
                    let row_index = rows.len();
                    let convert_started_at = diagnostics_enabled.then(Instant::now);
                    let (values, srids, mut row_large_values) = mysql_row_to_json_with_srids_and_previews(
                        &row,
                        &mut spatial_columns,
                        row_index,
                        preview_bytes,
                        &protected_indexes,
                    );
                    rows.push(values);
                    spatial_values.push(srids);
                    large_value_cells.append(&mut row_large_values);
                    if let Some(started_at) = convert_started_at {
                        row_convert_time += started_at.elapsed();
                    }
                } else {
                    truncated = true;
                }
            }
            rows
        };

        let warnings = if capture_per_set_messages { result.warnings() } else { 0 };
        let messages: Vec<QueryMessage> = if capture_per_set_messages {
            mysql_info_message(&result.info()).into_iter().collect()
        } else {
            Vec::new()
        };
        result_set_warnings.push(warnings);
        results.push(MySqlQueryResult {
            result: QueryResult {
                columns,
                column_types,
                column_sortables: vec![],
                spatial_columns: spatial_columns.finish(),
                spatial_values,
                rows,
                affected_rows: 0,
                execution_time_ms: start.elapsed().as_millis(),
                truncated,
                session_id: None,
                has_more: false,
                elasticsearch_raw_body: None,
                messages,
            },
            large_value_cells,
        });
    }

    if results.is_empty() {
        let finalize_started_at = diagnostics_enabled.then(Instant::now);
        let affected_rows = result.affected_rows();
        let warnings = result.warnings();
        let info = result.info().into_owned();
        drop(result);
        let messages = collect_mysql_server_messages(conn, warnings, &info).await;
        results.push(MySqlQueryResult::exact(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![],
            affected_rows,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages,
        }));
        if diagnostics_enabled {
            log::info!(
                "[query][mysql-result] trace_id={} protocol=text-multi dispatch_ms={} row_read_ms={} row_convert_ms={} finalize_ms={} result_count=1 row_counts=[0] column_counts=[0] truncated_sets=0 preview_cells=0",
                diagnostic_trace_id.unwrap_or("none"),
                dispatch_ms,
                row_read_time.as_millis(),
                row_convert_time.as_millis(),
                finalize_started_at.map_or(0, |started_at| started_at.elapsed().as_millis())
            );
        }
        return Ok(results);
    }
    // Without per-set capture (no CLIENT_DEPRECATE_EOF) the per-iteration
    // counts were skipped above; the connection state after the loop still
    // reflects the last statement's terminator, so use its warnings count for
    // the final SHOW WARNINGS attachment on the last result set.
    if !capture_per_set_messages {
        let last_index = result_set_warnings.len() - 1;
        result_set_warnings[last_index] = result.warnings();
    }
    let finalize_started_at = diagnostics_enabled.then(Instant::now);
    drop(result);

    // SHOW WARNINGS only reports the last executed statement, so detailed
    // warning rows can only be attached to the last result set; earlier sets
    // with warnings get a count-only fallback message.
    let last_index = results.len() - 1;
    for (index, warnings) in result_set_warnings.iter().copied().enumerate() {
        if warnings == 0 {
            continue;
        }
        if index == last_index {
            let mut messages = collect_mysql_server_messages(conn, warnings, "").await;
            results[index].result.messages.append(&mut messages);
        } else {
            results[index].result.messages.push(mysql_warnings_fallback_message(warnings));
        }
    }

    if diagnostics_enabled {
        log::info!(
            "[query][mysql-result] trace_id={} protocol=text-multi dispatch_ms={} row_read_ms={} row_convert_ms={} finalize_ms={} result_count={} row_counts={:?} column_counts={:?} truncated_sets={} preview_cells={}",
            diagnostic_trace_id.unwrap_or("none"),
            dispatch_ms,
            row_read_time.as_millis(),
            row_convert_time.as_millis(),
            finalize_started_at.map_or(0, |started_at| started_at.elapsed().as_millis()),
            results.len(),
            results.iter().map(|result| result.result.rows.len()).collect::<Vec<_>>(),
            results.iter().map(|result| result.result.columns.len()).collect::<Vec<_>>(),
            results.iter().filter(|result| result.result.truncated).count(),
            results.iter().map(|result| result.large_value_cells.len()).sum::<usize>()
        );
    }

    Ok(results)
}

async fn advance_to_result_set_with_columns(
    result: &mut mysql_async::QueryResult<'_, '_, mysql_async::TextProtocol>,
) -> Result<bool, String> {
    while result.columns_ref().is_empty() {
        if result.is_empty() {
            return Ok(false);
        }
        let _: Vec<mysql_async::Row> = result.collect().await.map_err(|e| e.to_string())?;
    }
    Ok(!result.columns_ref().is_empty())
}

async fn execute_result_set_with_prepared_protocol_on_conn(
    conn: &mut mysql_async::Conn,
    sql: &str,
    row_limit: usize,
    max_result_bytes: Option<usize>,
    result_key_columns: &[String],
    diagnostic_trace_id: Option<&str>,
    start: Instant,
) -> Result<MySqlQueryResult, String> {
    let diagnostics_enabled = diagnostic_trace_id.is_some() && log::log_enabled!(log::Level::Info);
    let dispatch_started_at = diagnostics_enabled.then(Instant::now);
    let mut result = conn.exec_iter(sql, ()).await.map_err(|e| e.to_string())?;
    let dispatch_ms = dispatch_started_at.map_or(0, |started_at| started_at.elapsed().as_millis());
    let columns: Vec<String> = result.columns_ref().iter().map(|c| c.name_str().to_string()).collect();
    let column_types: Vec<String> = result.columns_ref().iter().map(mysql_column_type_name).collect();
    let mut spatial_columns = mysql_spatial_column_builder(result.columns_ref());
    let preview_bytes =
        max_result_bytes.map(|max_bytes| mysql_result_cell_preview_bytes(max_bytes, row_limit, result.columns_ref()));
    let protected_indexes = mysql_result_protected_column_indexes(result.columns_ref(), result_key_columns);

    let mut result_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut spatial_values: Vec<Vec<Option<u32>>> = Vec::new();
    let mut large_value_cells = Vec::new();
    let mut truncated = false;
    let mut row_read_time = Duration::ZERO;
    let mut row_convert_time = Duration::ZERO;
    let mut stream = result
        .stream::<mysql_async::Row>()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Empty result set stream".to_string())?;

    loop {
        let read_started_at = diagnostics_enabled.then(Instant::now);
        let next_row = stream.next().await;
        if let Some(started_at) = read_started_at {
            row_read_time += started_at.elapsed();
        }
        let Some(row) = next_row else { break };
        let row = row.map_err(|e| e.to_string())?;
        if result_rows.len() >= row_limit {
            truncated = true;
            break;
        }
        let row_index = result_rows.len();
        let convert_started_at = diagnostics_enabled.then(Instant::now);
        let (values, srids, mut row_large_values) = mysql_row_to_json_with_srids_and_previews(
            &row,
            &mut spatial_columns,
            row_index,
            preview_bytes,
            &protected_indexes,
        );
        result_rows.push(values);
        spatial_values.push(srids);
        large_value_cells.append(&mut row_large_values);
        if let Some(started_at) = convert_started_at {
            row_convert_time += started_at.elapsed();
        }
    }
    drop(stream);

    // A truncated stream broke out of the row loop before this result set's
    // terminator packet arrived, so `result.warnings()`/`result.info()` still
    // hold the previous statement's values; skip capture instead of reporting
    // stale messages.
    let finalize_started_at = diagnostics_enabled.then(Instant::now);
    let messages = if truncated {
        drop(result);
        Vec::new()
    } else {
        let warnings = result.warnings();
        let info = result.info().into_owned();
        drop(result);
        collect_mysql_server_messages(conn, warnings, &info).await
    };
    if diagnostics_enabled {
        log::info!(
            "[query][mysql-result] trace_id={} protocol=prepared dispatch_ms={} row_read_ms={} row_convert_ms={} finalize_ms={} rows={} columns={} truncated={} preview_cells={}",
            diagnostic_trace_id.unwrap_or("none"),
            dispatch_ms,
            row_read_time.as_millis(),
            row_convert_time.as_millis(),
            finalize_started_at.map_or(0, |started_at| started_at.elapsed().as_millis()),
            result_rows.len(),
            columns.len(),
            truncated,
            large_value_cells.len()
        );
    }

    Ok(MySqlQueryResult {
        result: QueryResult {
            columns,
            column_types,
            column_sortables: vec![],
            spatial_columns: spatial_columns.finish(),
            spatial_values,
            rows: result_rows,
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages,
        },
        large_value_cells,
    })
}

pub async fn execute_query(pool: &MySqlPool, sql: &str, bare: bool) -> Result<QueryResult, String> {
    execute_query_with_max_rows(pool, sql, bare, None, MySqlQueryDialect::default()).await
}

pub async fn max_allowed_packet(pool: &MySqlPool) -> Result<u64, String> {
    let mut conn = get_conn_with_health_check(pool).await?;
    max_allowed_packet_on_conn(&mut conn).await
}

pub(crate) async fn max_allowed_packet_on_conn(conn: &mut mysql_async::Conn) -> Result<u64, String> {
    query_first_column::<u64>(conn, "SELECT @@max_allowed_packet")
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "MySQL did not return @@max_allowed_packet".to_string())
}

pub(crate) fn mysql_sql_statement_hard_limit(max_allowed_packet: u64) -> Option<usize> {
    let packet_bytes = usize::try_from(max_allowed_packet).ok()?;
    if packet_bytes == 0 {
        return None;
    }
    let margin = (packet_bytes / 10).clamp(1024, MYSQL_SQL_PACKET_MARGIN_MAX_BYTES).min(packet_bytes / 2);
    packet_bytes.checked_sub(margin).filter(|limit| *limit > 0)
}

pub async fn execute_query_with_max_rows<P>(
    pool: &P,
    sql: &str,
    bare: bool,
    max_rows: Option<usize>,
    dialect: MySqlQueryDialect,
) -> Result<QueryResult, String>
where
    P: MySqlPoolAccess + ?Sized,
{
    let mut conn = get_conn_with_health_check(pool).await?;
    execute_query_on_conn_with_max_rows(&mut conn, sql, bare, max_rows, dialect).await
}

pub async fn stream_query_rows(
    pool: &MySqlPool,
    sql: &str,
    bare: bool,
    max_rows: Option<usize>,
    dialect: MySqlQueryDialect,
    cancelled: &AtomicBool,
    mut on_row: impl FnMut(&[serde_json::Value]) -> Result<(), String>,
) -> Result<u64, String> {
    let mut conn = get_conn_with_health_check(pool).await?;
    stream_query_result_on_conn(&mut conn, sql, bare, max_rows, dialect, cancelled, false, |item| {
        if let MySqlQueryStreamItem::Row(row) = item {
            on_row(&row)?;
        }
        Ok(())
    })
    .await
}

pub async fn stream_query_result_on_conn(
    conn: &mut mysql_async::Conn,
    sql: &str,
    bare: bool,
    max_rows: Option<usize>,
    dialect: MySqlQueryDialect,
    cancelled: &AtomicBool,
    spatial_as_wkb: bool,
    mut on_item: impl FnMut(MySqlQueryStreamItem) -> Result<(), String>,
) -> Result<u64, String> {
    let row_limit = max_rows.unwrap_or(usize::MAX);

    if bare || prefers_text_protocol_query(sql, dialect) {
        stream_query_result_text(conn, sql, row_limit, cancelled, spatial_as_wkb, &mut on_item).await
    } else {
        match stream_query_result_prepared(conn, sql, row_limit, cancelled, spatial_as_wkb, &mut on_item).await {
            Ok(rows) => Ok(rows),
            Err(err) if mysql_error_should_retry_with_text_protocol(&err) => {
                stream_query_result_text(conn, sql, row_limit, cancelled, spatial_as_wkb, &mut on_item).await
            }
            Err(err) => Err(err),
        }
    }
}

async fn stream_query_result_text(
    conn: &mut mysql_async::Conn,
    sql: &str,
    row_limit: usize,
    cancelled: &AtomicBool,
    spatial_as_wkb: bool,
    on_item: &mut impl FnMut(MySqlQueryStreamItem) -> Result<(), String>,
) -> Result<u64, String> {
    let mut result = conn.query_iter(sql).await.map_err(|e| e.to_string())?;
    if !advance_to_result_set_with_columns(&mut result).await? {
        return Ok(0);
    }
    let columns: Vec<String> = result.columns_ref().iter().map(|c| c.name_str().to_string()).collect();
    let column_types: Vec<String> = result.columns_ref().iter().map(mysql_column_type_name).collect();
    on_item(MySqlQueryStreamItem::Columns { columns, column_types })?;

    let mut stream = result
        .stream::<mysql_async::Row>()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Empty result set stream".to_string())?;
    let mut rows_exported = 0_u64;

    while let Some(row) = stream.next().await {
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::query::canceled_error());
        }
        if rows_exported as usize >= row_limit {
            break;
        }
        let row = row.map_err(|e| e.to_string())?;
        let values: Vec<serde_json::Value> = (0..row.len())
            .map(|i| mysql_value_to_json_for_export(&row, i, spatial_as_wkb))
            .collect::<Result<_, _>>()?;
        on_item(MySqlQueryStreamItem::Row(values))?;
        rows_exported += 1;
    }

    Ok(rows_exported)
}

async fn stream_query_result_prepared(
    conn: &mut mysql_async::Conn,
    sql: &str,
    row_limit: usize,
    cancelled: &AtomicBool,
    spatial_as_wkb: bool,
    on_item: &mut impl FnMut(MySqlQueryStreamItem) -> Result<(), String>,
) -> Result<u64, String> {
    let mut result = conn.exec_iter(sql, ()).await.map_err(|e| e.to_string())?;
    let columns: Vec<String> = result.columns_ref().iter().map(|c| c.name_str().to_string()).collect();
    if columns.is_empty() {
        return Ok(0);
    }
    let column_types: Vec<String> = result.columns_ref().iter().map(mysql_column_type_name).collect();
    on_item(MySqlQueryStreamItem::Columns { columns, column_types })?;

    let mut stream = result
        .stream::<mysql_async::Row>()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Empty result set stream".to_string())?;
    let mut rows_exported = 0_u64;

    while let Some(row) = stream.next().await {
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::query::canceled_error());
        }
        if rows_exported as usize >= row_limit {
            break;
        }
        let row = row.map_err(|e| e.to_string())?;
        let values: Vec<serde_json::Value> = (0..row.len())
            .map(|i| mysql_value_to_json_for_export(&row, i, spatial_as_wkb))
            .collect::<Result<_, _>>()?;
        on_item(MySqlQueryStreamItem::Row(values))?;
        rows_exported += 1;
    }

    Ok(rows_exported)
}

pub async fn kill_query(pool: &MySqlPool, connection_id: u32) -> Result<(), String> {
    let start = Instant::now();
    let timeout = super::connection_timeout();
    let mut conn = tokio::time::timeout(timeout, pool.get_conn())
        .await
        .map_err(|_| {
            log::warn!(
                "[db:cancel:error] elapsed_ms={} timeout_ms={} error=MySQL kill connection checkout timed out",
                start.elapsed().as_millis(),
                timeout.as_millis()
            );
            "MySQL kill connection checkout timed out".to_string()
        })?
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(timeout, conn.query_drop(format!("KILL QUERY {connection_id}")))
        .await
        .map_err(|_| {
            log::warn!(
                "[db:cancel:error] elapsed_ms={} timeout_ms={} error=MySQL KILL QUERY timed out",
                start.elapsed().as_millis(),
                timeout.as_millis()
            );
            "MySQL KILL QUERY timed out".to_string()
        })?
        .map_err(|e| e.to_string())?;
    log::info!("[db:cancel:done] elapsed_ms={} timeout_ms={}", start.elapsed().as_millis(), timeout.as_millis());
    Ok(())
}

pub async fn kill_query_with_opts(opts: mysql_async::Opts, connection_id: u32) -> Result<(), String> {
    let start = Instant::now();
    let timeout = super::connection_timeout();
    let mut conn = tokio::time::timeout(timeout, mysql_async::Conn::new(opts))
        .await
        .map_err(|_| {
            log::warn!(
                "[db:cancel:error] elapsed_ms={} timeout_ms={} error=MySQL kill connection timed out",
                start.elapsed().as_millis(),
                timeout.as_millis()
            );
            "MySQL kill connection timed out".to_string()
        })?
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(timeout, conn.query_drop(format!("KILL QUERY {connection_id}")))
        .await
        .map_err(|_| {
            log::warn!(
                "[db:cancel:error] elapsed_ms={} timeout_ms={} error=MySQL KILL QUERY execution timed out",
                start.elapsed().as_millis(),
                timeout.as_millis()
            );
            "MySQL KILL QUERY execution timed out".to_string()
        })?
        .map_err(|e| e.to_string())?;
    log::info!("[db:cancel:done] elapsed_ms={} timeout_ms={}", start.elapsed().as_millis(), timeout.as_millis());
    Ok(())
}

pub async fn execute_query_on_conn_with_max_rows(
    conn: &mut mysql_async::Conn,
    sql: &str,
    bare: bool,
    max_rows: Option<usize>,
    dialect: MySqlQueryDialect,
) -> Result<QueryResult, String> {
    execute_query_on_conn_with_limits(conn, sql, bare, max_rows, None, &[], dialect, None)
        .await
        .map(|result| result.result)
}

pub async fn execute_query_on_conn_with_limits(
    conn: &mut mysql_async::Conn,
    sql: &str,
    bare: bool,
    max_rows: Option<usize>,
    max_result_bytes: Option<usize>,
    result_key_columns: &[String],
    dialect: MySqlQueryDialect,
    diagnostic_trace_id: Option<&str>,
) -> Result<MySqlQueryResult, String> {
    let start = Instant::now();
    let row_limit = query_result_row_limit(max_rows);

    if is_result_set_query(sql, dialect) {
        if bare || prefers_text_protocol_query(sql, dialect) {
            execute_result_set_with_text_protocol_on_conn(
                conn,
                sql,
                row_limit,
                max_rows,
                max_result_bytes,
                result_key_columns,
                diagnostic_trace_id,
                start,
            )
            .await
        } else {
            match execute_result_set_with_prepared_protocol_on_conn(
                conn,
                sql,
                row_limit,
                max_result_bytes,
                result_key_columns,
                diagnostic_trace_id,
                start,
            )
            .await
            {
                Ok(result) => Ok(result),
                Err(err) if mysql_error_should_retry_with_text_protocol(&err) => {
                    execute_result_set_with_text_protocol_on_conn(
                        conn,
                        sql,
                        row_limit,
                        max_rows,
                        max_result_bytes,
                        result_key_columns,
                        diagnostic_trace_id,
                        start,
                    )
                    .await
                }
                Err(err) => Err(err),
            }
        }
    } else {
        let previous_explicit_timestamp_defaults = enable_explicit_timestamp_defaults_for_query(conn, sql).await;
        let result = match conn.query_iter(sql).await {
            Ok(result) => result,
            Err(err) => {
                restore_explicit_timestamp_defaults_for_query(conn, previous_explicit_timestamp_defaults).await;
                return Err(err.to_string());
            }
        };
        let affected_rows = result.affected_rows();
        let warnings = result.warnings();
        let info = result.info().into_owned();
        let drop_result = result.drop_result().await;
        // Collect server messages before restoring the timestamp defaults: the
        // restore issues `SET SESSION explicit_defaults_for_timestamp`, which
        // clears the diagnostics area and would leave SHOW WARNINGS empty.
        let messages = collect_mysql_server_messages(conn, warnings, &info).await;
        restore_explicit_timestamp_defaults_for_query(conn, previous_explicit_timestamp_defaults).await;
        drop_result.map_err(|e| e.to_string())?;

        Ok(MySqlQueryResult::exact(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![],
            affected_rows,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages,
        }))
    }
}

pub async fn execute_query_results_on_conn_with_max_rows(
    conn: &mut mysql_async::Conn,
    sql: &str,
    bare: bool,
    max_rows: Option<usize>,
    dialect: MySqlQueryDialect,
) -> Result<Vec<QueryResult>, String> {
    execute_query_results_on_conn_with_limits(conn, sql, bare, max_rows, None, &[], dialect, None)
        .await
        .map(|results| results.into_iter().map(|result| result.result).collect())
}

pub async fn execute_query_results_on_conn_with_limits(
    conn: &mut mysql_async::Conn,
    sql: &str,
    bare: bool,
    max_rows: Option<usize>,
    max_result_bytes: Option<usize>,
    result_key_columns: &[String],
    dialect: MySqlQueryDialect,
    diagnostic_trace_id: Option<&str>,
) -> Result<Vec<MySqlQueryResult>, String> {
    if is_result_set_query(sql, dialect) && (bare || prefers_text_protocol_query(sql, dialect)) {
        let start = Instant::now();
        execute_result_sets_with_text_protocol_on_conn(
            conn,
            sql,
            query_result_row_limit(max_rows),
            max_rows,
            max_result_bytes,
            result_key_columns,
            diagnostic_trace_id,
            start,
        )
        .await
    } else {
        execute_query_on_conn_with_limits(
            conn,
            sql,
            bare,
            max_rows,
            max_result_bytes,
            result_key_columns,
            dialect,
            diagnostic_trace_id,
        )
        .await
        .map(|result| vec![result])
    }
}

#[derive(Debug)]
pub(crate) struct MySqlNonResultBatchOutcome {
    pub results: Vec<QueryResult>,
    pub error: Option<String>,
}

/// Executes a chunk of statements that are known not to return rows using one
/// COM_QUERY packet. MySQL still executes every statement in order and exposes
/// one OK packet per statement, so affected-row counts and failure positions
/// remain attributable to the original statements without one network round
/// trip per statement.
pub(crate) async fn execute_non_result_batch_on_conn(
    conn: &mut mysql_async::Conn,
    sql: &str,
    expected_results: usize,
    on_result: &mut (dyn FnMut(usize, &QueryResult) + Send),
) -> Result<MySqlNonResultBatchOutcome, String> {
    if expected_results == 0 {
        return Ok(MySqlNonResultBatchOutcome { results: Vec::new(), error: None });
    }

    let start = Instant::now();
    let capture_per_set_messages = conn.opts().deprecate_eof();
    let previous_explicit_timestamp_defaults = enable_explicit_timestamp_defaults_for_query(conn, sql).await;
    let mut result = match conn.query_iter(sql).await {
        Ok(result) => result,
        Err(error) => {
            restore_explicit_timestamp_defaults_for_query(conn, previous_explicit_timestamp_defaults).await;
            return Ok(MySqlNonResultBatchOutcome { results: Vec::new(), error: Some(error.to_string()) });
        }
    };
    let mut results = Vec::with_capacity(expected_results);
    let mut warning_counts = Vec::with_capacity(expected_results);
    let mut error = None;
    let mut previous_elapsed_ms = 0;

    for statement_index in 0..expected_results {
        let Some(columns) = result.columns() else {
            error = Some(match result.collect::<mysql_async::Row>().await {
                Err(next_error) => next_error.to_string(),
                Ok(_) => format!(
                    "MySQL batch returned fewer results than expected (expected {expected_results}, received {statement_index})."
                ),
            });
            break;
        };
        if !columns.is_empty() {
            error = Some(format!(
                "MySQL batch statement {} unexpectedly returned rows; retry the statement separately.",
                statement_index + 1
            ));
            break;
        }

        let warnings = result.warnings();
        let info = result.info().into_owned();
        let messages =
            if capture_per_set_messages { mysql_info_message(&info).into_iter().collect() } else { Vec::new() };
        let elapsed_ms = start.elapsed().as_millis();
        let current_result = QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![],
            affected_rows: result.affected_rows(),
            execution_time_ms: elapsed_ms.saturating_sub(previous_elapsed_ms),
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages,
        };

        // query_iter/next_set only expose this metadata after the server has
        // returned the current statement's OK packet. Report it before collect,
        // because collect also waits for the next statement's result.
        on_result(statement_index, &current_result);
        previous_elapsed_ms = elapsed_ms;
        results.push(current_result);
        warning_counts.push(warnings);

        if let Err(next_error) = result.collect::<mysql_async::Row>().await {
            error = Some(next_error.to_string());
            break;
        }
    }

    if let Err(drop_error) = result.drop_result().await {
        if error.is_none() {
            error = Some(drop_error.to_string());
        }
    }
    if error.is_none() && !results.is_empty() {
        let last_index = results.len() - 1;
        for (index, warnings) in warning_counts.into_iter().enumerate() {
            if warnings == 0 {
                continue;
            }
            if index == last_index {
                results[index].messages.extend(collect_mysql_server_messages(conn, warnings, "").await);
            } else if results[index].messages.is_empty() {
                results[index].messages.push(mysql_warnings_fallback_message(warnings));
            }
        }
    }
    restore_explicit_timestamp_defaults_for_query(conn, previous_explicit_timestamp_defaults).await;

    Ok(MySqlNonResultBatchOutcome { results, error })
}

fn prefers_text_protocol_query(sql: &str, dialect: MySqlQueryDialect) -> bool {
    // User-entered result-set queries are not parameterized in DBX. Text protocol
    // avoids binary result decoding bugs in MySQL-compatible servers and proxies.
    is_result_set_query(sql, dialect) || requires_text_protocol_query(sql, dialect)
}

pub(crate) fn is_result_set_query(sql: &str, dialect: MySqlQueryDialect) -> bool {
    // MySQL 的表维护语句虽然不是 SELECT，但服务器会返回包含表名和执行结果的表格。
    // 如果把它们当成普通写入语句，后续 drop_result 会直接丢弃这些返回行。
    starts_with_executable_sql_keyword_for_database(
        sql,
        &[
            "SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH", "CALL", "CHECKSUM", "ANALYZE", "CHECK", "OPTIMIZE",
            "REPAIR",
        ],
        DatabaseType::Mysql,
    ) || mysql_statement_returns_rows(sql)
        || is_xa_recover_query(sql)
        || dialect.supports_admin_show_results && is_admin_show_query(sql)
}

pub(crate) fn is_batchable_non_result_query(sql: &str, dialect: MySqlQueryDialect) -> bool {
    !is_result_set_query(sql, dialect)
        && starts_with_executable_sql_keyword_for_database(
            sql,
            &["INSERT", "REPLACE", "UPDATE", "DELETE"],
            DatabaseType::Mysql,
        )
}

/// MariaDB 10.5+ returns a result set for INSERT/DELETE/REPLACE ... RETURNING.
/// Route it through the existing query path; MySQL servers that do not support
/// the syntax still return their normal SQL syntax error.
fn mysql_statement_returns_rows(sql: &str) -> bool {
    let Ok(statements) = Parser::parse_sql(&MySqlDialect {}, sql) else {
        return false;
    };
    let [statement] = statements.as_slice() else {
        return false;
    };

    match statement {
        Statement::Insert(insert) => insert.returning.is_some(),
        Statement::Delete(delete) => delete.returning.is_some(),
        _ => false,
    }
}

fn is_xa_recover_query(sql: &str) -> bool {
    let tokens = leading_sql_word_tokens(sql, 2);
    tokens.first().is_some_and(|token| token == "xa") && tokens.get(1).is_some_and(|token| token == "recover")
}

fn requires_text_protocol_query(sql: &str, dialect: MySqlQueryDialect) -> bool {
    if dialect.supports_admin_show_results && is_admin_show_query(sql) {
        return true;
    }

    if !starts_with_executable_sql_keyword_for_database(sql, &["SHOW"], DatabaseType::Mysql) {
        return false;
    }

    let tokens = leading_sql_word_tokens(sql, 3);
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

fn is_admin_show_query(sql: &str) -> bool {
    let tokens = leading_sql_word_tokens(sql, 2);
    tokens.first().is_some_and(|token| token == "admin") && tokens.get(1).is_some_and(|token| token == "show")
}

fn leading_sql_word_tokens(sql: &str, limit: usize) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut i = 0;
    let mut tokens = Vec::new();

    while i < bytes.len() && tokens.len() < limit {
        i = skip_sql_whitespace_and_comments(bytes, i);
        let start = i;
        while i < bytes.len() && (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
            i += 1;
        }
        if i == start {
            break;
        }
        tokens.push(sql[start..i].to_ascii_lowercase());
    }

    tokens
}

fn skip_sql_whitespace_and_comments(bytes: &[u8], mut i: usize) -> usize {
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }

        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if i < bytes.len() && bytes[i] == b'#' {
            i += 1;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }

        return i;
    }
}

fn mysql_list_indexes_sql(database: &str, table: &str, include_expression: bool) -> String {
    let expression_column = if include_expression { "EXPRESSION, " } else { "" };
    format!(
        "SELECT INDEX_NAME, COLUMN_NAME, {expression_column}SEQ_IN_INDEX, NON_UNIQUE, INDEX_TYPE, INDEX_COMMENT \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} \
         ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        quote_value(database),
        quote_value(table),
    )
}

fn mysql_statistics_expression_is_unsupported(error: &mysql_async::Error) -> bool {
    match error {
        mysql_async::Error::Server(server_error) if server_error.code == 1054 => true,
        mysql_async::Error::Server(server_error)
            if server_error.code == 3009 && server_error.state.eq_ignore_ascii_case("HY000") =>
        {
            // PolarDB-X/DRDS wraps the unknown EXPRESSION column in TDDL error
            // 3009. Require the complete diagnostic so unrelated HY000 errors
            // (for example permissions or connectivity failures) are not retried
            // with a different metadata query.
            let message = server_error.message.to_ascii_lowercase();
            message.contains("column") && message.contains("expression") && message.contains("not found")
        }
        _ => false,
    }
}

pub async fn list_indexes(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let expression_sql = mysql_list_indexes_sql(database, table, true);
    let legacy_sql = mysql_list_indexes_sql(database, table, false);
    let (result, include_expression) = match conn.query_iter(&expression_sql).await {
        Ok(result) => (result, true),
        Err(error) if mysql_statistics_expression_is_unsupported(&error) => {
            // MySQL 5.7 and older compatible servers do not expose EXPRESSION; keep the legacy metadata path.
            log::debug!("MySQL index expressions are unavailable, retrying without EXPRESSION: {error}");
            (conn.query_iter(&legacy_sql).await.map_err(|e| e.to_string())?, false)
        }
        Err(error) => return Err(error.to_string()),
    };
    let mut indexes = Vec::new();
    let mut index_positions = HashMap::new();

    result
        .for_each_and_drop(|row| {
            let name = get_str_by_name(&row, "INDEX_NAME");
            let index_position = if let Some(index_position) = index_positions.get(&name) {
                *index_position
            } else {
                let index_position = indexes.len();
                index_positions.insert(name.clone(), index_position);
                indexes.push(IndexInfo {
                    name: name.clone(),
                    columns: Vec::new(),
                    is_unique: get_opt_i32(&row, "NON_UNIQUE").unwrap_or(1) == 0,
                    is_primary: name == "PRIMARY",
                    filter: None,
                    index_type: Some(get_str_by_name(&row, "INDEX_TYPE")),
                    included_columns: None,
                    comment: get_opt_str(&row, "INDEX_COMMENT").filter(|value| !value.is_empty()),
                    key_is_expression: Vec::new(),
                });
                index_position
            };

            let index_part = if include_expression {
                get_opt_str(&row, "EXPRESSION")
                    .filter(|value| !value.trim().is_empty())
                    .map(|expression| format!("({})", expression.trim()))
                    .or_else(|| get_opt_str(&row, "COLUMN_NAME").filter(|value| !value.is_empty()))
            } else {
                get_opt_str(&row, "COLUMN_NAME").filter(|value| !value.is_empty())
            };
            if let Some(index_part) = index_part {
                indexes[index_position].columns.push(index_part);
            }
        })
        .await
        .map_err(|e| e.to_string())?;

    Ok(indexes)
}

pub async fn show_create_table_ddl(pool: &MySqlPool, database: &str, table: &str) -> Result<String, String> {
    let sql = format!("SHOW CREATE TABLE {}", quote_table_ref(database, table));
    let mut conn = get_conn_with_health_check(pool).await?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let row = rows.first().ok_or("DDL not found")?;
    row.get_opt::<String, usize>(1)
        .and_then(|result| result.ok())
        .or_else(|| row.get_opt::<Vec<u8>, usize>(1).and_then(|result| result.ok()).map(bytes_to_string_lossy))
        .ok_or_else(|| "Failed to read DDL".to_string())
}

pub async fn list_foreign_keys(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let column_sql = format!(
        "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, \
         REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
         FROM information_schema.KEY_COLUMN_USAGE \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} \
         AND REFERENCED_TABLE_NAME IS NOT NULL \
         ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
        quote_value(database),
        quote_value(table),
    );
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let column_result = conn.query_iter(&column_sql).await.map_err(|e| e.to_string())?;
    let column_rows: Vec<mysql_async::Row> = column_result.collect_and_drop().await.map_err(|e| e.to_string())?;
    if column_rows.is_empty() {
        return Ok(Vec::new());
    }

    // MySQL 5.7 materializes information_schema tables without normal indexes.
    // Avoid joining two metadata tables because the join can scan the entire catalog.
    let rule_sql = format!(
        "SELECT CONSTRAINT_NAME, UPDATE_RULE, DELETE_RULE \
         FROM information_schema.REFERENTIAL_CONSTRAINTS \
         WHERE CONSTRAINT_SCHEMA = {} AND TABLE_NAME = {}",
        quote_value(database),
        quote_value(table),
    );
    let rule_result = conn.query_iter(&rule_sql).await.map_err(|e| e.to_string())?;
    let rule_rows: Vec<mysql_async::Row> = rule_result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let rules = rule_rows
        .iter()
        .map(|row| {
            (
                get_str_by_name(row, "CONSTRAINT_NAME"),
                (get_str_by_name(row, "UPDATE_RULE"), get_str_by_name(row, "DELETE_RULE")),
            )
        })
        .collect::<HashMap<_, _>>();

    Ok(column_rows
        .iter()
        .map(|row| {
            let name = get_str_by_name(row, "CONSTRAINT_NAME");
            let (on_update, on_delete) = rules.get(&name).cloned().unwrap_or_default();
            ForeignKeyInfo {
                name,
                column: get_str_by_name(row, "COLUMN_NAME"),
                ref_schema: Some(get_str_by_name(row, "REFERENCED_TABLE_SCHEMA")),
                ref_table: get_str_by_name(row, "REFERENCED_TABLE_NAME"),
                ref_column: get_str_by_name(row, "REFERENCED_COLUMN_NAME"),
                on_update: Some(on_update).filter(|value| !value.is_empty()),
                on_delete: Some(on_delete).filter(|value| !value.is_empty()),
            }
        })
        .collect())
}

pub async fn list_triggers(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let sql = format!(
        "SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING, ACTION_STATEMENT \
         FROM information_schema.TRIGGERS \
         WHERE TRIGGER_SCHEMA = {} AND EVENT_OBJECT_TABLE = {} \
         ORDER BY TRIGGER_NAME",
        quote_value(database),
        quote_value(table),
    );
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TriggerInfo {
            name: get_str_by_name(row, "TRIGGER_NAME"),
            event: get_str_by_name(row, "EVENT_MANIPULATION"),
            timing: get_str_by_name(row, "ACTION_TIMING"),
            level: None,
            condition: None,
            language: None,
            enabled: None,
            valid: None,
            comment: None,
            created_at: None,
            statement: Some(get_str_by_name(row, "ACTION_STATEMENT")).filter(|value| !value.is_empty()),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mysql_async::{consts::ColumnType, Column, Value};
    use mysql_common::row::new_row;

    fn mysql_test_row(values: Vec<Value>) -> mysql_async::Row {
        let columns = values
            .iter()
            .enumerate()
            .map(|(index, _)| {
                Column::new(ColumnType::MYSQL_TYPE_VAR_STRING).with_name(format!("column_{index}").as_bytes())
            })
            .collect::<Vec<_>>()
            .into();
        new_row(values, columns)
    }

    fn mysql_test_row_with_columns(values: Vec<Value>, columns: Vec<Column>) -> mysql_async::Row {
        new_row(values, columns.into())
    }

    #[test]
    fn mysql_first_column_value_ignores_extra_result_columns() {
        let row = mysql_async::from_row::<mysql_async::Row>(mysql_test_row(vec![
            Value::Bytes(Vec::new()),
            Value::Bytes(Vec::new()),
        ]));

        assert_eq!(first_column_value::<String>(&row), Some(String::new()));
    }

    #[tokio::test]
    async fn mysql_database_list_timeout_controls_checkout_deadline() {
        let exact = connection_result_with_timeout(Duration::from_millis(100), async {
            tokio::time::sleep(Duration::from_millis(60)).await;
            Ok::<_, String>("connection")
        });
        let adjacent = connection_result_with_timeout(Duration::from_millis(50), async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            Ok::<_, String>("connection")
        });
        let configured_five = connection_result_with_timeout(
            Duration::from_millis(10),
            std::future::pending::<Result<&'static str, String>>(),
        );

        let (exact, adjacent, configured_five) = tokio::join!(exact, adjacent, configured_five);

        assert_eq!(exact, Ok("connection"));
        assert_eq!(adjacent, Ok("connection"));
        assert_eq!(configured_five, Err("MySQL get connection timed out".to_string()));
    }

    #[tokio::test]
    async fn mysql_checkout_fault_injection_classifies_full_pool_as_wait() {
        assert!(tokio::time::timeout(Duration::from_millis(1), std::future::pending::<()>()).await.is_err());
        assert_eq!(
            classify_mysql_checkout_stage(MysqlCheckoutSnapshot {
                connection_count: 1,
                connections_in_pool: 0,
                max_connections: 1,
            }),
            MysqlCheckoutStage::Wait
        );
    }

    #[tokio::test]
    async fn mysql_checkout_fault_injection_classifies_hung_connection_create() {
        assert!(tokio::time::timeout(Duration::from_millis(1), std::future::pending::<()>()).await.is_err());
        assert_eq!(
            classify_mysql_checkout_stage(MysqlCheckoutSnapshot {
                connection_count: 0,
                connections_in_pool: 0,
                max_connections: 2,
            }),
            MysqlCheckoutStage::Create
        );
    }

    #[tokio::test]
    async fn mysql_checkout_fault_injection_preserves_create_stage_when_handshake_hangs() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let pool_options =
            mysql_async::PoolOpts::new().with_constraints(mysql_async::PoolConstraints::new(1, 2).unwrap());
        let options = mysql_async::OptsBuilder::default()
            .ip_or_hostname(address.ip().to_string())
            .tcp_port(address.port())
            .user(Some("fault-injection"))
            .pass(Some("fault-injection"))
            .pool_opts(Some(pool_options));
        let pool = MySqlPool::new(options, 2);

        let error = checkout_mysql_conn(&pool, Duration::from_millis(50)).await.unwrap_err();

        assert!(matches!(error, super::super::PoolCheckoutError::Timeout { stage: MysqlCheckoutStage::Create, .. }));
        server.abort();
        let _ = tokio::time::timeout(Duration::from_secs(1), pool.disconnect()).await;
    }

    #[tokio::test]
    async fn mysql_checkout_raw_driver_pool_timeout_keeps_stage_unknown() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let options = mysql_async::OptsBuilder::default()
            .ip_or_hostname(address.ip().to_string())
            .tcp_port(address.port())
            .user(Some("fault-injection"))
            .pass(Some("fault-injection"));
        let pool = mysql_async::Pool::new(options);

        let error = checkout_mysql_conn(&pool, Duration::from_millis(50)).await.unwrap_err();

        assert!(matches!(error, super::super::PoolCheckoutError::Timeout { stage: MysqlCheckoutStage::Unknown, .. }));
        server.abort();
        let _ = tokio::time::timeout(Duration::from_secs(1), pool.disconnect()).await;
    }

    #[tokio::test]
    #[ignore = "requires DBX_REVIEW_MYSQL_* environment variables"]
    async fn mysql_checkout_fault_injection_preserves_wait_stage_when_real_pool_is_full() {
        let host = std::env::var("DBX_REVIEW_MYSQL_HOST").expect("DBX_REVIEW_MYSQL_HOST is required");
        let port = std::env::var("DBX_REVIEW_MYSQL_PORT").expect("DBX_REVIEW_MYSQL_PORT is required");
        let user = std::env::var("DBX_REVIEW_MYSQL_USER").expect("DBX_REVIEW_MYSQL_USER is required");
        let password = std::env::var("DBX_REVIEW_MYSQL_PASSWORD").expect("DBX_REVIEW_MYSQL_PASSWORD is required");
        let database = std::env::var("DBX_REVIEW_MYSQL_DATABASE").expect("DBX_REVIEW_MYSQL_DATABASE is required");
        let pool_options =
            mysql_async::PoolOpts::new().with_constraints(mysql_async::PoolConstraints::new(1, 1).unwrap());
        let options = mysql_async::OptsBuilder::default()
            .ip_or_hostname(host)
            .tcp_port(port.parse().expect("DBX_REVIEW_MYSQL_PORT must be a valid port"))
            .user(Some(user))
            .pass(Some(password))
            .db_name(Some(database))
            .pool_opts(Some(pool_options));
        let pool = MySqlPool::new(options, 1);
        let held_connection = tokio::time::timeout(Duration::from_secs(10), pool.get_conn())
            .await
            .expect("real MySQL checkout timed out")
            .expect("real MySQL checkout failed");

        let error = checkout_mysql_conn(&pool, Duration::from_millis(50)).await.unwrap_err();

        assert!(matches!(error, super::super::PoolCheckoutError::Timeout { stage: MysqlCheckoutStage::Wait, .. }));
        drop(held_connection);
        let _ = tokio::time::timeout(Duration::from_secs(2), pool.disconnect()).await;
    }

    #[test]
    fn mysql_public_metadata_and_query_helpers_accept_driver_pool_for_compatibility() {
        let pool = mysql_async::Pool::new(mysql_async::OptsBuilder::default());
        let columns = get_columns(&pool, "database", "table");
        let query = execute_query_with_max_rows(&pool, "SELECT 1", false, Some(1), MySqlQueryDialect::default());

        drop((columns, query));
    }

    #[tokio::test]
    async fn mysql_database_list_timeout_preserves_immediate_errors_and_fallback_plan() {
        let error =
            connection_result_with_timeout(Duration::from_secs(10), async { Err::<(), _>("driver error".to_string()) })
                .await;

        assert_eq!(error, Err("driver error".to_string()));
        assert_eq!(DATABASE_LIST_QUERY_PLAN, [(SHOW_DATABASES_SQL, true), (INFORMATION_SCHEMA_DATABASES_SQL, false)]);
    }

    #[test]
    fn mysql_first_column_value_handles_null_and_conversion_failures() {
        let null_row = mysql_test_row(vec![Value::NULL, Value::Bytes(b"ignored".to_vec())]);
        let invalid_number_row = mysql_test_row(vec![Value::Bytes(b"not-a-number".to_vec())]);

        assert_eq!(first_column_value::<String>(&null_row), None);
        assert_eq!(first_column_value::<u64>(&invalid_number_row), None);
    }

    #[test]
    fn mysql_first_column_value_reads_integer_metadata() {
        let enabled_row = mysql_test_row(vec![Value::Int(1), Value::Bytes(b"ignored".to_vec())]);
        let packet_row = mysql_test_row(vec![Value::UInt(67_108_864), Value::Bytes(b"ignored".to_vec())]);

        assert_eq!(first_column_value::<u8>(&enabled_row), Some(1));
        assert_eq!(first_column_value::<u64>(&packet_row), Some(67_108_864));
    }

    #[test]
    fn mysql_info_message_maps_non_empty_info_strings() {
        let message = mysql_info_message("Records: 3  Duplicates: 0  Warnings: 1").unwrap();
        assert_eq!(message.severity, "INFO");
        assert_eq!(message.message, "Records: 3  Duplicates: 0  Warnings: 1");
        assert_eq!(message.code, None);
        assert_eq!(message.detail, None);
        assert_eq!(message.hint, None);

        assert!(mysql_info_message("").is_none());
        assert!(mysql_info_message("   ").is_none());
    }

    #[test]
    fn mysql_warning_rows_to_messages_maps_levels_and_codes() {
        let messages = mysql_warning_rows_to_messages(vec![
            ("Warning".to_string(), 1265, "Data truncated for column 'a' at row 1".to_string()),
            ("Note".to_string(), 1051, "Unknown table 't'".to_string()),
        ]);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].severity, "Warning");
        assert_eq!(messages[0].code.as_deref(), Some("1265"));
        assert_eq!(messages[0].message, "Data truncated for column 'a' at row 1");
        assert_eq!(messages[0].detail, None);
        assert_eq!(messages[0].hint, None);
        assert_eq!(messages[1].severity, "Note");
        assert_eq!(messages[1].code.as_deref(), Some("1051"));

        assert!(mysql_warning_rows_to_messages(Vec::new()).is_empty());
    }

    #[test]
    fn mysql_warnings_fallback_message_reports_count() {
        let message = mysql_warnings_fallback_message(3);
        assert_eq!(message.severity, "Warning");
        assert_eq!(message.message, "3 warning(s)");
        assert_eq!(message.code, None);
    }

    #[test]
    fn mysql_server_messages_from_warnings_maps_info_and_warning_rows() {
        let rows = vec![("Warning".to_string(), 1265, "Data truncated for column 'a' at row 1".to_string())];
        let messages = mysql_server_messages_from_warnings("Records: 1  Duplicates: 0  Warnings: 1", 1, Some(rows));

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].severity, "INFO");
        assert_eq!(messages[1].severity, "Warning");
        assert_eq!(messages[1].code.as_deref(), Some("1265"));
    }

    #[test]
    fn mysql_server_messages_from_warnings_falls_back_when_show_warnings_returns_no_rows() {
        let messages = mysql_server_messages_from_warnings("", 2, Some(Vec::new()));

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].severity, "Warning");
        assert_eq!(messages[0].message, "2 warning(s)");
    }

    #[test]
    fn mysql_server_messages_from_warnings_falls_back_when_show_warnings_fails() {
        let messages = mysql_server_messages_from_warnings("", 2, None);

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].message, "2 warning(s)");
    }

    #[test]
    fn mysql_server_messages_from_warnings_skips_warnings_when_count_is_zero() {
        let messages = mysql_server_messages_from_warnings("Query OK", 0, None);

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].severity, "INFO");
        assert_eq!(messages[0].message, "Query OK");
    }

    #[test]
    fn mysql_sql_statement_limit_reserves_packet_headroom() {
        let packet_bytes = 64 * 1024 * 1024;
        let hard_limit = mysql_sql_statement_hard_limit(packet_bytes).unwrap();

        assert!(hard_limit < packet_bytes as usize);
        assert!(hard_limit >= packet_bytes as usize * 9 / 10);
        assert_eq!(mysql_sql_statement_hard_limit(0), None);
        assert_eq!(mysql_sql_statement_hard_limit(4096), Some(3072));
    }
    use crate::db::connection_timeout;
    use mysql_async::consts::ColumnFlags;
    #[test]
    fn catalog_database_context_uses_database_specific_syntax_before_database() {
        assert_eq!(
            catalog_database_context_queries(Some(MySqlCatalogDialect::Doris), Some("paimon`catalog"), "bi").unwrap(),
            vec!["SWITCH `paimon``catalog`", "USE `bi`"]
        );
        assert_eq!(
            catalog_database_context_queries(Some(MySqlCatalogDialect::StarRocks), Some("paimon`catalog"), "bi")
                .unwrap(),
            vec!["SET CATALOG `paimon``catalog`", "USE `bi`"]
        );
        assert_eq!(
            catalog_database_context_queries(Some(MySqlCatalogDialect::Doris), None, "").unwrap(),
            Vec::<String>::new()
        );
        assert!(catalog_database_context_queries(None, Some("paimon_catalog"), "bi").is_err());
    }

    #[test]
    fn catalog_dialect_supports_native_and_profile_connections() {
        assert_eq!(mysql_catalog_dialect(DatabaseType::Doris, None), Some(MySqlCatalogDialect::Doris));
        assert_eq!(mysql_catalog_dialect(DatabaseType::StarRocks, None), Some(MySqlCatalogDialect::StarRocks));
        assert_eq!(mysql_catalog_dialect(DatabaseType::Mysql, Some("selectdb")), Some(MySqlCatalogDialect::Doris));
        assert_eq!(mysql_catalog_dialect(DatabaseType::Mysql, Some("STARROCKS")), Some(MySqlCatalogDialect::StarRocks));
        assert_eq!(mysql_catalog_dialect(DatabaseType::Mysql, None), None);
    }

    fn mysql_test_object(name: &str, object_type: &str) -> ObjectInfo {
        ObjectInfo {
            name: name.to_string(),
            object_type: object_type.to_string(),
            schema: Some("app".to_string()),
            valid: None,
            signature: None,
            custom_type_kind: None,
            has_members: None,
            comment: None,
            created_at: None,
            updated_at: None,
            parent_schema: None,
            parent_name: None,
            trigger: None,
            xugu_type_members_expandable: None,
        }
    }

    #[test]
    fn mysql_geometry_decoder_retains_srid_prefix() {
        let mut raw = 3857_u32.to_le_bytes().to_vec();
        raw.extend_from_slice(&[
            0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x40,
        ]);
        let decoded = decode_mysql_geometry(&raw).unwrap();
        assert_eq!(decoded.wkt, "POINT(1 2)");
        assert_eq!(decoded.srid, Some(3857));
    }

    #[test]
    fn mysql_geometry_decoder_accepts_unprefixed_wkb() {
        let raw = [
            0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x40,
        ];
        let decoded = decode_mysql_geometry(&raw).unwrap();
        assert_eq!(decoded.wkt, "POINT(1 2)");
        assert_eq!(decoded.srid, None);
        assert_eq!(
            mysql_geometry_to_export_marker(&raw).as_deref(),
            Some("DBX_WKB:0:0101000000000000000000F03F0000000000000040")
        );
    }

    #[test]
    fn mysql_geometry_export_marker_strips_internal_srid_prefix() {
        let mut raw = 4326_u32.to_le_bytes().to_vec();
        raw.extend_from_slice(&[
            0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x40,
        ]);
        assert_eq!(
            mysql_geometry_to_export_marker(&raw).as_deref(),
            Some("DBX_WKB:4326:0101000000000000000000F03F0000000000000040")
        );
    }

    #[test]
    fn mysql_geometry_srid_zero_is_unknown() {
        let mut raw = 0_u32.to_le_bytes().to_vec();
        raw.extend_from_slice(&[
            0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x40,
        ]);
        assert_eq!(decode_mysql_geometry(&raw).unwrap().srid, None);
    }

    #[test]
    fn bytes_to_string_reuses_valid_utf8_and_falls_back_lossy() {
        assert_eq!(super::bytes_to_string_lossy("héllo 世界".as_bytes().to_vec()), "héllo 世界");
        assert_eq!(super::bytes_to_string_lossy(vec![]), "");
        // 非法 UTF-8 序列退化为替换字符，与 from_utf8_lossy 语义一致
        let invalid = vec![0x66, 0x6f, 0xff, 0x6f];
        assert_eq!(super::bytes_to_string_lossy(invalid.clone()), String::from_utf8_lossy(&invalid));
    }

    #[test]
    fn mysql_column_type_names_map_to_friendly_names() {
        use mysql_async::consts::ColumnType::*;
        let utf8 = 45u16;
        let binary = 63u16;
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_TINY, utf8, ColumnFlags::empty(), 4)),
            "tinyint"
        );
        assert_eq!(mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_LONG, utf8, ColumnFlags::empty(), 11)), "int");
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_LONGLONG, utf8, ColumnFlags::empty(), 20)),
            "bigint"
        );
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_NEWDECIMAL, utf8, ColumnFlags::empty(), 10)),
            "decimal"
        );
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_VARCHAR, utf8, ColumnFlags::empty(), 255)),
            "varchar"
        );
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_VAR_STRING, utf8, ColumnFlags::empty(), 255)),
            "varchar"
        );
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_STRING, utf8, ColumnFlags::empty(), 16)),
            "char"
        );
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_STRING, utf8, ColumnFlags::ENUM_FLAG, 16)),
            "enum"
        );
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_STRING, utf8, ColumnFlags::SET_FLAG, 16)),
            "set"
        );
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_DATETIME, utf8, ColumnFlags::empty(), 19)),
            "datetime"
        );
        assert_eq!(mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_JSON, utf8, ColumnFlags::empty(), 0)), "json");
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_BLOB, binary, ColumnFlags::BLOB_FLAG, 65_535)),
            "blob"
        );
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_BLOB, utf8, ColumnFlags::empty(), 65_535)),
            "text"
        );
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_TINY_BLOB, utf8, ColumnFlags::empty(), 255)),
            "tinytext"
        );
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_MEDIUM_BLOB, utf8, ColumnFlags::empty(), 16_777_215)),
            "mediumtext"
        );
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_LONG_BLOB, utf8, ColumnFlags::empty(), 4_294_967_295)),
            "longtext"
        );
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_VAR_STRING, binary, ColumnFlags::BINARY_FLAG, 16)),
            "varbinary"
        );
        assert_eq!(
            mysql_column_type_name(&mysql_test_column(MYSQL_TYPE_STRING, binary, ColumnFlags::BINARY_FLAG, 16)),
            "binary"
        );
    }

    #[test]
    fn mysql_with_queries_are_treated_as_result_sets() {
        let sql = "WITH RECURSIVE org_tree AS (SELECT 1 AS id) SELECT id FROM org_tree";
        assert!(is_result_set_query(sql, MySqlQueryDialect::default()));
    }

    #[test]
    fn mariadb_returning_dml_is_treated_as_a_result_set() {
        let dialect = MySqlQueryDialect::default();

        assert!(is_result_set_query("INSERT INTO users (id) VALUES (1) RETURNING id", dialect));
        assert!(is_result_set_query("DELETE FROM users WHERE id = 1 RETURNING id", dialect));
        assert!(!is_result_set_query("UPDATE users SET name = 'Ada'", dialect));
    }

    #[test]
    fn mysql_multi_statement_pipeline_only_accepts_known_dml() {
        let dialect = MySqlQueryDialect::default();

        assert!(is_batchable_non_result_query("INSERT INTO users(id) VALUES (1)", dialect));
        assert!(is_batchable_non_result_query("UPDATE users SET active = 1", dialect));
        assert!(!is_batchable_non_result_query("SELECT * FROM users", dialect));
        assert!(!is_batchable_non_result_query("ANALYZE TABLE users", dialect));
        assert!(!is_batchable_non_result_query("CREATE TABLE users(id INT)", dialect));
    }

    #[test]
    fn mysql_hash_comments_before_queries_preserve_result_sets_per_issue_3830() {
        let dialect = MySqlQueryDialect::default();

        assert!(is_result_set_query("# 注释\nSELECT NOW()", dialect));
        assert!(prefers_text_protocol_query("# 注释\nSELECT NOW()", dialect));
        assert!(requires_text_protocol_query("# inspect sessions\nSHOW PROCESSLIST", dialect));
        assert!(!is_result_set_query("# update row\nUPDATE users SET name = 'Ada' WHERE id = 1", dialect));
    }

    #[test]
    fn mysql_desc_queries_are_treated_as_result_sets() {
        assert!(is_result_set_query("DESC users", MySqlQueryDialect::default()));
    }

    #[test]
    fn mysql_table_maintenance_queries_are_treated_as_result_sets() {
        let dialect = MySqlQueryDialect::default();

        for sql in [
            "CHECKSUM TABLE `users`;",
            "analyze table users",
            "-- 检查表状态\nCHECK TABLE users",
            "/* 整理表 */ OPTIMIZE TABLE users",
            "repair table users quick",
        ] {
            assert!(is_result_set_query(sql, dialect), "{sql}");
            assert!(prefers_text_protocol_query(sql, dialect), "{sql}");
        }
    }

    #[test]
    fn mysql_call_queries_are_treated_as_text_result_sets() {
        let dialect = MySqlQueryDialect::default();

        assert!(is_result_set_query("CALL proc_test1()", dialect));
        assert!(prefers_text_protocol_query("CALL proc_test1()", dialect));
    }

    #[test]
    fn mysql_xa_recover_queries_are_treated_as_text_result_sets() {
        let dialect = MySqlQueryDialect::default();

        for sql in [
            "XA RECOVER",
            "xa recover convert xid;",
            "  -- inspect prepared transactions\nXa /* command */ ReCoVeR ;",
            "# inspect prepared transactions\n/* before command */ XA\nRECOVER",
        ] {
            assert!(is_result_set_query(sql, dialect), "{sql}");
            assert!(prefers_text_protocol_query(sql, dialect), "{sql}");
        }

        for sql in [
            "XA START 'dbx_xid'",
            "XA BEGIN 'dbx_xid'",
            "XA END 'dbx_xid'",
            "XA PREPARE 'dbx_xid'",
            "XA COMMIT 'dbx_xid'",
            "XA ROLLBACK 'dbx_xid'",
        ] {
            assert!(!is_result_set_query(sql, dialect), "{sql}");
        }
    }

    #[test]
    fn starrocks_admin_show_queries_are_treated_as_result_sets() {
        let sql = "ADMIN SHOW FRONTEND CONFIG LIKE '%default_replication_num%'";
        let dialect = MySqlQueryDialect::for_connection(DatabaseType::StarRocks, None);

        assert!(is_result_set_query(sql, dialect));
        assert!(requires_text_protocol_query(sql, dialect));
    }

    #[test]
    fn doris_admin_show_queries_are_treated_as_result_sets() {
        let sql = "ADMIN SHOW FRONTEND CONFIG LIKE '%default_replication_num%'";
        let dialect = MySqlQueryDialect::for_connection(DatabaseType::Doris, None);

        assert!(is_result_set_query(sql, dialect));
        assert!(requires_text_protocol_query(sql, dialect));
    }

    #[test]
    fn mysql_starrocks_profile_admin_show_queries_are_treated_as_result_sets() {
        let sql = "ADMIN SHOW FRONTEND CONFIG LIKE '%default_replication_num%'";
        let dialect = MySqlQueryDialect::for_connection(DatabaseType::Mysql, Some("starrocks"));

        assert!(is_result_set_query(sql, dialect));
        assert!(requires_text_protocol_query(sql, dialect));
    }

    #[test]
    fn tidb_admin_show_queries_are_treated_as_result_sets() {
        let dialect = MySqlQueryDialect::for_connection(DatabaseType::Mysql, Some("tidb"));

        for sql in [
            "ADMIN SHOW DDL",
            "ADMIN SHOW DDL JOBS 20",
            "-- inspect DDL\nadmin /* TiDB */ show ddl jobs 20",
            "ADMIN SHOW DDL JOB QUERIES 1",
        ] {
            assert!(is_result_set_query(sql, dialect), "{sql}");
            assert!(requires_text_protocol_query(sql, dialect), "{sql}");
        }
    }

    #[test]
    fn tidb_non_show_admin_statements_are_not_treated_as_result_sets() {
        let dialect = MySqlQueryDialect::for_connection(DatabaseType::Mysql, Some("tidb"));

        for sql in [
            "ADMIN SET BDR ROLE PRIMARY",
            "ADMIN CANCEL DDL JOBS 1",
            "ADMIN PAUSE DDL JOBS 1",
            "ADMIN RESUME DDL JOBS 1",
            "ADMIN ALTER DDL JOBS 1 THREAD = 8",
        ] {
            assert!(!is_result_set_query(sql, dialect), "{sql}");
            assert!(!requires_text_protocol_query(sql, dialect), "{sql}");
        }
    }

    #[test]
    fn mysql_admin_show_queries_are_not_treated_as_result_sets() {
        let sql = "ADMIN SHOW FRONTEND CONFIG LIKE '%default_replication_num%'";
        let dialect = MySqlQueryDialect::for_connection(DatabaseType::Mysql, None);

        assert!(!is_result_set_query(sql, dialect));
        assert!(!requires_text_protocol_query(sql, dialect));
    }

    #[test]
    fn unrelated_mysql_profiles_do_not_enable_admin_show_results() {
        let sql = "ADMIN SHOW DDL JOBS 20";

        for profile in ["mariadb", "oceanbase", "tdsql", "polardb", "greatsql", "custom"] {
            let dialect = MySqlQueryDialect::for_connection(DatabaseType::Mysql, Some(profile));

            assert!(!is_result_set_query(sql, dialect), "{profile}");
            assert!(!requires_text_protocol_query(sql, dialect), "{profile}");
        }
    }

    #[test]
    fn admin_show_detection_skips_leading_comments() {
        let sql = "-- inspect FE config\nADMIN /* StarRocks */ SHOW FRONTEND CONFIG";
        let dialect = MySqlQueryDialect::for_connection(DatabaseType::StarRocks, None);

        assert!(is_result_set_query(sql, dialect));
        assert!(requires_text_protocol_query(sql, dialect));
    }

    #[test]
    fn admin_set_queries_are_not_treated_as_result_sets() {
        let dialect = MySqlQueryDialect::for_connection(DatabaseType::StarRocks, None);
        assert!(!is_result_set_query("ADMIN SET FRONTEND CONFIG ('default_replication_num' = '1')", dialect));
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
        let sql = list_tables_objects_sql("app", None, None, None);

        assert!(sql.contains("information_schema.TABLES"));
        assert!(!sql.contains("information_schema.ROUTINES"));
        assert!(!sql.contains("UNION"));
        assert!(sql.contains("CREATE_TIME"));
        assert!(sql.contains("UPDATE_TIME"));
    }

    #[test]
    fn mysql_list_tables_sql_applies_filter_limit_and_offset() {
        let sql = list_tables_sql("app", Some("user_%"), Some(101), Some(200), None, None);

        assert!(sql.contains("FROM information_schema.TABLES"));
        assert!(sql.contains("TABLE_SCHEMA = 'app'"));
        assert!(sql.contains("LOWER(TABLE_NAME) LIKE '%user\\\\_\\\\%%' ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(TABLE_COMMENT) LIKE '%user\\\\_\\\\%%' ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(TABLE_NAME) LIKE '%u%s%e%r%\\\\_%\\\\%%' ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(TABLE_COMMENT) LIKE '%u%s%e%r%\\\\_%\\\\%%' ESCAPE '\\\\'"));
        assert!(sql.contains("ORDER BY TABLE_NAME"));
        assert!(sql.contains("LIMIT 101"));
        assert!(sql.contains("OFFSET 200"));
    }

    #[test]
    fn mysql_list_tables_sql_adds_fuzzy_filter_pattern() {
        let sql = list_tables_sql("app", Some("sysu"), Some(100), None, None, None);

        assert!(sql.contains("LOWER(TABLE_NAME) LIKE '%sysu%' ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(TABLE_COMMENT) LIKE '%sysu%' ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(TABLE_NAME) LIKE '%s%y%s%u%' ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(TABLE_COMMENT) LIKE '%s%y%s%u%' ESCAPE '\\\\'"));
    }

    #[test]
    fn mysql_list_tables_sql_skips_fuzzy_filter_for_single_character() {
        let sql = list_tables_sql("app", Some("u"), Some(100), None, None, None);

        assert!(sql.contains("LOWER(TABLE_NAME) LIKE '%u%' ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(TABLE_COMMENT) LIKE '%u%' ESCAPE '\\\\'"));
        assert_eq!(sql.matches("LOWER(TABLE_NAME) LIKE").count(), 1);
        assert_eq!(sql.matches("LOWER(TABLE_COMMENT) LIKE").count(), 1);
        assert!(!sql.contains(" OR LOWER(TABLE_NAME) LIKE"));
    }

    #[test]
    fn mysql_list_tables_sql_filters_table_type_before_pagination() {
        let tables = vec!["TABLE".to_string()];
        let table_sql = list_tables_sql("app", None, Some(1000), None, Some(&tables), None);
        assert!(table_sql.contains("TABLE_TYPE NOT IN ('VIEW', 'SYSTEM VIEW')"));
        assert!(table_sql.find("TABLE_TYPE NOT IN ('VIEW', 'SYSTEM VIEW')") < table_sql.find("ORDER BY TABLE_NAME"));
        assert!(table_sql.find("ORDER BY TABLE_NAME") < table_sql.find("LIMIT 1000"));

        let views = vec!["VIEW".to_string()];
        let view_sql = list_tables_sql("app", None, Some(1000), None, Some(&views), None);
        assert!(view_sql.contains("TABLE_TYPE IN ('VIEW', 'SYSTEM VIEW')"));
    }

    #[test]
    fn mysql_system_views_are_normalized_as_views() {
        assert_eq!(normalize_mysql_table_type("SYSTEM VIEW"), "VIEW");
        assert_eq!(normalize_mysql_table_type("view"), "VIEW");
        assert_eq!(normalize_mysql_table_type("BASE TABLE"), "BASE TABLE");
        assert_eq!(normalize_mysql_table_type("MATERIALIZED VIEW"), "MATERIALIZED VIEW");
        assert_eq!(normalize_mysql_table_type(""), "TABLE");
    }

    #[test]
    fn logical_show_full_tables_is_one_exact_statement() {
        assert_eq!(logical_show_full_tables_sql("app"), "SHOW FULL TABLES FROM `app`");
        assert_eq!(logical_show_full_tables_sql(""), "SHOW FULL TABLES");
    }

    #[test]
    fn proxy_show_rows_keep_logical_names_and_types_without_comments() {
        let rows = vec![
            mysql_test_row(vec![Value::Bytes(b"normal_table".to_vec()), Value::Bytes(b"BASE TABLE".to_vec())]),
            mysql_test_row(vec![Value::Bytes(b"t_order".to_vec()), Value::Bytes(b"BASE TABLE".to_vec())]),
            mysql_test_row(vec![Value::Bytes(b"active_users".to_vec()), Value::Bytes(b"VIEW".to_vec())]),
        ];

        let tables = table_infos_from_show_rows(&rows);

        assert_eq!(
            tables.iter().map(|table| (table.name.as_str(), table.table_type.as_str())).collect::<Vec<_>>(),
            vec![("active_users", "VIEW"), ("normal_table", "BASE TABLE"), ("t_order", "BASE TABLE")]
        );
        assert!(tables.iter().all(|table| table.comment.is_none()));
    }

    #[test]
    fn mysql_filtered_show_fallback_is_server_bounded() {
        let tables_sql = show_tables_filtered_sql("app", true, Some("missing_%"), &[]);
        let status_sql = show_table_status_sql("app", Some("missing_%"));

        assert!(tables_sql.starts_with("SHOW FULL TABLES FROM `app` WHERE "));
        assert!(tables_sql.contains("`Tables_in_app` LIKE"));
        assert!(tables_sql.contains("missing"));
        assert!(tables_sql.contains("ESCAPE"));
        assert!(status_sql.starts_with("SHOW TABLE STATUS FROM `app` WHERE "));
        assert!(status_sql.contains("Name LIKE"));
        assert!(status_sql.contains("Comment LIKE"));
        assert!(status_sql.contains("missing"));
        assert!(status_sql.contains("ESCAPE"));
        assert!(!tables_sql.eq(&show_tables_filtered_sql("app", true, None, &[])));
    }

    #[test]
    fn mysql_filtered_show_fallback_attempts_bare_show_after_syntax_errors() {
        let attempts = show_tables_query_attempts("app", Some("orders"), &[]);

        assert_eq!(attempts.len(), 4);
        assert!(attempts[0].server_filtered);
        assert!(attempts[0].sql.starts_with("SHOW FULL TABLES FROM `app` WHERE "));
        assert!(attempts[1].server_filtered);
        assert!(attempts[1].sql.starts_with("SHOW TABLES FROM `app` WHERE "));
        assert!(!attempts[2].server_filtered);
        assert_eq!(attempts[2].sql, "SHOW FULL TABLES FROM `app`");
        assert!(!attempts[3].server_filtered);
        assert_eq!(attempts[3].sql, "SHOW TABLES FROM `app`");
    }

    #[test]
    fn mysql_unfiltered_show_avoids_duplicate_attempts() {
        let attempts = show_tables_query_attempts("app", None, &[]);

        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].sql, "SHOW FULL TABLES FROM `app`");
        assert_eq!(attempts[1].sql, "SHOW TABLES FROM `app`");
        assert!(attempts.iter().all(|attempt| !attempt.server_filtered));
    }

    #[test]
    fn mysql_unfiltered_status_fallback_is_filtered_locally_once() {
        let status = HashMap::from([
            (
                "orders".to_string(),
                TableStatusMeta { comment: Some("purchase history".to_string()), ..Default::default() },
            ),
            ("users".to_string(), TableStatusMeta::default()),
        ]);

        let filtered = filter_table_status_fallback(status, Some("purchase"));

        assert_eq!(filtered.keys().map(String::as_str).collect::<Vec<_>>(), vec!["orders"]);
    }

    #[test]
    fn mysql_table_status_auto_increment_is_lossless_and_nullable() {
        let auto_increment_column = Column::new(ColumnType::MYSQL_TYPE_LONGLONG).with_name(b"Auto_increment");
        let maximum = mysql_test_row_with_columns(vec![Value::UInt(u64::MAX)], vec![auto_increment_column.clone()]);
        let null = mysql_test_row_with_columns(vec![Value::NULL], vec![auto_increment_column]);

        assert_eq!(
            get_opt_unsigned_metadata_string(&maximum, "Auto_increment").as_deref(),
            Some("18446744073709551615")
        );
        assert_eq!(get_opt_unsigned_metadata_string(&null, "Auto_increment"), None);
    }

    #[test]
    fn mysql_exact_table_status_sql_quotes_identifiers_and_names() {
        assert_eq!(
            show_table_status_exact_sql("sales`archive", "order's"),
            "SHOW TABLE STATUS FROM `sales``archive` WHERE Name = 'order\\'s'"
        );
    }

    #[test]
    fn mysql_table_status_refresh_directive_is_version_gated() {
        assert!(MYSQL_FRESH_TABLE_STATUS_SESSION_SQL.starts_with("/*!80000 "));
        assert!(MYSQL_FRESH_TABLE_STATUS_SESSION_SQL.contains("information_schema_stats_expiry = 0"));
    }

    #[test]
    fn mysql_list_tables_sql_applies_table_name_filter_before_pagination() {
        let filter = TableNameFilter {
            include_patterns: vec!["ads_cp%".to_string(), "user_%".to_string()],
            exclude_patterns: vec!["%_bak".to_string()],
        };
        let sql = list_tables_sql("app", None, Some(100), Some(200), None, Some(&filter));

        assert!(sql.contains("LOWER(TABLE_NAME) LIKE 'ads_cp%' ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(TABLE_NAME) LIKE 'user_%' ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(TABLE_NAME) NOT LIKE '%_bak' ESCAPE '\\\\'"));
        assert!(sql.find("LOWER(TABLE_NAME) LIKE").unwrap() < sql.find("ORDER BY TABLE_NAME").unwrap());
        assert!(sql.find("ORDER BY TABLE_NAME").unwrap() < sql.find("LIMIT 100").unwrap());
    }

    #[test]
    fn mysql_show_tables_fallback_applies_filter_type_limit_and_offset() {
        let rows = vec![
            TableInfo {
                name: "audit_2024".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            TableInfo {
                name: "audit_view".to_string(),
                table_type: "VIEW".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            TableInfo {
                name: "audit_2025".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: Some("purchase order history".to_string()),
                parent_schema: None,
                parent_name: None,
            },
        ];
        let filtered =
            filter_list_tables_fallback(rows, Some("audit"), Some(1), Some(1), Some(&["TABLE".to_string()]), None);

        assert_eq!(filtered.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), vec!["audit_2025"]);

        let rows = vec![TableInfo {
            name: "t_0001".to_string(),
            table_type: "BASE TABLE".to_string(),
            comment: Some("food orders".to_string()),
            parent_schema: None,
            parent_name: None,
        }];
        let filtered = filter_list_tables_fallback(rows, Some("ood"), None, None, Some(&["TABLE".to_string()]), None);

        assert_eq!(filtered.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), vec!["t_0001"]);
    }

    #[test]
    fn mysql_object_browser_fallback_keeps_tables_views_and_routines_by_default() {
        let table_objects = vec![mysql_test_object("orders", "TABLE"), mysql_test_object("orders_view", "VIEW")];
        let mut objects = filter_table_objects_fallback(table_objects, None, None, None);
        objects.push(mysql_test_object("refresh_orders", "PROCEDURE"));

        assert_eq!(
            objects.iter().map(|object| object.object_type.as_str()).collect::<Vec<_>>(),
            vec!["TABLE", "VIEW", "PROCEDURE"]
        );
    }

    #[test]
    fn mysql_object_browser_routine_only_does_not_use_table_fallback() {
        let object_types = vec!["PROCEDURE".to_string(), "FUNCTION".to_string()];

        assert!(!wants_table_objects(Some(&object_types)));
        assert!(wants_routine_objects(Some(&object_types)));
        assert!(filter_table_objects_fallback(
            vec![mysql_test_object("orders", "TABLE")],
            Some(&object_types),
            None,
            None,
        )
        .is_empty());
    }

    #[test]
    fn mysql_object_browser_fallback_filters_type_limit_and_offset() {
        let objects = vec![
            mysql_test_object("a_table", "TABLE"),
            mysql_test_object("b_view", "VIEW"),
            mysql_test_object("c_table", "TABLE"),
        ];
        let object_types = vec!["TABLE".to_string()];

        let filtered = filter_table_objects_fallback(objects, Some(&object_types), Some(1), Some(1));

        assert_eq!(filtered.iter().map(|object| object.name.as_str()).collect::<Vec<_>>(), vec!["c_table"]);
    }

    #[test]
    fn mysql_table_comment_sql_targets_single_table() {
        let sql = table_comment_sql("app", "users");

        assert!(sql.contains("SELECT TABLE_COMMENT"));
        assert!(sql.contains("TABLE_SCHEMA = 'app'"));
        assert!(sql.contains("TABLE_NAME = 'users'"));
        assert!(sql.contains("TABLE_TYPE <> 'VIEW'"));
        assert!(sql.contains("LIMIT 1"));
        assert!(!sql.contains("ORDER BY"));
    }

    #[test]
    fn mysql_database_infos_filter_blank_names_and_keep_catalogless_marker() {
        let regular = database_infos_from_names(vec!["".to_string(), " app ".to_string(), "mysql".to_string()], true);
        assert_eq!(regular.iter().map(|db| db.name.as_str()).collect::<Vec<_>>(), vec!["app", "mysql"]);

        let catalogless = database_infos_from_names(vec!["".to_string(), "   ".to_string()], true);
        assert_eq!(catalogless.iter().map(|db| db.name.as_str()).collect::<Vec<_>>(), vec![""]);

        let no_marker = database_infos_from_names(vec!["".to_string()], false);
        assert!(no_marker.is_empty());
    }

    #[test]
    fn mysql_database_listing_prefers_show_databases() {
        assert_eq!(
            DATABASE_LIST_QUERY_PLAN,
            [
                ("SHOW DATABASES", true),
                ("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME", false),
            ]
        );
    }

    #[test]
    fn mysql_show_metadata_sql_supports_catalogless_services() {
        assert_eq!(show_tables_filtered_sql("", true, None, &[]), "SHOW FULL TABLES");
        assert_eq!(show_tables_filtered_sql("", false, None, &[]), "SHOW TABLES");
        assert_eq!(show_tables_filtered_sql("app", true, None, &[]), "SHOW FULL TABLES FROM `app`");
        assert_eq!(show_columns_sql("", "idx", true), "SHOW FULL COLUMNS FROM `idx`");
        assert_eq!(show_columns_sql("app", "idx", false), "SHOW COLUMNS FROM `app`.`idx`");
    }

    #[test]
    fn mysql_list_routines_sql_is_independent_of_tables() {
        let sql = list_routines_sql("app", None, None, None);

        assert!(sql.contains("information_schema.ROUTINES"));
        assert!(!sql.contains("information_schema.TABLES"));
        assert!(!sql.contains("UNION"));
        assert!(sql.contains("'PROCEDURE'"));
        assert!(sql.contains("'FUNCTION'"));
        assert!(sql.contains("CREATED AS created_at"));
        assert!(sql.contains("LAST_ALTERED AS updated_at"));
    }

    #[test]
    fn mysql_list_routines_sql_honors_requested_type_and_paging() {
        let object_types = vec!["PROCEDURE".to_string()];
        let sql = list_routines_sql("app", Some(&object_types), Some(101), Some(200));

        assert!(sql.contains("ROUTINE_TYPE IN ('PROCEDURE')"));
        assert!(!sql.contains("'FUNCTION'"));
        assert!(sql.ends_with("LIMIT 101 OFFSET 200"));
    }

    #[test]
    fn mysql_list_routines_legacy_sql_preserves_filtering_and_paging() {
        let object_types = vec!["FUNCTION".to_string()];
        let sql =
            list_routines_sql_for_query("app", Some(&object_types), Some(101), Some(200), RoutineMetadataQuery::Legacy);

        assert!(sql.contains("NULL AS created_at, NULL AS updated_at"));
        assert!(!sql.contains("CREATED AS created_at"));
        assert!(sql.contains("ROUTINE_TYPE IN ('FUNCTION')"));
        assert!(!sql.contains("ROUTINE_TYPE IN ('PROCEDURE')"));
        assert!(sql.ends_with("LIMIT 101 OFFSET 200"));
    }

    #[test]
    fn mysql_routine_metadata_queries_are_bounded_to_one_fallback() {
        assert_eq!(routine_metadata_queries(), [RoutineMetadataQuery::Timestamps, RoutineMetadataQuery::Legacy]);
    }

    #[test]
    fn mysql_routine_row_preserves_creation_and_update_times() {
        let columns = [
            "object_name",
            "object_type",
            "object_comment",
            "created_at",
            "updated_at",
            "parent_schema",
            "parent_name",
            "sort_order",
        ]
        .into_iter()
        .map(|name| Column::new(ColumnType::MYSQL_TYPE_VAR_STRING).with_name(name.as_bytes()))
        .collect();
        let row = mysql_test_row_with_columns(
            vec![
                Value::Bytes(b"refresh_orders".to_vec()),
                Value::Bytes(b"PROCEDURE".to_vec()),
                Value::NULL,
                Value::Bytes(b"2026-08-13 04:00:00".to_vec()),
                Value::Bytes(b"2026-08-13 04:05:00".to_vec()),
                Value::NULL,
                Value::NULL,
                Value::Int(2),
            ],
            columns,
        );

        let object = row_to_object(&row, "app");

        assert_eq!(object.created_at.as_deref(), Some("2026-08-13 04:00:00"));
        assert_eq!(object.updated_at.as_deref(), Some("2026-08-13 04:05:00"));
    }

    #[test]
    fn mysql_list_tables_objects_sql_honors_requested_type_and_paging() {
        let object_types = vec!["VIEW".to_string()];
        let sql = list_tables_objects_sql("app", Some(&object_types), Some(51), Some(100));

        assert!(sql.contains("TABLE_TYPE IN ('VIEW', 'SYSTEM VIEW')"));
        assert!(sql.contains("CASE WHEN TABLE_TYPE IN ('VIEW', 'SYSTEM VIEW') THEN 'VIEW' ELSE 'TABLE' END"));
        assert!(sql.ends_with("LIMIT 51 OFFSET 100"));
    }

    #[test]
    fn mysql_object_query_only_pages_within_one_metadata_source() {
        assert!(object_query_supports_paging(Some(&["PROCEDURE".to_string()])));
        assert!(object_query_supports_paging(Some(&["TABLE".to_string(), "VIEW".to_string()])));
        assert!(!object_query_supports_paging(Some(&["TABLE".to_string(), "PROCEDURE".to_string()])));
        assert!(!object_query_supports_paging(None));
    }

    #[test]
    fn logical_table_objects_keep_only_requested_non_table_sources() {
        assert_eq!(logical_table_supplemental_types(None), ["PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"]);
        assert!(logical_table_supplemental_types(Some(&["TABLE".to_string(), "VIEW".to_string()])).is_empty());
        assert_eq!(
            logical_table_supplemental_types(Some(&["TABLE".to_string(), "PROCEDURE".to_string()])),
            ["PROCEDURE"]
        );
    }

    #[test]
    fn mysql_completion_triggers_sql_lists_database_triggers() {
        let sql = list_completion_triggers_sql("app");

        assert!(sql.contains("information_schema.TRIGGERS"));
        assert!(sql.contains("'TRIGGER' AS object_type"));
        assert!(sql.contains("EVENT_OBJECT_TABLE AS parent_name"));
        assert!(sql.contains("TRIGGER_SCHEMA = 'app'"));
    }

    #[test]
    fn lists_triggers_and_events_via_information_schema() {
        let sql = list_triggers_objects_sql("shop");
        assert!(sql.contains("information_schema.TRIGGERS"));
        assert!(sql.contains("TRIGGER_SCHEMA = 'shop'"));
        let sql = list_events_objects_sql("shop");
        assert!(sql.contains("information_schema.EVENTS"));
        assert!(sql.contains("EVENT_SCHEMA = 'shop'"));
        assert!(wants_trigger_objects(Some(&["TRIGGER".to_string()])));
        assert!(!wants_trigger_objects(Some(&["TABLE".to_string()])));
        assert!(wants_event_objects(Some(&["EVENT".to_string()])));
    }

    #[test]
    fn mysql_completion_like_pattern_uses_prefix_by_default() {
        assert_eq!(mysql_completion_like_pattern("Temp", Some(&CompletionAssistantMatchMode::Prefix)), "Temp%");
        assert_eq!(mysql_completion_like_pattern("Temp", Some(&CompletionAssistantMatchMode::Contains)), "%Temp%");
        assert_eq!(
            mysql_completion_like_pattern("order_100%", Some(&CompletionAssistantMatchMode::Prefix)),
            "order\\_100\\%%"
        );
    }

    #[test]
    fn mysql_completion_sql_filters_before_limit() {
        let table_sql = mysql_completion_tables_sql(
            "app",
            "Temp%",
            &[CompletionAssistantObjectKind::Table, CompletionAssistantObjectKind::View],
            100,
        );
        let routine_sql =
            mysql_completion_routines_sql("app", "%audit%", &[CompletionAssistantObjectKind::Routine], 50);
        let column_sql = mysql_completion_columns_sql("app", "users", "id%", 25);

        assert!(table_sql.contains("TABLE_NAME LIKE 'Temp%' ESCAPE '\\\\'"));
        assert!(table_sql.contains("TABLE_TYPE IN ('BASE TABLE','SYSTEM VERSIONED','VIEW')"));
        assert!(table_sql.contains("ORDER BY TABLE_NAME LIMIT 100"));
        assert!(routine_sql.contains("ROUTINE_NAME LIKE '%audit%' ESCAPE '\\\\'"));
        assert!(routine_sql.contains("ROUTINE_TYPE IN ('PROCEDURE','FUNCTION')"));
        assert!(column_sql.contains("COLUMN_NAME LIKE 'id%' ESCAPE '\\\\'"));
        assert!(column_sql.contains("ORDER BY ORDINAL_POSITION LIMIT 25"));
    }

    #[test]
    fn mysql_columns_sql_uses_column_key_and_table_default_collation() {
        let sql = columns_sql("app", "users");

        assert!(sql.contains("information_schema.COLUMNS"));
        // TABLE_COLLATION is fetched separately via `table_collation_sql`; the LEFT JOIN onto
        // information_schema.TABLES is intentionally avoided to keep MySQL 5.7 fast.
        assert!(!sql.contains("information_schema.TABLES"));
        assert!(!sql.contains("TABLE_COLLATION"));
        assert!(!sql.contains("KEY_COLUMN_USAGE"));
        assert!(!sql.contains("CONSTRAINT_NAME = 'PRIMARY'"));
        assert!(sql.contains("COLUMN_KEY"));
        assert!(sql.contains("DATA_TYPE"));
        assert!(sql.contains("COLUMN_TYPE"));
        assert!(!sql.contains("COLLATE"));
        assert!(!sql.contains("AS ENUM_VALUES"));
    }

    #[test]
    fn mysql_generation_expression_sql_is_separate_and_scoped() {
        let sql = generation_expressions_sql("app", "products");

        assert!(sql.contains("COLUMN_NAME, GENERATION_EXPRESSION"));
        assert!(sql.contains("TABLE_SCHEMA = 'app'"));
        assert!(sql.contains("TABLE_NAME = 'products'"));
        assert!(sql.contains("GENERATION_EXPRESSION <> ''"));
    }

    #[test]
    fn mysql_generated_column_extra_rebuilds_virtual_and_stored_clauses() {
        assert_eq!(
            mysql_generated_column_extra("STORED GENERATED", "`price` * `quantity`"),
            Some("GENERATED ALWAYS AS (`price` * `quantity`) STORED".to_string())
        );
        assert_eq!(
            mysql_generated_column_extra("VIRTUAL GENERATED", "lower(`name`)"),
            Some("GENERATED ALWAYS AS (lower(`name`)) VIRTUAL".to_string())
        );
        assert_eq!(mysql_generated_column_extra("DEFAULT_GENERATED", "current_timestamp()"), None);
    }

    #[test]
    fn mysql_generated_column_expressions_enrich_only_generated_columns() {
        let mut columns = vec![
            ColumnInfo { name: "total".to_string(), extra: Some("STORED GENERATED".to_string()), ..Default::default() },
            ColumnInfo {
                name: "search_name".to_string(),
                extra: Some("VIRTUAL GENERATED".to_string()),
                ..Default::default()
            },
            ColumnInfo {
                name: "created_at".to_string(),
                extra: Some("DEFAULT_GENERATED".to_string()),
                ..Default::default()
            },
        ];
        let expressions = HashMap::from([
            ("total".to_string(), "`price` * `quantity`".to_string()),
            ("search_name".to_string(), "lower(`name`)".to_string()),
            ("created_at".to_string(), "current_timestamp()".to_string()),
        ]);

        apply_mysql_generated_column_expressions(&mut columns, &expressions);

        assert_eq!(columns[0].extra.as_deref(), Some("GENERATED ALWAYS AS (`price` * `quantity`) STORED"));
        assert_eq!(columns[1].extra.as_deref(), Some("GENERATED ALWAYS AS (lower(`name`)) VIRTUAL"));
        assert_eq!(columns[2].extra.as_deref(), Some("DEFAULT_GENERATED"));
    }

    #[test]
    fn mysql_nullable_table_collation_uses_optional_string_conversion() {
        let collation = mysql_async::from_value_opt::<Option<String>>(mysql_async::Value::NULL)
            .expect("Option<String> must accept NULL MySQL metadata values");

        assert_eq!(collation, None);
    }

    #[test]
    fn mysql_column_charset_metadata_clears_values_matching_table_default() {
        let mut columns = vec![
            ColumnInfo {
                name: "inherited_name".to_string(),
                character_set: Some("utf8mb4".to_string()),
                collation: Some("utf8mb4_unicode_ci".to_string()),
                ..Default::default()
            },
            ColumnInfo {
                name: "explicit_other".to_string(),
                character_set: Some("latin1".to_string()),
                collation: Some("latin1_bin".to_string()),
                ..Default::default()
            },
            ColumnInfo { name: "numeric_value".to_string(), ..Default::default() },
        ];

        normalize_mysql_column_charset_metadata(&mut columns, Some("utf8mb4_unicode_ci"));

        assert_eq!((columns[0].character_set.as_deref(), columns[0].collation.as_deref()), (None, None));
        assert_eq!(columns[1].character_set.as_deref(), Some("latin1"));
        assert_eq!(columns[1].collation.as_deref(), Some("latin1_bin"));
        assert_eq!((columns[2].character_set.as_deref(), columns[2].collation.as_deref()), (None, None));
    }

    #[test]
    fn mysql_column_charset_metadata_preserves_values_without_table_default() {
        let mut columns = vec![ColumnInfo {
            name: "name".to_string(),
            character_set: Some("utf8mb4".to_string()),
            collation: Some("utf8mb4_unicode_ci".to_string()),
            ..Default::default()
        }];

        normalize_mysql_column_charset_metadata(&mut columns, None);

        assert_eq!(columns[0].character_set.as_deref(), Some("utf8mb4"));
        assert_eq!(columns[0].collation.as_deref(), Some("utf8mb4_unicode_ci"));
    }

    #[test]
    fn parse_mysql_enum_values_preserves_mysql_literal_edges() {
        assert_eq!(
            parse_mysql_enum_values("enum('pending','active','archived')"),
            Some(vec!["pending".to_string(), "active".to_string(), "archived".to_string()])
        );
        assert_eq!(parse_mysql_enum_values("ENUM('','a')"), Some(vec!["".to_string(), "a".to_string()]));
        assert_eq!(parse_mysql_enum_values("enum('x'',''y','z')"), Some(vec!["x','y".to_string(), "z".to_string()]));
        assert_eq!(
            parse_mysql_enum_values(r#"enum('it''s','quote\"d','back\\slash')"#),
            Some(vec!["it's".to_string(), "quote\"d".to_string(), "back\\slash".to_string()])
        );
        assert_eq!(parse_mysql_enum_values("varchar(255)"), None);
    }

    #[test]
    fn mysql_largeint_uses_lossless_integer_decoding() {
        assert!(is_mysql_lossless_integer_type("LARGEINT"));
    }

    fn mysql_test_column(
        column_type: ColumnType,
        character_set: u16,
        flags: ColumnFlags,
        column_length: u32,
    ) -> mysql_async::Column {
        mysql_async::Column::new(column_type)
            .with_character_set(character_set)
            .with_flags(flags)
            .with_column_length(column_length)
    }

    #[test]
    fn mysql_binary_preview_keeps_binary_collation_varchar_as_text() {
        let column = mysql_test_column(ColumnType::MYSQL_TYPE_VAR_STRING, 45, ColumnFlags::BINARY_FLAG, 64);

        assert_eq!(mysql_bytes_to_json(b"SN-A0001".to_vec(), &column), serde_json::json!("SN-A0001"));
    }

    #[test]
    fn mysql_shardingsphere_binary_flags_restore_proxy_binary_types() {
        let proxy_flags = ColumnFlags::BINARY_FLAG | ColumnFlags::UNSIGNED_FLAG;
        let binary_column = mysql_test_column(ColumnType::MYSQL_TYPE_STRING, 45, proxy_flags, 8);
        let varbinary_column = mysql_test_column(ColumnType::MYSQL_TYPE_VAR_STRING, 45, proxy_flags, 32);

        assert_eq!(mysql_column_type_name(&binary_column), "binary");
        assert_eq!(mysql_column_type_name(&varbinary_column), "varbinary");
        assert_eq!(
            mysql_bytes_to_json(b"150010\0\0".to_vec(), &binary_column),
            serde_json::json!("0x3135303031300000")
        );
        assert_eq!(
            mysql_bytes_to_json(vec![0xde, 0xad, 0xbe, 0xef], &varbinary_column),
            serde_json::json!("0xdeadbeef")
        );
    }

    #[test]
    fn mysql_shardingsphere_unsigned_text_flags_remain_text() {
        let text_column = mysql_test_column(ColumnType::MYSQL_TYPE_VAR_STRING, 45, ColumnFlags::UNSIGNED_FLAG, 32);

        assert_eq!(mysql_column_type_name(&text_column), "varchar");
        assert_eq!(mysql_bytes_to_json(b"TEXT-001".to_vec(), &text_column), serde_json::json!("TEXT-001"));
    }

    #[test]
    fn mysql_binary_values_preserve_all_bytes_as_hex() {
        let binary_column = mysql_test_column(ColumnType::MYSQL_TYPE_STRING, 63, ColumnFlags::BINARY_FLAG, 8);
        let varbinary_column = mysql_test_column(ColumnType::MYSQL_TYPE_VAR_STRING, 63, ColumnFlags::BINARY_FLAG, 8);

        assert_eq!(
            mysql_bytes_to_json(b"150010\0\0".to_vec(), &binary_column),
            serde_json::json!("0x3135303031300000")
        );
        assert_eq!(mysql_bytes_to_json(b"150010".to_vec(), &varbinary_column), serde_json::json!("0x313530303130"));
        assert_eq!(
            mysql_bytes_to_json(b"SN-A0001".to_vec(), &varbinary_column),
            serde_json::json!("0x534e2d4130303031")
        );
    }

    #[test]
    fn mysql_binary_values_preserve_unprintable_bytes_as_hex() {
        let binary_column = mysql_test_column(ColumnType::MYSQL_TYPE_STRING, 63, ColumnFlags::BINARY_FLAG, 8);
        let varbinary_column = mysql_test_column(ColumnType::MYSQL_TYPE_VAR_STRING, 63, ColumnFlags::BINARY_FLAG, 8);

        assert_eq!(mysql_bytes_to_json(vec![0x01, 0x02, 0x03, 0x04], &binary_column), serde_json::json!("0x01020304"));
        assert_eq!(
            mysql_bytes_to_json(vec![0xde, 0xad, 0xbe, 0xef], &varbinary_column),
            serde_json::json!("0xdeadbeef")
        );
    }

    #[test]
    fn mysql_large_text_preview_preserves_key_and_reports_cell_coordinates() {
        let id_column = Column::new(ColumnType::MYSQL_TYPE_VAR_STRING)
            .with_name(b"id")
            .with_character_set(45)
            .with_column_length(64);
        let payload_column = Column::new(ColumnType::MYSQL_TYPE_LONG_BLOB)
            .with_name(b"payload")
            .with_character_set(45)
            .with_column_length(u32::MAX);
        let row = mysql_test_row_with_columns(
            vec![Value::Bytes(vec![b'k'; 2048]), Value::Bytes(vec![b'x'; 32 * 1024])],
            vec![id_column, payload_column],
        );
        let protected = mysql_result_protected_column_indexes(row.columns_ref(), &["id".to_string()]);
        let mut spatial_columns = mysql_spatial_column_builder(row.columns_ref());

        let (values, _srids, cells) =
            mysql_row_to_json_with_srids_and_previews(&row, &mut spatial_columns, 7, Some(1024), &protected);

        assert_eq!(values[0], serde_json::json!("k".repeat(2048)));
        assert_eq!(values[1].as_str().map(str::len), Some(1027));
        assert!(values[1].as_str().is_some_and(|value| value.ends_with("...")));
        assert_eq!(cells, vec![LargeValueCell { row_index: 7, column_index: 1, original_bytes: 32 * 1024 }]);
    }

    #[test]
    fn mysql_large_value_preview_protects_protocol_primary_keys_without_frontend_metadata() {
        let id_column = Column::new(ColumnType::MYSQL_TYPE_VAR_STRING)
            .with_name(b"id")
            .with_character_set(45)
            .with_flags(ColumnFlags::PRI_KEY_FLAG)
            .with_column_length(3072);
        let payload_column = Column::new(ColumnType::MYSQL_TYPE_JSON)
            .with_name(b"payload")
            .with_character_set(45)
            .with_column_length(u32::MAX);
        let row = mysql_test_row_with_columns(
            vec![Value::Bytes(vec![b'k'; 2048]), Value::Bytes(vec![b'x'; 4096])],
            vec![id_column, payload_column],
        );
        let protected = mysql_result_protected_column_indexes(row.columns_ref(), &[]);
        let mut spatial_columns = mysql_spatial_column_builder(row.columns_ref());

        let (values, _srids, cells) =
            mysql_row_to_json_with_srids_and_previews(&row, &mut spatial_columns, 0, Some(512), &protected);

        assert_eq!(values[0], serde_json::json!("k".repeat(2048)));
        assert_eq!(cells, vec![LargeValueCell { row_index: 0, column_index: 1, original_bytes: 4096 }]);
    }

    #[test]
    fn mysql_large_value_preview_skips_bounded_strings_and_server_preview_columns() {
        let ordinary_column = Column::new(ColumnType::MYSQL_TYPE_VAR_STRING)
            .with_name(b"image_url")
            .with_character_set(45)
            .with_column_length(2048);
        let large_column = Column::new(ColumnType::MYSQL_TYPE_VAR_STRING)
            .with_name(b"large_note")
            .with_character_set(45)
            .with_column_length(40_000);
        let server_preview_column = Column::new(ColumnType::MYSQL_TYPE_VAR_STRING)
            .with_name(b"image_data")
            .with_character_set(63)
            .with_column_length(1680);
        let marker_column = Column::new(ColumnType::MYSQL_TYPE_VAR_STRING)
            .with_name(format!("{}B_2", crate::sql_dialect::DBX_LARGE_VALUE_BYTES_COLUMN_PREFIX).as_bytes())
            .with_character_set(45)
            .with_column_length(64);
        let row = mysql_test_row_with_columns(
            vec![
                Value::Bytes(vec![b'u'; 500]),
                Value::Bytes(vec![b'n'; 10_000]),
                Value::Bytes(vec![0xab; 420]),
                Value::Bytes(b"B:419:25143".to_vec()),
            ],
            vec![ordinary_column, large_column, server_preview_column, marker_column],
        );
        let protected = mysql_result_protected_column_indexes(row.columns_ref(), &[]);
        let mut spatial_columns = mysql_spatial_column_builder(row.columns_ref());

        let (values, _srids, cells) =
            mysql_row_to_json_with_srids_and_previews(&row, &mut spatial_columns, 0, Some(256), &protected);

        assert_eq!(values[0].as_str().map(str::len), Some(500));
        assert!(values[1].as_str().is_some_and(|value| value.ends_with("...")));
        assert_eq!(values[2].as_str().map(str::len), Some(2 + 420 * 2));
        assert_eq!(values[3], serde_json::json!("B:419:25143"));
        assert_eq!(cells, vec![LargeValueCell { row_index: 0, column_index: 1, original_bytes: 10_000 }]);
    }

    #[test]
    fn mysql_large_binary_preview_is_bounded_hex() {
        let payload_column = Column::new(ColumnType::MYSQL_TYPE_LONG_BLOB)
            .with_name(b"payload")
            .with_character_set(63)
            .with_flags(ColumnFlags::BLOB_FLAG)
            .with_column_length(u32::MAX);
        let row = mysql_test_row_with_columns(vec![Value::Bytes(vec![0xAB; 4096])], vec![payload_column]);
        let mut spatial_columns = mysql_spatial_column_builder(row.columns_ref());

        let (values, _srids, cells) =
            mysql_row_to_json_with_srids_and_previews(&row, &mut spatial_columns, 0, Some(512), &HashSet::new());

        let preview = values[0].as_str().unwrap();
        assert!(preview.starts_with("0xabab"));
        assert!(preview.ends_with("..."));
        assert_eq!(preview.len(), 2 + 512 * 2 + 3);
        assert_eq!(cells[0].original_bytes, 4096);
    }

    #[test]
    fn mysql_result_preview_budget_scales_with_page_and_column_count() {
        let text_column = mysql_test_column(ColumnType::MYSQL_TYPE_LONG_BLOB, 45, ColumnFlags::empty(), u32::MAX);
        let binary_column = mysql_test_column(ColumnType::MYSQL_TYPE_LONG_BLOB, 63, ColumnFlags::BLOB_FLAG, u32::MAX);
        assert_eq!(mysql_result_cell_preview_bytes(32 * 1024 * 1024, 1, std::slice::from_ref(&text_column)), 8 * 1024);
        assert_eq!(mysql_result_cell_preview_bytes(32 * 1024 * 1024, 1000, &vec![text_column.clone(); 4]), 8 * 1024);
        assert_eq!(mysql_result_cell_preview_bytes(32 * 1024 * 1024, 1000, &vec![text_column.clone(); 16]), 2097);
        assert_eq!(mysql_result_cell_preview_bytes(1, 1000, &vec![text_column; 100]), 256);
        assert_eq!(mysql_result_cell_preview_bytes(32 * 1024 * 1024, 1000, &vec![binary_column; 4]), 4194);
    }

    #[test]
    fn mysql_binary_preview_uses_charset_to_separate_blob_from_text() {
        let text_column = mysql_test_column(ColumnType::MYSQL_TYPE_BLOB, 45, ColumnFlags::empty(), 65_535);
        let blob_column = mysql_test_column(ColumnType::MYSQL_TYPE_BLOB, 63, ColumnFlags::BLOB_FLAG, 65_535);

        assert_eq!(mysql_bytes_to_json(b"hello".to_vec(), &text_column), serde_json::json!("hello"));
        assert_eq!(mysql_bytes_to_json(vec![0x00, 0x01, 0xab, 0xff], &blob_column), serde_json::json!("0x0001abff"));
    }

    #[test]
    fn mysql_bit_preview_uses_boolean_or_bit_string_text() {
        let bit_one = mysql_test_column(ColumnType::MYSQL_TYPE_BIT, 63, ColumnFlags::UNSIGNED_FLAG, 1);
        let bit_eight = mysql_test_column(ColumnType::MYSQL_TYPE_BIT, 63, ColumnFlags::UNSIGNED_FLAG, 8);

        assert_eq!(mysql_bit_value_to_string(&[1], &bit_one), "1");
        assert_eq!(mysql_bit_value_to_string(&[0b1010_1010], &bit_eight), "10101010");
    }

    #[test]
    fn mysql_column_key_marks_primary() {
        let column_key = "PRI";
        let is_pk = column_key.eq_ignore_ascii_case("PRI");
        assert!(is_pk);
    }

    #[test]
    fn mysql_management_show_queries_use_text_protocol() {
        assert!(requires_text_protocol_query("SHOW PROCESSLIST", MySqlQueryDialect::default()));
        assert!(requires_text_protocol_query("show full processlist", MySqlQueryDialect::default()));
        assert!(requires_text_protocol_query("SHOW SLAVE STATUS", MySqlQueryDialect::default()));
        assert!(requires_text_protocol_query("show replica status", MySqlQueryDialect::default()));
        assert!(requires_text_protocol_query("SHOW GRANTS", MySqlQueryDialect::default()));
        assert!(requires_text_protocol_query("SHOW GRANTS FOR 'repl'@'%'", MySqlQueryDialect::default()));
        assert!(!requires_text_protocol_query("SHOW TABLES", MySqlQueryDialect::default()));
        assert!(!requires_text_protocol_query("SELECT * FROM users", MySqlQueryDialect::default()));
    }

    #[test]
    fn mysql_user_result_sets_prefer_text_protocol() {
        let dialect = MySqlQueryDialect::default();

        assert!(prefers_text_protocol_query("SELECT * FROM users", dialect));
        assert!(prefers_text_protocol_query("WITH recent AS (SELECT 1 AS id) SELECT id FROM recent", dialect));
        assert!(prefers_text_protocol_query("SHOW TABLES", dialect));
        assert!(!prefers_text_protocol_query("UPDATE users SET name = 'Ada' WHERE id = 1", dialect));
    }

    #[test]
    fn mysql_text_result_sets_use_buffered_collection_for_bounded_page_queries() {
        assert!(should_collect_text_result_set("SELECT * FROM users LIMIT 100;", 100, Some(100)));
        assert!(should_collect_text_result_set("SELECT * FROM users ORDER BY id LIMIT 25 OFFSET 50;", 100, Some(100)));
        assert!(should_collect_text_result_set("SELECT * FROM users LIMIT 20, 50;", 100, Some(100)));
    }

    #[test]
    fn mysql_text_result_sets_keep_streaming_when_unbounded_or_too_large() {
        assert!(!should_collect_text_result_set("SELECT * FROM users", 100, Some(100)));
        assert!(!should_collect_text_result_set("SELECT * FROM users LIMIT 1000000", 100, Some(100)));
        assert!(!should_collect_text_result_set("SELECT * FROM users LIMIT 100", 100, None));
        assert!(!should_collect_text_result_set("SELECT * FROM (SELECT * FROM audit LIMIT 100) t", 100, Some(100)));
    }

    #[test]
    fn mysql_binary_decode_parse_errors_retry_with_text_protocol() {
        assert!(mysql_error_should_retry_with_text_protocol(
            "Input/output error: can't parse: buf doesn't have enough data"
        ));
    }

    #[test]
    fn mysql_timestamp_default_null_ddl_enables_explicit_defaults() {
        let create_sql = r#"
            CREATE TABLE `referral_record` (
                `id` BINARY(16) NOT NULL,
                `created_at` TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                `updated_at` TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                `deleted_at` TIMESTAMP(6) DEFAULT NULL,
                PRIMARY KEY (`id`)
            ) ENGINE = InnoDB
        "#;

        assert!(should_enable_explicit_timestamp_defaults(create_sql));
        assert!(should_enable_explicit_timestamp_defaults(
            "ALTER TABLE referral_record ADD deleted_at TIMESTAMP DEFAULT NULL"
        ));
        assert!(!should_enable_explicit_timestamp_defaults("CREATE TABLE t (deleted_at DATETIME(6) DEFAULT NULL)"));
        assert!(!should_enable_explicit_timestamp_defaults("SELECT 'TIMESTAMP DEFAULT NULL'"));
        assert_eq!(explicit_timestamp_defaults_sql(true), "SET SESSION explicit_defaults_for_timestamp = ON");
        assert_eq!(explicit_timestamp_defaults_sql(false), "SET SESSION explicit_defaults_for_timestamp = OFF");
    }

    #[test]
    fn mysql_tls_session_close_errors_retry_without_ssl() {
        let error = "MySQL connection failed: error communicating with database: \
            encountered error while attempting to establish a TLS connection: \
            server closed session with no notification";

        assert!(mysql_error_should_retry_without_ssl(error));
    }

    #[test]
    fn mysql_server_without_ssl_capability_retries_without_ssl() {
        let error =
            "MySQL connection failed: Driver error: `Client asked for SSL but server does not have this capability'";

        assert!(mysql_error_should_retry_without_ssl(error));
    }

    #[test]
    fn mysql_packet_out_of_order_can_retry_without_ssl() {
        let error = "MySQL connection failed: Input/output error: Input/output error: packet out of order";

        assert!(mysql_error_should_retry_without_ssl(error));
        assert!(!mysql_error_should_retry_with_legacy_eof(error));
    }

    #[test]
    fn mysql_packets_out_of_sync_retries_with_legacy_eof() {
        let error = "MySQL connection failed: Input/output error: Input/output error: Packets out of sync";

        assert!(mysql_error_should_retry_with_legacy_eof(error));
        assert!(!mysql_error_should_retry_without_ssl(error));
    }

    #[test]
    fn mysql_async_builder_can_disable_deprecated_eof_protocol() {
        let opts = mysql_async::Opts::from(mysql_async::OptsBuilder::default().deprecate_eof(false));

        assert!(!opts.deprecate_eof());
    }

    #[test]
    fn mysql_bad_file_descriptor_retries_without_tcp_keepalive() {
        let error = "MySQL connection failed: Input/output error: Input/output error: Bad file descriptor (os error 9)";

        assert!(mysql_error_should_retry_without_tcp_keepalive(error));
        assert!(!mysql_error_should_retry_without_tcp_keepalive(
            "MySQL connection failed: Connection reset by peer (os error 54)"
        ));
    }

    #[test]
    fn mysql_tcp_keepalive_uses_milliseconds_not_seconds() {
        assert_eq!(MYSQL_TCP_KEEPALIVE_MS, 30_000);
        assert_eq!(
            MySqlTcpKeepaliveMode::Enabled.duration(),
            Some(Duration::from_millis(u64::from(MYSQL_TCP_KEEPALIVE_MS)))
        );
        assert_eq!(MySqlTcpKeepaliveMode::Disabled.duration(), None);
    }

    #[test]
    fn mysql_async_builder_host_strips_ipv6_url_brackets() {
        let opts = mysql_async::Opts::from_url("mysql://root:secret@[2001:db8::1]:3306/app").unwrap();

        assert_eq!(opts.ip_or_hostname(), "[2001:db8::1]");
        assert_eq!(mysql_async_tcp_host(opts.ip_or_hostname()), "2001:db8::1");

        let builder_opts = mysql_async::Opts::from(
            mysql_async::OptsBuilder::from_opts(opts).ip_or_hostname(mysql_async_tcp_host("[2001:db8::1]").to_string()),
        );
        assert_eq!(builder_opts.ip_or_hostname(), "2001:db8::1");
        assert_eq!(builder_opts.tcp_port(), 3306);
    }

    #[test]
    fn mysql_async_builder_host_only_strips_valid_ipv6_literals() {
        assert_eq!(mysql_async_tcp_host("2001:db8::1"), "2001:db8::1");
        assert_eq!(mysql_async_tcp_host("[mysql.example.com]"), "[mysql.example.com]");
        assert_eq!(mysql_async_tcp_host("mysql.example.com"), "mysql.example.com");
    }

    #[test]
    fn mysql_tls_url_strips_client_identity_params_before_driver_parse() {
        let dir = std::env::temp_dir();
        let cert = dir.join(format!("dbx-mysql-client-cert-{}.pem", std::process::id()));
        let key = dir.join(format!("dbx-mysql-client-key-{}.pem", std::process::id()));
        std::fs::write(&cert, "not a real cert").unwrap();
        std::fs::write(&key, "not a real key").unwrap();

        let url = format!(
            "mysql://root:secret@localhost/test?require_ssl=true&ssl-cert={}&ssl-key={}&charset=utf8mb4",
            cert.display(),
            key.display()
        );
        let parsed = mysql_tls_url(&url).unwrap();

        assert_eq!(parsed.url, "mysql://root:secret@localhost/test?require_ssl=true&charset=utf8mb4");
        assert_eq!(parsed.files.sslcert.as_deref(), Some(cert.to_str().unwrap()));
        assert_eq!(parsed.files.sslkey.as_deref(), Some(key.to_str().unwrap()));
        mysql_async::Opts::from_url(&mysql_async_url(&parsed.url)).unwrap();

        let _ = std::fs::remove_file(cert);
        let _ = std::fs::remove_file(key);
    }

    #[test]
    fn mysql_tls_rejects_unpaired_client_cert_and_key() {
        let files = MySqlTlsFiles { sslcert: Some("/tmp/client.crt".to_string()), sslkey: None };

        let error = mysql_ssl_opts(None, "mysql://root@localhost/db?require_ssl=true", None, &files).unwrap_err();
        assert!(error.contains("ssl-key"));
    }

    #[test]
    fn mysql_tls_client_identity_requires_ssl() {
        assert!(mysql_url_requires_ssl("mysql://root@localhost/db?ssl-cert=/tmp/client.crt&ssl-key=/tmp/client.key"));
    }

    #[test]
    fn mysql_preferred_tls_attempts_ssl_without_requiring_it() {
        let url = "mysql://root@localhost/db?ssl-mode=preferred&charset=utf8mb4";

        assert!(!mysql_url_requires_ssl(url));
        assert!(mysql_url_attempts_ssl(url));
        assert_eq!(
            ssl_fallback_url(url),
            Some("mysql://root@localhost/db?ssl-mode=disabled&charset=utf8mb4".to_string())
        );
        assert!(mysql_ssl_opts(None, url, None, &MySqlTlsFiles::default()).unwrap().is_some());
    }

    #[test]
    fn mysql_preferred_tls_handles_sslmode_prefer_alias() {
        let url = "mysql://root@localhost/db?sslmode=prefer&charset=utf8mb4#session";

        assert!(!mysql_url_requires_ssl(url));
        assert!(mysql_url_attempts_ssl(url));
        assert_eq!(
            ssl_fallback_url(url),
            Some("mysql://root@localhost/db?ssl-mode=disabled&charset=utf8mb4#session".to_string())
        );
        assert_eq!(
            ssl_fallback_url("mysql://root@localhost/db#session"),
            Some("mysql://root@localhost/db?ssl-mode=disabled#session".to_string())
        );
    }

    #[test]
    fn mysql_unknown_error_can_retry_with_text_protocol() {
        let error = "error returned from database: 1105 (HY000): Unknown error";

        assert!(mysql_error_should_retry_with_text_protocol(error));
    }

    #[test]
    fn mysql_unsupported_prepare_command_can_retry_with_text_protocol() {
        let error = "ERROR PX000 (3000): [a2jupsonbbv6zai1gomo5whu36ndqy] Unsupported command: COM_STMT_PREPARE";

        assert!(mysql_error_should_retry_with_text_protocol(error));
    }

    #[test]
    fn mysql_reprepared_statement_error_can_retry_with_text_protocol() {
        let error = "Server error: ERROR HY000 (1615): Prepared statement needs to be re-prepared";

        assert!(mysql_error_should_retry_with_text_protocol(error));
    }

    #[test]
    fn mysql_group_concat_setup_error_retries_without_session_variable() {
        let error = "MySQL connection failed: Server error: `ERROR HY000 (1193): Unknown system variable,stmt:SET @@group_concat_max_len = 1048576'";

        assert_eq!(
            mysql_group_concat_setup_fallback_mode(MySqlSetupMode::Standard, error),
            Some(MySqlSetupMode::Compatible)
        );
    }

    #[test]
    fn mysql_cnch_group_concat_syntax_error_retries_without_session_variable() {
        let error = "MySQL connection failed: Server error: `ERROR HY000 (1105): unknown error: Error 62 (HY000): Code: 62, e.displayText() = DB::Exception: host = cnch-server-2: Syntax error: failed at position 13 ('group_concat_max_len'): group_concat_max_len = 1048576. Expected one of: Dot, token, Equals SQLSTATE: 42000 (version 21.8.7.1)'";

        assert_eq!(
            mysql_group_concat_setup_fallback_mode(MySqlSetupMode::Standard, error),
            Some(MySqlSetupMode::Compatible)
        );
    }

    #[test]
    fn mysql_index_metadata_query_has_expression_compatibility_fallback() {
        let with_expression = mysql_list_indexes_sql("db", "users", true);
        assert!(with_expression.contains("EXPRESSION, SEQ_IN_INDEX"));

        let without_expression = mysql_list_indexes_sql("db", "users", false);
        assert!(!without_expression.contains("EXPRESSION"));
        assert!(without_expression.contains("ORDER BY INDEX_NAME, SEQ_IN_INDEX"));
    }

    #[test]
    fn mysql_index_metadata_falls_back_only_for_unknown_expression_column() {
        let unsupported = mysql_async::Error::Server(mysql_async::ServerError {
            code: 1054,
            message: "Unknown column 'EXPRESSION'".to_string(),
            state: "42S22".to_string(),
        });
        let permission_denied = mysql_async::Error::Server(mysql_async::ServerError {
            code: 1044,
            message: "Access denied".to_string(),
            state: "42000".to_string(),
        });

        assert!(mysql_statistics_expression_is_unsupported(&unsupported));
        assert!(!mysql_statistics_expression_is_unsupported(&permission_denied));
    }

    #[test]
    fn mysql_index_metadata_accepts_drds_expression_error_only_with_matching_message() {
        let unsupported = mysql_async::Error::Server(mysql_async::ServerError {
            code: 3009,
            message: "[TDDL-4518][ERR_VALIDATE] Column 'EXPRESSION' not found".to_string(),
            state: "HY000".to_string(),
        });
        let unrelated = mysql_async::Error::Server(mysql_async::ServerError {
            code: 3009,
            message: "[TDDL-4518][ERR_VALIDATE] Column 'INDEX_NAME' not found".to_string(),
            state: "HY000".to_string(),
        });
        let wrong_state = mysql_async::Error::Server(mysql_async::ServerError {
            code: 3009,
            message: "[TDDL-4518][ERR_VALIDATE] Column 'EXPRESSION' not found".to_string(),
            state: "42S22".to_string(),
        });

        assert!(mysql_statistics_expression_is_unsupported(&unsupported));
        assert!(!mysql_statistics_expression_is_unsupported(&unrelated));
        assert!(!mysql_statistics_expression_is_unsupported(&wrong_state));
    }

    #[test]
    fn mysql_group_concat_not_supported_error_retries_without_session_variable() {
        let error =
            "MySQL connection failed: Server error: `ERROR 1235 (42000): SET of group_concat_max_len is not supported'";

        assert_eq!(
            mysql_group_concat_setup_fallback_mode(MySqlSetupMode::Standard, error),
            Some(MySqlSetupMode::Compatible)
        );
    }

    #[test]
    fn mysql_gateway_forbidden_global_variables_error_retries_without_session_variable() {
        let error = "MySQL connection failed: Server error: `ERROR 10192 (HY000): SET GLOBAL VARIABLES is forbidden'";

        assert_eq!(
            mysql_group_concat_setup_fallback_mode(MySqlSetupMode::Standard, error),
            Some(MySqlSetupMode::Compatible)
        );
    }

    #[test]
    fn mysql_gateway_setup_retry_requires_exact_error_code_and_message() {
        for error in [
            "Server error: ERROR 10192 (HY000): operation is forbidden",
            "Server error: ERROR 1227 (42000): SET GLOBAL VARIABLES is forbidden",
            "Server error: ERROR 101920 (HY000): SET GLOBAL VARIABLES is forbidden",
        ] {
            assert_eq!(mysql_group_concat_setup_fallback_mode(MySqlSetupMode::Standard, error), None);
        }
    }

    #[test]
    fn mysql_sphinxql_group_concat_boolean_error_retries_without_session_variable() {
        let error = "MySQL connection failed: Server error: `ERROR 42000 (1064): sphinxql: only 0 and 1 could be used as boolean values near '1048576'`";

        assert_eq!(
            mysql_group_concat_setup_fallback_mode(MySqlSetupMode::Standard, error),
            Some(MySqlSetupMode::Compatible)
        );
    }

    #[test]
    fn mysql_sphinxql_boolean_error_retry_stays_scoped_to_group_concat_setup() {
        for error in [
            "Server error: sphinxql: only 0 and 1 could be used as boolean values near '42'",
            "Server error: only 0 and 1 could be used as boolean values near '1048576'",
        ] {
            assert_eq!(mysql_group_concat_setup_fallback_mode(MySqlSetupMode::Standard, error), None);
        }
    }

    #[test]
    fn mysql_proxy_parse_tablename_1105_does_not_disable_group_concat() {
        let error = "MySQL connection failed: Server error: `ERROR 07000 (1105): SQL操作失败 (operate fail ) ：解析表名出错 ( parse tablename error ) '";

        assert_eq!(mysql_group_concat_setup_fallback_mode(MySqlSetupMode::Standard, error), None);
    }

    #[test]
    fn mysql_group_concat_setup_retry_is_narrow() {
        assert_eq!(
            mysql_group_concat_setup_fallback_mode(
                MySqlSetupMode::Standard,
                "MySQL connection failed: Server error: `ERROR HY000 (1193): Unknown system variable,stmt:SET @@sql_mode = ANSI'",
            ),
            None
        );
        assert_eq!(
            mysql_group_concat_setup_fallback_mode(
                MySqlSetupMode::Standard,
                "MySQL connection failed: Server error: `ERROR 07000 (1105): SQL操作失败 (operate fail)'",
            ),
            None
        );
    }

    #[test]
    fn mysql_setup_queries_select_requested_database_before_session_init() {
        let queries = mysql_setup_queries("mysql://root:secret@localhost:3306/app?charset=utf8mb4", &[]);

        assert_eq!(queries, vec!["USE `app`", "SET NAMES utf8mb4", "SET SESSION group_concat_max_len = 1048576"]);
    }

    #[test]
    fn mysql_setup_queries_skip_use_when_database_missing() {
        let queries = mysql_setup_queries("mysql://root:secret@localhost:3306?charset=utf8mb4", &[]);

        assert_eq!(queries, vec!["SET NAMES utf8mb4", "SET SESSION group_concat_max_len = 1048576"]);
    }

    #[test]
    fn mysql_compatible_setup_queries_skip_group_concat_variable() {
        let queries = mysql_setup_queries_with_mode(
            "mysql://root:secret@localhost:9030/analytics?charset=utf8mb4",
            &[],
            MySqlSetupMode::Compatible,
        );

        assert_eq!(queries, vec!["USE `analytics`", "SET NAMES utf8mb4"]);
    }

    #[test]
    fn mysql_compatible_setup_queries_leave_catalog_to_database_specific_setup() {
        let extra = vec!["SET ob_query_timeout = 30000000".to_string()];
        let queries = mysql_setup_queries_with_mode(
            "mysql://root:secret@localhost:9030/clip?catalog=paimon_catalog",
            &extra,
            MySqlSetupMode::Compatible,
        );

        assert_eq!(queries, vec!["USE `clip`", "SET NAMES utf8mb4", "SET ob_query_timeout = 30000000"]);
    }

    #[test]
    fn mysql_setup_appends_database_specific_catalog_for_reverse_execution() {
        let extra = vec!["SWITCH `paimon_catalog`".to_string()];
        let queries = mysql_setup_queries_with_mode(
            "mysql://root:secret@localhost:9030/clip?catalog=paimon_catalog",
            &extra,
            MySqlSetupMode::Compatible,
        );

        assert_eq!(queries, vec!["USE `clip`", "SET NAMES utf8mb4", "SWITCH `paimon_catalog`"]);
    }

    #[test]
    fn mysql_setup_queries_decode_database_name_from_url() {
        let queries = mysql_setup_queries("mysql://root:secret@localhost:3306/db%2Fname?charset=utf8mb4", &[]);

        assert_eq!(queries, vec!["USE `db/name`", "SET NAMES utf8mb4", "SET SESSION group_concat_max_len = 1048576"]);
    }

    #[test]
    fn mysql_setup_queries_preserve_database_identifier_whitespace() {
        let queries = mysql_setup_queries("mysql://root:secret@localhost:3306/%20analytics%20?charset=utf8mb4", &[]);

        assert_eq!(
            queries,
            vec!["USE ` analytics `", "SET NAMES utf8mb4", "SET SESSION group_concat_max_len = 1048576"]
        );
    }

    #[test]
    fn mysql_setup_queries_can_select_database_without_url_path() {
        let queries = mysql_setup_queries_for_database(
            "mysql://root:secret@localhost:3306?charset=utf8mb4",
            Some("app`proxy"),
            &[],
        );

        assert_eq!(
            queries,
            vec!["USE `app``proxy`", "SET NAMES utf8mb4", "SET SESSION group_concat_max_len = 1048576"]
        );
    }

    #[test]
    fn mysql_datetime_utc_values_display_without_rfc3339_offset() {
        let value = NaiveDateTime::new(
            NaiveDate::from_ymd_opt(2026, 5, 12).unwrap(),
            NaiveTime::from_hms_opt(0, 0, 0).unwrap(),
        );

        assert_eq!(mysql_datetime_to_string(value), "2026-05-12 00:00:00");
    }

    #[test]
    fn mysql_date_values_display_without_midnight_time() {
        let date = NaiveDate::from_ymd_opt(2026, 6, 10).unwrap();
        let datetime = date.and_hms_opt(0, 0, 0).unwrap();

        assert_eq!(
            mysql_temporal_value_to_json(ColumnType::MYSQL_TYPE_DATE, Some(datetime), Some(date), None),
            Some(serde_json::json!("2026-06-10"))
        );
    }

    #[test]
    fn mysql_datetime_values_keep_time_component() {
        let datetime = NaiveDate::from_ymd_opt(2026, 6, 10).unwrap().and_hms_opt(12, 34, 56).unwrap();

        assert_eq!(
            mysql_temporal_value_to_json(ColumnType::MYSQL_TYPE_DATETIME, Some(datetime), None, None),
            Some(serde_json::json!("2026-06-10 12:34:56"))
        );
    }

    #[tokio::test]
    #[ignore = "requires remote MariaDB with ed25519 user"]
    async fn test_ed25519_auth() {
        let url = "mysql://edtest:test123@172.26.128.159:20026/testdb";
        let pool = super::connect(url, std::time::Duration::from_secs(5)).await.expect("connect with ed25519");
        let mut conn = pool.get_conn().await.expect("get connection");
        conn.ping().await.expect("ping");
        let _ = conn.disconnect().await;
        let _ = pool.disconnect().await;
    }

    #[test]
    fn parse_connect_timeout_extracts_underscore_form() {
        let url = "mysql://host:3306/db?connect_timeout=30";
        assert_eq!(crate::db::parse_connect_timeout(url), Duration::from_secs(30));
    }

    #[test]
    fn parse_connect_timeout_extracts_camelcase_form() {
        let url = "mysql://host:3306/db?connectTimeout=60";
        assert_eq!(crate::db::parse_connect_timeout(url), Duration::from_secs(60));
    }

    #[test]
    fn parse_connect_timeout_ignores_out_of_range() {
        let default = connection_timeout();
        let url = "mysql://host:3306/db?connect_timeout=999";
        assert_eq!(crate::db::parse_connect_timeout(url), default);
        let url2 = "mysql://host:3306/db?connect_timeout=0";
        assert_eq!(crate::db::parse_connect_timeout(url2), default);
    }

    #[test]
    fn parse_connect_timeout_returns_default_when_missing() {
        let default = connection_timeout();
        let url = "mysql://host:3306/db?ssl-mode=preferred&charset=utf8mb4";
        assert_eq!(crate::db::parse_connect_timeout(url), default);
    }

    #[test]
    fn parse_connect_timeout_returns_default_when_no_query() {
        let default = connection_timeout();
        let url = "mysql://host:3306/db";
        assert_eq!(crate::db::parse_connect_timeout(url), default);
    }

    #[test]
    fn mysql_async_url_translates_standard_required_ssl_mode() {
        let url = "mysql://host:3306/db?ssl-mode=required&charset=utf8mb4";

        assert_eq!(
            mysql_async_url(url).as_ref(),
            "mysql://host:3306/db?require_ssl=true&verify_ca=false&verify_identity=false"
        );
    }

    #[test]
    fn mysql_async_url_translates_preferred_ssl_mode_to_tls_attempt() {
        let url = "mysql://host:3306/db?ssl-mode=preferred&charset=utf8mb4";

        assert_eq!(
            mysql_async_url(url).as_ref(),
            "mysql://host:3306/db?require_ssl=true&verify_ca=false&verify_identity=false"
        );
    }

    #[test]
    fn mysql_async_url_translates_disabled_ssl_mode_even_when_param_count_matches() {
        let url = "mysql://host:3306/db?ssl-mode=disabled";

        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:3306/db?require_ssl=false");
    }

    #[test]
    fn mysql_async_url_translates_verify_identity_ssl_mode_even_when_param_count_matches() {
        let url = "mysql://host:3306/db?sslmode=verify_identity";

        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:3306/db?require_ssl=true");
    }

    #[test]
    fn mysql_async_url_translates_connector_j_tls_params() {
        let url = "mysql://host:3306/db?useUnicode=true&characterEncoding=utf8&zeroDateTimeBehavior=convertToNull&useSSL=true&serverTimezone=GMT%2B8&allowPublicKeyRetrieval=true";
        assert_eq!(
            mysql_async_url(url).as_ref(),
            "mysql://host:3306/db?require_ssl=true&verify_ca=false&verify_identity=false"
        );
    }

    #[test]
    fn mysql_async_url_translates_connector_j_required_verified_tls_params() {
        let url = "mysql://host:3306/db?useSSL=true&requireSSL=true&verifyServerCertificate=true";
        assert_eq!(
            mysql_async_url(url).as_ref(),
            "mysql://host:3306/db?require_ssl=true&verify_ca=true&verify_identity=false"
        );
    }

    #[test]
    fn mysql_async_url_preserves_connector_j_tls_truth_table() {
        assert_eq!(
            mysql_async_url("mysql://host:3306/db?verifyServerCertificate=true").as_ref(),
            "mysql://host:3306/db?require_ssl=true&verify_ca=true&verify_identity=false"
        );
        assert_eq!(
            mysql_async_url("mysql://host:3306/db?useSSL=false&requireSSL=true&verifyServerCertificate=true").as_ref(),
            "mysql://host:3306/db?require_ssl=false"
        );
        assert_eq!(
            mysql_async_url("mysql://host:3306/db?requireSSL=false").as_ref(),
            "mysql://host:3306/db?require_ssl=true&verify_ca=false&verify_identity=false"
        );
    }

    #[test]
    fn mysql_async_url_uses_last_connector_j_tls_param_value() {
        assert_eq!(
            mysql_async_url("mysql://host:3306/db?useSSL=false&useSSL=true").as_ref(),
            "mysql://host:3306/db?require_ssl=true&verify_ca=false&verify_identity=false"
        );
        assert_eq!(
            mysql_async_url("mysql://host:3306/db?useSSL=true&useSSL=false&verifyServerCertificate=true").as_ref(),
            "mysql://host:3306/db?require_ssl=false"
        );
    }

    #[test]
    fn mysql_async_url_prefers_native_tls_mode_over_connector_j_aliases() {
        let url = "mysql://host:3306/db?sslMode=REQUIRED&useSSL=false&requireSSL=false";
        assert_eq!(
            mysql_async_url(url).as_ref(),
            "mysql://host:3306/db?require_ssl=true&verify_ca=false&verify_identity=false"
        );
    }

    #[test]
    fn mysql_async_url_keeps_valid_params_while_stripping_jdbc() {
        let url = "mysql://host:3306/db?useUnicode=true&characterEncoding=utf8&require_ssl=true&charset=utf8mb4&autoReconnect=true&allowMultiQueries=true";
        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:3306/db?require_ssl=true");
    }

    #[test]
    fn connector_j_preferred_tls_falls_back_but_required_tls_does_not() {
        assert_eq!(
            ssl_fallback_url("mysql://host:3306/db?useSSL=true&characterEncoding=utf8"),
            Some("mysql://host:3306/db?useSSL=true&characterEncoding=utf8&ssl-mode=disabled".to_string())
        );
        assert_eq!(ssl_fallback_url("mysql://host:3306/db?useSSL=true&requireSSL=true"), None);
        assert_eq!(ssl_fallback_url("mysql://host:3306/db?verifyServerCertificate=true"), None);
        let disabled = "mysql://host:3306/db?useSSL=false&requireSSL=true&verifyServerCertificate=true";
        assert!(!mysql_url_requires_ssl(disabled));
        assert!(!mysql_url_attempts_ssl(disabled));
    }

    #[test]
    fn mysql_async_url_accepts_reported_doris_jdbc_params() {
        let url = "mysql://host:9030/db?useLocalSessionState=true&rewriteBatchedStatements=true&prepStmtCacheSqlLimit=2048&prepStmtCacheSize=250&sessionVariables=query_timeout%3D60";

        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:9030/db");
    }

    #[test]
    fn mysql_local_infile_paths_are_explicit_and_removed_from_driver_url() {
        let url = "mysql://host:9030/db?localInfilePath=%2Ftmp%2Fone.csv&require_ssl=true&localinfilepath=C%3A%5Cdata%5Ctwo.csv";

        assert_eq!(
            mysql_local_infile_paths(url),
            vec![PathBuf::from("/tmp/one.csv"), PathBuf::from(r"C:\data\two.csv")]
        );
        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:9030/db?require_ssl=true");
    }

    #[test]
    fn mysql_local_infile_paths_ignore_empty_or_unrelated_values() {
        let url = "mysql://host:9030/db?localInfilePath=&charset=utf8mb4&other=%2Ftmp%2Fignored.csv";

        assert!(mysql_local_infile_paths(url).is_empty());
        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:9030/db?other=%2Ftmp%2Fignored.csv");
    }

    #[test]
    fn mysql_async_url_normalizes_cleartext_password_auth_alias() {
        let url = "mysql://host:3306/db?allowCleartextPasswords=true&charset=utf8mb4";
        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:3306/db?enable_cleartext_plugin=true");
    }

    #[test]
    fn mysql_async_url_deduplicates_cleartext_password_auth_params() {
        let url = "mysql://host:3306/db?allowCleartextPasswords=true&enable_cleartext_plugin=true&require_ssl=true";
        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:3306/db?require_ssl=true&enable_cleartext_plugin=true");
    }

    #[test]
    fn mysql_async_url_omits_disabled_cleartext_password_auth_params() {
        let url = "mysql://host:3306/db?allowCleartextPasswords=false&enable_cleartext_plugin=&require_ssl=true";
        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:3306/db?require_ssl=true");
    }

    #[test]
    fn mysql_async_url_strips_go_and_timezone_compat_params() {
        let url = "mysql://host:3306/db?charset=utf8mb4&parseTime=True&loc=Local&connectionTimeZone=Asia%2FShanghai&forceConnectionTimeZoneToSession=true&require_ssl=true";

        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:3306/db?require_ssl=true");
    }

    #[test]
    fn mysql_async_url_strips_database_path_when_catalog_present() {
        // With a catalog configured, the database path must not reach mysql_async
        // (it would be sent as the handshake schema and rejected before SET catalog).
        assert_eq!(
            mysql_async_url("mysql://root:secret@host:3306/clip?catalog=paimon_catalog").as_ref(),
            "mysql://root:secret@host:3306"
        );
        assert_eq!(
            mysql_async_url("mysql://host:3306/clip?catalog=paimon_catalog&require_ssl=true").as_ref(),
            "mysql://host:3306?require_ssl=true"
        );
    }

    #[test]
    fn mysql_async_url_keeps_database_path_when_catalog_absent() {
        assert_eq!(
            mysql_async_url("mysql://host:3306/clip?require_ssl=true").as_ref(),
            "mysql://host:3306/clip?require_ssl=true"
        );
        assert_eq!(mysql_async_url("mysql://host:3306/clip").as_ref(), "mysql://host:3306/clip");
    }

    #[test]
    fn ssl_fallback_does_not_disable_required_tls() {
        assert_eq!(ssl_fallback_url("mysql://host:3306/db?require_ssl=true&charset=utf8mb4"), None);
        assert_eq!(ssl_fallback_url("mysql://host:3306/db?ssl-mode=verify_ca&charset=utf8mb4"), None);
    }

    #[test]
    fn mysql_setup_queries_default_to_utf8mb4() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db", &[]),
            vec!["USE `db`", "SET NAMES utf8mb4", "SET SESSION group_concat_max_len = 1048576"]
        );
    }

    #[test]
    fn mysql_setup_queries_use_safe_custom_charset() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?ssl-mode=preferred&charset=gbk", &[]),
            vec!["USE `db`", "SET NAMES gbk", "SET SESSION group_concat_max_len = 1048576"]
        );
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?charset=utf8mb4;DROP TABLE users", &[]),
            vec!["USE `db`", "SET NAMES utf8mb4", "SET SESSION group_concat_max_len = 1048576"]
        );
    }

    #[test]
    fn mysql_setup_queries_include_extra_setup_queries() {
        let extra = vec!["SET ob_query_timeout = 30000000".to_string()];

        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db", &extra),
            vec![
                "USE `db`",
                "SET NAMES utf8mb4",
                "SET SESSION group_concat_max_len = 1048576",
                "SET ob_query_timeout = 30000000"
            ]
        );
    }

    #[test]
    fn mysql_setup_queries_apply_connector_j_session_variables() {
        assert_eq!(
            mysql_setup_queries(
                "mysql://host:9030/db?sessionVariables=query_timeout%3D60%2Csql_mode%3D%27STRICT%2CTRADITIONAL%27%3B%40trace_id%3Dconcat%28%27a%2Cb%27%2C%27c%27%29",
                &[],
            ),
            vec![
                "USE `db`",
                "SET SESSION query_timeout=60,SESSION sql_mode='STRICT,TRADITIONAL',@trace_id=concat('a,b','c')",
                "SET NAMES utf8mb4",
                "SET SESSION group_concat_max_len = 1048576",
            ]
        );
    }

    #[test]
    fn mysql_setup_queries_ignore_empty_session_variables() {
        assert_eq!(
            mysql_setup_queries("mysql://host:9030/db?sessionVariables=%20%2C%20%3B%20", &[]),
            vec!["USE `db`", "SET NAMES utf8mb4", "SET SESSION group_concat_max_len = 1048576"]
        );
    }

    #[test]
    fn mysql_setup_queries_apply_explicit_time_zone() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?time_zone=%2B08%3A00&charset=utf8mb4", &[]),
            vec![
                "USE `db`",
                "SET time_zone = '+08:00'",
                "SET NAMES utf8mb4",
                "SET SESSION group_concat_max_len = 1048576"
            ]
        );
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?time-zone=Asia%2FShanghai", &[]),
            vec![
                "USE `db`",
                "SET time_zone = 'Asia/Shanghai'",
                "SET NAMES utf8mb4",
                "SET SESSION group_concat_max_len = 1048576"
            ]
        );
    }

    #[test]
    fn mysql_setup_queries_apply_jdbc_time_zone_aliases() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?serverTimezone=GMT%2B8", &[]),
            vec![
                "USE `db`",
                "SET time_zone = '+08:00'",
                "SET NAMES utf8mb4",
                "SET SESSION group_concat_max_len = 1048576"
            ]
        );
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?connectionTimeZone=UTC", &[]),
            vec![
                "USE `db`",
                "SET time_zone = '+00:00'",
                "SET NAMES utf8mb4",
                "SET SESSION group_concat_max_len = 1048576"
            ]
        );
    }

    #[test]
    fn mysql_setup_queries_apply_go_loc_when_no_explicit_time_zone_exists() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?loc=Asia%2FShanghai", &[]),
            vec![
                "USE `db`",
                "SET time_zone = 'Asia/Shanghai'",
                "SET NAMES utf8mb4",
                "SET SESSION group_concat_max_len = 1048576"
            ]
        );
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?time_zone=%2B08%3A00&loc=UTC", &[]),
            vec![
                "USE `db`",
                "SET time_zone = '+08:00'",
                "SET NAMES utf8mb4",
                "SET SESSION group_concat_max_len = 1048576"
            ]
        );
    }

    #[test]
    fn mysql_setup_queries_ignore_unsafe_time_zone_values() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?time_zone=%2B08%3A00%27%3BDROP%20TABLE%20users", &[]),
            vec!["USE `db`", "SET NAMES utf8mb4", "SET SESSION group_concat_max_len = 1048576"]
        );
    }

    #[test]
    fn catalog_setup_query_for_url_uses_database_specific_syntax() {
        assert_eq!(
            catalog_setup_query_for_url(MySqlCatalogDialect::Doris, "mysql://host:3306/clip?catalog=paimon_catalog"),
            Some("SWITCH `paimon_catalog`".to_string())
        );
        assert_eq!(
            catalog_setup_query_for_url(
                MySqlCatalogDialect::StarRocks,
                "mysql://host:3306/clip?catalog=paimon_catalog"
            ),
            Some("SET CATALOG `paimon_catalog`".to_string())
        );
        assert_eq!(
            catalog_setup_query_for_url(MySqlCatalogDialect::Doris, "mysql://host:3306/db?catalog=my%5Fcatalog"),
            Some("SWITCH `my_catalog`".to_string())
        );
    }

    #[test]
    fn mysql_setup_queries_omits_catalog_when_absent() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?charset=utf8mb4", &[]),
            vec!["USE `db`", "SET NAMES utf8mb4", "SET SESSION group_concat_max_len = 1048576"]
        );
    }

    #[tokio::test]
    #[ignore = "requires a live ShardingSphere Proxy 5.3.0 fixture"]
    async fn live_shardingsphere_proxy_preserves_binary_columns() {
        let url = std::env::var("DBX_MYSQL_SHARDING_PROXY_URL")
            .expect("DBX_MYSQL_SHARDING_PROXY_URL must point to the live proxy fixture");
        let opts = mysql_async::Opts::from_url(&url).expect("valid MySQL proxy URL");
        let pool = mysql_async::Pool::new(opts);

        let columns =
            get_columns(&pool, "dbx_sharding_proxy_test", "binary_samples").await.expect("load proxy column metadata");
        let result = execute_query_with_max_rows(
            &pool,
            "SELECT id, fixed_value, variable_value, char_value, text_value, binary_collated \
             FROM binary_samples ORDER BY id LIMIT 100",
            false,
            Some(100),
            MySqlQueryDialect::default(),
        )
        .await
        .expect("query proxy binary fixture");
        pool.disconnect().await.expect("disconnect proxy pool");

        assert_eq!(
            columns.iter().map(|column| column.data_type.as_str()).collect::<Vec<_>>(),
            vec!["int", "binary(8)", "varbinary(32)", "char(8)", "varchar(32)", "varchar(32)"]
        );
        assert_eq!(result.column_types, vec!["int", "binary", "varbinary", "char", "varchar", "varchar"]);
        assert_eq!(
            result.rows,
            vec![
                vec![
                    serde_json::json!("1"),
                    serde_json::json!("0x3135303031300000"),
                    serde_json::json!("0x534e2d4130303031"),
                    serde_json::json!("CHAR-001"),
                    serde_json::json!("TEXT-001"),
                    serde_json::json!("BIN-TEXT-001"),
                ],
                vec![
                    serde_json::json!("2"),
                    serde_json::json!("0xdeadbeef00000000"),
                    serde_json::json!("0xdeadbeef"),
                    serde_json::json!("CHAR-002"),
                    serde_json::json!("TEXT-002"),
                    serde_json::json!("BIN-TEXT-002"),
                ],
                vec![
                    serde_json::json!("3"),
                    serde_json::json!("0x0000000000000000"),
                    serde_json::json!("0x"),
                    serde_json::json!("CHAR-003"),
                    serde_json::json!("TEXT-003"),
                    serde_json::json!("BIN-TEXT-003"),
                ],
                vec![
                    serde_json::json!("4"),
                    serde_json::json!("0x7f80810000000000"),
                    serde_json::json!("0x7f8081"),
                    serde_json::json!("CHAR-004"),
                    serde_json::json!("TEXT-004"),
                    serde_json::json!("BIN-TEXT-004"),
                ],
            ]
        );
    }
}
