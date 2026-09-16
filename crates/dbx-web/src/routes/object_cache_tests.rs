//! Regression coverage across real Web handlers and MCP backends.
use super::{connection, query, schema, schema_cache};
use crate::state::WebState;
use axum::{
    routing::{get, post},
    Router,
};
use dbx_core::{
    agent_tools::AgentSqlPermissions,
    connection::AppState,
    models::connection::ConnectionConfig,
    query::QueryExecutionOptions,
    storage::{McpGlobalPolicy, Storage},
};
use dbx_mcp::{DbxBackend, LocalBackend, WebBackend};
use serde_json::{json, Value};
use std::sync::Arc;

async fn run_object_cache_regression(postgres: bool) {
    let dir = std::env::temp_dir().join(format!("dbx-object-cache-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let database =
        if postgres { std::env::var("DBX_LIVE_POSTGRES_DATABASE").expect("test database") } else { "main".into() };
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id": "cache:中文%", "name": "cache regression", "db_type": if postgres { "postgres" } else { "sqlite" },
        "host": if postgres { std::env::var("DBX_LIVE_POSTGRES_HOST").expect("test host") } else { dir.join("query.db").to_str().unwrap().to_string() },
        "port": if postgres { std::env::var("DBX_LIVE_POSTGRES_PORT").expect("test port").parse::<u16>().unwrap() } else { 0 },
        "username": if postgres { std::env::var("DBX_LIVE_POSTGRES_USER").expect("test user") } else { String::new() },
        "password": if postgres { std::env::var("DBX_LIVE_POSTGRES_PASSWORD").expect("test password") } else { String::new() },
        "database": database, "save_password": true
    })).unwrap();
    if !postgres {
        dbx_core::db::sqlite::connect_path_create_if_missing(&config.host).await.unwrap();
    }
    storage.save_connections(std::slice::from_ref(&config)).await.unwrap();
    storage
        .save_mcp_global_policy(&McpGlobalPolicy { read_only: false, allow_dangerous_sql: true, ..Default::default() })
        .await
        .unwrap();
    let app = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
    app.configs.write().await.insert(config.id.clone(), config.clone());
    let mut state = WebState::for_tests(app.clone(), dir.clone());
    state.password_disabled = true;
    let state = Arc::new(state);
    let router = Router::new()
        .route("/api/auth/check", get(crate::auth::check))
        .route("/api/connection/connect", post(connection::connect_db))
        .route("/api/query/execute", post(query::execute_query))
        .route("/api/query/execute-multi", post(query::execute_multi))
        .route("/api/query/execute-batch", post(query::execute_batch))
        .route("/api/schema/columns", get(schema::list_columns))
        .route("/api/schema/ddl", get(schema::get_ddl))
        .route("/api/schema/cache", get(schema_cache::load_schema_cache).post(schema_cache::save_schema_cache))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let local = LocalBackend::from_app_state(app.clone(), dir.clone());
    let web = WebBackend::new(base.clone(), String::new()).unwrap();
    let client = reqwest::Client::new();
    let schema_name = if postgres { format!("dbx_cache_{}", uuid::Uuid::new_v4().simple()) } else { "main".into() };
    if postgres {
        local.execute_query(&config, &database, &format!("CREATE SCHEMA {schema_name}"), None, None).await.unwrap();
    }
    let table = format!("{schema_name}.users");
    local.execute_query(&config, &database, &format!("CREATE TABLE {table} (id INTEGER)"), None, None).await.unwrap();
    let prefix = dbx_core::object_cache::object_metadata_cache_prefix(&config.id, &database);
    let schema_segment = dbx_core::object_cache::metadata_cache_segment(&schema_name);
    let front_key = format!("{prefix}{schema_segment}:users::TABLE:columns:");
    let ddl_key = format!(
        "object-ddl:v1:{}:{}:{schema_segment}:users::TABLE:",
        dbx_core::object_cache::metadata_cache_segment(&config.id),
        dbx_core::object_cache::metadata_cache_segment(&database)
    );
    let backend_key = format!("{prefix}{schema_segment}:users::backend-columns:");
    for mode in 0..5 {
        let parameters = [
            ("connection_id", config.id.as_str()),
            ("database", database.as_str()),
            ("schema", schema_name.as_str()),
            ("table", "users"),
        ];
        let old_columns: Value = client
            .get(format!("{base}/api/schema/columns"))
            .query(&parameters)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let old_ddl: Value = client
            .get(format!("{base}/api/schema/ddl"))
            .query(&parameters)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        for (key, payload) in [
            (&front_key, json!({"version": 1, "cachedAt": chrono::Utc::now().to_rfc3339(), "value": old_columns})),
            (&ddl_key, json!({"version": 1, "cachedAt": chrono::Utc::now().to_rfc3339(), "ddl": old_ddl})),
        ] {
            client
                .post(format!("{base}/api/schema/cache"))
                .json(&json!({"cacheKey": key, "payload": payload}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
        }
        assert!(app.storage.load_schema_cache(&backend_key).await.unwrap().is_some());
        let column = format!("added_{mode}");
        let sql = format!("ALTER TABLE {table} ADD COLUMN {column} INTEGER");
        if mode == 0 || mode == 2 {
            let backend: &dyn DbxBackend = if mode == 0 { &local } else { &web };
            let result = backend
                .execute_agent_tool(
                    &config,
                    &database,
                    "execute_query",
                    json!({"sql": sql}),
                    AgentSqlPermissions { allow_writes: true, allow_dangerous: true, confirmed_write_sql: None },
                )
                .await;
            assert!(!result.is_error, "{}", result.content);
        } else if mode == 1 || mode == 3 {
            let backend: &dyn DbxBackend = if mode == 1 { &local } else { &web };
            let results = backend
                .execute_batch(
                    &config,
                    &database,
                    Some(&schema_name),
                    &format!("{sql}; SELECT 1"),
                    QueryExecutionOptions::default(),
                )
                .await
                .unwrap();
            assert_eq!(results.len(), 2);
            assert!(results.iter().all(|result| !result.execution_error), "{results:?}");
        } else {
            client.post(format!("{base}/api/query/execute-batch")).json(&json!({"connectionId": config.id, "database": database, "statements": [sql], "schema": schema_name})).send().await.unwrap().error_for_status().unwrap();
        }
        for key in [&front_key, &ddl_key, &backend_key] {
            assert!(app.storage.load_schema_cache(key).await.unwrap().is_none(), "mode {mode}: {key}");
        }
        // A fresh frontend read must miss persisted snapshots, then fetch the
        // actual updated columns and DDL through the real Web handlers.
        let cached: Value = client
            .get(format!("{base}/api/schema/cache"))
            .query(&[("cache_key", &front_key)])
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(cached.is_null());
        let columns: Value = client
            .get(format!("{base}/api/schema/columns"))
            .query(&parameters)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(columns.as_array().unwrap().iter().any(|c| c["name"] == column), "{columns}");
        let ddl: Value = client
            .get(format!("{base}/api/schema/ddl"))
            .query(&parameters)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(ddl.to_string().contains(&column), "{ddl}");
    }
    if postgres {
        local
            .execute_query(&config, &database, &format!("DROP SCHEMA {schema_name} CASCADE"), None, None)
            .await
            .unwrap();
    }
    server.abort();
    let _ = server.await;
    drop(web);
    drop(local);
    drop(app);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn ddl_schema_cache_real_web_handlers_and_mcp_backends() {
    run_object_cache_regression(false).await;
}

#[tokio::test]
#[ignore = "requires isolated writable DBX_LIVE_POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE"]
async fn ddl_schema_cache_live_postgres_web_handlers_and_mcp_backends() {
    run_object_cache_regression(true).await;
}
