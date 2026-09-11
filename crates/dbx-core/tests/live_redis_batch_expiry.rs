use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::redis_ops::{
    redis_delete_keys_in_db_core, redis_get_ttl_in_db_core, redis_set_keys_expire_at_in_db_core,
    redis_set_keys_ttl_in_db_core, redis_set_string_in_db_core,
};
use dbx_core::storage::Storage;

/// Shared Redis fixtures used by the batch-expiration coverage below.
///
/// Run with a live server:
/// `DBX_LIVE_REDIS_HOST=... DBX_LIVE_REDIS_PORT=... DBX_LIVE_REDIS_PASSWORD=... \
///  cargo test -p dbx-core --test live_redis_batch_expiry -- --ignored --nocapture`
async fn live_state(connection_id: &str) -> Arc<AppState> {
    let host = std::env::var("DBX_LIVE_REDIS_HOST").expect("DBX_LIVE_REDIS_HOST");
    let port = std::env::var("DBX_LIVE_REDIS_PORT").expect("DBX_LIVE_REDIS_PORT").parse::<u16>().expect("Redis port");
    let username = std::env::var("DBX_LIVE_REDIS_USERNAME").unwrap_or_default();
    let password = std::env::var("DBX_LIVE_REDIS_PASSWORD").unwrap_or_default();
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let redis_config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": connection_id,
        "name": "Live batch expiry Redis",
        "db_type": DatabaseType::Redis,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": null,
        "connect_timeout_secs": 5,
        "query_timeout_secs": 5,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .unwrap();
    state.configs.write().await.insert(redis_config.id.clone(), redis_config.clone());
    state.get_or_create_pool(&redis_config.id, None).await.expect("open Redis connection");
    state
}

fn unique_prefix() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    format!("dbx_8899_{nanos}")
}

fn key_raws(prefix: &str) -> Vec<String> {
    // The browser always sends base64 key payloads, so the live test does too.
    (0..3)
        .map(|index| dbx_core::db::redis_driver::redis_key_bytes_to_raw(format!("{prefix}:{index}").as_bytes()))
        .collect()
}

async fn seed(state: &AppState, connection_id: &str, prefix: &str) -> Vec<String> {
    let raws = key_raws(prefix);
    for raw in &raws {
        redis_set_string_in_db_core(state, connection_id, 0, raw, "value", None).await.expect("seed Redis key");
    }
    raws
}

async fn ttls(state: &AppState, connection_id: &str, raws: &[String]) -> Vec<i64> {
    let mut values = Vec::new();
    for raw in raws {
        values.push(redis_get_ttl_in_db_core(state, connection_id, 0, raw).await.expect("read Redis TTL"));
    }
    values
}

async fn cleanup(state: &AppState, connection_id: &str, raws: &[String]) {
    let _ = redis_delete_keys_in_db_core(state, connection_id, 0, raws).await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_REDIS_HOST and DBX_LIVE_REDIS_PORT"]
async fn set_keys_ttl_expires_every_selected_key_on_a_live_server() {
    let connection_id = "live-redis-batch-ttl";
    let state = live_state(connection_id).await;
    let prefix = unique_prefix();
    let raws = seed(&state, connection_id, &prefix).await;

    let result = redis_set_keys_ttl_in_db_core(&state, connection_id, 0, &raws, 3_600).await.expect("apply batch TTL");
    assert_eq!(result.applied, 3);
    assert!(result.missing_key_raws.is_empty(), "unexpected misses: {:?}", result.missing_key_raws);

    for ttl in ttls(&state, connection_id, &raws).await {
        assert!((3_590..=3_600).contains(&ttl), "unexpected TTL {ttl}");
    }

    // A non-positive TTL keeps the single-key PERSIST convention.
    let persisted = redis_set_keys_ttl_in_db_core(&state, connection_id, 0, &raws, -1).await.expect("persist keys");
    assert_eq!(persisted.applied, 3);
    assert_eq!(ttls(&state, connection_id, &raws).await, vec![-1, -1, -1]);

    cleanup(&state, connection_id, &raws).await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_REDIS_HOST and DBX_LIVE_REDIS_PORT"]
async fn set_keys_expire_at_uses_one_absolute_deadline_on_a_live_server() {
    let connection_id = "live-redis-batch-expireat";
    let state = live_state(connection_id).await;
    let prefix = unique_prefix();
    let raws = seed(&state, connection_id, &prefix).await;

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    let expire_at = now + 7_200;
    let result = redis_set_keys_expire_at_in_db_core(&state, connection_id, 0, &raws, expire_at)
        .await
        .expect("apply batch EXPIREAT");
    assert_eq!(result.applied, 3);

    for ttl in ttls(&state, connection_id, &raws).await {
        // Every key shares the same deadline, minus the seconds the round trip took.
        assert!((7_190..=7_200).contains(&ttl), "unexpected absolute TTL {ttl}");
    }

    cleanup(&state, connection_id, &raws).await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_REDIS_HOST and DBX_LIVE_REDIS_PORT"]
async fn set_keys_ttl_reports_a_concurrently_deleted_key_without_failing_the_batch() {
    let connection_id = "live-redis-batch-partial";
    let state = live_state(connection_id).await;
    let prefix = unique_prefix();
    let mut raws = seed(&state, connection_id, &prefix).await;
    raws.push(dbx_core::db::redis_driver::redis_key_bytes_to_raw(format!("{prefix}:deleted").as_bytes()));

    let result =
        redis_set_keys_ttl_in_db_core(&state, connection_id, 0, &raws, 600).await.expect("apply partial batch TTL");

    assert_eq!(result.applied, 3);
    assert_eq!(result.missing_key_raws.len(), 1);
    assert_eq!(result.missing_key_raws[0], raws[3]);
    // The keys that did exist were still expired by the same request.
    for ttl in ttls(&state, connection_id, &raws[..3]).await {
        assert!((590..=600).contains(&ttl), "unexpected TTL {ttl}");
    }

    cleanup(&state, connection_id, &raws).await;
}
