use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};

use super::{PluginFilesystemCapability, PluginFilesystemProviderContribution, PluginHost, PLUGIN_REQUEST_TIMEOUT};

pub const PLUGIN_FILESYSTEM_LIST_METHOD: &str = "filesystem/list";
pub const PLUGIN_FILESYSTEM_READ_METHOD: &str = "filesystem/read";
pub const PLUGIN_FILESYSTEM_WRITE_METHOD: &str = "filesystem/write";
pub const PLUGIN_FILESYSTEM_CREATE_DIRECTORY_METHOD: &str = "filesystem/createDirectory";
pub const PLUGIN_FILESYSTEM_DELETE_METHOD: &str = "filesystem/delete";
pub const PLUGIN_FILESYSTEM_RENAME_METHOD: &str = "filesystem/rename";
pub const DEFAULT_PLUGIN_FILESYSTEM_PAGE_SIZE: u32 = 200;
pub const MAX_PLUGIN_FILESYSTEM_PAGE_SIZE: u32 = 1_000;
pub const DEFAULT_PLUGIN_FILESYSTEM_PREVIEW_BYTES: u64 = 256 * 1024;
pub const MAX_PLUGIN_FILESYSTEM_PREVIEW_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_PLUGIN_FILESYSTEM_INLINE_WRITE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemListRequest<'a> {
    provider_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_id: Option<&'a str>,
    uri: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a str>,
    limit: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemReadRequest<'a> {
    provider_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_id: Option<&'a str>,
    uri: &'a str,
    max_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemWriteRequest<'a> {
    provider_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_id: Option<&'a str>,
    uri: &'a str,
    data_base64: &'a str,
    create: bool,
    overwrite: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    etag: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemCreateDirectoryRequest<'a> {
    provider_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_id: Option<&'a str>,
    uri: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemDeleteRequest<'a> {
    provider_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_id: Option<&'a str>,
    uri: &'a str,
    recursive: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemRenameRequest<'a> {
    provider_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_id: Option<&'a str>,
    source_uri: &'a str,
    target_uri: &'a str,
    overwrite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginFilesystemEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginFilesystemEntry {
    pub name: String,
    pub uri: String,
    pub kind: PluginFilesystemEntryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginFilesystemListResult {
    #[serde(default)]
    pub entries: Vec<PluginFilesystemEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginFilesystemReadResult {
    pub data_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginFilesystemMutationResult {
    #[serde(default = "default_true")]
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<PluginFilesystemEntry>,
}

fn default_true() -> bool {
    true
}

impl PluginHost {
    pub async fn list_filesystem_entries(
        &self,
        plugin_id: &str,
        provider_id: &str,
        connection_id: Option<&str>,
        uri: Option<&str>,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<PluginFilesystemListResult, String> {
        let provider = self.resolve_filesystem_provider(plugin_id, provider_id)?;
        let uri = resolve_filesystem_uri(&provider, uri)?;
        let limit = limit.unwrap_or(DEFAULT_PLUGIN_FILESYSTEM_PAGE_SIZE).clamp(1, MAX_PLUGIN_FILESYSTEM_PAGE_SIZE);
        let request = PluginFilesystemListRequest {
            provider_id,
            connection_id: normalized_optional_value(connection_id),
            uri: &uri,
            cursor: normalized_optional_value(cursor),
            limit,
        };
        let result: PluginFilesystemListResult = self
            .invoke(
                plugin_id,
                PLUGIN_FILESYSTEM_LIST_METHOD,
                serde_json::to_value(request).map_err(|error| error.to_string())?,
                None,
                Some(PLUGIN_REQUEST_TIMEOUT),
            )
            .await?;
        validate_list_result(&provider, &result, limit)?;
        Ok(result)
    }

    pub async fn read_filesystem_file(
        &self,
        plugin_id: &str,
        provider_id: &str,
        connection_id: Option<&str>,
        uri: &str,
        max_bytes: Option<u64>,
    ) -> Result<PluginFilesystemReadResult, String> {
        let provider = self.resolve_filesystem_provider(plugin_id, provider_id)?;
        ensure_provider_capability(plugin_id, &provider, PluginFilesystemCapability::Read)?;
        let uri = resolve_filesystem_uri(&provider, Some(uri))?;
        let max_bytes =
            max_bytes.unwrap_or(DEFAULT_PLUGIN_FILESYSTEM_PREVIEW_BYTES).clamp(1, MAX_PLUGIN_FILESYSTEM_PREVIEW_BYTES);
        let request = PluginFilesystemReadRequest {
            provider_id,
            connection_id: normalized_optional_value(connection_id),
            uri: &uri,
            max_bytes,
        };
        let result: PluginFilesystemReadResult = self
            .invoke(
                plugin_id,
                PLUGIN_FILESYSTEM_READ_METHOD,
                serde_json::to_value(request).map_err(|error| error.to_string())?,
                None,
                Some(Duration::from_secs(30)),
            )
            .await?;
        validate_read_result(&result, max_bytes)?;
        Ok(result)
    }

    pub async fn write_filesystem_file(
        &self,
        plugin_id: &str,
        provider_id: &str,
        connection_id: Option<&str>,
        uri: &str,
        data_base64: &str,
        create: bool,
        overwrite: bool,
        etag: Option<&str>,
    ) -> Result<PluginFilesystemMutationResult, String> {
        let provider = self.resolve_filesystem_provider(plugin_id, provider_id)?;
        ensure_provider_capability(plugin_id, &provider, PluginFilesystemCapability::Write)?;
        let uri = resolve_filesystem_uri(&provider, Some(uri))?;
        validate_inline_write_data(data_base64)?;
        let request = PluginFilesystemWriteRequest {
            provider_id,
            connection_id: normalized_optional_value(connection_id),
            uri: &uri,
            data_base64,
            create,
            overwrite,
            etag: normalized_optional_value(etag),
        };
        let result =
            self.invoke_filesystem_mutation(plugin_id, &provider, PLUGIN_FILESYSTEM_WRITE_METHOD, request).await?;
        Ok(result)
    }

    pub async fn create_filesystem_directory(
        &self,
        plugin_id: &str,
        provider_id: &str,
        connection_id: Option<&str>,
        uri: &str,
    ) -> Result<PluginFilesystemMutationResult, String> {
        let provider = self.resolve_filesystem_provider(plugin_id, provider_id)?;
        ensure_provider_capability(plugin_id, &provider, PluginFilesystemCapability::Mkdir)?;
        let uri = resolve_filesystem_uri(&provider, Some(uri))?;
        let request = PluginFilesystemCreateDirectoryRequest {
            provider_id,
            connection_id: normalized_optional_value(connection_id),
            uri: &uri,
        };
        self.invoke_filesystem_mutation(plugin_id, &provider, PLUGIN_FILESYSTEM_CREATE_DIRECTORY_METHOD, request).await
    }

    pub async fn delete_filesystem_entry(
        &self,
        plugin_id: &str,
        provider_id: &str,
        connection_id: Option<&str>,
        uri: &str,
        recursive: bool,
    ) -> Result<PluginFilesystemMutationResult, String> {
        let provider = self.resolve_filesystem_provider(plugin_id, provider_id)?;
        ensure_provider_capability(plugin_id, &provider, PluginFilesystemCapability::Delete)?;
        let uri = resolve_filesystem_uri(&provider, Some(uri))?;
        let request = PluginFilesystemDeleteRequest {
            provider_id,
            connection_id: normalized_optional_value(connection_id),
            uri: &uri,
            recursive,
        };
        self.invoke_filesystem_mutation(plugin_id, &provider, PLUGIN_FILESYSTEM_DELETE_METHOD, request).await
    }

    pub async fn rename_filesystem_entry(
        &self,
        plugin_id: &str,
        provider_id: &str,
        connection_id: Option<&str>,
        source_uri: &str,
        target_uri: &str,
        overwrite: bool,
    ) -> Result<PluginFilesystemMutationResult, String> {
        let provider = self.resolve_filesystem_provider(plugin_id, provider_id)?;
        ensure_provider_capability(plugin_id, &provider, PluginFilesystemCapability::Rename)?;
        let source_uri = resolve_filesystem_uri(&provider, Some(source_uri))?;
        let target_uri = resolve_filesystem_uri(&provider, Some(target_uri))?;
        let request = PluginFilesystemRenameRequest {
            provider_id,
            connection_id: normalized_optional_value(connection_id),
            source_uri: &source_uri,
            target_uri: &target_uri,
            overwrite,
        };
        self.invoke_filesystem_mutation(plugin_id, &provider, PLUGIN_FILESYSTEM_RENAME_METHOD, request).await
    }

    async fn invoke_filesystem_mutation<T: Serialize>(
        &self,
        plugin_id: &str,
        provider: &PluginFilesystemProviderContribution,
        method: &str,
        request: T,
    ) -> Result<PluginFilesystemMutationResult, String> {
        let result: PluginFilesystemMutationResult = self
            .invoke(
                plugin_id,
                method,
                serde_json::to_value(request).map_err(|error| error.to_string())?,
                None,
                Some(Duration::from_secs(30)),
            )
            .await?;
        validate_mutation_result(provider, &result)?;
        Ok(result)
    }

    fn resolve_filesystem_provider(
        &self,
        plugin_id: &str,
        provider_id: &str,
    ) -> Result<PluginFilesystemProviderContribution, String> {
        let plugin =
            self.registry().find_plugin(plugin_id)?.ok_or_else(|| format!("Plugin '{plugin_id}' is not installed"))?;
        if !plugin.compatibility.compatible {
            return Err(format!("Plugin '{plugin_id}' is incompatible: {}", plugin.compatibility.errors.join("; ")));
        }
        plugin
            .manifest
            .filesystem_provider(provider_id)?
            .ok_or_else(|| format!("Filesystem provider '{plugin_id}/{provider_id}' is not declared"))
    }
}

fn normalized_optional_value(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn resolve_filesystem_uri(
    provider: &PluginFilesystemProviderContribution,
    requested_uri: Option<&str>,
) -> Result<String, String> {
    let uri = requested_uri
        .map(str::trim)
        .filter(|uri| !uri.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| provider.root_uri.clone())
        .unwrap_or_else(|| format!("{}:/", provider.schemes[0]));
    if uri.len() > 4_096 || uri.chars().any(char::is_control) {
        return Err("Plugin filesystem URI is invalid".to_string());
    }
    let scheme = uri.split_once(':').map(|(scheme, _)| scheme).unwrap_or_default();
    if !provider.schemes.iter().any(|candidate| candidate == scheme) {
        return Err(format!("Filesystem URI scheme '{scheme}' is not handled by provider '{}'", provider.id));
    }
    Ok(uri)
}

fn validate_list_result(
    provider: &PluginFilesystemProviderContribution,
    result: &PluginFilesystemListResult,
    requested_limit: u32,
) -> Result<(), String> {
    let maximum_entries = usize::try_from(requested_limit).unwrap_or(usize::MAX);
    if result.entries.len() > maximum_entries {
        return Err(format!(
            "Filesystem provider '{}' returned {} entries for a limit of {requested_limit}",
            provider.id,
            result.entries.len()
        ));
    }
    if result.next_cursor.as_ref().is_some_and(|cursor| cursor.is_empty() || cursor.len() > 4_096) {
        return Err(format!("Filesystem provider '{}' returned an invalid cursor", provider.id));
    }
    for entry in &result.entries {
        validate_entry(provider, entry)?;
    }
    Ok(())
}

fn validate_entry(
    provider: &PluginFilesystemProviderContribution,
    entry: &PluginFilesystemEntry,
) -> Result<(), String> {
    if entry.name.trim().is_empty() || entry.name.len() > 1_024 || entry.name.chars().any(char::is_control) {
        return Err(format!("Filesystem provider '{}' returned an invalid entry name", provider.id));
    }
    resolve_filesystem_uri(provider, Some(&entry.uri))?;
    if entry.modified_at.as_ref().is_some_and(|value| value.len() > 128) {
        return Err(format!("Filesystem provider '{}' returned an invalid modified timestamp", provider.id));
    }
    if entry.content_type.as_ref().is_some_and(|value| value.len() > 256 || value.chars().any(char::is_control)) {
        return Err(format!("Filesystem provider '{}' returned an invalid content type", provider.id));
    }
    Ok(())
}

fn validate_read_result(result: &PluginFilesystemReadResult, max_bytes: u64) -> Result<(), String> {
    if result.content_type.as_ref().is_some_and(|value| value.len() > 256 || value.chars().any(char::is_control)) {
        return Err("Filesystem provider returned an invalid content type".to_string());
    }
    if result.etag.as_ref().is_some_and(|value| value.len() > 512 || value.chars().any(char::is_control)) {
        return Err("Filesystem provider returned an invalid etag".to_string());
    }
    let estimated_bytes = result.data_base64.len().saturating_mul(3) / 4;
    if estimated_bytes as u64 > max_bytes.saturating_add(2) {
        return Err(format!("Filesystem provider returned more than the requested {max_bytes} bytes"));
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&result.data_base64)
        .map_err(|error| format!("Filesystem provider returned invalid base64 data: {error}"))?;
    if decoded.len() as u64 > max_bytes {
        return Err(format!("Filesystem provider returned more than the requested {max_bytes} bytes"));
    }
    Ok(())
}

fn validate_inline_write_data(data_base64: &str) -> Result<(), String> {
    let estimated_bytes = data_base64.len().saturating_mul(3) / 4;
    if estimated_bytes as u64 > MAX_PLUGIN_FILESYSTEM_INLINE_WRITE_BYTES.saturating_add(2) {
        return Err(format!(
            "Inline plugin filesystem writes are limited to {MAX_PLUGIN_FILESYSTEM_INLINE_WRITE_BYTES} bytes"
        ));
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("Plugin filesystem write contains invalid base64 data: {error}"))?;
    if decoded.len() as u64 > MAX_PLUGIN_FILESYSTEM_INLINE_WRITE_BYTES {
        return Err(format!(
            "Inline plugin filesystem writes are limited to {MAX_PLUGIN_FILESYSTEM_INLINE_WRITE_BYTES} bytes"
        ));
    }
    Ok(())
}

fn validate_mutation_result(
    provider: &PluginFilesystemProviderContribution,
    result: &PluginFilesystemMutationResult,
) -> Result<(), String> {
    if !result.success {
        return Err(result.message.clone().unwrap_or_else(|| "Plugin filesystem operation failed".to_string()));
    }
    if result.message.as_ref().is_some_and(|message| message.len() > 4_096 || message.chars().any(char::is_control)) {
        return Err(format!("Filesystem provider '{}' returned an invalid operation message", provider.id));
    }
    if let Some(entry) = &result.entry {
        validate_entry(provider, entry)?;
    }
    Ok(())
}

fn ensure_provider_capability(
    plugin_id: &str,
    provider: &PluginFilesystemProviderContribution,
    capability: PluginFilesystemCapability,
) -> Result<(), String> {
    if provider.has_capability(capability) {
        Ok(())
    } else {
        Err(format!(
            "Filesystem provider '{plugin_id}/{}' does not declare {} capability",
            provider.id,
            capability.as_str()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_filesystem_uri, validate_inline_write_data, validate_list_result, validate_read_result};
    use crate::plugins::{
        PluginFilesystemCapability, PluginFilesystemEntry, PluginFilesystemEntryKind, PluginFilesystemListResult,
        PluginFilesystemProviderContribution, PluginFilesystemReadResult,
    };

    fn provider() -> PluginFilesystemProviderContribution {
        PluginFilesystemProviderContribution {
            id: "sample.files".to_string(),
            label: "Sample files".to_string(),
            schemes: vec!["sample".to_string()],
            description: None,
            capabilities: vec![PluginFilesystemCapability::Read],
            root_uri: Some("sample:/home".to_string()),
        }
    }

    #[test]
    fn resolves_declared_root_and_rejects_other_schemes() {
        assert_eq!(resolve_filesystem_uri(&provider(), None).unwrap(), "sample:/home");
        assert!(resolve_filesystem_uri(&provider(), Some("other:/tmp")).unwrap_err().contains("not handled"));
    }

    #[test]
    fn validates_list_limits_and_entry_uris() {
        let valid = PluginFilesystemListResult {
            entries: vec![PluginFilesystemEntry {
                name: "README.txt".to_string(),
                uri: "sample:/README.txt".to_string(),
                kind: PluginFilesystemEntryKind::File,
                size: Some(5),
                modified_at: None,
                content_type: Some("text/plain".to_string()),
            }],
            next_cursor: None,
        };
        validate_list_result(&provider(), &valid, 1).unwrap();
        assert!(validate_list_result(&provider(), &valid, 0).unwrap_err().contains("limit of 0"));
    }

    #[test]
    fn rejects_invalid_or_oversized_file_preview() {
        let invalid = PluginFilesystemReadResult {
            data_base64: "not base64".to_string(),
            content_type: None,
            truncated: false,
            etag: None,
        };
        assert!(validate_read_result(&invalid, 16).unwrap_err().contains("invalid base64"));

        let oversized = PluginFilesystemReadResult {
            data_base64: "YWJjZA==".to_string(),
            content_type: None,
            truncated: false,
            etag: None,
        };
        assert!(validate_read_result(&oversized, 3).unwrap_err().contains("more than"));
    }

    #[test]
    fn validates_inline_write_base64() {
        validate_inline_write_data("YWJjZA==").unwrap();
        assert!(validate_inline_write_data("not base64").unwrap_err().contains("invalid base64"));
    }
}
