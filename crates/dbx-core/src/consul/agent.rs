use std::collections::BTreeMap;
use std::net::IpAddr;

use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};

use crate::connection::AppState;

use super::catalog::{encode_segment, ConsulServiceAddress, ConsulServiceWeights};
use super::client::{client_for_state, ensure_writable_core, ConsulClient};
use super::config::ConsulAgentTarget;
use super::health::ConsulHealthCheck;
use super::response::{decode_json_response, ensure_success};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentIdentity {
    pub node: String,
    pub address: String,
    pub datacenter: String,
    pub version: Option<String>,
    pub server: Option<bool>,
    pub revision: Option<String>,
    pub segment: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AgentSelfWire {
    #[serde(rename = "Config")]
    config: AgentSelfConfigWire,
    #[serde(rename = "Member")]
    member: AgentMemberWire,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AgentSelfConfigWire {
    #[serde(default)]
    node_name: String,
    #[serde(default)]
    datacenter: String,
    version: Option<String>,
    server: Option<bool>,
    revision: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulAgentMember {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub addr: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub tags: BTreeMap<String, String>,
    #[serde(default)]
    pub status: u8,
    #[serde(default)]
    pub protocol_min: u8,
    #[serde(default)]
    pub protocol_max: u8,
    #[serde(default)]
    pub protocol_cur: u8,
    #[serde(default)]
    pub delegate_min: u8,
    #[serde(default)]
    pub delegate_max: u8,
    #[serde(default)]
    pub delegate_cur: u8,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AgentMemberWire {
    #[serde(default)]
    addr: String,
    #[serde(default)]
    tags: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulAgentMetric {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub value: f64,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulAgentMetrics {
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub gauges: Vec<ConsulAgentMetric>,
    #[serde(default)]
    pub counters: Vec<ConsulAgentMetric>,
    #[serde(default)]
    pub samples: Vec<ConsulAgentMetric>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulAgentService {
    #[serde(default)]
    pub kind: String,
    #[serde(default, rename = "ID", alias = "Id")]
    pub id: String,
    #[serde(default)]
    pub service: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub meta: BTreeMap<String, String>,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub tagged_addresses: BTreeMap<String, ConsulServiceAddress>,
    #[serde(default)]
    pub weights: ConsulServiceWeights,
    #[serde(default)]
    pub enable_tag_override: bool,
    #[serde(default)]
    pub datacenter: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentServiceRegistration {
    pub id: String,
    pub name: String,
    pub tags: Vec<String>,
    pub address: String,
    pub port: u16,
    pub meta: BTreeMap<String, String>,
    pub weights: ConsulServiceWeights,
    pub kind: String,
    pub enable_tag_override: bool,
    #[serde(default)]
    pub tagged_addresses: BTreeMap<String, ConsulServiceAddress>,
    #[serde(default)]
    pub ports: Vec<ConsulAgentServicePort>,
    pub proxy: Option<ConsulAgentProxyRegistration>,
    #[serde(default)]
    pub connect: Option<ConsulAgentConnectRegistration>,
    pub checks: Vec<ConsulAgentCheckRegistration>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentServicePort {
    pub name: String,
    pub port: u16,
    pub default: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentConnectRegistration {
    pub native: bool,
    #[serde(default)]
    pub sidecar_service: Option<Box<ConsulAgentServiceRegistration>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentProxyRegistration {
    pub destination_service_name: String,
    pub destination_service_id: String,
    pub local_service_address: String,
    pub local_service_port: u16,
    #[serde(default)]
    pub local_service_ports: Vec<String>,
    #[serde(default)]
    pub local_service_socket_path: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub transparent_proxy: Option<ConsulAgentTransparentProxy>,
    #[serde(default)]
    pub config: BTreeMap<String, serde_json::Value>,
    pub upstreams: Vec<ConsulAgentUpstream>,
    #[serde(default)]
    pub mesh_gateway: Option<ConsulAgentMeshGateway>,
    #[serde(default)]
    pub expose: Option<ConsulAgentExpose>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentTransparentProxy {
    pub outbound_listener_port: u16,
    pub dialed_directly: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentMeshGateway {
    pub mode: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentExpose {
    pub checks: bool,
    #[serde(default)]
    pub paths: Vec<ConsulAgentExposePath>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentExposePath {
    pub path: String,
    pub protocol: String,
    pub local_path_port: u16,
    pub listener_port: u16,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentUpstream {
    pub destination_type: String,
    pub destination_name: String,
    #[serde(default)]
    pub destination_port: u16,
    #[serde(default)]
    pub destination_namespace: String,
    #[serde(default)]
    pub destination_partition: String,
    #[serde(default)]
    pub destination_peer: String,
    pub local_bind_address: String,
    pub local_bind_port: u16,
    #[serde(default)]
    pub local_bind_socket_path: String,
    #[serde(default)]
    pub local_bind_socket_mode: String,
    pub datacenter: String,
    #[serde(default)]
    pub mesh_gateway: Option<ConsulAgentMeshGateway>,
    #[serde(default)]
    pub config: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentCheckRegistration {
    pub id: String,
    pub name: String,
    pub notes: String,
    pub service_id: String,
    pub status: String,
    pub definition: ConsulAgentCheckDefinition,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConsulAgentCheckDefinition {
    Http { url: String, method: String, interval: String, timeout: String, tls_skip_verify: bool },
    Tcp { address: String, interval: String, timeout: String },
    Grpc { address: String, interval: String, timeout: String, tls: bool },
    Ttl { ttl: String },
    Docker { container_id: String, shell: String, args: Vec<String>, interval: String, timeout: String },
    Script { args: Vec<String>, interval: String, timeout: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConsulCheckStatus {
    Passing,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAgentWriteResult {
    pub target: ConsulAgentIdentity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentWritePermission {
    Service,
    Node,
}

impl ConsulClient {
    pub async fn agent_self(&self) -> Result<ConsulAgentIdentity, String> {
        let url = self.api_url("/v1/agent/self")?;
        let response =
            ensure_success(self.send(Method::GET, url, None).await?, "read Consul agent identity", self.token())
                .await?;
        let wire = decode_json_response::<AgentSelfWire>(response, "read Consul agent identity").await?;
        Ok(ConsulAgentIdentity {
            node: wire.config.node_name,
            address: wire.member.addr,
            datacenter: wire.config.datacenter,
            version: wire.config.version,
            server: wire.config.server,
            revision: wire.config.revision,
            segment: wire.member.tags.get("segment").cloned(),
        })
    }

    pub async fn agent_members(&self, wan: bool, segment: Option<&str>) -> Result<Vec<ConsulAgentMember>, String> {
        let mut url = self.api_url("/v1/agent/members")?;
        {
            let mut query = url.query_pairs_mut();
            if wan {
                query.append_pair("wan", "true");
            }
            if let Some(segment) = segment.map(str::trim).filter(|value| !value.is_empty()) {
                query.append_pair("segment", segment);
            }
        }
        let response =
            ensure_success(self.send(Method::GET, url, None).await?, "list Consul agent members", self.token()).await?;
        decode_json_response(response, "list Consul agent members").await
    }

    pub async fn agent_metrics(&self) -> Result<ConsulAgentMetrics, String> {
        let url = self.api_url("/v1/agent/metrics")?;
        let response =
            ensure_success(self.send(Method::GET, url, None).await?, "read Consul agent metrics", self.token()).await?;
        decode_json_response(response, "read Consul agent metrics").await
    }

    pub async fn agent_services(&self) -> Result<BTreeMap<String, ConsulAgentService>, String> {
        let mut url = self.api_url("/v1/agent/services")?;
        self.append_scope(&mut url, true);
        let response =
            ensure_success(self.send(Method::GET, url, None).await?, "list local Consul services", self.token())
                .await?;
        decode_json_response(response, "list local Consul services").await
    }

    pub async fn agent_service(&self, id: &str) -> Result<ConsulAgentService, String> {
        let mut url = self.api_url(&format!("/v1/agent/service/{}", encode_segment(required(id, "service id")?)))?;
        self.append_scope(&mut url, true);
        let response =
            ensure_success(self.send(Method::GET, url, None).await?, "read local Consul service", self.token()).await?;
        decode_json_response(response, "read local Consul service").await
    }

    pub async fn agent_checks(&self) -> Result<BTreeMap<String, ConsulHealthCheck>, String> {
        let mut url = self.api_url("/v1/agent/checks")?;
        self.append_scope(&mut url, true);
        let response =
            ensure_success(self.send(Method::GET, url, None).await?, "list local Consul checks", self.token()).await?;
        decode_json_response(response, "list local Consul checks").await
    }

    pub async fn validate_configured_agent_target(&self) -> Result<ConsulAgentIdentity, String> {
        if self.config().connect_override.is_some() {
            return Err(
                "CONSUL_AGENT_TARGET_TRANSPORT_UNSAFE: Agent writes are disabled through Transport Layer routing"
                    .to_string(),
            );
        }
        let ConsulAgentTarget { node, address } = self.config().agent_target.as_ref().ok_or(
            "CONSUL_AGENT_TARGET_REQUIRED: Configure an explicit Agent node and direct address before writing",
        )?;
        let request_host = self.config().base_url.host_str().unwrap_or_default();
        if request_host != "localhost" && request_host.parse::<IpAddr>().is_err() {
            return Err("CONSUL_AGENT_TARGET_LOAD_BALANCED: Agent writes require a literal IP or localhost endpoint, not a DNS/load-balanced host".to_string());
        }
        if !same_address(request_host, address) {
            return Err(
                "CONSUL_AGENT_TARGET_MISMATCH: Configured Agent address does not match the direct connection endpoint"
                    .to_string(),
            );
        }
        let identity = self.agent_self().await?;
        if identity.node != *node {
            return Err(format!(
                "CONSUL_AGENT_TARGET_MISMATCH: Expected Agent node '{node}', but the endpoint returned '{}'",
                identity.node
            ));
        }
        Ok(identity)
    }

    async fn agent_write_json(
        &self,
        path: &str,
        body: Option<serde_json::Value>,
        action: &str,
        permission: AgentWritePermission,
    ) -> Result<ConsulAgentWriteResult, String> {
        let body = encode_agent_write_body(body, action)?;
        let target = self.validate_configured_agent_target().await?;
        self.agent_write_body_for_target(path, body, action, permission, target).await
    }

    async fn agent_write_json_for_target(
        &self,
        path: &str,
        body: Option<serde_json::Value>,
        action: &str,
        permission: AgentWritePermission,
        target: ConsulAgentIdentity,
    ) -> Result<ConsulAgentWriteResult, String> {
        let body = encode_agent_write_body(body, action)?;
        self.agent_write_body_for_target(path, body, action, permission, target).await
    }

    async fn agent_write_body_for_target(
        &self,
        path: &str,
        body: Option<Vec<u8>>,
        action: &str,
        permission: AgentWritePermission,
        target: ConsulAgentIdentity,
    ) -> Result<ConsulAgentWriteResult, String> {
        let mut url = self.api_url(path)?;
        self.append_scope(&mut url, false);
        ensure_agent_write_success(self.send(Method::PUT, url, body).await?, action, permission, self.token()).await?;
        Ok(ConsulAgentWriteResult { target })
    }

    pub(super) async fn register_agent_service(
        &self,
        registration: ConsulAgentServiceRegistration,
    ) -> Result<ConsulAgentWriteResult, String> {
        required(&registration.name, "service name")?;
        if registration.port > 0 && registration.address.trim().is_empty() {
            // Empty is valid and means the agent address. Keep it explicit in the generated DTO.
        }
        let body = service_registration_json(registration)?;
        self.agent_write_json(
            "/v1/agent/service/register",
            Some(body),
            "register local Consul service",
            AgentWritePermission::Service,
        )
        .await
    }

    pub(super) async fn deregister_agent_service(&self, id: &str) -> Result<ConsulAgentWriteResult, String> {
        self.agent_write_json(
            &format!("/v1/agent/service/deregister/{}", encode_segment(required(id, "service id")?)),
            None,
            "deregister local Consul service",
            AgentWritePermission::Service,
        )
        .await
    }

    pub(super) async fn set_agent_service_maintenance(
        &self,
        id: &str,
        enable: bool,
        reason: Option<&str>,
    ) -> Result<ConsulAgentWriteResult, String> {
        let target = self.validate_configured_agent_target().await?;
        let mut url =
            self.api_url(&format!("/v1/agent/service/maintenance/{}", encode_segment(required(id, "service id")?)))?;
        self.append_scope(&mut url, false);
        url.query_pairs_mut().append_pair("enable", if enable { "true" } else { "false" });
        if let Some(reason) = reason.map(str::trim).filter(|value| !value.is_empty()) {
            url.query_pairs_mut().append_pair("reason", reason);
        }
        ensure_agent_write_success(
            self.send(Method::PUT, url, None).await?,
            "change Consul service maintenance",
            AgentWritePermission::Service,
            self.token(),
        )
        .await?;
        Ok(ConsulAgentWriteResult { target })
    }

    pub(super) async fn register_agent_check(
        &self,
        registration: ConsulAgentCheckRegistration,
    ) -> Result<ConsulAgentWriteResult, String> {
        required(&registration.name, "check name")?;
        let permission = agent_write_permission_for_service_id(&registration.service_id);
        let body = check_registration_json(registration)?;
        self.agent_write_json("/v1/agent/check/register", Some(body), "register local Consul check", permission).await
    }

    pub(super) async fn deregister_agent_check(&self, id: &str) -> Result<ConsulAgentWriteResult, String> {
        let id = required(id, "check id")?;
        let target = self.validate_configured_agent_target().await?;
        let Some(permission) = self.existing_check_write_permission(id).await? else {
            return Ok(ConsulAgentWriteResult { target });
        };
        self.agent_write_json_for_target(
            &format!("/v1/agent/check/deregister/{}", encode_segment(id)),
            None,
            "deregister local Consul check",
            permission,
            target,
        )
        .await
    }

    pub(super) async fn update_ttl_check(
        &self,
        id: &str,
        status: ConsulCheckStatus,
        output: Option<&str>,
    ) -> Result<ConsulAgentWriteResult, String> {
        let status = match status {
            ConsulCheckStatus::Passing => "passing",
            ConsulCheckStatus::Warning => "warning",
            ConsulCheckStatus::Critical => "critical",
        };
        let id = required(id, "check id")?;
        let target = self.validate_configured_agent_target().await?;
        let permission = self
            .existing_check_write_permission(id)
            .await?
            .ok_or_else(|| "CONSUL_AGENT_CHECK_NOT_FOUND: Local Consul check does not exist".to_string())?;
        self.agent_write_json_for_target(
            &format!("/v1/agent/check/update/{}", encode_segment(id)),
            Some(serde_json::json!({ "Status": status, "Output": output.unwrap_or_default() })),
            "update Consul TTL check",
            permission,
            target,
        )
        .await
    }

    async fn existing_check_write_permission(&self, id: &str) -> Result<Option<AgentWritePermission>, String> {
        let checks = self.agent_checks().await.map_err(|error| {
            format!("CONSUL_AGENT_CHECK_SCOPE_UNAVAILABLE: Failed to determine local check ownership: {error}")
        })?;
        Ok(checks
            .get(id)
            .or_else(|| checks.values().find(|check| check.check_id == id))
            .map(|check| agent_write_permission_for_service_id(&check.service_id)))
    }
}

const MAX_AGENT_WRITE_BODY_BYTES: usize = 512 * 1024;

fn encode_agent_write_body(body: Option<serde_json::Value>, action: &str) -> Result<Option<Vec<u8>>, String> {
    let body = body
        .map(|value| serde_json::to_vec(&value).map_err(|error| format!("Failed to encode {action}: {error}")))
        .transpose()?;
    if body.as_ref().is_some_and(|body| body.len() > MAX_AGENT_WRITE_BODY_BYTES) {
        return Err(format!(
            "CONSUL_AGENT_REQUEST_TOO_LARGE: {action} request exceeds the {} KiB limit",
            MAX_AGENT_WRITE_BODY_BYTES / 1024
        ));
    }
    Ok(body)
}

async fn ensure_agent_write_success(
    response: reqwest::Response,
    action: &str,
    permission: AgentWritePermission,
    token: &str,
) -> Result<(), String> {
    let forbidden = response.status() == StatusCode::FORBIDDEN;
    match ensure_success(response, action, token).await {
        Ok(_) => Ok(()),
        Err(error) if forbidden => Err(agent_permission_error(permission, action, &error)),
        Err(error) => Err(error),
    }
}

fn agent_write_permission_for_service_id(service_id: &str) -> AgentWritePermission {
    if service_id.trim().is_empty() {
        AgentWritePermission::Node
    } else {
        AgentWritePermission::Service
    }
}

fn agent_permission_error(permission: AgentWritePermission, action: &str, detail: &str) -> String {
    match permission {
        AgentWritePermission::Service => {
            format!("CONSUL_AGENT_SERVICE_WRITE_DENIED: {action} requires Consul service:write permission; {detail}")
        }
        AgentWritePermission::Node => {
            format!("CONSUL_AGENT_NODE_WRITE_DENIED: {action} requires Consul node:write permission; {detail}")
        }
    }
}

fn same_address(left: &str, right: &str) -> bool {
    let left = left.trim().trim_matches(['[', ']']);
    let right = right.trim().trim_matches(['[', ']']);
    left.eq_ignore_ascii_case(right)
        || (left.eq_ignore_ascii_case("localhost") && is_loopback_address(right))
        || (right.eq_ignore_ascii_case("localhost") && is_loopback_address(left))
}

fn is_loopback_address(value: &str) -> bool {
    value.eq_ignore_ascii_case("localhost") || value.parse::<IpAddr>().is_ok_and(|address| address.is_loopback())
}

fn required<'a>(value: &'a str, field: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("CONSUL_INVALID_REQUEST: {field} is required"))
    } else {
        Ok(value)
    }
}

fn service_registration_json(registration: ConsulAgentServiceRegistration) -> Result<serde_json::Value, String> {
    validate_service_registration(&registration, 0)?;
    service_registration_json_inner(registration)
}

fn service_registration_json_inner(registration: ConsulAgentServiceRegistration) -> Result<serde_json::Value, String> {
    let checks = registration.checks.into_iter().map(check_registration_json).collect::<Result<Vec<_>, _>>()?;
    let proxy = registration.proxy.map(proxy_registration_json);
    let connect = registration
        .connect
        .map(|connect| {
            let sidecar =
                connect.sidecar_service.map(|sidecar| service_registration_json_inner(*sidecar)).transpose()?;
            Ok::<_, String>(serde_json::json!({
                "Native": connect.native,
                "SidecarService": sidecar,
            }))
        })
        .transpose()?;
    Ok(serde_json::json!({
        "ID": registration.id,
        "Name": registration.name,
        "Tags": registration.tags,
        "Address": registration.address,
        "TaggedAddresses": registration.tagged_addresses,
        "Port": registration.port,
        "Ports": registration.ports.into_iter().map(|port| serde_json::json!({
            "Name": port.name,
            "Port": port.port,
            "Default": port.default,
        })).collect::<Vec<_>>(),
        "Meta": registration.meta,
        "Weights": registration.weights,
        "Kind": registration.kind,
        "EnableTagOverride": registration.enable_tag_override,
        "Proxy": proxy,
        "Connect": connect,
        "Checks": checks,
    }))
}

fn proxy_registration_json(proxy: ConsulAgentProxyRegistration) -> serde_json::Value {
    serde_json::json!({
        "DestinationServiceName": proxy.destination_service_name,
        "DestinationServiceID": proxy.destination_service_id,
        "LocalServiceAddress": proxy.local_service_address,
        "LocalServicePort": proxy.local_service_port,
        "LocalServicePorts": proxy.local_service_ports,
        "LocalServiceSocketPath": proxy.local_service_socket_path,
        "Mode": proxy.mode,
        "TransparentProxy": proxy.transparent_proxy.map(|transparent| serde_json::json!({
            "OutboundListenerPort": transparent.outbound_listener_port,
            "DialedDirectly": transparent.dialed_directly,
        })),
        "Config": proxy.config,
        "Upstreams": proxy.upstreams.into_iter().map(|upstream| serde_json::json!({
            "DestinationType": upstream.destination_type,
            "DestinationName": upstream.destination_name,
            "DestinationPort": upstream.destination_port,
            "DestinationNamespace": upstream.destination_namespace,
            "DestinationPartition": upstream.destination_partition,
            "DestinationPeer": upstream.destination_peer,
            "LocalBindAddress": upstream.local_bind_address,
            "LocalBindPort": upstream.local_bind_port,
            "LocalBindSocketPath": upstream.local_bind_socket_path,
            "LocalBindSocketMode": upstream.local_bind_socket_mode,
            "Datacenter": upstream.datacenter,
            "MeshGateway": mesh_gateway_json(upstream.mesh_gateway),
            "Config": upstream.config,
        })).collect::<Vec<_>>(),
        "MeshGateway": mesh_gateway_json(proxy.mesh_gateway),
        "Expose": proxy.expose.map(|expose| serde_json::json!({
            "Checks": expose.checks,
            "Paths": expose.paths.into_iter().map(|path| serde_json::json!({
                "Path": path.path,
                "Protocol": path.protocol,
                "LocalPathPort": path.local_path_port,
                "ListenerPort": path.listener_port,
            })).collect::<Vec<_>>(),
        })),
    })
}

fn mesh_gateway_json(mesh_gateway: Option<ConsulAgentMeshGateway>) -> Option<serde_json::Value> {
    mesh_gateway.map(|gateway| serde_json::json!({ "Mode": gateway.mode }))
}

const MAX_AGENT_SIDECAR_DEPTH: usize = 4;
const MAX_AGENT_COLLECTION_ITEMS: usize = 1_000;
const MAX_AGENT_CONFIG_DEPTH: usize = 16;
const MAX_AGENT_CONFIG_NODES: usize = 10_000;

fn validate_service_registration(registration: &ConsulAgentServiceRegistration, depth: usize) -> Result<(), String> {
    required(&registration.name, "service name")?;
    if depth > MAX_AGENT_SIDECAR_DEPTH {
        return Err(format!(
            "CONSUL_AGENT_REGISTRATION_DEPTH_EXCEEDED: Connect.SidecarService exceeds {MAX_AGENT_SIDECAR_DEPTH} nested levels"
        ));
    }
    for (field, length) in [
        ("Tags", registration.tags.len()),
        ("TaggedAddresses", registration.tagged_addresses.len()),
        ("Ports", registration.ports.len()),
        ("Meta", registration.meta.len()),
        ("Checks", registration.checks.len()),
    ] {
        ensure_agent_collection_limit(field, length)?;
    }
    if registration.port != 0 && !registration.ports.is_empty() {
        return Err("CONSUL_INVALID_REQUEST: Agent service Port and Ports are mutually exclusive".to_string());
    }
    if registration.ports.iter().filter(|port| port.default).count() > 1 {
        return Err("CONSUL_INVALID_REQUEST: Agent service Ports may contain at most one default port".to_string());
    }
    if let Some(proxy) = &registration.proxy {
        validate_proxy_registration(proxy)?;
    }
    if let Some(sidecar) = registration.connect.as_ref().and_then(|connect| connect.sidecar_service.as_deref()) {
        validate_service_registration(sidecar, depth + 1)?;
    }
    Ok(())
}

fn validate_proxy_registration(proxy: &ConsulAgentProxyRegistration) -> Result<(), String> {
    for (field, length) in [
        ("Proxy.LocalServicePorts", proxy.local_service_ports.len()),
        ("Proxy.Upstreams", proxy.upstreams.len()),
        ("Proxy.Config", proxy.config.len()),
        ("Proxy.Expose.Paths", proxy.expose.as_ref().map_or(0, |expose| expose.paths.len())),
    ] {
        ensure_agent_collection_limit(field, length)?;
    }
    validate_opaque_config(&proxy.config, "Proxy.Config")?;
    for (index, upstream) in proxy.upstreams.iter().enumerate() {
        if !upstream.local_bind_socket_path.is_empty()
            && (upstream.local_bind_port != 0 || !upstream.local_bind_address.is_empty())
        {
            return Err(format!(
                "CONSUL_INVALID_REQUEST: Proxy.Upstreams[{index}] socket path conflicts with bind address or port"
            ));
        }
        ensure_agent_collection_limit(&format!("Proxy.Upstreams[{index}].Config"), upstream.config.len())?;
        validate_opaque_config(&upstream.config, &format!("Proxy.Upstreams[{index}].Config"))?;
    }
    Ok(())
}

fn validate_opaque_config(config: &BTreeMap<String, serde_json::Value>, field: &str) -> Result<(), String> {
    let mut stack = config.values().map(|value| (value, 1_usize)).collect::<Vec<_>>();
    let mut nodes = config.len();
    while let Some((value, depth)) = stack.pop() {
        if depth > MAX_AGENT_CONFIG_DEPTH {
            return Err(format!(
                "CONSUL_AGENT_CONFIG_DEPTH_EXCEEDED: {field} exceeds {MAX_AGENT_CONFIG_DEPTH} nested levels"
            ));
        }
        match value {
            serde_json::Value::Array(items) => {
                ensure_agent_collection_limit(field, items.len())?;
                nodes = nodes.saturating_add(items.len());
                stack.extend(items.iter().map(|item| (item, depth + 1)));
            }
            serde_json::Value::Object(items) => {
                ensure_agent_collection_limit(field, items.len())?;
                nodes = nodes.saturating_add(items.len());
                stack.extend(items.values().map(|item| (item, depth + 1)));
            }
            _ => {}
        }
        if nodes > MAX_AGENT_CONFIG_NODES {
            return Err(format!(
                "CONSUL_AGENT_CONFIG_TOO_COMPLEX: {field} exceeds {MAX_AGENT_CONFIG_NODES} JSON nodes"
            ));
        }
    }
    Ok(())
}

fn ensure_agent_collection_limit(field: &str, length: usize) -> Result<(), String> {
    if length > MAX_AGENT_COLLECTION_ITEMS {
        return Err(format!(
            "CONSUL_AGENT_COLLECTION_LIMIT_EXCEEDED: {field} contains {length} items; maximum is {MAX_AGENT_COLLECTION_ITEMS}"
        ));
    }
    Ok(())
}

fn check_registration_json(registration: ConsulAgentCheckRegistration) -> Result<serde_json::Value, String> {
    let mut object = serde_json::Map::new();
    object.insert("ID".to_string(), registration.id.into());
    object.insert("Name".to_string(), registration.name.into());
    object.insert("Notes".to_string(), registration.notes.into());
    object.insert("ServiceID".to_string(), registration.service_id.into());
    object.insert("Status".to_string(), registration.status.into());
    match registration.definition {
        ConsulAgentCheckDefinition::Http { url, method, interval, timeout, tls_skip_verify } => {
            required(&url, "HTTP check URL")?;
            object.insert("HTTP".to_string(), url.into());
            object.insert("Method".to_string(), method.into());
            object.insert("Interval".to_string(), interval.into());
            object.insert("Timeout".to_string(), timeout.into());
            object.insert("TLSSkipVerify".to_string(), tls_skip_verify.into());
        }
        ConsulAgentCheckDefinition::Tcp { address, interval, timeout } => {
            required(&address, "TCP check address")?;
            object.insert("TCP".to_string(), address.into());
            object.insert("Interval".to_string(), interval.into());
            object.insert("Timeout".to_string(), timeout.into());
        }
        ConsulAgentCheckDefinition::Grpc { address, interval, timeout, tls } => {
            required(&address, "gRPC check address")?;
            object.insert("GRPC".to_string(), address.into());
            object.insert("GRPCUseTLS".to_string(), tls.into());
            object.insert("Interval".to_string(), interval.into());
            object.insert("Timeout".to_string(), timeout.into());
        }
        ConsulAgentCheckDefinition::Ttl { ttl } => {
            required(&ttl, "TTL")?;
            object.insert("TTL".to_string(), ttl.into());
        }
        ConsulAgentCheckDefinition::Docker { container_id, shell, args, interval, timeout } => {
            required(&container_id, "Docker container id")?;
            object.insert("DockerContainerID".to_string(), container_id.into());
            object.insert("Shell".to_string(), shell.into());
            object.insert("Args".to_string(), args.into());
            object.insert("Interval".to_string(), interval.into());
            object.insert("Timeout".to_string(), timeout.into());
        }
        ConsulAgentCheckDefinition::Script { args, interval, timeout } => {
            if args.is_empty() {
                return Err("CONSUL_INVALID_REQUEST: script check args are required".to_string());
            }
            object.insert("Args".to_string(), args.into());
            object.insert("Interval".to_string(), interval.into());
            object.insert("Timeout".to_string(), timeout.into());
        }
    }
    Ok(object.into())
}

pub async fn consul_agent_self_core(state: &AppState, connection_id: &str) -> Result<ConsulAgentIdentity, String> {
    client_for_state(state, connection_id).await?.agent_self().await
}

pub async fn consul_agent_members_core(
    state: &AppState,
    connection_id: &str,
    wan: bool,
    segment: Option<&str>,
) -> Result<Vec<ConsulAgentMember>, String> {
    client_for_state(state, connection_id).await?.agent_members(wan, segment).await
}

pub async fn consul_agent_metrics_core(state: &AppState, connection_id: &str) -> Result<ConsulAgentMetrics, String> {
    client_for_state(state, connection_id).await?.agent_metrics().await
}

pub async fn consul_agent_services_core(
    state: &AppState,
    connection_id: &str,
) -> Result<BTreeMap<String, ConsulAgentService>, String> {
    client_for_state(state, connection_id).await?.agent_services().await
}

pub async fn consul_agent_service_core(
    state: &AppState,
    connection_id: &str,
    id: &str,
) -> Result<ConsulAgentService, String> {
    client_for_state(state, connection_id).await?.agent_service(id).await
}

pub async fn consul_agent_checks_core(
    state: &AppState,
    connection_id: &str,
) -> Result<BTreeMap<String, ConsulHealthCheck>, String> {
    client_for_state(state, connection_id).await?.agent_checks().await
}

pub async fn consul_agent_register_service_core(
    state: &AppState,
    connection_id: &str,
    registration: ConsulAgentServiceRegistration,
) -> Result<ConsulAgentWriteResult, String> {
    ensure_writable_core(state, connection_id, "register Consul Agent service").await?;
    client_for_state(state, connection_id).await?.register_agent_service(registration).await
}

pub async fn consul_agent_deregister_service_core(
    state: &AppState,
    connection_id: &str,
    id: &str,
) -> Result<ConsulAgentWriteResult, String> {
    ensure_writable_core(state, connection_id, "deregister Consul Agent service").await?;
    client_for_state(state, connection_id).await?.deregister_agent_service(id).await
}

pub async fn consul_agent_service_maintenance_core(
    state: &AppState,
    connection_id: &str,
    id: &str,
    enable: bool,
    reason: Option<&str>,
) -> Result<ConsulAgentWriteResult, String> {
    ensure_writable_core(state, connection_id, "change Consul Agent service maintenance").await?;
    client_for_state(state, connection_id).await?.set_agent_service_maintenance(id, enable, reason).await
}

pub async fn consul_agent_register_check_core(
    state: &AppState,
    connection_id: &str,
    registration: ConsulAgentCheckRegistration,
) -> Result<ConsulAgentWriteResult, String> {
    ensure_writable_core(state, connection_id, "register Consul Agent check").await?;
    client_for_state(state, connection_id).await?.register_agent_check(registration).await
}

pub async fn consul_agent_deregister_check_core(
    state: &AppState,
    connection_id: &str,
    id: &str,
) -> Result<ConsulAgentWriteResult, String> {
    ensure_writable_core(state, connection_id, "deregister Consul Agent check").await?;
    client_for_state(state, connection_id).await?.deregister_agent_check(id).await
}

pub async fn consul_agent_update_ttl_core(
    state: &AppState,
    connection_id: &str,
    id: &str,
    status: ConsulCheckStatus,
    output: Option<&str>,
) -> Result<ConsulAgentWriteResult, String> {
    ensure_writable_core(state, connection_id, "update Consul Agent TTL check").await?;
    client_for_state(state, connection_id).await?.update_ttl_check(id, status, output).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_definition_is_discriminated() {
        let value = serde_json::to_value(ConsulAgentCheckDefinition::Ttl { ttl: "30s".to_string() }).unwrap();
        assert_eq!(value["type"], "ttl");
        assert_eq!(value["ttl"], "30s");
    }

    #[test]
    fn agent_service_id_uses_consul_uppercase_acronym() {
        let service: ConsulAgentService = serde_json::from_value(serde_json::json!({
            "ID": "api-1",
            "Service": "api",
            "Port": 8080
        }))
        .unwrap();
        assert_eq!(service.id, "api-1");
        assert_eq!(serde_json::to_value(service).unwrap()["ID"], "api-1");
    }

    #[test]
    fn target_address_matching_is_exact() {
        assert!(same_address("127.0.0.1", "127.0.0.1"));
        assert!(same_address("::1", "[::1]"));
        assert!(same_address("localhost", "127.0.0.1"));
        assert!(same_address("localhost", "::1"));
        assert!(!same_address("127.0.0.1", "127.0.0.2"));
    }

    #[test]
    fn service_registration_wire_includes_stable_mesh_fields() {
        let registration = ConsulAgentServiceRegistration {
            name: "api".into(),
            tagged_addresses: BTreeMap::from([(
                "lan".into(),
                ConsulServiceAddress { address: "127.0.0.1".into(), port: 8080 },
            )]),
            ports: vec![ConsulAgentServicePort { name: "http".into(), port: 8080, default: true }],
            connect: Some(ConsulAgentConnectRegistration {
                native: true,
                sidecar_service: Some(Box::new(ConsulAgentServiceRegistration {
                    name: "api-sidecar".into(),
                    kind: "connect-proxy".into(),
                    ..Default::default()
                })),
            }),
            proxy: Some(ConsulAgentProxyRegistration {
                destination_service_name: "api".into(),
                destination_service_id: "api-1".into(),
                local_service_address: "127.0.0.1".into(),
                local_service_port: 8080,
                mode: "transparent".into(),
                transparent_proxy: Some(ConsulAgentTransparentProxy {
                    outbound_listener_port: 22500,
                    dialed_directly: true,
                }),
                config: BTreeMap::from([("protocol".into(), serde_json::json!("http2"))]),
                upstreams: vec![ConsulAgentUpstream {
                    destination_type: "service".into(),
                    destination_name: "db".into(),
                    destination_port: 5432,
                    destination_namespace: "payments".into(),
                    destination_partition: "prod".into(),
                    destination_peer: "west".into(),
                    local_bind_address: "127.0.0.1".into(),
                    local_bind_port: 9191,
                    datacenter: "dc2".into(),
                    mesh_gateway: Some(ConsulAgentMeshGateway { mode: "remote".into() }),
                    config: BTreeMap::from([("connect_timeout_ms".into(), serde_json::json!(2500))]),
                    ..Default::default()
                }],
                mesh_gateway: Some(ConsulAgentMeshGateway { mode: "local".into() }),
                expose: Some(ConsulAgentExpose {
                    checks: true,
                    paths: vec![ConsulAgentExposePath {
                        path: "/healthz".into(),
                        protocol: "http".into(),
                        local_path_port: 8080,
                        listener_port: 21500,
                    }],
                }),
                ..Default::default()
            }),
            ..Default::default()
        };

        let value = service_registration_json(registration).unwrap();
        assert_eq!(value["TaggedAddresses"]["lan"]["Address"], "127.0.0.1");
        assert_eq!(value["Ports"][0]["Default"], true);
        assert_eq!(value["Connect"]["Native"], true);
        assert_eq!(value["Connect"]["SidecarService"]["Name"], "api-sidecar");
        assert_eq!(value["Proxy"]["TransparentProxy"]["OutboundListenerPort"], 22500);
        assert_eq!(value["Proxy"]["Expose"]["Paths"][0]["ListenerPort"], 21500);
        assert_eq!(value["Proxy"]["MeshGateway"]["Mode"], "local");
        assert_eq!(value["Proxy"]["Config"]["protocol"], "http2");
        assert_eq!(value["Proxy"]["Upstreams"][0]["DestinationPort"], 5432);
        assert_eq!(value["Proxy"]["Upstreams"][0]["DestinationNamespace"], "payments");
        assert_eq!(value["Proxy"]["Upstreams"][0]["DestinationPartition"], "prod");
        assert_eq!(value["Proxy"]["Upstreams"][0]["DestinationPeer"], "west");
        assert_eq!(value["Proxy"]["Upstreams"][0]["MeshGateway"]["Mode"], "remote");
        assert_eq!(value["Proxy"]["Upstreams"][0]["Config"]["connect_timeout_ms"], 2500);
    }

    #[test]
    fn registration_safety_limits_cover_depth_collections_and_bytes() {
        let mut within_limit = ConsulAgentServiceRegistration { name: "leaf".into(), ..Default::default() };
        for depth in 0..MAX_AGENT_SIDECAR_DEPTH {
            within_limit = ConsulAgentServiceRegistration {
                name: format!("sidecar-{depth}"),
                connect: Some(ConsulAgentConnectRegistration {
                    native: false,
                    sidecar_service: Some(Box::new(within_limit)),
                }),
                ..Default::default()
            };
        }
        assert!(service_registration_json(within_limit.clone()).is_ok());
        let too_deep = ConsulAgentServiceRegistration {
            name: "too-deep".into(),
            connect: Some(ConsulAgentConnectRegistration {
                native: false,
                sidecar_service: Some(Box::new(within_limit)),
            }),
            ..Default::default()
        };
        assert!(service_registration_json(too_deep).unwrap_err().contains("REGISTRATION_DEPTH_EXCEEDED"));

        let too_many = ConsulAgentServiceRegistration {
            name: "too-many".into(),
            tags: vec!["tag".into(); MAX_AGENT_COLLECTION_ITEMS + 1],
            ..Default::default()
        };
        assert!(service_registration_json(too_many).unwrap_err().contains("COLLECTION_LIMIT_EXCEEDED"));

        let mut nested_config = serde_json::json!(true);
        for _ in 0..MAX_AGENT_CONFIG_DEPTH {
            nested_config = serde_json::json!({ "next": nested_config });
        }
        let config_too_deep = ConsulAgentServiceRegistration {
            name: "deep-config".into(),
            proxy: Some(ConsulAgentProxyRegistration {
                config: BTreeMap::from([("root".into(), nested_config)]),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(service_registration_json(config_too_deep).unwrap_err().contains("CONFIG_DEPTH_EXCEEDED"));

        let oversized = serde_json::json!({ "blob": "x".repeat(MAX_AGENT_WRITE_BODY_BYTES) });
        assert!(encode_agent_write_body(Some(oversized), "register service")
            .unwrap_err()
            .contains("AGENT_REQUEST_TOO_LARGE"));
    }

    #[test]
    fn agent_write_permission_errors_are_stable_and_scope_specific() {
        assert_eq!(agent_write_permission_for_service_id(""), AgentWritePermission::Node);
        assert_eq!(agent_write_permission_for_service_id("api-1"), AgentWritePermission::Service);
        let service = agent_permission_error(AgentWritePermission::Service, "register check", "forbidden");
        let node = agent_permission_error(AgentWritePermission::Node, "register check", "forbidden");
        assert!(service.starts_with("CONSUL_AGENT_SERVICE_WRITE_DENIED:"));
        assert!(service.contains("service:write"));
        assert!(node.starts_with("CONSUL_AGENT_NODE_WRITE_DENIED:"));
        assert!(node.contains("node:write"));
    }
}
