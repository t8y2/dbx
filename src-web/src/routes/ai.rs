use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::stream::Stream;
use serde::Deserialize;

use dbx_core::ai::{
    AiCompletionRequest, AiConfig, AiConversation, AiStreamChunk,
};

use crate::error::AppError;
use crate::state::WebState;

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiConfigRequest {
    pub config: AiConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiConversationRequest {
    pub conversation: AiConversation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCompleteRequest {
    pub request: AiCompletionRequest,
}

#[derive(Deserialize)]
pub struct AiStreamRequest {
    #[serde(alias = "sessionId")]
    pub session_id: String,
    pub request: AiCompletionRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestConnectionRequest {
    pub config: AiConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCancelStreamRequest {
    pub session_id: String,
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

pub async fn save_ai_config(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveAiConfigRequest>,
) -> Result<Json<()>, AppError> {
    state
        .app
        .storage
        .save_ai_config(&body.config)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn load_ai_config(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Option<AiConfig>>, AppError> {
    let config = state
        .app
        .storage
        .load_ai_config()
        .await
        .map_err(AppError)?;
    Ok(Json(config))
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

pub async fn save_ai_conversation(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveAiConversationRequest>,
) -> Result<Json<()>, AppError> {
    state
        .app
        .storage
        .save_ai_conversation(&body.conversation)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn load_ai_conversations(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<AiConversation>>, AppError> {
    let conversations = state
        .app
        .storage
        .load_ai_conversations()
        .await
        .map_err(AppError)?;
    Ok(Json(conversations))
}

pub async fn delete_ai_conversation(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<()>, AppError> {
    state
        .app
        .storage
        .delete_ai_conversation(&id)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

// ---------------------------------------------------------------------------
// AI complete (non-streaming)
// ---------------------------------------------------------------------------

pub async fn ai_complete(
    Json(body): Json<AiCompleteRequest>,
) -> Result<Json<String>, AppError> {
    let result = dbx_core::ai::complete(&body.request)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// AI test connection
// ---------------------------------------------------------------------------

pub async fn ai_test_connection(
    Json(body): Json<AiTestConnectionRequest>,
) -> Result<Json<String>, AppError> {
    let result = dbx_core::ai::test_connection_core(&body.config)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// AI cancel stream
// ---------------------------------------------------------------------------

pub async fn ai_cancel_stream(
    Json(body): Json<AiCancelStreamRequest>,
) -> Result<Json<bool>, AppError> {
    let result = dbx_core::ai::cancel_stream(&body.session_id).await;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// AI stream (POST returns SSE directly)
// ---------------------------------------------------------------------------

pub async fn ai_stream(
    Json(body): Json<AiStreamRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let session_id = body.session_id;
    let request = body.request;

    let cancelled = dbx_core::ai::register_stream(&session_id).await;
    let (tx, rx) = tokio::sync::broadcast::channel::<String>(256);

    let sid = session_id.clone();
    tokio::spawn(async move {
        let result = dbx_core::ai::stream(&sid, &request, &cancelled, |chunk: AiStreamChunk| {
            let json = serde_json::to_string(&chunk).unwrap_or_default();
            let _ = tx.send(json);
        })
        .await;

        if let Err(_e) = result {
            let error_chunk = AiStreamChunk {
                session_id: sid.clone(),
                delta: String::new(),
                reasoning_delta: None,
                done: true,
            };
            let _ = tx.send(serde_json::to_string(&error_chunk).unwrap_or_default());
        }

        dbx_core::ai::unregister_stream(&sid).await;
    });

    let stream = async_stream::stream! {
        let mut rx = rx;
        while let Ok(data) = rx.recv().await {
            yield Ok(Event::default().data(data));
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}
