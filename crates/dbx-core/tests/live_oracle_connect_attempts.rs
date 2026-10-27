//! Live Oracle connection-attempt behaviour against a disposable test instance.
//!
//! These tests are `#[ignore]`d so CI never needs a database. Run them against a
//! test Oracle when touching connection-open/retry logic:
//!
//! ```bash
//! DBX_LIVE_ORACLE_HOST=127.0.0.1 \
//! DBX_LIVE_ORACLE_PORT=1521 \
//! DBX_LIVE_ORACLE_SERVICE=XEPDB1 \
//! DBX_LIVE_ORACLE_USER=dbx_test \
//! DBX_LIVE_ORACLE_PASSWORD=... \
//!   cargo test -p dbx-core --test live_oracle_connect_attempts -- --ignored --nocapture
//! ```
//!
//! `DBX_LIVE_ORACLE_CLOSED_PORT` (default `1`) should point at a port nothing
//! listens on; it is used to exercise the unreachable-listener path.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dbx_core::agent_connection::oracle_alternate_connect_configs;
use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::types::QueryResult;

fn required_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set for live Oracle tests"))
}

fn live_oracle_port() -> u16 {
    required_env("DBX_LIVE_ORACLE_PORT").parse().expect("DBX_LIVE_ORACLE_PORT must be a TCP port")
}

fn live_oracle_service() -> String {
    required_env("DBX_LIVE_ORACLE_SERVICE")
}

fn live_oracle_config(id: &str, port: u16, oracle_connection_type: Option<&str>) -> ConnectionConfig {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Oracle,
        "driver_profile": "oracle",
        "host": required_env("DBX_LIVE_ORACLE_HOST"),
        "port": port,
        "username": required_env("DBX_LIVE_ORACLE_USER"),
        "password": required_env("DBX_LIVE_ORACLE_PASSWORD"),
        "database": live_oracle_service(),
        "oracle_connection_type": oracle_connection_type,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 60,
        "idle_timeout_secs": 60,
        "idle_disconnect_secs": 0,
        "keepalive_interval_secs": 0
    }))
    .expect("live Oracle config should deserialize")
}

async fn app_state() -> Arc<AppState> {
    let dir = std::env::temp_dir().join(format!("dbx-live-oracle-attempts-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.expect("open test storage");
    Arc::new(AppState::new(storage))
}

fn single_int(result: &QueryResult) -> i64 {
    let cell = result.rows.first().and_then(|row| row.first()).expect("one row");
    match cell {
        serde_json::Value::Number(n) => n.as_i64().expect("integer"),
        serde_json::Value::String(s) => s.parse().expect("integer string"),
        other => panic!("unexpected cell {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_ORACLE_* env vars pointing at a disposable Oracle"]
async fn live_oracle_connects_and_runs_a_query() {
    let state = app_state().await;
    let (id, service) = ("live-oracle-connect", live_oracle_service());
    state.configs.write().await.insert(id.to_string(), live_oracle_config(id, live_oracle_port(), None));

    let started = Instant::now();
    let result = execute_sql_statement(&state, id, &service, "SELECT 1 AS N FROM DUAL", None, None)
        .await
        .unwrap_or_else(|error| panic!("live Oracle connect failed for {service}: {error}"));
    assert_eq!(single_int(&result), 1);
    eprintln!("live Oracle connect + query: {} ms", started.elapsed().as_millis());

    let banner =
        execute_sql_statement(&state, id, &service, "SELECT banner FROM v$version WHERE ROWNUM = 1", None, None)
            .await
            .expect("v$version query");
    let banner = banner.rows.first().and_then(|row| row.first()).cloned().unwrap_or_default();
    let banner = banner.as_str().unwrap_or_default();
    assert!(banner.contains("Oracle Database"), "unexpected v$version banner: {banner}");
    eprintln!("live Oracle banner: {banner}");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_ORACLE_* env vars pointing at a disposable Oracle"]
async fn live_oracle_unreachable_port_does_not_fan_out_descriptor_retries() {
    // A port with no listener is the case the Oracle descriptor fallback used to
    // turn into 1 + 4 TCP connection attempts. Every attempt is a new "connection"
    // for enterprise security/zero-trust clients in front of the database, which
    // pop one native warning each, so the live failure must stay a single attempt.
    let state = app_state().await;
    let closed_port =
        std::env::var("DBX_LIVE_ORACLE_CLOSED_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(1);
    let (id, service) = ("live-oracle-closed-port", live_oracle_service());
    let config = live_oracle_config(id, closed_port, None);
    state.configs.write().await.insert(id.to_string(), config.clone());

    let started = Instant::now();
    let error = execute_sql_statement(&state, id, &service, "SELECT 1 AS N FROM DUAL", None, None)
        .await
        .expect_err("closed port must fail to connect");
    let elapsed = started.elapsed();
    eprintln!("live Oracle unreachable port failed in {} ms: {error}", elapsed.as_millis());
    assert!(elapsed < Duration::from_secs(30), "unreachable port should fail fast, took {elapsed:?}");

    let alternates = oracle_alternate_connect_configs(&config, &error);
    assert!(
        alternates.is_empty(),
        "unreachable listener must not fan out into descriptor retries, got {} extra configs for: {error}",
        alternates.len()
    );
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_ORACLE_* env vars pointing at a disposable Oracle"]
async fn live_oracle_sid_form_falls_back_to_the_service_descriptor() {
    // A user who configured the SID form for a service-name database gets ORA-12505
    // from a listener that *is* reachable. The descriptor fallback must keep working
    // for that case (it is the one the popup-storm fix deliberately keeps), so the
    // alternate service-name URL has to connect and the retried statement succeed.
    let state = app_state().await;
    let (id, service) = ("live-oracle-sid-fallback", live_oracle_service());
    state.configs.write().await.insert(id.to_string(), live_oracle_config(id, live_oracle_port(), Some("sid")));

    let result = execute_sql_statement(&state, id, &service, "SELECT 1 AS N FROM DUAL", None, None)
        .await
        .unwrap_or_else(|error| panic!("SID->service descriptor fallback should connect: {error}"));
    assert_eq!(single_int(&result), 1);
    eprintln!("live Oracle SID-form fallback connected for service {service}");
}
