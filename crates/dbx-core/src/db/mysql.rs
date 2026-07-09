use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use futures::StreamExt;
use mysql_async::consts::ColumnType;
use mysql_async::prelude::*;
use percent_encoding::percent_decode_str;
use rust_decimal::Decimal;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::models::connection::DatabaseType;
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{
    ColumnInfo, CompletionAssistantCandidate, CompletionAssistantCandidateKind, CompletionAssistantMatchMode,
    CompletionAssistantObjectKind, CompletionAssistantRequest, CompletionAssistantResponse, DatabaseInfo,
    ForeignKeyInfo, IndexInfo, ObjectInfo, ObjectStatistics, QueryResult, TableInfo, TriggerInfo,
};

use super::file_validator::validate_file_path;

pub type MySqlPool = mysql_async::Pool;
const MYSQL_TCP_KEEPALIVE_MS: u32 = 30_000;

#[derive(Clone, Copy, Debug, Default)]
pub struct MySqlQueryDialect {
    supports_admin_show_results: bool,
}

impl MySqlQueryDialect {
    pub fn for_connection(db_type: DatabaseType, driver_profile: Option<&str>) -> Self {
        let profile = driver_profile.map(str::to_ascii_lowercase);
        Self {
            supports_admin_show_results: matches!(
                db_type,
                DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::ManticoreSearch
            ) || profile
                .as_deref()
                .is_some_and(|profile| matches!(profile, "doris" | "selectdb" | "starrocks" | "manticoresearch")),
        }
    }
}

pub enum MySqlQueryStreamItem {
    Columns { columns: Vec<String>, column_types: Vec<String> },
    Row(Vec<serde_json::Value>),
}

fn quote_value(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn quote_identifier(s: &str) -> String {
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

/// First non-empty string value among the named columns (e.g. Doris `CatalogName`
/// vs StarRocks `Catalog`). Returns an empty string when none of the columns
/// are present or all are empty.
fn first_nonempty_str_by_name(row: &mysql_async::Row, names: &[&str]) -> String {
    for name in names {
        let value = get_str_by_name(row, name);
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

fn get_opt_metadata_string(row: &mysql_async::Row, name: &str) -> Option<String> {
    get_opt_str(row, name)
        .or_else(|| row_get::<NaiveDateTime, _>(row, name).map(|value| value.to_string()))
        .or_else(|| row_get::<NaiveDate, _>(row, name).map(|value| value.to_string()))
        .or_else(|| row_get::<NaiveTime, _>(row, name).map(|value| value.to_string()))
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
    is_mysql_binary_charset(column)
        && matches!(
            column.column_type(),
            ColumnType::MYSQL_TYPE_STRING | ColumnType::MYSQL_TYPE_VAR_STRING | ColumnType::MYSQL_TYPE_VARCHAR
        )
}

fn mysql_printable_binary_preview(bytes: &[u8]) -> Option<String> {
    let trimmed = bytes.strip_suffix(&[0]).map_or(bytes, |mut value| {
        while let Some(rest) = value.strip_suffix(&[0]) {
            value = rest;
        }
        value
    });
    if trimmed.is_empty() {
        return Some(String::new());
    }

    let text = std::str::from_utf8(trimmed).ok()?;
    text.chars().all(|ch| !ch.is_control() || matches!(ch, '\t' | '\n' | '\r')).then(|| text.to_string())
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
        return mysql_printable_binary_preview(&bytes)
            .map(serde_json::Value::String)
            .unwrap_or_else(|| super::binary_value_to_json(&bytes));
    }
    serde_json::Value::String(String::from_utf8_lossy(&bytes).to_string())
}

/// Map a MySQL column to a user-facing type name for the result-grid header.
/// Returns the bare lowercase type name (no length/precision/signedness), which
/// is enough for display; unknown variants fall back to a lowercased debug name.
pub(crate) fn mysql_column_type_name(ty: ColumnType) -> String {
    use mysql_async::consts::ColumnType::*;
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
        MYSQL_TYPE_TINY_BLOB => "tinyblob",
        MYSQL_TYPE_MEDIUM_BLOB => "mediumblob",
        MYSQL_TYPE_LONG_BLOB => "longblob",
        MYSQL_TYPE_BLOB => "blob",
        MYSQL_TYPE_VARCHAR | MYSQL_TYPE_VAR_STRING => "varchar",
        MYSQL_TYPE_STRING => "char",
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
                        // MySQL prefixes geometry WKB with a 4-byte SRID.
                        // Strip it before passing to the WKB parser.
                        let wkb = if bytes.len() >= 4 { &bytes[4..] } else { &bytes };
                        super::wkb::wkb_to_wkt(wkb)
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
    let pool = create_pool(
        url,
        ca_cert_path,
        max_connections,
        idle_timeout_secs,
        setup_database,
        extra_setup_queries,
        setup_mode,
    )?;
    let result = verify_pool_connection_with_setup_fallback(
        pool,
        timeout,
        url,
        ca_cert_path,
        max_connections,
        idle_timeout_secs,
        setup_database,
        extra_setup_queries,
        setup_mode,
    )
    .await;

    if let Err(ref e) = result {
        if mysql_error_should_retry_without_ssl(e) {
            if let Some(fallback_url) = ssl_fallback_url(url) {
                log::info!("SSL handshake failed, retrying with ssl-mode=disabled");
                let fallback_pool = create_pool(
                    &fallback_url,
                    None,
                    max_connections,
                    idle_timeout_secs,
                    setup_database,
                    extra_setup_queries,
                    setup_mode,
                )?;
                return verify_pool_connection_with_setup_fallback(
                    fallback_pool,
                    timeout,
                    &fallback_url,
                    None,
                    max_connections,
                    idle_timeout_secs,
                    setup_database,
                    extra_setup_queries,
                    setup_mode,
                )
                .await;
            }
        }
    }

    result
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

impl MySqlSetupMode {
    fn set_group_concat_max_len(self) -> bool {
        self == Self::Standard
    }
}

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
) -> Result<MySqlPool, String> {
    match verify_pool_connection(&pool, timeout).await {
        Ok(()) => Ok(pool),
        Err(err) => {
            let Some(fallback_mode) = mysql_setup_mode_retry_without_group_concat(setup_mode, &err) else {
                return Err(err);
            };
            log::info!(
                "MySQL server rejected optional group_concat_max_len setup; retrying without that session setting"
            );
            let fallback_pool = create_pool(
                url,
                ca_cert_path,
                max_connections,
                idle_timeout_secs,
                setup_database,
                extra_setup_queries,
                fallback_mode,
            )?;
            verify_pool_connection(&fallback_pool, timeout).await.map(|_| fallback_pool)
        }
    }
}

fn mysql_setup_mode_retry_without_group_concat(setup_mode: MySqlSetupMode, error: &str) -> Option<MySqlSetupMode> {
    // group_concat_max_len improves real MySQL metadata reads, but some MySQL-compatible proxies reject the variable.
    if setup_mode.set_group_concat_max_len() && mysql_error_should_retry_without_group_concat_max_len(error) {
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
) -> Result<MySqlPool, String> {
    let tls_url = mysql_tls_url(url)?;
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
        .tcp_keepalive(Some(MYSQL_TCP_KEEPALIVE_MS))
        .setup(setup_queries);
    if let Some(ssl_opts) = mysql_ssl_opts(base_ssl_opts, url, ca_cert_path, &tls_url.files)? {
        builder = builder.ssl_opts(ssl_opts);
    }
    Ok(MySqlPool::new(builder))
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
    let catalog = mysql_connection_catalog(url);
    let database = setup_database.map(ToOwned::to_owned).or_else(|| mysql_connection_database(url));
    let mut queries = Vec::new();
    if let Some(database) = database.as_deref() {
        queries.push(format!("USE {}", quote_identifier(database)));
    }
    if let Some(time_zone) = mysql_connection_time_zone(url) {
        queries.push(format!("SET time_zone = {}", quote_value(&time_zone)));
    }
    queries.push(format!("SET NAMES {charset}"));
    // MySQL defaults group_concat_max_len to 1024, which silently truncates
    // GROUP_CONCAT results. Skip it for MySQL protocol-compatible databases
    // such as old StarRocks versions that reject unknown MySQL variables.
    if setup_mode.set_group_concat_max_len() {
        queries.push("SET @@group_concat_max_len = 1048576".to_string());
    }
    // StarRocks/Doris expose external storage (Paimon, Hive, ...) through a
    // catalog. `SET catalog` must run *before* `USE <database>` (the database
    // lives in the external catalog and is unknown to the default one).
    // mysql_async drains the setup list back-to-front (Vec::pop), so push it
    // last to make it execute first. The handshake does not send the database
    // as schema (see `mysql_async_url`, which strips the path when a catalog is
    // configured), so the connection establishes in the default catalog and
    // this setup query is what switches it. The pool re-runs these queries
    // after every connection reset, so the catalog stays current.
    if let Some(catalog) = catalog.as_deref() {
        queries.push(format!("SET catalog = {}", quote_identifier(catalog)));
    }
    queries.extend(extra_setup_queries.iter().cloned());
    queries
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

    let previous = match conn.query_first::<u8, _>("SELECT @@SESSION.explicit_defaults_for_timestamp").await {
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
/// and instead emits `SET catalog = <name>` during connection setup. This is
/// how StarRocks/Doris connections reach an external catalog such as Paimon.
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

fn mysql_error_should_retry_without_group_concat_max_len(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("group_concat_max_len") && (lower.contains("1193") || lower.contains("unknown system variable"))
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
    query.split('&').any(|segment| {
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
    })
}

fn mysql_url_attempts_ssl(url: &str) -> bool {
    if mysql_url_requires_ssl(url) {
        return true;
    }

    let Some((_, query)) = url.split_once('?') else {
        return false;
    };
    query.split('&').any(|segment| {
        let Some((key, value)) = segment.split_once('=') else {
            return false;
        };
        let key = key.trim();
        let value = value.trim();
        (key.eq_ignore_ascii_case("ssl-mode") || key.eq_ignore_ascii_case("sslmode"))
            && matches!(value.to_ascii_lowercase().replace('-', "_").as_str(), "preferred" | "prefer")
    })
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
/// reject an external-catalog database before `SET catalog` runs in setup).
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
    let pool =
        create_pool(url, None, max_connections, None, setup_database, extra_setup_queries, MySqlSetupMode::Compatible)?;
    verify_pool_connection(&pool, timeout).await.map(|_| pool)
}

pub async fn list_databases(pool: &MySqlPool) -> Result<Vec<DatabaseInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = match conn.query_iter("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME").await
    {
        Ok(result) => result,
        Err(err) => {
            log::debug!("Falling back to SHOW DATABASES after information_schema.SCHEMATA failed: {err}");
            return list_databases_show(pool).await;
        }
    };
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let databases = database_infos_from_names(rows.iter().map(|row| get_str(row, 0)), false);

    if databases.is_empty() {
        log::debug!("Falling back to SHOW DATABASES after information_schema.SCHEMATA returned no named databases");
        return list_databases_show(pool).await;
    }

    Ok(databases)
}

pub async fn list_databases_show(pool: &MySqlPool) -> Result<Vec<DatabaseInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = conn.query_iter("SHOW DATABASES").await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    Ok(database_infos_from_names(rows.iter().map(|row| get_str(row, 0)), true))
}

fn database_infos_from_names(
    names: impl IntoIterator<Item = String>,
    include_catalogless_when_blank: bool,
) -> Vec<DatabaseInfo> {
    let mut saw_row = false;
    let mut databases: Vec<DatabaseInfo> = names
        .into_iter()
        .filter_map(|name| {
            saw_row = true;
            let name = name.trim().to_string();
            (!name.is_empty()).then_some(DatabaseInfo { name })
        })
        .collect();
    databases.sort_by(|a, b| a.name.cmp(&b.name));
    if databases.is_empty() && saw_row && include_catalogless_when_blank {
        return vec![DatabaseInfo { name: String::new() }];
    }
    databases
}

pub async fn list_tables(pool: &MySqlPool, database: &str) -> Result<Vec<TableInfo>, String> {
    list_tables_filtered(pool, database, None, None, None, None).await
}

pub async fn list_tables_filtered(
    pool: &MySqlPool,
    database: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
) -> Result<Vec<TableInfo>, String> {
    let sql = list_tables_sql(database, filter, limit, offset, object_types);
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = match conn.query_iter(&sql).await {
        Ok(result) => result,
        Err(err) => {
            log::debug!(
                "Falling back to SHOW TABLES for database `{database}` after information_schema.TABLES failed: {err}"
            );
            return list_tables_show(pool, database)
                .await
                .map(|tables| filter_list_tables_fallback(tables, filter, limit, offset, object_types));
        }
    };
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    let tables: Vec<TableInfo> = rows
        .iter()
        .filter_map(|row| {
            let name = get_str_by_name(row, "TABLE_NAME").trim().to_string();
            (!name.is_empty()).then_some(TableInfo {
                name,
                table_type: get_str_by_name(row, "TABLE_TYPE"),
                comment: get_opt_str(row, "TABLE_COMMENT")
                    .map(|s| fix_potential_double_encoding(&s))
                    .filter(|s| !s.is_empty()),
                parent_schema: None,
                parent_name: None,
            })
        })
        .collect();

    if tables.is_empty() && should_fallback_empty_list_tables(filter) {
        log::debug!("Falling back to SHOW TABLES for database `{database}` after information_schema.TABLES returned no named tables");
        return list_tables_show(pool, database)
            .await
            .map(|tables| filter_list_tables_fallback(tables, filter, limit, offset, object_types));
    }

    Ok(tables)
}

fn should_fallback_empty_list_tables(filter: Option<&str>) -> bool {
    // MySQL proxies such as MyCat can return an empty information_schema.TABLES
    // even when SHOW TABLES exposes objects. Avoid the fallback for active
    // searches so normal MySQL "no match" queries do not rescan large schemas.
    !filter.is_some_and(|filter| !filter.trim().is_empty())
}

fn filter_list_tables_fallback(
    tables: Vec<TableInfo>,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
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
            (true, false) => sql.push_str(" AND TABLE_TYPE <> 'VIEW'"),
            (false, true) => sql.push_str(" AND TABLE_TYPE = 'VIEW'"),
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
    sql.push_str(" ORDER BY TABLE_NAME");
    if let Some(limit) = limit {
        sql.push_str(&format!(" LIMIT {}", limit));
    }
    if let Some(offset) = offset.filter(|offset| *offset > 0) {
        sql.push_str(&format!(" OFFSET {}", offset));
    }
    sql
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
struct TableStatusMeta {
    comment: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

async fn list_table_status_show(pool: &MySqlPool, database: &str) -> Result<HashMap<String, TableStatusMeta>, String> {
    let sql = if database.trim().is_empty() {
        "SHOW TABLE STATUS".to_string()
    } else {
        format!("SHOW TABLE STATUS FROM {}", quote_identifier(database))
    };
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
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
                },
            )
        })
        .filter(|(name, _)| !name.is_empty())
        .collect())
}

async fn list_table_names_show(pool: &MySqlPool, database: &str) -> Result<Vec<TableInfo>, String> {
    let sql = show_tables_sql(database, true);
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let rows: Vec<mysql_async::Row> = match conn.query_iter(&sql).await {
        Ok(result) => result.collect_and_drop().await.map_err(|e| e.to_string())?,
        Err(_) => {
            let sql = show_tables_sql(database, false);
            let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
            result.collect_and_drop().await.map_err(|e| e.to_string())?
        }
    };
    let mut tables: Vec<TableInfo> = rows
        .iter()
        .filter_map(|row| {
            let name = get_str(row, 0).trim().to_string();
            if name.is_empty() {
                return None;
            }
            let table_type = get_str(row, 1);
            Some(TableInfo {
                name,
                table_type: if table_type.is_empty() { "TABLE".to_string() } else { table_type },
                comment: None,
                parent_schema: None,
                parent_name: None,
            })
        })
        .collect();
    tables.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tables)
}

fn show_tables_sql(database: &str, full: bool) -> String {
    let prefix = if full { "SHOW FULL TABLES" } else { "SHOW TABLES" };
    if database.trim().is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix} FROM {}", quote_identifier(database))
    }
}

async fn list_tables_show_with_status(
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

pub async fn list_tables_show(pool: &MySqlPool, database: &str) -> Result<Vec<TableInfo>, String> {
    list_tables_show_with_status(pool, database).await.map(|(tables, _)| tables)
}

fn list_tables_objects_sql(database: &str) -> String {
    format!(
        "SELECT TABLE_NAME AS object_name, \
           CASE WHEN TABLE_TYPE = 'VIEW' THEN 'VIEW' ELSE 'TABLE' END AS object_type, \
           TABLE_COMMENT AS object_comment, \
           CREATE_TIME AS created_at, \
           UPDATE_TIME AS updated_at, \
           NULL AS parent_schema, NULL AS parent_name, \
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
           NULL AS parent_schema, NULL AS parent_name, \
           CASE WHEN ROUTINE_TYPE = 'PROCEDURE' THEN 2 ELSE 3 END AS sort_order \
         FROM information_schema.ROUTINES \
         WHERE ROUTINE_SCHEMA = {db} AND ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION') \
         ORDER BY sort_order, object_name",
        db = quote_value(database),
    )
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
        signature: None,
        comment: get_opt_str(row, "object_comment")
            .map(|s| fix_potential_double_encoding(&s))
            .filter(|s| !s.is_empty()),
        created_at: get_opt_str(row, "created_at"),
        updated_at: get_opt_str(row, "updated_at"),
        parent_schema: get_opt_str(row, "parent_schema"),
        parent_name: get_opt_str(row, "parent_name"),
    }
}

pub async fn list_objects(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;

    let tables_sql = list_tables_objects_sql(database);
    let result = match conn.query_iter(&tables_sql).await {
        Ok(result) => result,
        Err(err) => {
            log::debug!(
                "Falling back to SHOW TABLES for object browser database `{database}` after information_schema.TABLES failed: {err}"
            );
            return list_table_objects_show(pool, database).await;
        }
    };
    let table_rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    if table_rows.is_empty() {
        log::debug!(
            "Falling back to SHOW TABLES for object browser database `{database}` after information_schema.TABLES returned no named tables"
        );
        return list_table_objects_show(pool, database).await;
    }
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
    let mut objects: Vec<ObjectInfo> = tables
        .into_iter()
        .map(|table| {
            let meta = status.get(&table.name);
            ObjectInfo {
                name: table.name,
                object_type: if table.table_type.eq_ignore_ascii_case("VIEW") { "VIEW" } else { "TABLE" }.to_string(),
                schema: Some(database.to_string()),
                signature: None,
                comment: table.comment,
                created_at: meta.and_then(|meta| meta.created_at.clone()),
                updated_at: meta.and_then(|meta| meta.updated_at.clone()),
                parent_schema: table.parent_schema,
                parent_name: table.parent_name,
            }
        })
        .collect();

    match routines {
        Ok(routines) => objects.extend(routines),
        Err(err) => log::warn!("Skipping routines for database `{}` in object browser: {}", database, err),
    }

    Ok(objects)
}

async fn list_routine_objects(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let routines_sql = list_routines_sql(database);
    let result = conn.query_iter(&routines_sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| row_to_object(row, database)).collect())
}

pub async fn list_completion_objects(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let mut objects = Vec::new();

    let routines_sql = list_routines_sql(database);
    match conn.query_iter(&routines_sql).await {
        Ok(result) => match result.collect_and_drop::<mysql_async::Row>().await {
            Ok(rows) => objects.extend(rows.iter().map(|row| row_to_object(row, database))),
            Err(e) => log::warn!("Skipping routines for completion in database `{}`: {}", database, e),
        },
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
    format!(
        "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.EXTRA, \
         c.COLUMN_COMMENT, c.COLUMN_KEY, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.CHARACTER_MAXIMUM_LENGTH, \
         FROM information_schema.COLUMNS c \
         WHERE c.TABLE_SCHEMA = {} AND c.TABLE_NAME = {} \
         ORDER BY c.ORDINAL_POSITION",
        quote_value(database),
        quote_value(table),
    )
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
fn fix_potential_double_encoding(s: &str) -> String {
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

pub async fn get_columns(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
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

    let columns: Vec<ColumnInfo> = rows
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
                name,
                data_type: column_type,
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
            })
        })
        .collect();

    if columns.is_empty() {
        log::debug!(
            "Falling back to SHOW COLUMNS for `{database}`.`{table}` after information_schema.COLUMNS returned no named columns"
        );
        return get_columns_show(pool, database, table).await;
    }

    Ok(columns)
}

pub async fn get_columns_show(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
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
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = get_str_by_name(row, "Field").trim().to_string();
            if name.is_empty() {
                return None;
            }
            let key = get_str_by_name(row, "Key");
            Some(ColumnInfo {
                name,
                data_type: get_str_by_name(row, "Type"),
                is_nullable: get_str_by_name(row, "Null").eq_ignore_ascii_case("YES"),
                column_default: get_opt_str(row, "Default"),
                is_primary_key: key.eq_ignore_ascii_case("PRI"),
                extra: get_opt_str(row, "Extra"),
                comment: get_opt_str(row, "Comment")
                    .map(|s| fix_potential_double_encoding(&s))
                    .filter(|s| !s.is_empty()),
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
                enum_values: None,
            })
        })
        .collect())
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

fn mysql_keyword_at(sql: &str, i: usize, keyword: &str) -> bool {
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

fn is_mysql_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$')
}

fn skip_mysql_quoted(sql: &str, start: usize, quote: u8) -> usize {
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
pub async fn get_conn_with_health_check(pool: &MySqlPool) -> Result<mysql_async::Conn, String> {
    get_conn_with_health_check_with_timeout(pool, super::connection_timeout()).await
}

pub async fn get_conn_with_health_check_with_timeout(
    pool: &MySqlPool,
    timeout: Duration,
) -> Result<mysql_async::Conn, String> {
    get_conn_with_health_check_with_cancel(pool, timeout, timeout, None).await
}

pub async fn get_conn_with_health_check_with_cancel(
    pool: &MySqlPool,
    timeout: Duration,
    cleanup_timeout: Duration,
    cancel_token: Option<&CancellationToken>,
) -> Result<mysql_async::Conn, String> {
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

async fn get_conn_with_timeout_and_cancel(
    pool: &MySqlPool,
    timeout: Duration,
    cancel_token: Option<&CancellationToken>,
) -> Result<mysql_async::Conn, String> {
    let get_future = async {
        tokio::time::timeout(timeout, pool.get_conn())
            .await
            .map_err(|_| "MySQL get connection timed out".to_string())?
            .map_err(|e| e.to_string())
    };

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

pub async fn get_conn_with_timeout(pool: &MySqlPool, timeout: Duration) -> Result<mysql_async::Conn, String> {
    tokio::time::timeout(timeout, pool.get_conn())
        .await
        .map_err(|_| "MySQL get connection timed out".to_string())?
        .map_err(|e| e.to_string())
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

async fn execute_result_set_with_text_protocol_on_conn(
    conn: &mut mysql_async::Conn,
    sql: &str,
    row_limit: usize,
    max_rows: Option<usize>,
    start: Instant,
) -> Result<QueryResult, String> {
    let mut result = conn.query_iter(sql).await.map_err(|e| e.to_string())?;
    if !advance_to_result_set_with_columns(&mut result).await? {
        return Ok(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![],
            affected_rows: result.affected_rows(),
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        });
    }
    let columns: Vec<String> = result.columns_ref().iter().map(|c| c.name_str().to_string()).collect();
    let column_types: Vec<String> =
        result.columns_ref().iter().map(|c| mysql_column_type_name(c.column_type())).collect();

    if should_collect_text_result_set(sql, row_limit, max_rows) {
        let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
        let truncated = rows.len() > row_limit;
        let result_rows = rows
            .iter()
            .take(row_limit)
            .map(|row| (0..row.len()).map(|i| mysql_value_to_json(row, i)).collect())
            .collect();

        return Ok(QueryResult {
            columns,
            column_types,
            column_sortables: vec![],
            rows: result_rows,
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated,
            session_id: None,
            has_more: false,
        });
    }

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
        column_types,
        column_sortables: vec![],
        rows: result_rows,
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        session_id: None,
        has_more: false,
    })
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
    start: Instant,
) -> Result<QueryResult, String> {
    let mut result = conn.exec_iter(sql, ()).await.map_err(|e| e.to_string())?;
    let columns: Vec<String> = result.columns_ref().iter().map(|c| c.name_str().to_string()).collect();
    let column_types: Vec<String> =
        result.columns_ref().iter().map(|c| mysql_column_type_name(c.column_type())).collect();

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
        column_types,
        column_sortables: vec![],
        rows: result_rows,
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        session_id: None,
        has_more: false,
    })
}

pub async fn execute_query(pool: &MySqlPool, sql: &str, bare: bool) -> Result<QueryResult, String> {
    execute_query_with_max_rows(pool, sql, bare, None, MySqlQueryDialect::default()).await
}

pub async fn execute_query_with_max_rows(
    pool: &MySqlPool,
    sql: &str,
    bare: bool,
    max_rows: Option<usize>,
    dialect: MySqlQueryDialect,
) -> Result<QueryResult, String> {
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
    stream_query_result_on_conn(&mut conn, sql, bare, max_rows, dialect, cancelled, |item| {
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
    mut on_item: impl FnMut(MySqlQueryStreamItem) -> Result<(), String>,
) -> Result<u64, String> {
    let row_limit = max_rows.unwrap_or(usize::MAX);

    if bare || prefers_text_protocol_query(sql, dialect) {
        stream_query_result_text(conn, sql, row_limit, cancelled, &mut on_item).await
    } else {
        match stream_query_result_prepared(conn, sql, row_limit, cancelled, &mut on_item).await {
            Ok(rows) => Ok(rows),
            Err(err) if mysql_error_should_retry_with_text_protocol(&err) => {
                stream_query_result_text(conn, sql, row_limit, cancelled, &mut on_item).await
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
    on_item: &mut impl FnMut(MySqlQueryStreamItem) -> Result<(), String>,
) -> Result<u64, String> {
    let mut result = conn.query_iter(sql).await.map_err(|e| e.to_string())?;
    if !advance_to_result_set_with_columns(&mut result).await? {
        return Ok(0);
    }
    let columns: Vec<String> = result.columns_ref().iter().map(|c| c.name_str().to_string()).collect();
    let column_types: Vec<String> =
        result.columns_ref().iter().map(|c| mysql_column_type_name(c.column_type())).collect();
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
        let values: Vec<serde_json::Value> = (0..row.len()).map(|i| mysql_value_to_json(&row, i)).collect();
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
    on_item: &mut impl FnMut(MySqlQueryStreamItem) -> Result<(), String>,
) -> Result<u64, String> {
    let mut result = conn.exec_iter(sql, ()).await.map_err(|e| e.to_string())?;
    let columns: Vec<String> = result.columns_ref().iter().map(|c| c.name_str().to_string()).collect();
    if columns.is_empty() {
        return Ok(0);
    }
    let column_types: Vec<String> =
        result.columns_ref().iter().map(|c| mysql_column_type_name(c.column_type())).collect();
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
        let values: Vec<serde_json::Value> = (0..row.len()).map(|i| mysql_value_to_json(&row, i)).collect();
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
    let start = Instant::now();
    let row_limit = query_result_row_limit(max_rows);

    if is_result_set_query(sql, dialect) {
        if bare || prefers_text_protocol_query(sql, dialect) {
            execute_result_set_with_text_protocol_on_conn(conn, sql, row_limit, max_rows, start).await
        } else {
            match execute_result_set_with_prepared_protocol_on_conn(conn, sql, row_limit, start).await {
                Ok(result) => Ok(result),
                Err(err) if mysql_error_should_retry_with_text_protocol(&err) => {
                    execute_result_set_with_text_protocol_on_conn(conn, sql, row_limit, max_rows, start).await
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
        let drop_result = result.drop_result().await;
        restore_explicit_timestamp_defaults_for_query(conn, previous_explicit_timestamp_defaults).await;
        drop_result.map_err(|e| e.to_string())?;

        Ok(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![],
            affected_rows,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

fn prefers_text_protocol_query(sql: &str, dialect: MySqlQueryDialect) -> bool {
    // User-entered result-set queries are not parameterized in DBX. Text protocol
    // avoids binary result decoding bugs in MySQL-compatible servers and proxies.
    is_result_set_query(sql, dialect) || requires_text_protocol_query(sql, dialect)
}

fn is_result_set_query(sql: &str, dialect: MySqlQueryDialect) -> bool {
    starts_with_executable_sql_keyword(sql, &["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH", "CALL"])
        || dialect.supports_admin_show_results && is_admin_show_query(sql)
}

fn requires_text_protocol_query(sql: &str, dialect: MySqlQueryDialect) -> bool {
    if dialect.supports_admin_show_results && is_admin_show_query(sql) {
        return true;
    }

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

pub async fn list_indexes(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let sql = format!(
        "SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns, \
         MIN(NON_UNIQUE) = 0 AS is_unique, INDEX_NAME = 'PRIMARY' AS is_primary, \
         INDEX_TYPE, MAX(NULLIF(INDEX_COMMENT, '')) AS INDEX_COMMENT \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} \
         GROUP BY INDEX_NAME, INDEX_TYPE \
         ORDER BY INDEX_NAME",
        quote_value(database),
        quote_value(table),
    );
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
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
                comment: get_opt_str(row, "INDEX_COMMENT").filter(|value| !value.is_empty()),
            }
        })
        .collect())
}

pub async fn list_doris_family_indexes(
    pool: &MySqlPool,
    database: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let statistics_result = list_indexes(pool, database, table).await;
    let mut indexes = match &statistics_result {
        Ok(indexes) => indexes.clone(),
        Err(err) => {
            log::debug!(
                "Falling back to SHOW CREATE TABLE for Doris-family indexes on `{database}`.`{table}` after information_schema.STATISTICS failed: {err}"
            );
            Vec::new()
        }
    };

    match show_create_table_ddl(pool, database, table).await {
        Ok(ddl) => {
            merge_index_infos(&mut indexes, doris_indexes_from_create_table_ddl(&ddl));
            Ok(indexes)
        }
        Err(ddl_err) => {
            if indexes.is_empty() {
                if let Err(statistics_err) = statistics_result {
                    return Err(format!(
                        "{statistics_err}; SHOW CREATE TABLE fallback failed for Doris-family indexes: {ddl_err}"
                    ));
                }
            }
            Ok(indexes)
        }
    }
}

pub async fn show_create_table_ddl(pool: &MySqlPool, database: &str, table: &str) -> Result<String, String> {
    let sql = format!("SHOW CREATE TABLE {}", quote_table_ref(database, table));
    let mut conn = get_conn_with_health_check(pool).await?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let row = rows.first().ok_or("DDL not found")?;
    row.get_opt::<String, usize>(1)
        .and_then(|result| result.ok())
        .or_else(|| {
            row.get_opt::<Vec<u8>, usize>(1)
                .and_then(|result| result.ok())
                .map(|b| String::from_utf8_lossy(&b).to_string())
        })
        .ok_or_else(|| "Failed to read DDL".to_string())
}

// ---------------------------------------------------------------------------
// Doris / StarRocks multi-catalog support.
//
// These engines expose external catalogs (iceberg, hive, jdbc, ...) alongside
// the native `internal` catalog via `SHOW CATALOGS`. The functions below address
// objects in a specific catalog using 3-part qualified names
// (`<catalog>.<database>.<table>`), which the engines accept directly without
// needing to `SWITCH` the session catalog.
// ---------------------------------------------------------------------------

/// Build a 2-part qualified identifier `` `<catalog>`.`<database>` ``.
fn doris_catalog_database_ref(catalog: &str, database: &str) -> String {
    format!("{}.{}", quote_identifier(catalog), quote_identifier(database))
}

/// Build a 3-part qualified identifier `` `<catalog>`.`<database>`.`<table>` ``.
fn doris_catalog_table_ref(catalog: &str, database: &str, table: &str) -> String {
    format!("{}.{}.{}", quote_identifier(catalog), quote_identifier(database), quote_identifier(table))
}

/// `SHOW CATALOGS` → list of catalogs visible to the current user.
///
/// Column layouts differ between engines: Doris exposes `CatalogName` (with
/// `CatalogId`/`IsCurrent`/`CreateTime`/`LastUpdateTime`), while StarRocks
/// exposes `Catalog` (only `Type`/`Comment`, no `IsCurrent`). The name is read
/// from either column; missing trailing columns degrade gracefully to
/// empty/None. The built-in catalog is named `internal` in Doris and
/// `default_catalog` in StarRocks (both with `Type=internal`); detection is
/// type-based (see `CatalogInfo::is_internal`), not name-based.
pub async fn list_doris_catalogs(pool: &MySqlPool) -> Result<Vec<crate::db::CatalogInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = conn.query_iter("SHOW CATALOGS").await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let catalogs: Vec<crate::db::CatalogInfo> = rows
        .iter()
        .filter_map(|row| {
            // Doris column is `CatalogName`; StarRocks column is `Catalog`.
            let name = first_nonempty_str_by_name(row, &["CatalogName", "Catalog"]).trim().to_string();
            if name.is_empty() {
                return None;
            }
            let catalog_type = get_str_by_name(row, "Type").trim().to_string();
            let is_current = {
                let value = get_str_by_name(row, "IsCurrent").trim().to_ascii_lowercase();
                !value.is_empty() && value != "no" && value != "false" && value != "0"
            };
            let comment = get_opt_str(row, "Comment").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            Some(crate::db::CatalogInfo { name, catalog_type, is_current, comment })
        })
        .collect();
    Ok(normalize_doris_catalogs(catalogs))
}

/// Sort with the built-in catalog first, then the rest alphabetically by name.
/// The built-in catalog is identified by `CatalogInfo::is_internal` (type-based)
/// rather than by name, so StarRocks `default_catalog` sorts first just like
/// Doris `internal`. No synthetic catalog is injected: `SHOW CATALOGS` always
/// lists the built-in catalog on both engines, and a single-catalog result is
/// handled by the flat-sidebar fallback in the caller.
fn normalize_doris_catalogs(mut catalogs: Vec<crate::db::CatalogInfo>) -> Vec<crate::db::CatalogInfo> {
    catalogs.sort_by(|a, b| match (a.is_internal(), b.is_internal()) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    catalogs
}

/// `SHOW DATABASES FROM <catalog>` → databases in the given catalog.
pub async fn list_databases_show_from(pool: &MySqlPool, catalog: &str) -> Result<Vec<DatabaseInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let sql = format!("SHOW DATABASES FROM {}", quote_identifier(catalog));
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    Ok(database_infos_from_names(rows.iter().map(|row| get_str(row, 0)), false))
}

/// `SHOW TABLES FROM <catalog>.<database>` → tables in an external catalog.
///
/// External catalogs do not support `SHOW TABLE STATUS`, so comments/status are
/// not fetched (the caller only needs names + types for browsing).
pub async fn list_tables_show_from(pool: &MySqlPool, catalog: &str, database: &str) -> Result<Vec<TableInfo>, String> {
    let sql = format!("SHOW TABLES FROM {}", doris_catalog_database_ref(catalog, database));
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let mut tables: Vec<TableInfo> = rows
        .iter()
        .filter_map(|row| {
            let name = get_str(row, 0).trim().to_string();
            if name.is_empty() {
                return None;
            }
            // SHOW FULL TABLES exposes a type column; plain SHOW TABLES does not.
            let table_type = get_str(row, 1);
            Some(TableInfo {
                name,
                table_type: if table_type.trim().is_empty() { "TABLE".to_string() } else { table_type },
                comment: None,
                parent_schema: None,
                parent_name: None,
            })
        })
        .collect();
    tables.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tables)
}

/// `SHOW COLUMNS FROM <catalog>.<database>.<table>` → columns of an external
/// catalog table. Falls back to `DESCRIBE` if `SHOW COLUMNS` is rejected.
pub async fn get_columns_show_from(
    pool: &MySqlPool,
    catalog: &str,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let qualified = doris_catalog_table_ref(catalog, database, table);
    let full_sql = format!("SHOW FULL COLUMNS FROM {qualified}");
    let plain_sql = format!("SHOW COLUMNS FROM {qualified}");
    let describe_sql = format!("DESCRIBE {qualified}");
    let mut conn = get_conn_with_health_check(pool).await?;
    let rows: Vec<mysql_async::Row> = match conn.query_iter(&full_sql).await {
        Ok(result) => result.collect_and_drop().await.map_err(|e| e.to_string())?,
        Err(_) => match conn.query_iter(&plain_sql).await {
            Ok(result) => result.collect_and_drop().await.map_err(|e| e.to_string())?,
            Err(_) => {
                let result = conn.query_iter(&describe_sql).await.map_err(|e| e.to_string())?;
                result.collect_and_drop().await.map_err(|e| e.to_string())?
            }
        },
    };
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = get_str_by_name(row, "Field").trim().to_string();
            if name.is_empty() {
                return None;
            }
            let key = get_str_by_name(row, "Key");
            Some(ColumnInfo {
                name,
                data_type: get_str_by_name(row, "Type"),
                is_nullable: get_str_by_name(row, "Null").eq_ignore_ascii_case("YES"),
                column_default: get_opt_str(row, "Default"),
                is_primary_key: key.eq_ignore_ascii_case("PRI"),
                extra: get_opt_str(row, "Extra"),
                comment: get_opt_str(row, "Comment")
                    .map(|s| fix_potential_double_encoding(&s))
                    .filter(|s| !s.is_empty()),
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
                enum_values: None,
            })
        })
        .collect())
}

/// `SHOW CREATE TABLE <catalog>.<database>.<table>` → DDL for an external
/// catalog table.
pub async fn show_create_table_ddl_from(
    pool: &MySqlPool,
    catalog: &str,
    database: &str,
    table: &str,
) -> Result<String, String> {
    let sql = format!("SHOW CREATE TABLE {}", doris_catalog_table_ref(catalog, database, table));
    let mut conn = get_conn_with_health_check(pool).await?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let row = rows.first().ok_or("DDL not found")?;
    row.get_opt::<String, usize>(1)
        .and_then(|result| result.ok())
        .or_else(|| {
            row.get_opt::<Vec<u8>, usize>(1)
                .and_then(|result| result.ok())
                .map(|b| String::from_utf8_lossy(&b).to_string())
        })
        .ok_or_else(|| "Failed to read DDL".to_string())
}

/// Best-effort index listing for an external catalog table. External catalogs
/// generally do not expose MySQL-style index metadata via `information_schema`
/// (that view is scoped to the internal catalog), so indexes are derived from
/// `SHOW CREATE TABLE` parsing. Returns empty on failure (graceful degradation
/// — indexes are informational for external tables).
pub async fn list_doris_catalog_indexes(
    pool: &MySqlPool,
    catalog: &str,
    database: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let ddl = show_create_table_ddl_from(pool, catalog, database, table).await?;
    Ok(doris_indexes_from_create_table_ddl(&ddl))
}

fn merge_index_infos(target: &mut Vec<IndexInfo>, parsed: Vec<IndexInfo>) {
    let mut seen_names: HashSet<String> = target.iter().map(|index| index.name.to_ascii_lowercase()).collect();
    for index in parsed {
        if index.columns.is_empty() {
            continue;
        }
        if seen_names.contains(&index.name.to_ascii_lowercase())
            || target.iter().any(|existing| {
                existing.is_unique == index.is_unique
                    && existing.is_primary == index.is_primary
                    && existing.columns == index.columns
            })
        {
            continue;
        }
        seen_names.insert(index.name.to_ascii_lowercase());
        target.push(index);
    }
}

fn doris_indexes_from_create_table_ddl(ddl: &str) -> Vec<IndexInfo> {
    let mut indexes = Vec::new();
    for raw_line in ddl.lines() {
        let line = trim_ddl_definition_line(raw_line);
        if line.is_empty() {
            continue;
        }
        let upper = line.to_ascii_uppercase();
        if upper.starts_with("PRIMARY KEY") {
            if let Some(index) = doris_table_key_index("PRIMARY", line, true, true, "PRIMARY KEY") {
                indexes.push(index);
            }
        } else if upper.starts_with("UNIQUE KEY") {
            if let Some(index) = doris_table_key_index("UNIQUE KEY", line, true, false, "UNIQUE KEY") {
                indexes.push(index);
            }
        } else if upper.starts_with("INDEX ") {
            if let Some(index) = doris_secondary_index(line) {
                indexes.push(index);
            }
        }
    }
    indexes
}

fn trim_ddl_definition_line(line: &str) -> &str {
    let mut trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix(',') {
        trimmed = rest.trim_start();
    }
    while let Some(rest) = trimmed.strip_suffix(',') {
        trimmed = rest.trim_end();
    }
    trimmed
}

fn doris_table_key_index(
    name: &str,
    line: &str,
    is_unique: bool,
    is_primary: bool,
    index_type: &str,
) -> Option<IndexInfo> {
    let columns = parse_mysql_index_columns(first_parenthesized_content(line)?);
    if columns.is_empty() {
        return None;
    }
    Some(IndexInfo {
        name: name.to_string(),
        columns,
        is_unique,
        is_primary,
        filter: None,
        index_type: Some(index_type.to_string()),
        included_columns: None,
        comment: None,
    })
}

fn doris_secondary_index(line: &str) -> Option<IndexInfo> {
    let (_, rest) = split_keyword_prefix(line, "INDEX")?;
    let (name, after_name) = read_mysql_identifier(rest.trim_start())?;
    let columns = parse_mysql_index_columns(first_parenthesized_content(after_name)?);
    if columns.is_empty() {
        return None;
    }
    Some(IndexInfo {
        name,
        columns,
        is_unique: false,
        is_primary: false,
        filter: None,
        index_type: mysql_keyword_argument(after_name, "USING").or_else(|| Some("INDEX".to_string())),
        included_columns: None,
        comment: mysql_quoted_string_argument(after_name, "COMMENT"),
    })
}

fn split_keyword_prefix<'a>(line: &'a str, keyword: &str) -> Option<(&'a str, &'a str)> {
    if line.len() < keyword.len() || !line[..keyword.len()].eq_ignore_ascii_case(keyword) {
        return None;
    }
    let rest = &line[keyword.len()..];
    if !rest.is_empty() && is_mysql_identifier_byte(rest.as_bytes()[0]) {
        return None;
    }
    Some((&line[..keyword.len()], rest))
}

fn read_mysql_identifier(input: &str) -> Option<(String, &str)> {
    let input = input.trim_start();
    if input.is_empty() {
        return None;
    }
    let bytes = input.as_bytes();
    if bytes[0] == b'`' {
        let mut i = 1;
        let mut value = String::new();
        while i < bytes.len() {
            if bytes[i] == b'`' {
                if i + 1 < bytes.len() && bytes[i + 1] == b'`' {
                    value.push('`');
                    i += 2;
                    continue;
                }
                return Some((value, &input[i + 1..]));
            }
            let ch = input[i..].chars().next()?;
            value.push(ch);
            i += ch.len_utf8();
        }
        return None;
    }

    let end = input.find(|ch: char| ch.is_whitespace() || matches!(ch, '(' | ')' | ',')).unwrap_or(input.len());
    if end == 0 {
        return None;
    }
    Some((input[..end].to_string(), &input[end..]))
}

fn first_parenthesized_content(input: &str) -> Option<&str> {
    let bytes = input.as_bytes();
    let mut depth = 0usize;
    let mut start = None;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' | b'`' => {
                i = skip_mysql_quoted(input, i, bytes[i]);
                continue;
            }
            b'(' => {
                if depth == 0 {
                    start = Some(i + 1);
                }
                depth += 1;
            }
            b')' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    return start.map(|start| &input[start..i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn split_top_level_csv(input: &str) -> Vec<&str> {
    let bytes = input.as_bytes();
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' | b'`' => {
                i = skip_mysql_quoted(input, i, bytes[i]);
                continue;
            }
            b'(' => depth += 1,
            b')' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                parts.push(input[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(input[start..].trim());
    parts
}

fn parse_mysql_index_columns(input: &str) -> Vec<String> {
    split_top_level_csv(input)
        .into_iter()
        .filter_map(|part| read_mysql_identifier(part).map(|(column, _)| column))
        .filter(|column| !column.is_empty())
        .collect()
}

fn mysql_keyword_argument(input: &str, keyword: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' | b'`' => {
                i = skip_mysql_quoted(input, i, bytes[i]);
                continue;
            }
            _ if mysql_keyword_at(input, i, keyword) => {
                return read_mysql_identifier(&input[i + keyword.len()..]).map(|(value, _)| value);
            }
            _ => i += 1,
        }
    }
    None
}

fn mysql_quoted_string_argument(input: &str, keyword: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' | b'`' => {
                i = skip_mysql_quoted(input, i, bytes[i]);
                continue;
            }
            _ if mysql_keyword_at(input, i, keyword) => {
                let rest = input[i + keyword.len()..].trim_start();
                if rest.as_bytes().first().copied() != Some(b'\'') {
                    return None;
                }
                let end = skip_mysql_quoted(rest, 0, b'\'');
                if end <= 1 || end > rest.len() {
                    return None;
                }
                return Some(rest[1..end - 1].replace("\\'", "'").replace("''", "'"));
            }
            _ => i += 1,
        }
    }
    None
}

pub async fn list_foreign_keys(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let sql = format!(
        "SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME, \
         kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, \
         rc.UPDATE_RULE, rc.DELETE_RULE \
         FROM information_schema.KEY_COLUMN_USAGE kcu \
         LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
           ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA \
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
          AND rc.TABLE_NAME = kcu.TABLE_NAME \
         WHERE kcu.TABLE_SCHEMA = {} AND kcu.TABLE_NAME = {} \
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL \
         ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
        quote_value(database),
        quote_value(table),
    );
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ForeignKeyInfo {
            name: get_str_by_name(row, "CONSTRAINT_NAME"),
            column: get_str_by_name(row, "COLUMN_NAME"),
            ref_schema: Some(get_str_by_name(row, "REFERENCED_TABLE_SCHEMA")),
            ref_table: get_str_by_name(row, "REFERENCED_TABLE_NAME"),
            ref_column: get_str_by_name(row, "REFERENCED_COLUMN_NAME"),
            on_update: Some(get_str_by_name(row, "UPDATE_RULE")).filter(|value| !value.is_empty()),
            on_delete: Some(get_str_by_name(row, "DELETE_RULE")).filter(|value| !value.is_empty()),
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
            statement: Some(get_str_by_name(row, "ACTION_STATEMENT")).filter(|value| !value.is_empty()),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection_timeout;
    use mysql_async::consts::ColumnFlags;

    #[test]
    fn mysql_column_type_names_map_to_friendly_names() {
        use mysql_async::consts::ColumnType::*;
        assert_eq!(mysql_column_type_name(MYSQL_TYPE_TINY), "tinyint");
        assert_eq!(mysql_column_type_name(MYSQL_TYPE_LONG), "int");
        assert_eq!(mysql_column_type_name(MYSQL_TYPE_LONGLONG), "bigint");
        assert_eq!(mysql_column_type_name(MYSQL_TYPE_NEWDECIMAL), "decimal");
        assert_eq!(mysql_column_type_name(MYSQL_TYPE_VARCHAR), "varchar");
        assert_eq!(mysql_column_type_name(MYSQL_TYPE_VAR_STRING), "varchar");
        assert_eq!(mysql_column_type_name(MYSQL_TYPE_STRING), "char");
        assert_eq!(mysql_column_type_name(MYSQL_TYPE_DATETIME), "datetime");
        assert_eq!(mysql_column_type_name(MYSQL_TYPE_JSON), "json");
        assert_eq!(mysql_column_type_name(MYSQL_TYPE_BLOB), "blob");
    }

    #[test]
    fn mysql_with_queries_are_treated_as_result_sets() {
        let sql = "WITH RECURSIVE org_tree AS (SELECT 1 AS id) SELECT id FROM org_tree";
        assert!(is_result_set_query(sql, MySqlQueryDialect::default()));
    }

    #[test]
    fn mysql_desc_queries_are_treated_as_result_sets() {
        assert!(is_result_set_query("DESC users", MySqlQueryDialect::default()));
    }

    #[test]
    fn mysql_call_queries_are_treated_as_text_result_sets() {
        let dialect = MySqlQueryDialect::default();

        assert!(is_result_set_query("CALL proc_test1()", dialect));
        assert!(prefers_text_protocol_query("CALL proc_test1()", dialect));
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
    fn mysql_admin_show_queries_are_not_treated_as_result_sets() {
        let sql = "ADMIN SHOW FRONTEND CONFIG LIKE '%default_replication_num%'";
        let dialect = MySqlQueryDialect::for_connection(DatabaseType::Mysql, None);

        assert!(!is_result_set_query(sql, dialect));
        assert!(!requires_text_protocol_query(sql, dialect));
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
        let sql = list_tables_objects_sql("app");

        assert!(sql.contains("information_schema.TABLES"));
        assert!(!sql.contains("information_schema.ROUTINES"));
        assert!(!sql.contains("UNION"));
        assert!(sql.contains("CREATE_TIME"));
        assert!(sql.contains("UPDATE_TIME"));
    }

    #[test]
    fn mysql_list_tables_sql_applies_filter_limit_and_offset() {
        let sql = list_tables_sql("app", Some("user_%"), Some(101), Some(200), None);

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
        let sql = list_tables_sql("app", Some("sysu"), Some(100), None, None);

        assert!(sql.contains("LOWER(TABLE_NAME) LIKE '%sysu%' ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(TABLE_COMMENT) LIKE '%sysu%' ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(TABLE_NAME) LIKE '%s%y%s%u%' ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(TABLE_COMMENT) LIKE '%s%y%s%u%' ESCAPE '\\\\'"));
    }

    #[test]
    fn mysql_list_tables_sql_skips_fuzzy_filter_for_single_character() {
        let sql = list_tables_sql("app", Some("u"), Some(100), None, None);

        assert!(sql.contains("LOWER(TABLE_NAME) LIKE '%u%' ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(TABLE_COMMENT) LIKE '%u%' ESCAPE '\\\\'"));
        assert_eq!(sql.matches("LOWER(TABLE_NAME) LIKE").count(), 1);
        assert_eq!(sql.matches("LOWER(TABLE_COMMENT) LIKE").count(), 1);
        assert!(!sql.contains(" OR LOWER(TABLE_NAME) LIKE"));
    }

    #[test]
    fn mysql_list_tables_sql_filters_table_type_before_pagination() {
        let tables = vec!["TABLE".to_string()];
        let table_sql = list_tables_sql("app", None, Some(1000), None, Some(&tables));
        assert!(table_sql.contains("TABLE_TYPE <> 'VIEW'"));
        assert!(table_sql.find("TABLE_TYPE <> 'VIEW'") < table_sql.find("ORDER BY TABLE_NAME"));
        assert!(table_sql.find("ORDER BY TABLE_NAME") < table_sql.find("LIMIT 1000"));

        let views = vec!["VIEW".to_string()];
        let view_sql = list_tables_sql("app", None, Some(1000), None, Some(&views));
        assert!(view_sql.contains("TABLE_TYPE = 'VIEW'"));
    }

    #[test]
    fn mysql_empty_list_tables_fallback_allows_sidebar_paging_and_type_filters() {
        assert!(should_fallback_empty_list_tables(None));
        assert!(should_fallback_empty_list_tables(Some("")));
        assert!(should_fallback_empty_list_tables(Some("  ")));
        assert!(!should_fallback_empty_list_tables(Some("missing")));
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
        let filtered = filter_list_tables_fallback(rows, Some("audit"), Some(1), Some(1), Some(&["TABLE".to_string()]));

        assert_eq!(filtered.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), vec!["audit_2025"]);

        let rows = vec![TableInfo {
            name: "t_0001".to_string(),
            table_type: "BASE TABLE".to_string(),
            comment: Some("food orders".to_string()),
            parent_schema: None,
            parent_name: None,
        }];
        let filtered = filter_list_tables_fallback(rows, Some("ood"), None, None, Some(&["TABLE".to_string()]));

        assert_eq!(filtered.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), vec!["t_0001"]);
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
    fn mysql_show_metadata_sql_supports_catalogless_services() {
        assert_eq!(show_tables_sql("", true), "SHOW FULL TABLES");
        assert_eq!(show_tables_sql("", false), "SHOW TABLES");
        assert_eq!(show_tables_sql("app", true), "SHOW FULL TABLES FROM `app`");
        assert_eq!(show_columns_sql("", "idx", true), "SHOW FULL COLUMNS FROM `idx`");
        assert_eq!(show_columns_sql("app", "idx", false), "SHOW COLUMNS FROM `app`.`idx`");
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
    fn mysql_completion_triggers_sql_lists_database_triggers() {
        let sql = list_completion_triggers_sql("app");

        assert!(sql.contains("information_schema.TRIGGERS"));
        assert!(sql.contains("'TRIGGER' AS object_type"));
        assert!(sql.contains("EVENT_OBJECT_TABLE AS parent_name"));
        assert!(sql.contains("TRIGGER_SCHEMA = 'app'"));
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
    fn mysql_columns_sql_uses_column_key_for_primary_keys_without_join() {
        let sql = columns_sql("app", "users");

        assert!(sql.contains("information_schema.COLUMNS"));
        assert!(!sql.contains("KEY_COLUMN_USAGE"));
        assert!(!sql.contains("CONSTRAINT_NAME = 'PRIMARY'"));
        assert!(sql.contains("c.COLUMN_KEY"));
        assert!(sql.contains("c.DATA_TYPE"));
        assert!(sql.contains("c.COLUMN_TYPE"));
        assert!(!sql.contains("COLLATE"));
        assert!(!sql.contains("AS ENUM_VALUES"));
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
    fn doris_create_table_ddl_indexes_include_unique_key_and_inverted_indexes() {
        let ddl = r#"
CREATE TABLE `bfm_org` (
  `org_id` bigint NULL,
  `ORG_CODE` varchar(255) NULL,
  `ORG_NAME` varchar(255) NULL,
  INDEX org_id_idx (`org_id`) USING INVERTED,
  INDEX org_code_idx (`ORG_CODE`) USING INVERTED,
  INDEX org_name_idx (`ORG_NAME`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`org_id`)
COMMENT '部门信息表'
DISTRIBUTED BY HASH(`org_id`) BUCKETS 4
"#;

        let indexes = doris_indexes_from_create_table_ddl(ddl);

        assert_eq!(indexes.len(), 4);
        assert_eq!(indexes[0].name, "org_id_idx");
        assert_eq!(indexes[0].columns, vec!["org_id"]);
        assert!(!indexes[0].is_unique);
        assert_eq!(indexes[0].index_type.as_deref(), Some("INVERTED"));
        assert_eq!(indexes[3].name, "UNIQUE KEY");
        assert_eq!(indexes[3].columns, vec!["org_id"]);
        assert!(indexes[3].is_unique);
        assert!(!indexes[3].is_primary);
        assert_eq!(indexes[3].index_type.as_deref(), Some("UNIQUE KEY"));
    }

    #[test]
    fn doris_create_table_ddl_index_parser_handles_quoted_names_and_comments() {
        let ddl = r#"
CREATE TABLE `search_test` (
  `name``part` varchar(64) NULL,
  INDEX `idx``name` (`name``part`) USING NGRAM_BF COMMENT 'name''s index'
) ENGINE=OLAP
UNIQUE KEY(`tenant_id`, `name``part`)
"#;

        let indexes = doris_indexes_from_create_table_ddl(ddl);

        assert_eq!(indexes.len(), 2);
        assert_eq!(indexes[0].name, "idx`name");
        assert_eq!(indexes[0].columns, vec!["name`part"]);
        assert_eq!(indexes[0].index_type.as_deref(), Some("NGRAM_BF"));
        assert_eq!(indexes[0].comment.as_deref(), Some("name's index"));
        assert_eq!(indexes[1].columns, vec!["tenant_id", "name`part"]);
        assert!(indexes[1].is_unique);
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
    fn mysql_binary_preview_renders_binary_and_varbinary_like_navicat_text_preview() {
        let binary_column = mysql_test_column(ColumnType::MYSQL_TYPE_STRING, 63, ColumnFlags::BINARY_FLAG, 8);
        let varbinary_column = mysql_test_column(ColumnType::MYSQL_TYPE_VAR_STRING, 63, ColumnFlags::BINARY_FLAG, 8);

        assert_eq!(mysql_bytes_to_json(b"150010\0\0".to_vec(), &binary_column), serde_json::json!("150010"));
        assert_eq!(mysql_bytes_to_json(b"150010".to_vec(), &varbinary_column), serde_json::json!("150010"));
    }

    #[test]
    fn mysql_binary_preview_falls_back_to_hex_for_unprintable_bytes() {
        let binary_column = mysql_test_column(ColumnType::MYSQL_TYPE_STRING, 63, ColumnFlags::BINARY_FLAG, 8);
        let varbinary_column = mysql_test_column(ColumnType::MYSQL_TYPE_VAR_STRING, 63, ColumnFlags::BINARY_FLAG, 8);

        assert_eq!(mysql_bytes_to_json(vec![0x01, 0x02, 0x03, 0x04], &binary_column), serde_json::json!("0x01020304"));
        assert_eq!(
            mysql_bytes_to_json(vec![0xde, 0xad, 0xbe, 0xef], &varbinary_column),
            serde_json::json!("0xdeadbeef")
        );
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
    }

    #[test]
    fn mysql_tcp_keepalive_uses_milliseconds_not_seconds() {
        assert_eq!(MYSQL_TCP_KEEPALIVE_MS, 30_000);
        assert!(MYSQL_TCP_KEEPALIVE_MS >= 1_000);
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

        assert!(mysql_error_should_retry_without_group_concat_max_len(error));
        assert_eq!(
            mysql_setup_mode_retry_without_group_concat(MySqlSetupMode::Standard, error),
            Some(MySqlSetupMode::Compatible)
        );
    }

    #[test]
    fn mysql_group_concat_setup_retry_is_narrow() {
        assert!(!mysql_error_should_retry_without_group_concat_max_len(
            "MySQL connection failed: Server error: `ERROR HY000 (1193): Unknown system variable,stmt:SET @@sql_mode = ANSI'"
        ));
        assert_eq!(
            mysql_setup_mode_retry_without_group_concat(
                MySqlSetupMode::Compatible,
                "Server error: ERROR HY000 (1193): Unknown system variable,stmt:SET @@group_concat_max_len = 1048576"
            ),
            None
        );
    }

    #[test]
    fn mysql_setup_queries_select_requested_database_before_session_init() {
        let queries = mysql_setup_queries("mysql://root:secret@localhost:3306/app?charset=utf8mb4", &[]);

        assert_eq!(queries, vec!["USE `app`", "SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576"]);
    }

    #[test]
    fn mysql_setup_queries_skip_use_when_database_missing() {
        let queries = mysql_setup_queries("mysql://root:secret@localhost:3306?charset=utf8mb4", &[]);

        assert_eq!(queries, vec!["SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576"]);
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
    fn mysql_compatible_setup_queries_keep_catalog_and_extra_queries() {
        let extra = vec!["SET ob_query_timeout = 30000000".to_string()];
        let queries = mysql_setup_queries_with_mode(
            "mysql://root:secret@localhost:9030/clip?catalog=paimon_catalog",
            &extra,
            MySqlSetupMode::Compatible,
        );

        assert_eq!(
            queries,
            vec![
                "USE `clip`",
                "SET NAMES utf8mb4",
                "SET catalog = `paimon_catalog`",
                "SET ob_query_timeout = 30000000"
            ]
        );
    }

    #[test]
    fn mysql_setup_queries_decode_database_name_from_url() {
        let queries = mysql_setup_queries("mysql://root:secret@localhost:3306/db%2Fname?charset=utf8mb4", &[]);

        assert_eq!(queries, vec!["USE `db/name`", "SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576"]);
    }

    #[test]
    fn mysql_setup_queries_can_select_database_without_url_path() {
        let queries = mysql_setup_queries_for_database(
            "mysql://root:secret@localhost:3306?charset=utf8mb4",
            Some("app`proxy"),
            &[],
        );

        assert_eq!(queries, vec!["USE `app``proxy`", "SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576"]);
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
    fn mysql_async_url_strips_jdbc_params() {
        let url = "mysql://host:3306/db?useUnicode=true&characterEncoding=utf8&zeroDateTimeBehavior=convertToNull&useSSL=true&serverTimezone=GMT%2B8&allowPublicKeyRetrieval=true";
        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:3306/db");
    }

    #[test]
    fn mysql_async_url_keeps_valid_params_while_stripping_jdbc() {
        let url = "mysql://host:3306/db?useUnicode=true&characterEncoding=utf8&require_ssl=true&charset=utf8mb4&autoReconnect=true&allowMultiQueries=true";
        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:3306/db?require_ssl=true");
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
            vec!["USE `db`", "SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576"]
        );
    }

    #[test]
    fn mysql_setup_queries_use_safe_custom_charset() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?ssl-mode=preferred&charset=gbk", &[]),
            vec!["USE `db`", "SET NAMES gbk", "SET @@group_concat_max_len = 1048576"]
        );
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?charset=utf8mb4;DROP TABLE users", &[]),
            vec!["USE `db`", "SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576"]
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
                "SET @@group_concat_max_len = 1048576",
                "SET ob_query_timeout = 30000000"
            ]
        );
    }

    #[test]
    fn mysql_setup_queries_apply_explicit_time_zone() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?time_zone=%2B08%3A00&charset=utf8mb4", &[]),
            vec!["USE `db`", "SET time_zone = '+08:00'", "SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576"]
        );
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?time-zone=Asia%2FShanghai", &[]),
            vec![
                "USE `db`",
                "SET time_zone = 'Asia/Shanghai'",
                "SET NAMES utf8mb4",
                "SET @@group_concat_max_len = 1048576"
            ]
        );
    }

    #[test]
    fn mysql_setup_queries_apply_jdbc_time_zone_aliases() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?serverTimezone=GMT%2B8", &[]),
            vec!["USE `db`", "SET time_zone = '+08:00'", "SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576"]
        );
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?connectionTimeZone=UTC", &[]),
            vec!["USE `db`", "SET time_zone = '+00:00'", "SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576"]
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
                "SET @@group_concat_max_len = 1048576"
            ]
        );
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?time_zone=%2B08%3A00&loc=UTC", &[]),
            vec!["USE `db`", "SET time_zone = '+08:00'", "SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576"]
        );
    }

    #[test]
    fn mysql_setup_queries_ignore_unsafe_time_zone_values() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?time_zone=%2B08%3A00%27%3BDROP%20TABLE%20users", &[]),
            vec!["USE `db`", "SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576"]
        );
    }

    #[test]
    fn mysql_setup_queries_switch_catalog_when_present() {
        // `SET catalog` is pushed last so mysql_async's back-to-front setup
        // execution (Vec::pop) runs it before `USE <database>`.
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/clip?catalog=paimon_catalog", &[]),
            vec![
                "USE `clip`",
                "SET NAMES utf8mb4",
                "SET @@group_concat_max_len = 1048576",
                "SET catalog = `paimon_catalog`"
            ]
        );
    }

    #[test]
    fn mysql_setup_queries_switch_catalog_without_database() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/?catalog=paimon_catalog", &[]),
            vec!["SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576", "SET catalog = `paimon_catalog`"]
        );
    }

    #[test]
    fn mysql_setup_queries_decodes_catalog_parameter() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?catalog=my%5Fcatalog", &[]),
            vec!["USE `db`", "SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576", "SET catalog = `my_catalog`"]
        );
    }

    #[test]
    fn mysql_setup_queries_omits_catalog_when_absent() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?charset=utf8mb4", &[]),
            vec!["USE `db`", "SET NAMES utf8mb4", "SET @@group_concat_max_len = 1048576"]
        );
    }

    fn doris_catalog_info(name: &str, catalog_type: &str, is_current: bool) -> crate::db::CatalogInfo {
        crate::db::CatalogInfo {
            name: name.to_string(),
            catalog_type: catalog_type.to_string(),
            is_current,
            comment: None,
        }
    }

    #[test]
    fn doris_catalog_database_ref_backtick_qualifies_two_parts() {
        assert_eq!(doris_catalog_database_ref("iceberg_catalog", "sales"), "`iceberg_catalog`.`sales`");
    }

    #[test]
    fn doris_catalog_table_ref_backtick_qualifies_three_parts() {
        assert_eq!(doris_catalog_table_ref("iceberg_catalog", "sales", "orders"), "`iceberg_catalog`.`sales`.`orders`");
    }

    #[test]
    fn doris_catalog_refs_escape_embedded_backticks() {
        assert_eq!(doris_catalog_database_ref("a`b", "c`d"), "`a``b`.`c``d`");
        assert_eq!(doris_catalog_table_ref("a`b", "c`d", "e`f"), "`a``b`.`c``d`.`e``f`");
    }

    #[test]
    fn normalize_doris_catalogs_does_not_inject_missing_internal() {
        // SHOW CATALOGS always lists the built-in catalog on both engines, so a
        // missing internal catalog is not synthesized — the caller's flat-sidebar
        // fallback handles a single/empty result instead.
        let catalogs = vec![
            doris_catalog_info("iceberg_catalog", "iceberg", true),
            doris_catalog_info("hive_catalog", "hive", false),
        ];
        let normalized = normalize_doris_catalogs(catalogs);
        let names: Vec<&str> = normalized.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["hive_catalog", "iceberg_catalog"]);
        assert!(!normalized.iter().any(|c| c.is_internal()));
    }

    #[test]
    fn normalize_doris_catalogs_keeps_existing_internal_first() {
        let catalogs = vec![
            doris_catalog_info("iceberg_catalog", "iceberg", false),
            doris_catalog_info("internal", "internal", true),
            doris_catalog_info("hive_catalog", "hive", false),
        ];
        let normalized = normalize_doris_catalogs(catalogs);
        let names: Vec<&str> = normalized.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["internal", "hive_catalog", "iceberg_catalog"]);
    }

    #[test]
    fn normalize_doris_catalogs_sorts_starrocks_default_catalog_first() {
        // StarRocks names its built-in catalog `default_catalog` (Type=Internal);
        // detection is type-based, so it sorts first just like Doris `internal`.
        let catalogs = vec![
            doris_catalog_info("hive_catalog", "hive", false),
            doris_catalog_info("default_catalog", "Internal", true),
        ];
        let normalized = normalize_doris_catalogs(catalogs);
        let names: Vec<&str> = normalized.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["default_catalog", "hive_catalog"]);
        assert!(normalized[0].is_internal());
        assert!(!normalized[1].is_internal());
    }

    #[test]
    fn normalize_doris_catalogs_detects_internal_by_type_not_name() {
        // A catalog literally named `internal` but with an external type is NOT
        // the built-in catalog and must not sort first.
        let catalogs =
            vec![doris_catalog_info("internal", "iceberg", false), doris_catalog_info("hive_catalog", "hive", false)];
        let normalized = normalize_doris_catalogs(catalogs);
        let names: Vec<&str> = normalized.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["hive_catalog", "internal"]);
        assert!(!normalized.iter().any(|c| c.is_internal()));
    }

    #[test]
    fn normalize_doris_catalogs_handles_empty_input() {
        let normalized = normalize_doris_catalogs(Vec::new());
        assert!(normalized.is_empty());
    }
}
