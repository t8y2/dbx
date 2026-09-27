use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::connection::AppState;

use super::catalog::{
    encode_segment, ConsulCatalogNode, ConsulListResponse, ConsulReadOptions, ConsulServiceAddress,
    ConsulServiceWeights,
};
use super::client::{client_for_state, ConsulClient};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulHealthCheck {
    #[serde(default)]
    pub node: String,
    #[serde(default, rename = "CheckID", alias = "CheckId")]
    pub check_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub output: String,
    #[serde(default, rename = "ServiceID", alias = "ServiceId")]
    pub service_id: String,
    #[serde(default)]
    pub service_name: String,
    #[serde(default)]
    pub service_tags: Vec<String>,
    #[serde(default)]
    #[serde(rename = "Type")]
    pub type_: String,
    #[serde(default)]
    pub exposed_port: u16,
    #[serde(default)]
    pub definition: ConsulHealthCheckDefinition,
    #[serde(default, rename = "CreateIndex")]
    pub create_index: u64,
    #[serde(default, rename = "ModifyIndex")]
    pub modify_index: u64,
    #[serde(default, skip_deserializing)]
    pub maintenance: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulHealthCheckDefinition {
    #[serde(default)]
    pub http: String,
    #[serde(default)]
    pub tcp: String,
    #[serde(default)]
    pub grpc: String,
    #[serde(default)]
    pub interval: String,
    #[serde(default)]
    pub timeout: String,
    #[serde(default)]
    pub ttl: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulHealthService {
    #[serde(default, rename = "ID", alias = "Id")]
    pub id: String,
    #[serde(default)]
    pub service: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub tagged_addresses: BTreeMap<String, ConsulServiceAddress>,
    #[serde(default)]
    pub meta: BTreeMap<String, String>,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub weights: ConsulServiceWeights,
    #[serde(default)]
    pub kind: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulServiceInstance {
    pub node: ConsulCatalogNode,
    pub service: ConsulHealthService,
    #[serde(default)]
    pub checks: Vec<ConsulHealthCheck>,
}

impl ConsulClient {
    pub async fn health_node_checks(
        &self,
        node: &str,
        options: &ConsulReadOptions,
    ) -> Result<ConsulListResponse<Vec<ConsulHealthCheck>>, String> {
        let mut response: ConsulListResponse<Vec<ConsulHealthCheck>> = self
            .read_list(
                &format!("/v1/health/node/{}", encode_segment(required(node, "node")?)),
                options,
                "read Consul node health",
            )
            .await?;
        mark_maintenance(&mut response.items);
        Ok(response)
    }

    pub async fn health_service_checks(
        &self,
        service: &str,
        options: &ConsulReadOptions,
    ) -> Result<ConsulListResponse<Vec<ConsulHealthCheck>>, String> {
        let mut response: ConsulListResponse<Vec<ConsulHealthCheck>> = self
            .read_list(
                &format!("/v1/health/checks/{}", encode_segment(required(service, "service")?)),
                options,
                "read Consul service checks",
            )
            .await?;
        mark_maintenance(&mut response.items);
        Ok(response)
    }

    pub async fn health_service_instances(
        &self,
        service: &str,
        passing: Option<bool>,
        options: &ConsulReadOptions,
    ) -> Result<ConsulListResponse<Vec<ConsulServiceInstance>>, String> {
        let mut path = format!("/v1/health/service/{}", encode_segment(required(service, "service")?));
        if let Some(passing) = passing {
            path.push_str(if passing { "?passing=true" } else { "?passing=false" });
        }
        let mut response: ConsulListResponse<Vec<ConsulServiceInstance>> =
            self.read_list(&path, options, "read Consul service instances").await?;
        for instance in &mut response.items {
            mark_maintenance(&mut instance.checks);
        }
        Ok(response)
    }

    pub async fn health_state_checks(
        &self,
        state: &str,
        options: &ConsulReadOptions,
    ) -> Result<ConsulListResponse<Vec<ConsulHealthCheck>>, String> {
        let state = state.trim().to_ascii_lowercase();
        if !matches!(state.as_str(), "any" | "passing" | "warning" | "critical") {
            return Err("CONSUL_INVALID_REQUEST: health state must be any, passing, warning, or critical".to_string());
        }
        let mut response: ConsulListResponse<Vec<ConsulHealthCheck>> =
            self.read_list(&format!("/v1/health/state/{state}"), options, "read Consul health state").await?;
        mark_maintenance(&mut response.items);
        Ok(response)
    }
}

fn required<'a>(value: &'a str, field: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("CONSUL_INVALID_REQUEST: {field} is required"))
    } else {
        Ok(value)
    }
}

pub(super) fn mark_maintenance(checks: &mut [ConsulHealthCheck]) {
    for check in checks {
        check.maintenance =
            check.check_id == "_node_maintenance" || check.check_id.starts_with("_service_maintenance:");
    }
}

pub async fn consul_health_node_core(
    state: &AppState,
    connection_id: &str,
    node: &str,
    options: ConsulReadOptions,
) -> Result<ConsulListResponse<Vec<ConsulHealthCheck>>, String> {
    client_for_state(state, connection_id).await?.health_node_checks(node, &options).await
}

pub async fn consul_health_checks_core(
    state: &AppState,
    connection_id: &str,
    service: &str,
    options: ConsulReadOptions,
) -> Result<ConsulListResponse<Vec<ConsulHealthCheck>>, String> {
    client_for_state(state, connection_id).await?.health_service_checks(service, &options).await
}

pub async fn consul_health_service_core(
    state: &AppState,
    connection_id: &str,
    service: &str,
    passing: Option<bool>,
    options: ConsulReadOptions,
) -> Result<ConsulListResponse<Vec<ConsulServiceInstance>>, String> {
    client_for_state(state, connection_id).await?.health_service_instances(service, passing, &options).await
}

pub async fn consul_health_state_core(
    state: &AppState,
    connection_id: &str,
    health_state: &str,
    options: ConsulReadOptions,
) -> Result<ConsulListResponse<Vec<ConsulHealthCheck>>, String> {
    client_for_state(state, connection_id).await?.health_state_checks(health_state, &options).await
}
