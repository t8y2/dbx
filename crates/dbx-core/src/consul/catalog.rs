use std::collections::BTreeMap;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::connection::AppState;

use super::client::{client_for_state, ConsulClient};
use super::response::{decode_json_response, ensure_success, ConsulResponseMetadata};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulReadOptions {
    pub filter: Option<String>,
    pub near: Option<String>,
    pub index: Option<String>,
    pub wait: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulListResponse<T> {
    pub items: T,
    pub metadata: ConsulResponseMetadata,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulCatalogNode {
    #[serde(default, rename = "ID", alias = "Id")]
    pub id: String,
    #[serde(default)]
    pub node: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub datacenter: String,
    #[serde(default)]
    pub tagged_addresses: BTreeMap<String, String>,
    #[serde(default)]
    pub node_meta: BTreeMap<String, String>,
    #[serde(default)]
    pub create_index: u64,
    #[serde(default)]
    pub modify_index: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulCatalogServiceNode {
    #[serde(default, rename = "ID", alias = "Id")]
    pub id: String,
    #[serde(default)]
    pub node: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub datacenter: String,
    #[serde(default)]
    pub tagged_addresses: BTreeMap<String, String>,
    #[serde(default)]
    pub node_meta: BTreeMap<String, String>,
    #[serde(default)]
    pub service_kind: String,
    #[serde(default, rename = "ServiceID", alias = "ServiceId")]
    pub service_id: String,
    #[serde(default)]
    pub service_name: String,
    #[serde(default)]
    pub service_tags: Vec<String>,
    #[serde(default)]
    pub service_address: String,
    #[serde(default)]
    pub service_port: u16,
    #[serde(default)]
    pub service_meta: BTreeMap<String, String>,
    #[serde(default)]
    pub service_tagged_addresses: BTreeMap<String, ConsulServiceAddress>,
    #[serde(default)]
    pub service_weights: ConsulServiceWeights,
    #[serde(default)]
    pub create_index: u64,
    #[serde(default)]
    pub modify_index: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulServiceAddress {
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulServiceWeights {
    #[serde(default = "default_weight")]
    pub passing: u32,
    #[serde(default = "default_weight")]
    pub warning: u32,
}

impl Default for ConsulServiceWeights {
    fn default() -> Self {
        Self { passing: 1, warning: 1 }
    }
}

fn default_weight() -> u32 {
    1
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulCatalogService {
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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulNodeServices {
    pub node: ConsulCatalogNode,
    #[serde(default)]
    pub services: BTreeMap<String, ConsulCatalogService>,
}

impl ConsulClient {
    pub async fn catalog_datacenters(&self) -> Result<Vec<String>, String> {
        let url = self.api_url("/v1/catalog/datacenters")?;
        let response =
            ensure_success(self.send(Method::GET, url, None).await?, "list Consul datacenters", self.token()).await?;
        decode_json_response(response, "list Consul datacenters").await
    }

    pub async fn catalog_nodes(
        &self,
        options: &ConsulReadOptions,
    ) -> Result<ConsulListResponse<Vec<ConsulCatalogNode>>, String> {
        self.read_list("/v1/catalog/nodes", options, "list Consul catalog nodes").await
    }

    pub async fn catalog_services(
        &self,
        options: &ConsulReadOptions,
    ) -> Result<ConsulListResponse<BTreeMap<String, Vec<String>>>, String> {
        self.read_list("/v1/catalog/services", options, "list Consul catalog services").await
    }

    pub async fn catalog_service_nodes(
        &self,
        service: &str,
        options: &ConsulReadOptions,
    ) -> Result<ConsulListResponse<Vec<ConsulCatalogServiceNode>>, String> {
        let service = required_segment(service, "service")?;
        self.read_list(
            &format!("/v1/catalog/service/{}", encode_segment(service)),
            options,
            "list Consul service nodes",
        )
        .await
    }

    pub async fn catalog_node_services(
        &self,
        node: &str,
        options: &ConsulReadOptions,
    ) -> Result<ConsulListResponse<ConsulNodeServices>, String> {
        let node = required_segment(node, "node")?;
        self.read_list(&format!("/v1/catalog/node/{}", encode_segment(node)), options, "read Consul node services")
            .await
    }

    pub(super) async fn read_list<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        options: &ConsulReadOptions,
        action: &str,
    ) -> Result<ConsulListResponse<T>, String> {
        let mut url = self.api_url(path)?;
        self.append_scope(&mut url, true);
        append_read_options(&mut url, options);
        let response = ensure_success(self.send(Method::GET, url, None).await?, action, self.token()).await?;
        let metadata = ConsulResponseMetadata::from_response(&response);
        let items = decode_json_response(response, action).await?;
        Ok(ConsulListResponse { items, metadata })
    }
}

pub(super) fn append_read_options(url: &mut reqwest::Url, options: &ConsulReadOptions) {
    let mut query = url.query_pairs_mut();
    for (name, value) in [
        ("filter", options.filter.as_deref()),
        ("near", options.near.as_deref()),
        ("index", options.index.as_deref()),
        ("wait", options.wait.as_deref()),
    ] {
        if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
            query.append_pair(name, value);
        }
    }
}

pub(super) fn encode_segment(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn required_segment<'a>(value: &'a str, name: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("CONSUL_INVALID_REQUEST: {name} is required"));
    }
    Ok(value)
}

pub async fn consul_catalog_datacenters_core(state: &AppState, connection_id: &str) -> Result<Vec<String>, String> {
    client_for_state(state, connection_id).await?.catalog_datacenters().await
}

pub async fn consul_catalog_nodes_core(
    state: &AppState,
    connection_id: &str,
    options: ConsulReadOptions,
) -> Result<ConsulListResponse<Vec<ConsulCatalogNode>>, String> {
    client_for_state(state, connection_id).await?.catalog_nodes(&options).await
}

pub async fn consul_catalog_services_core(
    state: &AppState,
    connection_id: &str,
    options: ConsulReadOptions,
) -> Result<ConsulListResponse<BTreeMap<String, Vec<String>>>, String> {
    client_for_state(state, connection_id).await?.catalog_services(&options).await
}

pub async fn consul_catalog_service_nodes_core(
    state: &AppState,
    connection_id: &str,
    service: &str,
    options: ConsulReadOptions,
) -> Result<ConsulListResponse<Vec<ConsulCatalogServiceNode>>, String> {
    client_for_state(state, connection_id).await?.catalog_service_nodes(service, &options).await
}

pub async fn consul_catalog_node_services_core(
    state: &AppState,
    connection_id: &str,
    node: &str,
    options: ConsulReadOptions,
) -> Result<ConsulListResponse<ConsulNodeServices>, String> {
    client_for_state(state, connection_id).await?.catalog_node_services(node, &options).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consul_acronym_ids_deserialize_without_becoming_empty() {
        let instance: ConsulCatalogServiceNode = serde_json::from_value(serde_json::json!({
            "ID": "node-id",
            "Node": "node-1",
            "ServiceID": "api-1",
            "ServiceName": "api"
        }))
        .unwrap();
        assert_eq!(instance.id, "node-id");
        assert_eq!(instance.service_id, "api-1");

        let service: ConsulCatalogService = serde_json::from_value(serde_json::json!({
            "ID": "api-1",
            "Service": "api"
        }))
        .unwrap();
        assert_eq!(service.id, "api-1");
    }
}
