//! Opt-in TiDB 4.0.11 index metadata regression for #14080.
//! Set `DBX_LIVE_TIDB_INDEXES_URL` to an isolated TiDB 4.0.11 server and run:
//! `cargo test -p dbx-driver-mysql --test live_tidb_index_metadata -- --ignored --nocapture`.
//! Creates only `dbx_issue14080.index_metadata_fixture`, retains it for inspection,
//! and never drops or alters an existing table. Do not point this at production.
use dbx_driver_mysql::mysql;
use mysql_async::prelude::Queryable;
use std::collections::BTreeMap;
use std::time::Duration;

const SCHEMA: &str = "dbx_issue14080";
const TABLE: &str = "index_metadata_fixture";

#[tokio::test]
#[ignore = "requires an isolated TiDB 4.0.11 server; creates and retains a task-specific fixture"]
async fn tidb_index_metadata_matches_show_index_and_survives_reload() {
    let url = std::env::var("DBX_LIVE_TIDB_INDEXES_URL").expect("set DBX_LIVE_TIDB_INDEXES_URL");
    let pool = mysql::connect(&url, Duration::from_secs(15)).await.unwrap();
    let mut conn = mysql::get_conn_with_health_check(&pool).await.unwrap();
    let version: String = conn.query_first("SELECT VERSION()").await.unwrap().unwrap();
    assert!(version.contains("TiDB-v4.0.11"), "this regression requires TiDB 4.0.11; got {version}");
    println!("server version: {version}");

    conn.query_drop("CREATE DATABASE IF NOT EXISTS dbx_issue14080").await.unwrap();
    conn.query_drop(
        "CREATE TABLE IF NOT EXISTS dbx_issue14080.index_metadata_fixture (
            id BIGINT NOT NULL PRIMARY KEY,
            code VARCHAR(32),
            tenant_id INT,
            `NULL` INT,
            ` leading` INT,
            KEY custom_code_lookup (code),
            UNIQUE KEY business_pair (tenant_id, code),
            KEY literal_null_name (`NULL`),
            KEY leading_space_name (` leading`)
        )",
    )
    .await
    .unwrap();

    let statistics: Vec<mysql_async::Row> = conn
        .query(
            "SELECT INDEX_NAME, COLUMN_NAME, EXPRESSION, SEQ_IN_INDEX,
                    EXPRESSION IS NULL AS expression_is_sql_null
             FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = 'dbx_issue14080' AND TABLE_NAME = 'index_metadata_fixture'
             ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        )
        .await
        .unwrap();
    println!("STATISTICS: {statistics:?}");
    assert_eq!(statistics.len(), 6);
    for row in &statistics {
        assert_eq!(row.get::<String, _>("EXPRESSION").as_deref(), Some("NULL"));
        assert_eq!(row.get::<i64, _>("expression_is_sql_null"), Some(0));
    }

    let show_rows: Vec<mysql_async::Row> =
        conn.query("SHOW INDEX FROM dbx_issue14080.index_metadata_fixture").await.unwrap();
    println!("SHOW INDEX: {show_rows:?}");
    let mut show_indexes = BTreeMap::<String, (bool, Vec<(u64, String)>)>::new();
    for row in &show_rows {
        let name: String = row.get("Key_name").unwrap();
        let unique = row.get::<u64, _>("Non_unique").unwrap() == 0;
        let sequence: u64 = row.get("Seq_in_index").unwrap();
        let column: String = row.get("Column_name").unwrap();
        let entry = show_indexes.entry(name).or_insert_with(|| (unique, Vec::new()));
        assert_eq!(entry.0, unique);
        entry.1.push((sequence, column));
    }
    for (_, columns) in show_indexes.values_mut() {
        columns.sort_by_key(|(sequence, _)| *sequence);
    }
    drop(conn);

    let indexes = mysql::list_indexes(&pool, SCHEMA, TABLE).await.unwrap();
    println!("DBX indexes: {}", serde_json::to_string_pretty(&indexes).unwrap());
    assert_eq!(indexes.len(), 5);
    for index in &indexes {
        let (unique, columns) = show_indexes.get(&index.name).expect("DBX preserved the server index name");
        let columns: Vec<_> = columns.iter().map(|(_, column)| column.clone()).collect();
        assert_eq!(index.columns, columns, "index {}", index.name);
        assert_eq!(index.is_unique, *unique, "index {}", index.name);
        assert_eq!(index.is_primary, index.name == "PRIMARY");
        assert_eq!(index.index_type.as_deref(), Some("BTREE"));
    }
    let expected = [
        ("PRIMARY", vec!["id"]),
        ("business_pair", vec!["tenant_id", "code"]),
        ("custom_code_lookup", vec!["code"]),
        ("leading_space_name", vec![" leading"]),
        ("literal_null_name", vec!["NULL"]),
    ];
    for (name, columns) in expected {
        let index = indexes.iter().find(|index| index.name == name).unwrap();
        assert_eq!(index.columns, columns, "index {name}");
    }
    let reloaded = mysql::list_indexes(&pool, SCHEMA, TABLE).await.unwrap();
    assert_eq!(serde_json::to_value(&indexes).unwrap(), serde_json::to_value(&reloaded).unwrap());
}
