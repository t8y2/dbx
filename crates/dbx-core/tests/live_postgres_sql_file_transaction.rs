//! Regression coverage for #12160: a SQL file that contains its own
//! `BEGIN` / `COMMIT` must run on one pinned session, and the session must be
//! released when the file finishes so an unfinished transaction cannot stay
//! `idle in transaction` in the shared pool and block later work.
//!
//! Run explicitly with a writable PostgreSQL:
//!
//! ```sh
//! DBX_LIVE_POSTGRES_HOST=127.0.0.1 \
//! DBX_LIVE_POSTGRES_PORT=55432 \
//! DBX_LIVE_POSTGRES_USER=postgres \
//! DBX_LIVE_POSTGRES_PASSWORD=postgres \
//! DBX_LIVE_POSTGRES_DATABASE=postgres \
//! cargo test -p dbx-core --test live_postgres_sql_file_transaction -- --ignored --nocapture
//! ```
use dbx_core::connection::AppState;
use dbx_core::data::sql_file_import::execute_sql_file_content;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::sql::SqlFileRequest;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn postgres_url(database: &str, application_name: &str) -> String {
    let host = env_or("DBX_LIVE_POSTGRES_HOST", "127.0.0.1");
    let port = env_or("DBX_LIVE_POSTGRES_PORT", "5432");
    let user = env_or("DBX_LIVE_POSTGRES_USER", "postgres");
    let password = env_or("DBX_LIVE_POSTGRES_PASSWORD", "");
    format!("postgres://{user}:{password}@{host}:{port}/{database}?application_name={application_name}")
}

struct TestContext {
    state: AppState,
    database: String,
    application_name: String,
    _directory: tempfile::TempDir,
}

async fn setup() -> TestContext {
    let directory = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("state.db")).await.unwrap();
    let state = AppState::new(storage);
    let database = env_or("DBX_LIVE_POSTGRES_DATABASE", "postgres");
    let application_name = format!("dbx_sql_file_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "file-writer",
        "name": "SQL file transaction regression",
        "db_type": DatabaseType::Postgres,
        "host": env_or("DBX_LIVE_POSTGRES_HOST", "127.0.0.1"),
        "port": env_or("DBX_LIVE_POSTGRES_PORT", "5432").parse::<u16>().unwrap(),
        "username": env_or("DBX_LIVE_POSTGRES_USER", "postgres"),
        "password": env_or("DBX_LIVE_POSTGRES_PASSWORD", ""),
        "database": database,
        "url_params": format!("application_name={application_name}"),
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "keepalive_interval_secs": 0,
    }))
    .unwrap();
    state.configs.write().await.insert(config.id.clone(), config);
    TestContext { state, database, application_name, _directory: directory }
}

fn request(database: &str, execution_id: &str) -> SqlFileRequest {
    SqlFileRequest {
        execution_id: execution_id.to_string(),
        connection_id: "file-writer".to_string(),
        database: database.to_string(),
        schema: None,
        file_path: String::new(),
        continue_on_error: false,
        txn_session_id: None,
        selected_tables: None,
        part_cooldown_ms: 0,
        skip_relational_constraints: false,
        failure_log_enabled: true,
        encoding: Default::default(),
    }
}

async fn query(state: &AppState, database: &str, sql: &str) -> Result<dbx_core::types::QueryResult, String> {
    execute_sql_statement(state, "file-writer", database, sql, None, None).await
}

/// A file that opens a transaction and never commits must not leave the pooled
/// connection `idle in transaction` after the execution returns. The check runs
/// on an independent connection: querying through the same pool can land on the
/// very connection that holds the transaction, where it would read `active`.
#[tokio::test]
#[ignore = "requires a writable PostgreSQL pointed at by DBX_LIVE_POSTGRES_*"]
async fn live_postgres_sql_file_releases_unfinished_transaction() {
    let context = setup().await;
    let request = request(&context.database, "unfinished-transaction");

    execute_sql_file_content(
        &context.state,
        &request,
        "BEGIN;\nSELECT 1;\n",
        CancellationToken::new(),
        Instant::now(),
        |_| {},
    )
    .await
    .expect("SQL file execution");

    let observer = dbx_core::db::postgres::connect(
        &postgres_url(&context.database, &format!("{}_observer", context.application_name)),
        Duration::from_secs(5),
    )
    .await
    .expect("connect observer");
    let idle = dbx_core::db::postgres::execute_query_with_schema(
        &observer,
        "public",
        &format!(
            "SELECT count(*)::text FROM pg_stat_activity \
             WHERE application_name = '{}' AND state = 'idle in transaction'",
            context.application_name
        ),
    )
    .await
    .expect("inspect pg_stat_activity");
    observer.close();

    assert_eq!(
        idle.rows.first().and_then(|row| row.first()).and_then(|value| value.as_str()),
        Some("0"),
        "SQL file execution left an idle-in-transaction connection in the pool"
    );

    context.state.shutdown(Duration::from_secs(10)).await;
}

/// The exact scenario from #12160: run the same file twice, dropping the table
/// between runs. A leftover transaction from the first run blocks the drop (or
/// the second run) until the query timeout.
#[tokio::test]
#[ignore = "requires a writable PostgreSQL pointed at by DBX_LIVE_POSTGRES_*"]
async fn live_postgres_sql_file_with_explicit_transaction_runs_twice() {
    let context = setup().await;
    let request = request(&context.database, "two-runs");
    let table = format!("dbx_file_txn_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
    let file = format!(
        "BEGIN;\n\
         CREATE TABLE public.{table} (\n\
             id int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n\
             item_code varchar(64) NOT NULL DEFAULT '',\n\
             title varchar(255) NOT NULL DEFAULT '',\n\
             content text NOT NULL DEFAULT ''\n\
         );\n\
         INSERT INTO public.{table} (item_code, title, content)\n\
             VALUES ('PROD-001', 'item', '<div>content</div>');\n\
         ALTER TABLE public.{table} ADD COLUMN IF NOT EXISTS extra_tag varchar(64) NOT NULL DEFAULT '';\n\
         ALTER TABLE public.{table} RENAME TO {table}_old;\n\
         CREATE TABLE public.{table} (\n\
             id int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n\
             item_code varchar(64) NOT NULL DEFAULT '',\n\
             title varchar(255) NOT NULL DEFAULT '',\n\
             content text NOT NULL DEFAULT '',\n\
             extra_tag varchar(64) NOT NULL DEFAULT ''\n\
         );\n\
         INSERT INTO public.{table} (item_code, title, content, extra_tag)\n\
             SELECT item_code, title, content, extra_tag FROM public.{table}_old ORDER BY id;\n\
         DROP TABLE public.{table}_old;\n\
         COMMIT;\n"
    );

    execute_sql_file_content(&context.state, &request, &file, CancellationToken::new(), Instant::now(), |_| {})
        .await
        .expect("first SQL file execution");
    query(&context.state, &context.database, &format!("DROP TABLE public.{table}")).await.expect("drop between runs");

    let second = tokio::time::timeout(
        Duration::from_secs(20),
        execute_sql_file_content(&context.state, &request, &file, CancellationToken::new(), Instant::now(), |_| {}),
    )
    .await
    .expect("second SQL file execution must not hang");
    second.expect("second SQL file execution");
    query(&context.state, &context.database, &format!("DROP TABLE public.{table}")).await.expect("cleanup");

    context.state.shutdown(Duration::from_secs(10)).await;
}

/// `skip_relational_constraints` restores triggers on the shared pool after the
/// import. A file that leaves a transaction open (here: `BEGIN` + `LOCK TABLE`,
/// then a failing statement) must not keep the pinned session's lock while that
/// restore runs, or the restore blocks until the query timeout.
#[tokio::test]
#[ignore = "requires a writable PostgreSQL pointed at by DBX_LIVE_POSTGRES_*"]
async fn live_postgres_sql_file_releases_session_before_constraint_restore() {
    let context = setup().await;
    let table = format!("dbx_file_lock_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
    query(
        &context.state,
        &context.database,
        &format!("CREATE TABLE public.{table} (id int PRIMARY KEY, parent_id int REFERENCES public.{table}(id))"),
    )
    .await
    .expect("create probe table");

    let mut request = request(&context.database, "constraint-restore");
    request.skip_relational_constraints = true;
    let file = format!(
        "BEGIN;\n\
         LOCK TABLE public.{table} IN ACCESS EXCLUSIVE MODE;\n\
         SELECT missing_column FROM public.{table};\n"
    );

    let started = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        execute_sql_file_content(&context.state, &request, &file, CancellationToken::new(), Instant::now(), |_| {}),
    )
    .await
    .expect("constraint restore must not block on the pinned session");
    assert!(result.is_err(), "the missing column must fail the import");
    assert!(started.elapsed() < Duration::from_secs(15), "constraint restore waited on the pinned session's lock");

    let disabled = query(
        &context.state,
        &context.database,
        &format!(
            "SELECT count(*)::text FROM pg_trigger \
             WHERE tgrelid = 'public.{table}'::regclass AND tgenabled = 'D'"
        ),
    )
    .await
    .expect("inspect trigger state");
    assert_eq!(
        disabled.rows.first().and_then(|row| row.first()).and_then(|value| value.as_str()),
        Some("0"),
        "constraint restore did not re-enable the probe table's triggers"
    );

    query(&context.state, &context.database, &format!("DROP TABLE public.{table}")).await.expect("cleanup");
    context.state.shutdown(Duration::from_secs(10)).await;
}
