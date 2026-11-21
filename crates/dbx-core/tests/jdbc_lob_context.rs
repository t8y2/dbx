#![cfg(unix)]

use dbx_core::connection::{AppState, PoolKind};
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::plugins::{InstalledPlugin, PluginCompatibility, PluginDriverSession, PluginManifest, PluginRuntimeEnv};
use dbx_core::query::{request_large_value, LargeValueRequest};
use serde_json::json;
use std::{os::unix::fs::PermissionsExt, sync::Arc, time::Duration};

#[tokio::test]
async fn jdbc_lob_reads_and_releases_use_the_existing_workload_session_only() {
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("plugin.py");
    std::fs::write(
        &executable,
        r#"#!/usr/bin/env python3
import json, pathlib, sys
for line in sys.stdin:
    request = json.loads(line)
    with pathlib.Path(__file__).with_name('calls.jsonl').open('a') as log:
        log.write(json.dumps(request) + '\n')
    result = {'status':'ok', 'data':'original', 'next_offset':8, 'eof':True, 'value_kind':'text'}
    print(json.dumps({'id':request['id'], 'result':result}), flush=True)
"#,
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let session = Arc::new(
        PluginDriverSession::start_for_test(
            InstalledPlugin {
                manifest: PluginManifest {
                    id: "jdbc".into(),
                    name: "JDBC".into(),
                    version: "test".into(),
                    protocol_version: 1,
                    executable: Some("plugin.py".into()),
                    ..Default::default()
                },
                path: directory.path().into(),
                compatibility: PluginCompatibility {
                    compatible: true,
                    backend_executable: Some(executable),
                    ..Default::default()
                },
                provenance: None,
            },
            "jdbc".into(),
            PluginRuntimeEnv::default(),
        )
        .await
        .unwrap(),
    );
    let state =
        AppState::new(dbx_core::persistence::test_storage::open(&directory.path().join("state.db")).await.unwrap());
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id":"jdbc-lob", "name":"fixture", "db_type":"jdbc", "host":"127.0.0.1", "port":1,
        "username":"fixture", "password":"", "connection_string":"jdbc:fixture"
    }))
    .unwrap();
    state.configs.write().await.insert(config.id.clone(), config.clone());
    state
        .update_connection_pools(|pools| {
            pools.insert(
                config.id.clone(),
                PoolKind::ExternalDriver {
                    driver_id: "jdbc".into(),
                    config: Arc::new(config),
                    session: session.clone(),
                },
            );
        })
        .await;
    for release in [false, true] {
        let mut request: LargeValueRequest = serde_json::from_value(json!({
            "connectionId":"jdbc-lob", "database":"", "valueRef":"original-ref", "offset":0, "limit":4096
        }))
        .unwrap();
        request.client_session_id = Some("replacement-tab".into());
        assert_eq!(
            request_large_value(&state, request.clone(), release).await.unwrap_err(),
            "LOB context has expired; rerun the query"
        );
        request.client_session_id = None;
        assert_eq!(request_large_value(&state, request, release).await.unwrap()["data"], "original");
    }
    let calls = std::fs::read_to_string(directory.path().join("calls.jsonl")).unwrap();
    let calls: Vec<serde_json::Value> = calls.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(calls.len(), 2, "Must not reconnect, replay SQL or access the replacement scope");
    assert_eq!(calls[0]["method"], "read_large_value_chunk");
    assert_eq!(calls[1]["method"], "release_large_value");
    for call in calls {
        assert_eq!(call["params"]["valueRef"], "original-ref");
        assert_eq!(call["params"]["connection"]["id"], "jdbc-lob");
    }
    state.shutdown(Duration::from_secs(2)).await;
}
