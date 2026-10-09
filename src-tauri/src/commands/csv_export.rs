use std::sync::Arc;

use crate::commands::connection::AppState;
use dbx_core::csv_export::{
    csv_null_literal, default_csv_null_literal, export_table_data_csv_core, format_query_result_csv_with_options,
    CsvQuoteMode, TableCsvExportOptions,
};
use serde::Deserialize;
use serde_json::Value;
use tauri::State;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultCsvExportRequest {
    pub file_path: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub csv_quote_mode: CsvQuoteMode,
    /// CSV 里 NULL 写成什么。默认 `\N`；空字符串表示关闭该字面量，
    /// 退回「NULL 写成空字段」的旧行为（此时 NULL 与空字符串在文件里无法区分）。
    #[serde(default = "default_csv_null_literal")]
    pub null_literal: String,
}

#[tauri::command]
pub async fn export_query_result_csv(request: QueryResultCsvExportRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let csv = format_query_result_csv_with_options(
            &request.columns,
            &request.rows,
            request.csv_quote_mode,
            csv_null_literal(&request.null_literal),
        );
        std::fs::write(&request.file_path, format!("\u{FEFF}{csv}")).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn export_table_data_csv(
    state: State<'_, Arc<AppState>>,
    request: TableCsvExportOptions,
) -> Result<u64, String> {
    export_table_data_csv_core(&state, request).await
}
