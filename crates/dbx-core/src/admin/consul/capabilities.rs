use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};

use crate::connection::AppState;

use super::client::{client_for_state, ConsulClient};
use super::response::decode_json_response;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConsulCapabilityStatus {
    Supported,
    Unsupported,
    Disabled,
    Forbidden,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulCapabilities {
    pub version: Option<String>,
    pub datacenter: Option<String>,
    pub node_name: Option<String>,
    pub server: Option<bool>,
    pub edition: Option<String>,
    pub agent: ConsulCapabilityStatus,
    pub catalog: ConsulCapabilityStatus,
    pub health: ConsulCapabilityStatus,
    pub sessions: ConsulCapabilityStatus,
    pub acl: ConsulCapabilityStatus,
    pub auth_methods: ConsulCapabilityStatus,
    pub binding_rules: ConsulCapabilityStatus,
    pub templated_policies: ConsulCapabilityStatus,
    pub namespaces: ConsulCapabilityStatus,
    pub partitions: ConsulCapabilityStatus,
    pub config_entries: ConsulCapabilityStatus,
    pub intentions: ConsulCapabilityStatus,
    pub peering: ConsulCapabilityStatus,
    pub exported_services: ConsulCapabilityStatus,
    pub prepared_queries: ConsulCapabilityStatus,
    pub events: ConsulCapabilityStatus,
    pub coordinates: ConsulCapabilityStatus,
    pub operator_autopilot: ConsulCapabilityStatus,
    pub operator_raft: ConsulCapabilityStatus,
    pub operator_keyring: ConsulCapabilityStatus,
    pub operator_usage: ConsulCapabilityStatus,
    pub operator_license: ConsulCapabilityStatus,
    pub audit: ConsulCapabilityStatus,
}

#[derive(Debug, Deserialize)]
struct AgentSelfResponse {
    #[serde(rename = "Config")]
    config: AgentSelfConfig,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AgentSelfConfig {
    version: Option<String>,
    datacenter: Option<String>,
    node_name: Option<String>,
    server: Option<bool>,
}

pub async fn consul_capabilities_core(state: &AppState, connection_id: &str) -> Result<ConsulCapabilities, String> {
    let client = client_for_state(state, connection_id).await?;
    let (
        mut capabilities,
        acl,
        auth_methods,
        binding_rules,
        templated_policies,
        namespaces,
        partitions,
        config_entries,
        intentions,
        peering,
        exported_services,
        catalog,
        health,
        sessions,
        prepared_queries,
        events,
        coordinates,
        operator_autopilot,
        operator_raft,
        operator_keyring,
        operator_usage,
        operator_license,
        audit,
    ) = tokio::join!(
        probe_agent(&client),
        probe_acl_endpoint(&client),
        probe_endpoint(&client, "/v1/acl/auth-methods"),
        probe_endpoint(&client, "/v1/acl/binding-rules"),
        probe_endpoint(&client, "/v1/acl/templated-policies"),
        probe_endpoint(&client, "/v1/namespaces"),
        probe_endpoint(&client, "/v1/partitions"),
        probe_endpoint(&client, "/v1/config/service-defaults"),
        probe_endpoint(&client, "/v1/connect/intentions"),
        probe_endpoint(&client, "/v1/peerings"),
        probe_endpoint(&client, "/v1/exported-services"),
        probe_endpoint(&client, "/v1/catalog/datacenters"),
        probe_endpoint(&client, "/v1/health/state/any"),
        probe_endpoint(&client, "/v1/session/list"),
        probe_endpoint(&client, "/v1/query"),
        probe_endpoint(&client, "/v1/event/list"),
        probe_endpoint(&client, "/v1/coordinate/nodes"),
        probe_endpoint(&client, "/v1/operator/autopilot/configuration"),
        probe_endpoint(&client, "/v1/operator/raft/configuration"),
        probe_endpoint(&client, "/v1/operator/keyring"),
        probe_endpoint(&client, "/v1/operator/usage"),
        probe_endpoint(&client, "/v1/operator/license"),
        probe_audit_endpoint(&client),
    );
    capabilities.acl = acl;
    capabilities.auth_methods = auth_methods;
    capabilities.binding_rules = binding_rules;
    capabilities.templated_policies = templated_policies;
    capabilities.namespaces = namespaces;
    capabilities.partitions = partitions;
    capabilities.config_entries = config_entries;
    capabilities.intentions = intentions;
    capabilities.peering = peering;
    capabilities.exported_services = exported_services;
    capabilities.catalog = catalog;
    capabilities.health = health;
    capabilities.sessions = sessions;
    capabilities.prepared_queries = prepared_queries;
    capabilities.events = events;
    capabilities.coordinates = coordinates;
    capabilities.operator_autopilot = operator_autopilot;
    capabilities.operator_raft = operator_raft;
    capabilities.operator_keyring = operator_keyring;
    capabilities.operator_usage = operator_usage;
    capabilities.operator_license = operator_license;
    capabilities.audit = audit;
    capabilities.edition = infer_edition(capabilities.namespaces, capabilities.partitions);
    Ok(capabilities)
}

async fn probe_agent(client: &ConsulClient) -> ConsulCapabilities {
    let Ok(url) = client.api_url("/v1/agent/self") else {
        return ConsulCapabilities::default();
    };
    let Ok(response) = client.send(Method::GET, url, None).await else {
        return ConsulCapabilities::default();
    };
    let status = capability_status(response.status());
    if status != ConsulCapabilityStatus::Supported {
        return ConsulCapabilities { agent: status, ..ConsulCapabilities::default() };
    }
    let Ok(response) = decode_json_response::<AgentSelfResponse>(response, "probe Consul agent").await else {
        return ConsulCapabilities::default();
    };
    ConsulCapabilities {
        version: response.config.version,
        datacenter: response.config.datacenter,
        node_name: response.config.node_name,
        server: response.config.server,
        agent: ConsulCapabilityStatus::Supported,
        ..ConsulCapabilities::default()
    }
}

async fn probe_endpoint(client: &ConsulClient, path: &str) -> ConsulCapabilityStatus {
    let Ok(mut url) = client.api_url(path) else {
        return ConsulCapabilityStatus::Unknown;
    };
    client.append_scope(&mut url, true);
    match client.send(Method::GET, url, None).await {
        Ok(response) => capability_status(response.status()),
        Err(_) => ConsulCapabilityStatus::Unknown,
    }
}

async fn probe_acl_endpoint(client: &ConsulClient) -> ConsulCapabilityStatus {
    let Ok(mut url) = client.api_url("/v1/acl/token/self") else {
        return ConsulCapabilityStatus::Unknown;
    };
    client.append_scope(&mut url, true);
    match client.send(Method::GET, url, None).await {
        Ok(response) if response.status() == StatusCode::UNAUTHORIZED => {
            let body = response.text().await.unwrap_or_default();
            if is_acl_support_disabled(&body) {
                ConsulCapabilityStatus::Disabled
            } else {
                ConsulCapabilityStatus::Forbidden
            }
        }
        Ok(response) => capability_status(response.status()),
        Err(_) => ConsulCapabilityStatus::Unknown,
    }
}

async fn probe_audit_endpoint(client: &ConsulClient) -> ConsulCapabilityStatus {
    let Ok(mut url) = client.api_url("/v1/operator/audit-hash") else {
        return ConsulCapabilityStatus::Unknown;
    };
    client.append_scope(&mut url, true);
    match client.send(Method::POST, url, Some(br#"{"Input":"dbx-capability-probe"}"#.to_vec())).await {
        Ok(response) => capability_status(response.status()),
        Err(_) => ConsulCapabilityStatus::Unknown,
    }
}

fn capability_status(status: StatusCode) -> ConsulCapabilityStatus {
    match status {
        status if status.is_success() => ConsulCapabilityStatus::Supported,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ConsulCapabilityStatus::Forbidden,
        StatusCode::NOT_FOUND => ConsulCapabilityStatus::Unsupported,
        _ => ConsulCapabilityStatus::Unknown,
    }
}

fn is_acl_support_disabled(body: &str) -> bool {
    body.trim().eq_ignore_ascii_case("ACL support disabled")
}

fn infer_edition(namespaces: ConsulCapabilityStatus, partitions: ConsulCapabilityStatus) -> Option<String> {
    if matches!(namespaces, ConsulCapabilityStatus::Supported)
        || matches!(partitions, ConsulCapabilityStatus::Supported)
    {
        Some("enterprise".to_string())
    } else if matches!(namespaces, ConsulCapabilityStatus::Unsupported)
        && matches!(partitions, ConsulCapabilityStatus::Unsupported)
    {
        Some("community".to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_an_explicitly_disabled_acl_subsystem() {
        assert!(is_acl_support_disabled("ACL support disabled\n"));
        assert!(!is_acl_support_disabled("Permission denied"));
        assert_eq!(capability_status(StatusCode::UNAUTHORIZED), ConsulCapabilityStatus::Forbidden);
    }
}
