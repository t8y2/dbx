use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::connection::AppState;

use super::super::client::client_for_state;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulConfigEntry {
    pub kind: String,
    pub name: String,
    pub modify_index: u64,
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulConfigEntryApply {
    pub kind: String,
    pub name: String,
    pub expected_modify_index: u64,
    pub raw: serde_json::Value,
}

pub async fn consul_mesh_config_list_core(
    state: &AppState,
    connection_id: &str,
    kind: &str,
) -> Result<Vec<ConsulConfigEntry>, String> {
    validate_identifier(kind, "kind")?;
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url(&format!("/v1/config/{}", segment(kind)))?;
    let values: Vec<serde_json::Value> =
        client.request_json(Method::GET, url, None::<&()>, true, "list Service Mesh config entries").await?;
    values.into_iter().map(config_entry_from_raw).collect()
}

pub async fn consul_mesh_config_get_core(
    state: &AppState,
    connection_id: &str,
    kind: &str,
    name: &str,
) -> Result<ConsulConfigEntry, String> {
    validate_identifier(kind, "kind")?;
    validate_identifier(name, "name")?;
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url(&config_path(kind, name))?;
    let value = client.request_json(Method::GET, url, None::<&()>, true, "read Service Mesh config entry").await?;
    config_entry_from_raw(value)
}

pub async fn consul_mesh_config_apply_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulConfigEntryApply,
) -> Result<ConsulConfigEntry, String> {
    super::super::ensure_writable(state, connection_id, "Service Mesh config entry write").await?;
    validate_raw_identity(&request)?;
    let client = client_for_state(state, connection_id).await?;
    let mut url = client.api_url("/v1/config")?;
    url.query_pairs_mut().append_pair("cas", &request.expected_modify_index.to_string());
    let applied: bool = client
        .request_json(Method::PUT, url, Some(&request.raw), false, "apply Service Mesh config entry with CAS")
        .await?;
    if !applied {
        return Err("CONSUL_CAS_CONFLICT: Service Mesh config entry changed after it was loaded".to_string());
    }
    consul_mesh_config_get_core(state, connection_id, &request.kind, &request.name).await
}

pub async fn consul_mesh_config_delete_core(
    state: &AppState,
    connection_id: &str,
    kind: &str,
    name: &str,
    expected_modify_index: u64,
) -> Result<bool, String> {
    super::super::ensure_writable(state, connection_id, "Service Mesh config entry delete").await?;
    validate_identifier(kind, "kind")?;
    validate_identifier(name, "name")?;
    let client = client_for_state(state, connection_id).await?;
    let mut url = client.api_url(&config_path(kind, name))?;
    url.query_pairs_mut().append_pair("cas", &expected_modify_index.to_string());
    let deleted: bool = client
        .request_json(Method::DELETE, url, None::<&()>, false, "delete Service Mesh config entry with CAS")
        .await?;
    if !deleted {
        return Err("CONSUL_CAS_CONFLICT: Service Mesh config entry changed after it was loaded".to_string());
    }
    Ok(true)
}

fn config_entry_from_raw(raw: serde_json::Value) -> Result<ConsulConfigEntry, String> {
    let kind = raw.get("Kind").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let name = raw.get("Name").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let modify_index = raw.get("ModifyIndex").and_then(serde_json::Value::as_u64).unwrap_or(0);
    if kind.is_empty() || name.is_empty() {
        return Err("CONSUL_INVALID_RESPONSE: config entry is missing Kind or Name".to_string());
    }
    Ok(ConsulConfigEntry { kind, name, modify_index, raw })
}

fn validate_raw_identity(request: &ConsulConfigEntryApply) -> Result<(), String> {
    validate_identifier(&request.kind, "kind")?;
    validate_identifier(&request.name, "name")?;
    let object = request.raw.as_object().ok_or("CONSUL_INVALID_REQUEST: config entry raw JSON must be an object")?;
    if object.get("Kind").and_then(serde_json::Value::as_str) != Some(request.kind.as_str())
        || object.get("Name").and_then(serde_json::Value::as_str) != Some(request.name.as_str())
    {
        return Err("CONSUL_INVALID_REQUEST: raw JSON Kind and Name must match the selected resource".to_string());
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 256 {
        Err(format!("CONSUL_INVALID_REQUEST: config entry {label} is invalid"))
    } else {
        Ok(())
    }
}
fn segment(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}
fn config_path(kind: &str, name: &str) -> String {
    format!("/v1/config/{}/{}", segment(kind), segment(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_identity_must_match() {
        let request = ConsulConfigEntryApply {
            kind: "service-defaults".into(),
            name: "api".into(),
            expected_modify_index: 4,
            raw: serde_json::json!({"Kind":"service-defaults","Name":"other"}),
        };
        assert!(validate_raw_identity(&request).is_err());
    }
}
