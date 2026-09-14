use std::io::Write;
use std::path::Path;

use dbx_core::mongodb_import_export::{
    for_each_mongodb_import_document, preview_mongodb_import_file, MongoImportFormat, MongoImportIssue,
    MongoImportParseOptions, MongoImportPreviewRequest,
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

fn read(path: &Path) -> Result<Vec<Document>, MongoImportIssue> {
    let mut documents = Vec::new();
    for_each_mongodb_import_document(
        path.to_str().unwrap(),
        MongoImportFormat::Bson,
        &MongoImportParseOptions::default(),
        |parsed| {
            documents.push(parsed?.document);
            Ok(())
        },
    )?;
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
        let error = for_each_mongodb_import_document(
            path.to_str().unwrap(),
            MongoImportFormat::Bson,
            &MongoImportParseOptions { skip_error_rows: Some(true), ..Default::default() },
            |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(error.code, "BSON_STRUCTURE");
        assert_eq!(error.row, Some(2));
    }
}

fn run_tool(tools: &Path, name: &str, args: &[&str]) {
    let output = std::process::Command::new(tools.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)))
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("cannot run {name}: {error}"));
    assert!(output.status.success(), "{name}: {}", String::from_utf8_lossy(&output.stderr));
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
