use serde::Deserialize;
use serde_json::Value;
use std::{
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

use super::{models::*, BackupStore};
use crate::{connection::AppState, database_export::record_export_destination_identity};

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum BackupCommand {
    Snapshot,
    Preview { schedule: BackupSchedule },
    Save { schedule: BackupSchedule },
    DeleteSchedule { id: String },
    Migrate { migration: Migration },
    Run { request: RunRequest },
    Cancel { id: String },
    Rename { id: String, name: String },
    DeleteRuns { ids: Vec<String> },
    File { id: String, index: usize },
    Import { files: Vec<String> },
}

/// Source of history entries for backup files created outside DBX, such as Navicat `.nb3` archives.
pub const IMPORTED_SOURCE: &str = "imported";

#[derive(Clone)]
pub struct BackupService {
    pub(crate) state: Arc<AppState>,
    pub store: BackupStore,
    pub(crate) root: Option<PathBuf>,
}

impl BackupService {
    /// Web callers must supply a server-owned root, never one from the request.
    pub fn new(state: Arc<AppState>, data_dir: &Path, root: Option<PathBuf>) -> Self {
        Self { state, store: BackupStore::new(data_dir), root }
    }

    pub fn start(&self, stop: CancellationToken) -> tokio::task::JoinHandle<()> {
        self.start_with_drain(stop, CancellationToken::new())
    }

    /// Draining finishes the active job before releasing leadership; stopping cancels it.
    pub fn start_with_drain(&self, stop: CancellationToken, drain: CancellationToken) -> tokio::task::JoinHandle<()> {
        let service = self.clone();
        tokio::spawn(async move { service.serve(stop, drain).await })
    }

    pub async fn command(&self, command: BackupCommand) -> Result<Value, String> {
        match command {
            BackupCommand::File { id, index } => {
                Ok(Value::String(self.file(&id, index).await?.to_string_lossy().into_owned()))
            }
            BackupCommand::Preview { schedule } => {
                Ok(Value::String(schedule.next_after(chrono::Utc::now())?.to_rfc3339()))
            }
            BackupCommand::Snapshot => {
                let mut value = serde_json::to_value(self.store.snapshot().await?).map_err(|e| e.to_string())?;
                value["destinationRoot"] = serde_json::to_value(&self.root).map_err(|e| e.to_string())?;
                Ok(value)
            }
            BackupCommand::Save { schedule } => {
                schedule.validate()?;
                self.validate_destination(&schedule.config.destination_directory)?;
                let old = self.store.snapshot().await?.schedules.into_iter().find(|s| s.id == schedule.id);
                if old.is_none_or(|s| s.config.destination_directory != schedule.config.destination_directory) {
                    record_export_destination_identity(&self.state, Path::new(&schedule.config.destination_directory))
                        .await?;
                }
                serde_json::to_value(self.store.save_schedule(schedule).await?).map_err(|e| e.to_string())
            }
            BackupCommand::DeleteSchedule { id } => {
                self.store.delete_schedule(id).await?;
                Ok(Value::Null)
            }
            BackupCommand::Migrate { migration } => {
                if self.store.snapshot().await?.migrated {
                    return Ok(Value::Null);
                }
                // Browser-local history must not grant authority over arbitrary server files.
                if self.root.is_some() && (!migration.schedules.is_empty() || !migration.runs.is_empty()) {
                    return Err("Desktop backups cannot be imported into a Web server automatically".into());
                }
                self.store.migrate(migration).await?;
                Ok(Value::Null)
            }
            BackupCommand::Run { request } => {
                if let Some(config) = &request.config {
                    self.validate_destination(&config.destination_directory)?;
                }
                serde_json::to_value(self.store.enqueue(request).await?).map_err(|e| e.to_string())
            }
            BackupCommand::Cancel { id } => Ok(Value::Bool(self.store.cancel(id).await?)),
            BackupCommand::Rename { id, name } => {
                self.store.rename(id, name).await?;
                Ok(Value::Null)
            }
            BackupCommand::DeleteRuns { ids } => {
                self.delete_runs(ids).await?;
                Ok(Value::Null)
            }
            BackupCommand::Import { files } => {
                serde_json::to_value(self.import_files(files).await?).map_err(|e| e.to_string())
            }
        }
    }

    /// Lists backup files created outside DBX in the history so they can be restored later.
    /// DBX never owns imported files: deleting the entry only removes it from the history.
    async fn import_files(&self, files: Vec<String>) -> Result<Vec<BackupRun>, String> {
        if files.is_empty() || files.len() > 100 {
            return Err("Select between 1 and 100 backup files".into());
        }
        let known = self
            .store
            .snapshot()
            .await?
            .runs
            .into_iter()
            .flat_map(|run| run.files.into_iter().map(|file| file.file_path))
            .collect::<std::collections::HashSet<_>>();
        let mut runs = Vec::with_capacity(files.len());
        for file in files {
            bounded_text(&file, 4096, "Backup file")?;
            let path = Path::new(&file);
            let parent = path.parent().ok_or("Backup file has no parent directory")?;
            let directory = self.validate_destination(&parent.to_string_lossy())?;
            let metadata = std::fs::symlink_metadata(path).map_err(|e| format!("{file}: {e}"))?;
            if !metadata.is_file() {
                return Err(format!("Backup file is not a regular file: {file}"));
            }
            let resolved = path.canonicalize().map_err(|e| e.to_string())?;
            let file_path = resolved.to_string_lossy().into_owned();
            let name = resolved.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let lower = name.to_ascii_lowercase();
            if !lower.ends_with(".sql") && !lower.ends_with(".sql.gz") && !lower.ends_with(".nb3") {
                return Err(format!("Unsupported backup file (use .sql, .sql.gz or .nb3): {name}"));
            }
            if known.contains(&file_path) || runs.iter().any(|run: &BackupRun| run.files[0].file_path == file_path) {
                return Err(format!("Backup file is already in the history: {name}"));
            }
            let modified = metadata.modified().ok().map(chrono::DateTime::<chrono::Utc>::from);
            let (database, schema, started_at) = if crate::navicat_nb3::is_nb3_path(&resolved) {
                let archive = crate::navicat_nb3::Nb3Archive::open(&resolved).map_err(|e| format!("{name}: {e}"))?;
                let (database, schema) = archive.source_database_and_schema();
                let started = archive.started_at().and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0));
                (database, schema, started.or(modified))
            } else {
                (String::new(), String::new(), modified)
            };
            let display_name = match (database.is_empty(), schema.is_empty() || schema == database) {
                (true, _) => name.clone(),
                (false, true) => database.clone(),
                (false, false) => format!("{database}.{schema}"),
            };
            record_export_destination_identity(&self.state, &directory).await?;
            let now = chrono::Utc::now().to_rfc3339();
            runs.push(BackupRun {
                id: uuid::Uuid::new_v4().simple().to_string(),
                schedule_id: None,
                schedule_name: name,
                display_name: None,
                connection_id: String::new(),
                connection_name: String::new(),
                destination_directory: directory.to_string_lossy().into_owned(),
                trigger: "manual".into(),
                source: IMPORTED_SOURCE.into(),
                status: "success".into(),
                started_at: started_at.map(|time| time.to_rfc3339()).unwrap_or_else(|| now.clone()),
                completed_at: Some(now),
                files: vec![BackupFile { database, schema, display_name, file_path, owned: false }],
                progress_percent: 100.0,
                error: None,
            });
        }
        self.store.insert_completed(runs.clone()).await?;
        Ok(runs)
    }

    pub(crate) fn validate_destination(&self, path: &str) -> Result<PathBuf, String> {
        let path = Path::new(path);
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err("Backup directory must be an absolute path without traversal".into());
        }
        let resolved = path.canonicalize().map_err(|e| format!("Backup directory is unavailable: {e}"))?;
        if !resolved.is_dir() {
            return Err("Backup destination is not a directory".into());
        }
        if let Some(root) = &self.root {
            let root = root.canonicalize().map_err(|e| format!("Server backup root is unavailable: {e}"))?;
            if !resolved.starts_with(root) {
                return Err("Backup directory is outside the server backup root".into());
            }
        }
        Ok(resolved)
    }

    pub async fn file(&self, id: &str, index: usize) -> Result<PathBuf, String> {
        let snapshot = self.store.snapshot().await?;
        let run =
            snapshot.runs.iter().find(|r| r.id == id && r.status == "success").ok_or("Completed backup not found")?;
        let file = run.files.get(index).ok_or("Backup file not found")?;
        self.checked_file(run, Path::new(&file.file_path)).await
    }

    async fn checked_file(&self, run: &BackupRun, path: &Path) -> Result<PathBuf, String> {
        let root = self.validate_destination(&run.destination_directory)?;
        crate::database_export::verify_export_destination_identity(&self.state, Path::new(&run.destination_directory))
            .await?;
        let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("Backup file is not a regular file".into());
        }
        let resolved = path.canonicalize().map_err(|e| e.to_string())?;
        if resolved == root || !resolved.starts_with(root) {
            return Err("Backup file escaped its destination".into());
        }
        let name = resolved.file_name().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
        if !name.ends_with(".sql") && !name.ends_with(".sql.gz") && !name.ends_with(".nb3") {
            return Err("Not a SQL backup file".into());
        }
        Ok(resolved)
    }

    pub(crate) async fn cleanup(&self, run: &mut BackupRun) -> Result<(), String> {
        let others = self.store.snapshot().await?.runs;
        let mut retained = Vec::new();
        let mut errors = Vec::new();
        let mut emptied = Vec::new();
        for file in &run.files {
            if others.iter().any(|r| r.id != run.id && r.files.iter().any(|f| f.file_path == file.file_path)) {
                continue;
            }
            let path = Path::new(&file.file_path);
            match std::fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                _ => {}
            }
            if !file.owned {
                retained.push(file.clone());
                errors.push("File ownership could not be confirmed after interruption; inspect the file before removing it manually".into());
                continue;
            }
            match self.checked_file(run, path).await {
                Ok(path) => match tokio::fs::remove_file(&path).await {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                        retained.push(file.clone());
                        errors.push(e.to_string());
                    }
                    _ => emptied.extend(path.parent().map(Path::to_path_buf)),
                },
                Err(error) => {
                    retained.push(file.clone());
                    errors.push(error);
                }
            }
        }
        if let Ok(root) = self.validate_destination(&run.destination_directory) {
            for directory in emptied {
                remove_empty_directories(&directory, &root).await;
            }
        }
        run.files = retained;
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    pub(crate) async fn delete_runs(&self, ids: Vec<String>) -> Result<(), String> {
        if ids.len() > 1000 {
            return Err("Too many backups selected".into());
        }
        let mut errors = Vec::new();
        for mut run in self.store.mark_deleting(ids).await? {
            if run.source == IMPORTED_SOURCE {
                // Imported files belong to the user; only the history entry is removed.
                self.store.remove_run(run.id).await?;
                continue;
            }
            if let Err(error) = self.cleanup(&mut run).await {
                run.error = Some(format!("Backup cleanup failed: {error}"));
                self.store.deletion_failed(run).await?;
                errors.push(error);
                continue;
            }
            self.store.remove_run(run.id).await?;
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

/// Removes the per-run directories left behind once their backup files are gone.
/// `remove_dir` refuses non-empty directories, so folders still holding other runs'
/// backups or the user's own files are kept, and the destination root is never removed.
async fn remove_empty_directories(mut directory: &Path, root: &Path) {
    while directory != root && directory.starts_with(root) {
        let is_directory = tokio::fs::symlink_metadata(directory).await.is_ok_and(|m| m.is_dir());
        if !is_directory || tokio::fs::remove_dir(directory).await.is_err() {
            break;
        }
        let Some(parent) = directory.parent() else { break };
        directory = parent;
    }
}
