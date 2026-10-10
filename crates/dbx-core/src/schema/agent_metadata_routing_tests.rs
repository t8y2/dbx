use super::{
    get_table_comment_core, get_table_ddl_core, list_databases_core, list_object_statistics_core, AppState,
    ConnectionConfig, DatabaseType, PoolKind,
};
use crate::db::agent_driver::{AgentDriverClient, PooledAgentClient};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

struct AgentFixture {
    state: Arc<AppState>,
    directory: tempfile::TempDir,
    _listener: tokio::net::TcpListener,
}

impl AgentFixture {
    async fn new(db_type: DatabaseType) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            directory.path().join("plugins"),
            directory.path().join("agents"),
            "test",
        ));
        let profile = (db_type == DatabaseType::SqlServer).then_some("sqlserver-legacy");
        let driver_key = crate::database_capabilities::agent_key(&db_type, profile).unwrap();
        let executable = state.agent_manager.driver_native_path(driver_key);
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, include_str!("agent_metadata_fixture.py")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id": "conn", "name": "Agent metadata fixture", "db_type": db_type,
            "host": "127.0.0.1", "port": listener.local_addr().unwrap().port(),
            "username": "fixture", "password": "", "database": "configured", "driver_profile": profile,
            "connect_timeout_secs": 2, "query_timeout_secs": 1,
            "keepalive_interval_secs": 0, "idle_timeout_secs": 0
        }))
        .unwrap();
        state.configs.write().await.insert("conn".into(), config);
        Self { state, directory, _listener: listener }
    }

    fn control_path(&self, name: &str) -> std::path::PathBuf {
        let config = self.state.agent_manager.base_dir();
        config.join(name)
    }

    fn requests(&self, method: &str) -> Vec<Value> {
        std::fs::read_to_string(self.control_path("requests.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|request| request["method"] == method)
            .collect()
    }

    async fn pool(&self, key: &str) -> Arc<PooledAgentClient> {
        match self.state.pool_handle(key).await.unwrap() {
            PoolKind::Agent(client) => client,
            _ => panic!("expected Agent pool"),
        }
    }

    async fn wait_for_requests(&self, method: &str, count: usize) -> Vec<Value> {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let requests = self.requests(method);
                if requests.len() >= count {
                    return requests;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("expected {count} {method} requests"))
    }

    async fn foreground(&self) -> Arc<PooledAgentClient> {
        let key = self.state.get_or_create_metadata_pool_for_session("conn", Some("configured"), None).await.unwrap();
        self.pool(&key).await
    }

    async fn assert_only_foreground_remains(&self, foreground: &Arc<PooledAgentClient>) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let ready = self.state.with_connection_pools(|pools| {
                    pools.len() == 1 && matches!(pools.get("conn:configured:role:metadata"), Some(PoolKind::Agent(client)) if Arc::ptr_eq(client, foreground))
                }).await;
                let sessions = self.state.agent_manager.connection_runtimes.lock().await.values()
                    .filter_map(|cell| cell.get()).map(|runtime| runtime.active_session_count()).sum::<u64>();
                if ready && sessions == 1 { return; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("ephemeral pool and Agent session must be released");
    }

    async fn shutdown(self) {
        self.state.shutdown(Duration::from_secs(2)).await;
        drop(self.directory);
    }
}

#[tokio::test]
async fn enumeration_creates_metadata_pool_when_only_workload_exists() {
    let fixture = AgentFixture::new(DatabaseType::Hive).await;
    let workload_key = fixture.state.get_or_create_pool_for_session("conn", None, None).await.unwrap();
    let workload = fixture.pool(&workload_key).await;

    let databases = list_databases_core(&fixture.state, "conn").await.unwrap();

    assert_eq!(databases[0].name, "metadata");
    assert!(Arc::ptr_eq(&workload, &fixture.pool(&workload_key).await));
    let opens = fixture.requests("open_session");
    assert_eq!(opens.len(), 2);
    assert_eq!(opens[1]["params"]["database"], "configured");
    assert_eq!(fixture.requests("list_databases")[0]["params"]["agentSessionId"], opens[1]["params"]["agentSessionId"]);
    fixture.shutdown().await;
}

#[tokio::test]
async fn enumeration_uses_metadata_pool_when_both_roles_exist() {
    let fixture = AgentFixture::new(DatabaseType::Hive).await;
    fixture.state.get_or_create_pool_for_session("conn", None, None).await.unwrap();
    let metadata_key = fixture.state.get_or_create_metadata_pool_for_session("conn", None, None).await.unwrap();
    let metadata = fixture.pool(&metadata_key).await;

    assert_eq!(list_databases_core(&fixture.state, "conn").await.unwrap()[0].name, "metadata");
    assert!(Arc::ptr_eq(&metadata, &fixture.pool(&metadata_key).await));
    assert_eq!(fixture.requests("open_session").len(), 2);
    fixture.shutdown().await;
}

#[tokio::test]
async fn enumeration_timeout_removes_metadata_and_next_call_opens_fresh_session() {
    let fixture = AgentFixture::new(DatabaseType::Hive).await;
    let workload_key = fixture.state.get_or_create_pool_for_session("conn", None, None).await.unwrap();
    let workload = fixture.pool(&workload_key).await;
    let metadata_key = fixture.state.get_or_create_metadata_pool_for_session("conn", None, None).await.unwrap();
    let metadata = fixture.pool(&metadata_key).await;
    std::fs::write(fixture.control_path("list-error"), "timeout").unwrap();

    let error = list_databases_core(&fixture.state, "conn").await.unwrap_err();

    assert!(error.contains("fixture timeout"), "{error}");
    assert_eq!(fixture.requests("list_databases").len(), 1);
    assert!(fixture.state.pool_handle(&metadata_key).await.is_none());
    assert!(Arc::ptr_eq(&workload, &fixture.pool(&workload_key).await));
    std::fs::remove_file(fixture.control_path("list-error")).unwrap();
    assert_eq!(list_databases_core(&fixture.state, "conn").await.unwrap()[0].name, "metadata");
    assert!(!Arc::ptr_eq(&metadata, &fixture.pool(&metadata_key).await));
    assert_eq!(fixture.requests("list_databases").len(), 2);
    fixture.shutdown().await;
}

#[tokio::test]
async fn enumeration_transport_failure_replaces_runtime_but_preserves_unrelated_workload() {
    let fixture = AgentFixture::new(DatabaseType::Hive).await;
    let unrelated = Arc::new(PooledAgentClient::new(AgentDriverClient::test_stub()));
    fixture
        .state
        .update_connection_pools(|pools| {
            pools.insert("conn".into(), PoolKind::Agent(unrelated.clone()));
        })
        .await;
    let metadata_key = fixture.state.get_or_create_metadata_pool_for_session("conn", None, None).await.unwrap();
    let failed = fixture.pool(&metadata_key).await;
    std::fs::write(fixture.control_path("list-error"), "transport").unwrap();

    let error = list_databases_core(&fixture.state, "conn").await.unwrap_err();

    assert!(error.contains("fixture transport"), "{error}");
    assert!(fixture.state.pool_handle(&metadata_key).await.is_none());
    assert!(Arc::ptr_eq(&unrelated, &fixture.pool("conn").await));
    assert_eq!(fixture.requests("list_databases").len(), 1);
    std::fs::remove_file(fixture.control_path("list-error")).unwrap();
    assert_eq!(list_databases_core(&fixture.state, "conn").await.unwrap()[0].name, "metadata");
    assert!(!Arc::ptr_eq(&failed, &fixture.pool(&metadata_key).await));
    fixture.shutdown().await;
}

#[tokio::test]
async fn enumeration_native_sqlite_keeps_existing_pool() {
    let directory = tempfile::tempdir().unwrap();
    let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let pool = crate::db::sqlite::connect_path(":memory:").await.unwrap();
    state
        .update_connection_pools(|pools| {
            pools.insert("sqlite".into(), PoolKind::Sqlite(pool));
        })
        .await;
    assert!(!list_databases_core(&state, "sqlite").await.unwrap().is_empty());
    assert!(state.pool_handle("sqlite").await.is_some());
    state.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn enumeration_ignores_bare_client_with_unavailable_stdin() {
    let fixture = AgentFixture::new(DatabaseType::Hive).await;
    fixture
        .state
        .update_connection_pools(|pools| {
            pools.insert("conn".into(), PoolKind::agent(AgentDriverClient::test_stub()));
        })
        .await;

    assert_eq!(list_databases_core(&fixture.state, "conn").await.unwrap()[0].name, "metadata");
    assert_eq!(fixture.requests("open_session").len(), 1);
    fixture.shutdown().await;
}

#[tokio::test]
async fn enumeration_runtime_fail_stop_removes_shared_workload_and_recreates_without_bare_pool() {
    let fixture = AgentFixture::new(DatabaseType::Hive).await;
    let workload_key = fixture.state.get_or_create_pool_for_session("conn", None, None).await.unwrap();
    let metadata_key = fixture.state.get_or_create_metadata_pool_for_session("conn", None, None).await.unwrap();
    std::fs::write(fixture.control_path("list-error"), "transport").unwrap();

    assert!(list_databases_core(&fixture.state, "conn").await.unwrap_err().contains("fixture transport"));
    assert!(fixture.state.pool_handle(&metadata_key).await.is_none());
    assert!(fixture.state.pool_handle(&workload_key).await.is_none());
    std::fs::remove_file(fixture.control_path("list-error")).unwrap();
    assert_eq!(list_databases_core(&fixture.state, "conn").await.unwrap()[0].name, "metadata");
    assert!(fixture.state.pool_handle(&workload_key).await.is_none());
    assert_eq!(fixture.requests("open_session").len(), 3);
    fixture.shutdown().await;
}

#[tokio::test]
async fn enumeration_sql_error_keeps_metadata_session_without_replay() {
    let fixture = AgentFixture::new(DatabaseType::Hive).await;
    let metadata_key = fixture.state.get_or_create_metadata_pool_for_session("conn", None, None).await.unwrap();
    let metadata = fixture.pool(&metadata_key).await;
    std::fs::write(fixture.control_path("list-error"), "sql").unwrap();

    assert!(list_databases_core(&fixture.state, "conn").await.unwrap_err().contains("fixture sql"));
    assert!(Arc::ptr_eq(&metadata, &fixture.pool(&metadata_key).await));
    assert_eq!(fixture.requests("list_databases").len(), 1);
    fixture.shutdown().await;
}

#[tokio::test]
async fn enumeration_mongo_keeps_document_workload_route() {
    let fixture = AgentFixture::new(DatabaseType::Hive).await;
    fixture.state.get_or_create_pool_for_session("conn", None, None).await.unwrap();
    fixture.state.configs.write().await.get_mut("conn").unwrap().db_type = DatabaseType::MongoDb;

    assert_eq!(list_databases_core(&fixture.state, "conn").await.unwrap()[0].name, "workload");
    assert_eq!(fixture.requests("open_session").len(), 1);
    assert!(fixture.state.pool_handle("conn:role:metadata").await.is_none());
    fixture.shutdown().await;
}

#[tokio::test]
async fn enumeration_legacy_sqlserver_reuses_connection_metadata_across_databases() {
    let fixture = AgentFixture::new(DatabaseType::SqlServer).await;
    let metadata_key =
        fixture.state.get_or_create_metadata_pool_for_session("conn", Some("other"), None).await.unwrap();
    let metadata = fixture.pool(&metadata_key).await;

    assert_eq!(list_databases_core(&fixture.state, "conn").await.unwrap()[0].name, "workload");
    assert!(Arc::ptr_eq(&metadata, &fixture.pool(&metadata_key).await));
    assert_eq!(fixture.requests("connect").len(), 1);
    assert_eq!(metadata_key, "conn:role:metadata");
    fixture.shutdown().await;
}

#[tokio::test]
async fn legacy_sqlserver_table_comment_reads_extended_property_through_agent_query() {
    let fixture = AgentFixture::new(DatabaseType::SqlServer).await;

    let comment = get_table_comment_core(&fixture.state, "conn", "sales", "dbo", "orders").await.unwrap();

    // The fixture answers every query with a first string cell of `EVENTS`.
    assert_eq!(comment.as_deref(), Some("EVENTS"));
    let queries = fixture.requests("execute_query");
    assert_eq!(queries.len(), 1);
    let sql = queries[0]["params"]["sql"].as_str().unwrap();
    assert!(sql.contains("sys.extended_properties"), "{sql}");
    assert!(sql.contains("N'MS_Description'"), "{sql}");
    assert!(sql.contains("QUOTENAME('dbo') + '.' + QUOTENAME('orders')"), "{sql}");
    assert_eq!(queries[0]["params"]["database"], "sales");
    fixture.shutdown().await;
}

#[tokio::test]
async fn statistics_do_not_block_foreground_ddl_on_shared_runtime() {
    let fixture = AgentFixture::new(DatabaseType::Dameng).await;
    let foreground = fixture.foreground().await;
    std::fs::write(fixture.control_path("statistics"), "block").unwrap();
    let state = fixture.state.clone();
    let statistics =
        tokio::spawn(async move { list_object_statistics_core(&state, "conn", "configured", "APP").await });
    fixture.wait_for_requests("execute_query", 1).await;

    let ddl = tokio::time::timeout(
        Duration::from_millis(500),
        get_table_ddl_core(&fixture.state, "conn", "configured", "APP", "EVENTS", None),
    )
    .await;

    std::fs::write(fixture.control_path("release-statistics"), "release").unwrap();
    let result = statistics.await.unwrap().unwrap();
    assert!(ddl.is_ok(), "foreground DDL waited for background statistics");
    assert!(ddl.unwrap().unwrap().contains("CREATE TABLE"));
    assert_eq!(result[0].estimated_rows, Some(12));
    assert_eq!(result[0].total_bytes, Some(4096));
    let opens = fixture.requests("open_session");
    assert_eq!(opens.len(), 2);
    assert_ne!(
        fixture.requests("execute_query")[0]["params"]["agentSessionId"],
        fixture.requests("get_table_ddl")[0]["params"]["agentSessionId"]
    );
    assert_eq!(fixture.state.agent_manager.connection_runtimes.lock().await.len(), 1);
    fixture.assert_only_foreground_remains(&foreground).await;
    assert_eq!(fixture.requests("close_session").len(), 1);
    fixture.shutdown().await;
}

#[tokio::test]
async fn statistics_fallback_reuses_ephemeral_session_and_closes_it() {
    let fixture = AgentFixture::new(DatabaseType::Dameng).await;
    let foreground = fixture.foreground().await;
    std::fs::write(fixture.control_path("statistics"), "fallback").unwrap();

    let result = list_object_statistics_core(&fixture.state, "conn", "configured", "APP").await.unwrap();

    assert_eq!(result[0].estimated_rows, Some(12));
    assert_eq!(result[0].total_bytes, None);
    let queries = fixture.requests("execute_query");
    assert_eq!(queries.len(), 2);
    assert_eq!(queries[0]["params"]["agentSessionId"], queries[1]["params"]["agentSessionId"]);
    assert_eq!(fixture.requests("open_session").len(), 2);
    fixture.wait_for_requests("close_session", 1).await;
    fixture.assert_only_foreground_remains(&foreground).await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn statistics_sql_error_and_timeout_clean_up_without_replaying() {
    for failure in ["sql", "timeout"] {
        let fixture = AgentFixture::new(DatabaseType::Dameng).await;
        let foreground = fixture.foreground().await;
        std::fs::write(fixture.control_path("statistics"), failure).unwrap();

        let error = list_object_statistics_core(&fixture.state, "conn", "configured", "APP").await.unwrap_err();

        assert!(error.contains(&format!("fixture {failure}")), "{error}");
        assert_eq!(fixture.requests("execute_query").len(), 2);
        assert_eq!(fixture.requests("open_session").len(), 2);
        fixture.wait_for_requests("close_session", 1).await;
        fixture.assert_only_foreground_remains(&foreground).await;
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn statistics_connection_retry_replaces_only_ephemeral_session() {
    let fixture = AgentFixture::new(DatabaseType::Dameng).await;
    let foreground = fixture.foreground().await;
    std::fs::write(fixture.control_path("statistics"), "retry").unwrap();

    let result = list_object_statistics_core(&fixture.state, "conn", "configured", "APP").await.unwrap();

    assert_eq!(result[0].estimated_rows, Some(12));
    assert_eq!(fixture.requests("open_session").len(), 3);
    assert_eq!(fixture.requests("execute_query").len(), 3);
    fixture.wait_for_requests("close_session", 2).await;
    fixture.assert_only_foreground_remains(&foreground).await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn statistics_abort_closes_busy_session_and_preserves_foreground() {
    let fixture = AgentFixture::new(DatabaseType::Dameng).await;
    let foreground = fixture.foreground().await;
    std::fs::write(fixture.control_path("statistics"), "block").unwrap();
    let state = fixture.state.clone();
    let statistics =
        tokio::spawn(async move { list_object_statistics_core(&state, "conn", "configured", "APP").await });
    fixture.wait_for_requests("execute_query", 1).await;

    statistics.abort();
    assert!(statistics.await.unwrap_err().is_cancelled());

    fixture.wait_for_requests("close_session", 1).await;
    fixture.assert_only_foreground_remains(&foreground).await;
    assert!(get_table_ddl_core(&fixture.state, "conn", "configured", "APP", "EVENTS", None)
        .await
        .unwrap()
        .contains("CREATE TABLE"));
    fixture.shutdown().await;
}

#[tokio::test]
async fn statistics_capacity_error_does_not_invalidate_foreground_or_open_extra_sessions() {
    let fixture = AgentFixture::new(DatabaseType::Dameng).await;
    let foreground = fixture.foreground().await;
    std::fs::write(fixture.control_path("capacity"), "1").unwrap();

    let result = list_object_statistics_core(&fixture.state, "conn", "configured", "APP").await;

    assert!(result.is_err(), "statistics bypassed the Agent session limit");
    assert_eq!(fixture.requests("open_session").len(), 2);
    assert!(fixture.requests("execute_query").is_empty());
    fixture.assert_only_foreground_remains(&foreground).await;
    assert!(get_table_ddl_core(&fixture.state, "conn", "configured", "APP", "EVENTS", None)
        .await
        .unwrap()
        .contains("CREATE TABLE"));
    fixture.shutdown().await;
}

#[tokio::test]
async fn statistics_dropping_polled_future_closes_busy_session() {
    let fixture = AgentFixture::new(DatabaseType::Dameng).await;
    let foreground = fixture.foreground().await;
    std::fs::write(fixture.control_path("statistics"), "block").unwrap();
    let mut statistics = Box::pin(list_object_statistics_core(&fixture.state, "conn", "configured", "APP"));
    tokio::select! {
        result = &mut statistics => panic!("statistics unexpectedly completed: {result:?}"),
        _ = fixture.wait_for_requests("execute_query", 1) => {}
    }

    drop(statistics);

    fixture.wait_for_requests("close_session", 1).await;
    fixture.assert_only_foreground_remains(&foreground).await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn statistics_repeated_requests_release_every_ephemeral_session() {
    let fixture = AgentFixture::new(DatabaseType::Dameng).await;
    let foreground = fixture.foreground().await;
    for _ in 0..4 {
        let result = list_object_statistics_core(&fixture.state, "conn", "configured", "APP").await.unwrap();
        assert_eq!(result.len(), 1);
        fixture.assert_only_foreground_remains(&foreground).await;
    }
    let opens = fixture.requests("open_session");
    let closed = fixture.requests("close_session");
    assert_eq!(opens.len(), 5);
    assert_eq!(closed.len(), 4);
    let opened_sessions =
        opens[1..].iter().map(|request| request["params"]["agentSessionId"].clone()).collect::<Vec<_>>();
    assert!(closed.iter().all(|request| opened_sessions.contains(&request["params"]["agentSessionId"])));
    fixture.shutdown().await;
}

#[tokio::test]
async fn statistics_empty_result_closes_session_without_fallback() {
    let fixture = AgentFixture::new(DatabaseType::Dameng).await;
    let foreground = fixture.foreground().await;
    std::fs::write(fixture.control_path("statistics"), "empty").unwrap();

    assert!(list_object_statistics_core(&fixture.state, "conn", "configured", "APP").await.unwrap().is_empty());

    assert_eq!(fixture.requests("execute_query").len(), 1);
    fixture.wait_for_requests("close_session", 1).await;
    fixture.assert_only_foreground_remains(&foreground).await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn statistics_native_sqlite_preserves_default_pool() {
    let directory = tempfile::tempdir().unwrap();
    let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id": "sqlite", "name": "SQLite statistics", "db_type": "sqlite",
        "host": ":memory:", "port": 0, "username": "", "password": "",
        "keepalive_interval_secs": 0, "idle_timeout_secs": 0
    }))
    .unwrap();
    state.configs.write().await.insert(config.id.clone(), config);
    let key = state.get_or_create_pool("sqlite", None).await.unwrap();

    assert!(list_object_statistics_core(&state, "sqlite", "", "main").await.unwrap().is_empty());

    assert!(state.with_connection_pools(|pools| pools.len() == 1 && pools.contains_key(&key)).await);
    assert!(state.agent_manager.connection_runtimes.lock().await.is_empty());
    state.shutdown(Duration::from_secs(2)).await;
}
