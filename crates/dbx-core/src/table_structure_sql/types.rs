use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableStructureColumn {
    pub id: String,
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    #[serde(default)]
    pub default_value: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub is_primary_key: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<ColumnExtra>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<ColumnInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_position: Option<usize>,
    #[serde(default)]
    pub marked_for_drop: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnExtra {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_increment: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_update_current_timestamp: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<ColumnIdentity>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub increment: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub column_default: Option<String>,
    #[serde(default)]
    pub is_primary_key: bool,
    #[serde(default)]
    pub extra: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableStructureIndex {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub is_unique: bool,
    #[serde(default)]
    pub is_primary: bool,
    #[serde(default)]
    pub filter: String,
    #[serde(default)]
    pub index_type: String,
    #[serde(default)]
    pub included_columns: Vec<String>,
    #[serde(default)]
    pub comment: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<IndexInfo>,
    #[serde(default)]
    pub marked_for_drop: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub is_unique: bool,
    #[serde(default)]
    pub is_primary: bool,
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub index_type: Option<String>,
    #[serde(default)]
    pub included_columns: Option<Vec<String>>,
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableStructureForeignKey {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub column: String,
    #[serde(default)]
    pub ref_schema: String,
    #[serde(default)]
    pub ref_table: String,
    #[serde(default)]
    pub ref_column: String,
    #[serde(default)]
    pub on_update: String,
    #[serde(default)]
    pub on_delete: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<ForeignKeyInfo>,
    #[serde(default)]
    pub marked_for_drop: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForeignKeyInfo {
    pub name: String,
    pub column: String,
    #[serde(default)]
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_column: String,
    #[serde(default)]
    pub on_update: Option<String>,
    #[serde(default)]
    pub on_delete: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableStructureTrigger {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub timing: String,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub statement: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<TriggerInfo>,
    #[serde(default)]
    pub marked_for_drop: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TriggerInfo {
    pub name: String,
    pub event: String,
    pub timing: String,
    #[serde(default)]
    pub statement: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructureSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default)]
    pub columns: Vec<EditableStructureColumn>,
    #[serde(default)]
    pub indexes: Vec<EditableStructureIndex>,
    #[serde(default)]
    pub foreign_keys: Vec<EditableStructureForeignKey>,
    #[serde(default)]
    pub triggers: Vec<EditableStructureTrigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_table_comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructureSqlResult {
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SingleColumnAlterSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    pub column: EditableStructureColumn,
}
