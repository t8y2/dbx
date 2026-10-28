//! Issue #13517: preserve PostgreSQL foreign key actions and deferral on backup/restore.
//! Uses the DBX_LIVE_POSTGRES_EXPORT_* variables documented by the sibling export tests.
//! Run with RUST_MIN_STACK=67108864 for the database export future.

use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, DatabaseExportRequest};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::sql::SqlFileRequest;
use std::sync::Arc;

fn config(id: &str, database: &str) -> ConnectionConfig {
    serde_json::from_value(serde_json::json!({
        "id": id, "name": id, "db_type": DatabaseType::Postgres,
        "host": std::env::var("DBX_LIVE_POSTGRES_EXPORT_HOST").unwrap(),
        "port": std::env::var("DBX_LIVE_POSTGRES_EXPORT_PORT").unwrap().parse::<u16>().unwrap(),
        "username": std::env::var("DBX_LIVE_POSTGRES_EXPORT_USER").unwrap(),
        "password": std::env::var("DBX_LIVE_POSTGRES_EXPORT_PASSWORD").unwrap_or_default(),
        "database": database, "ssl": false,
        "connect_timeout_secs": 10, "query_timeout_secs": 30,
        "idle_timeout_secs": 60, "keepalive_interval_secs": 0
    }))
    .unwrap()
}

async fn child_before_parent(database: &str) -> Result<(), String> {
    let mut connection = tokio_postgres::Config::new();
    connection
        .host(std::env::var("DBX_LIVE_POSTGRES_EXPORT_HOST").unwrap())
        .port(std::env::var("DBX_LIVE_POSTGRES_EXPORT_PORT").unwrap().parse().unwrap())
        .user(std::env::var("DBX_LIVE_POSTGRES_EXPORT_USER").unwrap())
        .password(std::env::var("DBX_LIVE_POSTGRES_EXPORT_PASSWORD").unwrap_or_default())
        .dbname(database);
    let (client, driver) = connection.connect(tokio_postgres::NoTls).await.unwrap();
    let driver = tokio::spawn(driver);
    let child = uuid::Uuid::new_v4();
    let parent = uuid::Uuid::new_v4();
    let version = uuid::Uuid::new_v4();
    let result = client
        .batch_execute(&format!(
            "BEGIN; \
             INSERT INTO public.child_table VALUES ('{child}', '{parent}', '{version}'); \
             INSERT INTO public.parent_table VALUES ('{parent}', '{version}'); COMMIT;"
        ))
        .await
        .map_err(|error| format!("{error:?}"));
    drop(client);
    driver.await.unwrap().unwrap();
    result
}

#[tokio::test]
#[ignore = "requires a disposable PostgreSQL endpoint; detects issue #13517"]
async fn live_postgres_export_preserves_foreign_key_actions_and_deferral() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source = format!("dbx_13517_src_{}", &suffix[..10]);
    let target = format!("dbx_13517_dst_{}", &suffix[..10]);
    let storage_dir = tempfile::tempdir().unwrap();
    let output = std::env::var_os("DBX_ISSUE_13517_OUTPUT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| storage_dir.path().to_path_buf());
    std::fs::create_dir_all(&output).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&storage_dir.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    for (id, database) in [("admin", "postgres"), ("source", &source), ("target", &target)] {
        state.configs.write().await.insert(id.to_string(), config(id, database));
    }
    for database in [&source, &target] {
        execute_sql_statement(&state, "admin", "postgres", &format!("CREATE DATABASE \"{database}\""), None, None)
            .await
            .unwrap();
    }
    for statement in [
        "CREATE TABLE public.parent_table (id uuid NOT NULL, version_id uuid NOT NULL, \
         PRIMARY KEY (id), UNIQUE (id, version_id))",
        "CREATE TABLE public.child_table (id uuid PRIMARY KEY, parent_id uuid NOT NULL, \
         parent_version_id uuid NOT NULL, CONSTRAINT fk_child_parent \
         FOREIGN KEY (parent_id, parent_version_id) REFERENCES public.parent_table (id, version_id) \
         ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED)",
    ] {
        execute_sql_statement(&state, "source", &source, statement, None, None).await.unwrap();
    }
    let source_transaction = child_before_parent(&source).await;
    assert!(source_transaction.is_ok(), "source transaction: {source_transaction:?}");
    let catalog_sql = "SELECT condeferrable, condeferred, confupdtype::text, confdeltype::text, \
                       pg_get_constraintdef(oid) AS definition FROM pg_catalog.pg_constraint \
                       WHERE conrelid = 'public.child_table'::regclass AND conname = 'fk_child_parent'";
    let source_catalog = execute_sql_statement(&state, "source", &source, catalog_sql, None, None).await.unwrap();
    let constraints =
        dbx_core::schema::list_constraints_core(&state, "source", &source, "public", "child_table").await.unwrap();
    let foreign_keys =
        dbx_core::schema::list_foreign_keys_core(&state, "source", &source, "public", "child_table").await.unwrap();
    let ddl =
        dbx_core::schema::get_table_ddl_core(&state, "source", &source, "public", "child_table", None).await.unwrap();
    std::fs::write(output.join("source-dbx-ddl.sql"), &ddl).unwrap();
    let export_path = output.join("backup.sql");
    export_database_sql_core(
        &state,
        &DatabaseExportRequest {
            export_id: format!("issue-13517-{suffix}"),
            connection_id: "source".to_string(),
            database: source.clone(),
            schema: "public".to_string(),
            file_path: export_path.display().to_string(),
            selected_tables: Vec::new(),
            excluded_tables: Vec::new(),
            include_structure: true,
            include_data: true,
            include_objects: false,
            include_create_database: false,
            drop_table_if_exists: false,
            omit_auto_increment: false,
            preserve_original_language: false,
            fail_on_error: true,
            prevent_overwrite: false,
            output_compression: Default::default(),
            insert_dialect: Default::default(),
            insert_mode: Default::default(),
            snapshot_session_id: None,
            batch_size: 1000,
            split_max_mb: None,
        },
        |_| {},
    )
    .await
    .unwrap();
    let restore_request = SqlFileRequest {
        txn_session_id: None,
        execution_id: format!("issue-13517-restore-{suffix}"),
        connection_id: "target".to_string(),
        database: target.clone(),
        schema: Some("public".to_string()),
        file_path: export_path.display().to_string(),
        continue_on_error: false,
        selected_tables: None,
        part_cooldown_ms: 0,
        skip_relational_constraints: false,
        failure_log_enabled: true,
        resolve_includes: false,
        encoding: Default::default(),
    };
    dbx_core::sql_file_import::execute_sql_file_path(
        &state,
        &restore_request,
        &export_path,
        tokio_util::sync::CancellationToken::new(),
        std::time::Instant::now(),
        |_| {},
    )
    .await
    .unwrap();
    let target_catalog = execute_sql_statement(&state, "target", &target, catalog_sql, None, None).await.unwrap();
    let target_transaction = child_before_parent(&target).await;

    let report = serde_json::json!({
        "source_catalog": source_catalog.rows,
        "restored_catalog": target_catalog.rows,
        "source_constraint_metadata": constraints,
        "source_foreign_key_metadata": foreign_keys,
        "source_transaction": source_transaction,
        "restored_transaction": target_transaction,
        "source_dbx_ddl": ddl,
        "export_path": export_path
    });
    let report = serde_json::to_string_pretty(&report).unwrap();
    println!("{report}");
    std::fs::write(output.join("result.json"), report).unwrap();
    for database in [&source, &target] {
        execute_sql_statement(
            &state,
            "admin",
            "postgres",
            &format!("DROP DATABASE \"{database}\" WITH (FORCE)"),
            None,
            None,
        )
        .await
        .unwrap();
    }
    assert_eq!(source_catalog.rows, target_catalog.rows, "backup/restore changed foreign key attributes");
    assert!(target_transaction.is_ok(), "restored transaction: {target_transaction:?}");
}
