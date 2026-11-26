//! Host observation bus: a bounded, non-blocking fan-out of structured host
//! activity for observability plugins (`host.observe:*` permissions).
//!
//! Taps (query execution, connection lifecycle, AI agent loop, transfers,
//! plugin lifecycle) call [`HostObservationBus::publish`] synchronously at the
//! point of interest. Delivery to plugin UIs and sidecars is asynchronous and
//! lives in the shell layer, mirroring how `PluginEvent`s flow
//! (session → host broadcast → Tauri/SSE bridge). Publishers must stay fast:
//! the bus only clones the payload into a bounded broadcast channel, and
//! `publish` returns immediately when no observer is interested. This follows
//! DBeaver's Query Manager rule that execution-time handlers must never do
//! real work (`QMExecutionHandler` javadoc).
//!
//! "Interested" is tracked per category by [`ObservationInterest`], not by
//! broadcast receiver count: the shell bridges hold receivers for the whole
//! process, so a receiver is not evidence that anyone watches. Plugin
//! workbenches and running sidecars register interest while they are alive.
//!
//! This stream is best-effort: it is monitoring/analytics input, not an audit
//! log. Lagging subscribers drop events (bounded capacity, same tradeoff as
//! `PluginHost::events`); the shell turns the resulting `Lagged` into explicit
//! gap notices rather than leaving consumers to infer drops from `id` gaps.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dbx_types::models::observability::HostObservationEvent;
use tokio::sync::broadcast;

/// Observer registry lives in `dbx-types` so the plugin runtime can register
/// sidecar interest at activation without depending on this crate.
pub use dbx_types::models::observability::ObservationInterest;

/// Capacity for the observation channel. Query/connection events are
/// low-volume; AI deltas are the only burst source and a consumer that falls
/// behind can reconstruct text from the surrounding non-delta events.
pub const HOST_OBSERVATION_CAPACITY: usize = 1024;

/// Hard bound on the number of JSON values a single payload may contain. A
/// payload that exceeds it is replaced by a truncation marker instead of being
/// walked or cloned any further.
const MAX_OBSERVATION_PAYLOAD_NODES: usize = 4096;

/// Nesting bound for the payload backstop walk.
const MAX_OBSERVATION_PAYLOAD_DEPTH: usize = 32;

/// Cheap-to-clone handle stored on `AppState`. All taps share one bus.
#[derive(Clone)]
pub struct HostObservationBus {
    sender: broadcast::Sender<HostObservationEvent>,
    next_id: Arc<AtomicU64>,
    interest: ObservationInterest,
}

impl HostObservationBus {
    pub fn new() -> Self {
        Self {
            sender: broadcast::Sender::new(HOST_OBSERVATION_CAPACITY),
            next_id: Arc::new(AtomicU64::new(0)),
            interest: ObservationInterest::default(),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HostObservationEvent> {
        self.sender.subscribe()
    }

    /// Observer registry this bus publishes against.
    pub fn interest(&self) -> &ObservationInterest {
        &self.interest
    }

    /// Whether an observer asked for events of `kind`'s category AND a
    /// receiver is attached to deliver them. Taps call this before building a
    /// payload, so a category nobody can receive (for example a sidecar that
    /// declared `host.observe:*` in a shell without a bridge) costs nothing;
    /// one atomic load plus a registry lookup. Unregistered kinds report
    /// `false` (fail closed).
    pub fn is_enabled(&self, kind: &str) -> bool {
        match HostObservationEvent::category_for_kind(kind) {
            Some(category) => self.interest.has(category) && self.sender.receiver_count() > 0,
            None => false,
        }
    }

    /// Publish one event. Returns `false` when the event was dropped because
    /// no observer is attached — the fast path taps (every SQL statement,
    /// every AI delta) rely on this to avoid allocating payloads in the common
    /// case.
    pub fn publish(
        &self,
        kind: &str,
        connection_id: Option<String>,
        database: Option<String>,
        mut payload: serde_json::Value,
    ) -> bool {
        // Two independent gates, both inside `is_enabled`: an observer must
        // have registered interest in this category (the bridges keep receivers
        // attached for the whole process, so a receiver count is not evidence
        // of interest), and a receiver must actually be attached to deliver to.
        if !self.is_enabled(kind) {
            return false;
        }
        cap_observation_payload(&mut payload);
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

    /// Number of attached broadcast receivers. Not a measure of observer
    /// interest: the shell bridges hold receivers for the process lifetime.
    /// Use [`Self::is_enabled`] to decide whether a payload is worth building.
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

/// Last-resort size guard applied by [`HostObservationBus::publish`].
///
/// Taps cap the fields they know are text-heavy, but the bus is the one place
/// that sees every event, so it also enforces a bound on its own: every string
/// is truncated to `MAX_OBSERVATION_TEXT_BYTES` (marked `<key>Truncated` on
/// its parent object) and the payload's total value count is bounded. A
/// payload that would exceed the node budget is replaced by an explicit
/// truncation marker, so the result always stays valid JSON and a consumer can
/// tell that content was dropped.
pub fn cap_observation_payload(payload: &mut serde_json::Value) {
    let mut nodes = 0usize;
    if !cap_payload_value(payload, 0, &mut nodes) {
        *payload = serde_json::json!({
            "truncated": true,
            "reason": "payload_too_large",
        });
    }
}

/// Returns `false` when the payload is too large to keep walking.
fn cap_payload_value(value: &mut serde_json::Value, depth: usize, nodes: &mut usize) -> bool {
    *nodes += 1;
    if *nodes > MAX_OBSERVATION_PAYLOAD_NODES {
        return false;
    }
    if depth >= MAX_OBSERVATION_PAYLOAD_DEPTH {
        // Pathological nesting carries no observation value; dropping it keeps
        // both the walk and the consumer bounded.
        *value = serde_json::Value::Null;
        return true;
    }
    match value {
        serde_json::Value::String(_) => {
            cap_payload_string(value);
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                if !cap_payload_value(item, depth + 1, nodes) {
                    return false;
                }
            }
        }
        serde_json::Value::Object(object) => {
            let mut truncated = Vec::new();
            for (key, child) in object.iter_mut() {
                *nodes += 1;
                if *nodes > MAX_OBSERVATION_PAYLOAD_NODES {
                    return false;
                }
                if child.is_string() {
                    if cap_payload_string(child) {
                        truncated.push(key.clone());
                    }
                    continue;
                }
                if !cap_payload_value(child, depth + 1, nodes) {
                    return false;
                }
            }
            // Direct string children get the `<field>Truncated` marker so a
            // consumer can tell a clipped value from the real one.
            for key in truncated {
                object.insert(format!("{key}Truncated"), serde_json::Value::Bool(true));
            }
        }
        _ => {}
    }
    true
}

/// Truncate a JSON string in place; returns whether it was truncated.
fn cap_payload_string(value: &mut serde_json::Value) -> bool {
    let serde_json::Value::String(text) = value else {
        return false;
    };
    // Check the length first: `cap_observation_text` copies the input even when
    // it keeps it, and this runs for every string of every event (AI deltas
    // included), so the common under-limit case must not allocate.
    if text.len() <= dbx_types::models::observability::MAX_OBSERVATION_TEXT_BYTES {
        return false;
    }
    let (capped, truncated) = dbx_types::models::observability::cap_observation_text(text);
    *text = capped;
    truncated
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
    use dbx_types::models::observability::{
        ObservationCategory, KIND_AI_TEXT_DELTA, KIND_PLUGIN_ACTIVATED, KIND_QUERY_STARTED, OBSERVE_AI_PERMISSION,
        OBSERVE_PLUGINS_PERMISSION, OBSERVE_QUERIES_PERMISSION,
    };

    fn observe(bus: &HostObservationBus, owner: &str, permission: &str) {
        bus.interest().acquire(owner, &[permission.to_string()]);
    }

    #[test]
    fn publish_without_subscribers_is_dropped_and_cheap() {
        let bus = HostObservationBus::new();
        assert!(!bus.publish(KIND_QUERY_STARTED, None, None, serde_json::json!({})));
        assert_eq!(bus.subscriber_count(), 0);
    }

    /// The shell bridges hold receivers for the whole process; a receiver alone
    /// must not make publishers build payloads for categories nobody watches.
    #[test]
    fn receivers_without_interest_do_not_enable_publishing() {
        let bus = HostObservationBus::new();
        let _receiver = bus.subscribe();
        assert_eq!(bus.subscriber_count(), 1);
        assert!(!bus.is_enabled(KIND_QUERY_STARTED));
        assert!(!bus.publish(KIND_QUERY_STARTED, None, None, serde_json::json!({})));

        observe(&bus, "ui:1", OBSERVE_QUERIES_PERMISSION);
        assert!(bus.is_enabled(KIND_QUERY_STARTED));
        // Category-level fast path: watching queries does not enable AI events.
        assert!(!bus.is_enabled(KIND_AI_TEXT_DELTA));
    }

    /// A sidecar can register interest in a shell that never attaches a bridge
    /// receiver (web, MCP, CLI); taps must not build payloads nobody can get.
    #[test]
    fn interest_without_a_receiver_does_not_enable_publishing() {
        let bus = HostObservationBus::new();
        observe(&bus, "backend:plugin#1", OBSERVE_QUERIES_PERMISSION);
        assert!(!bus.is_enabled(KIND_QUERY_STARTED));
        assert!(!bus.publish(KIND_QUERY_STARTED, None, None, serde_json::json!({})));

        let _receiver = bus.subscribe();
        assert!(bus.is_enabled(KIND_QUERY_STARTED));
    }

    #[test]
    fn unregistered_kinds_stay_disabled_even_with_interest() {
        let bus = HostObservationBus::new();
        let _receiver = bus.subscribe();
        observe(&bus, "ui:1", OBSERVE_QUERIES_PERMISSION);
        assert!(!bus.is_enabled("query.internal_data"));
        assert!(!bus.publish("query.internal_data", None, None, serde_json::json!({})));
    }

    #[test]
    fn interest_is_refcounted_per_owner_and_released() {
        let bus = HostObservationBus::new();
        let _receiver = bus.subscribe();
        observe(&bus, "ui:1", OBSERVE_QUERIES_PERMISSION);
        observe(&bus, "ui:2", OBSERVE_QUERIES_PERMISSION);
        assert_eq!(bus.interest().count(ObservationCategory::Queries), 2);

        // Acquiring twice for one owner does not double count.
        observe(&bus, "ui:1", OBSERVE_QUERIES_PERMISSION);
        assert_eq!(bus.interest().count(ObservationCategory::Queries), 2);

        bus.interest().release("ui:1");
        assert_eq!(bus.interest().count(ObservationCategory::Queries), 1);
        assert!(bus.is_enabled(KIND_QUERY_STARTED));

        // Releasing an unknown owner is a no-op, never a wrap-around.
        bus.interest().release("ui:unknown");
        bus.interest().release("ui:2");
        assert_eq!(bus.interest().count(ObservationCategory::Queries), 0);
        assert!(!bus.is_enabled(KIND_QUERY_STARTED));
        assert!(bus.interest().is_empty());
    }

    #[test]
    fn interest_can_change_categories_on_acquire() {
        let bus = HostObservationBus::new();
        let _receiver = bus.subscribe();
        observe(&bus, "plugin:observer", OBSERVE_QUERIES_PERMISSION);
        bus.interest()
            .acquire("plugin:observer", &[OBSERVE_AI_PERMISSION.to_string(), OBSERVE_PLUGINS_PERMISSION.to_string()]);
        assert_eq!(bus.interest().count(ObservationCategory::Queries), 0);
        assert_eq!(bus.interest().count(ObservationCategory::Ai), 1);
        assert!(bus.is_enabled(KIND_AI_TEXT_DELTA));
        assert!(bus.is_enabled(KIND_PLUGIN_ACTIVATED));
        assert!(!bus.is_enabled(KIND_QUERY_STARTED));
    }

    #[tokio::test]
    async fn publish_stamps_monotonic_ids_and_delivers() {
        let bus = HostObservationBus::new();
        let mut receiver = bus.subscribe();
        observe(&bus, "ui:1", OBSERVE_QUERIES_PERMISSION);
        observe(&bus, "ui:1-plugin", OBSERVE_PLUGINS_PERMISSION);
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

    /// The bus caps payloads on its own so a tap that forgets a text field
    /// cannot push an unbounded value onto the bus.
    #[tokio::test]
    async fn publish_caps_oversized_strings_at_any_depth() {
        use dbx_types::models::observability::MAX_OBSERVATION_TEXT_BYTES;

        let bus = HostObservationBus::new();
        let mut receiver = bus.subscribe();
        observe(&bus, "ui:1", OBSERVE_QUERIES_PERMISSION);
        let big = "x".repeat(MAX_OBSERVATION_TEXT_BYTES * 4);
        assert!(bus.publish(
            KIND_QUERY_STARTED,
            None,
            None,
            serde_json::json!({
                "delta": big,
                "nested": { "message": big.clone() },
                "items": [{ "text": big }],
            })
        ));
        let payload = receiver.recv().await.unwrap().payload;
        assert!(payload["delta"].as_str().unwrap().len() <= MAX_OBSERVATION_TEXT_BYTES);
        assert_eq!(payload["deltaTruncated"], true);
        assert_eq!(payload["nested"]["messageTruncated"], true);
        assert!(payload["items"][0]["text"].as_str().unwrap().len() <= MAX_OBSERVATION_TEXT_BYTES);
        // Still valid JSON with the shape callers expect.
        assert!(serde_json::to_string(&payload).is_ok());
    }

    #[test]
    fn payload_backstop_replaces_pathologically_large_payloads() {
        let mut payload = serde_json::json!({
            "items": (0..MAX_OBSERVATION_PAYLOAD_NODES + 10).collect::<Vec<_>>(),
        });
        cap_observation_payload(&mut payload);
        assert_eq!(payload["truncated"], true);
        assert_eq!(payload["reason"], "payload_too_large");
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
