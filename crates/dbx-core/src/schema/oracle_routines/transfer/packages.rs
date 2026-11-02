use super::super::operations::{RoutineOperationPin, RoutineWriteBinding};
use super::*;
use crate::data::transfer::oracle_table_contract::{self, FrozenTableDdl, LengthSemantics};
use crate::data::transfer::{
    validate_transfer_database_pair, validate_transfer_request, TransferContent, TransferRequest,
};
use std::collections::HashSet;

mod external_types;
mod pending;
pub(crate) use pending::PackageTransfer;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OraclePackageTransferRequest {
    pub input: Option<OracleRoutinePlanInput>,
    #[serde(default)]
    pub operation_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_tables: Option<PendingPackageTables>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OraclePackageTransferPreview {
    pub input: OracleRoutinePlanInput,
    pub plan: OracleRoutinePlan,
    pub skipped: Vec<RoutineIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_tables: Option<PendingPackageTables>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPackageTables {
    pub source: RoutineEndpoint,
    pub target: RoutineEndpoint,
    pub tables: Vec<FrozenTableDdl>,
    pub dependency_manifest: Value,
    pub table_evidence: Vec<Value>,
}

#[derive(Debug)]
pub(crate) struct PackageTransferPreflightError {
    message: String,
    preview: Option<Box<OraclePackageTransferPreview>>,
}

impl From<String> for PackageTransferPreflightError {
    fn from(message: String) -> Self {
        Self { message, preview: None }
    }
}

impl From<&str> for PackageTransferPreflightError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

impl PackageTransferPreflightError {
    pub(crate) fn into_progress(self, request: &TransferRequest) -> crate::data::transfer::TransferProgress {
        use crate::data::transfer::{TransferProgress, TransferStatus};
        TransferProgress {
            oracle_package_approval: None,
            oracle_routine_operation: None,
            oracle_package_preflight: self.preview.map(|preview| *preview),
            transfer_id: request.transfer_id.clone(),
            table: "schema objects".into(),
            table_index: 0,
            total_tables: request.tables.len(),
            rows_transferred: 0,
            total_rows: None,
            status: TransferStatus::Error,
            error: Some(self.message),
            terminal: true,
        }
    }
}

pub(crate) struct ApprovedPackageTransfer<'a> {
    writes: Vec<(String, RoutineWriteBinding)>,
    skipped: Vec<RoutineIdentity>,
    _pins: Vec<RoutineOperationPin<'a>>,
}

impl ApprovedPackageTransfer<'_> {
    fn identities(&self) -> impl Iterator<Item = &RoutineIdentity> {
        self.writes.iter().map(|(_, binding)| &binding.identity)
    }

    fn skipped(&self) -> &[RoutineIdentity] {
        &self.skipped
    }

    async fn execute(&self, state: &AppState, index: usize) -> Result<RoutineOperationRecord, String> {
        let (id, binding) = self.writes.get(index).ok_or("The approved package step is unavailable")?;
        execution::execute_prepared_inline(state, id, &binding.sql).await
    }

    pub(crate) async fn run<F>(
        &self,
        state: &AppState,
        request: &TransferRequest,
        prerequisites_succeeded: bool,
        mut progress: F,
    ) -> (crate::data::transfer::TransferObjectOutcome, bool)
    where
        F: FnMut(crate::data::transfer::TransferProgress),
    {
        use crate::data::transfer::{is_cancelled, TransferObjectOutcome, TransferProgress, TransferStatus};
        let label = |identity: &RoutineIdentity| {
            format!(
                "{}:{}",
                if identity.kind == db::ObjectSourceKind::Package { "Package" } else { "PackageBody" },
                identity.name
            )
        };
        let mut outcome =
            TransferObjectOutcome { skipped: self.skipped().iter().map(label).collect(), ..Default::default() };
        if !prerequisites_succeeded {
            return (outcome, false);
        }
        for (index, identity) in self.identities().enumerate() {
            if is_cancelled(&request.transfer_id).await {
                return (outcome, true);
            }
            let item = label(identity);
            let (operation, error) = match self.execute(state, index).await {
                Ok(record) => {
                    let error = if record.verified() {
                        outcome.transferred.push(item.clone());
                        None
                    } else {
                        Some(record.failure_message())
                    };
                    (Some(record), error)
                }
                Err(error) => (None, Some(error)),
            };
            progress(TransferProgress {
                oracle_package_approval: None,
                oracle_package_preflight: None,
                oracle_routine_operation: operation,
                transfer_id: request.transfer_id.clone(),
                table: item.clone(),
                table_index: request.tables.len(),
                total_tables: request.tables.len(),
                rows_transferred: 0,
                total_rows: None,
                status: if error.is_some() { TransferStatus::Error } else { TransferStatus::TableDone },
                error: error.clone(),
                terminal: false,
            });
            if error.is_some() {
                outcome.failed.push(item);
                break;
            }
        }
        (outcome, false)
    }
}

fn claim_approvals<'a>(
    registry: &'a RoutineOperationRegistry,
    input: &OracleRoutinePlanInput,
    operation_ids: &[String],
) -> Result<ApprovedPackageTransfer<'a>, String> {
    let selected = input.drafts.iter().map(|draft| draft.identity.clone()).collect::<Vec<_>>();
    if operation_ids.len() != selected.len() {
        return Err("Every selected new package kind requires its original approved operation ID".into());
    }
    let ids = operation_ids.iter().collect::<HashSet<_>>();
    if ids.len() != operation_ids.len() {
        return Err("A package transfer cannot consume an approval twice".into());
    }
    let pins = operation_ids.iter().map(|id| registry.pin(id)).collect::<Result<Vec<_>, _>>()?;
    let mut writes = Vec::new();
    let mut seen = HashSet::new();
    for id in operation_ids {
        let binding = registry.binding_for_readback(id)?;
        let draft = input
            .drafts
            .iter()
            .find(|draft| draft.identity == binding.identity)
            .ok_or("The package approval belongs to an unselected identity")?;
        let compare =
            binding.compare.as_ref().ok_or("A package transfer requires its reviewed comparison preflight")?;
        let source = compare.source.as_ref().ok_or("The package approval has no original source evidence")?;
        if binding.target != input.target.endpoint
            || source.endpoint != input.source.endpoint
            || !binding.require_absent
            || !matches!(&binding.goal, RoutineReadbackGoal::Definition { sql } if *sql == binding.sql)
            || draft.action != RoutinePlanAction::Create
            || draft.baseline_operation_id.is_some()
            || !matches!(binding.identity.kind, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody)
            || !matches!(&compare.target, plan::ExpectedRoutine::Absent(identity) if *identity == binding.identity)
            || compare.selected.len() != selected.len()
            || compare.selected.iter().any(|identity| !selected.contains(identity))
        {
            return Err("The package approval does not match this exact source, target and new-object selection".into());
        }
        let source_name = draft.source_name.as_deref().unwrap_or(&draft.identity.name);
        if !matches!(&source.expected, plan::ExpectedRoutine::Present(object)
            if object.version.identity.owner == input.source.endpoint.schema
                && object.version.identity.name == source_name
                && object.version.identity.kind == draft.identity.kind)
        {
            return Err("The package approval belongs to a different original source object".into());
        }
        if let Some(sql) = &draft.sql {
            dbx_sql::object_source_sql::validate_oracle_routine_target_definition(
                dbx_sql::object_source_sql::EditableObjectSourceSqlInput {
                    database_type: input.target.endpoint.database_type,
                    object_type: draft.identity.kind.clone(),
                    schema: Some(draft.identity.owner.clone()),
                    name: draft.identity.name.clone(),
                    source: sql.clone(),
                },
                Some(false),
            )?;
            let approved = prepare_oracle_routine_definition(OracleRoutineDefinitionInput {
                database_type: input.target.endpoint.database_type,
                object_type: draft.identity.kind.clone(),
                source_owner: draft.identity.owner.clone(),
                target_owner: draft.identity.owner.clone(),
                name: draft.identity.name.clone(),
                source: sql.clone(),
                replace: false,
            })?;
            if approved != binding.sql {
                return Err("The package target draft changed after approval; retain it and validate again".into());
            }
        }
        if binding.prerequisite_operation_ids.iter().any(|before| !ids.contains(before) || !seen.contains(before))
            || binding.package_effect_operation_ids.iter().any(|other| !ids.contains(other))
        {
            return Err("Package approvals must retain the reviewed dependency order".into());
        }
        let record = registry.observe(id).operation.ok_or("Original package approval is unavailable")?;
        if record.lifecycle != RoutineOperationLifecycle::Prepared && !record.verified() {
            return Err(record.failure_message());
        }
        seen.insert(id.clone());
        writes.push((id.clone(), binding));
    }
    Ok(ApprovedPackageTransfer { writes, skipped: Vec::new(), _pins: pins })
}

fn selections(request: &TransferRequest) -> Vec<RoutineSelection> {
    let mut selected = Vec::new();
    for selection in request.objects.iter().flatten() {
        let kind = match selection.object_type {
            TransferObjectKind::Package => db::ObjectSourceKind::Package,
            TransferObjectKind::PackageBody => db::ObjectSourceKind::PackageBody,
            _ => continue,
        };
        for name in &selection.names {
            let identity = RoutineSelection { name: name.clone(), kind: kind.clone() };
            if !selected.contains(&identity) {
                selected.push(identity);
            }
        }
    }
    selected
}

fn transfer_input(
    source: RoutineSnapshot,
    target: RoutineSnapshot,
    selected: &[RoutineSelection],
    provided: Option<&[RoutinePlanDraft]>,
) -> Result<(OracleRoutinePlanInput, Vec<RoutineIdentity>), String> {
    let mut skipped = Vec::new();
    let mut drafts = Vec::new();
    if let Some(provided) = provided {
        for (index, draft) in provided.iter().enumerate() {
            if draft.identity.owner != target.endpoint.schema
                || !selected
                    .iter()
                    .any(|selection| selection.name == draft.identity.name && selection.kind == draft.identity.kind)
                || provided[..index].iter().any(|other| other.identity == draft.identity)
                || draft.action != RoutinePlanAction::Create
                || draft.baseline_operation_id.is_some()
            {
                return Err("Transfer package drafts must retain the exact selected new identities; compare existing objects before replacing or deleting them".into());
            }
        }
    }
    for selection in selected {
        let identity = RoutineIdentity {
            owner: target.endpoint.schema.clone(),
            name: selection.name.clone(),
            kind: selection.kind.clone(),
        };
        let existing = target.objects.iter().filter(|object| object.version.identity == identity).collect::<Vec<_>>();
        if existing.len() > 1 {
            return Err("The selected target package identity is ambiguous; refresh its complete inventory".into());
        }
        let supplied = provided.and_then(|drafts| drafts.iter().find(|draft| draft.identity == identity));
        if !existing.is_empty() {
            if supplied.is_some() {
                return Err("The target package kind already exists and must be skipped; open its comparison to review a replacement".into());
            }
            skipped.push(identity);
        } else if let Some(provided) = provided {
            drafts.push(
                provided
                    .iter()
                    .find(|draft| draft.identity == identity)
                    .ok_or("The reviewed transfer omits a selected new package kind; refresh its preview")?
                    .clone(),
            );
        } else {
            drafts.push(RoutinePlanDraft {
                identity,
                action: RoutinePlanAction::Create,
                source_name: Some(selection.name.clone()),
                sql: None,
                baseline_operation_id: None,
                supersedes_operation_id: None,
                package_body_source: None,
                package_contract: None,
                confirm_package_pair: false,
            });
        }
    }
    Ok((OracleRoutinePlanInput { compact_sql: false, source, target, drafts }, skipped))
}

async fn read_transfer_package_input(
    state: &AppState,
    request: &TransferRequest,
) -> Result<Option<(OracleRoutinePlanInput, Vec<RoutineIdentity>)>, String> {
    if !request.has_package_selection() {
        return Ok(None);
    }
    let source_product = crate::data::transfer::get_db_type(state, &request.source_connection_id).await?;
    let target_product = crate::data::transfer::get_db_type(state, &request.target_connection_id).await?;
    validate_transfer_database_pair(request, &source_product, &target_product)?;
    if source_product == DatabaseType::Xugu && target_product == DatabaseType::Xugu && request.oracle_packages.is_none()
    {
        return Ok(None);
    }
    validate_transfer_request(request)?;
    if matches!(request.content, TransferContent::DataOnly) {
        return Err("Data-only transfer does not execute package DDL".into());
    }
    let selected = selections(request);
    let previous = request.oracle_packages.as_ref().and_then(|package| package.input.as_ref());
    let (source, target) = if let Some(input) = previous {
        for (endpoint, connection, database, schema, product) in [
            (
                &input.source.endpoint,
                &request.source_connection_id,
                &request.source_database,
                &request.source_schema,
                source_product,
            ),
            (
                &input.target.endpoint,
                &request.target_connection_id,
                &request.target_database,
                &request.target_schema,
                target_product,
            ),
        ] {
            if endpoint.connection_id != *connection
                || endpoint.database != *database
                || endpoint.schema != *schema
                || endpoint.database_type != product
            {
                return Err("The package transfer preview belongs to different source or target identities; retain the drafts and refresh it".into());
            }
            plan::checked_endpoint(state, endpoint).await?;
        }
        (input.source.clone(), input.target.clone())
    } else {
        let options = RoutineReadOptions {
            object_kinds: Some(selected.iter().map(|selection| selection.kind.clone()).fold(
                Vec::new(),
                |mut kinds, kind| {
                    if !kinds.contains(&kind) {
                        kinds.push(kind);
                    }
                    kinds
                },
            )),
            selected_objects: Some(selected.clone()),
            selected_routines: None,
        };
        let source = load_schema_diff_routines_with_options_core(
            state,
            &request.source_connection_id,
            &request.source_database,
            &request.source_schema,
            options.clone(),
        )
        .await?;
        let target = load_schema_diff_routines_with_options_core(
            state,
            &request.target_connection_id,
            &request.target_database,
            &request.target_schema,
            options,
        )
        .await?;
        (source, target)
    };
    let (input, skipped) = transfer_input(source, target, &selected, previous.map(|input| input.drafts.as_slice()))?;
    let target_config = plan::checked_endpoint(state, &input.target.endpoint).await?;
    let target_catalog = LiveCatalog { state, endpoint: &input.target.endpoint, config: &target_config };
    for identity in &skipped {
        let before = &input.target.objects.iter().find(|object| object.version.identity == *identity).unwrap().version;
        let current =
            readback::exact_version(&readback::read_namespace(&target_catalog, identity, false).await?, identity)?;
        if *before != current {
            return Err(
                "An existing package selected for skipping changed; refresh before starting any transfer writes".into(),
            );
        }
    }
    Ok(Some((input, skipped)))
}

pub(crate) async fn prepare_transfer_packages(
    state: &AppState,
    request: &TransferRequest,
    structure: Option<&mut crate::data::transfer::TransferStructurePreview>,
) -> Result<Option<OraclePackageTransferPreview>, String> {
    let Some((mut input, skipped)) = read_transfer_package_input(state, request).await? else {
        return Ok(None);
    };
    let mut pending_tables = None;
    let plan = if input.drafts.is_empty() {
        OracleRoutinePlan { target: input.target.endpoint.clone(), steps: Vec::new(), ready: true }
    } else if let Some(structure) = structure.filter(|_| request.create_table) {
        let candidates = structure
            .tables
            .iter()
            .enumerate()
            .filter_map(|(index, table)| {
                let prepared = table.oracle_plan.as_ref()?;
                let columns = oracle_table_contract::planned_columns(
                    &prepared.ddl,
                    &input.target.endpoint.schema,
                    &table.target_table,
                )
                .ok()?;
                Some((
                    index,
                    super::super::references::PlannedRelation {
                        owner: input.target.endpoint.schema.clone(),
                        name: table.target_table.clone(),
                        columns,
                    },
                ))
            })
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            if request.oracle_packages.as_ref().is_some_and(|packages| packages.pending_tables.is_some()) {
                plan::prepare_transfer_plan_with_tables(state, input.clone(), &[], true).await?.0
            } else {
                prepare_oracle_routine_plan_core(state, input.clone()).await?
            }
        } else {
            let relations = candidates
                .iter()
                .map(|(_, table)| super::super::references::PlannedRelation {
                    owner: table.owner.clone(),
                    name: table.name.clone(),
                    columns: table.columns.clone(),
                })
                .collect::<Vec<_>>();
            let (mut plan, used, dependency_manifest) = plan::prepare_transfer_plan_with_tables(
                state,
                input.clone(),
                &relations,
                request.oracle_packages.as_ref().is_some_and(|packages| packages.pending_tables.is_some()),
            )
            .await?;
            if !used.is_empty() && plan.steps.iter().all(|step| step.issues.is_empty()) {
                let config = plan::checked_endpoint(state, &input.target.endpoint).await?;
                let catalog = LiveCatalog { state, endpoint: &input.target.endpoint, config: &config };
                let pending = prepare_pending_tables(
                    &catalog,
                    request,
                    &input.target.endpoint,
                    &input.source.endpoint,
                    structure,
                    &candidates,
                    &used,
                    dependency_manifest,
                )
                .await;
                match pending {
                    Ok(pending) => pending_tables = Some(pending),
                    Err(message) => {
                        for step in &mut plan.steps {
                            step.issues.push(dbx_sql::object_source_sql::OracleDraftIssue {
                                code: "pending-table-preflight".into(),
                                message: message.clone(),
                                line: 1,
                                column: 1,
                            });
                        }
                    }
                }
            }
            plan
        }
    } else {
        prepare_oracle_routine_plan_core(state, input.clone()).await?
    };
    if pending_tables.is_some() {
        for draft in &mut input.drafts {
            draft.supersedes_operation_id = None;
            draft.sql = Some(
                plan.steps
                    .iter()
                    .find(|step| step.identity == draft.identity)
                    .ok_or("The final package draft is unavailable")?
                    .sql
                    .clone(),
            );
        }
    }
    Ok(Some(OraclePackageTransferPreview { input, plan, skipped, pending_tables }))
}

async fn prepare_pending_tables(
    catalog: &impl RoutineCatalog,
    request: &TransferRequest,
    endpoint: &RoutineEndpoint,
    source: &RoutineEndpoint,
    structure: &mut crate::data::transfer::TransferStructurePreview,
    candidates: &[(usize, super::super::references::PlannedRelation)],
    used: &std::collections::BTreeSet<usize>,
    dependency_manifest: Value,
) -> Result<PendingPackageTables, String> {
    let login = catalog.query("SELECT USER AS LOGIN_OWNER FROM DUAL").await?;
    login.flags.check()?;
    if login.rows.len() != 1 {
        return Err("The target table namespace owner is unknown; retain the package drafts".into());
    }
    let dba = login.text(&login.rows[0], "LOGIN_OWNER")? != endpoint.schema;
    let mut tables = Vec::new();
    let mut table_evidence = Vec::new();
    let mut updates = Vec::new();
    let mut default_length = None;
    for &used_index in used {
        let &(index, ref relation) = candidates.get(used_index).ok_or("The pending table identity is unavailable")?;
        let table = &structure.tables[index];
        let prepared = table.oracle_plan.as_ref().ok_or("The final target table plan is unavailable")?;
        let namespace = readback::read_namespace(
            catalog,
            &RoutineIdentity {
                owner: relation.owner.clone(),
                name: relation.name.clone(),
                kind: db::ObjectSourceKind::Package,
            },
            dba,
        )
        .await?;
        if !namespace.rows.is_empty() {
            if !request.drop_target_before_create || namespace.rows.len() != 1 {
                return Err(format!(
                    "The planned table {} no longer has an empty target namespace; refresh before writing",
                    relation.name
                ));
            }
            let row = &namespace.rows[0];
            if namespace.text(row, "OWNER")? != relation.owner
                || namespace.text(row, "OBJECT_NAME")? != relation.name
                || namespace.text(row, "OBJECT_TYPE")? != "TABLE"
            {
                return Err(format!("The rebuild table {} has a different namespace identity", relation.name));
            }
            namespace.integer(row, "OBJECT_ID")?;
            namespace.text(row, "STATUS")?;
            namespace.text(row, "LAST_DDL_TIME")?;
        }
        let confirmed = request
            .oracle_packages
            .as_ref()
            .and_then(|packages| packages.pending_tables.as_ref())
            .map(|pending| {
                pending
                    .tables
                    .iter()
                    .find(|frozen| {
                        frozen.source_table() == table.source_table
                            && frozen.owner() == endpoint.schema
                            && frozen.name() == table.target_table
                    })
                    .ok_or("The confirmed pending table selection changed; retain drafts and refresh")
            })
            .transpose()?;
        let choice = if let Some(confirmed) = confirmed {
            confirmed.length_choice()
        } else if oracle_table_contract::needs_length_choice(&prepared.ddl)? {
            if default_length.is_none() {
                default_length = Some(read_target_length_choice(catalog).await?);
            }
            default_length
        } else {
            None
        };
        let frozen = FrozenTableDdl::from_server_plan(
            &table.source_table,
            &endpoint.schema,
            &table.target_table,
            &prepared.ddl,
            prepared.source_evidence.clone().ok_or("The complete original table evidence is missing")?,
            choice,
        )?;
        let final_ddl = frozen.final_ddl();
        let base = prepared.ddl.trim().trim_end_matches(';');
        if table.sql.matches(base).count() != 1 || structure.sql.matches(&table.sql).count() != 1 {
            return Err("The complete table preview does not contain its unique prepared CREATE statement".into());
        }
        let sql = table.sql.replacen(base, final_ddl.trim().trim_end_matches(';'), 1);
        if let Some(confirmed) = confirmed {
            confirmed.verify_server_plan(
                &table.source_table,
                &endpoint.schema,
                &table.target_table,
                &prepared.ddl,
                prepared.source_evidence.clone().unwrap(),
            )?;
        }
        let type_proofs = external_types::read(catalog, endpoint, &frozen).await?;
        table_evidence.push(serde_json::json!({ "sourceTable": table.source_table,
            "externalTypeProofs": external_types::manifest(&type_proofs),
            "targetTable": table.target_table, "namespaceColumns": namespace.columns,
            "namespaceRows": namespace.rows.iter().map(|row| row.iter().map(super::super::references::lossless_catalog_value).collect::<Vec<_>>()).collect::<Vec<_>>(), "sql": sql }));
        updates.push((index, sql));
        tables.push(frozen);
    }
    // Apply only after the whole batch has retained complete, typed evidence.
    for (index, sql) in updates {
        structure.sql = structure.sql.replacen(&structure.tables[index].sql, &sql, 1);
        structure.tables[index].sql = sql;
    }
    Ok(PendingPackageTables {
        source: source.clone(),
        target: endpoint.clone(),
        tables,
        dependency_manifest,
        table_evidence,
    })
}

async fn read_target_length_choice(catalog: &impl RoutineCatalog) -> Result<LengthSemantics, String> {
    let reply =
        catalog.query("SELECT VALUE FROM NLS_SESSION_PARAMETERS WHERE PARAMETER = 'NLS_LENGTH_SEMANTICS'").await?;
    reply.flags.check()?;
    if reply.rows.len() != 1 {
        return Err(
            "The target character length unit is not uniquely readable; retain the table and package drafts".into()
        );
    }
    match reply.text(&reply.rows[0], "VALUE")?.as_str() {
        "BYTE" => Ok(LengthSemantics::Bytes),
        "CHAR" => Ok(LengthSemantics::Characters),
        _ => Err("The target character length unit is unknown; retain the table and package drafts".into()),
    }
}

pub(crate) async fn claim_transfer_packages<'a>(
    state: &'a AppState,
    request: &TransferRequest,
    structure: Option<&mut crate::data::transfer::TransferStructurePreview>,
) -> Result<Option<PackageTransfer<'a>>, PackageTransferPreflightError> {
    if !request.has_package_selection() {
        return Ok(None);
    }
    if let Some(packages) = &request.oracle_packages {
        if packages.input.is_none() {
            return Err("The reviewed package transfer input is missing; refresh its preview".into());
        }
        if let Some(confirmed) = &packages.pending_tables {
            if !packages.operation_ids.is_empty() || confirmed.tables.is_empty() {
                return Err("Pending table confirmation cannot carry previously approved package operation IDs".into());
            }
            let structure = structure.ok_or("Pending table confirmation requires the original table transfer stage; refresh the complete transfer preview")?;
            let preview = prepare_transfer_packages(state, request, Some(structure))
                .await?
                .ok_or("The confirmed mixed package selection is unavailable")?;
            let preview = confirm_pending_preview(preview, confirmed)?;
            return Ok(Some(PackageTransfer::AwaitingTables(Box::new(pending::PendingClaim { preview }))));
        }
        // Pin before any asynchronous reads: closing the preview cannot discard
        // approvals already claimed by this server-side transfer.
        let input = packages.input.as_ref().unwrap();
        let mut approved = claim_approvals(&state.routine_operations, input, &packages.operation_ids)?;
        let (_, skipped) =
            read_transfer_package_input(state, request).await?.ok_or("The reviewed package selection is missing")?;
        let source_config = plan::checked_endpoint(state, &input.source.endpoint).await?;
        let target_config = plan::checked_endpoint(state, &input.target.endpoint).await?;
        let (_, origin) = routine_source_origin(&target_config)?;
        plan::verify_transfer_preflights(
            &approved.writes,
            &LiveCatalog { state, endpoint: &input.source.endpoint, config: &source_config },
            &LiveCatalog { state, endpoint: &input.target.endpoint, config: &target_config },
            origin,
        )
        .await?;
        approved.skipped = skipped;
        return Ok(Some(PackageTransfer::Approved(approved)));
    }
    let Some(preview) = prepare_transfer_packages(state, request, None).await? else {
        return Ok(None);
    };
    let preview = require_ready_transfer_preview(preview)?;
    let ids = preview
        .plan
        .steps
        .iter()
        .filter_map(|step| step.operation.as_ref().map(|operation| operation.operation_id.clone()))
        .collect::<Vec<_>>();
    let mut approved = claim_approvals(&state.routine_operations, &preview.input, &ids)?;
    approved.skipped = preview.skipped;
    Ok(Some(PackageTransfer::Approved(approved)))
}

fn require_ready_transfer_preview(
    preview: OraclePackageTransferPreview,
) -> Result<OraclePackageTransferPreview, PackageTransferPreflightError> {
    if !preview.plan.ready {
        return Err(PackageTransferPreflightError {
            message: "Package transfer requires target-draft corrections; open its structure preview and retain the original source before any writes".into(),
            preview: Some(Box::new(preview)),
        });
    }
    Ok(preview)
}

fn confirm_pending_preview(
    preview: OraclePackageTransferPreview,
    confirmed: &PendingPackageTables,
) -> Result<OraclePackageTransferPreview, PackageTransferPreflightError> {
    if preview.pending_tables.as_ref() != Some(confirmed)
        || preview.plan.ready
        || preview.plan.steps.is_empty()
        || preview.plan.steps.iter().any(|step| !step.issues.is_empty() || step.operation.is_some())
    {
        return Err(PackageTransferPreflightError { message: "The complete source, table SQL, namespace or package dependency evidence changed after confirmation; retain drafts and refresh before any writes".into(), preview: Some(Box::new(preview)) });
    }
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TableCatalog {
        replies: std::sync::Mutex<std::collections::VecDeque<(&'static str, Result<CatalogReply, String>)>>,
    }

    #[async_trait::async_trait]
    impl RoutineCatalog for TableCatalog {
        async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
            let (expected, reply) = self.replies.lock().unwrap().pop_front().expect("Unexpected catalog read");
            assert!(sql.contains(expected), "{sql}");
            reply
        }
        async fn source(&self, _: &RoutineIdentity) -> Result<SourceReply, String> {
            panic!("Table planning never reads or invokes a package")
        }
    }

    fn reply(columns: &[&str], rows: Vec<Vec<Value>>) -> Result<CatalogReply, String> {
        Ok(CatalogReply {
            columns: columns.iter().map(|name| (*name).into()).collect(),
            rows,
            flags: ReadFlags::default(),
        })
    }

    fn table_catalog(nls: Option<&str>) -> TableCatalog {
        let mut replies = std::collections::VecDeque::from([
            ("LOGIN_OWNER", reply(&["LOGIN_OWNER"], vec![vec![json!("T")]])),
            ("FROM ALL_OBJECTS", reply(&[], vec![])),
        ]);
        if let Some(nls) = nls {
            replies.push_back(("NLS_SESSION_PARAMETERS", reply(&["VALUE"], vec![vec![json!(nls)]])));
        }
        TableCatalog { replies: std::sync::Mutex::new(replies) }
    }

    fn pending_fixture(
        sql: &str,
    ) -> (
        TransferRequest,
        crate::data::transfer::TransferStructurePreview,
        Vec<(usize, super::super::super::references::PlannedRelation)>,
    ) {
        use crate::data::transfer::{TransferStructurePreview, TransferStructurePreviewTable};
        let request = serde_json::from_value(json!({
            "transferId":"mixed", "sourceConnectionId":"S", "sourceDatabase":"tenant", "sourceSchema":"S",
            "targetConnectionId":"T", "targetDatabase":"tenant", "targetSchema":"T", "tables":["ORIGINAL"],
            "createTable":true, "batchSize":100, "objects":[{"objectType":"PACKAGE", "names":["P"]}]
        }))
        .unwrap();
        let section = format!("-- ORIGINAL -> FINAL\n{sql};");
        let structure = TransferStructurePreview { sql: section.clone(), operations: vec![], schema_objects_expanded: false,
            tables: vec![TransferStructurePreviewTable {
                source_table: "ORIGINAL".into(), target_table: "FINAL".into(), preexisting: false, sql: section,
                oracle_plan: Some(serde_json::from_value(json!({"ddl":sql,"reused_source_ddl":true,
                    "deferred_fk_alters":[],"deferred_fk_names":[],
                    "source_evidence":{"sourceDdl":"CREATE TABLE ORIGINAL(V VARCHAR2(20))","columns":["source_column"]}})).unwrap()),
            }],
        };
        let columns = oracle_table_contract::planned_columns(sql, "T", "FINAL").unwrap();
        (
            request,
            structure,
            vec![(
                0,
                super::super::super::references::PlannedRelation { owner: "T".into(), name: "FINAL".into(), columns },
            )],
        )
    }

    #[tokio::test]
    async fn mixed_preview_uses_actual_prepared_sql_and_freezes_a_visible_explicit_unit() {
        let (request, mut structure, candidates) =
            pending_fixture("CREATE TABLE \"T\".FINAL(V VARCHAR2(20)) COMPRESS FOR ARCHIVE");
        let catalog = table_catalog(Some("CHAR"));
        let pending = prepare_pending_tables(
            &catalog,
            &request,
            &snapshot("T").endpoint,
            &snapshot("S").endpoint,
            &mut structure,
            &candidates,
            &std::collections::BTreeSet::from([0]),
            json!({"serverProof":"retained"}),
        )
        .await
        .unwrap();
        assert_eq!(pending.tables[0].final_ddl(), "CREATE TABLE \"T\".FINAL(V VARCHAR2(20 CHAR)) COMPRESS FOR ARCHIVE");
        assert!(structure.sql.contains("VARCHAR2(20 CHAR)"));
        assert_eq!(structure.sql, structure.tables[0].sql);
        assert_eq!(pending.dependency_manifest, json!({"serverProof":"retained"}));
        assert_eq!(pending.table_evidence[0]["sql"], structure.sql);
        assert!(catalog.replies.lock().unwrap().is_empty());
        let encoded = serde_json::to_value(pending).unwrap();
        assert_eq!(encoded["tables"][0]["sourceTable"], "ORIGINAL");
        assert_eq!(encoded["tables"][0]["sourceEvidence"]["columns"][0], "source_column");
        assert_eq!(encoded["tables"][0]["insertedUnits"][0]["semantics"], "characters");
    }

    #[tokio::test]
    async fn explicit_table_units_do_not_read_a_pool_default_or_modify_other_tables() {
        let (request, mut structure, candidates) = pending_fixture("CREATE TABLE FINAL(V VARCHAR2(20 BYTE))");
        let original = structure.sql.clone();
        let catalog = table_catalog(None);
        let pending = prepare_pending_tables(
            &catalog,
            &request,
            &snapshot("T").endpoint,
            &snapshot("S").endpoint,
            &mut structure,
            &candidates,
            &std::collections::BTreeSet::from([0]),
            json!({}),
        )
        .await
        .unwrap();
        assert_eq!(structure.sql, original);
        assert_eq!(pending.tables.len(), 1);
        assert!(catalog.replies.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn confirmed_units_are_reapplied_without_reading_a_new_pool_default() {
        let (mut request, mut structure, candidates) = pending_fixture("CREATE TABLE FINAL(V VARCHAR2(20))");
        let original = structure.clone();
        let confirmed = prepare_pending_tables(
            &table_catalog(Some("CHAR")),
            &request,
            &snapshot("T").endpoint,
            &snapshot("S").endpoint,
            &mut structure,
            &candidates,
            &std::collections::BTreeSet::from([0]),
            json!({"proof":"original"}),
        )
        .await
        .unwrap();
        request.oracle_packages =
            Some(OraclePackageTransferRequest { pending_tables: Some(confirmed.clone()), ..Default::default() });
        let mut current = original;
        let catalog = table_catalog(None);
        let regenerated = prepare_pending_tables(
            &catalog,
            &request,
            &snapshot("T").endpoint,
            &snapshot("S").endpoint,
            &mut current,
            &candidates,
            &std::collections::BTreeSet::from([0]),
            json!({"proof":"original"}),
        )
        .await
        .unwrap();
        assert_eq!(regenerated, confirmed);
        assert_eq!(current.sql, structure.sql);
        assert!(catalog.replies.lock().unwrap().is_empty());
    }

    fn pending_preview_fixture() -> OraclePackageTransferPreview {
        let (_, mut input, _) = approval_fixture();
        input.drafts.truncate(1);
        let draft = &input.drafts[0];
        let step = OracleRoutinePlanStep {
            identity: draft.identity.clone(),
            action: RoutinePlanAction::Create,
            sql: draft.sql.clone().unwrap(),
            source_original: Some("完整原文 中文😀".into()),
            target_original: None,
            recovery_sql: None,
            recovery_complete: true,
            references: vec![],
            incoming_callers: vec![],
            issues: vec![],
            operation: None,
            package_impact: None,
        };
        let pending = PendingPackageTables {
            source: input.source.endpoint.clone(),
            target: input.target.endpoint.clone(),
            tables: vec![FrozenTableDdl::from_server_plan(
                "SOURCE",
                "T",
                "FINAL",
                "CREATE TABLE FINAL(N NUMBER)",
                json!({"original":"source"}),
                None,
            )
            .unwrap()],
            dependency_manifest: json!({"steps":["frozen"]}),
            table_evidence: vec![json!({"sql":"CREATE TABLE FINAL(N NUMBER)","namespaceRows":[]})],
        };
        OraclePackageTransferPreview {
            plan: OracleRoutinePlan { target: input.target.endpoint.clone(), steps: vec![step], ready: false },
            input,
            skipped: vec![],
            pending_tables: Some(pending),
        }
    }

    #[test]
    fn pending_claim_requires_exact_endpoint_generation_source_sql_manifest_and_unapproved_plan() {
        let preview = pending_preview_fixture();
        let confirmed = preview.pending_tables.as_ref().unwrap();
        assert!(confirm_pending_preview(preview.clone(), confirmed).is_ok());
        for case in 0..7 {
            let mut current = preview.clone();
            match case {
                0 => current.pending_tables.as_mut().unwrap().source.connection_id = "different-source".into(),
                1 => current.pending_tables.as_mut().unwrap().target.generation += 1,
                2 => current.pending_tables.as_mut().unwrap().dependency_manifest = json!({"steps":[]}),
                3 => {
                    current.pending_tables.as_mut().unwrap().table_evidence[0]["sql"] =
                        json!("CREATE TABLE OTHER(N NUMBER)")
                }
                4 => current.pending_tables.as_mut().unwrap().tables.clear(),
                5 => current.plan.ready = true,
                _ => current.plan.steps[0].issues.push(dbx_sql::object_source_sql::OracleDraftIssue {
                    code: "changed".into(),
                    message: "source changed".into(),
                    line: 3,
                    column: 7,
                }),
            }
            let error = confirm_pending_preview(current, confirmed).unwrap_err();
            let retained = error.preview.unwrap();
            assert_eq!(retained.plan.steps[0].source_original.as_deref(), Some("完整原文 中文😀"), "case {case}");
            assert_eq!(retained.input.drafts[0].sql, preview.input.drafts[0].sql);
        }
        let request = OraclePackageTransferRequest {
            input: Some(preview.input.clone()),
            operation_ids: vec![],
            pending_tables: Some(confirmed.clone()),
        };
        let roundtrip: OraclePackageTransferRequest =
            serde_json::from_value(serde_json::to_value(request).unwrap()).unwrap();
        assert_eq!(roundtrip.pending_tables.as_ref(), Some(confirmed));
    }

    #[tokio::test]
    async fn pending_stage_does_not_approve_or_dispatch_after_table_failure_or_cancellation() {
        let packages =
            PackageTransfer::AwaitingTables(Box::new(pending::PendingClaim { preview: pending_preview_fixture() }));
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, directory.path().join("plugins"));
        let (mut request, _, _) = pending_fixture("CREATE TABLE FINAL(N NUMBER)");
        request.transfer_id = uuid::Uuid::new_v4().to_string();
        let (outcome, cancelled, error) =
            packages.run(&state, &request, false, |_| panic!("Failed tables cannot emit package approval")).await;
        assert!(!cancelled && error.is_none());
        assert!(outcome.transferred.is_empty() && outcome.failed.is_empty());
        crate::data::transfer::set_cancelled(&request.transfer_id).await;
        let (outcome, cancelled, error) =
            packages.run(&state, &request, true, |_| panic!("Cancellation cannot emit package approval")).await;
        crate::data::transfer::clear_cancelled(&request.transfer_id).await;
        assert!(cancelled && error.is_none());
        assert!(outcome.transferred.is_empty() && outcome.failed.is_empty());
    }

    #[tokio::test]
    async fn namespace_or_length_visibility_failure_preserves_the_original_table_preview() {
        for failure in ["namespace", "unit", "unknown-unit"] {
            let (request, mut structure, candidates) = pending_fixture("CREATE TABLE FINAL(V VARCHAR2(20))");
            let original = structure.sql.clone();
            let catalog = table_catalog(Some("CHAR"));
            {
                let mut replies = catalog.replies.lock().unwrap();
                match failure {
                    "namespace" => replies[1].1 = Err("permission denied".into()),
                    "unit" => replies[2].1 = reply(&["VALUE"], vec![vec![json!("BYTE")], vec![json!("CHAR")]]),
                    _ => replies[2].1 = reply(&["VALUE"], vec![vec![json!("UNKNOWN")]]),
                }
            }
            assert!(
                prepare_pending_tables(
                    &catalog,
                    &request,
                    &snapshot("T").endpoint,
                    &snapshot("S").endpoint,
                    &mut structure,
                    &candidates,
                    &std::collections::BTreeSet::from([0]),
                    json!({})
                )
                .await
                .is_err(),
                "{failure}"
            );
            assert_eq!(structure.sql, original);
            assert_eq!(structure.tables[0].sql, original);
        }
    }

    #[test]
    fn direct_transfer_preflight_retains_editable_draft_and_structured_issues_before_claim() {
        let (registry, input, ids) = approval_fixture();
        let identity = input.drafts[1].identity.clone();
        let preview = OraclePackageTransferPreview {
            pending_tables: None,
            plan: OracleRoutinePlan {
                target: input.target.endpoint.clone(),
                ready: false,
                steps: vec![OracleRoutinePlanStep {
                    identity,
                    action: RoutinePlanAction::Create,
                    sql: input.drafts[1].sql.clone().unwrap(),
                    source_original: Some("original body 中文😀".into()),
                    target_original: None,
                    recovery_sql: None,
                    recovery_complete: false,
                    references: vec![],
                    incoming_callers: vec![],
                    issues: vec![dbx_sql::object_source_sql::OracleDraftIssue {
                        code: "missing-reference".into(),
                        message: "Missing column 中文😀".into(),
                        line: 3,
                        column: 7,
                    }],
                    operation: None,
                    package_impact: None,
                }],
            },
            input,
            skipped: vec![],
        };
        let expected = serde_json::to_value(&preview).unwrap();
        let request: TransferRequest = serde_json::from_value(json!({
            "transferId":"preflight", "sourceConnectionId":"S", "sourceDatabase":"tenant", "sourceSchema":"S",
            "targetConnectionId":"T", "targetDatabase":"tenant", "targetSchema":"T", "tables":["not_written"],
            "createTable":true, "batchSize":100
        }))
        .unwrap();
        let progress = require_ready_transfer_preview(preview).unwrap_err().into_progress(&request);
        assert!(progress.terminal);
        assert!(matches!(progress.status, crate::data::transfer::TransferStatus::Error));
        assert_eq!(progress.table_index, 0);
        assert_eq!(progress.rows_transferred, 0);
        assert_eq!(serde_json::to_value(progress).unwrap()["oraclePackagePreflight"], expected);
        assert!(ids.iter().all(|id| registry
            .observe(id)
            .operation
            .is_some_and(|record| record.lifecycle == RoutineOperationLifecycle::Prepared && !record.dispatched)));
        let plain = PackageTransferPreflightError::from("old error").into_progress(&request);
        let plain = serde_json::to_value(plain).unwrap();
        assert_eq!(plain["error"], "old error");
        assert!(plain.get("oraclePackagePreflight").is_none());
    }

    fn approval_fixture() -> (RoutineOperationRegistry, OracleRoutinePlanInput, Vec<String>) {
        let source = snapshot("S");
        let target = snapshot("T");
        let selected = [db::ObjectSourceKind::Package, db::ObjectSourceKind::PackageBody]
            .into_iter()
            .map(|kind| RoutineIdentity { owner: "T".into(), name: "P".into(), kind })
            .collect::<Vec<_>>();
        let config: ConnectionConfig = serde_json::from_value(json!({"id":"T", "name":"test", "db_type":DatabaseType::OceanbaseOracle, "host":"localhost", "port":2881, "username":"T", "password":"", "database":null})).unwrap();
        let mut input = OracleRoutinePlanInput { compact_sql: false, source, target, drafts: Vec::new() };
        let mut requests = Vec::new();
        for (index, identity) in selected.iter().enumerate() {
            let sql = if index == 0 {
                "CREATE PACKAGE \"T\".\"P\" AS n NUMBER; END;"
            } else {
                "CREATE PACKAGE BODY \"T\".\"P\" AS END;"
            };
            let mut original = identity.clone();
            original.owner = "S".into();
            let object = RoutineObjectSnapshot {
                version: RoutineVersion {
                    identity: original,
                    object_id: "source".into(),
                    status: "VALID".into(),
                    last_ddl_time: "1".into(),
                },
                source: Some(sql.into()),
                source_origin: None,
                source_complete: true,
                dependencies: Vec::new(),
                dependencies_complete: true,
                issues: Vec::new(),
            };
            input.source.objects.push(object.clone());
            input.drafts.push(RoutinePlanDraft {
                identity: identity.clone(),
                action: RoutinePlanAction::Create,
                source_name: Some("P".into()),
                sql: Some(sql.into()),
                baseline_operation_id: None,
                supersedes_operation_id: None,
                package_body_source: None,
                package_contract: None,
                confirm_package_pair: false,
            });
            requests.push(super::super::super::operations::PreparedRoutineWrite {
                operation_id: format!("package-{index}"),
                supersedes: None,
                binding: RoutineWriteBinding {
                    target: input.target.endpoint.clone(),
                    identity: identity.clone(),
                    sql: sql.into(),
                    goal: RoutineReadbackGoal::Definition { sql: sql.into() },
                    expected_config: config.clone(),
                    require_absent: true,
                    compare: Some(plan::ComparePreflight {
                        source: Some(plan::SourcePreflight {
                            endpoint: input.source.endpoint.clone(),
                            config: config.clone(),
                            expected: plan::ExpectedRoutine::Present(object),
                            package_pair: None,
                        }),
                        target: plan::ExpectedRoutine::Absent(identity.clone()),
                        proofs: Vec::new(),
                        incoming: None,
                        selected: selected.clone(),
                        package: None,
                    }),
                    prerequisite_operation_ids: if index == 1 { vec!["package-0".into()] } else { Vec::new() },
                    package_effect_operation_ids: Vec::new(),
                },
            });
        }
        let registry = RoutineOperationRegistry::default();
        let records = registry.prepare_batch(requests, 0).unwrap();
        let ids = records.into_iter().map(|record| record.operation_id).collect::<Vec<_>>();
        registry.update_references(&ids, &[]).unwrap();
        (registry, input, ids)
    }

    #[test]
    fn transfer_claim_consumes_original_ids_and_pins_them_across_preview_release() {
        let (registry, input, ids) = approval_fixture();
        let approved = claim_approvals(&registry, &input, &ids).unwrap();
        assert_eq!(
            approved.identities().map(|identity| identity.kind.clone()).collect::<Vec<_>>(),
            vec![db::ObjectSourceKind::Package, db::ObjectSourceKind::PackageBody]
        );
        registry.update_references(&[], &ids).unwrap();
        assert!(ids.iter().all(|id| registry.observe(id).operation.is_some()));
        drop(approved);
        assert!(ids.iter().all(|id| registry.observe(id).operation.is_none()));
    }

    #[tokio::test]
    async fn native_xugu_packages_keep_their_existing_transfer_stage_without_oracle_preflight() {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, directory.path().join("plugins"));
        for id in ["xugu-source", "xugu-target"] {
            let config: ConnectionConfig = serde_json::from_value(json!({"id":id,"name":id,"db_type":"xugu","host":"localhost","port":1,"username":"fixture","password":""})).unwrap();
            state.configs.write().await.insert(id.into(), config);
        }
        let mut request: TransferRequest = serde_json::from_value(json!({
            "transferId":"xugu-native", "sourceConnectionId":"xugu-source", "sourceDatabase":"APP", "sourceSchema":"APP",
            "targetConnectionId":"xugu-target", "targetDatabase":"APP", "targetSchema":"APP", "tables":[],
            "createTable":true, "content":"structureOnly", "batchSize":100,
            "objects":[{"objectType":"PACKAGE","names":["P"]},{"objectType":"SYNONYM","names":["S"]}]
        })).unwrap();
        assert!(prepare_transfer_packages(&state, &request, None).await.unwrap().is_none());
        assert!(claim_transfer_packages(&state, &request, None).await.unwrap().is_none());
        request.objects.as_mut().unwrap().push(crate::data::transfer::TransferObjectSelection {
            object_type: TransferObjectKind::PackageBody,
            names: vec!["P".into()],
        });
        assert!(prepare_transfer_packages(&state, &request, None).await.is_err());
        assert!(claim_transfer_packages(&state, &request, None).await.is_err());
    }

    #[test]
    fn transfer_claim_rejects_changed_sql_identity_endpoint_selection_and_order() {
        let (registry, input, ids) = approval_fixture();
        for mutation in 0..6 {
            let mut changed = input.clone();
            match mutation {
                0 => changed.drafts[0].sql = Some("CREATE PACKAGE \"T\".\"P\" AS n VARCHAR2(20); END;".into()),
                1 => changed.source.endpoint.connection_id = "another-source".into(),
                2 => changed.target.endpoint.generation += 1,
                3 => changed.drafts[0].source_name = Some("Another.P".into()),
                4 => changed.drafts[0].action = RoutinePlanAction::Replace,
                _ => {
                    changed.drafts.remove(0);
                }
            }
            assert!(claim_approvals(&registry, &changed, &ids).is_err(), "mutation {mutation}");
        }
        assert!(claim_approvals(&registry, &input, &[ids[0].clone(), ids[0].clone()]).is_err());
        assert!(claim_approvals(&registry, &input, &[ids[1].clone(), ids[0].clone()]).is_err());
        assert!(claim_approvals(&registry, &input, &[]).is_err());
        assert!(claim_approvals(&registry, &input, &ids).is_ok());
    }

    #[test]
    fn transfer_claim_cannot_mix_sibling_approvals_from_different_prepared_plans() {
        let (registry, input, ids) = approval_fixture();
        let mut requests = Vec::new();
        for (index, id) in ids.iter().enumerate() {
            let mut binding = registry.binding_for_readback(id).unwrap();
            if index == 1 {
                binding.prerequisite_operation_ids = vec!["second-0".into()];
            }
            requests.push(super::super::super::operations::PreparedRoutineWrite {
                operation_id: format!("second-{index}"),
                binding,
                supersedes: None,
            });
        }
        let second = registry
            .prepare_batch(requests, 0)
            .unwrap()
            .into_iter()
            .map(|record| record.operation_id)
            .collect::<Vec<_>>();
        registry.update_references(&second, &[]).unwrap();
        assert!(claim_approvals(&registry, &input, &[ids[0].clone(), second[1].clone()]).is_err());
        assert!(claim_approvals(&registry, &input, &second).is_ok());
    }

    #[tokio::test]
    async fn shared_package_stage_preserves_skips_and_does_not_dispatch_after_failed_tables_or_cancellation() {
        let (registry, input, ids) = approval_fixture();
        let mut approved = claim_approvals(&registry, &input, &ids).unwrap();
        approved.skipped.push(RoutineIdentity {
            owner: "T".into(),
            name: "Existing.With.Dot😀".into(),
            kind: db::ObjectSourceKind::Package,
        });
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, directory.path().join("plugins"));
        let request: TransferRequest = serde_json::from_value(json!({
            "transferId": uuid::Uuid::new_v4().to_string(), "sourceConnectionId":"S", "sourceDatabase":"tenant", "sourceSchema":"S",
            "targetConnectionId":"T", "targetDatabase":"tenant", "targetSchema":"T", "tables":["pending_table"],
            "createTable":true, "content":"structureAndData", "objects":[{"objectType":"PACKAGE", "names":["P"]}], "batchSize":100
        })).unwrap();
        let (outcome, cancelled) = approved
            .run(&state, &request, false, |_| panic!("A failed table prerequisite must prevent all package dispatch"))
            .await;
        assert!(!cancelled);
        assert_eq!(outcome.skipped, vec!["Package:Existing.With.Dot😀"]);
        assert!(outcome.transferred.is_empty() && outcome.failed.is_empty());
        crate::data::transfer::set_cancelled(&request.transfer_id).await;
        let (outcome, cancelled) =
            approved.run(&state, &request, true, |_| panic!("Cancellation must prevent package dispatch")).await;
        crate::data::transfer::clear_cancelled(&request.transfer_id).await;
        assert!(cancelled);
        assert!(outcome.transferred.is_empty() && outcome.failed.is_empty());
        assert!(ids.iter().all(|id| registry.observe(id).operation.is_some_and(|operation| operation.lifecycle
            == RoutineOperationLifecycle::Prepared
            && !operation.dispatched)));
    }

    fn snapshot(owner: &str) -> RoutineSnapshot {
        RoutineSnapshot {
            endpoint: RoutineEndpoint {
                connection_id: owner.into(),
                database: "tenant".into(),
                schema: owner.into(),
                database_type: DatabaseType::OceanbaseOracle,
                generation: 1,
            },
            state: RoutineReadState::Complete,
            enumeration_complete: true,
            objects: Vec::new(),
            issues: Vec::new(),
        }
    }
    fn selected(kind: db::ObjectSourceKind) -> RoutineSelection {
        RoutineSelection { name: "Pkg.With.Dot😀".into(), kind }
    }
    fn existing(kind: db::ObjectSourceKind) -> RoutineObjectSnapshot {
        RoutineObjectSnapshot {
            version: RoutineVersion {
                identity: RoutineIdentity {
                    owner: "Target".into(), name: "Pkg.With.Dot😀".into(), kind: kind.clone()
                },
                object_id: "1".into(),
                status: "VALID".into(),
                last_ddl_time: "1".into(),
            },
            source: Some(format!(
                "CREATE {} \"Target\".\"Pkg.With.Dot😀\" AS END \"Pkg.With.Dot😀\";",
                kind_name(&kind)
            )),
            source_origin: Some(SourceOrigin::OceanBaseDictionary),
            source_complete: true,
            dependencies: Vec::new(),
            dependencies_complete: true,
            issues: Vec::new(),
        }
    }

    #[test]
    fn explicit_transfer_selection_keeps_body_only_and_deduplicates_exact_kind_name_pairs() {
        let request: TransferRequest = serde_json::from_value(json!({"transferId":"test", "sourceConnectionId":"source", "sourceDatabase":"tenant", "sourceSchema":"Source", "targetConnectionId":"target", "targetDatabase":"tenant", "targetSchema":"Target", "tables":[], "createTable":false, "batchSize":100, "dropTargetBeforeCreate":false, "dropTargetConfirmed":false,
            "objects":[{"objectType":"PACKAGE_BODY", "names":["Pkg.With.Dot😀", "Pkg.With.Dot😀"]}]})).unwrap();
        assert_eq!(selections(&request), vec![selected(db::ObjectSourceKind::PackageBody)]);
        let (input, skipped) =
            transfer_input(snapshot("Source"), snapshot("Target"), &selections(&request), None).unwrap();
        assert!(skipped.is_empty());
        assert_eq!(input.drafts.len(), 1);
        assert_eq!(input.drafts[0].identity.kind, db::ObjectSourceKind::PackageBody);
        assert_eq!(input.drafts[0].action, RoutinePlanAction::Create);
    }

    #[test]
    fn existing_specification_is_readonly_while_a_new_body_is_planned_and_never_replaced_by_transfer() {
        let mut target = snapshot("Target");
        target.objects.push(existing(db::ObjectSourceKind::Package));
        let selected = vec![selected(db::ObjectSourceKind::Package), selected(db::ObjectSourceKind::PackageBody)];
        let (input, skipped) = transfer_input(snapshot("Source"), target.clone(), &selected, None).unwrap();
        assert_eq!(skipped, vec![target.objects[0].version.identity.clone()]);
        assert_eq!(input.target.objects[0].source, target.objects[0].source);
        assert_eq!(input.drafts.len(), 1);
        assert_eq!(input.drafts[0].identity.kind, db::ObjectSourceKind::PackageBody);
        let mut replacement = input.drafts[0].clone();
        replacement.identity.kind = db::ObjectSourceKind::Package;
        replacement.action = RoutinePlanAction::Replace;
        assert!(transfer_input(snapshot("Source"), target, &selected, Some(&[replacement])).is_err());
    }

    #[test]
    fn editable_inputs_cannot_omit_new_selected_kinds_or_add_unselected_or_duplicate_writes() {
        let selected = vec![selected(db::ObjectSourceKind::PackageBody)];
        let (input, _) = transfer_input(snapshot("Source"), snapshot("Target"), &selected, None).unwrap();
        assert!(transfer_input(snapshot("Source"), snapshot("Target"), &selected, Some(&[])).is_err());
        let draft = input.drafts[0].clone();
        assert!(transfer_input(
            snapshot("Source"),
            snapshot("Target"),
            &selected,
            Some(&[draft.clone(), draft.clone()])
        )
        .is_err());
        let mut unselected = draft.clone();
        unselected.identity.name = "Other".into();
        assert!(transfer_input(snapshot("Source"), snapshot("Target"), &selected, Some(&[unselected])).is_err());
        let (restored, _) = transfer_input(snapshot("Source"), snapshot("Target"), &selected, Some(&[draft])).unwrap();
        assert_eq!(restored.drafts.len(), 1);
    }
}
