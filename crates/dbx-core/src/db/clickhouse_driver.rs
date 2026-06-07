use reqwest::{Certificate, Client as HttpClient};
use serde::Deserialize;
use std::fs;
use std::time::{Duration, Instant};

use super::with_connection_timeout;
use crate::query::MAX_ROWS;
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{ColumnInfo, DatabaseInfo, QueryResult, TableInfo};

pub struct ChClient {
    http: HttpClient,
    base_url: String,
    username: Option<String>,
    password: Option<String>,
}

impl ChClient {
    pub fn new(url: &str, username: Option<String>, password: Option<String>, timeout: Duration) -> Self {
        let http = HttpClient::builder().connect_timeout(timeout).build().unwrap_or_else(|_| HttpClient::new());
        Self { http, base_url: url.trim_end_matches('/').to_string(), username, password }
    }

    pub fn new_with_ca_cert(
        url: &str,
        username: Option<String>,
        password: Option<String>,
        ca_cert_path: Option<&str>,
        timeout: Duration,
    ) -> Result<Self, String> {
        let mut builder = HttpClient::builder().connect_timeout(timeout);
        if let Some(path) = ca_cert_path.map(str::trim).filter(|path| !path.is_empty()) {
            let path = expand_cert_path(path);
            let cert_bytes =
                fs::read(&path).map_err(|e| format!("Failed to read ClickHouse CA certificate at {path}: {e}"))?;
            let cert = Certificate::from_pem(&cert_bytes)
                .or_else(|_| Certificate::from_der(&cert_bytes))
                .map_err(|e| format!("Failed to parse ClickHouse CA certificate at {path}: {e}"))?;
            builder = builder.add_root_certificate(cert);
        }
        let http = builder.build().map_err(|e| format!("Failed to configure ClickHouse HTTP client: {e}"))?;
        Ok(Self { http, base_url: url.trim_end_matches('/').to_string(), username, password })
    }
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

impl Clone for ChClient {
    fn clone(&self) -> Self {
        Self {
            http: self.http.clone(),
            base_url: self.base_url.clone(),
            username: self.username.clone(),
            password: self.password.clone(),
        }
    }
}

#[derive(Deserialize)]
struct ChJsonResult {
    meta: Vec<ChColumn>,
    data: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    #[allow(dead_code)]
    rows: usize,
}

#[derive(Deserialize)]
struct ChColumn {
    name: String,
    #[serde(rename = "type")]
    _type: String,
}

enum QueryResultLimit {
    Unlimited,
    Limited(usize),
}

fn build_query_url(base_url: &str, database: Option<&str>, limit: QueryResultLimit) -> String {
    let mut url = format!("{}/?default_format=JSONCompact", base_url);
    if let Some(db) = database {
        url.push_str(&format!("&database={db}"));
    }
    if let QueryResultLimit::Limited(max_rows) = limit {
        url.push_str(&format!("&max_result_rows={max_rows}&result_overflow_mode=break"));
    }
    url
}

fn build_request(client: &ChClient, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match (&client.username, &client.password) {
        (Some(u), Some(p)) if !u.is_empty() => req.basic_auth(u, Some(p)),
        (Some(u), None) if !u.is_empty() => req.basic_auth(u, None::<&str>),
        _ => req,
    }
}

async fn ch_query(client: &ChClient, sql: &str, database: Option<&str>) -> Result<ChJsonResult, String> {
    ch_query_with_limit(client, sql, database, QueryResultLimit::Unlimited).await
}

async fn ch_query_with_limit(
    client: &ChClient,
    sql: &str,
    database: Option<&str>,
    limit: QueryResultLimit,
) -> Result<ChJsonResult, String> {
    let url = build_query_url(&client.base_url, database, limit);
    log::info!("[clickhouse] query url={url} user={:?} has_pass={}", client.username, client.password.is_some());
    let req = build_request(client, client.http.post(&url).body(sql.to_string()));
    let resp = req.send().await.map_err(|e| format!("ClickHouse request failed: {e}"))?;
    log::info!("[clickhouse] response status={}", resp.status());
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        log::error!("[clickhouse] error body: {body}");
        return Err(format!("ClickHouse error: {body}"));
    }
    resp.json::<ChJsonResult>().await.map_err(|e| format!("ClickHouse parse error: {e}"))
}

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(MAX_ROWS).max(1)
}

fn limited_query_result(result: ChJsonResult, execution_time_ms: u128, max_rows: Option<usize>) -> QueryResult {
    let columns: Vec<String> = result.meta.iter().map(|c| c.name.clone()).collect();
    let column_types: Vec<String> = result.meta.iter().map(|c| c._type.clone()).collect();
    let mut rows = result.data;
    let row_limit = query_result_row_limit(max_rows);
    let truncated = rows.len() > row_limit;
    if truncated {
        rows.truncate(row_limit);
    }
    QueryResult {
        columns,
        column_types,
        rows,
        affected_rows: 0,
        execution_time_ms,
        truncated,
        session_id: None,
        has_more: false,
    }
}

pub async fn test_connection(client: &ChClient, timeout: Duration) -> Result<(), String> {
    let url = format!("{}/?query=SELECT%201", client.base_url);
    let req = build_request(client, client.http.get(&url));
    let resp = with_connection_timeout("ClickHouse", timeout, async {
        req.send().await.map_err(|e| format!("ClickHouse connection failed: {e}"))
    })
    .await?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("ClickHouse error: {body}"));
    }
    Ok(())
}

pub async fn list_databases(client: &ChClient) -> Result<Vec<DatabaseInfo>, String> {
    let result = ch_query(client, "SELECT name FROM system.databases ORDER BY name", None).await?;
    Ok(result.data.iter().map(|row| DatabaseInfo { name: row[0].as_str().unwrap_or("").to_string() }).collect())
}

pub async fn list_tables(client: &ChClient, database: &str) -> Result<Vec<TableInfo>, String> {
    let sql = format!(
        "SELECT name, engine FROM system.tables WHERE database = '{}' ORDER BY name",
        database.replace('\'', "\\'")
    );
    let result = ch_query(client, &sql, Some(database)).await?;
    Ok(result
        .data
        .iter()
        .map(|row| {
            let engine = row.get(1).and_then(|v| v.as_str()).unwrap_or("");
            let table_type = if engine.contains("View") { "VIEW" } else { "BASE TABLE" };
            TableInfo {
                name: row[0].as_str().unwrap_or("").to_string(),
                table_type: table_type.to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }
        })
        .collect())
}

pub async fn get_columns(client: &ChClient, database: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let sql = format!(
        "SELECT name, type, default_kind, default_expression, is_in_primary_key, comment \
         FROM system.columns WHERE database = '{}' AND table = '{}' ORDER BY position",
        database.replace('\'', "\\'"),
        table.replace('\'', "\\'")
    );
    let result = ch_query(client, &sql, Some(database)).await?;
    Ok(result
        .data
        .iter()
        .map(|row| {
            let data_type = row.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let is_nullable = data_type.starts_with("Nullable");
            let is_pk = row.get(4).and_then(|v| v.as_u64()).unwrap_or(0) == 1;
            let default_kind = row.get(2).and_then(|v| v.as_str()).unwrap_or("");
            let default_expr = row.get(3).and_then(|v| v.as_str()).unwrap_or("");
            let column_default = if default_kind.is_empty() { None } else { Some(default_expr.to_string()) };
            ColumnInfo {
                name: row[0].as_str().unwrap_or("").to_string(),
                data_type,
                is_nullable,
                column_default,
                is_primary_key: is_pk,
                extra: None,
                comment: row.get(5).and_then(|v| v.as_str()).filter(|value| !value.is_empty()).map(str::to_string),
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
            }
        })
        .collect())
}

pub async fn execute_query(client: &ChClient, database: &str, sql: &str) -> Result<QueryResult, String> {
    execute_query_with_max_rows(client, database, sql, None).await
}

pub async fn execute_query_with_max_rows(
    client: &ChClient,
    database: &str,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let row_limit = query_result_row_limit(max_rows);

    if starts_with_executable_sql_keyword(sql, &["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH"]) {
        let result = ch_query_with_limit(client, sql, Some(database), QueryResultLimit::Limited(row_limit + 1)).await?;
        Ok(limited_query_result(result, start.elapsed().as_millis(), Some(row_limit)))
    } else {
        let url = build_query_url(&client.base_url, Some(database), QueryResultLimit::Unlimited);
        let req = build_request(client, client.http.post(&url).body(sql.to_string()));
        let resp = req.send().await.map_err(|e| format!("ClickHouse request failed: {e}"))?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("ClickHouse error: {body}"));
        }
        Ok(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            rows: vec![],
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_url_for_result_sets_adds_row_limit_break_settings() {
        let url = build_query_url(
            "http://localhost:8123",
            Some("analytics"),
            QueryResultLimit::Limited(crate::query::MAX_ROWS + 1),
        );

        assert_eq!(
            url,
            "http://localhost:8123/?default_format=JSONCompact&database=analytics&max_result_rows=10001&result_overflow_mode=break"
        );
    }

    #[test]
    fn limited_query_result_truncates_extra_probe_row() {
        let result = ChJsonResult {
            meta: vec![ChColumn { name: "id".to_string(), _type: "UInt64".to_string() }],
            data: (0..=crate::query::MAX_ROWS).map(|value| vec![serde_json::Value::Number(value.into())]).collect(),
            rows: crate::query::MAX_ROWS + 1,
        };

        let result = limited_query_result(result, 12, None);

        assert_eq!(result.columns, vec!["id"]);
        assert_eq!(result.rows.len(), crate::query::MAX_ROWS);
        assert_eq!(result.execution_time_ms, 12);
        assert!(result.truncated);
    }
}
