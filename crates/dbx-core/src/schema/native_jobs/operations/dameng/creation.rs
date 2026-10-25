use super::*;
use dbx_sql::native_job_changes::{native_job_dameng_catalog_id, native_job_dameng_name_queries};

pub(super) async fn lookup(
    session: &mut impl NativeJobMutationSession,
    name: &str,
) -> Result<Option<NativeJobRow>, &'static str> {
    for query in native_job_dameng_name_queries(name)? {
        let read = session.query(query).await.and_then(|raw| {
            decode_query_result(NativeJobEngine::Dameng, raw).and_then(|result| rows_from_result(result, 1, |_| Ok(())))
        });
        match read {
            Ok(NativeJobMetadata::Empty) => return Ok(None),
            Ok(NativeJobMetadata::Available { mut value }) if value.len() == 1 => {
                let row = value.pop().expect("one job");
                if !row.get("NAME").and_then(Value::as_str).is_some_and(|actual| actual.eq_ignore_ascii_case(name))
                    || row.get("DBX_JOB_ID").and_then(native_job_dameng_catalog_id).is_none()
                    || row.get("USERNAME").and_then(Value::as_str).is_none()
                {
                    return Err("native_job_identity_unverified");
                }
                return Ok(Some(row));
            }
            Err(error) if error.permits_fallback() => continue,
            _ => return Err("native_job_creation_visibility_unverified"),
        }
    }
    Err("native_job_creation_visibility_unverified")
}

fn initial_matches(
    details: &NativeJobDetails,
    plan: &NativeJobDamengCreatePlan,
    operators: &BTreeMap<&'static str, Option<i64>>,
    user: &str,
) -> bool {
    let Some(row) = row(details) else { return false };
    matches!(details.consistency, NativeJobMetadata::Available { .. })
        && matches!(details.native_identity, NativeJobMetadata::Available { .. })
        && row.get("USERNAME").and_then(Value::as_str) == Some(user)
        && super::super::super::details::boolean(row.get("ENABLE")) == Some(false)
        && fields_match(details, &plan.definition_fields)
        && operators.iter().all(|(column, expected)| match expected {
            Some(id) => values::field_matches(column, row.get(*column), &serde_json::json!(id)),
            None => row.get(*column).is_some_and(|value| {
                value.is_null() || super::super::super::details::integer(Some(value)).is_some_and(|id| id <= 0)
            }),
        })
        && [&details.steps, &details.schedules].into_iter().all(|part| {
            matches!(part, NativeJobMetadata::Empty)
                || matches!(part, NativeJobMetadata::Available {value} if value.is_empty())
        })
}

pub(in super::super) async fn run_create(
    state: &AppState,
    execution: &PreparedExecution,
    id: &str,
    cancel: &CancellationToken,
    session: &mut impl NativeJobMutationSession,
    dispatched: &mut bool,
) -> Result<NativeJobOperationOutcome, Failure> {
    let PreparedAction::DamengCreate { definition, plan } = &execution.action else { unreachable!() };
    session.begin_configure(id).await.map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
    check_dispatch(state, execution, cancel, false).await?;
    if lookup(session, &definition.name)
        .await
        .map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?
        .is_some()
    {
        return Err(("native_job_creation_target_not_absent", NativeJobOperationOutcome::NotApplied));
    }
    let operators = resolve_operators(session, &plan.configuration)
        .await
        .map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
    check_dispatch(state, execution, cancel, false).await?;
    let operations = state.native_jobs.operations();
    operations.edit(id, |status| {
        status.state = NativeJobOperationState::Running;
        status.steps[0].state = NativeJobStepState::Dispatching;
    });
    *dispatched = true;
    let receipt = session.execute(&plan.steps[0]).await;
    scheduler::mark(operations, id, 0, &receipt);
    match receipt.outcome {
        NativeJobDispatchOutcome::NotStarted => {
            return Err(("native_job_step_not_applied", NativeJobOperationOutcome::NotApplied))
        }
        // Never adopt a same-name job after a lost CREATE receipt or send CONFIG/ENABLE to it.
        NativeJobDispatchOutcome::Unknown => {
            return Err(("native_job_creation_outcome_unknown", NativeJobOperationOutcome::Unknown))
        }
        NativeJobDispatchOutcome::Applied => {}
    }
    let created = lookup(session, &definition.name)
        .await
        .map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?
        .ok_or(("native_job_created_definition_unverified", NativeJobOperationOutcome::Partial))?;
    let target = NativeJobRef::DamengNative {
        scope: execution.binding.context.scope.clone(),
        job_id: created["DBX_JOB_ID"]
            .as_str()
            .ok_or(("native_job_identity_unverified", NativeJobOperationOutcome::Partial))?
            .into(),
        name: created["NAME"].as_str().expect("validated native name").into(),
    };
    if created["USERNAME"].as_str() != Some(execution.binding.context.session_user.as_str()) {
        return Err(("native_job_created_definition_unverified", NativeJobOperationOutcome::Partial));
    }
    operations.edit(id, |status| status.target = Some(target.clone()));
    let before = session.read(&target).await.map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?;
    let NativeJobMetadata::Available { value: identity } = &before.native_identity else {
        return Err(("native_job_created_definition_unverified", NativeJobOperationOutcome::Partial));
    };
    if !matches!(before.consistency, NativeJobMetadata::Available { .. }) {
        return Err(("native_job_created_definition_unverified", NativeJobOperationOutcome::Partial));
    }
    let origin_key = native_origin_key(&execution.binding, &target, identity);
    operations.edit(id, |status| status.observed_identity = Some(identity.clone()));
    operations.configuration_dispatched(&origin_key);
    if !initial_matches(&before, plan, &operators, &execution.binding.context.session_user) {
        return Err(("native_job_created_definition_unverified", NativeJobOperationOutcome::Partial));
    }
    let mutation = NativeJobMutation {
        target: target.clone(),
        baseline: before.snapshot.revision.clone(),
        change: NativeJobChange::ConfigureDameng { configuration: plan.remaining.clone() },
    };
    let configured = native_job_mutation_plan(NativeJobEngine::Dameng, &mutation, &before)
        .map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?;
    run_steps(
        state,
        execution,
        id,
        cancel,
        session,
        dispatched,
        ConfigurationExecution { target: &target, plan: &configured, origin_key: &origin_key, offset: 1, before },
    )
    .await
}
