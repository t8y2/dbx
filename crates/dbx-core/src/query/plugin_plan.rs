//! Read-only estimated execution plan acquisition for the plugin Host API.
//!
//! A plugin never builds a plan statement and never reaches a driver: it
//! submits the original SQL plus a connection reference, and the host resolves
//! the connection, generates the statement through
//! [`build_explain_sql`](crate::query_execution_sql::build_explain_sql), runs the
//! same read-only safety gate DBX uses for its own plan view, and executes it
//! with the host's own connection, credentials, driver, and timeout. The plugin
//! only ever receives the raw plan.
//!
//! Only *estimated* plans are reachable from here. `analyze` is never set, so no
//! request can turn into `EXPLAIN ANALYZE` / `SET STATISTICS XML`, and the
//! caller's statement is never executed — it is only planned.
//!
//! The connection must already be open. Both entry points require a live pool
//! for the connection (`require_open_connection`); a saved-but-disconnected
//! connection is rejected rather than dialled with the stored credentials, so
//! `host.plans:read` can never make DBX connect on a plugin's behalf.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent_explain::{explain_database_type, get_agent_explain_info_core};
use crate::connection::AppState;
use crate::db::QueryResult;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::query_execution_sql::{
    build_explain_sql, estimated_plan_format, supports_explain_plan, EstimatedPlanFormat, ExplainFormat,
    ExplainSqlOptions,
};

use super::{execute_sql_statement_with_options_typed, QueryExecutionMode, QueryExecutionOptions};

/// The only plan mode this API serves. Actual plans execute the statement, so an
/// unknown mode is rejected outright rather than silently downgraded.
pub const PLUGIN_PLAN_MODE_ESTIMATED: &str = "estimated";
/// The agent-runtime mode that asks for an estimated plan. Kept separate from
/// the Host API `mode` vocabulary: `autotrace` (Dameng actual plan) is
/// deliberately never requested here.
const AGENT_EXPLAIN_MODE: &str = "explain";

/// Host-wide ceiling for a plugin-requested `timeoutMs`; reported as
/// `limits.maxTimeoutMs`. A connection's own query timeout can clamp it further.
pub const MAX_PLUGIN_PLAN_TIMEOUT_MS: u64 = 60_000;
/// Host-wide ceiling for the serialized plan; reported as `limits.maxPlanBytes`.
pub const MAX_PLUGIN_PLAN_BYTES: usize = 4 * 1024 * 1024;
/// Bound on the submitted SQL. Well inside the plugin bridge payload cap so a
/// single plan request always fits one round trip.
pub const MAX_PLUGIN_PLAN_SQL_CHARS: usize = 200_000;

const MAX_PLUGIN_PLAN_NAME_CHARS: usize = 256;
/// Rows the plan statement may return. OceanBase Oracle returns one line of the
/// JSON document per row and text plans can be long, so this stays generous
/// while still bounding the driver-side result.
const PLUGIN_PLAN_MAX_ROWS: usize = 20_000;
/// The server answered with something that is neither JSON nor expected text.
const WARNING_PLAN_NOT_JSON: &str = "plan_not_json";
/// The plan text was cut to fit `limits.maxPlanBytes`.
const WARNING_PLAN_TRUNCATED: &str = "plan_truncated";
/// The driver stopped collecting plan rows at `PLUGIN_PLAN_MAX_ROWS`.
const WARNING_PLAN_ROWS_TRUNCATED: &str = "plan_rows_truncated";

/// The one error both plan entry points return when the connection is not open.
/// Shared so `host.getPlanCapabilities` and `host.explainPlan` agree: a closed
/// connection rejects the capability probe instead of succeeding and leaving
/// the plan request to fail later.
const CONNECTION_NOT_OPEN_ERROR: &str = "Connection is not open";

#[derive(Debug, Clone, PartialEq, Eq)]
struct PlanPayload {
    format: EstimatedPlanFormat,
    raw_plan: Value,
    truncated: bool,
    warnings: Vec<String>,
}

/// A plugin's request for an estimated plan. The field set is exactly what the
/// Host API accepts; there is deliberately no way to pass an `EXPLAIN`
/// statement, a driver command, or an execution mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPlanRequest {
    pub connection_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub sql: String,
    /// Plan mode. Only `"estimated"` is served.
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// What the current host and connection can do, so a plugin can degrade instead
/// of probing with real requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPlanCapabilities {
    pub db_type: String,
    /// Server product version when DBX already learned it for this connection.
    /// Absent when unknown — the probe is never run on the plugin's behalf.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_version: Option<String>,
    pub supports: PluginPlanSupports,
    pub limits: PluginPlanLimits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPlanSupports {
    pub estimated_plan: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPlanLimits {
    pub max_timeout_ms: u64,
    pub max_plan_bytes: usize,
}

/// The raw estimated plan and everything a plugin needs to decode it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPlanResult {
    pub db_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_version: Option<String>,
    pub format: EstimatedPlanFormat,
    /// The plan itself: a JSON document for `format: "json"`, otherwise the plan
    /// text (ShowPlanXML stays a string).
    pub raw_plan: Value,
    /// True when the host cut the plan to respect its own limits.
    pub truncated: bool,
    pub warnings: Vec<String>,
}

/// Reports what the plugin may expect from this connection without connecting
/// to it, running any SQL, or reading anything beyond the stored config. The
/// connection must already be open, so a closed one is refused here rather than
/// after a plan request has already been prepared.
pub async fn plugin_plan_capabilities(state: &AppState, connection_id: &str) -> Result<PluginPlanCapabilities, String> {
    let connection_id = require_connection_id(connection_id)?;
    let config = connection_config(state, connection_id).await?;
    require_open_connection(state, connection_id).await?;
    let database_type = explain_database_type(&config);
    Ok(PluginPlanCapabilities {
        db_type: database_type.as_str().to_string(),
        db_version: database_version(&config),
        supports: PluginPlanSupports { estimated_plan: supports_explain_plan(Some(database_type)) },
        limits: PluginPlanLimits {
            max_timeout_ms: plugin_plan_timeout_ceiling_ms(&config),
            max_plan_bytes: MAX_PLUGIN_PLAN_BYTES,
        },
    })
}

/// Acquires the estimated plan for `request.sql`.
///
/// The statement is validated by the same read-only gate DBX uses for its own
/// plan view, the `EXPLAIN` text is generated by the host (never by the
/// caller), and execution happens on the host's connection with the host's
/// timeout. Nothing here can execute the caller's statement.
pub async fn explain_estimated_plan(state: &AppState, request: PluginPlanRequest) -> Result<PluginPlanResult, String> {
    let request = validate_plugin_plan_request(request)?;
    let config = connection_config(state, &request.connection_id).await?;
    require_open_connection(state, &request.connection_id).await?;
    let database_type = explain_database_type(&config);
    if !supports_explain_plan(Some(database_type)) {
        return Err(unsupported_dialect_message(database_type));
    }

    let timeout_secs = plugin_plan_timeout_secs(request.timeout_ms, &config);
    let (plan_text, rows_truncated) = if uses_driver_native_plan(database_type) {
        // Dameng and Oracle hand back a native plan listing from their driver;
        // Oracle's `EXPLAIN PLAN FOR` alone only fills `PLAN_TABLE`. This reuses
        // the core the AI and command explain paths already use, pinned to
        // `mode = "explain"` so Dameng autotrace stays unreachable.
        let text = get_agent_explain_info_core(
            state,
            &request.connection_id,
            request.database.as_deref(),
            request.schema.as_deref(),
            &request.sql,
            Some(AGENT_EXPLAIN_MODE),
            Some(timeout_secs),
        )
        .await?;
        (text, false)
    } else {
        native_estimated_plan(state, &request, database_type, timeout_secs).await?
    };

    let plan_text = non_empty_plan_text(plan_text)?;
    let mut payload = finalize_plan_payload(database_type, plan_text)?;
    if rows_truncated {
        payload.truncated = true;
        payload.warnings.push(WARNING_PLAN_ROWS_TRUNCATED.to_string());
    }

    Ok(PluginPlanResult {
        db_type: database_type.as_str().to_string(),
        db_version: database_version(&config),
        format: payload.format,
        raw_plan: payload.raw_plan,
        truncated: payload.truncated,
        warnings: payload.warnings,
    })
}

/// Dialects whose plan comes from the driver/oracle-side native plan listing
/// instead of a generated `EXPLAIN` statement.
fn uses_driver_native_plan(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Dameng | DatabaseType::Oracle)
}

async fn native_estimated_plan(
    state: &AppState,
    request: &PluginPlanRequest,
    database_type: DatabaseType,
    timeout_secs: u64,
) -> Result<(String, bool), String> {
    let built = build_explain_sql(ExplainSqlOptions {
        database_type: Some(database_type),
        // Estimated only: `analyze` is exactly what turns this into a statement
        // that runs the caller's SQL.
        analyze: None,
        format: Some(ExplainFormat::Json),
        sql: request.sql.clone(),
    });
    if !built.ok {
        return Err(explain_build_error(built.reason.as_deref(), database_type));
    }
    let Some(explain_sql) = built.sql else {
        return Err("The host did not build an EXPLAIN statement".to_string());
    };

    if database_type == DatabaseType::SqlServer {
        return sqlserver_estimated_plan(state, request, timeout_secs).await;
    }

    let database = request.database.as_deref().unwrap_or_default();
    let result = execute_sql_statement_with_options_typed(
        state,
        &request.connection_id,
        database,
        &explain_sql,
        request.schema.as_deref(),
        None,
        QueryExecutionOptions {
            max_rows: Some(PLUGIN_PLAN_MAX_ROWS),
            timeout_secs: Some(timeout_secs),
            ..Default::default()
        },
    )
    .await
    .map_err(|error| error.to_string())?;

    Ok((join_result_text(&result), result.truncated))
}

/// `SET SHOWPLAN_XML ON` is session state, so the toggle, the planned statement,
/// and the toggle-off must share one client session. DBX's own explain view
/// does the same with a dedicated explain session; the plugin path keeps the
/// session short-lived and discards it afterwards.
async fn sqlserver_estimated_plan(
    state: &AppState,
    request: &PluginPlanRequest,
    timeout_secs: u64,
) -> Result<(String, bool), String> {
    let client_session_id = format!("plugin-plan-{}", uuid::Uuid::new_v4());
    let database = request.database.as_deref().unwrap_or_default();
    let session_database = (!database.is_empty()).then_some(database);
    let options = |execution_mode: QueryExecutionMode| QueryExecutionOptions {
        max_rows: Some(PLUGIN_PLAN_MAX_ROWS),
        client_session_id: Some(client_session_id.clone()),
        // ShowPlan capture must not be distorted by result-set probing or query
        // rewriting, which is what the plain execution mode deliberately does.
        execution_mode,
        timeout_secs: Some(timeout_secs),
        ..Default::default()
    };

    let capture = async {
        execute_sql_statement_with_options_typed(
            state,
            &request.connection_id,
            database,
            "SET SHOWPLAN_XML ON;",
            request.schema.as_deref(),
            None,
            options(QueryExecutionMode::Simple),
        )
        .await
        .map_err(|error| error.to_string())?;
        execute_sql_statement_with_options_typed(
            state,
            &request.connection_id,
            database,
            &request.sql,
            request.schema.as_deref(),
            None,
            options(QueryExecutionMode::Simple),
        )
        .await
        .map_err(|error| error.to_string())
    }
    .await;

    // The session pool is dropped immediately below, so a failed toggle-off can
    // never leave ShowPlan capture enabled for another caller's session.
    let _ = execute_sql_statement_with_options_typed(
        state,
        &request.connection_id,
        database,
        "SET SHOWPLAN_XML OFF;",
        request.schema.as_deref(),
        None,
        options(QueryExecutionMode::Simple),
    )
    .await;
    let _ = state.close_client_session_pool(&request.connection_id, session_database, &client_session_id).await;

    let result = capture?;
    let plan = sqlserver_showplan_xml(&result)
        .ok_or_else(|| "SQL Server did not return a ShowPlan XML estimated plan".to_string())?;
    Ok((plan, result.truncated))
}

/// Extracts the `<ShowPlanXML>` document from the captured result, mirroring how
/// DBX's own plan view locates it: the driver may report other cells alongside.
fn sqlserver_showplan_xml(result: &QueryResult) -> Option<String> {
    result
        .rows
        .iter()
        .flatten()
        .find(|cell| matches!(cell, Value::String(text) if text.contains("<ShowPlanXML")))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Flattens a plan result into one text document. OceanBase Oracle returns one
/// line of the JSON document per row, PostgreSQL and MySQL return a single
/// cell, and text plans are line-oriented; joining reproduces all three.
fn join_result_text(result: &QueryResult) -> String {
    result.rows.iter().flatten().map(cell_text).collect::<Vec<_>>().join("\n")
}

fn cell_text(cell: &Value) -> String {
    match cell {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn non_empty_plan_text(text: String) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("The database returned an empty estimated plan".to_string());
    }
    Ok(text)
}

/// Decodes the acquired text into the shape advertised by `format`, downgrades
/// an unparseable JSON answer to text instead of lying about it, and enforces
/// the payload cap.
fn finalize_plan_payload(database_type: DatabaseType, text: String) -> Result<PlanPayload, String> {
    let mut format = estimated_plan_format(Some(database_type));
    let mut warnings = Vec::new();
    let mut raw_plan = Value::String(text);

    if format == EstimatedPlanFormat::Json {
        match serde_json::from_str::<Value>(raw_plan.as_str().unwrap_or_default()) {
            Ok(parsed) => raw_plan = parsed,
            Err(_) => {
                warnings.push(WARNING_PLAN_NOT_JSON.to_string());
                format = EstimatedPlanFormat::Text;
            }
        }
    }

    let encoded = serde_json::to_vec(&raw_plan).map_err(|error| error.to_string())?;
    if encoded.len() <= MAX_PLUGIN_PLAN_BYTES {
        return Ok(PlanPayload { format, raw_plan, truncated: false, warnings });
    }

    // Only a text plan can be cut without corrupting its own encoding. A JSON
    // document has no meaningful partial form, so an oversized one fails rather
    // than turning into something the plugin cannot parse.
    let Value::String(text) = &raw_plan else {
        return Err(plan_too_large_message());
    };
    let Some(truncated) = truncate_json_string_to_bytes(text, MAX_PLUGIN_PLAN_BYTES) else {
        return Err(plan_too_large_message());
    };
    warnings.push(WARNING_PLAN_TRUNCATED.to_string());
    Ok(PlanPayload { format, raw_plan: Value::String(truncated), truncated: true, warnings })
}

fn plan_too_large_message() -> String {
    format!("The estimated plan exceeds the {MAX_PLUGIN_PLAN_BYTES} byte host limit")
}

/// Cuts `text` so that its JSON encoding fits `limit` bytes. Escaping only ever
/// grows the payload, so the search shrinks until the encoded length fits.
fn truncate_json_string_to_bytes(text: &str, limit: usize) -> Option<String> {
    let mut end = limit.min(text.len());
    while end > 0 {
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == 0 {
            return None;
        }
        let candidate = &text[..end];
        let fits =
            serde_json::to_vec(&Value::String(candidate.to_string())).is_ok_and(|encoded| encoded.len() <= limit);
        if fits {
            return Some(candidate.to_string());
        }
        end -= (end / 8).max(1);
    }
    None
}

fn explain_build_error(reason: Option<&str>, database_type: DatabaseType) -> String {
    match reason {
        Some("unsupported") => unsupported_dialect_message(database_type),
        Some("empty") => "Plugin plan requests need a non-empty sql".to_string(),
        // `build_explain_sql` runs DBX's own read-only plan gate; a rejection
        // here is the security boundary doing its job, not a host defect. The
        // message stays generic so a plugin cannot use it to probe the gate.
        _ => "The requested statement is not safe to plan".to_string(),
    }
}

fn unsupported_dialect_message(database_type: DatabaseType) -> String {
    format!("Estimated execution plans are not available for '{}' connections", database_type.as_str())
}

fn database_version(config: &ConnectionConfig) -> Option<String> {
    config.database_info.as_ref().and_then(|info| info.product_version.clone())
}

async fn connection_config(state: &AppState, connection_id: &str) -> Result<ConnectionConfig, String> {
    let configs = state.configs.read().await;
    configs.get(connection_id).cloned().ok_or_else(|| "Connection config not found".to_string())
}

/// Enforces the boundary both plan entry points document: a plugin may plan on
/// a connection DBX already has open, never on a saved config alone.
///
/// `state.configs` holds every *saved* connection, and a disconnected one keeps
/// its config, so the config table cannot answer this. Only the pool registry
/// can, and it answers without connecting: a saved-but-closed connection is
/// rejected here instead of being dialled with the stored credentials. Runs
/// after [`connection_config`] so an unknown id still reports itself as unknown.
async fn require_open_connection(state: &AppState, connection_id: &str) -> Result<(), String> {
    if state.is_connection_open(connection_id).await {
        return Ok(());
    }
    Err(CONNECTION_NOT_OPEN_ERROR.to_string())
}

fn require_connection_id(connection_id: &str) -> Result<&str, String> {
    let trimmed = connection_id.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_PLUGIN_PLAN_NAME_CHARS {
        return Err("Plugin plan requests need a valid connectionId".to_string());
    }
    Ok(trimmed)
}

/// Rejects anything the Host API does not serve. This is the plugin-facing
/// boundary, so it runs before the connection is even resolved.
fn validate_plugin_plan_request(mut request: PluginPlanRequest) -> Result<PluginPlanRequest, String> {
    request.connection_id = require_connection_id(&request.connection_id)?.to_string();
    if request.mode != PLUGIN_PLAN_MODE_ESTIMATED {
        return Err(format!(
            "Plugin plan requests support mode '{}' only; '{}' is not available",
            PLUGIN_PLAN_MODE_ESTIMATED, request.mode
        ));
    }
    let sql = request.sql.trim();
    if sql.is_empty() {
        return Err("Plugin plan requests need a non-empty sql".to_string());
    }
    if sql.chars().count() > MAX_PLUGIN_PLAN_SQL_CHARS {
        return Err(format!("Plugin plan sql exceeds {MAX_PLUGIN_PLAN_SQL_CHARS} characters"));
    }
    request.sql = sql.to_string();
    request.database = normalize_plan_scope(request.database, "database")?;
    request.schema = normalize_plan_scope(request.schema, "schema")?;
    Ok(request)
}

fn normalize_plan_scope(value: Option<String>, name: &str) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_PLUGIN_PLAN_NAME_CHARS {
        return Err(format!("Plugin plan {name} is too long"));
    }
    Ok(Some(trimmed.to_string()))
}

/// The largest timeout a plugin may request for this connection: the
/// connection's own query timeout, never more than the host-wide ceiling. A
/// connection configured with `0` ("no limit") still gets the host ceiling.
pub fn plugin_plan_timeout_ceiling_ms(config: &ConnectionConfig) -> u64 {
    let connection_secs = config.effective_query_timeout_secs();
    if connection_secs == 0 {
        return MAX_PLUGIN_PLAN_TIMEOUT_MS;
    }
    connection_secs.saturating_mul(1000).min(MAX_PLUGIN_PLAN_TIMEOUT_MS)
}

/// Clamps a request to the connection ceiling. Execution granularity is
/// seconds, so the value rounds up rather than silently shortening the request.
pub fn plugin_plan_timeout_secs(timeout_ms: Option<u64>, config: &ConnectionConfig) -> u64 {
    let ceiling = plugin_plan_timeout_ceiling_ms(config);
    let requested = timeout_ms.map_or(ceiling, |timeout_ms| timeout_ms.clamp(1, ceiling));
    requested.div_ceil(1000).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::PoolKind;
    use crate::storage::Storage;

    fn config(db_type: DatabaseType, query_timeout_secs: u64) -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "conn-1",
            "name": "Connection",
            "db_type": db_type.as_str(),
            "host": "127.0.0.1",
            "port": 5432,
            "username": "user",
            "password": "secret",
            "query_timeout_secs": query_timeout_secs
        }))
        .unwrap()
    }

    /// A saved config with a different id, so one state can hold several.
    fn config_for(db_type: DatabaseType, id: &str, query_timeout_secs: u64) -> ConnectionConfig {
        let mut config = config(db_type, query_timeout_secs);
        config.id = id.to_string();
        config
    }

    /// A state holding saved configs but no pools: exactly the "saved but
    /// disconnected" situation the plan boundary has to refuse.
    async fn saved_connection_state(configs: &[ConnectionConfig]) -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(&dir.path().join("storage.db")).await.expect("open storage");
        let state = AppState::new_with_plugin_dir(storage, dir.path().join("plugins"));
        {
            let mut stored = state.configs.write().await;
            for config in configs {
                stored.insert(config.id.clone(), config.clone());
            }
        }
        (state, dir)
    }

    /// Opens `connection_id` the way DBX does: a pool in the registry. The pool
    /// kind is irrelevant here because the plan gate only reads pool keys.
    async fn open_connection(state: &AppState, pool_key: &str) {
        let pool = PoolKind::Redis(std::sync::Arc::new(crate::db::redis_driver::redis_connection_test_stub()));
        state.update_connection_pools(|connections| connections.insert(pool_key.to_string(), pool)).await;
    }

    fn request(mode: &str, sql: &str) -> PluginPlanRequest {
        PluginPlanRequest {
            connection_id: "conn-1".to_string(),
            database: None,
            schema: None,
            sql: sql.to_string(),
            mode: mode.to_string(),
            timeout_ms: None,
        }
    }

    #[test]
    fn accepts_only_the_estimated_mode() {
        assert!(validate_plugin_plan_request(request(PLUGIN_PLAN_MODE_ESTIMATED, "SELECT 1")).is_ok());
        for mode in ["actual", "analyze", "Estimated", "estimated ", "autotrace", ""] {
            let error = validate_plugin_plan_request(request(mode, "SELECT 1")).unwrap_err();
            assert!(error.contains("mode"), "mode '{mode}' must be rejected: {error}");
        }
    }

    #[test]
    fn rejects_missing_connection_and_empty_sql() {
        let mut empty_connection = request(PLUGIN_PLAN_MODE_ESTIMATED, "SELECT 1");
        empty_connection.connection_id = "   ".to_string();
        assert!(validate_plugin_plan_request(empty_connection).unwrap_err().contains("connectionId"));

        assert!(validate_plugin_plan_request(request(PLUGIN_PLAN_MODE_ESTIMATED, "  \n "))
            .unwrap_err()
            .contains("sql"));
    }

    #[test]
    fn rejects_oversized_inputs() {
        let oversized_sql = format!("SELECT '{}'", "a".repeat(MAX_PLUGIN_PLAN_SQL_CHARS));
        assert!(validate_plugin_plan_request(request(PLUGIN_PLAN_MODE_ESTIMATED, &oversized_sql))
            .unwrap_err()
            .contains("characters"));

        let mut oversized_database = request(PLUGIN_PLAN_MODE_ESTIMATED, "SELECT 1");
        oversized_database.database = Some("d".repeat(MAX_PLUGIN_PLAN_NAME_CHARS + 1));
        assert!(validate_plugin_plan_request(oversized_database).unwrap_err().contains("database"));

        let mut oversized_connection = request(PLUGIN_PLAN_MODE_ESTIMATED, "SELECT 1");
        oversized_connection.connection_id = "c".repeat(MAX_PLUGIN_PLAN_NAME_CHARS + 1);
        assert!(validate_plugin_plan_request(oversized_connection).unwrap_err().contains("connectionId"));
    }

    #[test]
    fn normalizes_scope_and_sql_whitespace() {
        let mut scoped = request(PLUGIN_PLAN_MODE_ESTIMATED, "  SELECT 1  ");
        scoped.database = Some("  app  ".to_string());
        scoped.schema = Some("   ".to_string());

        let validated = validate_plugin_plan_request(scoped).unwrap();
        assert_eq!(validated.sql, "SELECT 1");
        assert_eq!(validated.database.as_deref(), Some("app"));
        assert_eq!(validated.schema, None);
    }

    #[test]
    fn clamps_timeouts_to_the_connection_and_host_ceiling() {
        let unlimited = config(DatabaseType::Postgres, 0);
        assert_eq!(plugin_plan_timeout_ceiling_ms(&unlimited), MAX_PLUGIN_PLAN_TIMEOUT_MS);
        assert_eq!(plugin_plan_timeout_secs(None, &unlimited), 60);
        assert_eq!(plugin_plan_timeout_secs(Some(1), &unlimited), 1);
        assert_eq!(plugin_plan_timeout_secs(Some(u64::MAX), &unlimited), 60);
        assert_eq!(plugin_plan_timeout_secs(Some(0), &unlimited), 1);

        let connection_capped = config(DatabaseType::Postgres, 5);
        assert_eq!(plugin_plan_timeout_ceiling_ms(&connection_capped), 5_000);
        assert_eq!(plugin_plan_timeout_secs(None, &connection_capped), 5);
        assert_eq!(plugin_plan_timeout_secs(Some(30_000), &connection_capped), 5);
        assert_eq!(plugin_plan_timeout_secs(Some(1_500), &connection_capped), 2);

        let hour_long = config(DatabaseType::Postgres, 3_600);
        assert_eq!(plugin_plan_timeout_ceiling_ms(&hour_long), MAX_PLUGIN_PLAN_TIMEOUT_MS);
        assert_eq!(plugin_plan_timeout_secs(Some(45_000), &hour_long), 45);
    }

    #[test]
    fn parses_json_plans_and_downgrades_other_payloads_to_text() {
        let payload =
            finalize_plan_payload(DatabaseType::Postgres, r#"[{"Plan": {"Node Type": "Seq Scan"}}]"#.to_string())
                .unwrap();
        assert_eq!(payload.format, EstimatedPlanFormat::Json);
        assert_eq!(payload.raw_plan[0]["Plan"]["Node Type"], Value::String("Seq Scan".to_string()));
        assert!(!payload.truncated);
        assert!(payload.warnings.is_empty());

        let payload = finalize_plan_payload(DatabaseType::Postgres, "Seq Scan on users".to_string()).unwrap();
        assert_eq!(payload.format, EstimatedPlanFormat::Text);
        assert_eq!(payload.raw_plan, Value::String("Seq Scan on users".to_string()));
        assert_eq!(payload.warnings, vec![WARNING_PLAN_NOT_JSON.to_string()]);
    }

    #[test]
    fn keeps_text_and_xml_plans_as_strings() {
        let text = finalize_plan_payload(DatabaseType::Oracle, "1 #NSET2: [0, 1, 0]".to_string()).unwrap();
        assert_eq!(text.format, EstimatedPlanFormat::Text);
        assert_eq!(text.raw_plan, Value::String("1 #NSET2: [0, 1, 0]".to_string()));

        let xml =
            finalize_plan_payload(DatabaseType::SqlServer, "<ShowPlanXML><BatchSequence/></ShowPlanXML>".to_string())
                .unwrap();
        assert_eq!(xml.format, EstimatedPlanFormat::Xml);
        assert_eq!(xml.raw_plan, Value::String("<ShowPlanXML><BatchSequence/></ShowPlanXML>".to_string()));
        assert!(xml.warnings.is_empty());
    }

    #[test]
    fn truncates_oversized_text_plans_and_rejects_oversized_json_plans() {
        let oversized = "x".repeat(MAX_PLUGIN_PLAN_BYTES + 1_024);
        let payload = finalize_plan_payload(DatabaseType::Doris, oversized.clone()).unwrap();
        assert!(payload.truncated);
        assert_eq!(payload.warnings, vec![WARNING_PLAN_TRUNCATED.to_string()]);
        let Value::String(text) = &payload.raw_plan else {
            panic!("a truncated text plan stays a string");
        };
        assert!(text.len() < oversized.len());
        assert!(serde_json::to_vec(&payload.raw_plan).unwrap().len() <= MAX_PLUGIN_PLAN_BYTES);

        // A JSON document must not be handed over half-parsed.
        let oversized_json = format!(r#"[{{"Plan": "{}"}}]"#, "y".repeat(MAX_PLUGIN_PLAN_BYTES + 1_024));
        let error = finalize_plan_payload(DatabaseType::Postgres, oversized_json).unwrap_err();
        assert!(error.contains("host limit"), "{error}");
    }

    #[test]
    fn truncation_respects_utf8_and_escaping() {
        // Every character encodes as two JSON bytes plus the quote/escape pair.
        let oversized = "\"".repeat(MAX_PLUGIN_PLAN_BYTES);
        let truncated = truncate_json_string_to_bytes(&oversized, 1_024).unwrap();
        assert!(serde_json::to_vec(&Value::String(truncated)).unwrap().len() <= 1_024);

        let multibyte = "計".repeat(2_000);
        let truncated = truncate_json_string_to_bytes(&multibyte, 64).unwrap();
        assert!(multibyte.starts_with(&truncated));
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn rejects_empty_plans() {
        assert!(non_empty_plan_text(String::new()).is_err());
        assert!(non_empty_plan_text("  \n ".to_string()).is_err());
        assert_eq!(non_empty_plan_text("Seq Scan".to_string()).unwrap(), "Seq Scan");
    }

    #[test]
    fn joins_result_rows_into_one_document() {
        let result: QueryResult = serde_json::from_value(serde_json::json!({
            "columns": ["Query Plan"],
            "rows": [["{"], ["  \"query_block\": {}"], ["}"]],
            "affected_rows": 0,
            "execution_time_ms": 1
        }))
        .unwrap();

        assert_eq!(join_result_text(&result), "{\n  \"query_block\": {}\n}");
        assert!(serde_json::from_str::<Value>(&join_result_text(&result)).is_ok());
    }

    #[test]
    fn extracts_showplan_xml_from_any_cell() {
        let result: QueryResult = serde_json::from_value(serde_json::json!({
            "columns": ["note", "plan"],
            "rows": [["SHOWPLAN", "<ShowPlanXML><BatchSequence/></ShowPlanXML>"]],
            "affected_rows": 0,
            "execution_time_ms": 1
        }))
        .unwrap();
        assert_eq!(sqlserver_showplan_xml(&result).as_deref(), Some("<ShowPlanXML><BatchSequence/></ShowPlanXML>"));

        let without_plan: QueryResult = serde_json::from_value(serde_json::json!({
            "columns": ["note"],
            "rows": [["no plan"]],
            "affected_rows": 0,
            "execution_time_ms": 1
        }))
        .unwrap();
        assert_eq!(sqlserver_showplan_xml(&without_plan), None);
    }

    #[test]
    fn plans_native_dialects_through_the_driver_and_the_rest_through_explain_sql() {
        assert!(uses_driver_native_plan(DatabaseType::Dameng));
        assert!(uses_driver_native_plan(DatabaseType::Oracle));

        for database_type in
            [DatabaseType::Postgres, DatabaseType::Mysql, DatabaseType::SqlServer, DatabaseType::OceanbaseOracle]
        {
            assert!(!uses_driver_native_plan(database_type));
            assert!(supports_explain_plan(Some(database_type)));
        }
    }

    #[test]
    fn rejects_unsupported_dialects_and_unsafe_statements() {
        let redis = config(DatabaseType::Redis, 0);
        assert!(!supports_explain_plan(Some(explain_database_type(&redis))));

        // `build_explain_sql` is the same gate the plugin path relies on.
        for sql in [
            "DROP TABLE users",
            "DELETE FROM users",
            "INSERT INTO users (id) VALUES (1)",
            "UPDATE users SET name = 'x'",
            "SELECT 1; DROP TABLE users",
            "CREATE INDEX idx ON users (id)",
        ] {
            assert!(
                !build_explain_sql(ExplainSqlOptions {
                    database_type: Some(DatabaseType::Postgres),
                    analyze: None,
                    format: None,
                    sql: sql.to_string(),
                })
                .ok,
                "{sql} must not build an estimated plan statement"
            );
        }
    }

    #[test]
    fn reports_capability_limits_and_dialect_without_connecting() {
        // `plugin_plan_capabilities` only reads the stored config, so the parts
        // that do not need `AppState` are asserted through the shared helpers.
        let postgres = config(DatabaseType::Postgres, 30);
        assert_eq!(plugin_plan_timeout_ceiling_ms(&postgres), 30_000);
        assert_eq!(database_version(&postgres), None);
        assert_eq!(explain_database_type(&postgres).as_str(), "postgres");
    }

    /// The boundary the docs promise, enforced in core: a saved config is not an
    /// open connection, so a plugin can never make DBX dial stored credentials.
    #[tokio::test]
    async fn saved_but_disconnected_connection_is_rejected_by_both_plan_calls() {
        let postgres = config(DatabaseType::Postgres, 30);
        let (state, _dir) = saved_connection_state(std::slice::from_ref(&postgres)).await;

        let error = plugin_plan_capabilities(&state, &postgres.id).await.unwrap_err();
        assert_eq!(error, CONNECTION_NOT_OPEN_ERROR);

        let error = explain_estimated_plan(&state, request(PLUGIN_PLAN_MODE_ESTIMATED, "SELECT 1")).await.unwrap_err();
        assert_eq!(error, CONNECTION_NOT_OPEN_ERROR);

        // The check is a pure read: it must not have opened the connection it
        // just refused, and an unknown id must still report itself as unknown.
        assert!(state.with_connection_pools(|pools| pools.is_empty()).await);
        assert_eq!(plugin_plan_capabilities(&state, "unknown").await.unwrap_err(), "Connection config not found");
    }

    /// The same connection, once DBX holds it open, behaves exactly as before.
    #[tokio::test]
    async fn an_open_connection_keeps_the_existing_behavior() {
        let postgres = config(DatabaseType::Postgres, 30);
        let redis = config_for(DatabaseType::Redis, "redis-conn", 0);
        let (state, _dir) = saved_connection_state(&[postgres.clone(), redis.clone()]).await;

        // A database-scoped or session-scoped pool is the same open connection.
        open_connection(&state, "conn-1:analytics").await;
        open_connection(&state, "redis-conn:session:tab-1").await;

        let capabilities = plugin_plan_capabilities(&state, &postgres.id).await.unwrap();
        assert_eq!(capabilities.db_type, "postgres");
        assert!(capabilities.supports.estimated_plan);
        assert_eq!(capabilities.limits.max_timeout_ms, 30_000);

        // Redis has no estimated plan path, but the request reaches that dialect
        // check instead of the open-connection gate.
        let request =
            PluginPlanRequest { connection_id: redis.id.clone(), ..request(PLUGIN_PLAN_MODE_ESTIMATED, "SELECT 1") };
        assert_eq!(
            explain_estimated_plan(&state, request).await.unwrap_err(),
            unsupported_dialect_message(DatabaseType::Redis)
        );
    }
}
