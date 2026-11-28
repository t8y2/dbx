//! Opt-in coverage for the connection init script through the SQL Server legacy Agent.
use dbx_core::connection::AppState;
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::query::{execute_multi_core_with_options_for_client, QueryExecutionOptions};
use serde_json::json;

fn init_script_config(id: &str, database: &str, init_script: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_TEST_SQLSERVER_HOST").expect("SQL Server test host");
    let password = std::env::var("DBX_TEST_SQLSERVER_PASSWORD").expect("SQL Server test password");
    serde_json::from_value(json!({
        "id": id, "name": "SQL Server legacy init script live test", "db_type": "sqlserver",
        "driver_profile": "sqlserver-legacy", "host": host,
        "port": std::env::var("DBX_TEST_SQLSERVER_PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(1433),
        "port_explicit": true,
        "username": std::env::var("DBX_TEST_SQLSERVER_USER").unwrap_or_else(|_| "sa".into()),
        "password": password, "database": database,
        "url_params": std::env::var("DBX_TEST_SQLSERVER_URL_PARAMS").ok(),
        "connect_timeout_secs": 10, "query_timeout_secs": 30, "keepalive_interval_secs": 0,
        "init_script": init_script,
    }))
    .unwrap()
}

async fn state_with_legacy_agent(dir: &tempfile::TempDir) -> AppState {
    let storage = dbx_core::persistence::test_storage::open(&dir.path().join("state.db")).await.unwrap();
    let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        dir.path().join("agents"),
        "0.6.75",
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
    state
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST/PASSWORD, DBX_TEST_SQLSERVER_AGENT_JAR and DBX_TEST_SQLSERVER_JAVA"]
async fn sqlserver_legacy_init_script_applies_to_the_session() {
    let database = std::env::var("DBX_TEST_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".into());
    let config = init_script_config("legacy-init-script-live", &database, "SET ARITHABORT ON;\nSET ANSI_NULLS ON;");
    let dir = tempfile::tempdir().unwrap();
    let state = state_with_legacy_agent(&dir).await;
    state.configs.write().await.insert(config.id.clone(), config.clone());

    let results = execute_multi_core_with_options_for_client(
        &state,
        &config.id,
        &database,
        "DBCC USEROPTIONS",
        None,
        None,
        QueryExecutionOptions::default(),
    )
    .await
    .expect("query session options through the legacy Agent");

    let options =
        results.iter().find(|result| !result.result.columns.is_empty()).expect("DBCC USEROPTIONS rows").result.clone();
    let value_of = |name: &str| {
        options.rows.iter().find_map(|row| {
            let option = row.first().and_then(|value| value.as_str())?;
            option.trim().eq_ignore_ascii_case(name).then(|| row.get(1).and_then(|value| value.as_str())).flatten()
        })
    };
    assert_eq!(value_of("arithabort"), Some("SET"));
    assert_eq!(value_of("ansi_nulls"), Some("SET"));
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST/PASSWORD, DBX_TEST_SQLSERVER_AGENT_JAR and DBX_TEST_SQLSERVER_JAVA"]
async fn sqlserver_legacy_init_script_failure_rejects_the_connection() {
    let database = std::env::var("DBX_TEST_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".into());
    let config = init_script_config(
        "legacy-init-script-failure-live",
        &database,
        "SELECT * FROM dbx_missing_table_for_init_script",
    );
    let dir = tempfile::tempdir().unwrap();
    let state = state_with_legacy_agent(&dir).await;
    state.configs.write().await.insert(config.id.clone(), config.clone());

    let error = execute_multi_core_with_options_for_client(
        &state,
        &config.id,
        &database,
        "SELECT 1",
        None,
        None,
        QueryExecutionOptions::default(),
    )
    .await
    .expect_err("a failing init script must reject the connection");

    assert!(error.contains("Connection init script batch 1 failed:"), "{error}");
}
