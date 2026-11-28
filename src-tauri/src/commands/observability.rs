//! Helpers that mirror transfer/import/export progress onto the host
//! observation bus (`transfer.progress`).
//!
//! This is the desktop shell half of the observability feature. Progress
//! producers in dbx-core stay shell-agnostic; each command that already emits
//! a Tauri progress event also calls [`publish_transfer_progress`], so plugins
//! with `host.observe:transfers` see the same stream without polling. The
//! dbx-web shell parity is a follow-up.

use serde::Serialize;
use serde_json::Map;

use crate::commands::connection::AppState;

/// Fields a `transfer.progress` observer may see: ids, state, counters,
/// timings and object names.
///
/// This is an allow-list on purpose. Progress structs are shaped for the
/// desktop UI and carry content that a `host.observe:transfers` plugin must
/// not read: `statementSummary` (raw SQL from SQL files), `error` /
/// `errorMessage` (driver text that can quote statements or values),
/// `errorRows` / `failures` (imported row payloads), `filePath` (local paths)
/// and the Oracle package previews (routine source). Default-deny also means a
/// field added to a progress struct later stays hidden until it is reviewed
/// and added here.
const TRANSFER_PROGRESS_FIELDS: &[&str] = &[
    // Correlation and state.
    "taskId",
    "transferId",
    "exportId",
    "importId",
    "executionId",
    "status",
    "phase",
    "preparing",
    "success",
    "warnings",
    "terminal",
    // Object names are metadata, not row or statement content.
    "table",
    "tableName",
    "currentObject",
    "collection",
    "fileName",
    "fileIndex",
    // Progress counters.
    "tableIndex",
    "totalTables",
    "rowsTransferred",
    "totalRows",
    "objectIndex",
    "totalObjects",
    "rowsExported",
    "rowsImported",
    "rowsRead",
    "rowsInserted",
    "rowsFailed",
    "batchesCommitted",
    "documentsRead",
    "documentsWritten",
    "documentsFailed",
    "documentsValidated",
    "collectionsDone",
    "collectionsTotal",
    "indexesCreated",
    "statementIndex",
    "successCount",
    "failureCount",
    "affectedRows",
    "bytesRead",
    "totalBytes",
    "bytesWritten",
    "bytesProcessed",
    "totalRowsExact",
    "failuresTruncated",
    "errorCount",
    // Timings.
    "elapsedMs",
    "elapsedSeconds",
];

/// Publish one progress snapshot.
///
/// `task_kind` distinguishes the feature (`transfer`, `database-export`,
/// `table-import`, ...); `task_id` is the same id the desktop UI uses to
/// correlate progress events and journals. Only the fields in
/// [`TRANSFER_PROGRESS_FIELDS`] are published; everything else is dropped
/// before the event reaches the bus.
pub fn publish_transfer_progress<T: Serialize>(state: &AppState, task_kind: &str, task_id: &str, progress: &T) {
    if !state.host_observations.is_enabled(dbx_core::models::observability::KIND_TRANSFER_PROGRESS) {
        return;
    }
    let Ok(serde_json::Value::Object(fields)) = serde_json::to_value(progress) else {
        return;
    };
    let mut payload = Map::with_capacity(fields.len());
    for (name, value) in fields {
        if TRANSFER_PROGRESS_FIELDS.contains(&name.as_str()) {
            payload.insert(name, value);
        }
    }
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

    async fn state_with_bus() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().expect("temp dir");
        let storage =
            dbx_core::persistence::test_storage::open(&dir.path().join("storage.db")).await.expect("open test storage");
        let state = AppState::new_with_plugin_dir(storage, dir.path().join("plugins"));
        (dir, state)
    }

    #[tokio::test]
    async fn transfer_progress_payload_is_annotated_and_delivered() {
        let (_dir, state) = state_with_bus().await;
        state
            .host_observations
            .interest()
            .acquire("test", &[dbx_core::models::observability::OBSERVE_TRANSFERS_PERMISSION.to_string()]);
        let mut receiver = state.host_observations.subscribe();

        let progress = serde_json::json!({ "transferId": "t1", "rowsTransferred": 3 });
        publish_transfer_progress(&state, "transfer", "t1", &progress);

        let event = receiver.recv().await.expect("transfer.progress event");
        assert_eq!(event.kind, dbx_core::models::observability::KIND_TRANSFER_PROGRESS);
        assert_eq!(event.payload["taskKind"], "transfer");
        assert_eq!(event.payload["taskId"], "t1");
        assert_eq!(event.payload["transferId"], "t1");
        assert_eq!(event.payload["rowsTransferred"], 3);
    }

    /// A plugin holding only `host.observe:transfers` must not learn SQL text,
    /// driver error strings, row payloads or local file paths from a SQL file
    /// run; those fields exist in `SqlFileProgress` and stay UI-only.
    #[tokio::test]
    async fn sql_file_progress_does_not_leak_statement_text_or_errors() {
        let (_dir, state) = state_with_bus().await;
        state
            .host_observations
            .interest()
            .acquire("test", &[dbx_core::models::observability::OBSERVE_TRANSFERS_PERMISSION.to_string()]);
        let mut receiver = state.host_observations.subscribe();

        let progress = serde_json::json!({
            "executionId": "exec-1",
            "status": "statementFailed",
            "statementIndex": 4,
            "successCount": 3,
            "failureCount": 1,
            "affectedRows": 12,
            "elapsedMs": 900,
            "statementSummary": "INSERT INTO users VALUES ('alice', 'secret-token')",
            "error": "syntax error near 'secret-token'",
            "fileName": "seed.sql",
            "fileIndex": 0,
            "phase": "executing",
        });
        publish_transfer_progress(&state, "sql-file", "exec-1", &progress);

        let payload = receiver.recv().await.expect("transfer.progress event").payload;
        assert_eq!(payload["taskKind"], "sql-file");
        assert_eq!(payload["executionId"], "exec-1");
        assert_eq!(payload["statementIndex"], 4);
        assert_eq!(payload["successCount"], 3);
        assert_eq!(payload["affectedRows"], 12);
        assert_eq!(payload["fileName"], "seed.sql");
        assert_eq!(payload["phase"], "executing");
        assert!(payload.get("statementSummary").is_none(), "SQL text must not be published");
        assert!(payload.get("error").is_none(), "driver error text must not be published");
    }

    /// Fields outside the allow-list are dropped by default, so a field added
    /// to a progress struct later cannot leak without review.
    #[tokio::test]
    async fn unlisted_progress_fields_are_dropped_by_default() {
        let (_dir, state) = state_with_bus().await;
        state
            .host_observations
            .interest()
            .acquire("test", &[dbx_core::models::observability::OBSERVE_TRANSFERS_PERMISSION.to_string()]);
        let mut receiver = state.host_observations.subscribe();

        let progress = serde_json::json!({
            "exportId": "e1",
            "rowsExported": 7,
            "errorRows": [{ "document": { "ssn": "000-00-0000" } }],
            "failures": [{ "row": "alice,secret" }],
            "filePath": "/home/user/private/export.sql",
            "oraclePackageApproval": { "source": "CREATE OR REPLACE PACKAGE ..." },
        });
        publish_transfer_progress(&state, "mongo-import", "e1", &progress);

        let payload = receiver.recv().await.expect("transfer.progress event").payload;
        assert_eq!(payload["exportId"], "e1");
        assert_eq!(payload["rowsExported"], 7);
        for hidden in ["errorRows", "failures", "filePath", "oraclePackageApproval"] {
            assert!(payload.get(hidden).is_none(), "{hidden} must be dropped by default");
        }
    }

    #[test]
    fn transfer_progress_is_dropped_without_subscribers() {
        let bus = dbx_core::observability::HostObservationBus::new();
        // Mirrors the AppState fast path: no observer, no allocation.
        assert_eq!(bus.subscriber_count(), 0);
        assert!(!bus.publish(
            dbx_core::models::observability::KIND_TRANSFER_PROGRESS,
            None,
            None,
            serde_json::json!({})
        ));
    }

    /// A receiver alone (the shell bridges hold one for the process lifetime)
    /// must not turn the transfer tap back on.
    #[test]
    fn transfer_progress_stays_off_with_a_receiver_but_no_interest() {
        let bus = dbx_core::observability::HostObservationBus::new();
        let _receiver = bus.subscribe();
        assert!(!bus.is_enabled(dbx_core::models::observability::KIND_TRANSFER_PROGRESS));
        bus.interest().acquire("test", &[dbx_core::models::observability::OBSERVE_TRANSFERS_PERMISSION.to_string()]);
        assert!(bus.is_enabled(dbx_core::models::observability::KIND_TRANSFER_PROGRESS));
    }
}
