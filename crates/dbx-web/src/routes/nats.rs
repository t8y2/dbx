//! NATS routes used by the MCP Web backend.
//!
//! The request deliberately contains only a DBX connection id.  Credentials
//! and the authoritative connection profile are loaded from Web storage, so a
//! remote MCP client cannot replace them by sending an ad-hoc profile.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use dbx_core::nats::{
    NatsCaptureRequest, NatsCaptureResult, NatsConnectionConfig, NatsConsumerInfo, NatsConsumerList,
    NatsHistoryRequest, NatsHistoryResult, NatsJetStreamInfo, NatsPublishRequest, NatsPublishResult, NatsServerInfo,
    NatsService, NatsStreamInfo, NatsStreamList, NatsSubscriptionEvent, NatsSubscriptionInfo, NatsSubscriptionRequest,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::{atomic::Ordering, Arc};

use crate::error::AppError;
use crate::state::WebState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NatsConnectionRequest {
    connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NatsCaptureRouteRequest {
    connection_id: String,
    capture: NatsCaptureRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NatsPublishRouteRequest {
    connection_id: String,
    publish: NatsPublishRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NatsJetStreamNameRouteRequest {
    connection_id: String,
    stream: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NatsJetStreamConsumerRouteRequest {
    connection_id: String,
    stream: String,
    consumer: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NatsHistoryRouteRequest {
    connection_id: String,
    history: NatsHistoryRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NatsSubscriptionStartRouteRequest {
    connection_id: String,
    subscription: NatsSubscriptionRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NatsSubscriptionStopRouteRequest {
    connection_id: String,
    subscription_id: String,
}

async fn load_nats(
    state: &Arc<WebState>,
    connection_id: &str,
) -> Result<dbx_core::models::connection::ConnectionConfig, AppError> {
    let config = state
        .app
        .storage
        .load_connections()
        .await
        .map_err(AppError::from)?
        .into_iter()
        .find(|config| config.id == connection_id)
        .ok_or_else(|| AppError::not_found(format!("Connection with id '{connection_id}' not found")))?;
    if !NatsConnectionConfig::is_nats_connection(&config) {
        return Err(AppError::bad_request("The selected connection is not configured as NATS (systemKind=nats)."));
    }
    Ok(config)
}

async fn load_nats_config(state: &Arc<WebState>, connection_id: &str) -> Result<NatsConnectionConfig, AppError> {
    let connection = load_nats(state, connection_id).await?;
    let mut nats = NatsConnectionConfig::from_connection(&connection).map_err(AppError::bad_request)?;
    let (configured_host, configured_port) = nats.configured_endpoint().map_err(AppError::bad_request)?;
    let (connect_host, connect_port) =
        state.app.connection_host_port(connection_id, &connection).await.map_err(AppError::from)?;
    if connect_host != configured_host || connect_port != configured_port {
        nats = nats.with_connect_override(&connect_host, connect_port).map_err(AppError::bad_request)?;
    }
    Ok(nats)
}

async fn persistent_service(state: &Arc<WebState>) -> Result<NatsService, AppError> {
    let mut service = state.nats.service.lock().await;
    if service.is_none() {
        *service = Some(NatsService::from_agent_manager(&state.app.agent_manager).map_err(AppError::internal)?);
    }
    Ok(service.as_ref().expect("NATS service initialized").clone())
}

fn ensure_subscription_owner(
    subscription: Option<&crate::state::NatsWebSubscription>,
    connection_id: &str,
) -> Result<(), AppError> {
    if subscription.is_some_and(|subscription| subscription.connection_id != connection_id) {
        return Err(AppError::bad_request("NATS subscriptionId belongs to a different connection"));
    }
    Ok(())
}

async fn connection_operation(state: &Arc<WebState>, connection_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut operations = state.nats.connection_operations.lock().await;
    operations.entry(connection_id.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
}

/// Tear down live Agent subscriptions before a Web connection is removed or
/// disconnected. This keeps a detached UI/session from retaining broker work.
pub(crate) async fn close_nats_connection(state: &Arc<WebState>, connection_id: &str) {
    let operation = connection_operation(state, connection_id).await;
    let _operation = operation.lock().await;
    // Remove the Web ownership records first. A start request that arrives
    // after this point is a new lifecycle and can retain its own record while
    // the old Agent runtime is being stopped below.
    state.nats.subscriptions.write().await.retain(|_, subscription| subscription.connection_id != connection_id);
    let service = state.nats.service.lock().await.as_ref().cloned();
    if let Some(service) = service {
        service.close_connection(connection_id).await;
    }
}

fn ensure_event_forwarder(state: &Arc<WebState>, service: &NatsService) {
    if state.nats.event_forwarder_started.swap(true, Ordering::AcqRel) {
        return;
    }
    let mut events = service.subscribe_subscription_events();
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            };
            let (subscription_id, runtime_id, payload) = web_subscription_event(event);
            let sender = state.nats.subscriptions.read().await.get(&subscription_id).cloned();
            if let Some(subscription) = sender.filter(|subscription| subscription.matches_runtime_id(runtime_id)) {
                subscription.send(payload);
            }
        }
    });
}

fn web_subscription_event(event: NatsSubscriptionEvent) -> (String, u64, String) {
    match event {
        NatsSubscriptionEvent::Message(message) => {
            subscription_event_json("message", message.subscription_id.clone(), message.runtime_id, message)
        }
        NatsSubscriptionEvent::State(state) => {
            subscription_event_json("state", state.subscription_id.clone(), state.runtime_id, state)
        }
        NatsSubscriptionEvent::Error(error) => {
            subscription_event_json("error", error.subscription_id.clone(), error.runtime_id, error)
        }
    }
}

fn subscription_event_json<T: serde::Serialize>(
    kind: &str,
    subscription_id: String,
    runtime_id: u64,
    event: T,
) -> (String, u64, String) {
    let payload = serde_json::to_string(&json!({ "kind": kind, "data": event })).unwrap_or_else(|_| {
        r#"{"kind":"error","data":{"message":"Unable to serialize NATS subscription event"}}"#.to_string()
    });
    (subscription_id, runtime_id, payload)
}

pub async fn test_connection(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<NatsConnectionRequest>,
) -> Result<Json<NatsServerInfo>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let nats = load_nats_config(&state, &req.connection_id).await?;
    let service = NatsService::from_agent_manager(&state.app.agent_manager).map_err(AppError::internal)?;
    service.test_connection(&nats).await.map(Json).map_err(AppError::from)
}

pub async fn capture(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<NatsCaptureRouteRequest>,
) -> Result<Json<NatsCaptureResult>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let request = req.capture.bounded().map_err(AppError::bad_request)?;
    let nats = load_nats_config(&state, &req.connection_id).await?;
    let service = NatsService::from_agent_manager(&state.app.agent_manager).map_err(AppError::internal)?;
    service.capture(&nats, request).await.map(Json).map_err(AppError::from)
}

pub async fn publish(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<NatsPublishRouteRequest>,
) -> Result<Json<NatsPublishResult>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "NATS publish").await?;
    let request = req.publish.validate().map_err(AppError::bad_request)?;
    let nats = load_nats_config(&state, &req.connection_id).await?;
    let service = NatsService::from_agent_manager(&state.app.agent_manager).map_err(AppError::internal)?;
    service.publish(&nats, request).await.map(Json).map_err(AppError::from)
}

pub async fn jetstream_info(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<NatsConnectionRequest>,
) -> Result<Json<NatsJetStreamInfo>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let nats = load_nats_config(&state, &req.connection_id).await?;
    let service = NatsService::from_agent_manager(&state.app.agent_manager).map_err(AppError::internal)?;
    service.jetstream_info(&nats).await.map(Json).map_err(AppError::from)
}

pub async fn list_streams(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<NatsConnectionRequest>,
) -> Result<Json<NatsStreamList>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let nats = load_nats_config(&state, &req.connection_id).await?;
    let service = NatsService::from_agent_manager(&state.app.agent_manager).map_err(AppError::internal)?;
    service.list_streams(&nats).await.map(Json).map_err(AppError::from)
}

pub async fn get_stream(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<NatsJetStreamNameRouteRequest>,
) -> Result<Json<NatsStreamInfo>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let nats = load_nats_config(&state, &req.connection_id).await?;
    let service = NatsService::from_agent_manager(&state.app.agent_manager).map_err(AppError::internal)?;
    service.get_stream(&nats, &req.stream).await.map(Json).map_err(AppError::from)
}

pub async fn list_consumers(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<NatsJetStreamNameRouteRequest>,
) -> Result<Json<NatsConsumerList>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let nats = load_nats_config(&state, &req.connection_id).await?;
    let service = NatsService::from_agent_manager(&state.app.agent_manager).map_err(AppError::internal)?;
    service.list_consumers(&nats, &req.stream).await.map(Json).map_err(AppError::from)
}

pub async fn get_consumer(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<NatsJetStreamConsumerRouteRequest>,
) -> Result<Json<NatsConsumerInfo>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let nats = load_nats_config(&state, &req.connection_id).await?;
    let service = NatsService::from_agent_manager(&state.app.agent_manager).map_err(AppError::internal)?;
    service.get_consumer(&nats, &req.stream, &req.consumer).await.map(Json).map_err(AppError::from)
}

pub async fn fetch_history(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<NatsHistoryRouteRequest>,
) -> Result<Json<NatsHistoryResult>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let history = req.history.bounded().map_err(AppError::bad_request)?;
    let nats = load_nats_config(&state, &req.connection_id).await?;
    let service = NatsService::from_agent_manager(&state.app.agent_manager).map_err(AppError::internal)?;
    service.fetch_history(&nats, history).await.map(Json).map_err(AppError::from)
}

pub async fn start_subscription(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<NatsSubscriptionStartRouteRequest>,
) -> Result<Json<NatsSubscriptionInfo>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let operation = connection_operation(&state, &req.connection_id).await;
    let _operation = operation.lock().await;
    let nats = load_nats_config(&state, &req.connection_id).await?;
    let service = persistent_service(&state).await?;
    ensure_event_forwarder(&state, &service);
    let request = req.subscription.validate().map_err(AppError::bad_request)?;
    let subscription_id = request.subscription_id.clone();
    let (subscription, inserted) = {
        let mut subscriptions = state.nats.subscriptions.write().await;
        if let Some(existing) = subscriptions.get(&subscription_id) {
            if existing.connection_id != req.connection_id {
                return Err(AppError::bad_request("NATS subscriptionId is already in use by a different connection"));
            }
            (existing.clone(), false)
        } else {
            let subscription = Arc::new(crate::state::NatsWebSubscription::new(req.connection_id.clone()));
            subscriptions.insert(subscription_id.clone(), subscription.clone());
            (subscription, true)
        }
    };
    let _lifecycle = subscription.lock_lifecycle().await;
    // A stop or connection close may have removed the map entry while a
    // duplicate start was waiting for the same subscription lifecycle lock.
    // Reclaim an absent entry, but never replace a newer owner.
    {
        let mut subscriptions = state.nats.subscriptions.write().await;
        if let Some(current) = subscriptions.get(&subscription_id) {
            if !Arc::ptr_eq(current, &subscription) {
                return Err(AppError::bad_request("NATS subscriptionId is already active"));
            }
        } else {
            subscriptions.insert(subscription_id.clone(), subscription.clone());
        }
    }
    let info = service.start_subscription(&req.connection_id, &nats, request).await.map_err(AppError::from);
    if info.is_err() && inserted {
        let mut subscriptions = state.nats.subscriptions.write().await;
        if subscriptions.get(&subscription_id).is_some_and(|current| Arc::ptr_eq(current, &subscription)) {
            subscriptions.remove(&subscription_id);
        }
    }
    let info = info?;
    subscription.set_runtime_id(info.runtime_id);
    Ok(Json(info))
}

pub async fn stop_subscription(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<NatsSubscriptionStopRouteRequest>,
) -> Result<Json<bool>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let operation = connection_operation(&state, &req.connection_id).await;
    let _operation = operation.lock().await;
    let subscription = state.nats.subscriptions.read().await.get(&req.subscription_id).cloned();
    ensure_subscription_owner(subscription.as_deref(), &req.connection_id)?;
    let stopped = if let Some(subscription) = subscription {
        let _lifecycle = subscription.lock_lifecycle().await;
        let service = persistent_service(&state).await?;
        let stopped =
            service.stop_subscription(&req.connection_id, &req.subscription_id).await.map_err(AppError::from)?;
        let mut subscriptions = state.nats.subscriptions.write().await;
        if subscriptions.get(&req.subscription_id).is_some_and(|current| Arc::ptr_eq(current, &subscription)) {
            subscriptions.remove(&req.subscription_id);
        }
        stopped
    } else {
        let service = persistent_service(&state).await?;
        service.stop_subscription(&req.connection_id, &req.subscription_id).await.map_err(AppError::from)?
    };
    Ok(Json(stopped))
}

pub async fn list_subscriptions(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<NatsConnectionRequest>,
) -> Result<Json<Vec<NatsSubscriptionInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let service = persistent_service(&state).await?;
    service.list_subscriptions(&req.connection_id).await.map(Json).map_err(AppError::from)
}

pub async fn subscription_events(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Path(subscription_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let subscription = state
        .nats
        .subscriptions
        .read()
        .await
        .get(&subscription_id)
        .cloned()
        .ok_or_else(|| AppError::not_found(format!("NATS subscription '{subscription_id}' not found")))?;
    super::mcp_policy::ensure_scope(&state, &headers, &subscription.connection_id).await?;
    let (replay, receiver) = subscription.subscribe();
    Ok(crate::sse::sse_from_replay_lossy_channel(replay, receiver))
}

#[cfg(test)]
mod tests {
    use super::ensure_subscription_owner;
    use crate::state::NatsWebSubscription;

    #[test]
    fn subscription_stop_requires_the_owning_connection() {
        let subscription = NatsWebSubscription::new("connection-a".to_string());
        assert!(ensure_subscription_owner(Some(&subscription), "connection-a").is_ok());
        let error = ensure_subscription_owner(Some(&subscription), "connection-b").unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        assert!(ensure_subscription_owner(None, "connection-b").is_ok());
    }

    #[test]
    fn subscription_events_require_the_current_runtime() {
        let subscription = NatsWebSubscription::new("connection-a".to_string());
        assert!(!subscription.matches_runtime_id(1));

        subscription.set_runtime_id(7);
        assert!(subscription.matches_runtime_id(7));
        assert!(!subscription.matches_runtime_id(8));
        assert!(!subscription.matches_runtime_id(0));
    }
}
