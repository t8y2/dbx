use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use flate2::read::GzDecoder;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;

use crate::connection::AppState;

use super::client::{client_for_state, ensure_writable_core, ConsulClient};
use super::response::ensure_success;

const MAX_SNAPSHOT_BYTES: usize = 128 * 1024 * 1024;
const MAX_SNAPSHOT_EXPANDED_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulOperatorField {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulOperatorDocument {
    pub kind: String,
    pub fields: Vec<ConsulOperatorField>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConsulOperatorReadKind {
    AutopilotConfiguration,
    AutopilotHealth,
    AutopilotState,
    RaftConfiguration,
    Usage,
    License,
    Audit,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulAutopilotUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleanup_dead_servers: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_contact_threshold: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_trailing_logs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_quorum: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_stabilization_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redundancy_zone_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_upgrade_migration: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upgrade_version_tag: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSnapshotRestoreRequest {
    pub snapshot_base64: String,
    pub target_datacenter: String,
    pub confirmation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSnapshot {
    pub data_base64: String,
    pub size_bytes: usize,
    pub datacenter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulRaftWriteRequest {
    pub server_id: Option<String>,
    pub address: Option<String>,
    pub confirmation: String,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsulKeyringOperation {
    Install,
    Use,
    Remove,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulKeyringWriteRequest {
    pub operation: ConsulKeyringOperation,
    pub key: String,
    pub confirmation: String,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct ConsulKeyringWriteBody<'a> {
    key: &'a str,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulLicenseWriteRequest {
    pub license: String,
    pub confirmation: String,
}

pub async fn consul_operator_read_core(
    state: &AppState,
    connection_id: &str,
    kind: ConsulOperatorReadKind,
) -> Result<ConsulOperatorDocument, String> {
    let client = client_for_state(state, connection_id).await?;
    let path = match kind {
        ConsulOperatorReadKind::AutopilotConfiguration => "/v1/operator/autopilot/configuration",
        ConsulOperatorReadKind::AutopilotHealth => "/v1/operator/autopilot/health",
        ConsulOperatorReadKind::AutopilotState => "/v1/operator/autopilot/state",
        ConsulOperatorReadKind::RaftConfiguration => "/v1/operator/raft/configuration",
        ConsulOperatorReadKind::Usage => "/v1/operator/usage",
        ConsulOperatorReadKind::License => "/v1/operator/license",
        ConsulOperatorReadKind::Audit => "/v1/operator/audit-hash",
    };
    let url = client.api_url(path)?;
    let value: serde_json::Value = if matches!(kind, ConsulOperatorReadKind::Audit) {
        client
            .request_json(
                Method::POST,
                url,
                Some(&serde_json::json!({ "Input": "dbx-operator-audit" })),
                true,
                "read Consul audit hash",
            )
            .await?
    } else {
        client.request_json(Method::GET, url, None::<&()>, true, "read Consul operator state").await?
    };
    Ok(document(format!("{kind:?}"), value))
}

pub async fn consul_snapshot_generate_core(state: &AppState, connection_id: &str) -> Result<ConsulSnapshot, String> {
    let client = client_for_state(state, connection_id).await?;
    let mut url = client.api_url("/v1/snapshot")?;
    client.append_scope(&mut url, true);
    let mut response =
        ensure_success(client.send(Method::GET, url, None).await?, "generate Consul snapshot", client.token()).await?;
    let mut bytes = Vec::new();
    while let Some(chunk) =
        response.chunk().await.map_err(|error| format!("Failed to read snapshot: {}", error.without_url()))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_SNAPSHOT_BYTES {
            return Err("CONSUL_SNAPSHOT_TOO_LARGE: Snapshot exceeds 128 MiB".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(ConsulSnapshot {
        data_base64: STANDARD.encode(&bytes),
        size_bytes: bytes.len(),
        datacenter: client.datacenter().to_string(),
    })
}

pub async fn consul_snapshot_restore_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulSnapshotRestoreRequest,
) -> Result<(), String> {
    ensure_operator_write(state, connection_id, "snapshot_restore", "restore Consul snapshot").await?;
    let client = client_for_state(state, connection_id).await?;
    validate_datacenter_and_confirmation(
        &client,
        &request.target_datacenter,
        &request.confirmation,
        &format!("RESTORE SNAPSHOT {}", request.target_datacenter),
    )?;
    let snapshot =
        STANDARD.decode(request.snapshot_base64.trim()).map_err(|error| format!("CONSUL_SNAPSHOT_INVALID: {error}"))?;
    if snapshot.is_empty() || snapshot.len() > MAX_SNAPSHOT_BYTES {
        return Err("CONSUL_SNAPSHOT_INVALID: Snapshot is empty or exceeds 128 MiB".to_string());
    }
    let snapshot = tokio::task::spawn_blocking(move || {
        validate_snapshot_archive(&snapshot)?;
        Ok::<_, String>(snapshot)
    })
    .await
    .map_err(|error| format!("CONSUL_SNAPSHOT_INVALID: Snapshot validation task failed: {error}"))??;
    let mut url = client.api_url("/v1/snapshot")?;
    client.append_scope(&mut url, false);
    ensure_success(client.send(Method::PUT, url, Some(snapshot)).await?, "restore Consul snapshot", client.token())
        .await
        .map(|_| ())
}

fn validate_snapshot_archive(snapshot: &[u8]) -> Result<(), String> {
    if snapshot.len() < 10 || !snapshot.starts_with(&[0x1f, 0x8b, 0x08]) {
        return Err("CONSUL_SNAPSHOT_INVALID: Snapshot must be a gzip archive generated by Consul".to_string());
    }

    let decoder = GzDecoder::new(snapshot);
    let mut archive = tar::Archive::new(decoder);
    let mut digests = HashMap::new();
    let mut checksum_manifest = None;
    let mut expanded_bytes = 0_u64;
    let mut entry_count = 0_u8;
    let entries =
        archive.entries().map_err(|error| format!("CONSUL_SNAPSHOT_INVALID: Invalid snapshot archive: {error}"))?;

    for entry in entries {
        entry_count = entry_count
            .checked_add(1)
            .ok_or_else(|| "CONSUL_SNAPSHOT_INVALID: Snapshot contains too many entries".to_string())?;
        if entry_count > 64 {
            return Err("CONSUL_SNAPSHOT_INVALID: Snapshot contains too many entries".to_string());
        }
        let mut entry = entry.map_err(|error| format!("CONSUL_SNAPSHOT_INVALID: Invalid snapshot entry: {error}"))?;
        let size = entry.size();
        expanded_bytes = expanded_bytes
            .checked_add(size)
            .ok_or_else(|| "CONSUL_SNAPSHOT_INVALID: Snapshot expanded size overflow".to_string())?;
        if expanded_bytes > MAX_SNAPSHOT_EXPANDED_BYTES {
            return Err("CONSUL_SNAPSHOT_INVALID: Snapshot expands beyond 512 MiB".to_string());
        }

        let path = entry
            .path()
            .map_err(|error| format!("CONSUL_SNAPSHOT_INVALID: Invalid snapshot path: {error}"))?
            .to_string_lossy()
            .trim_start_matches("./")
            .to_string();
        match path.as_str() {
            "meta.json" | "state.bin" => {
                let mut hasher = Sha256::new();
                let mut buffer = [0_u8; 64 * 1024];
                let mut bytes_read = 0_u64;
                loop {
                    let count = entry
                        .read(&mut buffer)
                        .map_err(|error| format!("CONSUL_SNAPSHOT_INVALID: Failed to read {path}: {error}"))?;
                    if count == 0 {
                        break;
                    }
                    bytes_read += count as u64;
                    hasher.update(&buffer[..count]);
                }
                if bytes_read == 0 {
                    return Err(format!("CONSUL_SNAPSHOT_INVALID: Snapshot entry {path} is empty"));
                }
                if digests.insert(path.clone(), hex_digest(hasher.finalize().as_slice())).is_some() {
                    return Err(format!("CONSUL_SNAPSHOT_INVALID: Snapshot contains duplicate {path}"));
                }
            }
            "SHA256SUMS" => {
                if size > 64 * 1024 {
                    return Err("CONSUL_SNAPSHOT_INVALID: Snapshot checksum manifest is too large".to_string());
                }
                let mut manifest = Vec::with_capacity(size as usize);
                entry
                    .read_to_end(&mut manifest)
                    .map_err(|error| format!("CONSUL_SNAPSHOT_INVALID: Failed to read checksum manifest: {error}"))?;
                if checksum_manifest.replace(manifest).is_some() {
                    return Err("CONSUL_SNAPSHOT_INVALID: Snapshot contains duplicate SHA256SUMS".to_string());
                }
            }
            _ => {
                std::io::copy(&mut entry, &mut std::io::sink())
                    .map_err(|error| format!("CONSUL_SNAPSHOT_INVALID: Failed to read snapshot entry: {error}"))?;
            }
        }
    }

    let mut decoder = archive.into_inner();
    std::io::copy(&mut decoder, &mut std::io::sink())
        .map_err(|error| format!("CONSUL_SNAPSHOT_INVALID: Corrupt gzip stream: {error}"))?;

    let manifest =
        checksum_manifest.ok_or_else(|| "CONSUL_SNAPSHOT_INVALID: Snapshot is missing SHA256SUMS".to_string())?;
    let manifest = std::str::from_utf8(&manifest)
        .map_err(|_| "CONSUL_SNAPSHOT_INVALID: Snapshot checksum manifest is not UTF-8".to_string())?;
    let expected = parse_checksum_manifest(manifest)?;
    for required in ["meta.json", "state.bin"] {
        let actual =
            digests.get(required).ok_or_else(|| format!("CONSUL_SNAPSHOT_INVALID: Snapshot is missing {required}"))?;
        let expected = expected
            .get(required)
            .ok_or_else(|| format!("CONSUL_SNAPSHOT_INVALID: Checksum manifest is missing {required}"))?;
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(format!("CONSUL_SNAPSHOT_INVALID: Checksum mismatch for {required}"));
        }
    }
    Ok(())
}

fn parse_checksum_manifest(manifest: &str) -> Result<HashMap<String, String>, String> {
    let mut checksums = HashMap::new();
    for line in manifest.lines().filter(|line| !line.trim().is_empty()) {
        let mut fields = line.split_whitespace();
        let checksum = fields.next().unwrap_or_default();
        let path = fields.next().unwrap_or_default().trim_start_matches('*').trim_start_matches("./");
        if checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) || path.is_empty() {
            return Err("CONSUL_SNAPSHOT_INVALID: Malformed SHA256SUMS entry".to_string());
        }
        if checksums.insert(path.to_string(), checksum.to_string()).is_some() {
            return Err(format!("CONSUL_SNAPSHOT_INVALID: Duplicate SHA256SUMS entry for {path}"));
        }
    }
    Ok(checksums)
}

fn hex_digest(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub async fn consul_autopilot_update_core(
    state: &AppState,
    connection_id: &str,
    update: ConsulAutopilotUpdate,
    confirmation: &str,
) -> Result<(), String> {
    ensure_operator_write(state, connection_id, "autopilot", "update Consul Autopilot").await?;
    if confirmation != "UPDATE AUTOPILOT" {
        return Err("CONSUL_CONFIRMATION_REQUIRED: Enter UPDATE AUTOPILOT".to_string());
    }
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url("/v1/operator/autopilot/configuration")?;
    client.send_json(Method::PUT, url, Some(&update), false, "update Consul Autopilot").await.map(|_| ())
}

pub async fn consul_raft_transfer_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulRaftWriteRequest,
) -> Result<(), String> {
    ensure_operator_write(state, connection_id, "raft", "transfer Consul Raft leadership").await?;
    let id =
        request.server_id.filter(|id| !id.is_empty()).ok_or("CONSUL_RAFT_TARGET_REQUIRED: Server ID is required")?;
    if request.confirmation != id {
        return Err("CONSUL_CONFIRMATION_REQUIRED: Re-enter the target server ID".to_string());
    }
    let client = client_for_state(state, connection_id).await?;
    let mut url = client.api_url("/v1/operator/raft/transfer-leader")?;
    url.query_pairs_mut().append_pair("id", &id);
    client.send_json(Method::POST, url, None::<&()>, false, "transfer Raft leadership").await.map(|_| ())
}

pub async fn consul_raft_remove_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulRaftWriteRequest,
) -> Result<(), String> {
    ensure_operator_write(state, connection_id, "raft", "remove Consul Raft peer").await?;
    let (key, target) = match (
        request.server_id.filter(|value| !value.is_empty()),
        request.address.filter(|value| !value.is_empty()),
    ) {
        (Some(id), None) => ("id", id),
        (None, Some(address)) => ("address", address),
        _ => return Err("CONSUL_RAFT_TARGET_INVALID: Specify exactly one server ID or address".to_string()),
    };
    if request.confirmation != target {
        return Err("CONSUL_CONFIRMATION_REQUIRED: Re-enter the peer identifier".to_string());
    }
    let client = client_for_state(state, connection_id).await?;
    let mut url = client.api_url("/v1/operator/raft/peer")?;
    url.query_pairs_mut().append_pair(key, &target);
    client.send_json(Method::DELETE, url, None::<&()>, false, "remove Raft peer").await.map(|_| ())
}

pub async fn consul_keyring_write_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulKeyringWriteRequest,
) -> Result<(), String> {
    ensure_operator_write(state, connection_id, "keyring", "modify Consul gossip keyring").await?;
    if request.confirmation != "CHANGE KEYRING" {
        return Err("CONSUL_CONFIRMATION_REQUIRED: Enter CHANGE KEYRING".to_string());
    }
    if request.key.trim().is_empty() {
        return Err("CONSUL_KEYRING_KEY_REQUIRED: Gossip key is required".to_string());
    }
    let client = client_for_state(state, connection_id).await?;
    let method = match request.operation {
        ConsulKeyringOperation::Install => Method::POST,
        ConsulKeyringOperation::Use => Method::PUT,
        ConsulKeyringOperation::Remove => Method::DELETE,
    };
    let url = client.api_url("/v1/operator/keyring")?;
    let body = ConsulKeyringWriteBody { key: request.key.trim() };
    client.send_json(method, url, Some(&body), false, "modify Consul gossip keyring").await.map(|_| ())
}

pub async fn consul_license_write_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulLicenseWriteRequest,
) -> Result<(), String> {
    ensure_operator_write(state, connection_id, "license", "update Consul license").await?;
    if request.confirmation != "UPDATE LICENSE" {
        return Err("CONSUL_CONFIRMATION_REQUIRED: Enter UPDATE LICENSE".to_string());
    }
    if request.license.trim().is_empty() {
        return Err("CONSUL_LICENSE_REQUIRED: License is required".to_string());
    }
    let client = client_for_state(state, connection_id).await?;
    let mut url = client.api_url("/v1/operator/license")?;
    client.append_scope(&mut url, false);
    ensure_success(
        client.send(Method::PUT, url, Some(request.license.into_bytes())).await?,
        "update Consul license",
        client.token(),
    )
    .await
    .map(|_| ())
}

async fn ensure_operator_write(
    state: &AppState,
    connection_id: &str,
    feature: &str,
    action: &str,
) -> Result<(), String> {
    ensure_writable_core(state, connection_id, action).await?;
    let client = client_for_state(state, connection_id).await?;
    if !client.operator_feature_enabled(feature) {
        return Err(format!("CONSUL_OPERATOR_FEATURE_DISABLED: {feature} is disabled by default"));
    }
    Ok(())
}

fn validate_datacenter_and_confirmation(
    client: &ConsulClient,
    target: &str,
    confirmation: &str,
    expected: &str,
) -> Result<(), String> {
    if client.datacenter().is_empty() || target != client.datacenter() {
        return Err("CONSUL_DATACENTER_MISMATCH: Snapshot target must match the configured Datacenter".to_string());
    }
    if confirmation != expected {
        return Err(format!("CONSUL_CONFIRMATION_REQUIRED: Enter {expected}"));
    }
    Ok(())
}

fn document(kind: String, value: serde_json::Value) -> ConsulOperatorDocument {
    let mut fields = Vec::new();
    if let Some(object) = value.as_object() {
        for (name, value) in object {
            let lower = name.to_ascii_lowercase();
            if lower.contains("secret") || lower.contains("token") || lower == "license" {
                continue;
            }
            let mut value = value.clone();
            redact_nested_sensitive_fields(&mut value);
            let mut rendered = match &value {
                serde_json::Value::String(value) => value.clone(),
                _ => value.to_string(),
            };
            rendered.truncate(4096);
            fields.push(ConsulOperatorField { name: name.clone(), value: rendered });
        }
    }
    ConsulOperatorDocument { kind, fields }
}

fn redact_nested_sensitive_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            object.retain(|name, _| {
                let lower = name.to_ascii_lowercase();
                !lower.contains("secret") && !lower.contains("token") && lower != "license"
            });
            for value in object.values_mut() {
                redact_nested_sensitive_fields(value);
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                redact_nested_sensitive_fields(value);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operator_document_drops_sensitive_fields() {
        let result = document(
            "license".to_string(),
            serde_json::json!({
                "SecretID":"top-secret",
                "Healthy":true,
                "Config": { "PeeringToken": "nested-secret", "Mode": "safe" }
            }),
        );
        assert_eq!(result.fields.len(), 2);
        assert!(result.fields.iter().any(|field| field.name == "Healthy"));
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("top-secret"));
        assert!(!serialized.contains("nested-secret"));
        assert!(serialized.contains("safe"));
    }

    #[test]
    fn keyring_body_uses_the_official_pascal_case_field() {
        let body = ConsulKeyringWriteBody { key: "sensitive-gossip-key" };
        assert_eq!(serde_json::to_value(body).unwrap(), serde_json::json!({ "Key": "sensitive-gossip-key" }));
    }

    #[test]
    fn snapshot_preflight_requires_a_gzip_archive() {
        assert!(validate_snapshot_archive(b"not-a-snapshot").is_err());
        let valid = snapshot_fixture(b"raft-state");
        assert!(validate_snapshot_archive(&valid).is_ok());

        let mut truncated = valid.clone();
        truncated.truncate(truncated.len() - 4);
        assert!(validate_snapshot_archive(&truncated).is_err());

        let invalid_checksum = snapshot_fixture_with_checksum(b"raft-state", "0".repeat(64));
        assert!(validate_snapshot_archive(&invalid_checksum).is_err());
    }

    fn snapshot_fixture(state: &[u8]) -> Vec<u8> {
        snapshot_fixture_with_checksum(state, hex_digest(Sha256::digest(state).as_slice()))
    }

    fn snapshot_fixture_with_checksum(state: &[u8], state_checksum: String) -> Vec<u8> {
        let metadata = br#"{"ID":"fixture"}"#;
        let manifest =
            format!("{}  meta.json\n{}  state.bin\n", hex_digest(Sha256::digest(metadata).as_slice()), state_checksum);
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        for (path, contents) in
            [("meta.json", metadata.as_slice()), ("state.bin", state), ("SHA256SUMS", manifest.as_bytes())]
        {
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o600);
            header.set_size(contents.len() as u64);
            header.set_cksum();
            archive.append_data(&mut header, path, contents).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap()
    }
}
