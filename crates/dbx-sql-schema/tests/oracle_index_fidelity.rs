use dbx_sql_schema::models::connection::DatabaseType;
use dbx_sql_schema::table_structure_sql::{build_table_structure_change_sql, TableStructureSqlOptions};
use serde_json::{json, Value};

fn options(columns: Value) -> TableStructureSqlOptions {
    serde_json::from_value(json!({
        "databaseType": "oracle",
        "schema": "APP",
        "tableName": "EVENTS",
        "columns": [],
        "indexes": [columns]
    }))
    .unwrap()
}

fn existing_index(columns: Vec<&str>) -> Value {
    json!({
        "id": "existing:IX_EVENT",
        "name": "IX_EVENT_RENAMED",
        "columns": columns,
        "isUnique": false,
        "isPrimary": false,
        "original": {
            "name": "IX_EVENT",
            "columns": ["LOWER(EVENT_NAME)", "EVENT_TS"],
            "is_unique": false,
            "is_primary": false,
            "key_is_expression": [true, false],
            "key_directions": ["DESC", "ASC"],
            "visibility": "INVISIBLE",
            "key_metadata_complete": true
        }
    })
}

#[test]
fn oracle_expression_index_rename_keeps_raw_expression_and_key_semantics() {
    let result = build_table_structure_change_sql(options(existing_index(vec!["LOWER(EVENT_NAME)", "EVENT_TS"])));

    assert_eq!(result.statements.len(), 2, "{result:?}");
    assert!(result.statements[0].starts_with("DROP INDEX"), "{result:?}");
    assert!(result.statements[1].contains("LOWER(EVENT_NAME)"), "{result:?}");
    assert!(!result.statements[1].contains("\"LOWER(EVENT_NAME)\""), "{result:?}");
    assert!(result.statements[1].contains("DESC"), "{result:?}");
    assert!(result.statements[1].contains("EVENT_TS\" ASC"), "{result:?}");
    assert!(result.statements[1].contains("INVISIBLE"), "{result:?}");
}

#[test]
fn oracle_retry_after_drop_creates_only_and_keeps_original_key_semantics() {
    let mut input = existing_index(vec!["LOWER(EVENT_NAME)", "EVENT_TS"]);
    input["oracleOriginalMissing"] = json!(true);

    let result = build_table_structure_change_sql(options(input));

    assert_eq!(result.statements.len(), 1, "{result:?}");
    assert!(result.statements[0].starts_with("CREATE INDEX"), "{result:?}");
    assert!(result.statements[0].contains("LOWER(EVENT_NAME) DESC"), "{result:?}");
    assert!(result.statements[0].contains("EVENT_TS\" ASC"), "{result:?}");
    assert!(result.statements[0].contains("INVISIBLE"), "{result:?}");
}

#[test]
fn oracle_retry_after_drop_creates_only_when_target_matches_original_definition() {
    let mut input = existing_index(vec!["LOWER(EVENT_NAME)", "EVENT_TS"]);
    input["name"] = json!("IX_EVENT");
    input["oracleOriginalMissing"] = json!(true);

    let result = build_table_structure_change_sql(options(input));

    assert_eq!(result.statements.len(), 1, "{result:?}");
    assert!(result.statements[0].starts_with("CREATE INDEX \"IX_EVENT\""), "{result:?}");
    assert!(result.statements[0].contains("LOWER(EVENT_NAME) DESC"), "{result:?}");
    assert!(result.statements[0].contains("INVISIBLE"), "{result:?}");
}

#[test]
fn dropping_a_missing_oracle_index_draft_generates_no_ddl() {
    let mut input = existing_index(vec!["LOWER(EVENT_NAME)", "EVENT_TS"]);
    input["oracleOriginalMissing"] = json!(true);
    input["markedForDrop"] = json!(true);

    let result = build_table_structure_change_sql(options(input));

    assert!(result.statements.is_empty(), "{result:?}");
}

#[test]
fn oracle_reordered_keys_keep_their_individual_directions() {
    let result = build_table_structure_change_sql(options(existing_index(vec!["EVENT_TS", "LOWER(EVENT_NAME)"])));

    assert_eq!(result.statements.len(), 2, "{result:?}");
    assert!(result.statements[1].contains("EVENT_TS\" ASC, LOWER(EVENT_NAME) DESC"), "{result:?}");
}

#[test]
fn oceanbase_descending_rebuild_is_rejected_before_drop() {
    let mut input = existing_index(vec!["LOWER(EVENT_NAME)", "EVENT_TS"]);
    input["original"]["key_directions"] = json!(["DESC", "ASC"]);
    let mut options = options(input);
    options.database_type = Some(DatabaseType::OceanbaseOracle);

    let result = build_table_structure_change_sql(options);

    assert!(result.statements.is_empty(), "{result:?}");
    assert!(result.warnings.iter().any(|warning| warning.contains("descending index key 1")), "{result:?}");
}

#[test]
fn oceanbase_ascending_invisible_rebuild_preserves_supported_options() {
    let mut input = existing_index(vec!["LOWER(EVENT_NAME)", "EVENT_TS"]);
    input["original"]["key_directions"] = json!(["ASC", "ASC"]);
    let mut options = options(input);
    options.database_type = Some(DatabaseType::OceanbaseOracle);

    let result = build_table_structure_change_sql(options);

    assert_eq!(result.statements.len(), 2, "{result:?}");
    assert!(result.statements[1].contains("LOWER(EVENT_NAME) ASC"), "{result:?}");
    assert!(result.statements[1].contains("EVENT_TS\" ASC"), "{result:?}");
    assert!(result.statements[1].contains("INVISIBLE"), "{result:?}");
}

#[test]
fn oracle_unknown_index_metadata_blocks_rebuild() {
    let mut input = existing_index(vec!["LOWER(EVENT_NAME)", "EVENT_TS"]);
    input["original"]["key_metadata_complete"] = json!(false);

    let result = build_table_structure_change_sql(options(input));

    assert!(result.statements.is_empty(), "{result:?}");
    assert!(result.warnings.iter().any(|warning| warning.contains("metadata is incomplete")), "{result:?}");
}

#[test]
fn oracle_invalid_rebuild_does_not_drop_without_a_complete_create() {
    let result = build_table_structure_change_sql(options(existing_index(Vec::new())));

    assert!(result.statements.is_empty(), "{result:?}");
    assert!(!result.warnings.is_empty(), "{result:?}");
}

#[test]
fn indexes_on_other_oracle_dialect_engines_keep_existing_rebuild_behavior() {
    for database_type in [DatabaseType::Iris, DatabaseType::Yashandb, DatabaseType::Xugu] {
        let mut options = options(existing_index(vec!["LOWER(EVENT_NAME)", "EVENT_TS"]));
        options.database_type = Some(database_type);

        let result = build_table_structure_change_sql(options);

        assert_eq!(result.warnings, Vec::<String>::new(), "{database_type:?}: {result:?}");
        assert_eq!(result.statements.len(), 2, "{database_type:?}: {result:?}");
        assert!(result.statements[0].starts_with("DROP INDEX"), "{database_type:?}: {result:?}");
        assert!(result.statements[1].starts_with("CREATE INDEX"), "{database_type:?}: {result:?}");
    }
}
