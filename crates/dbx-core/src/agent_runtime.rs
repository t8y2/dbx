use serde::de::DeserializeOwned;
use std::time::Duration;

use crate::agent_manager::{AgentManager, DEFAULT_JRE_KEY};
use crate::database_capabilities;
use crate::db::agent_driver::{AgentDriverClient, AgentMethod, AgentRuntimeClient};
use crate::models::connection::DatabaseType;

pub fn db_type_to_agent_key(db_type: &DatabaseType, driver_profile: Option<&str>) -> Option<&'static str> {
    database_capabilities::agent_key(db_type, driver_profile)
}

pub fn is_agent_type(db_type: &DatabaseType) -> bool {
    database_capabilities::is_agent_type(db_type)
}

pub async fn stop_daemons(manager: &AgentManager) {
    manager.daemons.lock().await.clear();
    let runtimes = std::mem::take(&mut *manager.connection_runtimes.lock().await);
    for runtime in runtimes.into_values().filter_map(|cell| cell.get().cloned()) {
        runtime.kill_and_wait().await;
    }
}

pub async fn stop_daemon_by_key(manager: &AgentManager, agent_key: &str) {
    manager.daemons.lock().await.remove(agent_key);
    let runtimes = {
        let mut runtimes = manager.connection_runtimes.lock().await;
        let matching =
            runtimes.keys().filter(|key| key.starts_with(&format!("{agent_key}|"))).cloned().collect::<Vec<_>>();
        matching
            .into_iter()
            .filter_map(|key| runtimes.remove(&key).and_then(|cell| cell.get().cloned()))
            .collect::<Vec<_>>()
    };
    for runtime in runtimes {
        runtime.kill_and_wait().await;
    }
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

pub async fn spawn_shared_connection_client(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    extra_java_args: &[String],
    agent_session_id: String,
    connect_params: serde_json::Value,
    connect_timeout: Duration,
) -> Result<AgentDriverClient, String> {
    let keys = runtime_agent_key_candidates(db_type, driver_profile)
        .ok_or_else(|| format!("{:?} is not an agent-driven database type", db_type))?;
    let key = first_installed_agent_key(manager, &keys).unwrap_or(keys[0]);
    let state = manager.load_state();
    let jre_key = state.installed_drivers.get(key).map(|driver| driver.jre.as_str()).unwrap_or(DEFAULT_JRE_KEY);
    let launch = manager.resolve_agent_launch_spec_with_extra_args(&state, key, jre_key, extra_java_args)?;
    let runtime_key = shared_runtime_key(key, &launch);
    let mut session_params = connect_params;
    session_params
        .as_object_mut()
        .ok_or_else(|| "Agent connect parameters must be an object".to_string())?
        .insert("agentSessionId".to_string(), serde_json::Value::String(agent_session_id.clone()));

    let (runtime_cell, runtime) = loop {
        let runtime_cell = {
            let mut runtimes = manager.connection_runtimes.lock().await;
            if runtimes.get(&runtime_key).and_then(|cell| cell.get()).is_some_and(|runtime| runtime.is_failed()) {
                runtimes.remove(&runtime_key);
            }
            runtimes
                .entry(runtime_key.clone())
                .or_insert_with(|| std::sync::Arc::new(tokio::sync::OnceCell::new()))
                .clone()
        };
        let runtime = runtime_cell
            .get_or_try_init(|| AgentRuntimeClient::spawn(launch.clone(), manager.agent_app_version()))
            .await?
            .clone();

        let mut runtimes = manager.connection_runtimes.lock().await;
        if reserve_runtime_locked(&mut runtimes, &runtime_key, &runtime_cell, &runtime) {
            break (runtime_cell, runtime);
        }
    };
    if let Err(err) = runtime
        .call::<serde_json::Value>(AgentMethod::OpenSession.as_str(), session_params, Some(connect_timeout), None)
        .await
    {
        forget_unused_runtime_after_failed_open(manager, &runtime_key, &runtime_cell, &runtime).await;
        return Err(err);
    }
    Ok(AgentDriverClient::shared_session(runtime, agent_session_id))
}

async fn forget_unused_runtime_after_failed_open(
    manager: &AgentManager,
    runtime_key: &str,
    runtime_cell: &std::sync::Arc<tokio::sync::OnceCell<std::sync::Arc<AgentRuntimeClient>>>,
    runtime: &std::sync::Arc<AgentRuntimeClient>,
) {
    if AgentRuntimeClient::decrement_session_count(runtime) != 0 {
        return;
    }

    remove_unused_runtime_if_current(manager, runtime_key, runtime_cell, runtime).await;
}

async fn remove_unused_runtime_if_current(
    manager: &AgentManager,
    runtime_key: &str,
    runtime_cell: &std::sync::Arc<tokio::sync::OnceCell<std::sync::Arc<AgentRuntimeClient>>>,
    runtime: &std::sync::Arc<AgentRuntimeClient>,
) {
    // Keep reservation and map-entry validation under the same lock as openers.
    let mut runtimes = manager.connection_runtimes.lock().await;
    if runtime.active_session_count() == 0
        && runtimes.get(runtime_key).is_some_and(|current| std::sync::Arc::ptr_eq(current, runtime_cell))
    {
        runtimes.remove(runtime_key);
    }
}

fn reserve_runtime_locked(
    runtimes: &mut std::collections::HashMap<
        String,
        std::sync::Arc<tokio::sync::OnceCell<std::sync::Arc<AgentRuntimeClient>>>,
    >,
    runtime_key: &str,
    runtime_cell: &std::sync::Arc<tokio::sync::OnceCell<std::sync::Arc<AgentRuntimeClient>>>,
    runtime: &std::sync::Arc<AgentRuntimeClient>,
) -> bool {
    if runtimes.get(runtime_key).is_some_and(|current| std::sync::Arc::ptr_eq(current, runtime_cell))
        && !runtime.is_failed()
    {
        runtime.increment_session_count();
        true
    } else {
        false
    }
}

fn shared_runtime_key(agent_key: &str, launch: &crate::db::agent_driver::AgentLaunchSpec) -> String {
    format!(
        "{}|{}|{}|{}",
        agent_key,
        launch.program.display(),
        launch.args.join("\u{1f}"),
        launch.working_dir.as_ref().map(|path| path.display().to_string()).unwrap_or_default()
    )
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
    use std::path::PathBuf;

    async fn test_shared_runtime(
        name: &str,
    ) -> (
        AgentManager,
        std::sync::Arc<tokio::sync::OnceCell<std::sync::Arc<AgentRuntimeClient>>>,
        std::sync::Arc<AgentRuntimeClient>,
        PathBuf,
    ) {
        let test_id = uuid::Uuid::new_v4();
        let script_path = std::env::temp_dir().join(format!("dbx-agent-runtime-{name}-{test_id}.py"));
        std::fs::write(
            &script_path,
            r#"import json, sys
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    result = {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']} if req['method'] == 'handshake' else {'ok': True}
    print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'result': result}), flush=True)
"#,
        )
        .unwrap();
        let runtime = AgentRuntimeClient::spawn(
            crate::db::agent_driver::AgentLaunchSpec::new("python3")
                .with_args([script_path.to_string_lossy().to_string()]),
            "test",
        )
        .await
        .unwrap();
        let cell = std::sync::Arc::new(tokio::sync::OnceCell::new());
        assert!(cell.set(runtime.clone()).is_ok());
        let manager_dir = std::env::temp_dir().join(format!("dbx-agent-manager-{name}-{test_id}"));
        let manager = AgentManager::new_with_base_dir_and_app_version(manager_dir, "test");
        (manager, cell, runtime, script_path)
    }

    #[test]
    fn prestosql_does_not_use_agent_driver() {
        assert_eq!(runtime_agent_key_candidates(&DatabaseType::PrestoSql, None), None);
    }

    #[test]
    fn trino_uses_only_trino_agent_driver() {
        assert_eq!(runtime_agent_key_candidates(&DatabaseType::Trino, None).unwrap(), vec!["trino"]);
    }

    #[test]
    fn shared_runtime_key_includes_launch_fingerprint() {
        let base = crate::db::agent_driver::AgentLaunchSpec::new(PathBuf::from("oracle-agent"))
            .with_args(["--mode", "stdio"])
            .with_working_dir(PathBuf::from("/tmp/oracle"));
        let different_args = crate::db::agent_driver::AgentLaunchSpec::new(PathBuf::from("oracle-agent"))
            .with_args(["--mode", "debug"])
            .with_working_dir(PathBuf::from("/tmp/oracle"));

        assert_eq!(shared_runtime_key("oracle", &base), shared_runtime_key("oracle", &base));
        assert_ne!(shared_runtime_key("oracle", &base), shared_runtime_key("oracle", &different_args));
    }

    #[tokio::test]
    async fn failed_open_forgets_runtime_when_no_other_session_uses_it() {
        let (manager, cell, runtime, script_path) = test_shared_runtime("failed-open-unused").await;
        let runtime_key = "kingbase|test";
        manager.connection_runtimes.lock().await.insert(runtime_key.to_string(), cell.clone());
        runtime.increment_session_count();

        forget_unused_runtime_after_failed_open(&manager, runtime_key, &cell, &runtime).await;

        assert!(!manager.connection_runtimes.lock().await.contains_key(runtime_key));
        assert_eq!(runtime.active_session_count(), 0);
        runtime.kill();
        let _ = std::fs::remove_file(script_path);
    }

    #[tokio::test]
    async fn failed_open_keeps_runtime_while_another_session_is_reserved() {
        let (manager, cell, runtime, script_path) = test_shared_runtime("failed-open-in-use").await;
        let runtime_key = "oracle|test";
        manager.connection_runtimes.lock().await.insert(runtime_key.to_string(), cell.clone());
        runtime.increment_session_count();
        runtime.increment_session_count();

        forget_unused_runtime_after_failed_open(&manager, runtime_key, &cell, &runtime).await;

        assert!(manager.connection_runtimes.lock().await.contains_key(runtime_key));
        assert_eq!(runtime.active_session_count(), 1);
        AgentRuntimeClient::decrement_session_count(&runtime);
        runtime.kill();
        let _ = std::fs::remove_file(script_path);
    }

    #[tokio::test]
    async fn failed_open_cleanup_cannot_remove_runtime_after_reservation() {
        let (manager, cell, runtime, script_path) = test_shared_runtime("failed-open-race").await;
        let runtime_key = "oracle|test";
        manager.connection_runtimes.lock().await.insert(runtime_key.to_string(), cell.clone());
        runtime.increment_session_count();

        assert_eq!(AgentRuntimeClient::decrement_session_count(&runtime), 0);
        let mut runtimes = manager.connection_runtimes.lock().await;
        assert!(reserve_runtime_locked(&mut runtimes, runtime_key, &cell, &runtime));
        drop(runtimes);

        remove_unused_runtime_if_current(&manager, runtime_key, &cell, &runtime).await;

        assert!(manager.connection_runtimes.lock().await.contains_key(runtime_key));
        assert_eq!(runtime.active_session_count(), 1);
        AgentRuntimeClient::decrement_session_count(&runtime);
        runtime.kill();
        let _ = std::fs::remove_file(script_path);
    }

    #[tokio::test]
    async fn stopping_driver_runtime_removes_and_terminates_shared_process() {
        let (manager, cell, runtime, script_path) = test_shared_runtime("stop-driver-runtime").await;
        let runtime_key = "dameng|test";
        manager.connection_runtimes.lock().await.insert(runtime_key.to_string(), cell);

        stop_daemon_by_key(&manager, "dameng").await;

        assert!(!manager.connection_runtimes.lock().await.contains_key(runtime_key));
        assert!(runtime.is_failed());
        let call_result =
            runtime.call::<serde_json::Value>("ping", serde_json::json!({}), Some(Duration::from_secs(1)), None).await;
        assert_eq!(call_result.unwrap_err(), "Agent runtime is unavailable");
        let _ = std::fs::remove_file(script_path);
    }
}
