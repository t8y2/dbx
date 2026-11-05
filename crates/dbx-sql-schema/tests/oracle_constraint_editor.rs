use dbx_sql_schema::models::connection::DatabaseType;
use dbx_sql_schema::table_structure_sql::{
    build_table_structure_change_sql, build_table_structure_change_sql_with_context, OracleConstraintDefinition,
    StarRocksAlterOptions, TableStructureSqlOptions,
};
use serde_json::{json, Value};

fn options(engine: &str, expression: &str) -> TableStructureSqlOptions {
    serde_json::from_value(json!({
        "databaseType": engine,
        "schema": "APP",
        "tableName": "CONTACTS",
        "columns": [],
        "indexes": [],
        "oracleConstraintChanges": [{
            "original": Value::Null,
            "target": {
                "kind": "check",
                "definition": {
                    "name": "CK_CONTACTS_AGE",
                    "expression": expression,
                    "state": { "enabled": true, "validated": true, "deferrable": false, "initiallyDeferred": false, "rely": false }
                }
            }
        }]
    }))
    .unwrap()
}

fn rename_with_state_options(engine: &str) -> TableStructureSqlOptions {
    serde_json::from_value(json!({
        "databaseType": engine,
        "schema": "APP",
        "tableName": "CONTACTS",
        "columns": [],
        "indexes": [],
        "oracleConstraintChanges": [{
            "original": { "kind": "check", "definition": {
                "name": "CK_OLD", "expression": "AGE > 0",
                "state": { "enabled": true, "validated": true, "deferrable": false, "initiallyDeferred": false, "rely": false }
            } },
            "target": { "kind": "check", "definition": {
                "name": "CK_NEW", "expression": "AGE > 0",
                "state": { "enabled": false, "validated": false, "deferrable": false, "initiallyDeferred": false, "rely": false }
            } }
        }]
    }))
    .unwrap()
}

fn unique_state_options() -> TableStructureSqlOptions {
    serde_json::from_value(json!({
        "databaseType": "oracle", "schema": "APP", "tableName": "CONTACTS", "columns": [], "indexes": [],
        "oracleConstraintChanges": [{
            "indexPolicy": "keep",
            "original": { "kind": "unique", "definition": {
                "name": "UQ_CONTACTS", "columns": ["ID"], "relyRaw": "NULL",
                "state": { "enabled": true, "validated": true, "deferrable": false, "initiallyDeferred": false, "rely": false },
                "index": { "owner": "APP", "name": "UQ_CONTACTS", "tableOwner": "APP", "tableName": "CONTACTS", "sharing": "exclusive", "metadataComplete": true, "indexType": "NORMAL", "uniqueness": "UNIQUE", "status": "VALID", "partitioned": false, "visibility": "VISIBLE", "secondary": "N", "columns": ["ID"], "directions": ["ASC"], "keyIsExpression": [false], "includedColumns": [], "newNameAvailable": false }
            } },
            "target": { "kind": "unique", "definition": {
                "name": "UQ_CONTACTS", "columns": ["ID"], "relyRaw": "NULL",
                "state": { "enabled": false, "validated": true, "deferrable": false, "initiallyDeferred": false, "rely": false },
                "index": { "owner": "APP", "name": "UQ_CONTACTS", "tableOwner": "APP", "tableName": "CONTACTS", "sharing": "exclusive", "metadataComplete": true, "indexType": "NORMAL", "uniqueness": "UNIQUE", "status": "VALID", "partitioned": false, "visibility": "VISIBLE", "secondary": "N", "columns": ["ID"], "directions": ["ASC"], "keyIsExpression": [false], "includedColumns": [], "newNameAvailable": false }
            } }
        }]
    })).unwrap()
}

#[test]
fn oceanbase_unique_add_and_rebuild_use_the_verified_default_state() {
    for rebuild in [false, true] {
        let mut options = unique_state_options();
        options.database_type = Some(DatabaseType::OceanbaseOracle);
        let change = &mut options.oracle_constraint_changes.as_mut().unwrap()[0];
        change.index_policy = "none".into();
        if let Some(OracleConstraintDefinition::Unique(original)) = change.original.as_mut() {
            original.index.secondary = None;
        }
        let Some(OracleConstraintDefinition::Unique(target)) = change.target.as_mut() else { panic!() };
        target.state.enabled = true;
        target.index.secondary = None;
        if rebuild {
            target.columns.push("EMAIL".into());
            target.index.columns = target.columns.clone();
            target.index.directions.push("ASC".into());
            target.index.key_is_expression.push(false);
        } else {
            target.index.name.clear();
            target.index.metadata_complete = false;
            change.original = None;
        }
        let result = build_table_structure_change_sql(options.clone());
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        let columns = if rebuild { "\"ID\", \"EMAIL\"" } else { "\"ID\"" };
        assert_eq!(
            result.statements.last().unwrap(),
            &format!("ALTER TABLE \"APP\".\"CONTACTS\" ADD CONSTRAINT \"UQ_CONTACTS\" UNIQUE ({columns});")
        );
        assert_eq!(result.statements.len(), if rebuild { 2 } else { 1 });

        let Some(OracleConstraintDefinition::Unique(target)) =
            options.oracle_constraint_changes.as_mut().unwrap()[0].target.as_mut()
        else {
            panic!()
        };
        target.state.validated = false;
        let rejected = build_table_structure_change_sql(options);
        assert!(rejected.statements.is_empty());
        assert!(!rejected.warnings.is_empty());
    }
}

#[test]
fn oracle_unique_add_retains_explicit_state_clauses() {
    let mut options = unique_state_options();
    let change = &mut options.oracle_constraint_changes.as_mut().unwrap()[0];
    change.original = None;
    let Some(OracleConstraintDefinition::Unique(target)) = change.target.as_mut() else { panic!() };
    target.state.enabled = true;
    let result = build_table_structure_change_sql(options);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert!(result.statements[0].ends_with("USING INDEX \"APP\".\"UQ_CONTACTS\" ENABLE VALIDATE;"));
}

#[test]
fn starrocks_alter_rejects_oracle_only_changes_before_generating_ddl() {
    for (field, value) in [
        ("oracleConstraintChanges", json!([])),
        ("oracleForeignKeyChanges", json!([])),
        ("primaryKeyChange", json!({ "name": "PK_EVENTS", "originalColumns": ["id"], "columns": ["id"] })),
    ] {
        let mut payload = json!({
            "databaseType": "starrocks",
            "tableName": "events",
            "columns": [],
            "indexes": [],
            "tableComment": "must not be emitted"
        });
        payload[field] = value;
        let options: TableStructureSqlOptions = serde_json::from_value(payload).unwrap();
        let context: StarRocksAlterOptions = serde_json::from_value(json!({ "serverVersion": "3.5.0" })).unwrap();
        let result = build_table_structure_change_sql_with_context(options, Some(context));
        assert!(result.statements.is_empty(), "{field}: {:?}", result.statements);
        assert!(!result.warnings.is_empty(), "{field} should be rejected for StarRocks");
    }
}

#[test]
fn starrocks_alter_still_generates_native_table_comment_without_oracle_changes() {
    let options: TableStructureSqlOptions = serde_json::from_value(json!({
        "databaseType": "starrocks",
        "tableName": "events",
        "columns": [],
        "indexes": [],
        "tableComment": "native comment"
    }))
    .unwrap();
    let context: StarRocksAlterOptions = serde_json::from_value(json!({ "serverVersion": "3.5.0" })).unwrap();
    let result = build_table_structure_change_sql_with_context(options, Some(context));
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert!(!result.statements.is_empty());
}

#[test]
fn check_expression_line_comment_cannot_swallow_generated_ddl() {
    for engine in ["oracle", "oceanbase-oracle"] {
        let result = build_table_structure_change_sql(options(engine, "\"AGE\" >= 0 -- trailing note"));
        assert!(result.warnings.is_empty(), "{engine}: {:?}", result.warnings);
        let state = if engine == "oracle" { " NOT DEFERRABLE INITIALLY IMMEDIATE NORELY" } else { "" };
        assert_eq!(
            result.statements,
            vec![format!("ALTER TABLE \"APP\".\"CONTACTS\" ADD CONSTRAINT \"CK_CONTACTS_AGE\" CHECK (\n\"AGE\" >= 0 -- trailing note\n){state} ENABLE VALIDATE;")],
            "{engine}"
        );
    }
}

#[test]
fn check_expression_keeps_comment_markers_inside_literals_and_quoted_names() {
    let result =
        build_table_structure_change_sql(options("oracle", "\"A;B\" = 'x;--y' /* note */ AND \"A;B\" IS NOT NULL"));
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert!(result.statements[0].contains("CHECK (\n\"A;B\" = 'x;--y' /* note */ AND \"A;B\" IS NOT NULL\n)"));
}

#[test]
fn check_expression_with_check_marker_inside_string_literal_is_validated() {
    let result = build_table_structure_change_sql(options("oracle", "TEXT = ' CHECK ('"));
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert!(result.statements[0].contains("TEXT = ' CHECK ('"));
}

#[test]
fn check_expression_with_trailing_statement_is_rejected_before_any_ddl() {
    for expression in ["\"AGE\" >= 0; DROP TABLE CONTACTS", "\"AGE\" >= 0) ENABLE VALIDATE"] {
        let result = build_table_structure_change_sql(options("oracle", expression));
        assert!(result.statements.is_empty(), "unexpected DDL for {expression}: {:?}", result.statements);
        assert!(!result.warnings.is_empty());
    }
}

#[test]
fn rename_with_state_change_keeps_both_changes_for_each_engine() {
    let oracle = build_table_structure_change_sql(rename_with_state_options("oracle"));
    assert!(oracle.warnings.is_empty(), "{:?}", oracle.warnings);
    assert_eq!(
        oracle.statements,
        vec![
            "ALTER TABLE \"APP\".\"CONTACTS\" DISABLE NOVALIDATE CONSTRAINT \"CK_OLD\";",
            "ALTER TABLE \"APP\".\"CONTACTS\" RENAME CONSTRAINT \"CK_OLD\" TO \"CK_NEW\";"
        ]
    );

    let oceanbase = build_table_structure_change_sql(rename_with_state_options("oceanbase-oracle"));
    assert!(oceanbase.warnings.is_empty(), "{:?}", oceanbase.warnings);
    assert_eq!(oceanbase.statements.len(), 2);
    assert!(oceanbase.statements[0].contains("DROP CONSTRAINT \"CK_OLD\""));
    assert!(oceanbase.statements[1].contains("ADD CONSTRAINT \"CK_NEW\" CHECK (\nAGE > 0\n) DISABLE NOVALIDATE"));
}

#[test]
fn oracle_unique_disable_uses_explicit_index_policy() {
    let result = build_table_structure_change_sql(unique_state_options());
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert_eq!(
        result.statements,
        vec!["ALTER TABLE \"APP\".\"CONTACTS\" DISABLE VALIDATE CONSTRAINT \"UQ_CONTACTS\" KEEP INDEX;"]
    );
}
#[test]
fn oracle_enabling_novalidate_unique_without_an_index_creates_a_nonunique_index() {
    let options: TableStructureSqlOptions = serde_json::from_value(json!({
        "databaseType": "oracle", "schema": "APP", "tableName": "CONTACTS", "columns": [], "indexes": [],
        "oracleConstraintChanges": [{
            "indexPolicy": "keep",
            "original": { "kind": "unique", "definition": {
                "name": "UQ_CONTACTS", "columns": ["ID"], "relyRaw": "NULL",
                "state": { "enabled": false, "validated": false, "deferrable": false, "initiallyDeferred": false, "rely": false },
                "index": { "owner": "APP", "name": "", "tableOwner": "APP", "tableName": "CONTACTS", "sharing": "exclusive", "metadataComplete": true, "indexType": "NORMAL", "uniqueness": "UNIQUE", "status": "VALID", "partitioned": false, "visibility": "VISIBLE", "secondary": "N", "columns": [], "directions": [], "keyIsExpression": [], "includedColumns": [], "newNameAvailable": false }
            } },
            "target": { "kind": "unique", "definition": {
                "name": "UQ_CONTACTS", "columns": ["ID"], "relyRaw": "NULL",
                "state": { "enabled": true, "validated": false, "deferrable": false, "initiallyDeferred": false, "rely": false },
                "index": { "owner": "APP", "name": "", "newName": "IX_UQ_CONTACTS", "newNameAvailable": true, "tableOwner": "APP", "tableName": "CONTACTS", "sharing": "exclusive", "metadataComplete": false, "indexType": "NORMAL", "uniqueness": "UNIQUE", "status": "VALID", "partitioned": false, "visibility": "VISIBLE", "secondary": "N", "columns": ["ID"], "directions": ["ASC"], "keyIsExpression": [false], "includedColumns": [] }
            } }
        }]
    })).unwrap();

    let result = build_table_structure_change_sql(options);

    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE \"APP\".\"CONTACTS\" DROP CONSTRAINT \"UQ_CONTACTS\" KEEP INDEX;",
            "ALTER TABLE \"APP\".\"CONTACTS\" ADD CONSTRAINT \"UQ_CONTACTS\" UNIQUE (\"ID\") NOT DEFERRABLE INITIALLY IMMEDIATE NORELY USING INDEX (CREATE INDEX \"APP\".\"IX_UQ_CONTACTS\" ON \"APP\".\"CONTACTS\" (\"ID\")) ENABLE NOVALIDATE;"
        ]
    );
}
