use std::env;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

struct AgentProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl AgentProcess {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_dbx-tdengine-driver"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start TDengine agent");
        let stdin = child.stdin.take().expect("agent stdin");
        let mut stdout = BufReader::new(child.stdout.take().expect("agent stdout"));
        let mut ready = String::new();
        stdout.read_line(&mut ready).expect("read ready line");
        assert_eq!(serde_json::from_str::<Value>(&ready).unwrap(), json!({"ready": true}));
        Self { child, stdin, stdout, next_id: 1 }
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(self.stdin, "{request}").expect("write request");
        self.stdin.flush().expect("flush request");
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("read response");
        let response: Value = serde_json::from_str(&line).expect("valid JSON response");
        assert_eq!(response["id"], id, "unexpected response: {response}");
        if let Some(error) = response.get("error") {
            panic!("{method} failed: {error}");
        }
        response["result"].clone()
    }

    fn shutdown(mut self) {
        assert_eq!(self.call("shutdown", json!({})), json!({"ok": true}));
        drop(self.stdin);
        assert!(self.child.wait().expect("wait for agent").success());
    }
}

fn integration_params() -> Option<Value> {
    if env::var("TDENGINE_INTEGRATION").ok().as_deref() != Some("1") {
        return None;
    }
    Some(json!({
        "host": env::var("TDENGINE_TEST_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
        "port": env::var("TDENGINE_TEST_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(6041),
        "username": env::var("TDENGINE_TEST_USERNAME").unwrap_or_else(|_| "root".into()),
        "password": env::var("TDENGINE_TEST_PASSWORD").unwrap_or_else(|_| "taosdata".into()),
        "url_params": "timezone=Asia/Shanghai",
        "connect_timeout_secs": 20,
    }))
}

#[test]
fn tdengine_websocket_live_compatibility() {
    let Some(connect_params) = integration_params() else {
        return;
    };
    let database = format!("dbx_rust_live_{}", std::process::id());
    let session_id = "tdengine-live";
    let mut agent = AgentProcess::spawn();

    let tested = agent.call("test_connection", connect_params.clone());
    assert_eq!(tested["ok"], true);
    assert_eq!(tested["databaseInfo"]["productName"], "TDengine");
    assert!(tested["databaseInfo"]["productVersion"].as_str().is_some_and(|version| !version.is_empty()));

    let mut open_params = connect_params.clone();
    open_params["agentSessionId"] = json!(session_id);
    assert_eq!(agent.call("open_session", open_params), json!({"ok": true}));

    agent.call(
        "execute_batch",
        json!({
            "agentSessionId": session_id,
            "statements": [
                format!("CREATE DATABASE IF NOT EXISTS {database}"),
                format!("CREATE STABLE IF NOT EXISTS {database}.meters (ts TIMESTAMP, current FLOAT, voltage INT, active BOOL, note NCHAR(32)) TAGS (location NCHAR(64), group_id INT)"),
                format!("CREATE TABLE IF NOT EXISTS {database}.d1001 USING {database}.meters TAGS ('California.SanFrancisco', 2)"),
                format!("INSERT INTO {database}.d1001 VALUES ('2026-08-04 10:00:00.001', 10.1, 220, true, 'first') ('2026-08-04 10:00:00.002', 10.2, 221, false, 'second') ('2026-08-04 10:00:00.003', 10.3, 222, true, 'third')")
            ]
        }),
    );

    let host = connect_params["host"].as_str().unwrap();
    let host = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    let port = connect_params["port"].as_u64().unwrap();
    let mut database_connect_params = connect_params.clone();
    database_connect_params["connection_string"] = json!(format!("ws://{host}:{port}/{database}"));
    database_connect_params["database"] = json!("");
    let database_connection = agent.call("test_connection", database_connect_params);
    assert_eq!(database_connection["databaseInfo"]["currentDatabase"], database);

    let databases = agent.call("list_databases", json!({"agentSessionId": session_id}));
    assert!(databases.as_array().unwrap().iter().any(|item| item["name"] == database));

    let tables = agent.call(
        "list_tables",
        json!({
            "agentSessionId": session_id,
            "schema": database,
            "filter": "",
            "limit": 100,
            "offset": 0,
            "object_types": []
        }),
    );
    let tables = tables.as_array().unwrap();
    assert!(tables.iter().any(|table| table["name"] == "meters" && table["table_type"] == "STABLE"));
    assert!(tables.iter().any(|table| table["name"] == "d1001" && table["parent_name"] == "meters"));

    let columns =
        agent.call("get_columns", json!({"agentSessionId": session_id, "schema": database, "table": "meters"}));
    let columns = columns.as_array().unwrap();
    assert!(columns.iter().any(|column| column["name"] == "ts" && column["is_primary_key"] == true));
    assert!(columns.iter().any(|column| column["name"] == "location" && column["comment"] == "TAG"));

    let query = agent.call(
        "execute_query",
        json!({
            "agentSessionId": session_id,
            "schema": database,
            "sql": "SELECT * FROM d1001 ORDER BY ts",
            "maxRows": 2,
            "fetchSize": 100,
            "timeoutSecs": 10
        }),
    );
    assert_eq!(query["rows"].as_array().unwrap().len(), 2);
    assert_eq!(query["truncated"], true);
    assert_eq!(query["rows"][0][0], "2026-08-04 10:00:00.001");
    let connection_info = agent.call("connection_info", json!({"agentSessionId": session_id}));
    assert_eq!(connection_info["databaseInfo"]["currentDatabase"], database);

    let first_page = agent.call(
        "execute_query_page",
        json!({
            "agentSessionId": session_id,
            "schema": database,
            "sql": "SELECT * FROM d1001 ORDER BY ts",
            "maxRows": 2,
            "pageSize": 1,
            "timeoutSecs": 10
        }),
    );
    assert_eq!(first_page["has_more"], true);
    assert_eq!(first_page["truncated"], false);
    let query_session_id = first_page["session_id"].as_str().expect("paged query session");
    let final_page = agent.call(
        "fetch_query_page",
        json!({
            "agentSessionId": session_id,
            "sessionId": query_session_id,
            "pageSize": 1,
            "timeoutSecs": 10
        }),
    );
    assert_eq!(final_page["rows"].as_array().unwrap().len(), 1);
    assert_eq!(final_page["has_more"], false);
    assert_eq!(final_page["truncated"], true);

    let exact_limit = agent.call(
        "execute_query",
        json!({
            "agentSessionId": session_id,
            "schema": database,
            "sql": "SELECT * FROM d1001 WHERE voltage <= 221 ORDER BY ts",
            "maxRows": 2,
            "timeoutSecs": 10
        }),
    );
    assert_eq!(exact_limit["rows"].as_array().unwrap().len(), 2);
    assert_eq!(exact_limit["truncated"], false);

    let completion = agent.call(
        "completion_assistant_search_v1",
        json!({
            "agentSessionId": session_id,
            "schema": database,
            "object_kinds": ["table"],
            "mask": "met",
            "match_mode": "prefix",
            "max_results": 10
        }),
    );
    assert!(completion["candidates"].as_array().unwrap().iter().any(|candidate| candidate["name"] == "meters"));

    let ddl = agent.call("get_table_ddl", json!({"agentSessionId": session_id, "schema": database, "table": "meters"}));
    assert!(ddl.as_str().unwrap().to_ascii_uppercase().contains("CREATE"));

    let source = agent.call(
        "get_object_source",
        json!({
            "agentSessionId": session_id,
            "schema": database,
            "name": "meters",
            "object_type": "STABLE"
        }),
    );
    assert!(source["source"].as_str().unwrap().to_ascii_uppercase().contains("CREATE"));

    agent.call(
        "execute_batch",
        json!({"agentSessionId": session_id, "statements": [format!("DROP DATABASE IF EXISTS {database}")]}),
    );
    agent.shutdown();
}
