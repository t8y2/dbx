use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    #[serde(default)]
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
    pub sql: String,
    pub executed_at: String,
    pub execution_time_ms: u128,
    pub success: bool,
    pub error: Option<String>,
    #[serde(default = "default_activity_kind")]
    pub activity_kind: String,
    #[serde(default)]
    pub operation: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub affected_rows: Option<i64>,
    #[serde(default)]
    pub rollback_sql: Option<String>,
    #[serde(default)]
    pub details_json: Option<String>,
}

/// Matches current entries by connection ID and legacy entries by connection name.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryConnectionFilter {
    #[serde(default)]
    pub connection_id: String,
    #[serde(default)]
    pub connection_name: String,
}

/// Includes connection identity so same-named databases do not match across connections.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryDatabaseFilter {
    #[serde(default)]
    pub connection_id: String,
    #[serde(default)]
    pub connection_name: String,
    #[serde(default)]
    pub database: String,
}

/// Mirrors the descending (executed_at, id) order to paginate equal timestamps safely.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryCursor {
    pub executed_at: String,
    pub id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HistorySearchRequest {
    #[serde(default)]
    pub search_text: String,
    #[serde(default)]
    pub connections: Vec<HistoryConnectionFilter>,
    #[serde(default)]
    pub databases: Vec<HistoryDatabaseFilter>,
    pub activity_kind: Option<String>,
    pub success: Option<bool>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub cursor: Option<HistoryCursor>,
    #[serde(default)]
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistorySearchResult {
    pub entries: Vec<HistoryEntry>,
    pub next_cursor: Option<HistoryCursor>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryConnectionOption {
    pub connection_id: String,
    pub connection_name: String,
    pub databases: Vec<String>,
}

pub const MAX_HISTORY: usize = 1000;

fn default_activity_kind() -> String {
    "query".to_string()
}

pub fn read_all(path: &Path) -> Result<Vec<HistoryEntry>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

pub fn write_all(path: &Path, entries: &[HistoryEntry]) -> Result<(), String> {
    let json = serde_json::to_string(entries).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn save_history_entry(path: &Path, entry: HistoryEntry) -> Result<(), String> {
    let mut entries = read_all(path)?;
    entries.insert(0, entry);
    entries.truncate(MAX_HISTORY);
    write_all(path, &entries)
}

pub fn load_history_entries(path: &Path, limit: usize, offset: usize) -> Result<Vec<HistoryEntry>, String> {
    let entries = read_all(path)?;
    Ok(entries.into_iter().skip(offset).take(limit).collect())
}

pub fn clear_history_entries(path: &Path) -> Result<(), String> {
    write_all(path, &[])
}

pub fn delete_history_entry_by_id(path: &Path, id: &str) -> Result<(), String> {
    let entries: Vec<HistoryEntry> = read_all(path)?.into_iter().filter(|e| e.id != id).collect();
    write_all(path, &entries)
}
