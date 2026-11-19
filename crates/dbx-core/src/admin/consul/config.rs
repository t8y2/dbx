use std::fmt;

use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::models::connection::ConnectionConfig;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ConsulScope {
    pub datacenter: String,
    pub namespace: String,
    pub partition: String,
}

impl ConsulScope {
    pub fn contains_wildcard(&self) -> bool {
        self.datacenter == "*" || self.namespace == "*" || self.partition == "*"
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConsulConsistency {
    #[default]
    Default,
    Stale,
    Consistent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentTarget {
    pub node: String,
    pub address: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ConsulConfig {
    pub base_url: Url,
    pub token: String,
    pub datacenter: String,
    pub namespace: String,
    pub partition: String,
    pub consistency: ConsulConsistency,
    pub tls_skip_verify: bool,
    pub ca_cert_path: String,
    pub client_cert_path: String,
    pub client_key_path: String,
    pub connect_timeout_secs: u64,
    pub request_timeout_secs: u64,
    pub connect_override: Option<(String, u16)>,
    pub operator_snapshot_restore_enabled: bool,
    pub operator_autopilot_write_enabled: bool,
    pub operator_raft_write_enabled: bool,
    pub operator_keyring_write_enabled: bool,
    pub operator_license_write_enabled: bool,
    pub agent_target: Option<ConsulAgentTarget>,
}

impl fmt::Debug for ConsulConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let token = if self.token.is_empty() { "none" } else { "redacted" };
        formatter
            .debug_struct("ConsulConfig")
            .field("base_url", &self.base_url)
            .field("token", &token)
            .field("datacenter", &self.datacenter)
            .field("namespace", &self.namespace)
            .field("partition", &self.partition)
            .field("consistency", &self.consistency)
            .field("tls_skip_verify", &self.tls_skip_verify)
            .field("ca_cert_path", &self.ca_cert_path)
            .field("client_cert_path", &self.client_cert_path)
            .field("client_key_path", &self.client_key_path)
            .field("connect_timeout_secs", &self.connect_timeout_secs)
            .field("request_timeout_secs", &self.request_timeout_secs)
            .field("connect_override", &self.connect_override)
            .field("operator_snapshot_restore_enabled", &self.operator_snapshot_restore_enabled)
            .field("operator_autopilot_write_enabled", &self.operator_autopilot_write_enabled)
            .field("operator_raft_write_enabled", &self.operator_raft_write_enabled)
            .field("operator_keyring_write_enabled", &self.operator_keyring_write_enabled)
            .field("operator_license_write_enabled", &self.operator_license_write_enabled)
            .field("agent_target", &self.agent_target)
            .finish()
    }
}

impl ConsulConfig {
    pub fn scope(&self) -> ConsulScope {
        ConsulScope {
            datacenter: self.datacenter.clone(),
            namespace: self.namespace.clone(),
            partition: self.partition.clone(),
        }
    }

    pub fn from_connection(connection: &ConnectionConfig) -> Result<Self, String> {
        let external = connection.external_config.as_ref();
        let server_addr =
            external_string(external, &["serverAddr", "server_addr"]).unwrap_or_else(|| connection.connection_url());
        let mut base_url =
            Url::parse(server_addr.trim()).map_err(|error| format!("Consul server address is invalid: {error}"))?;
        if !matches!(base_url.scheme(), "http" | "https") {
            return Err("Consul server address must use http or https".to_string());
        }
        if base_url.host_str().is_none() {
            return Err("Consul server address must include a host".to_string());
        }
        if !base_url.username().is_empty() || base_url.password().is_some() {
            return Err("Consul server address must not contain embedded credentials".to_string());
        }
        if base_url.query().is_some() || base_url.fragment().is_some() {
            return Err("Consul server address must not contain a query or fragment".to_string());
        }
        let normalized_path = base_url.path().trim_end_matches('/').to_string();
        base_url.set_path(&normalized_path);

        let consistency = match external_string(external, &["consistency", "consulConsistency", "consul_consistency"])
            .unwrap_or_else(|| "default".to_string())
            .to_ascii_lowercase()
            .as_str()
        {
            "default" | "" => ConsulConsistency::Default,
            "stale" => ConsulConsistency::Stale,
            "consistent" => ConsulConsistency::Consistent,
            value => return Err(format!("Unsupported Consul consistency mode: {value}")),
        };

        let client_cert_path = connection.client_cert_path.trim().to_string();
        let client_key_path = connection.client_key_path.trim().to_string();
        if client_cert_path.is_empty() != client_key_path.is_empty() {
            return Err("Consul client certificate and key must be configured together".to_string());
        }

        Ok(Self {
            base_url,
            token: connection.password.clone(),
            datacenter: external_string(external, &["datacenter", "consulDatacenter", "consul_datacenter"])
                .unwrap_or_default(),
            namespace: external_string(external, &["namespace", "consulNamespace", "consul_namespace"])
                .unwrap_or_default(),
            partition: external_string(external, &["partition", "consulPartition", "consul_partition"])
                .unwrap_or_default(),
            consistency,
            tls_skip_verify: external_bool(
                external,
                &["tlsSkipVerify", "tls_skip_verify", "consulTlsSkipVerify", "consul_tls_skip_verify"],
            )
            .unwrap_or(false),
            ca_cert_path: connection.ca_cert_path.trim().to_string(),
            client_cert_path,
            client_key_path,
            connect_timeout_secs: connection.effective_connect_timeout_secs(),
            request_timeout_secs: connection.effective_query_timeout_secs(),
            connect_override: None,
            operator_snapshot_restore_enabled: external_bool(external, &["consulOperatorSnapshotRestoreEnabled"])
                .unwrap_or(false),
            operator_autopilot_write_enabled: external_bool(external, &["consulOperatorAutopilotWriteEnabled"])
                .unwrap_or(false),
            operator_raft_write_enabled: external_bool(external, &["consulOperatorRaftWriteEnabled"]).unwrap_or(false),
            operator_keyring_write_enabled: external_bool(external, &["consulOperatorKeyringWriteEnabled"])
                .unwrap_or(false),
            operator_license_write_enabled: external_bool(external, &["consulOperatorLicenseWriteEnabled"])
                .unwrap_or(false),
            agent_target: parse_agent_target(external)?,
        })
    }

    pub fn with_connect_override(mut self, host: impl Into<String>, port: u16) -> Self {
        self.connect_override = Some((host.into(), port));
        self
    }
}

fn parse_agent_target(value: Option<&serde_json::Value>) -> Result<Option<ConsulAgentTarget>, String> {
    let Some(raw) = value
        .and_then(serde_json::Value::as_object)
        .and_then(|object| object.get("agentTarget").or_else(|| object.get("agent_target")))
    else {
        return Ok(None);
    };
    let object = raw.as_object().ok_or("Consul agent_target must contain an explicit node and address")?;
    let node = object.get("node").and_then(serde_json::Value::as_str).unwrap_or_default().trim();
    let address = object.get("address").and_then(serde_json::Value::as_str).unwrap_or_default().trim();
    if node.is_empty() || address.is_empty() {
        return Err("Consul agent_target requires both node and address".to_string());
    }
    Ok(Some(ConsulAgentTarget { node: node.to_string(), address: address.to_string() }))
}

fn external_string(value: Option<&serde_json::Value>, keys: &[&str]) -> Option<String> {
    let object = value?.as_object()?;
    keys.iter()
        .find_map(|key| object.get(*key).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn external_bool(value: Option<&serde_json::Value>, keys: &[&str]) -> Option<bool> {
    let object = value?.as_object()?;
    keys.iter().find_map(|key| object.get(*key).and_then(serde_json::Value::as_bool))
}
