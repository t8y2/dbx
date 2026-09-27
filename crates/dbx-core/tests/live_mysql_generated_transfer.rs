//! Opt-in regression for MySQL tables whose columns are all generated (#10201).
//! Creates UUID-named databases and keeps all DBX state in a temporary directory.
use dbx_core::connection::AppState;
use dbx_core::db::mysql;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::storage::Storage;
use dbx_core::transfer::{transfer_table, TransferContent, TransferMode, TransferProgress, TransferRequest};
use futures::FutureExt;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

async fn run_transfer(
    state: &Arc<AppState>,
    request: &TransferRequest,
    source: &str,
    target: &str,
) -> Result<(u64, Vec<TransferProgress>), String> {
    let mut progress = Vec::new();
    let rows = transfer_table(
        state,
        request,
        "generated_only",
        0,
        &DatabaseType::Mysql,
        &DatabaseType::Mysql,
        source,
        target,
        &std::collections::HashMap::new(),
        &mut Vec::new(),
        None,
        |event| progress.push(event),
    )
    .await?;
    Ok((rows, progress))
}

async fn count(pool: &mysql::MySqlPool, database: &str) -> Result<u64, String> {
    let result =
        mysql::execute_query(pool, &format!("SELECT CAST(COUNT(*) AS CHAR) FROM `{database}`.generated_only"), false)
            .await?;
    result.rows[0][0].as_str().unwrap().parse::<u64>().map_err(|e| e.to_string())
}

#[test]
#[ignore = "requires disposable MySQL 8 via DBX_LIVE_MYSQL_TRANSFER_HOST/PORT/USER/PASSWORD"]
fn live_mysql_generated_only_transfer_modes_and_empty_source() {
    // The unoptimized driver/setup futures exceed the default test-thread stack.
    std::thread::Builder::new()
        .name("mysql-generated-transfer".into())
        .stack_size(8 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(run_mysql_generated_only_transfer());
        })
        .unwrap()
        .join()
        .unwrap();
}

async fn run_mysql_generated_only_transfer() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_db = format!("dbx_10201_src_{}", &suffix[..12]);
    let target_db = format!("dbx_10201_dst_{}", &suffix[..12]);
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id": "generated-transfer", "name": "generated-transfer", "db_type": "mysql",
        "host": std::env::var("DBX_LIVE_MYSQL_TRANSFER_HOST").expect("DBX_LIVE_MYSQL_TRANSFER_HOST"),
        "port": std::env::var("DBX_LIVE_MYSQL_TRANSFER_PORT").ok().and_then(|s| s.parse::<u16>().ok()).unwrap_or(3306),
        "username": std::env::var("DBX_LIVE_MYSQL_TRANSFER_USER").unwrap_or_else(|_| "root".into()),
        "password": std::env::var("DBX_LIVE_MYSQL_TRANSFER_PASSWORD").expect("DBX_LIVE_MYSQL_TRANSFER_PASSWORD"),
        "connect_timeout_secs": 10, "query_timeout_secs": 30, "keepalive_interval_secs": 0
    }))
    .unwrap();
    let url = format!("mysql://{}:{}@{}:{}", config.username, config.password, config.host, config.port);
    let pool = mysql::connect(&url, Duration::from_secs(10)).await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(&directory.path().join("state.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        directory.path().join("plugins"),
        directory.path().join("agents"),
        env!("CARGO_PKG_VERSION"),
    ));
    state.configs.write().await.insert(config.id.clone(), config);

    let outcome = std::panic::AssertUnwindSafe(async {
        mysql::execute_query(&pool, &format!(
            "CREATE DATABASE `{source_db}`; CREATE DATABASE `{target_db}`; \
             CREATE TABLE `{source_db}`.generated_only (constant_value INT AS (42) STORED, virtual_value INT AS (84) VIRTUAL); \
             INSERT INTO `{source_db}`.generated_only () VALUES (), (), ()"
        ), true).await?;
        let source = state.get_or_create_pool("generated-transfer", Some(&source_db)).await?;
        let target = state.get_or_create_pool("generated-transfer", Some(&target_db)).await?;
        let mut request: TransferRequest = serde_json::from_value(json!({
            "transferId": format!("generated-{suffix}"), "sourceConnectionId": "generated-transfer",
            "sourceDatabase": source_db, "sourceSchema": source_db,
            "targetConnectionId": "generated-transfer", "targetDatabase": target_db, "targetSchema": target_db,
            "tables": ["generated_only"], "createTable": true, "content": "structureOnly", "mode": "append", "batchSize": 2
        })).unwrap();

        // Structure-only must create both generated definitions without inserting data.
        assert_eq!(run_transfer(&state, &request, &source, &target).await?.0, 0);
        assert_eq!(count(&pool, &target_db).await?, 0);
        let ddl = mysql::execute_query(&pool, &format!("SHOW CREATE TABLE `{target_db}`.generated_only"), false).await?;
        let ddl = ddl.rows[0][1].as_str().unwrap();
        assert!(ddl.contains("STORED") && ddl.contains("VIRTUAL"), "{ddl}");

        request.content = TransferContent::DataOnly;
        request.create_table = false;
        dbx_core::transfer::set_cancelled(&request.transfer_id).await;
        let cancelled = run_transfer(&state, &request, &source, &target).await;
        dbx_core::transfer::clear_cancelled(&request.transfer_id).await;
        assert_eq!(cancelled.err().as_deref(), Some("Cancelled"));
        assert_eq!(count(&pool, &target_db).await?, 0);
        let (rows, progress) = run_transfer(&state, &request, &source, &target).await?;
        assert_eq!(rows, 3);
        assert!(progress.iter().any(|event| event.rows_transferred == 2));
        assert!(progress.iter().any(|event| event.rows_transferred == 3));
        assert_eq!(count(&pool, &target_db).await?, 3);
        run_transfer(&state, &request, &source, &target).await?;
        assert_eq!(count(&pool, &target_db).await?, 6);
        request.mode = TransferMode::Overwrite;
        assert_eq!(run_transfer(&state, &request, &source, &target).await?.0, 3);
        assert_eq!(count(&pool, &target_db).await?, 3);
        request.mode = TransferMode::Upsert; // Existing no-writable-PK fallback is append.
        assert_eq!(run_transfer(&state, &request, &source, &target).await?.0, 3);
        assert_eq!(count(&pool, &target_db).await?, 6);
        let values = mysql::execute_query(&pool, &format!("SELECT constant_value, virtual_value FROM `{target_db}`.generated_only"), false).await?;
        assert_eq!(values.rows, vec![vec![json!("42"), json!("84")]; 6]);

        // Fresh structure+data follows the same path.
        mysql::execute_query(&pool, &format!("DROP TABLE `{target_db}`.generated_only"), false).await?;
        request.create_table = true;
        request.content = TransferContent::StructureAndData;
        request.mode = TransferMode::Append;
        assert_eq!(run_transfer(&state, &request, &source, &target).await?.0, 3);
        assert_eq!(count(&pool, &target_db).await?, 3);

        mysql::execute_query(&pool, &format!("TRUNCATE TABLE `{source_db}`.generated_only"), false).await?;
        assert_eq!(run_transfer(&state, &request, &source, &target).await?.0, 0);
        assert_eq!(count(&pool, &target_db).await?, 3, "empty append must not invent a row");
        request.mode = TransferMode::Overwrite;
        assert_eq!(run_transfer(&state, &request, &source, &target).await?.0, 0);
        assert_eq!(count(&pool, &target_db).await?, 0);

        // An incompatible target must be rejected before destructive overwrite.
        mysql::execute_query(&pool, &format!(
            "DROP TABLE `{target_db}`.generated_only; \
             CREATE TABLE `{target_db}`.generated_only (constant_value INT DEFAULT 99); \
             INSERT INTO `{target_db}`.generated_only VALUES (123)"
        ), true).await?;
        request.create_table = false;
        request.content = TransferContent::DataOnly;
        let error = run_transfer(&state, &request, &source, &target).await.expect_err("ordinary target must fail");
        assert!(error.contains("must contain only generated columns"), "{error}");
        assert_eq!(count(&pool, &target_db).await?, 1);
        Ok::<(), String>(())
    }).catch_unwind().await;
    // Only this test's UUID-named databases are ever dropped.
    let cleanup = mysql::execute_query(
        &pool,
        &format!("DROP DATABASE IF EXISTS `{source_db}`; DROP DATABASE IF EXISTS `{target_db}`"),
        true,
    )
    .await;
    pool.disconnect().await.unwrap();
    outcome.unwrap().unwrap();
    cleanup.unwrap();
}
