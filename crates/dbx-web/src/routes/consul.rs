use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

async fn ensure_writable(
    app: &dbx_core::connection::AppState,
    connection_id: &str,
    action: &str,
) -> Result<(), AppError> {
    if let Some(name) = dbx_core::query::connection_readonly_name(app, connection_id).await {
        return Err(AppError::from(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. {} blocked.",
            name, action
        )));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulListPrefixRequest {
    pub connection_id: String,
    pub prefix: String,
    pub limit: usize,
    pub continuation: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulListRecursiveRequest {
    pub connection_id: String,
    pub prefix: String,
    pub max_entries: usize,
    pub max_value_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSearchApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulSearchRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSearchControlRequest {
    pub connection_id: String,
    pub request_id: String,
    pub scope: dbx_core::consul::ConsulScope,
    pub generation: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulExportApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulExportRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulImportApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulImportRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulDeletePrefixPreviewRequest {
    pub connection_id: String,
    pub prefix: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulDeletePrefixExecuteRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulDeletePrefixRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulConnectionRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulTxnApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulTxnRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulRenameApiRequest {
    pub connection_id: String,
    pub source: String,
    pub target: String,
    pub expected_modify_index: dbx_core::agent_kv::KvInt64,
    pub copy: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulBlockingApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulBlockingRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulDomainWatchApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulDomainWatchRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulCancelBlockingApiRequest {
    pub connection_id: String,
    pub scope: dbx_core::consul::ConsulScope,
    pub generation: u64,
    pub operation_id: String,
}

pub async fn txn(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulTxnApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulTxnResult>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Execute Consul transaction").await?;
    Ok(Json(
        dbx_core::consul::consul_txn_core(&state.app, &req.connection_id, req.request).await.map_err(AppError::from)?,
    ))
}

pub async fn rename_key(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulRenameApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulTxnResult>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_rename_key_core(
            &state.app,
            &req.connection_id,
            &req.source,
            &req.target,
            req.expected_modify_index,
            req.copy,
        )
        .await
        .map_err(AppError::from)?,
    ))
}

pub async fn blocking_query(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulBlockingApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulBlockingResponse>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_blocking_query_core(&state.app, &req.connection_id, req.request)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn domain_watch(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulDomainWatchApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulDomainWatchResponse>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_domain_watch_core(&state.app, &req.connection_id, req.request)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn cancel_blocking(Json(req): Json<ConsulCancelBlockingApiRequest>) -> Result<Json<bool>, AppError> {
    Ok(Json(dbx_core::consul::consul_cancel_blocking_core(
        &req.connection_id,
        &req.scope,
        req.generation,
        &req.operation_id,
    )))
}

pub async fn capabilities(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulConnectionRequest>,
) -> Result<Json<dbx_core::consul::ConsulCapabilities>, AppError> {
    let result =
        dbx_core::consul::consul_capabilities_core(&state.app, &req.connection_id).await.map_err(AppError::from)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulKeyRequest {
    pub connection_id: String,
    pub key: String,
    pub options: Option<dbx_core::agent_kv::KvDeleteOptions>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulPutRequest {
    pub connection_id: String,
    pub key: String,
    pub value: dbx_core::agent_kv::KvValue,
    pub options: Option<dbx_core::agent_kv::KvPutOptions>,
}

pub async fn list_prefix(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulListPrefixRequest>,
) -> Result<Json<dbx_core::agent_kv::KvListPrefixResponse>, AppError> {
    let result = dbx_core::consul::consul_list_prefix_core(
        &state.app,
        &req.connection_id,
        &req.prefix,
        req.limit,
        req.continuation.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_recursive(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulListRecursiveRequest>,
) -> Result<Json<dbx_core::consul::ConsulRecursiveListResponse>, AppError> {
    let result = dbx_core::consul::consul_list_recursive_core(
        &state.app,
        &req.connection_id,
        &req.prefix,
        req.max_entries,
        req.max_value_bytes,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn search(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulSearchApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulSearchResponse>, AppError> {
    let result = dbx_core::consul::consul_search_core(&state.app, &req.connection_id, req.request)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn search_progress(
    Json(req): Json<ConsulSearchControlRequest>,
) -> Result<Json<dbx_core::consul::ConsulSearchProgress>, AppError> {
    Ok(Json(dbx_core::consul::consul_search_progress_core(
        &req.connection_id,
        &req.scope,
        req.generation,
        &req.request_id,
    )))
}

pub async fn cancel_search(Json(req): Json<ConsulSearchControlRequest>) -> Result<Json<bool>, AppError> {
    Ok(Json(dbx_core::consul::consul_cancel_search_core(
        &req.connection_id,
        &req.scope,
        req.generation,
        &req.request_id,
    )))
}

pub async fn export_bundle(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulExportApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulKvBundle>, AppError> {
    let result = dbx_core::consul::consul_export_bundle_core(&state.app, &req.connection_id, req.request)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn import_preview(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulImportApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulImportPreview>, AppError> {
    let result = dbx_core::consul::consul_import_preview_core(&state.app, &req.connection_id, req.request)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn import_execute(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulImportApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulImportReport>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Import Consul KV bundle").await?;
    let result = dbx_core::consul::consul_import_execute_core(&state.app, &req.connection_id, req.request)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn delete_prefix_preview(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulDeletePrefixPreviewRequest>,
) -> Result<Json<dbx_core::consul::ConsulDeletePrefixPreview>, AppError> {
    let result = dbx_core::consul::consul_delete_prefix_preview_core(&state.app, &req.connection_id, &req.prefix)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn delete_prefix_execute(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulDeletePrefixExecuteRequest>,
) -> Result<Json<dbx_core::consul::ConsulDeletePrefixReport>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete Consul KV prefix").await?;
    let result = dbx_core::consul::consul_delete_prefix_execute_core(&state.app, &req.connection_id, req.request)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulKeyRequest>,
) -> Result<Json<dbx_core::agent_kv::KvGetResponse>, AppError> {
    let result =
        dbx_core::consul::consul_get_core(&state.app, &req.connection_id, &req.key).await.map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn put(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulPutRequest>,
) -> Result<Json<dbx_core::agent_kv::KvPutResponse>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Put Consul KV key").await?;
    let result = dbx_core::consul::consul_put_core(
        &state.app,
        &req.connection_id,
        &req.key,
        req.value,
        req.options.unwrap_or_default(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn delete(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulKeyRequest>,
) -> Result<Json<dbx_core::agent_kv::KvDeleteResponse>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete Consul KV key").await?;
    let result =
        dbx_core::consul::consul_delete_core(&state.app, &req.connection_id, &req.key, req.options.unwrap_or_default())
            .await
            .map_err(AppError::from)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulIdRequest {
    pub connection_id: String,
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulQueryInputRequest {
    pub connection_id: String,
    pub id: Option<String>,
    pub input: dbx_core::consul::ConsulPreparedQueryInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulQueryExecuteApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulPreparedQueryExecuteRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulNameRequest {
    pub connection_id: String,
    pub name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulEventFireApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulEventFireRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulOperatorReadRequest {
    pub connection_id: String,
    pub kind: dbx_core::consul::ConsulOperatorReadKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSnapshotRestoreApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulSnapshotRestoreRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAutopilotApiRequest {
    pub connection_id: String,
    pub update: dbx_core::consul::ConsulAutopilotUpdate,
    pub confirmation: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulRaftApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulRaftWriteRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulKeyringApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulKeyringWriteRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulLicenseApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulLicenseWriteRequest,
}

pub async fn prepared_query_list(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulConnectionRequest>,
) -> Result<Json<Vec<dbx_core::consul::ConsulPreparedQuery>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_prepared_query_list_core(&state.app, &req.connection_id)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn prepared_query_read(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulIdRequest>,
) -> Result<Json<dbx_core::consul::ConsulPreparedQuery>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_prepared_query_read_core(&state.app, &req.connection_id, &req.id)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn prepared_query_create(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulQueryInputRequest>,
) -> Result<Json<String>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Create Consul prepared query").await?;
    Ok(Json(
        dbx_core::consul::consul_prepared_query_create_core(&state.app, &req.connection_id, req.input)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn prepared_query_update(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulQueryInputRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Update Consul prepared query").await?;
    dbx_core::consul::consul_prepared_query_update_core(
        &state.app,
        &req.connection_id,
        req.id.as_deref().unwrap_or(""),
        req.input,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(()))
}
pub async fn prepared_query_delete(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulIdRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete Consul prepared query").await?;
    dbx_core::consul::consul_prepared_query_delete_core(&state.app, &req.connection_id, &req.id)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}
pub async fn prepared_query_execute(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulQueryExecuteApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulPreparedQueryExecuteResponse>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_prepared_query_execute_core(&state.app, &req.connection_id, req.request)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn prepared_query_explain(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_prepared_query_explain_core(&state.app, &req.connection_id, &req.id)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn event_list(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulNameRequest>,
) -> Result<Json<Vec<dbx_core::consul::ConsulEvent>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_event_list_core(&state.app, &req.connection_id, req.name.as_deref())
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn event_fire(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulEventFireApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulEvent>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Fire Consul event").await?;
    Ok(Json(
        dbx_core::consul::consul_event_fire_core(&state.app, &req.connection_id, req.request)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn coordinate_nodes(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulConnectionRequest>,
) -> Result<Json<Vec<dbx_core::consul::ConsulCoordinate>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_coordinate_nodes_core(&state.app, &req.connection_id).await.map_err(AppError::from)?,
    ))
}
pub async fn operator_read(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulOperatorReadRequest>,
) -> Result<Json<dbx_core::consul::ConsulOperatorDocument>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_operator_read_core(&state.app, &req.connection_id, req.kind)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn snapshot_generate(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulConnectionRequest>,
) -> Result<Json<dbx_core::consul::ConsulSnapshot>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_snapshot_generate_core(&state.app, &req.connection_id)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn snapshot_restore(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulSnapshotRestoreApiRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Restore Consul snapshot").await?;
    dbx_core::consul::consul_snapshot_restore_core(&state.app, &req.connection_id, req.request)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}
pub async fn autopilot_update(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulAutopilotApiRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Update Consul Autopilot").await?;
    dbx_core::consul::consul_autopilot_update_core(&state.app, &req.connection_id, req.update, &req.confirmation)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}
pub async fn raft_transfer(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulRaftApiRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Transfer Consul Raft leadership").await?;
    dbx_core::consul::consul_raft_transfer_core(&state.app, &req.connection_id, req.request)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}
pub async fn raft_remove(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulRaftApiRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Remove Consul Raft peer").await?;
    dbx_core::consul::consul_raft_remove_core(&state.app, &req.connection_id, req.request)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}
pub async fn keyring_write(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulKeyringApiRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Modify Consul gossip keyring").await?;
    dbx_core::consul::consul_keyring_write_core(&state.app, &req.connection_id, req.request)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}
pub async fn license_write(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulLicenseApiRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Update Consul license").await?;
    dbx_core::consul::consul_license_write_core(&state.app, &req.connection_id, req.request)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulReadOptionsRequest {
    pub connection_id: String,
    #[serde(default)]
    pub options: dbx_core::consul::ConsulReadOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulNamedReadRequest {
    pub connection_id: String,
    pub name: String,
    #[serde(default)]
    pub options: dbx_core::consul::ConsulReadOptions,
}

pub async fn status_leader(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulConnectionRequest>,
) -> Result<Json<String>, AppError> {
    Ok(Json(dbx_core::consul::consul_status_leader_core(&state.app, &req.connection_id).await.map_err(AppError::from)?))
}

pub async fn status_peers(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulConnectionRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    Ok(Json(dbx_core::consul::consul_status_peers_core(&state.app, &req.connection_id).await.map_err(AppError::from)?))
}

pub async fn agent_self(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulConnectionRequest>,
) -> Result<Json<dbx_core::consul::ConsulAgentIdentity>, AppError> {
    Ok(Json(dbx_core::consul::consul_agent_self_core(&state.app, &req.connection_id).await.map_err(AppError::from)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentMembersRequest {
    pub connection_id: String,
    #[serde(default)]
    pub wan: bool,
    pub segment: Option<String>,
}

pub async fn agent_members(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulAgentMembersRequest>,
) -> Result<Json<Vec<dbx_core::consul::ConsulAgentMember>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_agent_members_core(&state.app, &req.connection_id, req.wan, req.segment.as_deref())
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn agent_metrics(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulConnectionRequest>,
) -> Result<Json<dbx_core::consul::ConsulAgentMetrics>, AppError> {
    Ok(Json(dbx_core::consul::consul_agent_metrics_core(&state.app, &req.connection_id).await.map_err(AppError::from)?))
}

pub async fn catalog_datacenters(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulConnectionRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_catalog_datacenters_core(&state.app, &req.connection_id)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn catalog_nodes(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulReadOptionsRequest>,
) -> Result<Json<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulCatalogNode>>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_catalog_nodes_core(&state.app, &req.connection_id, req.options)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn catalog_services(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulReadOptionsRequest>,
) -> Result<Json<dbx_core::consul::ConsulListResponse<std::collections::BTreeMap<String, Vec<String>>>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_catalog_services_core(&state.app, &req.connection_id, req.options)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn catalog_service_nodes(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulNamedReadRequest>,
) -> Result<Json<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulCatalogServiceNode>>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_catalog_service_nodes_core(&state.app, &req.connection_id, &req.name, req.options)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn catalog_node_services(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulNamedReadRequest>,
) -> Result<Json<dbx_core::consul::ConsulListResponse<dbx_core::consul::ConsulNodeServices>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_catalog_node_services_core(&state.app, &req.connection_id, &req.name, req.options)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn health_node(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulNamedReadRequest>,
) -> Result<Json<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulHealthCheck>>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_health_node_core(&state.app, &req.connection_id, &req.name, req.options)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn health_checks(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulNamedReadRequest>,
) -> Result<Json<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulHealthCheck>>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_health_checks_core(&state.app, &req.connection_id, &req.name, req.options)
            .await
            .map_err(AppError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulHealthServiceRequest {
    pub connection_id: String,
    pub name: String,
    pub passing: Option<bool>,
    #[serde(default)]
    pub options: dbx_core::consul::ConsulReadOptions,
}

pub async fn health_service(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulHealthServiceRequest>,
) -> Result<Json<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulServiceInstance>>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_health_service_core(
            &state.app,
            &req.connection_id,
            &req.name,
            req.passing,
            req.options,
        )
        .await
        .map_err(AppError::from)?,
    ))
}

pub async fn health_state(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulNamedReadRequest>,
) -> Result<Json<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulHealthCheck>>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_health_state_core(&state.app, &req.connection_id, &req.name, req.options)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn agent_services(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulConnectionRequest>,
) -> Result<Json<std::collections::BTreeMap<String, dbx_core::consul::ConsulAgentService>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_agent_services_core(&state.app, &req.connection_id).await.map_err(AppError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentServiceRequest {
    pub connection_id: String,
    pub id: String,
}

pub async fn agent_service(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulAgentServiceRequest>,
) -> Result<Json<dbx_core::consul::ConsulAgentService>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_agent_service_core(&state.app, &req.connection_id, &req.id)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn agent_checks(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulConnectionRequest>,
) -> Result<Json<std::collections::BTreeMap<String, dbx_core::consul::ConsulHealthCheck>>, AppError> {
    Ok(Json(dbx_core::consul::consul_agent_checks_core(&state.app, &req.connection_id).await.map_err(AppError::from)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentServiceWriteRequest {
    pub connection_id: String,
    pub registration: dbx_core::consul::ConsulAgentServiceRegistration,
}

pub async fn agent_register_service(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulAgentServiceWriteRequest>,
) -> Result<Json<dbx_core::consul::ConsulAgentWriteResult>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Register Consul Agent service").await?;
    Ok(Json(
        dbx_core::consul::consul_agent_register_service_core(&state.app, &req.connection_id, req.registration)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn agent_deregister_service(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulIdRequest>,
) -> Result<Json<dbx_core::consul::ConsulAgentWriteResult>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Deregister Consul Agent service").await?;
    Ok(Json(
        dbx_core::consul::consul_agent_deregister_service_core(&state.app, &req.connection_id, &req.id)
            .await
            .map_err(AppError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulMaintenanceRequest {
    pub connection_id: String,
    pub id: String,
    pub enable: bool,
    pub reason: Option<String>,
}

pub async fn agent_service_maintenance(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMaintenanceRequest>,
) -> Result<Json<dbx_core::consul::ConsulAgentWriteResult>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Change Consul Agent service maintenance").await?;
    Ok(Json(
        dbx_core::consul::consul_agent_service_maintenance_core(
            &state.app,
            &req.connection_id,
            &req.id,
            req.enable,
            req.reason.as_deref(),
        )
        .await
        .map_err(AppError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentCheckWriteRequest {
    pub connection_id: String,
    pub registration: dbx_core::consul::ConsulAgentCheckRegistration,
}

pub async fn agent_register_check(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulAgentCheckWriteRequest>,
) -> Result<Json<dbx_core::consul::ConsulAgentWriteResult>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Register Consul Agent check").await?;
    Ok(Json(
        dbx_core::consul::consul_agent_register_check_core(&state.app, &req.connection_id, req.registration)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn agent_deregister_check(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulIdRequest>,
) -> Result<Json<dbx_core::consul::ConsulAgentWriteResult>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Deregister Consul Agent check").await?;
    Ok(Json(
        dbx_core::consul::consul_agent_deregister_check_core(&state.app, &req.connection_id, &req.id)
            .await
            .map_err(AppError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulTtlUpdateRequest {
    pub connection_id: String,
    pub id: String,
    pub status: dbx_core::consul::ConsulCheckStatus,
    pub output: Option<String>,
}

pub async fn agent_update_ttl(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulTtlUpdateRequest>,
) -> Result<Json<dbx_core::consul::ConsulAgentWriteResult>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Update Consul Agent TTL check").await?;
    Ok(Json(
        dbx_core::consul::consul_agent_update_ttl_core(
            &state.app,
            &req.connection_id,
            &req.id,
            req.status,
            req.output.as_deref(),
        )
        .await
        .map_err(AppError::from)?,
    ))
}

pub async fn sessions(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulReadOptionsRequest>,
) -> Result<Json<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulSession>>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_sessions_core(&state.app, &req.connection_id, req.options)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn node_sessions(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulNamedReadRequest>,
) -> Result<Json<dbx_core::consul::ConsulListResponse<Vec<dbx_core::consul::ConsulSession>>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_node_sessions_core(&state.app, &req.connection_id, &req.name, req.options)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn session(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulIdRequest>,
) -> Result<Json<Option<dbx_core::consul::ConsulSession>>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_session_core(&state.app, &req.connection_id, &req.id).await.map_err(AppError::from)?,
    ))
}

pub async fn session_keys(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulIdRequest>,
) -> Result<Json<dbx_core::consul::ConsulSessionKeysResponse>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_session_keys_core(&state.app, &req.connection_id, &req.id)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn session_destroy_impact(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulIdRequest>,
) -> Result<Json<dbx_core::consul::ConsulSessionDestroyImpact>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_session_destroy_impact_core(&state.app, &req.connection_id, &req.id)
            .await
            .map_err(AppError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSessionCreateApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulSessionCreateRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSessionDestroyApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulSessionDestroyRequest,
}

pub async fn create_session(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulSessionCreateApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulSession>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Create Consul Session").await?;
    Ok(Json(
        dbx_core::consul::consul_create_session_core(&state.app, &req.connection_id, req.request)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn renew_session(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulIdRequest>,
) -> Result<Json<dbx_core::consul::ConsulSession>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Renew Consul Session").await?;
    Ok(Json(
        dbx_core::consul::consul_renew_session_core(&state.app, &req.connection_id, &req.id)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn destroy_session(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulSessionDestroyApiRequest>,
) -> Result<Json<bool>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Destroy Consul Session").await?;
    Ok(Json(
        dbx_core::consul::consul_destroy_session_core(&state.app, &req.connection_id, req.request)
            .await
            .map_err(AppError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAcquireLockApiRequest {
    pub connection_id: String,
    pub request: dbx_core::consul::ConsulLockRequest,
}

pub async fn acquire_lock(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulAcquireLockApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulLockResponse>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Acquire Consul KV lock").await?;
    Ok(Json(
        dbx_core::consul::consul_acquire_lock_core(&state.app, &req.connection_id, req.request)
            .await
            .map_err(AppError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulReleaseLockApiRequest {
    pub connection_id: String,
    pub key: String,
    pub session: String,
}

pub async fn release_lock(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulReleaseLockApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulLockResponse>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Release Consul KV lock").await?;
    Ok(Json(
        dbx_core::consul::consul_release_lock_core(&state.app, &req.connection_id, &req.key, &req.session)
            .await
            .map_err(AppError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAclApiRequest {
    pub connection_id: String,
    pub kind: Option<dbx_core::consul::ConsulAclKind>,
    pub id: Option<String>,
    pub value: Option<dbx_core::consul::ConsulAclWrite>,
    pub description: Option<String>,
}

pub async fn acl_token_self(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulConnectionRequest>,
) -> Result<Json<dbx_core::consul::ConsulAclToken>, AppError> {
    Ok(Json(
        dbx_core::consul::consul_acl_token_self_core(&state.app, &req.connection_id).await.map_err(AppError::from)?,
    ))
}
pub async fn acl_token_clone(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulAclApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulAclToken>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Clone Consul ACL token").await?;
    let accessor_id = req.id.ok_or_else(|| AppError::from("ACL token AccessorID is required".to_string()))?;
    let request = dbx_core::consul::ConsulAclTokenClone { description: req.description.unwrap_or_default() };
    Ok(Json(
        dbx_core::consul::consul_acl_token_clone_core(&state.app, &req.connection_id, &accessor_id, request)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn acl_list(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulAclApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulAclList>, AppError> {
    let kind = req.kind.ok_or_else(|| AppError::from("ACL kind is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::consul_acl_list_core(&state.app, &req.connection_id, kind).await.map_err(AppError::from)?,
    ))
}
pub async fn acl_get(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulAclApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulAclItem>, AppError> {
    let kind = req.kind.ok_or_else(|| AppError::from("ACL kind is required".to_string()))?;
    let id = req.id.ok_or_else(|| AppError::from("ACL identifier is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::consul_acl_get_core(&state.app, &req.connection_id, kind, &id)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn acl_apply(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulAclApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulAclItem>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Write Consul ACL resource").await?;
    let value = req.value.ok_or_else(|| AppError::from("ACL value is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::consul_acl_apply_core(&state.app, &req.connection_id, req.id.as_deref(), value)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn acl_references(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulAclApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulAclReferences>, AppError> {
    let kind = req.kind.ok_or_else(|| AppError::from("ACL kind is required".to_string()))?;
    let id = req.id.ok_or_else(|| AppError::from("ACL identifier is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::consul_acl_references_core(&state.app, &req.connection_id, kind, &id)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn acl_delete(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulAclApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulAclReferences>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete Consul ACL resource").await?;
    let kind = req.kind.ok_or_else(|| AppError::from("ACL kind is required".to_string()))?;
    let id = req.id.ok_or_else(|| AppError::from("ACL identifier is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::consul_acl_delete_core(&state.app, &req.connection_id, kind, &id)
            .await
            .map_err(AppError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulEnterpriseApiRequest {
    pub connection_id: String,
    pub kind: Option<dbx_core::consul::ConsulEnterpriseKind>,
    pub name: Option<String>,
    pub existing_name: Option<String>,
    pub item: Option<dbx_core::consul::ConsulEnterpriseWrite>,
}
pub async fn enterprise_list(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulEnterpriseApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulEnterpriseList>, AppError> {
    let kind = req.kind.ok_or_else(|| AppError::from("Enterprise kind is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::consul_enterprise_list_core(&state.app, &req.connection_id, kind)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn enterprise_get(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulEnterpriseApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulEnterpriseItem>, AppError> {
    let kind = req.kind.ok_or_else(|| AppError::from("Enterprise kind is required".to_string()))?;
    let name = req.name.ok_or_else(|| AppError::from("Enterprise resource name is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::consul_enterprise_get_core(&state.app, &req.connection_id, kind, &name)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn enterprise_apply(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulEnterpriseApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulEnterpriseItem>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Write Consul Enterprise scope").await?;
    let item = req.item.ok_or_else(|| AppError::from("Enterprise resource is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::consul_enterprise_apply_core(
            &state.app,
            &req.connection_id,
            req.existing_name.as_deref(),
            item,
        )
        .await
        .map_err(AppError::from)?,
    ))
}
pub async fn enterprise_impact(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulEnterpriseApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulScopeImpact>, AppError> {
    let kind = req.kind.ok_or_else(|| AppError::from("Enterprise kind is required".to_string()))?;
    let name = req.name.ok_or_else(|| AppError::from("Enterprise resource name is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::consul_enterprise_impact_core(&state.app, &req.connection_id, kind, &name)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn enterprise_delete(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulEnterpriseApiRequest>,
) -> Result<Json<dbx_core::consul::ConsulScopeImpact>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete Consul Enterprise scope").await?;
    let kind = req.kind.ok_or_else(|| AppError::from("Enterprise kind is required".to_string()))?;
    let name = req.name.ok_or_else(|| AppError::from("Enterprise resource name is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::consul_enterprise_delete_core(&state.app, &req.connection_id, kind, &name)
            .await
            .map_err(AppError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulMeshConfigApiRequest {
    pub connection_id: String,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub expected_modify_index: Option<u64>,
    pub request: Option<dbx_core::consul::mesh::ConsulConfigEntryApply>,
    pub raw: Option<serde_json::Value>,
}
pub async fn mesh_config_list(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshConfigApiRequest>,
) -> Result<Json<Vec<dbx_core::consul::mesh::ConsulConfigEntry>>, AppError> {
    let kind = req.kind.ok_or_else(|| AppError::from("Config kind is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_config_list_core(&state.app, &req.connection_id, &kind)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_config_get(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshConfigApiRequest>,
) -> Result<Json<dbx_core::consul::mesh::ConsulConfigEntry>, AppError> {
    let kind = req.kind.ok_or_else(|| AppError::from("Config kind is required".to_string()))?;
    let name = req.name.ok_or_else(|| AppError::from("Config name is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_config_get_core(&state.app, &req.connection_id, &kind, &name)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_config_apply(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshConfigApiRequest>,
) -> Result<Json<dbx_core::consul::mesh::ConsulConfigEntry>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Write Consul Service Mesh config entry").await?;
    let request = req.request.ok_or_else(|| AppError::from("Config request is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_config_apply_core(&state.app, &req.connection_id, request)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_config_delete(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshConfigApiRequest>,
) -> Result<Json<bool>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete Consul Service Mesh config entry").await?;
    let kind = req.kind.ok_or_else(|| AppError::from("Config kind is required".to_string()))?;
    let name = req.name.ok_or_else(|| AppError::from("Config name is required".to_string()))?;
    let index =
        req.expected_modify_index.ok_or_else(|| AppError::from("Expected ModifyIndex is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_config_delete_core(&state.app, &req.connection_id, &kind, &name, index)
            .await
            .map_err(AppError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulMeshApiRequest {
    pub connection_id: String,
    pub id: Option<String>,
    pub name: Option<String>,
    pub service: Option<String>,
    pub intention: Option<dbx_core::consul::mesh::ConsulIntention>,
    pub exact_request: Option<dbx_core::consul::mesh::ConsulIntentionExactRequest>,
    pub match_request: Option<dbx_core::consul::mesh::ConsulIntentionMatchRequest>,
    pub check_request: Option<dbx_core::consul::mesh::ConsulIntentionCheckRequest>,
    pub generate_request: Option<dbx_core::consul::mesh::ConsulPeeringGenerateRequest>,
    pub establish_request: Option<dbx_core::consul::mesh::ConsulPeeringEstablishRequest>,
}
pub async fn mesh_intentions_list(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<Vec<dbx_core::consul::mesh::ConsulIntention>>, AppError> {
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_intentions_list_core(&state.app, &req.connection_id)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_intention_get(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<dbx_core::consul::mesh::ConsulIntention>, AppError> {
    let id = req.id.ok_or_else(|| AppError::from("Intention ID is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_intention_get_core(&state.app, &req.connection_id, &id)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_intention_get_exact(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<dbx_core::consul::mesh::ConsulIntention>, AppError> {
    let request = req.exact_request.ok_or_else(|| AppError::from("Exact intention request is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_intention_get_exact_core(&state.app, &req.connection_id, request)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_intention_upsert(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<dbx_core::consul::mesh::ConsulIntention>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Write Consul intention").await?;
    let item = req.intention.ok_or_else(|| AppError::from("Intention is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_intention_upsert_core(&state.app, &req.connection_id, item)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_intention_delete(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<bool>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete Consul intention").await?;
    let id = req.id.ok_or_else(|| AppError::from("Intention ID is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_intention_delete_core(&state.app, &req.connection_id, &id)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_intention_delete_exact(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<bool>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete exact Consul intention").await?;
    let request = req.exact_request.ok_or_else(|| AppError::from("Exact intention request is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_intention_delete_exact_core(&state.app, &req.connection_id, request)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_intention_match(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<Vec<dbx_core::consul::mesh::ConsulIntention>>, AppError> {
    let request = req.match_request.ok_or_else(|| AppError::from("Intention match request is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_intention_match_core(&state.app, &req.connection_id, request)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_intention_check(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<dbx_core::consul::mesh::ConsulIntentionCheckResponse>, AppError> {
    let request = req.check_request.ok_or_else(|| AppError::from("Intention check request is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_intention_check_core(&state.app, &req.connection_id, request)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_discovery_chain(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<dbx_core::consul::mesh::ConsulDiscoveryChain>, AppError> {
    let service = req.service.ok_or_else(|| AppError::from("Service is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_discovery_chain_core(&state.app, &req.connection_id, &service)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_peering_list(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<Vec<dbx_core::consul::mesh::ConsulPeering>>, AppError> {
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_peering_list_core(&state.app, &req.connection_id)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_peering_get(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<dbx_core::consul::mesh::ConsulPeering>, AppError> {
    let name = req.name.ok_or_else(|| AppError::from("Peering name is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_peering_get_core(&state.app, &req.connection_id, &name)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_peering_generate_token(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<dbx_core::consul::mesh::ConsulPeeringToken>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Generate Consul peering token").await?;
    let request =
        req.generate_request.ok_or_else(|| AppError::from("Peering token request is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_peering_generate_token_core(&state.app, &req.connection_id, request)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_peering_establish(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<dbx_core::consul::mesh::ConsulPeering>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Establish Consul peering").await?;
    let request =
        req.establish_request.ok_or_else(|| AppError::from("Peering establish request is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_peering_establish_core(&state.app, &req.connection_id, request)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_peering_delete(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<bool>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete Consul peering").await?;
    let name = req.name.ok_or_else(|| AppError::from("Peering name is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_peering_delete_core(&state.app, &req.connection_id, &name)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_exported_services_list(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshApiRequest>,
) -> Result<Json<Vec<dbx_core::consul::mesh::ConsulExportedService>>, AppError> {
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_exported_services_list_core(&state.app, &req.connection_id)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn mesh_exported_services_apply(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConsulMeshConfigApiRequest>,
) -> Result<Json<dbx_core::consul::mesh::ConsulConfigEntry>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Write Consul exported services").await?;
    let name = req.name.ok_or_else(|| AppError::from("Exported services name is required".to_string()))?;
    let index =
        req.expected_modify_index.ok_or_else(|| AppError::from("Expected ModifyIndex is required".to_string()))?;
    let raw = req.raw.ok_or_else(|| AppError::from("Raw exported-services JSON is required".to_string()))?;
    Ok(Json(
        dbx_core::consul::mesh::consul_mesh_exported_services_apply_core(
            &state.app,
            &req.connection_id,
            &name,
            index,
            raw,
        )
        .await
        .map_err(AppError::from)?,
    ))
}
