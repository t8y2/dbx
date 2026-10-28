use super::*;
use crate::connection::PreparedConnectionRuntime;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use dbx_drivers::agent_runtime::{prepare_pl_debug_channel_before_observed, StartupCleanup, StartupCleanupGuard};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

const EXPIRED: &str = "The debug inspection expired or its connection changed; inspect the target again";

pub struct PlDebugInspectionAdmission {
    pub(super) request: PlDebugInspect,
    pub(super) config: ConnectionConfig,
    pub(super) lifecycle: ConnectionLifecycleSnapshot,
}

pub struct PlDebugInspectionSubmission {
    owner: Arc<InspectionOwner>,
    receiver: Option<oneshot::Receiver<Result<Value, String>>>,
    finished: bool,
}

impl PlDebugInspectionSubmission {
    pub(super) fn detach(mut self) {
        self.finished = true;
    }
    pub async fn wait(mut self) -> Result<Value, String> {
        let result = tokio::time::timeout_at(self.owner.deadline.into(), self.receiver.take().unwrap()).await;
        self.finished = true;
        match result {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.owner.invalidate();
                Err("The original debug inspection stopped without a result".into())
            }
            Err(_) => {
                self.owner.invalidate();
                Err(EXPIRED.into())
            }
        }
    }
}

impl Drop for PlDebugInspectionSubmission {
    fn drop(&mut self) {
        if !self.finished {
            self.owner.invalidate();
        }
    }
}

pub(crate) struct InspectionOwner {
    pub(crate) request: PlDebugInspect,
    pub(crate) config: ConnectionConfig,
    pub(crate) lifecycle: ConnectionLifecycleSnapshot,
    pub(crate) deadline: Instant,
    scope: Uuid,
    agent_id: String,
    owner: AccessOwner,
    credential_owner: Option<String>,
    driver_key: String,
    profile_ids: Vec<String>,
    app: Weak<AppState>,
    state: Mutex<InspectionState>,
    changed: Notify,
    cancel: CancellationToken,
    compilation: Option<Arc<super::compilation::Compilation>>,
}

#[derive(Default)]
struct InspectionState {
    invalidated: bool,
    admission_closed: bool,
    preparing: bool,
    stamp: Option<ConnectionTransportStamp>,
    startup: Option<StartupCleanup>,
    channel: Option<PlDebugAgentChannel>,
    open_dispatched: bool,
    close_confirmed: bool,
    exited: bool,
    retired: bool,
}

impl InspectionState {
    fn resources_quiescent(&self) -> bool {
        self.admission_closed
            && !self.preparing
            && self.startup.as_ref().is_none_or(|startup| startup.snapshot().is_settled())
            && self
                .channel
                .as_ref()
                .is_none_or(|_| (!self.open_dispatched || self.close_confirmed) && self.exited && self.retired)
    }
}

impl InspectionOwner {
    pub(super) fn blocks_debug_start(&self, connection_id: &str) -> bool {
        self.request.connection_id == connection_id
            && self.request.target.as_ref().and_then(|target| target.metadata_preparation.as_deref())
                == Some("debug_compile")
            && !self.resources_quiescent()
    }

    fn lock(&self) -> MutexGuard<'_, InspectionState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn notify(&self) {
        self.changed.notify_waiters();
        if let Some(app) = self.app.upgrade() {
            app.pl_debug.changed.notify_waiters();
        }
    }

    fn check_locked(
        &self,
        app: &AppState,
        registry: &RegistryState,
        data: &InspectionState,
        publication: bool,
    ) -> Result<(), String> {
        if !registry.accepting
            || data.invalidated
            || (!publication && data.admission_closed)
            || Instant::now() >= self.deadline
            || !app.connection_lifecycle_is_current(&self.request.connection_id, &self.lifecycle)
            || registry.connection_drains.contains_key(&self.request.connection_id)
            || registry.connection_fences.contains_key(&self.request.connection_id)
            || registry.mutation_permits.values().any(|intent| {
                intent.scope.includes_inspection(self) || intent.connections.contains(&self.request.connection_id)
            })
            || !registry.inspections.get(&self.scope).is_some_and(|original| std::ptr::eq(original.as_ref(), self))
        {
            return Err(EXPIRED.into());
        }
        if let Some(stamp) = &data.stamp {
            if !registry
                .transports
                .get(&self.request.connection_id)
                .is_some_and(|current| current.confirms_runtime(stamp))
            {
                return Err(EXPIRED.into());
            }
        }
        Ok(())
    }

    pub(crate) fn check(&self, app: &AppState) -> Result<(), String> {
        let registry = app.pl_debug.lock();
        self.check_locked(app, &registry, &self.lock(), false)
    }

    pub(crate) fn begin_preparation(&self, app: &AppState) -> Result<(), String> {
        let registry = app.pl_debug.lock();
        let mut data = self.lock();
        self.check_locked(app, &registry, &data, false)?;
        data.preparing = true;
        Ok(())
    }

    pub(crate) fn preparation_finished(&self, stamp: Option<ConnectionTransportStamp>, succeeded: bool) {
        let mut data = self.lock();
        data.preparing = false;
        data.stamp = stamp;
        if !succeeded || data.invalidated || Instant::now() >= self.deadline {
            data.admission_closed = true;
        }
        drop(data);
        self.notify();
    }

    fn begin_launch(&self, app: &AppState) -> Result<StartupCleanupGuard, String> {
        let (guard, cleanup) = StartupCleanup::new_pair();
        let registry = app.pl_debug.lock();
        let mut data = self.lock();
        self.check_locked(app, &registry, &data, false)?;
        data.startup = Some(cleanup);
        Ok(guard)
    }

    fn remaining(&self) -> Result<Duration, String> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| EXPIRED.to_owned())
    }

    fn begin_open(&self, app: &AppState) -> Result<Duration, String> {
        let registry = app.pl_debug.lock();
        let mut data = self.lock();
        self.check_locked(app, &registry, &data, false)?;
        let remaining = self.remaining()?;
        data.open_dispatched = true;
        Ok(remaining)
    }

    pub(super) fn invalidate(&self) {
        let mut data = self.lock();
        data.invalidated = true;
        data.admission_closed = true;
        drop(data);
        self.cancel.cancel();
        self.notify();
    }

    pub(super) fn isolate(&self) {
        self.invalidate();
        if let Some(channel) = &self.lock().channel {
            channel.fail_stop();
        }
    }

    pub(super) fn resources_quiescent(&self) -> bool {
        self.lock().resources_quiescent()
    }

    pub(super) fn belongs_to(&self, owner: &AccessOwner) -> bool {
        &self.owner == owner
    }

    pub(super) fn active_transport(&self) -> Option<ConnectionTransportStamp> {
        let data = self.lock();
        (!data.resources_quiescent()).then(|| data.stamp.clone()).flatten()
    }

    fn retire_if_quiescent(&self, app: &AppState) {
        let mut registry = app.pl_debug.lock();
        if self.resources_quiescent()
            && registry.inspections.get(&self.scope).is_some_and(|original| std::ptr::eq(original.as_ref(), self))
        {
            if let Some(compilation) = &self.compilation {
                compilation.released();
            }
            registry.inspections.remove(&self.scope);
        }
    }
}

struct InspectionTaskGuard(Arc<InspectionOwner>);

impl Drop for InspectionTaskGuard {
    fn drop(&mut self) {
        if let Some(compilation) = &self.0.compilation {
            compilation.abandoned();
        }
        let mut data = self.0.lock();
        data.admission_closed = true;
        if !data.exited {
            if let Some(channel) = &data.channel {
                channel.fail_stop();
            }
        }
        drop(data);
        self.0.notify();
        if let Some(app) = self.0.app.upgrade() {
            self.0.retire_if_quiescent(&app);
        }
    }
}

impl PlDebugMutationScope {
    pub(super) fn includes_inspection(&self, inspection: &InspectionOwner) -> bool {
        match self {
            Self::Connections(ids) => ids.contains(&inspection.request.connection_id),
            Self::WriteProtection { connection_id, credential_owner } => {
                connection_id == &inspection.request.connection_id && credential_owner == &inspection.credential_owner
            }
            Self::TunnelProfiles(ids) => inspection.profile_ids.iter().any(|source| ids.contains(source)),
            Self::Driver(key) => key == &inspection.driver_key,
            Self::AllRuntimes => true,
        }
    }
}

pub async fn pl_debug_prepare_inspection_core(
    state: &AppState,
    request: &PlDebugInspect,
) -> Result<Option<PlDebugInspectionAdmission>, String> {
    let preparation = request.target.as_ref().and_then(|target| target.metadata_preparation.as_deref());
    if !matches!(preparation, Some("type_only" | "debug_compile")) {
        return Ok(None);
    }
    validate_identity(&request.client_session_id)?;
    let lifecycle = state.connection_lifecycle_snapshot(&request.connection_id);
    let config = state.configs.read().await.get(&request.connection_id).cloned().ok_or("Connection not found")?;
    if config.db_type != DatabaseType::Oracle
        && !(preparation == Some("debug_compile") && config.db_type == DatabaseType::OceanbaseOracle)
    {
        return Ok(None);
    }
    if !state.connection_lifecycle_is_current(&request.connection_id, &lifecycle) {
        return Err(EXPIRED.into());
    }
    Ok(Some(PlDebugInspectionAdmission { request: request.clone(), config, lifecycle }))
}

pub fn pl_debug_submit_inspection_core(
    app: &Arc<AppState>,
    access: &PlDebugAccess,
    admission: PlDebugInspectionAdmission,
) -> Result<PlDebugInspectionSubmission, String> {
    submit_inspection_before(app, access, admission, Instant::now() + QUICK_TIMEOUT + QUICK_TIMEOUT)
}

pub(super) fn submit_inspection_before(
    app: &Arc<AppState>,
    access: &PlDebugAccess,
    admission: PlDebugInspectionAdmission,
    deadline: Instant,
) -> Result<PlDebugInspectionSubmission, String> {
    submit_metadata_before(app, access, admission, deadline, None)
}

pub(super) fn submit_compilation(
    app: &Arc<AppState>,
    access: &PlDebugAccess,
    admission: PlDebugInspectionAdmission,
    compilation: Arc<super::compilation::Compilation>,
) -> Result<PlDebugInspectionSubmission, String> {
    submit_metadata_before(app, access, admission, Instant::now() + QUICK_TIMEOUT + QUICK_TIMEOUT, Some(compilation))
}

fn submit_metadata_before(
    app: &Arc<AppState>,
    access: &PlDebugAccess,
    admission: PlDebugInspectionAdmission,
    deadline: Instant,
    compilation: Option<Arc<super::compilation::Compilation>>,
) -> Result<PlDebugInspectionSubmission, String> {
    let driver_key = dbx_drivers::agent_runtime::db_type_to_agent_key(
        &admission.config.db_type,
        admission.config.driver_profile.as_deref(),
    )
    .ok_or("The original debug driver is not available")?
    .to_owned();
    let mut profile_ids = admission
        .config
        .effective_transport_layers()
        .iter()
        .map(|layer| layer.profile_id().to_owned())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    profile_ids.sort();
    profile_ids.dedup();
    let scope = Uuid::new_v4();
    let owner = Arc::new(InspectionOwner {
        request: admission.request,
        config: admission.config,
        lifecycle: admission.lifecycle,
        deadline,
        scope,
        agent_id: Uuid::new_v4().simple().to_string(),
        owner: access.owner.clone(),
        credential_owner: access.credential_owner.clone(),
        driver_key,
        profile_ids,
        app: Arc::downgrade(app),
        state: Mutex::new(InspectionState::default()),
        changed: Notify::new(),
        cancel: CancellationToken::new(),
        compilation,
    });
    {
        let mut registry = app.pl_debug.lock();
        if !registry.accepting
            || Instant::now() >= deadline
            || registry.inspections.len() >= MAX_SESSIONS
            || !app.connection_lifecycle_is_current(&owner.request.connection_id, &owner.lifecycle)
            || registry.connection_drains.contains_key(&owner.request.connection_id)
            || registry.connection_fences.contains_key(&owner.request.connection_id)
            || registry.mutation_permits.values().any(|intent| {
                intent.scope.includes_inspection(&owner) || intent.connections.contains(&owner.request.connection_id)
            })
            || registry.compilations.values().any(|compilation| {
                compilation.protects_connection(&owner.request.connection_id)
                    && !owner.compilation.as_ref().is_some_and(|own| Arc::ptr_eq(own, compilation))
            })
            || (owner.request.target.as_ref().and_then(|target| target.metadata_preparation.as_deref())
                == Some("debug_compile")
                && registry.sessions.values().any(|entry| {
                    entry.start.connection_id == owner.request.connection_id && entry.lock().protects_execution()
                }))
        {
            return Err(EXPIRED.into());
        }
        registry.inspections.insert(scope, owner.clone());
    }
    let (sender, receiver) = oneshot::channel();
    let task_guard = InspectionTaskGuard(owner.clone());
    let weak = Arc::downgrade(app);
    let accepted = app.pl_debug_supervisor().spawn_once(format!("pl-debug-inspect:{scope}"), move |_| async move {
        let guard = task_guard;
        let owner = &guard.0;
        let Some(app) = weak.upgrade() else { return };
        let result = with_credential_owner(owner.credential_owner.clone(), run_inspection(&app, owner)).await;
        {
            let mut registry = app.pl_debug.lock();
            let mut data = owner.lock();
            data.admission_closed = true;
            let result = if let Some(compilation) = &owner.compilation {
                compilation.finish(result.as_ref().err().cloned());
                result
            } else {
                result.and_then(|mut result| {
                    owner.check_locked(&app, &registry, &data, true)?;
                    if !data.resources_quiescent() {
                        return Err("The original inspection resources have not confirmed release".into());
                    }
                    result.as_object_mut().ok_or("Invalid debug inspection response")?.insert(
                        "connectionRevision".into(),
                        json!(connection_revision(app.pl_debug.epoch, &owner.lifecycle)),
                    );
                    Ok(result)
                })
            };
            if data.resources_quiescent() {
                if let Some(compilation) = &owner.compilation {
                    compilation.released();
                }
                registry.inspections.remove(&owner.scope);
            }
            let _ = sender.send(result);
        }
        owner.notify();
        let startup = owner.lock().startup.clone();
        if let Some(startup) = startup {
            startup.wait_until_settled().await;
        }
        observe_channel_exit(&app, owner).await;
        owner.retire_if_quiescent(&app);
    });
    if !accepted {
        owner.invalidate();
        owner.retire_if_quiescent(app);
        return Err("The application is shutting down".into());
    }
    Ok(PlDebugInspectionSubmission { owner, receiver: Some(receiver), finished: false })
}

pub async fn pl_debug_inspect_dispatch_core(
    app: &Arc<AppState>,
    access: &PlDebugAccess,
    request: PlDebugInspect,
) -> Result<Value, String> {
    match pl_debug_prepare_inspection_core(app, &request).await? {
        Some(admission) => pl_debug_submit_inspection_core(app, access, admission)?.wait().await,
        None => pl_debug_inspect_core(app, access, request).await,
    }
}

async fn run_inspection(app: &AppState, owner: &InspectionOwner) -> Result<Value, String> {
    let prepared = app.prepare_pl_debug_inspection_connection(owner).await?;
    owner.check(app)?;
    let startup = owner.begin_launch(app)?;
    let channel = prepare_pl_debug_channel_before_observed(
        &app.agent_manager,
        &prepared.config.db_type,
        prepared.config.driver_profile.as_deref(),
        &prepared.config.agent_java_options,
        prepared.transport_stamp.agent_launch_env(),
        owner.agent_id.clone(),
        owner.scope,
        owner.deadline,
        startup,
    )
    .await?;
    owner.lock().channel = Some(channel.clone());
    let result = inspect_on_channel(app, owner, &channel, &prepared).await;
    owner.lock().admission_closed = true;
    let cleanup = cleanup_channel(app, owner, &channel).await;
    if let Some(compilation) = &owner.compilation {
        if let Err(error) = cleanup {
            compilation.cleanup_error(error);
        }
        return result;
    }
    match (result, cleanup) {
        (Err(error), Err(cleanup)) => Err(format!("{error}; original inspection cleanup: {cleanup}")),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(result), Ok(())) => {
            let startup = owner.lock().startup.clone();
            if let Some(startup) = startup {
                tokio::time::timeout_at(owner.deadline.into(), startup.wait_until_settled())
                    .await
                    .map_err(|_| "The original inspection startup cleanup has not confirmed release".to_owned())?;
            }
            Ok(result)
        }
    }
}

async fn inspect_on_channel(
    app: &AppState,
    owner: &InspectionOwner,
    channel: &PlDebugAgentChannel,
    prepared: &PreparedConnectionRuntime,
) -> Result<Value, String> {
    owner.check(app)?;
    if !channel.supports_native_pl_debug() {
        return Err("This Agent does not advertise the native no-helper PL debug contract; update the Agent".into());
    }
    let params = agent_connect_params_with_role(
        &prepared.config,
        &prepared.endpoint.host,
        prepared.endpoint.port,
        prepared.config.effective_database().unwrap_or(""),
        AgentSessionRole::Metadata,
    )?;
    let timeout = owner.begin_open(app)?.min(agent_connect_timeout(&prepared.config));
    if let Err(error) = channel.open_session(params, timeout).await {
        if error.operation_outcome() == AgentOperationOutcome::NotStarted {
            owner.lock().open_dispatched = false;
        }
        return Err(error.into_legacy_string());
    }
    owner.check(app)?;
    if let Some(compilation) = &owner.compilation {
        compilation.check_write(app).await?;
        owner.check(app)?;
        let remaining = owner.remaining()?;
        compilation.dispatching()?;
        let result = channel
            .call::<Value>(
                "pl_debug_compile",
                json!({"operationId":compilation.request.operation_id,
            "target":compilation.request.target,"preview":compilation.request.preview}),
                remaining,
                Some(owner.cancel.clone()),
            )
            .await;
        match result {
            Ok(value) => {
                compilation.agent_result(value.clone())?;
                return Ok(value);
            }
            Err(error) => {
                compilation.call_error(&error);
                if error.operation_outcome() != AgentOperationOutcome::NotStarted {
                    if let Ok(remaining) = owner.remaining() {
                        if let Ok(value) = channel
                            .call::<Value>(
                                "pl_debug_compile_status",
                                json!({"operationId":compilation.request.operation_id}),
                                remaining,
                                None,
                            )
                            .await
                        {
                            if compilation.agent_result(value.clone()).is_ok() {
                                return Ok(value);
                            }
                        }
                    }
                }
                return Err(error.into_legacy_string());
            }
        }
    }
    channel
        .call(
            "pl_debug_inspect",
            json!({"target":owner.request.target}),
            owner.remaining()?,
            Some(owner.cancel.clone()),
        )
        .await
        .map_err(AgentCallError::into_legacy_string)
}

async fn cleanup_channel(app: &AppState, owner: &InspectionOwner, channel: &PlDebugAgentChannel) -> Result<(), String> {
    let mut failure = None;
    if owner.lock().open_dispatched {
        match owner.remaining() {
            Ok(remaining) => match channel.close_session(remaining).await {
                Ok(result) if result["ok"] == true => owner.lock().close_confirmed = true,
                Ok(_) => failure = Some("The original inspection did not confirm physical session closure".to_owned()),
                Err(error) => failure = Some(error.into_legacy_string()),
            },
            Err(error) => failure = Some(error),
        }
    }
    let shutdown_error = if let Ok(remaining) = owner.remaining() {
        channel.request_shutdown(remaining).await.err().map(AgentCallError::into_legacy_string)
    } else {
        None
    };
    let exited = match owner.remaining() {
        Ok(remaining) => channel.wait_for_exit(remaining).await,
        Err(_) => false,
    };
    if !exited {
        channel.fail_stop();
        failure.get_or_insert_with(|| {
            shutdown_error.unwrap_or_else(|| {
                "The original inspection did not confirm normal process exit before its deadline".into()
            })
        });
    } else {
        owner.lock().exited = true;
        let retired = channel.retire_after_exit(&app.agent_manager).await;
        owner.lock().retired = retired;
        if !retired {
            failure.get_or_insert_with(|| {
                "The original inspection runtime reservation has not confirmed retirement".into()
            });
        }
    }
    owner.notify();
    if let Some(failure) = failure {
        Err(failure)
    } else {
        Ok(())
    }
}

async fn observe_channel_exit(app: &AppState, owner: &InspectionOwner) {
    let channel = {
        let data = owner.lock();
        if data.exited && data.retired {
            return;
        }
        data.channel.clone()
    };
    if let Some(channel) = channel {
        if channel.wait_for_exit(Duration::ZERO).await {
            let retired = channel.retire_after_exit(&app.agent_manager).await;
            let mut data = owner.lock();
            let changed = !data.exited || data.retired != retired;
            data.exited = true;
            data.retired = retired;
            drop(data);
            if changed {
                owner.notify();
            }
        }
    }
}

pub(super) async fn wait_for_inspections(owners: &[Arc<InspectionOwner>], deadline: Instant) -> Result<(), String> {
    for owner in owners {
        let mut startup_settled_observed = false;
        loop {
            let notified = owner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(app) = owner.app.upgrade() {
                if tokio::time::timeout_at(deadline.into(), observe_channel_exit(&app, owner)).await.is_err() {
                    owner.isolate();
                    return Err("The original inspection runtime retirement has not completed".into());
                }
            }
            if owner.resources_quiescent() {
                if let Some(app) = owner.app.upgrade() {
                    owner.retire_if_quiescent(&app);
                }
                break;
            }
            let startup = owner.lock().startup.clone();
            let changed = async {
                if let Some(startup) = startup.filter(|_| !startup_settled_observed) {
                    tokio::select! {
                        _ = notified => {},
                        _ = startup.wait_until_settled() => { startup_settled_observed = true; }
                    }
                } else {
                    notified.await;
                }
            };
            if tokio::time::timeout_at(deadline.into(), changed).await.is_err() {
                owner.isolate();
                return Err(
                    "The original inspection has not confirmed resource release; its cleanup identity is retained"
                        .into(),
                );
            }
        }
    }
    Ok(())
}
