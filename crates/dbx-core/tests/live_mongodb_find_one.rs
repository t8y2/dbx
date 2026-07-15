use std::time::Duration;

use dbx_core::db::mongo_driver;

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_URL pointing at a writable MongoDB database"]
async fn find_one_returns_only_the_sorted_document() {
    let url = std::env::var("DBX_LIVE_MONGODB_URL").expect("DBX_LIVE_MONGODB_URL");
    let client = mongo_driver::connect(&url, Duration::from_secs(10), Duration::from_secs(60)).await.unwrap();
    let database = "dbx_live_find_one";
    let collection = format!("items_{}", std::process::id());

    mongo_driver::insert_documents(
        &client,
        database,
        &collection,
        r#"[{"name":"old","rank":1},{"name":"new","rank":2}]"#,
    )
    .await
    .unwrap();

    let result = mongo_driver::find_one(
        &client,
        database,
        &collection,
        Some("{}"),
        Some(r#"{"_id":0,"name":1}"#),
        Some(r#"{"sort":{"rank":-1}}"#),
    )
    .await
    .unwrap();

    assert_eq!(result.total, 1);
    assert_eq!(result.documents, vec![serde_json::json!({ "name": "new" })]);
    mongo_driver::drop_collection(&client, database, &collection).await.unwrap();
}
