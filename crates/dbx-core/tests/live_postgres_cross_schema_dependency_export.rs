use dbx_core::connection::AppState;
use dbx_core::database_export::{
    export_database_sql_core, DatabaseExportRequest, DatabaseExportSelectedObject, ExportStatus,
};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::sql::SqlFileRequest;
use dbx_core::sql_file_import::execute_sql_file_path;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

const MINIMAL_FIXTURE: &[&str] = &[
    "CREATE SCHEMA z_14178",
    "CREATE SCHEMA a_14178",
    "CREATE TABLE z_14178.items (id integer PRIMARY KEY)",
    "CREATE VIEW z_14178.base_view AS SELECT id FROM z_14178.items",
    "CREATE VIEW a_14178.report AS SELECT id FROM z_14178.base_view",
    "CREATE VIEW z_14178.a_local AS SELECT id FROM z_14178.base_view",
];

// The object graph is acyclic, but its schema-level graph is not: z -> a -> z -> a.
const MATRIX_FIXTURE: &[&str] = &[
    "CREATE SCHEMA z_14178",
    "CREATE SCHEMA a_14178",
    "CREATE SCHEMA s",
    r#"CREATE SCHEMA "s.part""#,
    r#"CREATE SCHEMA "Q""uote""#,
    "CREATE TABLE z_14178.items (id integer PRIMARY KEY, amount integer NOT NULL)",
    "CREATE TABLE a_14178.audit (id integer NOT NULL)",
    "CREATE TABLE a_14178.children (id integer PRIMARY KEY, item_id integer REFERENCES z_14178.items(id))",
    "INSERT INTO z_14178.items VALUES (1, 7), (2, 11)",
    "INSERT INTO a_14178.children VALUES (1, 1)",
    "CREATE VIEW z_14178.base_view AS SELECT id, amount FROM z_14178.items",
    "CREATE VIEW a_14178.same AS SELECT id, amount + 1 AS amount FROM z_14178.base_view",
    "CREATE VIEW z_14178.same AS SELECT id, amount * 2 AS amount FROM a_14178.same",
    "CREATE VIEW a_14178.report AS SELECT id, amount FROM z_14178.same",
    "CREATE MATERIALIZED VIEW z_14178.snapshot AS SELECT id, amount FROM a_14178.report",
    "CREATE VIEW a_14178.snapshot_report AS SELECT id, amount FROM z_14178.snapshot",
    // These two qualified names collide if an implementation just concatenates schema + '.' + name.
    r#"CREATE VIEW "s.part"."Shared" AS SELECT id, amount + 100 AS amount FROM z_14178.items"#,
    r#"CREATE VIEW s."part.Shared" AS SELECT id, amount + 200 AS amount FROM z_14178.items"#,
    r#"CREATE VIEW "Q""uote"."MiX.ed""View" AS SELECT id, amount FROM "s.part"."Shared""#,
    "CREATE FUNCTION a_14178.view_count() RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT count(*) FROM a_14178.report $$",
    "CREATE FUNCTION z_14178.bump(integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT $1 + 1 $$",
    "CREATE INDEX items_amount_idx ON z_14178.items (z_14178.bump(amount))",
    "CREATE FUNCTION a_14178.audit_new_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO a_14178.audit VALUES (NEW.id); RETURN NEW; END; $$",
    "CREATE TRIGGER items_audit AFTER INSERT ON z_14178.items FOR EACH ROW EXECUTE FUNCTION a_14178.audit_new_item()",
];

const MATRIX_QUERY: &str = r#"SELECT
    (SELECT count(*) FROM a_14178.report),
    (SELECT COALESCE(sum(amount), 0)::integer FROM a_14178.report),
    (SELECT count(*) FROM a_14178.snapshot_report),
    (SELECT COALESCE(sum(amount), 0)::integer FROM a_14178.snapshot_report),
    (SELECT COALESCE(sum(amount), 0)::integer FROM "s.part"."Shared"),
    (SELECT COALESCE(sum(amount), 0)::integer FROM s."part.Shared"),
    (SELECT count(*) FROM "Q""uote"."MiX.ed""View"),
    a_14178.view_count()"#;

fn config(id: &str, database: &str) -> ConnectionConfig {
    serde_json::from_value(json!({
        "id": id, "name": id, "db_type": DatabaseType::Postgres,
        "host": std::env::var("DBX_LIVE_POSTGRES_EXPORT_HOST").expect("host environment variable"),
        "port": std::env::var("DBX_LIVE_POSTGRES_EXPORT_PORT").expect("port environment variable")
            .parse::<u16>().expect("numeric port"),
        "username": std::env::var("DBX_LIVE_POSTGRES_EXPORT_USER").expect("user environment variable"),
        "password": std::env::var("DBX_LIVE_POSTGRES_EXPORT_PASSWORD").expect("password environment variable"),
        "database": database, "ssl": false, "connect_timeout_secs": 10,
        "query_timeout_secs": 30, "idle_timeout_secs": 60, "keepalive_interval_secs": 0
    }))
    .expect("PostgreSQL configuration")
}

fn redact(text: &str) -> String {
    let mut result = text.to_owned();
    for key in ["DBX_LIVE_POSTGRES_EXPORT_PASSWORD", "DBX_LIVE_POSTGRES_EXPORT_HOST", "DBX_LIVE_POSTGRES_EXPORT_USER"] {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() {
                result = result.replace(&value, "[redacted]");
            }
        }
    }
    result
}

fn save_json(dir: &Path, name: &str, value: &Value) {
    std::fs::write(dir.join(name), redact(&serde_json::to_string_pretty(value).unwrap())).expect("save evidence");
}

async fn query(state: &AppState, id: &str, database: &str, sql: &str) -> Result<Vec<Vec<Value>>, String> {
    Box::pin(execute_sql_statement(state, id, database, sql, None, None))
        .await
        .map(|result| result.rows)
        .map_err(|error| redact(&error))
}

async fn replay(state: &AppState, id: &str, database: &str, path: &Path) -> Result<(), String> {
    Box::pin(execute_sql_file_path(
        state,
        &SqlFileRequest {
            txn_session_id: None,
            execution_id: uuid::Uuid::new_v4().to_string(),
            connection_id: id.to_owned(),
            database: database.to_owned(),
            schema: None,
            file_path: path.display().to_string(),
            continue_on_error: false,
            selected_tables: None,
            part_cooldown_ms: 0,
            skip_relational_constraints: false,
            failure_log_enabled: false,
            resolve_includes: false,
            encoding: Default::default(),
        },
        path,
        CancellationToken::new(),
        std::time::Instant::now(),
        |_| {},
    ))
    .await
    .map_err(|error| redact(&error))
}

struct LiveCase {
    state: Arc<AppState>,
    evidence: PathBuf,
    admin: String,
    source: String,
    suffix: String,
    created: Vec<String>,
    _scratch: tempfile::TempDir,
}

impl LiveCase {
    async fn new(name: &str) -> Self {
        let root = PathBuf::from(std::env::var("DBX_REPRO_EVIDENCE_DIR").expect("evidence directory"));
        std::fs::create_dir_all(&root).unwrap();
        let evidence = root.join(name);
        std::fs::create_dir(&evidence).expect("fresh evidence directory for this case");
        let suffix = uuid::Uuid::new_v4().simple().to_string()[..12].to_owned();
        let admin = std::env::var("DBX_LIVE_POSTGRES_EXPORT_DATABASE").unwrap_or_else(|_| "dbx_test".into());
        let scratch = tempfile::tempdir().expect("isolated application data");
        let storage = dbx_core::persistence::test_storage::open(&scratch.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            scratch.path().join("plugins"),
            scratch.path().join("agents"),
            env!("CARGO_PKG_VERSION"),
        ));
        state.configs.write().await.insert("admin".into(), config("admin", &admin));
        let version_sql = "SELECT version(), current_setting('server_version_num'), \
            (SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user)";
        let version = query(&state, "admin", &admin, version_sql).await.expect("read-only version/permission probe");
        save_json(
            &evidence,
            "version.json",
            &json!({"query": version_sql, "rows": version, "dbx_core_version": env!("CARGO_PKG_VERSION")}),
        );
        assert_eq!(version[0][2], json!(true), "CREATEDB permission required; no database created");
        let mut case =
            Self { state, evidence, admin, source: String::new(), suffix, created: Vec::new(), _scratch: scratch };
        case.source = case.create_database("source").await;
        case
    }

    async fn create_database(&mut self, role: &str) -> String {
        let database = format!("dbx_14178_fix_{role}_{}", self.suffix);
        save_json(
            &self.evidence,
            "resources.json",
            &json!({"created": self.created, "creating": database, "cleanup": "not performed"}),
        );
        query(&self.state, "admin", &self.admin, &format!("CREATE DATABASE \"{database}\""))
            .await
            .expect("create task-owned database");
        self.created.push(database.clone());
        save_json(&self.evidence, "resources.json", &json!({"created": self.created, "cleanup": "not performed"}));
        self.state.configs.write().await.insert(role.into(), config(role, &database));
        database
    }

    async fn fixture(&self, statements: &[&str]) {
        std::fs::write(self.evidence.join("fixture.sql"), format!("{};\n", statements.join(";\n"))).unwrap();
        for (index, statement) in statements.iter().enumerate() {
            let result = query(&self.state, "source", &self.source, statement).await;
            if result.is_err() {
                save_json(
                    &self.evidence,
                    "fixture-error.json",
                    &json!({"index": index, "statement": statement, "result": result}),
                );
            }
            result.expect("create source fixture");
        }
    }

    fn request(&self, name: &str, include_data: bool) -> DatabaseExportRequest {
        DatabaseExportRequest {
            export_id: format!("cross-schema-{name}-{}", self.suffix),
            connection_id: "source".into(),
            database: self.source.clone(),
            schema: String::new(),
            file_path: self.evidence.join(format!("{name}.sql")).display().to_string(),
            selected_tables: Vec::new(),
            selected_objects: None,
            excluded_tables: Vec::new(),
            include_structure: true,
            include_data,
            include_objects: true,
            include_create_database: false,
            drop_table_if_exists: false,
            omit_auto_increment: false,
            omit_database_qualifier: false,
            preserve_original_language: false,
            fail_on_error: true,
            prevent_overwrite: true,
            output_compression: Default::default(),
            insert_dialect: Default::default(),
            insert_mode: Default::default(),
            snapshot_session_id: None,
            batch_size: 1,
            split_max_mb: None,
        }
    }

    async fn export(&self, name: &str, request: &DatabaseExportRequest) -> String {
        save_json(&self.evidence, &format!("{name}-request.json"), &json!(request));
        let progress = Mutex::new(Vec::new());
        let result = Box::pin(export_database_sql_core(&self.state, request, |event| {
            progress.lock().unwrap().push(event);
        }))
        .await
        .map_err(|error| redact(&error));
        let progress = progress.into_inner().unwrap();
        save_json(&self.evidence, &format!("{name}-export.json"), &json!({"result": result, "progress": progress}));
        result.expect("actual DBX all-schema export");
        let done = progress.iter().filter(|event| matches!(event.status, ExportStatus::Done)).collect::<Vec<_>>();
        assert_eq!(done.len(), 1, "only the completed final file emits Done");
        assert_eq!(done[0].error_count, 0, "strict export must not hide metadata errors");
        std::fs::read_to_string(&request.file_path).expect("read original exported SQL")
    }

    fn replay_plan(&self, name: &str, request: &DatabaseExportRequest, setup: &[&str], expectation: Value) {
        save_json(
            &self.evidence,
            &format!("{name}-independent-replay-plan.json"),
            &json!({"source_database": self.source, "sql_file": request.file_path,
                "target": "fresh task-owned database", "setup_statements": setup, "expectation": expectation}),
        );
    }

    async fn restore(&self, name: &str, role: &str, database: &str, path: &str) -> Result<(), String> {
        let result = replay(&self.state, role, database, Path::new(path)).await;
        save_json(
            &self.evidence,
            &format!("{name}-replay.json"),
            &json!({"database": database, "sql_file": path, "result": result}),
        );
        result
    }

    async fn check(&self, name: &str, role: &str, database: &str, sql: &str, expected: Value) {
        let result = query(&self.state, role, database, sql).await;
        save_json(
            &self.evidence,
            &format!("{name}-query.json"),
            &json!({"database": database, "connection_role": role, "query": sql, "result": result, "expected": expected}),
        );
        assert_eq!(json!(result.expect("query restored fixture")), expected);
    }
}

fn assert_before(sql: &str, dependency: &str, dependent: &str) {
    let dependency_pos = sql.find(dependency).unwrap_or_else(|| panic!("missing DDL: {dependency}"));
    let dependent_pos = sql.find(dependent).unwrap_or_else(|| panic!("missing DDL: {dependent}"));
    assert!(dependency_pos < dependent_pos, "{dependency} must precede {dependent}");
}

/// Uses the original exported SQL unchanged. Databases are retained for owner-approved cleanup.
#[tokio::test]
#[ignore = "requires an approved live PostgreSQL account with CREATEDB; retains task databases"]
async fn live_postgres_cross_schema_minimal_export_restores() {
    let mut case = LiveCase::new("minimal").await;
    case.fixture(MINIMAL_FIXTURE).await;
    let target = case.create_database("target").await;
    let request = case.request("original", false);
    let sql = case.export("original", &request).await;
    case.replay_plan("original", &request, &[], json!({"replay_succeeds": true,
        "query": "SELECT (SELECT count(*) FROM a_14178.report), (SELECT count(*) FROM z_14178.a_local)", "rows": [[0, 0]]}));
    assert_before(&sql, "CREATE OR REPLACE VIEW z_14178.base_view AS", "CREATE OR REPLACE VIEW a_14178.report AS");
    assert_before(&sql, "CREATE OR REPLACE VIEW z_14178.base_view AS", "CREATE OR REPLACE VIEW z_14178.a_local AS");
    case.restore("original", "target", &target, &request.file_path).await.unwrap();
    case.check(
        "restored",
        "target",
        &target,
        "SELECT (SELECT count(*) FROM a_14178.report), (SELECT count(*) FROM z_14178.a_local)",
        json!([[0, 0]]),
    )
    .await;
    save_json(
        &case.evidence,
        "outcome.json",
        &json!({"original_export_replayed": true, "same_schema_order_correct": true}),
    );
}

#[tokio::test]
#[ignore = "requires an approved live PostgreSQL account with CREATEDB; retains task databases"]
async fn live_postgres_cross_schema_matrix_restores_structure_and_data() {
    let mut case = LiveCase::new("matrix").await;
    case.fixture(MATRIX_FIXTURE).await;
    case.check("source", "source", &case.source, MATRIX_QUERY, json!([[2, 40, 2, 40, 218, 418, 2, 2]])).await;
    for include_data in [false, true] {
        let name = if include_data { "with-data" } else { "structure-only" };
        let target = case.create_database(name).await;
        let request = case.request(name, include_data);
        let sql = case.export(name, &request).await;
        for (dependency, dependent) in [
            ("CREATE OR REPLACE VIEW z_14178.base_view AS", "CREATE OR REPLACE VIEW a_14178.same AS"),
            ("CREATE OR REPLACE VIEW a_14178.same AS", "CREATE OR REPLACE VIEW z_14178.same AS"),
            ("CREATE OR REPLACE VIEW z_14178.same AS", "CREATE OR REPLACE VIEW a_14178.report AS"),
        ] {
            assert_before(&sql, dependency, dependent);
        }
        let expected =
            if include_data { json!([[2, 40, 2, 40, 218, 418, 2, 2]]) } else { json!([[0, 0, 0, 0, 0, 0, 0, 0]]) };
        case.replay_plan(
            name,
            &request,
            &[],
            json!({"replay_succeeds": true, "query": MATRIX_QUERY, "rows": expected}),
        );
        case.restore(name, name, &target, &request.file_path).await.unwrap();
        case.check(name, name, &target, MATRIX_QUERY, expected).await;
        case.check(
            &format!("{name}-post-view-objects"),
            name,
            &target,
            "SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname='z_14178' AND indexname='items_amount_idx'), \
             (SELECT count(*) FROM pg_trigger WHERE tgrelid='z_14178.items'::regclass AND tgname='items_audit'), \
             (SELECT count(*) FROM pg_constraint WHERE conrelid='a_14178.children'::regclass AND contype='f')",
            json!([[1, 1, 1]]),
        )
        .await;
        query(&case.state, name, &target, "INSERT INTO z_14178.items VALUES (99, 3)").await.unwrap();
        case.check(
            &format!("{name}-trigger"),
            name,
            &target,
            "SELECT id FROM a_14178.audit ORDER BY id",
            json!([[99]]),
        )
        .await;
        let invalid_fk = query(&case.state, name, &target, "INSERT INTO a_14178.children VALUES (99, -1)").await;
        save_json(&case.evidence, &format!("{name}-foreign-key.json"), &json!({"result": invalid_fk}));
        assert!(invalid_fk.unwrap_err().contains("23503"), "restored foreign key must enforce its reference");
    }
    save_json(
        &case.evidence,
        "outcome.json",
        &json!({"structure_and_data_replayed": true, "qualified_names_distinct": true, "post_view_objects_valid": true}),
    );
}

#[tokio::test]
#[ignore = "requires an approved live PostgreSQL account with CREATEDB; retains task databases"]
async fn live_postgres_cross_schema_selection_does_not_include_excluded_dependency() {
    let mut case = LiveCase::new("selection").await;
    case.fixture(MINIMAL_FIXTURE).await;
    let mut selected = case.request("selected-complete", false);
    selected.selected_objects = Some(
        [("TABLE", "items"), ("VIEW", "base_view"), ("VIEW", "report"), ("VIEW", "a_local")]
            .into_iter()
            .map(|(kind, name)| DatabaseExportSelectedObject {
                object_type: kind.into(),
                name: name.into(),
                signature: None,
            })
            .collect(),
    );
    case.export("selected-complete", &selected).await;
    case.replay_plan(
        "selected-complete",
        &selected,
        &[],
        json!({"replay_succeeds": true,
        "query": "SELECT count(*) FROM a_14178.report", "rows": [[0]]}),
    );
    let complete_target = case.create_database("complete").await;
    case.restore("selected-complete", "complete", &complete_target, &selected.file_path).await.unwrap();
    case.check("selected-complete", "complete", &complete_target, "SELECT count(*) FROM a_14178.report", json!([[0]]))
        .await;

    let mut excluded = case.request("excluded", false);
    excluded.excluded_tables = vec!["base_view".into()];
    let sql = case.export("excluded", &excluded).await;
    assert!(
        !sql.contains("CREATE OR REPLACE VIEW z_14178.base_view AS"),
        "excluded dependency must not be auto-included"
    );
    assert!(sql.contains("CREATE OR REPLACE VIEW a_14178.report AS"), "selected dependent must remain in the export");
    case.replay_plan(
        "excluded-missing",
        &excluded,
        &[],
        json!({"replay_succeeds": false, "sqlstate": "42P01", "missing_relation": "z_14178.base_view"}),
    );
    let missing_target = case.create_database("missing").await;
    let missing = case.restore("excluded-missing", "missing", &missing_target, &excluded.file_path).await;
    let error = missing.expect_err("the caller deliberately omitted a required external dependency");
    assert!(error.contains("42P01") && error.contains("base_view"), "unexpected missing-dependency error: {error}");

    let supplied_target = case.create_database("supplied").await;
    let supplied = ["CREATE SCHEMA z_14178", "CREATE VIEW z_14178.base_view AS SELECT 7::integer AS id"];
    std::fs::write(case.evidence.join("supplied-target-fixture.sql"), format!("{};\n", supplied.join(";\n"))).unwrap();
    case.replay_plan(
        "excluded-supplied",
        &excluded,
        &supplied,
        json!({"replay_succeeds": true,
        "query": "SELECT id FROM a_14178.report", "rows": [[7]]}),
    );
    for statement in supplied {
        query(&case.state, "supplied", &supplied_target, statement).await.unwrap();
    }
    case.restore("excluded-supplied", "supplied", &supplied_target, &excluded.file_path).await.unwrap();
    case.check("excluded-supplied", "supplied", &supplied_target, "SELECT id FROM a_14178.report", json!([[7]])).await;
    save_json(
        &case.evidence,
        "outcome.json",
        &json!({"complete_selection_replayed": true, "excluded_dependency_not_added": true, "explicitly_supplied_dependency_replayed": true}),
    );
}

/// Keep schema-local routines ahead of later schemas that already depended on them.
/// This guards existing valid exports; it does not require a general function dependency graph.
#[tokio::test]
#[ignore = "requires an approved live PostgreSQL account with CREATEDB; retains task databases"]
async fn live_postgres_cross_schema_preserves_earlier_schema_routines() {
    let mut failures = Vec::new();
    for (name, dependent_ddl, check_sql, expected) in [
        (
            "routine-default",
            "CREATE TABLE z_14178.t (id integer DEFAULT a_14178.f())",
            "INSERT INTO z_14178.t DEFAULT VALUES RETURNING id",
            json!([[7]]),
        ),
        (
            "routine-view-only",
            "CREATE VIEW z_14178.v AS SELECT a_14178.f() AS id",
            "SELECT id FROM z_14178.v",
            json!([[7]]),
        ),
        (
            "routine-forward-view",
            "CREATE VIEW z_14178.v AS SELECT a_14178.f() + e.id AS id FROM a_14178.early_view e",
            "SELECT id FROM z_14178.v",
            json!([[8]]),
        ),
    ] {
        let mut case = LiveCase::new(name).await;
        let fixture = [
            "CREATE SCHEMA a_14178",
            "CREATE SCHEMA z_14178",
            "CREATE VIEW a_14178.early_view AS SELECT 1 AS id",
            "CREATE FUNCTION a_14178.f() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 7 $$",
            dependent_ddl,
        ];
        case.fixture(&fixture).await;
        case.check("source-routine", "source", &case.source, "SELECT a_14178.f()", json!([[7]])).await;

        // The source was just created in this order. This is a constructed reference,
        // not output captured from an earlier DBX binary; preserve that distinction in evidence.
        let reference = case.evidence.join("schema-order-reference.sql");
        std::fs::write(
            &reference,
            format!(
                "-- Constructed direct schema-order reference, not an earlier binary export.\n{};\n",
                fixture.join(";\n")
            ),
        )
        .unwrap();
        save_json(
            &case.evidence,
            "reference-independent-replay-plan.json",
            &json!({"source_database": case.source, "sql_file": reference,
                "provenance": "constructed direct schema-order reference; not a baseline binary export",
                "target": "fresh task-owned database", "setup_statements": [],
                "expectation": {"replay_succeeds": true, "query": check_sql, "rows": expected}}),
        );

        let target = case.create_database("target").await;
        let request = case.request("original", false);
        case.export("original", &request).await;
        case.replay_plan(
            "original",
            &request,
            &[],
            json!({"replay_succeeds": true, "query": check_sql, "rows": expected}),
        );
        let restored = case.restore("original", "target", &target, &request.file_path).await;
        if let Err(error) = restored {
            failures.push(json!({"case": name, "stage": "replay", "error": error}));
            continue;
        }
        let result = query(&case.state, "target", &target, check_sql).await;
        save_json(
            &case.evidence,
            "restored-query.json",
            &json!({"database": target, "query": check_sql, "result": result, "expected": expected}),
        );
        match result {
            Ok(rows) if json!(rows) == expected => {
                save_json(
                    &case.evidence,
                    "outcome.json",
                    &json!({"original_export_replayed": true, "earlier_schema_routine_preserved": true}),
                );
            }
            other => failures.push(json!({"case": name, "stage": "query", "result": other, "expected": expected})),
        }
    }
    let evidence = PathBuf::from(std::env::var("DBX_REPRO_EVIDENCE_DIR").expect("evidence directory"));
    save_json(&evidence, "routine-order-summary.json", &json!({"failures": failures, "passed": failures.is_empty()}));
    assert!(failures.is_empty(), "earlier-schema routine regressions: {failures:?}");
}

/// One view can still depend on a table in a later schema; no second view is required.
#[tokio::test]
#[ignore = "requires an approved live PostgreSQL account with CREATEDB; retains task databases"]
async fn live_postgres_single_cross_schema_view_reads_later_schema_table() {
    let mut case = LiveCase::new("single-direct-view").await;
    case.fixture(&[
        "CREATE SCHEMA a_14178",
        "CREATE SCHEMA z_14178",
        "CREATE TABLE z_14178.items (id integer PRIMARY KEY)",
        "CREATE VIEW a_14178.direct_view AS SELECT id FROM z_14178.items",
    ])
    .await;
    let target = case.create_database("target").await;
    let request = case.request("original", false);
    let sql = case.export("original", &request).await;
    let check_sql = "SELECT count(*) FROM a_14178.direct_view";
    case.replay_plan("original", &request, &[], json!({"replay_succeeds": true, "query": check_sql, "rows": [[0]]}));
    case.restore("original", "target", &target, &request.file_path).await.unwrap();
    assert_before(&sql, "CREATE TABLE \"z_14178\".\"items\"", "CREATE OR REPLACE VIEW a_14178.direct_view AS");
    case.check("restored", "target", &target, check_sql, json!([[0]])).await;
    save_json(
        &case.evidence,
        "outcome.json",
        &json!({"original_export_replayed": true, "single_view_dependency_order_correct": true}),
    );
}
