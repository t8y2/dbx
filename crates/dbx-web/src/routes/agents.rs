use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use dbx_core::agent_manager::{
    AgentDriverInfo, AgentManager, AgentRegistry, AgentState, InstalledDriver, JavaRuntimeConfig, JavaRuntimeMode,
    DEFAULT_JRE_KEY,
};
use dbx_core::agent_service::{
    build_agent_list, download_temp_path, fetch_registry, find_local_agent_jar, github_url_to_r2_path,
    install_local_agent, invalidate_registry_cache, replace_download,
};
use futures::Stream;
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTypeRequest {
    pub db_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JreRequest {
    pub jre_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaRuntimeRequest {
    pub config: JavaRuntimeConfig,
}

pub async fn list_installed_agents_local(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<AgentDriverInfo>>, AppError> {
    Ok(Json(build_agent_list(&state.app.agent_manager, None)))
}

pub async fn list_installed_agents(State(state): State<Arc<WebState>>) -> Result<Json<Vec<AgentDriverInfo>>, AppError> {
    let registry = fetch_registry().await.ok();
    Ok(Json(build_agent_list(&state.app.agent_manager, registry.as_ref())))
}

pub async fn install_agent(
    State(state): State<Arc<WebState>>,
    Json(req): Json<AgentTypeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let tx = progress_sender(&state, "global").await;
    install_agent_core(&state.app.agent_manager, &req.db_type, &tx, None, None).await.map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn upgrade_all_agents(State(state): State<Arc<WebState>>) -> Result<Json<serde_json::Value>, AppError> {
    let tx = progress_sender(&state, "global").await;
    let am = &state.app.agent_manager;
    let registry = fetch_registry().await.map_err(AppError)?;
    let agents = build_agent_list(am, Some(&registry));
    let updatable: Vec<&AgentDriverInfo> = agents.iter().filter(|agent| agent.update_available).collect();
    let total = updatable.len() as u32;

    for (index, agent) in updatable.iter().enumerate() {
        install_agent_from_registry(am, &registry, &agent.db_type, &tx, Some((index + 1) as u32), Some(total)).await?;
    }

    send_progress(&tx, serde_json::json!({ "step": "all-done" }));
    Ok(Json(serde_json::json!({ "count": total })))
}

pub async fn uninstall_agent(
    State(state): State<Arc<WebState>>,
    Json(req): Json<AgentTypeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let am = &state.app.agent_manager;
    let jar_path = am.driver_jar_path(&req.db_type);
    if jar_path.exists() {
        std::fs::remove_file(&jar_path).map_err(|err| AppError(err.to_string()))?;
    }
    if let Some(driver_dir) = jar_path.parent() {
        if driver_dir.exists() {
            std::fs::remove_dir_all(driver_dir).map_err(|err| AppError(err.to_string()))?;
        }
    }
    let mut local_state = am.load_state();
    local_state.installed_drivers.remove(&req.db_type);
    am.save_state(&local_state).map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn get_agent_java_runtime_config(
    State(state): State<Arc<WebState>>,
) -> Result<Json<JavaRuntimeConfig>, AppError> {
    Ok(Json(state.app.agent_manager.load_state().java_runtime))
}

pub async fn set_agent_java_runtime_config(
    State(state): State<Arc<WebState>>,
    Json(req): Json<JavaRuntimeRequest>,
) -> Result<Json<JavaRuntimeConfig>, AppError> {
    let am = &state.app.agent_manager;
    let mut config = req.config;
    if config.mode == JavaRuntimeMode::Custom || config.mode == JavaRuntimeMode::System {
        let candidate_state = AgentState { java_runtime: config.clone(), ..am.load_state() };
        let resolved = am.resolve_java_runtime(&candidate_state, DEFAULT_JRE_KEY).map_err(AppError)?;
        if config.mode == JavaRuntimeMode::Custom {
            config.custom_java_path = Some(resolved.to_string_lossy().to_string());
        }
    }
    if config.mode != JavaRuntimeMode::Custom {
        config.custom_java_path = None;
    }

    let mut local_state = am.load_state();
    local_state.java_runtime = config.clone();
    am.save_state(&local_state).map_err(AppError)?;
    am.stop_daemons().await;
    Ok(Json(config))
}

pub async fn invalidate_agent_registry_cache() -> Result<Json<serde_json::Value>, AppError> {
    invalidate_registry_cache().await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn reinstall_jre(
    State(state): State<Arc<WebState>>,
    Json(req): Json<JreRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let tx = progress_sender(&state, "global").await;
    reinstall_jre_core(&state.app.agent_manager, req.jre_key.as_deref().unwrap_or(DEFAULT_JRE_KEY), &tx)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn uninstall_jre(
    State(state): State<Arc<WebState>>,
    Json(req): Json<JreRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let key = req.jre_key.as_deref().unwrap_or(DEFAULT_JRE_KEY);
    let am = &state.app.agent_manager;
    let local_state = am.load_state();
    let dependents: Vec<&str> =
        local_state.installed_drivers.iter().filter(|(_, driver)| driver.jre == key).map(|(k, _)| k.as_str()).collect();
    if !dependents.is_empty() {
        return Err(AppError(format!("JRE {} 正在被以下驱动使用: {}，请先卸载这些驱动", key, dependents.join(", "))));
    }
    let jre_dir = am.jre_dir(key);
    if jre_dir.exists() {
        std::fs::remove_dir_all(&jre_dir).map_err(|err| AppError(format!("Failed to remove JRE: {err}")))?;
    }
    let mut local_state = am.load_state();
    local_state.jre_versions.remove(key);
    am.save_state(&local_state).map_err(AppError)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn agent_progress(
    State(state): State<Arc<WebState>>,
    Path(operation_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let tx = progress_sender(&state, &operation_id).await;
    Ok(crate::sse::sse_from_channel(tx.subscribe()))
}

async fn progress_sender(state: &WebState, operation_id: &str) -> broadcast::Sender<String> {
    let mut channels = state.sse_channels.write().await;
    channels
        .entry(format!("agent-install-progress:{operation_id}"))
        .or_insert_with(|| {
            let (tx, _) = broadcast::channel::<String>(256);
            tx
        })
        .clone()
}

async fn install_agent_core(
    am: &AgentManager,
    db_type: &str,
    tx: &broadcast::Sender<String>,
    current: Option<u32>,
    total_drivers: Option<u32>,
) -> Result<(), String> {
    match fetch_registry().await {
        Ok(registry) => install_agent_from_registry(am, &registry, db_type, tx, current, total_drivers).await,
        Err(registry_err) => {
            if let Some(local_jar) = find_local_agent_jar(db_type) {
                install_local_agent(am, db_type, local_jar)?;
                send_progress(tx, serde_json::json!({ "step": "done" }));
                return Ok(());
            }
            Err(registry_err)
        }
    }
}

async fn install_agent_from_registry(
    am: &AgentManager,
    registry: &AgentRegistry,
    db_type: &str,
    tx: &broadcast::Sender<String>,
    current: Option<u32>,
    total_drivers: Option<u32>,
) -> Result<(), String> {
    let Some(driver) = registry.drivers.get(db_type) else {
        if let Some(local_jar) = find_local_agent_jar(db_type) {
            install_local_agent(am, db_type, local_jar)?;
            send_progress(tx, serde_json::json!({ "step": "done" }));
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
        send_install_progress(tx, "jre", 0, platform_jre.size, Some(db_type), current, total_drivers);
        download_with_progress(
            tx,
            "jre",
            &platform_jre.url,
            &github_url_to_r2_path(&platform_jre.url, "jre"),
            &jre_archive,
            platform_jre.size,
            Some(db_type),
            current,
            total_drivers,
        )
        .await?;
        send_install_progress(tx, "jre-extract", 0, 0, Some(db_type), current, total_drivers);
        extract_archive(&jre_archive, &am.jre_dir(jre_key))?;
        std::fs::remove_file(&jre_archive).ok();
    }

    let jar_path = am.driver_jar_path(db_type);
    send_install_progress(tx, "driver", 0, driver.jar.size, Some(db_type), current, total_drivers);
    download_with_progress(
        tx,
        "driver",
        &driver.jar.url,
        &github_url_to_r2_path(&driver.jar.url, "driver"),
        &jar_path,
        driver.jar.size,
        Some(db_type),
        current,
        total_drivers,
    )
    .await?;

    let mut local_state = am.load_state();
    if let Some(jre_info) = registry.resolve_jre(jre_key) {
        local_state.jre_versions.insert(jre_key.clone(), jre_info.version.clone());
    }
    local_state.installed_drivers.insert(
        db_type.to_string(),
        InstalledDriver {
            version: driver.version.clone(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            jre: jre_key.clone(),
        },
    );
    am.save_state(&local_state)?;
    send_progress(tx, serde_json::json!({ "step": "done" }));
    Ok(())
}

async fn reinstall_jre_core(am: &AgentManager, jre_key: &str, tx: &broadcast::Sender<String>) -> Result<(), String> {
    let registry = fetch_registry().await?;
    let jre_info = registry.resolve_jre(jre_key).ok_or_else(|| format!("No JRE definition for version: {jre_key}"))?;
    let platform = AgentManager::current_platform();
    let platform_jre = jre_info
        .platforms
        .get(platform)
        .ok_or_else(|| format!("No JRE {jre_key} available for platform: {platform}"))?;
    let jre_archive = am.base_dir().join("jre-download.tar.gz");
    download_with_progress(
        tx,
        "jre",
        &platform_jre.url,
        &github_url_to_r2_path(&platform_jre.url, "jre"),
        &jre_archive,
        platform_jre.size,
        None,
        None,
        None,
    )
    .await?;
    let jre_dir = am.jre_dir(jre_key);
    if jre_dir.exists() {
        std::fs::remove_dir_all(&jre_dir).map_err(|err| format!("Failed to remove old JRE: {err}"))?;
    }
    extract_archive(&jre_archive, &jre_dir)?;
    std::fs::remove_file(&jre_archive).ok();
    let mut local_state = am.load_state();
    local_state.jre_versions.insert(jre_key.to_string(), jre_info.version.clone());
    am.save_state(&local_state)?;
    send_progress(tx, serde_json::json!({ "step": "done" }));
    Ok(())
}

async fn download_with_progress(
    tx: &broadcast::Sender<String>,
    step: &str,
    url: &str,
    r2_path: &str,
    dest: &std::path::Path,
    total_size: u64,
    db_type: Option<&str>,
    current: Option<u32>,
    total_drivers: Option<u32>,
) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let tmp = download_temp_path(dest);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {err}"))?;
    let mut resp = dbx_core::race_download(&client, url, r2_path, "dbx-agent-manager")
        .await
        .map_err(|err| format!("Failed to download {url}: {err}"))?;
    let content_length = resp.content_length().unwrap_or(total_size);
    let mut file = std::fs::File::create(&tmp).map_err(|err| format!("Failed to create temp file: {err}"))?;
    let mut downloaded = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|err| format!("Download stream error: {err}"))? {
        std::io::Write::write_all(&mut file, &chunk).map_err(|err| format!("Failed to write chunk: {err}"))?;
        downloaded += chunk.len() as u64;
        send_install_progress(tx, step, downloaded, content_length, db_type, current, total_drivers);
    }
    std::io::Write::flush(&mut file).map_err(|err| format!("Failed to flush temp file: {err}"))?;
    drop(file);
    replace_download(&tmp, dest)
}

fn send_install_progress(
    tx: &broadcast::Sender<String>,
    step: &str,
    downloaded: u64,
    total: u64,
    db_type: Option<&str>,
    current: Option<u32>,
    total_drivers: Option<u32>,
) {
    let mut payload = serde_json::json!({ "step": step, "downloaded": downloaded, "total": total });
    if let Some(value) = db_type {
        payload["db_type"] = serde_json::json!(value);
    }
    if let Some(value) = current {
        payload["current"] = serde_json::json!(value);
    }
    if let Some(value) = total_drivers {
        payload["total_drivers"] = serde_json::json!(value);
    }
    send_progress(tx, payload);
}

fn send_progress(tx: &broadcast::Sender<String>, payload: serde_json::Value) {
    let _ = tx.send(payload.to_string());
}

fn extract_archive(archive: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    std::fs::create_dir_all(dest).map_err(|err| err.to_string())?;
    let status = Command::new("tar")
        .args(["xzf", &archive.to_string_lossy(), "-C", &dest.to_string_lossy(), "--strip-components=1"])
        .status()
        .map_err(|err| format!("Failed to extract archive: {err}"))?;
    if !status.success() {
        return Err("Failed to extract JRE archive".to_string());
    }
    Ok(())
}
