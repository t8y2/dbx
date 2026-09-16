use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64_URL},
    Engine as _,
};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::{Client as HttpClient, RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use super::{http_client_builder, with_connection_timeout};
use crate::models::connection::DatabaseConnectionInfo;
use crate::types::{ColumnInfo, DatabaseInfo, TableInfo};

const PATH_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

const HBASE_JSON: &str = "application/json";
const HBASE_KEY_ENCODING_HEADER: &str = "Encoding";
const HBASE_KEY_ENCODING_BASE64: &str = "base64";
const DEFAULT_NAMESPACE: &str = "default";

#[derive(Clone)]
pub struct HBaseClient {
    http: HttpClient,
    base_url: String,
    auth: Option<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HBaseVersionInfo {
    pub version: String,
    pub rest_version: Option<String>,
    pub server: Option<String>,
    pub jvm: Option<String>,
    pub os: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HBaseColumnFamily {
    pub name: String,
    pub properties: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HBaseTableSchema {
    pub name: String,
    pub column_families: Vec<HBaseColumnFamily>,
    pub properties: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HBaseCell {
    pub column: String,
    pub value: String,
    pub value_encoding: String,
    pub value_base64: String,
    pub timestamp: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HBaseRow {
    pub row_key: String,
    pub row_key_encoding: String,
    pub row_key_base64: String,
    pub cells: Vec<HBaseCell>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HBaseScanResult {
    pub rows: Vec<HBaseRow>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HBaseCellInput {
    pub column: String,
    pub value: String,
    #[serde(default)]
    pub value_encoding: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HBasePutRowInput {
    pub row_key: String,
    #[serde(default)]
    pub row_key_encoding: Option<String>,
    pub cells: Vec<HBaseCellInput>,
}

#[derive(Debug, Deserialize)]
struct RestNamespaces {
    #[serde(rename = "Namespace", default)]
    namespaces: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RestTableList {
    #[serde(rename = "table", default)]
    tables: Vec<RestTableName>,
}

#[derive(Debug, Deserialize)]
struct RestTableName {
    name: String,
}

#[derive(Debug, Deserialize)]
struct RestRows {
    #[serde(rename = "Row", default)]
    rows: Vec<RestRow>,
}

#[derive(Debug, Deserialize)]
struct RestRow {
    key: String,
    #[serde(rename = "Cell", default)]
    cells: Vec<RestCell>,
}

#[derive(Debug, Deserialize)]
struct RestCell {
    column: String,
    #[serde(default)]
    timestamp: Option<u64>,
    #[serde(rename = "$", default)]
    value: String,
}

impl HBaseClient {
    pub fn new(
        url: &str,
        username: Option<&str>,
        password: Option<&str>,
        accept_invalid_certs: bool,
        timeout: Duration,
    ) -> Result<Self, String> {
        let base_url = url.trim().trim_end_matches('/').to_string();
        reqwest::Url::parse(&base_url).map_err(|error| format!("Invalid HBase REST URL: {error}"))?;
        let auth = username
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| (value.to_string(), password.unwrap_or_default().to_string()));
        let http = http_client_builder(timeout)
            .danger_accept_invalid_certs(accept_invalid_certs)
            .build()
            .map_err(|error| format!("Failed to create HBase HTTP client: {error}"))?;
        Ok(Self { http, base_url, auth })
    }

    fn request(&self, method: reqwest::Method, path: &str) -> RequestBuilder {
        let request = self.http.request(method, format!("{}{}", self.base_url, path));
        self.with_auth(request)
    }

    fn scanner_request(&self, method: reqwest::Method, location: &str) -> Result<RequestBuilder, String> {
        let path = scanner_resource_path(location)?;
        Ok(self.request(method, &path))
    }

    fn with_auth(&self, request: RequestBuilder) -> RequestBuilder {
        match &self.auth {
            Some((username, password)) => request.basic_auth(username, Some(password)),
            None => request,
        }
    }
}

pub async fn test_connection(client: &HBaseClient, timeout: Duration) -> Result<HBaseVersionInfo, String> {
    with_connection_timeout("HBase", timeout, async { version_info(client).await }).await
}

pub async fn version_info(client: &HBaseClient) -> Result<HBaseVersionInfo, String> {
    let body = send_json(client.request(reqwest::Method::GET, "/version"), "read server version").await?;
    Ok(HBaseVersionInfo {
        version: json_string(&body, "Version").unwrap_or_else(|| "unknown".to_string()),
        rest_version: json_string(&body, "REST"),
        server: json_string(&body, "Server"),
        jvm: json_string(&body, "JVM"),
        os: json_string(&body, "OS"),
    })
}

pub async fn database_connection_info(client: &HBaseClient) -> Result<Option<DatabaseConnectionInfo>, String> {
    let version = version_info(client).await?;
    Ok(Some(DatabaseConnectionInfo {
        product_name: Some("Apache HBase".to_string()),
        product_version: Some(version.version),
        server_comment: version.rest_version.map(|rest| format!("HBase REST {rest}")),
        driver_name: Some("HBase REST API".to_string()),
        ..Default::default()
    }))
}

pub async fn list_namespaces(client: &HBaseClient) -> Result<Vec<DatabaseInfo>, String> {
    let response = client
        .request(reqwest::Method::GET, "/namespaces")
        .header(reqwest::header::ACCEPT, HBASE_JSON)
        .send()
        .await
        .map_err(|error| format_request_error("list namespaces", error))?;
    let body: RestNamespaces = parse_success_json(response, "list namespaces").await?;
    let mut namespaces = body.namespaces;
    namespaces.sort_by_key(|name| name.to_ascii_lowercase());
    Ok(namespaces.into_iter().map(|name| DatabaseInfo { name, ..Default::default() }).collect())
}

pub async fn list_tables(client: &HBaseClient, namespace: &str) -> Result<Vec<TableInfo>, String> {
    let response = client
        .request(reqwest::Method::GET, "/")
        .header(reqwest::header::ACCEPT, HBASE_JSON)
        .send()
        .await
        .map_err(|error| format_request_error("list tables", error))?;
    let body: RestTableList = parse_success_json(response, "list tables").await?;
    let mut names: Vec<String> =
        body.tables.into_iter().filter_map(|table| table_name_in_namespace(&table.name, namespace)).collect();
    names.sort_by_key(|name| name.to_ascii_lowercase());
    Ok(names
        .into_iter()
        .map(|name| TableInfo {
            name,
            table_type: "HBASE_TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        })
        .collect())
}

pub async fn get_table_schema(client: &HBaseClient, namespace: &str, table: &str) -> Result<HBaseTableSchema, String> {
    let qualified = qualified_table_name(namespace, table)?;
    let path = format!("/{}/schema", path_segment(&qualified));
    let body = send_json(client.request(reqwest::Method::GET, &path), "read table schema").await?;
    parse_table_schema(body)
}

pub async fn get_columns(client: &HBaseClient, namespace: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let schema = get_table_schema(client, namespace, table).await?;
    Ok(schema
        .column_families
        .into_iter()
        .map(|family| ColumnInfo {
            name: family.name,
            data_type: "COLUMN_FAMILY".to_string(),
            is_nullable: true,
            extra: family.properties.get("VERSIONS").map(|versions| format!("versions={versions}")),
            comment: family.properties.get("COMPRESSION").map(|compression| format!("compression={compression}")),
            ..Default::default()
        })
        .collect())
}

pub async fn scan_rows(
    client: &HBaseClient,
    namespace: &str,
    table: &str,
    row_key_prefix: Option<&str>,
    limit: usize,
) -> Result<HBaseScanResult, String> {
    let qualified = qualified_table_name(namespace, table)?;
    let limit = limit.clamp(1, 1000);
    let prefix = row_key_prefix.map(str::as_bytes).filter(|value| !value.is_empty());
    let mut scanner = Map::new();
    scanner.insert("batch".to_string(), Value::from((limit.saturating_mul(10)).clamp(10, 1000) as u64));
    scanner.insert("maxVersions".to_string(), Value::from(1));
    if let Some(prefix) = prefix {
        scanner.insert("startRow".to_string(), Value::String(BASE64.encode(prefix)));
        if let Some(end) = prefix_range_end(prefix) {
            scanner.insert("endRow".to_string(), Value::String(BASE64.encode(end)));
        }
    }

    let create_path = format!("/{}/scanner", path_segment(&qualified));
    let response = client
        .request(reqwest::Method::PUT, &create_path)
        .header(reqwest::header::CONTENT_TYPE, HBASE_JSON)
        .json(&Value::Object(scanner))
        .send()
        .await
        .map_err(|error| format_request_error("create scanner", error))?;
    let response = ensure_success(response, "create scanner").await?;
    let scanner_url = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| "HBase REST did not return a scanner location".to_string())?;

    let scan_result = read_scanner(client, &scanner_url, limit).await;
    let close_result = close_scanner(client, &scanner_url).await;
    match (scan_result, close_result) {
        (Ok(result), Ok(())) => Ok(result),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), _) => Err(error),
    }
}

pub async fn get_row(
    client: &HBaseClient,
    namespace: &str,
    table: &str,
    row_key: &str,
    row_key_encoding: Option<&str>,
) -> Result<Option<HBaseRow>, String> {
    let qualified = qualified_table_name(namespace, table)?;
    let row_key_bytes = decode_input(row_key, row_key_encoding, "row key")?;
    if row_key_bytes.is_empty() {
        return Err("HBase row key cannot be empty".to_string());
    }
    let path = encoded_row_path(&qualified, &row_key_bytes);
    let response = client
        .request(reqwest::Method::GET, &path)
        .header(HBASE_KEY_ENCODING_HEADER, HBASE_KEY_ENCODING_BASE64)
        .header(reqwest::header::ACCEPT, HBASE_JSON)
        .send()
        .await
        .map_err(|error| format_request_error("read row", error))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let body: RestRows = parse_success_json(response, "read row").await?;
    let mut rows = decode_rest_rows(body.rows)?;
    Ok(rows.pop())
}

pub async fn put_row(
    client: &HBaseClient,
    namespace: &str,
    table: &str,
    input: &HBasePutRowInput,
) -> Result<(), String> {
    let qualified = qualified_table_name(namespace, table)?;
    let row_key = decode_input(&input.row_key, input.row_key_encoding.as_deref(), "row key")?;
    if row_key.is_empty() {
        return Err("HBase row key cannot be empty".to_string());
    }
    if input.cells.is_empty() {
        return Err("At least one HBase cell is required".to_string());
    }
    let mut cells = Vec::with_capacity(input.cells.len());
    for cell in &input.cells {
        validate_column_name(&cell.column)?;
        let value = decode_input(&cell.value, cell.value_encoding.as_deref(), "cell value")?;
        cells.push(serde_json::json!({
            "column": BASE64.encode(cell.column.as_bytes()),
            "$": BASE64.encode(value),
        }));
    }
    let body = serde_json::json!({
        "Row": [{
            "key": BASE64.encode(&row_key),
            "Cell": cells,
        }]
    });
    let path = encoded_row_path(&qualified, &row_key);
    let response = client
        .request(reqwest::Method::PUT, &path)
        .header(HBASE_KEY_ENCODING_HEADER, HBASE_KEY_ENCODING_BASE64)
        .header(reqwest::header::CONTENT_TYPE, HBASE_JSON)
        .json(&body)
        .send()
        .await
        .map_err(|error| format_request_error("write row", error))?;
    ensure_success(response, "write row").await.map(|_| ())
}

pub async fn delete_row(
    client: &HBaseClient,
    namespace: &str,
    table: &str,
    row_key: &str,
    row_key_encoding: Option<&str>,
) -> Result<(), String> {
    let qualified = qualified_table_name(namespace, table)?;
    let row_key = decode_input(row_key, row_key_encoding, "row key")?;
    if row_key.is_empty() {
        return Err("HBase row key cannot be empty".to_string());
    }
    let path = encoded_row_path(&qualified, &row_key);
    let response = client
        .request(reqwest::Method::DELETE, &path)
        .header(HBASE_KEY_ENCODING_HEADER, HBASE_KEY_ENCODING_BASE64)
        .send()
        .await
        .map_err(|error| format_request_error("delete row", error))?;
    ensure_success(response, "delete row").await.map(|_| ())
}

pub async fn create_table(
    client: &HBaseClient,
    namespace: &str,
    table: &str,
    column_families: &[String],
) -> Result<(), String> {
    let qualified = qualified_table_name(namespace, table)?;
    if column_families.is_empty() {
        return Err("At least one HBase column family is required".to_string());
    }
    let mut families = Vec::with_capacity(column_families.len());
    for family in column_families {
        validate_family_name(family)?;
        families.push(serde_json::json!({ "name": family.trim() }));
    }
    let path = format!("/{}/schema", path_segment(&qualified));
    let response = client
        .request(reqwest::Method::PUT, &path)
        .header(reqwest::header::CONTENT_TYPE, HBASE_JSON)
        .json(&serde_json::json!({ "ColumnSchema": families }))
        .send()
        .await
        .map_err(|error| format_request_error("create table", error))?;
    ensure_success(response, "create table").await.map(|_| ())
}

pub async fn delete_table(client: &HBaseClient, namespace: &str, table: &str) -> Result<(), String> {
    let qualified = qualified_table_name(namespace, table)?;
    let path = format!("/{}/schema", path_segment(&qualified));
    let response = client
        .request(reqwest::Method::DELETE, &path)
        .send()
        .await
        .map_err(|error| format_request_error("delete table", error))?;
    ensure_success(response, "delete table").await.map(|_| ())
}

async fn read_scanner(client: &HBaseClient, scanner_url: &str, limit: usize) -> Result<HBaseScanResult, String> {
    let mut order = Vec::<String>::new();
    let mut rows = HashMap::<String, RestRow>::new();
    let mut exhausted = false;

    while rows.len() <= limit {
        let response = client
            .scanner_request(reqwest::Method::GET, scanner_url)?
            .header(reqwest::header::ACCEPT, HBASE_JSON)
            .send()
            .await
            .map_err(|error| format_request_error("read scanner", error))?;
        if response.status() == StatusCode::NO_CONTENT {
            exhausted = true;
            break;
        }
        let body: RestRows = parse_success_json(response, "read scanner").await?;
        if body.rows.is_empty() {
            exhausted = true;
            break;
        }
        for row in body.rows {
            let key = row.key.clone();
            if let Some(existing) = rows.get_mut(&key) {
                existing.cells.extend(row.cells);
            } else {
                order.push(key.clone());
                rows.insert(key, row);
            }
        }
        if rows.len() > limit {
            break;
        }
    }

    let truncated = !exhausted && rows.len() >= limit;
    let mut ordered_rows = Vec::with_capacity(order.len().min(limit));
    for key in order.into_iter().take(limit) {
        if let Some(row) = rows.remove(&key) {
            ordered_rows.push(row);
        }
    }
    Ok(HBaseScanResult { rows: decode_rest_rows(ordered_rows)?, truncated })
}

async fn close_scanner(client: &HBaseClient, scanner_url: &str) -> Result<(), String> {
    let response = client
        .scanner_request(reqwest::Method::DELETE, scanner_url)?
        .send()
        .await
        .map_err(|error| format_request_error("close scanner", error))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(());
    }
    ensure_success(response, "close scanner").await.map(|_| ())
}

fn decode_rest_rows(rows: Vec<RestRow>) -> Result<Vec<HBaseRow>, String> {
    rows.into_iter()
        .map(|row| {
            let row_key_bytes =
                BASE64.decode(&row.key).map_err(|error| format!("Invalid HBase row key Base64: {error}"))?;
            let (row_key, row_key_encoding) = display_bytes(&row_key_bytes);
            let mut cells = row
                .cells
                .into_iter()
                .map(|cell| {
                    let column_bytes =
                        BASE64.decode(&cell.column).map_err(|error| format!("Invalid HBase column Base64: {error}"))?;
                    let column = String::from_utf8(column_bytes)
                        .map_err(|_| "HBase returned a non-UTF-8 column identifier".to_string())?;
                    let value_bytes =
                        BASE64.decode(&cell.value).map_err(|error| format!("Invalid HBase cell Base64: {error}"))?;
                    let value_base64 = BASE64.encode(&value_bytes);
                    let (value, value_encoding) = display_bytes(&value_bytes);
                    Ok(HBaseCell { column, value, value_encoding, value_base64, timestamp: cell.timestamp })
                })
                .collect::<Result<Vec<_>, String>>()?;
            cells.sort_by(|left, right| left.column.cmp(&right.column));
            Ok(HBaseRow { row_key, row_key_encoding, row_key_base64: BASE64.encode(row_key_bytes), cells })
        })
        .collect()
}

fn parse_table_schema(body: Value) -> Result<HBaseTableSchema, String> {
    let object = body.as_object().ok_or_else(|| "Invalid HBase table schema response".to_string())?;
    let name = object.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut column_families = Vec::new();
    for raw_family in object.get("ColumnSchema").and_then(Value::as_array).into_iter().flatten() {
        let family = raw_family.as_object().ok_or_else(|| "Invalid HBase column family response".to_string())?;
        let family_name = family.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        if family_name.is_empty() {
            continue;
        }
        column_families.push(HBaseColumnFamily { name: family_name, properties: string_properties(family, &["name"]) });
    }
    column_families.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(HBaseTableSchema { name, column_families, properties: string_properties(object, &["name", "ColumnSchema"]) })
}

fn string_properties(object: &Map<String, Value>, excluded: &[&str]) -> BTreeMap<String, String> {
    object
        .iter()
        .filter(|(key, _)| !excluded.contains(&key.as_str()))
        .filter_map(|(key, value)| match value {
            Value::String(value) => Some((key.clone(), value.clone())),
            Value::Bool(value) => Some((key.clone(), value.to_string())),
            Value::Number(value) => Some((key.clone(), value.to_string())),
            _ => None,
        })
        .collect()
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

async fn send_json(request: RequestBuilder, action: &str) -> Result<Value, String> {
    let response = request
        .header(reqwest::header::ACCEPT, HBASE_JSON)
        .send()
        .await
        .map_err(|error| format_request_error(action, error))?;
    parse_success_json(response, action).await
}

async fn parse_success_json<T: serde::de::DeserializeOwned>(response: Response, action: &str) -> Result<T, String> {
    let response = ensure_success(response, action).await?;
    response.json::<T>().await.map_err(|error| format!("HBase failed to parse {action} response: {error}"))
}

async fn ensure_success(response: Response, action: &str) -> Result<Response, String> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    let detail = body.trim();
    if detail.is_empty() {
        Err(format!("HBase {action} failed ({status})"))
    } else {
        Err(format!("HBase {action} failed ({status}): {detail}"))
    }
}

fn format_request_error(action: &str, error: reqwest::Error) -> String {
    format!("HBase {action} request failed: {error}")
}

fn qualified_table_name(namespace: &str, table: &str) -> Result<String, String> {
    let namespace = namespace.trim();
    let table = table.trim();
    if table.is_empty() {
        return Err("HBase table name cannot be empty".to_string());
    }
    if table.contains(':') {
        return Ok(table.to_string());
    }
    if namespace.is_empty() || namespace == DEFAULT_NAMESPACE {
        Ok(table.to_string())
    } else {
        Ok(format!("{namespace}:{table}"))
    }
}

fn table_name_in_namespace(qualified: &str, namespace: &str) -> Option<String> {
    let namespace = namespace.trim();
    match qualified.split_once(':') {
        Some((table_namespace, table)) if table_namespace == namespace => Some(table.to_string()),
        Some(_) => None,
        None if namespace.is_empty() || namespace == DEFAULT_NAMESPACE => Some(qualified.to_string()),
        None => None,
    }
}

fn validate_family_name(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("HBase column family name cannot be empty".to_string());
    }
    if value.contains(':') {
        return Err(format!("HBase column family name cannot contain ':': {value}"));
    }
    Ok(())
}

fn validate_column_name(value: &str) -> Result<(), String> {
    let Some((family, qualifier)) = value.split_once(':') else {
        return Err(format!("HBase column must use family:qualifier syntax: {value}"));
    };
    validate_family_name(family)?;
    if qualifier.is_empty() {
        return Err(format!("HBase column qualifier cannot be empty: {value}"));
    }
    Ok(())
}

fn decode_input(value: &str, encoding: Option<&str>, label: &str) -> Result<Vec<u8>, String> {
    let encoding = encoding.unwrap_or("utf8").trim();
    if encoding.eq_ignore_ascii_case("base64") {
        BASE64.decode(value.trim()).map_err(|error| format!("Invalid Base64 {label}: {error}"))
    } else if encoding.eq_ignore_ascii_case("utf8") || encoding.is_empty() {
        Ok(value.as_bytes().to_vec())
    } else {
        Err(format!("Unsupported HBase {label} encoding: {encoding}"))
    }
}

fn display_bytes(bytes: &[u8]) -> (String, String) {
    match std::str::from_utf8(bytes) {
        Ok(text) if text.chars().all(|ch| !ch.is_control() || matches!(ch, '\n' | '\r' | '\t')) => {
            (text.to_string(), "utf8".to_string())
        }
        _ => (format!("base64:{}", BASE64.encode(bytes)), "base64".to_string()),
    }
}

fn prefix_range_end(prefix: &[u8]) -> Option<Vec<u8>> {
    let mut end = prefix.to_vec();
    for index in (0..end.len()).rev() {
        if end[index] != u8::MAX {
            end[index] += 1;
            end.truncate(index + 1);
            return Some(end);
        }
    }
    None
}

fn path_segment(value: &str) -> String {
    utf8_percent_encode(value, PATH_SEGMENT_ENCODE_SET).to_string()
}

fn encoded_row_path(qualified_table: &str, row_key: &[u8]) -> String {
    format!("/{}/{}", path_segment(qualified_table), BASE64_URL.encode(row_key))
}

fn scanner_resource_path(location: &str) -> Result<String, String> {
    let location = location.trim();
    if location.is_empty() {
        return Err("HBase REST returned an empty scanner location".to_string());
    }
    if let Ok(url) = reqwest::Url::parse(location) {
        let mut path = url.path().to_string();
        if let Some(query) = url.query() {
            path.push('?');
            path.push_str(query);
        }
        return Ok(path);
    }
    Ok(if location.starts_with('/') { location.to_string() } else { format!("/{location}") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn namespace_table_names_are_filtered_and_unqualified() {
        assert_eq!(table_name_in_namespace("orders", "default"), Some("orders".to_string()));
        assert_eq!(table_name_in_namespace("sales:orders", "sales"), Some("orders".to_string()));
        assert_eq!(table_name_in_namespace("sales:orders", "default"), None);
        assert_eq!(qualified_table_name("sales", "orders").unwrap(), "sales:orders");
        assert_eq!(qualified_table_name("default", "orders").unwrap(), "orders");
    }

    #[test]
    fn prefix_range_end_handles_carry_and_unbounded_prefix() {
        assert_eq!(prefix_range_end(b"customer#00"), Some(b"customer#01".to_vec()));
        assert_eq!(prefix_range_end(&[0x01, 0xff]), Some(vec![0x02]));
        assert_eq!(prefix_range_end(&[0xff, 0xff]), None);
    }

    #[test]
    fn binary_values_keep_base64_representation() {
        assert_eq!(display_bytes(b"hello"), ("hello".to_string(), "utf8".to_string()));
        assert_eq!(display_bytes(&[0, 1, 2]), ("base64:AAEC".to_string(), "base64".to_string()));
    }

    #[test]
    fn row_paths_use_url_safe_base64_for_arbitrary_keys() {
        assert_eq!(encoded_row_path("demo", b"customer#001"), "/demo/Y3VzdG9tZXIjMDAx");
        assert_eq!(encoded_row_path("demo", &[0, 1, 2, 0xfb, 0xff]), "/demo/AAEC-_8");
    }

    #[test]
    fn table_schema_properties_are_preserved() {
        let schema = parse_table_schema(serde_json::json!({
            "name": "demo",
            "ColumnSchema": [{"name": "cf", "VERSIONS": "3", "COMPRESSION": "SNAPPY"}],
            "IS_META": "false"
        }))
        .unwrap();
        assert_eq!(schema.name, "demo");
        assert_eq!(schema.column_families[0].name, "cf");
        assert_eq!(schema.column_families[0].properties.get("VERSIONS").map(String::as_str), Some("3"));
        assert_eq!(schema.properties.get("IS_META").map(String::as_str), Some("false"));
    }

    #[test]
    fn scanner_location_reuses_the_configured_gateway_origin() {
        assert_eq!(
            scanner_resource_path("http://hbase.internal:8080/dbx/scanner/123?token=abc").unwrap(),
            "/dbx/scanner/123?token=abc"
        );
        assert_eq!(scanner_resource_path("/dbx/scanner/123").unwrap(), "/dbx/scanner/123");
        assert_eq!(scanner_resource_path("dbx/scanner/123").unwrap(), "/dbx/scanner/123");
    }

    #[tokio::test]
    #[ignore = "requires DBX_TEST_HBASE_URL and a writable HBase REST gateway"]
    async fn live_hbase_rest_crud_and_scan() {
        let url = std::env::var("DBX_TEST_HBASE_URL").expect("DBX_TEST_HBASE_URL is required");
        let username = std::env::var("DBX_TEST_HBASE_USERNAME").ok();
        let password = std::env::var("DBX_TEST_HBASE_PASSWORD").ok();
        let client = HBaseClient::new(&url, username.as_deref(), password.as_deref(), false, Duration::from_secs(5))
            .expect("create HBase client");
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let table = format!("dbx_hbase_live_{suffix}");
        let namespace = "default";

        let version = test_connection(&client, Duration::from_secs(5)).await.expect("test connection");
        assert!(!version.version.is_empty());
        let namespaces = list_namespaces(&client).await.expect("list namespaces");
        assert!(namespaces.iter().any(|item| item.name == namespace));

        create_table(&client, namespace, &table, &["profile".to_string(), "metrics".to_string()])
            .await
            .expect("create table");
        let test_result: Result<(), String> = async {
            let tables = list_tables(&client, namespace).await?;
            if !tables.iter().any(|item| item.name == table) {
                return Err("created table is missing from the table list".to_string());
            }
            let schema = get_table_schema(&client, namespace, &table).await?;
            if schema.column_families.iter().map(|family| family.name.as_str()).collect::<Vec<_>>()
                != vec!["metrics", "profile"]
            {
                return Err(format!("unexpected column families: {:?}", schema.column_families));
            }

            for (key, name, score) in
                [("customer#001", "Alice", "10"), ("customer#002", "Bob", "20"), ("customer#003", "Carol", "30")]
            {
                put_row(
                    &client,
                    namespace,
                    &table,
                    &HBasePutRowInput {
                        row_key: key.to_string(),
                        row_key_encoding: Some("utf8".to_string()),
                        cells: vec![
                            HBaseCellInput {
                                column: "profile:name".to_string(),
                                value: name.to_string(),
                                value_encoding: Some("utf8".to_string()),
                            },
                            HBaseCellInput {
                                column: "metrics:score".to_string(),
                                value: score.to_string(),
                                value_encoding: Some("utf8".to_string()),
                            },
                        ],
                    },
                )
                .await?;
            }

            let limited = scan_rows(&client, namespace, &table, Some("customer#00"), 2).await?;
            if limited.rows.len() != 2 || !limited.truncated {
                return Err(format!("unexpected limited scan result: {limited:?}"));
            }
            let all = scan_rows(&client, namespace, &table, Some("customer#00"), 10).await?;
            if all.rows.iter().map(|row| row.row_key.as_str()).collect::<Vec<_>>()
                != vec!["customer#001", "customer#002", "customer#003"]
                || all.truncated
            {
                return Err(format!("unexpected full scan result: {all:?}"));
            }

            let row = get_row(&client, namespace, &table, "customer#002", Some("utf8"))
                .await?
                .ok_or_else(|| "customer#002 is missing".to_string())?;
            if !row.cells.iter().any(|cell| cell.column == "profile:name" && cell.value == "Bob") {
                return Err(format!("unexpected customer#002 row: {row:?}"));
            }
            put_row(
                &client,
                namespace,
                &table,
                &HBasePutRowInput {
                    row_key: "customer#002".to_string(),
                    row_key_encoding: Some("utf8".to_string()),
                    cells: vec![HBaseCellInput {
                        column: "metrics:score".to_string(),
                        value: "25".to_string(),
                        value_encoding: Some("utf8".to_string()),
                    }],
                },
            )
            .await?;
            let updated = get_row(&client, namespace, &table, "customer#002", Some("utf8"))
                .await?
                .ok_or_else(|| "updated customer#002 is missing".to_string())?;
            if !updated.cells.iter().any(|cell| cell.column == "metrics:score" && cell.value == "25") {
                return Err(format!("updated cell is missing: {updated:?}"));
            }

            put_row(
                &client,
                namespace,
                &table,
                &HBasePutRowInput {
                    row_key: "AAEC".to_string(),
                    row_key_encoding: Some("base64".to_string()),
                    cells: vec![HBaseCellInput {
                        column: "profile:binary".to_string(),
                        value: "/wA=".to_string(),
                        value_encoding: Some("base64".to_string()),
                    }],
                },
            )
            .await?;
            let binary = get_row(&client, namespace, &table, "AAEC", Some("base64"))
                .await?
                .ok_or_else(|| "binary row is missing".to_string())?;
            if binary.row_key != "base64:AAEC"
                || !binary.cells.iter().any(|cell| {
                    cell.column == "profile:binary" && cell.value == "base64:/wA=" && cell.value_base64 == "/wA="
                })
            {
                return Err(format!("unexpected binary row: {binary:?}"));
            }

            delete_row(&client, namespace, &table, "customer#003", Some("utf8")).await?;
            if get_row(&client, namespace, &table, "customer#003", Some("utf8")).await?.is_some() {
                return Err("customer#003 still exists after deletion".to_string());
            }
            Ok(())
        }
        .await;

        let cleanup_result = delete_table(&client, namespace, &table).await;
        if let Err(error) = test_result {
            panic!("live HBase test failed: {error:?}; cleanup result: {cleanup_result:?}");
        }
        cleanup_result.expect("delete temporary table");
        let tables = list_tables(&client, namespace).await.expect("list tables after cleanup");
        assert!(!tables.iter().any(|item| item.name == table));
    }
}
