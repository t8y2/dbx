use std::future::Future;

use crate::connection::AppState;
use crate::models::connection::{DatabaseConnectionInfo, DatabaseType};
use crate::nacos::types::*;

pub fn database_info_from_connection(info: &NacosConnectionInfo) -> Option<DatabaseConnectionInfo> {
    let product_version = info.server_version.clone().filter(|value| !value.trim().is_empty());
    Some(DatabaseConnectionInfo {
        product_name: Some("Nacos".to_string()),
        product_version,
        ..DatabaseConnectionInfo::default()
    })
}

async fn refresh_access_control_after_mutation(admin: &std::sync::Arc<dyn crate::nacos::port::NacosAdmin>) {
    admin.invalidate_access_control_capabilities();
    let _ = admin.refresh_access_control_capabilities().await;
}

async fn current_access_control_capabilities(
    admin: &std::sync::Arc<dyn crate::nacos::port::NacosAdmin>,
) -> NacosAccessControlCapabilities {
    // A synchronous read intentionally treats an expired entry as absent. All
    // feature and safety gates therefore go through the refreshing path so a
    // stale cache cannot disable the workspace or reopen legacy mutations.
    admin.refresh_access_control_capabilities().await
}

fn ensure_access_control_operation(
    capabilities: &NacosAccessControlCapabilities,
    operation: NacosAccessControlOperation,
) -> Result<(), String> {
    let capability = capabilities.operation(operation);
    if capability.supported {
        return Ok(());
    }
    let reason = match capability.reason {
        Some(NacosCapabilityReason::ImplementationReadOnly) => "implementationReadOnly",
        Some(NacosCapabilityReason::VersionUnsupported) => "versionUnsupported",
        Some(NacosCapabilityReason::EndpointUnavailable) => "endpointUnavailable",
        Some(NacosCapabilityReason::NotVerified) => "notVerified",
        Some(NacosCapabilityReason::ConnectionReadOnly) => "connectionReadOnly",
        Some(NacosCapabilityReason::PermissionDenied) => "permissionDenied",
        None => "notVerified",
    };
    Err(format!(
        "NACOS_ERROR[unsupportedOperation]: Nacos access-control operation {operation:?} is unavailable ({reason})"
    ))
}

pub async fn nacos_test_connection_core(
    state: &AppState,
    conn_id: &str,
    force_access_control_refresh: bool,
) -> Result<NacosConnectionInfo, String> {
    let cfg = state.configs.read().await.get(conn_id).cloned().ok_or("Connection not found")?;
    if cfg.db_type != DatabaseType::Nacos {
        return Err("Connection is not a Nacos admin connection".to_string());
    }
    let admin_config = state.nacos_admin_config_for_connection(conn_id, &cfg).await?;
    // Keep this probe on the connection's shared adapter so an r-nacos console
    // session verified for configuration history can also expose its version.
    let admin = state.nacos_registry.get_or_build_config(conn_id, admin_config).await?;
    if force_access_control_refresh {
        admin.invalidate_access_control_capabilities();
    }
    admin.inspect_connection().await
}

pub async fn nacos_list_namespaces_core(state: &AppState, conn_id: &str) -> Result<Vec<NacosNamespaceInfo>, String> {
    let (admin, fingerprint) = get_admin_with_operation_fingerprint(state, conn_id).await?;
    crate::nacos::namespace_access::list_displayable_namespaces(conn_id, fingerprint, admin).await
}

pub async fn nacos_sidebar_snapshot_core(
    state: &AppState,
    conn_id: &str,
) -> Result<NacosNamespaceSidebarSnapshot, String> {
    let visible_scope =
        state.configs.read().await.get(conn_id).ok_or("Connection not found")?.visible_databases.clone();
    let (admin, fingerprint) = get_admin_with_operation_fingerprint(state, conn_id).await?;
    crate::nacos::namespace_access::sidebar_snapshot_with_visible_scope(
        conn_id,
        fingerprint,
        admin,
        visible_scope.as_deref(),
    )
    .await
}

pub async fn nacos_create_namespace_core(
    state: &AppState,
    conn_id: &str,
    req: NacosNamespaceCreate,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Create Nacos namespace").await?;
    let admin = get_admin(state, conn_id).await?;
    let result = admin.create_namespace(req).await;
    if result.is_ok() {
        crate::nacos::namespace_access::invalidate(conn_id);
    }
    result
}

pub async fn nacos_update_namespace_core(
    state: &AppState,
    conn_id: &str,
    req: NacosNamespaceUpdate,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Update Nacos namespace").await?;
    let admin = get_admin(state, conn_id).await?;
    let result = admin.update_namespace(req).await;
    if result.is_ok() {
        crate::nacos::namespace_access::invalidate(conn_id);
    }
    result
}

pub async fn nacos_delete_namespace_core(state: &AppState, conn_id: &str, namespace_id: String) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Delete Nacos namespace").await?;
    let admin = get_admin(state, conn_id).await?;
    let result = admin.delete_namespace(namespace_id).await;
    if result.is_ok() {
        crate::nacos::namespace_access::invalidate(conn_id);
    }
    result
}

pub async fn nacos_list_configs_core(
    state: &AppState,
    conn_id: &str,
    query: NacosConfigQuery,
) -> Result<NacosConfigList, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.list_configs(query).await
}

pub async fn nacos_search_config_content_core<F, Fut>(
    state: &AppState,
    conn_id: &str,
    request: NacosContentSearchRequest,
    on_progress: F,
) -> Result<NacosContentSearchResult, String>
where
    F: Fn(NacosSearchProgress) -> Fut + Send + Sync,
    Fut: Future<Output = ()> + Send,
{
    let admin = get_admin(state, conn_id).await?;
    crate::nacos::search::search_config_content(admin, request, on_progress).await
}

pub fn nacos_cancel_operation_core(operation_id: &str) -> bool {
    crate::nacos::search::cancel_operation(operation_id)
}

pub async fn nacos_get_config_core(
    state: &AppState,
    conn_id: &str,
    key: NacosConfigKey,
) -> Result<NacosConfigItem, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.get_config(key).await
}

pub async fn nacos_publish_config_core(state: &AppState, conn_id: &str, req: NacosConfigUpsert) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Publish Nacos config").await?;
    let admin = get_admin(state, conn_id).await?;
    admin.publish_config(req).await
}

pub async fn nacos_delete_config_core(state: &AppState, conn_id: &str, key: NacosConfigKey) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Delete Nacos config").await?;
    let admin = get_admin(state, conn_id).await?;
    admin.delete_config(key).await
}

pub async fn nacos_list_config_history_core(
    state: &AppState,
    conn_id: &str,
    query: NacosConfigHistoryQuery,
) -> Result<NacosConfigHistoryList, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.list_config_history(query).await
}

pub async fn nacos_get_config_history_core(
    state: &AppState,
    conn_id: &str,
    key: NacosConfigHistoryKey,
) -> Result<NacosConfigItem, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.get_config_history(key).await
}

pub async fn nacos_rollback_config_core(
    state: &AppState,
    conn_id: &str,
    req: NacosConfigRollbackRequest,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Rollback Nacos config").await?;
    let admin = get_admin(state, conn_id).await?;
    admin.rollback_config(req).await
}

pub async fn nacos_get_rnacos_console_captcha_core(
    state: &AppState,
    conn_id: &str,
) -> Result<NacosRNacosConsoleCaptcha, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.get_rnacos_console_captcha().await
}

pub async fn nacos_login_rnacos_console_core(
    state: &AppState,
    conn_id: &str,
    captcha: Option<String>,
) -> Result<(), String> {
    let admin = get_admin(state, conn_id).await?;
    let result = admin.login_rnacos_console(captcha).await;
    if result.is_ok() {
        refresh_access_control_after_mutation(&admin).await;
        crate::nacos::namespace_access::invalidate(conn_id);
    }
    result
}

pub async fn nacos_list_users_core(
    state: &AppState,
    conn_id: &str,
    query: NacosUserQuery,
) -> Result<NacosUserList, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.list_users(query).await
}

pub async fn nacos_create_user_core(state: &AppState, conn_id: &str, req: NacosUserCreate) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Create Nacos user").await?;
    let admin = get_admin(state, conn_id).await?;
    let capabilities = current_access_control_capabilities(&admin).await;
    ensure_access_control_operation(&capabilities, NacosAccessControlOperation::CreateUser)?;
    let result = admin.create_user(req).await;
    if result.is_ok() {
        refresh_access_control_after_mutation(&admin).await;
        crate::nacos::namespace_access::invalidate_all();
    }
    result
}

pub async fn nacos_update_user_core(state: &AppState, conn_id: &str, req: NacosUserUpdate) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Update Nacos user").await?;
    let admin = get_admin(state, conn_id).await?;
    let capabilities = current_access_control_capabilities(&admin).await;
    ensure_access_control_operation(&capabilities, NacosAccessControlOperation::UpdateUser)?;
    let result = admin.update_user(req).await;
    if result.is_ok() {
        refresh_access_control_after_mutation(&admin).await;
        crate::nacos::namespace_access::invalidate_all();
    }
    result
}

pub async fn nacos_delete_user_core(state: &AppState, conn_id: &str, username: String) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Delete Nacos user").await?;
    let admin = get_admin(state, conn_id).await?;
    let capabilities = current_access_control_capabilities(&admin).await;
    if capabilities.enhanced_workspace {
        return Err(
            "Nacos users in the enhanced workspace must be deleted through the access-control workflow".to_string()
        );
    }
    ensure_access_control_operation(&capabilities, NacosAccessControlOperation::DeleteUser)?;
    let result = admin.delete_user(username).await;
    if result.is_ok() {
        refresh_access_control_after_mutation(&admin).await;
        crate::nacos::namespace_access::invalidate_all();
    }
    result
}

pub async fn nacos_list_role_bindings_core(
    state: &AppState,
    conn_id: &str,
    query: NacosRoleQuery,
) -> Result<NacosRoleList, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.list_role_bindings(query).await
}

pub async fn nacos_assign_role_core(state: &AppState, conn_id: &str, binding: NacosRoleBinding) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Assign Nacos role").await?;
    let admin = get_admin(state, conn_id).await?;
    let capabilities = current_access_control_capabilities(&admin).await;
    if capabilities.enhanced_workspace {
        return Err(
            "Nacos roles in the enhanced workspace must be changed through the access-control workflow".to_string()
        );
    }
    ensure_access_control_operation(&capabilities, NacosAccessControlOperation::AssignRole)?;
    let result = admin.assign_role(binding).await;
    if result.is_ok() {
        refresh_access_control_after_mutation(&admin).await;
        crate::nacos::namespace_access::invalidate_all();
    }
    result
}

pub async fn nacos_remove_role_core(state: &AppState, conn_id: &str, binding: NacosRoleBinding) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Remove Nacos role").await?;
    let admin = get_admin(state, conn_id).await?;
    let capabilities = current_access_control_capabilities(&admin).await;
    if capabilities.enhanced_workspace {
        return Err(
            "Nacos roles in the enhanced workspace must be changed through the access-control workflow".to_string()
        );
    }
    ensure_access_control_operation(&capabilities, NacosAccessControlOperation::RemoveRole)?;
    if binding.role == "ROLE_ADMIN" {
        return Err("The Nacos administrator role cannot be removed through the legacy endpoint".to_string());
    }
    let result = admin.remove_role(binding).await;
    if result.is_ok() {
        refresh_access_control_after_mutation(&admin).await;
        crate::nacos::namespace_access::invalidate_all();
    }
    result
}

pub async fn nacos_access_snapshot_core(state: &AppState, conn_id: &str) -> Result<NacosAccessControlSnapshot, String> {
    let admin = get_admin(state, conn_id).await?;
    if !current_access_control_capabilities(&admin).await.enhanced_workspace {
        return Err("The enhanced access-control workspace is unavailable for this Nacos connection".to_string());
    }
    crate::nacos::access_control::load_snapshot(admin).await
}

pub async fn nacos_start_access_operation_core(
    state: &AppState,
    conn_id: &str,
    req: NacosAccessOperationRequest,
) -> Result<NacosAccessOperationResult, String> {
    ensure_connection_writable(state, conn_id, "Manage Nacos access control").await?;
    let (admin, fingerprint) = get_admin_with_operation_fingerprint(state, conn_id).await?;
    if !current_access_control_capabilities(&admin).await.enhanced_workspace {
        return Err("The enhanced access-control workspace is unavailable for this Nacos connection".to_string());
    }
    let (result, state_changed) =
        crate::nacos::access_control::start_operation(conn_id, fingerprint, admin.clone(), req).await?;
    if state_changed {
        refresh_access_control_after_mutation(&admin).await;
        crate::nacos::namespace_access::invalidate_all();
    }
    Ok(result)
}

pub async fn nacos_get_access_operation_core(
    state: &AppState,
    conn_id: &str,
    operation_id: &str,
) -> Result<NacosAccessOperationResult, String> {
    let (_, fingerprint) = get_admin_with_operation_fingerprint(state, conn_id).await?;
    crate::nacos::access_control::get_operation(conn_id, &fingerprint, operation_id)
}

pub async fn nacos_retry_access_operation_core(
    state: &AppState,
    conn_id: &str,
    retry: NacosAccessOperationRetry,
) -> Result<NacosAccessOperationResult, String> {
    ensure_connection_writable(state, conn_id, "Retry Nacos access-control operation").await?;
    let (admin, fingerprint) = get_admin_with_operation_fingerprint(state, conn_id).await?;
    let (result, state_changed) =
        crate::nacos::access_control::retry_operation(conn_id, fingerprint, admin.clone(), retry).await?;
    if state_changed {
        refresh_access_control_after_mutation(&admin).await;
        crate::nacos::namespace_access::invalidate_all();
    }
    Ok(result)
}

pub async fn nacos_undo_access_operation_core(
    state: &AppState,
    conn_id: &str,
    operation_id: &str,
) -> Result<NacosAccessOperationResult, String> {
    ensure_connection_writable(state, conn_id, "Undo Nacos access-control operation").await?;
    let (admin, fingerprint) = get_admin_with_operation_fingerprint(state, conn_id).await?;
    let (result, state_changed) =
        crate::nacos::access_control::undo_operation(conn_id, fingerprint, admin.clone(), operation_id).await?;
    if state_changed {
        refresh_access_control_after_mutation(&admin).await;
        crate::nacos::namespace_access::invalidate_all();
    }
    Ok(result)
}

pub async fn nacos_list_services_core(
    state: &AppState,
    conn_id: &str,
    query: NacosServiceQuery,
) -> Result<NacosServiceList, String> {
    let admin = get_admin(state, conn_id).await?;
    ensure_service_operation(admin.as_ref(), NacosServiceOperation::ListServices)?;
    admin.list_services(query).await
}

pub async fn nacos_list_instances_core(
    state: &AppState,
    conn_id: &str,
    query: NacosInstanceQuery,
) -> Result<Vec<NacosInstanceInfo>, String> {
    let admin = get_admin(state, conn_id).await?;
    ensure_service_operation(admin.as_ref(), NacosServiceOperation::ListInstances)?;
    admin.list_instances(query).await
}

pub async fn nacos_get_service_core(
    state: &AppState,
    conn_id: &str,
    query: NacosServiceQuery,
) -> Result<NacosServiceDetail, String> {
    let admin = get_admin(state, conn_id).await?;
    ensure_service_operation(admin.as_ref(), NacosServiceOperation::GetService)?;
    admin.get_service(query).await
}

pub async fn nacos_create_service_core(state: &AppState, conn_id: &str, req: NacosServiceUpsert) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Create Nacos service").await?;
    let admin = get_admin(state, conn_id).await?;
    ensure_service_operation(admin.as_ref(), NacosServiceOperation::CreateService)?;
    admin.create_service(req).await
}

pub async fn nacos_update_service_core(state: &AppState, conn_id: &str, req: NacosServiceUpsert) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Update Nacos service").await?;
    let admin = get_admin(state, conn_id).await?;
    ensure_service_operation(admin.as_ref(), NacosServiceOperation::UpdateService)?;
    admin.update_service(req).await
}

pub async fn nacos_delete_service_core(
    state: &AppState,
    conn_id: &str,
    query: NacosServiceQuery,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Delete Nacos service").await?;
    let admin = get_admin(state, conn_id).await?;
    ensure_service_operation(admin.as_ref(), NacosServiceOperation::DeleteService)?;
    ensure_service_operation(admin.as_ref(), NacosServiceOperation::ListInstances)?;
    let service_name = query
        .service_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Nacos service name is required".to_string())?
        .to_string();
    let instances = admin
        .list_instances_for_service_delete(NacosInstanceQuery {
            namespace: query.namespace.clone(),
            service_name,
            group_name: query.group_name.clone(),
            clusters: None,
        })
        .await?;
    if !instances.is_empty() {
        return Err(format!(
            "NACOS_ERROR[serviceNotEmpty]: Nacos service still contains {} instance(s); deregister them before deletion",
            instances.len()
        ));
    }
    admin.delete_service(query).await
}

pub async fn nacos_update_instance_core(
    state: &AppState,
    conn_id: &str,
    req: NacosInstanceUpdateRequest,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Update Nacos instance").await?;
    let admin = get_admin(state, conn_id).await?;
    ensure_service_operation(admin.as_ref(), NacosServiceOperation::UpdateInstance)?;
    admin.update_instance(req).await
}

pub async fn nacos_register_instance_core(
    state: &AppState,
    conn_id: &str,
    req: NacosInstanceRegistration,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Register Nacos instance").await?;
    let admin = get_admin(state, conn_id).await?;
    ensure_service_operation(admin.as_ref(), NacosServiceOperation::RegisterInstance)?;
    admin.register_instance(req).await
}

pub async fn nacos_deregister_instance_core(
    state: &AppState,
    conn_id: &str,
    req: NacosInstanceRef,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Deregister Nacos instance").await?;
    let admin = get_admin(state, conn_id).await?;
    ensure_service_operation(admin.as_ref(), NacosServiceOperation::DeregisterInstance)?;
    admin.deregister_instance(req).await
}

pub async fn nacos_get_dashboard_core(
    state: &AppState,
    conn_id: &str,
    query: NacosDashboardQuery,
) -> Result<NacosDashboardSnapshot, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.get_dashboard(query).await
}

pub async fn nacos_raw_request_core(
    state: &AppState,
    conn_id: &str,
    req: NacosRawRequest,
) -> Result<NacosRawResponse, String> {
    crate::nacos::http::validate_raw_api_path(&req.path)?;
    if !req.method.eq_ignore_ascii_case("GET") {
        ensure_connection_writable(state, conn_id, "Run mutating Nacos raw request").await?;
    }
    let admin = get_admin(state, conn_id).await?;
    admin.raw_request(req).await
}

pub(crate) async fn get_admin(
    state: &AppState,
    conn_id: &str,
) -> Result<std::sync::Arc<dyn crate::nacos::port::NacosAdmin>, String> {
    let cfg = state.configs.read().await.get(conn_id).cloned().ok_or("Connection not found")?;
    if cfg.db_type != DatabaseType::Nacos {
        return Err("Connection is not a Nacos admin connection".to_string());
    }
    let admin_config = state.nacos_admin_config_for_connection(conn_id, &cfg).await?;
    state.nacos_registry.get_or_build_config(conn_id, admin_config).await
}

async fn get_admin_with_operation_fingerprint(
    state: &AppState,
    conn_id: &str,
) -> Result<(std::sync::Arc<dyn crate::nacos::port::NacosAdmin>, String), String> {
    let cfg = state.configs.read().await.get(conn_id).cloned().ok_or("Connection not found")?;
    if cfg.db_type != DatabaseType::Nacos {
        return Err("Connection is not a Nacos admin connection".to_string());
    }
    let admin_config = state.nacos_admin_config_for_connection(conn_id, &cfg).await?;
    let fingerprint = admin_config.operation_fingerprint();
    let admin = state.nacos_registry.get_or_build_config(conn_id, admin_config).await?;
    Ok((admin, fingerprint))
}

pub(crate) async fn ensure_connection_writable(state: &AppState, conn_id: &str, action: &str) -> Result<(), String> {
    let cfg = state.configs.read().await.get(conn_id).cloned().ok_or("Connection not found")?;
    if cfg.read_only && !state.write_unlock_windows.is_active(conn_id).await {
        Err(format!("{action} is blocked because this connection is read-only"))
    } else {
        Ok(())
    }
}

fn ensure_service_operation(
    admin: &dyn crate::nacos::port::NacosAdmin,
    operation: NacosServiceOperation,
) -> Result<(), String> {
    let capabilities = admin.service_capabilities();
    let capability = capabilities.operation(operation);
    if capability.supported {
        return Ok(());
    }
    let reason = match capability.reason {
        Some(NacosCapabilityReason::ImplementationReadOnly) => "implementationReadOnly",
        Some(NacosCapabilityReason::VersionUnsupported) => "versionUnsupported",
        Some(NacosCapabilityReason::EndpointUnavailable) => "endpointUnavailable",
        Some(NacosCapabilityReason::NotVerified) => "notVerified",
        Some(NacosCapabilityReason::ConnectionReadOnly) => "connectionReadOnly",
        Some(NacosCapabilityReason::PermissionDenied) => "permissionDenied",
        None => "notVerified",
    };
    Err(format!("NACOS_ERROR[unsupportedOperation]: Nacos service operation {operation:?} is unavailable ({reason})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_control_operation_guard_uses_individual_capabilities() {
        let mut capabilities = NacosAccessControlCapabilities::unavailable(NacosCapabilityReason::PermissionDenied);
        capabilities.update_user = NacosOperationCapability::supported();

        assert!(ensure_access_control_operation(&capabilities, NacosAccessControlOperation::UpdateUser).is_ok());
        let error =
            ensure_access_control_operation(&capabilities, NacosAccessControlOperation::CreateUser).unwrap_err();
        assert!(error.contains("CreateUser"));
        assert!(error.contains("permissionDenied"));
    }

    #[test]
    fn core_service_operation_guard_allows_documented_rnacos_v1_writes() {
        use crate::nacos::config::{
            NacosAdminConfig, NacosAuthConfig, NacosImplementation, NacosMetricsMode, NacosRNacosConsoleAuth,
            NacosVersionMode,
        };
        use crate::nacos::http::NacosOpenApiAdmin;
        use crate::nacos::port::NacosAdmin;

        let admin = NacosOpenApiAdmin::new(NacosAdminConfig {
            implementation: Some(NacosImplementation::RNacos),
            server_addr: "http://127.0.0.1:3848".to_string(),
            display_server_addr: "http://127.0.0.1:3848".to_string(),
            namespace: "public".to_string(),
            version_mode: Some(NacosVersionMode::Auto),
            api_plane: None,
            context_path: "/nacos".to_string(),
            managed_namespaces: Vec::new(),
            rnacos_console_addr: String::new(),
            rnacos_history_enabled: Some(false),
            rnacos_console_auth: NacosRNacosConsoleAuth::Inherit,
            auth: NacosAuthConfig::None,
            tls_skip_verify: false,
            metrics_mode: NacosMetricsMode::Disabled,
            metrics_url: String::new(),
            page_size: 20,
            connect_override: None,
        })
        .unwrap();
        assert!(ensure_service_operation(&admin, NacosServiceOperation::ListServices).is_ok());
        assert!(ensure_service_operation(&admin, NacosServiceOperation::CreateService).is_ok());
        assert!(ensure_service_operation(&admin, NacosServiceOperation::UpdateInstance).is_ok());
        assert!(admin.service_capabilities().create_service.supported);
        let error = ensure_service_operation(&admin, NacosServiceOperation::DeleteService).unwrap_err();
        assert!(error.contains("endpointUnavailable"));
    }

    #[tokio::test]
    async fn raw_mutation_requires_writable_connection_before_adapter_build() {
        let dir = std::env::temp_dir().join(format!("dbx-nacos-service-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = crate::storage::Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let mut cfg = crate::models::connection::ConnectionConfig {
            docs_notes_path: None,
            id: "nacos-1".to_string(),
            name: "Nacos".to_string(),
            note: String::new(),
            db_type: DatabaseType::Nacos,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "127.0.0.1".to_string(),
            port: 8848,
            username: String::new(),
            password: String::new(),
            database: None,
            default_schema: None,
            visible_databases: None,
            visible_database_patterns: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: crate::models::connection::default_keepalive_interval_secs(),
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: ":".to_string(),
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
            redis_key_templates: Vec::new(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: Some(serde_json::json!({ "serverAddr": "http://127.0.0.1:9" })),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            save_password: true,
            read_only: true,
            is_production: false,
            production_databases: Vec::new(),
            database_info: None,
        };
        cfg.read_only = true;
        state.configs.write().await.insert(cfg.id.clone(), cfg);
        let err = nacos_raw_request_core(
            &state,
            "nacos-1",
            NacosRawRequest { method: "POST".to_string(), path: "/v1/cs/configs".to_string(), query: None, body: None },
        )
        .await
        .unwrap_err();
        assert!(err.contains("read-only"));
    }

    #[tokio::test]
    async fn config_rollback_requires_writable_connection_before_adapter_build() {
        let dir = std::env::temp_dir().join(format!("dbx-nacos-service-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = crate::storage::Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let cfg = crate::models::connection::ConnectionConfig {
            docs_notes_path: None,
            id: "nacos-rollback".to_string(),
            name: "Nacos".to_string(),
            note: String::new(),
            db_type: DatabaseType::Nacos,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "127.0.0.1".to_string(),
            port: 8848,
            username: String::new(),
            password: String::new(),
            database: None,
            default_schema: None,
            visible_databases: None,
            visible_database_patterns: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: crate::models::connection::default_keepalive_interval_secs(),
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: ":".to_string(),
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
            redis_key_templates: Vec::new(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: Some(serde_json::json!({ "serverAddr": "http://127.0.0.1:9" })),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            save_password: true,
            read_only: true,
            is_production: false,
            production_databases: Vec::new(),
            database_info: None,
        };
        state.configs.write().await.insert(cfg.id.clone(), cfg);
        let err = nacos_rollback_config_core(
            &state,
            "nacos-rollback",
            NacosConfigRollbackRequest {
                namespace: None,
                data_id: "app.yaml".to_string(),
                group: "DEFAULT_GROUP".to_string(),
                history_id: "1".to_string(),
                nid: None,
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("read-only"));
    }
}
