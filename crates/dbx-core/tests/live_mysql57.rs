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
