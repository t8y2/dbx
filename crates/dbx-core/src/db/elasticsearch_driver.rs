use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::Client as HttpClient;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::error::Error;
use std::time::Duration;

use super::{http_client_builder, with_connection_timeout};
use crate::db::mongo_driver::MongoDocumentResult;

const ELASTICSEARCH_PATH_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS
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

const ELASTICSEARCH_QUERY_VALUE_ENCODE_SET: &AsciiSet =
    &CONTROLS.add(b' ').add(b'"').add(b'#').add(b'%').add(b'&').add(b'+').add(b'/').add(b'=').add(b'?');

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
        let builder = http_client_builder(timeout).danger_accept_invalid_certs(accept_invalid_certs);
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

fn elasticsearch_index_path(index: &str, endpoint: &str) -> String {
    format!("/{}/{}", elasticsearch_path_segment(index), endpoint.trim_start_matches('/'))
}

fn elasticsearch_path_segment(value: &str) -> String {
    utf8_percent_encode(value, ELASTICSEARCH_PATH_SEGMENT_ENCODE_SET).to_string()
}

fn elasticsearch_query_value(value: &str) -> String {
    utf8_percent_encode(value, ELASTICSEARCH_QUERY_VALUE_ENCODE_SET).to_string()
}

fn elasticsearch_document_path(index: &str, id: &str, routing: Option<&str>) -> String {
    let base = format!("/{}/_doc/{}", elasticsearch_path_segment(index), elasticsearch_path_segment(id));
    if let Some(routing) = routing.map(str::trim).filter(|value| !value.is_empty()) {
        format!("{base}?routing={}&refresh=true", elasticsearch_query_value(routing))
    } else {
        format!("{base}?refresh=true")
    }
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
    let path = elasticsearch_index_path(index, "_mapping");
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

enum HitsTotal {
    Count(u64),
    Value { value: u64 },
}

impl HitsTotal {
    fn value(&self) -> u64 {
        match self {
            Self::Count(value) | Self::Value { value } => *value,
        }
    }
}

impl<'de> Deserialize<'de> for HitsTotal {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        if let Some(count) = value.as_u64() {
            return Ok(Self::Count(count));
        }
        if let Some(count) = value.get("value").and_then(serde_json::Value::as_u64) {
            return Ok(Self::Value { value: count });
        }
        Err(serde::de::Error::custom("expected hits.total as a number or an object with value"))
    }
}

#[derive(Deserialize)]
struct SearchHit {
    #[serde(rename = "_id")]
    id: String,
    #[serde(rename = "_routing")]
    routing: Option<String>,
    #[serde(rename = "_source")]
    source: serde_json::Value,
}

pub async fn find_documents(
    client: &EsClient,
    index: &str,
    skip: u64,
    limit: i64,
    filter: Option<&str>,
    sort: Option<&str>,
) -> Result<MongoDocumentResult, String> {
    let body = build_find_documents_body(skip, limit, filter, sort)?;

    let path = elasticsearch_index_path(index, "_search");
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
            if let Some(routing) = hit.routing {
                doc.insert("_routing".to_string(), serde_json::Value::String(routing));
            }
            serde_json::Value::Object(doc)
        })
        .collect();

    Ok(MongoDocumentResult { documents, total: result.hits.total.value() })
}

fn build_find_documents_body(
    skip: u64,
    limit: i64,
    filter: Option<&str>,
    sort: Option<&str>,
) -> Result<serde_json::Value, String> {
    let mut body = serde_json::Map::new();
    body.insert("from".to_string(), serde_json::json!(skip));
    body.insert("size".to_string(), serde_json::json!(limit));

    if let Some(query) = elasticsearch_query_from_document_filter(filter)? {
        body.insert("query".to_string(), query);
    }

    body.insert("sort".to_string(), elasticsearch_sort_from_document_sort(sort)?);
    Ok(serde_json::Value::Object(body))
}

fn elasticsearch_query_from_document_filter(filter: Option<&str>) -> Result<Option<serde_json::Value>, String> {
    let Some(filter) = filter.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_str(filter).map_err(|e| format!("Invalid filter JSON: {e}"))?;
    let query = translate_document_filter_value(&value)?;
    Ok(query)
}

fn translate_document_filter_value(value: &serde_json::Value) -> Result<Option<serde_json::Value>, String> {
    let Some(object) = value.as_object() else {
        return Err("Elasticsearch filter must be a JSON object".to_string());
    };
    if object.is_empty() {
        return Ok(None);
    }

    let mut must = Vec::new();
    for (key, value) in object {
        match key.as_str() {
            "$and" => must.extend(translate_logical_filter_array("$and", value)?),
            "$or" => {
                let should = translate_logical_filter_array("$or", value)?;
                if !should.is_empty() {
                    must.push(serde_json::json!({ "bool": { "should": should, "minimum_should_match": 1 } }));
                }
            }
            key if key.starts_with('$') => {
                return Err(format!("Unsupported Elasticsearch filter operator: {key}"));
            }
            field => must.push(translate_field_filter(field, value)?),
        }
    }

    Ok(single_or_bool_filter(must))
}

fn translate_logical_filter_array(operator: &str, value: &serde_json::Value) -> Result<Vec<serde_json::Value>, String> {
    let items = value.as_array().ok_or_else(|| format!("{operator} must be an array"))?;
    let mut queries = Vec::new();
    for item in items {
        if let Some(query) = translate_document_filter_value(item)? {
            queries.push(query);
        }
    }
    Ok(queries)
}

fn translate_field_filter(field: &str, value: &serde_json::Value) -> Result<serde_json::Value, String> {
    let Some(object) = value.as_object() else {
        return Ok(term_or_null_query(field, value));
    };
    if object.keys().any(|key| key.starts_with('$')) {
        return translate_field_operator_filter(field, object);
    }
    Ok(term_or_null_query(field, value))
}

fn translate_field_operator_filter(
    field: &str,
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut must = Vec::new();
    let mut must_not = Vec::new();
    let mut range = serde_json::Map::new();

    for (operator, value) in object {
        match operator.as_str() {
            "$options" => {}
            "$ne" => {
                if value.is_null() {
                    must.push(serde_json::json!({ "exists": { "field": field } }));
                } else {
                    must_not.push(serde_json::json!({ "term": { field: value.clone() } }));
                }
            }
            "$gt" => {
                range.insert("gt".to_string(), value.clone());
            }
            "$gte" => {
                range.insert("gte".to_string(), value.clone());
            }
            "$lt" => {
                range.insert("lt".to_string(), value.clone());
            }
            "$lte" => {
                range.insert("lte".to_string(), value.clone());
            }
            "$regex" => {
                must.push(regex_like_query(field, value, object.get("$options"))?);
            }
            "$not" => {
                let Some(inner) = value.as_object() else {
                    return Err("$not must be a JSON object".to_string());
                };
                if let Some(regex) = inner.get("$regex") {
                    must_not.push(regex_like_query(
                        field,
                        regex,
                        inner.get("$options").or_else(|| object.get("$options")),
                    )?);
                } else {
                    return Err("Unsupported Elasticsearch $not filter".to_string());
                }
            }
            other => return Err(format!("Unsupported Elasticsearch field filter operator: {other}")),
        }
    }

    if !range.is_empty() {
        must.push(serde_json::json!({ "range": { field: serde_json::Value::Object(range) } }));
    }

    match (must.len(), must_not.is_empty()) {
        (1, true) => Ok(must.remove(0)),
        (0, false) => Ok(serde_json::json!({ "bool": { "must_not": must_not } })),
        _ => {
            let mut bool_query = serde_json::Map::new();
            if !must.is_empty() {
                bool_query.insert("must".to_string(), serde_json::Value::Array(must));
            }
            if !must_not.is_empty() {
                bool_query.insert("must_not".to_string(), serde_json::Value::Array(must_not));
            }
            Ok(serde_json::json!({ "bool": bool_query }))
        }
    }
}

fn term_or_null_query(field: &str, value: &serde_json::Value) -> serde_json::Value {
    if value.is_null() {
        serde_json::json!({ "bool": { "must_not": [{ "exists": { "field": field } }] } })
    } else {
        serde_json::json!({ "term": { field: value.clone() } })
    }
}

fn regex_like_query(
    field: &str,
    value: &serde_json::Value,
    options: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let pattern = value.as_str().ok_or_else(|| "$regex must be a string for Elasticsearch filters".to_string())?;
    let case_insensitive = options
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value.chars().any(|ch| ch.eq_ignore_ascii_case(&'i')));
    Ok(serde_json::json!({
        "wildcard": {
            field: {
                "value": wildcard_contains_pattern(pattern),
                "case_insensitive": case_insensitive
            }
        }
    }))
}

fn wildcard_contains_pattern(pattern: &str) -> String {
    if pattern.starts_with('*') || pattern.ends_with('*') {
        pattern.to_string()
    } else {
        format!("*{}*", pattern)
    }
}

fn single_or_bool_filter(mut queries: Vec<serde_json::Value>) -> Option<serde_json::Value> {
    match queries.len() {
        0 => None,
        1 => queries.pop(),
        _ => Some(serde_json::json!({ "bool": { "filter": queries } })),
    }
}

fn elasticsearch_sort_from_document_sort(sort: Option<&str>) -> Result<serde_json::Value, String> {
    let Some(sort) = sort.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(serde_json::json!(["_doc"]));
    };
    let value: serde_json::Value = serde_json::from_str(sort).map_err(|e| format!("Invalid sort JSON: {e}"))?;
    let object = value.as_object().ok_or_else(|| "Elasticsearch sort must be a JSON object".to_string())?;
    if object.is_empty() {
        return Ok(serde_json::json!(["_doc"]));
    }

    let items = object
        .iter()
        .map(|(field, direction)| {
            let order = match direction {
                serde_json::Value::Number(number) if number.as_i64().unwrap_or(1) < 0 => "desc",
                serde_json::Value::String(value) if value.eq_ignore_ascii_case("desc") => "desc",
                _ => "asc",
            };
            serde_json::json!({ field: { "order": order } })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::Value::Array(items))
}

pub async fn insert_document(client: &EsClient, index: &str, doc_json: &str) -> Result<String, String> {
    let doc = elasticsearch_document_body_from_json(doc_json)?;

    let path = elasticsearch_index_path(index, "_doc?refresh=true");
    let resp = client.post(&path).json(&doc).send().await.map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    let result: serde_json::Value = resp.json().await.map_err(|e| format!("Elasticsearch parse error: {e}"))?;
    Ok(result["_id"].as_str().unwrap_or("").to_string())
}

pub async fn update_document(
    client: &EsClient,
    index: &str,
    id: &str,
    doc_json: &str,
    routing: Option<&str>,
) -> Result<u64, String> {
    let (doc, routing) = elasticsearch_document_body_and_routing_from_json(doc_json, routing)?;

    let path = elasticsearch_document_path(index, id, routing.as_deref());
    let resp = client.put(&path).json(&doc).send().await.map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    Ok(1)
}

fn elasticsearch_document_body_from_json(doc_json: &str) -> Result<serde_json::Value, String> {
    elasticsearch_document_body_and_routing_from_json(doc_json, None).map(|(doc, _)| doc)
}

fn elasticsearch_document_body_and_routing_from_json(
    doc_json: &str,
    routing: Option<&str>,
) -> Result<(serde_json::Value, Option<String>), String> {
    let mut doc: serde_json::Value = serde_json::from_str(doc_json).map_err(|e| format!("Invalid JSON: {e}"))?;
    let mut routing = routing.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
    if let serde_json::Value::Object(map) = &mut doc {
        map.remove("_id");
        if routing.is_none() {
            routing = map.get("_routing").and_then(elasticsearch_routing_from_value);
        }
        map.remove("_routing");
    }
    Ok((doc, routing))
}

fn elasticsearch_routing_from_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(value) => {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        _ => None,
    }
}

pub async fn delete_document(client: &EsClient, index: &str, id: &str, routing: Option<&str>) -> Result<u64, String> {
    let path = elasticsearch_document_path(index, id, routing);
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
        // `SELECT *` with clauses our simple parser doesn't cover (WHERE, IN,
        // BETWEEN, LIKE, ...). Translate the SQL to an ES `_search` body
        // ourselves rather than going through ES's `_sql` endpoint — `_sql`
        // refuses several common shapes (LIKE on a `text` field with no
        // `.keyword`, `SELECT *` returning an array field like `host.ip`, ...)
        // that translate cleanly to raw DSL. Adapt first so that hyphenated
        // index names (`aifanfan-python-bot-logs-*`) and `@timestamp`-style
        // identifiers come out as double-quoted identifiers sqlparser will
        // accept.
        let adapted_for_translator = adapt_elasticsearch_sql_query(input);
        match crate::db::elasticsearch_sql::translate_select_star(&adapted_for_translator) {
            Ok(Some(translated)) => {
                return execute_translated_select_star(client, translated, start).await;
            }
            Ok(None) => {}
            Err(message) => return Err(format!("Elasticsearch SQL error: {message}")),
        }

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
    let path = elasticsearch_index_path(&query.index, "_search");
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
    } else if let Some(hits) = body.pointer("/hits/hits").and_then(|v| v.as_array()) {
        // Treat any `_search`-shaped body as the hits result, even when empty —
        // a 0-row match is a valid empty result, not a reason to fall back to
        // the raw-JSON status/response view.
        let mut all_keys = Vec::<String>::new();
        let docs: Vec<serde_json::Map<String, serde_json::Value>> = hits
            .iter()
            .map(|hit| {
                let mut row = serde_json::Map::new();
                if let Some(source) = hit.get("_source").and_then(|s| s.as_object()) {
                    for (k, v) in source {
                        row.insert(k.clone(), v.clone());
                    }
                }
                row.insert("_id".to_string(), hit.get("_id").cloned().unwrap_or(serde_json::Value::Null));
                if let Some(routing) = hit.get("_routing") {
                    row.insert("_routing".to_string(), routing.clone());
                }
                for k in row.keys() {
                    if !all_keys.contains(k) {
                        all_keys.push(k.clone());
                    }
                }
                row
            })
            .collect();
        if all_keys.is_empty() {
            // 0 hits → there's no doc to derive columns from; surface `_id`
            // so the grid at least shows a column header for the empty set.
            all_keys.push("_id".to_string());
        }

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
            column_sortables: vec![],
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
                column_sortables: vec![],
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
                column_sortables: vec![],
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
            column_sortables: vec![],
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

async fn execute_translated_select_star(
    client: &EsClient,
    translated: crate::db::elasticsearch_sql::TranslatedSelectStar,
    start: std::time::Instant,
) -> Result<crate::types::QueryResult, String> {
    let report_index_total = !translated.user_limited;
    let path = elasticsearch_index_path(&translated.index, "_search");
    let resp = client
        .post(&path)
        .json(&translated.body)
        .send()
        .await
        .map_err(|e| format!("Elasticsearch request failed: {e}"))?;
    let status = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await.unwrap_or_else(|_| serde_json::Value::Null);
    let index_total = body.pointer("/hits/total/value").and_then(|v| v.as_u64());

    let mut result = parse_elasticsearch_response(status, body, start)?;
    if report_index_total {
        if let Some(total) = index_total {
            result.affected_rows = total;
        }
    }
    Ok(result)
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
        column_sortables: vec![],
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
        build_find_documents_body, elasticsearch_accept_invalid_certs, elasticsearch_base_url_fallbacks,
        redact_elasticsearch_url, EsClient, SearchResponse,
    };
    use serde_json::json;
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
    fn encodes_elasticsearch_index_path_segments() {
        assert_eq!(super::elasticsearch_index_path("%kuzzle.users", "_search"), "/%25kuzzle.users/_search");
        assert_eq!(super::elasticsearch_index_path("logs-*", "_search"), "/logs-*/_search");
        assert_eq!(super::elasticsearch_index_path("logs/2026", "_mapping"), "/logs%2F2026/_mapping");
    }

    #[test]
    fn encodes_elasticsearch_document_id_path_segment() {
        assert_eq!(super::elasticsearch_path_segment("a%b/c"), "a%25b%2Fc");
    }

    #[test]
    fn builds_elasticsearch_document_path_with_routing() {
        assert_eq!(
            super::elasticsearch_document_path("orders/2026", "a%b/c", Some("tenant/a&b")),
            "/orders%2F2026/_doc/a%25b%2Fc?routing=tenant%2Fa%26b&refresh=true"
        );
        assert_eq!(super::elasticsearch_document_path("orders", "1", None), "/orders/_doc/1?refresh=true");
    }

    #[test]
    fn elasticsearch_sql_detection_does_not_treat_rest_methods_as_sql() {
        assert!(super::is_elasticsearch_sql_query("SELECT * FROM index_task_v1"));
        assert!(super::is_elasticsearch_sql_query(" select count(*) from index_task_v1"));
        assert!(!super::is_elasticsearch_sql_query("GET /index_task_v1/_mapping"));
        assert!(!super::is_elasticsearch_sql_query("POST /index_task_v1/_search\n{}"));
        assert!(!super::is_elasticsearch_sql_query("DELETE /index_task_v1/_doc/1"));
    }

    #[test]
    fn builds_elasticsearch_find_body_with_filter_and_sort() {
        let body = build_find_documents_body(20, 10, Some(r#"{"city":"长治"}"#), Some(r#"{"created_at":-1}"#)).unwrap();

        assert_eq!(
            body,
            json!({
                "from": 20,
                "size": 10,
                "query": { "term": { "city": "长治" } },
                "sort": [{ "created_at": { "order": "desc" } }]
            })
        );
    }

    #[test]
    fn builds_elasticsearch_find_body_with_structured_filter_operators() {
        let body = build_find_documents_body(
            0,
            100,
            Some(
                r#"{
                    "$and": [
                        {"city": {"$ne": "上海"}},
                        {"age": {"$gt": 18, "$lte": 60}},
                        {"name": {"$not": {"$regex": "test", "$options": "i"}}}
                    ]
                }"#,
            ),
            None,
        )
        .unwrap();

        assert_eq!(
            body,
            json!({
                "from": 0,
                "size": 100,
                "query": {
                    "bool": {
                        "filter": [
                            { "bool": { "must_not": [{ "term": { "city": "上海" } }] } },
                            { "range": { "age": { "gt": 18, "lte": 60 } } },
                            {
                                "bool": {
                                    "must_not": [
                                        {
                                            "wildcard": {
                                                "name": {
                                                    "value": "*test*",
                                                    "case_insensitive": true
                                                }
                                            }
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                },
                "sort": ["_doc"]
            })
        );
    }

    #[test]
    fn builds_elasticsearch_find_body_with_or_filter() {
        let body =
            build_find_documents_body(0, 50, Some(r#"{"$or":[{"city":"长治"},{"city":"上海"}]}"#), None).unwrap();

        assert_eq!(
            body["query"],
            json!({
                "bool": {
                    "should": [
                        { "term": { "city": "长治" } },
                        { "term": { "city": "上海" } }
                    ],
                    "minimum_should_match": 1
                }
            })
        );
    }

    #[test]
    fn parses_search_total_from_elasticsearch_6_number_shape() {
        let response: SearchResponse = serde_json::from_value(json!({
            "hits": {
                "total": 5,
                "hits": []
            }
        }))
        .unwrap();

        assert_eq!(response.hits.total.value(), 5);
    }

    #[test]
    fn parses_search_total_from_elasticsearch_7_object_shape() {
        let response: SearchResponse = serde_json::from_value(json!({
            "hits": {
                "total": { "value": 5, "relation": "eq" },
                "hits": []
            }
        }))
        .unwrap();

        assert_eq!(response.hits.total.value(), 5);
    }

    #[test]
    fn parses_elasticsearch_hit_routing_metadata() {
        let response: SearchResponse = serde_json::from_value(json!({
            "hits": {
                "total": { "value": 1, "relation": "eq" },
                "hits": [
                    { "_id": "doc-1", "_routing": "tenant-1", "_source": { "name": "Alice" } }
                ]
            }
        }))
        .unwrap();

        assert_eq!(response.hits.hits[0].routing.as_deref(), Some("tenant-1"));
    }

    #[test]
    fn parses_search_response_rows_with_routing_metadata() {
        let result = super::parse_elasticsearch_response(
            200,
            json!({
                "hits": {
                    "hits": [
                        { "_id": "doc-1", "_routing": "tenant-1", "_source": { "name": "Alice" } }
                    ]
                }
            }),
            std::time::Instant::now(),
        )
        .unwrap();

        let routing_idx = result.columns.iter().position(|column| column == "_routing").unwrap();
        assert_eq!(result.rows[0][routing_idx], json!("tenant-1"));
    }

    #[test]
    fn document_body_removes_elasticsearch_id_metadata() {
        let doc = super::elasticsearch_document_body_from_json(r#"{"_id":"abc","_routing":"tenant-1","name":"Alice"}"#)
            .unwrap();

        assert_eq!(doc, json!({ "name": "Alice" }));
    }

    #[test]
    fn document_body_extracts_elasticsearch_routing_metadata() {
        let (doc, routing) = super::elasticsearch_document_body_and_routing_from_json(
            r#"{"_id":"abc","_routing":"tenant-1","name":"Alice"}"#,
            None,
        )
        .unwrap();

        assert_eq!(doc, json!({ "name": "Alice" }));
        assert_eq!(routing.as_deref(), Some("tenant-1"));
    }

    #[test]
    fn explicit_elasticsearch_routing_overrides_document_metadata() {
        let (doc, routing) = super::elasticsearch_document_body_and_routing_from_json(
            r#"{"_id":"abc","_routing":"tenant-1","name":"Alice"}"#,
            Some("tenant-2"),
        )
        .unwrap();

        assert_eq!(doc, json!({ "name": "Alice" }));
        assert_eq!(routing.as_deref(), Some("tenant-2"));
    }

    #[test]
    fn document_body_preserves_user_field_order() {
        let doc = super::elasticsearch_document_body_from_json(r#"{"z":1,"_id":"abc","a":2}"#).unwrap();

        assert_eq!(serde_json::to_string(&doc).unwrap(), r#"{"z":1,"a":2}"#);
    }
}
