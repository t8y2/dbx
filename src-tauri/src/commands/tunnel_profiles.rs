use std::sync::Arc;

use dbx_core::models::connection::TransportLayerConfig;
use tauri::State;

use super::connection::AppState;

#[tauri::command]
pub async fn load_tunnel_profiles(state: State<'_, Arc<AppState>>) -> Result<Vec<TransportLayerConfig>, String> {
    state.storage.load_tunnel_profiles().await
}

#[tauri::command]
pub async fn save_tunnel_profiles(
    state: State<'_, Arc<AppState>>,
    profiles: Vec<TransportLayerConfig>,
) -> Result<(), String> {
    state.storage.save_tunnel_profiles(&profiles).await
}

#[tauri::command]
pub async fn test_tunnel_profile(
    state: State<'_, Arc<AppState>>,
    profile: TransportLayerConfig,
) -> Result<String, String> {
    state.test_tunnel_profile(&profile).await
}
