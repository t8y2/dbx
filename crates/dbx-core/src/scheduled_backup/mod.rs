//! Durable, UI-independent database backup scheduling shared by desktop and Web.
mod engine;
mod models;
mod service;
mod store;
#[cfg(test)]
mod tests;

pub use models::{BackupConfig, BackupFile, BackupRun, BackupSchedule, Migration, RunRequest};
pub use service::{BackupCommand, BackupService};
pub use store::{BackupSnapshot, BackupStore};

/// Metadata and export command chains nest very large async futures - a single
/// frame can reach 60-150 KiB - which does not fit into tokio's default 2 MiB
/// worker stack. Every runtime that drives them (desktop, background worker and
/// Web server) has to reserve the same roomy stack, otherwise the process dies
/// with `fatal runtime error: stack overflow` instead of reporting an error.
pub const WORKER_STACK_SIZE: usize = 16 * 1024 * 1024;

/// Builds the multi-threaded runtime used by processes that run metadata and
/// backup work, on a stack that can hold those nested futures.
pub fn worker_runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(WORKER_STACK_SIZE).build()
}
