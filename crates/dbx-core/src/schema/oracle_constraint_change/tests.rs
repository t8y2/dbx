use super::*;
use serde_json::{json, Value};
use std::sync::Mutex;

struct Database {
    engine: Engine,
    key: Option<KeySnapshot>,
    candidate: Vec<String>,
    writes: Vec<String>,
    references: u64,
    dependency_error: bool,
    nulls: bool,
    duplicates: bool,
    fail_step: Option<usize>,
    stamp: u64,
    truncate: bool,
    original_index_exists: bool,
}

struct Session(Mutex<Database>);

fn rows(rows: Vec<Vec<Value>>) -> db::QueryResult {
    serde_json::from_value(json!({ "columns": [], "rows": rows, "affected_rows": 0, "execution_time_ms": 0 })).unwrap()
}

fn change() -> PrimaryKeyChange {
    PrimaryKeyChange {
        schema: "Owner Mixed".into(),
        table_name: "Table\"name".into(),
        columns: vec!["Key B".into(), "Key A".into()],
        drop_previous_index: false,
    }
}

fn session() -> Session {
    Session(Mutex::new(Database {
        engine: Engine::Oracle,
        key: Some(KeySnapshot {
            name: "PK \"legacy\"".into(),
            columns: vec!["Key A".into()],
            enabled: true,
            validated: true,
            deferrable: false,
            initially_deferred: false,
            index_owner: Some("Owner Mixed".into()),
            index_name: Some("User Index".into()),
        }),
        candidate: change().columns,
        writes: Vec::new(),
        references: 0,
        dependency_error: false,
        nulls: false,
        duplicates: false,
        fail_step: None,
        stamp: 1,
        truncate: false,
        original_index_exists: true,
    }))
}

#[async_trait]
impl ConstraintSession for Session {
    fn engine(&self) -> Engine {
        self.0.lock().unwrap().engine
    }
    async fn query(&self, sql: &str) -> Result<db::QueryResult, String> {
        let mut db = self.0.lock().unwrap();
        let mut result = if sql.starts_with("SELECT c.CONSTRAINT_NAME") {
            rows(
                db.key
                    .as_ref()
                    .map(|key| {
                        key.columns
                            .iter()
                            .map(|column| {
                                vec![
                                    json!(key.name),
                                    json!(if key.enabled { "ENABLED" } else { "DISABLED" }),
                                    json!(if key.validated { "VALIDATED" } else { "NOT VALIDATED" }),
                                    json!(if key.deferrable { "DEFERRABLE" } else { "NOT DEFERRABLE" }),
                                    json!(if key.initially_deferred { "DEFERRED" } else { "IMMEDIATE" }),
                                    json!(key.index_owner),
                                    json!(key.index_name),
                                    json!(column),
                                ]
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            )
        } else if sql.contains("FROM DBA_CONSTRAINTS") {
            if db.dependency_error {
                return Err("ORA-00942".into());
            }
            rows(vec![vec![json!(db.references)]])
        } else if sql.starts_with("SELECT COUNT(*) FROM ALL_CONSTRAINTS") {
            rows(vec![vec![json!(0)]])
        } else if sql.starts_with("SELECT DBMS_METADATA.GET_DDL") {
            rows(vec![vec![json!(
                "CREATE UNIQUE INDEX \"Owner Mixed\".\"User Index\" ON \"Owner Mixed\".\"Table\"\"name\" (\"Key A\")"
            )]])
        } else if sql.starts_with("SELECT COUNT(*) FROM ALL_INDEXES") {
            rows(vec![vec![json!(u64::from(db.original_index_exists))]])
        } else if sql.contains("FROM ALL_IND_COLUMNS") {
            rows(vec![vec![json!("Owner Mixed"), json!("User Index"), json!("Key A"), json!(1), json!("ASC")]])
        } else if sql.contains("FROM ALL_INDEXES") {
            rows(vec![vec![
                json!("NORMAL"),
                json!("UNIQUE"),
                json!("VALID"),
                json!("Owner Mixed"),
                json!("Table\"name"),
            ]])
        } else if sql.contains("FROM ALL_TAB_COLUMNS") {
            rows(vec![vec![json!(db.candidate.len())]])
        } else if sql.starts_with("SELECT OBJECT_ID") {
            rows(vec![vec![json!(12), json!(db.stamp)]])
        } else if sql.contains("FROM ALL_TABLES") {
            rows(vec![vec![json!(1)]])
        } else if sql.contains("FROM ALL_OBJECTS") {
            rows(vec![vec![json!(0)]])
        } else if sql.contains(" IS NULL") {
            rows(vec![vec![json!(u64::from(db.nulls))]])
        } else if sql.contains("HAVING COUNT(*)>1") {
            rows(vec![vec![json!(u64::from(db.duplicates))]])
        } else if sql.starts_with("CREATE ") || sql.starts_with("ALTER TABLE ") || sql.starts_with("DROP INDEX ") {
            db.writes.push(sql.to_string());
            if db.fail_step == Some(db.writes.len()) {
                return Err("DDL rejected by database".into());
            }
            if sql.contains(" DROP CONSTRAINT ") || sql.ends_with(" DROP PRIMARY KEY") {
                db.key = None;
            }
            if sql.contains(" MODIFY PRIMARY KEY ") {
                let columns = db.candidate.clone();
                db.key.as_mut().unwrap().columns = columns;
            }
            if sql.starts_with("DROP INDEX ") {
                db.original_index_exists = false;
            }
            if sql.contains(" ADD CONSTRAINT ") {
                db.key = Some(KeySnapshot {
                    name: "PK \"legacy\"".into(),
                    columns: db.candidate.clone(),
                    enabled: true,
                    validated: true,
                    deferrable: false,
                    initially_deferred: false,
                    index_owner: Some("Owner Mixed".into()),
                    index_name: Some("Replacement Index".into()),
                });
            }
            db.stamp += 1;
            rows(Vec::new())
        } else {
            return Err(format!("Unexpected database request: {sql}"));
        };
        result.truncated = db.truncate;
        Ok(result)
    }
}

fn oceanbase_session() -> Session {
    let session = session();
    {
        let mut db = session.0.lock().unwrap();
        db.engine = Engine::OceanBaseOracle;
        let key = db.key.as_mut().unwrap();
        key.index_owner = None;
        key.index_name = None;
    }
    session
}

#[tokio::test]
async fn oceanbase_replaces_key_in_one_statement_without_dropping_original_first() {
    let session = oceanbase_session();
    let plan = preview(&session, &change()).await.unwrap();
    assert_eq!(
        plan.statements,
        ["ALTER TABLE \"Owner Mixed\".\"Table\"\"name\" MODIFY PRIMARY KEY (\"Key B\", \"Key A\")"]
    );
    let result = apply(&session, &change(), &plan.revision).await.unwrap();
    assert!(result.success);
    assert_eq!(result.steps.len(), 1);
    assert_eq!(result.current_constraint.unwrap().columns, change().columns);
    assert!(apply(&session, &change(), &plan.revision).await.is_err());
    assert_eq!(session.0.lock().unwrap().writes.len(), 1);
}

#[tokio::test]
async fn oceanbase_failed_modify_reads_original_and_does_not_offer_duplicate_restore() {
    let session = oceanbase_session();
    session.0.lock().unwrap().fail_step = Some(1);
    let plan = preview(&session, &change()).await.unwrap();
    let result = apply(&session, &change(), &plan.revision).await.unwrap();
    assert!(!result.success);
    assert_eq!(result.current_constraint.unwrap().columns, ["Key A"]);
    assert!(result.recovery_statements.is_empty());
}

#[tokio::test]
async fn oceanbase_drop_exposes_original_name_and_order_for_recovery_and_add_has_no_index_ddl() {
    let session = oceanbase_session();
    let mut request = change();
    request.columns.clear();
    let plan = preview(&session, &request).await.unwrap();
    assert!(plan.statements[0].ends_with(" DROP PRIMARY KEY"));
    assert_eq!(
        plan.recovery_statements,
        ["ALTER TABLE \"Owner Mixed\".\"Table\"\"name\" ADD CONSTRAINT \"PK \"\"legacy\"\"\" PRIMARY KEY (\"Key A\")"]
    );
    let result = apply(&session, &request, &plan.revision).await.unwrap();
    assert!(result.success);
    assert!(result.current_constraint.is_none());
    let add = preview(&session, &change()).await.unwrap();
    assert_eq!(add.statements.len(), 1);
    assert!(add.statements[0].contains(" ADD CONSTRAINT "));
    assert!(!add.statements[0].contains("USING INDEX"));
}

#[tokio::test]
async fn oceanbase_rejects_unsafe_candidates_dependencies_states_and_oracle_index_options() {
    for failure in ["null", "duplicate", "referenced", "permission", "state", "index-option", "partial-index"] {
        let session = oceanbase_session();
        let mut request = change();
        {
            let mut db = session.0.lock().unwrap();
            match failure {
                "null" => db.nulls = true,
                "duplicate" => db.duplicates = true,
                "referenced" => db.references = 1,
                "permission" => db.dependency_error = true,
                "state" => db.key.as_mut().unwrap().deferrable = true,
                "partial-index" => db.key.as_mut().unwrap().index_owner = Some("Owner Mixed".into()),
                _ => request.drop_previous_index = true,
            }
        }
        assert!(preview(&session, &request).await.is_err(), "{failure}");
        assert!(session.0.lock().unwrap().writes.is_empty());
    }
}

#[tokio::test]
async fn replacement_prepares_index_preserves_original_and_verifies_order() {
    let session = session();
    let request = change();
    let plan = preview(&session, &request).await.unwrap();
    assert!(session.0.lock().unwrap().writes.is_empty());
    assert!(plan.statements[0].starts_with("CREATE UNIQUE INDEX"));
    assert!(plan.statements[0].ends_with("(\"Key B\", \"Key A\")"));
    assert!(plan.statements[1].ends_with("DROP CONSTRAINT \"PK \"\"legacy\"\"\" KEEP INDEX"));
    assert!(plan.recovery_statements[0].contains("USING INDEX \"Owner Mixed\".\"User Index\""));
    let result = apply(&session, &request, &plan.revision).await.unwrap();
    assert!(result.success);
    assert_eq!(result.current_constraint.unwrap().columns, request.columns);
    assert_eq!(result.steps.len(), 3);
}

#[tokio::test]
async fn null_duplicate_and_incomplete_dependency_checks_never_execute_ddl() {
    for failure in ["null", "duplicate", "referenced", "permission", "truncated"] {
        let session = session();
        {
            let mut db = session.0.lock().unwrap();
            match failure {
                "null" => db.nulls = true,
                "duplicate" => db.duplicates = true,
                "referenced" => db.references = 1,
                "permission" => db.dependency_error = true,
                _ => db.truncate = true,
            }
        }
        assert!(preview(&session, &change()).await.is_err(), "{failure}");
        assert!(session.0.lock().unwrap().writes.is_empty());
        assert!(session.0.lock().unwrap().key.is_some());
    }
}

#[tokio::test]
async fn stale_preview_and_data_changed_after_preview_preserve_original() {
    for data_changed in [false, true] {
        let session = session();
        let plan = preview(&session, &change()).await.unwrap();
        if data_changed {
            session.0.lock().unwrap().duplicates = true;
        } else {
            session.0.lock().unwrap().stamp += 1;
        }
        assert!(apply(&session, &change(), &plan.revision).await.is_err());
        assert!(session.0.lock().unwrap().writes.is_empty());
    }
}

#[tokio::test]
async fn index_failure_keeps_old_key_and_add_failure_exposes_recovery_without_rollback_claim() {
    for fail_step in [1, 3] {
        let session = session();
        session.0.lock().unwrap().fail_step = Some(fail_step);
        let plan = preview(&session, &change()).await.unwrap();
        let result = apply(&session, &change(), &plan.revision).await.unwrap();
        assert!(!result.success);
        assert_eq!(result.steps.len(), fail_step);
        assert_eq!(result.steps.last().unwrap().error.as_deref(), Some("DDL rejected by database"));
        assert_eq!(result.current_constraint.is_none(), fail_step == 3);
        assert_eq!(result.recovery_statements.len(), usize::from(fail_step == 3));
        if fail_step == 3 {
            assert_eq!(result.recovery_statements, plan.recovery_statements);
            assert_eq!(session.0.lock().unwrap().writes.len(), 3);
            assert!(apply(&session, &change(), &plan.revision).await.is_err());
            assert_eq!(session.0.lock().unwrap().writes.len(), 3);
        }
    }
}

#[tokio::test]
async fn complete_removal_has_one_drop_and_retains_supporting_index() {
    let session = session();
    let mut request = change();
    request.columns.clear();
    let plan = preview(&session, &request).await.unwrap();
    assert_eq!(plan.statements.len(), 1);
    assert!(plan.statements[0].ends_with("KEEP INDEX"));
    let result = apply(&session, &request, &plan.revision).await.unwrap();
    assert!(result.success);
    assert!(result.current_constraint.is_none());
}

#[tokio::test]
async fn no_existing_key_adds_without_drop_and_duplicate_column_input_is_refused() {
    let session = session();
    session.0.lock().unwrap().key = None;
    let plan = preview(&session, &change()).await.unwrap();
    assert_eq!(plan.statements.len(), 2);
    assert!(!plan.statements.iter().any(|sql| sql.contains("DROP")));
    let mut duplicate = change();
    duplicate.columns.push("Key A".into());
    assert!(preview(&session, &duplicate).await.is_err());
}

#[tokio::test]
async fn explicit_index_removal_runs_after_new_key_and_preserves_recovery_definition() {
    let session = session();
    let mut request = change();
    request.drop_previous_index = true;
    let plan = preview(&session, &request).await.unwrap();
    assert!(plan.statements.last().unwrap().starts_with("DROP INDEX"));
    assert_eq!(plan.recovery_statements.len(), 2);
    let result = apply(&session, &request, &plan.revision).await.unwrap();
    assert!(result.success);
    assert!(!session.0.lock().unwrap().original_index_exists);
    assert_eq!(result.steps.len(), 4);
}

#[tokio::test]
async fn failed_add_keeps_original_index_and_returns_only_executable_constraint_restore() {
    let session = session();
    session.0.lock().unwrap().fail_step = Some(3);
    let mut request = change();
    request.drop_previous_index = true;
    let plan = preview(&session, &request).await.unwrap();
    let result = apply(&session, &request, &plan.revision).await.unwrap();
    assert!(!result.success);
    assert!(session.0.lock().unwrap().original_index_exists);
    assert_eq!(result.recovery_statements.len(), 1);
    assert!(result.recovery_statements[0].starts_with("ALTER TABLE"));
}
