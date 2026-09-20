use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::agent_kv::{KvInt64, KvValue, KvValueEncoding};
use crate::connection::AppState;

use super::catalog::{ConsulCatalogNode, ConsulCatalogServiceNode, ConsulNodeServices};
use super::client::client_for_state;
use super::health::{mark_maintenance, ConsulHealthCheck, ConsulServiceInstance};
use super::kv::ConsulKvRecord;
use super::response::{
    decode_json_body, ensure_success, is_consul_kv_not_found, read_bounded_response, ConsulResponseMetadata,
};
use super::types::ConsulKvEntry;

const MIN_QUERY_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulBlockingRequest {
    pub operation_id: String,
    #[serde(default)]
    pub generation: u64,
    pub key: String,
    pub prefix: bool,
    pub index: Option<KvInt64>,
    pub wait_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulBlockingResponse {
    pub entries: Vec<ConsulKvRecord>,
    pub metadata: ConsulResponseMetadata,
    pub changed: bool,
    pub timed_out: bool,
    pub index_reset: bool,
}

/// A non-KV Consul endpoint with blocking-query support.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ConsulDomainWatchTarget {
    CatalogNodes,
    CatalogServices,
    CatalogServiceNodes { service: String },
    CatalogNodeServices { node: String },
    HealthNode { node: String },
    HealthServiceChecks { service: String },
    HealthServiceInstances { service: String, passing: Option<bool> },
    HealthState { state: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulDomainWatchRequest {
    pub operation_id: String,
    #[serde(default)]
    pub generation: u64,
    pub target: ConsulDomainWatchTarget,
    pub index: Option<KvInt64>,
    pub wait_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulDomainWatchResponse {
    pub items: ConsulDomainWatchItems,
    pub metadata: ConsulResponseMetadata,
    pub changed: bool,
    pub timed_out: bool,
    pub index_reset: bool,
}

/// Each allowed watch target has an explicit response shape.  The untagged
/// representation preserves Consul's native JSON body for the UI transport.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ConsulDomainWatchItems {
    CatalogNodes(Vec<ConsulCatalogNode>),
    CatalogServices(BTreeMap<String, Vec<String>>),
    CatalogServiceNodes(Vec<ConsulCatalogServiceNode>),
    CatalogNodeServices(ConsulNodeServices),
    HealthNode(Vec<ConsulHealthCheck>),
    HealthServiceChecks(Vec<ConsulHealthCheck>),
    HealthServiceInstances(Vec<ConsulServiceInstance>),
    HealthState(Vec<ConsulHealthCheck>),
}

#[derive(Default)]
struct BlockingControl {
    cancelled: AtomicBool,
}

struct BlockingRegistration(String);

impl Drop for BlockingRegistration {
    fn drop(&mut self) {
        if let Ok(mut registry) = blocking_registry().lock() {
            registry.remove(&self.0);
        }
    }
}

static BLOCKING: OnceLock<Mutex<HashMap<String, Arc<BlockingControl>>>> = OnceLock::new();

pub async fn consul_blocking_query_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulBlockingRequest,
) -> Result<ConsulBlockingResponse, String> {
    validate_request(&request)?;
    let client = client_for_state(state, connection_id).await?;
    let scope = client.scope();
    let registry_key = format!(
        "{connection_id}\0{}\0{}\0{}\0{}\0{}",
        scope.datacenter, scope.partition, scope.namespace, request.generation, request.operation_id
    );
    let control = Arc::new(BlockingControl::default());
    {
        let mut registry =
            blocking_registry().lock().map_err(|_| "Consul blocking registry is unavailable".to_string())?;
        if registry.contains_key(&registry_key) {
            return Err("CONSUL_OPERATION_ALREADY_RUNNING: A blocking query with this operation ID is already running"
                .to_string());
        }
        registry.insert(registry_key.clone(), Arc::clone(&control));
    }
    let _registration = BlockingRegistration(registry_key);

    let requested_index = request.index.as_ref().map(parse_index).transpose()?.unwrap_or(1).max(1);
    let started = Instant::now();
    let future = blocking_request(&client, &request, requested_index);
    tokio::pin!(future);
    let mut cancel_tick = tokio::time::interval(Duration::from_millis(50));
    let mut response = loop {
        tokio::select! {
            response = &mut future => break response?,
            _ = cancel_tick.tick() => {
                if control.cancelled.load(Ordering::Acquire) {
                    return Err("CONSUL_BLOCKING_CANCELLED: Consul blocking query was cancelled".to_string());
                }
            }
        }
    };
    if control.cancelled.load(Ordering::Acquire) {
        return Err("CONSUL_BLOCKING_CANCELLED: Consul blocking query was cancelled".to_string());
    }

    let returned_index = response.metadata.index.as_ref().map(parse_index).transpose()?.unwrap_or(0);
    response.index_reset = returned_index == 0 || returned_index < requested_index;
    response.changed = !response.index_reset && returned_index > requested_index;
    response.timed_out =
        !response.changed && started.elapsed() >= Duration::from_secs(request.wait_seconds.saturating_sub(1));
    if started.elapsed() < MIN_QUERY_INTERVAL {
        tokio::time::sleep(MIN_QUERY_INTERVAL - started.elapsed()).await;
    }
    Ok(response)
}

/// Runs a Catalog or Health blocking query under the same cancellable registry as KV watches.
pub async fn consul_domain_watch_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulDomainWatchRequest,
) -> Result<ConsulDomainWatchResponse, String> {
    validate_domain_watch_request(&request)?;
    let client = client_for_state(state, connection_id).await?;
    let scope = client.scope();
    let registry_key = format!(
        "{connection_id}\0{}\0{}\0{}\0{}\0{}",
        scope.datacenter, scope.partition, scope.namespace, request.generation, request.operation_id
    );
    let control = Arc::new(BlockingControl::default());
    {
        let mut registry =
            blocking_registry().lock().map_err(|_| "Consul blocking registry is unavailable".to_string())?;
        if registry.contains_key(&registry_key) {
            return Err("CONSUL_OPERATION_ALREADY_RUNNING: A blocking query with this operation ID is already running"
                .to_string());
        }
        registry.insert(registry_key.clone(), Arc::clone(&control));
    }
    let _registration = BlockingRegistration(registry_key);
    let requested_index = request.index.as_ref().map(parse_index).transpose()?.unwrap_or(1).max(1);
    let started = Instant::now();
    let future = domain_watch_request(&client, &request, requested_index);
    tokio::pin!(future);
    let mut cancel_tick = tokio::time::interval(Duration::from_millis(50));
    let mut response = loop {
        tokio::select! {
            response = &mut future => break response?,
            _ = cancel_tick.tick() => {
                if control.cancelled.load(Ordering::Acquire) {
                    return Err("CONSUL_BLOCKING_CANCELLED: Consul blocking query was cancelled".to_string());
                }
            }
        }
    };
    if control.cancelled.load(Ordering::Acquire) {
        return Err("CONSUL_BLOCKING_CANCELLED: Consul blocking query was cancelled".to_string());
    }
    let returned_index = response.metadata.index.as_ref().map(parse_index).transpose()?.unwrap_or(0);
    response.index_reset = returned_index == 0 || returned_index < requested_index;
    response.changed = !response.index_reset && returned_index > requested_index;
    response.timed_out =
        !response.changed && started.elapsed() >= Duration::from_secs(request.wait_seconds.saturating_sub(1));
    if started.elapsed() < MIN_QUERY_INTERVAL {
        tokio::time::sleep(MIN_QUERY_INTERVAL - started.elapsed()).await;
    }
    Ok(response)
}

pub fn consul_cancel_blocking_core(
    connection_id: &str,
    scope: &super::ConsulScope,
    generation: u64,
    operation_id: &str,
) -> bool {
    let key = format!(
        "{connection_id}\0{}\0{}\0{}\0{generation}\0{operation_id}",
        scope.datacenter, scope.partition, scope.namespace
    );
    let control = blocking_registry().lock().ok().and_then(|registry| registry.get(&key).cloned());
    control.is_some_and(|control| {
        control.cancelled.store(true, Ordering::Release);
        true
    })
}

async fn blocking_request(
    client: &super::ConsulClient,
    request: &ConsulBlockingRequest,
    requested_index: u64,
) -> Result<ConsulBlockingResponse, String> {
    let encoded = request
        .key
        .split('/')
        .map(|segment| utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string())
        .collect::<Vec<_>>()
        .join("/");
    let mut url = client.api_url(&format!("/v1/kv/{encoded}"))?;
    client.append_scope(&mut url, true);
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("index", &requested_index.to_string());
        query.append_pair("wait", &format!("{}s", request.wait_seconds.clamp(1, 600)));
        if request.prefix {
            query.append_pair("recurse", "");
        }
    }
    let response = client.send(Method::GET, url, None).await?;
    let metadata = ConsulResponseMetadata::from_response(&response);
    if is_consul_kv_not_found(&response) {
        return Ok(ConsulBlockingResponse {
            entries: Vec::new(),
            metadata,
            changed: false,
            timed_out: false,
            index_reset: false,
        });
    }
    if !response.status().is_success() {
        return ensure_success(response, "watch Consul KV", client.token()).await.map(|_| unreachable!());
    }
    let body = read_bounded_response(response, "watch Consul KV").await?;
    let entries = decode_json_body::<Vec<ConsulKvEntry>>(&body, "watch Consul KV")?
        .into_iter()
        .map(record_from_entry)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ConsulBlockingResponse { entries, metadata, changed: false, timed_out: false, index_reset: false })
}

async fn domain_watch_request(
    client: &super::ConsulClient,
    request: &ConsulDomainWatchRequest,
    requested_index: u64,
) -> Result<ConsulDomainWatchResponse, String> {
    let (path, action) = match &request.target {
        ConsulDomainWatchTarget::CatalogNodes => ("/v1/catalog/nodes".to_string(), "watch Consul catalog nodes"),
        ConsulDomainWatchTarget::CatalogServices => {
            ("/v1/catalog/services".to_string(), "watch Consul catalog services")
        }
        ConsulDomainWatchTarget::CatalogServiceNodes { service } => {
            (format!("/v1/catalog/service/{}", encode_path_segment(service)), "watch Consul catalog service instances")
        }
        ConsulDomainWatchTarget::CatalogNodeServices { node } => {
            (format!("/v1/catalog/node/{}", encode_path_segment(node)), "watch Consul catalog node services")
        }
        ConsulDomainWatchTarget::HealthNode { node } => {
            (format!("/v1/health/node/{}", encode_path_segment(node)), "watch Consul node health")
        }
        ConsulDomainWatchTarget::HealthServiceChecks { service } => {
            (format!("/v1/health/checks/{}", encode_path_segment(service)), "watch Consul service checks")
        }
        ConsulDomainWatchTarget::HealthServiceInstances { service, passing } => {
            let suffix = passing.map(|value| format!("?passing={value}")).unwrap_or_default();
            (format!("/v1/health/service/{}{suffix}", encode_path_segment(service)), "watch Consul service instances")
        }
        ConsulDomainWatchTarget::HealthState { state } => {
            (format!("/v1/health/state/{}", state.trim().to_ascii_lowercase()), "watch Consul health state")
        }
    };
    let mut url = client.api_url(&path)?;
    client.append_scope(&mut url, true);
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("index", &requested_index.to_string());
        query.append_pair("wait", &format!("{}s", request.wait_seconds.clamp(1, 600)));
    }
    let response = client.send(Method::GET, url, None).await?;
    let metadata = ConsulResponseMetadata::from_response(&response);
    if !response.status().is_success() {
        return ensure_success(response, action, client.token()).await.map(|_| unreachable!());
    }
    let body = read_bounded_response(response, action).await?;
    let items = match &request.target {
        ConsulDomainWatchTarget::CatalogNodes => {
            ConsulDomainWatchItems::CatalogNodes(decode_json_body::<Vec<ConsulCatalogNode>>(&body, action)?)
        }
        ConsulDomainWatchTarget::CatalogServices => {
            ConsulDomainWatchItems::CatalogServices(decode_json_body::<BTreeMap<String, Vec<String>>>(&body, action)?)
        }
        ConsulDomainWatchTarget::CatalogServiceNodes { .. } => ConsulDomainWatchItems::CatalogServiceNodes(
            decode_json_body::<Vec<ConsulCatalogServiceNode>>(&body, action)?,
        ),
        ConsulDomainWatchTarget::CatalogNodeServices { .. } => {
            ConsulDomainWatchItems::CatalogNodeServices(decode_json_body::<ConsulNodeServices>(&body, action)?)
        }
        ConsulDomainWatchTarget::HealthNode { .. } => {
            ConsulDomainWatchItems::HealthNode(decode_health_checks(&body, action)?)
        }
        ConsulDomainWatchTarget::HealthServiceChecks { .. } => {
            ConsulDomainWatchItems::HealthServiceChecks(decode_health_checks(&body, action)?)
        }
        ConsulDomainWatchTarget::HealthServiceInstances { .. } => {
            let mut instances = decode_json_body::<Vec<ConsulServiceInstance>>(&body, action)?;
            for instance in &mut instances {
                mark_maintenance(&mut instance.checks);
            }
            ConsulDomainWatchItems::HealthServiceInstances(instances)
        }
        ConsulDomainWatchTarget::HealthState { .. } => {
            ConsulDomainWatchItems::HealthState(decode_health_checks(&body, action)?)
        }
    };
    Ok(ConsulDomainWatchResponse { items, metadata, changed: false, timed_out: false, index_reset: false })
}

fn decode_health_checks(body: &[u8], action: &str) -> Result<Vec<ConsulHealthCheck>, String> {
    let mut checks = decode_json_body::<Vec<ConsulHealthCheck>>(body, action)?;
    mark_maintenance(&mut checks);
    Ok(checks)
}

fn record_from_entry(entry: ConsulKvEntry) -> Result<ConsulKvRecord, String> {
    let bytes = entry
        .value
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|value| {
            STANDARD.decode(value).map_err(|error| format!("Failed to decode Consul KV Base64 value: {error}"))
        })
        .transpose()?
        .unwrap_or_default();
    let value = match String::from_utf8(bytes.clone()) {
        Ok(data) => KvValue { encoding: KvValueEncoding::Utf8, data },
        Err(_) => KvValue { encoding: KvValueEncoding::Base64, data: STANDARD.encode(bytes) },
    };
    Ok(ConsulKvRecord {
        key: entry.key,
        value,
        flags: KvInt64(entry.flags.to_string()),
        create_index: KvInt64(entry.create_index.to_string()),
        modify_index: KvInt64(entry.modify_index.to_string()),
        lock_index: KvInt64(entry.lock_index.to_string()),
        session: entry.session.filter(|session| !session.is_empty()),
    })
}

fn validate_request(request: &ConsulBlockingRequest) -> Result<(), String> {
    if request.operation_id.trim().is_empty() || request.operation_id.len() > 128 {
        return Err("CONSUL_OPERATION_ID_INVALID: Blocking operation ID is invalid".to_string());
    }
    if request.wait_seconds == 0 || request.wait_seconds > 600 {
        return Err("CONSUL_BLOCKING_WAIT_INVALID: Wait must be between 1 and 600 seconds".to_string());
    }
    Ok(())
}

fn validate_domain_watch_request(request: &ConsulDomainWatchRequest) -> Result<(), String> {
    if request.operation_id.trim().is_empty() || request.operation_id.len() > 128 {
        return Err("CONSUL_OPERATION_ID_INVALID: Blocking operation ID is invalid".to_string());
    }
    if request.wait_seconds == 0 || request.wait_seconds > 600 {
        return Err("CONSUL_BLOCKING_WAIT_INVALID: Wait must be between 1 and 600 seconds".to_string());
    }
    match &request.target {
        ConsulDomainWatchTarget::CatalogNodes | ConsulDomainWatchTarget::CatalogServices => Ok(()),
        ConsulDomainWatchTarget::CatalogServiceNodes { service } if !service.trim().is_empty() => Ok(()),
        ConsulDomainWatchTarget::CatalogNodeServices { node } | ConsulDomainWatchTarget::HealthNode { node }
            if !node.trim().is_empty() =>
        {
            Ok(())
        }
        ConsulDomainWatchTarget::HealthServiceChecks { service }
        | ConsulDomainWatchTarget::HealthServiceInstances { service, .. }
            if !service.trim().is_empty() =>
        {
            Ok(())
        }
        ConsulDomainWatchTarget::HealthState { state }
            if matches!(state.trim().to_ascii_lowercase().as_str(), "any" | "passing" | "warning" | "critical") =>
        {
            Ok(())
        }
        ConsulDomainWatchTarget::CatalogServiceNodes { .. }
        | ConsulDomainWatchTarget::HealthServiceChecks { .. }
        | ConsulDomainWatchTarget::HealthServiceInstances { .. } => {
            Err("CONSUL_INVALID_REQUEST: service is required for watch".to_string())
        }
        ConsulDomainWatchTarget::CatalogNodeServices { .. } | ConsulDomainWatchTarget::HealthNode { .. } => {
            Err("CONSUL_INVALID_REQUEST: node is required for watch".to_string())
        }
        ConsulDomainWatchTarget::HealthState { .. } => {
            Err("CONSUL_INVALID_REQUEST: health state must be any, passing, warning, or critical".to_string())
        }
    }
}

fn encode_path_segment(value: &str) -> String {
    utf8_percent_encode(value.trim(), NON_ALPHANUMERIC).to_string()
}

fn parse_index(value: &KvInt64) -> Result<u64, String> {
    value
        .as_str()
        .parse::<u64>()
        .map_err(|_| "CONSUL_BLOCKING_INDEX_INVALID: Index must be an unsigned 64-bit integer".to_string())
}

fn blocking_registry() -> &'static Mutex<HashMap<String, Arc<BlockingControl>>> {
    BLOCKING.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::consul::test_support::{serve_once, test_client};

    #[test]
    fn rejects_zero_wait_and_invalid_index() {
        let mut request = ConsulBlockingRequest {
            operation_id: "watch".to_string(),
            generation: 1,
            key: "a".to_string(),
            prefix: false,
            index: Some(KvInt64("-1".to_string())),
            wait_seconds: 0,
        };
        assert!(validate_request(&request).is_err());
        request.wait_seconds = 10;
        assert!(parse_index(request.index.as_ref().unwrap()).is_err());
    }

    #[test]
    fn validates_catalog_and_health_watch_targets() {
        let request = ConsulDomainWatchRequest {
            operation_id: "catalog-watch".to_string(),
            generation: 4,
            target: ConsulDomainWatchTarget::CatalogServiceNodes { service: "web/api".to_string() },
            index: Some(KvInt64("0".to_string())),
            wait_seconds: 300,
        };
        assert!(validate_domain_watch_request(&request).is_ok());
        assert_eq!(parse_index(request.index.as_ref().unwrap()).unwrap(), 0);

        let invalid = ConsulDomainWatchRequest {
            target: ConsulDomainWatchTarget::HealthState { state: "unknown".to_string() },
            ..request
        };
        assert!(validate_domain_watch_request(&invalid).is_err());
    }

    #[test]
    fn cancellation_is_bound_to_connection_scope_generation_and_operation() {
        let scope = super::super::ConsulScope {
            datacenter: "dc1".to_string(),
            partition: "partition-a".to_string(),
            namespace: "team-a".to_string(),
        };
        let key = format!("connection-a\0{}\0{}\0{}\0{}\0{}", "dc1", "partition-a", "team-a", 7, "watch-a");
        let control = Arc::new(BlockingControl::default());
        blocking_registry().lock().unwrap().insert(key.clone(), Arc::clone(&control));

        assert!(!consul_cancel_blocking_core("connection-a", &scope, 8, "watch-a"));
        assert!(!control.cancelled.load(Ordering::Acquire));
        assert!(consul_cancel_blocking_core("connection-a", &scope, 7, "watch-a"));
        assert!(control.cancelled.load(Ordering::Acquire));
        blocking_registry().lock().unwrap().remove(&key);
    }

    #[tokio::test]
    async fn blocking_kv_wire_uses_minimum_index_wait_scope_and_encoded_key() {
        let body = r#"[{"Key":"app/a b","Value":"dmFsdWU=","Flags":0,"CreateIndex":1,"ModifyIndex":9,"LockIndex":0}]"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Consul-Index: 9\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let (url, request_rx) = serve_once(response).await;
        let client = test_client(url).await;
        let request = ConsulBlockingRequest {
            operation_id: "watch-1".to_string(),
            generation: 3,
            key: "app/a b".to_string(),
            prefix: true,
            index: None,
            wait_seconds: 10,
        };
        let result = blocking_request(&client, &request, 1).await.unwrap();

        assert_eq!(result.metadata.index.as_ref().unwrap().as_str(), "9");
        assert_eq!(result.entries[0].value.data, "value");
        let raw = request_rx.await.unwrap();
        let headers = raw.split_once("\r\n\r\n").unwrap().0;
        assert!(headers.starts_with("GET /proxy/v1/kv/app/a%20b?"));
        for query in ["dc=dc1", "ns=team-a", "partition=partition-a", "consistent", "index=1", "wait=10s", "recurse"] {
            assert!(headers.contains(query), "missing query component {query}: {headers}");
        }
        assert!(headers.to_ascii_lowercase().contains("x-consul-token: fixture-token"));
    }
}
