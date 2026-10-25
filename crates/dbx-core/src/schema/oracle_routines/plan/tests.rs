use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) struct Catalog {
    pub(super) owner: &'static str,
    pub(super) objects: Vec<RoutineObjectSnapshot>,
    pub(super) incoming: BTreeMap<String, Vec<RoutineDependency>>,
    pub(super) deny_incoming: bool,
    pub(super) grants: Vec<PackageGrant>,
    pub(super) deny_grants: bool,
    pub(super) changed_body: AtomicBool,
    pub(super) changed_grants: AtomicBool,
    pub(super) changed_source: AtomicBool,
    pub(super) tables: BTreeMap<String, Vec<String>>,
}
impl Catalog {
    pub(super) fn new(owner: &'static str, objects: Vec<RoutineObjectSnapshot>) -> Self {
        Self {
            owner,
            objects,
            incoming: BTreeMap::new(),
            deny_incoming: false,
            changed_source: AtomicBool::new(false),
            grants: Vec::new(),
            deny_grants: false,
            changed_body: AtomicBool::new(false),
            changed_grants: AtomicBool::new(false),
            tables: BTreeMap::new(),
        }
    }
    fn source_text(&self, object: &RoutineObjectSnapshot) -> String {
        let source = object.source.as_ref().unwrap();
        if self.changed_source.load(Ordering::SeqCst)
            || (object.version.identity.kind == db::ObjectSourceKind::PackageBody
                && self.changed_body.load(Ordering::SeqCst))
        {
            format!("{source} -- concurrent edit")
        } else {
            source.clone()
        }
    }
}
fn reply(columns: &[&str], rows: Vec<Vec<Value>>) -> CatalogReply {
    serde_json::from_value(json!({"columns":columns,"rows":rows})).unwrap()
}
fn name_from(sql: &str, field: &str) -> String {
    sql.split(&format!("{field} = '")).nth(1).unwrap_or("").split('\'').next().unwrap_or("").into()
}

#[async_trait::async_trait]
impl RoutineCatalog for Catalog {
    async fn source(&self, identity: &RoutineIdentity) -> Result<SourceReply, String> {
        let object =
            self.objects.iter().find(|object| object.version.identity == *identity).ok_or("Source not found")?;
        Ok(serde_json::from_value(json!({"name":identity.name,"schema":identity.owner,"object_type":identity.kind,"source":self.source_text(object),"source_origin":matches!(identity.kind, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody).then_some("oceanbase-dictionary")})).unwrap())
    }
    async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
        if sql.contains("LOGIN_OWNER") {
            return Ok(reply(&["LOGIN_OWNER"], vec![vec![json!(self.owner)]]));
        }
        if sql.contains("ALL_OBJECTS") || sql.contains("DBA_OBJECTS") {
            let owner = name_from(sql, "OWNER");
            let name = name_from(sql, "OBJECT_NAME");
            let mut rows: Vec<Vec<Value>> = self
                .objects
                .iter()
                .filter(|object| object.version.identity.owner == owner && object.version.identity.name == name)
                .map(|object| {
                    let version = &object.version;
                    vec![
                        json!(version.identity.owner),
                        json!(version.identity.name),
                        json!(kind_name(&version.identity.kind)),
                        json!(version.object_id),
                        json!(version.status),
                        json!(version.last_ddl_time),
                    ]
                })
                .collect();
            if owner == self.owner && self.tables.contains_key(&name) {
                rows.push(vec![
                    json!(owner),
                    json!(name),
                    json!("TABLE"),
                    json!(100),
                    json!("VALID"),
                    json!("2026-10-23T00:00:00"),
                ]);
            }
            return Ok(reply(&["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "STATUS", "LAST_DDL_TIME"], rows));
        }
        if sql.contains("ALL_TAB_COLUMNS") {
            let table = name_from(sql, "TABLE_NAME");
            let columns = self.tables.get(&table).ok_or("Target table is unavailable")?;
            let rows = columns
                .iter()
                .enumerate()
                .map(|(index, name)| vec![json!(index + 16), json!(name), json!(index + 1)])
                .collect();
            return Ok(reply(&["COLUMN_ID", "COLUMN_NAME", "RN"], rows));
        }
        if sql.contains("ALL_ERRORS") {
            return Ok(reply(&["SEQUENCE", "ATTRIBUTE", "LINE", "POSITION", "TEXT"], Vec::new()));
        }
        if sql.contains("ALL_TAB_PRIVS") {
            if self.deny_grants {
                return Err("ORA-00942: grant visibility unavailable".into());
            }
            let offset =
                sql.split("WHERE RN > ").nth(1).unwrap().split_whitespace().next().unwrap().parse::<usize>().unwrap();
            let rows = self
                .grants
                .iter()
                .enumerate()
                .skip(offset)
                .take(PAGE_SIZE)
                .map(|(index, grant)| {
                    vec![
                        json!(grant.grantor),
                        json!(grant.grantee),
                        json!(if self.changed_grants.load(Ordering::SeqCst) {
                            "DEBUG"
                        } else {
                            grant.privilege.as_str()
                        }),
                        json!(if grant.grantable { "YES" } else { "NO" }),
                        json!(index + 1),
                    ]
                })
                .collect();
            return Ok(reply(&["GRANTOR", "GRANTEE", "PRIVILEGE", "GRANTABLE", "RN"], rows));
        }
        if sql.contains("SOURCE_ROWS") {
            let name = name_from(sql, "NAME");
            let kind = name_from(sql, "TYPE");
            let object = self
                .objects
                .iter()
                .find(|object| object.version.identity.name == name && kind_name(&object.version.identity.kind) == kind)
                .unwrap();
            let source = self.source_text(object);
            let body = source.strip_prefix("CREATE OR REPLACE ").unwrap();
            return Ok(reply(
                &["SOURCE_ROWS", "FIRST_LINE", "LAST_LINE", "SOURCE_CHARS", "HEAD_TRIM", "TAIL_TRIM", "SOURCE_HEAD"],
                vec![vec![
                    json!(1),
                    json!(1),
                    json!(1),
                    json!(body.chars().count()),
                    json!(0),
                    json!(0),
                    json!(kind_name(&object.version.identity.kind)),
                ]],
            ));
        }
        if sql.contains("DBA_DEPENDENCIES") {
            if self.deny_incoming {
                return Err("ORA-00942: no complete incoming visibility".into());
            }
            let name = name_from(sql, "REFERENCED_NAME");
            let rows = self
                .incoming
                .get(&name)
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(index, caller)| {
                    vec![
                        json!(caller.owner),
                        json!(caller.name),
                        json!(caller.kind),
                        json!(caller.database_link),
                        json!(caller.dependency_type),
                        json!(index + 1),
                    ]
                })
                .collect();
            return Ok(reply(&["OWNER", "NAME", "TYPE", "REFERENCED_LINK_NAME", "DEPENDENCY_TYPE", "RN"], rows));
        }
        if sql.contains("ALL_DEPENDENCIES") {
            let name = name_from(sql, "NAME");
            let kind = name_from(sql, "TYPE");
            let object = self
                .objects
                .iter()
                .find(|object| object.version.identity.name == name && kind_name(&object.version.identity.kind) == kind)
                .unwrap();
            let rows = object
                .dependencies
                .iter()
                .enumerate()
                .map(|(index, dependency)| {
                    vec![
                        json!(dependency.owner),
                        json!(dependency.name),
                        json!(dependency.kind),
                        json!(dependency.database_link),
                        json!(dependency.dependency_type),
                        json!(index + 1),
                    ]
                })
                .collect();
            return Ok(reply(
                &[
                    "REFERENCED_OWNER",
                    "REFERENCED_NAME",
                    "REFERENCED_TYPE",
                    "REFERENCED_LINK_NAME",
                    "DEPENDENCY_TYPE",
                    "RN",
                ],
                rows,
            ));
        }
        panic!("Unexpected metadata query: {sql}")
    }
}

pub(super) fn endpoint(owner: &str) -> RoutineEndpoint {
    RoutineEndpoint {
        connection_id: owner.into(),
        database: "tenant".into(),
        schema: owner.into(),
        database_type: DatabaseType::OceanbaseOracle,
        generation: 1,
    }
}
pub(super) fn object(owner: &str, name: &str, expression: &str) -> RoutineObjectSnapshot {
    RoutineObjectSnapshot {
        version: RoutineVersion {
            identity: RoutineIdentity { owner: owner.into(), name: name.into(), kind: db::ObjectSourceKind::Function },
            object_id: format!("{}", name.as_bytes()[0]),
            status: "VALID".into(),
            last_ddl_time: "2026-10-21T00:00:00".into(),
        },
        source: Some(format!("CREATE OR REPLACE FUNCTION \"{name}\" RETURN NUMBER AS BEGIN RETURN {expression}; END")),
        source_origin: None,
        source_complete: true,
        dependencies: Vec::new(),
        dependencies_complete: true,
        issues: Vec::new(),
    }
}
pub(super) fn snapshot(catalog: &Catalog) -> RoutineSnapshot {
    RoutineSnapshot {
        endpoint: endpoint(catalog.owner),
        state: RoutineReadState::Complete,
        enumeration_complete: true,
        objects: catalog.objects.clone(),
        issues: Vec::new(),
    }
}
pub(super) fn draft(name: &str, action: RoutinePlanAction) -> RoutinePlanDraft {
    RoutinePlanDraft {
        identity: object("OWNER", name, "1").version.identity,
        action,
        source_name: None,
        sql: None,
        baseline_operation_id: None,
        supersedes_operation_id: None,
        package_body_source: None,
        package_contract: None,
        confirm_package_pair: false,
    }
}
fn input(source: &Catalog, target: &Catalog, drafts: Vec<RoutinePlanDraft>) -> OracleRoutinePlanInput {
    OracleRoutinePlanInput { source: snapshot(source), target: snapshot(target), drafts, compact_sql: false }
}
async fn build(source: &Catalog, target: &Catalog, input: &OracleRoutinePlanInput) -> BuiltPlan {
    build_plan(
        Some(source),
        target,
        input,
        SourceOrigin::OceanBaseDictionary,
        SourceOrigin::OceanBaseDictionary,
        |_| Ok(None),
    )
    .await
}

#[test]
fn snapshot_lookup_distinguishes_package_kinds_but_retains_shared_namespace_conflicts() {
    let mut spec = object("OWNER", "Pkg.With.Dot", "1");
    spec.version.identity.kind = db::ObjectSourceKind::Package;
    let mut body = spec.clone();
    body.version.identity.kind = db::ObjectSourceKind::PackageBody;
    body.version.object_id = "999".into();
    let mut snapshot = snapshot(&Catalog::new("OWNER", vec![spec.clone(), body.clone()]));
    assert_eq!(
        snapshot_object(&snapshot, "Pkg.With.Dot", &db::ObjectSourceKind::Package).unwrap().unwrap().version,
        spec.version
    );
    assert_eq!(
        snapshot_object(&snapshot, "Pkg.With.Dot", &db::ObjectSourceKind::PackageBody).unwrap().unwrap().version,
        body.version
    );
    snapshot.objects.pop();
    assert!(snapshot_object(&snapshot, "Pkg.With.Dot", &db::ObjectSourceKind::PackageBody).unwrap().is_none());
    snapshot.objects.push(spec.clone());
    assert!(snapshot_object(&snapshot, "Pkg.With.Dot", &db::ObjectSourceKind::Package).is_err());
    snapshot.objects.pop();
    snapshot.objects.push(object("OWNER", "Pkg.With.Dot", "1"));
    assert!(snapshot_object(&snapshot, "Pkg.With.Dot", &db::ObjectSourceKind::Package).is_err());
    assert!(snapshot_object(&snapshot, "Pkg.With.Dot", &db::ObjectSourceKind::Function).is_err());
}

#[test]
fn public_plan_selection_allows_exact_package_kinds_without_expanding_cross_product_or_other_kind_selection() {
    let catalog = Catalog::new("OWNER", Vec::new());
    let mut input = OracleRoutinePlanInput {
        compact_sql: false,
        source: snapshot(&catalog),
        target: snapshot(&catalog),
        drafts: vec![RoutinePlanDraft {
            identity: RoutineIdentity {
                owner: "OWNER".into(),
                name: "PKG".into(),
                kind: db::ObjectSourceKind::Package,
            },
            action: RoutinePlanAction::Create,
            source_name: None,
            sql: None,
            baseline_operation_id: None,
            supersedes_operation_id: None,
            package_body_source: None,
            package_contract: None,
            confirm_package_pair: false,
        }],
    };
    for kind in [
        db::ObjectSourceKind::Procedure,
        db::ObjectSourceKind::Function,
        db::ObjectSourceKind::Package,
        db::ObjectSourceKind::PackageBody,
    ] {
        input.drafts[0].identity.kind = kind;
        assert!(check_plan_selection(&input).is_ok());
    }
    input.drafts[0].identity.kind = db::ObjectSourceKind::Type;
    assert!(check_plan_selection(&input).is_err());
    input.drafts[0].identity.kind = db::ObjectSourceKind::Package;
    input.target.endpoint.database_type = DatabaseType::Oracle;
    assert!(check_plan_selection(&input).is_ok());
    input.drafts[0].identity.kind = db::ObjectSourceKind::Function;
    assert!(check_plan_selection(&input).unwrap_err().contains("Cross-product"));
    input.drafts.clear();
    input.target.endpoint.database_type = input.source.endpoint.database_type;
    assert!(check_plan_selection(&input).is_err());
}

#[tokio::test]
async fn package_preflight_requires_the_actual_preview_origin_even_when_text_and_version_match() {
    let mut specification = object("OWNER", "PKG", "1");
    specification.version.identity.kind = db::ObjectSourceKind::Package;
    specification.source = Some("CREATE OR REPLACE PACKAGE \"OWNER\".PKG AS g NUMBER; END PKG;".into());
    specification.source_origin = Some(SourceOrigin::OceanBaseDictionary);
    let catalog = Catalog::new("OWNER", vec![specification.clone()]);
    verify_expected(
        &catalog,
        &endpoint("OWNER"),
        &ExpectedRoutine::Present(specification.clone()),
        SourceOrigin::OceanBaseDictionary,
    )
    .await
    .unwrap();
    for source_origin in [None, Some(SourceOrigin::OracleMetadata)] {
        let expected = ExpectedRoutine::Present(RoutineObjectSnapshot { source_origin, ..specification.clone() });
        assert!(verify_expected(&catalog, &endpoint("OWNER"), &expected, SourceOrigin::OceanBaseDictionary)
            .await
            .unwrap_err()
            .contains("origin"));
    }
}

#[tokio::test]
async fn initial_plan_preserves_raw_text_and_creates_without_replace_in_server_dependency_order() {
    let source =
        Catalog::new("SOURCE", vec![object("SOURCE", "Caller", "\"Callee\""), object("SOURCE", "Callee", "1")]);
    let target = Catalog::new("OWNER", Vec::new());
    let input = input(
        &source,
        &target,
        vec![draft("Caller", RoutinePlanAction::Create), draft("Callee", RoutinePlanAction::Create)],
    );
    let result = build(&source, &target, &input).await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    assert_eq!(result.order, vec![1, 0]);
    validate_oracle_routine_target_definition(
        ddl_input(&input.target.endpoint, &result.plan.steps[0].identity, result.plan.steps[0].sql.clone()),
        Some(false),
    )
    .unwrap();
    assert_eq!(result.plan.steps[0].source_original, source.objects[0].source);
    assert!(result.plan.steps[0].target_original.is_none());
    assert_eq!(result.plan.steps[0].recovery_sql.as_deref(), Some("DROP FUNCTION \"OWNER\".\"Caller\";"));
}

#[tokio::test]
async fn compact_generated_plan_preserves_snapshots_recovery_and_manual_drafts() {
    let source = Catalog::new("SOURCE", vec![object("SOURCE", "F", "1")]);
    let target = Catalog::new("OWNER", Vec::new());
    let mut input = input(&source, &target, vec![draft("F", RoutinePlanAction::Create)]);
    let original = build(&source, &target, &input).await;
    input.compact_sql = true;
    let compact = build(&source, &target, &input).await;
    assert!(compact.plan.ready, "{:?}", compact.plan.steps);
    assert!(compact.plan.steps[0].sql.starts_with("CREATE FUNCTION"));
    assert_eq!(compact.plan.steps[0].source_original, original.plan.steps[0].source_original);
    assert_eq!(compact.plan.steps[0].recovery_sql, original.plan.steps[0].recovery_sql);
    input.drafts[0].sql = Some("CREATE FUNCTION \"OWNER\".\"F\" RETURN   NUMBER AS BEGIN RETURN 1; END;".into());
    let manual = build(&source, &target, &input).await;
    assert!(manual.plan.ready, "{:?}", manual.plan.steps);
    assert!(manual.plan.steps[0].sql.contains("RETURN   NUMBER"));
}

#[tokio::test]
async fn final_manual_draft_invalidates_old_edges_and_becomes_the_new_readback_expectation() {
    let source =
        Catalog::new("SOURCE", vec![object("SOURCE", "Caller", "\"Callee\""), object("SOURCE", "Callee", "1")]);
    let target = Catalog::new("OWNER", Vec::new());
    let mut input = input(
        &source,
        &target,
        vec![draft("Caller", RoutinePlanAction::Create), draft("Callee", RoutinePlanAction::Create)],
    );
    input.drafts[0].sql = Some("CREATE FUNCTION \"OWNER\".\"Caller\" RETURN NUMBER AS BEGIN RETURN 77; END;".into());
    let result = build(&source, &target, &input).await;
    assert!(result.plan.ready);
    assert_eq!(result.order, vec![0, 1]);
    assert!(result.dependencies[0].is_empty());
    assert!(result.plan.steps[0].sql.contains("RETURN 77;"));
    input.drafts[0].sql = Some("CREATE FUNCTION \"OWNER\".\"Other\" RETURN NUMBER AS BEGIN RETURN 77; END;".into());
    assert!(!build(&source, &target, &input).await.plan.ready);
    input.drafts[0].sql =
        Some("CREATE OR REPLACE FUNCTION \"OWNER\".\"Caller\" RETURN NUMBER AS BEGIN RETURN 77; END;".into());
    assert!(!build(&source, &target, &input).await.plan.ready);
}

#[tokio::test]
async fn cycles_are_localized_and_independent_valid_drafts_are_not_discarded() {
    let source = Catalog::new(
        "SOURCE",
        vec![object("SOURCE", "F", "\"G\""), object("SOURCE", "G", "\"F\""), object("SOURCE", "Independent", "7")],
    );
    let target = Catalog::new("OWNER", Vec::new());
    let input = input(
        &source,
        &target,
        vec![
            draft("F", RoutinePlanAction::Create),
            draft("G", RoutinePlanAction::Create),
            draft("Independent", RoutinePlanAction::Create),
        ],
    );
    let result = build(&source, &target, &input).await;
    assert!(!result.plan.ready);
    assert!(!result.plan.steps[0].issues.is_empty());
    assert!(result.plan.steps[2].issues.is_empty());
    assert!(result.plan.steps[2].sql.contains("RETURN 7;"));
}

#[tokio::test]
async fn destructive_visibility_failure_only_affects_that_step_not_ordinary_owner_creation() {
    let source = Catalog::new("SOURCE", vec![object("SOURCE", "F", "2"), object("SOURCE", "New", "3")]);
    let mut target = Catalog::new("OWNER", vec![object("OWNER", "F", "1")]);
    target.deny_incoming = true;
    let input =
        input(&source, &target, vec![draft("F", RoutinePlanAction::Replace), draft("New", RoutinePlanAction::Create)]);
    let result = build(&source, &target, &input).await;
    assert!(!result.plan.ready);
    assert!(result.plan.steps[0].issues[0].message.contains("incoming"));
    assert!(result.plan.steps[1].issues.is_empty());
    let input = OracleRoutinePlanInput { drafts: vec![input.drafts[1].clone()], ..input };
    assert!(build(&source, &target, &input).await.plan.ready);
}

fn caller(name: &str) -> RoutineDependency {
    RoutineDependency {
        owner: "OWNER".into(),
        name: name.into(),
        kind: "FUNCTION".into(),
        database_link: None,
        dependency_type: "HARD".into(),
    }
}

#[tokio::test]
async fn delete_checks_full_callers_and_reverses_the_selected_deletion_order_without_claiming_grant_recovery() {
    let source = Catalog::new("SOURCE", Vec::new());
    let mut target = Catalog::new("OWNER", vec![object("OWNER", "F", "1"), object("OWNER", "G", "\"F\"")]);
    target.incoming.insert("F".into(), vec![caller("G")]);
    let blocked = input(&source, &target, vec![draft("F", RoutinePlanAction::Delete)]);
    assert!(build(&source, &target, &blocked).await.plan.steps[0].issues[0].message.contains("outside"));
    let all =
        input(&source, &target, vec![draft("F", RoutinePlanAction::Delete), draft("G", RoutinePlanAction::Delete)]);
    let result = build(&source, &target, &all).await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    assert_eq!(result.order, vec![1, 0]);
    assert_eq!(result.plan.steps[0].sql, "DROP FUNCTION \"OWNER\".\"F\";");
    assert!(!result.plan.steps[0].recovery_complete);
    validate_oracle_routine_target_definition(
        ddl_input(
            &all.target.endpoint,
            &result.plan.steps[0].identity,
            result.plan.steps[0].recovery_sql.clone().unwrap(),
        ),
        Some(false),
    )
    .unwrap();
}

#[tokio::test]
async fn same_second_source_target_and_incoming_changes_block_prepared_writes() {
    let source = Catalog::new("SOURCE", vec![object("SOURCE", "F", "2")]);
    let mut target = Catalog::new("OWNER", vec![object("OWNER", "F", "1")]);
    let input = input(&source, &target, vec![draft("F", RoutinePlanAction::Replace)]);
    let mut result = build(&source, &target, &input).await;
    assert!(result.plan.ready);
    let preflight = result.preflights[0].as_mut().unwrap();
    verify_compare_preflight(
        Some(&source),
        &target,
        &input.target.endpoint,
        preflight,
        SourceOrigin::OceanBaseDictionary,
    )
    .await
    .unwrap();
    target.changed_source.store(true, Ordering::SeqCst);
    assert!(verify_compare_preflight(
        Some(&source),
        &target,
        &input.target.endpoint,
        preflight,
        SourceOrigin::OceanBaseDictionary
    )
    .await
    .is_err());
    target.changed_source.store(false, Ordering::SeqCst);
    target.incoming.insert("F".into(), vec![caller("Outside")]);
    assert!(verify_compare_preflight(
        Some(&source),
        &target,
        &input.target.endpoint,
        preflight,
        SourceOrigin::OceanBaseDictionary
    )
    .await
    .is_err());
    source.changed_source.store(true, Ordering::SeqCst);
    assert!(verify_expected(
        &source,
        &input.source.endpoint,
        result.source_expected[0].as_ref().unwrap(),
        SourceOrigin::OceanBaseDictionary
    )
    .await
    .is_err());
}

#[tokio::test]
async fn occupied_new_namespace_incomplete_absence_and_extra_sql_cannot_produce_a_ready_plan() {
    let source = Catalog::new("SOURCE", vec![object("SOURCE", "F", "1")]);
    let target = Catalog::new("OWNER", Vec::new());
    let input = input(&source, &target, vec![draft("F", RoutinePlanAction::Create)]);
    let occupied = Catalog::new("OWNER", vec![object("OWNER", "F", "9")]);
    assert!(!build(&source, &occupied, &input).await.plan.ready);
    let mut missing_scope = input.clone();
    missing_scope.target.enumeration_complete = false;
    assert!(!build(&source, &target, &missing_scope).await.plan.ready);
    let mut extra = input;
    extra.drafts[0].sql =
        Some("CREATE FUNCTION \"OWNER\".\"F\" RETURN NUMBER AS BEGIN RETURN 1; END; DELETE FROM unrelated;".into());
    assert!(!build(&source, &target, &extra).await.plan.ready);
}

#[tokio::test]
async fn terminal_invalid_create_can_be_corrected_as_an_explicit_new_replace_approval() {
    let source = Catalog::new("SOURCE", vec![object("SOURCE", "F", "1")]);
    let target = Catalog::new("OWNER", vec![object("OWNER", "F", "1")]);
    let mut input = input(&source, &Catalog::new("OWNER", Vec::new()), vec![draft("F", RoutinePlanAction::Replace)]);
    input.drafts[0].baseline_operation_id = Some("original-invalid-create".into());
    input.drafts[0].sql = Some("CREATE FUNCTION \"OWNER\".\"F\" RETURN NUMBER AS BEGIN RETURN 77; END;".into());
    let result = build_plan(
        Some(&source),
        &target,
        &input,
        SourceOrigin::OceanBaseDictionary,
        SourceOrigin::OceanBaseDictionary,
        |_| {
            Ok(Some(RoutineBaseline { selected: ExpectedRoutine::Present(target.objects[0].clone()), companion: None }))
        },
    )
    .await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    validate_oracle_routine_target_definition(
        ddl_input(&input.target.endpoint, &result.plan.steps[0].identity, result.plan.steps[0].sql.clone()),
        Some(true),
    )
    .unwrap();
    assert!(result.plan.steps[0].sql.contains("RETURN 77;"));
}

fn correction_record() -> RoutineOperationRecord {
    let object = object("OWNER", "F", "1");
    RoutineOperationRecord {
        operation_id: "original".into(),
        target: endpoint("OWNER"),
        identity: object.version.identity.clone(),
        lifecycle: RoutineOperationLifecycle::Terminal,
        dispatched: true,
        acknowledged: true,
        error: None,
        readback: Some(RoutineReadback {
            identity: object.version.identity.clone(),
            state: RoutineReadbackState::Invalid,
            exists: Some(true),
            version: Some(object.version),
            source: object.source,
            source_origin: None,
            package_companion: None,
            definition_matches: Some(true),
            compiler_messages: Vec::new(),
            issues: Vec::new(),
        }),
    }
}

#[test]
fn correction_accepts_the_terminal_invalid_definition_but_not_a_competing_create() {
    let record = correction_record();
    let identity = record.identity.clone();
    assert!(matches!(
        correction_baseline(record.clone(), &endpoint("OWNER"), &identity).unwrap(),
        ExpectedRoutine::Present(_)
    ));
    let mut competing = record;
    competing.acknowledged = false;
    competing.readback.as_mut().unwrap().definition_matches = Some(false);
    let error = correction_baseline(competing, &endpoint("OWNER"), &identity).err().unwrap();
    assert!(error.contains("refresh and review"));
}

#[test]
fn matching_or_absent_readback_does_not_prove_an_unknown_request_has_terminated() {
    let mut record = correction_record();
    let identity = record.identity.clone();
    record.lifecycle = RoutineOperationLifecycle::Unproven;
    assert!(correction_baseline(record.clone(), &endpoint("OWNER"), &identity).is_err());
    let readback = record.readback.as_mut().unwrap();
    readback.state = RoutineReadbackState::Verified;
    readback.exists = Some(false);
    readback.version = None;
    readback.source = None;
    readback.definition_matches = None;
    assert!(correction_baseline(record.clone(), &endpoint("OWNER"), &identity).is_err());
    record.lifecycle = RoutineOperationLifecycle::Terminal;
    assert!(matches!(correction_baseline(record, &endpoint("OWNER"), &identity).unwrap(), ExpectedRoutine::Absent(_)));
}
