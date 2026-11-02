use dbx_drivers::db::mysql;
use mysql_async::prelude::Queryable;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires DBX_LIVE_STARROCKS_URL for a remote StarRocks with the SET CastExpr failure"]
async fn live_starrocks_group_concat_setup_fallback() {
    let url = std::env::var("DBX_LIVE_STARROCKS_URL").expect("DBX_LIVE_STARROCKS_URL");
    let timeout = Duration::from_secs(15);
    let bare_pool = mysql::connect_bare(&url, timeout).await.expect("bare StarRocks connection");
    let mut bare_connection = bare_pool.get_conn().await.unwrap();
    let version: Option<String> = bare_connection.query_first("SELECT current_version()").await.unwrap();
    println!("StarRocks version: {version:?}");
    let error = bare_connection
        .query_drop(
            "SET SESSION group_concat_max_len = \
             cast(greatest(@@session.group_concat_max_len, 1048576) as unsigned)",
        )
        .await
        .expect_err("server must reproduce the reported initialization failure")
        .to_string();
    println!("Rejected built-in setup: {error}");
    assert!(error.contains("ERROR 1064 (HY000)"), "{error}");
    assert!(
        error.contains(
            "class com.starrocks.analysis.CastExpr cannot be cast to class com.starrocks.analysis.LiteralExpr"
        ),
        "{error}"
    );
    drop(bare_connection);
    bare_pool.disconnect().await.unwrap();

    let extra_setup = ["SET query_timeout = 42".to_string()];
    let pool = mysql::connect_with_ca_cert_pool_limit_idle_and_setup(&url, None, timeout, 2, None, &extra_setup)
        .await
        .expect("normal DBX connection must retry without its optional GROUP_CONCAT setup");
    let mut first_connection = pool.get_conn().await.unwrap();
    let mut second_connection = pool.get_conn().await.unwrap();
    for connection in [&mut first_connection, &mut second_connection] {
        let configured_timeout: Option<u64> = connection.query_first("SELECT @@query_timeout").await.unwrap();
        assert_eq!(configured_timeout, Some(42));
        let result: Option<u64> = connection.query_first("SELECT 1").await.unwrap();
        assert_eq!(result, Some(1));
        connection.query_drop("SHOW DATABASES").await.unwrap();
    }
    drop(first_connection);
    drop(second_connection);
    pool.disconnect().await.unwrap();

    let invalid_setup = ["SET dbx_nonexistent_setup_variable = 1".to_string()];
    let error = mysql::connect_with_ca_cert_pool_limit_idle_and_setup(&url, None, timeout, 2, None, &invalid_setup)
        .await
        .expect_err("invalid user setup must not be swallowed by the compatibility retry");
    assert!(error.contains("dbx_nonexistent_setup_variable"), "{error}");
}
