use std::collections::HashMap;

use crate::models::connection::ConnectionConfig;
use crate::production_safety::sql_references_disallowed_database;
use crate::storage::McpGlobalPolicy;
use serde::Deserialize;
use serde_json::Value;

/// Version used by rules that opt into scoped override semantics.
pub const MCP_EXECUTION_POLICY_VERSION: u8 = 1;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct McpConnectionGroupPath {
    pub ids: Vec<String>,
    pub names: Vec<String>,
}

#[derive(Deserialize)]
struct SidebarLayout {
    #[serde(default)]
    groups: Vec<SidebarGroup>,
    #[serde(default)]
    order: Vec<SidebarOrderEntry>,
}

#[derive(Deserialize)]
struct SidebarGroup {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum SidebarOrderEntry {
    #[serde(rename = "group")]
    Group {
        id: String,
        children: Option<Vec<SidebarOrderEntry>>,
        #[serde(rename = "connectionIds")]
        connection_ids: Option<Vec<String>>,
    },
    #[serde(rename = "connection")]
    Connection { id: String },
}

/// Resolve each connection's stable group ids and display names from the
/// persisted sidebar tree. Legacy `connectionIds` group entries remain valid.
pub fn connection_group_paths(layout: &Value) -> Result<HashMap<String, McpConnectionGroupPath>, String> {
    let layout = serde_json::from_value::<SidebarLayout>(layout.clone())
        .map_err(|error| format!("INVALID_SIDEBAR_LAYOUT: {error}"))?;
    let groups = layout.groups.into_iter().map(|group| (group.id, group.name)).collect::<HashMap<_, _>>();
    let mut paths = HashMap::new();
    collect_connection_group_paths(&layout.order, &groups, &mut McpConnectionGroupPath::default(), &mut paths)?;
    Ok(paths)
}

fn collect_connection_group_paths(
    entries: &[SidebarOrderEntry],
    groups: &HashMap<String, String>,
    path: &mut McpConnectionGroupPath,
    paths: &mut HashMap<String, McpConnectionGroupPath>,
) -> Result<(), String> {
    for entry in entries {
        match entry {
            SidebarOrderEntry::Connection { id } => {
                insert_connection_group_path(paths, id, path)?;
            }
            SidebarOrderEntry::Group { id, children, connection_ids } => {
                let name =
                    groups.get(id).ok_or_else(|| format!("INVALID_SIDEBAR_LAYOUT: group '{id}' has no metadata"))?;
                path.ids.push(id.clone());
                path.names.push(name.clone());
                if let Some(children) = children {
                    collect_connection_group_paths(children, groups, path, paths)?;
                } else if let Some(connection_ids) = connection_ids {
                    for connection_id in connection_ids {
                        insert_connection_group_path(paths, connection_id, path)?;
                    }
                }
                path.ids.pop();
                path.names.pop();
            }
        }
    }
    Ok(())
}

fn insert_connection_group_path(
    paths: &mut HashMap<String, McpConnectionGroupPath>,
    connection_id: &str,
    path: &McpConnectionGroupPath,
) -> Result<(), String> {
    if paths.insert(connection_id.to_string(), path.clone()).is_some() {
        return Err(format!("INVALID_SIDEBAR_LAYOUT: connection '{connection_id}' appears more than once"));
    }
    Ok(())
}

pub fn policy_uses_connection_groups(policy: &McpGlobalPolicy) -> bool {
    !policy.allowed_group_ids.is_empty()
        || !policy.group_policies.is_empty()
        || !policy.result_protection.group_overrides.is_empty()
}

pub fn policy_allows_connection(
    policy: &McpGlobalPolicy,
    group_path: Option<&McpConnectionGroupPath>,
    connection_id: &str,
) -> bool {
    policy.allowed_connection_ids.as_ref().is_none_or(|allowed| {
        allowed.iter().any(|id| id == connection_id)
            || group_path.is_some_and(|path| {
                path.ids.iter().any(|id| policy.allowed_group_ids.iter().any(|allowed| allowed == id))
            })
    })
}

/// Resolve an omitted or blank request database to the connection default.
pub fn resolve_database(requested: &str, configured: Option<&str>) -> String {
    let requested = requested.trim();
    if requested.is_empty() {
        configured.unwrap_or_default().trim().to_string()
    } else {
        requested.to_string()
    }
}

/// Compute the effective execution mode while preserving legacy rule ceilings.
/// Rules without the current version marker are never allowed to widen the
/// global policy, including when they contain fields added by a newer client.
pub fn effective_database_execution_policy(
    policy: &McpGlobalPolicy,
    connection_id: &str,
    database: &str,
) -> (bool, bool) {
    effective_database_execution_policy_with_groups(policy, &[], connection_id, database)
}

pub fn effective_database_execution_policy_with_groups(
    policy: &McpGlobalPolicy,
    group_ids: &[String],
    connection_id: &str,
    database: &str,
) -> (bool, bool) {
    let mut effective = (policy.read_only, policy.allow_dangerous_sql);
    for group_id in group_ids {
        if let Some(rule) = policy.group_policies.iter().find(|rule| rule.group_id == *group_id) {
            effective = (rule.read_only, !rule.read_only && rule.allow_dangerous_sql);
        }
    }
    let Some(rule) = policy.connection_policies.iter().find(|rule| rule.connection_id == connection_id) else {
        return effective;
    };

    if rule.execution_mode_policy_version == Some(MCP_EXECUTION_POLICY_VERSION) {
        if rule.execution_mode_configured {
            effective = (rule.read_only, !rule.read_only && rule.allow_dangerous_sql);
        }
        if let Some(database_policy) = rule.database_policies.iter().find(|rule| rule.database_name == database) {
            effective = (database_policy.read_only, !database_policy.read_only && database_policy.allow_dangerous_sql);
        }
    } else {
        // Legacy rules only carried a ceiling when the old UI had configured
        // an execution mode; scope-only rules inherited the global mode
        // untouched and must keep doing so instead of being narrowed by the
        // implicit (false, false) ceiling.
        if rule.execution_mode_configured {
            effective = apply_ceiling(effective, (rule.read_only, rule.allow_dangerous_sql));
        }
        if let Some(database_policy) = rule.database_policies.iter().find(|rule| rule.database_name == database) {
            effective = apply_ceiling(effective, (database_policy.read_only, database_policy.allow_dangerous_sql));
        }
    }
    effective
}

fn apply_ceiling(current: (bool, bool), ceiling: (bool, bool)) -> (bool, bool) {
    let read_only = current.0 || ceiling.0;
    (read_only, !read_only && current.1 && ceiling.1)
}

/// Reject qualified SQL references when database-specific execution rules are
/// present and individual referenced databases have not been evaluated.
pub fn ensure_sql_database_execution_scope(
    policy: &McpGlobalPolicy,
    connection: &ConnectionConfig,
    active_database: &str,
    sql: &str,
) -> Result<(), String> {
    if policy.result_protection.has_database_overrides(&connection.id)
        && (crate::sql_risk::mcp_sql_has_forbidden_database_switch(sql, connection.db_type)
            || crate::mcp_result_protection::query_has_unbound_database(sql, connection.db_type, active_database)
            || sql_references_disallowed_database(
                sql,
                &connection.db_type,
                active_database,
                &[active_database.to_string()],
            ))
    {
        return Err(crate::mcp_result_protection::SOURCE_UNRESOLVED.to_string());
    }
    let Some(rule) = policy.connection_policies.iter().find(|rule| rule.connection_id == connection.id) else {
        return Ok(());
    };
    if rule.database_policies.is_empty()
        || !sql_references_disallowed_database(
            sql,
            &connection.db_type,
            active_database,
            &[active_database.to_string()],
        )
    {
        return Ok(());
    }
    Err(
        "DATABASE_EXECUTION_POLICY_OUT_OF_SCOPE: SQL cannot reference another database while database-specific MCP execution permissions are configured."
            .to_string(),
    )
}

/// Return databases targeted by MongoDB `$out` and `$merge` stages.
pub fn mongo_pipeline_output_databases(pipeline_json: &str, active_database: &str) -> Result<Vec<String>, String> {
    let stages = serde_json::from_str::<serde_json::Value>(pipeline_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .ok_or_else(|| "QUERY_ERROR: MongoDB aggregate pipeline must be a JSON array.".to_string())?;
    let mut databases = Vec::new();
    for stage in stages {
        let Some(stage) = stage.as_object() else { continue };
        for key in ["$out", "$merge"] {
            let Some(target) = stage.get(key) else { continue };
            let database = match target {
                serde_json::Value::String(_) => active_database.to_string(),
                serde_json::Value::Object(target) => target
                    .get("db")
                    .or_else(|| {
                        target.get("into").and_then(serde_json::Value::as_object).and_then(|into| into.get("db"))
                    })
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(active_database)
                    .to_string(),
                _ => return Err("QUERY_ERROR: MongoDB aggregate output target must be a string or object.".to_string()),
            };
            databases.push(database);
        }
    }
    Ok(databases)
}

/// Reject cross-database MongoDB writes while database-specific rules exist.
pub fn ensure_mongo_database_execution_scope(
    policy: &McpGlobalPolicy,
    connection_id: &str,
    active_database: &str,
    pipeline_json: &str,
) -> Result<(), String> {
    let has_database_policies = policy
        .connection_policies
        .iter()
        .find(|rule| rule.connection_id == connection_id)
        .is_some_and(|rule| !rule.database_policies.is_empty());
    if !has_database_policies {
        return Ok(());
    }
    if mongo_pipeline_output_databases(pipeline_json, active_database)?
        .into_iter()
        .any(|database| database != active_database)
    {
        return Err(
            "DATABASE_EXECUTION_POLICY_OUT_OF_SCOPE: MongoDB aggregation cannot target another database while database-specific MCP execution permissions are configured."
                .to_string(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        connection_group_paths, effective_database_execution_policy, resolve_database, MCP_EXECUTION_POLICY_VERSION,
    };
    use crate::storage::{McpConnectionPolicy, McpDatabasePolicy, McpGlobalPolicy};
    use serde_json::json;

    fn policy(version: Option<u8>) -> McpGlobalPolicy {
        McpGlobalPolicy {
            read_only: true,
            connection_policies: vec![McpConnectionPolicy {
                connection_id: "conn".to_string(),
                read_only: false,
                allow_dangerous_sql: false,
                execution_mode_configured: true,
                execution_mode_policy_version: version,
                database_scope: Default::default(),
                allowed_databases: Vec::new(),
                database_policies: vec![McpDatabasePolicy {
                    database_name: "db".to_string(),
                    read_only: false,
                    allow_dangerous_sql: true,
                }],
            }],
            ..Default::default()
        }
    }

    #[test]
    fn legacy_rules_cannot_widen_global_read_only() {
        assert_eq!(effective_database_execution_policy(&policy(None), "conn", "db"), (true, false));
    }

    #[test]
    fn current_rules_use_database_override() {
        assert_eq!(
            effective_database_execution_policy(&policy(Some(MCP_EXECUTION_POLICY_VERSION)), "conn", "db"),
            (false, true)
        );
    }

    #[test]
    fn legacy_connection_ceiling_is_preserved_for_safe_write_rule() {
        let mut policy = policy(None);
        policy.read_only = false;
        policy.allow_dangerous_sql = true;
        policy.connection_policies[0].allow_dangerous_sql = false;
        policy.connection_policies[0].database_policies.clear();
        assert_eq!(effective_database_execution_policy(&policy, "conn", "db"), (false, false));
    }

    #[test]
    fn legacy_scope_only_rules_inherit_global_mode() {
        let mut policy = policy(None);
        policy.read_only = false;
        policy.allow_dangerous_sql = true;
        policy.connection_policies[0].execution_mode_configured = false;
        policy.connection_policies[0].database_policies.clear();
        // Old-UI scope-only rules (configured=false, no mode saved) inherited
        // the global mode verbatim; the implicit (false, false) values must
        // not narrow allow_dangerous_sql on upgrade.
        assert_eq!(effective_database_execution_policy(&policy, "conn", "db"), (false, true));
    }

    #[test]
    fn blank_database_uses_connection_default() {
        assert_eq!(resolve_database("  ", Some("sample")), "sample");
        assert_eq!(resolve_database("analytics", Some("sample")), "analytics");
    }

    #[test]
    fn duplicate_sidebar_connection_membership_fails_closed() {
        let layout = json!({
            "groups": [
                { "id": "production", "name": "Production" },
                { "id": "testing", "name": "Testing" }
            ],
            "order": [
                { "type": "group", "id": "production", "connectionIds": ["conn"] },
                { "type": "group", "id": "testing", "connectionIds": ["conn"] }
            ]
        });
        let error = connection_group_paths(&layout).unwrap_err();
        assert!(error.starts_with("INVALID_SIDEBAR_LAYOUT:"));
        assert!(error.contains("conn"));
    }
}
