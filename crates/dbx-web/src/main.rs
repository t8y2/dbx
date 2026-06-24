mod auth;
mod error;
mod routes;
mod sse;
mod state;

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHasher};
use axum::extract::DefaultBodyLimit;
use axum::middleware;
use axum::routing::{delete, get, post};
use axum::Router;
use dbx_core::connection::AppState;
use dbx_core::storage::Storage;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

use state::WebState;

fn web_body_limit_bytes() -> usize {
    const DEFAULT_MB: usize = 1024;
    let mb = std::env::var("DBX_MAX_UPLOAD_MB")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MB);
    mb.saturating_mul(1024 * 1024)
}

#[cfg(feature = "mq-admin")]
fn add_mq_routes(router: Router<Arc<WebState>>) -> Router<Arc<WebState>> {
    router
        .route("/mq/test-connection", post(routes::mq::test_connection))
        .route("/mq/tenants/list", post(routes::mq::list_tenants))
        .route("/mq/tenants/get", post(routes::mq::get_tenant))
        .route("/mq/tenants/create", post(routes::mq::create_tenant))
        .route("/mq/tenants/update", post(routes::mq::update_tenant))
        .route("/mq/tenants/delete", post(routes::mq::delete_tenant))
        .route("/mq/namespaces/list", post(routes::mq::list_namespaces))
        .route("/mq/namespaces/create", post(routes::mq::create_namespace))
        .route("/mq/namespaces/delete", post(routes::mq::delete_namespace))
        .route("/mq/namespaces/policies", post(routes::mq::get_namespace_policies))
        .route("/mq/topics/list", post(routes::mq::list_topics))
        .route("/mq/topics/create", post(routes::mq::create_topic))
        .route("/mq/topics/delete", post(routes::mq::delete_topic))
        .route("/mq/topics/update-partitions", post(routes::mq::update_partitions))
        .route("/mq/topics/stats", post(routes::mq::get_topic_stats))
        .route("/mq/topics/internal-stats", post(routes::mq::get_topic_internal_stats))
        .route("/mq/subscriptions/list", post(routes::mq::list_subscriptions))
        .route("/mq/subscriptions/create", post(routes::mq::create_subscription))
        .route("/mq/subscriptions/delete", post(routes::mq::delete_subscription))
        .route("/mq/subscriptions/skip-messages", post(routes::mq::skip_messages))
        .route("/mq/subscriptions/reset-cursor", post(routes::mq::reset_cursor))
        .route("/mq/subscriptions/clear-backlog", post(routes::mq::clear_backlog))
        .route("/mq/subscriptions/peek-messages", post(routes::mq::peek_messages))
        .route("/mq/subscriptions/expire-messages", post(routes::mq::expire_messages))
        .route("/mq/producers/list", post(routes::mq::list_producers))
        .route("/mq/consumers/list", post(routes::mq::list_consumers))
        .route("/mq/topics/unload", post(routes::mq::unload_topic))
        .route("/mq/policies/publish-rate", post(routes::mq::set_publish_rate))
        .route("/mq/policies/dispatch-rate", post(routes::mq::set_dispatch_rate))
        .route("/mq/policies/subscribe-rate", post(routes::mq::set_subscribe_rate))
        .route("/mq/policies/backlog-quota", post(routes::mq::set_backlog_quota))
        .route("/mq/policies/retention", post(routes::mq::set_retention))
        .route("/mq/policies/effective", post(routes::mq::get_effective_policies))
        .route("/mq/permissions/grant", post(routes::mq::grant_permission))
        .route("/mq/permissions/revoke", post(routes::mq::revoke_permission))
        .route("/mq/permissions/list", post(routes::mq::list_permissions))
        .route("/mq/tokens/issue", post(routes::mq::issue_token))
        .route("/mq/tokens/list", post(routes::mq::list_token_records))
        .route("/mq/monitoring/backlog", post(routes::mq::get_backlog))
        .route("/mq/raw", post(routes::mq::raw_request))
}

#[cfg(not(feature = "mq-admin"))]
fn add_mq_routes(router: Router<Arc<WebState>>) -> Router<Arc<WebState>> {
    router
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "dbx_web=info,tower_http=info".parse().unwrap()),
        )
        .init();

    rustls::crypto::aws_lc_rs::default_provider().install_default().expect("Failed to install rustls crypto provider");

    // Data directory
    let data_dir = std::env::var("DBX_DATA_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        std::path::PathBuf::from(home).join(".dbx-web")
    });
    std::fs::create_dir_all(&data_dir).expect("Failed to create data directory");

    let app_state = {
        let db_path = data_dir.join("dbx.db");
        let storage = Storage::open(&db_path).await.expect("Failed to open storage");
        storage.migrate_from_json(&data_dir).await.expect("Failed to migrate JSON data");
        Arc::new(AppState::new_with_plugin_dir_and_app_version(
            storage,
            data_dir.join("plugins"),
            env!("CARGO_PKG_VERSION"),
        ))
    };

    // Password hash: env var takes priority, then database
    let password_disabled = std::env::var("DBX_DISABLE_PASSWORD")
        .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false);

    let password_hash = if password_disabled {
        None
    } else if let Ok(pw) = std::env::var("DBX_PASSWORD") {
        let salt = SaltString::generate(&mut OsRng);
        Some(Argon2::default().hash_password(pw.as_bytes(), &salt).expect("Failed to hash password").to_string())
    } else {
        app_state.storage.load_password_hash().await.unwrap_or(None)
    };

    let web_state = Arc::new(WebState {
        app: app_state,
        data_dir,
        password_disabled,
        password_hash: RwLock::new(password_hash),
        sessions: RwLock::new(HashSet::new()),
        sse_channels: RwLock::new(HashMap::new()),
        sql_file_executions: RwLock::new(HashMap::new()),
        login_rate_limit: tokio::sync::Mutex::new(state::LoginRateLimit { fail_count: 0, locked_until: None }),
        export_files: RwLock::new(HashMap::new()),
    });

    // CORS
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);

    // API routes
    let api = Router::new()
        // Auth
        .route("/auth/login", post(auth::login))
        .route("/auth/check", get(auth::check))
        .route("/auth/setup", post(auth::setup))
        .route("/auth/change-password", post(auth::change_password))
        .route("/auth/logout", post(auth::logout))
        // Connection
        .route("/connection/test", post(routes::connection::test_connection))
        .route("/connection/connect", post(routes::connection::connect_db))
        .route("/connection/final-proxy-port", post(routes::connection::connection_final_proxy_port))
        .route("/connection/disconnect", post(routes::connection::disconnect_db))
        .route("/connection/check-health", post(routes::connection::check_connection_health))
        .route("/connection/close-database", post(routes::connection::close_database_connection))
        .route("/connection/save", post(routes::connection::save_connections))
        .route("/connection/list", get(routes::connection::load_connections))
        .route("/plugins", get(routes::plugins::list_plugins))
        // JDBC
        .route("/jdbc/drivers", get(routes::jdbc::list_jdbc_drivers).post(routes::jdbc::import_jdbc_drivers))
        .route(
            "/jdbc/drivers/maven",
            get(routes::jdbc::list_jdbc_maven_bundles).post(routes::jdbc::install_jdbc_driver_from_maven),
        )
        .route("/jdbc/drivers/prestosql", post(routes::jdbc::install_prestosql_jdbc_driver))
        .route("/jdbc/drivers/maven/{bundle_id}", delete(routes::jdbc::delete_jdbc_maven_bundle))
        .route("/jdbc/drivers/{name}", delete(routes::jdbc::delete_jdbc_driver))
        .route("/jdbc/plugin/status", get(routes::jdbc::get_jdbc_plugin_status))
        .route("/jdbc/plugin/install", post(routes::jdbc::install_jdbc_plugin))
        .route("/jdbc/plugin/install-local", post(routes::jdbc::install_jdbc_plugin_local))
        .route("/jdbc/plugin/uninstall", post(routes::jdbc::uninstall_jdbc_plugin))
        // System
        .route("/system/fonts", get(routes::jdbc::list_system_fonts))
        // Agent drivers
        .route("/agents/installed-local", get(routes::agents::list_installed_agents_local))
        .route("/agents/installed", get(routes::agents::list_installed_agents))
        .route("/agents/storage-usage", get(routes::agents::get_driver_store_usage))
        .route("/agents/runtime", get(routes::agents::get_driver_runtime_summary))
        .route("/agents/runtime/stop", post(routes::agents::stop_driver_runtime))
        .route("/agents/runtime/restart", post(routes::agents::restart_driver_runtime))
        .route("/agents/install", post(routes::agents::install_agent))
        .route("/agents/upgrade-all", post(routes::agents::upgrade_all_agents))
        .route("/agents/uninstall", post(routes::agents::uninstall_agent))
        .route("/agents/import-offline", post(routes::agents::import_agents_from_zip))
        .route("/agents/import-jar", post(routes::agents::import_agent_jar))
        .route(
            "/agents/java-runtime",
            get(routes::agents::get_agent_java_runtime_config).post(routes::agents::set_agent_java_runtime_config),
        )
        .route("/agents/invalidate-registry-cache", post(routes::agents::invalidate_agent_registry_cache))
        .route("/agents/reinstall-jre", post(routes::agents::reinstall_jre))
        .route("/agents/uninstall-jre", post(routes::agents::uninstall_jre))
        .route("/agents/progress/{operationId}", get(routes::agents::agent_progress))
        // Schema
        .route("/schema/databases", get(routes::schema::list_databases))
        .route("/schema/sqlserver/linked-servers", get(routes::schema::list_sqlserver_linked_servers))
        .route("/schema/sqlserver/linked-server-catalogs", get(routes::schema::list_sqlserver_linked_server_catalogs))
        .route("/schema/sqlserver/linked-server-schemas", get(routes::schema::list_sqlserver_linked_server_schemas))
        .route("/schema/sqlserver/linked-server-tables", get(routes::schema::list_sqlserver_linked_server_tables))
        .route("/schema/schemas", get(routes::schema::list_schemas))
        .route("/schema/tables", get(routes::schema::list_tables))
        .route("/schema/objects", get(routes::schema::list_objects))
        .route("/schema/object-statistics", get(routes::schema::list_object_statistics))
        .route("/schema/completion-objects", get(routes::schema::list_completion_objects))
        .route("/schema/completion-assistant", post(routes::schema::completion_assistant_search))
        .route("/schema/object-source", get(routes::schema::get_object_source))
        .route("/schema/columns", get(routes::schema::list_columns))
        .route("/schema/indexes", get(routes::schema::list_indexes))
        .route("/schema/foreign-keys", get(routes::schema::list_foreign_keys))
        .route("/schema/triggers", get(routes::schema::list_triggers))
        .route("/schema/functions", get(routes::schema::list_functions))
        .route("/schema/sequences", get(routes::schema::list_sequences))
        .route("/schema/rules", get(routes::schema::list_rules))
        .route("/schema/owners", get(routes::schema::list_owners))
        .route("/schema/ddl", get(routes::schema::get_ddl))
        .route("/schema-diff/prepare", post(routes::schema_diff::prepare_schema_diff))
        .route("/schema-diff/generate-sync-sql", post(routes::schema_diff::generate_schema_sync_sql))
        .route(
            "/schema/cache",
            post(routes::schema_cache::save_schema_cache).get(routes::schema_cache::load_schema_cache),
        )
        .route("/schema/cache-prefix", delete(routes::schema_cache::delete_schema_cache_prefix))
        .route(
            "/tab-runtime-cache",
            post(routes::tab_runtime_cache::save_tab_runtime_cache)
                .get(routes::tab_runtime_cache::load_tab_runtime_cache)
                .delete(routes::tab_runtime_cache::delete_tab_runtime_cache),
        )
        // Query
        .route("/query/execute", post(routes::query::execute_query))
        .route("/query/execute-multi", post(routes::query::execute_multi))
        .route("/query/execute-batch", post(routes::query::execute_batch))
        .route("/query/execute-script", post(routes::query::execute_script))
        .route("/query/execute-in-transaction", post(routes::query::execute_in_transaction))
        .route("/query/analyze-sql-references", post(routes::query::analyze_sql_references))
        .route("/query/find-statement-at-cursor", post(routes::query::find_statement_at_cursor))
        .route("/query/prepare-pagination-plan", post(routes::query::prepare_query_pagination_execution_plan))
        .route("/query/build-sorted-sql", post(routes::query::build_sorted_query_sql))
        .route("/query/build-explain-sql", post(routes::query::build_explain_sql))
        .route("/query/build-dropped-file-preview-sql", post(routes::query::build_dropped_file_preview_sql))
        .route("/query/get-explain-info", post(routes::query::get_explain_info))
        .route("/query/build-create-user-sql", post(routes::query::build_create_user_sql))
        .route("/query/build-table-select-sql", post(routes::query::build_table_select_sql))
        .route("/query/build-database-search-sql", post(routes::query::build_database_search_sql))
        .route("/query/build-search-result-where", post(routes::query::build_search_result_where))
        .route("/query/build-rename-object-sql", post(routes::query::build_rename_object_sql))
        .route("/query/build-create-database-sql", post(routes::query::build_create_database_sql))
        .route("/query/build-duckdb-attach-database-sql", post(routes::query::build_duckdb_attach_database_sql))
        .route("/query/build-drop-object-sql", post(routes::query::build_drop_object_sql))
        .route("/query/build-drop-table-sql", post(routes::query::build_drop_table_sql))
        .route("/query/build-drop-table-child-object-sql", post(routes::query::build_drop_table_child_object_sql))
        .route("/query/build-empty-table-sql", post(routes::query::build_empty_table_sql))
        .route("/query/build-truncate-table-sql", post(routes::query::build_truncate_table_sql))
        .route("/query/build-drop-database-sql", post(routes::query::build_drop_database_sql))
        .route("/query/build-create-schema-sql", post(routes::query::build_create_schema_sql))
        .route("/query/build-drop-schema-sql", post(routes::query::build_drop_schema_sql))
        .route("/query/build-duplicate-table-structure-sql", post(routes::query::build_duplicate_table_structure_sql))
        .route(
            "/query/build-executable-object-source-statements",
            post(routes::query::build_executable_object_source_statements),
        )
        .route("/query/build-executable-object-source-sql", post(routes::query::build_executable_object_source_sql))
        .route("/query/build-editable-object-source", post(routes::query::build_editable_object_source))
        .route(
            "/query/build-routine-rename-object-source-statements",
            post(routes::query::build_routine_rename_object_source_statements),
        )
        .route("/query/build-view-ddl-sql", post(routes::query::build_view_ddl_sql))
        .route("/query/build-table-structure-change-sql", post(routes::query::build_table_structure_change_sql))
        .route("/query/build-create-table-sql", post(routes::query::build_create_table_sql))
        .route("/query/build-single-column-alter-sql", post(routes::query::build_single_column_alter_sql))
        .route("/query/analyze-editability", post(routes::query::analyze_editable_query_editability))
        .route("/query/prepare-data-grid-save", post(routes::query::prepare_data_grid_save))
        .route(
            "/query/build-data-grid-copy-update-statements",
            post(routes::query::build_data_grid_copy_update_statements),
        )
        .route(
            "/query/build-data-grid-copy-insert-statement",
            post(routes::query::build_data_grid_copy_insert_statement),
        )
        .route(
            "/query/build-data-grid-context-filter-condition",
            post(routes::query::build_data_grid_context_filter_condition),
        )
        .route(
            "/query/build-data-grid-column-value-filter-condition",
            post(routes::query::build_data_grid_column_value_filter_condition),
        )
        .route("/query/build-data-grid-count-sql", post(routes::query::build_data_grid_count_sql))
        .route("/query/build-hive-table-properties-sql", post(routes::query::build_hive_table_properties_sql))
        .route("/query/build-export-insert-statements", post(routes::query::build_export_insert_statements))
        .route("/query/build-export-sql-insert", post(routes::query::build_export_sql_insert))
        .route("/query/build-database-sql-export", post(routes::query::build_database_sql_export))
        .route("/data-compare/prepare", post(routes::data_compare::prepare_data_compare))
        .route("/data-compare/prepare-from-tables", post(routes::data_compare::prepare_data_compare_from_tables))
        .route("/data-compare/prepare-missing-target", post(routes::data_compare::prepare_data_compare_missing_target))
        .route("/data-compare/build-sync-plan", post(routes::data_compare::build_data_compare_sync_plan))
        .route("/query/cancel", post(routes::query::cancel_query))
        .route("/query/close-session", post(routes::query::close_query_session))
        .route("/query/close-client-session", post(routes::query::close_client_connection_session))
        .route("/export/query-result-json", post(routes::text_export::export_query_result_json))
        .route("/export/query-result-markdown", post(routes::text_export::export_query_result_markdown))
        // Redis
        .route("/redis/list-databases", post(routes::redis::list_databases))
        .route("/redis/scan-keys", post(routes::redis::scan_keys))
        .route("/redis/scan-keys-batch", post(routes::redis::scan_keys_batch))
        .route("/redis/scan-values", post(routes::redis::scan_values))
        .route("/redis/get-value", post(routes::redis::get_value))
        .route("/redis/set-string", post(routes::redis::set_string))
        .route("/redis/delete-key", post(routes::redis::delete_key))
        .route("/redis/hash-set", post(routes::redis::hash_set))
        .route("/redis/hash-del", post(routes::redis::hash_del))
        .route("/redis/list-push", post(routes::redis::list_push))
        .route("/redis/list-set", post(routes::redis::list_set))
        .route("/redis/list-remove", post(routes::redis::list_remove))
        .route("/redis/set-add", post(routes::redis::set_add))
        .route("/redis/set-remove", post(routes::redis::set_remove))
        .route("/redis/zadd", post(routes::redis::zadd))
        .route("/redis/stream-add", post(routes::redis::stream_add))
        .route("/redis/json-set", post(routes::redis::json_set))
        .route("/redis/check-json-module", post(routes::redis::check_json_module))
        .route("/redis/delete-keys", post(routes::redis::delete_keys))
        .route("/redis/flush-db", post(routes::redis::flush_db))
        .route("/redis/execute-command", post(routes::redis::execute_command))
        .route("/redis/pubsub/publish", post(routes::redis::publish_message))
        .route("/redis/pubsub/ws", get(routes::redis_pubsub_ws::ws_handler))
        // Redis Slowlog
        .route("/redis/slowlog-get", post(routes::redis::slowlog_get))
        .route("/redis/cluster-master-nodes", post(routes::redis::cluster_master_nodes))
        // etcd
        .route("/etcd/list-prefix", post(routes::etcd::list_prefix))
        .route("/etcd/get", post(routes::etcd::get))
        .route("/etcd/put", post(routes::etcd::put))
        .route("/etcd/delete", post(routes::etcd::delete))
        // ZooKeeper
        .route("/zookeeper/list-prefix", post(routes::zookeeper::list_prefix))
        .route("/zookeeper/get", post(routes::zookeeper::get))
        .route("/zookeeper/put", post(routes::zookeeper::put))
        .route("/zookeeper/delete", post(routes::zookeeper::delete))
        // Nacos
        .route("/nacos/test-connection", post(routes::nacos::test_connection))
        .route("/nacos/namespaces/list", post(routes::nacos::list_namespaces))
        .route("/nacos/namespaces/create", post(routes::nacos::create_namespace))
        .route("/nacos/namespaces/update", post(routes::nacos::update_namespace))
        .route("/nacos/configs/list", post(routes::nacos::list_configs))
        .route("/nacos/configs/get", post(routes::nacos::get_config))
        .route("/nacos/configs/publish", post(routes::nacos::publish_config))
        .route("/nacos/configs/delete", post(routes::nacos::delete_config))
        .route("/nacos/configs/history/list", post(routes::nacos::list_config_history))
        .route("/nacos/configs/history/get", post(routes::nacos::get_config_history))
        .route("/nacos/configs/history/rollback", post(routes::nacos::rollback_config))
        .route("/nacos/services/list", post(routes::nacos::list_services))
        .route("/nacos/instances/list", post(routes::nacos::list_instances))
        .route("/nacos/instances/update", post(routes::nacos::update_instance))
        .route("/nacos/raw", post(routes::nacos::raw_request))
        // MongoDB
        .route("/mongo/list-databases", post(routes::mongo::list_databases))
        .route("/mongo/list-collections", post(routes::mongo::list_collections))
        .route("/mongo/create-database", post(routes::mongo::create_database))
        .route("/mongo/drop-database", post(routes::mongo::drop_database))
        .route("/mongo/drop-collection", post(routes::mongo::drop_collection))
        .route("/document-store/find-documents", post(routes::mongo::document_find_documents))
        .route("/mongo/find-documents", post(routes::mongo::find_documents))
        .route("/mongo/aggregate-documents", post(routes::mongo::aggregate_documents))
        .route("/mongo/insert-document", post(routes::mongo::insert_document))
        .route("/mongo/insert-documents", post(routes::mongo::insert_documents))
        .route("/mongo/update-document", post(routes::mongo::update_document))
        .route("/mongo/update-documents", post(routes::mongo::update_documents))
        .route("/mongo/delete-document", post(routes::mongo::delete_document))
        .route("/mongo/delete-documents", post(routes::mongo::delete_documents))
        // History
        .route("/history", get(routes::history::load_history).delete(routes::history::clear_history))
        .route("/history/save", post(routes::history::save_history))
        .route("/history/{id}", delete(routes::history::delete_history_entry))
        // Saved SQL
        .route(
            "/saved-sql",
            get(routes::saved_sql::load_saved_sql_library).post(routes::saved_sql::save_saved_sql_file),
        )
        .route("/saved-sql/{id}", delete(routes::saved_sql::delete_saved_sql_file))
        .route("/saved-sql/folders", post(routes::saved_sql::save_saved_sql_folder))
        .route("/saved-sql/folders/{id}", delete(routes::saved_sql::delete_saved_sql_folder))
        // AI
        .route("/ai/config", post(routes::ai::save_ai_config).get(routes::ai::load_ai_config))
        .route("/ai/conversation", post(routes::ai::save_ai_conversation))
        .route("/ai/conversations", get(routes::ai::load_ai_conversations))
        .route("/ai/conversation/{id}", delete(routes::ai::delete_ai_conversation))
        .route("/ai/complete", post(routes::ai::ai_complete))
        .route("/ai/stream", post(routes::ai::ai_stream))
        .route("/ai/agent-stream", post(routes::ai::ai_agent_stream))
        .route("/ai/cancel-stream", post(routes::ai::ai_cancel_stream))
        .route("/ai/test-connection", post(routes::ai::ai_test_connection))
        .route("/ai/models", post(routes::ai::ai_list_models))
        // Transfer
        .route("/transfer/start", post(routes::transfer::start_transfer))
        .route("/transfer/progress/{transferId}", get(routes::transfer::transfer_progress))
        .route("/transfer/cancel", post(routes::transfer::cancel_transfer))
        .route("/transfer/sort-tables-by-fk", post(routes::transfer::sort_tables_by_fk_dependency))
        // Database export
        .route("/export/database", post(routes::database_export::start_database_export))
        .route("/export/database/progress/{exportId}", get(routes::database_export::database_export_progress))
        .route("/export/database/cancel", post(routes::database_export::cancel_database_export))
        .route("/export/database/download/{exportId}", get(routes::database_export::database_export_download))
        // Table export
        .route("/export/table", post(routes::table_export::start_table_export))
        .route("/export/table/progress/{exportId}", get(routes::table_export::table_export_progress))
        .route("/export/table/download/{exportId}", get(routes::table_export::table_export_download))
        .route("/export/table/cancel", post(routes::table_export::cancel_table_export))
        // Query result export
        .route("/export/query-result", post(routes::query_result_export::start_query_result_export))
        .route(
            "/export/query-result/progress/{exportId}",
            get(routes::query_result_export::query_result_export_progress),
        )
        .route(
            "/export/query-result/download/{exportId}",
            get(routes::query_result_export::query_result_export_download),
        )
        .route("/export/query-result/cancel", post(routes::query_result_export::cancel_query_result_export))
        // SQL file
        .route("/sql-file/preview", post(routes::sql_file::preview_sql_file))
        .route("/sql-file/execute", post(routes::sql_file::execute_sql_file))
        .route("/sql-file/progress/{executionId}", get(routes::sql_file::sql_file_progress))
        .route("/sql-file/cancel", post(routes::sql_file::cancel_sql_file))
        // Table import
        .route("/import/preview", post(routes::table_import::preview_import))
        .route("/import/execute", post(routes::table_import::execute_import))
        .route("/import/progress/{importId}", get(routes::table_import::import_progress))
        .route("/import/cancel", post(routes::table_import::cancel_import))
        // Update
        .route("/version", get(routes::update::get_version))
        .route("/update/check", get(routes::update::check_for_updates))
        // Layout
        .route("/layout/sidebar", post(routes::layout::save_sidebar_layout).get(routes::layout::load_sidebar_layout))
        // App settings
        .route(
            "/app-settings/pinned-tree-node-ids",
            get(routes::app_settings::load_pinned_tree_node_ids).post(routes::app_settings::save_pinned_tree_node_ids),
        )
        .route("/app-settings/config/decrypt", post(routes::app_settings::decrypt_config))
        // Cloud sync
        .route("/cloud-sync/webdav/test", post(routes::cloud_sync::webdav_sync_test))
        .route("/cloud-sync/webdav/password-status", post(routes::cloud_sync::webdav_password_status))
        .route("/cloud-sync/webdav/save-password", post(routes::cloud_sync::save_webdav_saved_password))
        .route("/cloud-sync/webdav/forget-password", post(routes::cloud_sync::forget_webdav_saved_password))
        .route("/cloud-sync/webdav/upload", post(routes::cloud_sync::webdav_sync_upload))
        .route("/cloud-sync/webdav/download", post(routes::cloud_sync::webdav_sync_download));

    let api = add_mq_routes(api)
        .layer(middleware::from_fn_with_state(web_state.clone(), auth::auth_middleware))
        .with_state(web_state.clone());

    // Build app
    let mut app = Router::new()
        .nest("/api", api)
        .layer(DefaultBodyLimit::max(web_body_limit_bytes()))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(cors);

    // Static file serving
    if let Ok(static_dir) = std::env::var("DBX_STATIC_DIR") {
        use tower_http::services::{ServeDir, ServeFile};
        let index_path = format!("{}/index.html", static_dir);
        let serve_dir = ServeDir::new(&static_dir).not_found_service(ServeFile::new(&index_path));
        app = app.fallback_service(serve_dir);
    }

    // Bind address
    let port: u16 = std::env::var("DBX_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4224);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    tracing::info!("DBX Web server starting on http://{}", addr);
    if password_disabled {
        tracing::info!("Password protection is disabled");
    } else if std::env::var("DBX_PASSWORD").is_ok() {
        tracing::info!("Password protection is enabled");
    }

    let listener = tokio::net::TcpListener::bind(addr).await.expect("Failed to bind address");
    axum::serve(listener, app).await.expect("Server error");
}
