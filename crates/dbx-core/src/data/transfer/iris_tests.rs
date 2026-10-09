use super::*;
use serde_json::json;

#[test]
fn iris_transfer_pages_advance_with_top_and_vid() {
    let columns = vec!["id".into(), "name".into()];
    assert_eq!(
        pagination_sql(&columns, "items", "SQLUSER", &DatabaseType::Iris, 0, 2),
        "SELECT TOP 2 \"id\", \"name\" FROM \"SQLUSER\".\"items\" ORDER BY %ID"
    );
    for offset in [2, 4] {
        assert_eq!(
            pagination_sql_with_order(
                &columns, "items", "SQLUSER", &DatabaseType::Iris, offset, 2, &["id".into()], None,
            ),
            format!("SELECT * FROM (SELECT TOP {} \"id\", \"name\" FROM \"SQLUSER\".\"items\" ORDER BY \"id\") WHERE %VID > {offset}", offset + 2)
        );
    }
    assert_eq!(
        pagination_sql_with_order(&columns, "items", "SQLUSER", &DatabaseType::Iris, 2, 2, &[], None),
        "SELECT * FROM (SELECT TOP 4 \"id\", \"name\" FROM \"SQLUSER\".\"items\" ORDER BY %ID) WHERE %VID > 2"
    );
}

#[test]
fn iris_transfer_filtered_pages_preserve_predicates_order_and_quoting() {
    assert_eq!(
        pagination_sql_with_filter_order(
            &["item\"id".into()], "item\"s", "team space", &DatabaseType::Iris,
            2, 2, Some("WHERE active = 1"), Some("\"item\"\"id\" DESC"), &[],
        ),
        "SELECT * FROM (SELECT TOP 4 \"item\"\"id\" FROM \"team space\".\"item\"\"s\" WHERE (active = 1) ORDER BY \"item\"\"id\" DESC) WHERE %VID > 2"
    );
}

#[test]
fn iris_transfer_append_and_overwrite_use_single_row_inserts() {
    for mode in [TransferMode::Append, TransferMode::Overwrite] {
        let statements = generate_transfer_write_sql_batches(
            &mode,
            &["id".into(), "name".into()],
            &[Some("INTEGER".into()), Some("VARCHAR".into())],
            &[vec![json!(1), json!("O'Hara")], vec![json!(2), json!(null)]],
            "item\"s",
            "SQLUSER",
            &DatabaseType::Iris,
            &[],
            None,
            false,
            false,
        )
        .unwrap();
        assert_eq!(
            statements,
            vec![
                "INSERT INTO \"SQLUSER\".\"item\"\"s\" (\"id\", \"name\") VALUES\n(1, 'O''Hara')",
                "INSERT INTO \"SQLUSER\".\"item\"\"s\" (\"id\", \"name\") VALUES\n(2, NULL)",
            ]
        );
        assert!(generate_transfer_write_sql_batches(
            &mode,
            &["id".into()],
            &[],
            &[],
            "items",
            "SQLUSER",
            &DatabaseType::Iris,
            &[],
            None,
            false,
            false,
        )
        .unwrap()
        .is_empty());
    }
}

#[test]
fn iris_transfer_limits_and_unsupported_upsert_keep_existing_policies() {
    assert!(transfer_upsert_falls_back_to_append(&DatabaseType::Iris));
    assert!(!supports_primary_key_upsert(&DatabaseType::Iris));
    assert!(transfer_upsert_falls_back_to_append(&DatabaseType::Hive));
    assert!(!transfer_upsert_falls_back_to_append(&DatabaseType::Postgres));
    for requested in [0, 1, 1000] {
        assert_eq!(SqlBatchLimits::for_database(&DatabaseType::Iris, requested).max_rows, 1);
    }
    let rows = ["(1)".into(), "(2)".into()];
    // Even callers supplying their own limits must obey the dialect's row limit.
    let limits = SqlBatchLimits { max_rows: 1000, target_sql_bytes: 1024, hard_sql_bytes: None };
    for (db_type, expected_batches) in [(DatabaseType::Iris, 2), (DatabaseType::Postgres, 1), (DatabaseType::Mysql, 1)]
    {
        let batches = generate_insert_sql_batches_from_value_rows(
            &["id".into()],
            &rows,
            "items",
            "",
            &db_type,
            None,
            limits,
            false,
            true,
        )
        .unwrap();
        assert_eq!(batches.len(), expected_batches);
    }
    assert!(generate_insert_sql_batches_from_value_rows(
        &["id".into()],
        &rows,
        "items",
        "",
        &DatabaseType::Iris,
        None,
        limits.with_hard_sql_bytes(Some(1)),
        false,
        true,
    )
    .unwrap_err()
    .contains("exceeds the 1 byte hard limit"));
}

const IRIS_TRANSFER_AGENT: &str = r#"
import json, pathlib, re, sys
trace = pathlib.Path(sys.argv[1])
row_count = int(sys.argv[2])
failure = sys.argv[3]
has_key = sys.argv[4] == 'true'

def query(rows=None, columns=None):
    return {'columns': columns or [], 'column_types': [], 'column_sortables': [],
            'rows': rows or [], 'affected_rows': 1, 'execution_time_ms': 0,
            'truncated': False, 'session_id': None, 'has_more': False}

print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    method = req['method']
    params = req.get('params', {})
    sql = params.get('sql', '')
    with trace.open('a', encoding='utf-8') as output:
        output.write(json.dumps({'method': method, 'sql': sql, 'params': params}) + '\n')
    try:
        if method == 'handshake':
            result = {'protocolVersion': 2, 'agentProtocolVersion': 2,
                      'capabilities': ['multi_session', 'query', 'metadata']}
        elif method == 'list_tables':
            result = [{'name': 'items', 'table_type': 'TABLE'}]
        elif method == 'get_columns':
            result = [{'name': name, 'data_type': kind, 'is_nullable': False,
                       'is_primary_key': has_key and name == 'id'}
                      for name, kind in [('id', 'INTEGER'), ('name', 'VARCHAR')]]
        elif method == 'execute_query':
            if sql.startswith('SELECT COUNT('):
                if failure == 'count':
                    raise ValueError('injected count failure')
                result = query([[row_count]], ['count'])
            elif sql.startswith('SELECT'):
                top = re.search(r'SELECT TOP (\d+)', sql)
                if not top or ' LIMIT ' in sql or ' OFFSET ' in sql:
                    raise ValueError('expected TOP/VID pagination: ' + sql)
                expected_order = 'ORDER BY "id"' if has_key else 'ORDER BY %ID'
                if expected_order not in sql:
                    raise ValueError('expected stable table order: ' + sql)
                offset = re.search(r'%VID > (\d+)', sql)
                offset = int(offset[1]) if offset else 0
                if failure == 'source' and offset > 0:
                    raise ValueError('injected source failure')
                rows = [[n, 'row-' + str(n)] for n in range(1, row_count + 1)]
                result = query(rows[offset:int(top[1])], ['id', 'name'])
            elif sql.startswith('INSERT INTO'):
                if '),\n(' in sql or 'MERGE' in sql or 'ON CONFLICT' in sql:
                    raise ValueError('expected single-row INSERT: ' + sql)
                if failure == 'target' and 'VALUES\n(3,' in sql:
                    raise ValueError('injected target failure')
                result = query()
            elif sql.startswith('TRUNCATE TABLE'):
                result = query()
            else:
                raise ValueError('unexpected transfer SQL: ' + sql)
        else:
            result = {'ok': True}
        response = {'jsonrpc': '2.0', 'id': req['id'], 'result': result}
    except Exception as error:
        response = {'jsonrpc': '2.0', 'id': req['id'], 'error': {'code': -1, 'message': str(error)}}
    print(json.dumps(response), flush=True)
"#;

async fn iris_transfer_fixture(
    profile: Option<&str>,
    rows: usize,
    failure: &str,
    has_key: bool,
) -> (tempfile::TempDir, Arc<AppState>, TransferRequest, String, String) {
    let directory = tempfile::tempdir().unwrap();
    let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        directory.path().join("plugins"),
        directory.path().join("agents"),
        "0.0.0-test",
    ));
    let script = directory.path().join("agent.py");
    std::fs::write(&script, IRIS_TRANSFER_AGENT).unwrap();
    let launch = state.agent_manager.driver_launch_config_path(profile.unwrap_or("iris"));
    std::fs::create_dir_all(launch.parent().unwrap()).unwrap();
    std::fs::write(
        launch,
        serde_json::to_vec(&json!({
            "command": if cfg!(windows) { "python" } else { "python3" },
            "args": [script, directory.path().join("trace.jsonl"), rows.to_string(), failure, has_key.to_string()],
        }))
        .unwrap(),
    )
    .unwrap();
    for id in ["source", "target"] {
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id": id, "name": id, "db_type": "iris", "driver_profile": profile,
            "host": "127.0.0.1", "port": 1972, "username": "test", "password": "",
            "database": "USER", "one_time": false, "save_password": false,
            "keepalive_interval_secs": 0,
        }))
        .unwrap();
        assert_eq!(effective_transfer_database_type(&config), DatabaseType::Iris);
        state.configs.write().await.insert(id.to_string(), config);
    }
    let source = ensure_transfer_pool(&state, "source", "USER", None).await.unwrap();
    let target = ensure_transfer_pool(&state, "target", "USER", None).await.unwrap();
    let request = serde_json::from_value(json!({
        "transferId": uuid::Uuid::new_v4().to_string(),
        "sourceConnectionId": "source", "sourceDatabase": "USER", "sourceSchema": "SOURCE",
        "targetConnectionId": "target", "targetDatabase": "USER", "targetSchema": "TARGET",
        "tables": ["items"], "createTable": false, "content": "dataOnly", "mode": "append", "batchSize": 2,
    }))
    .unwrap();
    (directory, state, request, source, target)
}

fn iris_transfer_trace(directory: &std::path::Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(directory.join("trace.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
async fn iris_transfer_agent_covers_profiles_pages_empty_tables_and_modes() {
    for profile in [None, Some("cache")] {
        for (rows, mode, has_key) in [
            (0, TransferMode::Append, true),
            (4, TransferMode::Append, true),
            (5, TransferMode::Overwrite, false),
            (5, TransferMode::Upsert, true),
        ] {
            let (directory, state, mut request, source, target) =
                iris_transfer_fixture(profile, rows, "", has_key).await;
            request.mode = mode.clone();
            let mut progress = Vec::new();
            let result = transfer_table(
                &state,
                &request,
                "items",
                0,
                &DatabaseType::Iris,
                &DatabaseType::Iris,
                &source,
                &target,
                &HashMap::new(),
                &mut Vec::new(),
                None,
                |value| progress.push(value.rows_transferred),
            )
            .await;
            state.shutdown(std::time::Duration::from_secs(1)).await;
            assert_eq!(result.unwrap(), rows as u64, "profile={profile:?}, mode={mode:?}");
            let trace = iris_transfer_trace(directory.path());
            let sql: Vec<&str> = trace.iter().filter_map(|entry| entry["sql"].as_str()).collect();
            let inserts: Vec<&&str> = sql.iter().filter(|sql| sql.starts_with("INSERT INTO")).collect();
            assert_eq!(inserts.len(), rows);
            for (index, statement) in inserts.iter().enumerate() {
                assert_eq!(
                    **statement,
                    format!(
                        "INSERT INTO \"TARGET\".\"items\" (\"id\", \"name\") VALUES\n({}, 'row-{}')",
                        index + 1,
                        index + 1,
                    )
                );
            }
            let pages: Vec<&&str> = sql.iter().filter(|sql| sql.contains("SELECT TOP")).collect();
            assert_eq!(pages.len(), rows / 2 + 1);
            for (page, statement) in pages.iter().enumerate().skip(1) {
                assert!(statement.ends_with(&format!("WHERE %VID > {}", page * 2)));
            }
            assert_eq!(
                sql.iter().filter(|sql| sql.starts_with("TRUNCATE TABLE")).count(),
                usize::from(mode == TransferMode::Overwrite)
            );
            if mode == TransferMode::Overwrite {
                let clear = sql.iter().position(|sql| sql.starts_with("TRUNCATE TABLE")).unwrap();
                let write = sql.iter().position(|sql| sql.starts_with("INSERT INTO")).unwrap();
                assert!(clear < write);
            }
            assert_eq!(progress.last().copied().unwrap_or(0), rows as u64);
        }
    }
}

#[tokio::test]
async fn iris_transfer_agent_preserves_errors_count_fallback_and_cancellation() {
    for failure in ["source", "target", "count", "cancel"] {
        let (directory, state, request, source, target) = iris_transfer_fixture(None, 5, failure, true).await;
        let mut totals = Vec::new();
        let mut observed_source_count = None;
        let result = Box::pin(transfer_table_inner(
            &state,
            &request,
            "items",
            0,
            &DatabaseType::Iris,
            &DatabaseType::Iris,
            &source,
            &target,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            |progress| {
                totals.push(progress.total_rows);
                if failure == "cancel" {
                    CANCELLED.try_write().unwrap().insert(request.transfer_id.clone());
                }
            },
            |source_count| observed_source_count = source_count,
        ))
        .await;
        clear_cancelled(&request.transfer_id).await;
        state.shutdown(std::time::Duration::from_secs(1)).await;
        if failure == "count" {
            let result = result.unwrap();
            assert_eq!(result.moved_rows, 5);
            assert_eq!(result.source_row_count, None);
            assert_eq!(observed_source_count, None);
            assert!(totals.iter().all(Option::is_none));
        } else {
            let error = result.unwrap_err();
            if failure == "cancel" {
                assert_eq!(error, "Cancelled");
            } else {
                assert!(error.contains(&format!("injected {failure} failure")), "{error}");
            }
            let trace = iris_transfer_trace(directory.path());
            let inserts = trace
                .iter()
                .filter(|entry| entry["sql"].as_str().is_some_and(|sql| sql.starts_with("INSERT INTO")))
                .count();
            assert_eq!(
                inserts,
                if failure == "target" { 3 } else { 2 },
                "failed writes must not be replayed or followed by more writes"
            );
        }
    }
}
