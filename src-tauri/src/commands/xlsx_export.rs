use dbx_core::xlsx_export::{build_xlsx_workbook, XlsxWorksheetData};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultXlsxExportRequest {
    pub file_path: String,
    pub sheet_name: Option<String>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

#[tauri::command]
pub async fn export_query_result_xlsx(request: QueryResultXlsxExportRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: request.sheet_name,
            columns: request.columns,
            rows: request.rows,
        })?;
        std::fs::write(&request.file_path, workbook).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}
