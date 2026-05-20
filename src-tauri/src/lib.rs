mod commands;
mod data_dir;
mod db;
mod models;
mod window_state_guard;

use commands::connection::AppState;
use dbx_core::storage::Storage;
use std::sync::Arc;
use std::time::Instant;
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri::{Emitter, Manager, RunEvent};
#[cfg(any(windows, target_os = "linux"))]
use tauri_plugin_deep_link::DeepLinkExt;

fn should_hide_window_on_close(target_os: &str) -> bool {
    matches!(target_os, "macos" | "windows")
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn open_connection_deep_links(app: &tauri::AppHandle, links: Vec<String>) {
    if links.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<commands::deep_link::DeepLinkOpenState>() {
        state.push(links.clone());
    }
    let _ = app.emit("dbx-open-connection-links", links);
    show_main_window(app);
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn setup_windows_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app).text("show", "Show DBX").separator().text("quit", "Quit DBX").build()?;
    let mut tray = TrayIconBuilder::with_id("main-tray").tooltip("DBX").menu(&menu).show_menu_on_left_click(false);

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.on_menu_event(|app, event| {
        if event.id() == "show" {
            show_main_window(app);
        } else if event.id() == "quit" {
            app.exit(0);
        }
    })
    .on_tray_icon_event(|tray, event| match event {
        TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }
        | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => show_main_window(tray.app_handle()),
        _ => {}
    })
    .build(app)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::should_hide_window_on_close;

    #[test]
    fn hides_window_on_close_for_windows_and_macos() {
        assert!(should_hide_window_on_close("windows"));
        assert!(should_hide_window_on_close("macos"));
    }

    #[test]
    fn does_not_hide_window_on_close_for_other_platforms() {
        assert!(!should_hide_window_on_close("linux"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    rustls::crypto::aws_lc_rs::default_provider().install_default().expect("Failed to install rustls crypto provider");

    let startup_begin = Instant::now();

    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let links = commands::deep_link::connection_deep_links_from_args(args.clone());
            open_connection_deep_links(app, links);

            let paths = commands::external_sql::sql_file_paths_from_args(args, std::path::Path::new(&cwd));
            if !paths.is_empty() {
                if let Some(state) = app.try_state::<commands::external_sql::ExternalSqlOpenState>() {
                    state.push(paths.clone());
                }
                let _ = app.emit("dbx-open-sql-files", paths);
            }
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
            let setup_start = Instant::now();
            eprintln!("[STARTUP] plugins registered in {:?}", startup_begin.elapsed());

            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }

            let default_data_dir =
                app.path().app_data_dir().map_err(|e| e.to_string()).expect("Failed to resolve app data dir");
            let data_dir = data_dir::resolve_data_dir(default_data_dir);
            std::fs::create_dir_all(&data_dir).expect("Failed to create data dir");
            let db_path = data_dir.join("dbx.db");

            let t = Instant::now();
            let storage = tauri::async_runtime::block_on(async {
                let s = Storage::open(&db_path).await.expect("Failed to open storage");
                eprintln!("[STARTUP]   Storage::open in {:?}", t.elapsed());
                let t2 = Instant::now();
                s.migrate_from_json(&data_dir).await.expect("Failed to migrate JSON data");
                eprintln!("[STARTUP]   migrate_from_json in {:?}", t2.elapsed());
                s
            });
            eprintln!("[STARTUP] storage ready in {:?}", t.elapsed());

            let state = Arc::new(AppState::new_with_plugin_dir_and_app_version(
                storage,
                data_dir.join("plugins"),
                env!("CARGO_PKG_VERSION"),
            ));
            app.manage(state.clone());
            app.manage(commands::external_sql::ExternalSqlOpenState::default());
            app.manage(commands::deep_link::DeepLinkOpenState::default());
            let startup_links = commands::deep_link::connection_deep_links_from_args(std::env::args().skip(1));
            open_connection_deep_links(app.handle(), startup_links);

            let app_handle = app.handle().clone();
            commands::mcp_bridge::start(app_handle, state);
            eprintln!("[STARTUP] setup complete in {:?} (total {:?})", setup_start.elapsed(), startup_begin.elapsed());

            #[cfg(not(target_os = "macos"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }
            #[cfg(target_os = "windows")]
            setup_windows_tray(app)?;
            window_state_guard::enforce_main_window_bounds(app.handle());
            #[cfg(any(windows, target_os = "linux"))]
            let _ = app.deep_link().register_all();

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if should_hide_window_on_close(std::env::consts::OS) {
                    let _ = window.hide();
                    api.prevent_close();
                }
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
            commands::plugins::list_plugins,
            commands::plugins::list_jdbc_drivers,
            commands::plugins::import_jdbc_drivers,
            commands::plugins::delete_jdbc_driver,
            commands::plugins::jdbc_plugin_status,
            commands::plugins::install_jdbc_plugin,
            commands::plugins::install_jdbc_plugin_local,
            commands::plugins::uninstall_jdbc_plugin,
            commands::schema::list_databases,
            commands::schema::list_tables,
            commands::schema::list_objects,
            commands::schema::get_object_source,
            commands::schema::list_schemas,
            commands::schema::get_columns,
            commands::schema::list_indexes,
            commands::schema::list_foreign_keys,
            commands::schema::list_triggers,
            commands::schema::get_table_ddl,
            commands::schema_cache::save_schema_cache,
            commands::schema_cache::load_schema_cache,
            commands::schema_cache::delete_schema_cache_prefix,
            commands::query::execute_query,
            commands::query::execute_multi,
            commands::query::cancel_query,
            commands::query::close_query_session,
            commands::query::execute_batch,
            commands::query::execute_script,
            commands::query::execute_in_transaction,
            commands::sql_file::preview_sql_file,
            commands::sql_file::execute_sql_file,
            commands::sql_file::cancel_sql_file_execution,
            commands::external_sql::pending_open_sql_files,
            commands::external_sql::read_external_sql_file,
            commands::deep_link::pending_open_connection_links,
            commands::table_import::preview_table_import_file,
            commands::table_import::import_table_file,
            commands::table_import::cancel_table_import,
            commands::redis_cmd::redis_list_databases,
            commands::redis_cmd::redis_scan_keys,
            commands::redis_cmd::redis_scan_values,
            commands::redis_cmd::redis_get_value,
            commands::redis_cmd::redis_set_string,
            commands::redis_cmd::redis_delete_key,
            commands::redis_cmd::redis_hash_set,
            commands::redis_cmd::redis_hash_del,
            commands::redis_cmd::redis_list_push,
            commands::redis_cmd::redis_list_set,
            commands::redis_cmd::redis_list_remove,
            commands::redis_cmd::redis_set_add,
            commands::redis_cmd::redis_set_remove,
            commands::redis_cmd::redis_zadd,
            commands::redis_cmd::redis_zrem,
            commands::redis_cmd::redis_set_ttl,
            commands::redis_cmd::redis_delete_keys,
            commands::redis_cmd::redis_flush_db,
            commands::redis_cmd::redis_execute_command,
            commands::redis_cmd::redis_load_more,
            commands::saved_sql::load_saved_sql_library,
            commands::saved_sql::save_saved_sql_folder,
            commands::saved_sql::delete_saved_sql_folder,
            commands::saved_sql::save_saved_sql_file,
            commands::saved_sql::delete_saved_sql_file,
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
            commands::database_export::export_database_sql,
            commands::database_export::cancel_database_export,
            commands::agents::list_installed_agents,
            commands::agents::list_installed_agents_local,
            commands::agents::install_agent,
            commands::agents::upgrade_all_agents,
            commands::agents::uninstall_agent,
            commands::agents::check_jre_installed,
            commands::agents::get_agent_java_runtime_config,
            commands::agents::set_agent_java_runtime_config,
            commands::agents::uninstall_jre,
            commands::agents::reinstall_jre,
            commands::agents::invalidate_agent_registry_cache,
            commands::agents::import_agents_from_zip,
            commands::agents::import_agent_jar_cmd,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Opened { urls } = &event {
                let links: Vec<String> = urls
                    .iter()
                    .map(|url| url.to_string())
                    .filter_map(|url| commands::deep_link::connection_deep_link_from_arg(&url))
                    .collect();
                open_connection_deep_links(app_handle, links);

                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter(|path| commands::external_sql::is_sql_file_path(path))
                    .map(|path| path.to_string_lossy().to_string())
                    .collect();
                if !paths.is_empty() {
                    if let Some(state) = app_handle.try_state::<commands::external_sql::ExternalSqlOpenState>() {
                        state.push(paths.clone());
                    }
                    let _ = app_handle.emit("dbx-open-sql-files", paths);
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }

            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { has_visible_windows, .. } = &event {
                if !has_visible_windows {
                    show_main_window(app_handle);
                }
            }
        });
}
