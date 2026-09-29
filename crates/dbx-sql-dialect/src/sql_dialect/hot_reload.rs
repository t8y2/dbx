use std::path::PathBuf;
use std::time::Duration;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

use super::dialect_loader::DialectPluginLoader;

/// Configuration for the hot-reload watcher.
#[derive(Debug, Clone)]
pub struct HotReloadConfig {
    /// Debounce duration — multiple changes within this window are coalesced.
    pub debounce_ms: u64,
    /// Whether to enable polling (needed for some network filesystems).
    pub enable_polling: bool,
    /// Polling interval when polling is enabled.
    pub poll_interval_ms: u64,
}

impl Default for HotReloadConfig {
    fn default() -> Self {
        Self { debounce_ms: 500, enable_polling: false, poll_interval_ms: 2000 }
    }
}

/// Result of a hot-reload operation on a changed file.
#[derive(Debug, Clone)]
pub enum ReloadEvent {
    /// A dialect YAML file was successfully loaded/updated.
    Loaded { path: PathBuf },
    /// A dialect YAML file was removed — dialect unregistered.
    Removed { path: PathBuf, dialect: String },
    /// A file changed but failed to load.
    Error { path: PathBuf, error: String },
}

/// Hot-reload watcher that monitors `plugins/dialects/` for YAML changes
/// and updates the `DialectRegistry` in real time.
pub struct DialectHotReload {
    watcher: Option<RecommendedWatcher>,
    config: HotReloadConfig,
}

impl DialectHotReload {
    pub fn new(config: HotReloadConfig) -> Self {
        Self { watcher: None, config }
    }

    /// Start watching. Returns a channel receiver for reload events.
    pub fn start(&mut self, watch_dirs: Vec<PathBuf>) -> Result<mpsc::UnboundedReceiver<ReloadEvent>, String> {
        let (tx, rx) = mpsc::unbounded_channel();

        let _debounce = Duration::from_millis(self.config.debounce_ms);

        let tx_clone = tx.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| match res {
                Ok(event) => {
                    if !Self::is_relevant(&event) {
                        return;
                    }
                    for path in &event.paths {
                        let _ = tx_clone.send(match event.kind {
                            EventKind::Create(_) | EventKind::Modify(_) => ReloadEvent::Loaded { path: path.clone() },
                            EventKind::Remove(_) => ReloadEvent::Removed {
                                path: path.clone(),
                                dialect: path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown").to_string(),
                            },
                            _ => continue,
                        });
                    }
                }
                Err(e) => {
                    let _ = tx_clone
                        .send(ReloadEvent::Error { path: PathBuf::from("."), error: format!("Watcher error: {e}") });
                }
            },
            Config::default()
                .with_poll_interval(Duration::from_millis(self.config.poll_interval_ms))
                .with_compare_contents(true),
        )
        .map_err(|e| format!("Failed to create file watcher: {e}"))?;

        for dir in &watch_dirs {
            if dir.exists() {
                watcher
                    .watch(dir, RecursiveMode::NonRecursive)
                    .map_err(|e| format!("Failed to watch {}: {e}", dir.display()))?;
            }
        }

        self.watcher = Some(watcher);
        Ok(rx)
    }

    /// Process reload events in a loop, updating the registry.
    /// This is a convenience function that runs forever on the current task.
    pub async fn run_forever(
        watch_dirs: Vec<PathBuf>,
        registry: &'static super::dialect_loader::DialectRegistry,
    ) -> Result<(), String> {
        let mut reload = Self::new(HotReloadConfig::default());
        let mut rx = reload.start(watch_dirs)?;

        while let Some(event) = rx.recv().await {
            match &event {
                ReloadEvent::Loaded { path } => match DialectPluginLoader::load_file(path) {
                    Ok((kind, yaml, descriptor)) => {
                        registry.register_yaml(path, yaml, descriptor);
                        log::info!("Hot-reload: loaded dialect {:?} from {}", kind, path.display());
                    }
                    Err(e) => {
                        log::warn!("Hot-reload: failed to load {}: {e}", path.display());
                    }
                },
                ReloadEvent::Removed { path, dialect } => {
                    registry.unregister(dialect);
                    log::info!("Hot-reload: unregistered dialect {dialect} ({})", path.display());
                }
                ReloadEvent::Error { path, error } => {
                    log::error!("Hot-reload: error watching {}: {error}", path.display());
                }
            }
        }

        Ok(())
    }

    fn is_relevant(event: &Event) -> bool {
        for path in &event.paths {
            if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                if matches!(ext, "yaml" | "yml") {
                    return true;
                }
            }
        }
        false
    }

    pub fn stop(&mut self) {
        self.watcher = None;
    }
}
