use super::super::plan;
use super::*;
use serde_json::json;
use std::sync::Mutex;

#[derive(Clone)]
struct Program {
    source: String,
    id: u64,
    time: u64,
    invalid: bool,
}
struct PackageIo {
    owner: &'static str,
    database_type: DatabaseType,
    programs: Mutex<BTreeMap<String, Program>>,
    writes: Mutex<Vec<String>>,
    invalidate_old_body: bool,
    fail_body: Mutex<bool>,
    unknown_body: bool,
    change_spec_during_body: bool,
    grants: Mutex<Vec<plan::PackageGrant>>,
    forbid_global_incoming: bool,
}

impl PackageIo {
    fn new(owner: &'static str, present: bool) -> Self {
        let mut programs = BTreeMap::new();
        if present {
            programs.insert("PACKAGE".into(),Program {source:format!("CREATE OR REPLACE PACKAGE \"{owner}\".PKG AS g NUMBER := 1; FUNCTION f(p NUMBER) RETURN NUMBER; END PKG;"),id:11,time:1,invalid:false});
            programs.insert("PACKAGE BODY".into(),Program {source:format!("CREATE OR REPLACE PACKAGE BODY \"{owner}\".PKG AS FUNCTION f(p NUMBER) RETURN NUMBER IS BEGIN RETURN p + g; END f; END PKG;"),id:12,time:1,invalid:false});
        }
        Self {
            owner,
            database_type: DatabaseType::OceanbaseOracle,
            programs: Mutex::new(programs),
            writes: Mutex::new(Vec::new()),
            invalidate_old_body: false,
            fail_body: Mutex::new(false),
            unknown_body: false,
            change_spec_during_body: false,
            grants: Mutex::new(Vec::new()),
            forbid_global_incoming: false,
        }
    }

    fn endpoint(&self) -> RoutineEndpoint {
        RoutineEndpoint {
            connection_id: self.owner.into(),
            database: "tenant".into(),
            schema: self.owner.into(),
            database_type: self.database_type,
            generation: 1,
        }
    }
    fn config(&self) -> ConnectionConfig {
        let mut config: ConnectionConfig = serde_json::from_value(json!({"id":self.owner,"name":"fixture","db_type":"oceanbase-oracle","host":"localhost","port":2881,"username":self.owner,"password":"","database":null})).unwrap();
        config.db_type = self.database_type;
        config
    }
    fn origin(&self) -> SourceOrigin {
        if self.database_type == DatabaseType::Oracle {
            SourceOrigin::OracleDictionary
        } else {
            SourceOrigin::OceanBaseDictionary
        }
    }
    fn snapshot(&self) -> RoutineSnapshot {
        RoutineSnapshot {
            endpoint: self.endpoint(),
            state: RoutineReadState::Complete,
            enumeration_complete: true,
            issues: Vec::new(),
            objects: self
                .programs
                .lock()
                .unwrap()
                .iter()
                .map(|(kind, program)| RoutineObjectSnapshot {
                    version: RoutineVersion {
                        identity: RoutineIdentity {
                            owner: self.owner.into(),
                            name: "PKG".into(),
                            kind: if kind == "PACKAGE" {
                                db::ObjectSourceKind::Package
                            } else {
                                db::ObjectSourceKind::PackageBody
                            },
                        },
                        object_id: program.id.to_string(),
                        status: if program.invalid { "INVALID" } else { "VALID" }.into(),
                        last_ddl_time: program.time.to_string(),
                    },
                    source: Some(program.source.clone()),
                    source_origin: Some(self.origin()),
                    source_complete: true,
                    dependencies: Vec::new(),
                    dependencies_complete: true,
                    issues: Vec::new(),
                })
                .collect(),
        }
    }
}

fn reply(columns: &[&str], rows: Vec<Vec<Value>>) -> CatalogReply {
    serde_json::from_value(json!({"columns":columns,"rows":rows})).unwrap()
}

#[async_trait::async_trait]
impl RoutineCatalog for PackageIo {
    async fn source(&self, identity: &RoutineIdentity) -> Result<SourceReply, String> {
        assert_eq!(identity.owner, self.owner);
        assert_eq!(identity.name, "PKG");
        let programs = self.programs.lock().unwrap();
        let program = programs.get(kind_name(&identity.kind)).ok_or("Source not found")?;
        Ok(serde_json::from_value(json!({"name":identity.name,"schema":identity.owner,"object_type":identity.kind,"source":program.source,"source_origin":self.origin()})).unwrap())
    }
    async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
        assert!(sql.starts_with("SELECT "));
        if sql.contains("LOGIN_OWNER") {
            return Ok(reply(&["LOGIN_OWNER"], vec![vec![json!(self.owner)]]));
        }
        let programs = self.programs.lock().unwrap();
        if sql.contains("OBJECTS") {
            return Ok(reply(
                &["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "STATUS", "LAST_DDL_TIME"],
                programs
                    .iter()
                    .map(|(kind, program)| {
                        vec![
                            json!(self.owner),
                            json!("PKG"),
                            json!(kind),
                            json!(program.id),
                            json!(if program.invalid { "INVALID" } else { "VALID" }),
                            json!(program.time.to_string()),
                        ]
                    })
                    .collect(),
            ));
        }
        let kind = if sql.contains("TYPE = 'PACKAGE BODY'") { "PACKAGE BODY" } else { "PACKAGE" };
        if sql.contains("SOURCE_ROWS") {
            let source = &programs.get(kind).unwrap().source;
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
                if programs.get(kind).is_some_and(|program| program.invalid) {
                    vec![vec![
                        json!(0),
                        json!("ERROR"),
                        json!(1),
                        json!(0),
                        json!("PLS-00382: simulated compiler boundary failure"),
                    ]]
                } else {
                    Vec::new()
                },
            ));
        }
        if sql.contains("DBA_DEPENDENCIES") {
            assert!(!self.forbid_global_incoming, "Ordinary package saving must not require global caller visibility");
            return Ok(reply(&["OWNER", "NAME", "TYPE", "REFERENCED_LINK_NAME", "DEPENDENCY_TYPE", "RN"], Vec::new()));
        }
        if sql.contains("ALL_DEPENDENCIES") {
            return Ok(reply(
                &[
                    "REFERENCED_OWNER",
                    "REFERENCED_NAME",
                    "REFERENCED_TYPE",
                    "REFERENCED_LINK_NAME",
                    "DEPENDENCY_TYPE",
                    "RN",
                ],
                Vec::new(),
            ));
        }
        if sql.contains("ALL_TAB_PRIVS") {
            return Ok(reply(
                &["GRANTOR", "GRANTEE", "PRIVILEGE", "GRANTABLE", "RN"],
                self.grants
                    .lock()
                    .unwrap()
                    .iter()
                    .enumerate()
                    .map(|(index, grant)| {
                        vec![
                            json!(grant.grantor),
                            json!(grant.grantee),
                            json!(grant.privilege),
                            json!(if grant.grantable { "YES" } else { "NO" }),
                            json!(index + 1),
                        ]
                    })
                    .collect(),
            ));
        }
        panic!("Unexpected package query: {sql}")
    }
}

#[async_trait::async_trait]
impl RoutineWriteIo for PackageIo {
    async fn check_write(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn write(&self, sql: &str) -> Result<db::QueryResult, QueryExecutionError> {
        self.writes.lock().unwrap().push(sql.into());
        let body = sql.contains("PACKAGE BODY");
        let kind = if body { "PACKAGE BODY" } else { "PACKAGE" };
        let mut programs = self.programs.lock().unwrap();
        if sql.starts_with("DROP ") {
            programs.remove(kind);
            if !body {
                programs.remove("PACKAGE BODY");
                self.grants.lock().unwrap().clear();
            }
        } else {
            let previous = programs.get(kind).cloned();
            programs.insert(
                kind.into(),
                Program {
                    source: sql.into(),
                    id: previous.as_ref().map_or(if body { 12 } else { 11 }, |program| program.id),
                    time: previous.map_or(1, |program| program.time + 1),
                    invalid: body && *self.fail_body.lock().unwrap(),
                },
            );
            if !body && self.invalidate_old_body {
                if let Some(body) = programs.get_mut("PACKAGE BODY") {
                    body.invalid = true;
                    body.time += 1;
                }
            }
            if body && self.change_spec_during_body {
                if let Some(spec) = programs.get_mut("PACKAGE") {
                    spec.source = spec.source.replace("g NUMBER := 1", "g NUMBER := 9");
                    spec.time += 1;
                }
            }
        }
        if body && self.unknown_body {
            return Err(QueryExecutionError::Agent(AgentCallError::Transport {
                message: "package response lost after dispatch".into(),
            }));
        }
        Ok(serde_json::from_value(json!({"columns":[],"rows":[],"affected_rows":0,"execution_time_ms":1})).unwrap())
    }
}

fn drafts(action: RoutinePlanAction) -> Vec<RoutinePlanDraft> {
    [db::ObjectSourceKind::Package, db::ObjectSourceKind::PackageBody]
        .into_iter()
        .map(|kind| RoutinePlanDraft {
            identity: RoutineIdentity { owner: "OWNER".into(), name: "PKG".into(), kind },
            action,
            source_name: None,
            sql: None,
            baseline_operation_id: None,
            supersedes_operation_id: None,
            package_body_source: None,
            package_contract: None,
            confirm_package_pair: true,
        })
        .collect()
}

async fn prepare(
    registry: &RoutineOperationRegistry,
    source: &PackageIo,
    target: &PackageIo,
    input: OracleRoutinePlanInput,
) -> OracleRoutinePlan {
    plan::prepare_with_catalogs(registry, source, target, input, &source.config(), &target.config()).await.unwrap()
}
async fn execute(
    registry: &RoutineOperationRegistry,
    source: &PackageIo,
    target: &PackageIo,
    step: &OracleRoutinePlanStep,
) -> RoutineOperationRecord {
    execute_approval(registry, Some(source), target, step.operation.as_ref().unwrap(), &step.sql).await
}

async fn execute_approval(
    registry: &RoutineOperationRegistry,
    source: Option<&PackageIo>,
    target: &PackageIo,
    approval: &RoutineOperationRecord,
    sql: &str,
) -> RoutineOperationRecord {
    let id = &approval.operation_id;
    match registry.begin(id, sql).unwrap() {
        BeginRoutineOperation::Dispatch(binding) => {
            run_write(registry, id, &binding, target, source, target.origin()).await
        }
        BeginRoutineOperation::Existing(_) => {}
    }
    registry.observe(id).operation.unwrap()
}

async fn save_approval(
    registry: &RoutineOperationRegistry,
    target: &PackageIo,
    kind: db::ObjectSourceKind,
    sql: &str,
    require_absent: bool,
) -> Result<RoutineOperationRecord, String> {
    prepare_package_definition(
        registry,
        target,
        OracleRoutineSaveInput {
            connection_id: target.owner.into(),
            database: "tenant".into(),
            identity: RoutineIdentity { owner: target.owner.into(), name: "PKG".into(), kind },
            sql: sql.into(),
            require_absent,
            prerequisite_operation_id: None,
            supersedes_operation_id: None,
        },
        &target.endpoint(),
        &target.config(),
        require_absent,
    )
    .await
}

#[tokio::test]
async fn ordinary_package_save_uses_pair_freeze_without_static_comparison_or_global_caller_requirements() {
    let mut target = PackageIo::new("OWNER", true);
    target.forbid_global_incoming = true;
    let registry = RoutineOperationRegistry::default();
    let sql = "CREATE OR REPLACE PACKAGE BODY \"OWNER\".PKG AS FUNCTION f(p NUMBER) RETURN NUMBER IS BEGIN EXECUTE IMMEDIATE 'SELECT 1 FROM DUAL'; RETURN p; END f; END PKG;";
    let approval = save_approval(&registry, &target, db::ObjectSourceKind::PackageBody, sql, false).await.unwrap();
    let result = execute_approval(&registry, None, &target, &approval, sql).await;
    assert!(result.verified(), "{}", result.failure_message());
    assert!(result.readback.unwrap().package_companion.unwrap().source.unwrap().contains("g NUMBER := 1"));
    assert_eq!(target.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn ordinary_specification_save_reports_old_body_invalidation_and_body_save_keeps_actual_invalid_spec_result() {
    let mut target = PackageIo::new("OWNER", true);
    target.forbid_global_incoming = true;
    target.invalidate_old_body = true;
    let registry = RoutineOperationRegistry::default();
    let spec = target.programs.lock().unwrap()["PACKAGE"].source.replace("g NUMBER := 1", "g NUMBER := 2");
    let approval = save_approval(&registry, &target, db::ObjectSourceKind::Package, &spec, false).await.unwrap();
    let result = execute_approval(&registry, None, &target, &approval, &spec).await;
    assert!(result.verified());
    assert_eq!(result.readback.unwrap().package_companion.unwrap().state, RoutineReadbackState::Invalid);
    target.programs.lock().unwrap().get_mut("PACKAGE").unwrap().invalid = true;
    let body = target.programs.lock().unwrap()["PACKAGE BODY"].source.clone();
    let approval = save_approval(&registry, &target, db::ObjectSourceKind::PackageBody, &body, false).await.unwrap();
    let result = execute_approval(&registry, None, &target, &approval, &body).await;
    assert!(result.dispatched && result.acknowledged);
    assert!(!result.verified());
    assert_eq!(result.readback.unwrap().package_companion.unwrap().state, RoutineReadbackState::Invalid);
    assert_eq!(target.writes.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn ordinary_save_detects_companion_change_and_save_as_absence_does_not_overwrite_existing_or_orphan_pair() {
    let target = PackageIo::new("OWNER", true);
    let registry = RoutineOperationRegistry::default();
    let body = target.programs.lock().unwrap()["PACKAGE BODY"].source.clone();
    let approval = save_approval(&registry, &target, db::ObjectSourceKind::PackageBody, &body, false).await.unwrap();
    target.programs.lock().unwrap().get_mut("PACKAGE").unwrap().source.push_str(" -- third party");
    let result = execute_approval(&registry, None, &target, &approval, &body).await;
    assert!(!result.dispatched);
    let spec = "CREATE PACKAGE \"OWNER\".PKG AS g NUMBER := 1; END PKG;";
    assert!(save_approval(&registry, &target, db::ObjectSourceKind::Package, spec, true).await.is_err());
    target.programs.lock().unwrap().remove("PACKAGE");
    assert!(save_approval(&registry, &target, db::ObjectSourceKind::Package, spec, true).await.is_err());
    assert!(target.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn ordinary_package_creation_freezes_empty_pair_and_supports_legacy_save_request_shape() {
    let mut target = PackageIo::new("OWNER", false);
    target.forbid_global_incoming = true;
    let registry = RoutineOperationRegistry::default();
    let sql = "CREATE PACKAGE \"OWNER\".PKG AS g NUMBER := 1; END PKG;";
    let input: OracleRoutineSaveInput = serde_json::from_value(json!({"connectionId":"OWNER","database":"tenant","identity":{"owner":"OWNER","name":"PKG","kind":"PACKAGE"},"sql":sql})).unwrap();
    assert!(!input.require_absent);
    let approval = save_approval(&registry, &target, db::ObjectSourceKind::Package, sql, true).await.unwrap();
    assert!(execute_approval(&registry, None, &target, &approval, sql).await.verified());
    assert_eq!(target.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn save_as_body_binds_the_original_verified_specification_not_a_changed_spec_captured_during_preparation() {
    for change in [false, true] {
        let target = PackageIo::new("OWNER", false);
        let registry = RoutineOperationRegistry::default();
        let spec_sql = "CREATE PACKAGE \"OWNER\".PKG AS g NUMBER := 1; FUNCTION f(p NUMBER) RETURN NUMBER; END PKG;";
        let specification =
            save_approval(&registry, &target, db::ObjectSourceKind::Package, spec_sql, true).await.unwrap();
        let specification = execute_approval(&registry, None, &target, &specification, spec_sql).await;
        assert!(specification.verified());
        if change {
            let mut programs = target.programs.lock().unwrap();
            let source = programs["PACKAGE"].source.replace("g NUMBER := 1", "g NUMBER := 9");
            programs.get_mut("PACKAGE").unwrap().source = source;
        }
        let body_sql = "CREATE PACKAGE BODY \"OWNER\".PKG AS FUNCTION f(p NUMBER) RETURN NUMBER IS BEGIN RETURN p + g; END f; END PKG;";
        let body = prepare_package_definition(
            &registry,
            &target,
            OracleRoutineSaveInput {
                connection_id: target.owner.into(),
                database: "tenant".into(),
                identity: RoutineIdentity {
                    owner: "OWNER".into(),
                    name: "PKG".into(),
                    kind: db::ObjectSourceKind::PackageBody,
                },
                sql: body_sql.into(),
                require_absent: true,
                prerequisite_operation_id: Some(specification.operation_id.clone()),
                supersedes_operation_id: None,
            },
            &target.endpoint(),
            &target.config(),
            true,
        )
        .await
        .unwrap();
        let result = execute_approval(&registry, None, &target, &body, body_sql).await;
        assert_eq!(result.dispatched, !change, "{}", result.failure_message());
        assert_eq!(result.verified(), !change);
        assert_eq!(target.writes.lock().unwrap().len(), if change { 1 } else { 2 });
    }
}

#[tokio::test]
async fn a_new_pair_dispatches_each_approved_statement_once_without_replaying_specification() {
    let source = PackageIo::new("SOURCE", true);
    let target = PackageIo::new("OWNER", false);
    let registry = RoutineOperationRegistry::default();
    let plan = prepare(
        &registry,
        &source,
        &target,
        OracleRoutinePlanInput {
            compact_sql: false,
            source: source.snapshot(),
            target: target.snapshot(),
            drafts: drafts(RoutinePlanAction::Create),
        },
    )
    .await;
    assert!(plan.ready, "{:?}", plan.steps);
    assert!(execute(&registry, &source, &target, &plan.steps[0]).await.verified());
    assert!(execute(&registry, &source, &target, &plan.steps[1]).await.verified());
    assert!(execute(&registry, &source, &target, &plan.steps[0]).await.verified());
    assert_eq!(target.writes.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn cross_product_packages_require_final_target_drafts_and_keep_full_validation_in_both_directions() {
    for (source_type, target_type) in
        [(DatabaseType::Oracle, DatabaseType::OceanbaseOracle), (DatabaseType::OceanbaseOracle, DatabaseType::Oracle)]
    {
        let mut source = PackageIo::new("SOURCE", true);
        source.database_type = source_type;
        let mut target = PackageIo::new("OWNER", false);
        target.database_type = target_type;
        let registry = RoutineOperationRegistry::default();
        let initial = prepare(
            &registry,
            &source,
            &target,
            OracleRoutinePlanInput {
                compact_sql: false,
                source: source.snapshot(),
                target: target.snapshot(),
                drafts: drafts(RoutinePlanAction::Create),
            },
        )
        .await;
        assert!(!initial.ready);
        assert!(initial.steps.iter().all(|step| step.operation.is_none()
            && step.source_original.is_some()
            && step.issues.iter().any(|issue| issue.message.contains("explicitly reviewed target draft"))));
        assert!(target.writes.lock().unwrap().is_empty());
        let mut invalid = drafts(RoutinePlanAction::Create);
        for (draft, step) in invalid.iter_mut().zip(&initial.steps) {
            draft.sql = Some(step.sql.clone());
        }
        invalid[1].sql.as_mut().unwrap().push_str(" BEGIN NULL; END;");
        let rejected = prepare(
            &registry,
            &source,
            &target,
            OracleRoutinePlanInput {
                compact_sql: false,
                source: source.snapshot(),
                target: target.snapshot(),
                drafts: invalid,
            },
        )
        .await;
        assert!(!rejected.ready);
        assert!(rejected.steps.iter().all(|step| step.operation.is_none()));
        let mut reviewed = drafts(RoutinePlanAction::Create);
        for (draft, step) in reviewed.iter_mut().zip(&initial.steps) {
            draft.sql = Some(step.sql.clone());
        }
        let approved = prepare(
            &registry,
            &source,
            &target,
            OracleRoutinePlanInput {
                compact_sql: false,
                source: source.snapshot(),
                target: target.snapshot(),
                drafts: reviewed,
            },
        )
        .await;
        assert!(approved.ready, "{:?}", approved.steps);
        for step in &approved.steps {
            let result = execute(&registry, &source, &target, step).await;
            assert!(result.verified(), "{}", result.failure_message());
        }
        assert_eq!(target.writes.lock().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn cross_product_package_attributes_remain_copyable_and_do_not_become_silent_semantic_conversions() {
    for clause in ["AUTHID CURRENT_USER", "ACCESSIBLE BY (PROCEDURE CALLER)", "SHARING = METADATA", "EDITIONABLE"] {
        let mut source = PackageIo::new("SOURCE", true);
        source.database_type = DatabaseType::Oracle;
        let original = {
            let mut programs = source.programs.lock().unwrap();
            let spec = programs.get_mut("PACKAGE").unwrap();
            spec.source = if clause == "EDITIONABLE" {
                spec.source.replace("REPLACE PACKAGE", "REPLACE EDITIONABLE PACKAGE")
            } else {
                spec.source.replace(" AS ", &format!(" {clause} AS "))
            };
            spec.source.clone()
        };
        let target = PackageIo::new("OWNER", false);
        let registry = RoutineOperationRegistry::default();
        let result = prepare(
            &registry,
            &source,
            &target,
            OracleRoutinePlanInput {
                compact_sql: false,
                source: source.snapshot(),
                target: target.snapshot(),
                drafts: drafts(RoutinePlanAction::Create),
            },
        )
        .await;
        assert!(!result.ready);
        assert!(result.steps.iter().all(|step| step.operation.is_none()));
        let spec = result.steps.iter().find(|step| step.identity.kind == db::ObjectSourceKind::Package).unwrap();
        assert_eq!(spec.source_original.as_deref(), Some(original.as_str()));
        assert!(spec.sql.contains(clause), "The editable target draft lost {clause}: {}", spec.sql);
        assert!(!spec.issues.is_empty());
        let mut reviewed = drafts(RoutinePlanAction::Create);
        for (draft, step) in reviewed.iter_mut().zip(&result.steps) {
            draft.sql = Some(step.sql.clone());
        }
        let manual = prepare(
            &registry,
            &source,
            &target,
            OracleRoutinePlanInput {
                compact_sql: false,
                source: source.snapshot(),
                target: target.snapshot(),
                drafts: reviewed,
            },
        )
        .await;
        assert!(!manual.ready, "Manual review does not establish unknown {clause} capabilities");
        assert!(manual.steps.iter().all(|step| step.operation.is_none()));
        assert!(target.writes.lock().unwrap().is_empty());
    }
}

async fn recovery(
    registry: &RoutineOperationRegistry,
    target: &PackageIo,
    id: &str,
) -> Result<OracleRoutinePlan, String> {
    plan::prepare_package_recovery(registry, id, target, &target.config(), SourceOrigin::OceanBaseDictionary).await
}

#[tokio::test]
async fn recovery_of_a_repaired_orphan_retains_its_original_body_without_approving_a_destructive_drop() {
    let source = PackageIo::new("SOURCE", true);
    let target = PackageIo::new("OWNER", true);
    let original_body = {
        let mut programs = target.programs.lock().unwrap();
        programs.remove("PACKAGE");
        let body = programs.get_mut("PACKAGE BODY").unwrap();
        body.invalid = true;
        body.source = body.source.replace("p + g", "p + g + 55");
        body.source.clone()
    };
    let registry = RoutineOperationRegistry::default();
    let mut selected = drafts(RoutinePlanAction::Create);
    selected[1].action = RoutinePlanAction::Replace;
    let plan = prepare(
        &registry,
        &source,
        &target,
        OracleRoutinePlanInput {
            compact_sql: false,
            source: source.snapshot(),
            target: target.snapshot(),
            drafts: selected,
        },
    )
    .await;
    assert!(plan.ready, "{:?}", plan.steps);
    let specification = execute(&registry, &source, &target, &plan.steps[0]).await;
    assert!(specification.verified(), "{}", specification.failure_message());
    assert!(execute(&registry, &source, &target, &plan.steps[1]).await.verified());
    let restored = recovery(&registry, &target, &specification.operation_id).await.unwrap();
    assert!(!restored.ready, "Orphan recovery must not approve dropping its backed-up body");
    assert!(restored.steps.iter().all(|step| step.operation.is_none() && !step.recovery_complete));
    let body = restored.steps.iter().find(|step| step.identity.kind == db::ObjectSourceKind::PackageBody).unwrap();
    assert_eq!(body.source_original.as_deref(), Some(original_body.as_str()));
    assert!(body.sql.contains("p + g + 55"));
    assert_eq!(target.writes.lock().unwrap().len(), 2);
}

fn grant() -> plan::PackageGrant {
    plan::PackageGrant {
        grantor: "OWNER".into(),
        grantee: "READER".into(),
        privilege: "EXECUTE".into(),
        grantable: false,
    }
}

#[tokio::test]
async fn new_pair_recovery_uses_known_body_receipt_and_dispatches_only_one_package_drop() {
    for fail in [false, true] {
        let source = PackageIo::new("SOURCE", true);
        let target = PackageIo::new("OWNER", false);
        *target.fail_body.lock().unwrap() = fail;
        let registry = RoutineOperationRegistry::default();
        let plan = prepare(
            &registry,
            &source,
            &target,
            OracleRoutinePlanInput {
                compact_sql: false,
                source: source.snapshot(),
                target: target.snapshot(),
                drafts: drafts(RoutinePlanAction::Create),
            },
        )
        .await;
        let spec = execute(&registry, &source, &target, &plan.steps[0]).await;
        execute(&registry, &source, &target, &plan.steps[1]).await;
        let undo = recovery(&registry, &target, &spec.operation_id).await.unwrap();
        assert!(undo.ready, "{:?}", undo.steps);
        assert_eq!(undo.steps.len(), 1);
        assert_eq!(undo.steps[0].identity.kind, db::ObjectSourceKind::Package);
        assert_eq!(undo.steps[0].action, RoutinePlanAction::Delete);
        assert!(execute(&registry, &source, &target, &undo.steps[0]).await.verified());
        assert!(target.programs.lock().unwrap().is_empty());
        assert_eq!(target.writes.lock().unwrap().len(), 3);
    }
}

#[tokio::test]
async fn replacement_recovery_reuses_pair_contract_and_restores_both_old_definitions_without_copying_grants() {
    let source = PackageIo::new("SOURCE", true);
    {
        let mut programs = source.programs.lock().unwrap();
        programs.get_mut("PACKAGE").unwrap().source =
            programs["PACKAGE"].source.replace("g NUMBER := 1", "g NUMBER := 2");
        programs.get_mut("PACKAGE BODY").unwrap().source =
            programs["PACKAGE BODY"].source.replace("p + g", "p + g + 2");
    }
    let target = PackageIo::new("OWNER", true);
    target.grants.lock().unwrap().push(grant());
    let before = target.snapshot();
    let registry = RoutineOperationRegistry::default();
    let plan = prepare(
        &registry,
        &source,
        &target,
        OracleRoutinePlanInput {
            compact_sql: false,
            source: source.snapshot(),
            target: before.clone(),
            drafts: drafts(RoutinePlanAction::Replace),
        },
    )
    .await;
    let spec = execute(&registry, &source, &target, &plan.steps[0]).await;
    assert!(spec.verified());
    assert!(execute(&registry, &source, &target, &plan.steps[1]).await.verified());
    let undo = recovery(&registry, &target, &spec.operation_id).await.unwrap();
    assert!(undo.ready, "{:?}", undo.steps);
    assert_eq!(undo.steps.len(), 2);
    assert_eq!(undo.steps[0].identity.kind, db::ObjectSourceKind::Package);
    for step in &undo.steps {
        assert!(execute(&registry, &source, &target, step).await.verified());
    }
    let after = target.snapshot();
    for old in before.objects {
        let current = after.objects.iter().find(|object| object.version.identity == old.version.identity).unwrap();
        let comparable = |object: &RoutineObjectSnapshot| {
            dbx_sql::object_source_sql::comparable_oracle_routine_definition(
                dbx_sql::object_source_sql::OracleRoutineDefinitionInput {
                    database_type: DatabaseType::OceanbaseOracle,
                    object_type: object.version.identity.kind.clone(),
                    source_owner: "OWNER".into(),
                    target_owner: "OWNER".into(),
                    name: "PKG".into(),
                    source: object.source.clone().unwrap(),
                    replace: true,
                },
            )
            .unwrap()
        };
        assert_eq!(comparable(current), comparable(&old));
    }
    assert_eq!(*target.grants.lock().unwrap(), vec![grant()]);
    assert_eq!(target.writes.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn recovery_cannot_claim_a_third_party_pair_even_after_successful_readonly_observation() {
    let source = PackageIo::new("SOURCE", true);
    let target = PackageIo::new("OWNER", false);
    let registry = RoutineOperationRegistry::default();
    let plan = prepare(
        &registry,
        &source,
        &target,
        OracleRoutinePlanInput {
            compact_sql: false,
            source: source.snapshot(),
            target: target.snapshot(),
            drafts: drafts(RoutinePlanAction::Create),
        },
    )
    .await;
    execute(&registry, &source, &target, &plan.steps[0]).await;
    let body = execute(&registry, &source, &target, &plan.steps[1]).await;
    target.programs.lock().unwrap().get_mut("PACKAGE BODY").unwrap().source.push_str(" -- third party");
    let binding = registry.binding_for_readback(&body.operation_id).unwrap();
    let now =
        current_readback(&registry, &body.operation_id, &binding, &target, SourceOrigin::OceanBaseDictionary).await;
    registry.update_readback(&body.operation_id, now);
    assert!(recovery(&registry, &target, &body.operation_id).await.is_err());
    assert_eq!(target.writes.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn unknown_related_body_blocks_recovery_and_new_grants_block_recovery_deletion() {
    for unknown in [false, true] {
        let source = PackageIo::new("SOURCE", true);
        let mut target = PackageIo::new("OWNER", false);
        target.unknown_body = unknown;
        let registry = RoutineOperationRegistry::default();
        let plan = prepare(
            &registry,
            &source,
            &target,
            OracleRoutinePlanInput {
                compact_sql: false,
                source: source.snapshot(),
                target: target.snapshot(),
                drafts: drafts(RoutinePlanAction::Create),
            },
        )
        .await;
        let spec = execute(&registry, &source, &target, &plan.steps[0]).await;
        execute(&registry, &source, &target, &plan.steps[1]).await;
        if unknown {
            assert!(recovery(&registry, &target, &spec.operation_id).await.is_err());
        } else {
            target.grants.lock().unwrap().push(grant());
            let undo = recovery(&registry, &target, &spec.operation_id).await.unwrap();
            assert!(!undo.ready);
            assert!(undo.steps[0].issues.iter().any(|issue| issue.message.contains("New grants")));
            assert!(undo.steps[0].operation.is_none());
        }
        assert_eq!(target.writes.lock().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn dropped_pair_recovery_restores_empty_grant_pair_but_preserves_nonempty_grant_gap() {
    for has_grant in [false, true] {
        let source = PackageIo::new("SOURCE", false);
        let target = PackageIo::new("OWNER", true);
        if has_grant {
            target.grants.lock().unwrap().push(grant());
        }
        let registry = RoutineOperationRegistry::default();
        let spec = drafts(RoutinePlanAction::Delete).remove(0);
        let plan = prepare(
            &registry,
            &source,
            &target,
            OracleRoutinePlanInput {
                compact_sql: false,
                source: source.snapshot(),
                target: target.snapshot(),
                drafts: vec![spec],
            },
        )
        .await;
        let dropped = execute(&registry, &source, &target, &plan.steps[0]).await;
        assert!(dropped.verified());
        let undo = recovery(&registry, &target, &dropped.operation_id).await.unwrap();
        assert_eq!(undo.steps.len(), 2);
        assert_eq!(undo.ready, !has_grant, "{:?}", undo.steps);
        if has_grant {
            assert!(undo.steps.iter().all(|step| step.operation.is_none() && !step.recovery_complete));
            assert!(undo.steps[0].package_impact.as_ref().unwrap().grants.as_ref().unwrap().grants.contains(&grant()));
        } else {
            for step in &undo.steps {
                assert!(execute(&registry, &source, &target, step).await.verified());
            }
            assert_eq!(target.programs.lock().unwrap().len(), 2);
        }
    }
}

#[tokio::test]
async fn recovery_after_spec_only_success_rebuilds_old_body_and_rejects_changes_after_approval() {
    for invalidate in [false, true] {
        let source = PackageIo::new("SOURCE", true);
        {
            let mut programs = source.programs.lock().unwrap();
            let definition = programs["PACKAGE"].source.replace("g NUMBER := 1", "g NUMBER := 2");
            programs.get_mut("PACKAGE").unwrap().source = definition;
        }
        let mut target = PackageIo::new("OWNER", true);
        target.invalidate_old_body = invalidate;
        let registry = RoutineOperationRegistry::default();
        let plan = prepare(
            &registry,
            &source,
            &target,
            OracleRoutinePlanInput {
                compact_sql: false,
                source: source.snapshot(),
                target: target.snapshot(),
                drafts: drafts(RoutinePlanAction::Replace),
            },
        )
        .await;
        let spec = execute(&registry, &source, &target, &plan.steps[0]).await;
        assert!(spec.verified());
        let undo = recovery(&registry, &target, &spec.operation_id).await.unwrap();
        assert!(undo.ready, "{:?}", undo.steps);
        assert_eq!(undo.steps.len(), 2);
        if invalidate {
            target.programs.lock().unwrap().get_mut("PACKAGE BODY").unwrap().source.push_str(" -- concurrent");
            let stopped = execute(&registry, &source, &target, &undo.steps[0]).await;
            assert!(!stopped.dispatched);
            assert_eq!(target.writes.lock().unwrap().len(), 1);
        } else {
            for step in &undo.steps {
                assert!(execute(&registry, &source, &target, step).await.verified());
            }
            assert_eq!(target.writes.lock().unwrap().len(), 3);
        }
    }
}

#[tokio::test]
async fn known_spec_post_state_allows_old_body_invalidation_but_not_unapproved_definition_changes() {
    for invalidate in [false, true] {
        let source = PackageIo::new("SOURCE", true);
        let mut target = PackageIo::new("OWNER", true);
        target.invalidate_old_body = invalidate;
        let registry = RoutineOperationRegistry::default();
        let plan = prepare(
            &registry,
            &source,
            &target,
            OracleRoutinePlanInput {
                compact_sql: false,
                source: source.snapshot(),
                target: target.snapshot(),
                drafts: drafts(RoutinePlanAction::Replace),
            },
        )
        .await;
        assert!(plan.ready, "{:?}", plan.steps);
        assert!(execute(&registry, &source, &target, &plan.steps[0]).await.verified());
        assert!(execute(&registry, &source, &target, &plan.steps[1]).await.verified());
        assert_eq!(target.writes.lock().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn companion_edit_after_specification_stops_body_before_dispatch() {
    let source = PackageIo::new("SOURCE", true);
    let target = PackageIo::new("OWNER", true);
    let registry = RoutineOperationRegistry::default();
    let plan = prepare(
        &registry,
        &source,
        &target,
        OracleRoutinePlanInput {
            compact_sql: false,
            source: source.snapshot(),
            target: target.snapshot(),
            drafts: drafts(RoutinePlanAction::Replace),
        },
    )
    .await;
    assert!(execute(&registry, &source, &target, &plan.steps[0]).await.verified());
    target.programs.lock().unwrap().get_mut("PACKAGE BODY").unwrap().source.push_str(" -- third party");
    let body = execute(&registry, &source, &target, &plan.steps[1]).await;
    assert!(!body.dispatched);
    assert_eq!(body.lifecycle, RoutineOperationLifecycle::Terminal);
    assert_eq!(target.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn body_failure_preserves_verified_spec_and_correction_only_dispatches_a_new_body() {
    let source = PackageIo::new("SOURCE", true);
    let target = PackageIo::new("OWNER", false);
    *target.fail_body.lock().unwrap() = true;
    let registry = RoutineOperationRegistry::default();
    let before = target.snapshot();
    let plan = prepare(
        &registry,
        &source,
        &target,
        OracleRoutinePlanInput {
            compact_sql: false,
            source: source.snapshot(),
            target: before.clone(),
            drafts: drafts(RoutinePlanAction::Create),
        },
    )
    .await;
    let spec = execute(&registry, &source, &target, &plan.steps[0]).await;
    assert!(spec.verified());
    let failed = execute(&registry, &source, &target, &plan.steps[1]).await;
    assert!(failed.dispatched && failed.acknowledged);
    assert_eq!(failed.readback.as_ref().unwrap().state, RoutineReadbackState::Invalid);
    *target.fail_body.lock().unwrap() = false;
    let mut correction = drafts(RoutinePlanAction::Replace).pop().unwrap();
    correction.baseline_operation_id = Some(failed.operation_id.clone());
    let corrected = prepare(
        &registry,
        &source,
        &target,
        OracleRoutinePlanInput {
            compact_sql: false,
            source: source.snapshot(),
            target: before,
            drafts: vec![correction],
        },
    )
    .await;
    assert!(corrected.ready, "{:?}", corrected.steps);
    assert!(execute(&registry, &source, &target, &corrected.steps[0]).await.verified());
    let writes = target.writes.lock().unwrap();
    assert_eq!(writes.len(), 3);
    assert_eq!(writes.iter().filter(|sql| !sql.contains("PACKAGE BODY")).count(), 1);
}

#[tokio::test]
async fn specification_change_during_body_write_is_kept_in_readback_but_never_reported_verified() {
    let source = PackageIo::new("SOURCE", true);
    let mut target = PackageIo::new("OWNER", true);
    target.change_spec_during_body = true;
    let registry = RoutineOperationRegistry::default();
    let body = drafts(RoutinePlanAction::Replace).pop().unwrap();
    let plan = prepare(
        &registry,
        &source,
        &target,
        OracleRoutinePlanInput {
            compact_sql: false,
            source: source.snapshot(),
            target: target.snapshot(),
            drafts: vec![body],
        },
    )
    .await;
    assert!(plan.ready, "{:?}", plan.steps);
    let result = execute(&registry, &source, &target, &plan.steps[0]).await;
    assert!(result.dispatched && result.acknowledged);
    assert!(!result.verified());
    let readback = result.readback.unwrap();
    assert_eq!(readback.state, RoutineReadbackState::ReadbackFailed);
    assert!(readback.package_companion.unwrap().source.unwrap().contains("g NUMBER := 9"));
    let binding = registry.binding_for_readback(&result.operation_id).unwrap();
    let refreshed =
        current_readback(&registry, &result.operation_id, &binding, &target, SourceOrigin::OceanBaseDictionary).await;
    assert_eq!(refreshed.state, RoutineReadbackState::ReadbackFailed);
    assert!(refreshed.package_companion.as_ref().unwrap().source.as_ref().unwrap().contains("g NUMBER := 9"));
    registry.update_readback(&result.operation_id, refreshed);
    assert!(!registry.observe(&result.operation_id).operation.unwrap().verified());
    assert_eq!(target.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn unknown_body_outcome_is_not_unlocked_by_matching_readback_or_a_new_specification_id() {
    let source = PackageIo::new("SOURCE", true);
    let mut target = PackageIo::new("OWNER", false);
    target.unknown_body = true;
    let registry = RoutineOperationRegistry::default();
    let plan = prepare(
        &registry,
        &source,
        &target,
        OracleRoutinePlanInput {
            compact_sql: false,
            source: source.snapshot(),
            target: target.snapshot(),
            drafts: drafts(RoutinePlanAction::Create),
        },
    )
    .await;
    assert!(execute(&registry, &source, &target, &plan.steps[0]).await.verified());
    let unknown = execute(&registry, &source, &target, &plan.steps[1]).await;
    assert_eq!(unknown.lifecycle, RoutineOperationLifecycle::Unproven);
    assert!(unknown.dispatched && !unknown.acknowledged);
    let body_binding = registry.binding_for_readback(&unknown.operation_id).unwrap();
    let current = readback::readback(
        &target,
        &target.endpoint(),
        body_binding.identity,
        &body_binding.goal,
        SourceOrigin::OceanBaseDictionary,
    )
    .await;
    assert_eq!(current.state, RoutineReadbackState::Verified);
    registry.update_readback(&unknown.operation_id, current);
    assert_eq!(
        execute(&registry, &source, &target, &plan.steps[1]).await.lifecycle,
        RoutineOperationLifecycle::Unproven
    );
    let mut retry = registry.binding_for_readback(&plan.steps[0].operation.as_ref().unwrap().operation_id).unwrap();
    retry.package_effect_operation_ids.clear();
    retry.prerequisite_operation_ids.clear();
    let retry = registry.prepare(retry);
    assert!(
        matches!(registry.begin(&retry.operation_id,&plan.steps[0].sql).unwrap(),BeginRoutineOperation::Existing(record) if !record.dispatched)
    );
    assert_eq!(target.writes.lock().unwrap().len(), 2);
}
