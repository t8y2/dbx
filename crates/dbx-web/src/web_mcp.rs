use std::{env, sync::RwLock};

use dbx_core::storage::{Storage, WebMcpSettings};
use dbx_mcp::HttpAuth;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const SECRET_NAMESPACE: &str = "dbx.global";
const SECRET_KEY: &str = "web_mcp_token";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TokenSource {
    Environment,
    File,
    Managed,
    None,
}

struct DeploymentConfig {
    token: String,
    source: TokenSource,
    allowed_hosts: Vec<String>,
    allowed_origins: Vec<String>,
}

impl TokenSource {
    fn as_str(self) -> Option<&'static str> {
        match self {
            Self::Environment => Some("environment"),
            Self::File => Some("file"),
            Self::Managed => Some("managed"),
            Self::None => None,
        }
    }
}

#[derive(Clone, Debug)]
struct RuntimeState {
    settings: WebMcpSettings,
    source: TokenSource,
    token: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebMcpHttpStatus {
    pub enabled: bool,
    pub endpoint_path: String,
    pub token_source: Option<&'static str>,
    pub allowed_hosts: Vec<String>,
    pub allowed_origins: Vec<String>,
    pub deployment_managed: bool,
    pub management_available: bool,
    /// Only Web-managed tokens are returned to the authenticated settings UI.
    /// Deployment-provided secrets are never echoed back by the API.
    pub access_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWebMcpRequest {
    pub enabled: bool,
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    #[serde(default)]
    pub rotate_token: bool,
}

pub struct WebMcpRuntime {
    auth: HttpAuth,
    state: RwLock<RuntimeState>,
    operation_lock: tokio::sync::Mutex<()>,
}

impl WebMcpRuntime {
    pub async fn load(storage: &Storage, allow_managed: bool) -> Result<Self, String> {
        Self::load_with_deployment(storage, deployment_config()?, allow_managed).await
    }

    async fn load_with_deployment(
        storage: &Storage,
        deployment: Option<DeploymentConfig>,
        allow_managed: bool,
    ) -> Result<Self, String> {
        if deployment.is_none() && !allow_managed {
            return Ok(Self::disabled());
        }
        let (token, source, settings) = match deployment {
            Some(deployment) => {
                let settings = WebMcpSettings {
                    enabled: true,
                    allowed_hosts: deployment.allowed_hosts,
                    allowed_origins: deployment.allowed_origins,
                };
                (Some(deployment.token), deployment.source, settings)
            }
            None => {
                let managed_settings = storage.load_web_mcp_settings().await?;
                let token = if managed_settings.enabled {
                    storage.get_secret(SECRET_NAMESPACE, SECRET_KEY).await?
                } else {
                    None
                };
                let source = if managed_settings.enabled { TokenSource::Managed } else { TokenSource::None };
                (token, source, managed_settings)
            }
        };

        validate_settings(&settings, token.as_deref())?;
        let auth = HttpAuth::new_with_hosts(
            token.clone(),
            settings.allowed_hosts.clone(),
            settings.allowed_origins.clone(),
            false,
        )?;
        Ok(Self {
            auth,
            state: RwLock::new(RuntimeState { settings, source, token }),
            operation_lock: tokio::sync::Mutex::new(()),
        })
    }

    pub fn disabled() -> Self {
        Self {
            auth: HttpAuth::new_with_hosts(None, Vec::<String>::new(), Vec::<String>::new(), false).unwrap(),
            state: RwLock::new(RuntimeState {
                settings: WebMcpSettings::default(),
                source: TokenSource::None,
                token: None,
            }),
            operation_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn auth(&self) -> HttpAuth {
        self.auth.clone()
    }

    pub async fn reload(&self, storage: &Storage, allow_managed: bool) -> Result<(), String> {
        let _guard = self.operation_lock.lock().await;
        let refreshed = Self::load(storage, allow_managed).await?;
        let state = refreshed.state.into_inner().unwrap_or_else(|error| error.into_inner());
        self.auth.reconfigure(
            state.token.clone(),
            state.settings.allowed_hosts.clone(),
            state.settings.allowed_origins.clone(),
        )?;
        *self.state.write().unwrap_or_else(|error| error.into_inner()) = state;
        Ok(())
    }

    pub fn allowed_hosts(&self) -> Vec<String> {
        self.state.read().unwrap_or_else(|error| error.into_inner()).settings.allowed_hosts.clone()
    }

    pub fn status(&self, endpoint_path: String, management_available: bool) -> WebMcpHttpStatus {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        let managed = state.source == TokenSource::Managed;
        WebMcpHttpStatus {
            enabled: state.settings.enabled && state.token.is_some(),
            endpoint_path,
            token_source: state.source.as_str(),
            allowed_hosts: state.settings.allowed_hosts.clone(),
            allowed_origins: state.settings.allowed_origins.clone(),
            deployment_managed: matches!(state.source, TokenSource::Environment | TokenSource::File),
            management_available,
            access_token: if managed && management_available { state.token.clone() } else { None },
        }
    }

    pub async fn update(&self, storage: &Storage, request: UpdateWebMcpRequest) -> Result<(), String> {
        let _guard = self.operation_lock.lock().await;
        self.update_locked(storage, request).await
    }

    async fn update_locked(&self, storage: &Storage, request: UpdateWebMcpRequest) -> Result<(), String> {
        if matches!(
            self.state.read().unwrap_or_else(|error| error.into_inner()).source,
            TokenSource::Environment | TokenSource::File
        ) {
            return Err("DBX Web MCP is managed by deployment environment configuration".to_string());
        }

        let settings = WebMcpSettings {
            enabled: request.enabled,
            allowed_hosts: normalize_list(request.allowed_hosts),
            allowed_origins: normalize_list(request.allowed_origins),
        };
        let current_token = storage.get_secret(SECRET_NAMESPACE, SECRET_KEY).await?;
        let token = if settings.enabled {
            if request.rotate_token || current_token.is_none() {
                Some(generate_token())
            } else {
                current_token
            }
        } else {
            None
        };
        validate_settings(&settings, token.as_deref())?;

        storage.save_web_mcp_credentials(&settings, token.as_deref()).await?;
        self.auth.reconfigure(token.clone(), settings.allowed_hosts.clone(), settings.allowed_origins.clone())?;
        *self.state.write().unwrap_or_else(|error| error.into_inner()) = RuntimeState {
            settings,
            source: if token.is_some() { TokenSource::Managed } else { TokenSource::None },
            token,
        };
        Ok(())
    }

    pub async fn rotate(&self, storage: &Storage) -> Result<(), String> {
        let _guard = self.operation_lock.lock().await;
        let settings = self.state.read().unwrap_or_else(|error| error.into_inner()).settings.clone();
        if !settings.enabled {
            return Err("DBX Web MCP is not enabled".to_string());
        }
        self.update_locked(
            storage,
            UpdateWebMcpRequest {
                enabled: true,
                allowed_hosts: settings.allowed_hosts,
                allowed_origins: settings.allowed_origins,
                rotate_token: true,
            },
        )
        .await
    }
}

fn deployment_config() -> Result<Option<DeploymentConfig>, String> {
    let inline = env::var("DBX_WEB_MCP_TOKEN").ok();
    let file = env::var("DBX_WEB_MCP_TOKEN_FILE").ok();
    let token_and_source = match (inline, file) {
        (Some(_), Some(_)) => Err("set only one of DBX_WEB_MCP_TOKEN or DBX_WEB_MCP_TOKEN_FILE".to_string()),
        (Some(token), None) => validate_token(token).map(|token| Some((token, TokenSource::Environment))),
        (None, Some(path)) => std::fs::read_to_string(&path)
            .map_err(|error| format!("failed to read DBX_WEB_MCP_TOKEN_FILE: {error}"))
            .map(|token| token.trim_end_matches(['\r', '\n']).to_string())
            .and_then(validate_token)
            .map(|token| Some((token, TokenSource::File))),
        (None, None) => Ok(None),
    }?;
    Ok(token_and_source.map(|(token, source)| DeploymentConfig {
        token,
        source,
        allowed_hosts: comma_separated_env("DBX_WEB_MCP_ALLOWED_HOSTS"),
        allowed_origins: comma_separated_env("DBX_WEB_MCP_ALLOWED_ORIGINS"),
    }))
}

fn validate_settings(settings: &WebMcpSettings, token: Option<&str>) -> Result<(), String> {
    if settings.enabled && token.is_none() {
        return Err("DBX Web MCP is enabled but no token is configured".to_string());
    }
    if settings.enabled && settings.allowed_hosts.is_empty() {
        return Err("DBX_WEB_MCP_ALLOWED_HOSTS or a Web MCP allowed Host is required".to_string());
    }
    HttpAuth::new_with_hosts(
        token.map(ToOwned::to_owned),
        settings.allowed_hosts.clone(),
        settings.allowed_origins.clone(),
        false,
    )?;
    Ok(())
}

fn validate_token(token: String) -> Result<String, String> {
    if token.is_empty() || token.contains(char::is_whitespace) {
        return Err("MCP HTTP bearer token must be non-empty and contain no whitespace".to_string());
    }
    Ok(token)
}

fn generate_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn normalize_list(values: Vec<String>) -> Vec<String> {
    let mut normalized = values
        .into_iter()
        .flat_map(|value| value.split([',', '\n']).map(str::trim).map(ToOwned::to_owned).collect::<Vec<_>>())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn comma_separated_env(name: &str) -> Vec<String> {
    normalize_list(env::var(name).ok().into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_storage() -> (tempfile::TempDir, Storage) {
        let dir = tempfile::tempdir().unwrap();
        let storage = dbx_core::persistence::test_storage::open(&dir.path().join("dbx.db")).await.unwrap();
        (dir, storage)
    }

    fn request(enabled: bool, hosts: &[&str], rotate_token: bool) -> UpdateWebMcpRequest {
        UpdateWebMcpRequest {
            enabled,
            allowed_hosts: hosts.iter().map(|host| host.to_string()).collect(),
            allowed_origins: vec!["https://client.example.test".to_string()],
            rotate_token,
        }
    }

    #[test]
    fn deployment_token_rejects_whitespace() {
        assert!(validate_token(" token".to_string()).is_err());
        assert!(validate_token("token ".to_string()).is_err());
        assert!(validate_token("token\n".to_string()).is_err());
    }

    #[tokio::test]
    async fn managed_token_survives_restart_and_is_encrypted() {
        let (_dir, storage) = test_storage().await;
        let runtime = WebMcpRuntime::load_with_deployment(&storage, None, true).await.unwrap();
        assert!(!runtime.status("/mcp".to_string(), true).enabled);

        runtime.update(&storage, request(true, &["dbx.example.test:4224"], false)).await.unwrap();
        let status = runtime.status("/mcp".to_string(), true);
        let token = status.access_token.clone().unwrap();
        assert!(status.enabled);
        assert_eq!(token.len(), 64);
        assert_eq!(status.token_source, Some("managed"));
        assert!(!serde_json::to_string(&storage.load_web_mcp_settings().await.unwrap()).unwrap().contains(&token));

        let restarted = WebMcpRuntime::load_with_deployment(&storage, None, true).await.unwrap();
        assert_eq!(restarted.status("/mcp".to_string(), true).access_token.as_deref(), Some(token.as_str()));
    }

    #[tokio::test]
    async fn rotate_and_disable_update_live_auth() {
        let (_dir, storage) = test_storage().await;
        let runtime = WebMcpRuntime::load_with_deployment(&storage, None, true).await.unwrap();
        runtime.update(&storage, request(true, &["dbx.example.test:4224"], false)).await.unwrap();
        let old = runtime.status("/mcp".to_string(), true).access_token.unwrap();

        runtime.rotate(&storage).await.unwrap();
        let new = runtime.status("/mcp".to_string(), true).access_token.unwrap();
        assert_ne!(old, new);
        assert!(runtime.auth.enabled());

        runtime.update(&storage, request(false, &[], false)).await.unwrap();
        assert!(!runtime.auth.enabled());
        assert!(!runtime.status("/mcp".to_string(), true).enabled);
        assert!(storage.get_secret(SECRET_NAMESPACE, SECRET_KEY).await.unwrap().is_none());
        assert!(
            !WebMcpRuntime::load_with_deployment(&storage, None, true)
                .await
                .unwrap()
                .status("/mcp".to_string(), true)
                .enabled
        );
    }

    #[tokio::test]
    async fn deployment_token_overrides_managed_settings() {
        let (_dir, storage) = test_storage().await;
        let runtime = WebMcpRuntime::load_with_deployment(&storage, None, true).await.unwrap();
        runtime.update(&storage, request(true, &["dbx.example.test:4224"], false)).await.unwrap();
        let managed = runtime.status("/mcp".to_string(), true).access_token.unwrap();

        let deployed = WebMcpRuntime::load_with_deployment(
            &storage,
            Some(DeploymentConfig {
                token: "deployment-secret".to_string(),
                source: TokenSource::Environment,
                allowed_hosts: vec!["deployed.example.test:4224".to_string()],
                allowed_origins: vec![],
            }),
            false,
        )
        .await
        .unwrap();
        let status = deployed.status("/mcp".to_string(), true);
        assert!(status.enabled);
        assert!(status.deployment_managed);
        assert_eq!(status.token_source, Some("environment"));
        assert_eq!(status.allowed_hosts, ["deployed.example.test:4224"]);
        assert!(status.access_token.is_none());
        assert!(deployed.update(&storage, request(false, &[], false)).await.is_err());
        assert_eq!(storage.get_secret(SECRET_NAMESPACE, SECRET_KEY).await.unwrap().as_deref(), Some(managed.as_str()));
        assert!(
            !WebMcpRuntime::load_with_deployment(&storage, None, false)
                .await
                .unwrap()
                .status("/mcp".to_string(), false)
                .enabled
        );
        assert_eq!(
            WebMcpRuntime::load_with_deployment(&storage, None, true)
                .await
                .unwrap()
                .status("/mcp".to_string(), true)
                .access_token
                .as_deref(),
            Some(managed.as_str())
        );
    }

    #[tokio::test]
    async fn invalid_host_or_origin_does_not_enable_mcp() {
        let (_dir, storage) = test_storage().await;
        let runtime = WebMcpRuntime::load_with_deployment(&storage, None, true).await.unwrap();
        assert!(runtime.update(&storage, request(true, &["https://dbx.example.test"], false)).await.is_err());
        assert!(!runtime.auth.enabled());
        assert!(storage.get_secret(SECRET_NAMESPACE, SECRET_KEY).await.unwrap().is_none());
    }
}
