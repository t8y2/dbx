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
    close_done: tokio::sync::watch::Sender<Option<Result<(), String>>>,
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
                if let Err(error) = existing.process.sidecar.shutdown().await {
                    log::warn!("Failed to stop the stale shared JDBC plugin runtime: {error}");
                }
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
                    let shutdown = process.shutdown().await;
                    startup.0 = None;
                    return Err(match shutdown {
                        Ok(()) => {
                            "Update the JDBC plugin to a version supporting embedded H2 logical sessions".to_string()
                        }
                        Err(error) => format!(
                            "Update the JDBC plugin to a version supporting embedded H2 logical sessions; additionally \
                             failed to stop its runtime: {error}"
                        ),
                    });
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
            close_done: tokio::sync::watch::channel(None).0,
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
        let _ = self.close_confirmed().await;
    }

    pub(super) async fn close_confirmed(self: &Arc<Self>) -> Result<(), String> {
        self.close_in_background();
        let mut done = self.close_done.subscribe();
        let result = done
            .wait_for(|done| done.is_some())
            .await
            .map_err(|_| "JDBC session cleanup outcome is unavailable".to_string())?;
        result.as_ref().expect("completed close").clone()
    }

    pub(super) fn close_in_background(self: &Arc<Self>) {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            if self.closed.swap(true, Ordering::AcqRel) {
                return;
            }
            let session = self.clone();
            handle.spawn(async move {
                let runtime = &session.runtime;
                let mut closed = runtime
                    .process
                    .sidecar
                    .invoke_with_timeout(
                        "closeJdbcSession",
                        serde_json::json!({"jdbcSessionId": session.id}),
                        Some("jdbc"),
                        Some(Duration::from_secs(3)),
                    )
                    .await
                    .and_then(|value: serde_json::Value| {
                        if value["ok"] == true {
                            Ok(())
                        } else {
                            Err("JDBC logical session cleanup was not confirmed".to_string())
                        }
                    });
                let mut members = runtime.members.lock().await;
                members.0 -= 1;
                if members.0 == 0 {
                    members.1 = true;
                    if let Err(error) = runtime.process.sidecar.shutdown().await {
                        log::warn!("Failed to stop the shared JDBC plugin runtime: {error}");
                        if closed.is_ok() {
                            closed = Err(error);
                        }
                    }
                }
                session.close_done.send_replace(Some(closed));
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
                    if let Err(error) = process.sidecar.shutdown().await {
                        log::warn!("Failed to stop the discarded JDBC plugin runtime: {error}");
                    }
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

#[cfg(all(test, any(windows, unix)))]
mod tests {
    use super::super::lifecycle_tests::{install, registry, ID};
    use super::*;

    #[tokio::test]
    async fn unknown_native_close_is_reported_without_closing_a_sibling() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        let log = temp.path().join("closed.txt");
        install(&root, "0.3.4");
        let registry = registry(&root);
        let process = PluginDriverSession::start(
            registry.find_plugin(ID).unwrap().unwrap(),
            "jdbc".into(),
            "0.6.14".into(),
            PluginRuntimeEnv::default().with_var("DBX_JDBC_CLOSE_LOG", log.to_string_lossy().into_owned()),
            registry.lifecycle().begin_connection(ID, "Native job close fixture").unwrap(),
        )
        .await
        .unwrap();
        let runtime = Arc::new(JdbcRuntime { process: Arc::new(process), members: Mutex::new((2, false)) });
        let driver = |id: &str| PluginDriverSession {
            sidecar: runtime.process.sidecar.clone(),
            driver_id: "jdbc".into(),
            _activity: None,
            logical: Some(Arc::new(JdbcLogicalSession {
                runtime: runtime.clone(),
                id: id.into(),
                closed: AtomicBool::new(false),
                operation: Mutex::new(()),
                close_done: tokio::sync::watch::channel(None).0,
            })),
        };
        let failed = driver("failed");
        let sibling = driver("survivor");
        let close = failed.shutdown_confirmed().await;
        assert_eq!(failed.shutdown_confirmed().await, close, "closed failure must be retained without reissuing close");
        assert!(failed.shutdown().await.is_ok(), "ordinary callers keep the existing best-effort shutdown contract");
        let live: Result<String, _> = sibling.invoke("version", serde_json::json!({})).await;
        assert_eq!(live.unwrap(), "0.3.4");
        sibling.shutdown_confirmed().await.unwrap();
        assert_eq!(std::fs::read_to_string(log).unwrap().lines().filter(|id| *id == "failed").count(), 1);
        assert!(close.is_err(), "an RPC-confirmed native cleanup failure must not become successful shutdown");
    }

    #[tokio::test]
    async fn dedicated_jdbc_close_requires_native_acknowledgment_and_always_stops_its_process() {
        for (mode, confirmed) in [("acknowledged", true), ("unconfirmed", false)] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("plugins");
            install(&root, "0.3.4");
            let registry = registry(&root);
            let process = PluginDriverSession::start(
                registry.find_plugin(ID).unwrap().unwrap(),
                "jdbc".into(),
                "0.6.14".into(),
                PluginRuntimeEnv::default().with_var("DBX_JDBC_ROOT_CLOSE", mode),
                registry.lifecycle().begin_connection(ID, "Owned native job session").unwrap(),
            )
            .await
            .unwrap();
            assert!(process.pid().await.is_some());
            assert_eq!(process.shutdown_confirmed().await.is_ok(), confirmed);
            assert!(process.pid().await.is_none(), "unconfirmed native cleanup must still retire the owned process");
        }
    }
}
