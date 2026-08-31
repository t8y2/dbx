use async_trait::async_trait;

use crate::nacos::types::*;

#[derive(Clone, Debug)]
pub struct NacosNamespaceAuthorizationSnapshot {
    pub access_control: NacosAccessControlCapabilities,
    pub roles: Vec<String>,
    pub permissions: Vec<NacosPermissionInfo>,
    pub global_admin: bool,
}

#[async_trait]
pub trait NacosAdmin: Send + Sync {
    fn service_capabilities(&self) -> NacosServiceCapabilities {
        NacosServiceCapabilities::default()
    }

    fn access_control_capabilities(&self) -> NacosAccessControlCapabilities {
        NacosAccessControlCapabilities::default()
    }

    fn invalidate_access_control_capabilities(&self) {}

    fn current_username(&self) -> Option<String> {
        None
    }

    /// Returns the user-configured namespace scope for accounts that cannot
    /// safely rely on server-wide namespace discovery.
    fn explicitly_scoped_namespace_ids(&self) -> Option<Vec<String>> {
        None
    }

    async fn test_connection(&self) -> Result<NacosConnectionInfo, String>;
    /// Runs the user-initiated connection check, including validation of every
    /// explicitly configured namespace. Normal connection establishment must
    /// remain bounded and should call `test_connection` instead.
    async fn test_connection_with_scope_validation(&self) -> Result<NacosConnectionInfo, String> {
        self.test_connection().await
    }
    /// Refreshes account capabilities from non-mutating authorization reads.
    /// Implementations that cannot inspect permissions keep their conservative
    /// configured capabilities.
    async fn refresh_access_control_capabilities(&self) -> NacosAccessControlCapabilities {
        self.access_control_capabilities()
    }
    /// Refreshes access-control capabilities and, when the adapter can do so
    /// without another round trip, returns the authorization rows needed to
    /// derive namespace visibility.
    async fn refresh_namespace_authorization(
        &self,
        _username: &str,
    ) -> Result<Option<NacosNamespaceAuthorizationSnapshot>, String> {
        let _ = self.refresh_access_control_capabilities().await;
        Ok(None)
    }
    /// Returns connection information for the Nacos management UI after
    /// refreshing account capabilities, without re-running full namespace
    /// scope validation on every tree or console refresh.
    async fn inspect_connection(&self) -> Result<NacosConnectionInfo, String> {
        self.test_connection().await
    }
    async fn list_namespaces(&self) -> Result<Vec<NacosNamespaceInfo>, String>;
    async fn create_namespace(&self, req: NacosNamespaceCreate) -> Result<(), String>;
    async fn update_namespace(&self, req: NacosNamespaceUpdate) -> Result<(), String>;
    async fn delete_namespace(&self, _: String) -> Result<(), String> {
        Err("Nacos namespace deletion is unavailable for this connection".to_string())
    }
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
    async fn list_users(&self, _: NacosUserQuery) -> Result<NacosUserList, String> {
        Err("Nacos user management is unavailable for this connection".to_string())
    }
    async fn create_user(&self, _: NacosUserCreate) -> Result<(), String> {
        Err("Nacos user management is unavailable for this connection".to_string())
    }
    async fn update_user(&self, _: NacosUserUpdate) -> Result<(), String> {
        Err("Nacos user management is unavailable for this connection".to_string())
    }
    async fn delete_user(&self, _: String) -> Result<(), String> {
        Err("Nacos user management is unavailable for this connection".to_string())
    }
    async fn list_role_bindings(&self, _: NacosRoleQuery) -> Result<NacosRoleList, String> {
        Err("Nacos role management is unavailable for this connection".to_string())
    }
    async fn assign_role(&self, _: NacosRoleBinding) -> Result<(), String> {
        Err("Nacos role management is unavailable for this connection".to_string())
    }
    async fn remove_role(&self, _: NacosRoleBinding) -> Result<(), String> {
        Err("Nacos role management is unavailable for this connection".to_string())
    }
    async fn list_permissions(&self, _: NacosPermissionQuery) -> Result<NacosPermissionList, String> {
        Err("Nacos permission management is unavailable for this connection".to_string())
    }
    async fn grant_permission(&self, _: NacosPermissionInfo) -> Result<(), String> {
        Err("Nacos permission management is unavailable for this connection".to_string())
    }
    async fn revoke_permission(&self, _: NacosPermissionInfo) -> Result<(), String> {
        Err("Nacos permission management is unavailable for this connection".to_string())
    }
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
