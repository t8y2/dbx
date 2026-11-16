//! Live Oracle check for grid saves on a result read through a PUBLIC synonym.
//!
//! An unqualified `SELECT ... FROM alias` resolves through a PUBLIC synonym, but a write
//! qualified with the query tab's schema (`UPDATE "APP"."ALIAS"`) fails with `ORA-00942`.
//! Column metadata must therefore report the synonym's target as the write identity.
//!
//! The login user needs `CREATE TABLE`, `CREATE PUBLIC SYNONYM`, and `DROP PUBLIC SYNONYM`:
//!
//! ```bash
//! DBX_LIVE_ORACLE_HOST=127.0.0.1 \
//! DBX_LIVE_ORACLE_PORT=1521 \
//! DBX_LIVE_ORACLE_SERVICE=FREEPDB1 \
//! DBX_LIVE_ORACLE_USER=dbx_test \
//! DBX_LIVE_ORACLE_PASSWORD=... \
//!   cargo test -p dbx-core --test live_oracle_public_synonym_columns -- --ignored --nocapture
//! ```

use std::sync::Arc;

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::schema::get_columns_core;

fn required_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set for live Oracle tests"))
}

fn live_oracle_config(id: &str) -> ConnectionConfig {
    let port = std::env::var("DBX_LIVE_ORACLE_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(1521);
    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Oracle,
        "host": required_env("DBX_LIVE_ORACLE_HOST"),
        "port": port,
        "username": required_env("DBX_LIVE_ORACLE_USER"),
        "password": required_env("DBX_LIVE_ORACLE_PASSWORD"),
        "database": required_env("DBX_LIVE_ORACLE_SERVICE"),
        "connect_timeout_secs": 10,
        "query_timeout_secs": 60,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live Oracle config should deserialize")
}

async fn live_state(suffix: &str) -> (Arc<AppState>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("dbx-live-oracle-public-synonym-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    (Arc::new(AppState::new(storage)), dir)
}

#[tokio::test]
#[ignore = "requires a disposable Oracle endpoint (DBX_LIVE_ORACLE_*) whose user may create PUBLIC synonyms"]
async fn live_oracle_public_synonym_columns_report_the_writable_target() {
    let suffix = uuid::Uuid::new_v4().simple().to_string()[..8].to_uppercase();
    let connection_id = format!("live-oracle-public-synonym-{suffix}");
    let service = required_env("DBX_LIVE_ORACLE_SERVICE");
    let login_schema = required_env("DBX_LIVE_ORACLE_USER").to_uppercase();
    let table = format!("DBX_SYN_BASE_{suffix}");
    let synonym = format!("DBX_SYN_ALIAS_{suffix}");
    let (state, dir) = live_state(&suffix).await;
    state.configs.write().await.insert(connection_id.clone(), live_oracle_config(&connection_id));
    let run = |sql: String| {
        let state = state.clone();
        let connection_id = connection_id.clone();
        let service = service.clone();
        async move { execute_sql_statement(&state, &connection_id, &service, &sql, None, None).await }
    };

    run(format!("CREATE TABLE {table} (PATIENT_ID VARCHAR2(20), VISIT_ID NUMBER, ROOM VARCHAR2(20), PRIMARY KEY (PATIENT_ID, VISIT_ID))"))
        .await
        .unwrap();
    run(format!("INSERT INTO {table} VALUES ('P1', 1, 'R1')")).await.unwrap();
    run(format!("CREATE PUBLIC SYNONYM {synonym} FOR {login_schema}.{table}")).await.unwrap();

    // The query tab supplies its schema for an unqualified source, as the grid save does.
    let columns = get_columns_core(&state, &connection_id, &service, &login_schema, &synonym).await;
    let qualified_synonym_update = run(format!(
        "UPDATE \"{login_schema}\".\"{synonym}\" SET \"ROOM\" = 'R2' WHERE \"PATIENT_ID\" = 'P1' AND \"VISIT_ID\" = 1"
    ))
    .await;
    let target_update = match &columns {
        Ok(columns) => match (columns.first().and_then(|c| c.resolved_schema.clone()), columns.first().and_then(|c| c.resolved_table.clone())) {
            (Some(schema), Some(name)) => Some(
                run(format!("UPDATE \"{schema}\".\"{name}\" SET \"ROOM\" = 'R2' WHERE \"PATIENT_ID\" = 'P1' AND \"VISIT_ID\" = 1"))
                    .await,
            ),
            _ => None,
        },
        Err(_) => None,
    };
    let room = run(format!("SELECT ROOM FROM {synonym} WHERE PATIENT_ID = 'P1'")).await;

    let _ = run(format!("DROP PUBLIC SYNONYM {synonym}")).await;
    let _ = run(format!("DROP TABLE {table} PURGE")).await;
    let _ = std::fs::remove_dir_all(&dir);

    let columns = columns.unwrap();
    assert_eq!(
        columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(),
        ["PATIENT_ID", "VISIT_ID", "ROOM"]
    );
    assert_eq!(
        columns.iter().filter(|column| column.is_primary_key).map(|column| column.name.as_str()).collect::<Vec<_>>(),
        ["PATIENT_ID", "VISIT_ID"]
    );
    for column in &columns {
        assert_eq!(column.resolved_schema.as_deref(), Some(login_schema.as_str()), "{}", column.name);
        assert_eq!(column.resolved_table.as_deref(), Some(table.as_str()), "{}", column.name);
        assert_eq!(column.resolved_object_type.as_deref(), Some("TABLE"), "{}", column.name);
    }
    let error = qualified_synonym_update.expect_err("a schema-qualified PUBLIC synonym must not resolve");
    assert!(error.contains("ORA-00942"), "{error}");
    let affected = target_update.expect("resolved identity").unwrap().affected_rows;
    assert_eq!(affected, 1);
    assert_eq!(room.unwrap().rows[0][0], serde_json::json!("R2"));
}
