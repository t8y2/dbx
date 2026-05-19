use std::path::PathBuf;

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
