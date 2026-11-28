//! Connection setup for DBX "Android (ADB)" connections: verify the device
//! and target app, install the on-device worker, and wrap its stdio protocol
//! in the shared [`SqliteWorkerClient`] so the existing SQLite pool path can
//! drive it unchanged.

use std::sync::Arc;

use crate::db::adb_transport::{
    adb_connection_params, check_debuggable, ensure_android_worker, ensure_device_online, resolve_adb_binary,
    resolve_local_worker_binary, spawn_android_worker,
};
use crate::db::sqlite_worker::SqliteWorkerClient;
use crate::models::connection::ConnectionConfig;

/// Establish an Android (ADB) SQLite worker connection.
///
/// Triggered when a connection pool is created for
/// [`DatabaseType::AndroidAdb`]. Flow: resolve adb → device online →
/// debuggable check → install worker → spawn → protocol `open` on the app's
/// database file.
pub async fn connect_adb_worker(config: &ConnectionConfig) -> Result<Arc<SqliteWorkerClient>, String> {
    let params = adb_connection_params(config)?;
    let adb = resolve_adb_binary(params.adb_path.as_deref())?;

    ensure_device_online(&adb, &params.serial).await?;
    check_debuggable(&adb, &params.serial, &params.package).await?;

    let abi = crate::db::adb_transport::device_abi(&adb, &params.serial).await?;
    let local_worker = resolve_local_worker_binary(&abi)?;
    ensure_android_worker(&adb, &params.serial, &params.package, &local_worker).await?;

    let child = spawn_android_worker(&adb, &params.serial, &params.package, &params.database_path).await?;
    let client = SqliteWorkerClient::from_local_process(child);
    client.open_database(&params.database_path).await?;
    Ok(Arc::new(client))
}

/// Probe helpers reused by the desktop frontend (M2 commands): each returns
/// human-readable errors suitable for connection dialogs.
pub async fn probe_adb_devices(configured_adb: Option<&std::path::Path>) -> Result<Vec<crate::db::adb_transport::AdbDevice>, String> {
    let adb = resolve_adb_binary(configured_adb)?;
    crate::db::adb_transport::list_adb_devices(&adb).await
}

pub async fn probe_adb_packages(
    configured_adb: Option<&std::path::Path>,
    serial: &str,
) -> Result<Vec<String>, String> {
    let adb = resolve_adb_binary(configured_adb)?;
    ensure_device_online(&adb, serial).await?;
    crate::db::adb_transport::list_adb_packages(&adb, serial).await
}

pub async fn probe_adb_database_files(
    configured_adb: Option<&std::path::Path>,
    serial: &str,
    package: &str,
) -> Result<Vec<String>, String> {
    let adb = resolve_adb_binary(configured_adb)?;
    ensure_device_online(&adb, serial).await?;
    crate::db::adb_transport::check_debuggable(&adb, serial, package).await?;
    crate::db::adb_transport::list_app_database_files(&adb, serial, package).await
}
