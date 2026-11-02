use super::operations::RoutineWriteBinding;
use super::references::{
    reference_proof_manifest, resolve_draft, resolve_draft_with_tables, CatalogReadProof, PlannedRelation,
    ReferenceProofGroup, ReferenceProofPurpose, ResolvedRoutineReference, SelectedFinalDraft,
};
use super::*;
use dbx_sql::object_source_sql::{
    analyze_oracle_routine_draft, compact_oracle_ddl, prepare_oracle_routine_definition,
    validate_oracle_routine_target_definition, EditableObjectSourceSqlInput, OracleDraftIssue,
    OracleRoutineDefinitionInput,
};
use std::collections::BTreeSet;

mod package;
mod recovery;
pub(super) use package::{
    effective_preflight, effective_prerequisite, observed_body_preflight, package_save_preflight, same_observation,
    validate_post_state,
};
use package::{ExpectedPackagePair, PackagePreflight, RoutineBaseline};
pub use package::{PackageBodySource, PackageContractChoice, PackageGrant, PackageGrantSnapshot, PackagePlanImpact};
pub use recovery::prepare_oracle_routine_recovery_core;
#[cfg(test)]
pub(super) use recovery::prepare_package_recovery;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoutinePlanAction {
    Create,
    Replace,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub package_body_source: Option<PackageBodySource>,
    pub package_contract: Option<PackageContractChoice>,
    #[serde(default)]
    pub confirm_package_pair: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleRoutinePlanInput {
    pub source: RoutineSnapshot,
    pub target: RoutineSnapshot,
    pub drafts: Vec<RoutinePlanDraft>,
    #[serde(default)]
    pub compact_sql: bool,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_impact: Option<PackagePlanImpact>,
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
    pub package_pair: Option<ExpectedPackagePair>,
}

#[derive(Clone, Serialize)]
pub(super) struct ComparePreflight {
    pub source: Option<SourcePreflight>,
    pub target: ExpectedRoutine,
    pub proofs: Vec<CatalogReadProof>,
    pub incoming: Option<Vec<RoutineDependency>>,
    pub selected: Vec<RoutineIdentity>,
    pub package: Option<PackagePreflight>,
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
    if matches!(expected, ExpectedRoutine::Present(object) if matches!(object.version.identity.kind, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody) && object.source_origin.is_none())
    {
        return Err("Refresh the complete package snapshot with its actual source origin before approval".into());
    }
    let current =
        readback::readback(catalog, endpoint, expected.identity().clone(), &RoutineReadbackGoal::Inspect, origin).await;
    verify_observation(catalog, expected, &current).await
}

async fn verify_observation(
    catalog: &impl RoutineCatalog,
    expected: &ExpectedRoutine,
    current: &RoutineReadback,
) -> Result<(), String> {
    if !current.issues.is_empty() {
        return Err(current.issues.iter().map(|issue| issue.message.as_str()).collect::<Vec<_>>().join("\n"));
    }
    match expected {
        ExpectedRoutine::Absent(_) if current.exists == Some(false) => Ok(()),
        ExpectedRoutine::Present(before) if before.source_complete && current.version.as_ref() == Some(&before.version) && current.source == before.source => {
            if before.source_origin.is_some() && current.source_origin != before.source_origin {
                return Err("The package source origin changed since preview; refresh and validate the preserved draft".into());
            }
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

pub(super) async fn verify_transfer_preflights(
    writes: &[(String, RoutineWriteBinding)],
    source: &impl RoutineCatalog,
    target: &impl RoutineCatalog,
    origin: SourceOrigin,
) -> Result<(), String> {
    for (index, (_, binding)) in writes.iter().enumerate() {
        let compare = binding.compare.as_ref().ok_or("The original package preflight is missing")?;
        let mut initial_pair = None;
        if binding.identity.kind == db::ObjectSourceKind::PackageBody {
            if let Some(package) = &compare.package {
                if matches!(&package.pair.specification, ExpectedRoutine::Absent(specification)
                    if writes[..index].iter().any(|(id, before)| binding.prerequisite_operation_ids.contains(id)
                        && before.require_absent && before.target == binding.target && before.identity == *specification
                        && before.identity.kind == db::ObjectSourceKind::Package))
                {
                    let mut initial = compare.clone();
                    initial.package.as_mut().unwrap().require_valid_specification = false;
                    initial_pair = Some(initial);
                }
            }
        }
        verify_compare_preflight(
            Some(source),
            target,
            &binding.target,
            initial_pair.as_ref().unwrap_or(compare),
            origin,
        )
        .await?;
    }
    Ok(())
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
        if let Some(pair) = &before.package_pair {
            package::verify_pair(source, &before.endpoint, pair, origin).await?;
        } else {
            verify_expected(source, &before.endpoint, &before.expected, origin).await?;
        }
    }
    if let Some(package) = &preflight.package {
        let current = package::verify_pair(target, endpoint, &package.pair, target_origin).await?;
        if package.require_valid_specification && current.state != RoutineReadbackState::Present {
            return Err(
                "The body dispatch requires its current complete VALID specification without compiler errors".into()
            );
        }
    } else {
        verify_expected(target, endpoint, &preflight.target, target_origin).await?;
    }
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

pub(super) async fn checked_endpoint(state: &AppState, endpoint: &RoutineEndpoint) -> Result<ConnectionConfig, String> {
    let config = connection_config(state, &endpoint.connection_id).await.ok_or("Original connection not found")?;
    let (actual, _) = routine_source_origin(&config)?;
    if actual != endpoint.database_type || endpoint.schema.is_empty() {
        return Err("Routine endpoint does not match its actual engine/schema".into());
    }
    LiveCatalog { state, endpoint, config: &config }.check_endpoint().await?;
    Ok(config)
}

fn snapshot_object(
    snapshot: &RoutineSnapshot,
    name: &str,
    kind: &db::ObjectSourceKind,
) -> Result<Option<RoutineObjectSnapshot>, String> {
    let objects: Vec<_> = snapshot
        .objects
        .iter()
        .filter(|object| {
            object.version.identity.name == name && object.version.identity.owner == snapshot.endpoint.schema
        })
        .collect();
    let counterpart = match kind {
        db::ObjectSourceKind::Package => Some(db::ObjectSourceKind::PackageBody),
        db::ObjectSourceKind::PackageBody => Some(db::ObjectSourceKind::Package),
        _ => None,
    };
    let mut found = None;
    let mut companion = false;
    for object in objects {
        if object.version.identity.kind == *kind {
            if found.replace(object.clone()).is_some() {
                return Err("Routine snapshot has duplicate exact object identities".into());
            }
        } else if counterpart.as_ref() == Some(&object.version.identity.kind) && !companion {
            companion = true;
        } else {
            return Err("Routine snapshot has conflicting namespace identities".into());
        }
    }
    Ok(found)
}

fn terminal_plan_baseline(
    registry: &RoutineOperationRegistry,
    id: &str,
    endpoint: &RoutineEndpoint,
    identity: &RoutineIdentity,
) -> Result<RoutineBaseline, String> {
    let record =
        registry.observe(id).operation.ok_or("Original operation is unavailable; only observe its original ID")?;
    let selected = correction_baseline(record.clone(), endpoint, identity)?;
    let companion = if package::is_package(&identity.kind) {
        let companion = record
            .readback
            .as_ref()
            .and_then(|readback| readback.package_companion.as_ref())
            .ok_or("Read the original operation's complete package pair before correction")?;
        if companion.identity != package::counterpart(identity) {
            return Err("The original operation returned another package companion identity".into());
        }
        Some(package::observation_baseline(companion)?)
    } else {
        None
    };
    Ok(RoutineBaseline { selected, companion })
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
            source_origin: readback.source_origin,
            source_complete: true,
            dependencies: Vec::new(),
            dependencies_complete: false,
            issues: Vec::new(),
        })),
        _ => Err("Original operation has no complete baseline for correction".into()),
    }
}

fn check_plan_selection(input: &OracleRoutinePlanInput) -> Result<(), String> {
    if input.source.endpoint.database_type != input.target.endpoint.database_type
        && (![input.source.endpoint.database_type, input.target.endpoint.database_type]
            .into_iter()
            .all(|product| matches!(product, DatabaseType::Oracle | DatabaseType::OceanbaseOracle))
            || input.drafts.iter().any(|draft| !package::is_package(&draft.identity.kind)))
    {
        return Err("Cross-product Oracle routine conversion is read-only".into());
    }
    if input.drafts.is_empty() {
        return Err("Select at least one changed routine".into());
    }
    if input.drafts.iter().any(|draft| {
        !matches!(
            draft.identity.kind,
            db::ObjectSourceKind::Procedure
                | db::ObjectSourceKind::Function
                | db::ObjectSourceKind::Package
                | db::ObjectSourceKind::PackageBody
        )
    }) {
        return Err("Routine plans accept only exact procedure, function, package and package body identities".into());
    }
    Ok(())
}

pub async fn prepare_oracle_routine_plan_core(
    state: &AppState,
    input: OracleRoutinePlanInput,
) -> Result<OracleRoutinePlan, String> {
    let input = package::normalize_input(input)?;
    check_plan_selection(&input)?;
    let _input_pins = input
        .drafts
        .iter()
        .flat_map(|draft| draft.baseline_operation_id.iter().chain(draft.supersedes_operation_id.iter()))
        .map(|id| state.routine_operations.pin(id))
        .collect::<Result<Vec<_>, _>>()?;
    let source_config = checked_endpoint(state, &input.source.endpoint).await?;
    let target_config = checked_endpoint(state, &input.target.endpoint).await?;
    let source = LiveCatalog { state, endpoint: &input.source.endpoint, config: &source_config };
    let target = LiveCatalog { state, endpoint: &input.target.endpoint, config: &target_config };
    let (_, source_origin) = routine_source_origin(&source_config)?;
    let (_, target_origin) = routine_source_origin(&target_config)?;
    let built = build_plan(Some(&source), &target, &input, source_origin, target_origin, |draft| {
        draft
            .baseline_operation_id
            .as_deref()
            .map(|id| terminal_plan_baseline(&state.routine_operations, id, &input.target.endpoint, &draft.identity))
            .transpose()
    })
    .await;
    prepare_built_plan(&state.routine_operations, &input, built, Some(&source_config), &target_config)
}

pub(super) async fn prepare_transfer_plan_with_tables(
    state: &AppState,
    input: OracleRoutinePlanInput,
    tables: &[PlannedRelation],
    defer_admission: bool,
) -> Result<(OracleRoutinePlan, BTreeSet<usize>, Value), String> {
    let input = package::normalize_input(input)?;
    check_plan_selection(&input)?;
    let _replacements = pin_transfer_replacements(&state.routine_operations, &input)?;
    let source_config = checked_endpoint(state, &input.source.endpoint).await?;
    let target_config = checked_endpoint(state, &input.target.endpoint).await?;
    let source = LiveCatalog { state, endpoint: &input.source.endpoint, config: &source_config };
    let target = LiveCatalog { state, endpoint: &input.target.endpoint, config: &target_config };
    let (_, source_origin) = routine_source_origin(&source_config)?;
    let (_, target_origin) = routine_source_origin(&target_config)?;
    let built =
        build_plan_with_tables(Some(&source), &target, &input, source_origin, target_origin, |_| Ok(None), tables)
            .await;
    let used = built.planned_table_dependencies.iter().flatten().copied().collect::<BTreeSet<_>>();
    let manifest = transfer_dependency_manifest(&built, tables);
    let positions = built.order_position.clone();
    let mut plan = if defer_admission {
        let mut plan = built.plan;
        plan.ready = false;
        plan
    } else {
        prepare_built_plan(&state.routine_operations, &input, built, Some(&source_config), &target_config)?
    };
    if !used.is_empty() {
        plan = ordered_transfer_preview(plan, &positions);
    }
    Ok((plan, used, manifest))
}

fn pin_transfer_replacements<'a>(
    registry: &'a RoutineOperationRegistry,
    input: &OracleRoutinePlanInput,
) -> Result<Vec<super::operations::RoutineOperationPin<'a>>, String> {
    let mut pins = Vec::new();
    for draft in &input.drafts {
        if draft.action != RoutinePlanAction::Create
            || draft.baseline_operation_id.is_some()
            || !matches!(draft.identity.kind, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody)
        {
            return Err("Pending table dependencies accept only new transfer package drafts".into());
        }
        if let Some(id) = &draft.supersedes_operation_id {
            let pin = registry.pin(id)?;
            let before = registry.observe(id).operation.ok_or("The original package preview is unavailable")?;
            let binding = registry.binding_for_readback(id)?;
            if before.lifecycle != RoutineOperationLifecycle::Prepared
                || before.dispatched
                || binding.target != input.target.endpoint
                || binding.identity != draft.identity
                || !binding.require_absent
            {
                return Err(
                    "Only the original unexecuted new-package preview can be replaced by a pending-table draft".into(),
                );
            }
            pins.push(pin);
        }
    }
    Ok(pins)
}

fn ordered_transfer_preview(mut plan: OracleRoutinePlan, positions: &[usize]) -> OracleRoutinePlan {
    if positions.len() != plan.steps.len()
        || positions.contains(&usize::MAX)
        || plan.steps.iter().any(|step| !step.issues.is_empty())
    {
        return plan;
    }
    let mut steps = plan.steps.into_iter().enumerate().collect::<Vec<_>>();
    steps.sort_by_key(|(index, _)| positions[*index]);
    plan.steps = steps.into_iter().map(|(_, step)| step).collect();
    plan
}

fn transfer_dependency_manifest(built: &BuiltPlan, pending_tables: &[PlannedRelation]) -> Value {
    let steps = built
        .plan
        .steps
        .iter()
        .enumerate()
        .map(|(index, step)| {
            // ComparePreflight.source is populated only at registry admission; its
            // connection config must never be part of a client confirmation payload.
            let preflight = built.preflights[index].as_ref();
            serde_json::json!({
                "identity": step.identity, "action": step.action, "sql": step.sql,
                "references": step.references, "dependencies": built.dependencies[index],
                "pendingTables": step.references.iter().filter(|reference| reference.kind == "TABLE"
                    && pending_tables.iter().any(|table| table.owner == reference.owner && table.name == reference.name))
                    .map(|reference| (&reference.owner, &reference.name)).collect::<BTreeSet<_>>()
                    .into_iter().map(|(owner, name)| serde_json::json!({"owner":owner,"name":name})).collect::<Vec<_>>(),
                "target": preflight.map(|before| &before.target),
                "proofGroups": reference_proof_manifest(&built.proof_groups[index],
                    preflight.map(|before| before.proofs.as_slice()).unwrap_or_default(), pending_tables),
                "incoming": preflight.and_then(|before| before.incoming.as_ref()),
                "package": preflight.and_then(|before| before.package.as_ref()),
                "source": built.source_expected[index], "sourcePair": built.source_pairs[index],
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({ "steps": steps, "order": built.order })
}

pub(super) async fn prepare_completed_transfer<'a>(
    state: &'a AppState,
    transfer_id: &str,
    input: &OracleRoutinePlanInput,
    tables: &[PlannedRelation],
    manifest: &Value,
    table_proofs: Vec<CatalogReadProof>,
) -> Result<(OracleRoutinePlan, Vec<super::operations::RoutineOperationPin<'a>>), String> {
    let input = package::normalize_input(input.clone())?;
    check_plan_selection(&input)?;
    if input.drafts.iter().any(|draft| {
        draft.sql.is_none()
            || draft.action != RoutinePlanAction::Create
            || draft.baseline_operation_id.is_some()
            || draft.supersedes_operation_id.is_some()
    }) {
        return Err("The completed table stage requires the exact frozen new package SQL".into());
    }
    let source_config = checked_endpoint(state, &input.source.endpoint).await?;
    let target_config = checked_endpoint(state, &input.target.endpoint).await?;
    let source = LiveCatalog { state, endpoint: &input.source.endpoint, config: &source_config };
    let target = LiveCatalog { state, endpoint: &input.target.endpoint, config: &target_config };
    let (_, source_origin) = routine_source_origin(&source_config)?;
    let (_, target_origin) = routine_source_origin(&target_config)?;
    let built = build_plan(Some(&source), &target, &input, source_origin, target_origin, |_| Ok(None)).await;
    if crate::data::transfer::is_cancelled(transfer_id).await {
        return Err("Cancelled before package approval; no package statement was dispatched".into());
    }
    finish_completed_transfer(
        &state.routine_operations,
        &input,
        built,
        tables,
        manifest,
        table_proofs,
        &source_config,
        &target_config,
    )
}

#[allow(clippy::too_many_arguments)]
fn finish_completed_transfer<'a>(
    registry: &'a RoutineOperationRegistry,
    input: &OracleRoutinePlanInput,
    mut built: BuiltPlan,
    tables: &[PlannedRelation],
    manifest: &Value,
    table_proofs: Vec<CatalogReadProof>,
    source_config: &ConnectionConfig,
    target_config: &ConnectionConfig,
) -> Result<(OracleRoutinePlan, Vec<super::operations::RoutineOperationPin<'a>>), String> {
    if transfer_dependency_manifest(&built, tables) != *manifest {
        built.plan.ready = false;
        for step in &mut built.plan.steps {
            step.issues.push(problem("A nonpending dependency, complete source, final SQL or execution order changed during table transfer; retain completed tables and refresh the package drafts"));
        }
    }
    if !built.plan.ready {
        return Ok((built.plan, Vec::new()));
    }
    for before in built.preflights.iter_mut().flatten() {
        before.proofs.extend(table_proofs.iter().cloned());
    }
    let plan = prepare_built_plan(registry, input, built, Some(source_config), target_config)?;
    let pins = plan
        .steps
        .iter()
        .filter_map(|step| step.operation.as_ref())
        .map(|operation| registry.pin(&operation.operation_id))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((plan, pins))
}

fn prepare_built_plan(
    registry: &RoutineOperationRegistry,
    input: &OracleRoutinePlanInput,
    mut built: BuiltPlan,
    source_config: Option<&ConnectionConfig>,
    target_config: &ConnectionConfig,
) -> Result<OracleRoutinePlan, String> {
    if built.planned_table_dependencies.iter().any(|tables| !tables.is_empty()) {
        built.plan.ready = false;
    }
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
        let source_preflight = source_config
            .map(|source_config| {
                Ok::<_, String>(SourcePreflight {
                    endpoint: input.source.endpoint.clone(),
                    config: source_config.clone(),
                    expected: built.source_expected[index].clone().ok_or("Source snapshot is unavailable")?,
                    package_pair: built.source_pairs[index].clone(),
                })
            })
            .transpose()?;
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
                compare: Some(ComparePreflight { source: source_preflight, ..preflight }),
                prerequisite_operation_ids: dependencies,
                package_effect_operation_ids: Vec::new(),
            },
            supersedes: input.drafts[index].supersedes_operation_id.clone(),
        });
        operations.insert(index, operation_id);
        indices.push(index);
    }
    let package_steps = requests
        .iter()
        .filter(|request| package::is_package(&request.binding.identity.kind))
        .map(|request| (request.operation_id.clone(), request.binding.identity.clone()))
        .collect::<Vec<_>>();
    for request in &mut requests {
        let mut namespaces = BTreeSet::new();
        if package::is_package(&request.binding.identity.kind) {
            namespaces.insert((request.binding.identity.owner.clone(), request.binding.identity.name.clone()));
        }
        for (id, identity) in &package_steps {
            if request.binding.prerequisite_operation_ids.contains(id) {
                namespaces.insert((identity.owner.clone(), identity.name.clone()));
            }
        }
        request.binding.package_effect_operation_ids = package_steps
            .iter()
            .filter(|(id, identity)| {
                *id != request.operation_id && namespaces.contains(&(identity.owner.clone(), identity.name.clone()))
            })
            .map(|(id, _)| id.clone())
            .collect();
    }
    let prepared = registry.prepare_batch(requests, 0)?;
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

#[cfg(test)]
pub(super) async fn prepare_with_catalogs(
    registry: &RoutineOperationRegistry,
    source: &impl RoutineCatalog,
    target: &impl RoutineCatalog,
    input: OracleRoutinePlanInput,
    source_config: &ConnectionConfig,
    target_config: &ConnectionConfig,
) -> Result<OracleRoutinePlan, String> {
    let input = package::normalize_input(input)?;
    check_plan_selection(&input)?;
    let (_, source_origin) = routine_source_origin(source_config)?;
    let (_, target_origin) = routine_source_origin(target_config)?;
    let built = build_plan(Some(source), target, &input, source_origin, target_origin, |draft| {
        draft
            .baseline_operation_id
            .as_deref()
            .map(|id| terminal_plan_baseline(registry, id, &input.target.endpoint, &draft.identity))
            .transpose()
    })
    .await;
    prepare_built_plan(registry, &input, built, Some(source_config), target_config)
}

struct BuiltPlan {
    plan: OracleRoutinePlan,
    preflights: Vec<Option<ComparePreflight>>,
    source_expected: Vec<Option<ExpectedRoutine>>,
    source_pairs: Vec<Option<ExpectedPackagePair>>,
    dependencies: Vec<BTreeSet<usize>>,
    order: Vec<usize>,
    order_position: Vec<usize>,
    planned_table_dependencies: Vec<BTreeSet<usize>>,
    proof_groups: Vec<Vec<ReferenceProofGroup>>,
}

async fn build_plan(
    source: Option<&impl RoutineCatalog>,
    target: &impl RoutineCatalog,
    input: &OracleRoutinePlanInput,
    source_origin: SourceOrigin,
    target_origin: SourceOrigin,
    baseline: impl Fn(&RoutinePlanDraft) -> Result<Option<RoutineBaseline>, String>,
) -> BuiltPlan {
    build_plan_with_tables(source, target, input, source_origin, target_origin, baseline, &[]).await
}

async fn build_plan_with_tables(
    source: Option<&impl RoutineCatalog>,
    target: &impl RoutineCatalog,
    input: &OracleRoutinePlanInput,
    source_origin: SourceOrigin,
    target_origin: SourceOrigin,
    baseline: impl Fn(&RoutinePlanDraft) -> Result<Option<RoutineBaseline>, String>,
    planned_tables: &[PlannedRelation],
) -> BuiltPlan {
    let mut plan = OracleRoutinePlan { target: input.target.endpoint.clone(), steps: Vec::new(), ready: false };
    let mut selected = Vec::new();
    let mut preflights = Vec::new();
    let mut source_expected = Vec::new();
    let mut source_pairs = Vec::new();
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
            package_impact: None,
        };
        let mut source_before = None;
        let mut before = None;
        let mut source_pair = None;
        let mut target_pair = None;
        let prepared: Result<(), String> = async {
            if draft.identity.owner != input.target.endpoint.schema || draft.identity.name.is_empty() || !matches!(draft.identity.kind, db::ObjectSourceKind::Function | db::ObjectSourceKind::Procedure | db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody) { return Err("Every step must retain its exact selected target identity".into()); }
            let namespace = (draft.identity.owner.clone(), draft.identity.name.clone());
            let key = (namespace.clone(), kind_name(&draft.identity.kind));
            if !seen.insert(key) || input.drafts.iter().any(|other| other.identity.owner == namespace.0 && other.identity.name == namespace.1 && other.identity.kind != draft.identity.kind && !(package::is_package(&other.identity.kind) && package::is_package(&draft.identity.kind))) { return Err("The same shared namespace target has duplicate or conflicting selected kinds".into()); }
            let source_name = draft.source_name.as_deref().unwrap_or(&draft.identity.name);
            if source_name != draft.identity.name { return Err("Routine rename mappings require a separate reviewed lifecycle; keep this comparison's exact name".into()); }
            let source_object = snapshot_object(&input.source, source_name, &draft.identity.kind)?;
            let target_object = snapshot_object(&input.target, &draft.identity.name, &draft.identity.kind)?;
            step.source_original = source_object.as_ref().and_then(|object| object.source.clone());
            step.target_original = target_object.as_ref().and_then(|object| object.source.clone());
            source_before = Some(if draft.action == RoutinePlanAction::Delete {
                if !input.source.enumeration_complete || source_object.is_some() { return Err("Deletion requires complete source enumeration and a confirmed absent source identity".into()); }
                ExpectedRoutine::Absent(RoutineIdentity { owner: input.source.endpoint.schema.clone(), ..draft.identity.clone() })
            } else if draft.package_body_source == Some(PackageBodySource::Target) {
                match source_object { Some(object) if object.source_complete => ExpectedRoutine::Present(object), None if input.source.enumeration_complete => ExpectedRoutine::Absent(RoutineIdentity { owner:input.source.endpoint.schema.clone(), ..draft.identity.clone() }), _ => return Err("Refresh complete source evidence before retaining the target body".into()) }
            } else {
                let object = source_object.ok_or("Source routine is not present in the complete preview")?;
                if object.version.identity.kind != draft.identity.kind || !object.source_complete { return Err("Source kind or complete definition is not verified".into()); }
                ExpectedRoutine::Present(object)
            });
            let correction = baseline(draft)?;
            let mut expected = match &correction {
                Some(expected) => expected.selected.clone(),
                None => match target_object {
                    Some(object) => ExpectedRoutine::Present(object),
                    None if input.target.enumeration_complete => ExpectedRoutine::Absent(draft.identity.clone()),
                    None => return Err("Target absence is not proven by this preview".into()),
                },
            };
            if package::is_package(&draft.identity.kind) {
                source_pair = Some(ExpectedPackagePair::from_snapshot(&input.source, source_name)?);
                let mut pair = ExpectedPackagePair::from_snapshot(&input.target, &draft.identity.name)?;
                pair.set(expected.clone());
                if let Some(companion) = correction.and_then(|baseline| baseline.companion) { pair.set(companion); }
                target_pair = Some(pair);
            }
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
                    let (owner, source) = if draft.package_body_source == Some(PackageBodySource::Target) { (&draft.identity.owner, step.target_original.as_deref().ok_or("The retained target body is unavailable")?) } else { (&input.source.endpoint.schema, step.source_original.as_deref().ok_or("Complete source is unavailable")?) };
                    adapted(&input.target.endpoint, &draft.identity, owner, source, replace)?
                };
                if input.compact_sql && draft.sql.is_none() {
                    step.sql = compact_oracle_ddl(&step.sql)?;
                }
            }
            step.recovery_sql = match &expected {
                ExpectedRoutine::Absent(_) => Some(drop_sql(&draft.identity)),
                ExpectedRoutine::Present(object) => Some(adapted(&input.target.endpoint, &draft.identity, &draft.identity.owner, object.source.as_deref().ok_or("Original target definition is unavailable")?, draft.action != RoutinePlanAction::Delete)?),
            };
            if matches!(&expected, ExpectedRoutine::Present(object) if !object.dependencies_complete) && draft.baseline_operation_id.is_none() { return Err("Target dependency snapshot is incomplete; refresh it before a destructive step".into()); }
            if let Some(source) = source {
                if let Some(pair) = &source_pair { package::verify_pair(source, &input.source.endpoint, pair, source_origin).await?; }
                else { verify_expected(source, &input.source.endpoint, source_before.as_ref().unwrap(), source_origin).await?; }
            }
            if let Some(pair) = &target_pair { package::verify_pair(target, &input.target.endpoint, pair, target_origin).await?; }
            else { verify_expected(target, &input.target.endpoint, &expected, target_origin).await?; }
            if let ExpectedRoutine::Present(object) = &mut expected {
                if !object.dependencies_complete {
                    object.dependencies = dependencies(target, &object.version.identity).await?;
                    object.dependencies_complete = true;
                }
            }
            before = Some(expected);
            if let Some(pair) = &mut target_pair { pair.set(before.as_ref().unwrap().clone()); }
            Ok(())
        }.await;
        if let Err(error) = prepared {
            step.issues.push(problem(error));
        }
        let analysis =
            if draft.action == RoutinePlanAction::Delete || draft.identity.kind == db::ObjectSourceKind::PackageBody {
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
            package: target_pair.map(|pair| PackagePreflight {
                pair,
                grants: None,
                require_valid_specification: draft.identity.kind == db::ObjectSourceKind::PackageBody
                    && draft.action != RoutinePlanAction::Delete,
            }),
        }));
        source_expected.push(source_before);
        source_pairs.push(source_pair);
        plan.steps.push(step);
    }
    package::prepare_package_drafts(
        target,
        input,
        &mut plan,
        &mut selected,
        &mut preflights,
        &source_pairs,
        target_origin,
    )
    .await;
    let mut dependencies = vec![BTreeSet::new(); plan.steps.len()];
    let mut planned_table_dependencies = vec![BTreeSet::new(); plan.steps.len()];
    let mut proof_groups = preflights
        .iter()
        .map(|before| {
            before
                .as_ref()
                .filter(|before| !before.proofs.is_empty())
                .map(|before| {
                    vec![ReferenceProofGroup {
                        purpose: ReferenceProofPurpose::PackagePreflight,
                        start: 0,
                        end: before.proofs.len(),
                    }]
                })
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    for index in 0..plan.steps.len() {
        if !plan.steps[index].issues.is_empty() {
            continue;
        }
        if plan.steps[index].action != RoutinePlanAction::Delete {
            let resolution = if planned_tables.is_empty() {
                resolve_draft(target, &input.target.endpoint, &selected, index).await
            } else {
                resolve_draft_with_tables(target, &input.target.endpoint, &selected, index, planned_tables).await
            };
            plan.steps[index].issues.extend(resolution.issues);
            plan.steps[index].references = resolution.references;
            dependencies[index] = resolution.selected_dependencies;
            planned_table_dependencies[index] = resolution.planned_table_dependencies;
            let offset = preflights[index].as_ref().unwrap().proofs.len();
            proof_groups[index].extend(resolution.proof_groups.into_iter().map(|mut group| {
                group.start += offset;
                group.end += offset;
                group
            }));
            preflights[index].as_mut().unwrap().proofs.extend(resolution.proofs);
        }
        if plan.steps[index].action != RoutinePlanAction::Create
            && plan.steps[index].identity.kind != db::ObjectSourceKind::PackageBody
        {
            match incoming_dependencies(target, &plan.steps[index].identity).await {
                Ok(incoming) => {
                    plan.steps[index].incoming_callers = incoming.clone();
                    if plan.steps[index].identity.kind == db::ObjectSourceKind::Package
                        && plan.steps[index].action == RoutinePlanAction::Replace
                        && !input.drafts[index].confirm_package_pair
                        && !external_incoming(
                            &incoming,
                            &input.drafts.iter().map(|draft| draft.identity.clone()).collect::<Vec<_>>(),
                        )
                        .is_empty()
                    {
                        plan.steps[index].issues.push(problem("Confirm the specification's external caller contract and invalidation risk before approval; VALID callers do not prove compatibility"));
                    }
                    if plan.steps[index].action == RoutinePlanAction::Delete {
                        for caller in &incoming {
                            if caller.owner == plan.steps[index].identity.owner
                                && caller.name == plan.steps[index].identity.name
                                && (caller.kind == kind_name(&plan.steps[index].identity.kind)
                                    || (plan.steps[index].identity.kind == db::ObjectSourceKind::Package
                                        && caller.kind == "PACKAGE BODY"))
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
        if plan.steps[index].identity.kind == db::ObjectSourceKind::Package
            && plan.steps[index].action != RoutinePlanAction::Delete
        {
            if let Some(body) = plan.steps.iter().position(|step| {
                step.identity == package::counterpart(&plan.steps[index].identity)
                    && step.action == RoutinePlanAction::Delete
            }) {
                dependencies[index].insert(body);
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
    if input.source.endpoint.database_type != input.target.endpoint.database_type {
        for (draft, step) in input.drafts.iter().zip(&mut plan.steps) {
            if draft.sql.is_none() {
                let mut issue = problem(format!("Cross-product package conversion from {:?} to {:?} requires an explicitly reviewed target draft; retain the original source, review or edit this draft and validate it again", input.source.endpoint.database_type, input.target.endpoint.database_type));
                issue.code = "target-draft-review".into();
                step.issues.push(issue);
            }
        }
    }
    plan.ready = plan.steps.iter().all(|step| step.issues.is_empty())
        && order.len() == plan.steps.len()
        && planned_table_dependencies.iter().all(BTreeSet::is_empty);
    let mut order_position = vec![usize::MAX; plan.steps.len()];
    for (position, index) in order.iter().enumerate() {
        order_position[*index] = position;
    }
    BuiltPlan {
        plan,
        preflights,
        source_expected,
        source_pairs,
        dependencies,
        order,
        order_position,
        planned_table_dependencies,
        proof_groups,
    }
}

#[cfg(test)]
mod package_tests;
#[cfg(test)]
mod tests;
