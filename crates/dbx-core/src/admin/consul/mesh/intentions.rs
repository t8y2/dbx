use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};

use super::super::client::client_for_state;
use crate::connection::AppState;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulIntention {
    #[serde(rename = "ID", default)]
    pub id: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub source_name: String,
    #[serde(default)]
    pub destination_name: String,
    #[serde(default)]
    pub source_namespace: String,
    #[serde(default)]
    pub destination_namespace: String,
    #[serde(default)]
    pub source_partition: String,
    #[serde(default)]
    pub destination_partition: String,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub permissions: Vec<serde_json::Value>,
    #[serde(default)]
    pub precedence: u64,
    #[serde(default)]
    pub create_index: u64,
    #[serde(default)]
    pub modify_index: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulIntentionMatchRequest {
    pub by: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulIntentionCheckRequest {
    pub source: String,
    pub destination: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulIntentionExactRequest {
    pub source: String,
    pub destination: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulIntentionCheckResponse {
    pub allowed: bool,
}

pub async fn consul_mesh_intentions_list_core(
    state: &AppState,
    connection_id: &str,
) -> Result<Vec<ConsulIntention>, String> {
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url("/v1/connect/intentions")?;
    client.request_json(Method::GET, url, None::<&()>, true, "list intentions").await
}

pub async fn consul_mesh_intention_get_core(
    state: &AppState,
    connection_id: &str,
    id: &str,
) -> Result<ConsulIntention, String> {
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url(&format!("/v1/connect/intentions/{}", segment(id)))?;
    client.request_json(Method::GET, url, None::<&()>, true, "read intention").await
}

pub async fn consul_mesh_intention_get_exact_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulIntentionExactRequest,
) -> Result<ConsulIntention, String> {
    validate_exact_request(&request)?;
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url("/v1/connect/intentions/exact")?;
    let url = exact_intention_url(url, &request.source, &request.destination);
    client.request_json(Method::GET, url, None::<&()>, true, "read exact intention").await
}

pub async fn consul_mesh_intention_upsert_core(
    state: &AppState,
    connection_id: &str,
    item: ConsulIntention,
) -> Result<ConsulIntention, String> {
    super::super::ensure_writable(state, connection_id, "intention write").await?;
    if item.source_name.trim().is_empty() || item.destination_name.trim().is_empty() {
        return Err("CONSUL_INVALID_REQUEST: intention SourceName and DestinationName are required".into());
    }
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url("/v1/connect/intentions/exact")?;
    let url = exact_intention_url(url, &item.source_name, &item.destination_name);
    let written: bool = client.request_json(Method::PUT, url, Some(&item), false, "upsert intention").await?;
    if !written {
        return Err("CONSUL_WRITE_REJECTED: Consul rejected the intention upsert".to_string());
    }
    let mut url = client.api_url("/v1/connect/intentions/exact")?;
    url.query_pairs_mut().append_pair("source", &item.source_name).append_pair("destination", &item.destination_name);
    client.request_json(Method::GET, url, None::<&()>, true, "read upserted intention").await
}

pub async fn consul_mesh_intention_delete_core(
    state: &AppState,
    connection_id: &str,
    id: &str,
) -> Result<bool, String> {
    super::super::ensure_writable(state, connection_id, "intention delete").await?;
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url(&format!("/v1/connect/intentions/{}", segment(id)))?;
    client.send_json(Method::DELETE, url, None::<&()>, false, "delete intention").await?;
    Ok(true)
}

pub async fn consul_mesh_intention_delete_exact_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulIntentionExactRequest,
) -> Result<bool, String> {
    super::super::ensure_writable(state, connection_id, "exact intention delete").await?;
    validate_exact_request(&request)?;
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url("/v1/connect/intentions/exact")?;
    let url = exact_intention_url(url, &request.source, &request.destination);
    client.send_json(Method::DELETE, url, None::<&()>, false, "delete exact intention").await?;
    Ok(true)
}

pub async fn consul_mesh_intention_match_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulIntentionMatchRequest,
) -> Result<Vec<ConsulIntention>, String> {
    if !matches!(request.by.as_str(), "source" | "destination") {
        return Err("CONSUL_INVALID_REQUEST: intention match 'by' must be source or destination".into());
    }
    let client = client_for_state(state, connection_id).await?;
    let mut url = client.api_url("/v1/connect/intentions/match")?;
    url.query_pairs_mut().append_pair("by", &request.by).append_pair("name", &request.name);
    client.request_json(Method::GET, url, None::<&()>, true, "match intentions").await
}

pub async fn consul_mesh_intention_check_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulIntentionCheckRequest,
) -> Result<ConsulIntentionCheckResponse, String> {
    if request.source.trim().is_empty() || request.destination.trim().is_empty() {
        return Err("CONSUL_INVALID_REQUEST: intention check source and destination are required".into());
    }
    let client = client_for_state(state, connection_id).await?;
    let mut url = client.api_url("/v1/connect/intentions/check")?;
    url.query_pairs_mut().append_pair("source", &request.source).append_pair("destination", &request.destination);
    client.request_json(Method::GET, url, None::<&()>, true, "check intention authorization").await
}

fn segment(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

fn exact_intention_url(mut url: Url, source: &str, destination: &str) -> Url {
    url.query_pairs_mut().append_pair("source", source).append_pair("destination", destination);
    url
}

fn validate_exact_request(request: &ConsulIntentionExactRequest) -> Result<(), String> {
    if request.source.trim().is_empty() || request.destination.trim().is_empty() {
        return Err("CONSUL_INVALID_REQUEST: exact intention source and destination are required".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_upsert_uses_official_method_path_and_query() {
        let base = Url::parse("https://consul.example/proxy/v1/connect/intentions/exact").unwrap();
        let url = exact_intention_url(base, "api/web", "payments v2");

        assert_eq!(url.path(), "/proxy/v1/connect/intentions/exact");
        assert_eq!(url.query(), Some("source=api%2Fweb&destination=payments+v2"));
    }

    #[test]
    fn exact_read_and_delete_share_the_official_path_and_validate_names() {
        let base = Url::parse("https://consul.example/proxy/v1/connect/intentions/exact").unwrap();
        let request = ConsulIntentionExactRequest { source: "api".into(), destination: "db".into() };
        assert!(validate_exact_request(&request).is_ok());
        let url = exact_intention_url(base, &request.source, &request.destination);
        assert_eq!(url.query(), Some("source=api&destination=db"));
        assert!(validate_exact_request(&ConsulIntentionExactRequest { source: "".into(), destination: "db".into() })
            .is_err());
    }

    #[test]
    fn check_endpoint_uses_official_path() {
        let mut url = Url::parse("https://consul.example/proxy/v1/connect/intentions/check").unwrap();
        url.query_pairs_mut().append_pair("source", "api").append_pair("destination", "db");

        assert_eq!(url.path(), "/proxy/v1/connect/intentions/check");
        assert_eq!(url.query(), Some("source=api&destination=db"));
    }
}
