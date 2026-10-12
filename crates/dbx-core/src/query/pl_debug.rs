//! PL/SQL debugging orchestration for Oracle connections.
//!
//! The oracle-go agent owns the debug session and all `DBMS_DEBUG` state; this
//! module keeps the routing table (debug id → the dedicated agent session that
//! owns it) and exposes the operations the Tauri commands call.
//!
//! Each debug session runs on its own client session id, so its agent
//! instance is isolated from metadata/query pools: continuation calls block on
//! the server until the debuggee reaches its next stop, and that blocking
//! must never occupy the pool every other request shares. Closing a session
//! releases the agent-side connections and tears the isolated pool down.
//!
//! The OceanBase Oracle (Java) agent that shares this contract lives on the
//! `feature/ob-oracle-pl-debug` branch.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::models::connection::{ConnectionConfig, DatabaseType};

/// Mirrors `PlDebugSession.DEFAULT_TIMEOUT_MILLIS` on the agent side.
pub const PL_DEBUG_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Non-blocking calls (probe, breakpoint management) use a short budget.
const PL_DEBUG_QUICK_TIMEOUT: Duration = Duration::from_secs(60);
/// Upper bound for the graceful close of one session while its connection is
/// being removed; see [`pl_debug_close_all_for_connection_core`].
const PL_DEBUG_REMOVAL_CLOSE_BUDGET: Duration = Duration::from_secs(5);
const PL_DEBUG_CLIENT_SESSION_PREFIX: &str = "pl-debug-";

/// One live debug session and where its agent-side state lives.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlDebugSessionHandle {
    pub debug_id: String,
    pub connection_id: String,
    pub database: String,
    pub client_session_id: String,
    /// Pool key of the dedicated agent session; resolved lazily on each call.
    pub pool_key: String,
}

fn supports_pl_debug(config: Option<&ConnectionConfig>) -> bool {
    config.is_some_and(|config| matches!(config.db_type, DatabaseType::Oracle))
}

fn unsupported_probe_result(config: Option<&ConnectionConfig>) -> Value {
    let scope = config.map(|config| config.db_type.as_str()).unwrap_or("unknown");
    json!({
        "supported": false,
        "reason": format!(
            "PL/SQL debugging is only available for Oracle connections (current: {scope})"
        ),
    })
}

/// Whether this connection can debug PL/SQL, and why not when it cannot.
pub async fn pl_debug_probe_core(state: &AppState, connection_id: &str) -> Result<Value, String> {
    let config = state.configs.read().await.get(connection_id).cloned();
    if !supports_pl_debug(config.as_ref()) {
        return Ok(unsupported_probe_result(config.as_ref()));
    }
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, None, None).await?;
    let pool = state.pool_handle(&pool_key).await.ok_or("Pool not found")?;
    let PoolKind::Agent(client) = pool else {
        return Ok(unsupported_probe_result(config.as_ref()));
    };
    let result = tokio::time::timeout(PL_DEBUG_QUICK_TIMEOUT, async {
        let mut guard = client.lock().await;
        guard.pl_debug_probe::<Value>().await
    })
    .await
    .map_err(|_| "PL debug probe timed out".to_string())??;
    Ok(result)
}

/// Starts a session on a dedicated agent connection and records its handle.
pub async fn pl_debug_start_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    request: Value,
) -> Result<Value, String> {
    let config = state.configs.read().await.get(connection_id).cloned();
    if !supports_pl_debug(config.as_ref()) {
        return Err("PL/SQL debugging is only available for Oracle connections".to_string());
    }
    let client_session_id = format!("{PL_DEBUG_CLIENT_SESSION_PREFIX}{}", uuid::Uuid::new_v4().simple());
    let pool_key =
        state.get_or_create_metadata_pool_for_session(connection_id, Some(database), Some(&client_session_id)).await?;
    let pool = state.pool_handle(&pool_key).await.ok_or("Pool not found")?;
    let PoolKind::Agent(client) = pool else {
        return Err("PL debug sessions require an agent-backed connection".to_string());
    };
    let result = tokio::time::timeout(PL_DEBUG_TIMEOUT, async {
        let mut guard = client.lock().await;
        guard.pl_debug_start::<Value>(request, Some(PL_DEBUG_TIMEOUT)).await
    })
    .await
    .map_err(|_| "Starting the PL debug session timed out".to_string())??;

    let debug_id = result
        .get("debugId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Agent returned no debug id for the PL debug session".to_string())?
        .to_string();
    state.pl_debug_sessions.write().await.insert(
        debug_id.clone(),
        PlDebugSessionHandle {
            debug_id: debug_id.clone(),
            connection_id: connection_id.to_string(),
            database: database.to_string(),
            client_session_id,
            pool_key,
        },
    );
    Ok(result)
}

/// Resolves the dedicated agent client that owns `debug_id`.
async fn pl_debug_client(state: &AppState, debug_id: &str) -> Result<Arc<db::agent_driver::PooledAgentClient>, String> {
    let handle = { state.pl_debug_sessions.read().await.get(debug_id).cloned() }
        .ok_or_else(|| format!("PL debug session not found: {debug_id}"))?;
    let pool = state.pool_handle(&handle.pool_key).await.ok_or("Pool not found")?;
    match pool {
        PoolKind::Agent(client) => Ok(client),
        _ => Err("PL debug session is not backed by an agent connection".to_string()),
    }
}

pub async fn pl_debug_set_breakpoints_core(
    state: &AppState,
    debug_id: &str,
    breakpoints: Value,
) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_set_breakpoints::<Value>(debug_id, breakpoints, Some(PL_DEBUG_QUICK_TIMEOUT)).await
}

pub async fn pl_debug_delete_breakpoints_core(
    state: &AppState,
    debug_id: &str,
    breakpoints: Value,
) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_delete_breakpoints::<Value>(debug_id, breakpoints, Some(PL_DEBUG_QUICK_TIMEOUT)).await
}

pub async fn pl_debug_list_breakpoints_core(state: &AppState, debug_id: &str) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_list_breakpoints::<Value>(debug_id, Some(PL_DEBUG_QUICK_TIMEOUT)).await
}

/// Enables or disables one existing breakpoint in place (DBMS_DEBUG
/// ENABLE_BREAKPOINT / DISABLE_BREAKPOINT) instead of deleting and re-setting
/// it, so the local condition / ignore count and the server breakpoint number
/// survive the toggle.
///
/// The agent response body is forwarded as-is: it carries `ok` / `result` /
/// `message` plus `serverSupported`, where `serverSupported = false` means the
/// server exposes no enable/disable primitive (not an error) and the caller must
/// keep its client-side fallback. Served by the oracle-go agent.
pub async fn pl_debug_set_breakpoint_enabled_core(
    state: &AppState,
    debug_id: &str,
    breakpoint_number: i64,
    enabled: bool,
) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard
        .pl_debug_set_breakpoint_enabled::<Value>(debug_id, breakpoint_number, enabled, Some(PL_DEBUG_QUICK_TIMEOUT))
        .await
}

pub async fn pl_debug_resume_core(state: &AppState, debug_id: &str) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_resume::<Value>(debug_id, Some(PL_DEBUG_TIMEOUT)).await
}

/// Runs the debuggee to completion while ignoring every remaining breakpoint
/// (ODC's `resumeIgnoreBreakpoints`). The agent drives the run itself -- the
/// helper package's `DBX_CNT_EXIT` is no longer usable (its step loop cannot
/// end on this architecture, see the Go agent's resumeIgnoreBreakpoints). The
/// blocking budget matches the other continuation calls because the agent only
/// returns once the interpreter has exited.
///
/// Served by the oracle-go agent with the `pl_debug_resume_ignore_breakpoints`
/// request branch backed by
/// `AgentProtocol.METHOD_PL_DEBUG_RESUME_IGNORE_BREAKPOINTS`.
pub async fn pl_debug_resume_ignore_breakpoints_core(state: &AppState, debug_id: &str) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_resume_ignore_breakpoints::<Value>(debug_id, Some(PL_DEBUG_TIMEOUT)).await
}

/// Assigns a new value to the variable `name` in the given frame/slot. The
/// agent response body (`{ok, result, message, snapshot}`) is forwarded
/// unchanged.
pub async fn pl_debug_set_value_core(
    state: &AppState,
    debug_id: &str,
    name: &str,
    frame: i64,
    index: i64,
    value: &str,
) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_set_value::<Value>(debug_id, name, frame, index, value, Some(PL_DEBUG_QUICK_TIMEOUT)).await
}

/// Enables or disables breaking on exceptions; the agent response body is
/// forwarded unchanged.
pub async fn pl_debug_set_exception_breakpoint_core(
    state: &AppState,
    debug_id: &str,
    enabled: bool,
) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_set_exception_breakpoint::<Value>(debug_id, enabled, Some(PL_DEBUG_QUICK_TIMEOUT)).await
}

pub async fn pl_debug_step_over_core(state: &AppState, debug_id: &str) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_step_over::<Value>(debug_id, Some(PL_DEBUG_TIMEOUT)).await
}

pub async fn pl_debug_step_in_core(state: &AppState, debug_id: &str) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_step_in::<Value>(debug_id, Some(PL_DEBUG_TIMEOUT)).await
}

pub async fn pl_debug_step_out_core(state: &AppState, debug_id: &str) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_step_out::<Value>(debug_id, Some(PL_DEBUG_TIMEOUT)).await
}

pub async fn pl_debug_abort_core(state: &AppState, debug_id: &str) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_abort::<Value>(debug_id, Some(PL_DEBUG_TIMEOUT)).await
}

/// `frame` selects the stack frame to read variables from; `None` lets the
/// agent use its default (frame 0).
pub async fn pl_debug_get_variables_core(
    state: &AppState,
    debug_id: &str,
    frame: Option<i64>,
) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    let result = guard.pl_debug_get_variables::<Value>(debug_id, frame, Some(PL_DEBUG_QUICK_TIMEOUT)).await?;
    // A JSON-shaped payload is flattened as well as the legacy
    // `*name*type*value` delimited text the Oracle agent returns, so the
    // frontend always receives a flat variables array.
    let scalar_values = result.get("scalarValues").and_then(Value::as_str).unwrap_or("");
    let variables = parse_scalar_values(scalar_values);
    let mut response = result;
    response["variables"] = json!(variables);
    Ok(response)
}

/// Normalizes both `DBMS_DEBUG.GET_VALUES` shapes into `{name, value}` pairs.
fn parse_scalar_values(payload: &str) -> Value {
    let trimmed = payload.trim();
    if trimmed.is_empty() {
        return json!([]);
    }
    // A JSON object mapping variable names to values/types.
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(element) = serde_json::from_str::<Value>(trimmed) {
            let mut variables = Vec::new();
            collect_json_variables(&element, None, &mut variables);
            return json!(variables);
        }
    }
    // Oracle legacy: `*name*type*value` groups separated by `*`.
    if trimmed.starts_with('*') {
        let parts: Vec<&str> = trimmed.trim_start_matches('*').split('*').collect();
        let mut variables = Vec::new();
        for chunk in parts.chunks(3) {
            let name = chunk.first().copied().unwrap_or("").trim();
            if name.is_empty() {
                continue;
            }
            let entry = match chunk.len() {
                1 => json!({ "name": name }),
                2 => json!({ "name": name, "type": chunk[1].trim() }),
                _ => json!({ "name": name, "type": chunk[1].trim(), "value": chunk[2].trim() }),
            };
            variables.push(entry);
        }
        if !variables.is_empty() {
            return json!(variables);
        }
    }
    json!([{ "name": "values", "value": trimmed }])
}

fn collect_json_variables(element: &Value, prefix: Option<&str>, variables: &mut Vec<Value>) {
    match element {
        Value::Object(map) => {
            for (key, value) in map {
                let name = match prefix {
                    Some(prefix) => format!("{prefix}.{key}"),
                    None => key.clone(),
                };
                collect_json_variables(value, Some(&name), variables);
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                let name = match prefix {
                    Some(prefix) => format!("{prefix}[{index}]"),
                    None => format!("[{index}]"),
                };
                collect_json_variables(item, Some(&name), variables);
            }
        }
        Value::Null => {}
        scalar => {
            let value = scalar.as_str().map(str::to_string).unwrap_or_else(|| scalar.to_string());
            variables.push(json!({ "name": prefix.unwrap_or("value"), "value": value }));
        }
    }
}

pub async fn pl_debug_get_stack_core(state: &AppState, debug_id: &str) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_get_stack::<Value>(debug_id, Some(PL_DEBUG_QUICK_TIMEOUT)).await
}

pub async fn pl_debug_get_log_core(state: &AppState, debug_id: &str) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_get_log::<Value>(debug_id, Some(PL_DEBUG_QUICK_TIMEOUT)).await
}

/// Closes the agent-side session (best effort) and releases its dedicated pool.
pub async fn pl_debug_close_core(state: &AppState, debug_id: &str) -> Result<(), String> {
    let handle = { state.pl_debug_sessions.write().await.remove(debug_id) };
    let Some(handle) = handle else {
        return Ok(());
    };
    if let Ok(pool) = state.pool_handle(&handle.pool_key).await.ok_or("Pool not found") {
        if let PoolKind::Agent(client) = pool {
            let mut guard = client.lock().await;
            if let Err(error) = guard.pl_debug_close::<Value>(debug_id, Some(PL_DEBUG_QUICK_TIMEOUT)).await {
                log::debug!("[pl-debug] agent-side close failed for {debug_id}: {error}");
            }
        }
    }
    if let Err(error) = state
        .close_metadata_session_pool(&handle.connection_id, Some(&handle.database), &handle.client_session_id)
        .await
    {
        log::debug!("[pl-debug] closing the dedicated pool for {debug_id} failed: {error}");
    }
    Ok(())
}

/// Closes every open session, e.g. when a connection is removed.
///
/// Each close is bounded: a session whose agent client is busy inside a blocked
/// continuation (resume/step wait up to [`PL_DEBUG_TIMEOUT`]) must not hold up
/// the removal, because the pool drain that follows ends the agent process
/// anyway. The graceful close is what lets the agent release the debuggee
/// without the client-side timeout, not a precondition for removal.
pub async fn pl_debug_close_all_for_connection_core(state: &AppState, connection_id: &str) {
    let debug_ids: Vec<String> = {
        let sessions = state.pl_debug_sessions.read().await;
        sessions
            .values()
            .filter(|handle| handle.connection_id == connection_id)
            .map(|handle| handle.debug_id.clone())
            .collect()
    };
    for debug_id in debug_ids {
        if tokio::time::timeout(PL_DEBUG_REMOVAL_CLOSE_BUDGET, pl_debug_close_core(state, &debug_id)).await.is_err() {
            log::debug!(
                "[pl-debug] graceful close of {debug_id} did not finish within {PL_DEBUG_REMOVAL_CLOSE_BUDGET:?}; the pool drain will end it"
            );
        }
    }
}

/// Forgets every session of a connection without talking to the agent.
///
/// Used by the detached pool-removal path, where the agent-side close RPC would
/// block the caller: draining the pools kills the agent processes, and the
/// parked debuggee is released by the server-side `SET_TIMEOUT`. Returning the
/// dropped debug ids keeps the caller able to log what it let go.
pub async fn pl_debug_forget_all_for_connection(state: &AppState, connection_id: &str) -> Vec<String> {
    let mut sessions = state.pl_debug_sessions.write().await;
    let forgotten: Vec<String> = sessions
        .values()
        .filter(|handle| handle.connection_id == connection_id)
        .map(|handle| handle.debug_id.clone())
        .collect();
    sessions.retain(|_, handle| handle.connection_id != connection_id);
    forgotten
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::{ConnectionConfig, DatabaseType};

    fn config(db_type: DatabaseType) -> ConnectionConfig {
        serde_json::from_value(json!({
            "id": "test-connection",
            "name": "Test",
            "db_type": db_type,
            "host": "127.0.0.1",
            "port": 1521,
            "username": "user",
            "password": "secret",
        }))
        .expect("minimal connection config")
    }

    #[test]
    fn supports_pl_debug_only_for_oracle() {
        assert!(!supports_pl_debug(None));
        assert!(supports_pl_debug(Some(&config(DatabaseType::Oracle))));
        // The OceanBase Oracle debugger lives on the feature/ob-oracle-pl-debug branch.
        assert!(!supports_pl_debug(Some(&config(DatabaseType::OceanbaseOracle))));
        assert!(!supports_pl_debug(Some(&config(DatabaseType::Mysql))));
    }

    #[test]
    fn unsupported_probe_result_names_the_current_engine() {
        let result = unsupported_probe_result(Some(&config(DatabaseType::Mysql)));
        assert_eq!(result["supported"], json!(false));
        let reason = result["reason"].as_str().unwrap_or("");
        assert!(reason.contains("mysql"), "reason must name the engine: {reason}");
        assert!(reason.contains("Oracle"), "reason must say what is supported: {reason}");

        let unknown = unsupported_probe_result(None);
        assert_eq!(unknown["supported"], json!(false));
        assert!(unknown["reason"].as_str().unwrap_or("").contains("unknown"));
    }

    #[test]
    fn parse_scalar_values_empty_payload_is_no_variable() {
        assert_eq!(parse_scalar_values(""), json!([]));
        assert_eq!(parse_scalar_values("   \n "), json!([]));
    }

    #[test]
    fn parse_scalar_values_flattens_json_objects_and_arrays() {
        let payload = r#"{"local_a": 7, "nested": {"flag": true, "name": "x"}, "list": [1, {"deep": "y"}]}"#;
        let parsed = parse_scalar_values(payload);
        let entries = parsed.as_array().cloned().unwrap_or_default();
        let by_name = |name: &str| -> Value {
            entries
                .iter()
                .find(|entry| entry["name"] == json!(name))
                .unwrap_or_else(|| panic!("missing {name} in {parsed}"))
                .clone()
        };
        assert_eq!(by_name("local_a")["value"], json!("7"));
        assert_eq!(by_name("nested.flag")["value"], json!("true"));
        assert_eq!(by_name("nested.name")["value"], json!("x"));
        assert_eq!(by_name("list[0]")["value"], json!("1"));
        assert_eq!(by_name("list[1].deep")["value"], json!("y"));
    }

    #[test]
    fn parse_scalar_values_bare_json_string_stays_raw_text() {
        // Only object/array payloads are treated as JSON: a bare quoted scalar is not a
        // GET_VALUES shape either agent produces, so it must survive verbatim instead of
        // being half-parsed.
        assert_eq!(parse_scalar_values("\"just text\""), json!([{ "name": "values", "value": "\"just text\"" }]));
    }

    #[test]
    fn parse_scalar_values_legacy_star_format_carries_type_and_value() {
        let parsed = parse_scalar_values("*V_COUNT*NUMBER*42*V_NAME*VARCHAR2*hello");
        assert_eq!(
            parsed,
            json!([
                { "name": "V_COUNT", "type": "NUMBER", "value": "42" },
                { "name": "V_NAME", "type": "VARCHAR2", "value": "hello" },
            ])
        );
    }

    #[test]
    fn parse_scalar_values_legacy_partial_groups_still_report_the_name() {
        assert_eq!(parse_scalar_values("*V_ONLY"), json!([{ "name": "V_ONLY" }]));
        assert_eq!(parse_scalar_values("*V_TYPED*DATE"), json!([{ "name": "V_TYPED", "type": "DATE" }]));
    }

    #[test]
    fn parse_scalar_values_unrecognised_payload_survives_as_raw_text() {
        let parsed = parse_scalar_values("some server specific dump");
        assert_eq!(parsed, json!([{ "name": "values", "value": "some server specific dump" }]));
    }
}
