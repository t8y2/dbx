use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::ssh_terminal::{SshProfile, SshTerminalDriverManifest, SshTerminalEvent, SshTerminalSize};

#[tauri::command]
pub async fn list_ssh_profiles(state: State<'_, Arc<AppState>>) -> Result<Vec<SshProfile>, String> {
    state.storage.load_ssh_profiles().await
}

#[tauri::command]
pub async fn save_ssh_profile(state: State<'_, Arc<AppState>>, profile: SshProfile) -> Result<SshProfile, String> {
    state.storage.save_ssh_profile(&profile).await
}

#[tauri::command]
pub async fn delete_ssh_profile(state: State<'_, Arc<AppState>>, profile_id: String) -> Result<bool, String> {
    state.storage.delete_ssh_profile(&profile_id).await
}

#[tauri::command]
pub fn list_ssh_terminal_drivers(state: State<'_, Arc<AppState>>) -> Vec<SshTerminalDriverManifest> {
    state.ssh_terminal.list_drivers()
}

#[tauri::command]
pub async fn test_ssh_terminal_profile(state: State<'_, Arc<AppState>>, profile: SshProfile) -> Result<(), String> {
    let known_hosts_path = state.storage.data_dir().join("known_hosts");
    let started = state
        .ssh_terminal
        .start(&profile, known_hosts_path, SshTerminalSize { columns: 80, rows: 24, pixel_width: 0, pixel_height: 0 })
        .await?;
    state.ssh_terminal.close(&started.id).await?;
    Ok(())
}

#[tauri::command]
pub async fn open_ssh_terminal(
    state: State<'_, Arc<AppState>>,
    profile_id: String,
    size: SshTerminalSize,
    on_event: Channel<SshTerminalEvent>,
) -> Result<String, String> {
    let profile = state
        .storage
        .load_ssh_profiles()
        .await?
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "SSH profile was not found".to_string())?;
    let known_hosts_path = state.storage.data_dir().join("known_hosts");
    let mut started = state.ssh_terminal.start(&profile, known_hosts_path, size).await?;
    let session_id = started.id.clone();
    let cleanup_session_id = session_id.clone();
    let app_state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = started.events.recv().await {
            let finished = matches!(event, SshTerminalEvent::Exit { .. });
            if on_event.send(event).is_err() || finished {
                break;
            }
        }
        app_state.ssh_terminal.forget(&cleanup_session_id).await;
    });
    Ok(session_id)
}

#[tauri::command]
pub async fn write_ssh_terminal(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.ssh_terminal.input(&session_id, data).await
}

#[tauri::command]
pub async fn resize_ssh_terminal(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    size: SshTerminalSize,
) -> Result<(), String> {
    state.ssh_terminal.resize(&session_id, size).await
}

#[tauri::command]
pub async fn close_ssh_terminal(state: State<'_, Arc<AppState>>, session_id: String) -> Result<bool, String> {
    state.ssh_terminal.close(&session_id).await
}
