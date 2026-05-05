use std::sync::Arc;
use tauri::{Emitter, AppHandle, State};

use super::connection::AppState;
pub use dbx_core::ai::*;

#[tauri::command]
pub async fn ai_test_connection(config: AiConfig) -> Result<String, String> {
    dbx_core::ai::test_connection_core(&config).await
}

#[tauri::command]
pub async fn save_ai_config(
    state: State<'_, Arc<AppState>>,
    config: AiConfig,
) -> Result<(), String> {
    state.storage.save_ai_config(&config).await
}

#[tauri::command]
pub async fn load_ai_config(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<AiConfig>, String> {
    state.storage.load_ai_config().await
}

#[tauri::command]
pub async fn ai_complete(request: AiCompletionRequest) -> Result<String, String> {
    dbx_core::ai::complete(&request).await
}

#[tauri::command]
pub async fn ai_stream(
    app: AppHandle,
    session_id: String,
    request: AiCompletionRequest,
) -> Result<(), String> {
    let cancelled = dbx_core::ai::register_stream(&session_id).await;

    let result = dbx_core::ai::stream(&session_id, &request, &cancelled, |chunk| {
        let _ = app.emit("ai-stream-chunk", &chunk);
    })
    .await;

    dbx_core::ai::unregister_stream(&session_id).await;
    result
}

#[tauri::command]
pub async fn ai_cancel_stream(session_id: String) -> Result<bool, String> {
    Ok(dbx_core::ai::cancel_stream(&session_id).await)
}

#[tauri::command]
pub async fn save_ai_conversation(
    state: State<'_, Arc<AppState>>,
    conversation: AiConversation,
) -> Result<(), String> {
    state.storage.save_ai_conversation(&conversation).await
}

#[tauri::command]
pub async fn load_ai_conversations(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<AiConversation>, String> {
    state.storage.load_ai_conversations().await
}

#[tauri::command]
pub async fn delete_ai_conversation(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    state.storage.delete_ai_conversation(&id).await
}
