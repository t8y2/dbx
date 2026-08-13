use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosCapabilities {
    pub supports_config_management: bool,
    pub supports_config_history: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_unavailable_reason: Option<String>,
    pub supports_service_management: bool,
    pub supports_instance_update: bool,
    pub supports_raw_api: bool,
    #[serde(default)]
    pub service_management: NacosServiceCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosOperationCapability {
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<NacosCapabilityReason>,
}

impl NacosOperationCapability {
    pub fn supported() -> Self {
        Self { supported: true, reason: None }
    }

    pub fn unsupported(reason: NacosCapabilityReason) -> Self {
        Self { supported: false, reason: Some(reason) }
    }
}

impl Default for NacosOperationCapability {
    fn default() -> Self {
        Self::supported()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NacosCapabilityReason {
    ImplementationReadOnly,
    VersionUnsupported,
    EndpointUnavailable,
    NotVerified,
    ConnectionReadOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NacosServiceOperation {
    ListServices,
    GetService,
    CreateService,
    UpdateService,
    DeleteService,
    ListInstances,
    UpdateInstance,
    RegisterInstance,
    DeregisterInstance,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NacosServiceCapabilities {
    pub list_services: NacosOperationCapability,
    pub get_service: NacosOperationCapability,
    pub create_service: NacosOperationCapability,
    pub update_service: NacosOperationCapability,
    pub delete_service: NacosOperationCapability,
    pub list_instances: NacosOperationCapability,
    pub update_instance: NacosOperationCapability,
    pub register_instance: NacosOperationCapability,
    pub deregister_instance: NacosOperationCapability,
}

impl NacosServiceCapabilities {
    pub fn read_only(reason: NacosCapabilityReason) -> Self {
        Self {
            list_services: NacosOperationCapability::supported(),
            get_service: NacosOperationCapability::supported(),
            create_service: NacosOperationCapability::unsupported(reason),
            update_service: NacosOperationCapability::unsupported(reason),
            delete_service: NacosOperationCapability::unsupported(reason),
            list_instances: NacosOperationCapability::supported(),
            update_instance: NacosOperationCapability::unsupported(reason),
            register_instance: NacosOperationCapability::unsupported(reason),
            deregister_instance: NacosOperationCapability::unsupported(reason),
        }
    }

    pub fn operation(&self, operation: NacosServiceOperation) -> &NacosOperationCapability {
        match operation {
            NacosServiceOperation::ListServices => &self.list_services,
            NacosServiceOperation::GetService => &self.get_service,
            NacosServiceOperation::CreateService => &self.create_service,
            NacosServiceOperation::UpdateService => &self.update_service,
            NacosServiceOperation::DeleteService => &self.delete_service,
            NacosServiceOperation::ListInstances => &self.list_instances,
            NacosServiceOperation::UpdateInstance => &self.update_instance,
            NacosServiceOperation::RegisterInstance => &self.register_instance,
            NacosServiceOperation::DeregisterInstance => &self.deregister_instance,
        }
    }
}

impl Default for NacosCapabilities {
    fn default() -> Self {
        Self {
            supports_config_management: true,
            supports_config_history: true,
            history_unavailable_reason: None,
            supports_service_management: true,
            supports_instance_update: true,
            supports_raw_api: true,
            service_management: NacosServiceCapabilities::default(),
        }
    }
}

/// A short-lived challenge returned by the authenticated r-nacos console.
/// The corresponding server-side CAPTCHA token stays in the adapter process;
/// only the image is returned to the desktop client.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosRNacosConsoleCaptcha {
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
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
    /// Applies case-insensitive contains matching to `group` after listing.
    /// Defaults to exact server-side filtering for internal callers.
    #[serde(default)]
    pub group_contains: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum NacosNamespaceScope {
    #[default]
    CurrentNamespace,
    AllNamespaces,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosContentSearchRequest {
    pub operation_id: String,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub scope: NacosNamespaceScope,
    pub query: String,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub data_id: Option<String>,
    #[serde(default)]
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosContentMatch {
    pub namespace: String,
    pub group: String,
    pub data_id: String,
    pub line_number: u64,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosSearchFailure {
    pub namespace: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosSearchProgress {
    pub operation_id: String,
    pub phase: String,
    #[serde(default)]
    pub namespace: Option<String>,
    pub scanned: u64,
    #[serde(default)]
    pub total: Option<u64>,
    pub matched: u64,
    #[serde(default)]
    pub matches: Vec<NacosContentMatch>,
    #[serde(default)]
    pub failures: Vec<NacosSearchFailure>,
    pub truncated: bool,
    pub cancelled: bool,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosContentSearchResult {
    pub operation_id: String,
    pub scanned: u64,
    pub matches: Vec<NacosContentMatch>,
    pub failures: Vec<NacosSearchFailure>,
    pub truncated: bool,
    pub cancelled: bool,
    pub incomplete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum NacosConfigSelectionScope {
    Selected,
    Filtered,
    #[default]
    Namespace,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosConfigSelector {
    pub namespace: String,
    #[serde(default)]
    pub scope: NacosConfigSelectionScope,
    #[serde(default)]
    pub keys: Vec<NacosConfigKey>,
    #[serde(default)]
    pub query: Option<NacosConfigQuery>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NacosConflictPolicy {
    #[default]
    Abort,
    Skip,
    Overwrite,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosBatchPreviewItem {
    pub namespace: String,
    pub group: String,
    pub data_id: String,
    pub status: String,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosBatchPreview {
    pub plan_hash: String,
    pub total: u64,
    pub created: u64,
    pub conflicts: u64,
    pub invalid: u64,
    pub items: Vec<NacosBatchPreviewItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosBatchItemResult {
    pub namespace: String,
    pub group: String,
    pub data_id: String,
    pub status: String,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosBatchReport {
    pub operation_id: String,
    #[serde(default)]
    pub plan_hash: Option<String>,
    pub total: u64,
    pub created: u64,
    pub overwritten: u64,
    pub skipped: u64,
    pub failed: u64,
    pub aborted: bool,
    pub partial: bool,
    pub cancelled: bool,
    pub items: Vec<NacosBatchItemResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosConfigTransferRequest {
    pub operation_id: String,
    pub source_connection_id: String,
    pub target_connection_id: String,
    pub source: NacosConfigSelector,
    pub target_namespace: String,
    #[serde(default)]
    pub conflict_policy: NacosConflictPolicy,
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
pub struct NacosServiceDetail {
    pub service_name: String,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(default)]
    pub protect_threshold: Option<f64>,
    #[serde(default)]
    pub selector: Option<serde_json::Value>,
    #[serde(default)]
    pub ephemeral: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosServiceUpsert {
    #[serde(default)]
    pub namespace: Option<String>,
    pub service_name: String,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub protect_threshold: Option<f64>,
    #[serde(default)]
    pub selector: Option<serde_json::Value>,
    #[serde(default)]
    pub ephemeral: Option<bool>,
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
pub struct NacosInstanceRef {
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
    pub ephemeral: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NacosInstancePatch {
    #[serde(default)]
    pub healthy: Option<bool>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub weight: Option<f64>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosInstanceUpdateRequest {
    pub target: NacosInstanceRef,
    pub patch: NacosInstancePatch,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosInstanceRegistration {
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
    pub weight: Option<f64>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosDashboardQuery {
    #[serde(default)]
    pub namespace: Option<String>,
}

#[cfg(test)]
mod service_capability_tests {
    use super::*;

    #[test]
    fn official_nacos_service_capabilities_enable_every_supported_operation() {
        let capabilities = NacosServiceCapabilities::default();
        for operation in [
            NacosServiceOperation::ListServices,
            NacosServiceOperation::GetService,
            NacosServiceOperation::CreateService,
            NacosServiceOperation::UpdateService,
            NacosServiceOperation::DeleteService,
            NacosServiceOperation::ListInstances,
            NacosServiceOperation::UpdateInstance,
            NacosServiceOperation::RegisterInstance,
            NacosServiceOperation::DeregisterInstance,
        ] {
            assert!(capabilities.operation(operation).supported);
        }
    }

    #[test]
    fn read_only_implementation_preserves_reads_and_explains_writes() {
        let capabilities = NacosServiceCapabilities::read_only(NacosCapabilityReason::ImplementationReadOnly);
        assert!(capabilities.list_services.supported);
        assert!(capabilities.get_service.supported);
        assert!(capabilities.list_instances.supported);
        assert_eq!(capabilities.update_instance.reason, Some(NacosCapabilityReason::ImplementationReadOnly));
        assert_eq!(capabilities.create_service.reason, Some(NacosCapabilityReason::ImplementationReadOnly));
        assert_eq!(capabilities.deregister_instance.reason, Some(NacosCapabilityReason::ImplementationReadOnly));
    }

    #[test]
    fn service_capabilities_use_the_tauri_and_web_camel_case_contract() {
        let value =
            serde_json::to_value(NacosServiceCapabilities::read_only(NacosCapabilityReason::NotVerified)).unwrap();
        assert_eq!(value["listServices"]["supported"], true);
        assert_eq!(value["createService"]["supported"], false);
        assert_eq!(value["createService"]["reason"], "notVerified");
        assert!(value.get("manageServices").is_none());
    }

    #[test]
    fn instance_update_uses_nested_target_and_patch_transport_contract() {
        let value = serde_json::to_value(NacosInstanceUpdateRequest {
            target: NacosInstanceRef {
                namespace: Some("public".to_string()),
                service_name: "api".to_string(),
                ip: "127.0.0.1".to_string(),
                port: 8080,
                group_name: Some("DBX_TEST".to_string()),
                cluster_name: Some("blue".to_string()),
                ephemeral: Some(false),
            },
            patch: NacosInstancePatch { enabled: Some(false), ..Default::default() },
        })
        .unwrap();
        assert_eq!(value["target"]["serviceName"], "api");
        assert_eq!(value["target"]["ephemeral"], false);
        assert_eq!(value["patch"]["enabled"], false);
        assert!(value.get("serviceName").is_none());
        assert!(value["patch"].get("weight").is_some_and(serde_json::Value::is_null));
    }

    #[test]
    fn legacy_capabilities_without_the_operation_matrix_remain_readable() {
        let capabilities: NacosCapabilities = serde_json::from_value(serde_json::json!({
            "supportsConfigManagement": true,
            "supportsConfigHistory": true,
            "supportsServiceManagement": true,
            "supportsInstanceUpdate": true,
            "supportsRawApi": true
        }))
        .unwrap();
        assert!(capabilities.service_management.list_services.supported);
        assert!(capabilities.service_management.update_instance.supported);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NacosDashboardMetrics {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub service_count: Option<u64>,
    #[serde(default)]
    pub instance_count: Option<u64>,
    #[serde(default)]
    pub subscribe_count: Option<u64>,
    #[serde(default)]
    pub raft_notify_task_count: Option<u64>,
    #[serde(default)]
    pub responsible_service_count: Option<u64>,
    #[serde(default)]
    pub responsible_instance_count: Option<u64>,
    #[serde(default)]
    pub client_count: Option<u64>,
    #[serde(default)]
    pub connection_based_client_count: Option<u64>,
    #[serde(default)]
    pub ephemeral_ip_port_client_count: Option<u64>,
    #[serde(default)]
    pub persistent_ip_port_client_count: Option<u64>,
    #[serde(default)]
    pub responsible_client_count: Option<u64>,
    #[serde(default)]
    pub cpu: Option<f64>,
    #[serde(default)]
    pub load: Option<f64>,
    #[serde(default)]
    pub mem: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NacosPrometheusSource {
    pub kind: String,
    pub endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NacosPrometheusResourceMetrics {
    pub cpu_ratio: Option<f64>,
    pub memory_ratio: Option<f64>,
    pub memory_used_bytes: Option<f64>,
    pub memory_max_bytes: Option<f64>,
    pub rss_bytes: Option<f64>,
    pub vms_bytes: Option<f64>,
    pub system_total_memory_bytes: Option<f64>,
    pub load_1m: Option<f64>,
    pub jvm_daemon_threads: Option<f64>,
    pub gc_pause_count: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NacosPrometheusTrafficMetrics {
    pub http_requests_total: Option<f64>,
    pub grpc_requests_total: Option<f64>,
    pub http_errors_total: Option<f64>,
    pub grpc_errors_total: Option<f64>,
    pub http_duration_seconds_total: Option<f64>,
    pub http_duration_count: Option<f64>,
    pub grpc_duration_seconds_total: Option<f64>,
    pub grpc_duration_count: Option<f64>,
    pub http_p50_ms: Option<f64>,
    pub http_p95_ms: Option<f64>,
    pub http_p99_ms: Option<f64>,
    pub grpc_p50_ms: Option<f64>,
    pub grpc_p95_ms: Option<f64>,
    pub grpc_p99_ms: Option<f64>,
    pub executor_pool_size: Option<f64>,
    pub executor_active_count: Option<f64>,
    pub executor_queued_tasks: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NacosPrometheusConfigMetrics {
    pub config_count: Option<f64>,
    pub get_config_total: Option<f64>,
    pub publish_total: Option<f64>,
    pub long_polling: Option<f64>,
    pub listener_clients: Option<f64>,
    pub listener_keys: Option<f64>,
    pub notify_tasks: Option<f64>,
    pub notify_client_tasks: Option<f64>,
    pub dump_tasks: Option<f64>,
    pub subscriber_count: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NacosPrometheusNamingMetrics {
    pub service_count: Option<f64>,
    pub instance_count: Option<f64>,
    pub subscriber_count: Option<f64>,
    pub connection_count: Option<f64>,
    pub total_push: Option<f64>,
    pub failed_push: Option<f64>,
    pub empty_push: Option<f64>,
    pub push_pending_tasks: Option<f64>,
    pub avg_push_cost_ms: Option<f64>,
    pub max_push_cost_ms: Option<f64>,
    pub leader_status: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NacosPrometheusSnapshot {
    pub source: NacosPrometheusSource,
    pub resource: NacosPrometheusResourceMetrics,
    pub traffic: NacosPrometheusTrafficMetrics,
    pub config: NacosPrometheusConfigMetrics,
    pub naming: NacosPrometheusNamingMetrics,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosClusterNode {
    pub address: String,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub alive: Option<bool>,
    #[serde(default)]
    pub site: Option<String>,
    #[serde(default)]
    pub weight: Option<f64>,
    #[serde(default)]
    pub last_refresh_time: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NacosDashboardSnapshot {
    pub namespace: String,
    #[serde(default)]
    pub namespace_count: Option<u64>,
    #[serde(default)]
    pub config_count: Option<u64>,
    #[serde(default)]
    pub service_count: Option<u64>,
    #[serde(default)]
    pub metrics: Option<NacosDashboardMetrics>,
    #[serde(default)]
    pub prometheus: Option<NacosPrometheusSnapshot>,
    #[serde(default)]
    pub nodes: Vec<NacosClusterNode>,
    #[serde(default)]
    pub warnings: Vec<String>,
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
