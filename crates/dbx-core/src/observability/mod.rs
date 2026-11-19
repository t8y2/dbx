//! Host observation bus: a bounded, non-blocking fan-out of structured host
//! activity for observability plugins (`host.observe:*` permissions).
//!
//! Taps (query execution, connection lifecycle, AI agent loop, transfers,
//! plugin lifecycle) call [`HostObservationBus::publish`] synchronously at the
//! point of interest. Delivery to plugin UIs and sidecars is asynchronous and
//! lives in the shell layer, mirroring how `PluginEvent`s flow
//! (session → host broadcast → Tauri/SSE bridge). Publishers must stay fast:
//! the bus only clones the payload into a bounded broadcast channel, and
//! `publish` returns immediately when no observer is attached. This follows
//! DBeaver's Query Manager rule that execution-time handlers must never do
//! real work (`QMExecutionHandler` javadoc).
//!
//! Lagging subscribers drop events (bounded capacity, same tradeoff as
//! `PluginHost::events`) and can detect gaps through the monotonic `id`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dbx_types::models::observability::HostObservationEvent;
use tokio::sync::broadcast;

/// Capacity for the observation channel. Query/connection events are
/// low-volume; AI deltas are the only burst source and a consumer that falls
/// behind can reconstruct text from the surrounding non-delta events.
pub const HOST_OBSERVATION_CAPACITY: usize = 1024;

/// Cheap-to-clone handle stored on `AppState`. All taps share one bus.
#[derive(Clone)]
pub struct HostObservationBus {
    sender: broadcast::Sender<HostObservationEvent>,
    next_id: Arc<AtomicU64>,
}

impl HostObservationBus {
    pub fn new() -> Self {
        Self { sender: broadcast::Sender::new(HOST_OBSERVATION_CAPACITY), next_id: Arc::new(AtomicU64::new(0)) }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HostObservationEvent> {
        self.sender.subscribe()
    }

    /// Publish one event. Returns `false` when the event was dropped because
    /// no observer is attached — the fast path taps (every SQL statement) rely
    /// on this to avoid allocating payloads in the common case.
    pub fn publish(
        &self,
        kind: &str,
        connection_id: Option<String>,
        database: Option<String>,
        payload: serde_json::Value,
    ) -> bool {
        if self.sender.receiver_count() == 0 {
            return false;
        }
        let event = HostObservationEvent {
            // Start ids at 1 so `0` can never be mistaken for a real event.
            id: self.next_id.fetch_add(1, Ordering::Relaxed) + 1,
            ts_ms: unix_now_ms(),
            kind: kind.to_string(),
            connection_id,
            database,
            payload,
        };
        // `send` only fails when every receiver went away after the count
        // check; dropping the event is correct in that case.
        self.sender.send(event).is_ok()
    }

    /// Number of attached subscribers. Used by tests and by callers that want
    /// to build an expensive payload only when someone is listening.
    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }
}

impl Default for HostObservationBus {
    fn default() -> Self {
        Self::new()
    }
}

fn unix_now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or_default()
}

/// Cap text-heavy fields of an observation payload in place. String fields are
/// truncated directly; structured values (tool args/results) are serialized
/// and replaced with the capped text when they exceed the limit, together with
/// a `<field>Truncated` marker so consumers never mistake a clipped value for
/// the real one.
pub fn cap_observation_fields(payload: &mut serde_json::Value, fields: &[&str]) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    for field in fields {
        let Some(value) = object.get(*field).cloned() else {
            continue;
        };
        let capped = match &value {
            serde_json::Value::String(text) => {
                let (capped, truncated) = dbx_types::models::observability::cap_observation_text(text);
                truncated.then_some(serde_json::Value::String(capped))
            }
            other => serde_json::to_string(other).ok().and_then(|serialized| {
                let (capped, truncated) = dbx_types::models::observability::cap_observation_text(&serialized);
                truncated.then_some(serde_json::Value::String(capped))
            }),
        };
        if let Some(capped) = capped {
            object.insert((*field).to_string(), capped);
            object.insert(format!("{field}Truncated"), serde_json::Value::Bool(true));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_types::models::observability::{KIND_PLUGIN_ACTIVATED, KIND_QUERY_STARTED};

    #[test]
    fn publish_without_subscribers_is_dropped_and_cheap() {
        let bus = HostObservationBus::new();
        assert!(!bus.publish(KIND_QUERY_STARTED, None, None, serde_json::json!({})));
        assert_eq!(bus.subscriber_count(), 0);
    }

    #[tokio::test]
    async fn publish_stamps_monotonic_ids_and_delivers() {
        let bus = HostObservationBus::new();
        let mut receiver = bus.subscribe();
        assert!(bus.publish(
            KIND_QUERY_STARTED,
            Some("conn-1".into()),
            Some("db".into()),
            serde_json::json!({"sql": "select 1"})
        ));
        assert!(bus.publish(KIND_PLUGIN_ACTIVATED, None, None, serde_json::json!({"pluginId": "p"})));

        let first = receiver.recv().await.unwrap();
        let second = receiver.recv().await.unwrap();
        assert_eq!(first.id, 1);
        assert_eq!(second.id, 2);
        assert!(second.ts_ms >= first.ts_ms);
        assert_eq!(first.connection_id.as_deref(), Some("conn-1"));
        assert_eq!(second.kind, KIND_PLUGIN_ACTIVATED);
    }

    #[test]
    fn cap_observation_fields_truncates_and_marks() {
        use dbx_types::models::observability::MAX_OBSERVATION_TEXT_BYTES;

        let big = "x".repeat(MAX_OBSERVATION_TEXT_BYTES + 16);
        let mut payload = serde_json::json!({
            "sql": big,
            "args": { "blob": "y".repeat(MAX_OBSERVATION_TEXT_BYTES + 16) },
            "small": "ok",
        });
        cap_observation_fields(&mut payload, &["sql", "args"]);
        assert!(payload["sql"].as_str().unwrap().ends_with('…'));
        assert_eq!(payload["sqlTruncated"], true);
        // Structured values are replaced by their capped JSON text.
        assert!(payload["args"].is_string());
        assert_eq!(payload["argsTruncated"], true);
        assert_eq!(payload["small"], "ok");
        assert!(payload.get("smallTruncated").is_none());
    }

    /// The plugin-runtime emits these kinds; keep them equal to the dbx-types
    /// constants so the sidecar/UI permission mapping cannot silently drift.
    #[test]
    fn plugin_observation_kinds_match_shared_constants() {
        use dbx_plugin_runtime::plugins::observation::{
            KIND_ACTIVATED, KIND_ACTIVATE_FAILED, KIND_STATUS_CHANGED, KIND_STOPPED,
        };
        use dbx_types::models::observability::{
            KIND_PLUGIN_ACTIVATED, KIND_PLUGIN_ACTIVATE_FAILED, KIND_PLUGIN_STATUS_CHANGED, KIND_PLUGIN_STOPPED,
        };
        assert_eq!(KIND_ACTIVATED, KIND_PLUGIN_ACTIVATED);
        assert_eq!(KIND_ACTIVATE_FAILED, KIND_PLUGIN_ACTIVATE_FAILED);
        assert_eq!(KIND_STATUS_CHANGED, KIND_PLUGIN_STATUS_CHANGED);
        assert_eq!(KIND_STOPPED, KIND_PLUGIN_STOPPED);
    }
}
