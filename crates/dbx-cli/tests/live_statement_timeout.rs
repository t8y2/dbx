//! Run with DBX_LIVE_TIMEOUT_MYSQL_* against an isolated MySQL database.
use std::{
    env,
    process::Command,
    time::{Duration, Instant},
};

use dbx_core::models::connection::ConnectionConfig;
use dbx_core::persistence::{secret_codec::SecretKeyPolicy, storage::Storage};
use serde_json::json;

#[tokio::test]
#[ignore = "requires DBX_LIVE_TIMEOUT_MYSQL_* scratch database"]
async fn local_cli_waits_for_the_write_and_exits_after_commit() {
    let get = |key: &str| env::var(key).unwrap_or_else(|_| panic!("{key} must be set"));
    let dir = tempfile::tempdir().unwrap();
    let storage = Storage::open_unmigrated(&dir.path().join("dbx.db"))
        .await
        .unwrap()
        .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id": "slow-write", "name": "slow-write", "db_type": "mysql",
        "host": get("DBX_LIVE_TIMEOUT_MYSQL_HOST"),
        "port": env::var("DBX_LIVE_TIMEOUT_MYSQL_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(3306),
        "username": get("DBX_LIVE_TIMEOUT_MYSQL_USER"),
        "password": env::var("DBX_LIVE_TIMEOUT_MYSQL_PASSWORD").unwrap_or_default(),
        "database": get("DBX_LIVE_TIMEOUT_MYSQL_DATABASE"),
        "query_timeout_secs": 1, "write_timeout_secs": 1, "keepalive_interval_secs": 0,
    })).unwrap();
    storage.save_connections(&[config]).await.unwrap();
    drop(storage);

    let query = |sql: &str| {
        let output = Command::new(env!("CARGO_BIN_EXE_dbx"))
            .env("DBX_DATA_DIR", dir.path())
            .env_remove("DBX_WEB_URL")
            .args(["query", "slow-write", sql, "--allow-writes", "--allow-dangerous-sql", "--json"])
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    let table =
        format!("dbx_cli_timeout_{}", dir.path().file_name().unwrap().to_string_lossy().replace(['.', '-'], ""));
    query(&format!("CREATE TABLE {table} (n int)"));
    let started = Instant::now();
    query(&format!("INSERT INTO {table} VALUES (SLEEP(2))"));
    assert!(started.elapsed() >= Duration::from_secs(2));
    // This is a fresh process and connection, after the writer has exited.
    let result = query(&format!("SELECT COUNT(*) AS committed_rows FROM {table}"));
    query(&format!("DROP TABLE {table}"));
    assert_eq!(result["rows"], json!([{"committed_rows": "1"}]));
}
