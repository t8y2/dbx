use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
pub struct RunningQueries {
    inner: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl RunningQueries {
    pub fn register(&self, execution_id: String) -> RegisteredQuery {
        let token = CancellationToken::new();
        self.inner
            .lock()
            .expect("running query registry poisoned")
            .insert(execution_id.clone(), token.clone());

        RegisteredQuery {
            execution_id,
            token,
            running_queries: self.clone(),
        }
    }

    pub fn cancel(&self, execution_id: &str) -> bool {
        let token = self
            .inner
            .lock()
            .expect("running query registry poisoned")
            .get(execution_id)
            .cloned();

        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    pub fn has(&self, execution_id: &str) -> bool {
        self.inner
            .lock()
            .expect("running query registry poisoned")
            .contains_key(execution_id)
    }

    fn remove(&self, execution_id: &str) {
        self.inner
            .lock()
            .expect("running query registry poisoned")
            .remove(execution_id);
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
