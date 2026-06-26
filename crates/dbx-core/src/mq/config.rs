//! Parses the message queue admin configuration out of a `ConnectionConfig`.
//!
//! MQ admin connections reuse the generic `external_config` extension slot on
//! `ConnectionConfig` rather than adding top-level fields, keeping the 50+
//! database-type connection model untouched.

use serde::{Deserialize, Serialize};

use crate::models::connection::ConnectionConfig;
use crate::mq::auth::MqAuth;
use crate::mq::types::{MqSystemKind, MqTokenSigningConfig};

/// Runtime TCP endpoint override for MQ admin requests.
///
/// The public admin URL remains unchanged so TLS hostname verification, SNI and
/// the HTTP Host header continue to target the broker name. The HTTP client uses
/// this endpoint only for the underlying TCP connection, e.g. after an SSH/proxy
/// tunnel has mapped the broker to a local port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqConnectOverride {
    pub host: String,
    pub port: u16,
}

/// Configuration for an MQ admin connection, decoded from
/// `ConnectionConfig.external_config`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqAdminConfig {
    pub system_kind: MqSystemKind,
    /// Admin REST base URL, e.g. `http://broker:8080`.
    pub admin_url: String,
    #[serde(default)]
    pub auth: MqAuth,
    /// Skip TLS certificate verification (self-signed clusters only).
    #[serde(default)]
    pub tls_skip_verify: bool,
    /// Manually pin a server version (e.g. `3.1`), skipping auto-detection for
    /// environments where the version endpoint is blocked by a gateway.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_version: Option<String>,
    /// Optional local JWT signing configuration. This is used only by dbx to
    /// issue Pulsar client tokens; the signing key itself is stored through the
    /// connection secret path, not in plain connection JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_signing: Option<MqTokenSigningConfig>,
    /// Runtime-only TCP endpoint override used by transport layers.
    #[serde(skip)]
    pub connect_override: Option<MqConnectOverride>,
    /// System-specific extension fields (e.g. Kafka bootstrap servers).
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub extra: serde_json::Value,
}

impl MqAdminConfig {
    /// Decode the MQ admin config from a connection's `external_config` slot.
    pub fn from_connection(cfg: &ConnectionConfig) -> Result<Self, String> {
        let raw = cfg
            .external_config
            .as_ref()
            .ok_or("This connection has no message queue admin configuration (external_config is empty)")?;
        let mut parsed: MqAdminConfig = serde_json::from_value(raw.clone())
            .map_err(|e| format!("Failed to parse message queue admin config: {e}"))?;
        parsed.admin_url = parsed.admin_url.trim().to_string();
        if parsed.admin_url.is_empty() {
            return Err("Message queue admin URL is empty".to_string());
        }
        Ok(parsed)
    }

    pub fn token_signing_configured(&self) -> bool {
        self.token_signing.as_ref().is_some_and(MqTokenSigningConfig::is_configured)
    }

    pub fn with_admin_endpoint(mut self, host: &str, port: u16) -> Result<Self, String> {
        self.admin_url = admin_url_with_endpoint(&self.admin_url, host, port)?;
        Ok(self)
    }

    pub fn with_connect_override(mut self, host: &str, port: u16) -> Self {
        self.connect_override = Some(MqConnectOverride { host: host.to_string(), port });
        self
    }
}

pub fn admin_url_with_endpoint(admin_url: &str, host: &str, port: u16) -> Result<String, String> {
    let mut url = reqwest::Url::parse(admin_url).map_err(|e| format!("MQ Admin URL is invalid: {e}"))?;
    url.set_host(Some(host)).map_err(|_| format!("MQ Admin URL host is invalid: {host}"))?;
    url.set_port(Some(port)).map_err(|_| format!("MQ Admin URL port is invalid: {port}"))?;
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection_with_external(value: serde_json::Value) -> ConnectionConfig {
        let mut cfg = ConnectionConfig {
            id: "c1".to_string(),
            name: "mq".to_string(),
            db_type: crate::models::connection::DatabaseType::MessageQueue,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: String::new(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            attached_databases: Vec::new(),
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: crate::models::connection::default_keepalive_interval_secs(),
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: String::new(),
            redis_scan_page_size: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: Some(value),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
        };
        cfg.redis_key_separator = ":".to_string();
        cfg
    }

    #[test]
    fn parses_pulsar_config() {
        let cfg = connection_with_external(serde_json::json!({
            "systemKind": "pulsar",
            "adminUrl": "http://localhost:8080",
            "auth": { "kind": "none" }
        }));
        let mqc = MqAdminConfig::from_connection(&cfg).expect("should parse valid Pulsar config");
        assert_eq!(mqc.system_kind, MqSystemKind::Pulsar);
        assert_eq!(mqc.admin_url, "http://localhost:8080");
        assert!(matches!(mqc.auth, MqAuth::None));
    }

    #[test]
    fn errors_when_external_config_missing() {
        let mut cfg = connection_with_external(serde_json::Value::Null);
        cfg.external_config = None;
        assert!(MqAdminConfig::from_connection(&cfg).is_err());
    }

    #[test]
    fn errors_on_empty_admin_url() {
        let cfg = connection_with_external(serde_json::json!({
            "systemKind": "pulsar",
            "adminUrl": "   "
        }));
        assert!(MqAdminConfig::from_connection(&cfg).is_err());
    }

    #[test]
    fn admin_url_with_endpoint_preserves_scheme_path_and_query() {
        let rewritten =
            admin_url_with_endpoint("https://broker.internal:8443/pulsar-admin?tenant=public", "127.0.0.1", 49152)
                .expect("should rewrite admin URL with endpoint");

        assert_eq!(rewritten, "https://127.0.0.1:49152/pulsar-admin?tenant=public");
    }
}
