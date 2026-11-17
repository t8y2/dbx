//! Opt-in DM8 regression through DBX's execute-multi and manual transaction APIs.
//! Set DBX_LIVE_DM_{HOST,PORT,USER,PASSWORD,AGENT_DIR}; the write test requires
//! DBX_LIVE_DM_PROBE_PREFIX=DBX_DM_<unique suffix> for absent, approved objects.
//! `cargo test -p dbx-core --no-default-features --features sqlite-bundled
//! --test live_dameng_console -- --ignored --nocapture --test-threads=1`

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
    std::env::var(format!("DBX_LIVE_DM_{suffix}")).expect("missing DM8 test environment variable")
}

async fn setup() -> (AppState, ConnectionConfig, tempfile::TempDir) {
    let username = required("USER");
    assert!(username.to_ascii_lowercase().contains("test"), "an explicitly selected test account is required");
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": format!("dm8-console-{}", uuid::Uuid::new_v4().simple()),
        "name": "DM8 console live regression",
        "db_type": DatabaseType::Dameng,
        "host": required("HOST"),
        "port": required("PORT").parse::<u16>().expect("DM8 port"),
        "username": username,
        "password": required("PASSWORD"),
        "database": "",
        "connect_timeout_secs": 10,
        "query_timeout_secs": 15,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("DM8 test configuration");
    let directory = tempfile::tempdir().expect("isolated test directory");
    let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
        dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap(),
        directory.path().join("plugins"),
        std::path::PathBuf::from(required("AGENT_DIR")),
        env!("CARGO_PKG_VERSION"),
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
        "",
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
    let results = run(state, config, session, sql).await.expect("execute DM8 statement");
    for result in &results {
        assert!(!result.execution_error, "DM8 statement failed: {:?}", result.result.rows);
    }
    results
}

fn number(value: &serde_json::Value) -> i64 {
    value.as_i64().or_else(|| value.as_str().and_then(|value| value.parse().ok())).expect("integer cell")
}

fn scalar(results: &[ExecuteMultiResult]) -> i64 {
    number(&results.last().expect("query result").result.rows[0][0])
}

async fn identity(state: &AppState, config: &ConnectionConfig, session: &str) -> String {
    let user = successful(state, config, session, "SELECT USER FROM DUAL").await;
    let owner = user[0].result.rows[0][0].as_str().unwrap().to_string();
    assert!(owner.eq_ignore_ascii_case(&required("USER")));
    let version = successful(state, config, session, "SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1").await;
    println!("DM8_IDENTITY user={owner} version={}", version[0].result.rows[0][0]);
    owner
}

#[tokio::test]
#[ignore = "requires an explicitly selected DM8 test account and isolated official JDBC agent"]
async fn live_dm8_console_read_only_identity() {
    let (state, config, _directory) = setup().await;
    identity(&state, &config, "identity").await;
    state.close_client_session_pool(&config.id, Some(""), "identity").await.unwrap();
}

#[tokio::test]
#[ignore = "creates and cleans up isolated objects in an explicitly approved DM8 test schema"]
async fn live_dm8_console_sql_and_transactions() {
    let prefix = required("PROBE_PREFIX");
    assert!(
        prefix.starts_with("DBX_DM_")
            && prefix.len() <= 20
            && prefix.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    );
    let procedure = format!("{prefix}_P");
    let quoted = format!("{prefix}.Q\"X");
    let quoted_identifier = format!("\"{}\"", quoted.replace('"', "\"\""));
    let (state, config, _directory) = setup().await;
    let mut created: Vec<(&str, String)> = Vec::new();
    let mut transactions: Vec<String> = Vec::new();
    let verification = AssertUnwindSafe(async {
        let owner = identity(&state, &config, "console").await;
        for name in [&prefix, &procedure, &quoted] {
            assert_eq!(scalar(&successful(&state, &config, "observer", &format!("SELECT COUNT(*) FROM USER_OBJECTS WHERE OBJECT_NAME = '{name}'")).await), 0, "refusing to replace an existing object");
        }
        successful(&state, &config, "console", &format!("CREATE TABLE {prefix} (ID INT PRIMARY KEY, V INT NOT NULL, NOTE VARCHAR(40))")).await;
        created.push(("TABLE", prefix.clone()));
        successful(&state, &config, "console", &format!("CREATE TABLE {quoted_identifier} (ID INT)")).await;
        created.push(("TABLE", quoted_identifier.clone()));
        successful(&state, &config, "console", &format!("INSERT INTO {prefix} VALUES (1,0,'dm8 console')")).await;
        let value_sql = format!("SELECT V FROM {prefix} WHERE ID = 1");
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 0);
        let columns = dbx_core::schema::get_columns_core_for_session_in_context(&state, &config.id, "", &owner, &prefix, None, None).await.unwrap();
        assert_eq!(columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(), vec!["ID", "V", "NOTE"]);
        let quoted_columns = dbx_core::schema::get_columns_core_for_session_in_context(&state, &config.id, "", &owner, &quoted, None, None).await.unwrap();
        assert_eq!(quoted_columns[0].name, "ID");
        println!("PASS metadata: ordinary and quoted-dot/escaped-quote tables resolve through DBX schema API");

        let batch = successful(&state, &config, "console", &format!("BEGIN\n UPDATE {prefix} SET V = V + 1 WHERE ID = 1;\nEND;\n/\nSELECT V FROM {prefix} WHERE ID = 1;")).await;
        assert_eq!(batch.len(), 2);
        assert_eq!(scalar(&batch), 1);
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 1);
        println!("PASS anonymous block: internal semicolons preserved, slash terminates once, follow-up SELECT works");

        successful(&state, &config, "console", &format!("CREATE PROCEDURE {procedure}(n INT) AS BEGIN UPDATE {prefix} SET V = V + n WHERE ID = 1; END;\n/")).await;
        created.push(("PROCEDURE", procedure.clone()));
        successful(&state, &config, "console", &format!("CALL {procedure}(2)")).await;
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 3);
        println!("PASS routine: CREATE PROCEDURE with slash and native CALL execute correctly");

        assert_eq!(dbx_core::sql::console_command_family_for_database(DatabaseType::Dameng), Some(dbx_sql::console_command::ConsoleCommandFamily::Disql));
        for object in [prefix.clone(), prefix.to_ascii_lowercase(), format!("{owner}.{prefix}"), quoted_identifier.clone(), format!("{owner}.{quoted_identifier}")] {
            let desc = successful(&state, &config, "console", &format!("DESC {object}")).await;
            assert_eq!(desc[0].result.columns, vec!["Name", "Null?", "Type"]);
            assert_eq!(desc[0].result.rows[0][0], "ID");
        }
        successful(&state, &config, "console", &format!("EXEC {procedure}(0); -- trailing note")).await;
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 3);
        let commands = successful(&state, &config, "console", "PROMPT dm8; literal\nSET TIMING ON\nSHOW USER\nSPOOL unsupported.txt\nSELECT 7 FROM DUAL;").await;
        assert_eq!(commands.len(), 5);
        assert_eq!(commands[0].result.rows[0][0], "dm8; literal");
        let warning = commands[1].result.rows[0][0].as_str().unwrap();
        assert!(warning.contains("not implemented") && warning.contains("not applied") && !warning.contains("acknowledged"));
        assert_eq!(commands[2].result.rows[0][0], owner);
        assert!(commands[3].result.rows[0][0].as_str().unwrap().contains("disql"));
        assert_eq!(scalar(&commands), 7);
        let rerun = successful(&state, &config, "console", &format!("EXEC {procedure}(1)\nRUN\n{value_sql};")).await;
        assert_eq!(scalar(&rerun), 5);
        let exit = successful(&state, &config, "console", &format!("EXIT\nUPDATE {prefix} SET V = 99 WHERE ID = 1;")).await;
        assert_eq!(exit.len(), 1);
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 5);
        successful(&state, &config, "console", &format!("SET SCHEMA \"{owner}\";\nSELECT 1 FROM DUAL;")).await;
        let missing = run(&state, &config, "console", &format!("DESC {prefix}_MISSING\nSELECT 8 FROM DUAL;")).await.unwrap();
        assert!(missing[0].execution_error);
        assert_eq!(scalar(&missing), 8);
        successful(&state, &config, "console", &format!("UPDATE {prefix} SET V = 3 WHERE ID = 1;")).await;
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 3);
        println!("PASS disql: DESC identifiers, EXEC/comments, PROMPT, SHOW USER, RUN, EXIT, explicit SET warning, native SET SCHEMA and missing-object recovery");

        let session = begin_manual_transaction(&state, &config.id, "", None, None).await.unwrap();
        transactions.push(session.clone());
        execute_in_manual_transaction(&state, &session, &format!("UPDATE {prefix} SET V = 10 WHERE ID = 1"), "", None, Some(16)).await.unwrap();
        let own = execute_in_manual_transaction(&state, &session, &value_sql, "", None, Some(16)).await.unwrap();
        assert_eq!(number(&own[0].rows[0][0]), 10);
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 3);
        rollback_manual_transaction(&state, &session).await.unwrap();
        transactions.clear();
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 3);
        println!("PASS rollback: own pending UPDATE visible, observer isolated, rollback removes changes");

        let session = begin_manual_transaction(&state, &config.id, "", None, None).await.unwrap();
        transactions.push(session.clone());
        execute_in_manual_transaction(&state, &session, &format!("UPDATE {prefix} SET V = 11 WHERE ID = 1"), "", None, Some(16)).await.unwrap();
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 3);
        commit_manual_transaction(&state, &session).await.unwrap();
        transactions.clear();
        assert_eq!(scalar(&successful(&state, &config, "observer", &value_sql).await), 11);
        println!("PASS commit: cross-request UPDATE becomes visible to observer after COMMIT");

        let duplicate = run(&state, &config, "console", &format!("INSERT INTO {prefix} VALUES (1,99,'duplicate')")).await;
        assert!(duplicate.is_err() || duplicate.as_ref().unwrap().iter().any(|result| result.execution_error));
        assert_eq!(scalar(&successful(&state, &config, "console", &value_sql).await), 11);
        state.close_client_session_pool(&config.id, Some(""), "console").await.unwrap();
        assert_eq!(scalar(&successful(&state, &config, "console", &value_sql).await), 11);
        println!("PASS recovery: duplicate-key error is visible; session can query and reconnect afterwards");
    }).catch_unwind().await;

    let mut cleanup_failed = false;
    for session in transactions {
        cleanup_failed |= rollback_manual_transaction(&state, &session).await.is_err();
    }
    for (kind, name) in created.iter().rev() {
        match run(&state, &config, "cleanup", &format!("DROP {kind} {name}")).await {
            Ok(results) if results.iter().all(|result| !result.execution_error) => {}
            _ => {
                cleanup_failed = true;
                eprintln!("DM8_CLEANUP_FAILED object={name}");
            }
        }
    }
    let remaining = scalar(
        &successful(
            &state,
            &config,
            "cleanup",
            &format!("SELECT COUNT(*) FROM USER_OBJECTS WHERE OBJECT_NAME IN ('{prefix}','{procedure}','{quoted}')"),
        )
        .await,
    );
    cleanup_failed |= remaining != 0;
    for session in ["console", "observer", "cleanup"] {
        cleanup_failed |= state.close_client_session_pool(&config.id, Some(""), session).await.is_err();
    }
    assert!(!cleanup_failed, "DM8 probe cleanup incomplete; inspect isolated DBX_DM_ objects");
    println!("DM8_CLEANUP_OK remaining_objects={remaining}");
    if let Err(panic) = verification {
        std::panic::resume_unwind(panic);
    }
}
