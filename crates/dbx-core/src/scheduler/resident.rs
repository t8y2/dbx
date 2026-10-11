//! Resident (long-running) session model (ADR §2.7): one active session per
//! task definition, persisted in `task_runtime_sessions`, supervised with a
//! bounded restart policy so a crash loop can never spin forever.

use serde::{Deserialize, Serialize};

use super::models::TaskRestartPolicy;

/// Session lifecycle states; stored as lowercase strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResidentState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Crashed,
    Degraded,
}

impl ResidentState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Crashed => "crashed",
            Self::Degraded => "degraded",
        }
    }

    pub fn is_active(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Stopping)
    }
}

/// Probe result of `ResidentExecutor::status` (mirrors the `task/status` RPC).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidentStatus {
    pub state: ResidentState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_at: Option<String>,
    #[serde(default)]
    pub restart_count: u32,
}

/// A persisted resident session row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidentSession {
    pub id: String,
    pub task_id: String,
    pub run_id: String,
    pub plugin_id: String,
    pub session_id: String,
    pub state: ResidentState,
    #[serde(default)]
    pub heartbeat_at: Option<String>,
    #[serde(default)]
    pub restart_count: u32,
    pub created_at: String,
    pub updated_at: String,
}

impl ResidentSession {
    /// Whether the restart policy still allows another restart. The count
    /// window resets once `restart_window_seconds` has elapsed since the
    /// session row was created.
    pub fn can_restart(&self, policy: &TaskRestartPolicy, now: chrono::DateTime<chrono::Utc>) -> bool {
        if !policy.enabled {
            return false;
        }
        let count = match policy.restart_window_seconds {
            Some(window) => match chrono::DateTime::parse_from_rfc3339(&self.created_at) {
                Ok(created) if (now - created.with_timezone(&chrono::Utc)).num_seconds() < window as i64 => {
                    self.restart_count
                }
                _ => 0,
            },
            None => self.restart_count,
        };
        count < policy.max_restarts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(created_at: &str, restart_count: u32) -> ResidentSession {
        ResidentSession {
            id: "s".into(),
            task_id: "t".into(),
            run_id: "r".into(),
            plugin_id: "p".into(),
            session_id: "x".into(),
            state: ResidentState::Crashed,
            heartbeat_at: None,
            restart_count,
            created_at: created_at.into(),
            updated_at: created_at.into(),
        }
    }

    #[test]
    fn restart_policy_is_bounded_and_windowed() {
        let now = chrono::Utc::now();
        let policy =
            TaskRestartPolicy { enabled: true, max_restarts: 3, backoff_seconds: 0, restart_window_seconds: Some(60) };
        let fresh = session(&now.to_rfc3339(), 3);
        assert!(!fresh.can_restart(&policy, now)); // 3 restarts inside the window → degraded
        let stale = session(&(now - chrono::Duration::seconds(120)).to_rfc3339(), 3);
        assert!(stale.can_restart(&policy, now)); // window elapsed → counter resets
        let disabled =
            TaskRestartPolicy { enabled: false, max_restarts: 3, backoff_seconds: 0, restart_window_seconds: None };
        assert!(!session(&now.to_rfc3339(), 0).can_restart(&disabled, now));
    }
}
