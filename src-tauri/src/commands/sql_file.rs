use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::commands::connection::{ensure_connection_writable, AppState};
use dbx_core::sql_file_import::{
    execute_sql_file_paths, execute_sql_file_zip_package_paths, export_sql_file_failure_log as derive_failure_log_file,
    mysql_like_sql_file_bootstrap_analysis, prune_sql_file_failure_logs, read_sql_file_preview_with_encoding,
    sql_file_failure_log_text as derive_failure_log_text, sql_file_progress, start_sql_file_failure_log,
    SqlFileFailureLogDeriveError, SqlFileFailureLogFileInfo, SqlFileFailureLogFormat, SqlFileFailureLogHandle,
    SqlFileFailureLogInfo, SqlFileFailureLogKey, SqlFileFailureLogMeta, SqlFileFailureLogRegistry,
    SqlFileFailureLogRunCounters, SqlFileProgressEmitter, SQL_FILE_FAILURE_LOG_CLIPBOARD_MAX_BYTES,
    SQL_FILE_FAILURE_LOG_DIR,
};

pub use dbx_core::sql::{SqlFileEncoding, SqlFilePreview, SqlFileRequest, SqlFileStatus};

static SQL_FILE_EXECUTIONS: OnceLock<RwLock<HashMap<String, CancellationToken>>> = OnceLock::new();

fn sql_file_executions() -> &'static RwLock<HashMap<String, CancellationToken>> {
    SQL_FILE_EXECUTIONS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// The desktop runtime has no session concept, so every log it registers shares
/// one owner. The Web runtime binds the authenticated session instead, which is
/// why the registry is owner-scoped at all.
const DESKTOP_FAILURE_LOG_OWNER: &str = "desktop";

static SQL_FILE_FAILURE_LOGS: OnceLock<SqlFileFailureLogRegistry> = OnceLock::new();

pub(crate) fn sql_file_failure_log_registry() -> &'static SqlFileFailureLogRegistry {
    SQL_FILE_FAILURE_LOGS.get_or_init(SqlFileFailureLogRegistry::new)
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlFileSummary {
    status: SqlFileStatus,
    success_count: usize,
    failure_count: usize,
    failed_statement_index: Option<usize>,
}

#[tauri::command]
pub async fn inspect_sql_file_tables(
    file_path: String,
    encoding: Option<SqlFileEncoding>,
) -> Result<Vec<dbx_core::sql_file_import::SqlFileTable>, String> {
    dbx_core::sql_file_import::inspect_sql_file_tables_with_encoding(
        std::path::Path::new(&file_path),
        encoding.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
pub async fn preview_sql_file(file_path: String, encoding: Option<SqlFileEncoding>) -> Result<SqlFilePreview, String> {
    let path = PathBuf::from(&file_path);
    let metadata = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?;
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        sweep_stale_sql_zip_packages();
        let extraction_dir = std::env::temp_dir().join(format!(
            "{}{}",
            dbx_core::sql_file_zip_package::SQL_FILE_ZIP_EXTRACTION_DIR_PREFIX_DESKTOP,
            uuid::Uuid::new_v4()
        ));
        let (package, extracted_paths) = tokio::task::spawn_blocking({
            let path = path.clone();
            let extraction_dir = extraction_dir.clone();
            move || {
                let package = dbx_core::sql_file_zip_package::extract_sql_file_zip_package(&path, &extraction_dir)?;
                let paths = dbx_core::sql_file_zip_package::extracted_sql_zip_paths(&extraction_dir, &package)
                    .into_iter()
                    .map(|part| part.to_string_lossy().to_string())
                    .collect::<Vec<_>>();
                Ok::<_, String>((package, paths))
            }
        })
        .await
        .map_err(|error| format!("Failed to extract SQL ZIP package: {error}"))??;
        let prefix = read_sql_file_preview_with_encoding(
            PathBuf::from(&extracted_paths[0]).as_path(),
            1_000_000,
            encoding.unwrap_or_default(),
        )
        .await?;
        let bootstrap_analysis = mysql_like_sql_file_bootstrap_analysis(&prefix);
        return Ok(SqlFilePreview {
            file_name: path.file_name().and_then(|name| name.to_str()).unwrap_or("package.zip").to_string(),
            file_path,
            size_bytes: metadata.len(),
            preview: prefix.chars().take(20_000).collect(),
            can_execute_without_selected_database: bootstrap_analysis.can_execute_without_selected_database,
            establishes_database_context: bootstrap_analysis.establishes_database_context,
            package_file_paths: Some(extracted_paths),
            package_part_count: Some(package.part_names.len()),
        });
    }
    let prefix = read_sql_file_preview_with_encoding(&path, 1_000_000, encoding.unwrap_or_default()).await?;
    let bootstrap_analysis = mysql_like_sql_file_bootstrap_analysis(&prefix);
    let preview = prefix.chars().take(20_000).collect();

    Ok(SqlFilePreview {
        file_name: path.file_name().and_then(|name| name.to_str()).unwrap_or("script.sql").to_string(),
        file_path,
        size_bytes: metadata.len(),
        preview,
        can_execute_without_selected_database: bootstrap_analysis.can_execute_without_selected_database,
        establishes_database_context: bootstrap_analysis.establishes_database_context,
        package_file_paths: None,
        package_part_count: None,
    })
}

#[tauri::command]
pub async fn execute_sql_file(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: SqlFileRequest,
) -> Result<(), String> {
    execute_sql_files(app, state, request.clone(), vec![request.file_path.clone()]).await
}

/// The frontend always sends the extracted `.sql` part paths as `file_paths`
/// for a ZIP upload, never the original `.zip` path (that only ever lives in
/// `SqlFileRequest::file_path`), so routing to the ZIP-package incremental
/// -flush importer must be derived from those actual execution paths, not
/// from `request.file_path`'s extension.
fn execution_targets_zip_package(file_paths: &[String]) -> bool {
    file_paths.iter().any(|path| is_desktop_sql_zip_package_part(Path::new(path)))
}

/// A desktop ZIP-package part lives in a `dbx-sql-package-<uuid>` directory
/// under the OS temp dir, exactly where `preview_sql_file` extracts uploads.
/// Requiring both the prefix and the temp-dir parent confines matching to
/// directories DBX created itself: desktop `file_paths` are arbitrary
/// user-chosen paths, so a user directory named `package-1.0/` (or even
/// `dbx-sql-package-...`) must never be mistaken for an extraction dir and
/// routed through the ZIP importer or its `remove_dir_all` cleanup.
fn is_desktop_sql_zip_package_part(path: &Path) -> bool {
    path.parent().is_some_and(|parent| {
        parent.starts_with(std::env::temp_dir())
            && dbx_core::sql_file_zip_package::is_extracted_sql_zip_package_path(
                path,
                dbx_core::sql_file_zip_package::SQL_FILE_ZIP_EXTRACTION_DIR_PREFIX_DESKTOP,
            )
    })
}

#[tauri::command]
pub async fn execute_sql_files(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: SqlFileRequest,
    file_paths: Vec<String>,
) -> Result<(), String> {
    // Fast-fail: reject early if the connection is read-only (individual statements are also checked in do_execute)
    ensure_connection_writable(&state, &request.connection_id, "SQL file execution").await?;
    if file_paths.is_empty() {
        return Err("No SQL files selected".to_string());
    }
    let token = CancellationToken::new();
    {
        let mut executions = sql_file_executions().write().await;
        register_sql_file_execution(&mut executions, request.execution_id.clone(), token.clone())?;
    }

    let started_at = Instant::now();
    let is_zip_package = execution_targets_zip_package(&file_paths);

    // Failure log (dbx#11619): created before the run so a mid-run export can
    // already read what failed, registered under the execution id so the export
    // and copy commands can find it, and finished on every exit path below.
    let mut failure_log = start_execution_failure_log(&state, &request, &file_paths).await;
    sql_file_failure_log_registry().register(
        DESKTOP_FAILURE_LOG_OWNER,
        &request.execution_id,
        failure_log.path().map(Path::to_path_buf),
        failure_log.status_probe(),
    );
    let mut counters = SqlFileFailureLogRunCounters::default();
    let result = execute_sql_files_inner(
        &app,
        &state,
        &request,
        &file_paths,
        token,
        started_at,
        is_zip_package,
        &mut failure_log,
        &mut counters,
    )
    .await;
    failure_log.finish(counters.summary(started_at.elapsed().as_millis() as u64)).await;
    // The log stays registered for later export, but stops shielding itself from
    // retention now that nothing is writing to it.
    sql_file_failure_log_registry().mark_finished(DESKTOP_FAILURE_LOG_OWNER, &request.execution_id);

    cleanup_sql_zip_package_paths(&file_paths);
    {
        let mut executions = sql_file_executions().write().await;
        remove_sql_file_execution(&mut executions, &request.execution_id);
    }
    result
}

/// Status of the failure log of one execution, for the export/copy controls.
/// Returns `None` when this process never logged that execution (unknown id, or
/// the run predates a restart: logs are not re-discoverable across restarts).
#[tauri::command]
pub async fn sql_file_failure_log_info(execution_id: String) -> Result<Option<SqlFileFailureLogInfo>, String> {
    Ok(sql_file_failure_log_registry().info(DESKTOP_FAILURE_LOG_OWNER, &execution_id))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileFailureLogExportPayload {
    pub records: u64,
    pub bytes: u64,
    pub format: String,
}

/// Clipboard payload. Being over the cap is a normal outcome the UI must handle
/// by suggesting the file export, so it is a flag rather than an error.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileFailureLogTextPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub too_large: bool,
    pub limit_bytes: u64,
}

/// Streams the failure log into a path the frontend already picked with the
/// native save dialog. Derivation is blocking (a log can be large), so it runs
/// off the async runtime.
#[tauri::command]
pub async fn export_sql_file_failure_log(
    execution_id: String,
    format: String,
    target_path: String,
    keys: Option<Vec<SqlFileFailureLogKey>>,
) -> Result<SqlFileFailureLogExportPayload, String> {
    let format = SqlFileFailureLogFormat::parse(&format).ok_or_else(|| format!("Unsupported log format: {format}"))?;
    let log_path = resolve_failure_log_path(&execution_id)?;
    let selection = failure_log_selection(keys);
    let format_name = format.extension().to_string();
    let summary = tokio::task::spawn_blocking(move || {
        derive_failure_log_file(&log_path, Path::new(&target_path), format, selection.as_ref())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    Ok(SqlFileFailureLogExportPayload { records: summary.records, bytes: summary.bytes, format: format_name })
}

/// Derived TXT/CSV text for the clipboard, capped so a huge log cannot be
/// pushed into the clipboard (and into the frontend) by accident.
#[tauri::command]
pub async fn read_sql_file_failure_log_text(
    execution_id: String,
    format: Option<String>,
    keys: Option<Vec<SqlFileFailureLogKey>>,
) -> Result<SqlFileFailureLogTextPayload, String> {
    let format = match format {
        Some(value) => {
            SqlFileFailureLogFormat::parse(&value).ok_or_else(|| format!("Unsupported log format: {value}"))?
        }
        None => SqlFileFailureLogFormat::Txt,
    };
    let log_path = resolve_failure_log_path(&execution_id)?;
    let selection = failure_log_selection(keys);
    let limit = SQL_FILE_FAILURE_LOG_CLIPBOARD_MAX_BYTES;
    let derived =
        tokio::task::spawn_blocking(move || derive_failure_log_text(&log_path, format, selection.as_ref(), limit))
            .await
            .map_err(|error| error.to_string())?;
    match derived {
        Ok(text) => Ok(SqlFileFailureLogTextPayload { text: Some(text), too_large: false, limit_bytes: limit }),
        Err(SqlFileFailureLogDeriveError::TooLarge { limit }) => {
            Ok(SqlFileFailureLogTextPayload { text: None, too_large: true, limit_bytes: limit })
        }
        Err(error) => Err(error.to_string()),
    }
}

fn resolve_failure_log_path(execution_id: &str) -> Result<PathBuf, String> {
    sql_file_failure_log_registry().path(DESKTOP_FAILURE_LOG_OWNER, execution_id).ok_or_else(|| {
        let reason =
            sql_file_failure_log_registry().info(DESKTOP_FAILURE_LOG_OWNER, execution_id).and_then(|info| info.reason);
        match reason {
            Some(reason) => format!("No failure log to export for this execution: {reason}"),
            None => "No failure log to export for this execution".to_string(),
        }
    })
}

fn failure_log_selection(keys: Option<Vec<SqlFileFailureLogKey>>) -> Option<HashSet<SqlFileFailureLogKey>> {
    let keys = keys?;
    if keys.is_empty() {
        return None;
    }
    Some(keys.into_iter().collect())
}

/// Prunes the failure log directory down to its retention limits. Best effort:
/// a failure to clean up must never block an import. Logs of executions that
/// are still registered (i.e. possibly still running) are protected, so two
/// parallel imports cannot delete each other's in-progress logs.
pub(crate) fn prune_desktop_sql_file_failure_logs(data_dir: &Path) {
    let dir = data_dir.join(SQL_FILE_FAILURE_LOG_DIR);
    let protected = sql_file_failure_log_registry().active_paths();
    if let Err(error) = prune_sql_file_failure_logs(&dir, &protected) {
        log::warn!("Failed to prune SQL file failure logs: {error}");
    }
}

async fn start_execution_failure_log(
    state: &State<'_, Arc<AppState>>,
    request: &SqlFileRequest,
    file_paths: &[String],
) -> SqlFileFailureLogHandle {
    if !request.failure_log_enabled {
        return SqlFileFailureLogHandle::unavailable("Failure log disabled for this execution".to_string());
    }
    let dir = state.storage.data_dir().join(SQL_FILE_FAILURE_LOG_DIR);
    // Retention runs before the new file exists, so it can never delete the log
    // this execution is about to write.
    prune_desktop_sql_file_failure_logs(state.storage.data_dir());
    let connection_name = state.configs.read().await.get(&request.connection_id).map(|config| config.name.clone());
    let mut files = Vec::with_capacity(file_paths.len());
    for (index, file_path) in file_paths.iter().enumerate() {
        let path = PathBuf::from(file_path);
        let size_bytes = tokio::fs::metadata(&path).await.ok().map(|metadata| metadata.len());
        let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        files.push(SqlFileFailureLogFileInfo { index, name, path: file_path.clone(), size_bytes });
    }
    let meta = SqlFileFailureLogMeta {
        execution_id: request.execution_id.clone(),
        connection_id: request.connection_id.clone(),
        connection_name,
        database: request.database.clone(),
        schema: request.schema.clone(),
        files,
        limits: Default::default(),
    };
    start_sql_file_failure_log(&dir, meta).await
}

fn cleanup_sql_zip_package_paths(file_paths: &[String]) {
    let mut directories = std::collections::HashSet::new();
    for path in file_paths {
        let path = PathBuf::from(path);
        if is_desktop_sql_zip_package_part(&path) {
            directories.insert(path.parent().expect("checked by is_desktop_sql_zip_package_part").to_path_buf());
        }
    }
    for directory in directories {
        let _ = std::fs::remove_dir_all(directory);
    }
}

/// A preview that never reaches execution leaves its extraction directory behind, so each new
/// preview also sweeps `dbx-sql-package-*` directories that have outlived a day.
fn sweep_stale_sql_zip_packages() {
    const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_name().to_str().is_some_and(|name| {
            name.starts_with(dbx_core::sql_file_zip_package::SQL_FILE_ZIP_EXTRACTION_DIR_PREFIX_DESKTOP)
        }) {
            continue;
        }
        let expired = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= MAX_AGE);
        if expired {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[tauri::command]
pub async fn cancel_sql_file_execution(execution_id: String) -> Result<bool, String> {
    let executions = sql_file_executions().read().await;
    if let Some(token) = executions.get(&execution_id) {
        token.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

async fn execute_sql_files_inner(
    app: &AppHandle,
    state: &State<'_, Arc<AppState>>,
    request: &SqlFileRequest,
    file_paths: &[String],
    token: CancellationToken,
    started_at: Instant,
    is_zip_package: bool,
    failure_log: &mut SqlFileFailureLogHandle,
    counters: &mut SqlFileFailureLogRunCounters,
) -> Result<(), String> {
    let mut progress_emitter = SqlFileProgressEmitter::new(|progress| {
        // The sink only serializes and hands off to its writer task, so a slow or
        // failing disk stays out of the execution path.
        counters.observe(&progress);
        failure_log.record(&progress);
        let _ = app.emit("sql-file-progress", progress);
    });
    progress_emitter.emit(sql_file_progress(
        &request.execution_id,
        SqlFileStatus::Started,
        0,
        0,
        0,
        0,
        started_at,
        "",
        None,
    ));
    let paths: Vec<PathBuf> = file_paths.iter().map(PathBuf::from).collect();
    let path_refs: Vec<&std::path::Path> = paths.iter().map(PathBuf::as_path).collect();
    if is_zip_package {
        execute_sql_file_zip_package_paths(state.inner().as_ref(), request, &path_refs, token, started_at, |progress| {
            progress_emitter.emit(progress);
        })
        .await
    } else {
        execute_sql_file_paths(state.inner().as_ref(), request, &path_refs, token, started_at, |progress| {
            progress_emitter.emit(progress);
        })
        .await
    }
}

fn register_sql_file_execution(
    executions: &mut HashMap<String, CancellationToken>,
    execution_id: String,
    token: CancellationToken,
) -> Result<(), String> {
    if executions.contains_key(&execution_id) {
        return Err(format!("SQL file execution '{execution_id}' already exists"));
    }

    executions.insert(execution_id, token);
    Ok(())
}

fn remove_sql_file_execution(executions: &mut HashMap<String, CancellationToken>, execution_id: &str) {
    executions.remove(execution_id);
}

#[cfg(test)]
async fn run_statements_for_test(
    statements: Vec<String>,
    continue_on_error: bool,
    token: CancellationToken,
    cancel_after_successes: Option<usize>,
) -> SqlFileSummary {
    let mut success_count = 0;
    let mut failure_count = 0;
    let mut failed_statement_index = None;

    for (idx, statement) in statements.iter().enumerate() {
        if token.is_cancelled() {
            return SqlFileSummary {
                status: SqlFileStatus::Cancelled,
                success_count,
                failure_count,
                failed_statement_index,
            };
        }

        if statement.starts_with("fail") {
            failure_count += 1;
            failed_statement_index = Some(idx + 1);
            if !continue_on_error {
                return SqlFileSummary {
                    status: SqlFileStatus::Error,
                    success_count,
                    failure_count,
                    failed_statement_index,
                };
            }
        } else {
            success_count += 1;
            if cancel_after_successes == Some(success_count) {
                token.cancel();
            }
        }
    }

    SqlFileSummary {
        status: if token.is_cancelled() { SqlFileStatus::Cancelled } else { SqlFileStatus::Done },
        success_count,
        failure_count,
        failed_statement_index,
    }
}

#[cfg(test)]
mod execution_tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    async fn run_fake_script(
        statements: Vec<String>,
        continue_on_error: bool,
        cancel_after_successes: Option<usize>,
    ) -> SqlFileSummary {
        let token = CancellationToken::new();
        run_statements_for_test(statements, continue_on_error, token, cancel_after_successes).await
    }

    #[tokio::test]
    async fn stops_on_first_failure_by_default() {
        let summary: SqlFileSummary =
            run_fake_script(vec!["ok 1".into(), "fail 2".into(), "ok 3".into()], false, None).await;

        assert_eq!(summary.success_count, 1);
        assert_eq!(summary.failure_count, 1);
        assert_eq!(summary.status, SqlFileStatus::Error);
        assert_eq!(summary.failed_statement_index, Some(2));
    }

    #[tokio::test]
    async fn continues_after_failure_when_enabled() {
        let summary = run_fake_script(vec!["ok 1".into(), "fail 2".into(), "ok 3".into()], true, None).await;

        assert_eq!(summary.success_count, 2);
        assert_eq!(summary.failure_count, 1);
        assert_eq!(summary.status, SqlFileStatus::Done);
    }

    #[tokio::test]
    async fn cancellation_stops_before_next_statement() {
        let summary = run_fake_script(vec!["ok 1".into(), "ok 2".into(), "ok 3".into()], true, Some(1)).await;

        assert_eq!(summary.success_count, 1);
        assert_eq!(summary.status, SqlFileStatus::Cancelled);
    }

    #[test]
    fn zip_package_routing_is_selected_from_extracted_part_paths_not_the_original_zip_name() {
        // Regression for PR #10632 review: `SqlFileExecutionDialog.vue` sends
        // `executionPaths = packageFilePaths ?? [filePath]`, i.e. the extracted
        // `.sql` part paths, as `file_paths` -- `request.file_path` on its own
        // (still `.zip` in that case) must never gate this decision.
        // Extraction dirs live under the OS temp dir, so the fixtures must too.
        let temp = std::env::temp_dir();
        let zip_upload_part_paths = vec![
            temp.join("dbx-sql-package-11111111-1111-1111-1111-111111111111/00001-dump.sql")
                .to_string_lossy()
                .into_owned(),
            temp.join("dbx-sql-package-11111111-1111-1111-1111-111111111111/00002-dump.sql")
                .to_string_lossy()
                .into_owned(),
        ];
        assert!(execution_targets_zip_package(&zip_upload_part_paths));

        let ordinary_upload_paths = vec![temp.join("upload-22222222.sql").to_string_lossy().into_owned()];
        assert!(!execution_targets_zip_package(&ordinary_upload_paths));

        // `execute_sql_file` forwards `vec![request.file_path.clone()]` as the
        // sole `file_paths` entry, so a single extracted part must also match.
        let single_zip_part_as_sole_path =
            vec![temp.join("dbx-sql-package-33333333/00001-dump.sql").to_string_lossy().into_owned()];
        assert!(execution_targets_zip_package(&single_zip_part_as_sole_path));
    }

    #[test]
    fn zip_package_routing_ignores_user_directories_sharing_an_extraction_prefix() {
        // Scoping regression for PR #10632 review: desktop `file_paths` are
        // arbitrary user-chosen paths, so only `dbx-sql-package-*` directories
        // under the OS temp dir count as extraction dirs.
        let temp = std::env::temp_dir();
        let web_style_user_dir = vec![temp.join("package-1.0/00001-dump.sql").to_string_lossy().into_owned()];
        assert!(!execution_targets_zip_package(&web_style_user_dir));

        let desktop_named_dir_outside_temp =
            vec!["/definitely/not/the/temp/dbx-sql-package-44444444/00001-dump.sql".to_string()];
        assert!(!execution_targets_zip_package(&desktop_named_dir_outside_temp));
    }

    #[test]
    fn zip_package_cleanup_never_removes_user_directories_sharing_a_prefix() {
        let temp = std::env::temp_dir();
        let extraction = temp.join(format!("dbx-sql-package-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&extraction).unwrap();
        std::fs::write(extraction.join("00001-dump.sql"), "SELECT 1;\n").unwrap();
        let user_dir = temp.join(format!("package-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&user_dir).unwrap();
        std::fs::write(user_dir.join("user.sql"), "SELECT 2;\n").unwrap();

        cleanup_sql_zip_package_paths(&[
            extraction.join("00001-dump.sql").to_string_lossy().into_owned(),
            user_dir.join("user.sql").to_string_lossy().into_owned(),
        ]);

        assert!(!extraction.exists());
        assert!(user_dir.exists());
        let _ = std::fs::remove_dir_all(&user_dir);
    }

    fn terminal_progress(
        status: SqlFileStatus,
        success: usize,
        failures: usize,
        affected: u64,
    ) -> dbx_core::sql::SqlFileProgress {
        dbx_core::sql::SqlFileProgress {
            execution_id: "exec-1".to_string(),
            status,
            statement_index: 0,
            success_count: success,
            failure_count: failures,
            affected_rows: affected,
            elapsed_ms: 0,
            statement_summary: String::new(),
            error: None,
            bytes_read: None,
            total_bytes: None,
            phase: None,
            file_index: None,
            file_name: None,
            failure_sql: None,
        }
    }

    #[test]
    fn terminal_counters_only_follow_terminal_events() {
        let mut counters = SqlFileFailureLogRunCounters::default();
        // Intermediate (and failure) progress must not be mistaken for the final
        // figures, otherwise the log summary would contradict the UI counters.
        counters.observe(&terminal_progress(SqlFileStatus::Running, 5, 1, 2));
        counters.observe(&terminal_progress(SqlFileStatus::StatementFailed, 5, 1, 2));
        assert_eq!(counters.success_count, 0);

        counters.observe(&terminal_progress(SqlFileStatus::Done, 4, 1, 7));
        assert_eq!((counters.success_count, counters.failure_count, counters.affected_rows), (4, 1, 7));
        assert!(!counters.cancelled);

        counters.observe(&terminal_progress(SqlFileStatus::Cancelled, 2, 1, 3));
        assert!(counters.cancelled);
        assert_eq!(counters.success_count, 2);
    }

    #[test]
    fn duplicate_execution_id_is_rejected_without_replacing_token() {
        let mut executions = HashMap::new();
        let original = CancellationToken::new();
        let replacement = CancellationToken::new();
        executions.insert("dup".to_string(), original.clone());

        let result = register_sql_file_execution(&mut executions, "dup".to_string(), replacement.clone());

        assert_eq!(result.unwrap_err(), "SQL file execution 'dup' already exists");
        assert_eq!(executions.len(), 1);

        executions.get("dup").unwrap().cancel();
        assert!(original.is_cancelled());
        assert!(!replacement.is_cancelled());
    }
}
