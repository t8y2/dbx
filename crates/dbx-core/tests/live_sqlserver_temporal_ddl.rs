use dbx_core::connection::AppState;
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::query::execute_sql_statement;
use dbx_core::storage::Storage;
use std::sync::Arc;

fn quote(value: &str) -> String {
    format!("[{}]", value.replace(']', "]]"))
}

#[tokio::test]
#[ignore = "requires writable DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD"]
async fn live_sqlserver_temporal_display_ddl_replays_period_history_and_disabled_versioning() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(Storage::open(&dir.path().join("dbx.db")).await.unwrap()));
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id":"temporal-ddl", "name":"Temporal DDL regression", "db_type":"sqlserver",
        "host":std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_|"127.0.0.1".into()),
        "port":std::env::var("DBX_LIVE_SQLSERVER_PORT").unwrap_or_else(|_|"1433".into()).parse::<u16>().unwrap(),
        "username":std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_|"sa".into()),
        "password":std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("live SQL Server password"),
        "database":"master", "connect_timeout_secs":15, "query_timeout_secs":60
    }))
    .unwrap();
    state.configs.write().await.insert(config.id.clone(), config.clone());
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source = format!("dbx_temporal_{suffix}");
    let restored = format!("dbx_temporal_restore_{suffix}");
    let history_schema = "His]t_2209";
    let table = "Current]Table";
    let history = "Archive]Table";
    let table_ref = format!("[dbo].{}", quote(table));
    let history_ref = format!("{}.{}", quote(history_schema), quote(history));
    for database in [&source, &restored] {
        execute_sql_statement(
            &state,
            &config.id,
            "master",
            &format!("CREATE DATABASE {}", quote(database)),
            None,
            None,
        )
        .await
        .unwrap();
        execute_sql_statement(
            &state,
            &config.id,
            database,
            &format!("CREATE SCHEMA {}", quote(history_schema)),
            None,
            None,
        )
        .await
        .unwrap();
    }
    let result = async {
        let create = format!("CREATE TABLE {table_ref} ([id] int NOT NULL PRIMARY KEY,[payload] nvarchar(50),[Start]]At] datetime2(7) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL DEFAULT SYSUTCDATETIME(),[End.At] datetime2(7) GENERATED ALWAYS AS ROW END NOT NULL DEFAULT CONVERT(datetime2(7),'9999-12-31 23:59:59.9999999'),PERIOD FOR SYSTEM_TIME ([Start]]At],[End.At])) WITH (SYSTEM_VERSIONING=ON (HISTORY_TABLE={history_ref},HISTORY_RETENTION_PERIOD=6 MONTHS))");
        execute_sql_statement(&state, &config.id, &source, &create, None, None).await?;
        let ddl = dbx_core::schema::get_table_display_ddl_core(&state, &config.id, &source, "dbo", table, None).await?;
        assert!(ddl.contains("GENERATED ALWAYS AS ROW START HIDDEN"), "{ddl}");
        assert!(ddl.contains("GENERATED ALWAYS AS ROW END NOT NULL"), "{ddl}");
        assert!(ddl.contains("PERIOD FOR SYSTEM_TIME ([Start]]At], [End.At])"), "{ddl}");
        assert!(ddl.contains(&format!("HISTORY_TABLE = {history_ref}")), "{ddl}");
        assert!(ddl.contains("HISTORY_RETENTION_PERIOD = 6 MONTH"), "{ddl}");
        // A history definition advertises the reverse relationship. Replaying it
        // first lets the current-table script bind to the same qualified history.
        let history_ddl = dbx_core::schema::get_table_display_ddl_core(&state, &config.id, &source, history_schema, history, None).await?;
        assert!(history_ddl.starts_with(&format!("-- History table for {table_ref}\n")), "{history_ddl}");
        execute_sql_statement(&state, &config.id, &restored, &history_ddl, None, None).await?;
        execute_sql_statement(&state, &config.id, &restored, &ddl, None, None).await?;
        let catalog = execute_sql_statement(&state, &config.id, &restored,
            "SELECT CAST(t.temporal_type AS int),s.name,h.name,cs.name,ce.name,CAST(t.history_retention_period AS int),t.history_retention_period_unit_desc FROM sys.tables t JOIN sys.periods p ON p.object_id=t.object_id JOIN sys.tables h ON h.object_id=t.history_table_id JOIN sys.schemas s ON s.schema_id=h.schema_id JOIN sys.columns cs ON cs.object_id=p.object_id AND cs.column_id=p.start_column_id JOIN sys.columns ce ON ce.object_id=p.object_id AND ce.column_id=p.end_column_id WHERE t.temporal_type=2", None, None).await?;
        assert_eq!(catalog.rows[0], vec![serde_json::json!(2),serde_json::json!(history_schema),serde_json::json!(history),serde_json::json!("Start]At"),serde_json::json!("End.At"),serde_json::json!(6),serde_json::json!("MONTH")]);
        execute_sql_statement(&state, &config.id, &restored, &format!("INSERT INTO {table_ref}([id],[payload]) VALUES(1,N'first')"), None, None).await?;
        execute_sql_statement(&state, &config.id, &restored, &format!("UPDATE {table_ref} SET [payload]=N'second' WHERE [id]=1"), None, None).await?;
        let rows = execute_sql_statement(&state, &config.id, &restored, &format!("SELECT [payload] FROM {history_ref}"), None, None).await?;
        assert_eq!(rows.rows[0][0], serde_json::json!("first"));
        // Basic/portable definitions must not attach a clone to a source history table.
        let portable = dbx_core::schema::get_table_export_ddl_core(&state, &config.id, &source, "dbo", table, None).await?;
        assert!(!portable.contains("PERIOD FOR SYSTEM_TIME"));
        assert!(!portable.contains("SYSTEM_VERSIONING"));
        execute_sql_statement(&state, &config.id, &source, &format!("ALTER TABLE {table_ref} SET (SYSTEM_VERSIONING=OFF)"), None, None).await?;
        let disabled = dbx_core::schema::get_table_display_ddl_core(&state, &config.id, &source, "dbo", table, None).await?;
        assert!(disabled.contains("PERIOD FOR SYSTEM_TIME"), "{disabled}");
        assert!(!disabled.contains("SYSTEM_VERSIONING"), "{disabled}");
        execute_sql_statement(&state, &config.id, &restored, &format!("ALTER TABLE {table_ref} SET (SYSTEM_VERSIONING=OFF); DROP TABLE {table_ref}"), None, None).await?;
        execute_sql_statement(&state, &config.id, &restored, &disabled, None, None).await?;
        let state_after = execute_sql_statement(&state, &config.id, &restored, "SELECT CAST(t.temporal_type AS int) FROM sys.tables t JOIN sys.periods p ON p.object_id=t.object_id", None, None).await?;
        assert_eq!(state_after.rows[0][0], serde_json::json!(0));
        Ok::<(),String>(())
    }.await;
    for database in [&source, &restored] {
        execute_sql_statement(
            &state,
            &config.id,
            "master",
            &format!(
                "ALTER DATABASE {} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE {}",
                quote(database),
                quote(database)
            ),
            None,
            None,
        )
        .await
        .unwrap();
    }
    state.shutdown(std::time::Duration::from_secs(1)).await;
    result.expect("temporal DDL live regression");
}
