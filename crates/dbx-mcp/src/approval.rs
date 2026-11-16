//! Desktop confirmation for high-risk non-SQL MCP tool calls.
//!
//! SQL keeps its dedicated token flow (`approve_high_risk_sql`): the server
//! re-validates the exact statement after the prompt and consumes a one-shot
//! token. Other tools use this simpler contract: the desktop shows what will
//! run, the person answers, and the server re-checks policy before running.
//!
//! Call safety is evaluated after resource authorization. HighRisk confirms
//! authorized Full operations too; only the explicit legacy Full policy may
//! temporarily elevate Write. Every handler rechecks authorization after approval.

use serde::{Deserialize, Serialize};

/// Upper bound for the argument preview shown in the confirmation dialog.
const MAX_ARGUMENT_PREVIEW_CHARS: usize = 4_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolApprovalKind {
    /// A plugin tool declared `full` in its manifest.
    PluginTool,
    /// A Redis command classified as dangerous (FLUSHALL, KEYS *, …).
    RedisCommand,
    /// A MongoDB command requiring Full access.
    MongoCommand,
    /// A product-provider tool declared `full` (Nacos config delete, …).
    ProductTool,
    /// A destructive host operation such as removing a connection.
    ConnectionManagement,
}

/// What the desktop shows and the person confirms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolApprovalRequest {
    pub kind: ToolApprovalKind,
    /// Exposed MCP tool name (`dbx_ssh__exec`, `dbx_execute_redis_command`).
    pub tool: String,
    /// Plugin display name for plugin tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    /// Human-readable summary of the call (command line, arguments JSON).
    pub detail: String,
}

impl ToolApprovalRequest {
    pub fn new(kind: ToolApprovalKind, tool: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            kind,
            tool: tool.into(),
            plugin: None,
            connection_id: None,
            database: None,
            detail: preview(detail.into()),
        }
    }

    pub fn with_plugin(mut self, plugin: impl Into<String>) -> Self {
        self.plugin = Some(plugin.into());
        self
    }

    pub fn with_target(mut self, connection_id: Option<&str>, database: Option<&str>) -> Self {
        self.connection_id = connection_id.map(str::to_string);
        self.database = database.map(str::to_string);
        self
    }
}

/// Pretty JSON of call arguments for the dialog, capped in length.
pub fn arguments_preview(arguments: &serde_json::Value) -> String {
    preview(serde_json::to_string_pretty(arguments).unwrap_or_else(|_| arguments.to_string()))
}

fn preview(text: String) -> String {
    if text.chars().count() <= MAX_ARGUMENT_PREVIEW_CHARS {
        return text;
    }
    let mut truncated = text.chars().take(MAX_ARGUMENT_PREVIEW_CHARS).collect::<String>();
    truncated.push_str("\n…");
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn requests_serialize_for_the_bridge_and_cap_previews() {
        let request = ToolApprovalRequest::new(
            ToolApprovalKind::PluginTool,
            "dbx_ssh__exec",
            arguments_preview(&json!({ "command": "rm -rf /tmp/x" })),
        )
        .with_plugin("Terminal")
        .with_target(Some("c1"), None);
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["kind"], "plugin_tool");
        assert_eq!(value["plugin"], "Terminal");
        assert!(value.get("database").is_none());
        assert!(value["detail"].as_str().unwrap().contains("rm -rf"));
        let round_trip: ToolApprovalRequest = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip, request);

        let long = arguments_preview(&json!({ "payload": "x".repeat(10_000) }));
        assert!(long.chars().count() <= MAX_ARGUMENT_PREVIEW_CHARS + 2);
        assert!(long.ends_with('…'));
    }
}
