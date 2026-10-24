use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

type Reply = Box<dyn Fn(&str, &MongoScriptControl) -> HostReply + Send + Sync>;

struct FakeBackend {
    calls: Mutex<Vec<(String, bool)>>,
    reply: Reply,
}

impl FakeBackend {
    fn new(reply: impl Fn(&str, &MongoScriptControl) -> HostReply + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { calls: Mutex::new(Vec::new()), reply: Box::new(reply) })
    }
    fn replying(body: impl Fn(&str) -> String + Send + Sync + 'static) -> Arc<Self> {
        Self::new(move |source, _| HostReply { body: body(source), outcome: HostOutcome::Completed { write: false } })
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().iter().map(|(source, _)| source.clone()).collect()
    }
    fn display_flags(&self) -> Vec<bool> {
        self.calls.lock().unwrap().iter().map(|(_, display)| *display).collect()
    }
}

impl MongoScriptBackend for FakeBackend {
    fn exec(&self, shell_source: &str, display: bool, control: &MongoScriptControl) -> HostReply {
        self.calls.lock().unwrap().push((shell_source.to_string(), display));
        (self.reply)(shell_source, control)
    }
}

fn docs_reply(docs: Value) -> String {
    serde_json::json!({ "docs": docs }).to_string()
}

fn write_reply() -> HostReply {
    HostReply {
        body: serde_json::json!({ "write": { "inserted": 1 } }).to_string(),
        outcome: HostOutcome::Completed { write: true },
    }
}

fn settings(timeout_ms: u64) -> MongoScriptSettings {
    MongoScriptSettings { max_rows: 1000, timeout: Duration::from_millis(timeout_ms) }
}

fn run_with(
    source: &str,
    backend: Arc<FakeBackend>,
    timeout_ms: u64,
    cancel: CancellationToken,
) -> Result<MongoScriptOutput, String> {
    let control = MongoScriptControl::new(cancel, Duration::from_millis(timeout_ms));
    run_script(source, backend, settings(timeout_ms), control, &MONGO_SCRIPT_LIMITS)
}

fn run(source: &str, backend: &Arc<FakeBackend>) -> Result<MongoScriptOutput, String> {
    run_with(source, backend.clone(), 5_000, CancellationToken::new())
}

fn config(value: serde_json::Value) -> ConnectionConfig {
    let mut base = serde_json::json!({
        "id": "c1",
        "name": "mongo",
        "db_type": "mongodb",
        "host": "localhost",
        "port": 27017,
        "username": "",
        "password": "",
        "database": "staging",
    });
    base.as_object_mut().unwrap().extend(value.as_object().unwrap().clone());
    serde_json::from_value(base).unwrap()
}

fn parse(source: &str) -> MongoCommand {
    mongo_shell::parse(source).unwrap_or_else(|error| panic!("{source} must parse: {error}"))
}

#[test]
fn iife_with_var_and_foreach_returns_completion_value() {
    let backend = FakeBackend::replying(|_| error_json("unexpected backend call"));
    let output = run(
        "(function () { var a = [1, 2, 3]; var s = 0; a.forEach(function (x) { s += x; }); return s; })()",
        &backend,
    )
    .unwrap();
    assert_eq!(output.value, Some(serde_json::json!(6)));
    assert!(backend.calls().is_empty());
}

#[test]
fn find_chain_builds_a_parsable_shell_command_without_a_client_row_limit() {
    let backend = FakeBackend::replying(|_| {
        docs_reply(serde_json::json!([
            {"_id": {"$oid": "507f1f77bcf86cd799439011"}, "n": {"$numberInt": "1"}},
            {"_id": {"$oid": "507f1f77bcf86cd799439012"}, "n": {"$numberInt": "2"}},
        ]))
    });
    let output = run(
        "var rows = db.users.find({ n: { $gt: 0 } }).sort({ n: 1 }).skip(2).limit(5).toArray(); rows.map(function (d) { return d.n; })",
        &backend,
    )
    .unwrap();
    assert_eq!(output.value, Some(serde_json::json!([1, 2])));
    assert_eq!(
        backend.calls(),
        vec![r#"db.getCollection("users").find({"n":{"$gt":{"$numberInt":"0"}}}).sort({"n":1}).skip(2).limit(5)"#]
    );
    // Without .limit() only the server-side row limit applies: limit(0) means none.
    run("db.users.find({}).toArray()", &backend).unwrap();
    assert_eq!(backend.calls()[1], r#"db.getCollection("users").find({}).limit(0)"#);
    assert_eq!(
        parse(&backend.calls()[1]),
        MongoCommand::Find {
            collection: "users".to_string(),
            filter: "{}".to_string(),
            projection: None,
            sort: None,
            collation: None,
            skip: 0,
            limit: 0,
        }
    );
    for call in backend.calls() {
        parse(&call);
    }
}

#[test]
fn values_are_sent_as_canonical_extended_json_and_commands_parse() {
    let backend = FakeBackend::replying(|_| docs_reply(serde_json::json!([])));
    run(
        r#"db.getSiblingDB("app").logs.find({ _id: ObjectId("507f1f77bcf86cd799439011"), at: ISODate("2020-01-01T00:00:00Z"), n: NumberLong(5), i: 7, big: 3000000000, f: 1.5, name: /ab+/i }).toArray()"#,
        &backend,
    )
    .unwrap();
    let backend_writes = FakeBackend::new(|_, _| write_reply());
    run(
        r#"db.items.insertOne({ a: 1 }); db.items.updateMany({ a: 1 }, { $set: { b: 2 } }, { upsert: true }); db.items.deleteOne({ a: 1 });
           db.items.bulkWrite([{ insertOne: { document: { a: 1 } } }]); db.items.createIndex({ a: 1 }, { unique: true });
           db.items.renameCollection("items2"); db.items.dropIndex("a_1")"#,
        &backend_writes,
    )
    .unwrap();
    let call = &backend.calls()[0];
    assert!(call.contains(r#"{"$oid":"507f1f77bcf86cd799439011"}"#), "{call}");
    assert!(call.contains(r#""at":{"$date":{"$numberLong":"1577836800000"}}"#), "{call}");
    assert!(call.contains(r#""n":{"$numberLong":"5"}"#), "{call}");
    assert!(call.contains(r#""i":{"$numberInt":"7"}"#), "{call}");
    assert!(call.contains(r#""big":3000000000"#), "{call}");
    assert!(call.contains(r#""f":1.5"#), "{call}");
    assert!(call.contains(r#"$regularExpression"#), "{call}");
    // Options and index keys stay plain JSON for the parser.
    let writes = backend_writes.calls();
    assert!(writes[1].ends_with(r#",{"upsert":true})"#), "{}", writes[1]);
    assert!(writes[4].contains(r#"createIndex({"a":1},{"unique":true})"#), "{}", writes[4]);
    for call in backend.calls().iter().chain(writes.iter()) {
        parse(call);
    }
}

#[test]
fn documents_round_trip_with_their_types() {
    let stored = serde_json::json!([{
        "_id": {"$oid": "507f1f77bcf86cd799439011"},
        "at": {"$date": {"$numberLong": "1600000000123"}},
        "big": {"$numberLong": "9007199254740993"},
        "small": {"$numberLong": "5"},
        "i32": {"$numberInt": "5"},
        "dbl": {"$numberDouble": "1.5"},
        "dec": {"$numberDecimal": "1.10"},
        "bin": {"$binary": {"base64": "AQID", "subType": "00"}},
        "ts": {"$timestamp": {"t": 1, "i": 2}},
        "re": {"$regularExpression": {"pattern": "a+", "options": "x"}},
        "s": "ISODate(\"2020-01-01T00:00:00Z\")",
        "nested": {"x": {"$numberInt": "1"}, "arr": [{"$numberInt": "1"}, {"$numberInt": "2"}]},
    }]);
    let reply = stored.clone();
    let backend = FakeBackend::new(move |source, _| {
        if source.contains(".insertOne(") {
            write_reply()
        } else {
            HostReply { body: docs_reply(reply.clone()), outcome: HostOutcome::Completed { write: false } }
        }
    });
    let output = run(
        r#"var d = db.items.findOne({}); db.copy.insertOne(d); [typeof d.s, d.at instanceof Date, d.i32 + 1, d.dbl * 2, String(d.big), d.small + 1]"#,
        &backend,
    )
    .unwrap();
    assert_eq!(output.value, Some(serde_json::json!(["string", true, 6, 3, "NumberLong(\"9007199254740993\")", 6])));
    let insert = &backend.calls()[1];
    let sent: Value = serde_json::from_str(
        insert.strip_prefix(r#"db.getCollection("copy").insertOne("#).unwrap().strip_suffix(')').unwrap(),
    )
    .unwrap();
    // Every field goes back exactly as it was stored (1.5 is a plain double either way).
    let mut expected = stored[0].clone();
    expected["dbl"] = serde_json::json!(1.5);
    assert_eq!(sent, expected);
}

#[test]
fn heterogeneous_documents_keep_only_their_own_fields() {
    let backend = FakeBackend::new(|source, _| {
        if source.contains(".insertOne(") {
            write_reply()
        } else {
            HostReply {
                body: docs_reply(
                    serde_json::json!([{"_id": {"$numberInt": "1"}, "a": {"$numberInt": "1"}}, {"_id": {"$numberInt": "2"}, "b": {"$numberInt": "2"}}]),
                ),
                outcome: HostOutcome::Completed { write: false },
            }
        }
    });
    run(r#"db.a.find({}).forEach(function (d) { db.b.insertOne(d); })"#, &backend).unwrap();
    let calls = backend.calls();
    assert_eq!(calls[1], r#"db.getCollection("b").insertOne({"_id":{"$numberInt":"1"},"a":{"$numberInt":"1"}})"#);
    assert_eq!(calls[2], r#"db.getCollection("b").insertOne({"_id":{"$numberInt":"2"},"b":{"$numberInt":"2"}})"#);
}

#[test]
fn cursor_count_counts_every_match_like_the_shell() {
    let backend = FakeBackend::new(|source, _| HostReply {
        body: if source.contains("countDocuments") {
            serde_json::json!({ "columns": ["count"], "rows": [[1500]], "affected": 0 }).to_string()
        } else {
            docs_reply(serde_json::json!([{"a": 1}]))
        },
        outcome: HostOutcome::Completed { write: false },
    });
    let output =
        run(r#"var c = db.items.find({ a: 1 }).limit(1); [c.count(), c.itcount(), c.size()]"#, &backend).unwrap();
    assert_eq!(output.value, Some(serde_json::json!([1500, 1, 1])));
    assert_eq!(backend.calls()[0], r#"db.getCollection("items").countDocuments({"a":{"$numberInt":"1"}})"#);
}

#[test]
fn inserts_generate_ids_on_the_client_and_writes_report_real_counts() {
    let backend = FakeBackend::new(|source, _| {
        let write = if source.contains("updateOne") {
            serde_json::json!({ "matched": 1, "modified": 0, "upsertedId": null })
        } else if source.contains("updateMany") {
            serde_json::json!({ "matched": 0, "modified": 0, "upsertedId": {"$oid": "507f1f77bcf86cd799439011"} })
        } else if source.contains("deleteMany") {
            serde_json::json!({ "deleted": 3 })
        } else {
            serde_json::json!({ "inserted": 2 })
        };
        HostReply {
            body: serde_json::json!({ "write": write }).to_string(),
            outcome: HostOutcome::Completed { write: true },
        }
    });
    let output = run(
        r#"var one = db.items.insertOne({ a: 1 });
           var many = db.items.insertMany([{ _id: 7 }, { b: 1 }]);
           var noop = db.items.updateOne({ a: 1 }, { $set: { a: 1 } });
           var up = db.items.updateMany({ a: 2 }, { $set: { a: 2 } }, { upsert: true });
           var del = db.items.deleteMany({ a: 1 });
           [one.insertedId instanceof ObjectId, many.insertedIds[0], many.insertedIds[1] instanceof ObjectId, many.insertedCount,
            noop.matchedCount, noop.modifiedCount, noop.upsertedId, up.upsertedCount, up.upsertedId.toHexString(), del.deletedCount]"#,
        &backend,
    )
    .unwrap();
    assert_eq!(output.value, Some(serde_json::json!([true, 7, true, 2, 1, 0, null, 1, "507f1f77bcf86cd799439011", 3])));
    assert!(backend.calls()[0].contains(r#""_id":{"$oid":""#), "{}", backend.calls()[0]);
}

#[test]
fn the_completion_value_is_read_in_display_mode_and_reports_truncation() {
    let backend = FakeBackend::new(|_, _| HostReply {
        body: serde_json::json!({ "docs": [{"a": 1}], "truncated": true }).to_string(),
        outcome: HostOutcome::Completed { write: false },
    });
    let output = run("var n = db.items.find({}).toArray().length; db.items.find({})", &backend).unwrap();
    assert_eq!(backend.display_flags(), vec![false, true]);
    assert!(output.value_truncated);
    assert!(script_query_result(output, 100).truncated);
}

#[test]
fn the_completion_value_reads_like_a_plain_find_in_the_grid() {
    let backend = FakeBackend::replying(|_| {
        docs_reply(serde_json::json!([{
            "_id": {"$oid": "507f1f77bcf86cd799439011"},
            "at": {"$date": {"$numberLong": "1577836800000"}},
            "n": {"$numberLong": "5"},
        }]))
    });
    let output = run("db.items.find({})", &backend).unwrap();
    assert_eq!(
        output.value,
        Some(
            serde_json::json!([{ "_id": "507f1f77bcf86cd799439011", "at": "ISODate(\"2020-01-01T00:00:00.000Z\")", "n": 5 }])
        )
    );
    // print keeps the shell's Extended JSON view.
    let printed = run(r#"print(db.items.findOne({})._id)"#, &backend).unwrap();
    assert_eq!(printed.output, vec![r#"{"$oid":"507f1f77bcf86cd799439011"}"#.to_string()]);
}

#[test]
fn print_and_printjson_are_collected() {
    let backend = FakeBackend::replying(|_| error_json("unexpected"));
    let output = run(r#"print("a", 1); printjson({ x: 1, n: NumberLong(5) }); 7"#, &backend).unwrap();
    assert_eq!(output.output, vec!["a 1".to_string(), "{\n  \"x\": 1,\n  \"n\": 5\n}".to_string()]);
    assert_eq!(output.value, Some(serde_json::json!(7)));
    assert!(!output.output_truncated);
}

#[test]
fn print_output_is_bounded() {
    let backend = FakeBackend::replying(|_| error_json("unexpected"));
    let output = run("for (var i = 0; i < 20000; i++) print(i);", &backend).unwrap();
    assert_eq!(output.output.len(), MONGO_SCRIPT_LIMITS.max_output_lines);
    assert!(output.output_truncated);
    let table = script_query_result(output, 100);
    assert_eq!(table.rows.len(), 100);
    assert!(table.truncated);
}

#[test]
fn print_output_budget_counts_utf8_bytes() {
    let backend = FakeBackend::replying(|_| error_json("unexpected"));
    // 1.5 MiB of three-byte characters is 4.5 MiB of UTF-8: the second line no longer fits.
    let output = run("var s = '中'.repeat(512 * 1024); print(s); print(s); print(s); 1", &backend).unwrap();
    assert_eq!(output.output.len(), 2);
    assert!(output.output_truncated);
}

#[test]
fn host_hooks_are_hidden_from_the_script() {
    let backend = FakeBackend::replying(|_| error_json("unexpected"));
    let output = run(
        r#"var seen = [typeof __dbx_exec, typeof __dbx_finish, typeof __DBX_MAX_OUTPUT_LINES];
           globalThis.__dbx_finish = function () { return "{}"; };
           seen"#,
        &backend,
    )
    .unwrap();
    assert_eq!(output.value, Some(serde_json::json!(["undefined", "undefined", "undefined"])));
}

#[test]
fn errors_show_the_users_frames_only() {
    let backend = FakeBackend::replying(|_| error_json("boom from backend"));
    let error = run("function load() {\n  return db.users.find({}).toArray();\n}\nload();", &backend).unwrap_err();
    assert!(error.contains("boom from backend"), "{error}");
    assert!(error.contains("script:2"), "{error}");
    assert!(!error.contains("dbx-prelude"), "{error}");
    assert!(!error.contains("eval_script"), "{error}");
}

#[test]
fn unsupported_shell_helpers_fail_with_a_clear_message() {
    let backend = FakeBackend::replying(|_| error_json("unexpected"));
    for (source, name) in [
        ("db.getCollectionNames()", "db.getCollectionNames()"),
        ("db.runCommand({ ping: 1 })", "db.runCommand()"),
        ("db.adminCommand({ ping: 1 })", "db.adminCommand()"),
        ("db.items.find({}).explain()", "cursor.explain()"),
    ] {
        let error = run(source, &backend).unwrap_err();
        assert!(error.contains(&format!("{name} is not supported in DBX MongoDB scripts")), "{source}: {error}");
    }
    assert!(backend.calls().is_empty());
}

#[test]
fn skip_and_limit_only_accept_integers() {
    let backend = FakeBackend::replying(|_| docs_reply(serde_json::json!([])));
    assert!(run(r#"db.items.find({}).skip("0).limit(5").toArray()"#, &backend).unwrap_err().contains("skip()"));
    assert!(run(r#"db.items.find({}).limit(1.5).toArray()"#, &backend).unwrap_err().contains("limit()"));
    assert!(run(r#"db.items.find({}).skip(-1).toArray()"#, &backend).unwrap_err().contains("skip()"));
    assert!(run(r#"db.items.find({}).limit(-2).toArray()"#, &backend).unwrap_err().contains("limit()"));
    assert!(backend.calls().is_empty());
    run(r#"db.items.find({}).skip("3").limit("2").toArray()"#, &backend).unwrap();
    assert_eq!(backend.calls(), vec![r#"db.getCollection("items").find({}).skip(3).limit(2)"#]);
    parse(&backend.calls()[0]);
}

#[test]
fn backend_errors_surface_as_script_errors() {
    let backend = FakeBackend::replying(|_| error_json("boom from backend"));
    let error = run("db.users.find({}).toArray()", &backend).unwrap_err();
    assert!(error.contains("boom from backend"), "{error}");
}

#[test]
fn syntax_errors_are_reported() {
    let backend = FakeBackend::replying(|_| error_json("unexpected"));
    let error = run("(function () {", &backend).unwrap_err();
    assert!(!error.is_empty());
    assert!(backend.calls().is_empty());
}

#[test]
fn infinite_loops_time_out() {
    let backend = FakeBackend::replying(|_| error_json("unexpected"));
    let error = run_with("while (true) {}", backend, 200, CancellationToken::new()).unwrap_err();
    assert!(error.contains("timed out after 200 ms"), "{error}");
}

#[test]
fn oversized_source_is_rejected_before_the_runtime_starts() {
    let backend = FakeBackend::replying(|_| error_json("unexpected"));
    let source = format!("/*{}*/1", "x".repeat(MONGO_SCRIPT_LIMITS.max_source_bytes));
    let error = run(&source, &backend).unwrap_err();
    assert!(error.contains("too large"), "{error}");
    let at_limit = format!("/*{}*/1", "x".repeat(MONGO_SCRIPT_LIMITS.max_source_bytes - 5));
    assert_eq!(run(&at_limit, &backend).unwrap().value, Some(serde_json::json!(1)));
}

#[tokio::test]
async fn the_entry_point_rejects_oversized_source_before_admission() {
    let directory = tempfile::tempdir().unwrap();
    let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let available = ADMISSION.available();
    let source = "x".repeat(MONGO_SCRIPT_LIMITS.max_source_bytes + 1);
    let error = execute_mongo_script_core(state, "missing", "app", &source, MongoScriptOptions::default(), None)
        .await
        .unwrap_err();
    assert!(error.contains("too large"), "{error}");
    assert_eq!(ADMISSION.available(), available);
}

#[test]
fn client_limits_are_clamped_by_the_server() {
    let huge = MongoScriptOptions { max_rows: Some(usize::MAX), timeout_ms: Some(u64::MAX), ..Default::default() };
    let resolved = MongoScriptSettings::resolve(&huge, &MONGO_SCRIPT_LIMITS);
    assert_eq!(resolved.max_rows, MONGO_SCRIPT_LIMITS.max_rows);
    assert_eq!(resolved.timeout, MONGO_SCRIPT_LIMITS.max_timeout);
    let zero = MongoScriptOptions { max_rows: Some(0), ..Default::default() };
    assert_eq!(MongoScriptSettings::resolve(&zero, &MONGO_SCRIPT_LIMITS).max_rows, 1);
    let default = MongoScriptSettings::resolve(&MongoScriptOptions::default(), &MONGO_SCRIPT_LIMITS);
    assert_eq!(default.max_rows, MONGO_SCRIPT_LIMITS.default_max_rows);
    // Client fields that used to decide safety are ignored.
    let options: MongoScriptOptions = serde_json::from_value(
        serde_json::json!({ "allowWrites": true, "allowDangerous": true, "productionDatabase": false }),
    )
    .unwrap();
    assert!(!options.confirmed_production_writes);
}

#[test]
fn cancellation_reports_completed_writes() {
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let backend = FakeBackend::new(move |_, _| {
        if seen.fetch_add(1, Ordering::SeqCst) == 1 {
            trigger.cancel();
        }
        write_reply()
    });
    let error = run_with("for (var i = 0; i < 10; i++) db.items.insertOne({ i: i });", backend.clone(), 5_000, cancel)
        .unwrap_err();
    assert!(error.starts_with(crate::query::QUERY_CANCELED), "{error}");
    assert!(error.contains("Confirmed completed operations: 2 (2 writes)"), "{error}");
    assert!(error.contains("not rolled back"), "{error}");
    assert_eq!(backend.calls().len(), 2, "nothing is sent after cancellation");
}

#[test]
fn interrupted_write_is_reported_as_unknown() {
    let backend = FakeBackend::new(|source, _| {
        if source.contains(r#""i":{"$numberInt":"1"}"#) {
            HostReply { body: error_json("Query canceled"), outcome: HostOutcome::UnknownWrite }
        } else {
            write_reply()
        }
    });
    let error = run("db.items.insertOne({ i: 0 }); db.items.insertOne({ i: 1 });", &backend).unwrap_err();
    assert!(error.contains("Confirmed completed operations: 1 (1 writes)"), "{error}");
    assert!(error.contains("Outcome unknown"), "{error}");
    assert!(error.contains(r#""i":{"$numberInt":"1"}"#), "{error}");
}

#[test]
fn a_rejected_write_is_not_reported_as_unknown() {
    let backend = FakeBackend::new(|source, _| {
        if source.contains(r#""i":{"$numberInt":"1"}"#) {
            HostReply { body: error_json("E11000 duplicate key error"), outcome: HostOutcome::Failed }
        } else {
            write_reply()
        }
    });
    let error = run("db.items.insertOne({ i: 0 }); db.items.insertOne({ i: 1 });", &backend).unwrap_err();
    assert!(error.contains("E11000"), "{error}");
    assert!(error.contains("Confirmed completed operations: 1 (1 writes)"), "{error}");
    assert!(!error.contains("Outcome unknown"), "{error}");
}

#[test]
fn caught_write_failures_are_still_reported_when_the_script_succeeds() {
    let backend = FakeBackend::new(|source, _| {
        if source.contains(r#""i":{"$numberInt":"1"}"#) || source.contains(r#""i":{"$numberInt":"2"}"#) {
            HostReply { body: error_json("connection reset"), outcome: HostOutcome::UnknownWrite }
        } else {
            write_reply()
        }
    });
    let output = run(
        r#"for (var i = 0; i < 4; i++) { try { db.items.insertOne({ i: i }); } catch (e) { print("skipped " + i); } }"#,
        &backend,
    )
    .unwrap();
    assert_eq!(output.progress.completed_writes, 2);
    let table = script_query_result(output, 100);
    let messages: Vec<(String, Option<String>, String)> = table
        .messages
        .iter()
        .map(|message| (message.severity.clone(), message.code.clone(), message.message.clone()))
        .collect();
    assert_eq!(messages.len(), 3, "{messages:?}");
    assert_eq!(messages[0].1.as_deref(), Some("MONGO_SCRIPT_WRITES"));
    assert_eq!(messages[0].2, "Confirmed completed operations: 2 (2 writes).");
    for (message, i) in messages[1..].iter().zip([1, 2]) {
        assert_eq!((message.0.as_str(), message.1.as_deref()), ("WARNING", Some("MONGO_SCRIPT_UNKNOWN_WRITE")));
        assert!(message.2.contains(&format!(r#""i":{{"$numberInt":"{i}"}}"#)), "{}", message.2);
    }
}

#[test]
fn a_read_only_script_gets_no_progress_messages() {
    let backend = FakeBackend::replying(|_| docs_reply(serde_json::json!([{"a": 1}])));
    let output = run("db.items.find({}).toArray()", &backend).unwrap();
    assert!(script_query_result(output, 100).messages.is_empty());
}

#[test]
fn unknown_writes_are_all_listed_up_to_a_bound() {
    let backend = FakeBackend::new(|_, _| HostReply { body: error_json("reset"), outcome: HostOutcome::UnknownWrite });
    let output =
        run(r#"for (var i = 0; i < 25; i++) { try { db.items.insertOne({ i: i }); } catch (e) {} } 1"#, &backend)
            .unwrap();
    assert_eq!(output.progress.unknown_writes.len(), MAX_UNKNOWN_WRITES);
    assert_eq!(output.progress.unknown_writes_dropped, 5);
    let messages = script_query_result(output, 100).messages;
    assert_eq!(
        messages.last().and_then(|message| message.code.as_deref()),
        Some("MONGO_SCRIPT_UNKNOWN_WRITES_DROPPED")
    );

    let error = run(
        r#"for (var i = 0; i < 3; i++) { try { db.items.insertOne({ i: i }); } catch (e) {} } throw new Error("stop")"#,
        &backend,
    )
    .unwrap_err();
    assert_eq!(error.matches("Outcome unknown, it may or may not have been applied").count(), 3, "{error}");
}

#[test]
fn oversized_replies_are_refused_but_completed_writes_still_count() {
    let reply = serde_json::json!({ "docs": [{ "s": "x".repeat(100) }] });
    let small = bounded_reply(&reply, false, 1_000);
    assert_eq!(small.outcome, HostOutcome::Completed { write: false });
    assert_eq!(small.body, reply.to_string());

    let read = bounded_reply(&reply, false, 50);
    assert_eq!(read.outcome, HostOutcome::Failed);
    assert!(read.body.contains("over the 50 byte limit"), "{}", read.body);

    let write = bounded_reply(&reply, true, 50);
    assert_eq!(write.outcome, HostOutcome::Completed { write: true });
    assert!(write.body.contains("\"error\""), "{}", write.body);
}

#[test]
fn write_errors_are_classified_by_what_they_prove() {
    let insert = parse(r#"db.items.insertOne({ a: 1 })"#);
    let update_one = parse(r#"db.items.updateOne({ a: 1 }, { $set: { b: 1 } })"#);
    let update_many = parse(r#"db.items.updateMany({ a: 1 }, { $set: { b: 1 } })"#);
    let sibling_delete = parse(r#"db.getSiblingDB("app").items.deleteOne({ a: 1 })"#);
    let duplicate = "Kind: An error occurred when trying to execute an insert_many operation: InsertManyError { write_errors: Some([IndexedWriteError { index: 0, code: 11000, .. }]), write_concern_error: None, inserted_ids: {} }";
    let partial = "Kind: An error occurred when trying to execute an insert_many operation: InsertManyError { write_errors: Some([..]), write_concern_error: None, inserted_ids: {0: Int32(1)} }";
    let write_error =
        "Kind: An error occurred when trying to execute a write operation: WriteError(WriteError { code: 121, .. })";
    let concern = "Kind: An error occurred when trying to execute a write operation: WriteConcernError(WriteConcernError { code: 64, .. })";
    for (command, message, rejected) in [
        (&insert, duplicate, true),
        (&insert, partial, false),
        (&insert, "Invalid document: expected an object", true),
        (&insert, "Kind: I/O error: connection reset", false),
        (&update_one, write_error, true),
        (&update_one, concern, false),
        (&update_many, write_error, false),
        (&sibling_delete, "Kind: Command failed: Error code 13 (Unauthorized)", true),
        (&update_one, "Not found", true),
    ] {
        assert_eq!(write_error_was_rejected(command, message), rejected, "{command:?}: {message}");
    }
}

#[test]
fn timeout_reports_progress() {
    let backend = FakeBackend::new(|_, _| write_reply());
    let error =
        run_with("db.items.insertOne({ a: 1 }); while (true) {}", backend, 300, CancellationToken::new()).unwrap_err();
    assert!(error.contains("timed out after 300 ms"), "{error}");
    assert!(error.contains("Confirmed completed operations: 1 (1 writes)"), "{error}");
}

#[test]
fn production_writes_are_judged_on_the_database_each_operation_targets() {
    let staging_with_prod_db = config(serde_json::json!({ "production_databases": ["prod"] }));
    let sibling_delete = parse(r#"db.getSiblingDB("prod").users.deleteMany({ a: 1 })"#);
    assert_eq!(
        host_operation_policy(&sibling_delete, "staging", Some(&staging_with_prod_db), true, false),
        Err(MongoSafetyError::ProductionWrite)
    );
    assert_eq!(host_operation_policy(&sibling_delete, "staging", Some(&staging_with_prod_db), true, true), Ok(()));
    let local_delete = parse(r#"db.users.deleteMany({ a: 1 })"#);
    assert_eq!(host_operation_policy(&local_delete, "staging", Some(&staging_with_prod_db), true, false), Ok(()));
    assert_eq!(
        host_operation_policy(&local_delete, "prod", Some(&staging_with_prod_db), true, false),
        Err(MongoSafetyError::ProductionWrite)
    );
    let read = parse(r#"db.getSiblingDB("prod").users.find({})"#);
    assert_eq!(host_operation_policy(&read, "staging", Some(&staging_with_prod_db), true, false), Ok(()));

    let production_connection = config(serde_json::json!({ "is_production": true }));
    assert_eq!(
        host_operation_policy(&local_delete, "staging", Some(&production_connection), true, false),
        Err(MongoSafetyError::ProductionWrite)
    );
    // An unknown connection fails closed.
    assert_eq!(
        host_operation_policy(&local_delete, "staging", None, true, false),
        Err(MongoSafetyError::ProductionWrite)
    );
}

#[test]
fn scripts_typed_literals_pass_the_unbounded_filter_guard() {
    let staging = config(serde_json::json!({}));
    for source in [
        r#"db.users.deleteOne({"n":{"$numberInt":"1"}})"#,
        r#"db.users.updateMany({"at":{"$date":{"$numberLong":"1600000000123"}}},{"$set":{"a":{"$numberInt":"1"}}})"#,
    ] {
        assert_eq!(host_operation_policy(&parse(source), "staging", Some(&staging), true, false), Ok(()), "{source}");
    }
}

#[test]
fn dangerous_and_read_only_operations_are_blocked_in_scripts() {
    let staging = config(serde_json::json!({}));
    for source in [
        r#"db.users.deleteMany({})"#,
        r#"db.users.drop()"#,
        r#"db.users.aggregate([{ "$out": "copy" }])"#,
        r#"db.users.aggregate([{ "$merge": { "into": { "db": "prod", "coll": "copy" } } }])"#,
        r#"db.runCommand({ dropDatabase: 1 })"#,
    ] {
        assert!(
            host_operation_policy(&parse(source), "staging", Some(&staging), true, true).is_err(),
            "{source} must be blocked"
        );
    }
    assert_eq!(
        host_operation_policy(&parse(r#"db.users.insertOne({ a: 1 })"#), "staging", Some(&staging), false, true),
        Err(MongoSafetyError::WritesDisabled)
    );
}

#[test]
fn misspelled_and_unsupported_calls_never_reach_the_backend() {
    let backend = FakeBackend::replying(|_| error_json("unexpected"));
    assert!(run("db.users.fnd({})", &backend).is_err());
    assert!(run("db.users.find({}).explode()", &backend).is_err());
    assert!(backend.calls().is_empty(), "{:?}", backend.calls());
}

fn blocking_backend(release: Arc<(Mutex<bool>, std::sync::Condvar)>) -> Arc<FakeBackend> {
    FakeBackend::new(move |_, control| {
        let (lock, wake) = &*release;
        let mut released = lock.lock().unwrap();
        while !*released && control.interruption().is_none() {
            released = wake.wait_timeout(released, Duration::from_millis(20)).unwrap().0;
        }
        write_reply()
    })
}

fn release(gate: &Arc<(Mutex<bool>, std::sync::Condvar)>) {
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
}

async fn wait_for(admission: &MongoScriptAdmission, available: usize) {
    for _ in 0..200 {
        if admission.available() == available {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("admission never reached {available} free permits (now {})", admission.available());
}

#[tokio::test]
async fn admission_queues_cancels_times_out_and_releases() {
    let admission = Arc::new(MongoScriptAdmission::new(1));
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let first_backend = blocking_backend(gate.clone());

    let first = {
        let admission = admission.clone();
        let backend = first_backend.clone();
        tokio::spawn(async move {
            let control = MongoScriptControl::new(CancellationToken::new(), Duration::from_secs(10));
            run_admitted(
                &admission,
                "db.a.insertOne({ x: 1 })",
                backend,
                settings(10_000),
                control,
                &MONGO_SCRIPT_LIMITS,
            )
            .await
        })
    };
    wait_for(&admission, 0).await;

    // A queued script that is canceled never starts.
    let queued_backend = FakeBackend::replying(|_| docs_reply(serde_json::json!([])));
    let cancel = CancellationToken::new();
    let canceled = {
        let admission = admission.clone();
        let backend = queued_backend.clone();
        let control = MongoScriptControl::new(cancel.clone(), Duration::from_secs(10));
        tokio::spawn(async move {
            run_admitted(
                &admission,
                "db.a.find({}).toArray()",
                backend,
                settings(10_000),
                control,
                &MONGO_SCRIPT_LIMITS,
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    cancel.cancel();
    assert_eq!(canceled.await.unwrap().unwrap_err(), crate::query::canceled_error());

    // A queued script that runs out of time never starts either.
    let control = MongoScriptControl::new(CancellationToken::new(), Duration::from_millis(100));
    let error = run_admitted(
        &admission,
        "db.a.find({}).toArray()",
        queued_backend.clone(),
        settings(100),
        control,
        &MONGO_SCRIPT_LIMITS,
    )
    .await
    .unwrap_err();
    assert!(error.contains("waiting for a free script slot"), "{error}");
    assert!(queued_backend.calls().is_empty());
    assert_eq!(admission.available(), 0);

    // Releasing the running script frees its slot for the next one.
    release(&gate);
    first.await.unwrap().unwrap();
    wait_for(&admission, 1).await;
    let control = MongoScriptControl::new(CancellationToken::new(), Duration::from_secs(5));
    run_admitted(
        &admission,
        "db.a.find({}).toArray()",
        queued_backend.clone(),
        settings(5_000),
        control,
        &MONGO_SCRIPT_LIMITS,
    )
    .await
    .unwrap();
    assert_eq!(queued_backend.calls().len(), 1);
    wait_for(&admission, 1).await;
}

#[tokio::test]
async fn canceling_a_running_script_releases_its_slot() {
    let admission = Arc::new(MongoScriptAdmission::new(1));
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let cancel = CancellationToken::new();
    let control = MongoScriptControl::new(cancel.clone(), Duration::from_secs(10));
    let running = {
        let admission = admission.clone();
        let backend = blocking_backend(gate);
        tokio::spawn(async move {
            run_admitted(
                &admission,
                "db.a.insertOne({ x: 1 }); db.a.insertOne({ x: 2 })",
                backend,
                settings(10_000),
                control,
                &MONGO_SCRIPT_LIMITS,
            )
            .await
        })
    };
    wait_for(&admission, 0).await;
    cancel.cancel();
    let error = running.await.unwrap().unwrap_err();
    assert!(error.starts_with(crate::query::QUERY_CANCELED), "{error}");
    wait_for(&admission, 1).await;
}

#[test]
fn result_rendering_prefers_output_then_value() {
    let output = |value: Option<Value>, output: Vec<String>| MongoScriptOutput {
        value,
        output,
        output_truncated: false,
        value_truncated: false,
        progress: MongoScriptProgress::default(),
    };
    let table = script_query_result(output(Some(serde_json::json!([{"a": 1}, {"a": 2}])), vec![]), 100);
    assert_eq!(table.columns, vec!["a".to_string()]);
    assert_eq!(table.rows.len(), 2);
    let printed = script_query_result(output(None, vec!["hello".to_string()]), 100);
    assert_eq!(printed.columns, vec!["output".to_string()]);
    let scalar = script_query_result(output(Some(serde_json::json!(3)), vec![]), 100);
    assert_eq!(scalar.columns, vec!["result".to_string()]);
    let many = script_query_result(output(Some(serde_json::json!([1, 2, 3])), vec![]), 2);
    assert!(many.truncated);
}
