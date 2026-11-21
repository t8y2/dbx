use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::schema::{list_objects_core, list_tables_core, TableNameFilter};
use serde_json::{json, Value};
use std::time::Duration;

struct Fixture {
    state: AppState,
    directory: tempfile::TempDir,
    _listener: tokio::net::TcpListener,
}

impl Fixture {
    async fn new() -> Self {
        Self::for_database_type(DatabaseType::OceanbaseOracle).await
    }

    async fn for_database_type(db_type: DatabaseType) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let storage = dbx_core::persistence::test_storage::open(&directory.path().join("state.db")).await.unwrap();
        let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            directory.path().join("plugins"),
            directory.path().join("agents"),
            "test",
        );
        let key = dbx_core::database_capabilities::agent_key(&db_type, None).unwrap();
        let launch = state.agent_manager.driver_launch_config_path(key);
        std::fs::create_dir_all(launch.parent().unwrap()).unwrap();
        let script = directory.path().join("agent.py");
        std::fs::write(
            &script,
            r#"import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
rows = [
    {'name':'A', 'object_type':'TABLE', 'schema':'APP', 'comment':'quarterly report'},
    {'name':'B', 'object_type':'TABLE', 'schema':'APP', 'comment':'quarterly report'},
    {'name':'B', 'object_type':'VIEW', 'schema':'APP', 'comment':'quarterly report'},
    {'name':'C', 'object_type':'TABLE', 'schema':'APP', 'comment':'unrelated'},
]
print(json.dumps({'ready':True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    with (root/'requests.jsonl').open('a') as log:
        log.write(json.dumps(request)+'\n')
    method = request['method']; params = request.get('params', {})
    if method == 'handshake':
        result = {'protocolVersion':2, 'agentProtocolVersion':2, 'capabilities':['multi_session']}
    elif method in ['list_objects', 'list_tables']:
        result = rows
        if params.get('filter'):
            term = params['filter'].strip().lower()
            result = [r for r in result if term in r['name'].lower() or term in r['comment'].lower()]
        if 'object_types' in params:
            result = [r for r in result if r['object_type'] in params['object_types']]
        result = result[params.get('offset', 0):]
        if params.get('limit', 0) > 0:
            result = result[:params['limit']]
        if method == 'list_tables':
            result = [{'name':r['name'], 'table_type':r['object_type'], 'comment':r['comment']} for r in result]
    else:
        result = {'ok':True}
    print(json.dumps({'jsonrpc':'2.0', 'id':request['id'], 'result':result}), flush=True)
"#,
        )
        .unwrap();
        std::fs::write(
            launch,
            serde_json::to_vec(&json!({
                "command": if cfg!(windows) { "python" } else { "python3" },
                "args": [script, directory.path()]
            }))
            .unwrap(),
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id":"ob", "name":"OceanBase paging fixture", "db_type":db_type,
            "host":"127.0.0.1", "port":listener.local_addr().unwrap().port(),
            "username":"fixture", "password":"", "database":"APP", "save_password":true,
            "keepalive_interval_secs":0, "idle_timeout_secs":0
        }))
        .unwrap();
        state.configs.write().await.insert("ob".into(), config);
        Self { state, directory, _listener: listener }
    }

    fn requests(&self, method: &str) -> Vec<Value> {
        std::fs::read_to_string(self.directory.path().join("requests.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|request| request["method"] == method)
            .collect()
    }

    async fn shutdown(self) {
        self.state.shutdown(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn oceanbase_objects_request_bounded_comment_pages() {
    let fixture = Fixture::new().await;
    let types = vec!["TABLE".into(), "VIEW".into()];
    let page =
        list_objects_core(&fixture.state, "ob", "APP", "APP", Some("report"), Some(2), Some(2), Some(&types), None)
            .await
            .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].name, "B");
    assert_eq!(page[0].object_type, "VIEW");
    let requests = fixture.requests("list_objects");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["params"]["limit"], 2);
    assert_eq!(requests[0]["params"]["offset"], 2);
    assert_eq!(requests[0]["params"]["filter"], "report");
    assert_eq!(requests[0]["params"]["object_types"], json!(["TABLE", "VIEW"]));
    fixture.shutdown().await;
}

#[tokio::test]
async fn oceanbase_tables_request_bounded_comment_pages() {
    let fixture = Fixture::new().await;
    let types = vec!["TABLE".into(), "VIEW".into()];
    let page =
        list_tables_core(&fixture.state, "ob", "APP", "APP", Some("report"), Some(2), Some(2), Some(&types), None)
            .await
            .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].name, "B");
    assert_eq!(page[0].table_type, "VIEW");
    let requests = fixture.requests("list_tables");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["params"]["limit"], 2);
    assert_eq!(requests[0]["params"]["offset"], 2);
    assert_eq!(requests[0]["params"]["filter"], "report");
    assert_eq!(requests[0]["params"]["object_types"], json!(["TABLE", "VIEW"]));
    fixture.shutdown().await;
}

#[tokio::test]
async fn oceanbase_empty_and_out_of_range_pages_do_not_query_agent() {
    let fixture = Fixture::new().await;
    let too_large = i32::MAX as usize + 1;
    let mut errors = Vec::new();
    for (limit, offset) in [(Some(0), Some(0)), (Some(too_large), None), (Some(1), Some(too_large))] {
        let objects = list_objects_core(&fixture.state, "ob", "APP", "APP", None, limit, offset, None, None).await;
        let tables = list_tables_core(&fixture.state, "ob", "APP", "APP", None, limit, offset, None, None).await;
        if limit == Some(0) {
            assert!(objects.as_ref().unwrap().is_empty());
            assert!(tables.as_ref().unwrap().is_empty());
        }
        errors.push((objects.is_err(), tables.is_err()));
    }
    assert_eq!(
        (
            errors,
            fixture.requests("list_objects").len(),
            fixture.requests("list_tables").len(),
            fixture.requests("open_session").len()
        ),
        (vec![(false, false), (true, true), (true, true)], 0, 0, 0)
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn oceanbase_offset_without_limit_is_applied_once() {
    let fixture = Fixture::new().await;
    let objects =
        list_objects_core(&fixture.state, "ob", "APP", "APP", Some("report"), None, Some(1), None, None).await.unwrap();
    let tables =
        list_tables_core(&fixture.state, "ob", "APP", "APP", Some("report"), None, Some(1), None, None).await.unwrap();
    assert_eq!(
        objects.iter().map(|row| (row.name.as_str(), row.object_type.as_str())).collect::<Vec<_>>(),
        vec![("B", "TABLE"), ("B", "VIEW")]
    );
    assert_eq!(
        tables.iter().map(|row| (row.name.as_str(), row.table_type.as_str())).collect::<Vec<_>>(),
        vec![("B", "TABLE"), ("B", "VIEW")]
    );
    for method in ["list_objects", "list_tables"] {
        let requests = fixture.requests(method);
        assert_eq!(requests.len(), 1);
        assert!(requests[0]["params"]["limit"].is_null());
        assert_eq!(requests[0]["params"]["offset"], 1);
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn oceanbase_empty_pages_and_maximum_protocol_integers_remain_authoritative() {
    let fixture = Fixture::new().await;
    let max = i32::MAX as usize;
    for (limit, offset) in [(2, 3), (max, max)] {
        assert!(list_objects_core(
            &fixture.state,
            "ob",
            "APP",
            "APP",
            Some("report"),
            Some(limit),
            Some(offset),
            None,
            None
        )
        .await
        .unwrap()
        .is_empty());
        assert!(list_tables_core(
            &fixture.state,
            "ob",
            "APP",
            "APP",
            Some("report"),
            Some(limit),
            Some(offset),
            None,
            None
        )
        .await
        .unwrap()
        .is_empty());
    }
    for method in ["list_objects", "list_tables"] {
        let requests = fixture.requests(method);
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["params"]["limit"], 2);
        assert_eq!(requests[0]["params"]["offset"], 3);
        assert_eq!(requests[1]["params"]["limit"], i32::MAX);
        assert_eq!(requests[1]["params"]["offset"], i32::MAX);
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn oceanbase_include_exclude_filters_stay_before_local_pagination() {
    let fixture = Fixture::new().await;
    let name_filter = TableNameFilter { include_patterns: vec!["B%".into()], exclude_patterns: vec!["A%".into()] };
    let objects = list_objects_core(
        &fixture.state,
        "ob",
        "APP",
        "APP",
        Some("report"),
        Some(1),
        Some(1),
        None,
        Some(&name_filter),
    )
    .await
    .unwrap();
    let tables = list_tables_core(
        &fixture.state,
        "ob",
        "APP",
        "APP",
        Some("report"),
        Some(1),
        Some(1),
        None,
        Some(&name_filter),
    )
    .await
    .unwrap();
    assert_eq!(objects.len(), 1);
    assert_eq!((&*objects[0].name, &*objects[0].object_type), ("B", "VIEW"));
    assert_eq!(tables.len(), 1);
    assert_eq!((&*tables[0].name, &*tables[0].table_type), ("B", "VIEW"));
    for method in ["list_objects", "list_tables"] {
        let requests = fixture.requests(method);
        assert_eq!(requests.len(), 1);
        assert!(requests[0]["params"]["limit"].is_null());
        assert!(requests[0]["params"]["offset"].is_null());
        assert_eq!(requests[0]["params"]["filter"], "report");
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn other_agents_keep_local_metadata_pagination() {
    let fixture = Fixture::for_database_type(DatabaseType::Dameng).await;
    let objects = list_objects_core(&fixture.state, "ob", "APP", "APP", Some("report"), Some(1), Some(2), None, None)
        .await
        .unwrap();
    let tables = list_tables_core(&fixture.state, "ob", "APP", "APP", Some("report"), Some(1), Some(2), None, None)
        .await
        .unwrap();
    assert_eq!(objects.len(), 1);
    assert_eq!((&*objects[0].name, &*objects[0].object_type), ("B", "VIEW"));
    assert_eq!(tables.len(), 1);
    assert_eq!((&*tables[0].name, &*tables[0].table_type), ("B", "VIEW"));
    for method in ["list_objects", "list_tables"] {
        let requests = fixture.requests(method);
        assert_eq!(requests.len(), 1);
        assert!(requests[0]["params"]["limit"].is_null());
        assert!(requests[0]["params"]["offset"].is_null());
    }
    fixture.shutdown().await;
}
