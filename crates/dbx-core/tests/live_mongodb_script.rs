#![cfg(feature = "mongo-script")]

use std::sync::Arc;

use dbx_core::connection::{AppState, PoolKind};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::mongo_script::{execute_mongo_script_core, MongoScriptOptions};
use mongodb::Client;

fn live_mongodb_config(id: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_MONGODB_HOST").expect("DBX_LIVE_MONGODB_HOST");
    let port = std::env::var("DBX_LIVE_MONGODB_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(27017);
    let username = std::env::var("DBX_LIVE_MONGODB_USER").expect("DBX_LIVE_MONGODB_USER");
    let password = std::env::var("DBX_LIVE_MONGODB_PASSWORD").expect("DBX_LIVE_MONGODB_PASSWORD");
    let database = std::env::var("DBX_LIVE_MONGODB_DATABASE").expect("DBX_LIVE_MONGODB_DATABASE");
    let auth_source = std::env::var("DBX_LIVE_MONGODB_AUTH_SOURCE").unwrap_or_else(|_| database.clone());

    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": "Live MongoDB script",
        "db_type": DatabaseType::MongoDb,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": database,
        "url_params": format!("authSource={auth_source}"),
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live MongoDB connection config should deserialize")
}

/// Scripts share one process-wide admission (a few runtimes at once), so live tests run one at
/// a time: otherwise a queued script spends its timeout waiting for a slot.
async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    static LIVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    LIVE.lock().await
}

async fn live_state(id: &str) -> (Arc<AppState>, ConnectionConfig, Client, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let config = live_mongodb_config(id);
    let client = Client::with_uri_str(config.connection_url()).await.unwrap();
    state.configs.write().await.insert(config.id.clone(), config.clone());
    state
        .update_connection_pools(|connections| {
            connections.insert(config.id.clone(), PoolKind::MongoDb(client.clone()));
        })
        .await;
    (state, config, client, directory)
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a writable MongoDB database"]
async fn iife_script_inserts_updates_reads_and_cleans_up() {
    let _serial = serial().await;
    let (state, config, client, _directory) = live_state("live-mongodb-script").await;
    let database = config.database.clone().expect("database");
    let collection = format!("script_live_{}", std::process::id());
    let script = format!(
        r#"(function () {{
  var c = db.getCollection("{collection}");
  c.insertMany([{{ n: 1, tag: "a" }}, {{ n: 2, tag: "b" }}, {{ n: 3, tag: "a" }}]);
  var docs = c.find({{ tag: "a" }}).sort({{ n: -1 }}).toArray();
  docs.forEach(function (d) {{ c.updateOne({{ _id: d._id }}, {{ $set: {{ seen: true }} }}); }});
  var seen = c.countDocuments({{ seen: true }});
  c.deleteMany({{ tag: "b" }});
  var left = c.find({{}}).toArray().map(function (d) {{ return d.n; }});
  return {{ docs: docs.length, seen: seen, left: left.sort() }};
}})()"#
    );

    let result =
        execute_mongo_script_core(state, &config.id, &database, &script, MongoScriptOptions::default(), None).await;
    client.database(&database).collection::<mongodb::bson::Document>(&collection).drop().await.unwrap();
    let result = result.unwrap();

    let row = result
        .columns
        .iter()
        .cloned()
        .zip(result.rows[0].iter().cloned())
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(row["docs"], serde_json::json!(2));
    assert_eq!(row["seen"], serde_json::json!(2));
    assert_eq!(row["left"], serde_json::json!([1, 3]));
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a writable MongoDB database"]
async fn script_cannot_bypass_the_unbounded_filter_guard() {
    let _serial = serial().await;
    let (state, config, _client, _directory) = live_state("live-mongodb-script-guard").await;
    let database = config.database.clone().expect("database");
    let collection = format!("script_guard_{}", std::process::id());
    let script = format!(r#"(function () {{ db.getCollection("{collection}").deleteMany({{}}); }})()"#);

    let error = execute_mongo_script_core(state, &config.id, &database, &script, MongoScriptOptions::default(), None)
        .await
        .unwrap_err();

    assert!(error.contains("blocked"), "{error}");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a writable MongoDB database"]
async fn script_cannot_drop_a_collection_without_confirmation() {
    let _serial = serial().await;
    let (state, config, _client, _directory) = live_state("live-mongodb-script-drop").await;
    let database = config.database.clone().expect("database");
    let collection = format!("script_drop_{}", std::process::id());
    let script = format!(r#"(function () {{ db.getCollection("{collection}").drop(); }})()"#);

    let error = execute_mongo_script_core(state, &config.id, &database, &script, MongoScriptOptions::default(), None)
        .await
        .unwrap_err();

    assert!(error.contains("blocked"), "{error}");
}

/// Reads "Confirmed completed operations: N" back out of a script error.
fn confirmed_completed(error: &str) -> usize {
    let marker = "Confirmed completed operations: ";
    let start = error.find(marker).unwrap_or_else(|| panic!("no progress in: {error}")) + marker.len();
    error[start..].split_whitespace().next().unwrap().parse().unwrap()
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a writable MongoDB database"]
async fn sibling_database_writes_follow_the_production_marker_of_the_target_database() {
    let _serial = serial().await;
    let (state, mut config, client, _directory) = live_state("live-mongodb-script-production").await;
    let production = config.database.clone().expect("database");
    // The script runs from a staging database; only the sibling it writes to is production.
    config.production_databases = vec![production.clone()];
    state.configs.write().await.insert(config.id.clone(), config.clone());
    let collection = format!("script_prod_{}", std::process::id());
    let script = format!(r#"db.getSiblingDB("{production}").getCollection("{collection}").insertOne({{ a: 1 }})"#);
    let documents = client.database(&production).collection::<mongodb::bson::Document>(&collection);

    let error = execute_mongo_script_core(
        state.clone(),
        &config.id,
        "dbx_script_staging",
        &script,
        MongoScriptOptions::default(),
        None,
    )
    .await
    .unwrap_err();
    assert!(error.contains("production database"), "{error}");
    assert_eq!(documents.count_documents(mongodb::bson::doc! {}).await.unwrap(), 0, "nothing may be written");

    let confirmed = MongoScriptOptions { confirmed_production_writes: true, ..Default::default() };
    let result = execute_mongo_script_core(state, &config.id, "dbx_script_staging", &script, confirmed, None).await;
    let written = documents.count_documents(mongodb::bson::doc! {}).await.unwrap();
    documents.drop().await.unwrap();
    result.unwrap();
    assert_eq!(written, 1);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a writable MongoDB database"]
async fn canceled_script_reports_the_writes_that_reached_the_server() {
    let _serial = serial().await;
    let (state, config, client, _directory) = live_state("live-mongodb-script-cancel").await;
    let database = config.database.clone().expect("database");
    let collection = format!("script_cancel_{}", std::process::id());
    let script = format!(r#"for (var i = 0; i < 100000; i++) db.getCollection("{collection}").insertOne({{ i: i }});"#);
    let cancel = tokio_util::sync::CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        trigger.cancel();
    });

    let error =
        execute_mongo_script_core(state, &config.id, &database, &script, MongoScriptOptions::default(), Some(cancel))
            .await
            .unwrap_err();
    let documents = client.database(&database).collection::<mongodb::bson::Document>(&collection);
    let written = documents.count_documents(mongodb::bson::doc! {}).await.unwrap() as usize;
    documents.drop().await.unwrap();

    assert!(error.starts_with(dbx_core::query::QUERY_CANCELED), "{error}");
    let confirmed = confirmed_completed(&error);
    assert!(confirmed > 0, "{error}");
    // Every confirmed write is in the database; at most the interrupted one is unaccounted for.
    let unknown = usize::from(error.contains("Outcome unknown"));
    assert!(written >= confirmed && written <= confirmed + unknown, "written={written} confirmed={confirmed}: {error}");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a writable MongoDB database"]
async fn timed_out_script_reports_the_writes_that_reached_the_server() {
    let _serial = serial().await;
    let (state, config, client, _directory) = live_state("live-mongodb-script-timeout").await;
    let database = config.database.clone().expect("database");
    let collection = format!("script_timeout_{}", std::process::id());
    let script = format!(r#"for (var i = 0; i < 100000; i++) db.getCollection("{collection}").insertOne({{ i: i }});"#);
    let options = MongoScriptOptions { timeout_ms: Some(800), ..Default::default() };

    let error = execute_mongo_script_core(state, &config.id, &database, &script, options, None).await.unwrap_err();
    let documents = client.database(&database).collection::<mongodb::bson::Document>(&collection);
    let written = documents.count_documents(mongodb::bson::doc! {}).await.unwrap() as usize;
    documents.drop().await.unwrap();

    assert!(error.contains("timed out after 800 ms"), "{error}");
    let confirmed = confirmed_completed(&error);
    let unknown = usize::from(error.contains("Outcome unknown"));
    assert!(written >= confirmed && written <= confirmed + unknown, "written={written} confirmed={confirmed}: {error}");
}

fn row_map(
    result: &dbx_core::types::QueryResult,
    index: usize,
) -> std::collections::BTreeMap<String, serde_json::Value> {
    result.columns.iter().cloned().zip(result.rows[index].iter().cloned()).collect()
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a writable MongoDB database"]
async fn documents_read_and_written_back_keep_their_bson_types() {
    let _serial = serial().await;
    use mongodb::bson::{doc, Binary, Bson, DateTime, Document};
    let (state, config, client, _directory) = live_state("live-mongodb-script-types").await;
    let database = config.database.clone().expect("database");
    let collection = format!("script_types_{}", std::process::id());
    let documents = client.database(&database).collection::<Document>(&collection);
    let original = doc! {
        "_id": 1,
        "at": DateTime::from_millis(1_600_000_000_123),
        "big": 9_007_199_254_740_993_i64,
        "small64": 5_i64,
        "i32": 5_i32,
        "dbl": 1.5_f64,
        "oid": mongodb::bson::oid::ObjectId::new(),
        "nested": { "x": 1_i32, "arr": [1_i32, 2_i32] },
        "bin": Bson::Binary(Binary { subtype: mongodb::bson::spec::BinarySubtype::Generic, bytes: vec![1, 2, 3] }),
        "dec": Bson::Decimal128("1.10".parse().unwrap()),
        "ts": Bson::Timestamp(mongodb::bson::Timestamp { time: 1, increment: 2 }),
    };
    documents.insert_one(original.clone()).await.unwrap();
    let script = format!(
        r#"var c = db.getCollection("{collection}"); var d = c.findOne({{ _id: 1 }}); d._id = 2; c.insertOne(d);
           c.updateOne({{ _id: 2, oid: d.oid, at: d.at }}, {{ $set: {{ touched: true }} }}).matchedCount"#
    );

    let result =
        execute_mongo_script_core(state, &config.id, &database, &script, MongoScriptOptions::default(), None).await;
    let copy = documents.find_one(doc! { "_id": 2 }).await.unwrap();
    documents.drop().await.unwrap();
    let result = result.unwrap();

    assert_eq!(result.rows, vec![vec![serde_json::json!(1)]], "typed values must match in filters");
    let copy = copy.expect("copy");
    for (key, value) in original.iter().filter(|(key, _)| key.as_str() != "_id") {
        assert_eq!(copy.get(key), Some(value), "{key} changed: {copy:?}");
    }
    assert_eq!(copy.len(), original.len() + 1, "no extra fields besides `touched`: {copy:?}");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a writable MongoDB database"]
async fn copying_heterogeneous_documents_adds_no_null_fields() {
    let _serial = serial().await;
    use mongodb::bson::{doc, Document};
    let (state, config, client, _directory) = live_state("live-mongodb-script-heterogeneous").await;
    let database = config.database.clone().expect("database");
    let source = format!("script_het_src_{}", std::process::id());
    let target = format!("script_het_dst_{}", std::process::id());
    let db = client.database(&database);
    db.collection::<Document>(&source)
        .insert_many(vec![doc! { "_id": 1, "a": 1 }, doc! { "_id": 2, "b": 2 }])
        .await
        .unwrap();
    let script = format!(
        r#"db.getCollection("{source}").find({{}}).forEach(function (d) {{ db.getCollection("{target}").insertOne(d); }})"#
    );

    let result =
        execute_mongo_script_core(state, &config.id, &database, &script, MongoScriptOptions::default(), None).await;
    let copied = db.collection::<Document>(&target).find(doc! {}).sort(doc! { "_id": 1 }).await.unwrap();
    let copied: Vec<Document> = futures::TryStreamExt::try_collect(copied).await.unwrap();
    db.collection::<Document>(&source).drop().await.unwrap();
    db.collection::<Document>(&target).drop().await.unwrap();
    result.unwrap();

    assert_eq!(copied, vec![doc! { "_id": 1, "a": 1 }, doc! { "_id": 2, "b": 2 }]);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a writable MongoDB database"]
async fn reads_over_the_row_limit_fail_instead_of_dropping_documents() {
    let _serial = serial().await;
    use mongodb::bson::{doc, Document};
    let (state, config, client, _directory) = live_state("live-mongodb-script-row-limit").await;
    let database = config.database.clone().expect("database");
    let collection = format!("script_rows_{}", std::process::id());
    let documents = client.database(&database).collection::<Document>(&collection);
    documents.insert_many((0..1500).map(|i| doc! { "i": i }).collect::<Vec<_>>()).await.unwrap();
    let run = |script: String, options: MongoScriptOptions| {
        let (state, id, database) = (state.clone(), config.id.clone(), database.clone());
        async move { execute_mongo_script_core(state, &id, &database, &script, options, None).await }
    };
    let c = format!(r#"db.getCollection("{collection}")"#);

    let over =
        run(format!("var n = 0; {c}.find({{}}).forEach(function () {{ n++; }}); n"), MongoScriptOptions::default())
            .await;
    let aggregate =
        run(format!("{c}.aggregate([{{ $match: {{}} }}]).toArray().length"), MongoScriptOptions::default()).await;
    let counted = run(
        format!("({{ count: {c}.find({{}}).count(), itcount: {c}.find({{}}).limit(10).itcount() }})"),
        MongoScriptOptions::default(),
    )
    .await;
    let raised = run(
        format!("var n = 0; {c}.find({{}}).forEach(function () {{ n++; }}); n"),
        MongoScriptOptions { max_rows: Some(2_000), ..Default::default() },
    )
    .await;
    let displayed = run(format!("{c}.find({{}})"), MongoScriptOptions::default()).await;
    documents.drop().await.unwrap();

    for error in [over.unwrap_err(), aggregate.unwrap_err()] {
        assert!(error.contains("more than 1000 documents"), "{error}");
    }
    let counted = row_map(&counted.unwrap(), 0);
    assert_eq!(
        (counted["count"].clone(), counted["itcount"].clone()),
        (serde_json::json!(1500), serde_json::json!(10))
    );
    assert_eq!(raised.unwrap().rows, vec![vec![serde_json::json!(1500)]]);
    // The completion value is only displayed, so it is cut to the limit and flagged.
    let displayed = displayed.unwrap();
    assert_eq!(displayed.rows.len(), 1000);
    assert!(displayed.truncated);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a writable MongoDB database"]
async fn write_results_report_the_servers_counts() {
    let _serial = serial().await;
    let (state, config, client, _directory) = live_state("live-mongodb-script-write-results").await;
    let database = config.database.clone().expect("database");
    let collection = format!("script_write_results_{}", std::process::id());
    let script = format!(
        r#"var c = db.getCollection("{collection}");
           var inserted = c.insertOne({{ a: 1 }});
           var noop = c.updateOne({{ a: 1 }}, {{ $set: {{ a: 1 }} }});
           var upsert = c.updateOne({{ a: 2 }}, {{ $set: {{ b: 1 }} }}, {{ upsert: true }});
           var deleted = c.deleteMany({{ a: {{ $in: [1, 2] }} }});
           ({{ insertedFound: c.countDocuments({{ _id: inserted.insertedId }}) === 0 ? "deleted" : "kept",
              noopMatched: noop.matchedCount, noopModified: noop.modifiedCount,
              upserted: upsert.upsertedCount, upsertedIsId: upsert.upsertedId instanceof ObjectId,
              deleted: deleted.deletedCount }})"#
    );

    let result =
        execute_mongo_script_core(state, &config.id, &database, &script, MongoScriptOptions::default(), None).await;
    client.database(&database).collection::<mongodb::bson::Document>(&collection).drop().await.unwrap();
    let row = row_map(&result.unwrap(), 0);

    assert_eq!(row["insertedFound"], serde_json::json!("deleted"));
    assert_eq!(row["noopMatched"], serde_json::json!(1));
    assert_eq!(row["noopModified"], serde_json::json!(0));
    assert_eq!(row["upserted"], serde_json::json!(1));
    assert_eq!(row["upsertedIsId"], serde_json::json!(true));
    assert_eq!(row["deleted"], serde_json::json!(2));
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a writable MongoDB database"]
async fn a_duplicate_key_write_is_reported_as_failed_not_unknown() {
    let _serial = serial().await;
    let (state, config, client, _directory) = live_state("live-mongodb-script-duplicate").await;
    let database = config.database.clone().expect("database");
    let collection = format!("script_duplicate_{}", std::process::id());
    let script =
        format!(r#"var c = db.getCollection("{collection}"); c.insertOne({{ _id: 7 }}); c.insertOne({{ _id: 7 }});"#);

    let error = execute_mongo_script_core(state, &config.id, &database, &script, MongoScriptOptions::default(), None)
        .await
        .unwrap_err();
    client.database(&database).collection::<mongodb::bson::Document>(&collection).drop().await.unwrap();

    assert!(error.contains("E11000"), "{error}");
    assert_eq!(confirmed_completed(&error), 1, "{error}");
    assert!(!error.contains("Outcome unknown"), "{error}");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a writable MongoDB database"]
async fn a_script_that_catches_a_failed_write_still_reports_its_writes() {
    let _serial = serial().await;
    let (state, config, client, _directory) = live_state("live-mongodb-script-caught").await;
    let database = config.database.clone().expect("database");
    let collection = format!("script_caught_{}", std::process::id());
    let script = format!(
        r#"var c = db.getCollection("{collection}");
           c.insertOne({{ _id: 7 }});
           try {{ c.insertOne({{ _id: 7 }}); }} catch (e) {{ print("duplicate skipped"); }}
           c.insertOne({{ _id: 8 }});
           undefined;"#
    );

    let result =
        execute_mongo_script_core(state, &config.id, &database, &script, MongoScriptOptions::default(), None).await;
    client.database(&database).collection::<mongodb::bson::Document>(&collection).drop().await.unwrap();
    let result = result.unwrap();

    assert_eq!(result.rows, vec![vec![serde_json::json!("duplicate skipped")]]);
    let messages: Vec<_> =
        result.messages.iter().map(|message| (message.code.clone(), message.message.clone())).collect();
    // The rejected duplicate is a known failure, so only the confirmed writes are reported.
    assert_eq!(
        messages,
        vec![(Some("MONGO_SCRIPT_WRITES".to_string()), "Confirmed completed operations: 2 (2 writes).".to_string())]
    );
}
