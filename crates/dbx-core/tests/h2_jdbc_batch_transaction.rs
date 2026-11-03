use dbx_core::connection::{AppState, PoolKind};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::plugins::{PluginDriverSession, PluginRegistry};
use dbx_core::query::{do_execute, execute_statements_in_transaction, QueryExecutionOptions};
use std::sync::Arc;
use std::time::Duration;

async fn fixture() -> (Arc<AppState>, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let directory = std::env::temp_dir().join(format!("dbx-h2-jdbc-batch-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let plugins = directory.join("plugins");
    let plugin = plugins.join("jdbc");
    std::fs::create_dir_all(&plugin).unwrap();
    let script = plugin.join("driver.py");
    std::fs::write(
        &script,
        r#"#!/usr/bin/python3
import json, os, sys
sessions = {}
active_tx = set()
committed_batches = []
rolled_back_batches = []
batch_statements = {}
executed_queries = []
with open(os.path.join(os.path.dirname(__file__), 'pids'), 'a') as pids:
    pids.write(str(os.getpid()) + '\n')
for line in sys.stdin:
    request = json.loads(line)
    method, params = request['method'], request.get('params', {})
    session = params.get('jdbcSessionId', 'legacy')
    result = {'pid': os.getpid(), 'session': session}
    response = {'id': request['id']}
    if method == 'jdbcSessionProtocol':
        result = {'version': 2}
    elif method == 'openJdbcSession':
        sessions[session] = None
    elif method == 'connect':
        sessions[session] = params['connection'].get('connection_string')
    elif method == 'closeJdbcSession':
        active_tx.discard(session)
        sessions.pop(session, None)
    elif method == 'beginManualTransaction':
        if session in active_tx:
            response['error'] = {'message': 'A manual transaction is already active'}
        else:
            active_tx.add(session)
            batch_statements[session] = []
            result = {'ok': True}
    elif method == 'executeInManualTransaction':
        if session not in active_tx:
            response['error'] = {'message': 'No manual transaction active'}
        else:
            sql = params.get('sql', '')
            batch_statements.setdefault(session, []).append(sql)
            if 'sleep' in sql:
                import time
                time.sleep(1.0)
            if 'fail_statement' in sql:
                response['error'] = {'message': 'table not found'}
            else:
                result = {
                    'columns': ['affected'],
                    'column_types': ['INT'],
                    'column_sortables': [True],
                    'rows': [[1]],
                    'affected_rows': 1,
                    'execution_time_ms': 1,
                    'truncated': False,
                    'session_id': None,
                    'has_more': False
                }
    elif method == 'commitManualTransaction':
        if session not in active_tx:
            response['error'] = {'message': 'No manual transaction active to commit'}
        else:
            active_tx.remove(session)
            committed_batches.append({'session': session, 'statements': list(batch_statements.get(session, []))})
            result = {'ok': True}
    elif method == 'rollbackManualTransaction':
        conn = params.get('connection', {})
        if conn and conn.get('username') == 'fail_rollback':
            response['error'] = {'message': 'connection reset during rollback'}
        else:
            if session in active_tx:
                active_tx.remove(session)
                rolled_back_batches.append({'session': session, 'statements': list(batch_statements.get(session, []))})
            result = {'ok': True}
    elif method in ('executeQuery', 'executeQueryPage'):
        sql = params.get('sql', '')
        in_tx = session in active_tx
        executed_queries.append({'session': session, 'sql': sql, 'in_tx': in_tx})
        result = {
            'columns': ['in_tx'],
            'column_types': ['BOOL'],
            'column_sortables': [True],
            'rows': [[in_tx]],
            'affected_rows': 0,
            'execution_time_ms': 1,
            'truncated': False,
            'session_id': None,
            'has_more': False
        }
    elif method == 'txStats':
        result = {
            'active_tx': list(active_tx),
            'committed': committed_batches,
            'rolled_back': rolled_back_batches,
            'queries': executed_queries,
            'sessions': list(sessions.keys()),
        }
    elif method == 'identity':
        result = {'pid': os.getpid(), 'session': session, 'session_count': len(sessions)}
    elif method == 'exit':
        sys.exit(0)
    else:
        result['url'] = sessions.get(session)
        result['session_count'] = len(sessions)
    response.setdefault('result', result)
    print(json.dumps(response), flush=True)
"#,
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(
        plugin.join("manifest.json"),
        serde_json::json!({
            "id": "jdbc", "name": "JDBC", "version": "0.1.41", "protocol_version": 1,
            "executable": "driver.py", "drivers": [{"id": "jdbc", "label": "JDBC", "kind": "external", "database_type": "jdbc"}]
        })
        .to_string(),
    )
    .unwrap();

    let storage = dbx_core::persistence::test_storage::open(&directory.join("storage.db")).await.unwrap();
    let mut state = AppState::new(storage);
    state.plugins = PluginRegistry::new_with_app_version(plugins, "0.6.30");

    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "conn",
        "name": "H2 Sample",
        "db_type": DatabaseType::Jdbc,
        "host": "localhost",
        "port": 0,
        "username": "sa",
        "password": "",
        "database": "sample",
        "connection_string": "jdbc:h2:file:./sample;LOCK_TIMEOUT=2000",
        "jdbc_driver_class": "org.h2.Driver",
        "connect_timeout_secs": 5,
        "query_timeout_secs": 10,
    }))
    .unwrap();
    state.configs.write().await.insert(config.id.clone(), config);

    (Arc::new(state), directory)
}

async fn get_session(state: &AppState, key: &str) -> Arc<PluginDriverSession> {
    match state.pool_handle(key).await.unwrap() {
        PoolKind::ExternalDriver { session, .. } => session,
        _ => panic!("expected external JDBC driver"),
    }
}

#[tokio::test]
async fn embedded_h2_jdbc_concurrent_batch_transactions_are_isolated() {
    let (state, directory) = fixture().await;
    let statements_a = vec!["DELETE FROM users WHERE id = 1".to_string(), "DELETE FROM users WHERE id = 2".to_string()];
    let statements_b =
        vec!["DELETE FROM orders WHERE id = 10".to_string(), "DELETE FROM orders WHERE id = 20".to_string()];

    let (res_a, res_b) = tokio::join!(
        execute_statements_in_transaction(&state, "conn", "sample", &statements_a, None, None),
        execute_statements_in_transaction(&state, "conn", "sample", &statements_b, None, None),
    );

    assert!(res_a.is_ok(), "batch A failed: {:?}", res_a.err());
    assert!(res_b.is_ok(), "batch B failed: {:?}", res_b.err());

    let shared_pool_key = state.get_or_create_pool("conn", Some("sample")).await.unwrap();
    let shared_session = get_session(&state, &shared_pool_key).await;
    let stats = shared_session.invoke::<serde_json::Value>("txStats", serde_json::json!({})).await.unwrap();

    let committed = stats["committed"].as_array().unwrap();
    assert_eq!(committed.len(), 2, "both batches should have committed");
    let session_a = committed[0]["session"].as_str().unwrap();
    let session_b = committed[1]["session"].as_str().unwrap();
    assert_ne!(session_a, session_b, "batches must execute in separate client sessions");

    assert!(stats["active_tx"].as_array().unwrap().is_empty(), "no dangling active transactions");

    state.shutdown(Duration::from_secs(5)).await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn embedded_h2_jdbc_concurrent_batch_and_ordinary_query_do_not_interleave() {
    let (state, directory) = fixture().await;
    let statements = vec!["DELETE FROM logs WHERE id = 1".to_string(), "DELETE FROM logs WHERE id = 2".to_string()];

    let shared_pool_key = state.get_or_create_pool("conn", Some("sample")).await.unwrap();

    let (batch_res, query_res) = tokio::join!(
        execute_statements_in_transaction(&state, "conn", "sample", &statements, None, None),
        do_execute(
            &state,
            &shared_pool_key,
            dbx_core::db::mysql::MySqlQueryDialect::default(),
            Some("sample"),
            "SELECT 1",
            None,
            None,
            QueryExecutionOptions::default(),
        ),
    );

    assert!(batch_res.is_ok(), "batch transaction failed: {:?}", batch_res.err());
    assert!(query_res.is_ok(), "ordinary query failed: {:?}", query_res.err());

    let shared_session = get_session(&state, &shared_pool_key).await;
    let stats = shared_session.invoke::<serde_json::Value>("txStats", serde_json::json!({})).await.unwrap();

    let queries = stats["queries"].as_array().unwrap();
    assert!(!queries.is_empty(), "ordinary query must have executed");
    for q in queries {
        assert_eq!(q["in_tx"].as_bool(), Some(false), "ordinary query must not run inside a batch transaction");
    }

    let committed = stats["committed"].as_array().unwrap();
    assert_eq!(committed.len(), 1, "batch should have committed");
    let batch_session = committed[0]["session"].as_str().unwrap();
    let shared_identity = shared_session.invoke::<serde_json::Value>("identity", serde_json::json!({})).await.unwrap();
    assert_ne!(
        batch_session,
        shared_identity["session"].as_str().unwrap(),
        "batch must use a dedicated session, not the shared connection session"
    );

    state.shutdown(Duration::from_secs(5)).await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn embedded_h2_jdbc_batch_transaction_cancels_and_reclaims_session() {
    let (state, directory) = fixture().await;
    let statements = vec!["SELECT 1".to_string(), "SELECT sleep(1)".to_string()];

    let shared_pool_key = state.get_or_create_pool("conn", Some("sample")).await.unwrap();

    let res = tokio::time::timeout(
        Duration::from_millis(50),
        execute_statements_in_transaction(&state, "conn", "sample", &statements, None, None),
    )
    .await;

    assert!(res.is_err(), "batch should have timed out / been cancelled");

    let shared_session = get_session(&state, &shared_pool_key).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let stats = shared_session.invoke::<serde_json::Value>("txStats", serde_json::json!({})).await.unwrap();
            let active = stats["active_tx"].as_array().unwrap();
            if active.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("cleanup guard must reclaim active transaction session upon cancellation");

    state.shutdown(Duration::from_secs(5)).await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn embedded_h2_jdbc_batch_transaction_reports_rollback_failure_accurately() {
    let (state, directory) = fixture().await;
    let mut config = state.configs.read().await["conn"].clone();
    config.id = "conn-rb-fail".to_string();
    config.username = "fail_rollback".to_string();
    state.configs.write().await.insert(config.id.clone(), config);

    let statements = vec!["DELETE FROM users WHERE id = 1".to_string(), "DELETE fail_statement FROM users".to_string()];

    let err =
        execute_statements_in_transaction(&state, "conn-rb-fail", "sample", &statements, None, None).await.unwrap_err();

    assert!(err.contains("table not found"), "expected statement error: {err}");
    assert!(
        err.contains("Transaction rollback failed: connection reset during rollback"),
        "expected accurate rollback failure notice: {err}"
    );
    assert!(
        !err.contains("The transaction was rolled back"),
        "must not claim transaction was rolled back when rollback failed: {err}"
    );

    state.shutdown(Duration::from_secs(5)).await;
    let _ = std::fs::remove_dir_all(directory);
}
