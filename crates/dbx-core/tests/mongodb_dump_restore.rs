use std::io::Write;
use std::path::Path;

use dbx_core::mongodb_import_export::{
    for_each_mongodb_import_document, preview_mongodb_import_file, MongoImportFormat, MongoImportIssue,
    MongoImportParseOptions, MongoImportPreviewRequest, ParsedMongoDocument,
};
use flate2::{write::GzEncoder, Compression};
use mongodb::bson::{doc, Bson, Document};

fn encode(documents: &[Document], gzip: bool) -> Vec<u8> {
    let bytes = documents.iter().flat_map(|document| mongodb::bson::to_vec(document).unwrap()).collect::<Vec<_>>();
    if !gzip {
        return bytes;
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&bytes).unwrap();
    encoder.finish().unwrap()
}

fn read(path: &Path) -> Result<Vec<Document>, Box<MongoImportIssue>> {
    let mut documents = Vec::new();
    #[expect(clippy::result_large_err, reason = "The public import callback requires MongoImportIssue by value")]
    let collect = |parsed: Result<ParsedMongoDocument, MongoImportIssue>| {
        documents.push(parsed?.document);
        Ok(())
    };
    for_each_mongodb_import_document(
        path.to_str().unwrap(),
        MongoImportFormat::Bson,
        &MongoImportParseOptions::default(),
        collect,
    )
    .map_err(Box::new)?;
    Ok(documents)
}

#[test]
fn bson_preview_is_bounded_and_preserves_explicit_format() {
    let directory = tempfile::tempdir().unwrap();
    // The selected format, not the filename, chooses the parser.
    let path = directory.path().join("renamed.json");
    let documents = (0..80).map(|index| doc! { "_id": index, "smallLong": 1i64 }).collect::<Vec<_>>();
    std::fs::write(&path, encode(&documents, false)).unwrap();
    let mut request = MongoImportPreviewRequest {
        file_path: path.to_str().unwrap().into(),
        source_ref: None,
        format: MongoImportFormat::Bson,
        parse_options: MongoImportParseOptions::default(),
        preview_limit: Some(3),
    };
    let preview = preview_mongodb_import_file(&request).unwrap();
    assert_eq!(preview.rows.len(), 3);
    assert!(!preview.estimated_rows_exact);
    assert_eq!(preview.detected_encoding, None);
    assert_eq!(preview.rows[0]["smallLong"]["$numberLong"], "1");
    assert_eq!(read(&path).unwrap(), documents);

    std::fs::write(&path, []).unwrap();
    request.preview_limit = Some(1);
    let preview = preview_mongodb_import_file(&request).unwrap();
    assert_eq!(preview.estimated_rows, Some(0));
    assert!(preview.estimated_rows_exact);
    assert!(read(&path).unwrap().is_empty());
}

#[test]
fn gzip_reads_all_members_and_rejects_corrupt_or_truncated_streams() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("records.bson.gz");
    let first = doc! { "_id": 1 };
    let second = doc! { "_id": 2 };
    let mut bytes = encode(std::slice::from_ref(&first), true);
    bytes.extend(encode(std::slice::from_ref(&second), true));
    std::fs::write(&path, &bytes).unwrap();
    assert_eq!(read(&path).unwrap(), vec![first.clone(), second]);

    let valid = encode(&[first], true);
    for length in [0, 1, valid.len() - 1, valid.len() - 8] {
        std::fs::write(&path, &valid[..length]).unwrap();
        assert!(read(&path).is_err(), "accepted truncated gzip at {length}");
    }
    let mut corrupt = valid.clone();
    let crc_offset = corrupt.len() - 8;
    corrupt[crc_offset] ^= 1;
    std::fs::write(&path, corrupt).unwrap();
    assert!(read(&path).is_err(), "accepted invalid gzip checksum");
    let mut trailing = valid;
    trailing.extend_from_slice(b"junk");
    std::fs::write(&path, trailing).unwrap();
    assert!(read(&path).is_err(), "ignored trailing compressed data");

    std::fs::write(&path, encode(&[], true)).unwrap();
    assert!(read(&path).unwrap().is_empty());
}

#[test]
fn invalid_bson_is_fatal_even_when_callback_skips_errors() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("records.bson");
    let prefix = encode(&[doc! { "_id": 1 }], false);
    for tail in [
        vec![1],
        vec![5, 0, 0],
        4i32.to_le_bytes().to_vec(),
        (-1i32).to_le_bytes().to_vec(),
        (16 * 1024 * 1024 + 1i32).to_le_bytes().to_vec(),
        vec![5, 0, 0, 0, 1],
    ] {
        let mut bytes = prefix.clone();
        bytes.extend(tail);
        std::fs::write(&path, bytes).unwrap();
        #[expect(clippy::result_large_err, reason = "The public import callback requires MongoImportIssue by value")]
        let ignore = |_: Result<ParsedMongoDocument, MongoImportIssue>| Ok(());
        let error = for_each_mongodb_import_document(
            path.to_str().unwrap(),
            MongoImportFormat::Bson,
            &MongoImportParseOptions { skip_error_rows: Some(true), ..Default::default() },
            ignore,
        )
        .unwrap_err();
        assert_eq!(error.code, "BSON_STRUCTURE");
        assert_eq!(error.row, Some(2));
    }
}

fn run_tool(tools: &Path, name: &str, args: &[&str]) {
    let logs = tempfile::tempdir().unwrap();
    let log = logs.path().join("stderr.log");
    let mut child = std::process::Command::new(tools.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)))
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::fs::File::create(&log).unwrap())
        .spawn()
        .unwrap_or_else(|error| panic!("cannot run {name}: {error}"));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "{name}: {}", std::fs::read_to_string(&log).unwrap());
            return;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("{name} timed out: {}", std::fs::read_to_string(&log).unwrap());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

async fn collection_bytes(client: &mongodb::Client, database: &str, collection: &str) -> Vec<Vec<u8>> {
    use futures::TryStreamExt;
    client
        .database(database)
        .collection::<Document>(collection)
        .find(doc! {})
        .sort(doc! { "_id": 1 })
        .await
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap()
        .iter()
        .map(|document| mongodb::bson::to_vec(document).unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "opt-in: DBX_MONGO_DUMP_TEST_URI and DBX_MONGO_TOOLS_DIR; creates a temporary database"]
async fn official_tools_round_trip_through_dbx_core() {
    use dbx_core::connection::{AppState, PoolKind};
    use dbx_core::models::connection::ConnectionConfig;
    use dbx_core::mongodb_import_export::{
        export_mongodb_query_core, import_mongodb_file_core, MongoExportFormat, MongoExportRequest, MongoExportStatus,
        MongoImportRequest, MongoImportStatus,
    };
    use dbx_core::storage::Storage;
    use mongodb::bson::{oid::ObjectId, spec::BinarySubtype, Binary, DateTime, Decimal128, Regex, Timestamp};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    let uri = std::env::var("DBX_MONGO_DUMP_TEST_URI").expect("DBX_MONGO_DUMP_TEST_URI");
    let tools = std::path::PathBuf::from(std::env::var("DBX_MONGO_TOOLS_DIR").expect("DBX_MONGO_TOOLS_DIR"));
    let directory = tempfile::tempdir().unwrap();
    let client = mongodb::Client::with_uri_str(&uri).await.unwrap();
    let database = format!("dbx_dump_test_{}", uuid::Uuid::new_v4().simple());
    let storage = Storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let connection_id = "mongo-dump-test";
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": connection_id, "name": "Dump test", "db_type": "mongodb", "host": "127.0.0.1",
        "port": 27090, "username": "", "password": "", "database": database,
        "connection_string": uri, "driver_profile": "mongodb-native"
    }))
    .unwrap();
    state.configs.write().await.insert(connection_id.into(), config);
    state
        .update_connection_pools(|pools| {
            pools.insert(connection_id.into(), PoolKind::MongoDb(client.clone()));
        })
        .await;
    let documents = (0..1207)
        .map(|index| {
            doc! {
                "_id": index,
                "objectId": ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap(),
                "smallLong": 1i64, "maxLong": i64::MAX, "double": 1.5f64,
                "decimal": "123.45".parse::<Decimal128>().unwrap(),
                "date": DateTime::from_millis(-1234567890),
                "binary": Binary { subtype: BinarySubtype::UserDefined(0x80), bytes: vec![0, 1, 255] },
                "regex": Regex { pattern: "^test".into(), options: "im".into() },
                "timestamp": Timestamp { time: 12345, increment: 42 },
                "min": Bson::MinKey, "max": Bson::MaxKey, "undefined": Bson::Undefined,
                "code": Bson::JavaScriptCode("return 1".into()),
                "nested": { "array": [Bson::Null, Bson::Boolean(true), Bson::String("1".into())] },
            }
        })
        .collect::<Vec<_>>();
    client.database(&database).collection("source").insert_many(documents).await.unwrap();
    let expected = collection_bytes(&client, &database, "source").await;
    assert_eq!(expected.len(), 1207);

    for gzip in [false, true] {
        let extension = if gzip { "bson.gz" } else { "bson" };
        let dump_dir = directory.path().join(if gzip { "official-gzip" } else { "official-plain" });
        let mut args = vec![
            "--uri",
            uri.as_str(),
            "--db",
            &database,
            "--collection",
            "source",
            "--out",
            dump_dir.to_str().unwrap(),
        ];
        if gzip {
            args.push("--gzip");
        }
        run_tool(&tools, "mongodump", &args);
        let dumped = dump_dir.join(&database).join(format!("source.{extension}"));
        assert_eq!(read(&dumped).unwrap().len(), expected.len());
        let preview = preview_mongodb_import_file(&MongoImportPreviewRequest {
            file_path: dumped.to_str().unwrap().into(),
            source_ref: None,
            format: MongoImportFormat::Bson,
            parse_options: Default::default(),
            preview_limit: Some(5),
        })
        .unwrap();
        assert_eq!(preview.rows.len(), 5);

        let imported = if gzip { "dbx_gzip" } else { "dbx_plain" };
        let request = MongoImportRequest {
            import_id: uuid::Uuid::new_v4().to_string(),
            connection_id: connection_id.into(),
            database: database.clone(),
            collection: imported.into(),
            file_path: dumped.to_str().unwrap().into(),
            source_ref: None,
            format: MongoImportFormat::Bson,
            parse_options: Default::default(),
            batch_size: 500,
            execution_id: None,
        };
        let summary = import_mongodb_file_core(&state, &request, |_| Box::pin(async { false }), |_| {}).await.unwrap();
        assert_eq!(summary.rows_inserted, 1207);
        assert_eq!(summary.rows_failed, 0);
        assert_eq!(summary.batches_committed, 3);
        assert_eq!(collection_bytes(&client, &database, imported).await, expected);

        // This file is produced by DBX, with no official metadata sidecar beside it.
        let exported = directory.path().join(format!("dbx-output.{extension}"));
        let export = MongoExportRequest {
            export_id: uuid::Uuid::new_v4().to_string(),
            connection_id: connection_id.into(),
            database: database.clone(),
            collection: imported.into(),
            filter: None,
            sort: Some("{\"_id\":1}".into()),
            projection: None,
            collation: None,
            format: MongoExportFormat::Bson,
            include_header: false,
            gzip,
            file_path: exported.to_str().unwrap().into(),
            execution_id: None,
        };
        let summary = export_mongodb_query_core(&state, &export, |_| Box::pin(async { false }), |_| {}).await.unwrap();
        assert_eq!(summary.documents_exported, 1207);
        assert_eq!(
            read(&exported).unwrap().iter().map(|d| mongodb::bson::to_vec(d).unwrap()).collect::<Vec<_>>(),
            expected
        );
        let restored = if gzip { "official_gzip" } else { "official_plain" };
        let mut args = vec!["--uri", uri.as_str(), "--db", &database, "--collection", restored];
        if gzip {
            args.push("--gzip");
        }
        args.push(exported.to_str().unwrap());
        run_tool(&tools, "mongorestore", &args);
        assert_eq!(collection_bytes(&client, &database, restored).await, expected);
        println!("{extension}: official -> DBX -> official, 1207 documents, BSON bytes match");

        let mut empty_export = export.clone();
        empty_export.collection = "empty".into();
        empty_export.file_path = directory.path().join(format!("empty.{extension}")).to_str().unwrap().into();
        let empty =
            export_mongodb_query_core(&state, &empty_export, |_| Box::pin(async { false }), |_| {}).await.unwrap();
        assert_eq!(empty.documents_exported, 0);
        assert!(read(Path::new(&empty.file_path)).unwrap().is_empty());

        let cancelled = Arc::new(AtomicBool::new(false));
        let check = cancelled.clone();
        let original = std::fs::read(&exported).unwrap();
        let result = export_mongodb_query_core(
            &state,
            &export,
            move |_| {
                let check = check.clone();
                Box::pin(async move { check.load(Ordering::SeqCst) })
            },
            |progress| {
                if progress.status == MongoExportStatus::Running && progress.documents_read > 0 {
                    cancelled.store(true, Ordering::SeqCst);
                }
            },
        )
        .await;
        assert_eq!(result.unwrap_err(), "Export cancelled");
        assert_eq!(std::fs::read(&exported).unwrap(), original, "cancel replaced the previous export");

        let damaged = directory.path().join("damaged.bson");
        std::fs::write(&damaged, [1]).unwrap();
        let mut request = request;
        request.file_path = damaged.to_str().unwrap().into();
        request.parse_options.skip_error_rows = Some(true);
        let mut status = MongoImportStatus::Running;
        let result =
            import_mongodb_file_core(&state, &request, |_| Box::pin(async { false }), |p| status = p.status).await;
        assert!(result.is_err());
        assert_eq!(status, MongoImportStatus::Error);
    }
    client.database(&database).drop().await.unwrap();
}

async fn specs(client: &mongodb::Client, db: &str, collection: &str) -> (Document, Vec<Document>) {
    use futures::TryStreamExt;
    let specification = client
        .database(db)
        .list_collections()
        .filter(doc! { "name": collection })
        .await
        .unwrap()
        .try_next()
        .await
        .unwrap()
        .unwrap();
    let options = mongodb::bson::to_document(&specification.options).unwrap();
    let mut indexes = Vec::new();
    if !matches!(specification.collection_type, mongodb::results::CollectionType::View) {
        let mut cursor = client.database(db).collection::<Document>(collection).list_indexes().await.unwrap();
        while let Some(index) = cursor.try_next().await.unwrap() {
            let mut index = mongodb::bson::to_document(&index).unwrap();
            index.remove("ns");
            index.remove("v");
            indexes.push(index);
        }
        indexes.sort_by_key(|index| index.get_str("name").unwrap().to_string());
    }
    (options, indexes)
}

#[tokio::test]
#[ignore = "opt-in: DBX_MONGO_DUMP_TEST_URI and DBX_MONGO_TOOLS_DIR; creates temporary databases"]
async fn official_database_tools_round_trip_through_dbx() {
    use dbx_core::{
        connection::{AppState, PoolKind},
        models::connection::ConnectionConfig,
        mongodb_dump::*,
        storage::Storage,
    };
    let uri = std::env::var("DBX_MONGO_DUMP_TEST_URI").expect("DBX_MONGO_DUMP_TEST_URI");
    let tools = std::path::PathBuf::from(std::env::var("DBX_MONGO_TOOLS_DIR").expect("DBX_MONGO_TOOLS_DIR"));
    let files = tempfile::tempdir().unwrap();
    let client = mongodb::Client::with_uri_str(&uri).await.unwrap();
    let database = format!("dbx_db_{}", uuid::Uuid::new_v4().simple());
    let db = client.database(&database);
    db.run_command(doc! { "create": "records", "validator": { "score": { "$gte": 0 } }, "validationLevel": "strict", "collation": { "locale": "en", "strength": 2 } }).await.unwrap();
    db.collection("records")
        .insert_many(vec![
            doc! { "_id": 1, "score": 1i64, "name": "first" },
            doc! { "_id": 2, "score": 2i64, "name": "second" },
        ])
        .await
        .unwrap();
    db.run_command(doc! { "createIndexes": "records", "indexes": [ { "key": { "name": 1, "score": -1 }, "name": "compound_unique", "unique": true }, { "key": { "expires": 1 }, "name": "ttl", "expireAfterSeconds": 3600 }] }).await.unwrap();
    db.create_collection("empty").await.unwrap();
    db.run_command(doc! { "create": "capped", "capped": true, "size": 65536i64, "max": 100i64 }).await.unwrap();
    db.collection("capped").insert_one(doc! { "_id": 1, "n": 1 }).await.unwrap();
    db.collection("odd/name").insert_one(doc! { "_id": 1, "binary": mongodb::bson::Binary { subtype: mongodb::bson::spec::BinarySubtype::Generic, bytes: vec![1, 2, 3] } }).await.unwrap();
    db.run_command(doc! { "create": "z_view", "viewOn": "records", "pipeline": [ { "$match": { "score": { "$gte": 1 } } } ], "collation": { "locale": "en", "strength": 2 } }).await.unwrap();
    db.run_command(doc! { "create": "a_nested", "viewOn": "z_view", "pipeline": [], "collation": { "locale": "en", "strength": 2 } }).await.unwrap();
    let collections = ["records", "empty", "capped", "odd/name", "z_view", "a_nested"];
    let state = AppState::new(Storage::open(&files.path().join("storage.db")).await.unwrap());
    let connection_id = "database-dump-test";
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({ "id": connection_id, "name": "Database dump test", "db_type": "mongodb", "host": "127.0.0.1", "port": 27090, "username": "", "password": "", "database": database, "connection_string": uri, "driver_profile": "mongodb-native" })).unwrap();
    state.configs.write().await.insert(connection_id.into(), config);
    state
        .update_connection_pools(|pools| {
            pools.insert(connection_id.into(), PoolKind::MongoDb(client.clone()));
        })
        .await;
    let mut databases = vec![database.clone()];
    for format in [MongoDumpFormat::Directory, MongoDumpFormat::Archive] {
        for gzip in [false, true] {
            let tag = format!("{format:?}_{gzip}");
            let official_path = files.path().join(format!("official-{tag}"));
            let archive_arg = format!("--archive={}", official_path.display());
            let mut args = vec!["--uri", uri.as_str(), "--db", &database];
            if format == MongoDumpFormat::Archive {
                args.push(&archive_arg);
            } else {
                args.extend(["--out", official_path.to_str().unwrap()]);
            }
            if gzip {
                args.push("--gzip");
            }
            run_tool(&tools, "mongodump", &args);
            let preview = prepare_mongodb_restore_source(MongoRestoreSourceRequest {
                path: official_path.to_str().unwrap().into(),
                format,
                gzip,
            })
            .await
            .unwrap();
            assert_eq!(preview.catalog.collections.len(), 6);
            assert!(preview.catalog.collections.iter().all(|c| c.documents.is_none()));
            let restored = format!("{database}_{tag}");
            databases.push(restored.clone());
            let request = MongoDatabaseRestoreRequest {
                task_id: uuid::Uuid::new_v4().to_string(),
                connection_id: connection_id.into(),
                database: restored.clone(),
                source_database: database.clone(),
                source_ref: preview.source_ref.clone(),
                collections: None,
                drop_existing: false,
                restore_options: true,
                restore_indexes: true,
                stop_on_error: true,
                objcheck: gzip,
                batch_size: 500,
                execution_id: None,
            };
            let mut saw_data = false;
            let result = restore_mongodb_database(
                &state,
                &request,
                |_| Box::pin(async { false }),
                |p| {
                    assert_ne!(p.phase, "validating");
                    saw_data |= p.phase == "data";
                },
            )
            .await
            .unwrap();
            assert!(saw_data);
            assert_eq!(result.documents_validated, if gzip { 4 } else { 0 });
            assert_eq!(result.collections_done, 6);
            assert_eq!(result.documents_written, 4);
            for collection in collections {
                assert_eq!(
                    collection_bytes(&client, &database, collection).await,
                    collection_bytes(&client, &restored, collection).await,
                    "data: {tag} {collection}"
                );
                assert_eq!(
                    specs(&client, &database, collection).await,
                    specs(&client, &restored, collection).await,
                    "metadata: {tag} {collection}"
                );
            }
            client.database(&restored).collection("unselected").insert_one(doc! { "_id": "keep" }).await.unwrap();
            client
                .database(&restored)
                .collection("records")
                .insert_one(doc! { "_id": 999, "score": 999, "name": "remove" })
                .await
                .unwrap();
            let mut selected = request.clone();
            selected.drop_existing = true;
            selected.collections = Some(vec!["records".into()]);
            restore_mongodb_database(&state, &selected, |_| Box::pin(async { false }), |_| {}).await.unwrap();
            assert_eq!(
                collection_bytes(&client, &database, "records").await,
                collection_bytes(&client, &restored, "records").await
            );
            assert_eq!(collection_bytes(&client, &restored, "unselected").await.len(), 1);
            if format == MongoDumpFormat::Directory && !gzip {
                let cancel_dir = files.path().join("cancel_source");
                std::fs::create_dir(&cancel_dir).unwrap();
                let documents = (0..201).map(|id| doc! { "_id": id }).collect::<Vec<_>>();
                std::fs::write(cancel_dir.join("records.bson"), encode(&documents, false)).unwrap();
                let cancel_source = prepare_mongodb_restore_source(MongoRestoreSourceRequest {
                    path: cancel_dir.to_str().unwrap().into(),
                    format: MongoDumpFormat::Directory,
                    gzip: false,
                })
                .await
                .unwrap();
                let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let signal = cancel.clone();
                let mut cancel_request = selected.clone();
                cancel_request.source_ref = cancel_source.source_ref.clone();
                cancel_request.source_database = "cancel_source".into();
                cancel_request.batch_size = 100;
                let mut final_progress = None;
                let cancelled = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    restore_mongodb_database(
                        &state,
                        &cancel_request,
                        |_| {
                            let signal = signal.clone();
                            Box::pin(async move { signal.load(std::sync::atomic::Ordering::Relaxed) })
                        },
                        |p| {
                            if p.documents_written >= 100 {
                                cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                            }
                            final_progress = Some(p);
                        },
                    ),
                )
                .await
                .expect("cancellation must stop and join the reader")
                .unwrap_err();
                assert!(cancelled.contains("cancelled"), "{cancelled}");
                let final_progress = final_progress.unwrap();
                assert_eq!(final_progress.status, "cancelled");
                assert_eq!(final_progress.documents_written, 100);
                assert_eq!(collection_bytes(&client, &restored, "records").await.len(), 100);
                let mut duplicate_request = cancel_request.clone();
                duplicate_request.batch_size = 500;
                duplicate_request.drop_existing = false;
                let mut partial_progress = None;
                let error = restore_mongodb_database(
                    &state,
                    &duplicate_request,
                    |_| Box::pin(async { false }),
                    |p| partial_progress = Some(p),
                )
                .await
                .unwrap_err();
                assert!(error.contains("duplicate key"), "{error}");
                let partial_progress = partial_progress.unwrap();
                assert_eq!(partial_progress.documents_written, 101);
                assert_eq!(partial_progress.documents_failed, 100);
                duplicate_request.stop_on_error = false;
                let continued =
                    restore_mongodb_database(&state, &duplicate_request, |_| Box::pin(async { false }), |_| {})
                        .await
                        .unwrap();
                assert_eq!(continued.documents_written, 0);
                assert_eq!(continued.documents_failed, 201);
                release_mongodb_restore_source(&cancel_source.source_ref);
                let broken_dir = files.path().join("broken_source");
                std::fs::create_dir(&broken_dir).unwrap();
                std::fs::write(broken_dir.join("records.bson"), encode(&[doc! { "_id": "replacement" }], false))
                    .unwrap();
                std::fs::write(broken_dir.join("zz_broken.bson"), b"invalid BSON").unwrap();
                let broken = prepare_mongodb_restore_source(MongoRestoreSourceRequest {
                    path: broken_dir.to_str().unwrap().into(),
                    format,
                    gzip,
                })
                .await
                .unwrap();
                let mut invalid = selected.clone();
                invalid.source_ref = broken.source_ref.clone();
                invalid.source_database = "broken_source".into();
                invalid.collections = None;
                let mut partial = 0;
                let error = restore_mongodb_database(&state, &invalid, |_| Box::pin(async { false }), |_| {})
                    .await
                    .unwrap_err();
                assert!(error.contains("BSON"), "{error}");
                assert_eq!(
                    collection_bytes(&client, &restored, "records").await,
                    vec![mongodb::bson::to_vec(&doc! { "_id": "replacement" }).unwrap()],
                    "valid earlier collections are restored without a full pre-scan"
                );
                invalid.objcheck = true;
                assert!(restore_mongodb_database(
                    &state,
                    &invalid,
                    |_| Box::pin(async { false }),
                    |p| partial = p.documents_written
                )
                .await
                .is_err());
                assert_eq!(partial, 1);
                release_mongodb_restore_source(&broken.source_ref);
                let mut no_metadata = request.clone();
                no_metadata.database = format!("{database}_no_options");
                databases.push(no_metadata.database.clone());
                no_metadata.collections = Some(vec!["records".into()]);
                no_metadata.restore_options = false;
                no_metadata.restore_indexes = false;
                restore_mongodb_database(&state, &no_metadata, |_| Box::pin(async { false }), |_| {}).await.unwrap();
                let (options, indexes) = specs(&client, &no_metadata.database, "records").await;
                assert!(options.is_empty());
                assert_eq!(indexes.len(), 1);
                state.configs.write().await.get_mut(connection_id).unwrap().read_only = true;
                let blocked = restore_mongodb_database(&state, &no_metadata, |_| Box::pin(async { false }), |_| {})
                    .await
                    .unwrap_err();
                assert!(blocked.contains("Read-only"));
                state.configs.write().await.get_mut(connection_id).unwrap().read_only = false;
                let cancelled = restore_mongodb_database(&state, &no_metadata, |_| Box::pin(async { true }), |_| {})
                    .await
                    .unwrap_err();
                assert!(cancelled.contains("cancelled"));
            }
            assert!(release_mongodb_restore_source(&preview.source_ref));

            let output = files.path().join(format!("dbx-{tag}"));
            let dump = MongoDatabaseDumpRequest {
                task_id: uuid::Uuid::new_v4().to_string(),
                connection_id: connection_id.into(),
                database: database.clone(),
                file_path: output.to_str().unwrap().into(),
                format,
                gzip,
                collections: None,
            };
            dump_mongodb_database(&state, &dump, |_| Box::pin(async { false }), |_| {}).await.unwrap();
            let target = format!("{database}_out_{tag}");
            databases.push(target.clone());
            let from = format!("{database}.*");
            let to = format!("{target}.*");
            let archive_arg = format!("--archive={}", output.display());
            let mut args = vec!["--uri", uri.as_str(), "--nsFrom", &from, "--nsTo", &to];
            if gzip {
                args.push("--gzip");
            }
            if format == MongoDumpFormat::Archive {
                args.push(&archive_arg);
            } else {
                args.push(output.to_str().unwrap());
            }
            run_tool(&tools, "mongorestore", &args);
            for collection in collections {
                assert_eq!(
                    collection_bytes(&client, &database, collection).await,
                    collection_bytes(&client, &target, collection).await,
                    "exported data: {tag} {collection}"
                );
                assert_eq!(
                    specs(&client, &database, collection).await,
                    specs(&client, &target, collection).await,
                    "exported metadata: {tag} {collection}"
                );
            }
            println!("{tag}: six collections/views, BSON, options and indexes match in both directions");
            if format == MongoDumpFormat::Archive && !gzip {
                let mut bytes = std::fs::read(&output).unwrap();
                let offset = bytes.windows(5).position(|bytes| bytes == b"first").unwrap();
                bytes[offset] = b'F';
                let corrupt = files.path().join("corrupt.archive");
                std::fs::write(&corrupt, &bytes).unwrap();
                let corrupt_preview = prepare_mongodb_restore_source(MongoRestoreSourceRequest {
                    path: corrupt.to_str().unwrap().into(),
                    format,
                    gzip: false,
                })
                .await
                .unwrap();
                let mut corrupt_request = request.clone();
                corrupt_request.source_ref = corrupt_preview.source_ref.clone();
                corrupt_request.database = target.clone();
                corrupt_request.drop_existing = true;
                let mut partial = 0;
                let error = restore_mongodb_database(
                    &state,
                    &corrupt_request,
                    |_| Box::pin(async { false }),
                    |p| partial = p.documents_written,
                )
                .await
                .unwrap_err();
                assert!(error.contains("checksum"), "{error}");
                assert!(partial > 0, "archive CRC is checked as data streams, not in a separate pre-pass");
                release_mongodb_restore_source(&corrupt_preview.source_ref);
                bytes = std::fs::read(&output).unwrap();
                bytes.truncate(bytes.len() - 1);
                std::fs::write(&corrupt, bytes).unwrap();
                let truncated = prepare_mongodb_restore_source(MongoRestoreSourceRequest {
                    path: corrupt.to_str().unwrap().into(),
                    format,
                    gzip: false,
                })
                .await
                .unwrap();
                corrupt_request.source_ref = truncated.source_ref.clone();
                assert!(restore_mongodb_database(&state, &corrupt_request, |_| Box::pin(async { false }), |_| {})
                    .await
                    .is_err());
                assert_eq!(
                    collection_bytes(&client, &database, "records").await,
                    collection_bytes(&client, &target, "records").await
                );
                release_mongodb_restore_source(&truncated.source_ref);
            }
        }
    }
    for database in databases {
        client.database(&database).drop().await.unwrap();
    }
}

#[tokio::test]
#[ignore = "opt-in: DBX_MONGO_LEGACY_DUMP_TEST_HOST (host:port, MongoDB 3.6+ without auth) and an installed MongoDB Legacy Agent; creates temporary databases"]
async fn legacy_agent_database_round_trip_through_dbx() {
    use dbx_core::{
        connection::{AppState, PoolKind},
        models::connection::ConnectionConfig,
        mongo_ops::mongo_run_command_core,
        mongodb_dump::*,
        storage::Storage,
    };
    // Everything, including seeding and verification, goes through the legacy agent: the native
    // Rust driver refuses servers older than 4.2, which is the very case the agent exists for.
    async fn command(state: &AppState, id: &str, database: &str, command: Document) -> Document {
        let json = mongodb::bson::Bson::Document(command).into_canonical_extjson().to_string();
        let result = mongo_run_command_core(state, id, database, &json).await.unwrap();
        let response = result.extended_documents.unwrap().remove(0);
        let response = dbx_core::db::mongo_driver::json_object_to_document_extended_json(&response).unwrap();
        assert_eq!(
            response.get_f64("ok").ok().or_else(|| response.get_i32("ok").ok().map(f64::from)),
            Some(1.0),
            "{response}"
        );
        response
    }
    fn batch(response: &Document) -> Vec<Document> {
        let cursor = response.get_document("cursor").unwrap();
        cursor.get_array("firstBatch").unwrap().iter().map(|b| b.as_document().unwrap().clone()).collect()
    }
    async fn documents(state: &AppState, id: &str, database: &str, collection: &str) -> Vec<Vec<u8>> {
        batch(&command(state, id, database, doc! { "find": collection, "sort": { "_id": 1 } }).await)
            .iter()
            .map(|document| mongodb::bson::to_vec(document).unwrap())
            .collect()
    }
    async fn specs(state: &AppState, id: &str, database: &str, collection: &str) -> (Document, Vec<Document>) {
        let listed =
            batch(&command(state, id, database, doc! { "listCollections": 1, "filter": { "name": collection } }).await);
        let spec = listed.first().unwrap_or_else(|| panic!("{database}.{collection} is missing"));
        let options = spec.get_document("options").cloned().unwrap_or_default();
        let mut indexes = Vec::new();
        if spec.get_str("type").unwrap_or("collection") != "view" {
            for mut index in batch(&command(state, id, database, doc! { "listIndexes": collection }).await) {
                index.remove("ns");
                index.remove("v");
                indexes.push(index);
            }
            indexes.sort_by_key(|index| index.get_str("name").unwrap().to_string());
        }
        (options, indexes)
    }

    let endpoint = std::env::var("DBX_MONGO_LEGACY_DUMP_TEST_HOST").expect("DBX_MONGO_LEGACY_DUMP_TEST_HOST");
    let (host, port) = endpoint.split_once(':').expect("host:port");
    let files = tempfile::tempdir().unwrap();
    let database = format!("dbx_legacy_{}", uuid::Uuid::new_v4().simple());
    let state = AppState::new(Storage::open(&files.path().join("storage.db")).await.unwrap());
    let id = "legacy-dump-test";
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({ "id": id, "name": "Legacy dump test", "db_type": "mongodb", "host": host, "port": port.parse::<u16>().unwrap(), "username": "", "password": "", "database": database, "driver_profile": "mongodb-legacy" })).unwrap();
    state.configs.write().await.insert(id.into(), config);
    let key = state.get_or_create_pool(id, Some(&database)).await.unwrap();
    let kind = match state.pool_handle(&key).await {
        Some(PoolKind::Agent(_)) => "agent",
        Some(PoolKind::MongoDb(_)) => "native",
        Some(_) => "other",
        None => "none",
    };
    assert_eq!(kind, "agent", "test must run over the legacy agent (pool key {key})");

    command(&state, id, &database, doc! { "create": "records", "validator": { "score": { "$gte": 0 } }, "validationLevel": "strict", "collation": { "locale": "en", "strength": 2 } }).await;
    command(&state, id, &database, doc! { "insert": "records", "documents": [
        { "_id": 1, "score": 1i64, "name": "first", "when": mongodb::bson::DateTime::from_millis(1_700_000_000_000) },
        { "_id": 2, "score": 2i64, "name": "second", "ratio": 0.5f64, "tags": ["a", "b"] },
    ] }).await;
    command(&state, id, &database, doc! { "createIndexes": "records", "indexes": [ { "key": { "name": 1, "score": -1 }, "name": "compound_unique", "unique": true }, { "key": { "expires": 1 }, "name": "ttl", "expireAfterSeconds": 3600 }] }).await;
    command(&state, id, &database, doc! { "create": "empty" }).await;
    command(&state, id, &database, doc! { "create": "capped", "capped": true, "size": 65536i64, "max": 100i64 }).await;
    command(&state, id, &database, doc! { "insert": "capped", "documents": [ { "_id": 1, "n": 1 } ] }).await;
    command(&state, id, &database, doc! { "insert": "odd/name", "documents": [ { "_id": mongodb::bson::oid::ObjectId::new(), "binary": mongodb::bson::Binary { subtype: mongodb::bson::spec::BinarySubtype::Generic, bytes: vec![1, 2, 3] }, "big": i64::MAX } ] }).await;
    command(&state, id, &database, doc! { "create": "z_view", "viewOn": "records", "pipeline": [ { "$match": { "score": { "$gte": 1 } } } ], "collation": { "locale": "en", "strength": 2 } }).await;
    command(&state, id, &database, doc! { "create": "a_nested", "viewOn": "z_view", "pipeline": [], "collation": { "locale": "en", "strength": 2 } }).await;
    let collections = ["records", "empty", "capped", "odd/name", "z_view", "a_nested"];

    let catalog = inspect_mongodb_database_dump(&state, id, &database).await.unwrap();
    assert_eq!(catalog.collections.len(), 6);

    let mut databases = vec![database.clone()];
    for format in [MongoDumpFormat::Directory, MongoDumpFormat::Archive] {
        for gzip in [false, true] {
            let tag = format!("{format:?}_{gzip}");
            let output = files.path().join(format!("legacy-{tag}"));
            let dump = MongoDatabaseDumpRequest {
                task_id: uuid::Uuid::new_v4().to_string(),
                connection_id: id.into(),
                database: database.clone(),
                file_path: output.to_str().unwrap().into(),
                format,
                gzip,
                collections: None,
            };
            let dumped = dump_mongodb_database(&state, &dump, |_| Box::pin(async { false }), |_| {}).await.unwrap();
            assert_eq!(dumped.collections_done, 6);
            assert_eq!(dumped.documents_read, 4);

            let preview = prepare_mongodb_restore_source(MongoRestoreSourceRequest {
                path: output.to_str().unwrap().into(),
                format,
                gzip,
            })
            .await
            .unwrap();
            let restored = format!("{database}_{tag}");
            databases.push(restored.clone());
            let request = MongoDatabaseRestoreRequest {
                task_id: uuid::Uuid::new_v4().to_string(),
                connection_id: id.into(),
                database: restored.clone(),
                source_database: database.clone(),
                source_ref: preview.source_ref.clone(),
                collections: None,
                drop_existing: false,
                restore_options: true,
                restore_indexes: true,
                stop_on_error: true,
                objcheck: gzip,
                batch_size: 500,
                execution_id: None,
            };
            let result =
                restore_mongodb_database(&state, &request, |_| Box::pin(async { false }), |_| {}).await.unwrap();
            assert_eq!(result.collections_done, 6);
            assert_eq!(result.documents_written, 4);
            assert_eq!(result.documents_failed, 0);
            assert_eq!(result.indexes_created, 2, "records: compound_unique + ttl; _id_ indexes are never recreated");
            for collection in collections {
                assert_eq!(
                    documents(&state, id, &database, collection).await,
                    documents(&state, id, &restored, collection).await,
                    "data: {tag} {collection}"
                );
                assert_eq!(
                    specs(&state, id, &database, collection).await,
                    specs(&state, id, &restored, collection).await,
                    "metadata: {tag} {collection}"
                );
            }

            // Selective restore with dropExisting replaces only the chosen collection.
            command(&state, id, &restored, doc! { "insert": "unselected", "documents": [ { "_id": "keep" } ] }).await;
            command(
                &state,
                id,
                &restored,
                doc! { "insert": "records", "documents": [ { "_id": 999, "score": 999, "name": "remove" } ] },
            )
            .await;
            let mut selected = request.clone();
            selected.drop_existing = true;
            selected.collections = Some(vec!["records".into()]);
            restore_mongodb_database(&state, &selected, |_| Box::pin(async { false }), |_| {}).await.unwrap();
            assert_eq!(
                documents(&state, id, &database, "records").await,
                documents(&state, id, &restored, "records").await
            );
            assert_eq!(documents(&state, id, &restored, "unselected").await.len(), 1);

            // Appending onto existing _ids reports each duplicate instead of silently succeeding.
            let mut duplicate = request.clone();
            duplicate.collections = Some(vec!["records".into()]);
            duplicate.stop_on_error = false;
            let appended =
                restore_mongodb_database(&state, &duplicate, |_| Box::pin(async { false }), |_| {}).await.unwrap();
            assert_eq!(appended.documents_written, 0);
            assert_eq!(appended.documents_failed, 2);
            assert_eq!(
                documents(&state, id, &database, "records").await,
                documents(&state, id, &restored, "records").await
            );

            assert!(release_mongodb_restore_source(&preview.source_ref));
            println!("legacy agent {tag}: six collections/views, BSON, options and indexes match");
        }
    }
    for database in databases {
        command(&state, id, &database, doc! { "dropDatabase": 1 }).await;
    }
}

#[tokio::test]
async fn database_source_rejects_invalid_metadata_and_view_cycles() {
    use dbx_core::mongodb_dump::*;
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("records.bson"), []).unwrap();
    let request = MongoRestoreSourceRequest {
        path: source.to_str().unwrap().into(),
        format: MongoDumpFormat::Directory,
        gzip: false,
    };
    for metadata in [
        r#"{"collectionName":"records","options":{"$db":"outside"},"indexes":[]}"#,
        r#"{"collectionName":"records","options":{},"indexes":[{"name":"bad"}]}"#,
        r#"{"collectionName":"records","type":"timeseries","options":{},"indexes":[]}"#,
    ] {
        std::fs::write(source.join("records.metadata.json"), metadata).unwrap();
        assert!(prepare_mongodb_restore_source(request.clone()).await.is_err());
    }
    std::fs::write(source.join("records.metadata.json"), r#"{"collectionName":"records","options":{},"indexes":[]}"#)
        .unwrap();
    std::fs::write(
        source.join("one.metadata.json"),
        r#"{"collectionName":"one","type":"view","options":{"viewOn":"two","pipeline":[]},"indexes":[]}"#,
    )
    .unwrap();
    std::fs::write(
        source.join("two.metadata.json"),
        r#"{"collectionName":"two","type":"view","options":{"viewOn":"one","pipeline":[]},"indexes":[]}"#,
    )
    .unwrap();
    let error = prepare_mongodb_restore_source(request).await.unwrap_err();
    assert!(error.contains("Cyclic"));
}

#[tokio::test]
async fn directory_preview_does_not_read_bson_and_source_identity_is_checked_before_restore() {
    use dbx_core::{connection::AppState, mongodb_dump::*, storage::Storage};
    let files = tempfile::tempdir().unwrap();
    let source = files.path().join("source");
    std::fs::create_dir(&source).unwrap();
    // Preview must succeed without opening/decoding this invalid gzip data.
    std::fs::write(source.join("records.bson.gz"), b"not gzip or BSON").unwrap();
    let preview = prepare_mongodb_restore_source(MongoRestoreSourceRequest {
        path: source.to_str().unwrap().into(),
        format: MongoDumpFormat::Directory,
        gzip: true,
    })
    .await
    .unwrap();
    assert_eq!(preview.catalog.collections[0].documents, None);
    assert_eq!(preview.catalog.collections[0].size_bytes, 16);
    let state = AppState::new(Storage::open(&files.path().join("state.db")).await.unwrap());
    let request: MongoDatabaseRestoreRequest = serde_json::from_value(serde_json::json!({
        "taskId":"validation-test", "connectionId":"missing", "database":"target", "sourceDatabase":"source",
        "sourceRef":preview.source_ref, "dropExisting":true
    }))
    .unwrap();
    let error = restore_mongodb_database(&state, &request, |_| Box::pin(async { false }), |_| {}).await.unwrap_err();
    assert!(
        !error.to_lowercase().contains("gzip"),
        "no pre-scan should run before the missing connection fails: {error}"
    );
    assert!(!request.objcheck, "objcheck is opt-in");
    std::fs::write(source.join("records.bson.gz"), []).unwrap();
    let error = restore_mongodb_database(&state, &request, |_| Box::pin(async { false }), |_| {}).await.unwrap_err();
    assert!(error.contains("changed"), "{error}");
    release_mongodb_restore_source(&preview.source_ref);
}

#[tokio::test]
async fn directory_catalog_accepts_large_manifest_without_data_and_binds_only_selected_upload() {
    use dbx_core::mongodb_dump::*;
    let owner = tempfile::tempdir().unwrap();
    let manifest = vec![
        MongoDumpFile { path: "source/selected.bson".into(), size_bytes: 0 },
        MongoDumpFile { path: "source/huge.bson".into(), size_bytes: 5 * 1024 * 1024 * 1024 },
    ];
    let preview = prepare_mongodb_directory_catalog(owner, manifest, false).await.unwrap();
    assert_eq!(preview.catalog.collections.len(), 2);
    assert!(preview.catalog.collections.iter().all(|c| c.documents.is_none()));
    let request: MongoDatabaseRestoreRequest = serde_json::from_value(serde_json::json!({
        "taskId":"upload-test", "connectionId":"missing", "database":"target", "sourceDatabase":"source",
        "sourceRef":preview.source_ref, "collections":["selected"]
    }))
    .unwrap();
    let upload = tempfile::tempdir().unwrap();
    std::fs::create_dir(upload.path().join("source")).unwrap();
    std::fs::write(upload.path().join("source/selected.bson"), []).unwrap();
    let acquired = attach_mongodb_restore_upload(&request, upload).await.unwrap();
    assert_eq!(acquired.catalog.collections.len(), 1);
    release_mongodb_restore_source(&acquired.source_ref);
    let changed = tempfile::tempdir().unwrap();
    std::fs::create_dir(changed.path().join("source")).unwrap();
    std::fs::write(changed.path().join("source/selected.bson"), b"changed").unwrap();
    assert!(attach_mongodb_restore_upload(&request, changed).await.unwrap_err().contains("differ"));
    release_mongodb_restore_source(&preview.source_ref);
}
