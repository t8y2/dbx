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

    // 10. Missing intermediate chunk and length mismatch error paths on real MongoDB
    let multi_chunk_binary = vec![0xaau8; chunk_size * 2 + 1024]; // 3 chunks (n=0, 1, 2)
    let file_id_3 =
        upload_gridfs_file_core(&state, id, &database, bucket, "three_chunks.bin", &multi_chunk_binary, None)
            .await
            .unwrap();

    // Verify it downloads cleanly before tampering
    let downloaded_3 = download_gridfs_file_core(&state, id, &database, bucket, &file_id_3).await.unwrap();
    assert_eq!(downloaded_3, multi_chunk_binary);

    // Delete intermediate chunk n=1 directly on MongoDB
    let pool = state.pool_handle(id).await.unwrap();
    let agent_client = match &pool {
        PoolKind::Agent(client) => client.clone(),
        _ => panic!("expected legacy agent pool"),
    };
    {
        let mut client = agent_client.lock().await;
        let delete_chunk_filter = serde_json::json!({
            "files_id": { "$oid": &file_id_3 },
            "n": 1,
        })
        .to_string();
        let delete_res = client
            .mongo_delete_documents::<serde_json::Value>(serde_json::json!({
                "database": &database,
                "collection": format!("{bucket}.chunks"),
                "filter": &delete_chunk_filter,
                "filter_json": &delete_chunk_filter,
                "many": false,
            }))
            .await;
        assert!(delete_res.is_ok(), "delete intermediate chunk failed: {:?}", delete_res);
    }

    // Attempt download, verify corrupt file error due to chunk index gap
    let gap_err = download_gridfs_file_core(&state, id, &database, bucket, &file_id_3).await.unwrap_err();
    assert!(
        gap_err.contains("chunk index gap") && gap_err.contains("expected chunk n=1"),
        "expected chunk gap error, got: {gap_err}"
    );

    // Also verify missing trailing chunk: delete chunk n=2 directly on MongoDB
    {
        let mut client = agent_client.lock().await;
        let delete_chunk_filter = serde_json::json!({
            "files_id": { "$oid": &file_id_3 },
            "n": 2,
        })
        .to_string();
        let _ = client
            .mongo_delete_documents::<serde_json::Value>(serde_json::json!({
                "database": &database,
                "collection": format!("{bucket}.chunks"),
                "filter": &delete_chunk_filter,
                "filter_json": &delete_chunk_filter,
                "many": false,
            }))
            .await;
    }
    // Now only chunk n=0 remains; length mismatches metadata length
    let len_err = download_gridfs_file_core(&state, id, &database, bucket, &file_id_3).await.unwrap_err();
    assert!(len_err.contains("length mismatch"), "expected length mismatch error, got: {len_err}");

    delete_gridfs_file_core(&state, id, &database, bucket, &file_id_3).await.unwrap();

    // 11. Upload failure cleanup: verify subsequent batch / files document write failure
    // cleans up any already written chunks from {bucket}.chunks without leaving orphan records.
    {
        let mut client = agent_client.lock().await;
        let index_res = client
            .mongo_create_index::<serde_json::Value>(serde_json::json!({
                "database": &database,
                "collection": format!("{bucket}.files"),
                "keys_json": r#"{"filename":1}"#,
                "options_json": r#"{"name":"unique_filename_test","unique":true}"#,
            }))
            .await;
        assert!(index_res.is_ok(), "create unique index failed: {:?}", index_res);
    }

    // Upload first file with target filename
    let dup_filename = "conflict_file.bin";
    let first_file_content = vec![0x11u8; 100];
    let first_file_id =
        upload_gridfs_file_core(&state, id, &database, bucket, dup_filename, &first_file_content, None).await.unwrap();

    let chunks_count_before_failed_upload: i64;
    {
        let mut client = agent_client.lock().await;
        chunks_count_before_failed_upload = client
            .mongo_count_documents(serde_json::json!({
                "database": &database,
                "collection": format!("{bucket}.chunks"),
                "filter": "{}",
                "filter_json": "{}",
            }))
            .await
            .unwrap();
    }

    // Attempt to upload second file with the same filename and multi-batch chunks (17 chunks across 2 batches)
    const INSERT_BATCH_CHUNKS: usize = 16;
    let multi_batch_content = vec![0x22u8; chunk_size * INSERT_BATCH_CHUNKS + 1024]; // 17 chunks across 2 batches
    let upload_err = upload_gridfs_file_core(&state, id, &database, bucket, dup_filename, &multi_batch_content, None)
        .await
        .unwrap_err();
    assert!(
        upload_err.contains("duplicate") || upload_err.contains("E11000") || upload_err.contains("index"),
        "expected duplicate key error on files insert, got: {upload_err}"
    );

    // Verify all chunks from the failed upload were cleaned up and no orphaned chunks remain
    {
        let mut client = agent_client.lock().await;
        let chunks_count_after: i64 = client
            .mongo_count_documents(serde_json::json!({
                "database": &database,
                "collection": format!("{bucket}.chunks"),
                "filter": "{}",
                "filter_json": "{}",
            }))
            .await
            .unwrap();
        assert_eq!(
            chunks_count_after, chunks_count_before_failed_upload,
            "orphaned chunks were left in {bucket}.chunks after upload failure"
        );
    }

    delete_gridfs_file_core(&state, id, &database, bucket, &first_file_id).await.unwrap();

    // 12. Upload failure cleanup when a subsequent chunk batch insertion fails:
    // Insert a blocking chunk n=16 and create a partial unique index on {bucket}.chunks for n >= 16.
    // Batch 0 (chunks 0..15) inserts successfully, but Batch 1 (chunk 16) fails with duplicate key error.
    // Verify chunks from Batch 0 are cleaned up.
    let dummy_file_id = mongodb::bson::oid::ObjectId::new().to_hex();
    {
        let mut client = agent_client.lock().await;
        let dummy_chunk = serde_json::json!({
            "files_id": { "$oid": &dummy_file_id },
            "n": 16,
            "data": { "$binary": { "base64": "", "subType": "00" } }
        });
        client
            .mongo_insert_documents::<serde_json::Value>(serde_json::json!({
                "database": &database,
                "collection": format!("{bucket}.chunks"),
                "docs_json": serde_json::to_string(&vec![dummy_chunk]).unwrap(),
            }))
            .await
            .unwrap();

        client
            .mongo_create_index::<serde_json::Value>(serde_json::json!({
                "database": &database,
                "collection": format!("{bucket}.chunks"),
                "keys_json": r#"{"n":1}"#,
                "options_json": r#"{"name":"unique_n_gte_16","unique":true,"partialFilterExpression":{"n":{"$gte":16}}}"#,
            }))
            .await
            .unwrap();
    }

    let chunks_before_batch_fail: i64;
    {
        let mut client = agent_client.lock().await;
        chunks_before_batch_fail = client
            .mongo_count_documents(serde_json::json!({
                "database": &database,
                "collection": format!("{bucket}.chunks"),
                "filter": "{}",
                "filter_json": "{}",
            }))
            .await
            .unwrap();
    }

    // Upload 17-chunk file: batch 0 (chunks 0..15) passes, batch 1 (chunk 16) fails on duplicate index
    let batch_fail_err =
        upload_gridfs_file_core(&state, id, &database, bucket, "batch_fail.bin", &multi_batch_content, None)
            .await
            .unwrap_err();
    assert!(
        batch_fail_err.contains("rejected")
            || batch_fail_err.contains("duplicate")
            || batch_fail_err.contains("E11000"),
        "expected chunk batch insert failure, got: {batch_fail_err}"
    );

    // Verify batch 0 chunks were deleted and count is restored
    {
        let mut client = agent_client.lock().await;
        let chunks_after_batch_fail: i64 = client
            .mongo_count_documents(serde_json::json!({
                "database": &database,
                "collection": format!("{bucket}.chunks"),
                "filter": "{}",
                "filter_json": "{}",
            }))
            .await
            .unwrap();
        assert_eq!(
            chunks_after_batch_fail, chunks_before_batch_fail,
            "batch 0 chunks were not cleaned up after batch 1 failure"
        );

        // Remove the dummy chunk
        let delete_dummy_filter = serde_json::json!({
            "files_id": { "$oid": &dummy_file_id },
        })
        .to_string();
        let _ = client
            .mongo_delete_documents::<serde_json::Value>(serde_json::json!({
                "database": &database,
                "collection": format!("{bucket}.chunks"),
                "filter": &delete_dummy_filter,
                "filter_json": &delete_dummy_filter,
                "many": true,
            }))
            .await;
    }

    // 13. Delete single file
    delete_gridfs_file_core(&state, id, &database, bucket, &file_id_1).await.unwrap();
    let files_after_delete = list_gridfs_files_core(&state, id, &database, bucket, None, None).await.unwrap();
    assert_eq!(files_after_delete.len(), 1);
    assert_eq!(files_after_delete[0].id, file_id_2);

    // 14. Delete entire bucket
    delete_gridfs_bucket_core(&state, id, &database, bucket).await.unwrap();
    let buckets_after_delete = list_gridfs_buckets_core(&state, id, &database, None, None).await.unwrap();
    assert!(!buckets_after_delete.iter().any(|b| b.name == bucket));
}
