use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use crate::models::connection::{ConnectionConfig, ConnectionTestResult, DatabaseType};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Mutex, RwLock};

use super::{
    InstalledPlugin, PluginBinaryMessage, PluginConnectionActionContribution, PluginConnectionCapability,
    PluginConnectionProviderContribution, PluginEvent, PluginFormFieldBinding, PluginFormFieldDefinition,
    PluginFormFieldType, PluginPackageInstaller, PluginRegistry, PluginRuntimeEnv, PluginSessionState,
    PluginSidecarSession, PluginTrustStore, PLUGIN_CONNECTION_ACTION_METHOD, PLUGIN_CONNECTION_CONNECT_METHOD,
    PLUGIN_CONNECTION_DISCONNECT_METHOD, PLUGIN_CONNECTION_TEST_METHOD,
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
    _activity: super::lifecycle::PluginUsageGuard,
}

impl PluginConnectionHandle {
    pub fn is_running(&self) -> bool {
        self.session.as_ref().is_none_or(|session| session.status().state == PluginSessionState::Running)
    }

    /// The lifecycle payload this connection was opened with: provider,
    /// hydrated connection, and the runtime endpoint *after* DBX transport
    /// layers. Host-initiated calls that act on an open connection (for
    /// example plugin MCP tools) must reuse it instead of rebuilding a payload
    /// from the saved config, which would bypass the tunnel.
    pub fn lifecycle_params(&self) -> &serde_json::Value {
        &self.params
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
        let _activity = self.inner.registry.lifecycle.begin_operation(plugin_id)?;
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
        let env = env.with_plugin_data_dir(&self.inner.registry.plugin_data_dir(&plugin.manifest.id));
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
        let _activity = self.inner.registry.lifecycle.begin_operation(plugin_id)?;
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
        let _activity = self.inner.registry.lifecycle.begin_operation(plugin_id)?;
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
        let _activity = self.inner.registry.lifecycle.begin_operation(plugin_id)?;
        let session = self.activate(plugin_id).await?;
        ensure_permission(session.plugin(), required_permission)?;
        session.send_binary(channel, data).await
    }

    /// Builds the standard plugin connection lifecycle payload for a config
    /// using the config endpoint as the runtime endpoint (no desktop tunnel
    /// available, e.g. the MCP CLI bridge). Validates that the config maps
    /// to an installed connection provider.
    pub fn connection_params_standalone(&self, config: &ConnectionConfig) -> Result<serde_json::Value, String> {
        let (_, provider) = self.resolve_connection_provider(config)?;
        plugin_connection_params(config, &provider, &config.host, config.port, None)
    }

    /// Reports whether the connection's provider declared
    /// `proxy_route` (multi-endpoint targets that want a SOCKS5
    /// runtime route over transport layers instead of a static tunnel).
    /// Unresolvable configs report `false` so the caller falls back to the
    /// static-tunnel path (and its empty-endpoint guard).
    pub async fn wants_proxy_route(&self, config: &ConnectionConfig) -> bool {
        match self.resolve_connection_provider(config) {
            Ok((_, provider)) => provider.proxy_route,
            Err(_) => false,
        }
    }
    pub async fn test_connection(
        &self,
        config: &ConnectionConfig,
        runtime_host: &str,
        runtime_port: u16,
        runtime_proxy: Option<PluginRuntimeProxy>,
    ) -> Result<ConnectionTestResult, String> {
        let _activity = self
            .inner
            .registry
            .lifecycle
            .begin_connection(config.plugin_id.as_deref().unwrap_or_default(), &config.name)?;
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
                plugin_connection_params(config, &provider, runtime_host, runtime_port, runtime_proxy.as_ref())?,
                None,
                Some(plugin_connect_deadline(config, &provider)),
            )
            .await?;
        plugin_connection_test_result(result, provider_label)
    }

    pub async fn connect_connection(
        &self,
        config: &ConnectionConfig,
        runtime_host: &str,
        runtime_port: u16,
        runtime_proxy: Option<PluginRuntimeProxy>,
    ) -> Result<PluginConnectionHandle, String> {
        let activity = self
            .inner
            .registry
            .lifecycle
            .begin_connection(config.plugin_id.as_deref().unwrap_or_default(), &config.name)?;
        let (_, provider) = self.resolve_connection_provider(config)?;
        validate_plugin_connection_values(config, &provider)?;
        let params = plugin_connection_params(config, &provider, runtime_host, runtime_port, runtime_proxy.as_ref())?;
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
                        Some(plugin_connect_deadline(config, &provider)),
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
            _activity: activity,
        })
    }

    pub async fn invoke_connection_action(
        &self,
        config: &ConnectionConfig,
        action_id: &str,
        runtime_host: &str,
        runtime_port: u16,
        runtime_proxy: Option<PluginRuntimeProxy>,
    ) -> Result<PluginConnectionActionResult, String> {
        let _activity = self
            .inner
            .registry
            .lifecycle
            .begin_connection(config.plugin_id.as_deref().unwrap_or_default(), &config.name)?;
        let (_, provider) = self.resolve_connection_provider(config)?;
        let action = plugin_invoke_connection_action(&provider, action_id)?;
        validate_plugin_connection_values_for_action(config, &provider, action.requires_valid_form)?;
        let session = self.activate(config.plugin_id.as_deref().unwrap_or_default()).await?;
        let mut params =
            plugin_connection_params(config, &provider, runtime_host, runtime_port, runtime_proxy.as_ref())?;
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

    /// Runtime-aware uninstall. The lifecycle update lease is taken *before* the sidecar is stopped
    /// and held until the store-level uninstall committed, so nothing can re-activate the plugin
    /// and re-lock its container between the runtime stop and the filesystem rename. It also keeps
    /// `PluginHost::sessions` and the plugin store consistent: the session is removed and the
    /// container gone before the lease is released.
    ///
    /// Callers drain the plugin's connection pools and external driver pools first: the lease is
    /// refused while the plugin still has an active connection or operation.
    pub async fn uninstall_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let _update = self.inner.registry.lifecycle.begin_update(plugin_id)?;
        self.stop(plugin_id).await;
        let root_dir = self.inner.registry.root_dir().to_path_buf();
        let app_version = self.inner.registry.app_version().to_string();
        // Uninstall never validates a package signature, so it must not load the user trust store.
        let installer = PluginPackageInstaller::with_trust_store(root_dir, app_version, PluginTrustStore::default());
        let plugin_id = plugin_id.to_string();
        tokio::task::spawn_blocking(move || installer.uninstall(&plugin_id)).await.map_err(|error| error.to_string())?
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

/// RPC deadline for connection/test and connection/connect. A config-bound
/// `connect_timeout_secs` field is the plugin's own handshake timeout (the SSH
/// plugin defaults it to 30 and lets advanced users tune it), so the host
/// deadline must never fire first: the resolved plugin value wins — stored
/// `external_config` first, then the manifest default for configs whose value
/// was never materialized (imports, MCP, older hosts) — and only plugins that
/// do not declare the field at all keep the generic built-in fallback.
fn plugin_connect_deadline(config: &ConnectionConfig, provider: &PluginConnectionProviderContribution) -> Duration {
    fn positive_timeout(value: &serde_json::Value) -> Option<u64> {
        value.as_u64().or_else(|| value.as_f64().map(|n| n.max(0.0) as u64)).filter(|secs| *secs > 0)
    }
    let plugin_timeout = provider.fields.iter().find(|field| field.key == "connect_timeout_secs").and_then(|field| {
        config
            .external_config
            .as_ref()
            .and_then(|external| external.get("connect_timeout_secs"))
            .and_then(positive_timeout)
            .or_else(|| field.default.as_ref().and_then(positive_timeout))
    });
    let secs = plugin_timeout.unwrap_or_else(|| config.effective_connect_timeout_secs());
    Duration::from_secs(secs.clamp(1, 300))
}

fn plugin_connection_params(
    config: &ConnectionConfig,
    provider: &PluginConnectionProviderContribution,
    runtime_host: &str,
    runtime_port: u16,
    runtime_proxy: Option<&PluginRuntimeProxy>,
) -> Result<serde_json::Value, String> {
    let mut runtime = serde_json::json!({
        "host": runtime_host,
        "port": runtime_port,
    });
    if let Some(proxy) = runtime_proxy {
        runtime["proxy"] = serde_json::to_value(proxy).map_err(|error| error.to_string())?;
    }
    Ok(serde_json::json!({
        "provider": {
            "id": provider.id,
            "databaseType": provider.database_type,
        },
        "connection": serde_json::to_value(config).map_err(|error| error.to_string())?,
        "runtime": runtime,
        "operationId": uuid::Uuid::new_v4().to_string(),
    }))
}

/// A host-managed SOCKS5 route handed to a plugin through
/// `runtime.proxy`. Providers declaring `proxy_route` (multi-endpoint
/// targets such as Kafka) dial every advertised broker through this route
/// instead of a static tunnel, which can only reach a single endpoint.
/// Credentials ride the same encrypted lifecycle channel as connection
/// secrets and must never be logged by the plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRuntimeProxy {
    #[serde(rename = "type")]
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub username: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub password: String,
}

impl PluginRuntimeProxy {
    pub fn socks5(host: String, port: u16, username: String, password: String) -> Self {
        Self { proxy_type: "socks5".to_string(), host, port, username, password }
    }
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
        // Required enforcement is condition-aware (Host API 1.1): fields hidden
        // by `visible_when` or only conditionally required via `required_when`
        // are validated against the current stored values, mirroring the
        // connection dialog's `pluginFieldConditions` semantics. This keeps
        // non-dialog write paths (MCP/import) from unconditionally rejecting
        // connections whose protocol-specific fields are simply not visible.
        if require_required_fields
            && plugin_field_is_visible(field, config, provider)
            && plugin_field_is_required(field, config, provider)
            && plugin_field_value_is_empty(value.as_ref())
        {
            return Err(format!("Plugin connection field '{}' is required", field.label));
        }
        // A stored JSON null means "unset" (older dialog builds wrote nulls for
        // untouched optional fields); it must not fail the declared type check.
        if let Some(value) = value.filter(|value| !value.is_null()) {
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

/// Resolves the stored value of one plugin form field (a condition's operand).
fn plugin_condition_field_value(
    key: &str,
    config: &ConnectionConfig,
    provider: &PluginConnectionProviderContribution,
) -> Option<serde_json::Value> {
    let sibling = provider.fields.iter().find(|field| field.key == key)?;
    plugin_connection_field_value(config, sibling)
}

/// Evaluates a plugin manifest field condition (`visible_when` / `required_when`,
/// Host API 1.1) against the stored connection values. Mirrors the frontend
/// `pluginFieldConditions.ts` semantics: a leaf matches when the current value
/// of the referenced sibling field is listed in `one_of`, and a missing sibling
/// field or an unset/empty value never matches; `all_of` / `any_of` / `not`
/// compose those clauses.
fn plugin_field_condition_matches(
    condition: &super::PluginFieldCondition,
    config: &ConnectionConfig,
    provider: &PluginConnectionProviderContribution,
) -> bool {
    condition.matches(&|key| plugin_condition_field_value(key, config, provider))
}

/// A field participates in the form when its `visible_when` (if any) matches.
/// Mirrors the frontend cascade (`pluginFieldConditions.ts`): a clause only
/// counts while the sibling it reads is itself visible — a hidden container
/// field's stored default (e.g. `krb_credential_type: "password"` while auth is
/// simple) must not mark grandchild fields visible + required, otherwise
/// non-dialog write paths reject connections the dialog accepts.
fn plugin_field_is_visible(
    field: &PluginFormFieldDefinition,
    config: &ConnectionConfig,
    provider: &PluginConnectionProviderContribution,
) -> bool {
    let mut seen = HashSet::new();
    seen.insert(field.key.clone());
    plugin_field_is_visible_cached(field, config, provider, &mut seen)
}

fn plugin_field_is_visible_cached(
    field: &PluginFormFieldDefinition,
    config: &ConnectionConfig,
    provider: &PluginConnectionProviderContribution,
    seen: &mut HashSet<String>,
) -> bool {
    let Some(condition) = &field.visible_when else {
        return true;
    };
    plugin_field_condition_is_visible(condition, config, provider, seen)
}

/// Visibility-aware evaluation of one condition expression, mirroring the
/// frontend `conditionExpressionVisible`: a clause only counts while the field
/// it reads is itself visible, `any_of`/`all_of` compose those verdicts, and
/// `not` additionally requires every operand to be visible (an inverted hidden
/// value is not a usable answer).
fn plugin_field_condition_is_visible(
    condition: &super::PluginFieldCondition,
    config: &ConnectionConfig,
    provider: &PluginConnectionProviderContribution,
    seen: &mut HashSet<String>,
) -> bool {
    match condition {
        super::PluginFieldCondition::Field(clause) => {
            if !plugin_field_condition_matches(condition, config, provider) {
                return false;
            }
            plugin_field_key_is_visible(&clause.field, config, provider, seen)
        }
        super::PluginFieldCondition::AllOf { all_of } => {
            all_of.iter().all(|child| plugin_field_condition_is_visible(child, config, provider, seen))
        }
        super::PluginFieldCondition::AnyOf { any_of } => {
            any_of.iter().any(|child| plugin_field_condition_is_visible(child, config, provider, seen))
        }
        super::PluginFieldCondition::Not { not } => {
            let operands_visible =
                not.referenced_fields().iter().all(|key| plugin_field_key_is_visible(key, config, provider, seen));
            operands_visible && !plugin_field_condition_matches(not, config, provider)
        }
    }
}

/// Whether the sibling field behind one referenced key is itself rendered.
/// Cycles count as visible, mirroring the frontend's `seen` guard.
fn plugin_field_key_is_visible(
    key: &str,
    config: &ConnectionConfig,
    provider: &PluginConnectionProviderContribution,
    seen: &mut HashSet<String>,
) -> bool {
    let Some(sibling) = provider.fields.iter().find(|candidate| candidate.key == key) else {
        return true;
    };
    if seen.contains(&sibling.key) {
        return true;
    }
    seen.insert(sibling.key.clone());
    let visible = plugin_field_is_visible_cached(sibling, config, provider, seen);
    seen.remove(&sibling.key);
    visible
}

/// Effective required = static `required` OR a matching `required_when`
/// (a missing `required_when` never implies required).
fn plugin_field_is_required(
    field: &PluginFormFieldDefinition,
    config: &ConnectionConfig,
    provider: &PluginConnectionProviderContribution,
) -> bool {
    if field.required {
        return true;
    }
    match &field.required_when {
        None => false,
        Some(condition) => plugin_field_condition_matches(condition, config, provider),
    }
}

fn validate_plugin_field_type(field: &PluginFormFieldDefinition, value: &serde_json::Value) -> Result<(), String> {
    let valid = match field.field_type {
        PluginFormFieldType::Text
        | PluginFormFieldType::Password
        | PluginFormFieldType::Select
        | PluginFormFieldType::Radio
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
        plugin_connect_deadline, plugin_connection_action_result, plugin_connection_params, plugin_field_is_visible,
        plugin_invoke_connection_action, validate_plugin_connection_values,
        validate_plugin_connection_values_for_action, PluginRuntimeProxy,
    };
    use crate::models::connection::ConnectionConfig;
    use crate::plugins::PluginConnectionProviderContribution;

    #[tokio::test]
    async fn uninstall_plugin_holds_one_update_lease_across_the_runtime_and_the_store() {
        use crate::plugins::installer::PLUGIN_TRASH_DIR;
        use crate::plugins::{PluginHost, PluginRegistry};

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        let plugin_dir = root.join("sample.hello");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("manifest.json"),
            serde_json::json!({ "id": "sample.hello", "name": "Sample", "version": "1.0.0", "protocol_version": 1 })
                .to_string(),
        )
        .unwrap();
        let registry = PluginRegistry::new_with_app_version(root.clone(), "0.5.67");
        let lifecycle = registry.lifecycle();
        let host = PluginHost::new(registry);

        // An active operation refuses the uninstall before anything is stopped or deleted, so the
        // caller still sees a complete, discoverable plugin.
        let operation = lifecycle.begin_operation("sample.hello").unwrap();
        let refused = host.uninstall_plugin("sample.hello").await.unwrap_err();
        assert!(refused.contains("active operations"), "{refused}");
        assert!(plugin_dir.join("manifest.json").is_file(), "a refused uninstall must not touch the container");
        drop(operation);

        host.uninstall_plugin("sample.hello").await.unwrap();
        assert!(!plugin_dir.exists());
        let tombstones = std::fs::read_dir(root.join(PLUGIN_TRASH_DIR)).map(|entries| entries.count()).unwrap_or(0);
        assert_eq!(tombstones, 0, "a successful uninstall sweeps its tombstone");

        // The lease is released again, and it was scoped to just this plugin.
        assert!(lifecycle.begin_update("sample.hello").is_ok());
        assert!(lifecycle.begin_update("sample.other").is_ok());
    }

    #[tokio::test]
    async fn ui_only_connections_hold_update_guards_but_saved_configs_do_not() {
        let root = tempfile::tempdir().unwrap();
        let plugin_dir = root.path().join("sample.ui");
        std::fs::create_dir(&plugin_dir).unwrap();
        std::fs::write(plugin_dir.join("index.html"), "<html></html>").unwrap();
        std::fs::write(
            plugin_dir.join("manifest.json"),
            serde_json::json!({
                "manifest_version": 1,
                "id": "sample.ui",
                "name": "Sample UI",
                "version": "1.0.0",
                "publisher": "sample",
                "engines": { "dbx": ">=0.5.0", "host_api": "^1.0" },
                "entrypoints": { "ui": { "entry": "index.html" } },
                "contributions": [{
                    "type": "connection-provider",
                    "id": "sample.connection",
                    "database_type": "sample"
                }]
            })
            .to_string(),
        )
        .unwrap();
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "saved-connection",
            "name": "Saved UI connection",
            "db_type": "plugin",
            "host": "localhost",
            "port": 0,
            "username": "",
            "password": "",
            "plugin_id": "sample.ui",
            "plugin_connection_provider": "sample.connection",
            "plugin_connection_type": "sample"
        }))
        .unwrap();
        let registry = crate::plugins::PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");
        let lifecycle = registry.lifecycle();
        let host = super::PluginHost::new(registry);
        let update = lifecycle.begin_update("sample.ui").unwrap();
        assert!(host.connect_connection(&config, "localhost", 0, None).await.is_err());
        drop(update);
        let connection = host.connect_connection(&config, "localhost", 0, None).await.unwrap();
        assert!(lifecycle.begin_update("sample.ui").unwrap_err().contains("Saved UI connection"));
        connection.disconnect().await.unwrap();
        drop(connection);
        assert!(lifecycle.begin_update("sample.ui").is_ok());
    }

    #[test]
    fn connect_deadline_follows_the_provider_declared_timeout_field() {
        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "sample.connection",
            "label": "Sample",
            "database_type": "sample",
            "fields": [{ "key": "connect_timeout_secs", "label": "Connect timeout", "type": "number", "default": 30 }]
        }))
        .unwrap();
        let config_with = |timeout: u64, external: Option<u64>| {
            serde_json::from_value::<ConnectionConfig>(serde_json::json!({
                "id": "plugin-connection",
                "name": "Plugin connection",
                "db_type": "plugin",
                "host": "localhost",
                "port": 0,
                "username": "",
                "password": "",
                "connect_timeout_secs": timeout,
                "external_config": external.map_or(serde_json::json!({}), |secs| serde_json::json!({ "connect_timeout_secs": secs })),
                "plugin_id": "sample",
                "plugin_connection_provider": "sample.connection",
                "plugin_connection_type": "sample"
            }))
            .unwrap()
        };

        // Unmaterialized typed value (0): the manifest default becomes the deadline.
        assert_eq!(plugin_connect_deadline(&config_with(0, None), &provider), std::time::Duration::from_secs(30));
        // A stored plugin-field value wins over the typed field: the plugin's own
        // handshake timeout and the host deadline must never disagree.
        assert_eq!(plugin_connect_deadline(&config_with(10, Some(60)), &provider), std::time::Duration::from_secs(60));
        assert_eq!(plugin_connect_deadline(&config_with(5, None), &provider), std::time::Duration::from_secs(30));

        // Providers without the well-known field keep the typed/generic behavior.
        let provider_without_default: PluginConnectionProviderContribution =
            serde_json::from_value(serde_json::json!({
                "id": "sample.connection",
                "label": "Sample",
                "database_type": "sample"
            }))
            .unwrap();
        assert_eq!(
            plugin_connect_deadline(&config_with(0, Some(60)), &provider_without_default),
            std::time::Duration::from_secs(10)
        );
        assert_eq!(
            plugin_connect_deadline(&config_with(5, None), &provider_without_default),
            std::time::Duration::from_secs(5)
        );
    }

    #[test]
    fn connection_params_embed_optional_socks5_proxy_route() {
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
            "fields": []
        }))
        .unwrap();

        let without = plugin_connection_params(&config, &provider, "", 0, None).unwrap();
        assert!(without["runtime"].get("proxy").is_none());

        let proxy = PluginRuntimeProxy::socks5("127.0.0.1".to_string(), 1080, "user".to_string(), "pass".to_string());
        let with = plugin_connection_params(&config, &provider, "k1", 9092, Some(&proxy)).unwrap();
        assert_eq!(with["runtime"]["proxy"]["type"], "socks5");
        assert_eq!(with["runtime"]["proxy"]["host"], "127.0.0.1");
        assert_eq!(with["runtime"]["proxy"]["port"], 1080);
        assert_eq!(with["runtime"]["proxy"]["username"], "user");
    }

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
    fn tolerates_stored_null_config_values_for_type_check() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "plugin-connection",
            "name": "Plugin connection",
            "db_type": "plugin",
            "host": "localhost",
            "port": 22,
            "username": "root",
            "password": "",
            "database": null,
            "plugin_id": "sample",
            "plugin_connection_provider": "sample.connection",
            "plugin_connection_type": "sample",
            "external_config": { "authentication": "agent", "agent_socket": null }
        }))
        .unwrap();
        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "sample.connection",
            "label": "Sample",
            "database_type": "sample",
            "fields": [
                {
                    "key": "authentication",
                    "label": "Authentication",
                    "type": "select",
                    "binding": "config",
                    "default": "password",
                    "options": [
                        { "value": "password", "label": "Password" },
                        { "value": "agent", "label": "Agent" }
                    ]
                },
                { "key": "agent_socket", "label": "Agent socket", "type": "text", "binding": "config" }
            ]
        }))
        .unwrap();

        assert!(validate_plugin_connection_values(&config, &provider).is_ok());
    }

    /// Mirrors the files plugin manifest shape: `bucket` is required only when
    /// `protocol` selects `s3` (`required_when` paired with `visible_when`).
    #[test]
    fn conditional_required_field_enforced_only_when_condition_matches() {
        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "sample.connection",
            "label": "Sample",
            "database_type": "sample",
            "fields": [
                {
                    "key": "protocol",
                    "label": "Protocol",
                    "type": "select",
                    "binding": "config",
                    "required": true,
                    "default": "fs",
                    "options": [
                        { "value": "fs", "label": "fs" },
                        { "value": "s3", "label": "s3" }
                    ]
                },
                {
                    "key": "bucket",
                    "label": "Bucket",
                    "type": "text",
                    "binding": "config",
                    "visible_when": { "field": "protocol", "one_of": ["s3"] },
                    "required_when": { "field": "protocol", "one_of": ["s3"] }
                }
            ]
        }))
        .unwrap();
        let config_for = |external: serde_json::Value| -> ConnectionConfig {
            serde_json::from_value(serde_json::json!({
                "id": "plugin-connection",
                "name": "Plugin connection",
                "db_type": "plugin",
                "host": "localhost",
                "port": 22,
                "username": "",
                "password": "",
                "database": null,
                "plugin_id": "sample",
                "plugin_connection_provider": "sample.connection",
                "plugin_connection_type": "sample",
                "external_config": external
            }))
            .unwrap()
        };

        // fs: bucket not visible → not required → connection accepted.
        assert!(
            validate_plugin_connection_values(&config_for(serde_json::json!({ "protocol": "fs" })), &provider).is_ok()
        );
        // s3: bucket visible and conditionally required → empty bucket rejected.
        assert!(validate_plugin_connection_values(&config_for(serde_json::json!({ "protocol": "s3" })), &provider)
            .unwrap_err()
            .contains("field 'Bucket' is required"));
        // s3 with a bucket value passes.
        assert!(validate_plugin_connection_values(
            &config_for(serde_json::json!({ "protocol": "s3", "bucket": "demo" })),
            &provider
        )
        .is_ok());
        // Whitespace-only values count as empty.
        assert!(validate_plugin_connection_values(
            &config_for(serde_json::json!({ "protocol": "s3", "bucket": "  " })),
            &provider
        )
        .unwrap_err()
        .contains("field 'Bucket' is required"));
    }

    #[test]
    fn statically_required_field_only_enforced_while_visible() {
        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "sample.connection",
            "label": "Sample",
            "database_type": "sample",
            "fields": [
                {
                    "key": "mode",
                    "label": "Mode",
                    "type": "select",
                    "binding": "config",
                    "default": "simple",
                    "options": [
                        { "value": "simple", "label": "Simple" },
                        { "value": "custom", "label": "Custom" }
                    ]
                },
                {
                    "key": "secret_key",
                    "label": "Secret key",
                    "type": "password",
                    "binding": "secret",
                    "required": true,
                    "visible_when": { "field": "mode", "one_of": ["custom"] }
                }
            ]
        }))
        .unwrap();
        let config_for = |external: serde_json::Value, secrets: serde_json::Value| -> ConnectionConfig {
            serde_json::from_value(serde_json::json!({
                "id": "plugin-connection",
                "name": "Plugin connection",
                "db_type": "plugin",
                "host": "localhost",
                "port": 22,
                "username": "",
                "password": "",
                "database": null,
                "plugin_id": "sample",
                "plugin_connection_provider": "sample.connection",
                "plugin_connection_type": "sample",
                "external_config": external,
                "connection_secrets": secrets
            }))
            .unwrap()
        };

        // Hidden static-required field must not block the connection.
        assert!(validate_plugin_connection_values(
            &config_for(serde_json::json!({ "mode": "simple" }), serde_json::json!({})),
            &provider
        )
        .is_ok());
        // Visible and empty → rejected.
        assert!(validate_plugin_connection_values(
            &config_for(serde_json::json!({ "mode": "custom" }), serde_json::json!({})),
            &provider
        )
        .unwrap_err()
        .contains("field 'Secret key' is required"));
        // Visible and filled → accepted.
        assert!(validate_plugin_connection_values(
            &config_for(serde_json::json!({ "mode": "custom" }), serde_json::json!({ "secret_key": "k" })),
            &provider
        )
        .is_ok());
    }

    #[test]
    fn required_when_referencing_missing_sibling_field_is_never_required() {
        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "sample.connection",
            "label": "Sample",
            "database_type": "sample",
            "fields": [
                { "key": "root", "label": "Root", "type": "text", "binding": "config" },
                {
                    "key": "orphan",
                    "label": "Orphan",
                    "type": "text",
                    "binding": "config",
                    "required_when": { "field": "ghost", "one_of": ["x"] }
                }
            ]
        }))
        .unwrap();
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "plugin-connection",
            "name": "Plugin connection",
            "db_type": "plugin",
            "host": "localhost",
            "port": 22,
            "username": "",
            "password": "",
            "database": null,
            "plugin_id": "sample",
            "plugin_connection_provider": "sample.connection",
            "plugin_connection_type": "sample"
        }))
        .unwrap();

        assert!(validate_plugin_connection_values(&config, &provider).is_ok());
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

    /// Mirrors the ldap plugin manifest shape: `krb_password` conditions on
    /// `krb_credential_type`, which is itself hidden unless `auth_type` is
    /// `kerberos`. A stored default on the hidden container field ("password")
    /// must not make `krb_password` visible + required — the connection dialog
    /// (cascading visibility) accepts such a save, so validation must too.
    #[test]
    fn cascaded_hidden_container_default_does_not_force_grandchild_required() {
        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "ldap.connection",
            "label": "LDAP",
            "database_type": "ldap",
            "fields": [
                {
                    "key": "auth_type",
                    "label": "Authentication",
                    "type": "select",
                    "binding": "config",
                    "default": "simple",
                    "options": [
                        { "value": "simple", "label": "Simple" },
                        { "value": "kerberos", "label": "Kerberos (GSSAPI)" }
                    ]
                },
                {
                    "key": "krb_credential_type",
                    "label": "Kerberos credential type",
                    "type": "select",
                    "binding": "config",
                    "default": "password",
                    "visible_when": { "field": "auth_type", "one_of": ["kerberos"] },
                    "options": [
                        { "value": "password", "label": "Password" },
                        { "value": "keytab", "label": "Keytab" }
                    ]
                },
                {
                    "key": "krb_password",
                    "label": "Kerberos password",
                    "type": "password",
                    "binding": "secret",
                    "visible_when": { "field": "krb_credential_type", "one_of": ["password"] },
                    "required_when": { "field": "krb_credential_type", "one_of": ["password"] }
                }
            ]
        }))
        .unwrap();
        let config_for = |external: serde_json::Value| -> ConnectionConfig {
            serde_json::from_value(serde_json::json!({
                "id": "plugin-connection",
                "name": "KN-LDAP",
                "db_type": "plugin",
                "host": "ldap.example.com",
                "port": 389,
                "username": "",
                "password": "",
                "database": null,
                "plugin_id": "io.dbx.ldap",
                "plugin_connection_provider": "ldap.connection",
                "plugin_connection_type": "ldap",
                "external_config": external
            }))
            .unwrap()
        };

        // Simple auth with the stale stored default on the hidden container
        // field: dialog saves it, host must not demand the hidden secret.
        let simple = config_for(serde_json::json!({ "auth_type": "simple", "krb_credential_type": "password" }));
        assert!(validate_plugin_connection_values(&simple, &provider).is_ok());

        // Kerberos + password credential type: the grandchild is genuinely
        // visible and required, and the empty secret must still be rejected.
        let kerberos = config_for(serde_json::json!({ "auth_type": "kerberos", "krb_credential_type": "password" }));
        assert!(validate_plugin_connection_values(&kerberos, &provider)
            .unwrap_err()
            .contains("Kerberos password' is required"));

        // Cycle guard: mutual references must not hang or misclassify.
        let cyclic: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "cyclic.connection",
            "label": "Cyclic",
            "database_type": "cyclic",
            "fields": [
                { "key": "a", "label": "A", "type": "text", "binding": "config",
                  "visible_when": { "field": "b", "one_of": ["x"] } },
                { "key": "b", "label": "B", "type": "text", "binding": "config",
                  "visible_when": { "field": "a", "one_of": ["x"] } }
            ]
        }))
        .unwrap();
        let cyclic_config = config_for(serde_json::json!({ "a": "x", "b": "x" }));
        assert!(validate_plugin_connection_values(&cyclic_config, &cyclic).is_ok());
    }

    #[test]
    fn condition_sibling_branches_keep_cycle_detection_path_local() {
        let mut provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "test.connection",
            "database_type": "test",
            "fields": [
                { "key": "mode", "label": "Mode", "type": "text" },
                {
                    "key": "auth", "label": "Auth", "type": "text",
                    "visible_when": { "field": "mode", "one_of": ["enabled"] }
                },
                { "key": "flag", "label": "Flag", "type": "boolean" },
                { "key": "target", "label": "Target", "type": "text", "required": true }
            ]
        }))
        .unwrap();
        let mut config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "plugin-connection", "name": "Test", "db_type": "plugin",
            "host": "", "port": 0, "username": "", "password": ""
        }))
        .unwrap();
        let clause = serde_json::json!({ "field": "auth", "one_of": ["password"] });
        let branches = [
            serde_json::json!({ "all_of": [clause, { "field": "flag", "one_of": [true] }] }),
            serde_json::json!({ "all_of": [{ "field": "flag", "one_of": [false] }, clause] }),
        ];
        for condition in [
            clause.clone(),
            serde_json::json!({ "any_of": [clause, clause] }),
            serde_json::json!({ "all_of": [clause, clause] }),
            serde_json::json!({ "any_of": [branches[0], branches[1]] }),
            serde_json::json!({ "any_of": [branches[1], branches[0]] }),
        ] {
            provider.fields[3].visible_when = Some(serde_json::from_value(condition.clone()).unwrap());
            for flag in [false, true] {
                for (mode, expected) in [("disabled", false), ("enabled", true)] {
                    config.external_config =
                        Some(serde_json::json!({ "mode": mode, "auth": "password", "flag": flag }));
                    assert_eq!(
                        plugin_field_is_visible(&provider.fields[3], &config, &provider),
                        expected,
                        "{condition}"
                    );
                    assert_eq!(validate_plugin_connection_values(&config, &provider).is_err(), expected, "{condition}");
                }
            }
        }
        provider.fields[3].visible_when = Some(
            serde_json::from_value(serde_json::json!({
                "not": { "any_of": [clause, clause] }
            }))
            .unwrap(),
        );
        for (mode, expected) in [("disabled", false), ("enabled", true)] {
            config.external_config = Some(serde_json::json!({ "mode": mode, "auth": "token" }));
            assert_eq!(plugin_field_is_visible(&provider.fields[3], &config, &provider), expected);
        }
    }

    #[test]
    fn condition_cycles_still_require_matching_values() {
        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "test.connection",
            "database_type": "test",
            "fields": [
                { "key": "first", "label": "First", "type": "text", "visible_when": { "field": "second", "one_of": ["on"] } },
                { "key": "second", "label": "Second", "type": "text", "visible_when": { "field": "first", "one_of": ["on"] } },
                { "key": "self", "label": "Self", "type": "text", "visible_when": { "field": "self", "one_of": ["on"] } },
                { "key": "unknown", "label": "Unknown", "type": "text", "visible_when": { "field": "missing", "one_of": ["on"] } }
            ]
        }))
        .unwrap();
        let mut config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "plugin-connection", "name": "Test", "db_type": "plugin",
            "host": "", "port": 0, "username": "", "password": ""
        }))
        .unwrap();
        for (value, expected) in [("on", true), ("off", false)] {
            config.external_config =
                Some(serde_json::json!({ "first": value, "second": "on", "self": value, "missing": value }));
            for field in &provider.fields {
                assert_eq!(
                    plugin_field_is_visible(field, &config, &provider),
                    expected && field.key != "unknown",
                    "{}",
                    field.key
                );
            }
        }
    }

    /// Mirrors the SSH plugin shape the composite contract was added for:
    /// `sudo_command` is required only while `sudo_source = custom` **and**
    /// `read_only = false`, which the single-clause contract could not express.
    #[test]
    fn composite_condition_gates_required_fields_like_the_dialog() {
        let provider: PluginConnectionProviderContribution = serde_json::from_value(serde_json::json!({
            "id": "ssh.connection",
            "label": "SSH",
            "database_type": "ssh",
            "fields": [
                {
                    "key": "read_only",
                    "label": "Read only",
                    "type": "boolean",
                    "binding": "config",
                    "default": false
                },
                {
                    "key": "sudo_source",
                    "label": "Sudo source",
                    "type": "select",
                    "binding": "config",
                    "default": "none",
                    "options": [
                        { "value": "none", "label": "None" },
                        { "value": "custom", "label": "Custom" }
                    ]
                },
                {
                    "key": "sudo_command",
                    "label": "Sudo command",
                    "type": "text",
                    "binding": "config",
                    "visible_when": {
                        "all_of": [
                            { "field": "sudo_source", "one_of": ["custom"] },
                            { "field": "read_only", "one_of": [false] }
                        ]
                    },
                    "required_when": {
                        "all_of": [
                            { "field": "sudo_source", "one_of": ["custom"] },
                            { "not": { "field": "read_only", "one_of": [true] } }
                        ]
                    }
                }
            ]
        }))
        .unwrap();
        let config_for = |external: serde_json::Value| -> ConnectionConfig {
            serde_json::from_value(serde_json::json!({
                "id": "plugin-connection",
                "name": "Prod SSH",
                "db_type": "plugin",
                "host": "ssh.example.com",
                "port": 22,
                "username": "root",
                "password": "",
                "database": null,
                "plugin_id": "io.dbx.ssh",
                "plugin_connection_provider": "ssh.connection",
                "plugin_connection_type": "ssh",
                "external_config": external
            }))
            .unwrap()
        };

        // Read-only sessions ignore the sudo block: nothing is required.
        assert!(validate_plugin_connection_values(
            &config_for(serde_json::json!({ "sudo_source": "custom", "read_only": true })),
            &provider
        )
        .is_ok());
        // Sudo stays off: nothing is required either.
        assert!(validate_plugin_connection_values(
            &config_for(serde_json::json!({ "sudo_source": "none", "read_only": false })),
            &provider
        )
        .is_ok());
        // Custom sudo on a writable connection: the command becomes required.
        assert!(validate_plugin_connection_values(
            &config_for(serde_json::json!({ "sudo_source": "custom", "read_only": false })),
            &provider
        )
        .unwrap_err()
        .contains("Sudo command' is required"));
        // ...and passes once it is filled in.
        assert!(validate_plugin_connection_values(
            &config_for(
                serde_json::json!({ "sudo_source": "custom", "read_only": false, "sudo_command": "sudo -n true" })
            ),
            &provider
        )
        .is_ok());
    }
}
