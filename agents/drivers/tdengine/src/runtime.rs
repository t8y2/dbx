use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{anyhow, bail, Context, Result};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex, OwnedSemaphorePermit, RwLock, Semaphore};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::driver::TdengineDriver;
use crate::model::{
    ConnectParams, HandshakeResult, RpcError, RpcRequest, RpcResponse, StructuredError, LEGACY_SESSION_ID,
    MAX_AGENT_SESSIONS, MAX_CONCURRENT_REQUESTS, PROTOCOL_VERSION,
};

struct RuntimeServer {
    sessions: RwLock<HashMap<String, Arc<AgentSession>>>,
    session_slots: Arc<Semaphore>,
    request_slots: Arc<Semaphore>,
}

struct AgentSession {
    driver: Mutex<TdengineDriver>,
    active: StdMutex<Option<ActiveOperation>>,
    next_operation_id: AtomicU64,
    _slot: OwnedSemaphorePermit,
}

struct ActiveOperation {
    id: u64,
    token: CancellationToken,
}

struct OperationGuard<'a> {
    session: &'a AgentSession,
    id: u64,
}

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        let mut active = self.session.active.lock().expect("active operation lock poisoned");
        if active.as_ref().is_some_and(|operation| operation.id == self.id) {
            *active = None;
        }
    }
}

impl AgentSession {
    fn begin_operation(&self) -> (CancellationToken, OperationGuard<'_>) {
        let id = self.next_operation_id.fetch_add(1, Ordering::Relaxed);
        let token = CancellationToken::new();
        *self.active.lock().expect("active operation lock poisoned") =
            Some(ActiveOperation { id, token: token.clone() });
        (token, OperationGuard { session: self, id })
    }

    fn cancel(&self) {
        if let Some(operation) = self.active.lock().expect("active operation lock poisoned").as_ref() {
            operation.token.cancel();
        }
    }
}

pub async fn run() -> Result<()> {
    let runtime = Arc::new(RuntimeServer::new());
    let (responses, mut response_rx) = mpsc::unbounded_channel::<RpcResponse>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        stdout.write_all(b"{\"ready\":true}\n").await?;
        stdout.flush().await?;
        while let Some(response) = response_rx.recv().await {
            let line = serde_json::to_vec(&response)?;
            stdout.write_all(&line).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
        Ok::<(), anyhow::Error>(())
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut requests = JoinSet::new();
    while let Some(line) = lines.next_line().await? {
        while requests.try_join_next().is_some() {}
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parsed = serde_json::from_str::<RpcRequest>(line);
        if parsed.as_ref().is_ok_and(|request| request.method == "shutdown") {
            let response = match parsed {
                Ok(request) => handle_request(runtime.clone(), request).await,
                Err(error) => error_response(Value::Null, "request", None, error.into()),
            };
            responses.send(response).map_err(|_| anyhow!("TDengine response writer stopped"))?;
            while requests.join_next().await.is_some() {}
            break;
        }
        let request_permit = if parsed.as_ref().is_ok_and(|request| is_capacity_exempt(&request.method)) {
            None
        } else {
            match runtime.request_slots.clone().try_acquire_owned() {
                Ok(permit) => Some(permit),
                Err(_) => {
                    let response = match parsed {
                        Ok(request) => error_response(
                            if request.id.is_null() { json!(1) } else { request.id },
                            &request.method,
                            session_id(&request.params),
                            anyhow!("agent request capacity is temporarily exhausted"),
                        ),
                        Err(error) => error_response(Value::Null, "request", None, error.into()),
                    };
                    responses.send(response).map_err(|_| anyhow!("TDengine response writer stopped"))?;
                    continue;
                }
            }
        };
        let runtime = runtime.clone();
        let responses = responses.clone();
        requests.spawn(async move {
            let _request_permit = request_permit;
            let response = match parsed {
                Ok(request) => handle_request(runtime, request).await,
                Err(error) => error_response(Value::Null, "request", None, error.into()),
            };
            let _ = responses.send(response);
        });
    }
    runtime.close_all_sessions().await;
    while requests.join_next().await.is_some() {}
    drop(responses);
    writer.await.context("TDengine response writer task failed")??;
    Ok(())
}

async fn handle_request(runtime: Arc<RuntimeServer>, request: RpcRequest) -> RpcResponse {
    let id = if request.id.is_null() { json!(1) } else { request.id.clone() };
    let session_id = session_id(&request.params);
    match runtime.dispatch(&request.method, request.params).await {
        Ok(result) => RpcResponse { jsonrpc: "2.0", id, result: Some(result), error: None },
        Err(error) => error_response(id, &request.method, session_id, error),
    }
}

impl RuntimeServer {
    fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            session_slots: Arc::new(Semaphore::new(MAX_AGENT_SESSIONS)),
            request_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)),
        }
    }

    async fn dispatch(&self, method: &str, params: Value) -> Result<Value> {
        match method {
            "handshake" => serialize(HandshakeResult {
                protocol_version: PROTOCOL_VERSION,
                agent_protocol_version: PROTOCOL_VERSION,
                capabilities: vec![
                    "connect",
                    "test_connection",
                    "metadata",
                    "query",
                    "paged_query",
                    "transaction",
                    "ddl",
                    "multi_session",
                    "structured_error_v1",
                ],
            }),
            "open_session" => {
                let id = required_string(&params, "agentSessionId")?;
                let connect = decode::<ConnectParams>(&params)?;
                self.open_session(&id, connect).await?;
                Ok(json!({"ok": true}))
            }
            "close_session" => {
                self.close_session(&required_string(&params, "agentSessionId")?).await?;
                Ok(json!({"ok": true}))
            }
            "validate_session" => {
                let session = self.session(&required_string(&params, "agentSessionId")?).await?;
                let driver = session.driver.lock().await;
                let (token, _operation) = session.begin_operation();
                driver.validate_connection(&token).await?;
                Ok(json!({"ok": true}))
            }
            "cancel_session" => {
                self.session(&required_string(&params, "agentSessionId")?).await?.cancel();
                Ok(json!({"ok": true}))
            }
            "test_connection" => {
                let database_info = TdengineDriver::test_connection(decode::<ConnectParams>(&params)?).await?;
                Ok(json!({"ok": true, "databaseInfo": database_info}))
            }
            "connect" => {
                self.close_session(LEGACY_SESSION_ID).await?;
                self.open_session(LEGACY_SESSION_ID, decode::<ConnectParams>(&params)?).await?;
                Ok(json!({"ok": true}))
            }
            "disconnect" => {
                self.close_session(LEGACY_SESSION_ID).await?;
                Ok(json!({"ok": true}))
            }
            "shutdown" => {
                self.close_all_sessions().await;
                Ok(json!({"ok": true}))
            }
            _ => {
                if !is_driver_method(method) {
                    bail!("unknown method: {method}");
                }
                let id = session_id(&params).unwrap_or_else(|| LEGACY_SESSION_ID.to_string());
                let session = self.session(&id).await?;
                let mut driver = session.driver.lock().await;
                let (token, _operation) = session.begin_operation();
                dispatch_driver(&mut driver, method, &params, &token).await
            }
        }
    }

    async fn open_session(&self, id: &str, params: ConnectParams) -> Result<()> {
        if id.trim().is_empty() {
            bail!("agentSessionId is required");
        }
        {
            let sessions = self.sessions.read().await;
            if sessions.contains_key(id) {
                bail!("agent session already exists: {id}");
            }
        }
        let slot = self
            .session_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| anyhow!("agent session limit reached: {MAX_AGENT_SESSIONS}"))?;
        let mut driver = TdengineDriver::new();
        driver.connect(params).await?;
        let session = Arc::new(AgentSession {
            driver: Mutex::new(driver),
            active: StdMutex::new(None),
            next_operation_id: AtomicU64::new(1),
            _slot: slot,
        });
        let mut sessions = self.sessions.write().await;
        if sessions.contains_key(id) {
            bail!("agent session already exists: {id}");
        }
        sessions.insert(id.to_string(), session);
        Ok(())
    }

    async fn session(&self, id: &str) -> Result<Arc<AgentSession>> {
        self.sessions.read().await.get(id).cloned().ok_or_else(|| anyhow!("agent session not found: {id}"))
    }

    async fn close_session(&self, id: &str) -> Result<()> {
        let session = self.sessions.write().await.remove(id);
        let Some(session) = session else {
            return Ok(());
        };
        session.cancel();
        session.driver.lock().await.disconnect().await;
        Ok(())
    }

    async fn close_all_sessions(&self) {
        let sessions = {
            let mut sessions = self.sessions.write().await;
            std::mem::take(&mut *sessions)
        };
        for (_, session) in sessions {
            session.cancel();
            session.driver.lock().await.disconnect().await;
        }
    }
}

async fn dispatch_driver(
    driver: &mut TdengineDriver,
    method: &str,
    params: &Value,
    token: &CancellationToken,
) -> Result<Value> {
    let scope = database_scope(params);
    match method {
        "validate_connection" => {
            driver.validate_connection(token).await?;
            Ok(json!({"ok": true}))
        }
        "connection_info" => serialize(driver.connection_info()?),
        "list_databases" => serialize(driver.list_databases(token).await?),
        "list_schemas" => serialize(driver.list_schemas()),
        "list_tables" => serialize(driver.list_tables(&scope, decode(params)?, token).await?),
        "get_table_comment" => serialize(driver.get_table_comment(&scope, &required_string(params, "table")?).await?),
        "list_objects" => serialize(driver.list_objects(&scope, decode(params)?, token).await?),
        "list_data_types" => serialize(driver.list_data_types()),
        "completion_assistant_search_v1" => {
            serialize(driver.completion_assistant_search(decode(params)?, token).await?)
        }
        "get_columns" => serialize(driver.get_columns(&scope, &required_string(params, "table")?, token).await?),
        "list_indexes" | "list_foreign_keys" | "list_triggers" | "list_constraints" | "list_partitions"
        | "list_subpartitions" => Ok(json!([])),
        "get_object_source" => serialize(
            driver
                .get_object_source(
                    &scope,
                    &required_string(params, "name")?,
                    &required_string(params, "object_type")?,
                    token,
                )
                .await?,
        ),
        "get_table_ddl" => serialize(driver.get_table_ddl(&scope, &required_string(params, "table")?, token).await?),
        "get_explain_info" => Ok(json!({
            "plan": driver
                .get_explain_info(
                    &required_string(params, "sql")?,
                    token,
                    optional_u64(params, "timeoutSecs").unwrap_or(0),
                )
                .await?,
            "has_actual_stats": false,
        })),
        "execute_query" => serialize(driver.execute_query(decode(params)?, token).await?),
        "execute_query_page" | "start_table_read" => {
            serialize(driver.execute_query_page(decode(params)?, token).await?)
        }
        "fetch_query_page" | "fetch_table_read_page" => serialize(
            driver
                .fetch_query_page(
                    &required_string(params, "sessionId")?,
                    optional_usize(params, "pageSize").unwrap_or(100),
                    optional_u64(params, "timeoutSecs").unwrap_or(0),
                    token,
                )
                .await?,
        ),
        "close_query_session" | "close_table_read_session" => {
            serialize(driver.close_query_session(&required_string(params, "sessionId")?))
        }
        "execute_transaction" | "execute_batch" => serialize(
            driver
                .execute_statements(
                    string_array(params, "statements")?,
                    &scope,
                    optional_u64(params, "timeoutSecs").unwrap_or(0),
                    token,
                )
                .await?,
        ),
        "disconnect" => {
            driver.disconnect().await;
            Ok(json!({"ok": true}))
        }
        "shutdown" => {
            driver.disconnect().await;
            Ok(json!({"ok": true}))
        }
        _ => bail!("unknown method: {method}"),
    }
}

fn decode<T: DeserializeOwned>(params: &Value) -> Result<T> {
    serde_json::from_value(params.clone()).with_context(|| "invalid TDengine agent request parameters")
}

fn serialize<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(anyhow::Error::from)
}

fn required_string(params: &Value, key: &str) -> Result<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("{key} is required"))
}

fn optional_string(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn optional_usize(params: &Value, key: &str) -> Option<usize> {
    params.get(key).and_then(Value::as_u64).and_then(|value| usize::try_from(value).ok())
}

fn optional_u64(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(Value::as_u64)
}

fn string_array(params: &Value, key: &str) -> Result<Vec<String>> {
    params
        .get(key)
        .cloned()
        .ok_or_else(|| anyhow!("{key} is required"))
        .and_then(|value| serde_json::from_value(value).map_err(anyhow::Error::from))
}

fn database_scope(params: &Value) -> String {
    let schema = optional_string(params, "schema");
    if schema.trim().is_empty() {
        optional_string(params, "database")
    } else {
        schema
    }
}

fn session_id(params: &Value) -> Option<String> {
    params.get("agentSessionId").and_then(Value::as_str).map(str::to_string)
}

fn is_driver_method(method: &str) -> bool {
    matches!(
        method,
        "validate_connection"
            | "connection_info"
            | "list_databases"
            | "list_schemas"
            | "list_tables"
            | "get_table_comment"
            | "list_objects"
            | "list_data_types"
            | "completion_assistant_search_v1"
            | "get_columns"
            | "list_indexes"
            | "list_foreign_keys"
            | "list_triggers"
            | "list_constraints"
            | "list_partitions"
            | "list_subpartitions"
            | "get_object_source"
            | "get_table_ddl"
            | "get_explain_info"
            | "execute_query"
            | "execute_query_page"
            | "start_table_read"
            | "fetch_query_page"
            | "fetch_table_read_page"
            | "close_query_session"
            | "close_table_read_session"
            | "execute_transaction"
            | "execute_batch"
    )
}

fn is_capacity_exempt(method: &str) -> bool {
    matches!(method, "handshake" | "cancel_session" | "close_session" | "disconnect")
}

fn error_response(id: Value, method: &str, session_id: Option<String>, error: anyhow::Error) -> RpcResponse {
    let message = format!("{error:#}");
    let lower = message.to_ascii_lowercase();
    let stage = error_stage(method);
    let (category, retryable, session_disposition) = if lower.contains("cancel") {
        ("canceled", false, "quarantine")
    } else if lower.contains("timed out") || lower.contains("timeout") {
        ("timeout", false, "quarantine")
    } else if lower.contains("memory exhausted")
        || lower.contains("resource exhausted")
        || lower.contains("session limit reached")
        || lower.contains("request capacity")
    {
        ("resource", true, "keep")
    } else if lower.contains("agent session not found")
        || lower.contains("query session not found")
        || lower.contains("agent session already exists")
        || lower.contains("unknown method")
        || lower.contains("invalid tdengine agent request parameters")
        || lower.contains(" is required")
    {
        ("protocol", false, "keep")
    } else if stage == "connect" || stage == "validate" || lower.contains("connection") || lower.contains("websocket") {
        (
            "connection",
            stage == "connect" || stage == "validate",
            if stage == "connect" { "keep" } else { "quarantine" },
        )
    } else if matches!(stage, "execute" | "fetch") {
        ("sql", false, "keep")
    } else {
        ("protocol", false, "keep")
    };
    RpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(RpcError {
            code: -1,
            message,
            data: Some(StructuredError {
                category,
                retryable,
                session_disposition,
                stage,
                contract_version: 1,
                operation_outcome: if matches!(stage, "request" | "connect" | "validate") {
                    "not_started"
                } else {
                    "unknown"
                },
                agent_session_id: session_id,
                exception_class: Some("dbx_tdengine_driver::Error".into()),
            }),
        }),
    }
}

fn error_stage(method: &str) -> &'static str {
    match method {
        "request" | "handshake" => "request",
        "connect" | "open_session" | "test_connection" => "connect",
        "validate_connection" | "validate_session" => "validate",
        "cancel_session" => "cancel",
        "close_session" | "disconnect" | "close_query_session" | "close_table_read_session" | "shutdown" => "close",
        "fetch_query_page" | "fetch_table_read_page" => "fetch",
        _ => "execute",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_errors_keep_stage_and_outcome_consistent() {
        let response = error_response(json!(1), "open_session", Some("s1".into()), anyhow!("connection refused"));
        let data = response.error.unwrap().data.unwrap();
        assert_eq!(data.category, "connection");
        assert_eq!(data.stage, "connect");
        assert_eq!(data.operation_outcome, "not_started");
        assert_eq!(data.agent_session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn classifies_tdengine_execution_failures_as_sql_errors() {
        let response = error_response(json!(1), "execute_query", Some("s1".into()), anyhow!("invalid function"));
        let data = response.error.unwrap().data.unwrap();
        assert_eq!(data.category, "sql");
        assert_eq!(data.stage, "execute");
        assert_eq!(data.operation_outcome, "unknown");
    }

    #[test]
    fn keeps_invalid_request_parameters_as_protocol_errors() {
        let response = error_response(
            json!(1),
            "execute_query",
            Some("s1".into()),
            anyhow!("invalid TDengine agent request parameters"),
        );
        assert_eq!(response.error.unwrap().data.unwrap().category, "protocol");
    }

    #[test]
    fn keeps_missing_query_sessions_as_protocol_errors() {
        let response =
            error_response(json!(1), "fetch_query_page", Some("s1".into()), anyhow!("query session not found"));
        let data = response.error.unwrap().data.unwrap();
        assert_eq!(data.category, "protocol");
        assert_eq!(data.stage, "fetch");
    }

    #[test]
    fn quarantines_connections_lost_during_execution() {
        let response = error_response(json!(1), "execute_query", Some("s1".into()), anyhow!("connection reset"));
        let data = response.error.unwrap().data.unwrap();
        assert_eq!(data.category, "connection");
        assert_eq!(data.session_disposition, "quarantine");
        assert!(!data.retryable);
    }

    #[test]
    fn tdengine_uses_database_when_schema_is_empty() {
        assert_eq!(database_scope(&json!({"database": "power", "schema": ""})), "power");
        assert_eq!(database_scope(&json!({"database": "power", "schema": "metrics"})), "metrics");
    }

    #[test]
    fn metadata_constraints_ignore_protocol_session_fields() {
        let constraints: crate::model::MetadataListConstraints = decode(&json!({
            "agentSessionId": "session-1",
            "filter": "meter",
            "limit": 10,
        }))
        .unwrap();
        assert_eq!(constraints.filter, "meter");
        assert_eq!(constraints.limit, 10);
    }

    #[test]
    fn query_options_accept_protocol_camel_case_fields() {
        let options: crate::model::QueryOptions =
            decode(&json!({"sql": "SELECT 1", "pageSize": 25, "maxRows": 100})).unwrap();
        assert_eq!(options.page_size, 25);
        assert_eq!(options.max_rows, 100);
    }

    #[test]
    fn completion_request_accepts_null_optional_fields() {
        let request: crate::model::CompletionAssistantRequest = decode(&json!({
            "connection_id": "connection-1",
            "database": "power",
            "schema": null,
            "object_kinds": ["table"],
            "max_results": null,
            "parent_schema": null,
            "parent_name": null,
            "match_mode": null,
        }))
        .unwrap();
        assert_eq!(request.schema, "");
        assert_eq!(request.max_results, 0);
        assert_eq!(request.parent_schema, "");
        assert_eq!(request.parent_name, "");
        assert_eq!(request.match_mode, "");
    }

    #[test]
    fn cancel_session_cancels_the_active_operation() {
        let slot = Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap();
        let session = AgentSession {
            driver: Mutex::new(TdengineDriver::new()),
            active: StdMutex::new(None),
            next_operation_id: AtomicU64::new(1),
            _slot: slot,
        };
        let (token, operation) = session.begin_operation();
        session.cancel();
        assert!(token.is_cancelled());
        drop(operation);
        assert!(session.active.lock().unwrap().is_none());
    }

    #[test]
    fn session_slots_bound_connects_in_flight_and_open_sessions() {
        let runtime = RuntimeServer::new();
        let permits = (0..MAX_AGENT_SESSIONS)
            .map(|_| runtime.session_slots.clone().try_acquire_owned().unwrap())
            .collect::<Vec<_>>();
        assert!(runtime.session_slots.clone().try_acquire_owned().is_err());
        drop(permits);
        assert!(runtime.session_slots.clone().try_acquire_owned().is_ok());
    }

    #[test]
    fn request_slots_bound_non_control_work_without_blocking_cancellation() {
        let runtime = RuntimeServer::new();
        let permits = (0..MAX_CONCURRENT_REQUESTS)
            .map(|_| runtime.request_slots.clone().try_acquire_owned().unwrap())
            .collect::<Vec<_>>();
        assert!(runtime.request_slots.clone().try_acquire_owned().is_err());
        assert!(is_capacity_exempt("cancel_session"));
        assert!(is_capacity_exempt("close_session"));
        assert!(!is_capacity_exempt("execute_query"));
        drop(permits);
    }
}
