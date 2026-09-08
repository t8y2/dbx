use super::*;
use serde_json::json;

async fn sqlite_fixture() -> (tempfile::TempDir, Arc<AppState>, TransferRequest, String, String) {
    let directory = tempfile::tempdir().unwrap();
    let storage = crate::storage::Storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_dir(storage, directory.path().join("plugins")));
    for id in ["source", "target"] {
        let path = directory.path().join(format!("{id}.db"));
        crate::db::sqlite::connect_path_create_if_missing(path.to_str().unwrap()).await.unwrap();
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id": id, "name": id, "db_type": "sqlite", "host": path.to_str().unwrap(),
            "port": 0, "username": "", "password": "", "database": null,
            "one_time": false, "save_password": false, "read_only": false
        }))
        .unwrap();
        state.configs.write().await.insert(id.to_string(), config);
    }
    let source_pool = ensure_transfer_pool(&state, "source", "main", None).await.unwrap();
    let target_pool = ensure_transfer_pool(&state, "target", "main", None).await.unwrap();
    for table in ["orders", "users"] {
        execute_on_pool(&state, &source_pool, &format!("CREATE TABLE {table}(id INTEGER PRIMARY KEY, name TEXT)"))
            .await
            .unwrap();
        execute_on_pool(&state, &source_pool, &format!("INSERT INTO {table} VALUES(1, 'source')")).await.unwrap();
        execute_on_pool(&state, &target_pool, &format!("CREATE TABLE {table}(id INTEGER PRIMARY KEY, old_value TEXT)"))
            .await
            .unwrap();
        execute_on_pool(&state, &target_pool, &format!("INSERT INTO {table} VALUES(99, 'original')")).await.unwrap();
    }
    let request: TransferRequest = serde_json::from_value(json!({
        "transferId": uuid::Uuid::new_v4().to_string(),
        "sourceConnectionId": "source", "sourceDatabase": "main", "sourceSchema": "main",
        "targetConnectionId": "target", "targetDatabase": "main", "targetSchema": "main",
        "tables": ["orders", "users"], "createTable": true, "content": "structureAndData",
        "mode": "append", "batchSize": 1, "dropTargetBeforeCreate": true,
        "dropTargetConfirmed": true
    }))
    .unwrap();
    (directory, state, request, source_pool, target_pool)
}

#[tokio::test]
async fn transfer_rebuild_preflights_every_backup_collision_before_renaming_any_table() {
    let (_directory, state, request, _, target_pool) = sqlite_fixture().await;
    let backup =
        crate::transfer_rebuild::backup_table_name(DatabaseType::Sqlite, &request.transfer_id, "main.users", "users")
            .unwrap();
    execute_on_pool(&state, &target_pool, &format!("CREATE TABLE \"{backup}\"(id INTEGER)")).await.unwrap();
    let result =
        rename_tables_to_backup(&state, &request, &request.tables, DatabaseType::Sqlite, &target_pool, |_| {}).await;
    assert!(result.is_err(), "a preexisting backup must block the operation");
    let original = execute_read_on_pool(&state, &target_pool, "SELECT old_value FROM orders WHERE id=99").await;
    assert!(original.is_ok(), "a collision on users must not rename orders: {original:?}");
    assert_eq!(original.unwrap().rows[0][0], json!("original"));
}

#[tokio::test]
async fn transfer_rebuild_cancellation_remains_a_cancellation_after_backup() {
    let (_directory, state, mut request, source_pool, target_pool) = sqlite_fixture().await;
    request.tables = vec!["orders".into()];
    let backups =
        rename_tables_to_backup(&state, &request, &request.tables, DatabaseType::Sqlite, &target_pool, |_| {})
            .await
            .unwrap();
    set_cancelled(&request.transfer_id).await;
    let result = transfer_table(
        &state,
        &request,
        "orders",
        0,
        &DatabaseType::Sqlite,
        &DatabaseType::Sqlite,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        Some(&backups),
        |_| {},
    )
    .await;
    clear_cancelled(&request.transfer_id).await;
    assert_eq!(result.unwrap_err(), "Cancelled", "recovery details must not change the cancellation discriminator");
}

#[tokio::test]
async fn transfer_rebuild_preview_plans_without_executing_ddl() {
    let (_directory, state, request, source_pool, target_pool) = sqlite_fixture().await;
    let preview = preview_transfer_ownership(
        &state,
        &request,
        &DatabaseType::Sqlite,
        &DatabaseType::Sqlite,
        &source_pool,
        &target_pool,
    )
    .await
    .unwrap();
    let rebuild = preview.rebuild.expect("a rebuild transfer must expose its SQL plan");

    assert_eq!(rebuild.tables.len(), 2, "every source table must be mapped: {:?}", rebuild.tables);
    for table in &rebuild.tables {
        assert!(table.backup_table.is_some(), "preexisting targets must carry a backup name: {table:?}");
    }
    assert!(rebuild.sql.contains("-- 1. Backup existing target tables"), "{}", rebuild.sql);
    assert!(rebuild.sql.contains("-- 2. Recreate the"), "{}", rebuild.sql);
    assert!(rebuild.sql.contains("-- 3. Drop backups after success"), "{}", rebuild.sql);

    // The preview must be pure planning: neither table may have been renamed aside.
    for table in ["orders", "users"] {
        let rows =
            execute_read_on_pool(&state, &target_pool, &format!("SELECT old_value FROM {table} WHERE id=99")).await;
        assert!(rows.is_ok(), "preview must not rename {table}: {rows:?}");
        assert_eq!(rows.unwrap().rows[0][0], json!("original"));
    }
}
