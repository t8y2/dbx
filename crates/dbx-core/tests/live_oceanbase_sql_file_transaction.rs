//! Run explicitly with DBX_LIVE_SQL_FILE_OB_{HOST,USER,PASSWORD,DATABASE,AGENT_DIR}.
//! The agent directory must contain a compatible installed OceanBase Oracle driver and JRE.
use dbx_core::connection::AppState;
use dbx_core::data::sql_file_import::{execute_sql_file_content, execute_sql_file_paths};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{
    begin_manual_transaction, commit_manual_transaction, execute_blob_bound_statements,
    execute_in_manual_transaction_with_options, execute_sql_statement, rollback_manual_transaction,
    ManualTransactionExecutionOptions,
};
use dbx_core::sql::{SqlFileRequest, SqlFileStatus};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

fn required(name: &str) -> String {
    std::env::var(format!("DBX_LIVE_SQL_FILE_OB_{name}")).expect("required live SQL file test configuration")
}

async fn query(
    state: &AppState,
    connection: &str,
    database: &str,
    sql: &str,
) -> Result<dbx_core::types::QueryResult, String> {
    execute_sql_statement(state, connection, database, sql, None, None).await
}

async fn verify_committed_value(state: &AppState, database: &str, table: &str, expected: i64) -> Result<(), String> {
    let result = query(state, "file-reader", database, &format!("SELECT VAL FROM {table} WHERE ID = 1")).await?;
    let value = result.rows.first().and_then(|row| row.first());
    let actual = value.and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()));
    if actual != Some(expected) {
        return Err(format!("Independent connection expected {expected}, got {value:?}"));
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires an installed OceanBase Oracle agent and writable DBX_LIVE_SQL_FILE_OB_* environment"]
async fn live_oceanbase_sql_files_commit_rollback_failure_and_cancel() {
    let directory = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("state.db")).await.unwrap();
    let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        directory.path().join("plugins"),
        required("AGENT_DIR").into(),
        "0.6.17",
    );
    let database = required("DATABASE");
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "file-writer", "name": "SQL file transaction regression", "db_type": DatabaseType::OceanbaseOracle,
        "host": required("HOST"), "port": std::env::var("DBX_LIVE_SQL_FILE_OB_PORT").ok().and_then(|s| s.parse::<u16>().ok()).unwrap_or(2881),
        "username": required("USER"), "password": required("PASSWORD"), "database": database,
        "connect_timeout_secs": 10, "query_timeout_secs": 30, "keepalive_interval_secs": 0,
    })).unwrap();
    let mut reader = config.clone();
    reader.id = "file-reader".to_string();
    state.configs.write().await.insert(config.id.clone(), config);
    state.configs.write().await.insert(reader.id.clone(), reader);
    let table = format!("DBX_FILE_TXN_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]).to_uppercase();
    query(&state, "file-writer", &database, &format!("CREATE TABLE {table} (ID NUMBER PRIMARY KEY, VAL NUMBER)"))
        .await
        .unwrap();

    let mut phase = "seed";
    let outcome: Result<(), String> = async {
        query(&state, "file-writer", &database, &format!("INSERT INTO {table} VALUES (1, 10)")).await?;
        let mut request = SqlFileRequest {
            execution_id: "live-manual-file".to_string(), connection_id: "file-writer".to_string(),
            database: database.clone(), schema: None, file_path: String::new(), continue_on_error: false,
            selected_tables: None, part_cooldown_ms: 0, skip_relational_constraints: false, txn_session_id: None,
        };
        let first = directory.path().join("first.sql");
        let second = directory.path().join("second.sql");
        std::fs::write(&first, format!("UPDATE {table} SET VAL = 20 WHERE ID = 1;\n")).unwrap();
        std::fs::write(&second, format!("UPDATE {table} SET VAL = 21 WHERE ID = 1;\n")).unwrap();
        phase = "begin transaction";
        let session = begin_manual_transaction(&state, "file-writer", &database, None, None).await?;
        request.txn_session_id = Some(session.clone());
        phase = "execute multiple files";
        execute_sql_file_paths(&state, &request, &[&first, &second], CancellationToken::new(), Instant::now(), |_| {}).await?;
        phase = "read from independent connection";
        verify_committed_value(&state, &database, &table, 10).await?;
        phase = "commit";
        commit_manual_transaction(&state, &session).await?;
        phase = "read from independent connection";
        verify_committed_value(&state, &database, &table, 21).await?;

        phase = "begin transaction";
        let session = begin_manual_transaction(&state, "file-writer", &database, None, None).await?;
        request.txn_session_id = Some(session.clone());
        phase = "execute file content";
        execute_sql_file_content(&state, &request, &format!("UPDATE {table} SET VAL = 30 WHERE ID = 1;"), CancellationToken::new(), Instant::now(), |_| {}).await?;
        phase = "read from independent connection";
        verify_committed_value(&state, &database, &table, 21).await?;
        phase = "rollback";
        rollback_manual_transaction(&state, &session).await?;
        phase = "read from independent connection";
        verify_committed_value(&state, &database, &table, 21).await?;

        phase = "begin transaction";
        let session = begin_manual_transaction(&state, "file-writer", &database, None, None).await?;
        request.txn_session_id = Some(session.clone());
        let mut terminal = None;
        phase = "execute failing file";
        let failure = execute_sql_file_content(&state, &request, &format!("UPDATE {table} SET VAL = 40 WHERE ID = 1; UPDATE {table} SET MISSING_COLUMN = 1; UPDATE {table} SET VAL = 50;"), CancellationToken::new(), Instant::now(), |event| terminal = Some(event)).await;
        if failure.is_ok() || terminal.as_ref().is_none_or(|event| event.status != SqlFileStatus::Error || event.success_count != 1 || event.failure_count != 1) {
            return Err("A failed SQL file must stop after its first error".to_string());
        }
        if state.transaction_sessions.read().await.contains_key(&session) { return Err("Failed file retained its transaction".to_string()); }
        phase = "read from independent connection";
        verify_committed_value(&state, &database, &table, 21).await?;

        phase = "begin transaction";
        let session = begin_manual_transaction(&state, "file-writer", &database, None, None).await?;
        request.txn_session_id = Some(session.clone());
        let token = CancellationToken::new();
        let mut terminal = None;
        phase = "execute file content";
        execute_sql_file_content(&state, &request, &format!("UPDATE {table} SET VAL = 60 WHERE ID = 1; UPDATE {table} SET VAL = 70 WHERE ID = 1;"), token.clone(), Instant::now(), |event| {
            if event.success_count == 1 { token.cancel(); }
            terminal = Some(event);
        }).await?;
        if terminal.is_none_or(|event| event.status != SqlFileStatus::Cancelled || event.success_count != 1) {
            return Err("Cancellation must stop before the second statement".to_string());
        }
        if state.transaction_sessions.read().await.contains_key(&session) { return Err("Cancelled file retained its transaction".to_string()); }
        phase = "read from independent connection";
        verify_committed_value(&state, &database, &table, 21).await
    }.await;

    let remaining: Vec<String> = state.transaction_sessions.read().await.keys().cloned().collect();
    for session in remaining {
        let _ = rollback_manual_transaction(&state, &session).await;
    }
    let cleanup = query(&state, "file-writer", &database, &format!("DROP TABLE {table} PURGE")).await;
    state.shutdown(Duration::from_secs(10)).await;
    cleanup.expect("remove isolated regression table");
    outcome.unwrap_or_else(|error| panic!("SQL file manual transaction {phase}: {error}"));
}

/// Real Core -> installed Agent test. Credentials must name a dedicated DBX_BIND_* owner.
#[tokio::test]
#[ignore = "requires explicitly authorized dedicated DBX_BIND_* owner and blob_bind_statements_v1 agent"]
async fn live_oceanbase_bound_manual_savepoint_and_user_rollback() {
    use sha2::{Digest, Sha256};
    let database = required("DATABASE");
    let user = required("USER");
    assert!(
        database.starts_with("DBX_BIND_")
            && database.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_'),
        "use a dedicated DBX_BIND_* schema owner"
    );
    assert_eq!(user, format!("{database}@oracletest"), "use the dedicated owner in the verified tenant");
    let url_params = required("URL_PARAMS");
    assert_eq!(
        url_params, "connectTimeout=10000&socketTimeout=30000",
        "use the verified bounded connection parameters"
    );
    assert_eq!(required("ALLOW_BOUND_MANUAL_WRITE"), "yes", "explicit live write gate required");
    let evidence = std::path::PathBuf::from(required("BOUND_MANUAL_EVIDENCE"));
    assert!(evidence.is_dir(), "prepare an independent evidence directory first");
    let agent_dir = std::path::PathBuf::from(required("AGENT_DIR"));
    let agent_hash = format!(
        "{:X}",
        Sha256::digest(
            std::fs::read(agent_dir.join("drivers/oceanbase-oracle/agent.jar"))
                .expect("independent installed bound Agent jar")
        )
    );
    let expected_agent_hash = required("AGENT_SHA256");
    assert!(
        expected_agent_hash.len() == 64 && expected_agent_hash.bytes().all(|c| c.is_ascii_hexdigit()),
        "verified Agent SHA256 required"
    );
    assert_eq!(agent_hash, expected_agent_hash.to_ascii_uppercase(), "use the approved independent Agent artifact");
    let directory = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("state.db")).await.unwrap();
    let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        directory.path().join("plugins"),
        agent_dir,
        "0.6.17",
    );
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "bound-writer", "name": "Bound manual transaction regression", "db_type": DatabaseType::OceanbaseOracle,
        "host": required("HOST"), "port": std::env::var("DBX_LIVE_SQL_FILE_OB_PORT").ok().and_then(|s| s.parse::<u16>().ok()).unwrap_or(2881),
        "username": user, "password": required("PASSWORD"), "database": database,
        "default_schema": database, "url_params": url_params, "driver_profile": "oceanbase-oracle",
        "connect_timeout_secs": 10, "query_timeout_secs": 30, "keepalive_interval_secs": 0,
    })).unwrap();
    let mut reader = config.clone();
    reader.id = "bound-reader".into();
    state.configs.write().await.insert(config.id.clone(), config);
    state.configs.write().await.insert(reader.id.clone(), reader);
    let table = format!("DBX_BOUND_TXN_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]).to_uppercase();
    let manifest = serde_json::json!({"schema": database, "table": table, "rows": [1,2,3], "cleanupSql": format!("DROP TABLE {table} PURGE"), "status": "planned"});
    std::fs::write(evidence.join("fixture-manifest.json"), serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
    let mut created = false;
    let mut checks = Vec::<serde_json::Value>::new();
    let mut phase = "verify writer and independent reader identity before DDL";
    let outcome: Result<(), String> = async {
        for connection in ["bound-writer", "bound-reader"] {
            let identity = query(&state, connection, &database, "SELECT SYS_CONTEXT('USERENV','CON_NAME'), USER, SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL").await?;
            let row = identity.rows.first().ok_or("Connection identity query returned no row")?;
            if row.len() != 3 || row[0].as_str().is_none_or(|v| !v.eq_ignore_ascii_case("oracletest")) || row[1].as_str() != Some(database.as_str()) || row[2].as_str() != Some(database.as_str()) {
                return Err(format!("Refused fixture write: {connection} tenant/user/schema mismatch"));
            }
            checks.push(serde_json::json!({"phase": phase, "connection": connection, "identity": row}));
        }
        phase = "create fixture";
        query(&state, "bound-writer", &database, &format!("CREATE TABLE {table} (ID NUMBER PRIMARY KEY, VAL NUMBER NOT NULL, PAYLOAD BLOB)")).await?;
        created = true;
        for id in 1..=3 {
            query(&state, "bound-writer", &database, &format!("INSERT INTO {table} VALUES ({id}, 10, HEXTORAW('010203'))")).await?;
        }
        let select = format!("SELECT ID, VAL, RAWTOHEX(DBMS_LOB.SUBSTR(PAYLOAD, 3, 1)), DBMS_LOB.GETLENGTH(PAYLOAD) FROM {table} ORDER BY ID");
        let original = query(&state, "bound-reader", &database, &select).await?.rows;
        if original.len() != 3 { return Err("Fixture must contain exactly three committed rows".into()); }
        let make_bound = |id: i32, expected: &str, next: &str| dbx_core::types::BlobBoundStatement {
            preview_sql: format!("UPDATE {table} SET PAYLOAD = HEXTORAW('{next}') WHERE ID = {id};"),
            sql: format!("DECLARE n NUMBER; BEGIN UPDATE {table} SET PAYLOAD = ? WHERE ID = {id} AND DBMS_LOB.COMPARE(PAYLOAD, ?) = 0; n := SQL%ROWCOUNT; IF n <> 1 THEN RAISE_APPLICATION_ERROR(-20001, 'DBX bound stale row'); END IF; END;"),
            blob_parameters: vec![next.into(), expected.into()],
        };
        phase = "batch conflict preserves earlier transaction work";
        let session = begin_manual_transaction(&state, "bound-writer", &database, Some(&database), None).await?;
        execute_in_manual_transaction_with_options(&state, &session, &format!("UPDATE {table} SET VAL = 11 WHERE ID = 1"), &database, Some(&database), Default::default()).await?;
        let batch = vec![make_bound(2, "010203", "AABBCC"), make_bound(3, "FFFFFF", "DDEEFF")];
        let sql = batch.iter().map(|s| s.preview_sql.as_str()).collect::<Vec<_>>().join(";\n");
        let failure = execute_in_manual_transaction_with_options(&state, &session, &sql, &database, Some(&database), ManualTransactionExecutionOptions { bound_statements: Some(batch), timeout_secs: Some(30), ..Default::default() }).await;
        let error = failure.err().ok_or("The second bound statement must fail with stale row")?;
        if !error.contains("DBX bound stale row") || !state.transaction_sessions.read().await.contains_key(&session) {
            return Err(format!("Expected known stale conflict retaining original transaction: {error}"));
        }
        let same = execute_in_manual_transaction_with_options(&state, &session, &select, &database, Some(&database), Default::default()).await?;
        let mut expected = original.clone();
        expected[0][1] = serde_json::json!("11");
        let actual = &same.first().ok_or("Missing same-session SELECT result")?.result.rows;
        // Agent numeric cells may be represented as JSON strings or numbers.
        let normalize = |rows: &[Vec<serde_json::Value>]| rows.iter().map(|r| r.iter().map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())).collect::<Vec<_>>()).collect::<Vec<_>>();
        if normalize(actual) != normalize(&expected) { return Err("Savepoint rollback did not preserve batch-before VAL and restore batch BLOBs".into()); }
        if query(&state, "bound-reader", &database, &select).await?.rows != original { return Err("Independent reader saw uncommitted changes".into()); }
        checks.push(serde_json::json!({"phase": phase, "error": error, "sessionRetained": true, "sameSessionRows": actual, "independentRows": original}));
        phase = "user rollback after failed bound batch";
        rollback_manual_transaction(&state, &session).await?;
        if state.transaction_sessions.read().await.contains_key(&session) || query(&state, "bound-reader", &database, &select).await?.rows != original { return Err("User ROLLBACK did not restore all fixture values and remove session".into()); }
        checks.push(serde_json::json!({"phase": phase, "passed": true}));
        phase = "successful bound batch remains uncommitted";
        let session = begin_manual_transaction(&state, "bound-writer", &database, Some(&database), None).await?;
        let batch = vec![make_bound(2, "010203", "AABBCC"), make_bound(3, "010203", "DDEEFF")];
        let sql = batch.iter().map(|s| s.preview_sql.as_str()).collect::<Vec<_>>().join(";\n");
        execute_in_manual_transaction_with_options(&state, &session, &sql, &database, Some(&database), ManualTransactionExecutionOptions { bound_statements: Some(batch), timeout_secs: Some(30), ..Default::default() }).await?;
        let same = execute_in_manual_transaction_with_options(&state, &session, &select, &database, Some(&database), Default::default()).await?;
        let mut expected = original.clone();
        expected[1][2] = serde_json::json!("AABBCC");
        expected[2][2] = serde_json::json!("DDEEFF");
        let actual = &same.first().ok_or("Missing same-session SELECT result")?.result.rows;
        if normalize(actual) != normalize(&expected) || query(&state, "bound-reader", &database, &select).await?.rows != original { return Err("Successful bound batch committed or failed to update its own session".into()); }
        checks.push(serde_json::json!({"phase": phase, "sameSessionRows": actual, "independentRows": original}));
        phase = "user rollback after successful bound batch";
        rollback_manual_transaction(&state, &session).await?;
        if state.transaction_sessions.read().await.contains_key(&session) || query(&state, "bound-reader", &database, &select).await?.rows != original { return Err("User ROLLBACK after success did not fully restore fixture".into()); }
        checks.push(serde_json::json!({"phase": phase, "passed": true}));
        phase = "default pooled typed batch rolls back earlier writes on late conflict";
        let batch = vec![make_bound(2, "010203", "AABBCC"), make_bound(3, "FFFFFF", "DDEEFF")];
        let previews = batch.iter().map(|s| s.preview_sql.clone()).collect::<Vec<_>>();
        let error = execute_blob_bound_statements(&state, "bound-writer", &database, &previews, &batch, Some(&database), false, Some(30))
            .await.err().ok_or("Default pooled batch must reject the second stale target")?;
        if !error.contains("DBX bound stale row") || !error.contains("\"sessionDisposition\":\"keep\"") || query(&state, "bound-reader", &database, &select).await?.rows != original {
            return Err(format!("Default pooled typed batch left partial writes or lost known SQL classification: {error}"));
        }
        checks.push(serde_json::json!({"phase": phase, "error": error, "independentRows": original}));
        phase = "default pooled typed batch commits successful writes and restores auto-commit";
        let batch = vec![make_bound(2, "010203", "AABBCC"), make_bound(3, "010203", "DDEEFF")];
        let previews = batch.iter().map(|s| s.preview_sql.clone()).collect::<Vec<_>>();
        execute_blob_bound_statements(&state, "bound-writer", &database, &previews, &batch, Some(&database), false, Some(30)).await?;
        let mut committed = original.clone();
        committed[1][2] = serde_json::json!("AABBCC"); committed[2][2] = serde_json::json!("DDEEFF");
        if normalize(&query(&state, "bound-reader", &database, &select).await?.rows) != normalize(&committed) { return Err("Successful default typed batch did not commit its complete changes".into()); }
        query(&state, "bound-writer", &database, &format!("UPDATE {table} SET VAL = 12 WHERE ID = 1")).await?;
        committed[0][1] = serde_json::json!(12);
        if normalize(&query(&state, "bound-reader", &database, &select).await?.rows) != normalize(&committed) { return Err("Pooled connection auto-commit was not restored after typed batch".into()); }
        checks.push(serde_json::json!({"phase": phase, "independentRows": committed}));
        Ok(())
    }.await;
    let remaining: Vec<String> = state.transaction_sessions.read().await.keys().cloned().collect();
    let mut cleanup_errors = Vec::new();
    for session in remaining {
        if let Err(error) = rollback_manual_transaction(&state, &session).await {
            cleanup_errors.push(format!("Remaining transaction rollback unconfirmed: {error}"));
        }
    }
    if created {
        if let Err(error) = query(&state, "bound-writer", &database, &format!("DROP TABLE {table} PURGE")).await {
            cleanup_errors.push(format!("Fixture cleanup failed: {error}"));
        }
    }
    state.shutdown(Duration::from_secs(10)).await;
    let report = serde_json::json!({"test": "live_oceanbase_bound_manual_savepoint_and_user_rollback", "schema": database, "table": table, "phase": phase, "passed": outcome.is_ok() && cleanup_errors.is_empty(), "error": outcome.as_ref().err(), "checks": checks, "cleanupErrors": cleanup_errors});
    std::fs::write(evidence.join("core-live-result.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    assert!(cleanup_errors.is_empty(), "Cleanup unconfirmed; inspect evidence manifest: {cleanup_errors:?}");
    outcome.unwrap_or_else(|error| panic!("Bound manual transaction {phase}: {error}"));
}
