#![cfg(feature = "test-support")]

use dbx_core::history::{HistoryEntry, HistorySearchRequest};
use dbx_core::persistence::test_storage;
use serde_json::json;

#[tokio::test]
async fn diagnostic_evidence_survives_storage_reopen_without_sql_or_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("dbx.db");
    let storage = test_storage::open(&path).await.unwrap();
    let evidence = json!({
        "format": "dbx-runtime-diagnostic-v1", "engineVersion": "19.23.0.0.0",
        "target": { "sqlId": "0123456789abc", "instanceId": "2", "childNumber": "1" },
        "metrics": [{ "name": "elapsed", "value": "4500", "unit": "microseconds", "scope": "cursor_cumulative", "source": "GV$SQL.ELAPSED_TIME" }],
        "status": "collected"
    });
    let entry: HistoryEntry = serde_json::from_value(json!({
        "id": "diagnostic-1", "connection_id": "dedicated", "connection_name": "Dedicated",
        "database": "PDB1", "sql": "", "executed_at": "2026-10-09T10:00:00Z",
        "execution_time_ms": 0, "success": true, "error": null,
        "source": "other", "activity_kind": "query", "operation": "runtime_diagnostic",
        "target": "0123456789abc", "details_json": evidence.to_string()
    })).unwrap();
    storage.save_history_entry(&entry).await.unwrap();
    drop(storage);
    let reopened = test_storage::open(&path).await.unwrap();
    let page = reopened.search_history_entries(HistorySearchRequest { source: Some("other".into()), limit: 100, ..Default::default() }).await.unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].sql, "");
    assert_eq!(page.entries[0].operation, "runtime_diagnostic");
    assert_eq!(serde_json::from_str::<serde_json::Value>(page.entries[0].details_json.as_ref().unwrap()).unwrap(), evidence);
}
