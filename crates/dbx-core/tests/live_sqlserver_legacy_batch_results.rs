//! Opt-in coverage for the core -> rebuilt SQL Server Agent -> real server path.
use dbx_core::connection::AppState;
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::query::{execute_multi_core_with_options_for_client, QueryExecutionOptions};
use serde_json::json;

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST/PASSWORD, DBX_TEST_SQLSERVER_AGENT_JAR and DBX_TEST_SQLSERVER_JAVA"]
async fn sqlserver_legacy_auto_commit_keeps_all_results_scope_and_late_errors() {
    let host = std::env::var("DBX_TEST_SQLSERVER_HOST").expect("SQL Server test host");
    let password = std::env::var("DBX_TEST_SQLSERVER_PASSWORD").expect("SQL Server test password");
    let database = std::env::var("DBX_TEST_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".into());
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id":"legacy-batch-live", "name":"SQL Server legacy batch live test", "db_type":"sqlserver",
        "driver_profile":"sqlserver-legacy", "host":host,
        "port":std::env::var("DBX_TEST_SQLSERVER_PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(1433),
        "port_explicit":true, "username":std::env::var("DBX_TEST_SQLSERVER_USER").unwrap_or_else(|_| "sa".into()),
        "password":password, "database":database,
        "url_params":std::env::var("DBX_TEST_SQLSERVER_URL_PARAMS").ok(),
        "connect_timeout_secs":10, "query_timeout_secs":30, "keepalive_interval_secs":0
    }))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.path().join("state.db")).await.unwrap();
    let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        dir.path().join("agents"),
        "0.6.37",
    );
    let jar = std::env::var("DBX_TEST_SQLSERVER_AGENT_JAR").expect("rebuilt SQL Server Agent JAR");
    dbx_core::agent_service::import_agent_jar(&state.agent_manager, "sqlserver-legacy", std::path::Path::new(&jar))
        .await
        .unwrap();
    state
        .agent_manager
        .mutate_state(|manager| {
            manager.java_runtime = dbx_core::agent_manager::JavaRuntimeConfig {
                mode: dbx_core::agent_manager::JavaRuntimeMode::Custom,
                custom_java_path: Some(std::env::var("DBX_TEST_SQLSERVER_JAVA").expect("Java 21 executable")),
            };
        })
        .unwrap();
    state.configs.write().await.insert(config.id.clone(), config.clone());

    // Pin every execution to the test connection so the private temp table
    // measures whether a batch was replayed while collecting later results.
    let options = QueryExecutionOptions { client_session_id: Some("legacy-batch-live".into()), ..Default::default() };
    let sql = "SELECT 101 AS first_result; SELECT 202 AS second_result; SELECT 303 AS third_result;";
    for page_size in [None, Some(100)] {
        let results = execute_multi_core_with_options_for_client(
            &state,
            &config.id,
            &database,
            sql,
            Some("dbo"),
            None,
            QueryExecutionOptions { page_size, ..options.clone() },
        )
        .await
        .unwrap();
        let rows: Vec<_> = results.iter().filter(|result| !result.result.columns.is_empty()).collect();
        assert_eq!(rows.len(), 3);
        for (result, expected) in rows.iter().zip([101, 202, 303]) {
            assert_eq!(result.result.rows, vec![vec![json!(expected)]]);
        }
    }
    let scope = execute_multi_core_with_options_for_client(
        &state, &config.id, &database,
        "DECLARE @rows TABLE (n INT); INSERT INTO @rows VALUES (1),(2),(3); SELECT n FROM @rows ORDER BY n; SELECT COUNT(*) AS total FROM @rows;",
        None, None, QueryExecutionOptions { max_rows: Some(1), ..options.clone() },
    ).await.unwrap();
    let rows: Vec<_> = scope.iter().filter(|result| !result.result.columns.is_empty()).collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].result.rows, vec![vec![json!(1)]]);
    assert!(rows[0].result.truncated);
    assert_eq!(rows[1].result.rows, vec![vec![json!(3)]]);

    let temp = execute_multi_core_with_options_for_client(
        &state, &config.id, &database,
        "CREATE TABLE #dbx_batch_counter (n INT); INSERT INTO #dbx_batch_counter VALUES (0); UPDATE #dbx_batch_counter SET n=n+1; SELECT n AS first FROM #dbx_batch_counter; UPDATE #dbx_batch_counter SET n=n+1; SELECT n AS second FROM #dbx_batch_counter;",
        None, None, options.clone(),
    ).await.unwrap();
    assert_eq!(temp.iter().map(|result| result.result.affected_rows).sum::<u64>(), 3);
    let rows: Vec<_> = temp.iter().filter(|result| !result.result.columns.is_empty()).collect();
    assert_eq!(rows[0].result.rows, vec![vec![json!(1)]]);
    assert_eq!(rows[1].result.rows, vec![vec![json!(2)]]);

    let go = execute_multi_core_with_options_for_client(
        &state,
        &config.id,
        &database,
        "SELECT 1 AS n;\nGO\nSELECT 2 AS n;",
        None,
        None,
        options.clone(),
    )
    .await
    .unwrap();
    assert_eq!(go.len(), 2);
    assert_eq!(go[0].result.rows, vec![vec![json!(1)]]);
    assert_eq!(go[1].result.rows, vec![vec![json!(2)]]);

    let error = execute_multi_core_with_options_for_client(
        &state,
        &config.id,
        &database,
        "SELECT 1 AS n; RAISERROR('DBX batch late error',16,1);",
        None,
        None,
        options.clone(),
    )
    .await
    .unwrap();
    assert_eq!(error.len(), 1);
    assert!(error[0].execution_error);
    assert!(error[0].result.rows[0][0].as_str().unwrap().contains("DBX batch late error"));
    state.close_client_session_pool(&config.id, Some(&database), "legacy-batch-live").await.unwrap();
}
