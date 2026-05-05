use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use dbx_core::models::connection::ConnectionConfig;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub config: ConnectionConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionsRequest {
    pub configs: Vec<ConnectionConfig>,
}

pub async fn test_connection(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<String>, AppError> {
    let config = body.config;
    let app = &state.app;

    // Store config temporarily
    let temp_id = format!("__test_{}", uuid::Uuid::new_v4());
    app.configs
        .lock()
        .await
        .insert(temp_id.clone(), config.clone());

    // Try to connect
    let result = app.get_or_create_pool(&temp_id, config.database.as_deref()).await;

    // Clean up
    app.connections.lock().await.remove(&temp_id);
    app.configs.lock().await.remove(&temp_id);

    match result {
        Ok(_) => Ok(Json("Connection successful".to_string())),
        Err(e) => Err(AppError(e)),
    }
}

pub async fn connect_db(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<String>, AppError> {
    let config = body.config;
    let app = &state.app;
    let connection_id = config.id.clone();

    app.configs
        .lock()
        .await
        .insert(connection_id.clone(), config.clone());

    let pool_key = app
        .get_or_create_pool(&connection_id, config.database.as_deref())
        .await
        .map_err(AppError)?;

    Ok(Json(pool_key))
}

pub async fn disconnect_db(
    State(state): State<Arc<WebState>>,
    Json(body): Json<DisconnectRequest>,
) -> Result<Json<()>, AppError> {
    let app = &state.app;
    let mut connections = app.connections.lock().await;

    // Remove all pool keys that start with this connection_id
    let keys_to_remove: Vec<String> = connections
        .keys()
        .filter(|k| k.starts_with(&body.connection_id))
        .cloned()
        .collect();
    for key in keys_to_remove {
        connections.remove(&key);
    }
    drop(connections);

    app.configs.lock().await.remove(&body.connection_id);
    app.tunnels.stop_tunnel(&body.connection_id).await;

    Ok(Json(()))
}

pub async fn save_connections(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveConnectionsRequest>,
) -> Result<Json<()>, AppError> {
    state
        .app
        .storage
        .save_connections(&body.configs)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn load_connections(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<ConnectionConfig>>, AppError> {
    let configs = state
        .app
        .storage
        .load_connections()
        .await
        .map_err(AppError)?;
    Ok(Json(configs))
}
