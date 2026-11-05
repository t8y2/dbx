use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

const SOURCE: &str = "CREATE OR REPLACE FUNCTION \"Read.Func\" RETURN NUMBER AS BEGIN RETURN 1; END";

#[tokio::test]
async fn definition_grammar_extension_does_not_enable_unpaired_controlled_package_saves() {
    let dir = tempfile::tempdir().unwrap();
    let storage = crate::persistence::test_storage::open(&dir.path().join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    for kind in [db::ObjectSourceKind::Package, db::ObjectSourceKind::PackageBody] {
        let input = OracleRoutineSaveInput {
            connection_id: "target".into(),
            database: "tenant".into(),
            identity: RoutineIdentity { owner: "OWNER".into(), name: "P".into(), kind: kind.clone() },
            sql: format!("CREATE OR REPLACE {} \"OWNER\".P AS END P;", kind_name(&kind)),
            require_absent: false,
            prerequisite_operation_id: None,
            supersedes_operation_id: None,
        };
        let result = prepare_bound_definition(&state, input, binding().expected_config, 1, false);
        assert!(result.is_err(), "package approval needs its frozen pair lifecycle");
    }
}

#[tokio::test]
async fn actual_execute_entry_pins_terminal_readback_through_cancel_or_final_response() {
    use crate::db::agent_driver::{AgentDriverClient, AgentLaunchSpec, AgentRuntimeClient};
    struct RuntimeGuard(Arc<AgentRuntimeClient>);
    impl Drop for RuntimeGuard {
        fn drop(&mut self) {
            self.0.kill();
        }
    }
    async fn wait_for(path: &std::path::Path) {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !path.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fake Agent did not reach the controlled readback barrier");
    }
    for cancel_waiter in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("routine-agent.py");
        let root = serde_json::to_string(&dir.path().to_string_lossy()).unwrap();
        let source = serde_json::to_string(SOURCE).unwrap();
        std::fs::write(&script, r#"import json, pathlib, sys, time
root = pathlib.Path(__ROOT__)
source = __SOURCE__
writes = 0
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    method = req['method']
    params = req.get('params', {})
    sql = params.get('sql', '')
    if method == 'handshake':
        result = {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']}
    elif method in ('validate_session', 'validate_connection', 'close_session', 'set_schema'):
        result = {}
    elif method.replace('_', '').lower() == 'getobjectsource':
        result = {'name': 'Read.Func', 'schema': 'OWNER', 'object_type': 'FUNCTION', 'source': source}
    elif sql:
        if sql.lstrip().upper().startswith('CREATE'):
            writes += 1
            (root / 'writes').write_text(str(writes))
            result = {'columns': [], 'rows': [], 'affected_rows': 0, 'execution_time_ms': 1}
        else:
            if writes and not (root / 'release').exists():
                (root / 'readback-entered').touch()
                while not (root / 'release').exists(): time.sleep(0.01)
            if 'LOGIN_OWNER' in sql:
                columns, rows = ['LOGIN_OWNER'], [['OWNER']]
            elif 'ALL_ERRORS' in sql:
                columns, rows = ['SEQUENCE', 'ATTRIBUTE', 'LINE', 'POSITION', 'TEXT'], []
            elif 'SOURCE_ROWS' in sql:
                columns = ['SOURCE_ROWS', 'FIRST_LINE', 'LAST_LINE', 'SOURCE_CHARS', 'HEAD_TRIM', 'TAIL_TRIM', 'SOURCE_HEAD']
                rows = [[1, 1, 1, len(source.removeprefix('CREATE OR REPLACE ')), 0, 0, 'FUNCTION']]
            elif 'ALL_OBJECTS' in sql:
                columns = ['OWNER', 'OBJECT_NAME', 'OBJECT_TYPE', 'OBJECT_ID', 'STATUS', 'LAST_DDL_TIME']
                rows = [['OWNER', 'Read.Func', 'FUNCTION', 12, 'VALID', '2026-10-21T08:30:00']]
            else:
                raise RuntimeError('unexpected fake metadata query')
            result = {'columns': columns, 'rows': rows}
    else:
        (root / 'unexpected-method').write_text(method)
        print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'error': {'code': -1, 'message': 'unexpected fake Agent method'}}), flush=True)
        continue
    print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'result': result}), flush=True)
"#.replace("__ROOT__", &root).replace("__SOURCE__", &source)).unwrap();
        let python = if cfg!(windows) { "python" } else { "python3" };
        let runtime = AgentRuntimeClient::spawn(
            AgentLaunchSpec::new(python).with_args([script.to_string_lossy().to_string()]),
            "test",
        )
        .await
        .unwrap();
        let _runtime_guard = RuntimeGuard(runtime.clone());
        let storage = crate::persistence::test_storage::open(&dir.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new(storage));
        let bound = binding();
        state.configs.write().await.insert("target".into(), bound.expected_config);
        state
            .update_connection_pools(|pools| {
                for key in ["target:tenant", "target:tenant:role:metadata"] {
                    runtime.increment_session_count();
                    pools.insert(
                        key.into(),
                        PoolKind::agent(AgentDriverClient::shared_session(runtime.clone(), "routine-test".into())),
                    );
                }
            })
            .await;
        let approval = prepare_oracle_routine_save_core(
            &state,
            OracleRoutineSaveInput {
                connection_id: "target".into(),
                database: "tenant".into(),
                identity: bound.identity,
                sql: SOURCE.into(),
                require_absent: false,
                prerequisite_operation_id: None,
                supersedes_operation_id: None,
            },
        )
        .await
        .unwrap();
        state.routine_operations.update_references(std::slice::from_ref(&approval.operation_id), &[]).unwrap();
        let waiter = tokio::spawn(execute_oracle_routine_operation_core(
            state.clone(),
            approval.operation_id.clone(),
            SOURCE.into(),
        ));
        wait_for(&dir.path().join("readback-entered")).await;
        let paused = state.routine_operations.observe(&approval.operation_id).operation.unwrap();
        assert_eq!(paused.lifecycle, RoutineOperationLifecycle::Terminal);
        assert!(paused.dispatched && paused.acknowledged && paused.readback.is_none());
        state.routine_operations.update_references(&[], std::slice::from_ref(&approval.operation_id)).unwrap();
        assert!(state.routine_operations.observe(&approval.operation_id).operation.is_some());
        let waiter = if cancel_waiter {
            waiter.abort();
            assert!(waiter.await.unwrap_err().is_cancelled());
            state.routine_operations.update_references(&[], &[]).unwrap();
            assert!(state.routine_operations.observe(&approval.operation_id).operation.is_some());
            None
        } else {
            Some(waiter)
        };
        std::fs::write(dir.path().join("release"), b"").unwrap();
        if let Some(waiter) = waiter {
            let final_record = waiter.await.unwrap().unwrap();
            assert!(final_record.verified());
        }
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while state.routine_operations.observe(&approval.operation_id).operation.is_some() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("operation was not reclaimed after the last worker/response pin");
        assert_eq!(std::fs::read_to_string(dir.path().join("writes")).unwrap(), "1");
    }
}

struct Io {
    name: String,
    source_text: String,
    object_id: u64,
    endpoint_current: bool,
    exists: AtomicBool,
    invalid: bool,
    failure: Option<QueryExecutionError>,
    writes: AtomicUsize,
    queries: Mutex<Vec<String>>,
    wait: bool,
    entered: tokio::sync::Notify,
    block_readback: bool,
    readback_entered: tokio::sync::Notify,
}

impl Default for Io {
    fn default() -> Self {
        Self {
            name: "Read.Func".into(),
            source_text: SOURCE.into(),
            object_id: 12,
            endpoint_current: true,
            exists: AtomicBool::new(true),
            invalid: false,
            failure: None,
            writes: AtomicUsize::new(0),
            queries: Mutex::new(Vec::new()),
            wait: false,
            entered: tokio::sync::Notify::new(),
            block_readback: false,
            readback_entered: tokio::sync::Notify::new(),
        }
    }
}

#[async_trait::async_trait]
impl RoutineCatalog for Io {
    async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
        if self.block_readback && self.writes.load(Ordering::SeqCst) > 0 {
            self.readback_entered.notify_one();
            std::future::pending::<()>().await;
        }
        self.queries.lock().unwrap().push(sql.into());
        let (columns, rows) = if sql.contains("LOGIN_OWNER") {
            (vec!["LOGIN_OWNER"], vec![vec![json!("OWNER")]])
        } else if sql.contains("ALL_ERRORS") {
            (
                vec!["SEQUENCE", "ATTRIBUTE", "LINE", "POSITION", "TEXT"],
                if self.invalid {
                    vec![vec![json!(1), json!("ERROR"), json!(1), json!(72), json!("missing identifier")]]
                } else {
                    vec![]
                },
            )
        } else if sql.contains("SOURCE_ROWS") {
            (
                vec!["SOURCE_ROWS", "FIRST_LINE", "LAST_LINE", "SOURCE_CHARS", "HEAD_TRIM", "TAIL_TRIM", "SOURCE_HEAD"],
                vec![vec![
                    json!(1),
                    json!(1),
                    json!(1),
                    json!(self.source_text.strip_prefix("CREATE OR REPLACE ").unwrap().chars().count()),
                    json!(0),
                    json!(0),
                    json!("FUNCTION"),
                ]],
            )
        } else if sql.contains("ALL_OBJECTS") {
            (
                vec!["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "STATUS", "LAST_DDL_TIME"],
                if self.exists.load(Ordering::SeqCst) {
                    vec![vec![
                        json!("OWNER"),
                        json!(self.name),
                        json!("FUNCTION"),
                        json!(self.object_id),
                        json!(if self.invalid { "INVALID" } else { "VALID" }),
                        json!("2026-10-21T08:30:00"),
                    ]]
                } else {
                    vec![]
                },
            )
        } else {
            panic!("unexpected query: {sql}")
        };
        Ok(serde_json::from_value(json!({"columns":columns,"rows":rows})).unwrap())
    }
    async fn source(&self, _: &RoutineIdentity) -> Result<SourceReply, String> {
        Ok(serde_json::from_value(
            json!({"name":self.name,"schema":"OWNER","object_type":"FUNCTION","source":self.source_text}),
        )
        .unwrap())
    }
}

#[async_trait::async_trait]
impl RoutineWriteIo for Io {
    async fn check_write(&self, _sql: &str) -> Result<(), String> {
        if self.endpoint_current {
            Ok(())
        } else {
            Err("endpoint changed".into())
        }
    }
    async fn write(&self, sql: &str) -> Result<db::QueryResult, QueryExecutionError> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        if self.wait {
            std::future::pending::<()>().await;
        }
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        self.exists.store(!sql.starts_with("DROP "), Ordering::SeqCst);
        Ok(serde_json::from_value(json!({"columns":[],"rows":[],"affected_rows":0,"execution_time_ms":1})).unwrap())
    }
}

fn binding() -> RoutineWriteBinding {
    RoutineWriteBinding {
        target: RoutineEndpoint { connection_id: "target".into(), database: "tenant".into(), schema: "OWNER".into(), database_type: DatabaseType::OceanbaseOracle, generation: 0 },
        identity: RoutineIdentity { owner: "OWNER".into(), name: "Read.Func".into(), kind: db::ObjectSourceKind::Function },
        sql: SOURCE.into(), goal: RoutineReadbackGoal::Definition { sql: SOURCE.into() }, require_absent: false,
        expected_config: serde_json::from_value(json!({"id":"target","name":"test","db_type":DatabaseType::OceanbaseOracle,"host":"localhost","port":2881,"username":"OWNER","password":"","database":null})).unwrap(),
        compare: None, prerequisite_operation_ids: Vec::new(), package_effect_operation_ids:Vec::new(),
    }
}

async fn run(io: &Io, binding: RoutineWriteBinding) -> RoutineOperationRecord {
    let registry = RoutineOperationRegistry::default();
    let operation = registry.prepare(binding.clone());
    registry.begin(&operation.operation_id, &binding.sql).unwrap();
    run_write(&registry, &operation.operation_id, &binding, io, None::<&Io>, SourceOrigin::OceanBaseDictionary).await;
    registry.observe(&operation.operation_id).operation.unwrap()
}

#[tokio::test]
async fn save_counts_only_valid_full_readback_and_does_not_require_global_dependencies() {
    let io = Io::default();
    assert!(run(&io, binding()).await.verified());
    assert_eq!(io.writes.load(Ordering::SeqCst), 1);
    assert!(!io.queries.lock().unwrap().iter().any(|sql| sql.contains("DBA_")));
    let io = Io { invalid: true, ..Default::default() };
    let operation = run(&io, binding()).await;
    assert!(operation.dispatched && operation.acknowledged);
    assert!(!operation.verified());
    let read = operation.readback.unwrap();
    assert_eq!(read.state, RoutineReadbackState::Invalid);
    assert_eq!(read.compiler_messages[0].position, 72);
}

#[tokio::test]
async fn endpoint_change_or_an_occupied_create_target_does_not_dispatch() {
    let io = Io { endpoint_current: false, ..Default::default() };
    let operation = run(&io, binding()).await;
    assert!(!operation.dispatched);
    assert_eq!(io.writes.load(Ordering::SeqCst), 0);
    let io = Io::default();
    let operation = run(&io, RoutineWriteBinding { require_absent: true, ..binding() }).await;
    assert!(!operation.dispatched);
    assert_eq!(io.writes.load(Ordering::SeqCst), 0);
    let io = Io { exists: AtomicBool::new(false), ..Default::default() };
    assert!(run(&io, RoutineWriteBinding { require_absent: true, ..binding() }).await.verified());
}

#[tokio::test]
async fn lost_transport_is_unproven_even_if_the_object_currently_matches() {
    let io = Io {
        failure: Some(QueryExecutionError::Agent(AgentCallError::Transport { message: "connection lost".into() })),
        ..Default::default()
    };
    let operation = run(&io, binding()).await;
    assert_eq!(operation.lifecycle, RoutineOperationLifecycle::Unproven);
    assert!(operation.dispatched && !operation.acknowledged);
    assert!(operation.readback.is_none());
    assert_eq!(io.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn terminal_sql_error_and_known_not_started_are_distinct_from_unknown() {
    let io =
        Io { failure: Some(QueryExecutionError::Sql("ORA-00955: name is already used".into())), ..Default::default() };
    let operation = run(&io, binding()).await;
    assert_eq!(operation.lifecycle, RoutineOperationLifecycle::Terminal);
    assert!(operation.dispatched && !operation.acknowledged && !operation.verified());
    let io = Io {
        failure: Some(QueryExecutionError::Canceled {
            stage: AgentErrorStage::Checkout,
            operation_outcome: AgentOperationOutcome::NotStarted,
        }),
        ..Default::default()
    };
    let operation = run(&io, binding()).await;
    assert_eq!(operation.lifecycle, RoutineOperationLifecycle::Terminal);
    assert!(!operation.dispatched);
}

#[tokio::test]
async fn an_abandoned_worker_does_not_release_a_possibly_dispatched_target() {
    let io = Arc::new(Io { wait: true, ..Default::default() });
    let registry = Arc::new(RoutineOperationRegistry::default());
    let bound = binding();
    let operation = registry.prepare(bound.clone());
    registry.begin(&operation.operation_id, &bound.sql).unwrap();
    let worker = {
        let io = io.clone();
        let registry = registry.clone();
        let id = operation.operation_id.clone();
        tokio::spawn(async move {
            run_write(&registry, &id, &bound, io.as_ref(), None::<&Io>, SourceOrigin::OceanBaseDictionary).await
        })
    };
    io.entered.notified().await;
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    assert_eq!(registry.observe(&operation.operation_id).lifecycle, RoutineOperationLifecycle::Unproven);
    let next = registry.prepare(binding());
    assert!(
        matches!(registry.begin(&next.operation_id, SOURCE).unwrap(), BeginRoutineOperation::Existing(record) if record.lifecycle == RoutineOperationLifecycle::Terminal && !record.dispatched)
    );
}

#[tokio::test]
async fn live_preflight_preserves_read_only_policy_and_rejects_a_changed_original_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let storage = crate::persistence::test_storage::open(&dir.path().join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let bound = binding();
    state.configs.write().await.insert("target".into(), bound.expected_config.clone());
    let io = LiveWriter {
        catalog: LiveCatalog { state: &state, endpoint: &bound.target, config: &bound.expected_config },
        cancellation: CancellationToken::new(),
        execution_id: "policy-test",
    };
    assert!(io.check_write(&bound.sql).await.is_ok());
    state.configs.write().await.get_mut("target").unwrap().read_only = true;
    assert!(io.check_write(&bound.sql).await.is_err());
    state.configs.write().await.get_mut("target").unwrap().read_only = false;
    assert!(io.check_write(&bound.sql).await.is_ok());
    state.configs.write().await.get_mut("target").unwrap().host = "changed-endpoint".into();
    assert!(io.check_write(&bound.sql).await.unwrap_err().contains("changed"));
}

#[tokio::test]
async fn losing_only_the_readback_preserves_the_original_terminal_write_receipt() {
    let io = Arc::new(Io { block_readback: true, ..Default::default() });
    let registry = Arc::new(RoutineOperationRegistry::default());
    let bound = binding();
    let operation = registry.prepare(bound.clone());
    registry.begin(&operation.operation_id, &bound.sql).unwrap();
    let worker = {
        let io = io.clone();
        let registry = registry.clone();
        let id = operation.operation_id.clone();
        tokio::spawn(async move {
            run_write(&registry, &id, &bound, io.as_ref(), None::<&Io>, SourceOrigin::OceanBaseDictionary).await
        })
    };
    io.readback_entered.notified().await;
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    let observed = registry.observe(&operation.operation_id).operation.unwrap();
    assert_eq!(observed.lifecycle, RoutineOperationLifecycle::Terminal);
    assert!(observed.dispatched && observed.acknowledged);
    assert!(!observed.verified());
    assert!(observed.readback.is_none());
}

struct PlanIo {
    prerequisite: Io,
    next: Io,
}

#[async_trait::async_trait]
impl RoutineCatalog for PlanIo {
    async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
        if sql.contains("'Read.Func'") {
            self.prerequisite.query(sql).await
        } else {
            self.next.query(sql).await
        }
    }
    async fn source(&self, identity: &RoutineIdentity) -> Result<SourceReply, String> {
        if identity.name == "Read.Func" {
            self.prerequisite.source(identity).await
        } else {
            self.next.source(identity).await
        }
    }
}

#[async_trait::async_trait]
impl RoutineWriteIo for PlanIo {
    async fn check_write(&self, sql: &str) -> Result<(), String> {
        self.next.check_write(sql).await
    }
    async fn write(&self, sql: &str) -> Result<db::QueryResult, QueryExecutionError> {
        self.next.write(sql).await
    }
}

#[tokio::test]
async fn review_regression_completed_prerequisite_is_rechecked_before_the_next_dispatch() {
    for change in ["unchanged", "body", "identity", "status", "deleted", "refreshed-identity", "reappeared"] {
        let registry = RoutineOperationRegistry::default();
        let mut previous = binding();
        if change == "reappeared" {
            previous.sql = "DROP FUNCTION \"OWNER\".\"Read.Func\"".into();
            previous.goal = RoutineReadbackGoal::Absent;
        }
        let first = registry.prepare(previous.clone());
        registry.begin(&first.operation_id, &previous.sql).unwrap();
        let original_io = Io::default();
        run_write(
            &registry,
            &first.operation_id,
            &previous,
            &original_io,
            None::<&Io>,
            SourceOrigin::OceanBaseDictionary,
        )
        .await;
        assert!(registry.observe(&first.operation_id).operation.unwrap().verified());

        let prerequisite = Io {
            source_text: if change == "body" { SOURCE.replace("RETURN 1", "RETURN 9") } else { SOURCE.into() },
            object_id: if matches!(change, "identity" | "refreshed-identity") { 99 } else { 12 },
            invalid: change == "status",
            exists: AtomicBool::new(change != "deleted"),
            ..Default::default()
        };
        if change == "refreshed-identity" {
            let current = readback::readback(
                &prerequisite,
                &previous.target,
                previous.identity.clone(),
                &previous.goal,
                SourceOrigin::OceanBaseDictionary,
            )
            .await;
            assert_eq!(current.state, RoutineReadbackState::Verified);
            registry.update_readback(&first.operation_id, current);
        }
        let next_source = SOURCE.replace("Read.Func", "Next.Func").replace("RETURN 1", "RETURN \"Read.Func\"");
        let next = RoutineWriteBinding {
            identity: RoutineIdentity { name: "Next.Func".into(), ..binding().identity },
            sql: next_source.clone(),
            goal: RoutineReadbackGoal::Definition { sql: next_source.clone() },
            prerequisite_operation_ids: vec![first.operation_id.clone()],
            ..binding()
        };
        let operation = registry.prepare(next.clone());
        assert!(matches!(
            registry.begin(&operation.operation_id, &next.sql).unwrap(),
            BeginRoutineOperation::Dispatch(_)
        ));
        let io = PlanIo {
            prerequisite,
            next: Io { name: "Next.Func".into(), source_text: next_source, ..Default::default() },
        };
        run_write(&registry, &operation.operation_id, &next, &io, None::<&Io>, SourceOrigin::OceanBaseDictionary).await;
        let result = registry.observe(&operation.operation_id).operation.unwrap();
        if change == "unchanged" {
            assert!(result.verified(), "{}", result.failure_message());
            assert_eq!(io.next.writes.load(Ordering::SeqCst), 1);
        } else {
            assert!(!result.dispatched, "{change}: the next routine was dispatched after the prerequisite changed");
            assert_eq!(result.lifecycle, RoutineOperationLifecycle::Terminal);
            assert_eq!(io.next.writes.load(Ordering::SeqCst), 0);
        }
        assert_eq!(original_io.writes.load(Ordering::SeqCst), 1, "completed work must not be replayed");
    }
}
