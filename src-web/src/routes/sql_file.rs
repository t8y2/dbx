use std::sync::Arc;

use axum::extract::{Multipart, Path, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use dbx_core::sql;
use dbx_core::query;
use futures::stream::Stream;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileExecuteRequest {
    pub execution_id: String,
    pub connection_id: String,
    pub database: String,
    pub file_path: String,
    pub continue_on_error: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileExecuteWrapper {
    pub request: SqlFileExecuteRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelSqlFileRequest {
    pub execution_id: String,
}

pub async fn preview_sql_file(
    State(state): State<Arc<WebState>>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let tmp_dir = state.data_dir.join("tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| AppError(e.to_string()))?;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError(e.to_string()))?
    {
        let file_name = field
            .file_name()
            .unwrap_or("upload.sql")
            .to_string();
        let data = field.bytes().await.map_err(|e| AppError(e.to_string()))?;

        let file_path = tmp_dir.join(&file_name);
        std::fs::write(&file_path, &data).map_err(|e| AppError(e.to_string()))?;

        let size_bytes = data.len() as u64;
        let content = String::from_utf8_lossy(&data);
        let preview: String = content.chars().take(5000).collect();

        return Ok(Json(serde_json::json!({
            "fileName": file_name,
            "filePath": file_path.to_string_lossy(),
            "sizeBytes": size_bytes,
            "preview": preview,
        })));
    }

    Err(AppError("No file uploaded".to_string()))
}

pub async fn execute_sql_file(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SqlFileExecuteWrapper>,
) -> Result<Json<serde_json::Value>, AppError> {
    let req = body.request;
    let execution_id = req.execution_id.clone();

    let (tx, _) = tokio::sync::broadcast::channel::<String>(256);
    state
        .sse_channels
        .write()
        .await
        .insert(execution_id.clone(), tx.clone());

    let app = state.app.clone();
    let state_clone = state.clone();

    tokio::spawn(async move {
        let file_content = match std::fs::read_to_string(&req.file_path) {
            Ok(c) => c,
            Err(e) => {
                let progress = dbx_core::sql::SqlFileProgress {
                    execution_id: req.execution_id.clone(),
                    status: dbx_core::sql::SqlFileStatus::Error,
                    statement_index: 0,
                    success_count: 0,
                    failure_count: 0,
                    affected_rows: 0,
                    elapsed_ms: 0,
                    statement_summary: String::new(),
                    error: Some(e.to_string()),
                };
                if let Ok(json) = serde_json::to_string(&progress) {
                    let _ = tx.send(json);
                }
                return;
            }
        };

        // Send started
        let started = dbx_core::sql::SqlFileProgress {
            execution_id: req.execution_id.clone(),
            status: dbx_core::sql::SqlFileStatus::Started,
            statement_index: 0,
            success_count: 0,
            failure_count: 0,
            affected_rows: 0,
            elapsed_ms: 0,
            statement_summary: String::new(),
            error: None,
        };
        if let Ok(json) = serde_json::to_string(&started) {
            let _ = tx.send(json);
        }

        let statements = sql::split_sql_statements(&file_content);
        let start = std::time::Instant::now();
        let mut success_count = 0usize;
        let mut failure_count = 0usize;
        let mut total_affected: u64 = 0;

        for (i, stmt) in statements.iter().enumerate() {
            let summary = sql::statement_summary(stmt);

            // Send running
            let running = dbx_core::sql::SqlFileProgress {
                execution_id: req.execution_id.clone(),
                status: dbx_core::sql::SqlFileStatus::Running,
                statement_index: i,
                success_count,
                failure_count,
                affected_rows: total_affected,
                elapsed_ms: start.elapsed().as_millis(),
                statement_summary: summary.clone(),
                error: None,
            };
            if let Ok(json) = serde_json::to_string(&running) {
                let _ = tx.send(json);
            }

            match query::execute_sql_statement(&app, &req.connection_id, &req.database, stmt, None)
                .await
            {
                Ok(result) => {
                    success_count += 1;
                    total_affected += result.affected_rows;
                    let done = dbx_core::sql::SqlFileProgress {
                        execution_id: req.execution_id.clone(),
                        status: dbx_core::sql::SqlFileStatus::StatementDone,
                        statement_index: i,
                        success_count,
                        failure_count,
                        affected_rows: total_affected,
                        elapsed_ms: start.elapsed().as_millis(),
                        statement_summary: summary,
                        error: None,
                    };
                    if let Ok(json) = serde_json::to_string(&done) {
                        let _ = tx.send(json);
                    }
                }
                Err(e) => {
                    failure_count += 1;
                    let failed = dbx_core::sql::SqlFileProgress {
                        execution_id: req.execution_id.clone(),
                        status: dbx_core::sql::SqlFileStatus::StatementFailed,
                        statement_index: i,
                        success_count,
                        failure_count,
                        affected_rows: total_affected,
                        elapsed_ms: start.elapsed().as_millis(),
                        statement_summary: summary,
                        error: Some(e),
                    };
                    if let Ok(json) = serde_json::to_string(&failed) {
                        let _ = tx.send(json);
                    }
                    if !req.continue_on_error {
                        break;
                    }
                }
            }
        }

        // Send final done
        let final_done = dbx_core::sql::SqlFileProgress {
            execution_id: req.execution_id.clone(),
            status: dbx_core::sql::SqlFileStatus::Done,
            statement_index: statements.len(),
            success_count,
            failure_count,
            affected_rows: total_affected,
            elapsed_ms: start.elapsed().as_millis(),
            statement_summary: String::new(),
            error: None,
        };
        if let Ok(json) = serde_json::to_string(&final_done) {
            let _ = tx.send(json);
        }

        state_clone.sse_channels.write().await.remove(&req.execution_id);
    });

    Ok(Json(serde_json::json!({ "executionId": execution_id })))
}

pub async fn sql_file_progress(
    State(state): State<Arc<WebState>>,
    Path(execution_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let channels = state.sse_channels.read().await;
    let tx = channels
        .get(&execution_id)
        .ok_or_else(|| AppError("Execution not found".to_string()))?;
    let rx = tx.subscribe();
    drop(channels);
    Ok(crate::sse::sse_from_channel(rx))
}

pub async fn cancel_sql_file(
    State(state): State<Arc<WebState>>,
    Json(req): Json<CancelSqlFileRequest>,
) -> Json<serde_json::Value> {
    // Remove the channel to stop the execution loop
    state.sse_channels.write().await.remove(&req.execution_id);
    Json(serde_json::json!({ "cancelled": true }))
}
