use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::process::Command;

mod assets;
mod filesystem;
mod host;
mod installer;
mod manifest;
mod marketplace;
mod runtime;

pub use assets::PluginUiAsset;
pub use filesystem::{
    PluginFilesystemEntry, PluginFilesystemEntryKind, PluginFilesystemListResult, PluginFilesystemMutationResult,
    PluginFilesystemReadResult, DEFAULT_PLUGIN_FILESYSTEM_PAGE_SIZE, DEFAULT_PLUGIN_FILESYSTEM_PREVIEW_BYTES,
    MAX_PLUGIN_FILESYSTEM_INLINE_WRITE_BYTES, MAX_PLUGIN_FILESYSTEM_PAGE_SIZE, MAX_PLUGIN_FILESYSTEM_PREVIEW_BYTES,
    PLUGIN_FILESYSTEM_CREATE_DIRECTORY_METHOD, PLUGIN_FILESYSTEM_DELETE_METHOD, PLUGIN_FILESYSTEM_LIST_METHOD,
    PLUGIN_FILESYSTEM_READ_METHOD, PLUGIN_FILESYSTEM_RENAME_METHOD, PLUGIN_FILESYSTEM_WRITE_METHOD,
};
pub use host::{ActivePluginSession, PluginConnectionActionResult, PluginConnectionHandle, PluginHost};
pub use installer::{
    PluginInstallPolicy, PluginInstallResponse, PluginInstallResult, PluginPackageInstaller, PluginRollbackResponse,
    PluginRollbackResult, PluginSignatureStatus, PluginTrustStore, PluginTrustedKey, DBXP_EXTENSION,
    MAX_PLUGIN_PACKAGE_BYTES, PLUGIN_CHECKSUMS_FILE, PLUGIN_SIGNATURE_FILE,
};
pub use marketplace::{
    PluginMarketplace, PluginMarketplaceArtifact, PluginMarketplaceCatalog, PluginMarketplaceInstallRequest,
    PluginMarketplaceLocalization, PluginMarketplacePlugin, PluginMarketplaceRepositoryMetadata,
    PluginMarketplaceVersion, PluginRepository, PluginRepositoryCatalogResult, PluginRepositoryKind,
    PluginRepositoryStore, MAX_PLUGIN_CATALOG_BYTES, OFFICIAL_PLUGIN_REPOSITORY_ID, SUPPORTED_PLUGIN_CATALOG_VERSION,
};

pub use manifest::{
    current_plugin_target, resolve_safe_plugin_path, PluginBackendEntrypoint, PluginBackendTransport,
    PluginCompatibility, PluginConnectionActionContribution, PluginConnectionActionVariant, PluginConnectionActionWhen,
    PluginConnectionCapability, PluginConnectionProviderContribution, PluginContribution, PluginDriverManifest,
    PluginEngines, PluginEntrypoints, PluginFilesystemCapability, PluginFilesystemProviderContribution,
    PluginFormFieldBinding, PluginFormFieldDefinition, PluginFormFieldOption, PluginFormFieldType, PluginManifest,
    PluginUiEntrypoint, PluginWorkbenchContribution, PLUGIN_CONNECTION_ACTION_METHOD, PLUGIN_CONNECTION_CONNECT_METHOD,
    PLUGIN_CONNECTION_DISCONNECT_METHOD, PLUGIN_CONNECTION_TEST_METHOD, SUPPORTED_PLUGIN_HOST_API_VERSION,
    SUPPORTED_PLUGIN_MANIFEST_VERSION, SUPPORTED_PLUGIN_PERMISSIONS, SUPPORTED_PLUGIN_PROTOCOL_VERSION,
};
pub use runtime::{
    PluginBinaryMessage, PluginEvent, PluginHandshake, PluginHandshakeIdentity, PluginSessionState,
    PluginSessionStatus, PluginSidecarSession, PLUGIN_REQUEST_TIMEOUT,
};

#[derive(Debug, Clone)]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    pub path: PathBuf,
    pub compatibility: PluginCompatibility,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginInfo {
    pub manifest: PluginManifest,
    pub compatibility: PluginCompatibilityInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCompatibilityInfo {
    pub compatible: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl InstalledPlugin {
    pub fn new(manifest: PluginManifest, path: PathBuf, app_version: &str) -> Self {
        let compatibility = manifest.compatibility(&path, app_version);
        Self { manifest, path, compatibility }
    }

    pub fn info(&self) -> InstalledPluginInfo {
        InstalledPluginInfo {
            manifest: self.manifest.clone(),
            compatibility: PluginCompatibilityInfo {
                compatible: self.compatibility.compatible,
                errors: self.compatibility.errors.clone(),
                warnings: self.compatibility.warnings.clone(),
                target: self.compatibility.target.clone(),
            },
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PluginRuntimeEnv {
    vars: Vec<(String, String)>,
}

impl PluginRuntimeEnv {
    pub fn with_var(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.vars.push((key.into(), value.into()));
        self
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.vars.iter().find_map(|(name, value)| (name == key).then_some(value.as_str()))
    }

    pub fn apply_to(&self, command: &mut Command) {
        for (key, value) in &self.vars {
            command.env(key, value);
        }
    }
}

#[derive(Debug, Clone)]
pub struct PluginRegistry {
    root_dir: PathBuf,
    app_version: String,
}

impl PluginRegistry {
    pub fn new(root_dir: PathBuf) -> Self {
        Self::new_with_app_version(root_dir, env!("CARGO_PKG_VERSION"))
    }

    pub fn new_with_app_version(root_dir: PathBuf, app_version: impl Into<String>) -> Self {
        Self { root_dir, app_version: app_version.into() }
    }

    pub fn root_dir(&self) -> &Path {
        &self.root_dir
    }

    pub fn app_version(&self) -> &str {
        &self.app_version
    }

    pub fn list_installed(&self) -> Result<Vec<InstalledPlugin>, String> {
        let entries = match std::fs::read_dir(&self.root_dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(err) => return Err(err.to_string()),
        };

        let mut plugins = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|err| err.to_string())?;
            let container_path = entry.path();
            if !container_path.is_dir() {
                continue;
            }
            let path = match installer::resolve_active_plugin_dir(&container_path) {
                Ok(Some(path)) => path,
                Ok(None) => continue,
                Err(error) => {
                    plugins.push(unavailable_plugin(container_path, error));
                    continue;
                }
            };
            let manifest_path = path.join("manifest.json");
            if !manifest_path.exists() {
                continue;
            }
            let raw = match std::fs::read_to_string(&manifest_path) {
                Ok(raw) => raw,
                Err(error) => {
                    plugins.push(unavailable_plugin(
                        container_path,
                        format!("Failed to read plugin manifest {}: {error}", manifest_path.display()),
                    ));
                    continue;
                }
            };
            let manifest: PluginManifest = match serde_json::from_str(&raw) {
                Ok(manifest) => manifest,
                Err(error) => {
                    plugins.push(unavailable_plugin(
                        container_path,
                        format!("Failed to parse plugin manifest {}: {error}", manifest_path.display()),
                    ));
                    continue;
                }
            };
            plugins.push(InstalledPlugin::new(manifest, path, &self.app_version));
        }
        plugins.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
        Ok(plugins)
    }

    pub fn find_driver(&self, driver_id: &str) -> Result<Option<InstalledPlugin>, String> {
        Ok(self.list_installed()?.into_iter().find(|plugin| {
            plugin.compatibility.compatible
                && plugin
                    .manifest
                    .drivers
                    .iter()
                    .any(|driver| driver.id == driver_id || driver.database_type.as_deref() == Some(driver_id))
        }))
    }

    pub fn find_plugin(&self, plugin_id: &str) -> Result<Option<InstalledPlugin>, String> {
        Ok(self.list_installed()?.into_iter().find(|plugin| plugin.manifest.id == plugin_id))
    }

    pub async fn invoke_driver<T>(&self, driver_id: &str, method: &str, params: serde_json::Value) -> Result<T, String>
    where
        T: DeserializeOwned,
    {
        self.invoke_driver_with_env(driver_id, method, params, PluginRuntimeEnv::default()).await
    }

    pub async fn invoke_driver_with_env<T>(
        &self,
        driver_id: &str,
        method: &str,
        params: serde_json::Value,
        env: PluginRuntimeEnv,
    ) -> Result<T, String>
    where
        T: DeserializeOwned,
    {
        self.invoke_driver_with_env_and_timeout(driver_id, method, params, env, Some(PLUGIN_REQUEST_TIMEOUT)).await
    }

    pub async fn invoke_driver_with_env_and_timeout<T>(
        &self,
        driver_id: &str,
        method: &str,
        params: serde_json::Value,
        env: PluginRuntimeEnv,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String>
    where
        T: DeserializeOwned,
    {
        let plugin =
            self.find_driver(driver_id)?.ok_or_else(|| format!("Plugin driver '{driver_id}' is not installed"))?;
        ensure_plugin_compatible(&plugin)?;
        let session = PluginSidecarSession::start(plugin, self.app_version.clone(), env).await?;
        let result = session.invoke_with_timeout(method, params, Some(driver_id), timeout_duration).await;
        session.shutdown().await;
        result
    }

    pub async fn start_driver_session(&self, driver_id: &str) -> Result<Arc<PluginDriverSession>, String> {
        self.start_driver_session_with_env(driver_id, PluginRuntimeEnv::default()).await
    }

    pub async fn start_driver_session_with_env(
        &self,
        driver_id: &str,
        env: PluginRuntimeEnv,
    ) -> Result<Arc<PluginDriverSession>, String> {
        let plugin =
            self.find_driver(driver_id)?.ok_or_else(|| format!("Plugin driver '{driver_id}' is not installed"))?;
        ensure_plugin_compatible(&plugin)?;
        PluginDriverSession::start(plugin, driver_id.to_string(), self.app_version.clone(), env).await.map(Arc::new)
    }
}

fn unavailable_plugin(path: PathBuf, error: String) -> InstalledPlugin {
    let id = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("invalid-plugin")
        .to_string();
    InstalledPlugin {
        manifest: PluginManifest {
            id: id.clone(),
            name: id,
            version: "0.0.0-invalid".to_string(),
            description: error.clone(),
            ..PluginManifest::default()
        },
        path,
        compatibility: PluginCompatibility {
            compatible: false,
            errors: vec![error],
            target: Some(current_plugin_target()),
            ..PluginCompatibility::default()
        },
    }
}

fn ensure_plugin_compatible(plugin: &InstalledPlugin) -> Result<(), String> {
    if plugin.compatibility.compatible {
        return Ok(());
    }
    Err(format!("Plugin '{}' is incompatible: {}", plugin.manifest.id, plugin.compatibility.errors.join("; ")))
}

pub struct PluginDriverSession {
    sidecar: Arc<PluginSidecarSession>,
    driver_id: String,
}

impl PluginDriverSession {
    async fn start(
        plugin: InstalledPlugin,
        driver_id: String,
        app_version: String,
        env: PluginRuntimeEnv,
    ) -> Result<Self, String> {
        let sidecar = PluginSidecarSession::start(plugin, app_version, env).await?;
        Ok(Self { sidecar, driver_id })
    }

    pub async fn invoke<T>(&self, method: &str, params: serde_json::Value) -> Result<T, String>
    where
        T: DeserializeOwned,
    {
        self.invoke_with_timeout(method, params, Some(PLUGIN_REQUEST_TIMEOUT)).await
    }

    pub async fn invoke_with_timeout<T>(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String>
    where
        T: DeserializeOwned,
    {
        self.sidecar.invoke_with_timeout(method, params, Some(&self.driver_id), timeout_duration).await
    }

    pub async fn shutdown(&self) {
        self.sidecar.shutdown().await;
    }

    pub async fn pid(&self) -> Option<u32> {
        self.sidecar.pid().await
    }

    pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<PluginEvent> {
        self.sidecar.subscribe_events()
    }

    pub fn subscribe_binary(&self) -> tokio::sync::broadcast::Receiver<PluginBinaryMessage> {
        self.sidecar.subscribe_binary()
    }

    pub async fn send_binary(&self, channel: &str, data: &[u8]) -> Result<(), String> {
        self.sidecar.send_binary(channel, data).await
    }

    #[cfg(all(test, unix))]
    pub(crate) async fn start_for_test(
        plugin: InstalledPlugin,
        driver_id: String,
        env: PluginRuntimeEnv,
    ) -> Result<Self, String> {
        Self::start(plugin, driver_id, env!("CARGO_PKG_VERSION").to_string(), env).await
    }
}

#[cfg(test)]
mod tests {
    use super::{InstalledPlugin, PluginContribution, PluginManifest, PluginRegistry};
    #[cfg(unix)]
    use super::{PluginDriverManifest, PluginDriverSession, PluginRuntimeEnv};

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_kills_plugin_child_process() {
        let dir = std::env::temp_dir().join(format!("dbx-plugin-shutdown-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let executable = dir.join("plugin.sh");
        std::fs::write(&executable, "#!/bin/sh\nsleep 30\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&executable, permissions).unwrap();
        }
        let plugin = InstalledPlugin::new(
            PluginManifest {
                id: "jdbc".to_string(),
                name: "JDBC".to_string(),
                version: "test".to_string(),
                protocol_version: 1,
                description: String::new(),
                executable: Some("plugin.sh".to_string()),
                drivers: vec![PluginDriverManifest {
                    id: "jdbc".to_string(),
                    label: "JDBC".to_string(),
                    kind: "external".to_string(),
                    database_type: Some("jdbc".to_string()),
                }],
                contributions: Vec::new(),
                ..PluginManifest::default()
            },
            dir.clone(),
            env!("CARGO_PKG_VERSION"),
        );

        let session = PluginDriverSession::start(
            plugin,
            "jdbc".to_string(),
            env!("CARGO_PKG_VERSION").to_string(),
            PluginRuntimeEnv::default(),
        )
        .await
        .expect("session should start");
        let pid = session.pid().await.expect("child should have a pid");

        session.shutdown().await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        assert!(!process_exists(pid));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        std::process::Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[test]
    fn preserves_typed_contributions_in_manifest_round_trip() {
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "sample",
            "name": "Sample",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "host_api": "1" },
            "contributions": [{
                "type": "connection-provider",
                "id": "sample.connection",
                "database_type": "sample",
                "fields": []
            }]
        }))
        .expect("manifest should parse");

        assert!(matches!(
            &manifest.contributions[0],
            PluginContribution::ConnectionProvider(provider) if provider.id == "sample.connection"
        ));
        let serialized = serde_json::to_value(manifest).expect("manifest should serialize");
        assert_eq!(serialized["contributions"][0]["database_type"], "sample");
    }

    #[test]
    fn registry_lists_frontend_contributions_from_disk() {
        let root = std::env::temp_dir().join(format!("dbx-plugin-registry-test-{}", uuid::Uuid::new_v4()));
        let plugin_dir = root.join("sample");
        std::fs::create_dir_all(&plugin_dir).expect("plugin directory should be created");
        std::fs::write(
            plugin_dir.join("manifest.json"),
            serde_json::json!({
                "manifest_version": 1,
                "id": "sample",
                "name": "Sample",
                "version": "1.0.0",
                "publisher": "example",
                "engines": { "host_api": "1" },
                "contributions": [{
                    "type": "connection-provider",
                    "id": "sample.connection",
                    "database_type": "sample",
                    "fields": []
                }]
            })
            .to_string(),
        )
        .expect("manifest should be written");

        let plugins = PluginRegistry::new(root.clone()).list_installed().expect("plugins should be listed");

        assert_eq!(plugins.len(), 1);
        assert!(matches!(
            &plugins[0].manifest.contributions[0],
            PluginContribution::ConnectionProvider(provider) if provider.id == "sample.connection"
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn registry_keeps_other_plugins_visible_when_one_manifest_is_corrupt() {
        let root = std::env::temp_dir().join(format!("dbx-plugin-corrupt-registry-test-{}", uuid::Uuid::new_v4()));
        let valid = root.join("valid");
        let corrupt = root.join("corrupt");
        std::fs::create_dir_all(&valid).unwrap();
        std::fs::create_dir_all(&corrupt).unwrap();
        std::fs::write(
            valid.join("manifest.json"),
            serde_json::json!({ "id": "valid", "name": "Valid", "drivers": [] }).to_string(),
        )
        .unwrap();
        std::fs::write(corrupt.join("manifest.json"), "{").unwrap();

        let plugins = PluginRegistry::new(root.clone()).list_installed().unwrap();

        assert_eq!(plugins.len(), 2);
        assert!(plugins.iter().any(|plugin| plugin.manifest.id == "valid" && plugin.compatibility.compatible));
        assert!(plugins.iter().any(|plugin| {
            plugin.manifest.id == "corrupt"
                && !plugin.compatibility.compatible
                && plugin.compatibility.errors.iter().any(|error| error.contains("Failed to parse"))
        }));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn installed_plugin_info_hides_runtime_paths() {
        let plugin = InstalledPlugin::new(
            PluginManifest {
                manifest_version: 1,
                id: "sample".to_string(),
                name: "Sample".to_string(),
                version: "1.0.0".to_string(),
                publisher: "example".to_string(),
                ..PluginManifest::default()
            },
            std::path::PathBuf::from("/private/plugin/install"),
            env!("CARGO_PKG_VERSION"),
        );
        let serialized = serde_json::to_value(plugin.info()).unwrap();

        assert!(serialized.get("path").is_none());
        assert!(serialized["compatibility"].get("backend_executable").is_none());
        assert!(serialized["compatibility"].get("ui_entry").is_none());
        assert!(serialized["compatibility"].get("ui_root").is_none());
    }
}
