use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosCapabilities {
    pub supports_config_management: bool,
    pub supports_config_history: bool,
    pub supports_service_management: bool,
    pub supports_instance_update: bool,
    pub supports_raw_api: bool,
}

impl Default for NacosCapabilities {
    fn default() -> Self {
        Self {
            supports_config_management: true,
            supports_config_history: true,
            supports_service_management: true,
            supports_instance_update: true,
            supports_raw_api: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosConnectionInfo {
    pub server_addr: String,
    pub display_server_addr: String,
    pub namespace: String,
    pub server_version: Option<String>,
    pub auth: String,
    pub capabilities: NacosCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosNamespaceInfo {
    pub namespace: String,
    pub namespace_show_name: String,
    #[serde(default)]
    pub namespace_desc: Option<String>,
    #[serde(default)]
    pub config_count: Option<u64>,
    #[serde(default)]
    pub quota: Option<u64>,
    #[serde(default)]
    pub namespace_type: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosNamespaceCreate {
    #[serde(default)]
    pub namespace_id: Option<String>,
    pub namespace_name: String,
    #[serde(default)]
    pub namespace_desc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosNamespaceUpdate {
    pub namespace_id: String,
    pub namespace_name: String,
    #[serde(default)]
    pub namespace_desc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosConfigQuery {
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub data_id: Option<String>,
    #[serde(default)]
    pub app_name: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub page_no: Option<u32>,
    #[serde(default)]
    pub page_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosConfigItem {
    pub data_id: String,
    pub group: String,
    pub namespace: String,
    #[serde(default)]
    pub app_name: Option<String>,
    #[serde(default)]
    pub desc: Option<String>,
    #[serde(default)]
    pub tags: Option<String>,
    #[serde(default)]
    pub config_type: Option<String>,
    #[serde(default)]
    pub md5: Option<String>,
    #[serde(default)]
    pub encrypted_data_key: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosConfigList {
    pub page_no: u32,
    pub page_size: u32,
    pub total_count: u64,
    pub items: Vec<NacosConfigItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosConfigUpsert {
    #[serde(default)]
    pub namespace: Option<String>,
    pub data_id: String,
    pub group: String,
    pub content: String,
    #[serde(default)]
    pub config_type: Option<String>,
    #[serde(default)]
    pub app_name: Option<String>,
    #[serde(default)]
    pub desc: Option<String>,
    #[serde(default)]
    pub tags: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosConfigKey {
    #[serde(default)]
    pub namespace: Option<String>,
    pub data_id: String,
    pub group: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosConfigHistoryQuery {
    #[serde(default)]
    pub namespace: Option<String>,
    pub data_id: String,
    pub group: String,
    #[serde(default)]
    pub page_no: Option<u32>,
    #[serde(default)]
    pub page_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosConfigHistoryItem {
    pub history_id: String,
    #[serde(default)]
    pub nid: Option<i64>,
    pub data_id: String,
    pub group: String,
    pub namespace: String,
    #[serde(default)]
    pub app_name: Option<String>,
    #[serde(default)]
    pub operation: Option<String>,
    #[serde(default)]
    pub operator: Option<String>,
    #[serde(default)]
    pub last_modified_time: Option<String>,
    #[serde(default)]
    pub config_type: Option<String>,
    #[serde(default)]
    pub tags: Option<String>,
    #[serde(default)]
    pub md5: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosConfigHistoryList {
    pub page_no: u32,
    pub page_size: u32,
    pub total_count: u64,
    pub items: Vec<NacosConfigHistoryItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosConfigHistoryKey {
    #[serde(default)]
    pub namespace: Option<String>,
    pub data_id: String,
    pub group: String,
    pub history_id: String,
    #[serde(default)]
    pub nid: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosConfigRollbackRequest {
    #[serde(default)]
    pub namespace: Option<String>,
    pub data_id: String,
    pub group: String,
    pub history_id: String,
    #[serde(default)]
    pub nid: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosServiceQuery {
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub service_name: Option<String>,
    #[serde(default)]
    pub page_no: Option<u32>,
    #[serde(default)]
    pub page_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosServiceInfo {
    pub service_name: String,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub cluster_count: Option<u64>,
    #[serde(default)]
    pub ip_count: Option<u64>,
    #[serde(default)]
    pub healthy_instance_count: Option<u64>,
    #[serde(default)]
    pub trigger_flag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosServiceList {
    pub page_no: u32,
    pub page_size: u32,
    pub total_count: u64,
    pub items: Vec<NacosServiceInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosInstanceInfo {
    pub ip: String,
    pub port: u16,
    #[serde(default)]
    pub service_name: Option<String>,
    #[serde(default)]
    pub cluster_name: Option<String>,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub healthy: Option<bool>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub ephemeral: Option<bool>,
    #[serde(default)]
    pub weight: Option<f64>,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosInstanceQuery {
    #[serde(default)]
    pub namespace: Option<String>,
    pub service_name: String,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub clusters: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosInstanceUpdate {
    #[serde(default)]
    pub namespace: Option<String>,
    pub service_name: String,
    pub ip: String,
    pub port: u16,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub cluster_name: Option<String>,
    #[serde(default)]
    pub healthy: Option<bool>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub ephemeral: Option<bool>,
    #[serde(default)]
    pub weight: Option<f64>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosRawRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosRawResponse {
    pub status: u16,
    pub body: serde_json::Value,
    #[serde(default)]
    pub text: Option<String>,
}
