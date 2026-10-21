use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::transfer::{
    ensure_transfer_pool, transfer_schema_objects, transfer_table, TransferColumnNameCase, TransferContent,
    TransferMode, TransferObjectKind, TransferObjectSelection, TransferOwnershipPolicy, TransferRequest,
    TransferTableNameCase,
};
use std::sync::Arc;

fn live_oracle_config(id: &str, username: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_ORACLE_HOST").expect("DBX_LIVE_ORACLE_HOST");
    let port = std::env::var("DBX_LIVE_ORACLE_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(1521);
    let service = std::env::var("DBX_LIVE_ORACLE_SERVICE").expect("DBX_LIVE_ORACLE_SERVICE");
    let password = std::env::var("DBX_LIVE_ORACLE_PASSWORD").expect("DBX_LIVE_ORACLE_PASSWORD");

    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Oracle,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": service,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 60,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live Oracle config should deserialize")
}

fn cells(result: &dbx_core::types::QueryResult) -> Vec<String> {
    result
        .rows
        .iter()
        .filter_map(|row| row.first())
        .map(|value| match value {
            serde_json::Value::String(value) => value.clone(),
            value => value.to_string(),
        })
        .collect()
}

/// Both users must own disposable schemas and share `DBX_LIVE_ORACLE_PASSWORD`.
#[tokio::test]
#[ignore = "requires DBX_LIVE_ORACLE_SOURCE_USER and DBX_LIVE_ORACLE_TARGET_USER on a disposable Oracle"]
async fn live_oracle_transfer_creates_table_with_index_comment_and_trigger() {
    let suffix = uuid::Uuid::new_v4().simple().to_string()[..8].to_uppercase();
    let dir = std::env::temp_dir().join(format!("dbx-live-oracle-transfer-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let service = std::env::var("DBX_LIVE_ORACLE_SERVICE").unwrap();
    let source_schema =
        std::env::var("DBX_LIVE_ORACLE_SOURCE_USER").expect("DBX_LIVE_ORACLE_SOURCE_USER").to_uppercase();
    let target_schema =
        std::env::var("DBX_LIVE_ORACLE_TARGET_USER").expect("DBX_LIVE_ORACLE_TARGET_USER").to_uppercase();
    let source_id = format!("live-oracle-transfer-src-{suffix}");
    let target_id = format!("live-oracle-transfer-dst-{suffix}");
    state.configs.write().await.insert(source_id.clone(), live_oracle_config(&source_id, &source_schema));
    state.configs.write().await.insert(target_id.clone(), live_oracle_config(&target_id, &target_schema));

    let table = format!("DBX_TRANSFER_ORDERS_{suffix}");
    let sequence = format!("DBX_TRANSFER_SEQ_{suffix}");
    let trigger = format!("DBX_TRANSFER_TRG_{suffix}");
    let run = |connection_id: String, schema: String, sql: String| {
        let state = state.clone();
        let service = service.clone();
        async move { execute_sql_statement(&state, &connection_id, &service, &sql, Some(&schema), None).await }
    };
    let source = |sql: String| run(source_id.clone(), source_schema.clone(), sql);
    let target = |sql: String| run(target_id.clone(), target_schema.clone(), sql);
    let drop_all = [format!("DROP TABLE {table} PURGE"), format!("DROP SEQUENCE {sequence}")];
    for sql in &drop_all {
        let _ = source(sql.clone()).await;
        let _ = target(sql.clone()).await;
    }

    for sql in [
        format!("CREATE TABLE {table} (ID NUMBER PRIMARY KEY, NOTE VARCHAR2(50))"),
        format!("CREATE INDEX {table}_NOTE_IX ON {table} (NOTE)"),
        format!("COMMENT ON TABLE {table} IS 'transfer orders'"),
        format!("CREATE SEQUENCE {sequence} START WITH 100 INCREMENT BY 5 NOCACHE"),
        format!(
            "CREATE OR REPLACE TRIGGER {trigger} BEFORE INSERT ON {table} FOR EACH ROW\n\
             BEGIN\n  IF :NEW.ID IS NULL THEN SELECT {sequence}.NEXTVAL INTO :NEW.ID FROM DUAL; END IF;\nEND;"
        ),
        format!("INSERT INTO {table} (NOTE) VALUES ('first')"),
    ] {
        source(sql).await.expect("source setup");
    }

    let request = TransferRequest {
        table_filters: Default::default(),
        transfer_id: format!("live-oracle-transfer-{suffix}"),
        source_connection_id: source_id.clone(),
        source_database: service.clone(),
        source_schema: source_schema.clone(),
        source_catalog: None,
        target_connection_id: target_id.clone(),
        target_database: service.clone(),
        target_schema: target_schema.clone(),
        target_catalog: None,
        tables: vec![table.clone()],
        create_table: true,
        drop_target_before_create: false,
        drop_target_confirmed: false,
        content: TransferContent::StructureAndData,
        objects: Some(vec![
            TransferObjectSelection { object_type: TransferObjectKind::Sequence, names: vec![sequence.clone()] },
            TransferObjectSelection { object_type: TransferObjectKind::Trigger, names: vec![trigger.clone()] },
        ]),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        target_column_name_case: TransferColumnNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 100,
    };
    let source_pool = ensure_transfer_pool(&state, &source_id, &service, None).await.unwrap();
    let target_pool = ensure_transfer_pool(&state, &target_id, &service, None).await.unwrap();
    let table_result = transfer_table(
        &state,
        &request,
        &table,
        0,
        &DatabaseType::Oracle,
        &DatabaseType::Oracle,
        &source_pool,
        &target_pool,
        &Default::default(),
        &mut Vec::new(),
        None,
        |_| {},
    )
    .await;
    let mut object_errors = Vec::new();
    let objects_result = transfer_schema_objects(&state, &request, &source_pool, &target_pool, |progress| {
        object_errors.extend(progress.error);
    })
    .await;

    let indexes = target(format!("SELECT INDEX_NAME FROM USER_INDEXES WHERE TABLE_NAME = '{table}'")).await;
    let comment = target(format!("SELECT COMMENTS FROM USER_TAB_COMMENTS WHERE TABLE_NAME = '{table}'")).await;
    let trigger_state = target(format!(
        "SELECT o.STATUS || '/' || t.STATUS || '/' || t.TABLE_OWNER FROM USER_OBJECTS o \
         JOIN USER_TRIGGERS t ON t.TRIGGER_NAME = o.OBJECT_NAME WHERE o.OBJECT_NAME = '{trigger}'"
    ))
    .await;
    let insert = target(format!("INSERT INTO {table} (NOTE) VALUES ('after')")).await;
    let ids = target(format!("SELECT ID FROM {table} ORDER BY ID")).await;
    let source_triggers = source(format!("SELECT COUNT(*) FROM ALL_TRIGGERS WHERE TABLE_NAME = '{table}'")).await;

    for sql in &drop_all {
        let _ = source(sql.clone()).await;
        let _ = target(sql.clone()).await;
    }
    let _ = std::fs::remove_dir_all(dir);

    assert_eq!(table_result, Ok(1));
    let objects = objects_result.expect("schema objects");
    assert!(objects.failed.is_empty(), "{objects:?} {object_errors:?}");
    assert!(cells(&indexes.unwrap()).contains(&format!("{table}_NOTE_IX")));
    assert_eq!(cells(&comment.unwrap()), vec!["transfer orders".to_string()]);
    assert_eq!(cells(&trigger_state.unwrap()), vec![format!("VALID/ENABLED/{target_schema}")]);
    insert.expect("the transferred trigger fills ID from the transferred sequence");
    assert_eq!(cells(&ids.unwrap()), vec!["100".to_string(), "105".to_string()]);
    assert_eq!(cells(&source_triggers.unwrap()), vec!["1".to_string()]);
}

/// Like the test above, but the two users must have different default tablespaces and
/// the target user must have no quota on the source user's default tablespace.
#[tokio::test]
#[ignore = "requires DBX_LIVE_ORACLE_SOURCE_USER and DBX_LIVE_ORACLE_TARGET_USER with separate default tablespaces"]
async fn live_oracle_transfer_places_tables_in_target_default_tablespace() {
    let suffix = uuid::Uuid::new_v4().simple().to_string()[..8].to_uppercase();
    let dir = std::env::temp_dir().join(format!("dbx-live-oracle-transfer-ts-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let service = std::env::var("DBX_LIVE_ORACLE_SERVICE").unwrap();
    let source_schema =
        std::env::var("DBX_LIVE_ORACLE_SOURCE_USER").expect("DBX_LIVE_ORACLE_SOURCE_USER").to_uppercase();
    let target_schema =
        std::env::var("DBX_LIVE_ORACLE_TARGET_USER").expect("DBX_LIVE_ORACLE_TARGET_USER").to_uppercase();
    let source_id = format!("live-oracle-transfer-ts-src-{suffix}");
    let target_id = format!("live-oracle-transfer-ts-dst-{suffix}");
    state.configs.write().await.insert(source_id.clone(), live_oracle_config(&source_id, &source_schema));
    state.configs.write().await.insert(target_id.clone(), live_oracle_config(&target_id, &target_schema));

    let filled = format!("DBX_TRANSFER_TS_FILLED_{suffix}");
    let empty = format!("DBX_TRANSFER_TS_EMPTY_{suffix}");
    let run = |connection_id: String, schema: String, sql: String| {
        let state = state.clone();
        let service = service.clone();
        async move { execute_sql_statement(&state, &connection_id, &service, &sql, Some(&schema), None).await }
    };
    let source = |sql: String| run(source_id.clone(), source_schema.clone(), sql);
    let target = |sql: String| run(target_id.clone(), target_schema.clone(), sql);
    let drop_all = [format!("DROP TABLE {filled} PURGE"), format!("DROP TABLE {empty} PURGE")];
    for sql in &drop_all {
        let _ = source(sql.clone()).await;
        let _ = target(sql.clone()).await;
    }

    let default_tablespace = "SELECT DEFAULT_TABLESPACE FROM USER_USERS".to_string();
    let source_tablespace = cells(&source(default_tablespace.clone()).await.unwrap());
    let target_tablespace = cells(&target(default_tablespace).await.unwrap());
    assert_ne!(source_tablespace, target_tablespace, "the users must have different default tablespaces");

    for sql in [
        format!("CREATE TABLE {filled} (ID NUMBER PRIMARY KEY, NOTE VARCHAR2(50), BODY CLOB)"),
        format!("CREATE INDEX {filled}_NOTE_IX ON {filled} (NOTE)"),
        format!("INSERT INTO {filled} VALUES (1, 'first', 'body')"),
        format!("CREATE TABLE {empty} (ID NUMBER PRIMARY KEY, BODY CLOB)"),
    ] {
        source(sql).await.expect("source setup");
    }

    let request = TransferRequest {
        table_filters: Default::default(),
        transfer_id: format!("live-oracle-transfer-ts-{suffix}"),
        source_connection_id: source_id.clone(),
        source_database: service.clone(),
        source_schema: source_schema.clone(),
        source_catalog: None,
        target_connection_id: target_id.clone(),
        target_database: service.clone(),
        target_schema: target_schema.clone(),
        target_catalog: None,
        tables: vec![filled.clone(), empty.clone()],
        create_table: true,
        drop_target_before_create: false,
        drop_target_confirmed: false,
        content: TransferContent::StructureAndData,
        objects: None,
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        target_column_name_case: TransferColumnNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 100,
    };
    let source_pool = ensure_transfer_pool(&state, &source_id, &service, None).await.unwrap();
    let target_pool = ensure_transfer_pool(&state, &target_id, &service, None).await.unwrap();
    let mut results = Vec::new();
    for (index, table) in [&filled, &empty].into_iter().enumerate() {
        results.push(
            transfer_table(
                &state,
                &request,
                table,
                index,
                &DatabaseType::Oracle,
                &DatabaseType::Oracle,
                &source_pool,
                &target_pool,
                &Default::default(),
                &mut Vec::new(),
                None,
                |_| {},
            )
            .await,
        );
    }
    let in_tables = format!("('{filled}', '{empty}')");
    let segment_tablespaces = target(format!(
        "SELECT DISTINCT TABLESPACE_NAME FROM (\
         SELECT TABLESPACE_NAME FROM USER_TABLES WHERE TABLE_NAME IN {in_tables} \
         UNION ALL SELECT TABLESPACE_NAME FROM USER_INDEXES WHERE TABLE_NAME IN {in_tables} \
         UNION ALL SELECT TABLESPACE_NAME FROM USER_LOBS WHERE TABLE_NAME IN {in_tables})"
    ))
    .await;
    // The empty table has no segment yet, so only a write proves the target can use it.
    let insert = target(format!("INSERT INTO {empty} VALUES (1, 'body')")).await;

    for sql in &drop_all {
        let _ = source(sql.clone()).await;
        let _ = target(sql.clone()).await;
    }
    let _ = std::fs::remove_dir_all(dir);

    assert_eq!(results, vec![Ok(1), Ok(0)]);
    assert_eq!(cells(&segment_tablespaces.unwrap()), target_tablespace);
    insert.expect("the empty table accepts rows in the target tablespace");
}
