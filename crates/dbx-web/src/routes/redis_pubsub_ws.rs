use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::State;
use axum::extract::{Query, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;

use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PubSubWsParams {
    pub connection_id: String,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<PubSubWsParams>,
    State(state): State<Arc<WebState>>,
) -> impl IntoResponse {
    let connection_id = params.connection_id;
    ws.on_upgrade(move |socket| handle_pubsub_socket(socket, state, connection_id))
}

async fn handle_pubsub_socket(socket: WebSocket, state: Arc<WebState>, connection_id: String) {
    // Create PubSub connection
    let pubsub = match dbx_core::redis_ops::redis_create_pubsub_core(&state.app, &connection_id).await {
        Ok(p) => p,
        Err(e) => {
            let (mut sender, _) = socket.split();
            let _ = sender.send(Message::Text(format!(r#"{{"error":"{e}"}}"#).into())).await;
            return;
        }
    };

    let (mut sink, mut stream) = pubsub.split();
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Channel for WebSocket commands -> PubSub sink
    let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Task: Read WebSocket commands
    let ws_read = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if cmd_tx.send(text.to_string()).is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Task: Apply commands to PubSub sink
    let sink_handle = tokio::spawn(async move {
        while let Some(text) = cmd_rx.recv().await {
            if let Err(e) = handle_pubsub_command(&mut sink, &text).await {
                log::warn!("PubSub command error: {e}");
            }
        }
    });

    // Forward Redis messages to WebSocket (uses ws_sender, no mutex)
    while let Some(msg) = stream.next().await {
        let payload: String = msg.get_payload().unwrap_or_default();
        let channel = msg.get_channel_name().to_string();
        let pattern: Option<String> = msg.get_pattern().ok();
        let json = serde_json::json!({
            "channel": channel,
            "pattern": pattern,
            "payload": payload,
        });
        let text = serde_json::to_string(&json).unwrap_or_default();
        if ws_sender.send(Message::Text(text.into())).await.is_err() {
            break;
        }
    }

    ws_read.abort();
    sink_handle.abort();
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum PubSubCommand {
    #[serde(rename = "subscribe")]
    Subscribe { channels: Vec<String> },
    #[serde(rename = "psubscribe")]
    Psubscribe { patterns: Vec<String> },
    #[serde(rename = "unsubscribe")]
    Unsubscribe { channels: Vec<String> },
    #[serde(rename = "punsubscribe")]
    Punsubscribe { patterns: Vec<String> },
}

async fn handle_pubsub_command(sink: &mut redis::aio::PubSubSink, text: &str) -> Result<(), String> {
    let cmd: PubSubCommand = serde_json::from_str(text).map_err(|e| format!("Invalid PubSub command: {e}"))?;

    match cmd {
        PubSubCommand::Subscribe { channels } => {
            for ch in &channels {
                sink.subscribe(ch).await.map_err(|e| format!("Subscribe error: {e}"))?;
            }
        }
        PubSubCommand::Psubscribe { patterns } => {
            for pat in &patterns {
                sink.psubscribe(pat).await.map_err(|e| format!("PSubscribe error: {e}"))?;
            }
        }
        PubSubCommand::Unsubscribe { channels } => {
            for ch in &channels {
                sink.unsubscribe(ch).await.map_err(|e| format!("Unsubscribe error: {e}"))?;
            }
        }
        PubSubCommand::Punsubscribe { patterns } => {
            for pat in &patterns {
                sink.punsubscribe(pat).await.map_err(|e| format!("PUnsubscribe error: {e}"))?;
            }
        }
    }
    Ok(())
}
