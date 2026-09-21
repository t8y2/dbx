//! Run explicitly with DBX_LIVE_SQL_FILE_OB_{HOST,USER,PASSWORD,DATABASE,AGENT_DIR}.
//! The agent directory must contain a compatible installed OceanBase Oracle driver and JRE.
use dbx_core::connection::AppState;
use dbx_core::data::sql_file_import::{execute_sql_file_content, execute_sql_file_paths};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{
    begin_manual_transaction, commit_manual_transaction, execute_sql_statement, rollback_manual_transaction,
};
use dbx_core::sql::{SqlFileRequest, SqlFileStatus};
use dbx_core::storage::Storage;
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
    let storage = Storage::open(&directory.path().join("state.db")).await.unwrap();
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
            database: database.clone(), file_path: String::new(), continue_on_error: false,
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
