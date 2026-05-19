use std::sync::Arc;

use tauri::{Emitter, State};

use dbx_core::agent_manager::{
    AgentDriverInfo, AgentManager, InstalledDriver, JavaRuntimeConfig, JavaRuntimeMode, DEFAULT_JRE_KEY,
};
use dbx_core::agent_service::{
    build_agent_list, download_temp_path, fetch_registry, find_local_agent_jar, github_url_to_r2_path,
    install_local_agent, invalidate_registry_cache, replace_download,
};
use dbx_core::connection::AppState;

#[tauri::command]
pub async fn list_installed_agents_local(state: State<'_, Arc<AppState>>) -> Result<Vec<AgentDriverInfo>, String> {
    Ok(build_agent_list(&state.agent_manager, None))
}

#[tauri::command]
pub async fn list_installed_agents(state: State<'_, Arc<AppState>>) -> Result<Vec<AgentDriverInfo>, String> {
    let registry = fetch_registry().await.ok();
    Ok(build_agent_list(&state.agent_manager, registry.as_ref()))
}

#[tauri::command]
pub async fn install_agent(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    db_type: String,
) -> Result<(), String> {
    let am = &state.agent_manager;
    let registry = match fetch_registry().await {
        Ok(registry) => registry,
        Err(registry_err) => {
            if let Some(local_jar) = find_local_agent_jar(&db_type) {
                install_local_agent(am, &db_type, local_jar)?;
                let _ = app.emit("agent-install-progress", serde_json::json!({ "step": "done" }));
                return Ok(());
            }
            return Err(registry_err);
        }
    };

    let Some(driver) = registry.drivers.get(&db_type) else {
        if let Some(local_jar) = find_local_agent_jar(&db_type) {
            install_local_agent(am, &db_type, local_jar)?;
            let _ = app.emit("agent-install-progress", serde_json::json!({ "step": "done" }));
            return Ok(());
        }
        return Err(format!("Unknown driver type: {db_type}"));
    };
    let jre_key = &driver.jre;
    let needs_jre = am.load_state().java_runtime.mode == JavaRuntimeMode::Managed && !am.is_jre_installed(jre_key);

    if needs_jre {
        let jre_info =
            registry.resolve_jre(jre_key).ok_or_else(|| format!("No JRE definition for version: {jre_key}"))?;
        let platform = AgentManager::current_platform();
        let platform_jre = jre_info
            .platforms
            .get(platform)
            .ok_or_else(|| format!("No JRE {jre_key} available for platform: {platform}"))?;
        let jre_archive = am.base_dir().join("jre-download.tar.gz");
        let _ = app.emit(
            "agent-install-progress",
            serde_json::json!({
                "step": "jre", "downloaded": 0u64, "total": platform_jre.size,
            }),
        );
        download_with_progress(
            &app,
            "jre",
            &platform_jre.url,
            &github_url_to_r2_path(&platform_jre.url, "jre"),
            &jre_archive,
            platform_jre.size,
        )
        .await?;
        let _ = app.emit(
            "agent-install-progress",
            serde_json::json!({
                "step": "jre-extract", "downloaded": 0u64, "total": 0u64,
            }),
        );
        extract_archive(&jre_archive, &am.jre_dir(jre_key))?;
        std::fs::remove_file(&jre_archive).ok();
    }

    let jar_path = am.driver_jar_path(&db_type);
    let _ = app.emit(
        "agent-install-progress",
        serde_json::json!({
            "step": "driver", "downloaded": 0u64, "total": driver.jar.size,
        }),
    );
    download_with_progress(
        &app,
        "driver",
        &driver.jar.url,
        &github_url_to_r2_path(&driver.jar.url, "driver"),
        &jar_path,
        driver.jar.size,
    )
    .await?;

    let mut local_state = am.load_state();
    if let Some(jre_info) = registry.resolve_jre(jre_key) {
        local_state.jre_versions.insert(jre_key.clone(), jre_info.version.clone());
    }
    local_state.installed_drivers.insert(
        db_type,
        InstalledDriver {
            version: driver.version.clone(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            jre: jre_key.clone(),
        },
    );
    am.save_state(&local_state)?;
    let _ = app.emit("agent-install-progress", serde_json::json!({ "step": "done" }));
    Ok(())
}

#[tauri::command]
pub async fn upgrade_all_agents(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Result<u32, String> {
    let am = &state.agent_manager;
    let registry = fetch_registry().await?;
    let agents = build_agent_list(am, Some(&registry));
    let updatable: Vec<&AgentDriverInfo> = agents.iter().filter(|a| a.update_available).collect();
    let total_drivers = updatable.len() as u32;
    if total_drivers == 0 {
        return Ok(0);
    }

    for (i, agent) in updatable.iter().enumerate() {
        let current = (i + 1) as u32;
        let db_type = &agent.db_type;
        let driver = registry.drivers.get(db_type).ok_or_else(|| format!("Unknown driver type: {db_type}"))?;
        let jre_key = &driver.jre;
        let needs_jre = am.load_state().java_runtime.mode == JavaRuntimeMode::Managed && !am.is_jre_installed(jre_key);

        if needs_jre {
            let jre_info =
                registry.resolve_jre(jre_key).ok_or_else(|| format!("No JRE definition for version: {jre_key}"))?;
            let platform = AgentManager::current_platform();
            let platform_jre = jre_info
                .platforms
                .get(platform)
                .ok_or_else(|| format!("No JRE {jre_key} available for platform: {platform}"))?;
            let jre_archive = am.base_dir().join("jre-download.tar.gz");
            let _ = app.emit(
                "agent-install-progress",
                serde_json::json!({
                    "step": "jre", "downloaded": 0u64, "total": platform_jre.size,
                    "db_type": db_type, "current": current, "total_drivers": total_drivers,
                }),
            );
            download_with_progress(
                &app,
                "jre",
                &platform_jre.url,
                &github_url_to_r2_path(&platform_jre.url, "jre"),
                &jre_archive,
                platform_jre.size,
            )
            .await?;
            let _ = app.emit(
                "agent-install-progress",
                serde_json::json!({
                    "step": "jre-extract", "downloaded": 0u64, "total": 0u64,
                    "db_type": db_type, "current": current, "total_drivers": total_drivers,
                }),
            );
            extract_archive(&jre_archive, &am.jre_dir(jre_key))?;
            std::fs::remove_file(&jre_archive).ok();
        }

        let jar_path = am.driver_jar_path(db_type);
        let _ = app.emit(
            "agent-install-progress",
            serde_json::json!({
                "step": "driver", "downloaded": 0u64, "total": driver.jar.size,
                "db_type": db_type, "current": current, "total_drivers": total_drivers,
            }),
        );
        download_with_progress(
            &app,
            "driver",
            &driver.jar.url,
            &github_url_to_r2_path(&driver.jar.url, "driver"),
            &jar_path,
            driver.jar.size,
        )
        .await?;

        let mut local_state = am.load_state();
        if let Some(jre_info) = registry.resolve_jre(jre_key) {
            local_state.jre_versions.insert(jre_key.clone(), jre_info.version.clone());
        }
        local_state.installed_drivers.insert(
            db_type.clone(),
            InstalledDriver {
                version: driver.version.clone(),
                installed_at: chrono::Utc::now().to_rfc3339(),
                jre: jre_key.clone(),
            },
        );
        am.save_state(&local_state)?;
    }

    let _ = app.emit("agent-install-progress", serde_json::json!({ "step": "all-done" }));
    Ok(total_drivers)
}

#[tauri::command]
pub async fn uninstall_agent(state: State<'_, Arc<AppState>>, db_type: String) -> Result<(), String> {
    let am = &state.agent_manager;
    let jar_path = am.driver_jar_path(&db_type);
    if jar_path.exists() {
        std::fs::remove_file(&jar_path).map_err(|e| e.to_string())?;
    }
    let driver_dir = jar_path.parent().unwrap();
    if driver_dir.exists() {
        std::fs::remove_dir_all(driver_dir).map_err(|e| e.to_string())?;
    }
    let mut local_state = am.load_state();
    local_state.installed_drivers.remove(&db_type);
    am.save_state(&local_state)?;
    Ok(())
}

#[tauri::command]
pub async fn check_jre_installed(state: State<'_, Arc<AppState>>, jre_key: Option<String>) -> Result<bool, String> {
    let key = jre_key.as_deref().unwrap_or(DEFAULT_JRE_KEY);
    Ok(state.agent_manager.is_jre_installed(key))
}

#[tauri::command]
pub async fn get_agent_java_runtime_config(state: State<'_, Arc<AppState>>) -> Result<JavaRuntimeConfig, String> {
    Ok(state.agent_manager.load_state().java_runtime)
}

#[tauri::command]
pub async fn set_agent_java_runtime_config(
    state: State<'_, Arc<AppState>>,
    mut config: JavaRuntimeConfig,
) -> Result<JavaRuntimeConfig, String> {
    let am = &state.agent_manager;
    if config.mode == JavaRuntimeMode::Custom || config.mode == JavaRuntimeMode::System {
        let candidate_state = dbx_core::agent_manager::AgentState { java_runtime: config.clone(), ..am.load_state() };
        let resolved = am.resolve_java_runtime(&candidate_state, DEFAULT_JRE_KEY)?;
        if config.mode == JavaRuntimeMode::Custom {
            config.custom_java_path = Some(resolved.to_string_lossy().to_string());
        }
    }
    if config.mode != JavaRuntimeMode::Custom {
        config.custom_java_path = None;
    }

    let mut local_state = am.load_state();
    local_state.java_runtime = config.clone();
    am.save_state(&local_state)?;
    am.stop_daemons().await;
    Ok(config)
}

#[tauri::command]
pub async fn uninstall_jre(state: State<'_, Arc<AppState>>, jre_key: String) -> Result<(), String> {
    let am = &state.agent_manager;
    let local_state = am.load_state();
    let dependents: Vec<&str> =
        local_state.installed_drivers.iter().filter(|(_, d)| d.jre == jre_key).map(|(k, _)| k.as_str()).collect();
    if !dependents.is_empty() {
        return Err(format!("JRE {} 正在被以下驱动使用: {}，请先卸载这些驱动", jre_key, dependents.join(", ")));
    }
    let jre_dir = am.jre_dir(&jre_key);
    if jre_dir.exists() {
        std::fs::remove_dir_all(&jre_dir).map_err(|e| format!("Failed to remove JRE: {e}"))?;
    }
    let mut local_state = am.load_state();
    local_state.jre_versions.remove(&jre_key);
    am.save_state(&local_state)?;
    Ok(())
}

#[tauri::command]
pub async fn invalidate_agent_registry_cache() -> Result<(), String> {
    invalidate_registry_cache().await;
    Ok(())
}

#[tauri::command]
pub async fn reinstall_jre(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    jre_key: Option<String>,
) -> Result<(), String> {
    let am = &state.agent_manager;
    let key = jre_key.as_deref().unwrap_or(DEFAULT_JRE_KEY);
    let registry = fetch_registry().await?;
    let jre_info = registry.resolve_jre(key).ok_or_else(|| format!("No JRE definition for version: {key}"))?;
    let platform = AgentManager::current_platform();
    let platform_jre =
        jre_info.platforms.get(platform).ok_or_else(|| format!("No JRE {key} available for platform: {platform}"))?;
    let jre_archive = am.base_dir().join("jre-download.tar.gz");
    download_with_progress(
        &app,
        "jre",
        &platform_jre.url,
        &github_url_to_r2_path(&platform_jre.url, "jre"),
        &jre_archive,
        platform_jre.size,
    )
    .await?;
    let jre_dir = am.jre_dir(key);
    if jre_dir.exists() {
        std::fs::remove_dir_all(&jre_dir).map_err(|e| format!("Failed to remove old JRE: {e}"))?;
    }
    extract_archive(&jre_archive, &jre_dir)?;
    std::fs::remove_file(&jre_archive).ok();
    let mut local_state = am.load_state();
    local_state.jre_versions.insert(key.to_string(), jre_info.version.clone());
    am.save_state(&local_state)?;
    let _ = app.emit("agent-install-progress", serde_json::json!({ "step": "done" }));
    Ok(())
}

async fn download_with_progress(
    app: &tauri::AppHandle,
    step: &str,
    url: &str,
    r2_path: &str,
    dest: &std::path::Path,
    total_size: u64,
) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = download_temp_path(dest);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let resp = dbx_core::race_download(&client, url, r2_path, "dbx-agent-manager")
        .await
        .map_err(|e| format!("Failed to download {url}: {e}"))?;

    let content_length = resp.content_length().unwrap_or(total_size);
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("Failed to create temp file: {e}"))?;
    let mut downloaded: u64 = 0;
    let mut bytes = resp;
    while let Some(chunk) = bytes.chunk().await.map_err(|e| format!("Download stream error: {e}"))? {
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| format!("Failed to write chunk: {e}"))?;
        downloaded += chunk.len() as u64;
        let _ = app.emit(
            "agent-install-progress",
            serde_json::json!({ "step": step, "downloaded": downloaded, "total": content_length }),
        );
    }
    std::io::Write::flush(&mut file).map_err(|e| format!("Failed to flush temp file: {e}"))?;
    drop(file);
    replace_download(&tmp, dest)
}

fn extract_archive(archive: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let status = Command::new("tar")
        .args(["xzf", &archive.to_string_lossy(), "-C", &dest.to_string_lossy(), "--strip-components=1"])
        .status()
        .map_err(|e| format!("Failed to extract archive: {e}"))?;
    if !status.success() {
        return Err("Failed to extract JRE archive".to_string());
    }
    Ok(())
}
