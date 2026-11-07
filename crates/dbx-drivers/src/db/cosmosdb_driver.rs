//! Azure Cosmos DB for NoSQL over the REST gateway API.
//!
//! - Authentication uses the account key (`type=master&ver=1.0` HMAC-SHA256
//!   signatures). Microsoft Entra ID is planned for a later phase.
//! - Queries run through the gateway with cross-partition execution enabled.
//!   Queries the gateway cannot serve directly (cross-partition ORDER BY,
//!   aggregates, DISTINCT, GROUP BY, OFFSET/LIMIT, TOP) need a client-side
//!   query pipeline; they return an explicit error that suggests scoping the
//!   query to one logical partition.
//! - Every document exposed to the document browser carries a synthetic `_id`
//!   holding `{ "id": ..., "partitionKey": [...] }`, the coordinates required
//!   for point reads and writes.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS, NON_ALPHANUMERIC};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, StatusCode};
use serde_json::{Map, Value};
use sha2::Sha256;

use super::document_result::DocumentQueryResult;
use super::{apply_http_proxy, apply_tls_certificates_for_driver, http_client_builder, with_connection_timeout};
use crate::db::ColumnInfo;
use crate::models::connection::DatabaseConnectionInfo;
use crate::types::{QueryMessage, QueryResult};

pub const COSMOSDB_DEFAULT_PORT: u16 = 443;
const COSMOS_API_VERSION: &str = "2020-07-15";
const IDENTITY_FIELD: &str = "_id";
const SYSTEM_PROPERTIES: [&str; 5] = ["_rid", "_self", "_etag", "_attachments", "_ts"];
const MAX_THROTTLE_RETRIES: usize = 3;
const MAX_THROTTLE_WAIT: Duration = Duration::from_secs(5);
/// Cross-partition gateway queries can return many empty pages (one per
/// physical partition). Bound the number of round trips per browser page.
const MAX_PAGE_ROUND_TRIPS: usize = 256;
const COLUMN_SAMPLE_SIZE: usize = 50;

/// Characters escaped in a URL path segment. Cosmos ids cannot contain `/`,
/// `\`, `?` or `#`, but they can contain spaces and other reserved characters.
const PATH_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'`')
    .add(b'?')
    .add(b'{')
    .add(b'}')
    .add(b'/')
    .add(b'\\')
    .add(b'^')
    .add(b'|');

fn encode_path_segment(value: &str) -> String {
    utf8_percent_encode(value, PATH_SEGMENT_ENCODE_SET).to_string()
}

// ---------------------------------------------------------------------------
// Connection settings
// ---------------------------------------------------------------------------

/// Endpoint and key parsed from a portal connection string
/// (`AccountEndpoint=https://...;AccountKey=...;`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CosmosConnectionString {
    pub endpoint: String,
    pub key: String,
}

pub fn parse_cosmos_connection_string(value: &str) -> Option<CosmosConnectionString> {
    let mut endpoint = None;
    let mut key = None;
    for part in value.trim().split(';') {
        let Some((name, raw)) = part.split_once('=') else {
            continue;
        };
        let raw = raw.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "accountendpoint" if !raw.is_empty() => endpoint = Some(raw.to_string()),
            // Base64 keys end with `=` padding, which `split_once` keeps in `raw`.
            "accountkey" if !raw.is_empty() => key = Some(raw.to_string()),
            _ => {}
        }
    }
    Some(CosmosConnectionString { endpoint: endpoint?, key: key? })
}

/// Normalizes a host field or endpoint URI to `https://host[:port]`.
pub fn normalize_cosmos_endpoint(url: &str, tls_enabled: bool) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else if let Some(stripped) = trimmed.strip_prefix("cosmosdb://") {
        format!("{}://{stripped}", if tls_enabled { "https" } else { "http" })
    } else {
        format!("{}://{trimmed}", if tls_enabled { "https" } else { "http" })
    };
    match reqwest::Url::parse(&with_scheme) {
        Ok(parsed) => {
            let host = parsed.host_str().unwrap_or_default();
            let host =
                if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
            match parsed.port() {
                Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
                None => format!("{}://{host}", parsed.scheme()),
            }
        }
        Err(_) => with_scheme,
    }
}

fn url_params_flag(params: Option<&str>, key: &str, expected_values: &[&str]) -> bool {
    params.unwrap_or("").trim().trim_start_matches('?').split(['&', ';']).filter_map(|p| p.split_once('=')).any(
        |(k, v)| k.trim().eq_ignore_ascii_case(key) && expected_values.iter().any(|e| v.trim().eq_ignore_ascii_case(e)),
    )
}

/// Certificate validation stays on by default. The local emulator uses a
/// self-signed certificate: trust it with a CA file, or opt out explicitly.
pub fn cosmos_accept_invalid_certs(url_params: Option<&str>) -> bool {
    url_params_flag(url_params, "tlsverify", &["false", "0", "no", "off"])
        || url_params_flag(url_params, "verify", &["false", "0", "no", "off"])
        || url_params_flag(url_params, "insecure", &["true", "1", "yes", "on"])
        || url_params_flag(url_params, "accept_invalid_certs", &["true", "1", "yes", "on"])
}

/// Options for [`CosmosDbClient::from_config`].
pub struct CosmosClientOptions<'a> {
    /// Endpoint the user configured (host field or `AccountEndpoint`).
    pub configured_endpoint: &'a str,
    /// Endpoint DBX actually connects to; differs from `configured_endpoint`
    /// when an SSH or transport tunnel publishes the account locally.
    pub transport_url: &'a str,
    pub account_key: &'a str,
    pub tls_enabled: bool,
    pub url_params: Option<&'a str>,
    pub timeout: Duration,
    pub ca_cert_path: Option<&'a str>,
    pub client_cert_path: Option<&'a str>,
    pub client_key_path: Option<&'a str>,
    pub proxy: Option<reqwest::Proxy>,
}

#[derive(Debug, Clone)]
struct PartitionKeyDefinition {
    paths: Vec<String>,
    kind: String,
}

impl PartitionKeyDefinition {
    fn from_container(container: &Value) -> Self {
        let definition = container.get("partitionKey");
        let paths = definition
            .and_then(|d| d.get("paths"))
            .and_then(Value::as_array)
            .map(|paths| paths.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let kind = definition.and_then(|d| d.get("kind")).and_then(Value::as_str).unwrap_or("Hash").to_string();
        Self { paths, kind }
    }
}

#[derive(Clone)]
pub struct CosmosDbClient {
    http: reqwest::Client,
    base_url: String,
    key: Arc<Vec<u8>>,
    partition_keys: Arc<Mutex<HashMap<(String, String), PartitionKeyDefinition>>>,
}

impl std::fmt::Debug for CosmosDbClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CosmosDbClient").field("base_url", &self.base_url).finish_non_exhaustive()
    }
}

impl CosmosDbClient {
    pub fn from_config(options: CosmosClientOptions<'_>) -> Result<Self, String> {
        let key_text = options.account_key.trim();
        let key_text =
            parse_cosmos_connection_string(key_text).map(|parsed| parsed.key).unwrap_or(key_text.to_string());
        if key_text.is_empty() {
            return Err("Azure Cosmos DB account key is required".to_string());
        }
        let key = STANDARD
            .decode(key_text.as_bytes())
            .map_err(|_| "Azure Cosmos DB account key must be the Base64 primary or secondary key".to_string())?;

        let configured_url = normalize_cosmos_endpoint(options.configured_endpoint, options.tls_enabled);
        let transport_url = normalize_cosmos_endpoint(options.transport_url, options.tls_enabled);

        let mut builder = http_client_builder(options.timeout);
        if cosmos_accept_invalid_certs(options.url_params) {
            builder = builder.danger_accept_invalid_certs(true);
        }
        // Behind a tunnel, keep the account host in the URL so TLS validates
        // the real certificate, and route its socket to the local endpoint.
        // Endpoints with an explicit port (the emulator) connect to the tunnel
        // address directly instead.
        let base_url = if configured_url == transport_url {
            configured_url
        } else if let Some((host, address)) = tunnel_override(&configured_url, &transport_url) {
            builder = builder.resolve(&host, address);
            configured_url
        } else {
            transport_url
        };
        builder = apply_http_proxy(builder, &base_url, options.proxy, None, None)?;
        builder = apply_tls_certificates_for_driver(
            builder,
            options.ca_cert_path.filter(|p| !p.trim().is_empty()),
            options.client_cert_path.filter(|p| !p.trim().is_empty()),
            options.client_key_path.filter(|p| !p.trim().is_empty()),
            "Azure Cosmos DB",
        )?;
        let http = builder.build().map_err(|e| format!("Failed to initialize Azure Cosmos DB HTTP client: {e}"))?;
        Ok(Self { http, base_url, key: Arc::new(key), partition_keys: Arc::new(Mutex::new(HashMap::new())) })
    }

    #[cfg(test)]
    fn for_test(base_url: &str, key_base64: &str) -> Self {
        Self::from_config(CosmosClientOptions {
            configured_endpoint: base_url,
            transport_url: base_url,
            account_key: key_base64,
            tls_enabled: false,
            url_params: None,
            timeout: Duration::from_secs(5),
            ca_cert_path: None,
            client_cert_path: None,
            client_key_path: None,
            proxy: None,
        })
        .unwrap()
    }

    fn cached_partition_key(&self, database: &str, container: &str) -> Option<PartitionKeyDefinition> {
        self.partition_keys.lock().ok()?.get(&(database.to_string(), container.to_string())).cloned()
    }

    fn cache_partition_key(&self, database: &str, container: &str, definition: PartitionKeyDefinition) {
        if let Ok(mut cache) = self.partition_keys.lock() {
            cache.insert((database.to_string(), container.to_string()), definition);
        }
    }
}

/// Resolver override that sends the configured host to the tunnel address.
/// Only possible when the configured URL has no explicit port: the HTTP
/// connector always prefers an explicit URL port over the resolved one.
fn tunnel_override(configured_url: &str, transport_url: &str) -> Option<(String, SocketAddr)> {
    let configured = reqwest::Url::parse(configured_url).ok()?;
    if configured.port().is_some() {
        return None;
    }
    let transport = reqwest::Url::parse(transport_url).ok()?;
    let host = configured.host_str()?.to_string();
    let transport_host = transport.host_str()?.trim_matches(['[', ']']);
    let ip = if transport_host.eq_ignore_ascii_case("localhost") {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        transport_host.parse::<IpAddr>().ok()?
    };
    let port = transport.port_or_known_default()?;
    Some((host, SocketAddr::new(ip, port)))
}

// ---------------------------------------------------------------------------
// Request signing and transport
// ---------------------------------------------------------------------------

fn rfc1123_now() -> String {
    chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

/// Builds the `authorization` header value for master-key requests.
/// See "Access control on Azure Cosmos DB resources" in the REST reference.
fn master_key_authorization(verb: &Method, resource_type: &str, resource_link: &str, date: &str, key: &[u8]) -> String {
    let payload = format!(
        "{}\n{}\n{}\n{}\n\n",
        verb.as_str().to_ascii_lowercase(),
        resource_type.to_ascii_lowercase(),
        resource_link,
        date.to_ascii_lowercase()
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(payload.as_bytes());
    let signature = STANDARD.encode(mac.finalize().into_bytes());
    let token = format!("type=master&ver=1.0&sig={signature}");
    utf8_percent_encode(&token, NON_ALPHANUMERIC).to_string()
}

/// HTTP header values must be visible ASCII. Partition key values are JSON
/// and may contain any Unicode text, so escape everything else as `\uXXXX`.
fn ascii_json(value: &Value) -> String {
    let text = value.to_string();
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch.is_ascii() && !ch.is_ascii_control() {
            escaped.push(ch);
        } else {
            let mut units = [0_u16; 2];
            for unit in ch.encode_utf16(&mut units) {
                escaped.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    escaped
}

struct CosmosRequest<'a> {
    method: Method,
    resource_type: &'a str,
    resource_link: String,
    path: String,
    headers: Vec<(&'static str, String)>,
    body: Option<Value>,
    content_type: &'static str,
}

impl<'a> CosmosRequest<'a> {
    fn new(method: Method, resource_type: &'a str, resource_link: String, path: String) -> Self {
        Self {
            method,
            resource_type,
            resource_link,
            path,
            headers: Vec::new(),
            body: None,
            content_type: "application/json",
        }
    }

    fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }

    fn json(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }

    fn query(mut self, body: Value) -> Self {
        self.body = Some(body);
        self.content_type = "application/query+json";
        self.headers.push(("x-ms-documentdb-isquery", "True".to_string()));
        self
    }
}

#[derive(Debug)]
struct CosmosResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

impl CosmosResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    fn continuation(&self) -> Option<String> {
        self.header("x-ms-continuation").filter(|value| !value.is_empty()).map(str::to_string)
    }

    fn request_charge(&self) -> f64 {
        self.header("x-ms-request-charge").and_then(|value| value.parse::<f64>().ok()).unwrap_or(0.0)
    }

    fn activity_id(&self) -> Option<&str> {
        self.header("x-ms-activity-id")
    }

    fn json(&self) -> Result<Value, String> {
        serde_json::from_str(&self.body).map_err(|e| format!("Invalid Azure Cosmos DB response JSON: {e}"))
    }
}

async fn send(client: &CosmosDbClient, request: CosmosRequest<'_>) -> Result<CosmosResponse, String> {
    let url = format!("{}{}", client.base_url, request.path);
    let mut waited = Duration::ZERO;
    let mut attempt = 0;
    loop {
        let date = rfc1123_now();
        let authorization = master_key_authorization(
            &request.method,
            request.resource_type,
            &request.resource_link,
            &date,
            &client.key,
        );
        let mut builder = client
            .http
            .request(request.method.clone(), &url)
            .header("authorization", authorization)
            .header("x-ms-date", &date)
            .header("x-ms-version", COSMOS_API_VERSION)
            .header("accept", "application/json");
        for (name, value) in &request.headers {
            let header_name = HeaderName::from_static(name);
            let header_value =
                HeaderValue::from_str(value).map_err(|_| format!("Invalid value for Azure Cosmos DB header {name}"))?;
            builder = builder.header(header_name, header_value);
        }
        if let Some(body) = &request.body {
            builder = builder.header("content-type", request.content_type).body(body.to_string());
        }
        let response = builder.send().await.map_err(|e| format!("Azure Cosmos DB request failed: {e}"))?;
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.text().await.map_err(|e| format!("Azure Cosmos DB response read failed: {e}"))?;
        let response = CosmosResponse { status, headers, body };
        if status == StatusCode::TOO_MANY_REQUESTS && attempt < MAX_THROTTLE_RETRIES {
            let retry_after = response
                .header("x-ms-retry-after-ms")
                .and_then(|value| value.parse::<u64>().ok())
                .map(Duration::from_millis)
                .unwrap_or(Duration::from_millis(100));
            if waited + retry_after <= MAX_THROTTLE_WAIT {
                tokio::time::sleep(retry_after).await;
                waited += retry_after;
                attempt += 1;
                continue;
            }
        }
        return Ok(response);
    }
}

fn is_gateway_unservable_query(response: &CosmosResponse) -> bool {
    response.status == StatusCode::BAD_REQUEST
        && (response.header("x-ms-substatus") == Some("1004")
            || response.body.contains("can not be directly served by the gateway")
            || response.body.contains("partitionedQueryExecutionInfoVersion"))
}

/// Generic 400 message the gateway returns for query syntax errors; the
/// query plan endpoint reports the actual error (see [`query_syntax_detail`]).
const GENERIC_INVALID_INPUT: &str = "One of the input values is invalid.";

/// Extracts a readable message from a service error body. Bodies may nest
/// `{ "code", "message" }` envelopes and embed an `{"Errors": [...]}` or
/// `{"errors": [{ "message", "location" }]}` object in the message text.
fn error_detail(body: &str) -> String {
    let mut message = body.trim().to_string();
    for _ in 0..4 {
        match serde_json::from_str::<Value>(&message) {
            Ok(value) if value.get("message").is_some_and(Value::is_string) => {
                message = value["message"].as_str().unwrap_or_default().to_string();
            }
            _ => break,
        }
    }
    for marker in ["{\"errors\":", "{\"Errors\":"] {
        let Some(start) = message.find(marker) else {
            continue;
        };
        let Some(Ok(errors)) = serde_json::Deserializer::from_str(&message[start..]).into_iter::<Value>().next() else {
            continue;
        };
        let list = errors.get("errors").or_else(|| errors.get("Errors")).and_then(Value::as_array);
        let messages: Vec<String> = list
            .into_iter()
            .flatten()
            .filter_map(|error| match error {
                Value::String(text) => Some(text.clone()),
                Value::Object(object) => {
                    let text = object.get("message").and_then(Value::as_str)?;
                    let location = object.get("location");
                    let start = location.and_then(|l| l.get("start")).and_then(Value::as_u64);
                    let end = location.and_then(|l| l.get("end")).and_then(Value::as_u64);
                    Some(match (start, end) {
                        (Some(start), Some(end)) => format!("{text} (characters {start}-{end})"),
                        _ => text.to_string(),
                    })
                }
                _ => None,
            })
            .collect();
        if !messages.is_empty() {
            return messages.join("; ");
        }
    }
    let first_line = message.lines().next().unwrap_or_default().trim();
    first_line.strip_prefix("Message: ").unwrap_or(first_line).to_string()
}

fn response_error(context: &str, response: &CosmosResponse) -> String {
    response_error_with_detail(context, response, error_detail(&response.body))
}

fn response_error_with_detail(context: &str, response: &CosmosResponse, detail: String) -> String {
    let code = serde_json::from_str::<Value>(&response.body)
        .ok()
        .and_then(|value| value.get("code").and_then(Value::as_str).map(str::to_string));
    let mut message = format!("Azure Cosmos DB {context} failed ({}", response.status.as_u16());
    if let Some(code) = code {
        message.push(' ');
        message.push_str(&code);
    }
    message.push(')');
    if !detail.is_empty() {
        message.push_str(": ");
        message.push_str(&detail);
    }
    if let Some(activity_id) = response.activity_id() {
        message.push_str(&format!(" [activity id: {activity_id}]"));
    }
    message
}

fn database_link(database: &str) -> String {
    format!("dbs/{database}")
}

fn container_link(database: &str, container: &str) -> String {
    format!("dbs/{database}/colls/{container}")
}

fn document_link(database: &str, container: &str, id: &str) -> String {
    format!("dbs/{database}/colls/{container}/docs/{id}")
}

fn database_path(database: &str) -> String {
    format!("/dbs/{}", encode_path_segment(database))
}

fn container_path(database: &str, container: &str) -> String {
    format!("{}/colls/{}", database_path(database), encode_path_segment(container))
}

fn document_path(database: &str, container: &str, id: &str) -> String {
    format!("{}/docs/{}", container_path(database, container), encode_path_segment(id))
}

/// Reads every page of a metadata feed (`/dbs`, `/colls`, `/pkranges`).
async fn read_feed(
    client: &CosmosDbClient,
    resource_type: &str,
    resource_link: String,
    path: String,
    items_key: &str,
    context: &str,
) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    let mut continuation = None::<String>;
    loop {
        let mut request = CosmosRequest::new(Method::GET, resource_type, resource_link.clone(), path.clone());
        if let Some(token) = continuation.take() {
            request = request.header("x-ms-continuation", token);
        }
        let response = send(client, request).await?;
        if !response.status.is_success() {
            return Err(response_error(context, &response));
        }
        let body = response.json()?;
        items.extend(body.get(items_key).and_then(Value::as_array).cloned().unwrap_or_default());
        match response.continuation() {
            Some(token) => continuation = Some(token),
            None => return Ok(items),
        }
    }
}

// ---------------------------------------------------------------------------
// Account and metadata
// ---------------------------------------------------------------------------

async fn read_account(client: &CosmosDbClient) -> Result<Value, String> {
    let response = send(client, CosmosRequest::new(Method::GET, "", String::new(), "/".to_string())).await?;
    if !response.status.is_success() {
        return Err(response_error("connection test", &response));
    }
    response.json()
}

pub async fn test_connection(client: &CosmosDbClient, timeout: Duration) -> Result<(), String> {
    with_connection_timeout("Azure Cosmos DB", timeout, async { read_account(client).await.map(|_| ()) }).await
}

pub async fn database_connection_info(client: &CosmosDbClient) -> Result<DatabaseConnectionInfo, String> {
    let account = read_account(client).await?;
    let account_id = account.get("id").and_then(Value::as_str).map(str::to_string);
    let region = account
        .get("writableLocations")
        .and_then(Value::as_array)
        .and_then(|locations| locations.first())
        .and_then(|location| location.get("name"))
        .and_then(Value::as_str);
    Ok(DatabaseConnectionInfo {
        product_name: Some("Azure Cosmos DB for NoSQL".to_string()),
        product_version: Some(format!("REST API {COSMOS_API_VERSION}")),
        server_comment: match (account_id.as_deref(), region) {
            (Some(id), Some(region)) => Some(format!("{id} ({region})")),
            (Some(id), None) => Some(id.to_string()),
            _ => None,
        },
        ..Default::default()
    })
}

pub async fn list_databases(client: &CosmosDbClient) -> Result<Vec<String>, String> {
    let items = read_feed(client, "dbs", String::new(), "/dbs".to_string(), "Databases", "list databases").await?;
    Ok(items.iter().filter_map(|item| item.get("id").and_then(Value::as_str)).map(str::to_string).collect())
}

/// Container summary for the object tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CosmosContainerInfo {
    pub id: String,
    pub partition_key_paths: Vec<String>,
}

pub async fn list_containers(client: &CosmosDbClient, database: &str) -> Result<Vec<CosmosContainerInfo>, String> {
    let items = read_feed(
        client,
        "colls",
        database_link(database),
        format!("{}/colls", database_path(database)),
        "DocumentCollections",
        "list containers",
    )
    .await?;
    let mut containers = Vec::with_capacity(items.len());
    for item in items {
        let Some(id) = item.get("id").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        let definition = PartitionKeyDefinition::from_container(&item);
        client.cache_partition_key(database, &id, definition.clone());
        containers.push(CosmosContainerInfo { id, partition_key_paths: definition.paths });
    }
    Ok(containers)
}

async fn partition_key_definition(
    client: &CosmosDbClient,
    database: &str,
    container: &str,
) -> Result<PartitionKeyDefinition, String> {
    if let Some(definition) = client.cached_partition_key(database, container) {
        return Ok(definition);
    }
    let response = send(
        client,
        CosmosRequest::new(
            Method::GET,
            "colls",
            container_link(database, container),
            container_path(database, container),
        ),
    )
    .await?;
    if !response.status.is_success() {
        return Err(response_error("read container", &response));
    }
    let definition = PartitionKeyDefinition::from_container(&response.json()?);
    client.cache_partition_key(database, container, definition.clone());
    Ok(definition)
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub async fn get_columns(client: &CosmosDbClient, database: &str, container: &str) -> Result<Vec<ColumnInfo>, String> {
    let definition = partition_key_definition(client, database, container).await?;
    let mut columns = vec![ColumnInfo {
        name: "id".to_string(),
        data_type: "string".to_string(),
        is_primary_key: true,
        is_nullable: false,
        ..Default::default()
    }];
    let mut seen: HashSet<String> = ["id".to_string()].into_iter().collect();
    let hierarchical = definition.kind.eq_ignore_ascii_case("MultiHash");
    for path in &definition.paths {
        if let Some(top_level) = partition_key_segments(path).first() {
            if seen.insert(top_level.clone()) {
                columns.push(ColumnInfo {
                    name: top_level.clone(),
                    data_type: "partition key".to_string(),
                    is_nullable: true,
                    comment: Some(if hierarchical {
                        format!("Hierarchical partition key {path}")
                    } else {
                        format!("Partition key {path}")
                    }),
                    ..Default::default()
                });
            }
        }
    }
    // A sample is best effort: metadata stays usable even when the query fails.
    let sample = query_page(client, database, container, "SELECT * FROM c", Vec::new(), None, COLUMN_SAMPLE_SIZE, None)
        .await
        .map(|page| page.documents)
        .unwrap_or_default();
    for document in &sample {
        let Some(object) = document.as_object() else {
            continue;
        };
        for (name, value) in object {
            if SYSTEM_PROPERTIES.contains(&name.as_str()) || !seen.insert(name.clone()) {
                continue;
            }
            columns.push(ColumnInfo {
                name: name.clone(),
                data_type: json_type_name(value).to_string(),
                is_nullable: true,
                ..Default::default()
            });
        }
    }
    for name in SYSTEM_PROPERTIES {
        if seen.insert(name.to_string()) {
            columns.push(ColumnInfo {
                name: name.to_string(),
                data_type: if name == "_ts" { "number" } else { "string" }.to_string(),
                is_nullable: true,
                comment: Some("System property".to_string()),
                ..Default::default()
            });
        }
    }
    Ok(columns)
}

// ---------------------------------------------------------------------------
// Partition keys and document identity
// ---------------------------------------------------------------------------

fn partition_key_segments(path: &str) -> Vec<String> {
    path.trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| segment.trim_matches('"').to_string())
        .collect()
}

/// Extracts the partition key values from a document, in the JSON array form
/// used by the `x-ms-documentdb-partitionkey` header. A missing value maps to
/// `{}` ("undefined"), matching the service and the official SDKs.
fn extract_partition_key(definition: &PartitionKeyDefinition, document: &Value) -> Result<Value, String> {
    if definition.paths.is_empty() {
        // Legacy non-partitioned containers.
        return Ok(Value::Array(Vec::new()));
    }
    let mut values = Vec::with_capacity(definition.paths.len());
    for path in &definition.paths {
        let mut current = Some(document);
        for segment in partition_key_segments(path) {
            current = current.and_then(|value| value.get(&segment));
        }
        match current {
            None => values.push(Value::Object(Map::new())),
            Some(value @ (Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null)) => {
                values.push(value.clone())
            }
            Some(_) => {
                return Err(format!("Partition key {path} must be a string, number, boolean or null"));
            }
        }
    }
    Ok(Value::Array(values))
}

fn document_identity(id: &str, partition_key: &Value) -> Value {
    serde_json::json!({ "id": id, "partitionKey": partition_key })
}

#[derive(Debug, Clone, PartialEq)]
struct DocumentIdentity {
    id: String,
    partition_key: Value,
}

fn decode_identity(raw: &str) -> Result<DocumentIdentity, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|e| format!("Invalid Azure Cosmos DB document identity: {e}"))?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Azure Cosmos DB document identity requires a string \"id\"")?
        .to_string();
    let partition_key = value.get("partitionKey").cloned().unwrap_or(Value::Array(Vec::new()));
    if !partition_key.is_array() {
        return Err("Azure Cosmos DB document identity requires a \"partitionKey\" array".to_string());
    }
    Ok(DocumentIdentity { id, partition_key })
}

fn is_synthetic_identity(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == 2 && object.get("id").is_some_and(Value::is_string) && object.contains_key("partitionKey")
    })
}

fn with_identity(mut document: Value, definition: &PartitionKeyDefinition) -> Value {
    let Some(id) = document.get("id").and_then(Value::as_str).map(str::to_string) else {
        return document;
    };
    let Ok(partition_key) = extract_partition_key(definition, &document) else {
        return document;
    };
    if let Value::Object(object) = &mut document {
        object.insert(IDENTITY_FIELD.to_string(), document_identity(&id, &partition_key));
    }
    document
}

/// Prepares an edited document for the service: drops the synthetic identity
/// and server-managed system properties, and returns the ETag it carried.
fn prepare_write_body(document: &mut Map<String, Value>) -> Option<String> {
    if document.get(IDENTITY_FIELD).is_some_and(is_synthetic_identity) {
        document.remove(IDENTITY_FIELD);
    }
    let etag = document.get("_etag").and_then(Value::as_str).map(str::to_string);
    for name in SYSTEM_PROPERTIES {
        document.remove(name);
    }
    etag
}

fn parse_document_object(doc_json: &str) -> Result<Map<String, Value>, String> {
    match serde_json::from_str::<Value>(doc_json).map_err(|e| format!("Invalid JSON: {e}"))? {
        Value::Object(object) => Ok(object),
        _ => Err("Azure Cosmos DB documents must be JSON objects".to_string()),
    }
}

fn document_id(document: &Map<String, Value>) -> Result<Option<String>, String> {
    match document.get("id") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) if id.is_empty() => Err("Document \"id\" must not be empty".to_string()),
        Some(Value::String(id)) => {
            if id.contains(['/', '\\', '?', '#']) {
                return Err("Document \"id\" cannot contain '/', '\\', '?' or '#'".to_string());
            }
            Ok(Some(id.clone()))
        }
        Some(_) => Err("Document \"id\" must be a string".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

struct QueryPage {
    documents: Vec<Value>,
    continuation: Option<String>,
    request_charge: f64,
    activity_id: Option<String>,
}

/// Prefix of continuation tokens that belong to a query sent straight to one
/// physical partition (see [`query_page`]). Range ids never contain `:`.
const RANGE_CURSOR_PREFIX: &str = "dbx-range:";

/// Where a query page is executed.
#[derive(Debug, Clone, PartialEq)]
enum QueryRoute {
    /// The gateway, with cross-partition execution enabled (or scoped to the
    /// logical partition in the partition key header).
    Gateway,
    /// One physical partition key range. On a container with a single
    /// physical partition this serves the queries the gateway rejects
    /// cross-partition (ORDER BY, TOP, OFFSET/LIMIT, DISTINCT, aggregates,
    /// GROUP BY) with complete, correctly ordered results.
    Range(String),
}

fn decode_query_cursor(cursor: Option<&str>) -> (QueryRoute, Option<String>) {
    match cursor.filter(|cursor| !cursor.is_empty()) {
        Some(cursor) => match cursor.strip_prefix(RANGE_CURSOR_PREFIX).and_then(|rest| rest.split_once(':')) {
            Some((range, token)) => (QueryRoute::Range(range.to_string()), Some(token.to_string())),
            None => (QueryRoute::Gateway, Some(cursor.to_string())),
        },
        None => (QueryRoute::Gateway, None),
    }
}

fn encode_query_cursor(route: &QueryRoute, token: String) -> String {
    match route {
        QueryRoute::Gateway => token,
        QueryRoute::Range(range) => format!("{RANGE_CURSOR_PREFIX}{range}:{token}"),
    }
}

/// Runs one query and keeps reading pages until `limit` documents arrive or
/// the result set ends. When the gateway cannot serve a cross-partition
/// query and the container has a single physical partition, the query is
/// retried against that partition.
#[allow(clippy::too_many_arguments)]
async fn query_page(
    client: &CosmosDbClient,
    database: &str,
    container: &str,
    query: &str,
    parameters: Vec<Value>,
    partition_key: Option<&Value>,
    limit: usize,
    continuation: Option<&str>,
) -> Result<QueryPage, String> {
    let body = serde_json::json!({ "query": query, "parameters": parameters });
    let mut documents = Vec::new();
    let (mut route, mut token) = decode_query_cursor(continuation);
    if partition_key.is_some() {
        route = QueryRoute::Gateway;
    }
    let mut request_charge = 0.0;
    let mut activity_id = None;
    for _ in 0..MAX_PAGE_ROUND_TRIPS {
        let remaining = limit.saturating_sub(documents.len()).max(1);
        let mut request = CosmosRequest::new(
            Method::POST,
            "docs",
            container_link(database, container),
            format!("{}/docs", container_path(database, container)),
        )
        .query(body.clone())
        .header("x-ms-max-item-count", remaining.to_string());
        request = match (partition_key, &route) {
            (Some(value), _) => request.header("x-ms-documentdb-partitionkey", ascii_json(value)),
            (None, QueryRoute::Range(range)) => request.header("x-ms-documentdb-partitionkeyrangeid", range.clone()),
            (None, QueryRoute::Gateway) => request.header("x-ms-documentdb-query-enablecrosspartition", "True"),
        };
        if let Some(value) = token.take() {
            request = request.header("x-ms-continuation", value);
        }
        let response = send(client, request).await?;
        if is_gateway_unservable_query(&response) {
            let ranges = partition_key_ranges(client, database, container).await?;
            if let ([range], QueryRoute::Gateway, true) = (ranges.as_slice(), &route, documents.is_empty()) {
                route = QueryRoute::Range(range.clone());
                continue;
            }
            return Err(unservable_query_error(&response, ranges.len()));
        }
        if !response.status.is_success() {
            let mut detail = error_detail(&response.body);
            if response.status == StatusCode::BAD_REQUEST && detail == GENERIC_INVALID_INPUT {
                detail = query_syntax_detail(client, database, container, &body).await.unwrap_or(detail);
            }
            return Err(response_error_with_detail("query", &response, detail));
        }
        request_charge += response.request_charge();
        activity_id = response.activity_id().map(str::to_string).or(activity_id);
        let page = response.json()?;
        documents.extend(page.get("Documents").and_then(Value::as_array).cloned().unwrap_or_default());
        token = response.continuation();
        if token.is_none() || documents.len() >= limit {
            break;
        }
    }
    let continuation = token.map(|token| encode_query_cursor(&route, token));
    Ok(QueryPage { documents, continuation, request_charge, activity_id })
}

/// Asks the query plan endpoint to parse the query: unlike query execution it
/// reports syntax errors with their position.
async fn query_syntax_detail(client: &CosmosDbClient, database: &str, container: &str, body: &Value) -> Option<String> {
    let request = CosmosRequest::new(
        Method::POST,
        "docs",
        container_link(database, container),
        format!("{}/docs", container_path(database, container)),
    )
    .query(body.clone())
    .header("x-ms-documentdb-query-enablecrosspartition", "True")
    .header("x-ms-cosmos-is-query-plan-request", "True")
    .header("x-ms-cosmos-query-version", "1.4")
    .header(
        "x-ms-cosmos-supported-query-features",
        "Aggregate, CompositeAggregate, Distinct, GroupBy, MultipleAggregates, MultipleOrderBy, OffsetAndLimit, \
         OrderBy, Top, NonValueAggregate",
    );
    let response = send(client, request).await.ok()?;
    if response.status.is_success() {
        return None;
    }
    let detail = error_detail(&response.body);
    (!detail.is_empty() && detail != GENERIC_INVALID_INPUT).then_some(detail)
}

fn unservable_query_error(response: &CosmosResponse, physical_partitions: usize) -> String {
    let mut message = format!(
        "This Azure Cosmos DB query (ORDER BY, aggregates, DISTINCT, GROUP BY, OFFSET/LIMIT or TOP) needs results \
         merged across the container's {physical_partitions} physical partitions, which DBX does not do yet. \
         Filter on the partition key, scope the query with a `/* partitionKey: [\"value\"] */` comment, or remove \
         those clauses."
    );
    if let Some(activity_id) = response.activity_id() {
        message.push_str(&format!(" [activity id: {activity_id}]"));
    }
    message
}

/// Partition key values fixed by equality conditions on every partition key
/// path at the top level of a document-browser filter. Such a filter can be
/// sent as a single-partition query.
fn partition_key_from_filter(definition: &PartitionKeyDefinition, filter: Option<&str>) -> Option<Value> {
    let filter = serde_json::from_str::<Value>(filter?).ok()?;
    let filter = filter.as_object()?;
    if definition.paths.is_empty() {
        return None;
    }
    let mut values = Vec::with_capacity(definition.paths.len());
    for path in &definition.paths {
        let key = partition_key_segments(path).join(".");
        let value = match filter.get(&key)? {
            Value::Object(condition) if condition.len() == 1 => condition.get("$eq")?.clone(),
            Value::Object(_) | Value::Array(_) => return None,
            // `{ field: null }` also matches missing fields, which is not one partition.
            Value::Null => return None,
            scalar => scalar.clone(),
        };
        if value.is_object() || value.is_array() || value.is_null() {
            return None;
        }
        values.push(value);
    }
    Some(Value::Array(values))
}

/// Quotes a field path for Cosmos SQL: `a.b` -> `c["a"]["b"]`, `items.0` -> `c["items"][0]`.
fn field_reference(path: &str) -> Result<String, String> {
    field_reference_in("c", path)
}

fn field_reference_in(root: &str, path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("Filter field name must not be empty".to_string());
    }
    let mut reference = root.to_string();
    for segment in path.split('.') {
        if segment.is_empty() {
            return Err(format!("Invalid field path: {path}"));
        }
        if segment.bytes().all(|b| b.is_ascii_digit()) && segment.len() < 10 {
            reference.push_str(&format!("[{segment}]"));
        } else {
            reference.push('[');
            reference.push_str(&Value::String(segment.to_string()).to_string());
            reference.push(']');
        }
    }
    Ok(reference)
}

struct FilterBuilder {
    parameters: Vec<Value>,
    /// Counter for `$elemMatch` iteration aliases (`e1`, `e2`, ...).
    aliases: usize,
}

impl FilterBuilder {
    fn parameter(&mut self, value: Value) -> String {
        let name = format!("@p{}", self.parameters.len());
        self.parameters.push(serde_json::json!({ "name": name, "value": value }));
        name
    }

    fn document(&mut self, filter: &Map<String, Value>, root: &str) -> Result<String, String> {
        let mut clauses = Vec::new();
        for (key, value) in filter {
            clauses.push(match key.as_str() {
                "$and" | "$or" | "$nor" => {
                    let items = value.as_array().ok_or_else(|| format!("{key} expects an array"))?;
                    let parts = items
                        .iter()
                        .map(|item| {
                            item.as_object()
                                .ok_or_else(|| format!("{key} items must be objects"))
                                .and_then(|object| self.document(object, root))
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    if parts.is_empty() {
                        continue;
                    }
                    let joiner = if key == "$and" { " AND " } else { " OR " };
                    let joined = format!("({})", parts.join(joiner));
                    if key == "$nor" {
                        format!("NOT {joined}")
                    } else {
                        joined
                    }
                }
                other if other.starts_with('$') => {
                    return Err(format!("Unsupported filter operator at the top level: {other}"));
                }
                field => {
                    let reference = field_reference_in(root, field)?;
                    self.condition(&reference, value)?
                }
            });
        }
        Ok(if clauses.is_empty() { "true".to_string() } else { clauses.join(" AND ") })
    }

    fn condition(&mut self, reference: &str, condition: &Value) -> Result<String, String> {
        let reference = reference.to_string();
        let operators = condition.as_object().filter(|object| object.keys().any(|key| key.starts_with('$')));
        let Some(operators) = operators else {
            return Ok(self.equals(&reference, condition));
        };
        let mut clauses = Vec::new();
        let regex_options = operators.get("$options").and_then(Value::as_str).unwrap_or("");
        for (operator, value) in operators {
            clauses.push(match operator.as_str() {
                "$eq" => self.equals(&reference, value),
                "$ne" => format!("NOT ({})", self.equals(&reference, value)),
                "$gt" => format!("{reference} > {}", self.parameter(value.clone())),
                "$gte" => format!("{reference} >= {}", self.parameter(value.clone())),
                "$lt" => format!("{reference} < {}", self.parameter(value.clone())),
                "$lte" => format!("{reference} <= {}", self.parameter(value.clone())),
                "$in" | "$nin" => {
                    if !value.is_array() {
                        return Err(format!("{operator} expects an array"));
                    }
                    let clause = format!("ARRAY_CONTAINS({}, {reference})", self.parameter(value.clone()));
                    if operator == "$in" {
                        clause
                    } else {
                        format!("NOT {clause}")
                    }
                }
                "$exists" => {
                    if value.as_bool().unwrap_or(true) {
                        format!("IS_DEFINED({reference})")
                    } else {
                        format!("NOT IS_DEFINED({reference})")
                    }
                }
                "$regex" => {
                    let pattern = value.as_str().ok_or("$regex expects a string")?;
                    let flags: String = regex_options.chars().filter(|c| matches!(c, 'i' | 'm' | 's' | 'x')).collect();
                    let pattern = self.parameter(Value::String(pattern.to_string()));
                    if flags.is_empty() {
                        format!("RegexMatch({reference}, {pattern})")
                    } else {
                        format!("RegexMatch({reference}, {pattern}, {})", self.parameter(Value::String(flags)))
                    }
                }
                "$options" => continue,
                "$contains" => format!("CONTAINS({reference}, {})", self.parameter(value.clone())),
                "$notContains" => format!("NOT CONTAINS({reference}, {})", self.parameter(value.clone())),
                "$beginsWith" => format!("STARTSWITH({reference}, {})", self.parameter(value.clone())),
                "$not" => {
                    let inner = self.condition(&reference, value)?;
                    format!("NOT ({inner})")
                }
                "$elemMatch" => {
                    let element = value.as_object().ok_or("$elemMatch expects an object")?;
                    self.aliases += 1;
                    let alias = format!("e{}", self.aliases);
                    // `{ $elemMatch: { $gt: 5 } }` tests the element itself;
                    // `{ $elemMatch: { qty: 5 } }` tests fields of object elements.
                    let tests_element = element.keys().all(|key| key.starts_with('$'))
                        && !element.keys().any(|key| matches!(key.as_str(), "$and" | "$or" | "$nor"));
                    let inner =
                        if tests_element { self.condition(&alias, value)? } else { self.document(element, &alias)? };
                    format!("EXISTS(SELECT VALUE {alias} FROM {alias} IN {reference} WHERE {inner})")
                }
                other => {
                    return Err(format!(
                        "Unsupported filter operator {other}. Supported: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, \
                         $exists, $regex, $contains, $notContains, $beginsWith, $not, $elemMatch, $and, $or, $nor"
                    ));
                }
            });
        }
        Ok(if clauses.len() == 1 { clauses.remove(0) } else { format!("({})", clauses.join(" AND ")) })
    }

    /// Mongo-style null equality: matches both null and missing fields.
    fn equals(&mut self, reference: &str, value: &Value) -> String {
        if value.is_null() {
            return format!("(NOT IS_DEFINED({reference}) OR IS_NULL({reference}))");
        }
        format!("{reference} = {}", self.parameter(value.clone()))
    }
}

/// Converts a document-browser filter (Mongo-style JSON) to a parameterized
/// Cosmos SQL condition. Returns `None` for an empty filter.
fn build_where_clause(filter: Option<&str>) -> Result<Option<(String, Vec<Value>)>, String> {
    let Some(filter) = filter.map(str::trim).filter(|f| !f.is_empty() && *f != "{}") else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(filter).map_err(|e| format!("Invalid filter JSON: {e}"))?;
    let object = parsed.as_object().ok_or("Azure Cosmos DB filter must be a JSON object")?;
    let mut builder = FilterBuilder { parameters: Vec::new(), aliases: 0 };
    let clause = builder.document(object, "c")?;
    Ok(Some((clause, builder.parameters)))
}

fn build_order_by(sort: Option<&str>) -> Result<Option<String>, String> {
    let Some(sort) = sort.map(str::trim).filter(|s| !s.is_empty() && *s != "{}" && *s != "[]") else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(sort).map_err(|e| format!("Invalid sort JSON: {e}"))?;
    let mut entries = Vec::new();
    let mut push = |field: &str, direction: &Value| -> Result<(), String> {
        let descending = match direction {
            Value::Number(n) => n.as_i64() == Some(-1),
            Value::String(s) => s.eq_ignore_ascii_case("desc") || s == "-1",
            _ => false,
        };
        entries.push(format!("{} {}", field_reference(field)?, if descending { "DESC" } else { "ASC" }));
        Ok(())
    };
    match &parsed {
        Value::Object(object) => {
            for (field, direction) in object {
                push(field, direction)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                match item {
                    Value::String(field) => push(field, &Value::String("asc".to_string()))?,
                    Value::Object(object) => {
                        for (field, direction) in object {
                            push(field, direction)?;
                        }
                    }
                    _ => return Err("Sort entries must be field names or {field: direction} objects".to_string()),
                }
            }
        }
        _ => return Err("Azure Cosmos DB sort must be a JSON object or array".to_string()),
    }
    Ok((!entries.is_empty()).then(|| format!("ORDER BY {}", entries.join(", "))))
}

fn browse_query(filter: Option<&str>, sort: Option<&str>) -> Result<(String, Vec<Value>), String> {
    let mut query = "SELECT * FROM c".to_string();
    let mut parameters = Vec::new();
    if let Some((clause, params)) = build_where_clause(filter)? {
        query.push_str(" WHERE ");
        query.push_str(&clause);
        parameters = params;
    }
    if let Some(order_by) = build_order_by(sort)? {
        query.push(' ');
        query.push_str(&order_by);
    }
    Ok((query, parameters))
}

/// Document-browser page. Cosmos queries paginate with continuation tokens,
/// so this always uses cursor pagination.
pub async fn find_documents(
    client: &CosmosDbClient,
    database: &str,
    container: &str,
    limit: i64,
    filter: Option<&str>,
    sort: Option<&str>,
    cursor: Option<&str>,
) -> Result<DocumentQueryResult, String> {
    let limit = usize::try_from(limit.max(1)).unwrap_or(100);
    let definition = partition_key_definition(client, database, container).await?;
    let (query, parameters) = browse_query(filter, sort)?;
    let cursor = cursor.filter(|c| !c.is_empty());
    let partition_key = partition_key_from_filter(&definition, filter);
    let page =
        query_page(client, database, container, &query, parameters, partition_key.as_ref(), limit, cursor).await?;
    let documents: Vec<Value> = page.documents.into_iter().map(|doc| with_identity(doc, &definition)).collect();
    let raw_documents = documents
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Azure Cosmos DB document serialization failed: {e}"))?;

    let has_filter = build_where_clause(filter)?.is_some();
    let exact_total = if !has_filter { container_document_count(client, database, container).await.ok() } else { None };
    let (total, total_is_exact) = match exact_total {
        Some(total) => (total, true),
        None => (
            documents.len() as u64 + u64::from(page.continuation.is_some()),
            page.continuation.is_none() && cursor.is_none(),
        ),
    };
    Ok(DocumentQueryResult {
        documents,
        raw_documents: Some(raw_documents),
        extended_documents: None,
        total,
        total_is_exact,
        next_cursor: page.continuation,
    })
}

pub async fn close_cursor(_client: &CosmosDbClient, _cursor: &str) -> Result<(), String> {
    Ok(())
}

/// Document count from the container quota headers. The service maintains it
/// asynchronously, so very recent writes may not be reflected yet.
async fn container_document_count(client: &CosmosDbClient, database: &str, container: &str) -> Result<u64, String> {
    let response = send(
        client,
        CosmosRequest::new(
            Method::GET,
            "colls",
            container_link(database, container),
            container_path(database, container),
        )
        .header("x-ms-documentdb-populatequotainfo", "True"),
    )
    .await?;
    if !response.status.is_success() {
        return Err(response_error("read container", &response));
    }
    response
        .header("x-ms-resource-usage")
        .and_then(|usage| {
            usage.split(';').find_map(|entry| {
                let (name, value) = entry.split_once('=')?;
                name.trim().eq_ignore_ascii_case("documentsCount").then(|| value.trim().parse::<u64>().ok()).flatten()
            })
        })
        .ok_or_else(|| "Azure Cosmos DB did not report a document count".to_string())
}

/// Live physical partition key ranges. Ranges that split are listed as
/// `parents` of their children and are skipped.
async fn partition_key_ranges(client: &CosmosDbClient, database: &str, container: &str) -> Result<Vec<String>, String> {
    let ranges = read_feed(
        client,
        "pkranges",
        container_link(database, container),
        format!("{}/pkranges", container_path(database, container)),
        "PartitionKeyRanges",
        "read partition key ranges",
    )
    .await?;
    let parents: HashSet<String> = ranges
        .iter()
        .filter_map(|range| range.get("parents").and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    Ok(ranges
        .iter()
        .filter_map(|range| range.get("id").and_then(Value::as_str))
        .filter(|id| !parents.contains(*id))
        .map(str::to_string)
        .collect())
}

/// Exact count: without a filter this reads the container quota; with a
/// filter it runs `SELECT VALUE COUNT(1)` on each physical partition (which
/// the gateway serves as single-partition queries) and sums partial results.
pub async fn count_documents(
    client: &CosmosDbClient,
    database: &str,
    container: &str,
    filter: Option<&str>,
) -> Result<u64, String> {
    let Some((clause, parameters)) = build_where_clause(filter)? else {
        return container_document_count(client, database, container).await;
    };
    let query = format!("SELECT VALUE COUNT(1) FROM c WHERE {clause}");
    let body = serde_json::json!({ "query": query, "parameters": parameters });
    let mut total = 0_u64;
    for range in partition_key_ranges(client, database, container).await? {
        let mut continuation = None::<String>;
        loop {
            let mut request = CosmosRequest::new(
                Method::POST,
                "docs",
                container_link(database, container),
                format!("{}/docs", container_path(database, container)),
            )
            .query(body.clone())
            .header("x-ms-documentdb-partitionkeyrangeid", range.clone());
            if let Some(token) = continuation.take() {
                request = request.header("x-ms-continuation", token);
            }
            let response = send(client, request).await?;
            if !response.status.is_success() {
                return Err(response_error("count", &response));
            }
            let page = response.json()?;
            for value in page.get("Documents").and_then(Value::as_array).into_iter().flatten() {
                total += value.as_u64().or_else(|| value.get("item").and_then(Value::as_u64)).unwrap_or(0);
            }
            match response.continuation() {
                Some(token) => continuation = Some(token),
                None => break,
            }
        }
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// Document writes
// ---------------------------------------------------------------------------

async fn create_document(
    client: &CosmosDbClient,
    database: &str,
    container: &str,
    document: &Map<String, Value>,
    partition_key: &Value,
) -> Result<(), String> {
    let response = send(
        client,
        CosmosRequest::new(
            Method::POST,
            "docs",
            container_link(database, container),
            format!("{}/docs", container_path(database, container)),
        )
        .header("x-ms-documentdb-partitionkey", ascii_json(partition_key))
        .json(Value::Object(document.clone())),
    )
    .await?;
    match response.status {
        status if status.is_success() => Ok(()),
        StatusCode::CONFLICT => Err(format!(
            "A document with id {} already exists in partition {}",
            document.get("id").map(Value::to_string).unwrap_or_default(),
            partition_key
        )),
        _ => Err(response_error("insert document", &response)),
    }
}

async fn read_document(
    client: &CosmosDbClient,
    database: &str,
    container: &str,
    identity: &DocumentIdentity,
) -> Result<Option<Value>, String> {
    let response = send(
        client,
        CosmosRequest::new(
            Method::GET,
            "docs",
            document_link(database, container, &identity.id),
            document_path(database, container, &identity.id),
        )
        .header("x-ms-documentdb-partitionkey", ascii_json(&identity.partition_key)),
    )
    .await?;
    match response.status {
        status if status.is_success() => response.json().map(Some),
        StatusCode::NOT_FOUND => Ok(None),
        _ => Err(response_error("read document", &response)),
    }
}

async fn delete_by_identity(
    client: &CosmosDbClient,
    database: &str,
    container: &str,
    identity: &DocumentIdentity,
    etag: Option<&str>,
) -> Result<(), String> {
    let mut request = CosmosRequest::new(
        Method::DELETE,
        "docs",
        document_link(database, container, &identity.id),
        document_path(database, container, &identity.id),
    )
    .header("x-ms-documentdb-partitionkey", ascii_json(&identity.partition_key));
    if let Some(etag) = etag {
        request = request.header("if-match", etag.to_string());
    }
    let response = send(client, request).await?;
    match response.status {
        status if status.is_success() => Ok(()),
        StatusCode::NOT_FOUND => Err(format!("Document {} was not found; it may have been deleted", identity.id)),
        StatusCode::PRECONDITION_FAILED => Err(concurrent_change_error(&identity.id)),
        _ => Err(response_error("delete document", &response)),
    }
}

fn concurrent_change_error(id: &str) -> String {
    format!("Document {id} was changed by another writer after it was loaded (ETag mismatch). Refresh and retry.")
}

/// Inserts a document and returns its serialized identity. A missing `id` is
/// generated, as in the Azure portal Data Explorer.
pub async fn insert_document(
    client: &CosmosDbClient,
    database: &str,
    container: &str,
    doc_json: &str,
) -> Result<String, String> {
    let mut document = parse_document_object(doc_json)?;
    prepare_write_body(&mut document);
    let id = match document_id(&document)? {
        Some(id) => id,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            document.insert("id".to_string(), Value::String(id.clone()));
            id
        }
    };
    let definition = partition_key_definition(client, database, container).await?;
    let partition_key = extract_partition_key(&definition, &Value::Object(document.clone()))?;
    create_document(client, database, container, &document, &partition_key).await?;
    Ok(document_identity(&id, &partition_key).to_string())
}

/// Replaces the document addressed by `identity_json`.
///
/// The replace is conditional on the ETag loaded with the document. When the
/// edit changes `id` or the partition key, the new document is created first
/// and the old one deleted afterwards (a partition key change cannot be one
/// atomic operation in Cosmos DB).
pub async fn update_document(
    client: &CosmosDbClient,
    database: &str,
    container: &str,
    identity_json: &str,
    doc_json: &str,
) -> Result<u64, String> {
    let current = decode_identity(identity_json)?;
    let mut document = parse_document_object(doc_json)?;
    let body_etag = prepare_write_body(&mut document);

    let stored = read_document(client, database, container, &current)
        .await?
        .ok_or_else(|| format!("Document {} was not found; it may have been deleted", current.id))?;
    let etag = body_etag.or_else(|| stored.get("_etag").and_then(Value::as_str).map(str::to_string));
    // The document browser shows the synthetic identity under `_id`, so a
    // stored `_id` value cannot be edited there. Keep it instead of dropping it.
    if let Some(native_id) = stored.get(IDENTITY_FIELD) {
        document.entry(IDENTITY_FIELD.to_string()).or_insert_with(|| native_id.clone());
    }

    let id = match document_id(&document)? {
        Some(id) => id,
        None => {
            document.insert("id".to_string(), Value::String(current.id.clone()));
            current.id.clone()
        }
    };
    let definition = partition_key_definition(client, database, container).await?;
    let partition_key = extract_partition_key(&definition, &Value::Object(document.clone()))?;
    let target = DocumentIdentity { id: id.clone(), partition_key: partition_key.clone() };

    if target != current {
        create_document(client, database, container, &document, &partition_key).await?;
        delete_by_identity(client, database, container, &current, etag.as_deref()).await.map_err(|error| {
            format!("Created the document under its new id/partition key, but removing the original failed: {error}")
        })?;
        return Ok(1);
    }

    let mut request = CosmosRequest::new(
        Method::PUT,
        "docs",
        document_link(database, container, &id),
        document_path(database, container, &id),
    )
    .header("x-ms-documentdb-partitionkey", ascii_json(&partition_key))
    .json(Value::Object(document));
    if let Some(etag) = etag {
        request = request.header("if-match", etag);
    }
    let response = send(client, request).await?;
    match response.status {
        status if status.is_success() => Ok(1),
        StatusCode::NOT_FOUND => Err(format!("Document {id} was not found; it may have been deleted")),
        StatusCode::PRECONDITION_FAILED => Err(concurrent_change_error(&id)),
        _ => Err(response_error("replace document", &response)),
    }
}

pub async fn delete_document(
    client: &CosmosDbClient,
    database: &str,
    container: &str,
    identity_json: &str,
) -> Result<u64, String> {
    let identity = decode_identity(identity_json)?;
    delete_by_identity(client, database, container, &identity, None).await?;
    Ok(1)
}

// ---------------------------------------------------------------------------
// Query editor
// ---------------------------------------------------------------------------

/// Settings written as comments in the query editor, for example
/// `/* partitionKey: ["tenant-1"] */`. Block comments stay inside the
/// statement the editor sends; `--` lines only apply when the whole editor
/// text runs, because the editor drops comments before a statement.
#[derive(Debug, Default, PartialEq)]
struct QueryDirectives {
    container: Option<String>,
    partition_key: Option<Value>,
}

fn parse_query_directives(source: &str) -> Result<QueryDirectives, String> {
    let mut directives = QueryDirectives::default();
    for comment in scan_sql(source).comments {
        for line in comment.lines() {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim();
            match name.trim().trim_start_matches('@').to_ascii_lowercase().as_str() {
                "container" if !value.is_empty() => directives.container = Some(value.to_string()),
                "partitionkey" | "partition key" if !value.is_empty() => {
                    let parsed: Value = serde_json::from_str(value).map_err(|e| {
                        format!("Invalid partitionKey directive (expected JSON such as [\"value\"]): {e}")
                    })?;
                    directives.partition_key =
                        Some(if parsed.is_array() { parsed } else { Value::Array(vec![parsed]) });
                }
                _ => {}
            }
        }
    }
    Ok(directives)
}

#[derive(Debug, PartialEq)]
enum SqlToken {
    Word(String),
    Quoted(String),
    Symbol(char),
}

#[derive(Debug)]
struct ScannedToken {
    depth: usize,
    token: SqlToken,
    /// Character range of the token in the source.
    start: usize,
    end: usize,
}

struct ScannedSql {
    tokens: Vec<ScannedToken>,
    comments: Vec<String>,
}

/// Minimal Cosmos SQL scanner: tokens with their parenthesis depth, plus the
/// text of every comment. String literals are single tokens.
fn scan_sql(source: &str) -> ScannedSql {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut comments = Vec::new();
    let mut depth = 0_usize;
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        let start = index;
        if ch == '-' && chars.get(index + 1) == Some(&'-') {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            comments.push(chars[start + 2..index].iter().collect());
            continue;
        }
        if ch == '/' && chars.get(index + 1) == Some(&'*') {
            index += 2;
            while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') {
                index += 1;
            }
            comments.push(chars[start + 2..index.min(chars.len())].iter().collect());
            index = (index + 2).min(chars.len());
            continue;
        }
        if ch == '\'' || ch == '"' {
            let mut value = String::new();
            index += 1;
            while index < chars.len() && chars[index] != ch {
                if chars[index] == '\\' && index + 1 < chars.len() {
                    index += 1;
                }
                value.push(chars[index]);
                index += 1;
            }
            index = (index + 1).min(chars.len());
            tokens.push(ScannedToken { depth, token: SqlToken::Quoted(value), start, end: index });
            continue;
        }
        if ch.is_alphanumeric() || ch == '_' {
            while index < chars.len() && (chars[index].is_alphanumeric() || chars[index] == '_') {
                index += 1;
            }
            let word = chars[start..index].iter().collect();
            tokens.push(ScannedToken { depth, token: SqlToken::Word(word), start, end: index });
            continue;
        }
        index += 1;
        match ch {
            '(' | '[' => {
                tokens.push(ScannedToken { depth, token: SqlToken::Symbol(ch), start, end: index });
                depth += 1;
            }
            ')' | ']' => {
                depth = depth.saturating_sub(1);
                tokens.push(ScannedToken { depth, token: SqlToken::Symbol(ch), start, end: index });
            }
            c if c.is_whitespace() => {}
            c => tokens.push(ScannedToken { depth, token: SqlToken::Symbol(c), start, end: index }),
        }
    }
    ScannedSql { tokens, comments }
}

/// The container named by the top-level FROM clause, plus the query to send.
#[derive(Debug, PartialEq)]
struct FromClause {
    /// `orders` in `FROM orders o`; in `FROM t IN orders.tags` the root of the
    /// IN expression.
    root: Option<String>,
    /// The root was written as a quoted container id (`FROM "order-items" o`).
    quoted: bool,
    /// Query text sent to the service. A quoted container id is not valid
    /// Cosmos SQL, so it is replaced with `ROOT`; the service always reads
    /// the container addressed by the request path.
    query: String,
}

fn analyze_from_clause(query: &str) -> FromClause {
    let unchanged = || FromClause { root: None, quoted: false, query: query.to_string() };
    let tokens = scan_sql(query).tokens;
    let Some(from) = tokens.iter().position(|token| {
        token.depth == 0 && matches!(&token.token, SqlToken::Word(word) if word.eq_ignore_ascii_case("FROM"))
    }) else {
        return unchanged();
    };
    let is_in = |index: usize| {
        tokens.get(index).is_some_and(|token| {
            token.depth == 0 && matches!(&token.token, SqlToken::Word(word) if word.eq_ignore_ascii_case("IN"))
        })
    };
    let root_index = if is_in(from + 2) { from + 3 } else { from + 1 };
    match tokens.get(root_index) {
        Some(ScannedToken { depth: 0, token: SqlToken::Word(word), .. }) => {
            FromClause { root: Some(word.clone()), quoted: false, query: query.to_string() }
        }
        Some(ScannedToken { depth: 0, token: SqlToken::Quoted(name), start, end }) => {
            let chars: Vec<char> = query.chars().collect();
            let rewritten: String = chars[..*start]
                .iter()
                .chain("ROOT".chars().collect::<Vec<_>>().iter())
                .chain(chars[*end..].iter())
                .collect();
            FromClause { root: Some(name.clone()), quoted: true, query: rewritten }
        }
        _ => unchanged(),
    }
}

fn resolve_query_container(
    from: &FromClause,
    directives: &QueryDirectives,
    containers: &[CosmosContainerInfo],
) -> Result<String, String> {
    let exists = |name: &str| containers.iter().find(|info| info.id == name).map(|info| info.id.clone());
    if let Some(container) = &directives.container {
        return exists(container).ok_or_else(|| format!("Container {container} does not exist in this database"));
    }
    if let Some(root) = &from.root {
        if let Some(container) = exists(root) {
            return Ok(container);
        }
        if from.quoted {
            return Err(format!("Container \"{root}\" does not exist in this database"));
        }
    }
    if let [only] = containers {
        return Ok(only.id.clone());
    }
    Err("Cannot tell which container to query. Name it in FROM, for example `SELECT * FROM orders o`; \
        quote ids that are not identifiers: `SELECT * FROM \"order-items\" o`."
        .to_string())
}

fn docs_to_table(documents: &[Value]) -> (Vec<String>, Vec<String>, Vec<Vec<Value>>) {
    if !documents.iter().all(Value::is_object) {
        let rows = documents
            .iter()
            .map(|value| match value {
                Value::Array(_) | Value::Object(_) => vec![Value::String(value.to_string())],
                other => vec![other.clone()],
            })
            .collect();
        return (vec!["value".to_string()], vec!["json".to_string()], rows);
    }
    let mut columns = Vec::<String>::new();
    let mut indexes = HashMap::<String, usize>::new();
    let mut json_columns = HashSet::<usize>::new();
    let mut rows = Vec::<Vec<Value>>::with_capacity(documents.len());
    for document in documents {
        let mut row = vec![Value::Null; columns.len()];
        for (key, value) in document.as_object().into_iter().flatten() {
            let index = *indexes.entry(key.clone()).or_insert_with(|| {
                columns.push(key.clone());
                for previous in rows.iter_mut() {
                    previous.push(Value::Null);
                }
                row.push(Value::Null);
                columns.len() - 1
            });
            if matches!(value, Value::Array(_) | Value::Object(_)) {
                json_columns.insert(index);
                row[index] = Value::String(value.to_string());
            } else {
                row[index] = value.clone();
            }
        }
        rows.push(row);
    }
    let column_types = (0..columns.len())
        .map(|index| {
            if json_columns.contains(&index) {
                return "json".to_string();
            }
            let mut inferred = None;
            for value in rows.iter().filter_map(|row| row.get(index)) {
                let kind = match value {
                    Value::Null => continue,
                    Value::Bool(_) => "boolean",
                    Value::Number(_) => "number",
                    Value::String(_) => "text",
                    Value::Array(_) | Value::Object(_) => "json",
                };
                inferred = match inferred {
                    None => Some(kind),
                    Some(existing) if existing == kind => Some(existing),
                    Some(_) => Some("json"),
                };
            }
            inferred.unwrap_or("unknown").to_string()
        })
        .collect();
    (columns, column_types, rows)
}

fn table_result(
    columns: Vec<String>,
    column_types: Vec<String>,
    rows: Vec<Vec<Value>>,
    start: Instant,
    truncated: bool,
    messages: Vec<QueryMessage>,
) -> QueryResult {
    QueryResult {
        affected_rows: rows.len() as u64,
        columns,
        column_types,
        deferred_large_value_cells: Vec::new(),
        column_sortables: vec![],
        spatial_columns: vec![],
        raw_key_cells: Vec::new(),
        spatial_values: vec![],
        rows,
        execution_time_ms: start.elapsed().as_millis(),
        server_execute_time_us: None,
        query_timings_ms: None,
        truncated,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages,
    }
}

/// Runs a Cosmos SQL query from the query editor. The NoSQL query language is
/// read-only, so this never modifies data.
pub async fn execute_query(
    client: &CosmosDbClient,
    database: Option<&str>,
    source: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let directives = parse_query_directives(source)?;
    let query = strip_sql_comments(source);
    let query = query.trim().trim_end_matches(';').trim().to_string();
    if query.is_empty() {
        return Err("Enter a Cosmos SQL query, for example SELECT * FROM c".to_string());
    }
    if !query.split_whitespace().next().is_some_and(|word| word.eq_ignore_ascii_case("SELECT")) {
        return Err("Azure Cosmos DB for NoSQL only runs SELECT queries".to_string());
    }
    let database = match database.map(str::trim).filter(|db| !db.is_empty()) {
        Some(database) => database.to_string(),
        None => match list_databases(client).await?.as_slice() {
            [only] => only.clone(),
            _ => return Err("Select an Azure Cosmos DB database before running the query".to_string()),
        },
    };
    let containers = list_containers(client, &database).await?;
    let from = analyze_from_clause(&query);
    let container = resolve_query_container(&from, &directives, &containers)?;
    let limit = max_rows.unwrap_or(1000).max(1);
    let partition_key = directives.partition_key.as_ref();
    let page = query_page(client, &database, &container, &from.query, Vec::new(), partition_key, limit, None).await?;
    let truncated = page.continuation.is_some() || page.documents.len() > limit;
    let documents = &page.documents[..page.documents.len().min(limit)];
    let (columns, column_types, rows) = docs_to_table(documents);
    let mut summary = format!("{database}/{container} · request charge {:.2} RU", page.request_charge);
    if truncated {
        summary.push_str(&format!(" · first {limit} results"));
    }
    if let Some(activity_id) = &page.activity_id {
        summary.push_str(&format!(" · activity id {activity_id}"));
    }
    let messages =
        vec![QueryMessage { severity: "INFO".to_string(), message: summary, code: None, detail: None, hint: None }];
    Ok(table_result(columns, column_types, rows, start, truncated, messages))
}

/// Removes `--` and `/* */` comments outside string literals, so directive
/// lines never reach the service.
fn strip_sql_comments(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut output = String::with_capacity(source.len());
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch == '-' && chars.get(index + 1) == Some(&'-') {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            continue;
        }
        if ch == '/' && chars.get(index + 1) == Some(&'*') {
            index += 2;
            while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') {
                index += 1;
            }
            index += 2;
            output.push(' ');
            continue;
        }
        if ch == '\'' || ch == '"' {
            output.push(ch);
            index += 1;
            while index < chars.len() {
                output.push(chars[index]);
                if chars[index] == '\\' && index + 1 < chars.len() {
                    output.push(chars[index + 1]);
                    index += 2;
                    continue;
                }
                index += 1;
                if chars[index - 1] == ch {
                    break;
                }
            }
            continue;
        }
        output.push(ch);
        index += 1;
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Key from the "Access control on Azure Cosmos DB resources" REST docs example.
    const DOCS_KEY: &str = "dsZQi3KtZmCv1ljt3VNWNm7sQUF1y5rJfC6kv5JiwvW0EndXdDku/dkKBp8/ufDToSxLzR4y+O/0H/t4bQtVNw==";

    fn decode_auth(header: &str) -> String {
        percent_encoding::percent_decode_str(header).decode_utf8().unwrap().to_string()
    }

    #[test]
    fn signs_master_key_requests_like_the_rest_reference() {
        let key = STANDARD.decode(DOCS_KEY).unwrap();
        let header =
            master_key_authorization(&Method::GET, "dbs", "dbs/ToDoList", "Thu, 27 Apr 2017 00:51:12 GMT", &key);
        assert_eq!(decode_auth(&header), "type=master&ver=1.0&sig=c09PEVJrgp2uQRkr934kFbTqhByc7TVr3OHyqlu+c+c=");
    }

    #[test]
    fn parses_portal_connection_strings() {
        let parsed = parse_cosmos_connection_string(
            "AccountEndpoint=https://acct.documents.azure.com:443/;AccountKey=abc+/def==;",
        )
        .unwrap();
        assert_eq!(parsed.endpoint, "https://acct.documents.azure.com:443/");
        assert_eq!(parsed.key, "abc+/def==");
        assert!(parse_cosmos_connection_string("AccountKey=abc==").is_none());
    }

    #[test]
    fn normalizes_endpoints() {
        assert_eq!(normalize_cosmos_endpoint("acct.documents.azure.com", true), "https://acct.documents.azure.com");
        assert_eq!(
            normalize_cosmos_endpoint("https://acct.documents.azure.com:443/", true),
            "https://acct.documents.azure.com"
        );
        assert_eq!(normalize_cosmos_endpoint("localhost:8081", true), "https://localhost:8081");
        assert_eq!(normalize_cosmos_endpoint("http://127.0.0.1:8081/", false), "http://127.0.0.1:8081");
    }

    #[test]
    fn routes_tunneled_connections_without_changing_the_tls_host() {
        let (host, address) =
            tunnel_override("https://acct.documents.azure.com", "https://127.0.0.1:50123").expect("tunnel override");
        assert_eq!(host, "acct.documents.azure.com");
        assert_eq!(address, "127.0.0.1:50123".parse().unwrap());
        // An explicit port would win over the resolved address, so connect directly.
        assert!(tunnel_override("https://localhost:8081", "https://127.0.0.1:50123").is_none());
    }

    #[test]
    fn rejects_keys_that_are_not_base64() {
        let error = CosmosDbClient::from_config(CosmosClientOptions {
            configured_endpoint: "https://acct.documents.azure.com",
            transport_url: "https://acct.documents.azure.com",
            account_key: "not a key!",
            tls_enabled: true,
            url_params: None,
            timeout: Duration::from_secs(1),
            ca_cert_path: None,
            client_cert_path: None,
            client_key_path: None,
            proxy: None,
        })
        .unwrap_err();
        assert!(error.contains("Base64"));
    }

    #[test]
    fn escapes_unicode_partition_keys_for_headers() {
        assert_eq!(ascii_json(&serde_json::json!(["租户-1"])), r#"["\u79df\u6237-1"]"#);
        assert_eq!(ascii_json(&serde_json::json!(["a\"b"])), r#"["a\"b"]"#);
    }

    #[test]
    fn extracts_partition_keys_including_hierarchical_and_undefined() {
        let single = PartitionKeyDefinition { paths: vec!["/tenant/id".to_string()], kind: "Hash".to_string() };
        let doc = serde_json::json!({ "id": "1", "tenant": { "id": "t1" } });
        assert_eq!(extract_partition_key(&single, &doc).unwrap(), serde_json::json!(["t1"]));
        assert_eq!(extract_partition_key(&single, &serde_json::json!({ "id": "1" })).unwrap(), serde_json::json!([{}]));

        let hierarchical = PartitionKeyDefinition {
            paths: vec!["/tenantId".to_string(), "/userId".to_string()],
            kind: "MultiHash".to_string(),
        };
        let doc = serde_json::json!({ "id": "1", "tenantId": "t", "userId": 7 });
        assert_eq!(extract_partition_key(&hierarchical, &doc).unwrap(), serde_json::json!(["t", 7]));
        assert!(extract_partition_key(&single, &serde_json::json!({ "tenant": { "id": [1] } })).is_err());
    }

    #[test]
    fn round_trips_document_identity() {
        let definition = PartitionKeyDefinition { paths: vec!["/pk".to_string()], kind: "Hash".to_string() };
        let doc = with_identity(serde_json::json!({ "id": "a b", "pk": "p" }), &definition);
        let identity = doc.get("_id").unwrap();
        assert!(is_synthetic_identity(identity));
        let decoded = decode_identity(&identity.to_string()).unwrap();
        assert_eq!(decoded, DocumentIdentity { id: "a b".to_string(), partition_key: serde_json::json!(["p"]) });
    }

    #[test]
    fn strips_identity_and_system_properties_before_writes() {
        let mut document = parse_document_object(
            r#"{"_id":{"id":"1","partitionKey":["p"]},"id":"1","pk":"p","_etag":"\"0000\"","_rid":"x","_ts":1}"#,
        )
        .unwrap();
        assert_eq!(prepare_write_body(&mut document).as_deref(), Some("\"0000\""));
        assert_eq!(Value::Object(document), serde_json::json!({ "id": "1", "pk": "p" }));

        let mut native = parse_document_object(r#"{"_id":"legacy","id":"1"}"#).unwrap();
        prepare_write_body(&mut native);
        assert_eq!(native.get("_id"), Some(&serde_json::json!("legacy")));
    }

    #[test]
    fn translates_document_filters_to_parameterized_sql() {
        let (clause, params) = build_where_clause(Some(
            r#"{"status":"open","total":{"$gte":10,"$lt":20},"$or":[{"tags":{"$in":["a","b"]}},{"customer.name":{"$regex":"^ab","$options":"i"}}],"deleted":null}"#,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(
            clause,
            r#"c["status"] = @p0 AND (c["total"] >= @p1 AND c["total"] < @p2) AND (ARRAY_CONTAINS(@p3, c["tags"]) OR RegexMatch(c["customer"]["name"], @p4, @p5)) AND (NOT IS_DEFINED(c["deleted"]) OR IS_NULL(c["deleted"]))"#
        );
        assert_eq!(params.len(), 6);
        assert_eq!(params[0], serde_json::json!({ "name": "@p0", "value": "open" }));
        assert_eq!(params[5], serde_json::json!({ "name": "@p5", "value": "i" }));

        let (clause, _) = build_where_clause(Some(
            r#"{"items":{"$elemMatch":{"$and":[{"sku":"a"},{"qty":{"$gt":1}}]}},"scores":{"$elemMatch":{"$gte":90}}}"#,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(
            clause,
            r#"EXISTS(SELECT VALUE e1 FROM e1 IN c["items"] WHERE (e1["sku"] = @p0 AND e1["qty"] > @p1)) AND EXISTS(SELECT VALUE e2 FROM e2 IN c["scores"] WHERE e2 >= @p2)"#
        );

        assert!(build_where_clause(Some("{}")).unwrap().is_none());
        assert!(build_where_clause(Some(r#"{"a":{"$where":"x"}}"#)).is_err());
        assert!(build_where_clause(Some("[1]")).is_err());
    }

    #[test]
    fn quotes_field_paths_against_injection() {
        assert_eq!(field_reference("a.0.b").unwrap(), r#"c["a"][0]["b"]"#);
        assert_eq!(field_reference(r#"x"] OR 1=1 --"#).unwrap(), r#"c["x\"] OR 1=1 --"]"#);
        assert!(field_reference("a..b").is_err());
    }

    #[test]
    fn builds_order_by_from_object_and_array_sorts() {
        assert_eq!(
            build_order_by(Some(r#"{"ts":-1,"name":1}"#)).unwrap().unwrap(),
            r#"ORDER BY c["ts"] DESC, c["name"] ASC"#
        );
        assert_eq!(
            build_order_by(Some(r#"[{"a":"desc"},"b"]"#)).unwrap().unwrap(),
            r#"ORDER BY c["a"] DESC, c["b"] ASC"#
        );
        assert!(build_order_by(Some("{}")).unwrap().is_none());
    }

    #[test]
    fn resolves_the_query_container() {
        let containers = vec![
            CosmosContainerInfo { id: "orders".to_string(), partition_key_paths: vec!["/tenant".to_string()] },
            CosmosContainerInfo { id: "order-items".to_string(), partition_key_paths: vec!["/id".to_string()] },
        ];
        let none = QueryDirectives::default();
        let resolve = |query: &str, directives: &QueryDirectives, containers: &[CosmosContainerInfo]| {
            resolve_query_container(&analyze_from_clause(query), directives, containers)
        };
        assert_eq!(resolve("SELECT * FROM orders o WHERE o.x = 1", &none, &containers).unwrap(), "orders");
        assert_eq!(resolve("SELECT VALUE t FROM t IN orders.tags", &none, &containers).unwrap(), "orders");
        assert_eq!(resolve("SELECT * FROM \"order-items\" i", &none, &containers).unwrap(), "order-items");
        assert_eq!(
            resolve(
                "SELECT * FROM c WHERE c.id IN (SELECT VALUE u.id FROM users u)",
                &QueryDirectives { container: Some("orders".to_string()), partition_key: None },
                &containers
            )
            .unwrap(),
            "orders"
        );
        assert!(resolve("SELECT * FROM c", &none, &containers).unwrap_err().contains("FROM"));
        assert!(resolve("SELECT * FROM \"missing\" m", &none, &containers).unwrap_err().contains("missing"));
        assert_eq!(resolve("SELECT * FROM c", &none, &containers[..1]).unwrap(), "orders");
    }

    #[test]
    fn rewrites_quoted_container_ids_to_root() {
        let from = analyze_from_clause("SELECT * FROM \"order-items\" i WHERE i.sku = 'FROM \"x\"'");
        assert_eq!(from.root.as_deref(), Some("order-items"));
        assert!(from.quoted);
        assert_eq!(from.query, "SELECT * FROM ROOT i WHERE i.sku = 'FROM \"x\"'");

        let from = analyze_from_clause("SELECT 'FROM x' AS f FROM /* FROM y */ items i");
        assert_eq!(from.root.as_deref(), Some("items"));
        assert!(!from.quoted);
        assert_eq!(from.query, "SELECT 'FROM x' AS f FROM /* FROM y */ items i");
    }

    #[test]
    fn parses_query_directives() {
        let directives =
            parse_query_directives("-- container: orders\n-- partitionKey: \"t1\"\nSELECT * FROM c").unwrap();
        assert_eq!(directives.container.as_deref(), Some("orders"));
        assert_eq!(directives.partition_key, Some(serde_json::json!(["t1"])));
        // Block comments survive the editor's statement splitting.
        let directives =
            parse_query_directives("SELECT * FROM c /* partitionKey: [\"t1\", 7] */ ORDER BY c.ts").unwrap();
        assert_eq!(directives.partition_key, Some(serde_json::json!(["t1", 7])));
        assert!(parse_query_directives("-- partitionKey: [oops").is_err());
        assert_eq!(parse_query_directives("SELECT 'partitionKey: [1]' FROM c").unwrap(), QueryDirectives::default());
    }

    #[test]
    fn extracts_readable_service_errors() {
        let body = r#"{"code":"BadRequest","message":"Message: {\"Errors\":[\"Syntax error, incorrect syntax near 'FORM'.\"]}\r\nActivityId: 123, Microsoft.Azure.Documents.Common/2.14.0"}"#;
        assert_eq!(error_detail(body), "Syntax error, incorrect syntax near 'FORM'.");
        // Query plan endpoint: nested envelopes with structured errors.
        let plan = r#"{"code":"BadRequest","message":"{\"code\":\"BadRequest\",\"message\":\"{\\\"errors\\\":[{\\\"severity\\\":\\\"Error\\\",\\\"location\\\":{\\\"start\\\":21,\\\"end\\\":22},\\\"code\\\":\\\"SC1001\\\",\\\"message\\\":\\\"Syntax error, incorrect syntax near 'c'.\\\"}]}\\r\\nActivityId: 3a61\"}"}"#;
        assert_eq!(error_detail(plan), "Syntax error, incorrect syntax near 'c'. (characters 21-22)");
        assert_eq!(
            error_detail(
                r#"{"code":"BadRequest","message":"One of the input values is invalid.\r\nActivityId: 0b06"}"#
            ),
            GENERIC_INVALID_INPUT
        );
        assert_eq!(
            error_detail(
                r#"{"code":"NotFound","message":"Entity with the specified id does not exist in the system.\r\nActivityId: 1"}"#
            ),
            "Entity with the specified id does not exist in the system."
        );
    }

    #[test]
    fn maps_scalar_and_object_results_to_tables() {
        let (columns, types, rows) = docs_to_table(&[serde_json::json!(3), serde_json::json!({"a":1})]);
        assert_eq!(columns, ["value"]);
        assert_eq!(types, ["json"]);
        assert_eq!(rows[1], vec![Value::String("{\"a\":1}".to_string())]);

        let (columns, types, rows) =
            docs_to_table(&[serde_json::json!({"id":"1","n":1}), serde_json::json!({"id":"2","tags":["x"]})]);
        assert_eq!(columns, ["id", "n", "tags"]);
        assert_eq!(types, ["text", "number", "json"]);
        assert_eq!(rows[0], vec![serde_json::json!("1"), serde_json::json!(1), Value::Null]);
    }

    // -- Local HTTP simulator ------------------------------------------------

    struct RecordedRequest {
        request_line: String,
        headers: HashMap<String, String>,
        body: String,
    }

    async fn read_request(socket: &mut tokio::net::TcpStream) -> RecordedRequest {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        let header_end = loop {
            let read = socket.read(&mut buffer).await.unwrap();
            assert!(read > 0, "client closed the connection early");
            bytes.extend_from_slice(&buffer[..read]);
            if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break end;
            }
        };
        let head = String::from_utf8_lossy(&bytes[..header_end]).to_string();
        let mut lines = head.lines();
        let request_line = lines.next().unwrap_or_default().to_string();
        let headers: HashMap<String, String> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect();
        let length = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
        while bytes.len() < header_end + 4 + length {
            let read = socket.read(&mut buffer).await.unwrap();
            assert!(read > 0);
            bytes.extend_from_slice(&buffer[..read]);
        }
        let body = String::from_utf8_lossy(&bytes[header_end + 4..header_end + 4 + length]).to_string();
        RecordedRequest { request_line, headers, body }
    }

    type Exchange = (Box<dyn Fn(&RecordedRequest) + Send>, String);

    fn exchange(check: impl Fn(&RecordedRequest) + Send + 'static, response: String) -> Exchange {
        (Box::new(check), response)
    }

    /// Serves one response per expected request, in order, and checks each
    /// request with the matching closure.
    async fn simulator(exchanges: Vec<Exchange>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            for (check, response) in exchanges {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                check(&request);
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.ok();
            }
        });
        (format!("http://{address}"), handle)
    }

    fn http_response(status: &str, headers: &[(&str, &str)], body: &str) -> String {
        let mut response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nConnection: close\r\n");
        for (name, value) in headers {
            response.push_str(&format!("{name}: {value}\r\n"));
        }
        response.push_str(&format!("Content-Length: {}\r\n\r\n{body}", body.len()));
        response
    }

    fn assert_signed(request: &RecordedRequest) {
        let auth = decode_auth(request.headers.get("authorization").expect("authorization header"));
        assert!(auth.starts_with("type=master&ver=1.0&sig="), "{auth}");
        assert_eq!(request.headers.get("x-ms-version").map(String::as_str), Some(COSMOS_API_VERSION));
        assert!(request.headers.contains_key("x-ms-date"));
    }

    const CONTAINER_BODY: &str = r#"{"id":"orders","partitionKey":{"paths":["/tenant"],"kind":"Hash","version":2}}"#;

    #[tokio::test]
    async fn lists_databases_across_continuation_pages() {
        let (url, server) = simulator(vec![
            (
                Box::new(|request: &RecordedRequest| {
                    assert_eq!(request.request_line, "GET /dbs HTTP/1.1");
                    assert_signed(request);
                    assert!(!request.headers.contains_key("x-ms-continuation"));
                }),
                http_response(
                    "200 OK",
                    &[("x-ms-continuation", "page-2")],
                    r#"{"Databases":[{"id":"app"}],"_count":1}"#,
                ),
            ),
            (
                Box::new(|request: &RecordedRequest| {
                    assert_eq!(request.headers.get("x-ms-continuation").map(String::as_str), Some("page-2"));
                }),
                http_response("200 OK", &[], r#"{"Databases":[{"id":"logs"}],"_count":1}"#),
            ),
        ])
        .await;
        let client = CosmosDbClient::for_test(&url, DOCS_KEY);
        assert_eq!(list_databases(&client).await.unwrap(), ["app", "logs"]);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn browses_documents_with_identity_cursor_and_quota_count() {
        let (url, server) = simulator(vec![
            (
                Box::new(|request: &RecordedRequest| {
                    assert_eq!(request.request_line, "GET /dbs/app/colls/orders HTTP/1.1");
                }),
                http_response("200 OK", &[], CONTAINER_BODY),
            ),
            (
                Box::new(|request: &RecordedRequest| {
                    assert_eq!(request.request_line, "POST /dbs/app/colls/orders/docs HTTP/1.1");
                    assert_signed(request);
                    assert_eq!(request.headers.get("content-type").map(String::as_str), Some("application/query+json"));
                    assert_eq!(request.headers.get("x-ms-documentdb-isquery").map(String::as_str), Some("True"));
                    assert_eq!(
                        request.headers.get("x-ms-documentdb-query-enablecrosspartition").map(String::as_str),
                        Some("True")
                    );
                    assert_eq!(request.headers.get("x-ms-max-item-count").map(String::as_str), Some("2"));
                    let body: Value = serde_json::from_str(&request.body).unwrap();
                    assert_eq!(body["query"], r#"SELECT * FROM c ORDER BY c["ts"] DESC"#);
                }),
                http_response(
                    "200 OK",
                    &[("x-ms-continuation", "{\"token\":\"t1\"}"), ("x-ms-request-charge", "2.5")],
                    r#"{"Documents":[{"id":"1","tenant":"a","_etag":"\"e1\""},{"id":"2","tenant":"b"}],"_count":2}"#,
                ),
            ),
            (
                Box::new(|request: &RecordedRequest| {
                    assert_eq!(request.request_line, "GET /dbs/app/colls/orders HTTP/1.1");
                    assert_eq!(
                        request.headers.get("x-ms-documentdb-populatequotainfo").map(String::as_str),
                        Some("True")
                    );
                }),
                http_response(
                    "200 OK",
                    &[("x-ms-resource-usage", "documentSize=0;documentsSize=1;documentsCount=42;collectionSize=1;")],
                    CONTAINER_BODY,
                ),
            ),
        ])
        .await;
        let client = CosmosDbClient::for_test(&url, DOCS_KEY);
        let result = find_documents(&client, "app", "orders", 2, None, Some(r#"{"ts":-1}"#), None).await.unwrap();
        assert_eq!(result.total, 42);
        assert!(result.total_is_exact);
        assert_eq!(result.next_cursor.as_deref(), Some("{\"token\":\"t1\"}"));
        assert_eq!(result.documents[0]["_id"], serde_json::json!({ "id": "1", "partitionKey": ["a"] }));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn reports_queries_the_gateway_cannot_serve() {
        let unservable = || {
            http_response(
                "400 Bad Request",
                &[("x-ms-substatus", "1004"), ("x-ms-activity-id", "act-1")],
                r#"{"code":"BadRequest","message":"The provided cross partition query can not be directly served by the gateway."}"#,
            )
        };
        let (url, server) = simulator(vec![
            exchange(
                |_: &RecordedRequest| {},
                http_response(
                    "200 OK",
                    &[],
                    r#"{"DocumentCollections":[{"id":"orders","partitionKey":{"paths":["/tenant"]}}]}"#,
                ),
            ),
            exchange(|_: &RecordedRequest| {}, unservable()),
            exchange(
                |request: &RecordedRequest| {
                    assert_eq!(request.request_line, "GET /dbs/app/colls/orders/pkranges HTTP/1.1")
                },
                http_response("200 OK", &[], r#"{"PartitionKeyRanges":[{"id":"1"},{"id":"2"}]}"#),
            ),
        ])
        .await;
        let client = CosmosDbClient::for_test(&url, DOCS_KEY);
        let error =
            execute_query(&client, Some("app"), "SELECT * FROM orders o ORDER BY o.ts", Some(10)).await.unwrap_err();
        assert!(error.contains("2 physical partitions"), "{error}");
        assert!(error.contains("partitionKey"), "{error}");
        assert!(error.contains("act-1"), "{error}");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn explains_syntax_errors_through_the_query_plan() {
        let (url, server) = simulator(vec![
            exchange(
                |_: &RecordedRequest| {},
                http_response("200 OK", &[], r#"{"DocumentCollections":[{"id":"orders","partitionKey":{"paths":["/tenant"]}}]}"#),
            ),
            exchange(
                |_: &RecordedRequest| {},
                http_response(
                    "400 Bad Request",
                    &[("x-ms-activity-id", "act-9")],
                    r#"{"code":"BadRequest","message":"One of the input values is invalid.\r\nActivityId: act-9"}"#,
                ),
            ),
            exchange(
                |request: &RecordedRequest| {
                    assert_eq!(request.headers.get("x-ms-cosmos-is-query-plan-request").map(String::as_str), Some("True"));
                },
                http_response(
                    "400 Bad Request",
                    &[],
                    r#"{"code":"BadRequest","message":"{\"errors\":[{\"location\":{\"start\":26,\"end\":30},\"message\":\"Syntax error, incorrect syntax near 'WHRE'.\"}]}"}"#,
                ),
            ),
        ])
        .await;
        let client = CosmosDbClient::for_test(&url, DOCS_KEY);
        let error =
            execute_query(&client, Some("app"), "SELECT * FROM orders o WHRE o.id = 'x'", None).await.unwrap_err();
        assert!(error.contains("incorrect syntax near 'WHRE'. (characters 26-30)"), "{error}");
        assert!(error.contains("act-9"), "{error}");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn retries_unservable_queries_on_the_only_physical_partition() {
        let (url, server) = simulator(vec![
            exchange(|_: &RecordedRequest| {}, http_response("200 OK", &[], CONTAINER_BODY)),
            exchange(
                |request: &RecordedRequest| {
                    assert_eq!(
                        request.headers.get("x-ms-documentdb-query-enablecrosspartition").map(String::as_str),
                        Some("True")
                    );
                },
                http_response(
                    "400 Bad Request",
                    &[("x-ms-substatus", "1004")],
                    r#"{"code":"BadRequest","message":"x"}"#,
                ),
            ),
            exchange(|_: &RecordedRequest| {}, http_response("200 OK", &[], r#"{"PartitionKeyRanges":[{"id":"0"}]}"#)),
            exchange(
                |request: &RecordedRequest| {
                    assert_eq!(
                        request.headers.get("x-ms-documentdb-partitionkeyrangeid").map(String::as_str),
                        Some("0")
                    );
                    assert!(!request.headers.contains_key("x-ms-documentdb-query-enablecrosspartition"));
                    let body: Value = serde_json::from_str(&request.body).unwrap();
                    assert_eq!(body["query"], r#"SELECT * FROM c WHERE c["amount"] > @p0 ORDER BY c["amount"] DESC"#);
                },
                http_response(
                    "200 OK",
                    &[("x-ms-continuation", "tok-1")],
                    r#"{"Documents":[{"id":"b","tenant":"t","amount":2}]}"#,
                ),
            ),
            exchange(
                |request: &RecordedRequest| {
                    // The next page stays on the same physical partition.
                    assert_eq!(
                        request.headers.get("x-ms-documentdb-partitionkeyrangeid").map(String::as_str),
                        Some("0")
                    );
                    assert_eq!(request.headers.get("x-ms-continuation").map(String::as_str), Some("tok-1"));
                },
                http_response("200 OK", &[], r#"{"Documents":[{"id":"a","tenant":"t","amount":1}]}"#),
            ),
        ])
        .await;
        let client = CosmosDbClient::for_test(&url, DOCS_KEY);
        let sort = Some(r#"{"amount":-1}"#);
        let filter = Some(r#"{"amount":{"$gt":0}}"#);
        let first = find_documents(&client, "app", "orders", 1, filter, sort, None).await.unwrap();
        assert_eq!(first.next_cursor.as_deref(), Some("dbx-range:0:tok-1"));
        let second =
            find_documents(&client, "app", "orders", 1, filter, sort, first.next_cursor.as_deref()).await.unwrap();
        assert_eq!(second.documents[0]["id"], "a");
        assert!(second.next_cursor.is_none());
        server.await.unwrap();
    }

    #[test]
    fn scopes_browser_filters_that_fix_the_partition_key() {
        let single = PartitionKeyDefinition { paths: vec!["/tenant/id".to_string()], kind: "Hash".to_string() };
        assert_eq!(
            partition_key_from_filter(&single, Some(r#"{"tenant.id":"t1","n":1}"#)),
            Some(serde_json::json!(["t1"]))
        );
        assert_eq!(
            partition_key_from_filter(&single, Some(r#"{"tenant.id":{"$eq":5}}"#)),
            Some(serde_json::json!([5]))
        );
        assert_eq!(partition_key_from_filter(&single, Some(r#"{"tenant.id":{"$gt":5}}"#)), None);
        assert_eq!(partition_key_from_filter(&single, Some(r#"{"tenant.id":null}"#)), None);
        assert_eq!(partition_key_from_filter(&single, Some(r#"{"$or":[{"tenant.id":"t1"}]}"#)), None);
        let hierarchical =
            PartitionKeyDefinition { paths: vec!["/a".to_string(), "/b".to_string()], kind: "MultiHash".to_string() };
        assert_eq!(partition_key_from_filter(&hierarchical, Some(r#"{"a":"x"}"#)), None);
        assert_eq!(
            partition_key_from_filter(&hierarchical, Some(r#"{"a":"x","b":2}"#)),
            Some(serde_json::json!(["x", 2]))
        );
        assert_eq!(
            decode_query_cursor(Some("dbx-range:3:{\"t\":1}")),
            (QueryRoute::Range("3".to_string()), Some("{\"t\":1}".to_string()))
        );
        assert_eq!(decode_query_cursor(Some("plain")), (QueryRoute::Gateway, Some("plain".to_string())));
    }

    #[tokio::test]
    async fn runs_partition_scoped_queries_from_the_editor() {
        let (url, server) = simulator(vec![
            (
                Box::new(|request: &RecordedRequest| assert_eq!(request.request_line, "GET /dbs/app/colls HTTP/1.1")),
                http_response("200 OK", &[], r#"{"DocumentCollections":[{"id":"orders","partitionKey":{"paths":["/tenant"]}},{"id":"users","partitionKey":{"paths":["/id"]}}]}"#),
            ),
            (
                Box::new(|request: &RecordedRequest| {
                    assert_eq!(request.request_line, "POST /dbs/app/colls/orders/docs HTTP/1.1");
                    assert_eq!(
                        request.headers.get("x-ms-documentdb-partitionkey").map(String::as_str),
                        Some(r#"["\u79df\u6237"]"#)
                    );
                    assert!(!request.headers.contains_key("x-ms-documentdb-query-enablecrosspartition"));
                    let body: Value = serde_json::from_str(&request.body).unwrap();
                    assert_eq!(body["query"], "SELECT VALUE COUNT(1) FROM orders o");
                }),
                http_response("200 OK", &[("x-ms-request-charge", "3.1"), ("x-ms-activity-id", "act-2")], r#"{"Documents":[7],"_count":1}"#),
            ),
        ])
        .await;
        let client = CosmosDbClient::for_test(&url, DOCS_KEY);
        let result = execute_query(
            &client,
            Some("app"),
            "-- partitionKey: [\"租户\"]\nSELECT VALUE COUNT(1) FROM orders o;",
            Some(100),
        )
        .await
        .unwrap();
        assert_eq!(result.columns, ["value"]);
        assert_eq!(result.rows, vec![vec![serde_json::json!(7)]]);
        assert!(result.messages[0].message.contains("3.10 RU"));
        assert!(result.messages[0].message.contains("act-2"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn replaces_documents_with_etag_and_partition_key() {
        let (url, server) = simulator(vec![
            (
                Box::new(|request: &RecordedRequest| {
                    assert_eq!(request.request_line, "GET /dbs/app/colls/orders/docs/a%20b HTTP/1.1");
                    assert_eq!(
                        request.headers.get("x-ms-documentdb-partitionkey").map(String::as_str),
                        Some(r#"["t1"]"#)
                    );
                }),
                http_response("200 OK", &[], r#"{"id":"a b","tenant":"t1","_etag":"\"stored\""}"#),
            ),
            (Box::new(|_: &RecordedRequest| {}), http_response("200 OK", &[], CONTAINER_BODY)),
            (
                Box::new(|request: &RecordedRequest| {
                    assert_eq!(request.request_line, "PUT /dbs/app/colls/orders/docs/a%20b HTTP/1.1");
                    assert_eq!(request.headers.get("if-match").map(String::as_str), Some("\"loaded\""));
                    let body: Value = serde_json::from_str(&request.body).unwrap();
                    assert_eq!(body, serde_json::json!({ "id": "a b", "tenant": "t1", "status": "done" }));
                }),
                http_response("412 Precondition Failed", &[], r#"{"code":"PreconditionFailed","message":"x"}"#),
            ),
        ])
        .await;
        let client = CosmosDbClient::for_test(&url, DOCS_KEY);
        let identity = r#"{"id":"a b","partitionKey":["t1"]}"#;
        let edited = r#"{"_id":{"id":"a b","partitionKey":["t1"]},"id":"a b","tenant":"t1","status":"done","_etag":"\"loaded\"","_ts":1}"#;
        let error = update_document(&client, "app", "orders", identity, edited).await.unwrap_err();
        assert!(error.contains("ETag mismatch"), "{error}");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn inserts_documents_with_generated_ids() {
        let (url, server) = simulator(vec![
            (Box::new(|_: &RecordedRequest| {}), http_response("200 OK", &[], CONTAINER_BODY)),
            (
                Box::new(|request: &RecordedRequest| {
                    assert_eq!(request.request_line, "POST /dbs/app/colls/orders/docs HTTP/1.1");
                    assert_eq!(
                        request.headers.get("x-ms-documentdb-partitionkey").map(String::as_str),
                        Some(r#"["t9"]"#)
                    );
                    assert!(!request.headers.contains_key("x-ms-documentdb-isquery"));
                    let body: Value = serde_json::from_str(&request.body).unwrap();
                    assert!(body["id"].as_str().is_some_and(|id| id.len() == 36));
                }),
                http_response("201 Created", &[], r#"{}"#),
            ),
        ])
        .await;
        let client = CosmosDbClient::for_test(&url, DOCS_KEY);
        let identity = insert_document(&client, "app", "orders", r#"{"tenant":"t9","n":1}"#).await.unwrap();
        let decoded = decode_identity(&identity).unwrap();
        assert_eq!(decoded.partition_key, serde_json::json!(["t9"]));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn counts_filtered_documents_per_partition_range() {
        let (url, server) = simulator(vec![
            (
                Box::new(|request: &RecordedRequest| {
                    assert_eq!(request.request_line, "GET /dbs/app/colls/orders/pkranges HTTP/1.1")
                }),
                http_response(
                    "200 OK",
                    &[],
                    r#"{"PartitionKeyRanges":[{"id":"0"},{"id":"1","parents":["0"]},{"id":"2","parents":["0"]}]}"#,
                ),
            ),
            (
                Box::new(|request: &RecordedRequest| {
                    assert_eq!(
                        request.headers.get("x-ms-documentdb-partitionkeyrangeid").map(String::as_str),
                        Some("1")
                    );
                    let body: Value = serde_json::from_str(&request.body).unwrap();
                    assert_eq!(body["query"], r#"SELECT VALUE COUNT(1) FROM c WHERE c["status"] = @p0"#);
                }),
                http_response("200 OK", &[], r#"{"Documents":[3]}"#),
            ),
            (
                Box::new(|request: &RecordedRequest| {
                    assert_eq!(
                        request.headers.get("x-ms-documentdb-partitionkeyrangeid").map(String::as_str),
                        Some("2")
                    )
                }),
                http_response("200 OK", &[], r#"{"Documents":[4]}"#),
            ),
        ])
        .await;
        let client = CosmosDbClient::for_test(&url, DOCS_KEY);
        assert_eq!(count_documents(&client, "app", "orders", Some(r#"{"status":"open"}"#)).await.unwrap(), 7);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn retries_throttled_requests() {
        let (url, server) = simulator(vec![
            (
                Box::new(|_: &RecordedRequest| {}),
                http_response("429 Too Many Requests", &[("x-ms-retry-after-ms", "10")], "{}"),
            ),
            (Box::new(|_: &RecordedRequest| {}), http_response("200 OK", &[], r#"{"Databases":[{"id":"app"}]}"#)),
        ])
        .await;
        let client = CosmosDbClient::for_test(&url, DOCS_KEY);
        assert_eq!(list_databases(&client).await.unwrap(), ["app"]);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn sends_quoted_container_queries_as_root() {
        let (url, server) = simulator(vec![
            exchange(
                |_: &RecordedRequest| {},
                http_response(
                    "200 OK",
                    &[],
                    r#"{"DocumentCollections":[{"id":"order-items","partitionKey":{"paths":["/id"]}},{"id":"users","partitionKey":{"paths":["/id"]}}]}"#,
                ),
            ),
            exchange(
                |request: &RecordedRequest| {
                    assert_eq!(request.request_line, "POST /dbs/app/colls/order-items/docs HTTP/1.1");
                    let body: Value = serde_json::from_str(&request.body).unwrap();
                    assert_eq!(body["query"], "SELECT * FROM ROOT i WHERE i.qty > 1");
                },
                http_response("200 OK", &[], r#"{"Documents":[{"id":"1","qty":2}]}"#),
            ),
        ])
        .await;
        let client = CosmosDbClient::for_test(&url, DOCS_KEY);
        let result =
            execute_query(&client, Some("app"), "SELECT * FROM \"order-items\" i WHERE i.qty > 1", None).await.unwrap();
        assert_eq!(result.columns, ["id", "qty"]);
        server.await.unwrap();
    }

    fn live_client() -> CosmosDbClient {
        let endpoint = std::env::var("DBX_COSMOSDB_ENDPOINT").expect("DBX_COSMOSDB_ENDPOINT");
        let key = std::env::var("DBX_COSMOSDB_KEY").expect("DBX_COSMOSDB_KEY");
        let url_params = std::env::var("DBX_COSMOSDB_URL_PARAMS").ok();
        CosmosDbClient::from_config(CosmosClientOptions {
            configured_endpoint: &endpoint,
            transport_url: &endpoint,
            account_key: &key,
            tls_enabled: !endpoint.starts_with("http://"),
            url_params: url_params.as_deref(),
            timeout: Duration::from_secs(15),
            ca_cert_path: None,
            client_cert_path: None,
            client_key_path: None,
            proxy: None,
        })
        .unwrap()
    }

    /// Read-only live check against the Cosmos DB emulator or an account.
    #[tokio::test]
    #[ignore = "requires DBX_COSMOSDB_ENDPOINT and DBX_COSMOSDB_KEY"]
    async fn live_lists_databases() {
        let client = live_client();
        test_connection(&client, Duration::from_secs(15)).await.unwrap();
        let info = database_connection_info(&client).await.unwrap();
        println!("connected: {:?} {:?}", info.product_name, info.server_comment);
        let databases = list_databases(&client).await.unwrap();
        println!("databases: {}", databases.len());
        for database in databases.iter().take(3) {
            let containers = list_containers(&client, database).await.unwrap();
            println!("database {database}: {} containers", containers.len());
            for container in containers.iter().take(2) {
                let page = find_documents(&client, database, &container.id, 5, None, None, None).await.unwrap();
                println!(
                    "  {}: partition key {:?}, page {} docs, total {} (exact: {}), more: {}",
                    container.id,
                    container.partition_key_paths,
                    page.documents.len(),
                    page.total,
                    page.total_is_exact,
                    page.next_cursor.is_some()
                );
                assert!(page.documents.iter().all(|doc| doc.get("_id").is_some_and(is_synthetic_identity)));
                get_columns(&client, database, &container.id).await.unwrap();
            }
        }
    }

    /// Writes only `dbx-live-*` documents to the given test container and
    /// deletes them again.
    #[tokio::test]
    #[ignore = "requires DBX_COSMOSDB_ENDPOINT, DBX_COSMOSDB_KEY, DBX_COSMOSDB_TEST_DATABASE and DBX_COSMOSDB_TEST_CONTAINER"]
    async fn live_document_round_trip() {
        let client = live_client();
        let database = std::env::var("DBX_COSMOSDB_TEST_DATABASE").expect("DBX_COSMOSDB_TEST_DATABASE");
        let container = std::env::var("DBX_COSMOSDB_TEST_CONTAINER").expect("DBX_COSMOSDB_TEST_CONTAINER");
        let definition = partition_key_definition(&client, &database, &container).await.unwrap();
        println!("partition key: {:?} ({})", definition.paths, definition.kind);

        let id = format!("dbx-live-{}", uuid::Uuid::new_v4());
        let set_partition_key = |document: &mut Value, suffix: &str| {
            for (index, path) in definition.paths.iter().enumerate() {
                let segments = partition_key_segments(path);
                if segments == ["id"] {
                    continue;
                }
                let mut current = &mut *document;
                for segment in &segments[..segments.len() - 1] {
                    current = current
                        .as_object_mut()
                        .unwrap()
                        .entry(segment.clone())
                        .or_insert_with(|| Value::Object(Map::new()));
                }
                current.as_object_mut().unwrap().insert(
                    segments.last().unwrap().clone(),
                    // Non-ASCII on purpose: partition key headers must stay valid.
                    Value::String(format!("dbx-live-租户-{suffix}-{index}")),
                );
            }
        };
        let mut document = serde_json::json!({ "id": id, "status": "new", "n": 1 });
        set_partition_key(&mut document, "a");

        let identity = insert_document(&client, &database, &container, &document.to_string()).await.unwrap();
        println!("inserted {identity}");
        let by_id = serde_json::json!({ "id": id }).to_string();
        let found = find_documents(&client, &database, &container, 10, Some(&by_id), None, None).await.unwrap();
        assert_eq!(found.documents.len(), 1, "inserted document is visible to the browser query");
        let loaded = found.documents[0].clone();
        assert_eq!(loaded["_id"].to_string(), identity);

        let mut edited = loaded.clone();
        edited["status"] = Value::String("done".to_string());
        assert_eq!(update_document(&client, &database, &container, &identity, &edited.to_string()).await.unwrap(), 1);

        let mut stale = loaded.clone();
        stale["status"] = Value::String("stale".to_string());
        let conflict =
            update_document(&client, &database, &container, &identity, &stale.to_string()).await.unwrap_err();
        assert!(conflict.contains("ETag mismatch"), "{conflict}");

        assert_eq!(count_documents(&client, &database, &container, Some(&by_id)).await.unwrap(), 1);

        let partition_key = decode_identity(&identity).unwrap().partition_key;
        let scoped = format!(
            "SELECT * FROM {} x WHERE x.id = '{id}' /* partitionKey: {} */",
            serde_json::to_string(&container).unwrap(),
            partition_key
        );
        let result = execute_query(&client, Some(&database), &scoped, Some(10)).await.unwrap();
        assert_eq!(result.rows.len(), 1);
        println!("partition-scoped query: {}", result.messages[0].message);

        // A non-ASCII partition key must survive the request header encoding.
        let unicode_scoped = format!(
            "SELECT * FROM {} x WHERE x.id = '{id}' /* partitionKey: [\"dbx-live-租户\"] */",
            serde_json::to_string(&container).unwrap()
        );
        let result = execute_query(&client, Some(&database), &unicode_scoped, Some(10)).await.unwrap();
        assert!(result.rows.is_empty());

        let cross_partition =
            format!("SELECT * FROM {} x ORDER BY x._ts DESC", serde_json::to_string(&container).unwrap());
        match execute_query(&client, Some(&database), &cross_partition, Some(5)).await {
            Ok(result) => println!("cross-partition ORDER BY served: {} rows", result.rows.len()),
            Err(error) => {
                assert!(error.contains("partitionKey"), "{error}");
                println!("cross-partition ORDER BY rejected as expected: {error}");
            }
        }

        let mut current_identity = identity.clone();
        let movable = definition.paths.iter().any(|path| partition_key_segments(path) != ["id"]);
        if movable {
            let reloaded = find_documents(&client, &database, &container, 10, Some(&by_id), None, None).await.unwrap();
            let mut moved = reloaded.documents[0].clone();
            set_partition_key(&mut moved, "b");
            update_document(&client, &database, &container, &current_identity, &moved.to_string()).await.unwrap();
            let old = decode_identity(&current_identity).unwrap();
            assert!(read_document(&client, &database, &container, &old).await.unwrap().is_none());
            let after = find_documents(&client, &database, &container, 10, Some(&by_id), None, None).await.unwrap();
            assert_eq!(after.documents.len(), 1, "the moved document exists exactly once");
            current_identity = after.documents[0]["_id"].to_string();
            assert_ne!(current_identity, identity);
            println!("moved to {current_identity}");
        }

        assert_eq!(delete_document(&client, &database, &container, &current_identity).await.unwrap(), 1);
        let gone = find_documents(&client, &database, &container, 10, Some(&by_id), None, None).await.unwrap();
        assert!(gone.documents.is_empty());
    }
}
