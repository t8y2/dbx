use crate::models::connection::ConnectionConfig;
use crate::production_safety::sql_references_disallowed_database;
use crate::storage::McpGlobalPolicy;

/// Version used by rules that opt into scoped override semantics.
pub const MCP_EXECUTION_POLICY_VERSION: u8 = 1;

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
    let mut effective = (policy.read_only, policy.allow_dangerous_sql);
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
    use super::{effective_database_execution_policy, resolve_database, MCP_EXECUTION_POLICY_VERSION};
    use crate::storage::{McpConnectionPolicy, McpDatabasePolicy, McpGlobalPolicy};

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
}
