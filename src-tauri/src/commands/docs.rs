use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use dbx_core::connection::AppState;
// `apply_annotations` is NOT re-exported at `dbx_core::docs` — that module's
// `pub use` list covers collector, color, dbml, keys, relations and snapshot,
// but not annotations. It must come from the submodule path.
use dbx_core::docs::annotations::{
    apply_annotations, load_annotations, resolve_notes_path, save_annotations, AnnotationFile,
};
use dbx_core::docs::{collect_snapshot, CollectOptions, SchemaSnapshot};
use dbx_core::models::connection::ConnectionConfig;
use tauri::State;

async fn connection_of(state: &Arc<AppState>, connection_id: &str) -> Result<ConnectionConfig, String> {
    let configs = state.configs.read().await;
    configs.get(connection_id).cloned().ok_or_else(|| format!("Connection {connection_id} not found."))
}

/// The notes file for a connection, resolved against DBX's data directory.
///
/// `AppState.storage.data_dir()` is the directory DBX is actually using — it
/// honours a custom data dir, which a fresh `app_data_dir()` lookup would not.
/// (`dbx-mcp::paths::app_data_dir()` is NOT available here: src-tauri does not
/// depend on dbx-mcp.)
async fn notes_path_of(state: &Arc<AppState>, connection_id: &str) -> Result<std::path::PathBuf, String> {
    let config = connection_of(state, connection_id).await?;
    Ok(resolve_notes_path(&config.id, config.docs_notes_path.as_deref(), state.storage.data_dir()))
}

/// Collect a RAW snapshot — annotations are applied separately, so the
/// frontend can re-derive after an edit without touching the database.
#[tauri::command]
pub async fn docs_collect_snapshot(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schemas: Vec<String>,
    tables: Vec<String>,
    project_name: Option<String>,
) -> Result<SchemaSnapshot, String> {
    let config = connection_of(&state, &connection_id).await?;
    let options =
        CollectOptions { database, schemas, tables, project_name: project_name.unwrap_or_else(|| config.name.clone()) };
    collect_snapshot(&state, &config, &options, &|_progress| {}, &AtomicBool::new(false)).await
}

#[tauri::command]
pub async fn docs_load_annotations(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Option<AnnotationFile>, String> {
    let path = notes_path_of(&state, &connection_id).await?;
    load_annotations(&path)
}

/// Apply annotations to a raw snapshot. Pure — no database access.
///
/// This exists so the `shadowedNote` rule has exactly ONE implementation.
/// Re-implementing it in TypeScript to update the view optimistically is the
/// drift this feature has repeatedly suffered from.
#[tauri::command]
pub async fn docs_apply_annotations(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    snapshot: SchemaSnapshot,
    annotations: AnnotationFile,
) -> Result<SchemaSnapshot, String> {
    let config = connection_of(&state, &connection_id).await?;
    let mut applied = snapshot;
    apply_annotations(&mut applied, &annotations, config.db_type);
    Ok(applied)
}

#[tauri::command]
pub async fn docs_save_annotations(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    annotations: AnnotationFile,
) -> Result<(), String> {
    let path = notes_path_of(&state, &connection_id).await?;
    save_annotations(&path, &annotations)
}
