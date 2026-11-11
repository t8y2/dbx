//! Regression coverage for #14735: a write statement whose last line ends with
//! a `--` or `#` comment, followed by `;` on the next line, must run as its own
//! statement when the editor pipelines adjacent writes into one MySQL packet.
//!
//! Run against a writable MySQL database:
//! `DBX_LIVE_TRAILING_COMMENT_MYSQL_HOST=... DBX_LIVE_TRAILING_COMMENT_MYSQL_USER=... \
//!  DBX_LIVE_TRAILING_COMMENT_MYSQL_PASSWORD=... DBX_LIVE_TRAILING_COMMENT_MYSQL_DATABASE=... \
//!  cargo test -p dbx-core --test live_mysql_trailing_line_comment -- --ignored`

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{
    execute_multi_core_with_options_for_client_typed, execute_sql_statement, ExecuteMultiResult, QueryExecutionOptions,
};
use std::sync::Arc;

const PREFIX: &str = "DBX_LIVE_TRAILING_COMMENT_MYSQL";

fn live_config() -> ConnectionConfig {
    serde_json::from_value(serde_json::json!({
        "id": format!("trailing-line-comment-{}", uuid::Uuid::new_v4().simple()),
        "name": "MySQL trailing line comment regression",
        "db_type": DatabaseType::Mysql,
        "host": std::env::var(format!("{PREFIX}_HOST")).expect("live database host"),
        "port": std::env::var(format!("{PREFIX}_PORT")).ok().and_then(|port| port.parse::<u16>().ok()).unwrap_or(3306),
        "username": std::env::var(format!("{PREFIX}_USER")).expect("live database user"),
        "password": std::env::var(format!("{PREFIX}_PASSWORD")).expect("live database password"),
        "database": std::env::var(format!("{PREFIX}_DATABASE")).expect("live database name"),
        "connect_timeout_secs": 5,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live connection configuration")
}

async fn run(state: &AppState, config: &ConnectionConfig, database: &str, sql: &str) {
    execute_sql_statement(state, &config.id, database, sql, None, None).await.expect("prepare regression table");
}

async fn run_editor_batch(
    state: &AppState,
    config: &ConnectionConfig,
    database: &str,
    sql: &str,
) -> Vec<ExecuteMultiResult> {
    execute_multi_core_with_options_for_client_typed(
        state,
        &config.id,
        database,
        sql,
        None,
        None,
        QueryExecutionOptions { client_session_id: Some(uuid::Uuid::new_v4().to_string()), ..Default::default() },
    )
    .await
    .expect("execute editor batch")
}

fn assert_all_succeeded(results: &[ExecuteMultiResult], expected_affected_rows: &[u64]) {
    let errors = results
        .iter()
        .filter(|result| result.execution_error)
        .map(|result| format!("{:?}", result.result.rows))
        .collect::<Vec<_>>();
    assert!(errors.is_empty(), "batch failed: {errors:?}");
    assert_eq!(results.iter().map(|result| result.result.affected_rows).collect::<Vec<_>>(), expected_affected_rows);
}

async fn row_count(state: &AppState, config: &ConnectionConfig, database: &str, table: &str) -> i64 {
    let result =
        execute_sql_statement(state, &config.id, database, &format!("SELECT COUNT(*) FROM {table}"), None, None)
            .await
            .expect("count rows");
    result.rows[0][0]
        .as_i64()
        .or_else(|| result.rows[0][0].as_str().and_then(|value| value.parse().ok()))
        .expect("integer row count")
}

#[tokio::test]
#[ignore = "requires a writable MySQL database"]
async fn pipelined_writes_keep_a_trailing_line_comment_out_of_the_next_statement() {
    let config = live_config();
    let database = config.database.clone().expect("database");
    let storage_path =
        std::env::temp_dir().join(format!("dbx-trailing-line-comment-{}.db", uuid::Uuid::new_v4().simple()));
    let state = Arc::new(AppState::new(
        dbx_core::persistence::test_storage::open(&storage_path).await.expect("temporary storage"),
    ));
    state.configs.write().await.insert(config.id.clone(), config.clone());
    let table = format!("dbx_issue_14735_{}", uuid::Uuid::new_v4().simple());
    run(&state, &config, &database, &format!("CREATE TABLE {table} (id BIGINT PRIMARY KEY, name VARCHAR(100))")).await;
    run(&state, &config, &database, &format!("INSERT INTO {table} (id, name) VALUES (1, '测试数据')")).await;

    // The script from the issue, with only the table name changed.
    let issue_script = format!(
        "INSERT INTO {table} (id)\nSELECT 1\nFROM {table} t\nWHERE 1 = 0   -- 进入来源\n;\n\n\
         INSERT INTO {table} (id)\nSELECT 1\nFROM {table} t\nWHERE 1 = 0;\n"
    );
    let issue_results = run_editor_batch(&state, &config, &database, &issue_script).await;

    // Writes that change rows prove each statement ran on its own, for both
    // MySQL line-comment styles.
    let writes = format!(
        "INSERT INTO {table} (id, name) VALUES (2, 'two') -- 第二筆\n;\n\
         UPDATE {table} SET name = 'one' WHERE id = 1 # hash comment\n;\n\
         INSERT INTO {table} (id, name) VALUES (3, 'three');\n"
    );
    let write_results = run_editor_batch(&state, &config, &database, &writes).await;
    let final_count = row_count(&state, &config, &database, &table).await;

    run(&state, &config, &database, &format!("DROP TABLE {table}")).await;
    let _ = std::fs::remove_file(storage_path);

    assert_all_succeeded(&issue_results, &[0, 0]);
    assert_all_succeeded(&write_results, &[1, 1, 1]);
    assert_eq!(final_count, 3);
}
