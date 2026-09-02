use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::s3::{
    s3_create_bucket_with_client, s3_delete_object_with_client, s3_download_object_with_client,
    s3_list_buckets_with_client, s3_list_objects_with_client, s3_put_object_with_client, S3Client, S3Config,
};

fn minio_connection() -> ConnectionConfig {
    ConnectionConfig {
        id: "s3-test".to_string(),
        name: "s3-test".to_string(),
        note: String::new(),
        db_type: DatabaseType::S3,
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: std::env::var("MINIO_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
        port: std::env::var("MINIO_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(9000),
        username: std::env::var("MINIO_ACCESS_KEY").unwrap_or_else(|_| "minioadmin".to_string()),
        password: std::env::var("MINIO_SECRET_KEY").unwrap_or_else(|_| "minioadmin".to_string()),
        database: None,
        default_schema: None,
        visible_databases: None,
        visible_schemas: None,
        show_system_schemas: false,
        attached_databases: Vec::new(),
        init_script: None,
        color: None,
        docs_notes_path: None,
        transport_layers: Vec::new(),
        connect_timeout_secs: 5,
        query_timeout_secs: 30,
        idle_timeout_secs: 60,
        keepalive_interval_secs: dbx_core::models::connection::default_keepalive_interval_secs(),
        ssl: false,
        ca_cert_path: String::new(),
        client_cert_path: String::new(),
        client_key_path: String::new(),
        sysdba: false,
        oracle_connection_type: None,
        connection_string: None,
        redis_connection_mode: None,
        redis_sentinel_master: String::new(),
        redis_sentinel_nodes: String::new(),
        redis_sentinel_username: String::new(),
        redis_sentinel_password: String::new(),
        redis_sentinel_tls: false,
        redis_cluster_nodes: String::new(),
        redis_key_separator: String::new(),
        redis_scan_page_size: None,
        redis_database_aliases: std::collections::HashMap::new(),
        etcd_endpoints: String::new(),
        gbase_server: String::new(),
        informix_server: String::new(),
        external_config: Some(serde_json::json!({ "region": "us-east-1" })),
        jdbc_driver_class: None,
        jdbc_driver_paths: Vec::new(),
        one_time: false,
        read_only: false,
        save_password: true,
        is_production: false,
        production_databases: vec![],
        database_info: None,
    }
}

async fn minio_client() -> S3Client {
    let config = S3Config::from_connection(&minio_connection()).expect("config");
    S3Client::new(config).await.expect("client")
}

#[tokio::test]
#[ignore = "requires local MinIO"]
async fn minio_lists_and_creates_bucket() {
    let client = minio_client().await;
    let bucket = format!("dbx-test-{}", uuid::Uuid::new_v4().simple());

    s3_list_buckets_with_client(&client).await.expect("list buckets");
    s3_create_bucket_with_client(&client, &bucket).await.expect("create bucket");
    let buckets = s3_list_buckets_with_client(&client).await.expect("list buckets after create");
    assert!(buckets.iter().any(|entry| entry.name == bucket));
}

#[tokio::test]
#[ignore = "requires local MinIO"]
async fn minio_lists_objects_in_bucket_with_delimiter() {
    let client = minio_client().await;
    let bucket = format!("dbx-test-{}", uuid::Uuid::new_v4().simple());
    s3_create_bucket_with_client(&client, &bucket).await.expect("create bucket");
    s3_list_objects_with_client(&client, &bucket, "", Some("/"), 200, None).await.expect("list objects with delimiter");
}

#[tokio::test]
#[ignore = "requires local MinIO"]
async fn minio_uploads_lists_and_deletes_object() {
    let client = minio_client().await;
    let bucket = format!("dbx-test-{}", uuid::Uuid::new_v4().simple());
    let key = "folder/hello.txt";
    let payload = b"hello from dbx";

    s3_create_bucket_with_client(&client, &bucket).await.expect("create bucket");
    s3_put_object_with_client(&client, &bucket, key, payload, Some("text/plain")).await.expect("put object");
    let listed = s3_list_objects_with_client(&client, &bucket, "folder/", None, 200, None).await.expect("list objects");
    assert!(listed.objects.iter().any(|entry| entry.key == key));
    let downloaded = s3_download_object_with_client(&client, &bucket, key).await.expect("download object");
    assert_eq!(downloaded, payload);
    s3_delete_object_with_client(&client, &bucket, key).await.expect("delete object");
    let listed =
        s3_list_objects_with_client(&client, &bucket, "", None, 200, None).await.expect("list objects after delete");
    assert!(!listed.objects.iter().any(|entry| entry.key == key));
}
