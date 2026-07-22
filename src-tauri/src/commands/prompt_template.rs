use std::sync::Arc;
use tauri::State;

use dbx_core::prompt_template::PromptTemplate;

use super::connection::AppState;

#[tauri::command]
pub async fn load_prompt_templates(state: State<'_, Arc<AppState>>) -> Result<Vec<PromptTemplate>, String> {
    state.storage.load_prompt_templates().await
}

#[tauri::command]
pub async fn save_prompt_template(
    state: State<'_, Arc<AppState>>,
    id: String,
    name: String,
    content: String,
) -> Result<PromptTemplate, String> {
    state.storage.save_prompt_template(&id, &name, &content).await
}

#[tauri::command]
pub async fn delete_prompt_template(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_prompt_template(&id).await
}

#[tauri::command]
pub async fn get_ai_global_custom_instructions(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    state.storage.load_ai_global_custom_instructions().await
}

#[tauri::command]
pub async fn set_ai_global_custom_instructions(state: State<'_, Arc<AppState>>, content: String) -> Result<(), String> {
    state.storage.save_ai_global_custom_instructions(&content).await
}
