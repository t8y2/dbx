use serde::{Deserialize, Serialize};

use crate::connection::{AppState, PoolKind};
use crate::db::agent_driver::{AgentCapability, AgentKvMethod};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvValue {
    pub encoding: KvValueEncoding,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KvValueEncoding {
    Utf8,
    Base64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvKeyMetadata {
    pub create_revision: Option<i64>,
    pub mod_revision: Option<i64>,
    pub version: Option<i64>,
    pub lease: Option<i64>,
    pub value_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvKeySummary {
    pub key: String,
    #[serde(flatten)]
    pub metadata: KvKeyMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvListPrefixRequest {
    pub prefix: String,
    pub limit: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvListPrefixResponse {
    pub keys: Vec<KvKeySummary>,
    pub continuation: Option<String>,
    pub revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvGetRequest {
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvGetResponse {
    pub found: bool,
    pub key: Option<String>,
    pub value: Option<KvValue>,
    pub metadata: Option<KvKeyMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvPutRequest {
    pub key: String,
    pub value: KvValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvPutResponse {
    pub revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvDeleteRequest {
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvDeleteResponse {
    pub deleted: u64,
    pub revision: Option<i64>,
}

pub fn kv_list_prefix_params(prefix: &str, limit: usize, continuation: Option<&str>) -> serde_json::Value {
    serde_json::to_value(KvListPrefixRequest {
        prefix: prefix.to_string(),
        limit,
        continuation: continuation.map(str::to_string),
    })
    .expect("KV list prefix request should serialize")
}

pub fn kv_get_params(key: &str) -> serde_json::Value {
    serde_json::to_value(KvGetRequest { key: key.to_string() }).expect("KV get request should serialize")
}

pub fn kv_put_params(key: &str, value: KvValue, lease: Option<i64>) -> serde_json::Value {
    serde_json::to_value(KvPutRequest { key: key.to_string(), value, lease }).expect("KV put request should serialize")
}

pub fn kv_delete_params(key: &str) -> serde_json::Value {
    serde_json::to_value(KvDeleteRequest { key: key.to_string() }).expect("KV delete request should serialize")
}

pub async fn kv_list_prefix_core(
    state: &AppState,
    connection_id: &str,
    prefix: &str,
    limit: usize,
    continuation: Option<&str>,
) -> Result<KvListPrefixResponse, String> {
    call_agent_kv(state, connection_id, AgentKvMethod::ListPrefix, kv_list_prefix_params(prefix, limit, continuation))
        .await
}

pub async fn kv_get_core(state: &AppState, connection_id: &str, key: &str) -> Result<KvGetResponse, String> {
    call_agent_kv(state, connection_id, AgentKvMethod::Get, kv_get_params(key)).await
}

pub async fn kv_put_core(
    state: &AppState,
    connection_id: &str,
    key: &str,
    value: KvValue,
    lease: Option<i64>,
) -> Result<KvPutResponse, String> {
    call_agent_kv(state, connection_id, AgentKvMethod::Put, kv_put_params(key, value, lease)).await
}

pub async fn kv_delete_core(state: &AppState, connection_id: &str, key: &str) -> Result<KvDeleteResponse, String> {
    call_agent_kv(state, connection_id, AgentKvMethod::Delete, kv_delete_params(key)).await
}

async fn ensure_agent_kv_pool(state: &AppState, connection_id: &str) -> Result<(), String> {
    state.get_or_create_pool(connection_id, None).await.map(|_| ())
}

async fn call_agent_kv<T: serde::de::DeserializeOwned + Send + 'static>(
    state: &AppState,
    connection_id: &str,
    method: AgentKvMethod,
    params: serde_json::Value,
) -> Result<T, String> {
    ensure_agent_kv_pool(state, connection_id).await?;

    let connections = state.connections.read().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            if !client.supports_capability(AgentCapability::Kv) {
                return Err("Agent does not support key-value operations".to_string());
            }
            client.call_kv_method(method, params).await
        }
        _ => Err("Not an agent key-value connection".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_kv_list_prefix_params() {
        assert_eq!(
            kv_list_prefix_params("/config/", 100, Some("next-token")),
            serde_json::json!({
                "prefix": "/config/",
                "limit": 100,
                "continuation": "next-token"
            })
        );
        assert_eq!(
            kv_list_prefix_params("", 50, None),
            serde_json::json!({
                "prefix": "",
                "limit": 50
            })
        );
    }

    #[test]
    fn serializes_kv_get_put_delete_params() {
        assert_eq!(kv_get_params("/app/name"), serde_json::json!({ "key": "/app/name" }));
        assert_eq!(
            kv_put_params("/app/name", KvValue { encoding: KvValueEncoding::Utf8, data: "dbx".to_string() }, Some(42),),
            serde_json::json!({
                "key": "/app/name",
                "value": {
                    "encoding": "utf8",
                    "data": "dbx"
                },
                "lease": 42
            })
        );
        assert_eq!(kv_delete_params("/app/name"), serde_json::json!({ "key": "/app/name" }));
    }

    #[test]
    fn decodes_kv_list_prefix_response() {
        let decoded: KvListPrefixResponse = serde_json::from_value(serde_json::json!({
            "keys": [{
                "key": "/app/name",
                "createRevision": 1,
                "modRevision": 2,
                "version": 3,
                "lease": 0,
                "valueSize": 5
            }],
            "continuation": "next-token",
            "revision": 9
        }))
        .unwrap();

        assert_eq!(decoded.keys[0].key, "/app/name");
        assert_eq!(decoded.keys[0].metadata.mod_revision, Some(2));
        assert_eq!(decoded.continuation.as_deref(), Some("next-token"));
        assert_eq!(decoded.revision, Some(9));
    }
}
