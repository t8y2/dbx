use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::agent_driver::{AgentCallError, AgentRuntimeClient};
use crate::agent_manager::AgentManager;

/// A fixed protocol-v2 session in a Core-scoped debugger process. It does not
/// participate in ordinary pool replacement, retries or query cancellation.
#[derive(Clone)]
pub struct PlDebugAgentChannel {
    inner: Arc<PlDebugChannelOwner>,
}

struct PlDebugChannelOwner {
    runtime: Arc<AgentRuntimeClient>,
    agent_session_id: String,
    scope: Uuid,
    runtime_key: String,
    reservation_released: AtomicBool,
}

impl PlDebugChannelOwner {
    fn release_reservation(&self) {
        if !self.reservation_released.swap(true, Ordering::AcqRel) {
            AgentRuntimeClient::decrement_session_count(&self.runtime);
        }
    }
}

impl Drop for PlDebugChannelOwner {
    fn drop(&mut self) {
        self.release_reservation();
    }
}

impl PlDebugAgentChannel {
    /// The caller must already hold the reservation in the launch-scope map.
    pub(crate) fn from_reserved(
        runtime: Arc<AgentRuntimeClient>,
        agent_session_id: String,
        scope: Uuid,
        runtime_key: String,
    ) -> Self {
        Self {
            inner: Arc::new(PlDebugChannelOwner {
                runtime,
                agent_session_id,
                scope,
                runtime_key,
                reservation_released: AtomicBool::new(false),
            }),
        }
    }

    pub fn scope(&self) -> Uuid {
        self.inner.scope
    }

    pub fn is_available(&self) -> bool {
        !self.inner.runtime.is_failed()
    }

    pub fn supports_native_pl_debug(&self) -> bool {
        self.inner
            .runtime
            .handshake()
            .pl_debug
            .as_ref()
            .is_some_and(|contract| contract.contract_version == 1 && !contract.helper_objects)
    }

    pub fn supports_set_value_operation_status(&self) -> bool {
        self.supports_native_pl_debug()
            && self
                .inner
                .runtime
                .handshake()
                .pl_debug
                .as_ref()
                .is_some_and(|contract| contract.set_value_operation_status)
    }

    pub fn supports_execute_operation_status(&self) -> bool {
        self.supports_native_pl_debug()
            && self
                .inner
                .runtime
                .handshake()
                .pl_debug
                .as_ref()
                .is_some_and(|contract| contract.execute_operation_status)
    }

    pub fn supports_retained_pl_debug_results(&self) -> bool {
        self.supports_native_pl_debug()
            && self
                .inner
                .runtime
                .handshake()
                .capabilities
                .iter()
                .any(|capability| capability == "pl_debug_retained_results_v1")
    }

    pub fn supports_breakpoint_operation_status(&self) -> bool {
        self.supports_native_pl_debug()
            && self
                .inner
                .runtime
                .handshake()
                .pl_debug
                .as_ref()
                .is_some_and(|contract| contract.breakpoint_operation_status)
    }

    /// Core stores this channel before calling open_session, including when
    /// opening times out and the original physical allocation is still pending.
    pub async fn open_session(&self, params: Value, timeout: Duration) -> Result<Value, AgentCallError> {
        self.session_request("open_session", params, timeout, None).await
    }

    pub async fn close_session(&self, timeout: Duration) -> Result<Value, AgentCallError> {
        self.session_request("close_session", serde_json::json!({}), timeout, None).await
    }

    pub async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel_wait: Option<CancellationToken>,
    ) -> Result<T, AgentCallError> {
        if !method.starts_with("pl_debug_") {
            return Err(AgentCallError::Transport { message: "This channel only accepts PL/SQL debug methods".into() });
        }
        self.session_request(method, params, timeout, cancel_wait).await
    }

    async fn session_request<T: DeserializeOwned>(
        &self,
        method: &str,
        mut params: Value,
        timeout: Duration,
        cancel_wait: Option<CancellationToken>,
    ) -> Result<T, AgentCallError> {
        params
            .as_object_mut()
            .ok_or_else(|| AgentCallError::Transport { message: "Agent RPC parameters must be an object".into() })?
            .insert("agentSessionId".into(), Value::String(self.inner.agent_session_id.clone()));
        self.inner.runtime.call_pl_debug_typed(method, params, timeout, cancel_wait).await
    }

    /// The reply accepts shutdown; only wait_for_exit proves process exit.
    pub async fn request_shutdown(&self, timeout: Duration) -> Result<Value, AgentCallError> {
        self.inner.runtime.call_pl_debug_typed("shutdown", serde_json::json!({}), timeout, None).await
    }

    pub async fn wait_for_exit(&self, timeout: Duration) -> bool {
        self.inner.runtime.wait_for_exit(timeout).await
    }

    /// Core keeps the result record but removes the ended, uniquely scoped
    /// runtime from launch routing. A shutdown ACK alone cannot retire it.
    pub async fn retire_after_exit(&self, manager: &AgentManager) -> bool {
        if !self.wait_for_exit(Duration::ZERO).await {
            return false;
        }
        let mut runtimes = manager.connection_runtimes.lock().await;
        if runtimes
            .get(&self.inner.runtime_key)
            .and_then(|cell| cell.get())
            .is_some_and(|runtime| Arc::ptr_eq(runtime, &self.inner.runtime))
        {
            runtimes.remove(&self.inner.runtime_key);
        }
        self.inner.release_reservation();
        true
    }

    /// Reachable independently of stdin and all logical-session RPC locks.
    /// Process exit cannot confirm database termination or transaction rollback.
    pub fn fail_stop(&self) {
        self.inner.runtime.kill();
    }
}
