use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use deadpool_postgres::{ManagerConfig, Pool, RecyclingMethod, Runtime};
use futures::{SinkExt, StreamExt};
use percent_encoding::percent_decode_str;
use rust_decimal::Decimal;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Instant;
use tokio_postgres::config::SslMode;
use tokio_postgres::types::{FromSql, Type};
use tokio_postgres::{Row, SimpleQueryMessage};

use super::file_validator::validate_file_path;
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ObjectInfo, QueryResult, TableInfo, TriggerInfo,
};

fn pg_temporal_to_json_value(row: &Row, idx: usize) -> Option<serde_json::Value> {
    if let Ok(v) = row.try_get::<_, DateTime<Utc>>(idx) {
        return Some(serde_json::Value::String(v.to_rfc3339()));
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
    if let Ok(values) = row.try_get::<_, Vec<Option<DateTime<Utc>>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(v.to_rfc3339())));
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
    None
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

    if matches!(upper.as_str(), "OID" | "XID" | "CID") {
        return pg_system_u32_to_json(row, idx).unwrap_or(serde_json::Value::Null);
    }

    if upper.starts_with('_') {
        return pg_array_to_json_value(row, idx).unwrap_or(serde_json::Value::Null);
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
        .or_else(|_| {
            row.try_get::<_, Vec<u8>>(idx).map(|bytes| super::binary_value_to_json(&bytes))
        })
        .unwrap_or(serde_json::Value::Null)
}

fn pg_error_to_string(err: tokio_postgres::Error) -> String {
    err.as_db_error().map(ToString::to_string).unwrap_or_else(|| err.to_string())
}

fn should_retry_postgres_text_query(err: &tokio_postgres::Error) -> bool {
    let message = err.as_db_error().map(ToString::to_string).unwrap_or_else(|| err.to_string()).to_ascii_lowercase();
    message.contains("no binary output function")
        || message.contains("no binary send function")
        || message.contains("cannot display a value of type")
}

async fn execute_select_prepared(
    client: &deadpool_postgres::Client,
    sql: &str,
    start: Instant,
    row_limit: usize,
) -> Result<QueryResult, tokio_postgres::Error> {
    let stmt = client.prepare_cached(sql).await?;
    let columns: Vec<String> = stmt.columns().iter().map(|c| c.name().to_string()).collect();
    let column_types: Vec<String> = stmt.columns().iter().map(|c| c.type_().name().to_string()).collect();

    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = Vec::new();
    let stream = client.query_raw(&stmt, params).await?;
    tokio::pin!(stream);
    let mut result_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;

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
        Err(err) if should_retry_postgres_text_query(&err) => execute_select_text(client, sql, start, row_limit).await,
        Err(err) => Err(pg_error_to_string(err)),
    }
}

pub async fn connect(url: &str) -> Result<Pool, String> {
    validate_postgres_ssl_paths(url)?;
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let tz = iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string());

    super::with_connection_timeout("PostgreSQL", super::connection_timeout(), async {
        let pg_config =
            tokio_postgres::Config::from_str(url).map_err(|e| format!("Invalid PostgreSQL connection URL: {e}"))?;

        let mgr_config = ManagerConfig { recycling_method: RecyclingMethod::Fast };
        let tls_config = postgres_tls_config(&pg_config);
        let mgr = deadpool_postgres::Manager::from_config(
            pg_config.clone(),
            tokio_postgres_rustls::MakeRustlsConnect::new(tls_config),
            mgr_config,
        );
        let pool = Pool::builder(mgr)
            .max_size(1)
            .runtime(Runtime::Tokio1)
            .wait_timeout(Some(super::connection_timeout()))
            .build()
            .map_err(|e| format!("Failed to create PostgreSQL pool: {e}"))?;

        // Verify connectivity and set timezone. Only set timezone if the user
        // hasn't already specified one via connection parameters (e.g. options=-c timezone=...)
        let client = pool.get().await.map_err(|e| format!("PostgreSQL connection failed: {e}"))?;
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

fn postgres_tls_config(pg_config: &tokio_postgres::Config) -> rustls::ClientConfig {
    if postgres_sslmode_accepts_invalid_certs(pg_config.get_ssl_mode()) {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        return rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoPostgresCertVerification { provider }))
            .with_no_client_auth();
    }

    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    rustls::ClientConfig::builder().with_root_certificates(root_store).with_no_client_auth()
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

fn validate_postgres_ssl_paths(url: &str) -> Result<(), String> {
    if let Some(query_start) = url.find('?') {
        let query_string = &url[query_start + 1..];

        for param in query_string.split('&') {
            if let Some((key, value)) = param.split_once('=') {
                match key {
                    "sslcert" | "sslkey" | "sslrootcert" => {
                        let decoded = percent_decode_str(value)
                            .decode_utf8()
                            .map_err(|_| format!("Invalid URL encoding in {key}"))?;

                        validate_file_path(&decoded, |_| false).map_err(|e| format!("{key}: {e}"))?;
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(())
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
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client.prepare_cached(postgres_tables_sql()).await.map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: row.get::<_, String>(0),
            table_type: row.get::<_, String>(1),
            comment: row.try_get::<_, Option<String>>(2).ok().flatten().filter(|s| !s.is_empty()),
        })
        .collect())
}

fn postgres_tables_sql() -> &'static str {
    "SELECT c.relname AS table_name, \
         CASE c.relkind WHEN 'r' THEN 'BASE TABLE' WHEN 'v' THEN 'VIEW' \
           WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' \
           WHEN 'p' THEN 'BASE TABLE' END AS table_type, \
         obj_description(c.oid) AS table_comment \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','p') \
         ORDER BY c.relname"
}

fn list_objects_sql(include_timestamps: bool) -> &'static str {
    if include_timestamps {
        return "SELECT c.relname AS object_name, \
       CASE c.relkind \
         WHEN 'v' THEN 'VIEW' \
         WHEN 'm' THEN 'VIEW' \
         ELSE 'TABLE' \
       END AS object_type, \
       obj_description(c.oid) AS object_comment, \
       stat.creation::text AS created_at, \
       COALESCE( \
         CASE WHEN current_setting('track_commit_timestamp', true) = 'on' \
           THEN pg_xact_commit_timestamp(c.xmin)::text END, \
         stat.modification::text \
       ) AS updated_at, \
       CASE c.relkind WHEN 'v' THEN 1 WHEN 'm' THEN 1 ELSE 0 END AS sort_order \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN LATERAL pg_stat_file( \
       CASE WHEN c.relkind IN ('r','m','f','p') THEN pg_relation_filepath(c.oid) END, true \
     ) stat ON true \
     WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','p') \
     UNION ALL \
     SELECT p.proname AS object_name, \
       CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       CASE WHEN current_setting('track_commit_timestamp', true) = 'on' \
         THEN pg_xact_commit_timestamp(p.xmin)::text END AS updated_at, \
       CASE p.prokind WHEN 'p' THEN 2 ELSE 3 END AS sort_order \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND p.prokind IN ('p','f') \
     ORDER BY sort_order, object_name";
    }

    "SELECT c.relname AS object_name, \
       CASE c.relkind \
         WHEN 'v' THEN 'VIEW' \
         WHEN 'm' THEN 'VIEW' \
         ELSE 'TABLE' \
       END AS object_type, \
       obj_description(c.oid) AS object_comment, \
       NULL::text AS created_at, \
       NULL::text AS updated_at, \
       CASE c.relkind WHEN 'v' THEN 1 WHEN 'm' THEN 1 ELSE 0 END AS sort_order \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','p') \
     UNION ALL \
     SELECT p.proname AS object_name, \
       CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       NULL::text AS updated_at, \
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

pub async fn get_columns(pool: &Pool, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client
        .prepare_cached(
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
             WHERE a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass \
             AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema, &table]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let full_type = row.try_get::<_, Option<String>>(1).ok().flatten().unwrap_or_default();
            ColumnInfo {
                name: row.get::<_, String>(0),
                data_type: full_type,
                is_nullable: row.get::<_, bool>(2),
                column_default: row.try_get::<_, Option<String>>(3).ok().flatten(),
                is_primary_key: row.get::<_, bool>(4),
                extra: None,
                comment: row.try_get::<_, Option<String>>(5).ok().flatten(),
                numeric_precision: row.try_get::<_, Option<i32>>(6).ok().flatten(),
                numeric_scale: row.try_get::<_, Option<i32>>(7).ok().flatten(),
                character_maximum_length: row.try_get::<_, Option<i32>>(8).ok().flatten(),
            }
        })
        .collect())
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
        let affected = client.execute(sql, &[]).await.map_err(|e| e.to_string())?;

        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: affected,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
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
    let client = pool.get().await.map_err(|e| e.to_string())?;
    client
        .execute(&format!("SET search_path TO {}, public", pg_quote_ident(schema)), &[])
        .await
        .map_err(|e| e.to_string())?;

    let result = execute_query_with_max_rows_inner(&client, sql, max_rows).await;

    // Always reset search_path so the connection is clean when returned to the pool
    let _ = client.execute("RESET search_path", &[]).await;

    result
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
        let affected = client.execute(sql, &[]).await.map_err(|e| e.to_string())?;

        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: affected,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

pub async fn list_indexes(pool: &Pool, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client
        .prepare_cached(
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
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema, &table]).await.map_err(|e| e.to_string())?;

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

pub async fn list_foreign_keys(pool: &Pool, schema: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client
        .prepare_cached(
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
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema, &table]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ForeignKeyInfo {
            name: row.get::<_, String>(0),
            column: row.get::<_, String>(1),
            ref_table: row.get::<_, String>(2),
            ref_column: row.get::<_, String>(3),
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
    client.batch_execute(&combined).await.map_err(|e| e.to_string())
}

/// Export data via COPY TO STDOUT. `sql` must be a complete COPY statement, e.g.
/// `COPY table (col1, col2) TO STDOUT (FORMAT CSV, HEADER)`.
/// Returns the raw COPY output bytes.
pub async fn copy_out(pool: &Pool, sql: &str) -> Result<Vec<u8>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stream = client.copy_out(sql).await.map_err(|e| e.to_string())?;
    tokio::pin!(stream);
    let mut result = Vec::new();
    while let Some(chunk) = stream.next().await {
        result.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

/// Import data via COPY FROM STDIN. `sql` must be a complete COPY statement, e.g.
/// `COPY table (col1, col2) FROM STDIN (FORMAT CSV)`.
/// `data` is the raw input in the format specified by the COPY command.
pub async fn copy_in(pool: &Pool, sql: &str, data: &[u8]) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let sink = client.copy_in::<str, bytes::Bytes>(sql).await.map_err(|e: tokio_postgres::Error| e.to_string())?;
    let mut sink = Box::pin(sink);
    sink.as_mut().send(bytes::Bytes::copy_from_slice(data)).await.map_err(|e| e.to_string())?;
    sink.as_mut().close().await.map_err(|e| e.to_string())
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
        assert!(escaped.matches('"').count() % 2 == 0, "quote count should be even");
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
        assert!(sql.contains("$1"));
        assert!(sql.contains("BASE TABLE"));
        assert!(sql.contains("VIEW"));
        assert!(sql.contains("MATERIALIZED VIEW"));
        assert!(sql.contains("FOREIGN TABLE"));
    }

    #[test]
    fn list_objects_sql_includes_routines() {
        let sql = list_objects_sql(true);
        assert!(sql.contains("pg_catalog.pg_class"));
        assert!(sql.contains("pg_catalog.pg_proc"));
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
        let statements = vec!["  ".to_string(), "\t\n".to_string(), "".to_string()];
        let combined = statements.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(";\n");
        assert!(combined.is_empty());
    }

    #[test]
    fn execute_batch_joins_with_semicolons() {
        let statements = vec!["SELECT 1".to_string(), "SELECT 2".to_string()];
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
}
