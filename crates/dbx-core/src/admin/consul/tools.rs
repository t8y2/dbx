use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::agent_kv::KvInt64;
use crate::connection::AppState;

use super::client::{client_for_state, ensure_writable_core, ConsulClient};

const MAX_EVENT_PAYLOAD_BYTES: usize = 100;
const MAX_EVENT_NAME_BYTES: usize = 256;
const MAX_EVENT_FILTER_BYTES: usize = 1_024;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulPreparedQueryService {
    pub service: String,
    #[serde(default)]
    pub near: String,
    #[serde(default)]
    pub only_passing: bool,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulPreparedQuery {
    #[serde(rename = "ID", alias = "Id", default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub session: String,
    pub service: ConsulPreparedQueryService,
    #[serde(default = "zero_index")]
    pub create_index: KvInt64,
    #[serde(default = "zero_index")]
    pub modify_index: KvInt64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulPreparedQueryInput {
    pub name: String,
    pub session: String,
    pub service: ConsulPreparedQueryService,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct ConsulPreparedQueryWrite<'a> {
    name: &'a str,
    session: &'a str,
    service: &'a ConsulPreparedQueryService,
}

impl ConsulPreparedQueryInput {
    fn wire(&self) -> ConsulPreparedQueryWrite<'_> {
        ConsulPreparedQueryWrite { name: &self.name, session: &self.session, service: &self.service }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulPreparedQueryExecuteRequest {
    pub query: String,
    pub limit: usize,
    pub connect: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulPreparedQueryNode {
    pub node: ConsulPreparedNodeIdentity,
    pub service: ConsulPreparedServiceIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulPreparedNodeIdentity {
    pub node: String,
    pub address: String,
    #[serde(default)]
    pub datacenter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulPreparedServiceIdentity {
    #[serde(rename = "ID", alias = "Id")]
    pub id: String,
    pub service: String,
    #[serde(default)]
    pub address: String,
    pub port: u16,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulPreparedQueryExecuteResponse {
    #[serde(default)]
    pub service: String,
    #[serde(default)]
    pub nodes: Vec<ConsulPreparedQueryNode>,
    #[serde(rename = "DNS", alias = "Dns", default)]
    pub dns: ConsulPreparedQueryDns,
    #[serde(default)]
    pub datacenter: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulPreparedQueryDns {
    #[serde(rename = "TTL", alias = "Ttl", default)]
    pub ttl: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ConsulPreparedQueryExplainResponse {
    query: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulEventFireRequest {
    pub name: String,
    pub payload_base64: String,
    pub node_filter: String,
    pub service_filter: String,
    pub tag_filter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulEvent {
    #[serde(rename = "ID", alias = "Id")]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub payload: Option<String>,
    #[serde(default)]
    pub node_filter: String,
    #[serde(default)]
    pub service_filter: String,
    #[serde(default)]
    pub tag_filter: String,
    #[serde(default = "zero_index")]
    pub l_time: KvInt64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulCoordinate {
    pub node: String,
    #[serde(default)]
    pub segment: String,
    pub coord: ConsulCoordinateValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulCoordinateValue {
    #[serde(default)]
    pub vec: Vec<f64>,
    pub error: f64,
    pub adjustment: f64,
    pub height: f64,
}

impl ConsulClient {
    async fn prepared_queries(&self) -> Result<Vec<ConsulPreparedQuery>, String> {
        let url = self.api_url("/v1/query")?;
        self.request_json(Method::GET, url, None::<&()>, true, "list prepared queries").await
    }
}

pub async fn consul_prepared_query_list_core(
    state: &AppState,
    connection_id: &str,
) -> Result<Vec<ConsulPreparedQuery>, String> {
    client_for_state(state, connection_id).await?.prepared_queries().await
}

pub async fn consul_prepared_query_read_core(
    state: &AppState,
    connection_id: &str,
    id: &str,
) -> Result<ConsulPreparedQuery, String> {
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url(&format!("/v1/query/{}", encode(id)))?;
    client
        .request_json::<Vec<ConsulPreparedQuery>, _>(Method::GET, url, None::<&()>, true, "read prepared query")
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| "CONSUL_QUERY_NOT_FOUND: Prepared query not found".to_string())
}

pub async fn consul_prepared_query_create_core(
    state: &AppState,
    connection_id: &str,
    input: ConsulPreparedQueryInput,
) -> Result<String, String> {
    ensure_writable_core(state, connection_id, "create Consul prepared query").await?;
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url("/v1/query")?;
    #[derive(Deserialize)]
    struct Created {
        #[serde(rename = "ID")]
        id: String,
    }
    Ok(client
        .request_json::<Created, _>(Method::POST, url, Some(&input.wire()), false, "create prepared query")
        .await?
        .id)
}

pub async fn consul_prepared_query_update_core(
    state: &AppState,
    connection_id: &str,
    id: &str,
    input: ConsulPreparedQueryInput,
) -> Result<(), String> {
    ensure_writable_core(state, connection_id, "update Consul prepared query").await?;
    let client = client_for_state(state, connection_id).await?;
    let read_url = client.api_url(&format!("/v1/query/{}", encode(id)))?;
    let mut existing = client
        .request_json::<Vec<serde_json::Value>, _>(
            Method::GET,
            read_url,
            None::<&()>,
            true,
            "read prepared query before update",
        )
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| "CONSUL_QUERY_NOT_FOUND: Prepared query not found".to_string())?;
    apply_prepared_query_patch(&mut existing, &input)?;
    let url = client.api_url(&format!("/v1/query/{}", encode(id)))?;
    client.send_json(Method::PUT, url, Some(&existing), false, "update prepared query").await.map(|_| ())
}

fn apply_prepared_query_patch(
    existing: &mut serde_json::Value,
    input: &ConsulPreparedQueryInput,
) -> Result<(), String> {
    if input.name.trim().is_empty() || input.service.service.trim().is_empty() {
        return Err("CONSUL_INVALID_REQUEST: Prepared query name and service are required".to_string());
    }
    let object = existing
        .as_object_mut()
        .ok_or_else(|| "CONSUL_INVALID_RESPONSE: Prepared query is not an object".to_string())?;
    object.remove("ID");
    object.remove("CreateIndex");
    object.remove("ModifyIndex");
    object.insert("Name".to_string(), serde_json::Value::String(input.name.trim().to_string()));
    let service = object
        .entry("Service")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()))
        .as_object_mut()
        .ok_or_else(|| "CONSUL_INVALID_RESPONSE: Prepared query Service is not an object".to_string())?;
    service.insert("Service".to_string(), serde_json::Value::String(input.service.service.trim().to_string()));
    Ok(())
}

pub async fn consul_prepared_query_delete_core(state: &AppState, connection_id: &str, id: &str) -> Result<(), String> {
    ensure_writable_core(state, connection_id, "delete Consul prepared query").await?;
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url(&format!("/v1/query/{}", encode(id)))?;
    client.send_json(Method::DELETE, url, None::<&()>, false, "delete prepared query").await.map(|_| ())
}

pub async fn consul_prepared_query_execute_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulPreparedQueryExecuteRequest,
) -> Result<ConsulPreparedQueryExecuteResponse, String> {
    let client = client_for_state(state, connection_id).await?;
    let mut url = client.api_url(&format!("/v1/query/{}/execute", encode(&request.query)))?;
    url.query_pairs_mut()
        .append_pair("limit", &request.limit.clamp(1, 1000).to_string())
        .append_pair("connect", if request.connect { "true" } else { "false" });
    client.request_json(Method::GET, url, None::<&()>, true, "execute prepared query").await
}

pub async fn consul_prepared_query_explain_core(
    state: &AppState,
    connection_id: &str,
    query: &str,
) -> Result<serde_json::Value, String> {
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url(&format!("/v1/query/{}/explain", encode(query)))?;
    let response: ConsulPreparedQueryExplainResponse =
        client.request_json(Method::GET, url, None::<&()>, true, "explain prepared query").await?;
    let mut query = response.query;
    redact_prepared_query_secrets(&mut query);
    Ok(query)
}

fn redact_prepared_query_secrets(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, value) in object {
                if key.eq_ignore_ascii_case("token") {
                    *value = serde_json::Value::String("****************".to_string());
                } else {
                    redact_prepared_query_secrets(value);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                redact_prepared_query_secrets(value);
            }
        }
        _ => {}
    }
}

pub async fn consul_event_list_core(
    state: &AppState,
    connection_id: &str,
    name: Option<&str>,
) -> Result<Vec<ConsulEvent>, String> {
    let client = client_for_state(state, connection_id).await?;
    let mut url = client.api_url("/v1/event/list")?;
    if let Some(name) = name.filter(|name| !name.is_empty()) {
        url.query_pairs_mut().append_pair("name", name);
    }
    client.request_json(Method::GET, url, None::<&()>, true, "list Consul events").await
}

pub async fn consul_event_fire_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulEventFireRequest,
) -> Result<ConsulEvent, String> {
    ensure_writable_core(state, connection_id, "fire Consul event").await?;
    validate_event_text(&request.name, "name", MAX_EVENT_NAME_BYTES)?;
    if request.name.starts_with('_') {
        return Err("CONSUL_EVENT_NAME_RESERVED: Event names beginning with '_' are reserved by Consul".to_string());
    }
    for (name, value) in [
        ("node filter", request.node_filter.as_str()),
        ("service filter", request.service_filter.as_str()),
        ("tag filter", request.tag_filter.as_str()),
    ] {
        if value.len() > MAX_EVENT_FILTER_BYTES {
            return Err(format!("CONSUL_EVENT_FILTER_TOO_LARGE: {name} exceeds {MAX_EVENT_FILTER_BYTES} bytes"));
        }
    }
    let encoded_payload = request.payload_base64.trim();
    let max_encoded_len = MAX_EVENT_PAYLOAD_BYTES.div_ceil(3) * 4;
    if encoded_payload.len() > max_encoded_len {
        return Err(format!("CONSUL_EVENT_PAYLOAD_TOO_LARGE: Event payload exceeds {MAX_EVENT_PAYLOAD_BYTES} bytes"));
    }
    let payload = STANDARD.decode(encoded_payload).map_err(|error| format!("CONSUL_EVENT_PAYLOAD_INVALID: {error}"))?;
    if payload.len() > MAX_EVENT_PAYLOAD_BYTES {
        return Err(format!("CONSUL_EVENT_PAYLOAD_TOO_LARGE: Event payload exceeds {MAX_EVENT_PAYLOAD_BYTES} bytes"));
    }
    let client = client_for_state(state, connection_id).await?;
    let mut url = client.api_url(&format!("/v1/event/fire/{}", encode(&request.name)))?;
    {
        let mut query = url.query_pairs_mut();
        if !request.node_filter.is_empty() {
            query.append_pair("node", &request.node_filter);
        }
        if !request.service_filter.is_empty() {
            query.append_pair("service", &request.service_filter);
        }
        if !request.tag_filter.is_empty() {
            query.append_pair("tag", &request.tag_filter);
        }
    }
    client.append_scope(&mut url, false);
    let response = client.send(Method::PUT, url, Some(payload)).await?;
    let response = super::response::ensure_success(response, "fire Consul event", client.token()).await?;
    super::response::decode_json_response(response, "fire Consul event").await
}

fn validate_event_text(value: &str, field: &str, max_bytes: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("CONSUL_INVALID_REQUEST: Event {field} is required"));
    }
    if value.len() > max_bytes {
        return Err(format!("CONSUL_EVENT_INPUT_TOO_LARGE: Event {field} exceeds {max_bytes} bytes"));
    }
    Ok(())
}

pub async fn consul_coordinate_nodes_core(
    state: &AppState,
    connection_id: &str,
) -> Result<Vec<ConsulCoordinate>, String> {
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url("/v1/coordinate/nodes")?;
    client.request_json(Method::GET, url, None::<&()>, true, "list network coordinates").await
}

fn encode(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn zero_index() -> KvInt64 {
    KvInt64("0".to_string())
}

fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_query_transport_input_maps_to_pascal_case_wire_body() {
        let input = ConsulPreparedQueryInput {
            name: "payments".into(),
            session: "session-1".into(),
            service: ConsulPreparedQueryService { service: "api".into(), ..Default::default() },
        };
        let value = serde_json::to_value(input.wire()).unwrap();
        assert_eq!(value["Name"], "payments");
        assert_eq!(value["Session"], "session-1");
        assert_eq!(value["Service"]["Service"], "api");
        assert!(value.get("name").is_none());
    }

    #[test]
    fn prepared_query_update_preserves_advanced_and_sensitive_fields() {
        let mut existing = serde_json::json!({
            "ID": "query-1",
            "Name": "old",
            "Token": "keep-secret",
            "Service": { "Service": "old-api", "Near": "_agent", "Tags": ["v1"], "Failover": { "Datacenters": ["dc2"] } },
            "DNS": { "TTL": "5s" },
            "CreateIndex": 10,
            "ModifyIndex": 11
        });
        let input = ConsulPreparedQueryInput {
            name: "new".into(),
            session: String::new(),
            service: ConsulPreparedQueryService { service: "new-api".into(), ..Default::default() },
        };
        apply_prepared_query_patch(&mut existing, &input).unwrap();
        assert_eq!(existing["Name"], "new");
        assert_eq!(existing["Service"]["Service"], "new-api");
        assert_eq!(existing["Service"]["Near"], "_agent");
        assert_eq!(existing["Token"], "keep-secret");
        assert_eq!(existing["DNS"]["TTL"], "5s");
        assert!(existing.get("ID").is_none());
        assert!(existing.get("ModifyIndex").is_none());
    }

    #[test]
    fn event_validation_rejects_reserved_names_and_oversized_encoded_payloads() {
        assert!(validate_event_text("", "name", MAX_EVENT_NAME_BYTES).is_err());
        assert!("_internal".starts_with('_'));
        let oversized = vec![0_u8; MAX_EVENT_PAYLOAD_BYTES + 3];
        assert!(STANDARD.encode(oversized).len() > MAX_EVENT_PAYLOAD_BYTES.div_ceil(3) * 4);
    }

    #[test]
    fn official_event_response_uses_id_acronym() {
        let event: ConsulEvent = serde_json::from_value(serde_json::json!({
            "ID": "7f12d2f4-2cb8-4795-9e5f-f8e35e9912aa",
            "Name": "deploy",
            "Payload": "cmVsZWFzZS0x",
            "NodeFilter": "",
            "ServiceFilter": "api",
            "TagFilter": "v1",
            "Version": 1,
            "LTime": 42
        }))
        .unwrap();
        assert_eq!(event.id, "7f12d2f4-2cb8-4795-9e5f-f8e35e9912aa");
        assert_eq!(event.l_time, KvInt64("42".into()));
        let encoded = serde_json::to_value(event).unwrap();
        assert_eq!(encoded["ID"], "7f12d2f4-2cb8-4795-9e5f-f8e35e9912aa");
        assert!(encoded.get("Id").is_none());
    }

    #[test]
    fn official_prepared_query_response_preserves_protocol_acronyms() {
        let query: ConsulPreparedQuery = serde_json::from_value(serde_json::json!({
            "ID": "query-1",
            "Name": "payments",
            "Session": "",
            "Service": { "Service": "api", "Near": "", "OnlyPassing": true, "Tags": ["v1"] },
            "CreateIndex": 10,
            "ModifyIndex": 11
        }))
        .unwrap();
        assert_eq!(query.id, "query-1");
        let encoded = serde_json::to_value(query).unwrap();
        assert_eq!(encoded["ID"], "query-1");
        assert!(encoded.get("Id").is_none());
    }

    #[test]
    fn official_prepared_query_execute_response_preserves_dns_ttl_and_service_id() {
        let response: ConsulPreparedQueryExecuteResponse = serde_json::from_value(serde_json::json!({
            "Service": "api",
            "Nodes": [{
                "Node": { "Node": "node-1", "Address": "10.0.0.1", "Datacenter": "dc1" },
                "Service": { "ID": "api-1", "Service": "api", "Port": 8080, "Tags": null }
            }],
            "DNS": { "TTL": "5s" },
            "Datacenter": "dc1"
        }))
        .unwrap();
        assert_eq!(response.nodes[0].service.id, "api-1");
        assert_eq!(response.nodes[0].service.address, "");
        assert!(response.nodes[0].service.tags.is_empty());
        assert_eq!(response.dns.ttl, "5s");
        let encoded = serde_json::to_value(response).unwrap();
        assert_eq!(encoded["Nodes"][0]["Service"]["ID"], "api-1");
        assert_eq!(encoded["DNS"]["TTL"], "5s");
        assert!(encoded.get("Dns").is_none());
    }

    #[test]
    fn official_prepared_query_explain_response_unwraps_query_document() {
        let response: ConsulPreparedQueryExplainResponse = serde_json::from_value(serde_json::json!({
            "Query": {
                "ID": "query-1",
                "Name": "payments",
                "Session": "",
                "Token": "secret-management-token",
                "Template": { "Type": "name_prefix_match", "Regexp": "^payments-(.*)$" },
                "Service": { "Service": "api", "Near": "", "OnlyPassing": true, "Tags": [] },
                "DNS": { "TTL": "5s" },
                "CreateIndex": 10,
                "ModifyIndex": 11
            },
            "Index": 11,
            "KnownLeader": true
        }))
        .unwrap();
        let mut query = response.query;
        redact_prepared_query_secrets(&mut query);
        assert_eq!(query["ID"], "query-1");
        assert_eq!(query["Service"]["Service"], "api");
        assert_eq!(query["Template"]["Type"], "name_prefix_match");
        assert_eq!(query["DNS"]["TTL"], "5s");
        assert_eq!(query["Token"], "****************");
    }
}
