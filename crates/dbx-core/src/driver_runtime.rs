use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

use crate::agent_catalog;
use crate::connection::{config_for_pool_key, AppState, PoolKind};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DriverRuntimeInfo {
    pub id: String,
    pub driver_key: String,
    pub label: String,
    pub kind: String,
    pub source: String,
    pub status: String,
    pub pid: Option<u32>,
    pub memory_bytes: Option<u64>,
    pub cpu_percent: Option<f32>,
    pub uptime_seconds: Option<u64>,
    pub version: Option<String>,
    pub last_error: Option<String>,
    pub can_stop: bool,
    pub can_restart: bool,
    pub control_unavailable_reason: Option<String>,
    #[serde(default)]
    pub protocol_mode: Option<String>,
    #[serde(default)]
    pub active_sessions: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct DriverRuntimeSummary {
    pub running_count: usize,
    pub total_memory_bytes: u64,
    pub last_error: Option<String>,
    pub health: String,
    pub runtimes: Vec<DriverRuntimeInfo>,
}

#[derive(Debug, Clone)]
struct RuntimeSeed {
    id: String,
    driver_key: String,
    label: String,
    kind: String,
    source: String,
    status: String,
    pid: Option<u32>,
    version: Option<String>,
    last_error: Option<String>,
    can_stop: bool,
    can_restart: bool,
    control_unavailable_reason: Option<String>,
    protocol_mode: Option<String>,
    active_sessions: Option<u64>,
}

#[derive(Debug, Clone, Default)]
struct ProcessStats {
    memory_bytes: u64,
    cpu_percent: f32,
    uptime_seconds: u64,
}

pub async fn collect_driver_runtime_summary(state: &AppState) -> DriverRuntimeSummary {
    let seeds = collect_runtime_seeds(state).await;
    let pids = seeds.iter().filter_map(|seed| seed.pid).collect::<HashSet<_>>();
    let stats = collect_process_stats(pids).await;
    build_summary(seeds, &stats)
}

pub async fn stop_driver_runtime(state: &AppState, runtime_id: &str) -> Result<(), String> {
    let agent_key = runtime_agent_key(runtime_id).ok_or_else(|| "Only agent runtimes can be stopped".to_string())?;
    state.agent_manager.stop_daemon_by_key(agent_key).await;
    Ok(())
}

pub async fn restart_driver_runtime(state: &AppState, runtime_id: &str) -> Result<(), String> {
    let agent_key = runtime_agent_key(runtime_id).ok_or_else(|| "Only agent runtimes can be restarted".to_string())?;
    if runtime_id.starts_with("agent-runtime:") {
        // Shared connection runtimes are recreated lazily with their exact launch
        // fingerprint; eagerly spawning the generic daemon could use incompatible options.
        state.agent_manager.stop_daemon_by_key(agent_key).await;
        Ok(())
    } else {
        state.agent_manager.restart_daemon_by_key(agent_key).await
    }
}

fn runtime_agent_key(runtime_id: &str) -> Option<&str> {
    runtime_id.strip_prefix("agent:").or_else(|| {
        runtime_id.strip_prefix("agent-runtime:").and_then(|value| value.rsplit_once(':').map(|(key, _)| key))
    })
}

async fn collect_runtime_seeds(state: &AppState) -> Vec<RuntimeSeed> {
    let agent_state = state.agent_manager.load_state();
    let mut seeds = HashMap::<String, RuntimeSeed>::new();

    for (key, installed) in &agent_state.installed_drivers {
        seeds.insert(
            format!("agent:{key}"),
            RuntimeSeed {
                id: format!("agent:{key}"),
                driver_key: key.clone(),
                label: agent_catalog::label_for_key(key).unwrap_or(key).to_string(),
                kind: "agent".to_string(),
                source: "daemon".to_string(),
                status: "stopped".to_string(),
                pid: None,
                version: Some(installed.version.clone()),
                last_error: None,
                can_stop: false,
                can_restart: state.agent_manager.is_driver_installed(key),
                control_unavailable_reason: None,
                protocol_mode: None,
                active_sessions: None,
            },
        );
    }

    {
        let daemons = state.agent_manager.daemons.lock().await;
        for (key, client) in daemons.iter() {
            let last_error = non_empty(client.stderr_tail_snapshot());
            seeds.insert(
                format!("agent:{key}"),
                RuntimeSeed {
                    id: format!("agent:{key}"),
                    driver_key: key.clone(),
                    label: agent_catalog::label_for_key(key).unwrap_or(key).to_string(),
                    kind: "agent".to_string(),
                    source: "daemon".to_string(),
                    status: "running".to_string(),
                    pid: Some(client.pid()),
                    version: agent_state.installed_drivers.get(key).map(|driver| driver.version.clone()),
                    last_error,
                    can_stop: true,
                    can_restart: true,
                    control_unavailable_reason: None,
                    protocol_mode: Some("legacy".to_string()),
                    active_sessions: None,
                },
            );
        }
    }

    let configs = state.configs.read().await;
    let connections = state.connections.read().await;
    for (pool_key, pool) in connections.iter() {
        match pool {
            PoolKind::Agent(client) => {
                let Some(config) = config_for_pool_key(pool_key, &configs) else {
                    continue;
                };
                let key = crate::agent_manager::AgentManager::db_type_to_agent_key(
                    &config.db_type,
                    config.driver_profile.as_deref(),
                )
                .unwrap_or("agent");
                let client = client.lock().await;
                let last_error = non_empty(client.stderr_tail_snapshot());
                let protocol_mode = client.protocol_mode();
                let runtime_id = if protocol_mode == "multi_session" {
                    format!("agent-runtime:{key}:{}", client.pid())
                } else {
                    format!("agent-connection:{pool_key}")
                };
                seeds.insert(
                    runtime_id.clone(),
                    RuntimeSeed {
                        id: runtime_id,
                        driver_key: key.to_string(),
                        label: agent_catalog::label_for_key(key).unwrap_or(key).to_string(),
                        kind: "agent".to_string(),
                        source: if protocol_mode == "multi_session" { "shared-runtime" } else { "connection" }
                            .to_string(),
                        status: "running".to_string(),
                        pid: Some(client.pid()),
                        version: agent_state.installed_drivers.get(key).map(|driver| driver.version.clone()),
                        last_error,
                        can_stop: protocol_mode == "multi_session",
                        can_restart: protocol_mode == "multi_session",
                        control_unavailable_reason: (protocol_mode != "multi_session")
                            .then(|| "connection-owned".to_string()),
                        protocol_mode: Some(protocol_mode.to_string()),
                        active_sessions: Some(client.active_session_count()),
                    },
                );
            }
            PoolKind::ExternalDriver { driver_id, session, .. } => {
                seeds.insert(
                    format!("plugin-connection:{pool_key}"),
                    RuntimeSeed {
                        id: format!("plugin-connection:{pool_key}"),
                        driver_key: driver_id.clone(),
                        label: driver_id.clone(),
                        kind: "plugin".to_string(),
                        source: "connection".to_string(),
                        status: "running".to_string(),
                        pid: session.pid().await,
                        version: None,
                        last_error: None,
                        can_stop: false,
                        can_restart: false,
                        control_unavailable_reason: Some("connection-owned".to_string()),
                        protocol_mode: None,
                        active_sessions: None,
                    },
                );
            }
            _ => {}
        }
    }

    let mut output = seeds.into_values().collect::<Vec<_>>();
    sort_runtime_seeds(&mut output);
    output
}

fn sort_runtime_seeds(runtimes: &mut [RuntimeSeed]) {
    runtimes.sort_by(|left, right| {
        // Active runtimes are the primary operational focus; preserve the
        // existing deterministic order within active and inactive groups.
        runtime_activity_rank(&left.status).cmp(&runtime_activity_rank(&right.status)).then(
            left.kind
                .cmp(&right.kind)
                .then(left.label.cmp(&right.label))
                .then(left.source.cmp(&right.source))
                .then(left.id.cmp(&right.id)),
        )
    });
}

fn runtime_activity_rank(status: &str) -> u8 {
    if status == "running" {
        0
    } else {
        1
    }
}

async fn collect_process_stats(pids: HashSet<u32>) -> HashMap<u32, ProcessStats> {
    if pids.is_empty() {
        return HashMap::new();
    }

    tokio::task::spawn_blocking(move || {
        let mut system = System::new_with_specifics(
            RefreshKind::new().with_processes(ProcessRefreshKind::new().with_cpu().with_memory().with_disk_usage()),
        );
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::new().with_cpu().with_memory().with_disk_usage(),
        );

        let mut stats = HashMap::new();
        for pid in pids {
            let Some(process) = system.process(Pid::from(pid as usize)) else {
                continue;
            };
            stats.insert(
                pid,
                ProcessStats {
                    memory_bytes: process.memory(),
                    cpu_percent: process.cpu_usage(),
                    uptime_seconds: process.run_time(),
                },
            );
        }
        stats
    })
    .await
    .unwrap_or_default()
}

fn build_summary(seeds: Vec<RuntimeSeed>, stats: &HashMap<u32, ProcessStats>) -> DriverRuntimeSummary {
    let runtimes = seeds
        .into_iter()
        .map(|seed| {
            let stat = seed.pid.and_then(|pid| stats.get(&pid));
            DriverRuntimeInfo {
                id: seed.id,
                driver_key: seed.driver_key,
                label: seed.label,
                kind: seed.kind,
                source: seed.source,
                status: seed.status,
                pid: seed.pid,
                memory_bytes: stat.map(|value| value.memory_bytes),
                cpu_percent: stat.map(|value| value.cpu_percent),
                uptime_seconds: stat.map(|value| value.uptime_seconds),
                version: seed.version,
                last_error: seed.last_error,
                can_stop: seed.can_stop,
                can_restart: seed.can_restart,
                control_unavailable_reason: seed.control_unavailable_reason,
                protocol_mode: seed.protocol_mode,
                active_sessions: seed.active_sessions,
            }
        })
        .collect::<Vec<_>>();

    let running_count = runtimes.iter().filter(|runtime| runtime.status == "running").count();
    let total_memory_bytes = runtimes.iter().filter_map(|runtime| runtime.memory_bytes).sum();
    let last_error = runtimes.iter().rev().find_map(|runtime| runtime.last_error.clone());
    let health = if runtimes.iter().any(|runtime| runtime.status == "error") {
        "error"
    } else if last_error.is_some() {
        "warning"
    } else {
        "healthy"
    }
    .to_string();

    DriverRuntimeSummary { running_count, total_memory_bytes, last_error, health, runtimes }
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::{build_summary, runtime_agent_key, sort_runtime_seeds, ProcessStats, RuntimeSeed};
    use std::collections::HashMap;

    fn seed(id: &str, status: &str, pid: Option<u32>) -> RuntimeSeed {
        RuntimeSeed {
            id: id.to_string(),
            driver_key: id.to_string(),
            label: id.to_string(),
            kind: "agent".to_string(),
            source: "daemon".to_string(),
            status: status.to_string(),
            pid,
            version: None,
            last_error: None,
            can_stop: true,
            can_restart: true,
            control_unavailable_reason: None,
            protocol_mode: None,
            active_sessions: None,
        }
    }

    #[test]
    fn summary_counts_running_runtimes_and_memory() {
        let mut stats = HashMap::new();
        stats.insert(42, ProcessStats { memory_bytes: 1024, cpu_percent: 0.5, uptime_seconds: 7 });

        let summary = build_summary(vec![seed("oracle", "running", Some(42)), seed("h2", "stopped", None)], &stats);

        assert_eq!(summary.running_count, 1);
        assert_eq!(summary.total_memory_bytes, 1024);
        assert_eq!(summary.health, "healthy");
        assert_eq!(summary.runtimes[0].memory_bytes, Some(1024));
    }

    #[test]
    fn parses_legacy_and_shared_agent_runtime_ids() {
        assert_eq!(runtime_agent_key("agent:oracle"), Some("oracle"));
        assert_eq!(runtime_agent_key("agent-runtime:oracle:123"), Some("oracle"));
        assert_eq!(runtime_agent_key("plugin-connection:test"), None);
    }

    #[test]
    fn running_runtimes_sort_before_stopped_runtimes() {
        let mut runtimes = vec![seed("h2", "stopped", None), seed("oracle", "running", Some(42))];

        sort_runtime_seeds(&mut runtimes);

        assert_eq!(runtimes.iter().map(|runtime| runtime.id.as_str()).collect::<Vec<_>>(), vec!["oracle", "h2"]);
    }
}
