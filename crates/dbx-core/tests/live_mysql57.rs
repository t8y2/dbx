use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{execute_multi_core, execute_sql_statement};
use dbx_core::query_result_export::{export_query_result_core, ExportStatus, QueryResultExportRequest};
use dbx_core::sql::{split_sql_statements_for_database, SqlFileRequest};
use dbx_core::sql_file_import::execute_sql_file_path;
use dbx_core::storage::Storage;
use dbx_core::table_import::parse_xlsx_file;
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

fn live_mysql_query_export_config(
    id: &str,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
) -> ConnectionConfig {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Mysql,
        "host": host,
        "port": port,
        "username": user,
        "password": password,
        "database": database,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live MySQL query export config should deserialize")
}

fn json_cell_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
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
#[ignore = "requires a writable MySQL endpoint for query-result XLSX export"]
async fn live_mysql_query_result_export_xlsx_streams_single_query_without_duplicate_batches() {
    let host = std::env::var("DBX_LIVE_MYSQL_EXPORT_HOST").expect("DBX_LIVE_MYSQL_EXPORT_HOST");
    let port = std::env::var("DBX_LIVE_MYSQL_EXPORT_PORT").expect("DBX_LIVE_MYSQL_EXPORT_PORT").parse::<u16>().unwrap();
    let user = std::env::var("DBX_LIVE_MYSQL_EXPORT_USER").expect("DBX_LIVE_MYSQL_EXPORT_USER");
    let password = std::env::var("DBX_LIVE_MYSQL_EXPORT_PASSWORD").expect("DBX_LIVE_MYSQL_EXPORT_PASSWORD");
    let database = std::env::var("DBX_LIVE_MYSQL_EXPORT_DATABASE").expect("DBX_LIVE_MYSQL_EXPORT_DATABASE");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let table = format!("dbx_query_export_{}", &suffix[..8]);
    let connection_id = format!("live-mysql-query-export-{suffix}");
    let config = live_mysql_query_export_config(&connection_id, &host, port, &user, &password, &database);
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-query-export-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    state.configs.write().await.insert(config.id.clone(), config);

    let values = (1..=250).map(|id| format!("({id}, 'row-{id}')")).collect::<Vec<_>>().join(", ");
    let cleanup_sql = format!("DROP TABLE IF EXISTS `{table}`");
    let create_sql = format!("CREATE TABLE `{table}` (id INT PRIMARY KEY, label VARCHAR(32) NOT NULL)");
    let insert_sql = format!("INSERT INTO `{table}` (id, label) VALUES {values}");
    let _ = execute_sql_statement(&state, &connection_id, &database, &cleanup_sql, None, None).await;
    execute_sql_statement(&state, &connection_id, &database, &create_sql, None, None)
        .await
        .expect("create live export table");
    execute_sql_statement(&state, &connection_id, &database, &insert_sql, None, None)
        .await
        .expect("insert live export rows");

    let file_path = dir.join("result.xlsx");
    let sql = format!("SELECT id, label FROM `{table}`");
    let request = QueryResultExportRequest {
        export_id: format!("live-mysql-query-export-{suffix}"),
        connection_id: connection_id.clone(),
        database: database.clone(),
        schema: None,
        sql: sql.clone(),
        query_base_sql: sql,
        database_type: DatabaseType::Mysql,
        use_agent_cursor: false,
        file_path: file_path.to_string_lossy().to_string(),
        format: "xlsx".to_string(),
        include_sql_sheet: false,
        page_size: 50,
        row_limit: None,
        total_rows: Some(250),
        timeout_secs: Some(30),
        keyset_optimization_enabled: false,
        client_session_id: None,
        execution_id: Some(format!("live-mysql-query-export-{suffix}")),
        date_time_format: None,
    };
    let done_seen = AtomicBool::new(false);
    let result = export_query_result_core(&state, &request, None, |progress| {
        if matches!(progress.status, ExportStatus::Done) {
            done_seen.store(true, Ordering::Relaxed);
        }
    })
    .await;

    let cleanup_result = execute_sql_statement(&state, &connection_id, &database, &cleanup_sql, None, None).await;
    result.expect("export MySQL query result to XLSX");
    cleanup_result.expect("cleanup live export table");
    assert!(done_seen.load(Ordering::Relaxed));

    let parsed = parse_xlsx_file(&file_path.to_string_lossy(), 300).expect("parse exported XLSX");
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(parsed.columns, vec!["id", "label"]);
    assert_eq!(parsed.total_rows, 250);
    assert_eq!(parsed.rows.len(), 250);

    let exported_ids = parsed
        .rows
        .iter()
        .map(|row| json_cell_text(&row[0]).parse::<i64>().expect("numeric id"))
        .collect::<BTreeSet<_>>();
    let expected_ids = (1..=250).collect::<BTreeSet<_>>();
    assert_eq!(exported_ids, expected_ids);
}

#[tokio::test]
#[ignore = "requires a writable MySQL endpoint for a 650,000-row XLSX export"]
async fn live_mysql_xlsx_export_can_outlive_query_timeout_while_rows_keep_arriving() {
    let host = std::env::var("DBX_LIVE_MYSQL_EXPORT_HOST").expect("DBX_LIVE_MYSQL_EXPORT_HOST");
    let port = std::env::var("DBX_LIVE_MYSQL_EXPORT_PORT").expect("DBX_LIVE_MYSQL_EXPORT_PORT").parse::<u16>().unwrap();
    let user = std::env::var("DBX_LIVE_MYSQL_EXPORT_USER").expect("DBX_LIVE_MYSQL_EXPORT_USER");
    let password = std::env::var("DBX_LIVE_MYSQL_EXPORT_PASSWORD").expect("DBX_LIVE_MYSQL_EXPORT_PASSWORD");
    let database = std::env::var("DBX_LIVE_MYSQL_EXPORT_DATABASE").expect("DBX_LIVE_MYSQL_EXPORT_DATABASE");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let table = format!("dbx_query_export_timeout_{}", &suffix[..8]);
    let connection_id = format!("live-mysql-query-export-timeout-{suffix}");
    let config = live_mysql_query_export_config(&connection_id, &host, port, &user, &password, &database);
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-query-export-timeout-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    state.configs.write().await.insert(config.id.clone(), config);

    let values = (1..=807).map(|id| format!("({id}, 'row-{id}')")).collect::<Vec<_>>().join(", ");
    let cleanup_sql = format!("DROP TABLE IF EXISTS `{table}`");
    let create_sql = format!("CREATE TABLE `{table}` (id INT PRIMARY KEY, label VARCHAR(32) NOT NULL)");
    let insert_sql = format!("INSERT INTO `{table}` (id, label) VALUES {values}");
    let _ = execute_sql_statement(&state, &connection_id, &database, &cleanup_sql, None, None).await;
    execute_sql_statement(&state, &connection_id, &database, &create_sql, None, None)
        .await
        .expect("create live export timeout table");
    execute_sql_statement(&state, &connection_id, &database, &insert_sql, None, None)
        .await
        .expect("insert live export timeout rows");

    let file_path = dir.join("result.xlsx");
    let sql = format!(
        "SELECT a.id * 100000 + b.id AS id, CONCAT(a.label, '-', b.label) AS label \
         FROM `{table}` AS a CROSS JOIN `{table}` AS b LIMIT 650000"
    );
    let request = QueryResultExportRequest {
        export_id: format!("live-mysql-query-export-timeout-{suffix}"),
        connection_id: connection_id.clone(),
        database: database.clone(),
        schema: None,
        sql: sql.clone(),
        query_base_sql: sql,
        database_type: DatabaseType::Mysql,
        use_agent_cursor: false,
        file_path: file_path.to_string_lossy().to_string(),
        format: "xlsx".to_string(),
        include_sql_sheet: false,
        page_size: 10_000,
        row_limit: None,
        total_rows: Some(650_000),
        timeout_secs: Some(1),
        keyset_optimization_enabled: false,
        client_session_id: None,
        execution_id: Some(format!("live-mysql-query-export-timeout-{suffix}")),
        date_time_format: None,
    };
    let rows_exported = AtomicU64::new(0);
    let done_seen = AtomicBool::new(false);
    let started_at = Instant::now();
    let result = export_query_result_core(&state, &request, None, |progress| {
        rows_exported.store(progress.rows_exported, Ordering::Relaxed);
        if matches!(progress.status, ExportStatus::Done) {
            done_seen.store(true, Ordering::Relaxed);
        }
    })
    .await;
    let elapsed = started_at.elapsed();

    let cleanup_result = execute_sql_statement(&state, &connection_id, &database, &cleanup_sql, None, None).await;
    result.expect("stream 650,000 MySQL rows to XLSX");
    cleanup_result.expect("cleanup live export timeout table");
    assert!(elapsed > Duration::from_secs(1), "export should outlive configured timeout: {elapsed:?}");
    assert_eq!(rows_exported.load(Ordering::Relaxed), 650_000);
    assert!(done_seen.load(Ordering::Relaxed));
    assert!(std::fs::metadata(&file_path).unwrap().len() > 1_000_000);

    let _ = std::fs::remove_dir_all(dir);
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
#[ignore = "requires a remote writable MySQL endpoint"]
async fn live_mysql_splitter_executes_routine_without_delimiter() {
    let url = std::env::var("DBX_LIVE_MYSQL_PROCEDURE_URL").expect("DBX_LIVE_MYSQL_PROCEDURE_URL");
    let pool = dbx_core::db::mysql::connect(&url, std::time::Duration::from_secs(10)).await.unwrap();
    let procedure = "dbx_issue_2695_proc";

    let sql = format!(
        "\
DROP PROCEDURE IF EXISTS {procedure};
CREATE PROCEDURE {procedure}()
BEGIN
    SET @dbx_issue_2695_value = 2695;
    SELECT @dbx_issue_2695_value AS value;
END;
CALL {procedure}();
DROP PROCEDURE IF EXISTS {procedure};"
    );
    let statements = split_sql_statements_for_database(&sql, DatabaseType::Mysql);
    assert_eq!(statements.len(), 4);
    assert!(statements[1].contains("SET @dbx_issue_2695_value = 2695;"));
    assert!(statements[1].contains("SELECT @dbx_issue_2695_value AS value;"));
    assert!(statements[1].ends_with("END"));

    for statement in statements {
        dbx_core::db::mysql::execute_query_with_max_rows(&pool, &statement, false, Some(10), Default::default())
            .await
            .unwrap();
    }
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
async fn live_mysql_multi_statement_stops_after_first_error() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-multi-stop-{suffix}");
    let config = live_mysql_sql_file_config(&connection_id);
    let (state, db_path) = app_state_with_config(config.clone()).await;
    let database_name = format!("dbx_issue_2783_{suffix}");
    let table_name = "statement_order";
    let script = format!(
        "INSERT INTO `{table_name}` (id, label) VALUES (1, 'first');\n\
         INSERT INTO `{table_name}` (id, label) VALUES (1, 'duplicate');\n\
         INSERT INTO `{table_name}` (id, label) VALUES (2, 'must-not-run');"
    );

    let result = async {
        let _ = execute_sql_statement(
            &state,
            &config.id,
            "",
            &format!("DROP DATABASE IF EXISTS `{database_name}`"),
            None,
            None,
        )
        .await;
        execute_sql_statement(&state, &config.id, "", &format!("CREATE DATABASE `{database_name}`"), None, None)
            .await?;
        execute_sql_statement(
            &state,
            &config.id,
            &database_name,
            &format!("CREATE TABLE `{table_name}` (id INT PRIMARY KEY, label VARCHAR(32) NOT NULL)"),
            None,
            None,
        )
        .await?;

        let results = execute_multi_core(&state, &config.id, &database_name, &script, None, None).await?;
        let rows = execute_sql_statement(
            &state,
            &config.id,
            &database_name,
            &format!("SELECT id, label FROM `{table_name}` ORDER BY id"),
            None,
            None,
        )
        .await?;
        Ok::<_, String>((results, rows))
    }
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

    let (results, rows) = result.expect("multi-statement execution should return the first failure");
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].affected_rows, 1);
    assert_eq!(results[1].columns, vec!["Error"]);
    assert_eq!(rows.columns, vec!["id", "label"]);
    assert_eq!(rows.rows, vec![vec![serde_json::json!("1"), serde_json::json!("first")]]);
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
        file_path: std::env::temp_dir()
            .join(format!("issue-2356-mysql-install-{suffix}.sql"))
            .to_string_lossy()
            .into_owned(),
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

    tokio::fs::write(&request.file_path, &script).await.unwrap();
    let result = execute_sql_file_path(
        &state,
        &request,
        std::path::Path::new(&request.file_path),
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
    let _ = std::fs::remove_file(&request.file_path);

    result.expect("SQL file import should succeed");
    let verify = verify.expect("verify imported rows");
    assert_eq!(verify.columns, vec!["count"]);
    assert_eq!(verify.rows, vec![vec![serde_json::json!("2")]]);
}
