//! InfluxDB 3.x native driver.
//!
//! Transport is HTTP JSON — `POST /api/v3/query_sql` for queries,
//! `GET /api/v3/configure/database?format=json` for the database list.
//! This is intentionally the same wire path Core's own tooling uses,
//! and every metadata / query / test call funnels through
//! [`post_query_json`] so the connection test proves the exact code
//! path a real query will take.
//!
//! Row bounding is implemented by rewriting eligible `SELECT` statements
//! with `LIMIT N + 1` when [`execute_query`] is given a `max_rows` cap.
//! That keeps the server from serializing a full table into JSON when
//! the caller only ever wanted the first few thousand rows.
//!
//! Database creation is deliberately **not** implemented here — Core's
//! `POST /api/v3/configure/database` admin endpoint exists but is not
//! part of the generic SQL execution path, and the driver manifest
//! reflects this by advertising `databaseCreate: false`.

use regex::Regex;
use reqwest::{Certificate, Client as HttpClient, Response, StatusCode};
use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use super::with_connection_timeout;
use crate::models::connection::ConnectionConfig;
use crate::types::{ColumnInfo, DatabaseInfo, QueryResult, TableInfo};

/// InfluxDB 3 Core's internal database — present on every install. We
/// use it as the bootstrap target for `test_connection` when the user
/// hasn't set a default database, so the test still exercises the real
/// query endpoint.
const BOOTSTRAP_DATABASE: &str = "_internal";

/// Only user tables live in the `iox` schema. `system` and
/// `information_schema` are engine internals and get filtered out of
/// the sidebar.
const USER_SCHEMA: &str = "iox";

#[derive(Clone)]
pub struct Influxdb3Client {
    http: HttpClient,
    /// Normalized `http[s]://host:port` — no trailing slash.
    base_url: String,
    /// Bearer token from `config.password`. `None` when the server runs
    /// with `--without-auth`.
    token: Option<String>,
    /// Optional custom query-string appended to `/api/v3/query_sql`.
    url_params: Option<String>,
    /// Default target database from `config.database`. Used when no
    /// caller-supplied database is given (list_databases,
    /// test_connection).
    default_database: Option<String>,
}

impl Influxdb3Client {
    pub fn new_for_config(url: &str, config: &ConnectionConfig, timeout: Duration) -> Result<Self, String> {
        let http = build_http_client(Some(&config.ca_cert_path), timeout)?;
        let default_database =
            config.database.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
        let token = (!config.password.is_empty()).then_some(config.password.clone());
        Ok(Self {
            http,
            base_url: url.trim_end_matches('/').to_string(),
            token,
            url_params: config.url_params.clone(),
            default_database,
        })
    }
}

fn build_http_client(ca_cert_path: Option<&str>, timeout: Duration) -> Result<HttpClient, String> {
    let mut builder = HttpClient::builder().connect_timeout(timeout);
    if let Some(path) = ca_cert_path.map(str::trim).filter(|path| !path.is_empty()) {
        let path = expand_cert_path(path);
        let cert_bytes =
            fs::read(&path).map_err(|e| format!("Failed to read InfluxDB 3 CA certificate at {path}: {e}"))?;
        let cert = Certificate::from_pem(&cert_bytes)
            .or_else(|_| Certificate::from_der(&cert_bytes))
            .map_err(|e| format!("Failed to parse InfluxDB 3 CA certificate at {path}: {e}"))?;
        builder = builder.add_root_certificate(cert);
    }
    builder.build().map_err(|e| format!("Failed to configure InfluxDB 3 HTTP client: {e}"))
}

fn expand_cert_path(path: &str) -> String {
    let home = || std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok();
    if path == "~" || path.starts_with("~/") || path.starts_with("~\\") {
        if let Some(home) = home() {
            return format!("{}{}", home, &path[1..]);
        }
    }
    if let Some(rest) = path.strip_prefix("$HOME") {
        if let Some(home) = home() {
            return format!("{home}{rest}");
        }
    }
    if let Some(rest) = path.strip_prefix("${HOME}") {
        if let Some(home) = home() {
            return format!("{home}{rest}");
        }
    }
    if let Some(rest) = path.strip_prefix("%USERPROFILE%") {
        if let Ok(home) = std::env::var("USERPROFILE") {
            return format!("{home}{rest}");
        }
    }
    path.to_string()
}

fn auth(client: &Influxdb3Client, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match client.token.as_deref().map(str::trim).filter(|token| !token.is_empty()) {
        Some(token) => req.header("Authorization", format!("Bearer {token}")),
        None => req,
    }
}

fn query_url(client: &Influxdb3Client) -> String {
    match client.url_params.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(params) => format!("{}/api/v3/query_sql?{params}", client.base_url),
        None => format!("{}/api/v3/query_sql", client.base_url),
    }
}

#[derive(Serialize)]
struct QueryBody<'a> {
    db: &'a str,
    q: &'a str,
    format: &'static str,
}

#[derive(Deserialize, Default)]
struct ErrorBody {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// The single HTTP round-trip every code path (test_connection,
/// list_databases, list_tables, get_columns, execute_query) ends up
/// executing. Keeping this as the sole "does the wire actually work"
/// primitive is why test_connection can prove the real query path.
async fn post_query_json(
    client: &Influxdb3Client,
    database: &str,
    sql: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let url = query_url(client);
    let body = QueryBody { db: database, q: sql, format: "json" };
    let resp = auth(client, client.http.post(&url).json(&body))
        .send()
        .await
        .map_err(|e| format!("InfluxDB 3 request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(error_message(resp).await);
    }
    let text = resp.text().await.unwrap_or_default();
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<serde_json::Value>>(&text)
        .map_err(|e| format!("InfluxDB 3 JSON parse error: {e}; response: {text}"))
}

async fn error_message(resp: Response) -> String {
    let status = resp.status();
    let hint = match status {
        StatusCode::UNAUTHORIZED => Some("Unauthorized — check the token."),
        StatusCode::FORBIDDEN => Some("Access denied."),
        StatusCode::NOT_FOUND => Some("Endpoint not found — verify the InfluxDB 3 base URL."),
        _ => None,
    };
    let body = resp.text().await.unwrap_or_default();
    let extracted = serde_json::from_str::<ErrorBody>(&body).ok().and_then(|value| {
        value.error.filter(|msg| !msg.trim().is_empty()).or_else(|| value.message.filter(|msg| !msg.trim().is_empty()))
    });
    let message = extracted.or_else(|| hint.map(str::to_string)).unwrap_or_else(|| {
        if body.trim().is_empty() {
            format!("Unknown error (HTTP {})", status.as_str())
        } else {
            body
        }
    });
    format!("InfluxDB 3 error: status = {}, message = {message}", status.as_str())
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/// Validate the connection by running the same `POST /api/v3/query_sql`
/// call every real query uses — proves the base URL, TLS, auth token,
/// **and** the query endpoint all work end-to-end. With no configured
/// default database the first database visible to the token is probed;
/// `_internal` exists on every Core install but is admin-only on
/// Enterprise, so it is only the last resort.
pub async fn test_connection(client: &Influxdb3Client, timeout: Duration) -> Result<(), String> {
    let fallback_database = match client.default_database.as_deref() {
        Some(database) => Some(database.to_string()),
        None => list_databases(client)
            .await
            .ok()
            .and_then(|databases| databases.first().map(|database| database.name.clone())),
    };
    let database = fallback_database.as_deref().unwrap_or(BOOTSTRAP_DATABASE);
    with_connection_timeout("InfluxDB 3", timeout, async {
        post_query_json(client, database, "SELECT 1").await.map(|_| ())
    })
    .await
}

pub async fn list_databases(client: &Influxdb3Client) -> Result<Vec<DatabaseInfo>, String> {
    // The admin endpoint is the canonical way to enumerate databases on
    // Core. `?format=json` is required — omitting it returns 400.
    let url = format!("{}/api/v3/configure/database?format=json", client.base_url);
    let resp =
        auth(client, client.http.get(&url)).send().await.map_err(|e| format!("InfluxDB 3 request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(error_message(resp).await);
    }
    let text = resp.text().await.unwrap_or_default();
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(&text).map_err(|e| format!("InfluxDB 3 JSON parse error: {e}; response: {text}"))?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let obj = row.as_object()?;
            obj.get("iox::database")
                .or_else(|| obj.get("db_name"))
                .or_else(|| obj.get("name"))
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .map(|name| DatabaseInfo {
                    name: name.to_string(),
                    size_bytes: None,
                    created_at: None,
                    updated_at: None,
                    comment: None,
                    default_charset: None,
                    default_collation: None,
                })
        })
        .collect())
}

pub async fn list_tables(client: &Influxdb3Client, database: &str) -> Result<Vec<TableInfo>, String> {
    // `SHOW TABLES` returns rows across every catalog schema. User
    // measurements live under `iox`; `system` / `information_schema`
    // are engine internals and would just clutter the sidebar.
    let rows = post_query_json(client, database, "SHOW TABLES").await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let obj = row.as_object()?;
            let schema = obj.get("table_schema").and_then(serde_json::Value::as_str).unwrap_or("");
            if schema != USER_SCHEMA {
                return None;
            }
            let name =
                obj.get("table_name").or_else(|| obj.get("name")).and_then(serde_json::Value::as_str)?.to_string();
            Some(TableInfo {
                name,
                table_type: "TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            })
        })
        .collect())
}

pub async fn get_columns(client: &Influxdb3Client, database: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let sql = format!(
        "SELECT column_name, data_type, is_nullable \
         FROM information_schema.columns \
         WHERE table_name = '{}' AND table_schema = '{}'",
        escape_sql_literal(table),
        USER_SCHEMA
    );
    let rows = post_query_json(client, database, &sql).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let obj = row.as_object()?;
            let name = obj.get("column_name").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
            if name.is_empty() {
                return None;
            }
            let data_type = obj.get("data_type").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
            let is_nullable = obj
                .get("is_nullable")
                .and_then(serde_json::Value::as_str)
                .map(|value| !value.eq_ignore_ascii_case("NO"))
                .unwrap_or(true);
            Some(ColumnInfo {
                name: name.clone(),
                data_type,
                is_nullable,
                is_primary_key: name == "time",
                ..Default::default()
            })
        })
        .collect())
}

pub async fn execute_query(
    client: &Influxdb3Client,
    database: &str,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    // When the caller only wants N rows, push `LIMIT N + 1` down into
    // the SQL so the server never serializes more than that. The `+1`
    // lets the caller detect truncation. Only rewrite pure top-level
    // SELECT statements that don't already carry a LIMIT — anything
    // else (SHOW, INSERT, CTEs with LIMIT, etc.) runs verbatim.
    let start = Instant::now();
    let effective_sql = max_rows.and_then(|limit| inject_limit(sql, limit)).unwrap_or_else(|| sql.to_string());
    let rows = post_query_json(client, database, &effective_sql).await?;
    Ok(build_query_result(rows, start))
}

fn build_query_result(rows: Vec<serde_json::Value>, start: Instant) -> QueryResult {
    // Preserve the first row's key order — /api/v3/query_sql already
    // emits columns in a stable order, and the frontend grid renders
    // headers from `columns`, so we mirror that here.
    let mut columns: Vec<String> = Vec::new();
    let mut column_index = std::collections::BTreeMap::<String, usize>::new();
    for row in &rows {
        if let Some(obj) = row.as_object() {
            for (key, _) in obj {
                if !column_index.contains_key(key) {
                    column_index.insert(key.clone(), columns.len());
                    columns.push(key.clone());
                }
            }
        }
    }
    let mut out_rows = Vec::with_capacity(rows.len());
    for row in rows {
        let mut cells = vec![serde_json::Value::Null; columns.len()];
        if let Some(obj) = row.as_object() {
            for (key, value) in obj {
                if let Some(&idx) = column_index.get(key) {
                    cells[idx] = value.clone();
                }
            }
        }
        out_rows.push(cells);
    }
    let affected = out_rows.len() as u64;
    QueryResult {
        column_sortables: columns.iter().map(|_| false).collect(),
        spatial_columns: vec![],
        spatial_values: vec![],
        columns,
        column_types: vec![],
        rows: out_rows,
        affected_rows: affected,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: vec![],
    }
}

fn escape_sql_literal(value: &str) -> String {
    value.replace('\'', "''")
}

fn select_head_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)^\s*(--[^\n]*\n|/\*.*?\*/|\s)*select\b").unwrap())
}

fn limit_clause_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // Word-boundary LIMIT that isn't inside a string literal. The
    // (?i) makes it case-insensitive; a real SQL parser would be
    // safer, but this is only used to *avoid over-applying* the
    // rewrite — false positives just leave the SQL unchanged.
    RE.get_or_init(|| Regex::new(r"(?i)\blimit\b").unwrap())
}

fn inject_limit(sql: &str, max_rows: usize) -> Option<String> {
    let trimmed = sql.trim_end_matches(|c: char| c.is_whitespace() || c == ';');
    if !select_head_re().is_match(trimmed) {
        return None;
    }
    if limit_clause_re().is_match(trimmed) {
        return None;
    }
    let cap = max_rows.saturating_add(1);
    Some(format!("{trimmed} LIMIT {cap}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn client() -> Influxdb3Client {
        Influxdb3Client {
            http: HttpClient::new(),
            base_url: "http://localhost:8181".to_string(),
            token: Some("t".to_string()),
            url_params: None,
            default_database: Some("mydb".to_string()),
        }
    }

    #[test]
    fn config_reads_bearer_token_and_default_database() {
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id": "influx3",
            "name": "InfluxDB 3",
            "db_type": "influxdb3",
            "host": "127.0.0.1",
            "port": 8181,
            "username": "",
            "password": "my-token",
            "database": "metrics"
        }))
        .unwrap();
        let c = Influxdb3Client::new_for_config("http://localhost:8181/", &config, Duration::from_secs(1)).unwrap();
        assert_eq!(c.token.as_deref(), Some("my-token"));
        assert_eq!(c.default_database.as_deref(), Some("metrics"));
        assert_eq!(c.base_url, "http://localhost:8181");
    }

    #[test]
    fn empty_password_skips_authorization_header() {
        // Servers running with `--without-auth` accept the driver
        // when the user leaves the token blank.
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id": "influx3",
            "name": "InfluxDB 3",
            "db_type": "influxdb3",
            "host": "127.0.0.1",
            "port": 8181,
            "username": "",
            "password": ""
        }))
        .unwrap();
        let c = Influxdb3Client::new_for_config("http://localhost:8181", &config, Duration::from_secs(1)).unwrap();
        assert!(c.token.is_none());
    }

    #[test]
    fn query_url_appends_url_params() {
        let mut c = client();
        c.url_params = Some("trace=1".to_string());
        assert_eq!(query_url(&c), "http://localhost:8181/api/v3/query_sql?trace=1");
    }

    #[test]
    fn inject_limit_wraps_bare_select() {
        let sql = "SELECT * FROM cpu ORDER BY time DESC";
        assert_eq!(inject_limit(sql, 100).as_deref(), Some("SELECT * FROM cpu ORDER BY time DESC LIMIT 101"));
    }

    #[test]
    fn inject_limit_respects_existing_limit() {
        let sql = "SELECT * FROM cpu LIMIT 50";
        assert!(inject_limit(sql, 100).is_none());
    }

    #[test]
    fn inject_limit_ignores_non_select_statements() {
        assert!(inject_limit("SHOW TABLES", 100).is_none());
        assert!(inject_limit("INSERT INTO t VALUES (1)", 100).is_none());
    }

    #[test]
    fn inject_limit_handles_leading_comments() {
        let sql = "-- keep only recent rows\nSELECT * FROM cpu";
        assert_eq!(inject_limit(sql, 5).as_deref(), Some("-- keep only recent rows\nSELECT * FROM cpu LIMIT 6"));
    }

    #[test]
    fn inject_limit_trims_trailing_semicolon() {
        let sql = "SELECT 1;";
        assert_eq!(inject_limit(sql, 10).as_deref(), Some("SELECT 1 LIMIT 11"));
    }

    #[test]
    fn build_query_result_flattens_json_rows_preserving_first_seen_column_order() {
        let rows = vec![
            json!({ "time": "2026-01-01T00:00:00Z", "host": "a", "value": 1 }),
            json!({ "time": "2026-01-01T00:01:00Z", "host": "b", "value": 2 }),
        ];
        let result = build_query_result(rows, Instant::now());
        assert_eq!(result.columns, vec!["time", "host", "value"]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.affected_rows, 2);
    }

    #[test]
    fn escape_sql_literal_doubles_single_quotes() {
        assert_eq!(escape_sql_literal("a'b"), "a''b");
    }
}
