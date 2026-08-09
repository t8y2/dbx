use async_trait::async_trait;

use crate::nacos::types::*;

#[async_trait]
pub trait NacosAdmin: Send + Sync {
    fn service_capabilities(&self) -> NacosServiceCapabilities {
        NacosServiceCapabilities::default()
    }

    async fn test_connection(&self) -> Result<NacosConnectionInfo, String>;
    async fn list_namespaces(&self) -> Result<Vec<NacosNamespaceInfo>, String>;
    async fn create_namespace(&self, req: NacosNamespaceCreate) -> Result<(), String>;
    async fn update_namespace(&self, req: NacosNamespaceUpdate) -> Result<(), String>;
    async fn list_configs(&self, query: NacosConfigQuery) -> Result<NacosConfigList, String>;
    /// Returns `Ok(None)` only when the server does not expose a native
    /// content-search endpoint. Authentication, throttling and transport
    /// failures are returned as errors so callers never amplify them with a
    /// more expensive full scan.
    async fn search_config_content_page(
        &self,
        namespace: &str,
        query: &str,
        page_no: u32,
        page_size: u32,
    ) -> Result<Option<NacosConfigList>, String>;
    async fn get_config(&self, key: NacosConfigKey) -> Result<NacosConfigItem, String>;
    async fn publish_config(&self, req: NacosConfigUpsert) -> Result<(), String>;
    async fn delete_config(&self, key: NacosConfigKey) -> Result<(), String>;
    async fn list_config_history(&self, query: NacosConfigHistoryQuery) -> Result<NacosConfigHistoryList, String>;
    async fn get_config_history(&self, key: NacosConfigHistoryKey) -> Result<NacosConfigItem, String>;
    async fn rollback_config(&self, req: NacosConfigRollbackRequest) -> Result<(), String>;
    async fn get_rnacos_console_captcha(&self) -> Result<NacosRNacosConsoleCaptcha, String>;
    async fn login_rnacos_console(&self, captcha: Option<String>) -> Result<(), String>;
    async fn list_services(&self, query: NacosServiceQuery) -> Result<NacosServiceList, String>;
    async fn get_service(&self, query: NacosServiceQuery) -> Result<NacosServiceDetail, String>;
    async fn create_service(&self, req: NacosServiceUpsert) -> Result<(), String>;
    async fn update_service(&self, req: NacosServiceUpsert) -> Result<(), String>;
    async fn delete_service(&self, query: NacosServiceQuery) -> Result<(), String>;
    async fn list_instances(&self, query: NacosInstanceQuery) -> Result<Vec<NacosInstanceInfo>, String>;
    /// Returns the authoritative management view used before deleting a
    /// service. Implementations whose discovery API hides disabled instances
    /// must override this instead of falling back to that lossy view.
    async fn list_instances_for_service_delete(
        &self,
        query: NacosInstanceQuery,
    ) -> Result<Vec<NacosInstanceInfo>, String> {
        self.list_instances(query).await
    }
    async fn update_instance(&self, req: NacosInstanceUpdateRequest) -> Result<(), String>;
    async fn register_instance(&self, req: NacosInstanceRegistration) -> Result<(), String>;
    async fn deregister_instance(&self, req: NacosInstanceRef) -> Result<(), String>;
    async fn get_dashboard(&self, query: NacosDashboardQuery) -> Result<NacosDashboardSnapshot, String>;
    async fn raw_request(&self, req: NacosRawRequest) -> Result<NacosRawResponse, String>;
}
