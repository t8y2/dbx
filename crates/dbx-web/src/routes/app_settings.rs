use std::sync::Arc;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use axum::extract::State;
use axum::http::header;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use dbx_core::storage::{McpGlobalPolicy, McpGlobalPolicyState};
use pbkdf2::pbkdf2_hmac;
use serde::Deserialize;
use sha2::Sha256;

use crate::error::AppError;
use crate::state::WebState;
use crate::web_mcp::{UpdateWebMcpRequest, WebMcpHttpStatus};

const CONFIG_PBKDF2_ITERATIONS: u32 = 100_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePinnedTreeNodeIdsRequest {
    pub ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedConfigPayload {
    pub format: String,
    pub version: u8,
    pub salt: String,
    pub iv: String,
    pub data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecryptConfigRequest {
    pub payload: EncryptedConfigPayload,
    pub passphrase: String,
}

pub async fn load_pinned_tree_node_ids(State(state): State<Arc<WebState>>) -> Result<Json<Vec<String>>, AppError> {
    let ids = state.app.storage.load_pinned_tree_node_ids().await.map_err(AppError::from)?;
    Ok(Json(ids))
}

pub async fn save_pinned_tree_node_ids(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SavePinnedTreeNodeIdsRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_pinned_tree_node_ids(&body.ids).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn load_mcp_global_policy(
    State(state): State<Arc<WebState>>,
) -> Result<Json<McpGlobalPolicyState>, AppError> {
    state.app.storage.load_mcp_global_policy().await.map(Json).map_err(AppError::from)
}

pub async fn load_mcp_tool_catalog() -> Json<dbx_core::mcp_catalog::McpToolCatalog> {
    Json(dbx_mcp::DbxMcpServer::tool_catalog())
}

pub async fn list_plugin_mcp_views(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<dbx_core::plugin_mcp::PluginMcpView>>, AppError> {
    dbx_core::plugin_mcp::list_plugin_views(&state.app).await.map(Json).map_err(AppError::from)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpViewRequest {
    pub plugin_id: String,
}

pub async fn load_plugin_mcp_view(
    State(state): State<Arc<WebState>>,
    Json(body): Json<PluginMcpViewRequest>,
) -> Result<Json<dbx_core::plugin_mcp::PluginMcpView>, AppError> {
    dbx_core::plugin_mcp::plugin_view_for(&state.app, &body.plugin_id).await.map(Json).map_err(AppError::bad_request)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPluginMcpScopesRequest {
    pub plugin_id: String,
    pub connection_id: String,
}

pub async fn list_plugin_mcp_scopes(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ListPluginMcpScopesRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let manifest = state
        .app
        .plugins
        .list_installed()
        .map_err(AppError::from)?
        .into_iter()
        .find(|plugin| plugin.manifest.id == body.plugin_id)
        .ok_or_else(|| AppError::bad_request("Plugin is not installed."))?
        .manifest;
    let method = manifest
        .mcp_contribution()
        .and_then(|mcp| mcp.scope.as_ref())
        .and_then(|scope| scope.list_method.as_deref())
        .ok_or_else(|| AppError::bad_request("This plugin does not declare a scope list method."))?;
    let (policy, group_paths) = crate::routes::mcp_policy::load_policy_context(&state).await?;
    let connection = state
        .app
        .storage
        .load_connections()
        .await
        .map_err(AppError::from)?
        .into_iter()
        .find(|connection| connection.id == body.connection_id)
        .ok_or_else(|| AppError::bad_request("CONNECTION_NOT_FOUND: connection is not available."))?;
    if connection.plugin_id.as_deref() != Some(body.plugin_id.as_str()) {
        return Err(AppError::bad_request("CONNECTION_OUT_OF_SCOPE: connection is not owned by this plugin."));
    }
    crate::routes::mcp_policy::ensure_allowed(&policy, group_paths.get(&connection.id), &connection.id)?;
    let value = state
        .app
        .plugin_host
        .invoke::<serde_json::Value>(
            &body.plugin_id,
            method,
            serde_json::json!({ "connectionId": connection.id }),
            None,
            Some(std::time::Duration::from_secs(8)),
        )
        .await
        .map_err(AppError::bad_request)?;
    let values: Vec<String> = serde_json::from_value(
        value
            .get("values")
            .cloned()
            .ok_or_else(|| AppError::bad_request("Plugin scope list must return { values: string[] }."))?,
    )
    .map_err(|_| AppError::bad_request("Plugin scope list must return { values: string[] }."))?;
    Ok(Json(serde_json::json!({ "values": values })))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePluginMcpGrantRequest {
    pub plugin_id: String,
    pub grant: dbx_core::storage::PluginMcpGrant,
    #[serde(default)]
    pub approve_current: bool,
}

pub async fn save_plugin_mcp_grant(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SavePluginMcpGrantRequest>,
) -> Result<Json<dbx_core::plugin_mcp::PluginMcpView>, AppError> {
    dbx_core::plugin_mcp::save_plugin_grant(&state.app, &body.plugin_id, body.grant, body.approve_current)
        .await
        .map(Json)
        .map_err(AppError::bad_request)
}

pub async fn load_mcp_access_policy(
    State(state): State<Arc<WebState>>,
) -> Result<Json<dbx_core::mcp_access::McpAccessPolicy>, AppError> {
    state.app.storage.load_mcp_access_policy().await.map(Json).map_err(AppError::from)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMcpPluginScopeRuleRequest {
    pub connection_id: String,
    pub kind: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub rule: Option<dbx_core::mcp_access::McpAccessRule>,
    #[serde(default)]
    pub sub_scope: Option<dbx_core::mcp_access::McpSubScopeMode>,
}

pub async fn set_mcp_plugin_scope_rule(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SetMcpPluginScopeRuleRequest>,
) -> Result<Json<dbx_core::mcp_access::McpAccessPolicy>, AppError> {
    dbx_core::plugin_mcp::set_scope_rule(
        &state.app,
        &body.connection_id,
        &body.kind,
        body.value.as_deref(),
        body.rule,
        body.sub_scope,
    )
    .await
    .map(Json)
    .map_err(AppError::bad_request)
}

pub async fn reset_invalid_mcp_access_policy(State(state): State<Arc<WebState>>) -> Result<Json<()>, AppError> {
    state.app.storage.reset_invalid_mcp_access_policy().await.map(Json).map_err(AppError::bad_request)
}

pub async fn save_mcp_global_policy(
    State(state): State<Arc<WebState>>,
    Json(policy): Json<McpGlobalPolicy>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_mcp_global_policy(&policy).await.map_err(AppError::from)?;
    Ok(Json(()))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebCapabilities {
    pub password_viewer_enabled: bool,
}

pub async fn load_web_capabilities(State(state): State<Arc<WebState>>) -> Json<WebCapabilities> {
    Json(WebCapabilities { password_viewer_enabled: state.password_viewer_enabled })
}

pub async fn load_web_mcp_http_status(State(state): State<Arc<WebState>>) -> impl IntoResponse {
    let endpoint_path =
        if state.public_base_path == "/" { "/mcp".to_string() } else { format!("{}/mcp", state.public_base_path) };
    let management_available =
        !state.password_disabled && state.password_hash.read().await.is_some() && !state.demo_mode;
    let mut status = state.web_mcp.status(endpoint_path, management_available);
    if state.demo_mode {
        status.enabled = false;
    }
    web_mcp_status_response(status)
}

pub async fn save_web_mcp_http_settings(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(request): Json<UpdateWebMcpRequest>,
) -> Result<impl IntoResponse, AppError> {
    ensure_web_mcp_management_allowed(&state, &headers).await?;
    state.web_mcp.update(&state.app.storage, request).await.map_err(AppError::bad_request)?;
    let endpoint_path =
        if state.public_base_path == "/" { "/mcp".to_string() } else { format!("{}/mcp", state.public_base_path) };
    Ok(web_mcp_status_response(state.web_mcp.status(endpoint_path, true)))
}

pub async fn rotate_web_mcp_token(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    ensure_web_mcp_management_allowed(&state, &headers).await?;
    state.web_mcp.rotate(&state.app.storage).await.map_err(AppError::bad_request)?;
    let endpoint_path =
        if state.public_base_path == "/" { "/mcp".to_string() } else { format!("{}/mcp", state.public_base_path) };
    Ok(web_mcp_status_response(state.web_mcp.status(endpoint_path, true)))
}

fn web_mcp_status_response(status: WebMcpHttpStatus) -> impl IntoResponse {
    ([(header::CACHE_CONTROL, "no-store")], Json(status))
}

async fn ensure_web_mcp_management_allowed(state: &WebState, headers: &HeaderMap) -> Result<(), AppError> {
    if state.demo_mode || state.password_disabled || state.password_hash.read().await.is_none() {
        return Err(AppError::forbidden("Web MCP management requires password-protected DBX Web"));
    }
    if headers.get("x-dbx-mcp-settings").and_then(|value| value.to_str().ok()) != Some("1") {
        return Err(AppError::forbidden("Web MCP management requires a same-origin settings request"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMaxAgentTurnsRequest {
    pub max_agent_turns: u32,
}

pub async fn load_max_agent_turns(State(state): State<Arc<WebState>>) -> Result<Json<u32>, AppError> {
    state.app.storage.load_max_agent_turns().await.map(Json).map_err(AppError::from)
}

pub async fn save_max_agent_turns(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveMaxAgentTurnsRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_max_agent_turns(body.max_agent_turns).await.map_err(AppError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
pub struct SaveHistoryRetentionLimitRequest {
    pub limit: u32,
}

pub async fn load_history_retention_limit(State(state): State<Arc<WebState>>) -> Result<Json<u32>, AppError> {
    state.app.storage.load_history_retention_limit().await.map(Json).map_err(AppError::from)
}

pub async fn save_history_retention_limit(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveHistoryRetentionLimitRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::history::validate_history_retention_limit(body.limit).map_err(AppError::bad_request)?;
    state.app.storage.save_history_retention_limit(body.limit).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn load_mcp_history_retention_limit(State(state): State<Arc<WebState>>) -> Result<Json<u32>, AppError> {
    state.app.storage.load_mcp_history_retention_limit().await.map(Json).map_err(AppError::from)
}

pub async fn save_mcp_history_retention_limit(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveHistoryRetentionLimitRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::history::validate_history_retention_limit(body.limit).map_err(AppError::bad_request)?;
    state.app.storage.save_mcp_history_retention_limit(body.limit).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn cleanup_mcp_history_retention(State(state): State<Arc<WebState>>) -> Result<Json<u64>, AppError> {
    state.app.storage.cleanup_mcp_history_retention().await.map(Json).map_err(AppError::from)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMaxRetriesRequest {
    pub max_retries: u32,
}

pub async fn load_max_retries(State(state): State<Arc<WebState>>) -> Result<Json<u32>, AppError> {
    state.app.storage.load_max_retries().await.map(Json).map_err(AppError::from)
}

fn sql_file_upload_max_bytes_from_mb(max_mb: u32) -> u64 {
    u64::from(max_mb).saturating_mul(1024 * 1024)
}

pub async fn load_sql_file_upload_max_bytes(State(state): State<Arc<WebState>>) -> Result<Json<u64>, AppError> {
    let max_mb = state.app.storage.load_sql_file_upload_max_mb().await.map_err(AppError::from)?;
    Ok(Json(sql_file_upload_max_bytes_from_mb(max_mb)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSqlFileUploadMaxMbRequest {
    pub sql_file_upload_max_mb: u32,
}

pub async fn save_sql_file_upload_max_mb(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveSqlFileUploadMaxMbRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_sql_file_upload_max_mb(body.sql_file_upload_max_mb).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn save_max_retries(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveMaxRetriesRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_max_retries(body.max_retries).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn decrypt_config(Json(body): Json<DecryptConfigRequest>) -> Result<Json<String>, AppError> {
    decrypt_config_payload(&body.payload, &body.passphrase).map(Json).map_err(AppError::from)
}

fn decrypt_config_payload(payload: &EncryptedConfigPayload, passphrase: &str) -> Result<String, String> {
    if payload.format != "dbx-encrypted" || payload.version != 1 {
        return Err("Unsupported encrypted config format".to_string());
    }
    let salt = BASE64.decode(&payload.salt).map_err(|_| "wrong_passphrase".to_string())?;
    let iv = BASE64.decode(&payload.iv).map_err(|_| "wrong_passphrase".to_string())?;
    let ciphertext = BASE64.decode(&payload.data).map_err(|_| "wrong_passphrase".to_string())?;
    if iv.len() != 12 {
        return Err("wrong_passphrase".to_string());
    }

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), &salt, CONFIG_PBKDF2_ITERATIONS, &mut key);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "wrong_passphrase".to_string())?;
    let plaintext =
        cipher.decrypt(Nonce::from_slice(&iv), ciphertext.as_ref()).map_err(|_| "wrong_passphrase".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "wrong_passphrase".to_string())
}

#[cfg(test)]
mod tests {
    use super::{decrypt_config_payload, sql_file_upload_max_bytes_from_mb, EncryptedConfigPayload};

    #[test]
    fn preserves_four_gib_sql_file_upload_limit() {
        assert_eq!(sql_file_upload_max_bytes_from_mb(4096), 4096_u64 * 1024 * 1024);
    }

    fn exported_browser_payload() -> EncryptedConfigPayload {
        EncryptedConfigPayload {
            format: "dbx-encrypted".to_string(),
            version: 1,
            salt: "AAECAwQFBgcICQoLDA0ODw==".to_string(),
            iv: "EBESExQVFhcYGRob".to_string(),
            data: "sCyBTex9XqcCCH5mOyJcF/UN9kpnMp+t0VeEtGrJBMt+QyR85kYhUWezuC9yEhM5jF0=".to_string(),
        }
    }

    #[test]
    fn decrypts_browser_exported_config_payload() {
        let plaintext = decrypt_config_payload(&exported_browser_payload(), "passphrase").unwrap();

        assert_eq!(plaintext, r#"{"connections":[{"name":"local"}]}"#);
    }

    #[test]
    fn rejects_wrong_config_passphrase() {
        let error = decrypt_config_payload(&exported_browser_payload(), "wrong").unwrap_err();

        assert_eq!(error, "wrong_passphrase");
    }
}
