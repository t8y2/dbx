//! Opt-in coverage for structure-editor comments through the rebuilt SQL Server Agent on a real server.
use dbx_core::connection::AppState;
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::query::execute_statements;
use dbx_core::schema::{get_columns_core, get_table_comment_core};
use dbx_core::table_structure_sql::{build_table_structure_change_sql, TableStructureSqlOptions};
use serde_json::json;

const SCHEMA: &str = "dbx_live_comments";
const TABLE: &str = "legacy_comments";

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST/PASSWORD, DBX_TEST_SQLSERVER_AGENT_JAR and DBX_TEST_SQLSERVER_JAVA"]
async fn sqlserver_legacy_comments_round_trip_on_non_dbo_schema() {
    let host = std::env::var("DBX_TEST_SQLSERVER_HOST").expect("SQL Server test host");
    let password = std::env::var("DBX_TEST_SQLSERVER_PASSWORD").expect("SQL Server test password");
    let database = std::env::var("DBX_TEST_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".into());
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id":"legacy-comments-live", "name":"SQL Server legacy comments live test", "db_type":"sqlserver",
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
        "0.6.38",
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

    // A schema without a same-named database user is what SQL Server 2005+
    // rejects for the `USER` extended-property level (Msg 15135).
    let setup = [
        format!("IF SCHEMA_ID(N'{SCHEMA}') IS NULL EXEC (N'CREATE SCHEMA [{SCHEMA}] AUTHORIZATION dbo')"),
        format!("IF OBJECT_ID(N'[{SCHEMA}].[{TABLE}]') IS NOT NULL DROP TABLE [{SCHEMA}].[{TABLE}]"),
        format!("CREATE TABLE [{SCHEMA}].[{TABLE}] (id int NOT NULL, name nvarchar(50) NULL)"),
    ];
    execute_statements(&state, &config.id, &database, &setup, Some(SCHEMA), None).await.unwrap();

    for (column_comment, table_comment) in
        [("Customer's name", "Customers"), ("Display name", "Customer list"), ("", "")]
    {
        let columns = get_columns_core(&state, &config.id, &database, SCHEMA, TABLE).await.unwrap();
        let original_table_comment =
            get_table_comment_core(&state, &config.id, &database, SCHEMA, TABLE).await.unwrap().unwrap_or_default();
        let drafts = columns
            .iter()
            .map(|column| {
                let comment = if column.name == "name" { column_comment } else { "" };
                json!({
                    "id": column.name, "name": column.name, "dataType": column.data_type,
                    "isNullable": column.is_nullable, "comment": comment, "original": column,
                })
            })
            .collect::<Vec<_>>();
        let options: TableStructureSqlOptions = serde_json::from_value(json!({
            "databaseType": "sqlserver", "driverProfile": "sqlserver-legacy", "schema": SCHEMA, "tableName": TABLE,
            "columns": drafts, "tableComment": table_comment, "originalTableComment": original_table_comment,
        }))
        .unwrap();
        let change = build_table_structure_change_sql(options);
        assert!(change.warnings.is_empty(), "{:?}", change.warnings);
        execute_statements(&state, &config.id, &database, &change.statements, Some(SCHEMA), None).await.unwrap();

        let columns = get_columns_core(&state, &config.id, &database, SCHEMA, TABLE).await.unwrap();
        let name = columns.iter().find(|column| column.name == "name").unwrap();
        assert_eq!(name.comment.as_deref().unwrap_or(""), column_comment);
        let table = get_table_comment_core(&state, &config.id, &database, SCHEMA, TABLE).await.unwrap();
        assert_eq!(table.as_deref().unwrap_or(""), table_comment);
    }

    let cleanup = [format!("DROP TABLE [{SCHEMA}].[{TABLE}]"), format!("DROP SCHEMA [{SCHEMA}]")];
    execute_statements(&state, &config.id, &database, &cleanup, None, None).await.unwrap();
}
