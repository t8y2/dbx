//! Builtin task providers (ADR §2.2): executors that live inside dbx-core and
//! reuse the existing feature services instead of re-implementing them.

pub mod database_backup;
pub mod plugin;

pub use database_backup::{DatabaseBackupTaskConfig, DatabaseBackupTaskExecutor, DATABASE_BACKUP_PROVIDER_ID};
pub use plugin::PluginTaskExecutor;
