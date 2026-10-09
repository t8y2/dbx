mod commands;

pub fn handles(command: &str) -> bool {
    command.starts_with("consul_")
}

pub fn invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::consul_capabilities,
        commands::consul_txn,
        commands::consul_rename_key,
        commands::consul_blocking_query,
        commands::consul_domain_watch,
        commands::consul_cancel_blocking,
        commands::consul_watch_start,
        commands::consul_list_prefix,
        commands::consul_list_recursive,
        commands::consul_search,
        commands::consul_search_progress,
        commands::consul_cancel_search,
        commands::consul_export_bundle,
        commands::consul_import_preview,
        commands::consul_import_execute,
        commands::consul_delete_prefix_preview,
        commands::consul_delete_prefix_execute,
        commands::consul_get,
        commands::consul_put,
        commands::consul_delete,
        commands::consul_prepared_query_list,
        commands::consul_prepared_query_read,
        commands::consul_prepared_query_create,
        commands::consul_prepared_query_update,
        commands::consul_prepared_query_delete,
        commands::consul_prepared_query_execute,
        commands::consul_prepared_query_explain,
        commands::consul_event_list,
        commands::consul_event_fire,
        commands::consul_coordinate_nodes,
        commands::consul_operator_read,
        commands::consul_snapshot_generate,
        commands::consul_snapshot_restore,
        commands::consul_autopilot_update,
        commands::consul_raft_transfer,
        commands::consul_raft_remove,
        commands::consul_keyring_write,
        commands::consul_license_write,
        commands::consul_status_leader,
        commands::consul_status_peers,
        commands::consul_agent_self,
        commands::consul_agent_members,
        commands::consul_agent_metrics,
        commands::consul_catalog_datacenters,
        commands::consul_catalog_nodes,
        commands::consul_catalog_services,
        commands::consul_catalog_service_nodes,
        commands::consul_catalog_node_services,
        commands::consul_health_node,
        commands::consul_health_checks,
        commands::consul_health_service,
        commands::consul_health_state,
        commands::consul_agent_services,
        commands::consul_agent_service,
        commands::consul_agent_checks,
        commands::consul_agent_register_service,
        commands::consul_agent_deregister_service,
        commands::consul_agent_service_maintenance,
        commands::consul_agent_register_check,
        commands::consul_agent_deregister_check,
        commands::consul_agent_update_ttl,
        commands::consul_sessions,
        commands::consul_node_sessions,
        commands::consul_session,
        commands::consul_session_keys,
        commands::consul_session_destroy_impact,
        commands::consul_create_session,
        commands::consul_renew_session,
        commands::consul_destroy_session,
        commands::consul_acquire_lock,
        commands::consul_release_lock,
        commands::consul_acl_list,
        commands::consul_acl_token_self,
        commands::consul_acl_token_clone,
        commands::consul_acl_get,
        commands::consul_acl_apply,
        commands::consul_acl_references,
        commands::consul_acl_delete,
        commands::consul_enterprise_list,
        commands::consul_enterprise_get,
        commands::consul_enterprise_apply,
        commands::consul_enterprise_impact,
        commands::consul_enterprise_delete,
        commands::consul_mesh_config_list,
        commands::consul_mesh_config_get,
        commands::consul_mesh_config_apply,
        commands::consul_mesh_config_delete,
        commands::consul_mesh_intentions_list,
        commands::consul_mesh_intention_get,
        commands::consul_mesh_intention_get_exact,
        commands::consul_mesh_intention_upsert,
        commands::consul_mesh_intention_delete,
        commands::consul_mesh_intention_delete_exact,
        commands::consul_mesh_intention_match,
        commands::consul_mesh_intention_check,
        commands::consul_mesh_discovery_chain,
        commands::consul_mesh_peering_list,
        commands::consul_mesh_peering_get,
        commands::consul_mesh_peering_generate_token,
        commands::consul_mesh_peering_establish,
        commands::consul_mesh_peering_delete,
        commands::consul_mesh_exported_services_list,
        commands::consul_mesh_exported_services_apply,
    ]
}

pub fn route(
    main_handler: impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    let consul_handler = invoke_handler();
    move |invoke| {
        if handles(invoke.message.command()) {
            consul_handler(invoke)
        } else {
            main_handler(invoke)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::handles;

    #[test]
    fn handles_only_consul_commands() {
        assert!(handles("consul_capabilities"));
        assert!(!handles("load_connections"));
    }
}
