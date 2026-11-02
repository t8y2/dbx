use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fs2::FileExt;
use sha2::{Digest, Sha256};

const UPDATE_IN_PROGRESS: &str = "Plugin update is in progress. Please try again after it finishes.";
const OPERATIONS_ACTIVE: &str = "Plugin update blocked by active operations. Please wait for them to finish.";

#[derive(Debug, Clone, Default)]
pub struct PluginLifecycle {
    usage: Arc<Mutex<HashMap<String, PluginUsage>>>,
    store: Option<Arc<PathBuf>>,
}

pub(super) struct PluginUpdateProbe(Option<File>);

impl PluginUpdateProbe {
    pub(super) fn requested(&self) -> Result<bool, String> {
        let Some(file) = &self.0 else { return Ok(false) };
        match FileExt::try_lock_shared(file) {
            Ok(()) => FileExt::unlock(file)
                .map(|()| false)
                .map_err(|error| format!("Failed to release plugin lifecycle probe: {error}")),
            Err(error) if lock_contended(&error) => Ok(true),
            Err(error) => Err(format!("Failed to inspect plugin lifecycle lock: {error}")),
        }
    }
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
    // Release the runtime barrier before admitting new operations.
    runtime_lock: Mutex<Option<File>>,
    _activity_lock: Option<File>,
}

#[derive(Debug)]
enum PluginUsageKind {
    Connection(String),
    Operation,
    Update,
}

impl PluginLifecycle {
    pub(super) fn for_store(root: &Path) -> Self {
        Self { store: Some(Arc::new(root.join(".runtime"))), ..Self::default() }
    }

    fn lock_file(&self, plugin_id: &str, name: &str) -> Result<Option<File>, String> {
        let Some(root) = &self.store else { return Ok(None) };
        // IDs arriving from external tool calls must never become filesystem paths.
        let key = format!("{:x}", Sha256::digest(plugin_id.as_bytes()));
        let dir = root.join(key);
        std::fs::create_dir_all(&dir).map_err(|error| format!("Failed to prepare plugin lifecycle: {error}"))?;
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join(name))
            .map(Some)
            .map_err(|error| format!("Failed to open plugin lifecycle lock: {error}"))
    }

    pub(super) fn runtime_lease(&self, plugin_id: &str) -> Result<Option<File>, String> {
        let file = self.lock_file(plugin_id, "runtime.lock")?;
        if let Some(file) = &file {
            FileExt::try_lock_shared(file).map_err(|_| UPDATE_IN_PROGRESS.to_string())?;
        }
        Ok(file)
    }

    /// An exclusive activity lock requests idle runtimes in *every* DBX host to stop.
    pub(super) fn update_probe(&self, plugin_id: &str) -> Result<PluginUpdateProbe, String> {
        Ok(PluginUpdateProbe(self.lock_file(plugin_id, "activity.lock")?))
    }

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
        if matches!(kind, PluginUsageKind::Update) {
            usage.ensure_updatable()?;
        }
        let file = self.lock_file(plugin_id, "activity.lock")?;
        if let Some(file) = &file {
            let result = if matches!(kind, PluginUsageKind::Update) {
                FileExt::try_lock_exclusive(file)
            } else {
                FileExt::try_lock_shared(file)
            };
            result.map_err(|error| {
                if lock_contended(&error) {
                    if matches!(kind, PluginUsageKind::Update) {
                        "Plugin update blocked by active connections or operations in another DBX host. Close them and try again.".to_string()
                    } else {
                        UPDATE_IN_PROGRESS.to_string()
                    }
                } else { format!("Failed to lock plugin lifecycle: {error}") }
            })?;
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
            _lease: Arc::new(PluginUsageLease {
                lifecycle: self.clone(),
                plugin_id: plugin_id.to_string(),
                kind,
                runtime_lock: Mutex::new(None),
                _activity_lock: file,
            }),
        })
    }
}

fn lock_contended(error: &std::io::Error) -> bool {
    error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
}

impl PluginUsageGuard {
    pub(super) fn runtime_lease(&self) -> Result<Option<File>, String> {
        self._lease.lifecycle.runtime_lease(&self._lease.plugin_id)
    }

    /// Called on a blocking installer thread, after the activity lock prevents new work.
    /// Runtime monitors release their shared locks only after all executable handles drop.
    pub(super) fn drain_runtimes(&self) -> Result<(), String> {
        let Some(file) = self._lease.lifecycle.lock_file(&self._lease.plugin_id, "runtime.lock")? else {
            return Ok(());
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match FileExt::try_lock_exclusive(&file) {
                Ok(()) => {
                    *self._lease.runtime_lock.lock().unwrap_or_else(|error| error.into_inner()) = Some(file);
                    return Ok(());
                }
                Err(error) if lock_contended(&error) && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => {
                    return Err(format!(
                        "Failed to stop plugin '{}' runtimes in other DBX hosts: {error}",
                        self._lease.plugin_id
                    ))
                }
            }
        }
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
