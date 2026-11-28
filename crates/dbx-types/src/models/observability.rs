//! Host observation events for the plugin observability bus.
//!
//! Plugins that declare one of the `host.observe:*` permissions receive a
//! stream of structured events describing what the host is doing: SQL
//! execution, connection lifecycle, AI agent activity, data transfers and
//! plugin lifecycle. The bus itself lives in `dbx-core::observability`; this
//! module only defines the wire shape so both shells and the plugin runtime
//! agree on it.
//!
//! Design reference: DBeaver's Query Manager (`org.jkiss.dbeaver.model.qm`)
//! records query/session/transaction lifecycle through fast synchronous
//! handlers and lets listeners consume the resulting event stream. We follow
//! the same split: taps publish non-blockingly at the execution site, and
//! delivery (plugin UI / sidecar / future audit sinks) consumes the stream
//! asynchronously.

use serde::{Deserialize, Serialize};

/// Plugin permissions gating each event category. These strings must match
/// `SUPPORTED_PLUGIN_PERMISSIONS` in `dbx-plugin-runtime` and the enum in
/// `plugins/manifest.schema.json`.
pub const OBSERVE_QUERIES_PERMISSION: &str = "host.observe:queries";
pub const OBSERVE_CONNECTIONS_PERMISSION: &str = "host.observe:connections";
pub const OBSERVE_AI_PERMISSION: &str = "host.observe:ai";
pub const OBSERVE_TRANSFERS_PERMISSION: &str = "host.observe:transfers";
pub const OBSERVE_PLUGINS_PERMISSION: &str = "host.observe:plugins";

/// Every permission that grants access to the observation stream.
pub const OBSERVATION_PERMISSIONS: &[&str] = &[
    OBSERVE_QUERIES_PERMISSION,
    OBSERVE_CONNECTIONS_PERMISSION,
    OBSERVE_AI_PERMISSION,
    OBSERVE_TRANSFERS_PERMISSION,
    OBSERVE_PLUGINS_PERMISSION,
];

// Event kind constants. Every kind must be registered in
// [`OBSERVATION_KINDS`] below: delivery looks kinds up by exact name, so a
// kind that is emitted without registration is dropped (fail closed). Keep
// the registry and the frontend mirror in
// apps/desktop/src/lib/plugins/pluginObservation.ts in sync.
pub const KIND_QUERY_STARTED: &str = "query.started";
pub const KIND_QUERY_FINISHED: &str = "query.finished";
pub const KIND_QUERY_MESSAGE: &str = "query.message";
pub const KIND_CONNECTION_OPENED: &str = "connection.opened";
pub const KIND_CONNECTION_OPEN_FAILED: &str = "connection.open_failed";
pub const KIND_CONNECTION_CLOSED: &str = "connection.closed";
pub const KIND_CONNECTION_LIVENESS_LOST: &str = "connection.liveness_lost";
pub const KIND_CONNECTION_IDLE_CLOSED: &str = "connection.idle_closed";
pub const KIND_AI_TURN_STARTED: &str = "ai.turn_started";
pub const KIND_AI_TURN_ENDED: &str = "ai.turn_ended";
pub const KIND_AI_TEXT_DELTA: &str = "ai.text_delta";
pub const KIND_AI_REASONING_DELTA: &str = "ai.reasoning_delta";
pub const KIND_AI_TOOL_CALL_STARTED: &str = "ai.tool_call_started";
pub const KIND_AI_TOOL_CALL_FINISHED: &str = "ai.tool_call_finished";
pub const KIND_AI_APPROVAL_REQUIRED: &str = "ai.approval_required";
pub const KIND_AI_APPROVAL_RESOLVED: &str = "ai.approval_resolved";
pub const KIND_AI_WRITE_SQL_CONFIRMATION_REQUIRED: &str = "ai.write_sql_confirmation_required";
pub const KIND_AI_PRODUCTION_WRITE_BLOCKED: &str = "ai.production_write_blocked";
pub const KIND_AI_RESPONSE_COMPLETE: &str = "ai.response_complete";
pub const KIND_AI_OUTPUT_TRUNCATED: &str = "ai.output_truncated";
pub const KIND_AI_AGENT_FINISHED: &str = "ai.agent_finished";
pub const KIND_AI_CONTEXT_COMPACTED: &str = "ai.context_compacted";
pub const KIND_AI_ERROR: &str = "ai.error";
pub const KIND_TRANSFER_PROGRESS: &str = "transfer.progress";
pub const KIND_PLUGIN_ACTIVATED: &str = "plugin.activated";
pub const KIND_PLUGIN_ACTIVATE_FAILED: &str = "plugin.activate_failed";
pub const KIND_PLUGIN_STATUS_CHANGED: &str = "plugin.status_changed";
pub const KIND_PLUGIN_STOPPED: &str = "plugin.stopped";

/// High-frequency streaming kinds that are delivered to plugin UIs but are
/// skipped when fanning out to sidecar backends (delta-per-token traffic over
/// stdin is wasteful; subscribers can reconstruct the text from the final
/// payloads and the UI stream).
pub const SIDECAR_SKIPPED_KINDS: &[&str] = &[KIND_AI_TEXT_DELTA, KIND_AI_REASONING_DELTA];

/// Observation categories, one per `host.observe:*` permission. Interest is
/// tracked per category so a plugin that only watches queries does not make
/// the host build AI or transfer payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ObservationCategory {
    Queries,
    Connections,
    Ai,
    Transfers,
    Plugins,
}

impl ObservationCategory {
    pub const ALL: [ObservationCategory; 5] = [
        ObservationCategory::Queries,
        ObservationCategory::Connections,
        ObservationCategory::Ai,
        ObservationCategory::Transfers,
        ObservationCategory::Plugins,
    ];

    pub fn permission(self) -> &'static str {
        match self {
            ObservationCategory::Queries => OBSERVE_QUERIES_PERMISSION,
            ObservationCategory::Connections => OBSERVE_CONNECTIONS_PERMISSION,
            ObservationCategory::Ai => OBSERVE_AI_PERMISSION,
            ObservationCategory::Transfers => OBSERVE_TRANSFERS_PERMISSION,
            ObservationCategory::Plugins => OBSERVE_PLUGINS_PERMISSION,
        }
    }

    /// Dense index for the per-category interest counters.
    pub fn index(self) -> usize {
        self as usize
    }

    pub fn from_permission(permission: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|category| category.permission() == permission)
    }
}

/// One registered observation event kind.
///
/// Registration is the single place that answers "who may see this event and
/// through which transport". Delivery is looked up by exact kind, not by
/// prefix: a new `connection.credentials`-style event cannot inherit the
/// `connection` permission merely by reusing the prefix — it is dropped until
/// it is registered (and thus reviewed) here.
#[derive(Debug, Clone, Copy)]
pub struct ObservationKindDefinition {
    pub kind: &'static str,
    pub category: ObservationCategory,
    /// Whether sidecar backends receive this kind. UI delivery is uncapped.
    pub sidecar: bool,
}

const fn kind(kind: &'static str, category: ObservationCategory) -> ObservationKindDefinition {
    ObservationKindDefinition { kind, category, sidecar: true }
}

const fn ui_only(kind: &'static str, category: ObservationCategory) -> ObservationKindDefinition {
    ObservationKindDefinition { kind, category, sidecar: false }
}

/// Every event kind the host can publish. See [`ObservationKindDefinition`].
pub const OBSERVATION_KINDS: &[ObservationKindDefinition] = &[
    kind(KIND_QUERY_STARTED, ObservationCategory::Queries),
    kind(KIND_QUERY_FINISHED, ObservationCategory::Queries),
    kind(KIND_QUERY_MESSAGE, ObservationCategory::Queries),
    kind(KIND_CONNECTION_OPENED, ObservationCategory::Connections),
    kind(KIND_CONNECTION_OPEN_FAILED, ObservationCategory::Connections),
    kind(KIND_CONNECTION_CLOSED, ObservationCategory::Connections),
    kind(KIND_CONNECTION_LIVENESS_LOST, ObservationCategory::Connections),
    kind(KIND_CONNECTION_IDLE_CLOSED, ObservationCategory::Connections),
    kind(KIND_AI_TURN_STARTED, ObservationCategory::Ai),
    kind(KIND_AI_TURN_ENDED, ObservationCategory::Ai),
    ui_only(KIND_AI_TEXT_DELTA, ObservationCategory::Ai),
    ui_only(KIND_AI_REASONING_DELTA, ObservationCategory::Ai),
    kind(KIND_AI_TOOL_CALL_STARTED, ObservationCategory::Ai),
    kind(KIND_AI_TOOL_CALL_FINISHED, ObservationCategory::Ai),
    kind(KIND_AI_APPROVAL_REQUIRED, ObservationCategory::Ai),
    kind(KIND_AI_APPROVAL_RESOLVED, ObservationCategory::Ai),
    kind(KIND_AI_WRITE_SQL_CONFIRMATION_REQUIRED, ObservationCategory::Ai),
    kind(KIND_AI_PRODUCTION_WRITE_BLOCKED, ObservationCategory::Ai),
    kind(KIND_AI_RESPONSE_COMPLETE, ObservationCategory::Ai),
    kind(KIND_AI_OUTPUT_TRUNCATED, ObservationCategory::Ai),
    kind(KIND_AI_AGENT_FINISHED, ObservationCategory::Ai),
    kind(KIND_AI_CONTEXT_COMPACTED, ObservationCategory::Ai),
    kind(KIND_AI_ERROR, ObservationCategory::Ai),
    kind(KIND_TRANSFER_PROGRESS, ObservationCategory::Transfers),
    kind(KIND_PLUGIN_ACTIVATED, ObservationCategory::Plugins),
    kind(KIND_PLUGIN_ACTIVATE_FAILED, ObservationCategory::Plugins),
    kind(KIND_PLUGIN_STATUS_CHANGED, ObservationCategory::Plugins),
    kind(KIND_PLUGIN_STOPPED, ObservationCategory::Plugins),
];

/// Registry entry for `kind`, if it is registered.
pub fn observation_definition(kind: &str) -> Option<&'static ObservationKindDefinition> {
    OBSERVATION_KINDS.iter().find(|definition| definition.kind == kind)
}

/// Who is currently asking for host observations, per category.
///
/// Attaching a `broadcast::Receiver` is not evidence of interest: the shell's
/// UI and sidecar bridges stay attached for the whole process lifetime. The
/// real observers are the plugin UIs whose workbench declared a
/// `host.observe:*` permission and the running sidecars that declared one, and
/// those register themselves here while they are alive. Publishing is gated on
/// this registry, so a host with no observer never builds payloads.
#[derive(Clone, Default)]
pub struct ObservationInterest {
    inner: std::sync::Arc<InterestInner>,
}

#[derive(Default)]
struct InterestInner {
    counts: [std::sync::atomic::AtomicUsize; ObservationCategory::ALL.len()],
    owners: std::sync::Mutex<std::collections::HashMap<String, Vec<ObservationCategory>>>,
}

impl ObservationInterest {
    /// Record the categories `owner` is interested in (idempotent per owner).
    /// `permissions` are permission strings, e.g. `host.observe:queries`.
    /// Returns the categories that gained their first observer.
    pub fn acquire(&self, owner: &str, permissions: &[String]) -> Vec<ObservationCategory> {
        self.set(owner, categories_for_permissions(permissions))
    }

    /// Drop `owner`'s interest. Unknown owners are a no-op.
    pub fn release(&self, owner: &str) {
        self.set(owner, Vec::new());
    }

    /// Drop every owner whose id starts with `prefix`. Returns how many
    /// owners were removed.
    ///
    /// A workbench registers interest from a renderer, and a renderer can
    /// disappear without running its unmount path (window teardown, WebView2
    /// renderer crash and reload). The shell scopes UI owners by window label
    /// and calls this on teardown, otherwise a dead renderer's interest would
    /// keep the fast path disabled for the rest of the process lifetime.
    pub fn release_prefix(&self, prefix: &str) -> usize {
        let mut owners = self.inner.owners.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let stale: Vec<String> = owners.keys().filter(|owner| owner.starts_with(prefix)).cloned().collect();
        for owner in &stale {
            if let Some(categories) = owners.remove(owner) {
                self.decrement(&categories);
            }
        }
        stale.len()
    }

    pub fn has(&self, category: ObservationCategory) -> bool {
        self.count(category) > 0
    }

    /// Whether any observer is attached at all.
    pub fn is_empty(&self) -> bool {
        ObservationCategory::ALL.into_iter().all(|category| !self.has(category))
    }

    /// Number of observers for one category (tests and diagnostics).
    pub fn count(&self, category: ObservationCategory) -> usize {
        self.inner.counts[category.index()].load(std::sync::atomic::Ordering::Relaxed)
    }

    fn set(&self, owner: &str, categories: Vec<ObservationCategory>) -> Vec<ObservationCategory> {
        use std::sync::atomic::Ordering;
        let mut owners = self.inner.owners.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = (if categories.is_empty() {
            owners.remove(owner)
        } else {
            owners.insert(owner.to_string(), categories.clone())
        })
        .unwrap_or_default();
        let mut gained = Vec::new();
        for category in &categories {
            if !previous.contains(category) {
                self.inner.counts[category.index()].fetch_add(1, Ordering::Relaxed);
                gained.push(*category);
            }
        }
        let lost: Vec<ObservationCategory> =
            previous.iter().copied().filter(|category| !categories.contains(category)).collect();
        self.decrement(&lost);
        gained
    }

    /// Release one reference per listed category. Callers hold the owners lock,
    /// so a removed owner can never be counted twice.
    fn decrement(&self, categories: &[ObservationCategory]) {
        use std::sync::atomic::Ordering;
        for category in categories {
            // Saturating: a stale double release must not wrap the counter.
            let _ = self.inner.counts[category.index()]
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| Some(count.saturating_sub(1)));
        }
    }
}

fn categories_for_permissions(permissions: &[String]) -> Vec<ObservationCategory> {
    let mut categories = Vec::new();
    for permission in permissions {
        if let Some(category) = ObservationCategory::from_permission(permission) {
            if !categories.contains(&category) {
                categories.push(category);
            }
        }
    }
    categories
}

/// One event on the host observation bus.
///
/// The envelope is intentionally generic (`payload` stays a JSON object) so
/// new kinds can be added additively without changing the envelope. `id` is
/// monotonically increasing per host process and `tsMs` is wall-clock epoch
/// milliseconds, which lets consumers detect drops (id gaps) and order events
/// across transports.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostObservationEvent {
    pub id: u64,
    pub ts_ms: u64,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    pub payload: serde_json::Value,
}

impl HostObservationEvent {
    /// Category of `kind`, if it is registered in [`OBSERVATION_KINDS`].
    pub fn category_for_kind(kind: &str) -> Option<ObservationCategory> {
        observation_definition(kind).map(|definition| definition.category)
    }

    /// Map a kind to the permission that gates it. Unknown or unregistered
    /// kinds return `None`; delivery layers must drop them (fail closed) so a
    /// future kind that forgets its registration cannot leak through an
    /// unrelated permission.
    pub fn permission_for_kind(kind: &str) -> Option<&'static str> {
        Self::category_for_kind(kind).map(ObservationCategory::permission)
    }

    /// Whether this kind is delivered to sidecar backends. Delta streams are
    /// UI-only; see `SIDECAR_SKIPPED_KINDS`.
    pub fn is_delivered_to_sidecar(&self) -> bool {
        observation_definition(&self.kind).is_some_and(|definition| definition.sidecar)
    }
}

/// Cap for text fields embedded in observation payloads (SQL text, tool args,
/// tool results, AI deltas, error messages). Keeps a single pathological
/// statement from bloating the bounded broadcast channel or a sidecar's stdin.
/// Truncation is marked with a `<field>Truncated: true` sibling by the
/// publishing tap, and the bus applies the same cap to every string it sees.
pub const MAX_OBSERVATION_TEXT_BYTES: usize = 16 * 1024;

/// Truncate `text` to at most [`MAX_OBSERVATION_TEXT_BYTES`] bytes on a UTF-8
/// boundary, including the trailing `…` marker, so re-capping an already
/// capped value is a no-op. Returns the (possibly truncated) text and whether
/// truncation happened.
pub fn cap_observation_text(text: &str) -> (String, bool) {
    if text.len() <= MAX_OBSERVATION_TEXT_BYTES {
        return (text.to_string(), false);
    }
    // Reserve room for the marker: 3 bytes of UTF-8 for `…`.
    const MARKER: &str = "…";
    let mut end = MAX_OBSERVATION_TEXT_BYTES - MARKER.len();
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}{MARKER}", &text[..end]), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_mapping_uses_the_registry_and_fails_closed() {
        for (kind, permission) in [
            (KIND_QUERY_STARTED, OBSERVE_QUERIES_PERMISSION),
            (KIND_QUERY_MESSAGE, OBSERVE_QUERIES_PERMISSION),
            (KIND_CONNECTION_OPENED, OBSERVE_CONNECTIONS_PERMISSION),
            (KIND_AI_TOOL_CALL_STARTED, OBSERVE_AI_PERMISSION),
            (KIND_TRANSFER_PROGRESS, OBSERVE_TRANSFERS_PERMISSION),
            (KIND_PLUGIN_ACTIVATED, OBSERVE_PLUGINS_PERMISSION),
        ] {
            assert_eq!(HostObservationEvent::permission_for_kind(kind), Some(permission), "{kind}");
        }
        assert_eq!(HostObservationEvent::permission_for_kind("unknown.kind"), None);
        assert_eq!(HostObservationEvent::permission_for_kind(""), None);
        // A known prefix is not enough: only registered kinds are delivered.
        assert_eq!(HostObservationEvent::permission_for_kind("query.internal_data"), None);
        assert_eq!(HostObservationEvent::permission_for_kind("connection.credentials"), None);
        assert_eq!(HostObservationEvent::category_for_kind("ai.internal_context"), None);
    }

    /// Every kind constant must be registered, so a new event cannot be
    /// silently dropped by delivery (or silently inherit a category).
    #[test]
    fn every_kind_constant_is_registered() {
        for kind in [
            KIND_QUERY_STARTED,
            KIND_QUERY_FINISHED,
            KIND_QUERY_MESSAGE,
            KIND_CONNECTION_OPENED,
            KIND_CONNECTION_OPEN_FAILED,
            KIND_CONNECTION_CLOSED,
            KIND_CONNECTION_LIVENESS_LOST,
            KIND_CONNECTION_IDLE_CLOSED,
            KIND_AI_TURN_STARTED,
            KIND_AI_TURN_ENDED,
            KIND_AI_TEXT_DELTA,
            KIND_AI_REASONING_DELTA,
            KIND_AI_TOOL_CALL_STARTED,
            KIND_AI_TOOL_CALL_FINISHED,
            KIND_AI_APPROVAL_REQUIRED,
            KIND_AI_APPROVAL_RESOLVED,
            KIND_AI_WRITE_SQL_CONFIRMATION_REQUIRED,
            KIND_AI_PRODUCTION_WRITE_BLOCKED,
            KIND_AI_RESPONSE_COMPLETE,
            KIND_AI_OUTPUT_TRUNCATED,
            KIND_AI_AGENT_FINISHED,
            KIND_AI_CONTEXT_COMPACTED,
            KIND_AI_ERROR,
            KIND_TRANSFER_PROGRESS,
            KIND_PLUGIN_ACTIVATED,
            KIND_PLUGIN_ACTIVATE_FAILED,
            KIND_PLUGIN_STATUS_CHANGED,
            KIND_PLUGIN_STOPPED,
        ] {
            assert!(observation_definition(kind).is_some(), "{kind} is emitted but not registered");
        }
        for category in ObservationCategory::ALL {
            assert!(
                OBSERVATION_KINDS.iter().any(|definition| definition.category == category),
                "{:?} has no registered kinds",
                category
            );
        }
    }

    #[test]
    fn sidecar_flags_match_the_skip_list() {
        for definition in OBSERVATION_KINDS {
            let skipped = SIDECAR_SKIPPED_KINDS.contains(&definition.kind);
            assert_eq!(definition.sidecar, !skipped, "{}", definition.kind);
        }
    }

    /// Owners are refcounted per category, and a prefix release removes exactly
    /// the matching owners (a renderer that never ran its unmount path).
    #[test]
    fn interest_is_refcounted_and_prefix_release_is_scoped() {
        let interest = ObservationInterest::default();
        interest.acquire("ui:main:1", &[OBSERVE_QUERIES_PERMISSION.to_string()]);
        interest.acquire("ui:main:2", &[OBSERVE_QUERIES_PERMISSION.to_string()]);
        interest.acquire("backend:plugin#1", &[OBSERVE_QUERIES_PERMISSION.to_string()]);
        assert_eq!(interest.count(ObservationCategory::Queries), 3);

        // Re-acquiring one owner is idempotent, and dropping a category it no
        // longer wants releases just that reference.
        interest.acquire("ui:main:1", &[OBSERVE_QUERIES_PERMISSION.to_string()]);
        assert_eq!(interest.count(ObservationCategory::Queries), 3);
        interest.acquire("ui:main:1", &[OBSERVE_AI_PERMISSION.to_string()]);
        assert_eq!(interest.count(ObservationCategory::Queries), 2);
        assert_eq!(interest.count(ObservationCategory::Ai), 1);

        assert_eq!(interest.release_prefix("ui:main:"), 2);
        assert_eq!(interest.count(ObservationCategory::Queries), 1);
        assert_eq!(interest.count(ObservationCategory::Ai), 0);
        assert!(!interest.is_empty(), "the backend owner must survive a UI prefix release");

        interest.release_prefix("ui:main:");
        interest.release("backend:plugin#1");
        assert!(interest.is_empty());
        // A stale double release must not wrap the counter.
        interest.release("backend:plugin#1");
        assert_eq!(interest.count(ObservationCategory::Queries), 0);
    }

    #[test]
    fn event_serializes_camel_case_and_skips_empty_context() {
        let event = HostObservationEvent {
            id: 7,
            ts_ms: 123,
            kind: KIND_QUERY_STARTED.into(),
            connection_id: Some("c1".into()),
            database: None,
            payload: serde_json::json!({ "sql": "select 1" }),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["id"], 7);
        assert_eq!(value["tsMs"], 123);
        assert_eq!(value["connectionId"], "c1");
        assert!(value.get("database").is_none());
    }

    #[test]
    fn cap_text_truncates_on_char_boundary_and_marks() {
        let (short, truncated) = cap_observation_text("select 1");
        assert_eq!(short, "select 1");
        assert!(!truncated);

        let big = "a".repeat(MAX_OBSERVATION_TEXT_BYTES + 10);
        let (capped, truncated) = cap_observation_text(&big);
        assert!(truncated);
        // The result never exceeds the advertised cap (marker included), so a
        // second pass over it is a no-op: taps cap some fields and the bus caps
        // every string, and double truncation must not grow the payload.
        assert!(capped.len() <= MAX_OBSERVATION_TEXT_BYTES);
        assert!(!cap_observation_text(&capped).1);
        assert_eq!(cap_observation_text(&capped).0, capped);

        // Multi-byte boundary: truncating inside a char must not panic.
        let wide = "数".repeat(MAX_OBSERVATION_TEXT_BYTES);
        let (capped, truncated) = cap_observation_text(&wide);
        assert!(truncated);
        assert!(capped.ends_with('…'));
        assert!(capped.len() <= MAX_OBSERVATION_TEXT_BYTES);
    }

    #[test]
    fn delta_kinds_are_ui_only() {
        let delta = HostObservationEvent {
            id: 1,
            ts_ms: 0,
            kind: KIND_AI_TEXT_DELTA.into(),
            connection_id: None,
            database: None,
            payload: serde_json::json!({ "delta": "x" }),
        };
        assert!(!delta.is_delivered_to_sidecar());
        let tool = HostObservationEvent { kind: KIND_AI_TOOL_CALL_STARTED.into(), ..delta };
        assert!(tool.is_delivered_to_sidecar());
    }
}
