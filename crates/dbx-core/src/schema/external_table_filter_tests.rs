use super::{list_tables_core, TableNameFilter};
use crate::connection::{AppState, PoolKind};
use crate::models::connection::ConnectionConfig;
use crate::plugins::{
    InstalledPlugin, PluginCompatibility, PluginDriverManifest, PluginDriverSession, PluginManifest, PluginRuntimeEnv,
};
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

async fn jdbc_state() -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("plugin.py");
    std::fs::write(
        &executable,
        r#"#!/usr/bin/env python3
import json, pathlib, sys
tables = [{'name': 'T%04d' % i, 'table_type': 'TABLE'} for i in range(1005)]
for line in sys.stdin:
    request = json.loads(line)
    params = request.get('params', {})
    if request['method'] == 'listTables':
        with pathlib.Path(__file__).with_name('calls.jsonl').open('a') as log:
            log.write(json.dumps(params) + '\n')
        start = params.get('offset', 0)
        end = start + params['limit'] if params.get('limit', 0) > 0 else len(tables)
        result = tables[start:end]
    else:
        result = {}
    print(json.dumps({'id': request['id'], 'result': result}), flush=True)
"#,
    )
    .unwrap();
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
            ..PluginManifest::default()
        },
        path: dir.path().to_path_buf(),
        compatibility: PluginCompatibility {
            compatible: true,
            backend_executable: Some(executable),
            ..PluginCompatibility::default()
        },
        provenance: None,
    };
    let session = Arc::new(
        PluginDriverSession::start_for_test(plugin, "jdbc".into(), PluginRuntimeEnv::default()).await.unwrap(),
    );
    let state = AppState::new(crate::persistence::test_storage::open(&dir.path().join("dbx.db")).await.unwrap());
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "jdbc-tables", "name": "JDBC metadata test", "db_type": "jdbc",
        "host": "127.0.0.1", "port": 1521, "username": "test", "password": "",
        "database": "demo", "connection_string": "jdbc:oracle:thin:@127.0.0.1:1521/demo"
    }))
    .unwrap();
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

#[tokio::test]
async fn jdbc_table_filters_find_matches_beyond_the_plugin_page_and_page_after_filtering() {
    let (dir, state) = jdbc_state().await;
    let filter = TableNameFilter { include_patterns: vec!["T100%".into()], exclude_patterns: vec!["T1002".into()] };
    let tables = list_tables_core(&state, "jdbc-tables", "demo", "APP", None, Some(2), Some(1), None, Some(&filter))
        .await
        .unwrap();
    assert_eq!(tables.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), ["T1001", "T1003"]);
    let calls = std::fs::read_to_string(dir.path().join("calls.jsonl")).unwrap();
    let params: serde_json::Value = serde_json::from_str(calls.lines().last().unwrap()).unwrap();
    assert!(params.get("limit").is_none());
    assert!(params.get("offset").is_none());
    state.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn jdbc_table_filters_apply_exclusions_before_pagination() {
    let (_dir, state) = jdbc_state().await;
    let filter = TableNameFilter { include_patterns: vec![], exclude_patterns: vec!["T000%".into()] };
    let tables = list_tables_core(&state, "jdbc-tables", "demo", "APP", None, Some(2), Some(1), None, Some(&filter))
        .await
        .unwrap();
    assert_eq!(tables.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), ["T0011", "T0012"]);
    state.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn jdbc_table_filters_keep_plugin_paging_for_empty_filters() {
    let (dir, state) = jdbc_state().await;
    let filter = TableNameFilter { include_patterns: vec!["  ".into()], exclude_patterns: vec![] };
    let tables = list_tables_core(&state, "jdbc-tables", "demo", "APP", None, Some(2), Some(1001), None, Some(&filter))
        .await
        .unwrap();
    assert_eq!(tables.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), ["T1001", "T1002"]);
    let calls = std::fs::read_to_string(dir.path().join("calls.jsonl")).unwrap();
    let params: serde_json::Value = serde_json::from_str(calls.lines().last().unwrap()).unwrap();
    assert_eq!(params["limit"], 2);
    assert_eq!(params["offset"], 1001);
    state.shutdown(Duration::from_secs(1)).await;
}
