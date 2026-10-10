use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::{ensure_connection_writable, AppState};

// Re-export types and functions used by other modules
use dbx_core::models::connection::DatabaseType;
use dbx_core::persistence::task_history::{
    TaskHistoryStorageError, TaskItemStatus, TaskLifecycleOwner, TransferTaskJournal,
};
pub use dbx_core::transfer::{
    get_db_type, TransferOwnershipPreview, TransferProgress, TransferRequest, TransferStatus,
};

fn emit_progress(app: &AppHandle, progress: TransferProgress) {
    let _ = app.emit("transfer-progress", progress);
}

async fn emit_terminal_progress(app: &AppHandle, history: Option<&TransferTaskJournal>, progress: TransferProgress) {
    if let Some(history) = history {
        history.finish(&progress).await;
    }
    emit_progress(app, progress);
}

async fn report_unexecuted_objects(
    app: &AppHandle,
    request: &TransferRequest,
    outcome: &mut dbx_core::transfer::TransferObjectOutcome,
    reason: &str,
    history: Option<&TransferTaskJournal>,
    all_selected_are_accounted_for: bool,
) {
    for result in
        dbx_core::transfer::mark_unexecuted_transfer_objects(request, outcome, reason, all_selected_are_accounted_for)
    {
        emit_progress(
            app,
            TransferProgress {
                transfer_id: request.transfer_id.clone(),
                table: format!("schema object: {}", result.name),
                table_index: request.tables.len(),
                total_tables: request.tables.len(),
                rows_transferred: 0,
                total_rows: None,
                status: TransferStatus::Running,
                error: None,
                terminal: false,
                object_result: Some(result),
            },
        );
    }
    if let Some(history) = history {
        history.record_object_outcome(outcome).await;
    }
}

#[tauri::command]
pub async fn start_transfer(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    mut request: TransferRequest,
    database_link_credentials: Option<Vec<dbx_core::transfer::TransferDatabaseLinkCredential>>,
) -> Result<(), String> {
    request.database_link_credentials = database_link_credentials.unwrap_or_default();
    let state = state.inner().clone();
    let transfer_id = request.transfer_id.clone();

    // Reject transfer early if the target connection is read-only — writing to it is inherently required
    ensure_connection_writable(&state, &request.target_connection_id, "Transfer").await?;

    // Validate connections exist
    let source_db_type = get_db_type(&state, &request.source_connection_id).await?;
    let target_db_type = get_db_type(&state, &request.target_connection_id).await?;
    dbx_core::transfer::validate_transfer_request(&request)?;
    dbx_core::transfer::validate_transfer_database_pair(&request, &source_db_type, &target_db_type)?;

    // `drop_target_before_create` rebuilds target tables; gate the dialect and require an
    // explicit confirmation for production databases.
    dbx_core::transfer_rebuild::ensure_drop_target_allowed(
        &state,
        &request.target_connection_id,
        &request.target_database,
        target_db_type,
        request.drop_target_before_create,
        request.drop_target_confirmed,
    )
    .await?;

    // Cross-family object transfers are validated inside transfer_schema_objects:
    // only mechanically rewriteable kinds (views, sequences) are allowed.
    // Structure-only data transfer is unsupported for MongoDB.
    if matches!(request.content, dbx_core::transfer::TransferContent::StructureOnly)
        && (matches!(source_db_type, DatabaseType::MongoDb) || matches!(target_db_type, DatabaseType::MongoDb))
    {
        return Err("MongoDB 暂不支持仅结构传输".to_string());
    }

    // External Doris/StarRocks catalogs: pool is created with `catalog=` URL
    // setup (SET catalog) and without USE <external-db>. See ensure_transfer_pool.
    let source_pool_key = dbx_core::transfer::ensure_transfer_pool(
        &state,
        &request.source_connection_id,
        &request.source_database,
        request.source_catalog.as_deref(),
    )
    .await?;
    let target_pool_key = dbx_core::transfer::ensure_transfer_pool(
        &state,
        &request.target_connection_id,
        &request.target_database,
        request.target_catalog.as_deref(),
    )
    .await?;

    let history = match TransferTaskJournal::accept(&state.storage, &state, &request, TaskLifecycleOwner::Tauri).await {
        Ok(history) => history,
        Err(TaskHistoryStorageError::RunIdConflict) => return Err("TRANSFER_RUN_ID_CONFLICT".to_string()),
        Err(error) => return Err(error.code().to_string()),
    };

    tokio::spawn(async move {
        let preflight = async {
            dbx_core::transfer::ensure_transfer_source_types_supported(&state, &request, &source_pool_key).await?;
            dbx_core::transfer::ensure_transfer_schema_objects_ready(
                &state,
                &request,
                &source_pool_key,
                &target_pool_key,
            )
            .await
        }
        .await;
        if let Err(error) = preflight {
            report_unexecuted_objects(
                &app,
                &request,
                &mut dbx_core::transfer::TransferObjectOutcome::default(),
                "Preflight did not complete; no selected schema object was executed",
                history.as_ref(),
                true,
            )
            .await;
            emit_terminal_progress(
                &app,
                history.as_ref(),
                TransferProgress {
                    transfer_id: transfer_id.clone(),
                    table: "schema objects".into(),
                    table_index: 0,
                    total_tables: request.tables.len(),
                    rows_transferred: 0,
                    total_rows: None,
                    status: if dbx_core::transfer::is_cancelled(&transfer_id).await {
                        TransferStatus::Cancelled
                    } else {
                        TransferStatus::Error
                    },
                    error: Some(error),
                    terminal: true,
                    object_result: None,
                },
            )
            .await;
            dbx_core::transfer::clear_cancelled(&transfer_id).await;
            return;
        }
        let mut observed_prerequisites = dbx_core::transfer::TransferObjectOutcome::default();
        let prerequisites = dbx_core::transfer::transfer_schema_prerequisites(
            &state,
            &request,
            &source_pool_key,
            &target_pool_key,
            |progress| {
                if let Some(result) = &progress.object_result {
                    observed_prerequisites.object_results.push(result.clone());
                }
                emit_progress(&app, progress)
            },
        )
        .await;
        let mut prerequisite_outcome;
        let prerequisite_error = match prerequisites {
            Ok(outcome) => {
                if let Some(journal) = history.as_ref() {
                    journal.record_object_outcome(&outcome).await;
                }
                let error = if !dbx_core::transfer::has_transfer_object_blockers(&outcome) {
                    None
                } else {
                    Some("Type prerequisite failed; tables and dependent programs were not executed".to_string())
                };
                prerequisite_outcome = outcome;
                error
            }
            Err(error) => {
                prerequisite_outcome = observed_prerequisites;
                Some(error)
            }
        };
        if let Some(error) = prerequisite_error {
            report_unexecuted_objects(
                &app,
                &request,
                &mut prerequisite_outcome,
                "Prerequisite stage did not complete; remaining selected objects were not executed",
                history.as_ref(),
                true,
            )
            .await;
            emit_terminal_progress(
                &app,
                history.as_ref(),
                TransferProgress {
                    transfer_id: transfer_id.clone(),
                    table: "type prerequisites".into(),
                    table_index: 0,
                    total_tables: request.tables.len(),
                    rows_transferred: 0,
                    total_rows: None,
                    status: if dbx_core::transfer::is_cancelled(&transfer_id).await {
                        TransferStatus::Cancelled
                    } else {
                        TransferStatus::Error
                    },
                    error: Some(error),
                    terminal: true,
                    object_result: None,
                },
            )
            .await;
            dbx_core::transfer::clear_cancelled(&transfer_id).await;
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
                        dbx_core::transfer::resolve_external_transfer_catalog_for_config(
                            request.source_catalog.as_deref(),
                            config,
                        )
                    })
                    .is_some()
            };
            if skip_fk_sort {
                (request.tables.clone(), std::collections::HashMap::new())
            } else {
                dbx_core::transfer::sort_tables_by_fk_dependency_with_foreign_keys(
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
            let (tables_for_rename, _) = dbx_core::transfer::sort_tables_by_fk_dependency_with_foreign_keys(
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

            match dbx_core::transfer::rename_tables_to_backup(
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
                            transfer_id: transfer_id.clone(),
                            table: "rename pre-pass".to_string(),
                            table_index: 0,
                            total_tables,
                            rows_transferred: last_rows_transferred,
                            total_rows: last_total_rows,
                            status: TransferStatus::Cancelled,
                            error: None,
                            terminal: true,
                            object_result: None,
                        },
                    )
                    .await;
                    dbx_core::transfer::clear_cancelled(&transfer_id).await;
                    return;
                }
                Err(e) => {
                    emit_terminal_progress(
                        &app,
                        history.as_ref(),
                        TransferProgress {
                            transfer_id: transfer_id.clone(),
                            table: "rename pre-pass".to_string(),
                            table_index: 0,
                            total_tables,
                            rows_transferred: last_rows_transferred,
                            total_rows: last_total_rows,
                            status: TransferStatus::Error,
                            error: Some(e),
                            terminal: true,
                            object_result: None,
                        },
                    )
                    .await;
                    dbx_core::transfer::clear_cancelled(&transfer_id).await;
                    return;
                }
            }
        } else {
            None
        };

        if matches!(source_db_type, dbx_core::models::connection::DatabaseType::Postgres)
            && matches!(target_db_type, dbx_core::models::connection::DatabaseType::Postgres)
        {
            match dbx_core::transfer::transfer_postgres_schema_dependencies(
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
                            transfer_id: transfer_id.clone(),
                            table: "schema dependencies".to_string(),
                            table_index: 0,
                            total_tables,
                            rows_transferred: last_rows_transferred,
                            total_rows: last_total_rows,
                            status: TransferStatus::Cancelled,
                            error: None,
                            terminal: true,
                            object_result: None,
                        },
                    )
                    .await;
                    dbx_core::transfer::clear_cancelled(&transfer_id).await;
                    return;
                }
                Err(e) => {
                    emit_terminal_progress(
                        &app,
                        history.as_ref(),
                        TransferProgress {
                            transfer_id: transfer_id.clone(),
                            table: "schema dependencies".to_string(),
                            table_index: 0,
                            total_tables,
                            rows_transferred: last_rows_transferred,
                            total_rows: last_total_rows,
                            status: TransferStatus::Error,
                            error: Some(e),
                            terminal: true,
                            object_result: None,
                        },
                    )
                    .await;
                    dbx_core::transfer::clear_cancelled(&transfer_id).await;
                    return;
                }
            }
        }
        // Overwrite clears each target right before copying it, parents first, which cannot
        // clear a table another selected table references. Empty those children first now.
        let overwrite_cleared = match dbx_core::transfer::clear_foreign_key_linked_overwrite_targets(
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
                        transfer_id: transfer_id.clone(),
                        table: "overwrite pre-pass".to_string(),
                        table_index: 0,
                        total_tables,
                        rows_transferred: last_rows_transferred,
                        total_rows: last_total_rows,
                        status: TransferStatus::Error,
                        error: Some(e),
                        terminal: true,
                        object_result: None,
                    },
                )
                .await;
                dbx_core::transfer::clear_cancelled(&transfer_id).await;
                return;
            }
        };

        for (i, table) in sorted_tables.iter().enumerate() {
            if dbx_core::transfer::is_cancelled(&transfer_id).await {
                emit_terminal_progress(
                    &app,
                    history.as_ref(),
                    TransferProgress {
                        transfer_id: transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables,
                        rows_transferred: last_rows_transferred,
                        total_rows: last_total_rows,
                        status: TransferStatus::Cancelled,
                        error: None,
                        terminal: true,
                        object_result: None,
                    },
                )
                .await;
                dbx_core::transfer::clear_cancelled(&transfer_id).await;
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
            let result = dbx_core::transfer::transfer_table_with_result(
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
                            transfer_id: transfer_id.clone(),
                            table: table.clone(),
                            table_index: i,
                            total_tables,
                            rows_transferred: result.moved_rows,
                            total_rows: last_total_rows.or(Some(result.moved_rows)),
                            status: TransferStatus::TableDone,
                            error: None,
                            terminal: false,
                            object_result: None,
                        },
                    );
                }
                Err(e) => {
                    if e == "Cancelled" {
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
                                transfer_id: transfer_id.clone(),
                                table: table.clone(),
                                table_index: i,
                                total_tables,
                                rows_transferred: 0,
                                total_rows: None,
                                status: TransferStatus::Cancelled,
                                error: None,
                                terminal: true,
                                object_result: None,
                            },
                        )
                        .await;
                        dbx_core::transfer::clear_cancelled(&transfer_id).await;
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
                            transfer_id: transfer_id.clone(),
                            table: table.clone(),
                            table_index: i,
                            total_tables,
                            rows_transferred: last_rows_transferred,
                            total_rows: last_total_rows,
                            status: TransferStatus::Error,
                            error: Some(e),
                            terminal: false,
                            object_result: None,
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
            if let Err(e) = dbx_core::transfer::execute_on_pool(&state, &target_pool_key, alter_sql).await {
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
        let mut object_outcome = prerequisite_outcome;
        let mut observed_objects = dbx_core::transfer::TransferObjectOutcome::default();
        let tables_blocked_objects =
            dbx_core::transfer::has_transfer_type_prerequisites(&request) && !failed_tables.is_empty();
        let exact_object_progress =
            matches!(source_db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng)
                && dbx_core::transfer::is_same_transfer_family(&source_db_type, &target_db_type);
        let schema_objects = if tables_blocked_objects {
            Err("Selected table transfer failed; dependent programs and deferred TYPE BODY were not executed"
                .to_string())
        } else {
            if let Some(journal) = history.as_ref() {
                journal.start_legacy_schema_objects().await;
            }
            dbx_core::transfer::transfer_schema_objects(
                &state,
                &request,
                &source_pool_key,
                &target_pool_key,
                |progress| {
                    if let Some(result) = &progress.object_result {
                        observed_objects.object_results.push(result.clone());
                    }
                    emit_progress(&app, progress)
                },
            )
            .await
        };
        match schema_objects {
            Ok(outcome) => {
                if let Some(journal) = history.as_ref() {
                    journal.record_object_outcome(&outcome).await;
                }
                object_outcome.transferred.extend(outcome.transferred);
                object_outcome.skipped.extend(outcome.skipped);
                object_outcome.failed.extend(outcome.failed);
                object_outcome.object_results.extend(outcome.object_results);
                report_unexecuted_objects(
                    &app,
                    &request,
                    &mut object_outcome,
                    "An earlier schema object stage did not complete; this selected object was not executed",
                    history.as_ref(),
                    true,
                )
                .await;
            }
            Err(e) if e == "Cancelled" || dbx_core::transfer::is_cancelled(&transfer_id).await => {
                object_outcome.object_results.extend(observed_objects.object_results);
                report_unexecuted_objects(
                    &app,
                    &request,
                    &mut object_outcome,
                    "Transfer was cancelled; this selected object was not executed",
                    history.as_ref(),
                    exact_object_progress,
                )
                .await;
                if let Some(journal) = history.as_ref() {
                    journal.record_schema_objects_error(true).await;
                }
                emit_terminal_progress(
                    &app,
                    history.as_ref(),
                    TransferProgress {
                        transfer_id: transfer_id.clone(),
                        table: "schema objects".to_string(),
                        table_index: total_tables,
                        total_tables,
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Cancelled,
                        error: Some(e),
                        terminal: true,
                        object_result: None,
                    },
                )
                .await;
                dbx_core::transfer::clear_cancelled(&transfer_id).await;
                return;
            }
            Err(e) => {
                object_outcome.object_results.extend(observed_objects.object_results);
                report_unexecuted_objects(
                    &app,
                    &request,
                    &mut object_outcome,
                    "Schema object stage did not complete; this selected object was not executed",
                    history.as_ref(),
                    tables_blocked_objects || exact_object_progress,
                )
                .await;
                if let Some(journal) = history.as_ref() {
                    journal.record_schema_objects_error(false).await;
                }
                failed_tables.push("schema objects".to_string());
                emit_progress(
                    &app,
                    TransferProgress {
                        transfer_id: transfer_id.clone(),
                        table: "schema objects".to_string(),
                        table_index: total_tables,
                        total_tables,
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Error,
                        error: Some(e),
                        terminal: false,
                        object_result: None,
                    },
                );
            }
        }
        if dbx_core::transfer::is_cancelled(&transfer_id).await {
            let error = object_outcome
                .object_results
                .iter()
                .filter_map(|result| result.error.as_deref())
                .collect::<Vec<_>>()
                .join("; ");
            if let Some(journal) = history.as_ref() {
                journal.record_schema_objects_error(true).await;
            }
            emit_terminal_progress(
                &app,
                history.as_ref(),
                TransferProgress {
                    transfer_id: transfer_id.clone(),
                    table: "schema objects".into(),
                    table_index: total_tables,
                    total_tables,
                    rows_transferred: 0,
                    total_rows: None,
                    status: TransferStatus::Cancelled,
                    error: Some(if error.is_empty() { "Transfer cancelled".into() } else { error }),
                    terminal: true,
                    object_result: None,
                },
            )
            .await;
            dbx_core::transfer::clear_cancelled(&transfer_id).await;
            return;
        }
        if !object_outcome.failed.is_empty() {
            failed_tables.push(format!("schema objects ({})", object_outcome.failed.len()));
        }
        let not_started = object_outcome.object_results.iter().filter(|result| result.status == "not_started").count();
        if not_started > 0 {
            failed_tables.push(format!("schema objects not executed ({not_started})"));
        }

        // The rename pre-pass left one backup per rebuilt table. Drop them only now that
        // every table, every deferred foreign key and every selected schema object has
        // succeeded — a failure anywhere above keeps the originals recoverable under
        // their backup names.
        if let Some(backup_names) = backup_names.as_ref() {
            if failed_tables.is_empty() {
                if let Err(e) = dbx_core::transfer::drop_backup_tables(
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
                        "{} transfer stage(s) did not complete: {}{}",
                        failed_tables.len(),
                        failed_tables.iter().take(5).cloned().collect::<Vec<_>>().join(", "),
                        skip_suffix
                    ))
                },
                terminal: true,
                object_result: None,
            },
        )
        .await;
        dbx_core::transfer::clear_cancelled(&transfer_id).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn preview_transfer_ownership(
    state: State<'_, Arc<AppState>>,
    request: TransferRequest,
) -> Result<TransferOwnershipPreview, String> {
    let state = state.inner().clone();
    let source_db_type = get_db_type(&state, &request.source_connection_id).await?;
    let target_db_type = get_db_type(&state, &request.target_connection_id).await?;
    dbx_core::transfer::validate_transfer_request(&request)?;
    dbx_core::transfer::validate_transfer_database_pair(&request, &source_db_type, &target_db_type)?;
    let source_pool_key = dbx_core::transfer::ensure_transfer_pool(
        &state,
        &request.source_connection_id,
        &request.source_database,
        request.source_catalog.as_deref(),
    )
    .await?;
    let target_pool_key = dbx_core::transfer::ensure_transfer_pool(
        &state,
        &request.target_connection_id,
        &request.target_database,
        request.target_catalog.as_deref(),
    )
    .await?;

    dbx_core::transfer::preview_transfer_ownership(
        &state,
        &request,
        &source_db_type,
        &target_db_type,
        &source_pool_key,
        &target_pool_key,
    )
    .await
}

#[tauri::command]
pub async fn cancel_transfer(transfer_id: String) -> Result<(), String> {
    dbx_core::transfer::set_cancelled(&transfer_id).await;
    Ok(())
}

/// Sort table names by foreign key dependency.
/// `parents_first: true` → parent tables first (insert/export order).
/// `parents_first: false` → child tables first (drop order).
#[allow(dead_code)]
#[tauri::command]
pub async fn sort_tables_by_fk_dependency(
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    tables: Vec<String>,
    parents_first: bool,
) -> Result<Vec<String>, String> {
    dbx_core::transfer::sort_tables_by_fk_dependency(&state, &connection_id, &database, &schema, &tables, parents_first)
        .await
}
