use std::fmt;

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::connection::ConnectionConfig;

const AWS_PARTITION_DOMAIN: &str = "amazonaws.com";
const AWS_CHINA_PARTITION_DOMAIN: &str = "amazonaws.com.cn";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum S3AddressingStyle {
    Auto,
    Path,
    VirtualHosted,
}

impl Default for S3AddressingStyle {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct S3Config {
    pub endpoint: Url,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: String,
    pub addressing_style: S3AddressingStyle,
    pub default_bucket: String,
    pub tls_skip_verify: bool,
    pub connect_timeout_secs: u64,
    pub request_timeout_secs: u64,
    pub connect_override: Option<(String, u16)>,
}

impl fmt::Debug for S3Config {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("S3Config")
            .field("endpoint", &self.endpoint)
            .field("region", &self.region)
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &redact(&self.secret_access_key))
            .field("session_token", &redact(&self.session_token))
            .field("addressing_style", &self.addressing_style)
            .field("default_bucket", &self.default_bucket)
            .field("tls_skip_verify", &self.tls_skip_verify)
            .field("connect_timeout_secs", &self.connect_timeout_secs)
            .field("request_timeout_secs", &self.request_timeout_secs)
            .field("connect_override", &self.connect_override)
            .finish()
    }
}

impl S3Config {
    pub fn from_connection(connection: &ConnectionConfig) -> Result<Self, String> {
        let external = connection.external_config.as_ref();
        let region = external_string(external, &["region"]).unwrap_or_else(|| "us-east-1".to_string());
        if region.is_empty() {
            return Err("S3 region is required".to_string());
        }
        let access_key_id = connection.username.trim().to_string();
        let secret_access_key = connection.password.trim().to_string();
        if access_key_id.is_empty() || secret_access_key.is_empty() {
            return Err("S3 access key ID and secret access key are required".to_string());
        }
        let endpoint = parse_endpoint(connection, &region)?;
        let addressing_style = parse_addressing_style(external)?;
        Ok(Self {
            endpoint,
            region,
            access_key_id,
            secret_access_key,
            session_token: external_string(external, &["sessionToken", "session_token"]).unwrap_or_default(),
            addressing_style,
            default_bucket: connection.database.clone().unwrap_or_default().trim().to_string(),
            tls_skip_verify: external_bool(external, &["tlsSkipVerify", "tls_skip_verify"]).unwrap_or(false),
            connect_timeout_secs: connection.effective_connect_timeout_secs(),
            request_timeout_secs: connection.effective_query_timeout_secs(),
            connect_override: None,
        })
    }

    pub fn from_agent_params(params: &Value) -> Result<Self, String> {
        let host = params.get("host").and_then(Value::as_str).unwrap_or_default().to_string();
        let port = params.get("port").and_then(Value::as_u64).unwrap_or(443) as u16;
        let username = params.get("username").and_then(Value::as_str).unwrap_or_default().trim().to_string();
        let password = params.get("password").and_then(Value::as_str).unwrap_or_default().trim().to_string();
        let database =
            params.get("database").and_then(Value::as_str).map(str::to_string).filter(|value| !value.is_empty());
        let ssl = params.get("ssl").and_then(Value::as_bool).unwrap_or(true);
        let connect_timeout_secs = params.get("connect_timeout_secs").and_then(Value::as_u64).unwrap_or(5);
        let query_timeout_secs = params.get("query_timeout_secs").and_then(Value::as_u64).unwrap_or(30);
        let external_config = params.get("external_config").cloned();
        let connection = ConnectionConfig {
            id: "s3-agent".to_string(),
            name: "s3-agent".to_string(),
            note: String::new(),
            db_type: crate::models::connection::DatabaseType::S3,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host,
            port,
            username,
            password,
            database,
            default_schema: None,
            visible_databases: None,
            visible_database_patterns: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            docs_notes_path: None,
            transport_layers: Vec::new(),
            connect_timeout_secs,
            query_timeout_secs,
            idle_timeout_secs: 60,
            keepalive_interval_secs: crate::models::connection::default_keepalive_interval_secs(),
            ssl,
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
            redis_key_templates: Vec::new(),
            redis_database_aliases: std::collections::HashMap::new(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            save_password: true,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        };
        Self::from_connection(&connection)
    }

    pub fn with_connect_override(mut self, host: impl Into<String>, port: u16) -> Self {
        self.connect_override = Some((host.into(), port));
        self
    }

    pub fn uses_path_style(&self, bucket: Option<&str>) -> bool {
        match self.addressing_style {
            S3AddressingStyle::Path => true,
            S3AddressingStyle::VirtualHosted => false,
            S3AddressingStyle::Auto => {
                if bucket.is_none() {
                    return true;
                }
                let host = self.endpoint.host_str().unwrap_or_default();
                !is_aws_endpoint_host(host)
            }
        }
    }

    pub fn signing_host(&self) -> String {
        self.endpoint.host_str().unwrap_or_default().to_string()
    }
}

pub fn default_aws_endpoint(region: &str) -> String {
    let domain = if is_china_region(region) { AWS_CHINA_PARTITION_DOMAIN } else { AWS_PARTITION_DOMAIN };
    format!("https://s3.{region}.{domain}")
}

pub fn is_china_region(region: &str) -> bool {
    region == "cn-north-1" || region == "cn-northwest-1"
}

fn parse_endpoint(connection: &ConnectionConfig, region: &str) -> Result<Url, String> {
    let external = connection.external_config.as_ref();
    let raw = external_string(external, &["endpoint", "serverAddr", "server_addr"])
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if connection.host.trim().is_empty() {
                default_aws_endpoint(region)
            } else {
                let scheme = if connection.ssl { "https" } else { "http" };
                let host = connection.host.trim();
                if connection.port == 0 || connection.port == default_port_for_scheme(connection.ssl) {
                    format!("{scheme}://{host}")
                } else {
                    format!("{scheme}://{host}:{}", connection.port)
                }
            }
        });
    let mut url = Url::parse(&raw).map_err(|error| format!("S3 endpoint is invalid: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("S3 endpoint must use http or https".to_string());
    }
    if url.host_str().is_none() {
        return Err("S3 endpoint must include a host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("S3 endpoint must not contain embedded credentials".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("S3 endpoint must not contain a query or fragment".to_string());
    }
    url.set_path("");
    Ok(url)
}

fn parse_addressing_style(external: Option<&serde_json::Value>) -> Result<S3AddressingStyle, String> {
    if let Some(value) = external_string(external, &["addressingStyle", "addressing_style"]) {
        return match value.to_ascii_lowercase().as_str() {
            "auto" | "" => Ok(S3AddressingStyle::Auto),
            "path" => Ok(S3AddressingStyle::Path),
            "virtual" | "virtual-hosted" | "virtualhosted" => Ok(S3AddressingStyle::VirtualHosted),
            other => Err(format!("Unsupported S3 addressing style: {other}")),
        };
    }
    if external_bool(external, &["forcePathStyle", "force_path_style", "pathStyle", "path_style"]).unwrap_or(false) {
        return Ok(S3AddressingStyle::Path);
    }
    Ok(S3AddressingStyle::Auto)
}

pub(crate) fn is_aws_endpoint_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "s3.amazonaws.com"
        || host.ends_with(".amazonaws.com")
        || host.ends_with(".amazonaws.com.cn")
        || host == "s3.amazonaws.com.cn"
}

fn default_port_for_scheme(ssl: bool) -> u16 {
    if ssl {
        443
    } else {
        80
    }
}

fn redact(value: &str) -> &'static str {
    if value.is_empty() {
        "none"
    } else {
        "redacted"
    }
}

fn external_string(value: Option<&serde_json::Value>, keys: &[&str]) -> Option<String> {
    let value = value?;
    for key in keys {
        if let Some(text) =
            value.get(*key).and_then(|item| item.as_str()).map(str::trim).filter(|item| !item.is_empty())
        {
            return Some(text.to_string());
        }
    }
    None
}

fn external_bool(value: Option<&serde_json::Value>, keys: &[&str]) -> Option<bool> {
    let value = value?;
    for key in keys {
        if let Some(flag) = value.get(*key).and_then(|item| item.as_bool()) {
            return Some(flag);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::{ConnectionConfig, DatabaseType};

    fn connection() -> ConnectionConfig {
        ConnectionConfig {
            id: "s3-1".to_string(),
            name: "s3".to_string(),
            db_type: DatabaseType::S3,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: String::new(),
            port: 443,
            username: "AKIAEXAMPLE".to_string(),
            password: "secret".to_string(),
            database: None,
            default_schema: None,
            visible_databases: None,
            visible_database_patterns: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            note: String::new(),
            docs_notes_path: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: crate::models::connection::default_keepalive_interval_secs(),
            ssl: true,
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
            redis_key_templates: Vec::new(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            save_password: true,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
            redis_database_aliases: std::collections::HashMap::new(),
        }
    }

    #[test]
    fn aws_china_region_uses_cn_partition_domain() {
        assert_eq!(default_aws_endpoint("cn-north-1"), "https://s3.cn-north-1.amazonaws.com.cn");
        assert_eq!(default_aws_endpoint("us-east-1"), "https://s3.us-east-1.amazonaws.com");
    }

    #[test]
    fn minio_endpoint_defaults_to_path_style() {
        let mut cfg = connection();
        cfg.host = "127.0.0.1".to_string();
        cfg.port = 9000;
        cfg.ssl = false;
        let parsed = S3Config::from_connection(&cfg).expect("config");
        assert!(parsed.uses_path_style(Some("lake")));
        assert_eq!(parsed.endpoint.as_str(), "http://127.0.0.1:9000/");
    }

    #[test]
    fn aws_endpoint_defaults_to_virtual_hosted_style() {
        let parsed = S3Config::from_connection(&connection()).expect("config");
        assert!(!parsed.uses_path_style(Some("lake")));
        assert_eq!(parsed.endpoint.as_str(), "https://s3.us-east-1.amazonaws.com/");
    }
}
