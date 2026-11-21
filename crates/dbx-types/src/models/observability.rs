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

// Event kind constants. The `kind` prefix (before the first `.`) selects the
// permission; keep `observation_permission_for_kind` and the frontend mirror
// in apps/desktop/src/lib/plugins/pluginObservation.ts in sync.
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
    /// Map a kind to the permission that gates it. Unknown kinds return
    /// `None`; delivery layers must drop them (fail closed) so a future kind
    /// that forgets its mapping cannot leak through an unrelated permission.
    pub fn permission_for_kind(kind: &str) -> Option<&'static str> {
        match kind.split('.').next()? {
            "query" => Some(OBSERVE_QUERIES_PERMISSION),
            "connection" => Some(OBSERVE_CONNECTIONS_PERMISSION),
            "ai" => Some(OBSERVE_AI_PERMISSION),
            "transfer" => Some(OBSERVE_TRANSFERS_PERMISSION),
            "plugin" => Some(OBSERVE_PLUGINS_PERMISSION),
            _ => None,
        }
    }

    /// Whether this kind is delivered to sidecar backends. Delta streams are
    /// UI-only; see `SIDECAR_SKIPPED_KINDS`.
    pub fn is_delivered_to_sidecar(&self) -> bool {
        !SIDECAR_SKIPPED_KINDS.contains(&self.kind.as_str())
    }
}

/// Cap for text fields embedded in observation payloads (SQL text, tool args,
/// tool results). Keeps a single pathological statement from bloating the
/// bounded broadcast channel or a sidecar's stdin. Truncation is marked with
/// `truncated: true` inside the payload by the publishing tap.
pub const MAX_OBSERVATION_TEXT_BYTES: usize = 16 * 1024;

/// Truncate `text` to `MAX_OBSERVATION_TEXT_BYTES` on a UTF-8 boundary.
/// Returns the (possibly truncated) text and whether truncation happened.
pub fn cap_observation_text(text: &str) -> (String, bool) {
    if text.len() <= MAX_OBSERVATION_TEXT_BYTES {
        return (text.to_string(), false);
    }
    let mut end = MAX_OBSERVATION_TEXT_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}…", &text[..end]), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_mapping_is_prefix_based_and_fails_closed() {
        for (kind, permission) in [
            ("query.started", OBSERVE_QUERIES_PERMISSION),
            ("query.message", OBSERVE_QUERIES_PERMISSION),
            ("connection.opened", OBSERVE_CONNECTIONS_PERMISSION),
            ("ai.tool_call_started", OBSERVE_AI_PERMISSION),
            ("transfer.progress", OBSERVE_TRANSFERS_PERMISSION),
            ("plugin.activated", OBSERVE_PLUGINS_PERMISSION),
        ] {
            assert_eq!(HostObservationEvent::permission_for_kind(kind), Some(permission), "{kind}");
        }
        assert_eq!(HostObservationEvent::permission_for_kind("unknown.kind"), None);
        assert_eq!(HostObservationEvent::permission_for_kind(""), None);
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
        assert!(capped.len() <= MAX_OBSERVATION_TEXT_BYTES + 4);

        // Multi-byte boundary: truncating inside a char must not panic.
        let wide = "数".repeat(MAX_OBSERVATION_TEXT_BYTES);
        let (capped, truncated) = cap_observation_text(&wide);
        assert!(truncated);
        assert!(capped.ends_with('…'));
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
