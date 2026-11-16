//! Optional live tests against a local CnosDB OSS instance.
//!
//! Enable with:
//! `CNOSDB_LIVE_URL=http://127.0.0.1:8902 CNOSDB_LIVE=1 cargo test --test live -- --nocapture`

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

fn live_enabled() -> bool {
    matches!(std::env::var("CNOSDB_LIVE").as_deref(), Ok("1") | Ok("true") | Ok("TRUE"))
}

fn live_url() -> String {
    std::env::var("CNOSDB_LIVE_URL").unwrap_or_else(|_| "http://127.0.0.1:8902".into())
}

struct AgentProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl AgentProcess {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_dbx-cnosdb-driver"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start CnosDB agent");
        let stdin = child.stdin.take().expect("agent stdin");
        let mut stdout = BufReader::new(child.stdout.take().expect("agent stdout"));
        let mut ready = String::new();
        stdout.read_line(&mut ready).expect("read ready line");
        assert_eq!(serde_json::from_str::<Value>(&ready).unwrap(), json!({"ready": true}));
        Self { child, stdin, stdout }
    }

    fn send(&mut self, request: Value) -> Value {
        writeln!(self.stdin, "{request}").expect("write request");
        self.stdin.flush().expect("flush request");
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("read response");
        serde_json::from_str(&line).expect("valid JSON response")
    }

    fn shutdown(mut self) {
        let _ = self.send(json!({"jsonrpc": "2.0", "id": 99, "method": "shutdown", "params": {}}));
        drop(self.stdin);
        let _ = self.child.wait();
    }
}

#[test]
fn live_connect_lists_databases_tables_and_columns() {
    if !live_enabled() {
        eprintln!("skipping live CnosDB test (set CNOSDB_LIVE=1)");
        return;
    }

    let mut agent = AgentProcess::spawn();
    let connect = agent.send(json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "test_connection",
        "params": {
            "connection_string": live_url(),
            "database": "public",
            "tenant": "cnosdb",
            "username": "root",
            "password": ""
        }
    }));
    assert!(connect.get("result").is_some(), "connect failed: {connect}");

    let open = agent.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "open_session",
        "params": {
            "agentSessionId": "live-1",
            "connection_string": live_url(),
            "database": "public",
            "tenant": "cnosdb",
            "username": "root",
            "password": ""
        }
    }));
    assert_eq!(open["result"], json!({"ok": true}), "{open}");

    let databases = agent.send(json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "list_databases",
        "params": {"agentSessionId": "live-1"}
    }));
    assert!(databases["result"].as_array().is_some(), "{databases}");

    let create_db = agent.send(json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "execute_batch",
        "params": {
            "agentSessionId": "live-1",
            "database": "public",
            "statements": ["CREATE DATABASE IF NOT EXISTS dbx_cnosdb_live;"]
        }
    }));
    assert!(create_db.get("result").is_some(), "{create_db}");

    let create_table = agent.send(json!({
        "jsonrpc": "2.0",
        "id": 5,
        "method": "execute_batch",
        "params": {
            "agentSessionId": "live-1",
            "database": "dbx_cnosdb_live",
            "statements": [
                "CREATE TABLE IF NOT EXISTS air (visibility DOUBLE, temperature DOUBLE, pressure DOUBLE, TAGS(station));",
                "INSERT INTO air (TIME, station, visibility, temperature, pressure) VALUES (now(), 'XiaoMaiDao', 56, 69, 77);"
            ]
        }
    }));
    assert!(create_table.get("result").is_some(), "{create_table}");

    let tables = agent.send(json!({
        "jsonrpc": "2.0",
        "id": 6,
        "method": "list_tables",
        "params": {"agentSessionId": "live-1", "database": "dbx_cnosdb_live"}
    }));
    let table_names = tables["result"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert!(table_names.iter().any(|name| *name == "air"), "{tables}");

    let columns = agent.send(json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "get_columns",
        "params": {"agentSessionId": "live-1", "database": "dbx_cnosdb_live", "table": "air"}
    }));
    assert!(columns["result"].as_array().unwrap().len() >= 3, "{columns}");

    let query = agent.send(json!({
        "jsonrpc": "2.0",
        "id": 8,
        "method": "execute_query",
        "params": {
            "agentSessionId": "live-1",
            "database": "dbx_cnosdb_live",
            "sql": "SELECT station, temperature FROM air LIMIT 10"
        }
    }));
    assert!(!query["result"]["rows"].as_array().unwrap().is_empty(), "{query}");

    agent.shutdown();
}
