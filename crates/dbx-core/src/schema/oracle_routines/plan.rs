use super::operations::RoutineWriteBinding;
use super::references::{resolve_draft, CatalogReadProof, ResolvedRoutineReference, SelectedFinalDraft};
use super::*;
use dbx_sql::object_source_sql::{
    analyze_oracle_routine_draft, prepare_oracle_routine_definition, validate_oracle_routine_target_definition,
    EditableObjectSourceSqlInput, OracleDraftIssue, OracleRoutineDefinitionInput,
};
use std::collections::BTreeSet;

mod recovery;
pub use recovery::prepare_oracle_routine_recovery_core;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoutinePlanAction {
    Create,
    Replace,
    Delete,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutinePlanDraft {
    pub identity: RoutineIdentity,
    pub action: RoutinePlanAction,
    pub source_name: Option<String>,
    // None generates the initial declaration-only adaptation. Some is the
    // user's final draft and must validate before any normalization.
    pub sql: Option<String>,
    pub baseline_operation_id: Option<String>,
    pub supersedes_operation_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleRoutinePlanInput {
    pub source: RoutineSnapshot,
    pub target: RoutineSnapshot,
    pub drafts: Vec<RoutinePlanDraft>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleRoutinePlanStep {
    pub identity: RoutineIdentity,
    pub action: RoutinePlanAction,
    pub sql: String,
    pub source_original: Option<String>,
    pub target_original: Option<String>,
    pub recovery_sql: Option<String>,
    pub recovery_complete: bool,
    pub references: Vec<ResolvedRoutineReference>,
    pub incoming_callers: Vec<RoutineDependency>,
    pub issues: Vec<OracleDraftIssue>,
    pub operation: Option<RoutineOperationRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleRoutinePlan {
    pub target: RoutineEndpoint,
    pub steps: Vec<OracleRoutinePlanStep>,
    pub ready: bool,
}

#[derive(Clone, Serialize)]
pub(super) enum ExpectedRoutine {
    Absent(RoutineIdentity),
    Present(RoutineObjectSnapshot),
}

impl ExpectedRoutine {
    fn identity(&self) -> &RoutineIdentity {
        match self {
            Self::Absent(identity) => identity,
            Self::Present(object) => &object.version.identity,
        }
    }
}

#[derive(Clone, Serialize)]
pub(super) struct SourcePreflight {
    pub endpoint: RoutineEndpoint,
    pub config: ConnectionConfig,
    pub expected: ExpectedRoutine,
}

#[derive(Clone, Serialize)]
pub(super) struct ComparePreflight {
    pub source: Option<SourcePreflight>,
    pub target: ExpectedRoutine,
    pub proofs: Vec<CatalogReadProof>,
    pub incoming: Option<Vec<RoutineDependency>>,
    pub selected: Vec<RoutineIdentity>,
}

fn problem(message: impl Into<String>) -> OracleDraftIssue {
    OracleDraftIssue { code: "plan-preflight".into(), message: message.into(), line: 1, column: 1 }
}
fn ddl_input(endpoint: &RoutineEndpoint, identity: &RoutineIdentity, sql: String) -> EditableObjectSourceSqlInput {
    EditableObjectSourceSqlInput {
        database_type: endpoint.database_type,
        object_type: identity.kind.clone(),
        schema: Some(identity.owner.clone()),
        name: identity.name.clone(),
        source: sql,
    }
}
fn drop_sql(identity: &RoutineIdentity) -> String {
    format!(
        "DROP {} \"{}\".\"{}\";",
        kind_name(&identity.kind),
        identity.owner.replace('"', "\"\""),
        identity.name.replace('"', "\"\"")
    )
}
fn adapted(
    endpoint: &RoutineEndpoint,
    identity: &RoutineIdentity,
    source_owner: &str,
    source: &str,
    replace: bool,
) -> Result<String, String> {
    prepare_oracle_routine_definition(OracleRoutineDefinitionInput {
        database_type: endpoint.database_type,
        object_type: identity.kind.clone(),
        source_owner: source_owner.into(),
        target_owner: identity.owner.clone(),
        name: identity.name.clone(),
        source: source.into(),
        replace,
    })
}

/// Complete incoming scope is specific to destructive comparison steps. It is
/// deliberately not used by ordinary saves or legacy structure transfer.
pub(super) async fn incoming_dependencies(
    catalog: &impl RoutineCatalog,
    identity: &RoutineIdentity,
) -> Result<Vec<RoutineDependency>, String> {
    let mut result = Vec::new();
    loop {
        let offset = result.len();
        let reply = catalog
            .query(&format!(
                "SELECT * FROM (SELECT OWNER, NAME, TYPE, REFERENCED_LINK_NAME, DEPENDENCY_TYPE, \
             ROW_NUMBER() OVER (ORDER BY OWNER, NAME, TYPE, REFERENCED_LINK_NAME, DEPENDENCY_TYPE) RN \
             FROM SYS.DBA_DEPENDENCIES WHERE REFERENCED_OWNER = {} AND REFERENCED_NAME = {} AND REFERENCED_TYPE = {}) \
             WHERE RN > {offset} AND RN <= {} ORDER BY RN",
                literal(&identity.owner),
                literal(&identity.name),
                literal(kind_name(&identity.kind)),
                offset + PAGE_SIZE,
            ))
            .await?;
        reply.flags.check()?;
        if reply.rows.len() > PAGE_SIZE {
            return Err("Incoming dependency metadata exceeded its page size".into());
        }
        for row in &reply.rows {
            if reply.integer(row, "RN")? != result.len() as u64 + 1 {
                return Err("Incoming dependency pagination is incomplete".into());
            }
            let link = match reply.cell(row, "REFERENCED_LINK_NAME")? {
                Value::Null => None,
                Value::String(value) if value.is_empty() => None,
                Value::String(value) => Some(value.clone()),
                _ => return Err("Incoming dependency link is unknown".into()),
            };
            result.push(RoutineDependency {
                owner: reply.text(row, "OWNER")?,
                name: reply.text(row, "NAME")?,
                kind: reply.text(row, "TYPE")?,
                database_link: link,
                dependency_type: reply.text(row, "DEPENDENCY_TYPE")?,
            });
        }
        if reply.rows.len() < PAGE_SIZE {
            result.sort();
            return Ok(result);
        }
    }
}

pub(super) async fn verify_expected(
    catalog: &impl RoutineCatalog,
    endpoint: &RoutineEndpoint,
    expected: &ExpectedRoutine,
    origin: SourceOrigin,
) -> Result<(), String> {
    let current =
        readback::readback(catalog, endpoint, expected.identity().clone(), &RoutineReadbackGoal::Inspect, origin).await;
    if !current.issues.is_empty() {
        return Err(current.issues.iter().map(|issue| issue.message.as_str()).collect::<Vec<_>>().join("\n"));
    }
    match expected {
        ExpectedRoutine::Absent(_) if current.exists == Some(false) => Ok(()),
        ExpectedRoutine::Present(before) if before.source_complete && current.version.as_ref() == Some(&before.version) && current.source == before.source => {
            if before.dependencies_complete && dependencies(catalog, &before.version.identity).await? != before.dependencies {
                return Err("Routine dependency snapshot changed; refresh and validate the preserved draft".into());
            }
            Ok(())
        }
        _ => Err("Routine identity, definition, status or namespace changed since preview; refresh and validate the preserved draft".into()),
    }
}

fn external_incoming(values: &[RoutineDependency], selected: &[RoutineIdentity]) -> Vec<RoutineDependency> {
    values
        .iter()
        .filter(|dependency| {
            !selected.iter().any(|identity| {
                identity.owner == dependency.owner
                    && identity.name == dependency.name
                    && kind_name(&identity.kind) == dependency.kind
            })
        })
        .cloned()
        .collect()
}

pub(super) async fn verify_compare_preflight(
    source: Option<&impl RoutineCatalog>,
    target: &impl RoutineCatalog,
    endpoint: &RoutineEndpoint,
    preflight: &ComparePreflight,
    target_origin: SourceOrigin,
) -> Result<(), String> {
    if let Some(before) = &preflight.source {
        let source = source.ok_or("Original source connection is unavailable")?;
        let (_, origin) = routine_source_origin(&before.config)?;
        verify_expected(source, &before.endpoint, &before.expected, origin).await?;
    }
    verify_expected(target, endpoint, &preflight.target, target_origin).await?;
    for proof in &preflight.proofs {
        proof.verify(target).await?;
    }
    if let Some(before) = &preflight.incoming {
        let current = incoming_dependencies(target, preflight.target.identity()).await?;
        if external_incoming(&current, &preflight.selected) != external_incoming(before, &preflight.selected) {
            return Err("Incoming callers changed after preview; refresh the affected step before writing".into());
        }
    }
    Ok(())
}

async fn checked_endpoint(state: &AppState, endpoint: &RoutineEndpoint) -> Result<ConnectionConfig, String> {
    let config = connection_config(state, &endpoint.connection_id).await.ok_or("Original connection not found")?;
    let (actual, _) = routine_source_origin(&config)?;
    if actual != endpoint.database_type || endpoint.schema.is_empty() {
        return Err("Routine endpoint does not match its actual engine/schema".into());
    }
    LiveCatalog { state, endpoint, config: &config }.check_endpoint().await?;
    Ok(config)
}

fn snapshot_object(snapshot: &RoutineSnapshot, name: &str) -> Result<Option<RoutineObjectSnapshot>, String> {
    let objects: Vec<_> = snapshot
        .objects
        .iter()
        .filter(|object| {
            object.version.identity.name == name && object.version.identity.owner == snapshot.endpoint.schema
        })
        .collect();
    match objects.as_slice() {
        [] => Ok(None),
        [object] => Ok(Some((*object).clone())),
        _ => Err("Routine snapshot has conflicting namespace identities".into()),
    }
}

fn terminal_baseline(
    state: &AppState,
    id: &str,
    endpoint: &RoutineEndpoint,
    identity: &RoutineIdentity,
) -> Result<ExpectedRoutine, String> {
    let record = state
        .routine_operations
        .observe(id)
        .operation
        .ok_or("Original operation is unavailable; only observe its original ID")?;
    correction_baseline(record, endpoint, identity)
}

fn correction_baseline(
    record: RoutineOperationRecord,
    endpoint: &RoutineEndpoint,
    identity: &RoutineIdentity,
) -> Result<ExpectedRoutine, String> {
    if record.target != *endpoint
        || record.identity != *identity
        || record.lifecycle != RoutineOperationLifecycle::Terminal
        || !record.dispatched
    {
        return Err("Correction requires a terminal operation on the same original target".into());
    }
    let readback = record.readback.ok_or("Read the original operation's complete current result before correction")?;
    if !readback.issues.is_empty() {
        return Err("Original operation readback is incomplete; retain its draft and refresh the result".into());
    }
    if readback.exists == Some(true) && readback.definition_matches != Some(true) {
        return Err("Current definition does not match the original approved write; refresh and review the target baseline before replacing it".into());
    }
    match (readback.exists, readback.version, readback.source) {
        (Some(false), _, _) => Ok(ExpectedRoutine::Absent(identity.clone())),
        (Some(true), Some(version), Some(source)) => Ok(ExpectedRoutine::Present(RoutineObjectSnapshot {
            version,
            source: Some(source),
            source_complete: true,
            dependencies: Vec::new(),
            dependencies_complete: false,
            issues: Vec::new(),
        })),
        _ => Err("Original operation has no complete baseline for correction".into()),
    }
}

pub async fn prepare_oracle_routine_plan_core(
    state: &AppState,
    input: OracleRoutinePlanInput,
) -> Result<OracleRoutinePlan, String> {
    let _input_pins = input
        .drafts
        .iter()
        .flat_map(|draft| draft.baseline_operation_id.iter().chain(draft.supersedes_operation_id.iter()))
        .map(|id| state.routine_operations.pin(id))
        .collect::<Result<Vec<_>, _>>()?;
    if input.source.endpoint.database_type != input.target.endpoint.database_type {
        return Err("Cross-product Oracle routine conversion is read-only".into());
    }
    if input.drafts.is_empty() {
        return Err("Select at least one changed routine".into());
    }
    if input
        .drafts
        .iter()
        .any(|draft| !matches!(draft.identity.kind, db::ObjectSourceKind::Procedure | db::ObjectSourceKind::Function))
    {
        return Err("Routine plans accept only exact standalone procedure/function identities".into());
    }
    let source_config = checked_endpoint(state, &input.source.endpoint).await?;
    let target_config = checked_endpoint(state, &input.target.endpoint).await?;
    let source = LiveCatalog { state, endpoint: &input.source.endpoint, config: &source_config };
    let target = LiveCatalog { state, endpoint: &input.target.endpoint, config: &target_config };
    let (_, source_origin) = routine_source_origin(&source_config)?;
    let (_, target_origin) = routine_source_origin(&target_config)?;
    let mut built = build_plan(&source, &target, &input, source_origin, target_origin, |draft| {
        draft
            .baseline_operation_id
            .as_deref()
            .map(|id| terminal_baseline(state, id, &input.target.endpoint, &draft.identity))
            .transpose()
    })
    .await;
    if !built.plan.ready {
        return Ok(built.plan);
    }
    let mut operations: BTreeMap<usize, String> = BTreeMap::new();
    let mut requests = Vec::new();
    let mut indices = Vec::new();
    for index in built.order {
        let step = &mut built.plan.steps[index];
        let dependencies = built.dependencies[index]
            .iter()
            .map(|dependency| operations.get(dependency).cloned().ok_or("Routine plan order is incomplete"))
            .collect::<Result<Vec<_>, _>>()?;
        let preflight = built.preflights[index].take().ok_or("Routine preflight is unavailable")?;
        let source_preflight = SourcePreflight {
            endpoint: input.source.endpoint.clone(),
            config: source_config.clone(),
            expected: built.source_expected[index].clone().ok_or("Source snapshot is unavailable")?,
        };
        let operation_id = uuid::Uuid::new_v4().to_string();
        requests.push(super::operations::PreparedRoutineWrite {
            operation_id: operation_id.clone(),
            binding: RoutineWriteBinding {
                target: input.target.endpoint.clone(),
                identity: step.identity.clone(),
                sql: step.sql.clone(),
                goal: if step.action == RoutinePlanAction::Delete {
                    RoutineReadbackGoal::Absent
                } else {
                    RoutineReadbackGoal::Definition { sql: step.sql.clone() }
                },
                expected_config: target_config.clone(),
                require_absent: step.action == RoutinePlanAction::Create,
                compare: Some(ComparePreflight { source: Some(source_preflight), ..preflight }),
                prerequisite_operation_ids: dependencies,
            },
            supersedes: input.drafts[index].supersedes_operation_id.clone(),
        });
        operations.insert(index, operation_id);
        indices.push(index);
    }
    let prepared = state.routine_operations.prepare_batch(requests, 0)?;
    for (index, operation) in indices.into_iter().zip(prepared) {
        built.plan.steps[index].operation = Some(operation);
    }
    // Present the actual server-enforced order, not merely frontend sorting.
    built.plan.steps.sort_by_key(|step| {
        operations
            .iter()
            .find_map(|(index, id)| {
                step.operation
                    .as_ref()
                    .filter(|operation| operation.operation_id == *id)
                    .map(|_| built.order_position[*index])
            })
            .unwrap_or(usize::MAX)
    });
    Ok(built.plan)
}

struct BuiltPlan {
    plan: OracleRoutinePlan,
    preflights: Vec<Option<ComparePreflight>>,
    source_expected: Vec<Option<ExpectedRoutine>>,
    dependencies: Vec<BTreeSet<usize>>,
    order: Vec<usize>,
    order_position: Vec<usize>,
}

async fn build_plan(
    source: &impl RoutineCatalog,
    target: &impl RoutineCatalog,
    input: &OracleRoutinePlanInput,
    source_origin: SourceOrigin,
    target_origin: SourceOrigin,
    baseline: impl Fn(&RoutinePlanDraft) -> Result<Option<ExpectedRoutine>, String>,
) -> BuiltPlan {
    let mut plan = OracleRoutinePlan { target: input.target.endpoint.clone(), steps: Vec::new(), ready: false };
    let mut selected = Vec::new();
    let mut preflights = Vec::new();
    let mut source_expected = Vec::new();
    let mut seen = BTreeSet::new();
    for draft in &input.drafts {
        let mut step = OracleRoutinePlanStep {
            identity: draft.identity.clone(),
            action: draft.action,
            sql: draft.sql.clone().unwrap_or_default(),
            source_original: None,
            target_original: None,
            recovery_sql: None,
            recovery_complete: draft.action != RoutinePlanAction::Delete,
            references: Vec::new(),
            incoming_callers: Vec::new(),
            issues: Vec::new(),
            operation: None,
        };
        let mut source_before = None;
        let mut before = None;
        let prepared: Result<(), String> = async {
            if draft.identity.owner != input.target.endpoint.schema || draft.identity.name.is_empty() || !matches!(draft.identity.kind, db::ObjectSourceKind::Function | db::ObjectSourceKind::Procedure) { return Err("Every step must retain its exact selected target identity".into()); }
            if !seen.insert((draft.identity.owner.clone(), draft.identity.name.clone())) { return Err("The same shared namespace target is selected more than once".into()); }
            let source_name = draft.source_name.as_deref().unwrap_or(&draft.identity.name);
            if source_name != draft.identity.name { return Err("Routine rename mappings require a separate reviewed lifecycle; keep this comparison's exact name".into()); }
            let source_object = snapshot_object(&input.source, source_name)?;
            let target_object = snapshot_object(&input.target, &draft.identity.name)?;
            step.source_original = source_object.as_ref().and_then(|object| object.source.clone());
            step.target_original = target_object.as_ref().and_then(|object| object.source.clone());
            source_before = Some(if draft.action == RoutinePlanAction::Delete {
                if !input.source.enumeration_complete || source_object.is_some() { return Err("Deletion requires complete source enumeration and a confirmed absent source identity".into()); }
                ExpectedRoutine::Absent(RoutineIdentity { owner: input.source.endpoint.schema.clone(), ..draft.identity.clone() })
            } else {
                let object = source_object.ok_or("Source routine is not present in the complete preview")?;
                if object.version.identity.kind != draft.identity.kind || !object.source_complete { return Err("Source kind or complete definition is not verified".into()); }
                ExpectedRoutine::Present(object)
            });
            let mut expected = match baseline(draft)? {
                Some(expected) => expected,
                None => match target_object {
                    Some(object) => ExpectedRoutine::Present(object),
                    None if input.target.enumeration_complete => ExpectedRoutine::Absent(draft.identity.clone()),
                    None => return Err("Target absence is not proven by this preview".into()),
                },
            };
            match (&expected, draft.action) {
                (ExpectedRoutine::Absent(_), RoutinePlanAction::Create) => {}
                (ExpectedRoutine::Present(object), RoutinePlanAction::Replace | RoutinePlanAction::Delete) => {
                    if object.version.identity != draft.identity || !object.source_complete { return Err("Target kind conflicts or its complete definition is unavailable".into()); }
                    step.target_original = object.source.clone();
                }
                _ => return Err("The selected operation no longer matches the target's existence; refresh the plan without discarding the draft".into()),
            }
            if draft.action == RoutinePlanAction::Delete {
                let exact = drop_sql(&draft.identity);
                if draft.sql.as_ref().is_some_and(|sql| sql.trim() != exact) { return Err("A deletion must contain only the exact selected DROP statement".into()); }
                step.sql = exact;
            } else {
                let replace = draft.action == RoutinePlanAction::Replace;
                step.sql = if let Some(sql) = &draft.sql {
                    validate_oracle_routine_target_definition(ddl_input(&input.target.endpoint, &draft.identity, sql.clone()), if replace { None } else { Some(false) })?;
                    adapted(&input.target.endpoint, &draft.identity, &draft.identity.owner, sql, replace)?
                } else {
                    adapted(&input.target.endpoint, &draft.identity, &input.source.endpoint.schema, step.source_original.as_deref().ok_or("Complete source is unavailable")?, replace)?
                };
            }
            step.recovery_sql = match &expected {
                ExpectedRoutine::Absent(_) => Some(drop_sql(&draft.identity)),
                ExpectedRoutine::Present(object) => Some(adapted(&input.target.endpoint, &draft.identity, &draft.identity.owner, object.source.as_deref().ok_or("Original target definition is unavailable")?, draft.action != RoutinePlanAction::Delete)?),
            };
            if matches!(&expected, ExpectedRoutine::Present(object) if !object.dependencies_complete) && draft.baseline_operation_id.is_none() { return Err("Target dependency snapshot is incomplete; refresh it before a destructive step".into()); }
            verify_expected(source, &input.source.endpoint, source_before.as_ref().unwrap(), source_origin).await?;
            verify_expected(target, &input.target.endpoint, &expected, target_origin).await?;
            if let ExpectedRoutine::Present(object) = &mut expected {
                if !object.dependencies_complete {
                    object.dependencies = dependencies(target, &object.version.identity).await?;
                    object.dependencies_complete = true;
                }
            }
            before = Some(expected);
            Ok(())
        }.await;
        if let Err(error) = prepared {
            step.issues.push(problem(error));
        }
        let analysis = if draft.action == RoutinePlanAction::Delete {
            None
        } else {
            let analysis =
                analyze_oracle_routine_draft(ddl_input(&input.target.endpoint, &draft.identity, step.sql.clone()));
            step.issues.extend(analysis.issues.clone());
            Some(analysis)
        };
        selected.push(SelectedFinalDraft { identity: draft.identity.clone(), analysis });
        preflights.push(before.map(|target| ComparePreflight {
            source: None,
            target,
            proofs: Vec::new(),
            incoming: None,
            selected: input.drafts.iter().map(|draft| draft.identity.clone()).collect(),
        }));
        source_expected.push(source_before);
        plan.steps.push(step);
    }
    let mut dependencies = vec![BTreeSet::new(); plan.steps.len()];
    for index in 0..plan.steps.len() {
        if !plan.steps[index].issues.is_empty() {
            continue;
        }
        if plan.steps[index].action != RoutinePlanAction::Delete {
            let resolution = resolve_draft(target, &input.target.endpoint, &selected, index).await;
            plan.steps[index].issues.extend(resolution.issues);
            plan.steps[index].references = resolution.references;
            dependencies[index] = resolution.selected_dependencies;
            preflights[index].as_mut().unwrap().proofs = resolution.proofs;
        }
        if plan.steps[index].action != RoutinePlanAction::Create {
            match incoming_dependencies(target, &plan.steps[index].identity).await {
                Ok(incoming) => {
                    plan.steps[index].incoming_callers = incoming.clone();
                    if plan.steps[index].action == RoutinePlanAction::Delete {
                        for caller in &incoming {
                            if caller.owner == plan.steps[index].identity.owner
                                && caller.name == plan.steps[index].identity.name
                                && caller.kind == kind_name(&plan.steps[index].identity.kind)
                            {
                                continue;
                            }
                            match input.drafts.iter().position(|draft| draft.identity.owner == caller.owner && draft.identity.name == caller.name && kind_name(&draft.identity.kind) == caller.kind) {
                                Some(caller_index) => { dependencies[index].insert(caller_index); }
                                None => plan.steps[index].issues.push(problem(format!("Caller {}.{} ({}) is outside the deletion/correction selection; remove its dependency first", caller.owner, caller.name, caller.kind))),
                            }
                        }
                    }
                    preflights[index].as_mut().unwrap().incoming = Some(incoming);
                }
                Err(error) => plan.steps[index].issues.push(problem(format!(
                    "Complete incoming dependency visibility is required for this destructive step: {error}"
                ))),
            }
        }
    }
    let mut order = Vec::new();
    let mut remaining: BTreeSet<_> = (0..plan.steps.len()).collect();
    while let Some(next) = remaining
        .iter()
        .copied()
        .find(|index| dependencies[*index].iter().all(|dependency| !remaining.contains(dependency)))
    {
        remaining.remove(&next);
        order.push(next);
    }
    for index in remaining {
        plan.steps[index].issues.push(problem(
            "Selected final drafts have an unresolved dependency cycle; correct the draft or reduce the selection",
        ));
    }
    plan.ready = plan.steps.iter().all(|step| step.issues.is_empty()) && order.len() == plan.steps.len();
    let mut order_position = vec![usize::MAX; plan.steps.len()];
    for (position, index) in order.iter().enumerate() {
        order_position[*index] = position;
    }
    BuiltPlan { plan, preflights, source_expected, dependencies, order, order_position }
}

#[cfg(test)]
mod tests;
