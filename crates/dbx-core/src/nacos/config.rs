use serde::{Deserialize, Serialize};

use crate::models::connection::ConnectionConfig;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[derive(Default)]
pub enum NacosAuthConfig {
    #[default]
    None,
    UsernamePassword {
        username: String,
        password: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum NacosImplementation {
    #[default]
    Nacos,
    #[serde(rename = "rnacos")]
    RNacos,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum NacosVersionMode {
    #[default]
    Auto,
    V2,
    V3,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NacosRNacosConsoleAuth {
    #[default]
    Inherit,
    UsernamePassword {
        username: String,
        password: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NacosAdminConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub implementation: Option<NacosImplementation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_mode: Option<NacosVersionMode>,
    pub server_addr: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub display_server_addr: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub context_path: String,
    /// Optional r-nacos authenticated-console address. This is separate from
    /// the OpenAPI server address because r-nacos exposes console-only APIs
    /// (including config history) on its console service, normally port 10848.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub rnacos_console_addr: String,
    /// `None` preserves legacy records where supplying a console address
    /// implicitly enabled configuration history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rnacos_history_enabled: Option<bool>,
    #[serde(default)]
    pub rnacos_console_auth: NacosRNacosConsoleAuth,
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
                implementation: None,
                version_mode: None,
                server_addr: format!("{scheme}://{}:{}", cfg.host.trim(), cfg.port),
                display_server_addr: String::new(),
                namespace: cfg.database.clone().unwrap_or_default(),
                context_path: String::new(),
                rnacos_console_addr: String::new(),
                rnacos_history_enabled: None,
                rnacos_console_auth: NacosRNacosConsoleAuth::Inherit,
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
        self.server_addr = normalize_endpoint_url(&self.server_addr, "Nacos server address")?;
        if self.server_addr.is_empty() {
            return Err("Nacos server address is empty".to_string());
        }
        if self.display_server_addr.trim().is_empty() {
            self.display_server_addr = self.server_addr.clone();
        } else {
            self.display_server_addr = normalize_endpoint_url(&self.display_server_addr, "Nacos display address")?;
        }
        self.context_path = normalize_context_path(&self.context_path);
        self.rnacos_console_addr = if self.rnacos_console_addr.trim().is_empty() {
            String::new()
        } else {
            normalize_endpoint_url(&self.rnacos_console_addr, "r-nacos console address")?
        };
        if !self.rnacos_console_addr.is_empty() {
            // Normalization above validates the URL and rejects userinfo.
        }
        if let NacosRNacosConsoleAuth::UsernamePassword { username, .. } = &self.rnacos_console_auth {
            if username.trim().is_empty() {
                return Err("r-nacos console username is empty".to_string());
            }
        }
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

    pub fn with_server_endpoint(mut self, host: &str, port: u16) -> Result<Self, String> {
        let mut url =
            reqwest::Url::parse(&self.server_addr).map_err(|e| format!("Nacos server address is invalid: {e}"))?;
        url.set_host(Some(host)).map_err(|_| format!("Nacos server address host is invalid: {host}"))?;
        url.set_port(Some(port)).map_err(|_| format!("Nacos server address port is invalid: {port}"))?;
        self.server_addr = url.to_string().trim_end_matches('/').to_string();
        self.connect_override = None;
        Ok(self)
    }

    pub fn with_rnacos_console_endpoint(mut self, host: &str, port: u16) -> Result<Self, String> {
        let mut url = reqwest::Url::parse(&self.rnacos_console_addr)
            .map_err(|e| format!("r-nacos console address is invalid: {e}"))?;
        url.set_host(Some(host)).map_err(|_| format!("r-nacos console address host is invalid: {host}"))?;
        url.set_port(Some(port)).map_err(|_| format!("r-nacos console address port is invalid: {port}"))?;
        self.rnacos_console_addr = url.to_string().trim_end_matches('/').to_string();
        Ok(self)
    }

    pub fn rnacos_history_enabled(&self) -> bool {
        self.rnacos_history_enabled.unwrap_or(!self.rnacos_console_addr.is_empty())
    }

    pub fn effective_rnacos_console_credentials(&self) -> Result<(&str, &str), String> {
        match &self.rnacos_console_auth {
            NacosRNacosConsoleAuth::Inherit => match &self.auth {
                NacosAuthConfig::UsernamePassword { username, password } if !username.trim().is_empty() => {
                    Ok((username, password))
                }
                _ => Err("r-nacos console credentials are unavailable".to_string()),
            },
            NacosRNacosConsoleAuth::UsernamePassword { username, password } => {
                if username.trim().is_empty() {
                    return Err("r-nacos console username is empty".to_string());
                }
                Ok((username, password))
            }
        }
    }

    pub fn has_effective_rnacos_console_credentials(&self) -> bool {
        match &self.rnacos_console_auth {
            NacosRNacosConsoleAuth::Inherit => {
                matches!(&self.auth, NacosAuthConfig::UsernamePassword { username, .. } if !username.trim().is_empty())
            }
            NacosRNacosConsoleAuth::UsernamePassword { username, .. } => !username.trim().is_empty(),
        }
    }
}

fn normalize_endpoint_url(value: &str, label: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(value.trim()).map_err(|e| format!("{label} is invalid: {e}"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{label} must not contain embedded credentials"));
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
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
            agent_java_options: Vec::new(),
            host: "127.0.0.1".to_string(),
            port: 8848,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            attached_databases: Vec::new(),
            init_script: None,
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
            redis_scan_page_size: None,
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
    fn parses_rnacos_console_address() {
        let cfg = connection_with_external(serde_json::json!({
            "serverAddr": "http://127.0.0.1:8848",
            "rnacosConsoleAddr": " http://127.0.0.1:10848/ ",
        }));

        let parsed = NacosAdminConfig::from_connection(&cfg).unwrap();
        assert_eq!(parsed.rnacos_console_addr, "http://127.0.0.1:10848");
    }

    #[test]
    fn accepts_optional_profile_fields_and_rejects_endpoint_userinfo() {
        let parsed = NacosAdminConfig::from_connection(&connection_with_external(serde_json::json!({
            "implementation": "rnacos",
            "versionMode": "auto",
            "serverAddr": "http://127.0.0.1:8848",
            "rnacosConsoleAddr": "http://127.0.0.1:10848/rnacos/",
            "rnacosHistoryEnabled": true,
            "rnacosConsoleAuth": { "kind": "usernamePassword", "username": "console", "password": "secret" }
        })))
        .unwrap();
        assert!(parsed.rnacos_history_enabled());
        assert_eq!(parsed.effective_rnacos_console_credentials().unwrap().0, "console");

        let err = NacosAdminConfig::from_connection(&connection_with_external(serde_json::json!({
            "serverAddr": "http://user:secret@127.0.0.1:8848"
        })))
        .unwrap_err();
        assert!(err.contains("must not contain embedded credentials"));
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

    #[test]
    fn with_server_endpoint_rewrites_only_host_and_port() {
        let cfg = connection_with_external(serde_json::json!({
            "serverAddr": "https://192.168.2.51:10840/nacos",
            "namespace": "public",
            "contextPath": "/console",
            "auth": { "kind": "none" }
        }));

        let parsed = NacosAdminConfig::from_connection(&cfg).unwrap().with_server_endpoint("127.0.0.1", 49152).unwrap();

        assert_eq!(parsed.server_addr, "https://127.0.0.1:49152/nacos");
        assert_eq!(parsed.context_path, "/console");
        assert!(parsed.connect_override.is_none());
    }

    #[test]
    fn with_rnacos_console_endpoint_rewrites_only_host_and_port() {
        let cfg = connection_with_external(serde_json::json!({
            "serverAddr": "https://192.168.2.51:8848",
            "rnacosConsoleAddr": "https://192.168.2.51:10848/gateway",
            "auth": { "kind": "none" }
        }));

        let parsed =
            NacosAdminConfig::from_connection(&cfg).unwrap().with_rnacos_console_endpoint("127.0.0.1", 49153).unwrap();

        assert_eq!(parsed.rnacos_console_addr, "https://127.0.0.1:49153/gateway");
    }
}
