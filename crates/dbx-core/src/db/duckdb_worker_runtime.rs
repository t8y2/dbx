#![cfg(feature = "duckdb-bundled")]

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdout};

use crate::db;
use crate::db::duckdb_worker_protocol::{
    DuckDbWorkerColumnParams, DuckDbWorkerConnectParams, DuckDbWorkerDatabaseParams, DuckDbWorkerError,
    DuckDbWorkerExecuteParams, DuckDbWorkerMethod, DuckDbWorkerRequest, DuckDbWorkerResponse, DuckDbWorkerTableParams,
};
use crate::models::connection::AttachedDatabaseConfig;
use crate::path_utils::expand_tilde;

#[derive(Default)]
pub struct DuckDbWorkerSession {
    connection: Option<Arc<db::duckdb_driver::DuckDbConnection>>,
    attached_names: Vec<String>,
}

impl DuckDbWorkerSession {
    pub fn connect(&mut self, params: DuckDbWorkerConnectParams) -> Result<(), String> {
        let path = expand_tilde(&params.path);
        let connection = db::duckdb_driver::connect_path(&path)?;
        let mut attached_names = Vec::new();
        {
            let locked = connection.lock().map_err(|e| e.to_string())?;
            for attached in &params.attached_databases {
                let path = expand_tilde(&attached.path);
                crate::schema::duckdb_attach_database(&locked, &attached.name, &path)?;
                attached_names.push(attached.name.clone());
            }
            if let Some(script) = params.init_script.as_deref() {
                // Track script attachments by diffing the actual catalog list
                // instead of parsing the SQL, so ATTACH without an alias,
                // dynamic statements, and extension-specific syntax all count.
                let before = duckdb_catalog_list(&locked)?;
                db::duckdb_driver::run_init_script(&locked, script)?;
                for name in duckdb_catalog_list(&locked)? {
                    if !before.iter().any(|existing| existing.eq_ignore_ascii_case(&name))
                        && !attached_names.iter().any(|attached| attached.eq_ignore_ascii_case(&name))
                    {
                        attached_names.push(name);
                    }
                }
            }
        }
        self.connection = Some(connection);
        self.attached_names = attached_names;
        Ok(())
    }

    pub fn execute(&mut self, params: DuckDbWorkerExecuteParams) -> Result<db::QueryResult, String> {
        let connection = self.connection.as_ref().ok_or("DuckDB worker is not connected")?.clone();
        let locked = connection.lock().map_err(|e| e.to_string())?;
        let result = crate::query::duckdb_execute_for_database(
            &locked,
            &self.attached_names,
            params.database.as_deref(),
            &params.sql,
            params.max_rows,
        )?;
        if let Some(name) = crate::db::duckdb_sql::attached_name_from_attach_sql(&params.sql) {
            if !self.attached_names.iter().any(|attached| attached.eq_ignore_ascii_case(&name)) {
                self.attached_names.push(name);
            }
        }
        Ok(result)
    }

    pub fn list_databases(&self) -> Result<Vec<db::DatabaseInfo>, String> {
        let connection = self.connection.as_ref().ok_or("DuckDB worker is not connected")?.clone();
        let locked = connection.lock().map_err(|e| e.to_string())?;
        crate::schema::duckdb_list_databases_with_attached(&locked, &self.attached_names)
    }

    pub fn list_schemas(&self, params: DuckDbWorkerDatabaseParams) -> Result<Vec<String>, String> {
        let connection = self.connection.as_ref().ok_or("DuckDB worker is not connected")?.clone();
        let locked = connection.lock().map_err(|e| e.to_string())?;
        crate::schema::duckdb_list_schemas_with_attached(&locked, &params.database, &self.attached_names)
    }

    pub fn list_tables(&self, params: DuckDbWorkerTableParams) -> Result<Vec<db::TableInfo>, String> {
        let connection = self.connection.as_ref().ok_or("DuckDB worker is not connected")?.clone();
        let locked = connection.lock().map_err(|e| e.to_string())?;
        crate::schema::duckdb_query_tables_in_database_with_attached(
            &locked,
            &params.database,
            &params.schema,
            &self.attached_names,
        )
    }

    pub fn list_columns(&self, params: DuckDbWorkerColumnParams) -> Result<Vec<db::ColumnInfo>, String> {
        let connection = self.connection.as_ref().ok_or("DuckDB worker is not connected")?.clone();
        let locked = connection.lock().map_err(|e| e.to_string())?;
        crate::schema::duckdb_query_columns_in_database_with_attached(
            &locked,
            &params.database,
            &params.schema,
            &params.table,
            &self.attached_names,
        )
    }

    pub fn attach_database(&mut self, attached: AttachedDatabaseConfig) -> Result<(), String> {
        let connection = self.connection.as_ref().ok_or("DuckDB worker is not connected")?.clone();
        let locked = connection.lock().map_err(|e| e.to_string())?;
        let path = expand_tilde(&attached.path);
        crate::schema::duckdb_attach_database(&locked, &attached.name, &path)?;
        self.attached_names.push(attached.name);
        Ok(())
    }

    fn interrupt_handle(&self) -> Result<Arc<duckdb::InterruptHandle>, String> {
        let connection = self.connection.as_ref().ok_or("DuckDB worker is not connected")?.clone();
        Ok(connection.interrupt_handle())
    }

    /// Probes whether the connection is still usable after an execute error.
    ///
    /// duckdb-rs 1.10503.1 has a bug where `Connection::prepare()` failing at the
    /// `duckdb_extract_statements` stage (a syntax `Parser Error`) permanently poisons
    /// the connection: every later operation returns `resource deadlock would occur`,
    /// and dropping the connection aborts the whole process. Benign errors (binder,
    /// catalog, runtime) do not poison the connection.
    ///
    /// This probe runs a trivial query through `execute_batch`, which uses the
    /// non-poisoning `duckdb_query_arrow` path and fails fast on a poisoned connection.
    /// It returns `true` when the connection is healthy and safe to reuse.
    fn is_connection_healthy(&self) -> bool {
        match self.connection.as_ref() {
            Some(connection) => match connection.lock() {
                Ok(locked) => locked.execute_batch("SELECT 1").is_ok(),
                Err(_) => false,
            },
            None => false,
        }
    }
}

fn duckdb_catalog_list(con: &duckdb::Connection) -> Result<Vec<String>, String> {
    let mut stmt = con.prepare("SHOW DATABASES").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

#[derive(Clone, Default)]
struct DuckDbWorkerRuntime {
    session: Arc<Mutex<DuckDbWorkerSession>>,
    active_interrupt: Arc<Mutex<Option<Arc<duckdb::InterruptHandle>>>>,
}

struct WorkerHandleResult {
    response: Option<DuckDbWorkerResponse>,
    shutdown: bool,
}

impl DuckDbWorkerRuntime {
    async fn handle_request(
        &self,
        request: DuckDbWorkerRequest,
        stdout: Arc<tokio::sync::Mutex<Stdout>>,
    ) -> WorkerHandleResult {
        match request.method {
            DuckDbWorkerMethod::Connect => self.handle_session_request(request, |session, request| {
                session.connect(request.parse_params()?)?;
                Ok(DuckDbWorkerResponse::ok(request.id, serde_json::json!({ "connected": true })))
            }),
            DuckDbWorkerMethod::ListDatabases => self.handle_session_request(request, |session, request| {
                Ok(DuckDbWorkerResponse::ok(request.id, session.list_databases()?))
            }),
            DuckDbWorkerMethod::ListSchemas => self.handle_session_request(request, |session, request| {
                let params = request.parse_params()?;
                Ok(DuckDbWorkerResponse::ok(request.id, session.list_schemas(params)?))
            }),
            DuckDbWorkerMethod::ListTables => self.handle_session_request(request, |session, request| {
                let params = request.parse_params()?;
                Ok(DuckDbWorkerResponse::ok(request.id, session.list_tables(params)?))
            }),
            DuckDbWorkerMethod::ListColumns => self.handle_session_request(request, |session, request| {
                let params = request.parse_params()?;
                Ok(DuckDbWorkerResponse::ok(request.id, session.list_columns(params)?))
            }),
            DuckDbWorkerMethod::AttachDatabase => self.handle_session_request(request, |session, request| {
                session.attach_database(request.parse_params()?)?;
                Ok(DuckDbWorkerResponse::ok_empty(request.id))
            }),
            DuckDbWorkerMethod::Execute => {
                if self.active_interrupt.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
                    return WorkerHandleResult {
                        response: Some(DuckDbWorkerResponse::err(
                            request.id,
                            DuckDbWorkerError::new("duckdb_worker_busy", "DuckDB worker is already executing a query"),
                        )),
                        shutdown: false,
                    };
                }

                let interrupt_handle = match self.session.lock().unwrap_or_else(|e| e.into_inner()).interrupt_handle() {
                    Ok(handle) => handle,
                    Err(err) => {
                        return WorkerHandleResult {
                            response: Some(DuckDbWorkerResponse::err(
                                request.id,
                                DuckDbWorkerError::from_message("duckdb_not_connected", err),
                            )),
                            shutdown: false,
                        }
                    }
                };
                *self.active_interrupt.lock().unwrap_or_else(|e| e.into_inner()) = Some(interrupt_handle);

                let session = self.session.clone();
                let active_interrupt = self.active_interrupt.clone();
                tokio::spawn(async move {
                    let id = request.id.clone();
                    let params = request.parse_params::<DuckDbWorkerExecuteParams>();
                    let (result, poisoned) = match params {
                        Ok(params) => {
                            let probe_session = session.clone();
                            tokio::task::spawn_blocking(move || {
                                let mut session = probe_session.lock().unwrap_or_else(|e| e.into_inner());
                                let result = session.execute(params);
                                // Only probe connection health when execute failed: a syntax
                                // Parser Error can poison the connection (duckdb-rs bug), and any
                                // later use — including drop — would abort the process.
                                let poisoned = result.is_err() && !session.is_connection_healthy();
                                (result, poisoned)
                            })
                            .await
                            .map_err(|e| e.to_string())
                            .unwrap_or_else(|err| (Err(err), true))
                        }
                        Err(err) => (Err(err.message), false),
                    };
                    *active_interrupt.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    let response = match result {
                        Ok(result) => DuckDbWorkerResponse::ok(id, result),
                        // A poisoned connection cannot be reused or even safely dropped in-process.
                        // Report a distinct code so the parent kills this worker (OS-level, skipping
                        // destructors) and restarts a fresh one on the next request. We must not exit
                        // here ourselves: process::exit races the parent's next request, which could
                        // be written to a dying worker. Killing on the parent side has no such window.
                        Err(err) if poisoned => {
                            log::warn!("[duckdb-worker:poisoned-connection] reporting to parent for restart");
                            DuckDbWorkerResponse::err(
                                id,
                                DuckDbWorkerError::from_message("duckdb_worker_poisoned", err),
                            )
                        }
                        Err(err) => {
                            DuckDbWorkerResponse::err(id, DuckDbWorkerError::from_message("duckdb_execute_failed", err))
                        }
                    };
                    write_response(stdout, &response).await;
                });

                WorkerHandleResult { response: None, shutdown: false }
            }
            DuckDbWorkerMethod::Cancel => {
                if let Some(handle) = self.active_interrupt.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                    handle.interrupt();
                }
                WorkerHandleResult {
                    response: Some(DuckDbWorkerResponse::ok(request.id, serde_json::json!({ "cancelled": true }))),
                    shutdown: false,
                }
            }
            DuckDbWorkerMethod::Shutdown => WorkerHandleResult {
                response: Some(DuckDbWorkerResponse::ok(request.id, serde_json::json!({ "shutdown": true }))),
                shutdown: true,
            },
        }
    }

    fn handle_session_request(
        &self,
        request: DuckDbWorkerRequest,
        handler: impl FnOnce(
            &mut DuckDbWorkerSession,
            DuckDbWorkerRequest,
        ) -> Result<DuckDbWorkerResponse, DuckDbWorkerError>,
    ) -> WorkerHandleResult {
        let id = request.id.clone();
        if self.active_interrupt.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
            return WorkerHandleResult {
                response: Some(DuckDbWorkerResponse::err(
                    id,
                    DuckDbWorkerError::new("duckdb_worker_busy", "DuckDB worker is executing a query"),
                )),
                shutdown: false,
            };
        }
        let response = {
            match self.session.try_lock() {
                Ok(mut session) => match handler(&mut session, request) {
                    Ok(response) => response,
                    Err(err) => DuckDbWorkerResponse::err(id, err),
                },
                Err(_) => DuckDbWorkerResponse::err(
                    id,
                    DuckDbWorkerError::new("duckdb_worker_busy", "DuckDB worker session is busy"),
                ),
            }
        };
        WorkerHandleResult { response: Some(response), shutdown: false }
    }
}

pub async fn run_stdio_worker() -> Result<(), String> {
    let runtime = DuckDbWorkerRuntime::default();
    let stdout = Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();

    loop {
        let line = lines.next_line().await.map_err(|e| e.to_string())?;
        let Some(line) = line else {
            std::process::exit(0);
        };
        if line.trim().is_empty() {
            continue;
        }
        let request: DuckDbWorkerRequest = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(err) => {
                let response = DuckDbWorkerResponse::err(
                    "",
                    DuckDbWorkerError::new("invalid_json", format!("Invalid worker request JSON: {err}")),
                );
                write_response(stdout.clone(), &response).await;
                continue;
            }
        };
        let result = runtime.handle_request(request, stdout.clone()).await;
        if let Some(response) = result.response {
            write_response(stdout.clone(), &response).await;
        }
        if result.shutdown {
            break;
        }
    }
    Ok(())
}

async fn write_response(stdout: Arc<tokio::sync::Mutex<Stdout>>, response: &DuckDbWorkerResponse) {
    let Ok(line) = serde_json::to_string(response) else {
        return;
    };
    let mut stdout = stdout.lock().await;
    let _ = stdout.write_all(line.as_bytes()).await;
    let _ = stdout.write_all(b"\n").await;
    let _ = stdout.flush().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_session_connects_to_memory_duckdb() {
        let mut session = DuckDbWorkerSession::default();

        session
            .connect(DuckDbWorkerConnectParams {
                path: ":memory:".to_string(),
                attached_databases: Vec::new(),
                init_script: None,
            })
            .expect("connect");

        assert_eq!(session.list_databases().expect("list databases")[0].name, "main");
    }

    #[test]
    fn worker_session_executes_select_query() {
        let mut session = DuckDbWorkerSession::default();
        session
            .connect(DuckDbWorkerConnectParams {
                path: ":memory:".to_string(),
                attached_databases: Vec::new(),
                init_script: None,
            })
            .expect("connect");

        let result = session
            .execute(DuckDbWorkerExecuteParams { sql: "SELECT 1 AS value".to_string(), database: None, max_rows: None })
            .expect("execute");

        assert_eq!(result.columns, vec!["value"]);
        assert_eq!(result.rows, vec![vec![serde_json::json!(1)]]);
    }

    #[test]
    fn worker_session_lists_tables_and_columns() {
        let mut session = DuckDbWorkerSession::default();
        session
            .connect(DuckDbWorkerConnectParams {
                path: ":memory:".to_string(),
                attached_databases: Vec::new(),
                init_script: None,
            })
            .expect("connect");
        session
            .execute(DuckDbWorkerExecuteParams {
                sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR)".to_string(),
                database: None,
                max_rows: None,
            })
            .expect("create table");

        let schemas =
            session.list_schemas(DuckDbWorkerDatabaseParams { database: "main".to_string() }).expect("list schemas");
        let tables = session
            .list_tables(DuckDbWorkerTableParams { database: "main".to_string(), schema: "main".to_string() })
            .expect("list tables");
        let columns = session
            .list_columns(DuckDbWorkerColumnParams {
                database: "main".to_string(),
                schema: "main".to_string(),
                table: "users".to_string(),
            })
            .expect("list columns");

        assert!(schemas.iter().any(|schema| schema == "main"));
        assert!(tables.iter().any(|table| table.name == "users"));
        assert!(columns.iter().any(|column| column.name == "id" && column.is_primary_key));
    }

    #[test]
    fn worker_session_attaches_database() {
        let dir = std::env::temp_dir().join(format!("dbx-duckdb-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let attached_path = dir.join("analytics.duckdb");
        {
            let con = duckdb::Connection::open(&attached_path).expect("create attached db");
            con.execute_batch("CREATE TABLE events (id INTEGER);").expect("create attached table");
        }
        let mut session = DuckDbWorkerSession::default();
        session
            .connect(DuckDbWorkerConnectParams {
                path: ":memory:".to_string(),
                attached_databases: Vec::new(),
                init_script: None,
            })
            .expect("connect");

        session
            .attach_database(AttachedDatabaseConfig {
                name: "analytics".to_string(),
                path: attached_path.to_string_lossy().to_string(),
            })
            .expect("attach");

        let databases = session.list_databases().expect("list databases");
        let tables = session
            .list_tables(DuckDbWorkerTableParams { database: "analytics".to_string(), schema: "main".to_string() })
            .expect("list tables");
        assert!(databases.iter().any(|database| database.name == "analytics"));
        assert!(tables.iter().any(|table| table.name == "events"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn worker_session_runs_init_script_and_tracks_attached_alias() {
        let dir = std::env::temp_dir().join(format!("dbx-duckdb-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let attached_path = dir.join("warehouse.duckdb");
        {
            let con = duckdb::Connection::open(&attached_path).expect("create attached db");
            con.execute_batch("CREATE TABLE facts (id INTEGER);").expect("create attached table");
        }
        let mut session = DuckDbWorkerSession::default();
        let script = format!(
            "SET memory_limit='512MB'; -- session tuning\nATTACH '{}' AS warehouse;\nCREATE TABLE staging (id INTEGER);",
            attached_path.to_string_lossy().replace('\'', "''")
        );
        session
            .connect(DuckDbWorkerConnectParams {
                path: ":memory:".to_string(),
                attached_databases: Vec::new(),
                init_script: Some(script),
            })
            .expect("connect");

        assert!(session.attached_names.iter().any(|name| name == "warehouse"));
        let databases = session.list_databases().expect("list databases");
        assert!(databases.iter().any(|database| database.name == "warehouse"));
        let tables = session
            .list_tables(DuckDbWorkerTableParams { database: "warehouse".to_string(), schema: "main".to_string() })
            .expect("list tables");
        assert!(tables.iter().any(|table| table.name == "facts"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn worker_session_tracks_init_script_attach_without_alias() {
        let dir = std::env::temp_dir().join(format!("dbx-duckdb-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let attached_path = dir.join("noalias.duckdb");
        {
            let con = duckdb::Connection::open(&attached_path).expect("create attached db");
            con.execute_batch("CREATE TABLE items (id INTEGER);").expect("create attached table");
        }
        let mut session = DuckDbWorkerSession::default();
        session
            .connect(DuckDbWorkerConnectParams {
                path: ":memory:".to_string(),
                attached_databases: Vec::new(),
                init_script: Some(format!("ATTACH '{}';", attached_path.to_string_lossy().replace('\'', "''"))),
            })
            .expect("connect");

        assert!(session.attached_names.iter().any(|name| name == "noalias"), "names: {:?}", session.attached_names);
        let tables = session
            .list_tables(DuckDbWorkerTableParams { database: "noalias".to_string(), schema: "main".to_string() })
            .expect("list tables");
        assert!(tables.iter().any(|table| table.name == "items"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn worker_session_reports_failing_init_script_statement() {
        let mut session = DuckDbWorkerSession::default();
        let err = session
            .connect(DuckDbWorkerConnectParams {
                path: ":memory:".to_string(),
                attached_databases: Vec::new(),
                init_script: Some("SELECT 1; SELECT * FROM missing_table;".to_string()),
            })
            .expect_err("init script should fail");
        assert!(err.contains("statement 2"), "unexpected error: {err}");
    }

    #[test]
    fn worker_session_tracks_attach_sql_alias() {
        let dir = std::env::temp_dir().join(format!("dbx-duckdb-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let attached_path = dir.join("sales.duckdb");
        {
            let con = duckdb::Connection::open(&attached_path).expect("create attached db");
            con.execute_batch("CREATE TABLE orders (id INTEGER);").expect("create attached table");
        }
        let mut session = DuckDbWorkerSession::default();
        session
            .connect(DuckDbWorkerConnectParams {
                path: ":memory:".to_string(),
                attached_databases: Vec::new(),
                init_script: None,
            })
            .expect("connect");

        session
            .execute(DuckDbWorkerExecuteParams {
                sql: format!("ATTACH '{}' AS \"sales db\";", attached_path.to_string_lossy().replace('\'', "''")),
                database: None,
                max_rows: None,
            })
            .expect("attach sql");

        assert!(session.attached_names.iter().any(|name| name == "sales db"));
        let tables = session
            .list_tables(DuckDbWorkerTableParams { database: "sales db".to_string(), schema: "main".to_string() })
            .expect("list tables");
        assert!(tables.iter().any(|table| table.name == "orders"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn metadata_returns_busy_while_query_is_active() {
        let runtime = DuckDbWorkerRuntime::default();
        let stdout = Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
        *runtime.active_interrupt.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(duckdb::Connection::open_in_memory().expect("connection").interrupt_handle());

        let result = runtime
            .handle_request(
                DuckDbWorkerRequest::new("req-busy", DuckDbWorkerMethod::ListDatabases, serde_json::json!({}))
                    .expect("request"),
                stdout,
            )
            .await;

        let response = result.response.expect("response");
        assert!(!response.ok);
        assert_eq!(response.error.expect("error").code, "duckdb_worker_busy");
    }
}
