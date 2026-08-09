use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use crate::models::connection::{ConnectionConfig, ConnectionTestResult, DatabaseType};
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::{broadcast, Mutex, RwLock};

use super::{
    InstalledPlugin, PluginBinaryMessage, PluginConnectionActionContribution, PluginConnectionCapability,
    PluginConnectionProviderContribution, PluginEvent, PluginFormFieldBinding, PluginFormFieldDefinition,
    PluginFormFieldType, PluginRegistry, PluginRuntimeEnv, PluginSessionState, PluginSidecarSession,
    PLUGIN_CONNECTION_ACTION_METHOD, PLUGIN_CONNECTION_CONNECT_METHOD, PLUGIN_CONNECTION_DISCONNECT_METHOD,
    PLUGIN_CONNECTION_TEST_METHOD,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivePluginSession {
    pub plugin_id: String,
    pub process_id: Option<u32>,
    pub state: PluginSessionState,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConnectionActionResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub field_values: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone)]
pub struct PluginHost {
    inner: Arc<PluginHostInner>,
}

#[derive(Clone)]
pub struct PluginConnectionHandle {
    pub plugin_id: String,
    pub provider_id: String,
    pub connection_id: String,
    session: Option<Arc<PluginSidecarSession>>,
    disconnect: bool,
    params: serde_json::Value,
}

impl PluginConnectionHandle {
    pub fn is_running(&self) -> bool {
        self.session.as_ref().is_none_or(|session| session.status().state == PluginSessionState::Running)
    }

    pub async fn disconnect(&self) -> Result<(), String> {
        let Some(session) = &self.session else {
            return Ok(());
        };
        if !self.disconnect || session.status().state != PluginSessionState::Running {
            return Ok(());
        }
        let result: serde_json::Value = session
            .invoke_with_timeout(
                PLUGIN_CONNECTION_DISCONNECT_METHOD,
                self.params.clone(),
                None,
                Some(super::PLUGIN_REQUEST_TIMEOUT),
            )
            .await?;
        ensure_plugin_operation_succeeded(result)
    }
}

struct PluginHostInner {
    registry: PluginRegistry,
    sessions: RwLock<HashMap<String, Arc<PluginSidecarSession>>>,
    activation_lock: Mutex<()>,
    events: broadcast::Sender<PluginEvent>,
    binary_messages: broadcast::Sender<PluginBinaryMessage>,
}

impl PluginHost {
    pub fn new(registry: PluginRegistry) -> Self {
        let (events, _) = broadcast::channel(512);
        let (binary_messages, _) = broadcast::channel(128);
        Self {
            inner: Arc::new(PluginHostInner {
                registry,
                sessions: RwLock::new(HashMap::new()),
                activation_lock: Mutex::new(()),
                events,
                binary_messages,
            }),
        }
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<PluginEvent> {
        self.inner.events.subscribe()
    }

    pub fn subscribe_binary(&self) -> broadcast::Receiver<PluginBinaryMessage> {
        self.inner.binary_messages.subscribe()
    }

    pub(super) fn registry(&self) -> &PluginRegistry {
        &self.inner.registry
    }

    pub async fn activate(&self, plugin_id: &str) -> Result<Arc<PluginSidecarSession>, String> {
        self.activate_with_env(plugin_id, PluginRuntimeEnv::default()).await
    }

    pub async fn activate_with_env(
        &self,
        plugin_id: &str,
        env: PluginRuntimeEnv,
    ) -> Result<Arc<PluginSidecarSession>, String> {
        if let Some(session) = self.running_session(plugin_id).await {
            return Ok(session);
        }

        let _activation = self.inner.activation_lock.lock().await;
        if let Some(session) = self.running_session(plugin_id).await {
            return Ok(session);
        }
        self.inner.sessions.write().await.remove(plugin_id);

        let plugin = self
            .inner
            .registry
            .find_plugin(plugin_id)?
            .ok_or_else(|| format!("Plugin '{plugin_id}' is not installed"))?;
        if !plugin.compatibility.compatible {
            return Err(format!("Plugin '{plugin_id}' is incompatible: {}", plugin.compatibility.errors.join("; ")));
        }
        let session = PluginSidecarSession::start(plugin, self.inner.registry.app_version().to_string(), env).await?;
        self.forward_session_events(&session);
        self.inner.sessions.write().await.insert(plugin_id.to_string(), session.clone());
        Ok(session)
    }

    pub async fn invoke<T>(
        &self,
        plugin_id: &str,
        method: &str,
        params: serde_json::Value,
        required_permission: Option<&str>,
        timeout: Option<Duration>,
    ) -> Result<T, String>
    where
        T: DeserializeOwned,
    {
        let session = self.activate(plugin_id).await?;
        ensure_permission(session.plugin(), required_permission)?;
        session.invoke_with_timeout(method, params, None, timeout).await
    }

    pub async fn notify(
        &self,
        plugin_id: &str,
        method: &str,
        params: serde_json::Value,
        required_permission: Option<&str>,
    ) -> Result<(), String> {
        let session = self.activate(plugin_id).await?;
        ensure_permission(session.plugin(), required_permission)?;
        session.notify(method, params, None).await
    }

    pub async fn send_binary(
        &self,
        plugin_id: &str,
        channel: &str,
        data: &[u8],
        required_permission: Option<&str>,
    ) -> Result<(), String> {
        let session = self.activate(plugin_id).await?;
        ensure_permission(session.plugin(), required_permission)?;
        session.send_binary(channel, data).await
    }

    pub async fn test_connection(
        &self,
        config: &ConnectionConfig,
        runtime_host: &str,
        runtime_port: u16,
    ) -> Result<ConnectionTestResult, String> {
        let (plugin, provider) = self.resolve_connection_provider(config)?;
        validate_plugin_connection_values(config, &provider)?;
        let provider_label = provider.label.as_deref().unwrap_or(&plugin.manifest.name);
        if !provider.has_capability(PluginConnectionCapability::Test) {
            return Ok(ConnectionTestResult::success(format!("{provider_label} is available")));
        }
        let session = self.activate(config.plugin_id.as_deref().unwrap_or_default()).await?;
        let result: serde_json::Value = session
            .invoke_with_timeout(
                PLUGIN_CONNECTION_TEST_METHOD,
                plugin_connection_params(config, &provider, runtime_host, runtime_port)?,
                None,
                Some(Duration::from_secs(config.effective_connect_timeout_secs())),
            )
            .await?;
        plugin_connection_test_result(result, provider_label)
    }

    pub async fn connect_connection(
        &self,
        config: &ConnectionConfig,
        runtime_host: &str,
        runtime_port: u16,
    ) -> Result<PluginConnectionHandle, String> {
        let (_, provider) = self.resolve_connection_provider(config)?;
        validate_plugin_connection_values(config, &provider)?;
        let params = plugin_connection_params(config, &provider, runtime_host, runtime_port)?;
        let needs_session = provider.has_capability(PluginConnectionCapability::Connect)
            || provider.has_capability(PluginConnectionCapability::Disconnect);
        let session = if needs_session {
            Some(self.activate(config.plugin_id.as_deref().unwrap_or_default()).await?)
        } else {
            None
        };
        if provider.has_capability(PluginConnectionCapability::Connect) {
            if let Some(session) = &session {
                let result: serde_json::Value = session
                    .invoke_with_timeout(
                        PLUGIN_CONNECTION_CONNECT_METHOD,
                        params.clone(),
                        None,
                        Some(Duration::from_secs(config.effective_connect_timeout_secs())),
                    )
                    .await?;
                ensure_plugin_operation_succeeded(result)?;
            }
        }
        let disconnect = provider.has_capability(PluginConnectionCapability::Disconnect);
        Ok(PluginConnectionHandle {
            plugin_id: config.plugin_id.clone().unwrap_or_default(),
            provider_id: provider.id,
            connection_id: config.id.clone(),
            session,
            disconnect,
            params,
        })
    }

    pub async fn invoke_connection_action(
        &self,
        config: &ConnectionConfig,
        action_id: &str,
        runtime_host: &str,
        runtime_port: u16,
    ) -> Result<PluginConnectionActionResult, String> {
        let (_, provider) = self.resolve_connection_provider(config)?;
        let action = plugin_invoke_connection_action(&provider, action_id)?;
        validate_plugin_connection_values_for_action(config, &provider, action.requires_valid_form)?;
        let session = self.activate(config.plugin_id.as_deref().unwrap_or_default()).await?;
        let mut params = plugin_connection_params(config, &provider, runtime_host, runtime_port)?;
        params
            .as_object_mut()
            .ok_or("Plugin connection action params must be an object")?
            .insert("action".to_string(), serde_json::json!({ "id": action.id }));
        let result: serde_json::Value = session
            .invoke_with_timeout(
                PLUGIN_CONNECTION_ACTION_METHOD,
                params,
                None,
                action.timeout_ms.map(Duration::from_millis).or(Some(super::PLUGIN_REQUEST_TIMEOUT)),
            )
            .await?;
        plugin_connection_action_result(result, &provider)
    }

    pub async fn list_active(&self) -> Vec<ActivePluginSession> {
        let sessions = self.inner.sessions.read().await.values().cloned().collect::<Vec<_>>();
        let mut active = Vec::with_capacity(sessions.len());
        for session in sessions {
            active.push(ActivePluginSession {
                plugin_id: session.plugin().manifest.id.clone(),
                process_id: session.pid().await,
                state: session.status().state,
            });
        }
        active.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
        active
    }

    pub async fn stop(&self, plugin_id: &str) {
        if let Some(session) = self.inner.sessions.write().await.remove(plugin_id) {
            session.shutdown().await;
        }
    }

    pub async fn stop_all(&self) {
        let sessions = std::mem::take(&mut *self.inner.sessions.write().await);
        for (_, session) in sessions {
            session.shutdown().await;
        }
    }

    async fn running_session(&self, plugin_id: &str) -> Option<Arc<PluginSidecarSession>> {
        let session = self.inner.sessions.read().await.get(plugin_id).cloned()?;
        (session.status().state == PluginSessionState::Running).then_some(session)
    }

    fn resolve_connection_provider(
        &self,
        config: &ConnectionConfig,
    ) -> Result<(InstalledPlugin, PluginConnectionProviderContribution), String> {
        if config.db_type != DatabaseType::Plugin {
            return Err("Connection is not a plugin-owned connection".to_string());
        }
        let plugin_id = required_plugin_binding(&config.plugin_id, "plugin_id")?;
        let provider_id = required_plugin_binding(&config.plugin_connection_provider, "plugin_connection_provider")?;
        let connection_type = required_plugin_binding(&config.plugin_connection_type, "plugin_connection_type")?;
        let plugin = self
            .inner
            .registry
            .find_plugin(plugin_id)?
            .ok_or_else(|| format!("Plugin '{plugin_id}' is not installed"))?;
        if !plugin.compatibility.compatible {
            return Err(format!("Plugin '{plugin_id}' is incompatible: {}", plugin.compatibility.errors.join("; ")));
        }
        let provider = plugin
            .manifest
            .connection_provider(provider_id)?
            .ok_or_else(|| format!("Plugin '{plugin_id}' does not provide connection provider '{provider_id}'"))?;
        if provider.database_type != connection_type {
            return Err(format!(
                "Connection type '{}' does not match provider '{}' type '{}'",
                connection_type, provider.id, provider.database_type
            ));
        }
        Ok((plugin, provider))
    }

    fn forward_session_events(&self, session: &Arc<PluginSidecarSession>) {
        let mut events = session.subscribe_events();
        let host_events = self.inner.events.clone();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => {
                        let _ = host_events.send(event);
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        log::warn!("Plugin host event relay skipped {skipped} events");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        let mut binary = session.subscribe_binary();
        let host_binary = self.inner.binary_messages.clone();
        tokio::spawn(async move {
            loop {
                match binary.recv().await {
                    Ok(message) => {
                        let _ = host_binary.send(message);
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        log::warn!("Plugin host binary relay skipped {skipped} messages");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
}

fn required_plugin_binding<'a>(value: &'a Option<String>, field: &str) -> Result<&'a str, String> {
    value
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Plugin connection is missing {field}"))
}

fn plugin_connection_params(
    config: &ConnectionConfig,
    provider: &PluginConnectionProviderContribution,
    runtime_host: &str,
    runtime_port: u16,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "provider": {
            "id": provider.id,
            "databaseType": provider.database_type,
        },
        "connection": serde_json::to_value(config).map_err(|error| error.to_string())?,
        "runtime": {
            "host": runtime_host,
            "port": runtime_port,
        }
    }))
}

fn validate_plugin_connection_values(
    config: &ConnectionConfig,
    provider: &PluginConnectionProviderContribution,
) -> Result<(), String> {
    validate_plugin_connection_values_for_action(config, provider, true)
}

fn plugin_invoke_connection_action<'a>(
    provider: &'a PluginConnectionProviderContribution,
    action_id: &str,
) -> Result<&'a PluginConnectionActionContribution, String> {
    provider
        .actions
        .iter()
        .find(|action| action.id == action_id)
        .ok_or_else(|| format!("Connection provider '{}' does not declare action '{action_id}'", provider.id))
}

fn validate_plugin_connection_values_for_action(
    config: &ConnectionConfig,
    provider: &PluginConnectionProviderContribution,
    require_required_fields: bool,
) -> Result<(), String> {
    let allowed_secrets = provider
        .fields
        .iter()
        .filter(|field| field.effective_binding() == PluginFormFieldBinding::Secret)
        .map(|field| field.key.as_str())
        .collect::<HashSet<_>>();
    for key in config.connection_secrets.keys() {
        if !allowed_secrets.contains(key.as_str()) {
            return Err(format!("Connection secret '{key}' is not declared by provider '{}'", provider.id));
        }
    }
    for field in &provider.fields {
        let value = plugin_connection_field_value(config, field);
        if require_required_fields && field.required && plugin_field_value_is_empty(value.as_ref()) {
            return Err(format!("Plugin connection field '{}' is required", field.label));
        }
        if let Some(value) = value {
            validate_plugin_field_type(field, &value)?;
            if field.effective_binding() == PluginFormFieldBinding::Port
                && value.as_u64().is_none_or(|port| port == 0 || port > u16::MAX as u64)
            {
                return Err(format!("Plugin connection field '{}' must be a port between 1 and 65535", field.label));
            }
        }
    }
    Ok(())
}

fn plugin_connection_action_result(
    result: serde_json::Value,
    provider: &PluginConnectionProviderContribution,
) -> Result<PluginConnectionActionResult, String> {
    if let Some(message) = result.as_str() {
        return Ok(PluginConnectionActionResult { message: Some(message.to_string()), field_values: BTreeMap::new() });
    }
    if result.is_null() {
        return Ok(PluginConnectionActionResult::default());
    }
    let object = result
        .as_object()
        .ok_or_else(|| "Plugin connection action must return null, a message string, or an object".to_string())?;
    if object.get("success").and_then(serde_json::Value::as_bool) == Some(false) {
        return Err(object
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Plugin connection action failed")
            .to_string());
    }
    let message = match object.get("message") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(message)) => Some(message.clone()),
        Some(_) => return Err("Plugin connection action message must be a string".to_string()),
    };
    let mut field_values = BTreeMap::new();
    if let Some(values) = object.get("fieldValues") {
        let values =
            values.as_object().ok_or_else(|| "Plugin connection action fieldValues must be an object".to_string())?;
        for (key, value) in values {
            let field = provider
                .fields
                .iter()
                .find(|field| field.key == *key)
                .ok_or_else(|| format!("Plugin connection action returned undeclared field '{key}'"))?;
            if !value.is_null() {
                validate_plugin_field_type(field, value)?;
                if field.effective_binding() == PluginFormFieldBinding::Port
                    && value.as_u64().is_none_or(|port| port == 0 || port > u16::MAX as u64)
                {
                    return Err(format!(
                        "Plugin connection field '{}' must be a port between 1 and 65535",
                        field.label
                    ));
                }
            }
            field_values.insert(key.clone(), value.clone());
        }
    }
    Ok(PluginConnectionActionResult { message, field_values })
}

fn plugin_connection_field_value(
    config: &ConnectionConfig,
    field: &PluginFormFieldDefinition,
) -> Option<serde_json::Value> {
    match field.effective_binding() {
        PluginFormFieldBinding::Name => Some(serde_json::Value::String(config.name.clone())),
        PluginFormFieldBinding::Host => Some(serde_json::Value::String(config.host.clone())),
        PluginFormFieldBinding::Port => Some(serde_json::Value::Number(config.port.into())),
        PluginFormFieldBinding::Username => Some(serde_json::Value::String(config.username.clone())),
        PluginFormFieldBinding::Password => Some(serde_json::Value::String(config.password.clone())),
        PluginFormFieldBinding::Database => config.database.clone().map(serde_json::Value::String),
        PluginFormFieldBinding::Secret => {
            config.connection_secrets.get(&field.key).cloned().map(serde_json::Value::String)
        }
        PluginFormFieldBinding::Config => config.external_config.as_ref()?.get(&field.key).cloned(),
    }
}

fn plugin_field_value_is_empty(value: Option<&serde_json::Value>) -> bool {
    match value {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::String(value)) => value.trim().is_empty(),
        _ => false,
    }
}

fn validate_plugin_field_type(field: &PluginFormFieldDefinition, value: &serde_json::Value) -> Result<(), String> {
    let valid = match field.field_type {
        PluginFormFieldType::Text
        | PluginFormFieldType::Password
        | PluginFormFieldType::Select
        | PluginFormFieldType::Textarea => value.is_string(),
        PluginFormFieldType::Number => value.is_number(),
        PluginFormFieldType::Boolean => value.is_boolean(),
    };
    if valid {
        Ok(())
    } else {
        Err(format!("Plugin connection field '{}' has an invalid value type", field.label))
    }
}

fn plugin_connection_test_result(
    result: serde_json::Value,
    provider_label: &str,
) -> Result<ConnectionTestResult, String> {
    if let Some(success) = result.get("success").and_then(serde_json::Value::as_bool) {
        let message = result.get("message").and_then(serde_json::Value::as_str).unwrap_or(if success {
            "Connection successful"
        } else {
            "Connection failed"
        });
        if !success {
            return Err(message.to_string());
        }
        return Ok(ConnectionTestResult::success(message));
    }
    if let Some(message) = result.as_str() {
        return Ok(ConnectionTestResult::success(message));
    }
    if result.is_null() {
        return Ok(ConnectionTestResult::success(format!("{provider_label} connection successful")));
    }
    serde_json::from_value(result)
        .map_err(|error| format!("Plugin connection test returned an invalid result: {error}"))
}

fn ensure_plugin_operation_succeeded(result: serde_json::Value) -> Result<(), String> {
    if result.get("success").and_then(serde_json::Value::as_bool) == Some(false) {
        return Err(result
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Plugin connection operation failed")
            .to_string());
    }
    Ok(())
}

fn ensure_permission(plugin: &super::InstalledPlugin, required_permission: Option<&str>) -> Result<(), String> {
    let Some(permission) = required_permission else {
        return Ok(());
    };
    if plugin.manifest.permissions.iter().any(|declared| declared == permission) {
        return Ok(());
    }
    Err(format!("Plugin '{}' has not declared permission '{permission}'", plugin.manifest.id))
}

#[cfg(test)]
mod tests {
    use super::{
        plugin_connection_action_result, plugin_invoke_connection_action, validate_plugin_connection_values,
        validate_plugin_connection_values_for_action,
    };
    use crate::models::connection::ConnectionConfig;
    use crate::plugins::PluginConnectionProviderContribution;

    #[test]
    fn rejects_zero_port_for_port_bound_connection_field() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "plugin-connection",
            "name": "Plugin connection",
            "db_type": "plugin",
            "host": "localhost",
            "port": 0,
            "username": "",
            "password": "",
            "database": null,
            "plugin_id": "sample",
            "plugin_connection_provider": "sample.connection",
            "plugin_connection_type": "sample"
        }))
        .unwrap();
        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "sample.connection",
            "label": "Sample",
            "database_type": "sample",
            "fields": [{ "key": "port", "label": "Port", "type": "number", "binding": "port", "required": true }]
        }))
        .unwrap();

        assert!(validate_plugin_connection_values(&config, &provider)
            .unwrap_err()
            .contains("port between 1 and 65535"));
    }

    #[test]
    fn allows_incomplete_fields_only_for_declared_permissive_actions() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "plugin-connection",
            "name": "Plugin connection",
            "db_type": "plugin",
            "host": "",
            "port": 0,
            "username": "",
            "password": "",
            "database": null,
            "plugin_id": "sample",
            "plugin_connection_provider": "sample.connection",
            "plugin_connection_type": "sample"
        }))
        .unwrap();
        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "sample.connection",
            "label": "Sample",
            "database_type": "sample",
            "fields": [{ "key": "host", "label": "Host", "type": "text", "binding": "host", "required": true }]
        }))
        .unwrap();

        assert!(validate_plugin_connection_values_for_action(&config, &provider, false).is_ok());
        assert!(validate_plugin_connection_values_for_action(&config, &provider, true)
            .unwrap_err()
            .contains("is required"));
    }

    #[test]
    fn resolves_only_declared_custom_actions() {
        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "sample.connection",
            "label": "Sample",
            "database_type": "sample",
            "fields": [],
            "actions": [{ "id": "discover", "label": "Discover" }]
        }))
        .unwrap();

        assert_eq!(plugin_invoke_connection_action(&provider, "discover").unwrap().id, "discover");
        assert!(plugin_invoke_connection_action(&provider, "missing").unwrap_err().contains("does not declare action"));
    }

    #[test]
    fn validates_connection_action_field_updates() {
        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "sample.connection",
            "label": "Sample",
            "database_type": "sample",
            "fields": [
                { "key": "host", "label": "Host", "type": "text", "binding": "host" },
                { "key": "port", "label": "Port", "type": "number", "binding": "port" }
            ]
        }))
        .unwrap();

        let result = plugin_connection_action_result(
            serde_json::json!({ "message": "Updated", "fieldValues": { "host": "db.internal", "port": 5432 } }),
            &provider,
        )
        .unwrap();
        assert_eq!(result.message.as_deref(), Some("Updated"));
        assert_eq!(result.field_values.get("port").and_then(serde_json::Value::as_u64), Some(5432));
        assert!(plugin_connection_action_result(
            serde_json::json!({ "fieldValues": { "unknown": "value" } }),
            &provider,
        )
        .unwrap_err()
        .contains("undeclared field"));
        assert!(plugin_connection_action_result(serde_json::json!({ "fieldValues": { "port": "5432" } }), &provider,)
            .unwrap_err()
            .contains("invalid value type"));
    }
}
