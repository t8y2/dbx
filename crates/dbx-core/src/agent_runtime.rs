use serde::de::DeserializeOwned;

use crate::agent_manager::{AgentManager, DEFAULT_JRE_KEY};
use crate::database_capabilities;
use crate::db::agent_driver::{AgentDriverClient, AgentMethod};
use crate::models::connection::DatabaseType;

pub fn db_type_to_agent_key(db_type: &DatabaseType, driver_profile: Option<&str>) -> Option<&'static str> {
    database_capabilities::agent_key(db_type, driver_profile)
}

pub fn is_agent_type(db_type: &DatabaseType) -> bool {
    database_capabilities::is_agent_type(db_type)
}

pub async fn stop_daemons(manager: &AgentManager) {
    manager.daemons.lock().await.clear();
}

pub async fn stop_daemon_by_key(manager: &AgentManager, agent_key: &str) {
    manager.daemons.lock().await.remove(agent_key);
}

pub async fn restart_daemon_by_key(manager: &AgentManager, agent_key: &str) -> Result<(), String> {
    manager.daemons.lock().await.remove(agent_key);
    let client = spawn_client_for_key(manager, agent_key).await?;
    manager.daemons.lock().await.insert(agent_key.to_string(), client);
    Ok(())
}

pub async fn spawn_connection_client(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
) -> Result<AgentDriverClient, String> {
    let key = db_type_to_agent_key(db_type, driver_profile)
        .ok_or_else(|| format!("{:?} is not an agent-driven database type", db_type))?;
    spawn_client_for_key(manager, key).await
}

pub async fn call_daemon<T: DeserializeOwned + Send + 'static>(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    method: &str,
    params: serde_json::Value,
) -> Result<T, String> {
    let key = db_type_to_agent_key(db_type, driver_profile)
        .ok_or_else(|| format!("{:?} is not an agent-driven database type", db_type))?
        .to_string();

    let mut daemons = manager.daemons.lock().await;

    if !daemons.contains_key(&key) {
        let client = spawn_client_for_key(manager, &key).await?;
        daemons.insert(key.clone(), client);
    }

    let client = daemons.get_mut(&key).unwrap();
    match client.call::<T>(method, params.clone()).await {
        Ok(result) => Ok(result),
        Err(err) => {
            log::warn!("[agent] daemon call failed, respawning: {err}");
            daemons.remove(&key);
            let mut new_client = spawn_client_for_key(manager, &key).await?;
            let result = new_client.call::<T>(method, params).await?;
            daemons.insert(key, new_client);
            Ok(result)
        }
    }
}

pub async fn call_daemon_method<T: DeserializeOwned + Send + 'static>(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    method: AgentMethod,
    params: serde_json::Value,
) -> Result<T, String> {
    call_daemon(manager, db_type, driver_profile, method.as_str(), params).await
}

async fn spawn_client_for_key(manager: &AgentManager, key: &str) -> Result<AgentDriverClient, String> {
    let state = manager.load_state();
    let jre_key = state.installed_drivers.get(key).map(|driver| driver.jre.as_str()).unwrap_or(DEFAULT_JRE_KEY);

    if !manager.is_driver_installed(key) {
        return Err(format!("{key} driver is not installed. Please install it from the Driver Manager."));
    }

    let java = manager.resolve_java_runtime(&state, jre_key)?.to_string_lossy().to_string();
    let jar = manager.driver_jar_path(key).to_string_lossy().to_string();
    let mut client = AgentDriverClient::spawn(&java, &jar).await?;
    client.try_optional_handshake(manager.agent_app_version()).await;
    Ok(client)
}
