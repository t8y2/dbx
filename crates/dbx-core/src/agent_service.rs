use std::io::Read;
use std::path::{Path, PathBuf};

use crate::agent_manager::{AgentDriverInfo, AgentManager, AgentRegistry, InstalledDriver, DEFAULT_JRE_KEY};

const REGISTRY_PATH: &str = "https://github.com/t8y2/dbx-agents/releases/latest/download/agent-registry.json";
const REGISTRY_R2_PATH: &str = "agents/agent-registry.json";

static REGISTRY_CACHE: std::sync::LazyLock<tokio::sync::Mutex<Option<(std::time::Instant, AgentRegistry)>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));

pub const AGENT_TYPES: &[(&str, &str)] = &[
    ("dameng", "达梦 DM8"),
    ("kingbase", "人大金仓 KingbaseES"),
    ("highgo", "瀚高 HighGo"),
    ("vastbase", "Vastbase"),
    ("goldendb", "GoldenDB"),
    ("databricks", "Databricks SQL"),
    ("saphana", "SAP HANA"),
    ("teradata", "Teradata"),
    ("vertica", "Vertica"),
    ("firebird", "Firebird"),
    ("exasol", "Exasol"),
    ("opengauss", "openGauss"),
    ("oceanbase-oracle", "OceanBase Oracle Mode"),
    ("gbase", "GBase"),
    ("access", "Microsoft Access"),
    ("oracle", "Oracle"),
    ("oracle-10g", "Oracle 10g"),
    ("h2", "H2"),
    ("snowflake", "Snowflake"),
    ("trino", "Trino (Presto)"),
    ("hive", "Apache Hive"),
    ("db2", "IBM DB2"),
    ("informix", "IBM Informix"),
    ("neo4j", "Neo4j"),
    ("cassandra", "Apache Cassandra"),
    ("bigquery", "Google BigQuery"),
    ("kylin", "Apache Kylin"),
    ("sundb", "SunDB"),
    ("gaussdb", "GaussDB"),
    ("yashandb", "崖山 YashanDB"),
    ("tdengine", "TDengine"),
    ("mongodb", "MongoDB (Legacy)"),
];

pub fn build_agent_list(am: &AgentManager, registry: Option<&AgentRegistry>) -> Vec<AgentDriverInfo> {
    let local_state = am.load_state();
    AGENT_TYPES
        .iter()
        .map(|(key, label)| {
            let installed = am.is_driver_installed(key);
            let local = local_state.installed_drivers.get(*key);
            let remote = registry.and_then(|r| r.drivers.get(*key));
            let jre_key = remote
                .map(|r| r.jre.clone())
                .or_else(|| local.map(|l| l.jre.clone()))
                .unwrap_or_else(|| DEFAULT_JRE_KEY.to_string());
            AgentDriverInfo {
                db_type: key.to_string(),
                label: label.to_string(),
                version: remote.map(|r| r.version.clone()).unwrap_or_default(),
                size: remote.map(|r| r.jar.size).unwrap_or(0),
                installed,
                installed_version: local.map(|l| l.version.clone()),
                update_available: match (local, remote) {
                    (Some(l), Some(r)) => l.version != r.version,
                    _ => false,
                },
                jre: jre_key.clone(),
                jre_installed: am.is_jre_installed(&jre_key),
            }
        })
        .collect()
}

pub fn local_agent_jar_candidates(db_type: &str) -> Vec<PathBuf> {
    let jar_name = format!("dbx-agent-{db_type}.jar");
    let relative = PathBuf::from("..").join("dbx-agents").join(db_type).join("build").join("libs").join(&jar_name);
    let nested = PathBuf::from("dbx-agents").join(db_type).join("build").join("libs").join(&jar_name);
    vec![relative, nested]
}

pub fn find_local_agent_jar(db_type: &str) -> Option<PathBuf> {
    local_agent_jar_candidates(db_type).into_iter().find(|path| path.exists())
}

pub fn install_local_agent(am: &AgentManager, db_type: &str, source: PathBuf) -> Result<(), String> {
    let jar_path = am.driver_jar_path(db_type);
    let parent = jar_path.parent().ok_or_else(|| format!("Invalid driver path: {}", jar_path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    std::fs::copy(&source, &jar_path).map_err(|e| format!("Failed to copy local agent jar: {e}"))?;

    let mut local_state = am.load_state();
    local_state.installed_drivers.insert(
        db_type.to_string(),
        InstalledDriver {
            version: "0.1.0-local".to_string(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            jre: DEFAULT_JRE_KEY.to_string(),
        },
    );
    am.save_state(&local_state)
}

pub async fn fetch_registry() -> Result<AgentRegistry, String> {
    {
        let cache = REGISTRY_CACHE.lock().await;
        if let Some((ts, registry)) = cache.as_ref() {
            if ts.elapsed() < std::time::Duration::from_secs(300) {
                return Ok(registry.clone());
            }
        }
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {err}"))?;
    let resp = crate::race_download(&client, REGISTRY_PATH, REGISTRY_R2_PATH, "dbx-agent-manager")
        .await
        .map_err(|err| format!("Failed to fetch agent registry: {err}"))?;
    let registry: AgentRegistry = resp.json().await.map_err(|err| format!("Failed to parse registry: {err}"))?;
    *REGISTRY_CACHE.lock().await = Some((std::time::Instant::now(), registry.clone()));
    Ok(registry)
}

pub async fn invalidate_registry_cache() {
    *REGISTRY_CACHE.lock().await = None;
}

pub fn github_url_to_r2_path(github_url: &str, category: &str) -> String {
    let filename = github_url.rsplit('/').next().unwrap_or(github_url);
    match category {
        "jre" => format!("agents/jre/{filename}"),
        "driver" => format!("agents/drivers/{filename}"),
        _ => format!("agents/{filename}"),
    }
}

pub fn ensure_driver_app_version(
    db_type: &str,
    driver: &crate::agent_manager::DriverInfo,
    current_version: &str,
) -> Result<(), String> {
    if is_app_version_compatible(&driver.min_app_version, current_version) {
        return Ok(());
    }
    Err(format!(
        "{db_type} driver {} requires DBX {} or newer. Current DBX version is {}.",
        driver.version, driver.min_app_version, current_version
    ))
}

pub fn is_app_version_compatible(min_app_version: &str, current_version: &str) -> bool {
    !crate::update::is_newer_version(min_app_version, current_version)
}

pub fn download_temp_path(dest: &std::path::Path) -> std::path::PathBuf {
    let file_name = dest.file_name().and_then(|name| name.to_str()).unwrap_or("download");
    dest.with_file_name(format!("{file_name}.download"))
}

pub fn replace_download(tmp: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if dest.exists() {
        let backup = backup_path(dest);
        std::fs::rename(dest, &backup).map_err(|e| format!("Failed to back up existing file: {e}"))?;
        match std::fs::rename(tmp, dest) {
            Ok(()) => {
                std::fs::remove_file(&backup).ok();
                Ok(())
            }
            Err(err) => {
                let _ = std::fs::rename(&backup, dest);
                Err(format!("Failed to replace downloaded file: {err}"))
            }
        }
    } else {
        std::fs::rename(tmp, dest).map_err(|e| format!("Failed to move downloaded file into place: {e}"))
    }
}

fn backup_path(dest: &std::path::Path) -> std::path::PathBuf {
    let file_name = dest.file_name().and_then(|name| name.to_str()).unwrap_or("download");
    dest.with_file_name(format!("{file_name}.backup-{}", uuid::Uuid::new_v4()))
}

// ──────────── Offline import ────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct OfflineImportProgress {
    pub step: String,
    pub current: u32,
    pub total: u32,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct OfflineImportResult {
    pub jre_installed: Vec<String>,
    pub drivers_installed: Vec<String>,
    pub drivers_skipped: Vec<String>,
}

pub fn import_offline_zip(
    am: &AgentManager,
    zip_path: &Path,
    progress: impl Fn(OfflineImportProgress),
) -> Result<OfflineImportResult, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("Failed to open ZIP file: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP file: {e}"))?;

    let registry = read_registry_from_zip(&mut archive)?;

    let platform = AgentManager::current_platform();
    let mut local_state = am.load_state();
    let mut result =
        OfflineImportResult { jre_installed: Vec::new(), drivers_installed: Vec::new(), drivers_skipped: Vec::new() };

    let jre_entries: Vec<(String, String)> = (0..archive.len())
        .filter_map(|i| {
            let entry = archive.by_index(i).ok()?;
            let name = entry.name().to_string();
            if name.starts_with("jre/") && name.ends_with(".tar.gz") && name.contains(platform) {
                let jre_key = extract_jre_key_from_filename(&name)?;
                Some((jre_key, name))
            } else {
                None
            }
        })
        .collect();

    let driver_entries: Vec<(String, String)> = (0..archive.len())
        .filter_map(|i| {
            let entry = archive.by_index(i).ok()?;
            let name = entry.name().to_string();
            if name.starts_with("drivers/") && name.ends_with(".jar") {
                let db_type = extract_db_type_from_filename(&name)?;
                Some((db_type, name))
            } else {
                None
            }
        })
        .collect();

    let total = (jre_entries.len() + driver_entries.len()) as u32;
    let mut current: u32 = 0;

    for (jre_key, entry_name) in &jre_entries {
        current += 1;
        let jre_version = registry.resolve_jre(jre_key).map(|j| j.version.clone());
        let existing_version = local_state.jre_versions.get(jre_key);
        if am.is_jre_installed(jre_key) && existing_version == jre_version.as_ref() {
            continue;
        }

        progress(OfflineImportProgress { step: "jre-extract".into(), current, total, label: format!("JRE {jre_key}") });

        let mut entry = archive.by_name(entry_name).map_err(|e| format!("Failed to read {entry_name}: {e}"))?;
        let tmp_archive = am.base_dir().join(format!("jre-offline-{jre_key}.tar.gz"));
        {
            let mut out =
                std::fs::File::create(&tmp_archive).map_err(|e| format!("Failed to create temp file: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("Failed to extract JRE archive: {e}"))?;
        }

        let jre_dir = am.jre_dir(jre_key);
        if jre_dir.exists() {
            std::fs::remove_dir_all(&jre_dir).ok();
        }
        extract_tar_gz(&tmp_archive, &jre_dir)?;
        std::fs::remove_file(&tmp_archive).ok();

        if let Some(ver) = jre_version {
            local_state.jre_versions.insert(jre_key.clone(), ver);
        }
        result.jre_installed.push(jre_key.clone());
    }

    for (db_type, entry_name) in &driver_entries {
        current += 1;

        if let Some(remote_driver) = registry.drivers.get(db_type) {
            if let Some(installed) = local_state.installed_drivers.get(db_type) {
                if installed.version != "0.1.0-local"
                    && installed.version != "local"
                    && !crate::update::is_newer_version(&remote_driver.version, &installed.version)
                {
                    result.drivers_skipped.push(db_type.clone());
                    continue;
                }
            }
        }

        progress(OfflineImportProgress {
            step: "driver".into(),
            current,
            total,
            label: AGENT_TYPES
                .iter()
                .find(|(k, _)| *k == db_type)
                .map(|(_, l)| l.to_string())
                .unwrap_or_else(|| db_type.clone()),
        });

        let jar_path = am.driver_jar_path(db_type);
        if let Some(parent) = jar_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut entry = archive.by_name(entry_name).map_err(|e| format!("Failed to read {entry_name}: {e}"))?;
        let mut out = std::fs::File::create(&jar_path).map_err(|e| format!("Failed to write driver JAR: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Failed to copy driver JAR: {e}"))?;

        let version = registry.drivers.get(db_type).map(|d| d.version.clone()).unwrap_or_else(|| "local".to_string());
        let jre_key =
            registry.drivers.get(db_type).map(|d| d.jre.clone()).unwrap_or_else(|| DEFAULT_JRE_KEY.to_string());

        local_state.installed_drivers.insert(
            db_type.clone(),
            InstalledDriver { version, installed_at: chrono::Utc::now().to_rfc3339(), jre: jre_key },
        );
        result.drivers_installed.push(db_type.clone());
    }

    am.save_state(&local_state)?;
    Ok(result)
}

fn read_registry_from_zip(archive: &mut zip::ZipArchive<std::fs::File>) -> Result<AgentRegistry, String> {
    let mut entry = archive
        .by_name("agent-registry.json")
        .map_err(|_| "ZIP 文件中未找到 agent-registry.json，请确认这是有效的离线驱动包".to_string())?;
    let mut buf = String::new();
    entry.read_to_string(&mut buf).map_err(|e| format!("Failed to read agent-registry.json: {e}"))?;
    serde_json::from_str(&buf).map_err(|e| format!("Invalid agent-registry.json: {e}"))
}

fn extract_jre_key_from_filename(name: &str) -> Option<String> {
    let filename = name.rsplit('/').next()?;
    let rest = filename.strip_prefix("jre-")?;
    let key = rest.split('-').next()?;
    if key.is_empty() {
        return None;
    }
    Some(key.to_string())
}

fn extract_db_type_from_filename(name: &str) -> Option<String> {
    let filename = name.rsplit('/').next()?;
    let rest = filename.strip_prefix("dbx-agent-")?;
    let db_type = rest.strip_suffix(".jar")?;
    if db_type.is_empty() {
        return None;
    }
    Some(db_type.to_string())
}

fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let status = std::process::Command::new("tar")
        .args(["xzf", &archive.to_string_lossy(), "-C", &dest.to_string_lossy(), "--strip-components=1"])
        .status()
        .map_err(|e| format!("Failed to extract archive: {e}"))?;
    if !status.success() {
        return Err("Failed to extract JRE archive".to_string());
    }
    Ok(())
}

pub fn import_agent_jar(am: &AgentManager, db_type: &str, jar_path: &Path) -> Result<(), String> {
    if !jar_path.exists() {
        return Err(format!("File not found: {}", jar_path.display()));
    }
    install_local_agent(am, db_type, jar_path.to_path_buf())
}
