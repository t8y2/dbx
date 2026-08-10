use std::path::PathBuf;
use std::time::Duration;

use dbx_core::models::connection::ConnectionConfig;
use dbx_core::plugins::{PluginHost, PluginInstallPolicy, PluginPackageInstaller, PluginRegistry};
use serde_json::{json, Value};

const PLUGIN_ID: &str = "io.dbx.ssh-sftp";
const ALTERNATE_HOST_PUBLIC_KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEftRCmpwBkC7IEcQ0pbOudddk5ICglnh6ho+e9gwMp6";

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("SSH plugin package smoke failed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let package =
        args.next().map(PathBuf::from).ok_or("Usage: ssh_plugin_package_smoke <package.dbxp> [plugin-store]")?;
    let requested_store = args.next().map(PathBuf::from);
    let temporary_store =
        if requested_store.is_none() { Some(tempfile::tempdir().map_err(|error| error.to_string())?) } else { None };
    let store = requested_store
        .unwrap_or_else(|| temporary_store.as_ref().expect("temporary store exists").path().to_path_buf());
    let app_version = current_dbx_app_version()?;
    let installer = PluginPackageInstaller::new(store.clone(), app_version.clone())?;
    let installed = installer.install_file(&package, PluginInstallPolicy::LocalDevelopment)?;
    if installed.plugin.manifest.id != PLUGIN_ID {
        return Err(format!("Expected plugin '{PLUGIN_ID}', got '{}'", installed.plugin.manifest.id));
    }
    for permission in ["host.events", "host.binary", "host.filesystem", "host.fileTransfer", "host.clipboard"] {
        if !installed.plugin.manifest.permissions.iter().any(|declared| declared == permission) {
            return Err(format!("Packaged plugin is missing permission '{permission}'"));
        }
    }

    let registry = PluginRegistry::new_with_app_version(store.clone(), app_version);
    let ui = registry.read_ui_entry(PLUGIN_ID)?;
    if ui.bytes.is_empty() || !String::from_utf8_lossy(&ui.bytes).contains("dbxPlugin") {
        return Err("Packaged plugin UI is empty or does not use the Host API".to_string());
    }

    let host = PluginHost::new(registry);
    let live_host = std::env::var("SSH_SMOKE_HOST").ok();
    let target_host = live_host.as_deref().unwrap_or("127.0.0.1");
    let target_port = std::env::var("SSH_SMOKE_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(22);
    let target_user = std::env::var("SSH_SMOKE_USER").unwrap_or_else(|_| "smoke".to_string());
    let target_password = std::env::var("SSH_SMOKE_PASSWORD").unwrap_or_else(|_| "not-sent-by-smoke".to_string());
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id": "ssh-package-smoke",
        "name": "SSH package smoke",
        "db_type": "plugin",
        "driver_profile": "plugin",
        "host": target_host,
        "port": target_port,
        "username": target_user,
        "password": target_password,
        "database": null,
        "external_config": {},
        "plugin_id": PLUGIN_ID,
        "plugin_connection_provider": "io.dbx.ssh-sftp.connection",
        "plugin_connection_type": "ssh"
    }))
    .map_err(|error| error.to_string())?;

    // connection/connect only caches the lifecycle payload. It must not open a
    // socket or send credentials before the workbench starts a verified session.
    let handle = host.connect_connection(&config, &config.host, config.port).await?;
    if !handle.is_running() {
        return Err("SSH plugin Sidecar did not remain running after connection/connect".to_string());
    }
    let data_dir = store.join(PLUGIN_ID).join("data");
    if !data_dir.is_dir() {
        return Err(format!("Plugin data directory was not created at {}", data_dir.display()));
    }
    if live_host.is_some() {
        let learned_host_key = run_live_smoke(&host, &config, &data_dir).await?;
        if learned_host_key && !data_dir.join("known_hosts").is_file() {
            return Err("Accepted host key was not persisted in the plugin data directory".to_string());
        }
    }

    handle.disconnect().await?;
    host.stop_all().await;
    println!("SSH plugin package smoke passed: install -> UI -> lifecycle -> data dir -> live SSH/SFTP -> disconnect");
    Ok(())
}

fn current_dbx_app_version() -> Result<String, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/Cargo.toml");
    let contents = std::fs::read_to_string(&manifest)
        .map_err(|error| format!("Failed to read current DBX package version from {}: {error}", manifest.display()))?;
    contents
        .lines()
        .find_map(|line| line.trim().strip_prefix("version = \"").and_then(|value| value.strip_suffix('"')))
        .map(str::to_string)
        .ok_or_else(|| format!("Current DBX package version is missing from {}", manifest.display()))
}

async fn run_live_smoke(
    host: &PluginHost,
    config: &ConnectionConfig,
    data_dir: &std::path::Path,
) -> Result<bool, String> {
    let mut events = host.subscribe_events();
    let (opened, challenged) = open_session(host, &config.id, &mut events, true).await?;
    let session_id = opened
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or("SSH session result did not contain sessionId")?
        .to_string();

    host.invoke::<Value>(
        PLUGIN_ID,
        "ssh/terminal/resize",
        json!({ "sessionId": session_id, "cols": 120, "rows": 40 }),
        None,
        Some(Duration::from_secs(5)),
    )
    .await?;
    let mut binary = host.subscribe_binary();
    let command = b"printf 'DBX_TERMINAL_OK\\n'\n";
    let mut input = Vec::with_capacity(8 + command.len());
    input.extend_from_slice(&1_u64.to_be_bytes());
    input.extend_from_slice(command);
    host.send_binary(PLUGIN_ID, &format!("ssh/terminal/in/{session_id}"), &input, None).await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let message = binary.recv().await.map_err(|error| error.to_string())?;
            if message.channel == format!("ssh/terminal/out/{session_id}")
                && message.data.len() >= 9
                && message.data[9..].windows(b"DBX_TERMINAL_OK".len()).any(|window| window == b"DBX_TERMINAL_OK")
            {
                return Ok::<(), String>(());
            }
        }
    })
    .await
    .map_err(|_| "Timed out waiting for terminal output".to_string())??;

    let home = host
        .invoke::<Value>(
            PLUGIN_ID,
            "sftp/home",
            json!({ "sessionId": session_id }),
            None,
            Some(Duration::from_secs(10)),
        )
        .await?
        .get("path")
        .and_then(Value::as_str)
        .ok_or("SFTP home response did not contain path")?
        .to_string();
    host.invoke::<Value>(
        PLUGIN_ID,
        "sftp/list",
        json!({ "sessionId": session_id, "path": home }),
        None,
        Some(Duration::from_secs(10)),
    )
    .await?;

    let remote_path = format!("{}/dbx-plugin-smoke.bin", home.trim_end_matches('/'));
    let content = (0..(4 * 1024 * 1024)).map(|index| (index % 251) as u8).collect::<Vec<_>>();
    upload(host, &session_id, &remote_path, &content).await?;
    let downloaded = download(host, &session_id, &remote_path, &mut binary).await?;
    if downloaded != content {
        return Err("SFTP 4 MiB round-trip content mismatch".to_string());
    }

    let empty_path = format!("{}/dbx-plugin-empty.bin", home.trim_end_matches('/'));
    upload(host, &session_id, &empty_path, &[]).await?;
    if !download(host, &session_id, &empty_path, &mut binary).await?.is_empty() {
        return Err("SFTP empty-file round trip returned data".to_string());
    }

    let cancelled_path = format!("{}/dbx-plugin-cancelled.bin", home.trim_end_matches('/'));
    let cancelled = host
        .invoke::<Value>(
            PLUGIN_ID,
            "sftp/upload/start",
            json!({ "sessionId": session_id, "remotePath": cancelled_path, "size": 1024 }),
            None,
            Some(Duration::from_secs(5)),
        )
        .await?;
    host.invoke::<Value>(
        PLUGIN_ID,
        "sftp/transfer/cancel",
        json!({ "taskId": required_value_string(&cancelled, "taskId")? }),
        None,
        Some(Duration::from_secs(5)),
    )
    .await?;

    for path in [&remote_path, &empty_path] {
        host.invoke::<Value>(
            PLUGIN_ID,
            "sftp/delete",
            json!({ "sessionId": session_id, "path": path, "recursive": false }),
            None,
            Some(Duration::from_secs(10)),
        )
        .await?;
    }
    host.invoke::<Value>(
        PLUGIN_ID,
        "ssh/session/close",
        json!({ "sessionId": session_id }),
        None,
        Some(Duration::from_secs(5)),
    )
    .await?;

    let known_hosts_path = data_dir.join("known_hosts");
    let original_known_hosts = std::fs::read(&known_hosts_path).ok();
    let host_identity =
        if config.port == 22 { config.host.clone() } else { format!("[{}]:{}", config.host, config.port) };
    std::fs::write(&known_hosts_path, format!("{host_identity} {ALTERNATE_HOST_PUBLIC_KEY}\n"))
        .map_err(|error| format!("Failed to stage changed-host-key test: {error}"))?;
    let changed_result = open_session(host, &config.id, &mut events, false).await;
    match original_known_hosts {
        Some(contents) => std::fs::write(&known_hosts_path, contents)
            .map_err(|error| format!("Failed to restore known_hosts after changed-key test: {error}"))?,
        None => match std::fs::remove_file(&known_hosts_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to remove changed-key test file: {error}")),
        },
    }
    match changed_result {
        Ok((unexpected, _)) => {
            if let Some(session_id) = unexpected.get("sessionId").and_then(Value::as_str) {
                let _ = host
                    .invoke::<Value>(
                        PLUGIN_ID,
                        "ssh/session/close",
                        json!({ "sessionId": session_id }),
                        None,
                        Some(Duration::from_secs(5)),
                    )
                    .await;
            }
            return Err("Changed host key was accepted".to_string());
        }
        Err(error) if error.to_ascii_lowercase().contains("changed") => {}
        Err(error) => return Err(format!("Changed host key failed for an unexpected reason: {error}")),
    }

    // The remembered key must allow another handshake without a second prompt.
    let (reopened, _) = open_session(host, &config.id, &mut events, false).await?;
    host.invoke::<Value>(
        PLUGIN_ID,
        "ssh/session/close",
        json!({ "sessionId": required_value_string(&reopened, "sessionId")? }),
        None,
        Some(Duration::from_secs(5)),
    )
    .await?;
    Ok(challenged)
}

async fn open_session(
    host: &PluginHost,
    connection_id: &str,
    events: &mut tokio::sync::broadcast::Receiver<dbx_core::plugins::PluginEvent>,
    allow_challenge: bool,
) -> Result<(Value, bool), String> {
    let open = host.invoke::<Value>(
        PLUGIN_ID,
        "ssh/session/open",
        json!({ "connectionId": connection_id, "workbenchId": "ssh-package-smoke-workbench", "cols": 100, "rows": 30 }),
        None,
        Some(Duration::from_secs(30)),
    );
    tokio::pin!(open);
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut challenged = false;
        loop {
            tokio::select! {
                opened = &mut open => return opened.map(|value| (value, challenged)),
                event = events.recv() => {
                    let event = event.map_err(|error| error.to_string())?;
                    if event.plugin_id != PLUGIN_ID || event.method != "connection/challenge" {
                        continue;
                    }
                    if !allow_challenge {
                        return Err("Reconnect unexpectedly requested a host-key challenge".to_string());
                    }
                    let challenge_id = event.params
                        .get("challengeId")
                        .and_then(Value::as_str)
                        .ok_or("Host-key challenge did not contain challengeId")?;
                    let operation_id = event.params
                        .get("operationId")
                        .and_then(Value::as_str)
                        .ok_or("Host-key challenge did not contain operationId")?;
                    host.invoke::<Value>(
                        PLUGIN_ID,
                        "connection/challenge/resolve",
                        json!({ "challengeId": challenge_id, "operationId": operation_id, "accept": true, "remember": true }),
                        None,
                        Some(Duration::from_secs(5)),
                    ).await?;
                    challenged = true;
                }
            }
        }
    })
    .await
    .map_err(|_| "Timed out opening the SSH session".to_string())?
}

async fn upload(host: &PluginHost, session_id: &str, path: &str, content: &[u8]) -> Result<(), String> {
    let started = host
        .invoke::<Value>(
            PLUGIN_ID,
            "sftp/upload/start",
            json!({ "sessionId": session_id, "remotePath": path, "size": content.len() }),
            None,
            Some(Duration::from_secs(5)),
        )
        .await?;
    let task_id = required_value_string(&started, "taskId")?;
    let chunk_size =
        started.get("chunkSize").and_then(Value::as_u64).ok_or("Upload response did not contain chunkSize")? as usize;
    for (index, chunk) in content.chunks(chunk_size).enumerate() {
        let offset = index * chunk_size;
        let mut payload = Vec::with_capacity(8 + chunk.len());
        payload.extend_from_slice(&(offset as u64).to_be_bytes());
        payload.extend_from_slice(chunk);
        host.send_binary(PLUGIN_ID, &format!("sftp/upload/{task_id}"), &payload, None).await?;
    }
    host.invoke::<Value>(
        PLUGIN_ID,
        "sftp/upload/finish",
        json!({ "taskId": task_id }),
        None,
        Some(Duration::from_secs(30)),
    )
    .await?;
    Ok(())
}

async fn download(
    host: &PluginHost,
    session_id: &str,
    path: &str,
    binary: &mut tokio::sync::broadcast::Receiver<dbx_core::plugins::PluginBinaryMessage>,
) -> Result<Vec<u8>, String> {
    let started = host
        .invoke::<Value>(
            PLUGIN_ID,
            "sftp/download/start",
            json!({ "sessionId": session_id, "remotePath": path }),
            None,
            Some(Duration::from_secs(30)),
        )
        .await?;
    let task_id = required_value_string(&started, "taskId")?.to_string();
    let size = started.get("size").and_then(Value::as_u64).ok_or("Download response did not contain size")? as usize;
    let mut output = vec![0_u8; size];
    let mut offset = 0;
    while offset < size {
        let result = host
            .invoke::<Value>(
                PLUGIN_ID,
                "sftp/download/next",
                json!({ "taskId": task_id, "offset": offset }),
                None,
                Some(Duration::from_secs(10)),
            )
            .await?;
        let length =
            result.get("length").and_then(Value::as_u64).ok_or("Download chunk did not contain length")? as usize;
        let message = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let message = binary.recv().await.map_err(|error| error.to_string())?;
                if message.channel == format!("sftp/download/{task_id}") {
                    return Ok::<_, String>(message);
                }
            }
        })
        .await
        .map_err(|_| "Timed out waiting for an SFTP download chunk".to_string())??;
        if message.data.len() != 8 + length {
            return Err("SFTP download frame length mismatch".to_string());
        }
        let frame_offset =
            u64::from_be_bytes(message.data[..8].try_into().map_err(|_| "Invalid download offset")?) as usize;
        if frame_offset != offset {
            return Err(format!("SFTP download offset mismatch: expected {offset}, received {frame_offset}"));
        }
        output[offset..offset + length].copy_from_slice(&message.data[8..]);
        offset += length;
    }
    host.invoke::<Value>(
        PLUGIN_ID,
        "sftp/download/finish",
        json!({ "taskId": task_id }),
        None,
        Some(Duration::from_secs(5)),
    )
    .await?;
    Ok(output)
}

fn required_value_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| format!("Response did not contain {key}"))
}
