mod commands;
mod db;
mod models;

use commands::connection::AppState;
use std::sync::Arc;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    let state = Arc::new(AppState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let app_handle = app.handle().clone();
            let state: tauri::State<Arc<AppState>> = app.state();
            commands::mcp_bridge::start(app_handle, state.inner().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::ai::ai_complete,
            commands::ai::ai_stream,
            commands::ai::ai_cancel_stream,
            commands::ai::ai_test_connection,
            commands::ai::save_ai_config,
            commands::ai::load_ai_config,
            commands::ai::save_ai_conversation,
            commands::ai::load_ai_conversations,
            commands::ai::delete_ai_conversation,
            commands::connection::test_connection,
            commands::connection::connect_db,
            commands::connection::disconnect_db,
            commands::connection::save_connections,
            commands::connection::load_connections,
            commands::connection::save_sidebar_layout,
            commands::connection::load_sidebar_layout,
            commands::schema::list_databases,
            commands::schema::list_tables,
            commands::schema::list_schemas,
            commands::schema::get_columns,
            commands::schema::list_indexes,
            commands::schema::list_foreign_keys,
            commands::schema::list_triggers,
            commands::schema::get_table_ddl,
            commands::query::execute_query,
            commands::query::execute_multi,
            commands::query::cancel_query,
            commands::query::execute_batch,
            commands::query::execute_script,
            commands::sql_file::preview_sql_file,
            commands::sql_file::execute_sql_file,
            commands::sql_file::cancel_sql_file_execution,
            commands::table_import::preview_table_import_file,
            commands::table_import::import_table_file,
            commands::table_import::cancel_table_import,
            commands::redis_cmd::redis_list_databases,
            commands::redis_cmd::redis_scan_keys,
            commands::redis_cmd::redis_get_value,
            commands::redis_cmd::redis_set_string,
            commands::redis_cmd::redis_delete_key,
            commands::redis_cmd::redis_hash_set,
            commands::redis_cmd::redis_hash_del,
            commands::redis_cmd::redis_list_push,
            commands::redis_cmd::redis_list_remove,
            commands::redis_cmd::redis_set_add,
            commands::redis_cmd::redis_set_remove,
            commands::mongo_cmd::mongo_list_databases,
            commands::mongo_cmd::mongo_list_collections,
            commands::mongo_cmd::mongo_find_documents,
            commands::mongo_cmd::mongo_insert_document,
            commands::mongo_cmd::mongo_update_document,
            commands::mongo_cmd::mongo_delete_document,
            commands::history::save_history,
            commands::history::load_history,
            commands::history::clear_history,
            commands::history::delete_history_entry,
            commands::update::check_for_updates,
            commands::transfer::start_transfer,
            commands::transfer::cancel_transfer,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { has_visible_windows, .. } = &event {
                if !has_visible_windows {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        });
}
