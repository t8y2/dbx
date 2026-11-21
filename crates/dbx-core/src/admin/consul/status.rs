use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::connection::AppState;

use super::client::{client_for_state, ConsulClient};
use super::response::{decode_json_response, ensure_success};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulStatus {
    pub leader: String,
    pub peers: Vec<String>,
}

impl ConsulClient {
    pub async fn status_leader(&self) -> Result<String, String> {
        let url = self.api_url("/v1/status/leader")?;
        let response =
            ensure_success(self.send(Method::GET, url, None).await?, "read Consul leader", self.token()).await?;
        decode_json_response(response, "read Consul leader").await
    }

    pub async fn status_peers(&self) -> Result<Vec<String>, String> {
        let url = self.api_url("/v1/status/peers")?;
        let response =
            ensure_success(self.send(Method::GET, url, None).await?, "read Consul peers", self.token()).await?;
        decode_json_response(response, "read Consul peers").await
    }
}

pub async fn consul_status_leader_core(state: &AppState, connection_id: &str) -> Result<String, String> {
    client_for_state(state, connection_id).await?.status_leader().await
}

pub async fn consul_status_peers_core(state: &AppState, connection_id: &str) -> Result<Vec<String>, String> {
    client_for_state(state, connection_id).await?.status_peers().await
}
