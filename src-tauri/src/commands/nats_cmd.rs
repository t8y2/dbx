//! Desktop NATS commands backed by the shared dbx-core Agent facade.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::{ensure_connection_writable, AppState};
use dbx_core::nats::{
    NatsCaptureRequest, NatsCaptureResult, NatsConnectionConfig, NatsConsumerInfo, NatsConsumerList,
    NatsHistoryRequest, NatsHistoryResult, NatsJetStreamInfo, NatsPublishRequest, NatsPublishResult, NatsServerInfo,
    NatsService, NatsStreamInfo, NatsStreamList, NatsSubscriptionEvent, NatsSubscriptionInfo, NatsSubscriptionRequest,
};

/// Desktop-scoped NATS service. Short calls may create temporary Agents, but
/// live subscriptions must share one service so their event router outlives a
/// single Tauri command invocation.
pub struct NatsServiceState {
    service: tokio::sync::Mutex<Option<NatsService>>,
    event_forwarder_started: AtomicBool,
}

impl Default for NatsServiceState {
    fn default() -> Self {
        Self { service: tokio::sync::Mutex::new(None), event_forwarder_started: AtomicBool::new(false) }
    }
}

impl NatsServiceState {
    async fn service(&self, app: &Arc<AppState>) -> Result<NatsService, String> {
        let mut service = self.service.lock().await;
        if service.is_none() {
            *service = Some(NatsService::from_agent_manager(&app.agent_manager)?);
        }
        Ok(service.as_ref().expect("NATS service initialized").clone())
    }

    fn ensure_event_forwarder(&self, app: &AppHandle, service: &NatsService) {
        if self.event_forwarder_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut events = service.subscribe_subscription_events();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                };
                match event {
                    NatsSubscriptionEvent::Message(message) => {
                        let _ = app.emit("nats://message", message);
                    }
                    NatsSubscriptionEvent::State(state) => {
                        let _ = app.emit("nats://state", state);
                    }
                    NatsSubscriptionEvent::Error(error) => {
                        let _ = app.emit("nats://error", error);
                    }
                }
            }
        });
    }

    pub async fn close_connection(&self, connection_id: &str) {
        let service = self.service.lock().await.as_ref().cloned();
        if let Some(service) = service {
            service.close_connection(connection_id).await;
        }
    }
}

async fn config(
    state: &Arc<AppState>,
    connection_id: &str,
) -> Result<dbx_core::models::connection::ConnectionConfig, String> {
    state
        .configs
        .read()
        .await
        .get(connection_id)
        .cloned()
        .ok_or_else(|| format!("Connection with id '{connection_id}' not found"))
}

async fn service_config(
    state: &Arc<AppState>,
    connection_id: &str,
) -> Result<(dbx_core::models::connection::ConnectionConfig, NatsConnectionConfig), String> {
    let connection = config(state, connection_id).await?;
    let mut nats = NatsConnectionConfig::from_connection(&connection)?;
    let (configured_host, configured_port) = nats.configured_endpoint()?;
    let (connect_host, connect_port) = state.connection_host_port(connection_id, &connection).await?;
    if connect_host != configured_host || connect_port != configured_port {
        nats = nats.with_connect_override(&connect_host, connect_port)?;
    }
    Ok((connection, nats))
}

#[tauri::command]
pub async fn nats_test_connection(
    state: State<'_, Arc<AppState>>,
    nats_state: State<'_, NatsServiceState>,
    connection_id: String,
) -> Result<NatsServerInfo, String> {
    let (_, nats) = service_config(state.inner(), &connection_id).await?;
    nats_state.service(state.inner()).await?.test_connection(&nats).await
}

#[tauri::command]
pub async fn nats_capture(
    state: State<'_, Arc<AppState>>,
    nats_state: State<'_, NatsServiceState>,
    connection_id: String,
    request: NatsCaptureRequest,
) -> Result<NatsCaptureResult, String> {
    let (_, nats) = service_config(state.inner(), &connection_id).await?;
    let request = request.bounded()?;
    nats_state.service(state.inner()).await?.capture(&nats, request).await
}

#[tauri::command]
pub async fn nats_publish(
    state: State<'_, Arc<AppState>>,
    nats_state: State<'_, NatsServiceState>,
    connection_id: String,
    request: NatsPublishRequest,
) -> Result<NatsPublishResult, String> {
    let (connection, nats) = service_config(state.inner(), &connection_id).await?;
    if connection.read_only {
        return Err("NATS publish is blocked for a read-only connection".to_string());
    }
    ensure_connection_writable(state.inner(), &connection_id, "NATS publish").await?;
    let request = request.validate()?;
    nats_state.service(state.inner()).await?.publish(&nats, request).await
}

#[tauri::command]
pub async fn nats_jetstream_info(
    state: State<'_, Arc<AppState>>,
    nats_state: State<'_, NatsServiceState>,
    connection_id: String,
) -> Result<NatsJetStreamInfo, String> {
    let (_, nats) = service_config(state.inner(), &connection_id).await?;
    nats_state.service(state.inner()).await?.jetstream_info(&nats).await
}

#[tauri::command]
pub async fn nats_list_streams(
    state: State<'_, Arc<AppState>>,
    nats_state: State<'_, NatsServiceState>,
    connection_id: String,
) -> Result<NatsStreamList, String> {
    let (_, nats) = service_config(state.inner(), &connection_id).await?;
    nats_state.service(state.inner()).await?.list_streams(&nats).await
}

#[tauri::command]
pub async fn nats_get_stream(
    state: State<'_, Arc<AppState>>,
    nats_state: State<'_, NatsServiceState>,
    connection_id: String,
    stream: String,
) -> Result<NatsStreamInfo, String> {
    let (_, nats) = service_config(state.inner(), &connection_id).await?;
    nats_state.service(state.inner()).await?.get_stream(&nats, &stream).await
}

#[tauri::command]
pub async fn nats_list_consumers(
    state: State<'_, Arc<AppState>>,
    nats_state: State<'_, NatsServiceState>,
    connection_id: String,
    stream: String,
) -> Result<NatsConsumerList, String> {
    let (_, nats) = service_config(state.inner(), &connection_id).await?;
    nats_state.service(state.inner()).await?.list_consumers(&nats, &stream).await
}

#[tauri::command]
pub async fn nats_get_consumer(
    state: State<'_, Arc<AppState>>,
    nats_state: State<'_, NatsServiceState>,
    connection_id: String,
    stream: String,
    consumer: String,
) -> Result<NatsConsumerInfo, String> {
    let (_, nats) = service_config(state.inner(), &connection_id).await?;
    nats_state.service(state.inner()).await?.get_consumer(&nats, &stream, &consumer).await
}

#[tauri::command]
pub async fn nats_fetch_history(
    state: State<'_, Arc<AppState>>,
    nats_state: State<'_, NatsServiceState>,
    connection_id: String,
    request: NatsHistoryRequest,
) -> Result<NatsHistoryResult, String> {
    let (_, nats) = service_config(state.inner(), &connection_id).await?;
    nats_state.service(state.inner()).await?.fetch_history(&nats, request).await
}

#[tauri::command]
pub async fn nats_start_subscription(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    nats_state: State<'_, NatsServiceState>,
    connection_id: String,
    request: NatsSubscriptionRequest,
) -> Result<NatsSubscriptionInfo, String> {
    let (_, nats) = service_config(state.inner(), &connection_id).await?;
    let service = nats_state.service(state.inner()).await?;
    nats_state.ensure_event_forwarder(&app, &service);
    service.start_subscription(&connection_id, &nats, request).await
}

#[tauri::command]
pub async fn nats_stop_subscription(
    state: State<'_, Arc<AppState>>,
    nats_state: State<'_, NatsServiceState>,
    connection_id: String,
    subscription_id: String,
) -> Result<bool, String> {
    let service = nats_state.service(state.inner()).await?;
    service.stop_subscription(&connection_id, &subscription_id).await
}

#[tauri::command]
pub async fn nats_list_subscriptions(
    state: State<'_, Arc<AppState>>,
    nats_state: State<'_, NatsServiceState>,
    connection_id: String,
) -> Result<Vec<NatsSubscriptionInfo>, String> {
    let service = nats_state.service(state.inner()).await?;
    service.list_subscriptions(&connection_id).await
}

#[tauri::command]
pub async fn nats_close_connection(
    nats_state: State<'_, NatsServiceState>,
    connection_id: String,
) -> Result<(), String> {
    nats_state.close_connection(&connection_id).await;
    Ok(())
}
