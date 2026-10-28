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
    use dbx_core::query::pl_debug::{pl_debug_claim_mutation_core, PlDebugAccess, PlDebugMutationScope};
    let access = PlDebugAccess::desktop();
    for _ in 0..3 {
        let (expected, allowed) = {
            let _configs = state.configs.read().await;
            let expected = state.storage.load_tunnel_profile_save_snapshot().await?;
            let allowed = changed_profile_ids(&expected, &profiles)?;
            (expected, allowed)
        };
        let permit = pl_debug_claim_mutation_core(
            state.inner(),
            Some(&access),
            PlDebugMutationScope::TunnelProfiles(allowed.clone()),
        )?;
        let saved = permit
            .after_debug_cleanup(async {
                let _configs = state.configs.write().await;
                if !changed_profile_ids(&expected, &profiles)?.iter().all(|id| allowed.contains(id)) {
                    return Ok(false);
                }
                state.storage.save_tunnel_profiles_if_unchanged(&expected, &profiles).await
            })
            .await?;
        if saved {
            return Ok(());
        }
    }
    Err("Tunnel profiles changed while saving; reload before trying again".into())
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

#[tauri::command]
pub async fn test_tunnel_profile(
    state: State<'_, Arc<AppState>>,
    profile: TransportLayerConfig,
) -> Result<String, String> {
    state.test_tunnel_profile(&profile).await
}

#[tauri::command]
pub async fn list_ssh_agent_identities(
    ssh_agent_sock_path: String,
) -> Result<Vec<dbx_core::db::ssh_tunnel::AgentIdentityInfo>, String> {
    dbx_core::db::ssh_tunnel::list_agent_identities(&ssh_agent_sock_path).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
    use dbx_core::query::pl_debug::{
        pl_debug_bootstrap_core, pl_debug_start_core, pl_debug_status_core, PlDebugAccess, PlDebugSessionRef,
        PlDebugStart,
    };
    use serde_json::json;
    use tauri::Manager;

    #[tokio::test]
    async fn desktop_profile_save_without_debugger_keeps_the_existing_entry_usable() {
        let directory = tempfile::tempdir().unwrap();
        let storage = dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_dir(storage, directory.path().join("plugins")));
        let app = tauri::test::mock_builder()
            .manage(state.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let profile: TransportLayerConfig = serde_json::from_value(json!({
            "type":"proxy","id":"ordinary","name":"Ordinary","host":"127.0.0.1","port":9
        }))
        .unwrap();
        save_tunnel_profiles(app.state::<Arc<AppState>>(), vec![profile.clone()]).await.unwrap();
        assert_eq!(state.storage.load_tunnel_profiles().await.unwrap(), vec![profile]);
    }

    #[tokio::test]
    async fn transport_desktop_profile_save_preserves_debug_ownership_and_display_edits() {
        let mut outcomes = Vec::new();
        for scenario in ["foreign", "own", "display"] {
            let directory = tempfile::tempdir().unwrap();
            let storage =
                dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
            let state = Arc::new(AppState::new_with_plugin_dir(storage, directory.path().join("plugins")));
            let app = tauri::test::mock_builder()
                .manage(state.clone())
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let original: TransportLayerConfig = serde_json::from_value(json!({
                "type":"proxy","id":"shared","name":"Original","host":"127.0.0.1","port":9
            }))
            .unwrap();
            state.storage.save_tunnel_profiles(std::slice::from_ref(&original)).await.unwrap();
            let config: ConnectionConfig = serde_json::from_value(json!({
                "id":"conn","name":"Profile fixture","db_type":DatabaseType::Oracle,
                "host":"127.0.0.1","port":9,"database":"fixture",
                "username":"fixture","password":"",
                "transport_layers":[{"type":"proxy","id":"reference","profile_id":"shared","host":"127.0.0.1","port":9}]
            }))
            .unwrap();
            state.configs.write().await.insert("conn".into(), config);
            let owner = if scenario == "own" {
                PlDebugAccess::desktop()
            } else {
                PlDebugAccess::web("browser".into()).unwrap()
            };
            // Keep the registered start pending until the mutation decision is made;
            // no Agent or database is needed to exercise its reserved resources.
            let start_runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            let started = {
                let _runtime = start_runtime.enter();
                pl_debug_start_core(
                    &state,
                    &owner,
                    PlDebugStart {
                        server_epoch: serde_json::from_value(pl_debug_bootstrap_core(&state)["serverEpoch"].clone())
                            .unwrap(),
                        operation_id: "profile-start".into(),
                        connection_id: "conn".into(),
                        database: "fixture".into(),
                        client_session_id: "editor".into(),
                        target: json!({"source":"BEGIN NULL; END;"}),
                        risk_accepted: false,
                        production_confirmed: false,
                        expected_connection_revision: None,
                    },
                )
            }
            .unwrap();
            let reference = PlDebugSessionRef {
                server_epoch: started.server_epoch,
                session_id: started.session_id,
                connection_id: "conn".into(),
                client_session_id: "editor".into(),
            };
            let mut changed = serde_json::to_value(&original).unwrap();
            if scenario == "display" {
                changed["name"] = json!("Renamed");
            } else {
                changed["host"] = json!("127.0.0.2");
            }
            let changed: TransportLayerConfig = serde_json::from_value(changed).unwrap();
            let (drive, driven) = std::sync::mpsc::channel();
            let (finish, finished) = tokio::sync::oneshot::channel();
            let driver = tokio::task::spawn_blocking(move || {
                if driven.recv_timeout(std::time::Duration::from_secs(5)).is_ok() {
                    start_runtime.block_on(async {
                        let _ = finished.await;
                    });
                }
            });
            let save = save_tunnel_profiles(app.state::<Arc<AppState>>(), vec![changed.clone()]);
            let result = if scenario == "own" {
                let release_pending_start = async {
                    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
                    let observed_close = loop {
                        let status = pl_debug_status_core(&state, &owner, &reference, false).await.unwrap();
                        if status["closing"] == true {
                            break true;
                        }
                        if tokio::time::Instant::now() >= deadline {
                            break false;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                    };
                    drive.send(()).unwrap();
                    observed_close
                };
                let (result, observed_close) = tokio::join!(save, release_pending_start);
                assert!(observed_close, "own profile mutation did not request original start cleanup");
                result
            } else {
                save.await
            };
            let stored = state.storage.load_tunnel_profiles().await.unwrap();
            let status = pl_debug_status_core(&state, &owner, &reference, false).await.unwrap();
            let valid = if scenario == "foreign" {
                result.is_err() && stored == vec![original] && status["runtimeExited"] == false
            } else {
                result.is_ok() && stored == vec![changed] && status["runtimeExited"] == (scenario == "own")
            };
            outcomes.push((scenario, result, status["runtimeExited"].clone(), valid));
            if scenario != "own" {
                drive.send(()).unwrap();
            }
            state.shutdown(std::time::Duration::from_secs(1)).await;
            let _ = finish.send(());
            driver.await.unwrap();
        }
        assert!(outcomes.iter().all(|(_, _, _, valid)| *valid), "{outcomes:?}");
    }
}
