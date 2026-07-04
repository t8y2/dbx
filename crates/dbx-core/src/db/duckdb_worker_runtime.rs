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
        if let Some(name) = duckdb_attached_name_from_attach_sql(&params.sql) {
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
                    let result = match params {
                        Ok(params) => tokio::task::spawn_blocking(move || {
                            let mut session = session.lock().unwrap_or_else(|e| e.into_inner());
                            session.execute(params)
                        })
                        .await
                        .map_err(|e| e.to_string())
                        .and_then(|result| result),
                        Err(err) => Err(err.message),
                    };
                    *active_interrupt.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    let response = match result {
                        Ok(result) => DuckDbWorkerResponse::ok(id, result),
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
            break;
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

fn duckdb_attached_name_from_attach_sql(sql: &str) -> Option<String> {
    let trimmed = sql.trim_start();
    let first_word = trimmed.split(|ch: char| ch.is_whitespace() || ch == ';').next().unwrap_or_default();
    if !first_word.eq_ignore_ascii_case("ATTACH") {
        return None;
    }

    let as_index = find_as_keyword_outside_quotes(trimmed)?;
    parse_identifier_after_as(&trimmed[as_index + 2..])
}

fn find_as_keyword_outside_quotes(sql: &str) -> Option<usize> {
    let bytes = sql.as_bytes();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' if !in_double => {
                if in_single && i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                    i += 2;
                    continue;
                }
                in_single = !in_single;
            }
            b'"' if !in_single => {
                if in_double && i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                    i += 2;
                    continue;
                }
                in_double = !in_double;
            }
            b'a' | b'A' if !in_single && !in_double && i + 1 < bytes.len() => {
                if (bytes[i + 1] == b's' || bytes[i + 1] == b'S')
                    && is_sql_word_boundary(bytes.get(i.wrapping_sub(1)).copied())
                    && is_sql_word_boundary(bytes.get(i + 2).copied())
                {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn is_sql_word_boundary(byte: Option<u8>) -> bool {
    !matches!(byte, Some(b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_'))
}

fn parse_identifier_after_as(input: &str) -> Option<String> {
    let input = input.trim_start();
    if input.is_empty() {
        return None;
    }
    if let Some(rest) = input.strip_prefix('"') {
        let mut name = String::new();
        let mut chars = rest.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    name.push('"');
                    chars.next();
                    continue;
                }
                return (!name.trim().is_empty()).then_some(name);
            }
            name.push(ch);
        }
        return None;
    }

    let name = input.split(|ch: char| ch.is_whitespace() || ch == ';').next().unwrap_or_default().trim();
    (!name.is_empty()).then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_session_connects_to_memory_duckdb() {
        let mut session = DuckDbWorkerSession::default();

        session
            .connect(DuckDbWorkerConnectParams { path: ":memory:".to_string(), attached_databases: Vec::new() })
            .expect("connect");

        assert_eq!(session.list_databases().expect("list databases")[0].name, "main");
    }

    #[test]
    fn worker_session_executes_select_query() {
        let mut session = DuckDbWorkerSession::default();
        session
            .connect(DuckDbWorkerConnectParams { path: ":memory:".to_string(), attached_databases: Vec::new() })
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
            .connect(DuckDbWorkerConnectParams { path: ":memory:".to_string(), attached_databases: Vec::new() })
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
            .connect(DuckDbWorkerConnectParams { path: ":memory:".to_string(), attached_databases: Vec::new() })
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
            .connect(DuckDbWorkerConnectParams { path: ":memory:".to_string(), attached_databases: Vec::new() })
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

    #[test]
    fn attach_sql_alias_parser_handles_generated_sql() {
        assert_eq!(
            duckdb_attached_name_from_attach_sql("ATTACH 'D:\\tmp\\sales.duckdb' AS \"sales db\";"),
            Some("sales db".to_string())
        );
        assert_eq!(duckdb_attached_name_from_attach_sql("select 'not attach' as value"), None);
    }
}
