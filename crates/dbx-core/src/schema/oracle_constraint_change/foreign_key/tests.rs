use super::*;
use serde_json::{json, Value};
use std::sync::Mutex;

struct Fixture {
    current: Option<ForeignKeyDefinition>,
    desired: Option<ForeignKeyDefinition>,
    queries: Vec<String>,
    writes: Vec<String>,
    stamp: u64,
    fail_step: Option<usize>,
    violations: bool,
    eligible: bool,
    privilege: bool,
    truncated: bool,
}
struct Session {
    engine: Engine,
    fixture: Mutex<Fixture>,
}
fn rows(rows: Vec<Vec<Value>>) -> db::QueryResult {
    serde_json::from_value(json!({"columns":[],"rows":rows,"affected_rows":0,"execution_time_ms":0})).unwrap()
}
fn key() -> ForeignKeyDefinition {
    ForeignKeyDefinition {
        name: "FK \"old\"".into(),
        columns: vec!["a".into(), "b".into()],
        referenced_schema: "Parent Owner".into(),
        referenced_table: "Parent Table".into(),
        referenced_columns: vec!["x".into(), "y".into()],
        delete_rule: DeleteRule::NoAction,
        enabled: true,
        validated: true,
        deferrable: false,
        initially_deferred: false,
        rely: false,
    }
}
fn change() -> ForeignKeyChange {
    let mut desired = key();
    desired.name = "FK new".into();
    desired.columns.reverse();
    desired.referenced_columns.reverse();
    desired.delete_rule = DeleteRule::Cascade;
    ForeignKeyChange {
        schema: "Owner".into(),
        table_name: "Child\"Table".into(),
        original_name: Some(key().name),
        desired: Some(desired),
    }
}
fn session(engine: Engine, request: &ForeignKeyChange) -> Session {
    Session {
        engine,
        fixture: Mutex::new(Fixture {
            current: Some(key()),
            desired: request.desired.clone(),
            queries: vec![],
            writes: vec![],
            stamp: 1,
            fail_step: None,
            violations: false,
            eligible: true,
            privilege: true,
            truncated: false,
        }),
    }
}

#[async_trait]
impl ConstraintSession for Session {
    fn engine(&self) -> Engine {
        self.engine
    }
    async fn query(&self, sql: &str) -> Result<db::QueryResult, String> {
        let mut fixture = self.fixture.lock().unwrap();
        fixture.queries.push(sql.into());
        let mut result = if sql.starts_with("SELECT c.CONSTRAINT_NAME,c.STATUS,c.VALIDATED") {
            rows(
                fixture
                    .current
                    .as_ref()
                    .filter(|key| sql.contains(&format!("c.CONSTRAINT_NAME={}", literal(&key.name))))
                    .map(|key| {
                        key.columns
                            .iter()
                            .zip(&key.referenced_columns)
                            .map(|(source, target)| {
                                vec![
                                    json!(key.name),
                                    json!(if key.enabled { "ENABLED" } else { "DISABLED" }),
                                    json!(if key.validated { "VALIDATED" } else { "NOT VALIDATED" }),
                                    json!(if key.deferrable { "DEFERRABLE" } else { "NOT DEFERRABLE" }),
                                    json!(if key.initially_deferred { "DEFERRED" } else { "IMMEDIATE" }),
                                    json!(match key.delete_rule {
                                        DeleteRule::NoAction => "NO ACTION",
                                        DeleteRule::Cascade => "CASCADE",
                                        DeleteRule::SetNull => "SET NULL",
                                    }),
                                    json!(key.referenced_schema),
                                    json!(key.referenced_table),
                                    json!(source),
                                    json!(target),
                                    json!(if key.rely { "RELY" } else { "NORELY" }),
                                ]
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            )
        } else if sql.starts_with("SELECT c.CONSTRAINT_NAME,c.STATUS,c.DEFERRABLE") {
            let status = if fixture.eligible { "ENABLED" } else { "DISABLED" };
            rows(vec![
                vec![json!("PK"), json!(status), json!("NOT DEFERRABLE"), json!("x")],
                vec![json!("PK"), json!(status), json!("NOT DEFERRABLE"), json!("y")],
                vec![json!("UQ"), json!(status), json!("NOT DEFERRABLE"), json!("y")],
                vec![json!("UQ"), json!(status), json!("NOT DEFERRABLE"), json!("x")],
            ])
        } else if sql == "SELECT USER FROM DUAL" {
            rows(vec![vec![json!("Owner")]])
        } else if sql.starts_with("SELECT OBJECT_ID") {
            rows(vec![vec![json!(1), json!(fixture.stamp)]])
        } else if sql.contains("FROM ALL_TABLES") {
            rows(vec![vec![json!(1)]])
        } else if sql.starts_with("SELECT COLUMN_NAME,DATA_TYPE") {
            rows(
                ["a", "b", "x", "y"]
                    .into_iter()
                    .map(|name| vec![json!(name), json!("NUMBER"), Value::Null, Value::Null])
                    .collect(),
            )
        } else if sql.contains("FROM ALL_TAB_COLUMNS") {
            rows(vec![vec![json!(2)]])
        } else if sql.contains("FROM ALL_TAB_PRIVS") || sql.contains("FROM ALL_COL_PRIVS") {
            rows(vec![vec![json!(u64::from(fixture.privilege))]])
        } else if sql.starts_with("SELECT COUNT(*) FROM ALL_CONSTRAINTS") {
            rows(vec![vec![json!(u64::from(
                fixture
                    .current
                    .as_ref()
                    .is_some_and(|key| sql.contains(&format!("CONSTRAINT_NAME={}", literal(&key.name))))
            ))]])
        } else if sql.contains("NOT EXISTS") {
            rows(vec![vec![json!(u64::from(fixture.violations))]])
        } else if sql.starts_with("ALTER TABLE") {
            fixture.writes.push(sql.into());
            if fixture.fail_step == Some(fixture.writes.len()) {
                return Err("database rejected DDL".into());
            }
            if sql.contains(" DROP CONSTRAINT ") {
                fixture.current = None;
            } else {
                fixture.current = fixture.desired.clone();
            }
            fixture.stamp += 1;
            rows(vec![])
        } else {
            return Err(format!("Unexpected SQL: {sql}"));
        };
        result.truncated = fixture.truncated;
        Ok(result)
    }
}

#[tokio::test]
async fn composite_quoted_cross_schema_replacement_preserves_order_and_reads_actual_result() {
    for engine in [Engine::Oracle, Engine::OceanBaseOracle] {
        let request = change();
        let session = session(engine, &request);
        let plan = preview_foreign_key(&session, &request).await.unwrap();
        assert_eq!(plan.statements.len(), 2);
        assert_eq!(plan.statements[0], "ALTER TABLE \"Owner\".\"Child\"\"Table\" DROP CONSTRAINT \"FK \"\"old\"\"\"");
        assert!(plan.statements[1].contains(
            "FOREIGN KEY (\"b\", \"a\") REFERENCES \"Parent Owner\".\"Parent Table\" (\"y\", \"x\") ON DELETE CASCADE"
        ));
        assert_eq!(plan.statements[1].contains("NOT DEFERRABLE"), engine == Engine::Oracle);
        assert!(session.fixture.lock().unwrap().writes.is_empty());
        let result = apply_foreign_key(&session, &request, &plan.revision).await.unwrap();
        assert!(result.success);
        assert_eq!(result.current_constraint, request.desired);
        assert!(result.original_constraint.is_none());
    }
}

#[tokio::test]
async fn invalid_data_missing_reference_privileges_and_truncated_metadata_block_before_drop() {
    for engine in [Engine::Oracle, Engine::OceanBaseOracle] {
        for failure in ["data", "key", "grant", "truncated"] {
            let request = change();
            let session = session(engine, &request);
            {
                let mut fixture = session.fixture.lock().unwrap();
                match failure {
                    "data" => fixture.violations = true,
                    "key" => fixture.eligible = false,
                    "grant" => fixture.privilege = false,
                    _ => fixture.truncated = true,
                }
            }
            assert!(preview_foreign_key(&session, &request).await.is_err(), "{failure}");
            assert!(session.fixture.lock().unwrap().writes.is_empty());
        }
    }
}

#[tokio::test]
async fn partial_failure_returns_original_recovery_without_replaying_drop() {
    let request = change();
    let session = session(Engine::Oracle, &request);
    session.fixture.lock().unwrap().fail_step = Some(2);
    let plan = preview_foreign_key(&session, &request).await.unwrap();
    let result = apply_foreign_key(&session, &request, &plan.revision).await.unwrap();
    assert!(!result.success);
    assert_eq!(result.steps.len(), 2);
    assert!(result.current_constraint.is_none());
    assert_eq!(result.recovery_statements, plan.recovery_statements);
    assert!(result.recovery_statements[0].contains("CONSTRAINT \"FK \"\"old\"\"\""));
    assert!(apply_foreign_key(&session, &request, &plan.revision).await.is_err());
    assert_eq!(session.fixture.lock().unwrap().writes.len(), 2);
}

#[tokio::test]
async fn stale_plan_is_rejected_and_novalidate_does_not_reject_existing_orphans() {
    let mut request = change();
    request.desired.as_mut().unwrap().validated = false;
    let session = session(Engine::OceanBaseOracle, &request);
    session.fixture.lock().unwrap().violations = true;
    let plan = preview_foreign_key(&session, &request).await.unwrap();
    assert!(plan.statements[1].ends_with("ENABLE NOVALIDATE"));
    session.fixture.lock().unwrap().stamp += 1;
    assert!(apply_foreign_key(&session, &request, &plan.revision).await.is_err());
    assert!(session.fixture.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn composite_validation_exempts_rows_with_any_null_component() {
    let request = change();
    let session = session(Engine::Oracle, &request);
    preview_foreign_key(&session, &request).await.unwrap();
    let fixture = session.fixture.lock().unwrap();
    let query = fixture.queries.iter().find(|sql| sql.contains("NOT EXISTS")).unwrap();
    assert!(query.contains("s.\"b\" IS NOT NULL AND s.\"a\" IS NOT NULL"));
    assert!(query.contains("s.\"b\"=p.\"y\" AND s.\"a\"=p.\"x\""));
}

#[test]
fn definition_validation_rejects_duplicate_columns_and_unsupported_deferred_state() {
    let request = change();
    let mut key = request.desired.clone().unwrap();
    key.deferrable = true;
    assert!(foreign_key_sql(Engine::OceanBaseOracle, &request, &key).is_err());
    assert!(foreign_key_sql(Engine::Oracle, &request, &key).is_ok());
    key.columns[1] = key.columns[0].clone();
    assert!(foreign_key_sql(Engine::Oracle, &request, &key).is_err());
}

#[tokio::test]
async fn add_self_reference_and_drop_use_one_statement_and_name_collisions_are_rejected() {
    for engine in [Engine::Oracle, Engine::OceanBaseOracle] {
        let mut add = change();
        add.original_name = None;
        add.desired.as_mut().unwrap().referenced_schema = add.schema.clone();
        add.desired.as_mut().unwrap().referenced_table = add.table_name.clone();
        let session = session(engine, &add);
        session.fixture.lock().unwrap().current = None;
        let plan = preview_foreign_key(&session, &add).await.unwrap();
        assert_eq!(plan.statements.len(), 1);
        assert!(!plan.statements[0].contains("DROP"));
        assert!(apply_foreign_key(&session, &add, &plan.revision).await.unwrap().success);
        let drop = ForeignKeyChange {
            original_name: Some(add.desired.as_ref().unwrap().name.clone()),
            desired: None,
            ..add.clone()
        };
        let plan = preview_foreign_key(&session, &drop).await.unwrap();
        assert_eq!(plan.statements.len(), 1);
        assert!(plan.statements[0].contains("DROP CONSTRAINT"));
        assert!(apply_foreign_key(&session, &drop, &plan.revision).await.unwrap().success);
    }
    let mut add = change();
    add.original_name = None;
    add.desired.as_mut().unwrap().name = key().name;
    let session = session(Engine::Oracle, &add);
    assert!(preview_foreign_key(&session, &add).await.is_err());
    assert!(session.fixture.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn state_only_change_does_not_drop_and_rely_is_preserved_in_recovery() {
    let mut original = key();
    original.rely = true;
    let mut desired = original.clone();
    desired.enabled = false;
    desired.validated = false;
    let request = ForeignKeyChange {
        schema: "Owner".into(),
        table_name: "Child\"Table".into(),
        original_name: Some(original.name.clone()),
        desired: Some(desired),
    };
    let session = session(Engine::Oracle, &request);
    session.fixture.lock().unwrap().current = Some(original);
    let plan = preview_foreign_key(&session, &request).await.unwrap();
    assert_eq!(plan.statements.len(), 1);
    assert!(plan.statements[0].contains(" DISABLE NOVALIDATE CONSTRAINT "));
    assert!(plan.recovery_statements[0].contains(" RELY "));
    assert!(apply_foreign_key(&session, &request, &plan.revision).await.unwrap().success);
}
