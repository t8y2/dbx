//! Live regression coverage for the MySQL object-browser row counts: MySQL 8
//! caches `information_schema.TABLES` statistics per session for
//! `information_schema_stats_expiry` seconds (86400 by default), so a table
//! that was read while still empty kept reporting `TABLE_ROWS = 0` long after
//! rows were inserted, and the sidebar/对象浏览器 showed the stale count
//! (#9736). The statistics path must clear that cache before reading.

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;

fn live_mysql_config(connection_id: &str, database: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_MYSQL_HOST").expect("DBX_LIVE_MYSQL_HOST");
    let port: u16 =
        std::env::var("DBX_LIVE_MYSQL_PORT").expect("DBX_LIVE_MYSQL_PORT").parse().expect("valid DBX_LIVE_MYSQL_PORT");
    let username = std::env::var("DBX_LIVE_MYSQL_USER").expect("DBX_LIVE_MYSQL_USER");
    let password = std::env::var("DBX_LIVE_MYSQL_PASSWORD").expect("DBX_LIVE_MYSQL_PASSWORD");

    serde_json::from_value::<ConnectionConfig>(serde_json::json!({
        "id": connection_id,
        "name": connection_id,
        "db_type": DatabaseType::Mysql,
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
    .expect("live MySQL config should deserialize")
}

async fn estimated_rows_for(state: &AppState, connection_id: &str, database: &str, table: &str) -> Option<i64> {
    let statistics = dbx_core::schema::list_object_statistics_core(state, connection_id, database, "")
        .await
        .expect("object statistics for a live MySQL schema");
    statistics.iter().find(|entry| entry.name == table).and_then(|entry| entry.estimated_rows)
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_HOST/PORT/USER/PASSWORD/DATABASE pointing at a writable MySQL 8 server"]
async fn live_mysql_object_statistics_refresh_after_writes() {
    let database = std::env::var("DBX_LIVE_MYSQL_DATABASE").expect("DBX_LIVE_MYSQL_DATABASE");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-object-statistics-{suffix}");
    let table = format!("dbx_stats_fresh_{}", &suffix[..12]);
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-object-statistics-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    state.configs.write().await.insert(connection_id.clone(), live_mysql_config(&connection_id, &database));

    execute_sql_statement(&state, &connection_id, &database, &format!("DROP TABLE IF EXISTS `{table}`"), None, None)
        .await
        .expect("clean the live statistics fixture table");
    execute_sql_statement(
        &state,
        &connection_id,
        &database,
        &format!("CREATE TABLE `{table}` (id INT PRIMARY KEY AUTO_INCREMENT, label VARCHAR(32) NOT NULL)"),
        None,
        None,
    )
    .await
    .expect("create the live statistics fixture table");

    // The desktop app reads the table list statistics right after opening a
    // database, which is what fills MySQL's session-scoped statistics cache.
    assert_eq!(
        estimated_rows_for(&state, &connection_id, &database, &table).await,
        Some(0),
        "an empty table reports zero rows before the writes"
    );

    let values = (1..=7).map(|id| format!("({id}, 'row-{id}')")).collect::<Vec<_>>().join(", ");
    execute_sql_statement(
        &state,
        &connection_id,
        &database,
        &format!("INSERT INTO `{table}` (id, label) VALUES {values}"),
        None,
        None,
    )
    .await
    .expect("insert the live statistics rows");

    let refreshed = estimated_rows_for(&state, &connection_id, &database, &table).await;
    let cleanup = execute_sql_statement(
        &state,
        &connection_id,
        &database,
        &format!("DROP TABLE IF EXISTS `{table}`"),
        None,
        None,
    )
    .await;

    assert_eq!(refreshed, Some(7), "the cached row count must be refreshed after the inserts");
    cleanup.expect("drop the live statistics fixture table");
}

/// The object list keeps MySQL identifiers verbatim (a leading space is legal
/// inside backticks). Statistics must use the exact same key or the browser
/// loses the row count, engine, charset and collation for the table (#14905).
#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_HOST/PORT/USER/PASSWORD/DATABASE pointing at a writable MySQL 8 server"]
async fn live_mysql_object_statistics_match_space_padded_object_list() {
    let database = std::env::var("DBX_LIVE_MYSQL_DATABASE").expect("DBX_LIVE_MYSQL_DATABASE");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-object-statistics-padded-{suffix}");
    // MySQL forbids a trailing space in a table name, but a leading space is
    // significant inside backticks and is enough to catch key normalization.
    let table = format!(" dbx_stats_padded_{}", &suffix[..12]);
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-object-statistics-padded-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    state.configs.write().await.insert(connection_id.clone(), live_mysql_config(&connection_id, &database));

    execute_sql_statement(&state, &connection_id, &database, &format!("DROP TABLE IF EXISTS `{table}`"), None, None)
        .await
        .expect("clean the live padded statistics fixture table");
    execute_sql_statement(
        &state,
        &connection_id,
        &database,
        &format!("CREATE TABLE `{table}` (id INT PRIMARY KEY AUTO_INCREMENT, label VARCHAR(32) NOT NULL)"),
        None,
        None,
    )
    .await
    .expect("create the live padded statistics fixture table");
    execute_sql_statement(
        &state,
        &connection_id,
        &database,
        &format!("INSERT INTO `{table}` (id, label) VALUES (1, 'row-1')"),
        None,
        None,
    )
    .await
    .expect("insert the live padded statistics fixture row");

    let object_types = vec!["TABLE".to_string()];
    let objects = dbx_core::schema::list_objects_core(
        &state,
        &connection_id,
        &database,
        "",
        None,
        None,
        None,
        Some(&object_types),
        None,
    )
    .await
    .expect("object list for a live MySQL schema");
    let object_names = objects.iter().map(|object| object.name.clone()).collect::<Vec<_>>();
    let statistics = dbx_core::schema::list_object_statistics_core(&state, &connection_id, &database, "")
        .await
        .expect("object statistics for a live MySQL schema");
    let matching_statistics = statistics
        .iter()
        .find(|entry| entry.name == table)
        .map(|entry| (entry.schema.clone(), entry.estimated_rows, entry.engine.clone(), entry.collation.clone()));
    let cleanup = execute_sql_statement(
        &state,
        &connection_id,
        &database,
        &format!("DROP TABLE IF EXISTS `{table}`"),
        None,
        None,
    )
    .await;

    assert!(object_names.contains(&table), "the object list must keep the exact MySQL table identifier");
    let (schema, estimated_rows, engine, collation) =
        matching_statistics.expect("statistics must use the exact object-list table name");
    assert_eq!(schema.as_deref(), Some(database.as_str()));
    assert_eq!(estimated_rows, Some(1));
    assert!(engine.is_some_and(|value| !value.trim().is_empty()), "engine must be reported for the matched table");
    assert!(
        collation.is_some_and(|value| !value.trim().is_empty()),
        "collation must be reported for the matched table"
    );
    cleanup.expect("drop the live padded statistics fixture table");
}

/// ` orders` and `orders` are two different tables. DDL generated from a row must
/// address only the row the user picked, and the refreshed list must keep showing
/// both rows with their own metadata (#14905 review).
#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_HOST/PORT/USER/PASSWORD/DATABASE pointing at a writable MySQL 8 server"]
async fn live_mysql_ddl_targets_only_the_selected_space_padded_table() {
    let database = std::env::var("DBX_LIVE_MYSQL_DATABASE").expect("DBX_LIVE_MYSQL_DATABASE");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-padded-ddl-{suffix}");
    let plain_table = format!("dbx_pad_{}", &suffix[..12]);
    // MySQL forbids a trailing space in a table name; a leading space is
    // significant inside backticks and is the shape reported in #14905.
    let padded_table = format!(" {plain_table}");
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-padded-ddl-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    state.configs.write().await.insert(connection_id.clone(), live_mysql_config(&connection_id, &database));

    for table in [&padded_table, &plain_table] {
        execute_sql_statement(
            &state,
            &connection_id,
            &database,
            &format!("DROP TABLE IF EXISTS `{table}`"),
            None,
            None,
        )
        .await
        .expect("clean the live padded DDL fixture tables");
        execute_sql_statement(
            &state,
            &connection_id,
            &database,
            &format!(
                "CREATE TABLE `{table}` (id INT PRIMARY KEY AUTO_INCREMENT, label VARCHAR(32) NOT NULL) ENGINE=InnoDB"
            ),
            None,
            None,
        )
        .await
        .expect("create the live padded DDL fixture tables");
    }

    let objects = dbx_core::schema::list_objects_core(
        &state,
        &connection_id,
        &database,
        "",
        None,
        None,
        None,
        Some(&["TABLE".to_string()]),
        None,
    )
    .await
    .expect("object list for a live MySQL schema");
    let object_names = objects.iter().map(|object| object.name.clone()).collect::<Vec<_>>();

    // Exactly what the desktop does when the user changes the engine of the
    // padded row: one statement, addressed by the row's exact identifier.
    let alter = execute_sql_statement(
        &state,
        &connection_id,
        &database,
        &format!("ALTER TABLE `{database}`.`{padded_table}` ENGINE = MyISAM"),
        None,
        None,
    )
    .await;

    let statistics = dbx_core::schema::list_object_statistics_core(&state, &connection_id, &database, "")
        .await
        .expect("object statistics for a live MySQL schema");
    let engine_of =
        |name: &str| statistics.iter().find(|entry| entry.name == name).and_then(|entry| entry.engine.clone());
    let padded_engine = engine_of(&padded_table);
    let plain_engine = engine_of(&plain_table);

    let mut cleanup_failures = Vec::new();
    for table in [&padded_table, &plain_table] {
        if let Err(error) = execute_sql_statement(
            &state,
            &connection_id,
            &database,
            &format!("DROP TABLE IF EXISTS `{table}`"),
            None,
            None,
        )
        .await
        {
            cleanup_failures.push(format!("{table}: {error}"));
        }
    }

    assert!(object_names.contains(&padded_table), "the object list must keep the leading space of the padded table");
    assert!(object_names.contains(&plain_table), "the trimmed table must stay in the object list");
    alter.expect("altering the padded table engine must succeed on its exact identifier");
    assert_eq!(padded_engine.as_deref(), Some("MyISAM"), "the selected table must be the one whose engine changed");
    assert_eq!(plain_engine.as_deref(), Some("InnoDB"), "the neighbouring table must keep its engine");
    assert!(cleanup_failures.is_empty(), "cleanup must drop both fixture tables: {cleanup_failures:?}");
}
