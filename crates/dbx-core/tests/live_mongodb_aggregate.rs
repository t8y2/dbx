//! Live MongoDB aggregate regressions.
//!
//! Run with a writable server:
//! ```text
//! DBX_LIVE_MONGODB_URL='mongodb://127.0.0.1:27017' \
//!   cargo test -p dbx-core --test live_mongodb_aggregate -- --ignored --nocapture
//! ```
//!
//! `aggregate_with_small_batch_size_reads_multiple_cursor_batches` is the session/getMore
//! guard: `cursor.batchSize: 1` forces multiple batches; a broken session fails or truncates.

use std::time::Duration;

use dbx_core::db::mongo_driver;

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_URL pointing at a writable MongoDB database"]
async fn aggregate_with_small_batch_size_reads_multiple_cursor_batches() {
    let url = std::env::var("DBX_LIVE_MONGODB_URL").expect("DBX_LIVE_MONGODB_URL");
    let client = mongo_driver::connect(&url, Duration::from_secs(10), Duration::from_secs(60)).await.unwrap();
    let database = "dbx_live_aggregate";
    let collection = format!("batch_pages_{}", std::process::id());

    let docs: Vec<serde_json::Value> =
        (0..5).map(|n| serde_json::json!({ "n": n, "label": format!("row-{n}") })).collect();
    mongo_driver::insert_documents(&client, database, &collection, &serde_json::to_string(&docs).unwrap())
        .await
        .unwrap();

    // batchSize:1 forces firstBatch + multiple getMore round-trips. Those getMore calls must share
    // the driver's cursor session (run_cursor_command), or pagination fails / returns partial data.
    let result = mongo_driver::aggregate_documents(
        &client,
        database,
        &collection,
        r#"[{"$sort":{"n":1}},{"$project":{"_id":0,"n":1,"label":1}}]"#,
        Some(10),
        Some(r#"{"allowDiskUse":true,"cursor":{"batchSize":1}}"#),
    )
    .await
    .unwrap();

    assert_eq!(result.total, 5, "expected all rows across multiple cursor batches: {:?}", result.documents);
    let numbers: Vec<i64> = result
        .documents
        .iter()
        .map(|doc| doc["n"].as_i64().or_else(|| doc["n"].as_u64().map(|v| v as i64)).expect("n"))
        .collect();
    assert_eq!(numbers, vec![0, 1, 2, 3, 4]);

    mongo_driver::drop_collection(&client, database, &collection).await.unwrap();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_URL pointing at a writable MongoDB database"]
async fn aggregate_with_options_respects_max_rows_across_batches() {
    let url = std::env::var("DBX_LIVE_MONGODB_URL").expect("DBX_LIVE_MONGODB_URL");
    let client = mongo_driver::connect(&url, Duration::from_secs(10), Duration::from_secs(60)).await.unwrap();
    let database = "dbx_live_aggregate";
    let collection = format!("batch_limit_{}", std::process::id());

    let docs: Vec<serde_json::Value> = (0..8).map(|n| serde_json::json!({ "n": n })).collect();
    mongo_driver::insert_documents(&client, database, &collection, &serde_json::to_string(&docs).unwrap())
        .await
        .unwrap();

    let result = mongo_driver::aggregate_documents(
        &client,
        database,
        &collection,
        r#"[{"$sort":{"n":1}},{"$project":{"_id":0,"n":1}}]"#,
        Some(3),
        Some(r#"{"cursor":{"batchSize":1}}"#),
    )
    .await
    .unwrap();

    assert_eq!(result.documents.len(), 3);
    // drain peeks one past max_rows so total > documents.len() signals more rows available.
    assert_eq!(result.total, 4);
    assert_eq!(
        result.documents[0]["n"].as_i64().or_else(|| result.documents[0]["n"].as_u64().map(|v| v as i64)),
        Some(0)
    );
    assert_eq!(
        result.documents[2]["n"].as_i64().or_else(|| result.documents[2]["n"].as_u64().map(|v| v as i64)),
        Some(2)
    );

    mongo_driver::drop_collection(&client, database, &collection).await.unwrap();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_URL pointing at a writable MongoDB database"]
async fn aggregate_without_options_uses_same_cursor_path() {
    let url = std::env::var("DBX_LIVE_MONGODB_URL").expect("DBX_LIVE_MONGODB_URL");
    let client = mongo_driver::connect(&url, Duration::from_secs(10), Duration::from_secs(60)).await.unwrap();
    let database = "dbx_live_aggregate";
    let collection = format!("no_options_{}", std::process::id());

    let docs: Vec<serde_json::Value> = (0..3).map(|n| serde_json::json!({ "n": n })).collect();
    mongo_driver::insert_documents(&client, database, &collection, &serde_json::to_string(&docs).unwrap())
        .await
        .unwrap();

    // Empty options still go through run_cursor_command (not Collection::aggregate).
    let result = mongo_driver::aggregate_documents(
        &client,
        database,
        &collection,
        r#"[{"$sort":{"n":1}},{"$project":{"_id":0,"n":1}}]"#,
        Some(10),
        None,
    )
    .await
    .unwrap();

    assert_eq!(result.total, 3);
    assert_eq!(result.documents.len(), 3);

    mongo_driver::drop_collection(&client, database, &collection).await.unwrap();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_URL pointing at a writable MongoDB database"]
async fn aggregate_explain_option_returns_plan_document() {
    let url = std::env::var("DBX_LIVE_MONGODB_URL").expect("DBX_LIVE_MONGODB_URL");
    let client = mongo_driver::connect(&url, Duration::from_secs(10), Duration::from_secs(60)).await.unwrap();
    let database = "dbx_live_aggregate";
    let collection = format!("explain_{}", std::process::id());

    mongo_driver::insert_documents(&client, database, &collection, r#"[{"n":1}]"#).await.unwrap();

    let result = mongo_driver::aggregate_documents(
        &client,
        database,
        &collection,
        r#"[{"$match":{"n":1}}]"#,
        Some(10),
        Some(r#"{"explain":true}"#),
    )
    .await
    .unwrap();

    assert_eq!(result.total, 1);
    assert_eq!(result.documents.len(), 1);
    // Explain plan shape varies by server version; just require a non-empty object.
    assert!(result.documents[0].is_object(), "explain should return a plan object");

    mongo_driver::drop_collection(&client, database, &collection).await.unwrap();
}
