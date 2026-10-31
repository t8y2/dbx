//! Opt-in Oracle command regression using an isolated driver directory.
//! Set DBX_LIVE_ORACLE_{HOST,PORT,SERVICE,USER,PASSWORD,AGENT_DIR}; the write
//! test also requires DBX_LIVE_ORACLE_PROBE_PREFIX=DBX_OC_<unique suffix>.
//! `cargo test -p dbx-core --no-default-features --features sqlite-bundled
//! --test live_oracle_console -- --ignored --nocapture --test-threads=1`

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{
    begin_manual_transaction, commit_manual_transaction, execute_in_manual_transaction,
    execute_multi_core_with_options_for_client_typed, rollback_manual_transaction, ExecuteMultiResult,
    QueryExecutionOptions,
};
use futures::FutureExt;
use std::panic::AssertUnwindSafe;

fn required(suffix: &str) -> String {
    std::env::var(format!("DBX_LIVE_ORACLE_{suffix}")).expect("missing Oracle test environment variable")
}

async fn setup() -> (AppState, ConnectionConfig, tempfile::TempDir) {
    let username = required("USER");
    assert!(username.to_ascii_lowercase().contains("test"), "a test account is required");
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": format!("oracle-console-{}", uuid::Uuid::new_v4().simple()),
        "name": "Oracle console live regression",
        "db_type": DatabaseType::Oracle,
        "host": required("HOST"),
        "port": required("PORT").parse::<u16>().expect("Oracle port"),
        "username": username,
        "password": required("PASSWORD"),
        "database": required("SERVICE"),
        "connect_timeout_secs": 10,
        "query_timeout_secs": 15,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("Oracle test configuration");
    let directory = tempfile::tempdir().expect("isolated test directory");
    let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
        dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap(),
        directory.path().join("plugins"),
        std::path::PathBuf::from(required("AGENT_DIR")),
        "0.6.53",
    );
    state.configs.write().await.insert(config.id.clone(), config.clone());
    (state, config, directory)
}

async fn run(
    state: &AppState,
    config: &ConnectionConfig,
    session: &str,
    sql: &str,
) -> Result<Vec<ExecuteMultiResult>, String> {
    execute_multi_core_with_options_for_client_typed(
        state,
        &config.id,
        config.database.as_deref().unwrap(),
        sql,
        None,
        None,
        QueryExecutionOptions {
            client_session_id: Some(session.to_string()),
            timeout_secs: Some(15),
            max_rows: Some(32),
            preserve_explicit_transaction: true,
            ..Default::default()
        },
    )
    .await
    .map_err(|error| error.into_legacy_string())
}

async fn successful(state: &AppState, config: &ConnectionConfig, session: &str, sql: &str) -> Vec<ExecuteMultiResult> {
    let results = run(state, config, session, sql)
        .await
        .unwrap_or_else(|error| panic!("Oracle regression SQL failed: {sql}\n{error}"));
    for result in &results {
        assert!(!result.execution_error, "Oracle statement failed: {:?}", result.result.rows);
    }
    results
}

fn number(value: &serde_json::Value) -> i64 {
    value.as_i64().or_else(|| value.as_str().and_then(|value| value.parse().ok())).expect("integer cell")
}

fn scalar(results: &[ExecuteMultiResult]) -> i64 {
    number(&results.last().expect("query result").result.rows[0][0])
}

async fn identity(state: &AppState, config: &ConnectionConfig, session: &str) {
    let results = successful(
        state,
        config,
        session,
        "SELECT USER, SYS_CONTEXT('USERENV','CURRENT_SCHEMA'), SYS_CONTEXT('USERENV','SERVICE_NAME') FROM DUAL",
    )
    .await;
    let row = &results[0].result.rows[0];
    assert!(row[0].as_str().unwrap().eq_ignore_ascii_case(&required("USER")));
    let version = successful(state, config, session, "SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1").await;
    println!(
        "ORACLE_IDENTITY user={} schema={} service={} version={}",
        row[0], row[1], row[2], version[0].result.rows[0][0]
    );
}

#[tokio::test]
#[ignore = "requires an explicitly selected Oracle test account and installed test agent"]
async fn live_oracle_console_read_only_identity() {
    let (state, config, _directory) = setup().await;
    identity(&state, &config, "identity").await;
    assert!(state.close_client_session_pool(&config.id, config.database.as_deref(), "identity").await.unwrap());
}

#[tokio::test]
#[ignore = "creates and cleans up isolated objects in an explicitly approved Oracle test schema"]
async fn live_oracle_console_commands_and_transactions() {
    let prefix = required("PROBE_PREFIX");
    assert!(
        prefix.starts_with("DBX_OC_")
            && prefix.len() <= 20
            && prefix.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    );
    let table = prefix.clone();
    let procedure = format!("{prefix}_P");
    // Oracle permits dots in quoted identifiers, but not embedded double quotes.
    let quoted = format!("{prefix}.Q");
    let quoted_identifier = format!("\"{quoted}\"");
    let (state, config, _directory) = setup().await;
    let database = config.database.as_deref().unwrap();
    let mut created: Vec<(&str, String)> = Vec::new();
    let mut transactions: Vec<String> = Vec::new();
    let verification = AssertUnwindSafe(async {
        identity(&state, &config, "console").await;
        for name in [&table, &procedure, &quoted] {
            let count = scalar(
                &successful(
                    &state,
                    &config,
                    "observer",
                    &format!("SELECT COUNT(*) FROM USER_OBJECTS WHERE OBJECT_NAME = '{}'", name.replace('\'', "''")),
                )
                .await,
            );
            assert_eq!(count, 0, "refusing to replace an existing object");
        }
        successful(
            &state,
            &config,
            "console",
            &format!("CREATE TABLE {table} (ID NUMBER PRIMARY KEY, V NUMBER NOT NULL, NOTE VARCHAR2(40))"),
        )
        .await;
        created.push(("TABLE", table.clone()));
        successful(&state, &config, "console", &format!("CREATE TABLE {quoted_identifier} (ID NUMBER)")).await;
        created.push(("TABLE", quoted_identifier.clone()));
        successful(
            &state,
            &config,
            "console",
            &format!(
                "CREATE PROCEDURE {procedure}(n NUMBER) AS BEGIN UPDATE {table} SET V = V + n WHERE ID = 1; END;\n/"
            ),
        )
        .await;
        created.push(("PROCEDURE", procedure.clone()));
        successful(&state, &config, "console", &format!("INSERT INTO {table} (ID,V,NOTE) VALUES (1,0,'console test')"))
            .await;
        let value_sql = format!("SELECT V FROM {table} WHERE ID = 1");
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 0);

        for object in [
            table.clone(),
            table.to_ascii_lowercase(),
            format!("{}.{}", required("USER").to_ascii_uppercase(), table),
            quoted_identifier.clone(),
            format!("{}.{}", required("USER").to_ascii_uppercase(), quoted_identifier),
        ] {
            let desc = successful(&state, &config, "console", &format!("DESC {object}")).await;
            assert_eq!(desc[0].result.columns, vec!["Name", "Null?", "Type"]);
            assert_eq!(desc[0].result.rows[0][0], "ID");
            if object.contains('"') {
                assert_eq!(desc[0].result.rows.len(), 1);
                assert_eq!(desc[0].result.rows[0][1], "");
            } else {
                assert_eq!(desc[0].result.rows.len(), 3);
                assert_eq!(desc[0].result.rows[0][1], "NOT NULL");
                assert!(desc[0].result.rows[0][2].as_str().unwrap().starts_with("NUMBER"));
                assert_eq!(desc[0].result.rows[2][0], "NOTE");
                let note_type = desc[0].result.rows[2][2].as_str().unwrap();
                assert!(note_type.starts_with("VARCHAR2") && note_type.contains("40"));
            }
        }
        println!("PASS describe: current/qualified/lowercase/quoted-dot names, nullability and type lengths");

        let commands = successful(
            &state,
            &config,
            "console",
            "PROMPT oracle probe\nSET TIMING ON\nSHOW USER\nSPOOL unsupported.txt\nSELECT 7 FROM DUAL;",
        )
        .await;
        assert_eq!(commands.len(), 5);
        assert_eq!(commands[0].result.rows[0][0], "oracle probe");
        assert!(commands[1].result.rows[0][0].as_str().unwrap().contains("acknowledged"));
        assert!(commands[2].result.rows[0][0].as_str().unwrap().eq_ignore_ascii_case(&required("USER")));
        assert!(commands[3].result.rows[0][0].as_str().unwrap().contains("not supported"));
        assert_eq!(scalar(&commands), 7);
        successful(&state, &config, "console", "SET CONSTRAINTS ALL IMMEDIATE;").await;
        println!("PASS client commands: PROMPT/SET/SHOW/unsupported warning and server SET CONSTRAINTS");

        successful(&state, &config, "console", &format!("EXEC {procedure}(2); -- trailing note")).await;
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 2);
        successful(
            &state,
            &config,
            "console",
            &format!(
                "BEGIN\n UPDATE {table} SET V = V + 1 WHERE ID = 1;\nEND;\n/\nSELECT V FROM {table} WHERE ID = 1;"
            ),
        )
        .await;
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 3);
        successful(
            &state,
            &config,
            "console",
            &format!("UPDATE {table} SET V = V + 1 WHERE ID = 1;\nRUN\nSELECT V FROM {table} WHERE ID = 1;"),
        )
        .await;
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 5);
        let exit =
            successful(&state, &config, "console", &format!("EXIT\nUPDATE {table} SET V = 99 WHERE ID = 1;")).await;
        assert_eq!(exit.len(), 1);
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 5);
        println!(
            "PASS execution: EXEC with trailing comment, anonymous block once, RUN once, EXIT skips remaining writes"
        );

        let missing =
            run(&state, &config, "console", &format!("DESC {prefix}_MISSING\nSELECT 8 FROM DUAL;")).await.unwrap();
        assert!(missing[0].execution_error);
        assert_eq!(scalar(&missing), 8);
        println!("PASS errors: missing DESC is reported without suppressing the next statement");

        let session = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
        transactions.push(session.clone());
        execute_in_manual_transaction(
            &state,
            &session,
            &format!("UPDATE {table} SET V = 10 WHERE ID = 1"),
            database,
            None,
            Some(16),
        )
        .await
        .unwrap();
        let own = execute_in_manual_transaction(&state, &session, &value_sql, database, None, Some(16)).await.unwrap();
        assert_eq!(number(&own[0].rows[0][0]), 10);
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 5);
        rollback_manual_transaction(&state, &session).await.unwrap();
        transactions.clear();
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 5);

        let session = begin_manual_transaction(&state, &config.id, database, None, None).await.unwrap();
        transactions.push(session.clone());
        execute_in_manual_transaction(
            &state,
            &session,
            &format!("UPDATE {table} SET V = 11 WHERE ID = 1"),
            database,
            None,
            Some(16),
        )
        .await
        .unwrap();
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 5);
        commit_manual_transaction(&state, &session).await.unwrap();
        transactions.clear();
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 11);
        println!(
            "PASS manual transactions: own writes visible, observer isolated, ROLLBACK undoes and COMMIT persists"
        );
    })
    .catch_unwind()
    .await;

    let mut cleanup_failed = false;
    for session in transactions {
        cleanup_failed |= rollback_manual_transaction(&state, &session).await.is_err();
    }
    for (kind, name) in created.iter().rev() {
        let sql = format!("DROP {kind} {name}{}", if *kind == "TABLE" { " PURGE" } else { "" });
        match run(&state, &config, "cleanup", &sql).await {
            Ok(results) if results.iter().all(|result| !result.execution_error) => {}
            _ => {
                cleanup_failed = true;
                eprintln!("CLEANUP_FAILED object={name}");
            }
        }
    }
    let remaining = scalar(
        &successful(
            &state,
            &config,
            "cleanup",
            &format!("SELECT COUNT(*) FROM USER_OBJECTS WHERE OBJECT_NAME IN ('{table}','{procedure}','{quoted}')"),
        )
        .await,
    );
    cleanup_failed |= remaining != 0;
    for session in ["console", "observer", "cleanup"] {
        cleanup_failed |= state.close_client_session_pool(&config.id, Some(database), session).await.is_err();
    }
    assert!(!cleanup_failed, "cleanup incomplete; inspect the isolated DBX_OC_ objects");
    println!("ORACLE_CLEANUP_OK remaining_objects={remaining}");
    if let Err(panic) = verification {
        std::panic::resume_unwind(panic);
    }
}
