use std::path::Path;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::commands::connection::AppState;

#[tauri::command]
pub async fn nacos_test_connection(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<dbx_core::nacos::NacosConnectionInfo, String> {
    dbx_core::nacos::service::nacos_test_connection_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn nacos_list_namespaces(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<dbx_core::nacos::NacosNamespaceInfo>, String> {
    dbx_core::nacos::service::nacos_list_namespaces_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn nacos_create_namespace(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    req: dbx_core::nacos::NacosNamespaceCreate,
) -> Result<(), String> {
    dbx_core::nacos::service::nacos_create_namespace_core(&state, &connection_id, req).await
}

#[tauri::command]
pub async fn nacos_update_namespace(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    req: dbx_core::nacos::NacosNamespaceUpdate,
) -> Result<(), String> {
    dbx_core::nacos::service::nacos_update_namespace_core(&state, &connection_id, req).await
}

#[tauri::command]
pub async fn nacos_list_configs(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    query: dbx_core::nacos::NacosConfigQuery,
) -> Result<dbx_core::nacos::NacosConfigList, String> {
    dbx_core::nacos::service::nacos_list_configs_core(&state, &connection_id, query).await
}

#[tauri::command]
pub async fn nacos_get_config(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: dbx_core::nacos::NacosConfigKey,
) -> Result<dbx_core::nacos::NacosConfigItem, String> {
    dbx_core::nacos::service::nacos_get_config_core(&state, &connection_id, key).await
}

#[tauri::command]
pub async fn nacos_publish_config(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    req: dbx_core::nacos::NacosConfigUpsert,
) -> Result<(), String> {
    dbx_core::nacos::service::nacos_publish_config_core(&state, &connection_id, req).await
}

#[tauri::command]
pub async fn nacos_delete_config(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: dbx_core::nacos::NacosConfigKey,
) -> Result<(), String> {
    dbx_core::nacos::service::nacos_delete_config_core(&state, &connection_id, key).await
}

#[tauri::command]
pub async fn nacos_list_config_history(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    query: dbx_core::nacos::NacosConfigHistoryQuery,
) -> Result<dbx_core::nacos::NacosConfigHistoryList, String> {
    dbx_core::nacos::service::nacos_list_config_history_core(&state, &connection_id, query).await
}

#[tauri::command]
pub async fn nacos_get_config_history(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: dbx_core::nacos::NacosConfigHistoryKey,
) -> Result<dbx_core::nacos::NacosConfigItem, String> {
    dbx_core::nacos::service::nacos_get_config_history_core(&state, &connection_id, key).await
}

#[tauri::command]
pub async fn nacos_rollback_config(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    req: dbx_core::nacos::NacosConfigRollbackRequest,
) -> Result<(), String> {
    dbx_core::nacos::service::nacos_rollback_config_core(&state, &connection_id, req).await
}

#[tauri::command]
pub async fn nacos_get_rnacos_console_captcha(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<dbx_core::nacos::NacosRNacosConsoleCaptcha, String> {
    dbx_core::nacos::service::nacos_get_rnacos_console_captcha_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn nacos_login_rnacos_console(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    captcha: Option<String>,
) -> Result<(), String> {
    dbx_core::nacos::service::nacos_login_rnacos_console_core(&state, &connection_id, captcha).await
}

#[tauri::command]
pub async fn nacos_list_services(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    query: dbx_core::nacos::NacosServiceQuery,
) -> Result<dbx_core::nacos::NacosServiceList, String> {
    dbx_core::nacos::service::nacos_list_services_core(&state, &connection_id, query).await
}

#[tauri::command]
pub async fn nacos_list_instances(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    query: dbx_core::nacos::NacosInstanceQuery,
) -> Result<Vec<dbx_core::nacos::NacosInstanceInfo>, String> {
    dbx_core::nacos::service::nacos_list_instances_core(&state, &connection_id, query).await
}

#[tauri::command]
pub async fn nacos_update_instance(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    req: dbx_core::nacos::NacosInstanceUpdate,
) -> Result<(), String> {
    dbx_core::nacos::service::nacos_update_instance_core(&state, &connection_id, req).await
}

#[tauri::command]
pub async fn nacos_get_dashboard(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    query: dbx_core::nacos::NacosDashboardQuery,
) -> Result<dbx_core::nacos::NacosDashboardSnapshot, String> {
    dbx_core::nacos::service::nacos_get_dashboard_core(&state, &connection_id, query).await
}

#[tauri::command]
pub async fn nacos_raw_request(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    req: dbx_core::nacos::NacosRawRequest,
) -> Result<dbx_core::nacos::NacosRawResponse, String> {
    dbx_core::nacos::service::nacos_raw_request_core(&state, &connection_id, req).await
}

#[tauri::command]
pub async fn nacos_search_config_content(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    req: dbx_core::nacos::NacosContentSearchRequest,
    on_progress: Channel<dbx_core::nacos::NacosSearchProgress>,
) -> Result<dbx_core::nacos::NacosContentSearchResult, String> {
    dbx_core::nacos::service::nacos_search_config_content_core(&state, &connection_id, req, move |progress| {
        let _ = on_progress.send(progress);
        std::future::ready(())
    })
    .await
}

#[tauri::command]
pub async fn nacos_cancel_operation(operation_id: String) -> Result<bool, String> {
    Ok(dbx_core::nacos::service::nacos_cancel_operation_core(&operation_id))
}

#[tauri::command]
pub async fn nacos_export_configs(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    selector: dbx_core::nacos::NacosConfigSelector,
    destination: String,
) -> Result<(), String> {
    dbx_core::nacos::batch::nacos_export_config_archive_core(&state, &connection_id, selector, Path::new(&destination))
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn nacos_preview_config_import(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    target_namespace: String,
    archive_path: String,
) -> Result<dbx_core::nacos::NacosBatchPreview, String> {
    dbx_core::nacos::batch::nacos_preview_config_import_core(
        &state,
        &connection_id,
        &target_namespace,
        Path::new(&archive_path),
    )
    .await
}

#[tauri::command]
pub async fn nacos_apply_config_import(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    operation_id: String,
    target_namespace: String,
    archive_path: String,
    plan_hash: String,
    conflict_policy: dbx_core::nacos::NacosConflictPolicy,
) -> Result<dbx_core::nacos::NacosBatchReport, String> {
    dbx_core::nacos::batch::nacos_apply_config_import_core(
        &state,
        &connection_id,
        &target_namespace,
        Path::new(&archive_path),
        &operation_id,
        &plan_hash,
        &conflict_policy,
    )
    .await
}

#[tauri::command]
pub async fn nacos_preview_config_transfer(
    state: State<'_, Arc<AppState>>,
    req: dbx_core::nacos::NacosConfigTransferRequest,
) -> Result<dbx_core::nacos::NacosBatchPreview, String> {
    dbx_core::nacos::batch::nacos_preview_config_transfer_core(&state, &req).await
}

#[tauri::command]
pub async fn nacos_apply_config_transfer(
    state: State<'_, Arc<AppState>>,
    req: dbx_core::nacos::NacosConfigTransferRequest,
    plan_hash: String,
) -> Result<dbx_core::nacos::NacosBatchReport, String> {
    dbx_core::nacos::batch::nacos_apply_config_transfer_core(&state, &req, &plan_hash).await
}
