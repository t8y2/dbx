use crate::agent_service::AgentProgressEvent;
use crate::plugins::{PluginManifest, SUPPORTED_PLUGIN_PROTOCOL_VERSION};
use crate::update::{fetch_latest_release, is_newer_version, JdbcPluginLatest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::process::Command;

const JDBC_PLUGIN_DOWNLOAD_URL: &str =
    "https://github.com/t8y2/dbx/releases/latest/download/dbx-jdbc-plugin-latest.zip";
const JDBC_PLUGIN_R2_PATH: &str = "releases/latest/dbx-jdbc-plugin-latest.zip";

#[derive(Debug, Clone, Serialize)]
pub struct JdbcDriverInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub bundle_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JdbcMavenInstallRequest {
    pub coordinate: String,
    #[serde(default)]
    pub repositories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JdbcMavenBundleInfo {
    pub id: String,
    pub coordinate: String,
    pub scope: String,
    pub repositories: Vec<String>,
    pub installed_at: String,
    pub path: String,
    pub artifacts: Vec<JdbcMavenArtifactInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JdbcMavenArtifactInfo {
    pub group_id: String,
    pub artifact_id: String,
    pub version: String,
    pub classifier: String,
    pub extension: String,
    pub file_name: String,
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct JdbcPluginStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub protocol_version: Option<u32>,
    pub compatible: bool,
    pub latest_version: Option<String>,
    pub latest_protocol_version: Option<u32>,
    pub update_available: bool,
    pub path: String,
}

// ---- JDBC Drivers ----

pub fn list_jdbc_drivers(plugins_root: &Path) -> Result<Vec<JdbcDriverInfo>, String> {
    list_jdbc_drivers_from_dir(&jdbc_drivers_dir(plugins_root))
}

pub fn list_jdbc_maven_bundles(plugins_root: &Path) -> Result<Vec<JdbcMavenBundleInfo>, String> {
    list_jdbc_maven_bundles_from_dir(&jdbc_maven_drivers_dir(plugins_root))
}

pub fn import_jdbc_drivers(plugins_root: &Path, paths: &[String]) -> Result<Vec<JdbcDriverInfo>, String> {
    let drivers_dir = jdbc_drivers_dir(plugins_root);
    std::fs::create_dir_all(&drivers_dir).map_err(|err| err.to_string())?;

    for path in paths {
        let source = PathBuf::from(path);
        if !source.exists() {
            return Err(format!("Driver JAR does not exist: {}", source.display()));
        }
        if source.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("jar")) != Some(true) {
            return Err(format!("Only .jar files can be imported: {}", source.display()));
        }
        let file_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("Invalid driver file path: {}", source.display()))?;
        let target = unique_target_path(&drivers_dir, file_name);
        if source == target {
            continue;
        }
        std::fs::copy(&source, &target)
            .map_err(|err| format!("Failed to import {} to {}: {err}", source.display(), target.display()))?;
    }

    list_jdbc_drivers_from_dir(&drivers_dir)
}

pub fn delete_jdbc_driver(plugins_root: &Path, path: &str) -> Result<Vec<JdbcDriverInfo>, String> {
    let drivers_dir = jdbc_drivers_dir(plugins_root);
    let drivers_dir = drivers_dir.canonicalize().map_err(|err| err.to_string())?;
    let target = PathBuf::from(path).canonicalize().map_err(|err| err.to_string())?;
    if !target.starts_with(&drivers_dir) {
        return Err("Driver file is outside the JDBC drivers directory".to_string());
    }
    std::fs::remove_file(&target).map_err(|err| err.to_string())?;
    list_jdbc_drivers_from_dir(&drivers_dir)
}

pub fn delete_jdbc_maven_bundle(plugins_root: &Path, bundle_id: &str) -> Result<Vec<JdbcDriverInfo>, String> {
    if !is_safe_bundle_id(bundle_id) {
        return Err("Invalid JDBC Maven bundle id".to_string());
    }
    let bundles_dir = jdbc_maven_drivers_dir(plugins_root);
    let target = bundles_dir.join(bundle_id);
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|err| err.to_string())?;
    }
    list_jdbc_drivers(plugins_root)
}

pub async fn install_jdbc_driver_from_maven(
    plugins_root: &Path,
    request: JdbcMavenInstallRequest,
) -> Result<Vec<JdbcDriverInfo>, String> {
    let coordinate = request.coordinate.trim().to_string();
    if coordinate.is_empty() {
        return Err("Maven coordinate is required".to_string());
    }
    let plugin_dir = plugins_root.join("jdbc");
    let resolver = jdbc_maven_resolver_executable(&plugin_dir);
    if !resolver.exists() {
        return Err("JDBC Maven resolver is not installed. Update or reinstall the JDBC plugin.".to_string());
    }

    let mut repositories = if request.repositories.is_empty() {
        vec!["https://repo.maven.apache.org/maven2/".to_string()]
    } else {
        request.repositories.into_iter().map(|repo| repo.trim().to_string()).filter(|repo| !repo.is_empty()).collect()
    };
    if repositories.is_empty() {
        repositories.push("https://repo.maven.apache.org/maven2/".to_string());
    }
    let local_repo = plugin_dir.join("maven-cache");
    std::fs::create_dir_all(&local_repo).map_err(|err| err.to_string())?;

    let mut command = Command::new(&resolver);
    command.arg("resolve").arg("--coordinate").arg(&coordinate).arg("--local-repo").arg(&local_repo);
    for repo in &repositories {
        command.arg("--repo").arg(repo);
    }
    let output = command.output().await.map_err(|err| format!("Failed to run JDBC Maven resolver: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() { "JDBC Maven resolver failed".to_string() } else { stderr });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let resolved: MavenResolveOutput =
        serde_json::from_str(&stdout).map_err(|err| format!("Failed to parse JDBC Maven resolver output: {err}"))?;
    let root = plugins_root.to_path_buf();
    tokio::task::spawn_blocking(move || install_jdbc_maven_bundle(&root, &coordinate, &resolved))
        .await
        .map_err(|err| err.to_string())??;
    list_jdbc_drivers(plugins_root)
}

// ---- JDBC Plugin ----

pub async fn get_jdbc_plugin_status(plugins_root: &Path) -> Result<JdbcPluginStatus, String> {
    jdbc_plugin_status_from_dir(&plugins_root.join("jdbc")).await
}

pub async fn install_jdbc_plugin(plugins_root: &Path) -> Result<JdbcPluginStatus, String> {
    install_jdbc_plugin_with_progress(plugins_root, |_| {}).await
}

pub async fn install_jdbc_plugin_with_progress(
    plugins_root: &Path,
    progress: impl Fn(AgentProgressEvent),
) -> Result<JdbcPluginStatus, String> {
    let bytes = download_jdbc_plugin_zip_with_progress(&progress).await?;
    let plugin_dir = plugins_root.join("jdbc");
    let status_dir = plugin_dir.clone();
    progress(AgentProgressEvent::transfer("jdbc-plugin-extract", 0, 0));
    tokio::task::spawn_blocking(move || install_jdbc_plugin_zip(&bytes, &plugin_dir))
        .await
        .map_err(|err| err.to_string())??;
    let status = jdbc_plugin_status_from_dir(&status_dir).await;
    progress(AgentProgressEvent::step("done"));
    status
}

pub async fn install_jdbc_plugin_from_file(plugins_root: &Path, file_path: &str) -> Result<JdbcPluginStatus, String> {
    let plugin_dir = plugins_root.join("jdbc");
    let status_dir = plugin_dir.clone();
    let file_path = file_path.to_string();
    tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(file_path).map_err(|e| format!("Failed to read file: {e}"))?;
        install_jdbc_plugin_zip(&bytes, &plugin_dir)
    })
    .await
    .map_err(|err| err.to_string())??;
    jdbc_plugin_status_from_dir(&status_dir).await
}

pub fn uninstall_jdbc_plugin(plugins_root: &Path) -> Result<JdbcPluginStatus, String> {
    let plugin_dir = plugins_root.join("jdbc");
    for entry in ["manifest.json", "bin", "lib"] {
        let path = plugin_dir.join(entry);
        if !path.exists() {
            continue;
        }
        if path.is_dir() {
            std::fs::remove_dir_all(path).map_err(|err| err.to_string())?;
        } else {
            std::fs::remove_file(path).map_err(|err| err.to_string())?;
        }
    }
    // synchronous version: check local manifest only, no network call
    let manifest_path = plugin_dir.join("manifest.json");
    let manifest = match std::fs::read_to_string(&manifest_path) {
        Ok(raw) => Some(serde_json::from_str::<PluginManifest>(&raw).map_err(|err| err.to_string())?),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(err.to_string()),
    };
    Ok(build_plugin_status(&manifest, None, &plugin_dir))
}

// ---- System Fonts ----

pub fn list_system_fonts() -> Vec<String> {
    let source = font_kit::source::SystemSource::new();
    match source.all_families() {
        Ok(families) => {
            use std::collections::BTreeSet;
            families
                .into_iter()
                .map(|family| family.trim().to_string())
                .filter(|family| !family.is_empty())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        }
        Err(_) => vec![],
    }
}

// ---- Internal helpers ----

fn jdbc_drivers_dir(plugins_root: &Path) -> PathBuf {
    plugins_root.join("jdbc").join("drivers")
}

fn jdbc_maven_drivers_dir(plugins_root: &Path) -> PathBuf {
    jdbc_drivers_dir(plugins_root).join("maven")
}

fn jdbc_maven_resolver_executable(plugin_dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        plugin_dir.join("bin").join("dbx-maven-resolver.bat")
    }
    #[cfg(not(windows))]
    {
        plugin_dir.join("bin").join("dbx-maven-resolver")
    }
}

async fn jdbc_plugin_status_from_dir(plugin_dir: &Path) -> Result<JdbcPluginStatus, String> {
    let manifest_path = plugin_dir.join("manifest.json");
    let manifest = match std::fs::read_to_string(&manifest_path) {
        Ok(raw) => Some(serde_json::from_str::<PluginManifest>(&raw).map_err(|err| err.to_string())?),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(err.to_string()),
    };
    let latest = latest_jdbc_plugin().await;
    Ok(build_plugin_status(&manifest, latest.as_ref(), plugin_dir))
}

fn build_plugin_status(
    manifest: &Option<PluginManifest>,
    latest: Option<&JdbcPluginLatest>,
    plugin_dir: &Path,
) -> JdbcPluginStatus {
    let version = manifest.as_ref().and_then(|m| (!m.version.is_empty()).then_some(m.version.clone()));
    let protocol_version = manifest.as_ref().map(|m| m.protocol_version);
    let compatible = match manifest.as_ref() {
        Some(m) => m.protocol_version == SUPPORTED_PLUGIN_PROTOCOL_VERSION,
        None => true,
    };
    let latest_version = latest.map(|plugin| plugin.version.clone());
    let latest_protocol_version = latest.map(|plugin| plugin.protocol_version);
    let update_available = match (version.as_deref(), latest) {
        (Some(current), Some(latest)) if manifest.is_some() => is_newer_version(&latest.version, current),
        (None, Some(_)) if manifest.is_some() => true,
        _ => false,
    };
    JdbcPluginStatus {
        installed: manifest.is_some(),
        version,
        protocol_version,
        compatible,
        latest_version,
        latest_protocol_version,
        update_available,
        path: plugin_dir.to_string_lossy().to_string(),
    }
}

async fn latest_jdbc_plugin() -> Option<JdbcPluginLatest> {
    fetch_latest_release().await.ok().and_then(|release| release.jdbc_plugin)
}

async fn download_jdbc_plugin_zip_with_progress(progress: &impl Fn(AgentProgressEvent)) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|err| err.to_string())?;

    let mut resp =
        crate::race_download(&client, JDBC_PLUGIN_DOWNLOAD_URL, JDBC_PLUGIN_R2_PATH, "dbx-jdbc-plugin-installer")
            .await
            .map_err(|err| format!("Failed to download JDBC plugin: {err}"))?;

    let total = resp.content_length().unwrap_or(0);
    progress(AgentProgressEvent::transfer("jdbc-plugin", 0, total));
    let mut downloaded = 0;
    let mut bytes = Vec::with_capacity(total.try_into().unwrap_or(0));
    while let Some(chunk) = resp.chunk().await.map_err(|err| err.to_string())? {
        downloaded += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);
        progress(AgentProgressEvent::transfer("jdbc-plugin", downloaded, total));
    }
    if total == 0 {
        progress(AgentProgressEvent::transfer("jdbc-plugin", downloaded, downloaded));
    }
    Ok(bytes)
}

fn install_jdbc_plugin_zip(bytes: &[u8], plugin_dir: &Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|err| err.to_string())?;
    let temp_dir = plugin_dir.with_extension("tmp");
    if temp_dir.exists() {
        std::fs::remove_dir_all(&temp_dir).map_err(|err| err.to_string())?;
    }
    std::fs::create_dir_all(&temp_dir).map_err(|err| err.to_string())?;

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|err| err.to_string())?;
        if file.is_dir() {
            continue;
        }
        let Some(enclosed) = file.enclosed_name().map(|path| path.to_path_buf()) else {
            continue;
        };
        let relative = strip_zip_root(&enclosed);
        if relative.as_os_str().is_empty() {
            continue;
        }
        let output = temp_dir.join(relative);
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut target = std::fs::File::create(&output).map_err(|err| err.to_string())?;
        std::io::copy(&mut file, &mut target).map_err(|err| err.to_string())?;
    }

    if !temp_dir.join("manifest.json").exists() {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err("Downloaded JDBC plugin package is missing manifest.json".to_string());
    }
    let manifest_path = temp_dir.join("manifest.json");
    let manifest = std::fs::read_to_string(&manifest_path)
        .map_err(|err| format!("Failed to read downloaded JDBC plugin manifest: {err}"))?;
    let manifest: PluginManifest = serde_json::from_str(&manifest)
        .map_err(|err| format!("Failed to parse downloaded JDBC plugin manifest: {err}"))?;
    if manifest.id != "jdbc" {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(format!("Downloaded plugin has unexpected id '{}'", manifest.id));
    }
    if manifest.protocol_version != SUPPORTED_PLUGIN_PROTOCOL_VERSION {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(format!(
            "Downloaded JDBC plugin uses protocol version {}, but this DBX build supports protocol version {}",
            manifest.protocol_version, SUPPORTED_PLUGIN_PROTOCOL_VERSION
        ));
    }

    let drivers_dir = plugin_dir.join("drivers");
    let temp_drivers_dir = temp_dir.join("drivers");
    if drivers_dir.exists() && !temp_drivers_dir.exists() {
        copy_dir_all(&drivers_dir, &temp_drivers_dir)?;
    }
    if plugin_dir.exists() {
        std::fs::remove_dir_all(plugin_dir).map_err(|err| err.to_string())?;
    }
    std::fs::rename(&temp_dir, plugin_dir).map_err(|err| err.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for executable in ["dbx-jdbc-plugin", "dbx-maven-resolver"] {
            let executable = plugin_dir.join("bin").join(executable);
            if executable.exists() {
                let mut permissions = std::fs::metadata(&executable).map_err(|err| err.to_string())?.permissions();
                permissions.set_mode(0o755);
                std::fs::set_permissions(executable, permissions).map_err(|err| err.to_string())?;
            }
        }
    }

    Ok(())
}

fn strip_zip_root(path: &Path) -> PathBuf {
    let mut components = path.components();
    let first = components.next();
    if let (Some(std::path::Component::Normal(_)), Some(_)) = (first, components.clone().next()) {
        components.collect()
    } else {
        path.to_path_buf()
    }
}

fn copy_dir_all(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|err| err.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        let dest = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn list_jdbc_drivers_from_dir(drivers_dir: &Path) -> Result<Vec<JdbcDriverInfo>, String> {
    let entries = match std::fs::read_dir(drivers_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(err) => return Err(err.to_string()),
    };

    let mut drivers = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if path.file_name().and_then(|name| name.to_str()) == Some("maven") && path.is_dir() {
            append_jdbc_maven_driver_jars(&mut drivers, &path)?;
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("jar")) != Some(true) {
            continue;
        }
        let metadata = entry.metadata().map_err(|err| err.to_string())?;
        drivers.push(JdbcDriverInfo {
            name: path.file_name().and_then(|name| name.to_str()).unwrap_or("driver.jar").to_string(),
            path: path.to_string_lossy().to_string(),
            size: metadata.len(),
            bundle_id: None,
        });
    }
    drivers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(drivers)
}

fn append_jdbc_maven_driver_jars(drivers: &mut Vec<JdbcDriverInfo>, maven_dir: &Path) -> Result<(), String> {
    let entries = match std::fs::read_dir(maven_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let bundle_dir = entry.path();
        if !bundle_dir.is_dir() {
            continue;
        }
        let bundle_id = entry.file_name().to_string_lossy().to_string();
        let jars_dir = bundle_dir.join("jars");
        let jars = match std::fs::read_dir(&jars_dir) {
            Ok(jars) => jars,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err.to_string()),
        };
        for jar in jars {
            let jar = jar.map_err(|err| err.to_string())?;
            let path = jar.path();
            if path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("jar")) != Some(true) {
                continue;
            }
            let metadata = jar.metadata().map_err(|err| err.to_string())?;
            drivers.push(JdbcDriverInfo {
                name: path.file_name().and_then(|name| name.to_str()).unwrap_or("driver.jar").to_string(),
                path: path.to_string_lossy().to_string(),
                size: metadata.len(),
                bundle_id: Some(bundle_id.clone()),
            });
        }
    }
    Ok(())
}

fn list_jdbc_maven_bundles_from_dir(maven_dir: &Path) -> Result<Vec<JdbcMavenBundleInfo>, String> {
    let entries = match std::fs::read_dir(maven_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(err) => return Err(err.to_string()),
    };
    let mut bundles = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let manifest_path = entry.path().join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        let raw = std::fs::read_to_string(&manifest_path).map_err(|err| err.to_string())?;
        bundles.push(serde_json::from_str::<JdbcMavenBundleInfo>(&raw).map_err(|err| err.to_string())?);
    }
    bundles.sort_by(|a, b| a.coordinate.cmp(&b.coordinate));
    Ok(bundles)
}

fn install_jdbc_maven_bundle(
    plugins_root: &Path,
    coordinate: &str,
    resolved: &MavenResolveOutput,
) -> Result<(), String> {
    if resolved.artifacts.is_empty() {
        return Err("Maven resolver did not return any JAR artifacts".to_string());
    }
    let bundle_id = maven_bundle_id(coordinate);
    let bundle_dir = jdbc_maven_drivers_dir(plugins_root).join(&bundle_id);
    let temp_dir = bundle_dir.with_extension("tmp");
    if temp_dir.exists() {
        std::fs::remove_dir_all(&temp_dir).map_err(|err| err.to_string())?;
    }
    std::fs::create_dir_all(temp_dir.join("jars")).map_err(|err| err.to_string())?;

    let mut artifacts = Vec::new();
    for artifact in &resolved.artifacts {
        if !artifact.extension.eq_ignore_ascii_case("jar") {
            continue;
        }
        let source = PathBuf::from(&artifact.file);
        if !source.exists() {
            return Err(format!("Resolved artifact file does not exist: {}", source.display()));
        }
        let file_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("Invalid resolved artifact path: {}", source.display()))?;
        let target = unique_target_path(&temp_dir.join("jars"), file_name);
        std::fs::copy(&source, &target)
            .map_err(|err| format!("Failed to copy {} to {}: {err}", source.display(), target.display()))?;
        let metadata = std::fs::metadata(&target).map_err(|err| err.to_string())?;
        let sha256 = file_sha256(&target)?;
        let final_path = bundle_dir.join("jars").join(target.file_name().unwrap_or_default());
        artifacts.push(JdbcMavenArtifactInfo {
            group_id: artifact.group_id.clone(),
            artifact_id: artifact.artifact_id.clone(),
            version: artifact.version.clone(),
            classifier: artifact.classifier.clone(),
            extension: artifact.extension.clone(),
            file_name: target.file_name().and_then(|name| name.to_str()).unwrap_or(file_name).to_string(),
            path: final_path.to_string_lossy().to_string(),
            size: metadata.len(),
            sha256,
        });
    }
    if artifacts.is_empty() {
        return Err("Maven resolver did not return any JAR artifacts".to_string());
    }
    let manifest = JdbcMavenBundleInfo {
        id: bundle_id.clone(),
        coordinate: resolved.coordinate.clone(),
        scope: resolved.scope.clone(),
        repositories: resolved.repositories.clone(),
        installed_at: chrono::Utc::now().to_rfc3339(),
        path: bundle_dir.to_string_lossy().to_string(),
        artifacts,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|err| err.to_string())?;
    std::fs::write(temp_dir.join("manifest.json"), manifest_json).map_err(|err| err.to_string())?;
    if bundle_dir.exists() {
        std::fs::remove_dir_all(&bundle_dir).map_err(|err| err.to_string())?;
    }
    std::fs::rename(&temp_dir, &bundle_dir).map_err(|err| err.to_string())?;
    Ok(())
}

fn maven_bundle_id(coordinate: &str) -> String {
    let mut id = String::with_capacity(coordinate.len());
    for ch in coordinate.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-') {
            id.push(ch);
        } else {
            id.push('_');
        }
    }
    if id.is_empty() {
        "maven-driver".to_string()
    } else {
        id
    }
}

fn is_safe_bundle_id(bundle_id: &str) -> bool {
    !bundle_id.is_empty() && bundle_id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|err| err.to_string())?;
    let hash = Sha256::digest(bytes);
    Ok(format!("{hash:x}"))
}

#[derive(Debug, Deserialize)]
struct MavenResolveOutput {
    coordinate: String,
    scope: String,
    repositories: Vec<String>,
    artifacts: Vec<MavenResolvedArtifact>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MavenResolvedArtifact {
    group_id: String,
    artifact_id: String,
    version: String,
    classifier: String,
    extension: String,
    file: String,
}

pub fn unique_target_path(dir: &Path, file_name: &str) -> PathBuf {
    let target = dir.join(file_name);
    if !target.exists() {
        return target;
    }

    let path = Path::new(file_name);
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("driver");
    let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("jar");
    for index in 1.. {
        let candidate = dir.join(format!("{stem}-{index}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maven_bundle_install_lists_nested_jars() {
        let root = std::env::temp_dir().join(format!("dbx-jdbc-maven-test-{}", uuid::Uuid::new_v4()));
        let source_dir = root.join("source");
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("demo-driver.jar");
        std::fs::write(&source, b"jar").unwrap();

        let resolved = MavenResolveOutput {
            coordinate: "com.example:demo-driver:1.0.0".to_string(),
            scope: "runtime".to_string(),
            repositories: vec!["https://repo.maven.apache.org/maven2/".to_string()],
            artifacts: vec![MavenResolvedArtifact {
                group_id: "com.example".to_string(),
                artifact_id: "demo-driver".to_string(),
                version: "1.0.0".to_string(),
                classifier: String::new(),
                extension: "jar".to_string(),
                file: source.to_string_lossy().to_string(),
            }],
        };

        install_jdbc_maven_bundle(&root, "com.example:demo-driver:1.0.0", &resolved).unwrap();
        let drivers = list_jdbc_drivers(&root).unwrap();
        assert_eq!(drivers.len(), 1);
        assert_eq!(drivers[0].name, "demo-driver.jar");
        assert_eq!(drivers[0].bundle_id.as_deref(), Some("com.example_demo-driver_1.0.0"));

        let bundles = list_jdbc_maven_bundles(&root).unwrap();
        assert_eq!(bundles.len(), 1);
        assert_eq!(bundles[0].artifacts.len(), 1);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn maven_bundle_ids_are_path_safe() {
        assert_eq!(
            maven_bundle_id("org.apache.hive:hive-jdbc:4.0.1:standalone"),
            "org.apache.hive_hive-jdbc_4.0.1_standalone"
        );
        assert!(is_safe_bundle_id("org.apache.hive_hive-jdbc_4.0.1_standalone"));
        assert!(!is_safe_bundle_id("../hive"));
    }
}
