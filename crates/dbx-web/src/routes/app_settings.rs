use std::sync::Arc;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use dbx_core::ldap_login::LdapLoginSettings;
use dbx_core::storage::{McpGlobalPolicy, McpGlobalPolicyState};
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::error::AppError;
use crate::state::{LdapLoginBackend, WebState};

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

pub async fn save_mcp_global_policy(
    State(state): State<Arc<WebState>>,
    Json(policy): Json<McpGlobalPolicy>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_mcp_global_policy(&policy).await.map_err(AppError::from)?;
    Ok(Json(()))
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
#[serde(rename_all = "camelCase")]
pub struct SaveMaxRetriesRequest {
    pub max_retries: u32,
}

pub async fn load_max_retries(State(state): State<Arc<WebState>>) -> Result<Json<u32>, AppError> {
    state.app.storage.load_max_retries().await.map(Json).map_err(AppError::from)
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LdapLoginConfigResponse {
    #[serde(flatten)]
    pub settings: LdapLoginSettings,
    /// Whether a service-account password is currently stored. The password
    /// itself is never returned to the client.
    pub service_account_password_set: bool,
}

/// Return the current LDAP login configuration (service-account password
/// masked) so the settings page can render the form.
pub async fn get_ldap_login_config(
    State(state): State<Arc<WebState>>,
) -> Result<Json<LdapLoginConfigResponse>, StatusCode> {
    let settings = state
        .app
        .storage
        .load_ldap_login_settings()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .unwrap_or_default();
    let service_account_password_set = settings.has_service_account_password();
    Ok(Json(LdapLoginConfigResponse { settings: settings.redacted(), service_account_password_set }))
}

/// When the client leaves the service-account password blank and one is
/// already stored, reuse the stored password so an empty field does not wipe
/// the configured credential.
async fn merge_stored_service_account_password(state: &WebState, body: &mut LdapLoginSettings) {
    if body.service_account_password.is_empty() {
        if let Ok(Some(current)) = state.app.storage.load_ldap_login_settings().await {
            if current.has_service_account_password() {
                body.service_account_password = current.service_account_password;
            }
        }
    }
}

/// Persist the LDAP login configuration from the settings page and reload
/// the runtime backend. When the client leaves the service-account password
/// blank and one is already stored, the existing password is preserved.
pub async fn save_ldap_login_config(
    State(state): State<Arc<WebState>>,
    Json(mut body): Json<LdapLoginSettings>,
) -> Result<Response, StatusCode> {
    merge_stored_service_account_password(&state, &mut body).await;
    // Keep the name trimmed so the login page never renders a blank label.
    body.name = body.name.trim().to_string();

    state.app.storage.save_ldap_login_settings(&body).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Rebuild the runtime backend so the new config takes effect immediately.
    // When LDAP login is enabled but the config is invalid, reject the save
    // so the settings page can show the problem instead of silently
    // disabling login.
    if body.enabled {
        let backend = match body.build_login() {
            Ok((mode, login)) => {
                let name = if body.name.is_empty() { "LDAP".to_string() } else { body.name.clone() };
                Some(LdapLoginBackend { name, mode, config: Arc::new(login) })
            }
            Err(err) => {
                return Ok(
                    (StatusCode::BAD_REQUEST, Json(serde_json::json!({"ok": false, "error": err}))).into_response()
                );
            }
        };
        *state.ldap_login.write().await = backend;
    } else {
        *state.ldap_login.write().await = None;
    }

    Ok((StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response())
}

/// Validate + test the supplied LDAP login config without saving it. When the
/// client leaves the service-account password blank and one is already stored,
/// the stored password is used (mirroring [`save_ldap_login_config`]).
pub async fn test_ldap_login_config(
    State(state): State<Arc<WebState>>,
    Json(mut body): Json<LdapLoginSettings>,
) -> Response {
    merge_stored_service_account_password(&state, &mut body).await;
    match dbx_core::ldap_login::test_connection(&body).await {
        Ok(message) => Json(serde_json::json!({"ok": true, "message": message})).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"ok": false, "error": err}))).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::{decrypt_config_payload, EncryptedConfigPayload};

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
