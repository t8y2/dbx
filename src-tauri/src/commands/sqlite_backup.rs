use std::sync::Arc;

use tauri::State;

use dbx_core::connection::{AppState, PoolKind};
use dbx_core::db::sqlite::{is_memory_database_path, SqliteHandle};
use dbx_core::models::connection::DatabaseType;
use dbx_core::sqlite_backup::{backup_sqlite_database as backup_sqlite_database_core, SqliteBackupOptions};

#[tauri::command]
pub async fn backup_sqlite_database(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    destination_path: String,
) -> Result<(), String> {
    let source_path = sqlite_source_path(&state, &connection_id).await?;
    let pool = if is_memory_database_path(&source_path) {
        existing_sqlite_pool(&state, &connection_id)
            .await?
            .ok_or_else(|| "Open the in-memory SQLite connection before backing it up".to_string())?
    } else {
        let pool_key = state.get_or_create_pool(&connection_id, None).await?;
        existing_sqlite_pool(&state, &pool_key).await?.ok_or_else(|| "Connection is not open".to_string())?
    };

    backup_sqlite_database_core(pool, SqliteBackupOptions { source_path, destination_path }).await
}

async fn sqlite_source_path(state: &Arc<AppState>, connection_id: &str) -> Result<String, String> {
    let configs = state.configs.read().await;
    let config = configs.get(connection_id).ok_or_else(|| format!("Connection config not found: {connection_id}"))?;
    if config.db_type != DatabaseType::Sqlite {
        return Err("SQLite backup is only available for SQLite connections".to_string());
    }
    let source = config.host.trim();
    if source.is_empty() {
        return Err("SQLite database path is empty".to_string());
    }
    Ok(source.to_string())
}

async fn existing_sqlite_pool(state: &Arc<AppState>, pool_key: &str) -> Result<Option<SqliteHandle>, String> {
    let connections = state.connections.read().await;
    match connections.get(pool_key) {
        Some(PoolKind::Sqlite(pool)) => Ok(Some(pool.clone())),
        Some(_) => Err("SQLite backup is only available for SQLite connections".to_string()),
        None => Ok(None),
    }
}
