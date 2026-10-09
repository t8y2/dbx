use super::*;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

// Exercises production transfer planning/execution through metadata/workload
// pools and real Agent JSON-RPC. Unix fixture execution is not live DB evidence.
struct Fixture {
    state: Arc<AppState>,
    directory: tempfile::TempDir,
    _listener: tokio::net::TcpListener,
    source_pool: String,
    target_pool: String,
}

const SOURCE_SPEC: &str = "CREATE OR REPLACE PACKAGE \"SRC\".\"P\" AS PROCEDURE run; marker VARCHAR2(40) := q'[SRC.source-marker]'; END;";
const SOURCE_BODY: &str = "CREATE OR REPLACE PACKAGE BODY \"SRC\".\"P\" AS PROCEDURE run IS BEGIN NULL; END; END;";
const OLD_SPEC: &str = "CREATE OR REPLACE PACKAGE \"DST\".\"P\" AS PROCEDURE old_run; marker VARCHAR2(40) := q'[DST.original-marker]'; END;";
const OLD_BODY: &str = "CREATE OR REPLACE PACKAGE BODY \"DST\".\"P\" AS PROCEDURE old_run IS BEGIN NULL; END; END;";
const CONCURRENT_SPEC: &str = "CREATE OR REPLACE PACKAGE \"DST\".\"P\" AS PROCEDURE concurrent_run; END;";
const CONCURRENT_BODY: &str = "CREATE OR REPLACE PACKAGE BODY \"DST\".\"P\" AS PROCEDURE concurrent_run IS BEGIN NULL; END; END;";

impl Fixture {
    async fn new(database_type: DatabaseType, mut mode: Value) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage, directory.path().join("plugins"), directory.path().join("agents"), "test",
        ));
        let key = crate::database_capabilities::agent_key(&database_type, None).unwrap();
        let executable = state.agent_manager.driver_native_path(key);
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, include_str!("oracle_transfer_agent_fixture.py")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        for (id, database, user) in [("source", "SOURCE_DB", "SRC"), ("target", "TARGET_DB", "DST")] {
            let config: ConnectionConfig = serde_json::from_value(json!({
                "id":id, "name":id, "db_type":database_type, "host":"127.0.0.1",
                "port":listener.local_addr().unwrap().port(), "username":user, "password":"",
                "database":database, "connect_timeout_secs":2, "query_timeout_secs":2,
                "keepalive_interval_secs":0, "idle_timeout_secs":0
            })).unwrap();
            state.configs.write().await.insert(id.into(), config);
        }
        mode["engine"] = json!(if database_type == DatabaseType::OceanbaseOracle { "oceanbase" } else { "oracle" });
        mode["source_spec"] = json!(SOURCE_SPEC);
        mode["source_body"] = json!(SOURCE_BODY);
        mode["old_spec"] = json!(OLD_SPEC);
        mode["old_body"] = json!(OLD_BODY);
        mode["concurrent_spec"] = json!(CONCURRENT_SPEC);
        mode["concurrent_body"] = json!(CONCURRENT_BODY);
        std::fs::write(state.agent_manager.base_dir().join("transfer.json"), mode.to_string()).unwrap();
        let source_pool = state.get_or_create_pool_for_session("source", Some("SOURCE_DB"), None).await.unwrap();
        let target_pool = state.get_or_create_pool_for_session("target", Some("TARGET_DB"), None).await.unwrap();
        Self { state, directory, _listener: listener, source_pool, target_pool }
    }

    fn requests(&self) -> Vec<Value> {
        std::fs::read_to_string(self.state.agent_manager.base_dir().join("requests.jsonl"))
            .unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn writes(&self) -> Vec<String> {
        self.requests().iter().filter_map(|r| r["params"]["sql"].as_str())
            .filter(|sql| sql.starts_with("CREATE ") || sql.starts_with("DROP ")).map(str::to_string).collect()
    }

    fn backups(&self) -> Vec<Value> {
        std::fs::read_dir(self.state.storage.data_dir().join("transfer-object-backups")).unwrap()
            .map(|entry| serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap()).collect()
    }

    async fn shutdown(self) {
        self.state.shutdown(Duration::from_secs(2)).await;
        drop(self.directory);
    }
}

fn request(kind: &str, name: &str) -> TransferRequest {
    serde_json::from_value(json!({
        "transferId":uuid::Uuid::new_v4().to_string(), "sourceConnectionId":"source",
        "sourceDatabase":"SOURCE_DB", "sourceSchema":"SRC", "targetConnectionId":"target",
        "targetDatabase":"TARGET_DB", "targetSchema":"DST", "tables":[], "createTable":false,
        "batchSize":10, "objectConflictPolicy":"replace", "objects":[{"objectType":kind,"names":[name]}]
    })).unwrap()
}

async fn package_outcome(fixture: &Fixture, request: &TransferRequest) -> TransferObjectOutcome {
    execute(&fixture.state, request, &fixture.source_pool, &fixture.target_pool, &mut |_| {}).await.unwrap()
}

fn assert_manual_package_recovery(fixture: &Fixture, outcome: &TransferObjectOutcome, kind: TransferObjectKind) {
    assert_eq!(outcome.failed.len(), 1);
    assert!(outcome.transferred.is_empty());
    let result = &outcome.object_results[0];
    assert_eq!(result.object_type, kind);
    assert_eq!(result.status, "failed");
    let recovery = result.recovery.as_deref().unwrap();
    assert!(recovery.contains("Automatic restoration was not attempted"));
    assert!(recovery.contains("Manual recovery:"));
    assert!(recovery.contains("recorded target connection/schema"));
    assert!(recovery.contains("specification before body"));
    assert_eq!(fixture.writes().len(), 1, "No recovery spec/body DDL may overwrite another session");
    let backups = fixture.backups();
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0]["connection_id"], "target");
    assert_eq!(backups[0]["schema"], "DST");
    assert_eq!(backups[0]["name"], "P");
    assert_eq!(backups[0]["definitions"], json!([["PACKAGE",OLD_SPEC],["PACKAGE BODY",OLD_BODY]]));
    assert!(!recovery.contains("original-marker"), "Public progress must not expose source literals");
}

#[tokio::test]
async fn package_concurrent_save_is_not_overwritten_and_unselected_body_is_not_restored() {
    for (kind, selected_kind, key, concurrent) in [
        ("PACKAGE", TransferObjectKind::Package, "spec", CONCURRENT_SPEC),
        ("PACKAGE_BODY", TransferObjectKind::PackageBody, "body", CONCURRENT_BODY),
    ] {
        let fixture = Fixture::new(DatabaseType::OceanbaseOracle, json!({"package_fault":"concurrent"})).await;
        let outcome = package_outcome(&fixture, &request(kind, "P")).await;
        assert_manual_package_recovery(&fixture, &outcome, selected_kind);
        assert_eq!(outcome.object_results[0].source_verified, Some(false));
        let current: Value = serde_json::from_slice(&std::fs::read(fixture.state.agent_manager.base_dir().join("target-package.json")).unwrap()).unwrap();
        assert_eq!(current[key], concurrent);
        if selected_kind == TransferObjectKind::Package { assert_eq!(current["body"], OLD_BODY); }
        else { assert_eq!(current["spec"], OLD_SPEC); }
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn package_lost_write_response_preserves_backup_without_replaying_old_definitions() {
    let fixture = Fixture::new(DatabaseType::OceanbaseOracle, json!({"package_fault":"lost-response"})).await;
    let outcome = package_outcome(&fixture, &request("PACKAGE", "P")).await;
    assert_manual_package_recovery(&fixture, &outcome, TransferObjectKind::Package);
    let current: Value = serde_json::from_slice(&std::fs::read(fixture.state.agent_manager.base_dir().join("target-package.json")).unwrap()).unwrap();
    assert!(current["spec"].as_str().unwrap().contains("SRC.source-marker"));
    assert_eq!(current["body"], OLD_BODY);
    assert!(outcome.object_results[0].error.as_deref().unwrap().contains("Package DDL failed"));
    fixture.shutdown().await;
}

#[tokio::test]
async fn package_known_compiler_failure_still_keeps_both_exact_backups_for_manual_recovery() {
    let fixture = Fixture::new(DatabaseType::Oracle, json!({"package_fault":"invalid"})).await;
    let outcome = package_outcome(&fixture, &request("PACKAGE", "P")).await;
    assert_manual_package_recovery(&fixture, &outcome, TransferObjectKind::Package);
    assert_eq!(outcome.object_results[0].compile_status.as_deref(), Some("INVALID"));
    assert!(outcome.object_results[0].error.as_deref().unwrap().contains("PLS-00323"));
    fixture.shutdown().await;
}

#[tokio::test]
async fn package_cancelled_unknown_write_never_replays_the_saved_body_or_specification() {
    let fixture = Fixture::new(DatabaseType::OceanbaseOracle, json!({"package_fault":"wait-for-cancel"})).await;
    let request = request("PACKAGE", "P");
    let task = {
        let state = fixture.state.clone();
        let request = request.clone();
        let source = fixture.source_pool.clone();
        let target = fixture.target_pool.clone();
        tokio::spawn(async move { execute(&state, &request, &source, &target, &mut |_| {}).await.unwrap() })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        while !fixture.state.agent_manager.base_dir().join("package-written").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    set_cancelled(&request.transfer_id).await;
    std::fs::write(fixture.state.agent_manager.base_dir().join("cancel-confirmed"), "done").unwrap();
    let outcome = task.await.unwrap();
    assert_manual_package_recovery(&fixture, &outcome, TransferObjectKind::Package);
    clear_cancelled(&request.transfer_id).await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn package_success_still_verifies_selected_definition_without_implicit_body_execution() {
    let fixture = Fixture::new(DatabaseType::OceanbaseOracle, json!({})).await;
    let outcome = package_outcome(&fixture, &request("PACKAGE", "P")).await;
    assert!(outcome.failed.is_empty());
    assert_eq!(outcome.transferred.len(), 1);
    assert_eq!(outcome.object_results[0].source_verified, Some(true));
    assert_eq!(fixture.writes().len(), 1);
    assert!(fixture.writes()[0].contains("\"DST\".\"P\""));
    assert!(fixture.writes()[0].contains("q'[SRC.source-marker]'"));
    fixture.shutdown().await;
}

async fn permission_plan(fixture: &Fixture, kind: &str, database_type: DatabaseType) -> TransferSchemaObjectPlan {
    let name = match kind { "TYPE" => "T", "SYNONYM" => "S", _ => "L" };
    let mut request = request(kind, name);
    if kind == "DB_LINK" {
        request.database_links.push(serde_json::from_value(json!({
            "objectType":"DB_LINK", "name":"L", "sourceOwner":"SRC", "targetName":"L",
            "targetScope":if database_type == DatabaseType::OceanbaseOracle { "tenant" } else { "private" },
            "authentication":"fixedUser", "username":"REMOTE_USER", "host":"remote-service",
            "protocol":if database_type == DatabaseType::OceanbaseOracle { Some("OB") } else { None },
            "tenant":if database_type == DatabaseType::OceanbaseOracle { Some("remoteTenant") } else { None },
            "credentialAvailable":true
        })).unwrap());
    }
    let plan = match kind {
        "TYPE" => super::super::oracle_types::preview(&fixture.state, &request, &fixture.source_pool, &fixture.target_pool).await,
        "SYNONYM" => super::super::oracle_synonyms::preview(&fixture.state, &request, &fixture.source_pool, &fixture.target_pool).await,
        _ => super::super::oracle_database_links::preview(&fixture.state, &request, &fixture.source_pool, &fixture.target_pool).await,
    };
    plan.unwrap().unwrap()
}

#[tokio::test]
async fn object_transfer_privileges_use_oracle_session_or_oceanbase_direct_grants_only() {
    for database_type in [DatabaseType::Oracle, DatabaseType::OceanbaseOracle] {
        for (kind, grant) in [("TYPE","CREATE TYPE"), ("SYNONYM","CREATE SYNONYM"), ("DB_LINK","CREATE DATABASE LINK")] {
            for direct in [true, false] {
                let fixture = Fixture::new(database_type, json!({"direct":if direct { vec![grant] } else { Vec::new() }})).await;
                if database_type == DatabaseType::OceanbaseOracle && direct {
                    let unavailable = execute_read_on_pool(&fixture.state, &fixture.target_pool, "SELECT PRIVILEGE FROM SESSION_PRIVS").await.unwrap_err();
                    assert!(unavailable.contains("ORA-00942"));
                }
                let before_plan = fixture.requests().len();
                let plan = permission_plan(&fixture, kind, database_type).await;
                assert_eq!(plan.can_execute, direct, "{database_type:?}/{kind}: {:?}", plan.items[0].errors);
                assert_eq!(plan.items[0].action != "blocked", direct);
                let requests = fixture.requests();
                let sqls: Vec<_> = requests[before_plan..].iter().filter_map(|r| r["params"]["sql"].as_str()).collect();
                if database_type == DatabaseType::OceanbaseOracle {
                    assert!(sqls.iter().any(|s| s.contains("USER_SYS_PRIVS") && s.contains("'SESSION_USER'")));
                    assert!(sqls.iter().all(|s| !s.contains("SESSION_PRIVS") && !s.contains("SESSION_ROLES")));
                    // The fixture supplies role candidates if asked, but roles cannot
                    // make an absent direct grant into a confirmed session permission.
                    assert!(sqls.iter().all(|s| !s.contains("USER_ROLE_PRIVS") && !s.contains("DBA_SYS_PRIVS")));
                } else {
                    assert!(sqls.iter().any(|s| s.contains("SESSION_PRIVS")));
                }
                assert!(fixture.writes().is_empty());
                fixture.shutdown().await;
            }
        }
    }
}

#[tokio::test]
async fn object_transfer_truncated_or_partial_direct_privileges_do_not_authorize_ddl() {
    for kind in ["TYPE", "SYNONYM", "DB_LINK"] {
        for fault in ["truncate_privileges", "more_privileges"] {
            let mut mode = json!({"direct":["CREATE TYPE","CREATE SYNONYM","CREATE DATABASE LINK"]});
            mode[fault] = json!(true);
            let fixture = Fixture::new(DatabaseType::OceanbaseOracle, mode).await;
            let plan = permission_plan(&fixture, kind, DatabaseType::OceanbaseOracle).await;
            assert!(!plan.can_execute);
            assert_eq!(plan.items[0].action, "blocked");
            assert!(fixture.writes().is_empty());
            fixture.shutdown().await;
        }
    }
}
