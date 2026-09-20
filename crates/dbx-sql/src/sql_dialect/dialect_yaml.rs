use serde::{Deserialize, Serialize};

use super::descriptor::{
    DialectCapabilityDescriptor, DialectKind, CAP_ADD_COLUMN, CAP_ALTER_EXISTING_COLUMN, CAP_ALTER_OWNER,
    CAP_ALTER_PRIMARY_KEY, CAP_AUTO_INCREMENT, CAP_COMMENT, CAP_CREATE_FUNCTION, CAP_CREATE_INDEX,
    CAP_CREATE_OR_REPLACE, CAP_CREATE_SEQUENCE, CAP_CREATE_TABLE, CAP_CREATE_TRIGGER, CAP_DROP_COLUMN,
    CAP_DROP_FUNCTION, CAP_DROP_INDEX, CAP_DROP_SEQUENCE, CAP_DROP_TABLE, CAP_DROP_TRIGGER, CAP_FOREIGN_KEY,
    CAP_GRANT_REVOKE, CAP_IDENTITY_COLUMNS, CAP_IF_NOT_EXISTS, CAP_INDEX_COMMENT, CAP_INDEX_FILTER, CAP_INDEX_INCLUDE,
    CAP_INDEX_TYPE, CAP_REBUILD_INDEX, CAP_RENAME_COLUMN, CAP_REORDER_COLUMN, CAP_TEMPORARY_TABLE,
    CAP_TRANSACTIONAL_DDL, CAP_TRUNCATE_TABLE,
};

// ============================================================================
// YAML Dialect Descriptor — complete Schema matching V4 design §3.1.1
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DialectYaml {
    pub dialect: DialectMeta,
    #[serde(default)]
    pub types: Vec<DialectType>,
    #[serde(default)]
    pub ddl_capabilities: DdlCapabilitiesYaml,
    #[serde(default)]
    pub structural_capabilities: StructuralCapabilitiesYaml,
    #[serde(default)]
    pub rollback_templates: RollbackTemplatesYaml,
    #[serde(default)]
    pub online_safety: OnlineSafetyYaml,
    #[serde(default)]
    pub destruction_level: DestructionLevelsYaml,
    pub identifier_rules: IdentifierRules,
    #[serde(default)]
    pub metadata_queries: MetadataQueriesYaml,
    #[serde(default)]
    pub pre_execution_checks: Vec<PreExecutionCheck>,
    #[serde(default)]
    pub version_conditions: VersionConditionsYaml,
    #[serde(default)]
    pub script_templates: ScriptTemplatesYaml,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DialectMeta {
    pub name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub versions: Vec<DialectVersion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DialectVersion {
    pub version: String,
    #[serde(default = "default_version_status")]
    pub status: String,
}

fn default_version_status() -> String {
    "COMPATIBLE".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DialectType {
    pub name: String,
    pub category: String,
    #[serde(default)]
    pub max_precision: Option<u32>,
    #[serde(default)]
    pub precision_range: Option<[i64; 2]>,
    #[serde(default)]
    pub has_length: bool,
    #[serde(default)]
    pub has_precision: bool,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default = "default_fidelity")]
    pub semantic_fidelity_base: f64,
}

fn default_fidelity() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DdlCapabilitiesYaml {
    #[serde(default = "default_true")]
    pub add_column: bool,
    #[serde(default = "default_true")]
    pub drop_column: bool,
    #[serde(default)]
    pub rename_column: bool,
    #[serde(default)]
    pub alter_column_type: bool,
    #[serde(default)]
    pub reorder_column: bool,
    #[serde(default)]
    pub comment: bool,
    #[serde(default = "default_true")]
    pub create_index: bool,
    #[serde(default = "default_true")]
    pub drop_index: bool,
    #[serde(default)]
    pub rebuild_index: bool,
    #[serde(default)]
    pub index_type: bool,
    #[serde(default)]
    pub index_include: bool,
    #[serde(default)]
    pub index_filter: bool,
    #[serde(default)]
    pub index_comment: bool,
    #[serde(default)]
    pub alter_primary_key: bool,
    #[serde(default)]
    pub foreign_key: bool,
    #[serde(default = "default_true")]
    pub create_table: bool,
    #[serde(default = "default_true")]
    pub drop_table: bool,
    #[serde(default)]
    pub truncate_table: bool,
    #[serde(default)]
    pub create_trigger: bool,
    #[serde(default)]
    pub drop_trigger: bool,
    #[serde(default)]
    pub create_function: bool,
    #[serde(default)]
    pub drop_function: bool,
    #[serde(default)]
    pub create_sequence: bool,
    #[serde(default)]
    pub drop_sequence: bool,
    #[serde(default)]
    pub alter_owner: bool,
    #[serde(default)]
    pub grant_revoke: bool,
    #[serde(default)]
    pub if_not_exists: bool,
    #[serde(default)]
    pub create_or_replace: bool,
    #[serde(default)]
    pub temporary_table: bool,
    #[serde(default)]
    pub transactional_ddl: bool,
    #[serde(default)]
    pub auto_increment: bool,
    #[serde(default)]
    pub identity_columns: bool,
    #[serde(default)]
    pub templates: DdlTemplatesYaml,
}

impl Default for DdlCapabilitiesYaml {
    fn default() -> Self {
        Self {
            add_column: true,
            drop_column: true,
            rename_column: false,
            alter_column_type: false,
            reorder_column: false,
            comment: false,
            create_index: true,
            drop_index: true,
            rebuild_index: false,
            index_type: false,
            index_include: false,
            index_filter: false,
            index_comment: false,
            alter_primary_key: false,
            foreign_key: false,
            create_table: true,
            drop_table: true,
            truncate_table: false,
            create_trigger: false,
            drop_trigger: false,
            create_function: false,
            drop_function: false,
            create_sequence: false,
            drop_sequence: false,
            alter_owner: false,
            grant_revoke: false,
            if_not_exists: false,
            create_or_replace: false,
            temporary_table: false,
            transactional_ddl: false,
            auto_increment: false,
            identity_columns: false,
            templates: DdlTemplatesYaml::default(),
        }
    }
}

fn default_true() -> bool {
    true
}

impl DdlCapabilitiesYaml {
    fn apply_descriptor_flags(&mut self, flags: u64) {
        self.add_column = flags & CAP_ADD_COLUMN != 0;
        self.drop_column = flags & CAP_DROP_COLUMN != 0;
        self.rename_column = flags & CAP_RENAME_COLUMN != 0;
        self.alter_column_type = flags & CAP_ALTER_EXISTING_COLUMN != 0;
        self.reorder_column = flags & CAP_REORDER_COLUMN != 0;
        self.comment = flags & CAP_COMMENT != 0;
        self.create_index = flags & CAP_CREATE_INDEX != 0;
        self.drop_index = flags & CAP_DROP_INDEX != 0;
        self.rebuild_index = flags & CAP_REBUILD_INDEX != 0;
        self.index_type = flags & CAP_INDEX_TYPE != 0;
        self.index_include = flags & CAP_INDEX_INCLUDE != 0;
        self.index_filter = flags & CAP_INDEX_FILTER != 0;
        self.index_comment = flags & CAP_INDEX_COMMENT != 0;
        self.alter_primary_key = flags & CAP_ALTER_PRIMARY_KEY != 0;
        self.foreign_key = flags & CAP_FOREIGN_KEY != 0;
        self.create_table = flags & CAP_CREATE_TABLE != 0;
        self.drop_table = flags & CAP_DROP_TABLE != 0;
        self.truncate_table = flags & CAP_TRUNCATE_TABLE != 0;
        self.create_trigger = flags & CAP_CREATE_TRIGGER != 0;
        self.drop_trigger = flags & CAP_DROP_TRIGGER != 0;
        self.create_function = flags & CAP_CREATE_FUNCTION != 0;
        self.drop_function = flags & CAP_DROP_FUNCTION != 0;
        self.create_sequence = flags & CAP_CREATE_SEQUENCE != 0;
        self.drop_sequence = flags & CAP_DROP_SEQUENCE != 0;
        self.alter_owner = flags & CAP_ALTER_OWNER != 0;
        self.grant_revoke = flags & CAP_GRANT_REVOKE != 0;
        self.if_not_exists = flags & CAP_IF_NOT_EXISTS != 0;
        self.create_or_replace = flags & CAP_CREATE_OR_REPLACE != 0;
        self.temporary_table = flags & CAP_TEMPORARY_TABLE != 0;
        self.transactional_ddl = flags & CAP_TRANSACTIONAL_DDL != 0;
        self.auto_increment = flags & CAP_AUTO_INCREMENT != 0;
        self.identity_columns = flags & CAP_IDENTITY_COLUMNS != 0;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DdlTemplatesYaml {
    #[serde(default)]
    pub add_column: String,
    #[serde(default)]
    pub drop_column: String,
    #[serde(default)]
    pub rename_column: String,
    #[serde(default)]
    pub modify_column: String,
    #[serde(default)]
    pub create_table: String,
    #[serde(default)]
    pub drop_table: String,
    #[serde(default)]
    pub create_index: String,
    #[serde(default)]
    pub drop_index: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RollbackTemplatesYaml {
    #[serde(default)]
    pub add_column: String,
    #[serde(default)]
    pub drop_column: String,
    #[serde(default)]
    pub rename_column: String,
    #[serde(default)]
    pub modify_column: String,
    #[serde(default)]
    pub create_table: String,
    #[serde(default)]
    pub drop_table: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OnlineSafetyYaml {
    #[serde(default)]
    pub add_column: SafetyEntry,
    #[serde(default)]
    pub modify_column: SafetyEntry,
    #[serde(default)]
    pub drop_column: SafetyEntry,
    #[serde(default)]
    pub drop_table: SafetyEntry,
    #[serde(default)]
    pub truncate: SafetyEntry,
    #[serde(default)]
    pub create_index: SafetyEntry,
    #[serde(default)]
    pub drop_index: SafetyEntry,
    pub osc_template: Option<OscTemplateYaml>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SafetyEntry {
    #[serde(default = "default_blocking_short")]
    pub level: String,
    #[serde(default = "default_cost_medium")]
    pub cost: String,
}

fn default_blocking_short() -> String {
    "BLOCKING_SHORT".to_string()
}

fn default_cost_medium() -> String {
    "MEDIUM".to_string()
}

impl Default for SafetyEntry {
    fn default() -> Self {
        Self { level: "NON_BLOCKING".to_string(), cost: "LOW".to_string() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OscTemplateYaml {
    #[serde(default)]
    pub gh_ost: String,
    #[serde(default)]
    pub pt_osc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DestructionLevelsYaml {
    #[serde(default = "default_fatal")]
    pub drop_table: String,
    #[serde(default = "default_fatal")]
    pub drop_schema: String,
    #[serde(default = "default_dangerous")]
    pub truncate: String,
    #[serde(default = "default_dangerous")]
    pub drop_column: String,
    #[serde(default = "default_modify")]
    pub alter_type: String,
    #[serde(default = "default_safe")]
    pub add_column: String,
    #[serde(default = "default_safe")]
    pub create_table: String,
}

fn default_fatal() -> String {
    "FATAL".to_string()
}
fn default_dangerous() -> String {
    "DANGEROUS".to_string()
}
fn default_modify() -> String {
    "MODIFY".to_string()
}
fn default_safe() -> String {
    "SAFE".to_string()
}

/// Structural/behavioral dialect properties (replaces hardcoded per-kind inference in to_descriptor).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuralCapabilitiesYaml {
    #[serde(default)]
    pub supports_schemas: bool,
    #[serde(default)]
    pub supports_catalogs: bool,
    #[serde(default = "default_max_cols")]
    pub max_columns_per_table: u32,
    #[serde(default = "default_max_idxs")]
    pub max_indexes_per_table: u32,
    #[serde(default = "default_query_bytes")]
    pub max_query_size_bytes: u64,
    #[serde(default)]
    pub supports_full_text_index: bool,
    #[serde(default)]
    pub supports_spatial_index: bool,
    #[serde(default)]
    pub supports_partitioning: bool,
    #[serde(default)]
    pub supports_table_sampling: bool,
    #[serde(default)]
    pub max_foreign_key_name_length: u32,
    #[serde(default)]
    pub supports_on_update_cascade: bool,
    #[serde(default)]
    pub supports_on_delete_set_null: bool,
    #[serde(default)]
    pub supports_deferrable_constraints: bool,
    #[serde(default)]
    pub supports_array_type: bool,
    #[serde(default)]
    pub supports_json_type: bool,
    #[serde(default)]
    pub supports_enum_type: bool,
    #[serde(default)]
    pub supports_uuid_type: bool,
    #[serde(default)]
    pub supports_sequences: bool,
}

fn default_max_cols() -> u32 {
    1600
}
fn default_max_idxs() -> u32 {
    100
}
fn default_query_bytes() -> u64 {
    16 * 1024 * 1024
}

impl Default for StructuralCapabilitiesYaml {
    fn default() -> Self {
        Self {
            supports_schemas: false,
            supports_catalogs: false,
            max_columns_per_table: 1600,
            max_indexes_per_table: 100,
            max_query_size_bytes: 16 * 1024 * 1024,
            supports_full_text_index: false,
            supports_spatial_index: false,
            supports_partitioning: false,
            supports_table_sampling: false,
            max_foreign_key_name_length: 0,
            supports_on_update_cascade: false,
            supports_on_delete_set_null: false,
            supports_deferrable_constraints: false,
            supports_array_type: false,
            supports_json_type: false,
            supports_enum_type: false,
            supports_uuid_type: false,
            supports_sequences: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentifierRules {
    pub quote_char: String,
    #[serde(default)]
    pub case_sensitive: bool,
    pub max_length: u32,
}

impl Default for IdentifierRules {
    fn default() -> Self {
        Self { quote_char: "\"".to_string(), case_sensitive: false, max_length: 128 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MetadataQueriesYaml {
    #[serde(default)]
    pub list_tables: Option<MetadataQuery>,
    #[serde(default)]
    pub list_columns: Option<MetadataQuery>,
    #[serde(default)]
    pub list_indexes: Option<MetadataQuery>,
    #[serde(default)]
    pub list_foreign_keys: Option<MetadataQuery>,
    #[serde(default)]
    pub list_triggers: Option<MetadataQuery>,
    #[serde(default)]
    pub list_functions: Option<MetadataQuery>,
    #[serde(default)]
    pub list_sequences: Option<MetadataQuery>,
    pub dependencies: Option<DependencyQuery>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataQuery {
    pub sql: String,
    #[serde(default = "default_light")]
    pub performance_profile: String,
}

fn default_light() -> String {
    "LIGHT".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyQuery {
    pub sql: String,
    #[serde(default)]
    pub depth_support: u32,
    #[serde(default = "default_heavy")]
    pub performance_profile: String,
}

fn default_heavy() -> String {
    "HEAVY".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreExecutionCheck {
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub threshold: Option<PreExecThreshold>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreExecThreshold {
    #[serde(default)]
    pub min_bytes: Option<u64>,
    #[serde(default)]
    pub min_rows: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VersionConditionsYaml {
    #[serde(default)]
    pub add_column_concurrent: Vec<VersionConditionEntry>,
    #[serde(default)]
    pub drop_column_concurrent: Vec<VersionConditionEntry>,
    #[serde(default)]
    pub modify_column_concurrent: Vec<VersionConditionEntry>,
}

/// Script-level Jinja2 template overrides (Phase 14 template dialect migration).
/// When set, these replace the 3 hardcoded template strings in ScriptTemplateEngine.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ScriptTemplatesYaml {
    #[serde(default)]
    pub schema_sync: Option<String>,
    #[serde(default)]
    pub joint_orchestration: Option<String>,
    #[serde(default)]
    pub batch: Option<String>,
    #[serde(default)]
    pub lock_timeout_statement: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionConditionEntry {
    #[serde(default)]
    pub min_version: Option<String>,
    #[serde(default)]
    pub max_version: Option<String>,
    pub template: String,
}

// ============================================================================
// DialectYaml → DialectCapabilityDescriptor conversion
// ============================================================================

impl DialectYaml {
    fn build_capability_flags(caps: &DdlCapabilitiesYaml) -> u64 {
        let mut flags: u64 = 0;
        if caps.add_column {
            flags |= CAP_ADD_COLUMN;
        }
        if caps.drop_column {
            flags |= CAP_DROP_COLUMN;
        }
        if caps.rename_column {
            flags |= CAP_RENAME_COLUMN;
        }
        if caps.alter_column_type {
            flags |= CAP_ALTER_EXISTING_COLUMN;
        }
        if caps.reorder_column {
            flags |= CAP_REORDER_COLUMN;
        }
        if caps.comment {
            flags |= CAP_COMMENT;
        }
        if caps.create_index {
            flags |= CAP_CREATE_INDEX;
        }
        if caps.drop_index {
            flags |= CAP_DROP_INDEX;
        }
        if caps.rebuild_index {
            flags |= CAP_REBUILD_INDEX;
        }
        if caps.index_type {
            flags |= CAP_INDEX_TYPE;
        }
        if caps.index_include {
            flags |= CAP_INDEX_INCLUDE;
        }
        if caps.index_filter {
            flags |= CAP_INDEX_FILTER;
        }
        if caps.index_comment {
            flags |= CAP_INDEX_COMMENT;
        }
        if caps.alter_primary_key {
            flags |= CAP_ALTER_PRIMARY_KEY;
        }
        if caps.foreign_key {
            flags |= CAP_FOREIGN_KEY;
        }
        if caps.create_table {
            flags |= CAP_CREATE_TABLE;
        }
        if caps.drop_table {
            flags |= CAP_DROP_TABLE;
        }
        if caps.truncate_table {
            flags |= CAP_TRUNCATE_TABLE;
        }
        if caps.create_trigger {
            flags |= CAP_CREATE_TRIGGER;
        }
        if caps.drop_trigger {
            flags |= CAP_DROP_TRIGGER;
        }
        if caps.create_function {
            flags |= CAP_CREATE_FUNCTION;
        }
        if caps.drop_function {
            flags |= CAP_DROP_FUNCTION;
        }
        if caps.create_sequence {
            flags |= CAP_CREATE_SEQUENCE;
        }
        if caps.drop_sequence {
            flags |= CAP_DROP_SEQUENCE;
        }
        if caps.alter_owner {
            flags |= CAP_ALTER_OWNER;
        }
        if caps.grant_revoke {
            flags |= CAP_GRANT_REVOKE;
        }
        if caps.if_not_exists {
            flags |= CAP_IF_NOT_EXISTS;
        }
        if caps.create_or_replace {
            flags |= CAP_CREATE_OR_REPLACE;
        }
        if caps.temporary_table {
            flags |= CAP_TEMPORARY_TABLE;
        }
        if caps.transactional_ddl {
            flags |= CAP_TRANSACTIONAL_DDL;
        }
        if caps.auto_increment {
            flags |= CAP_AUTO_INCREMENT;
        }
        if caps.identity_columns {
            flags |= CAP_IDENTITY_COLUMNS;
        }
        flags
    }

    pub fn to_descriptor(&self, kind: DialectKind) -> DialectCapabilityDescriptor {
        let flags = Self::build_capability_flags(&self.ddl_capabilities);
        let id = &self.identifier_rules;
        let sc = &self.structural_capabilities;

        DialectCapabilityDescriptor {
            dialect: kind,
            flags,
            max_identifier_length: id.max_length,
            supports_schemas: sc.supports_schemas,
            supports_catalogs: sc.supports_catalogs,
            max_columns_per_table: sc.max_columns_per_table,
            max_indexes_per_table: sc.max_indexes_per_table,
            max_query_size_bytes: sc.max_query_size_bytes,
            supports_full_text_index: sc.supports_full_text_index,
            supports_spatial_index: sc.supports_spatial_index,
            supports_partitioning: sc.supports_partitioning,
            supports_table_sampling: sc.supports_table_sampling,
            max_foreign_key_name_length: if sc.max_foreign_key_name_length > 0 {
                sc.max_foreign_key_name_length
            } else {
                id.max_length
            },
            supports_on_update_cascade: sc.supports_on_update_cascade,
            supports_on_delete_set_null: sc.supports_on_delete_set_null,
            supports_deferrable_constraints: sc.supports_deferrable_constraints,
            supports_array_type: sc.supports_array_type,
            supports_json_type: sc.supports_json_type,
            supports_enum_type: sc.supports_enum_type,
            supports_uuid_type: sc.supports_uuid_type,
            supports_identity_columns: flags & CAP_IDENTITY_COLUMNS != 0,
            supports_auto_increment: flags & CAP_AUTO_INCREMENT != 0,
            supports_sequences: sc.supports_sequences,
        }
    }

    pub fn dialect_kind(&self) -> Option<DialectKind> {
        DialectKind::from_label(&self.dialect.name)
    }

    pub fn to_yaml_string(&self) -> Result<String, String> {
        serde_yaml::to_string(self).map_err(|e| format!("YAML serialization error: {e}"))
    }

    pub fn from_descriptor(kind: DialectKind) -> Self {
        let desc = DialectCapabilityDescriptor::for_dialect(kind);
        Self::from_descriptor_with_caps(kind, &desc)
    }

    pub fn from_descriptor_with_caps(kind: DialectKind, desc: &DialectCapabilityDescriptor) -> Self {
        let (versions, mut ddl_caps) = match kind {
            DialectKind::Mysql => (
                vec![
                    DialectVersion { version: "8.0".to_string(), status: "RECOMMENDED".to_string() },
                    DialectVersion { version: "5.7".to_string(), status: "COMPATIBLE".to_string() },
                ],
                DdlCapabilitiesYaml {
                    add_column: true,
                    drop_column: true,
                    rename_column: true,
                    alter_column_type: true,
                    reorder_column: true,
                    comment: true,
                    create_index: true,
                    drop_index: true,
                    rebuild_index: true,
                    index_type: true,
                    index_comment: true,
                    alter_primary_key: true,
                    foreign_key: true,
                    truncate_table: true,
                    create_trigger: true,
                    drop_trigger: true,
                    create_function: true,
                    drop_function: true,
                    create_sequence: true,
                    drop_sequence: true,
                    alter_owner: true,
                    grant_revoke: true,
                    if_not_exists: true,
                    temporary_table: true,
                    auto_increment: true,
                    ..Default::default()
                },
            ),
            DialectKind::Postgres => (
                vec![
                    DialectVersion { version: "16".to_string(), status: "RECOMMENDED".to_string() },
                    DialectVersion { version: "15".to_string(), status: "COMPATIBLE".to_string() },
                ],
                DdlCapabilitiesYaml {
                    rename_column: true,
                    alter_column_type: true,
                    comment: true,
                    create_index: true,
                    drop_index: true,
                    rebuild_index: true,
                    index_type: true,
                    index_include: true,
                    index_filter: true,
                    index_comment: true,
                    alter_primary_key: true,
                    foreign_key: true,
                    truncate_table: true,
                    create_trigger: true,
                    drop_trigger: true,
                    create_function: true,
                    drop_function: true,
                    create_sequence: true,
                    drop_sequence: true,
                    alter_owner: true,
                    grant_revoke: true,
                    if_not_exists: true,
                    create_or_replace: true,
                    transactional_ddl: true,
                    temporary_table: true,
                    identity_columns: true,
                    ..Default::default()
                },
            ),
            DialectKind::Sqlite => (
                vec![DialectVersion { version: "3".to_string(), status: "RECOMMENDED".to_string() }],
                DdlCapabilitiesYaml {
                    rename_column: true,
                    create_index: true,
                    drop_index: true,
                    rebuild_index: true,
                    index_filter: true,
                    truncate_table: true,
                    create_trigger: true,
                    drop_trigger: true,
                    create_function: true,
                    drop_function: true,
                    create_sequence: true,
                    drop_sequence: true,
                    if_not_exists: true,
                    auto_increment: true,
                    ..Default::default()
                },
            ),
            DialectKind::DuckDb => (
                vec![DialectVersion { version: "1".to_string(), status: "RECOMMENDED".to_string() }],
                DdlCapabilitiesYaml {
                    rename_column: true,
                    create_index: true,
                    drop_index: true,
                    rebuild_index: true,
                    truncate_table: true,
                    if_not_exists: true,
                    create_or_replace: true,
                    temporary_table: true,
                    ..Default::default()
                },
            ),
            DialectKind::SqlServer => (
                vec![DialectVersion { version: "2022".to_string(), status: "RECOMMENDED".to_string() }],
                DdlCapabilitiesYaml {
                    rename_column: true,
                    alter_column_type: true,
                    comment: true,
                    create_index: true,
                    drop_index: true,
                    rebuild_index: true,
                    index_type: true,
                    index_include: true,
                    index_filter: true,
                    index_comment: true,
                    truncate_table: true,
                    create_trigger: true,
                    drop_trigger: true,
                    create_function: true,
                    drop_function: true,
                    create_sequence: true,
                    drop_sequence: true,
                    alter_owner: true,
                    grant_revoke: true,
                    if_not_exists: true,
                    temporary_table: true,
                    transactional_ddl: true,
                    identity_columns: true,
                    ..Default::default()
                },
            ),
            DialectKind::Oracle => (
                vec![DialectVersion { version: "21c".to_string(), status: "RECOMMENDED".to_string() }],
                DdlCapabilitiesYaml {
                    rename_column: true,
                    alter_column_type: true,
                    comment: true,
                    create_index: true,
                    drop_index: true,
                    rebuild_index: true,
                    index_type: true,
                    truncate_table: true,
                    create_trigger: true,
                    drop_trigger: true,
                    create_function: true,
                    drop_function: true,
                    create_sequence: true,
                    drop_sequence: true,
                    alter_owner: true,
                    grant_revoke: true,
                    if_not_exists: true,
                    temporary_table: true,
                    ..Default::default()
                },
            ),
            DialectKind::H2 => (
                vec![DialectVersion { version: "2".to_string(), status: "RECOMMENDED".to_string() }],
                DdlCapabilitiesYaml {
                    rename_column: true,
                    alter_column_type: true,
                    comment: true,
                    create_index: true,
                    drop_index: true,
                    rebuild_index: true,
                    truncate_table: true,
                    create_trigger: true,
                    drop_trigger: true,
                    create_function: true,
                    drop_function: true,
                    if_not_exists: true,
                    temporary_table: true,
                    identity_columns: true,
                    ..Default::default()
                },
            ),
            DialectKind::ClickHouse => (
                vec![DialectVersion { version: "24".to_string(), status: "RECOMMENDED".to_string() }],
                DdlCapabilitiesYaml {
                    rename_column: true,
                    alter_column_type: true,
                    reorder_column: true,
                    comment: true,
                    truncate_table: true,
                    if_not_exists: true,
                    temporary_table: true,
                    ..Default::default()
                },
            ),
            _ => (
                vec![DialectVersion { version: "1".to_string(), status: "COMPATIBLE".to_string() }],
                DdlCapabilitiesYaml::default(),
            ),
        };

        // Export must preserve the canonical descriptor exactly; the
        // hard-coded blocks above only provide human-friendly templates.
        ddl_caps.apply_descriptor_flags(desc.flags);

        let identifier_rules = match kind {
            DialectKind::Mysql => IdentifierRules {
                quote_char: "`".to_string(),
                case_sensitive: false,
                max_length: desc.max_identifier_length,
            },
            DialectKind::Postgres => IdentifierRules {
                quote_char: "\"".to_string(),
                case_sensitive: true,
                max_length: desc.max_identifier_length,
            },
            DialectKind::Sqlite => IdentifierRules {
                quote_char: "\"".to_string(),
                case_sensitive: false,
                max_length: desc.max_identifier_length,
            },
            DialectKind::SqlServer => IdentifierRules {
                quote_char: "\"".to_string(),
                case_sensitive: false,
                max_length: desc.max_identifier_length,
            },
            DialectKind::Oracle => IdentifierRules {
                quote_char: "\"".to_string(),
                case_sensitive: true,
                max_length: desc.max_identifier_length,
            },
            _ => IdentifierRules { quote_char: "\"".to_string(), case_sensitive: false, max_length: 128 },
        };

        DialectYaml {
            dialect: DialectMeta { name: kind_name(kind), display_name: Some(kind_name(kind)), versions },
            types: vec![],
            ddl_capabilities: ddl_caps,
            structural_capabilities: StructuralCapabilitiesYaml {
                supports_schemas: desc.supports_schemas,
                supports_catalogs: desc.supports_catalogs,
                max_columns_per_table: desc.max_columns_per_table,
                max_indexes_per_table: desc.max_indexes_per_table,
                max_query_size_bytes: desc.max_query_size_bytes,
                supports_full_text_index: desc.supports_full_text_index,
                supports_spatial_index: desc.supports_spatial_index,
                supports_partitioning: desc.supports_partitioning,
                supports_table_sampling: desc.supports_table_sampling,
                max_foreign_key_name_length: desc.max_foreign_key_name_length,
                supports_on_update_cascade: desc.supports_on_update_cascade,
                supports_on_delete_set_null: desc.supports_on_delete_set_null,
                supports_deferrable_constraints: desc.supports_deferrable_constraints,
                supports_array_type: desc.supports_array_type,
                supports_json_type: desc.supports_json_type,
                supports_enum_type: desc.supports_enum_type,
                supports_uuid_type: desc.supports_uuid_type,
                supports_sequences: desc.supports_sequences,
            },
            identifier_rules,
            ..Default::default()
        }
    }
}

fn kind_name(kind: DialectKind) -> String {
    match kind {
        DialectKind::Mysql => "MySQL",
        DialectKind::Postgres => "PostgreSQL",
        DialectKind::Sqlite => "SQLite",
        DialectKind::DuckDb => "DuckDB",
        DialectKind::SqlServer => "SQL Server",
        DialectKind::Oracle => "Oracle",
        DialectKind::H2 => "H2",
        DialectKind::ClickHouse => "ClickHouse",
        DialectKind::ManticoreSearch => "ManticoreSearch",
        DialectKind::Informix => "Informix",
        DialectKind::Questdb => "QuestDB",
        DialectKind::Unsupported => "Unsupported",
    }
    .to_string()
}

// ============================================================================
// Schema validation
// ============================================================================

#[derive(Debug, Clone)]
pub struct YamlValidationError {
    pub field: String,
    pub message: String,
}

impl std::fmt::Display for YamlValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.field, self.message)
    }
}

impl DialectYaml {
    pub fn validate(&self) -> Vec<YamlValidationError> {
        let mut errors = Vec::new();

        if self.dialect.name.is_empty() {
            errors.push(YamlValidationError {
                field: "dialect.name".to_string(),
                message: "dialect name is required".to_string(),
            });
        }

        if self.identifier_rules.max_length == 0 {
            errors.push(YamlValidationError {
                field: "identifier_rules.max_length".to_string(),
                message: "max_length must be > 0".to_string(),
            });
        }

        if self.identifier_rules.quote_char.is_empty() {
            errors.push(YamlValidationError {
                field: "identifier_rules.quote_char".to_string(),
                message: "quote_char is required".to_string(),
            });
        }

        errors
    }

    pub fn is_valid(&self) -> bool {
        self.validate().is_empty()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_minimal_mysql_yaml() {
        let yaml = r#"
dialect:
  name: "MySQL"
  versions:
    - version: "8.0"
      status: "RECOMMENDED"
identifier_rules:
  quote_char: "`"
  max_length: 64
"#;
        let parsed: DialectYaml = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(parsed.dialect.name, "MySQL");
        assert_eq!(parsed.identifier_rules.quote_char, "`");
        assert_eq!(parsed.identifier_rules.max_length, 64);
        assert!(parsed.is_valid());
    }

    #[test]
    fn ddl_capability_default_matches_serde_defaults() {
        let from_default = DdlCapabilitiesYaml::default();
        let from_yaml: DdlCapabilitiesYaml = serde_yaml::from_str("{}").unwrap();

        assert_eq!(DialectYaml::build_capability_flags(&from_default), DialectYaml::build_capability_flags(&from_yaml));
        assert!(from_default.add_column);
        assert!(from_default.drop_column);
        assert!(from_default.create_index);
        assert!(from_default.drop_index);
        assert!(from_default.create_table);
        assert!(from_default.drop_table);
    }

    #[test]
    fn parse_mysql_with_capabilities() {
        let yaml = r#"
dialect:
  name: "MySQL"
  display_name: "MySQL"
  versions:
    - version: "8.0"
      status: "RECOMMENDED"
    - version: "5.7"
      status: "COMPATIBLE"
types:
  - name: "VARCHAR"
    category: "STRING"
    max_precision: 65535
    has_length: true
    aliases: ["CHARACTER VARYING"]
  - name: "INT"
    category: "INTEGER"
    aliases: ["INTEGER"]
ddl_capabilities:
  add_column: true
  drop_column: true
  rename_column: true
  alter_column_type: true
  reorder_column: true
  comment: true
  create_index: true
  drop_index: true
  rebuild_index: true
  index_type: true
  index_comment: true
  alter_primary_key: true
  foreign_key: true
  truncate_table: true
  create_trigger: true
  drop_trigger: true
  create_function: true
  drop_function: true
  create_sequence: true
  drop_sequence: true
  alter_owner: true
  grant_revoke: true
  if_not_exists: true
  temporary_table: true
  auto_increment: true
  templates:
    add_column: "ALTER TABLE {table} ADD COLUMN {column} {type}"
    drop_column: "ALTER TABLE {table} DROP COLUMN {column}"
    rename_column: "ALTER TABLE {table} RENAME COLUMN {old} TO {new}"
    modify_column: "ALTER TABLE {table} MODIFY COLUMN {column} {type}"
rollback_templates:
  add_column: "ALTER TABLE {table} DROP COLUMN {column}"
  drop_column: "ALTER TABLE {table} ADD COLUMN {column} {original_type}"
  rename_column: "ALTER TABLE {table} RENAME COLUMN {new} TO {old}"
  modify_column: "ALTER TABLE {table} MODIFY COLUMN {column} {original_type}"
online_safety:
  add_column:
    level: "BLOCKING_SHORT"
    cost: "LOW"
  modify_column:
    level: "BLOCKING_LONG"
    cost: "MEDIUM"
  drop_column:
    level: "BLOCKING_LONG"
    cost: "MEDIUM"
  osc_template:
    gh_ost: "gh-ost --alter='{ddl}' --execute ..."
    pt_osc: "pt-online-schema-change --alter='{ddl}' --execute ..."
destruction_level:
  drop_table: "FATAL"
  drop_column: "DANGEROUS"
  truncate: "DANGEROUS"
identifier_rules:
  quote_char: "`"
  case_sensitive: false
  max_length: 64
metadata_queries:
  list_tables:
    sql: "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '{schema}'"
    performance_profile: "LIGHT"
  dependencies:
    sql: "SELECT ..."
    depth_support: 2
    performance_profile: "HEAVY"
pre_execution_checks:
  - name: "tablespace_free"
    sql: "SELECT ..."
    threshold:
      min_bytes: 1073741824
version_conditions:
  add_column_concurrent:
    - min_version: "8.0"
      template: "ALTER TABLE {table} ADD COLUMN {column} {type}, ALGORITHM=INPLACE"
    - max_version: "8.0"
      template: "ALTER TABLE {table} ADD COLUMN {column} {type}"
"#;
        let parsed: DialectYaml = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(parsed.dialect.name, "MySQL");
        assert_eq!(parsed.types.len(), 2);
        assert_eq!(parsed.types[0].name, "VARCHAR");
        assert!(parsed.ddl_capabilities.add_column);
        assert!(!parsed.ddl_capabilities.transactional_ddl);
        assert_eq!(parsed.ddl_capabilities.templates.add_column, "ALTER TABLE {table} ADD COLUMN {column} {type}");
        assert_eq!(parsed.online_safety.add_column.level, "BLOCKING_SHORT");
        assert_eq!(parsed.destruction_level.drop_table, "FATAL");
        assert_eq!(parsed.metadata_queries.list_tables.as_ref().unwrap().performance_profile, "LIGHT");
        assert_eq!(parsed.metadata_queries.dependencies.as_ref().unwrap().depth_support, 2);
        assert_eq!(parsed.pre_execution_checks.len(), 1);
        assert_eq!(parsed.version_conditions.add_column_concurrent.len(), 2);
        assert!(parsed.is_valid());
    }

    #[test]
    fn yaml_to_descriptor_mysql() {
        let yaml = r#"
dialect:
  name: "MySQL"
  versions:
    - version: "8.0"
ddl_capabilities:
  add_column: true
  drop_column: true
  rename_column: true
  alter_column_type: true
  create_index: true
  drop_index: true
  foreign_key: true
  if_not_exists: true
  auto_increment: true
  grant_revoke: true
  comment: true
  alter_owner: true
identifier_rules:
  quote_char: "`"
  max_length: 64
"#;
        let parsed: DialectYaml = serde_yaml::from_str(yaml).unwrap();
        let desc = parsed.to_descriptor(DialectKind::Mysql);
        assert!(desc.has_capability(CAP_ADD_COLUMN));
        assert!(desc.has_capability(CAP_RENAME_COLUMN));
        assert!(desc.has_capability(CAP_FOREIGN_KEY));
        assert!(desc.has_capability(CAP_IF_NOT_EXISTS));
        assert!(desc.has_capability(CAP_AUTO_INCREMENT));
        assert!(!desc.has_capability(CAP_TRANSACTIONAL_DDL));
        assert_eq!(desc.max_identifier_length, 64);
        assert!(desc.supports_auto_increment);
    }

    #[test]
    fn yaml_default_capabilities_are_true() {
        let yaml = r#"
dialect:
  name: "Test"
  versions: []
identifier_rules:
  quote_char: "\""
  max_length: 128
"#;
        let parsed: DialectYaml = serde_yaml::from_str(yaml).unwrap();
        assert!(parsed.ddl_capabilities.add_column);
        assert!(parsed.ddl_capabilities.drop_column);
        assert!(parsed.ddl_capabilities.create_table);
        assert!(parsed.ddl_capabilities.drop_table);
        assert!(parsed.ddl_capabilities.create_index);
        assert!(parsed.ddl_capabilities.drop_index);
        assert!(!parsed.ddl_capabilities.rename_column);
        assert!(!parsed.ddl_capabilities.alter_column_type);
    }

    #[test]
    fn yaml_validation_missing_name() {
        let yaml = r#"
dialect:
  name: ""
  versions: []
identifier_rules:
  quote_char: "\""
  max_length: 128
"#;
        let parsed: DialectYaml = serde_yaml::from_str(yaml).unwrap();
        let errors = parsed.validate();
        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| e.field == "dialect.name"));
    }

    #[test]
    fn yaml_validation_missing_quote_char() {
        let yaml = r#"
dialect:
  name: "MySQL"
  versions: []
identifier_rules:
  quote_char: ""
  max_length: 64
"#;
        let parsed: DialectYaml = serde_yaml::from_str(yaml).unwrap();
        let errors = parsed.validate();
        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| e.field == "identifier_rules.quote_char"));
    }

    #[test]
    fn yaml_validation_zero_max_length() {
        let yaml = r#"
dialect:
  name: "MySQL"
  versions: []
identifier_rules:
  quote_char: "`"
  max_length: 0
"#;
        let parsed: DialectYaml = serde_yaml::from_str(yaml).unwrap();
        let errors = parsed.validate();
        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| e.field == "identifier_rules.max_length"));
    }

    #[test]
    fn from_descriptor_mysql_roundtrip() {
        let yaml = DialectYaml::from_descriptor(DialectKind::Mysql);
        assert_eq!(yaml.dialect.name, "MySQL");
        assert!(yaml.ddl_capabilities.add_column);
        assert!(yaml.ddl_capabilities.auto_increment);
        assert!(!yaml.ddl_capabilities.transactional_ddl);
        assert_eq!(yaml.identifier_rules.quote_char, "`");
        assert_eq!(yaml.identifier_rules.max_length, 64);
    }

    #[test]
    fn from_descriptor_postgres_roundtrip() {
        let yaml = DialectYaml::from_descriptor(DialectKind::Postgres);
        assert_eq!(yaml.dialect.name, "PostgreSQL");
        assert!(yaml.ddl_capabilities.add_column);
        assert!(yaml.ddl_capabilities.drop_column);
        assert!(yaml.ddl_capabilities.create_table);
        assert!(yaml.ddl_capabilities.drop_table);
        assert!(yaml.ddl_capabilities.transactional_ddl);
        assert!(yaml.ddl_capabilities.identity_columns);
        assert_eq!(yaml.identifier_rules.quote_char, "\"");
        assert_eq!(yaml.identifier_rules.max_length, 63);
    }

    #[test]
    fn from_descriptor_to_yaml_and_back() {
        for kind in &[
            DialectKind::Mysql,
            DialectKind::Postgres,
            DialectKind::Sqlite,
            DialectKind::DuckDb,
            DialectKind::SqlServer,
            DialectKind::Oracle,
            DialectKind::H2,
            DialectKind::ClickHouse,
        ] {
            let yaml = DialectYaml::from_descriptor(*kind);
            let yaml_str = yaml.to_yaml_string().unwrap();
            let parsed: DialectYaml = serde_yaml::from_str(&yaml_str).unwrap();
            let desc = parsed.to_descriptor(*kind);
            let expected = DialectCapabilityDescriptor::for_dialect(*kind);
            assert_eq!(desc.dialect, *kind);
            assert_eq!(desc.flags, expected.flags, "capabilities changed for {kind:?}");
        }
    }

    #[test]
    fn from_descriptor_all_core_dialects() {
        let kinds = &[
            DialectKind::Mysql,
            DialectKind::Postgres,
            DialectKind::Sqlite,
            DialectKind::DuckDb,
            DialectKind::SqlServer,
            DialectKind::Oracle,
            DialectKind::H2,
            DialectKind::ClickHouse,
            DialectKind::ManticoreSearch,
            DialectKind::Informix,
            DialectKind::Questdb,
        ];
        for kind in kinds {
            let yaml = DialectYaml::from_descriptor(*kind);
            assert!(!yaml.dialect.name.is_empty());
            assert!(!yaml.identifier_rules.quote_char.is_empty());
            assert!(yaml.identifier_rules.max_length > 0);
        }
    }
}
