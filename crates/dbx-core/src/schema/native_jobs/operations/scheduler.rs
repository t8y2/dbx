use super::*;

pub(super) mod transition;

pub(super) fn validate_namespace(
    binding: &super::super::service::BoundContext,
    definition: &NativeJobSchedulerCreate,
) -> Result<(), &'static str> {
    if binding.context.engine == NativeJobEngine::OceanbaseOracle {
        // BP7 treats a qualified CREATE_JOB argument as a literal name, not another owner's job.
        if definition.owner != binding.context.session_user {
            return Err("native_job_create_owner_mapping_unverified");
        }
        for reference in [&definition.program, &definition.schedule].into_iter().flatten() {
            if reference.owner != binding.context.session_user {
                return Err("native_job_reference_owner_mapping_unverified");
            }
        }
    }
    Ok(())
}

pub(super) fn require_absent(details: &NativeJobDetails, user: &str) -> Result<(), &'static str> {
    if !matches!(details.snapshot.definition, NativeJobMetadata::Empty)
        || !matches!(details.native_identity, NativeJobMetadata::Empty)
    {
        return Err("native_job_creation_target_not_absent");
    }
    let own = matches!(&details.snapshot.job_ref, NativeJobRef::Scheduler { owner, .. } if owner == user);
    if !details.sources.get("definition").is_some_and(|source| {
        source.coverage == Some(NativeJobCatalogCoverage::Database)
            || (own
                && matches!(
                    source.coverage,
                    Some(NativeJobCatalogCoverage::CurrentUser | NativeJobCatalogCoverage::Accessible)
                ))
    }) {
        return Err("native_job_creation_visibility_unverified");
    }
    Ok(())
}

fn nullable_text(actual: Option<&Value>, expected: &str) -> bool {
    actual.and_then(Value::as_str) == Some(expected) || (expected.is_empty() && actual == Some(&Value::Null))
}

pub(super) fn same_timestamp(actual: Option<&Value>, expected: &str) -> bool {
    let Some(actual) = actual.and_then(Value::as_str) else { return false };
    let parse = |value: &str| {
        let normalized = value.trim().replacen(' ', "T", 1).replace(" +", "+").replace(" -", "-");
        let offset = regex::Regex::new(r"([+-])(\d):(\d{2})$").unwrap();
        let normalized = offset.replace(&normalized, "${1}0${2}:${3}");
        chrono::DateTime::parse_from_rfc3339(&normalized).ok()
    };
    match (parse(actual), parse(expected)) {
        (Some(actual), Some(expected)) => actual == expected,
        _ => false,
    }
}

fn reference_matches(row: &NativeJobRow, prefix: &str, reference: &NativeJobObjectReference) -> bool {
    row.get(&format!("{prefix}_OWNER")).and_then(Value::as_str) == Some(reference.owner.as_str())
        && row.get(&format!("{prefix}_NAME")).and_then(Value::as_str) == Some(reference.name.as_str())
}

fn verify_initial(details: &NativeJobDetails, target: &NativeJobRef, definition: &NativeJobSchedulerCreate) -> bool {
    if &details.snapshot.job_ref != target
        || !matches!(details.consistency, NativeJobMetadata::Available { .. })
        || !matches!(details.native_identity, NativeJobMetadata::Available { .. })
    {
        return false;
    }
    let Some(row) = row(details) else { return false };
    if super::super::details::boolean(row.get("ENABLED")) != Some(false)
        || super::super::details::boolean(row.get("AUTO_DROP")) != Some(definition.auto_drop)
    {
        return false;
    }
    if let Some(program) = &definition.program {
        if !reference_matches(row, "PROGRAM", program) {
            return false;
        }
    } else if row
        .get("JOB_TYPE")
        .and_then(Value::as_str)
        .zip(definition.job_type.as_deref())
        .is_none_or(|(actual, expected)| !actual.eq_ignore_ascii_case(expected))
        || !definition.job_action.as_deref().is_some_and(|expected| nullable_text(row.get("JOB_ACTION"), expected))
        || super::super::details::integer(row.get("NUMBER_OF_ARGUMENTS")) != Some(definition.number_of_arguments as i64)
    {
        return false;
    }
    if let Some(schedule) = &definition.schedule {
        if !reference_matches(row, "SCHEDULE", schedule) {
            return false;
        }
    } else {
        if definition.start_date.as_deref().is_some_and(|expected| !same_timestamp(row.get("START_DATE"), expected))
            || definition.end_date.as_deref().is_some_and(|expected| !same_timestamp(row.get("END_DATE"), expected))
            || definition
                .repeat_interval
                .as_deref()
                .is_some_and(|expected| !nullable_text(row.get("REPEAT_INTERVAL"), expected))
            || definition
                .event_condition
                .as_deref()
                .is_some_and(|expected| !nullable_text(row.get("EVENT_CONDITION"), expected))
        {
            return false;
        }
        match &definition.event_source {
            Some(NativeJobEventSource::Queue { owner, name, agent }) => {
                if row.get("EVENT_QUEUE_OWNER").and_then(Value::as_str) != Some(owner.as_str())
                    || row.get("EVENT_QUEUE_NAME").and_then(Value::as_str) != Some(name.as_str())
                    || agent.as_deref().is_some_and(|agent| !nullable_text(row.get("EVENT_QUEUE_AGENT"), agent))
                {
                    return false;
                }
            }
            Some(NativeJobEventSource::FileWatcher { reference })
                if !reference_matches(row, "FILE_WATCHER", reference) =>
            {
                return false;
            }
            _ => {}
        }
    }
    for (key, expected) in [
        ("COMMENTS", &definition.comments),
        ("JOB_CLASS", &definition.job_class),
        ("JOB_STYLE", &definition.job_style),
        ("CREDENTIAL_NAME", &definition.credential_name),
        ("DESTINATION", &definition.destination_name),
    ] {
        if expected.as_deref().is_some_and(|expected| !nullable_text(row.get(key), expected)) {
            return false;
        }
    }
    true
}

pub(super) fn mark(operations: &NativeJobOperations, id: &str, index: usize, receipt: &NativeJobStepReceipt) {
    operations.edit(id, |status| {
        status.steps[index].state = match receipt.outcome {
            NativeJobDispatchOutcome::NotStarted => NativeJobStepState::Failed,
            NativeJobDispatchOutcome::Applied => NativeJobStepState::Applied,
            NativeJobDispatchOutcome::Unknown => NativeJobStepState::Unknown,
        };
        status.steps[index].reason = receipt.reason.clone();
        status.steps[index].vendor_code = receipt.vendor_code;
    });
}

async fn run_validations(
    state: &AppState,
    execution: &PreparedExecution,
    id: &str,
    cancel: &CancellationToken,
    session: &mut impl NativeJobMutationSession,
    steps: &[NativeJobSqlStep],
) -> Result<usize, (&'static str, NativeJobOperationOutcome)> {
    let operations = state.native_jobs.operations();
    let mut count = 0;
    for (index, step) in
        steps.iter().enumerate().take_while(|(_, step)| matches!(step.effect, NativeJobStepEffect::ArgumentValidated))
    {
        require_write(state, &execution.binding)
            .await
            .map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
        if cancel.is_cancelled() {
            return Err(("native_job_canceled_before_dispatch", NativeJobOperationOutcome::NotApplied));
        }
        operations.edit(id, |status| {
            status.state = NativeJobOperationState::Running;
            status.steps[index].state = NativeJobStepState::Dispatching;
        });
        let receipt = session.execute(step).await;
        mark(operations, id, index, &receipt);
        if receipt.outcome != NativeJobDispatchOutcome::Applied {
            return Err(("native_job_argument_validation_failed", NativeJobOperationOutcome::NotApplied));
        }
        count += 1;
    }
    Ok(count)
}

pub(super) async fn run_create(
    state: &AppState,
    execution: &PreparedExecution,
    id: &str,
    cancel: &CancellationToken,
    session: &mut impl NativeJobMutationSession,
    dispatched: &mut bool,
) -> Result<NativeJobOperationOutcome, (&'static str, NativeJobOperationOutcome)> {
    let PreparedAction::SchedulerCreate { definition, plan } = &execution.action else { unreachable!() };
    let projection = (execution.binding.context.engine == NativeJobEngine::Oracle)
        .then(|| transition::projection::OracleSchedulerProjection::for_create(definition))
        .flatten();
    let operations = state.native_jobs.operations();
    let existing =
        session.read(&plan.target).await.map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
    require_absent(&existing, &execution.binding.context.session_user)
        .map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
    let create_index = run_validations(state, execution, id, cancel, session, &plan.steps).await?;
    if create_index != 0 {
        let existing =
            session.read(&plan.target).await.map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
        require_absent(&existing, &execution.binding.context.session_user)
            .map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
    }
    require_write(state, &execution.binding).await.map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
    if cancel.is_cancelled() {
        return Err(("native_job_canceled_before_dispatch", NativeJobOperationOutcome::NotApplied));
    }
    operations.edit(id, |status| {
        status.state = NativeJobOperationState::Running;
        status.steps[create_index].state = NativeJobStepState::Dispatching;
    });
    *dispatched = true;
    let receipt = session.execute(&plan.steps[create_index]).await;
    mark(operations, id, create_index, &receipt);
    if receipt.outcome == NativeJobDispatchOutcome::NotStarted {
        return Err(("native_job_step_not_applied", NativeJobOperationOutcome::NotApplied));
    }
    let created = session.read(&plan.target).await;
    if let Ok(created) = &created {
        if let NativeJobMetadata::Available { value } = &created.native_identity {
            operations.edit(id, |status| status.observed_identity = Some(value.clone()));
        }
    }
    // A same-name object appearing after a lost CREATE receipt is not proof that this call created
    // it. Keep it available for inspection, but do not configure, enable, remove or create again.
    if receipt.outcome == NativeJobDispatchOutcome::Unknown {
        return Err(("native_job_creation_outcome_unknown", NativeJobOperationOutcome::Unknown));
    }
    let mut before = created.map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?;
    if !verify_initial(&before, &plan.target, definition) {
        return Err(("native_job_created_definition_unverified", NativeJobOperationOutcome::Partial));
    }
    if let Some(projection) = &projection {
        if !projection
            .preserved(&before, &before, true)
            .map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?
        {
            return Err(("native_job_created_definition_unverified", NativeJobOperationOutcome::Partial));
        }
    }
    let NativeJobMetadata::Available { value: identity } = &before.native_identity else { unreachable!() };
    let resolved = native_job_scheduler_create_plan(
        execution.binding.context.engine,
        &execution.binding.context.scope,
        definition,
        Some(identity),
    )
    .map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?;
    for (index, step) in resolved.steps.iter().enumerate().skip(create_index + 1) {
        let stopped = if cancel.is_cancelled() {
            Some("native_job_canceled_after_dispatch")
        } else {
            require_write(state, &execution.binding).await.err()
        };
        if let Some(reason) = stopped {
            return Err((reason, NativeJobOperationOutcome::Partial));
        }
        let current =
            session.read(&plan.target).await.map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?;
        let definition_preserved = if let Some(projection) = &projection {
            projection
                .preserved(&before, &current, true)
                .map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?
        } else {
            preserved_definition(&before, &current, &NativeJobStepEffect::Completed, execution.binding.context.engine)
        };
        let storage_preserved = if execution.binding.context.engine == NativeJobEngine::Oracle {
            match (
                super::super::details::parse_argument_inventory(&before.parameter_metadata),
                super::super::details::parse_argument_inventory(&current.parameter_metadata),
            ) {
                (NativeJobMetadata::Available { value: before }, NativeJobMetadata::Available { value: current }) => {
                    transition::same_inventory(NativeJobEngine::Oracle, &before, &current)
                }
                _ => true,
            }
        } else {
            true
        };
        if !matches!(current.consistency, NativeJobMetadata::Available { .. })
            || current.native_identity != before.native_identity
            || !definition_preserved
            || current.snapshot.arguments != before.snapshot.arguments
            || !storage_preserved
        {
            return Err(("native_job_created_target_changed", NativeJobOperationOutcome::Partial));
        }
        before = current;
        // A cancellation or write-lock change may arrive while the preflight read is in flight.
        require_write(state, &execution.binding)
            .await
            .map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?;
        if cancel.is_cancelled() {
            return Err(("native_job_canceled_after_dispatch", NativeJobOperationOutcome::Partial));
        }
        operations.edit(id, |status| status.steps[index].state = NativeJobStepState::Dispatching);
        let receipt = session.execute(step).await;
        mark(operations, id, index, &receipt);
        if receipt.outcome == NativeJobDispatchOutcome::NotStarted {
            return Err(("native_job_step_not_applied", NativeJobOperationOutcome::Partial));
        }
        let unknown = receipt.outcome == NativeJobDispatchOutcome::Unknown;
        let after = session.read(&plan.target).await.map_err(|reason| {
            (reason, if unknown { NativeJobOperationOutcome::Unknown } else { NativeJobOperationOutcome::Partial })
        })?;
        let failed_read = if unknown { NativeJobOperationOutcome::Unknown } else { NativeJobOperationOutcome::Partial };
        let verified = if let Some(projection) = &projection {
            projection
                .verify(&before, &after, &step.effect, true, &execution.binding.context.session_user)
                .map_err(|reason| (reason, failed_read))?
        } else {
            verify_effect(
                &before,
                &after,
                &step.effect,
                &execution.binding.context.session_user,
                execution.binding.context.engine,
            )
        };
        if !verified {
            return Err(("native_job_readback_not_verified", failed_read));
        }
        operations.edit(id, |status| status.steps[index].state = NativeJobStepState::Applied);
        before = after;
    }
    Ok(NativeJobOperationOutcome::Verified)
}

#[cfg(test)]
mod tests {
    use super::same_timestamp;
    use serde_json::json;

    #[test]
    fn native_short_offsets_preserve_instant_and_nanoseconds() {
        for (actual, expected) in [
            ("2026-10-22 00:54:25.656000001 +8:00", "2026-10-21T16:54:25.656000001Z"),
            ("2026-10-21 22:24:25.656 +5:30", "2026-10-21T16:54:25.656Z"),
            ("2026-10-21 13:24:25.656 -3:30", "2026-10-21T16:54:25.656Z"),
        ] {
            assert!(same_timestamp(Some(&json!(actual)), expected));
        }
        for actual in [
            "2026-10-21 16:54:25.656 +8:00",
            "2026-10-22 00:54:25.656000001 +8:00",
            "2026-10-22 00:54:25.656 +8:60",
            "2026-10-22 00:54:25.656",
        ] {
            assert!(!same_timestamp(Some(&json!(actual)), "2026-10-21T16:54:25.656Z"), "{actual}");
        }
    }
}
