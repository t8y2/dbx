use super::operations::{BeginRoutineOperation, RoutineWriteBinding};
use super::*;
use crate::connection::session_credentials::{current_credential_owner, with_credential_owner};
use crate::db::agent_driver::{AgentCallError, AgentErrorCategory, AgentErrorStage, AgentOperationOutcome};
use crate::query::query_cancel::RunningTaskMetadata;
use crate::query::{execute_sql_statement_with_options_typed, QueryExecutionError};
use dbx_sql::object_source_sql::{validate_oracle_routine_target_definition, EditableObjectSourceSqlInput};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleRoutineSaveInput {
    pub connection_id: String,
    pub database: String,
    pub identity: RoutineIdentity,
    pub sql: String,
    #[serde(default)]
    pub require_absent: bool,
    pub prerequisite_operation_id: Option<String>,
    #[serde(default)]
    pub supersedes_operation_id: Option<String>,
}

/// Ordinary saves retain their existing permission contract. In particular this
/// path does not ask for global inbound-dependency visibility.
pub async fn prepare_oracle_routine_save_core(
    state: &AppState,
    input: OracleRoutineSaveInput,
) -> Result<RoutineOperationRecord, String> {
    prepare_definition(state, input, false).await
}

pub(super) fn prepare_bound_definition_pinned(
    state: &AppState,
    input: OracleRoutineSaveInput,
    config: ConnectionConfig,
    generation: u64,
    require_absent: bool,
) -> Result<(RoutineOperationRecord, operations::RoutineOperationPin<'_>), String> {
    let record = prepare_bound_definition_with_pins(state, input, config, generation, require_absent, 1)?;
    let pin = state.routine_operations.adopt_pin(&record.operation_id);
    Ok((record, pin))
}

pub(super) async fn prepare_definition(
    state: &AppState,
    input: OracleRoutineSaveInput,
    require_absent: bool,
) -> Result<RoutineOperationRecord, String> {
    let config = connection_config(state, &input.connection_id).await.ok_or("Connection not found")?;
    let generation = state.connection_lifecycle_snapshot(&input.connection_id).generation();
    let require_absent = require_absent || input.require_absent;
    if matches!(input.identity.kind, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody) {
        let (database_type, _) = routine_source_origin(&config)?;
        let target = RoutineEndpoint {
            connection_id: input.connection_id.clone(),
            database: input.database.clone(),
            schema: input.identity.owner.clone(),
            database_type,
            generation,
        };
        let catalog = LiveCatalog { state, endpoint: &target, config: &config };
        return prepare_package_definition(
            &state.routine_operations,
            &catalog,
            input,
            &target,
            &config,
            require_absent,
        )
        .await;
    }
    prepare_bound_definition(state, input, config, generation, require_absent)
}

async fn prepare_package_definition(
    registry: &RoutineOperationRegistry,
    catalog: &impl RoutineCatalog,
    input: OracleRoutineSaveInput,
    target: &RoutineEndpoint,
    config: &ConnectionConfig,
    require_absent: bool,
) -> Result<RoutineOperationRecord, String> {
    let (database_type, origin) = routine_source_origin(config)?;
    if input.identity.owner.is_empty()
        || input.identity.name.is_empty()
        || target.schema != input.identity.owner
        || target.connection_id != input.connection_id
        || target.database != input.database
    {
        return Err("A package save requires its exact original target, owner and name".into());
    }
    validate_oracle_routine_target_definition(
        EditableObjectSourceSqlInput {
            database_type,
            object_type: input.identity.kind.clone(),
            schema: Some(input.identity.owner.clone()),
            name: input.identity.name.clone(),
            source: input.sql.clone(),
        },
        require_absent.then_some(false),
    )?;
    if let Some(id) = &input.prerequisite_operation_id {
        let specification = registry.binding_for_readback(id)?;
        if input.identity.kind != db::ObjectSourceKind::PackageBody
            || specification.identity.kind != db::ObjectSourceKind::Package
            || specification.identity.owner != input.identity.owner
            || specification.identity.name != input.identity.name
            || specification.target != *target
            || specification.expected_config != *config
            || !registry.observe(id).operation.is_some_and(|record| record.verified())
        {
            return Err(
                "The new package body requires its original verified specification operation on the same target".into(),
            );
        }
    }
    let compare = plan::package_save_preflight(catalog, target, &input.identity, origin).await?;
    if require_absent {
        if !matches!(&compare.target, plan::ExpectedRoutine::Absent(_)) {
            return Err("The new package save target already exists; refresh without overwriting it".into());
        }
        if input.identity.kind == db::ObjectSourceKind::Package
            && !matches!(&compare.package.as_ref().unwrap().pair.body, plan::ExpectedRoutine::Absent(_))
        {
            return Err(
                "The new package name has a residual body; refresh without overwriting that package pair".into()
            );
        }
    }
    registry.prepare_replacing(
        RoutineWriteBinding {
            target: target.clone(),
            identity: input.identity,
            goal: RoutineReadbackGoal::Definition { sql: input.sql.clone() },
            sql: input.sql,
            expected_config: config.clone(),
            require_absent,
            compare: Some(compare),
            prerequisite_operation_ids: input.prerequisite_operation_id.into_iter().collect(),
            package_effect_operation_ids: Vec::new(),
        },
        input.supersedes_operation_id.as_deref(),
    )
}

pub(super) fn prepare_bound_definition(
    state: &AppState,
    input: OracleRoutineSaveInput,
    config: ConnectionConfig,
    generation: u64,
    require_absent: bool,
) -> Result<RoutineOperationRecord, String> {
    prepare_bound_definition_with_pins(state, input, config, generation, require_absent, 0)
}

fn prepare_bound_definition_with_pins(
    state: &AppState,
    input: OracleRoutineSaveInput,
    config: ConnectionConfig,
    generation: u64,
    require_absent: bool,
    pins: usize,
) -> Result<RoutineOperationRecord, String> {
    let require_absent = require_absent || input.require_absent;
    if input.prerequisite_operation_id.is_some() {
        return Err("A package specification prerequisite applies only to controlled package-body saves".into());
    }
    let (database_type, _) = routine_source_origin(&config)?;
    if !matches!(input.identity.kind, db::ObjectSourceKind::Procedure | db::ObjectSourceKind::Function) {
        return Err("Standalone routine saves require an exact procedure/function identity".into());
    }
    if input.identity.owner.is_empty() || input.identity.name.is_empty() {
        return Err("A routine write requires its exact original owner and name".into());
    }
    validate_oracle_routine_target_definition(
        EditableObjectSourceSqlInput {
            database_type,
            object_type: input.identity.kind.clone(),
            schema: Some(input.identity.owner.clone()),
            name: input.identity.name.clone(),
            source: input.sql.clone(),
        },
        require_absent.then_some(false),
    )?;
    let target = RoutineEndpoint {
        connection_id: input.connection_id,
        database: input.database,
        schema: input.identity.owner.clone(),
        database_type,
        generation,
    };
    let mut records = state.routine_operations.prepare_batch(
        vec![operations::PreparedRoutineWrite {
            operation_id: uuid::Uuid::new_v4().to_string(),
            binding: RoutineWriteBinding {
                target,
                identity: input.identity,
                goal: RoutineReadbackGoal::Definition { sql: input.sql.clone() },
                sql: input.sql,
                expected_config: config,
                require_absent,
                compare: None,
                prerequisite_operation_ids: Vec::new(),
                package_effect_operation_ids: Vec::new(),
            },
            supersedes: input.supersedes_operation_id,
        }],
        pins,
    )?;
    Ok(records.remove(0))
}

/// The caller already knows operationId from preparation. Dropping its HTTP or
/// desktop wait cannot drop the spawned database operation or cause a replay.
pub async fn execute_oracle_routine_operation_core(
    state: Arc<AppState>,
    operation_id: String,
    approved_sql: String,
) -> Result<RoutineOperationRecord, String> {
    let binding = match state.routine_operations.begin(&operation_id, &approved_sql)? {
        BeginRoutineOperation::Existing(record) => return Ok(*record),
        BeginRoutineOperation::Dispatch(binding) => *binding,
    };
    let owner_scope = current_credential_owner();
    let _response_pin = state.routine_operations.adopt_pin(&operation_id);
    let app = state.clone();
    let id = operation_id.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(with_credential_owner(owner_scope, async move {
        let _worker_pin = app.routine_operations.adopt_pin(&id);
        perform_write(&app, &id, binding).await;
        let _ = tx.send(());
    }));
    // This bounds only the response wait. The registry remains Running until
    // the original worker obtains its own result, even if the client times out.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(30), rx).await;
    state
        .routine_operations
        .observe(&operation_id)
        .operation
        .ok_or_else(|| "Routine operation is unavailable; do not replay".into())
}

async fn perform_write(state: &AppState, id: &str, binding: RoutineWriteBinding) {
    let lifecycle = state.connection_lifecycle_snapshot(&binding.target.connection_id);
    let mut metadata =
        RunningTaskMetadata::query(binding.target.connection_id.clone(), binding.target.database.clone(), None);
    metadata.owner_scope = current_credential_owner();
    let registered = state.running_queries.register_task_for_terminal_confirmation_with_parent(
        id.into(),
        metadata,
        lifecycle.cancellation(),
    );
    let io = LiveWriter {
        catalog: LiveCatalog { state, endpoint: &binding.target, config: &binding.expected_config },
        cancellation: registered.token(),
        execution_id: id,
    };
    let (_, origin) =
        routine_source_origin(&binding.expected_config).expect("preparation accepted this routine engine");
    let source = binding.compare.as_ref().and_then(|compare| compare.source.as_ref()).map(|before| LiveCatalog {
        state,
        endpoint: &before.endpoint,
        config: &before.config,
    });
    run_write(&state.routine_operations, id, &binding, &io, source.as_ref(), origin).await;
    drop(registered);
}

/// The transfer runner already owns a server-side task independent of the UI.
/// Reuse that lifetime instead of requiring Arc at the legacy Core entry point.
pub(super) async fn execute_prepared_inline(
    state: &AppState,
    operation_id: &str,
    approved_sql: &str,
) -> Result<RoutineOperationRecord, String> {
    let binding = match state.routine_operations.begin(operation_id, approved_sql)? {
        BeginRoutineOperation::Existing(record) => return Ok(*record),
        BeginRoutineOperation::Dispatch(binding) => *binding,
    };
    let _response_pin = state.routine_operations.adopt_pin(operation_id);
    let _worker_pin = state.routine_operations.adopt_pin(operation_id);
    perform_write(state, operation_id, binding).await;
    state
        .routine_operations
        .observe(operation_id)
        .operation
        .ok_or_else(|| "Original routine operation is unavailable; do not replay".into())
}

pub async fn observe_oracle_routine_operation_core(
    state: &AppState,
    operation_id: &str,
    refresh_readback: bool,
) -> RoutineOperationObservation {
    let _readback_pin = refresh_readback.then(|| state.routine_operations.pin(operation_id).ok()).flatten();
    if _readback_pin.is_some() {
        if let Ok(binding) = state.routine_operations.binding_for_readback(operation_id) {
            let catalog = LiveCatalog { state, endpoint: &binding.target, config: &binding.expected_config };
            if let Ok((_, origin)) = routine_source_origin(&binding.expected_config) {
                let current =
                    current_readback(&state.routine_operations, operation_id, &binding, &catalog, origin).await;
                // Updating current contents deliberately does not change lifecycle.
                state.routine_operations.update_readback(operation_id, current);
            }
        }
    }
    state.routine_operations.observe(operation_id)
}

async fn current_readback(
    registry: &RoutineOperationRegistry,
    id: &str,
    binding: &RoutineWriteBinding,
    catalog: &impl RoutineCatalog,
    origin: SourceOrigin,
) -> RoutineReadback {
    let mut current =
        readback::readback(catalog, &binding.target, binding.identity.clone(), &binding.goal, origin).await;
    if binding.identity.kind == db::ObjectSourceKind::PackageBody {
        match registry
            .package_effects_for_write(id)
            .and_then(|effects| plan::observed_body_preflight(binding, &effects))
        {
            Ok(compare) => plan::validate_post_state(binding, compare.as_ref(), &mut current),
            Err(error) => {
                current.state = RoutineReadbackState::ReadbackFailed;
                current.issues.push(issue("package-contract", error));
            }
        }
    }
    current
}

#[async_trait::async_trait]
trait RoutineWriteIo: RoutineCatalog {
    async fn check_write(&self, sql: &str) -> Result<(), String>;
    async fn write(&self, sql: &str) -> Result<db::QueryResult, QueryExecutionError>;
}

struct LiveWriter<'a> {
    catalog: LiveCatalog<'a>,
    cancellation: CancellationToken,
    execution_id: &'a str,
}

#[async_trait::async_trait]
impl RoutineCatalog for LiveWriter<'_> {
    async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
        self.catalog.query(sql).await
    }
    async fn source(&self, identity: &RoutineIdentity) -> Result<SourceReply, String> {
        self.catalog.source(identity).await
    }
}

#[async_trait::async_trait]
impl RoutineWriteIo for LiveWriter<'_> {
    async fn check_write(&self, sql: &str) -> Result<(), String> {
        self.catalog.check_endpoint().await?;
        crate::query::check_read_only_for_connection(self.catalog.state, &self.catalog.endpoint.connection_id, sql)
            .await
    }
    async fn write(&self, sql: &str) -> Result<db::QueryResult, QueryExecutionError> {
        execute_sql_statement_with_options_typed(
            self.catalog.state,
            &self.catalog.endpoint.connection_id,
            &self.catalog.endpoint.database,
            sql,
            Some(&self.catalog.endpoint.schema),
            Some(self.cancellation.clone()),
            QueryExecutionOptions {
                timeout_secs: Some(0),
                await_cancel_completion: true,
                execution_id: Some(self.execution_id.into()),
                ..Default::default()
            },
        )
        .await
    }
}

struct WriteGuard<'a> {
    registry: &'a RoutineOperationRegistry,
    id: &'a str,
    complete: bool,
}
impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        if !self.complete {
            self.registry.waiting_lost(
                self.id,
                "Original routine execution worker ended without terminal evidence; do not replay".into(),
            );
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum WriteFailure {
    NotStarted,
    Terminal,
    Unproven,
}

fn classify_write_failure(error: &QueryExecutionError) -> WriteFailure {
    match error {
        QueryExecutionError::Agent(error) if error.operation_outcome() == AgentOperationOutcome::NotStarted => {
            WriteFailure::NotStarted
        }
        QueryExecutionError::Canceled { operation_outcome: AgentOperationOutcome::NotStarted, .. } => {
            WriteFailure::NotStarted
        }
        QueryExecutionError::Sql(_) | QueryExecutionError::SqlWithPosition { .. } => WriteFailure::Terminal,
        QueryExecutionError::Agent(AgentCallError::Structured { context, .. })
            if context.category == AgentErrorCategory::Sql
                && matches!(context.stage, AgentErrorStage::Execute | AgentErrorStage::Fetch) =>
        {
            WriteFailure::Terminal
        }
        _ => WriteFailure::Unproven,
    }
}

async fn run_write(
    registry: &RoutineOperationRegistry,
    id: &str,
    binding: &RoutineWriteBinding,
    io: &impl RoutineWriteIo,
    source: Option<&impl RoutineCatalog>,
    origin: SourceOrigin,
) {
    let mut guard = WriteGuard { registry, id, complete: false };
    let mut effective_compare = None;
    let preflight: Result<(), String> = async {
        io.check_write(&binding.sql).await?;
        let effects=registry.package_effects_for_write(id)?;
        effective_compare=plan::effective_preflight(binding,&effects)?;
        if matches!(binding.identity.kind,db::ObjectSourceKind::Package|db::ObjectSourceKind::PackageBody) && !effective_compare.as_ref().is_some_and(|compare|compare.package.is_some()) {
            return Err("Package dispatch requires its frozen pair approval".into());
        }
        if let Some(compare)=&effective_compare {plan::verify_compare_preflight(source,io,&binding.target,compare,origin).await?;}
        if binding.require_absent {
            let before = readback::readback(
                io,
                &binding.target,
                binding.identity.clone(),
                &RoutineReadbackGoal::Inspect,
                origin,
            )
            .await;
            if before.exists != Some(false) || !before.issues.is_empty() {
                return Err("Routine target is not confirmed absent; preserve the draft and read a new preview".into());
            }
        }
        for (prerequisite, before) in registry.prerequisites_for_write(id)? {
            let before=plan::effective_prerequisite(&prerequisite,&before,&effects)?;
            let current = readback::readback(
                io,
                &prerequisite.target,
                prerequisite.identity.clone(),
                &prerequisite.goal,
                origin,
            ).await;
            if current.state != RoutineReadbackState::Verified
                || !current.issues.is_empty()
                || !plan::same_observation(&current,&before)
            {
                return Err(format!(
                    "Prerequisite routine {}.{} changed since its verified deployment; refresh and validate the remaining draft without replaying completed steps",
                    prerequisite.identity.owner, prerequisite.identity.name,
                ));
            }
        }
        io.check_write(&binding.sql).await?;
        Ok(())
    }
    .await;
    if let Err(error) = preflight {
        registry.not_started(id, error);
        guard.complete = true;
        return;
    }
    if let Err(error) = registry.mark_dispatched(id) {
        registry.waiting_lost(id, error);
        guard.complete = true;
        return;
    }
    let result = io.write(&binding.sql).await;
    let (acknowledged, error, failure) = match result {
        Ok(result) => {
            let error = result
                .messages
                .iter()
                .find(|message| message.severity.eq_ignore_ascii_case("ERROR"))
                .map(|message| message.message.clone());
            (error.is_none(), error, WriteFailure::Terminal)
        }
        Err(error) => (false, Some(error.to_string()), classify_write_failure(&error)),
    };
    match failure {
        WriteFailure::NotStarted => registry.not_started(id, error.expect("NotStarted is an error")),
        WriteFailure::Unproven => registry.waiting_lost(id, error.expect("Unproven is an error")),
        WriteFailure::Terminal => {
            // Receipt/terminal evidence belongs to the write itself. A later
            // metadata timeout or dropped readback must not erase that fact.
            registry.terminal(id, acknowledged, None, error.clone());
            let mut current =
                readback::readback(io, &binding.target, binding.identity.clone(), &binding.goal, origin).await;
            plan::validate_post_state(binding, effective_compare.as_ref(), &mut current);
            registry.terminal(id, acknowledged, Some(current), error);
        }
    }
    guard.complete = true;
}

#[cfg(test)]
mod package_tests;
#[cfg(test)]
mod tests;
