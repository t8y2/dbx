#![cfg(feature = "duckdb-bundled")]

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

/// Connects to a DuckDb database file with file validation.
///
/// # Arguments
/// * `path` - The file path to the DuckDb database
///
/// # Returns
/// * `Ok(Arc<Mutex<duckdb::Connection>>)` on successful connection
/// * `Err(String)` with descriptive error message if connection fails
pub fn connect_path(path: &str) -> Result<Arc<Mutex<duckdb::Connection>>, String> {
    let is_memory = is_memory_database_path(path);
    if !is_memory {
        validate_duckdb_path(path)?;
    }

    let connection = if is_memory { duckdb::Connection::open_in_memory() } else { duckdb::Connection::open(path) }
        .map_err(|e| format!("DuckDb connection failed: {e}"))?;

    Ok(Arc::new(Mutex::new(connection)))
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
        if let Some(parent) = path_obj.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                return Err(format!("Parent directory does not exist: {}", parent.display()));
            }
        }
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
pub fn close_connection(con: Arc<Mutex<duckdb::Connection>>) {
    match Arc::try_unwrap(con) {
        Ok(mutex) => match mutex.into_inner() {
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
}
