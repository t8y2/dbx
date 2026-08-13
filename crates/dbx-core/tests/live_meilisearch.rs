use dbx_core::db::meilisearch_driver::{
    execute_rest_query, find_documents, get_columns, insert_document, list_indexes, save_document_batch,
    test_connection, MeilisearchClient, MeilisearchDocumentUpdate,
};
use serde_json::json;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn live_client() -> MeilisearchClient {
    let url = std::env::var("DBX_LIVE_MEILISEARCH_URL").expect("DBX_LIVE_MEILISEARCH_URL");
    let api_key = std::env::var("DBX_LIVE_MEILISEARCH_API_KEY").ok();
    MeilisearchClient::new(&url, api_key.as_deref(), url.starts_with("https://"), None, Duration::from_secs(15))
        .expect("create Meilisearch client")
}

fn unique_index() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    format!("dbx_live_{nanos}")
}

async fn rest(client: &MeilisearchClient, request: &str) -> serde_json::Value {
    let result = execute_rest_query(client, request).await.expect("execute REST request");
    assert_eq!(result.rows.len(), 1);
    let status = result.rows[0][0].as_u64().expect("status code");
    assert!(status < 400, "request failed: {}", result.rows[0][1]);
    serde_json::from_str(result.rows[0][1].as_str().expect("response body")).expect("JSON response")
}

async fn wait_for_task(client: &MeilisearchClient, task_uid: u64) {
    for _ in 0..100 {
        let task = rest(client, &format!("GET /tasks/{task_uid}")).await;
        match task["status"].as_str() {
            Some("succeeded") => return,
            Some("failed") | Some("canceled") => panic!("task {task_uid} failed: {}", task["error"]),
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    panic!("task {task_uid} did not finish");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MEILISEARCH_URL and optional DBX_LIVE_MEILISEARCH_API_KEY"]
async fn meilisearch_document_lifecycle() {
    let client = live_client();
    test_connection(&client, Duration::from_secs(15)).await.expect("connect");

    let index = unique_index();
    let create = rest(&client, &format!("POST /indexes\n{}", json!({ "uid": index, "primaryKey": "id" }))).await;
    let create_task = create["taskUid"].as_u64().expect("create task uid");
    wait_for_task(&client, create_task).await;

    let settings = rest(
        &client,
        &format!(
            "PATCH /indexes/{index}/settings\n{}",
            json!({ "filterableAttributes": ["status", "rating", "title"], "sortableAttributes": ["rating"] })
        ),
    )
    .await;
    let settings_task = settings["taskUid"].as_u64().expect("settings task uid");
    wait_for_task(&client, settings_task).await;

    insert_document(
        &client,
        &index,
        &json!({ "_id": "001", "title": "Space Opera", "status": "published", "rating": 8, "obsolete": true })
            .to_string(),
    )
    .await
    .expect("insert string id");
    insert_document(
        &client,
        &index,
        &json!({ "_id": 2, "title": "Ocean Story", "status": "draft", "rating": 5 }).to_string(),
    )
    .await
    .expect("insert numeric id");

    assert!(list_indexes(&client).await.expect("list indexes").contains(&index));
    let documents = find_documents(
        &client,
        &index,
        0,
        20,
        Some(r#"{"$and":[{"status":"published"},{"rating":{"$gte":8}}]}"#),
        Some(r#"{"rating":-1}"#),
    )
    .await
    .expect("find documents");
    assert_eq!(documents.total, 1);
    assert_eq!(documents.documents[0]["_id"], "001");

    let columns = get_columns(&client, &index).await.expect("get columns");
    assert!(columns.iter().any(|column| column.name == "id" && column.is_primary_key));
    assert!(columns.iter().any(|column| column.name == "title"));

    let affected = save_document_batch(
        &client,
        &index,
        &[
            MeilisearchDocumentUpdate {
                id: "__dbx_meilisearch_string_id__\"001\"".to_string(),
                doc_json: json!({ "title": "Space Opera Revised", "status": "published", "rating": 9 }).to_string(),
            },
            MeilisearchDocumentUpdate {
                id: "2".to_string(),
                doc_json: json!({ "title": "Ocean Story Revised", "status": "draft", "rating": 6 }).to_string(),
            },
        ],
        &["2".to_string()],
        &[
            json!({ "_id": "003", "title": "Forest Story", "status": "published", "rating": 7 }).to_string(),
            json!({ "_id": 4, "title": "Desert Story", "status": "draft", "rating": 4 }).to_string(),
        ],
    )
    .await
    .expect("save document batch");
    assert_eq!(affected, 5);

    let remaining = find_documents(&client, &index, 0, 20, None, None).await.expect("fetch remaining documents");
    assert_eq!(remaining.total, 3);
    let revised = remaining.documents.iter().find(|document| document["_id"] == "001").expect("revised document");
    assert_eq!(revised["title"], "Space Opera Revised");
    assert!(revised.get("obsolete").is_none(), "full replacement must remove deleted fields");
    assert!(remaining.documents.iter().all(|document| document["_id"] != 2));
    assert!(remaining.documents.iter().any(|document| document["_id"] == "003"));
    assert!(remaining.documents.iter().any(|document| document["_id"] == 4));

    let delete = rest(&client, &format!("DELETE /indexes/{index}")).await;
    let delete_task = delete["taskUid"].as_u64().expect("delete task uid");
    wait_for_task(&client, delete_task).await;
}
