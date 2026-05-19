use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::database_capabilities;
use crate::db::agent_driver::{AgentDriverClient, AgentMethod};
use crate::models::connection::DatabaseType;

pub const DEFAULT_JRE_KEY: &str = "17";

fn default_jre_key() -> String {
    DEFAULT_JRE_KEY.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRegistry {
    #[serde(default)]
    pub jre: Option<JreInfo>,
    #[serde(default)]
    pub jres: std::collections::HashMap<String, JreInfo>,
    pub drivers: std::collections::HashMap<String, DriverInfo>,
}

impl AgentRegistry {
    pub fn resolve_jre(&self, key: &str) -> Option<&JreInfo> {
        if !self.jres.is_empty() {
            return self.jres.get(key);
        }
        if key == DEFAULT_JRE_KEY {
            self.jre.as_ref()
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn test_manager(name: &str) -> AgentManager {
        let dir = std::env::temp_dir().join(format!("dbx-agent-manager-{name}-{}", uuid::Uuid::new_v4()));
        AgentManager::new_with_base_dir(dir)
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).unwrap();
        }
    }

    #[test]
    fn resolves_managed_java_runtime_by_default() {
        let manager = test_manager("managed");
        let java = manager.jre_java_path("17");
        touch(&java);

        let state = AgentState::default();

        assert_eq!(manager.resolve_java_runtime(&state, "17").unwrap(), java);
    }

    #[test]
    fn resolves_custom_java_runtime_when_configured() {
        let manager = test_manager("custom");
        let custom_java = manager.base_dir().join("custom").join("bin").join("java");
        touch(&custom_java);
        let state = AgentState {
            java_runtime: JavaRuntimeConfig {
                mode: JavaRuntimeMode::Custom,
                custom_java_path: Some(custom_java.to_string_lossy().to_string()),
            },
            ..AgentState::default()
        };

        assert_eq!(manager.resolve_java_runtime(&state, "17").unwrap(), custom_java);
    }

    #[test]
    fn rejects_missing_custom_java_runtime() {
        let manager = test_manager("missing-custom");
        let state = AgentState {
            java_runtime: JavaRuntimeConfig {
                mode: JavaRuntimeMode::Custom,
                custom_java_path: Some(manager.base_dir().join("missing-java").to_string_lossy().to_string()),
            },
            ..AgentState::default()
        };

        let err = manager.resolve_java_runtime(&state, "17").unwrap_err();

        assert!(err.contains("Custom Java runtime does not exist"));
    }

    #[test]
    fn stores_configured_app_version_for_agent_handshake() {
        let dir = std::env::temp_dir().join(format!("dbx-agent-manager-version-{}", uuid::Uuid::new_v4()));
        let manager = AgentManager::new_with_base_dir_and_app_version(dir, "0.5.13");

        assert_eq!(manager.agent_app_version(), "0.5.13");
    }

    #[test]
    fn resolves_system_java_runtime_from_path() {
        let manager = test_manager("system");
        let system_java = manager.base_dir().join("bin").join(if cfg!(windows) { "java.exe" } else { "java" });
        touch(&system_java);
        let path = std::env::join_paths([system_java.parent().unwrap()]).unwrap();

        assert_eq!(resolve_system_java_path(Some(path.as_os_str())).unwrap(), system_java);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JreInfo {
    pub version: String,
    pub platforms: std::collections::HashMap<String, ArtifactInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriverInfo {
    pub version: String,
    pub label: String,
    pub min_app_version: String,
    pub jar: ArtifactInfo,
    #[serde(default = "default_jre_key")]
    pub jre: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactInfo {
    pub url: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentState {
    #[serde(default)]
    pub jre_version: Option<String>,
    #[serde(default)]
    pub jre_versions: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub installed_drivers: std::collections::HashMap<String, InstalledDriver>,
    #[serde(default)]
    pub java_runtime: JavaRuntimeConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledDriver {
    pub version: String,
    pub installed_at: String,
    #[serde(default = "default_jre_key")]
    pub jre: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum JavaRuntimeMode {
    #[default]
    Managed,
    System,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct JavaRuntimeConfig {
    #[serde(default)]
    pub mode: JavaRuntimeMode,
    #[serde(default)]
    pub custom_java_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDriverInfo {
    pub db_type: String,
    pub label: String,
    pub version: String,
    pub size: u64,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub update_available: bool,
    pub jre: String,
    pub jre_installed: bool,
}

pub struct AgentManager {
    base_dir: PathBuf,
    app_version: String,
    daemons: Mutex<std::collections::HashMap<String, AgentDriverClient>>,
}

impl AgentManager {
    pub fn new() -> Self {
        let home =
            std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_else(|_| ".".to_string());
        Self::new_with_base_dir(PathBuf::from(home).join(".dbx").join("agents"))
    }

    pub fn new_with_base_dir(base_dir: PathBuf) -> Self {
        Self::new_with_base_dir_and_app_version(base_dir, env!("CARGO_PKG_VERSION"))
    }

    pub fn new_with_base_dir_and_app_version(base_dir: PathBuf, app_version: impl Into<String>) -> Self {
        let mgr =
            Self { base_dir, app_version: app_version.into(), daemons: Mutex::new(std::collections::HashMap::new()) };
        mgr.migrate_legacy_jre();
        mgr
    }

    fn migrate_legacy_jre(&self) {
        let legacy = self.base_dir.join("jre");
        let versioned = self.jre_dir(DEFAULT_JRE_KEY);
        if legacy.exists() && !versioned.exists() {
            let _ = std::fs::rename(&legacy, &versioned);
        }
    }

    pub fn base_dir(&self) -> &PathBuf {
        &self.base_dir
    }

    pub fn agent_app_version(&self) -> &str {
        &self.app_version
    }

    pub fn jre_dir(&self, jre_key: &str) -> PathBuf {
        self.base_dir.join(format!("jre-{jre_key}"))
    }

    pub fn jre_java_path(&self, jre_key: &str) -> PathBuf {
        let dir = self.jre_dir(jre_key);
        let java_name = if cfg!(windows) { "java.exe" } else { "java" };
        let flat = dir.join("bin").join(java_name);
        if flat.exists() {
            return flat;
        }
        // macOS Adoptium JRE 8 uses Contents/Home/ layout
        let macos = dir.join("Contents").join("Home").join("bin").join(java_name);
        if macos.exists() {
            return macos;
        }
        flat
    }

    pub fn driver_jar_path(&self, db_type: &str) -> PathBuf {
        self.base_dir.join("drivers").join(db_type).join("agent.jar")
    }

    fn state_path(&self) -> PathBuf {
        self.base_dir.join("state.json")
    }

    pub fn load_state(&self) -> AgentState {
        std::fs::read_to_string(self.state_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn save_state(&self, state: &AgentState) -> Result<(), String> {
        let dir = self.base_dir.clone();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
        std::fs::write(self.state_path(), json).map_err(|e| e.to_string())
    }

    pub fn is_jre_installed(&self, jre_key: &str) -> bool {
        self.jre_java_path(jre_key).exists()
    }

    pub fn is_driver_installed(&self, db_type: &str) -> bool {
        self.driver_jar_path(db_type).exists()
    }

    pub fn resolve_java_runtime(&self, state: &AgentState, jre_key: &str) -> Result<PathBuf, String> {
        match state.java_runtime.mode {
            JavaRuntimeMode::Managed => {
                if !self.is_jre_installed(jre_key) {
                    return Err(format!(
                        "JRE {jre_key} runtime is not installed. Please install it from the Driver Manager."
                    ));
                }
                Ok(self.jre_java_path(jre_key))
            }
            JavaRuntimeMode::System => resolve_system_java_path(None).ok_or_else(|| {
                "System Java runtime was not found on PATH. Please install Java or choose a custom Java executable."
                    .to_string()
            }),
            JavaRuntimeMode::Custom => {
                let path = state
                    .java_runtime
                    .custom_java_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| "Custom Java runtime path is empty. Please choose a Java executable.".to_string())?;
                resolve_custom_java_path(path)
            }
        }
    }

    pub async fn stop_daemons(&self) {
        self.daemons.lock().await.clear();
    }

    pub fn db_type_to_agent_key(db_type: &DatabaseType, driver_profile: Option<&str>) -> Option<&'static str> {
        database_capabilities::agent_key(db_type, driver_profile)
    }

    pub fn is_agent_type(db_type: &DatabaseType) -> bool {
        database_capabilities::is_agent_type(db_type)
    }

    pub async fn spawn(
        &self,
        db_type: &DatabaseType,
        driver_profile: Option<&str>,
    ) -> Result<AgentDriverClient, String> {
        let key = Self::db_type_to_agent_key(db_type, driver_profile)
            .ok_or_else(|| format!("{:?} is not an agent-driven database type", db_type))?;

        let state = self.load_state();
        let jre_key = state.installed_drivers.get(key).map(|d| d.jre.as_str()).unwrap_or(DEFAULT_JRE_KEY);

        if !self.is_driver_installed(key) {
            return Err(format!("{key} driver is not installed. Please install it from the Driver Manager."));
        }

        let java = self.resolve_java_runtime(&state, jre_key)?.to_string_lossy().to_string();
        let jar = self.driver_jar_path(key).to_string_lossy().to_string();
        let mut client = AgentDriverClient::spawn(&java, &jar).await?;
        client.try_optional_handshake(self.agent_app_version()).await;
        Ok(client)
    }

    pub async fn call_daemon<T: serde::de::DeserializeOwned + Send + 'static>(
        &self,
        db_type: &DatabaseType,
        driver_profile: Option<&str>,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T, String> {
        let key = Self::db_type_to_agent_key(db_type, driver_profile)
            .ok_or_else(|| format!("{:?} is not an agent-driven database type", db_type))?
            .to_string();

        let mut daemons = self.daemons.lock().await;

        if !daemons.contains_key(&key) {
            let state = self.load_state();
            let jre_key = state.installed_drivers.get(&key).map(|d| d.jre.as_str()).unwrap_or(DEFAULT_JRE_KEY);

            if !self.is_driver_installed(&key) {
                return Err(format!("{key} driver is not installed. Please install it from the Driver Manager."));
            }
            let java = self.resolve_java_runtime(&state, jre_key)?.to_string_lossy().to_string();
            let jar = self.driver_jar_path(&key).to_string_lossy().to_string();
            let mut client = AgentDriverClient::spawn(&java, &jar).await?;
            client.try_optional_handshake(self.agent_app_version()).await;
            daemons.insert(key.clone(), client);
        }

        let client = daemons.get_mut(&key).unwrap();
        match client.call::<T>(method, params.clone()).await {
            Ok(result) => Ok(result),
            Err(e) => {
                log::warn!("[agent] daemon call failed, respawning: {e}");
                daemons.remove(&key);
                let state = self.load_state();
                let jre_key = state.installed_drivers.get(&key).map(|d| d.jre.as_str()).unwrap_or(DEFAULT_JRE_KEY);
                let java = self.resolve_java_runtime(&state, jre_key)?.to_string_lossy().to_string();
                let jar = self.driver_jar_path(&key).to_string_lossy().to_string();
                let mut new_client = AgentDriverClient::spawn(&java, &jar).await?;
                new_client.try_optional_handshake(self.agent_app_version()).await;
                let result = new_client.call::<T>(method, params).await?;
                daemons.insert(key, new_client);
                Ok(result)
            }
        }
    }

    pub async fn call_daemon_method<T: serde::de::DeserializeOwned + Send + 'static>(
        &self,
        db_type: &DatabaseType,
        driver_profile: Option<&str>,
        method: AgentMethod,
        params: serde_json::Value,
    ) -> Result<T, String> {
        self.call_daemon(db_type, driver_profile, method.as_str(), params).await
    }

    pub async fn download_file(url: &str, dest: &Path) -> Result<(), String> {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let resp = reqwest::get(url).await.map_err(|e| format!("Download failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Download failed with status: {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("Download read failed: {e}"))?;
        std::fs::write(dest, &bytes).map_err(|e| format!("Failed to write file: {e}"))
    }

    pub fn current_platform() -> &'static str {
        if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
            "macos-aarch64"
        } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
            "macos-x64"
        } else if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
            "linux-aarch64"
        } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
            "linux-x64"
        } else if cfg!(target_os = "windows") && cfg!(target_arch = "aarch64") {
            "windows-aarch64"
        } else if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
            "windows-x64"
        } else {
            "unknown"
        }
    }
}

fn java_executable_name() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

fn resolve_custom_java_path(path: &str) -> Result<PathBuf, String> {
    let raw = PathBuf::from(path);
    if is_executable_file(&raw) {
        return Ok(raw);
    }

    let flat = raw.join("bin").join(java_executable_name());
    if is_executable_file(&flat) {
        return Ok(flat);
    }

    let macos = raw.join("Contents").join("Home").join("bin").join(java_executable_name());
    if is_executable_file(&macos) {
        return Ok(macos);
    }

    Err(format!("Custom Java runtime does not exist or is not a Java executable: {}", raw.display()))
}

fn resolve_system_java_path(path_var: Option<&OsStr>) -> Option<PathBuf> {
    let path_var = path_var.map(|p| p.to_owned()).or_else(|| std::env::var_os("PATH"))?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(java_executable_name()))
        .find(|candidate| is_executable_file(candidate))
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        return path.metadata().map(|meta| meta.permissions().mode() & 0o111 != 0).unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        true
    }
}
