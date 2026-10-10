//! Engine event sink (ADR §7.4): the add-only bridge between engine-side
//! activity (run logs, progress, engine-driven state changes) and whichever
//! host process runs the engine. Hosts register a sink at startup
//! (`register_event_sink`); the engine, the task logger and the progress
//! reporter publish fire-and-forget events with the frozen ADR §7.4 payload
//! shape `{ "type", "taskId", "runId", ... }`.
//!
//! Events are notifications only (§7.4: they are allowed to be lost; clients
//! must be able to rebuild full state from the API), so `publish` never fails
//! and never influences run execution. Sinks must be cheap and must not
//! panic — they run inline on the emitting code path (engine loop, log
//! append, progress report).

use std::sync::{Arc, OnceLock, RwLock};

/// A process-global receiver of scheduler events.
pub type SchedulerEventSink = Arc<dyn Fn(&serde_json::Value) + Send + Sync>;

fn sinks() -> &'static RwLock<Vec<(String, SchedulerEventSink)>> {
    static SINKS: OnceLock<RwLock<Vec<(String, SchedulerEventSink)>>> = OnceLock::new();
    SINKS.get_or_init(|| RwLock::new(Vec::new()))
}

/// Registers (or replaces, keyed by `name`) a process-global event sink.
/// Name-keyed so repeated host startup paths (router rebuilds, app re-setup)
/// stay idempotent instead of duplicating deliveries.
pub fn register_event_sink(name: &str, sink: SchedulerEventSink) {
    let mut sinks = match sinks().write() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match sinks.iter_mut().find(|(existing, _)| existing == name) {
        Some(slot) => slot.1 = sink,
        None => sinks.push((name.to_owned(), sink)),
    }
}

/// Fan-out to every registered sink. Best effort by contract: no sink, no
/// delivery, no error.
pub(crate) fn publish(event: serde_json::Value) {
    let sinks = match sinks().read() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    for (_, sink) in sinks.iter() {
        sink(&event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // The sink registry is process-global and tests run in parallel, so every
    // test publishes events carrying a unique `marker` and filters for it in
    // its own sink — cross-test deliveries are ignored by construction.

    #[test]
    fn sink_receives_published_events_and_name_registration_is_idempotent() {
        let received: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let first = Arc::clone(&received);
        register_event_sink(
            "test-hub",
            Arc::new(move |event| {
                if event["marker"] == "hub-test" {
                    first.lock().unwrap().push(event.clone());
                }
            }),
        );
        publish(serde_json::json!({ "type": "run-state", "runId": "r1", "marker": "hub-test" }));

        let replaced: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let second = Arc::clone(&replaced);
        register_event_sink(
            "test-hub",
            Arc::new(move |event| {
                if event["marker"] == "hub-test" {
                    second.lock().unwrap().push(event["type"].as_str().unwrap_or_default().to_owned());
                }
            }),
        );
        publish(serde_json::json!({ "type": "run-progress", "runId": "r1", "marker": "hub-test" }));

        let events = received.lock().unwrap();
        assert_eq!(events.len(), 1, "re-registering under the same name must replace, not duplicate");
        assert_eq!(events[0]["type"], "run-state");
        assert_eq!(replaced.lock().unwrap().as_slice(), ["run-progress"]);
    }

    #[test]
    fn multiple_sinks_each_receive_one_copy() {
        let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let first = Arc::clone(&received);
        register_event_sink(
            "sink-a",
            Arc::new(move |event| {
                if event["marker"] == "fanout-test" {
                    first.lock().unwrap().push("a".into());
                }
            }),
        );
        let second = Arc::clone(&received);
        register_event_sink(
            "sink-b",
            Arc::new(move |event| {
                if event["marker"] == "fanout-test" {
                    second.lock().unwrap().push("b".into());
                }
            }),
        );
        publish(serde_json::json!({ "type": "run-created", "marker": "fanout-test" }));
        let mut names = received.lock().unwrap().clone();
        names.sort();
        assert_eq!(names, vec!["a".to_owned(), "b".to_owned()]);
    }
}
