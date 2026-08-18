//! Regression coverage for PR review points on partition DDL:
//! (1) database export must not duplicate a partition's `CREATE TABLE`
//!     (once via the parent's embedded tree, once via the export loop's own
//!     iteration over that same child relation) and the exported SQL must
//!     replay cleanly into a fresh schema; (2) a partition-local dropped
//!     column default must be modeled and replayed as a standalone
//!     `ALTER TABLE ONLY ... DROP DEFAULT`, not silently reintroduced;
//!     (3) fetching a whole partition tree's DDL must issue a small,
//!     roughly-constant number of queries rather than one scaling with the
//!     number of partitions.
//! Needs local Docker; skips cleanly when unavailable.

use std::process::Command;

use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, DatabaseExportRequest};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::storage::Storage;

struct DockerPostgres {
    name: String,
    port: u16,
}

impl Drop for DockerPostgres {
    fn drop(&mut self) {
        let _ = Command::new("docker").args(["rm", "-f", &self.name]).status();
    }
}

fn docker_ready() -> bool {
    Command::new("docker")
        .args(["version", "--format", "{{.Server.Version}}"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn start_docker_postgres(name_prefix: &str) -> Option<DockerPostgres> {
    if !docker_ready() {
        eprintln!("skipping docker-backed partition ddl test because Docker is unavailable");
        return None;
    }

    let port = portpicker::pick_unused_port().expect("pick unused postgres port");
    let container = DockerPostgres { name: format!("{name_prefix}-{}", uuid::Uuid::new_v4()), port };

    let status = Command::new("docker")
        .args([
            "run",
            "-d",
            "--rm",
            "--name",
            &container.name,
            "-e",
            "POSTGRES_PASSWORD=postgres",
            "-e",
            "POSTGRES_USER=postgres",
            "-e",
            "POSTGRES_DB=postgres",
            "-p",
            &format!("{port}:5432"),
            "postgres:16-alpine",
        ])
        .status()
        .expect("start docker postgres");
    assert!(status.success(), "docker run postgres container should succeed");

    let mut consecutive_ok = 0;
    for _ in 0..120 {
        let ready = Command::new("docker")
            .args(["exec", &container.name, "psql", "-U", "postgres", "-d", "postgres", "-c", "SELECT 1"])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        consecutive_ok = if ready { consecutive_ok + 1 } else { 0 };
        if consecutive_ok >= 2 {
            return Some(container);
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    panic!("postgres container did not become ready");
}

fn psql(container: &DockerPostgres, sql: &str) {
    let output = Command::new("docker")
        .args(["exec", &container.name, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql])
        .output()
        .expect("run psql");
    assert!(output.status.success(), "psql failed: {}", String::from_utf8_lossy(&output.stderr));
}

fn psql_allow_failure(container: &DockerPostgres, sql: &str) -> bool {
    Command::new("docker")
        .args(["exec", &container.name, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn postgres_test_config(id: &str, port: u16) -> ConnectionConfig {
    ConnectionConfig {
        docs_notes_path: None,
        id: id.to_string(),
        name: id.to_string(),
        note: String::new(),
        db_type: DatabaseType::Postgres,
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: "127.0.0.1".to_string(),
        port,
        username: "postgres".to_string(),
        password: "postgres".to_string(),
        database: Some("postgres".to_string()),
        default_schema: None,
        visible_databases: None,
        visible_schemas: None,
        attached_databases: Vec::new(),
        init_script: None,
        color: None,
        transport_layers: Vec::new(),
        connect_timeout_secs: 5,
        query_timeout_secs: 30,
        idle_timeout_secs: 60,
        keepalive_interval_secs: 0,
        ssl: false,
        ca_cert_path: String::new(),
        client_cert_path: String::new(),
        client_key_path: String::new(),
        sysdba: false,
        oracle_connection_type: None,
        connection_string: None,
        redis_connection_mode: None,
        redis_sentinel_master: String::new(),
        redis_sentinel_nodes: String::new(),
        redis_sentinel_username: String::new(),
        redis_sentinel_password: String::new(),
        redis_sentinel_tls: false,
        redis_cluster_nodes: String::new(),
        redis_key_separator: dbx_core::models::connection::default_redis_key_separator(),
        redis_scan_page_size: None,
        redis_database_aliases: Default::default(),
        etcd_endpoints: String::new(),
        gbase_server: String::new(),
        informix_server: String::new(),
        external_config: None,
        jdbc_driver_class: None,
        jdbc_driver_paths: Vec::new(),
        one_time: false,
        save_password: true,
        read_only: false,
        is_production: false,
        production_databases: vec![],
        show_system_schemas: false,
        database_info: None,
    }
}

/// Full database export of a partitioned schema must not duplicate any
/// relation's `CREATE TABLE`/`CREATE FOREIGN TABLE`, must faithfully replay
/// a partition-local dropped default, and the exported SQL must replay
/// cleanly into a fresh schema (the actual "restore" check the review
/// comment asked for).
#[tokio::test]
async fn database_export_of_partition_tree_has_no_duplicates_and_replays() {
    let Some(container) = start_docker_postgres("dbx-export-partition-ddl") else {
        return;
    };

    psql(
        &container,
        "CREATE EXTENSION IF NOT EXISTS postgres_fdw;\
         CREATE SERVER dbx_export_loopback FOREIGN DATA WRAPPER postgres_fdw \
           OPTIONS (host 'localhost', dbname 'postgres', port '5432');\
         CREATE USER MAPPING FOR CURRENT_USER SERVER dbx_export_loopback \
           OPTIONS (user 'postgres', password 'postgres');\
         CREATE TABLE foreign_child_data (id integer, status text);\
         CREATE TABLE events (id bigint NOT NULL, status text DEFAULT 'active', created_at timestamp NOT NULL) \
           PARTITION BY RANGE (created_at);\
         CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');\
         CREATE TABLE events_2027 PARTITION OF events FOR VALUES FROM ('2027-01-01') TO ('2028-01-01') PARTITION BY RANGE (created_at);\
         CREATE TABLE events_2027_h1 PARTITION OF events_2027 FOR VALUES FROM ('2027-01-01') TO ('2027-07-01');\
         CREATE TABLE events_2027_h2 PARTITION OF events_2027 FOR VALUES FROM ('2027-07-01') TO ('2028-01-01');\
         CREATE FOREIGN TABLE events_foreign PARTITION OF events FOR VALUES FROM ('2028-01-01') TO ('2029-01-01') \
           SERVER dbx_export_loopback OPTIONS (schema_name 'public', table_name 'foreign_child_data');\
         ALTER TABLE ONLY events_2027_h1 ALTER COLUMN status DROP DEFAULT;\
         ALTER TABLE ONLY events_2027_h2 ALTER COLUMN status SET DEFAULT 'archived';",
    );

    let dir = std::env::temp_dir().join(format!("dbx-export-partition-ddl-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);

    let connection_id = "export-partition-ddl-conn";
    state.configs.write().await.insert(connection_id.to_string(), postgres_test_config(connection_id, container.port));

    let file_path = dir.join("export.sql");
    let request = DatabaseExportRequest {
        export_id: format!("export-partition-ddl-{}", uuid::Uuid::new_v4()),
        connection_id: connection_id.to_string(),
        database: "postgres".to_string(),
        schema: "public".to_string(),
        file_path: file_path.to_string_lossy().to_string(),
        selected_tables: Vec::new(),
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: false,
        include_objects: false,
        include_create_database: false,
        drop_table_if_exists: false,
        omit_auto_increment: false,
        fail_on_error: true,
        snapshot_session_id: None,
        batch_size: 1000,
    };

    export_database_sql_core(&state, &request, |_progress| {}).await.expect("export should succeed");

    let exported = std::fs::read_to_string(&file_path).expect("read exported file");
    assert!(!exported.contains("-- ERROR"), "exported SQL should not contain errors:\n{exported}");

    for table in ["events", "events_2026", "events_2027", "events_2027_h1", "events_2027_h2", "events_foreign"] {
        let needle = format!("TABLE \"public\".\"{table}\"");
        let count = exported.matches(&needle).count();
        assert_eq!(count, 1, "expected exactly one CREATE (FOREIGN) TABLE for {table}, found {count}:\n{exported}");
    }
    assert!(exported.contains("CREATE FOREIGN TABLE \"public\".\"events_foreign\""), "exported: {exported}");

    assert!(
        exported.contains("ALTER TABLE ONLY \"public\".\"events_2027_h1\" ALTER COLUMN \"status\" DROP DEFAULT;"),
        "dropped default should be replayed as a standalone statement:\n{exported}"
    );
    assert!(
        exported.contains("\"status\" WITH OPTIONS DEFAULT 'archived'::text"),
        "overridden default should still render inline:\n{exported}"
    );
    // The untouched sibling (events_2026) must not gain either a drop or an
    // inline override — it purely inherits the parent's default.
    let events_2026_ddl_start = exported.find("PARTITION OF \"public\".\"events\"").expect("events_2026 ddl present");
    let events_2026_ddl = &exported[events_2026_ddl_start..(events_2026_ddl_start + 400).min(exported.len())];
    assert!(!events_2026_ddl.contains("DROP DEFAULT"), "events_2026 ddl: {events_2026_ddl}");
    assert!(!events_2026_ddl.contains("WITH OPTIONS DEFAULT"), "events_2026 ddl: {events_2026_ddl}");

    // The actual "restore" check: replay the exported SQL into a fresh
    // schema and confirm no `relation already exists` (or any other) error.
    psql(&container, "CREATE SCHEMA replay");
    let replayable = exported.replace("\"public\".", "\"replay\".").replace("SCHEMA \"public\"", "SCHEMA \"replay\"");
    let replay_file = dir.join("replay.sql");
    std::fs::write(&replay_file, &replayable).unwrap();
    let output = Command::new("docker")
        .args(["cp", replay_file.to_str().unwrap(), &format!("{}:/tmp/replay.sql", container.name)])
        .output()
        .expect("copy replay file into container");
    assert!(output.status.success(), "docker cp failed: {}", String::from_utf8_lossy(&output.stderr));
    let replay_output = Command::new("docker")
        .args([
            "exec",
            &container.name,
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-f",
            "/tmp/replay.sql",
        ])
        .output()
        .expect("replay exported sql");
    assert!(
        replay_output.status.success(),
        "replaying the exported SQL should succeed (no duplicate/`already exists` errors): {}",
        String::from_utf8_lossy(&replay_output.stderr)
    );
}

/// Fetching a whole partition tree's DDL (the "view DDL" interactive path)
/// must issue a small, roughly-constant number of queries — not one that
/// scales linearly with the number of leaf partitions.
#[tokio::test]
async fn partition_tree_ddl_query_count_does_not_scale_with_partition_count() {
    let Some(container) = start_docker_postgres("dbx-partition-ddl-query-count") else {
        return;
    };

    if !psql_allow_failure(&container, "ALTER SYSTEM SET log_statement = 'all'") {
        eprintln!("skipping query-count test: could not enable log_statement");
        return;
    }
    psql(&container, "SELECT pg_reload_conf()");

    let build_tree = |leaves: u32| -> String {
        let mut sql = String::from(
            "CREATE TABLE t (id bigint NOT NULL, bucket integer NOT NULL, status text DEFAULT 'active') PARTITION BY RANGE (bucket);",
        );
        for i in 0..leaves {
            sql.push_str(&format!(
                "CREATE TABLE t_{i} PARTITION OF t FOR VALUES FROM ({start}) TO ({end});",
                i = i,
                start = i * 10,
                end = (i + 1) * 10
            ));
        }
        sql
    };

    let dir = std::env::temp_dir().join(format!("dbx-partition-query-count-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let connection_id = "partition-query-count-conn";
    state.configs.write().await.insert(connection_id.to_string(), postgres_test_config(connection_id, container.port));

    async fn fetch_ddl(state: &AppState, connection_id: &str) -> String {
        dbx_core::schema::get_table_display_ddl_core(state, connection_id, "postgres", "public", "t", None)
            .await
            .expect("fetch partition tree ddl")
    }

    let logs_between = |container: &DockerPostgres, start_marker: &str, end_marker: &str| -> usize {
        let output = Command::new("docker").args(["logs", &container.name]).output().expect("docker logs");
        let combined =
            format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        let start = combined.rfind(start_marker).map(|i| i + start_marker.len());
        let end = combined.rfind(end_marker);
        match (start, end) {
            (Some(s), Some(e)) if e > s => {
                combined[s..e].lines().filter(|line| line.contains("statement:") || line.contains("execute")).count()
            }
            _ => usize::MAX,
        }
    };

    psql(&container, &format!("DROP TABLE IF EXISTS t CASCADE; {}", build_tree(3)));
    psql(&container, "SELECT 'MARKER_SMALL_START'");
    let small_ddl = fetch_ddl(&state, connection_id).await;
    psql(&container, "SELECT 'MARKER_SMALL_END'");
    assert_eq!(small_ddl.matches("PARTITION OF").count(), 3, "small tree ddl: {small_ddl}");

    psql(&container, &format!("DROP TABLE IF EXISTS t CASCADE; {}", build_tree(40)));
    psql(&container, "SELECT 'MARKER_LARGE_START'");
    let large_ddl = fetch_ddl(&state, connection_id).await;
    psql(&container, "SELECT 'MARKER_LARGE_END'");
    assert_eq!(large_ddl.matches("PARTITION OF").count(), 40, "large tree ddl: {large_ddl}");

    // Give the container's log a moment to flush before reading it back.
    std::thread::sleep(std::time::Duration::from_millis(500));
    let small_count = logs_between(&container, "MARKER_SMALL_START", "MARKER_SMALL_END");
    let large_count = logs_between(&container, "MARKER_LARGE_START", "MARKER_LARGE_END");

    assert_ne!(small_count, usize::MAX, "could not locate small-tree marker window in container logs");
    assert_ne!(large_count, usize::MAX, "could not locate large-tree marker window in container logs");
    // A naive per-relation recursion issues ~9 queries per relation, so a
    // 40-leaf tree (41 relations) would log roughly 13x the 3-leaf tree's
    // (4 relations) query count. The batched implementation should stay
    // close to flat instead.
    assert!(
        large_count <= small_count + 10,
        "query count should not scale with partition count: small={small_count} large={large_count}"
    );
}
