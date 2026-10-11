//! In-flight run queue: tracks the dispatch tasks the engine has spawned so
//! cancel requests, shutdown draining and reaping stay O(active runs) and the
//! engine never loses track of a run it claimed.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use tokio_util::sync::CancellationToken;

struct QueueEntry {
    #[allow(dead_code)]
    task_id: String,
    cancellation: CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

/// The runs this worker has claimed and dispatched but not yet finished.
#[derive(Default)]
pub struct RunQueue {
    entries: Mutex<HashMap<String, QueueEntry>>,
}

impl RunQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a dispatched run and spawns its future.
    pub fn spawn(
        &self,
        run_id: String,
        task_id: String,
        cancellation: CancellationToken,
        future: impl Future<Output = ()> + Send + 'static,
    ) {
        let handle = tokio::spawn(future);
        self.entries.lock().expect("run queue poisoned").insert(run_id, QueueEntry { task_id, cancellation, handle });
    }

    pub fn is_running(&self, run_id: &str) -> bool {
        self.entries.lock().expect("run queue poisoned").contains_key(run_id)
    }

    pub fn active_runs(&self) -> Vec<String> {
        self.entries.lock().expect("run queue poisoned").keys().cloned().collect()
    }

    /// Fires the cancellation token of one in-flight run. The executor is
    /// expected to stop for real; the dispatch task then finalizes the run.
    pub fn cancel(&self, run_id: &str) -> bool {
        self.entries.lock().expect("run queue poisoned").get(run_id).map(|entry| entry.cancellation.cancel()).is_some()
    }

    /// Drops the bookkeeping of finished dispatch tasks.
    pub fn reap(&self) {
        self.entries.lock().expect("run queue poisoned").retain(|_, entry| !entry.handle.is_finished());
    }

    /// Cancels every in-flight run and waits for the dispatch tasks to unwind
    /// (engine shutdown).
    pub async fn drain(&self) {
        let mut entries: Vec<QueueEntry> = {
            let mut guard = self.entries.lock().expect("run queue poisoned");
            guard.drain().map(|(_, entry)| entry).collect()
        };
        for entry in entries.iter_mut() {
            entry.cancellation.cancel();
        }
        for entry in entries {
            let _ = entry.handle.await;
        }
    }
}

impl std::fmt::Debug for RunQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunQueue").field("active", &self.active_runs().len()).finish()
    }
}
