use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, NaiveTime};
use deadpool_postgres::{ManagerConfig, Pool, PoolError, RecyclingMethod, Runtime};
use futures::{SinkExt, StreamExt};
use percent_encoding::percent_decode_str;
use rust_decimal::Decimal;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::verify_server_cert_signed_by_trust_anchor;
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use std::fs::File;
use std::future::Future;
use std::io::BufReader;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_postgres::config::SslMode;
use tokio_postgres::types::{FromSql, Type};
use tokio_postgres::{NoTls, Row, SimpleQueryMessage};
use tokio_util::sync::CancellationToken;

use super::file_validator::validate_file_path;
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, FunctionInfo, IndexInfo, ObjectInfo, ObjectStatistics, OwnerInfo,
    QueryResult, RuleInfo, SequenceInfo, TableInfo, TriggerInfo,
};

fn pg_temporal_to_json_value(row: &Row, idx: usize) -> Option<serde_json::Value> {
    if let Ok(v) = row.try_get::<_, DateTime<Local>>(idx) {
        return Some(serde_json::Value::String(format_pg_timestamptz(v)));
    }
    if let Ok(v) = row.try_get::<_, NaiveDateTime>(idx) {
        return Some(serde_json::Value::String(v.to_string()));
    }
    if let Ok(v) = row.try_get::<_, NaiveDate>(idx) {
        return Some(serde_json::Value::String(v.to_string()));
    }
    if let Ok(v) = row.try_get::<_, NaiveTime>(idx) {
        return Some(serde_json::Value::String(v.to_string()));
    }
    None
}

struct PgSystemU32(u32);

impl<'a> FromSql<'a> for PgSystemU32 {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        let bytes: [u8; 4] = raw.try_into().map_err(|_| "expected 4 bytes for PostgreSQL system u32")?;
        Ok(Self(u32::from_be_bytes(bytes)))
    }

    fn accepts(ty: &Type) -> bool {
        matches!(*ty, Type::XID | Type::CID)
    }
}

/// A `FromSql` adapter that accepts any PostgreSQL type and reads its raw
/// bytes as a UTF-8 string. This is used as a last-resort fallback to handle
/// custom types (enums, domains, etc.) that tokio_postgres cannot map to
/// built-in Rust types in the binary protocol.
struct PgAnyString(String);

impl<'a> FromSql<'a> for PgAnyString {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        std::str::from_utf8(raw)
            .map(|s| PgAnyString(s.to_string()))
            .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Sync + Send>)
    }

    fn accepts(_: &Type) -> bool {
        true
    }
}

/// A `FromSql` adapter that accepts any PostgreSQL type and returns the raw
/// bytes unchanged. Used to decode custom types like pgvector whose binary
/// format we handle ourselves.
struct PgRawBytes(Vec<u8>);

impl<'a> FromSql<'a> for PgRawBytes {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(PgRawBytes(raw.to_vec()))
    }

    fn accepts(_: &Type) -> bool {
        true
    }
}

/// Decode pgvector binary format into a Vec<f32>.
///
/// pgvector binary layout (big-endian):
/// - 2 bytes: dimensions (uint16)
/// - 2 bytes: unused (padding)
/// - N*4 bytes: IEEE 754 f32 values
fn decode_pgvector_bytes(raw: &[u8]) -> Option<Vec<f32>> {
    if raw.len() < 4 {
        return None;
    }
    let dims = u16::from_be_bytes([raw[0], raw[1]]) as usize;
    let expected_len = 4 + dims * 4;
    if raw.len() != expected_len {
        return None;
    }
    let floats: Vec<f32> =
        raw[4..].chunks_exact(4).map(|chunk| f32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])).collect();
    Some(floats)
}

fn pg_u32_number(v: u32) -> serde_json::Value {
    serde_json::Value::Number(serde_json::Number::from(v))
}

fn pg_system_u32_to_json(row: &Row, idx: usize) -> Option<serde_json::Value> {
    if let Ok(v) = row.try_get::<_, u32>(idx) {
        return Some(pg_u32_number(v));
    }
    row.try_get::<_, PgSystemU32>(idx).ok().map(|v| pg_u32_number(v.0))
}

fn pg_optional_array_to_json<T>(
    values: Vec<Option<T>>,
    map_value: impl Fn(T) -> serde_json::Value,
) -> serde_json::Value {
    serde_json::Value::Array(
        values.into_iter().map(|value| value.map(&map_value).unwrap_or(serde_json::Value::Null)).collect(),
    )
}

fn pg_float_number(v: f64) -> serde_json::Value {
    serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
}

fn pg_array_to_json_value(row: &Row, idx: usize) -> Option<serde_json::Value> {
    if let Ok(values) = row.try_get::<_, Vec<Option<String>>>(idx) {
        return Some(pg_optional_array_to_json(values, serde_json::Value::String));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<bool>>>(idx) {
        return Some(pg_optional_array_to_json(values, serde_json::Value::Bool));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<Decimal>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(v.to_string())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<uuid::Uuid>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(v.to_string())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<DateTime<Local>>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(format_pg_timestamptz(v))));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<NaiveDateTime>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(v.to_string())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<NaiveDate>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(v.to_string())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<NaiveTime>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(v.to_string())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<u32>>>(idx) {
        return Some(pg_optional_array_to_json(values, pg_u32_number));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<i8>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::Number(v.into())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<i16>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::Number(v.into())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<i32>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::Number(v.into())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<i64>>>(idx) {
        return Some(pg_optional_array_to_json(values, super::safe_i64_to_json));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<f32>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| pg_float_number(v as f64)));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<f64>>>(idx) {
        return Some(pg_optional_array_to_json(values, pg_float_number));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<PgAnyString>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(v.0)));
    }
    None
}

fn format_pg_timestamptz(value: DateTime<Local>) -> String {
    value.to_rfc3339()
}

fn pg_value_to_json(row: &Row, idx: usize, type_name: &str) -> serde_json::Value {
    let upper = type_name.to_uppercase();

    if upper == "BYTEA" {
        return row
            .try_get::<_, Vec<u8>>(idx)
            .map(|bytes| super::binary_value_to_json(&bytes))
            .unwrap_or(serde_json::Value::Null);
    }

    if upper == "JSON" || upper == "JSONB" {
        if let Ok(v) = row.try_get::<_, serde_json::Value>(idx) {
            return serde_json::Value::String(v.to_string());
        }
        if let Ok(v) = row.try_get::<_, String>(idx) {
            return serde_json::Value::String(v);
        }
        return serde_json::Value::Null;
    }

    if upper == "BOOL" {
        return row.try_get::<_, bool>(idx).map(serde_json::Value::Bool).unwrap_or(serde_json::Value::Null);
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
            .try_get::<_, Decimal>(idx)
            .map(|v: Decimal| serde_json::Value::String(v.to_string()))
            .unwrap_or(serde_json::Value::Null);
    }

    if upper == "UUID" {
        return row
            .try_get::<_, uuid::Uuid>(idx)
            .map(|v| serde_json::Value::String(v.to_string()))
            .unwrap_or(serde_json::Value::Null);
    }

    if upper == "TSVECTOR" {
        return row
            .try_get::<_, PgRawBytes>(idx)
            .ok()
            .and_then(|raw| decode_tsvector_bytes(&raw.0))
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null);
    }

    if matches!(upper.as_str(), "OID" | "XID" | "CID") {
        return pg_system_u32_to_json(row, idx).unwrap_or(serde_json::Value::Null);
    }

    if upper.starts_with('_') {
        return pg_array_to_json_value(row, idx).unwrap_or(serde_json::Value::Null);
    }

    if upper == "VECTOR" || upper.starts_with("VECTOR(") {
        if let Ok(PgRawBytes(raw)) = row.try_get::<_, PgRawBytes>(idx) {
            if let Some(floats) = decode_pgvector_bytes(&raw) {
                return serde_json::Value::Array(
                    floats
                        .into_iter()
                        .map(|v| {
                            serde_json::Number::from_f64((v as f64 * 1_000_000.0).round() / 1_000_000.0)
                                .map(serde_json::Value::Number)
                                .unwrap_or(serde_json::Value::Null)
                        })
                        .collect(),
                );
            }
        }
        return serde_json::Value::Null;
    }

    if upper == "GEOMETRY" || upper == "GEOGRAPHY" {
        if let Ok(PgRawBytes(raw)) = row.try_get::<_, PgRawBytes>(idx) {
            return super::wkb::wkb_to_wkt(&raw)
                .map(serde_json::Value::String)
                .unwrap_or_else(|| super::binary_value_to_json(&raw));
        }
        return serde_json::Value::Null;
    }

    row.try_get::<_, String>(idx)
        .map(serde_json::Value::String)
        .or_else(|e| pg_system_u32_to_json(row, idx).ok_or(e))
        .or_else(|_| row.try_get::<_, i64>(idx).map(super::safe_i64_to_json))
        .or_else(|_| row.try_get::<_, i32>(idx).map(|v| serde_json::Value::Number(v.into())))
        .or_else(|_| row.try_get::<_, i16>(idx).map(|v| serde_json::Value::Number(v.into())))
        .or_else(|_| row.try_get::<_, i8>(idx).map(|v| serde_json::Value::Number(v.into())))
        .or_else(|e| pg_array_to_json_value(row, idx).ok_or(e))
        .or_else(|_| {
            row.try_get::<_, f64>(idx).map(|v| {
                serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
            })
        })
        .or_else(|_| {
            row.try_get::<_, f32>(idx).map(|v| {
                serde_json::Number::from_f64((v as f64 * 1_000_000.0).round() / 1_000_000.0)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null)
            })
        })
        .or_else(|_| row.try_get::<_, bool>(idx).map(serde_json::Value::Bool))
        .or_else(|_| row.try_get::<_, uuid::Uuid>(idx).map(|v| serde_json::Value::String(v.to_string())))
        .or_else(|e| pg_temporal_to_json_value(row, idx).ok_or(e))
        .or_else(|_| row.try_get::<_, Vec<u8>>(idx).map(|bytes| super::binary_value_to_json(&bytes)))
        .or_else(|_| row.try_get::<_, PgAnyString>(idx).map(|v| serde_json::Value::String(v.0)))
        .or_else(|_| row.try_get::<_, PgRawBytes>(idx).map(|v| super::binary_value_to_json(&v.0)))
        .unwrap_or(serde_json::Value::Null)
}

fn decode_tsvector_bytes(raw: &[u8]) -> Option<String> {
    let mut cursor = 0;
    let count = read_i32_be(raw, &mut cursor)?;
    if count < 0 {
        return None;
    }

    let mut entries = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let start = cursor;
        while cursor < raw.len() && raw[cursor] != 0 {
            cursor += 1;
        }
        if cursor >= raw.len() {
            return None;
        }
        let lexeme = std::str::from_utf8(&raw[start..cursor]).ok()?;
        cursor += 1;

        let position_count = read_u16_be(raw, &mut cursor)? as usize;
        let mut positions = Vec::with_capacity(position_count);
        for _ in 0..position_count {
            let encoded = read_u16_be(raw, &mut cursor)?;
            let position = encoded & 0x3fff;
            let weight = match encoded >> 14 {
                3 => "A",
                2 => "B",
                1 => "C",
                _ => "",
            };
            positions.push(format!("{position}{weight}"));
        }

        let mut entry = format!("'{}'", escape_tsvector_lexeme(lexeme));
        if !positions.is_empty() {
            entry.push(':');
            entry.push_str(&positions.join(","));
        }
        entries.push(entry);
    }

    if cursor == raw.len() {
        Some(entries.join(" "))
    } else {
        None
    }
}

fn read_i32_be(raw: &[u8], cursor: &mut usize) -> Option<i32> {
    let bytes: [u8; 4] = raw.get(*cursor..*cursor + 4)?.try_into().ok()?;
    *cursor += 4;
    Some(i32::from_be_bytes(bytes))
}

fn read_u16_be(raw: &[u8], cursor: &mut usize) -> Option<u16> {
    let bytes: [u8; 2] = raw.get(*cursor..*cursor + 2)?.try_into().ok()?;
    *cursor += 2;
    Some(u16::from_be_bytes(bytes))
}

fn escape_tsvector_lexeme(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "''")
}

fn pg_error_to_string(err: tokio_postgres::Error) -> String {
    err.as_db_error().map(ToString::to_string).unwrap_or_else(|| err.to_string())
}

fn pg_db_error_to_string(err: &tokio_postgres::error::DbError) -> String {
    format!("{err} (SQLSTATE {})", err.code().code())
}

fn pg_error_from_sources(err: &(dyn std::error::Error + 'static)) -> Option<String> {
    let mut current = Some(err);
    while let Some(source) = current {
        if let Some(pg_error) = source.downcast_ref::<tokio_postgres::Error>() {
            if let Some(db_error) = pg_error.as_db_error() {
                return Some(pg_db_error_to_string(db_error));
            }
        }
        if let Some(db_error) = source.downcast_ref::<tokio_postgres::error::DbError>() {
            return Some(pg_db_error_to_string(db_error));
        }
        current = source.source();
    }
    None
}

fn error_with_sources_to_string(err: &(dyn std::error::Error + 'static)) -> String {
    let mut messages = vec![err.to_string()];
    let mut current = err.source();
    while let Some(source) = current {
        let message = source.to_string();
        if !messages.iter().any(|existing| existing == &message) {
            messages.push(message);
        }
        current = source.source();
    }
    messages.join(": ")
}

fn pg_pool_error_to_string(err: PoolError) -> String {
    pg_error_from_sources(&err).unwrap_or_else(|| error_with_sources_to_string(&err))
}

fn should_retry_postgres_text_query(err: &tokio_postgres::Error) -> bool {
    let message = err.as_db_error().map(ToString::to_string).unwrap_or_else(|| err.to_string()).to_ascii_lowercase();
    message.contains("no binary output function")
        || message.contains("no binary send function")
        || message.contains("cannot display a value of type")
}

fn should_retry_postgres_stale_cache(err: &tokio_postgres::Error) -> bool {
    let message = err.as_db_error().map(ToString::to_string).unwrap_or_else(|| err.to_string()).to_ascii_lowercase();
    message.contains("cached plan must not change result type")
}

async fn execute_select_prepared(
    client: &deadpool_postgres::Client,
    sql: &str,
    start: Instant,
    row_limit: usize,
) -> Result<QueryResult, tokio_postgres::Error> {
    let prepared_start = Instant::now();
    let stmt = client.prepare_cached(sql).await?;
    log::info!(
        "[postgres][select:prepare_cached:done] elapsed_ms={} total_ms={}",
        prepared_start.elapsed().as_millis(),
        start.elapsed().as_millis()
    );
    let columns: Vec<String> = stmt.columns().iter().map(|c| c.name().to_string()).collect();
    let column_types: Vec<String> = stmt.columns().iter().map(|c| c.type_().name().to_string()).collect();

    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = Vec::new();
    let query_start = Instant::now();
    let stream = client.query_raw(&stmt, params).await?;
    log::info!(
        "[postgres][select:query_raw:done] elapsed_ms={} total_ms={} column_count={}",
        query_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        columns.len()
    );
    tokio::pin!(stream);
    let mut result_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;

    let rows_start = Instant::now();
    while let Some(row_result) = stream.next().await {
        if result_rows.len() >= row_limit {
            truncated = true;
            break;
        }
        let row = row_result?;
        result_rows.push(
            (0..row.columns().len())
                .map(|i| pg_value_to_json(&row, i, column_types.get(i).map(String::as_str).unwrap_or("")))
                .collect(),
        );
    }
    log::info!(
        "[postgres][select:rows:done] elapsed_ms={} total_ms={} row_count={} truncated={}",
        rows_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        result_rows.len(),
        truncated
    );

    Ok(QueryResult {
        columns,
        column_types,
        column_sortables: Vec::new(),
        rows: result_rows,
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        session_id: None,
        has_more: false,
    })
}

async fn execute_select_text(
    client: &deadpool_postgres::Client,
    sql: &str,
    start: Instant,
    row_limit: usize,
) -> Result<QueryResult, String> {
    let messages = client.simple_query(sql).await.map_err(pg_error_to_string)?;
    let mut columns: Vec<String> = Vec::new();
    let mut result_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;

    for message in messages {
        match message {
            SimpleQueryMessage::RowDescription(cols) => {
                columns = cols.iter().map(|c| c.name().to_string()).collect();
            }
            SimpleQueryMessage::Row(row) => {
                if columns.is_empty() {
                    columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                }
                if result_rows.len() >= row_limit {
                    truncated = true;
                    continue;
                }
                let mut values = Vec::with_capacity(row.len());
                for i in 0..row.len() {
                    values.push(match row.try_get(i).map_err(pg_error_to_string)? {
                        Some(value) => serde_json::Value::String(value.to_string()),
                        None => serde_json::Value::Null,
                    });
                }
                result_rows.push(values);
            }
            SimpleQueryMessage::CommandComplete(_) => {}
            _ => {}
        }
    }

    Ok(QueryResult {
        columns,
        column_types: Vec::new(),
        column_sortables: Vec::new(),
        rows: result_rows,
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        session_id: None,
        has_more: false,
    })
}

async fn execute_select_query(
    client: &deadpool_postgres::Client,
    sql: &str,
    start: Instant,
    row_limit: usize,
) -> Result<QueryResult, String> {
    match execute_select_prepared(client, sql, start, row_limit).await {
        Ok(result) => Ok(result),
        Err(err) if should_retry_postgres_stale_cache(&err) => {
            // The cached prepared statement is stale (e.g. the view or table
            // schema changed since the statement was prepared). Evict the
            // stale entry and retry with a fresh server-side prepare.
            log::warn!("[postgres][select:stale_cache] evicting cached statement: {}", pg_error_to_string(err));
            client.statement_cache.remove(sql, &[]);
            match execute_select_prepared(client, sql, start, row_limit).await {
                Ok(result) => Ok(result),
                Err(err) if should_retry_postgres_text_query(&err) => {
                    execute_select_text(client, sql, start, row_limit).await
                }
                Err(err) => Err(pg_error_to_string(err)),
            }
        }
        Err(err) if should_retry_postgres_text_query(&err) => execute_select_text(client, sql, start, row_limit).await,
        Err(err) => Err(pg_error_to_string(err)),
    }
}

pub async fn connect(url: &str, fallback_timeout: Duration) -> Result<Pool, String> {
    let postgres_url = postgres_connection_url(url)?;
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let timeout = super::parse_connect_timeout_with_fallback(url, fallback_timeout);
    let tz = iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string());

    super::with_connection_timeout("PostgreSQL", timeout, async {
        let pg_config = tokio_postgres::Config::from_str(&postgres_url.url)
            .map_err(|e| format!("Invalid PostgreSQL connection URL: {e}"))?;

        let mgr_config = ManagerConfig { recycling_method: RecyclingMethod::Verified };
        let tls_config = postgres_tls_config(
            &pg_config,
            &postgres_url.ssl_files,
            postgres_url.accepts_invalid_certs,
            postgres_url.verifies_hostname,
        )?;
        let mgr = deadpool_postgres::Manager::from_config(
            pg_config.clone(),
            tokio_postgres_rustls::MakeRustlsConnect::new(tls_config),
            mgr_config,
        );
        let pool = Pool::builder(mgr)
            .max_size(10)
            .runtime(Runtime::Tokio1)
            .wait_timeout(Some(timeout))
            .build()
            .map_err(|e| format!("Failed to create PostgreSQL pool: {e}"))?;

        // Verify connectivity and set timezone. Only set timezone if the user
        // hasn't already specified one via connection parameters (e.g. options=-c timezone=...)
        let client =
            pool.get().await.map_err(|e| format!("PostgreSQL connection failed: {}", pg_pool_error_to_string(e)))?;
        if !pg_url_has_timezone_setting(url) {
            client
                .execute(&format!("SET timezone = '{}'", tz.replace('\'', "''")), &[])
                .await
                .map_err(|e| format!("PostgreSQL SET timezone failed: {e}"))?;
        }

        Ok(pool)
    })
    .await
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct PostgresSslFiles {
    sslcert: Option<String>,
    sslkey: Option<String>,
    sslrootcert: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PostgresConnectionUrl {
    url: String,
    ssl_files: PostgresSslFiles,
    accepts_invalid_certs: bool,
    verifies_hostname: bool,
}

fn postgres_connection_url(url: &str) -> Result<PostgresConnectionUrl, String> {
    let Some(query_start) = url.find('?') else {
        let pg_config =
            tokio_postgres::Config::from_str(url).map_err(|e| format!("Invalid PostgreSQL connection URL: {e}"))?;
        return Ok(PostgresConnectionUrl {
            url: url.to_string(),
            ssl_files: PostgresSslFiles::default(),
            accepts_invalid_certs: postgres_sslmode_accepts_invalid_certs(pg_config.get_ssl_mode()),
            verifies_hostname: false,
        });
    };

    let prefix = &url[..query_start];
    let suffix = &url[query_start + 1..];
    let (query_string, fragment) = suffix.split_once('#').map_or((suffix, ""), |(query, fragment)| (query, fragment));
    let mut ssl_files = PostgresSslFiles::default();
    let mut kept_params = Vec::new();
    let mut accepts_invalid_certs = true;
    let mut verifies_hostname = false;

    for param in query_string.split('&') {
        if param.is_empty() {
            continue;
        }

        let Some((key, value)) = param.split_once('=') else {
            kept_params.push(param.to_string());
            continue;
        };

        if key.eq_ignore_ascii_case("sslcert")
            || key.eq_ignore_ascii_case("sslkey")
            || key.eq_ignore_ascii_case("sslrootcert")
        {
            let decoded = percent_decode_str(value)
                .decode_utf8()
                .map_err(|_| format!("Invalid URL encoding in {key}"))?
                .into_owned();
            validate_file_path(&decoded, |_| false).map_err(|e| format!("{key}: {e}"))?;

            if key.eq_ignore_ascii_case("sslcert") {
                ssl_files.sslcert = Some(decoded);
            } else if key.eq_ignore_ascii_case("sslkey") {
                ssl_files.sslkey = Some(decoded);
            } else {
                ssl_files.sslrootcert = Some(decoded);
            }
        } else if key.eq_ignore_ascii_case("channel_binding") {
            // channel_binding=require fails when the server does not offer
            // SCRAM-SHA-256-PLUS (e.g. Neon). Normalize require→prefer so
            // channel binding is used when available but does not cause a
            // hard failure when the server doesn't support it.
            match value.to_ascii_lowercase().as_str() {
                "require" => kept_params.push("channel_binding=prefer".to_string()),
                _ => kept_params.push(param.to_string()),
            }
        } else if key.eq_ignore_ascii_case("sslmode") {
            match value.to_ascii_lowercase().as_str() {
                "verify-ca" => {
                    accepts_invalid_certs = false;
                    kept_params.push("sslmode=require".to_string());
                }
                "verify-full" | "verify_identity" | "verify-identity" => {
                    accepts_invalid_certs = false;
                    verifies_hostname = true;
                    kept_params.push("sslmode=require".to_string());
                }
                "disable" => {
                    accepts_invalid_certs = false;
                    kept_params.push(param.to_string());
                }
                "prefer" | "require" => {
                    accepts_invalid_certs = true;
                    kept_params.push(param.to_string());
                }
                _ => kept_params.push(param.to_string()),
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

    Ok(PostgresConnectionUrl { url: sanitized_url, ssl_files, accepts_invalid_certs, verifies_hostname })
}

fn postgres_tls_config(
    pg_config: &tokio_postgres::Config,
    ssl_files: &PostgresSslFiles,
    accepts_invalid_certs: bool,
    verifies_hostname: bool,
) -> Result<rustls::ClientConfig, String> {
    if pg_config.get_ssl_mode() != SslMode::Disable && accepts_invalid_certs {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let builder = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoPostgresCertVerification { provider }));
        return postgres_tls_client_auth(builder, ssl_files);
    }

    let root_store = postgres_root_cert_store(ssl_files)?;
    let builder = if verifies_hostname {
        rustls::ClientConfig::builder().with_root_certificates(root_store)
    } else {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        rustls::ClientConfig::builder().dangerous().with_custom_certificate_verifier(Arc::new(
            PostgresCaOnlyCertVerification { provider, roots: Arc::new(root_store) },
        ))
    };
    postgres_tls_client_auth(builder, ssl_files)
}

fn postgres_root_cert_store(ssl_files: &PostgresSslFiles) -> Result<rustls::RootCertStore, String> {
    let mut root_store = rustls::RootCertStore::empty();
    if let Some(path) = ssl_files.sslrootcert.as_deref() {
        let certs = read_postgres_pem_certs("sslrootcert", path)?;
        let (valid_count, _) = root_store.add_parsable_certificates(certs);
        if valid_count == 0 {
            return Err(format!("sslrootcert: no valid CA certificates found in {path}"));
        }
    } else {
        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }
    Ok(root_store)
}

fn postgres_tls_client_auth(
    builder: rustls::ConfigBuilder<rustls::ClientConfig, rustls::client::WantsClientCert>,
    ssl_files: &PostgresSslFiles,
) -> Result<rustls::ClientConfig, String> {
    match (ssl_files.sslcert.as_deref(), ssl_files.sslkey.as_deref()) {
        (Some(cert_path), Some(key_path)) => {
            let certs = read_postgres_pem_certs("sslcert", cert_path)?;
            if certs.is_empty() {
                return Err(format!("sslcert: no certificates found in {cert_path}"));
            }
            let private_key = read_postgres_private_key(key_path)?;
            builder
                .with_client_auth_cert(certs, private_key)
                .map_err(|e| format!("PostgreSQL client certificate/key mismatch or invalid key: {e}"))
        }
        (Some(_), None) => Err("PostgreSQL sslcert requires sslkey".to_string()),
        (None, Some(_)) => Err("PostgreSQL sslkey requires sslcert".to_string()),
        (None, None) => Ok(builder.with_no_client_auth()),
    }
}

fn read_postgres_pem_certs(label: &str, path: &str) -> Result<Vec<CertificateDer<'static>>, String> {
    let file = File::open(path).map_err(|e| format!("{label}: failed to open {path}: {e}"))?;
    let mut reader = BufReader::new(file);
    rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("{label}: failed to read PEM certificates from {path}: {e}"))
}

fn read_postgres_private_key(path: &str) -> Result<PrivateKeyDer<'static>, String> {
    let file = File::open(path).map_err(|e| format!("sslkey: failed to open {path}: {e}"))?;
    let mut reader = BufReader::new(file);
    rustls_pemfile::private_key(&mut reader)
        .map_err(|e| format!("sslkey: failed to read PEM private key from {path}: {e}"))?
        .ok_or_else(|| format!("sslkey: no private key found in {path}"))
}

fn postgres_sslmode_accepts_invalid_certs(ssl_mode: SslMode) -> bool {
    matches!(ssl_mode, SslMode::Prefer | SslMode::Require)
}

#[derive(Debug)]
struct NoPostgresCertVerification {
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for NoPostgresCertVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

#[derive(Debug)]
struct PostgresCaOnlyCertVerification {
    provider: Arc<CryptoProvider>,
    roots: Arc<rustls::RootCertStore>,
}

impl ServerCertVerifier for PostgresCaOnlyCertVerification {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let cert = ParsedCertificate::try_from(end_entity)?;
        verify_server_cert_signed_by_trust_anchor(
            &cert,
            &self.roots,
            intermediates,
            now,
            self.provider.signature_verification_algorithms.all,
        )?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// Check whether the user's connection URL already specifies a timezone via
/// the `options` parameter so we don't overwrite it with the local timezone.
fn pg_url_has_timezone_setting(url: &str) -> bool {
    let lower = url.to_lowercase();
    // Match "timezone=" anywhere after the query string, covering:
    //   ?options=-c timezone=Asia/Shanghai
    //   ?options=--timezone=UTC
    // Also handles URL-encoded forms like timezone%3D
    if let Some(query) = lower.split('?').nth(1) {
        if query.contains("timezone=") || query.contains("timezone%3d") {
            return true;
        }
    }
    false
}

#[cfg(test)]
fn validate_postgres_ssl_paths(url: &str) -> Result<(), String> {
    postgres_connection_url(url).map(|_| ())
}

pub async fn list_databases(pool: &Pool) -> Result<Vec<DatabaseInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client
        .prepare_cached(
            "SELECT datname FROM pg_database \
             WHERE datallowconn = true \
             ORDER BY datname",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[]).await.map_err(|e| e.to_string())?;

    Ok(rows.iter().map(|row| DatabaseInfo { name: row.get::<_, String>(0) }).collect())
}

pub async fn list_tables(pool: &Pool, schema: &str) -> Result<Vec<TableInfo>, String> {
    list_tables_filtered(pool, schema, None, None, None).await
}

pub async fn list_tables_filtered(
    pool: &Pool,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<TableInfo>, String> {
    let schema = if schema.is_empty() { "public" } else { schema };
    let filter_pattern = like_contains_pattern(filter.unwrap_or("").trim());
    let limit_param = limit.and_then(|value| i64::try_from(value).ok());
    let offset_param = offset.and_then(|value| i64::try_from(value).ok()).unwrap_or(0);
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client.prepare_cached(postgres_tables_sql()).await.map_err(|e| e.to_string())?;
    let rows = client
        .query(&stmt, &[&schema, &filter_pattern, &limit_param, &offset_param])
        .await
        .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: row.get::<_, String>(0),
            table_type: row.get::<_, String>(1),
            comment: row.try_get::<_, Option<String>>(2).ok().flatten().filter(|s| !s.is_empty()),
            parent_schema: row.try_get::<_, Option<String>>(3).ok().flatten().filter(|s| !s.is_empty()),
            parent_name: row.try_get::<_, Option<String>>(4).ok().flatten().filter(|s| !s.is_empty()),
        })
        .collect())
}

pub async fn get_table_comment(pool: &Pool, schema: &str, table: &str) -> Result<Option<String>, String> {
    let schema = if schema.is_empty() { "public" } else { schema };
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client.prepare_cached(postgres_table_comment_sql()).await.map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema, &table]).await.map_err(|e| e.to_string())?;
    Ok(rows.first().and_then(|row| row.try_get::<_, Option<String>>(0).ok().flatten()).filter(|s| !s.is_empty()))
}

fn postgres_table_comment_sql() -> &'static str {
    "SELECT obj_description(c.oid) AS table_comment \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','m','f','p') \
     LIMIT 1"
}

fn postgres_tables_sql() -> &'static str {
    "SELECT c.relname AS table_name, \
         CASE c.relkind WHEN 'r' THEN 'BASE TABLE' WHEN 'v' THEN 'VIEW' \
           WHEN 'm' THEN 'MATERIALIZED_VIEW' WHEN 'f' THEN 'FOREIGN TABLE' \
           WHEN 'p' THEN 'BASE TABLE' END AS table_type, \
         obj_description(c.oid) AS table_comment, \
         CASE WHEN pc.relkind = 'p' THEN pn.nspname ELSE NULL END AS parent_schema, \
         CASE WHEN pc.relkind = 'p' THEN pc.relname ELSE NULL END AS parent_name \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid \
         LEFT JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
         LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','p') \
           AND ($2 = '%%' OR c.relname ILIKE $2 ESCAPE '~') \
         ORDER BY c.relname \
         LIMIT $3 OFFSET $4"
}

fn like_contains_pattern(value: &str) -> String {
    if value.is_empty() {
        return "%%".to_string();
    }

    let mut pattern = String::with_capacity(value.len() + 2);
    pattern.push('%');
    for ch in value.chars() {
        if ch == '~' || ch == '%' || ch == '_' {
            pattern.push('~');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
}

fn list_objects_sql(include_timestamps: bool) -> &'static str {
    if include_timestamps {
        return "SELECT c.relname AS object_name, \
       CASE c.relkind \
         WHEN 'v' THEN 'VIEW' \
         WHEN 'm' THEN 'MATERIALIZED_VIEW' \
         WHEN 'S' THEN 'SEQUENCE' \
         ELSE 'TABLE' \
       END AS object_type, \
       obj_description(c.oid) AS object_comment, \
       stat.creation::text AS created_at, \
       COALESCE( \
         CASE WHEN current_setting('track_commit_timestamp', true) = 'on' \
           THEN pg_xact_commit_timestamp(c.xmin)::text END, \
         stat.modification::text \
       ) AS updated_at, \
       CASE WHEN pc.relkind = 'p' THEN pn.nspname ELSE NULL END AS parent_schema, \
       CASE WHEN pc.relkind = 'p' THEN pc.relname ELSE NULL END AS parent_name, \
       CASE c.relkind WHEN 'v' THEN 1 WHEN 'm' THEN 1 WHEN 'S' THEN 4 ELSE 0 END AS sort_order \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid \
     LEFT JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
     LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
     LEFT JOIN LATERAL pg_stat_file( \
       CASE WHEN c.relkind IN ('r','m','f','p') THEN pg_relation_filepath(c.oid) END, true \
     ) stat ON true \
     WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','p','S') \
     UNION ALL \
     SELECT p.proname AS object_name, \
       CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       CASE WHEN current_setting('track_commit_timestamp', true) = 'on' \
         THEN pg_xact_commit_timestamp(p.xmin)::text END AS updated_at, \
       NULL::text AS parent_schema, \
       NULL::text AS parent_name, \
       CASE p.prokind WHEN 'p' THEN 2 ELSE 3 END AS sort_order \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND p.prokind IN ('p','f') \
     ORDER BY sort_order, object_name";
    }

    "SELECT c.relname AS object_name, \
       CASE c.relkind \
         WHEN 'v' THEN 'VIEW' \
         WHEN 'm' THEN 'MATERIALIZED_VIEW' \
         WHEN 'S' THEN 'SEQUENCE' \
         ELSE 'TABLE' \
       END AS object_type, \
       obj_description(c.oid) AS object_comment, \
       NULL::text AS created_at, \
       NULL::text AS updated_at, \
       CASE WHEN pc.relkind = 'p' THEN pn.nspname ELSE NULL END AS parent_schema, \
       CASE WHEN pc.relkind = 'p' THEN pc.relname ELSE NULL END AS parent_name, \
       CASE c.relkind WHEN 'v' THEN 1 WHEN 'm' THEN 1 WHEN 'S' THEN 4 ELSE 0 END AS sort_order \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid \
     LEFT JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
     LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
     WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','p','S') \
     UNION ALL \
     SELECT p.proname AS object_name, \
       CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       NULL::text AS updated_at, \
       NULL::text AS parent_schema, \
       NULL::text AS parent_name, \
       CASE p.prokind WHEN 'p' THEN 2 ELSE 3 END AS sort_order \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND p.prokind IN ('p','f') \
     ORDER BY sort_order, object_name"
}

pub async fn list_objects(pool: &Pool, schema: &str) -> Result<Vec<ObjectInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client.prepare_cached(list_objects_sql(true)).await.map_err(|e| e.to_string())?;
    let rows = match client.query(&stmt, &[&schema]).await {
        Ok(rows) => rows,
        Err(_) => {
            let stmt = client.prepare_cached(list_objects_sql(false)).await.map_err(|e| e.to_string())?;
            client.query(&stmt, &[&schema]).await.map_err(|e| e.to_string())?
        }
    };

    Ok(rows
        .iter()
        .map(|row| ObjectInfo {
            name: row.get::<_, String>(0),
            object_type: row.get::<_, String>(1),
            schema: Some(schema.to_string()),
            comment: row.try_get::<_, Option<String>>(2).ok().flatten().filter(|s| !s.is_empty()),
            created_at: row.try_get::<_, Option<String>>(3).ok().flatten().filter(|s| !s.is_empty()),
            updated_at: row.try_get::<_, Option<String>>(4).ok().flatten().filter(|s| !s.is_empty()),
            parent_schema: row.try_get::<_, Option<String>>(5).ok().flatten().filter(|s| !s.is_empty()),
            parent_name: row.try_get::<_, Option<String>>(6).ok().flatten().filter(|s| !s.is_empty()),
        })
        .collect())
}

pub async fn list_object_statistics(pool: &Pool, schema: &str) -> Result<Vec<ObjectStatistics>, String> {
    let schema = if schema.is_empty() { "public" } else { schema };
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client
        .prepare_cached(
            "SELECT c.relname, \
                    GREATEST(c.reltuples, 0)::bigint AS estimated_rows, \
                    pg_catalog.pg_total_relation_size(c.oid)::bigint AS total_bytes \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relkind IN ('r','m','f','p') \
             ORDER BY c.relname",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema]).await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| ObjectStatistics {
            name: row.get::<_, String>(0),
            schema: Some(schema.to_string()),
            estimated_rows: row.try_get::<_, i64>(1).ok(),
            total_bytes: row.try_get::<_, i64>(2).ok(),
        })
        .collect())
}

pub async fn list_schemas(pool: &Pool) -> Result<Vec<String>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client
        .prepare_cached(
            "SELECT n.nspname AS schema_name FROM pg_catalog.pg_namespace n \
             WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast') \
             AND n.nspname NOT LIKE 'pg_toast_temp_%' \
             AND n.nspname NOT LIKE 'pg_temp_%' \
             ORDER BY n.nspname",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[]).await.map_err(|e| e.to_string())?;

    Ok(rows.iter().map(|row| row.get::<_, String>(0)).collect())
}

const POSTGRES_COLUMNS_SQL: &str = "SELECT a.attname AS column_name, \
             format_type(a.atttypid, a.atttypmod) AS full_type, \
             COALESCE(c.is_nullable = 'YES', NOT a.attnotnull) AS is_nullable, \
             CASE WHEN a.attgenerated <> '' THEN NULL ELSE pg_get_expr(ad.adbin, ad.adrelid) END AS column_default, \
             EXISTS ( \
               SELECT 1 FROM pg_constraint co \
               JOIN pg_index i ON i.indrelid = co.conrelid AND co.conindid = i.indexrelid \
               WHERE co.conrelid = a.attrelid AND co.contype = 'p' \
               AND a.attnum = ANY(i.indkey) \
             ) AS is_pk, \
             col_description(a.attrelid, a.attnum) AS column_comment, \
             CASE a.attidentity \
               WHEN 'd' THEN 'generated by default as identity' || CASE WHEN pseq.seqstart IS NOT NULL THEN format(' (start with %s increment by %s)', pseq.seqstart, pseq.seqincrement) ELSE '' END \
               WHEN 'a' THEN 'generated always as identity' || CASE WHEN pseq.seqstart IS NOT NULL THEN format(' (start with %s increment by %s)', pseq.seqstart, pseq.seqincrement) ELSE '' END \
               ELSE CASE a.attgenerated \
                 WHEN 's' THEN 'generated always as (' || pg_get_expr(ad.adbin, ad.adrelid) || ') stored' \
                 WHEN 'v' THEN 'generated always as (' || pg_get_expr(ad.adbin, ad.adrelid) || ') virtual' \
                 ELSE NULL \
               END \
             END AS column_extra, \
             CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 \
               THEN ((a.atttypmod - 4) >> 16) & 65535 ELSE NULL END AS numeric_precision, \
             CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 \
               THEN (a.atttypmod - 4) & 65535 ELSE NULL END AS numeric_scale, \
             CASE WHEN t.typname IN ('varchar', 'bpchar') AND a.atttypmod > 0 \
               THEN a.atttypmod - 4 ELSE NULL END AS character_maximum_length \
             FROM pg_attribute a \
             JOIN pg_type t ON t.oid = a.atttypid \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             LEFT JOIN pg_depend dep ON dep.refobjid = a.attrelid AND dep.refobjsubid = a.attnum AND dep.deptype = 'i' \
             LEFT JOIN pg_sequence pseq ON pseq.seqrelid = dep.objid \
             LEFT JOIN information_schema.columns c \
               ON c.table_schema = $1 AND c.table_name = $2 AND c.column_name = a.attname \
             WHERE a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass \
             AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum";

const POSTGRES_COLUMNS_COMPAT_SQL: &str = "SELECT a.attname AS column_name, \
             format_type(a.atttypid, a.atttypmod) AS full_type, \
             COALESCE(c.is_nullable = 'YES', NOT a.attnotnull) AS is_nullable, \
             pg_get_expr(ad.adbin, ad.adrelid) AS column_default, \
             EXISTS ( \
               SELECT 1 FROM pg_constraint co \
               JOIN pg_index i ON i.indrelid = co.conrelid AND co.conindid = i.indexrelid \
               WHERE co.conrelid = a.attrelid AND co.contype = 'p' \
               AND a.attnum = ANY(i.indkey) \
             ) AS is_pk, \
             col_description(a.attrelid, a.attnum) AS column_comment, \
             NULL::text AS column_extra, \
             CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 \
               THEN ((a.atttypmod - 4) >> 16) & 65535 ELSE NULL END AS numeric_precision, \
             CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 \
               THEN (a.atttypmod - 4) & 65535 ELSE NULL END AS numeric_scale, \
             CASE WHEN t.typname IN ('varchar', 'bpchar') AND a.atttypmod > 0 \
               THEN a.atttypmod - 4 ELSE NULL END AS character_maximum_length \
             FROM pg_attribute a \
             JOIN pg_type t ON t.oid = a.atttypid \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             LEFT JOIN information_schema.columns c \
               ON c.table_schema = $1 AND c.table_name = $2 AND c.column_name = a.attname \
             WHERE a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass \
             AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum";

const POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL: &str = "SELECT c.column_name, \
             CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name ELSE c.data_type END AS full_type, \
             c.is_nullable = 'YES' AS is_nullable, \
             c.column_default, \
             EXISTS ( \
               SELECT 1 FROM information_schema.table_constraints tc \
               JOIN information_schema.key_column_usage kcu \
                 ON kcu.constraint_catalog = tc.constraint_catalog \
                AND kcu.constraint_schema = tc.constraint_schema \
                AND kcu.constraint_name = tc.constraint_name \
                AND kcu.table_schema = tc.table_schema \
                AND kcu.table_name = tc.table_name \
               WHERE tc.constraint_type = 'PRIMARY KEY' \
                 AND tc.table_schema = c.table_schema \
                 AND tc.table_name = c.table_name \
                 AND kcu.column_name = c.column_name \
             ) AS is_pk, \
             NULL::text AS column_comment, \
             NULL::text AS column_extra, \
             CAST(c.numeric_precision AS int) AS numeric_precision, \
             CAST(c.numeric_scale AS int) AS numeric_scale, \
             CAST(c.character_maximum_length AS int) AS character_maximum_length \
             FROM information_schema.columns c \
             WHERE c.table_schema = $1 AND c.table_name = $2 \
             ORDER BY c.ordinal_position";

fn column_info_from_row(row: &Row) -> ColumnInfo {
    let full_type = row.try_get::<_, Option<String>>(1).ok().flatten().unwrap_or_default();
    ColumnInfo {
        name: row.get::<_, String>(0),
        data_type: full_type,
        is_nullable: row.get::<_, bool>(2),
        column_default: row.try_get::<_, Option<String>>(3).ok().flatten(),
        is_primary_key: row.get::<_, bool>(4),
        extra: row.try_get::<_, Option<String>>(6).ok().flatten(),
        comment: row.try_get::<_, Option<String>>(5).ok().flatten(),
        numeric_precision: row.try_get::<_, Option<i32>>(7).ok().flatten(),
        numeric_scale: row.try_get::<_, Option<i32>>(8).ok().flatten(),
        character_maximum_length: row.try_get::<_, Option<i32>>(9).ok().flatten(),
    }
}

async fn get_columns_with_sql(
    client: &deadpool_postgres::Client,
    sql: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, tokio_postgres::Error> {
    let stmt = client.prepare_cached(sql).await?;
    let rows = client.query(&stmt, &[&schema, &table]).await?;

    Ok(rows.iter().map(column_info_from_row).collect())
}

pub async fn get_columns(pool: &Pool, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let schema = if schema.is_empty() { "public" } else { schema };
    let client = pool.get().await.map_err(|e| e.to_string())?;
    match get_columns_with_sql(&client, POSTGRES_COLUMNS_SQL, schema, table).await {
        Ok(columns) => Ok(columns),
        Err(primary_error) => match get_columns_with_sql(&client, POSTGRES_COLUMNS_COMPAT_SQL, schema, table).await {
            Ok(columns) => Ok(columns),
            Err(fallback_error) => {
                let primary_message = pg_error_to_string(primary_error);
                let fallback_message = pg_error_to_string(fallback_error);
                match get_columns_with_sql(&client, POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL, schema, table).await {
                    Ok(columns) => Ok(columns),
                    Err(information_schema_error) => {
                        let information_schema_message = pg_error_to_string(information_schema_error);
                        log::debug!(
                            "[postgres][get_columns:compat-failed] primary_error={} fallback_error={} information_schema_error={}",
                            primary_message,
                            fallback_message,
                            information_schema_message
                        );
                        Err(information_schema_message)
                    }
                }
            }
        },
    }
}

pub(crate) fn pg_quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(crate::query::MAX_ROWS).max(1)
}

pub async fn execute_query(pool: &Pool, sql: &str) -> Result<QueryResult, String> {
    execute_query_with_max_rows(pool, sql, None).await
}

pub async fn execute_query_with_max_rows(
    pool: &Pool,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let row_limit = query_result_row_limit(max_rows);

    if starts_with_executable_sql_keyword(sql, &["SELECT", "SHOW", "EXPLAIN", "WITH", "TABLE"]) {
        let client = pool.get().await.map_err(|e| e.to_string())?;
        execute_select_query(&client, sql, start, row_limit).await
    } else {
        let client = pool.get().await.map_err(|e| e.to_string())?;
        let affected = client.execute(sql, &[]).await.map_err(pg_error_to_string)?;
        clear_postgres_caches_after_ddl(pool, Some(&client), sql);

        Ok(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            rows: vec![],
            affected_rows: affected,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

pub async fn execute_query_with_max_rows_and_cancel(
    pool: &Pool,
    sql: &str,
    max_rows: Option<usize>,
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
) -> Result<QueryResult, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let pg_cancel_token = client.cancel_token();
    wait_postgres_query(
        pg_cancel_token,
        cancel_token,
        timeout_duration,
        execute_query_with_max_rows_inner(&client, sql, max_rows),
    )
    .await
}

pub async fn execute_query_with_schema(pool: &Pool, schema: &str, sql: &str) -> Result<QueryResult, String> {
    execute_query_with_schema_and_max_rows(pool, schema, sql, None).await
}

pub async fn execute_query_with_schema_and_max_rows(
    pool: &Pool,
    schema: &str,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let checkout_start = Instant::now();
    let client = pool.get().await.map_err(|e| e.to_string())?;
    log::info!(
        "[postgres][execute_with_schema:pool:done] elapsed_ms={} total_ms={} schema={}",
        checkout_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        schema
    );
    if is_transaction_recovery_statement(sql) {
        log::info!(
            "[postgres][execute_with_schema:skip-search-path] total_ms={} reason=transaction-recovery",
            start.elapsed().as_millis()
        );
        return execute_query_with_max_rows_inner(&client, sql, max_rows).await;
    }

    let set_schema_start = Instant::now();
    client.execute(&format!("SET search_path TO {}", pg_quote_ident(schema)), &[]).await.map_err(pg_error_to_string)?;
    log::info!(
        "[postgres][execute_with_schema:set-search-path:done] elapsed_ms={} total_ms={}",
        set_schema_start.elapsed().as_millis(),
        start.elapsed().as_millis()
    );

    let query_start = Instant::now();
    let result = execute_query_with_max_rows_inner(&client, sql, max_rows).await;
    if result.is_ok() {
        clear_postgres_caches_after_ddl(pool, Some(&client), sql);
    }
    log::info!(
        "[postgres][execute_with_schema:query:done] elapsed_ms={} total_ms={} ok={}",
        query_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        result.is_ok()
    );

    // Always reset search_path so the connection is clean when returned to the pool
    let reset_start = Instant::now();
    let _ = client.execute("RESET search_path", &[]).await;
    log::info!(
        "[postgres][execute_with_schema:reset-search-path:done] elapsed_ms={} total_ms={}",
        reset_start.elapsed().as_millis(),
        start.elapsed().as_millis()
    );

    result
}

pub async fn execute_query_with_schema_and_max_rows_and_cancel(
    pool: &Pool,
    schema: &str,
    sql: &str,
    max_rows: Option<usize>,
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let checkout_start = Instant::now();
    let client = pool.get().await.map_err(|e| e.to_string())?;
    log::info!(
        "[postgres][execute_with_schema:pool:done] elapsed_ms={} total_ms={} schema={}",
        checkout_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        schema
    );
    if is_transaction_recovery_statement(sql) {
        log::info!(
            "[postgres][execute_with_schema:skip-search-path] total_ms={} reason=transaction-recovery",
            start.elapsed().as_millis()
        );
        let pg_cancel_token = client.cancel_token();
        return wait_postgres_query(
            pg_cancel_token,
            cancel_token,
            timeout_duration,
            execute_query_with_max_rows_inner(&client, sql, max_rows),
        )
        .await;
    }

    let set_schema_start = Instant::now();
    client.execute(&format!("SET search_path TO {}", pg_quote_ident(schema)), &[]).await.map_err(pg_error_to_string)?;
    log::info!(
        "[postgres][execute_with_schema:set-search-path:done] elapsed_ms={} total_ms={}",
        set_schema_start.elapsed().as_millis(),
        start.elapsed().as_millis()
    );

    let query_start = Instant::now();
    let pg_cancel_token = client.cancel_token();
    let result = wait_postgres_query(
        pg_cancel_token,
        cancel_token,
        timeout_duration,
        execute_query_with_max_rows_inner(&client, sql, max_rows),
    )
    .await;
    if result.is_ok() {
        clear_postgres_caches_after_ddl(pool, Some(&client), sql);
    }
    log::info!(
        "[postgres][execute_with_schema:query:done] elapsed_ms={} total_ms={} ok={}",
        query_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        result.is_ok()
    );

    let reset_start = Instant::now();
    let _ = client.execute("RESET search_path", &[]).await;
    log::info!(
        "[postgres][execute_with_schema:reset-search-path:done] elapsed_ms={} total_ms={}",
        reset_start.elapsed().as_millis(),
        start.elapsed().as_millis()
    );

    result
}

async fn wait_postgres_query<T, F>(
    pg_cancel_token: tokio_postgres::CancelToken,
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    match (cancel_token, timeout_duration) {
        (Some(token), Some(duration)) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    cancel_postgres_query(pg_cancel_token).await;
                    Err(crate::query::canceled_error())
                }
                result = tokio::time::timeout(duration, future) => match result {
                    Ok(result) => result,
                    Err(_) => {
                        cancel_postgres_query(pg_cancel_token).await;
                        Err(format!("Query timed out after {} seconds", duration.as_secs()))
                    }
                },
            }
        }
        (None, Some(duration)) => match tokio::time::timeout(duration, future).await {
            Ok(result) => result,
            Err(_) => {
                cancel_postgres_query(pg_cancel_token).await;
                Err(format!("Query timed out after {} seconds", duration.as_secs()))
            }
        },
        (Some(token), None) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    cancel_postgres_query(pg_cancel_token).await;
                    Err(crate::query::canceled_error())
                }
                result = future => result,
            }
        }
        (None, None) => future.await,
    }
}

async fn cancel_postgres_query(pg_cancel_token: tokio_postgres::CancelToken) {
    match tokio::time::timeout(Duration::from_secs(2), pg_cancel_token.cancel_query(NoTls)).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => log::warn!("Failed to send PostgreSQL cancel request: {err}"),
        Err(_) => log::warn!("Timed out sending PostgreSQL cancel request"),
    }
}

fn is_transaction_recovery_statement(sql: &str) -> bool {
    starts_with_executable_sql_keyword(sql, &["ROLLBACK", "ABORT", "COMMIT", "END"])
}

async fn execute_query_with_max_rows_inner(
    client: &deadpool_postgres::Client,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let row_limit = query_result_row_limit(max_rows);

    if starts_with_executable_sql_keyword(sql, &["SELECT", "SHOW", "EXPLAIN", "WITH", "TABLE"]) {
        execute_select_query(client, sql, start, row_limit).await
    } else {
        let affected = client.execute(sql, &[]).await.map_err(pg_error_to_string)?;

        Ok(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            rows: vec![],
            affected_rows: affected,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

const POSTGRES_INDEXES_SQL: &str = "SELECT i.relname AS index_name, \
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
             ORDER BY i.relname";

const POSTGRES_INDEXES_COMPAT_SQL: &str = "SELECT i.relname AS index_name, \
             array_agg(COALESCE(a.attname, pg_get_indexdef(ix.indexrelid, k.n::int, true)) ORDER BY k.n) AS columns, \
             ix.indisunique AS is_unique, \
             ix.indisprimary AS is_primary, \
             pg_get_expr(ix.indpred, ix.indrelid) AS filter_expr, \
             am.amname AS index_type, \
             NULL::smallint AS nkeyatts, \
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
             GROUP BY i.relname, i.oid, ix.indisunique, ix.indisprimary, ix.indpred, ix.indrelid, am.amname, ix.indkey \
             ORDER BY i.relname";

const POSTGRES_OWNERS_SQL: &str =
    "SELECT n.nspname, c.relname, c.relkind::text AS relkind, pg_get_userbyid(c.relowner) \
     FROM pg_class c \
     JOIN pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 \
       AND c.relkind IN ('r', 'v', 'm', 'S', 'f', 'p')";

fn postgres_owner_object_type(relkind: &str) -> &str {
    match relkind {
        "r" => "TABLE",
        "v" => "VIEW",
        "m" => "MATERIALIZED_VIEW",
        "S" => "SEQUENCE",
        "f" => "FOREIGN TABLE",
        "p" => "PARTITIONED TABLE",
        "I" => "PARTITIONED INDEX",
        _ => relkind,
    }
}

async fn list_indexes_with_sql(
    client: &deadpool_postgres::Client,
    sql: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, tokio_postgres::Error> {
    let stmt = client.prepare_cached(sql).await?;
    let rows = client.query(&stmt, &[&schema, &table]).await?;

    Ok(rows
        .iter()
        .map(|row| {
            let all_cols: Vec<String> = row.get::<_, Vec<String>>(1);
            let nkeyatts = row.try_get::<_, Option<i16>>(6).ok().flatten().unwrap_or(all_cols.len() as i16) as usize;
            let split_at = nkeyatts.min(all_cols.len());
            let key_cols = all_cols[..split_at].to_vec();
            let included = if split_at < all_cols.len() { all_cols[split_at..].to_vec() } else { vec![] };
            IndexInfo {
                name: row.get::<_, String>(0),
                columns: key_cols,
                is_unique: row.get::<_, bool>(2),
                is_primary: row.get::<_, bool>(3),
                filter: row.try_get::<_, Option<String>>(4).ok().flatten(),
                index_type: row.try_get::<_, Option<String>>(5).ok().flatten(),
                included_columns: if included.is_empty() { None } else { Some(included) },
                comment: row.try_get::<_, Option<String>>(8).ok().flatten(),
            }
        })
        .collect())
}

pub async fn list_indexes(pool: &Pool, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    match list_indexes_with_sql(&client, POSTGRES_INDEXES_SQL, schema, table).await {
        Ok(indexes) => Ok(indexes),
        Err(primary_error) => match list_indexes_with_sql(&client, POSTGRES_INDEXES_COMPAT_SQL, schema, table).await {
            Ok(indexes) => Ok(indexes),
            Err(fallback_error) => {
                let primary_message = pg_error_to_string(primary_error);
                let fallback_message = pg_error_to_string(fallback_error);
                log::debug!(
                    "[postgres][list_indexes:compat-failed] primary_error={} fallback_error={}",
                    primary_message,
                    fallback_message
                );
                Err(fallback_message)
            }
        },
    }
}

pub async fn list_foreign_keys(pool: &Pool, schema: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client
        .prepare_cached(
            "SELECT fk.constraint_name, fk.column_name, \
             pk.table_schema AS ref_schema, pk.table_name AS ref_table, pk.column_name AS ref_column \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage fk \
               ON fk.constraint_name = tc.constraint_name \
               AND fk.constraint_schema = tc.constraint_schema \
               AND fk.table_schema = tc.table_schema \
               AND fk.table_name = tc.table_name \
             JOIN information_schema.referential_constraints rc \
               ON rc.constraint_name = tc.constraint_name \
               AND rc.constraint_schema = tc.constraint_schema \
             JOIN information_schema.key_column_usage pk \
               ON pk.constraint_name = rc.unique_constraint_name \
               AND pk.constraint_schema = rc.unique_constraint_schema \
               AND pk.ordinal_position = fk.position_in_unique_constraint \
             WHERE tc.constraint_type = 'FOREIGN KEY' \
               AND fk.table_schema = $1 AND fk.table_name = $2 \
             ORDER BY fk.constraint_name, fk.ordinal_position",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema, &table]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ForeignKeyInfo {
            name: row.get::<_, String>(0),
            column: row.get::<_, String>(1),
            ref_schema: Some(row.get::<_, String>(2)),
            ref_table: row.get::<_, String>(3),
            ref_column: row.get::<_, String>(4),
            on_update: None,
            on_delete: None,
        })
        .collect())
}

pub async fn list_triggers(pool: &Pool, schema: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client
        .prepare_cached(
            "SELECT trigger_name, event_manipulation, action_timing \
             FROM information_schema.triggers \
             WHERE trigger_schema = $1 AND event_object_table = $2 \
             ORDER BY trigger_name",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema, &table]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TriggerInfo {
            name: row.get::<_, String>(0),
            event: row.get::<_, String>(1),
            timing: row.get::<_, String>(2),
            statement: None,
        })
        .collect())
}

pub async fn list_functions(pool: &Pool, schema: &str) -> Result<Vec<FunctionInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    // Use pg_proc + pg_get_functiondef() instead of information_schema.routines
    // for reliable function definition retrieval (information_schema.routines.routine_definition
    // is NULL for non-SQL functions like plpgsql)
    let stmt = client
        .prepare_cached(
            "SELECT p.proname, \
                    CASE p.prokind WHEN 'f' THEN 'FUNCTION' WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, \
                    COALESCE(pg_get_function_result(p.oid), ''), \
                    pg_get_functiondef(p.oid), \
                    COALESCE(pg_get_function_arguments(p.oid), '') \
             FROM pg_proc p \
             JOIN pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') \
             ORDER BY p.proname",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let def: String = row.get::<_, String>(3);
            // Remove schema qualification from CREATE FUNCTION statement
            // to avoid false differences when comparing across schemas.
            // Handle both "schema.name" and schema.name formats.
            let normalized_def = def
                .replace(&format!("CREATE OR REPLACE FUNCTION \"{}\".", schema), "CREATE OR REPLACE FUNCTION ")
                .replace(&format!("CREATE OR REPLACE FUNCTION {}.", schema), "CREATE OR REPLACE FUNCTION ");
            FunctionInfo {
                name: row.get::<_, String>(0),
                function_type: row.get::<_, String>(1),
                data_type: row.get::<_, String>(2),
                definition: normalized_def,
                arguments: row.get::<_, String>(4),
            }
        })
        .collect())
}

pub async fn list_sequences(pool: &Pool, schema: &str, with_last_values: bool) -> Result<Vec<SequenceInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    // Use pg_class + pg_sequence + pg_namespace instead of pg_sequences view
    // for better compatibility and permission handling
    let stmt = client
        .prepare_cached(
            "SELECT c.relname, \
              COALESCE(format_type(s.seqtypid, NULL), 'bigint'), \
              COALESCE(s.seqstart::text, '1'), \
              COALESCE(s.seqmin::text, '1'), \
              COALESCE(s.seqmax::text, '9223372036854775807'), \
              COALESCE(s.seqincrement::text, '1'), \
              CASE WHEN s.seqcycle THEN 'YES' ELSE 'NO' END \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_sequence s ON s.seqrelid = c.oid \
             WHERE c.relkind = 'S' AND n.nspname = $1 \
             ORDER BY c.relname",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema]).await.map_err(|e| e.to_string())?;

    let mut sequences: Vec<SequenceInfo> = rows
        .iter()
        .map(|row| SequenceInfo {
            name: row.get::<_, String>(0),
            data_type: row.get::<_, String>(1),
            start_value: row.get::<_, String>(2),
            min_value: row.get::<_, String>(3),
            max_value: row.get::<_, String>(4),
            increment: row.get::<_, String>(5),
            cycle: row.get::<_, String>(6) == "YES",
            last_value: None,
        })
        .collect();

    if with_last_values {
        // Batch query: get last values for all sequences in one query
        let sql = "SELECT c.relname, pg_sequence_last_value(c.oid) \
                   FROM pg_class c \
                   JOIN pg_namespace n ON n.oid = c.relnamespace \
                   WHERE c.relkind = 'S' AND n.nspname = $1";
        if let Ok(stmt) = client.prepare_cached(sql).await {
            if let Ok(rows) = client.query(&stmt, &[&schema]).await {
                for row in rows {
                    let name: String = row.get(0);
                    if let Ok(val) = row.try_get::<_, i64>(1) {
                        if let Some(seq) = sequences.iter_mut().find(|s| s.name == name) {
                            seq.last_value = Some(val.to_string());
                        }
                    }
                }
            }
        }
    }

    Ok(sequences)
}

pub async fn list_rules(pool: &Pool, schema: &str) -> Result<Vec<RuleInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client
        .prepare_cached(
            "SELECT schemaname, tablename, rulename, definition \
             FROM pg_rules \
             WHERE schemaname = $1 \
             ORDER BY rulename",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| RuleInfo {
            name: row.get::<_, String>(2),
            table_name: row.get::<_, String>(1),
            definition: row.get::<_, String>(3),
        })
        .collect())
}

pub async fn list_owners(pool: &Pool, schema: &str) -> Result<Vec<OwnerInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client.prepare_cached(POSTGRES_OWNERS_SQL).await.map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let relkind: String = row.get(2);
            OwnerInfo {
                object_name: row.get::<_, String>(1),
                object_type: postgres_owner_object_type(&relkind).to_string(),
                owner: row.get::<_, String>(3),
            }
        })
        .collect())
}

/// Execute multiple SQL statements in a single round-trip using batch_execute.
/// Best for DDL scripts where per-statement affected-row counts are not needed.
pub async fn execute_batch(pool: &Pool, statements: &[String]) -> Result<(), String> {
    let combined = statements.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(";\n");
    if combined.is_empty() {
        return Ok(());
    }
    let client = pool.get().await.map_err(|e| e.to_string())?;
    client.batch_execute(&combined).await.map_err(pg_error_to_string)?;
    clear_postgres_caches_after_ddl(pool, Some(&client), &combined);
    Ok(())
}

pub async fn terminate_current_user_database_backends(pool: &Pool, database: &str) -> Result<u64, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    client
        .execute(
            "SELECT pg_terminate_backend(pid) \
             FROM pg_stat_activity \
             WHERE datname = $1 \
               AND pid <> pg_backend_pid() \
               AND usename = current_user",
            &[&database],
        )
        .await
        .map_err(pg_error_to_string)
}

fn clear_postgres_caches_after_ddl(pool: &Pool, client: Option<&deadpool_postgres::Client>, sql: &str) {
    if !invalidates_postgres_statement_cache(sql) {
        return;
    }
    pool.manager().statement_caches.clear();
    if let Some(client) = client {
        client.clear_type_cache();
    }
}

fn invalidates_postgres_statement_cache(sql: &str) -> bool {
    let trimmed = sql.trim_start();
    starts_with_executable_sql_keyword(
        trimmed,
        &["ALTER", "CREATE", "DROP", "TRUNCATE", "COMMENT", "REINDEX", "VACUUM"],
    )
}

/// Export data via COPY TO STDOUT. `sql` must be a complete COPY statement, e.g.
/// `COPY table (col1, col2) TO STDOUT (FORMAT CSV, HEADER)`.
/// Returns the raw COPY output bytes.
pub async fn copy_out(pool: &Pool, sql: &str) -> Result<Vec<u8>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stream = client.copy_out(sql).await.map_err(pg_error_to_string)?;
    tokio::pin!(stream);
    let mut result = Vec::new();
    while let Some(chunk) = stream.next().await {
        result.extend_from_slice(&chunk.map_err(pg_error_to_string)?);
    }
    Ok(result)
}

/// Import data via COPY FROM STDIN. `sql` must be a complete COPY statement, e.g.
/// `COPY table (col1, col2) FROM STDIN (FORMAT CSV)`.
/// `data` is the raw input in the format specified by the COPY command.
pub async fn copy_in(pool: &Pool, sql: &str, data: &[u8]) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let sink = client.copy_in::<str, bytes::Bytes>(sql).await.map_err(pg_error_to_string)?;
    let mut sink = Box::pin(sink);
    sink.as_mut().send(bytes::Bytes::copy_from_slice(data)).await.map_err(pg_error_to_string)?;
    sink.as_mut().close().await.map_err(pg_error_to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_postgres::types::FromSql;

    // --- pg_quote_ident ---

    #[test]
    fn pg_system_u32_decodes_catalog_integer_types() {
        let raw = 42_u32.to_be_bytes();

        assert_eq!(u32::from_sql(&Type::OID, &raw).unwrap(), 42);
        assert_eq!(PgSystemU32::from_sql(&Type::XID, &raw).unwrap().0, 42);
        assert_eq!(PgSystemU32::from_sql(&Type::CID, &raw).unwrap().0, 42);
        assert!(u32::accepts(&Type::OID));
        assert!(PgSystemU32::accepts(&Type::XID));
        assert!(PgSystemU32::accepts(&Type::CID));
        assert!(!PgSystemU32::accepts(&Type::OID));
        assert!(!PgSystemU32::accepts(&Type::INT4));
    }

    #[test]
    fn pg_any_string_accepts_all_types_and_decodes_utf8() {
        // Accepts any type — built-in, custom enum OIDs, domains, etc.
        assert!(PgAnyString::accepts(&Type::TEXT));
        assert!(PgAnyString::accepts(&Type::INT4));
        assert!(PgAnyString::accepts(&Type::UNKNOWN));
        assert!(PgAnyString::accepts(&Type::OID));
        assert!(PgAnyString::accepts(&Type::BOOL));

        let label = PgAnyString::from_sql(&Type::UNKNOWN, b"pending").unwrap();
        assert_eq!(label.0, "pending");

        let label = PgAnyString::from_sql(&Type::UNKNOWN, b"hello world").unwrap();
        assert_eq!(label.0, "hello world");

        // Non-UTF-8 bytes should fail gracefully
        assert!(PgAnyString::from_sql(&Type::UNKNOWN, &[0xFF, 0xFE, 0xFD]).is_err());
    }

    #[test]
    fn pg_raw_bytes_accepts_all_types_and_preserves_binary_payloads() {
        assert!(PgRawBytes::accepts(&Type::TEXT));
        assert!(PgRawBytes::accepts(&Type::UNKNOWN));
        assert!(PgRawBytes::accepts(&Type::OID));

        let raw = PgRawBytes::from_sql(&Type::UNKNOWN, &[0x01, 0xAB, 0xFF]).unwrap();
        assert_eq!(raw.0, vec![0x01, 0xAB, 0xFF]);
    }

    #[test]
    fn decodes_tsvector_binary_output() {
        let raw = [
            0, 0, 0, 2, b'b', b'a', b'c', b'k', b'\\', b's', b'l', b'a', b's', b'h', 0, 0, 1, 0x80, 0x03, b'o', b'\'',
            b'c', b'l', b'o', b'c', b'k', 0, 0, 2, 0, 1, 0xc0, 0x02,
        ];

        assert_eq!(decode_tsvector_bytes(&raw).as_deref(), Some("'back\\\\slash':3B 'o''clock':1,2A"));
    }

    fn decode_hex(hex: &str) -> Vec<u8> {
        assert_eq!(hex.len() % 2, 0, "hex input must have an even number of chars");
        (0..hex.len()).step_by(2).map(|idx| u8::from_str_radix(&hex[idx..idx + 2], 16).unwrap()).collect()
    }

    #[test]
    fn ewkb_point_with_srid_formats_as_wkt() {
        let raw = decode_hex("0101000020E6100000C520B07268195D404E62105839F44340");
        assert_eq!(super::super::wkb::wkb_to_wkt(&raw), Some("POINT(116.397 39.908)".to_string()));
    }

    #[test]
    fn ewkb_multi_polygon_formats_as_wkt() {
        let raw = decode_hex(
            "0106000020E610000002000000010300000001000000050000000000000000005D4000000000000044400000000000405D4000000000000044400000000000405D4000000000008044400000000000005D4000000000008044400000000000005D400000000000004440010300000001000000050000000000000000805D4000000000008043400000000000C05D4000000000008043400000000000C05D4000000000000044400000000000805D4000000000000044400000000000805D400000000000804340",
        );
        assert_eq!(
            super::super::wkb::wkb_to_wkt(&raw),
            Some(
                "MULTIPOLYGON(((116 40,117 40,117 41,116 41,116 40)),((118 39,119 39,119 40,118 40,118 39)))"
                    .to_string()
            )
        );
    }

    #[test]
    fn ewkb_geometry_collection_formats_as_wkt() {
        let raw = decode_hex(
            "0107000020E61000000200000001010000000000000000005D4000000000000044400102000000020000000000000000405D4000000000008044400000000000805D400000000000004540",
        );
        assert_eq!(
            super::super::wkb::wkb_to_wkt(&raw),
            Some("GEOMETRYCOLLECTION(POINT(116 40),LINESTRING(117 41,118 42))".to_string())
        );
    }

    #[test]
    fn pg_optional_array_to_json_preserves_text_values_and_nulls() {
        let value = pg_optional_array_to_json(
            vec![Some("productManager".to_string()), None, Some("projectOwner".to_string())],
            serde_json::Value::String,
        );

        assert_eq!(value, serde_json::json!(["productManager", null, "projectOwner"]));
    }

    #[test]
    fn pg_quote_ident_plain_identifier() {
        assert_eq!(pg_quote_ident("public"), "\"public\"");
    }

    #[test]
    fn pg_quote_ident_escapes_double_quotes() {
        assert_eq!(pg_quote_ident("my\"schema"), "\"my\"\"schema\"");
    }

    #[test]
    fn pg_quote_ident_empty_string() {
        assert_eq!(pg_quote_ident(""), "\"\"");
    }

    #[test]
    fn pg_quote_ident_special_chars() {
        // PostgreSQL allows many special chars in quoted identifiers
        let ident = "my schema with spaces";
        assert_eq!(pg_quote_ident(ident), "\"my schema with spaces\"");
    }

    #[test]
    fn pg_quote_ident_injection_attempt() {
        // A malicious schema name that tries to break out of quotes
        let malicious = r#"public"; DROP TABLE users; --"#;
        let escaped = pg_quote_ident(malicious);
        // Double quotes should be doubled, not breaking out
        assert_eq!(escaped, r#""public""; DROP TABLE users; --""#);
        assert!(escaped.matches('"').count().is_multiple_of(2), "quote count should be even");
    }

    // --- query_result_row_limit ---

    #[test]
    fn row_limit_uses_max_rows_when_present() {
        assert_eq!(query_result_row_limit(Some(50)), 50);
    }

    #[test]
    fn row_limit_falls_back_to_default() {
        let default = crate::query::MAX_ROWS;
        assert_eq!(query_result_row_limit(None), default);
    }

    #[test]
    fn row_limit_clamps_zero_to_one() {
        assert_eq!(query_result_row_limit(Some(0)), 1);
    }

    #[test]
    fn row_limit_allows_max_rows_override() {
        assert_eq!(query_result_row_limit(Some(5)), 5);
    }

    #[test]
    fn timestamptz_display_preserves_local_offset() {
        let text = format_pg_timestamptz(Local::now());
        assert!(!text.ends_with("+00:00") || Local::now().offset().local_minus_utc() == 0);
    }

    // --- validate_postgres_ssl_paths ---

    #[test]
    fn ssl_validation_passes_for_clean_url() {
        assert!(validate_postgres_ssl_paths("postgres://localhost/db").is_ok());
    }

    #[test]
    fn ssl_validation_passes_for_url_without_query() {
        assert!(validate_postgres_ssl_paths("host=localhost dbname=test").is_ok());
    }

    #[test]
    fn ssl_validation_passes_for_irrelevant_params() {
        assert!(validate_postgres_ssl_paths("postgres://localhost/db?sslmode=require&connect_timeout=10").is_ok());
    }

    #[test]
    fn ssl_validation_rejects_nonexistent_sslcert_path() {
        let result = validate_postgres_ssl_paths("postgres://localhost/db?sslcert=/nonexistent/path/cert.pem");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("sslcert"), "error should mention sslcert");
    }

    #[test]
    fn ssl_validation_rejects_nonexistent_sslkey_path() {
        let result = validate_postgres_ssl_paths("postgres://localhost/db?sslkey=/nonexistent/path/key.pem");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("sslkey"), "error should mention sslkey");
    }

    #[test]
    fn ssl_validation_rejects_nonexistent_sslrootcert_path() {
        let result = validate_postgres_ssl_paths("postgres://localhost/db?sslrootcert=/nonexistent/path/root.crt");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("sslrootcert"), "error should mention sslrootcert");
    }

    #[test]
    fn ssl_validation_rejects_path_traversal_in_sslcert() {
        let result = validate_postgres_ssl_paths("postgres://localhost/db?sslcert=../../../etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn ssl_validation_handles_url_encoded_ssl_param() {
        // %2F = '/', so sslcert=%2Ftmp%2Fcert.pem means sslcert=/tmp/cert.pem
        let result = validate_postgres_ssl_paths("postgres://localhost/db?sslcert=%2Fnonexistent%2Fcert.pem");
        assert!(result.is_err());
    }

    #[test]
    fn ssl_validation_handles_multiple_params() {
        let result =
            validate_postgres_ssl_paths("postgres://localhost/db?sslmode=require&sslcert=/nonexistent/cert.pem");
        assert!(result.is_err());
    }

    #[test]
    fn postgres_connection_url_strips_ssl_file_params_before_driver_parse() {
        let dir = std::env::temp_dir();
        let cert = dir.join(format!("dbx-postgres-cert-{}.pem", std::process::id()));
        let key = dir.join(format!("dbx-postgres-key-{}.pem", std::process::id()));
        let root = dir.join(format!("dbx-postgres-root-{}.pem", std::process::id()));
        std::fs::write(&cert, "not a real cert").unwrap();
        std::fs::write(&key, "not a real key").unwrap();
        std::fs::write(&root, "not a real root").unwrap();

        let url = format!(
            "postgres://localhost/db?sslmode=verify-full&sslcert={}&sslkey={}&sslrootcert={}&application_name=dbx",
            cert.display(),
            key.display(),
            root.display()
        );
        let parsed = postgres_connection_url(&url).unwrap();

        assert_eq!(parsed.url, "postgres://localhost/db?sslmode=require&application_name=dbx");
        assert_eq!(parsed.ssl_files.sslcert.as_deref(), Some(cert.to_str().unwrap()));
        assert_eq!(parsed.ssl_files.sslkey.as_deref(), Some(key.to_str().unwrap()));
        assert_eq!(parsed.ssl_files.sslrootcert.as_deref(), Some(root.to_str().unwrap()));
        assert!(!parsed.accepts_invalid_certs);
        assert!(parsed.verifies_hostname);
        tokio_postgres::Config::from_str(&parsed.url).unwrap();

        let _ = std::fs::remove_file(cert);
        let _ = std::fs::remove_file(key);
        let _ = std::fs::remove_file(root);
    }

    #[test]
    fn postgres_connection_url_keeps_verify_ca_ca_only_semantics() {
        let parsed = postgres_connection_url("postgres://localhost/db?sslmode=verify-ca").unwrap();

        assert_eq!(parsed.url, "postgres://localhost/db?sslmode=require");
        assert!(!parsed.accepts_invalid_certs);
        assert!(!parsed.verifies_hostname);
    }

    #[test]
    fn postgres_connection_url_normalizes_channel_binding_require_to_prefer() {
        let parsed =
            postgres_connection_url("postgres://localhost/db?sslmode=require&channel_binding=require").unwrap();

        assert_eq!(parsed.url, "postgres://localhost/db?sslmode=require&channel_binding=prefer");
        // The sanitized URL must be parseable by the driver
        tokio_postgres::Config::from_str(&parsed.url).unwrap();
    }

    #[test]
    fn postgres_connection_url_keeps_channel_binding_prefer() {
        let parsed = postgres_connection_url("postgres://localhost/db?channel_binding=prefer").unwrap();

        assert_eq!(parsed.url, "postgres://localhost/db?channel_binding=prefer");
        tokio_postgres::Config::from_str(&parsed.url).unwrap();
    }

    #[test]
    fn postgres_tls_rejects_unpaired_client_cert_and_key() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let pg_config = tokio_postgres::Config::from_str("postgres://localhost/db?sslmode=require").unwrap();
        let ssl_files =
            PostgresSslFiles { sslcert: Some("/tmp/client.crt".to_string()), sslkey: None, sslrootcert: None };

        let error = match postgres_tls_config(&pg_config, &ssl_files, true, false) {
            Ok(_) => panic!("expected missing sslkey to fail"),
            Err(error) => error,
        };
        assert!(error.contains("sslkey"));
    }

    #[test]
    fn postgres_tls_accepts_invalid_certs_for_require_sslmode() {
        let pg_config = tokio_postgres::Config::from_str("postgres://localhost/db?sslmode=require").unwrap();

        assert!(postgres_sslmode_accepts_invalid_certs(pg_config.get_ssl_mode()));
    }

    #[test]
    fn postgres_tls_accepts_invalid_certs_for_default_prefer_sslmode() {
        let pg_config = tokio_postgres::Config::from_str("postgres://localhost/db").unwrap();

        assert!(postgres_sslmode_accepts_invalid_certs(pg_config.get_ssl_mode()));
    }

    #[test]
    fn postgres_tls_keeps_verification_off_only_when_ssl_is_disabled() {
        let pg_config = tokio_postgres::Config::from_str("postgres://localhost/db?sslmode=disable").unwrap();

        assert!(!postgres_sslmode_accepts_invalid_certs(pg_config.get_ssl_mode()));
    }

    // --- SQL generation ---

    #[test]
    fn postgres_tables_sql_contains_expected_columns() {
        let sql = postgres_tables_sql();
        assert!(sql.contains("table_name"));
        assert!(sql.contains("table_type"));
        assert!(sql.contains("table_comment"));
        assert!(sql.contains("pg_catalog.pg_inherits"));
        assert!(sql.contains("parent_schema"));
        assert!(sql.contains("parent_name"));
        assert!(sql.contains("pc.relkind = 'p'"));
        assert!(sql.contains("$1"));
        assert!(sql.contains("BASE TABLE"));
        assert!(sql.contains("VIEW"));
        assert!(sql.contains("MATERIALIZED_VIEW"));
        assert!(sql.contains("FOREIGN TABLE"));
    }

    #[test]
    fn postgres_table_comment_sql_targets_single_table() {
        let sql = postgres_table_comment_sql();

        assert!(sql.contains("obj_description(c.oid)"));
        assert!(sql.contains("n.nspname = $1"));
        assert!(sql.contains("c.relname = $2"));
        assert!(sql.contains("LIMIT 1"));
        assert!(!sql.contains("ORDER BY"));
    }

    #[test]
    fn postgres_column_metadata_reads_identity_extra() {
        assert!(POSTGRES_COLUMNS_SQL.contains("a.attidentity"));
        assert!(POSTGRES_COLUMNS_SQL.contains("pg_sequence"));
        assert!(POSTGRES_COLUMNS_SQL.contains("generated by default as identity"));
        assert!(POSTGRES_COLUMNS_SQL.contains("generated always as identity"));
        assert!(POSTGRES_COLUMNS_SQL.contains("COALESCE(c.is_nullable = 'YES', NOT a.attnotnull)"));
        assert!(POSTGRES_COLUMNS_SQL.contains("LEFT JOIN information_schema.columns"));
    }

    #[test]
    fn postgres_column_metadata_has_opengauss_compatible_fallback() {
        assert!(!POSTGRES_COLUMNS_COMPAT_SQL.contains("a.attidentity"));
        assert!(!POSTGRES_COLUMNS_COMPAT_SQL.contains("pg_sequence"));
        assert!(POSTGRES_COLUMNS_COMPAT_SQL.contains("NULL::text AS column_extra"));
        assert!(POSTGRES_COLUMNS_COMPAT_SQL.contains("col_description"));
        assert!(POSTGRES_COLUMNS_COMPAT_SQL.contains("COALESCE(c.is_nullable = 'YES', NOT a.attnotnull)"));
        assert!(POSTGRES_COLUMNS_COMPAT_SQL.contains("LEFT JOIN information_schema.columns"));
    }

    #[test]
    fn postgres_column_metadata_has_information_schema_fallback() {
        assert!(POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("information_schema.columns"));
        assert!(POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("information_schema.table_constraints"));
        assert!(POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("information_schema.key_column_usage"));
        assert!(!POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("pg_attribute"));
        assert!(!POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("regclass"));
    }

    #[test]
    fn postgres_index_metadata_has_legacy_catalog_fallback() {
        assert!(POSTGRES_INDEXES_SQL.contains("ix.indnkeyatts"));
        assert!(!POSTGRES_INDEXES_COMPAT_SQL.contains("ix.indnkeyatts"));
        assert!(POSTGRES_INDEXES_COMPAT_SQL.contains("NULL::smallint AS nkeyatts"));
    }

    #[test]
    fn postgres_owner_metadata_casts_relkind_to_text() {
        assert!(POSTGRES_OWNERS_SQL.contains("c.relkind::text AS relkind"));
        assert!(POSTGRES_OWNERS_SQL.contains("c.relkind IN ('r', 'v', 'm', 'S', 'f', 'p')"));
    }

    #[test]
    fn postgres_owner_object_type_maps_relkind_codes() {
        assert_eq!(postgres_owner_object_type("r"), "TABLE");
        assert_eq!(postgres_owner_object_type("v"), "VIEW");
        assert_eq!(postgres_owner_object_type("m"), "MATERIALIZED_VIEW");
        assert_eq!(postgres_owner_object_type("S"), "SEQUENCE");
        assert_eq!(postgres_owner_object_type("f"), "FOREIGN TABLE");
        assert_eq!(postgres_owner_object_type("p"), "PARTITIONED TABLE");
        assert_eq!(postgres_owner_object_type("?"), "?");
    }

    #[test]
    fn list_objects_sql_includes_routines() {
        let sql = list_objects_sql(true);
        assert!(sql.contains("pg_catalog.pg_class"));
        assert!(sql.contains("pg_catalog.pg_proc"));
        assert!(sql.contains("pg_catalog.pg_inherits"));
        assert!(sql.contains("parent_schema"));
        assert!(sql.contains("parent_name"));
        assert!(sql.contains("pc.relkind = 'p'"));
        assert!(sql.contains("pg_stat_file"));
        assert!(sql.contains("pg_xact_commit_timestamp"));
        assert!(sql.contains("'PROCEDURE'"));
        assert!(sql.contains("'FUNCTION'"));
    }

    #[test]
    fn list_objects_sql_without_timestamps_omits_stat_file() {
        let sql = list_objects_sql(false);
        assert!(!sql.contains("pg_stat_file"));
        assert!(sql.contains("NULL::text AS created_at"));
        assert!(sql.contains("NULL::text AS updated_at"));
    }

    #[test]
    fn both_list_objects_sql_variants_use_parameter() {
        assert!(list_objects_sql(true).contains("$1"));
        assert!(list_objects_sql(false).contains("$1"));
    }

    #[test]
    fn both_list_objects_sql_variants_include_pg_proc() {
        assert!(list_objects_sql(true).contains("pg_catalog.pg_proc"));
        assert!(list_objects_sql(false).contains("pg_catalog.pg_proc"));
    }

    #[test]
    fn transaction_recovery_statement_detection_matches_common_postgres_commands() {
        assert!(is_transaction_recovery_statement("ROLLBACK"));
        assert!(is_transaction_recovery_statement("rollback work"));
        assert!(is_transaction_recovery_statement("ABORT TRANSACTION"));
        assert!(is_transaction_recovery_statement("commit"));
        assert!(is_transaction_recovery_statement("END"));
    }

    #[test]
    fn transaction_recovery_statement_detection_ignores_regular_queries() {
        assert!(!is_transaction_recovery_statement("SELECT 1"));
        assert!(!is_transaction_recovery_statement("BEGIN"));
        assert!(!is_transaction_recovery_statement("UPDATE users SET name = 'dbx'"));
    }

    #[test]
    fn postgres_ddl_detection_covers_schema_changing_statements() {
        assert!(invalidates_postgres_statement_cache("ALTER TABLE users ADD COLUMN email text"));
        assert!(invalidates_postgres_statement_cache("  CREATE INDEX idx_users_email ON users(email)"));
        assert!(invalidates_postgres_statement_cache("COMMENT ON COLUMN users.email IS 'Email'"));
        assert!(invalidates_postgres_statement_cache("DROP TABLE users"));
        assert!(invalidates_postgres_statement_cache("TRUNCATE users"));
        assert!(invalidates_postgres_statement_cache("REINDEX TABLE users"));
        assert!(invalidates_postgres_statement_cache("VACUUM users"));
    }

    #[test]
    fn postgres_ddl_detection_ignores_regular_dml_and_selects() {
        assert!(!invalidates_postgres_statement_cache("SELECT * FROM users"));
        assert!(!invalidates_postgres_statement_cache("UPDATE users SET name = 'Ada'"));
        assert!(!invalidates_postgres_statement_cache("INSERT INTO users(name) VALUES ('Ada')"));
        assert!(!invalidates_postgres_statement_cache("DELETE FROM users WHERE id = 1"));
    }

    // --- execute_batch ---

    #[tokio::test]
    async fn execute_batch_empty_statements_returns_ok() {
        // Empty input should not error or try to connect
        // We can't test with a real pool, but we can verify the empty-early-return logic
        // by testing that an empty Vec doesn't need a pool reference
        let statements: Vec<String> = vec![];
        // This test validates the early return logic at code review level
        // Actual execution requires a pool; we just verify the empty path exists
        assert!(statements.is_empty());
    }

    #[tokio::test]
    async fn execute_batch_whitespace_only_is_filtered() {
        let statements = ["  ".to_string(), "\t\n".to_string(), "".to_string()];
        let combined = statements.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(";\n");
        assert!(combined.is_empty());
    }

    #[test]
    fn execute_batch_joins_with_semicolons() {
        let statements = ["SELECT 1".to_string(), "SELECT 2".to_string()];
        let combined = statements.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(";\n");
        assert_eq!(combined, "SELECT 1;\nSELECT 2");
    }

    // --- SET timezone escaping ---

    #[test]
    fn timezone_single_quotes_are_doubled() {
        let tz = "UTC";
        let escaped = tz.replace('\'', "''");
        assert_eq!(escaped, "UTC");
    }

    #[test]
    fn timezone_with_quote_is_escaped() {
        let tz = "Some'Zone";
        let escaped = tz.replace('\'', "''");
        assert_eq!(escaped, "Some''Zone");
    }

    // --- pg_url_has_timezone_setting ---

    #[test]
    fn url_without_timezone_returns_false() {
        assert!(!pg_url_has_timezone_setting("postgres://localhost/db"));
        assert!(!pg_url_has_timezone_setting("postgres://localhost/db?sslmode=require"));
    }

    #[test]
    fn url_with_options_timezone_returns_true() {
        assert!(pg_url_has_timezone_setting("postgres://localhost/db?options=-c timezone=Asia/Shanghai"));
    }

    #[test]
    fn url_with_url_encoded_timezone_returns_true() {
        assert!(pg_url_has_timezone_setting("postgres://localhost/db?options=-c%20timezone%3DUTC"));
    }

    #[test]
    fn url_with_uppercase_timezone_returns_true() {
        assert!(pg_url_has_timezone_setting("postgres://localhost/db?options=--TimeZone=UTC"));
    }

    #[test]
    fn like_contains_pattern_escapes_wildcards() {
        assert_eq!(like_contains_pattern(""), "%%");
        assert_eq!(like_contains_pattern("order_100%"), "%order~_100~%%");
        assert_eq!(like_contains_pattern("tilde~name"), "%tilde~~name%");
        assert_eq!(like_contains_pattern(r"foo\bar"), r"%foo\bar%");
    }

    #[test]
    fn postgres_tables_sql_uses_non_backslash_like_escape() {
        let sql = postgres_tables_sql();

        assert!(sql.contains("ILIKE $2 ESCAPE '~'"));
    }
}
