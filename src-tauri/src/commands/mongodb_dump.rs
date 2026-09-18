use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::{ensure_connection_writable, AppState};
use dbx_core::mongodb_dump::{
    self, MongoDatabaseDumpProgress, MongoDatabaseDumpRequest, MongoDatabaseRestoreRequest, MongoDumpCatalog,
    MongoRestoreSourcePreview, MongoRestoreSourceRequest,
};

#[tauri::command]
pub async fn inspect_mongodb_database_dump(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<MongoDumpCatalog, String> {
    mongodb_dump::inspect_mongodb_database_dump(&state, &connection_id, &database).await
}

#[tauri::command]
pub async fn prepare_mongodb_restore_source(
    request: MongoRestoreSourceRequest,
) -> Result<MongoRestoreSourcePreview, String> {
    mongodb_dump::prepare_mongodb_restore_source(request).await
}

#[tauri::command]
pub fn release_mongodb_restore_source(source_ref: String) -> bool {
    mongodb_dump::release_mongodb_restore_source(&source_ref)
}

#[tauri::command]
pub async fn dump_mongodb_database(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: MongoDatabaseDumpRequest,
) -> Result<MongoDatabaseDumpProgress, String> {
    let state = state.inner().clone();
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        runtime.block_on(async move {
            let result = mongodb_dump::dump_mongodb_database(
                &state,
                &request,
                |id| {
                    let id = id.to_string();
                    Box::pin(async move { dbx_core::transfer::is_cancelled(&id).await })
                },
                |progress| {
                    let _ = app.emit("mongo-database-dump-progress", progress);
                },
            )
            .await;
            dbx_core::transfer::clear_cancelled(&request.task_id).await;
            result
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn restore_mongodb_database(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: MongoDatabaseRestoreRequest,
) -> Result<MongoDatabaseDumpProgress, String> {
    ensure_connection_writable(&state, &request.connection_id, "Restore").await?;
    let state = state.inner().clone();
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        runtime.block_on(async move {
            let result = mongodb_dump::restore_mongodb_database(
                &state,
                &request,
                |id| {
                    let id = id.to_string();
                    Box::pin(async move { dbx_core::transfer::is_cancelled(&id).await })
                },
                |progress| {
                    let _ = app.emit("mongo-database-dump-progress", progress);
                },
            )
            .await;
            dbx_core::transfer::clear_cancelled(&request.task_id).await;
            result
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cancel_mongodb_database_dump(task_id: String) -> bool {
    dbx_core::transfer::set_cancelled(&task_id).await;
    true
}
