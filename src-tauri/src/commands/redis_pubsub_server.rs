use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::{net::Ipv4Addr, net::TcpListener};

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tauri::async_runtime::JoinHandle;
use tokio_util::sync::CancellationToken;

use dbx_core::connection::AppState;

const DEFAULT_PUBSUB_PORT: u16 = 4224;

pub struct PubSubServerState {
    port: Option<u16>,
    shutdown: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl PubSubServerState {
    fn unavailable() -> Self {
        Self { port: None, shutdown: CancellationToken::new(), task: Mutex::new(None) }
    }

    fn get(&self) -> Result<u16, String> {
        self.port.ok_or_else(|| "Redis PubSub server is unavailable".to_string())
    }

    pub async fn shutdown(&self, deadline: Duration) {
        self.shutdown.cancel();
        let task = self.task.lock().unwrap_or_else(|error| error.into_inner()).take();
        let Some(mut task) = task else { return };
        if tokio::time::timeout(deadline, &mut task).await.is_err() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for PubSubServerState {
    fn drop(&mut self) {
        self.shutdown.cancel();
        if let Some(task) = self.task.get_mut().unwrap_or_else(|error| error.into_inner()).take() {
            task.abort();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PubSubWsParams {
    connection_id: String,
}

pub fn build_pubsub_router(state: Arc<AppState>) -> Router {
    Router::new().route("/api/redis/pubsub/ws", get(ws_handler)).with_state(state)
}

fn pubsub_server_port() -> u16 {
    std::env::var("DBX_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PUBSUB_PORT)
}

#[tauri::command]
pub fn redis_pubsub_server_port(state: tauri::State<'_, PubSubServerState>) -> Result<u16, String> {
    state.get()
}

fn bind_pubsub_listener(preferred_port: u16) -> Result<TcpListener, String> {
    let preferred_addr = (Ipv4Addr::LOCALHOST, preferred_port);
    match TcpListener::bind(preferred_addr) {
        Ok(listener) => Ok(listener),
        Err(preferred_error) if preferred_port != 0 => {
            log::warn!(
                "Failed to bind PubSub server on {preferred_addr:?}: {preferred_error}; using an available port instead"
            );
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|fallback_error| {
                format!("Failed to bind PubSub server on an available port: {fallback_error}")
            })
        }
        Err(error) => Err(format!("Failed to bind PubSub server on {preferred_addr:?}: {error}")),
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<PubSubWsParams>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let connection_id = params.connection_id;
    ws.on_upgrade(move |socket| handle_socket(socket, state, connection_id))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, connection_id: String) {
    // Create PubSub connection
    let pubsub = match dbx_core::redis_ops::redis_create_pubsub_core(&state, &connection_id).await {
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
            if let Err(e) = handle_command(&mut sink, &text).await {
                log::warn!("PubSub command error: {e}");
            }
        }
    });

    // Forward Redis messages to WebSocket (uses ws_sender, no mutex contention)
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

async fn handle_command(sink: &mut redis::aio::PubSubSink, text: &str) -> Result<(), String> {
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

/// Start the embedded web server for PubSub WebSocket support.
/// Runs on a background task using the shared AppState.
pub fn start_pubsub_server(state: Arc<AppState>) -> PubSubServerState {
    let router = build_pubsub_router(state);
    let listener = match bind_pubsub_listener(pubsub_server_port()) {
        Ok(listener) => listener,
        Err(error) => {
            log::warn!("{error}");
            return PubSubServerState::unavailable();
        }
    };
    let addr = match listener.local_addr() {
        Ok(addr) => addr,
        Err(error) => {
            log::warn!("Failed to read PubSub server address: {error}");
            return PubSubServerState::unavailable();
        }
    };
    if let Err(error) = listener.set_nonblocking(true) {
        log::warn!("Failed to configure PubSub server listener: {error}");
        return PubSubServerState::unavailable();
    }

    start_pubsub_server_with_listener(listener, addr, router)
}

fn start_pubsub_server_with_listener(
    listener: TcpListener,
    addr: std::net::SocketAddr,
    router: Router,
) -> PubSubServerState {
    let shutdown = CancellationToken::new();
    let shutdown_signal = shutdown.clone();
    let task = tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                log::warn!("Failed to start PubSub server on {addr}: {error}");
                return;
            }
        };
        log::info!("PubSub WebSocket server listening on {addr}");
        if let Err(error) =
            axum::serve(listener, router).with_graceful_shutdown(shutdown_signal.cancelled_owned()).await
        {
            log::warn!("PubSub server stopped with error: {error}");
        }
    });

    PubSubServerState { port: Some(addr.port()), shutdown, task: Mutex::new(Some(task)) }
}

#[cfg(test)]
mod tests {
    use super::{bind_pubsub_listener, start_pubsub_server_with_listener};
    use axum::Router;
    use std::net::{Ipv4Addr, TcpListener};
    use std::time::Duration;

    #[test]
    fn falls_back_to_an_available_local_port_when_the_preferred_port_is_in_use() {
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let preferred_port = occupied.local_addr().unwrap().port();

        let listener = bind_pubsub_listener(preferred_port).unwrap();

        assert_eq!(listener.local_addr().unwrap().ip(), Ipv4Addr::LOCALHOST);
        assert_ne!(listener.local_addr().unwrap().port(), preferred_port);
    }

    #[tokio::test]
    async fn shutdown_releases_listener_before_process_exit() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let state = start_pubsub_server_with_listener(listener, addr, Router::new());

        state.shutdown(Duration::from_secs(1)).await;

        let rebound = TcpListener::bind(addr).unwrap();
        assert_eq!(rebound.local_addr().unwrap(), addr);
    }
}
