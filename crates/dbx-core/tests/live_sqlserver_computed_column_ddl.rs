//! Live regression coverage for issue #10055: a SQL Server computed column
//! (`AS (expression) [PERSISTED]`) used to be scripted as a plain column with
//! its derived result type, so the generated `CREATE TABLE` did not recreate
//! the table. The display DDL has to keep the computed definition, and the
//! emitted script has to replay onto the server.

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::storage::Storage;
use std::sync::Arc;

fn live_sqlserver_config(id: &str, database: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port: u16 = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let username = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");

    serde_json::from_value::<ConnectionConfig>(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::SqlServer,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": database,
        "connect_timeout_secs": 15,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live SQL Server config should deserialize")
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server"]
async fn live_sqlserver_display_ddl_keeps_computed_column_definitions() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-sqlserver-computed-ddl-{suffix}");
    let database = format!("dbx_ddl_computed_{suffix}");
    let restored_database = format!("{database}_replay");
    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-computed-ddl-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), live_sqlserver_config(&connection_id, "master"));

    let table = format!("authorization_{suffix}");
    let create_table = format!(
        "CREATE TABLE [dbo].[{table}] ([id] [nvarchar](100) NOT NULL, [authorization_code_value] [nvarchar](max) NULL, \
         [authorization_code_hash] AS (CONVERT([binary](32), hashbytes('SHA2_256', [authorization_code_value]))) PERSISTED, \
         [id_hash] AS (CONVERT([binary](32), hashbytes('SHA2_256', [id]))) PERSISTED NOT NULL, \
         [name_upper] AS (upper([id])), CONSTRAINT [PK_{table}] PRIMARY KEY CLUSTERED ([id] ASC))"
    );
    for sql in [
        format!("CREATE DATABASE [{database}]"),
        format!("USE [{database}]; {create_table}"),
        format!("CREATE DATABASE [{restored_database}]"),
    ] {
        execute_sql_statement(&state, &connection_id, "", &sql, None, None)
            .await
            .unwrap_or_else(|error| panic!("fixture statement failed: {error}"));
    }

    let ddl = dbx_core::schema::get_table_display_ddl_core(&state, &connection_id, &database, "dbo", &table, None)
        .await
        .expect("display DDL for a table owning computed columns");

    println!("=== display DDL ===\n{ddl}\n===================");

    // SQL Server normalizes the stored definition (no whitespace from the
    // original statement), so the script has to reuse that text.
    assert!(
        ddl.contains("[authorization_code_hash] AS (CONVERT([binary](32),hashbytes('SHA2_256',[authorization_code_value]))) PERSISTED"),
        "persisted computed column keeps its expression: {ddl}"
    );
    assert!(
        ddl.contains("[id_hash] AS (CONVERT([binary](32),hashbytes('SHA2_256',[id]))) PERSISTED NOT NULL"),
        "a NOT NULL computed column keeps both attributes: {ddl}"
    );
    assert!(ddl.contains("[name_upper] AS (upper([id]))"), "non-persisted computed column keeps its expression: {ddl}");
    assert!(
        !ddl.contains("[authorization_code_hash] binary(32)"),
        "the derived result type must not be rendered as the column definition: {ddl}"
    );

    // Replaying the script must recreate both computed columns instead of
    // flattening them into their derived result types.
    execute_sql_statement(&state, &connection_id, "", &format!("USE [{restored_database}]; {ddl}"), None, None)
        .await
        .unwrap_or_else(|error| panic!("replayed DDL must execute: {error}"));

    let computed_columns_sql = format!(
        "USE [{restored_database}]; SELECT c.name, cc.definition, cc.is_persisted FROM sys.columns c \
         JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
         WHERE c.object_id = OBJECT_ID(N'dbo.{table}') ORDER BY c.column_id"
    );
    let restored = execute_sql_statement(&state, &connection_id, "", &computed_columns_sql, None, None)
        .await
        .expect("read the replayed computed columns");
    let restored_rows = restored
        .rows
        .iter()
        .map(|row| {
            (
                row[0].as_str().unwrap_or_default().to_string(),
                row[1].as_str().unwrap_or_default().to_string(),
                row[2].as_bool().unwrap_or(false),
            )
        })
        .collect::<Vec<_>>();

    let cleanup_sql = format!(
        "USE [master]; ALTER DATABASE [{database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{database}]; \
         ALTER DATABASE [{restored_database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{restored_database}]"
    );
    let cleanup = execute_sql_statement(&state, &connection_id, "", &cleanup_sql, None, None).await;

    assert_eq!(
        restored_rows,
        vec![
            (
                "authorization_code_hash".to_string(),
                "(CONVERT([binary](32),hashbytes('SHA2_256',[authorization_code_value])))".to_string(),
                true
            ),
            ("id_hash".to_string(), "(CONVERT([binary](32),hashbytes('SHA2_256',[id])))".to_string(), true),
            ("name_upper".to_string(), "(upper([id]))".to_string(), false),
        ],
        "the replayed DDL recreates both computed columns: {ddl}"
    );
    cleanup.expect("drop the live SQL Server computed-column fixture databases");
}
