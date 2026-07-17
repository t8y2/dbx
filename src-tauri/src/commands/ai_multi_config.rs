use std::sync::Arc;
use tauri::State;

use super::connection::AppState;
use dbx_core::ai::AiConfigItem;

#[tauri::command]
pub async fn save_ai_configs(state: State<'_, Arc<AppState>>, configs: Vec<AiConfigItem>) -> Result<(), String> {
    state.storage.save_ai_configs(&configs).await
}

#[tauri::command]
pub async fn load_ai_configs(state: State<'_, Arc<AppState>>) -> Result<Vec<AiConfigItem>, String> {
    state.storage.load_ai_configs().await
}

#[tauri::command]
pub async fn set_default_ai_config(state: State<'_, Arc<AppState>>, config_id: String) -> Result<(), String> {
    state.storage.set_default_ai_config(&config_id).await
}

#[tauri::command]
pub async fn save_ai_config_item(state: State<'_, Arc<AppState>>, config: AiConfigItem) -> Result<(), String> {
    state.storage.save_ai_config_item(&config).await
}

#[tauri::command]
pub async fn delete_ai_config(state: State<'_, Arc<AppState>>, config_id: String) -> Result<(), String> {
    state.storage.delete_ai_config(&config_id).await
}
