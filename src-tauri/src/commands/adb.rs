use dbx_core::adb_transport::{self, AdbDevice};

fn resolve_adb(configured_path: Option<String>) -> Result<std::path::PathBuf, String> {
    let configured =
        configured_path.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(std::path::PathBuf::from);
    adb_transport::resolve_adb_binary(configured.as_deref())
}

#[tauri::command]
pub async fn adb_detect_binary(configured_path: Option<String>) -> Result<Option<String>, String> {
    match resolve_adb(configured_path) {
        Ok(path) => Ok(Some(path.to_string_lossy().into_owned())),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn list_adb_devices(configured_path: Option<String>) -> Result<Vec<AdbDevice>, String> {
    let adb = resolve_adb(configured_path)?;
    adb_transport::list_adb_devices(&adb).await
}

#[tauri::command]
pub async fn list_adb_packages(configured_path: Option<String>, serial: String) -> Result<Vec<String>, String> {
    let adb = resolve_adb(configured_path)?;
    adb_transport::ensure_device_online(&adb, &serial).await?;
    adb_transport::list_adb_packages(&adb, &serial).await
}

#[tauri::command]
pub async fn list_adb_databases(
    configured_path: Option<String>,
    serial: String,
    package: String,
) -> Result<Vec<String>, String> {
    let adb = resolve_adb(configured_path)?;
    adb_transport::ensure_device_online(&adb, &serial).await?;
    adb_transport::check_debuggable(&adb, &serial, &package).await?;
    adb_transport::list_app_database_files(&adb, &serial, &package).await
}
