use dbx_sql_schema::table_structure_sql::{
    build_create_table_sql, build_table_structure_change_sql, TableStructureSqlOptions,
};
use serde_json::{json, Value};

fn definition(name: &str) -> Value {
    json!({
        "name": name, "columns": ["B", "A,quoted"],
        "refSchema": "Parent Owner", "refTable": "Parent,Table", "refColumns": ["V", "ID\"quoted"],
        "onDelete": "CASCADE",
        "state": { "enabled": true, "validated": false, "deferrable": false, "initiallyDeferred": false, "rely": false }
    })
}

fn options(engine: &str, original: Value, target: Value) -> TableStructureSqlOptions {
    serde_json::from_value(json!({
        "databaseType": engine, "schema": "App Owner", "tableName": "Child,Table",
        "columns": [], "indexes": [],
        "oracleForeignKeyChanges": [{ "original": original, "target": target }]
    }))
    .unwrap()
}

#[test]
fn ordered_quoted_composite_add_reaches_real_builder() {
    for engine in ["oracle", "oceanbase-oracle"] {
        let result = build_table_structure_change_sql(options(engine, Value::Null, definition("FK\"name")));
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        let deferred = if engine == "oracle" { " NOT DEFERRABLE INITIALLY IMMEDIATE" } else { "" };
        assert_eq!(
            result.statements,
            vec![format!(
                "ALTER TABLE \"App Owner\".\"Child,Table\" ADD CONSTRAINT \"FK\"\"name\" FOREIGN KEY (\"B\", \"A,quoted\") REFERENCES \"Parent Owner\".\"Parent,Table\" (\"V\", \"ID\"\"quoted\") ON DELETE CASCADE{deferred} NORELY ENABLE NOVALIDATE;"
            )],
            "{engine}"
        );
    }
}

#[test]
fn invalid_replacement_never_returns_original_drop() {
    let mut invalid = definition("FK_NEW");
    invalid["refColumns"] = json!(["V"]);
    let result = build_table_structure_change_sql(options("oracle", definition("FK_OLD"), invalid));
    assert!(result.statements.is_empty());
    assert!(!result.warnings.is_empty());
}

#[test]
fn unsupported_engine_cannot_consume_oracle_changes() {
    let result = build_table_structure_change_sql(options("postgres", Value::Null, definition("FK_NEW")));
    assert!(result.statements.is_empty());
    assert!(!result.warnings.is_empty());
}

#[test]
fn oracle_name_and_state_edit_preserves_existing_key() {
    let original = definition("FK_OLD");
    let mut target = definition("FK_NEW");
    target["state"]["enabled"] = json!(false);
    let result = build_table_structure_change_sql(options("oracle", original, target));
    assert!(result.warnings.is_empty());
    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE \"App Owner\".\"Child,Table\" DISABLE NOVALIDATE CONSTRAINT \"FK_OLD\";",
            "ALTER TABLE \"App Owner\".\"Child,Table\" RENAME CONSTRAINT \"FK_OLD\" TO \"FK_NEW\";"
        ]
    );
}

#[test]
fn oceanbase_name_edit_rebuilds_but_state_edit_is_in_place() {
    let original = definition("FK_OLD");
    let mut target = original.clone();
    target["state"]["enabled"] = json!(false);
    let result = build_table_structure_change_sql(options("oceanbase-oracle", original.clone(), target));
    assert_eq!(
        result.statements,
        vec!["ALTER TABLE \"App Owner\".\"Child,Table\" DISABLE NOVALIDATE CONSTRAINT \"FK_OLD\";"]
    );
    let renamed = build_table_structure_change_sql(options("oceanbase-oracle", original, definition("FK_NEW")));
    assert!(renamed.warnings.is_empty());
    assert_eq!(renamed.statements.len(), 2);
    assert_eq!(renamed.statements[0], "ALTER TABLE \"App Owner\".\"Child,Table\" DROP CONSTRAINT \"FK_OLD\";");
    assert!(renamed.statements[1].contains("ADD CONSTRAINT \"FK_NEW\""));
}

#[test]
fn duplicate_columns_and_illegal_actions_are_rejected_before_drop() {
    for (field, value) in [("columns", json!(["B", "B"])), ("onDelete", json!("RESTRICT"))] {
        let mut target = definition("FK_NEW");
        target[field] = value;
        let result = build_table_structure_change_sql(options("oracle", definition("FK_OLD"), target));
        assert!(result.statements.is_empty());
        assert!(!result.warnings.is_empty());
    }
}

fn new_table_options(engine: &str) -> TableStructureSqlOptions {
    serde_json::from_value(json!({
        "databaseType": engine, "schema": "APP", "tableName": "child",
        "columns": [{"id":"id", "name":"key_id", "dataType":"NUMBER", "isNullable":false, "isPrimaryKey":true},
                    {"id":"pid", "name":"parent_id", "dataType":"NUMBER", "isNullable":true}],
        "oracleForeignKeyChanges": [{"original":null,"target":{
            "name":"fk_self", "columns":["parent_id"], "refSchema":"APP", "refTable":"child", "refColumns":["key_id"],
            "onDelete":"NO ACTION", "state":{"enabled":true,"validated":true,"deferrable":false,"initiallyDeferred":false,"rely":false}
        }}]
    })).unwrap()
}

#[test]
fn new_table_foreign_key_uses_existing_create_identity_rules() {
    for engine in ["oracle", "oceanbase-oracle"] {
        let result = build_create_table_sql(new_table_options(engine));
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(result.statements.len(), 2, "{engine}: {:?}", result.statements);
        if engine == "oracle" {
            assert!(result.statements[0].contains("CREATE TABLE \"APP\".child"));
            assert!(result.statements[1].contains("ALTER TABLE \"APP\".child ADD CONSTRAINT fk_self FOREIGN KEY (parent_id) REFERENCES \"APP\".child (key_id)"), "{:?}", result.statements);
        } else {
            assert!(result.statements[1].contains("ALTER TABLE \"APP\".\"child\" ADD CONSTRAINT \"fk_self\" FOREIGN KEY (\"parent_id\") REFERENCES \"APP\".\"child\" (\"key_id\")"));
        }
    }
}

#[test]
fn self_reference_preserves_reverse_composite_parent_key_order() {
    let options = serde_json::from_value::<TableStructureSqlOptions>(json!({
        "databaseType": "oracle", "schema": "APP", "tableName": "child",
        "columns": [
            {"id":"a", "name":"A", "dataType":"NUMBER", "isNullable":false, "isPrimaryKey":true},
            {"id":"b", "name":"B", "dataType":"NUMBER", "isNullable":false, "isPrimaryKey":true},
            {"id":"x", "name":"X", "dataType":"NUMBER", "isNullable":true},
            {"id":"y", "name":"Y", "dataType":"NUMBER", "isNullable":true}
        ],
        "oracleForeignKeyChanges": [{"original":null,"target":{
            "name":"FK_SELF", "columns":["X","Y"], "refSchema":"APP", "refTable":"child", "refColumns":["B","A"],
            "onDelete":"NO ACTION", "state":{"enabled":true,"validated":true,"deferrable":false,"initiallyDeferred":false,"rely":false}
        }}]
    })).unwrap();
    let result = build_create_table_sql(options.clone());
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert!(result.statements[1].contains("FOREIGN KEY (X, Y) REFERENCES \"APP\".child (B, A)"));
}

#[test]
fn invalid_new_foreign_key_returns_zero_create_statements() {
    let mut options = new_table_options("oracle");
    options.oracle_foreign_key_changes.as_mut().unwrap()[0].target.as_mut().unwrap().columns = vec!["missing".into()];
    let result = build_create_table_sql(options);
    assert!(result.statements.is_empty());
    assert!(!result.warnings.is_empty());
}

#[test]
fn self_reference_must_target_the_new_primary_key_before_create() {
    let mut options = new_table_options("oracle");
    options.oracle_foreign_key_changes.as_mut().unwrap()[0].target.as_mut().unwrap().ref_columns =
        vec!["parent_id".into()];
    let result = build_create_table_sql(options);
    assert!(result.statements.is_empty());
    assert!(!result.warnings.is_empty());
}

#[test]
fn oracle_self_reference_uses_unquoted_identifier_folding() {
    let mut options = new_table_options("oracle");
    options.oracle_foreign_key_changes.as_mut().unwrap()[0].target.as_mut().unwrap().ref_table = "CHILD".into();
    let result = build_create_table_sql(options);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert!(result.statements[1].contains("REFERENCES \"APP\".child (key_id)"));
}

#[test]
fn new_foreign_keys_preserve_special_source_and_existing_parent_names() {
    let mut options = new_table_options("oracle");
    options.table_name = "Child,Quoted".into();
    options.columns[1].name = " parent\"column ".into();
    let target = options.oracle_foreign_key_changes.as_mut().unwrap()[0].target.as_mut().unwrap();
    target.name = "FK,Quoted".into();
    target.columns = vec![" parent\"column ".into()];
    target.ref_schema = "Parent Owner".into();
    target.ref_table = "MixedCaseParent".into();
    target.ref_columns = vec![" Key,One ".into()];
    let result = build_create_table_sql(options);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert!(result.statements[1].contains("ALTER TABLE \"APP\".\"Child,Quoted\" ADD CONSTRAINT \"FK,Quoted\" FOREIGN KEY (\" parent\"\"column \") REFERENCES \"Parent Owner\".\"MixedCaseParent\" (\" Key,One \")"), "{:?}", result.statements);
}

#[test]
fn ordinary_oracle_new_constraint_names_cannot_collide_after_folding() {
    let mut options = new_table_options("oracle");
    let mut second = options.oracle_foreign_key_changes.as_ref().unwrap()[0].clone();
    second.target.as_mut().unwrap().name = "FK_SELF".into();
    options.oracle_foreign_key_changes.as_mut().unwrap().push(second);
    let result = build_create_table_sql(options);
    assert!(result.statements.is_empty());
    assert!(!result.warnings.is_empty());
}
