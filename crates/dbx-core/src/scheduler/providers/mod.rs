//! Builtin task providers (ADR §2.2): executors that live inside dbx-core and
//! reuse the existing feature services instead of re-implementing them.

pub mod cloud_sync;
pub mod plugin;

pub use cloud_sync::{CloudSyncTaskExecutor, CLOUD_SYNC_PROVIDER_ID, CLOUD_SYNC_TRIGGER_ID};
pub use plugin::{PluginResidentExecutor, PluginTaskExecutor};
