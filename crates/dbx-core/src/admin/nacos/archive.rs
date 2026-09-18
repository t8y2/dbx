use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;

use crate::nacos::types::{NacosConfigItem, NacosConfigUpsert};

pub const MAX_ARCHIVE_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_CONFIG_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_METADATA_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_CONFIG_ITEMS: usize = 10_000;
const METADATA_PATH: &str = ".metadata.yml";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MetadataItem {
    group: String,
    #[serde(rename = "dataId")]
    data_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    desc: Option<String>,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    config_type: Option<String>,
    #[serde(rename = "appName", default, skip_serializing_if = "Option::is_none")]
    app_name: Option<String>,
    #[serde(rename = "configTags", default, skip_serializing_if = "Option::is_none")]
    config_tags: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MetadataDocument {
    metadata: Vec<MetadataItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum CompatibleMetadata {
    Document(MetadataDocument),
    Items(Vec<MetadataItem>),
}

impl CompatibleMetadata {
    fn into_items(self) -> Vec<MetadataItem> {
        match self {
            Self::Document(document) => document.metadata,
            Self::Items(items) => items,
        }
    }
}

pub fn encode_config_archive(configs: &[NacosConfigItem]) -> Result<Vec<u8>, String> {
    if configs.len() > MAX_CONFIG_ITEMS {
        return Err(format!("Nacos archive contains more than {MAX_CONFIG_ITEMS} configurations"));
    }
    let mut sorted = configs.to_vec();
    sorted.sort_by(|left, right| {
        (&left.group, &left.data_id, &left.namespace).cmp(&(&right.group, &right.data_id, &right.namespace))
    });
    let mut seen = HashSet::new();
    let mut metadata = Vec::with_capacity(sorted.len());
    let mut actual_uncompressed = 0u64;
    for config in &sorted {
        validate_config_key(&config.group, &config.data_id)?;
        if !seen.insert((config.group.clone(), config.data_id.clone())) {
            return Err(format!("Duplicate Nacos configuration key: {}/{}", config.group, config.data_id));
        }
        let content = config
            .content
            .as_deref()
            .ok_or_else(|| format!("Nacos configuration {}/{} has no content", config.group, config.data_id))?;
        if content.len() as u64 > MAX_CONFIG_BYTES {
            return Err(format!("Nacos configuration {}/{} exceeds the 20 MiB limit", config.group, config.data_id));
        }
        actual_uncompressed = add_uncompressed_size(actual_uncompressed, content.len() as u64)?;
        metadata.push(MetadataItem {
            group: config.group.clone(),
            data_id: config.data_id.clone(),
            desc: config.desc.clone(),
            config_type: config.config_type.clone(),
            app_name: config.app_name.clone(),
            config_tags: config.tags.clone(),
        });
    }
    let metadata = serde_yaml_ng::to_string(&MetadataDocument { metadata })
        .map_err(|error| format!("Failed to encode Nacos archive metadata: {error}"))?;
    if metadata.len() as u64 > MAX_METADATA_BYTES {
        return Err("Nacos archive metadata exceeds the 2 MiB limit".to_string());
    }
    add_uncompressed_size(actual_uncompressed, metadata.len() as u64)?;

    let cursor = Cursor::new(Vec::new());
    let mut archive = zip::ZipWriter::new(cursor);
    let options =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).unix_permissions(0o600);
    archive
        .start_file(METADATA_PATH, options)
        .map_err(|error| format!("Failed to create Nacos archive metadata entry: {error}"))?;
    archive
        .write_all(metadata.as_bytes())
        .map_err(|error| format!("Failed to write Nacos archive metadata: {error}"))?;
    for config in sorted {
        archive
            .start_file(archive_entry_path(&config.group, &config.data_id), options)
            .map_err(|error| format!("Failed to create Nacos archive entry: {error}"))?;
        archive
            .write_all(config.content.as_deref().unwrap_or_default().as_bytes())
            .map_err(|error| format!("Failed to write Nacos archive entry: {error}"))?;
    }
    let bytes = archive.finish().map_err(|error| format!("Failed to finish Nacos archive: {error}"))?.into_inner();
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err("Nacos archive exceeds the 100 MiB limit".to_string());
    }
    Ok(bytes)
}

pub fn decode_config_archive(bytes: &[u8], target_namespace: &str) -> Result<Vec<NacosConfigUpsert>, String> {
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err("Nacos archive exceeds the 100 MiB limit".to_string());
    }
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("Invalid Nacos ZIP archive: {error}"))?;
    if archive.len() > MAX_CONFIG_ITEMS.saturating_add(1) {
        return Err(format!("Nacos archive contains more than {MAX_CONFIG_ITEMS} configurations"));
    }
    let mut entries = HashMap::<String, Vec<u8>>::new();
    let mut actual_uncompressed = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| format!("Invalid Nacos ZIP entry: {error}"))?;
        let name = entry.name().to_string();
        validate_archive_path(&name)?;
        if entry.is_dir() {
            continue;
        }
        if entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            return Err(format!("Nacos archive symlink is not allowed: {name}"));
        }
        let declared_limit = if name == METADATA_PATH { MAX_METADATA_BYTES } else { MAX_CONFIG_BYTES };
        if entry.size() > declared_limit {
            return Err(format!("Nacos archive entry exceeds its size limit: {name}"));
        }
        let mut content = Vec::with_capacity(entry.size().min(declared_limit) as usize);
        entry
            .by_ref()
            .take(declared_limit + 1)
            .read_to_end(&mut content)
            .map_err(|error| format!("Failed to read Nacos archive entry {name}: {error}"))?;
        if content.len() as u64 > declared_limit {
            return Err(format!("Nacos archive entry exceeds its size limit: {name}"));
        }
        actual_uncompressed = add_uncompressed_size(actual_uncompressed, content.len() as u64)?;
        if entries.insert(name.clone(), content).is_some() {
            return Err(format!("Duplicate Nacos archive path: {name}"));
        }
    }
    let metadata = entries.remove(METADATA_PATH).ok_or_else(|| "Nacos archive is missing .metadata.yml".to_string())?;
    let metadata: CompatibleMetadata =
        serde_yaml_ng::from_slice(&metadata).map_err(|error| format!("Invalid Nacos archive metadata: {error}"))?;
    let metadata = metadata.into_items();
    if metadata.len() > MAX_CONFIG_ITEMS {
        return Err(format!("Nacos archive contains more than {MAX_CONFIG_ITEMS} configurations"));
    }
    let mut keys = HashSet::new();
    let mut configs = Vec::with_capacity(metadata.len());
    for item in metadata {
        validate_config_key(&item.group, &item.data_id)?;
        if !keys.insert((item.group.clone(), item.data_id.clone())) {
            return Err(format!("Duplicate Nacos configuration key: {}/{}", item.group, item.data_id));
        }
        let path = archive_entry_path(&item.group, &item.data_id);
        // Archives exported by older DBX versions and the Nacos console use
        // the direct `group/dataId` layout. Keep accepting it as a fallback;
        // new exports only use that layout when both components are safe.
        let legacy_path = format!("{}/{}", item.group, item.data_id);
        let content = entries
            .remove(&path)
            .or_else(|| entries.remove(&legacy_path))
            .ok_or_else(|| format!("Nacos archive metadata references a missing file: {path}"))?;
        let content =
            String::from_utf8(content).map_err(|_| format!("Nacos configuration is not valid UTF-8: {path}"))?;
        configs.push(NacosConfigUpsert {
            namespace: Some(target_namespace.to_string()),
            data_id: item.data_id,
            group: item.group,
            content,
            config_type: item.config_type,
            app_name: item.app_name,
            desc: item.desc,
            tags: item.config_tags,
        });
    }
    if let Some(orphan) = entries.keys().next() {
        return Err(format!("Nacos archive contains an orphan file not present in metadata: {orphan}"));
    }
    Ok(configs)
}

fn validate_archive_path(name: &str) -> Result<(), String> {
    let bytes = name.as_bytes();
    let has_windows_drive_prefix =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\');
    if name.is_empty()
        || name.contains('\0')
        || name.contains('\\')
        || name.starts_with('/')
        || has_windows_drive_prefix
    {
        return Err(format!("Unsafe Nacos archive path: {name}"));
    }
    let path = Path::new(name);
    if path.components().any(|component| !matches!(component, Component::Normal(_))) {
        return Err(format!("Unsafe Nacos archive path: {name}"));
    }
    Ok(())
}

fn add_uncompressed_size(current: u64, addition: u64) -> Result<u64, String> {
    let total = current.checked_add(addition).ok_or_else(|| "Nacos archive uncompressed size overflow".to_string())?;
    if total > MAX_UNCOMPRESSED_BYTES {
        return Err("Nacos archive exceeds the 256 MiB uncompressed limit".to_string());
    }
    Ok(total)
}

fn validate_config_key(group: &str, data_id: &str) -> Result<(), String> {
    for (label, value) in [("group", group), ("dataId", data_id)] {
        if value.trim().is_empty() || value.contains('\0') {
            return Err(format!("Invalid Nacos configuration {label}: {value:?}"));
        }
    }
    Ok(())
}

fn archive_entry_path(group: &str, data_id: &str) -> String {
    if is_safe_archive_component(group) && is_safe_archive_component(data_id) {
        return format!("{group}/{data_id}");
    }
    // Metadata is the source of truth for the original identifiers. Hex keeps
    // the ZIP entry path portable and collision-free without treating Nacos
    // identifiers as filesystem paths.
    format!("configs/{}--{}", hex_encode(group.as_bytes()), hex_encode(data_id.as_bytes()))
}

fn is_safe_archive_component(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".." && !value.contains(['/', '\\', '\0'])
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(group: &str, data_id: &str, content: &str) -> NacosConfigItem {
        NacosConfigItem {
            data_id: data_id.to_string(),
            group: group.to_string(),
            namespace: "source".to_string(),
            app_name: Some("dbx".to_string()),
            desc: Some("test".to_string()),
            tags: Some("one,two".to_string()),
            config_type: Some("yaml".to_string()),
            md5: None,
            encrypted_data_key: Some("must-not-leak".to_string()),
            content: Some(content.to_string()),
        }
    }

    #[test]
    fn archive_round_trip_preserves_migratable_fields_only() {
        let bytes = encode_config_archive(&[config("DEFAULT_GROUP", "app.yaml", "数据库: mysql://db")]).unwrap();
        let decoded = decode_config_archive(&bytes, "target").unwrap();
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].namespace.as_deref(), Some("target"));
        assert_eq!(decoded[0].content, "数据库: mysql://db");
        assert_eq!(decoded[0].tags.as_deref(), Some("one,two"));
    }

    #[test]
    fn rejects_path_traversal() {
        let cursor = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        zip.start_file("../evil", SimpleFileOptions::default()).unwrap();
        zip.write_all(b"bad").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let error = decode_config_archive(&bytes, "target").unwrap_err();
        assert!(error.contains("Unsafe"));
    }

    #[test]
    fn rejects_windows_absolute_path() {
        let cursor = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        zip.start_file("C:/secret", SimpleFileOptions::default()).unwrap();
        zip.write_all(b"bad").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let error = decode_config_archive(&bytes, "target").unwrap_err();
        assert!(error.contains("Unsafe"));
    }

    #[test]
    fn enforces_total_uncompressed_limit_arithmetically() {
        assert_eq!(add_uncompressed_size(MAX_UNCOMPRESSED_BYTES - 1, 1).unwrap(), MAX_UNCOMPRESSED_BYTES);
        assert!(add_uncompressed_size(MAX_UNCOMPRESSED_BYTES, 1).unwrap_err().contains("256 MiB"));
    }

    #[test]
    fn accepts_official_list_shaped_metadata() {
        let cursor = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        zip.start_file(METADATA_PATH, SimpleFileOptions::default()).unwrap();
        zip.write_all(b"- group: DEFAULT_GROUP\n  dataId: app.properties\n  type: properties\n").unwrap();
        zip.start_file("DEFAULT_GROUP/app.properties", SimpleFileOptions::default()).unwrap();
        zip.write_all(b"a=1").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        assert_eq!(decode_config_archive(&bytes, "").unwrap()[0].content, "a=1");
    }

    #[test]
    fn archive_round_trip_preserves_identifiers_with_path_separators() {
        let bytes = encode_config_archive(&[config("team/dev", "apps/service.yaml", "enabled: true")]).unwrap();
        let archive = zip::ZipArchive::new(Cursor::new(bytes.clone())).unwrap();
        assert!(archive.file_names().any(|name| name.starts_with("configs/")));

        let decoded = decode_config_archive(&bytes, "target").unwrap();
        assert_eq!(decoded[0].group, "team/dev");
        assert_eq!(decoded[0].data_id, "apps/service.yaml");
    }

    #[test]
    fn accepts_legacy_nested_path_for_separator_identifiers() {
        let cursor = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        zip.start_file(METADATA_PATH, SimpleFileOptions::default()).unwrap();
        zip.write_all(b"- group: team/dev\n  dataId: apps/service.yaml\n").unwrap();
        zip.start_file("team/dev/apps/service.yaml", SimpleFileOptions::default()).unwrap();
        zip.write_all(b"enabled: true").unwrap();
        let bytes = zip.finish().unwrap().into_inner();

        let decoded = decode_config_archive(&bytes, "target").unwrap();
        assert_eq!(decoded[0].group, "team/dev");
        assert_eq!(decoded[0].data_id, "apps/service.yaml");
    }
}
