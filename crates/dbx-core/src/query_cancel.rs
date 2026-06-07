use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

type InterruptFn = Box<dyn Fn() + Send + 'static>;

#[derive(Clone, Default)]
pub struct RunningQueries {
    inner: Arc<Mutex<HashMap<String, CancellationToken>>>,
    interrupts: Arc<Mutex<HashMap<String, InterruptFn>>>,
}

impl RunningQueries {
    pub fn register(&self, execution_id: String) -> RegisteredQuery {
        let token = CancellationToken::new();
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).insert(execution_id.clone(), token.clone());

        RegisteredQuery { execution_id, token, running_queries: self.clone() }
    }

    pub fn register_interrupt(&self, execution_id: &str, interrupt: impl Fn() + Send + 'static) {
        self.interrupts.lock().unwrap_or_else(|e| e.into_inner()).insert(execution_id.to_string(), Box::new(interrupt));
    }

    pub fn cancel(&self, execution_id: &str) -> bool {
        let token = self.inner.lock().unwrap_or_else(|e| e.into_inner()).get(execution_id).cloned();
        let interrupt = self.interrupts.lock().unwrap_or_else(|e| e.into_inner()).remove(execution_id);

        if let Some(interrupt) = interrupt {
            interrupt();
        }
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    pub fn has(&self, execution_id: &str) -> bool {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).contains_key(execution_id)
    }

    fn remove(&self, execution_id: &str) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).remove(execution_id);
        self.interrupts.lock().unwrap_or_else(|e| e.into_inner()).remove(execution_id);
    }
}

pub struct RegisteredQuery {
    execution_id: String,
    token: CancellationToken,
    running_queries: RunningQueries,
}

impl RegisteredQuery {
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }
}

impl Drop for RegisteredQuery {
    fn drop(&mut self) {
        self.running_queries.remove(&self.execution_id);
    }
}

#[cfg(test)]
mod tests {
    use super::RunningQueries;

    #[test]
    fn cancel_marks_registered_query_as_cancelled() {
        let running = RunningQueries::default();
        let registered = running.register("exec-1".to_string());

        assert!(running.cancel("exec-1"));
        assert!(registered.token().is_cancelled());
    }

    #[test]
    fn dropping_registration_removes_running_query() {
        let running = RunningQueries::default();
        let registered = running.register("exec-1".to_string());

        assert!(running.has("exec-1"));
        drop(registered);

        assert!(!running.has("exec-1"));
    }
}
