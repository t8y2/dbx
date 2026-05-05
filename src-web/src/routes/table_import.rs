use std::sync::Arc;

use axum::extract::{Multipart, Path, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use dbx_core::table_import::{
    self, TableImportRequest,
};
use dbx_core::transfer;
use futures::stream::Stream;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteImportWrapper {
    pub request: TableImportRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelImportRequest {
    pub import_id: String,
}

pub async fn preview_import(
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
            .unwrap_or("upload.csv")
            .to_string();
        let data = field.bytes().await.map_err(|e| AppError(e.to_string()))?;

        let file_path = tmp_dir.join(&file_name);
        std::fs::write(&file_path, &data).map_err(|e| AppError(e.to_string()))?;

        let file_path_str = file_path.to_string_lossy().to_string();
        let preview = table_import::preview_table_import_file_core(&file_path_str)
            .map_err(AppError)?;

        return Ok(Json(
            serde_json::to_value(preview).map_err(|e| AppError(e.to_string()))?,
        ));
    }

    Err(AppError("No file uploaded".to_string()))
}

pub async fn execute_import(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ExecuteImportWrapper>,
) -> Result<Json<serde_json::Value>, AppError> {
    let req = body.request;
    let import_id = req.import_id.clone();

    let (tx, _) = tokio::sync::broadcast::channel::<String>(256);
    state
        .sse_channels
        .write()
        .await
        .insert(import_id.clone(), tx.clone());

    let app = state.app.clone();
    let state_clone = state.clone();

    tokio::spawn(async move {
        let db_type = match transfer::get_db_type(&app, &req.connection_id).await {
            Ok(t) => t,
            Err(e) => {
                let _ = tx.send(
                    serde_json::json!({
                        "importId": req.import_id,
                        "status": "error",
                        "error": e
                    })
                    .to_string(),
                );
                return;
            }
        };

        let pool_key = match app
            .get_or_create_pool(&req.connection_id, Some(&req.database))
            .await
        {
            Ok(k) => k,
            Err(e) => {
                let _ = tx.send(
                    serde_json::json!({
                        "importId": req.import_id,
                        "status": "error",
                        "error": e
                    })
                    .to_string(),
                );
                return;
            }
        };

        let tx_clone = tx.clone();
        let import_id_for_cancel = req.import_id.clone();
        let result = table_import::import_table_file_core(
            &app,
            &req,
            &db_type,
            &pool_key,
            |id: &str| {
                let id = id.to_string();
                Box::pin(async move {
                    transfer::is_cancelled(&id).await
                })
            },
            |progress| {
                if let Ok(json) = serde_json::to_string(&progress) {
                    let _ = tx_clone.send(json);
                }
            },
        )
        .await;

        match result {
            Ok(summary) => {
                if let Ok(json) = serde_json::to_string(&summary) {
                    let _ = tx.send(json);
                }
            }
            Err(e) => {
                let _ = tx.send(
                    serde_json::json!({
                        "importId": import_id_for_cancel,
                        "status": "error",
                        "error": e
                    })
                    .to_string(),
                );
            }
        }

        state_clone.sse_channels.write().await.remove(&req.import_id);
    });

    Ok(Json(serde_json::json!({ "importId": import_id })))
}

pub async fn import_progress(
    State(state): State<Arc<WebState>>,
    Path(import_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let channels = state.sse_channels.read().await;
    let tx = channels
        .get(&import_id)
        .ok_or_else(|| AppError("Import not found".to_string()))?;
    let rx = tx.subscribe();
    drop(channels);
    Ok(crate::sse::sse_from_channel(rx))
}

pub async fn cancel_import(
    State(_state): State<Arc<WebState>>,
    Json(req): Json<CancelImportRequest>,
) -> Json<serde_json::Value> {
    transfer::set_cancelled(&req.import_id).await;
    Json(serde_json::json!({ "cancelled": true }))
}
