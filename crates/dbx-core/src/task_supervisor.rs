use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
pub struct TaskSupervisor {
    accepting: Arc<AtomicBool>,
    cancellation: CancellationToken,
    tasks: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

impl TaskSupervisor {
    pub fn new() -> Self {
        Self {
            accepting: Arc::new(AtomicBool::new(true)),
            cancellation: CancellationToken::new(),
            tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn spawn_replace<F, Fut>(&self, key: impl Into<String>, task: F) -> bool
    where
        F: FnOnce(CancellationToken) -> Fut,
        Fut: Future<Output = ()> + Send + 'static,
    {
        if !self.accepting.load(Ordering::Acquire) {
            return false;
        }
        let handle = tokio::spawn(task(self.cancellation.child_token()));
        if let Some(previous) = self.tasks.lock().unwrap_or_else(|error| error.into_inner()).insert(key.into(), handle)
        {
            previous.abort();
        }
        true
    }

    pub fn stop(&self, key: &str) {
        if let Some(task) = self.tasks.lock().unwrap_or_else(|error| error.into_inner()).remove(key) {
            task.abort();
        }
    }

    pub async fn stop_and_wait(&self, key: &str) {
        let task = self.tasks.lock().unwrap_or_else(|error| error.into_inner()).remove(key);
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
    }

    pub fn stop_many<'a>(&self, keys: impl IntoIterator<Item = &'a str>) {
        for key in keys {
            self.stop(key);
        }
    }

    pub fn active_count(&self) -> usize {
        self.tasks.lock().unwrap_or_else(|error| error.into_inner()).len()
    }

    pub async fn shutdown(&self, deadline: Duration) {
        self.accepting.store(false, Ordering::Release);
        self.cancellation.cancel();
        let mut handles: Vec<JoinHandle<()>> =
            self.tasks.lock().unwrap_or_else(|error| error.into_inner()).drain().map(|(_, handle)| handle).collect();
        let wait = async {
            for handle in &mut handles {
                let _ = handle.await;
            }
        };
        if tokio::time::timeout(deadline, wait).await.is_err() {
            for handle in handles {
                handle.abort();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TaskSupervisor;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn replacement_aborts_previous_task() {
        let supervisor = TaskSupervisor::new();
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        supervisor.spawn_replace("task", move |token| async move {
            token.cancelled().await;
            flag.store(true, Ordering::SeqCst);
        });
        supervisor.spawn_replace("task", |_| async {});
        tokio::task::yield_now().await;
        assert_eq!(supervisor.active_count(), 1);
        assert!(!cancelled.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn shutdown_cancels_tasks_and_rejects_new_work() {
        let supervisor = TaskSupervisor::new();
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        supervisor.spawn_replace("task", move |token| async move {
            token.cancelled().await;
            flag.store(true, Ordering::SeqCst);
        });
        supervisor.shutdown(Duration::from_secs(1)).await;
        assert!(cancelled.load(Ordering::SeqCst));
        assert_eq!(supervisor.active_count(), 0);
        assert!(!supervisor.spawn_replace("late", |_| async {}));
    }
}
