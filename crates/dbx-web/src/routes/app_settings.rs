use std::sync::Arc;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use axum::extract::State;
use axum::Json;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use dbx_core::storage::{McpGlobalPolicy, McpGlobalPolicyState};
use pbkdf2::pbkdf2_hmac;
use serde::Deserialize;
use sha2::Sha256;

use crate::error::AppError;
use crate::state::WebState;

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
    let ids = state.app.storage.load_pinned_tree_node_ids().await.map_err(AppError)?;
    Ok(Json(ids))
}

pub async fn save_pinned_tree_node_ids(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SavePinnedTreeNodeIdsRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_pinned_tree_node_ids(&body.ids).await.map_err(AppError)?;
    Ok(Json(()))
}

pub async fn load_mcp_global_policy(
    State(state): State<Arc<WebState>>,
) -> Result<Json<McpGlobalPolicyState>, AppError> {
    state.app.storage.load_mcp_global_policy().await.map(Json).map_err(AppError)
}

pub async fn save_mcp_global_policy(
    State(state): State<Arc<WebState>>,
    Json(policy): Json<McpGlobalPolicy>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_mcp_global_policy(&policy).await.map_err(AppError)?;
    Ok(Json(()))
}

pub async fn decrypt_config(Json(body): Json<DecryptConfigRequest>) -> Result<Json<String>, AppError> {
    decrypt_config_payload(&body.payload, &body.passphrase).map(Json).map_err(AppError)
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
