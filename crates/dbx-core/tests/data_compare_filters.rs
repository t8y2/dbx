use dbx_core::connection::{AppState, PoolKind};
use dbx_core::data_compare::{
    build_data_compare_sync_plan, prepare_data_compare_from_tables, prepare_data_compare_missing_target,
    DataCompareFromTablesOptions, DataCompareMissingTargetOptions,
};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use serde_json::{json, Value};

async fn fixture() -> (AppState, tempfile::TempDir, dbx_core::db::sqlite::SqliteHandle) {
    let directory = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("state.db")).await.unwrap();
    let state = AppState::new(storage);
    let pool = dbx_core::db::sqlite::connect_path(":memory:").await.unwrap();
    pool.with_connection(|connection| {
        connection
            .execute_batch(
                "CREATE TABLE source_items (id INTEGER PRIMARY KEY, payload TEXT, cohort INTEGER);
                 CREATE TABLE target_items (id INTEGER PRIMARY KEY, payload TEXT, cohort INTEGER);
                 INSERT INTO source_items VALUES
                   (1, 'one', 1), (2, 'two', 0), (3, 'new', 1),
                   (4, 'four', 1), (5, 'five', 0), (6, 'six', 1);
                 INSERT INTO target_items VALUES
                   (1, 'one', 2), (2, 'two', 0), (3, 'old', 2),
                   (4, 'four', 0), (5, 'five', 2), (6, 'six', 2);
                 CREATE TABLE source_nullable (id INTEGER, payload TEXT, cohort INTEGER);
                 CREATE TABLE target_nullable (id INTEGER, payload TEXT, cohort INTEGER);
                 INSERT INTO source_nullable VALUES (NULL, 'null', 1), (1, 'excluded', 0), (2, 'new', 1);
                 INSERT INTO target_nullable VALUES (NULL, 'null', 1), (1, 'outdated', 0), (2, 'old', 1);",
            )
            .map_err(|error| error.to_string())
    })
    .unwrap();
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id": "compare-filter", "name": "compare filter", "db_type": DatabaseType::Sqlite,
        "host": "", "port": 0, "username": "", "password": "", "database": ":memory:"
    }))
    .unwrap();
    state.configs.write().await.insert(config.id.clone(), config);
    state
        .update_connection_pools(|connections| {
            connections.insert("compare-filter".to_string(), PoolKind::Sqlite(pool.clone()));
        })
        .await;
    (state, directory, pool)
}

fn options() -> Value {
    json!({
        "sourceConnectionId": "compare-filter", "sourceDatabase": "", "sourceSchema": "main",
        "sourceTable": "source_items", "targetConnectionId": "compare-filter", "targetDatabase": "",
        "targetSchema": "main", "targetTable": "target_items", "columns": ["id", "payload"],
        "keyColumns": ["id"], "fetchBatchSize": 1,
    })
}

#[tokio::test]
async fn data_compare_filters_independently_count_and_page_each_side() {
    let (state, _directory, _pool) = fixture().await;
    let mut options = options();
    options["sourceFilter"] = json!("cohort = 1");
    options["targetFilter"] = json!("cohort = 2");
    options["degradationThreshold"] = json!({
        "fullCompareMaxRows": 5, "sampleMaxRows": 100, "sampleSize": 2, "extremeSampleCount": 1
    });
    let result = prepare_data_compare_from_tables(&state, serde_json::from_value(options).unwrap()).await.unwrap();
    assert_eq!((result.source_row_count, result.target_row_count), (4, 4));
    assert_eq!(result.degradation_level.as_deref(), Some("full"));
    assert_eq!(result.result.added.len(), 1);
    assert_eq!(result.result.added[0].values["id"], json!(4));
    assert_eq!(result.result.removed.len(), 1);
    assert_eq!(result.result.removed[0].values["id"], json!(5));
    assert_eq!(result.result.modified.len(), 1);
    assert_eq!(result.result.modified[0].key_values["id"], json!(3));
    assert!(result.sync_eligible);
    assert!(!result.source_truncated && !result.target_truncated);
}

#[tokio::test]
async fn data_compare_filters_allow_one_side_empty_or_legacy_requests() {
    let (state, _directory, _pool) = fixture().await;
    for (source, target, expected) in [
        (Some("cohort = 1"), None, (4, 6)),
        (None, Some("cohort = 2"), (6, 4)),
        (Some(" \n\t "), Some(""), (6, 6)),
        (None, None, (6, 6)),
        (Some("id < 0"), Some("id < 0"), (0, 0)),
    ] {
        let mut options = options();
        if let Some(source) = source {
            options["sourceFilter"] = json!(source);
        }
        if let Some(target) = target {
            options["targetFilter"] = json!(target);
        }
        let options: DataCompareFromTablesOptions = serde_json::from_value(options).unwrap();
        let result = prepare_data_compare_from_tables(&state, options).await.unwrap();
        assert_eq!((result.source_row_count, result.target_row_count), expected);
    }
}

#[tokio::test]
async fn data_compare_filters_apply_to_missing_target_and_its_budget() {
    let (state, _directory, _pool) = fixture().await;
    let mut options = options();
    options["sourceFilter"] = json!("cohort = 1");
    options["targetTable"] = json!("not_created");
    options["degradationThreshold"] = json!({
        "fullCompareMaxRows": 3, "sampleMaxRows": 100, "sampleSize": 2, "extremeSampleCount": 1
    });
    let options: DataCompareMissingTargetOptions = serde_json::from_value(options).unwrap();
    let result = prepare_data_compare_missing_target(&state, options).await.unwrap();
    assert_eq!(result.source_row_count, 4);
    assert_eq!(
        result.result.added.iter().map(|row| row.values["id"].clone()).collect::<Vec<_>>(),
        vec![json!(1), json!(3), json!(4)]
    );
    assert!(result.source_truncated);
    assert!(!result.sync_eligible);
    assert!(result.sync_statements.is_empty());
}

#[tokio::test]
async fn data_compare_filters_reject_invalid_input_before_any_table_query() {
    let (state, _directory, _pool) = fixture().await;
    for field in ["sourceFilter", "targetFilter"] {
        for filter in [
            "SELECT * FROM source_items",
            "WHERE id = 1",
            "id > 0; DELETE FROM source_items",
            "id > 0 ORDER BY id",
            "id > 0) UNION SELECT 1, 2 --",
            "id > 0 -- comment",
            "id > 0 /* comment */",
        ] {
            let mut options = options();
            options["sourceTable"] = json!("not_created");
            options["targetTable"] = json!("not_created");
            options[field] = json!(filter);
            let error =
                prepare_data_compare_from_tables(&state, serde_json::from_value(options).unwrap()).await.unwrap_err();
            assert!(error.contains(if field == "sourceFilter" { "source" } else { "target" }), "{filter}: {error}");
            assert!(error.contains("filter"), "{filter}: {error}");
        }
    }
    let mut options = options();
    options["sourceTable"] = json!("not_created");
    options["sourceFilter"] = json!("1 = 1; DELETE FROM source_items");
    let error =
        prepare_data_compare_missing_target(&state, serde_json::from_value(options).unwrap()).await.unwrap_err();
    assert!(error.contains("source") && error.contains("filter"), "{error}");
}

#[tokio::test]
async fn data_compare_filters_cover_every_sampling_strategy() {
    let (state, _directory, pool) = fixture().await;
    pool.with_connection(|connection| {
        connection
            .execute_batch(
                "UPDATE source_items SET payload = 'outside-source' WHERE cohort = 0;
                 UPDATE target_items SET payload = 'outside-target' WHERE cohort = 0;",
            )
            .map_err(|error| error.to_string())
    })
    .unwrap();
    for strategy in ["random", "extremeValues", "hybrid"] {
        let mut options = options();
        options["sourceFilter"] = json!("cohort = 1");
        options["targetFilter"] = json!("cohort = 2");
        options["samplingStrategy"] = json!(strategy);
        options["degradationThreshold"] = json!({
            "fullCompareMaxRows": 1, "sampleMaxRows": 100, "sampleSize": 20, "extremeSampleCount": 1
        });
        let result = prepare_data_compare_from_tables(&state, serde_json::from_value(options).unwrap()).await.unwrap();
        assert_eq!((result.source_row_count, result.target_row_count), (4, 4));
        assert_eq!(result.degradation_level.as_deref(), Some("sample"));
        assert_eq!(result.result.modified.len(), 1);
        assert_eq!(result.result.modified[0].key_values["id"], json!(3));
        assert!(result.result.added.is_empty() && result.result.removed.is_empty());
        assert!(!result.sync_eligible && result.sync_statements.is_empty());
    }
}

#[tokio::test]
async fn data_compare_filters_preserve_literals_multiline_predicates_and_read_subqueries() {
    let (state, _directory, _pool) = fixture().await;
    for filter in [
        "cohort = 1\nAND payload <> '; -- /* */'",
        "cohort = 1 AND lower(payload) <> 'two'",
        "id IN (SELECT id FROM source_items WHERE cohort = 1)",
    ] {
        let mut options = options();
        options["sourceFilter"] = json!(filter);
        let result = prepare_data_compare_from_tables(&state, serde_json::from_value(options).unwrap()).await.unwrap();
        assert_eq!(result.source_row_count, 4, "{filter}");
    }
}

#[tokio::test]
async fn data_compare_filters_reject_writes_nested_inside_subqueries() {
    let (state, _directory, _pool) = fixture().await;
    state.configs.write().await.get_mut("compare-filter").unwrap().db_type = DatabaseType::Postgres;
    for filter in [
        "id IN (SELECT id INTO stolen_items FROM source_items)",
        "EXISTS (WITH deleted AS (DELETE FROM source_items RETURNING id) SELECT id FROM deleted)",
        "id IN (SELECT id FROM source_items FOR UPDATE)",
        "nextval('some_sequence') > 0",
    ] {
        let mut options = options();
        options["sourceTable"] = json!("not_created");
        options["sourceFilter"] = json!(filter);
        let error =
            prepare_data_compare_from_tables(&state, serde_json::from_value(options).unwrap()).await.unwrap_err();
        assert!(error.contains("source") && error.contains("filter"), "{filter}: {error}");
    }
}

#[tokio::test]
async fn data_compare_filters_keep_or_precedence_across_keyset_pages() {
    let (state, _directory, _pool) = fixture().await;
    state.configs.write().await.get_mut("compare-filter").unwrap().db_type = DatabaseType::Postgres;
    let mut options = options();
    options["sourceFilter"] = json!("id = 1 OR id >= 4");
    options["targetFilter"] = json!("id = 1 OR id >= 4");
    let result = prepare_data_compare_from_tables(&state, serde_json::from_value(options).unwrap()).await.unwrap();
    assert_eq!((result.source_row_count, result.target_row_count), (4, 4));
    assert!(result.result.added.is_empty() && result.result.removed.is_empty() && result.result.modified.is_empty());
    assert!(result.sync_eligible);
}

#[tokio::test]
async fn data_compare_filters_survive_keyset_fallback_to_offset() {
    let (state, _directory, _pool) = fixture().await;
    state.configs.write().await.get_mut("compare-filter").unwrap().db_type = DatabaseType::Postgres;
    let mut options = options();
    options["sourceTable"] = json!("source_nullable");
    options["targetTable"] = json!("target_nullable");
    options["sourceFilter"] = json!("cohort = 1");
    options["targetFilter"] = json!("cohort = 1");
    let result = prepare_data_compare_from_tables(&state, serde_json::from_value(options).unwrap()).await.unwrap();
    assert_eq!((result.source_row_count, result.target_row_count), (2, 2));
    assert_eq!(result.result.modified.len(), 1);
    assert_eq!(result.result.modified[0].key_values["id"], json!(2));
    assert!(result.sync_eligible);
}

#[tokio::test]
async fn data_compare_filters_keep_update_and_delete_sync_inside_target_scope() {
    let (state, _directory, pool) = fixture().await;
    for rebuild in [false, true] {
        for rows_per_action in [1, 2] {
            pool.with_connection(|connection| {
                connection
                    .execute_batch("DELETE FROM source_nullable; DELETE FROM target_nullable;")
                    .map_err(|error| error.to_string())?;
                for id in 1..=rows_per_action * 2 {
                    if id <= rows_per_action {
                        connection
                            .execute("INSERT INTO source_nullable VALUES (?1, 'new', 1)", [id])
                            .map_err(|error| error.to_string())?;
                    }
                    connection
                        .execute("INSERT INTO target_nullable VALUES (?1, 'old', 1), (?1, 'untouched', 2)", [id])
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            })
            .unwrap();
            let mut options = options();
            options["sourceTable"] = json!("source_nullable");
            options["targetTable"] = json!("target_nullable");
            options["sourceFilter"] = json!("cohort = 1");
            options["targetFilter"] = json!("cohort = 1 OR cohort = 3");
            let result =
                prepare_data_compare_from_tables(&state, serde_json::from_value(options).unwrap()).await.unwrap();
            assert!(result.sync_eligible);
            let sql = if rebuild {
                let plan = build_data_compare_sync_plan(
                    serde_json::from_value(json!({"tables": [{
                        "tableName": "target_nullable", "schema": "main", "columns": ["id", "payload"],
                        "keyColumns": ["id"], "diff": result.result, "databaseType": "sqlite",
                        "syncEligible": true, "targetFilter": "cohort = 1 OR cohort = 3"
                    }]}))
                    .unwrap(),
                )
                .unwrap();
                plan.sync_sql
            } else {
                result.sync_sql
            };
            pool.with_connection(|connection| connection.execute_batch(&sql).map_err(|error| error.to_string()))
                .unwrap();
            let rows = dbx_core::db::sqlite::execute_query(
                &pool,
                "SELECT id, payload, cohort FROM target_nullable ORDER BY cohort, id",
            )
            .await
            .unwrap()
            .rows;
            let mut expected =
                (1..=rows_per_action).map(|id| vec![json!(id), json!("new"), json!(1)]).collect::<Vec<_>>();
            expected.extend((1..=rows_per_action * 2).map(|id| vec![json!(id), json!("untouched"), json!(2)]));
            assert_eq!(rows, expected, "rebuild={rebuild}, rows_per_action={rows_per_action}, sql={sql}");
        }
    }
}

#[test]
fn data_compare_filters_validate_public_sync_plan_requests() {
    for filter in ["id > 0; DELETE FROM items", "WHERE id = 1", "id = 1 ORDER BY id"] {
        let error = build_data_compare_sync_plan(
            serde_json::from_value(json!({"tables": [{
                "tableName": "items", "columns": ["id"], "keyColumns": ["id"],
                "diff": {"added": [], "removed": [], "modified": []}, "databaseType": "sqlite",
                "syncEligible": true, "targetFilter": filter
            }]}))
            .unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("target filter"), "{error}");
    }
}
