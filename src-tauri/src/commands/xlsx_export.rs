use dbx_core::xlsx_export::{
    build_xlsx_workbook_multi_with_auto_filter, build_xlsx_workbook_with_auto_filter, XlsxWorksheetData,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultXlsxExportRequest {
    pub file_path: String,
    pub sheet_name: Option<String>,
    pub columns: Vec<String>,
    #[serde(default)]
    pub column_types: Vec<String>,
    #[serde(default)]
    pub column_comments: Vec<Option<String>>,
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub numeric_column_right_align: bool,
    #[serde(default)]
    pub auto_filter: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultsXlsxExportRequest {
    pub file_path: String,
    pub worksheets: Vec<XlsxWorksheetData>,
    #[serde(default)]
    pub auto_filter: Option<bool>,
}

#[tauri::command]
pub async fn export_query_result_xlsx(request: QueryResultXlsxExportRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut data = XlsxWorksheetData {
            sheet_name: request.sheet_name,
            columns: request.columns,
            column_types: request.column_types,
            column_comments: request.column_comments,
            rows: request.rows,
            numeric_column_right_align: request.numeric_column_right_align,
        };
        // Ensure consistency: if the feature is disabled, clear the flag.
        if !data.numeric_column_right_align {
            data.numeric_column_right_align = false;
        }
        let workbook = build_xlsx_workbook_with_auto_filter(&data, request.auto_filter.unwrap_or(true))?;
        std::fs::write(&request.file_path, workbook).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn export_query_results_xlsx(request: QueryResultsXlsxExportRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workbook =
            build_xlsx_workbook_multi_with_auto_filter(&request.worksheets, request.auto_filter.unwrap_or(true))?;
        std::fs::write(&request.file_path, workbook).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}
