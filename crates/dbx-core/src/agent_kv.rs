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
    pub czxid: Option<i64>,
    pub mzxid: Option<i64>,
    pub pzxid: Option<i64>,
    pub ctime: Option<i64>,
    pub mtime: Option<i64>,
    pub cversion: Option<i64>,
    pub aversion: Option<i64>,
    pub ephemeral_owner: Option<i64>,
    pub data_length: Option<u64>,
    pub num_children: Option<i64>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_mode: Option<KvWriteMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_mode: Option<KvCreateMode>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvPutOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_mode: Option<KvWriteMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_mode: Option<KvCreateMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KvWriteMode {
    Upsert,
    Create,
    Update,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KvCreateMode {
    Persistent,
    Ephemeral,
    PersistentSequential,
    EphemeralSequential,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvPutResponse {
    pub revision: Option<i64>,
    pub key: Option<String>,
    pub created_key: Option<String>,
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
    kv_list_prefix_params_with_options(prefix, limit, continuation, None)
}

pub fn kv_list_prefix_params_with_options(
    prefix: &str,
    limit: usize,
    continuation: Option<&str>,
    recursive: Option<bool>,
) -> serde_json::Value {
    serde_json::to_value(KvListPrefixRequest {
        prefix: prefix.to_string(),
        limit,
        continuation: continuation.map(str::to_string),
        recursive,
    })
    .expect("KV list prefix request should serialize")
}

pub fn kv_get_params(key: &str) -> serde_json::Value {
    serde_json::to_value(KvGetRequest { key: key.to_string() }).expect("KV get request should serialize")
}

pub fn kv_put_params(key: &str, value: KvValue, lease: Option<i64>) -> serde_json::Value {
    kv_put_params_with_options(key, value, KvPutOptions { lease, ..KvPutOptions::default() })
}

pub fn kv_put_params_with_options(key: &str, value: KvValue, options: KvPutOptions) -> serde_json::Value {
    serde_json::to_value(KvPutRequest {
        key: key.to_string(),
        value,
        lease: options.lease,
        write_mode: options.write_mode,
        create_mode: options.create_mode,
    })
    .expect("KV put request should serialize")
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
    kv_list_prefix_core_with_options(state, connection_id, prefix, limit, continuation, None).await
}

pub async fn kv_list_prefix_core_with_options(
    state: &AppState,
    connection_id: &str,
    prefix: &str,
    limit: usize,
    continuation: Option<&str>,
    recursive: Option<bool>,
) -> Result<KvListPrefixResponse, String> {
    call_agent_kv(
        state,
        connection_id,
        AgentKvMethod::ListPrefix,
        kv_list_prefix_params_with_options(prefix, limit, continuation, recursive),
    )
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
    kv_put_core_with_options(state, connection_id, key, value, KvPutOptions { lease, ..KvPutOptions::default() }).await
}

pub async fn kv_put_core_with_options(
    state: &AppState,
    connection_id: &str,
    key: &str,
    value: KvValue,
    options: KvPutOptions,
) -> Result<KvPutResponse, String> {
    call_agent_kv(state, connection_id, AgentKvMethod::Put, kv_put_params_with_options(key, value, options)).await
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
    fn serializes_kv_list_prefix_params_with_recursive_false() {
        assert_eq!(
            kv_list_prefix_params_with_options("/app", 200, None, Some(false)),
            serde_json::json!({
                "prefix": "/app",
                "limit": 200,
                "recursive": false
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
    fn serializes_kv_put_options_without_changing_default_shape() {
        let value = KvValue { encoding: KvValueEncoding::Utf8, data: "dbx".to_string() };
        assert_eq!(
            kv_put_params("/app/name", value.clone(), None),
            serde_json::json!({
                "key": "/app/name",
                "value": {
                    "encoding": "utf8",
                    "data": "dbx"
                }
            })
        );
        assert_eq!(
            kv_put_params_with_options(
                "/jobs/job-",
                value,
                KvPutOptions {
                    write_mode: Some(KvWriteMode::Create),
                    create_mode: Some(KvCreateMode::EphemeralSequential),
                    ..KvPutOptions::default()
                },
            ),
            serde_json::json!({
                "key": "/jobs/job-",
                "value": {
                    "encoding": "utf8",
                    "data": "dbx"
                },
                "writeMode": "create",
                "createMode": "ephemeral_sequential"
            })
        );
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

    #[test]
    fn decodes_kv_put_response_with_created_key() {
        let decoded: KvPutResponse = serde_json::from_value(serde_json::json!({
            "key": "/jobs/job-0000000001",
            "createdKey": "/jobs/job-0000000001"
        }))
        .unwrap();

        assert_eq!(decoded.revision, None);
        assert_eq!(decoded.key.as_deref(), Some("/jobs/job-0000000001"));
        assert_eq!(decoded.created_key.as_deref(), Some("/jobs/job-0000000001"));
    }

    #[test]
    fn decodes_zookeeper_metadata_fields() {
        let decoded: KvGetResponse = serde_json::from_value(serde_json::json!({
            "found": true,
            "key": "/admin",
            "value": {
                "encoding": "utf8",
                "data": ""
            },
            "metadata": {
                "czxid": 27,
                "mzxid": 27,
                "pzxid": 39825,
                "ctime": 1780674584000_i64,
                "mtime": 1780674585000_i64,
                "cversion": 5,
                "aversion": 0,
                "ephemeralOwner": 0,
                "dataLength": 0,
                "numChildren": 5
            }
        }))
        .unwrap();

        let metadata = decoded.metadata.unwrap();
        assert_eq!(metadata.czxid, Some(27));
        assert_eq!(metadata.mzxid, Some(27));
        assert_eq!(metadata.pzxid, Some(39825));
        assert_eq!(metadata.ephemeral_owner, Some(0));
        assert_eq!(metadata.num_children, Some(5));
    }
}
