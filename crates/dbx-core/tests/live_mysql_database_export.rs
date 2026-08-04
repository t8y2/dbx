use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, DatabaseExportRequest};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::sql::SqlFileRequest;
use dbx_core::sql_file_import::execute_sql_file_path;
use dbx_core::storage::Storage;
use tokio_util::sync::CancellationToken;

fn exported_view_position(sql: &str, view_name: &str) -> Option<usize> {
    regex::Regex::new(&format!(r"(?is)\bCREATE\b[^;]*\bVIEW\s+(?:`[^`]+`\.)?`{}`\s+AS\b", regex::escape(view_name)))
        .unwrap()
        .find(sql)
        .map(|matched| matched.start())
}

fn live_mysql_config(id: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_SQL_FILE_MYSQL_HOST").expect("DBX_LIVE_SQL_FILE_MYSQL_HOST");
    let port =
        std::env::var("DBX_LIVE_SQL_FILE_MYSQL_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(3306);
    let username = std::env::var("DBX_LIVE_SQL_FILE_MYSQL_USER").expect("DBX_LIVE_SQL_FILE_MYSQL_USER");
    let password = std::env::var("DBX_LIVE_SQL_FILE_MYSQL_PASSWORD").expect("DBX_LIVE_SQL_FILE_MYSQL_PASSWORD");

    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Mysql,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": null,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live MySQL export config should deserialize")
}

#[tokio::test]
#[ignore = "requires a disposable MySQL endpoint"]
async fn live_mysql_database_export_restores_dependent_views() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-export-{suffix}");
    let database = format!("dbx_export_{suffix}");
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-export-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    state.configs.write().await.insert(connection_id.clone(), live_mysql_config(&connection_id));

    for sql in [
        format!("DROP DATABASE IF EXISTS `{database}`"),
        format!("CREATE DATABASE `{database}`"),
        format!("CREATE TABLE `{database}`.`base_table` (id INT PRIMARY KEY)"),
        format!("INSERT INTO `{database}`.`base_table` VALUES (7)"),
        format!("CREATE VIEW `{database}`.`z_view` AS SELECT id FROM `{database}`.`base_table`"),
        format!("CREATE VIEW `{database}`.`a_view` AS SELECT id FROM `{database}`.`z_view`"),
    ] {
        execute_sql_statement(&state, &connection_id, "", &sql, None, None).await.unwrap();
    }

    let file_path = dir.join("export.sql");
    let export_request = DatabaseExportRequest {
        export_id: format!("live-mysql-export-{suffix}"),
        connection_id: connection_id.clone(),
        database: database.clone(),
        schema: database.clone(),
        file_path: file_path.to_string_lossy().to_string(),
        selected_tables: Vec::new(),
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: true,
        include_objects: true,
        include_create_database: true,
        drop_table_if_exists: true,
        omit_auto_increment: false,
        fail_on_error: true,
        snapshot_session_id: None,
        batch_size: 1000,
    };
    let test_result = async {
        export_database_sql_core(&state, &export_request, |_| {}).await?;
        let exported = std::fs::read_to_string(&file_path).map_err(|error| error.to_string())?;
        let referenced_view = exported_view_position(&exported, "z_view")
            .ok_or_else(|| "exported z_view DDL was not found".to_string())?;
        let dependent_view = exported_view_position(&exported, "a_view")
            .ok_or_else(|| "exported a_view DDL was not found".to_string())?;

        execute_sql_statement(&state, &connection_id, "", &format!("DROP DATABASE `{database}`"), None, None).await?;
        let import_request = SqlFileRequest {
            execution_id: format!("live-mysql-import-{suffix}"),
            connection_id: connection_id.clone(),
            database: String::new(),
            file_path: file_path.to_string_lossy().to_string(),
            continue_on_error: false,
        };
        execute_sql_file_path(
            &state,
            &import_request,
            &file_path,
            CancellationToken::new(),
            std::time::Instant::now(),
            |_| {},
        )
        .await?;

        let result =
            execute_sql_statement(&state, &connection_id, &database, "SELECT id FROM a_view", None, None).await?;
        Ok::<_, String>((referenced_view, dependent_view, result))
    }
    .await;
    let cleanup =
        execute_sql_statement(&state, &connection_id, "", &format!("DROP DATABASE `{database}`"), None, None).await;

    cleanup.unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    let (referenced_view, dependent_view, result) = test_result.unwrap();
    assert!(referenced_view < dependent_view);
    assert_eq!(result.rows, vec![vec![serde_json::json!("7")]]);
}
