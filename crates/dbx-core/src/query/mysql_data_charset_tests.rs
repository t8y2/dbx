use super::{mysql_data_charset_policy as policy, tests::test_connection_config, *};

#[test]
fn mysql_data_charset_server_preview_is_pending_and_original_keys_are_rebased() {
    use dbx_types::types::OriginalKeyCell;
    let mut result = empty_query_result(0);
    result.columns = vec!["text".into(), "__DBX_LARGE_VALUE_BYTES_T_0".into(), "key".into()];
    result.rows = vec![
        vec![serde_json::json!("çÍ·×"), serde_json::json!("T:3:96000"), serde_json::json!("中文")],
        vec![serde_json::json!("ÖÐÎÄ"), serde_json::json!("T:8:4"), serde_json::json!("中文")],
        vec![serde_json::json!("ÖÐÎÄ\u{81}"), serde_json::json!("T:8:5"), serde_json::json!("other")],
    ];
    result.raw_key_cells = vec![
        OriginalKeyCell { row_index: 0, column_index: 2, value: serde_json::json!("ÖÐÎÄ") },
        OriginalKeyCell { row_index: 1, column_index: 2, value: serde_json::json!("中文") },
        OriginalKeyCell { row_index: 2, column_index: 2, value: serde_json::json!("other") },
    ];
    let cells = extract_server_large_value_markers_with_charset(&mut result, Some(db::mysql::MySqlDataCharset::Gbk));
    assert_eq!(cells.len(), 1);
    assert_eq!(cells[0].pending_decode, Some(true));
    assert_eq!(cells[0].original_bytes, 96000);
    assert_eq!(result.rows[0][0], "");
    assert_eq!(result.rows[1][0], "中文");
    assert_eq!(result.rows[2][0], "ÖÐÎÄ\u{81}", "invalid complete suffix keeps the whole original carrier");
    assert_eq!(result.raw_key_cells[0].column_index, 1);
    assert_ne!(result.raw_key_cells[0].value, result.raw_key_cells[1].value);
    let truncated = truncate_result_with_max_rows(result, Some(2));
    assert_eq!(truncated.raw_key_cells.len(), 2);
    assert!(truncated.raw_key_cells.iter().all(|cell| cell.row_index < 2));
}

#[test]
fn mysql_data_charset_preview_keeps_upstream_deferred_cells() {
    let mut result = empty_query_result(0);
    result.columns = vec!["text".into(), "__DBX_LARGE_VALUE_BYTES_T_0".into(), "deferred".into()];
    result.rows = vec![vec![serde_json::json!("çÍ·×"), serde_json::json!("T:3:96000"), serde_json::json!("")]];
    result.deferred_large_value_cells = vec![db::LargeValueCell {
        row_index: 0,
        column_index: 2,
        original_bytes: 128000,
        value_ref: Some("deferred-ref".into()),
        pending_decode: None,
    }];
    for indexed in [false, true] {
        let output = if indexed {
            ExecuteMultiResult::success_with_index_and_large_values_and_charset(
                result.clone(),
                0,
                Vec::new(),
                true,
                Some(db::mysql::MySqlDataCharset::Gbk),
            )
        } else {
            ExecuteMultiResult::success_with_optional_server_large_values_and_charset(
                result.clone(),
                true,
                Some(db::mysql::MySqlDataCharset::Gbk),
            )
        };
        assert_eq!(output.result.columns, ["text", "deferred"]);
        assert!(output.result.deferred_large_value_cells.is_empty());
        assert_eq!(output.large_value_cells.len(), 2);
        let pending = output.large_value_cells.iter().find(|cell| cell.column_index == 0).unwrap();
        assert_eq!(pending.pending_decode, Some(true));
        let deferred = output.large_value_cells.iter().find(|cell| cell.column_index == 1).unwrap();
        assert_eq!(deferred.value_ref.as_deref(), Some("deferred-ref"));
        assert_eq!(deferred.original_bytes, 128000);
    }
}

#[test]
fn mysql_data_charset_pending_is_not_applied_to_json_binary_or_default_results() {
    for (alias, marker, codec, expected) in [
        ("T", "T:3:20", None, "çÍ·..."),
        ("J", "T:3:20", Some(db::mysql::MySqlDataCharset::Gbk), "çÍ·..."),
        ("B", "B:3:20", Some(db::mysql::MySqlDataCharset::Gbk), "0xaabbcc..."),
    ] {
        let mut result = empty_query_result(0);
        result.columns = vec!["value".into(), format!("__DBX_LARGE_VALUE_BYTES_{alias}_0")];
        result.rows =
            vec![vec![serde_json::json!(if alias == "B" { "0xaabbccdd" } else { "çÍ·×" }), serde_json::json!(marker)]];
        let cells = extract_server_large_value_markers_with_charset(&mut result, codec);
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].pending_decode, None);
        assert_eq!(result.rows[0][0], expected);
    }
}

async fn fixture() -> (tempfile::TempDir, Arc<AppState>) {
    let directory = tempfile::tempdir().unwrap();
    let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let mut config = test_connection_config(DatabaseType::Mysql);
    config.url_params = Some("dataCharset=GBK".into());
    state.configs.write().await.insert(config.id.clone(), config);
    (directory, state)
}

#[test]
fn compatibility_sql_rejects_session_changes_and_known_writes() {
    for sql in [
        "SET NAMES latin1",
        "SET @@session.character_set_results = 'gbk'",
        "/*!40101 SET NAMES latin1 */",
        "SELECT 1; SET NAMES gbk",
        "SELECT 1 /*!50000 INTO OUTFILE '/tmp/data' */",
        "PREPARE s FROM 'SET NAMES latin1'",
        "EXECUTE s",
        "UPDATE t SET v = '中文'",
        "INSERT INTO t VALUES ('中文')",
        "DELETE FROM t",
        "ALTER TABLE t ADD COLUMN v TEXT",
        "DROP TABLE t",
        "CALL mutate()",
        "WITH c AS (SELECT 1) UPDATE t SET v = 'new'",
        "SELECT 1; DELETE FROM t",
        "SELECT * FROM t INTO OUTFILE '/tmp/data'",
    ] {
        assert!(policy::check_sql(sql, "test").is_err(), "must reject {sql}");
    }
    for sql in [
        "SELECT 'SET NAMES latin1'",
        "SELECT '/*! SET NAMES latin1 */'",
        "/* SET NAMES latin1 */ SELECT 1",
        "SELECT 1; SELECT 2",
        "SHOW CREATE TABLE t",
        "WITH c AS (SELECT 1) SELECT * FROM c",
    ] {
        assert!(policy::check_sql(sql, "test").is_ok(), "must allow {sql}");
    }
}

#[tokio::test]
async fn compatibility_policy_precedes_unlock_and_preserves_stored_readonly() {
    let (_directory, state) = fixture().await;
    assert!(unlock_connection_writes_core(&state, "conn-1", 60).await.unwrap_err().starts_with(policy::READ_ONLY));
    assert_eq!(state.write_unlock_windows.remaining_ms("conn-1").await, 0);
    state.write_unlock_windows.unlock("conn-1", 60).await.unwrap();
    assert!(check_read_only_for_connection(&state, "conn-1:db", "UPDATE t SET v=1").await.is_err());
    assert!(check_read_only_for_connection_multi(&state, "conn-1:db", &["SELECT 1", "DELETE FROM t"]).await.is_err());
    assert!(connection_readonly_name(&state, "conn-1").await.is_some());
    assert!(policy::reject_operation(&state, "conn-1", policy::READ_ONLY).await.is_err());
    assert!(check_read_only_for_connection(&state, "conn-1", "SELECT 1").await.is_ok());
    assert!(!state.configs.read().await["conn-1"].read_only);

    state.configs.write().await.get_mut("conn-1").unwrap().url_params = None;
    assert!(unlock_connection_writes_core(&state, "conn-1", 60).await.unwrap() > 0);
    assert!(check_read_only_for_connection(&state, "conn-1", "UPDATE t SET v=1").await.is_ok());
    assert!(policy::reject_operation(&state, "conn-1", policy::READ_ONLY).await.is_ok());
    state.configs.write().await.get_mut("conn-1").unwrap().read_only = true;
    assert!(check_read_only_for_connection(&state, "conn-1", "UPDATE t SET v=1").await.is_ok());
    state.write_unlock_windows.lock("conn-1").await;
    assert!(check_read_only_for_connection(&state, "conn-1", "UPDATE t SET v=1").await.is_err());
    assert!(state.configs.read().await["conn-1"].read_only);
}

#[tokio::test]
async fn compatibility_policy_keeps_pinned_session_protected_after_config_change() {
    let (_directory, state) = fixture().await;
    let mut session = super::tests::idle_test_session(Duration::from_secs(300));
    session.connection_id = "conn-1".into();
    session.pool_key = "conn-1:db".into();
    session.mysql_data_charset = Some(db::mysql::MySqlDataCharset::Gbk);
    state.transaction_sessions.write().await.insert("legacy-txn".into(), session);
    state.configs.write().await.get_mut("conn-1").unwrap().url_params = None;
    state.write_unlock_windows.unlock("conn-1", 60).await.unwrap();
    assert!(check_read_only_for_connection(&state, "conn-1:db", "DELETE FROM t").await.is_err());
    assert!(policy::check_export(&state, "conn-1", "sql").await.is_err());
    assert!(policy::reject_operation(&state, "conn-1", policy::READ_ONLY).await.is_err());
    // The empty fake handle would fail differently if dispatch reached the driver.
    let error =
        execute_in_manual_transaction(&state, "legacy-txn", "UPDATE t SET v=1", "db", None, None).await.unwrap_err();
    assert!(error.starts_with(policy::READ_ONLY), "{error}");
    let config = state.configs.write().await.remove("conn-1").unwrap();
    assert!(check_read_only_for_connection(&state, "conn-1:db", "DELETE FROM t").await.is_err());
    state.configs.write().await.insert(config.id.clone(), config);
    state.transaction_sessions.write().await.remove("legacy-txn");
    assert!(check_read_only_for_connection(&state, "conn-1", "DELETE FROM t").await.is_ok());
}

#[tokio::test]
async fn compatibility_policy_is_mysql_only_and_invalid_options_fail_closed() {
    let (_directory, state) = fixture().await;
    state.configs.write().await.get_mut("conn-1").unwrap().db_type = DatabaseType::Postgres;
    assert!(check_read_only_for_connection(&state, "conn-1", "DELETE FROM t").await.is_ok());
    let mut configs = state.configs.write().await;
    let config = configs.get_mut("conn-1").unwrap();
    config.db_type = DatabaseType::Mysql;
    config.url_params = Some("dataCharset=unsupported".into());
    drop(configs);
    assert!(check_read_only_for_connection(&state, "conn-1", "SELECT 1").await.is_err());
    assert!(connection_readonly_name(&state, "conn-1").await.is_some());
}

#[tokio::test]
async fn compatibility_exports_fail_before_touching_destination_or_pool() {
    let (directory, state) = fixture().await;
    let destination = directory.path().join("preserve.sql");
    std::fs::write(&destination, b"preserve existing output").unwrap();
    for format in ["sql", "txt", "markdown"] {
        let table: crate::table_export::TableExportRequest = serde_json::from_value(serde_json::json!({
            "exportId":"legacy-export", "connectionId":"conn-1", "database":"db", "schema":null,
            "tableName":"t", "filePath":destination, "format":format
        }))
        .unwrap();
        let error =
            crate::table_export::export_table_data_core(&state, &table, |_| panic!("must reject before progress"))
                .await
                .unwrap_err();
        assert!(error.starts_with(policy::EXPORT_UNSUPPORTED), "{error}");
        let completion = crate::table_export::export_table_data_core_with_completion(&state, &table, |_| {
            panic!("must reject before progress")
        })
        .await;
        assert!(completion.result.unwrap_err().starts_with(policy::EXPORT_UNSUPPORTED));
        assert!(completion.cleanup.is_ok());
        let query: crate::query_result_export::QueryResultExportRequest = serde_json::from_value(serde_json::json!({
            "exportId":"legacy-query-export", "connectionId":"conn-1", "database":"db", "sql":"SELECT 1",
            "queryBaseSql":"SELECT 1", "databaseType":"mysql", "filePath":destination, "format":format,
            "pageSize":100
        }))
        .unwrap();
        let error = crate::query_result_export::export_query_result_core(&state, &query, None, |_| {
            panic!("must reject before progress")
        })
        .await
        .unwrap_err();
        assert!(error.starts_with(policy::EXPORT_UNSUPPORTED), "{error}");
        let completion =
            crate::query_result_export::export_query_result_core_with_completion(&state, &query, None, |_| {
                panic!("must reject before progress")
            })
            .await;
        assert!(completion.result.unwrap_err().starts_with(policy::EXPORT_UNSUPPORTED));
        assert!(completion.cleanup.is_ok());
    }
    let backup: crate::database_export::DatabaseExportRequest = serde_json::from_value(serde_json::json!({
        "exportId":"legacy-backup", "connectionId":"conn-1", "database":"db", "schema":"db",
        "filePath":destination, "includeStructure":true, "includeData":true, "includeObjects":true, "batchSize":100
    }))
    .unwrap();
    assert!(crate::database_export::export_database_sql_core(&state, &backup, |_| panic!(
        "must reject before progress"
    ))
    .await
    .unwrap_err()
    .starts_with(policy::EXPORT_UNSUPPORTED));
    assert!(crate::database_export::begin_database_backup_snapshot_core(&state, "conn-1", "db")
        .await
        .unwrap_err()
        .starts_with(policy::EXPORT_UNSUPPORTED));
    for format in ["csv", "JSON", "xlsx"] {
        policy::check_export(&state, "conn-1", format).await.unwrap();
    }
    assert_eq!(std::fs::read(&destination).unwrap(), b"preserve existing output");
    assert!(state.connection_pools_snapshot().await.is_empty());
}

#[tokio::test]
async fn compatibility_imports_and_direct_write_executor_fail_before_io() {
    let (directory, state) = fixture().await;
    let request: crate::sql::SqlFileRequest = serde_json::from_value(serde_json::json!({
        "executionId":"legacy-import", "connectionId":"conn-1", "database":"db",
        "filePath":directory.path().join("does-not-exist.sql"), "continueOnError":false
    }))
    .unwrap();
    let error = crate::sql_file_import::execute_sql_file_content(
        &state,
        &request,
        "DELETE FROM t",
        CancellationToken::new(),
        std::time::Instant::now(),
        |_| panic!("no import progress"),
    )
    .await
    .unwrap_err();
    assert!(error.starts_with(policy::READ_ONLY), "{error}");
    let error = crate::sql_file_import::execute_sql_file_path(
        &state,
        &request,
        std::path::Path::new(&request.file_path),
        CancellationToken::new(),
        std::time::Instant::now(),
        |_| panic!("no import progress"),
    )
    .await
    .unwrap_err();
    assert!(error.starts_with(policy::READ_ONLY), "{error}");
    let error =
        crate::transfer::execute_on_pool(&state, "conn-1:db", "ALTER TABLE t ADD COLUMN v TEXT").await.unwrap_err();
    assert!(error.starts_with(policy::READ_ONLY), "{error}");
    let table: crate::table_import::TableImportRequest = serde_json::from_value(serde_json::json!({
        "importId":"legacy-table-import", "connectionId":"conn-1", "database":"db", "schema":"db",
        "table":"t", "filePath":directory.path().join("does-not-exist.csv"), "mappings":[], "mode":"append", "batchSize":100
    })).unwrap();
    let error = crate::table_import::import_table_file_core(
        &state,
        &table,
        &DatabaseType::Mysql,
        "conn-1:db",
        |_| Box::pin(async { false }),
        |_| panic!("no table import progress"),
    )
    .await
    .unwrap_err();
    assert!(error.starts_with(policy::READ_ONLY), "{error}");
    assert!(state.connection_pools_snapshot().await.is_empty());
}

#[tokio::test]
async fn compatibility_transfer_rejects_source_and_target_before_dispatch() {
    let (_directory, state) = fixture().await;
    let mut ordinary = test_connection_config(DatabaseType::Mysql);
    ordinary.id = "ordinary".into();
    state.configs.write().await.insert(ordinary.id.clone(), ordinary);
    for (source, target) in [("conn-1", "ordinary"), ("ordinary", "conn-1")] {
        let request: crate::transfer::TransferRequest = serde_json::from_value(serde_json::json!({
            "transferId":"legacy-transfer", "sourceConnectionId":source, "sourceDatabase":"db", "sourceSchema":"db",
            "targetConnectionId":target, "targetDatabase":"db", "targetSchema":"db",
            "tables":["t"], "createTable":true, "batchSize":100
        }))
        .unwrap();
        assert!(crate::transfer::check_data_charset_transfer(&state, &request)
            .await
            .unwrap_err()
            .starts_with(policy::TRANSFER_UNSUPPORTED));
        let error = crate::transfer::transfer_schema_objects(&state, &request, source, target, |_| {
            panic!("no transfer progress")
        })
        .await
        .unwrap_err();
        assert!(error.starts_with(policy::TRANSFER_UNSUPPORTED), "{error}");
        let error = crate::transfer::transfer_table_with_result(
            &state,
            &request,
            "t",
            0,
            &DatabaseType::Mysql,
            &DatabaseType::Mysql,
            source,
            target,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            false,
            |_| panic!("no transfer progress"),
            |_| panic!("no source read"),
        )
        .await
        .unwrap_err();
        assert!(error.starts_with(policy::TRANSFER_UNSUPPORTED), "{error}");
    }
    assert!(state.connection_pools_snapshot().await.is_empty());
}

#[tokio::test]
async fn compatibility_schema_transfer_rejects_before_data_only_shortcut_or_package_approval() {
    let (_directory, state) = fixture().await;
    for (source, target) in [("conn-1", "unconfigured"), ("unconfigured", "conn-1")] {
        for content in ["dataOnly", "structureOnly", "structureAndData"] {
            for packages in [false, true] {
                let request: crate::transfer::TransferRequest = serde_json::from_value(serde_json::json!({
                    "transferId": "legacy-schema-transfer", "sourceConnectionId": source,
                    "sourceDatabase": "db", "sourceSchema": "db", "targetConnectionId": target,
                    "targetDatabase": "db", "targetSchema": "db", "tables": [],
                    "createTable": false, "batchSize": 100, "content": content,
                    "objects": if packages { serde_json::json!([{"objectType":"PACKAGE_BODY", "names":["pkg"]}]) } else { serde_json::json!([]) },
                })).unwrap();
                let error = crate::transfer::transfer_schema_objects(
                    &state,
                    &request,
                    "missing-source",
                    "missing-target",
                    |_| panic!("policy rejection must precede package approval progress"),
                )
                .await
                .unwrap_err();
                assert!(error.starts_with(policy::TRANSFER_UNSUPPORTED), "{content}, packages={packages}: {error}");
                let error = crate::transfer::transfer_schema_objects_with_routine_context(
                    &state,
                    &request,
                    "missing-source",
                    "missing-target",
                    None,
                    |_| panic!("direct inner entry must retain the same protection"),
                )
                .await
                .unwrap_err();
                assert!(error.starts_with(policy::TRANSFER_UNSUPPORTED), "{error}");
            }
        }
    }
    assert!(state.connection_pools_snapshot().await.is_empty());
}
