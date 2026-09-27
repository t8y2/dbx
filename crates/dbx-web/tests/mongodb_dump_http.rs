use futures::StreamExt;
use reqwest::multipart::{Form, Part};
use std::process::Stdio;
use std::time::Duration;

#[tokio::test]
async fn database_dump_upload_and_progress_http_contract() {
    let directory = tempfile::tempdir().unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let log_path = directory.path().join("server.log");
    let mut server = tokio::process::Command::new(env!("CARGO_BIN_EXE_dbx-web"))
        .env("DBX_DATA_DIR", directory.path())
        .env("DBX_PORT", port.to_string())
        .env("DBX_DISABLE_PASSWORD", "1")
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(&log_path).unwrap())
        .spawn()
        .unwrap();
    let base = format!("http://127.0.0.1:{port}/api/mongo/dump");
    let client = reqwest::Client::new();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if client.get(format!("http://127.0.0.1:{port}/api/auth/check")).send().await.is_ok() {
                break;
            }
            if let Some(status) = server.try_wait().unwrap() {
                panic!("Web server exited {status}: {}", std::fs::read_to_string(&log_path).unwrap());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();

    let bad = Form::new()
        .text("format", "archive")
        .text("gzip", "false")
        .part("file", Part::bytes(vec![0]).file_name("../escape.archive"));
    let response = client.post(format!("{base}/source")).multipart(bad).send().await.unwrap();
    assert!(!response.status().is_success());
    assert!(response.text().await.unwrap().contains("Invalid dump upload path"));

    let form = Form::new()
        .text("format", "directory")
        .text("gzip", "false")
        .text("manifest", serde_json::json!([
            {"path":"source/records.bson","sizeBytes":0},
            {"path":"source/records.metadata.json","sizeBytes":r#"{"collectionName":"records","options":{},"indexes":[],"type":"collection"}"#.len()}
        ]).to_string())
        .part(
            "file",
            Part::text(r#"{"collectionName":"records","options":{},"indexes":[],"type":"collection"}"#)
                .file_name("source/records.metadata.json"),
        );
    let response = client.post(format!("{base}/source")).multipart(form).send().await.unwrap();
    assert!(response.status().is_success(), "{}", response.text().await.unwrap());
    let preview: serde_json::Value = response.json().await.unwrap();
    assert_eq!(preview["databases"], serde_json::json!(["source"]));
    assert_eq!(preview["collections"][0]["name"], "records");
    assert!(preview["collections"][0]["documents"].is_null());
    assert_eq!(preview["collections"][0]["sourceFiles"].as_array().unwrap().len(), 2);
    let source_ref = preview["sourceRef"].as_str().unwrap();
    let request = serde_json::json!({ "taskId":"acquire", "connectionId":"missing", "database":"target", "sourceDatabase":"source", "sourceRef":source_ref, "collections":["records"] });
    let acquisition = Form::new()
        .text("format", "directory")
        .text("gzip", "false")
        .text("request", request.to_string())
        .part("file", Part::bytes(Vec::new()).file_name("source/records.bson"))
        .part(
            "file",
            Part::text(r#"{"collectionName":"records","options":{},"indexes":[],"type":"collection"}"#)
                .file_name("source/records.metadata.json"),
        );
    let response = client.post(format!("{base}/source/upload")).multipart(acquisition).send().await.unwrap();
    assert!(response.status().is_success(), "{}", response.text().await.unwrap());
    let acquired: serde_json::Value = response.json().await.unwrap();
    let acquired_ref = acquired["sourceRef"].as_str().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let response = client.post(format!("{base}/restore")).json(&serde_json::json!({ "request": {
        "taskId": id, "connectionId": "missing", "database": "target", "sourceDatabase": "source", "sourceRef": acquired_ref
    }})).send().await.unwrap();
    assert!(response.status().is_success());
    tokio::time::sleep(Duration::from_millis(100)).await;
    let events = client.get(format!("{base}/progress/{id}")).send().await.unwrap();
    assert!(events.status().is_success());
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut stream = events.bytes_stream();
        let mut text = String::new();
        while let Some(chunk) = stream.next().await {
            text.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
            if text.contains("\"status\":\"error\"") {
                return;
            }
        }
        panic!("Missing terminal restore event: {text}");
    })
    .await
    .unwrap();
    let response: serde_json::Value = client
        .post(format!("{base}/source/release"))
        .json(&serde_json::json!({ "sourceRef": source_ref }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["released"], true);
    client
        .post(format!("{base}/source/release"))
        .json(&serde_json::json!({"sourceRef":acquired_ref}))
        .send()
        .await
        .unwrap();
    server.kill().await.unwrap();
    server.wait().await.unwrap();
}
