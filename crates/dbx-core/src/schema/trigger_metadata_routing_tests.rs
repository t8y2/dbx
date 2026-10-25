use super::*;
use crate::plugins::{
    InstalledPlugin, PluginCompatibility, PluginDriverManifest, PluginDriverSession, PluginManifest, PluginRuntimeEnv,
};
use std::os::unix::fs::PermissionsExt;

async fn jdbc_fixture() -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("plugin.py");
    std::fs::write(&executable, r#"#!/usr/bin/env python3
import json, pathlib, sys
metadata = {'contractVersion': 1, 'identityMode': 'exact', 'engine': 'oracle', 'engineVersion': '19', 'owner': ' Owner ', 'name': ' Trigger ', 'scope': 'VIEW', 'parent': {'owner': ' Parent Owner ', 'name': ' Parent ', 'objectType': 'VIEW'}, 'objectId': '9007199254740993', 'reads': {'identity': {'state': 'available'}}}
trigger = {'name': ' Trigger ', 'event': 'UPDATE', 'timing': 'INSTEAD OF', 'enabled': True, 'valid': False, 'oracle_metadata': metadata}
for line in sys.stdin:
    request = json.loads(line)
    params = request.get('params', {})
    with pathlib.Path(__file__).with_name('calls.jsonl').open('a') as log:
        log.write(json.dumps(request) + '\n')
    if params.get('schema') == 'missing-method':
        response = {'id': request['id'], 'error': {'code': -32601, 'message': 'Unsupported JDBC plugin method: ' + request['method']}}
    else:
        if request['method'] == 'listObjects':
            result = [{'name': trigger['name'], 'object_type': 'TRIGGER', 'schema': metadata['owner'], 'trigger': trigger}]
        elif request['method'] == 'listTriggers':
            result = [trigger]
        elif request['method'] == 'getObjectSource':
            result = {'name': trigger['name'], 'schema': metadata['owner'], 'object_type': 'TRIGGER', 'source': 'TRIGGER complete declaration', 'trigger': trigger}
        else:
            result = {}
        response = {'id': request['id'], 'result': result}
    print(json.dumps(response), flush=True)
"#).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let plugin = InstalledPlugin {
        manifest: PluginManifest {
            id: "jdbc".into(),
            name: "JDBC".into(),
            version: "test".into(),
            protocol_version: 1,
            executable: Some("plugin.py".into()),
            drivers: vec![PluginDriverManifest {
                id: "jdbc".into(),
                label: "JDBC".into(),
                kind: "external".into(),
                database_type: Some("jdbc".into()),
            }],
            ..Default::default()
        },
        path: dir.path().to_path_buf(),
        compatibility: PluginCompatibility {
            compatible: true,
            backend_executable: Some(executable),
            ..Default::default()
        },
        provenance: None,
    };
    let session = Arc::new(
        PluginDriverSession::start_for_test(plugin, "jdbc".into(), PluginRuntimeEnv::default()).await.unwrap(),
    );
    let state = AppState::new(crate::persistence::test_storage::open(&dir.path().join("dbx.db")).await.unwrap());
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({"id":"jdbc-trigger", "name":"JDBC trigger routing test", "db_type":"jdbc", "host":"127.0.0.1", "port":1521, "username":"fixture", "password":"", "database":"demo", "connection_string":"jdbc:oracle:thin:@127.0.0.1:1521/demo"})).unwrap();
    state.configs.write().await.insert(config.id.clone(), config.clone());
    state
        .update_connection_pools(|pools| {
            pools.insert(
                config.id.clone(),
                PoolKind::ExternalDriver { driver_id: "jdbc".into(), config: Arc::new(config), session },
            );
        })
        .await;
    (dir, state)
}

fn calls(dir: &tempfile::TempDir) -> Vec<serde_json::Value> {
    std::fs::read_to_string(dir.path().join("calls.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
async fn core_routes_exact_reads_to_the_existing_jdbc_methods_and_does_not_page_twice() {
    let (dir, state) = jdbc_fixture().await;
    let options =
        MetadataReadOptions { identity_mode: Some(MetadataIdentityMode::Exact), catalog: Some(" Catalog ".into()) };
    let objects = super::list_objects_core_with_options(
        &state,
        "jdbc-trigger",
        "demo",
        " Owner ",
        Some("trig"),
        Some(1),
        Some(2),
        Some(&["TRIGGER".into()]),
        None,
        &options,
    )
    .await
    .unwrap();
    assert_eq!(objects.len(), 1);
    let triggers =
        super::list_triggers_core_with_options(&state, "jdbc-trigger", "demo", " Parent Owner ", " Parent ", &options)
            .await
            .unwrap();
    assert_eq!(triggers[0].oracle_metadata.as_ref().unwrap().owner, " Owner ");
    let source = super::get_object_source_core_with_options(
        &state,
        "jdbc-trigger",
        "demo",
        " Owner ",
        " Trigger ",
        db::ObjectSourceKind::Trigger,
        None,
        None,
        &options,
    )
    .await
    .unwrap();
    assert_eq!(source.trigger.unwrap().oracle_metadata.unwrap().object_id.as_deref(), Some("9007199254740993"));
    let calls = calls(&dir);
    for request in &calls {
        assert_eq!(request["params"]["identity_mode"], "exact");
        assert_eq!(request["params"]["catalog"], " Catalog ");
    }
    assert_eq!(calls[0]["method"], "listObjects");
    assert_eq!(calls[0]["params"]["limit"], 1);
    assert_eq!(calls[0]["params"]["offset"], 2);
    assert_eq!(calls[1]["method"], "listTriggers");
    assert_eq!(calls[1]["params"]["schema"], " Parent Owner ");
    assert_eq!(calls[1]["params"]["table"], " Parent ");
    assert_eq!(calls[2]["method"], "getObjectSource");
    assert_eq!(calls[2]["params"]["schema"], " Owner ");
    assert_eq!(calls[2]["params"]["name"], " Trigger ");
    state.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn old_plugin_keeps_default_empty_trigger_contract_but_exact_request_reports_missing_method() {
    let (dir, state) = jdbc_fixture().await;
    assert!(super::list_triggers_core(&state, "jdbc-trigger", "demo", "missing-method", "T").await.unwrap().is_empty());
    let options = MetadataReadOptions { identity_mode: Some(MetadataIdentityMode::Exact), catalog: None };
    let error = super::list_triggers_core_with_options(&state, "jdbc-trigger", "demo", "missing-method", "T", &options)
        .await
        .unwrap_err();
    assert!(error.contains("listTriggers"), "{error}");
    let calls = calls(&dir);
    assert_eq!(calls.len(), 2);
    assert!(calls[0]["params"].get("identity_mode").is_none());
    assert_eq!(calls[1]["params"]["identity_mode"], "exact");
    state.shutdown(Duration::from_secs(2)).await;
}
