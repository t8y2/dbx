use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    pub connection_name: String,
    pub database: String,
    pub sql: String,
    pub executed_at: String,
    pub execution_time_ms: u128,
    pub success: bool,
    pub error: Option<String>,
}

pub const MAX_HISTORY: usize = 1000;

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
    let entries: Vec<HistoryEntry> = read_all(path)?
        .into_iter()
        .filter(|e| e.id != id)
        .collect();
    write_all(path, &entries)
}
