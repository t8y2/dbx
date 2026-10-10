//! Add-only, offline DBX connection bundle import. Never connect to imported endpoints.
use crate::models::connection::{ConnectionConfig, TransportLayerConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{IsTerminal, Read},
    path::Path,
};

pub const MAX_IMPORT_BYTES: usize = 16 * 1024 * 1024;
fn invalid() -> String {
    "INVALID_CONNECTION_IMPORT: Invalid or unsupported connection bundle.".into()
}

fn open_regular_file(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| "INVALID_CONNECTION_IMPORT: Could not open input file.".to_string())?;
    let metadata = file.metadata().map_err(|_| invalid())?;
    if !metadata.is_file() {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("INSECURE_INPUT: Input files must be owner-only (chmod 600).".into());
        }
    }
    Ok(file)
}

/// File input is bounded and owner-only; parse errors never contain submitted values.
pub fn read_import_file(path: &Path, allow_stdin: bool) -> Result<Value, String> {
    let mut bytes = Vec::new();
    if path == Path::new("-") {
        if !allow_stdin || std::io::stdin().is_terminal() {
            return Err("INVALID_CONNECTION_IMPORT: Use an owner-only file or a non-interactive stdin pipe.".into());
        }
        std::io::stdin().take(MAX_IMPORT_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_| invalid())?;
    } else {
        let file = open_regular_file(path)?;
        file.take(MAX_IMPORT_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_| invalid())?;
    }
    if bytes.len() > MAX_IMPORT_BYTES {
        return Err("INVALID_CONNECTION_IMPORT: Import exceeds 16 MiB.".into());
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    serde_json::from_slice(bytes).map_err(|_| invalid())
}

/// Read encrypted exports using a separate owner-only passphrase file, never argv values.
/// One final LF/CRLF is removed to support files written by password-manager CLIs.
pub fn read_import_file_with_passphrase(
    path: &Path,
    allow_stdin: bool,
    passphrase_path: Option<&Path>,
) -> Result<Value, String> {
    if path == Path::new("-") && passphrase_path == Some(Path::new("-")) {
        return Err("INVALID_CONNECTION_IMPORT: Bundle and passphrase cannot share stdin.".into());
    }
    let value = read_import_file(path, allow_stdin)?;
    let encrypted = value.get("format").and_then(Value::as_str) == Some("dbx-encrypted");
    if !encrypted {
        if passphrase_path.is_some() {
            return Err("INVALID_CONNECTION_IMPORT: Passphrase file supplied for an unencrypted bundle.".into());
        }
        return Ok(value);
    }
    let path = passphrase_path.ok_or_else(|| {
        "IMPORT_PASSPHRASE_REQUIRED: Use an owner-only --passphrase-file for the encrypted export.".to_string()
    })?;
    let mut passphrase = zeroize::Zeroizing::new(Vec::new());
    if path == Path::new("-") {
        if !allow_stdin || std::io::stdin().is_terminal() {
            return Err("INVALID_CONNECTION_IMPORT: Passphrase stdin must be a non-interactive pipe.".into());
        }
        std::io::stdin().take(65537).read_to_end(&mut passphrase).map_err(|_| invalid())?;
    } else {
        open_regular_file(path)?.take(65537).read_to_end(&mut passphrase).map_err(|_| invalid())?;
    }
    if passphrase.len() > 65536 {
        return Err(invalid());
    }
    if passphrase.last() == Some(&b'\n') {
        passphrase.pop();
        if passphrase.last() == Some(&b'\r') {
            passphrase.pop();
        }
    }
    decrypt_import_payload(value, &passphrase)
}

pub fn decrypt_import_payload(value: Value, passphrase: &[u8]) -> Result<Value, String> {
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    use base64::{engine::general_purpose::STANDARD, Engine};
    let wrong = || "IMPORT_DECRYPT_FAILED: Encrypted export or passphrase is invalid.".to_string();
    if value["format"] != "dbx-encrypted" || value["version"] != 1 || std::str::from_utf8(passphrase).is_err() {
        return Err(wrong());
    }
    let decode = |key: &str| -> Result<Vec<u8>, String> {
        STANDARD.decode(value[key].as_str().ok_or_else(wrong)?).map_err(|_| wrong())
    };
    let salt = decode("salt")?;
    let iv = decode("iv")?;
    let data = decode("data")?;
    if salt.len() != 16 || iv.len() != 12 || data.len() < 16 || data.len() > MAX_IMPORT_BYTES {
        return Err(wrong());
    }
    let mut key = zeroize::Zeroizing::new([0u8; 32]);
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(passphrase, &salt, 100_000, &mut *key);
    let cipher = Aes256Gcm::new_from_slice(&*key).map_err(|_| wrong())?;
    let plaintext =
        zeroize::Zeroizing::new(cipher.decrypt(Nonce::from_slice(&iv), data.as_ref()).map_err(|_| wrong())?);
    serde_json::from_slice(&plaintext).map_err(|_| wrong())
}

// Deliberately no Debug: connection and profile values can contain credentials.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ImportBundle {
    pub connections: Vec<ConnectionConfig>,
    #[serde(default)]
    pub layout: Option<Value>,
    #[serde(default, rename = "tunnelProfiles")]
    pub profiles: Vec<TransportLayerConfig>,
    #[serde(skip)]
    pub timeout_inheritance: HashMap<String, (bool, bool)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionImportReport {
    pub dry_run: bool,
    pub input_count: usize,
    pub imported_count: usize,
    pub skipped_count: usize,
    pub tunnel_profile_count: usize,
    pub connections_without_password: usize,
    pub ssh_layers_without_credentials: usize,
    pub file_database_count: usize,
    pub warnings: Vec<String>,
}

pub(crate) struct ImportPlan {
    pub connections: Vec<ConnectionConfig>,
    pub profiles: Vec<TransportLayerConfig>,
    pub layout: Value,
    pub report: ConnectionImportReport,
    pub timeout_inheritance: Vec<(String, bool, bool)>,
}

pub(crate) fn parse_bundle(mut value: Value) -> Result<ImportBundle, String> {
    if serde_json::to_vec(&value).map_err(|_| invalid())?.len() > MAX_IMPORT_BYTES {
        return Err(invalid());
    }
    if value.is_array() {
        value = json!({"connections":value});
    }
    if let Some(object) = value.as_object_mut() {
        if object.get("format").and_then(Value::as_str) == Some("dbx-encrypted") {
            return Err("ENCRYPTED_IMPORT_UNSUPPORTED: Decrypt the export in DBX first; never put its passphrase in command arguments.".into());
        }
        if let Some(format) = object.remove("format") {
            if format != "dbx-config" {
                return Err(invalid());
            }
            if let Some(version) = object.remove("version") {
                if version != 1 {
                    return Err(invalid());
                }
            }
        }
    }
    let mut timeout_inheritance = HashMap::new();
    if let Some(connections) = value.get("connections").and_then(Value::as_array) {
        for config in connections {
            if config.get("connect_timeout_inherit").is_some() || config.get("query_timeout_inherit").is_some() {
                let mut flags = [false; 2];
                for (index, key) in ["connect_timeout_inherit", "query_timeout_inherit"].into_iter().enumerate() {
                    if let Some(value) = config.get(key) {
                        flags[index] = value.as_bool().ok_or_else(invalid)?;
                    }
                }
                let id = config.get("id").and_then(Value::as_str).ok_or_else(invalid)?;
                timeout_inheritance.insert(id.to_string(), (flags[0], flags[1]));
            }
        }
    }
    let mut bundle: ImportBundle = serde_json::from_value(value).map_err(|_| invalid())?;
    bundle.timeout_inheritance = timeout_inheritance;
    if bundle.connections.is_empty() || bundle.connections.len() > 10_000 || bundle.profiles.len() > 10_000 {
        return Err(invalid());
    }
    let mut ids = HashSet::new();
    for config in &bundle.connections {
        if config.id.trim().is_empty() || !ids.insert(config.id.clone()) {
            return Err(invalid());
        }
        super::connection_management::validate_connection_patch(&json!({"name":config.name,"host":config.host}))?;
        // Device-bound envelopes are not portable passwords. Never persist them as plaintext credentials.
        if config.password.starts_with("enc:") || config.password.starts_with("dbx-secret:") {
            return Err(
                "ENCRYPTED_IMPORT_UNSUPPORTED: Device-bound credentials cannot be imported as passwords.".into()
            );
        }
    }
    let mut profile_ids = HashSet::new();
    for profile in &bundle.profiles {
        if profile.id().trim().is_empty() || !profile_ids.insert(profile.id()) || !profile.profile_id().is_empty() {
            return Err(invalid());
        }
    }
    for config in &bundle.connections {
        for layer in &config.transport_layers {
            if !layer.profile_id().is_empty()
                && !bundle.profiles.iter().any(|p| p.id() == layer.profile_id() && p.same_type_as(layer))
            {
                return Err(invalid());
            }
        }
    }
    Ok(bundle)
}

fn identity(config: &ConnectionConfig) -> String {
    // Name alone is not an identity; different DB types/databases must never be silently skipped.
    json!([
        config.name.trim().to_lowercase(),
        config.db_type,
        config.host,
        config.port,
        config.database,
        config.username
    ])
    .to_string()
}
fn remap_profile(layer: &mut TransportLayerConfig, id: Option<String>, profile_id: Option<String>) {
    match layer {
        TransportLayerConfig::Ssh(v) => {
            if let Some(id) = id {
                v.id = id
            }
            if let Some(id) = profile_id {
                v.profile_id = id
            }
        }
        TransportLayerConfig::Proxy(v) => {
            if let Some(id) = id {
                v.id = id
            }
            if let Some(id) = profile_id {
                v.profile_id = id
            }
        }
        TransportLayerConfig::HttpTunnel(v) => {
            if let Some(id) = id {
                v.id = id
            }
            if let Some(id) = profile_id {
                v.profile_id = id
            }
        }
    }
}

pub(crate) fn plan_import(
    bundle: ImportBundle,
    existing: &[ConnectionConfig],
    current_layout: Option<Value>,
    dry_run: bool,
) -> Result<ImportPlan, String> {
    let input_count = bundle.connections.len();
    let mut identities: HashSet<String> = existing.iter().map(identity).collect();
    let mut new_ids = HashMap::new();
    let mut connections = Vec::new();
    let mut skipped_count = 0;
    for config in bundle.connections {
        let mut config = config.canonicalized();
        let fingerprint = identity(&config);
        if identities.contains(&fingerprint) {
            skipped_count += 1;
            continue;
        }
        identities.insert(fingerprint);
        let id = uuid::Uuid::new_v4().to_string();
        new_ids.insert(config.id.clone(), id.clone());
        config.id = id;
        connections.push(config.canonicalized());
    }
    let referenced: HashSet<String> = connections
        .iter()
        .flat_map(|c| c.transport_layers.iter())
        .filter_map(|l| (!l.profile_id().is_empty()).then(|| l.profile_id().to_string()))
        .collect();
    let mut profiles = Vec::new();
    let mut profile_ids = HashMap::new();
    for mut profile in bundle.profiles {
        if !referenced.contains(profile.id()) {
            continue;
        }
        let new_id = uuid::Uuid::new_v4().to_string();
        profile_ids.insert(profile.id().to_string(), new_id.clone());
        remap_profile(&mut profile, Some(new_id), None);
        profiles.push(profile);
    }
    for config in &mut connections {
        for layer in &mut config.transport_layers {
            if let Some(id) = profile_ids.get(layer.profile_id()) {
                remap_profile(layer, None, Some(id.clone()));
            }
        }
    }
    let timeout_inheritance = bundle
        .timeout_inheritance
        .into_iter()
        .filter_map(|(source, (connect, query))| new_ids.get(&source).map(|id| (id.clone(), connect, query)))
        .collect();
    let layout = merge_import_layout(current_layout, bundle.layout, &new_ids)?;
    let without_password = connections.iter().filter(|c| c.password.is_empty()).count();
    let ssh_missing = connections
        .iter()
        .flat_map(|c| c.transport_layers.iter())
        .filter(|l| match l {
            TransportLayerConfig::Ssh(s) => {
                s.enabled && s.password.is_empty() && s.key_path.is_empty() && s.profile_id.is_empty()
            }
            _ => false,
        })
        .count();
    let files = connections
        .iter()
        .filter(|c| {
            matches!(
                c.db_type,
                crate::models::connection::DatabaseType::Sqlite | crate::models::connection::DatabaseType::DuckDb
            )
        })
        .count();
    let mut warnings = vec![
        "Configuration only: no database connection, credential validation, or file copying was performed.".into(),
    ];
    if without_password > 0 {
        warnings
            .push("Some imported connections have no saved password; credentials may be required before use.".into());
    }
    if ssh_missing > 0 {
        warnings
            .push("Some enabled SSH layers have no password or key path; configure authentication before use.".into());
    }
    if files > 0 {
        warnings.push("File-based database paths are preserved verbatim; source files are not included and may be unavailable on this computer.".into());
    }
    warnings.push("Loopback, private-network addresses, and device-specific paths keep their original meaning and may not be reachable on this computer.".into());
    let report = ConnectionImportReport {
        dry_run,
        input_count,
        imported_count: connections.len(),
        skipped_count,
        tunnel_profile_count: profiles.len(),
        connections_without_password: without_password,
        ssh_layers_without_credentials: ssh_missing,
        file_database_count: files,
        warnings,
    };
    Ok(ImportPlan { connections, profiles, layout, report, timeout_inheritance })
}

fn merge_import_layout(
    current: Option<Value>,
    imported: Option<Value>,
    ids: &HashMap<String, String>,
) -> Result<Value, String> {
    let mut current = current.unwrap_or_else(|| json!({"groups":[],"order":[]}));
    if !current["groups"].is_array() || !current["order"].is_array() {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    if let Some(imported) = imported {
        let groups = imported["groups"].as_array().ok_or_else(invalid)?;
        let order = imported["order"].as_array().ok_or_else(invalid)?;
        let mut group_map = HashMap::new();
        for group in groups {
            let id = group["id"].as_str().filter(|s| !s.is_empty()).ok_or_else(invalid)?;
            if !group["name"].is_string() || group_map.insert(id.to_owned(), group.clone()).is_some() {
                return Err(invalid());
            }
        }
        fn walk(
            entries: &[Value],
            groups: &HashMap<String, Value>,
            ids: &HashMap<String, String>,
            seen: &mut HashSet<String>,
            seen_groups: &mut HashSet<String>,
            new_groups: &mut Vec<Value>,
            depth: usize,
        ) -> Result<Vec<Value>, String> {
            if depth > 64 {
                return Err(invalid());
            }
            let mut result = Vec::new();
            for entry in entries {
                let id = entry["id"].as_str().ok_or_else(invalid)?;
                match entry["type"].as_str() {
                    Some("connection") => {
                        if let Some(new_id) = ids.get(id) {
                            if seen.insert(id.to_owned()) {
                                result.push(json!({"type":"connection","id":new_id}));
                            }
                        }
                    }
                    Some("group") => {
                        if !seen_groups.insert(id.to_owned()) {
                            return Err(invalid());
                        }
                        let mut group = groups.get(id).cloned().ok_or_else(invalid)?;
                        let legacy = entry["connectionIds"]
                            .as_array()
                            .map(|v| v.iter().map(|id| json!({"type":"connection","id":id})).collect::<Vec<_>>());
                        let children = entry["children"].as_array().or(legacy.as_ref()).ok_or_else(invalid)?;
                        let children = walk(children, groups, ids, seen, seen_groups, new_groups, depth + 1)?;
                        if !children.is_empty() {
                            let new_id = uuid::Uuid::new_v4().to_string();
                            group["id"] = json!(new_id);
                            new_groups.push(group);
                            result.push(json!({"type":"group","id":new_id,"children":children}));
                        }
                    }
                    _ => return Err(invalid()),
                }
            }
            Ok(result)
        }
        let mut new_groups = Vec::new();
        let order = walk(order, &group_map, ids, &mut seen, &mut HashSet::new(), &mut new_groups, 0)?;
        current["groups"].as_array_mut().unwrap().extend(new_groups);
        current["order"].as_array_mut().unwrap().extend(order);
    }
    // Stable fallback order for bundles without a layout.
    let mut remaining = ids.iter().filter(|(id, _)| !seen.contains(*id)).collect::<Vec<_>>();
    remaining.sort_by_key(|(id, _)| *id);
    current["order"]
        .as_array_mut()
        .unwrap()
        .extend(remaining.into_iter().map(|(_, id)| json!({"type":"connection","id":id})));
    Ok(current)
}
