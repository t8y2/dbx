use super::*;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;

// Unix executable fixture, like agent_metadata_routing_tests. This exercises Core,
// metadata pools and Agent RPC, but does not establish real engine compatibility.
struct Fixture {
    state: Arc<AppState>,
    directory: tempfile::TempDir,
    _listener: tokio::net::TcpListener,
}

impl Fixture {
    async fn new(mode: Value) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage, directory.path().join("plugins"), directory.path().join("agents"), "test",
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        for (id, db_type) in [("source", DatabaseType::Oracle), ("target", DatabaseType::OceanbaseOracle)] {
            let key = crate::database_capabilities::agent_key(&db_type, None).unwrap();
            let executable = state.agent_manager.driver_native_path(key);
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            std::fs::write(&executable, include_str!("oracle_routine_context_fixture.py")).unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
            let config: ConnectionConfig = serde_json::from_value(json!({
                "id":id, "name":id, "db_type":db_type, "host":"127.0.0.1",
                "port":listener.local_addr().unwrap().port(), "username":"fixture", "password":"",
                "database":"configured", "connect_timeout_secs":2, "query_timeout_secs":2,
                "keepalive_interval_secs":0, "idle_timeout_secs":0
            })).unwrap();
            state.configs.write().await.insert(id.into(), config);
        }
        std::fs::write(state.agent_manager.base_dir().join("routine.json"), mode.to_string()).unwrap();
        Self { state, directory, _listener: listener }
    }

    fn requests(&self) -> Vec<Value> {
        std::fs::read_to_string(self.state.agent_manager.base_dir().join("requests.jsonl"))
            .unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    async fn context(&self, endpoints: &crate::schema_diff::RoutineEndpoints, source: &[db::FunctionInfo], target: &[db::FunctionInfo]) -> Result<dbx_sql::oracle_program_compatibility::OracleProgramContext, String> {
        let recovery = endpoints.recovery;
        schema_diff_routine_context(&self.state, Some(endpoints),
            Some(if recovery { DatabaseType::OceanbaseOracle } else { DatabaseType::Oracle }),
            DatabaseType::OceanbaseOracle, Some(if recovery { "DST" } else { "SRC" }), Some("DST"),
            source, &[], target).await?.ok_or_else(|| "Missing context".into())
    }

    async fn shutdown(self) {
        self.state.shutdown(Duration::from_secs(2)).await;
        drop(self.directory);
    }
}

fn endpoints() -> crate::schema_diff::RoutineEndpoints {
    crate::schema_diff::RoutineEndpoints {
        recovery: false, source_connection_id: "source".into(), source_database: "configured".into(),
        target_connection_id: "target".into(), target_database: "configured".into(),
    }
}

fn routine(kind: &str, schema: &str, definition: &str) -> db::FunctionInfo {
    let mut info: db::FunctionInfo = serde_json::from_value(json!({
        "name":"T", "functionType":kind, "schema":schema, "definition":definition,
        "dataType":"", "arguments":"", "status":"VALID", "pairedObjectPresent":true
    })).unwrap();
    info.type_info = Some(db::RoutineTypeInfo {
        pairing_state: oracle_types::OracleMetadataReadState::Available,
        dependency_state: oracle_types::OracleMetadataReadState::Empty,
        incoming_state: oracle_types::OracleMetadataReadState::Empty,
        referenced_columns: Vec::new(), metadata_message: None,
    });
    info
}

const SPEC: &str = "CREATE OR REPLACE TYPE T AS OBJECT (N NUMBER);";
const BODY_SPEC: &str = "CREATE OR REPLACE TYPE T AS OBJECT (N NUMBER, MEMBER FUNCTION F RETURN NUMBER);";
const BODY: &str = "CREATE OR REPLACE TYPE BODY T AS MEMBER FUNCTION F RETURN NUMBER IS BEGIN RETURN 1; END; END;";

async fn prepare(fixture: &Fixture, info: db::FunctionInfo) -> Result<crate::schema_diff::SchemaDiffPreparation, String> {
    let options = serde_json::from_value(json!({
        "routineEndpoints":endpoints(), "sourceDatabaseType":DatabaseType::Oracle,
        "databaseType":DatabaseType::OceanbaseOracle, "sourceSchema":"SRC", "targetSchema":"DST",
        "sourceFunctions":[info]
    })).unwrap();
    prepare_schema_diff_core(&fixture.state, options).await
}

#[tokio::test]
async fn core_reads_versions_and_prepares_supported_type_but_blocks_unknown_versions() {
    for (version, target_version, allowed) in [
        ("Oracle Database 19c Enterprise Edition", "4.2.5.0", true),
        ("Oracle Database 21c Enterprise Edition", "4.2.5.6", true),
        ("Oracle Database 23ai", "4.2.5.0", false), ("unknown", "4.2.5.0", false),
        ("Oracle Database 19c Enterprise Edition", "5.7.25-OceanBase-v4.2.5.0", false),
        ("Oracle Database 19c Enterprise Edition", "4.3.0", false),
    ] {
        let fixture = Fixture::new(json!({"oracle_versions":[[version]], "ob_versions":[[target_version]], "target_spec_status":null})).await;
        let info = routine("TYPE", "SRC", SPEC);
        let context = fixture.context(&endpoints(), &[info.clone()], &[]).await.unwrap();
        assert_eq!(context.source_version, version);
        assert_eq!(context.target_version, target_version);
        let plan = prepare(&fixture, info).await.unwrap();
        assert_eq!(plan.routine_steps.len(), 1);
        assert_eq!(plan.routine_steps[0].blocked_reason.is_none(), allowed);
        assert_eq!(plan.routine_steps[0].sql.is_some(), allowed);
        let requests = fixture.requests();
        assert!(requests.iter().any(|r| r["params"]["sql"].as_str().is_some_and(|s| s.contains("V$VERSION"))));
        assert!(requests.iter().any(|r| r["params"]["sql"].as_str().is_some_and(|s| s.contains("OB_VERSION()"))));
        assert!(requests.iter().filter(|r| r["method"] == "open_session").all(|r| r["params"]["sessionRole"] == "metadata"));
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn core_rejects_missing_ambiguous_and_truncated_versions() {
    for mode in [json!({"oracle_versions":[]}), json!({"ob_versions":[["4.2.5"],["4.2.5"]]}),
        json!({"truncate_contains":"V$VERSION"}), json!({"more_contains":"OB_VERSION()"})] {
        let fixture = Fixture::new(mode).await;
        let error = fixture.context(&endpoints(), &[routine("TYPE", "SRC", SPEC)], &[]).await.unwrap_err();
        assert!(error.contains("missing or ambiguous") || error.contains("incomplete"), "{error}");
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn core_stops_on_denied_and_incomplete_global_dictionaries() {
    for dictionary in ["DBA_DEPENDENCIES", "DBA_TAB_COLUMNS"] {
        for fault in ["fail_contains", "truncate_contains", "more_contains"] {
            let mut mode = json!({"target_spec_status":null});
            mode[fault] = json!(dictionary);
            let fixture = Fixture::new(mode).await;
            let error = prepare(&fixture, routine("TYPE", "SRC", SPEC)).await.unwrap_err();
            assert!(error.contains("ORA-01031") || error.contains("incomplete"), "{error}");
            assert!(!fixture.requests().iter().any(|r| r["params"]["sql"].as_str().is_some_and(|s| s.starts_with("CREATE "))));
            fixture.shutdown().await;
        }
    }
}

#[tokio::test]
async fn core_detects_source_and_target_preview_drift() {
    for (mode, target, message) in [
        (json!({"source_status":"INVALID"}), false, "source status changed"),
        (json!({"source_spec":"CREATE TYPE T AS OBJECT (N DATE);"}), false, "source changed"),
        (json!({"source_spec":""}), false, "missing or is not visible"),
        (json!({"target_status":"INVALID", "target_spec_status":"INVALID"}), true, "target owner/status changed"),
        (json!({"target_status":"VALID", "target_spec":"CREATE TYPE T AS OBJECT (N DATE);"}), true, "target source changed"),
        (json!({"target_status":"VALID"}), false, "appeared after comparison"),
    ] {
        let fixture = Fixture::new(mode).await;
        let targets = if target { vec![routine("TYPE", "DST", SPEC)] } else { Vec::new() };
        let error = fixture.context(&endpoints(), &[routine("TYPE", "SRC", SPEC)], &targets).await.unwrap_err();
        assert!(error.contains(message), "{error}");
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn core_independent_body_requires_matching_valid_live_specification() {
    for (status, spec, allowed) in [(Some("VALID"), BODY_SPEC, true),
        (Some("VALID"), "CREATE TYPE T AS OBJECT (N DATE, MEMBER FUNCTION F RETURN NUMBER);", false),
        (Some("INVALID"), BODY_SPEC, false), (None, BODY_SPEC, false)] {
        let fixture = Fixture::new(json!({"target_spec_status":status, "source_spec":BODY_SPEC, "target_spec":spec})).await;
        let body = routine("TYPE BODY", "SRC", BODY);
        let context = fixture.context(&endpoints(), &[body.clone()], &[]).await.unwrap();
        assert_eq!(context.blocked_bodies.is_empty(), allowed);
        assert_eq!(context.target_dependencies.contains(&("DST".into(), "T".into(), "TYPE".into())), allowed);
        let plan = prepare(&fixture, body).await.unwrap();
        assert_eq!(plan.routine_steps[0].blocked_reason.is_none(), allowed);
        assert_eq!(plan.routine_steps[0].sql.is_some(), allowed);
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn core_independent_body_rejects_unreadable_or_invalid_source_spec_metadata() {
    for mode in [json!({"paired_status":"INVALID"}), json!({"fail_contains":"REFERENCED_LINK_NAME"}),
        json!({"truncate_contains":"REFERENCED_LINK_NAME"}),
        json!({"paired_dependencies":[["SRC","T","TYPE",null,"X","TYPE",null,"HARD"]]})] {
        let fixture = Fixture::new(mode).await;
        let error = fixture.context(&endpoints(), &[routine("TYPE BODY", "SRC", BODY)], &[]).await.unwrap_err();
        assert!(error.contains("Paired source TYPE"), "{error}");
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn core_recovery_checks_saved_target_endpoint_and_live_data_dependencies() {
    let mut recovery = endpoints();
    recovery.recovery = true;
    recovery.source_connection_id = "target".into();
    for columns in [json!([]), json!([["DST","STORED","VALUE"]])] {
        let fixture = Fixture::new(json!({"source_status":"INVALID", "target_status":"VALID", "columns":columns})).await;
        let mut saved = routine("TYPE", "DST", SPEC);
        // Physical references in a source snapshot must not be treated as live target data.
        saved.type_info.as_mut().unwrap().referenced_columns.push(db::RoutineColumnDependency {
            owner:"SRC".into(), table_name:"SOURCE_ONLY".into(), column_name:"VALUE".into(),
        });
        let context = fixture.context(&recovery, &[saved], &[routine("TYPE", "DST", SPEC)]).await.unwrap();
        assert_eq!(context.blocked_types.is_empty(), columns.as_array().unwrap().is_empty());
        let sqls: Vec<_> = fixture.requests().into_iter().filter_map(|r| r["params"]["sql"].as_str().map(str::to_string)).collect();
        assert!(sqls.iter().any(|s| s.contains("DBA_TAB_COLUMNS") && s.contains("'DST'")));
        assert!(!sqls.iter().any(|s| s.contains("'SRC'")));
        for wrong in [endpoints(), crate::schema_diff::RoutineEndpoints { source_database:"different".into(), ..recovery.clone() }] {
            let invalid = crate::schema_diff::RoutineEndpoints { recovery:true, ..wrong };
            let error = fixture.context(&invalid, &[routine("TYPE", "DST", SPEC)], &[]).await.unwrap_err();
            assert!(error.contains("recovery must use") || error.contains("engines disagree"), "{error}");
        }
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn core_same_engine_package_checks_drift_and_removed_only_target() {
    const PACKAGE: &str = "CREATE OR REPLACE PACKAGE P AS PROCEDURE RUN; END;";
    for (mode, removed_only, message) in [
        (json!({"source_status":"INVALID"}), false, "source status changed"),
        (json!({"routine_source":"CREATE PACKAGE P AS PROCEDURE OTHER; END;"}), false, "source changed"),
        (json!({"target_status":"INVALID"}), true, "target owner/status changed"),
        (json!({"target_status":"VALID", "routine_source":"CREATE PACKAGE P AS PROCEDURE OTHER; END;"}), true, "target source changed"),
    ] {
        let fixture = Fixture::new(mode).await;
        fixture.state.configs.write().await.get_mut("source").unwrap().db_type = DatabaseType::OceanbaseOracle;
        let mut info = routine("PACKAGE", if removed_only { "DST" } else { "SRC" }, PACKAGE);
        info.name = "P".into();
        info.type_info = None;
        let selected = if removed_only { Vec::new() } else { vec![info.clone()] };
        let targets = if removed_only { vec![info.clone()] } else { Vec::new() };
        let removed = if removed_only { vec![info] } else { Vec::new() };
        let error = schema_diff_routine_context(&fixture.state, Some(&endpoints()),
            Some(DatabaseType::OceanbaseOracle), DatabaseType::OceanbaseOracle,
            Some("SRC"), Some("DST"), &selected, &removed, &targets).await.unwrap_err();
        assert!(error.contains(message), "{error}");
        fixture.shutdown().await;
    }
    // Same-engine recovery skips the saved source snapshot, but still checks the current target.
    let fixture = Fixture::new(json!({"target_status":"INVALID"})).await;
    let mut recovery = endpoints();
    recovery.recovery = true;
    recovery.source_connection_id = "target".into();
    let mut saved = routine("PACKAGE", "DST", PACKAGE);
    saved.name = "P".into();
    let error = fixture.context(&recovery, &[saved.clone()], &[saved]).await.unwrap_err();
    assert!(error.contains("target owner/status changed"), "{error}");
    fixture.shutdown().await;
}

#[tokio::test]
async fn core_recovery_preserves_invalid_backup_and_blocks_automatic_restoration() {
    const CURRENT: &str = "CREATE OR REPLACE TYPE T AS OBJECT (N DATE);";
    let fixture = Fixture::new(json!({"target_status":"VALID", "target_spec":CURRENT})).await;
    let mut recovery = endpoints();
    recovery.recovery = true;
    recovery.source_connection_id = "target".into();
    let mut saved = routine("TYPE", "DST", SPEC);
    saved.status = Some("INVALID".into());
    let options = serde_json::from_value(json!({
        "routineEndpoints":recovery, "sourceDatabaseType":DatabaseType::OceanbaseOracle,
        "databaseType":DatabaseType::OceanbaseOracle, "sourceSchema":"DST", "targetSchema":"DST",
        "sourceFunctions":[saved], "targetFunctions":[routine("TYPE", "DST", CURRENT)]
    })).unwrap();
    let plan = prepare_schema_diff_core(&fixture.state, options).await.unwrap();
    assert!(plan.routine_steps[0].sql.is_none());
    assert!(plan.routine_steps[0].blocked_reason.as_deref().unwrap().contains("not confirmed VALID"));
    let backup = plan.function_diffs[0].source.as_ref().unwrap();
    assert_eq!(backup.status.as_deref(), Some("INVALID"));
    assert_eq!(backup.definition, SPEC);
    let current = plan.function_diffs[0].target.as_ref().unwrap();
    assert_eq!(current.definition, CURRENT);
    fixture.shutdown().await;
}

#[tokio::test]
async fn core_oracle_target_editions_gate_only_cross_engine_conversion() {
    for (editions, allowed) in [("N", true), ("Y", false), ("UNKNOWN", false)] {
        let fixture = Fixture::new(json!({"editions":editions, "target_spec_status":null})).await;
        {
            let mut configs = fixture.state.configs.write().await;
            configs.get_mut("source").unwrap().db_type = DatabaseType::OceanbaseOracle;
            configs.get_mut("target").unwrap().db_type = DatabaseType::Oracle;
        }
        let options = serde_json::from_value(json!({
            "routineEndpoints":endpoints(), "sourceDatabaseType":DatabaseType::OceanbaseOracle,
            "databaseType":DatabaseType::Oracle, "sourceSchema":"SRC", "targetSchema":"DST",
            "sourceFunctions":[routine("TYPE", "SRC", SPEC)]
        })).unwrap();
        let plan = prepare_schema_diff_core(&fixture.state, options).await.unwrap();
        assert_eq!(plan.routine_steps[0].sql.is_some(), allowed);
        assert_eq!(plan.routine_steps[0].blocked_reason.is_none(), allowed);
        assert!(fixture.requests().iter().any(|r| r["params"]["sql"].as_str().is_some_and(|s| s.contains("EDITIONS_ENABLED"))));
        fixture.shutdown().await;
    }
    let fixture = Fixture::new(json!({"editions":"Y"})).await;
    fixture.state.configs.write().await.get_mut("target").unwrap().db_type = DatabaseType::Oracle;
    let mut package = routine("PACKAGE", "SRC", "CREATE OR REPLACE PACKAGE P AS PROCEDURE RUN; END;");
    package.name = "P".into();
    package.type_info = None;
    let options = serde_json::from_value(json!({
        "routineEndpoints":endpoints(), "sourceDatabaseType":DatabaseType::Oracle,
        "databaseType":DatabaseType::Oracle, "sourceSchema":"SRC", "targetSchema":"DST",
        "sourceFunctions":[package]
    })).unwrap();
    let plan = prepare_schema_diff_core(&fixture.state, options).await.unwrap();
    assert!(plan.routine_steps[0].blocked_reason.is_none());
    assert!(plan.routine_steps[0].sql.is_some());
    fixture.shutdown().await;
    // Missing endpoints remain a legacy planning-only path: no live dictionary guarantee.
    let fixture = Fixture::new(json!({})).await;
    let context = schema_diff_routine_context(&fixture.state, None, Some(DatabaseType::Oracle),
        DatabaseType::Oracle, Some("SRC"), Some("DST"), &[routine("TYPE", "SRC", SPEC)], &[], &[]).await.unwrap();
    assert!(context.is_none());
    assert!(fixture.requests().is_empty());
    fixture.shutdown().await;
}
