//! Shell commands that reach the MongoDB Legacy Agent through its generic `runCommand`,
//! driven through the same parse → dispatch path the query tab uses.
use dbx_core::{
    connection::{AppState, PoolKind},
    models::connection::ConnectionConfig,
    mongo_ops::{
        execute_mongo_command_core, mongo_collection_stats_core, mongo_create_database_core, mongo_list_databases_core,
        mongo_run_command_core,
    },
    mongo_shell,
    storage::Storage,
};
use mongodb::bson::{doc, Document};

async fn command(state: &AppState, id: &str, database: &str, command: Document) -> Document {
    let json = mongodb::bson::Bson::Document(command).into_canonical_extjson().to_string();
    let result = mongo_run_command_core(state, id, database, &json).await.unwrap();
    dbx_core::db::mongo_driver::json_object_to_document_extended_json(&result.extended_documents.unwrap()[0]).unwrap()
}

/// `runCommand` replies come back through the agent as relaxed Extended JSON, so integers lose
/// their width; compare numerically.
fn number(document: &Document, key: &str) -> Option<i64> {
    match document.get(key)? {
        mongodb::bson::Bson::Int32(n) => Some(i64::from(*n)),
        mongodb::bson::Bson::Int64(n) => Some(*n),
        mongodb::bson::Bson::Double(n) => Some(*n as i64),
        _ => None,
    }
}

async fn find_all(state: &AppState, id: &str, database: &str, collection: &str) -> Vec<Document> {
    let response = command(state, id, database, doc! { "find": collection, "sort": { "_id": 1 } }).await;
    response
        .get_document("cursor")
        .unwrap()
        .get_array("firstBatch")
        .unwrap()
        .iter()
        .map(|b| b.as_document().unwrap().clone())
        .collect()
}

async fn shell(state: &AppState, id: &str, database: &str, text: &str) -> Result<dbx_core::types::QueryResult, String> {
    let parsed = mongo_shell::parse(text)?;
    execute_mongo_command_core(state, id, database, &parsed, 100).await
}

#[tokio::test]
#[ignore = "opt-in: DBX_MONGO_LEGACY_DUMP_TEST_HOST (host:port, MongoDB 3.6+ without auth) and an installed MongoDB Legacy Agent; creates a temporary database"]
async fn find_and_modify_commands_run_over_the_legacy_agent() {
    let endpoint = std::env::var("DBX_MONGO_LEGACY_DUMP_TEST_HOST").expect("DBX_MONGO_LEGACY_DUMP_TEST_HOST");
    let (host, port) = endpoint.split_once(':').expect("host:port");
    let files = tempfile::tempdir().unwrap();
    let database = format!("dbx_legacy_fam_{}", uuid::Uuid::new_v4().simple());
    let state = AppState::new(Storage::open(&files.path().join("storage.db")).await.unwrap());
    let id = "legacy-find-and-modify-test";
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({ "id": id, "name": "Legacy findAndModify test", "db_type": "mongodb", "host": host, "port": port.parse::<u16>().unwrap(), "username": "", "password": "", "database": database, "driver_profile": "mongodb-legacy" })).unwrap();
    state.configs.write().await.insert(id.into(), config);
    let key = state.get_or_create_pool(id, Some(&database)).await.unwrap();
    assert!(matches!(state.pool_handle(&key).await, Some(PoolKind::Agent(_))), "test must run over the legacy agent");

    command(&state, id, &database, doc! { "insert": "users", "documents": [
        { "_id": 1, "name": "Ada", "score": 10i64, "tags": [ { "k": "a", "on": false }, { "k": "b", "on": false } ] },
        { "_id": 2, "name": "Grace", "score": 20i64 },
    ] }).await;

    // findOneAndUpdate: default returns the document before the change.
    let before = shell(&state, id, &database, "db.users.findOneAndUpdate({_id: 1}, {$inc: {score: 5}})").await.unwrap();
    assert_eq!(before.rows.len(), 1, "{before:?}");
    assert!(format!("{:?}", before.rows[0]).contains("10"), "pre-change score expected: {:?}", before.rows[0]);
    // …and with returnDocument: 'after', sort and projection: sort {_id: -1} must pick Grace.
    let after = shell(
        &state,
        id,
        &database,
        r#"db.users.findOneAndUpdate({}, {$set: {level: 2}}, {sort: {_id: -1}, returnDocument: "after", projection: {_id: 1, name: 1, level: 1}})"#,
    )
    .await
    .unwrap();
    assert_eq!(after.rows.len(), 1);
    let shown = format!("{:?}", after.rows[0]);
    assert!(shown.contains("Grace") && shown.contains("2") && !shown.contains("score"), "{shown}");
    let docs = find_all(&state, id, &database, "users").await;
    assert_eq!(number(&docs[0], "score"), Some(15));
    assert!(!docs[0].contains_key("level"), "sort honoured: Ada untouched");
    assert_eq!(number(&docs[1], "level"), Some(2));

    // arrayFilters must flip only tag "a".
    shell(
        &state,
        id,
        &database,
        r#"db.users.findOneAndUpdate({_id: 1}, {$set: {"tags.$[t].on": true}}, {arrayFilters: [{"t.k": "a"}]})"#,
    )
    .await
    .unwrap();
    let ada = &find_all(&state, id, &database, "users").await[0];
    assert_eq!(ada.get_array("tags").unwrap()[0].as_document().unwrap().get_bool("on"), Ok(true));
    assert_eq!(ada.get_array("tags").unwrap()[1].as_document().unwrap().get_bool("on"), Ok(false));

    // A server-side failure comes back as the server's own message.
    let server_error = shell(
        &state,
        id,
        &database,
        r#"db.users.findOneAndUpdate({_id: 2}, {$set: {"tags.$[t].on": true}}, {arrayFilters: [{"t.k": "a"}]})"#,
    )
    .await
    .unwrap_err();
    assert!(server_error.contains("must exist in the document"), "{server_error}");

    // upsert creates when nothing matches.
    let upserted = shell(
        &state,
        id,
        &database,
        r#"db.users.findOneAndUpdate({_id: 3}, {$set: {name: "Linus"}}, {upsert: true, new: true})"#,
    )
    .await
    .unwrap();
    assert_eq!(upserted.rows.len(), 1);
    assert_eq!(find_all(&state, id, &database, "users").await.len(), 3);

    // No match, no upsert: empty result, not an error.
    let missing = shell(&state, id, &database, "db.users.findOneAndUpdate({_id: 99}, {$set: {x: 1}})").await.unwrap();
    assert_eq!(missing.rows.len(), 0);

    // findOneAndReplace replaces the whole document.
    let replaced = shell(
        &state,
        id,
        &database,
        r#"db.users.findOneAndReplace({_id: 2}, {name: "Grace H", level: 1}, {returnDocument: "after"})"#,
    )
    .await
    .unwrap();
    assert_eq!(replaced.rows.len(), 1);
    let grace = &find_all(&state, id, &database, "users").await[1];
    assert_eq!(grace.get_str("name"), Ok("Grace H"));
    assert!(!grace.contains_key("score"), "replacement drops old fields: {grace}");
    // A replacement carrying update operators is refused before reaching the server.
    let refused =
        shell(&state, id, &database, r#"db.users.findOneAndReplace({_id: 2}, {$set: {name: "x"}})"#).await.unwrap_err();
    assert!(refused.contains("update operators"), "{refused}");

    // findOneAndDelete removes and returns the matched document (with projection and sort).
    let deleted =
        shell(&state, id, &database, r#"db.users.findOneAndDelete({}, {sort: {_id: -1}, projection: {name: 1}})"#)
            .await
            .unwrap();
    assert_eq!(deleted.rows.len(), 1);
    assert!(format!("{:?}", deleted.rows[0]).contains("Linus"), "highest _id deleted first: {:?}", deleted.rows[0]);
    assert_eq!(find_all(&state, id, &database, "users").await.len(), 2);

    command(&state, id, &database, doc! { "dropDatabase": 1 }).await;
}

#[tokio::test]
#[ignore = "opt-in: DBX_MONGO_LEGACY_DUMP_TEST_HOST (host:port, MongoDB 3.6+ without auth) and an installed MongoDB Legacy Agent; creates a temporary database"]
async fn distinct_runs_over_the_legacy_agent() {
    let endpoint = std::env::var("DBX_MONGO_LEGACY_DUMP_TEST_HOST").expect("DBX_MONGO_LEGACY_DUMP_TEST_HOST");
    let (host, port) = endpoint.split_once(':').expect("host:port");
    let files = tempfile::tempdir().unwrap();
    let database = format!("dbx_legacy_distinct_{}", uuid::Uuid::new_v4().simple());
    let state = AppState::new(Storage::open(&files.path().join("storage.db")).await.unwrap());
    let id = "legacy-distinct-test";
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({ "id": id, "name": "Legacy distinct test", "db_type": "mongodb", "host": host, "port": port.parse::<u16>().unwrap(), "username": "", "password": "", "database": database, "driver_profile": "mongodb-legacy" })).unwrap();
    state.configs.write().await.insert(id.into(), config);
    let key = state.get_or_create_pool(id, Some(&database)).await.unwrap();
    assert!(matches!(state.pool_handle(&key).await, Some(PoolKind::Agent(_))), "test must run over the legacy agent");

    command(
        &state,
        id,
        &database,
        doc! { "insert": "orders", "documents": [
            { "_id": 1, "status": "open", "tags": ["a", "b"], "meta": { "region": "eu" } },
            { "_id": 2, "status": "closed", "tags": ["b"], "meta": { "region": "us" } },
            { "_id": 3, "status": "open", "tags": [], "meta": { "region": "eu" } },
        ] },
    )
    .await;

    let statuses = shell(&state, id, &database, r#"db.orders.distinct("status")"#).await.unwrap();
    let mut shown: Vec<String> = statuses.rows.iter().map(|row| format!("{:?}", row[0])).collect();
    shown.sort();
    assert_eq!(shown.len(), 2, "{statuses:?}");
    assert!(shown[0].contains("closed") && shown[1].contains("open"), "{shown:?}");

    // Array fields are flattened and a filter narrows the input, as the native helper does.
    let tags = shell(&state, id, &database, r#"db.orders.distinct("tags", {status: "open"})"#).await.unwrap();
    let mut tags: Vec<String> = tags.rows.iter().map(|row| format!("{:?}", row[0])).collect();
    tags.sort();
    assert_eq!(tags.len(), 2, "{tags:?}");

    // Dotted paths reach nested fields.
    let regions = shell(&state, id, &database, r#"db.orders.distinct("meta.region")"#).await.unwrap();
    assert_eq!(regions.rows.len(), 2, "{regions:?}");

    // No matches: empty result, not an error.
    let none = shell(&state, id, &database, r#"db.orders.distinct("status", {status: "missing"})"#).await.unwrap();
    assert_eq!(none.rows.len(), 0);

    command(&state, id, &database, doc! { "dropDatabase": 1 }).await;
}

#[tokio::test]
#[ignore = "opt-in: DBX_MONGO_LEGACY_DUMP_TEST_HOST (host:port, MongoDB 3.6+ without auth) and an installed MongoDB Legacy Agent; creates temporary databases"]
async fn collection_stats_and_create_database_run_over_the_legacy_agent() {
    let endpoint = std::env::var("DBX_MONGO_LEGACY_DUMP_TEST_HOST").expect("DBX_MONGO_LEGACY_DUMP_TEST_HOST");
    let (host, port) = endpoint.split_once(':').expect("host:port");
    let files = tempfile::tempdir().unwrap();
    let database = format!("dbx_legacy_admin_{}", uuid::Uuid::new_v4().simple());
    let state = AppState::new(Storage::open(&files.path().join("storage.db")).await.unwrap());
    let id = "legacy-admin-test";
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({ "id": id, "name": "Legacy admin test", "db_type": "mongodb", "host": host, "port": port.parse::<u16>().unwrap(), "username": "", "password": "", "database": database, "driver_profile": "mongodb-legacy" })).unwrap();
    state.configs.write().await.insert(id.into(), config);
    let key = state.get_or_create_pool(id, Some(&database)).await.unwrap();
    assert!(matches!(state.pool_handle(&key).await, Some(PoolKind::Agent(_))), "test must run over the legacy agent");

    command(
        &state,
        id,
        &database,
        doc! { "insert": "orders", "documents": [ { "_id": 1, "n": 1 }, { "_id": 2, "n": 2 }, { "_id": 3, "n": 3 } ] },
    )
    .await;
    command(
        &state,
        id,
        &database,
        doc! { "createIndexes": "orders", "indexes": [ { "key": { "n": 1 }, "name": "n_1" } ] },
    )
    .await;

    // The database view's object statistics take the same numbers per collection, skipping views.
    command(&state, id, &database, doc! { "create": "orders_view", "viewOn": "orders", "pipeline": [] }).await;
    command(&state, id, &database, doc! { "create": "empty" }).await;
    let mut objects = dbx_core::schema::list_object_statistics_core(&state, id, &database, "").await.unwrap();
    objects.sort_by(|a, b| a.name.cmp(&b.name));
    // `system.views` is a real collection and is listed on the native path too; the view is not.
    let names: Vec<&str> = objects.iter().map(|o| o.name.as_str()).collect();
    assert!(!names.contains(&"orders_view"), "views own no storage and are skipped: {names:?}");
    let by_name =
        |name: &str| objects.iter().find(|o| o.name == name).unwrap_or_else(|| panic!("{name} missing: {names:?}"));
    assert_eq!(by_name("orders").estimated_rows, Some(3), "{objects:?}");
    assert!(by_name("orders").total_bytes.is_some_and(|bytes| bytes > 0), "{objects:?}");
    assert_eq!(by_name("orders").schema.as_deref(), Some(database.as_str()));
    assert_eq!(by_name("empty").estimated_rows, Some(0), "{objects:?}");

    let stats = mongo_collection_stats_core(&state, id, &database, "orders", None).await.unwrap();
    assert_eq!(stats.count, serde_json::json!(3), "{stats:?}");
    assert_eq!(stats.nindexes, serde_json::json!(2), "{stats:?}");
    assert!(stats.size.as_u64().is_some_and(|size| size > 0), "{stats:?}");
    // scale divides byte sizes; count and index count are unaffected.
    let scaled = mongo_collection_stats_core(&state, id, &database, "orders", Some(serde_json::Number::from(1024)))
        .await
        .unwrap();
    assert_eq!(scaled.count, serde_json::json!(3));
    assert!(scaled.storage_size.as_u64().unwrap() <= stats.storage_size.as_u64().unwrap());
    let missing = mongo_collection_stats_core(&state, id, &database, "no_such_collection", None).await.unwrap_err();
    assert!(
        missing.contains("not found") || missing.contains("ns not found") || missing.contains("NamespaceNotFound"),
        "{missing}"
    );

    // Create database: the new database becomes visible with its placeholder collection.
    let created = format!("{database}_created");
    mongo_create_database_core(&state, id, &created).await.unwrap();
    let databases = mongo_list_databases_core(&state, id).await.unwrap();
    assert!(databases.iter().any(|name| name == &created), "{databases:?}");
    let listed = command(&state, id, &created, doc! { "listCollections": 1 }).await;
    let names: Vec<String> = listed
        .get_document("cursor")
        .unwrap()
        .get_array("firstBatch")
        .unwrap()
        .iter()
        .map(|b| b.as_document().unwrap().get_str("name").unwrap().to_string())
        .collect();
    assert_eq!(names, vec!["dbx_init"]);
    assert!(mongo_create_database_core(&state, id, "   ").await.unwrap_err().contains("Database name is required"));

    command(&state, id, &created, doc! { "dropDatabase": 1 }).await;
    command(&state, id, &database, doc! { "dropDatabase": 1 }).await;
}

/// MongoDB pools are keyed `<connection id>:<database>`. Dump, restore and collection
/// import/export used to resolve the pool by the bare connection id instead, which only worked
/// while some earlier call happened to have left a pool under that key.
#[tokio::test]
#[ignore = "opt-in: DBX_MONGO_LEGACY_DUMP_TEST_HOST (host:port, MongoDB 3.6+ without auth) and an installed MongoDB Legacy Agent; creates a temporary database"]
async fn dump_and_export_resolve_the_per_database_pool() {
    use dbx_core::mongodb_dump::*;

    let endpoint = std::env::var("DBX_MONGO_LEGACY_DUMP_TEST_HOST").expect("DBX_MONGO_LEGACY_DUMP_TEST_HOST");
    let (host, port) = endpoint.split_once(':').expect("host:port");
    let files = tempfile::tempdir().unwrap();
    let database = format!("dbx_legacy_pool_{}", uuid::Uuid::new_v4().simple());
    let state = AppState::new(Storage::open(&files.path().join("storage.db")).await.unwrap());
    let id = "legacy-pool-key-test";
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({ "id": id, "name": "Legacy pool key test", "db_type": "mongodb", "host": host, "port": port.parse::<u16>().unwrap(), "username": "", "password": "", "database": database, "driver_profile": "mongodb-legacy" })).unwrap();
    state.configs.write().await.insert(id.into(), config);

    command(
        &state,
        id,
        &database,
        doc! { "insert": "orders", "documents": [ { "_id": 1, "n": 1 }, { "_id": 2, "n": 2 } ] },
    )
    .await;

    // Seeding went through the bare-connection pool. Drop it, leaving only the per-database pool
    // the dump itself creates — the state the app is normally in.
    state.remove_pool_by_key(id).await;
    let key = state.get_or_create_pool(id, Some(&database)).await.unwrap();
    assert_eq!(key, format!("{id}:{database}"), "MongoDB pools are keyed per database");
    assert!(
        state.pool_handle(id).await.is_none(),
        "the bare-connection pool must be gone for this test to mean anything"
    );

    let catalog = inspect_mongodb_database_dump(&state, id, &database).await.unwrap();
    assert_eq!(catalog.collections.len(), 1, "{catalog:?}");

    let output = files.path().join("pool-key.archive");
    let dump = MongoDatabaseDumpRequest {
        task_id: uuid::Uuid::new_v4().to_string(),
        connection_id: id.into(),
        database: database.clone(),
        file_path: output.to_str().unwrap().into(),
        format: MongoDumpFormat::Archive,
        gzip: false,
        collections: None,
    };
    let dumped = dump_mongodb_database(&state, &dump, |_| Box::pin(async { false }), |_| {}).await.unwrap();
    assert_eq!(dumped.collections_done, 1);
    assert_eq!(dumped.documents_read, 2);

    // Restore writes through the same lookup.
    let preview = prepare_mongodb_restore_source(MongoRestoreSourceRequest {
        path: output.to_str().unwrap().into(),
        format: MongoDumpFormat::Archive,
        gzip: false,
    })
    .await
    .unwrap();
    let restored = format!("{database}_restored");
    let restore = MongoDatabaseRestoreRequest {
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
        objcheck: false,
        batch_size: 500,
        execution_id: None,
    };
    let result = restore_mongodb_database(&state, &restore, |_| Box::pin(async { false }), |_| {}).await.unwrap();
    assert_eq!(result.documents_written, 2);
    assert!(release_mongodb_restore_source(&preview.source_ref));

    command(&state, id, &restored, doc! { "dropDatabase": 1 }).await;
    command(&state, id, &database, doc! { "dropDatabase": 1 }).await;
}
