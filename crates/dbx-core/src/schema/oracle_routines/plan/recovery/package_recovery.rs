use super::*;

fn acknowledged_record(registry: &RoutineOperationRegistry, id: &str) -> Result<RoutineOperationRecord, String> {
    let mut record = registry.observe(id).operation.ok_or("Original package operation is unavailable")?;
    let binding = registry.binding_for_readback(id)?;
    record.readback = Some(registry.recovery_post_state(id)?);
    check_recovery_receipt(&record, &binding.goal)?;
    Ok(record)
}

fn snapshot(endpoint: &RoutineEndpoint, pair: &ExpectedPackagePair) -> RoutineSnapshot {
    RoutineSnapshot {
        endpoint: endpoint.clone(),
        state: RoutineReadState::Complete,
        enumeration_complete: true,
        objects: [&pair.specification, &pair.body]
            .into_iter()
            .filter_map(|expected| match expected {
                ExpectedRoutine::Present(object) => Some(object.clone()),
                ExpectedRoutine::Absent(_) => None,
            })
            .collect(),
        issues: Vec::new(),
    }
}

fn same_definition(before: &ExpectedRoutine, current: &ExpectedRoutine) -> bool {
    match (before, current) {
        (ExpectedRoutine::Absent(left), ExpectedRoutine::Absent(right)) => left == right,
        (ExpectedRoutine::Present(left), ExpectedRoutine::Present(right)) => {
            left.version.identity == right.version.identity
                && left.version.status == right.version.status
                && left.source == right.source
                && left.source_origin == right.source_origin
        }
        _ => false,
    }
}

fn draft(before: &ExpectedRoutine, current: &ExpectedRoutine) -> Option<RoutinePlanDraft> {
    let action = match (before, current) {
        (ExpectedRoutine::Absent(_), ExpectedRoutine::Absent(_)) => return None,
        (ExpectedRoutine::Absent(_), ExpectedRoutine::Present(_)) => RoutinePlanAction::Delete,
        (ExpectedRoutine::Present(_), ExpectedRoutine::Absent(_)) => RoutinePlanAction::Create,
        _ => RoutinePlanAction::Replace,
    };
    Some(RoutinePlanDraft {
        identity: before.identity().clone(),
        action,
        source_name: None,
        sql: None,
        baseline_operation_id: None,
        supersedes_operation_id: None,
        package_body_source: None,
        package_contract: None,
        confirm_package_pair: true,
    })
}

pub(in crate::schema::oracle_routines) async fn prepare_package_recovery(
    registry: &RoutineOperationRegistry,
    operation_id: &str,
    catalog: &impl RoutineCatalog,
    config: &ConnectionConfig,
    origin: SourceOrigin,
) -> Result<OracleRoutinePlan, String> {
    let _pin = registry.pin(operation_id)?;
    let original = acknowledged_record(registry, operation_id)?;
    let binding = registry.binding_for_readback(operation_id)?;
    let backup = binding
        .compare
        .as_ref()
        .and_then(|compare| compare.package.as_ref())
        .ok_or("The original package write has no frozen pair recovery material")?;
    let mut current = ExpectedPackagePair::from_readback(original.readback.as_ref().unwrap())?;
    let mut grants = backup.grants.clone();
    for related_id in &binding.package_effect_operation_ids {
        let related_binding = registry.binding_for_readback(related_id)?;
        if related_binding.identity.owner != binding.identity.owner
            || related_binding.identity.name != binding.identity.name
        {
            continue;
        }
        if related_binding.target != binding.target || related_binding.expected_config != binding.expected_config {
            return Err("Related package recovery material belongs to another target".into());
        }
        if related_binding.identity.kind == db::ObjectSourceKind::Package && grants.is_none() {
            grants = related_binding
                .compare
                .as_ref()
                .and_then(|compare| compare.package.as_ref())
                .and_then(|package| package.grants.clone());
        }
        let related = registry.observe(related_id).operation.ok_or("A related package operation is unavailable")?;
        if related.lifecycle == RoutineOperationLifecycle::Prepared
            || (related.lifecycle == RoutineOperationLifecycle::Terminal && !related.dispatched)
        {
            continue;
        }
        let related = acknowledged_record(registry, related_id)?;
        if binding.prerequisite_operation_ids.contains(related_id) {
            continue;
        }
        if !related_binding.prerequisite_operation_ids.iter().any(|id| id == operation_id) {
            return Err("The related package write has no proven execution order for recovery".into());
        }
        let post = related.readback.as_ref().unwrap();
        let companion =
            post.package_companion.as_deref().ok_or("The related package write has no complete pair receipt")?;
        let expected = if companion.identity.kind == db::ObjectSourceKind::Package {
            &current.specification
        } else {
            &current.body
        };
        if !package::definition_identity_matches(expected, companion) {
            return Err(
                "The related package write cannot explain a changed definition, identity or actual origin".into()
            );
        }
        current = ExpectedPackagePair::from_readback(post)?;
    }
    package::verify_pair(catalog, &original.target, &current, origin).await?;
    let before = &backup.pair;
    let restore_spec = !same_definition(&before.specification, &current.specification);
    if matches!(&before.specification, ExpectedRoutine::Absent(_))
        && matches!(&before.body, ExpectedRoutine::Present(_))
    {
        let mut steps = Vec::new();
        for (saved, actual) in [(&before.specification, &current.specification), (&before.body, &current.body)] {
            let Some(mut proposed) = draft(saved, actual) else { continue };
            if saved.identity().kind == db::ObjectSourceKind::PackageBody && restore_spec {
                proposed.action = RoutinePlanAction::Create;
            }
            let mut step = OracleRoutinePlanStep {
                identity: saved.identity().clone(),
                action: proposed.action,
                sql: String::new(),
                source_original: match saved { ExpectedRoutine::Present(object) => object.source.clone(), _ => None },
                target_original: match actual { ExpectedRoutine::Present(object) => object.source.clone(), _ => None },
                recovery_sql: None,
                recovery_complete: false,
                references: Vec::new(),
                incoming_callers: Vec::new(),
                issues: vec![problem("The original package had a body without a specification. Retain its complete definition and review recovery manually; dropping the specification also deletes the current body, and recreating the original orphan is not a verified package recovery")],
                operation: None,
                package_impact: None,
            };
            match saved {
                ExpectedRoutine::Absent(identity) => step.sql = drop_sql(identity),
                ExpectedRoutine::Present(object) => {
                    match adapted(
                        &original.target,
                        saved.identity(),
                        &saved.identity().owner,
                        object.source.as_deref().ok_or("Original complete package body is unavailable")?,
                        proposed.action == RoutinePlanAction::Replace,
                    ) {
                        Ok(sql) => step.sql = sql,
                        Err(error) => step.issues.push(problem(error)),
                    }
                }
            }
            steps.push(step);
        }
        return Ok(OracleRoutinePlan { target: original.target, steps, ready: false });
    }
    let mut drafts = Vec::new();
    if restore_spec {
        if let Some(step) = draft(&before.specification, &current.specification) {
            drafts.push(step);
        }
    }
    if (!matches!(&before.specification, ExpectedRoutine::Absent(_)) || !restore_spec)
        && (restore_spec || !same_definition(&before.body, &current.body))
    {
        if let Some(step) = draft(&before.body, &current.body) {
            drafts.push(step);
        }
    }
    if drafts.is_empty() {
        return Err("The recorded package pair already has its backed-up definitions; no recovery DDL is needed".into());
    }
    let mut target = snapshot(&original.target, &current);
    for object in &mut target.objects {
        object.dependencies = dependencies(catalog, &object.version.identity).await?;
        object.dependencies_complete = true;
    }
    let input = package::normalize_input(OracleRoutinePlanInput {
        compact_sql: false,
        source: snapshot(&original.target, before),
        target,
        drafts,
    })?;
    let mut built = build_plan(None::<&LiveCatalog<'_>>, catalog, &input, origin, origin, |_| Ok(None)).await;
    if restore_spec {
        let (observed, proofs) = package::read_grants(catalog, before.specification.identity()).await;
        let issue = if !observed.complete {
            Some("Current package grants cannot be completely verified; keep the recovery drafts and refresh with sufficient visibility")
        } else if matches!(&before.specification, ExpectedRoutine::Absent(_)) {
            (!observed.grants.is_empty())
                .then_some("New grants exist on the deployed package; recovery deletion would lose them")
        } else {
            match &grants {
                Some(grants) if grants.complete && grants.grants == observed.grants => None,
                Some(grants) if grants.complete => {
                    Some(if matches!(&current.specification, ExpectedRoutine::Absent(_)) {
                        "The dropped package's original grants are not restored by recreating definitions; restore and review those grants explicitly before claiming complete recovery"
                    } else {
                        "Package grants changed after the original approval; retain the drafts and review the target instead"
                    })
                }
                _ => Some(
                    "Original package grants were not completely backed up; complete one-click recovery is unavailable",
                ),
            }
        };
        for (step, preflight) in built.plan.steps.iter_mut().zip(&mut built.preflights) {
            if let Some(preflight) = preflight {
                preflight.proofs.extend(proofs.clone());
            }
            if let Some(issue) = issue {
                step.issues.push(problem(issue));
                step.recovery_complete = false;
            }
            if let Some(impact) = &mut step.package_impact {
                if step.identity.kind == db::ObjectSourceKind::Package {
                    impact.grants = grants.clone().or_else(|| Some(observed.clone()));
                }
            }
        }
        if issue.is_some() {
            built.plan.ready = false;
        }
    }
    prepare_built_plan(registry, &input, built, None, config)
}
