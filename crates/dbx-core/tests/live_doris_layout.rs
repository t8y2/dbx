// Live coverage for Doris `SHOW PARTITIONS` parsing and per-partition bucket
// metadata. Defaults target the official all-in-one Docker fixture:
//
//   docker run -d --name doris -p 9030:9030 apache/doris:all-in-one-4.1.3
//   cargo test -p dbx-core --test live_doris_layout -- --ignored
//
// Override with DBX_TEST_DORIS_HOST / PORT / USER / PASSWORD.
use std::time::Duration;

use dbx_core::connection::{connect_bare_metadata_pool, AppState};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use mysql_async::prelude::Queryable;

fn live_doris_config(id: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_TEST_DORIS_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_TEST_DORIS_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(9030);
    let username = std::env::var("DBX_TEST_DORIS_USER").unwrap_or_else(|_| "root".to_string());
    let password = std::env::var("DBX_TEST_DORIS_PASSWORD").unwrap_or_default();

    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Doris,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": null,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live Doris config should deserialize")
}

#[tokio::test]
#[ignore = "requires DBX_TEST_DORIS_HOST/DBX_TEST_DORIS_PORT/DBX_TEST_DORIS_USER pointing at Doris 4.1+"]
async fn doris_show_partitions_returns_bucket_and_state_metadata() {
    let config = live_doris_config("doris-layout-live");
    let db = format!("dbx_layout_live_{}", uuid::Uuid::new_v4().simple());
    let pool = connect_bare_metadata_pool(&config, &config.host, config.port, Duration::from_secs(10), 3)
        .await
        .expect("connect bare Doris metadata pool");

    let mut conn = pool.get_conn().await.expect("get Doris connection");
    Queryable::query_drop(&mut conn, format!("CREATE DATABASE `{db}`").as_str()).await.expect("create test database");

    let setup = [
        format!(
            "CREATE TABLE `{db}`.`t_range` (\
                 `id` BIGINT NOT NULL, \
                 `dt` DATE NOT NULL, \
                 `amount` DECIMAL(18, 2) SUM \
             ) ENGINE=OLAP \
             AGGREGATE KEY(`id`, `dt`) \
             PARTITION BY RANGE(`dt`) \
             (PARTITION p202401 VALUES [('2024-01-01'), ('2024-02-01'))) \
             DISTRIBUTED BY HASH(`id`) BUCKETS 3 \
             PROPERTIES ('replication_num' = '1')"
        ),
        format!(
            "CREATE TABLE `{db}`.`t_list` (\
                 `id` BIGINT NOT NULL, \
                 `region` VARCHAR(32) NOT NULL \
             ) ENGINE=OLAP \
             UNIQUE KEY(`id`, `region`) \
             PARTITION BY LIST(`region`) \
             (PARTITION p_east VALUES IN (('east'))) \
             DISTRIBUTED BY HASH(`id`) BUCKETS 2 \
             PROPERTIES ('replication_num' = '1')"
        ),
        format!(
            "CREATE TABLE `{db}`.`t_unpartitioned` (\
                 `id` BIGINT NOT NULL \
             ) ENGINE=OLAP \
             DUPLICATE KEY(`id`) \
             DISTRIBUTED BY HASH(`id`) BUCKETS 2 \
             PROPERTIES ('replication_num' = '1')"
        ),
        format!(
            "CREATE TABLE `{db}`.`t_auto` (\
                 `id` BIGINT NOT NULL, \
                 `dt` DATE NOT NULL \
             ) ENGINE=OLAP \
             UNIQUE KEY(`id`, `dt`) \
             AUTO PARTITION BY RANGE(date_trunc(`dt`, 'month')) () \
             DISTRIBUTED BY HASH(`id`) BUCKETS AUTO \
             PROPERTIES ('replication_num' = '1')"
        ),
    ];
    for statement in setup {
        Queryable::query_drop(&mut conn, statement.as_str()).await.expect("create test table");
    }
    Queryable::query_drop(&mut conn, format!("INSERT INTO `{db}`.`t_auto` VALUES (1, '2024-01-15')").as_str())
        .await
        .expect("create an auto partition");
    drop(conn);

    let range = dbx_core::db::doris::list_table_partitions(&pool, &db, "t_range").await.expect("range partitions");
    assert_eq!(range.len(), 1, "range table should expose one explicit partition: {range:?}");
    assert_eq!(range[0].name, "p202401");
    assert_eq!(range[0].buckets, Some(3));
    assert_eq!(range[0].replication_num, Some(1));
    assert!(range[0].range.as_deref().is_some_and(|value| value.contains("2024-01-01")));

    let list = dbx_core::db::doris::list_table_partitions(&pool, &db, "t_list").await.expect("list partitions");
    assert_eq!(list.len(), 1, "list table should expose one explicit partition: {list:?}");
    assert_eq!(list[0].name, "p_east");
    assert_eq!(list[0].buckets, Some(2));

    let unpartitioned =
        dbx_core::db::doris::list_table_partitions(&pool, &db, "t_unpartitioned").await.expect("unpartitioned table");
    assert_eq!(unpartitioned.len(), 1, "unpartitioned Doris tables expose a synthetic full-table partition");
    assert_eq!(unpartitioned[0].buckets, Some(2));

    let auto = dbx_core::db::doris::list_table_partitions(&pool, &db, "t_auto").await.expect("auto partitions");
    assert!(!auto.is_empty(), "an inserted row should have created at least one auto partition: {auto:?}");
    assert!(
        auto.iter().all(|partition| partition.name.starts_with("p")),
        "auto partition names should be present: {auto:?}"
    );

    // Exercise the core dispatcher, not only the driver helper: this is the
    // path used by the Web/Tauri command and it must resolve the Doris profile
    // from the stored connection config.
    let state_path = std::env::temp_dir().join(format!("dbx-doris-layout-{}.db", uuid::Uuid::new_v4().simple()));
    let storage = dbx_core::persistence::test_storage::open(&state_path).await.expect("open temp storage");
    let state = AppState::new(storage);
    state.configs.write().await.insert(config.id.clone(), config.clone());
    let core = dbx_core::schema::list_doris_partitions_core(&state, &config.id, "", &db, "t_range", None)
        .await
        .expect("core Doris partitions");
    assert!(core.supported, "core should support an internal Doris table: {core:?}");
    assert_eq!(core.partitions.len(), 1);
    assert_eq!(core.partitions[0].buckets, Some(3));

    let mut conn = pool.get_conn().await.expect("get cleanup connection");
    Queryable::query_drop(&mut conn, format!("DROP DATABASE `{db}`").as_str()).await.expect("drop test database");
}
