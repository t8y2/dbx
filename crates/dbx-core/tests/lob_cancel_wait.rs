use dbx_core::connection::{AppState, PoolKind, TransactionSession, TxnConnection};
use dbx_core::db::agent_driver::{AgentDriverClient, AgentLaunchSpec, AgentRuntimeClient};
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::query::{request_large_value, request_large_value_reported, LargeValueCompletion, LargeValueRequest};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

struct Fixture {
    state: AppState,
    runtime: Arc<AgentRuntimeClient>,
    directory: tempfile::TempDir,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.runtime.kill();
    }
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lob_cancel_wait_agent.py");
        let log_path = directory.path().join("methods.log");
        let python = if cfg!(windows) { "python" } else { "python3" };
        let runtime = AgentRuntimeClient::spawn(
            AgentLaunchSpec::new(python)
                .with_args([script.to_string_lossy().to_string(), log_path.to_string_lossy().to_string()]),
            "test",
        )
        .await
        .unwrap();
        runtime.increment_session_count();
        let storage = dbx_core::persistence::test_storage::open(&directory.path().join("state.db")).await.unwrap();
        let state = AppState::new(storage);
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id":"lob", "name":"LOB wait fixture", "db_type":"oceanbase-oracle",
            "host":"127.0.0.1", "port":1, "username":"fixture", "password":"", "connect_timeout_secs":1
        }))
        .unwrap();
        state.configs.write().await.insert("lob".into(), config);
        state
            .update_connection_pools(|pools| {
                pools.insert(
                    "lob".into(),
                    PoolKind::agent(AgentDriverClient::shared_session(runtime.clone(), "lob-fixture".into())),
                )
            })
            .await;
        Self { state, runtime, directory }
    }

    fn assert_no_lob_rpc(&self) {
        let methods = std::fs::read_to_string(self.directory.path().join("methods.log")).unwrap_or_default();
        assert!(
            !methods.lines().any(|method| method == "read_large_value_chunk" || method == "release_large_value"),
            "A cancelled lock wait sent a LOB RPC"
        );
    }
}

fn request(transaction: bool) -> LargeValueRequest {
    serde_json::from_value(json!({
        "connectionId":"lob", "database":"", "valueRef":"captured-locator", "offset":0, "limit":4096,
        "executionId":"lob-wait", "txnSessionId":if transaction { Some("txn") } else { None }
    }))
    .unwrap()
}

async fn assert_local_cancel(fixture: &Fixture, transaction: bool, release: bool) {
    let mut pending = Box::pin(request_large_value(&fixture.state, request(transaction), release));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut pending).await.is_err(),
        "Fixture must hold the actual entry pending"
    );
    assert!(fixture.state.running_queries.diagnostics().active_execution_ids.iter().any(|id| id == "lob-wait"));
    assert!(fixture.state.running_queries.cancel("lob-wait"));
    let result = tokio::time::timeout(Duration::from_secs(1), &mut pending).await;
    assert!(result.is_ok(), "Cancelling must end local waiting while the lock remains held");
    assert_eq!(result.unwrap().unwrap_err(), "Query canceled");
    assert!(fixture.state.running_queries.diagnostics().active_execution_ids.is_empty());
    fixture.assert_no_lob_rpc();
}

#[tokio::test]
async fn public_lob_request_cancels_while_waiting_for_transaction_registry() {
    for release in [false, true] {
        let fixture = Fixture::new().await;
        let _held = fixture.state.transaction_sessions.write().await;
        assert_local_cancel(&fixture, true, release).await;
    }
}

#[tokio::test]
async fn public_lob_request_cancels_while_waiting_for_transaction_connection() {
    for release in [false, true] {
        let fixture = Fixture::new().await;
        let connection = Arc::new(Mutex::new(TxnConnection::Mysql(None)));
        fixture.state.transaction_sessions.write().await.insert(
            "txn".into(),
            TransactionSession {
                mysql_data_charset: None,
                sqlserver: None,
                connection: connection.clone(),
                pool_key: "lob".into(),
                last_activity: Instant::now(),
                idle_timeout: std::time::Duration::from_secs(dbx_core::query::MANUAL_TRANSACTION_IDLE_TIMEOUT_SECS),
                busy: false,
                snapshot_rotation_safe: false,
                connection_id: "lob".into(),
                database: "".into(),
                schema: None,
            },
        );
        let _held = connection.lock().await;
        assert_local_cancel(&fixture, true, release).await;
    }
}

#[tokio::test]
async fn public_lob_request_cancels_while_waiting_for_agent_client() {
    for release in [false, true] {
        let fixture = Fixture::new().await;
        let Some(PoolKind::Agent(client)) = fixture.state.pool_handle("lob").await else {
            panic!("Agent fixture missing")
        };
        let _held = client.lock().await;
        assert_local_cancel(&fixture, false, release).await;
    }
}

#[tokio::test]
async fn reported_lob_cancel_during_lock_wait_is_confirmed_without_rpc() {
    let fixture = Fixture::new().await;
    let Some(PoolKind::Agent(client)) = fixture.state.pool_handle("lob").await else { panic!("Agent fixture missing") };
    let _held = client.lock().await;
    let mut pending = Box::pin(request_large_value_reported(&fixture.state, request(false)));
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut pending).await.is_err());
    assert!(fixture.state.running_queries.cancel("lob-wait"));
    let error = tokio::time::timeout(Duration::from_secs(1), pending).await.unwrap().unwrap_err();
    assert_eq!(error.status, LargeValueCompletion::Cancelled);
    fixture.assert_no_lob_rpc();
}

#[tokio::test]
async fn reported_lob_cancel_waits_for_original_response_and_preserves_transport_unknown() {
    for transport in [false, true] {
        let fixture = Fixture::new().await;
        let mut req = request(false);
        req.value_ref = if transport { "delayed-transport" } else { "delayed" }.into();
        let mut pending = Box::pin(request_large_value_reported(&fixture.state, req));
        tokio::select! {
            result = &mut pending => panic!("Read returned before original response: {result:?}"),
            _ = async {
                tokio::time::timeout(Duration::from_secs(2), async {
                    loop {
                        let methods = std::fs::read_to_string(fixture.directory.path().join("methods.log")).unwrap_or_default();
                        if methods.lines().any(|method| method == "read_large_value_chunk") { break; }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }).await.unwrap();
            } => {}
        }
        assert!(fixture.state.running_queries.cancel("lob-wait"));
        assert!(tokio::time::timeout(Duration::from_millis(30), &mut pending).await.is_err());
        std::fs::write(fixture.directory.path().join("methods.release"), "release").unwrap();
        let error = tokio::time::timeout(Duration::from_secs(2), pending).await.unwrap().unwrap_err();
        assert_eq!(
            error.status,
            if transport { LargeValueCompletion::Unknown } else { LargeValueCompletion::Cancelled }
        );
    }
}

#[tokio::test]
async fn reported_lob_original_error_is_a_confirmed_failure() {
    let fixture = Fixture::new().await;
    let mut req = request(false);
    req.value_ref = "original-error".into();
    let error = request_large_value_reported(&fixture.state, req).await.unwrap_err();
    assert_eq!(error.status, LargeValueCompletion::Failed);
    assert!(error.message.contains("fixture read failed"));
}

#[tokio::test]
async fn public_lob_request_cancels_while_preparing_its_pool() {
    for release in [false, true] {
        let fixture = Fixture::new().await;
        let _held = fixture.state.configs.write().await;
        assert_local_cancel(&fixture, false, release).await;
    }
}

#[tokio::test]
async fn public_lob_request_does_not_recreate_a_missing_locator_session() {
    for release in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let storage = dbx_core::persistence::test_storage::open(&directory.path().join("state.db")).await.unwrap();
        let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            directory.path().join("plugins"),
            directory.path().join("agents"),
            "test",
        );
        let launch = state.agent_manager.driver_launch_config_path("oceanbase-oracle");
        std::fs::create_dir_all(launch.parent().unwrap()).unwrap();
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lob_cancel_wait_agent.py");
        let log = directory.path().join("methods.log");
        std::fs::write(
            launch,
            serde_json::to_vec(&json!({
                "command":if cfg!(windows) { "python" } else { "python3" }, "args":[script, log]
            }))
            .unwrap(),
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id":"lob", "name":"Missing locator fixture", "db_type":"oceanbase-oracle",
            "host":"127.0.0.1", "port":listener.local_addr().unwrap().port(),
            "username":"fixture", "password":"", "save_password":true,
            "keepalive_interval_secs":0, "idle_timeout_secs":0
        }))
        .unwrap();
        state.configs.write().await.insert("lob".into(), config);
        let result = request_large_value(&state, request(false), release).await;
        let methods = std::fs::read_to_string(log).unwrap_or_default();
        state.shutdown(Duration::from_secs(2)).await;
        assert_eq!(result.unwrap_err(), "LOB context has expired; rerun the query");
        assert!(methods.is_empty(), "Missing locator session must not start an Agent: {methods}");
        assert!(state.running_queries.diagnostics().active_execution_ids.is_empty());
    }
}

#[tokio::test]
async fn public_lob_request_uses_only_its_original_workload_scope() {
    for release in [false, true] {
        let fixture = Fixture::new().await;
        for (database, catalog, client_session) in [("", None, Some("other-tab")), ("other-database", None, None)] {
            let mut req = request(false);
            req.database = database.into();
            req.catalog = catalog.map(str::to_string);
            req.client_session_id = client_session.map(str::to_string);
            assert_eq!(
                request_large_value(&fixture.state, req, release).await.unwrap_err(),
                "LOB context has expired; rerun the query"
            );
        }
        fixture.assert_no_lob_rpc();
        let mut req = request(false);
        // A catalog query uses the connection workload pool, matching query_pool_database.
        req.database = "catalog-display-database".into();
        req.catalog = Some("catalog".into());
        assert!(request_large_value(&fixture.state, req, release).await.is_ok());
    }
}

#[tokio::test]
async fn public_lob_request_does_not_fall_back_to_metadata_role() {
    let fixture = Fixture::new().await;
    fixture
        .state
        .update_connection_pools(|pools| {
            let pool = pools.remove("lob").unwrap();
            pools.insert("lob:role:metadata".into(), pool);
        })
        .await;
    assert_eq!(
        request_large_value(&fixture.state, request(false), false).await.unwrap_err(),
        "LOB context has expired; rerun the query"
    );
    fixture.assert_no_lob_rpc();
}
