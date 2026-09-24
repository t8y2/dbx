//! Live regression coverage for the DDL path of a SQL Server table that owns a
//! foreign key: `sys.foreign_keys.delete_referential_action` /
//! `update_referential_action` are `tinyint` and used to be read with
//! `row.get::<i32>()`, which panicked inside tiberius and aborted the process
//! (the desktop app crashed on "查看 DDL" and on the hover DDL preview).

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::storage::Storage;
use std::sync::Arc;

fn live_sqlserver_config(id: &str, database: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").expect("DBX_LIVE_SQLSERVER_HOST");
    let port: u16 = std::env::var("DBX_LIVE_SQLSERVER_PORT")
        .expect("DBX_LIVE_SQLSERVER_PORT")
        .parse()
        .expect("valid DBX_LIVE_SQLSERVER_PORT");
    let username = std::env::var("DBX_LIVE_SQLSERVER_USER").expect("DBX_LIVE_SQLSERVER_USER");
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
async fn live_sqlserver_display_ddl_reads_foreign_key_actions() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-sqlserver-ddl-fk-{suffix}");
    let database = format!("dbx_ddl_fk_{suffix}");
    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-ddl-fk-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), live_sqlserver_config(&connection_id, "master"));

    let parent = format!("dbx_ddl_parent_{suffix}");
    let child = format!("dbx_ddl_child_{suffix}");
    for sql in [
        format!("CREATE DATABASE [{database}]"),
        format!("CREATE TABLE [dbo].[{parent}] ([id] INT NOT NULL CONSTRAINT [PK_{parent}] PRIMARY KEY CLUSTERED ([id] ASC))"),
        format!(
            "CREATE TABLE [dbo].[{child}] ([id] INT NOT NULL CONSTRAINT [PK_{child}] PRIMARY KEY CLUSTERED ([id] ASC), \
             [parent_id] INT NULL, CONSTRAINT [FK_{child}_parent] FOREIGN KEY ([parent_id]) \
             REFERENCES [dbo].[{parent}] ([id]) ON DELETE CASCADE ON UPDATE NO ACTION)"
        ),
    ] {
        let sql = if sql.starts_with("CREATE TABLE") { format!("USE [{database}]; {sql}") } else { sql };
        execute_sql_statement(&state, &connection_id, "", &sql, None, None)
            .await
            .unwrap_or_else(|error| panic!("fixture statement failed: {error}"));
    }

    // The desktop app calls exactly this path for the DDL tab and the hover preview.
    let ddl = dbx_core::schema::get_table_display_ddl_core(&state, &connection_id, &database, "dbo", &child, None)
        .await
        .expect("display DDL for a table owning a foreign key");

    let cleanup = execute_sql_statement(
        &state,
        &connection_id,
        "",
        &format!("USE [master]; ALTER DATABASE [{database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{database}]"),
        None,
        None,
    )
    .await;

    assert!(ddl.contains("FOREIGN KEY ([parent_id])"), "DDL keeps the foreign key: {ddl}");
    assert!(ddl.contains("ON DELETE CASCADE"), "DDL keeps the delete action: {ddl}");
    assert!(!ddl.contains("ON UPDATE"), "NO ACTION stays implicit: {ddl}");
    cleanup.expect("drop the live SQL Server DDL fixture database");
}
