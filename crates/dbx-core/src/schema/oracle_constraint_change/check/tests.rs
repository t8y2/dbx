use super::*;
use serde_json::{json, Value};
use std::sync::Mutex;

struct Fixture {
    current: Option<CheckDefinition>,
    desired: Option<CheckDefinition>,
    writes: Vec<String>,
    queries: Vec<String>,
    stamp: u64,
    fail_step: Option<usize>,
    violations: bool,
    readback_error: bool,
    privilege: bool,
    nonnullable: bool,
    name_error: Option<String>,
    name_bytes: u64,
}
struct Session {
    engine: Engine,
    fixture: Mutex<Fixture>,
}
fn rows(rows: Vec<Vec<Value>>) -> db::QueryResult {
    serde_json::from_value(json!({"columns":[],"rows":rows,"affected_rows":0,"execution_time_ms":0})).unwrap()
}
fn key() -> CheckDefinition {
    CheckDefinition {
        name: "CK \"old\"".into(),
        expression: "\"amount\" >= 0\nAND (\"label\" <> q'[a;);b]' OR \"label\" IS NULL)".into(),
        enabled: true,
        validated: true,
        deferrable: false,
        initially_deferred: false,
        rely: false,
    }
}
fn request() -> CheckChange {
    let mut desired = key();
    desired.expression = "\"amount\" >= 1\nAND LENGTH(\"label\") < 50".into();
    CheckChange {
        schema: "Owner".into(),
        table_name: "Table\"Name".into(),
        original_name: Some(key().name),
        desired: Some(desired),
    }
}
fn session(engine: Engine, request: &CheckChange) -> Session {
    Session {
        engine,
        fixture: Mutex::new(Fixture {
            current: Some(key()),
            desired: request.desired.clone(),
            writes: vec![],
            queries: vec![],
            stamp: 1,
            fail_step: None,
            violations: false,
            readback_error: false,
            privilege: true,
            nonnullable: false,
            name_error: None,
            name_bytes: 20,
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
        if sql.starts_with("SELECT LENGTHB(") || sql.starts_with("SELECT 1 AS ") {
            if let Some(error) = &fixture.name_error {
                return Err(error.clone());
            }
            return Ok(rows(vec![vec![json!(if self.engine == Engine::OceanBaseOracle {
                fixture.name_bytes
            } else {
                1
            })]]));
        }
        if sql.starts_with("SELECT CONSTRAINT_NAME,SEARCH_CONDITION") {
            if fixture.readback_error && !fixture.writes.is_empty() {
                return Err("dictionary unavailable".into());
            }
            return Ok(rows(
                fixture
                    .current
                    .as_ref()
                    .filter(|key| sql.contains(&format!("CONSTRAINT_NAME={}", literal(&key.name))))
                    .map(|key| {
                        vec![vec![
                            json!(key.name),
                            json!(key.expression),
                            json!(if key.enabled { "ENABLED" } else { "DISABLED" }),
                            json!(if key.validated { "VALIDATED" } else { "NOT VALIDATED" }),
                            json!(if key.deferrable { "DEFERRABLE" } else { "NOT DEFERRABLE" }),
                            json!(if key.initially_deferred { "DEFERRED" } else { "IMMEDIATE" }),
                            json!(if key.rely { "RELY" } else { "NORELY" }),
                        ]]
                    })
                    .unwrap_or_default(),
            ));
        }
        if sql == "SELECT USER FROM DUAL" {
            return Ok(rows(vec![vec![json!(if fixture.privilege { "Owner" } else { "Other" })]]));
        }
        if sql.starts_with("SELECT OBJECT_ID") {
            return Ok(rows(vec![vec![json!(1), json!(fixture.stamp)]]));
        }
        if sql.contains("FROM ALL_TABLES") {
            return Ok(rows(vec![vec![json!(1)]]));
        }
        if sql.contains("FROM ALL_TAB_COLUMNS") {
            return Ok(rows(if fixture.nonnullable { vec![vec![json!("amount")]] } else { vec![] }));
        }
        if sql.contains("FROM ALL_CONSTRAINTS") {
            return Ok(rows(vec![vec![json!(u64::from(
                fixture
                    .current
                    .as_ref()
                    .is_some_and(|key| sql.contains(&format!("CONSTRAINT_NAME={}", literal(&key.name))))
            ))]]));
        }
        if sql.contains("SESSION_PRIVS") || sql.contains("ALL_TAB_PRIVS") {
            return Ok(rows(vec![vec![json!(0)]]));
        }
        if sql.contains(" WHERE NOT (") {
            return Ok(rows(vec![vec![json!(u64::from(fixture.violations && !sql.ends_with("AND 1=0")))]]));
        }
        if sql.starts_with("ALTER TABLE") {
            fixture.writes.push(sql.into());
            if fixture.fail_step == Some(fixture.writes.len()) {
                return Err("ORA-02293: cannot validate CHECK".into());
            }
            fixture.current = if sql.contains(" DROP CONSTRAINT ") { None } else { fixture.desired.clone() };
            fixture.stamp += 1;
            return Ok(rows(vec![]));
        }
        Err(format!("Unexpected query: {sql}"))
    }
}

#[test]
fn expression_boundary_preserves_strings_comments_q_literals_and_rejects_statement_escapes() {
    for expression in [
        "x > 0 AND y <> 'it''s; fine)'",
        "x <> q'[); DROP TABLE t;]'",
        "x > 0 /* ; ) */ AND y > 1",
        "x > 0 -- ; )\nAND y > 1",
        "\"odd;name\" > 0",
    ] {
        assert!(expression_boundary(expression).is_ok(), "{expression}");
    }
    for expression in [
        "x > 0); DROP TABLE t; --",
        "x > 0; SELECT 1",
        "x > 0) DISABLE --",
        "x > 0 /*",
        "x = 'unclosed",
        "x = q'[unclosed'",
        "(x>0",
        "",
    ] {
        assert!(expression_boundary(expression).is_err(), "{expression}");
    }
}

#[tokio::test]
async fn valid_names_use_server_encoding_and_preserve_identifier_quoting() {
    for (engine, name, name_bytes) in [
        (Engine::OceanBaseOracle, "X".repeat(128), 128),
        (Engine::OceanBaseOracle, "汉".repeat(42), 126),
        (Engine::Oracle, "é".repeat(128), 128),
        (Engine::Oracle, "Quoted \"Name\"".into(), 13),
    ] {
        let mut request = request();
        request.desired.as_mut().unwrap().name = name.clone();
        let session = session(engine, &request);
        session.fixture.lock().unwrap().name_bytes = name_bytes;
        let plan = preview_check(&session, &request).await.unwrap();
        assert_eq!(plan.statements.len(), 2);
        assert!(plan.statements[1].contains(&identifier(&name).unwrap()));
        let expected_probe = match engine {
            Engine::OceanBaseOracle => format!("SELECT LENGTHB({}) FROM DUAL", literal(&name)),
            Engine::Oracle => format!("SELECT 1 AS {} FROM DUAL", identifier(&name).unwrap()),
        };
        assert!(session.fixture.lock().unwrap().queries.contains(&expected_probe));
        assert!(apply_check(&session, &request, &plan.revision).await.unwrap().success);
    }
}

#[tokio::test]
async fn invalid_or_unverifiable_name_never_drops_original_on_preview_or_apply() {
    for (engine, unavailable) in [
        (Engine::Oracle, false),
        (Engine::OceanBaseOracle, false),
        (Engine::Oracle, true),
        (Engine::OceanBaseOracle, true),
    ] {
        let mut request = request();
        request.desired.as_mut().unwrap().name = "长".repeat(50);
        let session = session(engine, &request);
        let plan = preview_check(&session, &request).await.unwrap();
        {
            let mut fixture = session.fixture.lock().unwrap();
            fixture.name_bytes = 150;
            fixture.name_error = if unavailable {
                Some("name validation unavailable".into())
            } else if engine == Engine::Oracle {
                Some("ORA-00972: identifier is too long".into())
            } else {
                None
            };
        }
        assert!(preview_check(&session, &request).await.is_err());
        assert!(apply_check(&session, &request, &plan.revision).await.is_err());
        let fixture = session.fixture.lock().unwrap();
        assert!(fixture.writes.is_empty());
        assert_eq!(fixture.current, Some(key()));
    }
}

#[tokio::test]
async fn not_null_constraints_are_refused_without_blocking_ordinary_checks() {
    for engine in [Engine::Oracle, Engine::OceanBaseOracle] {
        let request = request();
        let session = session(engine, &request);
        session.fixture.lock().unwrap().nonnullable = true;
        assert!(preview_check(&session, &request).await.is_ok());
        session.fixture.lock().unwrap().current.as_mut().unwrap().expression = "(\"amount\" IS NOT NULL)".into();
        let error = preview_check(&session, &request).await.unwrap_err();
        assert!(error.contains("Edit column nullability instead"));
        let fixture = session.fixture.lock().unwrap();
        assert!(fixture.writes.is_empty());
        assert!(fixture.current.is_some());
    }
}

#[test]
fn canonical_readback_ignores_formatting_but_not_case_sensitive_identifiers_or_precedence() {
    assert!(canonical_expression("amount > 0").is_some());
    assert!(canonical_expression("x <> q'[a;);b]'").is_some());
    assert_eq!(canonical_expression("amount > 0"), canonical_expression("(\"AMOUNT\" > 0)"));
    assert_eq!(canonical_expression("x <> q'[a;);b]'"), canonical_expression("\"X\" <> 'a;);b'"));
    assert_ne!(canonical_expression("\"Mixed\">0"), canonical_expression("MIXED>0"));
    assert_ne!(canonical_expression("a=1 AND (b=2 OR c=3)"), canonical_expression("(a=1 AND b=2) OR c=3"));
    assert_eq!(canonical_expression("a=1 AND ((b=2 OR c=3))"), canonical_expression("A = 1 AND (B = 2 OR C = 3)"));
    assert_ne!(canonical_expression("a * (b + c) > 0"), canonical_expression("a * b + c > 0"));
}

#[tokio::test]
async fn readback_with_changed_operator_grouping_is_not_marked_successful() {
    for engine in [Engine::Oracle, Engine::OceanBaseOracle] {
        let mut request = request();
        request.desired.as_mut().unwrap().expression = "a=1 AND (b=2 OR c=3)".into();
        let session = session(engine, &request);
        let plan = preview_check(&session, &request).await.unwrap();
        session.fixture.lock().unwrap().desired.as_mut().unwrap().expression = "(a=1 AND b=2) OR c=3".into();
        let result = apply_check(&session, &request, &plan.revision).await.unwrap();
        assert!(result.steps.iter().all(|step| step.success));
        assert!(!result.success);
        assert!(result.refresh_error.as_ref().unwrap().contains("could not be confirmed"));
        assert_eq!(result.current_constraint.unwrap().expression, "(a=1 AND b=2) OR c=3");
    }
}

#[tokio::test]
async fn replacement_preserves_multiline_text_and_returns_actual_state_on_both_engines() {
    for engine in [Engine::Oracle, Engine::OceanBaseOracle] {
        let request = request();
        let session = session(engine, &request);
        let plan = preview_check(&session, &request).await.unwrap();
        assert_eq!(plan.statements.len(), 2);
        assert!(plan.statements[1].contains(&request.desired.as_ref().unwrap().expression));
        assert!(plan.recovery_statements[0].contains(&key().expression));
        assert!(session.fixture.lock().unwrap().writes.is_empty());
        let result = apply_check(&session, &request, &plan.revision).await.unwrap();
        assert!(result.success);
        assert_eq!(result.current_constraint, request.desired);
    }
}

#[tokio::test]
async fn unsafe_expression_violating_rows_and_missing_privilege_never_drop_original() {
    for reason in ["injection", "data", "privilege"] {
        let mut request = request();
        if reason == "injection" {
            request.desired.as_mut().unwrap().expression = "x>0); DROP TABLE t; --".into();
        }
        let session = session(Engine::Oracle, &request);
        {
            let mut fixture = session.fixture.lock().unwrap();
            fixture.violations = reason == "data";
            fixture.privilege = reason != "privilege";
        }
        assert!(preview_check(&session, &request).await.is_err());
        assert!(session.fixture.lock().unwrap().writes.is_empty());
    }
}

#[tokio::test]
async fn validation_uses_not_expression_without_turning_null_into_false() {
    let request = request();
    let session = session(Engine::Oracle, &request);
    preview_check(&session, &request).await.unwrap();
    let fixture = session.fixture.lock().unwrap();
    let query = fixture.queries.iter().find(|sql| sql.contains(" WHERE NOT (")).unwrap();
    assert!(query.contains(&request.desired.as_ref().unwrap().expression));
    assert!(!query.contains("NVL"));
    assert!(!query.contains("IS NULL"));
}

#[tokio::test]
async fn state_only_change_has_no_drop_and_novalidate_skips_historical_rows() {
    let mut request = request();
    let mut desired = key();
    desired.enabled = false;
    desired.validated = false;
    request.desired = Some(desired);
    let session = session(Engine::OceanBaseOracle, &request);
    session.fixture.lock().unwrap().violations = true;
    let plan = preview_check(&session, &request).await.unwrap();
    assert_eq!(plan.statements.len(), 1);
    assert!(plan.statements[0].contains("DISABLE NOVALIDATE CONSTRAINT"));
    assert!(apply_check(&session, &request, &plan.revision).await.unwrap().success);
}

#[tokio::test]
async fn partial_failure_restores_original_definition_and_readback_failure_is_not_success() {
    for unavailable in [false, true] {
        let request = request();
        let session = session(Engine::Oracle, &request);
        {
            let mut fixture = session.fixture.lock().unwrap();
            fixture.fail_step = if unavailable { None } else { Some(2) };
            fixture.readback_error = unavailable;
        }
        let plan = preview_check(&session, &request).await.unwrap();
        let result = apply_check(&session, &request, &plan.revision).await.unwrap();
        assert!(!result.success);
        if unavailable {
            assert!(result.refresh_error.is_some());
            assert!(result.recovery_statements.is_empty());
        } else {
            assert_eq!(result.recovery_statements, plan.recovery_statements);
            assert!(apply_check(&session, &request, &plan.revision).await.is_err());
        }
    }
}

#[tokio::test]
async fn add_drop_and_stale_preview_do_not_repeat_old_ddl() {
    let mut request = request();
    request.original_name = None;
    let session = session(Engine::Oracle, &request);
    session.fixture.lock().unwrap().current = None;
    let plan = preview_check(&session, &request).await.unwrap();
    assert_eq!(plan.statements.len(), 1);
    assert!(apply_check(&session, &request, &plan.revision).await.unwrap().success);
    assert!(apply_check(&session, &request, &plan.revision).await.is_err());
    let drop =
        CheckChange { original_name: Some(request.desired.as_ref().unwrap().name.clone()), desired: None, ..request };
    let plan = preview_check(&session, &drop).await.unwrap();
    assert_eq!(plan.statements.len(), 1);
    assert!(apply_check(&session, &drop, &plan.revision).await.unwrap().success);
}
