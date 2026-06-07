use std::sync::Arc;
use tauri::State;

use dbx_core::connection::AppState;
use dbx_core::saved_sql::{SavedSqlFile, SavedSqlFolder, SavedSqlLibrary};

#[tauri::command]
pub async fn load_saved_sql_library(state: State<'_, Arc<AppState>>) -> Result<SavedSqlLibrary, String> {
    state.storage.load_saved_sql_library().await
}

#[tauri::command]
pub async fn save_saved_sql_folder(
    state: State<'_, Arc<AppState>>,
    folder: SavedSqlFolder,
) -> Result<SavedSqlFolder, String> {
    state.storage.save_saved_sql_folder(&folder).await?;
    Ok(folder)
}

#[tauri::command]
pub async fn delete_saved_sql_folder(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_saved_sql_folder(&id).await
}

#[tauri::command]
pub async fn save_saved_sql_file(state: State<'_, Arc<AppState>>, file: SavedSqlFile) -> Result<SavedSqlFile, String> {
    state.storage.save_saved_sql_file(&file).await?;
    Ok(file)
}

#[tauri::command]
pub async fn delete_saved_sql_file(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_saved_sql_file(&id).await
}
