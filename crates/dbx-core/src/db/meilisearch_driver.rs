use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::{Client as HttpClient, Method, RequestBuilder, StatusCode};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
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
        Ok(Self { http, base_url: url.trim_end_matches('/').to_string(), api_key })
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

#[derive(Debug, Deserialize)]
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
    let response = client
        .get(&format!("/indexes/{}", encode_path_segment(index)))
        .send()
        .await
        .map_err(|error| format!("Meilisearch request failed: {error}"))?;
    let value = response_json(response, "index lookup").await?;
    serde_json::from_value(value).map_err(|error| format!("Meilisearch index parse error: {error}"))
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

async fn fetch_documents_value(
    client: &MeilisearchClient,
    index: &str,
    offset: u64,
    limit: u64,
    filter: Option<&str>,
    sort: Option<&str>,
) -> Result<(DocumentsResponse, Option<String>), String> {
    let index_info = index_info(client, index).await?;
    let mut body = Map::new();
    body.insert("offset".to_string(), Value::Number(offset.into()));
    body.insert("limit".to_string(), Value::Number(limit.into()));
    if let Some(filter) = meilisearch_filter_from_request(filter, index_info.primary_key.as_deref())? {
        body.insert("filter".to_string(), Value::String(filter));
    }
    if let Some(sort) = meilisearch_sort_from_request(sort, index_info.primary_key.as_deref())? {
        body.insert("sort".to_string(), Value::Array(sort.into_iter().map(Value::String).collect()));
    }

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
    document.remove("_id");
    document.insert(primary_key, decoded_identity(id));
    // Meilisearch uses POST for full replacement and PUT for partial updates.
    // DBX sends the complete edited document so removed fields must disappear.
    submit_documents(client, index, Method::POST, vec![Value::Object(document)]).await?;
    Ok(1)
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

fn meilisearch_filter_from_request(filter: Option<&str>, primary_key: Option<&str>) -> Result<Option<String>, String> {
    let Some(filter) = filter.map(str::trim).filter(|value| !value.is_empty() && *value != "{}") else {
        return Ok(None);
    };
    let value: Value =
        serde_json::from_str(filter).map_err(|error| format!("Invalid Meilisearch filter JSON: {error}"))?;
    if let Some(raw) = value.get("$meiliFilter").and_then(Value::as_str) {
        return Ok(Some(raw.to_string()));
    }
    filter_expression(&value, primary_key).map(Some)
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
    let value: Value = serde_json::from_str(sort).map_err(|error| format!("Invalid Meilisearch sort JSON: {error}"))?;
    let object = value.as_object().ok_or_else(|| "Meilisearch sort must be a JSON object".to_string())?;
    let mut result = Vec::new();
    for (field, direction) in object {
        let field = if field == "_id" { primary_key.unwrap_or(field) } else { field };
        validate_filter_field(field)?;
        let direction = match direction {
            Value::Number(number) if number.as_i64().unwrap_or(1) < 0 => "desc",
            Value::String(value) if value.eq_ignore_ascii_case("desc") => "desc",
            _ => "asc",
        };
        result.push(format!("{field}:{direction}"));
    }
    Ok((!result.is_empty()).then_some(result))
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
    use super::{decode_bounded_rest_body, filter_expression, meilisearch_sort_from_request, parse_rest_request_line};
    use reqwest::Method;

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
}
