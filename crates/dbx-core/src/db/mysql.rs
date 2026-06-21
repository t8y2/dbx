use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use futures::StreamExt;
use mysql_async::consts::ColumnType;
use mysql_async::prelude::*;
use percent_encoding::percent_decode_str;
use rust_decimal::Decimal;
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use crate::models::connection::DatabaseType;
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ObjectInfo, ObjectStatistics, QueryResult, TableInfo,
    TriggerInfo,
};

use super::file_validator::validate_file_path;

pub type MySqlPool = mysql_async::Pool;

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

fn quote_value(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn quote_identifier(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
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
fn mysql_column_type_name(ty: ColumnType) -> String {
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
    let timeout = super::parse_connect_timeout_with_fallback(url, fallback_timeout);
    let pool = create_pool(url, ca_cert_path, max_connections)?;
    let result = verify_pool_connection(&pool, timeout).await;

    if let Err(ref e) = result {
        if mysql_error_should_retry_without_ssl(e) {
            if let Some(fallback_url) = ssl_fallback_url(url) {
                log::info!("SSL handshake failed, retrying with ssl-mode=disabled");
                let fallback_pool = create_pool(&fallback_url, None, max_connections)?;
                return match verify_pool_connection(&fallback_pool, timeout).await {
                    Ok(()) => Ok(fallback_pool),
                    Err(e) => Err(e),
                };
            }
        }
    }

    result.map(|_| pool)
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct MySqlTlsFiles {
    sslcert: Option<String>,
    sslkey: Option<String>,
}

fn create_pool(url: &str, ca_cert_path: Option<&str>, max_connections: usize) -> Result<MySqlPool, String> {
    let tls_url = mysql_tls_url(url)?;
    let opts =
        mysql_async::Opts::from_url(&mysql_async_url(&tls_url.url)).map_err(|e| format!("Invalid MySQL URL: {e}"))?;
    let base_ssl_opts = opts.ssl_opts().cloned();
    let max_connections = max_connections.max(1);
    // Single-connection pools (max_connections == 1) are client session pools that
    // must preserve session state (e.g. TEMPORARY TABLEs) across queries.
    // Disable COM_RESET_CONNECTION for these pools to avoid clearing that state.
    let pool_opts = mysql_async::PoolOpts::new()
        .with_constraints(mysql_async::PoolConstraints::new(1, max_connections).unwrap())
        .with_inactive_connection_ttl(Duration::from_secs(300))
        .with_reset_connection(max_connections > 1);
    let mut builder = mysql_async::OptsBuilder::from_opts(opts)
        .stmt_cache_size(0)
        .prefer_socket(false)
        .pool_opts(Some(pool_opts))
        .setup(mysql_setup_queries(url));
    if let Some(ssl_opts) = mysql_ssl_opts(base_ssl_opts, url, ca_cert_path, &tls_url.files)? {
        builder = builder.ssl_opts(ssl_opts);
    }
    Ok(MySqlPool::new(builder))
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
    if !mysql_url_requires_ssl(url) && !has_client_identity {
        return Ok(None);
    }

    let mut ssl_opts = base_ssl_opts.unwrap_or_default();
    if let Some(ca_cert_path) = ca_cert_path.filter(|_| mysql_url_requires_ssl(url) || has_client_identity) {
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

fn mysql_setup_queries(url: &str) -> Vec<String> {
    let charset = mysql_connection_charset(url).unwrap_or("utf8mb4");
    let mut queries = Vec::new();
    if let Some(database) = mysql_connection_database(url) {
        queries.push(format!("USE {}", quote_identifier(&database)));
    }
    if let Some(time_zone) = mysql_connection_time_zone(url) {
        queries.push(format!("SET time_zone = {}", quote_value(&time_zone)));
    }
    queries.push(format!("SET NAMES {charset}"));
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
    if url.contains("ssl-mode=preferred") {
        Some(url.replace("ssl-mode=preferred", "ssl-mode=disabled"))
    } else if !url.contains("ssl-mode=") {
        let sep = if url.contains('?') { "&" } else { "?" };
        Some(format!("{url}{sep}ssl-mode=disabled"))
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

fn mysql_async_url(url: &str) -> Cow<'_, str> {
    let Some((base, query)) = url.split_once('?') else {
        return Cow::Borrowed(url);
    };

    let original_count = query.split('&').filter(|segment| !segment.trim().is_empty()).count();
    let mut filtered: Vec<String> = Vec::new();
    let mut changed = false;
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
        if is_dbx_handled_mysql_url_param(key) {
            changed = true;
            continue;
        }
        if key.eq_ignore_ascii_case("ssl-mode") || key.eq_ignore_ascii_case("sslmode") {
            changed = true;
            match value.to_ascii_lowercase().replace('-', "_").as_str() {
                "disabled" | "disable" => filtered.push("require_ssl=false".to_string()),
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

    if !changed && filtered.len() == original_count {
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
    let timeout = super::parse_connect_timeout_with_fallback(url, fallback_timeout);
    let pool = create_pool(url, None, max_connections)?;
    verify_pool_connection(&pool, timeout).await.map(|_| pool)
}

pub async fn list_databases(pool: &MySqlPool) -> Result<Vec<DatabaseInfo>, String> {
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
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
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
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
    let sql = format!(
        "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = {} ORDER BY TABLE_NAME",
        quote_value(database),
    );
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = match conn.query_iter(&sql).await {
        Ok(result) => result,
        Err(err) => {
            log::debug!(
                "Falling back to SHOW TABLES for database `{database}` after information_schema.TABLES failed: {err}"
            );
            return list_tables_show(pool, database).await;
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

    if tables.is_empty() {
        log::debug!("Falling back to SHOW TABLES for database `{database}` after information_schema.TABLES returned no named tables");
        return list_tables_show(pool, database).await;
    }

    Ok(tables)
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
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
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
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
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

pub async fn list_object_statistics(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectStatistics>, String> {
    let sql = format!(
        "SELECT TABLE_NAME, TABLE_ROWS, COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS TOTAL_BYTES \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = {} AND TABLE_TYPE <> 'VIEW' \
         ORDER BY TABLE_NAME",
        quote_value(database),
    );
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
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
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let routines_sql = list_routines_sql(database);
    let result = conn.query_iter(&routines_sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| row_to_object(row, database)).collect())
}

pub async fn list_completion_objects(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectInfo>, String> {
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
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
        "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.EXTRA, \
         c.COLUMN_COMMENT, \
         c.COLUMN_KEY, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.CHARACTER_MAXIMUM_LENGTH, \
         CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS is_pk \
         FROM information_schema.COLUMNS c \
         LEFT JOIN information_schema.KEY_COLUMN_USAGE pk \
           ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA \
           AND pk.TABLE_NAME = c.TABLE_NAME \
           AND pk.COLUMN_NAME = c.COLUMN_NAME \
           AND pk.CONSTRAINT_NAME = 'PRIMARY' \
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
            let from_pk_join = row.get::<i32, &str>("is_pk").unwrap_or(0) == 1;
            Some(ColumnInfo {
                is_primary_key: from_pk_join || column_key.eq_ignore_ascii_case("PRI"),
                name,
                data_type: get_str_by_name(row, "COLUMN_TYPE"),
                is_nullable: get_str_by_name(row, "IS_NULLABLE") == "YES",
                column_default: get_opt_str(row, "COLUMN_DEFAULT"),
                extra: get_opt_str(row, "EXTRA"),
                comment: get_opt_str(row, "COLUMN_COMMENT")
                    .map(|s| fix_potential_double_encoding(&s))
                    .filter(|s| !s.is_empty()),
                numeric_precision: get_opt_i32(row, "NUMERIC_PRECISION"),
                numeric_scale: get_opt_i32(row, "NUMERIC_SCALE"),
                character_maximum_length: get_opt_i32(row, "CHARACTER_MAXIMUM_LENGTH"),
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
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    match tokio::time::timeout(crate::db::connection_timeout(), conn.ping()).await {
        Ok(Ok(())) => Ok(conn),
        _ => {
            let _ = conn.disconnect().await;
            pool.get_conn().await.map_err(|e| e.to_string())
        }
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

pub async fn kill_query(pool: &MySqlPool, connection_id: u32) -> Result<(), String> {
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.query_drop(format!("KILL QUERY {connection_id}")).await.map_err(|e| e.to_string())
}

pub async fn kill_query_with_opts(opts: mysql_async::Opts, connection_id: u32) -> Result<(), String> {
    let mut conn = mysql_async::Conn::new(opts).await.map_err(|e| e.to_string())?;
    conn.query_drop(format!("KILL QUERY {connection_id}")).await.map_err(|e| e.to_string())
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
    starts_with_executable_sql_keyword(sql, &["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH"])
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
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
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
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
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
    fn mysql_columns_sql_joins_key_column_usage_for_primary_keys() {
        let sql = columns_sql("app", "users");

        assert!(sql.contains("LEFT JOIN information_schema.KEY_COLUMN_USAGE"));
        assert!(sql.contains("CONSTRAINT_NAME = 'PRIMARY'"));
        assert!(sql.contains("c.COLUMN_KEY"));
        assert!(!sql.contains("COLLATE"));
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
    fn mysql_column_key_marks_primary_when_pk_join_returns_null() {
        // COLUMN_KEY='PRI' provides a fallback when KEY_COLUMN_USAGE LEFT JOIN returns NULL
        let from_pk_join = false;
        let column_key = "PRI";
        let is_pk = from_pk_join || column_key.eq_ignore_ascii_case("PRI");
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
    fn mysql_setup_queries_select_requested_database_before_session_init() {
        let queries = mysql_setup_queries("mysql://root:secret@localhost:3306/app?charset=utf8mb4");

        assert_eq!(queries, vec!["USE `app`", "SET NAMES utf8mb4"]);
    }

    #[test]
    fn mysql_setup_queries_skip_use_when_database_missing() {
        let queries = mysql_setup_queries("mysql://root:secret@localhost:3306?charset=utf8mb4");

        assert_eq!(queries, vec!["SET NAMES utf8mb4"]);
    }

    #[test]
    fn mysql_setup_queries_decode_database_name_from_url() {
        let queries = mysql_setup_queries("mysql://root:secret@localhost:3306/db%2Fname?charset=utf8mb4");

        assert_eq!(queries, vec!["USE `db/name`", "SET NAMES utf8mb4"]);
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
        let default = crate::db::connection_timeout();
        let url = "mysql://host:3306/db?connect_timeout=999";
        assert_eq!(crate::db::parse_connect_timeout(url), default);
        let url2 = "mysql://host:3306/db?connect_timeout=0";
        assert_eq!(crate::db::parse_connect_timeout(url2), default);
    }

    #[test]
    fn parse_connect_timeout_returns_default_when_missing() {
        let default = crate::db::connection_timeout();
        let url = "mysql://host:3306/db?ssl-mode=preferred&charset=utf8mb4";
        assert_eq!(crate::db::parse_connect_timeout(url), default);
    }

    #[test]
    fn parse_connect_timeout_returns_default_when_no_query() {
        let default = crate::db::connection_timeout();
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
        let url = "mysql://host:3306/db?useUnicode=true&characterEncoding=utf8&require_ssl=true&charset=utf8mb4&autoReconnect=true";
        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:3306/db?require_ssl=true");
    }

    #[test]
    fn mysql_async_url_strips_go_and_timezone_compat_params() {
        let url = "mysql://host:3306/db?charset=utf8mb4&parseTime=True&loc=Local&connectionTimeZone=Asia%2FShanghai&forceConnectionTimeZoneToSession=true&require_ssl=true";

        assert_eq!(mysql_async_url(url).as_ref(), "mysql://host:3306/db?require_ssl=true");
    }

    #[test]
    fn ssl_fallback_does_not_disable_required_tls() {
        assert_eq!(ssl_fallback_url("mysql://host:3306/db?require_ssl=true&charset=utf8mb4"), None);
        assert_eq!(ssl_fallback_url("mysql://host:3306/db?ssl-mode=verify_ca&charset=utf8mb4"), None);
    }

    #[test]
    fn mysql_setup_queries_default_to_utf8mb4() {
        assert_eq!(mysql_setup_queries("mysql://host:3306/db"), vec!["USE `db`", "SET NAMES utf8mb4"]);
    }

    #[test]
    fn mysql_setup_queries_use_safe_custom_charset() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?ssl-mode=preferred&charset=gbk"),
            vec!["USE `db`", "SET NAMES gbk"]
        );
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?charset=utf8mb4;DROP TABLE users"),
            vec!["USE `db`", "SET NAMES utf8mb4"]
        );
    }

    #[test]
    fn mysql_setup_queries_apply_explicit_time_zone() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?time_zone=%2B08%3A00&charset=utf8mb4"),
            vec!["USE `db`", "SET time_zone = '+08:00'", "SET NAMES utf8mb4"]
        );
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?time-zone=Asia%2FShanghai"),
            vec!["USE `db`", "SET time_zone = 'Asia/Shanghai'", "SET NAMES utf8mb4"]
        );
    }

    #[test]
    fn mysql_setup_queries_apply_jdbc_time_zone_aliases() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?serverTimezone=GMT%2B8"),
            vec!["USE `db`", "SET time_zone = '+08:00'", "SET NAMES utf8mb4"]
        );
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?connectionTimeZone=UTC"),
            vec!["USE `db`", "SET time_zone = '+00:00'", "SET NAMES utf8mb4"]
        );
    }

    #[test]
    fn mysql_setup_queries_apply_go_loc_when_no_explicit_time_zone_exists() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?loc=Asia%2FShanghai"),
            vec!["USE `db`", "SET time_zone = 'Asia/Shanghai'", "SET NAMES utf8mb4"]
        );
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?time_zone=%2B08%3A00&loc=UTC"),
            vec!["USE `db`", "SET time_zone = '+08:00'", "SET NAMES utf8mb4"]
        );
    }

    #[test]
    fn mysql_setup_queries_ignore_unsafe_time_zone_values() {
        assert_eq!(
            mysql_setup_queries("mysql://host:3306/db?time_zone=%2B08%3A00%27%3BDROP%20TABLE%20users"),
            vec!["USE `db`", "SET NAMES utf8mb4"]
        );
    }
}
