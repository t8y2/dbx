use axum::Json;
use dbx_core::text_export::{format_html, format_json, format_markdown, QueryResultTextExportData};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultTextExportRequest {
    #[serde(default)]
    pub title: Option<String>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

impl QueryResultTextExportRequest {
    fn data(self) -> QueryResultTextExportData {
        QueryResultTextExportData { title: self.title, columns: self.columns, rows: self.rows }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultTextExportResponse {
    pub content: String,
}

pub async fn export_query_result_json(
    Json(req): Json<QueryResultTextExportRequest>,
) -> Result<Json<QueryResultTextExportResponse>, AppError> {
    let content = format_json(&req.data()).map_err(AppError::from)?;
    Ok(Json(QueryResultTextExportResponse { content }))
}

pub async fn export_query_result_markdown(
    Json(req): Json<QueryResultTextExportRequest>,
) -> Json<QueryResultTextExportResponse> {
    Json(QueryResultTextExportResponse { content: format_markdown(&req.data()) })
}

pub async fn export_query_result_html(
    Json(req): Json<QueryResultTextExportRequest>,
) -> Json<QueryResultTextExportResponse> {
    Json(QueryResultTextExportResponse { content: format_html(&req.data()) })
}
