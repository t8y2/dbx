use super::super::client::client_for_state;
use super::super::ConsulSecret;
use crate::connection::AppState;
use reqwest::Method;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulPeering {
    #[serde(rename = "ID", default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub partition: String,
    #[serde(default)]
    pub state: String,
    #[serde(rename = "PeerID", default)]
    pub peer_id: String,
    #[serde(default)]
    pub peer_server_name: String,
    #[serde(rename = "PeerCAPems", default)]
    pub peer_ca_pems: Vec<String>,
    #[serde(default)]
    pub peer_server_addresses: Vec<String>,
    #[serde(default)]
    pub imported_services: Vec<String>,
    #[serde(default)]
    pub exported_services: Vec<String>,
    #[serde(default)]
    pub create_index: u64,
    #[serde(default)]
    pub modify_index: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulPeeringGenerateRequest {
    pub peer_name: String,
    #[serde(default)]
    pub partition: String,
    #[serde(default)]
    pub meta: serde_json::Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulPeeringToken {
    pub peering_token: ConsulSecret,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulPeeringEstablishRequest {
    pub peer_name: String,
    pub peering_token: ConsulSecret,
    #[serde(default)]
    pub partition: String,
}

pub async fn consul_mesh_peering_list_core(
    state: &AppState,
    connection_id: &str,
) -> Result<Vec<ConsulPeering>, String> {
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url("/v1/peerings")?;
    client.request_json(Method::GET, url, None::<&()>, true, "list peerings").await
}
pub async fn consul_mesh_peering_get_core(
    state: &AppState,
    connection_id: &str,
    name: &str,
) -> Result<ConsulPeering, String> {
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url(&format!("/v1/peering/{}", segment(name)))?;
    client.request_json(Method::GET, url, None::<&()>, true, "read peering").await
}
pub async fn consul_mesh_peering_generate_token_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulPeeringGenerateRequest,
) -> Result<ConsulPeeringToken, String> {
    super::super::ensure_writable(state, connection_id, "peering token generation").await?;
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url("/v1/peering/token")?;
    client.request_json(Method::POST, url, Some(&request), false, "generate peering token").await
}
pub async fn consul_mesh_peering_establish_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulPeeringEstablishRequest,
) -> Result<ConsulPeering, String> {
    super::super::ensure_writable(state, connection_id, "peering establish").await?;
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url("/v1/peering/establish")?;
    client.request_json(Method::POST, url, Some(&request), false, "establish peering").await
}
pub async fn consul_mesh_peering_delete_core(
    state: &AppState,
    connection_id: &str,
    name: &str,
) -> Result<bool, String> {
    super::super::ensure_writable(state, connection_id, "peering delete").await?;
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url(&format!("/v1/peering/{}", segment(name)))?;
    client.send_json(Method::DELETE, url, None::<&()>, false, "delete peering").await?;
    Ok(true)
}
fn segment(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}
