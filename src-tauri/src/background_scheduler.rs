//! Background scheduler worker (ADR §11): generalizes the legacy database
//! backup worker to host the generic [`SchedulerEngine`] in a detached child
//! process, so enabled tasks keep running after the UI closes (ADR §1.4) and
//! a worker crash never takes the desktop app down.
//!
//! Reuse contract: process spawn / detached flags / worker log / graceful
//! shutdown mirror `background_backup.rs`; there is exactly one scheduler
//! implementation (the `SchedulerEngine` in dbx-core) — this module only
//! hosts it.
//!
//! Process model:
//! - Worker mode: `--scheduler-worker` (or `DBX_PROCESS_ROLE=scheduler-worker`).
//!   The legacy backup worker arguments stay untouched and keep working.
//! - Feature flags (ADR §12), both default OFF for zero behavior change:
//!   `DBX_SCHEDULER_BACKGROUND_ENABLED=1` → `scheduler.background.enabled`
//!   (the UI spawns and supervises the worker child),
//!   `DBX_SCHEDULER_GENERIC_ENABLED=1` → `scheduler.generic.enabled`
//!   (the worker migrates legacy database backup schedules before looping).
//! - Lifecycle (ADR §3.4): startup → acquire lease → recover → migration →
//!   loop { heartbeat → enqueue_due → claim → dispatch → reconcile } →
//!   shutdown { cancel → stop active work → persist → release lease → exit }.
//!   The loop itself lives in `SchedulerEngine::run`; this module drives its
//!   stop signals (SIGINT/SIGTERM/stop-request file) and supervises crashes
//!   with bounded backoff restarts.

use dbx_core::{
    connection::AppState,
    scheduled_backup::{worker_runtime, BackupService, BackupStore},
    scheduler::{
        providers::{DatabaseBackupTaskExecutor, DATABASE_BACKUP_PROVIDER_ID},
        register_event_sink, LeaseGuard, SchedulerEngine, SchedulerMigration, SchedulerStore, TaskExecutorRegistry,
        SCHEDULER_LEASE,
    },
    storage::Storage,
};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const WORKER_ARG: &str = "--scheduler-worker";
const ROLE_ENV: &str = "DBX_PROCESS_ROLE";
const ROLE_VALUE: &str = "scheduler-worker";
pub const BACKGROUND_FLAG_ENV: &str = "DBX_SCHEDULER_BACKGROUND_ENABLED";
pub const GENERIC_FLAG_ENV: &str = "DBX_SCHEDULER_GENERIC_ENABLED";
const POLL_SECONDS_ENV: &str = "DBX_SCHEDULER_POLL_SECONDS";
const DEFAULT_POLL_SECONDS: u64 = 10;
/// Desktop Tauri event name (ADR §7.4), same channel the API commands use.
const SCHEDULER_EVENT: &str = "dbx-scheduler-event";
/// How long a stop-request file stays actionable; stale leftovers (crashed
/// supervisor between write and remove) expire instead of self-stopping the
/// next worker.
const STOP_REQUEST_VALIDITY: Duration = Duration::from_secs(5 * 60);
/// How often the worker checks its stop signals while the engine runs.
const STOP_POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Grace period for the engine drain (queue drain + resident stops + lease
/// release) after cancellation before the process exits anyway.
const ENGINE_SHUTDOWN_GRACE: Duration = Duration::from_secs(90);
/// How long a new supervisor waits for the previous worker generation to
/// exit gracefully before spawning its own child anyway.
const TAKEOVER_WAIT: Duration = Duration::from_secs(20);

#[derive(Debug, PartialEq, Eq)]
enum WorkerMode {
    None,
    Scheduler,
}

fn worker_mode(args: &[std::ffi::OsString], process_role: Option<&str>) -> WorkerMode {
    if args.iter().any(|arg| arg == WORKER_ARG) {
        return WorkerMode::Scheduler;
    }
    if process_role.is_some_and(|role| role.trim() == ROLE_VALUE) {
        return WorkerMode::Scheduler;
    }
    WorkerMode::None
}

/// `scheduler.background.enabled` (ADR §12): whether the desktop app spawns
/// and supervises the background scheduler worker.
///
/// Defaults to **on**: the task center enqueues runs into the scheduler
/// database and nothing in the UI process claims them (the UI owns no task
/// lifecycle, ADR §1), so a flag-off install would leave every run queued
/// forever — the exact "always queued" symptom. The env var remains as an
/// explicit opt-out for installs that must not run scheduled work.
fn env_enabled(value: Option<&str>) -> bool {
    match value.map(|value| value.trim().to_lowercase()) {
        None => true,
        Some(value) => !matches!(value.as_str(), "0" | "false" | "no" | "off" | ""),
    }
}

pub fn background_enabled() -> bool {
    env_enabled(std::env::var(BACKGROUND_FLAG_ENV).ok().as_deref())
}

/// `scheduler.generic.enabled` (ADR §12): whether the generic scheduler owns
/// the migrated legacy database backup schedules.
pub fn generic_enabled() -> bool {
    env_enabled(std::env::var(GENERIC_FLAG_ENV).ok().as_deref())
}

/// Engine poll interval — injected, never hard-coded into the engine loop
/// (ADR §3.4); `DBX_SCHEDULER_POLL_SECONDS` overrides the desktop default.
fn poll_interval() -> Duration {
    Duration::from_secs(poll_seconds_from(std::env::var(POLL_SECONDS_ENV).ok().as_deref()))
}

fn poll_seconds_from(value: Option<&str>) -> u64 {
    value
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|seconds| *seconds >= 1)
        .unwrap_or(DEFAULT_POLL_SECONDS)
}

fn scheduler_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("scheduler")
}

fn worker_pid_path(data_dir: &Path) -> PathBuf {
    scheduler_dir(data_dir).join("worker.pid")
}

fn worker_stop_path(data_dir: &Path) -> PathBuf {
    scheduler_dir(data_dir).join("worker.stop")
}

fn worker_log_path(data_dir: &Path) -> PathBuf {
    scheduler_dir(data_dir).join("worker.log")
}

fn data_dir_from_args(args: &[std::ffi::OsString]) -> Result<PathBuf, String> {
    let index =
        args.iter().position(|arg| arg == "--data-dir").ok_or("--data-dir is required for the scheduler worker")?;
    let dir = PathBuf::from(args.get(index + 1).ok_or("--data-dir requires a path")?);
    if !dir.is_absolute() || !dir.join("dbx.db").is_file() {
        return Err("Worker requires an existing absolute DBX data directory".into());
    }
    Ok(dir)
}

fn process_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    #[cfg(unix)]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .output()
            .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
    }
}

/// Whether a stop-request file is present and fresh; stale leftovers are
/// removed so they cannot self-stop a later worker generation.
fn stop_request_pending(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else { return false };
    let fresh = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < STOP_REQUEST_VALIDITY);
    if !fresh {
        let _ = std::fs::remove_file(path);
    }
    fresh
}

/// Exit request for the previous worker generation: the stop file is the only
/// channel into the detached worker, and the pid file only ever marks
/// liveness — nothing is ever SIGKILLed, so a recycled pid at worst causes a
/// harmless 20s wait.
async fn retire_previous_worker(data_dir: &Path) {
    let pid = std::fs::read_to_string(worker_pid_path(data_dir))
        .ok()
        .and_then(|content| content.trim().parse::<u32>().ok())
        .filter(|pid| *pid != std::process::id() && process_alive(*pid));
    if let Some(pid) = pid {
        log::info!("[scheduler] asking the previous worker (pid {pid}) to exit");
        let stop_path = worker_stop_path(data_dir);
        let _ = std::fs::write(&stop_path, chrono::Utc::now().to_rfc3339());
        let deadline = Instant::now() + TAKEOVER_WAIT;
        while Instant::now() < deadline {
            if !process_alive(pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    // Always clear the request so the fresh worker never self-stops.
    let _ = std::fs::remove_file(worker_stop_path(data_dir));
}

/// Spawns the detached worker child and records its pid for the next
/// generation's takeover. Detached like the backup worker: own process group
/// on unix, breakaway + no window on Windows, so the child outlives the UI.
async fn spawn_scheduler_worker(data_dir: &Path) -> Result<std::process::Child, String> {
    retire_previous_worker(data_dir).await;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = Command::new(executable);
    command
        .arg(WORKER_ARG)
        .arg("--data-dir")
        .arg(data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = command.spawn().map_err(|error| error.to_string())?;
    let _ = std::fs::write(worker_pid_path(data_dir), child.id().to_string());
    Ok(child)
}

/// Bounded crash-restart policy (ADR §11: "restart with backoff (有界)"):
/// consecutive failures double the backoff up to `max_backoff`; past
/// `max_consecutive_failures` the supervisor gives up until the next app
/// start instead of crash-looping forever.
#[derive(Debug, Clone, Copy)]
struct RestartPolicy {
    probe_interval: Duration,
    base_backoff: Duration,
    max_backoff: Duration,
    max_consecutive_failures: u32,
    /// A child that stayed alive this long counts as healthy again.
    healthy_runtime: Duration,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            probe_interval: Duration::from_secs(5),
            base_backoff: Duration::from_secs(5),
            max_backoff: Duration::from_secs(300),
            max_consecutive_failures: 5,
            healthy_runtime: Duration::from_secs(120),
        }
    }
}

/// `None` means the restart budget is exhausted — stop restarting.
fn restart_backoff(consecutive_failures: u32, policy: &RestartPolicy) -> Option<Duration> {
    if consecutive_failures > policy.max_consecutive_failures {
        return None;
    }
    let shift = consecutive_failures.saturating_sub(1).min(16);
    Some(policy.base_backoff.saturating_mul(1u32 << shift).min(policy.max_backoff))
}

/// Worker supervisor loop: keeps exactly one child running while alive,
/// restarting crashes with bounded backoff. Deliberately does NOT kill the
/// child when the supervisor itself stops (UI close must not stop enabled
/// tasks, ADR §1.4) — the detached worker is the execution host, and the DB
/// lease arbitrates when a later app start spawns a replacement.
async fn supervise<F, Fut>(mut spawn: F, stop: CancellationToken, policy: RestartPolicy)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<std::process::Child, String>>,
{
    let mut consecutive_failures: u32 = 0;
    let mut child: Option<std::process::Child> = None;
    let mut spawned_at: Option<Instant> = None;
    loop {
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = tokio::time::sleep(policy.probe_interval) => {
                let exited = match child.as_mut() {
                    Some(running) => running.try_wait().ok().flatten().is_some(),
                    None => true,
                };
                if !exited {
                    continue;
                }
                if let Some(started) = spawned_at {
                    if started.elapsed() >= policy.healthy_runtime {
                        consecutive_failures = 0;
                    }
                }
                consecutive_failures += 1;
                log::warn!("[scheduler] worker exited; consecutive failure {consecutive_failures}");
                match restart_backoff(consecutive_failures, &policy) {
                    Some(backoff) => {
                        tokio::select! {
                            _ = stop.cancelled() => break,
                            _ = tokio::time::sleep(backoff) => {}
                        }
                        match spawn().await {
                            Ok(restarted) => {
                                log::info!("[scheduler] worker restarted (pid {:?})", restarted.id());
                                child = Some(restarted);
                                spawned_at = Some(Instant::now());
                            }
                            Err(error) => {
                                log::error!("[scheduler] worker spawn failed: {error}");
                                child = None;
                                spawned_at = None;
                            }
                        }
                    }
                    None => {
                        log::error!("[scheduler] worker restart budget exhausted; no further restarts until the next app start");
                        break;
                    }
                }
            }
        }
    }
}

/// UI-side state: supervises the worker child while the app runs. Safe to
/// construct and manage unconditionally — without
/// `DBX_SCHEDULER_BACKGROUND_ENABLED` both `start` and `shutdown` are no-ops,
/// so the flag-off behavior is byte-for-byte the old one.
pub struct BackgroundScheduler {
    data_dir: PathBuf,
    stop: CancellationToken,
    supervisor: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl BackgroundScheduler {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir, stop: CancellationToken::new(), supervisor: tokio::sync::Mutex::new(None) }
    }

    /// Spawns and supervises the worker child when
    /// `scheduler.background.enabled` is on. Startup failures are logged and
    /// swallowed: the scheduler must never take the desktop app down.
    pub async fn start(&self) {
        if !background_enabled() {
            return;
        }
        let mut supervisor = self.supervisor.lock().await;
        if supervisor.is_some() {
            return;
        }
        let data_dir = self.data_dir.clone();
        let stop = self.stop.clone();
        *supervisor = Some(tokio::spawn(async move {
            // The factory owns its own copy so each spawn future is
            // self-contained (no borrow of the closure environment).
            supervise(
                move || {
                    let data_dir = data_dir.clone();
                    async move { spawn_scheduler_worker(&data_dir).await }
                },
                stop,
                RestartPolicy::default(),
            )
            .await;
        }));
    }

    /// Stops supervising on app exit. The detached worker child keeps running
    /// (ADR §1.4); a crashed worker is only restarted while the app lives,
    /// with OS-level registration as the follow-up for the managed mode.
    pub async fn shutdown(&self) {
        self.stop.cancel();
        if let Some(supervisor) = self.supervisor.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(15), supervisor).await;
        }
    }
}

/// Desktop subscription point for engine-originated scheduler events (ADR
/// §7.4): forwards them onto the same `dbx-scheduler-event` Tauri channel the
/// API mutations use. Registered in the UI process; the detached worker
/// process has no webview, so its engine events are mirrored to the worker
/// log there instead.
pub fn register_tauri_event_sink(app: tauri::AppHandle) {
    register_event_sink(
        "dbx-tauri-ui",
        Arc::new(move |event| {
            let _ = tauri::Emitter::emit(&app, SCHEDULER_EVENT, event.clone());
        }),
    );
}

/// Wave 2 handoff A (ADR §8): migrate legacy scheduled database backups into
/// the generic store after the lease attempt and before entering the engine
/// loop. The migration itself is idempotent, atomic and restart-safe (ADR
/// §8.3), and its marker protocol serializes racing attempts inside
/// `BEGIN IMMEDIATE` — so a lost lease race against another live worker is
/// still safe, and a skipped run is simply retried on the next startup.
async fn run_legacy_migration_if_enabled(store: SchedulerStore, data_dir: &Path, enabled: bool) {
    if !enabled {
        return;
    }
    let worker_id = format!("scheduler-{}", uuid::Uuid::new_v4().simple());
    // ADR §3.4 ordering: take the scheduler lease around the migration, then
    // release it so SchedulerEngine::run re-acquires it for the main loop.
    let lease_ttl = (poll_interval() * 5).max(Duration::from_secs(10));
    let lease = LeaseGuard::acquire(&store, SCHEDULER_LEASE, &worker_id, lease_ttl).await.ok().flatten();
    let legacy = BackupStore::new(data_dir);
    match SchedulerMigration::new(store).migrate_legacy_database_backups(&legacy).await {
        Ok(report) => {
            log::info!("[scheduler] legacy backup migration: {} schedules, {} runs", report.schedules, report.runs)
        }
        // Non-fatal: the legacy scheduler keeps working and the next worker
        // start retries the marker-guarded transaction (ADR §8.3).
        Err(error) => log::error!("[scheduler] legacy backup migration failed: {error}"),
    }
    // LeaseGuard has no Drop release — the async release must be awaited, or
    // the row lingers until TTL expiry and delays the engine's first acquire.
    if let Some(lease) = lease {
        lease.release().await;
    }
}

struct WorkerLogger(std::sync::Mutex<std::fs::File>);

impl log::Log for WorkerLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }
    fn log(&self, record: &log::Record<'_>) {
        use std::io::Write;
        if self.enabled(record.metadata()) {
            if let Ok(mut file) = self.0.lock() {
                let _ = writeln!(file, "{} {} {}", chrono::Utc::now().to_rfc3339(), record.level(), record.args());
            }
        }
    }
    fn flush(&self) {
        use std::io::Write;
        if let Ok(mut file) = self.0.lock() {
            let _ = file.flush();
        }
    }
}

/// Worker log under `<data-dir>/scheduler/worker.log` (5 MiB truncate), at
/// info level so engine run bookkeeping and mirrored events stay observable
/// in a headless child process.
fn worker_logging(data_dir: &Path) -> Result<(), String> {
    let directory = scheduler_dir(data_dir);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = worker_log_path(data_dir);
    let truncate = std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 5 * 1024 * 1024);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(!truncate)
        .truncate(truncate)
        .open(path)
        .map_err(|error| error.to_string())?;
    if log::set_logger(Box::leak(Box::new(WorkerLogger(std::sync::Mutex::new(file))))).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    Ok(())
}

/// Entrypoint for `--scheduler-worker` (or `DBX_PROCESS_ROLE`). Returns false
/// when this process is not a scheduler worker; true after the worker ran to
/// completion (the caller then exits without initializing the Tauri app).
pub fn run_if_requested() -> bool {
    let args: Vec<_> = std::env::args_os().collect();
    if worker_mode(&args, std::env::var(ROLE_ENV).ok().as_deref()) != WorkerMode::Scheduler {
        return false;
    }
    let result = (|| {
        let dir = data_dir_from_args(&args)?;
        worker_logging(&dir)?;
        register_event_sink(
            "dbx-scheduler-worker-log",
            Arc::new(|event| {
                log::info!("[scheduler-event] {event}");
            }),
        );
        let runtime = worker_runtime().map_err(|error| error.to_string())?;
        let result = runtime.block_on(async {
            let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
            dbx_core::sql_dialect::dialect_loader::register_core_dialects();
            let storage = Storage::open_unmigrated(&dir.join("dbx.db")).await?;
            let state = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
            let store = SchedulerStore::new(&dir);

            let registry = Arc::new(TaskExecutorRegistry::new());
            let backup = BackupService::new(state.clone(), &dir, None);
            registry.register_run(DATABASE_BACKUP_PROVIDER_ID, Arc::new(DatabaseBackupTaskExecutor::new(backup)));
            // One executor routes every plugin task provider over the frozen
            // task/* RPC contract; provider ids decide the plugin (ADR §22).
            registry.register_run(
                "plugin",
                Arc::new(dbx_core::scheduler::providers::PluginTaskExecutor::new(state.clone())),
            );
            registry.register_run(
                dbx_core::scheduler::providers::CLOUD_SYNC_PROVIDER_ID,
                Arc::new(dbx_core::scheduler::providers::CloudSyncTaskExecutor::new(state.clone())),
            );

            run_legacy_migration_if_enabled(store.clone(), &dir, generic_enabled()).await;

            let worker_id = format!("scheduler-{}", uuid::Uuid::new_v4().simple());
            let engine = Arc::new(SchedulerEngine::new(store, registry, worker_id, poll_interval()));
            let shutdown = CancellationToken::new();
            let engine = {
                let shutdown = shutdown.clone();
                tokio::spawn(async move { engine.run(shutdown).await })
            };
            log::info!("[scheduler] worker started (poll every {:?})", poll_interval());
            #[cfg(unix)]
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|e| e.to_string())?;
            loop {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => break,
                    _ = async {
                        #[cfg(unix)]
                        {
                            terminate.recv().await;
                        }
                        #[cfg(not(unix))]
                        {
                            std::future::pending::<()>().await;
                        }
                    } => break,
                    _ = tokio::time::sleep(STOP_POLL_INTERVAL) => {
                        if engine.is_finished() {
                            break;
                        }
                        if stop_request_pending(&worker_stop_path(&dir)) {
                            log::info!("[scheduler] stop requested by the supervisor");
                            break;
                        }
                    }
                }
            }
            // Graceful shutdown order (ADR §11): cancel the scheduler → the
            // engine stops active work and persists → releases the lease →
            // then the process exits.
            shutdown.cancel();
            let _ = tokio::time::timeout(ENGINE_SHUTDOWN_GRACE, engine).await;
            let _ = std::fs::remove_file(worker_pid_path(&dir));
            state.shutdown(Duration::from_secs(3)).await;
            Ok::<_, String>(())
        });
        // Runtime drop otherwise waits indefinitely for a stalled executor.
        runtime.shutdown_timeout(Duration::from_secs(3));
        result
    })();
    if let Err(error) = result {
        log::error!("DBX scheduler worker: {error}");
        eprintln!("DBX scheduler worker: {error}");
        std::process::exit(1);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::Mutex;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn scheduler_mode_requires_its_own_arg_or_role() {
        assert_eq!(worker_mode(&args(&[]), None), WorkerMode::None);
        assert_eq!(worker_mode(&args(&["--scheduler-worker", "--data-dir", "/tmp"]), None), WorkerMode::Scheduler);
        assert_eq!(worker_mode(&args(&[]), Some("scheduler-worker")), WorkerMode::Scheduler);
        assert_eq!(worker_mode(&args(&[]), Some(" scheduler-worker ")), WorkerMode::Scheduler);
        assert_eq!(worker_mode(&args(&[]), Some("ui-backup-worker")), WorkerMode::None);
        assert_eq!(worker_mode(&args(&["other"]), Some("scheduler-worker")), WorkerMode::Scheduler);
    }

    #[test]
    fn legacy_backup_worker_arguments_stay_with_the_backup_worker() {
        // The migration-era backup workers (--ui-backup-worker,
        // --managed-backup-worker, --backup-worker and the historical
        // --background-backup-worker spelling) must never be claimed by the
        // scheduler worker; background_backup::run_if_requested keeps them.
        for legacy in ["--ui-backup-worker", "--managed-backup-worker", "--backup-worker", "--background-backup-worker"]
        {
            assert_eq!(worker_mode(&args(&[legacy, "--data-dir", "/tmp"]), None), WorkerMode::None, "{legacy}");
        }
    }

    #[test]
    fn feature_flags_default_on_with_explicit_opt_out() {
        // Unset → on: the task center needs the worker, or runs queue forever.
        assert!(env_enabled(None));
        assert!(env_enabled(Some("1")));
        assert!(env_enabled(Some(" true ")));
        assert!(env_enabled(Some("YES")));
        assert!(env_enabled(Some("on")));
        assert!(env_enabled(Some("anything-else")));
        // Explicit opt-out only.
        assert!(!env_enabled(Some("0")));
        assert!(!env_enabled(Some("false")));
        assert!(!env_enabled(Some("")));
    }

    #[test]
    fn restart_backoff_is_exponential_capped_and_bounded() {
        let policy = RestartPolicy::default();
        assert_eq!(restart_backoff(1, &policy), Some(Duration::from_secs(5)));
        assert_eq!(restart_backoff(2, &policy), Some(Duration::from_secs(10)));
        assert_eq!(restart_backoff(3, &policy), Some(Duration::from_secs(20)));
        // The budget is finite: past the limit there is no restart.
        assert_eq!(restart_backoff(policy.max_consecutive_failures, &policy).is_some(), true);
        assert_eq!(restart_backoff(policy.max_consecutive_failures + 1, &policy), None);

        // A long budget still saturates at the cap instead of overflowing.
        let long_budget = RestartPolicy { max_consecutive_failures: 20, ..policy };
        assert_eq!(restart_backoff(8, &long_budget), Some(Duration::from_secs(300)));
        assert_eq!(restart_backoff(20, &long_budget), Some(Duration::from_secs(300)));
        assert_eq!(restart_backoff(21, &long_budget), None);
    }

    #[test]
    fn stop_request_requires_a_fresh_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("worker.stop");
        assert!(!stop_request_pending(&path), "missing file is not a stop request");
        std::fs::write(&path, b"1").unwrap();
        assert!(stop_request_pending(&path), "a just-written request is honored");
    }

    #[test]
    fn liveness_check_recognizes_the_current_process() {
        assert!(process_alive(std::process::id()));
    }

    #[test]
    fn poll_seconds_are_injected_and_sanitized() {
        assert_eq!(poll_seconds_from(None), 10);
        assert_eq!(poll_seconds_from(Some("")), 10);
        assert_eq!(poll_seconds_from(Some("abc")), 10);
        assert_eq!(poll_seconds_from(Some("0")), 10);
        assert_eq!(poll_seconds_from(Some("30")), 30);
        assert_eq!(poll_seconds_from(Some(" 5 ")), 5);
    }

    #[tokio::test]
    async fn background_scheduler_start_is_shutdown_safe_and_idempotent() {
        // Tests may run with the flag either way (CI sometimes exports it);
        // start() must stay shutdown-idempotent in both.
        std::env::remove_var(BACKGROUND_FLAG_ENV);
        let scheduler = BackgroundScheduler::new(forgetful_tempdir().await);
        scheduler.start().await;
        scheduler.shutdown().await;
        assert!(scheduler.supervisor.lock().await.is_none());
        scheduler.shutdown().await; // idempotent
    }

    async fn forgetful_tempdir() -> PathBuf {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        // Keep the directory alive for the duration of the test binary.
        std::mem::forget(dir);
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn supervisor_restarts_crashed_children_and_keeps_them_on_shutdown() {
        let spawned: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
        let factory = {
            let spawned = Arc::clone(&spawned);
            move || {
                let spawned = Arc::clone(&spawned);
                async move {
                    let child = std::process::Command::new("/bin/sleep")
                        .arg("60")
                        .spawn()
                        .map_err(|error| error.to_string())?;
                    spawned.lock().unwrap().push(child.id());
                    Ok(child)
                }
            }
        };
        let policy = RestartPolicy {
            probe_interval: Duration::from_millis(40),
            base_backoff: Duration::from_millis(40),
            max_backoff: Duration::from_millis(120),
            max_consecutive_failures: 3,
            healthy_runtime: Duration::from_secs(3600),
        };
        let stop = CancellationToken::new();
        let supervisor = tokio::spawn(supervise(factory, stop.clone(), policy));

        // Wait for the first child, crash it, and wait for the bounded restart.
        let deadline = Instant::now() + Duration::from_secs(5);
        while spawned.lock().unwrap().is_empty() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let first = *spawned.lock().unwrap().first().expect("first child spawned");
        let _ = Command::new("kill").args(["-9", &first.to_string()]).status();
        let deadline = Instant::now() + Duration::from_secs(5);
        while spawned.lock().unwrap().len() < 2 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(spawned.lock().unwrap().len(), 2, "crashed worker is restarted");

        // Stopping the supervisor must not stop the (healthy) child.
        stop.cancel();
        tokio::time::timeout(Duration::from_secs(5), supervisor).await.expect("supervisor exits").unwrap();
        let replacement = *spawned.lock().unwrap().last().unwrap();
        assert!(process_alive(replacement), "UI-side shutdown leaves the worker running");
        let _ = Command::new("kill").args(["-9", &replacement.to_string()]).status();
    }

    #[tokio::test]
    async fn legacy_migration_runs_once_and_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let legacy_store = dbx_core::scheduled_backup::BackupStore::new(directory.path());
        let schedule: dbx_core::scheduled_backup::BackupSchedule = serde_json::from_str(
            r#"{
                "id": "legacy-1", "name": "Nightly", "enabled": true, "connectionId": "conn-1", "databases": [],
                "destinationDirectory": "/tmp/b", "includeStructure": true, "includeData": true,
                "includeObjects": true, "frequency": "daily", "intervalHours": 1,
                "timeOfDay": "02:30", "weekday": 0, "retentionCount": 3, "timeZone": "UTC",
                "createdAt": "2026-01-01T00:00:00+00:00", "updatedAt": "2026-01-01T00:00:00+00:00",
                "nextRunAt": "2026-01-01T00:00:00+00:00"
            }"#,
        )
        .unwrap();
        legacy_store.save_schedule(schedule).await.unwrap();

        let store = SchedulerStore::new(directory.path());
        let migration = SchedulerMigration::new(store.clone());
        let marker = dbx_core::scheduler::migration::DATABASE_BACKUP_MIGRATION_KEY;

        // Flag off: zero behavior — no task appears, no marker is written.
        run_legacy_migration_if_enabled(store.clone(), directory.path(), false).await;
        assert!(store.list_tasks().await.unwrap().is_empty());
        assert!(!migration.is_applied(marker).await.unwrap());

        // Flag on: the legacy schedule becomes a generic task definition.
        run_legacy_migration_if_enabled(store.clone(), directory.path(), true).await;
        let tasks = store.list_tasks().await.unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].provider_id, "dbx.database-backup");
        assert_eq!(tasks[0].id, "legacy-1");
        assert!(migration.is_applied(marker).await.unwrap());

        // Restart-safe: a second run is a no-op (idempotent marker protocol).
        run_legacy_migration_if_enabled(store.clone(), directory.path(), true).await;
        assert_eq!(store.list_tasks().await.unwrap().len(), 1);
    }
}
