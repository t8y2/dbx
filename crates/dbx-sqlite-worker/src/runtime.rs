use rusqlite::{Connection, DatabaseName, OpenFlags};
use serde_json::json;
use std::io::{BufRead, Write};
use std::path::Path;
use std::time::Duration;

use crate::protocol::{WorkerBody, WorkerOp, WorkerRequest, WorkerResponse};

pub fn run_stdio() -> Result<(), String> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    let mut connection = None;
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let request: WorkerRequest = serde_json::from_str(&line).map_err(|e| format!("invalid worker request: {e}"))?;
        let response = handle(&mut connection, request);
        serde_json::to_writer(&mut stdout, &response).map_err(|e| e.to_string())?;
        stdout.write_all(b"\n").map_err(|e| e.to_string())?;
        stdout.flush().map_err(|e| e.to_string())?;
        if matches!(response.body, WorkerBody::Ok { .. }) {
            // keep serving
        }
    }
    Ok(())
}

fn handle(connection: &mut Option<Connection>, request: WorkerRequest) -> WorkerResponse {
    let body = match request.op {
        WorkerOp::Open { path } => match open_database(&path) {
            Ok(opened) => {
                *connection = Some(opened);
                WorkerBody::ok()
            }
            Err(error) => WorkerBody::err(error),
        },
        WorkerOp::Query { sql, max_rows } => match connection.as_mut() {
            Some(conn) => query(conn, &sql, max_rows.unwrap_or(10_000)),
            None => WorkerBody::err("SQLite worker has no open database"),
        },
        WorkerOp::Backup { dest } => match connection.as_mut() {
            Some(conn) => backup(conn, &dest),
            None => WorkerBody::err("SQLite worker has no open database"),
        },
        WorkerOp::Restore { src } => match connection.as_mut() {
            Some(conn) => restore(conn, &src),
            None => WorkerBody::err("SQLite worker has no open database"),
        },
        WorkerOp::Ping => WorkerBody::pong(),
        WorkerOp::Close => {
            *connection = None;
            WorkerBody::ok()
        }
    };
    WorkerResponse { id: request.id, body }
}

fn open_database(path: &str) -> Result<Connection, String> {
    if path.trim().is_empty() {
        return Err("SQLite path is empty".to_string());
    }
    if path.contains('\0') {
        return Err("SQLite path contains NUL".to_string());
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_URI;
    let conn = Connection::open_with_flags(path, flags).map_err(|e| format!("failed to open SQLite file: {e}"))?;
    conn.busy_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn query(conn: &Connection, sql: &str, max_rows: usize) -> WorkerBody {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return WorkerBody::err("SQL is empty");
    }
    match conn.prepare(trimmed) {
        Ok(mut stmt) => {
            let column_count = stmt.column_count();
            if column_count == 0 {
                return match stmt.execute([]) {
                    Ok(changed) => WorkerBody::query(Vec::new(), Vec::new(), changed as u64, false),
                    Err(error) => WorkerBody::err(error.to_string()),
                };
            }
            let columns = stmt.column_names().iter().map(|name| (*name).to_string()).collect::<Vec<_>>();
            let mut rows = Vec::new();
            let mut truncated = false;
            match stmt.query([]) {
                Ok(mut mapped) => {
                    while let Ok(Some(row)) = mapped.next() {
                        if rows.len() >= max_rows {
                            truncated = true;
                            break;
                        }
                        let mut values = Vec::with_capacity(columns.len());
                        for index in 0..columns.len() {
                            match row.get_ref(index) {
                                Ok(value) => values.push(value_to_json(value)),
                                Err(error) => return WorkerBody::err(error.to_string()),
                            }
                        }
                        rows.push(values);
                    }
                }
                Err(error) => return WorkerBody::err(error.to_string()),
            }
            WorkerBody::query(columns, rows, 0, truncated)
        }
        Err(_) => match conn.execute_batch(trimmed) {
            Ok(()) => WorkerBody::query(Vec::new(), Vec::new(), conn.changes(), false),
            Err(error) => WorkerBody::err(error.to_string()),
        },
    }
}

fn backup(conn: &Connection, dest: &str) -> WorkerBody {
    if dest.trim().is_empty() || dest.contains('\0') {
        return WorkerBody::err("Backup destination is invalid");
    }
    if let Some(parent) = Path::new(dest).parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                return WorkerBody::err(error.to_string());
            }
        }
    }
    match conn.backup(DatabaseName::Main, dest, None) {
        Ok(()) => WorkerBody::ok(),
        Err(error) => WorkerBody::err(format!("SQLite backup failed: {error}")),
    }
}

fn restore(conn: &mut Connection, src: &str) -> WorkerBody {
    if src.trim().is_empty() || src.contains('\0') {
        return WorkerBody::err("Restore source is invalid");
    }
    match conn.restore(DatabaseName::Main, src, None::<fn(_)>) {
        Ok(()) => WorkerBody::ok(),
        Err(error) => WorkerBody::err(format!("SQLite restore failed: {error}")),
    }
}

fn value_to_json(value: rusqlite::types::ValueRef<'_>) -> serde_json::Value {
    match value {
        rusqlite::types::ValueRef::Null => json!(null),
        rusqlite::types::ValueRef::Integer(value) => json!(value),
        rusqlite::types::ValueRef::Real(value) => json!(value),
        rusqlite::types::ValueRef::Text(value) => json!(String::from_utf8_lossy(value)),
        rusqlite::types::ValueRef::Blob(value) => json!({ "$blob": value }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::WorkerRequest;

    #[test]
    fn open_query_and_backup() {
        let dir = std::env::temp_dir().join(format!("dbx-sqlite-worker-{}", uuid_like()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("app.db");
        let backup = dir.join("app.bak");
        let mut connection = None;
        let open =
            handle(&mut connection, WorkerRequest { id: 1, op: WorkerOp::Open { path: db.to_string_lossy().into() } });
        assert!(matches!(open.body, WorkerBody::Ok { .. }));
        let create = handle(
            &mut connection,
            WorkerRequest { id: 2, op: WorkerOp::Query { sql: "CREATE TABLE t(id INTEGER)".into(), max_rows: None } },
        );
        assert!(matches!(create.body, WorkerBody::Ok { .. }));
        let insert = handle(
            &mut connection,
            WorkerRequest { id: 3, op: WorkerOp::Query { sql: "INSERT INTO t VALUES (1)".into(), max_rows: None } },
        );
        assert!(matches!(insert.body, WorkerBody::Ok { .. }));
        let select = handle(
            &mut connection,
            WorkerRequest { id: 4, op: WorkerOp::Query { sql: "SELECT id FROM t".into(), max_rows: Some(10) } },
        );
        match select.body {
            WorkerBody::Ok { rows, .. } => assert_eq!(rows.unwrap()[0][0], json!(1)),
            WorkerBody::Err { error } => panic!("{error}"),
        }
        let backup_resp = handle(
            &mut connection,
            WorkerRequest { id: 5, op: WorkerOp::Backup { dest: backup.to_string_lossy().into() } },
        );
        assert!(matches!(backup_resp.body, WorkerBody::Ok { .. }), "{backup_resp:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    fn uuid_like() -> String {
        format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        )
    }
}
