use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use super::descriptor::{DialectCapabilityDescriptor, DialectKind};
use super::dialect_yaml::DialectYaml;

/// Singleton dialect registry that holds all loaded dialect descriptors.
/// Thread-safe via RwLock. Access via `DialectRegistry::global()`.
pub struct DialectRegistry {
    descriptors: RwLock<HashMap<String, LoadedDialect>>,
    plugin_dirs: RwLock<Vec<PathBuf>>,
}

#[derive(Debug, Clone)]
pub struct LoadedDialect {
    pub dialect_name: String,
    pub kind: DialectKind,
    pub descriptor: DialectCapabilityDescriptor,
    pub yaml: DialectYaml,
    pub source_path: Option<PathBuf>,
    pub loaded_at: String,
}

#[derive(Debug, Clone)]
pub struct LoadError {
    pub path: PathBuf,
    pub error: String,
}

impl DialectRegistry {
    pub fn new() -> Self {
        Self { descriptors: RwLock::new(HashMap::new()), plugin_dirs: RwLock::new(Vec::new()) }
    }

    pub fn global() -> &'static Self {
        use std::sync::OnceLock;
        static INSTANCE: OnceLock<DialectRegistry> = OnceLock::new();
        INSTANCE.get_or_init(DialectRegistry::new)
    }

    pub fn add_plugin_dir(&self, dir: PathBuf) {
        if let Ok(mut dirs) = self.plugin_dirs.write() {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }

    pub fn get(&self, name: &str) -> Option<LoadedDialect> {
        self.descriptors.read().ok().and_then(|d| d.get(&name.to_ascii_lowercase()).cloned())
    }

    pub fn get_by_kind(&self, kind: DialectKind) -> Option<LoadedDialect> {
        self.descriptors.read().ok().and_then(|d| d.values().find(|ld| ld.kind == kind).cloned())
    }

    /// Return all loaded dialects that map to the given kind.
    /// Unlike `get_by_kind` (which returns only the first match), this is
    /// order-independent and is used when a type's capabilities must be
    /// resolved across an entire dialect family (e.g. PostgreSQL, HighGo,
    /// KingBase all share `DialectKind::Postgres`).
    pub fn get_all_by_kind(&self, kind: DialectKind) -> Vec<LoadedDialect> {
        self.descriptors
            .read()
            .ok()
            .map(|d| d.values().filter(|ld| ld.kind == kind).cloned().collect())
            .unwrap_or_default()
    }

    pub fn get_descriptor(&self, name: &str) -> Option<DialectCapabilityDescriptor> {
        self.get(name).map(|ld| ld.descriptor)
    }

    pub fn get_descriptor_for_db(
        &self,
        db_type: crate::models::connection::DatabaseType,
    ) -> Option<DialectCapabilityDescriptor> {
        let kind = DialectKind::from_database_type(db_type);
        let label = kind.label();
        let db_name = format!("{db_type:?}").to_ascii_lowercase();
        self.get(&db_name).or_else(|| self.get(label)).map(|ld| ld.descriptor)
    }

    pub fn get_yaml(&self, name: &str) -> Option<DialectYaml> {
        self.get(name).map(|ld| ld.yaml)
    }

    pub fn has(&self, name: &str) -> bool {
        self.descriptors.read().ok().is_some_and(|d| d.contains_key(&name.to_ascii_lowercase()))
    }

    pub fn all_names(&self) -> Vec<String> {
        self.descriptors.read().ok().map(|d| d.keys().cloned().collect()).unwrap_or_default()
    }

    pub fn all_descriptors(&self) -> Vec<DialectCapabilityDescriptor> {
        self.descriptors.read().ok().map(|d| d.values().map(|ld| ld.descriptor).collect()).unwrap_or_default()
    }

    pub fn register(
        &self,
        name: &str,
        kind: DialectKind,
        descriptor: DialectCapabilityDescriptor,
        yaml: DialectYaml,
        source_path: Option<PathBuf>,
    ) {
        if let Ok(mut d) = self.descriptors.write() {
            d.insert(
                name.to_ascii_lowercase(),
                LoadedDialect {
                    dialect_name: name.to_string(),
                    kind,
                    descriptor,
                    yaml,
                    source_path,
                    loaded_at: chrono::Utc::now().to_rfc3339(),
                },
            );
        }
    }

    pub fn register_yaml(&self, path: &Path, yaml: DialectYaml, descriptor: DialectCapabilityDescriptor) {
        let kind = descriptor.dialect;
        let name = yaml.dialect.name.clone();
        self.register(&name, kind, descriptor, yaml, Some(path.to_path_buf()));
    }

    pub fn register_descriptor(&self, name: &str, descriptor: DialectCapabilityDescriptor, yaml: DialectYaml) {
        let kind = descriptor.dialect;
        self.register(name, kind, descriptor, yaml, None);
    }

    pub fn unregister(&self, name: &str) -> bool {
        self.descriptors.write().ok().is_some_and(|mut d| d.remove(&name.to_ascii_lowercase()).is_some())
    }

    pub fn is_empty(&self) -> bool {
        self.descriptors.read().ok().is_none_or(|d| d.is_empty())
    }

    pub fn len(&self) -> usize {
        self.descriptors.read().ok().map_or(0, |d| d.len())
    }
}

impl Default for DialectRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Register all core dialect YAML definitions embedded at compile time.
/// Called once at startup by `lazy_init()`.
pub fn register_core_dialects() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let registry = DialectRegistry::global();
        include!(concat!(env!("OUT_DIR"), "/core_dialects.rs"));
        let n = registry.len();
        log::info!("Registered {n} core dialects");
    });
}

// ============================================================================
// DialectPluginLoader — scans plugin directories and loads YAML files
// ============================================================================

pub struct DialectPluginLoader;

#[derive(Debug)]
pub struct LoadResult {
    pub loaded: Vec<DialectKind>,
    pub errors: Vec<LoadError>,
    pub skipped: Vec<PathBuf>,
}

impl DialectPluginLoader {
    pub fn scan_and_load(registry: &DialectRegistry, plugin_dirs: &[PathBuf]) -> LoadResult {
        let mut result = LoadResult { loaded: Vec::new(), errors: Vec::new(), skipped: Vec::new() };

        for dir in plugin_dirs {
            if !dir.exists() {
                continue;
            }

            let entries = match fs::read_dir(dir) {
                Ok(entries) => entries,
                Err(e) => {
                    result.errors.push(LoadError { path: dir.clone(), error: format!("Cannot read directory: {e}") });
                    continue;
                }
            };

            for entry in entries {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                let path = entry.path();
                if !path.is_file() {
                    continue;
                }

                let file_name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");

                if !matches!(extension, "yaml" | "yml") {
                    continue;
                }

                match Self::load_file(&path) {
                    Ok((kind, yaml, descriptor)) => {
                        registry.register(file_name, kind, descriptor, yaml, Some(path.clone()));
                        result.loaded.push(kind);
                    }
                    Err(e) => {
                        result.errors.push(LoadError { path: path.clone(), error: e });
                    }
                }
            }
        }

        result
    }

    pub fn load_file(path: &Path) -> Result<(DialectKind, DialectYaml, DialectCapabilityDescriptor), String> {
        let content = fs::read_to_string(path).map_err(|e| format!("Cannot read file: {e}"))?;
        Self::load_from_string(&content, Some(path))
    }

    pub fn load_from_string(
        yaml_str: &str,
        source_path: Option<&Path>,
    ) -> Result<(DialectKind, DialectYaml, DialectCapabilityDescriptor), String> {
        let parsed: DialectYaml = serde_yaml::from_str(yaml_str).map_err(|e| format!("YAML parse error: {e}"))?;

        let kind = parsed.dialect_kind().ok_or_else(|| {
            format!(
                "Unknown dialect name '{}' in {}",
                parsed.dialect.name,
                source_path.map_or_else(|| "<string>".to_string(), |p| p.display().to_string())
            )
        })?;

        let validation_errors = parsed.validate();
        if !validation_errors.is_empty() {
            let msgs: Vec<String> = validation_errors.iter().map(|e| e.to_string()).collect();
            return Err(format!("Validation errors: {}", msgs.join("; ")));
        }

        let descriptor = parsed.to_descriptor(kind);
        Ok((kind, parsed, descriptor))
    }

    pub fn load_directory(registry: &DialectRegistry, dir: &Path) -> LoadResult {
        Self::scan_and_load(registry, &[dir.to_path_buf()])
    }
}

// ============================================================================
// Fallback: use hardcoded descriptors when YAML is unavailable
// ============================================================================

pub fn resolve_descriptor(kind: DialectKind, registry: &DialectRegistry) -> DialectCapabilityDescriptor {
    if let Some(desc) = registry.get_descriptor(kind.label()) {
        return desc;
    }
    DialectCapabilityDescriptor::for_dialect(kind)
}

pub fn resolve_descriptor_for_db(
    db_type: crate::models::connection::DatabaseType,
    registry: &DialectRegistry,
) -> DialectCapabilityDescriptor {
    if let Some(desc) = registry.get_descriptor_for_db(db_type) {
        return desc;
    }
    let kind = DialectKind::from_database_type(db_type);
    DialectCapabilityDescriptor::for_dialect(kind)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dialect_dir() -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("dbx-dialect-test-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_temp_yaml(dir: &Path, name: &str, dialect_name: &str) -> PathBuf {
        let file_path = dir.join(name);
        let yaml_content = format!(
            r#"
dialect:
  name: "{dialect_name}"
  versions:
    - version: "1.0"
identifier_rules:
  quote_char: "\""
  max_length: 64
"#
        );
        let mut file = fs::File::create(&file_path).unwrap();
        file.write_all(yaml_content.as_bytes()).unwrap();
        file_path
    }

    fn cleanup_temp_dir(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn load_valid_yaml_file() {
        let dir = temp_dialect_dir();
        let path = write_temp_yaml(&dir, "dialect_postgresql.yaml", "PostgreSQL");
        let result = DialectPluginLoader::load_file(&path);
        cleanup_temp_dir(&dir);
        assert!(result.is_ok());
        let (kind, _yaml, desc) = result.unwrap();
        assert_eq!(kind, DialectKind::Postgres);
        assert_eq!(desc.dialect, DialectKind::Postgres);
    }

    #[test]
    fn load_valid_yaml_file_mysql() {
        let dir = temp_dialect_dir();
        let path = write_temp_yaml(&dir, "dialect_mysql.yaml", "MySQL");
        let result = DialectPluginLoader::load_file(&path);
        cleanup_temp_dir(&dir);
        assert!(result.is_ok());
        let (kind, _, _) = result.unwrap();
        assert_eq!(kind, DialectKind::Mysql);
    }

    #[test]
    fn load_invalid_dialect_name() {
        let dir = temp_dialect_dir();
        let path = write_temp_yaml(&dir, "dialect_unknown.yaml", "UnknownDB");
        let result = DialectPluginLoader::load_file(&path);
        cleanup_temp_dir(&dir);
        assert!(result.is_err());
    }

    #[test]
    fn load_invalid_yaml_syntax() {
        let dir = temp_dialect_dir();
        let path = dir.join("dialect_bad.yaml");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(b"dialect: [invalid: yaml: syntax:").unwrap();
        let result = DialectPluginLoader::load_file(&path);
        cleanup_temp_dir(&dir);
        assert!(result.is_err());
    }

    #[test]
    fn registry_register_and_get() {
        let registry = DialectRegistry::new();
        assert!(registry.is_empty());

        let desc = DialectCapabilityDescriptor::for_dialect(DialectKind::Mysql);
        let yaml = DialectYaml {
            dialect: super::super::dialect_yaml::DialectMeta {
                name: "MySQL".to_string(),
                display_name: Some("MySQL".to_string()),
                versions: vec![],
            },
            identifier_rules: super::super::dialect_yaml::IdentifierRules {
                quote_char: "`".to_string(),
                case_sensitive: false,
                max_length: 64,
            },
            ..Default::default()
        };

        registry.register_descriptor("MySQL", desc, yaml);
        assert_eq!(registry.len(), 1);
        assert!(registry.has("MySQL"));
        assert!(!registry.has("PostgreSQL"));

        let loaded = registry.get("MySQL").unwrap();
        assert_eq!(loaded.dialect_name, "MySQL");

        registry.unregister("MySQL");
        assert!(registry.is_empty());
    }

    #[test]
    fn registry_fallback_resolve() {
        let registry = DialectRegistry::new();
        let desc = resolve_descriptor(DialectKind::Mysql, &registry);
        assert!(desc.has_capability(super::super::descriptor::CAP_ADD_COLUMN));
    }

    #[test]
    fn registry_all_kinds() {
        let registry = DialectRegistry::new();
        let desc = DialectCapabilityDescriptor::for_dialect(DialectKind::Mysql);
        let yaml = DialectYaml {
            dialect: super::super::dialect_yaml::DialectMeta {
                name: "MySQL".to_string(),
                display_name: None,
                versions: vec![],
            },
            identifier_rules: super::super::dialect_yaml::IdentifierRules {
                quote_char: "`".to_string(),
                case_sensitive: false,
                max_length: 64,
            },
            ..Default::default()
        };

        registry.register_descriptor("MySQL", desc, yaml);
        let names = registry.all_names();
        assert_eq!(names, vec!["mysql"]);
    }
}
