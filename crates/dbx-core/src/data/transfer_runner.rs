use std::sync::{Arc, Mutex};

use crate::{
    connection::AppState,
    models::connection::DatabaseType,
    persistence::task_history::{TaskItemStatus, TransferTaskJournal},
};

use super::transfer::{TransferProgress, TransferRequest, TransferStatus};

struct ProgressEmitter<F> {
    callback: Mutex<F>,
    terminal: Mutex<Option<TransferProgress>>,
}

impl<F> ProgressEmitter<F>
where
    F: FnMut(TransferProgress) + Send,
{
    fn new(callback: F) -> Self {
        Self { callback: Mutex::new(callback), terminal: Mutex::new(None) }
    }

    fn emit(&self, progress: TransferProgress) {
        (self.callback.lock().unwrap_or_else(std::sync::PoisonError::into_inner))(progress);
    }

    fn emit_terminal(&self, progress: TransferProgress) {
        *self.terminal.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(progress);
    }

    fn take_terminal(&self, transfer_id: &str, total_tables: usize) -> TransferProgress {
        self.terminal.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take().unwrap_or_else(|| {
            TransferProgress {
                oracle_package_approval: None,
                oracle_package_preflight: None,
                oracle_routine_operation: None,
                transfer_id: transfer_id.to_string(),
                table: String::new(),
                table_index: total_tables,
                total_tables,
                rows_transferred: 0,
                total_rows: None,
                status: TransferStatus::Error,
                error: Some("Transfer ended without a terminal result".to_string()),
                terminal: true,
            }
        })
    }
}

fn emit_progress<F>(emitter: &ProgressEmitter<F>, progress: TransferProgress)
where
    F: FnMut(TransferProgress) + Send,
{
    emitter.emit(progress);
}

async fn emit_terminal_progress<F>(
    emitter: &ProgressEmitter<F>,
    _history: Option<&TransferTaskJournal>,
    progress: TransferProgress,
) where
    F: FnMut(TransferProgress) + Send,
{
    emitter.emit_terminal(progress);
}

fn cancelled_table_counts(
    source: &DatabaseType,
    target: &DatabaseType,
    moved_rows: Option<u64>,
    source_rows: Option<u64>,
) -> (u64, Option<u64>) {
    // Cancellation does not roll back batches already committed to Xugu. Keep
    // the current table's acknowledged writes, never a previous table's count.
    // Preserve the existing terminal-event contract for every other DB pair.
    if super::transfer::mysql_xugu::is_pair(source, target) {
        (moved_rows.unwrap_or(0), source_rows)
    } else {
        (0, None)
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn run_transfer<F>(
    state: Arc<AppState>,
    request: TransferRequest,
    source_db_type: DatabaseType,
    target_db_type: DatabaseType,
    source_pool_key: String,
    target_pool_key: String,
    history: Option<TransferTaskJournal>,
    operation_timeout_secs: Option<u64>,
    progress_callback: F,
) -> TransferProgress
where
    F: FnMut(TransferProgress) + Send,
{
    let transfer_id = request.transfer_id.clone();
    let total_tables = request.tables.len();
    let app = ProgressEmitter::new(progress_callback);

    let (routine_context, package_transfer) = match async {
        // Reject interpreted source/target data before preflight I/O or claiming
        // package approvals. Keep the later check after those awaited steps too.
        super::transfer::check_data_charset_transfer(&state, &request).await?;
        super::transfer::validate_transfer_database_pair(&request, &source_db_type, &target_db_type)?;
        if super::transfer::mysql_xugu::is_pair(&source_db_type, &target_db_type) {
            super::transfer::mysql_xugu::preflight(&state, &request, &source_pool_key, &target_pool_key).await?;
        }
        let routine = crate::schema::oracle_routines::capture_routine_transfer_context(
            &state,
            &request.source_connection_id,
            &request.target_connection_id,
        )
        .await?;
        let mut table_structure =
            if request.oracle_packages.as_ref().is_some_and(|packages| packages.pending_tables.is_some()) {
                Some(
                    super::transfer::build_package_transfer_structure(
                        &state,
                        &request,
                        &source_db_type,
                        &target_db_type,
                        &source_pool_key,
                        &target_pool_key,
                    )
                    .await?,
                )
            } else {
                None
            };
        let packages =
            crate::schema::oracle_routines::claim_transfer_packages(&state, &request, table_structure.as_mut()).await?;
        Ok::<_, crate::schema::oracle_routines::PackageTransferPreflightError>((routine, packages))
    }
    .await
    {
        Ok(context) => context,
        Err(error) => {
            if let Some(journal) = history.as_ref() {
                journal.record_schema_objects_error(false).await;
            }
            super::transfer::clear_cancelled(&transfer_id).await;
            return error.into_progress(&request);
        }
    };

    super::transfer::with_transfer_operation_timeout(operation_timeout_secs, async {
        if let Err(error) = super::transfer::check_data_charset_transfer(&state, &request).await {
            emit_terminal_progress(
                &app,
                history.as_ref(),
                TransferProgress {
                    oracle_package_approval: None,
                    oracle_package_preflight: None,
                    oracle_routine_operation: None,
                    transfer_id: transfer_id.clone(),
                    table: String::new(),
                    table_index: 0,
                    total_tables,
                    rows_transferred: 0,
                    total_rows: None,
                    status: TransferStatus::Error,
                    error: Some(error),
                    terminal: true,
                },
            )
            .await;
            return;
        }
        // Sort tables by FK dependency so referenced tables are transferred first,
        // and keep the foreign key metadata fetched along the way — MySQL-family
        // targets reuse it per table below instead of re-querying it.
        // Skip for external Doris/StarRocks catalogs — the database name does not
        // exist in the default catalog and sorting is unnecessary (no FK constraints).
        let (sorted_tables, known_foreign_keys) = {
            let skip_fk_sort = {
                let configs = state.configs.read().await;
                configs
                    .get(&request.source_connection_id)
                    .and_then(|config| {
                        super::transfer::resolve_external_transfer_catalog_for_config(
                            request.source_catalog.as_deref(),
                            config,
                        )
                    })
                    .is_some()
            };
            if skip_fk_sort {
                (request.tables.clone(), std::collections::HashMap::new())
            } else {
                super::transfer::sort_tables_by_fk_dependency_with_foreign_keys(
                    &state,
                    &request.source_connection_id,
                    &request.source_database,
                    &request.source_schema,
                    &request.tables,
                    true,
                )
                .await
                .unwrap_or_else(|e| {
                    log::warn!("[transfer] failed to sort tables by FK dependency, using original order: {e}");
                    (request.tables.clone(), std::collections::HashMap::new())
                })
            }
        };

        let total_tables = sorted_tables.len();
        log::info!("[transfer] starting transfer_id={} tables={}", transfer_id, total_tables);

        let mut failed_tables: Vec<String> = Vec::new();
        let mut pending_fk_alters: Vec<(String, String)> = Vec::new();
        let mut last_rows_transferred = 0_u64;
        let mut last_total_rows = None;

        // Xugu-only preflight: read every selected definition before writing,
        // then establish independent sequences before tables. Packages and
        // programmable objects follow tables; triggers run last. Other engines
        // retain their existing execution order.
        let xugu_object_plan = if source_db_type == DatabaseType::Xugu
            && target_db_type == DatabaseType::Xugu
            && super::transfer::should_transfer_schema_objects(&source_db_type, &target_db_type, &request)
        {
            let prepared = super::transfer::xugu_objects::prepare(&state, &request, &source_pool_key).await;
            let result = match prepared {
                Ok(plan) => plan.before_tables(&state, &request, &target_pool_key).await.map(|()| plan),
                Err(error) => Err(error),
            };
            match result {
                Ok(plan) => Some(plan),
                Err(error) => {
                    emit_terminal_progress(
                        &app,
                        history.as_ref(),
                        TransferProgress {
                            oracle_package_approval: None,
                            oracle_package_preflight: None,
                            oracle_routine_operation: None,
                            transfer_id: transfer_id.clone(),
                            table: "schema objects".into(),
                            table_index: 0,
                            total_tables,
                            rows_transferred: 0,
                            total_rows: None,
                            status: if error == "Cancelled" {
                                TransferStatus::Cancelled
                            } else {
                                TransferStatus::Error
                            },
                            error: Some(error),
                            terminal: true,
                        },
                    )
                    .await;
                    super::transfer::clear_cancelled(&transfer_id).await;
                    return;
                }
            }
        } else {
            None
        };

        // When drop_target_before_create is true, perform a rename pre-pass in
        // parents_first=false order (children first) so that foreign keys on the
        // backup tables remain intact. The main create/insert pass then runs in
        // parents_first=true order (parents first).
        // Children-first order used by the rename pre-pass, kept for the post-loop backup
        // cleanup: a backup can still be referenced by another backup, so the drops must
        // follow the same order.
        let mut backup_drop_order: Vec<String> = Vec::new();
        let backup_names = if request.drop_target_before_create {
            // Re-sort tables in children-first order for the rename pre-pass
            let (tables_for_rename, _) = super::transfer::sort_tables_by_fk_dependency_with_foreign_keys(
                &state,
                &request.target_connection_id,
                &request.target_database,
                &request.target_schema,
                &sorted_tables,
                false, // parents_first=false: children first
            )
            .await
            .unwrap_or_else(|e| {
                log::warn!("[transfer] failed to sort tables for rename pre-pass, using original order: {e}");
                (sorted_tables.clone(), std::collections::HashMap::new())
            });
            backup_drop_order = tables_for_rename.clone();

            match super::transfer::rename_tables_to_backup(
                &state,
                &request,
                &tables_for_rename,
                target_db_type,
                &target_pool_key,
                |progress| {
                    last_rows_transferred = progress.rows_transferred;
                    last_total_rows = progress.total_rows;
                    emit_progress(&app, progress);
                },
            )
            .await
            {
                Ok(names) => Some(names),
                Err(e) if e == "Cancelled" => {
                    emit_terminal_progress(
                        &app,
                        history.as_ref(),
                        TransferProgress {
                            oracle_package_approval: None,
                            oracle_package_preflight: None,
                            oracle_routine_operation: None,
                            transfer_id: transfer_id.clone(),
                            table: "rename pre-pass".to_string(),
                            table_index: 0,
                            total_tables,
                            rows_transferred: last_rows_transferred,
                            total_rows: last_total_rows,
                            status: TransferStatus::Cancelled,
                            error: None,
                            terminal: true,
                        },
                    )
                    .await;
                    super::transfer::clear_cancelled(&transfer_id).await;
                    return;
                }
                Err(e) => {
                    emit_terminal_progress(
                        &app,
                        history.as_ref(),
                        TransferProgress {
                            oracle_package_approval: None,
                            oracle_package_preflight: None,
                            oracle_routine_operation: None,
                            transfer_id: transfer_id.clone(),
                            table: "rename pre-pass".to_string(),
                            table_index: 0,
                            total_tables,
                            rows_transferred: last_rows_transferred,
                            total_rows: last_total_rows,
                            status: TransferStatus::Error,
                            error: Some(e),
                            terminal: true,
                        },
                    )
                    .await;
                    super::transfer::clear_cancelled(&transfer_id).await;
                    return;
                }
            }
        } else {
            None
        };

        if matches!(source_db_type, DatabaseType::Postgres) && matches!(target_db_type, DatabaseType::Postgres) {
            match super::transfer::transfer_postgres_schema_dependencies(
                &state,
                &request,
                &source_pool_key,
                &target_pool_key,
                |progress| {
                    last_rows_transferred = progress.rows_transferred;
                    last_total_rows = progress.total_rows;
                    emit_progress(&app, progress);
                },
            )
            .await
            {
                Ok(()) => {}
                Err(e) if e == "Cancelled" => {
                    emit_terminal_progress(
                        &app,
                        history.as_ref(),
                        TransferProgress {
                            oracle_package_approval: None,
                            oracle_package_preflight: None,
                            oracle_routine_operation: None,
                            transfer_id: transfer_id.clone(),
                            table: "schema dependencies".to_string(),
                            table_index: 0,
                            total_tables,
                            rows_transferred: last_rows_transferred,
                            total_rows: last_total_rows,
                            status: TransferStatus::Cancelled,
                            error: None,
                            terminal: true,
                        },
                    )
                    .await;
                    super::transfer::clear_cancelled(&transfer_id).await;
                    return;
                }
                Err(e) => {
                    emit_terminal_progress(
                        &app,
                        history.as_ref(),
                        TransferProgress {
                            oracle_package_approval: None,
                            oracle_package_preflight: None,
                            oracle_routine_operation: None,
                            transfer_id: transfer_id.clone(),
                            table: "schema dependencies".to_string(),
                            table_index: 0,
                            total_tables,
                            rows_transferred: last_rows_transferred,
                            total_rows: last_total_rows,
                            status: TransferStatus::Error,
                            error: Some(e),
                            terminal: true,
                        },
                    )
                    .await;
                    super::transfer::clear_cancelled(&transfer_id).await;
                    return;
                }
            }
        }
        // Overwrite clears each target right before copying it, parents first, which cannot
        // clear a table another selected table references. Empty those children first now.
        let overwrite_cleared = match super::transfer::clear_foreign_key_linked_overwrite_targets(
            &state,
            &request,
            &sorted_tables,
            target_db_type,
            &target_pool_key,
        )
        .await
        {
            Ok(cleared) => cleared,
            Err(e) => {
                emit_terminal_progress(
                    &app,
                    history.as_ref(),
                    TransferProgress {
                        oracle_package_approval: None,
                        oracle_package_preflight: None,
                        oracle_routine_operation: None,
                        transfer_id: transfer_id.clone(),
                        table: "overwrite pre-pass".to_string(),
                        table_index: 0,
                        total_tables,
                        rows_transferred: last_rows_transferred,
                        total_rows: last_total_rows,
                        status: TransferStatus::Error,
                        error: Some(e),
                        terminal: true,
                    },
                )
                .await;
                super::transfer::clear_cancelled(&transfer_id).await;
                return;
            }
        };

        for (i, table) in sorted_tables.iter().enumerate() {
            if super::transfer::is_cancelled(&transfer_id).await {
                emit_terminal_progress(
                    &app,
                    history.as_ref(),
                    TransferProgress {
                        oracle_package_approval: None,
                        oracle_package_preflight: None,
                        oracle_routine_operation: None,
                        transfer_id: transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables,
                        rows_transferred: last_rows_transferred,
                        total_rows: last_total_rows,
                        status: TransferStatus::Cancelled,
                        error: None,
                        terminal: true,
                    },
                )
                .await;
                super::transfer::clear_cancelled(&transfer_id).await;
                return;
            }

            log::info!("[transfer] table {}/{}: {}", i + 1, total_tables, table);
            let history_item_index =
                history.as_ref().and_then(|journal| journal.item_index_for_table(table)).unwrap_or(i);
            if let Some(journal) = history.as_ref() {
                journal.start_table(history_item_index).await;
            }
            let mut source_row_count = None;
            let mut moved_row_count = None;
            let history_for_progress = history.as_ref();
            let history_for_count = history.as_ref();
            let result = super::transfer::transfer_table_with_result(
                &state,
                &request,
                table,
                i,
                &source_db_type,
                &target_db_type,
                &source_pool_key,
                &target_pool_key,
                &known_foreign_keys,
                &mut pending_fk_alters,
                backup_names.as_ref(),
                overwrite_cleared.contains(table),
                |progress| {
                    last_rows_transferred = progress.rows_transferred;
                    last_total_rows = progress.total_rows;
                    moved_row_count = Some(progress.rows_transferred);
                    if let Some(journal) = history_for_progress {
                        journal.observe_table_progress(history_item_index, progress.rows_transferred);
                    }
                    emit_progress(&app, progress);
                },
                |source_count| {
                    source_row_count = source_count;
                    if let Some(journal) = history_for_count {
                        journal.observe_source_count(history_item_index, source_count);
                    }
                },
            )
            .await;
            match result {
                Ok(result) => {
                    if let Some(journal) = history.as_ref() {
                        journal
                            .finish_table(
                                history_item_index,
                                TaskItemStatus::Succeeded,
                                result.source_row_count,
                                Some(result.moved_rows),
                            )
                            .await;
                    }
                    emit_progress(
                        &app,
                        TransferProgress {
                            oracle_package_approval: None,
                            oracle_package_preflight: None,
                            oracle_routine_operation: None,
                            transfer_id: transfer_id.clone(),
                            table: table.clone(),
                            table_index: i,
                            total_tables,
                            rows_transferred: result.moved_rows,
                            total_rows: last_total_rows.or(Some(result.moved_rows)),
                            status: TransferStatus::TableDone,
                            error: None,
                            terminal: false,
                        },
                    );
                }
                Err(e) => {
                    if e == "Cancelled" {
                        let (rows_transferred, total_rows) =
                            cancelled_table_counts(&source_db_type, &target_db_type, moved_row_count, source_row_count);
                        if let Some(journal) = history.as_ref() {
                            journal
                                .finish_table(
                                    history_item_index,
                                    TaskItemStatus::Cancelled,
                                    source_row_count,
                                    moved_row_count,
                                )
                                .await;
                        }
                        emit_terminal_progress(
                            &app,
                            history.as_ref(),
                            TransferProgress {
                                oracle_package_approval: None,
                                oracle_package_preflight: None,
                                oracle_routine_operation: None,
                                transfer_id: transfer_id.clone(),
                                table: table.clone(),
                                table_index: i,
                                total_tables,
                                rows_transferred,
                                total_rows,
                                status: TransferStatus::Cancelled,
                                error: None,
                                terminal: true,
                            },
                        )
                        .await;
                        super::transfer::clear_cancelled(&transfer_id).await;
                        return;
                    }
                    if let Some(journal) = history.as_ref() {
                        journal
                            .finish_table(history_item_index, TaskItemStatus::Failed, source_row_count, moved_row_count)
                            .await;
                    }
                    failed_tables.push(table.clone());
                    emit_progress(
                        &app,
                        TransferProgress {
                            oracle_package_approval: None,
                            oracle_package_preflight: None,
                            oracle_routine_operation: None,
                            transfer_id: transfer_id.clone(),
                            table: table.clone(),
                            table_index: i,
                            total_tables,
                            rows_transferred: last_rows_transferred,
                            total_rows: last_total_rows,
                            status: TransferStatus::Error,
                            error: Some(e),
                            terminal: false,
                        },
                    );
                }
            }
        }

        // Add any foreign keys deferred during MySQL-family table creation now that
        // every selected table exists — see transfer_table's use of
        // strip_inline_foreign_key_constraint_lines for why these can't be created
        // inline (a foreign key cycle has no valid CREATE TABLE order at all). The
        // rename pre-pass already freed the backup constraint names, so these re-create
        // the original names without colliding.
        let mut failed_fk_tables: Vec<String> = Vec::new();
        let mut failed_fk_count = 0usize;
        for (table, alter_sql) in &pending_fk_alters {
            if let Err(e) = super::transfer::execute_on_pool(&state, &target_pool_key, alter_sql).await {
                log::warn!("[transfer] failed to add deferred foreign key constraint for {table}: {e}");
                failed_fk_count += 1;
                failed_fk_tables.push(table.clone());
            }
        }
        if failed_fk_count > 0 {
            failed_fk_tables.sort();
            failed_fk_tables.dedup();
            failed_tables.push(format!("{} foreign key(s) on: {}", failed_fk_count, failed_fk_tables.join(", ")));
        }

        // Transfer selected non-table objects (views, procedures, functions,
        // triggers, sequences, events) after the per-table loop. The shared
        // Core decision handles all content modes: DataOnly never
        // transfers schema objects; PG→PG keeps the legacy empty-selection
        // default only when structure participates in the transfer.
        let mut object_outcome = super::transfer::TransferObjectOutcome::default();
        let object_result = if let Some(plan) = xugu_object_plan.as_ref() {
            plan.after_tables(&state, &request, &target_pool_key, &failed_tables, |mut progress| {
                // Object completion is not a copied row. Preserve the table-data
                // counters while reporting the current Xugu schema object.
                progress.rows_transferred = last_rows_transferred;
                progress.total_rows = last_total_rows;
                emit_progress(&app, progress)
            })
            .await
        } else {
            super::transfer::transfer_schema_objects_with_routine_context(
                &state,
                &request,
                &source_pool_key,
                &target_pool_key,
                routine_context.as_ref(),
                |progress| emit_progress(&app, progress),
            )
            .await
        };
        match object_result {
            Ok(outcome) => {
                if let Some(journal) = history.as_ref() {
                    journal.record_object_outcome(&outcome).await;
                }
                object_outcome = outcome;
            }
            Err(e) if e == "Cancelled" => {
                if let Some(journal) = history.as_ref() {
                    journal.record_schema_objects_error(true).await;
                }
                emit_terminal_progress(
                    &app,
                    history.as_ref(),
                    TransferProgress {
                        oracle_package_approval: None,
                        oracle_package_preflight: None,
                        oracle_routine_operation: None,
                        transfer_id: transfer_id.clone(),
                        table: "schema objects".to_string(),
                        table_index: total_tables,
                        total_tables,
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Cancelled,
                        error: None,
                        terminal: true,
                    },
                )
                .await;
                super::transfer::clear_cancelled(&transfer_id).await;
                return;
            }
            Err(e) => {
                if let Some(journal) = history.as_ref() {
                    journal.record_schema_objects_error(false).await;
                }
                failed_tables.push("schema objects".to_string());
                emit_progress(
                    &app,
                    TransferProgress {
                        oracle_package_approval: None,
                        oracle_package_preflight: None,
                        oracle_routine_operation: None,
                        transfer_id: transfer_id.clone(),
                        table: "schema objects".to_string(),
                        table_index: total_tables,
                        total_tables,
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Error,
                        error: Some(e),
                        terminal: false,
                    },
                );
            }
        }
        if !object_outcome.failed.is_empty() {
            failed_tables.push(format!("schema objects ({})", object_outcome.failed.len()));
        }

        if let Some(packages) = &package_transfer {
            // A failed prerequisite leaves its actual table/object results intact;
            // no package step is sent, and unsent steps are not counted as writes.
            let (outcome, package_cancelled, preflight_error) = packages
                .run(&state, &request, failed_tables.is_empty(), |progress| emit_progress(&app, progress))
                .await;
            if let Some(error) = preflight_error {
                failed_tables.push(format!("package preflight: {error}"));
            }
            if !outcome.failed.is_empty() {
                failed_tables.push("package objects".into());
            }
            if let Some(journal) = history.as_ref() {
                journal.record_object_outcome(&outcome).await;
            }
            object_outcome.transferred.extend(outcome.transferred);
            object_outcome.skipped.extend(outcome.skipped);
            object_outcome.failed.extend(outcome.failed);
            if package_cancelled {
                if let Some(journal) = history.as_ref() {
                    journal.record_schema_objects_error(true).await;
                }
                emit_terminal_progress(
                    &app,
                    history.as_ref(),
                    TransferProgress {
                        oracle_package_approval: None,
                        oracle_package_preflight: None,
                        oracle_routine_operation: None,
                        transfer_id: transfer_id.clone(),
                        table: "package objects".into(),
                        table_index: total_tables,
                        total_tables,
                        rows_transferred: last_rows_transferred,
                        total_rows: last_total_rows,
                        status: TransferStatus::Cancelled,
                        error: None,
                        terminal: true,
                    },
                )
                .await;
                super::transfer::clear_cancelled(&transfer_id).await;
                return;
            }
        }

        // The rename pre-pass left one backup per rebuilt table. Drop them only now that
        // every table, every deferred foreign key and every selected schema object has
        // succeeded — a failure anywhere above keeps the originals recoverable under
        // their backup names.
        if let Some(backup_names) = backup_names.as_ref() {
            if failed_tables.is_empty() {
                if let Err(e) = super::transfer::drop_backup_tables(
                    &state,
                    &request,
                    target_db_type,
                    &target_pool_key,
                    backup_names,
                    &backup_drop_order,
                )
                .await
                {
                    failed_tables.push(e);
                }
            } else {
                log::warn!(
                    "[transfer] keeping {} backup table(s) because {} step(s) failed",
                    backup_names.len(),
                    failed_tables.len()
                );
            }
        }
        let skip_suffix = if !object_outcome.skipped.is_empty() && failed_tables.is_empty() {
            format!("，跳过 {} 个已存在对象", object_outcome.skipped.len())
        } else if !object_outcome.skipped.is_empty() {
            format!("；跳过 {} 个已存在对象", object_outcome.skipped.len())
        } else {
            String::new()
        };

        emit_terminal_progress(
            &app,
            history.as_ref(),
            TransferProgress {
                oracle_package_approval: None,
                oracle_package_preflight: None,
                oracle_routine_operation: None,
                transfer_id: transfer_id.clone(),
                table: String::new(),
                table_index: total_tables,
                total_tables,
                rows_transferred: last_rows_transferred,
                total_rows: last_total_rows,
                status: if failed_tables.is_empty() { TransferStatus::Done } else { TransferStatus::Error },
                error: if failed_tables.is_empty() {
                    if skip_suffix.is_empty() {
                        None
                    } else {
                        Some(skip_suffix.clone())
                    }
                } else {
                    Some(format!(
                        "{} table(s) failed: {}{}",
                        failed_tables.len(),
                        failed_tables.iter().take(5).cloned().collect::<Vec<_>>().join(", "),
                        skip_suffix
                    ))
                },
                terminal: true,
            },
        )
        .await;
        super::transfer::clear_cancelled(&transfer_id).await;
    })
    .await;

    super::transfer::clear_cancelled(&transfer_id).await;
    app.take_terminal(&transfer_id, total_tables)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::ConnectionConfig;
    use serde_json::json;

    #[test]
    fn mysql_xugu_cancellation_preserves_only_current_table_acknowledged_rows() {
        assert_eq!(
            cancelled_table_counts(&DatabaseType::Mysql, &DatabaseType::Xugu, Some(413), Some(10_000)),
            (413, Some(10_000))
        );
        assert_eq!(
            cancelled_table_counts(&DatabaseType::Mysql, &DatabaseType::Xugu, None, Some(10_000)),
            (0, Some(10_000))
        );
        assert_eq!(cancelled_table_counts(&DatabaseType::Mysql, &DatabaseType::Xugu, None, None), (0, None));
        for (source, target) in [
            (DatabaseType::Mysql, DatabaseType::Mysql),
            (DatabaseType::Xugu, DatabaseType::Xugu),
            (DatabaseType::Postgres, DatabaseType::Xugu),
        ] {
            assert_eq!(cancelled_table_counts(&source, &target, Some(413), Some(10_000)), (0, None));
        }
    }

    #[tokio::test]
    async fn data_charset_transfer_stops_before_preflight_or_connection_capture() {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_dir(storage, directory.path().join("plugins")));
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id": "legacy", "name": "legacy", "db_type": "mysql", "host": "127.0.0.1",
            "port": 1, "username": "", "password": "", "url_params": "dataCharset=GBK"
        }))
        .unwrap();
        state.configs.write().await.insert("legacy".into(), config);
        for (source, target, source_type, target_type) in [
            ("legacy", "unconfigured", DatabaseType::Mysql, DatabaseType::Xugu),
            ("unconfigured", "legacy", DatabaseType::Mysql, DatabaseType::Mysql),
        ] {
            let request: TransferRequest = serde_json::from_value(json!({
                "transferId": uuid::Uuid::new_v4().to_string(), "sourceConnectionId": source,
                "sourceDatabase": "db", "sourceSchema": "db", "targetConnectionId": target,
                "targetDatabase": "db", "targetSchema": "db", "tables": ["must-not-read"],
                "createTable": false, "content": "dataOnly", "batchSize": 100
            }))
            .unwrap();
            let terminal = run_transfer(
                state.clone(),
                request,
                source_type,
                target_type,
                "no-source-pool".into(),
                "no-target-pool".into(),
                None,
                None,
                |_| panic!("compatibility rejection must precede progress"),
            )
            .await;
            assert!(terminal.terminal);
            assert!(matches!(terminal.status, TransferStatus::Error));
            assert!(terminal.error.unwrap().starts_with(crate::query::mysql_data_charset_policy::TRANSFER_UNSUPPORTED));
            assert!(terminal.oracle_package_approval.is_none());
            assert!(terminal.oracle_package_preflight.is_none());
            assert!(terminal.oracle_routine_operation.is_none());
        }
        assert!(state.connection_pools_snapshot().await.is_empty());
    }

    #[tokio::test]
    async fn unsupported_package_requests_stop_before_connection_capture_or_any_table_work() {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_dir(storage, directory.path().join("plugins")));
        for content in ["structureOnly", "structureAndData", "dataOnly"] {
            let request: TransferRequest = serde_json::from_value(json!({
                "transferId": uuid::Uuid::new_v4().to_string(), "sourceConnectionId": "unconfigured-source",
                "sourceDatabase": "tenant", "sourceSchema": "SOURCE", "targetConnectionId": "unconfigured-target",
                "targetDatabase": "tenant", "targetSchema": "TARGET", "tables": ["must-not-write"],
                "createTable": true, "content": content,
                "objects": [{"objectType":"PACKAGE_BODY", "names":["Pkg.With.Dot😀"]}], "batchSize": 100,
            }))
            .unwrap();
            let terminal = run_transfer(
                state.clone(),
                request,
                DatabaseType::Dameng,
                DatabaseType::Oracle,
                "not-a-source-pool".into(),
                "not-a-target-pool".into(),
                None,
                None,
                |_| panic!("Unsupported package request must stop before progress or writes"),
            )
            .await;
            assert!(terminal.terminal);
            assert!(matches!(terminal.status, TransferStatus::Error));
            assert!(terminal.error.unwrap().contains("actual Oracle or OceanBase Oracle"));
        }
    }

    #[tokio::test]
    async fn empty_data_only_transfer_completes_without_schema_object_progress() {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_dir(storage, directory.path().join("plugins")));

        for id in ["source", "target"] {
            let path = directory.path().join(format!("{id}.db"));
            crate::db::sqlite::connect_path_create_if_missing(path.to_str().unwrap()).await.unwrap();
            let config: ConnectionConfig = serde_json::from_value(json!({
                "id": id,
                "name": id,
                "db_type": "sqlite",
                "host": path.to_str().unwrap(),
                "port": 0,
                "username": "",
                "password": "",
                "database": null,
                "one_time": false,
                "save_password": false,
                "read_only": false
            }))
            .unwrap();
            state.configs.write().await.insert(id.to_string(), config);
        }

        let source_pool = super::super::transfer::ensure_transfer_pool(&state, "source", "main", None).await.unwrap();
        let target_pool = super::super::transfer::ensure_transfer_pool(&state, "target", "main", None).await.unwrap();
        let request: TransferRequest = serde_json::from_value(json!({
            "transferId": uuid::Uuid::new_v4().to_string(),
            "sourceConnectionId": "source",
            "sourceDatabase": "main",
            "sourceSchema": "main",
            "targetConnectionId": "target",
            "targetDatabase": "main",
            "targetSchema": "main",
            "tables": [],
            "createTable": false,
            "dropTargetBeforeCreate": false,
            "dropTargetConfirmed": false,
            "content": "dataOnly",
            "objects": [],
            "mode": "append",
            "batchSize": 1000
        }))
        .unwrap();
        let transfer_id = request.transfer_id.clone();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let observed_for_callback = observed.clone();

        let terminal = run_transfer(
            state,
            request,
            DatabaseType::Sqlite,
            DatabaseType::Sqlite,
            source_pool,
            target_pool,
            None,
            None,
            move |progress| {
                observed_for_callback.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(progress);
            },
        )
        .await;

        assert!(matches!(terminal.status, TransferStatus::Done));
        assert!(terminal.terminal);
        assert!(terminal.error.is_none());
        assert!(
            observed
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .all(|progress| progress.table != "schema objects"),
            "data-only no-op must not emit schema-object progress"
        );
        assert!(!super::super::transfer::is_cancelled(&transfer_id).await);
    }
}
