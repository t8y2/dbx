use axum::{extract::Query, Json};
use dbx_core::text_export::{
    format_html, format_json, format_markdown, format_transposed_markdown, QueryResultTextExportData,
};
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

#[derive(Debug, Deserialize)]
pub struct MarkdownExportQuery {
    field: Option<String>,
    data: Option<String>,
}

pub async fn export_query_result_markdown(
    Query(labels): Query<MarkdownExportQuery>,
    Json(req): Json<QueryResultTextExportRequest>,
) -> Result<Json<QueryResultTextExportResponse>, AppError> {
    let data = req.data();
    let content = match (labels.field, labels.data) {
        (None, None) => format_markdown(&data),
        (Some(field), Some(label)) => {
            // Only the short localized record label is repeated for every row.
            if label.len() > 64 {
                return Err(AppError::bad_request("Markdown record label is too long"));
            }
            // A missing cell renders as " | NULL". Bound the space synthesized
            // for ragged input without restricting valid rectangular exports.
            let missing = data
                .rows
                .iter()
                .fold(0usize, |sum, row| sum.saturating_add(data.columns.len().saturating_sub(row.len())));
            if missing > crate::web_body_limit_bytes() / 7 {
                return Err(AppError::bad_request("Too many missing Markdown cells"));
            }
            format_transposed_markdown(&data, &field, &label)
        }
        _ => return Err(AppError::bad_request("Both Markdown labels are required")),
    };
    Ok(Json(QueryResultTextExportResponse { content }))
}

pub async fn export_query_result_html(
    Json(req): Json<QueryResultTextExportRequest>,
) -> Json<QueryResultTextExportResponse> {
    Json(QueryResultTextExportResponse { content: format_html(&req.data()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::DefaultBodyLimit, http::StatusCode, routing::post, Router};
    use serde_json::{json, Value};

    #[tokio::test]
    async fn transposes_at_the_same_body_limit_as_an_ordinary_export() {
        let body = json!({"columns": ["id"], "rows": [[11], [22]]}).to_string();
        let router = Router::new()
            .route("/markdown", post(export_query_result_markdown))
            .layer(DefaultBodyLimit::max(body.len()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/markdown", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        let request = || client.post(&url).header("content-type", "application/json").body(body.clone());
        let normal = request().send().await.unwrap().error_for_status().unwrap().json::<Value>().await.unwrap();
        assert!(normal["content"].as_str().unwrap().starts_with("| id  |"));
        let transposed = request()
            .query(&[("field", "字段"), ("data", "数据")])
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(transposed["content"], "| 字段 | 数据 1 | 数据 2 |\n| --- | --- | --- |\n| id | 11 | 22 |\n");
        assert_eq!(request().body(format!("{body} ")).send().await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(request().query(&[("data", "Data")]).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            request().query(&[("field", "Field"), ("data", &"x".repeat(65))]).send().await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        server.abort();
    }
}
