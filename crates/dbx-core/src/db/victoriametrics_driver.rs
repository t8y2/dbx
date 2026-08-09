use chrono::{DateTime, Utc};
use reqwest::{Certificate, Client as HttpClient, Response};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::time::{Duration, Instant};

use super::with_connection_timeout;
use crate::models::connection::ConnectionConfig;
use crate::types::{ColumnInfo, DatabaseInfo, ObjectStatistics, QueryResult, TableInfo};

const DEFAULT_API_PATH: &str = "/prometheus";
const DEFAULT_LOOKBACK: &str = "1h";

#[derive(Clone)]
pub struct VictoriaMetricsClient {
    http: HttpClient,
    base_url: String,
    api_path: String,
    username: Option<String>,
    password: Option<String>,
    database_label: String,
    lookback: String,
}

#[derive(Debug, Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
struct ApiResponse<T> {
    status: String,
    #[serde(default)]
    data: Option<T>,
    #[serde(default)]
    error_type: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct QueryData {
    #[serde(rename = "resultType")]
    result_type: String,
    result: Value,
}

#[derive(Debug, Deserialize)]
struct SeriesResult {
    #[serde(default)]
    metric: HashMap<String, String>,
    #[serde(default)]
    value: Option<(f64, String)>,
    #[serde(default)]
    values: Vec<(f64, String)>,
}

#[derive(Debug, Deserialize)]
struct TsdbStatus {
    #[serde(rename = "seriesCountByMetricName", default)]
    series_count_by_metric_name: Vec<TsdbMetricStatistic>,
}

#[derive(Debug, Deserialize)]
struct TsdbMetricStatistic {
    name: String,
    value: Value,
}

impl VictoriaMetricsClient {
    pub fn new_for_config(url: &str, config: &ConnectionConfig, timeout: Duration) -> Result<Self, String> {
        let api_path = external_string(config, &["apiPath", "api_path"])
            .map(|value| normalize_api_path(&value))
            .unwrap_or_else(|| DEFAULT_API_PATH.to_string());
        let lookback = external_string(config, &["lookback"])
            .filter(|value| valid_lookback(value))
            .unwrap_or_else(|| DEFAULT_LOOKBACK.to_string());
        let database_label = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("metrics")
            .to_string();
        let http = build_http_client(Some(&config.ca_cert_path), timeout)?;
        Ok(Self {
            http,
            base_url: url.trim_end_matches('/').to_string(),
            api_path,
            username: (!config.username.trim().is_empty()).then(|| config.username.clone()),
            password: (!config.password.is_empty()).then(|| config.password.clone()),
            database_label,
            lookback,
        })
    }

    fn endpoint(&self, suffix: &str) -> String {
        format!("{}{}{}", self.base_url, self.api_path, suffix)
    }

    fn request(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match (&self.username, &self.password) {
            (Some(username), password) => request.basic_auth(username, password.as_deref()),
            _ => request,
        }
    }
}

fn external_string(config: &ConnectionConfig, keys: &[&str]) -> Option<String> {
    let value = config.external_config.as_ref()?;
    keys.iter()
        .find_map(|key| value.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_api_path(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        String::new()
    } else if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

fn valid_lookback(value: &str) -> bool {
    let value = value.trim();
    let split = value.find(|character: char| !character.is_ascii_digit()).unwrap_or(value.len());
    split > 0
        && split < value.len()
        && value[..split].parse::<u64>().is_ok_and(|number| number > 0)
        && matches!(&value[split..], "ms" | "s" | "m" | "h" | "d" | "w" | "y")
}

fn build_http_client(ca_cert_path: Option<&str>, timeout: Duration) -> Result<HttpClient, String> {
    let mut builder = HttpClient::builder().connect_timeout(timeout);
    if let Some(path) = ca_cert_path.map(str::trim).filter(|path| !path.is_empty()) {
        let path = expand_cert_path(path);
        let cert_bytes = fs::read(&path)
            .map_err(|error| format!("Failed to read VictoriaMetrics CA certificate at {path}: {error}"))?;
        let cert = Certificate::from_pem(&cert_bytes)
            .or_else(|_| Certificate::from_der(&cert_bytes))
            .map_err(|error| format!("Failed to parse VictoriaMetrics CA certificate at {path}: {error}"))?;
        builder = builder.add_root_certificate(cert);
    }
    builder.build().map_err(|error| format!("Failed to configure VictoriaMetrics HTTP client: {error}"))
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

pub async fn test_connection(client: &VictoriaMetricsClient, timeout: Duration) -> Result<(), String> {
    let request = client.request(client.http.get(client.endpoint("/api/v1/status/buildinfo")));
    let response = with_connection_timeout("VictoriaMetrics", timeout, async {
        request.send().await.map_err(|error| format!("VictoriaMetrics connection failed: {error}"))
    })
    .await?;
    parse_api_response::<Value>(response).await.map(|_| ())
}

pub async fn list_databases(client: &VictoriaMetricsClient) -> Result<Vec<DatabaseInfo>, String> {
    Ok(vec![DatabaseInfo { name: client.database_label.clone() }])
}

pub async fn list_tables(client: &VictoriaMetricsClient) -> Result<Vec<TableInfo>, String> {
    let request = client.request(
        client
            .http
            .get(client.endpoint("/api/v1/label/__name__/values"))
            .query(&[("start", format!("-{}", client.lookback))]),
    );
    let mut names = parse_api_response::<Vec<String>>(request.send().await.map_err(request_error)?).await?;
    names.sort();
    names.dedup();
    Ok(names
        .into_iter()
        .filter(|name| !name.trim().is_empty())
        .map(|name| TableInfo {
            name,
            table_type: "TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        })
        .collect())
}

pub async fn get_columns(client: &VictoriaMetricsClient, metric_name: &str) -> Result<Vec<ColumnInfo>, String> {
    let selector = metric_selector(metric_name);
    let request = client.request(
        client
            .http
            .post(client.endpoint("/api/v1/series"))
            .form(&[("match[]", selector.as_str()), ("start", format!("-{}", client.lookback).as_str())]),
    );
    let series =
        parse_api_response::<Vec<HashMap<String, String>>>(request.send().await.map_err(request_error)?).await?;
    let label_names = series
        .iter()
        .flat_map(|labels| labels.keys())
        .filter(|name| name.as_str() != "__name__")
        .cloned()
        .collect::<BTreeSet<_>>();

    let label_names = label_names.into_iter().collect::<Vec<_>>();
    let (timestamp_name, value_name, metric_name) = result_column_names(&label_names);
    let mut columns = vec![
        column(&timestamp_name, "timestamp", false, true, Some("Sample timestamp")),
        column(&value_name, "double", false, false, Some("Sample value")),
        column(&metric_name, "string", false, true, Some("Metric name")),
    ];
    columns.extend(label_names.into_iter().map(|name| column(&name, "string", true, true, Some("Metric label"))));
    Ok(columns)
}

pub async fn list_object_statistics(client: &VictoriaMetricsClient) -> Result<Vec<ObjectStatistics>, String> {
    let request = client.request(client.http.get(client.endpoint("/api/v1/status/tsdb"))).query(&[("topN", "100000")]);
    let status = parse_api_response::<TsdbStatus>(request.send().await.map_err(request_error)?).await?;
    Ok(status
        .series_count_by_metric_name
        .into_iter()
        .filter(|item| !item.name.trim().is_empty())
        .map(|item| ObjectStatistics {
            name: item.name,
            schema: None,
            estimated_rows: item.value.as_i64().or_else(|| item.value.as_str().and_then(|value| value.parse().ok())),
            // VictoriaMetrics exposes series counts here, but no per-metric storage size.
            total_bytes: None,
        })
        .collect())
}

fn column(name: &str, data_type: &str, is_nullable: bool, is_primary_key: bool, comment: Option<&str>) -> ColumnInfo {
    ColumnInfo {
        name: name.to_string(),
        data_type: data_type.to_string(),
        is_nullable,
        is_primary_key,
        comment: comment.map(str::to_string),
        ..Default::default()
    }
}

pub async fn execute_query(client: &VictoriaMetricsClient, query: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let query = query.trim().trim_end_matches(';').trim();
    if query.is_empty() {
        return Err("VictoriaMetrics query is empty".to_string());
    }
    let request = client.request(client.http.post(client.endpoint("/api/v1/query")).form(&[("query", query)]));
    let data = parse_api_response::<QueryData>(request.send().await.map_err(request_error)?).await?;
    query_data_to_result(data, start)
}

fn query_data_to_result(data: QueryData, start: Instant) -> Result<QueryResult, String> {
    match data.result_type.as_str() {
        "vector" | "matrix" => {
            let series = serde_json::from_value::<Vec<SeriesResult>>(data.result)
                .map_err(|error| format!("VictoriaMetrics response parse failed: {error}"))?;
            Ok(series_result_to_query_result(series, start))
        }
        "scalar" => {
            let (timestamp, value) = serde_json::from_value::<(f64, String)>(data.result)
                .map_err(|error| format!("VictoriaMetrics response parse failed: {error}"))?;
            Ok(simple_result(vec![vec![timestamp_value(timestamp), sample_value(&value)]], "double", start))
        }
        "string" => {
            let (timestamp, value) = serde_json::from_value::<(f64, String)>(data.result)
                .map_err(|error| format!("VictoriaMetrics response parse failed: {error}"))?;
            Ok(simple_result(vec![vec![timestamp_value(timestamp), Value::String(value)]], "string", start))
        }
        other => Err(format!("VictoriaMetrics returned unsupported result type: {other}")),
    }
}

fn series_result_to_query_result(series: Vec<SeriesResult>, start: Instant) -> QueryResult {
    let labels = series
        .iter()
        .flat_map(|item| item.metric.keys())
        .filter(|name| name.as_str() != "__name__")
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let (timestamp_name, value_name, metric_name) = result_column_names(&labels);
    let mut columns = vec![timestamp_name, value_name, metric_name];
    columns.extend(labels.iter().cloned());
    let mut rows = Vec::new();

    for item in series {
        let metric_name = item.metric.get("__name__").cloned().map(Value::String).unwrap_or(Value::Null);
        let samples = item.value.into_iter().chain(item.values);
        for (timestamp, value) in samples {
            let mut row = vec![timestamp_value(timestamp), sample_value(&value), metric_name.clone()];
            row.extend(
                labels.iter().map(|label| item.metric.get(label).cloned().map(Value::String).unwrap_or(Value::Null)),
            );
            rows.push(row);
        }
    }

    QueryResult {
        column_types: std::iter::once("timestamp".to_string())
            .chain(std::iter::once("double".to_string()))
            .chain(std::iter::repeat_n("string".to_string(), columns.len().saturating_sub(2)))
            .collect(),
        column_sortables: vec![true; columns.len()],
        columns,
        affected_rows: rows.len() as u64,
        rows,
        execution_time_ms: start.elapsed().as_millis(),
        spatial_columns: vec![],
        spatial_values: vec![],
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    }
}

fn result_column_names(labels: &[String]) -> (String, String, String) {
    let mut used = labels.iter().cloned().collect::<BTreeSet<_>>();
    let timestamp = unique_result_column_name("timestamp", "sample_timestamp", &mut used);
    let value = unique_result_column_name("value", "sample_value", &mut used);
    let metric = unique_result_column_name("metric", "metric_name", &mut used);
    (timestamp, value, metric)
}

fn unique_result_column_name(preferred: &str, fallback: &str, used: &mut BTreeSet<String>) -> String {
    let mut candidate = if used.contains(preferred) { fallback.to_string() } else { preferred.to_string() };
    let mut suffix = 2;
    while used.contains(&candidate) {
        candidate = format!("{fallback}_{suffix}");
        suffix += 1;
    }
    used.insert(candidate.clone());
    candidate
}

fn simple_result(rows: Vec<Vec<Value>>, value_type: &str, start: Instant) -> QueryResult {
    QueryResult {
        columns: vec!["timestamp".to_string(), "value".to_string()],
        column_types: vec!["timestamp".to_string(), value_type.to_string()],
        column_sortables: vec![true, true],
        affected_rows: rows.len() as u64,
        rows,
        execution_time_ms: start.elapsed().as_millis(),
        spatial_columns: vec![],
        spatial_values: vec![],
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    }
}

fn timestamp_value(timestamp: f64) -> Value {
    DateTime::<Utc>::from_timestamp(timestamp.trunc() as i64, (timestamp.fract() * 1_000_000_000.0) as u32)
        .map(|value| Value::String(value.to_rfc3339()))
        .unwrap_or_else(|| json!(timestamp))
}

fn sample_value(value: &str) -> Value {
    value
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .map(|number| json!(number))
        .unwrap_or_else(|| json!(value))
}

pub fn metric_selector(metric_name: &str) -> String {
    format!(r#"{{__name__="{}"}}"#, escape_label_value(metric_name))
}

pub fn metric_range_query(metric_name: &str, lookback: &str) -> String {
    format!("{}[{}]", metric_selector(metric_name), if valid_lookback(lookback) { lookback } else { DEFAULT_LOOKBACK })
}

fn escape_label_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

async fn parse_api_response<T: for<'de> Deserialize<'de>>(response: Response) -> Result<T, String> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(http_error(status, &body));
    }
    let parsed = serde_json::from_str::<ApiResponse<T>>(&body)
        .map_err(|error| format!("VictoriaMetrics response parse failed: {error}; response: {body}"))?;
    if parsed.status != "success" {
        let kind =
            parsed.error_type.filter(|value| !value.is_empty()).map(|value| format!("{value}: ")).unwrap_or_default();
        return Err(format!(
            "VictoriaMetrics error: {kind}{}",
            parsed.error.unwrap_or_else(|| "unknown error".to_string())
        ));
    }
    parsed.data.ok_or_else(|| "VictoriaMetrics response is missing data".to_string())
}

fn http_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("error").and_then(Value::as_str).map(str::to_string))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| body.trim().to_string());
    let detail =
        if detail.is_empty() { status.canonical_reason().unwrap_or("request failed").to_string() } else { detail };
    format!("VictoriaMetrics error: status={}, message={detail}", status.as_u16())
}

fn request_error(error: reqwest::Error) -> String {
    format!("VictoriaMetrics request failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_api_paths_and_lookbacks() {
        assert_eq!(normalize_api_path("prometheus/"), "/prometheus");
        assert_eq!(normalize_api_path("/select/42/prometheus/"), "/select/42/prometheus");
        assert_eq!(normalize_api_path("/"), "");
        assert!(valid_lookback("15m"));
        assert!(valid_lookback("250ms"));
        assert!(!valid_lookback("0h"));
        assert!(!valid_lookback("1 hour"));
    }

    #[test]
    fn metric_queries_escape_label_values() {
        assert_eq!(metric_selector("rack\\\"temp"), r#"{__name__="rack\\\"temp"}"#);
        assert_eq!(metric_range_query("cpu_usage", "2h"), r#"{__name__="cpu_usage"}[2h]"#);
        assert_eq!(metric_range_query("cpu_usage", "bad"), r#"{__name__="cpu_usage"}[1h]"#);
    }

    #[test]
    fn parses_metric_statistics() {
        let status: TsdbStatus = serde_json::from_value(json!({
            "seriesCountByMetricName": [{"name": "flag", "value": "276"}]
        }))
        .unwrap();
        assert_eq!(status.series_count_by_metric_name[0].name, "flag");
        assert_eq!(status.series_count_by_metric_name[0].value.as_str(), Some("276"));
    }

    #[test]
    fn parses_matrix_results_into_rows() {
        let data = QueryData {
            result_type: "matrix".to_string(),
            result: json!([
                {
                    "metric": {"__name__": "temperature", "site": "shanghai"},
                    "values": [[1720000000.0, "23.5"], [1720000060.0, "24"]]
                }
            ]),
        };
        let result = query_data_to_result(data, Instant::now()).unwrap();
        assert_eq!(result.columns, vec!["timestamp", "value", "metric", "site"]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0][1], json!(23.5));
        assert_eq!(result.rows[0][2], json!("temperature"));
        assert_eq!(result.rows[0][3], json!("shanghai"));
    }

    #[test]
    fn keeps_reserved_label_names_unique() {
        let data = QueryData {
            result_type: "vector".to_string(),
            result: json!([
                {
                    "metric": {
                        "__name__": "flag",
                        "metric": "label-metric",
                        "timestamp": "label-timestamp",
                        "value": "label-value"
                    },
                    "value": [1720000000.0, "1"]
                }
            ]),
        };
        let result = query_data_to_result(data, Instant::now()).unwrap();
        assert_eq!(
            result.columns,
            vec!["sample_timestamp", "sample_value", "metric_name", "metric", "timestamp", "value"]
        );
        assert_eq!(result.rows[0].len(), result.columns.len());
        assert_eq!(result.rows[0][3], json!("label-metric"));
        assert_eq!(result.rows[0][5], json!("label-value"));
    }

    #[test]
    fn parses_scalar_and_preserves_non_finite_values() {
        let scalar = QueryData { result_type: "scalar".to_string(), result: json!([1720000000.0, "42"]) };
        let result = query_data_to_result(scalar, Instant::now()).unwrap();
        assert_eq!(result.rows[0][1], json!(42.0));
        assert_eq!(sample_value("NaN"), json!("NaN"));
    }

    #[test]
    fn keeps_string_query_results_as_strings() {
        let string = QueryData { result_type: "string".to_string(), result: json!([1720000000.0, "healthy"]) };
        let result = query_data_to_result(string, Instant::now()).unwrap();
        assert_eq!(result.column_types, vec!["timestamp", "string"]);
        assert_eq!(result.rows[0][1], json!("healthy"));
    }

    #[tokio::test]
    #[ignore = "requires DBX_LIVE_VICTORIAMETRICS_* env vars pointing at a VictoriaMetrics endpoint"]
    async fn live_connection_metadata_and_query() {
        let url = std::env::var("DBX_LIVE_VICTORIAMETRICS_URL").expect("DBX_LIVE_VICTORIAMETRICS_URL");
        let username = std::env::var("DBX_LIVE_VICTORIAMETRICS_USER").unwrap_or_default();
        let password = std::env::var("DBX_LIVE_VICTORIAMETRICS_PASSWORD").unwrap_or_default();
        let api_path = std::env::var("DBX_LIVE_VICTORIAMETRICS_API_PATH").unwrap_or_else(|_| "/prometheus".into());
        let metric = std::env::var("DBX_LIVE_VICTORIAMETRICS_METRIC").expect("DBX_LIVE_VICTORIAMETRICS_METRIC");
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id": "live-victoriametrics",
            "name": "Live VictoriaMetrics",
            "db_type": "victoriametrics",
            "host": "unused",
            "port": 8428,
            "username": username,
            "password": password,
            "database": "metrics",
            "external_config": { "apiPath": api_path, "lookback": "1h" }
        }))
        .expect("live VictoriaMetrics config");
        let client = VictoriaMetricsClient::new_for_config(&url, &config, Duration::from_secs(10)).unwrap();

        test_connection(&client, Duration::from_secs(10)).await.unwrap();
        let tables = list_tables(&client).await.unwrap();
        assert!(tables.iter().any(|table| table.name == metric));
        let columns = get_columns(&client, &metric).await.unwrap();
        assert!(columns.iter().any(|column| column.name == "timestamp"));
        assert!(columns.iter().any(|column| column.name == "value"));
        assert!(columns.iter().any(|column| column.name == "metric"));
        let statistics = list_object_statistics(&client).await.unwrap();
        assert!(statistics.iter().any(|stat| stat.name == metric && stat.estimated_rows.unwrap_or_default() > 0));
        let result = execute_query(&client, &metric_range_query(&metric, "1h")).await.unwrap();
        assert!(!result.rows.is_empty());
    }
}
