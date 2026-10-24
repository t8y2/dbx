#![recursion_limit = "256"]

use dbx_core::connection::{task_client_session_id, AppState, PoolKind};
use dbx_core::db::agent_driver::{AgentDriverClient, AgentLaunchSpec, AgentRuntimeClient, PooledAgentClient};
use dbx_core::schema::native_jobs::*;
use dbx_types::native_jobs::*;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::Arc;
use std::time::Duration;

#[test]
fn native_job_legacy_rpc_fixture() {
    let Ok(path) = std::env::var("DBX_LEGACY_RPC_LOG") else { return };
    let mode = std::env::var("DBX_LEGACY_RPC_MODE").unwrap();
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    println!("\n{}", json!({"ready":true}));
    std::io::stdout().flush().unwrap();
    let mut operation = String::new();
    for line in std::io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        writeln!(log, "{request}").unwrap();
        log.flush().unwrap();
        let method = request["method"].as_str().unwrap();
        let result = match method {
            "handshake" => json!({"protocolVersion":2,"agentProtocolVersion":2,"capabilities":[
                "connect","metadata","query","multi_session",if mode=="old-package" {"native_job_legacy_v1"} else {"native_job_legacy_ob_v1"}
            ]}),
            "connection_info" => {
                json!({"databaseInfo":{"productName":"OceanBase","productVersion":"4.2.5.7","currentDatabase":"ORACLETEST","compatibilityMode":"oracle"}})
            }
            "execute_query" => {
                json!({"columns":["DBX_SESSION_USER"],"rows":[["Owner"]],"affected_rows":0,"execution_time_ms":0})
            }
            "prepare_legacy_job" => {
                operation = request["params"]["operationId"].as_str().unwrap().into();
                let mut result = json!({"operationId":operation,"phase":"rolled_back","jobId":"41"});
                if mode != "lost-terminal" {
                    result["disposalConfirmed"] = json!(mode != "close-failed");
                }
                result
            }
            "legacy_job_status" => {
                json!({"operationId":operation,"phase":"rolled_back","jobId":"41","disposalConfirmed":mode!="close-failed"})
            }
            // The real MultiSession runtime accepts logical close before physical cleanup finishes.
            "close_session" | "open_session" | "shutdown" => json!({"ok":true}),
            _ => panic!("unexpected native dispatch: {method}"),
        };
        println!("{}", json!({"jsonrpc":"2.0","id":request["id"],"result":result}));
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
            "id":"c","name":"fixture","db_type":"oceanbase-oracle","host":"127.0.0.1","port":1,
            "username":"Owner","password":"","query_timeout_secs":2,"connect_timeout_secs":2
        }))
        .unwrap(),
    );
    let context=native_job_open_context_with(&state,"c","",|_|std::future::ready(Ok(NativeJobRuntimeIdentity{
        database_info:Some(serde_json::from_value(json!({"productName":"OceanBase","productVersion":"4.2.5.7","currentDatabase":"ORACLETEST","compatibilityMode":"oracle"})).unwrap()),
        session_user:"Owner".into(),
    }))).await.unwrap();
    let plan = native_job_prepare_request_with(
        &state,
        NativeJobRequest::Create {
            scope: context.scope,
            definition: NativeJobCreateDefinition::Legacy(NativeJobLegacyCreate {
                what: "private_call();".into(),
                next_date: "2026-10-21 10:20:30".into(),
                interval: "SYSDATE+1".into(),
                enabled: false,
                instance: 0,
                schema: "Owner".into(),
                zone: Some("zone1".into()),
            }),
        },
        |_| std::future::ready(Err("preview must not query")),
    )
    .await
    .unwrap();
    let launch = AgentLaunchSpec::new(std::env::current_exe().unwrap())
        .with_args(["--exact", "native_job_legacy_rpc_fixture", "--nocapture", "--test-threads=1"])
        .with_env(vec![
            ("DBX_LEGACY_RPC_LOG".into(), log.to_string_lossy().into_owned()),
            ("DBX_LEGACY_RPC_MODE".into(), mode.into()),
        ]);
    let runtime = AgentRuntimeClient::spawn(launch, "test").await.unwrap();
    let session_id = "legacy-owned-session";
    runtime
        .call::<Value>("open_session", json!({"agentSessionId":session_id}), Some(Duration::from_secs(2)), None)
        .await
        .unwrap();
    runtime.increment_session_count();
    let client =
        Arc::new(PooledAgentClient::new(AgentDriverClient::shared_session(runtime.clone(), session_id.into())));
    let client_id = task_client_session_id("native-job-operation", &plan.operation_id).replace(':', "_");
    let key = format!("c:session:{client_id}:role:metadata");
    state.update_connection_pools(|pools| pools.insert(key.clone(), PoolKind::Agent(client))).await;
    native_job_apply_core(state.clone(), &plan.plan_id).unwrap();
    let status = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status = native_job_status(&state, &plan.operation_id);
            if status.state == NativeJobOperationState::Finished {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(state.pool_handle(&key).await.is_none());
    runtime.kill();
    state.shutdown(Duration::from_secs(2)).await;
    let requests =
        std::fs::read_to_string(log).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    (status, requests)
}

#[tokio::test]
async fn production_ob_legacy_binds_zone_and_requires_original_physical_disposal_before_logical_close() {
    for mode in ["confirmed", "close-failed", "lost-terminal"] {
        let (status, requests) = run(mode).await;
        assert_eq!(
            status.outcome,
            if mode == "close-failed" {
                NativeJobOperationOutcome::Unknown
            } else {
                NativeJobOperationOutcome::NotApplied
            }
        );
        let prepared = requests.iter().find(|r| r["method"] == "prepare_legacy_job").unwrap();
        assert_eq!(prepared["params"]["dialect"], "oceanbase-oracle");
        assert_eq!(prepared["params"]["zone"], "zone1");
        assert_eq!(prepared["params"]["instance"], 0);
        assert!(requests
            .iter()
            .all(|r| !matches!(r["method"].as_str(), Some("commit_legacy_job" | "rollback_legacy_job"))));
        let closed = requests.iter().position(|r| r["method"] == "close_session").unwrap();
        if mode == "lost-terminal" {
            let checked = requests.iter().position(|r| r["method"] == "legacy_job_status").unwrap();
            assert!(checked < closed);
        }
        if mode == "close-failed" {
            assert_eq!(status.reason.as_deref(), Some("native_job_session_cleanup_unknown"));
        }
    }
}

#[tokio::test]
async fn an_old_oracle_legacy_capability_does_not_claim_the_ob_protocol() {
    let (status, requests) = run("old-package").await;
    assert_eq!(status.outcome, NativeJobOperationOutcome::NotApplied);
    assert_eq!(status.reason.as_deref(), Some("native_job_legacy_runtime_update_required"));
    assert!(!requests.iter().any(|r| r["method"] == "prepare_legacy_job"));
}
