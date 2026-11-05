//! Static descriptor catalog for the built-in `dbx` MCP tools.
//!
//! The catalog groups every built-in tool into a toolset owned by a provider,
//! declares the highest access level the tool can reach, and computes which
//! connection types the tool works on. Settings UIs render it instead of a
//! hardcoded checkbox list, so the grouping and the coverage text cannot drift
//! from the server. It is descriptive only: tool permissions are still the
//! flat `allowed_tool_names` allowlist enforced by the MCP server.
//!
//! `dbx-mcp` asserts that the router and this catalog name the same tools, so
//! a new tool cannot ship without a descriptor.

use serde::Serialize;

use crate::database_manifest::{self, DatabaseCapability};
use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpAccessLevel {
    Read,
    Write,
    Full,
}

/// Whether the access level is fixed per tool or decided per call (for
/// example by the SQL risk classifier).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpAccessMode {
    Static,
    Classified,
}

/// How a tool's applicable connection types are derived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpCoverage {
    /// Not bound to a connection (connection management, plugin router).
    None,
    /// Every connection type the MCP server can reach.
    AllConnections,
    /// Connection types whose manifest entry advertises the capability,
    /// minus `exclude` (types the tool rejects explicitly).
    Capability { capability: DatabaseCapability, exclude: &'static [DatabaseType] },
    /// A fixed list of connection types.
    Types(&'static [DatabaseType]),
}

#[derive(Debug, Clone, Copy)]
pub struct McpToolDescriptor {
    pub name: &'static str,
    pub toolset: &'static str,
    pub access: McpAccessLevel,
    pub access_mode: McpAccessMode,
    pub coverage: McpCoverage,
}

#[derive(Debug, Clone, Copy)]
pub struct McpToolsetDescriptor {
    pub id: &'static str,
    pub provider: &'static str,
    /// Resource scopes understood by this toolset. Empty means the toolset is
    /// connection-less (for example the plugin router); the values are stable
    /// ids used by the settings resource tree and policy API.
    pub scope_kinds: &'static [&'static str],
}

const NO_SCOPE: &[&str] = &[];
const DATABASE_SCOPE: &[&str] = &["database"];
const REDIS_SCOPE: &[&str] = &["dbIndex"];
const MQ_SCOPE: &[&str] = &["topic", "queue"];
const SALESFORCE_SCOPE: &[&str] = &["org"];
const NACOS_SCOPE: &[&str] = &["namespace"];

pub const TOOLSETS: &[McpToolsetDescriptor] = &[
    McpToolsetDescriptor { id: "core.discovery", provider: "builtin:core", scope_kinds: DATABASE_SCOPE },
    McpToolsetDescriptor { id: "sql.query", provider: "builtin:sql", scope_kinds: DATABASE_SCOPE },
    McpToolsetDescriptor { id: "sql.session", provider: "builtin:sql", scope_kinds: DATABASE_SCOPE },
    McpToolsetDescriptor { id: "sql.schema", provider: "builtin:sql", scope_kinds: DATABASE_SCOPE },
    McpToolsetDescriptor { id: "redis", provider: "builtin:redis", scope_kinds: REDIS_SCOPE },
    McpToolsetDescriptor { id: "mq", provider: "builtin:mq", scope_kinds: MQ_SCOPE },
    McpToolsetDescriptor { id: "salesforce", provider: "builtin:salesforce", scope_kinds: SALESFORCE_SCOPE },
    McpToolsetDescriptor { id: "nacos.config", provider: "builtin:nacos", scope_kinds: NACOS_SCOPE },
    McpToolsetDescriptor { id: "nacos.service", provider: "builtin:nacos", scope_kinds: NACOS_SCOPE },
    // A Consul connection already represents one configured datacenter. The
    // product API does not accept a datacenter selector, so there is no
    // separate MCP sub-scope to authorize here.
    McpToolsetDescriptor { id: "consul.kv", provider: "builtin:consul", scope_kinds: NO_SCOPE },
    McpToolsetDescriptor { id: "consul.service", provider: "builtin:consul", scope_kinds: NO_SCOPE },
    McpToolsetDescriptor { id: "workbench", provider: "builtin:workbench", scope_kinds: NO_SCOPE },
    McpToolsetDescriptor { id: "admin.connections", provider: "builtin:admin", scope_kinds: NO_SCOPE },
    McpToolsetDescriptor { id: "plugin.router", provider: "builtin:plugin", scope_kinds: NO_SCOPE },
];

const NON_SQL_SESSION: &[DatabaseType] = &[DatabaseType::Redis, DatabaseType::MongoDb, DatabaseType::Salesforce];

/// `dbx_execute_batch` and sessions reject the same types (see their
/// `DBX_BATCH_UNSUPPORTED` / `SESSION_UNSUPPORTED` guards in `dbx-mcp`).
const SQL_QUERY: McpCoverage =
    McpCoverage::Capability { capability: DatabaseCapability::QueryExecution, exclude: NON_SQL_SESSION };

/// Product providers (design §5): one product, one connection type.
const NACOS: McpCoverage = McpCoverage::Types(&[DatabaseType::Nacos]);
const CONSUL: McpCoverage = McpCoverage::Types(&[DatabaseType::Consul]);

/// Fixed-session transactions only run on native MySQL
/// (`transaction_connection_supported` in `dbx-mcp`).
const TRANSACTIONS: McpCoverage = McpCoverage::Types(&[DatabaseType::Mysql]);

const fn tool(
    name: &'static str,
    toolset: &'static str,
    access: McpAccessLevel,
    coverage: McpCoverage,
) -> McpToolDescriptor {
    McpToolDescriptor { name, toolset, access, access_mode: McpAccessMode::Static, coverage }
}

const fn classified(name: &'static str, toolset: &'static str, coverage: McpCoverage) -> McpToolDescriptor {
    McpToolDescriptor { name, toolset, access: McpAccessLevel::Full, access_mode: McpAccessMode::Classified, coverage }
}

use McpAccessLevel::{Full, Read, Write};

pub const TOOLS: &[McpToolDescriptor] = &[
    // Listing the configured connections is a discovery operation in its own
    // right, so it remains available when the workspace has no connections.
    tool("dbx_list_connections", "core.discovery", Read, McpCoverage::None),
    tool("dbx_list_databases", "core.discovery", Read, McpCoverage::AllConnections),
    tool(
        "dbx_get_schema_context",
        "core.discovery",
        Read,
        McpCoverage::Capability { capability: DatabaseCapability::MetadataBrowse, exclude: &[] },
    ),
    classified(
        "dbx_execute_query",
        "sql.query",
        McpCoverage::Capability { capability: DatabaseCapability::QueryExecution, exclude: &[] },
    ),
    classified(
        "dbx_execute_batch",
        "sql.query",
        McpCoverage::Capability { capability: DatabaseCapability::SqlFileExecution, exclude: NON_SQL_SESSION },
    ),
    tool("dbx_open_session", "sql.session", Read, SQL_QUERY),
    tool("dbx_begin_transaction", "sql.session", Write, TRANSACTIONS),
    tool("dbx_commit_transaction", "sql.session", Write, TRANSACTIONS),
    tool("dbx_rollback_transaction", "sql.session", Read, TRANSACTIONS),
    tool("dbx_close_session", "sql.session", Read, SQL_QUERY),
    tool(
        "dbx_list_tables",
        "sql.schema",
        Read,
        McpCoverage::Capability { capability: DatabaseCapability::MetadataBrowse, exclude: &[] },
    ),
    tool(
        "dbx_describe_table",
        "sql.schema",
        Read,
        McpCoverage::Capability { capability: DatabaseCapability::MetadataBrowse, exclude: &[] },
    ),
    tool(
        "dbx_list_routines",
        "sql.schema",
        Read,
        McpCoverage::Capability { capability: DatabaseCapability::ObjectSource, exclude: &[] },
    ),
    tool(
        "dbx_get_routine_source",
        "sql.schema",
        Read,
        McpCoverage::Capability { capability: DatabaseCapability::ObjectSource, exclude: &[] },
    ),
    classified("dbx_execute_redis_command", "redis", McpCoverage::Types(&[DatabaseType::Redis])),
    tool("dbx_peek_messages", "mq", Read, McpCoverage::Types(&[DatabaseType::MessageQueue])),
    tool("dbx_send_message", "mq", Write, McpCoverage::Types(&[DatabaseType::MessageQueue])),
    tool("dbx_salesforce_current_user", "salesforce", Read, McpCoverage::Types(&[DatabaseType::Salesforce])),
    // Preparing a write does not send it yet, but it is part of the DML
    // capability and is therefore gated by the same write ceiling as apply.
    tool("dbx_salesforce_prepare_write", "salesforce", Write, McpCoverage::Types(&[DatabaseType::Salesforce])),
    tool("dbx_salesforce_apply_write", "salesforce", Write, McpCoverage::Types(&[DatabaseType::Salesforce])),
    tool("dbx_nacos_list_namespaces", "nacos.config", Read, NACOS),
    tool("dbx_nacos_list_configs", "nacos.config", Read, NACOS),
    tool("dbx_nacos_search_configs", "nacos.config", Read, NACOS),
    tool("dbx_nacos_get_config", "nacos.config", Read, NACOS),
    tool("dbx_nacos_config_history", "nacos.config", Read, NACOS),
    tool("dbx_nacos_publish_config", "nacos.config", Write, NACOS),
    tool("dbx_nacos_rollback_config", "nacos.config", Write, NACOS),
    tool("dbx_nacos_delete_config", "nacos.config", Full, NACOS),
    tool("dbx_nacos_list_services", "nacos.service", Read, NACOS),
    tool("dbx_nacos_get_service", "nacos.service", Read, NACOS),
    tool("dbx_nacos_list_instances", "nacos.service", Read, NACOS),
    tool("dbx_nacos_update_instance", "nacos.service", Write, NACOS),
    tool("dbx_nacos_register_instance", "nacos.service", Write, NACOS),
    tool("dbx_nacos_deregister_instance", "nacos.service", Full, NACOS),
    tool("dbx_consul_kv_list", "consul.kv", Read, CONSUL),
    tool("dbx_consul_kv_get", "consul.kv", Read, CONSUL),
    tool("dbx_consul_kv_put", "consul.kv", Write, CONSUL),
    tool("dbx_consul_kv_delete", "consul.kv", Full, CONSUL),
    tool("dbx_consul_list_services", "consul.service", Read, CONSUL),
    tool("dbx_consul_list_nodes", "consul.service", Read, CONSUL),
    tool("dbx_consul_service_health", "consul.service", Read, CONSUL),
    tool("dbx_consul_set_maintenance", "consul.service", Write, CONSUL),
    tool(
        "dbx_open_table",
        "workbench",
        Read,
        McpCoverage::Capability { capability: DatabaseCapability::MetadataBrowse, exclude: &[] },
    ),
    classified(
        "dbx_execute_and_show",
        "workbench",
        McpCoverage::Capability { capability: DatabaseCapability::QueryExecution, exclude: &[] },
    ),
    tool("dbx_add_connection", "admin.connections", Write, McpCoverage::None),
    tool("dbx_duplicate_connection", "admin.connections", Write, McpCoverage::None),
    tool("dbx_remove_connection", "admin.connections", Full, McpCoverage::None),
    tool("dbx_plugin_list", "plugin.router", Read, McpCoverage::None),
    tool("dbx_plugin_tools", "plugin.router", Read, McpCoverage::None),
    classified("dbx_plugin_call", "plugin.router", McpCoverage::None),
];

/// Connection types the MCP server can reach at all.
fn mcp_reachable(db_type: &DatabaseType) -> bool {
    database_manifest::entry(db_type).is_some_and(|entry| entry.mcp_mode != "unsupported")
}

impl McpCoverage {
    /// Applicable connection types in manifest order; empty for `None`.
    pub fn database_types(&self) -> Vec<DatabaseType> {
        let manifest_types = || database_manifest::entries().iter().map(|entry| entry.db_type);
        match self {
            McpCoverage::None => Vec::new(),
            McpCoverage::AllConnections => manifest_types().filter(mcp_reachable).collect(),
            McpCoverage::Capability { capability, exclude } => manifest_types()
                .filter(|db_type| {
                    mcp_reachable(db_type)
                        && !exclude.contains(db_type)
                        && database_manifest::supports_capability(db_type, *capability)
                })
                .collect(),
            McpCoverage::Types(types) => types.to_vec(),
        }
    }

    fn kind(&self) -> McpCoverageKind {
        match self {
            McpCoverage::None => McpCoverageKind::None,
            McpCoverage::AllConnections => McpCoverageKind::AllConnections,
            McpCoverage::Capability { .. } => McpCoverageKind::Capability,
            McpCoverage::Types(_) => McpCoverageKind::Types,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpCoverageKind {
    None,
    AllConnections,
    Capability,
    Types,
}

/// One input argument of a tool, flattened from its JSON Schema for display.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolParameter {
    pub name: String,
    /// Display type such as `string`, `integer`, `string[]` or `latest | earliest | offset`.
    pub value_type: String,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCatalogTool {
    pub name: &'static str,
    pub access: McpAccessLevel,
    pub access_mode: McpAccessMode,
    pub coverage_kind: McpCoverageKind,
    /// Applicable connection types; empty when `coverage_kind` is `none`.
    pub database_types: Vec<DatabaseType>,
    /// Description the MCP server advertises to clients (English, for the model).
    pub description: String,
    pub parameters: Vec<McpToolParameter>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCatalogToolset {
    pub id: &'static str,
    pub provider: &'static str,
    /// Resource kinds this provider can address. This is the descriptor-level
    /// equivalent of `resource.kinds` in the capability design.
    pub resource_kinds: Vec<&'static str>,
    /// Primary scope argument kind, when the toolset has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_kind: Option<&'static str>,
    pub scope_kinds: Vec<&'static str>,
    pub tools: Vec<McpToolCatalogTool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCatalog {
    pub toolsets: Vec<McpToolCatalogToolset>,
}

/// The serializable catalog served to settings UIs. Descriptions and
/// parameters live on the MCP router, so this core view leaves them empty;
/// `dbx_mcp::DbxMcpServer::tool_catalog` fills them in with
/// [`McpToolCatalog::with_router_details`].
pub fn tool_catalog() -> McpToolCatalog {
    let toolsets = TOOLSETS
        .iter()
        .map(|toolset| McpToolCatalogToolset {
            id: toolset.id,
            provider: toolset.provider,
            resource_kinds: toolset.scope_kinds.to_vec(),
            scope_kind: toolset.scope_kinds.first().copied(),
            scope_kinds: toolset.scope_kinds.to_vec(),
            tools: TOOLS
                .iter()
                .filter(|tool| tool.toolset == toolset.id)
                .map(|tool| McpToolCatalogTool {
                    name: tool.name,
                    access: tool.access,
                    access_mode: tool.access_mode,
                    coverage_kind: tool.coverage.kind(),
                    database_types: tool.coverage.database_types(),
                    description: String::new(),
                    parameters: Vec::new(),
                })
                .collect(),
        })
        .collect();
    McpToolCatalog { toolsets }
}

impl McpToolCatalog {
    /// Fills each tool's advertised description and parameters from the
    /// router's tool definitions (`name`, `description`, `inputSchema`).
    pub fn with_router_details<'a>(
        mut self,
        router_tools: impl IntoIterator<Item = (&'a str, &'a str, &'a serde_json::Map<String, serde_json::Value>)>,
    ) -> Self {
        let details = router_tools.into_iter().collect::<Vec<_>>();
        for tool in self.toolsets.iter_mut().flat_map(|toolset| toolset.tools.iter_mut()) {
            if let Some((_, description, schema)) = details.iter().find(|(name, _, _)| *name == tool.name) {
                tool.description = append_coverage_description(description, descriptor(tool.name).map(|d| d.coverage));
                tool.parameters = schema_parameters(schema);
            }
        }
        self
    }
}

fn append_coverage_description(description: &str, coverage: Option<McpCoverage>) -> String {
    let Some(coverage) = coverage else { return description.to_string() };
    let types = coverage.database_types();
    let suffix = match coverage {
        McpCoverage::None => "Supported without a database connection.".to_string(),
        _ if types.is_empty() => "No supported database types are currently available.".to_string(),
        _ => {
            let examples = types.iter().take(3).map(|kind| human_database_type(*kind)).collect::<Vec<_>>().join(", ");
            if types.len() <= 3 {
                format!("Supported on {} database type(s): {}.", types.len(), examples)
            } else {
                format!("Supported on {} database types, including {}.", types.len(), examples)
            }
        }
    };
    format!("{} {}", description.trim_end(), suffix)
}

fn human_database_type(kind: DatabaseType) -> String {
    match kind.as_str() {
        "mysql" => "MySQL".into(),
        "postgres" => "PostgreSQL".into(),
        "sqlserver" => "SQL Server".into(),
        "sqlite" => "SQLite".into(),
        "mongodb" => "MongoDB".into(),
        "redis" => "Redis".into(),
        "nacos" => "Nacos".into(),
        "consul" => "Consul".into(),
        value => value
            .replace('_', " ")
            .split_whitespace()
            .map(|word| {
                let mut chars = word.chars();
                chars.next().map(|first| first.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// Flattens a tool input schema's top-level properties for display,
/// resolving local `#/$defs/...` references. Required arguments come first,
/// each group keeping the schema's declaration order.
pub fn schema_parameters(schema: &serde_json::Map<String, serde_json::Value>) -> Vec<McpToolParameter> {
    let Some(properties) = schema.get("properties").and_then(serde_json::Value::as_object) else {
        return Vec::new();
    };
    let required = schema
        .get("required")
        .and_then(serde_json::Value::as_array)
        .map(|items| items.iter().filter_map(serde_json::Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut parameters = properties
        .iter()
        .map(|(name, property)| McpToolParameter {
            name: name.clone(),
            value_type: schema_value_type(schema, property, 0),
            required: required.contains(&name.as_str()),
            default: property.get("default").filter(|value| !value.is_null()).cloned(),
            description: property
                .get("description")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
        .collect::<Vec<_>>();
    parameters.sort_by_key(|parameter| !parameter.required);
    parameters
}

fn schema_value_type(
    root: &serde_json::Map<String, serde_json::Value>,
    property: &serde_json::Value,
    depth: usize,
) -> String {
    if depth > 4 {
        return "any".to_string();
    }
    if let Some(reference) = property.get("$ref").and_then(serde_json::Value::as_str) {
        let resolved = reference
            .strip_prefix("#/$defs/")
            .and_then(|name| root.get("$defs").and_then(|defs| defs.get(name)))
            .or_else(|| {
                reference
                    .strip_prefix("#/definitions/")
                    .and_then(|name| root.get("definitions").and_then(|defs| defs.get(name)))
            });
        return resolved
            .map(|target| schema_value_type(root, target, depth + 1))
            .unwrap_or_else(|| "object".to_string());
    }
    if let Some(values) = property.get("enum").and_then(serde_json::Value::as_array) {
        return values
            .iter()
            .map(|value| value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()))
            .collect::<Vec<_>>()
            .join(" | ");
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(variants) = property.get(key).and_then(serde_json::Value::as_array) {
            let types = variants
                .iter()
                .filter(|variant| variant.get("type").and_then(serde_json::Value::as_str) != Some("null"))
                .map(|variant| schema_value_type(root, variant, depth + 1))
                .collect::<Vec<_>>();
            if !types.is_empty() {
                return types.join(" | ");
            }
        }
    }
    let types = match property.get("type") {
        Some(serde_json::Value::String(kind)) => vec![kind.as_str()],
        Some(serde_json::Value::Array(kinds)) => {
            kinds.iter().filter_map(serde_json::Value::as_str).filter(|kind| *kind != "null").collect()
        }
        _ => Vec::new(),
    };
    match types.as_slice() {
        ["array"] => {
            let item = property.get("items").map(|items| schema_value_type(root, items, depth + 1));
            format!("{}[]", item.unwrap_or_else(|| "any".to_string()))
        }
        [] => "any".to_string(),
        kinds => kinds.join(" | "),
    }
}

pub fn descriptor(name: &str) -> Option<&'static McpToolDescriptor> {
    TOOLS.iter().find(|tool| tool.name == name)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn every_tool_belongs_to_a_declared_toolset_and_names_are_unique() {
        let toolsets = TOOLSETS.iter().map(|toolset| toolset.id).collect::<HashSet<_>>();
        assert_eq!(toolsets.len(), TOOLSETS.len(), "toolset ids are unique");
        let mut names = HashSet::new();
        for tool in TOOLS {
            assert!(toolsets.contains(tool.toolset), "{} has an unknown toolset {}", tool.name, tool.toolset);
            assert!(names.insert(tool.name), "duplicate descriptor {}", tool.name);
            assert!(tool.name.starts_with("dbx_") && !tool.name.contains("__"), "{} is a router name", tool.name);
        }
        for toolset in TOOLSETS {
            assert!(TOOLS.iter().any(|tool| tool.toolset == toolset.id), "{} has no tools", toolset.id);
        }
    }

    #[test]
    fn coverage_follows_manifest_capabilities() {
        let routines = descriptor("dbx_get_routine_source").unwrap().coverage.database_types();
        assert!(routines.contains(&DatabaseType::Mysql));
        assert!(routines.contains(&DatabaseType::Oracle));
        assert!(!routines.contains(&DatabaseType::Sqlite));

        let query = descriptor("dbx_execute_query").unwrap().coverage.database_types();
        assert!(query.contains(&DatabaseType::Redis), "execute_query also routes Redis/Mongo commands");
        assert!(!query.contains(&DatabaseType::Nacos), "MCP-unsupported types never count");

        let batch = descriptor("dbx_execute_batch").unwrap().coverage.database_types();
        assert!(batch.contains(&DatabaseType::Postgres));
        assert!(!batch.contains(&DatabaseType::Redis) && !batch.contains(&DatabaseType::MongoDb));
        assert!(!batch.contains(&DatabaseType::Salesforce));

        assert_eq!(descriptor("dbx_begin_transaction").unwrap().coverage.database_types(), vec![DatabaseType::Mysql]);
        assert!(descriptor("dbx_add_connection").unwrap().coverage.database_types().is_empty());
    }

    #[test]
    fn schema_parameters_flatten_types_refs_and_required_order() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "partition": { "type": ["integer", "null"], "default": null },
                "start_position": { "$ref": "#/$defs/Start", "default": "latest", "description": "Where to start" },
                "topic": { "type": "string", "description": "Topic name" },
                "tables": { "type": "array", "items": { "type": "string" } },
                "arguments": {}
            },
            "required": ["topic"],
            "$defs": { "Start": { "type": "string", "enum": ["latest", "earliest"] } }
        });
        let parameters = schema_parameters(schema.as_object().unwrap());
        let summary = parameters
            .iter()
            .map(|parameter| (parameter.name.as_str(), parameter.value_type.as_str(), parameter.required))
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            [
                ("topic", "string", true),
                ("partition", "integer", false),
                ("start_position", "latest | earliest", false),
                ("tables", "string[]", false),
                ("arguments", "any", false),
            ]
        );
        assert_eq!(parameters[0].description, "Topic name");
        assert_eq!(parameters[1].default, None, "null defaults are dropped");
        assert_eq!(parameters[2].default, Some(serde_json::json!("latest")));
        assert!(schema_parameters(serde_json::json!({ "type": "object" }).as_object().unwrap()).is_empty());
    }

    #[test]
    fn catalog_serializes_for_settings_ui() {
        let catalog = serde_json::to_value(tool_catalog()).unwrap();
        let first = &catalog["toolsets"][0];
        assert_eq!(first["id"], "core.discovery");
        assert_eq!(first["resourceKinds"], serde_json::json!(["database"]));
        assert_eq!(first["scopeKind"], "database");
        assert_eq!(first["scopeKinds"], serde_json::json!(["database"]));
        assert_eq!(first["tools"][0]["name"], "dbx_list_connections");
        assert_eq!(first["tools"][0]["coverageKind"], "none");
        let query = catalog["toolsets"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|toolset| toolset["tools"].as_array().unwrap())
            .find(|tool| tool["name"] == "dbx_execute_query")
            .unwrap();
        assert_eq!(query["accessMode"], "classified");
        assert!(query["databaseTypes"].as_array().unwrap().iter().any(|value| value == "mysql"));
        assert_eq!(descriptor("dbx_salesforce_prepare_write").unwrap().access, McpAccessLevel::Write);
    }

    #[test]
    fn product_toolsets_declare_their_resource_scope_kinds() {
        let catalog = serde_json::to_value(tool_catalog()).unwrap();
        let scope_kinds = |id: &str| {
            catalog["toolsets"].as_array().unwrap().iter().find(|toolset| toolset["id"] == id).unwrap()["scopeKinds"]
                .clone()
        };
        assert_eq!(scope_kinds("redis"), serde_json::json!(["dbIndex"]));
        assert_eq!(scope_kinds("mq"), serde_json::json!(["topic", "queue"]));
        assert_eq!(scope_kinds("nacos.config"), serde_json::json!(["namespace"]));
        assert_eq!(scope_kinds("consul.kv"), serde_json::json!([]));
        assert_eq!(scope_kinds("plugin.router"), serde_json::json!([]));
    }

    #[test]
    fn router_descriptions_include_bounded_coverage_suffix() {
        let description =
            append_coverage_description("Execute a query.", descriptor("dbx_execute_query").map(|tool| tool.coverage));
        assert!(description.starts_with("Execute a query. "));
        assert!(description.contains("Supported on"));
        assert!(description.len() <= 200);
    }
}
