//! Scheduler engine (ADR §3.4 / §4): the polling worker that turns the store
//! into a running scheduler.
//!
//! Loop shape (frozen): `startup → recover → acquire lease → loop { heartbeat
//! → enqueue_due → claim → dispatch → reap → reconcile residents } → shutdown
//! { drain in-flight runs, stop resident sessions, release lease }`.
//!
//! The dispatch invariant (ADR §3.3) is honored everywhere: a run is marked
//! `running` *before* the executor is invoked, so a `starting` run in the
//! store always means "the executor never started" and recovery can requeue
//! it safely.
//!
//! Poll interval, lease TTL and the resident heartbeat timeout are injected —
//! never hard-coded — so tests and embedders can drive the engine at any
//! speed.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tokio_util::sync::CancellationToken;

use super::artifacts::TaskArtifact;
use super::executor::{TaskExecutionContext, TaskExecutionResult, TaskExecutorRegistry, TaskProgressReporter};
use super::lease::LeaseGuard;
use super::logs::TaskLogger;
use super::models::{TaskExecutionMode, TaskRestartPolicy, TaskRunStatus, TaskRunTrigger};
use super::policy;
use super::queue::RunQueue;
use super::resident::{ResidentSession, ResidentState};
use super::store::{RunJob, SchedulerStore, SCHEDULER_LEASE};
use super::trigger::TaskTrigger;
use super::TaskError;

/// How long an executor may keep unwinding after its cancellation token fired
/// before the engine finalizes the run anyway (the executor future is then
/// dropped — the token remains the primary stop signal).
const CANCEL_GRACE: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub struct SchedulerEngine {
    store: SchedulerStore,
    registry: Arc<TaskExecutorRegistry>,
    worker_id: String,
    poll_interval: Duration,
    lease_name: String,
    lease_ttl: Duration,
    resident_heartbeat_timeout: Duration,
    queue: RunQueue,
}

impl SchedulerEngine {
    pub fn new(
        store: SchedulerStore,
        registry: Arc<TaskExecutorRegistry>,
        worker_id: impl Into<String>,
        poll_interval: Duration,
    ) -> Self {
        let lease_ttl = (poll_interval * 5).max(Duration::from_secs(10));
        Self {
            store,
            registry,
            worker_id: worker_id.into(),
            poll_interval,
            lease_name: SCHEDULER_LEASE.to_owned(),
            lease_ttl,
            resident_heartbeat_timeout: Duration::from_secs(60),
            queue: RunQueue::new(),
        }
    }

    pub fn with_lease_name(mut self, name: impl Into<String>) -> Self {
        self.lease_name = name.into();
        self
    }

    pub fn with_lease_ttl(mut self, ttl: Duration) -> Self {
        self.lease_ttl = ttl;
        self
    }

    pub fn with_resident_heartbeat_timeout(mut self, timeout: Duration) -> Self {
        self.resident_heartbeat_timeout = timeout;
        self
    }

    pub fn store(&self) -> &SchedulerStore {
        &self.store
    }

    pub fn registry(&self) -> &Arc<TaskExecutorRegistry> {
        &self.registry
    }

    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }

    pub fn queue(&self) -> &RunQueue {
        &self.queue
    }

    /// Full worker lifecycle: recover → acquire lease → poll loop → graceful
    /// shutdown. Returns when `shutdown` fires; never panics on provider or
    /// store errors (per-tick/per-run failures are logged and isolated).
    pub async fn run(self: Arc<Self>, shutdown: CancellationToken) {
        if let Err(error) = self.store.recover().await {
            log::error!("[scheduler] recovery failed: {error}");
        }
        let mut lease = None;
        while lease.is_none() && !shutdown.is_cancelled() {
            match LeaseGuard::acquire(&self.store, &self.lease_name, &self.worker_id, self.lease_ttl).await {
                Ok(acquired) => lease = acquired,
                Err(error) => log::warn!("[scheduler] lease acquisition failed: {error}"),
            }
            if lease.is_none() {
                tokio::select! {
                    _ = shutdown.cancelled() => break,
                    _ = tokio::time::sleep(self.poll_interval) => {}
                }
            }
        }
        let Some(lease) = lease else { return };
        if let Err(error) = lease.recover().await {
            log::error!("[scheduler] recovery failed: {error}");
        }
        self.enqueue_startup_runs().await;
        log::info!("[scheduler] worker {} took over the scheduler lease", self.worker_id);
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                _ = tokio::time::sleep(self.poll_interval) => {
                    if let Err(error) = lease.heartbeat().await {
                        log::warn!("[scheduler] lease heartbeat failed: {error}");
                    }
                    if let Err(error) = self.tick().await {
                        log::error!("[scheduler] scheduler tick failed: {error}");
                    }
                }
            }
        }
        log::info!("[scheduler] worker {} shutting down", self.worker_id);
        self.queue.drain().await;
        self.shutdown_residents().await;
        if let Err(error) = self.store.cancel_queued_runs().await {
            log::warn!("[scheduler] cannot cancel queued runs during shutdown: {error}");
        }
        lease.release().await;
    }

    /// One scheduling pass. Public so tests and embedders can drive the loop
    /// deterministically instead of relying on wall-clock polling.
    pub async fn tick(self: &Arc<Self>) -> Result<(), TaskError> {
        let now = Utc::now();
        self.store.enqueue_due(now).await?;
        while let Some(job) = self.store.claim(self.worker_id.clone(), now).await? {
            self.dispatch(job);
        }
        self.reap().await;
        self.reconcile_residents().await;
        Ok(())
    }

    /// `startup` triggers fire once on every (re)start of the worker for
    /// enabled tasks that have no run in flight.
    async fn enqueue_startup_runs(&self) {
        let Ok(tasks) = self.store.list_tasks().await else { return };
        for task in tasks {
            if !task.enabled || task.trigger != TaskTrigger::Startup {
                continue;
            }
            let in_flight =
                self.store.active_runs_for_task(task.id.clone()).await.map_or(true, |runs| !runs.is_empty());
            if in_flight {
                continue;
            }
            match self.store.enqueue_run(task.id.clone(), TaskRunTrigger::Startup, 1, Utc::now()).await {
                Ok(run) => {
                    super::events::publish(serde_json::json!({
                        "type": "run-created",
                        "taskId": task.id.clone(),
                        "runId": run.id.clone(),
                        "status": "queued",
                    }));
                }
                Err(error) => log::warn!("[scheduler] cannot enqueue startup run of task {}: {error}", task.id),
            }
        }
    }

    fn dispatch(self: &Arc<Self>, job: RunJob) {
        let run_id = job.run.id.clone();
        let task_id = job.task.id.clone();
        let cancellation = CancellationToken::new();
        let future = self.clone().execute_job(job, cancellation.clone());
        self.queue.spawn(run_id, task_id, cancellation, future);
    }

    /// Polls cancel flags of in-flight runs and drops finished bookkeeping.
    async fn reap(&self) {
        for run_id in self.queue.active_runs() {
            if self.store.is_cancel_requested(run_id.clone()).await.unwrap_or(false) {
                self.queue.cancel(&run_id);
            }
        }
        self.queue.reap();
    }

    /// Executes one claimed run end-to-end: mark running (dispatch
    /// invariant), execute (run mode) or start (resident mode), persist
    /// artifacts and logs, finalize the run, schedule retries.
    async fn execute_job(self: Arc<Self>, job: RunJob, cancellation: CancellationToken) {
        let run_id = job.run.id.clone();
        if let Err(error) = self.store.mark_run_started(run_id.clone(), self.worker_id.clone()).await {
            log::error!("[scheduler] cannot mark run {run_id} started: {error}");
            return;
        }
        // Engine-driven state change (ADR §7.4): the dispatch invariant made
        // this run `running`; broadcast it fire-and-forget.
        super::events::publish(serde_json::json!({
            "type": "run-state",
            "taskId": job.task.id.clone(),
            "runId": run_id.clone(),
            "status": "running",
        }));
        let log_directory = run_log_directory(&self.store, &job.run.created_at, &run_id);
        let mut logger = match TaskLogger::open_with_task(log_directory.clone(), Some(job.task.id.clone())) {
            Ok(logger) => logger,
            Err(error) => {
                log::error!("[scheduler] cannot open run log for {run_id}: {error}");
                let _ = self
                    .store
                    .finish_run(
                        run_id,
                        TaskRunStatus::Failed,
                        None,
                        Some("scheduler_unavailable".into()),
                        Some(format!("Cannot open run log: {error}")),
                    )
                    .await;
                return;
            }
        };
        let _ = logger.system(&format!(
            "run started (attempt {}, trigger {})",
            job.run.attempt,
            serde_json::to_string(&job.run.trigger).unwrap_or_default()
        ));
        let resident = job.task.execution.mode == TaskExecutionMode::Resident;
        let outcome = if resident {
            self.start_resident(&job, &cancellation, &logger).await
        } else {
            self.execute_run(&job, &cancellation, &logger).await
        };
        self.persist_log_index(&run_id, &log_directory, &logger).await;
        match outcome {
            // The run stays `running` and is supervised through its session.
            Outcome::ResidentStarted => {}
            Outcome::Cancelled => {
                self.finalize(
                    &job,
                    TaskRunStatus::Cancelled,
                    None,
                    Some("cancelled".into()),
                    Some("Run was cancelled".into()),
                    false,
                )
                .await;
            }
            Outcome::TimedOut => {
                let error =
                    TaskError::timeout(format!("Run exceeded its timeout of {:?}", job.task.execution.timeout_seconds));
                self.finalize(
                    &job,
                    TaskRunStatus::Timeout,
                    None,
                    Some(error.code.clone()),
                    Some(error.message.clone()),
                    true,
                )
                .await;
            }
            Outcome::Completed(Ok(result)) => {
                for artifact in result.artifacts {
                    self.save_artifact(&run_id, &logger, artifact).await;
                }
                let cancel_requested = self.store.is_cancel_requested(run_id.clone()).await.unwrap_or(false);
                if cancel_requested || cancellation.is_cancelled() {
                    self.finalize(
                        &job,
                        TaskRunStatus::Cancelled,
                        result.exit_code,
                        Some("cancelled".into()),
                        Some("Run was cancelled".into()),
                        false,
                    )
                    .await;
                } else if result.success {
                    let _ = logger.system("run finished successfully");
                    self.finalize(&job, TaskRunStatus::Success, result.exit_code, None, result.message, false).await;
                } else {
                    let _ = logger.system("run finished with a failure");
                    self.finalize(
                        &job,
                        TaskRunStatus::Failed,
                        result.exit_code,
                        Some("execution_failed".into()),
                        result.message.or_else(|| Some("Task reported failure".into())),
                        false,
                    )
                    .await;
                }
            }
            Outcome::Completed(Err(error)) => {
                let cancel_requested = self.store.is_cancel_requested(run_id.clone()).await.unwrap_or(false);
                let _ = logger.append("error", "system", &format!("run failed: {error}"));
                match error.kind {
                    super::TaskErrorKind::Cancelled => {
                        self.finalize(
                            &job,
                            TaskRunStatus::Cancelled,
                            None,
                            Some(error.code.clone()),
                            Some(error.message.clone()),
                            false,
                        )
                        .await;
                    }
                    _ if cancel_requested || cancellation.is_cancelled() => {
                        self.finalize(
                            &job,
                            TaskRunStatus::Cancelled,
                            None,
                            Some(error.code.clone()),
                            Some(error.message.clone()),
                            false,
                        )
                        .await;
                    }
                    _ => {
                        self.finalize(
                            &job,
                            TaskRunStatus::Failed,
                            None,
                            Some(error.code.clone()),
                            Some(error.message.clone()),
                            error.retryable(),
                        )
                        .await;
                    }
                }
            }
        }
    }

    async fn save_artifact(&self, run_id: &str, logger: &TaskLogger, artifact: TaskArtifact) {
        if let Err(error) = self.store.save_artifact(run_id.to_owned(), artifact.clone()).await {
            log::error!("[scheduler] cannot save artifact of run {run_id}: {error}");
            return;
        }
        let mut logger = logger.clone();
        let _ = logger.append("info", "system", &format!("artifact saved: {}", artifact.name));
    }

    /// Finalizes the run and schedules a retry when the error classification
    /// allows it and attempts remain (ADR §2.6: retries create a new run with
    /// `attempt + 1`, `trigger = "retry"`).
    async fn finalize(
        &self,
        job: &RunJob,
        status: TaskRunStatus,
        exit_code: Option<i32>,
        error_code: Option<String>,
        error_message: Option<String>,
        may_retry: bool,
    ) {
        let run = match self.store.finish_run(job.run.id.clone(), status, exit_code, error_code, error_message).await {
            Ok(run) => run,
            Err(error) => {
                log::error!("[scheduler] cannot finish run {}: {error}", job.run.id);
                return;
            }
        };
        log::info!("[scheduler] run {} finished as {}", run.id, run.status.as_str());
        super::events::publish(serde_json::json!({
            "type": "run-state",
            "taskId": job.task.id.clone(),
            "runId": run.id.clone(),
            "status": run.status.as_str(),
        }));
        if may_retry && matches!(status, TaskRunStatus::Failed | TaskRunStatus::Timeout) {
            let retry = &job.task.execution.retry;
            if run.attempt < retry.max_attempts {
                let delay = policy::retry_delay(retry, run.attempt);
                let available = Utc::now() + chrono::Duration::from_std(delay).unwrap_or_default();
                match self
                    .store
                    .enqueue_run(job.task.id.clone(), TaskRunTrigger::Retry, run.attempt + 1, available)
                    .await
                {
                    Ok(retry_run) => {
                        log::info!("[scheduler] scheduled retry run {} (attempt {})", retry_run.id, retry_run.attempt);
                        super::events::publish(serde_json::json!({
                            "type": "run-created",
                            "taskId": job.task.id.clone(),
                            "runId": retry_run.id.clone(),
                            "status": "queued",
                        }));
                    }
                    Err(error) => log::error!("[scheduler] cannot schedule retry of run {}: {error}", run.id),
                }
            }
        }
    }

    async fn execute_run(&self, job: &RunJob, cancellation: &CancellationToken, logger: &TaskLogger) -> Outcome {
        let Some(executor) = self.registry.task_executor(&job.task.provider_id) else {
            return Outcome::Completed(Err(TaskError::provider_not_found(format!(
                "No task executor registered for provider {}",
                job.task.provider_id
            ))));
        };
        if let Err(error) = executor.validate(&job.task).await {
            return Outcome::Completed(Err(error));
        }
        let context = TaskExecutionContext {
            task: job.task.clone(),
            run: job.run.clone(),
            cancellation: cancellation.clone(),
            logger: logger.clone(),
            progress: TaskProgressReporter::new(self.store.clone(), &job.run.id).with_task_id(job.task.id.clone()),
        };
        let execution = executor.execute(context);
        tokio::pin!(execution);
        let timeout = job.task.execution.timeout_seconds.map(Duration::from_secs);
        let sleep = async {
            match timeout {
                Some(duration) => tokio::time::sleep(duration).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(sleep);
        let mut timed_out = false;
        let completed = tokio::select! {
            result = &mut execution => Some(result),
            _ = &mut sleep => {
                // The cancellation token is the real stop signal (ADR §2.5):
                // timeout → token cancelled → executor stops → run = timeout.
                timed_out = true;
                cancellation.cancel();
                None
            }
            _ = cancellation.cancelled() => None,
        };
        match completed {
            Some(result) => Outcome::Completed(result),
            // Give the executor a grace period to observe the cancellation and
            // clean up before the run is finalized.
            None => {
                let _ = tokio::time::timeout(CANCEL_GRACE, &mut execution).await;
                if timed_out {
                    Outcome::TimedOut
                } else {
                    Outcome::Cancelled
                }
            }
        }
    }

    /// Resident mode: `timeout_seconds` bounds only the `start` phase (ADR
    /// §2.5); the running session is supervised by `reconcile_residents`.
    async fn start_resident(&self, job: &RunJob, cancellation: &CancellationToken, logger: &TaskLogger) -> Outcome {
        let Some(executor) = self.registry.resident_executor(&job.task.provider_id) else {
            return Outcome::Completed(Err(TaskError::provider_not_found(format!(
                "No resident executor registered for provider {}",
                job.task.provider_id
            ))));
        };
        let context = TaskExecutionContext {
            task: job.task.clone(),
            run: job.run.clone(),
            cancellation: cancellation.clone(),
            logger: logger.clone(),
            progress: TaskProgressReporter::new(self.store.clone(), &job.run.id).with_task_id(job.task.id.clone()),
        };
        let start = executor.start(context);
        tokio::pin!(start);
        let timeout = job.task.execution.timeout_seconds.map(Duration::from_secs);
        let sleep = async {
            match timeout {
                Some(duration) => tokio::time::sleep(duration).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(sleep);
        let mut timed_out = false;
        let started = tokio::select! {
            result = &mut start => Some(result),
            _ = &mut sleep => {
                // Timeout bounds only the `start` phase; the token is the stop signal.
                timed_out = true;
                cancellation.cancel();
                None
            }
            _ = cancellation.cancelled() => None,
        };
        let started = match started {
            Some(result) => result,
            None => {
                let _ = tokio::time::timeout(CANCEL_GRACE, &mut start).await;
                return if timed_out { Outcome::TimedOut } else { Outcome::Cancelled };
            }
        };
        let session_data = match started {
            Ok(session) => session,
            Err(error) => return Outcome::Completed(Err(error)),
        };
        let now = Utc::now();
        let restart_count = job.run.attempt.saturating_sub(1);
        // Reuse an existing session row (restart) so `restart_count` and the
        // restart window survive; otherwise create one.
        let session = match self.store.active_session_for_task(job.task.id.clone()).await {
            Ok(Some(mut existing)) => {
                existing.session_id = session_data.session_id;
                existing.run_id = job.run.id.clone();
                existing.state = ResidentState::Running;
                existing.heartbeat_at = Some(now.to_rfc3339());
                existing.restart_count = restart_count;
                existing.updated_at = now.to_rfc3339();
                existing
            }
            _ => ResidentSession {
                id: uuid::Uuid::new_v4().simple().to_string(),
                task_id: job.task.id.clone(),
                run_id: job.run.id.clone(),
                plugin_id: job.task.provider_id.clone(),
                session_id: session_data.session_id.clone(),
                state: ResidentState::Running,
                heartbeat_at: Some(now.to_rfc3339()),
                restart_count,
                created_at: now.to_rfc3339(),
                updated_at: now.to_rfc3339(),
            },
        };
        if let Err(error) = self.store.upsert_session(session).await {
            log::error!("[scheduler] cannot persist resident session of run {}: {error}", job.run.id);
            return Outcome::Completed(Err(error));
        }
        let mut logger = logger.clone();
        let _ = logger.system("resident session started");
        Outcome::ResidentStarted
    }

    /// Resident supervision (ADR §2.7): probe live sessions, honor restart
    /// policy on crashes, never leave a session stuck.
    async fn reconcile_residents(self: &Arc<Self>) {
        let Ok(sessions) = self.store.list_sessions().await else { return };
        let now = Utc::now();
        for session in sessions {
            match session.state {
                ResidentState::Crashed => self.clone().handle_resident_crash(session).await,
                ResidentState::Starting | ResidentState::Running | ResidentState::Stopping => {
                    self.probe_resident(session, now).await;
                }
                ResidentState::Stopped | ResidentState::Degraded => {}
            }
        }
    }

    async fn probe_resident(self: &Arc<Self>, session: ResidentSession, now: chrono::DateTime<Utc>) {
        let Some(executor) = self.registry.resident_executor(&session.plugin_id) else { return };
        let probe = executor.status(&session).await;
        match probe {
            Ok(status) => match status.state {
                ResidentState::Starting | ResidentState::Running | ResidentState::Stopping => {
                    let _ =
                        self.store.update_session_state(session.id.clone(), status.state, status.restart_count).await;
                }
                ResidentState::Stopped => {
                    let _ = self
                        .store
                        .update_session_state(session.id.clone(), ResidentState::Stopped, status.restart_count)
                        .await;
                    let _ =
                        self.store.finish_run(session.run_id.clone(), TaskRunStatus::Success, None, None, None).await;
                }
                ResidentState::Crashed => self.clone().handle_resident_crash(session).await,
                ResidentState::Degraded => {
                    let _ = self
                        .store
                        .update_session_state(session.id.clone(), ResidentState::Degraded, status.restart_count)
                        .await;
                    let _ = self
                        .store
                        .finish_run(
                            session.run_id.clone(),
                            TaskRunStatus::Failed,
                            None,
                            Some("restart_limit_reached".into()),
                            Some("Resident session reported degraded".into()),
                        )
                        .await;
                }
            },
            Err(error) => {
                // Heartbeat timeout judgement: a session whose heartbeat went
                // silent beyond the timeout counts as crashed.
                let stale = session
                    .heartbeat_at
                    .as_deref()
                    .and_then(|heartbeat| chrono::DateTime::parse_from_rfc3339(heartbeat).ok())
                    .map_or(false, |heartbeat| {
                        (now - heartbeat.with_timezone(&Utc)).num_milliseconds()
                            > self.resident_heartbeat_timeout.as_millis() as i64
                    });
                if stale {
                    log::warn!("[scheduler] resident session {} heartbeat timed out", session.id);
                    let _ = self
                        .store
                        .update_session_state(session.id.clone(), ResidentState::Crashed, session.restart_count)
                        .await;
                    self.clone().handle_resident_crash(session).await;
                } else {
                    log::warn!("[scheduler] resident status probe failed (retrying): {error}");
                }
            }
        }
    }

    async fn handle_resident_crash(self: Arc<Self>, session: ResidentSession) {
        // A stale crash report (the probe may still see the previous plugin
        // session while a restart dispatch is winding up) must not degrade a
        // session whose current run is already finalized. Only act when the
        // session's run is genuinely still in flight.
        let Ok(run) = self.store.get_run(session.run_id.clone()).await else { return };
        if !run.status.is_active() {
            return;
        }
        let Ok(task) = self.store.get_task(&session.task_id).await else { return };
        if task.execution.mode != TaskExecutionMode::Resident {
            return;
        }
        let restart = task.execution.restart.clone().unwrap_or(TaskRestartPolicy {
            enabled: false,
            max_restarts: 0,
            backoff_seconds: 0,
            restart_window_seconds: None,
        });
        if session.can_restart(&restart, Utc::now()) {
            let restart_count = session.restart_count + 1;
            let _ = self.store.update_session_state(session.id.clone(), ResidentState::Starting, restart_count).await;
            let available = Utc::now() + chrono::Duration::seconds(restart.backoff_seconds as i64);
            match self.store.enqueue_run(task.id.clone(), TaskRunTrigger::Restart, restart_count + 1, available).await {
                Ok(run) => {
                    log::info!("[scheduler] resident restart run {} scheduled (restart {restart_count})", run.id)
                }
                Err(error) => log::error!("[scheduler] cannot schedule resident restart: {error}"),
            }
            let _ = self
                .store
                .finish_run(
                    session.run_id.clone(),
                    TaskRunStatus::Failed,
                    None,
                    Some("worker_interrupted".into()),
                    Some("Resident session crashed; restart scheduled".into()),
                )
                .await;
        } else {
            log::warn!("[scheduler] resident session {} exceeded its restart budget; degrading", session.id);
            let _ = self
                .store
                .update_session_state(session.id.clone(), ResidentState::Degraded, session.restart_count)
                .await;
            let _ = self
                .store
                .finish_run(
                    session.run_id.clone(),
                    TaskRunStatus::Failed,
                    None,
                    Some("restart_limit_reached".into()),
                    Some("Resident session exceeded its restart budget".into()),
                )
                .await;
        }
    }

    /// Graceful shutdown of resident sessions: stop executors, mark stopped,
    /// finalize their runs as cancelled. A clean shutdown never triggers the
    /// restart policy (ADR §11).
    async fn shutdown_residents(&self) {
        let Ok(sessions) = self.store.list_sessions().await else { return };
        for session in sessions {
            if !session.state.is_active() {
                continue;
            }
            if let Some(executor) = self.registry.resident_executor(&session.plugin_id) {
                if let Err(error) = executor.stop(&session).await {
                    log::warn!("[scheduler] resident stop during shutdown failed: {error}");
                }
            }
            let _ = self
                .store
                .update_session_state(session.id.clone(), ResidentState::Stopped, session.restart_count)
                .await;
            let _ = self
                .store
                .finish_run(
                    session.run_id.clone(),
                    TaskRunStatus::Cancelled,
                    None,
                    Some("cancelled".into()),
                    Some("Scheduler shut down while the resident session was running".into()),
                )
                .await;
        }
    }

    async fn persist_log_index(&self, run_id: &str, directory: &std::path::Path, logger: &TaskLogger) {
        let Some(stats) = logger.stats() else { return };
        let path = directory.join(format!("{:06}.log", stats.segment));
        if let Err(error) =
            self.store.upsert_log_index(run_id.to_owned(), stats.segment, path, stats.byte_size, stats.line_count).await
        {
            log::error!("[scheduler] cannot update log index of run {run_id}: {error}");
        }
    }
}

enum Outcome {
    Completed(Result<TaskExecutionResult, TaskError>),
    TimedOut,
    Cancelled,
    ResidentStarted,
}

fn run_log_directory(store: &SchedulerStore, created_at: &str, run_id: &str) -> PathBuf {
    let date = chrono::DateTime::parse_from_rfc3339(created_at)
        .map(|time| time.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());
    store.logs_root().join(date.format("%Y/%m/%d").to_string()).join(run_id)
}
