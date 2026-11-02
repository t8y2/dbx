use super::*;
use crate::connection::{AppState, ClientSessionPoolCleanupGuard};
use crate::session_credentials::{current_credential_owner, with_credential_owner};
use dbx_sql::native_job_changes::{
    native_job_dameng_create_plan, native_job_legacy_create_preview, native_job_mutation_plan,
    native_job_scheduler_create_plan, native_job_scheduler_edit_plan, NativeJobDamengCreatePlan,
    NativeJobSchedulerSqlPlan, NativeJobSqlPlan, NativeJobSqlStep, NativeJobStepEffect,
};
use dbx_types::native_jobs::*;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, Weak};
use tokio_util::sync::CancellationToken;

const MAX_OPERATIONS: usize = 256;

mod arguments;
mod dameng;
mod legacy;
mod observation;
pub use observation::Snapshot as NativeJobExecutionRead;
mod scheduler;
mod values;

enum PreparedAction {
    Mutation { mutation: NativeJobMutation, plan: NativeJobSqlPlan },
    SchedulerTransition { mutation: NativeJobMutation, plan: Box<scheduler::transition::PreparedSchedulerTransition> },
    LegacyCreate { definition: NativeJobLegacyCreate, steps: Vec<NativeJobStepPreview> },
    SchedulerCreate { definition: Box<NativeJobSchedulerCreate>, plan: NativeJobSchedulerSqlPlan },
    DamengCreate { definition: NativeJobDamengCreate, plan: NativeJobDamengCreatePlan },
}

struct PreparedExecution {
    binding: super::service::BoundContext,
    action: PreparedAction,
    origin_key: String,
    lock_key: String,
}

type OperationClaim = (NativeJobOperationStatus, Option<(PreparedExecution, CancellationToken)>);

struct OperationRecord {
    plan_id: String,
    actor: Option<String>,
    status: NativeJobOperationStatus,
    pending: Option<PreparedExecution>,
    cancel: CancellationToken,
    observation: Option<Arc<tokio::sync::Mutex<observation::Tracker>>>,
    rename: Option<Arc<tokio::sync::Mutex<dameng::rename::Binding>>>,
    run_lease: Option<Weak<RunLease>>,
}

struct RunLease {
    _guards: Vec<tokio::sync::OwnedMutexGuard<()>>,
    binding: super::service::BoundContext,
    target: NativeJobRef,
    identity: NativeJobRow,
}

struct PublishedRun {
    operations: NativeJobOperations,
    id: String,
    _lease: Arc<RunLease>,
}

impl Drop for PublishedRun {
    fn drop(&mut self) {
        if let Some(record) = self
            .operations
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .records
            .iter_mut()
            .find(|record| record.status.operation_id == self.id)
        {
            record.run_lease = None;
        }
    }
}

#[derive(Default)]
struct Ledger {
    records: VecDeque<OperationRecord>,
    job_locks: HashMap<String, Weak<tokio::sync::Mutex<()>>>,
    pending_dm_configurations: HashSet<String>,
}

#[derive(Clone, Default)]
pub struct NativeJobOperations(Arc<Mutex<Ledger>>);

impl NativeJobOperations {
    fn register(&self, execution: PreparedExecution) -> Result<NativeJobPreparedPlan, &'static str> {
        let plan_id = uuid::Uuid::new_v4().to_string();
        let operation_id = uuid::Uuid::new_v4().to_string();
        let (target, steps) = match &execution.action {
            PreparedAction::Mutation { mutation, plan } => (
                Some(mutation.target.clone()),
                plan.steps
                    .iter()
                    .map(|step| NativeJobStepPreview {
                        id: step.id.clone(),
                        label: step.label.clone(),
                        sql: step.sql.clone(),
                    })
                    .collect(),
            ),
            PreparedAction::SchedulerTransition { mutation, plan } => (
                Some(mutation.target.clone()),
                plan.edit
                    .sql
                    .steps
                    .iter()
                    .map(|step| NativeJobStepPreview {
                        id: step.id.clone(),
                        label: step.label.clone(),
                        sql: step.sql.clone(),
                    })
                    .collect(),
            ),
            PreparedAction::LegacyCreate { steps, .. } => (None, steps.clone()),
            PreparedAction::DamengCreate { plan, .. } => (
                None,
                plan.steps
                    .iter()
                    .map(|step| NativeJobStepPreview {
                        id: step.id.clone(),
                        label: step.label.clone(),
                        sql: step.sql.clone(),
                    })
                    .collect(),
            ),
            PreparedAction::SchedulerCreate { plan, .. } => (
                Some(plan.target.clone()),
                plan.steps
                    .iter()
                    .map(|step| NativeJobStepPreview {
                        id: step.id.clone(),
                        label: step.label.clone(),
                        sql: step.sql.clone(),
                    })
                    .collect(),
            ),
        };
        let prepared = NativeJobPreparedPlan {
            plan_id: plan_id.clone(),
            operation_id: operation_id.clone(),
            scope: execution.binding.context.scope.clone(),
            target,
            steps,
        };
        let status = NativeJobOperationStatus {
            operation_id,
            target: prepared.target.clone(),
            observed_identity: None,
            created_children: Vec::new(),
            execution_observation: None,
            state: NativeJobOperationState::Prepared,
            outcome: NativeJobOperationOutcome::NotStarted,
            cancel_requested: false,
            steps: prepared
                .steps
                .iter()
                .map(|step| NativeJobStepStatus {
                    id: step.id.clone(),
                    state: NativeJobStepState::Pending,
                    reason: None,
                    vendor_code: None,
                })
                .collect(),
            reason: None,
        };
        let mut ledger = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if ledger.records.len() >= MAX_OPERATIONS {
            let disposable = ledger
                .records
                .iter()
                .position(|record| {
                    matches!(record.status.state, NativeJobOperationState::Prepared | NativeJobOperationState::Finished)
                })
                .ok_or("native_job_operations_busy")?;
            ledger.records.remove(disposable);
        }
        ledger.records.push_back(OperationRecord {
            plan_id,
            actor: current_credential_owner(),
            status,
            pending: Some(execution),
            cancel: CancellationToken::new(),
            observation: None,
            rename: None,
            run_lease: None,
        });
        Ok(prepared)
    }

    fn claim(&self, plan_id: &str) -> Result<OperationClaim, &'static str> {
        let actor = current_credential_owner();
        let mut ledger = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let record = ledger
            .records
            .iter_mut()
            .find(|record| record.plan_id == plan_id && record.actor == actor)
            .ok_or("native_job_preview_stale")?;
        let execution = record.pending.take();
        if execution.is_some() {
            record.status.state = NativeJobOperationState::Queued;
        }
        Ok((record.status.clone(), execution.map(|execution| (execution, record.cancel.clone()))))
    }

    fn status(&self, operation_id: &str) -> NativeJobOperationStatus {
        let actor = current_credential_owner();
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .records
            .iter()
            .find(|record| record.status.operation_id == operation_id && record.actor == actor)
            .map(|record| record.status.clone())
            .unwrap_or_else(|| missing_status(operation_id))
    }

    fn edit(&self, operation_id: &str, edit: impl FnOnce(&mut NativeJobOperationStatus)) {
        let actor = current_credential_owner();
        if let Some(record) = self
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .records
            .iter_mut()
            .find(|record| record.status.operation_id == operation_id && record.actor == actor)
        {
            edit(&mut record.status);
        }
    }

    fn job_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut ledger = self.0.lock().unwrap_or_else(|error| error.into_inner());
        ledger.job_locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = ledger.job_locks.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        ledger.job_locks.insert(key.into(), Arc::downgrade(&lock));
        lock
    }

    fn configuration_pending(&self, key: &str) -> bool {
        self.0.lock().unwrap_or_else(|error| error.into_inner()).pending_dm_configurations.contains(key)
    }

    fn publish_run(
        &self,
        id: &str,
        execution: &PreparedExecution,
        target: &NativeJobRef,
        identity: NativeJobRow,
        guards: &mut Vec<tokio::sync::OwnedMutexGuard<()>>,
        step: usize,
    ) -> PublishedRun {
        let lease = Arc::new(RunLease {
            _guards: std::mem::take(guards),
            binding: execution.binding.clone(),
            target: target.clone(),
            identity,
        });
        let mut ledger = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let record =
            ledger.records.iter_mut().find(|record| record.status.operation_id == id).expect("claimed Run record");
        record.run_lease = Some(Arc::downgrade(&lease));
        record.status.steps[step].state = NativeJobStepState::Dispatching;
        PublishedRun { operations: self.clone(), id: id.into(), _lease: lease }
    }

    fn borrow_run(&self, execution: &PreparedExecution, target: &NativeJobRef) -> Option<Arc<RunLease>> {
        let actor = current_credential_owner();
        let ledger = self.0.lock().unwrap_or_else(|error| error.into_inner());
        ledger
            .records
            .iter()
            .filter(|record| {
                record.actor == actor
                    && record.status.state == NativeJobOperationState::Running
                    && record
                        .status
                        .steps
                        .iter()
                        .any(|step| step.id == "run" && step.state == NativeJobStepState::Dispatching)
            })
            .find_map(|record| {
                let lease = record.run_lease.as_ref()?.upgrade()?;
                (&lease.target == target && lease.binding.context.scope == execution.binding.context.scope)
                    .then_some(lease)
            })
    }

    fn configuration_dispatched(&self, key: &str) -> bool {
        self.0.lock().unwrap_or_else(|error| error.into_inner()).pending_dm_configurations.insert(key.into())
    }

    fn configuration_verified(&self, key: &str) {
        self.0.lock().unwrap_or_else(|error| error.into_inner()).pending_dm_configurations.remove(key);
    }
}

fn missing_status(operation_id: &str) -> NativeJobOperationStatus {
    NativeJobOperationStatus {
        operation_id: operation_id.into(),
        target: None,
        observed_identity: None,
        created_children: Vec::new(),
        execution_observation: None,
        state: NativeJobOperationState::Finished,
        outcome: NativeJobOperationOutcome::Unknown,
        cancel_requested: false,
        steps: Vec::new(),
        reason: Some("native_job_operation_record_unavailable".into()),
    }
}

pub fn native_job_status(state: &AppState, operation_id: &str) -> NativeJobOperationStatus {
    state.native_jobs.operations().status(operation_id)
}

pub async fn native_job_status_observed_core(
    state: &AppState,
    operation_id: &str,
    observe: bool,
) -> NativeJobOperationStatus {
    let operations = state.native_jobs.operations();
    let actor = current_credential_owner();
    let (tracker, rename) = if observe {
        operations
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .records
            .iter()
            .find(|record| {
                record.status.operation_id == operation_id
                    && record.actor == actor
                    && record.status.state == NativeJobOperationState::Finished
            })
            .map(|record| (record.observation.clone(), record.rename.clone()))
            .unwrap_or_default()
    } else {
        (None, None)
    };
    if let Some(tracker) = tracker {
        let mut tracker = tracker.lock().await;
        let result = observation::read_core(state, &tracker.binding, &tracker.target).await;
        let observed = match result {
            Ok(current) => tracker.record(current),
            Err(reason) => observation::unavailable(reason),
        };
        operations.edit(operation_id, |status| status.execution_observation = Some(observed));
    }
    if let Some(tracker) = rename {
        let tracker = tracker.lock().await;
        if let Ok((target, identity)) = dameng::rename::observe_core(state, &tracker).await {
            operations.edit(operation_id, |status| {
                status.target = Some(target);
                status.observed_identity = Some(identity);
            });
        }
    }
    operations.status(operation_id)
}

pub fn native_job_cancel(state: &AppState, operation_id: &str) -> NativeJobOperationStatus {
    let operations = state.native_jobs.operations();
    let actor = current_credential_owner();
    {
        let mut ledger = operations.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(record) =
            ledger.records.iter_mut().find(|record| record.status.operation_id == operation_id && record.actor == actor)
        {
            if record.status.state != NativeJobOperationState::Finished {
                record.cancel.cancel();
                record.status.cancel_requested = true;
                if record.pending.take().is_some() {
                    record.status.state = NativeJobOperationState::Finished;
                    record.status.outcome = NativeJobOperationOutcome::NotApplied;
                    record.status.reason = Some("native_job_canceled_before_dispatch".into());
                    for step in &mut record.status.steps {
                        step.state = NativeJobStepState::Skipped;
                    }
                }
            }
        }
    }
    operations.status(operation_id)
}

pub async fn native_job_prepare_with<Q, F>(
    state: &AppState,
    mutation: NativeJobMutation,
    read: Q,
) -> Result<NativeJobPreparedPlan, &'static str>
where
    Q: FnOnce(NativeJobRef) -> F,
    F: Future<Output = Result<NativeJobDetails, &'static str>>,
{
    native_job_prepare_with_references(state, mutation, read, |request| async move {
        super::native_job_references_core(state, &request).await.map_err(|_| "native_job_reference_read_failed")
    })
    .await
}

pub async fn native_job_prepare_with_references<Q, F, R, RF>(
    state: &AppState,
    mutation: NativeJobMutation,
    read: Q,
    mut read_reference: R,
) -> Result<NativeJobPreparedPlan, &'static str>
where
    Q: FnOnce(NativeJobRef) -> F,
    F: Future<Output = Result<NativeJobDetails, &'static str>>,
    R: FnMut(NativeJobReferenceListRequest) -> RF,
    RF: Future<Output = Result<NativeJobReferenceCatalog, &'static str>>,
{
    mutation.target.validate()?;
    let binding = state.native_jobs.context(state, mutation.target.scope())?;
    let latest = read(mutation.target.clone()).await?;
    let scheduler_edit = if matches!(mutation.target, NativeJobRef::Scheduler { .. })
        && matches!(mutation.change, NativeJobChange::Update { .. })
    {
        Some(native_job_scheduler_edit_plan(binding.context.engine, &mutation, &latest)?)
    } else {
        None
    };
    let mut plan = scheduler_edit
        .as_ref()
        .map(|edit| Ok(edit.sql.clone()))
        .unwrap_or_else(|| native_job_mutation_plan(binding.context.engine, &mutation, &latest));
    let NativeJobMetadata::Available { value: identity } = &latest.native_identity else {
        return Err("native_job_identity_unverified");
    };
    let origin_key = native_origin_key(&binding, &mutation.target, identity);
    if binding.context.engine == NativeJobEngine::Dameng
        && !matches!(mutation.target, NativeJobRef::Scheduler { .. })
        && (matches!(mutation.change, NativeJobChange::Enable)
            || (plan.as_ref().err().copied() == Some("native_job_no_changes")
                && matches!(mutation.change, NativeJobChange::Update { .. } | NativeJobChange::ConfigureDameng { .. })))
        && (state.native_jobs.operations().configuration_pending(&origin_key)
            || row(&latest).is_some_and(|row| row.get("VALID").and_then(Value::as_str) == Some("N")))
    {
        // A fresh preview explicitly shows the new configuration cycle. It neither replays the
        // previous fields nor sends an old COMMIT to a replacement physical session.
        let enabled = if matches!(mutation.change, NativeJobChange::Enable) {
            true
        } else {
            row(&latest)
                .and_then(|row| super::details::boolean(row.get("ENABLE")))
                .ok_or("native_job_metadata_incomplete")?
        };
        let recovery = NativeJobMutation {
            target: mutation.target.clone(),
            baseline: mutation.baseline.clone(),
            change: NativeJobChange::Update {
                final_enabled: None,
                argument_target: None,
                attributes: vec![NativeJobAttributeChange {
                    name: "ENABLE".into(),
                    change: NativeJobFieldChange::Set { value: Value::Bool(enabled) },
                }],
                arguments: Vec::new(),
            },
        };
        plan = native_job_mutation_plan(binding.context.engine, &recovery, &latest);
    }
    let mut plan = plan?;
    let transition = if let Some(edit) = scheduler_edit.filter(|edit| edit.transition) {
        let prepared = scheduler::transition::prepare(&binding, &mutation, &latest, edit, &mut read_reference).await?;
        plan = prepared.edit.sql.clone();
        Some(prepared)
    } else {
        None
    };
    if binding.context.engine == NativeJobEngine::Dameng
        && matches!(mutation.target, NativeJobRef::Legacy { .. })
        && matches!(
            mutation.change,
            NativeJobChange::Run
                | NativeJobChange::Enable
                | NativeJobChange::Disable
                | NativeJobChange::Drop { .. }
                | NativeJobChange::ClearHistory
        )
        && state.native_jobs.legacy_definition_recorded(state, &mutation.target, &mutation.baseline)?
    {
        plan.required_partitions.push("legacyDefinition".into());
    }
    state.native_jobs.compare_baseline(
        state,
        &mutation.target,
        &mutation.baseline,
        &latest.snapshot.revision,
        &plan.required_partitions.iter().map(String::as_str).collect::<Vec<_>>(),
        plan.compare_next_date,
    )?;
    state.native_jobs.context(state, mutation.target.scope())?;
    let lock_key = if binding.context.engine == NativeJobEngine::Dameng
        && !matches!(mutation.target, NativeJobRef::Scheduler { .. })
    {
        let name = match &mutation.target {
            NativeJobRef::DamengNative { name, .. } => name.as_str(),
            _ => row(&latest)
                .and_then(|row| row.get("NAME"))
                .and_then(Value::as_str)
                .ok_or("native_job_metadata_incomplete")?,
        };
        dameng_name_key(&binding, name)
    } else {
        origin_key.clone()
    };
    state.native_jobs.operations().register(PreparedExecution {
        binding,
        action: match transition {
            Some(plan) => PreparedAction::SchedulerTransition { mutation, plan: Box::new(plan) },
            None => PreparedAction::Mutation { mutation, plan },
        },
        origin_key,
        lock_key,
    })
}

fn native_origin_key(binding: &super::service::BoundContext, target: &NativeJobRef, identity: &NativeJobRow) -> String {
    if let NativeJobRef::Scheduler { owner, name, .. } = target {
        // Name-scoped serialization also covers the absent -> created transition. A generation
        // check still rejects an old preview after same-name replacement.
        return serde_json::to_string(&serde_json::json!([
            target.scope().connection_id,
            target.scope().database,
            binding.context.actual_database,
            binding.context.engine,
            "scheduler",
            owner,
            name,
        ]))
        .expect("JSON identity");
    }
    let family =
        if binding.context.engine == NativeJobEngine::Dameng && !matches!(target, NativeJobRef::Scheduler { .. }) {
            "dameng-native"
        } else if matches!(target, NativeJobRef::Scheduler { .. }) {
            "scheduler"
        } else {
            "legacy"
        };
    serde_json::to_string(&serde_json::json!([
        target.scope().connection_id,
        target.scope().database,
        binding.context.actual_database,
        binding.context.engine,
        family,
        identity.get("DBX_JOB_ID"),
        identity.get("DBX_CREATED_AT")
    ]))
    .expect("JSON identity")
}

fn dameng_name_key(binding: &super::service::BoundContext, name: &str) -> String {
    serde_json::to_string(&serde_json::json!([
        binding.context.scope.connection_id,
        binding.context.scope.database,
        binding.context.actual_database,
        "dameng-native-name",
        name.to_ascii_uppercase(),
    ]))
    .expect("JSON identity")
}

pub async fn native_job_prepare_request_with<Q, F>(
    state: &AppState,
    request: NativeJobRequest,
    read: Q,
) -> Result<NativeJobPreparedPlan, &'static str>
where
    Q: FnOnce(NativeJobRef) -> F,
    F: Future<Output = Result<NativeJobDetails, &'static str>>,
{
    match request {
        NativeJobRequest::Mutation(mutation) => native_job_prepare_with(state, mutation, read).await,
        NativeJobRequest::Create { scope, definition: NativeJobCreateDefinition::DamengNative(definition) } => {
            scope.validate()?;
            let binding = state.native_jobs.context(state, &scope)?;
            if binding.context.engine != NativeJobEngine::Dameng {
                return Err("native_job_action_not_applicable");
            }
            let plan = native_job_dameng_create_plan(&definition)?;
            let origin_key = dameng_name_key(&binding, &definition.name);
            state.native_jobs.operations().register(PreparedExecution {
                binding,
                action: PreparedAction::DamengCreate { definition, plan },
                lock_key: origin_key.clone(),
                origin_key,
            })
        }
        NativeJobRequest::Create { scope, definition: NativeJobCreateDefinition::Scheduler(mut definition) } => {
            scope.validate()?;
            let binding = state.native_jobs.context(state, &scope)?;
            if definition.owner.is_empty() {
                definition.owner = binding.context.session_user.clone();
            }
            scheduler::validate_namespace(&binding, &definition)?;
            let plan = native_job_scheduler_create_plan(binding.context.engine, &scope, &definition, None)?;
            let latest = read(plan.target.clone()).await?;
            scheduler::require_absent(&latest, &binding.context.session_user)?;
            state.native_jobs.context(state, &scope)?;
            let origin_key = native_origin_key(&binding, &plan.target, &NativeJobRow::new());
            state.native_jobs.operations().register(PreparedExecution {
                binding,
                action: PreparedAction::SchedulerCreate { definition, plan },
                lock_key: origin_key.clone(),
                origin_key,
            })
        }
        NativeJobRequest::Create { scope, definition: NativeJobCreateDefinition::Legacy(mut definition) } => {
            scope.validate()?;
            let binding = state.native_jobs.context(state, &scope)?;
            if !matches!(binding.context.engine, NativeJobEngine::Oracle | NativeJobEngine::OceanbaseOracle) {
                return Err("native_job_legacy_protocol_unavailable");
            }
            let parsed = chrono::NaiveDateTime::parse_from_str(&definition.next_date, "%Y-%m-%d %H:%M:%S")
                .map_err(|_| "native_job_date_invalid")?;
            if chrono::Datelike::year(&parsed) < 1
                || parsed.format("%Y-%m-%d %H:%M:%S").to_string() != definition.next_date
            {
                return Err("native_job_date_invalid");
            }
            if definition.schema.is_empty() {
                definition.schema = binding.context.session_user.clone();
            }
            let steps = native_job_legacy_create_preview(binding.context.engine, &definition)?;
            let origin_key = serde_json::to_string(&serde_json::json!([
                scope.connection_id,
                scope.database,
                binding.context.actual_database,
                binding.context.engine,
                "legacy-create",
                binding.context.session_user,
            ]))
            .expect("JSON identity");
            state.native_jobs.operations().register(PreparedExecution {
                binding,
                action: PreparedAction::LegacyCreate { definition, steps },
                lock_key: origin_key.clone(),
                origin_key,
            })
        }
    }
}

pub async fn native_job_prepare_core(
    state: &AppState,
    mut request: NativeJobRequest,
) -> Result<NativeJobPreparedPlan, String> {
    arguments::normalize_core(state, &mut request).await.map_err(str::to_string)?;
    native_job_prepare_request_with(state, request, |target| async move {
        super::native_job_read_core(state, &target).await.map_err(|_| "native_job_readback_failed")
    })
    .await
    .map_err(str::to_string)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum NativeJobDispatchOutcome {
    NotStarted,
    Applied,
    Unknown,
}

pub struct NativeJobStepReceipt {
    pub outcome: NativeJobDispatchOutcome,
    pub reason: Option<String>,
    pub vendor_code: Option<i32>,
}

#[async_trait::async_trait]
pub trait NativeJobMutationSession: Send {
    async fn read(&mut self, target: &NativeJobRef) -> Result<NativeJobDetails, &'static str>;
    async fn read_execution(&mut self, _target: &NativeJobRef) -> Result<NativeJobExecutionRead, &'static str> {
        Err("native_job_execution_reader_unavailable")
    }
    async fn execute(&mut self, step: &NativeJobSqlStep) -> NativeJobStepReceipt;
    async fn read_reference(
        &mut self,
        _request: NativeJobReferenceListRequest,
    ) -> Result<NativeJobReferenceCatalog, &'static str> {
        Err("native_job_reference_reader_unavailable")
    }
    async fn begin_configure(&mut self, _operation_id: &str) -> Result<(), &'static str> {
        Err("native_job_configuration_protocol_unavailable")
    }
    async fn query(&mut self, _query: NativeJobCatalogQuery) -> Result<Value, NativeJobCatalogFailure> {
        Err(NativeJobCatalogFailure::RouteUnavailable)
    }
    async fn prepare_legacy(
        &mut self,
        operation_id: &str,
        _definition: &NativeJobLegacyCreate,
    ) -> NativeJobLegacyReceipt {
        legacy::receipt(operation_id, NativeJobLegacyPhase::NotStarted, "native_job_legacy_protocol_unavailable")
    }
    async fn finish_legacy(
        &mut self,
        operation_id: &str,
        _job_id: Option<&str>,
        _commit: bool,
    ) -> NativeJobLegacyReceipt {
        legacy::receipt(operation_id, NativeJobLegacyPhase::Unknown, "native_job_legacy_session_unavailable")
    }
    /// Close this operation's own scope. Never commit or activate during cleanup.
    async fn finish(&mut self) -> Result<(), &'static str>;
}

pub async fn native_job_apply_with(
    state: &AppState,
    plan_id: &str,
    session: &mut impl NativeJobMutationSession,
) -> Result<NativeJobOperationStatus, &'static str> {
    let operations = state.native_jobs.operations().clone();
    let (status, claimed) = operations.claim(plan_id)?;
    if let Some((execution, cancel)) = claimed {
        run_claimed(state, &operations, &status.operation_id, execution, cancel, session).await;
    }
    Ok(operations.status(&status.operation_id))
}

struct UnknownOnDrop {
    operations: NativeJobOperations,
    id: String,
    armed: bool,
}
impl Drop for UnknownOnDrop {
    fn drop(&mut self) {
        if self.armed {
            finish_status(
                &self.operations,
                &self.id,
                NativeJobOperationOutcome::Unknown,
                Some("native_job_worker_interrupted"),
            );
        }
    }
}

fn finish_status(operations: &NativeJobOperations, id: &str, outcome: NativeJobOperationOutcome, reason: Option<&str>) {
    operations.edit(id, |status| {
        status.state = NativeJobOperationState::Finished;
        status.outcome = outcome;
        status.reason = reason.map(str::to_string);
        for step in &mut status.steps {
            if step.state == NativeJobStepState::Pending {
                step.state = NativeJobStepState::Skipped;
            } else if step.state == NativeJobStepState::Dispatching {
                step.state = NativeJobStepState::Unknown;
            }
        }
    });
}

async fn require_write(state: &AppState, binding: &super::service::BoundContext) -> Result<(), &'static str> {
    if !state.connection_lifecycle_is_current(&binding.context.scope.connection_id, &binding.lifecycle) {
        return Err("native_job_context_changed");
    }
    if !state.configs.read().await.contains_key(&binding.context.scope.connection_id) {
        return Err("native_job_connection_missing");
    }
    if crate::query::connection_readonly_name(state, &binding.context.scope.connection_id).await.is_some() {
        return Err("native_job_connection_read_only");
    }
    Ok(())
}

async fn run_claimed(
    state: &AppState,
    operations: &NativeJobOperations,
    id: &str,
    execution: PreparedExecution,
    cancel: CancellationToken,
    session: &mut impl NativeJobMutationSession,
) {
    let mut guard = UnknownOnDrop { operations: operations.clone(), id: id.into(), armed: true };
    let mut lock_keys = vec![execution.lock_key.clone()];
    if let PreparedAction::Mutation { plan, .. } = &execution.action {
        for step in &plan.steps {
            if let NativeJobStepEffect::DamengRenamed { old_name, new_name } = &step.effect {
                lock_keys.extend([
                    dameng_name_key(&execution.binding, old_name),
                    dameng_name_key(&execution.binding, new_name),
                ]);
            }
        }
    }
    lock_keys.sort();
    lock_keys.dedup();
    let locks = lock_keys.iter().map(|key| operations.job_lock(key)).collect::<Vec<_>>();
    let mut job_guards = Vec::new();
    let mut shared_run = None;
    let mut published_run = None;
    let mut stop_guard = None;
    let mut created_job_guard = None;
    let scope = &execution.binding.context.scope;
    let mut dispatched = false;
    let result: Result<NativeJobOperationOutcome, (&'static str, NativeJobOperationOutcome)> = async {
        if let PreparedAction::Mutation { mutation, .. } = &execution.action {
            if matches!(mutation.change, NativeJobChange::Stop { .. }) {
                let serial = operations.job_lock(&format!("native-stop:{}", execution.lock_key));
                stop_guard = Some(tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(("native_job_canceled_before_dispatch", NativeJobOperationOutcome::NotApplied)),
                    _ = execution.binding.lifecycle.cancellation().cancelled() => return Err(("native_job_context_changed", NativeJobOperationOutcome::NotApplied)),
                    guard = serial.lock_owned() => guard,
                });
                shared_run = operations.borrow_run(&execution, &mutation.target);
            }
        }
        if shared_run.is_none() { for lock in &locks { job_guards.push(tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(("native_job_canceled_before_dispatch", NativeJobOperationOutcome::NotApplied)),
            _ = execution.binding.lifecycle.cancellation().cancelled() => return Err(("native_job_context_changed", NativeJobOperationOutcome::NotApplied)),
            guard = lock.clone().lock_owned() => guard,
        }); } }
        require_write(state, &execution.binding).await.map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
        if matches!(&execution.action, PreparedAction::LegacyCreate { .. }) {
            return legacy::run_create(state, &execution, id, &cancel, session, &mut created_job_guard, &mut dispatched).await;
        }
        if matches!(&execution.action, PreparedAction::SchedulerCreate { .. }) {
            return scheduler::run_create(state, &execution, id, &cancel, session, &mut dispatched).await;
        }
        if matches!(&execution.action, PreparedAction::DamengCreate { .. }) {
            return dameng::run_create(state, &execution, id, &cancel, session, &mut dispatched).await;
        }
        if matches!(&execution.action, PreparedAction::SchedulerTransition { .. }) {
            return scheduler::transition::run(state, &execution, id, &cancel, session, &mut dispatched).await;
        }
        let PreparedAction::Mutation { mutation, plan } = &execution.action else { unreachable!() };
        if plan.dameng_configuration.is_some() {
            return dameng::run_configure(state, &execution, id, &cancel, session, &mut dispatched).await;
        }
        if execution.binding.context.engine == NativeJobEngine::Dameng
            && !matches!(mutation.target, NativeJobRef::Scheduler { .. })
            && matches!(mutation.change, NativeJobChange::Enable | NativeJobChange::Run)
            && operations.configuration_pending(&execution.origin_key)
        {
            return Err(("native_job_configuration_preview_required", NativeJobOperationOutcome::NotApplied));
        }
        let mut before = session.read(&mutation.target).await.map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
        state.native_jobs.compare_baseline(state, &mutation.target, &mutation.baseline,
            &before.snapshot.revision, &plan.required_partitions.iter().map(String::as_str).collect::<Vec<_>>(),
            plan.compare_next_date).map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
        if let Some(lease) = &shared_run {
            require_write(state, &lease.binding).await.map_err(|reason| (reason, NativeJobOperationOutcome::NotApplied))?;
            if !matches!(&before.native_identity, NativeJobMetadata::Available { value } if value == &lease.identity) {
                return Err(("native_job_replaced", NativeJobOperationOutcome::NotApplied));
            }
        }
        operations.edit(id, |status| status.state = NativeJobOperationState::Running);
        let mut outcome = NativeJobOperationOutcome::Verified;
        for (index, step) in plan.steps.iter().enumerate() {
            let stopped = if cancel.is_cancelled() { Some("native_job_canceled_after_dispatch") }
                else { require_write(state, &execution.binding).await.err() };
            if let Some(reason) = stopped { return Err((reason, if dispatched { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::NotApplied })); }
            if plan.steps.len() == 1 && matches!(mutation.change, NativeJobChange::Run)
                && (matches!(mutation.target, NativeJobRef::Scheduler { .. }) || execution.binding.context.engine == NativeJobEngine::Dameng)
            {
                let NativeJobMetadata::Available { value: identity } = &before.native_identity else { unreachable!("baseline identity verified") };
                published_run = Some(operations.publish_run(id, &execution, &mutation.target, identity.clone(), &mut job_guards, index));
            } else {
                operations.edit(id, |status| status.steps[index].state = NativeJobStepState::Dispatching);
            }
            dispatched = true;
            // Do not drop an in-flight mutation because a page canceled its remaining steps.
            let receipt = session.execute(step).await;
            operations.edit(id, |status| {
                status.steps[index].vendor_code = receipt.vendor_code;
                status.steps[index].reason = receipt.reason.clone();
                status.steps[index].state = match receipt.outcome {
                    NativeJobDispatchOutcome::NotStarted => NativeJobStepState::Failed,
                    NativeJobDispatchOutcome::Applied => NativeJobStepState::Applied,
                    NativeJobDispatchOutcome::Unknown => NativeJobStepState::Unknown,
                };
            });
            if receipt.outcome == NativeJobDispatchOutcome::NotStarted {
                return Err(("native_job_step_not_applied", if index == 0 { NativeJobOperationOutcome::NotApplied } else { NativeJobOperationOutcome::Partial }));
            }
            if matches!(step.effect, NativeJobStepEffect::Accepted | NativeJobStepEffect::Completed) {
                if matches!(step.effect, NativeJobStepEffect::Accepted)
                    && matches!(mutation.change, NativeJobChange::Run | NativeJobChange::Stop { .. })
                {
                    let tracker = Arc::new(tokio::sync::Mutex::new(observation::Tracker {
                        binding: execution.binding.clone(), target: mutation.target.clone(),
                        stop: matches!(mutation.change, NativeJobChange::Stop { .. }),
                        baseline: NativeJobExecutionRead::from_details(&before),
                        running_keys: HashSet::new(),
                    }));
                    if let Some(record) = operations.0.lock().unwrap_or_else(|error| error.into_inner()).records.iter_mut()
                        .find(|record| record.status.operation_id == id && record.actor == current_credential_owner())
                    {
                        record.observation = Some(tracker.clone());
                    }
                    let mut tracker = tracker.lock().await;
                    let observed = if !state.connection_lifecycle_is_current(&scope.connection_id, &execution.binding.lifecycle) {
                        observation::unavailable("native_job_context_changed")
                    } else {
                        match session.read_execution(&mutation.target).await {
                            Ok(current) if state.connection_lifecycle_is_current(&scope.connection_id, &execution.binding.lifecycle) => tracker.record(current),
                            Ok(_) => observation::unavailable("native_job_context_changed"),
                            Err(reason) => observation::unavailable(reason),
                        }
                    };
                    operations.edit(id, |status| status.execution_observation = Some(observed));
                }
                if receipt.outcome == NativeJobDispatchOutcome::Unknown { return Err(("native_job_execution_outcome_unknown", NativeJobOperationOutcome::Unknown)); }
                outcome = if matches!(step.effect, NativeJobStepEffect::Completed) { NativeJobOperationOutcome::Verified } else { NativeJobOperationOutcome::Accepted };
                operations.edit(id, |status| status.steps[index].state = if outcome == NativeJobOperationOutcome::Accepted { NativeJobStepState::Accepted } else { NativeJobStepState::Applied });
                continue;
            }
            if !state.connection_lifecycle_is_current(&scope.connection_id, &execution.binding.lifecycle) {
                return Err(("native_job_context_changed", NativeJobOperationOutcome::Unknown));
            }
            let after = session.read(&mutation.target).await.map_err(|reason| (reason,
                if receipt.outcome == NativeJobDispatchOutcome::Unknown { NativeJobOperationOutcome::Unknown } else { NativeJobOperationOutcome::Partial }))?;
            if !verify_effect(&before, &after, &step.effect, &execution.binding.context.session_user, execution.binding.context.engine) {
                return Err(("native_job_readback_not_verified", if receipt.outcome == NativeJobDispatchOutcome::Unknown { NativeJobOperationOutcome::Unknown } else { NativeJobOperationOutcome::Partial }));
            }
            operations.edit(id, |status| status.steps[index].state = NativeJobStepState::Applied);
            if matches!(step.effect, NativeJobStepEffect::Deleted) {
                operations.configuration_verified(&execution.origin_key);
            }
            before = after;
        }
        Ok(outcome)
    }.await;
    let (outcome, reason) = match result {
        Ok(outcome) => (
            outcome,
            if outcome == NativeJobOperationOutcome::Accepted
                && matches!(&execution.action, PreparedAction::Mutation { plan, .. } if plan.steps.iter().any(|step| matches!(step.effect, NativeJobStepEffect::DamengLegacyInterval { expected_seconds: None })))
            {
                Some("native_job_legacy_interval_expression_not_readable")
            } else {
                None
            },
        ),
        Err((reason, outcome)) => (outcome, Some(reason)),
    };
    let (outcome, reason) = if session.finish().await.is_err() {
        (
            if dispatched { NativeJobOperationOutcome::Unknown } else { NativeJobOperationOutcome::NotApplied },
            Some("native_job_session_cleanup_unknown"),
        )
    } else {
        (outcome, reason)
    };
    finish_status(operations, id, outcome, reason);
    guard.armed = false;
    drop(published_run);
    drop(shared_run);
    drop(stop_guard);
    drop(created_job_guard);
    drop(job_guards);
}

fn row(details: &NativeJobDetails) -> Option<&NativeJobRow> {
    match &details.snapshot.definition {
        NativeJobMetadata::Available { value } => Some(value),
        _ => None,
    }
}

fn verify_effect(
    before: &NativeJobDetails,
    after: &NativeJobDetails,
    effect: &NativeJobStepEffect,
    session_user: &str,
    engine: NativeJobEngine,
) -> bool {
    verify_effect_with_extra(before, after, effect, session_user, engine, &[])
}

fn verify_effect_with_extra(
    before: &NativeJobDetails,
    after: &NativeJobDetails,
    effect: &NativeJobStepEffect,
    session_user: &str,
    engine: NativeJobEngine,
    extra: &[&str],
) -> bool {
    if matches!(effect, NativeJobStepEffect::Deleted) {
        let source = after.sources.get("definition");
        let own = matches!(&after.snapshot.job_ref, NativeJobRef::Scheduler { owner, .. } if owner == session_user)
            || row(before).is_some_and(|row| {
                row.get("LOG_USER").or_else(|| row.get("USERNAME")).and_then(Value::as_str) == Some(session_user)
            });
        return matches!(after.snapshot.definition, NativeJobMetadata::Empty)
            && matches!(after.native_identity, NativeJobMetadata::Empty)
            && (own || source.is_some_and(|source| source.coverage == Some(NativeJobCatalogCoverage::Database)));
    }
    if !matches!(after.consistency, NativeJobMetadata::Available { .. })
        || before.native_identity != after.native_identity
    {
        return false;
    }
    if !preserved_definition_with_extra(before, after, effect, extra, engine) {
        return false;
    }
    match effect {
        NativeJobStepEffect::Enabled(expected) => {
            let Some(row) = row(after) else {
                return false;
            };
            super::details::boolean(row.get("ENABLED").or_else(|| row.get("ENABLE"))) == Some(*expected)
                || row.get("BROKEN").and_then(Value::as_str) == Some(if *expected { "N" } else { "Y" })
        }
        NativeJobStepEffect::SchedulerDefinition(effect) => row(after).is_some_and(|row| {
            effect.columns.iter().all(|change| match &change.change {
                NativeJobFieldChange::Set { value } => {
                    values::field_matches(&change.name, row.get(&change.name), value)
                }
                NativeJobFieldChange::Clear => row.get(&change.name) == Some(&Value::Null),
                NativeJobFieldChange::Keep => true,
            }) && scheduler::transition::reference_projections_match(row, &effect.references)
        }),
        NativeJobStepEffect::Fields(changes) => row(after).is_some_and(|row| {
            changes.iter().all(|change| match &change.change {
                NativeJobFieldChange::Set { value } => {
                    values::field_matches(&change.name, row.get(&change.name), value)
                }
                NativeJobFieldChange::Clear => row.get(&change.name) == Some(&Value::Null),
                NativeJobFieldChange::Keep => true,
            })
        }),
        NativeJobStepEffect::Argument(change, expected) if engine == NativeJobEngine::Oracle => {
            match super::details::parse_argument_inventory(&after.parameter_metadata) {
                NativeJobMetadata::Available { value } => match &change.value {
                    NativeJobArgumentValue::Inherit | NativeJobArgumentValue::Unset => {
                        !value.contains_key(&change.position)
                    }
                    _ => value.get(&change.position).is_some_and(|row| match expected {
                        Some(expected) => expected.matches(&dbx_sql::native_job_arguments::decode_argument(row, false)),
                        None => dbx_sql::native_job_arguments::oracle_argument_matches(row, &change.value, "UNKNOWN"),
                    }),
                },
                _ => false,
            }
        }
        NativeJobStepEffect::Argument(change, _) => match &after.snapshot.arguments {
            NativeJobMetadata::Available { value } => {
                value.iter().any(|argument| argument.position == change.position && argument.value == change.value)
            }
            _ => false,
        },
        NativeJobStepEffect::HistoryCleared => {
            matches!(after.history, NativeJobMetadata::Empty)
                || matches!(&after.history, NativeJobMetadata::Available { value } if value.is_empty())
        }
        _ => false,
    }
}

fn preserved_definition(
    before: &NativeJobDetails,
    after: &NativeJobDetails,
    effect: &NativeJobStepEffect,
    engine: NativeJobEngine,
) -> bool {
    preserved_definition_with_extra(before, after, effect, &[], engine)
}

fn preserved_definition_with_extra(
    before: &NativeJobDetails,
    after: &NativeJobDetails,
    effect: &NativeJobStepEffect,
    extra: &[&str],
    engine: NativeJobEngine,
) -> bool {
    let target = &before.snapshot.job_ref;
    let (Some(before), Some(after)) = (row(before), row(after)) else {
        return false;
    };
    let changed = |key: &str| match effect {
        NativeJobStepEffect::Fields(changes) | NativeJobStepEffect::DamengDefinition(changes) => {
            changes.iter().any(|change| change.name == key)
        }
        NativeJobStepEffect::SchedulerDefinition(effect) => effect.columns.iter().any(|change| change.name == key),
        NativeJobStepEffect::Enabled(_) => matches!(key, "ENABLED" | "ENABLE" | "BROKEN"),
        _ => false,
    };
    let ignored = |key: &str| {
        extra.contains(&key)
            || super::details::generated_definition_column(engine, target, before, key)
            || changed(key)
            || matches!(
                key,
                "STATE"
                    | "RUN_COUNT"
                    | "FAILURE_COUNT"
                    | "RETRY_COUNT"
                    | "LAST_START_DATE"
                    | "LAST_RUN_DATE"
                    | "LAST_RUN_DURATION"
                    | "NEXT_RUN_DATE"
                    | "LAST_DATE"
                    | "LAST_SEC"
                    | "THIS_DATE"
                    | "THIS_SEC"
                    | "NEXT_DATE"
                    | "NEXT_SEC"
                    | "TOTAL_TIME"
                    | "FAILURES"
                    | "GMT_MODIFIED"
                    | "MODIFYTIME"
            )
    };
    before.iter().all(|(key, value)| ignored(key) || after.get(key) == Some(value))
        && after.keys().all(|key| ignored(key) || before.contains_key(key))
}

struct OwnedPoolSession {
    state: Arc<AppState>,
    binding: super::service::BoundContext,
    client_session_id: String,
    cleanup: Option<ClientSessionPoolCleanupGuard>,
    pool: Option<PoolKind>,
    operation_timeout: Option<Duration>,
    configuration_operation: Option<String>,
    physical_session: Option<NativeJobPhysicalSession>,
    legacy_operation: Option<String>,
    legacy_disposal: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhysicalSessionReceipt {
    operation_id: String,
    phase: String,
    #[serde(default)]
    session_token: Option<String>,
}

impl OwnedPoolSession {
    async fn open(&mut self) -> Result<(), &'static str> {
        if self.pool.is_some() {
            return Ok(());
        }
        let scope = &self.binding.context.scope;
        let database = (!scope.database.is_empty()).then_some(scope.database.as_str());
        self.cleanup = self
            .state
            .metadata_session_pool_cleanup_guard(&scope.connection_id, database, &self.client_session_id)
            .await;
        if self.cleanup.is_none() {
            return Err("native_job_isolated_session_required");
        }
        let key = self
            .state
            .get_or_create_metadata_pool_for_session(&scope.connection_id, database, Some(&self.client_session_id))
            .await
            .map_err(|_| "native_job_session_open_failed")?;
        let pool = self.state.pool_handle(&key).await.ok_or("native_job_session_open_failed")?;
        super::service::validate_runtime_context(&self.state, &self.binding, &pool).await?;
        self.pool = Some(pool);
        Ok(())
    }

    async fn legacy_call(&mut self, id: &str, method: &str, mut params: Value) -> NativeJobLegacyReceipt {
        let Some(pool) = &self.pool else {
            return legacy::receipt(id, NativeJobLegacyPhase::Unknown, "native_job_legacy_session_unavailable");
        };
        let result = match pool {
            PoolKind::Agent(client) => {
                let mut client = client.lock().await;
                client.call_typed_with_timeout(method, params, self.operation_timeout).await.map_err(|error| {
                    let mut failure =
                        legacy::receipt(id, NativeJobLegacyPhase::Unknown, "native_job_legacy_rpc_failed");
                    if let AgentCallError::Structured { context, .. } = error {
                        failure.vendor_code = context.vendor_code;
                    }
                    failure
                })
            }
            PoolKind::ExternalDriver { config, session, .. } => {
                params
                    .as_object_mut()
                    .expect("owned native parameters")
                    .insert("connection".into(), serde_json::json!(config.as_ref()));
                let method = match method {
                    "prepare_legacy_job" => "prepareLegacyJob",
                    "commit_legacy_job" => "commitLegacyJob",
                    "rollback_legacy_job" => "rollbackLegacyJob",
                    "legacy_job_status" => "legacyJobStatus",
                    _ => unreachable!(),
                };
                session
                    .invoke_with_timeout(method, params, self.operation_timeout)
                    .await
                    .map_err(|_| legacy::receipt(id, NativeJobLegacyPhase::Unknown, "native_job_legacy_rpc_failed"))
            }
            _ => Err(legacy::receipt(id, NativeJobLegacyPhase::NotStarted, "native_job_legacy_protocol_unavailable")),
        };
        let receipt = result.unwrap_or_else(|failure| failure);
        if self.binding.context.engine == NativeJobEngine::OceanbaseOracle && receipt.operation_id == id {
            if receipt.phase != NativeJobLegacyPhase::NotStarted || receipt.disposal_confirmed.is_some() {
                self.legacy_operation = Some(id.into());
            }
            if receipt.disposal_confirmed == Some(false) {
                self.legacy_disposal = Some(false);
            } else if self.legacy_disposal != Some(false)
                && receipt.disposal_confirmed == Some(true)
                && matches!(
                    receipt.phase,
                    NativeJobLegacyPhase::Committed
                        | NativeJobLegacyPhase::RolledBack
                        | NativeJobLegacyPhase::NotStarted
                        | NativeJobLegacyPhase::Unknown
                )
            {
                self.legacy_disposal = Some(true);
            }
        }
        receipt
    }

    async fn close_legacy(&mut self) -> Result<(), &'static str> {
        let Some(operation) = self.legacy_operation.clone() else { return Ok(()) };
        if self.legacy_disposal.is_none() {
            // Terminal acknowledgement loss allows a status read, never another native finish.
            let _ = tokio::time::timeout(
                Duration::from_secs(crate::connection::POOL_CLOSE_TIMEOUT_SECS),
                self.legacy_call(&operation, "legacy_job_status", serde_json::json!({"operationId":operation})),
            )
            .await;
        }
        if self.legacy_disposal == Some(true) {
            Ok(())
        } else {
            Err("native_job_legacy_dispose_unknown")
        }
    }

    async fn supports_protocol(&self, capability: &str) -> bool {
        match self.pool.as_ref().expect("opened pool") {
            PoolKind::Agent(client) => client
                .lock()
                .await
                .handshake()
                .is_some_and(|handshake| handshake.capabilities.iter().any(|value| value == capability)),
            PoolKind::ExternalDriver { config, session, .. } => session
                .invoke_with_timeout::<Value>(
                    "jdbcSessionProtocol",
                    serde_json::json!({"connection":config.as_ref()}),
                    self.operation_timeout,
                )
                .await
                .ok()
                .is_some_and(|protocol| {
                    protocol["capabilities"]
                        .as_array()
                        .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(capability)))
                }),
            _ => false,
        }
    }

    async fn physical_session_call(
        &self,
        open: bool,
        mut params: Value,
    ) -> Result<PhysicalSessionReceipt, &'static str> {
        let timeout = if open {
            self.operation_timeout
        } else {
            Some(Duration::from_secs(crate::connection::POOL_CLOSE_TIMEOUT_SECS))
        };
        let raw: Value = match self.pool.as_ref() {
            Some(PoolKind::Agent(client)) => {
                let mut client = tokio::time::timeout(crate::connection::METADATA_POOL_ACQUIRE_TIMEOUT, client.lock())
                    .await
                    .map_err(|_| "native_job_configuration_session_unavailable")?;
                client
                    .call_typed_with_timeout(
                        if open { "open_native_job_session" } else { "close_native_job_session" },
                        params,
                        timeout,
                    )
                    .await
                    .map_err(|_| "native_job_configuration_session_rpc_failed")?
            }
            Some(PoolKind::ExternalDriver { config, session, .. }) => {
                params["connection"] = serde_json::json!(config.as_ref());
                session
                    .invoke_with_timeout(
                        if open { "openNativeJobSession" } else { "closeNativeJobSession" },
                        params,
                        timeout,
                    )
                    .await
                    .map_err(|_| "native_job_configuration_session_rpc_failed")?
            }
            _ => return Err("native_job_configuration_session_unavailable"),
        };
        serde_json::from_value(raw).map_err(|_| "native_job_configuration_session_receipt_invalid")
    }

    async fn close_configuration(&self) -> Result<(), &'static str> {
        let Some(operation_id) = &self.configuration_operation else { return Ok(()) };
        let mut params = serde_json::json!({"operationId":operation_id});
        if let Some(physical) = &self.physical_session {
            params["sessionToken"] = Value::String(physical.token.clone());
        }
        // No reopening or replacement connection: only the original physical owner can confirm
        // disposal, including an open whose receipt was lost before its token reached Core.
        let receipt = self.physical_session_call(false, params).await?;
        if receipt.operation_id != *operation_id
            || receipt.phase != "closed"
            || self
                .physical_session
                .as_ref()
                .is_some_and(|physical| receipt.session_token.as_ref() != Some(&physical.token))
        {
            return Err("native_job_configuration_session_dispose_unknown");
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl NativeJobMutationSession for OwnedPoolSession {
    async fn read_execution(&mut self, target: &NativeJobRef) -> Result<NativeJobExecutionRead, &'static str> {
        observation::read_core(&self.state, &self.binding, target).await
    }
    async fn read_reference(
        &mut self,
        request: NativeJobReferenceListRequest,
    ) -> Result<NativeJobReferenceCatalog, &'static str> {
        super::native_job_references_core(&self.state, &request).await.map_err(|_| "native_job_reference_read_failed")
    }
    async fn read(&mut self, target: &NativeJobRef) -> Result<NativeJobDetails, &'static str> {
        self.open().await?;
        if let Some(physical) = &self.physical_session {
            let timeout = super::super::agent_metadata_timeout(
                self.state.configs.read().await.get(&self.binding.context.scope.connection_id),
            );
            return super::native_job_read_with(&self.state, target, |query| {
                execute_catalog_query_in_session(
                    self.binding.context.engine,
                    self.pool.as_ref().expect("opened pool"),
                    &self.binding.context.scope.database,
                    query,
                    timeout,
                    Some(physical),
                )
            })
            .await;
        }
        // A separate read scope proves visibility after commit; do not verify using an operation's
        // potentially uncommitted connection after an unknown response.
        super::native_job_read_core(&self.state, target).await.map_err(|_| "native_job_readback_failed")
    }
    async fn execute(&mut self, step: &NativeJobSqlStep) -> NativeJobStepReceipt {
        if let Err(reason) = require_write(&self.state, &self.binding).await {
            return NativeJobStepReceipt {
                outcome: NativeJobDispatchOutcome::NotStarted,
                reason: Some(reason.into()),
                vendor_code: None,
            };
        }
        let config = self.state.configs.read().await.get(&self.binding.context.scope.connection_id).cloned();
        let timeout = config.as_ref().and_then(|config| match config.effective_query_timeout_secs() {
            0 => None,
            secs => Some(Duration::from_secs(secs)),
        });
        let query = NativeJobCatalogQuery {
            source: "native-job-operation",
            coverage: NativeJobCatalogCoverage::CurrentUser,
            sql: step.sql.clone(),
            limit: 1,
        };
        let raw = execute_catalog_query_in_session(
            self.binding.context.engine,
            self.pool.as_ref().expect("opened pool"),
            &self.binding.context.scope.database,
            query,
            timeout,
            self.physical_session.as_ref(),
        )
        .await;
        let result = raw.and_then(|raw| decode_query_result(self.binding.context.engine, raw));
        match result {
            Ok(_) => {
                NativeJobStepReceipt { outcome: NativeJobDispatchOutcome::Applied, reason: None, vendor_code: None }
            }
            Err(error) => {
                let vendor_code = match error {
                    NativeJobCatalogFailure::Denied(code)
                    | NativeJobCatalogFailure::Unavailable(code)
                    | NativeJobCatalogFailure::Unsupported(code)
                    | NativeJobCatalogFailure::Query(code) => code,
                    _ => None,
                };
                NativeJobStepReceipt {
                    outcome: NativeJobDispatchOutcome::Unknown,
                    reason: Some("native_job_native_call_failed".into()),
                    vendor_code,
                }
            }
        }
    }
    async fn begin_configure(&mut self, operation_id: &str) -> Result<(), &'static str> {
        self.open().await?;
        require_write(&self.state, &self.binding).await?;
        let seconds = self
            .state
            .configs
            .read()
            .await
            .get(&self.binding.context.scope.connection_id)
            .map(|config| config.effective_query_timeout_secs())
            .ok_or("native_job_connection_missing")?;
        self.operation_timeout = (seconds != 0).then(|| Duration::from_secs(seconds));
        if !self.supports_protocol("native_job_session_v1").await {
            return Err("native_job_configuration_protocol_unavailable");
        }
        self.configuration_operation = Some(operation_id.into());
        let receipt = self.physical_session_call(true, serde_json::json!({"operationId":operation_id})).await?;
        if receipt.operation_id != operation_id || receipt.phase != "opened" {
            return Err("native_job_configuration_session_open_unverified");
        }
        let token = receipt
            .session_token
            .filter(|token| !token.is_empty() && token.len() <= 512 && !token.contains('\0'))
            .ok_or("native_job_configuration_session_receipt_invalid")?;
        self.physical_session = Some(NativeJobPhysicalSession { operation_id: operation_id.into(), token });
        super::service::validate_runtime_context_in_session(
            &self.state,
            &self.binding,
            self.pool.as_ref().expect("opened pool"),
            self.physical_session.as_ref(),
        )
        .await
    }
    async fn query(&mut self, query: NativeJobCatalogQuery) -> Result<Value, NativeJobCatalogFailure> {
        let Some(physical) = &self.physical_session else { return Err(NativeJobCatalogFailure::RouteUnavailable) };
        let timeout = super::super::agent_metadata_timeout(
            self.state.configs.read().await.get(&self.binding.context.scope.connection_id),
        );
        execute_catalog_query_in_session(
            self.binding.context.engine,
            self.pool.as_ref().expect("opened pool"),
            &self.binding.context.scope.database,
            query,
            timeout,
            Some(physical),
        )
        .await
    }
    async fn prepare_legacy(
        &mut self,
        operation_id: &str,
        definition: &NativeJobLegacyCreate,
    ) -> NativeJobLegacyReceipt {
        if let Err(reason) = self.open().await {
            return legacy::receipt(operation_id, NativeJobLegacyPhase::NotStarted, reason);
        }
        if let Err(reason) = require_write(&self.state, &self.binding).await {
            return legacy::receipt(operation_id, NativeJobLegacyPhase::NotStarted, reason);
        }
        let seconds = self
            .state
            .configs
            .read()
            .await
            .get(&self.binding.context.scope.connection_id)
            .map(|config| config.effective_query_timeout_secs());
        let Some(seconds) = seconds.filter(|seconds| *seconds <= i32::MAX as u64) else {
            return legacy::receipt(operation_id, NativeJobLegacyPhase::NotStarted, "native_job_timeout_invalid");
        };
        self.operation_timeout = (seconds != 0).then(|| Duration::from_secs(seconds));
        let oceanbase = self.binding.context.engine == NativeJobEngine::OceanbaseOracle;
        let available =
            self.supports_protocol(if oceanbase { "native_job_legacy_ob_v1" } else { "native_job_legacy_v1" }).await;
        if !available {
            return legacy::receipt(
                operation_id,
                NativeJobLegacyPhase::NotStarted,
                if oceanbase {
                    "native_job_legacy_runtime_update_required"
                } else {
                    "native_job_legacy_protocol_unavailable"
                },
            );
        }
        let mut params = serde_json::json!({
            "operationId":operation_id, "what":definition.what, "nextDate":definition.next_date,
            "interval":definition.interval, "enabled":definition.enabled, "instance":definition.instance,
            "schema":definition.schema, "timeoutSecs":seconds,
        });
        if oceanbase {
            params["dialect"] = Value::String("oceanbase-oracle".into());
            params["zone"] = serde_json::json!(definition.zone);
        }
        self.legacy_call(operation_id, "prepare_legacy_job", params).await
    }
    async fn finish_legacy(
        &mut self,
        operation_id: &str,
        job_id: Option<&str>,
        commit: bool,
    ) -> NativeJobLegacyReceipt {
        let mut params = serde_json::json!({"operationId":operation_id});
        if let Some(job_id) = job_id {
            params["jobId"] = Value::String(job_id.into());
        }
        // Deliberately do not reopen a lost session or reevaluate connection configuration here.
        self.legacy_call(operation_id, if commit { "commit_legacy_job" } else { "rollback_legacy_job" }, params).await
    }
    async fn finish(&mut self) -> Result<(), &'static str> {
        let legacy = self.close_legacy().await;
        let native = self.close_configuration().await;
        let physical = tokio::time::timeout(Duration::from_secs(crate::connection::POOL_CLOSE_TIMEOUT_SECS), async {
            match self.pool.as_ref() {
                Some(PoolKind::Agent(client)) => {
                    client.lock().await.disconnect().await.map(|_| ()).map_err(|_| "native_job_session_cleanup_unknown")
                }
                Some(PoolKind::ExternalDriver { session, .. }) => {
                    session.shutdown_confirmed().await.map_err(|_| "native_job_session_cleanup_unknown")
                }
                _ => Ok(()),
            }
        })
        .await
        .map_err(|_| "native_job_session_cleanup_unknown")
        .and_then(|result| result);
        let scope = &self.binding.context.scope;
        let closed = self
            .state
            .close_metadata_session_pool(
                &scope.connection_id,
                (!scope.database.is_empty()).then_some(scope.database.as_str()),
                &self.client_session_id,
            )
            .await;
        if matches!(closed, Ok(true)) {
            if let Some(cleanup) = &mut self.cleanup {
                cleanup.disarm();
            }
        }
        self.pool = None;
        legacy.and(native).and(physical).and(closed.map(|_| ()).map_err(|_| "native_job_session_cleanup_unknown"))
    }
}

pub fn native_job_apply_core(state: Arc<AppState>, plan_id: &str) -> Result<NativeJobOperationStatus, String> {
    let operations = state.native_jobs.operations().clone();
    let (status, claimed) = operations.claim(plan_id).map_err(str::to_string)?;
    if let Some((execution, cancel)) = claimed {
        let actor = current_credential_owner();
        let id = status.operation_id.clone();
        tokio::spawn(async move {
            with_credential_owner(actor, async {
                let mut session = OwnedPoolSession {
                    state: state.clone(),
                    binding: execution.binding.clone(),
                    client_session_id: crate::connection::task_client_session_id("native-job-operation", &id),
                    cleanup: None,
                    pool: None,
                    operation_timeout: None,
                    configuration_operation: None,
                    physical_session: None,
                    legacy_operation: None,
                    legacy_disposal: None,
                };
                run_claimed(&state, &operations, &id, execution, cancel, &mut session).await;
            })
            .await;
        });
    }
    Ok(status)
}
