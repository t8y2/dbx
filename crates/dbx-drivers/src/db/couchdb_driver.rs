use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::Method;
use serde_json::Value;

use super::document_result::DocumentQueryResult;
use super::{apply_tls_certificates, http_client_builder, with_connection_timeout};
use crate::db::ColumnInfo;
use crate::models::connection::DatabaseConnectionInfo;
use crate::types::QueryResult;

const COUCHDB_PATH_ENCODE_SET: &AsciiSet =
    &CONTROLS.add(b' ').add(b'"').add(b'#').add(b'<').add(b'>').add(b'`').add(b'?').add(b'{').add(b'}').add(b'/');

fn encode_path_segment(value: &str) -> String {
    utf8_percent_encode(value, COUCHDB_PATH_ENCODE_SET).to_string()
}

#[derive(Clone)]
pub struct CouchDbClient {
    http: reqwest::Client,
    base_url: String,
    auth: Option<(String, String)>,
}

impl CouchDbClient {
    #[allow(clippy::too_many_arguments)]
    pub fn from_config(
        url: &str,
        username: Option<&str>,
        password: Option<&str>,
        tls_enabled: bool,
        url_params: Option<&str>,
        _external_config: Option<&Value>,
        timeout: Duration,
        ca_cert_path: Option<&str>,
        client_cert_path: Option<&str>,
        client_key_path: Option<&str>,
    ) -> Result<Self, String> {
        let base_url = normalize_couchdb_base_url(url, tls_enabled);
        let auth = match (username, password) {
            (Some(u), Some(p)) if !u.is_empty() => Some((u.to_string(), p.to_string())),
            _ => None,
        };
        let mut builder = http_client_builder(timeout)
            .danger_accept_invalid_certs(couchdb_accept_invalid_certs(tls_enabled, url_params));
        builder = apply_tls_certificates(builder, ca_cert_path, client_cert_path, client_key_path)?;
        let http = builder.build().map_err(|e| format!("Failed to initialize CouchDB HTTP client: {e}"))?;
        Ok(Self { http, base_url, auth })
    }

    pub fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        let path = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };
        let req = self.http.request(method, format!("{}{}", self.base_url, path));
        if let Some((ref user, ref pass)) = self.auth {
            req.basic_auth(user, Some(pass))
        } else {
            req
        }
    }

    pub fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(Method::GET, path)
    }

    pub fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(Method::POST, path)
    }

    pub fn put(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(Method::PUT, path)
    }

    pub fn delete(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(Method::DELETE, path)
    }

    pub fn head(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(Method::HEAD, path)
    }
}

pub fn normalize_couchdb_base_url(url: &str, tls_enabled: bool) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else if let Some(stripped) = trimmed.strip_prefix("couchdb://") {
        let scheme = if tls_enabled { "https" } else { "http" };
        format!("{scheme}://{stripped}")
    } else {
        let scheme = if tls_enabled { "https" } else { "http" };
        format!("{scheme}://{trimmed}")
    }
}

pub fn couchdb_accept_invalid_certs(tls_enabled: bool, url_params: Option<&str>) -> bool {
    tls_enabled
        || couchdb_url_params_flag(url_params, "sslmode", &["disable", "allow"])
        || couchdb_url_params_flag(url_params, "tlsverify", &["false", "0", "no", "off"])
        || couchdb_url_params_flag(url_params, "verify", &["false", "0", "no", "off"])
        || couchdb_url_params_flag(url_params, "insecure", &["true", "1", "yes", "on"])
        || couchdb_url_params_flag(url_params, "accept_invalid_certs", &["true", "1", "yes", "on"])
}

fn couchdb_url_params_flag(params: Option<&str>, key: &str, expected_values: &[&str]) -> bool {
    params.unwrap_or("").trim().trim_start_matches('?').split('&').filter_map(|p| p.split_once('=')).any(|(k, v)| {
        k.eq_ignore_ascii_case(key) && expected_values.iter().any(|expected| v.eq_ignore_ascii_case(expected))
    })
}

pub async fn test_connection(client: &CouchDbClient, timeout: Duration) -> Result<(), String> {
    with_connection_timeout("CouchDB", timeout, async {
        let resp = client.get("/").send().await.map_err(|e| format!("CouchDB connection failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("CouchDB HTTP {status}: {body}"));
        }
        Ok(())
    })
    .await
}

pub async fn database_connection_info(client: &CouchDbClient) -> Result<DatabaseConnectionInfo, String> {
    let resp = client.get("/").send().await.map_err(|e| format!("CouchDB request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("CouchDB HTTP {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("CouchDB parse error: {e}"))?;
    let version = body.get("version").and_then(Value::as_str).unwrap_or("unknown").to_string();
    Ok(DatabaseConnectionInfo {
        product_name: Some("Apache CouchDB".to_string()),
        product_version: Some(version),
        ..Default::default()
    })
}

pub async fn list_databases(client: &CouchDbClient) -> Result<Vec<String>, String> {
    let resp = client.get("/_all_dbs").send().await.map_err(|e| format!("CouchDB request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("CouchDB error {status}: {body}"));
    }
    let dbs: Vec<String> = resp.json().await.map_err(|e| format!("Invalid CouchDB JSON: {e}"))?;
    Ok(dbs)
}

pub async fn get_columns(client: &CouchDbClient, database: &str) -> Result<Vec<ColumnInfo>, String> {
    let encoded_db = encode_path_segment(database);
    let path = format!("/{encoded_db}/_all_docs?include_docs=true&limit=50");
    let mut columns = vec![
        ColumnInfo {
            name: "_id".to_string(),
            data_type: "string".to_string(),
            is_primary_key: true,
            is_nullable: false,
            ..Default::default()
        },
        ColumnInfo {
            name: "_rev".to_string(),
            data_type: "string".to_string(),
            is_primary_key: false,
            is_nullable: false,
            ..Default::default()
        },
    ];

    let resp = match client.get(&path).send().await {
        Ok(r) => r,
        Err(_) => return Ok(columns),
    };

    if resp.status().is_success() {
        if let Ok(body) = resp.json::<Value>().await {
            if let Some(rows) = body.get("rows").and_then(Value::as_array) {
                let mut seen: HashSet<String> = ["_id".to_string(), "_rev".to_string()].into_iter().collect();
                for row in rows {
                    if let Some(doc) = row.get("doc").and_then(Value::as_object) {
                        for (k, v) in doc {
                            if seen.insert(k.clone()) {
                                let type_str = match v {
                                    Value::Null => "null",
                                    Value::Bool(_) => "boolean",
                                    Value::Number(_) => "number",
                                    Value::String(_) => "string",
                                    Value::Array(_) => "array",
                                    Value::Object(_) => "object",
                                };
                                columns.push(ColumnInfo {
                                    name: k.clone(),
                                    data_type: type_str.to_string(),
                                    is_primary_key: false,
                                    is_nullable: true,
                                    ..Default::default()
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(columns)
}

fn parse_couchdb_sort(sort: Option<&str>) -> Result<Option<Value>, String> {
    let sort = match sort {
        Some(s) if !s.trim().is_empty() => s.trim(),
        _ => return Ok(None),
    };
    let parsed = serde_json::from_str::<Value>(sort).map_err(|e| format!("Invalid sort JSON: {e}"))?;
    match parsed {
        Value::Array(val) => Ok(Some(Value::Array(val))),
        Value::Object(map) => {
            let mut list = Vec::new();
            for (k, v) in map {
                let dir = match v {
                    Value::Number(n) if n.as_i64() == Some(-1) => "desc",
                    Value::String(ref s) if s.eq_ignore_ascii_case("desc") => "desc",
                    _ => "asc",
                };
                list.push(serde_json::json!({ k: dir }));
            }
            if !list.is_empty() {
                Ok(Some(Value::Array(list)))
            } else {
                Ok(None)
            }
        }
        _ => Err(format!("CouchDB sort must be a JSON array or object, got: {sort}")),
    }
}

fn parse_couchdb_selector(filter: Option<&str>) -> Result<Value, String> {
    let filter = match filter {
        Some(f) if !f.trim().is_empty() => f.trim(),
        _ => return Ok(serde_json::json!({ "_id": { "$gt": null } })),
    };

    let parsed = serde_json::from_str::<Value>(filter).map_err(|e| format!("Invalid filter JSON: {e}"))?;
    match parsed {
        Value::Object(ref map) => {
            if let Some(selector) = map.get("selector") {
                Ok(selector.clone())
            } else {
                Ok(parsed)
            }
        }
        _ => Err(format!("CouchDB selector must be a JSON object, got: {filter}")),
    }
}

async fn find_documents_impl(
    client: &CouchDbClient,
    database: &str,
    skip: Option<u64>,
    limit: i64,
    filter: Option<&str>,
    sort: Option<&str>,
    cursor: Option<&str>,
) -> Result<DocumentQueryResult, String> {
    let encoded_db = encode_path_segment(database);
    let has_filter = filter.is_some_and(|f| !f.trim().is_empty());
    let parsed_sort = parse_couchdb_sort(sort)?;

    if !has_filter && parsed_sort.is_none() && cursor.is_none() {
        // Fast path: use _all_docs
        let skip_val = skip.unwrap_or(0);
        let path = format!("/{encoded_db}/_all_docs?include_docs=true&limit={limit}&skip={skip_val}");
        let resp = client.get(&path).send().await.map_err(|e| format!("CouchDB request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("CouchDB query error {status}: {body}"));
        }
        let body: Value = resp.json().await.map_err(|e| format!("Invalid CouchDB JSON: {e}"))?;
        let total = body.get("total_rows").and_then(Value::as_u64).unwrap_or(0);
        let docs = body
            .get("rows")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().filter_map(|r| r.get("doc").cloned()).collect::<Vec<_>>())
            .unwrap_or_default();
        let raw_documents = docs
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("CouchDB document serialization failed: {e}"))?;
        return Ok(DocumentQueryResult {
            documents: docs,
            raw_documents: Some(raw_documents),
            extended_documents: None,
            total,
            total_is_exact: true,
            next_cursor: None,
        });
    }

    // Mango query: POST /{db}/_find
    let selector = parse_couchdb_selector(filter)?;
    let mut payload = serde_json::json!({
        "selector": selector,
        "limit": limit
    });
    if let Some(s) = skip {
        if cursor.is_none() && s > 0 {
            payload["skip"] = Value::Number(s.into());
        }
    }
    if let Some(c) = cursor {
        payload["bookmark"] = Value::String(c.to_string());
    }
    if let Some(s) = parsed_sort {
        payload["sort"] = s;
    }

    let resp = client
        .post(&format!("/{encoded_db}/_find"))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("CouchDB _find request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("CouchDB _find error {status}: {body}"));
    }

    let body: Value = resp.json().await.map_err(|e| format!("Invalid CouchDB _find JSON: {e}"))?;
    let docs = body.get("docs").and_then(Value::as_array).cloned().unwrap_or_default();
    let next_cursor = if docs.len() == limit as usize {
        body.get("bookmark").and_then(Value::as_str).map(str::to_string)
    } else {
        None
    };

    let total = count_documents(client, database, None).await.unwrap_or(docs.len() as u64);
    let raw_documents = docs
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("CouchDB document serialization failed: {e}"))?;
    Ok(DocumentQueryResult {
        documents: docs,
        raw_documents: Some(raw_documents),
        extended_documents: None,
        total,
        // count_documents 忽略 selector，返回全库 doc_count；带过滤时不是精确总数。
        total_is_exact: !has_filter,
        next_cursor,
    })
}

pub async fn find_documents(
    client: &CouchDbClient,
    database: &str,
    skip: u64,
    limit: i64,
    filter: Option<&str>,
    sort: Option<&str>,
) -> Result<DocumentQueryResult, String> {
    find_documents_impl(client, database, Some(skip), limit, filter, sort, None).await
}

pub async fn find_documents_with_cursor(
    client: &CouchDbClient,
    database: &str,
    limit: i64,
    filter: Option<&str>,
    sort: Option<&str>,
    cursor: Option<&str>,
) -> Result<DocumentQueryResult, String> {
    find_documents_impl(client, database, None, limit, filter, sort, cursor).await
}

pub async fn close_cursor(_client: &CouchDbClient, _cursor: &str) -> Result<(), String> {
    Ok(())
}

pub async fn count_documents(client: &CouchDbClient, database: &str, _filter: Option<&str>) -> Result<u64, String> {
    let encoded_db = encode_path_segment(database);
    let resp =
        client.get(&format!("/{encoded_db}")).send().await.map_err(|e| format!("CouchDB request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("CouchDB error {status}: {body}"));
    }
    let body: Value = resp.json().await.map_err(|e| format!("Invalid CouchDB JSON: {e}"))?;
    let doc_count = body.get("doc_count").and_then(Value::as_u64).unwrap_or(0);
    Ok(doc_count)
}

pub async fn insert_document(client: &CouchDbClient, database: &str, doc_json: &str) -> Result<String, String> {
    let encoded_db = encode_path_segment(database);
    let doc: Value = serde_json::from_str(doc_json).map_err(|e| format!("Invalid JSON: {e}"))?;
    let id_opt = doc.get("_id").and_then(Value::as_str).map(str::to_string);

    let resp = if let Some(ref id) = id_opt {
        let encoded_id = encode_path_segment(id);
        client.put(&format!("/{encoded_db}/{encoded_id}")).json(&doc).send().await
    } else {
        client.post(&format!("/{encoded_db}")).json(&doc).send().await
    }
    .map_err(|e| format!("CouchDB request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("CouchDB insert error {status}: {body}"));
    }
    let body: Value = resp.json().await.map_err(|e| format!("Invalid CouchDB response: {e}"))?;
    let id = body.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    Ok(id)
}

async fn fetch_doc_rev(client: &CouchDbClient, database: &str, id: &str) -> Result<Option<String>, String> {
    let encoded_db = encode_path_segment(database);
    let encoded_id = encode_path_segment(id);
    let resp = client
        .head(&format!("/{encoded_db}/{encoded_id}"))
        .send()
        .await
        .map_err(|e| format!("CouchDB request failed: {e}"))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    if let Some(etag) = resp.headers().get(reqwest::header::ETAG).and_then(|h| h.to_str().ok()) {
        let rev = etag.trim().trim_matches('"');
        return Ok(Some(rev.to_string()));
    }
    Ok(None)
}

pub async fn update_document(client: &CouchDbClient, database: &str, id: &str, doc_json: &str) -> Result<u64, String> {
    let encoded_db = encode_path_segment(database);
    let encoded_id = encode_path_segment(id);
    let mut doc: Value = serde_json::from_str(doc_json).map_err(|e| format!("Invalid JSON: {e}"))?;
    if let Value::Object(ref mut map) = doc {
        if !map.contains_key("_rev") {
            if let Some(rev) = fetch_doc_rev(client, database, id).await? {
                map.insert("_rev".to_string(), Value::String(rev));
            }
        }
        if !map.contains_key("_id") {
            map.insert("_id".to_string(), Value::String(id.to_string()));
        }
    }
    let resp = client
        .put(&format!("/{encoded_db}/{encoded_id}"))
        .json(&doc)
        .send()
        .await
        .map_err(|e| format!("CouchDB request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("CouchDB update error {status}: {body}"));
    }
    Ok(1)
}

pub async fn delete_document(client: &CouchDbClient, database: &str, id: &str) -> Result<u64, String> {
    let encoded_db = encode_path_segment(database);
    let encoded_id = encode_path_segment(id);
    let rev = fetch_doc_rev(client, database, id).await?.ok_or_else(|| format!("Document '{id}' not found"))?;
    let path = format!("/{encoded_db}/{encoded_id}?rev={rev}");
    let resp = client.delete(&path).send().await.map_err(|e| format!("CouchDB request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("CouchDB delete error {status}: {body}"));
    }
    Ok(1)
}

// ---------------------------------------------------------------------------
// REST console execution
// ---------------------------------------------------------------------------

struct CouchDbRestRequest {
    method: Method,
    path: String,
    body: Option<String>,
}

fn strip_leading_couchdb_comments(input: &str) -> &str {
    let mut rest = input;
    loop {
        rest = rest.trim_start();
        if let Some(comment) = rest.strip_prefix('#').or_else(|| rest.strip_prefix("//")) {
            rest = comment.split_once('\n').map_or("", |(_, remaining)| remaining);
            continue;
        }
        if let Some(comment) = rest.strip_prefix("/*") {
            rest = comment.split_once("*/").map_or("", |(_, remaining)| remaining);
            continue;
        }
        return rest.trim();
    }
}

fn parse_couchdb_rest_request(input: &str) -> Result<CouchDbRestRequest, String> {
    let input = strip_leading_couchdb_comments(input);
    if input.is_empty() {
        return Err("Invalid query: expected METHOD /path".to_string());
    }
    let (request_line, body) = input.split_once('\n').map_or((input, None), |(line, body)| {
        let body = body.trim();
        (line, (!body.is_empty()).then(|| body.to_string()))
    });
    let (method, path) =
        request_line.trim().split_once(char::is_whitespace).ok_or("Invalid query: expected METHOD /path")?;
    let method = method.to_ascii_uppercase();
    let method = Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("Unsupported HTTP method: {method}. Use GET, POST, PUT, DELETE, or HEAD."))?;
    if !matches!(method, Method::GET | Method::POST | Method::PUT | Method::DELETE | Method::HEAD) {
        return Err(format!("Unsupported HTTP method: {}. Use GET, POST, PUT, DELETE, or HEAD.", method.as_str()));
    }

    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("Invalid query: expected METHOD /path".to_string());
    }
    let path = if path.starts_with('/') { path } else { format!("/{path}") };
    Ok(CouchDbRestRequest { method, path, body })
}

fn couchdb_docs_to_table(docs: &[Value]) -> (Vec<String>, Vec<String>, Vec<Vec<Value>>) {
    let mut columns = Vec::<String>::new();
    let mut column_indexes = HashMap::<String, usize>::new();
    let mut json_column_indexes = HashSet::<usize>::new();
    let mut rows = Vec::<Vec<Value>>::with_capacity(docs.len());

    for doc in docs {
        let mut row = vec![Value::Null; columns.len()];
        if let Some(object) = doc.as_object() {
            for (key, value) in object {
                let is_json_cell = matches!(value, Value::Array(_) | Value::Object(_));
                let value = if is_json_cell { Value::String(value.to_string()) } else { value.clone() };
                match column_indexes.get(key).copied() {
                    Some(index) => {
                        if is_json_cell {
                            json_column_indexes.insert(index);
                        }
                        row[index] = value;
                    }
                    None => {
                        let index = columns.len();
                        if is_json_cell {
                            json_column_indexes.insert(index);
                        }
                        column_indexes.insert(key.clone(), index);
                        columns.push(key.clone());
                        for previous_row in rows.iter_mut() {
                            previous_row.push(Value::Null);
                        }
                        row.push(value);
                    }
                }
            }
        }
        rows.push(row);
    }

    let column_types = columns
        .iter()
        .enumerate()
        .map(|(index, _)| {
            if json_column_indexes.contains(&index) {
                return "json".to_string();
            }
            let mut inferred = None;
            for value in rows.iter().filter_map(|row| row.get(index)) {
                let value_type = match value {
                    Value::Null => continue,
                    Value::Bool(_) => "boolean",
                    Value::Number(_) => "number",
                    Value::String(_) => "text",
                    Value::Array(_) | Value::Object(_) => "json",
                };
                inferred = match inferred {
                    None => Some(value_type),
                    Some(existing) if existing == value_type => Some(existing),
                    Some(_) => Some("json"),
                };
            }
            inferred.unwrap_or("unknown").to_string()
        })
        .collect();
    (columns, column_types, rows)
}

fn couchdb_table_result(
    columns: Vec<String>,
    column_types: Vec<String>,
    rows: Vec<Vec<Value>>,
    start: Instant,
) -> QueryResult {
    let row_count = rows.len() as u64;
    QueryResult {
        columns,
        column_types,
        column_sortables: vec![],
        spatial_columns: vec![],
        spatial_values: vec![],
        rows,
        affected_rows: row_count,
        execution_time_ms: start.elapsed().as_millis(),
        server_execute_time_us: None,
        query_timings_ms: None,
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    }
}

fn couchdb_raw_json_response_result(status: u16, body_text: impl Into<String>, start: Instant) -> QueryResult {
    QueryResult {
        columns: vec!["status".to_string(), "response".to_string()],
        column_types: Vec::new(),
        column_sortables: vec![],
        spatial_columns: vec![],
        spatial_values: vec![],
        rows: vec![vec![Value::Number(status.into()), Value::String(body_text.into())]],
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        server_execute_time_us: None,
        query_timings_ms: None,
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    }
}

pub fn parse_couchdb_rest_response(status: u16, body_text: &str, start: Instant) -> Result<QueryResult, String> {
    if status >= 400 {
        return Ok(couchdb_raw_json_response_result(status, body_text, start));
    }
    match serde_json::from_str::<Value>(body_text) {
        Ok(body) => {
            // Case 1: Array of database names, e.g. /_all_dbs
            if let Some(arr) = body.as_array() {
                let is_string_list = arr.iter().all(|item| item.is_string());
                if is_string_list {
                    let rows: Vec<Vec<Value>> = arr.iter().map(|item| vec![item.clone()]).collect();
                    let mut result =
                        couchdb_table_result(vec!["database".to_string()], vec!["text".to_string()], rows, start);
                    result.elasticsearch_raw_body = Some(body_text.to_string());
                    return Ok(result);
                }
            }

            // Case 2: Document array in "docs" from _find
            if let Some(docs) = body.get("docs").and_then(Value::as_array) {
                let (columns, column_types, rows) = couchdb_docs_to_table(docs);
                let mut result = couchdb_table_result(columns, column_types, rows, start);
                result.elasticsearch_raw_body = Some(body_text.to_string());
                return Ok(result);
            }

            // Case 3: Rows array from _all_docs
            if let Some(rows) = body.get("rows").and_then(Value::as_array) {
                let has_doc = rows.iter().any(|r| r.get("doc").is_some());
                if has_doc {
                    let docs: Vec<Value> = rows.iter().filter_map(|r| r.get("doc").cloned()).collect();
                    let (columns, column_types, rows) = couchdb_docs_to_table(&docs);
                    let mut result = couchdb_table_result(columns, column_types, rows, start);
                    result.elasticsearch_raw_body = Some(body_text.to_string());
                    return Ok(result);
                }
            }

            // Default: formatted JSON
            Ok(couchdb_raw_json_response_result(
                status,
                serde_json::to_string_pretty(&body).unwrap_or_else(|_| body_text.to_string()),
                start,
            ))
        }
        Err(_) => {
            let rows: Vec<Vec<Value>> = body_text.lines().map(|line| vec![Value::String(line.to_string())]).collect();
            let mut result = couchdb_table_result(vec!["response".to_string()], Vec::new(), rows, start);
            result.affected_rows = result.rows.len() as u64;
            Ok(result)
        }
    }
}

pub async fn execute_rest_query(client: &CouchDbClient, input: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let request = parse_couchdb_rest_request(input)?;
    let mut builder = client.request(request.method, &request.path);
    if let Some(body) = request.body {
        let json: Value = serde_json::from_str(&body).map_err(|e| format!("Invalid JSON body: {e}"))?;
        builder = builder.json(&json);
    }
    let resp = builder.send().await.map_err(|e| format!("CouchDB request failed: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| format!("CouchDB response read failed: {e}"))?;
    parse_couchdb_rest_response(status, &body, start)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_couchdb_base_url() {
        assert_eq!(normalize_couchdb_base_url("http://localhost:5984", false), "http://localhost:5984");
        assert_eq!(normalize_couchdb_base_url("http://localhost:5984/", false), "http://localhost:5984");
        assert_eq!(normalize_couchdb_base_url("couchdb://localhost:5984", false), "http://localhost:5984");
        assert_eq!(normalize_couchdb_base_url("couchdb://localhost:5984", true), "https://localhost:5984");
        assert_eq!(normalize_couchdb_base_url("localhost:5984", false), "http://localhost:5984");
        assert_eq!(normalize_couchdb_base_url("localhost:5984", true), "https://localhost:5984");
    }

    #[test]
    fn test_parse_couchdb_rest_request() {
        let req = parse_couchdb_rest_request("GET /_all_dbs").unwrap();
        assert_eq!(req.method, Method::GET);
        assert_eq!(req.path, "/_all_dbs");
        assert!(req.body.is_none());

        let req = parse_couchdb_rest_request("POST /mydb/_find\n{\"selector\":{}}").unwrap();
        assert_eq!(req.method, Method::POST);
        assert_eq!(req.path, "/mydb/_find");
        assert_eq!(req.body.as_deref(), Some("{\"selector\":{}}"));
    }

    #[test]
    fn test_parse_couchdb_sort() {
        assert_eq!(parse_couchdb_sort(None).unwrap(), None);
        assert_eq!(parse_couchdb_sort(Some("")).unwrap(), None);
        let sort_obj = parse_couchdb_sort(Some(r#"{"age": -1, "name": "asc"}"#)).unwrap().expect("sort should parse");
        assert!(sort_obj.is_array());
        assert!(parse_couchdb_sort(Some("not json")).is_err());
        assert!(parse_couchdb_sort(Some("42")).is_err());
    }

    #[test]
    fn test_parse_couchdb_selector() {
        let sel = parse_couchdb_selector(None).unwrap();
        assert_eq!(sel, serde_json::json!({ "_id": { "$gt": null } }));

        let sel = parse_couchdb_selector(Some(r#"{"name": "Alice"}"#)).unwrap();
        assert_eq!(sel, serde_json::json!({ "name": "Alice" }));

        let sel = parse_couchdb_selector(Some(r#"{"selector": {"name": "Alice"}}"#)).unwrap();
        assert_eq!(sel, serde_json::json!({ "name": "Alice" }));

        assert!(parse_couchdb_selector(Some("not json")).is_err());
        assert!(parse_couchdb_selector(Some(r#"["not","an","object"]"#)).is_err());
    }
}
