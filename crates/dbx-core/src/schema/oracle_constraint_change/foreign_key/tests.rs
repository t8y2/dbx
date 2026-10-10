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
    name_bytes: u64,
    name_parser_accepts: bool,
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
            name_bytes: request.desired.as_ref().map_or(0, |key| key.name.len() as u64),
            name_parser_accepts: true,
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
        let mut result = if sql.starts_with("SELECT LENGTHB(") {
            rows(vec![vec![json!(fixture.name_bytes)]])
        } else if sql.starts_with("SELECT 1 AS ") {
            if !fixture.name_parser_accepts {
                return Err("ORA-00972: identifier is too long".into());
            }
            rows(vec![vec![json!(1)]])
        } else if sql.starts_with("SELECT c.CONSTRAINT_NAME,c.STATUS,c.VALIDATED") {
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
async fn requested_name_uses_engine_byte_rules_before_any_drop() {
    for (engine, name, database_bytes, parser_accepts, valid) in [
        (Engine::OceanBaseOracle, "X".repeat(129), 129, true, false),
        (Engine::OceanBaseOracle, "X".repeat(128), 128, true, true),
        (Engine::OceanBaseOracle, "汉".repeat(43), 129, true, false),
        (Engine::Oracle, "X".repeat(31), 31, false, false),
        (Engine::Oracle, "X".repeat(128), 128, true, true),
        // A single-byte database charset can represent this as 128 bytes, not UTF-8's 256.
        (Engine::Oracle, "é".repeat(128), 128, true, true),
    ] {
        let mut request = change();
        request.desired.as_mut().unwrap().name = name.clone();
        let session = session(engine, &request);
        {
            let mut fixture = session.fixture.lock().unwrap();
            fixture.name_bytes = database_bytes;
            fixture.name_parser_accepts = parser_accepts;
        }
        let preview = preview_foreign_key(&session, &request).await;
        if valid {
            assert_eq!(preview.unwrap().statements.len(), 2);
        } else {
            assert!(preview.is_err(), "invalid name produced a DROP plan: {engine:?}");
            assert!(apply_foreign_key(&session, &request, "old-revision").await.is_err());
        }
        let fixture = session.fixture.lock().unwrap();
        assert!(fixture.writes.is_empty());
        assert_eq!(fixture.current, Some(key()));
        let expected_probe = match engine {
            Engine::OceanBaseOracle => format!("SELECT LENGTHB({}) FROM DUAL", literal(&name)),
            Engine::Oracle => format!("SELECT 1 AS {} FROM DUAL", identifier(&name).unwrap()),
        };
        assert!(fixture.queries.contains(&expected_probe));
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

struct PermissionSession {
    inner: Session,
    object_grant: Result<u64, &'static str>,
    system_grant: Result<u64, &'static str>,
    granted_roles: Result<u64, &'static str>,
    role_alter: Result<u64, &'static str>,
    reference_table_grant: u64,
    reference_column_grants: Vec<String>,
    queries: Mutex<Vec<String>>,
}
impl PermissionSession {
    fn new(engine: Engine, request: &ForeignKeyChange) -> Self {
        Self {
            inner: session(engine, request),
            object_grant: Ok(0),
            system_grant: Ok(0),
            granted_roles: Ok(0),
            role_alter: Ok(0),
            reference_table_grant: 1,
            reference_column_grants: vec![],
            queries: Mutex::new(vec![]),
        }
    }
}
#[async_trait]
impl ConstraintSession for PermissionSession {
    fn engine(&self) -> Engine {
        self.inner.engine
    }
    async fn query(&self, sql: &str) -> Result<db::QueryResult, String> {
        self.queries.lock().unwrap().push(sql.into());
        if sql == "SELECT USER FROM DUAL" {
            return Ok(rows(vec![vec![json!("Visitor")]]));
        }
        if sql.contains("FROM ALL_TAB_PRIVS") && sql.contains("PRIVILEGE='REFERENCES'") {
            return Ok(rows(vec![vec![json!(self.reference_table_grant)]]));
        }
        if sql.contains("FROM ALL_COL_PRIVS") {
            let owner_column = match self.engine() {
                Engine::Oracle => "TABLE_SCHEMA",
                Engine::OceanBaseOracle => "OWNER",
            };
            if !sql.contains(&format!("WHERE {owner_column}=")) {
                return Err("ORA-00904: invalid column in ALL_COL_PRIVS".into());
            }
            let granted = self
                .reference_column_grants
                .iter()
                .any(|column| sql.contains(&format!("COLUMN_NAME={}", literal(column))));
            return Ok(rows(vec![vec![json!(u64::from(granted))]]));
        }
        let grant = if sql.contains("SESSION_PRIVS") || sql.contains("SESSION_ROLES") {
            if self.engine() == Engine::OceanBaseOracle {
                return Err("ORA-00942: SESSION dictionary view does not exist".into());
            }
            if sql.contains("SESSION_ROLES") {
                self.role_alter
            } else {
                self.system_grant
            }
        } else if sql.contains("SYS.USER_SYS_PRIVS") {
            self.system_grant
        } else if sql.contains("SYS.USER_ROLE_PRIVS") {
            self.granted_roles
        } else if sql.contains("SYS.ALL_TAB_PRIVS") && sql.contains("PRIVILEGE='ALTER'") {
            self.object_grant
        } else {
            return self.inner.query(sql).await;
        };
        grant.map(|value| rows(vec![vec![json!(value)]])).map_err(str::to_owned)
    }
}

#[tokio::test]
async fn cross_owner_column_references_use_engine_dictionary_and_require_every_column_without_writes() {
    for engine in [Engine::Oracle, Engine::OceanBaseOracle] {
        for columns in [vec![], vec!["x"], vec!["x", "y"]] {
            let request = change();
            let mut session = PermissionSession::new(engine, &request);
            session.object_grant = Ok(1);
            session.reference_table_grant = 0;
            session.reference_column_grants = columns.iter().map(|column| (*column).into()).collect();
            let result = preview_foreign_key(&session, &request).await;
            if columns.len() == 2 {
                assert_eq!(result.unwrap().statements.len(), 2);
            } else {
                assert!(result.unwrap_err().contains("direct REFERENCES grant"));
            }
            let queries = session.queries.lock().unwrap();
            assert!(queries.iter().any(|sql| sql.contains("FROM ALL_COL_PRIVS")));
            assert!(queries.iter().filter(|sql| sql.contains("FROM ALL_COL_PRIVS")).all(|sql| {
                sql.contains("TABLE_NAME='Parent Table'")
                    && sql.contains("PRIVILEGE='REFERENCES'")
                    && sql.contains("GRANTEE IN ('Visitor','PUBLIC')")
            }));
            assert!(session.inner.fixture.lock().unwrap().writes.is_empty());
            assert_eq!(session.inner.fixture.lock().unwrap().current, Some(key()));
        }
    }
}

#[tokio::test]
async fn oceanbase_cross_owner_direct_alter_grants_reach_real_foreign_key_plan_without_missing_session_views() {
    for system in [false, true] {
        let request = change();
        let mut session = PermissionSession::new(Engine::OceanBaseOracle, &request);
        if system {
            session.system_grant = Ok(1);
        } else {
            session.object_grant = Ok(1);
        }
        let plan = preview_foreign_key(&session, &request).await.unwrap();
        assert!(apply_foreign_key(&session, &request, &plan.revision).await.unwrap().success);
        assert_eq!(session.inner.fixture.lock().unwrap().writes.len(), 2);
        assert!(!session
            .queries
            .lock()
            .unwrap()
            .iter()
            .any(|query| query.contains("SESSION_PRIVS") || query.contains("SESSION_ROLES")));
    }
}

#[tokio::test]
async fn oceanbase_denied_role_unknown_and_dictionary_unknown_permissions_preserve_original_foreign_key() {
    for reason in ["denied", "role", "object dictionary", "system dictionary", "role dictionary"] {
        let request = change();
        let mut session = PermissionSession::new(Engine::OceanBaseOracle, &request);
        match reason {
            "role" => session.granted_roles = Ok(1),
            "object dictionary" => session.object_grant = Err("ORA-01031 object catalog"),
            "system dictionary" => session.system_grant = Err("ORA-01031 system catalog"),
            "role dictionary" => session.granted_roles = Err("ORA-01031 role catalog"),
            _ => (),
        }
        let error = preview_foreign_key(&session, &request).await.unwrap_err();
        assert!(error.contains(if reason == "denied" { "not granted" } else { "unknown" }), "{reason}: {error}");
        let fixture = session.inner.fixture.lock().unwrap();
        assert!(fixture.writes.is_empty());
        assert_eq!(fixture.current, Some(key()));
    }
}

#[tokio::test]
async fn independent_direct_system_grant_remains_usable_when_object_privilege_dictionary_is_unavailable() {
    let request = change();
    let mut session = PermissionSession::new(Engine::OceanBaseOracle, &request);
    session.object_grant = Err("ORA-01031 object catalog");
    session.system_grant = Ok(1);
    assert!(preview_foreign_key(&session, &request).await.is_ok());
}

#[tokio::test]
async fn native_oracle_cross_owner_effective_system_and_active_object_role_grants_are_preserved() {
    for system in [false, true] {
        let request = change();
        let mut session = PermissionSession::new(Engine::Oracle, &request);
        if system {
            session.system_grant = Ok(1);
        } else {
            session.role_alter = Ok(1);
        }
        let plan = preview_foreign_key(&session, &request).await.unwrap();
        assert!(apply_foreign_key(&session, &request, &plan.revision).await.unwrap().success);
        assert!(session.queries.lock().unwrap().iter().any(|query| query.contains("SYS.SESSION_PRIVS")));
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
async fn disabled_foreign_key_with_disabled_parent_can_be_loaded_and_deleted() {
    let mut original = key();
    original.enabled = false;
    original.validated = false;
    let request = ForeignKeyChange { desired: None, ..change() };
    let session = session(Engine::Oracle, &request);
    {
        let mut fixture = session.fixture.lock().unwrap();
        fixture.current = Some(original.clone());
        fixture.eligible = false;
    }
    // The editor loads its existing definition through the same read-only drop preview.
    let plan = preview_foreign_key(&session, &request).await.unwrap();
    assert_eq!(plan.current_constraint, Some(original));
    assert_eq!(plan.statements.len(), 1);
    assert!(plan.statements[0].contains("DROP CONSTRAINT"));
    assert!(plan.recovery_statements[0].ends_with("DISABLE NOVALIDATE"));
    assert!(session.fixture.lock().unwrap().writes.is_empty());
    let result = apply_foreign_key(&session, &request, &plan.revision).await.unwrap();
    assert!(result.success);
    assert!(result.current_constraint.is_none());
    assert_eq!(session.fixture.lock().unwrap().writes, plan.statements);
}

#[tokio::test]
async fn disabled_parent_allows_disabled_replacement_but_blocks_enabling_before_drop() {
    for enabled in [false, true] {
        let mut request = change();
        request.desired.as_mut().unwrap().enabled = enabled;
        request.desired.as_mut().unwrap().validated = false;
        let session = session(Engine::Oracle, &request);
        {
            let mut fixture = session.fixture.lock().unwrap();
            fixture.current.as_mut().unwrap().enabled = false;
            fixture.current.as_mut().unwrap().validated = false;
            fixture.eligible = false;
        }
        let plan = preview_foreign_key(&session, &request).await;
        if enabled {
            assert!(plan.unwrap_err().contains("enabled when"));
            assert!(session.fixture.lock().unwrap().writes.is_empty());
        } else {
            let plan = plan.unwrap();
            assert!(plan.statements[1].ends_with("DISABLE NOVALIDATE"));
            assert!(apply_foreign_key(&session, &request, &plan.revision).await.unwrap().success);
        }
    }
}

#[tokio::test]
async fn disabled_parent_drop_still_requires_reference_permissions_and_complete_metadata() {
    for truncated in [false, true] {
        let request = ForeignKeyChange { desired: None, ..change() };
        let session = session(Engine::Oracle, &request);
        {
            let mut fixture = session.fixture.lock().unwrap();
            fixture.current.as_mut().unwrap().enabled = false;
            fixture.eligible = false;
            fixture.privilege = truncated;
            fixture.truncated = truncated;
        }
        assert!(preview_foreign_key(&session, &request).await.is_err());
        assert!(session.fixture.lock().unwrap().writes.is_empty());
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
