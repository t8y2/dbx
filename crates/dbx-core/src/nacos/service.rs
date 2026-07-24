use crate::connection::AppState;
use crate::models::connection::DatabaseType;
use crate::nacos::types::*;

pub async fn nacos_test_connection_core(state: &AppState, conn_id: &str) -> Result<NacosConnectionInfo, String> {
    let cfg = state.configs.read().await.get(conn_id).cloned().ok_or("Connection not found")?;
    if cfg.db_type != DatabaseType::Nacos {
        return Err("Connection is not a Nacos admin connection".to_string());
    }
    let admin_config = state.nacos_admin_config_for_connection(conn_id, &cfg).await?;
    // Keep this probe on the connection's shared adapter so an r-nacos console
    // session verified for configuration history can also expose its version.
    let admin = state.nacos_registry.get_or_build_config(conn_id, admin_config).await?;
    admin.test_connection().await
}

pub async fn nacos_list_namespaces_core(state: &AppState, conn_id: &str) -> Result<Vec<NacosNamespaceInfo>, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.list_namespaces().await
}

pub async fn nacos_create_namespace_core(
    state: &AppState,
    conn_id: &str,
    req: NacosNamespaceCreate,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Create Nacos namespace").await?;
    let admin = get_admin(state, conn_id).await?;
    admin.create_namespace(req).await
}

pub async fn nacos_update_namespace_core(
    state: &AppState,
    conn_id: &str,
    req: NacosNamespaceUpdate,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Update Nacos namespace").await?;
    let admin = get_admin(state, conn_id).await?;
    admin.update_namespace(req).await
}

pub async fn nacos_list_configs_core(
    state: &AppState,
    conn_id: &str,
    query: NacosConfigQuery,
) -> Result<NacosConfigList, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.list_configs(query).await
}

pub async fn nacos_get_config_core(
    state: &AppState,
    conn_id: &str,
    key: NacosConfigKey,
) -> Result<NacosConfigItem, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.get_config(key).await
}

pub async fn nacos_publish_config_core(state: &AppState, conn_id: &str, req: NacosConfigUpsert) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Publish Nacos config").await?;
    let admin = get_admin(state, conn_id).await?;
    admin.publish_config(req).await
}

pub async fn nacos_delete_config_core(state: &AppState, conn_id: &str, key: NacosConfigKey) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Delete Nacos config").await?;
    let admin = get_admin(state, conn_id).await?;
    admin.delete_config(key).await
}

pub async fn nacos_list_config_history_core(
    state: &AppState,
    conn_id: &str,
    query: NacosConfigHistoryQuery,
) -> Result<NacosConfigHistoryList, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.list_config_history(query).await
}

pub async fn nacos_get_config_history_core(
    state: &AppState,
    conn_id: &str,
    key: NacosConfigHistoryKey,
) -> Result<NacosConfigItem, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.get_config_history(key).await
}

pub async fn nacos_rollback_config_core(
    state: &AppState,
    conn_id: &str,
    req: NacosConfigRollbackRequest,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Rollback Nacos config").await?;
    let admin = get_admin(state, conn_id).await?;
    admin.rollback_config(req).await
}

pub async fn nacos_get_rnacos_console_captcha_core(
    state: &AppState,
    conn_id: &str,
) -> Result<NacosRNacosConsoleCaptcha, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.get_rnacos_console_captcha().await
}

pub async fn nacos_login_rnacos_console_core(
    state: &AppState,
    conn_id: &str,
    captcha: Option<String>,
) -> Result<(), String> {
    let admin = get_admin(state, conn_id).await?;
    admin.login_rnacos_console(captcha).await
}

pub async fn nacos_list_services_core(
    state: &AppState,
    conn_id: &str,
    query: NacosServiceQuery,
) -> Result<NacosServiceList, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.list_services(query).await
}

pub async fn nacos_list_instances_core(
    state: &AppState,
    conn_id: &str,
    query: NacosInstanceQuery,
) -> Result<Vec<NacosInstanceInfo>, String> {
    let admin = get_admin(state, conn_id).await?;
    admin.list_instances(query).await
}

pub async fn nacos_update_instance_core(
    state: &AppState,
    conn_id: &str,
    req: NacosInstanceUpdate,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Update Nacos instance").await?;
    let admin = get_admin(state, conn_id).await?;
    admin.update_instance(req).await
}

pub async fn nacos_raw_request_core(
    state: &AppState,
    conn_id: &str,
    req: NacosRawRequest,
) -> Result<NacosRawResponse, String> {
    crate::nacos::http::validate_raw_api_path(&req.path)?;
    if !req.method.eq_ignore_ascii_case("GET") {
        ensure_connection_writable(state, conn_id, "Run mutating Nacos raw request").await?;
    }
    let admin = get_admin(state, conn_id).await?;
    admin.raw_request(req).await
}

async fn get_admin(
    state: &AppState,
    conn_id: &str,
) -> Result<std::sync::Arc<dyn crate::nacos::port::NacosAdmin>, String> {
    let cfg = state.configs.read().await.get(conn_id).cloned().ok_or("Connection not found")?;
    if cfg.db_type != DatabaseType::Nacos {
        return Err("Connection is not a Nacos admin connection".to_string());
    }
    let admin_config = state.nacos_admin_config_for_connection(conn_id, &cfg).await?;
    state.nacos_registry.get_or_build_config(conn_id, admin_config).await
}

async fn ensure_connection_writable(state: &AppState, conn_id: &str, action: &str) -> Result<(), String> {
    let cfg = state.configs.read().await.get(conn_id).cloned().ok_or("Connection not found")?;
    if cfg.read_only {
        Err(format!("{action} is blocked because this connection is read-only"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn raw_mutation_requires_writable_connection_before_adapter_build() {
        let dir = std::env::temp_dir().join(format!("dbx-nacos-service-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = crate::storage::Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let mut cfg = crate::models::connection::ConnectionConfig {
            id: "nacos-1".to_string(),
            name: "Nacos".to_string(),
            db_type: DatabaseType::Nacos,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "127.0.0.1".to_string(),
            port: 8848,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: crate::models::connection::default_keepalive_interval_secs(),
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: ":".to_string(),
            redis_scan_page_size: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: Some(serde_json::json!({ "serverAddr": "http://127.0.0.1:9" })),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: true,
            is_production: false,
            production_databases: Vec::new(),
            database_info: None,
        };
        cfg.read_only = true;
        state.configs.write().await.insert(cfg.id.clone(), cfg);
        let err = nacos_raw_request_core(
            &state,
            "nacos-1",
            NacosRawRequest { method: "POST".to_string(), path: "/v1/cs/configs".to_string(), query: None, body: None },
        )
        .await
        .unwrap_err();
        assert!(err.contains("read-only"));
    }

    #[tokio::test]
    async fn config_rollback_requires_writable_connection_before_adapter_build() {
        let dir = std::env::temp_dir().join(format!("dbx-nacos-service-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = crate::storage::Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let cfg = crate::models::connection::ConnectionConfig {
            id: "nacos-rollback".to_string(),
            name: "Nacos".to_string(),
            db_type: DatabaseType::Nacos,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "127.0.0.1".to_string(),
            port: 8848,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: crate::models::connection::default_keepalive_interval_secs(),
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: ":".to_string(),
            redis_scan_page_size: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: Some(serde_json::json!({ "serverAddr": "http://127.0.0.1:9" })),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: true,
            is_production: false,
            production_databases: Vec::new(),
            database_info: None,
        };
        state.configs.write().await.insert(cfg.id.clone(), cfg);
        let err = nacos_rollback_config_core(
            &state,
            "nacos-rollback",
            NacosConfigRollbackRequest {
                namespace: None,
                data_id: "app.yaml".to_string(),
                group: "DEFAULT_GROUP".to_string(),
                history_id: "1".to_string(),
                nid: None,
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("read-only"));
    }
}
