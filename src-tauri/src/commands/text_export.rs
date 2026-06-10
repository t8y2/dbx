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
    fn into_data(self) -> QueryResultTextExportData {
        QueryResultTextExportData { columns: self.columns, rows: self.rows }
    }
}

#[tauri::command]
pub async fn export_query_result_json(request: QueryResultTextExportRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file_path = request.file_path.clone();
        let content = format_json(&request.into_data())?;
        std::fs::write(file_path, format!("\u{FEFF}{content}")).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn export_query_result_markdown(request: QueryResultTextExportRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file_path = request.file_path.clone();
        let content = format_markdown(&request.into_data());
        std::fs::write(file_path, format!("\u{FEFF}{content}")).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}
