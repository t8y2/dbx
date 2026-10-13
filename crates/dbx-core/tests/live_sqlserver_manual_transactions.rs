//! Run against each SQL Server version/driver profile; ignored without an explicit writable test endpoint.
use dbx_core::connection::AppState;
#[path = "support/sqlserver_live_observer.rs"]
mod sqlserver;
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::query::{
    begin_manual_transaction, commit_manual_transaction, execute_in_manual_transaction,
    execute_in_manual_transaction_with_options, rollback_manual_transaction, ManualTransactionExecutionOptions,
};
use std::time::Duration;
#[path = "support/sqlserver_fault_proxy.rs"]
mod fault_proxy;
use dbx_core::query::sqlserver_manual_transaction::live_test_hooks::{self, Phase};
use fault_proxy::FaultProxy;
use std::sync::atomic::Ordering;

async fn setup() -> (AppState, ConnectionConfig, sqlserver::SqlServerClient, tempfile::TempDir) {
    let host = std::env::var("DBX_TEST_SQLSERVER_HOST").expect("DBX_TEST_SQLSERVER_HOST");
    let password = std::env::var("DBX_TEST_SQLSERVER_PASSWORD").expect("DBX_TEST_SQLSERVER_PASSWORD");
    let user = std::env::var("DBX_TEST_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_owned());
    let database = std::env::var("DBX_TEST_SQLSERVER_DATABASE").expect("Use a writable, isolated test database");
    let port: u16 = std::env::var("DBX_TEST_SQLSERVER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(1433);
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id":"live-sqlserver-manual", "name":"live SQL Server manual transactions", "db_type":"sqlserver",
        "host":host, "port":port, "username":user, "password":password, "database":database,
        "driver_profile":std::env::var("DBX_TEST_SQLSERVER_DRIVER_PROFILE").ok(),
        "jdbc_driver_class":std::env::var("DBX_TEST_SQLSERVER_JDBC_CLASS").ok(),
        "connection_string":std::env::var("DBX_TEST_SQLSERVER_JDBC_URL").ok(),
        "connect_timeout_secs":10, "query_timeout_secs":30, "keepalive_interval_secs":0
    }))
    .unwrap();
    let observer = sqlserver::connect_with_port_explicit(
        &host,
        port,
        true,
        &user,
        &password,
        Some(&database),
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.path().join("state.db")).await.unwrap();
    let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        dir.path().join("agents"),
        "0.6.31",
    );
    if config.driver_profile.as_deref() == Some("sqlserver-legacy") {
        let jar = std::env::var("DBX_TEST_SQLSERVER_AGENT_JAR").expect("built SQL Server Agent JAR");
        let java = std::env::var("DBX_TEST_SQLSERVER_JAVA").expect("Java 21 executable");
        dbx_core::agent_service::import_agent_jar(&state.agent_manager, "sqlserver-legacy", std::path::Path::new(&jar))
            .await
            .unwrap();
        state
            .agent_manager
            .mutate_state(|agent| {
                agent.java_runtime = dbx_core::agent_manager::JavaRuntimeConfig {
                    mode: dbx_core::agent_manager::JavaRuntimeMode::Custom,
                    custom_java_path: Some(java),
                };
            })
            .unwrap();
    }
    state.configs.write().await.insert(config.id.clone(), config.clone());
    (state, config, observer, dir)
}

async fn assert_driver(state: &AppState, id: &str) {
    let sessions = state.transaction_sessions.read().await;
    let driver = &sessions[id].sqlserver.as_ref().unwrap().driver;
    println!("Actual driver: {} {:?}; server {:?}", driver.driver_name, driver.driver_version, driver.server_version);
    if sqlserver::sql_server_2000() {
        let major = driver.server_version.as_deref().unwrap().split('.').next().unwrap().parse::<u32>().unwrap();
        assert_eq!(major, 8, "SQL Server 2000 compatibility tests require the actual 8.x engine");
    }
    let conn = sessions[id].connection.lock().await;
    if let dbx_core::connection::TxnConnection::Agent { client, .. } = &*conn {
        println!("Actual Agent runtime: {}", if client.uses_shared_runtime() { "shared" } else { "dedicated process" });
    }
    drop(conn);
    let expected = std::env::var("DBX_TEST_SQLSERVER_EXPECT_DRIVER")
        .expect("DBX_TEST_SQLSERVER_EXPECT_DRIVER must identify the actual driver under test");
    assert!(!expected.trim().is_empty(), "expected driver cannot be empty");
    assert!(
        driver.driver_name.to_lowercase().contains(&expected.to_lowercase()),
        "unexpected actual driver: {}",
        driver.driver_name
    );
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_* writable endpoint; repeat with native and sqlserver-legacy profiles"]
async fn live_manual_transaction_fixed_connections_batches_commit_and_rollback() {
    let (state, config, mut observer, _dir) = setup().await;
    let database = config.database.as_deref().unwrap();
    let table = format!("dbo.dbx_manual_{}", uuid::Uuid::new_v4().simple());
    sqlserver::execute_simple_batch_with_max_rows(
        &mut observer,
        &format!("CREATE TABLE {table} (id int PRIMARY KEY, value int)"),
        None,
    )
    .await
    .unwrap();
    let first = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
    assert_driver(&state, &first).await;
    let second = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
    let first_spid =
        execute_in_manual_transaction(&state, &first, "SELECT @@SPID AS spid", database, None, Some(10)).await.unwrap();
    let second_spid = execute_in_manual_transaction(&state, &second, "SELECT @@SPID AS spid", database, None, Some(10))
        .await
        .unwrap();
    assert_ne!(first_spid[0].rows, second_spid[0].rows);
    execute_in_manual_transaction(
        &state,
        &first,
        &format!("INSERT INTO {table} VALUES (1, 10)"),
        database,
        None,
        Some(10),
    )
    .await
    .unwrap();
    // A separate READ COMMITTED observer may block on uncommitted writes. Bound
    // the lock wait and assert that it cannot silently observe a committed row.
    let lock_hint = if sqlserver::sql_server_2000() { "" } else { " WITH (READCOMMITTEDLOCK)" };
    let blocked = sqlserver::execute_simple_batch_with_max_rows(&mut observer,
        &format!("SET LOCK_TIMEOUT 500; SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SELECT value FROM {table}{lock_hint} WHERE id = 1"), Some(10)).await;
    let lock_error = blocked.expect_err("uncommitted row should remain locked");
    assert!(
        lock_error.to_lowercase().contains("lock request time out")
            || lock_error.to_lowercase().contains("lock request timeout"),
        "expected SQL Server lock timeout, got: {lock_error}"
    );
    commit_manual_transaction(&state, &first).await.unwrap();
    let visible =
        sqlserver::execute_query(&mut observer, &format!("SELECT value FROM {table} WHERE id = 1")).await.unwrap();
    assert_eq!(visible.rows[0][0], serde_json::json!(10));
    execute_in_manual_transaction(
        &state,
        &second,
        &format!("UPDATE {table} SET value = 20 WHERE id = 1"),
        database,
        None,
        Some(10),
    )
    .await
    .unwrap();
    rollback_manual_transaction(&state, &second).await.unwrap();
    let visible =
        sqlserver::execute_query(&mut observer, &format!("SELECT value FROM {table} WHERE id = 1")).await.unwrap();
    assert_eq!(visible.rows[0][0], serde_json::json!(10));
    let batch = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
    execute_in_manual_transaction(
        &state,
        &batch,
        if sqlserver::sql_server_2000() {
            "CREATE TABLE #dbx_manual (id int); INSERT INTO #dbx_manual VALUES (1); INSERT INTO #dbx_manual VALUES (2); INSERT INTO #dbx_manual VALUES (3)"
        } else {
            "CREATE TABLE #dbx_manual (id int); INSERT INTO #dbx_manual VALUES (1), (2), (3)"
        },
        database,
        None,
        Some(10),
    )
    .await
    .unwrap();
    let results = execute_in_manual_transaction(&state, &batch,
        if sqlserver::sql_server_2000() {
            "DECLARE @v int; SET @v = 4; SELECT @v AS variable;\nGO\nSELECT id FROM #dbx_manual ORDER BY id; PRINT 'SQL2000 manual batch'; SELECT 99 AS last_result"
        } else {
            "DECLARE @v int = 4; SELECT @v AS variable;\nGO\nBEGIN TRY SELECT id FROM #dbx_manual ORDER BY id; END TRY BEGIN CATCH SELECT ERROR_MESSAGE(); END CATCH; SELECT 99 AS last_result"
        }, database, None, Some(1)).await.unwrap();
    assert!(results.iter().any(|r| r.columns == vec!["variable"]));
    assert!(results.iter().any(|r| r.truncated));
    assert!(results.iter().any(|r| r.columns == vec!["last_result"]));
    let spid_again =
        execute_in_manual_transaction(&state, &batch, "SELECT @@SPID AS spid", database, None, Some(10)).await.unwrap();
    let spid_last =
        execute_in_manual_transaction(&state, &batch, "SELECT @@SPID AS spid", database, None, Some(10)).await.unwrap();
    assert_eq!(spid_again[0].rows, spid_last[0].rows);
    rollback_manual_transaction(&state, &batch).await.unwrap();
    sqlserver::execute_simple_batch_with_max_rows(&mut observer, &format!("DROP TABLE {table}"), None).await.unwrap();
    assert!(state.transaction_sessions.read().await.is_empty());
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_* writable endpoint"]
async fn live_manual_transaction_timeout_invalidates_session_without_replay() {
    let (state, config, mut observer, _dir) = setup().await;
    let database = config.database.as_deref().unwrap();
    let session = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
    assert_driver(&state, &session).await;
    let spid = execute_in_manual_transaction(&state, &session, "SELECT @@SPID", database, None, Some(1)).await.unwrap()
        [0]
    .rows[0][0]
        .as_i64()
        .unwrap();
    let identity = sqlserver::log_old_session(&mut observer, spid, "before timeout").await;
    let error = execute_in_manual_transaction_with_options(
        &state,
        &session,
        "WAITFOR DELAY '00:00:10'; SELECT 1",
        database,
        None,
        ManualTransactionExecutionOptions {
            timeout_secs: Some(1),
            execution_id: Some("live-sqlserver-timeout".to_owned()),
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    let error = dbx_core::query::sqlserver_manual_transaction::backend_error(&error).unwrap();
    assert_eq!(serde_json::to_value(error).unwrap()["transactionOutcome"], "unknown");
    assert!(!state.transaction_sessions.read().await.contains_key(&session));
    assert!(execute_in_manual_transaction(&state, &session, "SELECT 2", database, None, Some(10)).await.is_err());
    sqlserver::wait_for_session_release(&mut observer, spid, identity.as_deref()).await;
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_* writable endpoint"]
async fn live_manual_transaction_failures_and_idle_expiry_acknowledge_rollback() {
    let (state, config, _observer, _dir) = setup().await;
    let database = config.database.as_deref().unwrap();
    for idle in [false, true] {
        let session = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
        assert_driver(&state, &session).await;
        execute_in_manual_transaction(
            &state,
            &session,
            "CREATE TABLE #pending (id int); INSERT INTO #pending VALUES (1)",
            database,
            None,
            Some(10),
        )
        .await
        .unwrap();
        if idle {
            state.transaction_sessions.write().await.get_mut(&session).unwrap().last_activity =
                std::time::Instant::now() - Duration::from_secs(301);
        }
        let error = execute_in_manual_transaction(
            &state,
            &session,
            if idle { "SELECT 2" } else { "SELECT * FROM dbx_missing_table_7542" },
            database,
            None,
            Some(10),
        )
        .await
        .unwrap_err();
        let error = dbx_core::query::sqlserver_manual_transaction::backend_error(&error).unwrap();
        assert_eq!(serde_json::to_value(error).unwrap()["transactionOutcome"], "rolled_back");
        assert!(!state.transaction_sessions.read().await.contains_key(&session));
        assert!(execute_in_manual_transaction(&state, &session, "SELECT 3", database, None, Some(10)).await.is_err());
    }
    state.agent_manager.stop_daemons().await;
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_* writable endpoint"]
async fn live_manual_transaction_killed_connection_has_unknown_outcome_without_replay() {
    let (state, config, mut observer, _dir) = setup().await;
    let database = config.database.as_deref().unwrap();
    let session = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
    assert_driver(&state, &session).await;
    let spid = execute_in_manual_transaction(&state, &session, "SELECT @@SPID", database, None, Some(1)).await.unwrap()
        [0]
    .rows[0][0]
        .as_i64()
        .unwrap();
    sqlserver::execute_simple_batch_with_max_rows(&mut observer, &format!("KILL {spid}"), None).await.unwrap();
    let error =
        execute_in_manual_transaction(&state, &session, "SELECT 1", database, None, Some(10)).await.unwrap_err();
    let error = dbx_core::query::sqlserver_manual_transaction::backend_error(&error).unwrap();
    assert_eq!(serde_json::to_value(error).unwrap()["transactionOutcome"], "unknown");
    assert!(!state.transaction_sessions.read().await.contains_key(&session));
    assert!(execute_in_manual_transaction(&state, &session, "SELECT 2", database, None, Some(10)).await.is_err());
    state.agent_manager.stop_daemons().await;
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_* writable endpoint"]
async fn live_manual_transaction_cancel_confirms_terminal_and_rejects_busy_end() {
    let (state, config, mut observer, _dir) = setup().await;
    let state = std::sync::Arc::new(state);
    let database = config.database.as_deref().unwrap();
    let session = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
    assert_driver(&state, &session).await;
    let spid = execute_in_manual_transaction(&state, &session, "SELECT @@SPID", database, None, Some(1)).await.unwrap()
        [0]
    .rows[0][0]
        .as_i64()
        .unwrap();
    let identity = sqlserver::log_old_session(&mut observer, spid, "before execution").await;
    let execution = {
        let state = state.clone();
        let session = session.clone();
        let database = database.to_owned();
        tokio::spawn(async move {
            execute_in_manual_transaction_with_options(
                &state,
                &session,
                "WAITFOR DELAY '00:00:20'; SELECT 1",
                &database,
                None,
                ManualTransactionExecutionOptions {
                    timeout_secs: Some(30),
                    execution_id: Some("live-sqlserver-cancel".to_owned()),
                    ..Default::default()
                },
            )
            .await
        })
    };
    // Confirm the actual WAITFOR reached SQL Server before sending cancellation.
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let requests = sqlserver::execute_query(&mut observer, &sqlserver::wait_query(spid)).await.unwrap();
            if requests.rows[0][0] == serde_json::json!(1) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("long query never reached SQL Server");
    assert!(state.running_queries.diagnostics().active_execution_ids.contains(&"live-sqlserver-cancel".to_owned()));
    assert!(commit_manual_transaction(&state, &session).await.unwrap_err().contains("busy"));
    assert!(rollback_manual_transaction(&state, &session).await.unwrap_err().contains("busy"));
    let cancelled = state.running_queries.cancel_and_wait("live-sqlserver-cancel", Duration::from_secs(8)).await;
    assert!(cancelled.requested && cancelled.terminal, "cancellation did not confirm terminal state");
    let error = execution.await.unwrap().unwrap_err();
    let error = dbx_core::query::sqlserver_manual_transaction::backend_error(&error).unwrap();
    assert_eq!(serde_json::to_value(error).unwrap()["transactionOutcome"], "unknown");
    assert!(!state.transaction_sessions.read().await.contains_key(&session));
    assert!(!state.running_queries.diagnostics().active_execution_ids.contains(&"live-sqlserver-cancel".to_owned()));
    assert!(execute_in_manual_transaction(&state, &session, "SELECT 2", database, None, Some(10)).await.is_err());
    sqlserver::wait_for_session_release(&mut observer, spid, identity.as_deref()).await;
    state.agent_manager.stop_daemons().await;
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_* writable endpoint"]
async fn live_manual_transaction_control_conflicts_and_hidden_commit_end_session() {
    let (state, config, mut observer, _dir) = setup().await;
    let database = config.database.as_deref().unwrap();
    let procedure = format!("dbo.dbx_manual_proc_{}", uuid::Uuid::new_v4().simple());
    sqlserver::execute_simple_batch_with_max_rows(
        &mut observer,
        &format!("CREATE PROCEDURE {procedure} AS BEGIN COMMIT TRANSACTION; SELECT @@TRANCOUNT END"),
        None,
    )
    .await
    .unwrap();
    let session = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
    assert_driver(&state, &session).await;
    for sql in ["COMMIT TRANSACTION", "BEGIN TRANSACTION", "USE master", "SET IMPLICIT_TRANSACTIONS ON"] {
        let error = execute_in_manual_transaction(&state, &session, sql, database, None, Some(10)).await.unwrap_err();
        assert!(error.contains("control_conflict"), "wrong conflict error: {error}");
        assert!(state.transaction_sessions.read().await.contains_key(&session));
    }
    let count =
        execute_in_manual_transaction(&state, &session, "SELECT @@TRANCOUNT", database, None, Some(1)).await.unwrap();
    assert_eq!(count[0].rows[0][0], serde_json::json!(1));
    let error = execute_in_manual_transaction(&state, &session, &format!("EXEC {procedure}"), database, None, Some(10))
        .await
        .unwrap_err();
    let error = dbx_core::query::sqlserver_manual_transaction::backend_error(&error).unwrap();
    assert_eq!(serde_json::to_value(error).unwrap()["transactionOutcome"], "unknown");
    assert!(!state.transaction_sessions.read().await.contains_key(&session));
    assert!(execute_in_manual_transaction(&state, &session, "SELECT 2", database, None, Some(10)).await.is_err());
    sqlserver::execute_simple_batch_with_max_rows(&mut observer, &format!("DROP PROCEDURE {procedure}"), None)
        .await
        .unwrap();
    state.agent_manager.stop_daemons().await;
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_* writable endpoint"]
async fn live_manual_transaction_active_disconnect_cancels_and_releases_session() {
    let (state, config, mut observer, _dir) = setup().await;
    let state = std::sync::Arc::new(state);
    let database = config.database.as_deref().unwrap();
    let session = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
    assert_driver(&state, &session).await;
    let spid = execute_in_manual_transaction(&state, &session, "SELECT @@SPID", database, None, Some(1)).await.unwrap()
        [0]
    .rows[0][0]
        .as_i64()
        .unwrap();
    let identity = sqlserver::log_old_session(&mut observer, spid, "before execution").await;
    let execution = {
        let state = state.clone();
        let session = session.clone();
        let database = database.to_owned();
        tokio::spawn(async move {
            execute_in_manual_transaction_with_options(
                &state,
                &session,
                "WAITFOR DELAY '00:00:20'; SELECT 1",
                &database,
                None,
                ManualTransactionExecutionOptions {
                    timeout_secs: Some(30),
                    execution_id: Some("live-sqlserver-disconnect".to_owned()),
                    ..Default::default()
                },
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let requests = sqlserver::execute_query(&mut observer, &sqlserver::wait_query(spid)).await.unwrap();
            if requests.rows[0][0] == serde_json::json!(1) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("long query never reached SQL Server");
    tokio::time::timeout(Duration::from_secs(10), state.remove_connection_pools(&config.id))
        .await
        .expect("disconnect cleanup did not finish");
    let error = execution.await.unwrap().unwrap_err();
    let error = dbx_core::query::sqlserver_manual_transaction::backend_error(&error).unwrap();
    assert_eq!(serde_json::to_value(error).unwrap()["transactionOutcome"], "unknown");
    assert!(state.transaction_sessions.read().await.is_empty());
    assert!(state.running_queries.diagnostics().active_execution_ids.is_empty());
    assert!(execute_in_manual_transaction(&state, &session, "SELECT 2", database, None, Some(10)).await.is_err());
    sqlserver::wait_for_session_release(&mut observer, spid, identity.as_deref()).await;
    state.agent_manager.stop_daemons().await;
}

async fn fault_setup(
    mode: &str,
) -> (AppState, ConnectionConfig, sqlserver::SqlServerClient, tempfile::TempDir, FaultProxy) {
    let (state, mut config, observer, dir) = setup().await;
    let proxy = FaultProxy::start(&config.host, config.port).await;
    config.port = proxy.port;
    config.host = "127.0.0.1".to_owned();
    if config.driver_profile.as_deref() == Some("sqlserver-legacy") {
        let delegate = config.jdbc_driver_class.clone().expect("explicit actual JDBC delegate");
        let original = config.connection_string.as_ref().unwrap();
        let authority = original.find("://").expect("SQL Server JDBC URL authority") + 3;
        let suffix = original[authority..].find([';', '/']).map(|offset| authority + offset).unwrap_or(original.len());
        let url = format!("{}127.0.0.1:{}{}", &original[..authority], proxy.port, &original[suffix..]);
        config.connection_string = Some(format!(
            "jdbc:dbx-fault:{url};dbxFaultDriver={delegate};dbxFaultControlPort={};dbxFaultMode={mode}",
            proxy.control_port
        ));
        config.jdbc_driver_class = Some("com.dbx.agent.testing.SqlServerFaultDriver".to_owned());
        config.jdbc_driver_paths =
            vec![std::env::var("DBX_TEST_SQLSERVER_FAULT_DRIVER_JAR").expect("built test-support.jar")];
    }
    state.configs.write().await.insert(config.id.clone(), config.clone());
    (state, config, observer, dir, proxy)
}

async fn response_loss(commit: bool) {
    let mode = if commit { "commit_response_loss" } else { "rollback_response_loss" };
    let (state, config, mut observer, _dir, proxy) = fault_setup(mode).await;
    let database = config.database.as_deref().unwrap();
    let table = format!("dbo.dbx_manual_fault_{}", uuid::Uuid::new_v4().simple());
    sqlserver::execute_simple_batch_with_max_rows(
        &mut observer,
        &format!("CREATE TABLE {table} (id int PRIMARY KEY)"),
        None,
    )
    .await
    .unwrap();
    let session = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
    assert_driver(&state, &session).await;
    execute_in_manual_transaction(
        &state,
        &session,
        &format!("INSERT INTO {table} VALUES (1)"),
        database,
        None,
        Some(1),
    )
    .await
    .unwrap();
    // TLS negotiation can open several sockets before the dedicated workload
    // connection exists (SQL2000 rejects TLS before accepting plain TDS).
    // Only a connection opened after this point would be a forbidden reconnect.
    let established_connections = proxy.stats.connections.load(Ordering::SeqCst);
    let _hook = if config.driver_profile.is_none() {
        let hook_id = if commit {
            session.clone()
        } else {
            let sessions = state.transaction_sessions.read().await;
            let connection = sessions[&session].connection.lock().await;
            match &*connection {
                dbx_core::connection::TxnConnection::SqlServer { client_session_id, .. } => client_session_id.clone(),
                _ => panic!("expected fixed native connection"),
            }
        };
        let stats = proxy.stats.clone();
        Some(live_test_hooks::install(
            &hook_id,
            if commit { Phase::BeforeCommit } else { Phase::BeforeRollback },
            move || stats.armed.store(true, Ordering::SeqCst),
        ))
    } else {
        None
    };
    let error = if commit {
        commit_manual_transaction(&state, &session).await
    } else {
        rollback_manual_transaction(&state, &session).await
    }
    .unwrap_err();
    let parsed = dbx_core::query::sqlserver_manual_transaction::backend_error(&error).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap()["transactionOutcome"], "unknown");
    assert_eq!(proxy.stats.dropped_responses.load(Ordering::SeqCst), 1, "no actual server response was discarded");
    assert!(proxy.stats.request_bytes_after_arm.load(Ordering::SeqCst) > 0, "end request was not forwarded");
    assert!(!state.transaction_sessions.read().await.contains_key(&session));
    // The independent observer proves which operation really reached SQL Server.
    let visible =
        sqlserver::execute_query(&mut observer, &format!("SET LOCK_TIMEOUT 5000; SELECT COUNT(*) FROM {table}"))
            .await
            .unwrap();
    assert_eq!(visible.rows[0][0], serde_json::json!(if commit { 1 } else { 0 }));
    assert!(commit_manual_transaction(&state, &session).await.is_err());
    assert!(rollback_manual_transaction(&state, &session).await.is_err());
    assert!(execute_in_manual_transaction(&state, &session, "SELECT 1", database, None, Some(1)).await.is_err());
    assert_eq!(proxy.stats.connections.load(Ordering::SeqCst), established_connections, "client silently reconnected");
    sqlserver::execute_simple_batch_with_max_rows(&mut observer, &format!("DROP TABLE {table}"), None).await.unwrap();
    state.agent_manager.stop_daemons().await;
    println!(
        "{} response discarded; independently verified final data; outcome unknown; no reconnect/replay",
        if commit { "COMMIT" } else { "ROLLBACK" }
    );
}
#[tokio::test]
#[ignore = "requires writable SQL Server and live fault driver"]
async fn live_manual_transaction_fault_commit_response_lost_after_real_commit() {
    response_loss(true).await;
}
#[tokio::test]
#[ignore = "requires writable SQL Server and live fault driver"]
async fn live_manual_transaction_fault_rollback_response_loss_remains_unknown() {
    response_loss(false).await;
}

#[tokio::test]
#[ignore = "requires writable SQL Server and live fault driver"]
async fn live_manual_transaction_fault_acknowledged_commit_survives_terminal_transport_or_close_fault() {
    let (state, config, mut observer, _dir, proxy) = fault_setup("cleanup_failure").await;
    let database = config.database.as_deref().unwrap();
    let table = format!("dbo.dbx_manual_fault_{}", uuid::Uuid::new_v4().simple());
    sqlserver::execute_simple_batch_with_max_rows(
        &mut observer,
        &format!("CREATE TABLE {table} (id int PRIMARY KEY)"),
        None,
    )
    .await
    .unwrap();
    let session = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
    assert_driver(&state, &session).await;
    execute_in_manual_transaction(
        &state,
        &session,
        &format!("INSERT INTO {table} VALUES (1)"),
        database,
        None,
        Some(1),
    )
    .await
    .unwrap();
    // TLS negotiation can open several sockets before the dedicated workload
    // connection exists (SQL2000 rejects TLS before accepting plain TDS).
    // Only a connection opened after this point would be a forbidden reconnect.
    let established_connections = proxy.stats.connections.load(Ordering::SeqCst);
    let _hook = if config.driver_profile.is_none() {
        let stats = proxy.stats.clone();
        Some(live_test_hooks::install(&session, Phase::AfterCommitAck, move || stats.cut.cancel()))
    } else {
        None
    };
    // Keep the legacy single-process client alive until its asynchronous Java
    // close callback runs. Otherwise process fail-stop can precede fault injection.
    let close_guard = {
        let sessions = state.transaction_sessions.read().await;
        let connection = sessions[&session].connection.lock().await;
        match &*connection {
            dbx_core::connection::TxnConnection::Agent { client, .. } => Some(client.clone()),
            _ => None,
        }
    };
    commit_manual_transaction(&state, &session).await.unwrap();
    assert!(state.connection_pools_snapshot().await.is_empty());
    if config.driver_profile.is_some() {
        tokio::time::timeout(Duration::from_secs(8), async {
            while proxy.stats.close_failures.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("actual JDBC close error was not injected");
        assert_eq!(proxy.stats.close_entered.load(Ordering::SeqCst), 1);
    } else {
        assert!(proxy.stats.cut.is_cancelled());
    }
    drop(close_guard);
    tokio::time::timeout(Duration::from_secs(3), async {
        while proxy.stats.closed_connections.load(Ordering::SeqCst) < established_connections {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("terminal TCP socket handles were not released");
    let error = commit_manual_transaction(&state, &session).await.unwrap_err();
    let parsed = dbx_core::query::sqlserver_manual_transaction::backend_error(&error).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap()["transactionOutcome"], "committed");
    let visible = sqlserver::execute_query(&mut observer, &format!("SELECT COUNT(*) FROM {table}")).await.unwrap();
    assert_eq!(visible.rows[0][0], serde_json::json!(1));
    assert!(state.transaction_sessions.read().await.is_empty());
    assert_eq!(proxy.stats.connections.load(Ordering::SeqCst), established_connections);
    sqlserver::execute_simple_batch_with_max_rows(&mut observer, &format!("DROP TABLE {table}"), None).await.unwrap();
    state.agent_manager.stop_daemons().await;
    println!(
        "Real COMMIT acknowledged; {} did not change committed outcome",
        if config.driver_profile.is_some() { "injected JDBC close error" } else { "confirmed terminal TCP closure" }
    );
}

#[tokio::test]
#[ignore = "requires writable SQL Server and live fault driver"]
async fn live_manual_transaction_fault_network_break_during_execution_discards_session() {
    let (state, config, mut observer, _dir, proxy) = fault_setup("network_break").await;
    let state = std::sync::Arc::new(state);
    let database = config.database.as_deref().unwrap();
    let table = format!("dbo.dbx_manual_fault_{}", uuid::Uuid::new_v4().simple());
    sqlserver::execute_simple_batch_with_max_rows(
        &mut observer,
        &format!("CREATE TABLE {table} (id int PRIMARY KEY)"),
        None,
    )
    .await
    .unwrap();
    let session = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
    assert_driver(&state, &session).await;
    let spid = execute_in_manual_transaction(&state, &session, "SELECT @@SPID", database, None, Some(1)).await.unwrap()
        [0]
    .rows[0][0]
        .as_i64()
        .unwrap();
    execute_in_manual_transaction(
        &state,
        &session,
        &format!("INSERT INTO {table} VALUES (1)"),
        database,
        None,
        Some(1),
    )
    .await
    .unwrap();
    let executing = {
        let state = state.clone();
        let session = session.clone();
        let database = database.to_owned();
        tokio::spawn(async move {
            execute_in_manual_transaction_with_options(
                &state,
                &session,
                "WAITFOR DELAY '00:00:10'; SELECT 1",
                &database,
                None,
                ManualTransactionExecutionOptions {
                    timeout_secs: Some(15),
                    execution_id: Some("live-network-fault".to_owned()),
                    ..Default::default()
                },
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let waiting = sqlserver::execute_query(&mut observer, &sqlserver::wait_query(spid)).await.unwrap();
            if waiting.rows[0][0] == serde_json::json!(1) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let established_connections = proxy.stats.connections.load(Ordering::SeqCst);
    proxy.stats.cut.cancel();
    let error = tokio::time::timeout(Duration::from_secs(20), executing).await.unwrap().unwrap().unwrap_err();
    let parsed = dbx_core::query::sqlserver_manual_transaction::backend_error(&error).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap()["transactionOutcome"], "unknown");
    assert!(state.transaction_sessions.read().await.is_empty());
    assert!(execute_in_manual_transaction(&state, &session, "SELECT 2", database, None, Some(1)).await.is_err());
    let visible =
        sqlserver::execute_query(&mut observer, &format!("SET LOCK_TIMEOUT 15000; SELECT COUNT(*) FROM {table}"))
            .await
            .unwrap();
    assert_eq!(visible.rows[0][0], serde_json::json!(0));
    assert_eq!(
        proxy.stats.connections.load(Ordering::SeqCst),
        established_connections,
        "network failure triggered reconnect"
    );
    assert!(state.running_queries.diagnostics().active_execution_ids.is_empty());
    sqlserver::execute_simple_batch_with_max_rows(&mut observer, &format!("DROP TABLE {table}"), None).await.unwrap();
    state.agent_manager.stop_daemons().await;
    println!("Real TCP connection interrupted during WAITFOR; pending data absent; no reconnect/replay");
}

#[tokio::test]
#[ignore = "requires writable SQL Server; waits for the real five-minute idle watchdog"]
async fn live_manual_transaction_wall_clock_idle_watchdog_rolls_back_without_request() {
    let (state, config, mut observer, _dir) = setup().await;
    let database = config.database.as_deref().unwrap();
    let table = format!("dbo.dbx_manual_idle_{}", uuid::Uuid::new_v4().simple());
    sqlserver::execute_simple_batch_with_max_rows(
        &mut observer,
        &format!("CREATE TABLE {table} (id int PRIMARY KEY)"),
        None,
    )
    .await
    .unwrap();
    let session = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
    assert_driver(&state, &session).await;
    execute_in_manual_transaction(
        &state,
        &session,
        &format!("INSERT INTO {table} VALUES (1)"),
        database,
        None,
        Some(1),
    )
    .await
    .unwrap();
    let started = std::time::Instant::now();
    // Observe the registry only: do not execute another request or alter activity timestamps.
    tokio::time::timeout(Duration::from_secs(330), async {
        loop {
            if !state.transaction_sessions.read().await.contains_key(&session) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    })
    .await
    .expect("real idle watchdog did not remove session within 330 seconds");
    assert!(started.elapsed() >= Duration::from_secs(299), "watchdog expired before configured idle period");
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let error = commit_manual_transaction(&state, &session).await.unwrap_err();
            let parsed = dbx_core::query::sqlserver_manual_transaction::backend_error(&error).unwrap();
            let value = serde_json::to_value(parsed).unwrap();
            if value["transactionOutcome"] == "rolled_back" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("watchdog rollback acknowledgement never arrived");
    let visible =
        sqlserver::execute_query(&mut observer, &format!("SET LOCK_TIMEOUT 3000; SELECT COUNT(*) FROM {table}"))
            .await
            .unwrap();
    assert_eq!(visible.rows[0][0], serde_json::json!(0));
    assert!(state.connection_pools_snapshot().await.is_empty(), "watchdog left a routed dedicated pool");
    assert!(execute_in_manual_transaction(&state, &session, "SELECT 1", database, None, Some(1)).await.is_err());
    sqlserver::execute_simple_batch_with_max_rows(&mut observer, &format!("DROP TABLE {table}"), None).await.unwrap();
    state.agent_manager.stop_daemons().await;
    println!(
        "Real idle duration {:?}; background rollback acknowledged; data absent; no request replay",
        started.elapsed()
    );
}

async fn aborted_request_probe(disconnecting: bool) {
    let (state, config, mut observer, _dir) = setup().await;
    let state = std::sync::Arc::new(state);
    let database = config.database.as_deref().unwrap();
    let table = format!("dbo.dbx_manual_aborted_{}", uuid::Uuid::new_v4().simple());
    sqlserver::execute_simple_batch_with_max_rows(
        &mut observer,
        &format!("CREATE TABLE {table} (id int PRIMARY KEY)"),
        None,
    )
    .await
    .unwrap();
    let session = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
    assert_driver(&state, &session).await;
    let spid = execute_in_manual_transaction(&state, &session, "SELECT @@SPID", database, None, Some(1)).await.unwrap()
        [0]
    .rows[0][0]
        .as_i64()
        .unwrap();
    execute_in_manual_transaction(
        &state,
        &session,
        &format!("INSERT INTO {table} VALUES (1)"),
        database,
        None,
        Some(1),
    )
    .await
    .unwrap();
    let identity = sqlserver::log_old_session(&mut observer, spid, "before request abort").await;
    let execution = {
        let state = state.clone();
        let session = session.clone();
        let database = database.to_owned();
        tokio::spawn(async move {
            execute_in_manual_transaction_with_options(
                &state,
                &session,
                "WAITFOR DELAY '00:00:10'; SELECT 1",
                &database,
                None,
                ManualTransactionExecutionOptions {
                    timeout_secs: Some(20),
                    execution_id: Some("live-request-abort".to_owned()),
                    ..Default::default()
                },
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if sqlserver::execute_query(&mut observer, &sqlserver::wait_query(spid)).await.unwrap().rows[0][0]
                == serde_json::json!(1)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("request never reached server");
    // Transfer cleanup ownership before dropping the future. This avoids relying
    // on scheduler timing or lifecycle cancellation to reproduce the race.
    let disconnect_task = if disconnecting {
        let removed = state.transaction_sessions.write().await.remove(&session).unwrap();
        assert!(removed.busy);
        let state = state.clone();
        let session = session.clone();
        Some(tokio::spawn(async move {
            dbx_core::query::sqlserver_manual_transaction::disconnect(&state, &session, removed).await;
        }))
    } else {
        None
    };
    execution.abort();
    assert!(execution.await.unwrap_err().is_cancelled());
    if let Some(task) = disconnect_task {
        task.await.unwrap();
    }
    tokio::time::timeout(Duration::from_secs(8), async {
        while state.transaction_sessions.read().await.contains_key(&session) {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("dropped request left a registered session");
    sqlserver::wait_for_session_release(&mut observer, spid, identity.as_deref()).await;
    let visible =
        sqlserver::execute_query(&mut observer, &format!("SET LOCK_TIMEOUT 3000; SELECT COUNT(*) FROM {table}"))
            .await
            .unwrap();
    assert_eq!(visible.rows[0][0], serde_json::json!(0));
    assert!(state.running_queries.diagnostics().active_execution_ids.is_empty());
    assert!(execute_in_manual_transaction(&state, &session, "SELECT 2", database, None, Some(1)).await.is_err());
    sqlserver::execute_simple_batch_with_max_rows(&mut observer, &format!("DROP TABLE {table}"), None).await.unwrap();
    state.agent_manager.stop_daemons().await;
}
#[tokio::test]
#[ignore = "requires writable SQL Server; dropping a running request must stop its dedicated session"]
async fn live_manual_transaction_aborted_request_releases_original_server_transaction() {
    aborted_request_probe(false).await;
}

#[tokio::test]
#[ignore = "requires writable SQL Server; disconnect must own cleanup when the request is dropped"]
async fn live_manual_transaction_aborted_request_after_disconnect_releases_original_server_transaction() {
    aborted_request_probe(true).await;
}
