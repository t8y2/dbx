use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, DatabaseExportRequest};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::storage::Storage;
use std::sync::Arc;

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

/// Extracts the order tables appear in exported DDL, by scanning for
/// `CREATE TABLE ... \`name\`` occurrences in file order.
fn exported_table_order(sql: &str, candidate_names: &[&str]) -> Vec<String> {
    let mut hits: Vec<(usize, String)> = Vec::new();
    for name in candidate_names {
        if let Some(pos) = regex::Regex::new(&format!(r"(?is)\bCREATE\s+TABLE\s+`{}`", regex::escape(name)))
            .unwrap()
            .find(sql)
            .map(|m| m.start())
        {
            hits.push((pos, name.to_string()));
        }
    }
    hits.sort_by_key(|(pos, _)| *pos);
    hits.into_iter().map(|(_, name)| name).collect()
}

#[tokio::test]
#[ignore = "requires a disposable MySQL endpoint"]
async fn live_mysql_database_export_table_order_is_not_alphabetical_when_fk_reordered() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-export-order-{suffix}");
    let database = format!("dbx_export_order_{suffix}");
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-export-order-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), live_mysql_config(&connection_id));

    for sql in [
        format!("DROP DATABASE IF EXISTS `{database}`"),
        format!("CREATE DATABASE `{database}`"),
        format!("CREATE TABLE `{database}`.`alpha` (id INT PRIMARY KEY)"),
        format!("CREATE TABLE `{database}`.`bravo` (id INT PRIMARY KEY)"),
        format!("CREATE TABLE `{database}`.`mango` (id INT PRIMARY KEY)"),
        format!("CREATE TABLE `{database}`.`zoo` (id INT PRIMARY KEY)"),
        format!(
            "CREATE TABLE `{database}`.`orders` (id INT PRIMARY KEY, alpha_id INT, \
             FOREIGN KEY (alpha_id) REFERENCES `{database}`.`alpha`(id))"
        ),
        format!(
            "CREATE TABLE `{database}`.`order_items` (id INT PRIMARY KEY, orders_id INT, mango_id INT, \
             FOREIGN KEY (orders_id) REFERENCES `{database}`.`orders`(id), \
             FOREIGN KEY (mango_id) REFERENCES `{database}`.`mango`(id))"
        ),
    ] {
        execute_sql_statement(&state, &connection_id, "", &sql, None, None).await.unwrap();
    }

    let names = ["alpha", "bravo", "mango", "order_items", "orders", "zoo"];
    let alphabetical: Vec<String> = {
        let mut v: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        v.sort();
        v
    };

    let file_path = dir.join("export.sql");
    let export_request = DatabaseExportRequest {
        export_id: format!("live-mysql-export-order-{suffix}"),
        connection_id: connection_id.clone(),
        database: database.clone(),
        schema: database.clone(),
        file_path: file_path.to_string_lossy().to_string(),
        selected_tables: Vec::new(),
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: false,
        include_objects: false,
        include_create_database: false,
        drop_table_if_exists: false,
        omit_auto_increment: false,
        fail_on_error: true,
        snapshot_session_id: None,
        batch_size: 1000,
    };

    let test_result = async {
        export_database_sql_core(&state, &export_request, |_| {}).await?;
        let exported_1 = std::fs::read_to_string(&file_path).map_err(|error| error.to_string())?;
        let order_1 = exported_table_order(&exported_1, &names);

        // Export a second time against the exact same, unchanged schema.
        export_database_sql_core(&state, &export_request, |_| {}).await?;
        let exported_2 = std::fs::read_to_string(&file_path).map_err(|error| error.to_string())?;
        let order_2 = exported_table_order(&exported_2, &names);

        Ok::<_, String>((order_1, order_2))
    }
    .await;

    let cleanup =
        execute_sql_statement(&state, &connection_id, "", &format!("DROP DATABASE `{database}`"), None, None).await;
    cleanup.unwrap();
    std::fs::remove_dir_all(dir).unwrap();

    let (order_1, order_2) = test_result.unwrap();
    eprintln!("run 1 order: {order_1:?}");
    eprintln!("run 2 order: {order_2:?}");
    eprintln!("alphabetical (expected by user): {alphabetical:?}");

    assert_eq!(order_1, order_2, "export order should at least be stable across repeated runs of the same schema");
    assert_eq!(
        order_1, alphabetical,
        "exported table structure order should match the alphabetical order tables are shown in, \
         not the FK-dependency topological order"
    );
}
