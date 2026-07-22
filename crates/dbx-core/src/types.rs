use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseInfo {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseStorageInfo {
    pub name: String,
    pub size_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaInfo {
    pub name: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkedServerInfo {
    pub name: String,
    pub product: Option<String>,
    pub provider: Option<String>,
    pub data_source: Option<String>,
}

/// A catalog exposed by a multi-catalog engine (e.g. Doris / StarRocks).
/// `internal` is the engine's native catalog; other entries are external
/// catalogs (iceberg, hive, jdbc, ...) federated through the same connection.
///
/// Note: the built-in catalog is named `internal` in Doris (Type=`internal`)
/// but `default_catalog` in StarRocks (Type=`Internal`). The `catalog_type`
/// column is the cross-engine signal, so `is_internal()` matches it
/// case-insensitively and falls back to the canonical Doris name when the
/// column is absent (very old / proxied deployments).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogInfo {
    pub name: String,
    pub catalog_type: String,
    pub is_current: bool,
    pub comment: Option<String>,
}

impl CatalogInfo {
    /// Whether this is the engine's built-in (non-federated) catalog.
    pub fn is_internal(&self) -> bool {
        if !self.catalog_type.trim().is_empty() {
            self.catalog_type.eq_ignore_ascii_case("internal")
        } else {
            self.name == "internal"
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub table_type: String, // "TABLE" or "VIEW"
    pub comment: Option<String>,
    pub parent_schema: Option<String>,
    pub parent_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectInfo {
    pub name: String,
    pub object_type: String,
    pub schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    pub comment: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub parent_schema: Option<String>,
    pub parent_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionInfo {
    pub name: String,
    pub version: String,
    pub comment: Option<String>,
    pub schema: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectStatistics {
    pub name: String,
    pub schema: Option<String>,
    pub estimated_rows: Option<i64>,
    pub total_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ObjectSourceKind {
    View,
    MaterializedView,
    Procedure,
    Function,
    Trigger,
    Sequence,
    Package,
    PackageBody,
    Type,
    TypeBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectSource {
    pub name: String,
    pub object_type: ObjectSourceKind,
    pub schema: Option<String>,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub column_default: Option<String>,
    pub is_primary_key: bool,
    pub extra: Option<String>,
    pub comment: Option<String>,
    pub numeric_precision: Option<i32>,
    pub numeric_scale: Option<i32>,
    pub character_maximum_length: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_set: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionAssistantObjectKind {
    Database,
    Schema,
    Table,
    View,
    Routine,
    Procedure,
    Function,
    Column,
}

impl CompletionAssistantObjectKind {
    pub fn is_table_like(&self) -> bool {
        matches!(self, Self::Table | Self::View)
    }

    pub fn is_routine_like(&self) -> bool {
        matches!(self, Self::Routine | Self::Procedure | Self::Function)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionAssistantCandidateKind {
    Database,
    Schema,
    Table,
    View,
    Procedure,
    Function,
    Column,
    Object,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionAssistantMatchMode {
    Prefix,
    Contains,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionAssistantRequest {
    pub connection_id: String,
    pub database: String,
    pub schema: Option<String>,
    #[serde(default)]
    pub object_kinds: Vec<CompletionAssistantObjectKind>,
    #[serde(default)]
    pub mask: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub global_search: bool,
    pub max_results: Option<usize>,
    #[serde(default)]
    pub search_in_comments: bool,
    #[serde(default)]
    pub search_in_definitions: bool,
    pub parent_schema: Option<String>,
    pub parent_name: Option<String>,
    pub match_mode: Option<CompletionAssistantMatchMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionAssistantCandidate {
    pub name: String,
    pub kind: CompletionAssistantCandidateKind,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub parent_schema: Option<String>,
    pub parent_name: Option<String>,
    pub comment: Option<String>,
    pub data_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionAssistantResponse {
    pub candidates: Vec<CompletionAssistantCandidate>,
    pub incomplete: bool,
    pub fallback_used: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    /// Database type name for each column, parallel to `columns`. May be empty
    /// when a driver cannot supply types (e.g. schemaless stores or fallback
    /// query paths); consumers must tolerate a shorter/empty vector.
    #[serde(default)]
    pub column_types: Vec<String>,
    /// Sortable for each column. Parallel to `columns`. Optional and may
    /// be shorter/empty when a driver cannot supply sortable information.
    #[serde(default)]
    pub column_sortables: Vec<bool>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
    pub execution_time_ms: u128,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub is_primary: bool,
    pub filter: Option<String>,
    pub index_type: Option<String>,
    pub included_columns: Option<Vec<String>>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKeyInfo {
    pub name: String,
    pub column: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_column: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_update: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_delete: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerInfo {
    pub name: String,
    pub event: String,
    pub timing: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statement: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInfo {
    pub name: String,
    pub function_type: String,
    pub data_type: String,
    pub definition: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceInfo {
    pub name: String,
    pub data_type: String,
    pub start_value: String,
    pub min_value: String,
    pub max_value: String,
    pub increment: String,
    pub cycle: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleInfo {
    pub name: String,
    pub table_name: String,
    pub definition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerInfo {
    pub object_name: String,
    pub object_type: String,
    pub owner: String,
}

#[cfg(test)]
mod tests {
    use super::ObjectInfo;

    #[test]
    fn list_objects_payload_preserves_optional_validity() {
        let objects: Vec<ObjectInfo> =
            serde_json::from_str(r#"[{"name":"TRG_AUDIT","object_type":"TRIGGER","schema":"APP","valid":false}]"#)
                .unwrap();

        assert_eq!(objects[0].valid, Some(false));
        assert_eq!(objects[0].object_type, "TRIGGER");
    }
}
