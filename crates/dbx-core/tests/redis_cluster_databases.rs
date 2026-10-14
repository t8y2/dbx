//! Opt-in acceptance tests for the disposable issue-1271 three-master fixtures.
//! No test starts servers or touches user DBX data. Three separately gated
//! tests flush fixture db1, disconnect exact test clients, or move one empty slot.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dbx_core::connection::{AppState, PoolKind};
use dbx_core::db::redis_driver::{
    cluster_any_connection_in_db, redis_key_bytes_to_raw, RedisClusterConnectionGuard, RedisCollectionPage,
    RedisConnection, RedisValueData,
};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::redis_ops::*;

const ID: &str = "issue-1271-core-live";
const PRIMARY: u16 = 17379;
const TAGS: [&str; 3] = ["dbx1271:delta", "dbx1271:alpha", "dbx1271:beta"];

struct Fixture {
    state: Arc<AppState>,
    // Drop state before removing its isolated metadata/plugin/agent directory.
    _directory: tempfile::TempDir,
    prefix: String,
}

impl Fixture {
    async fn open(port: u16, denied: bool) -> Self {
        assert_eq!(
            std::env::var("DBX_1271_CORE_FIXTURE").as_deref(),
            Ok("disposable-loopback"),
            "Only run against the task-owned disposable loopback fixtures"
        );
        assert!([PRIMARY, 17479, 18379].contains(&port));
        let directory = tempfile::tempdir().unwrap();
        let storage = dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            directory.path().join("plugins"),
            directory.path().join("agents"),
            "0.0.0-test",
        ));
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": ID, "name": "Disposable cluster database acceptance", "db_type": DatabaseType::Redis,
            "host": "127.0.0.1", "port": port,
            "username": if denied { "dbx1271-no-config" } else { "" },
            "password": if denied { "dbx1271-fixture-only" } else { "" },
            "database": null, "redis_connection_mode": "cluster",
            "redis_cluster_nodes": format!("127.0.0.1:{port},127.0.0.1:{},127.0.0.1:{}", port + 1, port + 2),
            "connect_timeout_secs": 5, "query_timeout_secs": 5,
            "idle_timeout_secs": 60, "keepalive_interval_secs": 0
        }))
        .unwrap();
        state.configs.write().await.insert(ID.to_string(), config);
        state.get_or_create_pool(ID, None).await.expect("connect disposable cluster through core");
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        Self { state, _directory: directory, prefix: format!("dbx1271-core-{}-{nanos}", std::process::id()) }
    }

    fn key(&self, tag: &str, kind: &str) -> String {
        format!("{}:{{{tag}}}:{kind}", self.prefix)
    }

    async fn set(&self, db: u32, key: &str, value: &str) {
        redis_set_string_in_db_core(&self.state, ID, db, &raw(key), value, None).await.unwrap();
    }

    async fn assert_string(&self, db: u32, key: &str, expected: &str) {
        let value = redis_get_value_in_db_core(&self.state, ID, db, &raw(key)).await.unwrap();
        match value.data {
            RedisValueData::String { content, .. } => assert_eq!(content.raw_base64, raw(expected)),
            other => panic!("expected string in db{db}, got {other:?}"),
        }
    }

    async fn cleanup(&self, keys: &[String]) {
        let raws: Vec<_> = keys.iter().map(|key| raw(key)).collect();
        for db in [0, 1] {
            redis_delete_keys_in_db_core(&self.state, ID, db, &raws).await.expect("remove only this run's keys");
        }
    }
}

fn raw(value: &str) -> String {
    redis_key_bytes_to_raw(value.as_bytes())
}

// Independent dedicated connections prove the core getter and setter did not
// both accidentally agree on the wrong DB. Never SELECT a shared core handle.
async fn assert_fresh_master_value(db: u32, key: &str, expected: Option<&str>) {
    let mut owners = 0;
    for port in PRIMARY..=PRIMARY + 2 {
        let client = redis::Client::open(format!("redis://127.0.0.1:{port}/{db}")).unwrap();
        let mut connection = client.get_multiplexed_async_connection().await.unwrap();
        let result: redis::RedisResult<Option<String>> = redis::cmd("GET").arg(key).query_async(&mut connection).await;
        match result {
            Ok(value) => {
                owners += 1;
                assert_eq!(value.as_deref(), expected, "fresh master {port}, db{db}, {key}");
            }
            Err(error) => assert_eq!(
                error.kind(),
                redis::ErrorKind::Server(redis::ServerErrorKind::Moved),
                "unexpected master error: {error}"
            ),
        }
    }
    assert_eq!(owners, 1, "exactly one master must own the key");
}

#[tokio::test]
#[ignore = "requires DBX_1271_CORE_FIXTURE=disposable-loopback and task Valkey 4-DB cluster"]
async fn core_cluster_database_operations_are_isolated_on_all_masters() {
    let fixture = Fixture::open(PRIMARY, false).await;
    let state = &fixture.state;
    let databases = redis_list_databases_core(state, ID).await.unwrap();
    assert_eq!(databases.iter().map(|item| item.db).collect::<Vec<_>>(), [0, 1, 2, 3]);
    assert_eq!(databases[2].keys, Some(0));
    assert_eq!(databases[3].keys, Some(0));
    let mut keys = Vec::new();
    let mut slot_ranges = BTreeSet::new();
    for tag in TAGS {
        let scalar = fixture.key(tag, "string");
        let slot = redis_execute_command_core(state, ID, 0, &format!("CLUSTER KEYSLOT {scalar}"), true)
            .await
            .unwrap()
            .value
            .as_u64()
            .expect("numeric hash slot");
        slot_ranges.insert(if slot <= 5460 {
            0
        } else if slot <= 10922 {
            1
        } else {
            2
        });
        fixture.set(0, &scalar, "db0-sentinel").await;
        fixture.set(1, &scalar, "db1-value").await;
        for _ in 0..5 {
            tokio::join!(
                fixture.assert_string(0, &scalar, "db0-sentinel"),
                fixture.assert_string(1, &scalar, "db1-value")
            );
        }
        assert_fresh_master_value(0, &scalar, Some("db0-sentinel")).await;
        assert_fresh_master_value(1, &scalar, Some("db1-value")).await;
        redis_set_ttl_in_db_core(state, ID, 1, &raw(&scalar), 3600).await.unwrap();
        assert!((3500..=3600).contains(&redis_get_ttl_in_db_core(state, ID, 1, &raw(&scalar)).await.unwrap()));
        assert_eq!(redis_get_ttl_in_db_core(state, ID, 0, &raw(&scalar)).await.unwrap(), -1);
        let renamed = fixture.key(tag, "renamed");
        redis_rename_key_in_db_core(state, ID, 1, &raw(&scalar), &raw(&renamed)).await.unwrap();
        fixture.assert_string(1, &renamed, "db1-value").await;
        fixture.assert_string(0, &scalar, "db0-sentinel").await;
        assert_fresh_master_value(1, &scalar, None).await;
        keys.extend([scalar, renamed]);

        for kind in ["hash", "list", "set", "zset", "stream"] {
            let key = fixture.key(tag, kind);
            for db in [0, 1] {
                let value = format!("db{db}-{kind}");
                let key_raw = raw(&key);
                match kind {
                    "hash" => redis_hash_set_in_db_core(state, ID, db, &key_raw, "field", &value, None).await.unwrap(),
                    "list" => redis_list_push_in_db_core(state, ID, db, &key_raw, &value, None, ListPushSide::Right)
                        .await
                        .unwrap(),
                    "set" => redis_set_add_in_db_core(state, ID, db, &key_raw, &value, None).await.unwrap(),
                    "zset" => redis_zadd_in_db_core(state, ID, db, &key_raw, &value, 1.0, None).await.unwrap(),
                    "stream" => redis_stream_add_in_db_core(
                        state,
                        ID,
                        db,
                        &key_raw,
                        "*",
                        vec![("field".into(), value.clone())],
                        None,
                    )
                    .await
                    .unwrap(),
                    _ => unreachable!(),
                }
                let result = redis_get_value_in_db_core(state, ID, db, &key_raw).await.unwrap();
                match result.data {
                    RedisValueData::Hash { items, .. } => assert_eq!(items[0].value.raw_base64, raw(&value)),
                    RedisValueData::List { items, .. } => assert_eq!(items[0].value.raw_base64, raw(&value)),
                    RedisValueData::Set { items, .. } => assert_eq!(items[0].member.raw_base64, raw(&value)),
                    RedisValueData::Zset { items, .. } => assert_eq!(items[0].member.raw_base64, raw(&value)),
                    RedisValueData::Stream { entries, .. } => assert_eq!(entries[0].fields[0].value, value),
                    other => panic!("unexpected {kind} response: {other:?}"),
                }
            }
            // Re-read db0 after the db1 write, rather than only before it.
            let db0 = redis_get_value_in_db_core(state, ID, 0, &raw(&key)).await.unwrap();
            let encoded = serde_json::to_string(&db0.data).unwrap();
            assert!(encoded.contains(&raw(&format!("db0-{kind}"))) || encoded.contains(&format!("db0-{kind}")));
            keys.push(key);
        }
    }
    assert_eq!(slot_ranges, BTreeSet::from([0, 1, 2]));
    for command in ["SELECT 1", "select 0", "\"SELECT\" 1"] {
        let error = redis_execute_command_core(state, ID, 1, command, true).await.unwrap_err();
        assert!(error.to_lowercase().contains("select"));
        assert!(error.to_lowercase().contains("picker"), "must explain safe database switching: {error}");
    }
    let raws: Vec<_> = keys.iter().map(|key| raw(key)).collect();
    assert_eq!(redis_delete_keys_in_db_core(state, ID, 1, &raws).await.unwrap(), 18);
    for tag in TAGS {
        assert_fresh_master_value(0, &fixture.key(tag, "string"), Some("db0-sentinel")).await;
        assert_fresh_master_value(1, &fixture.key(tag, "renamed"), None).await;
    }
    fixture.cleanup(&keys).await;
}

#[tokio::test]
#[ignore = "requires DBX_1271_CORE_FIXTURE=disposable-loopback and task Valkey 4-DB cluster"]
async fn core_cluster_scan_cursors_reject_other_databases_without_consuming_owner_cursor() {
    let fixture = Fixture::open(PRIMARY, false).await;
    let state = &fixture.state;
    let mut keys = Vec::new();
    for tag in TAGS {
        for index in 0..80 {
            let key = fixture.key(tag, &format!("scan-{index}"));
            fixture.set(0, &key, "db0-sentinel").await;
            fixture.set(1, &key, "db1-match").await;
            keys.push(key);
        }
    }
    let pattern = format!("{}:*", fixture.prefix);
    for value_scan in [false, true] {
        let first = if value_scan {
            redis_scan_values_core(state, ID, 1, 0, &pattern, "db1-match", false, 1).await.unwrap()
        } else {
            redis_scan_keys_core(state, ID, 1, 0, &pattern, 1).await.unwrap()
        };
        assert_ne!(first.cursor, 0, "fixture must exercise a continuation");
        let wrong = if value_scan {
            redis_scan_values_core(state, ID, 0, first.cursor, &pattern, "db1-match", false, 1).await
        } else {
            redis_scan_keys_core(state, ID, 0, first.cursor, &pattern, 1).await
        };
        assert!(wrong.is_err(), "cross-database cursor must fail closed");
        let mut cursor = first.cursor;
        let mut found: BTreeSet<_> = first.keys.into_iter().map(|item| item.key_raw).collect();
        for _ in 0..2000 {
            let page = if value_scan {
                redis_scan_values_core(state, ID, 1, cursor, &pattern, "db1-match", false, 20).await.unwrap()
            } else {
                redis_scan_keys_core(state, ID, 1, cursor, &pattern, 20).await.unwrap()
            };
            found.extend(page.keys.into_iter().map(|item| item.key_raw));
            cursor = page.cursor;
            if cursor == 0 {
                break;
            }
        }
        assert_eq!(cursor, 0, "bounded scan must terminate");
        assert_eq!(found, keys.iter().map(|key| raw(key)).collect());
    }
    fixture.cleanup(&keys).await;
}

#[tokio::test]
#[ignore = "requires DBX_1271_CORE_FIXTURE=disposable-loopback and task Valkey 4-DB cluster"]
async fn core_cluster_collection_cursor_is_database_scoped() {
    let fixture = Fixture::open(PRIMARY, false).await;
    let key = fixture.key(TAGS[0], "paged-hash");
    for db in [0, 1] {
        // 400 compact fields stay listpack-encoded in the stock fixture;
        // HSCAN returns a page larger than DBX's 200-item display limit.
        let mut command = format!("HSET {key}");
        for index in 0..400 {
            command.push_str(&format!(" f{index} db{db}-{index}"));
        }
        redis_execute_command_core(&fixture.state, ID, db, &command, true).await.unwrap();
    }
    let initial = redis_get_value_in_db_core(&fixture.state, ID, 1, &raw(&key)).await.unwrap();
    let (items, cursor) = match initial.data {
        RedisValueData::Hash { items, scan_cursor: Some(cursor), .. } => (items, cursor),
        other => panic!("fixture must produce a buffered hash continuation: {other:?}"),
    };
    assert_eq!(items.len(), 200);
    let wrong = redis_load_more_in_db_core(&fixture.state, ID, 0, &raw(&key), "hash", cursor, 200, None, None).await;
    assert!(wrong.is_err(), "db0 must not consume db1 buffered hash data");
    let other_id = "issue-1271-other-core-connection";
    let mut other_config = fixture.state.configs.read().await.get(ID).unwrap().clone();
    other_config.id = other_id.to_string();
    fixture.state.configs.write().await.insert(other_id.to_string(), other_config);
    fixture.state.get_or_create_pool(other_id, None).await.unwrap();
    let wrong_connection =
        redis_load_more_in_db_core(&fixture.state, other_id, 1, &raw(&key), "hash", cursor, 200, None, None).await;
    assert!(wrong_connection.is_err(), "another connection must not consume the owner cursor");
    let page =
        redis_load_more_in_db_core(&fixture.state, ID, 1, &raw(&key), "hash", cursor, 200, None, None).await.unwrap();
    match page {
        RedisCollectionPage::Hash { items: more, .. } => {
            let found: BTreeSet<_> = items.into_iter().chain(more).map(|item| item.value.raw_base64).collect();
            let expected: BTreeSet<_> = (0..400).map(|index| raw(&format!("db1-{index}"))).collect();
            assert_eq!(found, expected);
        }
        other => panic!("expected hash continuation: {other:?}"),
    }
    fixture.cleanup(&[key]).await;
}

#[tokio::test]
#[ignore = "requires DBX_1271_CORE_FIXTURE=disposable-loopback and all task control clusters"]
async fn core_cluster_capability_controls_and_config_denial_remain_usable() {
    for port in [17479, 18379] {
        let fixture = Fixture::open(port, false).await;
        let databases = redis_list_databases_core(&fixture.state, ID).await.unwrap();
        assert_eq!(databases.iter().map(|item| item.db).collect::<Vec<_>>(), [0]);
        let key = fixture.key(TAGS[0], "control");
        fixture.set(0, &key, "control-db0").await;
        fixture.assert_string(0, &key, "control-db0").await;
        assert!(redis_get_value_in_db_core(&fixture.state, ID, 1, &raw(&key)).await.is_err());
        redis_delete_key_in_db_core(&fixture.state, ID, 0, &raw(&key)).await.unwrap();
    }
    let fixture = Fixture::open(PRIMARY, true).await;
    let databases = redis_list_databases_core(&fixture.state, ID).await.unwrap();
    assert_eq!(databases.iter().map(|item| item.db).collect::<Vec<_>>(), [0]);
    let key = fixture.key(TAGS[0], "acl");
    fixture.set(0, &key, "acl-db0").await;
    fixture.assert_string(0, &key, "acl-db0").await;
    let error = redis_get_value_in_db_core(&fixture.state, ID, 1, &raw(&key)).await.unwrap_err();
    assert!(error.to_uppercase().contains("CONFIG"), "actionable capability error required: {error}");
    redis_delete_key_in_db_core(&fixture.state, ID, 0, &raw(&key)).await.unwrap();
}

#[tokio::test]
#[ignore = "DESTRUCTIVE: also requires DBX_1271_ALLOW_FLUSH=task-primary-db1"]
async fn core_cluster_flush_db1_preserves_db0_on_every_master() {
    assert_eq!(std::env::var("DBX_1271_ALLOW_FLUSH").as_deref(), Ok("task-primary-db1"));
    let fixture = Fixture::open(PRIMARY, false).await;
    let mut keys = Vec::new();
    for tag in TAGS {
        let key = fixture.key(tag, "flush");
        fixture.set(0, &key, "db0-flush-sentinel").await;
        fixture.set(1, &key, "db1-flush-target").await;
        keys.push(key);
    }
    redis_flush_db_core(&fixture.state, ID, 1).await.unwrap();
    for key in &keys {
        fixture.assert_string(0, key, "db0-flush-sentinel").await;
        assert_fresh_master_value(0, key, Some("db0-flush-sentinel")).await;
        assert_fresh_master_value(1, key, None).await;
    }
    fixture.cleanup(&keys).await;
}

fn client_field<'a>(info: &'a str, field: &str) -> &'a str {
    info.split_whitespace()
        .filter_map(|item| item.split_once('='))
        .find_map(|(key, value)| (key == field).then_some(value))
        .unwrap_or_else(|| panic!("CLIENT INFO omitted {field}: {info}"))
}

fn node_route(port: u16) -> redis::cluster_routing::RoutingInfo {
    redis::cluster_routing::RoutingInfo::SingleNode(redis::cluster_routing::SingleNodeRoutingInfo::ByAddress {
        host: "127.0.0.1".to_string(),
        port,
    })
}

#[tokio::test]
#[ignore = "DISCONNECTS EXACT TEST CLIENTS: also requires DBX_1271_ALLOW_RECONNECT=exact-test-clients"]
async fn core_cluster_db1_reconnect_restores_database_on_every_master() {
    assert_eq!(std::env::var("DBX_1271_ALLOW_RECONNECT").as_deref(), Ok("exact-test-clients"));
    let fixture = Fixture::open(PRIMARY, false).await;
    let mut keys = Vec::new();
    for tag in TAGS {
        let key = fixture.key(tag, "reconnect");
        fixture.set(0, &key, "db0-reconnect-sentinel").await;
        fixture.set(1, &key, "db1-reconnect-value").await;
        keys.push(key);
    }
    let pool = fixture.state.pool_handle(ID).await.unwrap();
    let PoolKind::Redis(redis) = &pool else { panic!("expected Redis core pool") };
    let RedisConnection::Cluster(cluster) = redis.as_ref() else { panic!("expected native cluster") };
    let mut connection = match cluster_any_connection_in_db(cluster, 1).await.unwrap() {
        RedisClusterConnectionGuard::Database(connection) => connection,
        _ => panic!("db1 must use the core pool's database-fixed native cluster handle"),
    };
    let name = format!("{}-reconnect-client", fixture.prefix);
    let mut clients = Vec::new();
    for port in PRIMARY..=PRIMARY + 2 {
        connection
            .route_command(redis::cmd("CLIENT").arg("SETNAME").arg(&name).clone(), node_route(port))
            .await
            .unwrap();
        let info: String = redis::from_redis_value(
            connection.route_command(redis::cmd("CLIENT").arg("INFO").clone(), node_route(port)).await.unwrap(),
        )
        .unwrap();
        assert_eq!(client_field(&info, "name"), name);
        assert_eq!(client_field(&info, "db"), "1");
        let id = client_field(&info, "id").parse::<u64>().unwrap();
        assert!(id > 0);
        clients.push((port, id));
        println!("before-reconnect port={port} id={id} db=1 name={name}");
    }
    // Do not kill by address, type, database, or name. Recheck every exact ID
    // immediately before killing; no unrelated app/client can enter this set.
    for &(port, id) in &clients {
        let client = redis::Client::open(format!("redis://127.0.0.1:{port}/0")).unwrap();
        let mut admin = client.get_multiplexed_async_connection().await.unwrap();
        let list: String = redis::cmd("CLIENT").arg("LIST").arg("ID").arg(id).query_async(&mut admin).await.unwrap();
        assert_eq!(list.lines().count(), 1, "exact client must still exist");
        assert_eq!(client_field(&list, "name"), name, "refusing to kill non-test client");
        assert_eq!(client_field(&list, "id"), id.to_string());
        assert_eq!(client_field(&list, "db"), "1");
        let killed: u64 = redis::cmd("CLIENT").arg("KILL").arg("ID").arg(id).query_async(&mut admin).await.unwrap();
        assert_eq!(killed, 1);
        println!("exact-test-client-killed port={port} id={id}");
    }
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        for &(port, old_id) in &clients {
            let info: String = loop {
                match connection.route_command(redis::cmd("CLIENT").arg("INFO").clone(), node_route(port)).await {
                    Ok(value) => break redis::from_redis_value(value).unwrap(),
                    Err(_) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
                }
            };
            let new_id = client_field(&info, "id").parse::<u64>().unwrap();
            assert_ne!(new_id, old_id);
            assert_eq!(client_field(&info, "db"), "1", "new node connection must restore db1");
            println!("after-reconnect port={port} old_id={old_id} new_id={new_id} db=1");
        }
        for key in &keys {
            tokio::join!(
                fixture.assert_string(0, key, "db0-reconnect-sentinel"),
                fixture.assert_string(1, key, "db1-reconnect-value")
            );
            assert_fresh_master_value(0, key, Some("db0-reconnect-sentinel")).await;
            assert_fresh_master_value(1, key, Some("db1-reconnect-value")).await;
        }
    })
    .await
    .expect("database-fixed core handles must recover within 30 seconds");
    fixture.cleanup(&keys).await;
}

type Admins = Vec<(u16, redis::aio::MultiplexedConnection)>;
type SlotMap = Vec<(u16, u16, String)>;

async fn topology_snapshot(admin: &mut redis::aio::MultiplexedConnection) -> Result<SlotMap, String> {
    let info: String = redis::cmd("CLUSTER").arg("INFO").query_async(admin).await.map_err(|e| e.to_string())?;
    for expected in ["cluster_state:ok", "cluster_slots_assigned:16384", "cluster_slots_ok:16384"] {
        if !info.lines().any(|line| line.trim() == expected) {
            return Err(format!("cluster not healthy: missing {expected}; {info}"));
        }
    }
    let nodes: String = redis::cmd("CLUSTER").arg("NODES").query_async(admin).await.map_err(|e| e.to_string())?;
    if nodes.lines().any(|line| line.split_whitespace().skip(8).any(|field| field.starts_with('['))) {
        return Err("cluster has migrating/importing slots".to_string());
    }
    let rows: Vec<Vec<redis::Value>> =
        redis::cmd("CLUSTER").arg("SLOTS").query_async(admin).await.map_err(|e| e.to_string())?;
    let mut slots = Vec::new();
    for row in rows {
        let [start, end, master, ..] = row.as_slice() else { return Err("malformed CLUSTER SLOTS".into()) };
        let start: u16 = redis::from_redis_value(start.clone()).map_err(|e| e.to_string())?;
        let end: u16 = redis::from_redis_value(end.clone()).map_err(|e| e.to_string())?;
        let master: Vec<redis::Value> = redis::from_redis_value(master.clone()).map_err(|e| e.to_string())?;
        let id: String =
            redis::from_redis_value(master.get(2).ok_or("master ID missing")?.clone()).map_err(|e| e.to_string())?;
        slots.push((start, end, id));
    }
    slots.sort_by_key(|row| row.0);
    let mut next = 0_u32;
    for (start, end, _) in &slots {
        if u32::from(*start) != next || end < start {
            return Err("slot map has a gap or overlap".into());
        }
        next = u32::from(*end) + 1;
    }
    if next != 16384 {
        return Err(format!("expected all16384 slots, got {next}"));
    }
    Ok(slots)
}

fn slot_owner(slots: &SlotMap, slot: u16) -> Result<&str, String> {
    slots
        .iter()
        .find(|(start, end, _)| *start <= slot && slot <= *end)
        .map(|(_, _, id)| id.as_str())
        .ok_or_else(|| format!("no owner for slot {slot}"))
}

async fn wait_for_owner(admins: &mut Admins, slot: u16, owner: &str) -> Result<(), String> {
    let mut last = String::new();
    for _ in 0..50 {
        let mut ready = true;
        for (port, admin) in admins.iter_mut() {
            match topology_snapshot(admin).await {
                Ok(slots) if slot_owner(&slots, slot)? == owner => {}
                Ok(_) => {
                    ready = false;
                    last = format!("port {port} has a different owner");
                }
                Err(error) => {
                    ready = false;
                    last = format!("port {port}: {error}");
                }
            }
        }
        if ready {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err(format!("slot {slot} did not converge to {owner}: {last}"))
}

async fn slot_is_empty_everywhere(admins: &mut Admins, slot: u16) -> Result<bool, String> {
    let mut empty = true;
    for (port, admin) in admins.iter_mut() {
        for db in 0..4 {
            redis::cmd("SELECT").arg(db).query_async::<()>(admin).await.map_err(|e| e.to_string())?;
            let mut cursor = 0_u64;
            let mut completed = false;
            for _ in 0..10_000 {
                let (next, keys): (u64, Vec<Vec<u8>>) = redis::cmd("SCAN")
                    .arg(cursor)
                    .arg("COUNT")
                    .arg(1000)
                    .query_async(admin)
                    .await
                    .map_err(|e| e.to_string())?;
                for key in keys {
                    let key_slot: u16 = redis::cmd("CLUSTER")
                        .arg("KEYSLOT")
                        .arg(key)
                        .query_async(admin)
                        .await
                        .map_err(|e| e.to_string())?;
                    if key_slot == slot {
                        empty = false;
                    }
                }
                cursor = next;
                if cursor == 0 {
                    completed = true;
                    break;
                }
            }
            if !completed {
                return Err(format!("bounded full SCAN did not complete on {port} db{db}"));
            }
        }
    }
    Ok(empty)
}

async fn assign_empty_slot(admins: &mut Admins, slot: u16, owner: &str) -> Result<(), String> {
    // Attempt every node even when one fails, so restoration is not abandoned
    // after a partial update. Caller always checks consensus afterward.
    let mut errors = Vec::new();
    for (port, admin) in admins.iter_mut() {
        if let Err(error) =
            redis::cmd("CLUSTER").arg("SETSLOT").arg(slot).arg("NODE").arg(owner).query_async::<()>(admin).await
        {
            errors.push(format!("{port}: {error}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("slot {slot} -> {owner}: {}", errors.join("; ")))
    }
}

async fn delete_slot_test_keys(admins: &mut Admins, keys: &[String]) -> Result<(), String> {
    let mut errors = Vec::new();
    for (port, admin) in admins.iter_mut() {
        for db in [0, 1] {
            if let Err(error) = redis::cmd("SELECT").arg(db).query_async::<()>(admin).await {
                errors.push(format!("{port} db{db} SELECT: {error}"));
                continue;
            }
            for key in keys {
                match redis::cmd("DEL").arg(key).query_async::<u64>(admin).await {
                    Ok(_) => {}
                    Err(error) if error.kind() == redis::ErrorKind::Server(redis::ServerErrorKind::Moved) => {}
                    Err(error) => errors.push(format!("{port} db{db} exact key {key}: {error}")),
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

async fn assert_topology_core_values(fixture: &Fixture, keys: &[String]) -> Result<(), String> {
    for key in keys {
        for db in [0, 1] {
            let expected = format!("db{db}-slot-value");
            redis_set_string_in_db_core(&fixture.state, ID, db, &raw(key), &expected, None).await?;
            let result = redis_get_value_in_db_core(&fixture.state, ID, db, &raw(key)).await?;
            match result.data {
                RedisValueData::String { content, .. } if content.raw_base64 == raw(&expected) => {}
                other => return Err(format!("wrong slot value in db{db}: {other:?}")),
            }
        }
        // Re-read db0 after db1 writes to detect shared-selection corruption.
        let result = redis_get_value_in_db_core(&fixture.state, ID, 0, &raw(key)).await?;
        match result.data {
            RedisValueData::String { content, .. } if content.raw_base64 == raw("db0-slot-value") => {}
            other => return Err(format!("db1 write changed db0: {other:?}")),
        }
    }
    Ok(())
}

async fn assert_topology_direct_values(admins: &mut Admins, keys: &[String], owner_port: u16) -> Result<(), String> {
    let (_, admin) = admins.iter_mut().find(|(port, _)| *port == owner_port).ok_or("owner admin missing")?;
    for db in [0, 1] {
        redis::cmd("SELECT").arg(db).query_async::<()>(admin).await.map_err(|e| e.to_string())?;
        for key in keys {
            let actual: String = redis::cmd("GET").arg(key).query_async(admin).await.map_err(|e| e.to_string())?;
            if actual != format!("db{db}-slot-value") {
                return Err(format!("owner {owner_port} db{db} wrong value"));
            }
        }
    }
    Ok(())
}

#[tokio::test]
#[ignore = "TOPOLOGY CHANGE: also requires DBX_1271_ALLOW_SLOT_MOVE=one-empty-slot"]
async fn core_cluster_empty_slot_owner_change_preserves_database_and_restores_topology() -> Result<(), String> {
    assert_eq!(std::env::var("DBX_1271_ALLOW_SLOT_MOVE").as_deref(), Ok("one-empty-slot"));
    let fixture = Fixture::open(PRIMARY, false).await;
    let mut admins = Vec::new();
    let mut master_ids = Vec::new();
    let mut baseline = None;
    for port in PRIMARY..=PRIMARY + 2 {
        let client = redis::Client::open(format!("redis://127.0.0.1:{port}/0")).map_err(|e| e.to_string())?;
        let mut admin = client.get_multiplexed_async_connection().await.map_err(|e| e.to_string())?;
        let slots = topology_snapshot(&mut admin).await?;
        if baseline.as_ref().is_some_and(|expected| *expected != slots) {
            return Err("initial maps disagree".into());
        }
        baseline = Some(slots);
        let id: String = redis::cmd("CLUSTER").arg("MYID").query_async(&mut admin).await.map_err(|e| e.to_string())?;
        master_ids.push((port, id));
        admins.push((port, admin));
    }
    let baseline = baseline.ok_or("initial slot map missing")?;
    if baseline.iter().map(|row| &row.2).collect::<BTreeSet<_>>().len() != 3 {
        return Err("expected exactly three masters".into());
    }
    // Warm both native core handles while their cached owner mapping is old.
    let pool = fixture.state.pool_handle(ID).await.ok_or("core pool missing")?;
    let PoolKind::Redis(redis) = &pool else { return Err("not Redis".into()) };
    let RedisConnection::Cluster(cluster) = redis.as_ref() else { return Err("not cluster".into()) };
    for db in [0, 1] {
        drop(cluster_any_connection_in_db(cluster, db).await?);
    }
    let mut chosen = None;
    for attempt in 0..256 {
        let key = fixture.key(&format!("{}-slot-{attempt}", fixture.prefix), "a");
        let slot: u16 = redis::cmd("CLUSTER")
            .arg("KEYSLOT")
            .arg(&key)
            .query_async(&mut admins[0].1)
            .await
            .map_err(|e| e.to_string())?;
        if slot_is_empty_everywhere(&mut admins, slot).await? {
            chosen = Some((slot, vec![key.clone(), format!("{key}:b")]));
            break;
        }
    }
    let (slot, keys) = chosen.ok_or("no verified empty slot found")?;
    let original = slot_owner(&baseline, slot)?.to_string();
    let original_port = master_ids.iter().find(|(_, id)| *id == original).ok_or("original owner unknown")?.0;
    let (new_port, new_owner) = master_ids.iter().find(|(_, id)| *id != original).ok_or("new owner missing")?.clone();
    println!("slot-change planned slot={slot} original={original}@{original_port} new={new_owner}@{new_port}");

    // From this point onward, all fallible work returns Result. No asserts,
    // unwraps or early '?' outside the operation/recovery blocks may bypass cleanup.
    let operation: Result<(), String> = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        assign_empty_slot(&mut admins, slot, &new_owner).await?;
        wait_for_owner(&mut admins, slot, &new_owner).await?;
        assert_topology_core_values(&fixture, &keys).await?;
        assert_topology_direct_values(&mut admins, &keys, new_port).await?;
        println!("slot-change values verified slot={slot} owner={new_owner} db0/db1 distinct");
        Ok(())
    })
    .await
    .unwrap_or_else(|_| Err("slot operation exceeded 30 seconds; proceeding to recovery".into()));
    // This timeout is deliberately separate: timing out the entire test would
    // drop the restoration future instead of guaranteeing a recovery attempt.
    let recovery: Result<(), String> = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        delete_slot_test_keys(&mut admins, &keys).await?;
        if !slot_is_empty_everywhere(&mut admins, slot).await? {
            return Err("refusing to restore a slot containing unexpected keys".into());
        }
        assign_empty_slot(&mut admins, slot, &original).await?;
        wait_for_owner(&mut admins, slot, &original).await?;
        for (_, admin) in admins.iter_mut() {
            let restored = topology_snapshot(admin).await?;
            // Adjacent ranges may stay split; compare semantic owner per slot.
            for candidate in 0..16384 {
                if slot_owner(&restored, candidate)? != slot_owner(&baseline, candidate)? {
                    return Err(format!("restoration changed another slot {candidate}"));
                }
            }
        }
        println!("slot-change restored slot={slot} owner={original}; all16384 slots healthy and original");
        Ok(())
    })
    .await
    .unwrap_or_else(|_| Err("slot recovery exceeded 30 seconds; topology must be inspected manually".into()));
    if let Err(error) = recovery {
        return Err(format!("RECOVERY REQUIRED slot={slot} original={original}@{original_port} new={new_owner}@{new_port}; operation={operation:?}; recovery={error}"));
    }
    operation.map_err(|error| format!("slot={slot} original={original}@{original_port} new={new_owner}@{new_port}; topology restored; operation failed: {error}"))?;
    // Topology is restored now. Verify the warmed handles also follow it back.
    let restored_values = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        assert_topology_core_values(&fixture, &keys).await?;
        assert_topology_direct_values(&mut admins, &keys, original_port).await
    })
    .await
    .unwrap_or_else(|_| Err("post-restoration value verification exceeded 30 seconds".into()));
    let cleanup = tokio::time::timeout(std::time::Duration::from_secs(10), delete_slot_test_keys(&mut admins, &keys))
        .await
        .unwrap_or_else(|_| Err(format!("exact-key cleanup exceeded 10 seconds; slot={slot}; keys={keys:?}")));
    restored_values?;
    cleanup
}
