use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::state_persistence::StateMachine;

// ============================================================================
// 15.1 & 15.2: External OSC Tool Status
// ============================================================================

/// Status of an external online schema change tool execution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OscExecutionStatus {
    Preparing,
    Copying { progress_pct: f64, rows_copied: u64, rows_total: u64 },
    CutOver,
    Postponed,
    Completed,
    Failed(String),
}

/// Type of OSC tool
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OscToolKind {
    GhOst,
    PtOsc,
}

impl OscToolKind {
    pub fn name(&self) -> &'static str {
        match self {
            Self::GhOst => "gh-ost",
            Self::PtOsc => "pt-osc",
        }
    }
}

// ============================================================================
// 15.1: gh-ost Probe
// ============================================================================

pub struct GhOstProbe {
    progress_history: Vec<(String, f64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhOstProgress {
    pub status: OscExecutionStatus,
    pub ghost_table_exists: bool,
    pub changelog_table_exists: bool,
    pub rows_copied: u64,
    pub rows_total: u64,
    pub progress_pct: f64,
}

impl GhOstProbe {
    pub fn new() -> Self {
        Self { progress_history: Vec::new() }
    }

    pub fn probe(&mut self, _database: &str, _table: &str, _has_connection: bool) -> GhOstProgress {
        let ghost_table = format!("{_table}_gho");
        let changelog_table = format!("{_table}_ghc");
        if !_has_connection {
            return GhOstProgress {
                status: OscExecutionStatus::Copying { progress_pct: 0.0, rows_copied: 0, rows_total: 0 },
                ghost_table_exists: false,
                changelog_table_exists: false,
                rows_copied: 0,
                rows_total: 0,
                progress_pct: 0.0,
            };
        }
        GhOstProgress {
            status: OscExecutionStatus::Copying { progress_pct: 0.0, rows_copied: 0, rows_total: 0 },
            ghost_table_exists: false,
            changelog_table_exists: false,
            rows_copied: 0,
            rows_total: 0,
            progress_pct: 0.0,
        }
    }

    /// Parse gh-ost log line: "Copying rows: 12345/67890 (18.2%)"
    pub fn parse_log_line(line: &str) -> Option<GhOstProgress> {
        let upper = line.to_uppercase();
        if !upper.contains("COPYING ROWS") {
            return None;
        }
        let re = regex::Regex::new(r"(\d+)\s*/\s*(\d+)\s*\((\d+\.?\d*)%\)").ok()?;
        if let Some(caps) = re.captures(line) {
            let rows_copied: u64 = caps.get(1)?.as_str().parse().ok()?;
            let rows_total: u64 = caps.get(2)?.as_str().parse().ok()?;
            let progress_pct: f64 = caps.get(3)?.as_str().parse().ok()?;
            let status = if progress_pct >= 99.0 {
                OscExecutionStatus::CutOver
            } else {
                OscExecutionStatus::Copying { progress_pct, rows_copied, rows_total }
            };
            return Some(GhOstProgress {
                status,
                ghost_table_exists: true,
                changelog_table_exists: true,
                rows_copied,
                rows_total,
                progress_pct,
            });
        }
        None
    }

    pub fn record_sample(&mut self, progress_pct: f64, label: &str) {
        self.progress_history.push((label.to_string(), progress_pct));
        if self.progress_history.len() > 1000 {
            self.progress_history.remove(0);
        }
    }

    pub fn estimated_remaining_seconds(&self, current_pct: f64) -> Option<f64> {
        if self.progress_history.len() < 2 || current_pct <= 0.0 {
            return None;
        }
        let first = self.progress_history.first()?;
        let total_pct = current_pct - first.1;
        if total_pct <= 0.0 {
            return None;
        }
        let rate = total_pct / 1.0;
        if rate <= 0.0 {
            return None;
        }
        Some((100.0 - current_pct) / rate)
    }
}

impl Default for GhOstProbe {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 15.2: pt-osc Probe
// ============================================================================

pub struct PtOscProbe;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtOscProgress {
    pub status: OscExecutionStatus,
    pub new_table_exists: bool,
    pub old_table_exists: bool,
    pub triggers_active: u32,
    pub rows_copied: u64,
    pub rows_total: u64,
    pub progress_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtOscNames {
    pub new_table: String,
    pub old_table: String,
    pub del_trigger: String,
    pub ins_trigger: String,
    pub upd_trigger: String,
}

impl PtOscProbe {
    pub fn new() -> Self {
        Self
    }

    pub fn object_names(table: &str) -> PtOscNames {
        PtOscNames {
            new_table: format!("_{table}_new"),
            old_table: format!("_{table}_old"),
            del_trigger: format!("pt_osc_{table}_del"),
            ins_trigger: format!("pt_osc_{table}_ins"),
            upd_trigger: format!("pt_osc_{table}_upd"),
        }
    }

    pub fn parse_progress_line(line: &str) -> Option<f64> {
        let re = regex::Regex::new(r"(\d+)%\s").ok()?;
        if let Some(caps) = re.captures(line) {
            return caps.get(1)?.as_str().parse().ok();
        }
        None
    }
}

impl Default for PtOscProbe {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 15.3: OscStateBridge — map external status to StateMachine
// ============================================================================

pub struct OscStateBridge {
    state_machine: Arc<StateMachine>,
}

impl OscStateBridge {
    pub fn new(state_machine: Arc<StateMachine>) -> Self {
        Self { state_machine }
    }

    pub async fn bridge(&self, state_key: &str, external_status: &OscExecutionStatus) -> Result<String, String> {
        match external_status {
            OscExecutionStatus::Preparing | OscExecutionStatus::Copying { .. } | OscExecutionStatus::Postponed => {
                Ok("osc_syncing")
            }
            OscExecutionStatus::CutOver | OscExecutionStatus::Completed => {
                let new_state = crate::state_persistence::StateTransition::Completed;
                self.state_machine.transition(state_key, new_state).await?;
                Ok("completed")
            }
            OscExecutionStatus::Failed(_) => {
                let new_state = crate::state_persistence::StateTransition::Failed;
                self.state_machine.transition(state_key, new_state).await?;
                Err(format!("OSC failed: {external_status:?}"))
            }
        }
        .map(|s| s.to_string())
    }
}

// ============================================================================
// 15.6: dbdiff_lock — database-level distributed lock
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbDiffLock {
    pub lock_id: String,
    pub instance_id: String,
    pub acquired_at: String,
    pub expires_at: String,
}

impl DbDiffLock {
    pub fn create_table_sql() -> &'static str {
        "CREATE TABLE IF NOT EXISTS dbdiff_lock (
            lock_id TEXT PRIMARY KEY,
            instance_id TEXT NOT NULL,
            acquired_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP NOT NULL
        )"
    }

    pub fn acquire_sql(lock_id: &str, instance_id: &str, ttl_seconds: u64) -> String {
        format!(
            "INSERT INTO dbdiff_lock (lock_id, instance_id, expires_at) \
             VALUES ('{lock_id}', '{instance_id}', DATEADD('SECOND', {ttl_seconds}, CURRENT_TIMESTAMP))"
        )
    }

    pub fn check_sql(lock_id: &str) -> String {
        format!(
            "SELECT instance_id, acquired_at, expires_at FROM dbdiff_lock \
             WHERE lock_id = '{lock_id}' AND expires_at > CURRENT_TIMESTAMP"
        )
    }

    pub fn release_sql(lock_id: &str, instance_id: &str) -> String {
        format!("DELETE FROM dbdiff_lock WHERE lock_id = '{lock_id}' AND instance_id = '{instance_id}'")
    }

    pub fn cleanup_expired_sql() -> &'static str {
        "DELETE FROM dbdiff_lock WHERE expires_at <= CURRENT_TIMESTAMP"
    }

    pub fn extend_sql(lock_id: &str, instance_id: &str, ttl_seconds: u64) -> String {
        format!(
            "UPDATE dbdiff_lock SET expires_at = DATEADD('SECOND', {ttl_seconds}, CURRENT_TIMESTAMP) \
             WHERE lock_id = '{lock_id}' AND instance_id = '{instance_id}'"
        )
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // --- gh-ost log parsing ---

    #[test]
    fn gh_ost_parse_log_copying() {
        let line = "Copying rows: 12345/67890 (18.2%)";
        let result = GhOstProbe::parse_log_line(line).unwrap();
        assert_eq!(result.rows_copied, 12345);
        assert_eq!(result.rows_total, 67890);
        assert!((result.progress_pct - 18.2).abs() < 0.01);
        match result.status {
            OscExecutionStatus::Copying { .. } => {}
            _ => panic!("should be Copying"),
        }
    }

    #[test]
    fn gh_ost_parse_log_cutover() {
        let line = "Copying rows: 67889/67890 (100.0%)";
        let result = GhOstProbe::parse_log_line(line).unwrap();
        match result.status {
            OscExecutionStatus::CutOver => {}
            _ => panic!("should be CutOver at 100%"),
        }
    }

    #[test]
    fn gh_ost_parse_non_copying_line() {
        let line = "2024/01/01 12:00:00 Starting gh-ost...";
        assert!(GhOstProbe::parse_log_line(line).is_none());
    }

    // --- pt-osc ---

    #[test]
    fn pt_osc_get_object_names() {
        let names = PtOscProbe::object_names("users");
        assert_eq!(names.new_table, "_users_new");
        assert_eq!(names.del_trigger, "pt_osc_users_del");
    }

    #[test]
    fn pt_osc_parse_progress() {
        let line = "Copying `mydb`.`users`:  45% 00:30 remaining";
        let pct = PtOscProbe::parse_progress_line(line).unwrap();
        assert!((pct - 45.0).abs() < 0.01);
    }

    // --- OSC status serialization ---

    #[test]
    fn osc_status_serialization() {
        let status = OscExecutionStatus::Copying { progress_pct: 45.5, rows_copied: 100, rows_total: 200 };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("45.5"));
        let deserialized: OscExecutionStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(status, deserialized);
    }

    // --- dbdiff_lock ---

    #[test]
    fn dbdiff_lock_acquire_sql() {
        let sql = DbDiffLock::acquire_sql("mig-001", "node-1", 300);
        assert!(sql.contains("INSERT INTO dbdiff_lock"));
        assert!(sql.contains("mig-001"));
    }

    #[test]
    fn dbdiff_lock_release_sql() {
        let sql = DbDiffLock::release_sql("mig-001", "node-1");
        assert!(sql.contains("DELETE FROM dbdiff_lock"));
    }

    #[test]
    fn dbdiff_lock_check_sql() {
        let sql = DbDiffLock::check_sql("mig-001");
        assert!(sql.contains("expires_at > CURRENT_TIMESTAMP"));
    }

    #[test]
    fn dbdiff_lock_create_table_sql() {
        let sql = DbDiffLock::create_table_sql();
        assert!(sql.contains("CREATE TABLE IF NOT EXISTS dbdiff_lock"));
    }

    // --- State machine extended transition tests ---

    #[test]
    fn state_machine_new_transitions_valid() {
        use crate::state_persistence::{is_valid_transition, StateTransition};
        assert!(is_valid_transition(&StateTransition::Running, &StateTransition::OscSyncing));
        assert!(is_valid_transition(&StateTransition::OscSyncing, &StateTransition::Completed));
        assert!(is_valid_transition(&StateTransition::OscSyncing, &StateTransition::Failed));
        assert!(is_valid_transition(&StateTransition::Failed, &StateTransition::RollingBack));
        assert!(is_valid_transition(&StateTransition::RollingBack, &StateTransition::FullyRolledBack));
        assert!(is_valid_transition(&StateTransition::RollingBack, &StateTransition::PartiallyRolledBack));
        assert!(is_valid_transition(&StateTransition::PartiallyRolledBack, &StateTransition::RecoveryRequired));
    }

    #[test]
    fn state_machine_new_transitions_invalid() {
        use crate::state_persistence::{is_valid_transition, StateTransition};
        assert!(!is_valid_transition(&StateTransition::Created, &StateTransition::OscSyncing));
        assert!(!is_valid_transition(&StateTransition::OscSyncing, &StateTransition::Running));
        assert!(!is_valid_transition(&StateTransition::FullyRolledBack, &StateTransition::Running));
    }

    #[test]
    fn state_machine_full_lifecycle_with_osc() {
        use crate::state_persistence::{is_valid_transition, StateTransition};
        let lifecycle = ["created", "running", "osc_syncing", "completed"];
        // Validate each step
        let states = [
            StateTransition::Created,
            StateTransition::Running,
            StateTransition::OscSyncing,
            StateTransition::Completed,
        ];
        for i in 0..states.len() - 1 {
            assert!(is_valid_transition(&states[i], &states[i + 1]));
        }
    }

    #[test]
    fn state_machine_rollback_scenarios() {
        use crate::state_persistence::{is_valid_transition, StateTransition};
        // Failed → RollingBack → FullyRolledBack
        assert!(is_valid_transition(&StateTransition::Failed, &StateTransition::RollingBack));
        assert!(is_valid_transition(&StateTransition::RollingBack, &StateTransition::FullyRolledBack));
        // Failed → RollingBack → PartiallyRolledBack → RecoveryRequired
        assert!(is_valid_transition(&StateTransition::RollingBack, &StateTransition::PartiallyRolledBack));
        assert!(is_valid_transition(&StateTransition::PartiallyRolledBack, &StateTransition::RecoveryRequired));
        // Failed → RecoveryRequired (direct)
        assert!(is_valid_transition(&StateTransition::Failed, &StateTransition::RecoveryRequired));
    }
}
