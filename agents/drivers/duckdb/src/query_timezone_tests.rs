use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

struct ExtensionRepository {
    directory: PathBuf,
    address: String,
    requests: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl ExtensionRepository {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("dbx-duckdb-timezone-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let listener = (20000..21000)
            .find_map(|port| TcpListener::bind(("127.0.0.1", port)).ok())
            .expect("available loopback test port");
        listener.set_nonblocking(true).unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let worker_requests = requests.clone();
        let worker_stop = stop.clone();
        let worker = thread::spawn(move || {
            while !worker_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
                        let mut request = [0; 8192];
                        let _ = stream.read(&mut request);
                        worker_requests.fetch_add(1, Ordering::SeqCst);
                        let _ = stream
                            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("accept extension request: {error}"),
                }
            }
        });
        Self { directory, address, requests, stop, worker: Some(worker) }
    }

    fn configure(&self, con: &duckdb::Connection) {
        let directory = self.directory.to_string_lossy().replace('\'', "''");
        con.execute_batch(&format!(
            "SET extension_directory = '{directory}'; SET autoinstall_extension_repository = '{}'; SET http_proxy = ''",
            self.address
        ))
        .unwrap();
    }

    fn request_count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
}

impl Drop for ExtensionRepository {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}

#[test]
fn session_timezone_does_not_request_unregistered_icu() {
    let repository = ExtensionRepository::new();
    let con = duckdb::Connection::open_in_memory().unwrap();
    repository.configure(&con);

    for _ in 0..3 {
        assert!(duckdb_session_timezone(&con).unwrap().is_none());
    }
    assert_eq!(repository.request_count(), 0);

    assert!(con.query_row::<String, _, _>("SELECT current_setting('TimeZone')", [], |row| row.get(0)).is_err());
    assert!(repository.request_count() > 0);
}

#[test]
fn ordinary_queries_preserve_extension_settings_and_connection_reuse() {
    for file_database in [false, true] {
        for autoinstall in [true, false] {
            let repository = ExtensionRepository::new();
            let con = if file_database {
                duckdb::Connection::open(repository.directory.join("fixture.duckdb")).unwrap()
            } else {
                duckdb::Connection::open_in_memory().unwrap()
            };
            repository.configure(&con);
            con.execute_batch(&format!("SET autoinstall_known_extensions = {autoinstall}")).unwrap();
            duckdb_execute(&con, "CREATE TABLE sample AS SELECT 7 AS id").unwrap();
            for _ in 0..3 {
                assert_eq!(duckdb_execute(&con, "SELECT 1").unwrap().rows, vec![vec![serde_json::json!(1)]]);
                assert_eq!(
                    duckdb_execute(&con, "SELECT * FROM sample").unwrap().rows,
                    vec![vec![serde_json::json!(7)]]
                );
                assert!(duckdb_execute(&con, "SELECT * FROM missing_timezone_test_table")
                    .unwrap_err()
                    .contains("missing_timezone_test_table"));
                assert!(duckdb_execute(&con, "SELECT CAST('invalid' AS INTEGER)").unwrap_err().contains("invalid"));
            }
            assert!(duckdb_execute(&con, "SELECT FROM").is_err());
            assert!(duckdb_execute(&con, "SELECT 1 WHERE false").unwrap().rows.is_empty());
            assert!(duckdb_execute(&con, "SELECT NULL::TIMESTAMPTZ WHERE false").unwrap().rows.is_empty());
            assert_eq!(
                duckdb_execute(
                    &con,
                    "SELECT NULL::TIMESTAMPTZ, TIMESTAMP '2025-07-15 12:00:00', TIMESTAMPTZ '2025-07-15 12:00:00+02'"
                )
                .unwrap()
                .rows,
                vec![vec![
                    serde_json::Value::Null,
                    serde_json::json!("2025-07-15 12:00:00"),
                    serde_json::json!("2025-07-15 10:00:00+00")
                ]]
            );
            let enabled: bool =
                con.query_row("SELECT current_setting('autoinstall_known_extensions')", [], |row| row.get(0)).unwrap();
            assert_eq!(enabled, autoinstall);
            assert_eq!(repository.request_count(), 0);
        }
    }
}

#[test]
fn session_timezone_tracks_set_and_connection_local_state() {
    let con = duckdb::Connection::open_in_memory().unwrap();
    con.execute_batch("LOAD icu").unwrap();
    let other = con.try_clone().unwrap();
    other.execute_batch("SET TimeZone = 'Asia/Shanghai'").unwrap();
    for (zone, winter, summer) in [
        ("UTC", "2025-01-15 12:00:00+00", "2025-07-15 12:00:00+00"),
        ("America/New_York", "2025-01-15 07:00:00-05", "2025-07-15 08:00:00-04"),
        ("Asia/Kathmandu", "2025-01-15 17:45:00+05:45", "2025-07-15 17:45:00+05:45"),
        ("UTC", "2025-01-15 12:00:00+00", "2025-07-15 12:00:00+00"),
    ] {
        duckdb_execute(&con, &format!("SET TimeZone = '{zone}'")).unwrap();
        let result = duckdb_execute(
            &con,
            "SELECT TIMESTAMPTZ '2025-01-15 12:00:00+00', TIMESTAMPTZ '2025-07-15 12:00:00+00', NULL::TIMESTAMPTZ",
        )
        .unwrap();
        assert_eq!(
            result.rows,
            vec![vec![serde_json::json!(winter), serde_json::json!(summer), serde_json::Value::Null]]
        );
        assert_eq!(
            duckdb_execute(&other, "SELECT TIMESTAMPTZ '2025-01-15 12:00:00+00'").unwrap().rows,
            vec![vec![serde_json::json!("2025-01-15 20:00:00+08")]]
        );
    }
    assert!(duckdb_execute(&con, "SET TimeZone = 'invalid/timezone'").is_err());
    assert_eq!(
        duckdb_execute(&con, "SELECT TIMESTAMPTZ '2025-01-15 12:00:00+00'").unwrap().rows,
        vec![vec![serde_json::json!("2025-01-15 12:00:00+00")]]
    );
}

#[test]
fn session_timezone_observes_icu_loaded_during_prepare() {
    let con = duckdb::Connection::open_in_memory().unwrap();
    assert!(duckdb_session_timezone(&con).unwrap().is_none());
    let result = duckdb_execute(
        &con,
        "SELECT current_setting('TimeZone'), TIMESTAMPTZ '2025-01-15 12:00:00+00' AS instant, \
         TIMESTAMPTZ '2025-01-15 12:00:00+00'::VARCHAR AS engine_rendering",
    )
    .unwrap();
    assert!(duckdb_session_timezone(&con).unwrap().is_some());
    assert_eq!(result.rows[0][1], result.rows[0][2]);
}

#[test]
fn timezone_lookup_preserves_query_side_effects_and_streaming() {
    let con = duckdb::Connection::open_in_memory().unwrap();
    con.execute_batch("CREATE SEQUENCE once_per_row").unwrap();
    let result =
        duckdb_execute_with_max_rows(&con, "SELECT nextval('once_per_row'), i FROM range(5000) t(i)", Some(5000))
            .unwrap();
    assert_eq!(result.rows.len(), 5000);
    assert_eq!(result.rows[0], vec![serde_json::json!(1), serde_json::json!(0)]);
    assert_eq!(result.rows[4999], vec![serde_json::json!(5000), serde_json::json!(4999)]);
    assert_eq!(
        duckdb_execute(&con, "SELECT currval('once_per_row')").unwrap().rows,
        vec![vec![serde_json::json!(5000)]]
    );
}

#[test]
fn timezone_lookup_propagates_transaction_errors() {
    let con = duckdb::Connection::open_in_memory().unwrap();
    con.execute_batch("BEGIN TRANSACTION").unwrap();
    assert!(con.execute_batch("SELECT CAST('invalid' AS INTEGER)").is_err());
    assert!(duckdb_session_timezone(&con).is_err());
    con.execute_batch("ROLLBACK").unwrap();
    assert_eq!(duckdb_execute(&con, "SELECT 1").unwrap().rows, vec![vec![serde_json::json!(1)]]);
}

#[test]
fn timezone_parser_preserves_offset_and_invalid_input_behavior() {
    let instant = DateTime::parse_from_rfc3339("2025-01-15T12:00:00Z").unwrap().with_timezone(&Utc);
    for (name, offset) in [("+08", 28800), ("-05:30", -19800), ("+0545", 20700), (" UTC ", 0)] {
        assert_eq!(DuckDbSessionTimezone::parse(name).unwrap().to_local(instant).1, offset);
    }
    for name in ["", "invalid/timezone", "+24", "-05:60", "+12345"] {
        assert!(DuckDbSessionTimezone::parse(name).is_none());
    }
}
