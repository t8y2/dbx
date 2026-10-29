use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use dbx_core::connection::{AppState, PoolKind};
use dbx_core::db::duckdb_worker_process::DuckDbWorkerClient;
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::query::{close_query_session, execute_sql_statement_with_options, QueryExecutionOptions};
use dbx_core::query_result_export::{export_query_result_core, QueryResultExportRequest};
use dbx_core::table_export::{export_table_data_core, TableExportRequest};
use dbx_core::table_import::{parse_csv_bytes, parse_xlsx_file};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

fn run_with_stack<F: std::future::Future<Output = ()> + 'static>(test: impl FnOnce() -> F + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(Box::pin(test()));
        })
        .unwrap()
        .join()
        .unwrap();
}

pub fn run_parquet_exports(driver: PathBuf) {
    run_with_stack(move || parquet_exports_are_consistent(driver));
}

pub fn run_snapshot_cleanup(driver: PathBuf) {
    run_with_stack(move || snapshots_preserve_query_values_and_cleanup(driver));
}

pub fn run_query_pages(driver: PathBuf) {
    run_with_stack(move || query_pages_preserve_one_execution(driver));
}

struct Fixture {
    state: AppState,
    client: Arc<DuckDbWorkerClient>,
    id: String,
    dir: PathBuf,
}

impl Fixture {
    async fn new(driver: PathBuf) -> Self {
        let id = format!("duckdb-export-{}", uuid::Uuid::new_v4().simple());
        let dir = std::env::temp_dir().join(&id);
        std::fs::create_dir_all(&dir).unwrap();
        let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id": id, "name": id, "db_type": "duckdb", "host": ":memory:",
            "port": 0, "username": "", "password": "", "database": "main",
            "query_timeout_secs": 60, "keepalive_interval_secs": 0
        }))
        .unwrap();
        let client = Arc::new(
            DuckDbWorkerClient::open_with_executable(
                driver,
                ":memory:".into(),
                vec![],
                Some("SET threads = 4; SET preserve_insertion_order = false".into()),
            )
            .await
            .unwrap(),
        );
        state.configs.write().await.insert(id.clone(), config.clone());
        state.insert_connection_pool(id.clone(), PoolKind::DuckDbWorker(client.clone()), &config).await.unwrap();
        Self { state, client, id, dir }
    }

    async fn sql(&self, sql: &str) -> dbx_core::types::QueryResult {
        self.client.execute(None, sql.into(), Some(50), None, None).await.unwrap()
    }

    async fn assert_clean(&self) {
        let result = self.sql(
            "SELECT count(*) FROM duckdb_tables() WHERE database_name = 'temp' AND starts_with(table_name, '__dbx_export_')",
        ).await;
        assert_eq!(cell_number(&result.rows[0][0]), 0);
        let result = self.sql(
            "SELECT count(*) FROM duckdb_tables() WHERE database_name = 'temp' AND starts_with(table_name, '__dbx_result_')",
        ).await;
        assert_eq!(cell_number(&result.rows[0][0]), 0);
        assert_eq!(cell_number(&self.sql("SELECT * FROM keep_me").await.rows[0][0]), 42);
    }

    fn query_request(&self, sql: &str, path: &Path, format: &str) -> QueryResultExportRequest {
        serde_json::from_value(json!({
            "exportId": uuid::Uuid::new_v4().to_string(), "connectionId": self.id,
            "database": "main", "schema": "main", "databaseType": "duckdb",
            "sql": sql, "queryBaseSql": sql, "filePath": path,
            "format": format, "pageSize": 512, "includeSqlSheet": false,
            "numericColumnRightAlign": false
        }))
        .unwrap()
    }

    async fn finish(self) {
        self.client.shutdown().await;
        drop(self.state);
        let _ = std::fs::remove_dir_all(self.dir);
    }
}

fn cell_number(value: &Value) -> i64 {
    value.as_i64().unwrap_or_else(|| cell_text(value).parse::<f64>().unwrap().round() as i64)
}

fn cell_text(value: &Value) -> String {
    value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string())
}

fn verify_export(path: &Path, format: &str) {
    let parsed = if format == "csv" {
        parse_csv_bytes(&std::fs::read(path).unwrap(), 20_001).unwrap()
    } else {
        parse_xlsx_file(path.to_str().unwrap(), 20_001).unwrap()
    };
    assert_eq!(parsed.columns, vec!["rowid", "项目名称", "结算账期", "金额"]);
    let mut ids = BTreeSet::new();
    let mut totals = BTreeMap::<String, i64>::new();
    for row in &parsed.rows {
        let id = cell_number(&row[0]);
        assert!(ids.insert(id), "duplicate id {id} in {}", path.display());
        assert_eq!(cell_text(&row[2]), "2026-09");
        let cents = (cell_text(&row[3]).parse::<f64>().unwrap() * 100.0).round() as i64;
        assert_eq!(cents, id + 1, "amount for id {id}");
        *totals.entry(cell_text(&row[1])).or_default() += cents;
    }
    let expected_ids = (0..20_000).filter(|id| id % 5 != 0).collect::<BTreeSet<_>>();
    let mut expected_totals = BTreeMap::<String, i64>::new();
    for id in &expected_ids {
        let project = if *id < 5_000 {
            "Project A"
        } else if *id < 10_000 {
            "Project B"
        } else {
            "Project C"
        };
        *expected_totals.entry(project.into()).or_default() += id + 1;
    }
    assert_eq!(ids, expected_ids, "missing rows in {}", path.display());
    assert_eq!(totals, expected_totals, "project totals in {}", path.display());
}

async fn parquet_exports_are_consistent(driver: PathBuf) {
    let fixture = Fixture::new(driver).await;
    fixture.sql("CREATE TEMP TABLE keep_me AS SELECT 42").await;
    let parquet = fixture.dir.join("settlements.parquet").to_string_lossy().replace('\\', "/");
    fixture.sql(&format!(
        "COPY (SELECT i AS id, CASE WHEN i < 5000 THEN 'Project A' WHEN i < 10000 THEN 'Project B' ELSE 'Project C' END AS project, \
         CASE WHEN i % 5 = 0 THEN '2025-09' ELSE '2026-09' END AS period, \
         ((i + 1) / 100.0)::DECIMAL(18,2) AS amount FROM range(20000) t(i)) \
         TO '{}' (FORMAT PARQUET, ROW_GROUP_SIZE 2048)", parquet.replace('\'', "''")
    )).await;
    fixture.sql(&format!(
        "CREATE VIEW settlements AS SELECT id AS rowid, project AS \"项目名称\", period AS \"结算账期\", amount AS \"金额\" FROM read_parquet('{}')",
        parquet.replace('\'', "''")
    )).await;
    let sql = "SELECT * FROM settlements WHERE \"结算账期\" LIKE '%2026%' ORDER BY \"结算账期\" DESC";
    for preserve in [false, true] {
        fixture.sql(&format!("SET preserve_insertion_order = {preserve}")).await;
        fixture.state.configs.write().await.get_mut(&fixture.id).unwrap().read_only = preserve;
        for format in ["csv", "xlsx"] {
            for table_export in [true, false] {
                let path = fixture.dir.join(format!("{preserve}-{table_export}.{format}"));
                if table_export {
                    let request: TableExportRequest = serde_json::from_value(json!({
                        "exportId": uuid::Uuid::new_v4().to_string(), "connectionId": fixture.id,
                        "database": "main", "schema": "main", "tableName": "settlements",
                        "filePath": path, "format": format, "numericColumnRightAlign": false,
                        "columns": ["rowid", "项目名称", "结算账期", "金额"],
                        "columnTypes": ["BIGINT", "VARCHAR", "VARCHAR", "DECIMAL(18,2)"],
                        "primaryKeys": [], "skipCount": true, "batchSize": 512,
                        "whereInput": "\"结算账期\" LIKE '%2026%'", "orderBy": "\"结算账期\" DESC"
                    }))
                    .unwrap();
                    export_table_data_core(&fixture.state, &request, |_| {}).await.unwrap();
                } else {
                    let request = fixture.query_request(sql, &path, format);
                    export_query_result_core(&fixture.state, &request, None, |_| {}).await.unwrap();
                }
                verify_export(&path, format);
                fixture.assert_clean().await;
            }
        }
    }
    fixture.finish().await;
}

async fn snapshots_preserve_query_values_and_cleanup(driver: PathBuf) {
    let fixture = Fixture::new(driver).await;
    fixture.sql("CREATE TEMP TABLE keep_me AS SELECT 42").await;
    fixture.sql("CREATE SEQUENCE calls START 1").await;
    let path = fixture.dir.join("query.csv");
    let sql =
        "SELECT nextval('calls') AS id, i AS dup, -i AS dup, i AS rowid FROM range(2050) t(i); -- trailing comment";
    let request = fixture.query_request(sql, &path, "csv");
    export_query_result_core(&fixture.state, &request, None, |_| {}).await.unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap();
    assert_eq!(text.trim_start_matches('\u{feff}').lines().next(), Some("\"id\",\"dup\",\"dup\",\"rowid\""));
    let parsed = parse_csv_bytes(&bytes, 2051).unwrap();
    // The importer assigns unique header names; the CSV itself keeps both labels.
    assert_eq!(parsed.columns, vec!["id", "dup", "dup_1", "rowid"]);
    assert_eq!(parsed.rows.len(), 2050);
    for (i, row) in parsed.rows.iter().enumerate() {
        assert_eq!(
            row.iter().map(cell_number).collect::<Vec<_>>(),
            vec![i as i64 + 1, i as i64, -(i as i64), i as i64]
        );
    }
    assert_eq!(cell_number(&fixture.sql("SELECT nextval('calls')").await.rows[0][0]), 2051);
    fixture.assert_clean().await;

    // Native DuckDB exposes SQL BEGIN/ROLLBACK on its shared session, rather
    // than DBX manual-transaction handles. Export must see pending writes and
    // must not commit or discard the user's transaction.
    assert!(dbx_core::query::begin_manual_transaction(&fixture.state, &fixture.id, "main", None, None)
        .await
        .unwrap_err()
        .contains("not supported"));
    fixture.sql("CREATE TABLE transaction_values (id INT)").await;
    fixture.sql("BEGIN").await;
    fixture.sql("INSERT INTO transaction_values VALUES (42)").await;
    let request = fixture.query_request("SELECT * FROM transaction_values", &path, "csv");
    let preparing = std::sync::atomic::AtomicBool::new(false);
    export_query_result_core(&fixture.state, &request, None, |progress| {
        if matches!(progress.status, dbx_core::table_export::ExportStatus::PreparingSnapshot) {
            preparing.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    })
    .await
    .unwrap();
    assert!(preparing.load(std::sync::atomic::Ordering::Relaxed));
    let parsed = parse_csv_bytes(&std::fs::read(&path).unwrap(), 10).unwrap();
    assert_eq!(parsed.rows.len(), 1);
    assert_eq!(cell_number(&parsed.rows[0][0]), 42);
    fixture.sql("ROLLBACK").await;
    assert!(fixture.sql("SELECT * FROM transaction_values").await.rows.is_empty());
    fixture.assert_clean().await;

    let mut request = fixture.query_request("SELECT * FROM range(2050) t(id) ORDER BY id DESC", &path, "csv");
    request.row_limit = Some(513);
    export_query_result_core(&fixture.state, &request, None, |_| {}).await.unwrap();
    let parsed = parse_csv_bytes(&std::fs::read(&path).unwrap(), 2051).unwrap();
    assert_eq!(parsed.rows.len(), 513);
    assert_eq!(cell_number(&parsed.rows[0][0]), 2049);
    assert_eq!(cell_number(&parsed.rows[512][0]), 1537);
    fixture.assert_clean().await;

    let request = fixture.query_request("SELECT * FROM range(2050)", &fixture.dir, "xlsx");
    assert!(export_query_result_core(&fixture.state, &request, None, |_| {}).await.is_err());
    fixture.assert_clean().await;

    fixture.sql("CREATE VIEW source AS SELECT * FROM range(2050) t(id)").await;
    let table_request: TableExportRequest = serde_json::from_value(json!({
        "exportId": uuid::Uuid::new_v4().to_string(), "connectionId": fixture.id,
        "database": "main", "schema": "main", "tableName": "source",
        "filePath": fixture.dir, "format": "xlsx", "numericColumnRightAlign": false,
        "columns": ["id"], "columnTypes": ["BIGINT"], "primaryKeys": [], "skipCount": true
    }))
    .unwrap();
    assert!(export_table_data_core(&fixture.state, &table_request, |_| {}).await.is_err());
    fixture.assert_clean().await;

    let request = fixture.query_request("SELECT * FROM range(2050)", &path, "csv");
    let token = CancellationToken::new();
    export_query_result_core(&fixture.state, &request, Some(token.clone()), |progress| {
        if progress.rows_exported >= 512 {
            token.cancel();
        }
    })
    .await
    .unwrap();
    fixture.assert_clean().await;
    fixture.finish().await;
}

async fn query_pages_preserve_one_execution(driver: PathBuf) {
    let fixture = Fixture::new(driver).await;
    fixture.sql("CREATE TEMP TABLE keep_me AS SELECT 42").await;
    fixture.sql("CREATE SEQUENCE page_calls START 1").await;
    fixture.sql("CREATE TABLE page_source AS SELECT i AS id, 'same' AS period FROM range(20000) t(i)").await;
    for sql in ["SHOW TABLES", "EXPLAIN SELECT 42", "DESCRIBE page_source"] {
        let result = execute_sql_statement_with_options(
            &fixture.state,
            &fixture.id,
            "main",
            sql,
            None,
            None,
            QueryExecutionOptions { page_size: Some(100), max_rows: Some(1000), ..Default::default() },
        )
        .await
        .unwrap();
        assert!(!result.rows.is_empty());
        assert!(!result.has_more);
    }
    for order in ["", " ORDER BY period"] {
        let sql = format!("SELECT id, period FROM page_source{order}; -- trailing comment");
        let mut session_id = None;
        let mut ids = BTreeSet::new();
        loop {
            let page = execute_sql_statement_with_options(
                &fixture.state,
                &fixture.id,
                "main",
                &sql,
                None,
                None,
                QueryExecutionOptions {
                    page_size: Some(512),
                    max_rows: Some(20000),
                    result_session_id: session_id.clone(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert!(page.rows.len() <= 512);
            for row in &page.rows {
                assert!(ids.insert(cell_number(&row[0])), "duplicate grid row");
            }
            session_id = page.session_id;
            if !page.has_more {
                break;
            }
            assert!(session_id.is_some());
        }
        assert_eq!(ids, (0..20000).collect());
        fixture.assert_clean().await;
    }
    let sql = "SELECT nextval('page_calls') AS dup, i AS dup, i AS rowid FROM range(2050) t(i)";
    let mut session_id = None;
    let mut values = Vec::new();
    loop {
        let page = execute_sql_statement_with_options(
            &fixture.state,
            &fixture.id,
            "main",
            sql,
            None,
            None,
            QueryExecutionOptions {
                page_size: Some(100),
                max_rows: Some(2050),
                result_session_id: session_id.clone(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(page.columns, vec!["dup", "dup", "rowid"]);
        values.extend(page.rows.iter().map(|row| cell_number(&row[0])));
        session_id = page.session_id;
        if !page.has_more {
            break;
        }
    }
    assert_eq!(values, (1..=2050).collect::<Vec<_>>());
    assert_eq!(cell_number(&fixture.sql("SELECT nextval('page_calls')").await.rows[0][0]), 2051);
    fixture.assert_clean().await;

    let sql = "SELECT * FROM range(2050) t(id) ORDER BY id";
    let first = fixture.client.execute_query_page(None, sql.into(), Some(513), 500, None, None, None).await.unwrap();
    assert!(first.has_more);
    let last = fixture
        .client
        .execute_query_page(None, sql.into(), Some(513), 500, first.session_id.as_deref(), None, None)
        .await
        .unwrap();
    assert_eq!(last.rows.len(), 13);
    assert!(!last.has_more);
    assert!(last.truncated);
    fixture.assert_clean().await;

    let first = fixture.client.execute_query_page(None, sql.into(), Some(2050), 100, None, None, None).await.unwrap();
    let id = first.session_id.unwrap();
    assert!(close_query_session(&fixture.state, &fixture.id, "main", &id, None, None).await.unwrap());
    assert!(fixture
        .client
        .execute_query_page(None, sql.into(), Some(2050), 100, Some(&id), None, None)
        .await
        .unwrap_err()
        .contains("expired"));
    fixture.assert_clean().await;
    fixture.finish().await;
}
