use std::path::Path;
use std::time::Duration;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::{Certificate, Client, Identity, Method, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::connection::AppState;
use crate::models::connection::ConnectionConfig;

use super::config::{parse_api_version, DockerAdminConfig, DockerProtocol};
use super::types::DockerVersionResponse;

pub(crate) struct DockerClient {
    client: Client,
    stream_client: Client,
    base_url: String,
    api_version: String,
}

impl DockerClient {
    pub async fn connect(
        state: &AppState,
        connection_id: &str,
        connection: &ConnectionConfig,
        config: &DockerAdminConfig,
    ) -> Result<(Self, DockerVersionResponse), String> {
        let (client, stream_client, base_url) = build_transport(state, connection_id, connection, config).await?;
        let version: DockerVersionResponse =
            request_json_with(&client, Method::GET, &format!("{base_url}/version"), None).await?;
        let api_version = if config.api_version == "auto" {
            version.api_version.clone()
        } else {
            config.api_version.trim_start_matches('v').to_string()
        };
        parse_api_version(&api_version)?;
        let ping = request_text_with(&client, Method::GET, &format!("{base_url}/_ping")).await?;
        if ping.trim() != "OK" {
            return Err(format!("Docker daemon returned an unexpected ping response: {ping}"));
        }
        Ok((Self { client, stream_client, base_url, api_version }, version))
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}/v{}{}", self.base_url, self.api_version, path)
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        request_json_with(&self.client, Method::GET, &self.endpoint(path), None).await
    }

    pub async fn get_value(&self, path: &str) -> Result<Value, String> {
        self.get(path).await
    }

    pub async fn get_unversioned_value(&self, path: &str) -> Result<Value, String> {
        request_json_with(&self.client, Method::GET, &format!("{}{}", self.base_url, path), None).await
    }

    pub async fn post_empty(&self, path: &str) -> Result<(), String> {
        request_empty_with(&self.client, Method::POST, &self.endpoint(path)).await
    }

    pub async fn post_empty_long_running(&self, path: &str) -> Result<(), String> {
        request_empty_with(&self.stream_client, Method::POST, &self.endpoint(path)).await
    }

    pub async fn post_json<T: DeserializeOwned>(&self, path: &str, body: Value) -> Result<T, String> {
        request_json_with(&self.client, Method::POST, &self.endpoint(path), Some(body)).await
    }

    pub async fn delete_empty(&self, path: &str) -> Result<(), String> {
        request_empty_body_with(&self.client, Method::DELETE, &self.endpoint(path), None, None).await
    }

    pub async fn post_bytes(&self, path: &str, body: Value) -> Result<Vec<u8>, String> {
        request_bytes_with(&self.client, Method::POST, &self.endpoint(path), Some(body)).await
    }

    pub async fn request_stream(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        registry_auth: Option<String>,
    ) -> Result<reqwest::Response, String> {
        let url = self.endpoint(path);
        let mut request = self.stream_client.request(method, &url);
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(registry_auth) = registry_auth {
            request = request.header("X-Registry-Auth", registry_auth);
        }
        let response = request.send().await.map_err(|error| docker_transport_error(&url, error))?;
        if response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED {
            return Ok(response);
        }
        let status = response.status();
        let bytes = response.bytes().await.unwrap_or_default();
        Err(docker_api_error(status, &bytes))
    }
}

pub(crate) fn encoded_id(id: &str) -> String {
    utf8_percent_encode(id, NON_ALPHANUMERIC).to_string()
}

async fn build_transport(
    state: &AppState,
    connection_id: &str,
    connection: &ConnectionConfig,
    config: &DockerAdminConfig,
) -> Result<(Client, Client, String), String> {
    let timeout = Duration::from_secs(connection.effective_connect_timeout_secs().max(5));
    match config.protocol {
        DockerProtocol::Http | DockerProtocol::Https => {
            let original_host = connection.host.trim();
            let (connect_host, connect_port) = state.connection_host_port(connection_id, connection).await?;
            let scheme = if config.protocol == DockerProtocol::Https { "https" } else { "http" };
            let mut builder = Client::builder().connect_timeout(timeout).timeout(timeout).no_proxy();
            let mut stream_builder = Client::builder().connect_timeout(timeout).no_proxy();
            if config.protocol == DockerProtocol::Https {
                builder = configure_tls(builder, connection)?;
                stream_builder = configure_tls(stream_builder, connection)?;
            }
            if connect_host != original_host || connect_port != connection.port {
                let loopback = format!("127.0.0.1:{connect_port}")
                    .parse()
                    .map_err(|error| format!("Docker tunnel endpoint is invalid: {error}"))?;
                builder = builder.resolve(original_host, loopback);
                stream_builder = stream_builder.resolve(original_host, loopback);
                Ok((
                    builder.build().map_err(|error| format!("Failed to build Docker HTTP client: {error}"))?,
                    stream_builder
                        .build()
                        .map_err(|error| format!("Failed to build Docker streaming client: {error}"))?,
                    format!("{scheme}://{original_host}:{connect_port}"),
                ))
            } else {
                Ok((
                    builder.build().map_err(|error| format!("Failed to build Docker HTTP client: {error}"))?,
                    stream_builder
                        .build()
                        .map_err(|error| format!("Failed to build Docker streaming client: {error}"))?,
                    format!("{scheme}://{original_host}:{connect_port}"),
                ))
            }
        }
        DockerProtocol::Unix => {
            #[cfg(unix)]
            {
                let client = Client::builder()
                    .connect_timeout(timeout)
                    .timeout(timeout)
                    .no_proxy()
                    .unix_socket(config.socket_path.clone())
                    .build()
                    .map_err(|error| format!("Failed to open Docker Unix socket: {error}"))?;
                let stream_client = Client::builder()
                    .connect_timeout(timeout)
                    .no_proxy()
                    .unix_socket(config.socket_path.clone())
                    .build()
                    .map_err(|error| format!("Failed to open Docker Unix socket for streaming: {error}"))?;
                Ok((client, stream_client, "http://localhost".to_string()))
            }
            #[cfg(not(unix))]
            {
                let _ = (state, connection_id, connection);
                Err("Docker Unix sockets are only supported by Unix DBX backends".to_string())
            }
        }
        DockerProtocol::UnixOverNc | DockerProtocol::UnixOverNcSudo => {
            let layers = state.resolved_transport_layers(connection).await?;
            let ssh = match layers.as_slice() {
                [crate::models::connection::TransportLayerConfig::Ssh(ssh)] => ssh,
                _ => return Err("Docker Unix-over-NC requires exactly one resolved SSH transport".to_string()),
            };
            let command = nc_command(&config.socket_path, config.protocol == DockerProtocol::UnixOverNcSudo);
            let bridge_id = format!("{connection_id}:docker-nc");
            let port = state.tunnels.start_command_tunnel(&bridge_id, ssh, &command).await?;
            let client = Client::builder()
                .connect_timeout(timeout)
                .timeout(timeout)
                .no_proxy()
                .build()
                .map_err(|error| format!("Failed to build Docker NC client: {error}"))?;
            let stream_client = Client::builder()
                .connect_timeout(timeout)
                .no_proxy()
                .build()
                .map_err(|error| format!("Failed to build Docker NC streaming client: {error}"))?;
            Ok((client, stream_client, format!("http://127.0.0.1:{port}")))
        }
    }
}

fn configure_tls(
    mut builder: reqwest::ClientBuilder,
    connection: &ConnectionConfig,
) -> Result<reqwest::ClientBuilder, String> {
    if !connection.ca_cert_path.trim().is_empty() {
        let bytes = std::fs::read(Path::new(&connection.ca_cert_path))
            .map_err(|error| format!("Failed to read Docker CA certificate: {error}"))?;
        let certificate =
            Certificate::from_pem(&bytes).map_err(|error| format!("Docker CA certificate is invalid: {error}"))?;
        builder = builder.add_root_certificate(certificate);
    }
    let cert_path = connection.client_cert_path.trim();
    let key_path = connection.client_key_path.trim();
    if cert_path.is_empty() != key_path.is_empty() {
        return Err("Docker HTTPS requires both a client certificate and private key".to_string());
    }
    if !cert_path.is_empty() {
        let mut pem = std::fs::read(Path::new(cert_path))
            .map_err(|error| format!("Failed to read Docker client certificate: {error}"))?;
        pem.push(b'\n');
        pem.extend(
            std::fs::read(Path::new(key_path))
                .map_err(|error| format!("Failed to read Docker client private key: {error}"))?,
        );
        let identity = Identity::from_pem(&pem)
            .map_err(|error| format!("Docker client certificate or key is invalid: {error}"))?;
        builder = builder.identity(identity);
    }
    Ok(builder)
}

fn nc_command(socket_path: &str, sudo: bool) -> String {
    let quoted = format!("'{}'", socket_path.replace('\'', "'\"'\"'"));
    if sudo {
        format!("sudo -n -- nc -U {quoted}")
    } else {
        format!("nc -U {quoted}")
    }
}

async fn request_json_with<T: DeserializeOwned>(
    client: &Client,
    method: Method,
    url: &str,
    body: Option<Value>,
) -> Result<T, String> {
    let mut request = client.request(method, url);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|error| docker_transport_error(url, error))?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| format!("Failed to read Docker response: {error}"))?;
    if !status.is_success() {
        return Err(docker_api_error(status, &bytes));
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("Docker returned invalid JSON: {error}"))
}

async fn request_text_with(client: &Client, method: Method, url: &str) -> Result<String, String> {
    let response = client.request(method, url).send().await.map_err(|error| docker_transport_error(url, error))?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| format!("Failed to read Docker response: {error}"))?;
    if !status.is_success() {
        return Err(docker_api_error(status, &bytes));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn request_empty_with(client: &Client, method: Method, url: &str) -> Result<(), String> {
    request_empty_body_with(client, method, url, None, None).await
}

async fn request_empty_body_with(
    client: &Client,
    method: Method,
    url: &str,
    body: Option<Value>,
    registry_auth: Option<String>,
) -> Result<(), String> {
    let mut request = client.request(method, url);
    if let Some(body) = body {
        request = request.json(&body);
    }
    if let Some(registry_auth) = registry_auth {
        request = request.header("X-Registry-Auth", registry_auth);
    }
    let response = request.send().await.map_err(|error| docker_transport_error(url, error))?;
    if response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED {
        return Ok(());
    }
    let status = response.status();
    let bytes = response.bytes().await.unwrap_or_default();
    Err(docker_api_error(status, &bytes))
}

async fn request_bytes_with(
    client: &Client,
    method: Method,
    url: &str,
    body: Option<Value>,
) -> Result<Vec<u8>, String> {
    let mut request = client.request(method, url);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|error| docker_transport_error(url, error))?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| format!("Failed to read Docker response: {error}"))?;
    if !status.is_success() {
        return Err(docker_api_error(status, &bytes));
    }
    Ok(bytes.to_vec())
}

fn docker_transport_error(url: &str, error: reqwest::Error) -> String {
    format!("Failed to reach Docker daemon at {url}: {error}")
}

fn docker_api_error(status: StatusCode, body: &[u8]) -> String {
    let message = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| value.get("message").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| String::from_utf8_lossy(body).trim().to_string());
    if message.is_empty() {
        format!("Docker API returned HTTP {status}")
    } else {
        format!("Docker API returned HTTP {status}: {message}")
    }
}
