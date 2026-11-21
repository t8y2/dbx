//! Dictionary-derived identities used by the schema-index entry. Legacy callers
//! retain the ordinary metadata resolution and synonym behavior in schema/mod.rs.

use super::*;
use crate::db::agent_driver::{agent_schema_params, agent_schema_table_params, AgentCapability, AgentMethod};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

const UNSUPPORTED: &str = "Cannot verify exact_metadata_identity_v1. Update the Agent or JDBC plugin and reconnect.";

fn jdbc_supports_exact_identity(protocol: &Value) -> bool {
    protocol["version"] == 2
        && protocol["capabilities"].as_array().is_some_and(|values| {
            values.iter().any(|value| value.as_str() == Some(AgentCapability::ExactMetadataIdentityV1.as_str()))
        })
}

fn supports_family(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng)
        || (config.db_type == DatabaseType::Jdbc
            && config.connection_string.as_deref().is_some_and(|url| {
                let url = url.trim().to_ascii_lowercase();
                url.starts_with("jdbc:oracle:")
                    || url.starts_with("jdbc:dm:")
                    || url.starts_with("jdbc:oceanbase:oracle://")
            }))
}

fn external_method(method: AgentMethod) -> Option<&'static str> {
    match method {
        AgentMethod::ListTables => Some("listTables"),
        AgentMethod::ListObjects => Some("listObjects"),
        AgentMethod::GetColumns => Some("getColumns"),
        AgentMethod::ListIndexes => Some("listIndexes"),
        AgentMethod::GetTableDdl => Some("getObjectSource"),
        AgentMethod::ExecuteQuery => Some("executeQuery"),
        _ => None,
    }
}

async fn request<T: DeserializeOwned + Send + 'static>(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    client_session_id: Option<&str>,
    method: AgentMethod,
    params: Value,
) -> Result<T, String> {
    if schema.trim().is_empty() {
        return Err("An explicit schema is required for exact metadata identity".into());
    }
    let ephemeral = if client_session_id.is_none() {
        Some(EphemeralAgentMetadataSession::open(state, connection_id, Some(database), "exact-metadata").await)
    } else {
        None
    };
    let session_id = client_session_id.or_else(|| ephemeral.as_ref().and_then(|session| session.client_session_id()));
    let result = retry_metadata_connection_for_session(state, connection_id, Some(database), session_id, || async {
        let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), session_id).await?;
        let config = connection_config(state, connection_id).await;
        let timeout = agent_metadata_timeout(config.as_ref());
        let pool = state.pool_handle(&pool_key).await.ok_or("Pool not found")?;
        // A query generated here has raw owner/name predicates; it does not ask
        // an old metadata method to interpret an option it might silently ignore.
        let dictionary_sql = method == AgentMethod::ExecuteQuery;
        match pool {
            PoolKind::Agent(client) => {
                if !config.as_ref().is_some_and(supports_family) {
                    return Ok(Err(UNSUPPORTED.into()));
                }
                if method == AgentMethod::ListObjects
                    && config.as_ref().is_some_and(|config| {
                        config.db_type == DatabaseType::Oracle && !is_default_oracle_agent_config(config)
                    })
                {
                    // This retained path executes Core-owned raw dictionary SQL;
                    // no legacy metadata method is asked to interpret a new flag.
                    let types: Option<Vec<String>> =
                        serde_json::from_value(params["object_types"].clone()).map_err(|error| error.to_string())?;
                    let outcome = oracle_agent_list_objects(
                        client,
                        database,
                        schema,
                        params["filter"].as_str(),
                        params["limit"].as_u64().map(|value| value as usize),
                        params["offset"].as_u64().map(|value| value as usize),
                        types.as_deref(),
                        true,
                        timeout,
                    )
                    .await?;
                    return serde_json::to_value(outcome.objects)
                        .and_then(serde_json::from_value::<T>)
                        .map(Ok)
                        .map_err(|error| error.to_string());
                }
                let mut client = client.lock().await;
                if !dictionary_sql && !client.supports_capability(AgentCapability::ExactMetadataIdentityV1) {
                    return Ok(Err(UNSUPPORTED.into()));
                }
                let mut params = params.clone();
                if !dictionary_sql {
                    params["exact_identity"] = json!(true);
                }
                client.call_method_with_timeout::<T>(method, params, timeout).await.map(Ok)
            }
            PoolKind::ExternalDriver { config, session, .. } => {
                if !supports_family(&config) {
                    return Ok(Err(UNSUPPORTED.into()));
                }
                let Some(plugin_method) = external_method(method) else {
                    return Ok(Err("This JDBC metadata facet is not supported".into()));
                };
                if method == AgentMethod::GetTableDdl && params["portable"] == true {
                    return Ok(Err("Portable exact DDL is not available from this JDBC metadata method".into()));
                }
                if !dictionary_sql {
                    let protocol =
                        match session.invoke_with_timeout::<Value>("jdbcSessionProtocol", json!({}), timeout).await {
                            Ok(protocol) => protocol,
                            Err(error) => return Ok(Err(format!("{UNSUPPORTED} {error}"))),
                        };
                    if !jdbc_supports_exact_identity(&protocol) {
                        return Ok(Err(UNSUPPORTED.into()));
                    }
                }
                let mut params = params.clone();
                params["connection"] = serde_json::to_value(config.as_ref()).map_err(|error| error.to_string())?;
                if !dictionary_sql {
                    params["exact_identity"] = json!(true);
                }
                session.invoke_with_timeout::<T>(plugin_method, params, timeout).await.map(Ok)
            }
            _ => Ok(Err(UNSUPPORTED.into())),
        }
    })
    .await;
    if let Some(ephemeral) = ephemeral {
        ephemeral.finish(state, connection_id, Some(database)).await;
    }
    // Local contract refusal is not an Agent failure and must not quarantine
    // the legacy session. Only errors from an actual RPC enter recovery above.
    result.and_then(|result| result)
}

#[allow(clippy::too_many_arguments)]
pub async fn objects(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
    table_name_filter: Option<&TableNameFilter>,
) -> Result<Vec<db::ObjectInfo>, String> {
    validate_oceanbase_metadata_page(limit, offset)?;
    let mut params = agent_schema_params(database, schema);
    params["filter"] = json!(filter);
    let local_patterns = table_name_filter.is_some_and(|filter| !filter.is_empty());
    if !local_patterns {
        params["limit"] = json!(limit);
        params["offset"] = json!(offset);
    }
    params["object_types"] = json!(object_types);
    let objects = request(state, connection_id, database, schema, None, AgentMethod::ListObjects, params).await?;
    // The opted-in adapters own paging. Never apply their offset a second time.
    Ok(filter_object_infos(
        objects,
        filter,
        limit,
        if local_patterns { offset } else { Some(0) },
        object_types,
        table_name_filter,
    ))
}

#[allow(clippy::too_many_arguments)]
pub async fn tables(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
    table_name_filter: Option<&TableNameFilter>,
) -> Result<Vec<db::TableInfo>, String> {
    validate_oceanbase_metadata_page(limit, offset)?;
    let mut params = agent_schema_params(database, schema);
    params["filter"] = json!(filter);
    let local_patterns = table_name_filter.is_some_and(|filter| !filter.is_empty());
    if !local_patterns {
        params["limit"] = json!(limit);
        params["offset"] = json!(offset);
    }
    params["object_types"] = json!(object_types);
    let tables = request(state, connection_id, database, schema, None, AgentMethod::ListTables, params).await?;
    Ok(filter_table_infos(
        tables,
        filter,
        limit,
        if local_patterns { offset } else { Some(0) },
        object_types,
        table_name_filter,
    ))
}

pub async fn columns(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    client_session_id: Option<&str>,
) -> Result<Vec<db::ColumnInfo>, String> {
    request(
        state,
        connection_id,
        database,
        schema,
        client_session_id,
        AgentMethod::GetColumns,
        agent_schema_table_params(database, schema, table),
    )
    .await
}

pub async fn indexes(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::IndexInfo>, String> {
    request(
        state,
        connection_id,
        database,
        schema,
        None,
        AgentMethod::ListIndexes,
        agent_schema_table_params(database, schema, table),
    )
    .await
}

pub async fn foreign_keys(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    request(
        state,
        connection_id,
        database,
        schema,
        None,
        AgentMethod::ListForeignKeys,
        agent_schema_table_params(database, schema, table),
    )
    .await
}

pub async fn constraints(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ConstraintInfo>, String> {
    request(
        state,
        connection_id,
        database,
        schema,
        None,
        AgentMethod::ListConstraints,
        agent_schema_table_params(database, schema, table),
    )
    .await
}

pub async fn triggers(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::TriggerInfo>, String> {
    request(
        state,
        connection_id,
        database,
        schema,
        None,
        AgentMethod::ListTriggers,
        agent_schema_table_params(database, schema, table),
    )
    .await
}

pub async fn comment(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Option<String>, String> {
    let sql = oracle_table_comment_sql(schema, table);
    let params = agent_execute_query_params(
        &sql,
        Some(database),
        None,
        QueryExecutionOptions { max_rows: Some(1), ..Default::default() },
    );
    let result = request(state, connection_id, database, schema, None, AgentMethod::ExecuteQuery, params).await?;
    single_table_comment_from_query_result(result)
}

pub async fn ddl(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    object_type: Option<db::ObjectSourceKind>,
    portable: bool,
) -> Result<String, String> {
    let mut params = agent_schema_table_params(database, schema, table);
    params["name"] = json!(table);
    params["object_type"] = object_type.map_or_else(|| json!("TABLE"), |kind| json!(kind));
    params["portable"] = json!(portable);
    let result: Value = request(state, connection_id, database, schema, None, AgentMethod::GetTableDdl, params).await?;
    result
        .as_str()
        .or_else(|| result.get("source").and_then(Value::as_str))
        .map(str::to_owned)
        .filter(|source| !source.is_empty())
        .ok_or("Exact table DDL is unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::agent_driver::{AgentDriverClient, AgentLaunchSpec};

    #[test]
    fn a_jdbc_version_number_alone_cannot_grant_exact_identity() {
        assert!(!jdbc_supports_exact_identity(&json!({"version":2})));
        assert!(!jdbc_supports_exact_identity(&json!({"version":2,"capabilities":["metadata"]})));
        assert!(!jdbc_supports_exact_identity(&json!({"version":1,"capabilities":["exact_metadata_identity_v1"]})));
        assert!(jdbc_supports_exact_identity(&json!({"version":2,"capabilities":["exact_metadata_identity_v1"]})));
    }

    async fn agent_fixture(mode: &str) -> (tempfile::TempDir, AppState, String) {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("agent.py");
        std::fs::write(&script, r#"import json, pathlib, re, sys
mode, log = sys.argv[1], pathlib.Path(sys.argv[2])
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    method, params = request['method'], request.get('params', {})
    with log.open('a') as output:
        output.write(json.dumps(request) + '\n')
    body = {'result': {}}
    if method == 'handshake':
        if mode == 'missing':
            body = {'error': {'code': -32601, 'message': 'Method not found'}}
        else:
            capabilities = ['metadata']
            if mode in ('v1-exact', 'v2-exact'): capabilities.append('exact_metadata_identity_v1')
            version = 2 if mode == 'v2-exact' else 1
            body = {'result': {'protocolVersion': version, 'agentProtocolVersion': version, 'capabilities': capabilities}}
    elif method in ('list_objects', 'list_tables'):
        if mode == 'default-paged':
            rows = [{'name': 'I%d' % i, 'object_type': 'INDEX', 'schema': 'APP', 'parent_schema': 'APP', 'parent_name': 'T'} for i in range(5)]
            start = params.get('offset') or 0
            rows = rows[start:][:params.get('limit') or len(rows)]
            print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': rows}), flush=True)
            continue
        # An old provider accepts unknown options and returns a nearby object.
        exact = params.get('exact_identity', False) and mode.endswith('exact')
        body = {'result': [{'name': ' Ix(a) ' if exact else 'IX(A)', 'object_type': 'INDEX',
                            'schema': params['schema'] if exact else params['schema'].strip().upper(),
                            'parent_schema': ' Other Owner ', 'parent_name': ' T(a) '}]}
    elif method == 'get_columns':
        exact = params.get('exact_identity', False) and mode.endswith('exact')
        body = {'result': [{'name': 'Id' if exact else 'ID', 'data_type': 'NUMBER', 'is_nullable': False,
                            'is_primary_key': True}]}
    elif method == 'execute_query':
        if mode == 'legacy-error':
            body = {'error': {'code': -32000, 'message': 'ORA-01031: insufficient privileges'}}
        else:
            sql = params.get('sql', '')
            rows = [] if mode == 'legacy-empty' or "'INDEX'" not in sql else [['I_noise_%05d' % i, 'INDEX', ' Mixed ', ' Other Owner ', ' T(a) '] for i in range(10001)] + [[name, 'INDEX', ' Mixed ', ' Other Owner ', ' T(a) '] for name in [' needle(a) ', 'needle(A)', 'needle_A_2']]
            upper = re.search(r'ROWNUM <= (\d+)', sql)
            lower = re.search(r'dbx_row_number > (\d+)', sql)
            pattern = re.search(r"LOWER\(object_name\) LIKE '([^']*)'", sql)
            if pattern:
                expression = ''.join('.*' if ch == '%' else '.' if ch == '_' else re.escape(ch) for ch in pattern.group(1))
                rows = [row for row in rows if re.fullmatch(expression, row[0].lower())]
            rows = rows[int(lower.group(1)) if lower else 0:int(upper.group(1)) if upper else len(rows)]
            rows = rows[:params.get('maxRows', 10000)]
            body = {'result': {'columns': [], 'rows': rows, 'affected_rows': 0, 'execution_time_ms': 0}}
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], **body}), flush=True)
"#).unwrap();
        let python = if cfg!(windows) { "python" } else { "python3" };
        let mut client = AgentDriverClient::spawn(AgentLaunchSpec::new(python).with_args([
            script.to_string_lossy().to_string(),
            mode.into(),
            directory.path().join("calls").to_string_lossy().to_string(),
        ]))
        .await
        .unwrap();
        client.try_optional_handshake("test").await;
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id":"conn", "name":"Exact metadata test", "db_type":"oracle", "driver_profile": if mode.starts_with("legacy-") { "oracle-legacy" } else { "oracle" },
            "host":"127.0.0.1", "port":1521, "database":"demo", "username":"fixture", "password":"",
            "keepalive_interval_secs":0, "idle_timeout_secs":0,
        })).unwrap();
        state.configs.write().await.insert("conn".into(), config);
        let key =
            format!("{}:role:metadata", state.session_pool_key_for_test("conn", Some("demo"), "exact-test").await);
        state.update_connection_pools(|pools| pools.insert(key.clone(), PoolKind::agent(client))).await;
        (directory, state, key)
    }

    fn requests(directory: &std::path::Path, method: &str) -> Vec<Value> {
        std::fs::read_to_string(directory.join("calls"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|request| request["method"] == method)
            .collect()
    }

    #[tokio::test]
    async fn old_process_cannot_supply_exact_list_picker_or_baseline_but_legacy_reads_remain_usable() {
        for mode in ["missing", "metadata"] {
            let (directory, state, key) = agent_fixture(mode).await;
            for method in [AgentMethod::ListObjects, AgentMethod::ListTables, AgentMethod::GetColumns] {
                let error = request::<Value>(
                    &state,
                    "conn",
                    "demo",
                    " Mixed ",
                    Some("exact-test"),
                    method,
                    agent_schema_table_params("demo", " Mixed ", " T(a) "),
                )
                .await
                .unwrap_err();
                assert!(error.contains("exact_metadata_identity_v1"), "{mode}: {error}");
                assert!(requests(directory.path(), method.as_str()).is_empty());
            }
            let columns = super::super::get_columns_core_for_session_in_context(
                &state,
                "conn",
                "demo",
                "MIXED",
                "T(A)",
                Some("exact-test"),
                None,
            )
            .await
            .unwrap();
            assert_eq!(columns[0].name, "ID");
            assert_eq!(requests(directory.path(), "get_columns").len(), 1);
            assert!(state.pool_handle(&key).await.is_some());
            state.shutdown(Duration::from_secs(2)).await;
        }
    }

    #[tokio::test]
    async fn explicit_v1_and_v2_processes_receive_raw_identities_and_no_casefold_fallback() {
        for mode in ["v1-exact", "v2-exact"] {
            let (directory, state, _key) = agent_fixture(mode).await;
            let objects: Vec<db::ObjectInfo> = request(
                &state,
                "conn",
                "demo",
                " Mixed ",
                Some("exact-test"),
                AgentMethod::ListObjects,
                agent_schema_params("demo", " Mixed "),
            )
            .await
            .unwrap();
            assert_eq!(objects[0].name, " Ix(a) ");
            assert_eq!(objects[0].schema.as_deref(), Some(" Mixed "));
            assert_eq!(objects[0].parent_schema.as_deref(), Some(" Other Owner "));
            assert_eq!(objects[0].parent_name.as_deref(), Some(" T(a) "));
            assert_eq!(
                columns(&state, "conn", "demo", " Mixed ", " T(a) ", Some("exact-test")).await.unwrap()[0].name,
                "Id"
            );
            let calls = requests(directory.path(), "get_columns");
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0]["params"]["schema"], " Mixed ");
            assert_eq!(calls[0]["params"]["table"], " T(a) ");
            assert_eq!(calls[0]["params"]["exact_identity"], true);
            state.shutdown(Duration::from_secs(2)).await;
        }
    }

    #[tokio::test]
    async fn legacy_oracle_keeps_indexes_beyond_ten_thousand_candidates_and_both_raw_owners() {
        let (directory, state, _key) = agent_fixture("legacy-all").await;
        let types = vec!["INDEX".to_string()];
        let outcome = super::super::list_objects_once(
            &state,
            "conn",
            "demo",
            " mixed ",
            None,
            None,
            None,
            None,
            None,
            Some("exact-test"),
            &MetadataReadOptions::default(),
        )
        .await
        .unwrap();
        assert!(!outcome.paging_applied);
        assert_eq!(outcome.objects.len(), 10004);
        let page = filter_object_infos(outcome.objects, Some("needle"), Some(2), Some(1), Some(&types), None);
        assert_eq!(page.iter().map(|object| object.name.as_str()).collect::<Vec<_>>(), ["needle(A)", "needle_A_2"]);
        assert_eq!(page[0].schema.as_deref(), Some(" Mixed "));
        assert_eq!(page[0].parent_schema.as_deref(), Some(" Other Owner "));
        assert_eq!(page[0].parent_name.as_deref(), Some(" T(a) "));
        assert!(requests(directory.path(), "list_objects").is_empty());
        assert!(requests(directory.path(), "execute_query").len() >= 2);
        let outcome = super::super::list_objects_once(
            &state,
            "conn",
            "demo",
            " mixed ",
            Some("needle"),
            Some(2),
            Some(1),
            Some(&types),
            None,
            Some("exact-test"),
            &MetadataReadOptions::default(),
        )
        .await
        .unwrap();
        assert!(outcome.paging_applied);
        assert_eq!(
            outcome.objects.iter().map(|object| object.name.as_str()).collect::<Vec<_>>(),
            ["needle(A)", "needle_A_2"]
        );
        let objects: Vec<db::ObjectInfo> = request(&state, "conn", "demo", " Mixed ", Some("exact-test"), AgentMethod::ListObjects,
            json!({"database":"demo", "schema":" Mixed ", "object_types":["INDEX"], "filter":"needle", "limit":2, "offset":1})).await.unwrap();
        assert_eq!(objects[0].parent_schema.as_deref(), Some(" Other Owner "));
        assert!(requests(directory.path(), "execute_query").last().unwrap()["params"]["sql"]
            .as_str()
            .unwrap()
            .contains("o.owner = ' Mixed '"));
        state.shutdown(Duration::from_secs(2)).await;
    }

    #[tokio::test]
    async fn legacy_oracle_empty_and_dictionary_failure_are_distinct() {
        for mode in ["legacy-empty", "legacy-error"] {
            let (_directory, state, _key) = agent_fixture(mode).await;
            let result = super::super::list_objects_once(
                &state,
                "conn",
                "demo",
                "APP",
                None,
                Some(2),
                Some(1),
                Some(&["INDEX".into()]),
                None,
                Some("exact-test"),
                &MetadataReadOptions::default(),
            )
            .await;
            if mode == "legacy-empty" {
                assert!(result.unwrap().objects.is_empty());
            } else {
                assert!(result.err().unwrap().contains("ORA-01031"));
            }
            state.shutdown(Duration::from_secs(2)).await;
        }
    }

    #[tokio::test]
    async fn default_oracle_marks_its_constrained_page_as_already_paged() {
        let (directory, state, _key) = agent_fixture("default-paged").await;
        let outcome = super::super::list_objects_once(
            &state,
            "conn",
            "demo",
            "APP",
            None,
            Some(2),
            Some(2),
            Some(&["INDEX".into()]),
            None,
            Some("exact-test"),
            &MetadataReadOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(outcome.objects.iter().map(|object| object.name.as_str()).collect::<Vec<_>>(), ["I2", "I3"]);
        assert!(outcome.paging_applied);
        assert_eq!(requests(directory.path(), "list_objects")[0]["params"]["offset"], 2);
        state.shutdown(Duration::from_secs(2)).await;
    }
}
