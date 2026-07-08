use serde::de::DeserializeOwned;
use std::time::Duration;

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
    let client = spawn_client_for_key(manager, agent_key, &[]).await?;
    manager.daemons.lock().await.insert(agent_key.to_string(), client);
    Ok(())
}

pub async fn spawn_connection_client(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    extra_java_args: &[String],
) -> Result<AgentDriverClient, String> {
    let keys = runtime_agent_key_candidates(db_type, driver_profile)
        .ok_or_else(|| format!("{:?} is not an agent-driven database type", db_type))?;
    spawn_first_available_client(manager, &keys, extra_java_args).await
}

pub async fn call_daemon<T: DeserializeOwned + Send + 'static>(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    method: &str,
    params: serde_json::Value,
) -> Result<T, String> {
    let keys = runtime_agent_key_candidates(db_type, driver_profile)
        .ok_or_else(|| format!("{:?} is not an agent-driven database type", db_type))?;
    let key = first_installed_agent_key(manager, &keys).unwrap_or(keys[0]).to_string();

    let mut daemons = manager.daemons.lock().await;

    if !daemons.contains_key(&key) {
        let client = spawn_client_for_key(manager, &key, &[]).await?;
        daemons.insert(key.clone(), client);
    }

    let client = daemons.get_mut(&key).unwrap();
    match client.call::<T>(method, params.clone()).await {
        Ok(result) => Ok(result),
        Err(err) => {
            log::warn!("[agent] daemon call failed, respawning: {err}");
            daemons.remove(&key);
            let mut new_client = spawn_client_for_key(manager, &key, &[]).await?;
            let result = new_client.call::<T>(method, params).await?;
            daemons.insert(key, new_client);
            Ok(result)
        }
    }
}

pub async fn call_daemon_with_timeout<T: DeserializeOwned + Send + 'static>(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    method: &str,
    params: serde_json::Value,
    timeout_duration: Option<Duration>,
) -> Result<T, String> {
    let keys = runtime_agent_key_candidates(db_type, driver_profile)
        .ok_or_else(|| format!("{:?} is not an agent-driven database type", db_type))?;
    let key = first_installed_agent_key(manager, &keys).unwrap_or(keys[0]).to_string();

    let mut daemons = manager.daemons.lock().await;

    if !daemons.contains_key(&key) {
        let client = spawn_client_for_key(manager, &key, &[]).await?;
        daemons.insert(key.clone(), client);
    }

    let client = daemons.get_mut(&key).unwrap();
    match client.call_with_timeout::<T>(method, params.clone(), timeout_duration).await {
        Ok(result) => Ok(result),
        Err(err) => {
            log::warn!("[agent] daemon call failed, respawning: {err}");
            daemons.remove(&key);
            let mut new_client = spawn_client_for_key(manager, &key, &[]).await?;
            let result = new_client.call_with_timeout::<T>(method, params, timeout_duration).await?;
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

pub async fn call_daemon_method_with_timeout<T: DeserializeOwned + Send + 'static>(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    method: AgentMethod,
    params: serde_json::Value,
    timeout_duration: Option<Duration>,
) -> Result<T, String> {
    call_daemon_with_timeout(manager, db_type, driver_profile, method.as_str(), params, timeout_duration).await
}

fn runtime_agent_key_candidates(db_type: &DatabaseType, driver_profile: Option<&str>) -> Option<Vec<&'static str>> {
    let primary = db_type_to_agent_key(db_type, driver_profile)?;
    Some(vec![primary])
}

fn first_installed_agent_key<'a>(manager: &AgentManager, keys: &'a [&'static str]) -> Option<&'a str> {
    keys.iter().copied().find(|key| manager.is_driver_installed(key))
}

async fn spawn_first_available_client(
    manager: &AgentManager,
    keys: &[&'static str],
    extra_java_args: &[String],
) -> Result<AgentDriverClient, String> {
    let mut last_error = None;
    for key in keys {
        match spawn_client_for_key(manager, key, extra_java_args).await {
            Ok(client) => return Ok(client),
            Err(err) => last_error = Some(err),
        }
    }
    Err(last_error.unwrap_or_else(|| "No agent driver candidates available".to_string()))
}

async fn spawn_client_for_key(
    manager: &AgentManager,
    key: &str,
    extra_java_args: &[String],
) -> Result<AgentDriverClient, String> {
    let state = manager.load_state();
    let jre_key = state.installed_drivers.get(key).map(|driver| driver.jre.as_str()).unwrap_or(DEFAULT_JRE_KEY);

    let launch = manager.resolve_agent_launch_spec_with_extra_args(&state, key, jre_key, extra_java_args)?;
    let mut client = AgentDriverClient::spawn(launch).await?;
    client.try_optional_handshake(manager.agent_app_version()).await;
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prestosql_does_not_use_agent_driver() {
        assert_eq!(runtime_agent_key_candidates(&DatabaseType::PrestoSql, None), None);
    }

    #[test]
    fn trino_uses_only_trino_agent_driver() {
        assert_eq!(runtime_agent_key_candidates(&DatabaseType::Trino, None).unwrap(), vec!["trino"]);
    }
}
