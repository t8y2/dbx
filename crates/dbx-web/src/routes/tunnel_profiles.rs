use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use dbx_core::models::connection::TransportLayerConfig;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTunnelProfilesRequest {
    pub profiles: Vec<TransportLayerConfig>,
}

pub async fn load_tunnel_profiles(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<TransportLayerConfig>>, AppError> {
    let profiles = state.app.storage.load_tunnel_profiles().await.map_err(AppError::from)?;
    Ok(Json(
        profiles
            .into_iter()
            .map(
                |profile| {
                    if state.password_viewer_enabled {
                        profile
                    } else {
                        crate::credentials::redact_tunnel(profile)
                    }
                },
            )
            .collect(),
    ))
}

pub async fn save_tunnel_profiles(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveTunnelProfilesRequest>,
) -> Result<Json<()>, AppError> {
    let mut profiles = Vec::with_capacity(body.profiles.len());
    for profile in body.profiles {
        profiles.push(state.resolve_tunnel_credentials(profile).await?);
    }
    state.app.storage.save_tunnel_profiles(&profiles).await.map(Json).map_err(AppError::from)
}

pub async fn test_tunnel_profile(
    State(state): State<Arc<WebState>>,
    Json(profile): Json<TransportLayerConfig>,
) -> Result<Json<String>, AppError> {
    let profile = state.resolve_tunnel_credentials(profile).await?;
    state.app.test_tunnel_profile(&profile).await.map(Json).map_err(AppError::from)
}
