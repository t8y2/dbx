use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

struct AgentProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
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
        Self { child, stdin, stdout }
    }

    fn send(&mut self, request: Value) -> Value {
        writeln!(self.stdin, "{request}").expect("write request");
        self.stdin.flush().expect("flush request");
        self.read_response()
    }

    fn send_raw(&mut self, request: &str) -> Value {
        writeln!(self.stdin, "{request}").expect("write raw request");
        self.stdin.flush().expect("flush raw request");
        self.read_response()
    }

    fn read_response(&mut self) -> Value {
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("read response");
        assert!(!line.is_empty(), "agent exited before responding");
        serde_json::from_str(&line).expect("valid JSON response")
    }

    fn shutdown(mut self) {
        let response = self.send(json!({"jsonrpc": "2.0", "id": 99, "method": "shutdown", "params": {}}));
        assert_eq!(response["result"], json!({"ok": true}));
        drop(self.stdin);
        assert!(self.child.wait().expect("wait for agent").success());
    }
}

#[test]
fn stdio_protocol_reports_ready_handshake_and_structured_errors() {
    let mut agent = AgentProcess::spawn();

    let handshake = agent.send(json!({"jsonrpc": "2.0", "id": 7, "method": "handshake", "params": {}}));
    assert_eq!(handshake["jsonrpc"], "2.0");
    assert_eq!(handshake["id"], 7);
    assert_eq!(handshake["result"]["protocolVersion"], 2);
    assert!(handshake["result"]["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|capability| capability == "structured_error_v1"));

    let unknown = agent.send(json!({"jsonrpc": "2.0", "id": 8, "method": "not_a_method", "params": {}}));
    assert!(unknown["error"]["message"].as_str().unwrap().contains("unknown method"));
    assert_eq!(unknown["error"]["data"]["category"], "protocol");
    assert_eq!(unknown["error"]["data"]["stage"], "execute");

    let malformed = agent.send_raw("{");
    assert!(malformed["id"].is_null());
    assert_eq!(malformed["error"]["data"]["category"], "protocol");
    assert_eq!(malformed["error"]["data"]["stage"], "request");
    assert_eq!(malformed["error"]["data"]["operationOutcome"], "not_started");

    let invalid_connect = agent.send(json!({
        "jsonrpc": "2.0",
        "id": 9,
        "method": "test_connection",
        "params": {"connection_string": "postgres://localhost/example"}
    }));
    assert_eq!(invalid_connect["error"]["data"]["category"], "connection");
    assert_eq!(invalid_connect["error"]["data"]["stage"], "connect");
    assert_eq!(invalid_connect["error"]["data"]["operationOutcome"], "not_started");

    agent.shutdown();
}
