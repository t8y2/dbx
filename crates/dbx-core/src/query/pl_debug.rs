//! PL/SQL debugging orchestration for OceanBase Oracle connections.
//!
//! The Java agent owns the two JDBC debug connections and all `DBMS_DEBUG`
//! state; this module keeps the routing table (debug id → the dedicated agent
//! session that owns it) and exposes the operations the Tauri commands call.
//!
//! Each debug session runs on its own client session id, so its agent
//! instance is isolated from metadata/query pools: continuation calls block on
//! the server until the debuggee reaches its next stop, and that blocking
//! must never occupy the pool every other request shares. Closing a session
//! releases the agent-side connections and tears the isolated pool down.

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
    config.is_some_and(|config| matches!(config.db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle))
}

fn unsupported_probe_result(config: Option<&ConnectionConfig>) -> Value {
    let scope = config.map(|config| config.db_type.as_str()).unwrap_or("unknown");
    json!({
        "supported": false,
        "reason": format!(
            "PL/SQL debugging is only available for Oracle and OceanBase Oracle mode connections (current: {scope})"
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
        return Err("PL/SQL debugging is only available for Oracle and OceanBase Oracle mode connections".to_string());
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

pub async fn pl_debug_resume_core(state: &AppState, debug_id: &str) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    guard.pl_debug_resume::<Value>(debug_id, Some(PL_DEBUG_TIMEOUT)).await
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

pub async fn pl_debug_get_variables_core(state: &AppState, debug_id: &str) -> Result<Value, String> {
    let client = pl_debug_client(state, debug_id).await?;
    let mut guard = client.lock().await;
    let result = guard.pl_debug_get_variables::<Value>(debug_id, Some(PL_DEBUG_QUICK_TIMEOUT)).await?;
    // OceanBase serializes GET_VALUES as a JSON object; Oracle returns the
    // legacy `*name*type*value` delimited text. Normalize both here so the
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
    // OceanBase: a JSON object mapping variable names to values/types.
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
        if let Err(error) = pl_debug_close_core(state, &debug_id).await {
            log::debug!("[pl-debug] closing session {debug_id} failed: {error}");
        }
    }
}
