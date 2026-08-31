use dbx_core::connection::AppState;
use dbx_core::database_export::{
    begin_database_backup_snapshot_core, clear_export_cancelled, export_database_sql_core, set_export_cancelled,
    DatabaseExportRequest, ExportStatus,
};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{
    begin_manual_transaction, commit_manual_transaction, execute_in_manual_transaction, execute_sql_statement,
    rollback_manual_transaction, stream_rows_in_manual_transaction,
};
use dbx_core::storage::Storage;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

fn live_config(prefix: &str, db_type: DatabaseType, default_port: u16) -> ConnectionConfig {
    let host = std::env::var(format!("{prefix}_HOST")).expect("live DB host env var");
    let port = std::env::var(format!("{prefix}_PORT"))
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(default_port);
    let username = std::env::var(format!("{prefix}_USER")).expect("live DB user env var");
    let password = std::env::var(format!("{prefix}_PASSWORD")).expect("live DB password env var");
    let database = std::env::var(format!("{prefix}_DATABASE")).expect("live DB database env var");
    let url_params = std::env::var(format!("{prefix}_URL_PARAMS")).ok();

    serde_json::from_value(serde_json::json!({
        "id": format!("manual-txn-{prefix}"),
        "name": format!("Manual transaction {prefix}"),
        "db_type": db_type,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": database,
        "connect_timeout_secs": 5,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0,
        "url_params": url_params
    }))
    .expect("live connection config should deserialize")
}

async fn app_state_with_config(config: ConnectionConfig) -> (Arc<AppState>, std::path::PathBuf) {
    let db_path = std::env::temp_dir().join(format!("dbx-live-manual-txn-{}.db", uuid::Uuid::new_v4().simple()));
    let storage = Storage::open(&db_path).await.expect("open temp storage");
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(config.id.clone(), config);
    (state, db_path)
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MANUAL_TXN_POSTGRES_* env vars pointing at writable PostgreSQL"]
async fn live_manual_transaction_postgres_preserves_typed_selects_and_empty_metadata() {
    let config = live_config("DBX_LIVE_MANUAL_TXN_POSTGRES", DatabaseType::Postgres, 5432);
    let database = config.database.clone().expect("database");
    let (state, db_path) = app_state_with_config(config.clone()).await;

    let txn = begin_manual_transaction(&state, &config.id, &database, None, None).await.expect("begin");
    execute_in_manual_transaction(&state, &txn, "DEALLOCATE ALL", &database, None, Some(10))
        .await
        .expect("simulate lost prepared statements");
    let typed = execute_in_manual_transaction(
        &state,
        &txn,
        "SELECT 1::int4 AS id, 'pg'::text AS label, true AS ok",
        &database,
        None,
        Some(10),
    )
    .await
    .expect("typed select");
    assert_eq!(typed[0].columns, vec!["id", "label", "ok"]);
    assert_eq!(typed[0].rows, vec![vec![serde_json::json!(1), serde_json::json!("pg"), serde_json::json!(true)]]);

    let empty = execute_in_manual_transaction(
        &state,
        &txn,
        "SELECT 1::int4 AS id, 'empty'::text AS label WHERE false",
        &database,
        None,
        Some(10),
    )
    .await
    .expect("empty select");
    assert_eq!(empty[0].columns, vec!["id", "label"]);
    assert!(empty[0].rows.is_empty());

    commit_manual_transaction(&state, &txn).await.expect("commit");
    let _ = std::fs::remove_file(db_path);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MANUAL_TXN_POSTGRES_* env vars pointing at writable PostgreSQL"]
async fn live_postgres_backup_snapshot_streams_after_server_deallocates_statements() {
    let config = live_config("DBX_LIVE_MANUAL_TXN_POSTGRES", DatabaseType::Postgres, 5432);
    let database = config.database.clone().expect("database");
    let (state, db_path) = app_state_with_config(config.clone()).await;

    let snapshot = begin_database_backup_snapshot_core(&state, &config.id, &database).await.expect("begin snapshot");
    execute_in_manual_transaction(&state, &snapshot.session_id, "DEALLOCATE ALL", &database, None, Some(10))
        .await
        .expect("simulate lost prepared statements");

    let mut batches = Vec::new();
    let row_count = stream_rows_in_manual_transaction(
        &state,
        &snapshot.session_id,
        "SELECT 1::int4 AS value UNION ALL SELECT 2::int4",
        1,
        |batch| {
            batches.push(batch);
            Ok(())
        },
    )
    .await
    .expect("stream through backup snapshot");
    assert_eq!(row_count, 2);
    assert_eq!(batches, vec![vec![vec![serde_json::json!(1)]], vec![vec![serde_json::json!(2)]]]);

    let empty_rows = stream_rows_in_manual_transaction(
        &state,
        &snapshot.session_id,
        "SELECT 1::int4 AS value WHERE false",
        1,
        |_| panic!("empty result must not emit a row batch"),
    )
    .await
    .expect("stream empty result through backup snapshot");
    assert_eq!(empty_rows, 0);

    let mut fallback_batches = Vec::new();
    let fallback_rows = stream_rows_in_manual_transaction(
        &state,
        &snapshot.session_id,
        "SELECT ROW(1, 'fallback') AS value",
        1,
        |batch| {
            fallback_batches.push(batch);
            Ok(())
        },
    )
    .await
    .expect("stream text-fallback value through backup snapshot");
    assert_eq!(fallback_rows, 1);
    assert_eq!(fallback_batches.len(), 1);
    assert!(fallback_batches[0][0][0].as_str().is_some());

    rollback_manual_transaction(&state, &snapshot.session_id).await.expect("rollback snapshot");
    let _ = std::fs::remove_file(db_path);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MANUAL_TXN_POSTGRES_* env vars pointing at writable PostgreSQL"]
async fn live_postgres_backup_snapshot_times_out_when_row_stream_stalls() {
    let mut config = live_config("DBX_LIVE_MANUAL_TXN_POSTGRES", DatabaseType::Postgres, 5432);
    config.query_timeout_secs = 1;
    let database = config.database.clone().expect("database");
    let (state, db_path) = app_state_with_config(config.clone()).await;

    let snapshot = begin_database_backup_snapshot_core(&state, &config.id, &database).await.expect("begin snapshot");
    let started_at = Instant::now();
    let result = stream_rows_in_manual_transaction(
        &state,
        &snapshot.session_id,
        "SELECT pg_sleep(5), 1::int4 AS value",
        1,
        |_| Ok(()),
    )
    .await;

    assert_eq!(result, Err("Query timed out after 1 seconds. Transaction was auto-rolled back.".to_string()));
    assert!(started_at.elapsed() < Duration::from_secs(5), "stalled snapshot stream was not cancelled promptly");
    assert!(!state.transaction_sessions.read().await.contains_key(&snapshot.session_id));

    let recovery = begin_manual_transaction(&state, &config.id, &database, None, None).await.expect("begin recovery");
    execute_in_manual_transaction(&state, &recovery, "SELECT 1", &database, None, Some(1))
        .await
        .expect("PostgreSQL should accept a query after snapshot timeout");
    rollback_manual_transaction(&state, &recovery).await.expect("rollback recovery");
    let _ = std::fs::remove_file(db_path);
}

#[test]
#[ignore = "requires DBX_LIVE_MANUAL_TXN_POSTGRES_* env vars pointing at writable PostgreSQL"]
fn live_postgres_backup_snapshot_exports_wide_jsonb_then_next_table() {
    std::thread::Builder::new()
        .name("dbx-live-pg-wide-backup".to_string())
        .stack_size(16 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_stack_size(16 * 1024 * 1024)
                .enable_all()
                .build()
                .expect("build wide backup test runtime")
                .block_on(live_postgres_backup_snapshot_exports_wide_jsonb_then_next_table_inner())
        })
        .expect("spawn wide backup test thread")
        .join()
        .expect("wide backup test thread should not panic");
}

async fn live_postgres_backup_snapshot_exports_wide_jsonb_then_next_table_inner() {
    let mut config = live_config("DBX_LIVE_MANUAL_TXN_POSTGRES", DatabaseType::Postgres, 5432);
    config.query_timeout_secs = 1;
    let database = config.database.clone().expect("database");
    let connection_id = config.id.clone();
    let (state, db_path) = app_state_with_config(config).await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let schema = format!("dbx_7087_{}", &suffix[..12]);
    let export_path = std::env::temp_dir().join(format!("dbx-7087-wide-jsonb-{suffix}.sql"));

    let setup_sql = [
        format!(r#"CREATE SCHEMA "{schema}""#),
        format!(r#"CREATE TABLE "{schema}".audit_ops (id int PRIMARY KEY, task_payload jsonb NOT NULL)"#),
        format!(
            r#"INSERT INTO "{schema}".audit_ops
               SELECT i, jsonb_build_object('id', i, 'contents', jsonb_build_array(repeat('x', 1500)))
               FROM generate_series(1, 3000) AS source(i)"#
        ),
        format!(r#"CREATE TABLE "{schema}".zz_next (id int PRIMARY KEY, label text NOT NULL)"#),
        format!(
            r#"INSERT INTO "{schema}".zz_next
               SELECT i, 'next-' || i FROM generate_series(1, 6) AS source(i)"#
        ),
    ];
    for sql in setup_sql {
        execute_sql_statement(&state, &connection_id, &database, &sql, None, None)
            .await
            .expect("create wide JSONB backup fixture");
    }

    let snapshot =
        begin_database_backup_snapshot_core(&state, &connection_id, &database).await.expect("begin snapshot");
    let request = DatabaseExportRequest {
        export_id: format!("live-postgres-wide-jsonb-{suffix}"),
        connection_id: connection_id.clone(),
        database: database.clone(),
        schema: schema.clone(),
        file_path: export_path.to_string_lossy().to_string(),
        selected_tables: vec!["audit_ops".to_string(), "zz_next".to_string()],
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: true,
        include_objects: false,
        include_create_database: false,
        drop_table_if_exists: false,
        omit_auto_increment: false,
        fail_on_error: true,
        output_compression: Default::default(),
        snapshot_session_id: Some(snapshot.session_id.clone()),
        batch_size: 1000,
    };
    let terminal_rows = AtomicU64::new(u64::MAX);
    let export_result = export_database_sql_core(&state, &request, |progress| {
        if matches!(progress.status, dbx_core::database_export::ExportStatus::Done) {
            terminal_rows.store(progress.rows_exported, Ordering::Relaxed);
        }
    })
    .await;
    let rollback_result = rollback_manual_transaction(&state, &snapshot.session_id).await;

    export_result.expect("export wide JSONB table and continue to next table");
    rollback_result.expect("rollback completed backup snapshot");
    assert_eq!(terminal_rows.load(Ordering::Relaxed), 3006);
    let sql = std::fs::read_to_string(&export_path).expect("read wide JSONB export");
    assert!(sql.len() > 3_000_000, "wide JSONB fixture should produce a multi-megabyte export");
    assert!(sql.contains("audit_ops"));
    assert!(sql.contains("zz_next"));
    assert!(sql.contains("next-6"), "export must reach and finish the table after audit_ops");

    execute_sql_statement(&state, &connection_id, &database, &format!(r#"DROP SCHEMA "{schema}" CASCADE"#), None, None)
        .await
        .expect("drop wide JSONB backup fixture");
    let _ = std::fs::remove_file(export_path);
    let _ = std::fs::remove_file(db_path);
}

#[test]
#[ignore = "requires DBX_LIVE_MANUAL_TXN_POSTGRES_* env vars pointing at writable PostgreSQL"]
fn live_postgres_backup_snapshot_cancel_interrupts_pending_row() {
    std::thread::Builder::new()
        .name("dbx-live-pg-backup-cancel".to_string())
        .stack_size(16 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_stack_size(16 * 1024 * 1024)
                .enable_all()
                .build()
                .expect("build backup cancellation test runtime")
                .block_on(live_postgres_backup_snapshot_cancel_interrupts_pending_row_inner())
        })
        .expect("spawn backup cancellation test thread")
        .join()
        .expect("backup cancellation test thread should not panic");
}

async fn live_postgres_backup_snapshot_cancel_interrupts_pending_row_inner() {
    let admin_config = live_config("DBX_LIVE_MANUAL_TXN_POSTGRES", DatabaseType::Postgres, 5432);
    let database = admin_config.database.clone().expect("database");
    let admin_connection_id = admin_config.id.clone();
    let (admin_state, admin_db_path) = app_state_with_config(admin_config.clone()).await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let schema = format!("dbx_7087_cancel_{}", &suffix[..8]);
    let role = format!("dbx7087_{}", &suffix[..12]);
    let password = format!("dbx-{suffix}");

    let setup_sql = [
        format!(r#"CREATE ROLE "{role}" LOGIN PASSWORD '{password}'"#),
        format!(r#"CREATE SCHEMA "{schema}""#),
        format!(r#"CREATE TABLE "{schema}".slow_rows (id int PRIMARY KEY, payload text NOT NULL)"#),
        format!(r#"INSERT INTO "{schema}".slow_rows VALUES (1, repeat('x', 1000000)), (2, repeat('y', 1000000))"#),
        format!(
            r#"CREATE FUNCTION "{schema}".slow_visible(integer) RETURNS boolean
               LANGUAGE plpgsql VOLATILE
               AS 'BEGIN PERFORM pg_sleep(2); RETURN true; END'"#
        ),
        format!(r#"ALTER TABLE "{schema}".slow_rows ENABLE ROW LEVEL SECURITY"#),
        format!(
            r#"CREATE POLICY slow_rows_policy ON "{schema}".slow_rows
               FOR SELECT TO "{role}" USING ("{schema}".slow_visible(id))"#
        ),
        format!(r#"GRANT USAGE ON SCHEMA "{schema}" TO "{role}""#),
        format!(r#"GRANT SELECT ON "{schema}".slow_rows TO "{role}""#),
    ];
    for sql in setup_sql {
        execute_sql_statement(&admin_state, &admin_connection_id, &database, &sql, None, None)
            .await
            .expect("create cancellable backup fixture");
    }

    let mut role_config = admin_config;
    role_config.id = format!("live-postgres-backup-cancel-{suffix}");
    role_config.name = "Live PostgreSQL backup cancellation".to_string();
    role_config.username = role.clone();
    role_config.password = password;
    role_config.query_timeout_secs = 0;
    let role_connection_id = role_config.id.clone();
    let (role_state, role_db_path) = app_state_with_config(role_config).await;
    let role_state = Arc::new(role_state);
    let snapshot = begin_database_backup_snapshot_core(&role_state, &role_connection_id, &database)
        .await
        .expect("begin role snapshot");
    let export_id = format!("live-postgres-backup-cancel-{suffix}");
    clear_export_cancelled(&export_id).await;
    let export_path = std::env::temp_dir().join(format!("dbx-7087-cancel-{suffix}.sql"));
    let request = DatabaseExportRequest {
        export_id: export_id.clone(),
        connection_id: role_connection_id,
        database: database.clone(),
        schema: schema.clone(),
        file_path: export_path.to_string_lossy().to_string(),
        selected_tables: vec!["slow_rows".to_string()],
        excluded_tables: Vec::new(),
        include_structure: false,
        include_data: true,
        include_objects: false,
        include_create_database: false,
        drop_table_if_exists: false,
        omit_auto_increment: false,
        fail_on_error: true,
        output_compression: Default::default(),
        snapshot_session_id: Some(snapshot.session_id.clone()),
        batch_size: 1,
    };
    let rows_seen = Arc::new(AtomicU64::new(0));
    let terminal_status = Arc::new(AtomicU64::new(0));
    let rows_for_export = rows_seen.clone();
    let terminal_for_export = terminal_status.clone();
    let state_for_export = role_state.clone();
    let export_task = tokio::spawn(async move {
        export_database_sql_core(&state_for_export, &request, |progress| {
            rows_for_export.store(progress.rows_exported, Ordering::Relaxed);
            if matches!(progress.status, ExportStatus::Cancelled) {
                terminal_for_export.store(1, Ordering::Relaxed);
            } else if matches!(progress.status, ExportStatus::Done | ExportStatus::Error) {
                terminal_for_export.store(2, Ordering::Relaxed);
            }
        })
        .await
    });

    tokio::time::timeout(Duration::from_secs(10), async {
        while rows_seen.load(Ordering::Relaxed) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("first slow row should be exported before cancellation");
    let cancel_started = Instant::now();
    set_export_cancelled(&export_id).await;
    let export_result = tokio::time::timeout(Duration::from_secs(10), export_task)
        .await
        .expect("cancelled backup should terminate")
        .expect("backup task should not panic");

    assert_eq!(export_result, Ok(()));
    assert_eq!(terminal_status.load(Ordering::Relaxed), 1, "export cancel must produce the Cancelled terminal state");
    assert!(cancel_started.elapsed() < Duration::from_secs(2), "CancelRequest did not interrupt the pending row");
    assert!(!role_state.transaction_sessions.read().await.contains_key(&snapshot.session_id));
    clear_export_cancelled(&export_id).await;

    execute_sql_statement(
        &admin_state,
        &admin_connection_id,
        &database,
        &format!(r#"DROP SCHEMA "{schema}" CASCADE"#),
        None,
        None,
    )
    .await
    .expect("drop cancellable backup schema");
    execute_sql_statement(&admin_state, &admin_connection_id, &database, &format!(r#"DROP ROLE "{role}""#), None, None)
        .await
        .expect("drop cancellable backup role");
    let _ = std::fs::remove_file(export_path);
    let _ = std::fs::remove_file(role_db_path);
    let _ = std::fs::remove_file(admin_db_path);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MANUAL_TXN_MYSQL_* env vars pointing at writable MySQL"]
async fn live_manual_transaction_mysql_streams_with_row_limit() {
    let config = live_config("DBX_LIVE_MANUAL_TXN_MYSQL", DatabaseType::Mysql, 3306);
    let database = config.database.clone().expect("database");
    let (state, db_path) = app_state_with_config(config.clone()).await;

    let txn = begin_manual_transaction(&state, &config.id, &database, None, None).await.expect("begin");
    let limited = execute_in_manual_transaction(
        &state,
        &txn,
        "SELECT 1 AS id UNION ALL SELECT 2 UNION ALL SELECT 3",
        &database,
        None,
        Some(2),
    )
    .await
    .expect("limited select");
    assert_eq!(limited[0].columns, vec!["id"]);
    assert_eq!(limited[0].rows.len(), 2);
    assert!(limited[0].truncated);

    rollback_manual_transaction(&state, &txn).await.expect("rollback");
    let _ = std::fs::remove_file(db_path);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MANUAL_TXN_MYSQL_* env vars pointing at readable MySQL with table t_0001"]
async fn live_mysql_database_backup_refreshes_an_idle_snapshot_before_export() {
    let config = live_config("DBX_LIVE_MANUAL_TXN_MYSQL", DatabaseType::Mysql, 3306);
    let database = config.database.clone().expect("database");
    let (state, db_path) = app_state_with_config(config.clone()).await;
    let export_path = std::env::temp_dir().join(format!("dbx-live-backup-{}.sql", uuid::Uuid::new_v4().simple()));

    let snapshot = begin_database_backup_snapshot_core(&state, &config.id, &database).await.expect("begin snapshot");
    {
        let mut sessions = state.transaction_sessions.write().await;
        sessions.get_mut(&snapshot.session_id).expect("snapshot session").last_activity =
            Instant::now() - Duration::from_secs(301);
    }

    let request = DatabaseExportRequest {
        export_id: format!("live-mysql-backup-{}", uuid::Uuid::new_v4().simple()),
        connection_id: config.id.clone(),
        database: database.clone(),
        schema: database.clone(),
        file_path: export_path.to_string_lossy().to_string(),
        selected_tables: vec!["t_0001".to_string()],
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: true,
        include_objects: false,
        include_create_database: false,
        drop_table_if_exists: false,
        omit_auto_increment: false,
        fail_on_error: true,
        output_compression: Default::default(),
        snapshot_session_id: Some(snapshot.session_id.clone()),
        batch_size: 100,
    };
    let export_result = export_database_sql_core(&state, &request, |_| {}).await;
    let rollback_result = rollback_manual_transaction(&state, &snapshot.session_id).await;

    export_result.expect("export through refreshed snapshot");
    rollback_result.expect("rollback snapshot");
    let sql = std::fs::read_to_string(&export_path).expect("read exported SQL");
    assert!(sql.contains("t_0001"));

    let _ = std::fs::remove_file(export_path);
    let _ = std::fs::remove_file(db_path);
}
