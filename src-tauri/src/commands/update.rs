pub use dbx_core::update::UpdateInfo;

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    let release = dbx_core::update::fetch_latest_release().await?;
    let current_version = env!("CARGO_PKG_VERSION");
    Ok(dbx_core::update::build_update_info(release, current_version))
}
