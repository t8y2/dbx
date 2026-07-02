use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::Client as HttpClient;
use serde_json::{Map, Value};
use std::error::Error;
use std::time::{Duration, Instant};

use super::{http_client_builder, with_connection_timeout};
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

const QUERY_VALUE_ENCODE_SET: &AsciiSet = &PATH_SEGMENT_ENCODE_SET.add(b'&').add(b'=').add(b'+');

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CollectionInfo {
    pub name: String,
    pub id: String,
    pub dimension: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VectorDbKind {
    Qdrant,
    Milvus,
    Weaviate,
    ChromaDb,
}

impl VectorDbKind {
    fn label(self) -> &'static str {
        match self {
            VectorDbKind::Qdrant => "Qdrant",
            VectorDbKind::Milvus => "Milvus",
            VectorDbKind::Weaviate => "Weaviate",
            VectorDbKind::ChromaDb => "ChromaDB",
        }
    }
}

#[derive(Clone)]
pub struct VectorClient {
    kind: VectorDbKind,
    http: HttpClient,
    base_url: String,
    auth: Option<VectorAuth>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum VectorAuth {
    Basic(String, String),
    Bearer(String),
    ApiKey(String),
    ChromaToken(String),
}

impl VectorClient {
    pub fn new(
        kind: VectorDbKind,
        url: &str,
        username: Option<&str>,
        password: Option<&str>,
        accept_invalid_certs: bool,
        timeout: Duration,
    ) -> Self {
        let base_url = url.trim_end_matches('/').to_string();
        let auth = vector_auth(kind, username, password);
        let builder = http_client_builder(timeout).danger_accept_invalid_certs(accept_invalid_certs);
        let http = builder.build().unwrap_or_else(|_| HttpClient::new());
        Self { kind, http, base_url, auth }
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.with_auth(self.http.get(format!("{}{}", self.base_url, path)))
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.with_auth(self.http.post(format!("{}{}", self.base_url, path)))
    }

    fn put(&self, path: &str) -> reqwest::RequestBuilder {
        self.with_auth(self.http.put(format!("{}{}", self.base_url, path)))
    }

    fn delete(&self, path: &str) -> reqwest::RequestBuilder {
        self.with_auth(self.http.delete(format!("{}{}", self.base_url, path)))
    }

    fn with_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.auth {
            Some(VectorAuth::Basic(user, pass)) => req.basic_auth(user, Some(pass)),
            Some(VectorAuth::Bearer(token)) => req.bearer_auth(token),
            Some(VectorAuth::ApiKey(token)) => req.header("api-key", token),
            Some(VectorAuth::ChromaToken(token)) => req.header("x-chroma-token", token),
            None => req,
        }
    }
}

fn vector_auth(kind: VectorDbKind, username: Option<&str>, password: Option<&str>) -> Option<VectorAuth> {
    let username = username.unwrap_or("").trim();
    let password = password.unwrap_or("");
    match kind {
        VectorDbKind::Qdrant if !username.is_empty() => {
            Some(VectorAuth::Basic(username.to_string(), password.to_string()))
        }
        VectorDbKind::Qdrant if !password.is_empty() => Some(VectorAuth::ApiKey(password.to_string())),
        VectorDbKind::Qdrant => None,
        VectorDbKind::Milvus if !username.is_empty() => Some(VectorAuth::Bearer(format!("{username}:{password}"))),
        VectorDbKind::Milvus => None,
        VectorDbKind::Weaviate if !password.is_empty() => Some(VectorAuth::Bearer(password.to_string())),
        VectorDbKind::Weaviate => None,
        VectorDbKind::ChromaDb if !password.is_empty() => Some(VectorAuth::ChromaToken(password.to_string())),
        VectorDbKind::ChromaDb => None,
    }
}

pub async fn test_connection(client: &VectorClient, timeout: Duration) -> Result<(), String> {
    let label = client.kind.label();
    let path = match client.kind {
        VectorDbKind::Qdrant => "/collections",
        VectorDbKind::Milvus => "/v2/vectordb/collections/list",
        VectorDbKind::Weaviate => "/v1/meta",
        VectorDbKind::ChromaDb => "/api/v2/heartbeat",
    };
    let request = match client.kind {
        VectorDbKind::Qdrant => client.get(path),
        VectorDbKind::Milvus => client.post(path).json(&serde_json::json!({ "dbName": "default" })),
        VectorDbKind::Weaviate => client.get(path),
        VectorDbKind::ChromaDb => client.get(path),
    };
    let resp = with_connection_timeout(label, timeout, async {
        request.send().await.map_err(|e| format!("{label} connection failed: {}", format_reqwest_error(&e)))
    })
    .await?;
    ensure_success(label, resp).await.map(|_| ())
}

pub async fn list_collections(client: &VectorClient) -> Result<Vec<CollectionInfo>, String> {
    list_collections_with_db(client, "").await
}

/// List collections, passing an optional database name (used by Milvus).
pub(crate) async fn list_collections_with_db(
    client: &VectorClient,
    database: &str,
) -> Result<Vec<CollectionInfo>, String> {
    match client.kind {
        VectorDbKind::Qdrant => list_qdrant_collections(client).await,
        VectorDbKind::Milvus => list_milvus_collections(client, database).await,
        VectorDbKind::Weaviate => list_weaviate_collections(client).await,
        VectorDbKind::ChromaDb => list_chroma_collections(client).await,
    }
}

async fn list_qdrant_collections(client: &VectorClient) -> Result<Vec<CollectionInfo>, String> {
    let body = send_json(client.get("/collections"), "Qdrant").await?;
    let mut infos: Vec<CollectionInfo> = body
        .pointer("/result/collections")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let name = item.get("name").and_then(Value::as_str)?;
            Some(CollectionInfo { name: name.to_string(), id: name.to_string(), dimension: None })
        })
        .collect();
    infos.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(infos)
}

async fn list_milvus_collections(client: &VectorClient, database: &str) -> Result<Vec<CollectionInfo>, String> {
    let db_name = if database.is_empty() { "default" } else { database };
    let body = send_json(
        client.post("/v2/vectordb/collections/list").json(&serde_json::json!({ "dbName": db_name })),
        "Milvus",
    )
    .await?;
    let mut infos: Vec<CollectionInfo> = match body.get("data") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                let name = collection_name_from_milvus_item(item)?;
                Some(CollectionInfo { name: name.clone(), id: name, dimension: None })
            })
            .collect(),
        _ => Vec::new(),
    };
    infos.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(infos)
}

fn collection_name_from_milvus_item(item: &Value) -> Option<String> {
    item.as_str()
        .map(str::to_string)
        .or_else(|| item.get("collectionName").and_then(Value::as_str).map(str::to_string))
        .or_else(|| item.get("name").and_then(Value::as_str).map(str::to_string))
}

async fn list_weaviate_collections(client: &VectorClient) -> Result<Vec<CollectionInfo>, String> {
    let body = send_json(client.get("/v1/schema"), "Weaviate").await?;
    let mut infos: Vec<CollectionInfo> = weaviate_collection_names_from_schema(&body)
        .into_iter()
        .map(|name| CollectionInfo { name: name.clone(), id: name, dimension: None })
        .collect();
    infos.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(infos)
}

async fn list_chroma_collections(client: &VectorClient) -> Result<Vec<CollectionInfo>, String> {
    let body =
        send_json(client.get("/api/v2/tenants/default_tenant/databases/default_database/collections"), "ChromaDB")
            .await?;
    let mut infos: Vec<CollectionInfo> = body
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let name = item.get("name").and_then(Value::as_str)?;
            let id = item.get("id").and_then(Value::as_str)?;
            let dimension = item.get("dimension").and_then(|v| v.as_u64()).map(|d| d as u32);
            Some(CollectionInfo { name: name.to_string(), id: id.to_string(), dimension })
        })
        .collect();
    infos.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(infos)
}

pub async fn get_collection_detail(
    client: &VectorClient,
    database: &str,
    collection: &str,
) -> Result<CollectionInfo, String> {
    match client.kind {
        VectorDbKind::Qdrant => get_qdrant_collection_detail(client, collection).await,
        VectorDbKind::Milvus => get_milvus_collection_detail(client, database, collection).await,
        VectorDbKind::Weaviate => {
            // Weaviate REST API does not expose vector dimension
            Ok(CollectionInfo { name: collection.to_string(), id: collection.to_string(), dimension: None })
        }
        VectorDbKind::ChromaDb => get_chroma_collection_detail(client, collection).await,
    }
}

async fn get_qdrant_collection_detail(client: &VectorClient, collection: &str) -> Result<CollectionInfo, String> {
    let body = send_json(client.get(&format!("/collections/{}", path_segment(collection))), "Qdrant").await?;
    let dim = body
        .pointer("/result/config/params/vectors/size")
        .and_then(Value::as_u64)
        .or_else(|| {
            body.pointer("/result/config/params/vectors")
                .and_then(Value::as_object)
                .and_then(|obj| obj.values().find_map(|v| v.get("size").and_then(|s| s.as_u64())))
        })
        .map(|d| d as u32);
    Ok(CollectionInfo { name: collection.to_string(), id: collection.to_string(), dimension: dim })
}

fn milvus_vector_dim_from_field(field: &Value) -> Option<u32> {
    if let Some(dim) = field.pointer("/params/dim").and_then(Value::as_u64) {
        return Some(dim as u32);
    }
    if let Some(params) = field.get("params").and_then(Value::as_array) {
        for param in params {
            if param.get("key").and_then(Value::as_str) == Some("dim") {
                if let Some(v) = param.get("value").and_then(Value::as_str) {
                    return v.parse().ok();
                }
                if let Some(v) = param.get("value").and_then(Value::as_u64) {
                    return Some(v as u32);
                }
            }
        }
    }
    None
}

async fn get_milvus_collection_detail(
    client: &VectorClient,
    database: &str,
    collection: &str,
) -> Result<CollectionInfo, String> {
    let db_name = if database.is_empty() { "default" } else { database };
    let body = send_json(
        client
            .post("/v2/vectordb/collections/describe")
            .json(&serde_json::json!({ "dbName": db_name, "collectionName": collection })),
        "Milvus",
    )
    .await?;
    if body.get("code").and_then(Value::as_i64) != Some(0) {
        let msg = body.get("message").and_then(Value::as_str).unwrap_or("unknown error");
        return Err(format!("Milvus collection detail error: {msg}"));
    }
    let fields = body.pointer("/data/fields").and_then(Value::as_array);
    let dim = fields
        .and_then(|f| {
            f.iter().find(|f| {
                let t = f.get("type");
                t.and_then(Value::as_str) == Some("FloatVector")
                    || t.and_then(Value::as_str) == Some("BinaryVector")
                    || t.and_then(Value::as_i64) == Some(101)
                    || t.and_then(Value::as_i64) == Some(102)
            })
        })
        .and_then(milvus_vector_dim_from_field);
    Ok(CollectionInfo { name: collection.to_string(), id: collection.to_string(), dimension: dim })
}

async fn get_chroma_collection_detail(client: &VectorClient, collection: &str) -> Result<CollectionInfo, String> {
    let body = send_json(
        client.get(&format!(
            "/api/v2/tenants/default_tenant/databases/default_database/collections/{}",
            path_segment(collection)
        )),
        "ChromaDB",
    )
    .await?;
    let name = body.get("name").and_then(Value::as_str).unwrap_or(collection);
    let id = body.get("id").and_then(Value::as_str).unwrap_or(collection);
    let dimension = body.get("dimension").and_then(|v| v.as_u64()).map(|d| d as u32);
    Ok(CollectionInfo { name: name.to_string(), id: id.to_string(), dimension })
}

fn chroma_get_response_to_rows(body: &Value) -> Vec<Value> {
    let flatten = |key: &str| -> Vec<Value> {
        let raw = body.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        let is_nested = raw.first().and_then(|v| v.as_array()).is_some();
        if is_nested {
            raw.iter().flat_map(|v| v.as_array().cloned().unwrap_or_default()).collect()
        } else {
            raw
        }
    };

    let ids = flatten("ids");
    let documents = flatten("documents");
    let metadatas = flatten("metadatas");
    let distances = flatten("distances");

    ids.into_iter()
        .enumerate()
        .map(|(i, id_val)| {
            let mut row = serde_json::Map::new();
            row.insert("id".to_string(), id_val);
            if let Some(doc) = documents.get(i) {
                row.insert("document".to_string(), doc.clone());
            }
            if let Some(Value::Object(meta_obj)) = metadatas.get(i) {
                for (k, v) in meta_obj {
                    row.insert(k.clone(), v.clone());
                }
            }
            if let Some(dist) = distances.get(i) {
                row.insert("distance".to_string(), dist.clone());
            }
            Value::Object(row)
        })
        .collect()
}

fn weaviate_graphql_to_rows(body: &Value) -> Option<Vec<Value>> {
    let get_obj = body.pointer("/data/Get")?.as_object()?;
    let (_class_name, items) = get_obj.iter().next()?;
    let items = items.as_array()?;
    Some(
        items
            .iter()
            .map(|item| {
                let mut obj = match item {
                    Value::Object(m) => m.clone(),
                    _ => return item.clone(),
                };
                if let Some(Value::Object(additional)) = obj.remove("_additional") {
                    for (k, v) in additional {
                        obj.entry(k).or_insert(v);
                    }
                }
                Value::Object(obj)
            })
            .collect(),
    )
}

fn weaviate_collection_names_from_schema(body: &Value) -> Vec<String> {
    body.get("classes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("class").and_then(Value::as_str).map(str::to_string))
        .collect()
}

pub async fn find_documents(
    client: &VectorClient,
    collection: &str,
    skip: u64,
    limit: i64,
) -> Result<crate::db::mongo_driver::MongoDocumentResult, String> {
    if client.kind == VectorDbKind::ChromaDb {
        let start = std::time::Instant::now();
        let url = format!(
            "{}/api/v2/tenants/default_tenant/databases/default_database/collections/{}/get",
            client.base_url,
            path_segment(collection),
        );
        let resp = client
            .with_auth(client.http.post(&url))
            .json(&serde_json::json!({
                "limit": limit.max(1) as u64,
                "offset": skip,
                "include": ["documents", "metadatas"],
            }))
            .send()
            .await
            .map_err(|e| format!("ChromaDB request failed: {}", format_reqwest_error(&e)))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("ChromaDB error ({status}): {body}"));
        }
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        let rows = chroma_get_response_to_rows(&body);
        let result = values_to_query_result(rows, start);
        let documents = result
            .rows
            .into_iter()
            .map(|row| {
                let mut map = serde_json::Map::new();
                for (idx, col) in result.columns.iter().enumerate() {
                    map.insert(col.clone(), row.get(idx).cloned().unwrap_or(Value::Null));
                }
                Value::Object(map)
            })
            .collect();
        return Ok(crate::db::mongo_driver::MongoDocumentResult { documents, total: result.affected_rows });
    }

    let query = match client.kind {
        VectorDbKind::Qdrant => format!(
            "POST /collections/{}/points/scroll\n{}",
            path_segment(collection),
            serde_json::json!({
                "limit": limit.max(1) as u64,
                "offset": if skip == 0 { Value::Null } else { Value::from(skip) },
                "with_payload": true,
                "with_vector": false,
            })
        ),
        VectorDbKind::Milvus => format!(
            "POST /v2/vectordb/entities/query\n{}",
            serde_json::json!({
                "dbName": "default",
                "collectionName": collection,
                "filter": "",
                "limit": limit.max(1) as u64,
                "offset": skip,
                "outputFields": ["*"],
            })
        ),
        VectorDbKind::Weaviate => {
            format!("GET /v1/objects?class={}&limit={}&offset={}", query_value(collection), limit.max(1), skip)
        }
        VectorDbKind::ChromaDb => unreachable!("ChromaDB handled above"),
    };
    let result = execute_rest_query(client, &query).await?;
    let documents = result
        .rows
        .into_iter()
        .map(|row| {
            let mut map = Map::new();
            for (idx, column) in result.columns.iter().enumerate() {
                map.insert(column.clone(), row.get(idx).cloned().unwrap_or(Value::Null));
            }
            Value::Object(map)
        })
        .collect();
    Ok(crate::db::mongo_driver::MongoDocumentResult { documents, total: result.affected_rows })
}

pub async fn execute_rest_query(client: &VectorClient, input: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let request = parse_rest_query(client, input)?;
    let resp = request.send().await.map_err(|e| format!("{} request failed: {e}", client.kind.label()))?;
    let status = resp.status().as_u16();
    let body = resp.json::<Value>().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let detail = serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string());
        return Err(format!("{} error ({status}): {detail}", client.kind.label()));
    }
    Ok(json_to_query_result(status, body, start))
}

fn parse_rest_query(client: &VectorClient, input: &str) -> Result<reqwest::RequestBuilder, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(format!("{} query cannot be empty", client.kind.label()));
    }

    if !starts_with_http_method(trimmed) {
        return default_collection_query(client, trimmed);
    }

    let (head, body) = trimmed.split_once('\n').map_or((trimmed, ""), |(head, body)| (head.trim(), body.trim()));
    let mut parts = head.split_whitespace();
    let method = parts.next().unwrap_or("").to_ascii_uppercase();
    let path = parts.next().ok_or_else(|| "Vector query path is required".to_string())?;
    let path = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };
    let req = match method.as_str() {
        "GET" => client.get(&path),
        "POST" => client.post(&path),
        "PUT" => client.put(&path),
        "DELETE" => client.delete(&path),
        other => return Err(format!("Unsupported vector REST method: {other}")),
    };
    if body.is_empty() {
        Ok(req)
    } else {
        let json: Value = serde_json::from_str(body).map_err(|e| format!("Vector query body must be JSON: {e}"))?;
        Ok(req.json(&json))
    }
}

fn default_collection_query(client: &VectorClient, collection: &str) -> Result<reqwest::RequestBuilder, String> {
    let collection = collection.trim();
    if collection.is_empty() {
        return Err("Vector collection name cannot be empty".to_string());
    }
    match client.kind {
        VectorDbKind::Qdrant => Ok(client
            .post(&format!("/collections/{}/points/scroll", path_segment(collection)))
            .json(&serde_json::json!({ "limit": 100, "with_payload": true, "with_vector": false }))),
        VectorDbKind::Milvus => Ok(client.post("/v2/vectordb/entities/query").json(&serde_json::json!({
            "dbName": "default",
            "collectionName": collection,
            "filter": "",
            "limit": 100,
            "outputFields": ["*"],
        }))),
        VectorDbKind::Weaviate => Ok(client.get(&format!("/v1/objects?class={}&limit=100", query_value(collection)))),
        VectorDbKind::ChromaDb => Ok(client
            .post(&format!(
                "/api/v2/tenants/default_tenant/databases/default_database/collections/{}/get",
                path_segment(collection)
            ))
            .json(&serde_json::json!({"limit": 100, "include": ["documents", "metadatas"]}))),
    }
}

fn starts_with_http_method(input: &str) -> bool {
    ["GET ", "POST ", "PUT ", "DELETE "].iter().any(|prefix| input.to_ascii_uppercase().starts_with(prefix))
}

pub(crate) fn path_segment(value: &str) -> String {
    utf8_percent_encode(value, PATH_SEGMENT_ENCODE_SET).to_string()
}

pub(crate) fn query_value(value: &str) -> String {
    utf8_percent_encode(value, QUERY_VALUE_ENCODE_SET).to_string()
}

async fn send_json(req: reqwest::RequestBuilder, label: &str) -> Result<Value, String> {
    let resp = req.send().await.map_err(|e| format!("{label} request failed: {e}"))?;
    let resp = ensure_success(label, resp).await?;
    resp.json().await.map_err(|e| format!("{label} parse error: {e}"))
}

async fn ensure_success(label: &str, resp: reqwest::Response) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Err(format!("{label} error ({status}): {body}"))
}

fn json_to_query_result(status: u16, body: Value, start: Instant) -> QueryResult {
    let rows_value =
        body.pointer("/result/points").or_else(|| body.get("result")).or_else(|| body.get("data")).cloned();
    if let Some(Value::Array(items)) = rows_value {
        return values_to_query_result(items, start);
    }
    if let Some(Value::Array(items)) = body.get("objects").cloned() {
        return values_to_query_result(items, start);
    }
    if let Some(Value::Array(items)) = body.pointer("/result/collections").cloned() {
        return values_to_query_result(items, start);
    }
    if body.get("ids").and_then(Value::as_array).is_some() && body.get("documents").and_then(Value::as_array).is_some()
    {
        let rows = chroma_get_response_to_rows(&body);
        return values_to_query_result(rows, start);
    }
    // Weaviate GraphQL search response
    if let Some(items) = weaviate_graphql_to_rows(&body) {
        return values_to_query_result(items, start);
    }
    QueryResult {
        columns: vec!["status".to_string(), "response".to_string()],
        column_types: Vec::new(),
        column_sortables: vec![],
        rows: vec![vec![
            Value::Number(status.into()),
            Value::String(serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string())),
        ]],
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
    }
}

fn values_to_query_result(items: Vec<Value>, start: Instant) -> QueryResult {
    let docs: Vec<Map<String, Value>> = items.into_iter().map(normalize_row_object).collect();
    let mut columns = Vec::<String>::new();
    for doc in &docs {
        for key in doc.keys() {
            if !columns.contains(key) {
                columns.push(key.clone());
            }
        }
    }
    if columns.is_empty() {
        columns.push("value".to_string());
    }
    let rows: Vec<Vec<Value>> = docs
        .iter()
        .map(|doc| columns.iter().map(|column| doc.get(column).cloned().unwrap_or(Value::Null)).collect())
        .collect();
    QueryResult {
        columns,
        column_types: Vec::new(),
        column_sortables: vec![],
        affected_rows: rows.len() as u64,
        rows,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
    }
}

fn normalize_row_object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(mut object) => {
            if let Some(Value::Object(payload)) = object.remove("payload") {
                for (key, value) in payload {
                    object.entry(key).or_insert(value);
                }
            }
            if let Some(Value::Object(properties)) = object.remove("properties") {
                for (key, value) in properties {
                    object.entry(key).or_insert(value);
                }
            }
            object
        }
        other => {
            let mut object = Map::new();
            object.insert("value".to_string(), other);
            object
        }
    }
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

#[cfg(test)]
mod tests {
    use super::{
        chroma_get_response_to_rows, starts_with_http_method, values_to_query_result, vector_auth,
        weaviate_collection_names_from_schema, CollectionInfo, VectorAuth, VectorDbKind,
    };
    use serde_json::json;
    use std::time::Instant;

    #[test]
    fn detects_rest_queries_case_insensitively() {
        assert!(starts_with_http_method("post /collections/foo"));
        assert!(starts_with_http_method("GET /collections"));
        assert!(!starts_with_http_method("collection_name"));
    }

    #[test]
    fn flattens_qdrant_payload_columns() {
        let result =
            values_to_query_result(vec![json!({"id": 1, "score": 0.9, "payload": {"title": "hello"}})], Instant::now());
        assert!(result.columns.contains(&"id".to_string()));
        assert!(result.columns.contains(&"score".to_string()));
        assert!(result.columns.contains(&"title".to_string()));
    }

    #[test]
    fn extracts_weaviate_schema_class_names() {
        let names = weaviate_collection_names_from_schema(&json!({
            "classes": [
                { "class": "Article" },
                { "class": "Product" }
            ]
        }));
        assert_eq!(names, vec!["Article".to_string(), "Product".to_string()]);
    }

    #[test]
    fn flattens_weaviate_properties_columns() {
        let result = values_to_query_result(
            vec![json!({"id": "abc", "class": "Article", "properties": {"title": "hello"}})],
            Instant::now(),
        );
        assert!(result.columns.contains(&"id".to_string()));
        assert!(result.columns.contains(&"class".to_string()));
        assert!(result.columns.contains(&"title".to_string()));
    }

    #[test]
    fn uses_bearer_auth_for_weaviate_tokens_even_with_username() {
        assert_eq!(
            vector_auth(VectorDbKind::Weaviate, Some("user"), Some("token")),
            Some(VectorAuth::Bearer("token".to_string()))
        );
    }

    #[test]
    fn chroma_db_uses_x_chroma_token_header() {
        assert_eq!(
            vector_auth(VectorDbKind::ChromaDb, None, Some("my-key")),
            Some(VectorAuth::ChromaToken("my-key".to_string()))
        );
    }

    #[test]
    fn chroma_db_no_auth_when_no_password() {
        assert_eq!(vector_auth(VectorDbKind::ChromaDb, None, None), None);
    }

    #[test]
    fn parses_chroma_collection_list() {
        let body = json!([
            {"id": "uuid-123", "name": "my_collection", "dimension": 384},
            {"id": "uuid-456", "name": "other", "dimension": 768}
        ]);
        let infos: Vec<CollectionInfo> = body
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| {
                let name = item.get("name").and_then(|v| v.as_str())?;
                let id = item.get("id").and_then(|v| v.as_str())?;
                Some(CollectionInfo { name: name.to_string(), id: id.to_string(), dimension: None })
            })
            .collect();
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].name, "my_collection");
        assert_eq!(infos[0].id, "uuid-123");
        assert_eq!(infos[1].name, "other");
        assert_eq!(infos[1].id, "uuid-456");
    }

    #[test]
    fn converts_chroma_column_major_to_rows() {
        let body = json!({
            "ids": ["id1", "id2"],
            "documents": ["hello world", "test doc"],
            "metadatas": [{"source": "test"}, {"source": "demo"}]
        });
        let rows = chroma_get_response_to_rows(&body);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], json!("id1"));
        assert_eq!(rows[0]["document"], json!("hello world"));
        assert_eq!(rows[0]["source"], json!("test"));
        assert_eq!(rows[1]["id"], json!("id2"));
        assert_eq!(rows[1]["source"], json!("demo"));
    }
}
