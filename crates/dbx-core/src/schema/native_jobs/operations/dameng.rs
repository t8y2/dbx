use super::*;
use dbx_sql::native_job_changes::{
    native_job_dameng_child_key, resolve_native_job_dameng_child_step, NativeJobDamengChildAction,
    NativeJobDamengConfigPlan, NativeJobDamengOperatorSelector, NativeJobDamengPart,
};

mod creation;
mod parts;
pub(super) mod rename;
pub(super) use creation::run_create;

type Failure = (&'static str, NativeJobOperationOutcome);

fn legacy_coverage(details: &NativeJobDetails, user: &str) -> bool {
    let own = row(details).and_then(|row| row.get("USERNAME")).and_then(Value::as_str) == Some(user);
    ["legacyDefinition", "steps", "schedules"].into_iter().all(|part| {
        match details.sources.get(part).and_then(|source| source.coverage) {
            Some(NativeJobCatalogCoverage::Database | NativeJobCatalogCoverage::Accessible) => true,
            Some(NativeJobCatalogCoverage::CurrentUser) => own,
            _ => false,
        }
    })
}

fn legacy_preserved(
    before: &NativeJobDetails,
    after: &NativeJobDetails,
    interval: bool,
    next_date: bool,
    what: bool,
) -> bool {
    let (Some(NativeJobMetadata::Available { value: before }), Some(NativeJobMetadata::Available { value: after })) =
        (&before.legacy_definition, &after.legacy_definition)
    else {
        return false;
    };
    let ignored = |key: &str| {
        matches!(key, "LAST_DATE" | "LAST_SEC" | "THIS_DATE" | "THIS_SEC" | "TOTAL_TIME" | "FAILURES")
            || (interval && key == "INTERVAL")
            || (next_date && matches!(key, "NEXT_DATE" | "NEXT_SEC"))
            || (what && key == "WHAT")
    };
    before.iter().all(|(key, value)| ignored(key) || after.get(key) == Some(value))
        && after.keys().all(|key| ignored(key) || before.contains_key(key))
}

fn interval_matches(after: &NativeJobDetails, expected: &str) -> bool {
    let Some(NativeJobMetadata::Available { value }) = &after.legacy_definition else {
        return false;
    };
    let Some(Value::String(value)) = value.get("INTERVAL") else {
        return false;
    };
    let (integer, fraction) = value.split_once('.').map_or((value.as_str(), ""), |parts| parts);
    !integer.is_empty()
        && integer.bytes().all(|byte| byte.is_ascii_digit())
        && fraction.bytes().all(|byte| byte == b'0')
        && integer.trim_start_matches('0') == expected
}

async fn resolve_operators(
    session: &mut impl NativeJobMutationSession,
    plan: &NativeJobDamengConfigPlan,
) -> Result<BTreeMap<&'static str, Option<i64>>, &'static str> {
    let rows = if let Some(query) = plan.operator_query() {
        let limit = query.limit;
        let raw = session.query(query).await.map_err(|_| "native_job_notification_operator_unverified")?;
        let result = decode_query_result(NativeJobEngine::Dameng, raw)
            .and_then(|result| rows_from_result(result, limit, |_| Ok(())))
            .map_err(|_| "native_job_notification_operator_unverified")?;
        match result {
            NativeJobMetadata::Available { value } => value,
            NativeJobMetadata::Empty => Vec::new(),
            _ => return Err("native_job_notification_operator_unverified"),
        }
    } else {
        Vec::new()
    };
    let mut expected = BTreeMap::new();
    for operator in &plan.operators {
        let id = if matches!(operator.selector, NativeJobDamengOperatorSelector::Unassigned) {
            None
        } else {
            // The database supplies the match bit using its own name/case semantics. Do not
            // approximate a database name comparison with a client-side case conversion.
            let key = format!("DBX_MATCH_{}", operator.column);
            if rows.iter().any(|row| super::super::details::boolean(row.get(&key)).is_none()) {
                return Err("native_job_notification_operator_unverified");
            }
            let matching = rows
                .iter()
                .filter(|row| super::super::details::boolean(row.get(&key)) == Some(true))
                .collect::<Vec<_>>();
            if matching.len() != 1 || matching[0].get("NAME").and_then(Value::as_str).is_none() {
                return Err("native_job_notification_operator_unverified");
            }
            let id = matching[0]
                .get("DBX_OPERATOR_ID")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<i64>().ok())
                .filter(|id| *id > 0)
                .ok_or("native_job_notification_operator_unverified")?;
            if matches!(operator.selector, NativeJobDamengOperatorSelector::Id(expected) if expected != id) {
                return Err("native_job_notification_operator_unverified");
            }
            Some(id)
        };
        expected.insert(operator.column, id);
    }
    Ok(expected)
}

fn fields_match(after: &NativeJobDetails, changes: &[NativeJobAttributeChange]) -> bool {
    row(after).is_some_and(|row| {
        changes.iter().all(|change| match &change.change {
            NativeJobFieldChange::Set { value } => values::field_matches(&change.name, row.get(&change.name), value),
            NativeJobFieldChange::Clear => row.get(&change.name) == Some(&Value::Null),
            NativeJobFieldChange::Keep => true,
        })
    })
}

fn preserved_partition(
    before: &NativeJobMetadata<Vec<NativeJobRow>>,
    after: &NativeJobMetadata<Vec<NativeJobRow>>,
    generated: &[&str],
) -> bool {
    let empty = Vec::new();
    let before = match before {
        NativeJobMetadata::Available { value } => value,
        NativeJobMetadata::Empty => &empty,
        // Unrelated unreadable partitions are not new privileges required for a metadata edit.
        _ => return true,
    };
    let after = match after {
        NativeJobMetadata::Available { value } => value,
        NativeJobMetadata::Empty => &empty,
        _ => return false,
    };
    before.len() == after.len()
        && before.iter().zip(after).all(|(before, after)| {
            before.iter().all(|(key, value)| generated.contains(&key.as_str()) || after.get(key) == Some(value))
                && after.keys().all(|key| generated.contains(&key.as_str()) || before.contains_key(key))
        })
}

fn unchanged(before: &NativeJobDetails, current: &NativeJobDetails) -> bool {
    matches!(current.consistency, NativeJobMetadata::Available { .. })
        && current.native_identity == before.native_identity
        && preserved_definition(before, current, &NativeJobStepEffect::Completed, NativeJobEngine::Dameng)
        && preserved_partition(&before.steps, &current.steps, &[])
        && preserved_partition(&before.schedules, &current.schedules, &[])
}

fn verify_step(
    before: &NativeJobDetails,
    after: &NativeJobDetails,
    effect: &NativeJobStepEffect,
    operators: &BTreeMap<&'static str, Option<i64>>,
    user: &str,
) -> bool {
    if !matches!(after.consistency, NativeJobMetadata::Available { .. })
        || before.native_identity != after.native_identity
    {
        return false;
    }
    let extra: &[&str] = match effect {
        NativeJobStepEffect::DamengRenamed { .. } => &["NAME"],
        NativeJobStepEffect::DamengDefinition(_) => &["VALID", "EMAIL_OPERID", "NETSEND_OPERID"],
        NativeJobStepEffect::DamengConfigurationStarted
        | NativeJobStepEffect::DamengConfigurationCommitted
        | NativeJobStepEffect::Fields(_)
        | NativeJobStepEffect::DamengChild(_) => &["VALID"],
        _ => &[],
    };
    let child = if let NativeJobStepEffect::DamengChild(child) = effect { Some(child) } else { None };
    let steps_preserved = child.is_some_and(|child| child.part == NativeJobDamengPart::Steps)
        || preserved_partition(&before.steps, &after.steps, &[]);
    let schedules_preserved = child.is_some_and(|child| child.part == NativeJobDamengPart::Schedules)
        || preserved_partition(
            &before.schedules,
            &after.schedules,
            if matches!(effect, NativeJobStepEffect::DamengConfigurationCommitted) {
                &["VALID", "SCHNAME", "TRIGNAME"]
            } else {
                &[]
            },
        );
    if !preserved_definition_with_extra(before, after, effect, extra, NativeJobEngine::Dameng)
        || !steps_preserved
        || !schedules_preserved
        || child.is_some_and(|child| !parts::verify(before, after, child, user))
    {
        return false;
    }
    let Some(after_row) = row(after) else { return false };
    let enabled = super::super::details::boolean(after_row.get("ENABLE"));
    let expected_enabled = if matches!(effect, NativeJobStepEffect::DamengRenamed { .. }) {
        row(before).and_then(|row| super::super::details::boolean(row.get("ENABLE")))
    } else {
        Some(matches!(effect, NativeJobStepEffect::Enabled(true)))
    };
    if expected_enabled.is_none() || enabled != expected_enabled {
        return false;
    }
    match effect {
        NativeJobStepEffect::DamengRenamed { new_name, .. } => {
            after_row.get("NAME").and_then(Value::as_str) == Some(new_name)
                && (!matches!(before.legacy_definition, Some(NativeJobMetadata::Available { .. }))
                    || legacy_preserved(before, after, false, expected_enabled == Some(true), false))
        }
        NativeJobStepEffect::Enabled(_)
        | NativeJobStepEffect::DamengConfigurationStarted
        | NativeJobStepEffect::DamengChild(_) => true,
        NativeJobStepEffect::DamengConfigurationCommitted => {
            after_row.get("VALID").and_then(Value::as_str) == Some("Y")
        }
        NativeJobStepEffect::Fields(changes) => fields_match(after, changes),
        NativeJobStepEffect::DamengDefinition(changes) => {
            fields_match(after, changes)
                && operators.iter().all(|(column, expected)| match expected {
                    Some(id) => values::field_matches(column, after_row.get(*column), &serde_json::json!(id)),
                    None => after_row.get(*column).is_some_and(|value| {
                        value.is_null() || super::super::details::integer(Some(value)).is_some_and(|value| value <= 0)
                    }),
                })
        }
        NativeJobStepEffect::DamengLegacyInterval { expected_seconds } => {
            legacy_preserved(before, after, true, false, false)
                && matches!(&after.legacy_definition, Some(NativeJobMetadata::Available { value }) if value.contains_key("INTERVAL"))
                && expected_seconds.as_ref().is_none_or(|expected| interval_matches(after, expected))
        }
        NativeJobStepEffect::DamengLegacyWhat { expected } => {
            legacy_preserved(before, after, false, false, true)
                && matches!(&after.legacy_definition, Some(NativeJobMetadata::Available { value }) if value.get("WHAT").and_then(Value::as_str) == Some(expected))
        }
        NativeJobStepEffect::DamengLegacyNextDate { expected } => {
            legacy_preserved(before, after, false, true, false) && legacy_time_matches(after, expected)
        }
        _ => false,
    }
}

fn legacy_time_matches(details: &NativeJobDetails, expected: &str) -> bool {
    matches!(&details.legacy_definition, Some(NativeJobMetadata::Available { value })
        if dbx_sql::native_job_changes::native_job_dameng_legacy_time(value).as_deref() == Ok(expected))
}

async fn check_dispatch(
    state: &AppState,
    execution: &PreparedExecution,
    cancel: &CancellationToken,
    dispatched: bool,
) -> Result<(), Failure> {
    let reason = if cancel.is_cancelled() {
        Some("native_job_canceled_after_dispatch")
    } else {
        require_write(state, &execution.binding).await.err()
    };
    match reason {
        Some(reason) => Err((
            reason,
            if dispatched { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::NotApplied },
        )),
        None => Ok(()),
    }
}

pub(super) async fn run_configure(
    state: &AppState,
    execution: &PreparedExecution,
    id: &str,
    cancel: &CancellationToken,
    session: &mut impl NativeJobMutationSession,
    dispatched: &mut bool,
) -> Result<NativeJobOperationOutcome, Failure> {
    let PreparedAction::Mutation { mutation, plan } = &execution.action else { unreachable!() };
    if plan.steps.iter().any(|step| {
        matches!(
            step.effect,
            NativeJobStepEffect::DamengLegacyInterval { .. }
                | NativeJobStepEffect::DamengLegacyWhat { .. }
                | NativeJobStepEffect::DamengLegacyNextDate { .. }
                | NativeJobStepEffect::DamengRenamed { .. }
        )
    }) && !plan.steps.iter().any(|step| matches!(step.effect, NativeJobStepEffect::DamengConfigurationCommitted))
        && state.native_jobs.operations().configuration_pending(&execution.origin_key)
    {
        return Err(("native_job_configuration_preview_required", NativeJobOperationOutcome::NotApplied));
    }
    session.begin_configure(id).await.map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
    check_dispatch(state, execution, cancel, false).await?;
    let before =
        session.read(&mutation.target).await.map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
    if plan.steps.iter().any(|step| {
        matches!(
            step.effect,
            NativeJobStepEffect::DamengLegacyInterval { .. }
                | NativeJobStepEffect::DamengLegacyWhat { .. }
                | NativeJobStepEffect::DamengLegacyNextDate { .. }
        )
    }) && !legacy_coverage(&before, &execution.binding.context.session_user)
    {
        return Err(("native_job_legacy_coverage_incomplete", NativeJobOperationOutcome::NotApplied));
    }
    if plan.steps.iter().any(|step| {
        matches!(
            step.effect,
            NativeJobStepEffect::DamengLegacyInterval { .. }
                | NativeJobStepEffect::DamengLegacyWhat { .. }
                | NativeJobStepEffect::DamengLegacyNextDate { .. }
                | NativeJobStepEffect::DamengRenamed { .. }
        )
    }) && !plan.steps.iter().any(|step| matches!(step.effect, NativeJobStepEffect::DamengConfigurationCommitted))
        && row(&before).is_some_and(|row| row.get("VALID").and_then(Value::as_str) == Some("N"))
    {
        return Err(("native_job_configuration_preview_required", NativeJobOperationOutcome::NotApplied));
    }
    state
        .native_jobs
        .compare_baseline(
            state,
            &mutation.target,
            &mutation.baseline,
            &before.snapshot.revision,
            &plan.required_partitions.iter().map(String::as_str).collect::<Vec<_>>(),
            plan.compare_next_date,
        )
        .map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
    check_dispatch(state, execution, cancel, false).await?;
    for step in &plan.steps {
        if let NativeJobStepEffect::DamengLegacyWhat { expected } = &step.effect {
            let query = dbx_sql::native_job_changes::native_job_dameng_what_query(expected);
            let raw = session
                .query(query)
                .await
                .map_err(|_| ("native_job_attribute_value_invalid", NativeJobOperationOutcome::NotApplied))?;
            let result = decode_query_result(NativeJobEngine::Dameng, raw)
                .and_then(|result| rows_from_result(result, 1, |_| Ok(())))
                .map_err(|_| ("native_job_attribute_value_invalid", NativeJobOperationOutcome::NotApplied))?;
            if !matches!(result, NativeJobMetadata::Available { value } if value.len() == 1 && value[0].get("DBX_WHAT").and_then(Value::as_str) == Some(expected))
            {
                return Err(("native_job_attribute_value_invalid", NativeJobOperationOutcome::NotApplied));
            }
        }
        if let NativeJobStepEffect::DamengLegacyNextDate { expected } = &step.effect {
            let query = dbx_sql::native_job_changes::native_job_dameng_date_query(expected);
            let raw = session
                .query(query)
                .await
                .map_err(|_| ("native_job_attribute_value_invalid", NativeJobOperationOutcome::NotApplied))?;
            let result = decode_query_result(NativeJobEngine::Dameng, raw)
                .and_then(|result| rows_from_result(result, 1, |_| Ok(())))
                .map_err(|_| ("native_job_attribute_value_invalid", NativeJobOperationOutcome::NotApplied))?;
            let NativeJobMetadata::Available { value } = result else {
                return Err(("native_job_attribute_value_invalid", NativeJobOperationOutcome::NotApplied));
            };
            if value.len() != 1
                || !value[0].get("DBX_NEXT_DATE").and_then(Value::as_str).is_some_and(|date| {
                    let date = date.trim_start_matches(' ').strip_prefix('+').unwrap_or(date.trim_start_matches(' '));
                    dbx_sql::native_job_changes::native_job_dameng_civil_time(date).as_deref() == Ok(expected.as_str())
                })
            {
                return Err(("native_job_attribute_value_invalid", NativeJobOperationOutcome::NotApplied));
            }
        }
    }
    run_steps(
        state,
        execution,
        id,
        cancel,
        session,
        dispatched,
        ConfigurationExecution { target: &mutation.target, plan, origin_key: &execution.origin_key, offset: 0, before },
    )
    .await
}

struct ConfigurationExecution<'a> {
    target: &'a NativeJobRef,
    plan: &'a NativeJobSqlPlan,
    origin_key: &'a str,
    offset: usize,
    before: NativeJobDetails,
}

async fn run_steps(
    state: &AppState,
    execution: &PreparedExecution,
    id: &str,
    cancel: &CancellationToken,
    session: &mut impl NativeJobMutationSession,
    dispatched: &mut bool,
    configuration: ConfigurationExecution<'_>,
) -> Result<NativeJobOperationOutcome, Failure> {
    let ConfigurationExecution { target, plan, origin_key, offset, mut before } = configuration;
    let mut effective_target = target.clone();
    let mut renamed = false;
    let rename = if let Some((old_name, new_name)) = plan.steps.iter().find_map(|step| match &step.effect {
        NativeJobStepEffect::DamengRenamed { old_name, new_name } => Some((old_name.clone(), new_name.clone())),
        _ => None,
    }) {
        let NativeJobMetadata::Available { value: identity } = &before.native_identity else {
            return Err(("native_job_identity_unverified", NativeJobOperationOutcome::NotApplied));
        };
        if let Some(existing) = creation::lookup(session, &new_name)
            .await
            .map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?
        {
            if existing.get("DBX_JOB_ID") != identity.get("DBX_JOB_ID") {
                return Err(("native_job_name_conflict", NativeJobOperationOutcome::NotApplied));
            }
        }
        Some(Arc::new(tokio::sync::Mutex::new(rename::Binding {
            binding: execution.binding.clone(),
            target: target.clone(),
            identity: identity.clone(),
            old_name,
            new_name,
        })))
    } else {
        None
    };
    let operators = resolve_operators(session, plan.dameng_configuration.as_ref().expect("DM configuration plan"))
        .await
        .map_err(|reason| {
            (
                reason,
                if *dispatched { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::NotApplied },
            )
        })?;
    let operations = state.native_jobs.operations();
    if let Some(rename) = &rename {
        if let Some(record) = operations
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .records
            .iter_mut()
            .find(|record| record.status.operation_id == id && record.actor == current_credential_owner())
        {
            record.rename = Some(rename.clone());
        }
    }
    operations.edit(id, |status| status.state = NativeJobOperationState::Running);
    let mut configuration_written = false;
    let mut created_children = BTreeMap::new();
    let legacy_interval = plan.steps.iter().any(|step| {
        matches!(
            step.effect,
            NativeJobStepEffect::DamengLegacyInterval { .. }
                | NativeJobStepEffect::DamengLegacyWhat { .. }
                | NativeJobStepEffect::DamengLegacyNextDate { .. }
        )
    });
    let mut accepted_seen = false;
    let mut requested_date: Option<String> = None;
    for (index, step) in plan.steps.iter().enumerate() {
        let status_index = index + offset;
        check_dispatch(state, execution, cancel, *dispatched).await?;
        let current = session.read(&effective_target).await.map_err(|reason| {
            (
                reason,
                if *dispatched { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::NotApplied },
            )
        })?;
        if !*dispatched && plan.compare_next_date {
            state
                .native_jobs
                .compare_baseline(
                    state,
                    &effective_target,
                    &before.snapshot.revision,
                    &current.snapshot.revision,
                    &[],
                    true,
                )
                .map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
        }
        if !unchanged(&before, &current)
            || requested_date.as_deref().is_some_and(|expected| !legacy_time_matches(&current, expected))
            || (legacy_interval && !legacy_coverage(&current, &execution.binding.context.session_user))
            || (legacy_interval
                && !legacy_preserved(
                    &before,
                    &current,
                    false,
                    row(&before).and_then(|row| super::super::details::boolean(row.get("ENABLE"))) == Some(true),
                    false,
                ))
        {
            return Err((
                "native_job_definition_changed",
                if *dispatched { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::NotApplied },
            ));
        }
        before = current;
        let resolved = if renamed && matches!(step.effect, NativeJobStepEffect::Enabled(_)) {
            let NativeJobStepEffect::Enabled(enabled) = step.effect else { unreachable!() };
            let request = NativeJobMutation {
                target: effective_target.clone(),
                baseline: before.snapshot.revision.clone(),
                change: if enabled { NativeJobChange::Enable } else { NativeJobChange::Disable },
            };
            Some(
                dbx_sql::native_job_changes::native_job_mutation_plan(NativeJobEngine::Dameng, &request, &before)
                    .map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?
                    .steps
                    .into_iter()
                    .next()
                    .ok_or(("native_job_step_missing", NativeJobOperationOutcome::Partial))?,
            )
        } else if matches!(step.effect, NativeJobStepEffect::DamengChild(_)) {
            Some(resolve_native_job_dameng_child_step(step, target, &before, &created_children).map_err(|reason| {
                (
                    reason,
                    if *dispatched {
                        NativeJobOperationOutcome::Partial
                    } else {
                        NativeJobOperationOutcome::NotApplied
                    },
                )
            })?)
        } else {
            None
        };
        let step = resolved.as_ref().unwrap_or(step);
        // Reads can take long enough for cancellation or the existing write lock to change.
        check_dispatch(state, execution, cancel, *dispatched).await?;
        let first_configuration = !configuration_written
            && matches!(
                step.effect,
                NativeJobStepEffect::DamengDefinition(_) | NativeJobStepEffect::DamengConfigurationStarted
            );
        let newly_pending = first_configuration && operations.configuration_dispatched(origin_key);
        operations.edit(id, |status| status.steps[status_index].state = NativeJobStepState::Dispatching);
        *dispatched = true;
        let receipt = session.execute(step).await;
        scheduler::mark(operations, id, status_index, &receipt);
        if receipt.outcome == NativeJobDispatchOutcome::NotStarted {
            if newly_pending {
                operations.configuration_verified(origin_key);
            }
            return Err((
                "native_job_step_not_applied",
                if status_index == 0 {
                    NativeJobOperationOutcome::NotApplied
                } else {
                    NativeJobOperationOutcome::Partial
                },
            ));
        }
        configuration_written |= first_configuration;
        let unknown = receipt.outcome == NativeJobDispatchOutcome::Unknown;
        if unknown && matches!(step.effect, NativeJobStepEffect::DamengLegacyInterval { .. }) {
            return Err(("native_job_legacy_interval_commit_unknown", NativeJobOperationOutcome::Unknown));
        }
        if unknown
            && matches!(
                step.effect,
                NativeJobStepEffect::DamengLegacyWhat { .. } | NativeJobStepEffect::DamengLegacyNextDate { .. }
            )
        {
            return Err(("native_job_step_outcome_unknown", NativeJobOperationOutcome::Unknown));
        }
        if unknown && matches!(step.effect, NativeJobStepEffect::DamengRenamed { .. }) {
            return Err(("native_job_rename_commit_unknown", NativeJobOperationOutcome::Unknown));
        }
        if unknown
            && (matches!(
                step.effect,
                NativeJobStepEffect::DamengConfigurationStarted | NativeJobStepEffect::DamengConfigurationCommitted
            ) || matches!(&step.effect, NativeJobStepEffect::DamengChild(child) if child.requires_acknowledgement))
        {
            return Err(("native_job_configuration_protocol_outcome_unknown", NativeJobOperationOutcome::Unknown));
        }
        let after_target = if matches!(step.effect, NativeJobStepEffect::DamengRenamed { .. }) {
            let rename = rename.as_ref().expect("rename binding").lock().await;
            rename.locate_session(session).await.map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?
        } else {
            effective_target.clone()
        };
        let after = session.read(&after_target).await.map_err(|reason| {
            (reason, if unknown { NativeJobOperationOutcome::Unknown } else { NativeJobOperationOutcome::Partial })
        })?;
        if matches!(step.effect, NativeJobStepEffect::DamengRenamed { .. }) {
            let rename = rename.as_ref().expect("rename binding").lock().await;
            let identity = rename
                .verified(&after_target, &after)
                .map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?;
            if let NativeJobStepEffect::DamengRenamed { new_name, .. } = &step.effect {
                if identity.get("NAME").and_then(Value::as_str) != Some(new_name) {
                    return Err(("native_job_rename_not_observed", NativeJobOperationOutcome::Partial));
                }
            }
            effective_target = after_target;
            renamed = true;
            operations.edit(id, |status| {
                status.target = Some(effective_target.clone());
                status.observed_identity = Some(identity);
            });
        }
        if !verify_step(&before, &after, &step.effect, &operators, &execution.binding.context.session_user)
            || (legacy_interval && !legacy_coverage(&after, &execution.binding.context.session_user))
            || (legacy_interval
                && !legacy_preserved(
                    &before,
                    &after,
                    matches!(step.effect, NativeJobStepEffect::DamengLegacyInterval { .. }),
                    matches!(step.effect, NativeJobStepEffect::DamengLegacyNextDate { .. })
                        || (!plan.compare_next_date && matches!(step.effect, NativeJobStepEffect::Enabled(_))),
                    matches!(step.effect, NativeJobStepEffect::DamengLegacyWhat { .. }),
                ))
        {
            return Err((
                "native_job_readback_not_verified",
                if unknown { NativeJobOperationOutcome::Unknown } else { NativeJobOperationOutcome::Partial },
            ));
        }
        if let NativeJobStepEffect::DamengLegacyNextDate { expected } = &step.effect {
            requested_date = Some(expected.clone());
        }
        if requested_date.as_deref().is_some_and(|expected| !legacy_time_matches(&after, expected)) {
            return Err(("native_job_readback_not_verified", NativeJobOperationOutcome::Partial));
        }
        let accepted = matches!(step.effect, NativeJobStepEffect::DamengLegacyInterval { expected_seconds: None });
        accepted_seen |= accepted;
        operations.edit(id, |status| {
            status.steps[status_index].state =
                if accepted { NativeJobStepState::Accepted } else { NativeJobStepState::Applied };
            if accepted {
                status.steps[status_index].reason = Some("native_job_legacy_interval_expression_not_readable".into());
            }
        });
        if let NativeJobStepEffect::DamengChild(child) = &step.effect {
            if child.action == NativeJobDamengChildAction::Added {
                let native_id = parts::created_id(&after, child)
                    .ok_or(("native_job_child_identity_unverified", NativeJobOperationOutcome::Partial))?;
                operations.edit(id, |status| {
                    status.created_children.push(NativeJobDamengCreatedChild {
                        partition: child.part.key().into(),
                        name: child.name.clone(),
                        id: native_id.clone(),
                    })
                });
                created_children.insert(native_job_dameng_child_key(child.part, &child.name), native_id);
            }
        }
        if matches!(step.effect, NativeJobStepEffect::DamengConfigurationCommitted) {
            operations.configuration_verified(origin_key);
        }
        before = after;
    }
    Ok(if accepted_seen { NativeJobOperationOutcome::Accepted } else { NativeJobOperationOutcome::Verified })
}
