use futures::StreamExt;
use reqwest::{Certificate, Client as HttpClient};
use serde::Deserialize;
use std::fs;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use super::{http_client_builder, with_connection_timeout};
use crate::query::{canceled_error, MAX_ROWS};
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{ColumnInfo, DatabaseInfo, IndexInfo, ObjectStatistics, QueryResult, TableInfo};

pub struct ChClient {
    http: HttpClient,
    base_url: String,
    username: Option<String>,
    password: Option<String>,
    /// 用户在连接配置「URL 参数」中填写的自定义 HTTP query 参数（已归一化），
    /// 例如 `dialect_type=ANSI`，会追加到每次请求的 URL query string 上。
    extra_params: Option<String>,
}

impl ChClient {
    pub fn new(url: &str, username: Option<String>, password: Option<String>, timeout: Duration) -> Self {
        let http = http_client_builder(timeout).build().unwrap_or_else(|_| HttpClient::new());
        Self { http, base_url: url.trim_end_matches('/').to_string(), username, password, extra_params: None }
    }

    pub fn new_with_ca_cert(
        url: &str,
        username: Option<String>,
        password: Option<String>,
        ca_cert_path: Option<&str>,
        extra_params: Option<&str>,
        timeout: Duration,
    ) -> Result<Self, String> {
        let mut builder = http_client_builder(timeout);
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
        Ok(Self {
            http,
            base_url: url.trim_end_matches('/').to_string(),
            username,
            password,
            extra_params: normalize_extra_params(extra_params),
        })
    }
}

/// 归一化用户填写的「URL 参数」：去除首尾空白与开头的 `?`/`&`，
/// 返回可直接拼接到 query string 的片段；为空时返回 None。
fn normalize_extra_params(params: Option<&str>) -> Option<String> {
    let trimmed = params?.trim().trim_start_matches('?').trim_start_matches('&').trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
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
            extra_params: self.extra_params.clone(),
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

enum QueryResultFormat {
    JsonCompact,
    JsonCompactEachRowWithNamesAndTypes,
}

const CLICKHOUSE_STREAM_ROW_LIMIT_REACHED: &str = "__DBX_CLICKHOUSE_STREAM_ROW_LIMIT_REACHED__";

impl QueryResultFormat {
    fn as_str(&self) -> &'static str {
        match self {
            QueryResultFormat::JsonCompact => "JSONCompact",
            QueryResultFormat::JsonCompactEachRowWithNamesAndTypes => "JSONCompactEachRowWithNamesAndTypes",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClickHouseQueryStreamItem {
    Columns { columns: Vec<String>, column_types: Vec<String> },
    Row(Vec<serde_json::Value>),
}

fn build_query_url(
    base_url: &str,
    database: Option<&str>,
    limit: QueryResultLimit,
    extra_params: Option<&str>,
) -> String {
    build_query_url_with_format(base_url, database, limit, QueryResultFormat::JsonCompact, extra_params)
}

fn build_query_url_with_format(
    base_url: &str,
    database: Option<&str>,
    limit: QueryResultLimit,
    format: QueryResultFormat,
    extra_params: Option<&str>,
) -> String {
    let mut url = format!("{}/?default_format={}", base_url, format.as_str());
    if let Some(db) = database {
        url.push_str(&format!("&database={db}"));
    }
    if let QueryResultLimit::Limited(max_rows) = limit {
        url.push_str(&format!("&max_result_rows={max_rows}&result_overflow_mode=break"));
    }
    // 用户自定义 URL 参数放在最后追加，允许其覆盖前面的默认设置（ClickHouse 取同名参数的最后一个值）
    if let Some(params) = normalize_extra_params(extra_params) {
        url.push('&');
        url.push_str(&params);
    }
    url
}

#[derive(Default)]
struct ClickHouseStreamParser {
    line_index: usize,
    columns: Vec<String>,
}

impl ClickHouseStreamParser {
    fn parse_line(&mut self, line: &str) -> Result<Option<ClickHouseQueryStreamItem>, String> {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            return Ok(None);
        }

        match self.line_index {
            0 => {
                self.columns = parse_stream_string_array(line, "column names")?;
                self.line_index = 1;
                Ok(None)
            }
            1 => {
                let column_types = parse_stream_string_array(line, "column types")?;
                self.line_index = 2;
                Ok(Some(ClickHouseQueryStreamItem::Columns { columns: self.columns.clone(), column_types }))
            }
            _ => {
                let row = parse_stream_value_array(line, "row")?;
                self.line_index += 1;
                Ok(Some(ClickHouseQueryStreamItem::Row(row)))
            }
        }
    }

    fn finish(&self) -> Result<(), String> {
        if self.line_index == 1 {
            return Err("ClickHouse stream ended before column types were received".to_string());
        }
        Ok(())
    }
}

fn parse_stream_string_array(line: &str, label: &str) -> Result<Vec<String>, String> {
    parse_stream_value_array(line, label).map(|values| {
        values
            .into_iter()
            .map(|value| match value {
                serde_json::Value::String(value) => value,
                other => other.to_string(),
            })
            .collect()
    })
}

fn parse_stream_value_array(line: &str, label: &str) -> Result<Vec<serde_json::Value>, String> {
    serde_json::from_str(line).map_err(|e| format!("ClickHouse stream parse error in {label}: {e}"))
}

fn process_stream_buffer(
    buffer: &mut Vec<u8>,
    parser: &mut ClickHouseStreamParser,
    on_item: &mut impl FnMut(ClickHouseQueryStreamItem) -> Result<(), String>,
) -> Result<(), String> {
    while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
        let line_bytes: Vec<u8> = buffer.drain(..=newline).collect();
        let line_bytes = &line_bytes[..line_bytes.len().saturating_sub(1)];
        let line =
            std::str::from_utf8(line_bytes).map_err(|e| format!("ClickHouse stream contains invalid UTF-8: {e}"))?;
        if let Some(item) = parser.parse_line(line)? {
            on_item(item)?;
        }
    }
    Ok(())
}

fn process_stream_remainder(
    buffer: &mut Vec<u8>,
    parser: &mut ClickHouseStreamParser,
    on_item: &mut impl FnMut(ClickHouseQueryStreamItem) -> Result<(), String>,
) -> Result<(), String> {
    if !buffer.is_empty() {
        let line = std::str::from_utf8(buffer).map_err(|e| format!("ClickHouse stream contains invalid UTF-8: {e}"))?;
        if let Some(item) = parser.parse_line(line)? {
            on_item(item)?;
        }
        buffer.clear();
    }
    parser.finish()
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
    let url = build_query_url(&client.base_url, database, limit, client.extra_params.as_deref());
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

pub async fn stream_query_with_max_rows(
    client: &ChClient,
    database: &str,
    sql: &str,
    max_rows: Option<usize>,
    cancel_token: Option<CancellationToken>,
    mut on_item: impl FnMut(ClickHouseQueryStreamItem) -> Result<(), String>,
) -> Result<(), String> {
    let max_rows = max_rows.map(|max_rows| max_rows.max(1));
    let limit = max_rows.map(QueryResultLimit::Limited).unwrap_or(QueryResultLimit::Unlimited);
    let url = build_query_url_with_format(
        &client.base_url,
        Some(database),
        limit,
        QueryResultFormat::JsonCompactEachRowWithNamesAndTypes,
        client.extra_params.as_deref(),
    );
    log::info!("[clickhouse] stream query url={url} user={:?} has_pass={}", client.username, client.password.is_some());
    let req = build_request(client, client.http.post(&url).body(sql.to_string()));
    let resp = req.send().await.map_err(|e| format!("ClickHouse request failed: {e}"))?;
    log::info!("[clickhouse] stream response status={}", resp.status());
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        log::error!("[clickhouse] stream error body: {body}");
        return Err(format!("ClickHouse error: {body}"));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = Vec::new();
    let mut parser = ClickHouseStreamParser::default();
    let mut rows_seen = 0usize;
    let mut emit_item = |item: ClickHouseQueryStreamItem| -> Result<(), String> {
        if matches!(item, ClickHouseQueryStreamItem::Row(_)) {
            rows_seen = rows_seen.saturating_add(1);
        }
        on_item(item)?;
        if max_rows.is_some_and(|max_rows| rows_seen >= max_rows) {
            return Err(CLICKHOUSE_STREAM_ROW_LIMIT_REACHED.to_string());
        }
        Ok(())
    };

    loop {
        let chunk = match cancel_token.as_ref() {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => return Err(canceled_error()),
                    chunk = stream.next() => chunk,
                }
            }
            None => stream.next().await,
        };
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk.map_err(|e| format!("ClickHouse stream read failed: {e}"))?;
        buffer.extend_from_slice(&chunk);
        match process_stream_buffer(&mut buffer, &mut parser, &mut emit_item) {
            Err(error) if error == CLICKHOUSE_STREAM_ROW_LIMIT_REACHED => return Ok(()),
            result => result?,
        }
    }

    match process_stream_remainder(&mut buffer, &mut parser, &mut emit_item) {
        Err(error) if error == CLICKHOUSE_STREAM_ROW_LIMIT_REACHED => Ok(()),
        result => result,
    }
}

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(MAX_ROWS).max(1)
}

fn clickhouse_literal(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

fn json_value_as_u64(value: Option<&serde_json::Value>) -> Option<u64> {
    value.and_then(|value| value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok())))
}

fn json_value_as_i64(value: Option<&serde_json::Value>) -> Option<i64> {
    value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
    })
}

fn split_clickhouse_expression_list(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let inner = trimmed.strip_prefix("tuple(").and_then(|rest| rest.strip_suffix(')')).unwrap_or(trimmed);
    let mut items = Vec::new();
    let mut start = 0;
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for (idx, ch) in inner.char_indices() {
        if let Some(q) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == q {
                quote = None;
            }
            continue;
        }

        match ch {
            '\'' | '"' | '`' => quote = Some(ch),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = (depth - 1).max(0),
            ',' if depth == 0 => {
                let item = inner[start..idx].trim();
                if !item.is_empty() {
                    items.push(item.to_string());
                }
                start = idx + ch.len_utf8();
            }
            _ => {}
        }
    }

    let item = inner[start..].trim();
    if !item.is_empty() {
        items.push(item.to_string());
    }
    items
}

fn clickhouse_index_from_skipping_row(row: &[serde_json::Value]) -> IndexInfo {
    let index_type = row.get(2).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let granularity = json_value_as_u64(row.get(3));
    IndexInfo {
        name: row.first().and_then(|v| v.as_str()).unwrap_or("").to_string(),
        columns: split_clickhouse_expression_list(row.get(1).and_then(|v| v.as_str()).unwrap_or("")),
        is_unique: false,
        is_primary: false,
        filter: None,
        index_type: Some(match granularity {
            Some(value) => format!("{index_type} GRANULARITY {value}"),
            None => index_type,
        }),
        included_columns: None,
        comment: None,
    }
}

fn clickhouse_object_statistics_from_row(row: &[serde_json::Value], database: &str) -> Option<ObjectStatistics> {
    let name = row.first().and_then(|value| value.as_str()).unwrap_or("").trim();
    (!name.is_empty()).then(|| ObjectStatistics {
        name: name.to_string(),
        schema: Some(database.to_string()),
        estimated_rows: json_value_as_i64(row.get(1)),
        total_bytes: json_value_as_i64(row.get(2)),
    })
}

fn clickhouse_table_info_from_row(row: &[serde_json::Value]) -> TableInfo {
    let engine = row.get(1).and_then(|v| v.as_str()).unwrap_or("");
    let table_type = if engine.contains("View") { "VIEW" } else { "BASE TABLE" };
    TableInfo {
        name: row.first().and_then(|v| v.as_str()).unwrap_or("").to_string(),
        table_type: table_type.to_string(),
        comment: row.get(2).and_then(|v| v.as_str()).filter(|value| !value.is_empty()).map(str::to_string),
        parent_schema: None,
        parent_name: None,
    }
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
        column_sortables: vec![],
        rows,
        affected_rows: 0,
        execution_time_ms,
        truncated,
        session_id: None,
        has_more: false,
    }
}

pub async fn test_connection(client: &ChClient, timeout: Duration) -> Result<(), String> {
    let mut url = format!("{}/?query=SELECT%201", client.base_url);
    if let Some(params) = normalize_extra_params(client.extra_params.as_deref()) {
        url.push('&');
        url.push_str(&params);
    }
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
    let database_lit = clickhouse_literal(database);
    let sql_with_comment =
        format!("SELECT name, engine, comment FROM system.tables WHERE database = '{database_lit}' ORDER BY name");
    let result = match ch_query(client, &sql_with_comment, Some(database)).await {
        Ok(result) => result,
        Err(error) => {
            log::debug!("Falling back to ClickHouse table list without comments: {error}");
            let sql = format!("SELECT name, engine FROM system.tables WHERE database = '{database_lit}' ORDER BY name");
            ch_query(client, &sql, Some(database)).await?
        }
    };
    Ok(result.data.iter().map(|row| clickhouse_table_info_from_row(row)).collect())
}

pub async fn list_object_statistics(client: &ChClient, database: &str) -> Result<Vec<ObjectStatistics>, String> {
    let database_lit = clickhouse_literal(database);
    let sql = format!(
        "SELECT name, total_rows, total_bytes \
         FROM system.tables \
         WHERE database = '{database_lit}' \
         ORDER BY name"
    );
    let result = ch_query(client, &sql, Some(database)).await?;
    Ok(result.data.iter().filter_map(|row| clickhouse_object_statistics_from_row(row, database)).collect())
}

pub async fn get_columns(client: &ChClient, database: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let sql = format!(
        "SELECT name, type, default_kind, default_expression, is_in_primary_key, is_in_partition_key, comment \
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
            let is_partition_key = row.get(5).and_then(|v| v.as_u64()).unwrap_or(0) == 1;
            let default_kind = row.get(2).and_then(|v| v.as_str()).unwrap_or("");
            let default_expr = row.get(3).and_then(|v| v.as_str()).unwrap_or("");
            let column_default = if default_kind.is_empty() { None } else { Some(default_expr.to_string()) };
            ColumnInfo {
                name: row[0].as_str().unwrap_or("").to_string(),
                data_type,
                is_nullable,
                column_default,
                is_primary_key: is_pk,
                extra: is_partition_key.then(|| "partition_key".to_string()),
                comment: row.get(6).and_then(|v| v.as_str()).filter(|value| !value.is_empty()).map(str::to_string),
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
                enum_values: None,
                ..Default::default()
            }
        })
        .collect())
}

pub async fn list_indexes(client: &ChClient, database: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let database_lit = clickhouse_literal(database);
    let table_lit = clickhouse_literal(table);
    let primary_sql = format!(
        "SELECT primary_key FROM system.tables WHERE database = '{database_lit}' AND name = '{table_lit}' LIMIT 1"
    );
    let skipping_sql = format!(
        "SELECT name, expr, type, granularity \
         FROM system.data_skipping_indices \
         WHERE database = '{database_lit}' AND table = '{table_lit}' \
         ORDER BY name"
    );

    let mut indexes = Vec::new();
    let primary_result = ch_query(client, &primary_sql, Some(database)).await?;
    if let Some(primary_key) = primary_result
        .data
        .first()
        .and_then(|row| row.first())
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
    {
        indexes.push(IndexInfo {
            name: "PRIMARY".to_string(),
            columns: split_clickhouse_expression_list(primary_key),
            is_unique: false,
            is_primary: true,
            filter: None,
            index_type: Some("primary".to_string()),
            included_columns: None,
            comment: None,
        });
    }

    let skipping_result = ch_query(client, &skipping_sql, Some(database)).await?;
    indexes.extend(skipping_result.data.iter().map(|row| clickhouse_index_from_skipping_row(row)));
    Ok(indexes)
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
        let url = build_query_url(
            &client.base_url,
            Some(database),
            QueryResultLimit::Unlimited,
            client.extra_params.as_deref(),
        );
        let req = build_request(client, client.http.post(&url).body(sql.to_string()));
        let resp = req.send().await.map_err(|e| format!("ClickHouse request failed: {e}"))?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("ClickHouse error: {body}"));
        }
        Ok(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
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
            None,
        );

        assert_eq!(
            url,
            "http://localhost:8123/?default_format=JSONCompact&database=analytics&max_result_rows=10001&result_overflow_mode=break"
        );
    }

    #[test]
    fn query_url_appends_custom_url_params() {
        // 用户在「URL 参数」填 dialect_type=ANSI，应追加到 query string 末尾
        let url = build_query_url(
            "http://localhost:8123",
            Some("analytics"),
            QueryResultLimit::Unlimited,
            Some("dialect_type=ANSI"),
        );

        assert_eq!(url, "http://localhost:8123/?default_format=JSONCompact&database=analytics&dialect_type=ANSI");
    }

    #[test]
    fn query_url_normalizes_leading_symbols_and_ignores_blank_params() {
        // 允许用户带上开头的 ? 或 &，也允许多个参数
        let url = build_query_url(
            "http://localhost:8123",
            None,
            QueryResultLimit::Unlimited,
            Some("?dialect_type=ANSI&max_threads=8"),
        );
        assert_eq!(url, "http://localhost:8123/?default_format=JSONCompact&dialect_type=ANSI&max_threads=8");

        // 空白参数不产生多余的 &
        let url = build_query_url("http://localhost:8123", None, QueryResultLimit::Unlimited, Some("   "));
        assert_eq!(url, "http://localhost:8123/?default_format=JSONCompact");
    }

    #[test]
    fn stream_query_url_uses_line_delimited_names_and_types_format() {
        let url = build_query_url_with_format(
            "http://localhost:8123",
            Some("analytics"),
            QueryResultLimit::Limited(500),
            QueryResultFormat::JsonCompactEachRowWithNamesAndTypes,
            None,
        );

        assert_eq!(
            url,
            "http://localhost:8123/?default_format=JSONCompactEachRowWithNamesAndTypes&database=analytics&max_result_rows=500&result_overflow_mode=break"
        );
    }

    #[test]
    fn stream_parser_reads_columns_types_and_rows_across_chunks() {
        let mut buffer = b"[\"id\",\"name\"]\n[\"UInt64\",\"String\"]\n[1,\"Ada\"]\n[2,\"Linus\"".to_vec();
        let mut parser = ClickHouseStreamParser::default();
        let mut items = Vec::new();

        process_stream_buffer(&mut buffer, &mut parser, &mut |item| {
            items.push(item);
            Ok(())
        })
        .unwrap();
        buffer.extend_from_slice(b"]\n");
        process_stream_remainder(&mut buffer, &mut parser, &mut |item| {
            items.push(item);
            Ok(())
        })
        .unwrap();

        assert_eq!(
            items,
            vec![
                ClickHouseQueryStreamItem::Columns {
                    columns: vec!["id".to_string(), "name".to_string()],
                    column_types: vec!["UInt64".to_string(), "String".to_string()],
                },
                ClickHouseQueryStreamItem::Row(vec![serde_json::json!(1), serde_json::json!("Ada")]),
                ClickHouseQueryStreamItem::Row(vec![serde_json::json!(2), serde_json::json!("Linus")]),
            ]
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

    #[test]
    fn splits_clickhouse_expression_lists_without_splitting_function_args() {
        assert_eq!(split_clickhouse_expression_list("user_id, cityHash64(email, status), event_time"), {
            vec!["user_id".to_string(), "cityHash64(email, status)".to_string(), "event_time".to_string()]
        });
        assert_eq!(split_clickhouse_expression_list("tuple(user_id, event_time)"), {
            vec!["user_id".to_string(), "event_time".to_string()]
        });
    }

    #[test]
    fn maps_clickhouse_data_skipping_index_row() {
        let row = vec![
            serde_json::Value::String("idx_email".to_string()),
            serde_json::Value::String("lower(email)".to_string()),
            serde_json::Value::String("bloom_filter".to_string()),
            serde_json::Value::String("4".to_string()),
        ];

        let index = clickhouse_index_from_skipping_row(&row);

        assert_eq!(index.name, "idx_email");
        assert_eq!(index.columns, vec!["lower(email)"]);
        assert_eq!(index.index_type.as_deref(), Some("bloom_filter GRANULARITY 4"));
        assert!(!index.is_primary);
    }

    #[test]
    fn maps_clickhouse_object_statistics_row() {
        let row = vec![
            serde_json::Value::String("events".to_string()),
            serde_json::Value::String("1234".to_string()),
            serde_json::Value::Number(8192.into()),
        ];

        let stat = clickhouse_object_statistics_from_row(&row, "analytics").expect("stat row");

        assert_eq!(stat.name, "events");
        assert_eq!(stat.schema.as_deref(), Some("analytics"));
        assert_eq!(stat.estimated_rows, Some(1234));
        assert_eq!(stat.total_bytes, Some(8192));
    }

    #[test]
    fn skips_clickhouse_object_statistics_rows_without_name() {
        let row = vec![
            serde_json::Value::String(" ".to_string()),
            serde_json::Value::Number(1.into()),
            serde_json::Value::Number(2.into()),
        ];

        assert!(clickhouse_object_statistics_from_row(&row, "analytics").is_none());
    }

    #[test]
    fn maps_clickhouse_table_info_with_comment() {
        let row = vec![
            serde_json::Value::String("events".to_string()),
            serde_json::Value::String("MergeTree".to_string()),
            serde_json::Value::String("event stream".to_string()),
        ];

        let table = clickhouse_table_info_from_row(&row);

        assert_eq!(table.name, "events");
        assert_eq!(table.table_type, "BASE TABLE");
        assert_eq!(table.comment.as_deref(), Some("event stream"));
    }

    #[test]
    fn maps_clickhouse_table_info_without_comment_column() {
        let row =
            vec![serde_json::Value::String("active_users".to_string()), serde_json::Value::String("View".to_string())];

        let table = clickhouse_table_info_from_row(&row);

        assert_eq!(table.name, "active_users");
        assert_eq!(table.table_type, "VIEW");
        assert_eq!(table.comment, None);
    }
}
