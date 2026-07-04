use dbx_core::ssh_config::SshConfigHostEntry;

#[tauri::command]
pub async fn list_ssh_config_hosts() -> Result<Vec<SshConfigHostEntry>, String> {
    tauri::async_runtime::spawn_blocking(dbx_core::ssh_config::list_hosts).await.map_err(|err| err.to_string())?
}
