use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::{Client as HttpClient, Method, RequestBuilder, StatusCode};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::{http_client_builder, ColumnInfo};
use crate::db::document_result::DocumentQueryResult;
use crate::types::QueryResult;

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

const INDEX_PAGE_SIZE: u64 = 1_000;
const FIELD_SAMPLE_SIZE: u64 = 100;
const TASK_POLL_INTERVAL: Duration = Duration::from_millis(100);
const TASK_WAIT_TIMEOUT: Duration = Duration::from_secs(60);
const REST_RESPONSE_MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct MeilisearchClient {
    http: HttpClient,
    base_url: String,
    api_key: Option<String>,
    /// Per-index metadata cache so repeat searches stay single-request. Shared
    /// across clones of the pooled client; evicted when the index is deleted.
    index_info_cache: Arc<Mutex<HashMap<String, IndexInfoResponse>>>,
}

impl MeilisearchClient {
    pub fn new(
        url: &str,
        api_key: Option<&str>,
        tls_enabled: bool,
        url_params: Option<&str>,
        timeout: Duration,
    ) -> Result<Self, String> {
        let mut builder = http_client_builder(timeout);
        if meilisearch_accept_invalid_certs(tls_enabled, url_params) {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let http = builder.build().map_err(|error| format!("Meilisearch HTTP client error: {error}"))?;
        let api_key = api_key.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
        Ok(Self {
            http,
            base_url: url.trim_end_matches('/').to_string(),
            api_key,
            index_info_cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn new_for_config(
        url: &str,
        api_key: Option<&str>,
        tls_enabled: bool,
        url_params: Option<&str>,
        external_config: Option<&Value>,
        timeout: Duration,
    ) -> Result<Self, String> {
        let base_url = meilisearch_base_url(url, external_config)?;
        Self::new(&base_url, api_key, tls_enabled, url_params, timeout)
    }

    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        let request = self.http.request(method, format!("{}{}", self.base_url, path));
        match self.api_key.as_deref() {
            Some(api_key) => request.bearer_auth(api_key),
            None => request,
        }
    }

    fn get(&self, path: &str) -> RequestBuilder {
        self.request(Method::GET, path)
    }

    fn post(&self, path: &str) -> RequestBuilder {
        self.request(Method::POST, path)
    }

    fn delete(&self, path: &str) -> RequestBuilder {
        self.request(Method::DELETE, path)
    }
}

fn meilisearch_base_url(url: &str, external_config: Option<&Value>) -> Result<String, String> {
    let url = url.trim_end_matches('/');
    let Some(raw_base_path) = external_config
        .and_then(Value::as_object)
        .and_then(|config| config.get("basePath").or_else(|| config.get("base_path")))
        .and_then(Value::as_str)
    else {
        return Ok(url.to_string());
    };

    let input = raw_base_path.trim();
    if input.is_empty() || input == "/" {
        return Ok(url.to_string());
    }
    if input.contains(['?', '#']) {
        return Err("Meilisearch base path cannot contain a query or fragment".to_string());
    }

    let segments = input.split('/').filter(|segment| !segment.is_empty()).collect::<Vec<_>>();
    if segments.iter().any(|segment| matches!(*segment, "." | "..")) {
        return Err("Meilisearch base path cannot contain '.' or '..' segments".to_string());
    }
    Ok(format!("{url}/{}", segments.join("/")))
}

fn meilisearch_accept_invalid_certs(tls_enabled: bool, url_params: Option<&str>) -> bool {
    tls_enabled
        && url_params.is_some_and(|params| {
            params.trim_start_matches('?').split('&').any(|pair| {
                let (key, value) = pair.split_once('=').unwrap_or((pair, "true"));
                matches!(key.trim().to_ascii_lowercase().as_str(), "insecure" | "tls_insecure" | "accept_invalid_certs")
                    && matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on")
            })
        })
}

fn encode_path_segment(value: &str) -> String {
    utf8_percent_encode(value, PATH_SEGMENT_ENCODE_SET).to_string()
}

async fn response_json(response: reqwest::Response, context: &str) -> Result<Value, String> {
    let status = response.status();
    let body = response.text().await.map_err(|error| format!("Meilisearch response error: {error}"))?;
    if !status.is_success() {
        return Err(meilisearch_error(context, status, &body));
    }
    if body.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&body).map_err(|error| format!("Meilisearch parse error: {error}"))
}

fn meilisearch_error(context: &str, status: StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("message").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| body.trim().to_string());
    if detail.is_empty() {
        format!("Meilisearch {context} failed with HTTP {}", status.as_u16())
    } else {
        format!("Meilisearch {context} failed with HTTP {}: {detail}", status.as_u16())
    }
}

pub async fn test_connection(client: &MeilisearchClient, _timeout: Duration) -> Result<(), String> {
    let health = client.get("/health").send().await.map_err(|error| format!("Meilisearch request failed: {error}"))?;
    response_json(health, "health check").await?;

    let indexes = client
        .get("/indexes?offset=0&limit=1")
        .send()
        .await
        .map_err(|error| format!("Meilisearch request failed: {error}"))?;
    response_json(indexes, "index access check").await?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexInfoResponse {
    uid: String,
    primary_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IndexListResponse {
    results: Vec<IndexInfoResponse>,
    total: u64,
    offset: u64,
    limit: u64,
}

async fn index_info(client: &MeilisearchClient, index: &str) -> Result<IndexInfoResponse, String> {
    if let Some(cached) = client.index_info_cache.lock().unwrap().get(index).cloned() {
        return Ok(cached);
    }
    let response = client
        .get(&format!("/indexes/{}", encode_path_segment(index)))
        .send()
        .await
        .map_err(|error| format!("Meilisearch request failed: {error}"))?;
    let value = response_json(response, "index lookup").await?;
    let info: IndexInfoResponse =
        serde_json::from_value(value).map_err(|error| format!("Meilisearch index parse error: {error}"))?;
    client.index_info_cache.lock().unwrap().insert(index.to_string(), info.clone());
    Ok(info)
}

pub async fn list_indexes(client: &MeilisearchClient) -> Result<Vec<String>, String> {
    let mut offset = 0;
    let mut names = Vec::new();
    loop {
        let response = client
            .get(&format!("/indexes?offset={offset}&limit={INDEX_PAGE_SIZE}"))
            .send()
            .await
            .map_err(|error| format!("Meilisearch request failed: {error}"))?;
        let value = response_json(response, "index listing").await?;
        let page: IndexListResponse =
            serde_json::from_value(value).map_err(|error| format!("Meilisearch index list parse error: {error}"))?;
        names.extend(page.results.into_iter().map(|index| index.uid));
        let next_offset = page.offset.saturating_add(page.limit);
        if next_offset >= page.total || page.limit == 0 {
            break;
        }
        offset = next_offset;
    }
    names.sort();
    names.dedup();
    Ok(names)
}

#[derive(Debug, Deserialize)]
struct DocumentsResponse {
    results: Vec<Value>,
    total: u64,
}

fn meilisearch_fetch_body(
    offset: u64,
    limit: u64,
    filter: Option<&str>,
    sort: Option<&str>,
    primary_key: Option<&str>,
) -> Result<Map<String, Value>, String> {
    let mut body = Map::new();
    body.insert("offset".to_string(), Value::Number(offset.into()));
    body.insert("limit".to_string(), Value::Number(limit.into()));
    body.insert("fields".to_string(), Value::Array(vec![Value::String("*".to_string())]));
    if let Some(filter) = meilisearch_filter_from_request(filter, primary_key)? {
        body.insert("filter".to_string(), filter);
    }
    if let Some(sort) = meilisearch_sort_from_request(sort, primary_key)? {
        body.insert("sort".to_string(), Value::Array(sort.into_iter().map(Value::String).collect()));
    }
    Ok(body)
}

async fn fetch_documents_value(
    client: &MeilisearchClient,
    index: &str,
    offset: u64,
    limit: u64,
    filter: Option<&str>,
    sort: Option<&str>,
) -> Result<(DocumentsResponse, Option<String>), String> {
    let index_info = index_info(client, index).await?;
    let body = meilisearch_fetch_body(offset, limit, filter, sort, index_info.primary_key.as_deref())?;

    let response = client
        .post(&format!("/indexes/{}/documents/fetch", encode_path_segment(&index_info.uid)))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Meilisearch request failed: {error}"))?;
    let value = response_json(response, "document fetch").await?;
    let documents =
        serde_json::from_value(value).map_err(|error| format!("Meilisearch document parse error: {error}"))?;
    Ok((documents, index_info.primary_key))
}

pub async fn find_documents(
    client: &MeilisearchClient,
    index: &str,
    skip: u64,
    limit: i64,
    filter: Option<&str>,
    sort: Option<&str>,
) -> Result<DocumentQueryResult, String> {
    let limit = u64::try_from(limit.max(0)).unwrap_or(0);
    let (result, primary_key) = fetch_documents_value(client, index, skip, limit, filter, sort).await?;
    let documents = result
        .results
        .into_iter()
        .map(|document| inject_document_identity(document, primary_key.as_deref()))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(DocumentQueryResult {
        documents,
        raw_documents: None,
        extended_documents: None,
        total: result.total,
        total_is_exact: true,
        next_cursor: None,
    })
}

pub async fn fetch_document_page(
    client: &MeilisearchClient,
    index: &str,
    offset: u64,
    limit: u64,
    filter: Option<&str>,
    sort: Option<&str>,
) -> Result<MeilisearchDocumentPage, String> {
    let (result, _) = fetch_documents_value(client, index, offset, limit, filter, sort).await?;
    Ok(MeilisearchDocumentPage {
        documents_json: result.results.into_iter().map(|document| document.to_string()).collect(),
        total: result.total,
    })
}

pub async fn get_columns(client: &MeilisearchClient, index: &str) -> Result<Vec<ColumnInfo>, String> {
    let (result, primary_key) = fetch_documents_value(client, index, 0, FIELD_SAMPLE_SIZE, None, None).await?;
    let mut fields = BTreeMap::<String, FieldType>::new();
    for document in result.results {
        collect_field_types("", &document, &mut fields);
    }
    if let Some(primary_key) = primary_key.as_deref() {
        fields.entry(primary_key.to_string()).or_insert(FieldType::Unknown);
    }
    Ok(fields
        .into_iter()
        .map(|(name, field_type)| ColumnInfo {
            is_primary_key: primary_key.as_deref() == Some(name.as_str()),
            name,
            data_type: field_type.label().to_string(),
            resolved_schema: None,
            is_nullable: true,
            column_default: None,
            is_unique: false,
            extra: None,
            comment: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            character_set: None,
            collation: None,
        })
        .collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldType {
    Unknown,
    Null,
    Boolean,
    Number,
    String,
    Object,
    Array,
    Mixed,
}

impl FieldType {
    fn from_value(value: &Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(_) => Self::Boolean,
            Value::Number(_) => Self::Number,
            Value::String(_) => Self::String,
            Value::Array(_) => Self::Array,
            Value::Object(_) => Self::Object,
        }
    }

    fn merge(self, other: Self) -> Self {
        match (self, other) {
            (Self::Unknown | Self::Null, value) | (value, Self::Unknown | Self::Null) => value,
            (left, right) if left == right => left,
            _ => Self::Mixed,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Unknown => "dynamic",
            Self::Null => "null",
            Self::Boolean => "boolean",
            Self::Number => "number",
            Self::String => "string",
            Self::Object => "object",
            Self::Array => "array",
            Self::Mixed => "mixed",
        }
    }
}

fn collect_field_types(prefix: &str, value: &Value, fields: &mut BTreeMap<String, FieldType>) {
    let Value::Object(map) = value else {
        return;
    };
    for (name, value) in map {
        let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}.{name}") };
        let field_type = FieldType::from_value(value);
        fields.entry(path.clone()).and_modify(|current| *current = current.merge(field_type)).or_insert(field_type);
        if value.is_object() {
            collect_field_types(&path, value, fields);
        }
    }
}

fn inject_document_identity(document: Value, primary_key: Option<&str>) -> Result<Value, String> {
    let mut document =
        document.as_object().cloned().ok_or_else(|| "Meilisearch returned a non-object document".to_string())?;
    if let Some(primary_key) = primary_key {
        if let Some(id) = document.remove(primary_key) {
            document.insert("_id".to_string(), id);
        }
    }
    Ok(Value::Object(document))
}

fn search_hit(hit: Value, primary_key: Option<&str>, highlight: bool, ranking_score: bool) -> MeilisearchSearchHit {
    let id_json = primary_key.and_then(|primary_key| hit.get(primary_key)).map(Value::to_string);
    let mut document = hit;
    let mut formatted = None;
    let mut ranking = None;
    if let Some(object) = document.as_object_mut() {
        // Hoist response metadata only when the request asked for it; without
        // the flag a same-named key is a legitimate user field and stays put.
        if highlight {
            formatted = object.remove("_formatted");
        }
        if ranking_score {
            ranking = object.remove("_rankingScore");
        }
    }
    MeilisearchSearchHit {
        id_json,
        document_json: document.to_string(),
        formatted_json: formatted.map(|value| value.to_string()),
        ranking_score_json: ranking.map(|value| value.to_string()),
    }
}

fn parse_document_object(doc_json: &str) -> Result<Map<String, Value>, String> {
    let value: Value =
        serde_json::from_str(doc_json).map_err(|error| format!("Invalid Meilisearch document JSON: {error}"))?;
    value.as_object().cloned().ok_or_else(|| "Meilisearch document must be a JSON object".to_string())
}

const STRING_ID_PREFIX: &str = "__dbx_meilisearch_string_id__";

fn decoded_identity(id: &str) -> Value {
    if let Some(encoded) = id.strip_prefix(STRING_ID_PREFIX) {
        if let Ok(Value::String(value)) = serde_json::from_str::<Value>(encoded) {
            return Value::String(value);
        }
    }
    match serde_json::from_str::<Value>(id) {
        Ok(value @ (Value::String(_) | Value::Number(_))) => value,
        _ => Value::String(id.to_string()),
    }
}

fn identity_path(id: &str) -> String {
    value_to_id(&decoded_identity(id))
}

async fn submit_documents(
    client: &MeilisearchClient,
    index: &str,
    method: Method,
    documents: Vec<Value>,
) -> Result<(), String> {
    let response = client
        .request(method, &format!("/indexes/{}/documents", encode_path_segment(index)))
        .json(&documents)
        .send()
        .await
        .map_err(|error| format!("Meilisearch request failed: {error}"))?;
    let task = task_from_response(response, "document write").await?;
    wait_for_task(client, task.task_uid).await
}

pub async fn insert_document(client: &MeilisearchClient, index: &str, doc_json: &str) -> Result<String, String> {
    let index_info = index_info(client, index).await?;
    let mut document = parse_document_object(doc_json)?;
    let metadata_id = document.remove("_id");
    if let (Some(primary_key), Some(id)) = (index_info.primary_key.as_deref(), metadata_id) {
        document.insert(primary_key.to_string(), id);
    }
    submit_documents(client, index, Method::POST, vec![Value::Object(document.clone())]).await?;
    Ok(index_info
        .primary_key
        .and_then(|name| document.get(&name).cloned())
        .map(|value| value_to_id(&value))
        .unwrap_or_default())
}

pub async fn update_document(client: &MeilisearchClient, index: &str, id: &str, doc_json: &str) -> Result<u64, String> {
    let index_info = index_info(client, index).await?;
    let primary_key =
        index_info.primary_key.ok_or_else(|| format!("Meilisearch index '{}' has no primary key", index_info.uid))?;
    let mut document = parse_document_object(doc_json)?;
    // `_id` is only the dbx browse alias when it matches the target identity; a
    // genuine user field with a different value must survive the update.
    let is_identity_alias =
        document.get("_id").map(|value| value_to_id(value) == value_to_id(&decoded_identity(id))).unwrap_or(false);
    if is_identity_alias {
        document.remove("_id");
    }
    document.insert(primary_key, decoded_identity(id));
    // Meilisearch uses POST for full replacement and PUT for partial updates.
    // DBX sends the complete edited document so removed fields must disappear.
    submit_documents(client, index, Method::POST, vec![Value::Object(document)]).await?;
    Ok(1)
}

/// Fetch the canonical stored document by identity. Search hits may be shaped
/// by `displayedAttributes` and search options, so edits must round-trip
/// through this record instead of a hit payload.
pub async fn get_document(client: &MeilisearchClient, index: &str, id: &str) -> Result<String, String> {
    let response = client
        .get(&format!(
            "/indexes/{}/documents/{}?fields=*",
            encode_path_segment(index),
            encode_path_segment(&identity_path(id))
        ))
        .send()
        .await
        .map_err(|error| format!("Meilisearch request failed: {error}"))?;
    let document = response_json(response, "document lookup").await?;
    if !document.is_object() {
        return Err("Meilisearch returned a non-object document".to_string());
    }
    Ok(document.to_string())
}

pub async fn delete_document(client: &MeilisearchClient, index: &str, id: &str) -> Result<u64, String> {
    let response = client
        .delete(&format!(
            "/indexes/{}/documents/{}",
            encode_path_segment(index),
            encode_path_segment(&identity_path(id))
        ))
        .send()
        .await
        .map_err(|error| format!("Meilisearch request failed: {error}"))?;
    let task = task_from_response(response, "document deletion").await?;
    wait_for_task(client, task.task_uid).await?;
    Ok(1)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchDocumentUpdate {
    pub id: String,
    pub doc_json: String,
}

pub async fn save_document_batch(
    client: &MeilisearchClient,
    index: &str,
    updates: &[MeilisearchDocumentUpdate],
    delete_ids: &[String],
    inserts: &[String],
) -> Result<u64, String> {
    let index_info =
        if updates.is_empty() && inserts.is_empty() { None } else { Some(index_info(client, index).await?) };

    if !updates.is_empty() {
        let index_info = index_info.as_ref().expect("index info is loaded for document writes");
        let primary_key = index_info
            .primary_key
            .as_deref()
            .ok_or_else(|| format!("Meilisearch index '{}' has no primary key", index_info.uid))?;
        let documents = updates
            .iter()
            .map(|update| {
                let mut document = parse_document_object(&update.doc_json)?;
                document.remove("_id");
                document.insert(primary_key.to_string(), decoded_identity(&update.id));
                Ok(Value::Object(document))
            })
            .collect::<Result<Vec<_>, String>>()?;
        submit_documents(client, index, Method::POST, documents).await?;
    }

    if !delete_ids.is_empty() {
        let ids = delete_ids.iter().map(|id| decoded_identity(id)).collect::<Vec<_>>();
        let response = client
            .post(&format!("/indexes/{}/documents/delete-batch", encode_path_segment(index)))
            .json(&ids)
            .send()
            .await
            .map_err(|error| format!("Meilisearch request failed: {error}"))?;
        let task = task_from_response(response, "document batch deletion").await?;
        wait_for_task(client, task.task_uid).await?;
    }

    if !inserts.is_empty() {
        let index_info = index_info.as_ref().expect("index info is loaded for document writes");
        let documents = inserts
            .iter()
            .map(|doc_json| {
                let mut document = parse_document_object(doc_json)?;
                let metadata_id = document.remove("_id");
                if let (Some(primary_key), Some(id)) = (index_info.primary_key.as_deref(), metadata_id) {
                    document.insert(primary_key.to_string(), id);
                }
                Ok(Value::Object(document))
            })
            .collect::<Result<Vec<_>, String>>()?;
        submit_documents(client, index, Method::POST, documents).await?;
    }

    Ok((updates.len() + delete_ids.len() + inserts.len()) as u64)
}

fn value_to_id(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        _ => value.to_string(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskSummary {
    task_uid: u64,
}

#[derive(Debug, Deserialize)]
struct TaskStatus {
    status: String,
    error: Option<Value>,
}

async fn task_from_response(response: reqwest::Response, context: &str) -> Result<TaskSummary, String> {
    let value = response_json(response, context).await?;
    serde_json::from_value(value).map_err(|error| format!("Meilisearch task parse error: {error}"))
}

async fn wait_for_task(client: &MeilisearchClient, task_uid: u64) -> Result<(), String> {
    let deadline = Instant::now() + TASK_WAIT_TIMEOUT;
    loop {
        let response = client
            .get(&format!("/tasks/{task_uid}"))
            .send()
            .await
            .map_err(|error| format!("Meilisearch task request failed: {error}"))?;
        let value = response_json(response, "task lookup").await?;
        let task: TaskStatus =
            serde_json::from_value(value).map_err(|error| format!("Meilisearch task parse error: {error}"))?;
        match task.status.as_str() {
            "succeeded" => return Ok(()),
            "failed" | "canceled" => {
                let detail = task.error.map(|error| error.to_string()).unwrap_or_else(|| task.status.clone());
                return Err(format!("Meilisearch task {task_uid} {}: {detail}", task.status));
            }
            _ if Instant::now() >= deadline => {
                return Err(format!("Meilisearch task {task_uid} did not finish within 60 seconds"));
            }
            _ => tokio::time::sleep(TASK_POLL_INTERVAL).await,
        }
    }
}

fn meilisearch_filter_from_request(filter: Option<&str>, primary_key: Option<&str>) -> Result<Option<Value>, String> {
    let Some(filter) = filter.map(str::trim).filter(|value| !value.is_empty() && *value != "{}") else {
        return Ok(None);
    };
    // Native Meilisearch filter syntax (e.g. `status = "published" AND rating >= 8`)
    // is passed through; the server validates it. Same trust level as `$meiliFilter`.
    if !filter.starts_with('{') && !filter.starts_with('[') {
        return Ok(Some(Value::String(filter.to_string())));
    }
    let value: Value =
        serde_json::from_str(filter).map_err(|error| format!("Invalid Meilisearch filter JSON: {error}"))?;
    // Native filter arrays (e.g. [["rating > 3"], "status = \"published\""]) are
    // passed through unchanged; the official search API accepts string or array.
    if value.is_array() {
        return Ok(Some(value));
    }
    if let Some(raw) = value.get("$meiliFilter").and_then(Value::as_str) {
        return Ok(Some(Value::String(raw.to_string())));
    }
    filter_expression(&value, primary_key).map(|expression| Some(Value::String(expression)))
}

fn filter_expression(value: &Value, primary_key: Option<&str>) -> Result<String, String> {
    let object = value.as_object().ok_or_else(|| "Meilisearch filter must be a JSON object".to_string())?;
    let mut expressions = Vec::new();
    for (field, condition) in object {
        match field.as_str() {
            "$and" | "$or" => {
                let values =
                    condition.as_array().ok_or_else(|| format!("Meilisearch {field} filter must be an array"))?;
                let operator = if field == "$and" { " AND " } else { " OR " };
                let nested = values
                    .iter()
                    .map(|value| filter_expression(value, primary_key))
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .map(|expression| format!("({expression})"))
                    .collect::<Vec<_>>()
                    .join(operator);
                if !nested.is_empty() {
                    expressions.push(nested);
                }
            }
            "$meiliFilter" => {
                let raw = condition.as_str().ok_or_else(|| "$meiliFilter must be a string".to_string())?;
                if !raw.trim().is_empty() {
                    expressions.push(raw.trim().to_string());
                }
            }
            _ => expressions.push(field_filter_expression(field, condition, primary_key)?),
        }
    }
    if expressions.is_empty() {
        return Err("Meilisearch filter is empty".to_string());
    }
    Ok(expressions.into_iter().map(|expression| format!("({expression})")).collect::<Vec<_>>().join(" AND "))
}

fn field_filter_expression(field: &str, condition: &Value, primary_key: Option<&str>) -> Result<String, String> {
    let field = if field == "_id" { primary_key.unwrap_or(field) } else { field };
    validate_filter_field(field)?;
    let Some(operators) = condition.as_object().filter(|value| value.keys().any(|key| key.starts_with('$'))) else {
        return Ok(if condition.is_null() {
            format!("{field} IS NULL")
        } else {
            format!("{field} = {}", filter_value(condition)?)
        });
    };

    let mut expressions = Vec::new();
    for (operator, value) in operators {
        match operator.as_str() {
            "$options" => {}
            "$ne" if value.is_null() => expressions.push(format!("NOT {field} IS NULL")),
            "$ne" => expressions.push(format!("{field} != {}", filter_value(value)?)),
            "$gt" => expressions.push(format!("{field} > {}", filter_value(value)?)),
            "$gte" => expressions.push(format!("{field} >= {}", filter_value(value)?)),
            "$lt" => expressions.push(format!("{field} < {}", filter_value(value)?)),
            "$lte" => expressions.push(format!("{field} <= {}", filter_value(value)?)),
            "$regex" | "$not" => {
                return Err(format!(
                    "Meilisearch contains filters require an experimental server feature; use a raw $meiliFilter only when the target server enables it (field '{field}')"
                ));
            }
            _ => return Err(format!("Unsupported Meilisearch filter operator for field '{field}': {operator}")),
        }
    }
    if expressions.is_empty() {
        return Err(format!("Meilisearch filter for field '{field}' is empty"));
    }
    Ok(expressions.into_iter().map(|expression| format!("({expression})")).collect::<Vec<_>>().join(" AND "))
}

fn validate_filter_field(field: &str) -> Result<(), String> {
    if !field.is_empty()
        && field.split('.').all(|part| {
            !part.is_empty() && part.chars().all(|character| character.is_alphanumeric() || character == '_')
        })
    {
        return Ok(());
    }
    Err(format!("Unsupported Meilisearch filter field: {field}"))
}

fn filter_value(value: &Value) -> Result<String, String> {
    match value {
        Value::String(_) | Value::Number(_) | Value::Bool(_) => Ok(value.to_string()),
        _ => Err("Meilisearch filter values must be strings, numbers, booleans, or null".to_string()),
    }
}

fn meilisearch_sort_from_request(sort: Option<&str>, primary_key: Option<&str>) -> Result<Option<Vec<String>>, String> {
    let Some(sort) = sort.map(str::trim).filter(|value| !value.is_empty() && *value != "{}") else {
        return Ok(None);
    };

    fn sort_field<'a>(field: &'a str, primary_key: Option<&'a str>) -> Result<&'a str, String> {
        let field = if field == "_id" { primary_key.unwrap_or(field) } else { field };
        validate_filter_field(field)?;
        Ok(field)
    }

    // The generic document browser sends a JSON object like {"rating":-1}.
    if sort.starts_with('{') || sort.starts_with('[') {
        let value: Value =
            serde_json::from_str(sort).map_err(|error| format!("Invalid Meilisearch sort JSON: {error}"))?;
        let object = value.as_object().ok_or_else(|| "Meilisearch sort must be a JSON object".to_string())?;
        let mut result = Vec::new();
        for (field, direction) in object {
            let field = sort_field(field, primary_key)?;
            let direction = match direction {
                Value::Number(number) if number.as_i64().unwrap_or(1) < 0 => "desc",
                Value::String(value) if value.eq_ignore_ascii_case("desc") => "desc",
                _ => "asc",
            };
            result.push(format!("{field}:{direction}"));
        }
        return Ok((!result.is_empty()).then_some(result));
    }

    // Native Meilisearch syntax: comma-separated `field:asc|desc` entries, bare field means asc.
    let mut result = Vec::new();
    for entry in sort.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let (field, direction) = match entry.split_once(':') {
            Some((field, direction)) => (field.trim(), direction.trim()),
            None => (entry, "asc"),
        };
        let field = sort_field(field, primary_key)?;
        let direction = match direction.to_ascii_lowercase().as_str() {
            "asc" => "asc",
            "desc" => "desc",
            _ => return Err(format!("Unsupported Meilisearch sort direction: {direction}")),
        };
        result.push(format!("{field}:{direction}"));
    }
    Ok((!result.is_empty()).then_some(result))
}

/// Search hit with dbx identity and Meilisearch response metadata kept outside
/// the document payload: `document` is always the pure user payload, so a real
/// `_id` / `_formatted` / `_rankingScore` field in the stored document is never
/// shadowed or stripped. `formatted` / `rankingScore` are hoisted only when the
/// request actually asked for them.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchSearchHit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_json: Option<String>,
    pub document_json: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formatted_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ranking_score_json: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchSearchResult {
    pub hits: Vec<MeilisearchSearchHit>,
    pub total_hits: u64,
    pub processing_time_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchDocumentPage {
    pub documents_json: Vec<String>,
    pub total: u64,
}

#[derive(Debug, Clone)]
pub struct MeilisearchHybrid {
    pub embedder: String,
    pub semantic_ratio: f64,
}

fn meilisearch_search_body(
    q: Option<&str>,
    offset: u64,
    limit: u64,
    filter: Option<&str>,
    sort: Option<&str>,
    primary_key: Option<&str>,
    hybrid: Option<&MeilisearchHybrid>,
    show_ranking_score: bool,
    ranking_score_threshold: Option<f64>,
) -> Result<Map<String, Value>, String> {
    let mut body = Map::new();
    let q = q.map(str::trim).filter(|value| !value.is_empty());
    if let Some(q) = q {
        body.insert("q".to_string(), Value::String(q.to_string()));
    }
    body.insert("offset".to_string(), Value::Number(offset.into()));
    body.insert("limit".to_string(), Value::Number(limit.into()));
    if let Some(filter) = meilisearch_filter_from_request(filter, primary_key)? {
        body.insert("filter".to_string(), filter);
    }
    if let Some(sort) = meilisearch_sort_from_request(sort, primary_key)? {
        body.insert("sort".to_string(), Value::Array(sort.into_iter().map(Value::String).collect()));
    }
    if let Some(hybrid) = hybrid {
        let embedder = hybrid.embedder.trim();
        if embedder.is_empty() {
            return Err("Meilisearch hybrid search requires an embedder name".to_string());
        }
        let semantic_ratio =
            if hybrid.semantic_ratio.is_finite() { hybrid.semantic_ratio.clamp(0.0, 1.0) } else { 0.5 };
        let ratio =
            serde_json::Number::from_f64(semantic_ratio).ok_or_else(|| "Invalid hybrid semantic ratio".to_string())?;
        let mut hybrid_body = Map::new();
        hybrid_body.insert("embedder".to_string(), Value::String(embedder.to_string()));
        hybrid_body.insert("semanticRatio".to_string(), Value::Number(ratio));
        body.insert("hybrid".to_string(), Value::Object(hybrid_body));
    }
    if show_ranking_score {
        body.insert("showRankingScore".to_string(), Value::Bool(true));
    }
    if let Some(threshold) = ranking_score_threshold.filter(|value| value.is_finite() && *value > 0.0) {
        let threshold = serde_json::Number::from_f64(threshold.clamp(0.0, 1.0))
            .ok_or_else(|| "Invalid ranking score threshold".to_string())?;
        body.insert("rankingScoreThreshold".to_string(), Value::Number(threshold));
    }
    // Highlighting is only meaningful with a query term; asking for `_formatted`
    // on every search would double the response payload for plain browsing.
    if q.is_some() {
        body.insert("attributesToHighlight".to_string(), Value::Array(vec![Value::String("*".to_string())]));
        body.insert("highlightPreTag".to_string(), Value::String("<mark>".to_string()));
        body.insert("highlightPostTag".to_string(), Value::String("</mark>".to_string()));
    }
    Ok(body)
}

fn parse_meilisearch_search_response(
    value: Value,
    primary_key: Option<&str>,
    highlight: bool,
    ranking_score: bool,
) -> Result<MeilisearchSearchResult, String> {
    let hits = value
        .get("hits")
        .cloned()
        .unwrap_or(Value::Null)
        .as_array()
        .cloned()
        .ok_or_else(|| "Meilisearch search response 'hits' must be an array".to_string())?;
    let total_hits = value
        .get("estimatedTotalHits")
        .or_else(|| value.get("totalHits"))
        .and_then(Value::as_u64)
        .ok_or_else(|| "Meilisearch search response is missing a hit total".to_string())?;
    let processing_time_ms = value.get("processingTimeMs").and_then(Value::as_u64).unwrap_or(0);
    let hits = hits.into_iter().map(|hit| search_hit(hit, primary_key, highlight, ranking_score)).collect();
    Ok(MeilisearchSearchResult { hits, total_hits, processing_time_ms })
}

pub async fn execute_rest_query(client: &MeilisearchClient, input: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let input = input.trim();
    if input.is_empty() {
        return Err("Meilisearch REST request is empty".to_string());
    }
    let (request_line, body) = input.split_once('\n').map_or((input, ""), |(line, body)| (line.trim(), body.trim()));
    let (method, path) = parse_rest_request_line(request_line)?;
    let mut request = client.request(method, &path);
    if !body.is_empty() {
        let body: Value =
            serde_json::from_str(body).map_err(|error| format!("Invalid Meilisearch REST JSON body: {error}"))?;
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|error| format!("Meilisearch request failed: {error}"))?;
    let status = response.status().as_u16();
    let (body, truncated) = read_bounded_rest_response(response).await?;
    Ok(raw_response_result(status, body, start, truncated))
}

#[allow(clippy::too_many_arguments)]
pub async fn search_documents(
    client: &MeilisearchClient,
    index: &str,
    q: Option<&str>,
    filter: Option<&str>,
    sort: Option<&str>,
    limit: u64,
    offset: u64,
    hybrid: Option<&MeilisearchHybrid>,
    show_ranking_score: bool,
    ranking_score_threshold: Option<f64>,
) -> Result<MeilisearchSearchResult, String> {
    let index_info = index_info(client, index).await?;
    let body = meilisearch_search_body(
        q,
        offset,
        limit,
        filter,
        sort,
        index_info.primary_key.as_deref(),
        hybrid,
        show_ranking_score,
        ranking_score_threshold,
    )?;
    let response = client
        .post(&format!("/indexes/{}/search", encode_path_segment(&index_info.uid)))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Meilisearch request failed: {error}"))?;
    let value = response_json(response, "document search").await?;
    let highlight = q.map(str::trim).is_some_and(|value| !value.is_empty());
    parse_meilisearch_search_response(value, index_info.primary_key.as_deref(), highlight, show_ranking_score)
}

pub async fn get_index_settings(client: &MeilisearchClient, index: &str) -> Result<Value, String> {
    let response = client
        .get(&format!("/indexes/{}/settings", encode_path_segment(index)))
        .send()
        .await
        .map_err(|error| format!("Meilisearch request failed: {error}"))?;
    response_json(response, "index settings lookup").await
}

pub async fn update_index_settings(client: &MeilisearchClient, index: &str, settings: &Value) -> Result<(), String> {
    let response = client
        .request(Method::PATCH, &format!("/indexes/{}/settings", encode_path_segment(index)))
        .json(settings)
        .send()
        .await
        .map_err(|error| format!("Meilisearch request failed: {error}"))?;
    let task = task_from_response(response, "index settings update").await?;
    wait_for_task(client, task.task_uid).await
}

pub async fn get_index_stats(client: &MeilisearchClient, index: &str) -> Result<Value, String> {
    let response = client
        .get(&format!("/indexes/{}/stats", encode_path_segment(index)))
        .send()
        .await
        .map_err(|error| format!("Meilisearch request failed: {error}"))?;
    response_json(response, "index stats lookup").await
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchIndexOverview {
    pub uid: String,
    pub primary_key: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub number_of_documents: u64,
    pub is_indexing: bool,
    /// Instance-wide database size in bytes; `None` when the API key cannot read instance stats.
    pub database_size: Option<u64>,
}

pub async fn get_index_overview(client: &MeilisearchClient, index: &str) -> Result<MeilisearchIndexOverview, String> {
    let info = response_json(
        client
            .get(&format!("/indexes/{}", encode_path_segment(index)))
            .send()
            .await
            .map_err(|error| format!("Meilisearch request failed: {error}"))?,
        "index lookup",
    )
    .await?;
    let stats = get_index_stats(client, index).await?;
    // Instance stats require broader key permissions, so keep them best-effort.
    let database_size = match client.get("/stats").send().await {
        Ok(response) => response_json(response, "instance stats lookup")
            .await
            .ok()
            .and_then(|value| value.get("databaseSize").and_then(Value::as_u64)),
        Err(_) => None,
    };
    Ok(MeilisearchIndexOverview {
        uid: info.get("uid").and_then(Value::as_str).unwrap_or(index).to_string(),
        primary_key: info.get("primaryKey").and_then(Value::as_str).map(str::to_string),
        created_at: info.get("createdAt").and_then(Value::as_str).map(str::to_string),
        updated_at: info.get("updatedAt").and_then(Value::as_str).map(str::to_string),
        number_of_documents: stats.get("numberOfDocuments").and_then(Value::as_u64).unwrap_or(0),
        is_indexing: stats.get("isIndexing").and_then(Value::as_bool).unwrap_or(false),
        database_size,
    })
}

pub async fn delete_index(client: &MeilisearchClient, index: &str) -> Result<(), String> {
    let response = client
        .delete(&format!("/indexes/{}", encode_path_segment(index)))
        .send()
        .await
        .map_err(|error| format!("Meilisearch request failed: {error}"))?;
    let task = task_from_response(response, "index deletion").await?;
    wait_for_task(client, task.task_uid).await?;
    client.index_info_cache.lock().unwrap().remove(index);
    Ok(())
}

pub async fn delete_all_documents(client: &MeilisearchClient, index: &str) -> Result<(), String> {
    let response = client
        .delete(&format!("/indexes/{}/documents", encode_path_segment(index)))
        .send()
        .await
        .map_err(|error| format!("Meilisearch request failed: {error}"))?;
    let task = task_from_response(response, "document deletion").await?;
    wait_for_task(client, task.task_uid).await
}

async fn read_bounded_rest_response(mut response: reqwest::Response) -> Result<(String, bool), String> {
    let read_limit = REST_RESPONSE_MAX_BYTES.saturating_add(1);
    let capacity = response.content_length().unwrap_or(0).min(read_limit as u64) as usize;
    let mut body = Vec::with_capacity(capacity);
    let mut truncated = response.content_length().is_some_and(|length| length > REST_RESPONSE_MAX_BYTES as u64);
    while body.len() < read_limit {
        let Some(chunk) = response.chunk().await.map_err(|error| format!("Meilisearch response error: {error}"))?
        else {
            break;
        };
        let remaining = read_limit.saturating_sub(body.len());
        if chunk.len() > remaining {
            body.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        body.extend_from_slice(&chunk);
        if body.len() > REST_RESPONSE_MAX_BYTES {
            truncated = true;
            break;
        }
    }
    Ok((decode_bounded_rest_body(&body), truncated))
}

fn decode_bounded_rest_body(body: &[u8]) -> String {
    let body = &body[..body.len().min(REST_RESPONSE_MAX_BYTES)];
    match std::str::from_utf8(body) {
        Ok(text) => text.to_string(),
        Err(error) if error.error_len().is_none() => String::from_utf8_lossy(&body[..error.valid_up_to()]).into_owned(),
        Err(_) => String::from_utf8_lossy(body).into_owned(),
    }
}

fn parse_rest_request_line(line: &str) -> Result<(Method, String), String> {
    let mut parts = line.split_whitespace();
    let first = parts.next().ok_or_else(|| "Meilisearch REST request is empty".to_string())?;
    let (method, path) = if let Some(path) = parts.next() {
        let method = Method::from_bytes(first.as_bytes()).map_err(|_| format!("Unsupported HTTP method: {first}"))?;
        if !matches!(method, Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE | Method::HEAD) {
            return Err(format!("Unsupported Meilisearch HTTP method: {first}"));
        }
        (method, path)
    } else {
        (Method::GET, first)
    };
    if parts.next().is_some() {
        return Err("Meilisearch REST request line must be 'METHOD /path'".to_string());
    }
    if !path.starts_with('/') {
        return Err("Meilisearch REST path must start with '/'".to_string());
    }
    if path.contains('#') {
        return Err("Meilisearch REST path must not contain a fragment".to_string());
    }
    let raw_path = path.split_once('?').map_or(path, |(path, _)| path);
    for segment in raw_path.split('/') {
        let decoded = percent_decode_str(segment)
            .decode_utf8()
            .map_err(|_| "Meilisearch REST path contains invalid UTF-8 escaping".to_string())?;
        if matches!(decoded.as_ref(), "." | "..") || decoded.contains(['/', '\\']) {
            return Err("Meilisearch REST path cannot contain traversal segments".to_string());
        }
    }
    Ok((method, path.to_string()))
}

fn raw_response_result(status: u16, body: String, start: Instant, truncated: bool) -> QueryResult {
    let body = if body.trim().is_empty() {
        "null".to_string()
    } else if let Ok(value) = serde_json::from_str::<Value>(&body) {
        serde_json::to_string_pretty(&value).unwrap_or(body)
    } else {
        body
    };
    QueryResult {
        columns: vec!["status".to_string(), "response".to_string()],
        column_types: Vec::new(),
        column_sortables: Vec::new(),
        spatial_columns: Vec::new(),
        spatial_values: Vec::new(),
        rows: vec![vec![Value::Number(status.into()), Value::String(body)]],
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_bounded_rest_body, decoded_identity, filter_expression, identity_path, meilisearch_base_url,
        meilisearch_filter_from_request, meilisearch_search_body, meilisearch_sort_from_request,
        parse_meilisearch_search_response, parse_rest_request_line, MeilisearchClient,
    };
    use reqwest::Method;
    use serde_json::{json, Value};
    use std::time::Duration;

    #[test]
    fn normalizes_canonical_and_legacy_proxy_base_paths() {
        assert_eq!(
            meilisearch_base_url("http://search.example.com:7700/", Some(&json!({ "basePath": "/gateway/meili/" })))
                .unwrap(),
            "http://search.example.com:7700/gateway/meili"
        );
        assert_eq!(
            meilisearch_base_url("https://search.example.com", Some(&json!({ "base_path": "gateway//meili" })))
                .unwrap(),
            "https://search.example.com/gateway/meili"
        );
    }

    #[test]
    fn keeps_the_origin_unchanged_for_empty_proxy_base_paths() {
        for external_config in
            [None, Some(json!({})), Some(json!({ "basePath": "" })), Some(json!({ "basePath": "/" }))]
        {
            assert_eq!(
                meilisearch_base_url("http://search.example.com:7700/", external_config.as_ref()).unwrap(),
                "http://search.example.com:7700"
            );
        }
    }

    #[test]
    fn config_aware_client_uses_proxy_base_path() {
        let client = MeilisearchClient::new_for_config(
            "https://search.example.com:8443/",
            None,
            true,
            None,
            Some(&json!({ "basePath": "/gateway/meili/" })),
            Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(client.base_url, "https://search.example.com:8443/gateway/meili");
    }
    #[test]
    fn translates_document_filters_to_meilisearch_syntax() {
        let filter = serde_json::json!({
            "$and": [
                { "status": "published" },
                { "rating": { "$gte": 8 } }
            ]
        });
        let expression = filter_expression(&filter, Some("id")).unwrap();
        assert!(expression.contains("status = \"published\""));
        assert!(expression.contains("rating >= 8"));
    }

    #[test]
    fn rejects_contains_without_assuming_experimental_server_features() {
        let error = filter_expression(&serde_json::json!({ "title": { "$regex": "space" } }), Some("id")).unwrap_err();
        assert!(error.contains("experimental server feature"));
    }

    #[test]
    fn translates_document_sort_to_meilisearch_syntax() {
        assert_eq!(
            meilisearch_sort_from_request(Some(r#"{"rating":-1,"title":"asc"}"#), Some("id")).unwrap(),
            Some(vec!["rating:desc".to_string(), "title:asc".to_string()])
        );
    }

    #[test]
    fn accepts_native_meilisearch_sort_syntax() {
        assert_eq!(
            meilisearch_sort_from_request(Some("raw.createdAt:desc"), Some("id")).unwrap(),
            Some(vec!["raw.createdAt:desc".to_string()])
        );
        assert_eq!(
            meilisearch_sort_from_request(Some("rating:desc, title"), Some("id")).unwrap(),
            Some(vec!["rating:desc".to_string(), "title:asc".to_string()])
        );
        // The `_id` alias still maps to the real primary key in native syntax.
        assert_eq!(
            meilisearch_sort_from_request(Some("_id:desc"), Some("movie_id")).unwrap(),
            Some(vec!["movie_id:desc".to_string()])
        );
        assert!(meilisearch_sort_from_request(Some("rating:sideways"), Some("id")).is_err());
        assert!(meilisearch_sort_from_request(Some("bad field:asc"), Some("id")).is_err());
    }

    #[test]
    fn passes_through_native_meilisearch_filter_syntax() {
        assert_eq!(
            meilisearch_filter_from_request(Some("status = \"published\" AND rating >= 8"), Some("id")).unwrap(),
            Some(json!("status = \"published\" AND rating >= 8"))
        );
        // JSON filters keep going through the document-store translation.
        assert!(meilisearch_filter_from_request(Some(r#"{"status":"published"}"#), Some("id"))
            .unwrap()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap()
            .contains("status = \"published\""));
    }

    #[test]
    fn passes_through_native_meilisearch_filter_arrays() {
        // The official search API accepts filter as a string or an array; array
        // input must reach the request body unchanged instead of entering the
        // legacy JSON-object translation.
        let filter =
            meilisearch_filter_from_request(Some(r#"[["rating > 3"], "status = \"published\""]"#), Some("id")).unwrap();
        assert_eq!(filter, Some(json!([["rating > 3"], "status = \"published\""])));
    }

    #[test]
    fn maps_document_identity_alias_to_primary_key() {
        assert_eq!(
            filter_expression(&serde_json::json!({ "_id": "001" }), Some("movie_id")).unwrap(),
            "(movie_id = \"001\")"
        );
        assert_eq!(
            meilisearch_sort_from_request(Some(r#"{"_id":1}"#), Some("movie_id")).unwrap(),
            Some(vec!["movie_id:asc".to_string()])
        );
    }

    #[test]
    fn parses_rest_request_lines() {
        assert_eq!(parse_rest_request_line("GET /version").unwrap(), (Method::GET, "/version".to_string()));
        assert_eq!(parse_rest_request_line("/health").unwrap(), (Method::GET, "/health".to_string()));
        assert_eq!(
            parse_rest_request_line("GET /indexes/movies?limit=1").unwrap(),
            (Method::GET, "/indexes/movies?limit=1".to_string())
        );
        assert!(parse_rest_request_line("GET /../version").unwrap_err().contains("traversal"));
        assert!(parse_rest_request_line("GET /gateway/%2e%2e/version").unwrap_err().contains("traversal"));
        assert!(parse_rest_request_line("GET /gateway/%2e%2e%2fversion").unwrap_err().contains("traversal"));
        assert!(parse_rest_request_line("CONNECT /health")
            .unwrap_err()
            .contains("Unsupported Meilisearch HTTP method"));
    }

    #[test]
    fn bounded_rest_body_does_not_end_with_partial_utf8() {
        let mut body = vec![b'a'; super::REST_RESPONSE_MAX_BYTES - 1];
        body.extend_from_slice("界".as_bytes());
        assert_eq!(decode_bounded_rest_body(&body), "a".repeat(super::REST_RESPONSE_MAX_BYTES - 1));
    }

    #[test]
    fn builds_search_body_with_highlight_and_translated_filter_sort() {
        let body = meilisearch_search_body(
            Some("space"),
            20,
            10,
            Some(r#"{"status":"published"}"#),
            Some(r#"{"rating":-1}"#),
            Some("movie_id"),
            None,
            true,
            Some(0.8),
        )
        .unwrap();

        assert_eq!(body.get("q").and_then(Value::as_str), Some("space"));
        assert_eq!(body.get("offset").and_then(Value::as_u64), Some(20));
        assert_eq!(body.get("limit").and_then(Value::as_u64), Some(10));
        assert_eq!(body.get("filter").and_then(Value::as_str), Some("(status = \"published\")"));
        assert_eq!(
            body.get("sort")
                .and_then(Value::as_array)
                .map(|values| { values.iter().filter_map(Value::as_str).collect::<Vec<_>>() }),
            Some(vec!["rating:desc"])
        );
        assert_eq!(body.get("attributesToHighlight").and_then(Value::as_array).map(Vec::len), Some(1));
        assert_eq!(body.get("highlightPreTag").and_then(Value::as_str), Some("<mark>"));
        assert_eq!(body.get("highlightPostTag").and_then(Value::as_str), Some("</mark>"));
        assert_eq!(body.get("showRankingScore").and_then(Value::as_bool), Some(true));
        assert_eq!(body.get("rankingScoreThreshold").and_then(Value::as_f64), Some(0.8));
    }

    #[test]
    fn search_body_omits_empty_query_filter_and_sort() {
        let body = meilisearch_search_body(None, 0, 5, None, None, None, None, false, None).unwrap();

        assert!(body.get("q").is_none());
        assert!(body.get("filter").is_none());
        assert!(body.get("sort").is_none());
        assert!(body.get("hybrid").is_none());
        assert!(body.get("showRankingScore").is_none());
        // Without a query term there is nothing to highlight, so `_formatted`
        // data is not requested.
        assert!(body.get("attributesToHighlight").is_none());
        assert!(body.get("highlightPreTag").is_none());
        assert!(body.get("highlightPostTag").is_none());
        // A zero threshold means "no filtering" and is omitted.
        let body = meilisearch_search_body(None, 0, 5, None, None, None, None, false, Some(0.0)).unwrap();
        assert!(body.get("rankingScoreThreshold").is_none());
    }

    #[test]
    fn search_body_includes_hybrid_options_when_enabled() {
        let body = meilisearch_search_body(
            Some("space"),
            0,
            5,
            None,
            None,
            None,
            Some(&super::MeilisearchHybrid { embedder: "default".to_string(), semantic_ratio: 1.5 }),
            false,
            None,
        )
        .unwrap();

        let hybrid = body.get("hybrid").cloned().unwrap();
        assert_eq!(hybrid.get("embedder").and_then(Value::as_str), Some("default"));
        // Out-of-range ratios are clamped into [0, 1].
        assert_eq!(hybrid.get("semanticRatio").and_then(Value::as_f64), Some(1.0));

        let err = meilisearch_search_body(
            None,
            0,
            5,
            None,
            None,
            None,
            Some(&super::MeilisearchHybrid { embedder: "  ".to_string(), semantic_ratio: 0.5 }),
            false,
            None,
        )
        .unwrap_err();
        assert!(err.contains("embedder"));
    }

    #[test]
    fn parses_search_response_and_captures_identity() {
        let value = json!({
            "hits": [
                { "movie_id": 123, "title": "Alien", "_formatted": { "title": "<mark>Alien</mark>" } }
            ],
            "estimatedTotalHits": 42,
            "processingTimeMs": 7
        });
        let result = parse_meilisearch_search_response(value, Some("movie_id"), true, false).unwrap();

        assert_eq!(result.total_hits, 42);
        assert_eq!(result.processing_time_ms, 7);
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].id_json.as_deref(), Some("123"));
        // JSON crosses the HTTP/Tauri boundary as text so JavaScript never
        // rounds integer identities or document fields before decoding them.
        let document: Value = serde_json::from_str(&result.hits[0].document_json).unwrap();
        assert_eq!(document["movie_id"], json!(123));
        let formatted: Value = serde_json::from_str(result.hits[0].formatted_json.as_deref().unwrap()).unwrap();
        assert_eq!(formatted, json!({ "title": "<mark>Alien</mark>" }));
        assert!(document.get("_formatted").is_none());
    }

    #[test]
    fn search_hit_preserves_real_formatted_and_ranking_score_fields_when_not_requested() {
        // Without highlight/ranking-score requests, same-named keys are user
        // fields and must stay inside the document payload.
        let value = json!({
            "hits": [
                { "movie_id": 7, "_formatted": { "note": "user data" }, "_rankingScore": 0.99 }
            ],
            "estimatedTotalHits": 1,
            "processingTimeMs": 1
        });
        let result = parse_meilisearch_search_response(value.clone(), Some("movie_id"), false, false).unwrap();

        assert_eq!(result.hits[0].formatted_json, None);
        assert_eq!(result.hits[0].ranking_score_json, None);
        let document: Value = serde_json::from_str(&result.hits[0].document_json).unwrap();
        assert_eq!(document["_formatted"], json!({ "note": "user data" }));
        assert_eq!(document["_rankingScore"], json!(0.99));

        // With the flags on, Meilisearch-owned metadata is hoisted instead.
        let hoisted = parse_meilisearch_search_response(value, Some("movie_id"), true, true).unwrap();
        let formatted: Value = serde_json::from_str(hoisted.hits[0].formatted_json.as_deref().unwrap()).unwrap();
        let ranking_score: Value =
            serde_json::from_str(hoisted.hits[0].ranking_score_json.as_deref().unwrap()).unwrap();
        let document: Value = serde_json::from_str(&hoisted.hits[0].document_json).unwrap();
        assert_eq!(formatted, json!({ "note": "user data" }));
        assert_eq!(ranking_score, json!(0.99));
        assert!(document.get("_formatted").is_none());
        assert!(document.get("_rankingScore").is_none());
    }

    #[test]
    fn search_identity_never_shadows_a_real_underscore_id_field() {
        // A document may legitimately store its own `_id` field; the dbx identity
        // must live outside the document so the user field survives round-trips.
        let value = json!({
            "hits": [
                { "movie_id": 7, "_id": "user-owned", "title": "Alien" }
            ],
            "estimatedTotalHits": 1,
            "processingTimeMs": 1
        });
        let result = parse_meilisearch_search_response(value, Some("movie_id"), false, false).unwrap();

        assert_eq!(result.hits[0].id_json.as_deref(), Some("7"));
        let document: Value = serde_json::from_str(&result.hits[0].document_json).unwrap();
        assert_eq!(document["_id"], json!("user-owned"));
        assert_eq!(document["movie_id"], json!(7));
    }

    #[test]
    fn parses_large_search_responses() {
        let hits: Vec<Value> =
            (0..5000).map(|index| json!({ "movie_id": index, "title": format!("title-{index}") })).collect();
        let result = parse_meilisearch_search_response(
            json!({ "hits": hits, "estimatedTotalHits": 5000 }),
            Some("movie_id"),
            false,
            false,
        )
        .unwrap();

        assert_eq!(result.hits.len(), 5000);
        assert_eq!(result.hits[4999].id_json.as_deref(), Some("4999"));
        let document: Value = serde_json::from_str(&result.hits[4999].document_json).unwrap();
        assert_eq!(document["movie_id"], json!(4999));
    }

    #[test]
    fn search_transport_keeps_large_integer_identity_and_document_exact() {
        let value: Value =
            serde_json::from_str(r#"{"hits":[{"movie_id":9007199254740993,"title":"Alien"}],"estimatedTotalHits":1}"#)
                .unwrap();
        let result = parse_meilisearch_search_response(value, Some("movie_id"), false, false).unwrap();

        assert_eq!(result.hits[0].id_json.as_deref(), Some("9007199254740993"));
        assert_eq!(result.hits[0].document_json, r#"{"movie_id":9007199254740993,"title":"Alien"}"#);
        let wire = serde_json::to_value(&result).unwrap();
        assert_eq!(wire["hits"][0]["idJson"], json!("9007199254740993"));
        assert_eq!(wire["hits"][0]["documentJson"], json!(r#"{"movie_id":9007199254740993,"title":"Alien"}"#));
    }

    #[test]
    fn fetch_documents_requests_every_stored_field() {
        let body =
            super::meilisearch_fetch_body(0, 1000, Some(r#"genre = "sci-fi""#), Some("movie_id:asc"), Some("movie_id"))
                .unwrap();

        assert_eq!(body.get("fields"), Some(&json!(["*"])));
        assert_eq!(body.get("limit"), Some(&json!(1000)));
        assert_eq!(body.get("offset"), Some(&json!(0)));
    }

    #[test]
    fn search_response_prefers_estimated_total_and_falls_back_to_total() {
        let estimated = parse_meilisearch_search_response(
            json!({ "hits": [], "estimatedTotalHits": 5, "processingTimeMs": 1 }),
            None,
            false,
            false,
        )
        .unwrap();
        assert_eq!(estimated.total_hits, 5);

        let fallback = parse_meilisearch_search_response(
            json!({ "hits": [], "totalHits": 9, "processingTimeMs": 2 }),
            None,
            false,
            false,
        )
        .unwrap();
        assert_eq!(fallback.total_hits, 9);
    }

    #[test]
    fn search_response_requires_a_hit_total() {
        let error = parse_meilisearch_search_response(json!({ "hits": [], "processingTimeMs": 1 }), None, false, false)
            .unwrap_err();

        assert!(error.contains("hit total"));
    }

    /// Minimal HTTP/1.1 server that records request lines and serves canned
    /// index-info / search responses.
    async fn spawn_recording_server() -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let server_requests = requests.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                let requests = server_requests.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let read = socket.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..read]).to_string();
                    let request_line = head.lines().next().unwrap_or("").to_string();
                    requests.lock().unwrap().push(request_line.clone());
                    let body = if request_line.starts_with("GET ") && request_line.contains("/documents/") {
                        r#"{"movie_id":"SN-0001","title":"Canonical"}"#
                    } else if request_line.starts_with("GET ") {
                        r#"{"uid":"movies","primaryKey":"movie_id"}"#
                    } else {
                        r#"{"hits":[{"movie_id":1}],"estimatedTotalHits":1,"processingTimeMs":1}"#
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), requests)
    }

    #[tokio::test]
    async fn repeat_searches_share_one_index_lookup() {
        let (base_url, requests) = spawn_recording_server().await;
        let client = super::MeilisearchClient::new(&base_url, None, false, None, Duration::from_secs(5)).unwrap();

        super::search_documents(&client, "movies", None, None, None, 20, 0, None, false, None).await.unwrap();
        super::search_documents(&client, "movies", None, None, None, 20, 20, None, false, None).await.unwrap();

        let requests = requests.lock().unwrap();
        let index_lookups = requests.iter().filter(|line| line.starts_with("GET /indexes/movies ")).count();
        let searches = requests.iter().filter(|line| line.starts_with("POST /indexes/movies/search")).count();
        // The primary-key lookup is cached per index, so steady-state searching
        // is a single `/search` request instead of two round-trips.
        assert_eq!(index_lookups, 1, "requests: {requests:?}");
        assert_eq!(searches, 2, "requests: {requests:?}");
    }

    #[test]
    fn string_primary_keys_keep_their_string_identity() {
        // serializeDocumentStoreId on the frontend prefixes string ids so the
        // backend does not reinterpret a numeric-looking string as a number.
        let serialized = r#"__dbx_meilisearch_string_id__"123""#;
        assert_eq!(decoded_identity(serialized), json!("123"));
        assert_eq!(identity_path(serialized), "123");
        // A bare numeric id still decodes as a number.
        assert_eq!(decoded_identity("123"), json!(123));
        assert_eq!(identity_path("123"), "123");
    }

    #[tokio::test]
    async fn get_document_fetches_the_canonical_record_by_identity() {
        let (base_url, requests) = spawn_recording_server().await;
        let client = super::MeilisearchClient::new(&base_url, None, false, None, Duration::from_secs(5)).unwrap();

        // A string id arrives in the serialized form and must keep its string
        // identity in the request path.
        let document_json =
            super::get_document(&client, "movies", r#"__dbx_meilisearch_string_id__"SN-0001""#).await.unwrap();

        let document: Value = serde_json::from_str(&document_json).unwrap();
        assert_eq!(document["title"], json!("Canonical"));
        let requests = requests.lock().unwrap();
        assert!(
            requests.iter().any(|line| line.starts_with("GET /indexes/movies/documents/SN-0001?fields=*")),
            "requests: {requests:?}"
        );
    }
}
