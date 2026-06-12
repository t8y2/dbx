use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

const PLUGIN_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
pub const SUPPORTED_PLUGIN_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default = "default_plugin_protocol_version")]
    pub protocol_version: u32,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub executable: Option<String>,
    #[serde(default)]
    pub drivers: Vec<PluginDriverManifest>,
}

fn default_plugin_protocol_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginDriverManifest {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(default)]
    pub database_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    pub path: PathBuf,
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

    fn apply_to(&self, command: &mut Command) {
        for (key, value) in &self.vars {
            command.env(key, value);
        }
    }
}

#[derive(Debug, Clone)]
pub struct PluginRegistry {
    root_dir: PathBuf,
}

impl PluginRegistry {
    pub fn new(root_dir: PathBuf) -> Self {
        Self { root_dir }
    }

    pub fn root_dir(&self) -> &Path {
        &self.root_dir
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
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let manifest_path = path.join("manifest.json");
            if !manifest_path.exists() {
                continue;
            }
            let raw = std::fs::read_to_string(&manifest_path).map_err(|err| err.to_string())?;
            let manifest: PluginManifest = serde_json::from_str(&raw)
                .map_err(|err| format!("Failed to parse plugin manifest {}: {err}", manifest_path.display()))?;
            plugins.push(InstalledPlugin { manifest, path });
        }
        plugins.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
        Ok(plugins)
    }

    pub fn find_driver(&self, driver_id: &str) -> Result<Option<InstalledPlugin>, String> {
        Ok(self.list_installed()?.into_iter().find(|plugin| {
            plugin
                .manifest
                .drivers
                .iter()
                .any(|driver| driver.id == driver_id || driver.database_type.as_deref() == Some(driver_id))
        }))
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
        ensure_plugin_protocol_compatible(&plugin.manifest)?;
        let invoke = invoke_plugin(&plugin, driver_id, method, params, &env);
        match timeout_duration {
            Some(duration) => timeout(duration, invoke).await.map_err(|_| {
                format!("Plugin '{}' timed out after {} seconds", plugin.manifest.id, duration.as_secs())
            })?,
            None => invoke.await,
        }
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
        ensure_plugin_protocol_compatible(&plugin.manifest)?;
        PluginDriverSession::start(plugin, driver_id.to_string(), env).await.map(Arc::new)
    }
}

fn ensure_plugin_protocol_compatible(manifest: &PluginManifest) -> Result<(), String> {
    if manifest.protocol_version == SUPPORTED_PLUGIN_PROTOCOL_VERSION {
        return Ok(());
    }
    Err(format!(
        "Plugin '{}' uses protocol version {}, but this DBX build supports protocol version {}",
        manifest.id, manifest.protocol_version, SUPPORTED_PLUGIN_PROTOCOL_VERSION
    ))
}

#[derive(Debug, Serialize)]
struct PluginRequest {
    jsonrpc: &'static str,
    id: u64,
    driver: String,
    method: String,
    params: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct PluginResponse {
    id: u64,
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<PluginError>,
}

#[derive(Debug, Deserialize)]
struct PluginError {
    message: String,
}

pub struct PluginDriverSession {
    plugin: InstalledPlugin,
    driver_id: String,
    process: Mutex<PluginProcess>,
    next_request_id: AtomicU64,
}

struct PluginProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl PluginDriverSession {
    async fn start(plugin: InstalledPlugin, driver_id: String, env: PluginRuntimeEnv) -> Result<Self, String> {
        let mut child = spawn_plugin_child(&plugin, &env)?;
        let stdin = child.stdin.take().ok_or("Plugin stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Plugin stdout unavailable")?;
        if let Some(stderr) = child.stderr.take() {
            let plugin_id = plugin.manifest.id.clone();
            tokio::spawn(async move {
                let mut stderr = BufReader::new(stderr);
                loop {
                    match read_plugin_line(&mut stderr, "stderr").await {
                        Ok(line) => log::warn!("[plugin:{plugin_id}] {}", line.trim_end()),
                        Err(err) if err.contains("end of stream") => break,
                        Err(err) => {
                            log::warn!("[plugin:{plugin_id}] failed to read stderr: {err}");
                            break;
                        }
                    }
                }
            });
        }

        Ok(Self {
            plugin,
            driver_id,
            process: Mutex::new(PluginProcess { child, stdin, stdout: BufReader::new(stdout) }),
            next_request_id: AtomicU64::new(1),
        })
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
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let invoke = async {
            let mut process = self.process.lock().await;
            self.invoke_locked(&mut process, request_id, method, params).await
        };
        match timeout_duration {
            Some(duration) => match timeout(duration, invoke).await {
                Ok(result) => result,
                Err(_) => {
                    self.kill().await;
                    Err(format!("Plugin '{}' timed out after {} seconds", self.plugin.manifest.id, duration.as_secs()))
                }
            },
            None => invoke.await,
        }
    }

    async fn invoke_locked<T>(
        &self,
        process: &mut PluginProcess,
        request_id: u64,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T, String>
    where
        T: DeserializeOwned,
    {
        let request = PluginRequest {
            jsonrpc: "2.0",
            id: request_id,
            driver: self.driver_id.clone(),
            method: method.to_string(),
            params,
        };
        let line = encode_plugin_request_line(&request)?;
        process.stdin.write_all(&line).await.map_err(|err| err.to_string())?;
        process.stdin.flush().await.map_err(|err| err.to_string())?;

        let response_line = match read_plugin_line(&mut process.stdout, "response").await {
            Ok(line) => line,
            Err(err) if err.contains("end of stream") => {
                let status = process.child.try_wait().map_err(|err| err.to_string())?;
                return Err(match status {
                    Some(status) => format!("Plugin '{}' exited with status {}", self.plugin.manifest.id, status),
                    None => format!("Plugin '{}' closed stdout without a response", self.plugin.manifest.id),
                });
            }
            Err(err) => return Err(err),
        };
        if response_line.is_empty() {
            let status = process.child.try_wait().map_err(|err| err.to_string())?;
            return Err(match status {
                Some(status) => format!("Plugin '{}' exited with status {}", self.plugin.manifest.id, status),
                None => format!("Plugin '{}' closed stdout without a response", self.plugin.manifest.id),
            });
        }
        decode_plugin_response(&self.plugin, request_id, &response_line)
    }

    async fn kill(&self) {
        let mut process = self.process.lock().await;
        let _ = process.child.kill().await;
    }

    pub async fn pid(&self) -> Option<u32> {
        let process = self.process.lock().await;
        process.child.id()
    }
}

async fn invoke_plugin<T>(
    plugin: &InstalledPlugin,
    driver_id: &str,
    method: &str,
    params: serde_json::Value,
    env: &PluginRuntimeEnv,
) -> Result<T, String>
where
    T: DeserializeOwned,
{
    let mut child = spawn_plugin_child(plugin, env)?;

    let request =
        PluginRequest { jsonrpc: "2.0", id: 1, driver: driver_id.to_string(), method: method.to_string(), params };
    let line = encode_plugin_request_line(&request)?;

    let mut stdin = child.stdin.take().ok_or("Plugin stdin unavailable")?;
    stdin.write_all(&line).await.map_err(|err| err.to_string())?;
    drop(stdin);

    let stdout = child.stdout.take().ok_or("Plugin stdout unavailable")?;
    let mut stderr = child.stderr.take().ok_or("Plugin stderr unavailable")?;
    let mut reader = BufReader::new(stdout);
    let response_line_result = read_plugin_line(&mut reader, "response").await;
    let mut stderr_bytes = Vec::new();
    stderr.read_to_end(&mut stderr_bytes).await.map_err(|err| err.to_string())?;
    let stderr_text = String::from_utf8_lossy(&stderr_bytes).into_owned();
    let status = child.wait().await.map_err(|err| err.to_string())?;

    let response_line = match response_line_result {
        Ok(line) => line,
        Err(err) if err.contains("end of stream") => {
            let stderr = stderr_text.trim().to_string();
            return Err(if stderr.is_empty() {
                format!("Plugin '{}' exited without a response", plugin.manifest.id)
            } else {
                format!("Plugin '{}' exited without a response: {stderr}", plugin.manifest.id)
            });
        }
        Err(err) => return Err(err),
    };
    if response_line.is_empty() {
        let stderr = stderr_text.trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Plugin '{}' exited without a response", plugin.manifest.id)
        } else {
            format!("Plugin '{}' exited without a response: {stderr}", plugin.manifest.id)
        });
    }
    if !status.success() {
        let stderr = stderr_text.trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Plugin '{}' exited with status {}", plugin.manifest.id, status)
        } else {
            format!("Plugin '{}' failed: {stderr}", plugin.manifest.id)
        });
    }

    decode_plugin_response(plugin, request.id, &response_line)
}

fn encode_plugin_request_line(request: &PluginRequest) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    serde_json::to_writer(&mut bytes, request).map_err(|err| err.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn spawn_plugin_child(plugin: &InstalledPlugin, env: &PluginRuntimeEnv) -> Result<Child, String> {
    let executable = plugin
        .manifest
        .executable
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Plugin '{}' does not declare an executable", plugin.manifest.id))?;
    let executable_path = resolve_plugin_executable(&plugin.path, executable);

    let mut command = Command::new(&executable_path);
    command
        .current_dir(&plugin.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    env.apply_to(&mut command);

    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn().map_err(|err| format!("Failed to start plugin '{}': {err}", plugin.manifest.id))
}

async fn read_plugin_line<R>(reader: &mut R, context: &str) -> Result<String, String>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    let mut bytes = Vec::new();
    reader.read_until(b'\n', &mut bytes).await.map_err(|err| format!("Failed to read plugin {context}: {err}"))?;
    if bytes.is_empty() {
        return Err(format!("Failed to read plugin {context}: end of stream"));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn decode_plugin_response<T>(plugin: &InstalledPlugin, request_id: u64, response_line: &str) -> Result<T, String>
where
    T: DeserializeOwned,
{
    let response: PluginResponse = serde_json::from_str(response_line)
        .map_err(|err| format!("Failed to parse plugin '{}' response: {err}", plugin.manifest.id))?;
    if response.id != request_id {
        return Err(format!("Plugin '{}' returned mismatched response id", plugin.manifest.id));
    }
    if let Some(error) = response.error {
        return Err(error.message);
    }
    let result = response.result.unwrap_or(serde_json::Value::Null);
    serde_json::from_value(result)
        .map_err(|err| format!("Failed to decode plugin '{}' result: {err}", plugin.manifest.id))
}

fn resolve_plugin_executable(plugin_dir: &Path, executable: &str) -> PathBuf {
    let path = PathBuf::from(executable);
    let resolved = if path.is_absolute() { path } else { plugin_dir.join(path) };

    #[cfg(windows)]
    {
        let bat = resolved.with_extension("bat");
        if bat.exists() {
            return bat;
        }
    }

    resolved
}

#[cfg(test)]
mod tests {
    use super::read_plugin_line;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn reads_non_utf8_plugin_lines_lossily() {
        let bytes = vec![b'{', b'"', b'e', b'r', b'r', b'o', b'r', b'"', b':', 0xB2, 0xE2, b'}', b'\n'];
        let mut reader = BufReader::new(std::io::Cursor::new(bytes));

        let line = read_plugin_line(&mut reader, "response").await.expect("line should be readable");

        assert_eq!(line, format!("{{\"error\":{}}}\n", "\u{fffd}\u{fffd}"));
    }
}
