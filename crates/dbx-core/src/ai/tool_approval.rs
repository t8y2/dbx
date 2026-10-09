//! Interactive approvals for agent tool calls.
//!
//! A tool call that may change state outside DBX (today: plugin MCP tools not
//! declared read-only) must not run on the model's word alone. The agent loop
//! registers a pending approval, emits `AgentEvent::ToolApprovalRequired`, and
//! suspends until the client answers through [`resolve_tool_approval`], the
//! deadline passes, or the run is cancelled.
//!
//! The registry is process-wide and deliberately runtime-agnostic (a std mutex
//! plus `oneshot` channels): the web server runs each agent loop on its own
//! runtime while the approval arrives through an HTTP handler on another one.
//! An approval is bound to the AI session that requested it, so a client can
//! only answer questions its own run asked.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::{oneshot, Notify};

/// How long a pending approval waits for the user before it counts as denied.
pub const TOOL_APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);

struct PendingApproval {
    session_id: String,
    responder: oneshot::Sender<bool>,
}

fn pending_approvals() -> &'static Mutex<HashMap<String, PendingApproval>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingApproval>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How a wait for approval ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolApprovalWait {
    Approved,
    Denied,
    TimedOut,
    Cancelled,
}

/// A registered approval. Dropping it removes the entry, so an abandoned wait
/// (cancelled future, early return) can never leave a stale approval behind
/// for a later answer to hit.
pub struct PendingToolApproval {
    approval_id: String,
    receiver: Option<oneshot::Receiver<bool>>,
}

impl PendingToolApproval {
    pub fn id(&self) -> &str {
        &self.approval_id
    }

    /// Waits for the user's answer. A dropped responder (the entry was purged)
    /// counts as a denial: without an answer there is no approval.
    pub async fn wait(mut self, timeout: Duration, cancelled: &Notify) -> ToolApprovalWait {
        let Some(receiver) = self.receiver.take() else {
            return ToolApprovalWait::Denied;
        };
        tokio::select! {
            biased;
            _ = cancelled.notified() => ToolApprovalWait::Cancelled,
            answer = tokio::time::timeout(timeout, receiver) => match answer {
                Ok(Ok(true)) => ToolApprovalWait::Approved,
                Ok(Ok(false)) | Ok(Err(_)) => ToolApprovalWait::Denied,
                Err(_) => ToolApprovalWait::TimedOut,
            },
        }
    }
}

impl Drop for PendingToolApproval {
    fn drop(&mut self) {
        pending_approvals().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&self.approval_id);
    }
}

/// Registers a pending approval for `session_id`.
pub fn register_tool_approval(session_id: &str) -> PendingToolApproval {
    let approval_id = uuid::Uuid::new_v4().to_string();
    let (responder, receiver) = oneshot::channel();
    pending_approvals()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(approval_id.clone(), PendingApproval { session_id: session_id.to_string(), responder });
    PendingToolApproval { approval_id, receiver: Some(receiver) }
}

/// Answers a pending approval. Returns `false` when no approval with this id is
/// pending for `session_id` (already answered, timed out, or never asked).
pub fn resolve_tool_approval(session_id: &str, approval_id: &str, approved: bool) -> bool {
    let mut pending = pending_approvals().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let belongs_to_session = pending.get(approval_id).is_some_and(|entry| entry.session_id == session_id);
    if !belongs_to_session {
        return false;
    }
    let Some(entry) = pending.remove(approval_id) else {
        return false;
    };
    entry.responder.send(approved).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolved_approval_reports_the_user_answer() {
        let cancelled = Notify::new();
        let approval = register_tool_approval("session-a");
        let id = approval.id().to_string();
        assert!(resolve_tool_approval("session-a", &id, true));
        assert_eq!(approval.wait(Duration::from_secs(5), &cancelled).await, ToolApprovalWait::Approved);

        let denied = register_tool_approval("session-a");
        let id = denied.id().to_string();
        assert!(resolve_tool_approval("session-a", &id, false));
        assert_eq!(denied.wait(Duration::from_secs(5), &cancelled).await, ToolApprovalWait::Denied);
    }

    #[tokio::test]
    async fn another_session_cannot_answer_an_approval() {
        let cancelled = Notify::new();
        let approval = register_tool_approval("owner");
        let id = approval.id().to_string();
        assert!(!resolve_tool_approval("intruder", &id, true));
        assert!(resolve_tool_approval("owner", &id, false));
        assert_eq!(approval.wait(Duration::from_secs(5), &cancelled).await, ToolApprovalWait::Denied);
    }

    #[tokio::test]
    async fn unanswered_approval_times_out_and_is_forgotten() {
        let cancelled = Notify::new();
        let approval = register_tool_approval("session-b");
        let id = approval.id().to_string();
        assert_eq!(approval.wait(Duration::from_millis(20), &cancelled).await, ToolApprovalWait::TimedOut);
        assert!(!resolve_tool_approval("session-b", &id, true), "a timed-out approval must not accept a late answer");
    }

    #[tokio::test]
    async fn cancellation_ends_the_wait() {
        let cancelled = Notify::new();
        cancelled.notify_one();
        let approval = register_tool_approval("session-c");
        assert_eq!(approval.wait(Duration::from_secs(5), &cancelled).await, ToolApprovalWait::Cancelled);
    }

    #[tokio::test]
    async fn cancellation_wins_over_an_answer_that_arrived_at_the_same_time() {
        let cancelled = Notify::new();
        let approval = register_tool_approval("session-race");
        assert!(resolve_tool_approval("session-race", approval.id(), true));
        cancelled.notify_one();
        assert_eq!(approval.wait(Duration::from_secs(5), &cancelled).await, ToolApprovalWait::Cancelled);
    }
}
