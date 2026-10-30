//! MongoDB shell scripts: `(function () { ... })()`, `var`, `forEach`, `.toArray()` and friends.
//!
//! The script runs in an embedded QuickJS runtime. A small mongo shell
//! compatibility layer (`mongo_script_prelude.js`) turns every `db.*` call into
//! mongo shell source text, which the host parses with
//! [`dbx_drivers::mongo_shell::parse`] and executes through the same safety checks as a
//! plain command. Documents travel as canonical Extended JSON both ways, so a
//! document read and written back keeps its BSON types.
//!
//! Scripts are untrusted input, so every resource is bounded on the server:
//! source size, concurrently running runtimes, rows and bytes per operation, output,
//! heap, stack and wall-clock time. Each host operation is checked against the
//! database it actually targets (`getSiblingDB`, `$out`/`$merge`), never against
//! a client-supplied production flag.
//!
//! The runtime is compiled only where `rquickjs` ships bindings; elsewhere
//! [`RUNTIME_AVAILABLE`] is false and scripts are refused.

use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use super::mongo_ops::{execute_mongo_script_command_core, mongo_documents_query_result, scalar_query_result};
use crate::connection::AppState;
use crate::models::connection::ConnectionConfig;
use crate::mongo_shell::{self, MongoCommand, MongoSafetyError};
use crate::production_safety::{is_production_database, mongo_pipeline_targets_production_database};
use crate::types::{QueryMessage, QueryResult};

/// Whether this build can run MongoDB scripts: the `mongo-script` feature on a target
/// `rquickjs` ships bindings for.
pub const RUNTIME_AVAILABLE: bool = runtime::AVAILABLE;

/// Server-side limits. Client options can only lower `max_rows` / `timeout`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MongoScriptLimits {
    pub max_source_bytes: usize,
    pub max_concurrent_scripts: usize,
    pub default_max_rows: usize,
    pub max_rows: usize,
    pub default_timeout: Duration,
    pub max_timeout: Duration,
    pub max_output_lines: usize,
    pub max_output_bytes: usize,
    /// Bytes of one host operation's reply, and of the script's final result.
    pub max_result_bytes: usize,
    pub memory_bytes: usize,
    pub js_stack_bytes: usize,
    pub thread_stack_bytes: usize,
}

pub const MONGO_SCRIPT_LIMITS: MongoScriptLimits = MongoScriptLimits {
    max_source_bytes: 256 * 1024,
    max_concurrent_scripts: 4,
    default_max_rows: 1000,
    max_rows: 10_000,
    default_timeout: Duration::from_secs(60),
    max_timeout: Duration::from_secs(600),
    max_output_lines: 10_000,
    max_output_bytes: 4 * 1024 * 1024,
    max_result_bytes: 16 * 1024 * 1024,
    memory_bytes: 256 * 1024 * 1024,
    js_stack_bytes: 1024 * 1024,
    // Host callbacks `block_on` the MongoDB driver futures on the script thread, which are
    // too deep for the default 2 MiB thread stack.
    thread_stack_bytes: 16 * 1024 * 1024,
};

/// What the client may ask for. Anything else (writes, dangerous operations,
/// production scope) is decided by the server.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MongoScriptOptions {
    pub max_rows: Option<usize>,
    pub timeout_ms: Option<u64>,
    /// The user confirmed, in a dialog, that this script may write to production databases.
    /// Which operations are production writes is still decided per operation by the server.
    pub confirmed_production_writes: bool,
}

/// Options after clamping to [`MongoScriptLimits`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MongoScriptSettings {
    pub max_rows: usize,
    pub timeout: Duration,
}

impl MongoScriptSettings {
    pub fn resolve(options: &MongoScriptOptions, limits: &MongoScriptLimits) -> Self {
        let max_rows = options.max_rows.unwrap_or(limits.default_max_rows).clamp(1, limits.max_rows);
        let timeout = options
            .timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(limits.default_timeout)
            .clamp(Duration::from_millis(1), limits.max_timeout);
        Self { max_rows, timeout }
    }
}

/// Raw script outcome: the completion value (extended JSON) and `print` output.
#[derive(Debug, Clone, PartialEq)]
pub struct MongoScriptOutput {
    pub value: Option<Value>,
    pub output: Vec<String>,
    pub output_truncated: bool,
    /// A read made while rendering the completion value was cut to the row limit.
    pub value_truncated: bool,
    /// What the script's host operations did, also when it caught their errors itself.
    pub progress: MongoScriptProgress,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MongoScriptInterruption {
    Canceled,
    TimedOut,
}

/// Host operations the script has issued, so an interrupted or failed script can
/// say what was confirmed done and what may or may not have been applied.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MongoScriptProgress {
    pub completed: usize,
    pub completed_writes: usize,
    /// Writes that were interrupted or failed after being sent: their outcome is unknown.
    /// At most [`MAX_UNKNOWN_WRITES`] are kept; the rest are only counted.
    pub unknown_writes: Vec<String>,
    pub unknown_writes_dropped: usize,
}

pub const MAX_UNKNOWN_WRITES: usize = 20;

impl MongoScriptProgress {
    fn has_unknown_writes(&self) -> bool {
        !self.unknown_writes.is_empty() || self.unknown_writes_dropped > 0
    }
}

/// Shared between the caller, the script thread and the host operations.
pub struct MongoScriptControl {
    cancel: CancellationToken,
    timeout: Duration,
    deadline: Instant,
    progress: Mutex<MongoScriptProgress>,
}

impl MongoScriptControl {
    pub fn new(cancel: CancellationToken, timeout: Duration) -> Arc<Self> {
        Arc::new(Self { cancel, timeout, deadline: Instant::now() + timeout, progress: Mutex::default() })
    }

    pub fn cancel_token(&self) -> &CancellationToken {
        &self.cancel
    }

    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    pub fn interruption(&self) -> Option<MongoScriptInterruption> {
        if self.cancel.is_cancelled() {
            Some(MongoScriptInterruption::Canceled)
        } else if Instant::now() >= self.deadline {
            Some(MongoScriptInterruption::TimedOut)
        } else {
            None
        }
    }

    pub fn progress(&self) -> MongoScriptProgress {
        self.progress.lock().map(|progress| progress.clone()).unwrap_or_default()
    }

    fn interruption_message(&self, interruption: MongoScriptInterruption) -> String {
        match interruption {
            MongoScriptInterruption::Canceled => crate::query::canceled_error(),
            MongoScriptInterruption::TimedOut => {
                format!("MongoDB script timed out after {} ms.", self.timeout.as_millis())
            }
        }
    }
}

/// How a host operation ended, for [`MongoScriptProgress`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOutcome {
    /// Confirmed done by the server.
    Completed { write: bool },
    /// Refused before anything was sent (parse error, safety policy, interrupted).
    Rejected,
    /// A read that failed, or a write known not to have been applied.
    Failed,
    /// A write that was interrupted or failed after it may have reached the server.
    UnknownWrite,
}

/// Reply handed back to the JS layer: the host protocol of
/// [`execute_mongo_script_command_core`] or `{"error":".."}`, plus how the operation ended.
pub struct HostReply {
    pub body: String,
    pub outcome: HostOutcome,
}

impl HostReply {
    fn rejected(message: impl Into<String>) -> Self {
        Self { body: error_json(message), outcome: HostOutcome::Rejected }
    }
}

/// Executes one mongo shell command on behalf of the script. `display` is set while the
/// script's completion value is rendered: reads may then be cut to the row limit instead
/// of failing.
pub trait MongoScriptBackend: Send + Sync {
    fn exec(&self, shell_source: &str, display: bool, control: &MongoScriptControl) -> HostReply;
}

fn error_json(message: impl Into<String>) -> String {
    serde_json::json!({ "error": message.into() }).to_string()
}

/// Production scope of one host operation, judged on the database it actually targets.
/// An unknown connection fails closed.
fn targets_production(command: &MongoCommand, script_database: &str, config: Option<&ConnectionConfig>) -> bool {
    let Some(config) = config else { return true };
    let (database, command) = match command {
        MongoCommand::InDatabase { database, command } => (database.as_str(), command.as_ref()),
        command => (script_database, command),
    };
    match command {
        MongoCommand::Aggregate { pipeline, .. } => {
            mongo_pipeline_targets_production_database(config, database, pipeline)
        }
        _ => is_production_database(config, database),
    }
}

/// The safety gate every host operation passes before anything is sent to the server.
/// Dangerous operations (unbounded filters, drops, `runCommand`, `$out`/`$merge`) are never
/// allowed from a script, because there is no per-statement confirmation inside it.
pub fn host_operation_policy(
    command: &MongoCommand,
    script_database: &str,
    config: Option<&ConnectionConfig>,
    allow_writes: bool,
    confirmed_production_writes: bool,
) -> Result<(), MongoSafetyError> {
    let production_write = command.is_mutating() && targets_production(command, script_database, config);
    mongo_shell::validate_safety(command, allow_writes, false, production_write && !confirmed_production_writes)
}

/// Whether a failed write is known not to have been applied, so it is reported as a failure
/// instead of an unknown outcome. Only errors that prove nothing changed qualify: a local
/// refusal before sending, or a server rejection of a single-document write. Multi-document
/// writes, write concern errors and transport errors stay unknown.
pub fn write_error_was_rejected(command: &MongoCommand, message: &str) -> bool {
    let command = match command {
        MongoCommand::InDatabase { command, .. } => command.as_ref(),
        command => command,
    };
    if message.starts_with("Invalid ")
        || message.starts_with("Replacement document must not")
        || message.starts_with("MongoDB Legacy Agent does not support")
        || message == "Not found"
        || message == "Not a MongoDB connection"
    {
        return true;
    }
    if message.contains("WriteConcernError") || message.contains("write_concern_error: Some") {
        return false;
    }
    match command {
        // Inserts go through insert_many: nothing was inserted when no id is reported.
        MongoCommand::Insert { .. } => message.contains("InsertManyError") && message.contains("inserted_ids: {}"),
        MongoCommand::Update { many: false, .. }
        | MongoCommand::Delete { many: false, .. }
        | MongoCommand::Replace { .. }
        | MongoCommand::FindOneAndUpdate { .. }
        | MongoCommand::FindOneAndReplace { .. }
        | MongoCommand::FindOneAndDelete { .. } => {
            message.contains("WriteError(") || message.contains("Command failed")
        }
        _ => false,
    }
}

struct StateBackend {
    state: Arc<AppState>,
    connection_id: String,
    database: String,
    config: Option<ConnectionConfig>,
    allow_writes: bool,
    confirmed_production_writes: bool,
    max_rows: usize,
    max_reply_bytes: usize,
    handle: tokio::runtime::Handle,
}

impl MongoScriptBackend for StateBackend {
    fn exec(&self, shell_source: &str, display: bool, control: &MongoScriptControl) -> HostReply {
        let command = match mongo_shell::parse(shell_source) {
            Ok(command) => command,
            Err(message) => return HostReply::rejected(message),
        };
        if let Err(error) = host_operation_policy(
            &command,
            &self.database,
            self.config.as_ref(),
            self.allow_writes,
            self.confirmed_production_writes,
        ) {
            return HostReply::rejected(safety_message(&error));
        }
        let write = command.is_mutating();
        let operation = execute_mongo_script_command_core(
            &self.state,
            &self.connection_id,
            &self.database,
            &command,
            self.max_rows,
            display,
        );
        let deadline = tokio::time::Instant::from_std(control.deadline());
        let result = self.handle.block_on(async {
            tokio::select! {
                biased;
                _ = control.cancel_token().cancelled() => None,
                _ = tokio::time::sleep_until(deadline) => None,
                result = operation => Some(result),
            }
        });
        match result {
            Some(Ok(reply)) => bounded_reply(&reply, write, self.max_reply_bytes),
            Some(Err(message)) => {
                let outcome = if write && !write_error_was_rejected(&command, &message) {
                    HostOutcome::UnknownWrite
                } else {
                    HostOutcome::Failed
                };
                HostReply { body: error_json(message), outcome }
            }
            None => HostReply {
                body: error_json(
                    control.interruption_message(control.interruption().unwrap_or(MongoScriptInterruption::Canceled)),
                ),
                outcome: if write { HostOutcome::UnknownWrite } else { HostOutcome::Rejected },
            },
        }
    }
}

/// A completed operation's reply, unless it is too large to hand to the script. An oversized
/// write reply still counts as completed: the write itself was applied.
pub fn bounded_reply(reply: &Value, write: bool, max_reply_bytes: usize) -> HostReply {
    let body = reply.to_string();
    if body.len() <= max_reply_bytes {
        return HostReply { body, outcome: HostOutcome::Completed { write } };
    }
    HostReply {
        body: error_json(format!(
            "MongoDB script: the operation returned {} bytes, over the {} byte limit for one operation. Return fewer or smaller documents (projection, .limit()).",
            body.len(),
            max_reply_bytes
        )),
        outcome: if write { HostOutcome::Completed { write } } else { HostOutcome::Failed },
    }
}

fn safety_message(error: &MongoSafetyError) -> &'static str {
    match error {
        MongoSafetyError::WritesDisabled => "MongoDB script blocked: write operations are disabled for this connection.",
        MongoSafetyError::EmptyFilter => {
            "MongoDB script blocked: an update/delete uses an empty or unbounded filter. Run it as a separate command to confirm it."
        }
        MongoSafetyError::Dangerous => {
            "MongoDB script blocked: dangerous operations (drop, runCommand, $out/$merge, ...) must run as a separate command."
        }
        MongoSafetyError::ProductionWrite => {
            "MongoDB script blocked: this operation writes to a production database and the script was not confirmed for production writes."
        }
    }
}

/// Bounds how many script runtimes exist at once across the whole application.
pub struct MongoScriptAdmission {
    permits: Arc<Semaphore>,
}

impl MongoScriptAdmission {
    pub fn new(max_concurrent: usize) -> Self {
        Self { permits: Arc::new(Semaphore::new(max_concurrent.max(1))) }
    }

    pub fn available(&self) -> usize {
        self.permits.available_permits()
    }
}

static ADMISSION: LazyLock<MongoScriptAdmission> =
    LazyLock::new(|| MongoScriptAdmission::new(MONGO_SCRIPT_LIMITS.max_concurrent_scripts));

fn check_source_size(source: &str, limits: &MongoScriptLimits) -> Result<(), String> {
    if source.len() > limits.max_source_bytes {
        return Err(format!(
            "MongoDB script is too large: {} bytes (limit {} bytes).",
            source.len(),
            limits.max_source_bytes
        ));
    }
    Ok(())
}

/// Waits for a free runtime slot, then runs the script on its own thread. The slot is held
/// until the runtime is gone, so a canceled script cannot leave an extra runtime behind.
/// Waiting honors cancellation and the script deadline.
pub async fn run_admitted(
    admission: &MongoScriptAdmission,
    source: &str,
    backend: Arc<dyn MongoScriptBackend>,
    settings: MongoScriptSettings,
    control: Arc<MongoScriptControl>,
    limits: &MongoScriptLimits,
) -> Result<MongoScriptOutput, String> {
    check_source_size(source, limits)?;
    let deadline = tokio::time::Instant::from_std(control.deadline());
    let permit = tokio::select! {
        biased;
        _ = control.cancel_token().cancelled() => return Err(crate::query::canceled_error()),
        _ = tokio::time::sleep_until(deadline) => {
            return Err(format!(
                "MongoDB script timed out after {} ms while waiting for a free script slot ({} scripts may run at once).",
                settings.timeout.as_millis(),
                limits.max_concurrent_scripts
            ));
        }
        permit = admission.permits.clone().acquire_owned() => {
            permit.map_err(|_| "MongoDB script runtime is shutting down.".to_string())?
        }
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let source = source.to_string();
    let limits = *limits;
    std::thread::Builder::new()
        .name("mongo-script".into())
        .stack_size(limits.thread_stack_bytes)
        .spawn(move || {
            let result = run_script(&source, backend, settings, control, &limits);
            drop(permit);
            let _ = sender.send(result);
        })
        .map_err(|error| format!("MongoDB script thread failed to start: {error}"))?;
    receiver.await.map_err(|error| format!("MongoDB script task failed: {error}"))?
}

/// Runs a script against `state`'s MongoDB connection and renders the outcome as a result table.
///
/// `cancel` is the execution's cancellation token. Cancellation is handled here rather than by
/// dropping this future, so the error can report which operations completed before it.
pub async fn execute_mongo_script_core(
    state: Arc<AppState>,
    connection_id: &str,
    database: &str,
    source: &str,
    options: MongoScriptOptions,
    cancel: Option<CancellationToken>,
) -> Result<QueryResult, String> {
    let started = Instant::now();
    let limits = MONGO_SCRIPT_LIMITS;
    check_source_size(source, &limits)?;
    let settings = MongoScriptSettings::resolve(&options, &limits);
    let cancel = cancel.map(|token| token.child_token()).unwrap_or_default();
    // Dropping this future (client gone) also stops the runtime.
    let _stop_on_drop = cancel.clone().drop_guard();
    let config = state.configs.read().await.get(connection_id).cloned();
    let backend: Arc<dyn MongoScriptBackend> = Arc::new(StateBackend {
        allow_writes: super::connection_readonly_name(&state, connection_id).await.is_none(),
        state,
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        config,
        confirmed_production_writes: options.confirmed_production_writes,
        max_rows: settings.max_rows,
        max_reply_bytes: limits.max_result_bytes,
        handle: tokio::runtime::Handle::current(),
    });
    let control = MongoScriptControl::new(cancel, settings.timeout);
    let output = run_admitted(&ADMISSION, source, backend, settings, control, &limits).await?;
    let mut result = script_query_result(output, settings.max_rows);
    result.execution_time_ms = started.elapsed().as_millis();
    Ok(result)
}

/// Renders a script outcome: `print` lines win (shell-like), otherwise the completion value.
pub fn script_query_result(output: MongoScriptOutput, max_rows: usize) -> QueryResult {
    let messages = progress_messages(&output.progress);
    let mut result = render_output(output, max_rows);
    result.messages.extend(messages);
    result
}

/// Messages for a script that finished: the writes it made and those it caught failing with an
/// unknown outcome, which would otherwise go unreported.
pub fn progress_messages(progress: &MongoScriptProgress) -> Vec<QueryMessage> {
    let message = |severity: &str, code: &str, text: String| QueryMessage {
        severity: severity.to_string(),
        message: text,
        code: Some(code.to_string()),
        detail: None,
        hint: None,
    };
    let mut messages = Vec::new();
    if progress.completed_writes > 0 || progress.has_unknown_writes() {
        messages.push(message(
            "INFO",
            "MONGO_SCRIPT_WRITES",
            format!("Confirmed completed operations: {} ({} writes).", progress.completed, progress.completed_writes),
        ));
    }
    for label in &progress.unknown_writes {
        messages.push(message(
            "WARNING",
            "MONGO_SCRIPT_UNKNOWN_WRITE",
            format!("A failed write was caught by the script; its outcome is unknown: {label}"),
        ));
    }
    if progress.unknown_writes_dropped > 0 {
        messages.push(message(
            "WARNING",
            "MONGO_SCRIPT_UNKNOWN_WRITES_DROPPED",
            format!(
                "{} more failed writes were caught by the script; their outcome is unknown.",
                progress.unknown_writes_dropped
            ),
        ));
    }
    messages
}

fn render_output(output: MongoScriptOutput, max_rows: usize) -> QueryResult {
    let MongoScriptOutput { value, output, output_truncated, value_truncated, .. } = output;
    if !output.is_empty() {
        let mut lines = output;
        if let Some(value) = value.filter(|value| !value.is_null()) {
            lines.push(serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()));
        }
        let truncated = output_truncated || value_truncated || lines.len() > max_rows;
        let rows = lines.into_iter().take(max_rows).map(|line| vec![Value::String(line)]).collect::<Vec<_>>();
        let mut result = mongo_documents_query_result(Vec::new());
        result.columns = vec!["output".to_string()];
        result.rows = rows;
        result.truncated = truncated;
        return result;
    }
    let mut result = match value {
        None | Some(Value::Null) => mongo_documents_query_result(Vec::new()),
        Some(Value::Array(items)) => {
            let truncated = items.len() > max_rows;
            let mut result = mongo_documents_query_result(items.into_iter().take(max_rows).collect());
            result.truncated = truncated;
            result
        }
        Some(value @ Value::Object(_)) => mongo_documents_query_result(vec![value]),
        Some(value) => scalar_query_result("result", value),
    };
    result.truncated |= value_truncated;
    result
}

pub use runtime::run_script;

// The runtime is compiled only where rquickjs-sys ships bindings (Windows arm64 and the win7
// target have none). Keep this target list in sync with the `rquickjs` dependency in Cargo.toml.
#[cfg(not(all(
    feature = "mongo-script",
    any(
        all(target_os = "macos", any(target_arch = "x86_64", target_arch = "aarch64")),
        all(
            target_os = "linux",
            any(
                target_arch = "x86_64",
                target_arch = "aarch64",
                target_arch = "loongarch64",
                all(target_arch = "x86", target_env = "gnu")
            )
        ),
        all(target_os = "windows", target_arch = "x86_64", not(target_vendor = "win7"))
    )
)))]
mod runtime {
    use super::*;

    pub const AVAILABLE: bool = false;

    pub fn run_script(
        _source: &str,
        _backend: Arc<dyn MongoScriptBackend>,
        _settings: MongoScriptSettings,
        _control: Arc<MongoScriptControl>,
        _limits: &MongoScriptLimits,
    ) -> Result<MongoScriptOutput, String> {
        Err("MongoDB script execution is not available in this build.".to_string())
    }
}

#[cfg(all(
    feature = "mongo-script",
    any(
        all(target_os = "macos", any(target_arch = "x86_64", target_arch = "aarch64")),
        all(
            target_os = "linux",
            any(
                target_arch = "x86_64",
                target_arch = "aarch64",
                target_arch = "loongarch64",
                all(target_arch = "x86", target_env = "gnu")
            )
        ),
        all(target_os = "windows", target_arch = "x86_64", not(target_vendor = "win7"))
    )
))]
mod runtime {
    use super::*;
    use rquickjs::function::Opt;
    use rquickjs::{Context, Ctx, Exception, Function, Module, Runtime, Value as JsValue};

    pub const AVAILABLE: bool = true;

    const PRELUDE: &str = include_str!("mongo_script_prelude.js");
    /// Module name of the compatibility layer, so its frames can be told from the user's.
    const PRELUDE_NAME: &str = "dbx-prelude";

    fn record(control: &MongoScriptControl, outcome: &HostOutcome, label: &str) {
        let Ok(mut progress) = control.progress.lock() else { return };
        match outcome {
            HostOutcome::Completed { write } => {
                progress.completed += 1;
                progress.completed_writes += usize::from(*write);
            }
            HostOutcome::UnknownWrite if progress.unknown_writes.len() < MAX_UNKNOWN_WRITES => {
                progress.unknown_writes.push(label.to_string());
            }
            HostOutcome::UnknownWrite => progress.unknown_writes_dropped += 1,
            HostOutcome::Rejected | HostOutcome::Failed => {}
        }
    }

    /// Appends what is known about the operations already issued to an error message.
    fn describe_progress(message: String, progress: &MongoScriptProgress) -> String {
        if progress.completed == 0 && !progress.has_unknown_writes() {
            return message;
        }
        let mut text = message;
        text.push_str(&format!(
            "\nConfirmed completed operations: {} ({} writes).",
            progress.completed, progress.completed_writes
        ));
        for label in &progress.unknown_writes {
            text.push_str(&format!("\nOutcome unknown, it may or may not have been applied: {label}"));
        }
        if progress.unknown_writes_dropped > 0 {
            text.push_str(&format!(
                "\nOutcome unknown for {} more writes, they may or may not have been applied.",
                progress.unknown_writes_dropped
            ));
        }
        if progress.completed_writes > 0 || progress.has_unknown_writes() {
            text.push_str("\nWrites are not rolled back.");
        }
        text
    }

    fn operation_label(shell_source: &str) -> String {
        const MAX_CHARS: usize = 160;
        let mut label: String = shell_source.chars().take(MAX_CHARS).collect();
        if shell_source.chars().count() > MAX_CHARS {
            label.push('…');
        }
        label
    }

    /// Keeps the user's frames of a stack trace: the compatibility layer's frames are noise.
    fn user_stack(stack: &str) -> String {
        stack
            .lines()
            .filter(|line| !line.contains(PRELUDE_NAME))
            .map(|line| line.replace("eval_script", "script"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn describe(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
        if matches!(error, rquickjs::Error::Exception) {
            let caught = ctx.catch();
            if let Ok(exception) = Exception::from_value(caught.clone()) {
                let message = exception.message().unwrap_or_default();
                let stack = user_stack(&exception.stack().unwrap_or_default());
                return if stack.trim().is_empty() { message } else { format!("{message}\n{stack}") };
            }
            return format!("{caught:?}");
        }
        error.to_string()
    }

    pub fn run_script(
        source: &str,
        backend: Arc<dyn MongoScriptBackend>,
        settings: MongoScriptSettings,
        control: Arc<MongoScriptControl>,
        limits: &MongoScriptLimits,
    ) -> Result<MongoScriptOutput, String> {
        let _ = settings;
        check_source_size(source, limits)?;
        let fail = |message: String| describe_progress(message, &control.progress());

        let runtime = Runtime::new().map_err(|error| error.to_string())?;
        runtime.set_memory_limit(limits.memory_bytes);
        runtime.set_max_stack_size(limits.js_stack_bytes);
        let interrupt_control = control.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || interrupt_control.interruption().is_some())));
        let context = Context::full(&runtime).map_err(|error| error.to_string())?;

        context.with(|ctx| {
            let globals = ctx.globals();
            let setup = || -> rquickjs::Result<Function<'_>> {
                globals.set("__DBX_MAX_OUTPUT_LINES", limits.max_output_lines as f64)?;
                globals.set("__DBX_MAX_OUTPUT_BYTES", limits.max_output_bytes as f64)?;
                let host_control = control.clone();
                let exec = Function::new(ctx.clone(), move |shell_source: String, display: Opt<bool>| {
                    // Nothing new is sent once the script was canceled or ran out of time.
                    if let Some(interruption) = host_control.interruption() {
                        return error_json(host_control.interruption_message(interruption));
                    }
                    let reply = backend.exec(&shell_source, display.0.unwrap_or(false), &host_control);
                    record(&host_control, &reply.outcome, &operation_label(&shell_source));
                    reply.body
                })?;
                globals.set("__dbx_exec", exec)?;
                Module::evaluate(ctx.clone(), PRELUDE_NAME, PRELUDE)?.finish::<()>()?;
                // Held here and removed from the globals, so the script cannot replace it.
                let finish: Function = globals.get("__dbx_finish")?;
                globals.remove("__dbx_finish")?;
                Ok(finish)
            };
            let finish = setup().map_err(|error| describe(&ctx, error))?;

            let completion: JsValue = ctx.eval(source).map_err(|error| {
                let message = describe(&ctx, error);
                fail(match control.interruption() {
                    Some(interruption) => control.interruption_message(interruption),
                    None => message,
                })
            })?;
            let finished: String = finish.call((completion,)).map_err(|error| fail(describe(&ctx, error)))?;
            if finished.len() > limits.max_result_bytes {
                return Err(fail(format!(
                    "MongoDB script result is too large: {} bytes (limit {} bytes). Return fewer documents or use print().",
                    finished.len(),
                    limits.max_result_bytes
                )));
            }
            let parsed: Value = serde_json::from_str(&finished).map_err(|error| error.to_string())?;
            let value = match parsed.get("value") {
                Some(Value::String(text)) => Some(serde_json::from_str(text).map_err(|error| error.to_string())?),
                _ => None,
            };
            let output = parsed
                .get("output")
                .and_then(Value::as_array)
                .map(|lines| lines.iter().filter_map(|line| line.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let flag = |key: &str| parsed.get(key).and_then(Value::as_bool).unwrap_or(false);
            Ok(MongoScriptOutput {
                progress: control.progress(),
                value,
                output,
                output_truncated: flag("outputTruncated"),
                value_truncated: flag("valueTruncated"),
            })
        })
    }

    #[cfg(test)]
    mod tests;
}
