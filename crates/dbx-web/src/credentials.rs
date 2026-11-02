//! Public connection configs contain references, never saved credential values.
use std::collections::HashMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use dbx_core::models::connection::{jdbc_dialect_hint, ConnectionConfig, ConnectionResponse, TransportLayerConfig};
use serde_json::Value;

use crate::{error::AppError, state::WebState};

const REFERENCE_PREFIX: &str = "__DBX_SAVED_CREDENTIAL__:";
const TUNNEL_PROFILE_PREFIX: &str = "__dbx_tunnel_profile__:";

fn child_path(path: &str, key: &str) -> String {
    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"))
}

fn reference(id: &str, path: &str) -> String {
    format!("{REFERENCE_PREFIX}{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&(id, path)).unwrap()))
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['_', '-'], "");
    key.contains("password")
        || key.contains("passphrase")
        || key.contains("token")
        || key.contains("secret")
        || key.contains("apikey")
        || key == "privatekey"
}

fn redact_value(value: &mut Value, sanitized: Option<&Value>, id: &str, path: &str) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                redact_value(value, sanitized.and_then(|v| v.get(key)), id, &child_path(path, key));
            }
        }
        Value::Array(values) => {
            for (index, value) in values.iter_mut().enumerate() {
                redact_value(value, sanitized.and_then(|v| v.get(index)), id, &child_path(path, &index.to_string()));
            }
        }
        Value::String(text)
            if !text.is_empty()
                && (sensitive_key(path.rsplit('/').next().unwrap_or_default())
                    || sanitized != Some(&Value::String(text.clone()))) =>
        {
            *text = reference(id, path);
        }
        _ => {}
    }
}

pub fn redact(config: &ConnectionConfig) -> ConnectionConfig {
    let mut value = serde_json::to_value(config).expect("serialize connection");
    let sanitized = serde_json::to_value(dbx_core::storage::sanitized_connection_config(config))
        .expect("serialize sanitized connection");
    redact_value(&mut value, Some(&sanitized), &config.id, "");
    serde_json::from_value(value).expect("deserialize redacted connection")
}

pub fn contains_reference(value: &Value) -> bool {
    match value {
        Value::String(text) => text.starts_with(REFERENCE_PREFIX),
        Value::Object(fields) => fields.values().any(contains_reference),
        Value::Array(values) => values.iter().any(contains_reference),
        _ => false,
    }
}

fn restore_value(
    value: &mut Value,
    path: &str,
    saved: &HashMap<String, ConnectionConfig>,
    used: &mut Vec<String>,
) -> Result<(), AppError> {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                restore_value(value, &child_path(path, key), saved, used)?;
            }
        }
        Value::Array(values) => {
            for (index, value) in values.iter_mut().enumerate() {
                restore_value(value, &child_path(path, &index.to_string()), saved, used)?;
            }
        }
        Value::String(text) if text.starts_with(REFERENCE_PREFIX) => {
            let invalid =
                || AppError::bad_request("Saved credential reference is no longer valid. Reload the connections.");
            let bytes = URL_SAFE_NO_PAD.decode(&text[REFERENCE_PREFIX.len()..]).map_err(|_| invalid())?;
            let (id, original_path): (String, String) = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            let shared_tunnel = id.starts_with(TUNNEL_PROFILE_PREFIX)
                && original_path.starts_with("/transport_layers/0/")
                && path.starts_with("/transport_layers/")
                && original_path.rsplit('/').next() == path.rsplit('/').next();
            if original_path != path && !shared_tunnel {
                return Err(invalid());
            }
            let config = saved.get(&id).ok_or_else(invalid)?;
            if id.starts_with(TUNNEL_PROFILE_PREFIX)
                && (!shared_tunnel
                    || !config.host.is_empty()
                    || !config.password.is_empty()
                    || config.transport_layers.len() != 1)
            {
                return Err(invalid());
            }
            let redacted = serde_json::to_value(redact(config)).map_err(|_| invalid())?;
            // References cannot be moved into a note, host, or another credential field.
            if redacted.pointer(&original_path) != Some(&Value::String(text.clone())) {
                return Err(invalid());
            }
            *value = serde_json::to_value(config)
                .map_err(|_| invalid())?
                .pointer(&original_path)
                .cloned()
                .ok_or_else(invalid)?;
            if !used.contains(&id) {
                used.push(id);
            }
        }
        _ => {}
    }
    Ok(())
}

fn credential_target(config: &ConnectionConfig) -> Value {
    let mut value = serde_json::to_value(dbx_core::storage::sanitized_connection_config(config)).unwrap();
    fn scrub(value: &mut Value) {
        match value {
            Value::Object(fields) => {
                for (key, value) in fields {
                    if sensitive_key(key) && value.is_string() {
                        *value = Value::String(String::new());
                    } else {
                        scrub(value);
                    }
                }
            }
            Value::Array(values) => values.iter_mut().for_each(scrub),
            _ => {}
        }
    }
    scrub(&mut value);
    let fields = value.as_object_mut().unwrap();
    for key in [
        "id",
        "name",
        "note",
        "driver_label",
        "database",
        "default_schema",
        "visible_databases",
        "visible_database_patterns",
        "visible_schemas",
        "show_system_schemas",
        "color",
        "docs_notes_path",
        "connect_timeout_secs",
        "query_timeout_secs",
        "idle_timeout_secs",
        "manual_transaction_timeout_secs",
        "keepalive_interval_secs",
        "redis_key_separator",
        "redis_scan_page_size",
        "redis_database_aliases",
        "redis_key_templates",
        "redis_key_grouping",
        "one_time",
        "save_password",
        "read_only",
        "is_production",
        "production_databases",
        "database_info",
    ] {
        fields.remove(key);
    }
    // URLs and scripts can redirect or disclose credentials, so changes to these
    // fields require new credentials rather than silently reusing saved secrets.
    for (key, value) in [
        ("connection_string", &config.connection_string),
        ("url_params", &config.url_params),
        ("init_script", &config.init_script),
    ] {
        fields.insert(key.into(), serde_json::to_value(value.as_deref().filter(|value| !value.is_empty())).unwrap());
    }
    if let Some(external) = fields.get_mut("external_config").and_then(Value::as_object_mut) {
        for key in ["managedNamespaces", "managed_namespaces"] {
            external.remove(key);
        }
    }
    value
}

pub fn restore(
    config: ConnectionConfig,
    saved: &HashMap<String, ConnectionConfig>,
) -> Result<ConnectionConfig, AppError> {
    let mut value = serde_json::to_value(&config).map_err(|e| AppError::from(e.to_string()))?;
    if !contains_reference(&value) {
        return Ok(config);
    }
    let mut used = Vec::new();
    restore_value(&mut value, "", saved, &mut used)?;
    let mut restored: ConnectionConfig = serde_json::from_value(value).map_err(|e| AppError::from(e.to_string()))?;
    for id in used {
        if id.starts_with(TUNNEL_PROFILE_PREFIX) {
            let expected = &saved[&id].transport_layers[0];
            let mut original_value = serde_json::to_value(&config).unwrap();
            for (index, layer) in restored.transport_layers.iter().enumerate() {
                let source = original_value["transport_layers"][index].take();
                // Only compare layers that actually reference this saved profile.
                if contains_tunnel_reference(&source, &id) && tunnel_target(layer) != tunnel_target(expected) {
                    return Err(AppError::forbidden(
                        "Saved tunnel credentials cannot be used with a different tunnel target.",
                    ));
                }
            }
        } else if credential_target(&restored) != credential_target(&saved[&id]) {
            return Err(AppError::forbidden("Saved credentials cannot be used with a different connection target. Enter replacement credentials to change the target."));
        }
    }
    if !config.save_password {
        // Unchecking Save password removes primary saved credentials. Transport
        // and other independently persisted secrets keep their normal behavior.
        restored.password = if config.password.starts_with(REFERENCE_PREFIX) { String::new() } else { config.password };
        if restored.db_type == dbx_core::models::connection::DatabaseType::Nacos {
            if let Some(external) = restored.external_config.as_mut().and_then(Value::as_object_mut) {
                for key in ["auth", "rnacosConsoleAuth", "rnacos_console_auth"] {
                    if let Some(auth) = external.get_mut(key).and_then(Value::as_object_mut) {
                        let original = config
                            .external_config
                            .as_ref()
                            .and_then(|v| v.get(key))
                            .and_then(|v| v.get("password"))
                            .and_then(Value::as_str);
                        if original.is_some_and(|value| value.starts_with(REFERENCE_PREFIX)) {
                            auth.insert("password".into(), Value::String(String::new()));
                        }
                    }
                }
            }
        }
    }
    Ok(restored)
}

fn contains_tunnel_reference(value: &Value, id: &str) -> bool {
    match value {
        Value::Object(fields) => fields.values().any(|value| contains_tunnel_reference(value, id)),
        Value::Array(values) => values.iter().any(|value| contains_tunnel_reference(value, id)),
        Value::String(text) if text.starts_with(REFERENCE_PREFIX) => URL_SAFE_NO_PAD
            .decode(&text[REFERENCE_PREFIX.len()..])
            .ok()
            .and_then(|bytes| serde_json::from_slice::<(String, String)>(&bytes).ok())
            .is_some_and(|(source_id, _)| source_id == id),
        _ => false,
    }
}

fn tunnel_target(layer: &TransportLayerConfig) -> Value {
    let mut config = tunnel_connection(layer.clone());
    for layer in &mut config.transport_layers {
        match layer {
            TransportLayerConfig::Ssh(layer) => {
                layer.id.clear();
                layer.profile_id.clear();
            }
            TransportLayerConfig::Proxy(layer) => {
                layer.id.clear();
                layer.profile_id.clear();
            }
            TransportLayerConfig::HttpTunnel(layer) => {
                layer.id.clear();
                layer.profile_id.clear();
            }
        }
    }
    credential_target(&config)
}

fn tunnel_connection(profile: TransportLayerConfig) -> ConnectionConfig {
    serde_json::from_value(serde_json::json!({
        "id": format!("{TUNNEL_PROFILE_PREFIX}{}", profile.id()), "name": "", "db_type": "mysql", "host": "", "port": 0,
        "username": "", "password": "", "transport_layers": [profile]
    }))
    .expect("valid tunnel credential envelope")
}

pub fn redact_tunnel(profile: TransportLayerConfig) -> TransportLayerConfig {
    redact(&tunnel_connection(profile)).transport_layers.remove(0)
}

pub(crate) fn restore_tunnel_from_profiles(
    profile: TransportLayerConfig,
    saved: &[TransportLayerConfig],
) -> Result<TransportLayerConfig, AppError> {
    let saved = saved.iter().cloned().map(tunnel_connection).map(|config| (config.id.clone(), config)).collect();
    Ok(restore(tunnel_connection(profile), &saved)?.transport_layers.remove(0))
}

impl WebState {
    pub fn connection_response(&self, config: ConnectionConfig) -> ConnectionResponse {
        let jdbc_dialect = jdbc_dialect_hint(&config);
        let response_config = if self.password_viewer_enabled { config } else { redact(&config) };
        ConnectionResponse::with_jdbc_dialect(response_config, jdbc_dialect)
    }

    pub async fn resolve_connection_credentials(&self, config: ConnectionConfig) -> Result<ConnectionConfig, AppError> {
        if !contains_reference(&serde_json::to_value(&config).unwrap()) {
            return Ok(config);
        }
        let saved = self.saved_credential_configs().await?;
        restore(config, &saved)
    }

    pub async fn saved_credential_configs(&self) -> Result<HashMap<String, ConnectionConfig>, AppError> {
        let mut configs: HashMap<_, _> = self
            .app
            .storage
            .load_connections()
            .await
            .map_err(AppError::from)?
            .into_iter()
            .map(|config| (config.id.clone(), config))
            .collect();
        configs.extend(
            self.app
                .storage
                .load_tunnel_profiles()
                .await
                .map_err(AppError::from)?
                .into_iter()
                .map(tunnel_connection)
                .map(|config| (config.id.clone(), config)),
        );
        Ok(configs)
    }

    pub async fn resolve_tunnel_credentials(
        &self,
        profile: TransportLayerConfig,
    ) -> Result<TransportLayerConfig, AppError> {
        if !contains_reference(&serde_json::to_value(&profile).unwrap()) {
            return Ok(profile);
        }
        let saved = self
            .app
            .storage
            .load_tunnel_profiles()
            .await
            .map_err(AppError::from)?
            .into_iter()
            .map(tunnel_connection)
            .map(|config| (config.id.clone(), config))
            .collect();
        Ok(restore(tunnel_connection(profile), &saved)?.transport_layers.remove(0))
    }

    pub fn ensure_secret_export_allowed(&self, include_secrets: bool) -> Result<(), AppError> {
        if include_secrets && !self.password_viewer_enabled {
            return Err(AppError::forbidden("Credential export is disabled by DBX_DISABLE_PASSWORD_VIEWER"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::connection::{
        self, ConnectRequest, McpAddConnectionRequest, McpDuplicateConnectionRequest, SaveConnectionsRequest,
    };
    use axum::{extract::State, http::HeaderMap, Json};
    use std::sync::Arc;

    fn config() -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "saved", "name": "Shared database", "db_type": "mysql", "driver_profile": "mysql",
            "host": "db.internal", "port": 3306, "username": "app", "password": "database-secret",
            "url_params": "trustStorePassword=trust-secret", "connection_secrets": {"custom": "plugin-secret"},
            "transport_layers": [{"type": "ssh", "id": "ssh", "host": "gateway", "port": 22,
                "user": "ssh-user", "password": "ssh-secret", "key_passphrase": "key-secret"}]
        }))
        .unwrap()
    }

    async fn web_state() -> (Arc<WebState>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let storage = dbx_core::persistence::test_storage::open(&dir.path().join("dbx.db")).await.unwrap();
        let app = Arc::new(dbx_core::connection::AppState::new_with_plugin_dir(storage, dir.path().join("plugins")));
        let mut state = WebState::for_tests(app, dir.path().to_path_buf());
        state.password_viewer_enabled = false;
        (Arc::new(state), dir)
    }

    #[test]
    fn response_references_contain_no_secrets_and_restore_exact_credentials() {
        let original = config();
        let public = redact(&original);
        let serialized = serde_json::to_string(&public).unwrap();
        for secret in ["database-secret", "trust-secret", "ssh-secret", "key-secret", "plugin-secret"] {
            assert!(!serialized.contains(secret));
        }
        let saved = HashMap::from([(original.id.clone(), original.clone())]);
        assert_eq!(restore(public, &saved).unwrap(), original);
    }

    #[test]
    fn target_changes_and_reference_substitution_are_rejected() {
        let original = config();
        let saved = HashMap::from([(original.id.clone(), original.clone())]);
        for field in ["host", "username", "url_params", "init_script"] {
            let mut value = serde_json::to_value(redact(&original)).unwrap();
            value[field] = Value::String("attacker-controlled".into());
            assert!(restore(serde_json::from_value(value).unwrap(), &saved).is_err(), "{field}");
        }
        let mut changed = redact(&original);
        changed.note = changed.password.clone();
        assert!(restore(changed, &saved).is_err());
        let mut changed = redact(&original);
        changed.password = reference(&original.id, "/host");
        assert!(restore(changed, &saved).is_err());
        assert!(restore(redact(&original), &HashMap::new()).is_err());
    }

    #[test]
    fn draft_ids_metadata_and_password_replacement_remain_supported() {
        let original = config();
        let saved = HashMap::from([(original.id.clone(), original.clone())]);
        let mut draft = redact(&original);
        draft.id = "temporary-or-copy".into();
        draft.name = "Renamed".into();
        draft.database = Some("other".into());
        assert_eq!(restore(draft.clone(), &saved).unwrap().password, original.password);
        draft.password = "replacement".into();
        assert_eq!(restore(draft, &saved).unwrap().password, "replacement");
        let mut no_save = redact(&original);
        no_save.save_password = false;
        assert_eq!(restore(no_save, &saved).unwrap().password, "");
    }

    #[test]
    fn empty_optional_form_fields_match_saved_null_values() {
        let mut original = config();
        original.url_params = None;
        let saved = HashMap::from([(original.id.clone(), original.clone())]);
        let mut form = redact(&original);
        form.url_params = Some(String::new());
        form.connection_string = Some(String::new());
        form.init_script = Some(String::new());
        assert_eq!(restore(form, &saved).unwrap().password, original.password);
    }

    #[test]
    fn nested_auth_secrets_are_redacted() {
        for (db_type, external) in [
            (
                "nacos",
                serde_json::json!({"auth": {"kind": "usernamePassword", "username": "user", "password": "nested-secret"}}),
            ),
            ("mq", serde_json::json!({"auth": {"kind": "apiKey", "value": "nested-secret"}})),
            ("mysql", serde_json::json!({"apiToken": "nested-secret"})),
        ] {
            let mut value = serde_json::to_value(config()).unwrap();
            value["db_type"] = Value::String(db_type.into());
            value["external_config"] = external;
            let original: ConnectionConfig = serde_json::from_value(value).unwrap();
            let public = redact(&original);
            assert!(!serde_json::to_string(&public).unwrap().contains("nested-secret"));
            let saved = HashMap::from([(original.id.clone(), original.clone())]);
            assert_eq!(restore(public, &saved).unwrap(), original);
        }
    }

    #[tokio::test]
    async fn list_edit_replace_and_no_save_keep_correct_persisted_credentials() {
        let (state, _dir) = web_state().await;
        let original = config();
        state.app.storage.save_connections(std::slice::from_ref(&original)).await.unwrap();
        let Json(mut listed) = connection::load_connections(
            State(state.clone()),
            HeaderMap::new(),
            axum::extract::Query(Default::default()),
        )
        .await
        .unwrap();
        assert!(listed[0].config.password.starts_with(REFERENCE_PREFIX));
        assert_eq!(state.app.configs.read().await[&original.id].password, original.password);
        listed[0].config.name = "Renamed".into();
        let _ = connection::save_connections(
            State(state.clone()),
            HeaderMap::new(),
            Json(SaveConnectionsRequest {
                configs: listed.iter().map(|response| response.config.clone()).collect(),
                removed_ids: Vec::new(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(state.app.storage.load_connections().await.unwrap()[0].password, original.password);
        listed[0].config.password = "replacement".into();
        let _ = connection::save_connections(
            State(state.clone()),
            HeaderMap::new(),
            Json(SaveConnectionsRequest {
                configs: listed.iter().map(|response| response.config.clone()).collect(),
                removed_ids: Vec::new(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(state.app.storage.load_connections().await.unwrap()[0].password, "replacement");
        let Json(mut listed) = connection::load_connections(
            State(state.clone()),
            HeaderMap::new(),
            axum::extract::Query(Default::default()),
        )
        .await
        .unwrap();
        listed[0].config.save_password = false;
        let _ = connection::save_connections(
            State(state.clone()),
            HeaderMap::new(),
            Json(SaveConnectionsRequest {
                configs: listed.into_iter().map(|response| response.config).collect(),
                removed_ids: Vec::new(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(state.app.storage.get_secret(&original.id, "password").await.unwrap(), None);
        assert!(state.ensure_secret_export_allowed(true).is_err());
        assert!(state.ensure_secret_export_allowed(false).is_ok());
    }

    #[tokio::test]
    async fn jdbc_dialect_response_hint_survives_redaction_but_never_persists_or_trusts_input() {
        let (mut state, _dir) = web_state().await;
        let original: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "saved-jdbc", "name": "JDBC connection", "db_type": "jdbc", "driver_profile": "jdbc",
            "host": "host", "port": 2881, "username": "user", "password": "database-secret",
            "connection_string": "jdbc:oceanbase:oracle://host/service"
        }))
        .unwrap();
        state.app.storage.save_connections(std::slice::from_ref(&original)).await.unwrap();

        let Json(mut listed) = connection::load_connections(
            State(state.clone()),
            HeaderMap::new(),
            axum::extract::Query(Default::default()),
        )
        .await
        .unwrap();
        let response_json = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(response_json["jdbc_dialect"], "oceanbase-oracle");
        assert!(listed[0].config.connection_string.as_deref().unwrap().starts_with(REFERENCE_PREFIX));
        assert!(!serde_json::to_string(&response_json).unwrap().contains("jdbc:oceanbase:oracle://host/service"));
        assert!(!serde_json::to_string(&response_json).unwrap().contains("database-secret"));

        let mut rename = listed.remove(0).config;
        rename.name = "Renamed JDBC connection".into();
        let _ = connection::save_connections(
            State(state.clone()),
            HeaderMap::new(),
            Json(SaveConnectionsRequest { configs: vec![rename], removed_ids: Vec::new() }),
        )
        .await
        .unwrap();
        let persisted = state.app.storage.load_connections().await.unwrap();
        assert_eq!(persisted[0].name, "Renamed JDBC connection");
        assert_eq!(persisted[0].connection_string.as_deref(), Some("jdbc:oceanbase:oracle://host/service"));
        assert!(serde_json::to_value(&persisted[0]).unwrap().get("jdbc_dialect").is_none());

        Arc::get_mut(&mut state).unwrap().password_viewer_enabled = true;
        let Json(viewed) = connection::load_connections(
            State(state.clone()),
            HeaderMap::new(),
            axum::extract::Query(Default::default()),
        )
        .await
        .unwrap();
        assert_eq!(viewed[0].jdbc_dialect, Some(dbx_core::models::connection::JdbcDialectHint::OceanbaseOracle));
        assert_eq!(viewed[0].config.connection_string.as_deref(), original.connection_string.as_deref());
        assert_eq!(viewed[0].config.password, original.password);
        Arc::get_mut(&mut state).unwrap().password_viewer_enabled = false;

        let Json(mut listed) = connection::load_connections(
            State(state.clone()),
            HeaderMap::new(),
            axum::extract::Query(Default::default()),
        )
        .await
        .unwrap();
        assert_eq!(listed[0].jdbc_dialect, Some(dbx_core::models::connection::JdbcDialectHint::OceanbaseOracle));
        let mut changed_url = serde_json::to_value(listed.remove(0).config).unwrap();
        changed_url["connection_string"] = serde_json::json!("jdbc:oracle:thin:@host/service");
        changed_url["jdbc_dialect"] = serde_json::json!("oceanbase-oracle");
        changed_url["password"] = serde_json::json!("replacement-secret");
        let changed_url: ConnectionConfig = serde_json::from_value(changed_url).unwrap();
        let _ = connection::save_connections(
            State(state.clone()),
            HeaderMap::new(),
            Json(SaveConnectionsRequest { configs: vec![changed_url], removed_ids: Vec::new() }),
        )
        .await
        .unwrap();
        let Json(listed) = connection::load_connections(
            State(state.clone()),
            HeaderMap::new(),
            axum::extract::Query(Default::default()),
        )
        .await
        .unwrap();
        assert!(listed[0].jdbc_dialect.is_none());
        assert_eq!(
            state.app.storage.load_connections().await.unwrap()[0].connection_string.as_deref(),
            Some("jdbc:oracle:thin:@host/service")
        );

        let mut cleared_url = serde_json::to_value(&listed[0].config).unwrap();
        cleared_url["connection_string"] = Value::Null;
        cleared_url["jdbc_dialect"] = serde_json::json!("oceanbase-oracle");
        cleared_url["password"] = serde_json::json!("replacement-secret-2");
        let cleared_url: ConnectionConfig = serde_json::from_value(cleared_url).unwrap();
        let _ = connection::save_connections(
            State(state.clone()),
            HeaderMap::new(),
            Json(SaveConnectionsRequest { configs: vec![cleared_url], removed_ids: Vec::new() }),
        )
        .await
        .unwrap();
        let Json(listed) = connection::load_connections(
            State(state.clone()),
            HeaderMap::new(),
            axum::extract::Query(Default::default()),
        )
        .await
        .unwrap();
        assert!(listed[0].jdbc_dialect.is_none());
        assert!(state.app.storage.load_connections().await.unwrap()[0].connection_string.is_none());
    }

    #[tokio::test]
    async fn mcp_added_and_duplicated_connections_use_the_same_flat_dialect_response() {
        let (state, _dir) = web_state().await;
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "mcp-jdbc", "name": "MCP JDBC", "db_type": "jdbc", "driver_profile": "jdbc",
            "host": "host", "port": 2881, "username": "user", "password": "",
            "connection_string": "jdbc:oceanbase:oracle://host/service"
        }))
        .unwrap();
        let Json(added) = connection::mcp_add_connection(
            State(state.clone()),
            HeaderMap::new(),
            Json(McpAddConnectionRequest { config }),
        )
        .await
        .unwrap();
        let value = serde_json::to_value(&added).unwrap();
        assert_eq!(value["jdbc_dialect"], "oceanbase-oracle");
        assert!(value.get("config").is_none());
        let Json(duplicated) = connection::mcp_duplicate_connection(
            State(state.clone()),
            HeaderMap::new(),
            Json(McpDuplicateConnectionRequest {
                source_id: "mcp-jdbc".into(),
                copy_id: "mcp-copy".into(),
                copy_name: "Copy".into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(serde_json::to_value(&duplicated).unwrap()["jdbc_dialect"], "oceanbase-oracle");
        assert_eq!(duplicated.config.id, "mcp-copy");
    }

    #[cfg(feature = "sqlite-sqlcipher")]
    #[tokio::test]
    async fn connect_and_test_use_server_held_password_including_temporary_drafts() {
        let (state, dir) = web_state().await;
        let path = dir.path().join("encrypted.sqlite").to_string_lossy().into_owned();
        let handle =
            dbx_core::db::sqlite::connect_path_create_if_missing_with_cipher_key(&path, "stored-key").await.unwrap();
        handle
            .with_connection(|db| db.execute_batch("CREATE TABLE proof (id INTEGER)").map_err(|e| e.to_string()))
            .unwrap();
        drop(handle);
        let original: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "encrypted", "name": "Encrypted SQLite", "db_type": "sqlite", "host": path, "port": 0,
            "username": "", "password": "stored-key"
        }))
        .unwrap();
        state.app.storage.save_connections(std::slice::from_ref(&original)).await.unwrap();
        let browser = redact(&original);
        let _ = connection::test_connection(
            State(state.clone()),
            Json(ConnectRequest { config: browser.clone(), client_attempt: None }),
        )
        .await
        .unwrap();
        let _ = connection::connect_db(
            State(state.clone()),
            HeaderMap::new(),
            Json(ConnectRequest { config: browser.clone(), client_attempt: None }),
        )
        .await
        .unwrap();
        assert_eq!(state.app.configs.read().await[&original.id].password, "stored-key");
        let mut draft = browser;
        draft.id = "visible-db-preview".into();
        draft.one_time = true;
        let _ = connection::connect_db(
            State(state.clone()),
            HeaderMap::new(),
            Json(ConnectRequest { config: draft, client_attempt: None }),
        )
        .await
        .unwrap();
        assert_eq!(state.app.configs.read().await["visible-db-preview"].password, "stored-key");
    }

    #[tokio::test]
    async fn detached_shared_profile_refs_resolve_only_for_the_same_tunnel_endpoint() {
        let (state, _dir) = web_state().await;
        let profile = config().transport_layers.remove(0);
        state.app.storage.save_tunnel_profiles(std::slice::from_ref(&profile)).await.unwrap();
        let mut layer = redact_tunnel(profile.clone());
        if let TransportLayerConfig::Ssh(layer) = &mut layer {
            layer.id = "detached-copy".into();
        }
        let mut draft = config();
        draft.password.clear();
        draft.url_params = None;
        draft.connection_secrets.clear();
        draft.transport_layers = vec![layer];
        let resolved = state.resolve_connection_credentials(draft.clone()).await.unwrap();
        if let TransportLayerConfig::Ssh(layer) = &resolved.transport_layers[0] {
            assert_eq!(layer.password, "ssh-secret");
        }
        if let TransportLayerConfig::Ssh(layer) = &mut draft.transport_layers[0] {
            layer.host = "other-host".into();
        }
        assert!(state.resolve_connection_credentials(draft).await.is_err());
    }

    #[tokio::test]
    async fn shared_tunnel_profiles_hide_and_preserve_passwords() {
        let (state, _dir) = web_state().await;
        let profile = config().transport_layers.remove(0);
        state.app.storage.save_tunnel_profiles(std::slice::from_ref(&profile)).await.unwrap();
        let Json(profiles) = crate::routes::tunnel_profiles::load_tunnel_profiles(State(state.clone())).await.unwrap();
        assert!(!serde_json::to_string(&profiles).unwrap().contains("ssh-secret"));
        let _ = crate::routes::tunnel_profiles::save_tunnel_profiles(
            State(state.clone()),
            axum::http::HeaderMap::new(),
            Json(crate::routes::tunnel_profiles::SaveTunnelProfilesRequest { profiles }),
        )
        .await
        .unwrap();
        assert_eq!(state.app.storage.load_tunnel_profiles().await.unwrap()[0], profile);
    }
}
