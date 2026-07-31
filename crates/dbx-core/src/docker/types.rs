use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

fn null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerConnectionInfo {
    pub engine_version: String,
    pub api_version: String,
    pub minimum_api_version: Option<String>,
    pub operating_system: Option<String>,
    pub architecture: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerEngineSummary {
    pub engine_version: Option<String>,
    pub api_version: Option<String>,
    pub minimum_api_version: Option<String>,
    pub operating_system: Option<String>,
    pub architecture: Option<String>,
    pub kernel_version: Option<String>,
    pub storage_driver: Option<String>,
    pub containers: Option<u64>,
    pub containers_running: Option<u64>,
    pub containers_paused: Option<u64>,
    pub containers_stopped: Option<u64>,
    pub images: Option<u64>,
    pub docker_root_dir: Option<String>,
    pub security_options: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerEngineDetails {
    pub version: Value,
    pub info: Value,
    pub summary: DockerEngineSummary,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct DockerVersionResponse {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub api_version: String,
    #[serde(default)]
    pub min_api_version: Option<String>,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub arch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerPort {
    pub ip: Option<String>,
    pub private_port: u16,
    pub public_port: Option<u16>,
    pub port_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub names: Vec<String>,
    pub image: String,
    pub image_id: String,
    pub command: String,
    pub created: i64,
    pub state: String,
    pub status: String,
    pub ports: Vec<DockerPort>,
    pub labels: HashMap<String, String>,
    pub network_ips: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct DockerContainerWire {
    #[serde(default)]
    pub id: String,
    #[serde(default, deserialize_with = "null_default")]
    pub names: Vec<String>,
    #[serde(default)]
    pub image: String,
    #[serde(default)]
    pub image_id: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub created: i64,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub status: String,
    #[serde(default, deserialize_with = "null_default")]
    pub ports: Vec<DockerPortWire>,
    #[serde(default, deserialize_with = "null_default")]
    pub labels: HashMap<String, String>,
    #[serde(default)]
    pub network_settings: DockerNetworkSettingsWire,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct DockerPortWire {
    pub ip: Option<String>,
    #[serde(default)]
    pub private_port: u16,
    pub public_port: Option<u16>,
    #[serde(rename = "Type", default)]
    pub port_type: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct DockerNetworkSettingsWire {
    #[serde(default, deserialize_with = "null_default")]
    pub networks: HashMap<String, DockerEndpointWire>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct DockerEndpointWire {
    #[serde(default)]
    pub ip_address: String,
}

impl From<DockerContainerWire> for DockerContainer {
    fn from(value: DockerContainerWire) -> Self {
        Self {
            id: value.id,
            names: value.names,
            image: value.image,
            image_id: value.image_id,
            command: value.command,
            created: value.created,
            state: value.state,
            status: value.status,
            ports: value
                .ports
                .into_iter()
                .map(|port| DockerPort {
                    ip: port.ip,
                    private_port: port.private_port,
                    public_port: port.public_port,
                    port_type: port.port_type,
                })
                .collect(),
            labels: value.labels,
            network_ips: value
                .network_settings
                .networks
                .into_iter()
                .map(|(name, endpoint)| (name, endpoint.ip_address))
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerImage {
    pub id: String,
    pub repo_tags: Vec<String>,
    pub repo_digests: Vec<String>,
    pub created: i64,
    pub size: u64,
    pub labels: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct DockerImageWire {
    #[serde(default)]
    pub id: String,
    #[serde(default, deserialize_with = "null_default")]
    pub repo_tags: Vec<String>,
    #[serde(default, deserialize_with = "null_default")]
    pub repo_digests: Vec<String>,
    #[serde(default)]
    pub created: i64,
    #[serde(default)]
    pub size: u64,
    #[serde(default, deserialize_with = "null_default")]
    pub labels: HashMap<String, String>,
}

impl From<DockerImageWire> for DockerImage {
    fn from(value: DockerImageWire) -> Self {
        Self {
            id: value.id,
            repo_tags: value.repo_tags,
            repo_digests: value.repo_digests,
            created: value.created,
            size: value.size,
            labels: value.labels,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerVolume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub scope: String,
    pub labels: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct DockerVolumeWire {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub driver: String,
    #[serde(default)]
    pub mountpoint: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default, deserialize_with = "null_default")]
    pub labels: HashMap<String, String>,
}

impl From<DockerVolumeWire> for DockerVolume {
    fn from(value: DockerVolumeWire) -> Self {
        Self {
            name: value.name,
            driver: value.driver,
            mountpoint: value.mountpoint,
            scope: value.scope,
            labels: value.labels,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct DockerVolumeListWire {
    #[serde(default, deserialize_with = "null_default")]
    pub volumes: Vec<DockerVolumeWire>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerNetwork {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub internal: bool,
    pub attachable: bool,
    pub labels: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct DockerNetworkWire {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub driver: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub internal: bool,
    #[serde(default)]
    pub attachable: bool,
    #[serde(default, deserialize_with = "null_default")]
    pub labels: HashMap<String, String>,
}

impl From<DockerNetworkWire> for DockerNetwork {
    fn from(value: DockerNetworkWire) -> Self {
        Self {
            id: value.id,
            name: value.name,
            driver: value.driver,
            scope: value.scope,
            internal: value.internal,
            attachable: value.attachable,
            labels: value.labels,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{DockerContainerAction, DockerImageWire, DockerVolumeListWire};

    #[test]
    fn accepts_nullable_fields_from_older_and_newer_engines() {
        let image: DockerImageWire = serde_json::from_value(serde_json::json!({
            "Id": "sha256:abc",
            "RepoTags": null,
            "RepoDigests": null,
            "Labels": null,
            "FutureField": {"ignored": true}
        }))
        .unwrap();
        assert!(image.repo_tags.is_empty());
        assert!(image.repo_digests.is_empty());
        assert!(image.labels.is_empty());

        let volumes: DockerVolumeListWire =
            serde_json::from_value(serde_json::json!({"Volumes": null, "Warnings": null})).unwrap();
        assert!(volumes.volumes.is_empty());
    }

    #[test]
    fn lifecycle_actions_keep_lowercase_wire_values() {
        assert_eq!(serde_json::to_string(&DockerContainerAction::Pause).unwrap(), "\"pause\"");
        assert!(matches!(
            serde_json::from_str::<DockerContainerAction>("\"unpause\"").unwrap(),
            DockerContainerAction::Unpause
        ));
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DockerContainerAction {
    Start,
    Pause,
    Unpause,
    Stop,
    Restart,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerPortBinding {
    pub container_port: u16,
    #[serde(default = "default_port_protocol")]
    pub protocol: String,
    #[serde(default)]
    pub host_ip: String,
    pub host_port: Option<u16>,
}

fn default_port_protocol() -> String {
    "tcp".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerMountInput {
    #[serde(rename = "type")]
    pub mount_type: String,
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerCreateContainerRequest {
    pub name: String,
    pub image: String,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub environment: Vec<String>,
    #[serde(default)]
    pub ports: Vec<DockerPortBinding>,
    #[serde(default)]
    pub mounts: Vec<DockerMountInput>,
    #[serde(default)]
    pub labels: HashMap<String, String>,
    pub network: Option<String>,
    #[serde(default)]
    pub restart_policy: String,
    #[serde(default)]
    pub start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerComposeApplyRequest {
    pub project_name: String,
    pub content: String,
    #[serde(default)]
    pub replace_existing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerComposeApplyResult {
    pub container_ids: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerCreateContainerResult {
    pub id: String,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerRegistryAuth {
    #[serde(default)]
    pub server_address: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerCreateVolumeRequest {
    pub name: String,
    #[serde(default = "default_volume_driver")]
    pub driver: String,
    #[serde(default)]
    pub labels: HashMap<String, String>,
    #[serde(default)]
    pub driver_options: HashMap<String, String>,
}

fn default_volume_driver() -> String {
    "local".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerCreateNetworkRequest {
    pub name: String,
    #[serde(default = "default_network_driver")]
    pub driver: String,
    #[serde(default)]
    pub internal: bool,
    #[serde(default)]
    pub attachable: bool,
    pub subnet: Option<String>,
    pub gateway: Option<String>,
}

fn default_network_driver() -> String {
    "bridge".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerCreateNetworkResult {
    pub id: String,
    #[serde(default)]
    pub warning: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerLogOptions {
    #[serde(default = "default_log_tail")]
    pub tail: usize,
    #[serde(default)]
    pub timestamps: bool,
}

fn default_log_tail() -> usize {
    500
}

impl Default for DockerLogOptions {
    fn default() -> Self {
        Self { tail: default_log_tail(), timestamps: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerFileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerFilePreview {
    pub path: String,
    pub content: String,
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerProgressEvent {
    pub session_id: String,
    pub status: String,
    pub message: String,
    pub current: Option<u64>,
    pub total: Option<u64>,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerStats {
    pub container_id: String,
    pub read_at: String,
    pub cpu_percent: f64,
    pub memory_usage: u64,
    pub memory_limit: u64,
    pub memory_percent: f64,
    pub network_rx: u64,
    pub network_tx: u64,
    pub block_read: u64,
    pub block_write: u64,
}
