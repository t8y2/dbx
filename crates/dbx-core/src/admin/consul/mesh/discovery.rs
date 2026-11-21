use super::super::client::client_for_state;
use crate::connection::AppState;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulDiscoveryChain {
    #[serde(default)]
    pub service_name: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub partition: String,
    #[serde(default)]
    pub datacenter: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub start_node: String,
    #[serde(default)]
    pub nodes: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub targets: BTreeMap<String, serde_json::Value>,
}

pub async fn consul_mesh_discovery_chain_core(
    state: &AppState,
    connection_id: &str,
    service: &str,
) -> Result<ConsulDiscoveryChain, String> {
    if service.trim().is_empty() {
        return Err("CONSUL_INVALID_REQUEST: discovery service is required".into());
    }
    let client = client_for_state(state, connection_id).await?;
    let service = percent_encoding::utf8_percent_encode(service, percent_encoding::NON_ALPHANUMERIC);
    let url = client.api_url(&format!("/v1/discovery-chain/{service}"))?;
    client.request_json(Method::GET, url, None::<&()>, true, "compile discovery chain").await
}
