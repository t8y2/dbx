use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::sql::SqlFileRequest;
use dbx_core::sql_file_import::execute_sql_file_content;
use dbx_core::storage::Storage;
use tokio_util::sync::CancellationToken;

fn live_mysql_sql_file_config(id: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_SQL_FILE_MYSQL_HOST").expect("DBX_LIVE_SQL_FILE_MYSQL_HOST");
    let port =
        std::env::var("DBX_LIVE_SQL_FILE_MYSQL_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(3306);
    let username = std::env::var("DBX_LIVE_SQL_FILE_MYSQL_USER").expect("DBX_LIVE_SQL_FILE_MYSQL_USER");
    let password = std::env::var("DBX_LIVE_SQL_FILE_MYSQL_PASSWORD").expect("DBX_LIVE_SQL_FILE_MYSQL_PASSWORD");

    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Mysql,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": null,
        "connect_timeout_secs": 5,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live MySQL SQL file config should deserialize")
}

async fn app_state_with_config(config: ConnectionConfig) -> (AppState, std::path::PathBuf) {
    let db_path = std::env::temp_dir().join(format!("dbx-live-sql-file-{}.db", uuid::Uuid::new_v4().simple()));
    let storage = Storage::open(&db_path).await.expect("open temp storage");
    let state = AppState::new(storage);
    state.configs.write().await.insert(config.id.clone(), config);
    (state, db_path)
}

#[tokio::test]
#[ignore = "requires the remote DBX MySQL 5.7 smoke-test container"]
async fn live_mysql57_text_protocol_select_succeeds() {
    let url = std::env::var("DBX_LIVE_MYSQL57_URL").expect("DBX_LIVE_MYSQL57_URL");

    let pool = dbx_core::db::mysql::connect(&url, std::time::Duration::from_secs(5)).await.unwrap();
    let result = dbx_core::db::mysql::execute_query_with_max_rows(
        &pool,
        "SELECT 1 AS id, CAST('mysql57' AS CHAR) AS label",
        false,
        Some(10),
        Default::default(),
    )
    .await
    .unwrap();

    assert_eq!(result.columns, vec!["id", "label"]);
    assert_eq!(result.rows, vec![vec![serde_json::json!("1"), serde_json::json!("mysql57")]]);
}

#[tokio::test]
#[ignore = "requires a remote MySQL-compatible endpoint with a limited result-set query"]
async fn live_mysql_compatible_limited_text_protocol_query_succeeds() {
    let url = std::env::var("DBX_LIVE_MYSQL_COMPAT_URL").expect("DBX_LIVE_MYSQL_COMPAT_URL");
    let sql = std::env::var("DBX_LIVE_MYSQL_COMPAT_SQL").expect("DBX_LIVE_MYSQL_COMPAT_SQL");

    let pool = dbx_core::db::mysql::connect(&url, std::time::Duration::from_secs(10)).await.unwrap();
    let result = dbx_core::db::mysql::execute_query_with_max_rows(&pool, &sql, false, Some(100), Default::default())
        .await
        .unwrap();

    assert!(!result.columns.is_empty());
    assert!(!result.rows.is_empty());
    assert!(result.rows.len() <= 100);
}

#[tokio::test]
#[ignore = "requires a remote MySQL endpoint"]
async fn live_mysql_call_procedure_returns_select_result_set() {
    let url = std::env::var("DBX_LIVE_MYSQL_PROCEDURE_URL").expect("DBX_LIVE_MYSQL_PROCEDURE_URL");

    let pool = dbx_core::db::mysql::connect(&url, std::time::Duration::from_secs(10)).await.unwrap();
    dbx_core::db::mysql::execute_query_with_max_rows(
        &pool,
        "DROP PROCEDURE IF EXISTS proc_test1",
        false,
        Some(10),
        Default::default(),
    )
    .await
    .unwrap();
    dbx_core::db::mysql::execute_query_with_max_rows(
        &pool,
        r#"
CREATE PROCEDURE proc_test1()
READS SQL DATA
BEGIN
    DROP TEMPORARY TABLE IF EXISTS tb_tmp_001;
    CREATE TEMPORARY TABLE tb_tmp_001(
        id INT,
        NAME VARCHAR(32) DEFAULT ''
    );
    INSERT INTO tb_tmp_001(id, NAME) VALUES(1, '测试数据001');
    SELECT * FROM tb_tmp_001;
END
"#,
        false,
        Some(10),
        Default::default(),
    )
    .await
    .unwrap();

    let result = dbx_core::db::mysql::execute_query_with_max_rows(
        &pool,
        "CALL proc_test1()",
        false,
        Some(10),
        Default::default(),
    )
    .await
    .unwrap();
    dbx_core::db::mysql::execute_query_with_max_rows(
        &pool,
        "DROP PROCEDURE IF EXISTS proc_test1",
        false,
        Some(10),
        Default::default(),
    )
    .await
    .unwrap();

    assert_eq!(result.columns, vec!["id", "NAME"]);
    assert_eq!(result.rows, vec![vec![serde_json::json!("1"), serde_json::json!("测试数据001")]]);
}

#[tokio::test]
#[ignore = "requires a remote OceanBase MySQL-compatible endpoint"]
async fn live_oceanbase_mysql_setup_applies_query_timeout() {
    let url = std::env::var("DBX_LIVE_OCEANBASE_MYSQL_URL").expect("DBX_LIVE_OCEANBASE_MYSQL_URL");
    let setup = vec!["SET ob_query_timeout = 30000000".to_string()];

    let pool = dbx_core::db::mysql::connect_bare_with_pool_limit_and_setup(
        &url,
        std::time::Duration::from_secs(10),
        1,
        &setup,
    )
    .await
    .unwrap();
    let result = dbx_core::db::mysql::execute_query_with_max_rows(
        &pool,
        "SELECT @@ob_query_timeout",
        true,
        Some(10),
        Default::default(),
    )
    .await
    .unwrap();

    assert_eq!(result.rows, vec![vec![serde_json::json!("30000000")]]);
}

#[tokio::test]
#[ignore = "requires a remote MySQL endpoint"]
async fn live_mysql_query_cancel_kills_running_sleep() {
    let url = std::env::var("DBX_LIVE_MYSQL_CANCEL_URL").expect("DBX_LIVE_MYSQL_CANCEL_URL");

    let opts = mysql_async::OptsBuilder::from_opts(mysql_async::Opts::from_url(&url).unwrap())
        .pool_opts(mysql_async::PoolOpts::new().with_constraints(mysql_async::PoolConstraints::new(1, 1).unwrap()));
    let pool = mysql_async::Pool::new(opts);
    let mut conn = dbx_core::db::mysql::get_conn_with_health_check(&pool).await.unwrap();
    let connection_id = mysql_async::Conn::id(&conn);
    let kill_opts = conn.opts().clone();

    let query = tokio::spawn(async move {
        dbx_core::db::mysql::execute_query_on_conn_with_max_rows(
            &mut conn,
            "SELECT SLEEP(30)",
            false,
            Some(10),
            Default::default(),
        )
        .await
    });

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    dbx_core::db::mysql::kill_query_with_opts(kill_opts, connection_id).await.unwrap();

    let started = std::time::Instant::now();
    let result = query.await.unwrap();

    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    let result = result.unwrap();
    assert_eq!(result.rows, vec![vec![serde_json::json!("1")]]);
}

#[tokio::test]
#[ignore = "requires a remote MySQL endpoint"]
async fn live_mysql_recovers_after_server_idle_disconnect() {
    let url = std::env::var("DBX_LIVE_MYSQL_IDLE_URL").expect("DBX_LIVE_MYSQL_IDLE_URL");

    let pool =
        dbx_core::db::mysql::connect_with_ca_cert_and_pool_limit(&url, None, std::time::Duration::from_secs(5), 1)
            .await
            .unwrap();

    dbx_core::db::mysql::execute_query_with_max_rows(
        &pool,
        "SET SESSION wait_timeout = 1",
        false,
        Some(10),
        Default::default(),
    )
    .await
    .unwrap();

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    let result = dbx_core::db::mysql::execute_query_with_max_rows(
        &pool,
        "SELECT 1 AS recovered",
        false,
        Some(10),
        Default::default(),
    )
    .await
    .unwrap();

    assert_eq!(result.columns, vec!["recovered"]);
    assert_eq!(result.rows, vec![vec![serde_json::json!("1")]]);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQL_FILE_MYSQL_* env vars pointing at a writable MySQL connection without a required default database"]
async fn live_sql_file_import_creates_database_and_switches_context_without_default_database() {
    let config = live_mysql_sql_file_config("sql-file-import");
    let (state, db_path) = app_state_with_config(config.clone()).await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let database_name = format!("dbx_issue_2356_{suffix}");
    let script = format!(
        r#"
CREATE DATABASE `{database_name}`;
USE `{database_name}`;
CREATE TABLE install_check (
    id INT PRIMARY KEY
);
INSERT INTO install_check (id) VALUES (1), (2);
"#
    );
    let request = SqlFileRequest {
        execution_id: format!("exec-{suffix}"),
        connection_id: config.id.clone(),
        database: String::new(),
        file_path: "issue-2356-mysql-install.sql".to_string(),
        continue_on_error: false,
    };

    let _ = execute_sql_statement(
        &state,
        &config.id,
        "",
        &format!("DROP DATABASE IF EXISTS `{database_name}`"),
        None,
        None,
    )
    .await;

    let result = execute_sql_file_content(
        &state,
        &request,
        &script,
        CancellationToken::new(),
        std::time::Instant::now(),
        |_| {},
    )
    .await;
    let verify = execute_sql_statement(
        &state,
        &config.id,
        &database_name,
        "SELECT COUNT(*) AS count FROM install_check",
        None,
        None,
    )
    .await;
    let _ = execute_sql_statement(
        &state,
        &config.id,
        "",
        &format!("DROP DATABASE IF EXISTS `{database_name}`"),
        None,
        None,
    )
    .await;
    let _ = std::fs::remove_file(db_path);

    result.expect("SQL file import should succeed");
    let verify = verify.expect("verify imported rows");
    assert_eq!(verify.columns, vec!["count"]);
    assert_eq!(verify.rows, vec![vec![serde_json::json!("2")]]);
}
