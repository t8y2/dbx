//! Recovery decisions derived from typed JDBC Agent failures.

use crate::db::agent_driver::{AgentCallError, AgentErrorCategory, AgentSessionDisposition};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryScope {
    UserOperation,
    ReadOnlyMetadata { retried: bool },
    Keepalive,
    ConnectionOpen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryDecision {
    KeepSession,
    RetryReadOnlyMetadata,
    QuarantineSession,
    ReplaceRuntime,
}

impl RecoveryDecision {
    pub fn discards_session(self) -> bool {
        !matches!(self, Self::KeepSession)
    }

    pub fn replaces_runtime(self) -> bool {
        matches!(self, Self::ReplaceRuntime)
    }
}

pub struct RecoveryPolicy;

impl RecoveryPolicy {
    pub fn decide(error: &AgentCallError, scope: RecoveryScope) -> RecoveryDecision {
        match error {
            AgentCallError::ContractViolation { .. } => RecoveryDecision::QuarantineSession,
            AgentCallError::Transport { .. } => RecoveryDecision::ReplaceRuntime,
            AgentCallError::Timeout { .. } | AgentCallError::Canceled { .. } => RecoveryDecision::QuarantineSession,
            AgentCallError::Structured { context, .. } => {
                if matches!(context.category, AgentErrorCategory::Timeout | AgentErrorCategory::Canceled) {
                    return RecoveryDecision::QuarantineSession;
                }
                Self::from_disposition(Some(context.session_disposition), Some(context.category), scope)
            }
            AgentCallError::Legacy { hints, .. } => {
                Self::from_disposition(hints.session_disposition, hints.category, scope)
            }
        }
    }

    fn from_disposition(
        disposition: Option<AgentSessionDisposition>,
        category: Option<AgentErrorCategory>,
        scope: RecoveryScope,
    ) -> RecoveryDecision {
        match disposition {
            Some(AgentSessionDisposition::ReplaceRuntime) => RecoveryDecision::ReplaceRuntime,
            Some(AgentSessionDisposition::Quarantine)
                if category == Some(AgentErrorCategory::Connection)
                    && matches!(scope, RecoveryScope::ReadOnlyMetadata { retried: false }) =>
            {
                RecoveryDecision::RetryReadOnlyMetadata
            }
            Some(AgentSessionDisposition::Quarantine) => RecoveryDecision::QuarantineSession,
            Some(AgentSessionDisposition::Keep) | None => RecoveryDecision::KeepSession,
        }
    }
}
