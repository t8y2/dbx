use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::{Certificate, Client as HttpClient};
use serde::Deserialize;
use std::fs;
use std::time::{Duration, Instant};

use super::with_connection_timeout;
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{ColumnInfo, DatabaseInfo, QueryResult, TableInfo};

pub struct InfluxdbClient {
    http: HttpClient,
    base_url: String,
    username: Option<String>,
    password: Option<String>,
    url_params: Option<String>,
}

impl InfluxdbClient {
    pub fn new(
        url: &str,
        username: Option<String>,
        password: Option<String>,
        url_params: Option<String>,
        timeout: Duration,
    ) -> Self {
        let http = HttpClient::builder().connect_timeout(timeout).build().unwrap_or_else(|_| HttpClient::new());
        Self { http, base_url: url.trim_end_matches('/').to_string(), username, password, url_params }
    }

    pub fn new_with_ca_cert(
        url: &str,
        username: Option<String>,
        password: Option<String>,
        url_params: Option<String>,
        ca_cert_path: Option<&str>,
        timeout: Duration,
    ) -> Result<Self, String> {
        let mut builder = HttpClient::builder().connect_timeout(timeout);
        if let Some(path) = ca_cert_path.map(str::trim).filter(|path| !path.is_empty()) {
            let path = expand_cert_path(path);
            let cert_bytes =
                fs::read(&path).map_err(|e| format!("Failed to read InfluxDB CA certificate at {path}: {e}"))?;
            let cert = Certificate::from_pem(&cert_bytes)
                .or_else(|_| Certificate::from_der(&cert_bytes))
                .map_err(|e| format!("Failed to parse InfluxDB CA certificate at {path}: {e}"))?;
            builder = builder.add_root_certificate(cert);
        }
        let http = builder.build().map_err(|e| format!("Failed to configure InfluxDB HTTP client: {e}"))?;
        Ok(Self { http, base_url: url.trim_end_matches('/').to_string(), username, password, url_params })
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

impl Clone for InfluxdbClient {
    fn clone(&self) -> Self {
        Self {
            http: self.http.clone(),
            base_url: self.base_url.clone(),
            username: self.username.clone(),
            password: self.password.clone(),
            url_params: self.url_params.clone(),
        }
    }
}

#[derive(Deserialize, Default)]
struct InfluxErrorResult {
    #[serde(default)]
    error: String,
}

#[derive(Deserialize)]
struct InfluxJsonResult {
    results: Vec<InfluxQueryResult>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct InfluxQueryResult {
    /// The `statement_id` field may not be included in older versions (such as 1.1)
    #[serde(default)]
    #[allow(dead_code)]
    statement_id: usize,
    #[serde(default)]
    #[allow(dead_code)]
    series: Vec<InfluxSeries>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct InfluxSeries {
    #[serde(default)]
    #[allow(dead_code)]
    name: String,
    columns: Vec<String>,
    values: Vec<Vec<serde_json::Value>>,
}

fn build_query_url(client: &InfluxdbClient, database: Option<&str>, sql: &str) -> String {
    let mut params: Vec<String> = vec![];
    if let Some(url_params) = &client.url_params {
        params.push(url_params.to_string())
    }
    if let Some(db) = database {
        params.push(format!("db={db}"));
    }
    let encoded_sql = utf8_percent_encode(sql, NON_ALPHANUMERIC);
    params.push(format!("q={encoded_sql}"));
    format!("{}/query?{}", &client.base_url, params.join("&").as_str())
}

fn build_request(client: &InfluxdbClient, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match (&client.username, &client.password) {
        (Some(u), Some(p)) if !u.is_empty() => req.basic_auth(u, Some(p)),
        (Some(u), None) if !u.is_empty() => req.basic_auth(u, None::<&str>),
        _ => req,
    }
}

async fn influx_query(client: &InfluxdbClient, sql: &str, database: Option<&str>) -> Result<InfluxJsonResult, String> {
    let url = build_query_url(&client, database, sql);
    log::info!("[influxdb] query url={url} username={:?} password={}", client.username, client.password.is_some());

    let req = if starts_with_executable_sql_keyword(sql, &["SELECT", "SHOW"]) {
        build_request(client, client.http.get(&url))
    } else {
        build_request(client, client.http.post(&url))
    };

    let resp = req.send().await.map_err(|e| format!("InfluxDB request failed: {e}"))?;
    log::info!("[influxdb] response status={}", resp.status());
    if !resp.status().is_success() {
        let error_json = resp.json::<InfluxErrorResult>().await.unwrap_or_default();
        let msg = error_json.error;
        log::error!("[influxdb] error: {msg}");
        return Err(format!("InfluxDB error: {msg}"));
    }
    resp.json::<InfluxJsonResult>().await.map_err(|e| format!("InfluxDB parse error: {e}"))
}

pub async fn test_connection(client: &InfluxdbClient, timeout: Duration) -> Result<(), String> {
    let url = format!("{}/query?q=SHOW DATABASES", client.base_url);
    let req = build_request(client, client.http.get(&url));
    let resp = with_connection_timeout("InfluxDB", timeout, async {
        req.send().await.map_err(|e| format!("InfluxDB connection failed: {e}"))
    })
    .await?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("InfluxDB error: {body}"));
    }
    Ok(())
}

pub async fn list_databases(client: &InfluxdbClient) -> Result<Vec<DatabaseInfo>, String> {
    let result = influx_query(client, "SHOW DATABASES", None).await?;
    Ok(result
        .results
        .iter()
        .flat_map(|r| &r.series)
        .flat_map(|s| &s.values)
        .map(|row| DatabaseInfo { name: row[0].as_str().unwrap_or("").to_string() })
        .collect())
}

pub async fn list_tables(client: &InfluxdbClient, database: &str) -> Result<Vec<TableInfo>, String> {
    let result = influx_query(client, "SHOW MEASUREMENTS", Some(database)).await?;
    let empty = vec![];
    let series = result.results.first().map(|r| &r.series).unwrap_or(&empty);
    if series.is_empty() {
        return Ok(vec![]);
    }
    let first_series = &series[0];
    Ok(first_series
        .values
        .iter()
        .map(|row| TableInfo {
            name: row[0].as_str().unwrap_or("").to_string(),
            table_type: "TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        })
        .collect())
}

pub async fn get_columns(client: &InfluxdbClient, database: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let empty = vec![];

    let tag_sql = format!("SHOW TAG KEYS FROM \"{}\"", table);
    let tag_result = influx_query(client, &tag_sql, Some(database)).await?;
    let tag_series = tag_result.results.first().map(|r| &r.series).unwrap_or(&empty);

    let field_sql = format!("SHOW FIELD KEYS FROM \"{}\"", table);
    let field_result = influx_query(client, &field_sql, Some(database)).await?;
    let field_series = field_result.results.first().map(|r| &r.series).unwrap_or(&empty);

    let time_col = ColumnInfo {
        name: "time".to_string(),
        data_type: "timestamp".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: true,
        extra: None,
        comment: None,
        numeric_precision: None,
        numeric_scale: None,
        character_maximum_length: None,
    };

    let cols: Vec<ColumnInfo> = std::iter::once(time_col)
        .chain(tag_series.first().into_iter().flat_map(|s| s.values.iter()).map(|row| ColumnInfo {
            name: row[0].as_str().unwrap_or("").to_string(),
            data_type: "string".to_string(),
            is_nullable: true,
            column_default: None,
            is_primary_key: true,
            extra: None,
            comment: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
        }))
        .chain(field_series.first().into_iter().flat_map(|s| s.values.iter()).map(|row| {
            let data_type = row.get(1).and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
            ColumnInfo {
                name: row[0].as_str().unwrap_or("").to_string(),
                data_type,
                is_nullable: true,
                column_default: None,
                is_primary_key: false,
                extra: None,
                comment: None,
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
            }
        }))
        .collect();

    Ok(cols)
}

pub async fn execute_query(client: &InfluxdbClient, database: &str, sql: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let url = build_query_url(&client, Some(database), sql);
    let req = if starts_with_executable_sql_keyword(sql, &["SELECT", "SHOW"]) {
        build_request(client, client.http.get(&url))
    } else {
        build_request(client, client.http.post(&url))
    };
    let resp = req.send().await.map_err(|e| format!("InfluxDB request failed: {e}"))?;
    if !resp.status().is_success() {
        let error_json = resp.json::<InfluxErrorResult>().await.unwrap_or_default();
        let msg = error_json.error;
        return Err(format!("InfluxDB error: {msg}"));
    }
    let json = resp.json::<InfluxJsonResult>().await.map_err(|e| format!("InfluxDB parse error: {e}"))?;
    let series = json.results.iter().flat_map(|r| &r.series).next();
    match series {
        Some(s) => Ok(QueryResult {
            columns: s.columns.clone(),
            column_types: vec![],
            column_sortables: s.columns.iter().map(|_| false).collect(),
            rows: s.values.clone(),
            affected_rows: s.values.len() as u64,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        }),
        None => Ok(QueryResult {
            columns: vec![],
            column_types: vec![],
            column_sortables: vec![],
            rows: vec![],
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_url() {
        let client = InfluxdbClient {
            http: reqwest::Client::new(),
            base_url: "http://localhost:8086".to_string(),
            username: None,
            password: None,
            url_params: None,
        };
        let url = build_query_url(&client, Some("sample"), "SHOW DATABASES");

        assert_eq!(url, "http://localhost:8086/query?db=sample&q=SHOW%20DATABASES");
    }
}
