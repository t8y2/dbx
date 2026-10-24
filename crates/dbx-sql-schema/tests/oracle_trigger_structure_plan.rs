use dbx_sql_schema::table_structure_sql::{
    build_create_table_sql_plan_with_dialect_options, build_table_structure_change_sql,
    build_table_structure_change_sql_plan, TableStructureSqlOptions,
};
use serde_json::json;

fn replacement_options() -> TableStructureSqlOptions {
    serde_json::from_value(json!({
        "databaseType": "oceanbase-oracle", "schema": "Parent.Owner", "tableName": "T",
        "triggers": [{
            "id": "trigger-draft", "name": " Tr\"ig ", "timing": "BEFORE EACH ROW", "event": "INSERT",
            "statement": "BEGIN :NEW.ID := 7; END;", "enabled": false,
            "oracleExact": {"owner": " Trigger.Owner ", "parentType": "TABLE"},
            "original": {"name": " Tr\"ig ", "timing": "BEFORE EACH ROW", "event": "INSERT", "statement": "BEGIN NULL; END;", "enabled": false}
        }]
    })).unwrap()
}

#[test]
fn exact_structured_trigger_uses_its_own_owner_and_preserves_disabled_in_the_definition() {
    let result = build_table_structure_change_sql(replacement_options());
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert_eq!(result.statements, vec!["CREATE OR REPLACE TRIGGER \" Trigger.Owner \".\" Tr\"\"ig \" BEFORE INSERT ON \"Parent.Owner\".\"T\"\nFOR EACH ROW\nDISABLE\nBEGIN :NEW.ID := 7; END;"]);
}

#[test]
fn exact_trigger_operation_is_bound_to_its_generated_position_between_columns_and_comments() {
    let mut payload = serde_json::to_value(replacement_options()).unwrap();
    payload["columns"] = json!([{"id":"column-draft","name":"V","dataType":"NUMBER","isNullable":true}]);
    payload["tableComment"] = json!("new comment");
    payload["originalTableComment"] = json!("");
    let plan = build_table_structure_change_sql_plan(serde_json::from_value(payload).unwrap(), None);
    assert!(plan.sql.warnings.is_empty(), "{:?}", plan.sql.warnings);
    assert_eq!(plan.sql.statements.len(), 3);
    assert_eq!(
        serde_json::to_value(&plan).unwrap()["triggerOperations"],
        json!([{
            "draftId": "trigger-draft", "action": "replace", "owner": " Trigger.Owner ", "name": " Tr\"ig ",
            "statementIndex": 1, "statementCount": 1, "enabled": false
        }])
    );
}

#[test]
fn default_structured_payload_keeps_the_legacy_sql_and_json_fields() {
    let mut payload = serde_json::to_value(replacement_options()).unwrap();
    payload["triggers"][0].as_object_mut().unwrap().remove("oracleExact");
    let plan = build_table_structure_change_sql_plan(serde_json::from_value(payload).unwrap(), None);
    assert_eq!(
        serde_json::to_value(plan).unwrap(),
        json!({
            "statements": [
                "CREATE OR REPLACE TRIGGER \"Parent.Owner\".\"Tr\"\"ig\" BEFORE INSERT ON \"Parent.Owner\".\"T\"\nFOR EACH ROW\nBEGIN :NEW.ID := 7; END;",
                "ALTER TRIGGER \"Parent.Owner\".\" Tr\"\"ig \" DISABLE;"
            ], "warnings": []
        })
    );
}

#[test]
fn exact_trigger_noop_acknowledges_the_contract_without_inventing_an_operation() {
    let mut options = replacement_options();
    options.triggers[0].statement = options.triggers[0].original.as_ref().unwrap().statement.clone().unwrap();
    let plan = build_table_structure_change_sql_plan(options, None);
    assert!(plan.sql.statements.is_empty());
    assert!(plan.trigger_operations.is_empty());
    assert_eq!(serde_json::to_value(plan).unwrap()["oracleTriggerContract"], 1);
}

#[test]
fn renamed_trigger_operations_identify_the_old_drop_and_the_new_create_without_replace() {
    let mut options = replacement_options();
    options.triggers[0].name = " NewTrigger ".into();
    let plan = build_table_structure_change_sql_plan(options, None);
    assert!(plan.sql.warnings.is_empty(), "{:?}", plan.sql.warnings);
    assert_eq!(plan.sql.statements.len(), 2);
    assert_eq!(plan.sql.statements[0], "DROP TRIGGER \" Trigger.Owner \".\" Tr\"\"ig \";");
    assert!(!plan.sql.statements[1].contains("OR REPLACE"));
    assert_eq!(
        serde_json::to_value(plan).unwrap()["triggerOperations"],
        json!([
            {"draftId":"trigger-draft","action":"delete","owner":" Trigger.Owner ","name":" Tr\"ig ","statementIndex":0,"statementCount":1},
            {"draftId":"trigger-draft","action":"create","owner":" Trigger.Owner ","name":"NewTrigger","statementIndex":1,"statementCount":1,"enabled":false}
        ])
    );
}

#[test]
fn dm_disabled_replacement_is_one_logical_operation_with_two_explicit_statements() {
    let mut payload = serde_json::to_value(replacement_options()).unwrap();
    payload["databaseType"] = json!("dameng");
    let plan = build_table_structure_change_sql_plan(serde_json::from_value(payload).unwrap(), None);
    assert!(plan.sql.warnings.is_empty(), "{:?}", plan.sql.warnings);
    assert_eq!(plan.sql.statements.len(), 2);
    assert!(!plan.sql.statements[0].contains("\nDISABLE\n"));
    assert_eq!(plan.sql.statements[1], "ALTER TRIGGER \" Trigger.Owner \".\" Tr\"\"ig \" DISABLE;");
    assert_eq!(plan.trigger_operations[0].statement_count, 2);
    assert_eq!(plan.trigger_operations[0].action, "replace");
}

#[test]
fn new_oracle_table_and_trigger_operations_keep_the_existing_name_folding_rule() {
    let mut payload = serde_json::to_value(replacement_options()).unwrap();
    payload["databaseType"] = json!("oracle");
    payload["tableName"] = json!("new_table");
    payload["columns"] = json!([{"id":"new-column","name":"ID","dataType":"NUMBER","isNullable":true}]);
    payload["triggers"][0]["name"] = json!("new_trigger");
    payload["triggers"][0]["original"] = serde_json::Value::Null;
    let plan = build_create_table_sql_plan_with_dialect_options(
        serde_json::from_value(payload).unwrap(),
        None,
        Default::default(),
    );
    assert!(plan.sql.warnings.is_empty(), "{:?}", plan.sql.warnings);
    assert!(plan.sql.statements[0].starts_with("CREATE TABLE \"Parent.Owner\".new_table "));
    assert!(plan.sql.statements[1].contains("TRIGGER \" Trigger.Owner \".\"NEW_TRIGGER\""));
    assert!(plan.sql.statements[1].contains("ON \"Parent.Owner\".\"NEW_TABLE\""));
    assert!(!plan.sql.statements[1].contains("OR REPLACE"));
    assert_eq!(plan.trigger_operations[0].name, "NEW_TRIGGER");
    assert_eq!(plan.trigger_operations[0].statement_index, 1);
}

#[test]
fn a_protected_complete_source_can_toggle_but_cannot_be_rebuilt_from_a_body() {
    let mut options = replacement_options();
    let source = "TRIGGER \" Tr\"\"ig \" BEFORE INSERT ON \"Parent.Owner\".\"T\" FOR EACH ROW WHEN (NEW.ID > 0) BEGIN NULL; END;";
    options.triggers[0].original.as_mut().unwrap().statement = Some(source.into());
    options.triggers[0].statement = source.into();
    options.triggers[0].enabled = Some(true);
    let toggled = build_table_structure_change_sql_plan(options.clone(), None);
    assert!(toggled.sql.warnings.is_empty(), "{:?}", toggled.sql.warnings);
    assert_eq!(toggled.sql.statements, ["ALTER TRIGGER \" Trigger.Owner \".\" Tr\"\"ig \" ENABLE;"]);
    assert_eq!(toggled.trigger_operations[0].action, "enable");
    options.triggers[0].statement = "BEGIN :NEW.ID := 8; END;".into();
    let refused = build_table_structure_change_sql_plan(options, None);
    assert!(refused.sql.statements.is_empty());
    assert!(refused.trigger_operations.is_empty());
    assert!(refused.sql.warnings.iter().any(|warning| warning.contains("complete source definition")));
}
