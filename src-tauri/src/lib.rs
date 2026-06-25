mod commands;
mod data_dir;
mod db;
mod models;
mod window_state_guard;

use commands::connection::AppState;
use dbx_core::storage::{DesktopIconTheme, DesktopSettings, Storage};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::RunEvent;
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri::{Emitter, Manager};
#[cfg(any(windows, target_os = "linux"))]
use tauri_plugin_deep_link::DeepLinkExt;

const DESKTOP_TRAY_ID: &str = "main-tray";

pub struct CloseBehaviorState {
    quit_on_close: AtomicBool,
    prompted: AtomicBool,
}

impl CloseBehaviorState {
    fn new(settings: &DesktopSettings) -> Self {
        Self {
            quit_on_close: AtomicBool::new(settings.quit_on_close),
            prompted: AtomicBool::new(settings.close_action_prompted),
        }
    }

    fn apply(&self, settings: &DesktopSettings) {
        self.quit_on_close.store(settings.quit_on_close, Ordering::Relaxed);
        self.prompted.store(settings.close_action_prompted, Ordering::Relaxed);
    }

    fn quit_on_close(&self) -> bool {
        self.quit_on_close.load(Ordering::Relaxed)
    }

    fn prompted(&self) -> bool {
        self.prompted.load(Ordering::Relaxed)
    }
}
#[cfg(target_os = "macos")]
const MACOS_TRAY_ICON: tauri::image::Image<'_> = tauri::include_image!("icons/tray-macos-template.png");
const BLACK_APP_ICON: tauri::image::Image<'_> = tauri::include_image!("icons/icon-black.png");

pub(crate) fn apply_debug_log_level(debug_logging_enabled: bool) {
    log::set_max_level(if debug_logging_enabled { log::LevelFilter::Debug } else { log::LevelFilter::Off });
}

fn should_hide_window_on_close(target_os: &str) -> bool {
    matches!(target_os, "macos" | "windows")
}

fn should_setup_desktop_tray(target_os: &str, show_tray_icon: bool) -> bool {
    show_tray_icon && matches!(target_os, "macos" | "windows")
}

fn should_show_main_window_after_setup() -> bool {
    true
}

fn native_window_decorations_override(target_os: &str) -> Option<bool> {
    match target_os {
        "windows" => Some(false),
        "linux" => Some(true),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn apply_linux_webkit_rendering_workarounds() {
    const DISABLE_DMABUF_RENDERER: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if std::env::var_os(DISABLE_DMABUF_RENDERER).is_none() {
        // WebKitGTK's DMABUF renderer can produce a blank AppImage window on
        // Fedora/Wayland/NVIDIA systems. This must be set before WebKit starts.
        std::env::set_var(DISABLE_DMABUF_RENDERER, "1");
    }
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
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

#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
fn setup_desktop_tray<R: tauri::Runtime, M: Manager<R>>(
    manager: &M,
    _icon_theme: DesktopIconTheme,
) -> tauri::Result<()> {
    let menu = MenuBuilder::new(manager).text("show", "Show DBX").separator().text("quit", "Quit DBX").build()?;
    let mut tray =
        TrayIconBuilder::<R>::with_id(DESKTOP_TRAY_ID).tooltip("DBX").menu(&menu).show_menu_on_left_click(false);
    #[cfg(target_os = "macos")]
    {
        tray = tray.icon(MACOS_TRAY_ICON).icon_as_template(true);
    }
    #[cfg(target_os = "windows")]
    {
        let icon = match _icon_theme {
            DesktopIconTheme::Default => manager.app_handle().default_window_icon().cloned(),
            DesktopIconTheme::Black => Some(BLACK_APP_ICON),
        };
        if let Some(icon) = icon {
            tray = tray.icon(icon);
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(icon) = manager.app_handle().default_window_icon().cloned() {
            tray = tray.icon(icon);
        }
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
    .build(manager)?;

    Ok(())
}

fn apply_desktop_icon_theme(app: &tauri::AppHandle, icon_theme: DesktopIconTheme) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        match icon_theme {
            DesktopIconTheme::Default => {
                if let Some(icon) = app.default_window_icon().cloned() {
                    window.set_icon(icon)?;
                }
            }
            DesktopIconTheme::Black => window.set_icon(BLACK_APP_ICON)?,
        }
    }
    Ok(())
}

fn apply_desktop_tray_icon_theme(app: &tauri::AppHandle, icon_theme: DesktopIconTheme) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(DESKTOP_TRAY_ID) {
        #[cfg(target_os = "windows")]
        {
            let icon = match icon_theme {
                DesktopIconTheme::Default => app.default_window_icon().cloned(),
                DesktopIconTheme::Black => Some(BLACK_APP_ICON),
            };
            tray.set_icon(icon)?;
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (tray, icon_theme);
        }
    }
    Ok(())
}

pub(crate) fn apply_desktop_settings(app: &tauri::AppHandle, desktop_settings: &DesktopSettings) -> tauri::Result<()> {
    apply_debug_log_level(desktop_settings.debug_logging_enabled);
    if let Some(state) = app.try_state::<CloseBehaviorState>() {
        state.apply(desktop_settings);
    }
    apply_desktop_icon_theme(app, desktop_settings.icon_theme)?;
    if matches!(std::env::consts::OS, "macos" | "windows") {
        if let Some(tray) = app.tray_by_id(DESKTOP_TRAY_ID) {
            tray.set_visible(desktop_settings.show_tray_icon)?;
            apply_desktop_tray_icon_theme(app, desktop_settings.icon_theme)?;
        } else if desktop_settings.show_tray_icon {
            setup_desktop_tray(app, desktop_settings.icon_theme)?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::{
        native_window_decorations_override, should_hide_window_on_close, should_setup_desktop_tray,
        should_show_main_window_after_setup,
    };

    #[test]
    fn hides_window_on_close_for_windows_and_macos() {
        assert!(should_hide_window_on_close("windows"));
        assert!(should_hide_window_on_close("macos"));
    }

    #[test]
    fn does_not_hide_window_on_close_for_other_platforms() {
        assert!(!should_hide_window_on_close("linux"));
    }

    #[test]
    fn sets_up_desktop_tray_for_windows_and_macos() {
        assert!(should_setup_desktop_tray("windows", true));
        assert!(should_setup_desktop_tray("macos", true));
        assert!(!should_setup_desktop_tray("windows", false));
        assert!(!should_setup_desktop_tray("macos", false));
        assert!(!should_setup_desktop_tray("linux", true));
    }

    #[test]
    fn shows_main_window_after_regular_startup_setup() {
        assert!(should_show_main_window_after_setup());
    }

    #[test]
    fn overrides_native_window_decorations_for_desktop_platforms() {
        assert_eq!(native_window_decorations_override("windows"), Some(false));
        assert_eq!(native_window_decorations_override("linux"), Some(true));
        assert_eq!(native_window_decorations_override("macos"), None);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    rustls::crypto::aws_lc_rs::default_provider().install_default().expect("Failed to install rustls crypto provider");
    #[cfg(target_os = "linux")]
    apply_linux_webkit_rendering_workarounds();

    let startup_begin = Instant::now();

    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let links = commands::deep_link::connection_deep_links_from_args(args.clone());
            open_connection_deep_links(app, links);

            let paths = commands::external_sql::sql_file_paths_from_args(args.clone(), std::path::Path::new(&cwd));
            if !paths.is_empty() {
                if let Some(state) = app.try_state::<commands::external_sql::ExternalSqlOpenState>() {
                    state.push(paths.clone());
                }
                let _ = app.emit("dbx-open-sql-files", paths);
            }

            let db_paths = commands::external_db::db_file_paths_from_args(args, std::path::Path::new(&cwd));
            if !db_paths.is_empty() {
                if let Some(state) = app.try_state::<commands::external_db::ExternalDbOpenState>() {
                    state.push(db_paths.clone());
                }
                let _ = app.emit("dbx-open-db-files", db_paths);
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
            let desktop_settings = tauri::async_runtime::block_on(storage.load_desktop_settings()).unwrap_or_default();
            app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Debug).build())?;
            apply_debug_log_level(desktop_settings.debug_logging_enabled);
            eprintln!("[STARTUP] storage ready in {:?}", t.elapsed());

            let default_agent_dir = data_dir::uses_custom_data_dir().then(|| data_dir.join("agents"));
            let (plugin_dir, agent_dir) = commands::app_settings::resolve_driver_store_dirs_from_settings(
                &desktop_settings,
                &data_dir,
                default_agent_dir,
            );

            let state = if let Some(agent_dir) = agent_dir {
                Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
                    storage,
                    plugin_dir,
                    agent_dir,
                    env!("CARGO_PKG_VERSION"),
                ))
            } else {
                Arc::new(AppState::new_with_plugin_dir_and_app_version(storage, plugin_dir, env!("CARGO_PKG_VERSION")))
            };
            app.manage(state.clone());
            commands::redis_pubsub_server::start_pubsub_server(state.clone());
            app.manage(commands::saved_sql::SavedSqlStorageState { data_dir: data_dir.clone() });
            app.manage(commands::external_sql::ExternalSqlOpenState::default());
            app.manage(commands::external_db::ExternalDbOpenState::default());
            app.manage(commands::deep_link::DeepLinkOpenState::default());
            app.manage(CloseBehaviorState::new(&desktop_settings));
            let startup_links = commands::deep_link::connection_deep_links_from_args(std::env::args().skip(1));
            open_connection_deep_links(app.handle(), startup_links);

            let app_handle = app.handle().clone();
            commands::mcp_bridge::start(app_handle, state);
            eprintln!("[STARTUP] setup complete in {:?} (total {:?})", setup_start.elapsed(), startup_begin.elapsed());

            if let Some(decorations) = native_window_decorations_override(std::env::consts::OS) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(decorations);
                }
            }
            if should_setup_desktop_tray(std::env::consts::OS, desktop_settings.show_tray_icon) {
                setup_desktop_tray(app, desktop_settings.icon_theme)?;
            }
            apply_desktop_icon_theme(app.handle(), desktop_settings.icon_theme)?;
            window_state_guard::enforce_main_window_bounds(app.handle());
            if should_show_main_window_after_setup() {
                show_main_window(app.handle());
            }
            #[cfg(any(windows, target_os = "linux"))]
            let _ = app.deep_link().register_all();

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !should_hide_window_on_close(std::env::consts::OS) {
                    return;
                }
                let app = window.app_handle();
                let Some(state) = app.try_state::<CloseBehaviorState>() else {
                    let _ = window.hide();
                    api.prevent_close();
                    return;
                };
                if !state.prompted() {
                    api.prevent_close();
                    let _ = app.emit("dbx-close-action-prompt", ());
                    return;
                }
                if state.quit_on_close() {
                    app.exit(0);
                    return;
                }
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::ai::ai_complete,
            commands::ai::ai_stream,
            commands::ai::ai_agent_stream,
            commands::ai::ai_cancel_stream,
            commands::ai::ai_test_connection,
            commands::ai::ai_list_models,
            commands::ai::save_ai_config,
            commands::ai::load_ai_config,
            commands::ai::save_ai_conversation,
            commands::ai::load_ai_conversations,
            commands::ai::delete_ai_conversation,
            commands::app_settings::load_desktop_settings,
            commands::app_settings::save_desktop_settings,
            commands::app_settings::set_driver_store_dir,
            commands::app_settings::set_plugin_store_dir,
            commands::app_settings::set_agent_store_dir,
            commands::app_settings::get_driver_store_path,
            commands::app_settings::load_pinned_tree_node_ids,
            commands::app_settings::save_pinned_tree_node_ids,
            commands::app_settings::load_native_debug_logs,
            commands::cloud_sync::webdav_sync_test,
            commands::cloud_sync::webdav_password_status,
            commands::cloud_sync::save_webdav_saved_password,
            commands::cloud_sync::forget_webdav_saved_password,
            commands::cloud_sync::webdav_sync_upload,
            commands::cloud_sync::webdav_sync_download,
            commands::connection::test_connection,
            commands::connection::connect_db,
            commands::connection::connection_final_proxy_port,
            commands::connection::disconnect_db,
            commands::connection::close_database_connection,
            commands::connection::refresh_connections,
            commands::connection::check_connection_health,
            commands::connection::save_connections,
            commands::connection::load_connections,
            commands::connection::save_sidebar_layout,
            commands::connection::load_sidebar_layout,
            commands::plugins::list_plugins,
            commands::plugins::list_jdbc_drivers,
            commands::plugins::list_jdbc_maven_bundles,
            commands::plugins::import_jdbc_drivers,
            commands::plugins::install_jdbc_driver_from_maven,
            commands::plugins::install_prestosql_jdbc_driver,
            commands::plugins::delete_jdbc_driver,
            commands::plugins::delete_jdbc_maven_bundle,
            commands::plugins::jdbc_plugin_status,
            commands::plugins::install_jdbc_plugin,
            commands::plugins::install_jdbc_plugin_local,
            commands::plugins::uninstall_jdbc_plugin,
            commands::schema::list_databases,
            commands::schema::list_sqlserver_linked_servers,
            commands::schema::list_sqlserver_linked_server_catalogs,
            commands::schema::list_sqlserver_linked_server_schemas,
            commands::schema::list_sqlserver_linked_server_tables,
            commands::schema::list_tables,
            commands::schema::get_table_comment,
            commands::schema::list_objects,
            commands::schema::list_object_statistics,
            commands::schema::list_completion_objects,
            commands::schema::completion_assistant_search,
            commands::schema::get_object_source,
            commands::schema::list_schemas,
            commands::schema::list_schema_infos,
            commands::schema::get_columns,
            commands::schema::list_indexes,
            commands::schema::list_foreign_keys,
            commands::schema::list_triggers,
            commands::schema::get_table_ddl,
            commands::schema::list_functions,
            commands::schema::list_sequences,
            commands::schema::list_rules,
            commands::schema::list_owners,
            commands::schema_diff::prepare_schema_diff,
            commands::schema_diff::generate_schema_sync_sql,
            commands::schema_cache::save_schema_cache,
            commands::schema_cache::load_schema_cache,
            commands::schema_cache::delete_schema_cache_prefix,
            commands::tab_runtime_cache::save_tab_runtime_cache,
            commands::tab_runtime_cache::load_tab_runtime_cache,
            commands::tab_runtime_cache::delete_tab_runtime_cache,
            commands::query::execute_query,
            commands::query::execute_multi,
            commands::query::cancel_query,
            commands::query::close_query_session,
            commands::query::close_client_connection_session,
            commands::query::execute_batch,
            commands::query::execute_script,
            commands::query::execute_in_transaction,
            commands::query::analyze_sql_references,
            commands::query::find_statement_at_cursor,
            commands::query::prepare_query_pagination_execution_plan,
            commands::query::build_sorted_query_sql,
            commands::query::build_explain_sql,
            commands::query::get_explain_info,
            commands::query::build_create_user_sql,
            commands::query::build_dropped_file_preview_sql,
            commands::query::build_table_select_sql,
            commands::query::build_database_search_sql,
            commands::query::build_search_result_where,
            commands::query::build_rename_object_sql,
            commands::query::build_create_database_sql,
            #[cfg(feature = "duckdb-bundled")]
            commands::query::build_duckdb_attach_database_sql,
            commands::query::build_drop_object_sql,
            commands::query::build_drop_table_sql,
            commands::query::build_drop_table_child_object_sql,
            commands::query::build_empty_table_sql,
            commands::query::build_truncate_table_sql,
            commands::query::build_drop_database_sql,
            commands::query::build_create_schema_sql,
            commands::query::build_drop_schema_sql,
            commands::query::build_duplicate_table_structure_sql,
            commands::query::build_executable_object_source_statements,
            commands::query::build_executable_object_source_sql,
            commands::query::build_editable_object_source,
            commands::query::build_routine_rename_object_source_statements,
            commands::query::build_view_ddl_sql,
            commands::query::build_table_structure_change_sql,
            commands::query::build_create_table_sql,
            commands::query::build_single_column_alter_sql,
            commands::query::analyze_editable_query_editability,
            commands::query::prepare_data_grid_save,
            commands::query::build_data_grid_copy_update_statements,
            commands::query::build_data_grid_copy_insert_statement,
            commands::query::build_data_grid_context_filter_condition,
            commands::query::build_data_grid_column_value_filter_condition,
            commands::query::build_data_grid_count_sql,
            commands::query::build_hive_table_properties_sql,
            commands::query::build_export_insert_statements,
            commands::query::build_export_sql_insert,
            commands::query::build_database_sql_export,
            commands::data_compare::prepare_data_compare,
            commands::data_compare::prepare_data_compare_from_tables,
            commands::data_compare::prepare_data_compare_missing_target,
            commands::data_compare::build_data_compare_sync_plan,
            commands::sql_file::preview_sql_file,
            commands::sql_file::execute_sql_file,
            commands::sql_file::cancel_sql_file_execution,
            commands::external_sql::pending_open_sql_files,
            commands::external_sql::read_external_sql_file,
            commands::external_sql::write_external_sql_file,
            commands::external_db::pending_open_db_files,
            commands::keychain::read_keychain_password,
            commands::keychain::read_keychain_passwords,
            commands::deep_link::pending_open_connection_links,
            commands::table_import::preview_table_import_file,
            commands::table_import::import_table_file,
            commands::table_import::cancel_table_import,
            commands::redis_cmd::redis_list_databases,
            commands::redis_cmd::redis_scan_keys,
            commands::redis_cmd::redis_scan_keys_batch,
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
            commands::redis_cmd::redis_stream_add,
            commands::redis_cmd::redis_json_set,
            commands::redis_cmd::redis_check_json_module,
            commands::redis_cmd::redis_set_ttl,
            commands::redis_cmd::redis_delete_keys,
            commands::redis_cmd::redis_flush_db,
            commands::redis_cmd::redis_execute_command,
            commands::redis_cmd::redis_load_more,
            commands::redis_cmd::redis_pubsub_publish,
            commands::redis_cmd::redis_slowlog_get,
            commands::redis_cmd::redis_cluster_master_nodes,
            commands::etcd_cmd::etcd_list_prefix,
            commands::etcd_cmd::etcd_get,
            commands::etcd_cmd::etcd_put,
            commands::etcd_cmd::etcd_delete,
            commands::zookeeper_cmd::zookeeper_list_prefix,
            commands::zookeeper_cmd::zookeeper_get,
            commands::zookeeper_cmd::zookeeper_put,
            commands::zookeeper_cmd::zookeeper_delete,
            commands::nacos_cmd::nacos_test_connection,
            commands::nacos_cmd::nacos_list_namespaces,
            commands::nacos_cmd::nacos_create_namespace,
            commands::nacos_cmd::nacos_update_namespace,
            commands::nacos_cmd::nacos_list_configs,
            commands::nacos_cmd::nacos_get_config,
            commands::nacos_cmd::nacos_publish_config,
            commands::nacos_cmd::nacos_delete_config,
            commands::nacos_cmd::nacos_list_config_history,
            commands::nacos_cmd::nacos_get_config_history,
            commands::nacos_cmd::nacos_rollback_config,
            commands::nacos_cmd::nacos_list_services,
            commands::nacos_cmd::nacos_list_instances,
            commands::nacos_cmd::nacos_update_instance,
            commands::nacos_cmd::nacos_raw_request,
            commands::saved_sql::load_saved_sql_library,
            commands::saved_sql::save_saved_sql_folder,
            commands::saved_sql::delete_saved_sql_folder,
            commands::saved_sql::save_saved_sql_file,
            commands::saved_sql::delete_saved_sql_file,
            commands::saved_sql::saved_sql_storage_dir,
            commands::saved_sql::open_saved_sql_storage_dir,
            commands::saved_sql::sync_saved_sql_directory,
            commands::fs_open::reveal_path_in_file_manager,
            commands::fs_open::is_sqlite_database_file,
            commands::sqlite_backup::backup_sqlite_database,
            commands::mongo_cmd::mongo_list_databases,
            commands::mongo_cmd::mongo_list_collections,
            commands::mongo_cmd::mongo_create_database,
            commands::mongo_cmd::mongo_drop_database,
            commands::mongo_cmd::mongo_drop_collection,
            commands::mongo_cmd::document_find_documents,
            commands::mongo_cmd::mongo_find_documents,
            commands::mongo_cmd::mongo_aggregate_documents,
            commands::mongo_cmd::mongo_insert_document,
            commands::mongo_cmd::mongo_insert_documents,
            commands::mongo_cmd::mongo_update_document,
            commands::mongo_cmd::mongo_update_documents,
            commands::mongo_cmd::mongo_delete_document,
            commands::mongo_cmd::mongo_delete_documents,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_test_connection,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_tenants,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_tenant,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_create_tenant,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_update_tenant,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_delete_tenant,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_namespaces,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_create_namespace,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_delete_namespace,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_namespace_policies,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_topics,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_create_topic,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_delete_topic,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_update_partitions,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_topic_stats,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_topic_internal_stats,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_subscriptions,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_create_subscription,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_delete_subscription,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_skip_messages,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_reset_cursor,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_clear_backlog,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_peek_messages,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_expire_messages,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_producers,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_consumers,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_unload_topic,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_set_publish_rate,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_set_dispatch_rate,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_set_subscribe_rate,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_set_backlog_quota,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_set_retention,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_effective_policies,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_grant_permission,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_revoke_permission,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_permissions,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_issue_token,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_token_records,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_backlog,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_raw_request,
            commands::history::save_history,
            commands::history::load_history,
            commands::history::clear_history,
            commands::history::delete_history_entry,
            commands::mcp::check_mcp_server_status,
            commands::mcp::install_mcp_server,
            commands::update::check_for_updates,
            commands::update::get_system_proxy_url,
            commands::transfer::start_transfer,
            commands::transfer::cancel_transfer,
            commands::database_export::export_database_sql,
            commands::database_export::cancel_database_export,
            commands::table_export::start_table_export,
            commands::table_export::cancel_table_export,
            commands::query_result_export::start_query_result_export,
            commands::query_result_export::cancel_query_result_export,
            commands::csv_export::export_query_result_csv,
            commands::csv_export::export_table_data_csv,
            commands::xlsx_export::export_query_result_xlsx,
            commands::xlsx_export::export_query_results_xlsx,
            commands::text_export::export_query_result_json,
            commands::text_export::export_query_result_markdown,
            commands::agents::list_installed_agents,
            commands::agents::list_installed_agents_local,
            commands::agents::get_driver_store_usage,
            commands::agents::get_driver_runtime_summary,
            commands::agents::stop_driver_runtime,
            commands::agents::restart_driver_runtime,
            commands::agents::install_agent,
            commands::agents::upgrade_all_agents,
            commands::agents::check_agent_update_blockers,
            commands::agents::uninstall_agent,
            commands::agents::check_jre_installed,
            commands::agents::get_agent_java_runtime_config,
            commands::agents::set_agent_java_runtime_config,
            commands::agents::uninstall_jre,
            commands::agents::reinstall_jre,
            commands::agents::invalidate_agent_registry_cache,
            commands::agents::import_agents_from_zip,
            commands::agents::import_agent_jar_cmd,
            commands::system_fonts::list_system_fonts,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            #[cfg(not(target_os = "macos"))]
            let _ = (&app_handle, &event);

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

                let db_paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter(|path| commands::external_db::is_db_file_path(path))
                    .map(|path| path.to_string_lossy().to_string())
                    .collect();
                if !db_paths.is_empty() {
                    if let Some(state) = app_handle.try_state::<commands::external_db::ExternalDbOpenState>() {
                        state.push(db_paths.clone());
                    }
                    let _ = app_handle.emit("dbx-open-db-files", db_paths);
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
                let app_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        state.refresh_connections().await;
                    }
                });
            }

            if let RunEvent::Resumed = &event {
                let app_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        state.refresh_connections().await;
                    }
                });
            }
        });
}
