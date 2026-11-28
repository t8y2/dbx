//! Plugin lifecycle observations for the host observation bus.
//!
//! `PluginHost` reports activation, status transitions and stops through an
//! injected sink. The runtime stays independent of the bus implementation:
//! the shell (dbx-core `AppState`) maps these observations onto
//! [`dbx_types::models::observability::HostObservationEvent`] and its
//! `host.observe:plugins` permission.

use std::sync::Arc;

/// Kind constants shared with `dbx_types::models::observability`. Re-exported
/// here so the runtime and the bus cannot drift; a dbx-core test asserts
/// equality.
pub use dbx_types::models::observability::{
    KIND_PLUGIN_ACTIVATED as KIND_ACTIVATED, KIND_PLUGIN_ACTIVATE_FAILED as KIND_ACTIVATE_FAILED,
    KIND_PLUGIN_STATUS_CHANGED as KIND_STATUS_CHANGED, KIND_PLUGIN_STOPPED as KIND_STOPPED,
};

/// One plugin lifecycle observation.
#[derive(Debug, Clone)]
pub struct PluginObservation {
    pub plugin_id: String,
    pub kind: &'static str,
    pub payload: serde_json::Value,
}

/// Sink invoked from `PluginHost` activation/stop paths and the per-session
/// status watcher. Must not block: implementations publish into a bounded
/// broadcast channel.
pub type PluginObservationSink = Arc<dyn Fn(PluginObservation) + Send + Sync>;
