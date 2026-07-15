#![cfg(feature = "duckdb-bundled")]

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

pub struct DuckDbConnection {
    connection: Mutex<duckdb::Connection>,
    interrupt_handle: Arc<duckdb::InterruptHandle>,
    draining: AtomicBool,
}

impl DuckDbConnection {
    pub fn new(connection: duckdb::Connection) -> Self {
        let interrupt_handle = connection.interrupt_handle();
        Self { connection: Mutex::new(connection), interrupt_handle, draining: AtomicBool::new(false) }
    }

    pub fn lock(&self) -> std::sync::LockResult<std::sync::MutexGuard<'_, duckdb::Connection>> {
        self.connection.lock()
    }

    pub fn interrupt_handle(&self) -> Arc<duckdb::InterruptHandle> {
        self.interrupt_handle.clone()
    }

    pub fn mark_draining(&self) {
        self.draining.store(true, Ordering::SeqCst);
    }

    pub fn clear_draining(&self) {
        self.draining.store(false, Ordering::SeqCst);
    }

    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }

    fn into_inner(self) -> std::sync::LockResult<duckdb::Connection> {
        self.connection.into_inner()
    }
}

/// Connects to a DuckDb database file with file validation.
///
/// # Arguments
/// * `path` - The file path to the DuckDb database
///
/// # Returns
/// * `Ok(Arc<DuckDbConnection>)` on successful connection
/// * `Err(String)` with descriptive error message if connection fails
pub fn connect_path(path: &str) -> Result<Arc<DuckDbConnection>, String> {
    let is_memory = is_memory_database_path(path);
    if !is_memory {
        validate_duckdb_path(path)?;
        remove_empty_placeholder_file(path)?;
    }

    let connection = if is_memory { duckdb::Connection::open_in_memory() } else { duckdb::Connection::open(path) }
        .map_err(|e| format!("DuckDb connection failed: {e}"))?;

    Ok(Arc::new(DuckDbConnection::new(connection)))
}

/// Runs a connection init script statement-by-statement so a failure can
/// point at the offending statement instead of the whole batch.
pub fn run_init_script(con: &duckdb::Connection, script: &str) -> Result<(), String> {
    for (index, statement) in crate::db::duckdb_sql::split_sql_statements(script).iter().enumerate() {
        if crate::db::duckdb_sql::strip_leading_comments(statement).is_empty() {
            continue;
        }
        con.execute_batch(statement)
            .map_err(|e| format!("Connection init script statement {} failed: {e}", index + 1))?;
    }
    Ok(())
}

fn validate_duckdb_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Database file path cannot be empty".to_string());
    }
    if path.contains('\0') {
        return Err("Database file path contains null characters".to_string());
    }
    if is_network_path(path) {
        return Ok(());
    }
    let path_obj = Path::new(path);
    if path_obj.is_dir() {
        return Err(format!("Database file path is a directory, not a file: {}", path));
    }
    if !path_obj.exists() {
        // DuckDB creates a new database file on open when the parent directory
        // exists. Only reject paths whose parent directory is missing.
        if let Some(parent) = path_obj.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                return Err(format!("Parent directory does not exist: {}", parent.display()));
            }
        }
    }
    Ok(())
}

fn remove_empty_placeholder_file(path: &str) -> Result<(), String> {
    let path_obj = Path::new(path);
    if is_network_path(path) || !path_obj.exists() {
        return Ok(());
    }

    let metadata = fs::metadata(path_obj).map_err(|e| format!("Failed to read database file metadata: {e}"))?;
    if metadata.is_file() && metadata.len() == 0 {
        fs::remove_file(path_obj).map_err(|e| format!("Failed to replace empty DuckDB placeholder file: {e}"))?;
    }
    Ok(())
}

fn is_network_path(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//") || path.contains("wsl.localhost") || path.contains("wsl$")
}

pub fn is_memory_database_path(path: &str) -> bool {
    path.trim().eq_ignore_ascii_case(":memory:")
}

/// Closes a DuckDB connection, releasing the file lock.
///
/// Unlike relying on Drop, this calls `duckdb_disconnect` synchronously
/// so the file handle is released before this function returns.
/// On Windows this prevents "file already in use" errors when reconnecting.
pub fn close_connection(con: Arc<DuckDbConnection>) {
    match Arc::try_unwrap(con) {
        Ok(handle) => match handle.into_inner() {
            Ok(conn) => {
                let _ = conn.close();
            }
            Err(poisoned) => {
                let _ = poisoned.into_inner().close();
            }
        },
        Err(_) => {
            // Arc still referenced elsewhere (e.g. running queries);
            // the last holder will drop and close the connection.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_path_supports_memory_database() {
        let con = connect_path(":memory:").expect("connect in-memory DuckDB");
        let locked = con.lock().expect("lock connection");

        locked.execute_batch("CREATE TABLE memory_probe AS SELECT 42 AS id;").expect("create table");
        let value: i32 = locked.query_row("SELECT id FROM memory_probe;", [], |row| row.get(0)).expect("select row");

        assert_eq!(value, 42);
    }

    #[test]
    fn interrupt_handle_is_available_while_connection_is_locked() {
        let con = connect_path(":memory:").expect("connect in-memory DuckDB");
        let _locked = con.lock().expect("lock connection");

        let _interrupt_handle = con.interrupt_handle();
    }

    #[test]
    fn connect_path_replaces_empty_placeholder_file() {
        let path = std::env::temp_dir().join(format!("dbx-duckdb-empty-{}.duckdb", uuid::Uuid::new_v4()));
        std::fs::write(&path, "").expect("write empty placeholder");
        assert_eq!(std::fs::metadata(&path).expect("placeholder metadata").len(), 0);

        let con = connect_path(path.to_string_lossy().as_ref()).expect("connect empty placeholder DuckDB file");
        close_connection(con);

        assert!(std::fs::metadata(&path).expect("database metadata").len() > 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn run_init_script_executes_duckdb_escape_strings() {
        let con = connect_path(":memory:").expect("connect in-memory DuckDB");
        let locked = con.lock().expect("lock connection");

        run_init_script(&locked, r#"CREATE TABLE probe AS SELECT E'it\'s;ok' AS value; SELECT 2;"#)
            .expect("run init script");
        let value: String = locked.query_row("SELECT value FROM probe", [], |row| row.get(0)).expect("select value");

        assert_eq!(value, "it's;ok");
    }
}
