//! Shared fixtures for the scheduler integration tests: a temp store, task
//! definition builders and scriptable fake executors.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use dbx_core::scheduler::{
    ResidentExecutor, ResidentSession, ResidentState, ResidentStatus, SchedulerEngine, SchedulerStore, TaskDefinition,
    TaskError, TaskExecutionContext, TaskExecutionResult, TaskExecutor, TaskExecutorRegistry, TaskProviderType,
    TaskRunStatus, TaskTarget, TaskTrigger,
};

pub fn temp_store() -> (tempfile::TempDir, SchedulerStore) {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = SchedulerStore::new(dir.path());
    (dir, store)
}

pub fn run_definition(id: &str, provider: &str, trigger: TaskTrigger) -> TaskDefinition {
    TaskDefinition {
        id: id.to_owned(),
        name: format!("task {id}"),
        provider_type: TaskProviderType::Builtin,
        provider_id: provider.to_owned(),
        target: TaskTarget::default(),
        trigger,
        execution: Default::default(),
        config_version: 1,
        config: serde_json::json!({}),
        enabled: true,
        created_at: String::new(),
        updated_at: String::new(),
        next_run_at: None,
        last_run_at: None,
        last_run_status: None,
        version: 1,
    }
}

pub async fn save(store: &SchedulerStore, task: TaskDefinition) -> TaskDefinition {
    store.save_task(task, None).await.expect("save task")
}

/// Scripted behaviours of the fake run executor.
#[derive(Clone, Debug)]
pub enum Behavior {
    /// Succeed immediately.
    Succeed,
    /// Fail with a retryable error.
    FailRetryable,
    /// Fail with a non-retryable error.
    FailNonRetryable,
    /// Fail the first `n` executions with a retryable error, then succeed.
    FailNTimes(u32),
    /// Block until cancellation is observed, then fail as cancelled.
    WaitCancelled,
    /// Sleep, honoring cancellation; succeed when the sleep elapses.
    SleepThenSucceed(Duration),
    /// Succeed and emit one artifact file.
    EmitArtifact,
}

impl Default for Behavior {
    fn default() -> Self {
        Self::Succeed
    }
}

#[derive(Clone, Default)]
pub struct TestExecutor {
    behavior: Arc<Mutex<Behavior>>,
    pub executions: Arc<Mutex<Vec<String>>>,
    /// Run ids whose cancellation token was observed to fire.
    pub cancellations_seen: Arc<Mutex<Vec<String>>>,
}

impl TestExecutor {
    pub fn new(behavior: Behavior) -> Self {
        Self { behavior: Arc::new(Mutex::new(behavior)), ..Default::default() }
    }

    pub fn set_behavior(&self, behavior: Behavior) {
        *self.behavior.lock().unwrap() = behavior;
    }

    pub fn execution_count(&self) -> usize {
        self.executions.lock().unwrap().len()
    }

    pub fn executions(&self) -> Vec<String> {
        self.executions.lock().unwrap().clone()
    }

    pub fn cancellations_seen(&self) -> Vec<String> {
        self.cancellations_seen.lock().unwrap().clone()
    }
}

#[async_trait]
impl TaskExecutor for TestExecutor {
    async fn validate(&self, _task: &TaskDefinition) -> Result<(), TaskError> {
        Ok(())
    }

    async fn execute(&self, mut context: TaskExecutionContext) -> Result<TaskExecutionResult, TaskError> {
        let run_id = context.run.id.clone();
        self.executions.lock().unwrap().push(run_id.clone());
        let _ = context.logger.append("info", "stdout", &format!("executing run {run_id}"));
        let behavior = self.behavior.lock().unwrap().clone();
        match behavior {
            Behavior::Succeed => Ok(TaskExecutionResult { success: true, ..Default::default() }),
            Behavior::FailRetryable => Err(TaskError::execution_failed("scripted retryable failure")),
            Behavior::FailNonRetryable => Err(TaskError::invalid_config("scripted invalid config")),
            Behavior::FailNTimes(times) => {
                let count = self.executions.lock().unwrap().len();
                if count <= times as usize {
                    Err(TaskError::execution_failed("scripted retryable failure"))
                } else {
                    Ok(TaskExecutionResult { success: true, ..Default::default() })
                }
            }
            Behavior::WaitCancelled => {
                context.cancellation.cancelled().await;
                self.cancellations_seen.lock().unwrap().push(run_id);
                Err(TaskError::cancelled("stopped by cancellation"))
            }
            Behavior::SleepThenSucceed(duration) => {
                tokio::select! {
                    _ = tokio::time::sleep(duration) => Ok(TaskExecutionResult { success: true, ..Default::default() }),
                    _ = context.cancellation.cancelled() => {
                        self.cancellations_seen.lock().unwrap().push(run_id);
                        Err(TaskError::cancelled("stopped by cancellation"))
                    }
                }
            }
            Behavior::EmitArtifact => {
                let path = std::env::temp_dir().join(format!("dbx-scheduler-test-artifact-{run_id}.txt"));
                std::fs::write(&path, b"artifact body").expect("write artifact");
                let size = std::fs::metadata(&path).map(|meta| meta.len()).ok();
                Ok(TaskExecutionResult {
                    success: true,
                    artifacts: vec![dbx_core::scheduler::TaskArtifact {
                        name: "out.txt".into(),
                        uri: path.to_string_lossy().into_owned(),
                        content_type: Some("text/plain".into()),
                        size,
                        checksum: None,
                    }],
                    ..Default::default()
                })
            }
        }
    }
}

/// Scripted resident executor: `status` reports whatever the test last set
/// for a session id (default `Running`).
#[derive(Clone, Default)]
pub struct TestResidentExecutor {
    states: Arc<Mutex<HashMap<String, ResidentState>>>,
    pub starts: Arc<Mutex<Vec<String>>>,
    pub stops: Arc<Mutex<Vec<String>>>,
    start_counter: Arc<Mutex<u32>>,
    hang_start: Arc<Mutex<bool>>,
}

impl TestResidentExecutor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_state(&self, session_id: &str, state: ResidentState) {
        self.states.lock().unwrap().insert(session_id.to_owned(), state);
    }

    pub fn set_hang_start(&self, hang: bool) {
        *self.hang_start.lock().unwrap() = hang;
    }

    pub fn starts(&self) -> Vec<String> {
        self.starts.lock().unwrap().clone()
    }

    pub fn stops(&self) -> Vec<String> {
        self.stops.lock().unwrap().clone()
    }

    /// The plugin-side session id of the most recent start (oldest first).
    pub fn last_session_id(&self) -> String {
        self.starts.lock().unwrap().last().cloned().expect("no resident session started")
    }
}

#[async_trait]
impl ResidentExecutor for TestResidentExecutor {
    async fn start(&self, context: TaskExecutionContext) -> Result<ResidentSession, TaskError> {
        let hang = *self.hang_start.lock().unwrap();
        if hang {
            context.cancellation.cancelled().await;
            return Err(TaskError::cancelled("resident start stopped by cancellation"));
        }
        let mut counter = self.start_counter.lock().unwrap();
        *counter += 1;
        let session_id = format!("sess-{counter}");
        drop(counter);
        self.starts.lock().unwrap().push(session_id.clone());
        self.states.lock().unwrap().insert(session_id.clone(), ResidentState::Running);
        Ok(ResidentSession {
            id: String::new(),
            task_id: String::new(),
            run_id: String::new(),
            plugin_id: String::new(),
            session_id,
            state: ResidentState::Running,
            heartbeat_at: None,
            restart_count: 0,
            created_at: String::new(),
            updated_at: String::new(),
        })
    }

    async fn stop(&self, session: &ResidentSession) -> Result<(), TaskError> {
        self.stops.lock().unwrap().push(session.session_id.clone());
        self.states.lock().unwrap().insert(session.session_id.clone(), ResidentState::Stopped);
        Ok(())
    }

    async fn status(&self, session: &ResidentSession) -> Result<ResidentStatus, TaskError> {
        let state = self.states.lock().unwrap().get(&session.session_id).copied().unwrap_or(ResidentState::Running);
        Ok(ResidentStatus {
            state,
            heartbeat_at: Some(chrono::Utc::now().to_rfc3339()),
            restart_count: session.restart_count,
        })
    }
}

pub fn registry_with(executor: TestExecutor) -> Arc<TaskExecutorRegistry> {
    let registry = Arc::new(TaskExecutorRegistry::new());
    registry.register_run("dbx.test", Arc::new(executor));
    registry
}

pub fn engine(store: &SchedulerStore, registry: Arc<TaskExecutorRegistry>, worker_id: &str) -> Arc<SchedulerEngine> {
    Arc::new(
        SchedulerEngine::new(store.clone(), registry, worker_id, Duration::from_millis(20))
            .with_lease_ttl(Duration::from_secs(30)),
    )
}

/// Drives engine ticks (with small yields so spawned dispatch tasks run)
/// until `run_id` reaches one of `terminal`, then returns the run.
pub async fn drive_until_terminal(
    engine: &Arc<SchedulerEngine>,
    store: &SchedulerStore,
    run_id: &str,
    terminal: &[TaskRunStatus],
) -> dbx_core::scheduler::TaskRun {
    for _ in 0..300 {
        engine.tick().await.expect("engine tick");
        if let Ok(run) = store.get_run(run_id.to_owned()).await {
            if terminal.contains(&run.status) {
                return run;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("run {run_id} did not reach a terminal status in time");
}

/// Drives engine ticks (with small yields so spawned dispatch tasks run)
/// until `check` (re-evaluated with fresh awaits each iteration) is true.
pub async fn drive_until<F, Fut>(engine: &Arc<SchedulerEngine>, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..300 {
        engine.tick().await.expect("engine tick");
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("engine condition not reached in time");
}
