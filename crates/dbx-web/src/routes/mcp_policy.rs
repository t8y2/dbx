use std::{collections::HashMap, sync::Arc};

use axum::http::HeaderMap;
use dbx_core::mcp_policy::McpConnectionGroupPath;
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::storage::{McpDatabaseScope, McpGlobalPolicy};

use crate::error::AppError;
use crate::state::WebState;

const MCP_REQUEST_HEADER: &str = "x-dbx-mcp-request";

pub fn is_mcp_request(headers: &HeaderMap) -> bool {
    headers.get(MCP_REQUEST_HEADER).and_then(|value| value.to_str().ok()) == Some("1")
}

pub fn mongo_pipeline_has_write_stage(pipeline_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(pipeline_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .is_some_and(|stages| {
            stages.iter().any(|stage| {
                stage
                    .as_object()
                    .is_some_and(|document| document.contains_key("$out") || document.contains_key("$merge"))
            })
        })
}

pub fn mongo_filter_is_effectively_unbounded(filter_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(filter_json)
        .ok()
        .as_ref()
        .is_none_or(|value| mongo_filter_contains_opaque_logic(value) || mongo_filter_value_is_unbounded(value))
}

fn mongo_filter_contains_opaque_logic(value: &serde_json::Value) -> bool {
    let Some(filter) = value.as_object() else {
        return true;
    };
    filter.iter().any(|(key, value)| match key.as_str() {
        "$comment" => false,
        "$where" | "$expr" | "$nor" => true,
        "$and" | "$or" => {
            let Some(clauses) = value.as_array() else {
                return true;
            };
            clauses.is_empty()
                || clauses.iter().any(|clause| !clause.is_object() || mongo_filter_contains_opaque_logic(clause))
                || (key == "$or"
                    && clauses
                        .iter()
                        .any(|clause| clause.as_object().is_some_and(|document| document.contains_key("$and"))))
                || (key == "$or" && mongo_or_has_complementary_field_clauses(clauses))
        }
        _ => key.starts_with('$') || mongo_field_predicate_contains_opaque_logic(value),
    })
}

fn mongo_field_predicate_contains_opaque_logic(value: &serde_json::Value) -> bool {
    let Some(predicate) = value.as_object() else {
        return false;
    };
    if mongo_extended_json_scalar_literal_is_valid(value) {
        return false;
    }
    let has_operator = predicate.keys().any(|key| key.starts_with('$'));
    has_operator
        && predicate.keys().any(|key| {
            !matches!(key.as_str(), "$eq" | "$ne" | "$gt" | "$gte" | "$lt" | "$lte" | "$in" | "$nin" | "$exists")
        })
}

fn mongo_extended_json_scalar_literal_is_valid(value: &serde_json::Value) -> bool {
    let Some(wrapper) = value.as_object().filter(|wrapper| wrapper.len() == 1) else {
        return false;
    };
    if let Some(value) = wrapper.get("$oid").and_then(serde_json::Value::as_str) {
        return value.len() == 24 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    }
    if let Some(value) = wrapper.get("$numberLong").and_then(serde_json::Value::as_str) {
        return value.parse::<i64>().is_ok();
    }
    wrapper
        .get("$date")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MongoFieldOperator {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    In,
    Nin,
    Exists,
}

struct MongoPureFieldPredicate<'a> {
    field: &'a str,
    operator: MongoFieldOperator,
    operand: &'a serde_json::Value,
}

fn mongo_or_has_complementary_field_clauses(clauses: &[serde_json::Value]) -> bool {
    clauses.iter().enumerate().any(|(index, clause)| {
        let Some(predicate) = mongo_pure_field_predicate(clause) else {
            return false;
        };
        clauses[index + 1..]
            .iter()
            .filter_map(mongo_pure_field_predicate)
            .any(|other| mongo_field_predicates_are_complementary(&predicate, &other))
    })
}

fn mongo_pure_field_predicate(value: &serde_json::Value) -> Option<MongoPureFieldPredicate<'_>> {
    let filter = value.as_object()?;
    let mut entries = filter.iter().filter(|(key, _)| key.as_str() != "$comment");
    let (field, predicate) = entries.next()?;
    if entries.next().is_some() {
        return None;
    }
    if field == "$and" {
        let clauses = predicate.as_array()?;
        let mut bounded = clauses.iter().filter(|clause| !mongo_filter_value_is_unbounded(clause));
        let clause = bounded.next()?;
        if bounded.next().is_some() {
            return None;
        }
        return mongo_pure_field_predicate(clause);
    }
    if field == "$or" {
        let clauses = predicate.as_array()?;
        return (clauses.len() == 1).then(|| mongo_pure_field_predicate(&clauses[0])).flatten();
    }
    if field.starts_with('$') {
        return None;
    }
    let Some(operator_document) = predicate.as_object() else {
        return Some(MongoPureFieldPredicate { field, operator: MongoFieldOperator::Eq, operand: predicate });
    };
    if mongo_extended_json_scalar_literal_is_valid(predicate)
        || !operator_document.keys().any(|key| key.starts_with('$'))
    {
        return Some(MongoPureFieldPredicate { field, operator: MongoFieldOperator::Eq, operand: predicate });
    }
    let mut operators = operator_document.iter();
    let (operator, operand) = operators.next()?;
    if operators.next().is_some() {
        return None;
    }
    let operator = match operator.as_str() {
        "$eq" => MongoFieldOperator::Eq,
        "$ne" => MongoFieldOperator::Ne,
        "$gt" => MongoFieldOperator::Gt,
        "$gte" => MongoFieldOperator::Gte,
        "$lt" => MongoFieldOperator::Lt,
        "$lte" => MongoFieldOperator::Lte,
        "$in" => MongoFieldOperator::In,
        "$nin" => MongoFieldOperator::Nin,
        "$exists" => MongoFieldOperator::Exists,
        _ => return None,
    };
    Some(MongoPureFieldPredicate { field, operator, operand })
}

fn mongo_field_predicates_are_complementary(
    left: &MongoPureFieldPredicate<'_>,
    right: &MongoPureFieldPredicate<'_>,
) -> bool {
    if left.field != right.field {
        return false;
    }
    use MongoFieldOperator::{Eq, Exists, Gt, Gte, In, Lt, Lte, Ne, Nin};
    match (left.operator, right.operator) {
        (Exists, Exists) => {
            left.operand.as_bool().zip(right.operand.as_bool()).is_some_and(|(left, right)| left != right)
        }
        (In, Nin) | (Nin, In) => mongo_json_sets_equal(left.operand, right.operand),
        (Eq, Ne) | (Ne, Eq) | (Gt, Lte) | (Lte, Gt) | (Gte, Lt) | (Lt, Gte) => left.operand == right.operand,
        _ => false,
    }
}

fn mongo_json_sets_equal(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    let (Some(left), Some(right)) = (left.as_array(), right.as_array()) else {
        return false;
    };
    left.iter().all(|value| right.contains(value)) && right.iter().all(|value| left.contains(value))
}

fn mongo_filter_value_is_unbounded(value: &serde_json::Value) -> bool {
    let Some(filter) = value.as_object() else {
        return true;
    };
    if filter.is_empty() || filter.contains_key("$where") || filter.contains_key("$expr") {
        return true;
    }
    filter.iter().all(|(key, value)| match key.as_str() {
        "$comment" => true,
        "$and" => value
            .as_array()
            .is_none_or(|clauses| clauses.is_empty() || clauses.iter().all(mongo_filter_value_is_unbounded)),
        "$or" => value
            .as_array()
            .is_none_or(|clauses| clauses.is_empty() || clauses.iter().any(mongo_filter_value_is_unbounded)),
        "$nor" => true,
        _ if mongo_field_predicate_is_empty_nin(value) => true,
        "_id" if mongo_field_predicate_is_exists_true(value) => true,
        _ => key.starts_with('$'),
    })
}

fn mongo_field_predicate_is_empty_nin(value: &serde_json::Value) -> bool {
    value.as_object().is_some_and(|predicate| {
        predicate.len() == 1 && predicate.get("$nin").and_then(serde_json::Value::as_array).is_some_and(Vec::is_empty)
    })
}

fn mongo_field_predicate_is_exists_true(value: &serde_json::Value) -> bool {
    value.as_object().is_some_and(|predicate| {
        predicate.len() == 1 && predicate.get("$exists").and_then(serde_json::Value::as_bool) == Some(true)
    })
}

async fn load_policy(state: &Arc<WebState>) -> Result<McpGlobalPolicy, AppError> {
    state.app.storage.load_mcp_global_policy().await.map(|state| state.policy()).map_err(AppError::from)
}

async fn load_policy_context(
    state: &Arc<WebState>,
) -> Result<(McpGlobalPolicy, HashMap<String, McpConnectionGroupPath>), AppError> {
    let policy = load_policy(state).await?;
    let group_paths = match state.app.storage.load_sidebar_layout().await {
        Ok(Some(layout)) => dbx_core::mcp_policy::connection_group_paths(&layout),
        Ok(None) => Ok(HashMap::new()),
        Err(error) => Err(error),
    };
    match group_paths {
        Ok(paths) => Ok((policy, paths)),
        Err(error) if dbx_core::mcp_policy::policy_uses_connection_groups(&policy) => {
            Err(AppError::from(format!("MCP_POLICY_UNAVAILABLE: {error}")))
        }
        Err(_) => Ok((policy, HashMap::new())),
    }
}

fn ensure_allowed(
    policy: &McpGlobalPolicy,
    group_path: Option<&McpConnectionGroupPath>,
    connection_id: &str,
) -> Result<(), AppError> {
    if !dbx_core::mcp_policy::policy_allows_connection(policy, group_path, connection_id) {
        return Err(AppError::from(format!(
            "CONNECTION_OUT_OF_SCOPE: connection '{connection_id}' is not allowed by DBX MCP settings"
        )));
    }
    Ok(())
}

fn ensure_database_in_scope(policy: &McpGlobalPolicy, connection_id: &str, database: &str) -> Result<(), AppError> {
    let Some(rule) = policy.connection_policies.iter().find(|rule| rule.connection_id == connection_id) else {
        return Ok(());
    };
    match rule.database_scope {
        McpDatabaseScope::All => Ok(()),
        McpDatabaseScope::None => Err(AppError::from(format!(
            "DATABASE_OUT_OF_SCOPE: database '{database}' is not allowed by DBX MCP settings for connection '{connection_id}'"
        ))),
        McpDatabaseScope::Selected if rule.allowed_databases.iter().any(|allowed| allowed == database) => Ok(()),
        McpDatabaseScope::Selected => Err(AppError::from(format!(
            "DATABASE_OUT_OF_SCOPE: database '{database}' is not allowed by DBX MCP settings for connection '{connection_id}'"
        ))),
    }
}

/// Execution modes are scoped defaults: a database setting overrides a
/// configured connection default, then the nearest configured group and the
/// global default.
/// Connection read-only and production protections are checked separately.
fn effective_database_execution_policy(policy: &McpGlobalPolicy, connection_id: &str, database: &str) -> (bool, bool) {
    effective_database_execution_policy_with_groups(policy, &[], connection_id, database)
}

fn effective_database_execution_policy_with_groups(
    policy: &McpGlobalPolicy,
    group_ids: &[String],
    connection_id: &str,
    database: &str,
) -> (bool, bool) {
    dbx_core::mcp_policy::effective_database_execution_policy_with_groups(policy, group_ids, connection_id, database)
}

fn ensure_sql_database_execution_scope(
    policy: &McpGlobalPolicy,
    connection: &ConnectionConfig,
    active_database: &str,
    sql: &str,
) -> Result<(), AppError> {
    dbx_core::mcp_policy::ensure_sql_database_execution_scope(policy, connection, active_database, sql)
        .map_err(AppError::from)
}

fn mongo_pipeline_output_databases(pipeline_json: &str, active_database: &str) -> Result<Vec<String>, AppError> {
    dbx_core::mcp_policy::mongo_pipeline_output_databases(pipeline_json, active_database).map_err(AppError::from)
}

fn ensure_mongo_database_execution_scope(
    policy: &McpGlobalPolicy,
    connection_id: &str,
    active_database: &str,
    pipeline_json: &str,
) -> Result<(), AppError> {
    dbx_core::mcp_policy::ensure_mongo_database_execution_scope(policy, connection_id, active_database, pipeline_json)
        .map_err(AppError::from)
}

fn connection_read_only_error(message: impl Into<String>) -> AppError {
    AppError::from(format!("CONNECTION_READ_ONLY: {}", message.into()))
}

async fn load_connection(state: &Arc<WebState>, connection_id: &str) -> Result<ConnectionConfig, AppError> {
    state
        .app
        .storage
        .load_connections()
        .await
        .map_err(AppError::from)?
        .into_iter()
        .find(|config| config.id == connection_id)
        .ok_or_else(|| AppError::from(format!("Connection with id '{connection_id}' not found")))
}

pub async fn resolve_database(
    state: &Arc<WebState>,
    headers: &HeaderMap,
    connection_id: &str,
    database: &str,
) -> Result<String, AppError> {
    if !is_mcp_request(headers) {
        return Ok(database.to_string());
    }
    let config = load_connection(state, connection_id).await?;
    Ok(dbx_core::mcp_policy::resolve_database(database, config.database.as_deref()))
}

pub async fn ensure_scope(state: &Arc<WebState>, headers: &HeaderMap, connection_id: &str) -> Result<(), AppError> {
    if !is_mcp_request(headers) {
        return Ok(());
    }
    let (policy, group_paths) = load_policy_context(state).await?;
    ensure_allowed(&policy, group_paths.get(connection_id), connection_id)
}

pub async fn ensure_write(
    state: &Arc<WebState>,
    headers: &HeaderMap,
    connection_id: &str,
    database: &str,
    action: &str,
) -> Result<(), AppError> {
    ensure_write_with_risk(state, headers, connection_id, database, action, false).await
}

pub async fn ensure_dangerous_write(
    state: &Arc<WebState>,
    headers: &HeaderMap,
    connection_id: &str,
    database: &str,
    action: &str,
) -> Result<(), AppError> {
    ensure_write_with_risk(state, headers, connection_id, database, action, true).await
}

pub async fn ensure_mongo_pipeline_target(
    state: &Arc<WebState>,
    headers: &HeaderMap,
    connection_id: &str,
    database: &str,
    pipeline_json: &str,
) -> Result<String, AppError> {
    if !is_mcp_request(headers) {
        return Ok(database.to_string());
    }
    let (policy, group_paths) = load_policy_context(state).await?;
    let group_path = group_paths.get(connection_id);
    ensure_allowed(&policy, group_path, connection_id)?;
    let config = load_connection(state, connection_id).await?;
    let database = dbx_core::mcp_policy::resolve_database(database, config.database.as_deref());
    ensure_database_in_scope(&policy, connection_id, &database)?;
    for target_database in mongo_pipeline_output_databases(pipeline_json, &database)? {
        ensure_database_in_scope(&policy, connection_id, &target_database)?;
    }
    ensure_mongo_database_execution_scope(&policy, connection_id, &database, pipeline_json)?;
    if dbx_core::production_safety::mongo_pipeline_targets_production_database(&config, &database, pipeline_json) {
        return Err(AppError::from(
            "PRODUCTION_DATABASE_READ_ONLY: MongoDB aggregate write targeting production scope is blocked.".to_string(),
        ));
    }
    Ok(database)
}

async fn ensure_write_with_risk(
    state: &Arc<WebState>,
    headers: &HeaderMap,
    connection_id: &str,
    database: &str,
    action: &str,
    dangerous: bool,
) -> Result<(), AppError> {
    if !is_mcp_request(headers) {
        return Ok(());
    }
    let (policy, group_paths) = load_policy_context(state).await?;
    let group_path = group_paths.get(connection_id);
    ensure_allowed(&policy, group_path, connection_id)?;
    let config = load_connection(state, connection_id).await?;
    let database = dbx_core::mcp_policy::resolve_database(database, config.database.as_deref());
    ensure_database_in_scope(&policy, connection_id, &database)?;
    let group_ids = group_path.map(|path| path.ids.as_slice()).unwrap_or_default();
    let (read_only, allow_dangerous_sql) =
        effective_database_execution_policy_with_groups(&policy, group_ids, connection_id, &database);
    if read_only {
        return Err(AppError::from(format!(
            "MCP_READ_ONLY: MCP execution permission for database '{database}' is read-only. {action} blocked."
        )));
    }
    if dangerous && !allow_dangerous_sql {
        return Err(AppError::from(format!(
            "SQL_BLOCKED: High-risk operation '{action}' is disabled in DBX MCP settings."
        )));
    }
    if config.read_only {
        return Err(connection_read_only_error(format!(
            "Connection '{}' has read-only protection enabled. {action} blocked.",
            config.name
        )));
    }
    if dbx_core::production_safety::is_production_database(&config, &database) {
        return Err(AppError::from(format!(
            "PRODUCTION_DATABASE_READ_ONLY: {action} blocked for production database '{database}'."
        )));
    }
    Ok(())
}

pub async fn ensure_sql(
    state: &Arc<WebState>,
    headers: &HeaderMap,
    connection_id: &str,
    database: &str,
    sql: &str,
    allow_database_switch: bool,
) -> Result<String, AppError> {
    if !is_mcp_request(headers) {
        return Ok(database.to_string());
    }
    let (policy, group_paths) = load_policy_context(state).await?;
    let group_path = group_paths.get(connection_id);
    ensure_allowed(&policy, group_path, connection_id)?;
    let config = load_connection(state, connection_id).await?;
    let database = dbx_core::mcp_policy::resolve_database(database, config.database.as_deref());
    ensure_database_in_scope(&policy, connection_id, &database)?;
    if !allow_database_switch && dbx_core::sql_risk::mcp_sql_has_forbidden_database_switch(sql, config.db_type) {
        return Err(AppError::from(
            "SQL_BLOCKED: MCP does not allow USE or persistent database switching.".to_string(),
        ));
    }
    let is_write = dbx_core::query_execution_sql::is_write_sql_for_database(sql, config.db_type);
    ensure_sql_database_execution_scope(&policy, &config, &database, sql)?;
    let group_ids = group_path.map(|path| path.ids.as_slice()).unwrap_or_default();
    let (read_only, allow_dangerous_sql) =
        effective_database_execution_policy_with_groups(&policy, group_ids, connection_id, &database);
    if read_only && is_write {
        return Err(AppError::from(format!(
            "MCP_READ_ONLY: MCP execution permission for database '{database}' is read-only. SQL write blocked."
        )));
    }
    if !allow_dangerous_sql && dbx_core::sql_risk::is_dangerous_sql_for_database(sql, config.db_type) {
        return Err(AppError::from("SQL_BLOCKED: High-risk SQL is disabled in DBX MCP settings.".to_string()));
    }
    if config.read_only {
        dbx_core::query_execution_sql::check_read_only(sql, &config.name, config.db_type)
            .map_err(connection_read_only_error)?;
    }
    if is_write && dbx_core::production_safety::targets_production_database(&config, &database, sql) {
        return Err(AppError::from(
            "PRODUCTION_DATABASE_READ_ONLY: SQL write targeting production scope is blocked.".to_string(),
        ));
    }
    Ok(database)
}

#[cfg(test)]
mod tests {
    use super::{
        connection_read_only_error, effective_database_execution_policy, ensure_mongo_database_execution_scope,
        mongo_filter_is_effectively_unbounded, mongo_pipeline_has_write_stage,
    };
    use dbx_core::storage::{McpConnectionPolicy, McpDatabasePolicy, McpDatabaseScope, McpGlobalPolicy};

    fn database_policy() -> McpGlobalPolicy {
        McpGlobalPolicy {
            read_only: true,
            allow_dangerous_sql: false,
            connection_policies: vec![McpConnectionPolicy {
                connection_id: "conn-1".to_string(),
                read_only: true,
                allow_dangerous_sql: false,
                execution_mode_configured: true,
                execution_mode_policy_version: Some(dbx_core::mcp_policy::MCP_EXECUTION_POLICY_VERSION),
                database_scope: McpDatabaseScope::Selected,
                allowed_databases: vec!["operations".to_string(), "reporting".to_string()],
                database_policies: vec![McpDatabasePolicy {
                    database_name: "operations".to_string(),
                    read_only: false,
                    allow_dangerous_sql: true,
                }],
            }],
            ..Default::default()
        }
    }

    #[test]
    fn database_execution_policy_overrides_global_and_connection_defaults() {
        let policy = database_policy();

        assert_eq!(effective_database_execution_policy(&policy, "conn-1", "operations"), (false, true));
        assert_eq!(effective_database_execution_policy(&policy, "conn-1", "reporting"), (true, false));
    }

    #[test]
    fn database_execution_policy_blocks_cross_database_mongo_aggregate_output() {
        let policy = database_policy();

        assert!(
            ensure_mongo_database_execution_scope(&policy, "conn-1", "operations", r#"[{"$out":"archive"}]"#,).is_ok()
        );
        let error = ensure_mongo_database_execution_scope(
            &policy,
            "conn-1",
            "operations",
            r#"[{"$merge":{"into":{"db":"reporting","coll":"archive"}}}]"#,
        )
        .unwrap_err();
        assert!(error.message.starts_with("DATABASE_EXECUTION_POLICY_OUT_OF_SCOPE:"), "{}", error.message);
    }

    #[test]
    fn connection_read_only_errors_use_the_stable_mcp_code() {
        assert_eq!(connection_read_only_error("write blocked").message, "CONNECTION_READ_ONLY: write blocked");
    }

    #[test]
    fn detects_only_top_level_aggregate_write_stages() {
        assert!(mongo_pipeline_has_write_stage(r#"[{"$out":"archive"}]"#));
        assert!(mongo_pipeline_has_write_stage(r#"[{"$merge":{"into":"archive"}}]"#));
        assert!(!mongo_pipeline_has_write_stage(r#"[{"$project":{"value":"$out"}}]"#));
        assert!(!mongo_pipeline_has_write_stage("not-json"));
    }

    #[test]
    fn detects_effectively_unbounded_mongo_filters() {
        for filter in [
            "{}",
            r#"{"$comment":"all rows"}"#,
            r#"{"$expr":true}"#,
            r#"{"$or":[{}, {"id":1}]}"#,
            r#"{"$nor":[{"$expr":false}]}"#,
            r#"{"$or":[{"id":{"$exists":true}},{"id":{"$exists":false}}]}"#,
            r#"{"$or":[{"id":{"$exists":true}},{"id":{"$not":{"$exists":true}}}]}"#,
            r#"{"$or":[{"id":{"$eq":1}},{"id":{"$ne":1}}]}"#,
            r#"{"$or":[{"$and":[{"id":{"$eq":1}}]},{"id":{"$ne":1}}]}"#,
            r#"{"$or":[{"$and":[{"id":{"$eq":1}},{}]},{"id":{"$ne":1}}]}"#,
            r#"{"$or":[{"$and":[{"id":{"$eq":1}},{"x":{"$exists":true}}]},{"id":{"$ne":1}},{"x":{"$exists":false}}]}"#,
            r#"{"$or":[{"id":1},{"id":{"$ne":1}}]}"#,
            r#"{"$or":[{"id":{"$gt":1}},{"id":{"$lte":1}}]}"#,
            r#"{"$or":[{"id":{"$gte":1}},{"id":{"$lt":1}}]}"#,
            r#"{"$or":[{"id":{"$in":[1,2]}},{"id":{"$nin":[2,1]}}]}"#,
            r#"{"_id":{"$exists":true}}"#,
            r#"{"id":{"$nin":[]}}"#,
            r#"{"_id":{"$oid":"not-an-object-id"}}"#,
            r#"{"sequence":{"$numberLong":"9223372036854775808"}}"#,
            r#"{"created_at":{"$date":"2026-02-30T00:00:00Z"}}"#,
            r#"{"name":{"$regex":".*"}}"#,
            r#"{"$or":[{"_id":{"$oid":"507f1f77bcf86cd799439011"}},{"_id":{"$ne":{"$oid":"507f1f77bcf86cd799439011"}}}]}"#,
            r#"{"$and":[{"tenant_id":1},{"$nor":[{"archived":true}]}]}"#,
            r#"{"$or":[]}"#,
            r#"{"$opaque":[{"id":1}]}"#,
        ] {
            assert!(mongo_filter_is_effectively_unbounded(filter), "{filter}");
        }
        for filter in [
            r#"{"id":1}"#,
            r#"{"created_at":{"$gte":"2026-01-01"}}"#,
            r#"{"$and":[{}, {"tenant_id":1}]}"#,
            r#"{"$or":[{"tenant_id":1},{"tenant_id":2}]}"#,
            r#"{"id":{"$ne":1}}"#,
            r#"{"id":{"$in":[1,2]}}"#,
            r#"{"id":{"$exists":true}}"#,
            r#"{"_id":{"$oid":"507f1f77bcf86cd799439011"}}"#,
            r#"{"sequence":{"$numberLong":"9223372036854775807"}}"#,
            r#"{"created_at":{"$date":"2026-01-01T00:00:00.000Z"}}"#,
            r#"{"tenant_id":1,"id":{"$nin":[]}}"#,
        ] {
            assert!(!mongo_filter_is_effectively_unbounded(filter), "{filter}");
        }
    }
}
