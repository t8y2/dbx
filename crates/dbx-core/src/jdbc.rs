use crate::plugins::{PluginManifest, SUPPORTED_PLUGIN_PROTOCOL_VERSION};
use crate::update::{fetch_latest_release, is_newer_version, JdbcPluginLatest};
use serde::Serialize;
use std::path::{Path, PathBuf};

const JDBC_PLUGIN_DOWNLOAD_URL: &str =
    "https://github.com/t8y2/dbx/releases/latest/download/dbx-jdbc-plugin-latest.zip";
const JDBC_PLUGIN_R2_PATH: &str = "releases/latest/dbx-jdbc-plugin-latest.zip";

#[derive(Debug, Clone, Serialize)]
pub struct JdbcDriverInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
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

// ---- JDBC Plugin ----

pub async fn get_jdbc_plugin_status(plugins_root: &Path) -> Result<JdbcPluginStatus, String> {
    jdbc_plugin_status_from_dir(&plugins_root.join("jdbc")).await
}

pub async fn install_jdbc_plugin(plugins_root: &Path) -> Result<JdbcPluginStatus, String> {
    let bytes = download_jdbc_plugin_zip().await?;
    let plugin_dir = plugins_root.join("jdbc");
    let status_dir = plugin_dir.clone();
    tokio::task::spawn_blocking(move || install_jdbc_plugin_zip(&bytes, &plugin_dir))
        .await
        .map_err(|err| err.to_string())??;
    jdbc_plugin_status_from_dir(&status_dir).await
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

async fn download_jdbc_plugin_zip() -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|err| err.to_string())?;

    let resp =
        crate::race_download(&client, JDBC_PLUGIN_DOWNLOAD_URL, JDBC_PLUGIN_R2_PATH, "dbx-jdbc-plugin-installer")
            .await
            .map_err(|err| format!("Failed to download JDBC plugin: {err}"))?;

    let bytes = resp.bytes().await.map_err(|err| err.to_string())?;
    Ok(bytes.to_vec())
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
        let executable = plugin_dir.join("bin").join("dbx-jdbc-plugin");
        if executable.exists() {
            let mut permissions = std::fs::metadata(&executable).map_err(|err| err.to_string())?.permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(executable, permissions).map_err(|err| err.to_string())?;
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
        if path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("jar")) != Some(true) {
            continue;
        }
        let metadata = entry.metadata().map_err(|err| err.to_string())?;
        drivers.push(JdbcDriverInfo {
            name: path.file_name().and_then(|name| name.to_str()).unwrap_or("driver.jar").to_string(),
            path: path.to_string_lossy().to_string(),
            size: metadata.len(),
        });
    }
    drivers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(drivers)
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
