#![recursion_limit = "256"]

use dbx_core::connection::{task_client_session_id, AppState, PoolKind};
use dbx_core::db::agent_driver::{AgentDriverClient, AgentLaunchSpec, PooledAgentClient};
use dbx_core::schema::native_jobs::*;
use dbx_types::native_jobs::*;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::Arc;
use std::time::Duration;

fn query_result(columns: &[&str], rows: Value) -> Value {
    json!({"columns":columns,"rows":rows,"affected_rows":0,"execution_time_ms":0})
}

fn definition(enabled: bool, ep: i32, valid: &str) -> Value {
    query_result(
        &["DBX_JOB_ID", "NAME", "USERNAME", "CREATETIME", "ENABLE", "EP_SEQNO", "VALID", "SYS_FLAG"],
        json!([["41", "Job_1", "Owner", "creation", i32::from(enabled), ep, valid, 0]]),
    )
}

// A real child stdio peer exercises Core's existing Agent corridor. Only this external boundary is
// simulated; native_job_apply_core owns pool lookup, physical authorization, reads and cleanup.
#[test]
fn native_job_configuration_rpc_fixture() {
    let Ok(path) = std::env::var("DBX_NATIVE_JOB_RPC_LOG") else { return };
    let mode = std::env::var("DBX_NATIVE_JOB_RPC_MODE").unwrap();
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    let mut enabled = false;
    let mut ep = 0;
    let mut valid = "Y";
    let mut operation = String::new();
    let token = "fixture-owned-physical-connection";
    let mut leased = false;
    println!("\n{}", json!({"ready":true}));
    std::io::stdout().flush().unwrap();
    for line in std::io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        writeln!(log, "{request}").unwrap();
        log.flush().unwrap();
        let method = request["method"].as_str().unwrap();
        let params = &request["params"];
        let authorized = !leased
            || !matches!(method, "connection_info" | "execute_query")
            || (params["nativeJobOperationId"] == operation && params["nativeJobSessionToken"] == token);
        let value = if !authorized {
            json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"fixture requires owned physical token"}})
        } else {
            let result = match method {
                "handshake" => json!({"protocolVersion":2,"agentProtocolVersion":2,
                    "capabilities":["connect","metadata","query","native_job_session_v1"]}),
                "connection_info" => json!({"databaseInfo":{
                    "productName":"DM DBMS",
                    "productVersion":if leased && mode == "changed-version" { "different" } else { "8.1.fixture" },
                    "currentDatabase":if leased && mode == "changed-database" { "OTHER" } else { "JOBDB" }
                }}),
                "open_native_job_session" => {
                    operation = params["operationId"].as_str().unwrap().into();
                    leased = true;
                    json!({"operationId":operation,"sessionToken":token,
                        "phase":if mode == "open-unknown" { "unknown" } else { "opened" }})
                }
                "close_native_job_session" => {
                    assert_eq!(params["operationId"], operation);
                    if mode != "open-unknown" {
                        assert_eq!(params["sessionToken"], token);
                    } else {
                        assert!(params.get("sessionToken").is_none());
                    }
                    leased = false;
                    json!({"operationId":operation,"sessionToken":token,
                        "phase":if mode == "close-unknown" { "unknown" } else { "closed" }})
                }
                "execute_query" => {
                    let sql = params["sql"].as_str().unwrap();
                    if sql == "SELECT USER AS DBX_SESSION_USER FROM DUAL" {
                        query_result(
                            &["DBX_SESSION_USER"],
                            json!([[if leased && mode == "changed-user" { "Other" } else { "Owner" }]]),
                        )
                    } else if sql.starts_with("DECLARE") {
                        if sql.contains("SP_ENABLE_JOB('Job_1', 0)") {
                            enabled = false;
                        }
                        if sql.contains("SP_JOB_CONFIG_START(") {
                            valid = "N";
                        }
                        if sql.contains("SP_JOB_SET_EP_SEQNO('Job_1', 2)") {
                            ep = 2;
                        }
                        if sql.contains("SP_JOB_CONFIG_COMMIT(") {
                            valid = "Y";
                        }
                        query_result(&[], json!([]))
                    } else if sql.contains("AS DBX_CREATED_AT") {
                        query_result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([["41", "creation"]]))
                    } else if sql.contains("FROM SYSJOB.SYSJOBS J") {
                        definition(enabled, ep, valid)
                    } else {
                        query_result(&["JOBID"], json!([]))
                    }
                }
                _ => json!({}),
            };
            json!({"jsonrpc":"2.0","id":request["id"],"result":result})
        };
        println!("{value}");
        std::io::stdout().flush().unwrap();
        if method == "shutdown" {
            break;
        }
    }
}

async fn run(mode: &str) -> (NativeJobOperationStatus, Vec<Value>) {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("requests.jsonl");
    let storage = dbx_core::persistence::test_storage::open(&dir.path().join("state.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        dir.path().join("agents"),
        "test",
    ));
    state.configs.write().await.insert(
        "c".into(),
        serde_json::from_value(json!({
            "id":"c","name":"fixture","db_type":"dameng","host":"127.0.0.1","port":1,
            "username":"Owner","password":"","query_timeout_secs":2,"connect_timeout_secs":2
        }))
        .unwrap(),
    );
    let context = native_job_open_context_with(&state, "c", "", |_| {
        std::future::ready(Ok(NativeJobRuntimeIdentity {
            database_info: Some(
                serde_json::from_value(json!({
                    "productName":"DM DBMS", "productVersion":"8.1.fixture", "currentDatabase":"JOBDB"
                }))
                .unwrap(),
            ),
            session_user: "Owner".into(),
        }))
    })
    .await
    .unwrap();
    let target = NativeJobRef::DamengNative { scope: context.scope, job_id: "41".into(), name: "Job_1".into() };
    let read = |target: NativeJobRef| {
        let state = state.clone();
        async move {
            native_job_read_with(&state, &target, |query| {
                std::future::ready(Ok(if query.sql.contains("AS DBX_CREATED_AT") {
                    query_result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([["41", "creation"]]))
                } else if query.source == "SYSJOB.SYSJOBS" {
                    definition(false, 0, "Y")
                } else {
                    query_result(&["JOBID"], json!([]))
                }))
            })
            .await
        }
    };
    let initial = read(target.clone()).await.unwrap();
    let prepared = native_job_prepare_with(
        &state,
        NativeJobMutation {
            target,
            baseline: initial.snapshot.revision,
            change: NativeJobChange::Update {
                final_enabled: None,
                argument_target: None,
                attributes: vec![NativeJobAttributeChange {
                    name: "EP_SEQNO".into(),
                    change: NativeJobFieldChange::Set { value: json!(2) },
                }],
                arguments: vec![],
            },
        },
        read,
    )
    .await
    .unwrap();
    let launch = AgentLaunchSpec::new(std::env::current_exe().unwrap())
        .with_args(["--exact", "native_job_configuration_rpc_fixture", "--nocapture", "--test-threads=1"])
        .with_env(vec![
            ("DBX_NATIVE_JOB_RPC_LOG".into(), log.to_string_lossy().into_owned()),
            ("DBX_NATIVE_JOB_RPC_MODE".into(), mode.into()),
        ]);
    let mut client = AgentDriverClient::spawn(launch).await.unwrap();
    assert!(client.try_optional_handshake("test").await.is_some());
    let client = Arc::new(PooledAgentClient::new(client));
    let session_id = task_client_session_id("native-job-operation", &prepared.operation_id).replace(':', "_");
    let key = format!("c:session:{session_id}:role:metadata");
    state.update_connection_pools(|pools| pools.insert(key.clone(), PoolKind::Agent(client.clone()))).await;
    native_job_apply_core(state.clone(), &prepared.plan_id).unwrap();
    let status = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status = native_job_status(&state, &prepared.operation_id);
            if status.state == NativeJobOperationState::Finished {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let removed = state.pool_handle(&key).await.is_none();
    client.lock().await.shutdown().await;
    state.shutdown(Duration::from_secs(2)).await;
    assert!(removed, "owned metadata route was not removed; operation reason: {:?}", status.reason);
    let requests =
        std::fs::read_to_string(log).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    (status, requests)
}

#[tokio::test]
async fn production_owned_pool_binds_all_configuration_reads_and_writes_to_the_native_lease() {
    let (status, requests) = run("normal").await;
    assert!(status.outcome == NativeJobOperationOutcome::Verified, "{:?}", status.reason);
    let opened = requests.iter().position(|request| request["method"] == "open_native_job_session").unwrap();
    let closed = requests.iter().position(|request| request["method"] == "close_native_job_session").unwrap();
    let owned = &requests[opened + 1..closed];
    assert!(owned.iter().any(|request| request["method"] == "connection_info"));
    assert!(owned.iter().filter(|request| request["method"] == "execute_query").count() > 10);
    assert!(owned.iter().all(|request| request["params"]["nativeJobOperationId"] == status.operation_id
        && request["params"]["nativeJobSessionToken"] == "fixture-owned-physical-connection"));
    assert!(requests.iter().skip(closed + 1).all(|request| request["method"] != "execute_query"));
    assert!(!serde_json::to_string(&status).unwrap().contains("fixture-owned-physical-connection"));
}

#[tokio::test]
async fn production_cleanup_does_not_erase_a_native_unknown_close_with_a_successful_disconnect() {
    let (status, requests) = run("close-unknown").await;
    assert!(status.outcome == NativeJobOperationOutcome::Unknown);
    assert_eq!(status.reason.as_deref(), Some("native_job_session_cleanup_unknown"));
    assert!(requests.iter().any(|request| request["method"] == "disconnect"));
}

#[tokio::test]
async fn production_unknown_open_disposes_by_operation_id_without_guessing_a_token_or_writing_sql() {
    let (status, requests) = run("open-unknown").await;
    assert!(status.outcome == NativeJobOperationOutcome::NotApplied);
    assert!(requests.iter().any(|request| request["method"] == "close_native_job_session"));
    assert!(!requests
        .iter()
        .any(|request| request["params"]["sql"].as_str().is_some_and(|sql| sql.starts_with("DECLARE"))));
}

#[tokio::test]
async fn production_revalidates_the_actual_login_after_reserving_the_physical_connection() {
    let (status, requests) = run("changed-user").await;
    assert!(status.outcome == NativeJobOperationOutcome::NotApplied);
    assert_eq!(status.reason.as_deref(), Some("native_job_runtime_context_changed"));
    assert!(!requests
        .iter()
        .any(|request| request["params"]["sql"].as_str().is_some_and(|sql| sql.starts_with("DECLARE"))));
}

#[tokio::test]
async fn production_rejects_changed_database_or_version_on_the_reserved_physical_connection() {
    for mode in ["changed-database", "changed-version"] {
        let (status, requests) = run(mode).await;
        assert!(status.outcome == NativeJobOperationOutcome::NotApplied);
        assert_eq!(status.reason.as_deref(), Some("native_job_runtime_context_changed"));
        assert!(!requests
            .iter()
            .any(|request| request["params"]["sql"].as_str().is_some_and(|sql| sql.starts_with("DECLARE"))));
    }
}
