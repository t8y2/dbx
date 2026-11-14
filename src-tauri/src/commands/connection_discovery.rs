//! Read saved connection files only from known application configuration roots.
use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[path = "navicat_wine.rs"]
mod navicat_wine;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredConnectionSource {
    source: String,
    label: String,
    path: String,
    content: String,
}

const MAX_SOURCES: usize = 100;
const MAX_SCAN_ENTRIES: usize = 2000;
const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_WINE_PREFIXES: usize = 64;

/// Limits shared by every collector in one discovery pass. Each directory or
/// Wine prefix visited and each file read takes an entry; file contents also
/// consume bytes, checked before the file is read.
struct ScanBudget {
    entries: usize,
    bytes: u64,
}

impl ScanBudget {
    fn new() -> Self {
        Self { entries: MAX_SCAN_ENTRIES, bytes: MAX_SCAN_BYTES }
    }

    fn take_entry(&mut self) -> bool {
        if self.entries == 0 {
            return false;
        }
        self.entries -= 1;
        true
    }

    fn read_text(&mut self, path: &Path) -> Option<String> {
        String::from_utf8(self.read_bytes(path)?).ok()
    }

    fn read_bytes(&mut self, path: &Path) -> Option<Vec<u8>> {
        use std::io::Read;
        // Bound memory use and skip directories, links, and unexpectedly large files.
        let metadata = std::fs::symlink_metadata(path).ok()?;
        let limit = MAX_FILE_BYTES.min(self.bytes);
        if !metadata.is_file() || metadata.len() > limit || !self.take_entry() {
            return None;
        }
        // Cap the read too, in case the file grew after its size was checked.
        let mut bytes = Vec::new();
        std::fs::File::open(path).ok()?.take(limit + 1).read_to_end(&mut bytes).ok()?;
        self.bytes = self.bytes.saturating_sub(bytes.len() as u64);
        (bytes.len() as u64 <= limit).then_some(bytes)
    }
}

fn collect(root: &Path, depth: usize, output: &mut Vec<DiscoveredConnectionSource>, budget: &mut ScanBudget) {
    if output.len() >= MAX_SOURCES
        || std::fs::symlink_metadata(root).map_or(true, |m| m.file_type().is_symlink())
        || !budget.take_entry()
    {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let mut entries: Vec<_> = entries.flatten().take(500).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if output.len() >= MAX_SOURCES {
            break;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() && depth > 0 {
            collect(&path, depth - 1, output, budget);
        } else if kind.is_file() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let (source, label, content) = match name.as_ref() {
                "data-sources.json" => {
                    let Some(data) = budget.read_text(&path) else { continue };
                    let credentials = budget
                        .read_bytes(&root.join("credentials-config.json"))
                        .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
                        .unwrap_or_default();
                    (
                        "dbeaver",
                        "DBeaver",
                        serde_json::json!({"format": "dbeaver-import", "dataSources": data, "credentialsBase64": credentials}).to_string(),
                    )
                }
                "dataSources.xml" => {
                    let Some(data) = budget.read_text(&path) else { continue };
                    (
                        "datagrip",
                        "DataGrip",
                        serde_json::json!({
                            "format": "datagrip-import", "dataSources": data,
                            "dataSourcesLocal": budget.read_text(&root.join("dataSources.local.xml")).unwrap_or_default(),
                            "dbForestConfig": budget.read_text(&root.join("db-forest-config.xml")).unwrap_or_default()
                        })
                        .to_string(),
                    )
                }
                "connections.json" => {
                    let Some(data) = budget.read_text(&path) else { continue };
                    (
                        "rdm",
                        "Redis Desktop Manager",
                        serde_json::json!({"format": "rdm-import", "content": data}).to_string(),
                    )
                }
                _ => continue,
            };
            if !output.iter().any(|item| item.path == path.to_string_lossy()) {
                output.push(DiscoveredConnectionSource {
                    source: source.into(),
                    label: label.into(),
                    path: path.to_string_lossy().into_owned(),
                    content,
                });
            }
        }
    }
}

fn discover(home: &Path, config: &Path, data: &Path) -> Vec<DiscoveredConnectionSource> {
    discover_with_budget(home, config, data, &mut ScanBudget::new())
}

fn discover_with_budget(
    home: &Path,
    config: &Path,
    data: &Path,
    budget: &mut ScanBudget,
) -> Vec<DiscoveredConnectionSource> {
    let mut output = Vec::new();
    let roots: Vec<(PathBuf, usize)> = vec![
        (data.join("DBeaverData"), 6),
        (home.join(".local/share/DBeaverData"), 6),
        (home.join("Library/DBeaverData"), 6),
        (home.join(".dbeaver4"), 4),
        (home.join("snap/dbeaver-ce/current/.local/share/DBeaverData"), 6),
        (home.join(".var/app/io.dbeaver.DBeaverCommunity/data/DBeaverData"), 6),
        (config.join("JetBrains"), 4),
        (home.join("Library/Application Support/JetBrains"), 4),
        (home.join("DataGripProjects"), 5),
        (home.join(".rdm"), 1),
        (config.join("rdm"), 1),
        (config.join("RedisDesktopManager"), 2),
    ];
    for (root, depth) in roots {
        collect(&root, depth, &mut output, budget);
    }
    // Native Linux store documented by Navicat; also find NCX files saved
    // inside its configuration folders. These are distinct from RDM JSON.
    for root in [config.join("navicat"), home.join(".config/navicat"), home.join(".navicat"), home.join(".navicat64")] {
        collect_navicat(&root, 5, &mut output, budget);
    }
    collect_navicat_wine(home, data, &mut output, budget);
    output
}

fn collect_navicat_wine(
    home: &Path,
    data: &Path,
    output: &mut Vec<DiscoveredConnectionSource>,
    budget: &mut ScanBudget,
) {
    let mut prefixes = vec![home.join(".wine")];
    if let Some(prefix) = std::env::var_os("WINEPREFIX") {
        prefixes.push(PathBuf::from(prefix));
    }
    if let Ok(entries) = std::fs::read_dir(home) {
        let mut wine: Vec<_> = entries
            .flatten()
            .take(1000)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".wine"))
            .map(|entry| entry.path())
            .collect();
        wine.sort();
        prefixes.extend(wine);
    }
    for root in [
        data.join("bottles/bottles"),
        home.join(".local/share/bottles/bottles"),
        home.join(".var/app/com.usebottles.bottles/data/bottles/bottles"),
        home.join(".PlayOnLinux/wineprefix"),
    ] {
        if let Ok(entries) = std::fs::read_dir(root) {
            prefixes.extend(entries.flatten().take(MAX_WINE_PREFIXES).map(|entry| entry.path()));
        }
    }
    let mut seen = std::collections::HashSet::new();
    for prefix in prefixes.into_iter().take(MAX_WINE_PREFIXES) {
        // Each prefix costs an entry before it is touched, and its registry
        // file is read through the shared budget, so many prefixes or large
        // registries cannot exceed the limits the rest of the scan honors.
        if output.len() >= MAX_SOURCES || budget.bytes == 0 || !budget.take_entry() {
            break;
        }
        let Ok(path) = std::fs::canonicalize(prefix.join("user.reg")) else { continue };
        if !seen.insert(path.clone()) {
            continue;
        }
        let Some(registry) = budget.read_text(&path) else { continue };
        let connections = navicat_wine::parse(&registry);
        if !connections.is_empty() {
            output.push(DiscoveredConnectionSource {
                source: "navicat".into(),
                label: "Navicat (Wine)".into(),
                path: path.to_string_lossy().into_owned(),
                content: serde_json::json!({"format": "navicat-wine-import", "connections": connections}).to_string(),
            });
        }
    }
}

fn collect_navicat(root: &Path, depth: usize, output: &mut Vec<DiscoveredConnectionSource>, budget: &mut ScanBudget) {
    if output.len() >= MAX_SOURCES
        || std::fs::symlink_metadata(root).map_or(true, |m| m.file_type().is_symlink())
        || !budget.take_entry()
    {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let mut entries: Vec<_> = entries.flatten().take(500).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if output.len() >= MAX_SOURCES {
            break;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() && depth > 0 {
            collect_navicat(&path, depth - 1, output, budget);
        } else if kind.is_file()
            && (entry.file_name() == "connections.json"
                || path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("ncx")))
        {
            let Some(content) = budget.read_text(&path) else { continue };
            if !output.iter().any(|item| item.path == path.to_string_lossy()) {
                output.push(DiscoveredConnectionSource {
                    source: "navicat".into(),
                    label: "Navicat".into(),
                    path: path.to_string_lossy().into_owned(),
                    content,
                });
            }
        }
    }
}

#[tauri::command]
pub async fn discover_connection_sources(app: tauri::AppHandle) -> Result<Vec<DiscoveredConnectionSource>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let config = app.path().config_dir().map_err(|e| e.to_string())?;
    let data = app.path().data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || discover(&home, &config, &data)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_known_sources_and_companion_files_without_duplicates() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let dbeaver = home.join(".local/share/DBeaverData/workspace6/General/.dbeaver");
        let datagrip = home.join("config/JetBrains/DataGrip2026/options");
        std::fs::create_dir_all(&dbeaver).unwrap();
        std::fs::create_dir_all(&datagrip).unwrap();
        std::fs::write(dbeaver.join("data-sources.json"), "{\"connections\":{}}").unwrap();
        std::fs::write(dbeaver.join("credentials-config.json"), [1, 2, 3]).unwrap();
        std::fs::write(datagrip.join("dataSources.xml"), "<project/>").unwrap();
        std::fs::write(datagrip.join("dataSources.local.xml"), "<local/>").unwrap();
        let sources = discover(home, &home.join("config"), &home.join(".local/share"));
        assert_eq!(sources.len(), 2);
        let grip = sources.iter().find(|s| s.source == "datagrip").unwrap();
        let payload: serde_json::Value = serde_json::from_str(&grip.content).unwrap();
        assert_eq!(payload["dataSourcesLocal"], "<local/>");
        let beaver = sources.iter().find(|s| s.source == "dbeaver").unwrap();
        let payload: serde_json::Value = serde_json::from_str(&beaver.content).unwrap();
        assert_eq!(payload["credentialsBase64"], "AQID");
    }

    #[test]
    fn missing_roots_are_empty() {
        let temp = tempfile::tempdir().unwrap();
        assert!(discover(temp.path(), temp.path(), temp.path()).is_empty());
    }

    #[test]
    fn navicat_json_is_discovered_once_and_never_classified_as_redis() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(".config/navicat/Common");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("connections.json"), "{\"connections\":[]}").unwrap();
        std::fs::write(directory.join("export.ncx"), "<Connections/>").unwrap();
        let sources = discover(temp.path(), &temp.path().join(".config"), &temp.path().join(".local/share"));
        assert_eq!(sources.len(), 2);
        assert!(sources.iter().all(|source| source.source == "navicat"));
    }

    #[test]
    fn wine_registry_connections_are_discovered_without_unrelated_registry_values() {
        let temp = tempfile::tempdir().unwrap();
        let prefix = temp.path().join(".wine");
        std::fs::create_dir_all(&prefix).unwrap();
        std::fs::write(
            prefix.join("user.reg"),
            r#"[Software\\PremiumSoft\\Navicat\\Servers\\Demo] 1
"Host"="mysql.example"
"Port"=dword:00000cea
"Pwd_2"="private-blob"
"#,
        )
        .unwrap();
        let sources = discover(temp.path(), temp.path(), temp.path());
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].label, "Navicat (Wine)");
        assert!(!sources[0].content.contains("private-blob"));
        let payload: serde_json::Value = serde_json::from_str(&sources[0].content).unwrap();
        assert_eq!(payload["connections"][0]["Name"], "Demo");
    }

    const WINE_REGISTRY: &str =
        "[Software\\\\PremiumSoft\\\\Navicat\\\\Servers\\\\Demo] 1\n\"Host\"=\"mysql.example\"\n";

    fn wine_prefixes(home: &Path, count: usize) {
        for index in 0..count {
            let prefix = home.join(format!(".wine{index:03}"));
            std::fs::create_dir_all(&prefix).unwrap();
            std::fs::write(prefix.join("user.reg"), WINE_REGISTRY).unwrap();
        }
    }

    fn scan_wine(home: &Path, budget: &mut ScanBudget) -> Vec<DiscoveredConnectionSource> {
        let mut output = Vec::new();
        collect_navicat_wine(home, home, &mut output, budget);
        output
    }

    #[test]
    fn wine_scan_caps_prefixes_even_with_an_ample_budget() {
        let temp = tempfile::tempdir().unwrap();
        wine_prefixes(temp.path(), MAX_WINE_PREFIXES + 40);
        let mut budget = ScanBudget::new();
        let sources = scan_wine(temp.path(), &mut budget);
        assert!(!sources.is_empty());
        assert!(sources.len() <= MAX_WINE_PREFIXES);
        // One entry per prefix visited plus one per registry file read.
        assert!(MAX_SCAN_ENTRIES - budget.entries <= 2 * MAX_WINE_PREFIXES);
    }

    #[test]
    fn wine_scan_stops_reading_registries_when_the_byte_budget_is_spent() {
        let temp = tempfile::tempdir().unwrap();
        wine_prefixes(temp.path(), 20);
        let mut budget = ScanBudget { entries: MAX_SCAN_ENTRIES, bytes: 3 * WINE_REGISTRY.len() as u64 };
        let sources = scan_wine(temp.path(), &mut budget);
        assert_eq!(sources.len(), 3);
        assert_eq!(budget.bytes, 0);
    }

    #[test]
    fn wine_scan_stops_visiting_prefixes_when_the_entry_budget_is_spent() {
        let temp = tempfile::tempdir().unwrap();
        wine_prefixes(temp.path(), 20);
        let mut budget = ScanBudget { entries: 6, bytes: MAX_SCAN_BYTES };
        let sources = scan_wine(temp.path(), &mut budget);
        assert!(sources.len() <= 3);
        assert_eq!(budget.entries, 0);
    }

    #[test]
    fn wine_scan_shares_the_budget_left_by_the_ordinary_scan() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let datagrip = home.join("config/JetBrains/DataGrip2026/options");
        std::fs::create_dir_all(&datagrip).unwrap();
        std::fs::write(datagrip.join("dataSources.xml"), "<project/>").unwrap();
        wine_prefixes(home, 5);
        // Room for the DataGrip file and less than one registry file.
        let mut budget = ScanBudget { entries: MAX_SCAN_ENTRIES, bytes: "<project/>".len() as u64 + 1 };
        let sources = discover_with_budget(home, &home.join("config"), &home.join(".local/share"), &mut budget);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].source, "datagrip");
    }
}
