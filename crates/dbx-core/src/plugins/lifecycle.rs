use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

const UPDATE_IN_PROGRESS: &str = "Plugin update is in progress. Please try again after it finishes.";
const OPERATIONS_ACTIVE: &str = "Plugin update blocked by active operations. Please wait for them to finish.";

#[derive(Debug, Clone, Default)]
pub struct PluginLifecycle {
    usage: Arc<Mutex<HashMap<String, PluginUsage>>>,
}

#[derive(Debug, Default)]
struct PluginUsage {
    connections: BTreeMap<String, usize>,
    operations: usize,
    updating: bool,
}

impl PluginUsage {
    fn ensure_updatable(&self) -> Result<(), String> {
        if self.updating {
            return Err(UPDATE_IN_PROGRESS.to_string());
        }
        if !self.connections.is_empty() {
            return Err(format!(
                "Plugin update blocked by active connections: {}",
                self.connections.keys().cloned().collect::<Vec<_>>().join(", ")
            ));
        }
        if self.operations > 0 {
            return Err(OPERATIONS_ACTIVE.to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PluginUsageGuard {
    _lease: Arc<PluginUsageLease>,
}

#[derive(Debug)]
struct PluginUsageLease {
    lifecycle: PluginLifecycle,
    plugin_id: String,
    kind: PluginUsageKind,
}

#[derive(Debug)]
enum PluginUsageKind {
    Connection(String),
    Operation,
    Update,
}

impl PluginLifecycle {
    pub(crate) fn check_update(&self, plugin_id: &str) -> Result<(), String> {
        let usage = self.usage.lock().unwrap_or_else(|error| error.into_inner());
        usage.get(plugin_id).map_or(Ok(()), PluginUsage::ensure_updatable)
    }

    pub(crate) fn begin_connection(&self, plugin_id: &str, label: &str) -> Result<PluginUsageGuard, String> {
        let label = if label.trim().is_empty() { plugin_id } else { label };
        self.acquire(plugin_id, PluginUsageKind::Connection(label.to_string()))
    }

    pub(crate) fn begin_operation(&self, plugin_id: &str) -> Result<PluginUsageGuard, String> {
        self.acquire(plugin_id, PluginUsageKind::Operation)
    }

    pub(crate) fn begin_update(&self, plugin_id: &str) -> Result<PluginUsageGuard, String> {
        self.acquire(plugin_id, PluginUsageKind::Update)
    }

    fn acquire(&self, plugin_id: &str, kind: PluginUsageKind) -> Result<PluginUsageGuard, String> {
        let mut plugins = self.usage.lock().unwrap_or_else(|error| error.into_inner());
        let usage = plugins.entry(plugin_id.to_string()).or_default();
        if usage.updating {
            return Err(UPDATE_IN_PROGRESS.to_string());
        }
        match &kind {
            PluginUsageKind::Connection(label) => *usage.connections.entry(label.clone()).or_default() += 1,
            PluginUsageKind::Operation => usage.operations += 1,
            PluginUsageKind::Update => {
                usage.ensure_updatable()?;
                usage.updating = true;
            }
        }
        Ok(PluginUsageGuard {
            _lease: Arc::new(PluginUsageLease { lifecycle: self.clone(), plugin_id: plugin_id.to_string(), kind }),
        })
    }
}

impl Drop for PluginUsageLease {
    fn drop(&mut self) {
        let mut plugins = self.lifecycle.usage.lock().unwrap_or_else(|error| error.into_inner());
        let Some(usage) = plugins.get_mut(&self.plugin_id) else {
            return;
        };
        match &self.kind {
            PluginUsageKind::Connection(label) => {
                if let Some(count) = usage.connections.get_mut(label) {
                    *count -= 1;
                    if *count == 0 {
                        usage.connections.remove(label);
                    }
                }
            }
            PluginUsageKind::Operation => usage.operations -= 1,
            PluginUsageKind::Update => usage.updating = false,
        }
        if usage.connections.is_empty() && usage.operations == 0 && !usage.updating {
            plugins.remove(&self.plugin_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connections_block_only_their_plugin_until_all_handles_are_dropped() {
        let lifecycle = PluginLifecycle::default();
        let connection = lifecycle.begin_connection("s3", "Production S3").unwrap();
        let clone = connection.clone();
        let second = lifecycle.begin_connection("s3", "Production S3").unwrap();
        assert_eq!(
            lifecycle.begin_update("s3").unwrap_err(),
            "Plugin update blocked by active connections: Production S3"
        );
        assert!(lifecycle.begin_update("other").is_ok());
        drop(connection);
        drop(second);
        assert!(lifecycle.begin_update("s3").is_err());
        drop(clone);
        assert!(lifecycle.begin_update("s3").is_ok());
    }

    #[test]
    fn operations_block_updates_without_connections() {
        let lifecycle = PluginLifecycle::default();
        let operation = lifecycle.begin_operation("tool").unwrap();
        assert_eq!(lifecycle.begin_update("tool").unwrap_err(), OPERATIONS_ACTIVE);
        drop(operation);
        assert!(lifecycle.begin_update("tool").is_ok());
    }

    #[test]
    fn updates_block_new_connections_operations_and_updates() {
        let lifecycle = PluginLifecycle::default();
        let update = lifecycle.begin_update("s3").unwrap();
        assert_eq!(lifecycle.begin_connection("s3", "S3").unwrap_err(), UPDATE_IN_PROGRESS);
        assert_eq!(lifecycle.begin_operation("s3").unwrap_err(), UPDATE_IN_PROGRESS);
        assert_eq!(lifecycle.begin_update("s3").unwrap_err(), UPDATE_IN_PROGRESS);
        assert!(lifecycle.begin_connection("other", "Other").is_ok());
        drop(update);
        assert!(lifecycle.begin_connection("s3", "S3").is_ok());
        assert!(lifecycle.usage.lock().unwrap().is_empty());
    }

    #[test]
    fn connection_and_update_admission_are_atomic() {
        for _ in 0..64 {
            let lifecycle = PluginLifecycle::default();
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let other_lifecycle = lifecycle.clone();
            let other_barrier = barrier.clone();
            let connection = std::thread::spawn(move || {
                other_barrier.wait();
                let result = other_lifecycle.begin_connection("s3", "S3");
                other_barrier.wait();
                result
            });
            barrier.wait();
            let update = lifecycle.begin_update("s3");
            barrier.wait();
            let connection = connection.join().unwrap();
            assert_ne!(connection.is_ok(), update.is_ok());
        }
    }
}
