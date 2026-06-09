use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseInfo {
    pub name: String,
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
    pub comment: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub parent_schema: Option<String>,
    pub parent_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ObjectSourceKind {
    View,
    Procedure,
    Function,
    Sequence,
    Package,
    PackageBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectSource {
    pub name: String,
    pub object_type: ObjectSourceKind,
    pub schema: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerInfo {
    pub name: String,
    pub event: String,
    pub timing: String,
}
