//! WebView2 process-failure recovery coordinator.
//!
//! wry's platform layer detects WebView2 child-process failures and surfaces
//! a structured [`WebView2ProcessFailedInfo`] signal (see
//! `vendor/wry/src/webview2/mod.rs`). This module owns the
//! *application-level* recovery policy: deciding whether a failure deserves a
//! renderer reload, an application restart, or nothing but diagnostics, and
//! executing the chosen action through Tauri APIs.
//!
//! The policy is deliberately a pure, deterministic state machine
//! ([`WebView2Recovery`]) so it can be unit-tested on any platform without a
//! Windows/WebView2 runtime; only [`install`] touches Tauri/wry.
//!
//! ## Kind policy (mirrors Microsoft's process-related-event guidance)
//!
//! - **Browser process exited**: fatal. Every control is closed and the
//!   environment is gone; a plain reload is ineffective. DBX restarts the
//!   application through the normal close flow so persisted state (open tabs,
//!   window geometry, saved SQL) survives and running queries are cancelled
//!   by `AppState::shutdown` (see `commands::connection`).
//! - **Main renderer exited**: confirmed renderer death — reload, bounded by
//!   the rolling budget below.
//! - **Renderer unresponsive**: the event can be raised repeatedly and the
//!   renderer may recover on its own, so DBX does **not** reload on the first
//!   event. Only once the event fires `unresponsive_threshold` times inside
//!   `unresponsive_window` does recovery trigger (still bounded by the same
//!   rolling budget).
//! - **GPU exited**: WebView2 restarts the GPU process on its own; no reload.
//! - **Subframe renderer exited**: recovery is per-frame; reloading the whole
//!   SPA would discard unsaved SQL / editor state for the whole window.
//! - **Utility / other**: log only, no destructive recovery.
//!
//! ## Reload budget (rolling, committed only on success)
//!
//! At most `max_reloads_in_window` automatic reloads are allowed inside a
//! rolling `reload_window`. The policy *decides* a reload is allowed without
//! consuming the budget; the budget is **committed only after the reload is
//! confirmed to have succeeded** ([`WebView2Recovery::record_reload_success`]).
//! A failed reload (main-thread scheduling failure, missing main window, or
//! `window.reload()` returning an error) never consumes a budget slot, so a
//! run of reloads that never actually happened cannot silently exhaust the
//! window and permanently disable recovery. A `reload_cooldown` additionally
//! deduplicates the burst of events a crash loop produces.
//!
//! ### Failure / escalation semantics
//!
//! - **Hard failures** — the main-thread callback cannot be scheduled or the
//!   `main` webview window no longer exists. A reload cannot succeed in place:
//!   these are exactly the "controls need to be recreated" states Microsoft
//!   describes, so they escalate to a controlled [`tauri::AppHandle::request_restart`]
//!   (which runs `AppState::shutdown` and restores persisted state).
//! - **`window.reload()` error** — the webview is present and the page can be
//!   retried, so the first failures are logged and retried on the next
//!   `ProcessFailed` event; only after
//!   [`RELOAD_EXECUTION_ESCALATION_THRESHOLD`] consecutive reload errors does
//!   DBX escalate to a controlled restart rather than looping forever.
//! - A successful reload resets the consecutive-failure counter.
//!
//! ## Session-task cancellation on reload
//!
//! Before reloading, DBX cancels the tasks whose frontend consumer lives in
//! the (now-dying) renderer session via
//! `AppState::cancel_webview_reload_session_tasks` — currently every task
//! registered in `RunningQueries` (SQL execution, counts/explains and exports).
//! Connection pools, tunnels, transaction sessions and daemons are
//! application-scoped and are intentionally preserved across a renderer reload.
//!
//! ## Production visibility
//!
//! Every decision and execution outcome is appended to `webview2-recovery.log`
//! next to `startup.log` via
//! [`crate::startup_recovery::record_runtime_recovery_event`]. That file is
//! not gated by the `debug_logging_enabled` setting (which turns the whole
//! `log` facade off in packaged builds), so fatal / exhausted / restart
//! decisions are always observable on affected Windows devices. The `log`
//! facade and `eprintln!` are used on top in debug builds.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use wry::{WebView2ProcessFailedInfo, WebView2ProcessFailedKind};

/// Consecutive `window.reload()` execution errors tolerated before DBX
/// escalates a wedged renderer to a controlled application restart.
const RELOAD_EXECUTION_ESCALATION_THRESHOLD: u32 = 3;

/// What the application should do in response to a WebView2 process failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecoveryAction {
    /// Reload the main webview (bounded by the rolling budget).
    Reload,
    /// Restart the whole application through the normal close flow.
    Restart,
    /// No destructive action; the event is still logged.
    LogOnly,
}

/// Why an event produced its action; used for diagnostics and tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecoveryDetail {
    /// The browser process exited (fatal; every control is closed).
    BrowserProcessExited,
    /// The main renderer exited; confirmed death -> bounded reload.
    RendererProcessExited,
    /// Renderer unresponsive but not yet at the threshold; only armed.
    RendererUnresponsiveArmed { count: u32, threshold: u32 },
    /// Renderer unresponsive and the threshold was reached -> reload.
    RendererUnresponsiveTriggered { count: u32, threshold: u32 },
    /// The GPU process exited; WebView2 restarts it on its own.
    GpuProcessExited,
    /// A subframe renderer exited; a whole-SPA reload is not warranted.
    FrameRendererProcessExited,
    /// A utility or other process exited; no destructive recovery.
    OtherProcessExited,
    /// A reload was requested inside the cooldown window; skipped.
    ReloadThrottled,
    /// The rolling reload budget is exhausted; auto-recovery stops.
    ReloadBudgetExhausted { reloads: u32, window_secs: u64 },
}

/// Result of the pure budget-eligibility check; never mutates recovery state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReloadEligibility {
    /// The reload is allowed; the budget is *not* consumed by this decision.
    Allowed,
    /// The last successful reload is still inside the cooldown window.
    Cooldown,
    /// The rolling window is already full of successful reloads.
    BudgetExhausted,
}

/// At which stage a reload execution attempt failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReloadExecError {
    /// `AppHandle::run_on_main_thread` returned an error (event loop down).
    ScheduleMainThread,
    /// The `main` webview window no longer exists (controls are gone).
    MainWindowNotFound,
    /// `window.reload()` returned an error.
    ReloadError,
}

/// What the recovery layer does after a reload execution attempt. Pure policy
/// output; the Tauri glue in [`install`] logs it and performs any escalation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReloadDisposition {
    /// Reload succeeded and the rolling recovery budget was committed.
    Committed,
    /// Reload failed; budget untouched; retried on the next `ProcessFailed`.
    RetryNext,
    /// Reload cannot recover in place; escalate to a controlled app restart.
    EscalateRestart,
}

/// Tunable constants of the recovery policy.
///
/// Every field has a documented policy purpose; they are kept as plain fields
/// (with [`Default`]) so tests can exercise boundary values directly. Durations
/// are measured against the monotonic [`Instant`] clock, so a system wall-clock
/// rollback cannot distort cooldown or budget windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WebView2RecoveryPolicy {
    /// Minimum gap between two *successful* automatic reloads. Absorbs the
    /// burst of `ProcessFailed` events a crash loop produces so a single
    /// failure is not answered with a reload storm.
    pub reload_cooldown: Duration,
    /// Rolling window for the reload budget: reloads older than this stop
    /// counting, so a long healthy period resets the budget and unrelated
    /// failures hours apart never permanently disable recovery.
    pub reload_window: Duration,
    /// Maximum successful automatic reloads allowed inside [`Self::reload_window`].
    /// Once the window is full, auto-recovery stops and the app relies on the
    /// user (the failure is logged; on Windows the recovery log records it).
    pub max_reloads_in_window: u32,
    /// Rolling window for renderer-unresponsive events.
    pub unresponsive_window: Duration,
    /// Renderer-unresponsive events inside [`Self::unresponsive_window`] that
    /// trigger a reload. The first event never reloads (the renderer may
    /// recover on its own); reaching this count means the renderer is
    /// effectively wedged.
    pub unresponsive_threshold: u32,
}

impl Default for WebView2RecoveryPolicy {
    fn default() -> Self {
        Self {
            reload_cooldown: Duration::from_secs(30),
            reload_window: Duration::from_secs(10 * 60),
            max_reloads_in_window: 3,
            unresponsive_window: Duration::from_secs(60),
            unresponsive_threshold: 3,
        }
    }
}

/// Deterministic recovery state machine. Owns nothing but counters and
/// monotonic timestamps, so it can be driven with synthetic event streams in
/// tests using `Instant::now()` offsets (no sleeping, no wall clock).
struct WebView2Recovery {
    policy: WebView2RecoveryPolicy,
    /// [`Instant`] of each *successfully committed* reload inside the rolling
    /// window.
    reload_timestamps: VecDeque<Instant>,
    /// [`Instant`] of the last successful automatic reload; `None` = never.
    last_reload_at: Option<Instant>,
    /// Start of the current unresponsive counting window.
    unresponsive_window_start: Option<Instant>,
    /// Renderer-unresponsive events observed inside the current window.
    unresponsive_count: u32,
    /// Whether a browser-process-exit restart was already requested for this
    /// process. Guards against a second event double-restarting.
    browser_fatal_fired: bool,
    /// Consecutive `window.reload()` execution failures that were not yet
    /// followed by a successful reload.
    consecutive_reload_execution_failures: u32,
}

impl WebView2Recovery {
    fn new(policy: WebView2RecoveryPolicy) -> Self {
        Self {
            policy,
            reload_timestamps: VecDeque::new(),
            last_reload_at: None,
            unresponsive_window_start: None,
            unresponsive_count: 0,
            browser_fatal_fired: false,
            consecutive_reload_execution_failures: 0,
        }
    }

    /// Decides the recovery action for one `ProcessFailed` event.
    ///
    /// `now` is a monotonic [`Instant`] (injected for tests). A returned
    /// `Reload` action is a *decision* only — it does **not** consume the
    /// budget; the budget is committed later via [`Self::record_reload_success`]
    /// once the reload is confirmed to have succeeded.
    fn handle_process_failed(
        &mut self,
        info: &WebView2ProcessFailedInfo,
        now: Instant,
    ) -> (RecoveryAction, RecoveryDetail) {
        match info.kind {
            WebView2ProcessFailedKind::Browser => {
                if self.browser_fatal_fired {
                    (RecoveryAction::LogOnly, RecoveryDetail::BrowserProcessExited)
                } else {
                    self.browser_fatal_fired = true;
                    (RecoveryAction::Restart, RecoveryDetail::BrowserProcessExited)
                }
            }
            WebView2ProcessFailedKind::Renderer => self.renderer_recovery(now, RecoveryDetail::RendererProcessExited),
            WebView2ProcessFailedKind::RendererUnresponsive => {
                let window = self.policy.unresponsive_window;
                let window_expired = self
                    .unresponsive_window_start
                    .map(|start| now.checked_duration_since(start).is_some_and(|elapsed| elapsed >= window))
                    .unwrap_or(true);
                if window_expired {
                    self.unresponsive_window_start = Some(now);
                    self.unresponsive_count = 0;
                }
                self.unresponsive_count += 1;
                let count = self.unresponsive_count;
                if count >= self.policy.unresponsive_threshold {
                    // Reset so post-reload evaluation starts fresh; the rolling
                    // budget still bounds a wedged-renderer crash loop.
                    self.unresponsive_count = 0;
                    self.renderer_recovery(
                        now,
                        RecoveryDetail::RendererUnresponsiveTriggered {
                            count,
                            threshold: self.policy.unresponsive_threshold,
                        },
                    )
                } else {
                    (
                        RecoveryAction::LogOnly,
                        RecoveryDetail::RendererUnresponsiveArmed {
                            count,
                            threshold: self.policy.unresponsive_threshold,
                        },
                    )
                }
            }
            // WebView2 restarts the GPU process on its own; do not reload the SPA.
            WebView2ProcessFailedKind::Gpu => (RecoveryAction::LogOnly, RecoveryDetail::GpuProcessExited),
            // A subframe renderer exit only needs the affected frame; reloading the
            // whole SPA would discard unsaved SQL / editor state.
            WebView2ProcessFailedKind::FrameRenderer => {
                (RecoveryAction::LogOnly, RecoveryDetail::FrameRendererProcessExited)
            }
            _ => (RecoveryAction::LogOnly, RecoveryDetail::OtherProcessExited),
        }
    }

    /// Shared renderer recovery decision: allow the reload only if the pure
    /// eligibility check passes, without consuming the budget.
    fn renderer_recovery(&mut self, now: Instant, detail: RecoveryDetail) -> (RecoveryAction, RecoveryDetail) {
        match self.can_reload(now) {
            ReloadEligibility::Allowed => (RecoveryAction::Reload, detail),
            ReloadEligibility::Cooldown => (RecoveryAction::LogOnly, RecoveryDetail::ReloadThrottled),
            ReloadEligibility::BudgetExhausted => (
                RecoveryAction::LogOnly,
                RecoveryDetail::ReloadBudgetExhausted {
                    reloads: self.reload_timestamps.len() as u32,
                    window_secs: self.policy.reload_window.as_secs(),
                },
            ),
        }
    }

    /// Pure eligibility check. Returns whether a reload may be *attempted* at
    /// `now` without mutating any state, so the budget survive a later
    /// execution failure.
    fn can_reload(&self, now: Instant) -> ReloadEligibility {
        if let Some(last) = self.last_reload_at {
            if now.checked_duration_since(last).is_none_or(|elapsed| elapsed < self.policy.reload_cooldown) {
                return ReloadEligibility::Cooldown;
            }
        }
        let active = self
            .reload_timestamps
            .iter()
            .filter(|ts| now.checked_duration_since(**ts).is_none_or(|elapsed| elapsed < self.policy.reload_window))
            .count();
        if active >= self.policy.max_reloads_in_window as usize {
            return ReloadEligibility::BudgetExhausted;
        }
        ReloadEligibility::Allowed
    }

    /// Commits one successful reload into the rolling budget. Only call this
    /// after the reload is confirmed to have succeeded (see
    /// [`settle_reload_execution`]); a failure must not reach this method.
    fn record_reload_success(&mut self, now: Instant) {
        // Drop successful reloads that rolled out of the window: a long healthy
        // period resets the budget and unrelated failures hours apart never
        // permanently disable recovery.
        while let Some(&ts) = self.reload_timestamps.front() {
            if now.checked_duration_since(ts).is_some_and(|elapsed| elapsed >= self.policy.reload_window) {
                self.reload_timestamps.pop_front();
            } else {
                break;
            }
        }
        self.reload_timestamps.push_back(now);
        self.last_reload_at = Some(now);
        self.consecutive_reload_execution_failures = 0;
    }

    /// Records one reload execution failure and reports whether a controlled
    /// restart should be escalated to. Successful reloads reset the counter.
    fn record_reload_execution_failure(&mut self) -> bool {
        self.consecutive_reload_execution_failures += 1;
        self.consecutive_reload_execution_failures >= RELOAD_EXECUTION_ESCALATION_THRESHOLD
    }

    /// `(active_successful_reloads, max_reloads)` for the production-visible
    /// execution diagnostics (recorded by the Windows `record_execution_outcome`).
    #[cfg(target_os = "windows")]
    fn reload_budget_state(&self, now: Instant) -> (u32, u32) {
        let active = self
            .reload_timestamps
            .iter()
            .filter(|ts| now.checked_duration_since(**ts).is_none_or(|elapsed| elapsed < self.policy.reload_window))
            .count();
        (active as u32, self.policy.max_reloads_in_window)
    }
}

/// Settles a reload execution attempt against the recovery policy.
///
/// `Ok(())` means the reload was confirmed to have succeeded, so the rolling
/// budget is committed exactly once. A failure is never counted as success:
/// hard failures (event loop down / main window gone) escalate immediately to
/// a controlled restart, while a `window.reload()` error is retried on the
/// next event and escalates only after
/// [`RELOAD_EXECUTION_ESCALATION_THRESHOLD`] consecutive failures.
///
/// This is pure (no Tauri types) so the state transitions are unit-testable;
/// production's `install` is a thin shell around it.
fn settle_reload_execution(
    recovery: &Mutex<WebView2Recovery>,
    now: Instant,
    error: Option<ReloadExecError>,
) -> ReloadDisposition {
    let mut recovery = recovery.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match error {
        None => {
            recovery.record_reload_success(now);
            ReloadDisposition::Committed
        }
        Some(ReloadExecError::ScheduleMainThread | ReloadExecError::MainWindowNotFound) => {
            // The event loop is down or the main control is gone: a reload
            // cannot succeed in place. Recreate the webview by restarting the
            // application through the normal close flow (persisted state is
            // preserved and running tasks are cancelled by `AppState::shutdown`).
            ReloadDisposition::EscalateRestart
        }
        Some(ReloadExecError::ReloadError) => {
            if recovery.record_reload_execution_failure() {
                ReloadDisposition::EscalateRestart
            } else {
                ReloadDisposition::RetryNext
            }
        }
    }
}

fn recovery_log_message(action: RecoveryAction, detail: RecoveryDetail, info: &WebView2ProcessFailedInfo) -> String {
    format!(
        "recovery decision={action:?} detail={detail:?} kind={:?} reason={} exit_code={} process={} frames={}",
        info.kind,
        info.reason.as_deref().unwrap_or("-"),
        info.exit_code.map(|code| code.to_string()).unwrap_or_else(|| "-".to_string()),
        info.process_description.as_deref().unwrap_or("-"),
        info.affected_frames,
    )
}

/// Session-task cancellation diagnostic line (pure; recorded by Windows install).
fn cancel_session_log_message(kind: WebView2ProcessFailedKind, cancelled: Option<usize>) -> String {
    match cancelled {
        Some(count) => format!(
            "recovery decision=Reload kind={kind:?} execution=cancel-session-tasks result=ok cancelled={count}"
        ),
        None => format!(
            "recovery decision=Reload kind={kind:?} execution=cancel-session-tasks result=failed error=app_state_missing"
        ),
    }
}

/// Reload execution outcome diagnostic line (pure; recorded by Windows install).
fn reload_execution_log_message(
    info: &WebView2ProcessFailedInfo,
    error: Option<ReloadExecError>,
    disposition: ReloadDisposition,
    budget_active: u32,
    budget_max: u32,
) -> String {
    let stage = match error {
        None => "window-reload",
        Some(ReloadExecError::ScheduleMainThread) => "schedule-main-thread",
        Some(ReloadExecError::MainWindowNotFound) => "find-main-window",
        Some(ReloadExecError::ReloadError) => "window-reload",
    };
    let result = if error.is_none() { "success" } else { "failed" };
    let budget_commit = matches!(disposition, ReloadDisposition::Committed);
    let escalate = matches!(disposition, ReloadDisposition::EscalateRestart);
    let failure = error.map(|error| format!("{error:?}")).unwrap_or_else(|| "-".to_string());
    format!(
        "recovery decision=Reload kind={:?} execution={stage} result={result} error={} budget_commit={budget_commit} budget={budget_active}/{budget_max} escalate={escalate}",
        info.kind,
        failure,
    )
}

/// Installs the WebView2 process-failure handler for this application.
///
/// Must be called once during Tauri setup on Windows. The callback receives
/// every `ProcessFailed` event from the (single) main webview, applies the
/// recovery policy, records a production-visible log line, and executes the
/// action:
///
/// - `Restart` → [`tauri::AppHandle::request_restart`], which runs the normal
///   close flow (`RunEvent::ExitRequested` → [`AppState::shutdown`] cancels
///   running queries and closes pools/tunnels) before Tauri respawns the
///   process. Persisted state (open tabs incl. unsaved SQL, window geometry,
///   saved SQL library) survives the restart.
/// - `Reload` → cancels the webview-session tasks (`AppState::cancel_webview_reload_session_tasks`),
///   then reloads the `main` webview on the main thread. The rolling budget is
///   committed only after the reload is confirmed to have succeeded.
/// - `LogOnly` → nothing but the log line.
#[cfg(target_os = "windows")]
pub fn install(app: &tauri::AppHandle) {
    use std::sync::{Arc, LazyLock};

    use wry::WebView2ProcessFailedCallback;

    static RECOVERY: LazyLock<Mutex<WebView2Recovery>> =
        LazyLock::new(|| Mutex::new(WebView2Recovery::new(WebView2RecoveryPolicy::default())));

    let app = app.clone();
    let callback: WebView2ProcessFailedCallback = Arc::new(move |info: &WebView2ProcessFailedInfo| {
        let now = Instant::now();
        let (action, detail) = {
            let mut recovery = RECOVERY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            recovery.handle_process_failed(info, now)
        };
        let message = recovery_log_message(action, detail, info);
        crate::startup_recovery::record_runtime_recovery_event(&message);
        log::error!("{message}");
        eprintln!("{message}");
        match action {
            RecoveryAction::Restart => {
                // Full close flow: `ExitRequested` runs `AppState::shutdown` (cancels
                // running queries, closes pools/tunnels/daemons) before Tauri
                // respawns the process, so the restart is not a raw kill.
                app.request_restart();
            }
            RecoveryAction::Reload => {
                let recovery: &'static Mutex<WebView2Recovery> = &RECOVERY;
                perform_reload_recovery(&app, recovery, now, info);
            }
            RecoveryAction::LogOnly => {}
        }
    });
    wry::set_webview2_process_failed_callback(Some(callback));
}

/// Executes a renderer recovery reload: cancels the webview-session tasks,
/// schedules the reload on the main thread, and settles the result against the
/// budget (commit-on-success / retry / escalate).
#[cfg(target_os = "windows")]
fn perform_reload_recovery(
    app: &tauri::AppHandle,
    recovery: &'static Mutex<WebView2Recovery>,
    now: Instant,
    info: &WebView2ProcessFailedInfo,
) {
    use crate::commands::connection::AppState;
    use std::sync::Arc;
    use tauri::Manager;

    // 1. Cancel the webview-session tasks before reloading, so no SQL keeps
    //    running for a consumer that is about to disappear. Cancellation
    //    outcome is always logged; a missing AppState is recorded rather than
    //    silently reloading, but does not abort the reload (reloading is still
    //    the least-destructive recovery available).
    let session_cancel =
        app.try_state::<Arc<AppState>>().map(|state| state.inner().cancel_webview_reload_session_tasks());
    let cancel_line = cancel_session_log_message(info.kind, session_cancel);
    crate::startup_recovery::record_runtime_recovery_event(&cancel_line);
    log::info!("{cancel_line}");

    // 2. Schedule the actual reload on the main thread. Only the main-thread
    //    closure can confirm the reload outcome, so budget commit happens there.
    let reload_app = app.clone();
    let info_for_thread = info.clone();
    let schedule = app.run_on_main_thread(move || {
        let execute_now = Instant::now();
        let Some(window) = reload_app.get_webview_window("main") else {
            let error = Some(ReloadExecError::MainWindowNotFound);
            let disposition = settle_reload_execution(recovery, execute_now, error);
            record_execution_outcome(&info_for_thread, recovery, execute_now, error, disposition);
            escalate_if_needed(&reload_app, disposition);
            return;
        };
        let error = match window.reload() {
            Ok(()) => None,
            Err(reload_error) => {
                log::warn!("webview2 recovery: window.reload() failed: {reload_error}");
                Some(ReloadExecError::ReloadError)
            }
        };
        let disposition = settle_reload_execution(recovery, execute_now, error);
        record_execution_outcome(&info_for_thread, recovery, execute_now, error, disposition);
        escalate_if_needed(&reload_app, disposition);
    });
    if let Err(schedule_error) = schedule {
        log::error!("webview2 recovery: failed to schedule main-thread reload: {schedule_error}");
        let error = Some(ReloadExecError::ScheduleMainThread);
        let disposition = settle_reload_execution(recovery, now, error);
        record_execution_outcome(info, recovery, now, error, disposition);
        escalate_if_needed(app, disposition);
    }
}

/// Logs a reload execution outcome to the production-visible recovery log and
/// the `log` facade.
#[cfg(target_os = "windows")]
fn record_execution_outcome(
    info: &WebView2ProcessFailedInfo,
    recovery: &Mutex<WebView2Recovery>,
    now: Instant,
    error: Option<ReloadExecError>,
    disposition: ReloadDisposition,
) {
    let (budget_active, budget_max) = {
        let recovery = recovery.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        recovery.reload_budget_state(now)
    };
    let line = reload_execution_log_message(info, error, disposition, budget_active, budget_max);
    crate::startup_recovery::record_runtime_recovery_event(&line);
    log::info!("{line}");
}

/// Performs a controlled application restart when a reload execution has been
/// escalated. Records it first so the escalation is observable on the device.
#[cfg(target_os = "windows")]
fn escalate_if_needed(app: &tauri::AppHandle, disposition: ReloadDisposition) {
    if matches!(disposition, ReloadDisposition::EscalateRestart) {
        let line = "recovery decision=Reload escalation=restart reason=renderer_reload_cannot_recover_in_place";
        crate::startup_recovery::record_runtime_recovery_event(line);
        log::error!("{line}");
        app.request_restart();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_with(
        reload_cooldown: Duration,
        reload_window: Duration,
        max_reloads: u32,
        unresponsive_window: Duration,
        unresponsive_threshold: u32,
    ) -> WebView2RecoveryPolicy {
        WebView2RecoveryPolicy {
            reload_cooldown,
            reload_window,
            max_reloads_in_window: max_reloads,
            unresponsive_window,
            unresponsive_threshold,
        }
    }

    fn info(kind: WebView2ProcessFailedKind) -> WebView2ProcessFailedInfo {
        WebView2ProcessFailedInfo { kind, reason: None, exit_code: None, process_description: None, affected_frames: 0 }
    }

    fn base() -> Instant {
        Instant::now()
    }

    fn at(base: Instant, secs: u64) -> Instant {
        base + Duration::from_secs(secs)
    }

    fn mutex(recovery: WebView2Recovery) -> Mutex<WebView2Recovery> {
        Mutex::new(recovery)
    }

    // ------------------------------------------------------------------
    // Kind policy
    // ------------------------------------------------------------------

    #[test]
    fn browser_process_exit_requests_a_restart() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        assert_eq!(
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Browser), base()),
            (RecoveryAction::Restart, RecoveryDetail::BrowserProcessExited)
        );
    }

    #[test]
    fn browser_process_exit_never_restarts_twice() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        let t0 = base();
        assert_eq!(
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Browser), t0).0,
            RecoveryAction::Restart
        );
        assert_eq!(
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Browser), at(t0, 1)).0,
            RecoveryAction::LogOnly
        );
    }

    #[test]
    fn renderer_exit_decides_reload_without_consuming_budget() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        let t0 = base();
        // The decision alone must not consume the budget: after deciding Reload,
        // a second immediate decision is still allowed (only a committed success
        // enters the cooldown/budget).
        assert_eq!(
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), t0),
            (RecoveryAction::Reload, RecoveryDetail::RendererProcessExited)
        );
        assert!(recovery.reload_timestamps.is_empty());
        assert_eq!(recovery.can_reload(t0), ReloadEligibility::Allowed);
    }

    #[test]
    fn first_unresponsive_event_never_reloads() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        let (action, detail) =
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), base());
        assert_eq!(action, RecoveryAction::LogOnly);
        assert_eq!(detail, RecoveryDetail::RendererUnresponsiveArmed { count: 1, threshold: 3 });
    }

    #[test]
    fn unresponsive_reloads_only_after_the_threshold() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        let t0 = base();
        for (offset, expected_count) in [(0u64, 1u32), (20, 2)] {
            let (action, detail) =
                recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), at(t0, offset));
            assert_eq!(action, RecoveryAction::LogOnly);
            assert_eq!(detail, RecoveryDetail::RendererUnresponsiveArmed { count: expected_count, threshold: 3 });
        }
        let (action, detail) =
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), at(t0, 40));
        assert_eq!(action, RecoveryAction::Reload);
        assert_eq!(detail, RecoveryDetail::RendererUnresponsiveTriggered { count: 3, threshold: 3 });
        let (action, detail) =
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), at(t0, 50));
        assert_eq!(action, RecoveryAction::LogOnly);
        assert_eq!(detail, RecoveryDetail::RendererUnresponsiveArmed { count: 1, threshold: 3 });
    }

    #[test]
    fn unresponsive_counter_expires_with_the_window() {
        let mut recovery = WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            3,
            Duration::from_secs(60),
            3,
        ));
        let t0 = base();
        recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), t0);
        recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), at(t0, 20));
        let (action, detail) =
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), at(t0, 120));
        assert_eq!(action, RecoveryAction::LogOnly);
        assert_eq!(detail, RecoveryDetail::RendererUnresponsiveArmed { count: 1, threshold: 3 });
    }

    #[test]
    fn gpu_exit_never_reloads() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        let (action, detail) = recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Gpu), base());
        assert_eq!(action, RecoveryAction::LogOnly);
        assert_eq!(detail, RecoveryDetail::GpuProcessExited);
    }

    #[test]
    fn frame_renderer_exit_never_reloads_the_whole_webview() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        let (action, detail) = recovery.handle_process_failed(&info(WebView2ProcessFailedKind::FrameRenderer), base());
        assert_eq!(action, RecoveryAction::LogOnly);
        assert_eq!(detail, RecoveryDetail::FrameRendererProcessExited);
    }

    #[test]
    fn utility_and_unknown_exits_only_log() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        for kind in [
            WebView2ProcessFailedKind::Utility,
            WebView2ProcessFailedKind::SandboxHelper,
            WebView2ProcessFailedKind::PpapiPlugin,
            WebView2ProcessFailedKind::PpapiBroker,
            WebView2ProcessFailedKind::Unknown,
        ] {
            let (action, detail) = recovery.handle_process_failed(&info(kind), base());
            assert_eq!(action, RecoveryAction::LogOnly, "{kind:?}");
            assert_eq!(detail, RecoveryDetail::OtherProcessExited, "{kind:?}");
        }
    }

    // ------------------------------------------------------------------
    // Budget commit-on-success semantics
    // ------------------------------------------------------------------

    #[test]
    fn success_commits_budget_and_exhausts_after_three() {
        let mut recovery = WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            3,
            Duration::from_secs(60),
            3,
        ));
        let t0 = base();
        for offset in [0u64, 60, 120] {
            let now = at(t0, offset);
            assert_eq!(recovery.can_reload(now), ReloadEligibility::Allowed, "offset {offset}");
            recovery.record_reload_success(now);
        }
        assert_eq!(recovery.can_reload(at(t0, 180)), ReloadEligibility::BudgetExhausted);
    }

    #[test]
    fn failed_reload_does_not_consume_budget() {
        let recovery = mutex(WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            3,
            Duration::from_secs(60),
            3,
        )));
        let t0 = base();
        // A reload error is retried, never committed.
        assert_eq!(
            settle_reload_execution(&recovery, t0, Some(ReloadExecError::ReloadError)),
            ReloadDisposition::RetryNext
        );
        let inner = recovery.lock().unwrap();
        assert!(inner.reload_timestamps.is_empty());
        assert_eq!(inner.can_reload(t0), ReloadEligibility::Allowed);
    }

    #[test]
    fn two_success_and_one_failure_leaves_one_slot() {
        let mut recovery = WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            3,
            Duration::from_secs(60),
            3,
        ));
        let t0 = base();
        for offset in [0u64, 60] {
            recovery.record_reload_success(at(t0, offset));
        }
        // A failed reload must not fill the third slot ...
        let recovery = mutex(recovery);
        assert_eq!(
            settle_reload_execution(&recovery, at(t0, 120), Some(ReloadExecError::ReloadError)),
            ReloadDisposition::RetryNext
        );
        // ... so it is still eligible here (the failure consumed no budget).
        // Note: each `lock().method()` uses a temporary guard dropped at the
        // end of its statement, so no guard is held across a re-lock (which
        // would deadlock).
        assert_eq!(recovery.lock().unwrap().can_reload(at(t0, 120)), ReloadEligibility::Allowed);
        // ... and a subsequent success still fits in the third slot.
        recovery.lock().unwrap().record_reload_success(at(t0, 180));
        assert_eq!(recovery.lock().unwrap().can_reload(at(t0, 240)), ReloadEligibility::BudgetExhausted);
    }

    #[test]
    fn cooldown_is_based_on_successful_reloads_only() {
        let recovery = mutex(WebView2Recovery::new(WebView2RecoveryPolicy::default()));
        let t0 = base();
        // A failed reload neither commits nor starts a cooldown.
        assert_eq!(
            settle_reload_execution(&recovery, t0, Some(ReloadExecError::ReloadError)),
            ReloadDisposition::RetryNext
        );
        let mut inner = recovery.lock().unwrap();
        assert_eq!(inner.can_reload(t0), ReloadEligibility::Allowed);
        assert_eq!(inner.last_reload_at, None);

        // A successful reload starts the 30s cooldown.
        inner.record_reload_success(t0);
        assert_eq!(inner.can_reload(at(t0, 10)), ReloadEligibility::Cooldown);
        assert_eq!(inner.can_reload(at(t0, 31)), ReloadEligibility::Allowed);
    }

    // ------------------------------------------------------------------
    // Monotonic time / rolling window
    // ------------------------------------------------------------------

    #[test]
    fn budget_expires_after_the_rolling_window() {
        let mut recovery = WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            3,
            Duration::from_secs(60),
            3,
        ));
        let t0 = base();
        for offset in [0u64, 60, 120] {
            recovery.record_reload_success(at(t0, offset));
        }
        // Just inside the window the budget is still exhausted...
        assert_eq!(recovery.can_reload(at(t0, 179)), ReloadEligibility::BudgetExhausted);
        // ... and once the oldest reload falls out of the rolling window one
        // slot frees up again (a long healthy period resets the budget).
        assert_eq!(recovery.can_reload(at(t0, 600 + 1)), ReloadEligibility::Allowed);
    }

    #[test]
    fn unrelated_failures_hours_apart_do_not_deplete_the_lifetime_budget() {
        let recovery = mutex(WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            3,
            Duration::from_secs(60),
            3,
        )));
        let t0 = base();
        // One successful reload every hour: each is checked before the commit
        // (well past the 30s cooldown) and always eligible, so the budget is
        // never permanently consumed across the WebView lifetime.
        for hour in 0..10 {
            let now = at(t0, hour * 3600);
            assert_eq!(recovery.lock().unwrap().can_reload(now), ReloadEligibility::Allowed, "hour {hour}");
            assert_eq!(settle_reload_execution(&recovery, now, None), ReloadDisposition::Committed);
        }
    }

    #[test]
    fn unresponsive_threshold_window_now_uses_instant() {
        let recovery = mutex(WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            3,
            Duration::from_secs(60),
            3,
        )));
        let t0 = base();
        // Two armed events inside the 60s window...
        recovery.lock().unwrap().handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), t0);
        recovery
            .lock()
            .unwrap()
            .handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), at(t0, 20));
        // ... the window has not expired, so a third event triggers the reload.
        let (action, _) = recovery
            .lock()
            .unwrap()
            .handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), at(t0, 40));
        assert_eq!(action, RecoveryAction::Reload);
    }

    #[test]
    fn system_clock_does_not_drive_policy_state() {
        // Policy timestamps are `Instant` (monotonic). A wall-clock rollback
        // cannot shrink a `now.checked_duration_since(last)` elapsed value: the
        // policy reader only ever computes `now - earlier` on an `Instant`
        // timeline, which is strictly nondecreasing. This is a sanity guard that
        // the policy stores `Instant` values (never Unix wall-clock millis).
        let recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        let _: Option<Instant> = recovery.last_reload_at;
        let t0 = base();
        assert_eq!(t0.duration_since(t0), Duration::ZERO);
        assert!(at(t0, 5).checked_duration_since(t0).is_some());
    }

    // ------------------------------------------------------------------
    // Reload execution settling / escalation
    // ------------------------------------------------------------------

    #[test]
    fn reload_success_commits_exactly_once() {
        let recovery = mutex(WebView2Recovery::new(WebView2RecoveryPolicy::default()));
        let t0 = base();
        assert_eq!(settle_reload_execution(&recovery, t0, None), ReloadDisposition::Committed);
        assert_eq!(settle_reload_execution(&recovery, t0, None), ReloadDisposition::Committed);
        let inner = recovery.lock().unwrap();
        assert_eq!(inner.reload_timestamps.len(), 2);
        assert_eq!(inner.consecutive_reload_execution_failures, 0);
    }

    #[test]
    fn reload_error_is_retried_then_escalates_after_threshold() {
        let recovery = mutex(WebView2Recovery::new(WebView2RecoveryPolicy::default()));
        let t0 = base();
        // The first two `window.reload()` errors (failure counter 1, 2) are
        // retried on the next `ProcessFailed` event; the third consecutive
        // failure reaches `RELOAD_EXECUTION_ESCALATION_THRESHOLD` (3) and
        // escalates to a controlled restart.
        for offset in [0u64, 10] {
            assert_eq!(
                settle_reload_execution(&recovery, at(t0, offset), Some(ReloadExecError::ReloadError)),
                ReloadDisposition::RetryNext,
                "offset {offset} must retry before the threshold"
            );
        }
        assert_eq!(
            settle_reload_execution(&recovery, at(t0, 20), Some(ReloadExecError::ReloadError)),
            ReloadDisposition::EscalateRestart
        );
        // The counter keeps climbing, so a further error still escalates.
        assert_eq!(
            settle_reload_execution(&recovery, at(t0, 30), Some(ReloadExecError::ReloadError)),
            ReloadDisposition::EscalateRestart
        );
    }

    #[test]
    fn successful_reload_resets_the_failure_counter() {
        let recovery = mutex(WebView2Recovery::new(WebView2RecoveryPolicy::default()));
        let t0 = base();
        assert_eq!(
            settle_reload_execution(&recovery, t0, Some(ReloadExecError::ReloadError)),
            ReloadDisposition::RetryNext
        );
        // A success resets the counter, so the escalation threshold restarts.
        assert_eq!(settle_reload_execution(&recovery, at(t0, 40), None), ReloadDisposition::Committed);
        assert_eq!(
            settle_reload_execution(&recovery, at(t0, 50), Some(ReloadExecError::ReloadError)),
            ReloadDisposition::RetryNext
        );
        let inner = recovery.lock().unwrap();
        assert_eq!(inner.consecutive_reload_execution_failures, 1);
    }

    #[test]
    fn window_not_found_escalates_to_restart_without_committing() {
        let recovery = mutex(WebView2Recovery::new(WebView2RecoveryPolicy::default()));
        let t0 = base();
        assert_eq!(
            settle_reload_execution(&recovery, t0, Some(ReloadExecError::MainWindowNotFound)),
            ReloadDisposition::EscalateRestart
        );
        let inner = recovery.lock().unwrap();
        assert!(inner.reload_timestamps.is_empty());
    }

    #[test]
    fn schedule_main_thread_failure_escalates_to_restart() {
        let recovery = mutex(WebView2Recovery::new(WebView2RecoveryPolicy::default()));
        let t0 = base();
        assert_eq!(
            settle_reload_execution(&recovery, t0, Some(ReloadExecError::ScheduleMainThread)),
            ReloadDisposition::EscalateRestart
        );
    }

    #[test]
    fn repeated_hard_failures_never_commit_budget() {
        let recovery = mutex(WebView2Recovery::new(WebView2RecoveryPolicy::default()));
        let t0 = base();
        for offset in [0u64, 5, 10] {
            assert_eq!(
                settle_reload_execution(&recovery, at(t0, offset), Some(ReloadExecError::MainWindowNotFound)),
                ReloadDisposition::EscalateRestart
            );
        }
        let inner = recovery.lock().unwrap();
        assert!(inner.reload_timestamps.is_empty());
    }

    // ------------------------------------------------------------------
    // Logging
    // ------------------------------------------------------------------

    #[test]
    fn recovery_log_message_includes_kind_and_action() {
        let mut made = info(WebView2ProcessFailedKind::Renderer);
        made.reason = Some("crashed".to_string());
        made.exit_code = Some(-1);
        made.process_description = Some("renderer".to_string());
        made.affected_frames = 2;
        let message = recovery_log_message(RecoveryAction::Reload, RecoveryDetail::RendererProcessExited, &made);
        assert!(message.contains("decision=Reload"));
        assert!(message.contains("detail=RendererProcessExited"));
        assert!(message.contains("kind=Renderer"));
        assert!(message.contains("reason=crashed"));
        assert!(message.contains("exit_code=-1"));
        assert!(message.contains("frames=2"));
    }

    #[test]
    fn cancel_session_log_reflects_missing_state() {
        assert!(cancel_session_log_message(WebView2ProcessFailedKind::Renderer, None).contains("result=failed"));
        let ok = cancel_session_log_message(WebView2ProcessFailedKind::Renderer, Some(3));
        assert!(ok.contains("result=ok"));
        assert!(ok.contains("cancelled=3"));
    }

    #[test]
    fn reload_execution_log_includes_stage_budget_and_escalation() {
        let made = info(WebView2ProcessFailedKind::Renderer);
        let committed = reload_execution_log_message(&made, None, ReloadDisposition::Committed, 1, 3);
        assert!(committed.contains("execution=window-reload"));
        assert!(committed.contains("result=success"));
        assert!(committed.contains("budget_commit=true"));
        assert!(committed.contains("budget=1/3"));
        assert!(committed.contains("escalate=false"));

        let failed = reload_execution_log_message(
            &made,
            Some(ReloadExecError::MainWindowNotFound),
            ReloadDisposition::EscalateRestart,
            0,
            3,
        );
        assert!(failed.contains("execution=find-main-window"));
        assert!(failed.contains("result=failed"));
        assert!(failed.contains("budget_commit=false"));
        assert!(failed.contains("escalate=true"));
        assert!(failed.contains("error=MainWindowNotFound"));
    }
}
