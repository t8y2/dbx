//! Opt-in MySQL verification of the command console's execute-multi contract.
//! Set DBX_LIVE_CONSOLE_MYSQL_{HOST,PORT,USER,PASSWORD,DATABASE,TABLE}, then run
//! `cargo test -p dbx-core --no-default-features --features sqlite-bundled
//! --test live_console_transactions -- --ignored --nocapture`.
//! TABLE must name an approved, absent dbx_tx_probe_* table in a test database.

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{execute_multi_core_with_options_for_client_typed, ExecuteMultiResult, QueryExecutionOptions};
use futures::FutureExt;
use std::panic::AssertUnwindSafe;

fn required(suffix: &str) -> String {
    std::env::var(format!("DBX_LIVE_CONSOLE_MYSQL_{suffix}")).expect("missing live test environment variable")
}

async fn run(
    state: &AppState,
    config: &ConnectionConfig,
    session: Option<&str>,
    sql: &str,
    preserve: bool,
) -> Result<Vec<ExecuteMultiResult>, String> {
    let results = execute_multi_core_with_options_for_client_typed(
        state,
        &config.id,
        config.database.as_deref().expect("database"),
        sql,
        None,
        None,
        QueryExecutionOptions {
            client_session_id: session.map(str::to_string),
            preserve_explicit_transaction: preserve,
            timeout_secs: Some(10),
            max_rows: Some(16),
            ..Default::default()
        },
    )
    .await
    .map_err(|error| error.into_legacy_string())?;
    if results.iter().any(|result| result.execution_error) {
        return Err("server returned a per-statement execution error".to_string());
    }
    Ok(results)
}

fn scalar(results: &[ExecuteMultiResult]) -> i64 {
    let value = &results.last().expect("query result").result.rows[0][0];
    value.as_i64().or_else(|| value.as_str().and_then(|text| text.parse().ok())).expect("integer scalar")
}

fn transaction_open(results: &[ExecuteMultiResult]) -> bool {
    results.last().expect("statement result").auto_commit_open_transaction.expect("transaction state report")
}

#[tokio::test]
#[ignore = "requires an explicitly approved writable MySQL test database and absent probe table"]
async fn live_mysql_console_transactions_commit_rollback_and_close() {
    let database = required("DATABASE");
    assert!(database.to_ascii_lowercase().contains("test"), "only a named test database is allowed");
    let table = required("TABLE");
    assert!(
        table.starts_with("dbx_tx_probe_")
            && table.len() <= 64
            && table.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
        "the probe table must be an approved simple dbx_tx_probe_* identifier"
    );
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": format!("console-live-{}", uuid::Uuid::new_v4().simple()),
        "name": "Console transaction integration test",
        "db_type": DatabaseType::Mysql,
        "host": required("HOST"),
        "port": required("PORT").parse::<u16>().expect("MySQL port"),
        "username": required("USER"),
        "password": required("PASSWORD"),
        "database": database,
        "connect_timeout_secs": 5,
        "query_timeout_secs": 10,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("test connection configuration");
    let directory = tempfile::tempdir().expect("temporary fixture directory");
    let state = AppState::new(
        dbx_core::persistence::test_storage::open(&directory.path().join("storage.db"))
            .await
            .expect("isolated test storage"),
    );
    state.configs.write().await.insert(config.id.clone(), config.clone());
    let console = format!("console-{}", uuid::Uuid::new_v4().simple());
    let observer = format!("observer-{}", uuid::Uuid::new_v4().simple());
    let identity = run(&state, &config, None, "SELECT DATABASE(), VERSION()", false).await.expect("test DB identity");
    assert_eq!(identity[0].result.rows[0][0].as_str(), Some(database.as_str()));
    println!("LIVE_IDENTITY database={} version={}", database, identity[0].result.rows[0][1]);
    let existing = run(
        &state,
        &config,
        None,
        &format!(
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{table}'"
        ),
        false,
    )
    .await
    .expect("check probe table is absent");
    assert_eq!(scalar(&existing), 0, "refusing to overwrite an existing table");
    run(
        &state,
        &config,
        None,
        &format!("CREATE TABLE `{table}` (id INTEGER PRIMARY KEY, v INTEGER NOT NULL) ENGINE=InnoDB"),
        false,
    )
    .await
    .expect("create approved isolated probe table");

    // Always release transactions and remove our table, including assertion failures.
    let verification = AssertUnwindSafe(async {
        run(&state, &config, None, &format!("INSERT INTO `{table}` VALUES (1, 0)"), false).await.unwrap();
        let console_id = scalar(&run(&state, &config, Some(&console), "SELECT CONNECTION_ID()", true).await.unwrap());
        let observer_id =
            scalar(&run(&state, &config, Some(&observer), "SELECT CONNECTION_ID()", false).await.unwrap());
        assert_ne!(console_id, observer_id, "observer must use another physical connection");
        let value_sql = format!("SELECT v FROM `{table}` WHERE id = 1");
        let inserted_sql = format!("SELECT COUNT(*) FROM `{table}` WHERE id = 2");

        assert!(transaction_open(&run(&state, &config, Some(&console), "START TRANSACTION", true).await.unwrap()));
        let inserted =
            run(&state, &config, Some(&console), &format!("INSERT INTO `{table}` VALUES (2, 20)"), true).await.unwrap();
        assert!(transaction_open(&inserted));
        assert_eq!(scalar(&run(&state, &config, Some(&console), &inserted_sql, true).await.unwrap()), 1);
        assert_eq!(scalar(&run(&state, &config, Some(&observer), &inserted_sql, false).await.unwrap()), 0);
        assert!(!transaction_open(&run(&state, &config, Some(&console), "ROLLBACK", true).await.unwrap()));
        assert_eq!(scalar(&run(&state, &config, Some(&observer), &inserted_sql, false).await.unwrap()), 0);
        println!("PASS rollback: uncommitted INSERT was isolated and removed");

        run(&state, &config, Some(&console), "START TRANSACTION", true).await.unwrap();
        let updated = run(&state, &config, Some(&console), &format!("UPDATE `{table}` SET v = 1 WHERE id = 1"), true)
            .await
            .unwrap();
        assert!(transaction_open(&updated));
        assert!(!updated[0].auto_commit_explicit_transaction_rolled_back);
        assert_eq!(scalar(&run(&state, &config, Some(&console), &value_sql, true).await.unwrap()), 1);
        assert_eq!(scalar(&run(&state, &config, Some(&observer), &value_sql, false).await.unwrap()), 0);
        assert!(!transaction_open(&run(&state, &config, Some(&console), "COMMIT", true).await.unwrap()));
        assert_eq!(scalar(&run(&state, &config, Some(&observer), &value_sql, false).await.unwrap()), 1);
        assert_eq!(
            scalar(&run(&state, &config, Some(&console), "SELECT CONNECTION_ID()", true).await.unwrap()),
            console_id
        );
        println!(
            "PASS commit: same console connection persisted across requests; observer saw change only after COMMIT"
        );

        run(&state, &config, Some(&console), &format!("UPDATE `{table}` SET v = 2 WHERE id = 1"), true).await.unwrap();
        assert_eq!(scalar(&run(&state, &config, Some(&observer), &value_sql, false).await.unwrap()), 2);
        println!("PASS autocommit: normal UPDATE committed after explicit transaction ended");

        run(&state, &config, Some(&console), "START TRANSACTION", true).await.unwrap();
        run(&state, &config, Some(&console), &format!("UPDATE `{table}` SET v = 3 WHERE id = 1"), true).await.unwrap();
        let duplicate =
            run(&state, &config, Some(&console), &format!("INSERT INTO `{table}` VALUES (1, 100)"), true).await;
        assert!(duplicate.is_err(), "duplicate primary key must fail");
        assert_eq!(scalar(&run(&state, &config, Some(&console), &value_sql, true).await.unwrap()), 3);
        assert_eq!(scalar(&run(&state, &config, Some(&observer), &value_sql, false).await.unwrap()), 2);
        run(&state, &config, Some(&console), "ROLLBACK", true).await.unwrap();
        assert_eq!(scalar(&run(&state, &config, Some(&observer), &value_sql, false).await.unwrap()), 2);
        println!("PASS error recovery: duplicate-key failure preserved the transaction until explicit ROLLBACK");

        let legacy = run(
            &state,
            &config,
            Some(&console),
            &format!("START TRANSACTION; UPDATE `{table}` SET v = 9 WHERE id = 1"),
            false,
        )
        .await
        .unwrap();
        assert!(!transaction_open(&legacy));
        assert!(legacy.last().unwrap().auto_commit_explicit_transaction_rolled_back);
        assert_eq!(scalar(&run(&state, &config, Some(&observer), &value_sql, false).await.unwrap()), 2);
        println!("PASS control: preserve=false reproduced the historical automatic rollback");

        run(&state, &config, Some(&console), "START TRANSACTION", true).await.unwrap();
        run(&state, &config, Some(&console), &format!("UPDATE `{table}` SET v = 99 WHERE id = 1"), true).await.unwrap();
        assert_eq!(scalar(&run(&state, &config, Some(&observer), &value_sql, false).await.unwrap()), 2);
        assert!(state.close_client_session_pool(&config.id, Some(&database), &console).await.unwrap());
        assert_eq!(scalar(&run(&state, &config, Some(&observer), &value_sql, false).await.unwrap()), 2);
        let reopened_id = scalar(&run(&state, &config, Some(&console), "SELECT CONNECTION_ID()", true).await.unwrap());
        assert_ne!(reopened_id, console_id);
        assert_eq!(scalar(&run(&state, &config, Some(&console), &value_sql, true).await.unwrap()), 2);
        println!("PASS close: closing the session rolled back pending UPDATE and reopening used a new connection");
    })
    .catch_unwind()
    .await;

    let mut close_failed = false;
    for session in [&console, &observer] {
        let _ = run(&state, &config, Some(session), "ROLLBACK", false).await;
        close_failed |= state.close_client_session_pool(&config.id, Some(&database), session).await.is_err();
    }
    let cleanup = run(&state, &config, None, &format!("DROP TABLE `{table}`"), false).await;
    if cleanup.is_ok() {
        let remaining = run(
            &state,
            &config,
            None,
            &format!("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{table}'"),
            false,
        )
        .await
        .expect("verify cleanup");
        assert_eq!(scalar(&remaining), 0);
        println!("CLEANUP_OK table={table}");
    }
    cleanup.expect("failed to drop the approved probe table; manual cleanup required");
    assert!(!close_failed, "one or more test sessions failed to close");
    if let Err(panic) = verification {
        std::panic::resume_unwind(panic);
    }
}
