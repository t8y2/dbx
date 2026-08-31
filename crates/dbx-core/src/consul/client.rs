use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use reqwest::{Method, Url};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::connection::{AppState, PoolKind};
use crate::path_utils::expand_tilde;

use super::config::ConsulScope;
use super::config::{ConsulConfig, ConsulConsistency};

#[derive(Debug, Clone)]
pub struct ConsulClient {
    config: ConsulConfig,
    http: reqwest::Client,
}

impl ConsulClient {
    pub async fn new(mut config: ConsulConfig) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(config.connect_timeout_secs.max(1)))
            .redirect(reqwest::redirect::Policy::none());
        if config.request_timeout_secs > 0 {
            builder = builder.timeout(Duration::from_secs(config.request_timeout_secs));
        }
        if config.tls_skip_verify {
            builder = builder.danger_accept_invalid_certs(true);
        }
        if !config.ca_cert_path.is_empty() {
            let path = expand_tilde(&config.ca_cert_path);
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|error| format!("Failed to read Consul CA certificate at {path}: {error}"))?;
            let certificates = reqwest::Certificate::from_pem_bundle(&bytes)
                .or_else(|_| reqwest::Certificate::from_der(&bytes).map(|certificate| vec![certificate]))
                .map_err(|error| format!("Failed to parse Consul CA certificate at {path}: {error}"))?;
            for certificate in certificates {
                builder = builder.add_root_certificate(certificate);
            }
        }
        if !config.client_cert_path.is_empty() {
            let cert_path = expand_tilde(&config.client_cert_path);
            let key_path = expand_tilde(&config.client_key_path);
            let mut pem = tokio::fs::read(&cert_path)
                .await
                .map_err(|error| format!("Failed to read Consul client certificate at {cert_path}: {error}"))?;
            if !pem.ends_with(b"\n") {
                pem.push(b'\n');
            }
            pem.extend(
                tokio::fs::read(&key_path)
                    .await
                    .map_err(|error| format!("Failed to read Consul client key at {key_path}: {error}"))?,
            );
            let identity = reqwest::Identity::from_pem(&pem)
                .map_err(|error| format!("Failed to parse Consul client identity: {error}"))?;
            builder = builder.identity(identity);
        }
        if let Some((override_host, override_port)) = config.connect_override.clone() {
            let original_host = config.base_url.host_str().ok_or("Consul server address has no host")?.to_string();
            let ip = override_host
                .parse::<IpAddr>()
                .map_err(|_| format!("Consul transport target must resolve to an IP address: {override_host}"))?;
            config
                .base_url
                .set_port(Some(override_port))
                .map_err(|_| "Consul server address cannot use the transport override port".to_string())?;
            builder = builder.resolve(&original_host, SocketAddr::new(ip, override_port));
        }
        let http = builder.build().map_err(|error| format!("Failed to initialize Consul HTTP client: {error}"))?;
        Ok(Self { config, http })
    }

    pub async fn probe(&self) -> Result<(), String> {
        self.list_prefix("", 1, None).await.map(|_| ())
    }

    pub(super) fn api_url(&self, path: &str) -> Result<Url, String> {
        let base = self.config.base_url.as_str().trim_end_matches('/');
        Url::parse(&format!("{base}/{}", path.trim_start_matches('/')))
            .map_err(|error| format!("Failed to build Consul API URL: {error}"))
    }

    pub(super) fn append_scope(&self, url: &mut Url, read: bool) {
        let mut query = url.query_pairs_mut();
        if !self.config.datacenter.is_empty() {
            query.append_pair("dc", &self.config.datacenter);
        }
        if !self.config.namespace.is_empty() {
            query.append_pair("ns", &self.config.namespace);
        }
        if !self.config.partition.is_empty() {
            query.append_pair("partition", &self.config.partition);
        }
        if read {
            match self.config.consistency {
                ConsulConsistency::Default => {}
                ConsulConsistency::Stale => {
                    query.append_pair("stale", "");
                }
                ConsulConsistency::Consistent => {
                    query.append_pair("consistent", "");
                }
            }
        }
    }

    pub(super) async fn send(
        &self,
        method: Method,
        url: Url,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response, String> {
        let mut request = self.request(method, url);
        if let Some(body) = body {
            request = request.body(body);
        }
        request.send().await.map_err(|error| format!("Consul request failed: {}", error.without_url()))
    }

    fn request(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
        let mut request = self.http.request(method, url);
        if !self.config.token.is_empty() {
            request = request.header("X-Consul-Token", &self.config.token);
        }
        request
    }

    pub(super) async fn send_json<T: Serialize + ?Sized>(
        &self,
        method: Method,
        mut url: Url,
        body: Option<&T>,
        read: bool,
        action: &str,
    ) -> Result<reqwest::Response, String> {
        self.append_scope(&mut url, read);
        let body = body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|error| format!("Failed to serialize Consul request: {error}"))?;
        let mut request = self.http.request(method, url);
        if !self.config.token.is_empty() {
            request = request.header("X-Consul-Token", &self.config.token);
        }
        if let Some(body) = body {
            request = request.header(reqwest::header::CONTENT_TYPE, "application/json").body(body);
        }
        let response =
            request.send().await.map_err(|error| format!("Consul request failed: {}", error.without_url()))?;
        super::response::ensure_success(response, action, self.token()).await
    }

    pub(super) async fn request_json<R: DeserializeOwned, T: Serialize + ?Sized>(
        &self,
        method: Method,
        url: Url,
        body: Option<&T>,
        read: bool,
        action: &str,
    ) -> Result<R, String> {
        let response = self.send_json(method, url, body, read, action).await?;
        super::response::decode_json_response(response, action).await
    }

    pub(super) async fn request_json_unscoped<R: DeserializeOwned, T: Serialize + ?Sized>(
        &self,
        method: Method,
        url: Url,
        body: Option<&T>,
        action: &str,
    ) -> Result<R, String> {
        let body = body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|error| format!("Failed to serialize Consul request: {error}"))?;
        let mut request = self.request(method, url);
        if let Some(body) = body {
            request = request.header(reqwest::header::CONTENT_TYPE, "application/json").body(body);
        }
        let response =
            request.send().await.map_err(|error| format!("Consul request failed: {}", error.without_url()))?;
        let response = super::response::ensure_success(response, action, self.token()).await?;
        super::response::decode_json_response(response, action).await
    }

    pub(super) fn token(&self) -> &str {
        &self.config.token
    }

    pub(super) fn datacenter(&self) -> &str {
        &self.config.datacenter
    }

    pub(super) fn namespace(&self) -> &str {
        &self.config.namespace
    }

    pub(super) fn partition(&self) -> &str {
        &self.config.partition
    }

    pub fn scope(&self) -> ConsulScope {
        self.config.scope()
    }

    pub(super) fn config(&self) -> &ConsulConfig {
        &self.config
    }

    pub(super) fn operator_feature_enabled(&self, feature: &str) -> bool {
        match feature {
            "snapshot_restore" => self.config.operator_snapshot_restore_enabled,
            "autopilot" => self.config.operator_autopilot_write_enabled,
            "raft" => self.config.operator_raft_write_enabled,
            "keyring" => self.config.operator_keyring_write_enabled,
            "license" => self.config.operator_license_write_enabled,
            _ => false,
        }
    }
}

pub(super) async fn client_for_state(state: &AppState, connection_id: &str) -> Result<ConsulClient, String> {
    state.get_or_create_pool(connection_id, None).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id) {
        Some(PoolKind::Consul(client)) => Ok(client.clone()),
        Some(_) => Err("Connection is not a Consul connection".to_string()),
        None => Err("Connection not found".to_string()),
    }
}

pub(crate) async fn ensure_writable_core(state: &AppState, connection_id: &str, action: &str) -> Result<(), String> {
    if let Some(name) = crate::query::connection_readonly_name(state, connection_id).await {
        return Err(format!(
            "CONSUL_READ_ONLY: connection '{name}' has read-only protection enabled; {action} blocked"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::consul::test_support::serve_once;

    #[tokio::test]
    async fn connect_override_replaces_explicit_base_url_port() {
        let body = "[]";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let (mut base_url, request_rx) = serve_once(response).await;
        let tunnel_port = base_url.port().unwrap();
        base_url.set_host(Some("consul.internal")).unwrap();
        base_url.set_port(Some(1)).unwrap();
        let mut config = test_config("");
        config.base_url = base_url;
        config.connect_override = Some(("127.0.0.1".to_string(), tunnel_port));

        let client = ConsulClient::new(config).await.unwrap();
        assert_eq!(client.config.base_url.host_str(), Some("consul.internal"));
        assert_eq!(client.config.base_url.port(), Some(tunnel_port));
        client.probe().await.unwrap();

        let request = request_rx.await.unwrap();
        assert!(request.starts_with("GET /proxy/v1/kv/?"));
    }

    #[tokio::test]
    async fn direct_connection_preserves_base_url() {
        let config = test_config("");
        let expected = config.base_url.clone();

        let client = ConsulClient::new(config).await.unwrap();

        assert_eq!(client.config.base_url, expected);
    }

    #[test]
    fn preserves_proxy_path_scope_and_token_header() {
        let client = test_client("fixture-secret");
        let mut url = client.api_url("/v1/catalog/nodes").unwrap();
        client.append_scope(&mut url, true);
        let request = client.request(Method::GET, url).build().unwrap();
        assert_eq!(request.method(), Method::GET);
        assert_eq!(request.url().path(), "/proxy/v1/catalog/nodes");
        assert_eq!(request.url().query(), Some("dc=dc1&ns=ns1&partition=part1"));
        assert_eq!(request.headers().get("X-Consul-Token").unwrap(), "fixture-secret");
    }

    #[test]
    fn redacts_sensitive_error_fields() {
        let body = format!("SecretID=fixture-secret {}", "x".repeat(8_000));
        let redacted = super::super::response::redact_sensitive(&body[..4096], "fixture-secret");
        assert!(!redacted.contains("fixture-secret"));
        assert!(redacted.contains("[REDACTED]"));
        assert!(redacted.len() < 4_100);
    }

    #[test]
    fn operator_write_flags_are_independent_and_unknown_features_stay_disabled() {
        let mut client = test_client("");
        for feature in ["snapshot_restore", "autopilot", "raft", "keyring", "license", "unknown"] {
            assert!(!client.operator_feature_enabled(feature));
        }

        let cases = [("snapshot_restore", 0usize), ("autopilot", 1), ("raft", 2), ("keyring", 3), ("license", 4)];
        for (enabled_feature, enabled_index) in cases {
            client.config.operator_snapshot_restore_enabled = enabled_index == 0;
            client.config.operator_autopilot_write_enabled = enabled_index == 1;
            client.config.operator_raft_write_enabled = enabled_index == 2;
            client.config.operator_keyring_write_enabled = enabled_index == 3;
            client.config.operator_license_write_enabled = enabled_index == 4;
            for (feature, index) in
                ["snapshot_restore", "autopilot", "raft", "keyring", "license"].into_iter().zip(0usize..)
            {
                assert_eq!(client.operator_feature_enabled(feature), index == enabled_index, "{enabled_feature}");
            }
        }
    }

    fn test_client(token: &str) -> ConsulClient {
        ConsulClient { config: test_config(token), http: reqwest::Client::new() }
    }

    fn test_config(token: &str) -> ConsulConfig {
        ConsulConfig {
            base_url: Url::parse("http://127.0.0.1:8500/proxy").unwrap(),
            token: token.to_string(),
            datacenter: "dc1".to_string(),
            namespace: "ns1".to_string(),
            partition: "part1".to_string(),
            consistency: ConsulConsistency::Default,
            tls_skip_verify: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            connect_timeout_secs: 2,
            request_timeout_secs: 2,
            connect_override: None,
            agent_target: None,
            operator_snapshot_restore_enabled: false,
            operator_autopilot_write_enabled: false,
            operator_raft_write_enabled: false,
            operator_keyring_write_enabled: false,
            operator_license_write_enabled: false,
        }
    }
}
