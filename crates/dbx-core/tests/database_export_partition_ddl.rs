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

mod support;

use std::process::Command;
use std::sync::Arc;

use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, DatabaseExportRequest};
use dbx_core::storage::Storage;
use support::{
    postgres_test_config, psql, psql_allow_failure, start_docker_postgres, start_docker_postgres_with_server_args,
    DockerPostgres,
};

/// Full database export of a partitioned schema must not duplicate any
/// relation's `CREATE TABLE`/`CREATE FOREIGN TABLE`, must faithfully replay
/// a partition-local dropped default, and the exported SQL must replay
/// cleanly into a fresh schema (the actual "restore" check the review
/// comment asked for).
#[test]
fn database_export_of_partition_tree_has_no_duplicates_and_replays() {
    let handle = std::thread::Builder::new()
        .name("database-export-partition-ddl".to_string())
        .stack_size(8 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("build partition ddl test runtime")
                .block_on(run_database_export_of_partition_tree_has_no_duplicates_and_replays());
        })
        .expect("spawn partition ddl test thread");
    if let Err(panic) = handle.join() {
        std::panic::resume_unwind(panic);
    }
}

async fn run_database_export_of_partition_tree_has_no_duplicates_and_replays() {
    let Some(container) = start_docker_postgres("dbx-export-partition-ddl") else {
        return;
    };

    psql(
        &container,
        "DROP TABLE IF EXISTS events CASCADE;\
         DROP TABLE IF EXISTS foreign_child_data CASCADE;\
         DROP SERVER IF EXISTS dbx_export_loopback CASCADE;\
         CREATE EXTENSION IF NOT EXISTS postgres_fdw;\
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
    let state = Arc::new(AppState::new(storage));

    let connection_id = "export-partition-ddl-conn";
    state.configs.write().await.insert(connection_id.to_string(), postgres_test_config(connection_id, container.port));

    let selected_table_ddl =
        dbx_core::schema::get_table_export_ddl_core(&state, connection_id, "postgres", "public", "events", None)
            .await
            .expect("selected table structure export should succeed");
    for table in ["events", "events_2026", "events_2027", "events_2027_h1", "events_2027_h2", "events_foreign"] {
        let needle = format!("TABLE \"public\".\"{table}\"");
        let count = selected_table_ddl.matches(&needle).count();
        assert_eq!(count, 1, "selected structure export should include {table} exactly once: {selected_table_ddl}");
    }
    assert!(
        selected_table_ddl.contains("CREATE FOREIGN TABLE \"public\".\"events_foreign\""),
        "selected structure export should retain foreign partition syntax: {selected_table_ddl}"
    );

    let ordinary_table_ddl = dbx_core::schema::get_table_export_ddl_core(
        &state,
        connection_id,
        "postgres",
        "public",
        "foreign_child_data",
        None,
    )
    .await
    .expect("ordinary selected table structure export should succeed");
    assert_eq!(ordinary_table_ddl.matches("CREATE TABLE \"public\".\"foreign_child_data\"").count(), 1);
    assert!(!ordinary_table_ddl.contains("PARTITION OF"));

    let missing_table_error = dbx_core::schema::get_table_export_ddl_core(
        &state,
        connection_id,
        "postgres",
        "public",
        "missing_issue_6505_table",
        None,
    )
    .await
    .expect_err("missing selected table should remain an error");
    assert!(missing_table_error.contains("was not found"), "unexpected missing-table error: {missing_table_error}");

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
        output_compression: Default::default(),
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
    psql(&container, "DROP SCHEMA IF EXISTS replay CASCADE; CREATE SCHEMA replay");
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
    let state = Arc::new(AppState::new(storage));
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

/// A tree-DDL request for a relation that exists but isn't a
/// table/partition/foreign table (e.g. a view) must say so specifically,
/// not fall back to a generic "not found" message that also covers a
/// relation that doesn't exist at all.
#[tokio::test]
async fn display_ddl_error_distinguishes_wrong_relkind_from_missing_relation() {
    let Some(container) = start_docker_postgres("dbx-partition-ddl-relkind-error") else {
        return;
    };

    psql(&container, "CREATE VIEW v AS SELECT 1 AS id");

    let dir = std::env::temp_dir().join(format!("dbx-partition-relkind-error-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let connection_id = "partition-relkind-error-conn";
    state.configs.write().await.insert(connection_id.to_string(), postgres_test_config(connection_id, container.port));

    let view_error =
        dbx_core::schema::get_table_display_ddl_core(&state, connection_id, "postgres", "public", "v", None)
            .await
            .expect_err("requesting tree DDL for a view must fail");
    assert!(view_error.contains("is a VIEW"), "expected a relkind-specific error, got: {view_error}");

    let missing_error = dbx_core::schema::get_table_display_ddl_core(
        &state,
        connection_id,
        "postgres",
        "public",
        "does_not_exist",
        None,
    )
    .await
    .expect_err("requesting tree DDL for a missing relation must fail");
    assert!(missing_error.contains("was not found"), "expected a not-found error, got: {missing_error}");
    assert!(!missing_error.contains("is a"), "not-found error should not claim a relkind: {missing_error}");
}

/// Cloudberry/Greenplum's `pg_get_tabledef` (a community PL/pgSQL function
/// most installs have, not a catalog builtin) renders exactly the one
/// relation it's asked for — never its partitions' own `CREATE TABLE ...
/// PARTITION OF ...` statements. `cloudberry_ddl(..., include_partitions:
/// true)` must still return every partition's DDL by walking the same
/// partition tree the plain-Postgres path uses, instead of silently
/// returning just the root's DDL whenever the native call succeeds. This
/// installs a minimal stand-in `pg_get_tabledef` (mirroring the real one's
/// single-relation behavior) rather than the full upstream script, since
/// only that single-relation behavior is what the fix under test reacts to.
#[tokio::test]
async fn cloudberry_native_ddl_still_includes_every_partition() {
    let Some(container) = start_docker_postgres("dbx-cloudberry-partition-ddl") else {
        return;
    };

    psql(
        &container,
        "CREATE OR REPLACE FUNCTION pg_get_tabledef(in_schema text, in_table text, _verbose boolean) \
         RETURNS text AS $$ SELECT format('CREATE TABLE \"%s\".\"%s\" (id integer) /* stub-native-ddl */;', in_schema, in_table) $$ \
         LANGUAGE sql",
    );
    psql(&container, "CREATE TABLE t (id integer NOT NULL) PARTITION BY RANGE (id)");
    psql(&container, "CREATE TABLE t_p1 PARTITION OF t FOR VALUES FROM (0) TO (100)");
    psql(&container, "CREATE TABLE t_p2 PARTITION OF t FOR VALUES FROM (100) TO (200)");

    let url = format!("postgres://postgres:postgres@127.0.0.1:{}/postgres", container.port);
    let pool = dbx_core::db::postgres::connect(&url, std::time::Duration::from_secs(5)).await.expect("connect");

    let ddl =
        dbx_core::schema::cloudberry_ddl(&pool, "public", "t", true).await.expect("cloudberry ddl with partitions");
    assert_eq!(
        ddl.matches("stub-native-ddl").count(),
        3,
        "expected the root plus both partitions to each get their own native DDL: {ddl}"
    );
    assert!(ddl.contains("CREATE TABLE \"public\".\"t\""));
    assert!(ddl.contains("CREATE TABLE \"public\".\"t_p1\""));
    assert!(ddl.contains("CREATE TABLE \"public\".\"t_p2\""));

    let single_ddl =
        dbx_core::schema::cloudberry_ddl(&pool, "public", "t", false).await.expect("cloudberry ddl without partitions");
    assert_eq!(single_ddl.matches("stub-native-ddl").count(), 1, "expected only the root's own DDL: {single_ddl}");
}

/// `opentenbase_ddl(..., include_partitions: true)` must query and append
/// each partition's own `DISTRIBUTE BY` clause, not just the tree root's.
/// OpenTenBase itself has no simple single-container way to stand up (its
/// own docs only cover a multi-node `pgxc_ctl deploy`/`init` cluster built
/// from source), so this runs the actual, unmodified
/// `TABLE_DISTRIBUTION_FOR_RELATIONS_SQL` query against a real PostgreSQL
/// container with a stand-in `pg_catalog.pgxc_class` table shaped like
/// OpenTenBase's real one — exercising the real SQL (join, `unnest($1::
/// text[], $2::text[])` parameter binding, casts, row parsing), not just the
/// clause-insertion string logic around it.
#[tokio::test]
async fn opentenbase_tree_ddl_gives_every_partition_its_own_distribute_by() {
    let Some(container) =
        start_docker_postgres_with_server_args("dbx-opentenbase-partition-ddl", &["-c", "allow_system_table_mods=on"])
    else {
        return;
    };

    psql(
        &container,
        "CREATE TABLE pg_catalog.pgxc_class (pcrelid oid PRIMARY KEY, pclocatortype \"char\", discolnums smallint[])",
    );
    psql(&container, "CREATE TABLE t (id integer NOT NULL, region text NOT NULL) PARTITION BY RANGE (id)");
    psql(&container, "CREATE TABLE t_p1 PARTITION OF t FOR VALUES FROM (0) TO (100)");
    psql(&container, "CREATE TABLE t_p2 PARTITION OF t FOR VALUES FROM (100) TO (200)");
    // Root distributes by `region` (attnum 2); t_p1 distributes by `id`
    // (attnum 1) instead, to prove each relation's own policy is looked up
    // independently rather than the root's being reused for every relation.
    // t_p2 deliberately has no pgxc_class row at all — it must be left
    // without a DISTRIBUTE BY clause rather than erroring the whole DDL.
    psql(&container, "INSERT INTO pg_catalog.pgxc_class VALUES ('t'::regclass, 'H', ARRAY[2]::smallint[])");
    psql(&container, "INSERT INTO pg_catalog.pgxc_class VALUES ('t_p1'::regclass, 'H', ARRAY[1]::smallint[])");

    let url = format!("postgres://postgres:postgres@127.0.0.1:{}/postgres", container.port);
    let pool = dbx_core::db::postgres::connect(&url, std::time::Duration::from_secs(5)).await.expect("connect");

    let distributions = dbx_core::db::opentenbase::table_distribution_for_relations(
        &pool,
        &[("public".to_string(), "t".to_string()), ("public".to_string(), "t_p1".to_string())],
    )
    .await
    .expect("batched distribution query");
    assert_eq!(
        distributions.get(&("public".to_string(), "t".to_string())),
        Some(&dbx_core::db::opentenbase::DistributionPolicy::Hash(vec!["region".to_string()]))
    );
    assert_eq!(
        distributions.get(&("public".to_string(), "t_p1".to_string())),
        Some(&dbx_core::db::opentenbase::DistributionPolicy::Hash(vec!["id".to_string()]))
    );

    let ddl = dbx_core::schema::opentenbase_ddl(&pool, "public", "t", true).await.expect("opentenbase tree ddl");
    assert!(
        ddl.contains("\"t\" (\n  \"id\" integer NOT NULL,\n  \"region\" text NOT NULL\n) PARTITION BY RANGE (id)\nDISTRIBUTE BY HASH (\"region\");"),
        "root should get its own DISTRIBUTE BY HASH (region): {ddl}"
    );
    assert!(
        ddl.contains(
            "\"t_p1\" PARTITION OF \"public\".\"t\" FOR VALUES FROM (0) TO (100)\nDISTRIBUTE BY HASH (\"id\");"
        ),
        "t_p1 should get its own DISTRIBUTE BY HASH (id), independent of the root's: {ddl}"
    );
    assert!(
        ddl.contains("\"t_p2\" PARTITION OF \"public\".\"t\" FOR VALUES FROM (100) TO (200);"),
        "t_p2 has no pgxc_class row and must not get a DISTRIBUTE BY clause: {ddl}"
    );
    assert_eq!(ddl.matches("DISTRIBUTE BY").count(), 2);
}
