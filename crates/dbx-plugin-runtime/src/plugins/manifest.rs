use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf};

use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};

pub const SUPPORTED_PLUGIN_MANIFEST_VERSION: u32 = 1;
/// Host API version the host advertises at `plugin/initialize`.
///
/// 1.1 adds the plugin-initiated `host/requestUserInput` method (see
/// `plugins/runtime.rs`). It is additive: 1.0 plugins keep working, and a
/// plugin that wants the capability must check the advertised version (or the
/// `host.requestUserInput` entry in `host.features`) before calling it.
pub const SUPPORTED_PLUGIN_HOST_API_VERSION: &str = "1.1.0";
/// Capabilities the host advertises to a plugin backend at `plugin/initialize`.
pub const SUPPORTED_PLUGIN_HOST_FEATURES: &[&str] = &["host.requestUserInput"];
pub const SUPPORTED_PLUGIN_PROTOCOL_VERSION: u32 = 1;
pub const PLUGIN_CONNECTION_TEST_METHOD: &str = "connection/test";
pub const PLUGIN_CONNECTION_CONNECT_METHOD: &str = "connection/connect";
pub const PLUGIN_CONNECTION_DISCONNECT_METHOD: &str = "connection/disconnect";
pub const PLUGIN_CONNECTION_ACTION_METHOD: &str = "connection/action";
pub const SUPPORTED_PLUGIN_PERMISSIONS: &[&str] = &["host.events", "host.binary", "host.workbench", "host.filesystem"];

/// Cap the number of `host.network:<origin>` entries so a manifest cannot bloat
/// the sandbox CSP or enumerate large origin lists.
pub const MAX_PLUGIN_NETWORK_ORIGINS: usize = 8;
/// Bound the `visible_when` / `required_when` expression tree so a hostile
/// manifest cannot make the host or the dialog evaluator do unbounded work.
pub const MAX_PLUGIN_FIELD_CONDITION_DEPTH: usize = 8;
pub const MAX_PLUGIN_FIELD_CONDITION_NODES: usize = 64;
/// Cap the file filters a picker may declare so one manifest cannot bloat the
/// native dialog or the browser `accept` attribute.
pub const MAX_PLUGIN_PICKER_FILTERS: usize = 16;
const HOST_NETWORK_PERMISSION_PREFIX: &str = "host.network:";

/// Parse a `host.network:https://host[:port]` permission into the origin that
/// may appear in the sandbox `connect-src`. Only https origins without path,
/// query, or fragment parts are accepted.
pub fn parse_host_network_permission(permission: &str) -> Option<&str> {
    let origin = permission.strip_prefix(HOST_NETWORK_PERMISSION_PREFIX)?;
    let rest = origin.strip_prefix("https://")?;
    if rest.is_empty() || rest.contains('/') || rest.contains('?') || rest.contains('#') {
        return None;
    }
    let host = rest.split(':').next().unwrap_or_default();
    if host.is_empty()
        || !host.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_'))
    {
        return None;
    }
    if let Some(port) = rest.rsplit(':').next() {
        if rest.contains(':') && (port.is_empty() || !port.chars().all(|character| character.is_ascii_digit())) {
            return None;
        }
    }
    Some(origin)
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<PluginBackendEntrypoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    ContextMenu(PluginContextMenuContribution),
    ResultView(PluginResultViewContribution),
}

impl PluginContribution {
    pub fn id(&self) -> &str {
        match self {
            Self::ConnectionProvider(contribution) => &contribution.id,
            Self::Workbench(contribution) => &contribution.id,
            Self::FilesystemProvider(contribution) => &contribution.id,
            Self::ContextMenu(contribution) => &contribution.id,
            Self::ResultView(contribution) => &contribution.id,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<PluginFormFieldOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<PluginFormFieldBinding>,
    /// Optional local-file action on a text/password/textarea field.
    ///
    /// Desktop (client-side) hosts open a native picker and store the chosen
    /// **absolute path** in this field. Browser hosts cannot read a client
    /// path, so the same action becomes an **upload**: the host reads the file
    /// and stores its content in `content_field` instead. Contract documented
    /// in `plugins/README.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picker: Option<PluginFormFieldPicker>,
    /// Plugin method returning `{ options: [{ value, label }] }`; the host
    /// connection form fetches it and renders the field as a dynamic select.
    /// Optional and forward/backward compatible: older hosts reject the
    /// manifest, hosts without UI support keep the declared type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options_action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_when: Option<PluginFieldCondition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_when: Option<PluginFieldCondition>,
}

/// A `visible_when` / `required_when` expression.
///
/// The legacy single-field form `{ "field": "mode", "one_of": ["custom"] }`
/// keeps its exact meaning. Composite forms (`all_of`, `any_of`, `not`) let a
/// manifest express combinations such as
/// `sudo_source = custom AND read_only = false`, which a single-field
/// condition cannot. Composite nodes nest arbitrarily; [`MAX_PLUGIN_FIELD_CONDITION_DEPTH`]
/// bounds the evaluation cost of a hostile manifest.
///
/// Semantics are shared with the frontend evaluator
/// (`apps/desktop/src/lib/plugins/pluginFieldConditions.ts`): a leaf matches
/// when the referenced sibling field holds a non-empty value that equals one of
/// the listed literals (compared by canonical string form, so the boolean
/// `false` matches both the literal `false` and the literal `"false"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum PluginFieldCondition {
    /// Legacy single-field clause: `{ "field": "...", "one_of": [...] }`.
    Field(PluginFieldConditionClause),
    /// Every nested condition must match.
    AllOf { all_of: Vec<PluginFieldCondition> },
    /// At least one nested condition must match.
    AnyOf { any_of: Vec<PluginFieldCondition> },
    /// Inverts the nested condition.
    Not { not: Box<PluginFieldCondition> },
}

/// The legacy single-field clause of a [`PluginFieldCondition`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginFieldConditionClause {
    pub field: String,
    pub one_of: Vec<PluginFieldConditionLiteral>,
}

/// A value a manifest may list in `one_of`. Plugins mostly compare strings,
/// but booleans and numbers are allowed so a condition can be written exactly
/// like the value the form produces (`"read_only": [false]` instead of
/// `["false"]`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PluginFieldConditionLiteral {
    String(String),
    Bool(bool),
    Number(serde_json::Number),
}

impl PluginFieldConditionLiteral {
    /// Canonical string form used for comparison. This is the rule the
    /// frontend has always applied (`String(value)`), so every manifest written
    /// against the string-only contract keeps matching.
    pub fn canonical(&self) -> String {
        match self {
            Self::String(value) => value.clone(),
            Self::Bool(value) => value.to_string(),
            // `serde_json::Number` prints `22.0` for a float that JavaScript
            // renders as `22`; normalize integral floats so the two sides agree.
            Self::Number(value) => normalize_condition_number(value),
        }
    }
}

fn normalize_condition_number(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    if let Some(value) = number.as_f64() {
        if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
            return format!("{}", value as i64);
        }
    }
    number.to_string()
}

impl PluginFieldCondition {
    /// Every sibling field key the expression reads, in declaration order.
    /// Duplicates are preserved; callers de-duplicate when they need to.
    pub fn referenced_fields(&self) -> Vec<&str> {
        let mut fields = Vec::new();
        self.collect_referenced_fields(&mut fields);
        fields
    }

    fn collect_referenced_fields<'a>(&'a self, fields: &mut Vec<&'a str>) {
        match self {
            Self::Field(clause) => fields.push(clause.field.as_str()),
            Self::AllOf { all_of } => all_of.iter().for_each(|child| child.collect_referenced_fields(fields)),
            Self::AnyOf { any_of } => any_of.iter().for_each(|child| child.collect_referenced_fields(fields)),
            Self::Not { not } => not.collect_referenced_fields(fields),
        }
    }

    /// Structural validation shared by every condition site. Returns
    /// human-readable problems without a location prefix.
    pub fn validate(&self) -> Vec<String> {
        let mut errors = Vec::new();
        if self.node_count() > MAX_PLUGIN_FIELD_CONDITION_NODES {
            errors.push(format!("condition uses more than {MAX_PLUGIN_FIELD_CONDITION_NODES} nodes"));
            return errors;
        }
        self.validate_at_depth(0, &mut errors);
        errors
    }

    fn validate_at_depth(&self, depth: usize, errors: &mut Vec<String>) {
        if depth > MAX_PLUGIN_FIELD_CONDITION_DEPTH {
            errors.push(format!("condition nesting exceeds {MAX_PLUGIN_FIELD_CONDITION_DEPTH} levels"));
            return;
        }
        match self {
            Self::Field(clause) => {
                if clause.field.trim().is_empty() {
                    errors.push("condition field cannot be empty".to_string());
                }
                if clause.one_of.is_empty() {
                    errors.push("condition one_of cannot be empty".to_string());
                }
            }
            Self::AllOf { all_of } => {
                if all_of.is_empty() {
                    errors.push("condition all_of cannot be empty".to_string());
                }
                for child in all_of {
                    child.validate_at_depth(depth + 1, errors);
                }
            }
            Self::AnyOf { any_of } => {
                if any_of.is_empty() {
                    errors.push("condition any_of cannot be empty".to_string());
                }
                for child in any_of {
                    child.validate_at_depth(depth + 1, errors);
                }
            }
            Self::Not { not } => not.validate_at_depth(depth + 1, errors),
        }
    }

    /// Number of nodes in this expression tree (including this one).
    pub fn node_count(&self) -> usize {
        match self {
            Self::Field(_) => 1,
            Self::AllOf { all_of } => 1 + all_of.iter().map(Self::node_count).sum::<usize>(),
            Self::AnyOf { any_of } => 1 + any_of.iter().map(Self::node_count).sum::<usize>(),
            Self::Not { not } => 1 + not.node_count(),
        }
    }

    /// Raw expression evaluation against a field-value reader. Visibility
    /// cascade handling (a referenced field that is itself hidden) is applied
    /// by callers, exactly like the single-field contract behaved.
    pub fn matches(&self, read: &impl Fn(&str) -> Option<serde_json::Value>) -> bool {
        match self {
            Self::Field(clause) => {
                let Some(value) = read(&clause.field) else {
                    return false;
                };
                let text = condition_value_text(&value);
                if text.trim().is_empty() {
                    return false;
                }
                clause.one_of.iter().any(|literal| literal.canonical() == text)
            }
            Self::AllOf { all_of } => all_of.iter().all(|child| child.matches(read)),
            Self::AnyOf { any_of } => any_of.iter().any(|child| child.matches(read)),
            Self::Not { not } => !not.matches(read),
        }
    }
}

/// Canonical string form of a stored field value, mirroring the frontend
/// (`String(value)`) so a boolean `false` and the literal `"false"` agree.
pub fn condition_value_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => normalize_condition_number(value),
        other => other.to_string(),
    }
}

impl PluginFormFieldDefinition {
    pub fn effective_binding(&self) -> PluginFormFieldBinding {
        self.binding.unwrap_or(if self.field_type == PluginFormFieldType::Password {
            PluginFormFieldBinding::Secret
        } else {
            PluginFormFieldBinding::Config
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginFormFieldType {
    Text,
    Password,
    Number,
    Boolean,
    Select,
    Radio,
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

/// A file action on a plugin connection field (see
/// [`PluginFormFieldDefinition::picker`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginFormFieldPicker {
    pub kind: PluginFormFieldPickerKind,
    /// File filters offered by the picker, e.g. `[".pem", ".key"]`. Entries are
    /// extensions (`.ext`) or MIME types (`text/plain`); non-empty entries only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accept: Vec<String>,
    /// Field that receives the file **content** on hosts without a client
    /// filesystem (the browser build), which cannot produce a usable path.
    /// Required for the picker to appear in the browser; on desktop the chosen
    /// path goes into the declaring field and this field is cleared so the two
    /// sources cannot disagree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_field: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginFormFieldPickerKind {
    /// Pick one existing file.
    File,
    /// Pick one existing directory (desktop only; no browser equivalent).
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginConnectionProviderContribution {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub database_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub fields: Vec<PluginFormFieldDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workbench: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filesystem_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<PluginConnectionCapability>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<PluginConnectionActionContribution>,
    /// Providers whose targets have multiple reachable endpoints (Kafka
    /// bootstrap + advertised listeners) declare this flag so the host hands
    /// them a SOCKS5 `runtime.proxy` route instead of a static tunnel, which
    /// can only reach a single endpoint. Without the flag, transport layers
    /// keep today's static-tunnel behavior (fine for single-endpoint
    /// providers such as SSH or LDAP, which declare binding host/port fields).
    #[serde(default, skip_serializing_if = "is_false")]
    pub proxy_route: bool,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginConnectionActionContribution {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<PluginConnectionActionVariant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<PluginConnectionActionWhen>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub close_on_success: bool,
    #[serde(default = "default_action_requires_valid_form", skip_serializing_if = "is_true")]
    pub requires_valid_form: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// Native context-menu entry contributed to DBX surfaces. v1 targets the
/// saved-connection sidebar menu; clicks are dispatched to the plugin backend
/// as `contextMenu/<id>` requests.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginContextMenuContribution {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Menu surface the item belongs to; currently only `connection`.
    #[serde(default)]
    pub menu: String,
}

/// Plugin-rendered visualization surface for query results. Selecting the view
/// opens the plugin workbench with the current result set as its context.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginResultViewContribution {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginFilesystemProviderContribution {
    pub id: String,
    pub label: String,
    pub schemes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<PluginFilesystemCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
        let mut network_origins: HashSet<&str> = HashSet::new();
        for permission in &self.permissions {
            let valid = SUPPORTED_PLUGIN_PERMISSIONS.contains(&permission.as_str())
                || (permission.starts_with("host.network:") && parse_host_network_permission(permission).is_some());
            if !valid {
                errors.push(format!(
                    "Unsupported plugin Host API permission '{permission}' (network permissions must look like host.network:https://example.com)"
                ));
            } else if !seen_permissions.insert(permission) {
                errors.push(format!("Duplicate plugin permission '{permission}'"));
            }
            if let Some(origin) = parse_host_network_permission(permission) {
                if !network_origins.insert(origin) {
                    errors.push(format!("Duplicate plugin network origin '{origin}'"));
                }
            }
        }
        if network_origins.len() > MAX_PLUGIN_NETWORK_ORIGINS {
            errors.push(format!(
                "Plugin declares {} network origins; at most {MAX_PLUGIN_NETWORK_ORIGINS} are allowed",
                network_origins.len()
            ));
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
    // Windows cannot execute the Unix shell script shipped beside the launcher;
    // when both exist the .bat launcher always wins (see the May 2026 JDBC
    // plugin "os error 193" and ".bat over shell script" fixes).
    #[cfg(windows)]
    {
        let batch_path = path.with_extension("bat");
        if batch_path.is_file() {
            return batch_path;
        }
    }
    if path.is_file() {
        return path;
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
            PluginContribution::ResultView(result_view) => {
                validate_required_text(&result_view.label, &format!("Result view '{id}' label"), errors);
                validate_declared_icon(
                    plugin_dir,
                    &format!("Result view '{id}' icon"),
                    result_view.icon.as_deref(),
                    errors,
                );
                if !has_ui {
                    errors.push(format!("Result view contribution '{id}' requires a UI entrypoint"));
                }
            }
            PluginContribution::ContextMenu(menu) => {
                validate_required_text(&menu.label, &format!("Context menu '{id}' label"), errors);
                validate_declared_icon(plugin_dir, &format!("Context menu '{id}' icon"), menu.icon.as_deref(), errors);
                if menu.menu != "connection" {
                    errors.push(format!(
                        "Context menu '{id}' declares unsupported menu '{}'; only 'connection' is available",
                        menu.menu
                    ));
                }
                if !has_backend {
                    errors.push(format!("Context menu contribution '{id}' requires a backend entrypoint"));
                }
            }
            PluginContribution::FilesystemProvider(provider) => {
                validate_required_text(&provider.label, &format!("Filesystem provider '{id}' label"), errors);
                validate_declared_icon(
                    plugin_dir,
                    &format!("Filesystem provider '{id}' icon"),
                    provider.icon.as_deref(),
                    errors,
                );
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

/// A picker action only makes sense on a field the user can type into, and the
/// field that receives uploaded content must be a declared sibling.
fn validate_form_field_picker(
    field: &PluginFormFieldDefinition,
    fields: &[PluginFormFieldDefinition],
    contribution_index: usize,
    field_index: usize,
    errors: &mut Vec<String>,
) {
    let Some(picker) = &field.picker else {
        return;
    };
    let location = format!("Contribution at index {contribution_index} field {field_index} picker");
    if !matches!(
        field.field_type,
        PluginFormFieldType::Text | PluginFormFieldType::Password | PluginFormFieldType::Textarea
    ) {
        errors.push(format!("{location} is only supported on text, password, or textarea fields"));
    }
    if picker.accept.len() > MAX_PLUGIN_PICKER_FILTERS {
        errors.push(format!("{location} declares more than {MAX_PLUGIN_PICKER_FILTERS} filters"));
    }
    for filter in &picker.accept {
        if !valid_picker_filter(filter) {
            errors.push(format!("{location} filter '{filter}' must look like '.pem' or 'text/plain'"));
        }
    }
    if picker.kind == PluginFormFieldPickerKind::Directory && picker.content_field.is_some() {
        errors.push(format!("{location} cannot upload a directory into a content field"));
    }
    let Some(content_key) = &picker.content_field else {
        return;
    };
    match fields.iter().find(|candidate| candidate.key == *content_key) {
        None => errors.push(format!("{location} content_field references unknown field '{content_key}'")),
        Some(content) => {
            if content.key == field.key {
                errors.push(format!("{location} content_field cannot be the declaring field"));
            }
            if !matches!(
                content.field_type,
                PluginFormFieldType::Text | PluginFormFieldType::Password | PluginFormFieldType::Textarea
            ) {
                errors.push(format!("{location} content_field '{content_key}' must be a text or textarea field"));
            }
        }
    }
}

/// Accept entries are file extensions (`.pem`) or MIME types (`text/plain`), so
/// the browser `<input accept>` attribute and the native dialog filters can use
/// them directly. Anything else is rejected instead of silently ignored.
fn valid_picker_filter(filter: &str) -> bool {
    if let Some(extension) = filter.strip_prefix('.') {
        return !extension.is_empty()
            && extension.len() <= 16
            && extension.chars().all(|character| character.is_ascii_alphanumeric());
    }
    let mut parts = filter.split('/');
    let (Some(kind), Some(subtype), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let valid_part = |part: &str| {
        !part.is_empty()
            && part.len() <= 64
            && part
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.' | '_' | '*'))
    };
    valid_part(kind) && valid_part(subtype)
}

fn validate_form_fields(fields: &[PluginFormFieldDefinition], contribution_index: usize, errors: &mut Vec<String>) {
    let mut seen_keys = HashSet::new();
    let field_keys = fields.iter().map(|field| field.key.as_str()).collect::<HashSet<_>>();
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
        validate_form_field_picker(field, fields, contribution_index, field_index, errors);

        for (name, condition) in
            [("visible_when", field.visible_when.as_ref()), ("required_when", field.required_when.as_ref())]
        {
            let Some(condition) = condition else {
                continue;
            };
            let location = format!("Contribution at index {contribution_index} field {field_index} {name}");
            errors.extend(condition.validate().into_iter().map(|error| format!("{location} {error}")));
            for referenced in condition.referenced_fields() {
                // Self-references are tolerated for backward compatibility (a
                // single-field manifest could always point a field at itself);
                // unknown targets were already rejected by the v1 contract.
                if !field_keys.contains(referenced) {
                    errors.push(format!("{location} references unknown field '{referenced}'"));
                }
            }
        }

        if matches!(field.field_type, PluginFormFieldType::Select | PluginFormFieldType::Radio) {
            if field.options.is_empty() {
                errors.push(format!(
                    "Contribution at index {contribution_index} field {field_index} choice options cannot be empty"
                ));
            }
            let mut seen_values = HashSet::new();
            for option in &field.options {
                if option.label.trim().is_empty() || !seen_values.insert(&option.value) {
                    errors.push(format!(
                        "Contribution at index {contribution_index} field {field_index} has invalid or duplicate choice options"
                    ));
                }
            }
        } else if !field.options.is_empty() {
            errors.push(format!(
                "Contribution at index {contribution_index} field {field_index} only supports options for select or radio fields"
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
                | PluginFormFieldType::Password
                | PluginFormFieldType::Select
                | PluginFormFieldType::Radio
                | PluginFormFieldType::Textarea
        ) {
            errors.push(format!(
                "Contribution at index {contribution_index} field {field_index} string binding requires a string field type"
            ));
        }

        if let Some(default) = &field.default {
            let valid = match field.field_type {
                PluginFormFieldType::Text
                | PluginFormFieldType::Password
                | PluginFormFieldType::Select
                | PluginFormFieldType::Radio
                | PluginFormFieldType::Textarea => default.is_string(),
                PluginFormFieldType::Number => default.is_number(),
                PluginFormFieldType::Boolean => default.is_boolean(),
            };
            if !valid {
                errors.push(format!(
                    "Contribution at index {contribution_index} field {field_index} has an invalid default value"
                ));
            }
            if matches!(field.field_type, PluginFormFieldType::Select | PluginFormFieldType::Radio)
                && default.as_str().is_some_and(|default| !field.options.iter().any(|option| option.value == default))
            {
                errors.push(format!(
                    "Contribution at index {contribution_index} field {field_index} choice default is not declared in options"
                ));
            }
        }
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
        parse_host_network_permission, resolve_safe_plugin_path, validate_connection_actions,
        PluginConnectionActionContribution, PluginConnectionProviderContribution, PluginFormFieldBinding,
        PluginManifest,
    };

    #[test]
    fn connection_provider_proxy_route_defaults_false_and_parses() {
        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "sample.connection",
            "database_type": "sample",
            "fields": []
        }))
        .unwrap();
        assert!(!provider.proxy_route);

        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "sample.connection",
            "database_type": "sample",
            "fields": [],
            "proxy_route": true
        }))
        .unwrap();
        assert!(provider.proxy_route);
    }

    #[test]
    fn parses_only_strict_https_network_permissions() {
        assert_eq!(
            parse_host_network_permission("host.network:https://api.vendor.com"),
            Some("https://api.vendor.com")
        );
        assert_eq!(
            parse_host_network_permission("host.network:https://metrics.vendor.com:8443"),
            Some("https://metrics.vendor.com:8443")
        );
        assert_eq!(parse_host_network_permission("host.events"), None);
        assert_eq!(parse_host_network_permission("host.network:"), None);
        assert_eq!(parse_host_network_permission("host.network:http://api.vendor.com"), None);
        assert_eq!(parse_host_network_permission("host.network:https://api.vendor.com/path"), None);
        assert_eq!(parse_host_network_permission("host.network:https://api.vendor.com?q=1"), None);
        assert_eq!(parse_host_network_permission("host.network:https://api.vendor.com:notaport"), None);
        assert_eq!(parse_host_network_permission("host.network:https://"), None);
    }

    #[test]
    fn manifest_rejects_malformed_network_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.example",
            "name": "Example",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "entrypoints": { "ui": { "root": "ui", "entry": "ui/index.html" } },
            "permissions": ["host.network:http://api.vendor.com", "host.network:https://api.vendor.com"]
        }))
        .unwrap();
        std::fs::create_dir_all(dir.path().join("ui")).unwrap();
        std::fs::write(dir.path().join("ui").join("index.html"), "<!doctype html>").unwrap();
        let compatibility = manifest.compatibility(dir.path(), "0.1.0");
        assert!(compatibility.errors.iter().any(|error| error.contains("host.network:http://api.vendor.com")));
    }

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
            "contributions": [{
                "type": "connection-provider",
                "id": "io.dbx.example.connection",
                "database_type": "example",
                "fields": [{
                    "key": "protocol",
                    "label": "Protocol",
                    "type": "radio",
                    "default": "https",
                    "options": [
                        { "label": "HTTPS", "value": "https" },
                        { "label": "HTTP", "value": "http" }
                    ]
                }]
            }],
            "permissions": ["host.events"]
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
        std::fs::write(dir.path().join("icon.svg"), "<svg />").unwrap();
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
                    "icon": "icon.svg",
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
        assert_eq!(manifest.filesystem_provider("files.provider").unwrap().unwrap().icon.as_deref(), Some("icon.svg"));
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

    /// The manifest the frontend receives is a re-serialization of the parsed
    /// manifest, so an absent optional must stay absent. Emitting `null`
    /// instead made the connection form treat "no default" as a real `null`
    /// value: untouched fields showed a literal "null" and a save persisted the
    /// four-character string "null" into `connection_secrets`.
    #[test]
    fn serialized_form_fields_omit_absent_optionals() {
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.nulls",
            "name": "Nulls",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "contributions": [{
                "type": "connection-provider",
                "id": "nulls.connection",
                "label": "Nulls",
                "database_type": "nulls",
                "fields": [
                    { "key": "sudo_password", "label": "Sudo password", "type": "password", "binding": "secret" },
                    { "key": "with_default", "label": "With default", "type": "text", "default": "root" },
                    { "key": "explicit_null", "label": "Explicit null", "type": "text", "default": null },
                    { "key": "mode", "label": "Mode", "type": "text" }
                ]
            }]
        }))
        .unwrap();

        let serialized = serde_json::to_value(&manifest).unwrap();
        let fields = serialized["contributions"][0]["fields"].as_array().unwrap();

        // A field that declares nothing optional carries none of those keys, so
        // the frontend can never mistake "absent" for a `null` value.
        for key in ["default", "binding", "description", "placeholder"] {
            assert!(fields[3].get(key).is_none(), "bare field must not serialize `{key}`: {}", fields[3]);
        }
        // Declared values survive the round trip; an explicit `null` default
        // means "no default" and normalizes to an absent key rather than a
        // value the form would try to render.
        assert_eq!(fields[0]["binding"], "secret");
        assert_eq!(fields[1]["default"], "root");
        assert!(fields[2].get("default").is_none());
        // Provider-level optionals follow the same rule.
        assert!(serialized["contributions"][0].get("icon").is_none());
        assert!(serialized["contributions"][0].get("workbench").is_none());
        assert!(serialized["contributions"][0].get("filesystem_provider").is_none());
    }

    #[test]
    fn parses_form_field_conditions() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.conditions",
            "name": "Conditions",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "contributions": [{
                "type": "connection-provider",
                "id": "conditions.connection",
                "database_type": "conditions",
                "fields": [
                    {
                        "key": "mode",
                        "label": "Mode",
                        "type": "select",
                        "options": [
                            { "label": "Local", "value": "local" },
                            { "label": "Custom", "value": "custom" }
                        ],
                        "default": "local"
                    },
                    {
                        "key": "private_key_path",
                        "label": "Private key",
                        "type": "text",
                        "visible_when": { "field": "mode", "one_of": ["custom"] },
                        "required_when": { "field": "mode", "one_of": ["custom"] }
                    }
                ]
            }]
        }))
        .unwrap();
        let compatibility = manifest.compatibility(dir.path(), "0.5.68");
        let provider = manifest.connection_provider("conditions.connection").unwrap().unwrap();

        assert!(compatibility.compatible, "{:?}", compatibility.errors);
        let visible_when = provider.fields[1].visible_when.as_ref().unwrap();
        let super::PluginFieldCondition::Field(clause) = visible_when else {
            panic!("legacy single-field condition must deserialize into the field clause");
        };
        assert_eq!(clause.field, "mode");
        assert_eq!(clause.one_of, vec![super::PluginFieldConditionLiteral::String("custom".to_string())]);
        // Serializing a legacy clause keeps the exact v1 manifest shape.
        assert_eq!(
            serde_json::to_value(visible_when).unwrap(),
            serde_json::json!({ "field": "mode", "one_of": ["custom"] })
        );
        let required = provider.fields[1].required_when.as_ref().unwrap();
        let super::PluginFieldCondition::Field(required_clause) = required else {
            panic!("legacy single-field condition must deserialize into the field clause");
        };
        assert_eq!(required_clause.one_of, vec![super::PluginFieldConditionLiteral::String("custom".to_string())]);
    }

    #[test]
    fn rejects_invalid_form_field_conditions() {
        let dir = tempfile::tempdir().unwrap();
        let malformed = serde_json::from_value::<PluginManifest>(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.conditions",
            "name": "Conditions",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "contributions": [{
                "type": "connection-provider",
                "id": "conditions.connection",
                "database_type": "conditions",
                "fields": [
                    { "key": "mode", "label": "Mode", "type": "text" },
                    {
                        "key": "private_key_path",
                        "label": "Private key",
                        "type": "text",
                        "visible_when": { "field": "missing", "one_of": [] },
                        "required_when": { "field": "mode", "one_of": ["custom"], "extra": true }
                    }
                ]
            }]
        }));

        assert!(malformed.is_err());

        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.conditions",
            "name": "Conditions",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "contributions": [{
                "type": "connection-provider",
                "id": "conditions.connection",
                "database_type": "conditions",
                "fields": [
                    { "key": "mode", "label": "Mode", "type": "text" },
                    {
                        "key": "private_key_path",
                        "label": "Private key",
                        "type": "text",
                        "visible_when": { "field": "missing", "one_of": [] },
                        "required_when": { "field": "mode", "one_of": ["custom"] }
                    }
                ]
            }]
        }))
        .unwrap();
        let compatibility = manifest.compatibility(dir.path(), "0.5.68");

        assert!(!compatibility.compatible);
        assert!(compatibility
            .errors
            .iter()
            .any(|error| error.contains("visible_when condition one_of cannot be empty")));
        assert!(compatibility
            .errors
            .iter()
            .any(|error| error.contains("visible_when references unknown field 'missing'")));
    }

    #[test]
    fn parses_composite_form_field_conditions() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.conditions",
            "name": "Conditions",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "contributions": [{
                "type": "connection-provider",
                "id": "conditions.connection",
                "database_type": "conditions",
                "fields": [
                    { "key": "authentication", "label": "Auth", "type": "text" },
                    { "key": "read_only", "label": "Read only", "type": "boolean" },
                    { "key": "sudo_source", "label": "Sudo source", "type": "text" },
                    {
                        "key": "sudo_command",
                        "label": "Sudo command",
                        "type": "text",
                        "visible_when": {
                            "all_of": [
                                { "field": "sudo_source", "one_of": ["custom"] },
                                { "field": "read_only", "one_of": [false] }
                            ]
                        },
                        "required_when": {
                            "all_of": [
                                { "field": "sudo_source", "one_of": ["custom"] },
                                { "not": { "field": "read_only", "one_of": [true] } }
                            ]
                        }
                    }
                ]
            }]
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.6.14");
        assert!(compatibility.compatible, "{:?}", compatibility.errors);

        let provider = manifest.connection_provider("conditions.connection").unwrap().unwrap();
        let visible_when = provider.fields[3].visible_when.as_ref().unwrap();
        assert_eq!(visible_when.referenced_fields(), vec!["sudo_source", "read_only"]);
        assert_eq!(visible_when.node_count(), 3);
        assert!(matches!(visible_when, super::PluginFieldCondition::AllOf { .. }));
    }

    #[test]
    fn rejects_malformed_composite_form_field_conditions() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.conditions",
            "name": "Conditions",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "contributions": [{
                "type": "connection-provider",
                "id": "conditions.connection",
                "database_type": "conditions",
                "fields": [
                    { "key": "mode", "label": "Mode", "type": "text" },
                    {
                        "key": "empty_all_of",
                        "label": "Empty",
                        "type": "text",
                        "visible_when": { "all_of": [] }
                    },
                    {
                        "key": "unknown_nested",
                        "label": "Unknown",
                        "type": "text",
                        "required_when": { "any_of": [{ "field": "ghost", "one_of": ["x"] }] }
                    }
                ]
            }]
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.6.14");
        assert!(!compatibility.compatible);
        assert!(compatibility.errors.iter().any(|error| error.contains("condition all_of cannot be empty")));
        assert!(compatibility
            .errors
            .iter()
            .any(|error| error.contains("required_when references unknown field 'ghost'")));
    }

    /// The SSH plugin asks the host for a key file: desktop hosts store the
    /// client path, browser hosts upload the content into a paired field.
    #[test]
    fn parses_and_validates_file_pickers() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.ssh",
            "name": "SSH",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "contributions": [{
                "type": "connection-provider",
                "id": "ssh.connection",
                "label": "SSH",
                "database_type": "ssh",
                "fields": [
                    {
                        "key": "private_key_path",
                        "label": "Private key path",
                        "type": "text",
                        "binding": "config",
                        "picker": {
                            "kind": "file",
                            "accept": [".pem", ".key", "text/plain"],
                            "content_field": "private_key"
                        }
                    },
                    { "key": "private_key", "label": "Private key", "type": "textarea", "binding": "secret" }
                ]
            }]
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.6.15");
        assert!(compatibility.compatible, "{:?}", compatibility.errors);
        let provider = manifest.connection_provider("ssh.connection").unwrap().unwrap();
        let picker = provider.fields[0].picker.as_ref().unwrap();
        assert_eq!(picker.kind, super::PluginFormFieldPickerKind::File);
        assert_eq!(picker.accept, vec![".pem", ".key", "text/plain"]);
        assert_eq!(picker.content_field.as_deref(), Some("private_key"));
        // The picker round-trips through the manifest the UI receives.
        let serialized = serde_json::to_value(&manifest).unwrap();
        assert_eq!(serialized["contributions"][0]["fields"][0]["picker"]["kind"], "file");
    }

    #[test]
    fn rejects_invalid_file_pickers() {
        let dir = tempfile::tempdir().unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "io.dbx.ssh",
            "name": "SSH",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "contributions": [{
                "type": "connection-provider",
                "id": "ssh.connection",
                "label": "SSH",
                "database_type": "ssh",
                "fields": [
                    { "key": "port", "label": "Port", "type": "number", "picker": { "kind": "file" } },
                    {
                        "key": "private_key_path",
                        "label": "Private key path",
                        "type": "text",
                        "picker": {
                            "kind": "file",
                            "accept": ["pem", ".", "text/"],
                            "content_field": "missing"
                        }
                    },
                    {
                        "key": "self_reference",
                        "label": "Self",
                        "type": "text",
                        "picker": { "kind": "file", "content_field": "self_reference" }
                    },
                    {
                        "key": "folder",
                        "label": "Folder",
                        "type": "text",
                        "picker": { "kind": "directory", "content_field": "private_key_path" }
                    },
                    { "key": "private_key", "label": "Private key", "type": "textarea", "binding": "secret" }
                ]
            }]
        }))
        .unwrap();

        let compatibility = manifest.compatibility(dir.path(), "0.6.15");
        assert!(!compatibility.compatible);
        let errors = compatibility.errors.join("\n");
        assert!(errors.contains("picker is only supported on text, password, or textarea fields"), "{errors}");
        assert!(errors.contains("filter 'pem' must look like '.pem' or 'text/plain'"), "{errors}");
        assert!(errors.contains("filter 'text/' must look like '.pem' or 'text/plain'"), "{errors}");
        assert!(errors.contains("content_field references unknown field 'missing'"), "{errors}");
        assert!(errors.contains("content_field cannot be the declaring field"), "{errors}");
        assert!(errors.contains("cannot upload a directory into a content field"), "{errors}");
    }

    #[test]
    fn rejects_unknown_keys_and_mixed_condition_shapes() {
        // A clause may not smuggle composite keys, and a composite node may not
        // smuggle `field`/`one_of`; both must fail to deserialize.
        assert!(serde_json::from_value::<super::PluginFieldCondition>(serde_json::json!({
            "field": "mode",
            "one_of": ["custom"],
            "all_of": [{ "field": "mode", "one_of": ["custom"] }]
        }))
        .is_err());
        assert!(serde_json::from_value::<super::PluginFieldCondition>(serde_json::json!({})).is_err());
        assert!(serde_json::from_value::<super::PluginFieldCondition>(serde_json::json!({ "not": 1 })).is_err());
    }
}
