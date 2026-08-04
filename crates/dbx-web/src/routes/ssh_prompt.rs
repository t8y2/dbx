use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use dbx_core::db::ssh_prompt::{SshPromptAnswer, SshPromptRequest};
use futures::Stream;
use serde::Deserialize;
use std::convert::Infallible;
use std::sync::Arc;

use crate::error::AppError;
use crate::ssh_prompt::SshPromptEvent;
use crate::state::WebState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveSshPromptRequest {
    pub id: String,
    pub action: String,
    pub remember: Option<bool>,
    pub secret: Option<String>,
}

pub async fn stream_ssh_prompts(
    State(state): State<Arc<WebState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let (replay, mut receiver) = state.ssh_prompts.subscribe();
    let stream = async_stream::stream! {
        for event in replay {
            yield Ok(ssh_prompt_event(event));
        }
        loop {
            match receiver.recv().await {
                Ok(event) => yield Ok(ssh_prompt_event(event)),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => break,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default())
}

pub async fn resolve_ssh_prompt(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ResolveSshPromptRequest>,
) -> Result<Json<()>, AppError> {
    let answer = match request.action.as_str() {
        "accept" => SshPromptAnswer::Accept { remember: request.remember.unwrap_or(false) },
        "reject" => SshPromptAnswer::Reject,
        "secret" => SshPromptAnswer::Secret(request.secret.unwrap_or_default()),
        other => return Err(AppError::bad_request(format!("Unknown SSH prompt action: {other}"))),
    };

    state.ssh_prompts.resolve(&request.id, answer).map_err(AppError::bad_request)?;
    Ok(Json(()))
}

/// Returns all currently-pending host-key prompts. The frontend polls this as a
/// fallback to the SSE stream so a prompt that fired before the EventSource was
/// open is still recovered (see the SSH host-key first-connect regression).
pub async fn list_pending_ssh_prompts(State(state): State<Arc<WebState>>) -> Json<Vec<SshPromptRequest>> {
    Json(state.ssh_prompts.pending_requests())
}

fn ssh_prompt_event(event: SshPromptEvent) -> Event {
    Event::default().data(serde_json::to_string(&event).expect("SSH prompt events must serialize"))
}
