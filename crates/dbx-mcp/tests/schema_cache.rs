use dbx_core::{
    models::connection::ConnectionConfig,
    storage::{McpGlobalPolicy, Storage},
};
use dbx_mcp::{DbxMcpServer, LocalBackend, McpScope};
use rmcp::{model::CallToolRequestParams, ServiceExt};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn ddl_schema_cache_mcp_query_and_automatic_batch_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("query.db");
    dbx_core::db::sqlite::connect_path_create_if_missing(path.to_str().unwrap()).await.unwrap();
    let storage = Storage::open(&dir.path().join("storage.db")).await.unwrap();
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id": "cache-mcp", "name": "cache-mcp", "db_type": "sqlite", "host": path,
        "port": 0, "username": "", "password": "", "database": "main"
    }))
    .unwrap();
    storage.add_connection_for_mcp(config).await.unwrap();
    storage
        .save_mcp_global_policy(&McpGlobalPolicy { read_only: false, allow_dangerous_sql: true, ..Default::default() })
        .await
        .unwrap();
    let backend = Arc::new(LocalBackend::open(&dir.path().join("storage.db")).await.unwrap());
    let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.unwrap();
    for (tool, sql) in [
        ("dbx_execute_query", "CREATE TABLE users (id INTEGER)"),
        ("dbx_execute_query", "ALTER TABLE users ADD COLUMN from_query INTEGER; SELECT 1"),
        ("dbx_execute_batch", "ALTER TABLE users ADD COLUMN from_batch INTEGER; SELECT 1"),
    ] {
        let key = "object-meta:v1:cache-mcp:main:main:users::backend-columns:";
        storage.save_schema_cache(key, &json!([])).await.unwrap();
        let result = client
            .peer()
            .call_tool(
                CallToolRequestParams::new(tool).with_arguments(
                    json!({
                        "connection_id": "cache-mcp", "database": "main", "sql": sql
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                ),
            )
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true), "{result:?}");
        assert!(storage.load_schema_cache(key).await.unwrap().is_none(), "{tool}: {sql}");
    }
    client.cancel().await.unwrap();
    server_task.await.unwrap().unwrap().cancel().await.unwrap();
}
