use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::{ensure_connection_writable, AppState};

// Re-export types and functions used by other modules
use dbx_core::models::connection::DatabaseType;
use dbx_core::persistence::task_history::{TaskHistoryStorageError, TaskLifecycleOwner, TransferTaskJournal};
pub use dbx_core::transfer::{get_db_type, TransferOwnershipPreview, TransferProgress, TransferRequest};

fn emit_progress(app: &AppHandle, progress: TransferProgress) {
    let _ = app.emit("transfer-progress", progress);
}

async fn emit_terminal_progress(app: &AppHandle, history: Option<&TransferTaskJournal>, progress: TransferProgress) {
    if let Some(history) = history {
        history.finish(&progress).await;
    }
    emit_progress(app, progress);
}

#[tauri::command]
pub async fn start_transfer(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: TransferRequest,
    operation_timeout_secs: Option<u64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    dbx_core::transfer::check_data_charset_transfer(&state, &request).await?;
    dbx_core::transfer::validate_transfer_operation_timeout(operation_timeout_secs)?;
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

    dbx_core::transfer::with_transfer_operation_timeout(
        operation_timeout_secs,
        dbx_core::transfer::ensure_transfer_source_types_supported(&state, &request, &source_pool_key),
    )
    .await?;

    let history = match TransferTaskJournal::accept(&state.storage, &state, &request, TaskLifecycleOwner::Tauri).await {
        Ok(history) => history,
        Err(TaskHistoryStorageError::RunIdConflict) => return Err("TRANSFER_RUN_ID_CONFLICT".to_string()),
        Err(error) => return Err(error.code().to_string()),
    };

    tokio::spawn(async move {
        let terminal = dbx_core::transfer_runner::run_transfer(
            state,
            request,
            source_db_type,
            target_db_type,
            source_pool_key,
            target_pool_key,
            history.clone(),
            operation_timeout_secs,
            |progress| emit_progress(&app, progress),
        )
        .await;
        emit_terminal_progress(&app, history.as_ref(), terminal).await;
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
