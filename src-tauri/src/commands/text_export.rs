use dbx_core::text_export::{format_json, format_markdown, QueryResultTextExportData};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultTextExportRequest {
    pub file_path: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

impl QueryResultTextExportRequest {
    fn data(&self) -> QueryResultTextExportData {
        QueryResultTextExportData { columns: self.columns.clone(), rows: self.rows.clone() }
    }
}

#[tauri::command]
pub fn export_query_result_json(request: QueryResultTextExportRequest) -> Result<(), String> {
    let content = format_json(&request.data())?;
    std::fs::write(&request.file_path, format!("\u{FEFF}{content}")).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn export_query_result_markdown(request: QueryResultTextExportRequest) -> Result<(), String> {
    let content = format_markdown(&request.data());
    std::fs::write(&request.file_path, format!("\u{FEFF}{content}")).map_err(|err| err.to_string())
}
