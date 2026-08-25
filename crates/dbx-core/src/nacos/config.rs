use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::models::connection::{ConnectionConfig, DatabaseType};

pub const NACOS_PRIMARY_SESSION_PASSWORD: &str = "nacos-primary-password";
pub const NACOS_CONSOLE_SESSION_PASSWORD: &str = "nacos-console-password";

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum NacosApiPlane {
    #[default]
    Admin,
    Console,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum NacosMetricsMode {
    #[default]
    Auto,
    Disabled,
    Custom,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_plane: Option<NacosApiPlane>,
    pub server_addr: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub display_server_addr: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub context_path: String,
    /// Namespace IDs supplied for an official Nacos ordinary user that cannot
    /// call the namespace or authorization management APIs. They define the
    /// discoverable scope; Nacos still authorizes every configuration and
    /// naming request.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub managed_namespaces: Vec<String>,
    /// Optional r-nacos authenticated-console address. This is separate from
    /// the OpenAPI server address because r-nacos exposes console-only APIs
    /// (including config history plus config type and description metadata) on
    /// its console service, normally port 10848.
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
    #[serde(default)]
    pub metrics_mode: NacosMetricsMode,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub metrics_url: String,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
    #[serde(skip)]
    pub connect_override: Option<NacosConnectOverride>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct NacosTransientPasswords {
    pub primary: Option<String>,
    pub console: Option<String>,
}

fn take_username_password(value: Option<&mut serde_json::Value>) -> Option<String> {
    let auth = value?.as_object_mut()?;
    if auth.get("kind").and_then(serde_json::Value::as_str) != Some("usernamePassword") {
        return None;
    }
    let password = auth.get_mut("password")?;
    let secret = password.as_str()?.to_string();
    *password = serde_json::Value::String(String::new());
    (!secret.is_empty()).then_some(secret)
}

/// Removes no-save Nacos passwords from a runtime configuration and returns
/// them for placement in the owner-scoped in-memory credential store.
pub fn take_transient_passwords(config: &mut ConnectionConfig) -> NacosTransientPasswords {
    if config.db_type != DatabaseType::Nacos || config.save_password {
        return NacosTransientPasswords::default();
    }

    let top_level_password = std::mem::take(&mut config.password);
    let Some(external) = config.external_config.as_mut().and_then(serde_json::Value::as_object_mut) else {
        return NacosTransientPasswords {
            primary: (!top_level_password.is_empty()).then_some(top_level_password),
            console: None,
        };
    };

    NacosTransientPasswords {
        // NacosAdminConfig::from_connection treats external_config as the
        // canonical source when present, so a stale top-level password must
        // never override an explicitly empty external auth password.
        primary: take_username_password(external.get_mut("auth")),
        console: take_username_password(external.get_mut("rnacosConsoleAuth")),
    }
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
    /// Binds short-lived, destructive workflows to the exact Nacos target and
    /// credentials that created them. The digest is never exposed or persisted.
    pub fn operation_fingerprint(&self) -> String {
        let encoded = serde_json::to_vec(self).expect("NacosAdminConfig serialization must succeed");
        format!("{:x}", Sha256::digest(encoded))
    }

    pub fn from_connection(cfg: &ConnectionConfig) -> Result<Self, String> {
        let parsed = if let Some(raw) = cfg.external_config.as_ref() {
            serde_json::from_value::<NacosAdminConfig>(raw.clone())
                .map_err(|e| format!("Failed to parse Nacos admin config: {e}"))?
        } else {
            let scheme = if cfg.ssl { "https" } else { "http" };
            NacosAdminConfig {
                implementation: None,
                version_mode: None,
                api_plane: None,
                server_addr: format!("{scheme}://{}:{}", cfg.host.trim(), cfg.port),
                display_server_addr: String::new(),
                namespace: cfg.database.clone().unwrap_or_default(),
                context_path: String::new(),
                managed_namespaces: Vec::new(),
                rnacos_console_addr: String::new(),
                rnacos_history_enabled: None,
                rnacos_console_auth: NacosRNacosConsoleAuth::Inherit,
                auth: if cfg.username.trim().is_empty() {
                    NacosAuthConfig::None
                } else {
                    NacosAuthConfig::UsernamePassword { username: cfg.username.clone(), password: cfg.password.clone() }
                },
                tls_skip_verify: false,
                metrics_mode: NacosMetricsMode::Auto,
                metrics_url: String::new(),
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
        let context_path_is_explicit_root = self.context_path.trim() == "/";
        self.context_path = normalize_context_path(&self.context_path);
        // Nacos 3 management uses the server-side Admin API, normally
        // `:8848/nacos`. Keep the documented default context for explicit V3
        // profiles while preserving custom reverse-proxy prefixes.
        if self.context_path.is_empty()
            && !context_path_is_explicit_root
            && matches!(self.implementation, Some(NacosImplementation::Nacos))
            && matches!(self.version_mode, Some(NacosVersionMode::V3))
            && self.api_plane() == NacosApiPlane::Admin
        {
            self.context_path = "/nacos".to_string();
        }
        let mut managed_namespaces = Vec::new();
        for namespace in std::mem::take(&mut self.managed_namespaces) {
            let namespace = namespace.trim().to_string();
            if !namespace.is_empty() && !managed_namespaces.contains(&namespace) {
                managed_namespaces.push(namespace);
            }
        }
        self.managed_namespaces = managed_namespaces;
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
        self.metrics_url = match self.metrics_mode {
            NacosMetricsMode::Custom => normalize_metrics_url(&self.metrics_url)?,
            NacosMetricsMode::Auto | NacosMetricsMode::Disabled => String::new(),
        };
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

    pub fn api_plane(&self) -> NacosApiPlane {
        self.api_plane.unwrap_or_default()
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

fn normalize_metrics_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Nacos Prometheus metrics URL is empty".to_string());
    }
    let url = reqwest::Url::parse(value).map_err(|e| format!("Nacos Prometheus metrics URL is invalid: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Nacos Prometheus metrics URL must use http or https".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Nacos Prometheus metrics URL must not contain embedded credentials".to_string());
    }
    if url.fragment().is_some() {
        return Err("Nacos Prometheus metrics URL must not contain a fragment".to_string());
    }
    Ok(url.to_string())
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
            docs_notes_path: None,
            id: "nacos-1".to_string(),
            name: "Nacos".to_string(),
            note: String::new(),
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
            default_schema: None,
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
            redis_database_aliases: Default::default(),
            redis_key_templates: Vec::new(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: Some(value),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            save_password: true,
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
    fn normalizes_managed_namespaces() {
        let cfg = connection_with_external(serde_json::json!({
            "implementation": "nacos",
            "versionMode": "v3",
            "serverAddr": "http://127.0.0.1:8818",
            "managedNamespaces": [" public ", "team-a", "team-a", ""],
        }));

        let parsed = NacosAdminConfig::from_connection(&cfg).unwrap();
        assert_eq!(parsed.managed_namespaces, vec!["public", "team-a"]);
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
    fn defaults_prometheus_metrics_to_auto_and_validates_custom_urls() {
        let parsed = NacosAdminConfig::from_connection(&connection_with_external(serde_json::json!({
            "serverAddr": "http://127.0.0.1:8818"
        })))
        .unwrap();
        assert_eq!(parsed.metrics_mode, NacosMetricsMode::Auto);
        assert!(parsed.metrics_url.is_empty());

        let parsed = NacosAdminConfig::from_connection(&connection_with_external(serde_json::json!({
            "serverAddr": "http://127.0.0.1:8848",
            "metricsMode": "custom",
            "metricsUrl": "http://127.0.0.1:8818/nacos/actuator/prometheus?node=a"
        })))
        .unwrap();
        assert_eq!(parsed.metrics_mode, NacosMetricsMode::Custom);
        assert_eq!(parsed.metrics_url, "http://127.0.0.1:8818/nacos/actuator/prometheus?node=a");

        for metrics_url in [
            "",
            "file:///tmp/metrics",
            "http://user:secret@127.0.0.1:8818/metrics",
            "http://127.0.0.1:8818/metrics#private",
            "http://127.0.0.1:8818/metrics#",
        ] {
            let error = NacosAdminConfig::from_connection(&connection_with_external(serde_json::json!({
                "serverAddr": "http://127.0.0.1:8848",
                "metricsMode": "custom",
                "metricsUrl": metrics_url
            })))
            .unwrap_err();
            assert!(error.contains("Prometheus metrics URL"));
        }
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
    fn explicit_nacos_v3_defaults_to_server_admin_context() {
        let cfg = connection_with_external(serde_json::json!({
            "implementation": "nacos",
            "versionMode": "v3",
            "serverAddr": "http://127.0.0.1:8848",
            "auth": { "kind": "none" }
        }));

        let parsed = NacosAdminConfig::from_connection(&cfg).unwrap();
        assert_eq!(parsed.context_path, "/nacos");
    }

    #[test]
    fn explicit_nacos_v3_console_defaults_to_root_context() {
        let cfg = connection_with_external(serde_json::json!({
            "implementation": "nacos",
            "versionMode": "v3",
            "apiPlane": "console",
            "serverAddr": "http://127.0.0.1:8080",
            "auth": { "kind": "none" }
        }));

        let parsed = NacosAdminConfig::from_connection(&cfg).unwrap();
        assert_eq!(parsed.api_plane(), NacosApiPlane::Console);
        assert_eq!(parsed.context_path, "");
    }

    #[test]
    fn explicit_nacos_v3_root_context_is_preserved() {
        let cfg = connection_with_external(serde_json::json!({
            "implementation": "nacos",
            "versionMode": "v3",
            "serverAddr": "http://127.0.0.1:8848",
            "contextPath": "/",
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
    fn takes_no_save_external_passwords_without_removing_other_fields() {
        let mut cfg = connection_with_external(serde_json::json!({
            "implementation": "rnacos",
            "serverAddr": "http://127.0.0.1:8848",
            "managedNamespaces": ["team-a"],
            "auth": { "kind": "usernamePassword", "username": "primary", "password": "primary-secret" },
            "rnacosConsoleAuth": { "kind": "usernamePassword", "username": "console", "password": "console-secret" }
        }));
        cfg.save_password = false;
        cfg.password = "stale-top-level-secret".to_string();

        let passwords = take_transient_passwords(&mut cfg);

        assert_eq!(passwords.primary.as_deref(), Some("primary-secret"));
        assert_eq!(passwords.console.as_deref(), Some("console-secret"));
        assert!(cfg.password.is_empty());
        let external = cfg.external_config.as_ref().unwrap();
        assert_eq!(external["auth"]["password"], "");
        assert_eq!(external["rnacosConsoleAuth"]["password"], "");
        assert_eq!(external["managedNamespaces"], serde_json::json!(["team-a"]));
    }

    #[test]
    fn takes_legacy_top_level_password_only_without_external_config() {
        let mut cfg = connection_with_external(serde_json::Value::Null);
        cfg.external_config = None;
        cfg.save_password = false;
        cfg.password = "legacy-secret".to_string();

        let passwords = take_transient_passwords(&mut cfg);

        assert_eq!(passwords.primary.as_deref(), Some("legacy-secret"));
        assert_eq!(passwords.console, None);
        assert!(cfg.password.is_empty());
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
