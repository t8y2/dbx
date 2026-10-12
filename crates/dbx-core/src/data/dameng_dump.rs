//! Native Dameng `dexp`/`dimp` process runner.
//!
//! [`dbx_sql::dameng_dump`] builds the invocation and interprets the tool log;
//! this module drives the external process: it resolves the connection's
//! credentials, writes the PARFILE to a temp directory, spawns the configured
//! tool with managed process-tree ownership, streams a terminal progress
//! event, and cleans up its scratch files.
//!
//! The password necessarily rides on the command line (Dameng requires `USERID`
//! as the first argument — see the dbx-sql module docs), so the spawned
//! process must stay short-lived; `PARFILE` keeps everything else out of the
//! process list.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

pub use dbx_sql::dameng_dump::DamengDumpKind as DamengDumpKindReexport;
use dbx_sql::dameng_dump::{
    build_command, build_parfile_contents, parse_dump_log, DamengDumpKind, DamengDumpOutcome, DamengDumpRequest,
};

use crate::connection::AppState;
use crate::data::database_export::{clear_export_cancelled, is_export_cancelled, EXPORT_CANCELLED_ERROR};
use crate::models::connection::DatabaseType;

/// Poll interval for the child's exit / the cancellation marker.
const POLL_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DamengDumpKindArg {
    Export,
    Import,
}

impl From<DamengDumpKindArg> for DamengDumpKind {
    fn from(value: DamengDumpKindArg) -> Self {
        match value {
            DamengDumpKindArg::Export => DamengDumpKind::Export,
            DamengDumpKindArg::Import => DamengDumpKind::Import,
        }
    }
}

/// The request the frontend sends. Connection credentials are resolved
/// server-side from the connection config (plus the session-credential
/// fallback for `save_password=false` connections).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DamengDumpTaskRequest {
    pub task_id: String,
    pub connection_id: String,
    pub kind: DamengDumpKindArg,
    /// Absolute path to the `dexp`/`dimp` executable (from the user setting).
    pub tool_path: String,
    /// `.dmp` file to write (export) or read (import).
    pub file_path: String,
    /// Schemas to export/import; empty means whole-database.
    #[serde(default)]
    pub schemas: Vec<String>,
    /// Explicit tables (export only); empty means the whole schema.
    #[serde(default)]
    pub tables: Vec<String>,
    /// Import only: remap `REMAP_SCHEMA=SRC:DST`.
    #[serde(default)]
    pub remap_schema: Option<(String, String)>,
    /// Import only: `TABLE_EXISTS_ACTION=SKIP|REPLACE|TRUNCATE|APPEND`.
    #[serde(default)]
    pub table_exists_action: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DamengDumpStatus {
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DamengDumpProgress {
    pub task_id: String,
    pub status: DamengDumpStatus,
    pub success: bool,
    pub warnings: bool,
    pub elapsed_seconds: Option<String>,
    pub error: Option<String>,
}

/// Tagged so the frontend can map it to a localized hint pointing at the
/// Settings page (same convention as the AI CLI path errors).
pub const DAMENG_TOOL_NOT_FOUND_TAG: &str = "damengToolNotFound";
pub const DAMENG_CONNECTION_NOT_DAMENG_TAG: &str = "damengConnectionRequired";
pub const DAMENG_PASSWORD_MISSING_TAG: &str = "damengPasswordMissing";

fn tagged(tag: &str, message: &str) -> String {
    format!("[{tag}] {message}")
}

/// Resolve the `dexp`/`dimp` executable inside a configured client `bin`
/// directory. Windows installs use `dexp.exe`/`dimp.exe`; the extension-less
/// form is accepted too (some clients ship a launcher script).
pub fn resolve_damp_tool_path(bin_dir: &str, kind: DamengDumpKind) -> Result<PathBuf, String> {
    let bin_dir = bin_dir.trim();
    if bin_dir.is_empty() {
        return Err(tagged(DAMENG_TOOL_NOT_FOUND_TAG, "Dameng client bin directory is not configured."));
    }
    let base = match kind {
        DamengDumpKind::Export => "dexp",
        DamengDumpKind::Import => "dimp",
    };
    let dir = Path::new(bin_dir);
    let candidates = if cfg!(windows) {
        vec![dir.join(format!("{base}.exe")), dir.join(base)]
    } else {
        vec![dir.join(base), dir.join(format!("{base}.exe"))]
    };
    candidates.into_iter().find(|candidate| candidate.is_file()).ok_or_else(|| {
        tagged(
            DAMENG_TOOL_NOT_FOUND_TAG,
            &format!(
                "Dameng client tool '{base}' was not found in '{bin_dir}'. \
                     Configure the Dameng client bin directory in Settings > Data."
            ),
        )
    })
}

/// Export side: the native tool refuses to overwrite non-interactively (it
/// prompts `y/n` on the console, which we do not feed). The frontend's save
/// dialog has already asked the user to confirm the replacement, so removing
/// the existing file here only honors that confirmation.
fn prepare_export_target(file_path: &Path) -> Result<(), String> {
    match std::fs::metadata(file_path) {
        Ok(_) => std::fs::remove_file(file_path)
            .map_err(|error| format!("Failed to replace existing export file '{}': {error}", file_path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot access export file '{}': {error}", file_path.display())),
    }
}

fn prepare_import_source(file_path: &Path) -> Result<(), String> {
    if file_path.is_file() {
        Ok(())
    } else {
        Err(format!("Import file not found: '{}'", file_path.display()))
    }
}

/// Run the tool once and return the combined diagnostic text (log file
/// preferred, console capture as fallback).
async fn run_tool_and_collect(
    argv: &[String],
    log_path: &Path,
    out_path: &Path,
    err_path: &Path,
    task_id: &str,
) -> Result<String, String> {
    if argv.is_empty() {
        return Err("Empty dexp/dimp command".to_string());
    }
    let mut command = crate::process::new_tokio_command(&argv[0]);
    command.args(&argv[1..]);
    command.stdin(std::process::Stdio::null());
    command.kill_on_drop(true);

    let out_file = std::fs::File::create(out_path)
        .map_err(|error| format!("Failed to create capture file '{}': {error}", out_path.display()))?;
    let err_file = std::fs::File::create(err_path)
        .map_err(|error| format!("Failed to create capture file '{}': {error}", err_path.display()))?;
    command.stdout(std::process::Stdio::from(out_file));
    command.stderr(std::process::Stdio::from(err_file));

    let mut child = crate::process::spawn_managed_child(&mut command)
        .await
        .map_err(|error| format!("Failed to start '{}': {error}", argv[0]))?;

    let cancelled = loop {
        match child.try_wait() {
            Ok(Some(_)) => break false,
            Ok(None) => {}
            Err(error) => return Err(format!("Failed to wait for '{}': {error}", argv[0])),
        }
        if is_export_cancelled(task_id).await {
            let _ = child.terminate().await;
            break true;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    };

    if cancelled {
        return Err(EXPORT_CANCELLED_ERROR.to_string());
    }

    // Prefer the tool's own log (the parse target); fall back to console
    // capture for early failures (missing lib, bad args) that never reach it.
    let log_text = tokio::fs::read_to_string(log_path).await.unwrap_or_default();
    if !log_text.trim().is_empty() {
        return Ok(log_text);
    }
    let mut console = String::new();
    let mut out_file = tokio::fs::File::open(out_path).await.ok();
    let mut err_file = tokio::fs::File::open(err_path).await.ok();
    if let Some(file) = out_file.as_mut() {
        let _ = file.read_to_string(&mut console).await;
    }
    if let Some(file) = err_file.as_mut() {
        let mut err_text = String::new();
        let _ = file.read_to_string(&mut err_text).await;
        if !err_text.trim().is_empty() {
            if !console.trim().is_empty() {
                console.push('\n');
            }
            console.push_str(&err_text);
        }
    }
    Ok(console)
}

fn remove_if_exists(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// Drive one native export/import. Emits a `Running` progress at start and a
/// terminal `Done`/`Error`/`Cancelled` before returning. Returns `Ok(())` for
/// both parsed success and parsed failure (the progress carries the outcome);
/// `Err` is only for infrastructure problems before/around the run, which the
/// caller surfaces as a terminal `Error` event too.
pub async fn run_dameng_dump_task(
    state: &Arc<AppState>,
    request: &DamengDumpTaskRequest,
    on_progress: impl Fn(DamengDumpProgress) + Sync,
) -> Result<(), String> {
    let emit =
        |status: DamengDumpStatus, success: bool, warnings: bool, elapsed: Option<String>, error: Option<String>| {
            on_progress(DamengDumpProgress {
                task_id: request.task_id.clone(),
                status,
                success,
                warnings,
                elapsed_seconds: elapsed,
                error,
            })
        };
    emit(DamengDumpStatus::Running, false, false, None, None);

    let kind: DamengDumpKind = request.kind.into();

    let mut config = {
        let configs = state.configs.read().await;
        match configs.get(&request.connection_id).cloned() {
            Some(config) => config,
            None => {
                let error = format!("Connection config not found: {}", request.connection_id);
                emit(DamengDumpStatus::Error, false, false, None, Some(error.clone()));
                return Err(error);
            }
        }
    };
    if config.db_type != DatabaseType::Dameng {
        let error =
            tagged(DAMENG_CONNECTION_NOT_DAMENG_TAG, "Native dexp/dimp dump is only available for Dameng connections.");
        emit(DamengDumpStatus::Error, false, false, None, Some(error.clone()));
        return Err(error);
    }
    // save_password=false connections keep the password only in the session store.
    let config_snapshot = config.clone();
    state.apply_session_credential(&config_snapshot, &mut config, &request.connection_id);
    if config.password.is_empty() {
        let error = tagged(
            DAMENG_PASSWORD_MISSING_TAG,
            "The connection has no password available; reconnect and enter the password first.",
        );
        emit(DamengDumpStatus::Error, false, false, None, Some(error.clone()));
        return Err(error);
    }

    let tool_path = Path::new(&request.tool_path);
    if !tool_path.is_file() {
        let error = tagged(
            DAMENG_TOOL_NOT_FOUND_TAG,
            &format!(
                "Dameng client tool not found: '{}'. \
                 Configure the Dameng client bin directory in Settings > Data.",
                request.tool_path
            ),
        );
        emit(DamengDumpStatus::Error, false, false, None, Some(error.clone()));
        return Err(error);
    }

    let file_path = Path::new(&request.file_path);
    if let Err(error) = match kind {
        DamengDumpKind::Export => prepare_export_target(file_path),
        DamengDumpKind::Import => prepare_import_source(file_path),
    } {
        emit(DamengDumpStatus::Error, false, false, None, Some(error.clone()));
        return Err(error);
    }

    let temp_dir = std::env::temp_dir().join("dbx-dameng-dump");
    if let Err(error) = std::fs::create_dir_all(&temp_dir) {
        let error = format!("Failed to create temp dir '{}': {error}", temp_dir.display());
        emit(DamengDumpStatus::Error, false, false, None, Some(error.clone()));
        return Err(error);
    }
    let stem = format!("{}-{}", request.task_id, std::process::id());
    let parfile_path = temp_dir.join(format!("{stem}.par"));
    let log_path = temp_dir.join(format!("{stem}.log"));
    let out_path = temp_dir.join(format!("{stem}.out"));
    let err_path = temp_dir.join(format!("{stem}.err"));

    let dump_request = DamengDumpRequest {
        db_type: config.db_type,
        kind,
        tool_path: request.tool_path.clone(),
        host: config.host.clone(),
        port: config.port,
        user: config.username.clone(),
        password: config.password.clone(),
        file_path: request.file_path.clone(),
        log_path: log_path.to_string_lossy().into_owned(),
        schemas: request.schemas.clone(),
        tables: request.tables.clone(),
        remap_schema: request.remap_schema.clone(),
        table_exists_action: request.table_exists_action.clone(),
    };

    let parfile_contents = build_parfile_contents(&dump_request);
    if let Err(error) = std::fs::write(&parfile_path, parfile_contents) {
        let error = format!("Failed to write PARFILE '{}': {error}", parfile_path.display());
        emit(DamengDumpStatus::Error, false, false, None, Some(error.clone()));
        return Err(error);
    }
    let argv = build_command(&dump_request, &parfile_path.to_string_lossy());

    let run_result = run_tool_and_collect(&argv, &log_path, &out_path, &err_path, &request.task_id).await;

    remove_if_exists(&parfile_path);
    remove_if_exists(&out_path);
    remove_if_exists(&err_path);

    let text = match run_result {
        Ok(text) => text,
        Err(error) if error == EXPORT_CANCELLED_ERROR => {
            remove_if_exists(&log_path);
            emit(DamengDumpStatus::Cancelled, false, false, None, None);
            return Ok(());
        }
        Err(error) => {
            remove_if_exists(&log_path);
            emit(DamengDumpStatus::Error, false, false, None, Some(error.clone()));
            return Err(error);
        }
    };
    remove_if_exists(&log_path);

    let outcome: DamengDumpOutcome = parse_dump_log(&text, kind);
    if outcome.success {
        emit(DamengDumpStatus::Done, true, outcome.warnings, outcome.elapsed_seconds, None);
        Ok(())
    } else {
        let error = outcome
            .error
            .clone()
            .or_else(|| {
                Some(text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("dexp/dimp failed").trim().to_string())
            })
            .unwrap_or_else(|| "dexp/dimp failed".to_string());
        emit(DamengDumpStatus::Error, false, outcome.warnings, outcome.elapsed_seconds.clone(), Some(error.clone()));
        Err(error)
    }
}

/// The tauri command wrapper emits the terminal error itself; this keeps the
/// cancellation marker cleanup next to the task spawn (mirrors the database
/// export command).
pub async fn finish_dameng_dump_task(task_id: &str) {
    clear_export_cancelled(task_id).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_tool_path_requires_configured_dir() {
        let error = resolve_damp_tool_path("  ", DamengDumpKind::Export).unwrap_err();
        assert!(error.starts_with("[damengToolNotFound]"), "tagged error, got: {error}");
    }

    #[test]
    fn resolve_tool_path_finds_executable_in_dir() {
        let dir = std::env::temp_dir().join(format!("dbx-dameng-tool-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = if cfg!(windows) { "dexp.exe" } else { "dexp" };
        let tool = dir.join(name);
        std::fs::write(&tool, b"fake").unwrap();
        let resolved = resolve_damp_tool_path(&dir.to_string_lossy(), DamengDumpKind::Export).unwrap();
        assert_eq!(resolved, tool);
        let missing = resolve_damp_tool_path(&dir.to_string_lossy(), DamengDumpKind::Import).unwrap_err();
        assert!(missing.starts_with("[damengToolNotFound]"), "got: {missing}");
        let _ = std::fs::remove_file(&tool);
    }

    #[test]
    fn prepare_export_target_replaces_existing_file() {
        let file = std::env::temp_dir().join(format!("dbx-dameng-overwrite-{}.dmp", std::process::id()));
        std::fs::write(&file, b"old").unwrap();
        prepare_export_target(&file).unwrap();
        assert!(!file.exists());
        prepare_export_target(&file).unwrap();
    }

    #[test]
    fn prepare_import_source_requires_existing_file() {
        let file = std::env::temp_dir().join(format!("dbx-dameng-missing-{}.dmp", std::process::id()));
        let error = prepare_import_source(&file).unwrap_err();
        assert!(error.contains("Import file not found"), "got: {error}");
    }

    /// End-to-end runner check against a fake tool that behaves like dexp:
    /// it writes a real success log (the same markers parse_dump_log tests
    /// use) and exits 0. Proves spawn → capture → log-preferring parse →
    /// outcome wiring without a live DM8.
    #[tokio::test]
    async fn run_tool_and_collect_parses_fake_success_log() {
        let dir = std::env::temp_dir().join(format!("dbx-dameng-fake-tool-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log_path = dir.join("run.log");
        let out_path = dir.join("run.out");
        let err_path = dir.join("run.err");

        // The fake tool mirrors dexp: it writes a success log where the real
        // tool would and exits 0. Windows uses the English success marker
        // because cmd.exe `echo` writes in the OEM codepage, not UTF-8.
        #[cfg(windows)]
        let (tool, tool_args, expect_elapsed) = {
            let tool = dir.join("fake.bat");
            std::fs::write(
                &tool,
                "@echo off\r\necho dexp V8> \"%~dp0run.log\"\r\necho terminated successfully>> \"%~dp0run.log\"\r\n",
            )
            .unwrap();
            (tool, vec!["USERID=u/p@h:5236".to_string(), "PARFILE=x".to_string()], false)
        };
        #[cfg(not(windows))]
        let (tool, tool_args, expect_elapsed) = {
            use std::os::unix::fs::PermissionsExt;
            let tool = dir.join("fake.sh");
            std::fs::write(
                &tool,
                "#!/bin/sh\necho 'dexp V8' > \"$(dirname \"$0\")/run.log\"\necho '整个导出过程共花费 4.032 s' >> \"$(dirname \"$0\")/run.log\"\necho '成功终止导出, 没有出现警告' >> \"$(dirname \"$0\")/run.log\"\n",
            )
            .unwrap();
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
            (tool, vec!["USERID=u/p@h:5236".to_string(), "PARFILE=x".to_string()], true)
        };

        let mut argv = vec![tool.to_string_lossy().into_owned()];
        argv.extend(tool_args);
        let text = run_tool_and_collect(&argv, &log_path, &out_path, &err_path, "fake-task").await.unwrap();
        let outcome = parse_dump_log(&text, DamengDumpKind::Export);
        assert!(outcome.success, "should parse the fake success log: {outcome:?}");
        if expect_elapsed {
            assert_eq!(outcome.elapsed_seconds.as_deref(), Some("4.032s"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A tool that fails without writing a log must surface its stderr through
    /// the console fallback and parse as failure.
    #[tokio::test]
    async fn run_tool_and_collect_surfaces_stderr_without_log() {
        let dir = std::env::temp_dir().join(format!("dbx-dameng-fake-fail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log_path = dir.join("never-written.log");
        let out_path = dir.join("run.out");
        let err_path = dir.join("run.err");

        #[cfg(windows)]
        let (tool, tool_args) = {
            let tool = dir.join("fail.bat");
            std::fs::write(&tool, "@echo off\r\necho DMException: bad thing 1>&2\r\nexit /b 1\r\n").unwrap();
            (tool, vec![])
        };
        #[cfg(not(windows))]
        let (tool, tool_args) = {
            use std::os::unix::fs::PermissionsExt;
            let tool = dir.join("fail.sh");
            std::fs::write(&tool, "#!/bin/sh\necho 'dm.jdbc.driver.DMException: boom' >&2\nexit 1\n").unwrap();
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
            (tool, vec![])
        };

        let mut argv = vec![tool.to_string_lossy().into_owned()];
        argv.extend(tool_args);
        let text = run_tool_and_collect(&argv, &log_path, &out_path, &err_path, "fake-fail-task").await.unwrap();
        let outcome = parse_dump_log(&text, DamengDumpKind::Export);
        assert!(!outcome.success);
        assert!(outcome.error.as_deref().unwrap_or_default().contains("DMException"), "got: {outcome:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
