//! SELECT-only fixture regression for the production fixed-session MCP owner.
//! DBX_LIVE_MYSQL_DATA_CHARSET_URL points at the additive issue12458 fixtures.
//! Use the authorized local, direct plaintext MySQL fixture URL, with a database
//! containing legacy_long_keys and SELECT grants; TLS/tunnel/URL options are not
//! copied into this test's connection configs. DBX storage and its managed key
//! are isolated in a temporary directory; no OS keychain is required.
//! Rejected writes must produce a local policy error, not a MySQL grant error.
use dbx_core::{models::connection::ConnectionConfig, persistence::secret_codec::SecretKeyPolicy, storage::Storage};
use dbx_mcp::{transaction::TransactionState, DbxBackend, LocalBackend};
use serde_json::json;

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_DATA_CHARSET_URL and issue12458 legacy_long_keys fixture"]
async fn mysql_data_charset_fixed_owner_reads_and_enforces_immutable_policy() {
    let url = std::env::var("DBX_LIVE_MYSQL_DATA_CHARSET_URL").expect("set SELECT-only fixture URL");
    let opts = mysql_async::Opts::from_url(&url).unwrap();
    let database = opts.db_name().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let db_path = directory.path().join("dbx.db");
    let storage = Storage::open_with_secret_key_policy(&db_path, SecretKeyPolicy::ManagedDataDir).await.unwrap();
    let mut connections = Vec::new();
    for (id, charset) in [("legacy", Some("dataCharset=GBK")), ("default", None)] {
        let connection: ConnectionConfig = serde_json::from_value(json!({
            "id":id, "name":id, "db_type":"mysql", "host":opts.ip_or_hostname(), "port":opts.tcp_port(),
            "username":opts.user().unwrap_or(""), "password":opts.pass().unwrap_or(""), "database":database,
            "url_params":charset, "read_only":false, "keepalive_interval_secs":0,
            "connect_timeout_secs":5, "query_timeout_secs":30
        }))
        .unwrap();
        storage.add_connection_for_mcp(connection.clone()).await.unwrap();
        connections.push(connection);
    }
    drop(storage);
    let backend = LocalBackend::open(&db_path).await.unwrap();
    let legacy = backend.open_transaction_owner(&connections[0], database, "legacy-session").await.unwrap();
    let default = backend.open_transaction_owner(&connections[1], database, "default-session").await.unwrap();
    let query = "SELECT legacy_key,part FROM legacy_long_keys WHERE legacy_key=CONVERT(_binary 0xD6D0CEC4 USING latin1) ORDER BY part";
    let stored =
        "SELECT HEX(legacy_key),part,HEX(legacy_text),HEX(raw_blob) FROM legacy_long_keys ORDER BY legacy_key,part";
    let before = default.acquire().await.unwrap().query(stored, None).await.unwrap().result.rows;
    let original = default.acquire().await.unwrap().query(query, None).await.unwrap();
    assert_eq!(original.result.rows[0][0], "ÖÐÎÄ");
    assert!(original.result.raw_key_cells.is_empty());
    // The disabled mode still permits session SQL without changing database data.
    default.acquire().await.unwrap().query("SET @dbx_data_charset_probe=1", None).await.unwrap();
    legacy.acquire().await.unwrap().begin().await.unwrap();
    let decoded = legacy.acquire().await.unwrap().query(query, None).await.unwrap();
    assert_eq!(decoded.state, TransactionState::Active);
    assert_eq!(decoded.result.rows[0][0], "中文");
    assert_eq!(decoded.result.raw_key_cells[0].value, "ÖÐÎÄ");
    assert_eq!(decoded.result.raw_key_cells.len(), decoded.result.rows.len() * 2);

    // A live owner retains the pool codec even if the stored config changes.
    backend.state().configs.write().await.get_mut("legacy").unwrap().url_params = None;
    for sql in [
        "UPDATE legacy_long_keys SET legacy_text=legacy_text WHERE 1=0",
        "SET NAMES latin1",
        "SET @dbx_data_charset_probe=1",
    ] {
        let denied = legacy.acquire().await.unwrap().query(sql, None).await.unwrap_err();
        assert_eq!(denied.code, "TRANSACTION_SQL_BLOCKED");
        assert!(denied.message.contains("MYSQL_DATA_CHARSET"));
        assert_eq!(denied.mysql_code, None, "must reject before the database can enforce grants");
        assert_eq!(denied.state, TransactionState::Active, "local rejection preserves the physical transaction");
    }
    let batch = legacy
        .acquire()
        .await
        .unwrap()
        .batch(
            vec![query.into(), "UPDATE legacy_long_keys SET legacy_text=legacy_text WHERE 1=0".into(), query.into()],
            None,
            true,
        )
        .await;
    assert_eq!(batch.len(), 3);
    assert_eq!(batch[0].as_ref().unwrap().result.rows[0][0], "中文");
    assert_eq!(batch[1].as_ref().unwrap_err().code, "TRANSACTION_SQL_BLOCKED");
    assert_eq!(batch[2].as_ref().unwrap().result.rows[0][0], "中文");
    legacy.acquire().await.unwrap().commit().await.unwrap();
    legacy.acquire().await.unwrap().begin().await.unwrap();
    legacy.acquire().await.unwrap().rollback().await.unwrap();
    let after = default.acquire().await.unwrap().query(stored, None).await.unwrap().result.rows;
    assert_eq!(before, after);
    legacy.close().await.unwrap();
    default.close().await.unwrap();
}
