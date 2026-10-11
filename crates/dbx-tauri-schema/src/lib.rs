mod commands;

macro_rules! define_registry {
    ($($command:ident),+ $(,)?) => {
        const COMMANDS: &[&str] = &[$(stringify!($command)),+];

        pub fn invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
            tauri::generate_handler![$(commands::$command),+]
        }
    };
}

define_registry![
    list_databases,
    list_database_metadata,
    list_database_storage,
    list_xugu_tablespaces,
    get_sqlserver_completion_context,
    list_doris_catalogs,
    list_doris_catalog_databases,
    list_sqlserver_linked_servers,
    list_sqlserver_linked_server_catalogs,
    list_sqlserver_linked_server_schemas,
    list_sqlserver_linked_server_tables,
    list_tables,
    get_table_comment,
    get_mysql_table_auto_increment,
    list_objects,
    list_object_statistics,
    list_completion_objects,
    completion_assistant_search,
    get_object_source,
    get_event_info,
    get_custom_type_details,
    get_custom_type_management_capabilities,
    preview_custom_type_change,
    apply_custom_type_change,
    preview_custom_type_drop,
    apply_custom_type_drop,
    list_custom_type_dependencies,
    list_schemas,
    list_schema_infos,
    list_data_types,
    get_columns,
    get_plugin_table_metadata,
    get_all_columns,
    get_sqlserver_column_metadata,
    list_indexes,
    list_reference_key_columns,
    list_reference_keys,
    list_foreign_keys,
    list_foreign_keys_for_database,
    list_triggers,
    list_constraints,
    list_partitions,
    get_table_partition_status,
    get_table_partitioning,
    list_invalid_indexes,
    list_subpartitions,
    get_table_ddl,
    list_functions,
    list_sequences,
    list_rules,
    list_owners,
    get_table_owner,
    list_extensions,
    list_available_extensions,
    list_event_triggers,
];

pub fn handles(command: &str) -> bool {
    COMMANDS.contains(&command)
}

pub fn route(
    main_handler: impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    let schema_handler = invoke_handler();
    move |invoke| {
        if handles(invoke.message.command()) {
            schema_handler(invoke)
        } else {
            main_handler(invoke)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{handles, COMMANDS};

    #[test]
    fn handles_only_schema_commands() {
        assert_eq!(COMMANDS.len(), 55);
        assert!(handles("list_databases"));
        assert!(handles("list_event_triggers"));
        assert!(!handles("prepare_schema_diff"));
        assert!(!handles("load_connections"));
    }
}
