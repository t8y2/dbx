mod commands;
mod db;
mod models;

use commands::connection::AppState;
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            commands::ai::save_ai_config,
            commands::ai::load_ai_config,
            commands::connection::test_connection,
            commands::connection::connect_db,
            commands::connection::disconnect_db,
            commands::connection::save_connections,
            commands::connection::load_connections,
            commands::schema::list_databases,
            commands::schema::list_tables,
            commands::schema::list_schemas,
            commands::schema::get_columns,
            commands::schema::list_indexes,
            commands::schema::list_foreign_keys,
            commands::schema::list_triggers,
            commands::query::execute_query,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
