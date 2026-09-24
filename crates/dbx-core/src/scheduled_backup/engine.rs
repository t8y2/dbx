use chrono::Utc;
use std::{fs::OpenOptions, path::Path, sync::Arc, time::Duration};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::{models::*, BackupService};
use crate::{
    connection::AppState,
    database_export::{self, DatabaseExportOutputCompression, DatabaseExportRequest, ExportStatus},
    models::connection::DatabaseType,
    query, schema,
};

impl BackupService {
    pub(crate) async fn serve(&self, stop: CancellationToken, drain: CancellationToken) {
        let mut leader = None;
        let mut migration_ready = false;
        while !stop.is_cancelled() && !drain.is_cancelled() {
            if !migration_ready {
                migration_ready = match self.state.storage.inspect_data_migration().await {
                    Ok(status) => status.is_ready(),
                    Err(error) => {
                        log::warn!("[database-backup] waiting for data migration: {error}");
                        false
                    }
                };
            }
            if migration_ready && leader.is_none() {
                let acquired = std::fs::create_dir_all(&self.store.directory)
                    .and_then(|_| {
                        OpenOptions::new()
                            .create(true)
                            .truncate(false)
                            .read(true)
                            .write(true)
                            .open(self.store.directory.join("worker.lock"))
                    })
                    .ok()
                    .filter(|file| fs2::FileExt::try_lock_exclusive(file).is_ok());
                if let Some(file) = acquired {
                    match self.store.recover().await {
                        Ok(()) => leader = Some(file),
                        Err(error) => log::error!("[database-backup] recovery failed: {error}"),
                    }
                }
            }
            if migration_ready && leader.is_some() && !drain.is_cancelled() {
                if let Err(error) = self.tick(&stop).await {
                    log::error!("[database-backup] scheduler failed: {error}");
                }
            }
            tokio::select! { _ = stop.cancelled() => break, _ = drain.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(2)) => {} }
        }
        // Dropping the locked handle transfers leadership, including after an unclean process exit.
        drop(leader);
    }

    async fn tick(&self, stop: &CancellationToken) -> Result<(), String> {
        self.store.heartbeat().await?;
        self.store.enqueue_due().await?;
        let Some(job) = self.store.claim().await? else {
            return Ok(());
        };
        let state = Arc::new(AppState::new_with_plugin_dir(
            self.state.storage.clone(),
            self.state.storage.data_dir().join("plugins"),
        ));
        let cancellation = stop.child_token();
        if self.store.cancelled(job.run.id.clone()).await? {
            cancellation.cancel();
        }
        let (progress, receiver) = watch::channel(job.run.clone());
        let service = self.clone();
        let worker_state = state.clone();
        let worker_cancel = cancellation.clone();
        let run_id = job.run.id.clone();
        let fallback = job.run.clone();
        let runtime = tokio::runtime::Handle::current();
        // SQL formatting and compression perform synchronous writes; keep them off async worker threads.
        let mut worker = tokio::task::spawn_blocking(move || {
            runtime.block_on(service.execute(job, worker_state, worker_cancel, progress))
        });
        let mut run = loop {
            tokio::select! {
                result = &mut worker => break match result {
                    Ok(run) => run,
                    Err(error) => { let mut run = receiver.borrow().clone(); run.status = "failed".into(); run.error = Some(format!("Backup worker failed: {error}")); break run; }
                },
                _ = tokio::time::sleep(Duration::from_millis(500)) => {
                    if stop.is_cancelled() || self.store.cancelled(run_id.clone()).await.unwrap_or(true) {
                        cancellation.cancel();
                        database_export::set_export_cancelled(&run_id).await;
                    }
                    if let Err(error) = self.store.heartbeat().await { log::error!("[database-backup] heartbeat failed: {error}"); cancellation.cancel(); }
                    let latest = receiver.borrow().clone();
                    if let Err(error) = self.store.progress(latest).await { log::error!("[database-backup] progress persistence failed: {error}"); cancellation.cancel(); }
                }
            }
        };
        database_export::clear_export_cancelled(&run_id).await;
        state.shutdown(Duration::from_secs(3)).await;
        if run.status != "success" {
            if let Err(error) = self.cleanup(&mut run).await {
                run.error = Some(format!(
                    "{}; partial files retained: {error}",
                    run.error.as_deref().unwrap_or("Backup cancelled")
                ));
            }
        }
        run.completed_at = Some(Utc::now().to_rfc3339());
        let success = run.status == "success";
        self.store.finish(run).await?;
        if success {
            let snapshot = self.store.snapshot().await?;
            if let Some(schedule) = snapshot.schedules.iter().find(|s| Some(&s.id) == fallback.schedule_id.as_ref()) {
                let ids = snapshot
                    .runs
                    .iter()
                    .filter(|r| r.schedule_id.as_ref() == Some(&schedule.id) && r.status == "success")
                    .skip(schedule.retention_count)
                    .map(|r| r.id.clone())
                    .collect();
                self.delete_runs(ids).await?;
            }
        }
        Ok(())
    }

    async fn execute(
        &self,
        mut job: Job,
        state: Arc<AppState>,
        stop: CancellationToken,
        progress: watch::Sender<BackupRun>,
    ) -> BackupRun {
        let result = self.export_job(&mut job, &state, &stop, &progress).await;
        job.run.status = if stop.is_cancelled() {
            "cancelled"
        } else if result.is_ok() {
            "success"
        } else {
            "failed"
        }
        .into();
        job.run.error = result.err();
        if job.run.status == "success" {
            job.run.progress_percent = 100.0;
        }
        job.run
    }

    async fn export_job(
        &self,
        job: &mut Job,
        state: &Arc<AppState>,
        stop: &CancellationToken,
        progress: &watch::Sender<BackupRun>,
    ) -> Result<(), String> {
        check_cancel(stop)?;
        job.config.validate()?;
        self.validate_destination(&job.config.destination_directory)?;
        let connection = state
            .storage
            .load_connections()
            .await?
            .into_iter()
            .find(|c| c.id == job.config.connection_id)
            .ok_or("Saved backup connection is unavailable")?;
        if !matches!(connection.db_type, DatabaseType::Mysql | DatabaseType::Postgres) {
            return Err("This connection does not support consistent scheduled backups".into());
        }
        if !connection.save_password || connection.one_time {
            return Err("Unattended backups require a saved connection and saved credentials".into());
        }
        let postgres = connection.db_type == DatabaseType::Postgres;
        job.run.connection_name = connection.name.clone();
        state.configs.write().await.insert(connection.id.clone(), connection);
        check_cancel(stop)?;
        let available: Vec<String> =
            schema::list_databases_core(state, &job.config.connection_id).await?.into_iter().map(|d| d.name).collect();
        let databases = if job.config.databases.is_empty() {
            available.iter().filter(|name| !system_database(name, postgres)).cloned().collect::<Vec<_>>()
        } else {
            for name in &job.config.databases {
                if !available.contains(name) {
                    return Err(format!("Configured backup database is unavailable: {name}"));
                }
            }
            job.config.databases.clone()
        };
        if databases.is_empty() {
            return Err("No databases are available for this backup".into());
        }
        let mut sensitive = true;
        if !postgres && job.config.table_filter_mode != "all" {
            if let Ok(result) = query::execute_sql_statement(
                state,
                &job.config.connection_id,
                "",
                "SHOW VARIABLES LIKE 'lower_case_table_names'",
                None,
                None,
            )
            .await
            {
                sensitive = !result
                    .rows
                    .first()
                    .and_then(|r| r.get(1))
                    .is_some_and(|v| matches!(v.as_str(), Some("1" | "2")) || matches!(v.as_i64(), Some(1 | 2)));
            }
        }
        let directory = Path::new(&job.config.destination_directory).to_path_buf();
        let output = if let Some(pattern) = &job.directory_pattern {
            directory.join(render_template(pattern, &job.run, "", &job.time_zone, true)?)
        } else {
            directory
        };
        let mut included_count = 0;
        for (db_index, database) in databases.iter().enumerate() {
            check_cancel(stop)?;
            let schemas = if postgres {
                schema::list_schemas_core(state, &job.config.connection_id, database)
                    .await?
                    .into_iter()
                    .filter(|s| s != "information_schema" && !s.starts_with("pg_"))
                    .collect::<Vec<_>>()
            } else {
                vec![database.clone()]
            };
            if schemas.is_empty() {
                return Err(format!("Database {database} has no exportable schemas"));
            }
            // Metadata discovery may be slow; finish it before starting the snapshot idle timeout.
            let mut targets = Vec::new();
            for schema_name in &schemas {
                check_cancel(stop)?;
                let mut selected_tables = Vec::new();
                let mut excluded_tables = Vec::new();
                if job.config.table_filter_mode != "all" {
                    let tables = schema::list_tables_core(
                        state,
                        &job.config.connection_id,
                        database,
                        schema_name,
                        None,
                        None,
                        None,
                        None,
                        None,
                    )
                    .await?;
                    for table in &tables {
                        let matched = job
                            .config
                            .table_patterns
                            .iter()
                            .any(|p| matches_pattern(p, &table.name, database, schema_name, sensitive));
                        if matched {
                            if job.config.table_filter_mode == "include" {
                                selected_tables.push(table.name.clone());
                            } else {
                                excluded_tables.push(table.name.clone());
                            }
                        }
                    }
                    let included = if job.config.table_filter_mode == "include" {
                        selected_tables.len()
                    } else {
                        tables.len() - excluded_tables.len()
                    };
                    included_count += included;
                    if included == 0 {
                        continue;
                    }
                }
                targets.push((schema_name.clone(), selected_tables, excluded_tables));
            }
            if targets.is_empty() {
                continue;
            }
            check_cancel(stop)?;
            let snapshot = database_export::begin_database_backup_snapshot_core_for_export(
                state,
                &job.config.connection_id,
                database,
                Some(&job.run.id),
            )
            .await?;
            let result = async {
                for (schema_index, (schema_name, selected_tables, excluded_tables)) in targets.iter().enumerate() {
                    check_cancel(stop)?;
                    let stem = if schemas.len() > 1 { format!("{database}.{schema_name}") } else { database.clone() };
                    let name = render_template(
                        job.config.file_name_pattern.as_deref().unwrap_or(DEFAULT_FILE),
                        &job.run,
                        &stem,
                        &job.time_zone,
                        false,
                    )?;
                    let extension = if job.config.output_compression == "gzip" { "sql.gz" } else { "sql" };
                    let path = output.join(format!("{name}.{extension}"));
                    check_output_ancestors(&path, Path::new(&job.config.destination_directory))?;
                    if path.try_exists().map_err(|e| e.to_string())? {
                        return Err(format!("Backup file already exists: {}", path.display()));
                    }
                    if job.run.files.iter().any(|f| Path::new(&f.file_path) == path) {
                        return Err("Backup filename template produced duplicate paths".into());
                    }
                    let file = BackupFile {
                        database: database.clone(),
                        schema: schema_name.clone(),
                        display_name: stem,
                        file_path: path.to_string_lossy().into_owned(),
                        owned: false,
                    };
                    job.run.files.push(file.clone());
                    self.store.progress(job.run.clone()).await?;
                    progress.send_replace(job.run.clone());
                    let request = DatabaseExportRequest {
                        export_id: job.run.id.clone(),
                        connection_id: job.config.connection_id.clone(),
                        database: database.clone(),
                        schema: schema_name.clone(),
                        file_path: file.file_path,
                        selected_tables: selected_tables.clone(),
                        excluded_tables: excluded_tables.clone(),
                        include_structure: job.config.include_structure,
                        include_data: job.config.include_data,
                        include_objects: job.config.include_objects,
                        include_create_database: false,
                        drop_table_if_exists: job.config.drop_table_if_exists,
                        omit_auto_increment: false,
                        fail_on_error: true,
                        prevent_overwrite: true,
                        output_compression: if job.config.output_compression == "gzip" {
                            DatabaseExportOutputCompression::Gzip
                        } else {
                            DatabaseExportOutputCompression::None
                        },
                        snapshot_session_id: Some(snapshot.session_id.clone()),
                        batch_size: 1000,
                        split_max_mb: None,
                    };
                    let terminal_cancelled = std::sync::atomic::AtomicBool::new(false);
                    let created = Arc::new(std::sync::atomic::AtomicBool::new(false));
                    let result = database_export::track_backup_destination(
                        path,
                        created.clone(),
                        database_export::export_database_sql_core(state, &request, |event| {
                            if matches!(event.status, ExportStatus::Cancelled) {
                                terminal_cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
                            }
                            let mut run = job.run.clone();
                            if let Some(file) = run.files.last_mut() {
                                file.owned = created.load(std::sync::atomic::Ordering::Relaxed);
                            }
                            let fraction = if matches!(event.status, ExportStatus::Done) {
                                1.0
                            } else if event.total_objects > 0 {
                                event.object_index as f64 / event.total_objects as f64
                            } else {
                                0.0
                            };
                            run.progress_percent = ((db_index as f64
                                + (schema_index as f64 + fraction) / targets.len() as f64)
                                / databases.len() as f64
                                * 100.0)
                                .min(99.0);
                            progress.send_replace(run);
                        }),
                    )
                    .await;
                    if created.load(std::sync::atomic::Ordering::Relaxed) {
                        if let Some(file) = job.run.files.last_mut() {
                            file.owned = true;
                        }
                    } else {
                        // Preparation failures and external writers grant no file deletion authority.
                        job.run.files.pop();
                    }
                    result?;
                    if terminal_cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                        stop.cancel();
                    }
                    check_cancel(stop)?;
                    job.run.progress_percent = progress.borrow().progress_percent;
                }
                Ok::<_, String>(())
            }
            .await;
            let rollback = query::rollback_manual_transaction(state, &snapshot.session_id).await;
            result?;
            rollback?;
        }
        if job.config.table_filter_mode != "all" && included_count == 0 {
            return Err("No tables matched the backup table scope".into());
        }
        Ok(())
    }
}

fn check_cancel(stop: &CancellationToken) -> Result<(), String> {
    if stop.is_cancelled() {
        Err("Backup cancelled".into())
    } else {
        Ok(())
    }
}

fn system_database(name: &str, postgres: bool) -> bool {
    let name = name.to_ascii_lowercase();
    if postgres {
        matches!(name.as_str(), "template0" | "template1")
    } else {
        matches!(name.as_str(), "information_schema" | "mysql" | "performance_schema" | "sys")
    }
}

fn check_output_ancestors(path: &Path, root: &Path) -> Result<(), String> {
    let relative = path.strip_prefix(root).map_err(|_| "Backup output escaped destination")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("Invalid backup output path".into());
        }
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Backup output contains a symbolic link".into())
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.to_string()),
            _ => {}
        }
    }
    Ok(())
}
