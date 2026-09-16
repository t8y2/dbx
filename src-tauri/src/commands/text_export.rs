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

fn write_query_result_json(request: QueryResultTextExportRequest) -> Result<(), String> {
    let file_path = request.file_path.clone();
    let content = format_json(&request.into_data())?;
    std::fs::write(file_path, content).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn export_query_result_json(request: QueryResultTextExportRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_query_result_json(request))
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

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{write_query_result_json, QueryResultTextExportRequest};

    #[test]
    fn writes_json_without_utf8_bom() {
        let path = std::env::temp_dir().join(format!("dbx-json-export-{}.json", uuid::Uuid::new_v4()));
        write_query_result_json(QueryResultTextExportRequest {
            file_path: path.to_string_lossy().into_owned(),
            columns: vec!["id".to_string(), "name".to_string()],
            rows: vec![vec![json!(1), json!("Ada")]],
        })
        .unwrap();

        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        assert!(!bytes.starts_with(b"\xEF\xBB\xBF"));
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), json!([{ "id": 1, "name": "Ada" }]));
    }
}
