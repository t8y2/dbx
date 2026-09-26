//! External exposure of plugin MCP tools on the `dbx` MCP server.
//!
//! Detection-first: every installed, compatible plugin with a backend (and
//! without a manifest `external_tools: false` override) contributes its
//! `mcp/tools` listing under `dbx_<prefix>__<tool>` names. Naming, parsing,
//! and schema reduction are shared with the built-in AI agent
//! (`dbx_core::ai::plugin_tools`) so one plugin tool surfaces under the same
//! exposed name on both automatic surfaces.
//!
//! Calls stay host-bound: the caller picks among the plugin's saved
//! connections that the global MCP policy allows through `dbx_connection`
//! (`connectionId` / `connectionName` are accepted as aliases), and the host
//! generates the lifecycle payload from the saved connection — credentials
//! never cross the process boundary, and a connection saved for plugin A can
//! never be reached through plugin B's tools.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{json, Value};

use dbx_core::ai::plugin_tools::{
    exposed_tool_name, plugin_prefixes, sanitize_schema, RawPluginTool, CONNECTION_ARGUMENT, HOST_BOUND_ARGUMENTS,
};

/// Upper bound for the merged tools/list. Higher than the AI surface's cap:
/// MCP clients paginate and let their users enable/disable tools themselves,
/// so the host does not need to ration as aggressively.
pub const MAX_TOTAL_PLUGIN_TOOLS: usize = 512;

/// Plugin arguments the host resolves from the saved connection before the
/// call is forwarded.
pub const CONNECTION_SELECTOR_ARGUMENTS: &[&str] = &[CONNECTION_ARGUMENT, "connectionId", "connectionName"];

/// One plugin's discovered `mcp/tools` listing, keyed for exposure.
#[derive(Debug, Clone)]
pub struct PluginToolProvider {
    pub plugin_id: String,
    pub plugin_name: String,
    pub tools: Vec<RawPluginTool>,
}

/// One externally exposed plugin tool.
#[derive(Debug, Clone)]
pub struct PluginToolEntry {
    pub plugin_id: String,
    pub plugin_name: String,
    pub exposed_name: String,
    pub tool: RawPluginTool,
    /// The plugin schema declares `connectionId`, so the host injects the
    /// bound connection's id into the forwarded arguments.
    pub injects_connection_id: bool,
}

/// Whether `name` sits in the plugin-tool namespace (`dbx_<prefix>__<tool>`).
/// The static `dbx_*` router tools never contain `__`, so this cannot swallow
/// one, and unknown plugin names simply fail resolution at call time.
pub fn is_plugin_tool_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("dbx_") else { return false };
    let Some((prefix, _)) = rest.split_once("__") else { return false };
    !prefix.is_empty()
}

/// Builds the exposed entries from raw provider listings. Deterministic:
/// providers are ordered by plugin id (so prefix de-duplication is stable)
/// and each plugin keeps its listing order. Exposed names live in the
/// `dbx_<prefix>__<tool>` namespace: the shared AI-surface name plus the
/// `dbx_` router prefix, which static tools never use with a `__` separator.
pub fn build_catalog(providers: &[PluginToolProvider]) -> Vec<PluginToolEntry> {
    let mut sorted: Vec<&PluginToolProvider> = providers.iter().collect();
    sorted.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
    let prefixes = plugin_prefixes(sorted.iter().map(|provider| provider.plugin_id.as_str()));
    let mut entries = Vec::new();
    'providers: for provider in sorted {
        let prefix = &prefixes[&provider.plugin_id];
        let mut used = HashSet::new();
        for tool in &provider.tools {
            if entries.len() >= MAX_TOTAL_PLUGIN_TOOLS {
                log::warn!(
                    "[mcp][plugin-tools] tool limit {MAX_TOTAL_PLUGIN_TOOLS} reached; remaining plugin tools skipped"
                );
                break 'providers;
            }
            entries.push(PluginToolEntry {
                exposed_name: format!("dbx_{}", exposed_tool_name(prefix, &tool.name, &mut used)),
                plugin_id: provider.plugin_id.clone(),
                plugin_name: provider.plugin_name.clone(),
                injects_connection_id: tool.input_schema.pointer("/properties/connectionId").is_some(),
                tool: tool.clone(),
            });
        }
    }
    entries
}

/// The caller-facing parameter schema: the plugin schema reduced to the same
/// portable subset the AI surface uses, host-bound arguments removed, and an
/// optional connection selector added when the plugin has allowed
/// connections. The selector stays optional: with exactly one connection the
/// host binds it, and connection-less tools work without one.
pub fn external_tool_parameters(input_schema: &Value, connections: &[(String, String)]) -> Value {
    let mut schema = sanitize_schema(input_schema, 0);
    if schema.get("type").and_then(Value::as_str) != Some("object") {
        schema = json!({ "type": "object", "properties": {} });
    }
    let object = schema.as_object_mut().expect("object schema");
    let properties = object.entry("properties").or_insert_with(|| json!({}));
    if let Some(properties) = properties.as_object_mut() {
        for key in HOST_BOUND_ARGUMENTS {
            properties.remove(*key);
        }
    }
    let required = object
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|key| !HOST_BOUND_ARGUMENTS.contains(key))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !required.is_empty() {
        object.insert("required".to_string(), json!(required));
    } else {
        object.remove("required");
    }
    if !connections.is_empty() {
        let choices = connections.iter().map(|(id, name)| format!("{id} = {name}")).collect::<Vec<_>>().join("; ");
        let mut selector = json!({
            "type": "string",
            "description": format!(
                "DBX connection to run this tool on. Omit to use the only allowed connection. ({choices})"
            ),
        });
        if connections.len() > 1 {
            selector["enum"] = json!(connections.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>());
        }
        object["properties"][CONNECTION_ARGUMENT] = selector;
    }
    schema
}

/// Caller-facing description, attributed to the owning plugin.
pub fn external_tool_description(plugin_name: &str, tool: &RawPluginTool) -> String {
    let body = if tool.description.trim().is_empty() { tool.name.as_str() } else { tool.description.as_str() };
    format!("[{plugin_name} plugin] {body}").chars().take(1_500).collect()
}

/// Resolves the connection binding for one external call. `selector` is the
/// trimmed `dbx_connection` / `connectionId` / `connectionName` value, when
/// the caller supplied one. Matching mirrors the AI surface: exact id first,
/// then an unambiguous name.
pub fn select_connection<'a>(
    connections: &'a [(String, String)],
    selector: Option<&str>,
) -> Result<Option<&'a (String, String)>, String> {
    let available = || connections.iter().map(|(id, name)| format!("{id} ({name})")).collect::<Vec<_>>().join(", ");
    let Some(selector) = selector.filter(|selector| !selector.trim().is_empty()) else {
        return match connections {
            [only] => Ok(Some(only)),
            [] => Ok(None),
            _ => Err(format!(
                "Pass `{CONNECTION_ARGUMENT}` to choose the connection. Allowed connections: {}",
                available()
            )),
        };
    };
    let requested = selector.trim();
    connections
        .iter()
        .find(|(id, _)| id == requested)
        .or_else(|| {
            let mut by_name = connections.iter().filter(|(_, name)| name == requested);
            let first = by_name.next();
            // A name is only a valid selector when it is unambiguous.
            first.filter(|_| by_name.next().is_none())
        })
        .map(Some)
        .ok_or_else(|| {
            format!("`{requested}` is not an allowed connection for this tool. Allowed connections: {}", available())
        })
}

/// Extracts the connection selector from raw call arguments (without
/// consuming them), preferring the canonical `dbx_connection` key.
pub fn connection_selector_from(arguments: &Value) -> Option<&str> {
    CONNECTION_SELECTOR_ARGUMENTS.iter().find_map(|key| arguments.get(*key).and_then(Value::as_str))
}

/// Converts a plugin `mcp/call` answer (MCP `CallToolResult`-shaped JSON)
/// into the rmcp wire type, degrading to a plain text payload for plugins
/// that return something else.
pub fn call_result_to_rmcp(value: Value) -> rmcp::model::CallToolResult {
    use rmcp::model::{CallToolResult, ContentBlock};
    if let Ok(result) = serde_json::from_value::<CallToolResult>(value.clone()) {
        return result;
    }
    let text = if value.is_null() { "(the tool returned no output)".to_string() } else { value.to_string() };
    let mut result = CallToolResult::success(vec![ContentBlock::text(text)]);
    result.is_error = None;
    result
}

/// The rmcp `Tool` for the external `tools/list` view.
pub fn to_rmcp_tool(entry: &PluginToolEntry, connections: &[(String, String)]) -> rmcp::model::Tool {
    let annotations =
        entry.tool.annotations.as_object().filter(|annotations| !annotations.is_empty()).and_then(|annotations| {
            serde_json::from_value::<rmcp::model::ToolAnnotations>(Value::Object(annotations.clone())).ok()
        });
    let schema = external_tool_parameters(&entry.tool.input_schema, connections);
    let mut tool = rmcp::model::Tool::new(
        entry.exposed_name.clone(),
        external_tool_description(&entry.plugin_name, &entry.tool),
        Arc::new(schema.as_object().cloned().unwrap_or_default()),
    );
    tool.annotations = annotations;
    tool
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_core::ai::plugin_tools::parse_tool_list;

    fn provider(plugin_id: &str, plugin_name: &str, tools: Value) -> PluginToolProvider {
        PluginToolProvider {
            plugin_id: plugin_id.to_string(),
            plugin_name: plugin_name.to_string(),
            tools: parse_tool_list(&tools),
        }
    }

    fn ssh_listing() -> Value {
        json!({
            "tools": [
                {
                    "name": "sftp_list_dir",
                    "description": "List a remote directory",
                    "annotations": { "readOnlyHint": true },
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "connectionId": { "type": "string" },
                            "path": { "type": "string", "description": "Absolute path" }
                        },
                        "required": ["connectionId", "path"]
                    }
                },
                {
                    "name": "ssh_exec",
                    "description": "Run a command",
                    "inputSchema": { "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] }
                }
            ]
        })
    }

    #[test]
    fn plugin_namespace_cannot_swallow_static_router_names() {
        assert!(is_plugin_tool_name("dbx_ssh__sftp_list_dir"));
        assert!(is_plugin_tool_name("dbx_ssh__x__y"));
        assert!(!is_plugin_tool_name("dbx_list_connections"));
        assert!(!is_plugin_tool_name("dbx_ssh_underscore"));
        assert!(!is_plugin_tool_name("ssh__sftp_list_dir"));
        assert!(!is_plugin_tool_name("dbx____"));
    }

    #[test]
    fn catalog_exposes_prefixed_names_in_provider_order() {
        let providers = vec![
            provider("io.dbx.ssh", "Terminal", ssh_listing()),
            provider("io.dbx.files", "Files", json!({ "tools": [{ "name": "files_list", "description": "List" }] })),
        ];
        let entries = build_catalog(&providers);
        let names = entries.iter().map(|entry| entry.exposed_name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, ["dbx_files__files_list", "dbx_ssh__sftp_list_dir", "dbx_ssh__ssh_exec"]);
        let sftp = entries.iter().find(|entry| entry.exposed_name == "dbx_ssh__sftp_list_dir").unwrap();
        assert!(sftp.tool.read_only);
        assert!(sftp.injects_connection_id, "the plugin schema declares connectionId");
    }

    #[test]
    fn catalog_is_plugin_agnostic_and_disambiguates_prefix_clashes() {
        // Any plugin id works; the prefix is derived from its last segment.
        let providers = vec![
            provider("a.files", "Files A", json!({ "tools": [{ "name": "list", "description": "List" }] })),
            provider("b.files", "Files B", json!({ "tools": [{ "name": "list", "description": "List" }] })),
            provider("com.vendor.kubernetes", "K8s", json!({ "tools": [{ "name": "apply", "description": "Apply" }] })),
        ];
        let entries = build_catalog(&providers);
        let names = entries.iter().map(|entry| entry.exposed_name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, ["dbx_files__list", "dbx_files2__list", "dbx_kubernetes__apply"]);
    }

    #[test]
    fn external_schema_strips_host_bound_arguments_and_adds_selector() {
        let providers = vec![provider("io.dbx.ssh", "Terminal", ssh_listing())];
        let entries = build_catalog(&providers);
        let sftp = entries.iter().find(|entry| entry.exposed_name == "dbx_ssh__sftp_list_dir").unwrap();
        let schema = external_tool_parameters(
            &sftp.tool.input_schema,
            &[("c1".to_string(), "prod".to_string()), ("c2".to_string(), "test".to_string())],
        );
        assert!(schema.pointer("/properties/connectionId").is_none());
        assert_eq!(schema["required"], json!(["path"]), "connectionId leaves the required list");
        assert_eq!(schema["properties"][CONNECTION_ARGUMENT]["enum"], json!(["c1", "c2"]));

        let single = external_tool_parameters(&sftp.tool.input_schema, &[("c1".to_string(), "prod".to_string())]);
        assert!(single.pointer(&format!("/properties/{CONNECTION_ARGUMENT}/enum")).is_none());
        assert!(single.pointer(&format!("/properties/{CONNECTION_ARGUMENT}")).is_some());

        let none = external_tool_parameters(&sftp.tool.input_schema, &[]);
        assert!(none.pointer(&format!("/properties/{CONNECTION_ARGUMENT}")).is_none());
    }

    #[test]
    fn selector_resolution_mirrors_the_ai_surface() {
        let connections = vec![("c1".to_string(), "prod".to_string()), ("c2".to_string(), "test".to_string())];
        // Multiple connections need an explicit selector.
        assert!(select_connection(&connections, None).is_err());
        // Exact id, unique name, unknown.
        assert_eq!(select_connection(&connections, Some("c2")).unwrap().unwrap().0, "c2");
        assert_eq!(select_connection(&connections, Some("prod")).unwrap().unwrap().0, "c1");
        assert!(select_connection(&connections, Some("c9")).is_err());

        let single = vec![("c1".to_string(), "prod".to_string())];
        assert_eq!(select_connection(&single, None).unwrap().unwrap().0, "c1");
        let empty: Vec<(String, String)> = Vec::new();
        assert!(select_connection(&empty, None).unwrap().is_none(), "connection-less tools stay callable");
    }

    #[test]
    fn selector_extraction_prefers_the_canonical_argument() {
        let args = json!({ "connectionId": "k1", "path": "/" });
        assert_eq!(connection_selector_from(&args), Some("k1"));
        let canonical = json!({ "dbx_connection": "k2", "connectionId": "k1" });
        assert_eq!(connection_selector_from(&canonical), Some("k2"));
        assert_eq!(connection_selector_from(&json!({ "path": "/" })), None);
    }

    #[test]
    fn call_results_convert_with_a_text_fallback() {
        let shaped = call_result_to_rmcp(json!({
            "content": [{ "type": "text", "text": "done" }],
            "isError": true
        }));
        assert_eq!(shaped.content.len(), 1);
        assert_eq!(shaped.is_error, Some(true));
        let fallback = call_result_to_rmcp(json!({ "unexpected": "shape" }));
        assert_eq!(fallback.content.len(), 1);
        assert_eq!(fallback.is_error, None);
    }
}
