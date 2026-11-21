use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};

struct PackageCatalog {
    specification: Option<String>,
    body: Option<String>,
    invalid_body: bool,
    invalid_specification: bool,
    fail_body_source: bool,
    change_spec_on_body: bool,
    changed: AtomicBool,
}

impl Default for PackageCatalog {
    fn default() -> Self {
        Self {
            specification: Some(
                "CREATE OR REPLACE PACKAGE APP.\"Pkg.With.Dot\" AS g NUMBER := 1; END \"Pkg.With.Dot\";".into(),
            ),
            body: Some(
                "CREATE OR REPLACE PACKAGE BODY APP.\"Pkg.With.Dot\" AS BEGIN NULL; END \"Pkg.With.Dot\";".into(),
            ),
            invalid_body: false,
            invalid_specification: false,
            fail_body_source: false,
            change_spec_on_body: false,
            changed: AtomicBool::new(false),
        }
    }
}

fn reply(columns: &[&str], rows: Vec<Vec<Value>>) -> CatalogReply {
    serde_json::from_value(json!({"columns":columns,"rows":rows})).unwrap()
}

#[async_trait::async_trait]
impl RoutineCatalog for PackageCatalog {
    async fn source(&self, identity: &RoutineIdentity) -> Result<SourceReply, String> {
        let source = match identity.kind {
            db::ObjectSourceKind::Package => {
                let source = self.specification.as_ref().expect("absent specifications must not be fetched");
                if self.changed.load(Ordering::SeqCst) {
                    source.replace("g NUMBER := 1", "g NUMBER := 2")
                } else {
                    source.clone()
                }
            }
            db::ObjectSourceKind::PackageBody => {
                if self.fail_body_source {
                    return Err("ORA-01031: insufficient privileges".into());
                }
                if self.change_spec_on_body {
                    self.changed.store(true, Ordering::SeqCst);
                }
                self.body.as_ref().expect("absent bodies must not be fetched").clone()
            }
            _ => panic!("package readback must preserve exact kinds"),
        };
        Ok(serde_json::from_value(json!({"name":identity.name,"schema":identity.owner,"object_type":identity.kind,"source":source,"source_origin":"oceanbase-dictionary"})).unwrap())
    }

    async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
        assert!(sql.starts_with("SELECT "), "readback may only observe dictionary state");
        if sql.contains("LOGIN_OWNER") {
            return Ok(reply(&["LOGIN_OWNER"], vec![vec![json!("APP")]]));
        }
        let body = sql.contains("TYPE = 'PACKAGE BODY'");
        if sql.contains("SOURCE_ROWS") {
            let source = if body { self.body.as_ref() } else { self.specification.as_ref() }.unwrap();
            return Ok(reply(
                &["SOURCE_ROWS", "FIRST_LINE", "LAST_LINE", "SOURCE_CHARS", "HEAD_TRIM", "TAIL_TRIM", "SOURCE_HEAD"],
                vec![vec![
                    json!(1),
                    json!(1),
                    json!(1),
                    json!(source.chars().count()),
                    json!(0),
                    json!(0),
                    json!("CREATE PACKAGE"),
                ]],
            ));
        }
        if sql.contains("ALL_ERRORS") {
            return Ok(reply(
                &["SEQUENCE", "ATTRIBUTE", "LINE", "POSITION", "TEXT"],
                if body && self.invalid_body {
                    vec![vec![
                        json!(0),
                        json!("ERROR"),
                        json!(1),
                        json!(0),
                        json!(if self.specification.is_none() {
                            "PLS-00304: specification does not exist"
                        } else {
                            "PLS-00323: member does not match specification"
                        }),
                    ]]
                } else {
                    Vec::new()
                },
            ));
        }
        if sql.contains("OBJECTS") {
            let mut rows = Vec::new();
            if self.specification.is_some() {
                rows.push(vec![
                    json!("APP"),
                    json!("Pkg.With.Dot"),
                    json!("PACKAGE"),
                    json!(11),
                    json!(if self.invalid_specification { "INVALID" } else { "VALID" }),
                    json!("2026-10-23T01:00:00"),
                ]);
            }
            if self.body.is_some() {
                rows.push(vec![
                    json!("APP"),
                    json!("Pkg.With.Dot"),
                    json!("PACKAGE BODY"),
                    json!(12),
                    json!(if self.invalid_body { "INVALID" } else { "VALID" }),
                    json!("2026-10-23T01:00:00"),
                ]);
            }
            return Ok(reply(&["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "STATUS", "LAST_DDL_TIME"], rows));
        }
        panic!("Unexpected package observation: {sql}")
    }
}

async fn run(catalog: &PackageCatalog, kind: db::ObjectSourceKind, goal: RoutineReadbackGoal) -> RoutineReadback {
    readback(
        catalog,
        &RoutineEndpoint {
            connection_id: "target".into(),
            database: "tenant".into(),
            schema: "APP".into(),
            database_type: DatabaseType::OceanbaseOracle,
            generation: 1,
        },
        RoutineIdentity { owner: "APP".into(), name: "Pkg.With.Dot".into(), kind },
        &goal,
        SourceOrigin::OceanBaseDictionary,
    )
    .await
}

#[tokio::test]
async fn a_verified_specification_keeps_the_actual_invalid_body_and_its_errors() {
    let catalog = PackageCatalog { invalid_body: true, ..Default::default() };
    let result = run(
        &catalog,
        db::ObjectSourceKind::Package,
        RoutineReadbackGoal::Definition { sql: catalog.specification.clone().unwrap() },
    )
    .await;
    assert_eq!(result.state, RoutineReadbackState::Verified);
    let wire = serde_json::to_value(&result).unwrap();
    assert_eq!(wire["sourceOrigin"], "oceanbase-dictionary");
    assert_eq!(wire["packageCompanion"]["identity"]["kind"], "PACKAGE_BODY");
    assert_eq!(wire["packageCompanion"]["state"], "invalid");
    assert_eq!(wire["packageCompanion"]["source"], catalog.body.unwrap());
    assert_eq!(wire["packageCompanion"]["compilerMessages"][0]["position"], 0);
}

#[tokio::test]
async fn a_body_definition_is_not_verified_against_an_invalid_specification() {
    let catalog = PackageCatalog { invalid_specification: true, ..Default::default() };
    let result = run(
        &catalog,
        db::ObjectSourceKind::PackageBody,
        RoutineReadbackGoal::Definition { sql: catalog.body.clone().unwrap() },
    )
    .await;
    assert_eq!(result.exists, Some(true));
    assert_eq!(result.state, RoutineReadbackState::DefinitionMismatch);
    assert_eq!(result.package_companion.as_ref().unwrap().state, RoutineReadbackState::Invalid);
}

#[tokio::test]
async fn whole_package_absence_requires_both_kinds_to_be_absent() {
    let orphan = PackageCatalog { specification: None, invalid_body: true, ..Default::default() };
    let result = run(&orphan, db::ObjectSourceKind::Package, RoutineReadbackGoal::Absent).await;
    assert_ne!(result.state, RoutineReadbackState::Verified);
    assert_eq!(result.exists, Some(false));
    let wire = serde_json::to_value(&result).unwrap();
    assert_eq!(wire["packageCompanion"]["exists"], true);
    assert_eq!(wire["packageCompanion"]["source"], orphan.body.unwrap());
    let empty = PackageCatalog { specification: None, body: None, ..Default::default() };
    let result = run(&empty, db::ObjectSourceKind::Package, RoutineReadbackGoal::Absent).await;
    assert_eq!(result.state, RoutineReadbackState::Verified);
    assert_eq!(serde_json::to_value(&result).unwrap()["packageCompanion"]["exists"], false);
}

#[tokio::test]
async fn dropping_only_the_body_retains_complete_specification_evidence() {
    let catalog = PackageCatalog { body: None, ..Default::default() };
    let result = run(&catalog, db::ObjectSourceKind::PackageBody, RoutineReadbackGoal::Absent).await;
    assert_eq!(result.state, RoutineReadbackState::Verified);
    let wire = serde_json::to_value(&result).unwrap();
    assert_eq!(wire["packageCompanion"]["identity"]["kind"], "PACKAGE");
    assert_eq!(wire["packageCompanion"]["source"], catalog.specification.unwrap());
}

#[tokio::test]
async fn an_orphan_invalid_body_remains_present_with_its_actual_missing_specification() {
    let catalog = PackageCatalog { specification: None, invalid_body: true, ..Default::default() };
    let result = run(
        &catalog,
        db::ObjectSourceKind::PackageBody,
        RoutineReadbackGoal::Definition { sql: catalog.body.clone().unwrap() },
    )
    .await;
    assert_eq!(result.state, RoutineReadbackState::Invalid);
    assert_eq!(result.exists, Some(true));
    assert_eq!(result.source, catalog.body);
    assert_eq!(result.package_companion.as_ref().unwrap().exists, Some(false));
}

#[tokio::test]
async fn same_second_spec_mutation_while_reading_body_cannot_be_a_verified_pair() {
    let catalog = PackageCatalog { change_spec_on_body: true, ..Default::default() };
    let result = run(
        &catalog,
        db::ObjectSourceKind::Package,
        RoutineReadbackGoal::Definition { sql: catalog.specification.clone().unwrap() },
    )
    .await;
    assert_eq!(result.state, RoutineReadbackState::ReadbackFailed);
    assert!(!result.issues.is_empty());
    assert_eq!(result.source, catalog.specification);
}

#[tokio::test]
async fn companion_read_failure_retains_the_selected_definition_without_reporting_verified() {
    let catalog = PackageCatalog { fail_body_source: true, ..Default::default() };
    let result = run(
        &catalog,
        db::ObjectSourceKind::Package,
        RoutineReadbackGoal::Definition { sql: catalog.specification.clone().unwrap() },
    )
    .await;
    assert_eq!(result.state, RoutineReadbackState::ReadbackFailed);
    assert_eq!(result.source, catalog.specification);
    let wire = serde_json::to_value(&result).unwrap();
    assert_eq!(wire["packageCompanion"]["exists"], true);
    assert_eq!(wire["packageCompanion"]["state"], "readback-failed");
}
