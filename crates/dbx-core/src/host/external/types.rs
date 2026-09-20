use serde::{Deserialize, Serialize};

/// Reference to a specific table within an external source.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct ExternalTableRef {
    pub source_id: String,
    pub table_name: String,
    pub display_name: String,
}

/// Column definition for an external table snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalColumnDef {
    pub name: String,
    pub duckdb_type: String,
    pub is_nullable: bool,
    pub is_primary_key: bool,
    pub comment: Option<String>,
}

/// A full table snapshot loaded from an external source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalTableSnapshot {
    pub table_ref: ExternalTableRef,
    pub columns: Vec<ExternalColumnDef>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub source_version: String,
}

/// Capability flags for an external data source.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExternalCapabilities {
    pub can_read: bool,
    pub can_write: bool,
    pub can_append: bool,
    pub can_delete_rows: bool,
    pub supports_multiple_tables: bool,
    pub supports_refresh: bool,
    pub supports_file_watch: bool,
    pub supports_schema_detection: bool,
}

/// Cache state tracking for external source snapshots.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum CacheState {
    #[default]
    Empty,
    Fresh,
    Stale,
    Loading,
    Error(String),
}
