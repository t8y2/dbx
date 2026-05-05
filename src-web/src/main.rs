mod auth;
mod error;
mod routes;
mod sse;
mod state;

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;

use axum::middleware;
use axum::routing::{delete, get, post};
use axum::Router;
use dbx_core::connection::AppState;
use dbx_core::storage::Storage;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

use state::WebState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "dbx_web=info,tower_http=info".parse().unwrap()),
        )
        .init();

    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    // Data directory
    let data_dir = std::env::var("DBX_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            std::path::PathBuf::from(home).join(".dbx-web")
        });
    std::fs::create_dir_all(&data_dir).expect("Failed to create data directory");

    let app_state = {
        let db_path = data_dir.join("dbx.db");
        let storage = Storage::open(&db_path)
            .await
            .expect("Failed to open storage");
        storage
            .migrate_from_json(&data_dir)
            .await
            .expect("Failed to migrate JSON data");
        Arc::new(AppState::new(storage))
    };

    // Password hash
    let password_hash = std::env::var("DBX_PASSWORD").ok().map(|pw| {
        let mut hasher = Sha256::new();
        hasher.update(pw.as_bytes());
        hex::encode(hasher.finalize())
    });

    let web_state = Arc::new(WebState {
        app: app_state,
        data_dir,
        password_hash,
        sessions: RwLock::new(HashSet::new()),
        sse_channels: RwLock::new(HashMap::new()),
        login_rate_limit: tokio::sync::Mutex::new(state::LoginRateLimit {
            fail_count: 0,
            locked_until: None,
        }),
    });

    // CORS
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // API routes
    let api = Router::new()
        // Auth
        .route("/auth/login", post(auth::login))
        .route("/auth/check", get(auth::check))
        .route("/auth/logout", post(auth::logout))
        // Connection
        .route("/connection/test", post(routes::connection::test_connection))
        .route("/connection/connect", post(routes::connection::connect_db))
        .route("/connection/disconnect", post(routes::connection::disconnect_db))
        .route("/connection/save", post(routes::connection::save_connections))
        .route("/connection/list", get(routes::connection::load_connections))
        // Schema
        .route("/schema/databases", get(routes::schema::list_databases))
        .route("/schema/schemas", get(routes::schema::list_schemas))
        .route("/schema/tables", get(routes::schema::list_tables))
        .route("/schema/columns", get(routes::schema::list_columns))
        .route("/schema/indexes", get(routes::schema::list_indexes))
        .route("/schema/foreign-keys", get(routes::schema::list_foreign_keys))
        .route("/schema/triggers", get(routes::schema::list_triggers))
        .route("/schema/ddl", get(routes::schema::get_ddl))
        // Query
        .route("/query/execute", post(routes::query::execute_query))
        .route("/query/execute-multi", post(routes::query::execute_multi))
        .route("/query/execute-batch", post(routes::query::execute_batch))
        .route("/query/execute-script", post(routes::query::execute_script))
        .route("/query/cancel", post(routes::query::cancel_query))
        // Redis
        .route("/redis/list-databases", post(routes::redis::list_databases))
        .route("/redis/scan-keys", post(routes::redis::scan_keys))
        .route("/redis/get-value", post(routes::redis::get_value))
        .route("/redis/set-string", post(routes::redis::set_string))
        .route("/redis/delete-key", post(routes::redis::delete_key))
        .route("/redis/hash-set", post(routes::redis::hash_set))
        .route("/redis/hash-del", post(routes::redis::hash_del))
        .route("/redis/list-push", post(routes::redis::list_push))
        .route("/redis/list-remove", post(routes::redis::list_remove))
        .route("/redis/set-add", post(routes::redis::set_add))
        .route("/redis/set-remove", post(routes::redis::set_remove))
        // MongoDB
        .route("/mongo/list-databases", post(routes::mongo::list_databases))
        .route("/mongo/list-collections", post(routes::mongo::list_collections))
        .route("/mongo/find-documents", post(routes::mongo::find_documents))
        .route("/mongo/insert-document", post(routes::mongo::insert_document))
        .route("/mongo/update-document", post(routes::mongo::update_document))
        .route("/mongo/delete-document", post(routes::mongo::delete_document))
        // History
        .route("/history", get(routes::history::load_history).delete(routes::history::clear_history))
        .route("/history/save", post(routes::history::save_history))
        .route("/history/{id}", delete(routes::history::delete_history_entry))
        // AI
        .route("/ai/config", post(routes::ai::save_ai_config).get(routes::ai::load_ai_config))
        .route("/ai/conversation", post(routes::ai::save_ai_conversation))
        .route("/ai/conversations", get(routes::ai::load_ai_conversations))
        .route("/ai/conversation/{id}", delete(routes::ai::delete_ai_conversation))
        .route("/ai/complete", post(routes::ai::ai_complete))
        .route("/ai/stream", post(routes::ai::ai_stream))
        .route("/ai/cancel-stream", post(routes::ai::ai_cancel_stream))
        .route("/ai/test-connection", post(routes::ai::ai_test_connection))
        // Transfer
        .route("/transfer/start", post(routes::transfer::start_transfer))
        .route("/transfer/progress/{transferId}", get(routes::transfer::transfer_progress))
        .route("/transfer/cancel", post(routes::transfer::cancel_transfer))
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
        .route("/update/check", get(routes::update::check_for_updates))
        // Layout
        .route("/layout/sidebar", post(routes::layout::save_sidebar_layout).get(routes::layout::load_sidebar_layout))
        .layer(middleware::from_fn_with_state(web_state.clone(), auth::auth_middleware))
        .with_state(web_state.clone());

    // Build app
    let mut app = Router::new()
        .nest("/api", api)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(cors);

    // Static file serving
    if let Ok(static_dir) = std::env::var("DBX_STATIC_DIR") {
        use tower_http::services::{ServeDir, ServeFile};
        let index_path = format!("{}/index.html", static_dir);
        let serve_dir = ServeDir::new(&static_dir)
            .not_found_service(ServeFile::new(&index_path));
        app = app.fallback_service(serve_dir);
    }

    // Bind address
    let port: u16 = std::env::var("DBX_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4224);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    tracing::info!("DBX Web server starting on http://{}", addr);
    if std::env::var("DBX_PASSWORD").is_ok() {
        tracing::info!("Password protection is enabled");
    }

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind address");
    axum::serve(listener, app)
        .await
        .expect("Server error");
}
