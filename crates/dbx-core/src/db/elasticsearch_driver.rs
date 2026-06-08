use reqwest::Client as HttpClient;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::error::Error;
use std::time::Duration;

use super::with_connection_timeout;
use crate::db::mongo_driver::MongoDocumentResult;

pub struct EsClient {
    http: HttpClient,
    base_url: String,
    fallback_base_urls: Vec<String>,
    auth: Option<(String, String)>,
}

impl EsClient {
    pub fn new(
        url: &str,
        username: Option<&str>,
        password: Option<&str>,
        accept_invalid_certs: bool,
        timeout: Duration,
    ) -> Self {
        let base_url = url.trim_end_matches('/').to_string();
        let auth = match (username, password) {
            (Some(u), Some(p)) if !u.is_empty() => Some((u.to_string(), p.to_string())),
            _ => None,
        };
        let mut builder =
            HttpClient::builder().connect_timeout(timeout).danger_accept_invalid_certs(accept_invalid_certs);
        if elasticsearch_should_bypass_system_proxy(&base_url) {
            builder = builder.no_proxy();
        }
        let http = builder.build().unwrap_or_else(|_| HttpClient::new());
        let fallback_base_urls = elasticsearch_base_url_fallbacks(&base_url);
        Self { http, base_url, fallback_base_urls, auth }
    }

    pub fn from_config(
        url: &str,
        username: Option<&str>,
        password: Option<&str>,
        tls_enabled: bool,
        url_params: Option<&str>,
        timeout: Duration,
    ) -> Self {
        Self::new(url, username, password, elasticsearch_accept_invalid_certs(tls_enabled, url_params), timeout)
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        let req = self.http.get(format!("{}{}", self.base_url, path));
        self.with_auth(req)
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        let req = self.http.post(format!("{}{}", self.base_url, path));
        self.with_auth(req)
    }

    fn put(&self, path: &str) -> reqwest::RequestBuilder {
        let req = self.http.put(format!("{}{}", self.base_url, path));
        self.with_auth(req)
    }

    fn delete(&self, path: &str) -> reqwest::RequestBuilder {
        let req = self.http.delete(format!("{}{}", self.base_url, path));
        self.with_auth(req)
    }

    fn with_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some((ref user, ref pass)) = self.auth {
            req.basic_auth(user, Some(pass))
        } else {
            req
        }
    }
}

impl Clone for EsClient {
    fn clone(&self) -> Self {
        Self {
            http: self.http.clone(),
            base_url: self.base_url.clone(),
            fallback_base_urls: self.fallback_base_urls.clone(),
            auth: self.auth.clone(),
        }
    }
}

pub async fn test_connection(client: &mut EsClient, timeout: Duration) -> Result<(), String> {
    let mut errors = Vec::new();
    let urls = std::iter::once(client.base_url.clone()).chain(client.fallback_base_urls.clone());

    for base_url in urls {
        client.base_url = base_url.clone();
        let resp = with_connection_timeout("Elasticsearch", timeout, async {
            client.get("/").send().await.map_err(|e| {
                format!(
                    "Elasticsearch connection failed for {}: {}",
                    redact_elasticsearch_url(&base_url),
                    format_reqwest_error(&e)
                )
            })
        })
        .await;

        let resp = match resp {
            Ok(resp) => resp,
            Err(err) => {
                errors.push(err);
                continue;
            }
        };

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Elasticsearch error ({status}): {body}"));
        }
        return Ok(());
    }

    if errors.is_empty() {
        Err("Elasticsearch connection failed: no URL candidates".to_string())
    } else {
        Err(errors.join("; "))
    }
}

pub fn elasticsearch_accept_invalid_certs(tls_enabled: bool, url_params: Option<&str>) -> bool {
    tls_enabled
        || elasticsearch_url_params_flag(url_params, "sslmode", &["disable", "allow"])
        || elasticsearch_url_params_flag(url_params, "tlsverify", &["false", "0", "no", "off"])
        || elasticsearch_url_params_flag(url_params, "verify", &["false", "0", "no", "off"])
        || elasticsearch_url_params_flag(url_params, "insecure", &["true", "1", "yes", "on"])
        || elasticsearch_url_params_flag(url_params, "accept_invalid_certs", &["true", "1", "yes", "on"])
}

fn elasticsearch_url_params_flag(params: Option<&str>, key: &str, expected_values: &[&str]) -> bool {
    params.unwrap_or("").trim().trim_start_matches('?').split('&').filter_map(|pair| pair.split_once('=')).any(
        |(k, v)| {
            k.trim().eq_ignore_ascii_case(key)
                && expected_values.iter().any(|expected| v.trim().eq_ignore_ascii_case(expected))
        },
    )
}

fn elasticsearch_base_url_fallbacks(base_url: &str) -> Vec<String> {
    let Ok(parsed) = reqwest::Url::parse(base_url) else {
        return Vec::new();
    };
    let Some(host) = parsed.host_str() else {
        return Vec::new();
    };
    if !host.eq_ignore_ascii_case("localhost") {
        return Vec::new();
    }

    let mut fallback = parsed;
    if fallback.set_host(Some("127.0.0.1")).is_ok() {
        vec![fallback.as_str().trim_end_matches('/').to_string()]
    } else {
        Vec::new()
    }
}

fn elasticsearch_should_bypass_system_proxy(base_url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(base_url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn redact_elasticsearch_url(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return url.to_string();
    };
    if !parsed.username().is_empty() {
        let _ = parsed.set_username("user");
    }
    if parsed.password().is_some() {
        let _ = parsed.set_password(Some("password"));
    }
    parsed.as_str().trim_end_matches('/').to_string()
}

fn format_reqwest_error(err: &reqwest::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(err) = source {
        let text = err.to_string();
        if !text.is_empty() && !parts.iter().any(|part| part == &text) {
            parts.push(text);
        }
        source = err.source();
    }
    parts.join(": ")
}

#[derive(Deserialize)]
struct CatIndex {
    index: String,
}

pub async fn list_indices(client: &EsClient) -> Result<Vec<String>, String> {
    let resp = client
        .get("/_cat/indices?format=json&h=index")
        .send()
        .await
        .map_err(|e| format!("Elasticsearch request failed: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }
    let indices: Vec<CatIndex> = resp.json().await.map_err(|e| format!("Elasticsearch parse error: {e}"))?;
    let mut names: Vec<String> = indices.into_iter().filter(|i| !i.index.starts_with('.')).map(|i| i.index).collect();
    names.sort();
    Ok(names)
}

pub async fn get_columns(client: &EsClient, index: &str) -> Result<Vec<crate::db::ColumnInfo>, String> {
    let path = format!("/{index}/_mapping");
    let resp = client.get(&path).send().await.map_err(|e| format!("Elasticsearch request failed: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    let body: Value = resp.json().await.map_err(|e| format!("Elasticsearch parse error: {e}"))?;
    let mut seen = HashSet::new();
    let mut columns = Vec::new();

    if let Some(indices) = body.as_object() {
        for index_mapping in indices.values() {
            if let Some(properties) = mapping_properties(index_mapping) {
                collect_mapping_columns("", properties, &mut seen, &mut columns);
            }
        }
    }

    columns.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(columns)
}

fn mapping_properties(mapping: &Value) -> Option<&serde_json::Map<String, Value>> {
    if let Some(properties) = mapping.pointer("/mappings/properties").and_then(Value::as_object) {
        return Some(properties);
    }

    mapping
        .get("mappings")
        .and_then(Value::as_object)?
        .values()
        .find_map(|typed_mapping| typed_mapping.get("properties").and_then(Value::as_object))
}

fn collect_mapping_columns(
    prefix: &str,
    properties: &serde_json::Map<String, Value>,
    seen: &mut HashSet<String>,
    columns: &mut Vec<crate::db::ColumnInfo>,
) {
    for (name, definition) in properties {
        let field_name = if prefix.is_empty() { name.clone() } else { format!("{prefix}.{name}") };
        let field_type = definition.get("type").and_then(Value::as_str);

        if let Some(data_type) = field_type {
            push_mapping_column(&field_name, data_type, seen, columns);
        }

        if let Some(fields) = definition.get("fields").and_then(Value::as_object) {
            collect_mapping_columns(&field_name, fields, seen, columns);
        }

        if let Some(children) = definition.get("properties").and_then(Value::as_object) {
            collect_mapping_columns(&field_name, children, seen, columns);
        }
    }
}

fn push_mapping_column(
    name: &str,
    data_type: &str,
    seen: &mut HashSet<String>,
    columns: &mut Vec<crate::db::ColumnInfo>,
) {
    if !seen.insert(name.to_string()) {
        return;
    }

    columns.push(crate::db::ColumnInfo {
        name: name.to_string(),
        data_type: data_type.to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
        numeric_precision: None,
        numeric_scale: None,
        character_maximum_length: None,
    });
}

#[derive(Deserialize)]
struct SearchResponse {
    hits: SearchHits,
}

#[derive(Deserialize)]
struct SearchHits {
    total: HitsTotal,
    hits: Vec<SearchHit>,
}

#[derive(Deserialize)]
struct HitsTotal {
    value: u64,
}

#[derive(Deserialize)]
struct SearchHit {
    #[serde(rename = "_id")]
    id: String,
    #[serde(rename = "_source")]
    source: serde_json::Value,
}

pub async fn find_documents(
    client: &EsClient,
    index: &str,
    skip: u64,
    limit: i64,
) -> Result<MongoDocumentResult, String> {
    let body = serde_json::json!({
        "from": skip,
        "size": limit,
        "sort": ["_doc"],
    });

    let path = format!("/{}/_search", index);
    let resp = client.post(&path).json(&body).send().await.map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    let result: SearchResponse = resp.json().await.map_err(|e| format!("Elasticsearch parse error: {e}"))?;

    let documents: Vec<serde_json::Value> = result
        .hits
        .hits
        .into_iter()
        .map(|hit| {
            let mut doc = match hit.source {
                serde_json::Value::Object(map) => map,
                _ => serde_json::Map::new(),
            };
            doc.insert("_id".to_string(), serde_json::Value::String(hit.id));
            serde_json::Value::Object(doc)
        })
        .collect();

    Ok(MongoDocumentResult { documents, total: result.hits.total.value })
}

pub async fn insert_document(client: &EsClient, index: &str, doc_json: &str) -> Result<String, String> {
    let doc: serde_json::Value = serde_json::from_str(doc_json).map_err(|e| format!("Invalid JSON: {e}"))?;

    let path = format!("/{}/_doc?refresh=true", index);
    let resp = client.post(&path).json(&doc).send().await.map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    let result: serde_json::Value = resp.json().await.map_err(|e| format!("Elasticsearch parse error: {e}"))?;
    Ok(result["_id"].as_str().unwrap_or("").to_string())
}

pub async fn update_document(client: &EsClient, index: &str, id: &str, doc_json: &str) -> Result<u64, String> {
    let doc: serde_json::Value = serde_json::from_str(doc_json).map_err(|e| format!("Invalid JSON: {e}"))?;

    let path = format!("/{}/_doc/{}?refresh=true", index, id);
    let resp = client.put(&path).json(&doc).send().await.map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    Ok(1)
}

pub async fn delete_document(client: &EsClient, index: &str, id: &str) -> Result<u64, String> {
    let path = format!("/{}/_doc/{}?refresh=true", index, id);
    let resp = client.delete(&path).send().await.map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    Ok(1)
}

pub async fn execute_rest_query(client: &EsClient, input: &str) -> Result<crate::types::QueryResult, String> {
    let start = std::time::Instant::now();
    let input = input.trim();

    if let Some(search_query) = parse_select_star_search_query(input) {
        return execute_search_query(client, search_query, start).await;
    }

    if is_elasticsearch_sql_query(input) {
        return execute_sql_query(client, input, start).await;
    }

    let (method, rest) = input.split_once(char::is_whitespace).ok_or("Invalid query: expected METHOD /path")?;
    let method = method.to_uppercase();

    let (path, body) = if let Some(pos) = rest.find('\n') {
        let p = rest[..pos].trim();
        let b = rest[pos + 1..].trim();
        (p, if b.is_empty() { None } else { Some(b) })
    } else {
        (rest.trim(), None)
    };

    let path = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };

    let resp = match method.as_str() {
        "GET" => {
            let req = client.get(&path);
            if let Some(b) = body {
                let json: serde_json::Value = serde_json::from_str(b).map_err(|e| format!("Invalid JSON body: {e}"))?;
                req.json(&json).send().await
            } else {
                req.send().await
            }
        }
        "POST" => {
            let req = client.post(&path);
            if let Some(b) = body {
                let json: serde_json::Value = serde_json::from_str(b).map_err(|e| format!("Invalid JSON body: {e}"))?;
                req.json(&json).send().await
            } else {
                req.send().await
            }
        }
        "PUT" => {
            let req = client.put(&path);
            if let Some(b) = body {
                let json: serde_json::Value = serde_json::from_str(b).map_err(|e| format!("Invalid JSON body: {e}"))?;
                req.json(&json).send().await
            } else {
                req.send().await
            }
        }
        "DELETE" => client.delete(&path).send().await,
        _ => return Err(format!("Unsupported HTTP method: {method}. Use GET, POST, PUT, or DELETE.")),
    }
    .map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    let status = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await.unwrap_or_else(|_| serde_json::Value::Null);

    parse_elasticsearch_response(status, body, start)
}

// Size to use when `SELECT *` is run without an explicit LIMIT — large enough
// to be useful, small enough that the user doesn't accidentally pull millions
// of documents. The result-grid surfaces the index's true total separately so
// the user can see how much was actually held back.
const AUTO_PAGED_SELECT_STAR_SIZE: usize = 100;

struct ElasticsearchSearchQuery {
    index: String,
    body: serde_json::Value,
    // True when the SQL came through the pagination plan (it carries OFFSET).
    // In that case the result-grid total must reflect the index's true match
    // count so the front-end can compute the total page count. A bare
    // user-written `LIMIT N` (no OFFSET) is the "give me exactly N rows" case
    // and reports affected_rows = N for client-side paging.
    from_plan_pagination: bool,
}

async fn execute_search_query(
    client: &EsClient,
    query: ElasticsearchSearchQuery,
    start: std::time::Instant,
) -> Result<crate::types::QueryResult, String> {
    let report_index_total = query.from_plan_pagination;
    let path = format!("/{}/_search", query.index);
    let resp =
        client.post(&path).json(&query.body).send().await.map_err(|e| format!("Elasticsearch request failed: {e}"))?;
    let status = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await.unwrap_or_else(|_| serde_json::Value::Null);
    // Capture the index's true match total before the body is consumed by the
    // parser — needed below when we report total instead of rows.len().
    let index_total = body.pointer("/hits/total/value").and_then(|v| v.as_u64());

    let mut result = parse_elasticsearch_response(status, body, start)?;
    if report_index_total {
        if let Some(total) = index_total {
            result.affected_rows = total;
        }
    }
    Ok(result)
}

fn parse_elasticsearch_response(
    status: u16,
    body: serde_json::Value,
    start: std::time::Instant,
) -> Result<crate::types::QueryResult, String> {
    if let Some(result) = parse_sql_response(&body, start) {
        Ok(result)
    } else if let Some(hits) = body.pointer("/hits/hits").and_then(|v| v.as_array()).filter(|h| !h.is_empty()) {
        let mut all_keys = Vec::<String>::new();
        let docs: Vec<serde_json::Map<String, serde_json::Value>> = hits
            .iter()
            .map(|hit| {
                let mut row = serde_json::Map::new();
                row.insert("_id".to_string(), hit.get("_id").cloned().unwrap_or(serde_json::Value::Null));
                if let Some(source) = hit.get("_source").and_then(|s| s.as_object()) {
                    for (k, v) in source {
                        row.insert(k.clone(), v.clone());
                    }
                }
                for k in row.keys() {
                    if !all_keys.contains(k) {
                        all_keys.push(k.clone());
                    }
                }
                row
            })
            .collect();

        let rows: Vec<Vec<serde_json::Value>> = docs
            .iter()
            .map(|doc| {
                all_keys
                    .iter()
                    .map(|k| {
                        doc.get(k)
                            .map(|v| match v {
                                serde_json::Value::String(s) => serde_json::Value::String(s.clone()),
                                other => serde_json::Value::String(other.to_string()),
                            })
                            .unwrap_or(serde_json::Value::Null)
                    })
                    .collect()
            })
            .collect();

        let row_count = rows.len() as u64;

        Ok(crate::types::QueryResult {
            columns: all_keys,
            column_types: Vec::new(),
            rows,
            affected_rows: row_count,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    } else if let Some(aggs) = body.get("aggregations").or_else(|| body.get("aggs")).and_then(|v| v.as_object()) {
        let (columns, rows) = parse_aggregations(aggs);
        if !columns.is_empty() {
            let row_count = rows.len() as u64;
            Ok(crate::types::QueryResult {
                columns,
                column_types: Vec::new(),
                rows,
                affected_rows: row_count,
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
                session_id: None,
                has_more: false,
            })
        } else {
            let pretty = serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string());
            Ok(crate::types::QueryResult {
                columns: vec!["status".to_string(), "response".to_string()],
                column_types: Vec::new(),
                rows: vec![vec![serde_json::Value::Number(status.into()), serde_json::Value::String(pretty)]],
                affected_rows: 0,
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
                session_id: None,
                has_more: false,
            })
        }
    } else {
        let pretty = serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string());
        Ok(crate::types::QueryResult {
            columns: vec!["status".to_string(), "response".to_string()],
            column_types: Vec::new(),
            rows: vec![vec![serde_json::Value::Number(status.into()), serde_json::Value::String(pretty)]],
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

fn parse_select_star_search_query(input: &str) -> Option<ElasticsearchSearchQuery> {
    let mut cursor = skip_sql_whitespace(input, 0);
    cursor = consume_sql_keyword(input, cursor, "select")?;
    cursor = skip_sql_whitespace(input, cursor);
    if next_char_at(input, cursor)? != '*' {
        return None;
    }
    cursor += '*'.len_utf8();
    cursor = skip_sql_whitespace(input, cursor);
    cursor = consume_sql_keyword(input, cursor, "from")?;
    cursor = skip_sql_whitespace(input, cursor);

    let (index, next_cursor) = read_sql_token(input, cursor)?;
    cursor = next_cursor;

    let mut sort_field = None;
    let mut sort_order = "asc";
    let mut limit = None;
    let mut offset: Option<usize> = None;

    loop {
        cursor = skip_sql_whitespace(input, cursor);
        if cursor >= input.len() {
            break;
        }
        if next_char_at(input, cursor) == Some(';') {
            cursor += ';'.len_utf8();
            cursor = skip_sql_whitespace(input, cursor);
            if cursor == input.len() {
                break;
            }
            return None;
        }

        if is_keyword_at(input, cursor, "order") {
            cursor = consume_sql_keyword(input, cursor, "order")?;
            cursor = skip_sql_whitespace(input, cursor);
            cursor = consume_sql_keyword(input, cursor, "by")?;
            cursor = skip_sql_whitespace(input, cursor);
            let (field, next_cursor) = read_sql_token(input, cursor)?;
            sort_field = Some(field);
            cursor = skip_sql_whitespace(input, next_cursor);
            if is_keyword_at(input, cursor, "asc") {
                sort_order = "asc";
                cursor = consume_sql_keyword(input, cursor, "asc")?;
            } else if is_keyword_at(input, cursor, "desc") {
                sort_order = "desc";
                cursor = consume_sql_keyword(input, cursor, "desc")?;
            }
        } else if is_keyword_at(input, cursor, "limit") {
            cursor = consume_sql_keyword(input, cursor, "limit")?;
            cursor = skip_sql_whitespace(input, cursor);
            let (value, next_cursor) = read_while(input, cursor, |ch| ch.is_ascii_digit());
            limit = value.parse::<usize>().ok();
            cursor = next_cursor;
        } else if is_keyword_at(input, cursor, "offset") {
            cursor = consume_sql_keyword(input, cursor, "offset")?;
            cursor = skip_sql_whitespace(input, cursor);
            let (value, next_cursor) = read_while(input, cursor, |ch| ch.is_ascii_digit());
            offset = value.parse::<usize>().ok();
            cursor = next_cursor;
        } else {
            return None;
        }
    }

    // The pagination plan emits `LIMIT N OFFSET M` (always with OFFSET, even
    // when 0) for ES; a user-written SQL that only has `LIMIT N` leaves
    // OFFSET absent. We use that as the signal for whether the front-end is
    // driving server-side pagination — in that case affected_rows must reflect
    // the index's true total so the grid can compute the total page count.
    let from_plan_pagination = offset.is_some();
    let effective_size = limit.unwrap_or(AUTO_PAGED_SELECT_STAR_SIZE);
    let effective_from = offset.unwrap_or(0);
    let mut body = serde_json::Map::new();
    body.insert("size".to_string(), serde_json::json!(effective_size));
    if effective_from > 0 {
        body.insert("from".to_string(), serde_json::json!(effective_from));
    }

    if let Some(field) = sort_field {
        let mut sort_item = serde_json::Map::new();
        sort_item.insert(field, serde_json::json!({ "order": sort_order }));
        body.insert("sort".to_string(), serde_json::Value::Array(vec![serde_json::Value::Object(sort_item)]));
    }

    Some(ElasticsearchSearchQuery { index, body: serde_json::Value::Object(body), from_plan_pagination })
}

fn is_elasticsearch_sql_query(input: &str) -> bool {
    input
        .trim_start()
        .split_once(char::is_whitespace)
        .map(|(keyword, _)| keyword.eq_ignore_ascii_case("select"))
        .unwrap_or_else(|| input.trim_start().eq_ignore_ascii_case("select"))
}

async fn execute_sql_query(
    client: &EsClient,
    query: &str,
    start: std::time::Instant,
) -> Result<crate::types::QueryResult, String> {
    let query = adapt_elasticsearch_sql_query(query);
    let body = serde_json::json!({ "query": query });
    let resp =
        client.post("/_sql").json(&body).send().await.map_err(|e| format!("Elasticsearch request failed: {e}"))?;
    let status = resp.status();
    let response_body: serde_json::Value = resp.json().await.unwrap_or_else(|_| serde_json::Value::Null);

    if !status.is_success() {
        return Err(format_sql_error(status, &response_body));
    }

    parse_sql_response(&response_body, start).ok_or_else(|| {
        let pretty = serde_json::to_string_pretty(&response_body).unwrap_or_else(|_| response_body.to_string());
        format!("Unexpected Elasticsearch SQL response: {pretty}")
    })
}

fn adapt_elasticsearch_sql_query(query: &str) -> String {
    let mut output = String::with_capacity(query.len());
    let mut index = 0;
    let mut state = SqlScanState::Normal;

    while let Some(ch) = next_char_at(query, index) {
        match state {
            SqlScanState::Normal => match ch {
                '\'' => {
                    output.push(ch);
                    index += ch.len_utf8();
                    state = SqlScanState::SingleQuoted;
                }
                '"' => {
                    output.push(ch);
                    index += ch.len_utf8();
                    state = SqlScanState::DoubleQuoted;
                }
                '`' => {
                    output.push(ch);
                    index += ch.len_utf8();
                    state = SqlScanState::BacktickQuoted;
                }
                '-' if query[index..].starts_with("--") => {
                    output.push_str("--");
                    index += 2;
                    state = SqlScanState::LineComment;
                }
                '/' if query[index..].starts_with("/*") => {
                    output.push_str("/*");
                    index += 2;
                    state = SqlScanState::BlockComment;
                }
                '@' if is_at_identifier_boundary(&output) => {
                    let (identifier, next_index) = read_while(query, index, is_elasticsearch_identifier_part);
                    output.push('"');
                    output.push_str(identifier);
                    output.push('"');
                    index = next_index;
                }
                _ => {
                    if let Some(keyword) = relation_keyword_at(query, index) {
                        index = quote_relation_after_keyword(query, index, keyword, &mut output);
                    } else {
                        output.push(ch);
                        index += ch.len_utf8();
                    }
                }
            },
            SqlScanState::SingleQuoted => {
                if copy_quoted_char(query, &mut index, ch, '\'', &mut output) {
                    state = SqlScanState::Normal;
                }
            }
            SqlScanState::DoubleQuoted => {
                if copy_quoted_char(query, &mut index, ch, '"', &mut output) {
                    state = SqlScanState::Normal;
                }
            }
            SqlScanState::BacktickQuoted => {
                if copy_quoted_char(query, &mut index, ch, '`', &mut output) {
                    state = SqlScanState::Normal;
                }
            }
            SqlScanState::LineComment => {
                output.push(ch);
                index += ch.len_utf8();
                if ch == '\n' {
                    state = SqlScanState::Normal;
                }
            }
            SqlScanState::BlockComment => {
                if query[index..].starts_with("*/") {
                    output.push_str("*/");
                    index += 2;
                    state = SqlScanState::Normal;
                } else {
                    output.push(ch);
                    index += ch.len_utf8();
                }
            }
        }
    }

    output
}

fn quote_relation_after_keyword(query: &str, index: usize, keyword: &str, output: &mut String) -> usize {
    let mut cursor = index + keyword.len();
    output.push_str(&query[index..cursor]);

    while let Some(ch) = next_char_at(query, cursor) {
        if !ch.is_whitespace() {
            break;
        }
        output.push(ch);
        cursor += ch.len_utf8();
    }

    if matches!(next_char_at(query, cursor), Some('"' | '`' | '\'' | '(')) {
        return cursor;
    }

    let relation_start = cursor;
    while let Some(ch) = next_char_at(query, cursor) {
        if !is_relation_name_char(ch) {
            break;
        }
        cursor += ch.len_utf8();
    }

    let relation = &query[relation_start..cursor];
    if relation_name_needs_quotes(relation) {
        output.push('"');
        output.push_str(relation);
        output.push('"');
    } else {
        output.push_str(relation);
    }

    cursor
}

fn copy_quoted_char(query: &str, index: &mut usize, ch: char, quote: char, output: &mut String) -> bool {
    output.push(ch);
    *index += ch.len_utf8();

    if ch != quote {
        return false;
    }

    if next_char_at(query, *index).is_some_and(|next| next == quote) {
        output.push(quote);
        *index += quote.len_utf8();
        false
    } else {
        true
    }
}

fn read_while(query: &str, start: usize, predicate: fn(char) -> bool) -> (&str, usize) {
    let mut cursor = start;
    while let Some(ch) = next_char_at(query, cursor) {
        if !predicate(ch) {
            break;
        }
        cursor += ch.len_utf8();
    }

    (&query[start..cursor], cursor)
}

fn skip_sql_whitespace(query: &str, mut cursor: usize) -> usize {
    while let Some(ch) = next_char_at(query, cursor) {
        if !ch.is_whitespace() {
            break;
        }
        cursor += ch.len_utf8();
    }

    cursor
}

fn consume_sql_keyword(query: &str, cursor: usize, keyword: &str) -> Option<usize> {
    is_keyword_at(query, cursor, keyword).then_some(cursor + keyword.len())
}

fn read_sql_token(query: &str, cursor: usize) -> Option<(String, usize)> {
    let quote = match next_char_at(query, cursor)? {
        '"' => Some('"'),
        '`' => Some('`'),
        _ => None,
    };

    if let Some(quote) = quote {
        let mut output = String::new();
        let mut next_cursor = cursor + quote.len_utf8();
        while let Some(ch) = next_char_at(query, next_cursor) {
            next_cursor += ch.len_utf8();
            if ch == quote {
                if next_char_at(query, next_cursor).is_some_and(|next| next == quote) {
                    output.push(quote);
                    next_cursor += quote.len_utf8();
                } else {
                    return Some((output, next_cursor));
                }
            } else {
                output.push(ch);
            }
        }
        return None;
    }

    let (token, next_cursor) = read_while(query, cursor, is_relation_name_char);
    (!token.is_empty()).then(|| (token.to_string(), next_cursor))
}

fn relation_keyword_at(query: &str, index: usize) -> Option<&'static str> {
    ["from", "join"].into_iter().find(|keyword| is_keyword_at(query, index, keyword))
}

#[derive(Clone, Copy)]
enum SqlScanState {
    Normal,
    SingleQuoted,
    DoubleQuoted,
    BacktickQuoted,
    LineComment,
    BlockComment,
}

fn is_at_identifier_boundary(output: &str) -> bool {
    output.chars().next_back().is_none_or(|ch| !is_sql_identifier_part(ch))
}

fn is_sql_identifier_part(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.')
}

fn is_elasticsearch_identifier_part(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-' | '@')
}

fn is_relation_name_char(ch: char) -> bool {
    !ch.is_whitespace() && !matches!(ch, ',' | ';' | '(' | ')')
}

fn relation_name_needs_quotes(relation: &str) -> bool {
    relation.chars().any(|ch| matches!(ch, '-' | '*' | '@'))
}

fn is_keyword_at(query: &str, index: usize, keyword: &str) -> bool {
    query.get(index..index + keyword.len()).is_some_and(|candidate| candidate.eq_ignore_ascii_case(keyword))
        && query[..index].chars().next_back().is_none_or(|ch| !is_keyword_boundary_char(ch))
        && query[index + keyword.len()..].chars().next().is_none_or(|ch| !is_keyword_boundary_char(ch))
}

fn is_keyword_boundary_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn next_char_at(query: &str, index: usize) -> Option<char> {
    query.get(index..)?.chars().next()
}

fn parse_sql_response(body: &serde_json::Value, start: std::time::Instant) -> Option<crate::types::QueryResult> {
    let columns = body.get("columns")?.as_array()?;
    let rows = body.get("rows")?.as_array()?;
    let column_names: Vec<String> = columns
        .iter()
        .filter_map(|column| column.get("name").and_then(|name| name.as_str()).map(str::to_string))
        .collect();

    if column_names.is_empty() && !columns.is_empty() {
        return None;
    }

    let result_rows: Vec<Vec<serde_json::Value>> =
        rows.iter().filter_map(|row| row.as_array().map(|values| values.to_vec())).collect();

    Some(crate::types::QueryResult {
        columns: column_names,
        column_types: Vec::new(),
        rows: result_rows,
        affected_rows: rows.len() as u64,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: body.get("cursor").and_then(|cursor| cursor.as_str()).map(str::to_string),
        has_more: body.get("cursor").and_then(|cursor| cursor.as_str()).is_some(),
    })
}

fn format_sql_error(status: reqwest::StatusCode, body: &serde_json::Value) -> String {
    let detail = body
        .pointer("/error/reason")
        .and_then(|reason| reason.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| serde_json::to_string_pretty(body).unwrap_or_else(|_| body.to_string()));

    if status == reqwest::StatusCode::NOT_FOUND {
        format!("Elasticsearch SQL API is not available ({status}): {detail}")
    } else {
        format!("Elasticsearch SQL error ({status}): {detail}")
    }
}

fn parse_aggregations(aggs: &serde_json::Map<String, serde_json::Value>) -> (Vec<String>, Vec<Vec<serde_json::Value>>) {
    for (_name, agg_value) in aggs {
        if let Some(buckets) = agg_value.get("buckets").and_then(|b| b.as_array()) {
            if buckets.is_empty() {
                continue;
            }
            let mut all_keys = Vec::<String>::new();
            let mut bucket_rows = Vec::new();

            for bucket in buckets {
                if let Some(obj) = bucket.as_object() {
                    let mut row = serde_json::Map::new();
                    for (k, v) in obj {
                        if let Some(sub) = v.as_object() {
                            if let Some(val) = sub.get("value") {
                                row.insert(k.clone(), val.clone());
                            } else {
                                row.insert(k.clone(), serde_json::Value::String(v.to_string()));
                            }
                        } else {
                            row.insert(k.clone(), v.clone());
                        }
                    }
                    for key in row.keys() {
                        if !all_keys.contains(key) {
                            all_keys.push(key.clone());
                        }
                    }
                    bucket_rows.push(row);
                }
            }

            let rows = bucket_rows
                .iter()
                .map(|br| {
                    all_keys
                        .iter()
                        .map(|k| {
                            br.get(k)
                                .map(|v| match v {
                                    serde_json::Value::String(s) => serde_json::Value::String(s.clone()),
                                    other => serde_json::Value::String(other.to_string()),
                                })
                                .unwrap_or(serde_json::Value::Null)
                        })
                        .collect()
                })
                .collect();

            return (all_keys, rows);
        }
    }

    let mut columns = Vec::new();
    let mut values = Vec::new();
    for (name, agg_value) in aggs {
        if let Some(obj) = agg_value.as_object() {
            if let Some(val) = obj.get("value") {
                columns.push(name.clone());
                values.push(match val {
                    serde_json::Value::String(s) => serde_json::Value::String(s.clone()),
                    other => serde_json::Value::String(other.to_string()),
                });
            }
        }
    }
    if !columns.is_empty() {
        return (columns, vec![values]);
    }

    (Vec::new(), Vec::new())
}

#[cfg(test)]
mod tests {
    use super::{
        elasticsearch_accept_invalid_certs, elasticsearch_base_url_fallbacks, elasticsearch_should_bypass_system_proxy,
        redact_elasticsearch_url, EsClient,
    };
    use std::time::Duration;

    #[test]
    fn url_params_can_disable_elasticsearch_tls_verification() {
        assert!(elasticsearch_accept_invalid_certs(false, Some("sslmode=disable")));
        assert!(elasticsearch_accept_invalid_certs(false, Some("?tlsVerify=false")));
        assert!(elasticsearch_accept_invalid_certs(false, Some("verify=0")));
        assert!(elasticsearch_accept_invalid_certs(false, Some("insecure=true")));
        assert!(elasticsearch_accept_invalid_certs(false, Some("accept_invalid_certs=on")));
        assert!(!elasticsearch_accept_invalid_certs(false, Some("sslmode=require&verify=true")));
    }

    #[test]
    fn tls_checkbox_keeps_legacy_insecure_elasticsearch_behavior() {
        assert!(elasticsearch_accept_invalid_certs(true, None));
    }

    #[test]
    fn localhost_elasticsearch_url_falls_back_to_ipv4_loopback() {
        assert_eq!(
            elasticsearch_base_url_fallbacks("https://localhost:9200"),
            vec!["https://127.0.0.1:9200".to_string()]
        );
        assert_eq!(elasticsearch_base_url_fallbacks("https://search.example.com:9200"), Vec::<String>::new());
    }

    #[test]
    fn elasticsearch_client_from_config_uses_url_params_for_tls_verification() {
        let client = EsClient::from_config(
            "https://localhost:9200/",
            Some("elastic"),
            Some("secret"),
            false,
            Some("sslmode=disable"),
            Duration::from_secs(1),
        );

        assert_eq!(client.base_url, "https://localhost:9200");
        assert_eq!(client.fallback_base_urls, vec!["https://127.0.0.1:9200"]);
    }

    #[test]
    fn redacts_elasticsearch_url_credentials_in_errors() {
        assert_eq!(
            redact_elasticsearch_url("https://elastic:secret@localhost:9200"),
            "https://user:password@localhost:9200"
        );
    }

    #[test]
    fn elasticsearch_only_bypasses_system_proxy_for_loopback_hosts() {
        assert!(elasticsearch_should_bypass_system_proxy("https://localhost:9200"));
        assert!(elasticsearch_should_bypass_system_proxy("https://127.0.0.1:9200"));
        assert!(elasticsearch_should_bypass_system_proxy("https://[::1]:9200"));
        assert!(!elasticsearch_should_bypass_system_proxy("https://search.example.com:9200"));
    }
}
