//! Per-plugin governance of plugin tools on the external `dbx` MCP server.
//!
//! Three layers decide whether one plugin tool is exposed:
//!
//! 1. **Author contract.** The manifest `mcp` contribution must declare
//!    `external_tools: true`, and every exposed tool must be declared in its
//!    `tools` map with an `access` level. Undeclared tools never reach the
//!    external server: MCP annotations are client hints, not a contract.
//! 2. **User grant** ([`PluginMcpGrant`]). Nothing is exposed until the user
//!    authorizes the plugin: the switch, the access ceiling, the tools the
//!    user accepted (with the level each had), and per-tool opt-outs.
//! 3. **Tool level.** A tool above the ceiling stays hidden; a tool that
//!    needs more than read access and was not accepted at its current level
//!    (new or escalated after a plugin update) waits for confirmation.
//!
//! The global MCP policy (tool allowlist, execution mode, connection scope)
//! still applies on top of everything decided here.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::ai::plugin_tools::RawPluginTool;
use crate::plugins::{PluginManifest, PluginMcpAccess, PluginMcpContribution};
use crate::storage::{PluginMcpAccessLevel, PluginMcpGrant};

/// Toolset id used for tools a plugin does not assign to a declared toolset.
pub const DEFAULT_PLUGIN_TOOLSET: &str = "default";

/// Why a tool is or is not exposed on the external server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginToolExposure {
    Exposed,
    /// The author did not declare this tool's access level in the manifest.
    Undeclared,
    /// The plugin switch is off (or the author did not opt in).
    PluginDisabled,
    /// The user switched this tool off.
    ToolDisabled,
    /// The tool needs more than the granted ceiling.
    AboveCeiling,
    /// New or escalated since the user's last review; waits for confirmation.
    PendingApproval,
}

impl PluginToolExposure {
    pub fn is_exposed(self) -> bool {
        self == Self::Exposed
    }
}

impl From<PluginMcpAccess> for PluginMcpAccessLevel {
    fn from(access: PluginMcpAccess) -> Self {
        match access {
            PluginMcpAccess::Read => Self::Read,
            PluginMcpAccess::Write => Self::Write,
            PluginMcpAccess::Full => Self::Full,
        }
    }
}

/// Declared access level of one tool; `None` when the manifest does not
/// declare it (such a tool is never exposed externally).
pub fn tool_access(contribution: Option<&PluginMcpContribution>, tool: &str) -> Option<PluginMcpAccessLevel> {
    contribution.and_then(|mcp| mcp.declared_access(tool)).map(Into::into)
}

/// Toolset of one tool: the declared toolset when it exists, else the default group.
pub fn tool_toolset(contribution: Option<&PluginMcpContribution>, tool: &str) -> String {
    contribution
        .and_then(|mcp| {
            mcp.declared_toolset(tool).filter(|toolset| mcp.toolsets.iter().any(|declared| declared.id == *toolset))
        })
        .unwrap_or(DEFAULT_PLUGIN_TOOLSET)
        .to_string()
}

/// Whether the author opted the plugin into the external server.
pub fn author_allows_external(manifest: &PluginManifest) -> bool {
    manifest.mcp_contribution().is_some_and(|mcp| mcp.external_tools)
}

/// The grant in force for a plugin: the saved one, or "not authorized".
pub fn effective_grant(saved: Option<&PluginMcpGrant>) -> PluginMcpGrant {
    saved.cloned().unwrap_or(PluginMcpGrant {
        external: false,
        ceiling: PluginMcpAccessLevel::Read,
        approved_tools: Default::default(),
        disabled_tools: Vec::new(),
    })
}

/// Decides one tool's exposure under an effective grant.
pub fn tool_exposure(manifest: &PluginManifest, grant: &PluginMcpGrant, tool: &str) -> PluginToolExposure {
    let Some(access) = tool_access(manifest.mcp_contribution(), tool) else {
        return PluginToolExposure::Undeclared;
    };
    if !author_allows_external(manifest) || !grant.external {
        return PluginToolExposure::PluginDisabled;
    }
    if grant.disabled_tools.iter().any(|name| name == tool) {
        return PluginToolExposure::ToolDisabled;
    }
    if access > grant.ceiling {
        return PluginToolExposure::AboveCeiling;
    }
    if access > PluginMcpAccessLevel::Read && grant.approved_tools.get(tool).is_none_or(|approved| access > *approved) {
        return PluginToolExposure::PendingApproval;
    }
    PluginToolExposure::Exposed
}

/// Accepts every listed, declared tool at its current access level.
pub fn approvals(
    manifest: &PluginManifest,
    tools: &[RawPluginTool],
) -> std::collections::BTreeMap<String, PluginMcpAccessLevel> {
    tools
        .iter()
        .filter_map(|tool| tool_access(manifest.mcp_contribution(), &tool.name).map(|level| (tool.name.clone(), level)))
        .collect()
}

/// The grant suggested when the user turns a plugin on for the first time:
/// every listed declared tool is accepted, and the ceiling defaults to the
/// lower of the plugin's highest tool level and `write`.
pub fn initial_grant(manifest: &PluginManifest, tools: &[RawPluginTool]) -> PluginMcpGrant {
    let highest = tools
        .iter()
        .filter_map(|tool| tool_access(manifest.mcp_contribution(), &tool.name))
        .max()
        .unwrap_or(PluginMcpAccessLevel::Read);
    PluginMcpGrant {
        external: author_allows_external(manifest),
        ceiling: highest.min(PluginMcpAccessLevel::Write),
        approved_tools: approvals(manifest, tools),
        disabled_tools: Vec::new(),
    }
}

/// Keeps only the exposed tools of one plugin listing. The declared level is
/// authoritative on the external server, so each kept tool's `read_only` flag
/// and MCP hints are rewritten from it: the global read-only mode and client
/// annotations then follow the manifest contract, not the sidecar's own hints.
pub fn exposed_tools(
    manifest: &PluginManifest,
    saved: Option<&PluginMcpGrant>,
    tools: Vec<RawPluginTool>,
) -> Vec<RawPluginTool> {
    let grant = effective_grant(saved);
    tools
        .into_iter()
        .filter(|tool| tool_exposure(manifest, &grant, &tool.name).is_exposed())
        .map(|mut tool| {
            if let Some(level) = tool_access(manifest.mcp_contribution(), &tool.name) {
                apply_declared_level(&mut tool, level);
            }
            tool
        })
        .collect()
}

fn apply_declared_level(tool: &mut RawPluginTool, level: PluginMcpAccessLevel) {
    tool.read_only = level == PluginMcpAccessLevel::Read;
    if !tool.annotations.is_object() {
        tool.annotations = serde_json::json!({});
    }
    let annotations = tool.annotations.as_object_mut().expect("annotations object");
    annotations.insert("readOnlyHint".to_string(), serde_json::Value::Bool(level == PluginMcpAccessLevel::Read));
    annotations.insert("destructiveHint".to_string(), serde_json::Value::Bool(level == PluginMcpAccessLevel::Full));
}

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpToolView {
    pub name: String,
    pub description: String,
    pub toolset: String,
    /// Declared access level; `None` for an undeclared (never exposed) tool.
    pub access: Option<PluginMcpAccessLevel>,
    pub exposure: PluginToolExposure,
    /// Parameters flattened from the tool's input schema for display.
    pub parameters: Vec<crate::mcp_catalog::McpToolParameter>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpToolsetView {
    pub id: String,
    /// Declared title; `None` for the default group (the UI names it).
    pub title: Option<String>,
    pub description: Option<String>,
}

/// One plugin card in the MCP capability tab.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpView {
    pub plugin_id: String,
    pub plugin_name: String,
    pub version: String,
    /// The author declared `external_tools: true`.
    pub author_allows_external: bool,
    /// The user has authorized this plugin at least once.
    pub has_saved_grant: bool,
    pub grant: PluginMcpGrant,
    pub toolsets: Vec<PluginMcpToolsetView>,
    pub tools: Vec<PluginMcpToolView>,
    /// `mcp/tools` failed; the tool list is empty and this explains why.
    pub discovery_error: Option<String>,
}

impl PluginMcpView {
    pub fn pending_tool_count(&self) -> usize {
        self.tools.iter().filter(|tool| tool.exposure == PluginToolExposure::PendingApproval).count()
    }
}

/// Builds the settings view of one plugin from its manifest, saved grant and
/// `mcp/tools` listing (`Err` when discovery failed).
pub fn plugin_view(
    manifest: &PluginManifest,
    saved: Option<&PluginMcpGrant>,
    listing: Result<Vec<RawPluginTool>, String>,
) -> PluginMcpView {
    let (tools, discovery_error) = match listing {
        Ok(tools) => (tools, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    let contribution = manifest.mcp_contribution();
    let grant = effective_grant(saved);
    let tool_views = tools
        .iter()
        .map(|tool| PluginMcpToolView {
            name: tool.name.clone(),
            description: tool.description.clone(),
            toolset: tool_toolset(contribution, &tool.name),
            access: tool_access(contribution, &tool.name),
            exposure: tool_exposure(manifest, &grant, &tool.name),
            parameters: tool.input_schema.as_object().map(crate::mcp_catalog::schema_parameters).unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    let used = tool_views.iter().map(|tool| tool.toolset.as_str()).collect::<HashSet<_>>();
    let mut toolsets = contribution
        .map(|mcp| {
            mcp.toolsets
                .iter()
                .filter(|toolset| used.contains(toolset.id.as_str()))
                .map(|toolset| PluginMcpToolsetView {
                    id: toolset.id.clone(),
                    title: Some(toolset.title.clone()),
                    description: toolset.description.clone(),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if used.contains(DEFAULT_PLUGIN_TOOLSET) {
        toolsets.push(PluginMcpToolsetView { id: DEFAULT_PLUGIN_TOOLSET.to_string(), title: None, description: None });
    }
    PluginMcpView {
        plugin_id: manifest.id.clone(),
        plugin_name: manifest.name.clone(),
        version: manifest.version.clone(),
        author_allows_external: author_allows_external(manifest),
        has_saved_grant: saved.is_some(),
        grant,
        toolsets,
        tools: tool_views,
        discovery_error,
    }
}

/// Plugins carrying the "provides MCP tools" mark (backend + `mcp`
/// contribution), compatible with this host. Only these get a card in the
/// MCP capability tab; the author's `external_tools` decides whether the
/// card's switch can be turned on.
pub fn mcp_capable_plugins(plugins: &[crate::plugins::InstalledPlugin]) -> Vec<&crate::plugins::InstalledPlugin> {
    let mut capable = plugins
        .iter()
        .filter(|plugin| plugin.compatibility.compatible && plugin.manifest.provides_mcp_tools())
        .collect::<Vec<_>>();
    capable.sort_by(|left, right| {
        left.manifest.name.cmp(&right.manifest.name).then(left.manifest.id.cmp(&right.manifest.id))
    });
    capable
}

/// Probe budget for one plugin's `mcp/tools` while building the settings
/// view; matches the external discovery budget.
const SETTINGS_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

fn lacks_tool_surface(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("unknown method") || lower.contains("method not found") || lower.contains("-32601")
}

async fn probe_tools(state: &crate::connection::AppState, plugin_id: &str) -> Result<Vec<RawPluginTool>, String> {
    match state
        .plugin_host
        .invoke::<serde_json::Value>(plugin_id, "mcp/tools", serde_json::json!({}), None, Some(SETTINGS_PROBE_TIMEOUT))
        .await
    {
        Ok(listing) => Ok(crate::ai::plugin_tools::parse_tool_list(&listing)),
        Err(error) if lacks_tool_surface(&error) => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

/// Settings view of every MCP-capable plugin. User initiated, so it may start
/// sidecars; probes run concurrently and a failing plugin reports its error
/// on its own card. Plugins without the author opt-in are listed (with the
/// switch locked) but not probed.
pub async fn list_plugin_views(state: &crate::connection::AppState) -> Result<Vec<PluginMcpView>, String> {
    let plugins = state.plugins.list_installed()?;
    let grants = state.storage.load_plugin_mcp_grants().await?;
    let capable = mcp_capable_plugins(&plugins);
    let views = capable.into_iter().map(|plugin| {
        let grants = &grants;
        async move {
            let listing = if author_allows_external(&plugin.manifest) {
                probe_tools(state, &plugin.manifest.id).await
            } else {
                Ok(Vec::new())
            };
            plugin_view(&plugin.manifest, grants.get(&plugin.manifest.id), listing)
        }
    });
    Ok(futures::future::join_all(views).await)
}

/// One plugin's settings view (after a save or a refresh).
pub async fn plugin_view_for(state: &crate::connection::AppState, plugin_id: &str) -> Result<PluginMcpView, String> {
    let plugin =
        state.plugins.find_plugin(plugin_id)?.ok_or_else(|| format!("Plugin '{plugin_id}' is not installed"))?;
    if !plugin.manifest.provides_mcp_tools() {
        return Err(format!("Plugin '{plugin_id}' does not provide MCP tools"));
    }
    let grants = state.storage.load_plugin_mcp_grants().await?;
    let listing =
        if author_allows_external(&plugin.manifest) { probe_tools(state, plugin_id).await } else { Ok(Vec::new()) };
    Ok(plugin_view(&plugin.manifest, grants.get(plugin_id), listing))
}

/// Saves the user's grant for one plugin and returns the refreshed view.
/// Enabling requires the author opt-in; `approve_current` additionally
/// accepts every tool the plugin lists right now (first enable, or the
/// "confirm new tools" action), so the pending set is computed against the
/// live listing rather than a stale client copy.
pub async fn save_plugin_grant(
    state: &crate::connection::AppState,
    plugin_id: &str,
    mut grant: PluginMcpGrant,
    approve_current: bool,
) -> Result<PluginMcpView, String> {
    let plugin =
        state.plugins.find_plugin(plugin_id)?.ok_or_else(|| format!("Plugin '{plugin_id}' is not installed"))?;
    if grant.external && !author_allows_external(&plugin.manifest) {
        return Err(format!("Plugin '{plugin_id}' does not allow external MCP access"));
    }
    if approve_current {
        let tools = probe_tools(state, plugin_id).await?;
        grant.approved_tools.extend(approvals(&plugin.manifest, &tools));
    }
    state.storage.save_plugin_mcp_grant(plugin_id, grant).await?;
    plugin_view_for(state, plugin_id).await
}

/// Lookup helper: saved grants by plugin id.
pub fn saved_grant<'a>(grants: &'a HashMap<String, PluginMcpGrant>, plugin_id: &str) -> Option<&'a PluginMcpGrant> {
    grants.get(plugin_id)
}

/// Resolve a scope kind from the actual provider, not a global list: plugins
/// may declare custom kinds but cannot write rules for another connection.
fn validate_scope_kind(
    db_type: crate::models::connection::DatabaseType,
    plugin_id: Option<&str>,
    manifest: Option<&PluginManifest>,
    kind: &str,
) -> Result<(), String> {
    let expected = if let Some(plugin_id) = plugin_id {
        manifest
            .filter(|manifest| manifest.id == plugin_id)
            .and_then(|manifest| manifest.mcp_contribution())
            .and_then(|mcp| mcp.scope.as_ref())
            .map(|scope| scope.kind.as_str())
    } else if db_type == crate::models::connection::DatabaseType::Nacos {
        Some("namespace")
    } else {
        None
    };
    if kind == "database" || expected != Some(kind) {
        return Err("MCP_SCOPE_INVALID: This scope kind is not supported by the connection's provider".to_string());
    }
    Ok(())
}

pub async fn set_scope_rule(
    state: &crate::connection::AppState,
    connection_id: &str,
    kind: &str,
    value: Option<&str>,
    rule: Option<crate::mcp_access::McpAccessRule>,
    sub_scope: Option<crate::mcp_access::McpSubScopeMode>,
) -> Result<crate::mcp_access::McpAccessPolicy, String> {
    let connection = state
        .storage
        .load_connections()
        .await?
        .into_iter()
        .find(|connection| connection.id == connection_id.trim())
        .ok_or_else(|| "CONNECTION_NOT_FOUND: connection is not available".to_string())?;
    let manifest = match connection.plugin_id.as_deref() {
        Some(id) => state
            .plugins
            .list_installed()?
            .into_iter()
            .find(|plugin| plugin.manifest.id == id)
            .map(|plugin| plugin.manifest),
        None => None,
    };
    validate_scope_kind(connection.db_type, connection.plugin_id.as_deref(), manifest.as_ref(), kind.trim())?;
    if rule.as_ref().is_some_and(|rule| {
        rule.sub_scope.is_some() || rule.sub_scope_kind.is_some() || !rule.toolset_ceilings.is_empty()
    }) {
        return Err("MCP_SCOPE_INVALID: Child scope rules cannot change connection settings".to_string());
    }
    if rule.is_some() && value.is_none_or(|value| value.trim().is_empty()) {
        return Err("MCP_SCOPE_INVALID: A scope value is required for a rule".to_string());
    }
    state.storage.set_mcp_plugin_scope_rule(&connection.id, kind.trim(), value, rule, sub_scope).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::plugin_tools::parse_tool_list;
    use serde_json::json;

    fn manifest(mcp: serde_json::Value) -> PluginManifest {
        let mut contributions = Vec::new();
        if !mcp.is_null() {
            let mut contribution = json!({ "type": "mcp", "id": "io.dbx.example.mcp" });
            contribution.as_object_mut().unwrap().extend(mcp.as_object().cloned().unwrap_or_default());
            contributions.push(contribution);
        }
        serde_json::from_value(json!({
            "manifest_version": 1,
            "id": "io.dbx.example",
            "name": "Example",
            "version": "1.2.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "entrypoints": { "backend": { "executable": "bin/example" } },
            "contributions": contributions
        }))
        .unwrap()
    }

    #[test]
    fn scope_kinds_must_match_the_connection_provider_including_custom_plugins() {
        use crate::models::connection::DatabaseType;
        let custom = manifest(json!({"scope": {"kind": "workspace", "title": "Workspace", "argument": "workspace"}}));
        assert!(validate_scope_kind(DatabaseType::Mysql, None, None, "topic").is_err());
        assert!(validate_scope_kind(DatabaseType::Nacos, None, None, "namespace").is_ok());
        assert!(validate_scope_kind(DatabaseType::Nacos, None, None, "topic").is_err());
        assert!(validate_scope_kind(DatabaseType::Mysql, Some("io.dbx.example"), Some(&custom), "workspace").is_ok());
        assert!(validate_scope_kind(DatabaseType::Mysql, Some("other"), Some(&custom), "workspace").is_err());
        assert!(validate_scope_kind(DatabaseType::Mysql, Some("io.dbx.example"), None, "workspace").is_err());
        assert!(validate_scope_kind(DatabaseType::Mysql, Some("io.dbx.example"), Some(&custom), "database").is_err());
    }

    #[tokio::test]
    async fn scope_service_rejects_invalid_provider_and_child_fields_without_mutation() {
        use crate::mcp_access::{McpAccessRule, McpSubScopeMode};
        use crate::models::connection::{ConnectionConfig, DatabaseType};
        let dir = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&dir.path().join("state.db")).await.unwrap();
        let state = crate::connection::AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            dir.path().join("plugins"),
            dir.path().join("agents"),
            "test",
        );
        let connections = [DatabaseType::Mysql, DatabaseType::Nacos]
            .into_iter()
            .enumerate()
            .map(|(i, db_type)| {
                serde_json::from_value::<ConnectionConfig>(json!({
                    "id": i.to_string(), "name": "Test", "db_type": db_type,
                    "host": "localhost", "port": 3306, "username": "", "password": "", "database": ""
                }))
                .unwrap()
            })
            .collect::<Vec<_>>();
        state.storage.save_connections(&connections).await.unwrap();
        let before = state.storage.load_mcp_access_policy().await.unwrap();
        for (id, kind) in [("missing", "namespace"), ("0", "topic"), ("1", "topic")] {
            assert!(set_scope_rule(&state, id, kind, None, None, Some(McpSubScopeMode::None)).await.is_err());
        }
        assert!(set_scope_rule(
            &state,
            "1",
            "namespace",
            Some("team"),
            Some(McpAccessRule { sub_scope: Some(McpSubScopeMode::All), ..Default::default() }),
            None
        )
        .await
        .is_err());
        assert!(set_scope_rule(&state, "1", "namespace", None, Some(McpAccessRule::default()), None).await.is_err());
        assert_eq!(state.storage.load_mcp_access_policy().await.unwrap(), before);
        let saved = set_scope_rule(
            &state,
            "1",
            "namespace",
            Some("team"),
            Some(McpAccessRule { visible: Some(true), ..Default::default() }),
            Some(McpSubScopeMode::Selected),
        )
        .await
        .unwrap();
        assert!(saved.sub_scope_visible("1", "namespace", "team"));
        assert!(!saved.sub_scope_visible("1", "namespace", "other"));
    }

    /// Author opt-in with all three tools declared.
    fn declared() -> PluginManifest {
        manifest(json!({
            "external_tools": true,
            "tools": {
                "list_dir": { "access": "read" },
                "upload": { "access": "write" },
                "exec": { "access": "full" }
            }
        }))
    }

    fn tools() -> Vec<RawPluginTool> {
        parse_tool_list(&json!({
            "tools": [
                { "name": "list_dir", "annotations": { "readOnlyHint": true },
                  "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } },
                { "name": "upload" },
                { "name": "exec", "annotations": { "destructiveHint": true } }
            ]
        }))
    }

    fn full_grant(manifest: &PluginManifest) -> PluginMcpGrant {
        PluginMcpGrant { ceiling: PluginMcpAccessLevel::Full, ..initial_grant(manifest, &tools()) }
    }

    fn exposed(manifest: &PluginManifest, grant: Option<&PluginMcpGrant>) -> Vec<String> {
        exposed_tools(manifest, grant, tools()).into_iter().map(|tool| tool.name).collect()
    }

    #[test]
    fn nothing_is_exposed_before_the_user_authorizes() {
        assert!(exposed(&declared(), None).is_empty());
        let view = plugin_view(&declared(), None, Ok(tools()));
        assert!(!view.has_saved_grant && !view.grant.external);
        assert!(view.tools.iter().all(|tool| tool.exposure == PluginToolExposure::PluginDisabled));
    }

    #[test]
    fn undeclared_tools_are_never_exposed_and_annotations_do_not_count() {
        // A legacy plugin remains hidden even if an old grant approved its tools.
        for contribution in
            [json!({ "external_tools": true }), json!({ "external_tools": true, "tools": { "list_dir": {} } })]
        {
            let legacy = manifest(contribution);
            let grant = full_grant(&declared());
            assert!(exposed(&legacy, Some(&grant)).is_empty());
            let view = plugin_view(&legacy, Some(&grant), Ok(tools()));
            assert!(view.tools.iter().all(|tool| tool.exposure == PluginToolExposure::Undeclared));
        }
        // Only list_dir is declared; annotations on the others are ignored.
        let partial = manifest(json!({ "external_tools": true, "tools": { "list_dir": { "access": "read" } } }));
        let grant = full_grant(&partial);
        assert_eq!(grant.approved_tools.keys().collect::<Vec<_>>(), ["list_dir"], "undeclared tools are not approved");
        assert_eq!(exposed(&partial, Some(&grant)), ["list_dir"]);
        let view = plugin_view(&partial, Some(&grant), Ok(tools()));
        assert_eq!(view.tools[1].access, None);
        assert_eq!(view.tools[1].exposure, PluginToolExposure::Undeclared);
        assert_eq!(tool_access(partial.mcp_contribution(), "exec"), None);
    }

    #[test]
    fn author_opt_in_is_a_hard_ceiling() {
        let closed = manifest(json!({ "tools": { "list_dir": { "access": "read" } } }));
        let mut grant = initial_grant(&closed, &tools());
        grant.external = true;
        assert!(exposed(&closed, Some(&grant)).is_empty(), "a saved grant cannot override the author");
        assert!(exposed(&manifest(json!(null)), Some(&grant)).is_empty(), "no mcp contribution at all");
    }

    #[test]
    fn initial_grant_defaults_to_at_most_write_and_accepts_declared_tools() {
        let grant = initial_grant(&declared(), &tools());
        assert_eq!(grant.ceiling, PluginMcpAccessLevel::Write);
        assert!(grant.external);
        assert_eq!(
            grant.approved_tools.clone().into_iter().collect::<Vec<_>>(),
            [
                ("exec".to_string(), PluginMcpAccessLevel::Full),
                ("list_dir".to_string(), PluginMcpAccessLevel::Read),
                ("upload".to_string(), PluginMcpAccessLevel::Write),
            ]
        );
        assert_eq!(exposed(&declared(), Some(&grant)), ["list_dir", "upload"], "exec is above the write ceiling");

        let read_only = manifest(json!({ "external_tools": true, "tools": { "list_dir": { "access": "read" } } }));
        assert_eq!(initial_grant(&read_only, &tools()).ceiling, PluginMcpAccessLevel::Read);
    }

    #[test]
    fn new_write_tools_wait_for_approval_but_new_read_tools_follow_the_switch() {
        let grant = PluginMcpGrant {
            external: true,
            ceiling: PluginMcpAccessLevel::Full,
            approved_tools: Default::default(),
            disabled_tools: vec![],
        };
        let exposure = ["list_dir", "upload", "exec"].map(|tool| tool_exposure(&declared(), &grant, tool));
        assert_eq!(
            exposure,
            [PluginToolExposure::Exposed, PluginToolExposure::PendingApproval, PluginToolExposure::PendingApproval]
        );
    }

    #[test]
    fn escalated_tools_wait_for_approval_again() {
        // upload was accepted while it was read-only; it now needs write.
        let mut grant = full_grant(&declared());
        grant.approved_tools.insert("upload".to_string(), PluginMcpAccessLevel::Read);
        assert_eq!(tool_exposure(&declared(), &grant, "upload"), PluginToolExposure::PendingApproval);
        assert_eq!(tool_exposure(&declared(), &grant, "exec"), PluginToolExposure::Exposed);
        // A tool that drops to a lower level stays exposed.
        grant.approved_tools.insert("upload".to_string(), PluginMcpAccessLevel::Full);
        assert_eq!(tool_exposure(&declared(), &grant, "upload"), PluginToolExposure::Exposed);
    }

    #[test]
    fn exposed_tools_carry_the_declared_level_not_the_sidecar_hints() {
        // The sidecar marks exec destructive and list_dir read-only, but the
        // manifest says exec is read and list_dir is write.
        let contract = manifest(json!({
            "external_tools": true,
            "tools": { "list_dir": { "access": "write" }, "exec": { "access": "read" } }
        }));
        let grant = full_grant(&contract);
        let kept = exposed_tools(&contract, Some(&grant), tools());
        let list_dir = kept.iter().find(|tool| tool.name == "list_dir").unwrap();
        assert!(!list_dir.read_only);
        assert_eq!(list_dir.annotations["readOnlyHint"], json!(false));
        let exec = kept.iter().find(|tool| tool.name == "exec").unwrap();
        assert!(exec.read_only);
        assert_eq!(exec.annotations["destructiveHint"], json!(false));
    }

    #[test]
    fn plugin_switch_and_tool_opt_outs_hide_tools() {
        let mut grant = full_grant(&declared());
        grant.disabled_tools = vec!["upload".to_string()];
        assert_eq!(exposed(&declared(), Some(&grant)), ["list_dir", "exec"]);
        grant.external = false;
        assert!(exposed(&declared(), Some(&grant)).is_empty());
    }

    #[test]
    fn view_groups_tools_and_reports_pending_and_errors() {
        let grouped = manifest(json!({
            "external_tools": true,
            "toolsets": [{ "id": "files", "title": "Files" }, { "id": "unused", "title": "Unused" }],
            "tools": {
                "list_dir": { "toolset": "files", "access": "read" },
                "upload": { "toolset": "files", "access": "write" },
                "exec": { "access": "full" }
            }
        }));
        let grant = PluginMcpGrant {
            external: true,
            ceiling: PluginMcpAccessLevel::Full,
            approved_tools: [
                ("list_dir".to_string(), PluginMcpAccessLevel::Read),
                ("upload".to_string(), PluginMcpAccessLevel::Write),
            ]
            .into(),
            disabled_tools: vec![],
        };
        let view = plugin_view(&grouped, Some(&grant), Ok(tools()));
        assert!(view.has_saved_grant && view.author_allows_external);
        assert_eq!(view.toolsets.iter().map(|toolset| toolset.id.as_str()).collect::<Vec<_>>(), ["files", "default"]);
        assert_eq!(view.tools[0].toolset, "files");
        assert_eq!(view.tools[0].parameters[0].name, "path");
        assert_eq!(view.tools[2].toolset, DEFAULT_PLUGIN_TOOLSET);
        assert_eq!(view.pending_tool_count(), 1, "exec is new and above read");

        let failed = plugin_view(&grouped, None, Err("sidecar crashed".to_string()));
        assert!(failed.tools.is_empty());
        assert_eq!(failed.discovery_error.as_deref(), Some("sidecar crashed"));
        assert!(!failed.has_saved_grant);
    }
}
