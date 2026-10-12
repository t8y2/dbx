use dbx_core::connection::AppState;
use dbx_core::favorites::{
    CreateTableFavorite, CreatedTableFavorite, RelinkTableFavorite, TableFavorite, TableFavorites, UpdateTableFavorite,
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn list_table_favorites(state: State<'_, Arc<AppState>>) -> Result<TableFavorites, String> {
    state.storage.list_table_favorites().await
}

#[tauri::command]
pub async fn create_table_favorite(
    state: State<'_, Arc<AppState>>,
    input: CreateTableFavorite,
) -> Result<CreatedTableFavorite, String> {
    state.storage.create_table_favorite(input).await
}

#[tauri::command]
pub async fn update_table_favorite(
    state: State<'_, Arc<AppState>>,
    id: String,
    input: UpdateTableFavorite,
) -> Result<TableFavorite, String> {
    state.storage.update_table_favorite(id, input).await
}

#[tauri::command]
pub async fn relink_table_favorite(
    state: State<'_, Arc<AppState>>,
    id: String,
    input: RelinkTableFavorite,
) -> Result<TableFavorite, String> {
    state.storage.relink_table_favorite(id, input).await
}

#[tauri::command]
pub async fn remove_table_favorite(
    state: State<'_, Arc<AppState>>,
    id: String,
    expected_revision: i64,
) -> Result<(), String> {
    state.storage.remove_table_favorite(id, expected_revision).await
}
