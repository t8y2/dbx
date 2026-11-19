use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
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
    headers: HeaderMap,
    Json(body): Json<SaveTunnelProfilesRequest>,
) -> Result<Json<()>, AppError> {
    for _ in 0..3 {
        let (expected, profiles, allowed) = {
            let _configs = state.app.configs.read().await;
            let expected = state.app.storage.load_tunnel_profile_save_snapshot().await?;
            let profiles = body
                .profiles
                .iter()
                .cloned()
                .map(|profile| crate::credentials::restore_tunnel_from_profiles(profile, &expected.profiles))
                .collect::<Result<Vec<_>, _>>()?;
            let allowed = changed_profile_ids(&expected, &profiles)?;
            (expected, profiles, allowed)
        };
        let permit = super::pl_debug::claim_mutation(
            &state,
            &headers,
            dbx_core::query::pl_debug::PlDebugMutationScope::TunnelProfiles(allowed.clone()),
        )
        .await?;
        let saved = permit
            .after_debug_cleanup(async {
                let _configs = state.app.configs.write().await;
                if !changed_profile_ids(&expected, &profiles)?.iter().all(|id| allowed.contains(id)) {
                    return Ok(false);
                }
                state.app.storage.save_tunnel_profiles_if_unchanged(&expected, &profiles).await
            })
            .await?;
        if saved {
            return Ok(Json(()));
        }
    }
    Err(AppError::conflict("Tunnel profiles changed while saving; reload before trying again"))
}

fn changed_profile_ids(
    current: &dbx_core::storage::TunnelProfileSaveSnapshot,
    next: &[TransportLayerConfig],
) -> Result<Vec<String>, String> {
    use dbx_core::db::transport_layer_tunnel::ResolvedTransportLayers;
    let mut changed = current.discarded_profile_ids();
    let current =
        current.profiles.iter().map(|profile| (profile.id(), profile)).collect::<std::collections::HashMap<_, _>>();
    let next = next.iter().map(|profile| (profile.id(), profile)).collect::<std::collections::HashMap<_, _>>();
    let mut ids = current.keys().chain(next.keys()).copied().collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    for id in ids {
        let same = match (current.get(id), next.get(id)) {
            (Some(current), Some(next)) => {
                ResolvedTransportLayers::resolve(std::slice::from_ref(*current))?
                    == ResolvedTransportLayers::resolve(std::slice::from_ref(*next))?
            }
            _ => false,
        };
        if !same {
            changed.push(id.to_owned());
        }
    }
    changed.sort();
    changed.dedup();
    Ok(changed)
}

pub async fn test_tunnel_profile(
    State(state): State<Arc<WebState>>,
    Json(profile): Json<TransportLayerConfig>,
) -> Result<Json<String>, AppError> {
    let profile = state.resolve_tunnel_credentials(profile).await?;
    state.app.test_tunnel_profile(&profile).await.map(Json).map_err(AppError::from)
}
