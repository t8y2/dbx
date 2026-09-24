use super::plugin_metadata::{get_table_metadata, PluginTableContext, TABLE_METADATA_SESSION_NOT_OPEN_ERROR};
use super::{
    get_columns_core_for_existing_pool, get_columns_core_for_session_inner, run_metadata_connection_for_session,
};
use crate::connection::{AppState, PoolKind, METADATA_POOL_ACQUIRE_TIMEOUT};
use crate::db::agent_driver::{AgentDriverClient, AgentLaunchSpec, AgentRuntimeClient};
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::storage::Storage;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

async fn state(db_type: DatabaseType) -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let storage = Storage::open(&dir.path().join("storage.db")).await.unwrap();
    let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        dir.path().join("agents"),
        "test",
    );
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "conn",
        "name": "Metadata test",
        "db_type": db_type,
        "host": "127.0.0.1",
        "port": 5432,
        "username": "user",
        "password": "secret",
        "database": "app",
        "connect_timeout_secs": 1
    }))
    .unwrap();
    state.configs.write().await.insert(config.id.clone(), config);
    (dir, state)
}

fn context() -> PluginTableContext {
    PluginTableContext {
        connection_id: "conn".to_string(),
        database: Some("app".to_string()),
        schema: Some("public".to_string()),
        table: "users".to_string(),
    }
}

struct ScriptedAgent(Arc<AgentRuntimeClient>);

impl Drop for ScriptedAgent {
    fn drop(&mut self) {
        self.0.kill();
    }
}

async fn scripted_agent(dir: &std::path::Path, response: serde_json::Value) -> ScriptedAgent {
    let script = dir.join("metadata-agent.py");
    std::fs::write(
        &script,
        r#"import json, pathlib, sys
response = json.loads(sys.argv[1])
calls = pathlib.Path(sys.argv[2])
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    method = request['method']
    if method == 'handshake':
        body = {'result': {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']}}
    elif method == 'get_columns':
        with calls.open('a') as output:
            output.write(method + '\n')
        body = response
    else:
        body = {'result': {}}
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], **body}), flush=True)
"#,
    )
    .unwrap();
    let python = if cfg!(windows) { "python" } else { "python3" };
    let runtime = AgentRuntimeClient::spawn(
        AgentLaunchSpec::new(python).with_args([
            script.to_string_lossy().to_string(),
            response.to_string(),
            dir.join("calls").to_string_lossy().to_string(),
        ]),
        "test",
    )
    .await
    .unwrap();
    ScriptedAgent(runtime)
}

#[tokio::test]
async fn existing_pool_never_connects_on_empty_or_error_but_default_app_keeps_fallback() {
    for db_type in [DatabaseType::Highgo, DatabaseType::Vastbase] {
        for provider_error in [false, true] {
            let (dir, state) = state(db_type).await;
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            state.configs.write().await.get_mut("conn").unwrap().port = listener.local_addr().unwrap().port();
            let response = if provider_error {
                serde_json::json!({"error": {"code": -1, "message": "metadata denied", "data": {
                    "category": "sql", "sessionDisposition": "keep"
                }}})
            } else {
                serde_json::json!({"result": []})
            };
            let agent = scripted_agent(dir.path(), response).await;
            agent.0.increment_session_count();
            let client = AgentDriverClient::shared_session(agent.0.clone(), "metadata-session".to_string());
            let pool_key = "conn:app:role:metadata";
            state.update_connection_pools(|pools| pools.insert(pool_key.to_string(), PoolKind::agent(client))).await;

            let error = tokio::time::timeout(Duration::from_secs(3), async {
                tokio::select! {
                    biased;
                    _ = listener.accept() => panic!("plugin metadata attempted a native connection"),
                    result = get_table_metadata(&state, context()) => result.unwrap_err(),
                }
            })
            .await
            .expect("plugin metadata must not wait for a native fallback");
            if provider_error {
                assert!(error.contains("metadata denied"), "{error}");
                assert_eq!(
                    crate::db::agent_driver::try_agent_error_from_legacy(&error).and_then(|error| error.category()),
                    Some(crate::db::agent_driver::AgentErrorCategory::Sql)
                );
            } else {
                assert_eq!(error, "Table metadata provider returned no columns");
            }
            assert_eq!(std::fs::read_to_string(dir.path().join("calls")).unwrap().lines().count(), 1);
            assert!(state.pool_handle(pool_key).await.is_some());
            assert_eq!(state.with_connection_pools(|pools| pools.len()).await, 1);

            tokio::time::timeout(Duration::from_secs(3), async {
                tokio::select! {
                    accepted = listener.accept() => { accepted.unwrap(); }
                    result = get_columns_core_for_session_inner(&state, "conn", "app", "public", "users", None, true) => {
                        panic!("ordinary app skipped its native fallback: {result:?}");
                    }
                }
            })
            .await
            .expect("ordinary app fallback must still connect");
            assert_eq!(std::fs::read_to_string(dir.path().join("calls")).unwrap().lines().count(), 2);

            agent.0.kill();
            let stale_error = tokio::time::timeout(Duration::from_secs(3), async {
                tokio::select! {
                    biased;
                    _ = listener.accept() => panic!("stale plugin pool triggered a native connection"),
                    result = get_table_metadata(&state, context()) => result.unwrap_err(),
                }
            })
            .await
            .expect("cancelled metadata must release the agent lock");
            assert!(stale_error.contains("unavailable"), "{stale_error}");
            assert!(state.pool_handle(pool_key).await.is_some());
            assert_eq!(state.with_connection_pools(|pools| pools.len()).await, 1);
        }
    }
}

#[tokio::test]
async fn existing_pool_shares_app_concurrency_limit_and_queue_timeout() {
    for db_type in [DatabaseType::Mysql, DatabaseType::Postgres] {
        let (_dir, state) = state(db_type).await;
        tokio::time::pause();
        let entered = AtomicUsize::new(0);
        let mut operations = Vec::new();
        for index in 0..6 {
            let operation = run_metadata_connection_for_session(&state, "conn", Some("app"), None, index < 3, || {
                entered.fetch_add(1, Ordering::SeqCst);
                std::future::pending::<Result<(), String>>()
            });
            let mut operation = Box::pin(operation);
            assert!(futures::poll!(operation.as_mut()).is_pending());
            operations.push(operation);
        }
        assert_eq!(entered.load(Ordering::SeqCst), 6);
        let mut queued =
            Box::pin(run_metadata_connection_for_session(&state, "conn", Some("app"), None, false, || {
                entered.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            }));
        assert!(futures::poll!(queued.as_mut()).is_pending());
        tokio::time::advance(METADATA_POOL_ACQUIRE_TIMEOUT).await;
        assert_eq!(queued.await.unwrap_err(), crate::query::METADATA_POOL_BUSY_ERROR);
        assert_eq!(entered.load(Ordering::SeqCst), 6);
        drop(operations);
        for _ in 0..6 {
            run_metadata_connection_for_session(&state, "conn", Some("app"), None, false, || async { Ok(()) })
                .await
                .unwrap();
        }
        tokio::time::resume();
    }
}

#[tokio::test]
async fn existing_pool_entrypoint_waits_for_the_shared_budget_before_provider_lookup() {
    let (_dir, state) = state(DatabaseType::Postgres).await;
    let mut held = Vec::new();
    for _ in 0..6 {
        held.push(state.acquire_metadata_permit("conn", Some("app"), DatabaseType::Postgres, None).await.unwrap());
    }
    let mut lookup = Box::pin(get_columns_core_for_existing_pool(&state, "conn", "app", "public", "users", "conn:app"));
    assert!(futures::poll!(lookup.as_mut()).is_pending());
    drop(held.pop());
    assert_eq!(lookup.await.unwrap_err(), "Pool not found");
    let mut next = Box::pin(state.acquire_metadata_permit("conn", Some("app"), DatabaseType::Postgres, None));
    assert!(matches!(futures::poll!(next.as_mut()), std::task::Poll::Ready(Ok(_))));
}

#[tokio::test]
async fn existing_pool_releases_permits_on_success_error_and_cancellation_without_retry() {
    let (_dir, state) = state(DatabaseType::Postgres).await;
    let mut held = Vec::new();
    for _ in 0..5 {
        held.push(state.acquire_metadata_permit("conn", Some("app"), DatabaseType::Postgres, None).await.unwrap());
    }
    for result in [Ok(()), Err("Pool not found"), Err("connection reset by peer"), Err("Query canceled")] {
        let mut attempts = 0;
        let actual = run_metadata_connection_for_session(&state, "conn", Some("app"), None, false, || {
            attempts += 1;
            async { result.map_err(str::to_string) }
        })
        .await;
        assert_eq!(actual, result.map_err(str::to_string));
        assert_eq!(attempts, 1);
    }
    let mut running = Box::pin(run_metadata_connection_for_session(&state, "conn", Some("app"), None, false, || {
        std::future::pending::<Result<(), String>>()
    }));
    assert!(futures::poll!(running.as_mut()).is_pending());
    let queued_calls = AtomicUsize::new(0);
    let mut queued = Box::pin(run_metadata_connection_for_session(&state, "conn", Some("app"), None, false, || {
        queued_calls.fetch_add(1, Ordering::SeqCst);
        async { Ok(()) }
    }));
    assert!(futures::poll!(queued.as_mut()).is_pending());
    drop(queued);
    drop(running);
    assert_eq!(queued_calls.load(Ordering::SeqCst), 0);
    let mut next = Box::pin(state.acquire_metadata_permit("conn", Some("app"), DatabaseType::Postgres, None));
    assert!(matches!(futures::poll!(next.as_mut()), std::task::Poll::Ready(Ok(_))));
}

#[tokio::test]
async fn invalid_scope_and_removed_pool_do_not_create_or_reconnect() {
    let (_dir, state) = state(DatabaseType::Postgres).await;
    let mut invalid = context();
    invalid.table = " ".to_string();
    assert_eq!(get_table_metadata(&state, invalid).await.unwrap_err(), "table must not be empty");
    let mut unknown = context();
    unknown.connection_id = "unknown".to_string();
    assert_eq!(get_table_metadata(&state, unknown).await.unwrap_err(), "Connection config not found");
    state
        .update_connection_pools(|pools| {
            pools.insert("conn:other".to_string(), PoolKind::agent(AgentDriverClient::test_stub()));
        })
        .await;
    assert_eq!(get_table_metadata(&state, context()).await.unwrap_err(), TABLE_METADATA_SESSION_NOT_OPEN_ERROR);
    state
        .update_connection_pools(|pools| {
            pools.remove("conn:other");
            pools.insert("conn:app".to_string(), PoolKind::agent(AgentDriverClient::test_stub()));
        })
        .await;
    let key = state.existing_metadata_pool_key_for_session("conn", Some("app"), None).await.unwrap();
    state.update_connection_pools(|pools| pools.remove(&key)).await;
    assert_eq!(
        get_columns_core_for_existing_pool(&state, "conn", "app", "public", "users", &key).await.unwrap_err(),
        "Pool not found"
    );
    assert!(state.with_connection_pools(|pools| pools.is_empty()).await);
}
