use super::{list_databases_core, AppState, ConnectionConfig, DatabaseType, PoolKind};
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
