//! Live MongoDB `runCommand` regression.
//!
//! Run with a reachable MongoDB server:
//! ```text
//! DBX_LIVE_MONGODB_URL='mongodb://127.0.0.1:27017' \
//!   cargo test -p dbx-core --test live_mongodb_run_command -- --ignored --nocapture
//! ```

use std::time::Duration;

use dbx_core::db::mongo_driver;

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_URL pointing at a MongoDB database"]
async fn run_command_returns_browser_and_extended_json_documents() {
    let url = std::env::var("DBX_LIVE_MONGODB_URL").expect("DBX_LIVE_MONGODB_URL");
    let client = mongo_driver::connect(&url, Duration::from_secs(10), Duration::from_secs(60)).await.unwrap();
    let database = std::env::var("DBX_LIVE_MONGODB_DATABASE").unwrap_or_else(|_| "admin".to_string());

    let result = mongo_driver::run_command(&client, &database, r#"{"ping":1,"comment":"DBX #3050"}"#).await.unwrap();

    assert_eq!(result.total, 1);
    assert!(result.total_is_exact);
    assert_eq!(result.documents.len(), 1);
    let extended_documents = result.extended_documents.as_ref().expect("extended JSON documents");
    assert_eq!(extended_documents.len(), 1);
    assert_eq!(result.documents[0]["ok"].as_f64(), Some(1.0));
    assert_eq!(extended_documents[0]["ok"]["$numberDouble"].as_str(), Some("1.0"));

    let build_info = mongo_driver::run_command(&client, &database, r#"{"buildInfo":1}"#).await.unwrap();
    assert!(build_info.documents[0]["versionArray"].as_array().is_some());
    assert!(build_info.extended_documents.as_ref().unwrap()[0]["versionArray"].as_array().is_some());

    let collection = format!("dbx_run_command_{}", std::process::id());
    let create =
        mongo_driver::run_command(&client, &database, &serde_json::json!({ "create": &collection }).to_string())
            .await
            .unwrap();
    assert_eq!(create.documents[0]["ok"].as_f64(), Some(1.0));

    let drop = mongo_driver::run_command(&client, &database, &serde_json::json!({ "drop": &collection }).to_string())
        .await
        .unwrap();
    assert_eq!(drop.documents[0]["ok"].as_f64(), Some(1.0));
}
