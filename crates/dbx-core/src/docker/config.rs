use serde::{Deserialize, Serialize};

use crate::models::connection::{ConnectionConfig, DatabaseType, TransportLayerConfig};
use std::net::IpAddr;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DockerProtocol {
    #[default]
    Http,
    Https,
    Unix,
    UnixOverNc,
    UnixOverNcSudo,
}

fn default_socket_path() -> String {
    "/var/run/docker.sock".to_string()
}

fn default_api_version() -> String {
    "auto".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerAdminConfig {
    #[serde(default)]
    pub protocol: DockerProtocol,
    #[serde(default = "default_socket_path")]
    pub socket_path: String,
    #[serde(default = "default_api_version")]
    pub api_version: String,
    #[serde(default)]
    pub allow_insecure_remote_http: bool,
}

impl Default for DockerAdminConfig {
    fn default() -> Self {
        Self {
            protocol: DockerProtocol::Http,
            socket_path: default_socket_path(),
            api_version: default_api_version(),
            allow_insecure_remote_http: false,
        }
    }
}

impl DockerAdminConfig {
    pub fn from_connection(connection: &ConnectionConfig) -> Result<Self, String> {
        if connection.db_type != DatabaseType::Docker {
            return Err("Connection is not a Docker connection".to_string());
        }
        let config: DockerAdminConfig = connection
            .external_config
            .clone()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| format!("Docker connection settings are invalid: {error}"))?
            .unwrap_or_default();
        config.validate(connection)?;
        Ok(config)
    }

    pub fn validate(&self, connection: &ConnectionConfig) -> Result<(), String> {
        match self.protocol {
            DockerProtocol::Http | DockerProtocol::Https => {
                let host = connection.host.trim();
                if host.is_empty() {
                    return Err("Docker host is required".to_string());
                }
                if connection.port == 0 {
                    return Err("Docker port is required".to_string());
                }
                if self.protocol == DockerProtocol::Http
                    && !self.allow_insecure_remote_http
                    && !is_loopback_host(host)
                    && !connection
                        .effective_transport_layers()
                        .iter()
                        .any(|layer| matches!(layer, TransportLayerConfig::Ssh(_)))
                {
                    return Err(
                        "Remote Docker HTTP is disabled. Enable insecure remote HTTP explicitly, or use HTTPS or an SSH tunnel."
                            .to_string(),
                    );
                }
            }
            DockerProtocol::Unix => {
                if !connection.effective_transport_layers().is_empty() {
                    return Err("A local Docker Unix socket cannot use transport layers".to_string());
                }
                validate_socket_path(&self.socket_path)?;
            }
            DockerProtocol::UnixOverNc | DockerProtocol::UnixOverNcSudo => {
                validate_socket_path(&self.socket_path)?;
                let layers = connection.effective_transport_layers();
                if layers.len() != 1 || !matches!(layers.first(), Some(TransportLayerConfig::Ssh(_))) {
                    return Err("Docker Unix-over-NC requires exactly one SSH transport layer".to_string());
                }
            }
        }
        if self.api_version != "auto" {
            parse_api_version(&self.api_version)?;
        }
        Ok(())
    }
}

fn is_loopback_host(host: &str) -> bool {
    let normalized = host.trim().trim_matches(['[', ']']);
    normalized.eq_ignore_ascii_case("localhost")
        || normalized.parse::<IpAddr>().map(|address| address.is_loopback()).unwrap_or(false)
}

pub(crate) fn validate_socket_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Docker socket path is required".to_string());
    }
    if !path.starts_with('/') || path.contains('\0') || path.contains('\n') || path.contains('\r') {
        return Err("Docker socket path must be an absolute Unix path without control characters".to_string());
    }
    Ok(())
}

pub(crate) fn parse_api_version(value: &str) -> Result<(u16, u16), String> {
    let (major, minor) = value
        .trim_start_matches('v')
        .split_once('.')
        .ok_or_else(|| "Docker API version must look like 1.44".to_string())?;
    let parsed = (
        major.parse::<u16>().map_err(|_| "Docker API version has an invalid major number".to_string())?,
        minor.parse::<u16>().map_err(|_| "Docker API version has an invalid minor number".to_string())?,
    );
    if parsed < (1, 24) {
        return Err("Docker API versions older than 1.24 are not supported".to_string());
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::{parse_api_version, DockerAdminConfig};
    use crate::models::connection::{ConnectionConfig, TransportLayerConfig};

    fn docker_connection() -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "docker-test",
            "name": "Docker",
            "db_type": "docker",
            "host": "127.0.0.1",
            "port": 2375,
            "username": "",
            "password": "",
            "database": null
        }))
        .unwrap()
    }

    #[test]
    fn rejects_old_api_versions() {
        assert!(parse_api_version("1.23").is_err());
        assert_eq!(parse_api_version("v1.44").unwrap(), (1, 44));
    }

    #[test]
    fn rejects_remote_plain_http_without_explicit_opt_in() {
        let mut connection = docker_connection();
        connection.host = "docker.example.com".to_string();
        connection.port = 2375;
        connection.external_config = Some(serde_json::json!({"protocol": "http"}));
        assert!(DockerAdminConfig::from_connection(&connection).is_err());

        connection.external_config = Some(serde_json::json!({
            "protocol": "http",
            "allowInsecureRemoteHttp": true
        }));
        assert!(DockerAdminConfig::from_connection(&connection).is_ok());
    }

    #[test]
    fn validates_unix_and_nc_transport_combinations() {
        let mut connection = docker_connection();
        connection.external_config = Some(serde_json::json!({
            "protocol": "unix",
            "socketPath": "/var/run/docker.sock"
        }));
        assert!(DockerAdminConfig::from_connection(&connection).is_ok());

        let ssh: TransportLayerConfig = serde_json::from_value(serde_json::json!({
            "type": "ssh",
            "id": "ssh-1",
            "enabled": true,
            "profile_id": "shared-ssh"
        }))
        .unwrap();
        connection.transport_layers = vec![ssh];
        assert!(DockerAdminConfig::from_connection(&connection).is_err());

        connection.external_config = Some(serde_json::json!({
            "protocol": "unix-over-nc",
            "socketPath": "/var/run/docker.sock"
        }));
        assert!(DockerAdminConfig::from_connection(&connection).is_ok());
    }
}
