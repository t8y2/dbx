use std::sync::OnceLock;

use serde::Deserialize;

use crate::models::connection::DatabaseType;

const DATABASE_MANIFEST_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/database_manifest.json"));

#[derive(Debug, Deserialize)]
struct DatabaseManifestFile {
    drivers: Vec<DatabaseManifestEntry>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseRuntimeMode {
    Native,
    File,
    Agent,
    External,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseTransferObjectFamily {
    Mysql,
    Postgres,
    Oracle,
    SqlServer,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum DatabaseTransferSupportLevel {
    BestEffort,
    FamilyCompatible,
    Verified,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseCompareMode {
    Schema,
    Data,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDriverProfile {
    pub profile: String,
    pub agent_key: String,
    #[serde(default)]
    pub package_key: Option<String>,
    pub label: String,
    #[serde(default)]
    pub store_visible: bool,
    #[serde(default)]
    pub store_order: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDriverEntry {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub store_visible: bool,
    #[serde(default)]
    pub store_order: Option<u32>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseSupportLevel {
    Connect,
    Browse,
    Understand,
    Operate,
}

/// Product capabilities a connection type advertises. Flags the descriptor
/// omits fall back to its support level's defaults (see [`DatabaseManifestEntry::capability`]),
/// matching the frontend's `databaseDriverManifest.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DatabaseCapability {
    QueryExecution,
    MetadataBrowse,
    ObjectBrowser,
    ObjectSource,
    SchemaSearch,
    TableDataEdit,
    SqlFileExecution,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCapabilityFlags {
    #[serde(default)]
    pub query_execution: Option<bool>,
    #[serde(default)]
    pub metadata_browse: Option<bool>,
    #[serde(default)]
    pub object_browser: Option<bool>,
    #[serde(default)]
    pub object_source: Option<bool>,
    #[serde(default)]
    pub schema_search: Option<bool>,
    #[serde(default)]
    pub table_data_edit: Option<bool>,
    #[serde(default)]
    pub sql_file_execution: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseManifestEntry {
    pub db_type: DatabaseType,
    #[serde(default)]
    pub compare_modes: Vec<DatabaseCompareMode>,
    #[serde(default)]
    pub transfer_object_family: Option<DatabaseTransferObjectFamily>,
    #[serde(default)]
    pub transfer_support_level: Option<DatabaseTransferSupportLevel>,
    pub label: String,
    #[serde(default)]
    pub dialect: Option<String>,
    pub runtime_mode: DatabaseRuntimeMode,
    pub mcp_mode: String,
    #[serde(default)]
    pub agent_key: Option<String>,
    #[serde(default)]
    pub driver_store_visible: bool,
    #[serde(default)]
    pub driver_store_order: Option<u32>,
    #[serde(default)]
    pub driver_profiles: Vec<DatabaseDriverProfile>,
    #[serde(default)]
    pub managed_drivers: Vec<ManagedDriverEntry>,
    #[serde(default)]
    pub single_connection_pool: bool,
    #[serde(default)]
    pub metadata_connection_scoped: bool,
    #[serde(default)]
    pub skip_tcp_probe: bool,
    #[serde(default)]
    pub default_port: Option<u16>,
    #[serde(default)]
    pub local_file: bool,
    #[serde(default)]
    pub specialized_surface: bool,
    pub support_level: DatabaseSupportLevel,
    #[serde(default)]
    pub capabilities: DatabaseCapabilityFlags,
}

impl DatabaseManifestEntry {
    pub fn capability(&self, capability: DatabaseCapability) -> bool {
        let flags = &self.capabilities;
        let explicit = match capability {
            DatabaseCapability::QueryExecution => flags.query_execution,
            DatabaseCapability::MetadataBrowse => flags.metadata_browse,
            DatabaseCapability::ObjectBrowser => flags.object_browser,
            DatabaseCapability::ObjectSource => flags.object_source,
            DatabaseCapability::SchemaSearch => flags.schema_search,
            DatabaseCapability::TableDataEdit => flags.table_data_edit,
            DatabaseCapability::SqlFileExecution => flags.sql_file_execution,
        };
        explicit.unwrap_or_else(|| support_level_default(self.support_level, capability))
    }
}

fn support_level_default(level: DatabaseSupportLevel, capability: DatabaseCapability) -> bool {
    use DatabaseCapability::*;
    match capability {
        QueryExecution => level == DatabaseSupportLevel::Connect,
        SqlFileExecution => true,
        MetadataBrowse | ObjectBrowser => level != DatabaseSupportLevel::Connect,
        SchemaSearch => matches!(level, DatabaseSupportLevel::Understand | DatabaseSupportLevel::Operate),
        TableDataEdit => level == DatabaseSupportLevel::Operate,
        ObjectSource => false,
    }
}

static DATABASE_MANIFEST: OnceLock<DatabaseManifestFile> = OnceLock::new();

fn manifest() -> &'static DatabaseManifestFile {
    DATABASE_MANIFEST.get_or_init(|| {
        serde_json::from_str(DATABASE_MANIFEST_JSON).expect("database-drivers.manifest.json must be valid")
    })
}

pub fn entries() -> &'static [DatabaseManifestEntry] {
    &manifest().drivers
}

pub fn entry(db_type: &DatabaseType) -> Option<&'static DatabaseManifestEntry> {
    entries().iter().find(|candidate| candidate.db_type == *db_type)
}

pub fn default_port(db_type: &DatabaseType) -> Option<u16> {
    entry(db_type).and_then(|candidate| candidate.default_port.or(candidate.local_file.then_some(0)))
}

pub fn agent_key(db_type: &DatabaseType) -> Option<&'static str> {
    entry(db_type).and_then(|candidate| candidate.agent_key.as_deref())
}

pub fn dialect_name(db_type: &DatabaseType) -> Option<&'static str> {
    entry(db_type).and_then(|candidate| candidate.dialect.as_deref())
}

pub fn transfer_object_family(db_type: &DatabaseType) -> Option<DatabaseTransferObjectFamily> {
    entry(db_type).and_then(|candidate| candidate.transfer_object_family)
}

pub fn transfer_support_level(db_type: &DatabaseType) -> Option<DatabaseTransferSupportLevel> {
    entry(db_type).and_then(|candidate| candidate.transfer_support_level)
}

pub fn supports_compare_mode(db_type: &DatabaseType, mode: DatabaseCompareMode) -> bool {
    entry(db_type).is_some_and(|candidate| candidate.compare_modes.contains(&mode))
}

pub fn supports_capability(db_type: &DatabaseType, capability: DatabaseCapability) -> bool {
    entry(db_type).is_some_and(|candidate| candidate.capability(capability))
}

pub fn is_agent_runtime(db_type: &DatabaseType) -> bool {
    entry(db_type).is_some_and(|candidate| candidate.runtime_mode == DatabaseRuntimeMode::Agent)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn manifest_entries_have_unique_database_types() {
        let mut seen = HashSet::new();
        assert!(entries().iter().all(|entry| seen.insert(entry.db_type)));
        assert_eq!(seen.len(), DatabaseType::ALL.len());
        assert!(DatabaseType::ALL.iter().all(|db_type| entry(db_type).is_some()));
    }

    #[test]
    fn database_type_strings_match_serde_contract() {
        for db_type in DatabaseType::ALL {
            let serialized = serde_json::to_string(db_type).expect("database type must serialize");
            assert_eq!(serialized, format!("\"{}\"", db_type.as_str()));
            let deserialized =
                serde_json::from_str::<DatabaseType>(&serialized).expect("database type must deserialize");
            assert_eq!(deserialized, *db_type);
        }
    }

    #[test]
    fn capabilities_fall_back_to_support_level_defaults() {
        assert!(supports_capability(&DatabaseType::Mysql, DatabaseCapability::ObjectSource));
        assert!(!supports_capability(&DatabaseType::Sqlite, DatabaseCapability::ObjectSource));
        assert!(supports_capability(&DatabaseType::Sqlite, DatabaseCapability::QueryExecution));
        assert!(!supports_capability(&DatabaseType::Nacos, DatabaseCapability::QueryExecution));
        assert!(!support_level_default(DatabaseSupportLevel::Operate, DatabaseCapability::QueryExecution));
        assert!(support_level_default(DatabaseSupportLevel::Browse, DatabaseCapability::MetadataBrowse));
    }

    #[test]
    fn manifest_contains_connection_runtime_defaults() {
        assert_eq!(entry(&DatabaseType::Mysql).map(|entry| entry.default_port), Some(Some(3306)));
        assert_eq!(entry(&DatabaseType::Postgres).map(|entry| entry.default_port), Some(Some(5432)));
        assert_eq!(entry(&DatabaseType::Sqlite).map(|entry| entry.skip_tcp_probe), Some(true));
        assert_eq!(entry(&DatabaseType::H2).map(|entry| entry.agent_key.as_deref()), Some(Some("h2")));
    }

    #[test]
    fn transfer_object_families_come_from_the_shared_manifest() {
        assert_eq!(transfer_object_family(&DatabaseType::Mysql), Some(DatabaseTransferObjectFamily::Mysql));
        assert_eq!(transfer_object_family(&DatabaseType::Kingbase), Some(DatabaseTransferObjectFamily::Postgres));
        assert_eq!(transfer_object_family(&DatabaseType::Dameng), Some(DatabaseTransferObjectFamily::Oracle));
        assert_eq!(transfer_object_family(&DatabaseType::SqlServer), Some(DatabaseTransferObjectFamily::SqlServer));
        assert_eq!(transfer_object_family(&DatabaseType::Sqlite), None);
    }

    #[test]
    fn transfer_support_levels_distinguish_evidence_strength() {
        assert_eq!(transfer_support_level(&DatabaseType::Mysql), Some(DatabaseTransferSupportLevel::Verified));
        assert_eq!(
            transfer_support_level(&DatabaseType::Kingbase),
            Some(DatabaseTransferSupportLevel::FamilyCompatible)
        );
        assert_eq!(transfer_support_level(&DatabaseType::Db2), Some(DatabaseTransferSupportLevel::BestEffort));
        assert_eq!(transfer_support_level(&DatabaseType::Gbase), None);
    }

    #[test]
    fn compare_modes_come_from_the_shared_manifest() {
        assert!(supports_compare_mode(&DatabaseType::Mysql, DatabaseCompareMode::Schema));
        assert!(supports_compare_mode(&DatabaseType::Mysql, DatabaseCompareMode::Data));
        assert!(supports_compare_mode(&DatabaseType::Kingbase, DatabaseCompareMode::Data));
        assert!(!supports_compare_mode(&DatabaseType::MongoDb, DatabaseCompareMode::Data));
        assert!(!supports_compare_mode(&DatabaseType::Redis, DatabaseCompareMode::Schema));
    }
}
