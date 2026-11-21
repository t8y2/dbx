use super::super::client::client_for_state;
use super::config_entries::{consul_mesh_config_apply_core, ConsulConfigEntry, ConsulConfigEntryApply};
use crate::connection::AppState;
use reqwest::Method;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulExportedService {
    #[serde(default)]
    pub service: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub partition: String,
    #[serde(default)]
    pub consumers: Vec<serde_json::Value>,
}

pub async fn consul_mesh_exported_services_list_core(
    state: &AppState,
    connection_id: &str,
) -> Result<Vec<ConsulExportedService>, String> {
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url("/v1/exported-services")?;
    client.request_json(Method::GET, url, None::<&()>, true, "list exported services").await
}

pub async fn consul_mesh_exported_services_apply_core(
    state: &AppState,
    connection_id: &str,
    name: &str,
    expected_modify_index: u64,
    raw: serde_json::Value,
) -> Result<ConsulConfigEntry, String> {
    consul_mesh_config_apply_core(
        state,
        connection_id,
        ConsulConfigEntryApply { kind: "exported-services".into(), name: name.into(), expected_modify_index, raw },
    )
    .await
}
