use async_trait::async_trait;

use crate::nacos::types::*;

#[async_trait]
pub trait NacosAdmin: Send + Sync {
    async fn test_connection(&self) -> Result<NacosConnectionInfo, String>;
    async fn list_namespaces(&self) -> Result<Vec<NacosNamespaceInfo>, String>;
    async fn create_namespace(&self, req: NacosNamespaceCreate) -> Result<(), String>;
    async fn update_namespace(&self, req: NacosNamespaceUpdate) -> Result<(), String>;
    async fn list_configs(&self, query: NacosConfigQuery) -> Result<NacosConfigList, String>;
    async fn get_config(&self, key: NacosConfigKey) -> Result<NacosConfigItem, String>;
    async fn publish_config(&self, req: NacosConfigUpsert) -> Result<(), String>;
    async fn delete_config(&self, key: NacosConfigKey) -> Result<(), String>;
    async fn list_config_history(&self, query: NacosConfigHistoryQuery) -> Result<NacosConfigHistoryList, String>;
    async fn get_config_history(&self, key: NacosConfigHistoryKey) -> Result<NacosConfigItem, String>;
    async fn rollback_config(&self, req: NacosConfigRollbackRequest) -> Result<(), String>;
    async fn list_services(&self, query: NacosServiceQuery) -> Result<NacosServiceList, String>;
    async fn list_instances(&self, query: NacosInstanceQuery) -> Result<Vec<NacosInstanceInfo>, String>;
    async fn update_instance(&self, req: NacosInstanceUpdate) -> Result<(), String>;
    async fn raw_request(&self, req: NacosRawRequest) -> Result<NacosRawResponse, String>;
}
