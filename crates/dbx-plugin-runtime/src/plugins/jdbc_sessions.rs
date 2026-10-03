use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::sync::Mutex;

use super::{PluginDriverSession, PluginRegistry, PluginRuntimeEnv};

#[derive(Clone, Default)]
pub(super) struct JdbcRuntimeCache(Arc<Mutex<HashMap<String, Weak<JdbcRuntime>>>>);

impl std::fmt::Debug for JdbcRuntimeCache {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("JdbcRuntimeCache")
    }
}

struct JdbcRuntime {
    process: Arc<PluginDriverSession>,
    members: Mutex<(usize, bool)>,
}

pub(super) struct JdbcLogicalSession {
    runtime: Arc<JdbcRuntime>,
    id: String,
    closed: AtomicBool,
    operation: Mutex<()>,
    close_done: tokio::sync::watch::Sender<bool>,
}

impl PluginRegistry {
    pub async fn start_shared_jdbc_session_for_connection(
        &self,
        runtime_key: &str,
        env: PluginRuntimeEnv,
        connection_label: &str,
    ) -> Result<Arc<PluginDriverSession>, String> {
        let key = serde_json::to_string(&(runtime_key, &env.vars)).map_err(|error| error.to_string())?;
        let mut cache = self.jdbc_runtimes.0.lock().await;
        cache.retain(|_, runtime| runtime.strong_count() > 0);
        let mut runtime = cache.get(&key).and_then(Weak::upgrade);
        if let Some(existing) = &runtime {
            let mut members = existing.members.lock().await;
            if !members.1 && existing.process.sidecar.status().state == super::PluginSessionState::Running {
                members.0 += 1;
            } else {
                existing.process.sidecar.shutdown().await;
                members.1 = true;
                drop(members);
                runtime = None;
            }
        }
        let runtime = match runtime {
            Some(runtime) => runtime,
            None => {
                let process = self.start_driver_session_for_connection("jdbc", env, connection_label).await?;
                let mut startup = StartupGuard(Some(process.clone()));
                let protocol = process.invoke::<serde_json::Value>("jdbcSessionProtocol", serde_json::json!({})).await;
                if !matches!(protocol, Ok(ref value) if value["version"] == 2) {
                    process.shutdown().await;
                    startup.0 = None;
                    return Err("Update the JDBC plugin to a version supporting embedded H2 logical sessions".into());
                }
                startup.0 = None;
                let runtime = Arc::new(JdbcRuntime { process, members: Mutex::new((1, false)) });
                cache.insert(key, Arc::downgrade(&runtime));
                runtime
            }
        };
        let logical = Arc::new(JdbcLogicalSession {
            runtime: runtime.clone(),
            id: uuid::Uuid::new_v4().to_string(),
            closed: AtomicBool::new(false),
            operation: Mutex::new(()),
            close_done: tokio::sync::watch::channel(false).0,
        });
        let opened: Result<serde_json::Value, _> =
            logical.invoke("openJdbcSession", serde_json::json!({}), Some(Duration::from_secs(3))).await;
        if let Err(error) = opened {
            logical.close().await;
            return Err(error);
        }
        Ok(Arc::new(PluginDriverSession {
            sidecar: runtime.process.sidecar.clone(),
            driver_id: "jdbc".into(),
            _activity: None,
            logical: Some(logical),
        }))
    }
}

impl JdbcLogicalSession {
    pub(super) fn is_available(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
            && self.runtime.process.sidecar.status().state == super::PluginSessionState::Running
    }

    pub(super) async fn invoke<T: serde::de::DeserializeOwned>(
        self: &Arc<Self>,
        method: &str,
        mut params: serde_json::Value,
        timeout: Option<Duration>,
    ) -> Result<T, String> {
        let _operation = self.operation.lock().await;
        if !self.is_available() {
            return Err("JDBC logical session is closed; reconnect this session".into());
        }
        params
            .as_object_mut()
            .ok_or("JDBC session parameters must be an object")?
            .insert("jdbcSessionId".into(), self.id.clone().into());
        let mut guard = CancelOnDrop(Some(self.clone()));
        let request = self.runtime.process.sidecar.invoke_with_timeout(method, params, Some("jdbc"), None);
        let result = match timeout {
            Some(duration) => tokio::time::timeout(duration, request)
                .await
                .map_err(|_| "JDBC logical session request timed out".to_string())?,
            None => request.await,
        };
        guard.0 = None;
        result
    }

    pub(super) async fn close(self: &Arc<Self>) {
        self.close_in_background();
        let _ = self.close_done.subscribe().wait_for(|done| *done).await;
    }

    pub(super) fn close_in_background(self: &Arc<Self>) {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            if self.closed.swap(true, Ordering::AcqRel) {
                return;
            }
            let session = self.clone();
            handle.spawn(async move {
                let runtime = &session.runtime;
                let _: Result<serde_json::Value, _> = runtime
                    .process
                    .sidecar
                    .invoke_with_timeout(
                        "closeJdbcSession",
                        serde_json::json!({"jdbcSessionId": session.id}),
                        Some("jdbc"),
                        Some(Duration::from_secs(3)),
                    )
                    .await;
                let mut members = runtime.members.lock().await;
                members.0 -= 1;
                if members.0 == 0 {
                    members.1 = true;
                    runtime.process.sidecar.shutdown().await;
                }
                session.close_done.send_replace(true);
            });
        }
    }
}

struct CancelOnDrop(Option<Arc<JdbcLogicalSession>>);

struct StartupGuard(Option<Arc<PluginDriverSession>>);

impl Drop for StartupGuard {
    fn drop(&mut self) {
        if let Some(process) = self.0.take() {
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    process.sidecar.shutdown().await;
                });
            }
        }
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(session) = &self.0 {
            session.close_in_background();
        }
    }
}
