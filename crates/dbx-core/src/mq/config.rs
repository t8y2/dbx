//! Parses the message queue admin configuration out of a `ConnectionConfig`.
//!
//! MQ admin connections reuse the generic `external_config` extension slot on
//! `ConnectionConfig` rather than adding top-level fields, keeping the 50+
//! database-type connection model untouched.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::models::connection::ConnectionConfig;
use crate::mq::auth::MqAuth;
use crate::mq::types::{MqSystemKind, MqTokenSigningConfig};

/// Default query timeout when constructing test configs without a ConnectionConfig.
pub const DEFAULT_MQ_QUERY_TIMEOUT_SECS: u64 = 30;
/// Default connect timeout when constructing test configs without a ConnectionConfig.
pub const DEFAULT_MQ_CONNECT_TIMEOUT_SECS: u64 = 10;

/// Runtime TCP endpoint override for an MQ transport.
///
/// The logical broker endpoint remains unchanged so TLS hostname verification,
/// SNI and protocol-level host names continue to target the broker. The client
/// uses this endpoint only for the underlying TCP connection, e.g. after an
/// SSH/proxy tunnel has mapped the broker to a local port.
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
    /// Runtime-only TCP endpoint override for a secondary management endpoint.
    /// RabbitMQ uses this in addition to the AMQP `connect_override` because
    /// its Management HTTP API listens on an independently configured port.
    #[serde(skip)]
    pub management_connect_override: Option<MqConnectOverride>,
    /// Runtime-only: from `ConnectionConfig.query_timeout_secs` (`0` = unlimited).
    #[serde(skip)]
    pub query_timeout_secs: u64,
    /// Runtime-only: from `ConnectionConfig.effective_connect_timeout_secs()`.
    #[serde(skip)]
    pub connect_timeout_secs: u64,
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
        // Kafka, RocketMQ and RabbitMQ use namesrv/bootstrap/addresses from `extra` instead of an admin URL.
        if parsed.admin_url.is_empty()
            && parsed.system_kind != MqSystemKind::Kafka
            && parsed.system_kind != MqSystemKind::RocketMq
            && parsed.system_kind != MqSystemKind::RabbitMq
        {
            return Err("Message queue admin URL is empty".to_string());
        }
        // Advanced connection timeouts live on ConnectionConfig, not external_config.
        parsed.query_timeout_secs = cfg.effective_query_timeout_secs();
        parsed.connect_timeout_secs = cfg.effective_connect_timeout_secs();
        Ok(parsed)
    }

    /// Agent / HTTP RPC wall-clock timeout. `None` disables the client-side timeout.
    pub fn rpc_timeout(&self) -> Option<Duration> {
        if self.query_timeout_secs == 0 {
            None
        } else {
            Some(Duration::from_secs(self.query_timeout_secs.max(1)))
        }
    }

    /// Milliseconds for agent `request_timeout_ms`. Unlimited query timeout maps to a
    /// large but finite admin request budget so Java/Go clients still make progress.
    pub fn request_timeout_ms(&self) -> u64 {
        match self.query_timeout_secs {
            0 => 3_600_000,
            secs => secs.saturating_mul(1000).max(1_000),
        }
    }

    /// Budget for establishing the MQ adapter (agent spawn + handshake/connect).
    pub fn connect_timeout(&self) -> Duration {
        Duration::from_secs(self.connect_timeout_secs.max(1))
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

    pub fn with_management_connect_override(mut self, host: &str, port: u16) -> Self {
        self.management_connect_override = Some(MqConnectOverride { host: host.to_string(), port });
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
            note: String::new(),
            db_type: crate::models::connection::DatabaseType::MessageQueue,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: String::new(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
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
            redis_database_aliases: Default::default(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: Some(value),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
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
    fn parses_kafka_config_with_empty_admin_url() {
        let cfg = connection_with_external(serde_json::json!({
            "systemKind": "kafka",
            "adminUrl": "",
            "auth": { "kind": "none" },
            "extra": {
                "bootstrapServers": "broker1:9092,broker2:9092"
            }
        }));
        let mqc = MqAdminConfig::from_connection(&cfg).expect("should parse valid Kafka config");
        assert_eq!(mqc.system_kind, MqSystemKind::Kafka);
        assert_eq!(mqc.admin_url, "");
        assert_eq!(mqc.extra.get("bootstrapServers").and_then(|v| v.as_str()), Some("broker1:9092,broker2:9092"));
    }

    #[test]
    fn parses_rocketmq_config_with_empty_admin_url() {
        let cfg = connection_with_external(serde_json::json!({
            "systemKind": "rocketmq",
            "adminUrl": "",
            "auth": { "kind": "none" },
            "extra": {
                "namesrvAddr": "127.0.0.1:9876"
            }
        }));
        let mqc = MqAdminConfig::from_connection(&cfg).expect("should parse valid RocketMQ config");
        assert_eq!(mqc.system_kind, MqSystemKind::RocketMq);
        assert_eq!(mqc.admin_url, "");
        assert_eq!(mqc.extra.get("namesrvAddr").and_then(|v| v.as_str()), Some("127.0.0.1:9876"));
        assert_eq!(mqc.query_timeout_secs, 30);
        assert_eq!(mqc.connect_timeout_secs, 5);
        assert_eq!(mqc.request_timeout_ms(), 30_000);
    }

    #[test]
    fn copies_advanced_timeouts_from_connection_config() {
        let mut cfg = connection_with_external(serde_json::json!({
            "systemKind": "rocketmq",
            "adminUrl": "",
            "extra": { "namesrvAddr": "127.0.0.1:9876" }
        }));
        cfg.query_timeout_secs = 120;
        cfg.connect_timeout_secs = 15;
        let mqc = MqAdminConfig::from_connection(&cfg).expect("parse");
        assert_eq!(mqc.query_timeout_secs, 120);
        assert_eq!(mqc.connect_timeout_secs, 15);
        assert_eq!(mqc.request_timeout_ms(), 120_000);
        assert_eq!(mqc.rpc_timeout(), Some(std::time::Duration::from_secs(120)));
    }

    #[test]
    fn parses_rabbitmq_config_with_empty_admin_url() {
        let cfg = connection_with_external(serde_json::json!({
            "systemKind": "rabbitmq",
            "adminUrl": "",
            "auth": { "kind": "basic", "username": "guest", "password": "guest" },
            "extra": {
                "addresses": "127.0.0.1",
                "port": 5672,
                "virtualHost": "/"
            }
        }));
        let mqc = MqAdminConfig::from_connection(&cfg).expect("should parse valid RabbitMQ config");
        assert_eq!(mqc.system_kind, MqSystemKind::RabbitMq);
        assert_eq!(mqc.admin_url, "");
        assert_eq!(mqc.extra.get("addresses").and_then(|v| v.as_str()), Some("127.0.0.1"));
        assert_eq!(mqc.extra.get("virtualHost").and_then(|v| v.as_str()), Some("/"));
    }

    #[test]
    fn parses_rabbitmq_config_with_management_admin_url() {
        // An explicit management URL stays untouched: it may carry a reverse
        // proxy path prefix, and no http(s)-only scheme restriction applies.
        let cfg = connection_with_external(serde_json::json!({
            "systemKind": "rabbitmq",
            "adminUrl": "http://rabbit.internal:15672/proxy",
            "auth": { "kind": "basic", "username": "guest", "password": "guest" },
            "extra": {
                "addresses": "127.0.0.1",
                "port": 5672,
                "virtualHost": "/"
            }
        }));
        let mqc = MqAdminConfig::from_connection(&cfg).expect("should parse RabbitMQ config with a management URL");
        assert_eq!(mqc.system_kind, MqSystemKind::RabbitMq);
        assert_eq!(mqc.admin_url, "http://rabbit.internal:15672/proxy");
        assert_eq!(mqc.extra.get("addresses").and_then(|v| v.as_str()), Some("127.0.0.1"));
    }

    #[test]
    fn admin_url_with_endpoint_preserves_scheme_path_and_query() {
        let rewritten =
            admin_url_with_endpoint("https://broker.internal:8443/pulsar-admin?tenant=public", "127.0.0.1", 49152)
                .expect("should rewrite admin URL with endpoint");

        assert_eq!(rewritten, "https://127.0.0.1:49152/pulsar-admin?tenant=public");
    }
}
