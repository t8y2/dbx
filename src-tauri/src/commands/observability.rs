//! Helpers that mirror transfer/import/export progress onto the host
//! observation bus (`transfer.progress`).
//!
//! This is the desktop shell half of the observability feature. Progress
//! producers in dbx-core stay shell-agnostic; each command that already emits
//! a Tauri progress event also calls [`publish_transfer_progress`], so plugins
//! with `host.observe:transfers` see the same stream without polling. The
//! dbx-web shell parity is a follow-up.

use serde::Serialize;

use crate::commands::connection::AppState;

/// Publish one progress snapshot.
///
/// `task_kind` distinguishes the feature (`transfer`, `database-export`,
/// `table-import`, ...); `task_id` is the same id the desktop UI uses to
/// correlate progress events and journals. The progress struct itself is
/// serialized verbatim so new fields reach observers without code changes.
pub fn publish_transfer_progress<T: Serialize>(state: &AppState, task_kind: &str, task_id: &str, progress: &T) {
    if state.host_observations.subscriber_count() == 0 {
        return;
    }
    let Ok(serde_json::Value::Object(mut payload)) = serde_json::to_value(progress) else {
        return;
    };
    payload.insert("taskKind".to_string(), serde_json::Value::String(task_kind.to_string()));
    payload.insert("taskId".to_string(), serde_json::Value::String(task_id.to_string()));
    state.host_observations.publish(
        dbx_core::models::observability::KIND_TRANSFER_PROGRESS,
        None,
        None,
        serde_json::Value::Object(payload),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::connection::AppState;

    #[tokio::test]
    async fn transfer_progress_payload_is_annotated_and_delivered() {
        let dir = tempfile::tempdir().expect("temp dir");
        let storage =
            dbx_core::persistence::test_storage::open(&dir.path().join("storage.db")).await.expect("open test storage");
        let state = AppState::new_with_plugin_dir(storage, dir.path().join("plugins"));
        let mut receiver = state.host_observations.subscribe();

        let progress = serde_json::json!({ "transferId": "t1", "rowsTransferred": 3 });
        publish_transfer_progress(&state, "transfer", "t1", &progress);

        let event = receiver.recv().await.expect("transfer.progress event");
        assert_eq!(event.kind, dbx_core::models::observability::KIND_TRANSFER_PROGRESS);
        assert_eq!(event.payload["taskKind"], "transfer");
        assert_eq!(event.payload["taskId"], "t1");
        // The progress struct itself rides along verbatim.
        assert_eq!(event.payload["transferId"], "t1");
        assert_eq!(event.payload["rowsTransferred"], 3);
    }

    #[test]
    fn transfer_progress_is_dropped_without_subscribers() {
        let bus = dbx_core::observability::HostObservationBus::new();
        // Mirrors the AppState fast path: no subscriber, no allocation.
        assert_eq!(bus.subscriber_count(), 0);
        assert!(!bus.publish(
            dbx_core::models::observability::KIND_TRANSFER_PROGRESS,
            None,
            None,
            serde_json::json!({})
        ));
    }
}
