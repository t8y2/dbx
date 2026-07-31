use std::path::Path;

use base64::Engine;
use futures::{stream, StreamExt, TryStreamExt};
use reqwest::Method;
use serde_json::Value;
use tokio::io::AsyncWriteExt;

use crate::connection::AppState;
use crate::models::connection::{ConnectionConfig, DatabaseType};

use super::client::{encoded_id, DockerClient};
use super::config::DockerAdminConfig;
use super::types::*;

async fn connection_and_client(
    state: &AppState,
    connection_id: &str,
) -> Result<(ConnectionConfig, DockerClient, DockerVersionResponse), String> {
    let connection = state
        .configs
        .read()
        .await
        .get(connection_id)
        .cloned()
        .ok_or_else(|| "Docker connection not found".to_string())?;
    if connection.db_type != DatabaseType::Docker {
        return Err("Connection is not a Docker connection".to_string());
    }
    let config = DockerAdminConfig::from_connection(&connection)?;
    let (client, version) = DockerClient::connect(state, connection_id, &connection, &config).await?;
    Ok((connection, client, version))
}

pub async fn docker_test_connection_core(
    state: &AppState,
    connection_id: &str,
) -> Result<DockerConnectionInfo, String> {
    let (_, _, version) = connection_and_client(state, connection_id).await?;
    Ok(connection_info(version))
}

pub async fn docker_get_engine_details_core(
    state: &AppState,
    connection_id: &str,
) -> Result<DockerEngineDetails, String> {
    let (_, client, _) = connection_and_client(state, connection_id).await?;
    let (version, info) = tokio::try_join!(client.get_unversioned_value("/version"), client.get_value("/info"))?;
    let string = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let number = |value: &Value, key: &str| value.get(key).and_then(Value::as_u64);
    let strings = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default()
    };
    let summary = DockerEngineSummary {
        engine_version: string(&version, "Version"),
        api_version: string(&version, "ApiVersion"),
        minimum_api_version: string(&version, "MinAPIVersion"),
        operating_system: string(&info, "OperatingSystem").or_else(|| string(&version, "Os")),
        architecture: string(&info, "Architecture").or_else(|| string(&version, "Arch")),
        kernel_version: string(&info, "KernelVersion"),
        storage_driver: string(&info, "Driver"),
        containers: number(&info, "Containers"),
        containers_running: number(&info, "ContainersRunning"),
        containers_paused: number(&info, "ContainersPaused"),
        containers_stopped: number(&info, "ContainersStopped"),
        images: number(&info, "Images"),
        docker_root_dir: string(&info, "DockerRootDir"),
        security_options: strings(&info, "SecurityOptions"),
        warnings: strings(&info, "Warnings"),
    };
    Ok(DockerEngineDetails { version, info, summary })
}

pub async fn docker_test_connection_config_core(
    state: &AppState,
    connection_id: &str,
    connection: &ConnectionConfig,
) -> Result<DockerConnectionInfo, String> {
    if connection.db_type != DatabaseType::Docker {
        return Err("Connection is not a Docker connection".to_string());
    }
    let config = DockerAdminConfig::from_connection(connection)?;
    let (_, version) = DockerClient::connect(state, connection_id, connection, &config).await?;
    Ok(connection_info(version))
}

fn connection_info(version: DockerVersionResponse) -> DockerConnectionInfo {
    DockerConnectionInfo {
        engine_version: version.version,
        api_version: version.api_version,
        minimum_api_version: version.min_api_version,
        operating_system: version.os,
        architecture: version.arch,
    }
}

pub async fn docker_list_containers_core(
    state: &AppState,
    connection_id: &str,
    all: bool,
) -> Result<Vec<DockerContainer>, String> {
    let (_, client, _) = connection_and_client(state, connection_id).await?;
    let values: Vec<DockerContainerWire> =
        client.get(&format!("/containers/json?all={}", if all { 1 } else { 0 })).await?;
    Ok(values.into_iter().map(Into::into).collect())
}

pub async fn docker_list_images_core(state: &AppState, connection_id: &str) -> Result<Vec<DockerImage>, String> {
    let (_, client, _) = connection_and_client(state, connection_id).await?;
    let values: Vec<DockerImageWire> = client.get("/images/json?all=0").await?;
    Ok(values.into_iter().map(Into::into).collect())
}

pub async fn docker_list_volumes_core(state: &AppState, connection_id: &str) -> Result<Vec<DockerVolume>, String> {
    let (_, client, _) = connection_and_client(state, connection_id).await?;
    let value: DockerVolumeListWire = client.get("/volumes").await?;
    Ok(value.volumes.into_iter().map(Into::into).collect())
}

pub async fn docker_list_networks_core(state: &AppState, connection_id: &str) -> Result<Vec<DockerNetwork>, String> {
    let (_, client, _) = connection_and_client(state, connection_id).await?;
    let values: Vec<DockerNetworkWire> = client.get("/networks").await?;
    Ok(values.into_iter().map(Into::into).collect())
}

pub async fn docker_container_action_core(
    state: &AppState,
    connection_id: &str,
    container_id: &str,
    action: DockerContainerAction,
) -> Result<(), String> {
    let (connection, client, _) = connection_and_client(state, connection_id).await?;
    if connection.read_only {
        return Err("Docker connection is read-only; lifecycle operations are disabled".to_string());
    }
    let action_name = match action {
        DockerContainerAction::Start => "start",
        DockerContainerAction::Pause => "pause",
        DockerContainerAction::Unpause => "unpause",
        DockerContainerAction::Stop => "stop",
        DockerContainerAction::Restart => "restart",
    };
    let path = format!("/containers/{}/{action_name}", encoded_id(container_id));
    let result = if matches!(action, DockerContainerAction::Stop | DockerContainerAction::Restart) {
        client.post_empty_long_running(&path).await
    } else {
        client.post_empty(&path).await
    };
    match &result {
        Ok(()) => log::info!(
            "Docker lifecycle action succeeded: connection_id={} container_id={} action={}",
            connection_id,
            container_id,
            action_name
        ),
        Err(error) => log::warn!(
            "Docker lifecycle action failed: connection_id={} container_id={} action={} error={}",
            connection_id,
            container_id,
            action_name,
            error
        ),
    }
    result
}

fn validate_resource_name(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label} is required"));
    }
    if value.contains(['\0', '\n', '\r']) {
        return Err(format!("{label} contains unsupported control characters"));
    }
    Ok(value.to_string())
}

fn ensure_writable(connection: &ConnectionConfig, action: &str) -> Result<(), String> {
    if connection.read_only {
        return Err(format!("Docker connection is read-only; {action} is disabled"));
    }
    Ok(())
}

pub async fn docker_create_container_core(
    state: &AppState,
    connection_id: &str,
    request: DockerCreateContainerRequest,
) -> Result<DockerCreateContainerResult, String> {
    let (connection, client, _) = connection_and_client(state, connection_id).await?;
    ensure_writable(&connection, "container creation")?;
    let (name, body) = prepare_create_container_request(&request)?;
    let value: Value = client.post_json(&format!("/containers/create?name={}", encoded_id(&name)), body).await?;
    let id = value.get("Id").and_then(Value::as_str).unwrap_or_default().to_string();
    if id.is_empty() {
        return Err("Docker created the container but did not return its ID".to_string());
    }
    let warnings = value
        .get("Warnings")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    if request.start {
        client.post_empty(&format!("/containers/{}/start", encoded_id(&id))).await?;
    }
    log::info!("Docker container created: connection_id={} container_id={}", connection_id, id);
    Ok(DockerCreateContainerResult { id, warnings })
}

pub(crate) fn validate_create_container_request(request: &DockerCreateContainerRequest) -> Result<(), String> {
    prepare_create_container_request(request).map(|_| ())
}

fn prepare_create_container_request(request: &DockerCreateContainerRequest) -> Result<(String, Value), String> {
    let name = validate_resource_name(&request.name, "Container name")?;
    let image = validate_resource_name(&request.image, "Container image")?;
    if request.environment.iter().any(|value| value.contains('\0')) {
        return Err("Container environment contains a null character".to_string());
    }

    let mut exposed_ports = serde_json::Map::new();
    let mut port_bindings = serde_json::Map::new();
    for port in &request.ports {
        if port.container_port == 0 {
            return Err("Container port must be greater than zero".to_string());
        }
        let protocol = match port.protocol.trim().to_ascii_lowercase().as_str() {
            "" | "tcp" => "tcp",
            "udp" => "udp",
            _ => return Err("Container port protocol must be tcp or udp".to_string()),
        };
        let key = format!("{}/{protocol}", port.container_port);
        exposed_ports.insert(key.clone(), serde_json::json!({}));
        port_bindings.insert(
            key,
            serde_json::json!([{
                "HostIp": port.host_ip.trim(),
                "HostPort": port.host_port.map(|value| value.to_string()).unwrap_or_default()
            }]),
        );
    }

    let mounts = request
        .mounts
        .iter()
        .map(|mount| {
            let mount_type = match mount.mount_type.trim().to_ascii_lowercase().as_str() {
                "bind" => "bind",
                "volume" => "volume",
                _ => return Err("Mount type must be bind or volume".to_string()),
            };
            let source = validate_resource_name(&mount.source, "Mount source")?;
            let target = validate_container_path(&mount.target)?;
            Ok(serde_json::json!({
                "Type": mount_type,
                "Source": source,
                "Target": target,
                "ReadOnly": mount.read_only
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let restart_name = match request.restart_policy.trim().to_ascii_lowercase().as_str() {
        "" | "no" => "no",
        "always" => "always",
        "unless-stopped" => "unless-stopped",
        "on-failure" => "on-failure",
        _ => return Err("Restart policy must be no, always, unless-stopped, or on-failure".to_string()),
    };
    let network = request
        .network
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .map(|name| validate_resource_name(name, "Container network"))
        .transpose()?;
    let body = serde_json::json!({
        "Image": image,
        "Cmd": &request.command,
        "Env": &request.environment,
        "Labels": &request.labels,
        "ExposedPorts": exposed_ports,
        "HostConfig": {
            "PortBindings": port_bindings,
            "Mounts": mounts,
            "RestartPolicy": {"Name": restart_name}
        },
        "NetworkingConfig": network.as_ref().map(|name| {
            serde_json::json!({"EndpointsConfig": {name: {}}})
        })
    });
    Ok((name, body))
}

pub async fn docker_remove_container_core(
    state: &AppState,
    connection_id: &str,
    container_id: &str,
) -> Result<(), String> {
    let (connection, client, _) = connection_and_client(state, connection_id).await?;
    ensure_writable(&connection, "container deletion")?;
    let result = client.delete_empty(&format!("/containers/{}?force=false&v=false", encoded_id(container_id))).await;
    audit_result(connection_id, container_id, "remove-container", &result);
    result
}

pub(crate) async fn docker_rename_container_core(
    state: &AppState,
    connection_id: &str,
    container_id: &str,
    name: &str,
) -> Result<(), String> {
    let (connection, client, _) = connection_and_client(state, connection_id).await?;
    ensure_writable(&connection, "container rename")?;
    let name = validate_resource_name(name, "Container name")?;
    client.post_empty(&format!("/containers/{}/rename?name={}", encoded_id(container_id), encoded_id(&name))).await
}

pub(crate) async fn docker_remove_network_core(
    state: &AppState,
    connection_id: &str,
    network_id: &str,
) -> Result<(), String> {
    let (connection, client, _) = connection_and_client(state, connection_id).await?;
    ensure_writable(&connection, "network deletion")?;
    client.delete_empty(&format!("/networks/{}", encoded_id(network_id))).await
}

pub async fn docker_remove_image_core(state: &AppState, connection_id: &str, image_id: &str) -> Result<(), String> {
    let (connection, client, _) = connection_and_client(state, connection_id).await?;
    ensure_writable(&connection, "image deletion")?;
    let images: Vec<DockerImageWire> = client.get("/images/json?all=false").await?;
    let references = images
        .into_iter()
        .find(|image| image.id == image_id)
        .map(|image| image.repo_tags.into_iter().filter(|tag| tag != "<none>:<none>").collect::<Vec<_>>())
        .unwrap_or_default();
    let result = async {
        if references.is_empty() {
            client.delete_empty(&format!("/images/{}?force=false&noprune=true", encoded_id(image_id))).await?;
        } else {
            for reference in references {
                client.delete_empty(&format!("/images/{}?force=false&noprune=true", encoded_id(&reference))).await?;
            }
        }
        Ok(())
    }
    .await;
    audit_result(connection_id, image_id, "remove-image", &result);
    result
}

pub async fn docker_create_volume_core(
    state: &AppState,
    connection_id: &str,
    request: DockerCreateVolumeRequest,
) -> Result<DockerVolume, String> {
    let (connection, client, _) = connection_and_client(state, connection_id).await?;
    ensure_writable(&connection, "volume creation")?;
    let name = validate_resource_name(&request.name, "Volume name")?;
    let driver = validate_resource_name(&request.driver, "Volume driver")?;
    let value: DockerVolumeWire = client
        .post_json(
            "/volumes/create",
            serde_json::json!({
                "Name": name,
                "Driver": driver,
                "Labels": request.labels,
                "DriverOpts": request.driver_options
            }),
        )
        .await?;
    log::info!("Docker volume created: connection_id={} volume={}", connection_id, value.name);
    Ok(value.into())
}

pub async fn docker_create_network_core(
    state: &AppState,
    connection_id: &str,
    request: DockerCreateNetworkRequest,
) -> Result<DockerCreateNetworkResult, String> {
    let (connection, client, _) = connection_and_client(state, connection_id).await?;
    ensure_writable(&connection, "network creation")?;
    let name = validate_resource_name(&request.name, "Network name")?;
    let driver = validate_resource_name(&request.driver, "Network driver")?;
    let ipam_config = if request.subnet.as_deref().is_some_and(|value| !value.trim().is_empty())
        || request.gateway.as_deref().is_some_and(|value| !value.trim().is_empty())
    {
        vec![serde_json::json!({
            "Subnet": request.subnet.as_deref().unwrap_or_default().trim(),
            "Gateway": request.gateway.as_deref().unwrap_or_default().trim()
        })]
    } else {
        Vec::new()
    };
    let value: Value = client
        .post_json(
            "/networks/create",
            serde_json::json!({
                "Name": name,
                "Driver": driver,
                "Internal": request.internal,
                "Attachable": request.attachable,
                "IPAM": {"Config": ipam_config}
            }),
        )
        .await?;
    let result = DockerCreateNetworkResult {
        id: value.get("Id").and_then(Value::as_str).unwrap_or_default().to_string(),
        warning: value.get("Warning").and_then(Value::as_str).unwrap_or_default().to_string(),
    };
    log::info!("Docker network created: connection_id={} network_id={}", connection_id, result.id);
    Ok(result)
}

pub async fn docker_export_image_response_core(
    state: &AppState,
    connection_id: &str,
    image_id: &str,
) -> Result<reqwest::Response, String> {
    let (_, client, _) = connection_and_client(state, connection_id).await?;
    client.request_stream(Method::GET, &format!("/images/{}/get", encoded_id(image_id)), None, None).await
}

pub async fn docker_export_image_to_path_core(
    state: &AppState,
    connection_id: &str,
    image_id: &str,
    destination_path: &str,
) -> Result<u64, String> {
    if destination_path.trim().is_empty() {
        return Err("Image export destination is required".to_string());
    }
    let destination = Path::new(destination_path);
    let mut response = docker_export_image_response_core(state, connection_id, image_id).await?;
    let mut file = tokio::fs::File::create(destination)
        .await
        .map_err(|error| format!("Failed to create image export file: {error}"))?;
    let mut written = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|error| format!("Docker image export failed: {error}"))? {
        if let Err(error) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(destination).await;
            return Err(format!("Failed to write image export: {error}"));
        }
        written += chunk.len() as u64;
    }
    file.flush().await.map_err(|error| format!("Failed to finish image export: {error}"))?;
    Ok(written)
}

pub async fn docker_pull_image_response_core(
    state: &AppState,
    connection_id: &str,
    image: &str,
    auth: Option<DockerRegistryAuth>,
) -> Result<reqwest::Response, String> {
    let (connection, client, _) = connection_and_client(state, connection_id).await?;
    ensure_writable(&connection, "image pull")?;
    let image = validate_resource_name(image, "Image reference")?;
    let registry_auth = encode_registry_auth(auth);
    client
        .request_stream(Method::POST, &format!("/images/create?fromImage={}", encoded_id(&image)), None, registry_auth)
        .await
}

fn encode_registry_auth(auth: Option<DockerRegistryAuth>) -> Option<String> {
    auth.filter(|auth| !auth.username.is_empty() || !auth.password.is_empty() || !auth.server_address.is_empty()).map(
        |auth| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&serde_json::json!({
                    "username": auth.username,
                    "password": auth.password,
                    "serveraddress": auth.server_address
                }))
                .unwrap_or_default(),
            )
        },
    )
}

pub async fn docker_push_image_response_core(
    state: &AppState,
    connection_id: &str,
    source_image_id: &str,
    target_reference: &str,
    auth: Option<DockerRegistryAuth>,
) -> Result<reqwest::Response, String> {
    let (connection, client, _) = connection_and_client(state, connection_id).await?;
    ensure_writable(&connection, "image push")?;
    let source = validate_resource_name(source_image_id, "Source image")?;
    let target = validate_resource_name(target_reference, "Target image reference")?;
    let slash = target.rfind('/').unwrap_or(0);
    let colon = target.rfind(':').filter(|index| *index > slash);
    let (repository, tag) = match colon {
        Some(index) => (&target[..index], &target[index + 1..]),
        None => (target.as_str(), "latest"),
    };
    if repository.is_empty() || tag.is_empty() {
        return Err("Target image reference must contain a repository and a valid tag".to_string());
    }
    client
        .post_empty(&format!(
            "/images/{}/tag?repo={}&tag={}",
            encoded_id(&source),
            encoded_id(repository),
            encoded_id(tag)
        ))
        .await?;
    log::info!(
        "Docker image push started: connection_id={} source_image_id={} target={}",
        connection_id,
        source,
        target
    );
    client
        .request_stream(
            Method::POST,
            &format!("/images/{}/push?tag={}", encoded_id(repository), encoded_id(tag)),
            None,
            encode_registry_auth(auth),
        )
        .await
}

pub async fn docker_container_logs_response_core(
    state: &AppState,
    connection_id: &str,
    container_id: &str,
    options: DockerLogOptions,
) -> Result<reqwest::Response, String> {
    let (_, client, _) = connection_and_client(state, connection_id).await?;
    let tail = options.tail.clamp(1, 10_000);
    client
        .request_stream(
            Method::GET,
            &format!(
                "/containers/{}/logs?stdout=true&stderr=true&follow=true&tail={tail}&timestamps={}",
                encoded_id(container_id),
                options.timestamps
            ),
            None,
            None,
        )
        .await
}

fn validate_container_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if !path.starts_with('/') || path.contains(['\0', '\n', '\r']) {
        return Err("Container path must be absolute and cannot contain control characters".to_string());
    }
    Ok(path.to_string())
}

async fn docker_exec_output(
    client: &DockerClient,
    container_id: &str,
    command: Vec<String>,
) -> Result<Vec<u8>, String> {
    let create: Value = client
        .post_json(
            &format!("/containers/{}/exec", encoded_id(container_id)),
            serde_json::json!({
                "AttachStdout": true,
                "AttachStderr": true,
                "Tty": false,
                "Cmd": command
            }),
        )
        .await?;
    let exec_id = create.get("Id").and_then(Value::as_str).ok_or("Docker exec did not return an ID")?;
    let bytes = client
        .post_bytes(&format!("/exec/{}/start", encoded_id(exec_id)), serde_json::json!({"Detach": false, "Tty": false}))
        .await?;
    let output = decode_multiplexed_bytes(&bytes);
    let inspect: Value = client.get(&format!("/exec/{}/json", encoded_id(exec_id))).await?;
    if inspect.get("ExitCode").and_then(Value::as_i64).unwrap_or_default() != 0 {
        let message = String::from_utf8_lossy(&output).trim().to_string();
        return Err(if message.is_empty() { "Container command failed".to_string() } else { message });
    }
    Ok(output)
}

pub fn decode_multiplexed_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut output = Vec::new();
    let mut offset = 0usize;
    while offset + 8 <= bytes.len() && matches!(bytes[offset], 0..=2) {
        let length =
            u32::from_be_bytes([bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]]) as usize;
        if offset + 8 + length > bytes.len() {
            break;
        }
        output.extend_from_slice(&bytes[offset + 8..offset + 8 + length]);
        offset += 8 + length;
    }
    if offset == 0 {
        bytes.to_vec()
    } else {
        output
    }
}

pub fn decode_multiplexed_stream_chunk(buffer: &mut Vec<u8>, chunk: &[u8]) -> Vec<u8> {
    buffer.extend_from_slice(chunk);
    let mut output = Vec::new();
    loop {
        if buffer.is_empty() {
            break;
        }
        if !matches!(buffer[0], 0..=2) {
            output.append(buffer);
            break;
        }
        if buffer.len() < 8 {
            break;
        }
        let length = u32::from_be_bytes([buffer[4], buffer[5], buffer[6], buffer[7]]) as usize;
        if buffer.len() < 8 + length {
            break;
        }
        output.extend_from_slice(&buffer[8..8 + length]);
        buffer.drain(..8 + length);
    }
    output
}

pub async fn docker_list_container_files_core(
    state: &AppState,
    connection_id: &str,
    container_id: &str,
    path: &str,
) -> Result<Vec<DockerFileEntry>, String> {
    let (_, client, _) = connection_and_client(state, connection_id).await?;
    let path = validate_container_path(path)?;
    let script = r#"for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$entry" ] || [ -L "$entry" ] || continue; stat -c '%F	%s	%Y	%n' -- "$entry"; done"#;
    let output = docker_exec_output(
        &client,
        container_id,
        vec!["/bin/sh".into(), "-c".into(), script.into(), "dbx".into(), path],
    )
    .await
    .map_err(|error| format!("Container file browsing requires /bin/sh and stat: {error}"))?;
    let text = String::from_utf8_lossy(&output);
    let mut entries = Vec::new();
    for line in text.lines() {
        let mut fields = line.splitn(4, '\t');
        let kind_text = fields.next().unwrap_or_default();
        let size = fields.next().and_then(|value| value.parse().ok()).unwrap_or_default();
        let modified = fields.next().and_then(|value| value.parse().ok()).unwrap_or_default();
        let full_path = fields.next().unwrap_or_default();
        if full_path.is_empty() {
            continue;
        }
        let name = full_path.rsplit('/').next().unwrap_or(full_path).to_string();
        let kind = if kind_text.contains("directory") {
            "directory"
        } else if kind_text.contains("symbolic link") {
            "symlink"
        } else {
            "file"
        };
        entries.push(DockerFileEntry { name, path: full_path.to_string(), kind: kind.to_string(), size, modified });
    }
    entries.sort_by(|left, right| {
        (left.kind != "directory", left.name.to_ascii_lowercase())
            .cmp(&(right.kind != "directory", right.name.to_ascii_lowercase()))
    });
    Ok(entries)
}

pub async fn docker_preview_container_file_core(
    state: &AppState,
    connection_id: &str,
    container_id: &str,
    path: &str,
) -> Result<DockerFilePreview, String> {
    const LIMIT: usize = 2 * 1024 * 1024;
    let (_, client, _) = connection_and_client(state, connection_id).await?;
    let path = validate_container_path(path)?;
    let output = docker_exec_output(
        &client,
        container_id,
        vec!["/bin/sh".into(), "-c".into(), format!("head -c {} -- \"$1\"", LIMIT + 1), "dbx".into(), path.clone()],
    )
    .await
    .map_err(|error| format!("Container file preview requires /bin/sh and head: {error}"))?;
    let truncated = output.len() > LIMIT;
    let preview = &output[..output.len().min(LIMIT)];
    let binary = preview.contains(&0) || std::str::from_utf8(preview).is_err();
    Ok(DockerFilePreview {
        path,
        content: if binary { String::new() } else { String::from_utf8_lossy(preview).into_owned() },
        truncated,
        binary,
    })
}

fn audit_result(connection_id: &str, resource_id: &str, action: &str, result: &Result<(), String>) {
    match result {
        Ok(()) => log::info!(
            "Docker action succeeded: connection_id={} resource_id={} action={}",
            connection_id,
            resource_id,
            action
        ),
        Err(error) => log::warn!(
            "Docker action failed: connection_id={} resource_id={} action={} error={}",
            connection_id,
            resource_id,
            action,
            error
        ),
    }
}

pub async fn docker_inspect_container_core(
    state: &AppState,
    connection_id: &str,
    container_id: &str,
) -> Result<Value, String> {
    let (_, client, _) = connection_and_client(state, connection_id).await?;
    client.get_value(&format!("/containers/{}/json", encoded_id(container_id))).await
}

pub async fn docker_container_stats_core(
    state: &AppState,
    connection_id: &str,
    container_ids: Vec<String>,
) -> Result<Vec<DockerContainerStats>, String> {
    if container_ids.len() > 128 {
        return Err("At most 128 Docker containers can be sampled at once".to_string());
    }
    let (_, client, _) = connection_and_client(state, connection_id).await?;
    stream::iter(container_ids)
        .map(|container_id| {
            let client = &client;
            async move {
                let value =
                    client.get_value(&format!("/containers/{}/stats?stream=false", encoded_id(&container_id))).await?;
                Ok(stats_from_value(container_id, &value))
            }
        })
        .buffer_unordered(8)
        .try_collect()
        .await
}

fn stats_from_value(container_id: String, value: &Value) -> DockerContainerStats {
    let cpu_total = u64_at(value, &["cpu_stats", "cpu_usage", "total_usage"]);
    let previous_cpu_total = u64_at(value, &["precpu_stats", "cpu_usage", "total_usage"]);
    let system_total = u64_at(value, &["cpu_stats", "system_cpu_usage"]);
    let previous_system_total = u64_at(value, &["precpu_stats", "system_cpu_usage"]);
    let cpu_count = u64_at(value, &["cpu_stats", "online_cpus"])
        .max(value.pointer("/cpu_stats/cpu_usage/percpu_usage").and_then(Value::as_array).map_or(0, |v| v.len() as u64))
        .max(1);
    let cpu_delta = cpu_total.saturating_sub(previous_cpu_total);
    let system_delta = system_total.saturating_sub(previous_system_total);
    let cpu_percent =
        if system_delta == 0 { 0.0 } else { cpu_delta as f64 / system_delta as f64 * cpu_count as f64 * 100.0 };

    let raw_memory = u64_at(value, &["memory_stats", "usage"]);
    let cache = u64_at(value, &["memory_stats", "stats", "total_inactive_file"])
        .max(u64_at(value, &["memory_stats", "stats", "inactive_file"]))
        .max(u64_at(value, &["memory_stats", "stats", "cache"]));
    let memory_usage = raw_memory.saturating_sub(cache);
    let memory_limit = u64_at(value, &["memory_stats", "limit"]);
    let memory_percent = if memory_limit == 0 { 0.0 } else { memory_usage as f64 / memory_limit as f64 * 100.0 };

    let (network_rx, network_tx) = value
        .get("networks")
        .and_then(Value::as_object)
        .map(|networks| {
            networks.values().fold((0u64, 0u64), |(rx, tx), network| {
                (
                    rx.saturating_add(network.get("rx_bytes").and_then(Value::as_u64).unwrap_or_default()),
                    tx.saturating_add(network.get("tx_bytes").and_then(Value::as_u64).unwrap_or_default()),
                )
            })
        })
        .unwrap_or_default();
    let (block_read, block_write) = value
        .pointer("/blkio_stats/io_service_bytes_recursive")
        .and_then(Value::as_array)
        .map(|entries| {
            entries.iter().fold((0u64, 0u64), |(read, write), entry| {
                let amount = entry.get("value").and_then(Value::as_u64).unwrap_or_default();
                match entry.get("op").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase().as_str() {
                    "read" => (read.saturating_add(amount), write),
                    "write" => (read, write.saturating_add(amount)),
                    _ => (read, write),
                }
            })
        })
        .unwrap_or_default();

    DockerContainerStats {
        container_id,
        read_at: value.get("read").and_then(Value::as_str).unwrap_or_default().to_string(),
        cpu_percent,
        memory_usage,
        memory_limit,
        memory_percent,
        network_rx,
        network_tx,
        block_read,
        block_write,
    }
}

fn u64_at(value: &Value, path: &[&str]) -> u64 {
    path.iter().try_fold(value, |current, key| current.get(*key)).and_then(Value::as_u64).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{decode_multiplexed_bytes, decode_multiplexed_stream_chunk, stats_from_value, validate_container_path};

    #[test]
    fn calculates_stats_and_avoids_underflow() {
        let value = serde_json::json!({
            "read": "2026-07-29T12:00:00Z",
            "cpu_stats": {"cpu_usage": {"total_usage": 300}, "system_cpu_usage": 1000, "online_cpus": 2},
            "precpu_stats": {"cpu_usage": {"total_usage": 100}, "system_cpu_usage": 500},
            "memory_stats": {"usage": 1000, "limit": 2000, "stats": {"inactive_file": 250}},
            "networks": {"eth0": {"rx_bytes": 10, "tx_bytes": 20}},
            "blkio_stats": {"io_service_bytes_recursive": [{"op": "Read", "value": 30}, {"op": "Write", "value": 40}]}
        });
        let stats = stats_from_value("container".to_string(), &value);
        assert_eq!(stats.cpu_percent, 80.0);
        assert_eq!(stats.memory_usage, 750);
        assert_eq!(stats.memory_percent, 37.5);
        assert_eq!((stats.network_rx, stats.network_tx), (10, 20));
        assert_eq!((stats.block_read, stats.block_write), (30, 40));
    }

    #[test]
    fn decodes_complete_and_split_docker_log_frames() {
        let mut framed = vec![1, 0, 0, 0, 0, 0, 0, 6];
        framed.extend_from_slice(b"hello\n");
        assert_eq!(decode_multiplexed_bytes(&framed), b"hello\n");

        let mut buffer = Vec::new();
        assert!(decode_multiplexed_stream_chunk(&mut buffer, &framed[..5]).is_empty());
        assert_eq!(decode_multiplexed_stream_chunk(&mut buffer, &framed[5..]), b"hello\n");
        assert!(buffer.is_empty());
    }

    #[test]
    fn container_file_paths_must_be_absolute_and_control_free() {
        assert_eq!(validate_container_path("/var/log/app.log").unwrap(), "/var/log/app.log");
        assert!(validate_container_path("../etc/passwd").is_err());
        assert!(validate_container_path("/tmp/a\nb").is_err());
        assert!(validate_container_path("").is_err());
    }
}
