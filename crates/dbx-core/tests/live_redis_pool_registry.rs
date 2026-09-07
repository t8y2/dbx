use std::sync::Arc;
use std::time::Duration;

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::redis_ops::redis_execute_command_core;
use dbx_core::storage::Storage;

#[tokio::test]
#[ignore = "requires DBX_LIVE_REDIS_HOST and DBX_LIVE_REDIS_PORT"]
async fn blocking_redis_command_does_not_block_another_connection() {
    let host = std::env::var("DBX_LIVE_REDIS_HOST").expect("DBX_LIVE_REDIS_HOST");
    let port = std::env::var("DBX_LIVE_REDIS_PORT").expect("DBX_LIVE_REDIS_PORT").parse::<u16>().expect("Redis port");
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let redis_config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "live-redis-blocking",
        "name": "Live blocking Redis",
        "db_type": DatabaseType::Redis,
        "host": host,
        "port": port,
        "username": "",
        "password": "",
        "database": null,
        "connect_timeout_secs": 5,
        "query_timeout_secs": 5,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .unwrap();
    state.configs.write().await.insert(redis_config.id.clone(), redis_config.clone());
    state.get_or_create_pool(&redis_config.id, None).await.expect("open Redis connection");

    let redis_state = Arc::clone(&state);
    let redis_id = redis_config.id.clone();
    let blocking = tokio::spawn(async move {
        redis_execute_command_core(&redis_state, &redis_id, 0, "BLPOP dbx:issue:7720:missing 1", true).await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;

    let sqlite_path = directory.path().join("other-connection.db");
    std::fs::File::create(&sqlite_path).expect("create SQLite fixture");
    let sqlite_config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "other-connection",
        "name": "Other connection",
        "db_type": DatabaseType::Sqlite,
        "host": sqlite_path.to_string_lossy(),
        "port": 0,
        "username": "",
        "password": "",
        "database": null,
        "connect_timeout_secs": 5,
        "query_timeout_secs": 5,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .unwrap();
    state.configs.write().await.insert(sqlite_config.id.clone(), sqlite_config);
    let other_connection =
        tokio::time::timeout(Duration::from_millis(300), state.get_or_create_pool("other-connection", None)).await;

    assert!(other_connection.expect("other connection must not wait on Redis").is_ok());
    assert!(blocking.await.expect("Redis task join").is_ok());
}
