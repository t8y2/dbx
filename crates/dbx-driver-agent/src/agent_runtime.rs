use serde::de::DeserializeOwned;
use std::time::{Duration, Instant};

use crate::agent_manager::{AgentManager, DEFAULT_JRE_KEY};
use crate::agent_recovery::{RecoveryPolicy, RecoveryScope};
use crate::database_capabilities;
use crate::db::agent_driver::{AgentCallError, AgentDriverClient, AgentLaunchSpec, AgentMethod, AgentRuntimeClient};
use crate::models::connection::DatabaseType;
pub use crate::pl_debug_channel::PlDebugAgentChannel;
use crate::startup_cleanup::StartupReservationCleanup;
pub use crate::startup_cleanup::{StartupCleanup, StartupCleanupGuard, StartupCleanupSnapshot};

type SharedRuntimeCell = std::sync::Arc<tokio::sync::OnceCell<std::sync::Arc<AgentRuntimeClient>>>;
type SharedRuntimeMap = std::sync::Arc<tokio::sync::Mutex<std::collections::HashMap<String, SharedRuntimeCell>>>;

struct DedicatedStartupReservation {
    runtimes: SharedRuntimeMap,
    key: String,
    cell: SharedRuntimeCell,
    transferred: bool,
    cleanup: Option<StartupReservationCleanup>,
}

impl Drop for DedicatedStartupReservation {
    fn drop(&mut self) {
        if self.transferred {
            return;
        }
        if let Some(runtime) = self.cell.get() {
            runtime.kill();
        }
        let cleanup = self.cleanup.take();
        let remove = |runtimes: &mut std::collections::HashMap<String, SharedRuntimeCell>| {
            if runtimes.get(&self.key).is_some_and(|cell| std::sync::Arc::ptr_eq(cell, &self.cell)) {
                runtimes.remove(&self.key);
            }
        };
        if let Ok(mut runtimes) = self.runtimes.try_lock() {
            remove(&mut runtimes);
            if let Some(cleanup) = cleanup {
                cleanup.removed();
            }
        } else {
            let runtimes = self.runtimes.clone();
            let key = self.key.clone();
            let cell = self.cell.clone();
            std::thread::spawn(move || {
                let mut runtimes = runtimes.blocking_lock();
                if runtimes.get(&key).is_some_and(|current| std::sync::Arc::ptr_eq(current, &cell)) {
                    runtimes.remove(&key);
                }
                if let Some(cleanup) = cleanup {
                    cleanup.removed();
                }
            });
        }
    }
}

struct ReservedSharedRuntime {
    key: String,
    cell: SharedRuntimeCell,
    runtime: std::sync::Arc<AgentRuntimeClient>,
}

pub struct SharedConnectionOpenError {
    pub message: String,
    pub runtime: Option<std::sync::Arc<AgentRuntimeClient>>,
}

impl From<String> for SharedConnectionOpenError {
    fn from(message: String) -> Self {
        Self { message, runtime: None }
    }
}

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
    let client = spawn_client_for_key(manager, agent_key, &[], &[]).await?;
    manager.daemons.lock().await.insert(agent_key.to_string(), client);
    Ok(())
}

pub async fn spawn_connection_client(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    extra_java_args: &[String],
) -> Result<AgentDriverClient, String> {
    spawn_connection_client_with_env(manager, db_type, driver_profile, extra_java_args, &[]).await
}

/// Spawns a dedicated agent process whose environment carries `env`.
///
/// Oracle OCI ("thick") connections use this to hand process-scoped client
/// settings (`NLS_LANG`, the Instant Client loader directory) to the agent:
/// those cannot travel as connection parameters, and two connections that
/// disagree about them must never share one process.
pub async fn spawn_connection_client_with_env(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    extra_java_args: &[String],
    env: &[(String, String)],
) -> Result<AgentDriverClient, String> {
    let keys = runtime_agent_key_candidates(db_type, driver_profile)
        .ok_or_else(|| format!("{:?} is not an agent-driven database type", db_type))?;
    spawn_first_available_client(manager, &keys, extra_java_args, env).await
}

pub async fn spawn_shared_connection_client(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    extra_java_args: &[String],
    agent_env: &[(String, String)],
    agent_session_id: String,
    connect_params: serde_json::Value,
    connect_timeout: Duration,
) -> Result<AgentDriverClient, SharedConnectionOpenError> {
    let mut session_params = connect_params;
    session_params
        .as_object_mut()
        .ok_or_else(|| "Agent connect parameters must be an object".to_string())?
        .insert("agentSessionId".to_string(), serde_json::Value::String(agent_session_id.clone()));
    let ReservedSharedRuntime { key, cell, runtime } =
        reserve_shared_connection_runtime(manager, db_type, driver_profile, extra_java_args, agent_env).await?;
    let connect_result = match runtime
        .call_typed::<serde_json::Value>(AgentMethod::OpenSession.as_str(), session_params, Some(connect_timeout), None)
        .await
    {
        Ok(result) => result,
        Err(err) => {
            let open_error = shared_connection_open_error(err, runtime.clone());
            forget_unused_runtime_after_failed_open(manager, &key, &cell, &runtime).await;
            return Err(open_error);
        }
    };
    let mut client = AgentDriverClient::shared_session(runtime, agent_session_id);
    client.apply_connect_result(&connect_result);
    Ok(client)
}

/// Reserve the original process before any OpenSession RPC. `scope` is generated
/// by Core once per registered debug generation, never supplied by the browser.
pub async fn prepare_pl_debug_channel(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    extra_java_args: &[String],
    agent_env: &[(String, String)],
    agent_session_id: String,
    scope: uuid::Uuid,
) -> Result<PlDebugAgentChannel, String> {
    let mut env = agent_env.iter().filter(|(key, _)| key != "DBX_PL_DEBUG_RUNTIME_SCOPE").cloned().collect::<Vec<_>>();
    env.push(("DBX_PL_DEBUG_RUNTIME_SCOPE".into(), scope.to_string()));
    let ReservedSharedRuntime { key, runtime, .. } =
        reserve_shared_connection_runtime(manager, db_type, driver_profile, extra_java_args, &env).await?;
    Ok(PlDebugAgentChannel::from_reserved(runtime, agent_session_id, scope, key))
}

#[allow(clippy::too_many_arguments)]
pub async fn prepare_pl_debug_channel_before(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    extra_java_args: &[String],
    agent_env: &[(String, String)],
    agent_session_id: String,
    scope: uuid::Uuid,
    deadline: Instant,
) -> Result<PlDebugAgentChannel, String> {
    prepare_pl_debug_channel_before_internal(
        manager,
        db_type,
        driver_profile,
        extra_java_args,
        agent_env,
        agent_session_id,
        scope,
        deadline,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn prepare_pl_debug_channel_before_observed(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    extra_java_args: &[String],
    agent_env: &[(String, String)],
    agent_session_id: String,
    scope: uuid::Uuid,
    deadline: Instant,
    startup: StartupCleanupGuard,
) -> Result<PlDebugAgentChannel, String> {
    prepare_pl_debug_channel_before_internal(
        manager,
        db_type,
        driver_profile,
        extra_java_args,
        agent_env,
        agent_session_id,
        scope,
        deadline,
        Some(&startup),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn prepare_pl_debug_channel_before_internal(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    extra_java_args: &[String],
    agent_env: &[(String, String)],
    agent_session_id: String,
    scope: uuid::Uuid,
    deadline: Instant,
    startup: Option<&StartupCleanupGuard>,
) -> Result<PlDebugAgentChannel, String> {
    let timeout = || "PL debug channel preparation deadline exceeded".to_string();
    if Instant::now() >= deadline {
        return Err(timeout());
    }
    let mut env = agent_env.iter().filter(|(key, _)| key != "DBX_PL_DEBUG_RUNTIME_SCOPE").cloned().collect::<Vec<_>>();
    env.push(("DBX_PL_DEBUG_RUNTIME_SCOPE".into(), scope.to_string()));
    let (key, launch) = resolve_shared_runtime_launch(manager, db_type, driver_profile, extra_java_args, &env)?;
    let cell = std::sync::Arc::new(tokio::sync::OnceCell::new());
    let mut runtimes =
        tokio::time::timeout_at(deadline.into(), manager.connection_runtimes.lock()).await.map_err(|_| timeout())?;
    if Instant::now() >= deadline {
        return Err(timeout());
    }
    if runtimes.contains_key(&key) {
        return Err("The original PL debug runtime scope is already reserved".into());
    }
    runtimes.insert(key.clone(), cell.clone());
    let mut reservation = DedicatedStartupReservation {
        runtimes: manager.connection_runtimes.clone(),
        key: key.clone(),
        cell: cell.clone(),
        transferred: false,
        cleanup: startup.map(StartupCleanupGuard::reservation_started),
    };
    drop(runtimes);
    let runtime = cell
        .get_or_try_init(|| async {
            match startup {
                Some(startup) => {
                    AgentRuntimeClient::spawn_before_observed(launch, manager.agent_app_version(), deadline, startup)
                        .await
                }
                None => AgentRuntimeClient::spawn_before(launch, manager.agent_app_version(), deadline).await,
            }
        })
        .await?
        .clone();
    let mut runtimes =
        tokio::time::timeout_at(deadline.into(), manager.connection_runtimes.lock()).await.map_err(|_| timeout())?;
    if Instant::now() >= deadline {
        return Err(timeout());
    }
    if !reserve_runtime_locked(&mut runtimes, &key, &cell, &runtime) {
        return Err("The original PL debug runtime reservation changed during startup".into());
    }
    reservation.transferred = true;
    if let Some(cleanup) = reservation.cleanup.take() {
        cleanup.transferred();
    }
    Ok(PlDebugAgentChannel::from_reserved(runtime, agent_session_id, scope, key))
}

fn resolve_shared_runtime_launch(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    extra_java_args: &[String],
    agent_env: &[(String, String)],
) -> Result<(String, AgentLaunchSpec), String> {
    let keys = runtime_agent_key_candidates(db_type, driver_profile)
        .ok_or_else(|| format!("{:?} is not an agent-driven database type", db_type))?;
    let key = first_installed_agent_key(manager, &keys).unwrap_or(keys[0]);
    let state = manager.load_state();
    let jre_key = state.installed_drivers.get(key).map(|driver| driver.jre.as_str()).unwrap_or(DEFAULT_JRE_KEY);
    let launch = manager.resolve_agent_launch_spec_with_launch_env(&state, key, jre_key, extra_java_args, agent_env)?;
    Ok((shared_runtime_key(key, &launch), launch))
}

async fn reserve_shared_connection_runtime(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    extra_java_args: &[String],
    agent_env: &[(String, String)],
) -> Result<ReservedSharedRuntime, String> {
    let (runtime_key, launch) =
        resolve_shared_runtime_launch(manager, db_type, driver_profile, extra_java_args, agent_env)?;
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
    Ok(ReservedSharedRuntime { key: runtime_key, cell: runtime_cell, runtime })
}

fn shared_connection_open_error(
    error: AgentCallError,
    runtime: std::sync::Arc<AgentRuntimeClient>,
) -> SharedConnectionOpenError {
    let runtime = RecoveryPolicy::decide(&error, RecoveryScope::ConnectionOpen).replaces_runtime().then_some(runtime);
    SharedConnectionOpenError { message: error.into_legacy_string(), runtime }
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
    // `env` is part of the fingerprint on purpose: Oracle Client settings such
    // as `NLS_LANG` are process-scoped, so a connection that declares one must
    // not reuse a process started without it (or with a different value).
    let env = launch.env.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("\u{1f}");
    format!(
        "{}|{}|{}|{}|{}",
        agent_key,
        launch.program.display(),
        launch.args.join("\u{1f}"),
        launch.working_dir.as_ref().map(|path| path.display().to_string()).unwrap_or_default(),
        env
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
        let client = spawn_client_for_key(manager, &key, &[], &[]).await?;
        daemons.insert(key.clone(), client);
    }

    let client = daemons.get_mut(&key).unwrap();
    match client.call::<T>(method, params.clone()).await {
        Ok(result) => Ok(result),
        Err(err) => {
            log::warn!("[agent] daemon call failed, respawning: {err}");
            daemons.remove(&key);
            let mut new_client = spawn_client_for_key(manager, &key, &[], &[]).await?;
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
        let client = spawn_client_for_key(manager, &key, &[], &[]).await?;
        daemons.insert(key.clone(), client);
    }

    let client = daemons.get_mut(&key).unwrap();
    match client.call_with_timeout::<T>(method, params.clone(), timeout_duration).await {
        Ok(result) => Ok(result),
        Err(err) => {
            log::warn!("[agent] daemon call failed, respawning: {err}");
            daemons.remove(&key);
            let mut new_client = spawn_client_for_key(manager, &key, &[], &[]).await?;
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

/// Environment-aware sibling of [`call_daemon_method_with_timeout`].
///
/// A non-empty `env` gets a dedicated, short-lived process instead of the
/// shared per-key daemon: process-scoped Oracle OCI settings (`NLS_LANG`, the
/// Instant Client loader directory) must not leak into a process another
/// connection is already using.
pub async fn call_daemon_method_with_timeout_and_env<T: DeserializeOwned + Send + 'static>(
    manager: &AgentManager,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
    method: AgentMethod,
    params: serde_json::Value,
    timeout_duration: Option<Duration>,
    env: &[(String, String)],
) -> Result<T, String> {
    if env.is_empty() {
        return call_daemon_with_timeout(manager, db_type, driver_profile, method.as_str(), params, timeout_duration)
            .await;
    }
    let keys = runtime_agent_key_candidates(db_type, driver_profile)
        .ok_or_else(|| format!("{:?} is not an agent-driven database type", db_type))?;
    let key = first_installed_agent_key(manager, &keys).unwrap_or(keys[0]).to_string();
    let mut client = spawn_client_for_key(manager, &key, &[], env).await?;
    client.call_with_timeout::<T>(method.as_str(), params, timeout_duration).await
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
    keys: &[&str],
    extra_java_args: &[String],
    env: &[(String, String)],
) -> Result<AgentDriverClient, String> {
    let mut last_error = None;
    for key in keys {
        match spawn_client_for_key(manager, key, extra_java_args, env).await {
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
    env: &[(String, String)],
) -> Result<AgentDriverClient, String> {
    let state = manager.load_state();
    let jre_key = state.installed_drivers.get(key).map(|driver| driver.jre.as_str()).unwrap_or(DEFAULT_JRE_KEY);

    let launch = manager
        .resolve_agent_launch_spec_with_extra_args(&state, key, jre_key, extra_java_args)?
        .with_env(env.iter().cloned());
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
        let python = if cfg!(windows) { "python" } else { "python3" };
        let runtime = AgentRuntimeClient::spawn(
            crate::db::agent_driver::AgentLaunchSpec::new(python)
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

    #[tokio::test]
    async fn dedicated_reservation_drop_reaps_original_and_removes_only_its_cell() {
        for replace in [false, true] {
            let (manager, cell, runtime, script) = test_shared_runtime("dedicated-reservation-drop").await;
            let key = "oracle|test-scope".to_string();
            manager.connection_runtimes.lock().await.insert(key.clone(), cell.clone());
            let (startup, cleanup) = StartupCleanup::new_pair();
            let guard = DedicatedStartupReservation {
                runtimes: manager.connection_runtimes.clone(),
                key: key.clone(),
                cell,
                transferred: false,
                cleanup: Some(startup.reservation_started()),
            };
            drop(startup);
            let mut locked = manager.connection_runtimes.lock().await;
            let replacement = std::sync::Arc::new(tokio::sync::OnceCell::new());
            if replace {
                locked.insert(key.clone(), replacement.clone());
            }
            drop(guard);
            assert_eq!(cleanup.snapshot().reservations_pending, 1);
            assert!(!cleanup.snapshot().is_settled());
            drop(locked);
            tokio::time::timeout(Duration::from_secs(3), cleanup.wait_until_settled()).await.unwrap();
            assert!(runtime.wait_for_exit(Duration::from_secs(3)).await);
            if replace {
                assert!(std::sync::Arc::ptr_eq(
                    manager.connection_runtimes.lock().await.get(&key).unwrap(),
                    &replacement
                ));
            } else {
                tokio::time::timeout(Duration::from_secs(3), async {
                    while manager.connection_runtimes.lock().await.contains_key(&key) {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .unwrap();
            }
            runtime.kill_and_wait().await;
            let _ = std::fs::remove_file(script);
        }
    }

    #[tokio::test]
    async fn dedicated_channel_observer_closes_if_entry_future_is_never_polled() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AgentManager::new_with_base_dir(directory.path().join("agents"));
        let (startup, cleanup) = StartupCleanup::new_pair();
        let future = prepare_pl_debug_channel_before_observed(
            &manager,
            &DatabaseType::Oracle,
            None,
            &[],
            &[],
            "inspect".into(),
            uuid::Uuid::new_v4(),
            Instant::now() + Duration::from_secs(5),
            startup,
        );
        assert!(!cleanup.snapshot().producer_closed);
        drop(future);
        assert!(cleanup.snapshot().is_settled());
        assert_eq!(cleanup.snapshot().children_started, 0);
        assert!(manager.connection_runtimes.lock().await.is_empty());
    }

    #[tokio::test]
    async fn dedicated_channel_expired_deadline_does_not_reserve_or_resolve_driver() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AgentManager::new_with_base_dir(directory.path().join("agents"));
        let result = prepare_pl_debug_channel_before(
            &manager,
            &DatabaseType::Oracle,
            None,
            &[],
            &[],
            "inspect".into(),
            uuid::Uuid::new_v4(),
            Instant::now(),
        )
        .await;
        assert!(matches!(result, Err(error) if error.contains("deadline exceeded")));
        assert!(manager.connection_runtimes.lock().await.is_empty());
    }

    #[tokio::test]
    async fn dedicated_channel_startup_cancel_and_timeout_leave_no_runtime_reservation() {
        use std::io::Read;
        for cancel in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let manager = std::sync::Arc::new(AgentManager::new_with_base_dir(directory.path().join("agents")));
            let driver_dir = manager.driver_dir("oracle");
            std::fs::create_dir_all(&driver_dir).unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            std::fs::write(
                driver_dir.join("agent.py"),
                "import socket,sys,time\ns=socket.create_connection(('127.0.0.1',int(sys.argv[1])))\ntime.sleep(30)\n",
            )
            .unwrap();
            std::fs::write(
                manager.driver_launch_config_path("oracle"),
                serde_json::json!({
                    "command": if cfg!(windows) {"python"} else {"python3"},
                    "args":["{driver_dir}/agent.py",port.to_string()],"working_dir":"{driver_dir}"
                })
                .to_string(),
            )
            .unwrap();
            let own_manager = manager.clone();
            let (startup, cleanup) = StartupCleanup::new_pair();
            let task = tokio::spawn(async move {
                prepare_pl_debug_channel_before_observed(
                    &own_manager,
                    &DatabaseType::Oracle,
                    None,
                    &[],
                    &[],
                    "inspect".into(),
                    uuid::Uuid::new_v4(),
                    Instant::now() + Duration::from_secs(2),
                    startup,
                )
                .await
            });
            let connected = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                        Err(error) => panic!("startup witness accept failed: {error}"),
                    }
                }
            })
            .await;
            if connected.is_err() {
                task.abort();
                panic!("dedicated channel did not launch the test Agent");
            }
            let mut stream = connected.unwrap();
            stream.set_nonblocking(false).unwrap();
            assert_eq!(manager.connection_runtimes.lock().await.len(), 1);
            if cancel {
                task.abort();
                assert!(matches!(task.await, Err(error) if error.is_cancelled()));
            } else {
                assert!(tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap().is_err());
            }
            assert!(manager.connection_runtimes.lock().await.is_empty());
            tokio::time::timeout(Duration::from_secs(3), cleanup.wait_until_settled()).await.unwrap();
            assert_eq!(cleanup.snapshot().children_started, 1);
            assert_eq!(cleanup.snapshot().children_exited, 1);
            assert_eq!(cleanup.snapshot().reservations_pending, 0);
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let closed = tokio::task::spawn_blocking(move || stream.read(&mut [0u8; 1])).await.unwrap();
            assert!(
                matches!(closed, Ok(0))
                    || matches!(closed, Err(error) if matches!(error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted))
            );
        }
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

    #[test]
    fn shared_runtime_key_isolates_process_scoped_env() {
        let base = crate::db::agent_driver::AgentLaunchSpec::new(PathBuf::from("oracle-agent"));
        let with_nls =
            base.clone().with_env([("NLS_LANG".to_string(), "SIMPLIFIED CHINESE_CHINA.AL32UTF8".to_string())]);
        let with_other_nls = base.clone().with_env([("NLS_LANG".to_string(), "AMERICAN_AMERICA.AL32UTF8".to_string())]);

        // Setting a process-scoped variable must route to a dedicated process …
        assert_ne!(shared_runtime_key("oracle", &base), shared_runtime_key("oracle", &with_nls));
        // … and two different values must never share one process either.
        assert_ne!(shared_runtime_key("oracle", &with_nls), shared_runtime_key("oracle", &with_other_nls));
        // Identical env still reuses the same process.
        assert_eq!(shared_runtime_key("oracle", &with_nls), shared_runtime_key("oracle", &with_nls.clone()));
    }

    #[tokio::test]
    async fn shared_connection_entry_applies_each_database_exact_identity_result() {
        use crate::db::agent_driver::AgentCapability;
        let directory = tempfile::tempdir().unwrap();
        let manager = AgentManager::new_with_base_dir_and_app_version(directory.path().join("agents"), "test");
        let driver_dir = manager.driver_dir("oracle");
        std::fs::create_dir_all(&driver_dir).unwrap();
        std::fs::write(driver_dir.join("agent.py"), r#"import json, sys
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    req = json.loads(line); params = req.get('params', {})
    if req['method'] == 'open_session' and params.get('database') == 'failed':
        print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-1,'message':'open refused'}}), flush=True)
        continue
    if req['method'] == 'handshake':
        result = {'protocolVersion':2,'agentProtocolVersion':2,'capabilities':['multi_session','exact_metadata_identity_v1']}
    else:
        result = {'ok':True}
        if params.get('database') in ('legacy', 'modern'):
            result['exactMetadataIdentity'] = params['database'] == 'modern'
    print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}), flush=True)
"#).unwrap();
        let python = if cfg!(windows) { "python" } else { "python3" };
        std::fs::write(
            manager.driver_launch_config_path("oracle"),
            serde_json::json!({
                "command":python,"args":["{driver_dir}/agent.py"],"working_dir":"{driver_dir}"
            })
            .to_string(),
        )
        .unwrap();
        let failed = spawn_shared_connection_client(
            &manager,
            &DatabaseType::Oracle,
            None,
            &[],
            &[],
            "failed".into(),
            serde_json::json!({"database":"failed"}),
            Duration::from_secs(3),
        )
        .await;
        assert!(failed.is_err());
        assert!(manager.connection_runtimes.lock().await.is_empty());
        for (database, supported) in [("legacy", false), ("modern", true), ("old-response", true)] {
            let mut client = spawn_shared_connection_client(
                &manager,
                &DatabaseType::Oracle,
                None,
                &[],
                &[],
                database.into(),
                serde_json::json!({"database":database}),
                Duration::from_secs(3),
            )
            .await
            .unwrap_or_else(|error| panic!("{}", error.message));
            assert_eq!(client.supports_capability(AgentCapability::ExactMetadataIdentityV1), supported, "{database}");
            let result: serde_json::Value = client.call("get_tables", serde_json::json!({})).await.unwrap();
            assert_eq!(result["ok"], true);
            client.shutdown().await;
        }
    }

    #[tokio::test]
    async fn pl_debug_scopes_isolate_real_processes_and_keep_ordinary_runtime_sharing() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AgentManager::new_with_base_dir_and_app_version(directory.path().join("agents"), "test");
        let driver_dir = manager.driver_dir("oracle");
        std::fs::create_dir_all(&driver_dir).unwrap();
        std::fs::write(
            driver_dir.join("agent.py"),
            r#"import json, os, pathlib, sys
scope = os.environ.get('DBX_PL_DEBUG_RUNTIME_SCOPE', 'ordinary')
marker = pathlib.Path(__file__).parent/('opens-'+scope)
opens = 0; marker.write_text('0')
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    req = json.loads(line); method = req['method']
    if method == 'handshake':
        result = {'protocolVersion':2,'agentProtocolVersion':2,'capabilities':['multi_session']}
    else:
        if method == 'open_session': opens += 1; marker.write_text(str(opens))
        result = {'pid':os.getpid(),'scope':scope,'nls':os.environ.get('NLS_LANG'),'opens':opens,
                  'agentSessionId':req.get('params',{}).get('agentSessionId')}
    print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}),flush=True)
"#,
        )
        .unwrap();
        let python = if cfg!(windows) { "python" } else { "python3" };
        std::fs::write(
            manager.driver_launch_config_path("oracle"),
            serde_json::json!({
                "command":python,"args":["{driver_dir}/agent.py"],"working_dir":"{driver_dir}"
            })
            .to_string(),
        )
        .unwrap();
        let env = vec![("NLS_LANG".to_string(), "AMERICAN_AMERICA.AL32UTF8".to_string())];
        let mut ordinary_a = spawn_shared_connection_client(
            &manager,
            &DatabaseType::Oracle,
            None,
            &[],
            &env,
            "ordinary-a".into(),
            serde_json::json!({"role":"metadata"}),
            Duration::from_secs(3),
        )
        .await
        .unwrap_or_else(|error| panic!("{}", error.message));
        let mut ordinary_b = spawn_shared_connection_client(
            &manager,
            &DatabaseType::Oracle,
            None,
            &[],
            &env,
            "ordinary-b".into(),
            serde_json::json!({"role":"metadata"}),
            Duration::from_secs(3),
        )
        .await
        .unwrap_or_else(|error| panic!("{}", error.message));
        let a: serde_json::Value = ordinary_a.call("probe", serde_json::json!({})).await.unwrap();
        let b: serde_json::Value = ordinary_b.call("probe", serde_json::json!({})).await.unwrap();
        let mut scoped_env = env.clone();
        scoped_env.push(("DBX_PL_DEBUG_RUNTIME_SCOPE".into(), "not-the-core-scope".into()));
        let first_scope = uuid::Uuid::new_v4();
        let second_scope = uuid::Uuid::new_v4();
        let (startup, cleanup) = StartupCleanup::new_pair();
        let first = prepare_pl_debug_channel_before_observed(
            &manager,
            &DatabaseType::Oracle,
            None,
            &[],
            &scoped_env,
            "debug-first".into(),
            first_scope,
            Instant::now() + Duration::from_secs(5),
            startup,
        )
        .await
        .unwrap();
        assert_eq!(cleanup.snapshot().children_started, 1);
        assert_eq!(cleanup.snapshot().reservations_transferred, 1);
        assert!(!cleanup.snapshot().is_settled());
        let second = prepare_pl_debug_channel(
            &manager,
            &DatabaseType::Oracle,
            None,
            &[],
            &scoped_env,
            "debug-second".into(),
            second_scope,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(driver_dir.join(format!("opens-{first_scope}"))).unwrap(), "0");
        assert_eq!(std::fs::read_to_string(driver_dir.join(format!("opens-{second_scope}"))).unwrap(), "0");
        let one = first.open_session(serde_json::json!({"role":"metadata"}), Duration::from_secs(3)).await.unwrap();
        let two = second.open_session(serde_json::json!({"role":"metadata"}), Duration::from_secs(3)).await.unwrap();
        let first_status: serde_json::Value =
            first.call("pl_debug_status", serde_json::json!({}), Duration::from_secs(3), None).await.unwrap();
        assert!(!first.retire_after_exit(&manager).await);
        first.fail_stop();
        assert!(first.wait_for_exit(Duration::from_secs(3)).await);
        assert!(first.retire_after_exit(&manager).await);
        assert!(first.retire_after_exit(&manager).await);
        tokio::time::timeout(Duration::from_secs(3), cleanup.wait_until_settled()).await.unwrap();
        assert_eq!(manager.connection_runtimes.lock().await.len(), 2);
        let sibling_status: serde_json::Value =
            second.call("pl_debug_status", serde_json::json!({}), Duration::from_secs(3), None).await.unwrap();
        let ordinary_status: serde_json::Value = ordinary_b.call("probe", serde_json::json!({})).await.unwrap();
        stop_daemons(&manager).await;

        assert_eq!(a["pid"], b["pid"]);
        assert_eq!(a["opens"], 2);
        assert_ne!(one["pid"], a["pid"]);
        assert_ne!(two["pid"], a["pid"]);
        assert_ne!(one["pid"], two["pid"]);
        assert_eq!(one["scope"], first_scope.to_string());
        assert_eq!(two["scope"], second_scope.to_string());
        assert_eq!(first_status["nls"], "AMERICAN_AMERICA.AL32UTF8");
        assert_eq!(first_status["agentSessionId"], "debug-first");
        assert_eq!(first_status["opens"], 1);
        assert_eq!(sibling_status["pid"], two["pid"]);
        assert_eq!(ordinary_status["pid"], a["pid"]);
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
    async fn replace_runtime_open_error_reports_runtime_without_killing_it_directly() {
        let (manager, _cell, runtime, script_path) = test_shared_runtime("replace-runtime-open-error").await;
        let error = AgentCallError::Legacy {
            rpc_code: Some(-1),
            message: "capacity exhausted".to_string(),
            hints: crate::db::agent_driver::LegacyAgentHints {
                category: Some(crate::db::agent_driver::AgentErrorCategory::Resource),
                session_disposition: Some(crate::db::agent_driver::AgentSessionDisposition::ReplaceRuntime),
                ..Default::default()
            },
        };

        let open_error = shared_connection_open_error(error, runtime.clone());

        assert!(open_error.runtime.as_ref().is_some_and(|failed| std::sync::Arc::ptr_eq(failed, &runtime)));
        assert!(!runtime.is_failed());

        runtime.kill();
        drop(manager);
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
