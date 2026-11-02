use super::*;

mod package_recovery;
pub(in crate::schema::oracle_routines) use package_recovery::prepare_package_recovery;

/// Recovery is a new, explicitly approved DDL operation against the original
/// operation's recorded post-state. It never unlocks an unknown request.
pub async fn prepare_oracle_routine_recovery_core(
    state: &AppState,
    operation_id: &str,
) -> Result<OracleRoutinePlan, String> {
    let _original_pin = state.routine_operations.pin(operation_id)?;
    let mut original = state
        .routine_operations
        .observe(operation_id)
        .operation
        .ok_or("Original operation is unavailable; recovery cannot establish its termination")?;
    if original.lifecycle != RoutineOperationLifecycle::Terminal || !original.dispatched {
        return Err("Recovery requires the original write's terminal evidence; only observe its original ID".into());
    }
    let binding = state.routine_operations.binding_for_readback(operation_id)?;
    if package::is_package(&original.identity.kind) {
        let config = checked_endpoint(state, &original.target).await?;
        let catalog = LiveCatalog { state, endpoint: &original.target, config: &config };
        let (_, origin) = routine_source_origin(&config)?;
        return prepare_package_recovery(&state.routine_operations, operation_id, &catalog, &config, origin).await;
    }
    original.readback = Some(state.routine_operations.recovery_post_state(operation_id)?);
    check_recovery_receipt(&original, &binding.goal)?;
    let before =
        binding.compare.as_ref().ok_or("This operation has no complete comparison recovery material")?.target.clone();
    let current = correction_baseline(original.clone(), &original.target, &original.identity)?;
    let config = checked_endpoint(state, &original.target).await?;
    let catalog = LiveCatalog { state, endpoint: &original.target, config: &config };
    let (_, origin) = routine_source_origin(&config)?;
    let mut result = recovery_plan(&catalog, &original.target, &original.identity, before, current, origin).await;
    if result.plan.ready {
        let step = &mut result.plan.steps[0];
        step.operation = Some(state.routine_operations.prepare_replacing(
            RoutineWriteBinding {
                target: original.target,
                identity: step.identity.clone(),
                sql: step.sql.clone(),
                goal: if step.action == RoutinePlanAction::Delete {
                    RoutineReadbackGoal::Absent
                } else {
                    RoutineReadbackGoal::Definition { sql: step.sql.clone() }
                },
                expected_config: config,
                require_absent: step.action == RoutinePlanAction::Create,
                compare: result.preflight.take(),
                prerequisite_operation_ids: Vec::new(),
                package_effect_operation_ids: Vec::new(),
            },
            None,
        )?);
    }
    Ok(result.plan)
}

fn check_recovery_receipt(original: &RoutineOperationRecord, goal: &RoutineReadbackGoal) -> Result<(), String> {
    let recorded_post_matches = original.readback.as_ref().is_some_and(|readback| match goal {
        RoutineReadbackGoal::Definition { .. } => readback.definition_matches == Some(true),
        RoutineReadbackGoal::Absent => {
            readback.state == RoutineReadbackState::Verified && readback.exists == Some(false)
        }
        RoutineReadbackGoal::Inspect => false,
    });
    if original.lifecycle != RoutineOperationLifecycle::Terminal
        || !original.dispatched
        || !original.acknowledged
        || !recorded_post_matches
    {
        return Err("Recovery cannot attribute the recorded contents to an acknowledged matching write; refresh and review the target instead".into());
    }
    Ok(())
}

struct RecoveryPlan {
    plan: OracleRoutinePlan,
    preflight: Option<ComparePreflight>,
}

async fn recovery_plan(
    catalog: &impl RoutineCatalog,
    endpoint: &RoutineEndpoint,
    identity: &RoutineIdentity,
    before: ExpectedRoutine,
    mut current: ExpectedRoutine,
    origin: SourceOrigin,
) -> RecoveryPlan {
    let action = match (&before, &current) {
        (ExpectedRoutine::Absent(_), _) => RoutinePlanAction::Delete,
        (ExpectedRoutine::Present(_), ExpectedRoutine::Absent(_)) => RoutinePlanAction::Create,
        _ => RoutinePlanAction::Replace,
    };
    let mut step = OracleRoutinePlanStep {
        identity: identity.clone(),
        action,
        sql: String::new(),
        source_original: match &before {
            ExpectedRoutine::Present(object) => object.source.clone(),
            _ => None,
        },
        target_original: match &current {
            ExpectedRoutine::Present(object) => object.source.clone(),
            _ => None,
        },
        recovery_sql: None,
        recovery_complete: action != RoutinePlanAction::Create,
        references: Vec::new(),
        incoming_callers: Vec::new(),
        issues: Vec::new(),
        operation: None,
        package_impact: None,
    };
    let mut preflight = None;
    let prepared: Result<(), String> = async {
        step.sql = match &before {
            ExpectedRoutine::Absent(_) => drop_sql(identity),
            ExpectedRoutine::Present(object) => adapted(endpoint, identity, &identity.owner, object.source.as_deref().ok_or("Original complete definition is unavailable")?, action == RoutinePlanAction::Replace)?,
        };
        if action == RoutinePlanAction::Create {
            return Err("The deleted routine's definition is available to copy, but grants and other deleted state were not captured; complete one-click recovery is unavailable".into());
        }
        verify_expected(catalog, endpoint, &current, origin).await?;
        if let ExpectedRoutine::Present(object) = &mut current {
            object.dependencies = dependencies(catalog, identity).await?;
            object.dependencies_complete = true;
        }
        let incoming = incoming_dependencies(catalog, identity).await?;
        step.incoming_callers = incoming.clone();
        if action == RoutinePlanAction::Delete && incoming.iter().any(|caller| caller.owner != identity.owner || caller.name != identity.name || caller.kind != kind_name(&identity.kind)) {
            return Err("New callers depend on the deployed routine; remove those dependencies before recovery deletion".into());
        }
        let proofs = if action == RoutinePlanAction::Replace {
            let analysis = analyze_oracle_routine_draft(ddl_input(endpoint, identity, step.sql.clone()));
            if !analysis.complete { step.issues.extend(analysis.issues); return Ok(()); }
            let selected = vec![SelectedFinalDraft { identity: identity.clone(), analysis: Some(analysis) }];
            let resolution = resolve_draft(catalog, endpoint, &selected, 0).await;
            step.references = resolution.references;
            step.issues.extend(resolution.issues);
            resolution.proofs
        } else { Vec::new() };
        preflight = Some(ComparePreflight { source: None, target: current.clone(), proofs, incoming: Some(incoming), selected: vec![identity.clone()], package:None });
        Ok(())
    }.await;
    if let Err(error) = prepared {
        step.issues.push(problem(error));
    }
    let ready = step.issues.is_empty() && preflight.is_some();
    RecoveryPlan { plan: OracleRoutinePlan { target: endpoint.clone(), steps: vec![step], ready }, preflight }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{endpoint, object, Catalog};
    use super::*;

    #[tokio::test]
    async fn recovery_checks_the_recorded_post_state_and_refuses_third_party_source_changes() {
        let before = object("OWNER", "F", "1");
        let after = object("OWNER", "F", "2");
        let catalog = Catalog::new("OWNER", vec![after.clone()]);
        let result = recovery_plan(
            &catalog,
            &endpoint("OWNER"),
            &before.version.identity,
            ExpectedRoutine::Present(before.clone()),
            ExpectedRoutine::Present(after.clone()),
            SourceOrigin::OceanBaseDictionary,
        )
        .await;
        assert!(result.plan.ready);
        assert!(result.plan.steps[0].sql.contains("RETURN 1;"));
        catalog.changed_source.store(true, std::sync::atomic::Ordering::SeqCst);
        let result = recovery_plan(
            &catalog,
            &endpoint("OWNER"),
            &before.version.identity,
            ExpectedRoutine::Present(before.clone()),
            ExpectedRoutine::Present(after),
            SourceOrigin::OceanBaseDictionary,
        )
        .await;
        assert!(!result.plan.ready);
        assert!(!result.plan.steps[0].issues.is_empty());
    }

    #[tokio::test]
    async fn deleted_grants_are_not_invented_and_original_definition_stays_copyable() {
        let before = object("OWNER", "F", "1");
        let catalog = Catalog::new("OWNER", Vec::new());
        let result = recovery_plan(
            &catalog,
            &endpoint("OWNER"),
            &before.version.identity,
            ExpectedRoutine::Present(before.clone()),
            ExpectedRoutine::Absent(before.version.identity.clone()),
            SourceOrigin::OceanBaseDictionary,
        )
        .await;
        assert!(!result.plan.ready);
        assert!(!result.plan.steps[0].recovery_complete);
        validate_oracle_routine_target_definition(
            ddl_input(&endpoint("OWNER"), &before.version.identity, result.plan.steps[0].sql.clone()),
            Some(false),
        )
        .unwrap();
        assert!(result.plan.steps[0].issues[0].message.contains("grants"));
    }

    #[test]
    fn rejected_or_unknown_writes_cannot_claim_a_competing_object_for_recovery() {
        let identity = object("OWNER", "F", "1").version.identity;
        let goal = RoutineReadbackGoal::Definition { sql: "approved".into() };
        let mut original = RoutineOperationRecord {
            operation_id: "original".into(),
            target: endpoint("OWNER"),
            identity: identity.clone(),
            lifecycle: RoutineOperationLifecycle::Terminal,
            dispatched: true,
            acknowledged: true,
            error: None,
            readback: Some(RoutineReadback {
                identity,
                state: RoutineReadbackState::Invalid,
                exists: Some(true),
                version: None,
                source: Some("approved".into()),
                source_origin: None,
                package_companion: None,
                definition_matches: Some(true),
                compiler_messages: Vec::new(),
                issues: Vec::new(),
            }),
        };
        check_recovery_receipt(&original, &goal).unwrap();
        original.acknowledged = false;
        assert!(check_recovery_receipt(&original, &goal).is_err());
        original.acknowledged = true;
        original.lifecycle = RoutineOperationLifecycle::Unproven;
        assert!(check_recovery_receipt(&original, &goal).is_err());
        original.lifecycle = RoutineOperationLifecycle::Terminal;
        original.readback.as_mut().unwrap().definition_matches = Some(false);
        assert!(check_recovery_receipt(&original, &goal).is_err());
    }
}
