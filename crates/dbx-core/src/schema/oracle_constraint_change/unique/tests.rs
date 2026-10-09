use super::*;
use serde_json::{json, Value};
use std::sync::Mutex;
struct Fixture {
    current: Option<UniqueSnapshot>,
    desired: Option<UniqueDefinition>,
    writes: Vec<String>,
    queries: Vec<String>,
    stamp: u64,
    fail_step: Option<usize>,
    duplicates: bool,
    references: u64,
    shared: u64,
    permission: bool,
    index_exists: bool,
    index_name: String,
    ambiguous: bool,
    readback_error: bool,
}
struct Session {
    engine: Engine,
    fixture: Mutex<Fixture>,
}
fn rows(rows: Vec<Vec<Value>>) -> db::QueryResult {
    serde_json::from_value(json!({"columns":[],"rows":rows,"affected_rows":0,"execution_time_ms":0})).unwrap()
}
fn key() -> UniqueDefinition {
    UniqueDefinition {
        name: "UQ \"old\"".into(),
        columns: vec!["Key A".into()],
        enabled: true,
        validated: true,
        deferrable: false,
        initially_deferred: false,
        rely: false,
    }
}
fn request() -> UniqueChange {
    let mut desired = key();
    desired.columns = vec!["Key B".into(), "Key A".into()];
    UniqueChange {
        schema: "Owner".into(),
        table_name: "Table\"Name".into(),
        original_name: Some(key().name),
        desired: Some(desired),
        drop_previous_index: false,
    }
}
fn fixture_session(engine: Engine, request: &UniqueChange) -> Session {
    let index_name = if engine == Engine::OceanBaseOracle { key().name } else { "User Index".into() };
    Session {
        engine,
        fixture: Mutex::new(Fixture {
            current: Some(UniqueSnapshot {
                definition: key(),
                index_owner: Some("Owner".into()),
                index_name: Some(index_name.clone()),
            }),
            desired: request.desired.clone(),
            writes: vec![],
            queries: vec![],
            stamp: 1,
            fail_step: None,
            duplicates: false,
            references: 0,
            shared: 0,
            permission: true,
            index_exists: true,
            index_name,
            ambiguous: false,
            readback_error: false,
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
        if sql.starts_with("SELECT c.CONSTRAINT_NAME") {
            if fixture.readback_error && !fixture.writes.is_empty() {
                return Err("dictionary unavailable".into());
            }
            return Ok(rows(
                fixture
                    .current
                    .as_ref()
                    .filter(|key| sql.contains(&format!("c.CONSTRAINT_NAME={}", literal(&key.definition.name))))
                    .map(|key| {
                        key.definition
                            .columns
                            .iter()
                            .map(|column| {
                                vec![
                                    json!(key.definition.name),
                                    json!(if key.definition.enabled { "ENABLED" } else { "DISABLED" }),
                                    json!(if key.definition.validated { "VALIDATED" } else { "NOT VALIDATED" }),
                                    json!(if key.definition.deferrable { "DEFERRABLE" } else { "NOT DEFERRABLE" }),
                                    json!(if key.definition.initially_deferred { "DEFERRED" } else { "IMMEDIATE" }),
                                    json!(key.index_owner),
                                    json!(key.index_name),
                                    json!(column),
                                    json!(if key.definition.rely { "RELY" } else { "NORELY" }),
                                ]
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            ));
        }
        if sql == "SELECT USER FROM DUAL" {
            return Ok(rows(vec![vec![json!("Owner")]]));
        }
        if sql.contains("FROM ALL_TABLES") {
            return Ok(rows(vec![vec![json!(1)]]));
        }
        if sql.starts_with("SELECT OBJECT_ID") {
            return Ok(rows(vec![vec![json!(1), json!(fixture.stamp)]]));
        }
        if sql.starts_with("SELECT OWNER,INDEX_NAME") {
            return Ok(rows(if fixture.index_exists {
                vec![vec![json!("Owner"), json!(fixture.index_name), json!("NORMAL"), json!("UNIQUE"), json!("VALID")]]
            } else {
                vec![]
            }));
        }
        if sql.contains("FROM ALL_IND_COLUMNS") {
            return Ok(rows(if fixture.index_exists {
                vec![vec![json!("Owner"), json!(fixture.index_name), json!("Key A"), json!(1), json!("ASC")]]
            } else {
                vec![]
            }));
        }
        if sql.starts_with("SELECT INDEX_TYPE") {
            return Ok(rows(if fixture.index_exists {
                vec![vec![json!("NORMAL"), json!("UNIQUE"), json!("VALID"), json!("Owner"), json!("Table\"Name")]]
            } else {
                vec![]
            }));
        }
        if sql.starts_with("SELECT COUNT(*) FROM ALL_INDEXES") {
            return Ok(rows(vec![vec![json!(u64::from(
                fixture.index_exists && sql.contains(&literal(&fixture.index_name))
            ))]]));
        }
        if sql.contains("FROM DBA_CONSTRAINTS") {
            if !fixture.permission {
                return Err("ORA-00942".into());
            }
            return Ok(rows(vec![vec![json!(if sql.contains("CONSTRAINT_TYPE='R'") {
                fixture.references
            } else {
                fixture.shared
            })]]));
        }
        if sql.starts_with("SELECT DBMS_METADATA.GET_DDL") {
            return Ok(rows(vec![vec![json!(format!(
                "CREATE UNIQUE INDEX {} ON \"Owner\".\"Table\"\"Name\" (\"Key A\")",
                qualified("Owner", &fixture.index_name)?
            ))]]));
        }
        if sql.contains("FROM ALL_CONSTRAINTS") {
            return Ok(rows(vec![vec![json!(if fixture.ambiguous {
                2
            } else {
                u64::from(
                    fixture
                        .current
                        .as_ref()
                        .is_some_and(|key| sql.contains(&format!("CONSTRAINT_NAME={}", literal(&key.definition.name)))),
                )
            })]]));
        }
        if sql.contains("FROM ALL_TAB_COLUMNS") {
            return Ok(rows(vec![vec![json!(fixture.desired.as_ref().unwrap().columns.len())]]));
        }
        if sql.contains("HAVING COUNT(*)>1") {
            return Ok(rows(vec![vec![json!(u64::from(fixture.duplicates))]]));
        }
        if sql.contains("FROM ALL_OBJECTS") {
            return Ok(rows(vec![vec![json!(0)]]));
        }
        if sql.starts_with("ALTER TABLE") || sql.starts_with("CREATE INDEX") || sql.starts_with("DROP INDEX") {
            fixture.writes.push(sql.into());
            if fixture.fail_step == Some(fixture.writes.len()) {
                return Err("DDL rejected".into());
            }
            if sql.contains(" DROP CONSTRAINT ") {
                fixture.current = None;
            } else if sql.starts_with("DROP INDEX") {
                fixture.index_exists = false;
                if self.engine == Engine::OceanBaseOracle {
                    fixture.current = None;
                }
            } else if sql.starts_with("ALTER TABLE") {
                let definition = fixture.desired.clone().unwrap();
                let index_name = if self.engine == Engine::OceanBaseOracle {
                    definition.name.clone()
                } else if sql.contains(" RENAME CONSTRAINT ") || sql.contains(&qualified("Owner", &fixture.index_name)?) {
                    fixture.index_name.clone()
                } else {
                    "Replacement Index".into()
                };
                fixture.current = Some(UniqueSnapshot {
                    definition,
                    index_owner: Some("Owner".into()),
                    index_name: Some(index_name),
                });
            }
            fixture.stamp += 1;
            return Ok(rows(vec![]));
        }
        Err(format!("Unexpected query: {sql}"))
    }
}

#[tokio::test]
async fn oracle_name_only_rename_preserves_the_backing_index() {
    let mut request = request();
    let mut desired = key();
    desired.name = "UQ renamed".into();
    request.desired = Some(desired);
    let session = fixture_session(Engine::Oracle, &request);
    let plan = preview_unique(&session, &request).await.unwrap();
    assert_eq!(plan.statements.len(), 1);
    assert!(plan.statements[0].contains(" RENAME CONSTRAINT "));
    let result = apply_unique(&session, &request, &plan.revision).await.unwrap();
    assert!(result.success);
    let current = result.current_constraint.unwrap();
    assert_eq!(current.definition, request.desired.unwrap());
    assert_eq!(current.index_name.as_deref(), Some("User Index"));
    assert!(session.fixture.lock().unwrap().index_exists);
}

#[tokio::test]
async fn stale_preview_refuses_writes_and_preserves_original_unique_constraint() {
    for engine in [Engine::Oracle, Engine::OceanBaseOracle] {
        let request = request();
        let session = fixture_session(engine, &request);
        let plan = preview_unique(&session, &request).await.unwrap();
        session.fixture.lock().unwrap().stamp += 1;
        assert!(apply_unique(&session, &request, &plan.revision).await.is_err());
        let fixture = session.fixture.lock().unwrap();
        assert!(fixture.writes.is_empty());
        assert_eq!(fixture.current.as_ref().unwrap().definition, key());
    }
}

#[tokio::test]
async fn failed_dictionary_readback_does_not_report_success_or_fabricate_recovery() {
    for engine in [Engine::Oracle, Engine::OceanBaseOracle] {
        let request = request();
        let session = fixture_session(engine, &request);
        let plan = preview_unique(&session, &request).await.unwrap();
        session.fixture.lock().unwrap().readback_error = true;
        let result = apply_unique(&session, &request, &plan.revision).await.unwrap();
        assert!(!result.success);
        assert!(result.refresh_error.is_some());
        assert!(result.current_constraint.is_none());
        assert!(result.recovery_statements.is_empty());
        assert_eq!(session.fixture.lock().unwrap().writes.len(), plan.statements.len());
    }
}

#[tokio::test]
async fn oracle_preserves_user_index_while_oceanbase_manages_confirmed_unique_index_identity() {
    for engine in [Engine::Oracle, Engine::OceanBaseOracle] {
        let request = request();
        let session = fixture_session(engine, &request);
        let plan = preview_unique(&session, &request).await.unwrap();
        if engine == Engine::Oracle {
            assert_eq!(plan.statements.len(), 3);
            assert!(plan.statements[0].starts_with("CREATE INDEX"));
            assert!(plan.statements[1].ends_with("KEEP INDEX"));
        } else {
            assert_eq!(plan.statements.len(), 2);
            assert!(plan.statements[0].starts_with("DROP INDEX"));
            assert!(!plan.statements[1].contains("ENABLE"));
        }
        assert!(plan.statements.last().unwrap().contains("UNIQUE (\"Key B\", \"Key A\")"));
        let result = apply_unique(&session, &request, &plan.revision).await.unwrap();
        assert!(result.success);
        assert_eq!(result.current_constraint.unwrap().definition, request.desired.unwrap());
    }
}

#[tokio::test]
async fn duplicate_partial_null_keys_are_checked_but_all_null_keys_are_exempt() {
    let request = request();
    let session = fixture_session(Engine::Oracle, &request);
    preview_unique(&session, &request).await.unwrap();
    let fixture = session.fixture.lock().unwrap();
    let query = fixture.queries.iter().find(|sql| sql.contains("HAVING COUNT(*)>1")).unwrap();
    assert!(query.contains("\"Key B\" IS NOT NULL OR \"Key A\" IS NOT NULL"));
}

#[tokio::test]
async fn references_unknown_permissions_shared_indexes_and_ambiguous_constraint_identity_block_ddl() {
    for reason in ["references", "permission", "shared", "ambiguous", "duplicates"] {
        let mut request = request();
        request.drop_previous_index = true;
        let session = fixture_session(Engine::Oracle, &request);
        {
            let mut fixture = session.fixture.lock().unwrap();
            match reason {
                "references" => fixture.references = 1,
                "permission" => fixture.permission = false,
                "shared" => fixture.shared = 1,
                "ambiguous" => fixture.ambiguous = true,
                _ => fixture.duplicates = true,
            }
        }
        assert!(preview_unique(&session, &request).await.is_err(), "{reason}");
        assert!(session.fixture.lock().unwrap().writes.is_empty());
    }
}

#[tokio::test]
async fn failed_add_returns_recovery_for_the_original_constraint_and_does_not_replay() {
    for engine in [Engine::Oracle, Engine::OceanBaseOracle] {
        let request = request();
        let session = fixture_session(engine, &request);
        let fail = if engine == Engine::Oracle { 3 } else { 2 };
        session.fixture.lock().unwrap().fail_step = Some(fail);
        let plan = preview_unique(&session, &request).await.unwrap();
        let result = apply_unique(&session, &request, &plan.revision).await.unwrap();
        assert!(!result.success);
        assert!(result.current_constraint.is_none());
        assert_eq!(result.recovery_statements, plan.recovery_statements);
        assert!(apply_unique(&session, &request, &plan.revision).await.is_err());
        assert_eq!(session.fixture.lock().unwrap().writes.len(), fail);
    }
}

#[tokio::test]
async fn a_standalone_unique_index_is_not_accepted_as_the_original_constraint_but_can_back_a_new_oracle_constraint() {
    let request = request();
    let session = fixture_session(Engine::Oracle, &request);
    session.fixture.lock().unwrap().current = None;
    assert!(preview_unique(&session, &request).await.is_err());
    let mut add = request;
    add.original_name = None;
    add.desired.as_mut().unwrap().columns = vec!["Key A".into()];
    session.fixture.lock().unwrap().desired = add.desired.clone();
    let plan = preview_unique(&session, &add).await.unwrap();
    assert_eq!(plan.statements.len(), 1);
    assert!(plan.statements[0].contains("USING INDEX \"Owner\".\"User Index\""));
    assert!(apply_unique(&session, &add, &plan.revision).await.unwrap().success);
}

#[tokio::test]
async fn oracle_state_changes_preserve_indexes_and_ob_rejects_unsupported_options() {
    let mut request = request();
    let mut desired = key();
    desired.enabled = false;
    desired.validated = false;
    request.desired = Some(desired);
    let session = fixture_session(Engine::Oracle, &request);
    let plan = preview_unique(&session, &request).await.unwrap();
    assert_eq!(plan.statements.len(), 1);
    assert!(plan.statements[0].contains("DISABLE NOVALIDATE CONSTRAINT"));
    assert!(plan.statements[0].ends_with("KEEP INDEX"));
    assert!(apply_unique(&session, &request, &plan.revision).await.unwrap().success);
    let session = fixture_session(Engine::OceanBaseOracle, &request);
    assert!(preview_unique(&session, &request).await.is_err());
    assert!(session.fixture.lock().unwrap().queries.is_empty());
}

#[tokio::test]
async fn complete_removal_preserves_the_oracle_index_and_explicit_removal_has_recovery_definition() {
    for drop_index in [false, true] {
        let mut request = request();
        request.desired = None;
        request.drop_previous_index = drop_index;
        let session = fixture_session(Engine::Oracle, &request);
        let plan = preview_unique(&session, &request).await.unwrap();
        let result = apply_unique(&session, &request, &plan.revision).await.unwrap();
        assert!(result.success);
        assert!(result.current_constraint.is_none());
        assert_eq!(session.fixture.lock().unwrap().index_exists, !drop_index);
        assert_eq!(result.recovery_statements.len(), if drop_index { 2 } else { 1 });
    }
}
