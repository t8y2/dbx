//! The SQL Server opt-in query deadline includes sending a large request.
use dbx_driver_agent::agent_driver::{AgentCallError, AgentDriverClient, AgentLaunchSpec, AgentOperationOutcome};
use std::time::{Duration, Instant};

#[tokio::test]
async fn slow_request_write_does_not_restart_the_query_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("slow-reader.py");
    std::fs::write(&script, r#"import json, sys, time
print(json.dumps({'ready':True}),flush=True)
req=json.loads(sys.stdin.readline())
assert req['method']=='handshake'
print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':{'protocolVersion':2,'agentProtocolVersion':2,'capabilities':['multi_session']}}),flush=True)
time.sleep(1)
pending=None
for line in sys.stdin:
    req=json.loads(line)
    if req['method']=='execute_query': pending=req['id']
    elif req['method']=='cancel_session':
        assert pending is not None
        print(json.dumps({'jsonrpc':'2.0','id':pending,'error':{'code':-1,'message':'Query was cancelled'}}),flush=True)
        print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':{'ok':True}}),flush=True)
"#).unwrap();
    let python = if cfg!(windows) { "python" } else { "python3" };
    let mut client =
        AgentDriverClient::spawn(AgentLaunchSpec::new(python).with_args([script.to_string_lossy().to_string()]))
            .await
            .unwrap();
    client.try_optional_handshake("deadline-test").await.unwrap();
    client.enable_dedicated_transaction_query_cancellation();
    let began = Instant::now();
    let error = client
        .call_typed_with_timeout_and_cancel::<serde_json::Value>(
            "execute_query",
            serde_json::json!({"sql":" ".repeat(2 * 1024 * 1024)}),
            Some(Duration::from_millis(1600)),
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(error, AgentCallError::Timeout { operation_outcome: AgentOperationOutcome::Unknown, .. }));
    assert!(began.elapsed() >= Duration::from_millis(1500));
    assert!(
        began.elapsed() < Duration::from_millis(2400),
        "request write granted a second timeout: {:?}",
        began.elapsed()
    );
    assert!(client.call::<serde_json::Value>("execute_query", serde_json::json!({})).await.is_err());
}
