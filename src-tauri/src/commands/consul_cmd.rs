use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::{ensure_connection_writable, AppState};
use dbx_core::agent_kv::{
    KvDeleteOptions, KvDeleteResponse, KvGetResponse, KvListPrefixResponse, KvPutOptions, KvPutResponse, KvValue,
};

#[tauri::command]
pub async fn consul_capabilities(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<dbx_core::consul::ConsulCapabilities, String> {
    dbx_core::consul::consul_capabilities_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn consul_list_prefix(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    prefix: String,
    limit: usize,
    continuation: Option<String>,
) -> Result<KvListPrefixResponse, String> {
    dbx_core::consul::consul_list_prefix_core(&state, &connection_id, &prefix, limit, continuation.as_deref()).await
}

#[tauri::command]
pub async fn consul_list_recursive(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    prefix: String,
    max_entries: usize,
    max_value_bytes: usize,
) -> Result<dbx_core::consul::ConsulRecursiveListResponse, String> {
    dbx_core::consul::consul_list_recursive_core(&state, &connection_id, &prefix, max_entries, max_value_bytes).await
}

#[tauri::command]
pub async fn consul_search(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulSearchRequest,
) -> Result<dbx_core::consul::ConsulSearchResponse, String> {
    dbx_core::consul::consul_search_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_search_progress(
    connection_id: String,
    request_id: String,
    scope: dbx_core::consul::ConsulScope,
    generation: u64,
) -> Result<dbx_core::consul::ConsulSearchProgress, String> {
    Ok(dbx_core::consul::consul_search_progress_core(&connection_id, &scope, generation, &request_id))
}

#[tauri::command]
pub async fn consul_cancel_search(
    connection_id: String,
    request_id: String,
    scope: dbx_core::consul::ConsulScope,
    generation: u64,
) -> Result<bool, String> {
    Ok(dbx_core::consul::consul_cancel_search_core(&connection_id, &scope, generation, &request_id))
}

#[tauri::command]
pub async fn consul_txn(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulTxnRequest,
) -> Result<dbx_core::consul::ConsulTxnResult, String> {
    ensure_connection_writable(&state, &connection_id, "Execute Consul transaction").await?;
    dbx_core::consul::consul_txn_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_rename_key(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    source: String,
    target: String,
    expected_modify_index: dbx_core::agent_kv::KvInt64,
    copy: bool,
) -> Result<dbx_core::consul::ConsulTxnResult, String> {
    dbx_core::consul::consul_rename_key_core(&state, &connection_id, &source, &target, expected_modify_index, copy)
        .await
}

#[tauri::command]
pub async fn consul_blocking_query(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulBlockingRequest,
) -> Result<dbx_core::consul::ConsulBlockingResponse, String> {
    dbx_core::consul::consul_blocking_query_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_domain_watch(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulDomainWatchRequest,
) -> Result<dbx_core::consul::ConsulDomainWatchResponse, String> {
    dbx_core::consul::consul_domain_watch_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_cancel_blocking(
    connection_id: String,
    scope: dbx_core::consul::ConsulScope,
    generation: u64,
    operation_id: String,
) -> Result<bool, String> {
    Ok(dbx_core::consul::consul_cancel_blocking_core(&connection_id, &scope, generation, &operation_id))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsulWatchEvent {
    connection_id: String,
    operation_id: String,
    generation: u64,
    result: Option<dbx_core::consul::ConsulBlockingResponse>,
    error: Option<String>,
}

#[tauri::command]
pub async fn consul_watch_start(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulBlockingRequest,
) -> Result<String, String> {
    let operation_id = request.operation_id.clone();
    let event_operation_id = operation_id.clone();
    let generation = request.generation;
    let app_state = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        let response = dbx_core::consul::consul_blocking_query_core(&app_state, &connection_id, request).await;
        let event = match response {
            Ok(result) => ConsulWatchEvent {
                connection_id,
                operation_id: event_operation_id,
                generation,
                result: Some(result),
                error: None,
            },
            Err(error) => ConsulWatchEvent {
                connection_id,
                operation_id: event_operation_id,
                generation,
                result: None,
                error: Some(error),
            },
        };
        let _ = app.emit("consul-watch", event);
    });
    Ok(operation_id)
}

#[tauri::command]
pub async fn consul_export_bundle(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulExportRequest,
) -> Result<dbx_core::consul::ConsulKvBundle, String> {
    dbx_core::consul::consul_export_bundle_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_import_preview(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulImportRequest,
) -> Result<dbx_core::consul::ConsulImportPreview, String> {
    dbx_core::consul::consul_import_preview_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_import_execute(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulImportRequest,
) -> Result<dbx_core::consul::ConsulImportReport, String> {
    ensure_connection_writable(&state, &connection_id, "Import Consul KV bundle").await?;
    dbx_core::consul::consul_import_execute_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_delete_prefix_preview(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    prefix: String,
) -> Result<dbx_core::consul::ConsulDeletePrefixPreview, String> {
    dbx_core::consul::consul_delete_prefix_preview_core(&state, &connection_id, &prefix).await
}

#[tauri::command]
pub async fn consul_delete_prefix_execute(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulDeletePrefixRequest,
) -> Result<dbx_core::consul::ConsulDeletePrefixReport, String> {
    ensure_connection_writable(&state, &connection_id, "Delete Consul KV prefix").await?;
    dbx_core::consul::consul_delete_prefix_execute_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_get(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
) -> Result<KvGetResponse, String> {
    dbx_core::consul::consul_get_core(&state, &connection_id, &key).await
}

#[tauri::command]
pub async fn consul_put(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
    value: KvValue,
    options: Option<KvPutOptions>,
) -> Result<KvPutResponse, String> {
    ensure_connection_writable(&state, &connection_id, "Put Consul KV key").await?;
    dbx_core::consul::consul_put_core(&state, &connection_id, &key, value, options.unwrap_or_default()).await
}

#[tauri::command]
pub async fn consul_delete(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
    options: Option<KvDeleteOptions>,
) -> Result<KvDeleteResponse, String> {
    ensure_connection_writable(&state, &connection_id, "Delete Consul KV key").await?;
    dbx_core::consul::consul_delete_core(&state, &connection_id, &key, options.unwrap_or_default()).await
}

#[tauri::command]
pub async fn consul_prepared_query_list(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<dbx_core::consul::ConsulPreparedQuery>, String> {
    dbx_core::consul::consul_prepared_query_list_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn consul_prepared_query_read(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
) -> Result<dbx_core::consul::ConsulPreparedQuery, String> {
    dbx_core::consul::consul_prepared_query_read_core(&state, &connection_id, &id).await
}

#[tauri::command]
pub async fn consul_prepared_query_create(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    input: dbx_core::consul::ConsulPreparedQueryInput,
) -> Result<String, String> {
    ensure_connection_writable(&state, &connection_id, "Create Consul prepared query").await?;
    dbx_core::consul::consul_prepared_query_create_core(&state, &connection_id, input).await
}

#[tauri::command]
pub async fn consul_prepared_query_update(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
    input: dbx_core::consul::ConsulPreparedQueryInput,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Update Consul prepared query").await?;
    dbx_core::consul::consul_prepared_query_update_core(&state, &connection_id, &id, input).await
}

#[tauri::command]
pub async fn consul_prepared_query_delete(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Delete Consul prepared query").await?;
    dbx_core::consul::consul_prepared_query_delete_core(&state, &connection_id, &id).await
}

#[tauri::command]
pub async fn consul_prepared_query_execute(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulPreparedQueryExecuteRequest,
) -> Result<dbx_core::consul::ConsulPreparedQueryExecuteResponse, String> {
    dbx_core::consul::consul_prepared_query_execute_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_prepared_query_explain(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    query: String,
) -> Result<serde_json::Value, String> {
    dbx_core::consul::consul_prepared_query_explain_core(&state, &connection_id, &query).await
}

#[tauri::command]
pub async fn consul_event_list(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    name: Option<String>,
) -> Result<Vec<dbx_core::consul::ConsulEvent>, String> {
    dbx_core::consul::consul_event_list_core(&state, &connection_id, name.as_deref()).await
}

#[tauri::command]
pub async fn consul_event_fire(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulEventFireRequest,
) -> Result<dbx_core::consul::ConsulEvent, String> {
    ensure_connection_writable(&state, &connection_id, "Fire Consul event").await?;
    dbx_core::consul::consul_event_fire_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_coordinate_nodes(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<dbx_core::consul::ConsulCoordinate>, String> {
    dbx_core::consul::consul_coordinate_nodes_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn consul_operator_read(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    kind: dbx_core::consul::ConsulOperatorReadKind,
) -> Result<dbx_core::consul::ConsulOperatorDocument, String> {
    dbx_core::consul::consul_operator_read_core(&state, &connection_id, kind).await
}

#[tauri::command]
pub async fn consul_snapshot_generate(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<dbx_core::consul::ConsulSnapshot, String> {
    dbx_core::consul::consul_snapshot_generate_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn consul_snapshot_restore(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulSnapshotRestoreRequest,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Restore Consul snapshot").await?;
    dbx_core::consul::consul_snapshot_restore_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_autopilot_update(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    update: dbx_core::consul::ConsulAutopilotUpdate,
    confirmation: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Update Consul Autopilot").await?;
    dbx_core::consul::consul_autopilot_update_core(&state, &connection_id, update, &confirmation).await
}

#[tauri::command]
pub async fn consul_raft_transfer(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulRaftWriteRequest,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Transfer Consul Raft leadership").await?;
    dbx_core::consul::consul_raft_transfer_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_raft_remove(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulRaftWriteRequest,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Remove Consul Raft peer").await?;
    dbx_core::consul::consul_raft_remove_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_keyring_write(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulKeyringWriteRequest,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Modify Consul gossip keyring").await?;
    dbx_core::consul::consul_keyring_write_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_license_write(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulLicenseWriteRequest,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Update Consul license").await?;
    dbx_core::consul::consul_license_write_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_status_leader(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<String, String> {
    dbx_core::consul::consul_status_leader_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn consul_status_peers(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<String>, String> {
    dbx_core::consul::consul_status_peers_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn consul_agent_self(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<dbx_core::consul::ConsulAgentIdentity, String> {
    dbx_core::consul::consul_agent_self_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn consul_agent_members(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    wan: bool,
    segment: Option<String>,
) -> Result<Vec<dbx_core::consul::ConsulAgentMember>, String> {
    dbx_core::consul::consul_agent_members_core(&state, &connection_id, wan, segment.as_deref()).await
}

#[tauri::command]
pub async fn consul_agent_metrics(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<dbx_core::consul::ConsulAgentMetrics, String> {
    dbx_core::consul::consul_agent_metrics_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn consul_catalog_datacenters(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<String>, String> {
    dbx_core::consul::consul_catalog_datacenters_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn consul_catalog_nodes(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    options: dbx_core::consul::ConsulReadOptions,
) -> Result<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulCatalogNode>>, String> {
    dbx_core::consul::consul_catalog_nodes_core(&state, &connection_id, options).await
}

#[tauri::command]
pub async fn consul_catalog_services(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    options: dbx_core::consul::ConsulReadOptions,
) -> Result<dbx_core::consul::ConsulListResponse<std::collections::BTreeMap<String, Vec<String>>>, String> {
    dbx_core::consul::consul_catalog_services_core(&state, &connection_id, options).await
}

#[tauri::command]
pub async fn consul_catalog_service_nodes(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    service: String,
    options: dbx_core::consul::ConsulReadOptions,
) -> Result<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulCatalogServiceNode>>, String> {
    dbx_core::consul::consul_catalog_service_nodes_core(&state, &connection_id, &service, options).await
}

#[tauri::command]
pub async fn consul_catalog_node_services(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    node: String,
    options: dbx_core::consul::ConsulReadOptions,
) -> Result<dbx_core::consul::ConsulListResponse<dbx_core::consul::ConsulNodeServices>, String> {
    dbx_core::consul::consul_catalog_node_services_core(&state, &connection_id, &node, options).await
}

#[tauri::command]
pub async fn consul_health_node(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    node: String,
    options: dbx_core::consul::ConsulReadOptions,
) -> Result<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulHealthCheck>>, String> {
    dbx_core::consul::consul_health_node_core(&state, &connection_id, &node, options).await
}

#[tauri::command]
pub async fn consul_health_checks(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    service: String,
    options: dbx_core::consul::ConsulReadOptions,
) -> Result<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulHealthCheck>>, String> {
    dbx_core::consul::consul_health_checks_core(&state, &connection_id, &service, options).await
}

#[tauri::command]
pub async fn consul_health_service(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    service: String,
    passing: Option<bool>,
    options: dbx_core::consul::ConsulReadOptions,
) -> Result<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulServiceInstance>>, String> {
    dbx_core::consul::consul_health_service_core(&state, &connection_id, &service, passing, options).await
}

#[tauri::command]
pub async fn consul_health_state(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    health_state: String,
    options: dbx_core::consul::ConsulReadOptions,
) -> Result<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulHealthCheck>>, String> {
    dbx_core::consul::consul_health_state_core(&state, &connection_id, &health_state, options).await
}

#[tauri::command]
pub async fn consul_agent_services(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<std::collections::BTreeMap<String, dbx_core::consul::ConsulAgentService>, String> {
    dbx_core::consul::consul_agent_services_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn consul_agent_service(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
) -> Result<dbx_core::consul::ConsulAgentService, String> {
    dbx_core::consul::consul_agent_service_core(&state, &connection_id, &id).await
}

#[tauri::command]
pub async fn consul_agent_checks(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<std::collections::BTreeMap<String, dbx_core::consul::ConsulHealthCheck>, String> {
    dbx_core::consul::consul_agent_checks_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn consul_agent_register_service(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    registration: dbx_core::consul::ConsulAgentServiceRegistration,
) -> Result<dbx_core::consul::ConsulAgentWriteResult, String> {
    ensure_connection_writable(&state, &connection_id, "Register Consul Agent service").await?;
    dbx_core::consul::consul_agent_register_service_core(&state, &connection_id, registration).await
}

#[tauri::command]
pub async fn consul_agent_deregister_service(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
) -> Result<dbx_core::consul::ConsulAgentWriteResult, String> {
    ensure_connection_writable(&state, &connection_id, "Deregister Consul Agent service").await?;
    dbx_core::consul::consul_agent_deregister_service_core(&state, &connection_id, &id).await
}

#[tauri::command]
pub async fn consul_agent_service_maintenance(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
    enable: bool,
    reason: Option<String>,
) -> Result<dbx_core::consul::ConsulAgentWriteResult, String> {
    ensure_connection_writable(&state, &connection_id, "Change Consul Agent service maintenance").await?;
    dbx_core::consul::consul_agent_service_maintenance_core(&state, &connection_id, &id, enable, reason.as_deref())
        .await
}

#[tauri::command]
pub async fn consul_agent_register_check(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    registration: dbx_core::consul::ConsulAgentCheckRegistration,
) -> Result<dbx_core::consul::ConsulAgentWriteResult, String> {
    ensure_connection_writable(&state, &connection_id, "Register Consul Agent check").await?;
    dbx_core::consul::consul_agent_register_check_core(&state, &connection_id, registration).await
}

#[tauri::command]
pub async fn consul_agent_deregister_check(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
) -> Result<dbx_core::consul::ConsulAgentWriteResult, String> {
    ensure_connection_writable(&state, &connection_id, "Deregister Consul Agent check").await?;
    dbx_core::consul::consul_agent_deregister_check_core(&state, &connection_id, &id).await
}

#[tauri::command]
pub async fn consul_agent_update_ttl(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
    status: dbx_core::consul::ConsulCheckStatus,
    output: Option<String>,
) -> Result<dbx_core::consul::ConsulAgentWriteResult, String> {
    ensure_connection_writable(&state, &connection_id, "Update Consul Agent TTL check").await?;
    dbx_core::consul::consul_agent_update_ttl_core(&state, &connection_id, &id, status, output.as_deref()).await
}

#[tauri::command]
pub async fn consul_sessions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    options: dbx_core::consul::ConsulReadOptions,
) -> Result<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulSession>>, String> {
    dbx_core::consul::consul_sessions_core(&state, &connection_id, options).await
}

#[tauri::command]
pub async fn consul_node_sessions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    node: String,
    options: dbx_core::consul::ConsulReadOptions,
) -> Result<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulSession>>, String> {
    dbx_core::consul::consul_node_sessions_core(&state, &connection_id, &node, options).await
}

#[tauri::command]
pub async fn consul_session(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
) -> Result<Option<dbx_core::consul::ConsulSession>, String> {
    dbx_core::consul::consul_session_core(&state, &connection_id, &id).await
}

#[tauri::command]
pub async fn consul_session_keys(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
) -> Result<dbx_core::consul::ConsulSessionKeysResponse, String> {
    dbx_core::consul::consul_session_keys_core(&state, &connection_id, &id).await
}

#[tauri::command]
pub async fn consul_session_destroy_impact(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
) -> Result<dbx_core::consul::ConsulSessionDestroyImpact, String> {
    dbx_core::consul::consul_session_destroy_impact_core(&state, &connection_id, &id).await
}

#[tauri::command]
pub async fn consul_create_session(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulSessionCreateRequest,
) -> Result<dbx_core::consul::ConsulSession, String> {
    ensure_connection_writable(&state, &connection_id, "Create Consul Session").await?;
    dbx_core::consul::consul_create_session_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_renew_session(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
) -> Result<dbx_core::consul::ConsulSession, String> {
    ensure_connection_writable(&state, &connection_id, "Renew Consul Session").await?;
    dbx_core::consul::consul_renew_session_core(&state, &connection_id, &id).await
}

#[tauri::command]
pub async fn consul_destroy_session(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulSessionDestroyRequest,
) -> Result<bool, String> {
    ensure_connection_writable(&state, &connection_id, "Destroy Consul Session").await?;
    dbx_core::consul::consul_destroy_session_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_acquire_lock(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::ConsulLockRequest,
) -> Result<dbx_core::consul::ConsulLockResponse, String> {
    ensure_connection_writable(&state, &connection_id, "Acquire Consul KV lock").await?;
    dbx_core::consul::consul_acquire_lock_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn consul_release_lock(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
    session: String,
) -> Result<dbx_core::consul::ConsulLockResponse, String> {
    ensure_connection_writable(&state, &connection_id, "Release Consul KV lock").await?;
    dbx_core::consul::consul_release_lock_core(&state, &connection_id, &key, &session).await
}

#[tauri::command]
pub async fn consul_acl_list(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    kind: dbx_core::consul::ConsulAclKind,
) -> Result<dbx_core::consul::ConsulAclList, String> {
    dbx_core::consul::consul_acl_list_core(&state, &connection_id, kind).await
}
#[tauri::command]
pub async fn consul_acl_token_self(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<dbx_core::consul::ConsulAclToken, String> {
    dbx_core::consul::consul_acl_token_self_core(&state, &connection_id).await
}
#[tauri::command]
pub async fn consul_acl_token_clone(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    accessor_id: String,
    request: dbx_core::consul::ConsulAclTokenClone,
) -> Result<dbx_core::consul::ConsulAclToken, String> {
    ensure_connection_writable(&state, &connection_id, "Clone Consul ACL token").await?;
    dbx_core::consul::consul_acl_token_clone_core(&state, &connection_id, &accessor_id, request).await
}
#[tauri::command]
pub async fn consul_acl_get(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    kind: dbx_core::consul::ConsulAclKind,
    id: String,
) -> Result<dbx_core::consul::ConsulAclItem, String> {
    dbx_core::consul::consul_acl_get_core(&state, &connection_id, kind, &id).await
}
#[tauri::command]
pub async fn consul_acl_apply(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: Option<String>,
    value: dbx_core::consul::ConsulAclWrite,
) -> Result<dbx_core::consul::ConsulAclItem, String> {
    ensure_connection_writable(&state, &connection_id, "Write Consul ACL resource").await?;
    dbx_core::consul::consul_acl_apply_core(&state, &connection_id, id.as_deref(), value).await
}
#[tauri::command]
pub async fn consul_acl_references(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    kind: dbx_core::consul::ConsulAclKind,
    id: String,
) -> Result<dbx_core::consul::ConsulAclReferences, String> {
    dbx_core::consul::consul_acl_references_core(&state, &connection_id, kind, &id).await
}
#[tauri::command]
pub async fn consul_acl_delete(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    kind: dbx_core::consul::ConsulAclKind,
    id: String,
) -> Result<dbx_core::consul::ConsulAclReferences, String> {
    ensure_connection_writable(&state, &connection_id, "Delete Consul ACL resource").await?;
    dbx_core::consul::consul_acl_delete_core(&state, &connection_id, kind, &id).await
}

#[tauri::command]
pub async fn consul_enterprise_list(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    kind: dbx_core::consul::ConsulEnterpriseKind,
) -> Result<dbx_core::consul::ConsulEnterpriseList, String> {
    dbx_core::consul::consul_enterprise_list_core(&state, &connection_id, kind).await
}
#[tauri::command]
pub async fn consul_enterprise_get(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    kind: dbx_core::consul::ConsulEnterpriseKind,
    name: String,
) -> Result<dbx_core::consul::ConsulEnterpriseItem, String> {
    dbx_core::consul::consul_enterprise_get_core(&state, &connection_id, kind, &name).await
}
#[tauri::command]
pub async fn consul_enterprise_apply(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    existing_name: Option<String>,
    item: dbx_core::consul::ConsulEnterpriseWrite,
) -> Result<dbx_core::consul::ConsulEnterpriseItem, String> {
    ensure_connection_writable(&state, &connection_id, "Write Consul Enterprise scope").await?;
    dbx_core::consul::consul_enterprise_apply_core(&state, &connection_id, existing_name.as_deref(), item).await
}
#[tauri::command]
pub async fn consul_enterprise_impact(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    kind: dbx_core::consul::ConsulEnterpriseKind,
    name: String,
) -> Result<dbx_core::consul::ConsulScopeImpact, String> {
    dbx_core::consul::consul_enterprise_impact_core(&state, &connection_id, kind, &name).await
}
#[tauri::command]
pub async fn consul_enterprise_delete(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    kind: dbx_core::consul::ConsulEnterpriseKind,
    name: String,
) -> Result<dbx_core::consul::ConsulScopeImpact, String> {
    ensure_connection_writable(&state, &connection_id, "Delete Consul Enterprise scope").await?;
    dbx_core::consul::consul_enterprise_delete_core(&state, &connection_id, kind, &name).await
}

#[tauri::command]
pub async fn consul_mesh_config_list(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    kind: String,
) -> Result<Vec<dbx_core::consul::mesh::ConsulConfigEntry>, String> {
    dbx_core::consul::mesh::consul_mesh_config_list_core(&state, &connection_id, &kind).await
}
#[tauri::command]
pub async fn consul_mesh_config_get(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    kind: String,
    name: String,
) -> Result<dbx_core::consul::mesh::ConsulConfigEntry, String> {
    dbx_core::consul::mesh::consul_mesh_config_get_core(&state, &connection_id, &kind, &name).await
}
#[tauri::command]
pub async fn consul_mesh_config_apply(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::mesh::ConsulConfigEntryApply,
) -> Result<dbx_core::consul::mesh::ConsulConfigEntry, String> {
    ensure_connection_writable(&state, &connection_id, "Write Consul Service Mesh config entry").await?;
    dbx_core::consul::mesh::consul_mesh_config_apply_core(&state, &connection_id, request).await
}
#[tauri::command]
pub async fn consul_mesh_config_delete(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    kind: String,
    name: String,
    expected_modify_index: u64,
) -> Result<bool, String> {
    ensure_connection_writable(&state, &connection_id, "Delete Consul Service Mesh config entry").await?;
    dbx_core::consul::mesh::consul_mesh_config_delete_core(&state, &connection_id, &kind, &name, expected_modify_index)
        .await
}
#[tauri::command]
pub async fn consul_mesh_intentions_list(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<dbx_core::consul::mesh::ConsulIntention>, String> {
    dbx_core::consul::mesh::consul_mesh_intentions_list_core(&state, &connection_id).await
}
#[tauri::command]
pub async fn consul_mesh_intention_get(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
) -> Result<dbx_core::consul::mesh::ConsulIntention, String> {
    dbx_core::consul::mesh::consul_mesh_intention_get_core(&state, &connection_id, &id).await
}
#[tauri::command]
pub async fn consul_mesh_intention_get_exact(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::mesh::ConsulIntentionExactRequest,
) -> Result<dbx_core::consul::mesh::ConsulIntention, String> {
    dbx_core::consul::mesh::consul_mesh_intention_get_exact_core(&state, &connection_id, request).await
}
#[tauri::command]
pub async fn consul_mesh_intention_upsert(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    item: dbx_core::consul::mesh::ConsulIntention,
) -> Result<dbx_core::consul::mesh::ConsulIntention, String> {
    ensure_connection_writable(&state, &connection_id, "Write Consul intention").await?;
    dbx_core::consul::mesh::consul_mesh_intention_upsert_core(&state, &connection_id, item).await
}
#[tauri::command]
pub async fn consul_mesh_intention_delete(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    id: String,
) -> Result<bool, String> {
    ensure_connection_writable(&state, &connection_id, "Delete Consul intention").await?;
    dbx_core::consul::mesh::consul_mesh_intention_delete_core(&state, &connection_id, &id).await
}
#[tauri::command]
pub async fn consul_mesh_intention_delete_exact(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::mesh::ConsulIntentionExactRequest,
) -> Result<bool, String> {
    ensure_connection_writable(&state, &connection_id, "Delete exact Consul intention").await?;
    dbx_core::consul::mesh::consul_mesh_intention_delete_exact_core(&state, &connection_id, request).await
}
#[tauri::command]
pub async fn consul_mesh_intention_match(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::mesh::ConsulIntentionMatchRequest,
) -> Result<Vec<dbx_core::consul::mesh::ConsulIntention>, String> {
    dbx_core::consul::mesh::consul_mesh_intention_match_core(&state, &connection_id, request).await
}
#[tauri::command]
pub async fn consul_mesh_intention_check(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::mesh::ConsulIntentionCheckRequest,
) -> Result<dbx_core::consul::mesh::ConsulIntentionCheckResponse, String> {
    dbx_core::consul::mesh::consul_mesh_intention_check_core(&state, &connection_id, request).await
}
#[tauri::command]
pub async fn consul_mesh_discovery_chain(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    service: String,
) -> Result<dbx_core::consul::mesh::ConsulDiscoveryChain, String> {
    dbx_core::consul::mesh::consul_mesh_discovery_chain_core(&state, &connection_id, &service).await
}
#[tauri::command]
pub async fn consul_mesh_peering_list(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<dbx_core::consul::mesh::ConsulPeering>, String> {
    dbx_core::consul::mesh::consul_mesh_peering_list_core(&state, &connection_id).await
}
#[tauri::command]
pub async fn consul_mesh_peering_get(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    name: String,
) -> Result<dbx_core::consul::mesh::ConsulPeering, String> {
    dbx_core::consul::mesh::consul_mesh_peering_get_core(&state, &connection_id, &name).await
}
#[tauri::command]
pub async fn consul_mesh_peering_generate_token(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::mesh::ConsulPeeringGenerateRequest,
) -> Result<dbx_core::consul::mesh::ConsulPeeringToken, String> {
    ensure_connection_writable(&state, &connection_id, "Generate Consul peering token").await?;
    dbx_core::consul::mesh::consul_mesh_peering_generate_token_core(&state, &connection_id, request).await
}
#[tauri::command]
pub async fn consul_mesh_peering_establish(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: dbx_core::consul::mesh::ConsulPeeringEstablishRequest,
) -> Result<dbx_core::consul::mesh::ConsulPeering, String> {
    ensure_connection_writable(&state, &connection_id, "Establish Consul peering").await?;
    dbx_core::consul::mesh::consul_mesh_peering_establish_core(&state, &connection_id, request).await
}
#[tauri::command]
pub async fn consul_mesh_peering_delete(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    name: String,
) -> Result<bool, String> {
    ensure_connection_writable(&state, &connection_id, "Delete Consul peering").await?;
    dbx_core::consul::mesh::consul_mesh_peering_delete_core(&state, &connection_id, &name).await
}
#[tauri::command]
pub async fn consul_mesh_exported_services_list(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<dbx_core::consul::mesh::ConsulExportedService>, String> {
    dbx_core::consul::mesh::consul_mesh_exported_services_list_core(&state, &connection_id).await
}
#[tauri::command]
pub async fn consul_mesh_exported_services_apply(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    name: String,
    expected_modify_index: u64,
    raw: serde_json::Value,
) -> Result<dbx_core::consul::mesh::ConsulConfigEntry, String> {
    ensure_connection_writable(&state, &connection_id, "Write Consul exported services").await?;
    dbx_core::consul::mesh::consul_mesh_exported_services_apply_core(
        &state,
        &connection_id,
        &name,
        expected_modify_index,
        raw,
    )
    .await
}
