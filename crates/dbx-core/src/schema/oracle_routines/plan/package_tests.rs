use super::tests::{endpoint, object, snapshot, Catalog};
use super::*;
use std::sync::atomic::Ordering;

fn program(owner: &str, name: &str, kind: db::ObjectSourceKind, source: &str) -> RoutineObjectSnapshot {
    let mut result = object(owner, name, "1");
    result.version.identity.kind = kind.clone();
    result.version.object_id = if kind == db::ObjectSourceKind::PackageBody { "81" } else { "80" }.into();
    result.source = Some(source.into());
    result.source_origin = Some(SourceOrigin::OceanBaseDictionary);
    result
}

fn specification(owner: &str, initial: u8) -> RoutineObjectSnapshot {
    program(owner,"PKG",db::ObjectSourceKind::Package,&format!("CREATE OR REPLACE PACKAGE \"{owner}\".PKG AS g NUMBER := {initial}; FUNCTION f(p NUMBER DEFAULT 1) RETURN NUMBER; END PKG;"))
}

fn body(owner: &str) -> RoutineObjectSnapshot {
    program(owner,"PKG",db::ObjectSourceKind::PackageBody,&format!("CREATE OR REPLACE PACKAGE BODY \"{owner}\".PKG AS FUNCTION f(p NUMBER) RETURN NUMBER IS BEGIN RETURN p + g; END f; END PKG;"))
}

fn draft(kind: db::ObjectSourceKind, action: RoutinePlanAction) -> RoutinePlanDraft {
    RoutinePlanDraft {
        identity: RoutineIdentity { owner: "OWNER".into(), name: "PKG".into(), kind },
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

async fn build(source: &Catalog, target: &Catalog, drafts: Vec<RoutinePlanDraft>) -> BuiltPlan {
    build_with_compact(source, target, drafts, false).await
}

async fn build_with_compact(
    source: &Catalog,
    target: &Catalog,
    drafts: Vec<RoutinePlanDraft>,
    compact_sql: bool,
) -> BuiltPlan {
    let input = package::normalize_input(OracleRoutinePlanInput {
        compact_sql,
        source: snapshot(source),
        target: snapshot(target),
        drafts,
    })
    .unwrap();
    build_plan(
        Some(source),
        target,
        &input,
        SourceOrigin::OceanBaseDictionary,
        SourceOrigin::OceanBaseDictionary,
        |_| Ok(None),
    )
    .await
}

#[tokio::test]
async fn package_generated_specification_and_selected_body_compact_without_changing_manual_or_recovery_text() {
    for retained in [false, true] {
        let mut originals = vec![specification("SOURCE", 2), body("SOURCE")];
        for original in &mut originals {
            original.source = original.source.as_ref().map(|source| source.replace(" AS ", " AS\n    "));
        }
        let source = Catalog::new("SOURCE", originals);
        let target =
            Catalog::new("OWNER", if retained { vec![specification("OWNER", 1), body("OWNER")] } else { vec![] });
        let action = if retained { RoutinePlanAction::Replace } else { RoutinePlanAction::Create };
        let mut spec = draft(db::ObjectSourceKind::Package, action);
        spec.confirm_package_pair = retained;
        let mut implementation = draft(db::ObjectSourceKind::PackageBody, action);
        if retained {
            implementation.package_body_source = Some(PackageBodySource::Target);
        }
        let drafts = vec![spec, implementation];
        let expanded = build_with_compact(&source, &target, drafts.clone(), false).await.plan;
        let compact = build_with_compact(&source, &target, drafts.clone(), true).await.plan;
        assert!(expanded.ready, "{:?}", expanded.steps);
        assert!(compact.ready, "{:?}", compact.steps);
        for (before, after) in expanded.steps.iter().zip(&compact.steps) {
            assert_eq!(after.sql, compact_oracle_ddl(&before.sql).unwrap());
            assert_eq!(after.source_original, before.source_original);
            assert_eq!(after.target_original, before.target_original);
            assert_eq!(after.recovery_sql, before.recovery_sql);
        }
        let manual: Vec<_> = drafts
            .into_iter()
            .zip(&expanded.steps)
            .map(|(mut draft, step)| {
                draft.sql = Some(step.sql.clone());
                draft
            })
            .collect();
        let manual_baseline = build_with_compact(&source, &target, manual.clone(), false).await.plan;
        let reviewed = build_with_compact(&source, &target, manual, true).await.plan;
        assert!(manual_baseline.ready, "{:?}", manual_baseline.steps);
        assert!(reviewed.ready, "{:?}", reviewed.steps);
        for (before, after) in manual_baseline.steps.iter().zip(reviewed.steps) {
            assert_eq!(after.sql, before.sql);
        }
    }
}

#[tokio::test]
async fn transfer_batch_checks_the_initial_absent_pair_without_requiring_its_future_specification() {
    let source = Catalog::new("SOURCE", vec![specification("SOURCE", 1), body("SOURCE")]);
    let target = Catalog::new("OWNER", vec![]);
    let input = OracleRoutinePlanInput {
        compact_sql: false,
        source: snapshot(&source),
        target: snapshot(&target),
        drafts: vec![
            draft(db::ObjectSourceKind::Package, RoutinePlanAction::Create),
            draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Create),
        ],
    };
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({"id":"target","name":"test","db_type":"oceanbase-oracle","host":"localhost","port":2881,"username":"OWNER","password":""})).unwrap();
    let registry = RoutineOperationRegistry::default();
    let plan = prepare_with_catalogs(&registry, &source, &target, input, &config, &config).await.unwrap();
    assert!(plan.ready, "{:?}", plan.steps);
    let writes = plan
        .steps
        .iter()
        .map(|step| {
            let id = step.operation.as_ref().unwrap().operation_id.clone();
            let binding = registry.binding_for_readback(&id).unwrap();
            (id, binding)
        })
        .collect::<Vec<_>>();
    verify_transfer_preflights(&writes, &source, &target, SourceOrigin::OceanBaseDictionary).await.unwrap();
    let body = writes.iter().find(|(_, binding)| binding.identity.kind == db::ObjectSourceKind::PackageBody).unwrap();
    assert!(body.1.compare.as_ref().unwrap().package.as_ref().unwrap().require_valid_specification);
    assert!(
        verify_compare_preflight(
            Some(&source),
            &target,
            &body.1.target,
            body.1.compare.as_ref().unwrap(),
            SourceOrigin::OceanBaseDictionary
        )
        .await
        .is_err(),
        "Actual BODY dispatch must still wait for the verified VALID specification"
    );
    assert!(writes.iter().all(|(id, _)| registry
        .observe(id)
        .operation
        .is_some_and(|record| record.lifecycle == RoutineOperationLifecycle::Prepared && !record.dispatched)));
}

#[tokio::test]
async fn transfer_claim_rechecks_frozen_approvals_before_any_table_stage_without_reapproval() {
    for changed in ["source", "external", "target"] {
        let original = program(
            "SOURCE",
            "PKG",
            db::ObjectSourceKind::Package,
            "CREATE OR REPLACE PACKAGE \"SOURCE\".PKG AS n NUMBER := Q.g; END PKG;",
        );
        let source = Catalog::new("SOURCE", vec![original]);
        let external = program(
            "OWNER",
            "Q",
            db::ObjectSourceKind::Package,
            "CREATE OR REPLACE PACKAGE \"OWNER\".Q AS g NUMBER := 1; END Q;",
        );
        let mut target = Catalog::new("OWNER", vec![external]);
        let input = OracleRoutinePlanInput {
            compact_sql: false,
            source: snapshot(&source),
            target: snapshot(&target),
            drafts: vec![draft(db::ObjectSourceKind::Package, RoutinePlanAction::Create)],
        };
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({"id":"target","name":"test","db_type":"oceanbase-oracle","host":"localhost","port":2881,"username":"OWNER","password":""})).unwrap();
        let registry = RoutineOperationRegistry::default();
        let plan = prepare_with_catalogs(&registry, &source, &target, input, &config, &config).await.unwrap();
        assert!(plan.ready, "{:?}", plan.steps);
        let id = plan.steps[0].operation.as_ref().unwrap().operation_id.clone();
        let writes = vec![(id.clone(), registry.binding_for_readback(&id).unwrap())];
        verify_transfer_preflights(&writes, &source, &target, SourceOrigin::OceanBaseDictionary).await.unwrap();
        match changed {
            "source" => source.changed_source.store(true, Ordering::SeqCst),
            "external" => target.objects[0].source.as_mut().unwrap().push_str(" -- changed compatible dependency"),
            _ => target.objects.push(program(
                "OWNER",
                "PKG",
                db::ObjectSourceKind::Package,
                "CREATE OR REPLACE PACKAGE \"OWNER\".PKG AS n NUMBER; END PKG;",
            )),
        }
        assert!(
            verify_transfer_preflights(&writes, &source, &target, SourceOrigin::OceanBaseDictionary).await.is_err(),
            "{changed}"
        );
        let record = registry.observe(&id).operation.unwrap();
        assert_eq!(record.lifecycle, RoutineOperationLifecycle::Prepared);
        assert!(!record.dispatched);
        assert_eq!(record.operation_id, id);
    }
}

#[tokio::test]
async fn pending_table_edits_only_supersede_the_original_pinned_prepared_new_package() {
    let original = program(
        "SOURCE",
        "PKG",
        db::ObjectSourceKind::Package,
        "CREATE OR REPLACE PACKAGE \"SOURCE\".PKG AS n NUMBER; END PKG;",
    );
    let source = Catalog::new("SOURCE", vec![original]);
    let target = Catalog::new("OWNER", vec![]);
    let mut input = OracleRoutinePlanInput {
        compact_sql: false,
        source: snapshot(&source),
        target: snapshot(&target),
        drafts: vec![draft(db::ObjectSourceKind::Package, RoutinePlanAction::Create)],
    };
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({"id":"target","name":"test","db_type":"oceanbase-oracle","host":"localhost","port":2881,"username":"OWNER","password":""})).unwrap();
    let registry = RoutineOperationRegistry::default();
    let plan = prepare_with_catalogs(&registry, &source, &target, input.clone(), &config, &config).await.unwrap();
    assert!(plan.ready, "{:?}", plan.steps);
    let id = plan.steps[0].operation.as_ref().unwrap().operation_id.clone();
    input.drafts[0].supersedes_operation_id = Some(id.clone());
    let pins = pin_transfer_replacements(&registry, &input).unwrap();
    registry.update_references(&[], std::slice::from_ref(&id)).unwrap();
    assert!(
        registry.observe(&id).operation.is_some(),
        "Validation pins preserve the original ID across preview release"
    );
    for case in 0..4 {
        let mut changed = input.clone();
        match case {
            0 => changed.target.endpoint.generation += 1,
            1 => changed.drafts[0].identity.name = "OTHER".into(),
            2 => changed.drafts[0].action = RoutinePlanAction::Replace,
            _ => changed.drafts[0].baseline_operation_id = Some(id.clone()),
        }
        assert!(pin_transfer_replacements(&registry, &changed).is_err(), "case {case}");
    }
    registry.begin(&id, &plan.steps[0].sql).unwrap();
    assert!(pin_transfer_replacements(&registry, &input).is_err());
    registry.mark_dispatched(&id).unwrap();
    registry.waiting_lost(&id, "Original completion is unknown".into());
    assert!(pin_transfer_replacements(&registry, &input).is_err());
    drop(pins);
    assert_eq!(registry.observe(&id).operation.unwrap().lifecycle, RoutineOperationLifecycle::Unproven);
}

#[tokio::test]
async fn completed_mixed_batch_registers_and_pins_once_without_rebaselining_compatible_external_changes() {
    let spec = specification("SOURCE", 1);
    let implementation = program("SOURCE", "PKG", db::ObjectSourceKind::PackageBody,
        "CREATE OR REPLACE PACKAGE BODY \"SOURCE\".PKG AS FUNCTION f(p NUMBER) RETURN NUMBER IS n NUMBER; BEGIN SELECT a.TARGET_N INTO n FROM PENDING_REL a; RETURN n+p+g+Q.g; END f; END PKG;");
    let source = Catalog::new("SOURCE", vec![spec, implementation]);
    let external = program(
        "OWNER",
        "Q",
        db::ObjectSourceKind::Package,
        "CREATE OR REPLACE PACKAGE \"OWNER\".Q AS g NUMBER := 1; END Q;",
    );
    let mut target = Catalog::new("OWNER", vec![external]);
    let mut input = package::normalize_input(OracleRoutinePlanInput {
        compact_sql: false,
        source: snapshot(&source),
        target: snapshot(&target),
        drafts: vec![
            draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Create),
            draft(db::ObjectSourceKind::Package, RoutinePlanAction::Create),
        ],
    })
    .unwrap();
    let tables = vec![PlannedRelation {
        owner: "OWNER".into(),
        name: "PENDING_REL".into(),
        columns: BTreeSet::from(["TARGET_N".into()]),
    }];
    let initial = build_plan_with_tables(
        Some(&source),
        &target,
        &input,
        SourceOrigin::OceanBaseDictionary,
        SourceOrigin::OceanBaseDictionary,
        |_| Ok(None),
        &tables,
    )
    .await;
    assert!(initial.plan.steps.iter().all(|step| step.issues.is_empty()), "{:?}", initial.plan.steps);
    assert!(!initial.plan.ready);
    let public_preview = ordered_transfer_preview(initial.plan.clone(), &initial.order_position);
    assert!(!public_preview.ready);
    assert!(public_preview.steps.iter().all(|step| step.operation.is_none()));
    assert_eq!(
        public_preview.steps.iter().map(|step| step.identity.kind.clone()).collect::<Vec<_>>(),
        vec![db::ObjectSourceKind::Package, db::ObjectSourceKind::PackageBody],
        "The pending preview must show the same dependency order as final admission"
    );
    let manifest = transfer_dependency_manifest(&initial, &tables);
    for (draft, step) in input.drafts.iter_mut().zip(&initial.plan.steps) {
        draft.sql = Some(step.sql.clone());
    }
    target.tables.insert("PENDING_REL".into(), vec!["TARGET_N".into()]);
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({"id":"target","name":"test","db_type":"oceanbase-oracle","host":"localhost","port":2881,"username":"OWNER","password":""})).unwrap();
    for external_changed in [false, true] {
        target.changed_source.store(external_changed, Ordering::SeqCst);
        let actual = build_plan(
            Some(&source),
            &target,
            &input,
            SourceOrigin::OceanBaseDictionary,
            SourceOrigin::OceanBaseDictionary,
            |_| Ok(None),
        )
        .await;
        assert!(
            actual.plan.ready,
            "A compatible external text change still passes fresh analysis: {:?}",
            actual.plan.steps
        );
        let registry = RoutineOperationRegistry::default();
        let (plan, pins) =
            finish_completed_transfer(&registry, &input, actual, &tables, &manifest, vec![], &config, &config).unwrap();
        if external_changed {
            assert!(!plan.ready);
            assert!(pins.is_empty());
            assert!(plan.steps.iter().all(|step| step.operation.is_none()));
            assert!(plan.steps.iter().any(|step| step.issues.iter().any(|issue| issue.message.contains("dependency"))));
        } else {
            assert!(plan.ready);
            assert_eq!(
                plan.steps.iter().map(|step| step.identity.kind.clone()).collect::<Vec<_>>(),
                vec![db::ObjectSourceKind::Package, db::ObjectSourceKind::PackageBody]
            );
            let ids =
                plan.steps.iter().map(|step| step.operation.as_ref().unwrap().operation_id.clone()).collect::<Vec<_>>();
            assert_eq!(pins.len(), 2);
            let binding = registry.binding_for_readback(&ids[1]).unwrap();
            assert_eq!(binding.prerequisite_operation_ids, vec![ids[0].clone()]);
            assert!(binding
                .compare
                .as_ref()
                .unwrap()
                .proofs
                .iter()
                .any(|proof| matches!(proof, CatalogReadProof::Query { sql, .. } if sql.contains("ALL_TAB_COLUMNS"))));
            registry.update_references(&[], &ids).unwrap();
            assert!(
                ids.iter().all(|id| registry.observe(id).operation.is_some()),
                "Backend pins own the batch before any approval event"
            );
            drop(pins);
            assert!(ids.iter().all(|id| registry.observe(id).operation.is_none()));
        }
    }
}

#[tokio::test]
async fn pending_table_plan_keeps_complete_pair_and_order_without_registering_approval() {
    let spec = specification("SOURCE", 1);
    let implementation = program("SOURCE", "PKG", db::ObjectSourceKind::PackageBody,
        "CREATE OR REPLACE PACKAGE BODY \"SOURCE\".PKG AS FUNCTION f(p NUMBER) RETURN NUMBER IS n NUMBER; BEGIN SELECT a.TARGET_N INTO n FROM PENDING_REL a; RETURN n+p+g; END f; END PKG;");
    let source = Catalog::new("SOURCE", vec![spec, implementation]);
    let target = Catalog::new("OWNER", Vec::new());
    let input = package::normalize_input(OracleRoutinePlanInput {
        compact_sql: false,
        source: snapshot(&source),
        target: snapshot(&target),
        drafts: vec![
            draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Create),
            draft(db::ObjectSourceKind::Package, RoutinePlanAction::Create),
        ],
    })
    .unwrap();
    let tables = vec![super::super::references::PlannedRelation {
        owner: "OWNER".into(),
        name: "PENDING_REL".into(),
        columns: BTreeSet::from(["TARGET_N".into()]),
    }];
    let mut built = build_plan_with_tables(
        Some(&source),
        &target,
        &input,
        SourceOrigin::OceanBaseDictionary,
        SourceOrigin::OceanBaseDictionary,
        |_| Ok(None),
        &tables,
    )
    .await;
    assert!(built.plan.steps.iter().all(|step| step.issues.is_empty()), "{:?}", built.plan.steps);
    assert_eq!(built.order, [1, 0]);
    assert!(!built.plan.ready, "A pending table is not an approved existing relation");
    assert_eq!(built.planned_table_dependencies, [BTreeSet::from([0]), BTreeSet::new()]);
    let manifest = transfer_dependency_manifest(&built, &tables);
    assert_eq!(manifest["order"], serde_json::json!([1, 0]));
    assert_eq!(manifest["steps"][0]["pendingTables"], serde_json::json!([{"owner":"OWNER","name":"PENDING_REL"}]));
    assert_eq!(manifest["steps"][1]["pendingTables"], serde_json::json!([]));
    assert!(manifest["steps"][0]["proofGroups"].as_array().unwrap().iter().any(|group| {
        group["use"]["purpose"] == "loginOwner"
            && group["proofs"].as_array().unwrap().iter().any(|proof| {
                proof
                    .get("Query")
                    .and_then(|query| query["sql"].as_str())
                    .is_some_and(|sql| sql.contains("LOGIN_OWNER"))
            })
    }));
    assert!(!manifest.to_string().contains("expected_config"));
    assert!(built.plan.steps[0].sql.contains("SELECT a.TARGET_N INTO n FROM PENDING_REL a"));
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({"id":"target","name":"test","db_type":"oceanbase-oracle","host":"localhost","port":2881,"username":"OWNER","password":""})).unwrap();
    let registry = RoutineOperationRegistry::default();
    built.plan.ready = true;
    let plan = prepare_built_plan(&registry, &input, built, None, &config).unwrap();
    assert!(!plan.ready);
    assert!(plan.steps.iter().all(|step| step.operation.is_none()));
}

#[tokio::test]
async fn preserved_flow_pair_plans_specification_before_body_without_global_incoming_permissions() {
    let spec = program("SOURCE","PKG_FLOW",db::ObjectSourceKind::Package,"CREATE OR REPLACE PACKAGE PKG_FLOW AS g_bias NUMBER := 1; FUNCTION score(p NUMBER) RETURN NUMBER; END PKG_FLOW;");
    let body_source = include_str!("../../../../../dbx-sql-core/tests/fixtures/oracle_package_flow_body.sql");
    let body = program("SOURCE", "PKG_FLOW", db::ObjectSourceKind::PackageBody, body_source);
    let source = Catalog::new("SOURCE", vec![spec, body]);
    let mut target = Catalog::new("OWNER", Vec::new());
    target.deny_incoming = true;
    let mut body_draft = draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Create);
    body_draft.identity.name = "PKG_FLOW".into();
    let mut spec_draft = draft(db::ObjectSourceKind::Package, RoutinePlanAction::Create);
    spec_draft.identity.name = "PKG_FLOW".into();
    let result = build(&source, &target, vec![body_draft, spec_draft]).await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    assert_eq!(result.order, vec![1, 0]);
    assert_eq!(result.plan.steps[0].source_original.as_deref(), Some(body_source));
    for fragment in
        ["IF p < 0 THEN RAISE e_negative", "FOR i IN 1..3 LOOP", "EXCEPTION WHEN VALUE_ERROR", "WHEN OTHERS THEN RAISE"]
    {
        assert!(result.plan.steps[0].sql.contains(fragment));
    }
    assert!(result.plan.steps.iter().all(|step| step.package_impact.as_ref().unwrap().may_initialize));
}

#[tokio::test]
async fn constant_specification_only_is_complete_but_omitted_callable_body_is_explicit() {
    let constant = program(
        "SOURCE",
        "PKG",
        db::ObjectSourceKind::Package,
        "CREATE OR REPLACE PACKAGE \"SOURCE\".PKG AS g NUMBER := 1; END PKG;",
    );
    let source = Catalog::new("SOURCE", vec![constant]);
    let target = Catalog::new("OWNER", Vec::new());
    let result = build(&source, &target, vec![draft(db::ObjectSourceKind::Package, RoutinePlanAction::Create)]).await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    assert!(!result.plan.steps[0].package_impact.as_ref().unwrap().body_pending);
    let source = Catalog::new("SOURCE", vec![specification("SOURCE", 1), body("SOURCE")]);
    let mut spec = draft(db::ObjectSourceKind::Package, RoutinePlanAction::Create);
    assert!(!build(&source, &target, vec![spec.clone()]).await.plan.ready);
    spec.confirm_package_pair = true;
    let result = build(&source, &target, vec![spec]).await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    assert!(result.plan.steps[0].package_impact.as_ref().unwrap().body_pending);
}

#[tokio::test]
async fn body_only_uses_matching_complete_spec_and_target_contract_is_an_explicit_choice() {
    let source = Catalog::new("SOURCE", vec![specification("SOURCE", 1), body("SOURCE")]);
    let mut target = Catalog::new("OWNER", vec![specification("OWNER", 1)]);
    target.deny_incoming = true;
    let body = draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Create);
    assert!(build(&source, &target, vec![body.clone()]).await.plan.ready);
    target.objects[0].source = Some(target.objects[0].source.as_ref().unwrap().replace("DEFAULT 1", "DEFAULT 2"));
    let result = build(&source, &target, vec![body.clone()]).await;
    assert!(!result.plan.ready);
    assert!(result.plan.steps[0].issues.iter().any(|issue| issue.message.contains("specifications differ")));
    let mut explicit = body;
    explicit.package_contract = Some(PackageContractChoice::Target);
    let result = build(&source, &target, vec![explicit]).await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    assert!(result.plan.steps[0].package_impact.as_ref().unwrap().may_initialize);
}

#[tokio::test]
async fn body_only_repairs_an_invalid_body_with_unterminated_dictionary_specification() {
    let mut source_spec = specification("SOURCE", 1);
    source_spec.source = source_spec.source.map(|sql| sql.trim_end_matches(';').to_string());
    let source = Catalog::new("SOURCE", vec![source_spec, body("SOURCE")]);
    let mut target_spec = specification("OWNER", 1);
    target_spec.source = target_spec.source.map(|sql| sql.trim_end_matches(';').to_string());
    let mut invalid_body = body("OWNER");
    invalid_body.version.status = "INVALID".into();
    invalid_body.source = invalid_body.source.map(|sql| sql.replace("RETURN NUMBER IS", "RETURN VARCHAR2 IS"));
    let target = Catalog::new("OWNER", vec![target_spec, invalid_body]);
    let result =
        build(&source, &target, vec![draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Replace)]).await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    assert_eq!(result.plan.steps.len(), 1);
    assert_eq!(result.plan.steps[0].identity.kind, db::ObjectSourceKind::PackageBody);
    assert_eq!(result.plan.steps[0].target_original, target.objects[1].source);
    assert!(result.plan.steps[0].recovery_sql.as_deref().unwrap().contains("RETURN VARCHAR2 IS"));
    let mut wrong = draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Replace);
    wrong.sql = Some(
        source.objects[1]
            .source
            .as_ref()
            .unwrap()
            .replace("\"SOURCE\"", "\"OWNER\"")
            .replace("RETURN NUMBER IS", "RETURN VARCHAR2 IS"),
    );
    let rejected = build(&source, &target, vec![wrong]).await;
    assert!(!rejected.plan.ready);
    assert!(
        rejected.plan.steps[0]
            .issues
            .iter()
            .any(|issue| issue.message.contains("does not match its final specification signature")),
        "{:?}",
        rejected.plan.steps
    );
}

#[tokio::test]
async fn body_only_cannot_create_without_a_target_specification_or_match_a_wrong_public_return_type() {
    let source = Catalog::new("SOURCE", vec![specification("SOURCE", 1), body("SOURCE")]);
    let missing = build(
        &source,
        &Catalog::new("OWNER", Vec::new()),
        vec![draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Create)],
    )
    .await;
    assert!(!missing.plan.ready);
    let mut body = draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Create);
    body.sql = Some(
        source.objects[1]
            .source
            .as_ref()
            .unwrap()
            .replace("\"SOURCE\"", "\"OWNER\"")
            .replace("RETURN NUMBER IS", "RETURN VARCHAR2 IS"),
    );
    let target = Catalog::new("OWNER", vec![specification("OWNER", 1)]);
    assert!(!build(&source, &target, vec![body]).await.plan.ready);
}

#[tokio::test]
async fn specification_replacement_requires_an_explicit_body_action_even_when_old_body_is_valid() {
    let source = Catalog::new("SOURCE", vec![specification("SOURCE", 2)]);
    let target = Catalog::new("OWNER", vec![specification("OWNER", 1), body("OWNER")]);
    let mut spec = draft(db::ObjectSourceKind::Package, RoutinePlanAction::Replace);
    spec.confirm_package_pair = true;
    let result = build(&source, &target, vec![spec.clone()]).await;
    assert!(!result.plan.ready);
    assert!(result.plan.steps[0].issues.iter().any(|issue| issue.message.contains("explicit source body")));
    let mut retained = draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Replace);
    retained.package_body_source = Some(PackageBodySource::Target);
    let result = build(&source, &target, vec![spec, retained]).await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    assert_eq!(result.order, vec![0, 1]);
    assert_eq!(result.plan.steps[1].source_original, None);
    assert_eq!(result.plan.steps[1].target_original, target.objects[1].source);
    assert!(result.plan.steps[1].package_impact.as_ref().unwrap().retains_target_body);
}

#[tokio::test]
async fn specification_with_explicit_body_deletion_records_the_specification_only_scope() {
    let source = Catalog::new("SOURCE", vec![specification("SOURCE", 2)]);
    let target = Catalog::new("OWNER", vec![specification("OWNER", 1), body("OWNER")]);
    let mut spec = draft(db::ObjectSourceKind::Package, RoutinePlanAction::Replace);
    spec.confirm_package_pair = true;
    let result =
        build(&source, &target, vec![spec, draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Delete)]).await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    assert_eq!(result.order, vec![1, 0]);
    assert!(result.plan.steps[0].package_impact.as_ref().unwrap().body_pending);
}

#[tokio::test]
async fn retained_body_is_checked_against_new_specification_not_its_old_valid_status() {
    let mut new_spec = specification("SOURCE", 2);
    new_spec.source = Some(new_spec.source.unwrap().replace("RETURN NUMBER", "RETURN VARCHAR2"));
    let source = Catalog::new("SOURCE", vec![new_spec]);
    let target = Catalog::new("OWNER", vec![specification("OWNER", 1), body("OWNER")]);
    let mut spec = draft(db::ObjectSourceKind::Package, RoutinePlanAction::Replace);
    spec.confirm_package_pair = true;
    let mut retained = draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Replace);
    retained.package_body_source = Some(PackageBodySource::Target);
    let result = build(&source, &target, vec![spec, retained]).await;
    assert!(!result.plan.ready);
    assert!(result.plan.steps[1].issues.iter().any(|issue| issue.message.contains("final specification")));
}

#[tokio::test]
async fn whole_package_delete_collapses_body_drop_and_never_confirms_away_external_callers() {
    let source = Catalog::new("SOURCE", Vec::new());
    let mut target = Catalog::new("OWNER", vec![specification("OWNER", 1), body("OWNER")]);
    target.incoming.insert(
        "PKG".into(),
        vec![RoutineDependency {
            owner: "OWNER".into(),
            name: "PKG".into(),
            kind: "PACKAGE BODY".into(),
            database_link: None,
            dependency_type: "HARD".into(),
        }],
    );
    let mut spec = draft(db::ObjectSourceKind::Package, RoutinePlanAction::Delete);
    spec.confirm_package_pair = true;
    let result = build(
        &source,
        &target,
        vec![spec.clone(), draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Delete)],
    )
    .await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    assert_eq!(result.plan.steps.len(), 1);
    assert_eq!(result.plan.steps[0].sql, "DROP PACKAGE \"OWNER\".\"PKG\";");
    assert!(result.plan.steps[0].package_impact.as_ref().unwrap().implicit_companion_delete);
    target.incoming.get_mut("PKG").unwrap().push(RoutineDependency {
        owner: "OUTSIDE".into(),
        name: "CALLER".into(),
        kind: "FUNCTION".into(),
        database_link: None,
        dependency_type: "HARD".into(),
    });
    assert!(!build(&source, &target, vec![spec]).await.plan.ready);
}

#[tokio::test]
async fn body_delete_keeps_the_specification_without_requiring_global_caller_visibility() {
    let source = Catalog::new("SOURCE", vec![specification("SOURCE", 1)]);
    let mut target = Catalog::new("OWNER", vec![specification("OWNER", 1), body("OWNER")]);
    target.deny_incoming = true;
    let result =
        build(&source, &target, vec![draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Delete)]).await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    assert_eq!(result.plan.steps[0].sql, "DROP PACKAGE BODY \"OWNER\".\"PKG\";");
    assert!(result.preflights[0].as_ref().unwrap().incoming.is_none());
}

#[tokio::test]
async fn target_grants_are_backed_up_and_rechecked_without_copying_source_privileges() {
    let source = Catalog::new("SOURCE", Vec::new());
    let mut target = Catalog::new("OWNER", vec![specification("OWNER", 1), body("OWNER")]);
    target.grants.push(PackageGrant {
        grantor: "OWNER".into(),
        grantee: "READER".into(),
        privilege: "EXECUTE".into(),
        grantable: true,
    });
    let mut spec = draft(db::ObjectSourceKind::Package, RoutinePlanAction::Delete);
    spec.confirm_package_pair = true;
    let result = build(&source, &target, vec![spec]).await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    let grants = result.plan.steps[0].package_impact.as_ref().unwrap().grants.as_ref().unwrap();
    assert!(grants.complete);
    assert_eq!(grants.grants, target.grants);
    let preflight = result.preflights[0].as_ref().unwrap();
    verify_compare_preflight(
        None::<&Catalog>,
        &target,
        &endpoint("OWNER"),
        preflight,
        SourceOrigin::OceanBaseDictionary,
    )
    .await
    .unwrap();
    target.changed_grants.store(true, Ordering::SeqCst);
    assert!(verify_compare_preflight(
        None::<&Catalog>,
        &target,
        &endpoint("OWNER"),
        preflight,
        SourceOrigin::OceanBaseDictionary
    )
    .await
    .is_err());
}

#[tokio::test]
async fn complete_pair_preflight_rejects_companion_only_edits_with_unchanged_specification_version() {
    let source = Catalog::new("SOURCE", vec![specification("SOURCE", 2)]);
    let target = Catalog::new("OWNER", vec![specification("OWNER", 1), body("OWNER")]);
    let mut spec = draft(db::ObjectSourceKind::Package, RoutinePlanAction::Replace);
    spec.confirm_package_pair = true;
    let mut retained = draft(db::ObjectSourceKind::PackageBody, RoutinePlanAction::Replace);
    retained.package_body_source = Some(PackageBodySource::Target);
    let result = build(&source, &target, vec![spec, retained]).await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    target.changed_body.store(true, Ordering::SeqCst);
    assert!(verify_compare_preflight(
        None::<&Catalog>,
        &target,
        &endpoint("OWNER"),
        result.preflights[0].as_ref().unwrap(),
        SourceOrigin::OceanBaseDictionary
    )
    .await
    .is_err());
}

#[tokio::test]
async fn unreadable_grants_are_an_explicit_recovery_gap_not_a_complete_empty_backup() {
    let source = Catalog::new("SOURCE", Vec::new());
    let mut target = Catalog::new("OWNER", vec![specification("OWNER", 1), body("OWNER")]);
    target.deny_grants = true;
    let mut spec = draft(db::ObjectSourceKind::Package, RoutinePlanAction::Delete);
    spec.confirm_package_pair = true;
    let result = build(&source, &target, vec![spec]).await;
    assert!(result.plan.ready, "{:?}", result.plan.steps);
    assert!(!result.plan.steps[0].recovery_complete);
    let grants = result.plan.steps[0].package_impact.as_ref().unwrap().grants.as_ref().unwrap();
    assert!(!grants.complete && grants.issue.is_some());
}
