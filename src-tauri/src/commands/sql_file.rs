use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::commands::connection::{ensure_connection_writable, AppState};
use dbx_core::sql_file_import::{
    execute_sql_file_paths, execute_sql_file_zip_package_paths, mysql_like_sql_file_bootstrap_analysis,
    read_sql_file_preview, sql_file_progress, SqlFileProgressEmitter,
};

pub use dbx_core::sql::{SqlFilePreview, SqlFileRequest, SqlFileStatus};

static SQL_FILE_EXECUTIONS: OnceLock<RwLock<HashMap<String, CancellationToken>>> = OnceLock::new();

fn sql_file_executions() -> &'static RwLock<HashMap<String, CancellationToken>> {
    SQL_FILE_EXECUTIONS.get_or_init(|| RwLock::new(HashMap::new()))
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
) -> Result<Vec<dbx_core::sql_file_import::SqlFileTable>, String> {
    dbx_core::sql_file_import::inspect_sql_file_tables(std::path::Path::new(&file_path)).await
}

#[tauri::command]
pub async fn preview_sql_file(file_path: String) -> Result<SqlFilePreview, String> {
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
        let prefix = read_sql_file_preview(PathBuf::from(&extracted_paths[0]).as_path(), 1_000_000).await?;
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
    let prefix = read_sql_file_preview(&path, 1_000_000).await?;
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
    let result = execute_sql_files_inner(&app, &state, &request, &file_paths, token, started_at, is_zip_package).await;
    cleanup_sql_zip_package_paths(&file_paths);
    {
        let mut executions = sql_file_executions().write().await;
        remove_sql_file_execution(&mut executions, &request.execution_id);
    }
    result
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
) -> Result<(), String> {
    let mut progress_emitter = SqlFileProgressEmitter::new(|progress| {
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
