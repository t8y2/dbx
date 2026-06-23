use serde::{Deserialize, Serialize};

use crate::models::connection::ConnectionConfig;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NacosAuthConfig {
    None,
    UsernamePassword { username: String, password: String },
}

impl Default for NacosAuthConfig {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosAdminConfig {
    pub server_addr: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub context_path: String,
    #[serde(default)]
    pub auth: NacosAuthConfig,
    #[serde(default)]
    pub tls_skip_verify: bool,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
    #[serde(skip)]
    pub connect_override: Option<NacosConnectOverride>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NacosConnectOverride {
    pub host: String,
    pub port: u16,
}

pub fn default_page_size() -> u32 {
    20
}

impl NacosAdminConfig {
    pub fn from_connection(cfg: &ConnectionConfig) -> Result<Self, String> {
        let parsed = if let Some(raw) = cfg.external_config.as_ref() {
            serde_json::from_value::<NacosAdminConfig>(raw.clone())
                .map_err(|e| format!("Failed to parse Nacos admin config: {e}"))?
        } else {
            let scheme = if cfg.ssl { "https" } else { "http" };
            NacosAdminConfig {
                server_addr: format!("{scheme}://{}:{}", cfg.host.trim(), cfg.port),
                namespace: cfg.database.clone().unwrap_or_default(),
                context_path: String::new(),
                auth: if cfg.username.trim().is_empty() {
                    NacosAuthConfig::None
                } else {
                    NacosAuthConfig::UsernamePassword { username: cfg.username.clone(), password: cfg.password.clone() }
                },
                tls_skip_verify: false,
                page_size: default_page_size(),
                connect_override: None,
            }
        };
        parsed.validate()
    }

    pub fn validate(mut self) -> Result<Self, String> {
        self.server_addr = self.server_addr.trim().trim_end_matches('/').to_string();
        if self.server_addr.is_empty() {
            return Err("Nacos server address is empty".to_string());
        }
        self.context_path = normalize_context_path(&self.context_path);
        if self.page_size == 0 {
            self.page_size = default_page_size();
        }
        self.page_size = self.page_size.clamp(1, 500);
        Ok(self)
    }

    pub fn with_connect_override(mut self, host: &str, port: u16) -> Self {
        self.connect_override = Some(NacosConnectOverride { host: host.to_string(), port });
        self
    }
}

pub fn normalize_context_path(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::{default_keepalive_interval_secs, DatabaseType};

    fn connection_with_external(value: serde_json::Value) -> ConnectionConfig {
        ConnectionConfig {
            id: "nacos-1".to_string(),
            name: "Nacos".to_string(),
            db_type: DatabaseType::Nacos,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: "127.0.0.1".to_string(),
            port: 8848,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            attached_databases: Vec::new(),
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: default_keepalive_interval_secs(),
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
            redis_key_separator: ":".to_string(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: Some(value),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
        }
    }

    #[test]
    fn parses_external_config() {
        let cfg = connection_with_external(serde_json::json!({
            "serverAddr": " http://127.0.0.1:8848/ ",
            "namespace": "public",
            "contextPath": "nacos",
            "pageSize": 100,
            "auth": { "kind": "usernamePassword", "username": "nacos", "password": "pw" }
        }));

        let parsed = NacosAdminConfig::from_connection(&cfg).unwrap();
        assert_eq!(parsed.server_addr, "http://127.0.0.1:8848");
        assert_eq!(parsed.context_path, "/nacos");
        assert_eq!(parsed.page_size, 100);
        assert_eq!(parsed.namespace, "public");
    }

    #[test]
    fn missing_external_context_path_defaults_to_root() {
        let cfg = connection_with_external(serde_json::json!({
            "serverAddr": "http://127.0.0.1:8848",
            "auth": { "kind": "none" }
        }));

        let parsed = NacosAdminConfig::from_connection(&cfg).unwrap();
        assert_eq!(parsed.context_path, "");
    }

    #[test]
    fn falls_back_to_connection_fields() {
        let mut cfg = connection_with_external(serde_json::Value::Null);
        cfg.external_config = None;
        cfg.username = "nacos".to_string();
        cfg.password = "pw".to_string();
        let parsed = NacosAdminConfig::from_connection(&cfg).unwrap();
        assert_eq!(parsed.server_addr, "http://127.0.0.1:8848");
        assert_eq!(parsed.context_path, "");
        assert!(matches!(parsed.auth, NacosAuthConfig::UsernamePassword { .. }));
    }
}
