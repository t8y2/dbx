//! End-to-end GridFS testing over the MongoDB Legacy Agent against a live MongoDB server.
//!
//! Run with:
//! ```text
//! RUST_MIN_STACK=8388608 DBX_MONGO_LEGACY_DUMP_TEST_HOST='127.0.0.1:27017' \
//!   cargo test -p dbx-core --test live_mongodb_legacy_gridfs -- --ignored --nocapture
//! ```

use dbx_core::{
    connection::{AppState, PoolKind},
    document_ops::{
        create_gridfs_bucket_core, delete_gridfs_bucket_core, delete_gridfs_file_core, download_gridfs_file_core,
        list_gridfs_buckets_core, list_gridfs_files_core, upload_gridfs_file_core,
    },
    models::connection::ConnectionConfig,
};

#[tokio::test]
#[ignore = "opt-in: requires DBX_MONGO_LEGACY_DUMP_TEST_HOST (host:port) pointing at a writable MongoDB server"]
async fn gridfs_full_lifecycle_runs_over_the_legacy_agent() {
    let endpoint = std::env::var("DBX_MONGO_LEGACY_DUMP_TEST_HOST")
        .or_else(|_| std::env::var("DBX_LIVE_MONGODB_URL").map(|url| url.replace("mongodb://", "")))
        .expect("DBX_MONGO_LEGACY_DUMP_TEST_HOST");
    let (host, port) = endpoint.split_once(':').expect("host:port");
    let files = tempfile::tempdir().unwrap();
    let database = format!("dbx_legacy_gridfs_{}", uuid::Uuid::new_v4().simple());
    let state =
        AppState::new(dbx_core::persistence::test_storage::open(&files.path().join("storage.db")).await.unwrap());
    let id = "legacy-gridfs-lifecycle-test";
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": id,
        "name": "Legacy GridFS lifecycle test",
        "db_type": "mongodb",
        "host": host,
        "port": port.parse::<u16>().unwrap(),
        "username": "",
        "password": "",
        "database": database,
        "driver_profile": "mongodb-legacy"
    }))
    .unwrap();
    state.configs.write().await.insert(id.into(), config);
    let key = state.get_or_create_pool(id, Some(&database)).await.unwrap();
    assert!(matches!(state.pool_handle(&key).await, Some(PoolKind::Agent(_))), "test must run over the legacy agent");

    let bucket = "assets";

    // 1. Initially no buckets
    let initial_buckets = list_gridfs_buckets_core(&state, id, &database, None, None).await.unwrap();
    assert!(!initial_buckets.iter().any(|b| b.name == bucket));

    // 2. Explicitly create bucket
    create_gridfs_bucket_core(&state, id, &database, bucket).await.unwrap();
    let buckets_after_create = list_gridfs_buckets_core(&state, id, &database, None, None).await.unwrap();
    let bucket_info = buckets_after_create.iter().find(|b| b.name == bucket).expect("bucket should exist");
    assert_eq!(bucket_info.file_count, 0);
    assert_eq!(bucket_info.total_bytes, 0);

    // 3. Upload text file
    let sample_text = b"Hello from DBX Legacy Agent GridFS E2E test!";
    let file_id_1 =
        upload_gridfs_file_core(&state, id, &database, bucket, "readme.txt", sample_text, Some("text/plain"))
            .await
            .unwrap();
    assert!(!file_id_1.is_empty());

    // 4. Upload binary file spanning multiple chunks (> 255KB)
    let chunk_size = 255 * 1024;
    let large_binary = vec![0x42u8; chunk_size + 1024]; // 2 chunks
    let file_id_2 = upload_gridfs_file_core(
        &state,
        id,
        &database,
        bucket,
        "payload.bin",
        &large_binary,
        Some("application/octet-stream"),
    )
    .await
    .unwrap();
    assert!(!file_id_2.is_empty());

    // 5. Verify bucket summary
    let buckets_after_upload = list_gridfs_buckets_core(&state, id, &database, None, None).await.unwrap();
    let bucket_info = buckets_after_upload.iter().find(|b| b.name == bucket).expect("bucket should exist");
    assert_eq!(bucket_info.file_count, 2);
    assert_eq!(bucket_info.total_bytes, (sample_text.len() + large_binary.len()) as i64);

    // 6. List files in bucket
    let all_files = list_gridfs_files_core(&state, id, &database, bucket, None, None).await.unwrap();
    assert_eq!(all_files.len(), 2);

    // 7. Filter files
    let filtered = list_gridfs_files_core(&state, id, &database, bucket, Some(r#"{"filename":"readme.txt"}"#), None)
        .await
        .unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].filename.as_deref(), Some("readme.txt"));
    assert_eq!(filtered[0].length, sample_text.len() as i64);

    // 8. Download text file and verify content
    let downloaded_text = download_gridfs_file_core(&state, id, &database, bucket, &file_id_1).await.unwrap();
    assert_eq!(downloaded_text, sample_text);

    // 9. Download large multi-chunk binary file and verify content
    let downloaded_binary = download_gridfs_file_core(&state, id, &database, bucket, &file_id_2).await.unwrap();
    assert_eq!(downloaded_binary.len(), large_binary.len());
    assert_eq!(downloaded_binary, large_binary);

    // 10. Delete single file
    delete_gridfs_file_core(&state, id, &database, bucket, &file_id_1).await.unwrap();
    let files_after_delete = list_gridfs_files_core(&state, id, &database, bucket, None, None).await.unwrap();
    assert_eq!(files_after_delete.len(), 1);
    assert_eq!(files_after_delete[0].id, file_id_2);

    // 11. Delete entire bucket
    delete_gridfs_bucket_core(&state, id, &database, bucket).await.unwrap();
    let buckets_after_delete = list_gridfs_buckets_core(&state, id, &database, None, None).await.unwrap();
    assert!(!buckets_after_delete.iter().any(|b| b.name == bucket));
}
