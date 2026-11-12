use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::AppState;
use crate::agent_connection::agent_connect_params;
use crate::agent_manager::AgentManager;
use crate::models::connection::{ConnectionConfig, DatabaseType};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverConnectionParameter {
    pub name: String,
    #[serde(rename = "type")]
    pub value_type: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub secret: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionParameterMetadata {
    pub available: bool,
    pub parameters: Vec<DriverConnectionParameter>,
}

impl AppState {
    /// Inspect a driver in an isolated runtime. No connection, tunnel, pool or saved config is created.
    /// Native drivers use the application's transport-specific catalog. Older agents can return
    /// method-not-found; callers keep their existing/custom parameters editable in that case.
    pub async fn connection_parameter_metadata(
        &self,
        config: &ConnectionConfig,
    ) -> Result<ConnectionParameterMetadata, String> {
        let timeout = Some(Duration::from_secs(10));
        let parameters: Vec<DriverConnectionParameter> = if config.db_type == DatabaseType::Jdbc {
            let env = self.external_driver_runtime_env("jdbc")?;
            self.plugins
                .invoke_driver_with_env_and_timeout(
                    "jdbc",
                    "connectionParameters",
                    serde_json::json!({ "connection": config }),
                    env,
                    timeout,
                )
                .await?
        } else if let Some(key) = AgentManager::db_type_to_agent_key(&config.db_type, config.driver_profile.as_deref())
        {
            // Native/Go agents don't implement JDBC Driver.getPropertyInfo().
            if self.agent_manager.driver_native_path(key).exists() {
                return Ok(ConnectionParameterMetadata { available: true, parameters: Vec::new() });
            }
            let params =
                agent_connect_params(config, &config.host, config.port, config.effective_database().unwrap_or(""))?;
            let mut client = self
                .agent_manager
                .spawn_with_extra_java_args(
                    &config.db_type,
                    config.driver_profile.as_deref(),
                    &config.agent_java_options,
                )
                .await?;
            // The client owns a dedicated process; dropping it also cleans up after an RPC failure.
            client.call_with_timeout("connection_parameters", params, timeout).await?
        } else {
            Vec::new()
        };
        Ok(ConnectionParameterMetadata { available: true, parameters: sanitize_metadata(parameters) })
    }
}

fn sanitize_metadata(parameters: Vec<DriverConnectionParameter>) -> Vec<DriverConnectionParameter> {
    parameters
        .into_iter()
        .filter(|parameter| !parameter.name.trim().is_empty())
        .filter_map(|mut parameter| {
            let name = parameter.name.to_ascii_lowercase();
            if matches!(name.as_str(), "user" | "username" | "password") {
                return None;
            }
            parameter.secret |=
                ["password", "passwd", "pwd", "token", "secret", "credential", "privatekey", "apikey", "accesskey"]
                    .iter()
                    .any(|part| name.replace(['_', '-'], "").contains(part));
            if parameter.secret {
                parameter.default_value = None;
                parameter.choices = None;
            }
            parameter.source = "driver".to_string();
            Some(parameter)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn does_not_expose_echoed_secrets_or_duplicate_login_fields() {
        let parameters = serde_json::from_value(serde_json::json!([
            { "name": "password", "type": "string", "defaultValue": "login-secret", "source": "driver" },
            { "name": "api_token", "type": "string", "defaultValue": "echoed-secret", "choices": ["echoed-secret"], "source": "driver" },
            { "name": "applicationName", "type": "string", "defaultValue": "DBX", "source": "driver" }
        ])).unwrap();
        let sanitized = sanitize_metadata(parameters);
        assert_eq!(sanitized.len(), 2);
        assert!(sanitized[0].secret);
        assert!(sanitized[0].default_value.is_none());
        assert!(sanitized[0].choices.is_none());
        assert_eq!(sanitized[1].default_value.as_deref(), Some("DBX"));
        assert!(!serde_json::to_string(&sanitized).unwrap().contains("echoed-secret"));
    }
}
