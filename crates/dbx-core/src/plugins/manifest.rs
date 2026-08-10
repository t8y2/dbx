use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf};

use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};

pub const SUPPORTED_PLUGIN_MANIFEST_VERSION: u32 = 1;
pub const SUPPORTED_PLUGIN_HOST_API_VERSION: &str = "1.1.0";
pub const SUPPORTED_PLUGIN_PROTOCOL_VERSION: u32 = 1;
pub const PLUGIN_CONNECTION_TEST_METHOD: &str = "connection/test";
pub const PLUGIN_CONNECTION_CONNECT_METHOD: &str = "connection/connect";
pub const PLUGIN_CONNECTION_DISCONNECT_METHOD: &str = "connection/disconnect";
pub const PLUGIN_CONNECTION_ACTION_METHOD: &str = "connection/action";
pub const SUPPORTED_PLUGIN_PERMISSIONS: &[&str] =
    &["host.events", "host.binary", "host.workbench", "host.filesystem", "host.fileTransfer", "host.clipboard"];
pub const PLUGIN_CONNECTION_CHALLENGE_EVENT_METHOD: &str = "connection/challenge";
pub const PLUGIN_CONNECTION_CHALLENGE_RESOLVE_METHOD: &str = "connection/challenge/resolve";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginManifest {
    #[serde(rename = "$schema", default, skip_serializing)]
    pub schema: Option<String>,
    #[serde(default)]
    pub manifest_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub engines: PluginEngines,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub entrypoints: PluginEntrypoints,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contributions: Vec<PluginContribution>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub localizations: BTreeMap<String, PluginManifestLocalization>,
    #[serde(default, flatten, skip_serializing)]
    pub unknown_fields: BTreeMap<String, serde_json::Value>,

    // Legacy manifest v0 fields. They remain readable so the existing JDBC
    // plugin can migrate independently from the host runtime.
    #[serde(default = "default_plugin_protocol_version", skip_serializing_if = "is_default_plugin_protocol_version")]
    pub protocol_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drivers: Vec<PluginDriverManifest>,
}

fn default_plugin_protocol_version() -> u32 {
    SUPPORTED_PLUGIN_PROTOCOL_VERSION
}

fn is_default_plugin_protocol_version(version: &u32) -> bool {
    *version == SUPPORTED_PLUGIN_PROTOCOL_VERSION
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginEngines {
    #[serde(default)]
    pub dbx: String,
    #[serde(default)]
    pub host_api: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginEntrypoints {
    #[serde(default)]
    pub backend: Option<PluginBackendEntrypoint>,
    #[serde(default)]
    pub ui: Option<PluginUiEntrypoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginBackendEntrypoint {
    #[serde(
        default = "default_backend_protocol_versions",
        skip_serializing_if = "is_default_backend_protocol_versions"
    )]
    pub protocol_versions: Vec<u32>,
    #[serde(default, skip_serializing_if = "is_default_backend_transport")]
    pub transport: PluginBackendTransport,
    pub executable: String,
}

fn default_backend_protocol_versions() -> Vec<u32> {
    vec![SUPPORTED_PLUGIN_PROTOCOL_VERSION]
}

fn is_default_backend_protocol_versions(versions: &Vec<u32>) -> bool {
    versions.as_slice() == [SUPPORTED_PLUGIN_PROTOCOL_VERSION]
}

fn is_default_backend_transport(transport: &PluginBackendTransport) -> bool {
    *transport == PluginBackendTransport::StdioJsonLines
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum PluginBackendTransport {
    #[default]
    #[serde(rename = "stdio-jsonl")]
    StdioJsonLines,
    #[serde(rename = "stdio-framed")]
    StdioFramed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginUiEntrypoint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    pub entry: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginDriverManifest {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(default)]
    pub database_type: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginManifestLocalization {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub contributions: BTreeMap<String, PluginContributionLocalization>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginContributionLocalization {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, PluginFormFieldLocalization>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub actions: BTreeMap<String, PluginConnectionActionLocalization>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginConnectionActionLocalization {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginFormFieldLocalization {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub options: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PluginContribution {
    ConnectionProvider(PluginConnectionProviderContribution),
    Workbench(PluginWorkbenchContribution),
    FilesystemProvider(PluginFilesystemProviderContribution),
}

impl PluginContribution {
    pub fn id(&self) -> &str {
        match self {
            Self::ConnectionProvider(contribution) => &contribution.id,
            Self::Workbench(contribution) => &contribution.id,
            Self::FilesystemProvider(contribution) => &contribution.id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginFormFieldDefinition {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: PluginFormFieldType,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<PluginFormFieldOption>,
    #[serde(default)]
    pub binding: Option<PluginFormFieldBinding>,
    #[serde(default)]
    pub visible_when: Option<PluginFormFieldCondition>,
    #[serde(default)]
    pub required_when: Option<PluginFormFieldCondition>,
}

impl PluginFormFieldDefinition {
    pub fn effective_binding(&self) -> PluginFormFieldBinding {
        self.binding.unwrap_or(if self.field_type == PluginFormFieldType::Password {
            PluginFormFieldBinding::Secret
        } else {
            PluginFormFieldBinding::Config
        })
    }

    pub fn is_visible(&self, values: &BTreeMap<String, serde_json::Value>) -> bool {
        self.visible_when.as_ref().is_none_or(|condition| condition.matches(values))
    }

    pub fn is_required(&self, values: &BTreeMap<String, serde_json::Value>) -> bool {
        self.required || self.required_when.as_ref().is_some_and(|condition| condition.matches(values))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginFormFieldCondition {
    pub field: String,
    pub one_of: Vec<serde_json::Value>,
}

impl PluginFormFieldCondition {
    pub fn matches(&self, values: &BTreeMap<String, serde_json::Value>) -> bool {
        values.get(&self.field).is_some_and(|value| self.one_of.contains(value))
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginFormFieldType {
    Text,
    Path,
    Password,
    Number,
    Boolean,
    Select,
    Textarea,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginFormFieldBinding {
    Config,
    Secret,
    Name,
    Host,
    Port,
    Username,
    Password,
    Database,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginFormFieldOption {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginConnectionProviderContribution {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    pub database_type: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub fields: Vec<PluginFormFieldDefinition>,
    #[serde(default)]
    pub workbench: Option<String>,
    #[serde(default)]
    pub filesystem_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<PluginConnectionCapability>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<PluginConnectionActionContribution>,
}

impl PluginConnectionProviderContribution {
    pub fn has_capability(&self, capability: PluginConnectionCapability) -> bool {
        self.capabilities.contains(&capability)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum PluginConnectionCapability {
    Test,
    Connect,
    Disconnect,
    MultipleWorkbenches,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginConnectionActionContribution {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub variant: Option<PluginConnectionActionVariant>,
    #[serde(default)]
    pub when: Option<PluginConnectionActionWhen>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub close_on_success: bool,
    #[serde(default = "default_action_requires_valid_form", skip_serializing_if = "is_true")]
    pub requires_valid_form: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

fn default_action_requires_valid_form() -> bool {
    true
}

fn is_true(value: &bool) -> bool {
    *value
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginConnectionActionVariant {
    Default,
    Outline,
    Secondary,
    Destructive,
    Ghost,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginConnectionActionWhen {
    Always,
    Create,
    Edit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginWorkbenchContribution {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginFilesystemProviderContribution {
    pub id: String,
    pub label: String,
    pub schemes: Vec<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<PluginFilesystemCapability>,
    #[serde(default)]
    pub root_uri: Option<String>,
}

impl PluginFilesystemProviderContribution {
    pub fn has_capability(&self, capability: PluginFilesystemCapability) -> bool {
        self.capabilities.contains(&capability)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum PluginFilesystemCapability {
    Read,
    Write,
    Delete,
    Rename,
    Mkdir,
}

impl PluginFilesystemCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Delete => "delete",
            Self::Rename => "rename",
            Self::Mkdir => "mkdir",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginCompatibility {
    pub compatible: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_executable: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_entry: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_root: Option<PathBuf>,
}

impl PluginManifest {
    pub fn is_legacy(&self) -> bool {
        self.manifest_version == 0
    }

    pub fn backend_entrypoint(&self) -> Option<PluginBackendEntrypoint> {
        if let Some(backend) = &self.entrypoints.backend {
            return Some(backend.clone());
        }
        self.executable.as_ref().map(|executable| PluginBackendEntrypoint {
            protocol_versions: vec![self.protocol_version],
            transport: PluginBackendTransport::StdioJsonLines,
            executable: executable.clone(),
        })
    }

    pub fn connection_provider(
        &self,
        provider_id: &str,
    ) -> Result<Option<PluginConnectionProviderContribution>, String> {
        Ok(self.contributions.iter().find_map(|contribution| match contribution {
            PluginContribution::ConnectionProvider(provider) if provider.id == provider_id => Some(provider.clone()),
            _ => None,
        }))
    }

    pub fn filesystem_provider(
        &self,
        provider_id: &str,
    ) -> Result<Option<PluginFilesystemProviderContribution>, String> {
        Ok(self.contributions.iter().find_map(|contribution| match contribution {
            PluginContribution::FilesystemProvider(provider) if provider.id == provider_id => Some(provider.clone()),
            _ => None,
        }))
    }

    pub fn compatibility(&self, plugin_dir: &Path, dbx_version: &str) -> PluginCompatibility {
        let mut errors = Vec::new();
        let mut warnings = Vec::new();

        if self.manifest_version > SUPPORTED_PLUGIN_MANIFEST_VERSION {
            errors.push(format!(
                "Plugin manifest version {} is newer than the supported version {}",
                self.manifest_version, SUPPORTED_PLUGIN_MANIFEST_VERSION
            ));
        }
        if self.manifest_version == 0 {
            warnings.push("Legacy plugin manifest v0 is supported for migration only".to_string());
        } else if !self.unknown_fields.is_empty() {
            errors.push(format!(
                "Plugin manifest contains unknown top-level field(s): {}",
                self.unknown_fields.keys().cloned().collect::<Vec<_>>().join(", ")
            ));
        }
        if !valid_identifier(&self.id) {
            errors.push("Plugin id must contain only lowercase letters, digits, '.', '-' or '_'".to_string());
        }
        if self.name.trim().is_empty() {
            errors.push("Plugin name cannot be empty".to_string());
        }
        if self.manifest_version > 0 {
            if self.executable.is_some() || !self.drivers.is_empty() {
                errors.push(
                    "Manifest v1 cannot use legacy executable or drivers fields; use entrypoints and contributions"
                        .to_string(),
                );
            }
            if self.protocol_version != SUPPORTED_PLUGIN_PROTOCOL_VERSION {
                errors.push("Manifest v1 cannot override the legacy protocol_version field".to_string());
            }
            if Version::parse(self.version.trim()).is_err() {
                errors.push("Plugin version must be valid semantic versioning".to_string());
            }
            if self.publisher.trim().is_empty() {
                errors.push("Manifest v1 plugins must declare a publisher".to_string());
            }
            validate_engine_requirement("DBX", &self.engines.dbx, dbx_version, &mut errors);
            if self.engines.host_api.trim().is_empty() {
                errors.push("Manifest v1 plugins must declare engines.host_api".to_string());
            } else {
                validate_engine_requirement(
                    "DBX Host API",
                    &self.engines.host_api,
                    SUPPORTED_PLUGIN_HOST_API_VERSION,
                    &mut errors,
                );
            }
        }

        let mut seen_permissions = HashSet::new();
        for permission in &self.permissions {
            if !SUPPORTED_PLUGIN_PERMISSIONS.contains(&permission.as_str()) {
                errors.push(format!("Unsupported plugin Host API permission '{permission}'"));
            } else if !seen_permissions.insert(permission) {
                errors.push(format!("Duplicate plugin permission '{permission}'"));
            }
        }
        validate_localizations(&self.localizations, &mut errors);
        validate_declared_icon(plugin_dir, "Plugin icon", self.icon.as_deref(), &mut errors);
        validate_contributions(
            &self.contributions,
            self.backend_entrypoint().is_some(),
            self.entrypoints.ui.is_some(),
            plugin_dir,
            &mut errors,
        );

        let target = current_plugin_target();
        let backend_executable = self.backend_entrypoint().and_then(|backend| {
            if !backend.protocol_versions.contains(&SUPPORTED_PLUGIN_PROTOCOL_VERSION) {
                errors.push(format!(
                    "Plugin backend does not support protocol version {}",
                    SUPPORTED_PLUGIN_PROTOCOL_VERSION
                ));
            }
            match resolve_safe_plugin_path(plugin_dir, &backend.executable) {
                Ok(path) => {
                    let path = resolve_existing_backend_path(path);
                    if !path.is_file() {
                        errors.push(format!("Plugin backend executable does not exist: {}", path.display()));
                    }
                    Some(path)
                }
                Err(error) => {
                    errors.push(error);
                    None
                }
            }
        });

        let mut ui_root = None;
        let ui_entry = self.entrypoints.ui.as_ref().and_then(|ui| {
            let root_relative = ui.root.clone().unwrap_or_else(|| {
                Path::new(&ui.entry)
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                    .map(|parent| parent.to_string_lossy().into_owned())
                    .unwrap_or_else(|| ".".to_string())
            });
            match resolve_safe_plugin_path(plugin_dir, &root_relative) {
                Ok(path) if path.is_dir() => ui_root = Some(path),
                Ok(path) => errors.push(format!("Plugin UI root does not exist: {}", path.display())),
                Err(error) => errors.push(error),
            }
            match resolve_safe_plugin_path(plugin_dir, &ui.entry) {
                Ok(path) => {
                    if !path.is_file() {
                        errors.push(format!("Plugin UI entry does not exist: {}", path.display()));
                    }
                    if ui_root.as_ref().is_some_and(|root| !path.starts_with(root)) {
                        errors.push("Plugin UI entry must be contained by its UI root".to_string());
                    }
                    Some(path)
                }
                Err(error) => {
                    errors.push(error);
                    None
                }
            }
        });

        PluginCompatibility {
            compatible: errors.is_empty(),
            errors,
            warnings,
            target: Some(target),
            backend_executable,
            ui_entry,
            ui_root,
        }
    }
}

fn validate_localizations(localizations: &BTreeMap<String, PluginManifestLocalization>, errors: &mut Vec<String>) {
    for (locale, localization) in localizations {
        if !valid_locale_tag(locale) {
            errors.push(format!("Invalid plugin localization locale '{locale}'"));
        }
        if localization.name.as_ref().is_some_and(|value| value.trim().is_empty()) {
            errors.push(format!("Plugin localization '{locale}' has an empty name"));
        }
        for (contribution_id, contribution) in &localization.contributions {
            if !valid_identifier(contribution_id)
                || contribution.label.as_ref().is_some_and(|value| value.trim().is_empty())
            {
                errors.push(format!(
                    "Plugin localization '{locale}' has an invalid contribution entry '{contribution_id}'"
                ));
            }
            for (field_key, field) in &contribution.fields {
                if !valid_identifier(field_key)
                    || field.label.as_ref().is_some_and(|value| value.trim().is_empty())
                    || field.options.values().any(|value| value.trim().is_empty())
                {
                    errors.push(format!(
                        "Plugin localization '{locale}' has an invalid field entry '{contribution_id}/{field_key}'"
                    ));
                }
            }
            for (action_id, action) in &contribution.actions {
                if !valid_identifier(action_id) || action.label.as_ref().is_some_and(|value| value.trim().is_empty()) {
                    errors.push(format!(
                        "Plugin localization '{locale}' has an invalid action entry '{contribution_id}/{action_id}'"
                    ));
                }
            }
        }
    }
}

fn resolve_existing_backend_path(path: PathBuf) -> PathBuf {
    if path.is_file() {
        return path;
    }
    #[cfg(windows)]
    if path.extension().is_none() {
        let batch_path = path.with_extension("bat");
        if batch_path.is_file() {
            return batch_path;
        }
    }
    path
}

pub fn current_plugin_target() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

pub fn resolve_safe_plugin_path(plugin_dir: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative_path);
    if relative_path.as_os_str().is_empty() || relative_path.is_absolute() {
        return Err("Plugin entrypoint path must be a non-empty relative path".to_string());
    }
    if relative_path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err(format!("Plugin entrypoint escapes its package: {}", relative_path.display()));
    }
    Ok(plugin_dir.join(relative_path))
}

fn validate_engine_requirement(label: &str, requirement: &str, actual: &str, errors: &mut Vec<String>) {
    if requirement.trim().is_empty() {
        return;
    }
    let requirement = match VersionReq::parse(requirement.trim()) {
        Ok(requirement) => requirement,
        Err(error) => {
            errors.push(format!("Invalid {label} version requirement '{requirement}': {error}"));
            return;
        }
    };
    let actual = match Version::parse(actual.trim()) {
        Ok(actual) => actual,
        Err(error) => {
            errors.push(format!("Invalid installed {label} version '{actual}': {error}"));
            return;
        }
    };
    if !requirement.matches(&actual) {
        errors.push(format!("Plugin requires {label} {requirement}, but {actual} is installed"));
    }
}

fn validate_contributions(
    contributions: &[PluginContribution],
    has_backend: bool,
    has_ui: bool,
    plugin_dir: &Path,
    errors: &mut Vec<String>,
) {
    let mut seen_ids = HashSet::new();
    let mut provider_ids = HashSet::new();
    let mut workbench_ids = HashSet::new();
    let mut filesystem_provider_ids = HashSet::new();
    let mut workbench_references = Vec::new();
    let mut filesystem_references = Vec::new();

    for (index, contribution) in contributions.iter().enumerate() {
        let id = contribution.id();
        if !valid_identifier(id) {
            errors.push(format!("Contribution at index {index} has an invalid id"));
        } else if !seen_ids.insert(id) {
            errors.push(format!("Duplicate plugin contribution id '{id}'"));
        }

        match contribution {
            PluginContribution::ConnectionProvider(provider) => {
                validate_optional_text(provider.label.as_deref(), &format!("Connection provider '{id}' label"), errors);
                validate_declared_icon(
                    plugin_dir,
                    &format!("Connection provider '{id}' icon"),
                    provider.icon.as_deref(),
                    errors,
                );
                if !valid_identifier(&provider.database_type) {
                    errors.push(format!("Connection provider '{id}' has an invalid database_type"));
                }
                if valid_identifier(id) {
                    provider_ids.insert(id.to_string());
                }
                validate_form_fields(&provider.fields, index, errors);
                validate_optional_reference(provider.workbench.as_deref(), "workbench", id, errors);
                validate_optional_reference(provider.filesystem_provider.as_deref(), "filesystem provider", id, errors);
                if let Some(workbench) = &provider.workbench {
                    workbench_references.push((id.to_string(), workbench.clone()));
                }
                if let Some(filesystem_provider) = &provider.filesystem_provider {
                    filesystem_references.push((id.to_string(), filesystem_provider.clone()));
                }
                let mut seen_capabilities = HashSet::new();
                for capability in &provider.capabilities {
                    if !seen_capabilities.insert(*capability) {
                        errors.push(format!("Connection provider '{id}' has duplicate capabilities"));
                    }
                }
                if provider.has_capability(PluginConnectionCapability::Disconnect)
                    && !provider.has_capability(PluginConnectionCapability::Connect)
                {
                    errors.push(format!("Connection provider '{id}' cannot declare disconnect without connect"));
                }
                if (!provider.capabilities.is_empty() || !provider.actions.is_empty()) && !has_backend {
                    errors.push(format!("Connection provider '{id}' declares backend operations without a backend"));
                }
                validate_connection_actions(&provider.actions, id, errors);
            }
            PluginContribution::Workbench(workbench) => {
                validate_required_text(&workbench.label, &format!("Workbench '{id}' label"), errors);
                validate_declared_icon(
                    plugin_dir,
                    &format!("Workbench '{id}' icon"),
                    workbench.icon.as_deref(),
                    errors,
                );
                if valid_identifier(id) {
                    workbench_ids.insert(id.to_string());
                }
                if !has_ui {
                    errors.push(format!("Workbench contribution '{id}' requires a UI entrypoint"));
                }
            }
            PluginContribution::FilesystemProvider(provider) => {
                validate_required_text(&provider.label, &format!("Filesystem provider '{id}' label"), errors);
                if valid_identifier(id) {
                    filesystem_provider_ids.insert(id.to_string());
                }
                if provider.schemes.is_empty() {
                    errors.push(format!("Filesystem provider '{id}' must declare at least one scheme"));
                }
                let mut seen_schemes = HashSet::new();
                for scheme in &provider.schemes {
                    if !valid_capability_name(scheme) {
                        errors.push(format!("Filesystem provider '{id}' has an invalid scheme '{scheme}'"));
                    } else if !seen_schemes.insert(scheme) {
                        errors.push(format!("Filesystem provider '{id}' has duplicate scheme '{scheme}'"));
                    }
                }
                let mut seen_capabilities = HashSet::new();
                for capability in &provider.capabilities {
                    if !seen_capabilities.insert(*capability) {
                        errors.push(format!("Filesystem provider '{id}' has duplicate capabilities"));
                    }
                }
                if let Some(root_uri) = &provider.root_uri {
                    let root_uri = root_uri.trim();
                    let scheme = root_uri.split_once(':').map(|(scheme, _)| scheme).unwrap_or_default();
                    if root_uri.is_empty()
                        || root_uri.len() > 4_096
                        || root_uri.chars().any(char::is_whitespace)
                        || !provider.schemes.iter().any(|declared| declared == scheme)
                    {
                        errors.push(format!("Filesystem provider '{id}' has an invalid root_uri"));
                    }
                }
                if !has_backend {
                    errors.push(format!("Filesystem provider '{id}' requires a backend entrypoint"));
                }
            }
        }
    }

    for (provider, workbench) in workbench_references {
        if !workbench_ids.contains(&workbench) {
            errors.push(format!("Connection provider '{provider}' references missing workbench '{workbench}'"));
        }
    }
    for (provider, filesystem_provider) in filesystem_references {
        if !filesystem_provider_ids.contains(&filesystem_provider) {
            errors.push(format!(
                "Connection provider '{provider}' references missing filesystem provider '{filesystem_provider}'"
            ));
        }
    }
}

fn validate_connection_actions(
    actions: &[PluginConnectionActionContribution],
    provider_id: &str,
    errors: &mut Vec<String>,
) {
    let mut seen_ids = HashSet::new();
    for action in actions {
        if !valid_identifier(&action.id) || !seen_ids.insert(&action.id) {
            errors.push(format!(
                "Connection provider '{provider_id}' action '{}' has an invalid or duplicate id",
                action.id
            ));
        }
        validate_required_text(
            &action.label,
            &format!("Connection provider '{provider_id}' action '{}' label", action.id),
            errors,
        );
        if action.timeout_ms.is_some_and(|timeout| !(1..=120_000).contains(&timeout)) {
            errors.push(format!(
                "Connection provider '{provider_id}' action '{}' timeout_ms must be between 1 and 120000",
                action.id
            ));
        }
    }
}

fn validate_form_fields(fields: &[PluginFormFieldDefinition], contribution_index: usize, errors: &mut Vec<String>) {
    let mut seen_keys = HashSet::new();
    let declared_keys = fields.iter().map(|field| field.key.as_str()).collect::<HashSet<_>>();
    for (field_index, field) in fields.iter().enumerate() {
        if !valid_identifier(&field.key) || !seen_keys.insert(&field.key) {
            errors.push(format!(
                "Contribution at index {contribution_index} field {field_index} has an invalid or duplicate key"
            ));
        }
        validate_required_text(
            &field.label,
            &format!("Contribution at index {contribution_index} field {field_index} label"),
            errors,
        );

        if field.field_type == PluginFormFieldType::Select {
            if field.options.is_empty() {
                errors.push(format!(
                    "Contribution at index {contribution_index} field {field_index} select options cannot be empty"
                ));
            }
            let mut seen_values = HashSet::new();
            for option in &field.options {
                if option.label.trim().is_empty() || !seen_values.insert(&option.value) {
                    errors.push(format!(
                        "Contribution at index {contribution_index} field {field_index} has invalid or duplicate select options"
                    ));
                }
            }
        } else if !field.options.is_empty() {
            errors.push(format!(
                "Contribution at index {contribution_index} field {field_index} only supports options for select fields"
            ));
        }

        if field.binding == Some(PluginFormFieldBinding::Port) && field.field_type != PluginFormFieldType::Number {
            errors.push(format!(
                "Contribution at index {contribution_index} field {field_index} port binding requires number type"
            ));
        }
        if matches!(
            field.binding,
            Some(
                PluginFormFieldBinding::Secret
                    | PluginFormFieldBinding::Name
                    | PluginFormFieldBinding::Host
                    | PluginFormFieldBinding::Username
                    | PluginFormFieldBinding::Password
                    | PluginFormFieldBinding::Database
            )
        ) && !matches!(
            field.field_type,
            PluginFormFieldType::Text
                | PluginFormFieldType::Path
                | PluginFormFieldType::Password
                | PluginFormFieldType::Select
                | PluginFormFieldType::Textarea
        ) {
            errors.push(format!(
                "Contribution at index {contribution_index} field {field_index} string binding requires a string field type"
            ));
        }

        if let Some(default) = &field.default {
            let valid = match field.field_type {
                PluginFormFieldType::Text
                | PluginFormFieldType::Path
                | PluginFormFieldType::Password
                | PluginFormFieldType::Select
                | PluginFormFieldType::Textarea => default.is_string(),
                PluginFormFieldType::Number => default.is_number(),
                PluginFormFieldType::Boolean => default.is_boolean(),
            };
            if !valid {
                errors.push(format!(
                    "Contribution at index {contribution_index} field {field_index} has an invalid default value"
                ));
            }
            if field.field_type == PluginFormFieldType::Select
                && default.as_str().is_some_and(|default| !field.options.iter().any(|option| option.value == default))
            {
                errors.push(format!(
                    "Contribution at index {contribution_index} field {field_index} select default is not declared in options"
                ));
            }
        }
        validate_form_field_condition(
            field.visible_when.as_ref(),
            "visible_when",
            &declared_keys,
            contribution_index,
            field_index,
            errors,
        );
        validate_form_field_condition(
            field.required_when.as_ref(),
            "required_when",
            &declared_keys,
            contribution_index,
            field_index,
            errors,
        );
    }
}

fn validate_form_field_condition(
    condition: Option<&PluginFormFieldCondition>,
    label: &str,
    declared_keys: &HashSet<&str>,
    contribution_index: usize,
    field_index: usize,
    errors: &mut Vec<String>,
) {
    let Some(condition) = condition else {
        return;
    };
    if !declared_keys.contains(condition.field.as_str()) {
        errors.push(format!(
            "Contribution at index {contribution_index} field {field_index} {label} references an unknown field"
        ));
    }
    if condition.one_of.is_empty()
        || condition.one_of.iter().any(|value| !(value.is_string() || value.is_number() || value.is_boolean()))
    {
        errors.push(format!(
            "Contribution at index {contribution_index} field {field_index} {label} must contain scalar one_of values"
        ));
    }
}

fn validate_optional_reference(value: Option<&str>, label: &str, contribution_id: &str, errors: &mut Vec<String>) {
    if value.is_some_and(|value| !valid_identifier(value)) {
        errors.push(format!("Connection provider '{contribution_id}' has an invalid {label} reference"));
    }
}

fn validate_required_text(value: &str, label: &str, errors: &mut Vec<String>) {
    if value.trim().is_empty() {
        errors.push(format!("{label} cannot be empty"));
    }
}

fn validate_optional_text(value: Option<&str>, label: &str, errors: &mut Vec<String>) {
    if value.is_some_and(|value| value.trim().is_empty()) {
        errors.push(format!("{label} cannot be empty when present"));
    }
}

fn validate_declared_icon(plugin_dir: &Path, label: &str, icon: Option<&str>, errors: &mut Vec<String>) {
    let Some(icon) = icon else {
        return;
    };
    if icon.trim().is_empty() {
        errors.push(format!("{label} must be a non-empty relative path"));
        return;
    }
    match resolve_safe_plugin_path(plugin_dir, icon) {
        Ok(path) if !path.is_file() => errors.push(format!("{label} does not exist: {}", path.display())),
        Ok(path) if !supported_icon_path(&path) => {
            errors.push(format!("{label} must use svg, png, jpg, jpeg, gif, webp, or ico: {}", path.display()))
        }
        Ok(_) => {}
        Err(error) => errors.push(format!("{label} is invalid: {error}")),
    }
}

fn supported_icon_path(path: &Path) -> bool {
    path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| {
        matches!(extension.to_ascii_lowercase().as_str(), "svg" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "ico")
    })
}

fn valid_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut chars = value.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '.' | '-' | '_')
        })
}

fn valid_capability_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '.' | '-' | ':' | '_')
        })
}

fn valid_locale_tag(value: &str) -> bool {
    let mut parts = value.split('-');
    let Some(language) = parts.next() else {
        return false;
    };
    (2..=3).contains(&language.len())
        && language.chars().all(|character| character.is_ascii_alphabetic())
        && parts.all(|part| {
            (2..=8).contains(&part.len()) && part.chars().all(|character| character.is_ascii_alphanumeric())
        })
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_safe_plugin_path, validate_connection_actions, PluginConnectionActionContribution,
        PluginConnectionProviderContribution, PluginFormFieldBinding, PluginManifest,
    };

    #[test]
    fn validates_manifest_v1_and_resolves_package_executable() {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("bin").join("example");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"example").unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.example",
            "name": "Example",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "entrypoints": {
                "backend": { "executable": "bin/example" }
            },
            "permissions": ["host.events", "host.fileTransfer"]
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.5.67");

        assert!(compatibility.compatible, "{:?}", compatibility.errors);
        assert_eq!(compatibility.backend_executable.as_deref(), Some(executable.as_path()));
    }

    #[test]
    fn validates_localized_plugin_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.localized",
            "name": "Localized",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "localizations": {
                "zh-CN": {
                    "name": "本地化插件",
                    "contributions": {
                        "localized.connection": {
                            "label": "本地化连接",
                            "fields": { "host": { "label": "主机" } }
                        }
                    }
                }
            }
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.5.68");

        assert!(compatibility.compatible, "{:?}", compatibility.errors);
        assert_eq!(manifest.localizations["zh-CN"].name.as_deref(), Some("本地化插件"));
    }

    #[test]
    fn rejects_invalid_localization_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.localized",
            "name": "Localized",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "localizations": { "invalid_locale": { "name": "" } }
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.5.68");

        assert!(compatibility.errors.iter().any(|error| error.contains("Invalid plugin localization locale")));
        assert!(compatibility.errors.iter().any(|error| error.contains("empty name")));
    }

    #[test]
    fn rejects_entrypoint_path_traversal() {
        let error = resolve_safe_plugin_path(std::path::Path::new("/plugins/example"), "../other/bin").unwrap_err();
        assert!(error.contains("escapes"));
    }

    #[test]
    fn accepts_declared_plugin_and_provider_icons_with_optional_provider_label() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("assets/plugin.svg"), "<svg/>").unwrap();
        std::fs::write(dir.path().join("assets/provider.png"), b"png").unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.icons",
            "name": "Icons",
            "icon": "assets/plugin.svg",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "contributions": [{
                "type": "connection-provider",
                "id": "icons.connection",
                "icon": "assets/provider.png",
                "database_type": "icons",
                "fields": []
            }]
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.5.68");
        let provider = manifest.connection_provider("icons.connection").unwrap().unwrap();

        assert!(compatibility.compatible, "{:?}", compatibility.errors);
        assert_eq!(provider.label, None);
        assert_eq!(provider.icon.as_deref(), Some("assets/provider.png"));
    }

    #[test]
    fn rejects_unsafe_or_missing_declared_icons() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.icons",
            "name": "Icons",
            "icon": "../outside.svg",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "contributions": [{
                "type": "connection-provider",
                "id": "icons.connection",
                "icon": "assets/missing.svg",
                "database_type": "icons",
                "fields": []
            }]
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.5.68");

        assert!(compatibility.errors.iter().any(|error| error.contains("Plugin icon is invalid")));
        assert!(compatibility
            .errors
            .iter()
            .any(|error| error.contains("Connection provider 'icons.connection' icon does not exist")));
    }

    #[test]
    fn rejects_obsolete_ui_kind_declaration() {
        let ui_error = serde_json::from_value::<PluginManifest>(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.host-ui",
            "name": "Host UI",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "entrypoints": { "ui": { "kind": "sandbox-webview", "root": "ui", "entry": "ui/index.html" } }
        }))
        .unwrap_err();
        let backend_error = serde_json::from_value::<PluginManifest>(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.backend-protocol",
            "name": "Backend protocol",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "entrypoints": { "backend": { "protocol": "dbx-jsonrpc", "executable": "bin/plugin" } }
        }))
        .unwrap_err();

        assert!(ui_error.to_string().contains("unknown field `kind`"));
        assert!(backend_error.to_string().contains("unknown field `protocol`"));
    }

    #[test]
    fn rejects_unknown_v1_top_level_fields_without_breaking_legacy_manifests() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.unknown-field",
            "name": "Unknown field",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "activation_events": ["onStartup"]
        }))
        .unwrap();
        let compatibility = manifest.compatibility(dir.path(), "0.5.68");

        assert!(compatibility
            .errors
            .iter()
            .any(|error| error.contains("unknown top-level field(s): activation_events")));

        let legacy: PluginManifest = serde_json::from_value(serde_json::json!({
            "id": "jdbc",
            "name": "JDBC",
            "protocol_version": 1,
            "legacy_metadata": true
        }))
        .unwrap();
        assert!(legacy.compatibility(dir.path(), "0.5.68").errors.iter().all(|error| !error.contains("unknown")));
    }

    #[test]
    fn rejects_legacy_runtime_declarations_in_manifest_v1() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.mixed-contract",
            "name": "Mixed contract",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "protocol_version": 2,
            "executable": "bin/legacy",
            "drivers": [{ "id": "legacy", "label": "Legacy", "kind": "external" }]
        }))
        .unwrap();
        let compatibility = manifest.compatibility(dir.path(), "0.5.68");

        assert!(compatibility
            .errors
            .iter()
            .any(|error| error.contains("cannot use legacy executable or drivers fields")));
        assert!(compatibility
            .errors
            .iter()
            .any(|error| error.contains("cannot override the legacy protocol_version field")));
    }

    #[test]
    fn legacy_manifest_remains_readable() {
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "id": "jdbc",
            "name": "JDBC",
            "protocol_version": 1,
            "executable": "bin/dbx-jdbc-plugin",
            "drivers": []
        }))
        .unwrap();

        assert!(manifest.is_legacy());
        assert_eq!(manifest.backend_entrypoint().unwrap().executable, "bin/dbx-jdbc-plugin");
    }

    #[test]
    fn accepts_supported_connection_field_bindings() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.connection-bindings",
            "name": "Connection bindings",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "contributions": [{
                "type": "connection-provider",
                "id": "bindings.connection",
                "label": "Bindings",
                "database_type": "bindings",
                "fields": [
                    { "key": "display_name", "label": "Name", "type": "text", "binding": "name" },
                    { "key": "host", "label": "Host", "type": "text", "binding": "host" },
                    { "key": "port", "label": "Port", "type": "number", "binding": "port" },
                    { "key": "username", "label": "Username", "type": "text", "binding": "username" },
                    { "key": "password", "label": "Password", "type": "password", "binding": "password" },
                    { "key": "database", "label": "Database", "type": "text", "binding": "database" },
                    { "key": "mode", "label": "Mode", "type": "text", "binding": "config" },
                    { "key": "token", "label": "Token", "type": "password", "binding": "secret" }
                ]
            }]
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.5.67");

        assert!(compatibility.compatible, "{:?}", compatibility.errors);
        let provider = manifest.connection_provider("bindings.connection").unwrap().unwrap();
        assert_eq!(provider.fields.last().unwrap().effective_binding(), PluginFormFieldBinding::Secret);
    }

    #[test]
    fn accepts_path_fields_conditions_and_multiple_workbenches() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.ssh",
            "name": "SSH",
            "version": "0.2.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.1" },
            "permissions": ["host.clipboard"],
            "contributions": [{
                "type": "connection-provider",
                "id": "ssh.connection",
                "label": "SSH",
                "database_type": "ssh",
                "capabilities": ["multiple-workbenches"],
                "fields": [
                    {
                        "key": "authentication",
                        "label": "Authentication",
                        "type": "select",
                        "default": "password",
                        "options": [
                            { "label": "Password", "value": "password" },
                            { "label": "Private key", "value": "private-key" }
                        ]
                    },
                    {
                        "key": "private_key_path",
                        "label": "Private key",
                        "type": "path",
                        "visible_when": { "field": "authentication", "one_of": ["private-key"] },
                        "required_when": { "field": "authentication", "one_of": ["private-key"] }
                    }
                ]
            }]
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.5.77");

        assert!(compatibility.compatible, "{:?}", compatibility.errors);
    }

    #[test]
    fn rejects_invalid_connection_field_conditions() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.invalid-conditions",
            "name": "Invalid conditions",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.1" },
            "contributions": [{
                "type": "connection-provider",
                "id": "invalid.connection",
                "label": "Invalid",
                "database_type": "invalid",
                "fields": [{
                    "key": "private_key_path",
                    "label": "Private key",
                    "type": "path",
                    "visible_when": { "field": "missing", "one_of": [] }
                }]
            }]
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.5.77");

        assert!(compatibility.errors.iter().any(|error| error.contains("references an unknown field")));
        assert!(compatibility.errors.iter().any(|error| error.contains("must contain scalar one_of values")));
    }

    #[test]
    fn rejects_unknown_connection_field_binding() {
        let error = serde_json::from_value::<PluginManifest>(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.invalid-binding",
            "name": "Invalid binding",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "contributions": [{
                "type": "connection-provider",
                "id": "invalid.connection",
                "label": "Invalid",
                "database_type": "invalid",
                "fields": [{ "key": "token", "label": "Token", "type": "password", "binding": "environment" }]
            }]
        }))
        .unwrap_err();

        assert!(error.to_string().contains("unknown variant `environment`"));
    }

    #[test]
    fn rejects_incompatible_field_defaults_and_missing_provider_references() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.invalid-contract",
            "name": "Invalid contract",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "contributions": [
                {
                    "type": "connection-provider",
                    "id": "invalid.connection",
                    "label": "Invalid",
                    "database_type": "invalid type",
                    "fields": [{ "key": "port", "label": "Port", "type": "text", "binding": "port", "default": true }],
                    "workbench": "missing.main"
                }
            ]
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.5.67");

        assert!(compatibility.errors.iter().any(|error| error.contains("invalid database_type")));
        assert!(compatibility.errors.iter().any(|error| error.contains("port binding requires number type")));
        assert!(compatibility.errors.iter().any(|error| error.contains("invalid default value")));
        assert!(compatibility.errors.iter().any(|error| error.contains("missing workbench")));
    }

    #[test]
    fn validates_connection_bound_filesystem_provider_contract() {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("plugin");
        std::fs::write(&executable, "binary").unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.files",
            "name": "Files",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "entrypoints": { "backend": { "executable": "plugin" } },
            "contributions": [
                {
                    "type": "connection-provider",
                    "id": "files.connection",
                    "label": "Files",
                    "database_type": "files",
                    "fields": [],
                    "filesystem_provider": "files.provider"
                },
                {
                    "type": "filesystem-provider",
                    "id": "files.provider",
                    "label": "Files",
                    "schemes": ["files"],
                    "root_uri": "files:/",
                    "capabilities": ["read"]
                }
            ]
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.5.68");

        assert!(compatibility.compatible, "{:?}", compatibility.errors);
        assert_eq!(
            manifest.filesystem_provider("files.provider").unwrap().unwrap().root_uri.as_deref(),
            Some("files:/")
        );
        assert_eq!(
            manifest.connection_provider("files.connection").unwrap().unwrap().filesystem_provider.as_deref(),
            Some("files.provider")
        );
    }

    #[test]
    fn rejects_invalid_filesystem_root_and_missing_reference() {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("plugin");
        std::fs::write(&executable, "binary").unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.invalid-files",
            "name": "Invalid files",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "entrypoints": { "backend": { "executable": "plugin" } },
            "contributions": [
                {
                    "type": "connection-provider",
                    "id": "files.connection",
                    "label": "Files",
                    "database_type": "files",
                    "fields": [],
                    "filesystem_provider": "missing.provider"
                },
                {
                    "type": "filesystem-provider",
                    "id": "files.provider",
                    "label": "Files",
                    "schemes": ["files"],
                    "root_uri": "other:/",
                    "capabilities": ["read", "read"]
                }
            ]
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.5.68");

        assert!(compatibility.errors.iter().any(|error| error.contains("invalid root_uri")));
        assert!(compatibility.errors.iter().any(|error| error.contains("duplicate capabilities")));
        assert!(compatibility.errors.iter().any(|error| error.contains("missing filesystem provider")));
    }

    #[test]
    fn omits_empty_connection_actions_from_serialized_manifest() {
        let omitted: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "sample.connection",
            "label": "Sample",
            "database_type": "sample",
            "fields": []
        }))
        .unwrap();
        let empty: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "sample.connection",
            "label": "Sample",
            "database_type": "sample",
            "fields": [],
            "actions": []
        }))
        .unwrap();

        assert!(omitted.actions.is_empty());
        assert!(empty.actions.is_empty());
        assert!(serde_json::to_value(omitted).unwrap().get("actions").is_none());
        assert!(serde_json::to_value(empty).unwrap().get("actions").is_none());
    }

    #[test]
    fn validates_connection_action_contract() {
        let actions: Vec<PluginConnectionActionContribution> = serde_json::from_value(serde_json::json!([
            {
                "id": "discover",
                "label": "Discover",
                "variant": "outline",
                "when": "create",
                "requires_valid_form": false,
                "timeout_ms": 5000
            }
        ]))
        .unwrap();
        let mut errors = Vec::new();

        validate_connection_actions(&actions, "sample.connection", &mut errors);

        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn rejects_invalid_connection_action_contracts() {
        let malformed = serde_json::from_value::<PluginConnectionActionContribution>(serde_json::json!({
            "id": "legacy",
            "kind": "invoke",
            "label": "Legacy",
            "method": "sample/legacy"
        }))
        .unwrap_err();
        let actions: Vec<PluginConnectionActionContribution> = serde_json::from_value(serde_json::json!([
            { "id": "duplicate", "label": "" },
            { "id": "duplicate", "label": "Duplicate", "timeout_ms": 0 }
        ]))
        .unwrap();
        let mut errors = Vec::new();

        validate_connection_actions(&actions, "sample.connection", &mut errors);

        assert!(malformed.to_string().contains("unknown field `kind`"));
        assert!(errors.iter().any(|error| error.contains("label cannot be empty")));
        assert!(errors.iter().any(|error| error.contains("invalid or duplicate id")));
        assert!(errors.iter().any(|error| error.contains("timeout_ms must be between")));
    }
}
