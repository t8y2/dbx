use std::time::Duration;

use dbx_core::db::mongo_driver;
use futures::TryStreamExt;
use mongodb::{
    bson::{doc, Bson, DateTime, Document},
    options::IndexOptions,
    IndexModel,
};

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

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_URL pointing at a writable MongoDB database"]
async fn find_documents_returns_type_preserving_copy_documents() {
    let url = std::env::var("DBX_LIVE_MONGODB_URL").expect("DBX_LIVE_MONGODB_URL");
    let client = mongo_driver::connect(&url, Duration::from_secs(10), Duration::from_secs(60)).await.unwrap();
    let database = "dbx_live_find_one";
    let collection = format!("copy_types_{}", std::process::id());

    client
        .database(database)
        .collection(&collection)
        .insert_one(doc! {
            "lastUpdatedDate": DateTime::parse_rfc3339_str("2025-05-06T08:35:32Z").unwrap(),
            "dateText": Bson::String("ISODate(\"2025-05-06T08:35:32Z\")".to_string()),
        })
        .await
        .unwrap();

    let result = mongo_driver::find_documents(
        &client,
        database,
        &collection,
        0,
        10,
        Some("{}"),
        Some(r#"{"_id":0}"#),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(result.documents[0]["lastUpdatedDate"], serde_json::json!("ISODate(\"2025-05-06T08:35:32Z\")"));
    let extended = result.extended_documents.expect("extended documents");
    assert_eq!(extended[0]["lastUpdatedDate"], serde_json::json!({ "$date": "2025-05-06T08:35:32Z" }));
    assert_eq!(extended[0]["dateText"], serde_json::json!("ISODate(\"2025-05-06T08:35:32Z\")"));

    mongo_driver::drop_collection(&client, database, &collection).await.unwrap();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_URL pointing at a writable MongoDB database"]
async fn clone_collection_copies_options_documents_and_non_id_indexes() {
    let url = std::env::var("DBX_LIVE_MONGODB_URL").expect("DBX_LIVE_MONGODB_URL");
    let client = mongo_driver::connect(&url, Duration::from_secs(10), Duration::from_secs(60)).await.unwrap();
    let database = std::env::var("DBX_LIVE_MONGODB_DATABASE").unwrap_or_else(|_| "dbx_live_clone".to_string());
    let source_name = format!("clone_source_{}", std::process::id());
    let target_name = format!("clone_target_{}", std::process::id());
    let database_ref = client.database(&database);

    database_ref.create_collection(&source_name).validator(doc! { "kind": { "$type": "string" } }).await.unwrap();
    let source = database_ref.collection::<Document>(&source_name);
    source
        .insert_many(vec![
            doc! { "ordinal": 1, "kind": "record", "value": "first" },
            doc! { "ordinal": 2, "kind": "record", "value": "second" },
        ])
        .await
        .unwrap();
    source
        .create_index(
            IndexModel::builder()
                .keys(doc! { "ordinal": 1 })
                .options(IndexOptions::builder().name("ordinal_unique".to_string()).unique(true).build())
                .build(),
        )
        .await
        .unwrap();

    let result = mongo_driver::clone_collection(&client, &database, &source_name, &target_name).await.unwrap();
    assert_eq!(result.documents_copied, 2);
    assert_eq!(result.indexes_copied, 1);

    let target = database_ref.collection::<Document>(&target_name);
    let source_documents =
        source.find(doc! {}).sort(doc! { "ordinal": 1 }).await.unwrap().try_collect::<Vec<Document>>().await.unwrap();
    let target_documents =
        target.find(doc! {}).sort(doc! { "ordinal": 1 }).await.unwrap().try_collect::<Vec<Document>>().await.unwrap();
    assert_eq!(target_documents, source_documents);
    assert!(target.insert_one(doc! { "ordinal": 3 }).await.is_err(), "target must retain the validator");

    let target_indexes = mongo_driver::list_indexes(&client, &database, &target_name).await.unwrap();
    assert!(target_indexes.iter().any(|index| index.name == "ordinal_unique" && index.is_unique));

    mongo_driver::drop_collection(&client, &database, &target_name).await.unwrap();
    mongo_driver::drop_collection(&client, &database, &source_name).await.unwrap();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_URL pointing at a writable MongoDB database"]
async fn find_documents_applies_collation_to_results_total_and_pagination() {
    let url = std::env::var("DBX_LIVE_MONGODB_URL").expect("DBX_LIVE_MONGODB_URL");
    let client = mongo_driver::connect(&url, Duration::from_secs(10), Duration::from_secs(60)).await.unwrap();
    let database = std::env::var("DBX_LIVE_MONGODB_DATABASE").unwrap_or_else(|_| "dbx_live_find_one".to_string());
    let collection = format!("collation_{}", std::process::id());

    mongo_driver::insert_documents(
        &client,
        &database,
        &collection,
        r#"[{"name":"xxx","rank":1},{"name":"XXX","rank":2},{"name":"yyy","rank":3}]"#,
    )
    .await
    .unwrap();

    let result = mongo_driver::find_documents_extended_json(
        &client,
        &database,
        &collection,
        1,
        1,
        Some(r#"{"name":"xxx"}"#),
        Some(r#"{"_id":0}"#),
        Some(r#"{"rank":1}"#),
        Some(r#"{"locale":"en","strength":1}"#),
    )
    .await
    .unwrap();

    assert_eq!(result.total, 2);
    assert!(result.total_is_exact);
    assert_eq!(result.documents, vec![serde_json::json!({ "name": "XXX", "rank": 2 })]);

    mongo_driver::drop_collection(&client, &database, &collection).await.unwrap();
}
