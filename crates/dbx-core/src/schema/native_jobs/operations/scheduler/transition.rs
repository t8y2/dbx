use super::*;
use crate::schema::native_jobs::details::{
    inventory_value, parse_argument_inventory, parse_argument_layout, SchedulerArgumentInventory,
};
use dbx_sql::native_job_changes::{
    scheduler_argument_step, NativeJobSchedulerDefinitionEffect, NativeJobSchedulerEditPlan,
    NativeJobSchedulerReferenceBinding,
};

mod dameng;
pub(super) mod projection;

struct BoundReference {
    request: NativeJobReferenceListRequest,
    rows: Vec<NativeJobRow>,
}

pub(in crate::schema::native_jobs::operations) struct PreparedSchedulerTransition {
    pub edit: NativeJobSchedulerEditPlan,
    dependencies: Vec<BoundReference>,
    original: NativeJobDetails,
    inventory: Option<SchedulerArgumentInventory>,
    layout: Option<Vec<NativeJobArgument>>,
    retired: HashSet<usize>,
    oracle: Option<projection::OracleSchedulerProjection>,
    dameng: Option<dameng::DamengNamedProjection>,
}

fn reference_request(
    scope: &NativeJobScope,
    binding: &NativeJobSchedulerReferenceBinding,
) -> NativeJobReferenceListRequest {
    NativeJobReferenceListRequest {
        scope: scope.clone(),
        kind: binding.target.kind,
        schema: Some(binding.target.reference.owner.clone()),
        name: Some(binding.target.reference.name.clone()),
        filter: String::new(),
        offset: 0,
        limit: 1,
    }
}

fn checked_rows(
    request: &NativeJobReferenceListRequest,
    catalog: &NativeJobReferenceCatalog,
) -> Result<Vec<NativeJobRow>, &'static str> {
    let rows = match &catalog.objects {
        NativeJobMetadata::Available { value } => value.clone(),
        NativeJobMetadata::Empty
            if matches!(
                request.kind,
                NativeJobReferenceKind::ProgramArguments | NativeJobReferenceKind::DestinationGroupMembers
            ) =>
        {
            Vec::new()
        }
        NativeJobMetadata::Denied { .. } => return Err("native_job_reference_denied"),
        NativeJobMetadata::Unsupported { .. } => return Err("native_job_reference_unsupported"),
        NativeJobMetadata::Truncated { .. } => return Err("native_job_reference_truncated"),
        NativeJobMetadata::Empty => return Err("native_job_reference_missing"),
        NativeJobMetadata::Error { .. } => return Err("native_job_reference_read_failed"),
        _ => return Err("native_job_reference_unavailable"),
    };
    if !matches!(
        request.kind,
        NativeJobReferenceKind::ProgramArguments | NativeJobReferenceKind::DestinationGroupMembers
    ) && rows.len() != 1
    {
        return Err("native_job_reference_identity_unavailable");
    }
    let mut positions = HashSet::new();
    let mut members = HashSet::new();
    for row in &rows {
        if row.get("DBX_OWNER").and_then(Value::as_str) != request.schema.as_deref()
            || row.get("DBX_NAME").and_then(Value::as_str) != request.name.as_deref()
        {
            return Err("native_job_reference_identity_unavailable");
        }
        if request.kind == NativeJobReferenceKind::ProgramArguments {
            let position = crate::schema::native_jobs::details::integer(row.get("ARGUMENT_POSITION"))
                .filter(|position| *position > 0)
                .ok_or("native_job_arguments_invalid")?;
            if !positions.insert(position) {
                return Err("native_job_arguments_ambiguous");
            }
        } else if request.kind == NativeJobReferenceKind::DestinationGroupMembers {
            let member = row
                .get("MEMBER_NAME")
                .and_then(Value::as_str)
                .filter(|member| !member.is_empty() && !member.contains('\0'))
                .ok_or("native_job_reference_identity_unavailable")?;
            if !members.insert(member) {
                return Err("native_job_reference_identity_unavailable");
            }
        }
    }
    Ok(rows)
}

fn stable_rows(engine: NativeJobEngine, kind: NativeJobReferenceKind, rows: &[NativeJobRow]) -> Vec<NativeJobRow> {
    let mut rows = rows.to_vec();
    for row in &mut rows {
        if engine == NativeJobEngine::Oracle && kind == NativeJobReferenceKind::ProgramArguments {
            *row = dbx_sql::native_job_arguments::canonical_argument_row(row, true);
        }
        row.remove("DBX_ROW_NUM");
        if kind == NativeJobReferenceKind::Window {
            for field in ["ACTIVE", "NEXT_START_DATE", "LAST_START_DATE"] {
                row.remove(field);
            }
        }
    }
    if kind == NativeJobReferenceKind::DestinationGroupMembers {
        rows.sort_by(|left, right| {
            left.get("MEMBER_NAME").and_then(Value::as_str).cmp(&right.get("MEMBER_NAME").and_then(Value::as_str))
        });
    } else {
        rows.sort_by_key(|row| crate::schema::native_jobs::details::integer(row.get("ARGUMENT_POSITION")).unwrap_or(0));
    }
    rows
}

fn program_ref(row: &NativeJobRow) -> Option<NativeJobObjectReference> {
    Some(NativeJobObjectReference {
        owner: row.get("PROGRAM_OWNER")?.as_str()?.into(),
        name: row.get("PROGRAM_NAME")?.as_str()?.into(),
    })
}

fn cached_program(
    details: &NativeJobDetails,
    request: &NativeJobReferenceListRequest,
) -> Option<NativeJobReferenceCatalog> {
    let reference = row(details).and_then(program_ref)?;
    if request.schema.as_deref() != Some(&reference.owner) || request.name.as_deref() != Some(&reference.name) {
        return None;
    }
    let (objects, source) = if request.kind == NativeJobReferenceKind::Program {
        (crate::schema::native_jobs::details::map_metadata(details.program.clone()?, |row| vec![row]), "program")
    } else if request.kind == NativeJobReferenceKind::ProgramArguments {
        (details.program_arguments.clone()?, "programArguments")
    } else {
        return None;
    };
    Some(NativeJobReferenceCatalog {
        objects,
        source: details.sources.get(source)?.clone(),
        offset: 0,
        limit: request.limit,
    })
}

pub(in crate::schema::native_jobs::operations) async fn prepare<Q, F>(
    binding: &crate::schema::native_jobs::service::BoundContext,
    mutation: &NativeJobMutation,
    original: &NativeJobDetails,
    mut edit: NativeJobSchedulerEditPlan,
    read_reference: &mut Q,
) -> Result<PreparedSchedulerTransition, &'static str>
where
    Q: FnMut(NativeJobReferenceListRequest) -> F,
    F: Future<Output = Result<NativeJobReferenceCatalog, &'static str>>,
{
    let mut dependencies: Vec<BoundReference> = Vec::new();
    let mut program = None;
    let mut program_arguments = None;
    let mut requests = edit
        .references
        .iter()
        .map(|reference| reference_request(&binding.context.scope, reference))
        .collect::<Vec<_>>();
    let destination_group =
        edit.references.iter().any(|reference| reference.target.kind == NativeJobReferenceKind::DestinationGroup);
    for reference in
        edit.references.iter().filter(|reference| reference.target.kind == NativeJobReferenceKind::DestinationGroup)
    {
        let mut request = reference_request(&binding.context.scope, reference);
        request.kind = NativeJobReferenceKind::DestinationGroupMembers;
        request.limit = 10_000;
        requests.push(request);
    }
    if destination_group && edit.definition.get("JOB_TYPE").is_none_or(Value::is_null) {
        let reference = program_ref(&edit.definition).ok_or("native_job_reference_compatibility_unavailable")?;
        requests.push(NativeJobReferenceListRequest {
            scope: binding.context.scope.clone(),
            kind: NativeJobReferenceKind::Program,
            schema: Some(reference.owner),
            name: Some(reference.name),
            filter: String::new(),
            offset: 0,
            limit: 1,
        });
    }
    if edit.argument_target.is_some() && program_ref(&edit.definition).is_some() {
        let reference = program_ref(&edit.definition).unwrap();
        requests.push(NativeJobReferenceListRequest {
            scope: binding.context.scope.clone(),
            kind: NativeJobReferenceKind::ProgramArguments,
            schema: Some(reference.owner),
            name: Some(reference.name),
            filter: String::new(),
            offset: 0,
            limit: 10_000,
        });
    }
    for request in requests {
        if dependencies.iter().any(|bound| {
            bound.request.kind == request.kind
                && bound.request.schema == request.schema
                && bound.request.name == request.name
        }) {
            continue;
        }
        let catalog = if let Some(cached) = cached_program(original, &request) {
            cached
        } else {
            read_reference(request.clone()).await?
        };
        let rows = checked_rows(&request, &catalog)?;
        if request.kind == NativeJobReferenceKind::Program {
            program = Some(NativeJobMetadata::Available { value: rows[0].clone() });
        }
        if request.kind == NativeJobReferenceKind::ProgramArguments {
            program_arguments = Some(NativeJobMetadata::Available { value: rows.clone() });
        }
        dependencies.push(BoundReference { rows: stable_rows(binding.context.engine, request.kind, &rows), request });
    }
    let style = edit.definition.get("JOB_STYLE").and_then(Value::as_str);
    if destination_group && style.is_none() {
        return Err("native_job_reference_compatibility_unavailable");
    }
    let job_type = program
        .as_ref()
        .and_then(|program| match program {
            NativeJobMetadata::Available { value } => value.get("PROGRAM_TYPE").and_then(Value::as_str),
            _ => None,
        })
        .or_else(|| edit.definition.get("JOB_TYPE").and_then(Value::as_str));
    for reference in &edit.references {
        if reference.target.kind == NativeJobReferenceKind::DestinationGroup
            && (job_type == Some("CHAIN")
                || matches!(style, Some("LIGHTWEIGHT" | "IN_MEMORY_RUNTIME" | "IN_MEMORY_FULL")))
        {
            return Err("native_job_reference_not_applicable");
        }
        if reference.attribute == "JOB_ACTION" && !matches!(style, Some("REGULAR" | "IN_MEMORY_FULL")) {
            return Err("native_job_reference_not_applicable");
        }
    }
    let (inventory, layout, retired) = if let Some(target) = &edit.argument_target {
        let NativeJobMetadata::Available { value: inventory } = parse_argument_inventory(&original.parameter_metadata)
        else {
            return Err("native_job_arguments_unavailable");
        };
        let NativeJobMetadata::Available { value: layout } = parse_argument_layout(
            binding.context.engine,
            &NativeJobMetadata::Available { value: edit.definition.clone() },
            program.as_ref(),
            program_arguments.as_ref(),
        ) else {
            return Err("native_job_argument_target_unavailable");
        };
        if target.arguments.len() != layout.len() {
            return Err("native_job_argument_target_incomplete");
        }
        if target.program.is_some() {
            let Some(NativeJobMetadata::Available { value: program_arguments }) = &program_arguments else {
                return Err("native_job_argument_target_unavailable");
            };
            if program_arguments.len() != layout.len() {
                return Err("native_job_argument_target_unavailable");
            }
        }
        let mut resolved = target.clone();
        for argument in &mut resolved.arguments {
            let description = layout
                .iter()
                .find(|description| description.position == argument.position)
                .ok_or("native_job_argument_target_incomplete")?;
            if !description.editable
                && !matches!(argument.value, NativeJobArgumentValue::Unset | NativeJobArgumentValue::Inherit)
            {
                return Err("native_job_argument_not_editable");
            }
            if target.program.is_some() {
                argument.data_type = description.data_type.clone();
            }
        }
        // Recompile using the bound target types, never a stale caller-supplied Program type.
        let mut resolved_mutation = mutation.clone();
        let NativeJobChange::Update { argument_target, .. } = &mut resolved_mutation.change else { unreachable!() };
        *argument_target = Some(resolved);
        edit = native_job_scheduler_edit_plan(binding.context.engine, &resolved_mutation, original)?;
        let retired: HashSet<_> = inventory
            .keys()
            .copied()
            .filter(|position| {
                *position > layout.len()
                    || layout
                        .iter()
                        .find(|argument| argument.position == *position)
                        .is_some_and(|argument| !argument.editable)
            })
            .collect();
        if !retired.is_empty() {
            let NativeJobMetadata::Available { value: old_layout } = parse_argument_layout(
                binding.context.engine,
                &original.snapshot.definition,
                original.program.as_ref(),
                original.program_arguments.as_ref(),
            ) else {
                return Err("native_job_argument_retirement_context_unavailable");
            };
            if retired
                .iter()
                .any(|position| !old_layout.iter().any(|argument| argument.position == *position && argument.editable))
            {
                return Err("native_job_argument_retirement_requires_original_context");
            }
            let NativeJobMetadata::Available { value: identity } = &original.native_identity else {
                return Err("native_job_identity_unverified");
            };
            let mut retiring = Vec::new();
            for position in retired.iter().copied().collect::<std::collections::BTreeSet<_>>() {
                let mut step = scheduler_argument_step(
                    binding.context.engine,
                    &mutation.target,
                    Some(identity),
                    &NativeJobArgumentChange { position, value: NativeJobArgumentValue::Unset },
                    "UNKNOWN",
                )?;
                step.id = format!("retire-argument:{position}");
                step.label = "native_job_step_retire_argument".into();
                retiring.push(step);
            }
            let after_pause =
                edit.sql.steps.iter().position(|step| step.id == "pause").ok_or("native_job_transition_not_paused")?
                    + 1;
            edit.sql.steps.splice(after_pause..after_pause, retiring);
        }
        (Some(inventory), Some(layout), retired)
    } else {
        (None, None, HashSet::new())
    };
    let oracle = if binding.context.engine == NativeJobEngine::Oracle {
        Some(projection::OracleSchedulerProjection::bind(&edit, original, &dependencies)?)
    } else {
        None
    };
    let dameng = if binding.context.engine == NativeJobEngine::Dameng {
        Some(dameng::DamengNamedProjection::bind(&edit, original, &dependencies)?)
    } else {
        None
    };
    Ok(PreparedSchedulerTransition {
        edit,
        dependencies,
        original: original.clone(),
        inventory,
        layout,
        retired,
        oracle,
        dameng,
    })
}

pub(in crate::schema::native_jobs::operations) fn reference_projections_match(
    row: &NativeJobRow,
    references: &[NativeJobSchedulerReferenceBinding],
) -> bool {
    references.iter().all(|binding| {
        if binding.attribute == "JOB_ACTION" {
            let owner = row.get("OWNER").and_then(Value::as_str).unwrap_or("");
            return dbx_sql::native_job_changes::native_job_scheduler_reference_target(
                "JOB_ACTION",
                row.get("JOB_ACTION").unwrap_or(&Value::Null),
                owner,
                "CHAIN",
            )
            .ok()
            .flatten()
            .is_some_and(|target| target == binding.target);
        }
        // Other references are checked as exact, separate owner/name columns by the effect.
        true
    })
}

fn inventory(details: &NativeJobDetails) -> Result<SchedulerArgumentInventory, &'static str> {
    match parse_argument_inventory(&details.parameter_metadata) {
        NativeJobMetadata::Available { value } => Ok(value),
        _ => Err("native_job_arguments_unavailable"),
    }
}

fn same_override(engine: NativeJobEngine, a: &NativeJobRow, b: &NativeJobRow) -> bool {
    if engine == NativeJobEngine::Oracle {
        return dbx_sql::native_job_arguments::decode_argument(a, false)
            == dbx_sql::native_job_arguments::decode_argument(b, false);
    }
    inventory_value(engine, a) == inventory_value(engine, b)
}

pub(in crate::schema::native_jobs::operations) fn same_inventory(
    engine: NativeJobEngine,
    a: &SchedulerArgumentInventory,
    b: &SchedulerArgumentInventory,
) -> bool {
    a.len() == b.len()
        && a.iter().all(|(position, row)| b.get(position).is_some_and(|other| same_override(engine, row, other)))
}

fn desired_value_matches(
    engine: NativeJobEngine,
    actual: Option<&NativeJobRow>,
    desired: &NativeJobArgumentValue,
    data_type: &str,
) -> bool {
    match desired {
        NativeJobArgumentValue::Inherit | NativeJobArgumentValue::Unset => actual.is_none(),
        _ if engine == NativeJobEngine::Oracle => {
            actual.is_some_and(|row| dbx_sql::native_job_arguments::oracle_argument_matches(row, desired, data_type))
        }
        _ => actual.is_some_and(|row| inventory_value(engine, row) == *desired),
    }
}

fn allowed_inventory(
    engine: NativeJobEngine,
    plan: &PreparedSchedulerTransition,
    current: &SchedulerArgumentInventory,
) -> bool {
    let Some(original) = &plan.inventory else { return true };
    let Some(target) = &plan.edit.argument_target else { return false };
    current.iter().all(|(position, row)| {
        original.get(position).is_some_and(|old| same_override(engine, row, old))
            || target
                .arguments
                .iter()
                .find(|argument| argument.position == *position)
                .is_some_and(|argument| desired_value_matches(engine, Some(row), &argument.value, &argument.data_type))
    })
}

fn complete_arguments(
    engine: NativeJobEngine,
    plan: &PreparedSchedulerTransition,
    current: &SchedulerArgumentInventory,
) -> bool {
    let Some(target) = &plan.edit.argument_target else { return true };
    let Some(layout) = &plan.layout else { return false };
    current.keys().all(|position| *position <= layout.len())
        && target.arguments.iter().all(|argument| {
            desired_value_matches(engine, current.get(&argument.position), &argument.value, &argument.data_type)
        })
}

fn argument_type(plan: &PreparedSchedulerTransition, position: usize) -> &str {
    plan.edit
        .argument_target
        .as_ref()
        .and_then(|target| {
            target
                .arguments
                .iter()
                .find(|argument| argument.position == position)
                .map(|argument| argument.data_type.as_str())
        })
        .or_else(|| match &plan.original.snapshot.arguments {
            NativeJobMetadata::Available { value } => {
                value.iter().find(|argument| argument.position == position).map(|argument| argument.data_type.as_str())
            }
            _ => None,
        })
        .unwrap_or("UNKNOWN")
}

async fn check_dependencies(
    engine: NativeJobEngine,
    plan: &PreparedSchedulerTransition,
    session: &mut impl NativeJobMutationSession,
) -> Result<(), &'static str> {
    for bound in &plan.dependencies {
        let current = session.read_reference(bound.request.clone()).await?;
        let rows = checked_rows(&bound.request, &current)?;
        if stable_rows(engine, bound.request.kind, &rows) != bound.rows {
            return Err("native_job_reference_changed");
        }
    }
    Ok(())
}

fn target_definition_matches(
    plan: &PreparedSchedulerTransition,
    current: &NativeJobDetails,
    user: &str,
    engine: NativeJobEngine,
    dameng_active: &HashSet<String>,
) -> Result<bool, &'static str> {
    let mut columns = Vec::new();
    for step in &plan.edit.sql.steps {
        if let NativeJobStepEffect::SchedulerDefinition(effect) = &step.effect {
            for column in &effect.columns {
                columns.retain(|previous: &NativeJobAttributeChange| previous.name != column.name);
                columns.push(column.clone());
            }
        }
    }
    columns.push(NativeJobAttributeChange {
        name: "ENABLED".into(),
        change: NativeJobFieldChange::Set { value: Value::Bool(false) },
    });
    let effect = NativeJobStepEffect::SchedulerDefinition(NativeJobSchedulerDefinitionEffect {
        columns,
        references: plan.edit.references.clone(),
    });
    if let Some(projection) = &plan.oracle {
        projection.verify(&plan.original, current, &effect, true, user)
    } else if let Some(projection) = &plan.dameng {
        Ok(projection.complete(dameng_active)
            && projection.verify(&plan.original, current, &effect, dameng_active, user))
    } else {
        Ok(verify_effect(&plan.original, current, &effect, user, engine))
    }
}

fn mark_skipped(operations: &NativeJobOperations, id: &str, index: usize) {
    operations.edit(id, |status| {
        status.steps[index].state = NativeJobStepState::Skipped;
        status.steps[index].reason = Some("native_job_already_satisfied".into());
    });
}

pub(in crate::schema::native_jobs::operations) async fn run(
    state: &AppState,
    execution: &PreparedExecution,
    id: &str,
    cancel: &CancellationToken,
    session: &mut impl NativeJobMutationSession,
    dispatched: &mut bool,
) -> Result<NativeJobOperationOutcome, (&'static str, NativeJobOperationOutcome)> {
    let PreparedAction::SchedulerTransition { mutation, plan } = &execution.action else { unreachable!() };
    let operations = state.native_jobs.operations();
    let engine = execution.binding.context.engine;
    let user = &execution.binding.context.session_user;
    let mut before =
        session.read(&mutation.target).await.map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
    if let Some(projection) = &plan.oracle {
        projection.validate(&before).map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
    }
    state
        .native_jobs
        .compare_baseline(
            state,
            &mutation.target,
            &mutation.baseline,
            &before.snapshot.revision,
            &plan.edit.sql.required_partitions.iter().map(String::as_str).collect::<Vec<_>>(),
            false,
        )
        .map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
    check_dependencies(engine, plan, session)
        .await
        .map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
    let mut observed = if plan.inventory.is_some() {
        Some(inventory(&before).map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?)
    } else {
        None
    };
    if let (Some(original), Some(current)) = (&plan.inventory, &observed) {
        if !same_inventory(engine, original, current) {
            return Err(("native_job_argument_inventory_changed", NativeJobOperationOutcome::NotApplied));
        }
    }
    operations.edit(id, |status| status.state = NativeJobOperationState::Running);
    let validated = super::run_validations(state, execution, id, cancel, session, &plan.edit.sql.steps).await?;
    if validated != 0 {
        before =
            session.read(&mutation.target).await.map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
        if let Some(projection) = &plan.oracle {
            projection.validate(&before).map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
        }
        state
            .native_jobs
            .compare_baseline(
                state,
                &mutation.target,
                &mutation.baseline,
                &before.snapshot.revision,
                &plan.edit.sql.required_partitions.iter().map(String::as_str).collect::<Vec<_>>(),
                false,
            )
            .map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
        check_dependencies(engine, plan, session)
            .await
            .map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
        if plan.inventory.is_some() {
            let current = inventory(&before).map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
            if observed.as_ref().is_some_and(|previous| !same_inventory(engine, previous, &current)) {
                return Err(("native_job_argument_inventory_changed", NativeJobOperationOutcome::NotApplied));
            }
            observed = Some(current);
        }
    }
    let mut event_applied = !plan.edit.event_changed;
    let mut dameng_active = HashSet::new();
    for (index, step) in plan.edit.sql.steps.iter().enumerate().skip(validated) {
        let failure =
            if *dispatched { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::NotApplied };
        require_write(state, &execution.binding).await.map_err(|reason| (reason, failure))?;
        if cancel.is_cancelled() {
            return Err(("native_job_canceled_after_dispatch", failure));
        }
        if step.id == "enable"
            && (!target_definition_matches(plan, &before, user, engine, &dameng_active)
                .map_err(|reason| (reason, failure))?
                || observed.as_ref().is_some_and(|current| !complete_arguments(engine, plan, current)))
        {
            return Err(("native_job_transition_incomplete", failure));
        }
        if step.id == "enable" || matches!(step.effect, NativeJobStepEffect::SchedulerDefinition(_)) {
            check_dependencies(engine, plan, session).await.map_err(|reason| (reason, failure))?;
            require_write(state, &execution.binding).await.map_err(|reason| (reason, failure))?;
            if cancel.is_cancelled() {
                return Err(("native_job_canceled_after_dispatch", failure));
            }
        }
        if step.id == "pause" {
            match row(&before).and_then(|row| crate::schema::native_jobs::details::boolean(row.get("ENABLED"))) {
                Some(false) => {
                    mark_skipped(operations, id, index);
                    continue;
                }
                Some(true) => {}
                _ => return Err(("native_job_enabled_state_unavailable", failure)),
            }
        } else if row(&before).and_then(|row| crate::schema::native_jobs::details::boolean(row.get("ENABLED")))
            != Some(false)
        {
            return Err(("native_job_transition_not_paused", failure));
        }
        if let (NativeJobStepEffect::Argument(change, _), Some(current)) = (&step.effect, &observed) {
            let desired =
                if step.id.starts_with("retire-argument:") { &NativeJobArgumentValue::Unset } else { &change.value };
            if desired_value_matches(
                engine,
                current.get(&change.position),
                desired,
                argument_type(plan, change.position),
            ) {
                mark_skipped(operations, id, index);
                continue;
            }
            if current.get(&change.position).is_some_and(|actual| {
                !plan
                    .inventory
                    .as_ref()
                    .and_then(|old| old.get(&change.position))
                    .is_some_and(|old| same_override(engine, actual, old))
            }) {
                return Err(("native_job_argument_inventory_changed", failure));
            }
        }
        operations.edit(id, |status| status.steps[index].state = NativeJobStepState::Dispatching);
        *dispatched = true;
        let receipt = session.execute(step).await;
        super::mark(operations, id, index, &receipt);
        if receipt.outcome == NativeJobDispatchOutcome::NotStarted {
            return Err(("native_job_step_not_applied", failure));
        }
        let unknown = receipt.outcome == NativeJobDispatchOutcome::Unknown;
        let failed_read = if unknown { NativeJobOperationOutcome::Unknown } else { NativeJobOperationOutcome::Partial };
        let after = session.read(&mutation.target).await.map_err(|reason| (reason, failed_read))?;
        let next_inventory =
            if observed.is_some() { Some(inventory(&after).map_err(|reason| (reason, failed_read))?) } else { None };
        let next_dameng_active = if let Some(projection) = &plan.dameng {
            check_dependencies(engine, plan, session).await.map_err(|reason| (reason, failed_read))?;
            projection.advance(&dameng_active, &step.effect)
        } else {
            HashSet::new()
        };
        let next_event_applied = event_applied
            || matches!(&step.effect, NativeJobStepEffect::SchedulerDefinition(effect) if effect.columns.iter().any(|column| matches!(column.name.as_str(), "SCHEDULE_NAME" | "SCHEDULE_TYPE" | "EVENT_CONDITION")));
        let verified = match (&step.effect, &observed, &next_inventory) {
            (NativeJobStepEffect::Argument(change, _), Some(old), Some(current)) => {
                let desired = if step.id.starts_with("retire-argument:") {
                    &NativeJobArgumentValue::Unset
                } else {
                    &change.value
                };
                desired_value_matches(
                    engine,
                    current.get(&change.position),
                    desired,
                    argument_type(plan, change.position),
                ) && old.iter().all(|(position, value)| {
                    *position == change.position
                        || current.get(position).is_some_and(|other| same_override(engine, value, other))
                }) && current.keys().all(|position| *position == change.position || old.contains_key(position))
                    && after.native_identity == before.native_identity
                    && matches!(after.consistency, NativeJobMetadata::Available { .. })
                    && if let Some(projection) = &plan.oracle {
                        projection.preserved(&before, &after, event_applied).map_err(|reason| (reason, failed_read))?
                    } else if let Some(projection) = &plan.dameng {
                        projection.preserved(&before, &after, &next_dameng_active)
                    } else {
                        preserved_definition(&before, &after, &NativeJobStepEffect::Completed, engine)
                    }
            }
            _ => {
                if let Some(projection) = &plan.oracle {
                    projection
                        .verify(&before, &after, &step.effect, next_event_applied, user)
                        .map_err(|reason| (reason, failed_read))?
                } else if let Some(projection) = &plan.dameng {
                    projection.verify(&before, &after, &step.effect, &next_dameng_active, user)
                } else {
                    verify_effect(&before, &after, &step.effect, user, engine)
                }
            }
        };
        if !verified || next_inventory.as_ref().is_some_and(|current| !allowed_inventory(engine, plan, current)) {
            return Err(("native_job_readback_not_verified", failed_read));
        }
        if engine == NativeJobEngine::Dameng
            && !dameng_active.contains("PROGRAM_NAME")
            && next_dameng_active.contains("PROGRAM_NAME")
            && next_inventory.as_ref().is_some_and(|current| {
                plan.edit.argument_target.as_ref().is_some_and(|target| {
                    target.arguments.iter().any(|argument| {
                        matches!(argument.value, NativeJobArgumentValue::Unset | NativeJobArgumentValue::Inherit)
                            && current.contains_key(&argument.position)
                    })
                })
            })
        {
            return Err(("native_job_argument_reset_mapping_unverified", failed_read));
        }
        if matches!(step.effect, NativeJobStepEffect::SchedulerDefinition(_)) {
            if next_inventory
                .as_ref()
                .is_some_and(|current| plan.retired.iter().any(|position| current.contains_key(position)))
            {
                return Err(("native_job_argument_inventory_changed", NativeJobOperationOutcome::Partial));
            }
        } else if !matches!(step.effect, NativeJobStepEffect::Argument(..)) {
            if let (Some(old), Some(current)) = (&observed, &next_inventory) {
                if !same_inventory(engine, old, current) {
                    return Err(("native_job_argument_inventory_changed", failed_read));
                }
            }
        }
        operations.edit(id, |status| status.steps[index].state = NativeJobStepState::Applied);
        before = after;
        observed = next_inventory;
        event_applied = next_event_applied;
        dameng_active = next_dameng_active;
    }
    if !plan.edit.final_enabled
        && (!target_definition_matches(plan, &before, user, engine, &dameng_active)
            .map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?
            || observed.as_ref().is_some_and(|current| !complete_arguments(engine, plan, current)))
    {
        return Err(("native_job_transition_incomplete", NativeJobOperationOutcome::Partial));
    }
    if !plan.edit.final_enabled {
        check_dependencies(engine, plan, session)
            .await
            .map_err(|reason| (reason, NativeJobOperationOutcome::Partial))?;
    }
    Ok(NativeJobOperationOutcome::Verified)
}
