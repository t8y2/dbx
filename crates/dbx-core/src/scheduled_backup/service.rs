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
}

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
        }
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
        if !name.ends_with(".sql") && !name.ends_with(".sql.gz") {
            return Err("Not a SQL backup file".into());
        }
        Ok(resolved)
    }

    pub(crate) async fn cleanup(&self, run: &mut BackupRun) -> Result<(), String> {
        let others = self.store.snapshot().await?.runs;
        let mut retained = Vec::new();
        let mut errors = Vec::new();
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
                Ok(path) => {
                    if let Err(e) = tokio::fs::remove_file(path).await {
                        if e.kind() != std::io::ErrorKind::NotFound {
                            retained.push(file.clone());
                            errors.push(e.to_string());
                        }
                    }
                }
                Err(error) => {
                    retained.push(file.clone());
                    errors.push(error);
                }
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
