use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex};

use crate::{
    agent_manager::DEFAULT_JRE_KEY,
    db::agent_driver::{
        agent_handshake_params, AgentDriverClient, AgentEventClient, AgentHandshake, AgentLaunchSpec, AgentNotification,
    },
};

use super::{config::NatsConnectionConfig, types::*};

#[derive(Clone)]
pub struct NatsService {
    launch: AgentLaunchSpec,
    live: Arc<NatsLiveRegistry>,
}

struct NatsLiveRegistry {
    runtimes: Mutex<HashMap<String, Arc<NatsLiveRuntime>>>,
    events: broadcast::Sender<NatsSubscriptionEvent>,
}

struct NatsLiveRuntime {
    client: Arc<AgentEventClient>,
}

#[derive(serde::Deserialize)]
struct StopSubscriptionResult {
    ok: bool,
}

impl NatsService {
    pub fn new(launch: AgentLaunchSpec) -> Self {
        let (events, _) = broadcast::channel(512);
        Self { launch, live: Arc::new(NatsLiveRegistry { runtimes: Mutex::new(HashMap::new()), events }) }
    }

    pub fn from_agent_manager(manager: &crate::agent_manager::AgentManager) -> Result<Self, String> {
        let state = manager.load_state();
        let launch = manager.resolve_agent_launch_spec(&state, "nats", DEFAULT_JRE_KEY)?;
        Ok(Self::new(launch))
    }

    pub fn from_env() -> Result<Self, String> {
        let program = std::env::var_os("DBX_NATS_AGENT")
            .map(PathBuf::from)
            .or_else(|| Some(PathBuf::from("dbx-agent-nats")))
            .ok_or("DBX_NATS_AGENT is not configured")?;
        Ok(Self::new(AgentLaunchSpec::new(program)))
    }

    pub async fn test_connection(&self, config: &NatsConnectionConfig) -> Result<NatsServerInfo, String> {
        let mut client = self.spawn().await?;
        let timeout = self.rpc_timeout(config);
        self.call::<NatsServerInfo>(
            &mut client,
            "test_connection",
            json!({ "connection": config.agent_value() }),
            Some(timeout),
        )
        .await
    }

    pub async fn capture(
        &self,
        config: &NatsConnectionConfig,
        request: NatsCaptureRequest,
    ) -> Result<NatsCaptureResult, String> {
        let request = request.bounded()?;
        let mut client = self.spawn().await?;
        let timeout = self.rpc_timeout(config).max(Duration::from_millis(request.duration_ms + 2_000));
        self.call::<NatsCaptureResult>(
            &mut client,
            "capture",
            json!({ "connection": config.agent_value(), "capture": request }),
            Some(timeout),
        )
        .await
    }

    pub async fn publish(
        &self,
        config: &NatsConnectionConfig,
        request: NatsPublishRequest,
    ) -> Result<NatsPublishResult, String> {
        let request = request.validate()?;
        let payload_bytes = request.payload_bytes()?;
        let mut client = self.spawn().await?;
        self.call::<NatsPublishResult>(
            &mut client,
            "publish",
            json!({ "connection": config.agent_value(), "publish": request }),
            Some(self.rpc_timeout(config)),
        )
        .await
        .map(|mut result| {
            result.payload_bytes = payload_bytes;
            result
        })
    }

    pub async fn jetstream_info(&self, config: &NatsConnectionConfig) -> Result<NatsJetStreamInfo, String> {
        let mut client = self.spawn().await?;
        self.call(
            &mut client,
            "jetstream_info",
            json!({ "connection": config.agent_value() }),
            Some(self.rpc_timeout(config)),
        )
        .await
    }

    pub async fn list_streams(&self, config: &NatsConnectionConfig) -> Result<NatsStreamList, String> {
        let mut client = self.spawn().await?;
        self.call(
            &mut client,
            "list_streams",
            json!({ "connection": config.agent_value() }),
            Some(self.rpc_timeout(config)),
        )
        .await
    }

    pub async fn get_stream(&self, config: &NatsConnectionConfig, stream: &str) -> Result<NatsStreamInfo, String> {
        let stream = validate_jetstream_name(stream, "stream")?;
        let mut client = self.spawn().await?;
        self.call(
            &mut client,
            "get_stream",
            json!({ "connection": config.agent_value(), "stream": stream }),
            Some(self.rpc_timeout(config)),
        )
        .await
    }

    pub async fn list_consumers(
        &self,
        config: &NatsConnectionConfig,
        stream: &str,
    ) -> Result<NatsConsumerList, String> {
        let stream = validate_jetstream_name(stream, "stream")?;
        let mut client = self.spawn().await?;
        self.call(
            &mut client,
            "list_consumers",
            json!({ "connection": config.agent_value(), "stream": stream }),
            Some(self.rpc_timeout(config)),
        )
        .await
    }

    pub async fn get_consumer(
        &self,
        config: &NatsConnectionConfig,
        stream: &str,
        consumer: &str,
    ) -> Result<NatsConsumerInfo, String> {
        let stream = validate_jetstream_name(stream, "stream")?;
        let consumer = validate_jetstream_name(consumer, "consumer")?;
        let mut client = self.spawn().await?;
        self.call(
            &mut client,
            "get_consumer",
            json!({ "connection": config.agent_value(), "stream": stream, "consumer": consumer }),
            Some(self.rpc_timeout(config)),
        )
        .await
    }

    pub async fn fetch_history(
        &self,
        config: &NatsConnectionConfig,
        request: NatsHistoryRequest,
    ) -> Result<NatsHistoryResult, String> {
        let request = request.bounded()?;
        let mut client = self.spawn().await?;
        self.call(
            &mut client,
            "fetch_history",
            json!({ "connection": config.agent_value(), "history": request }),
            Some(self.rpc_timeout(config)),
        )
        .await
    }

    /// Subscribe to domain events from all persistent subscriptions created by
    /// this service instance. Consumers must discard events for subscriptions
    /// they no longer own because a final in-flight event can race `stop`.
    pub fn subscribe_subscription_events(&self) -> broadcast::Receiver<NatsSubscriptionEvent> {
        self.live.events.subscribe()
    }

    pub async fn start_subscription(
        &self,
        connection_id: &str,
        config: &NatsConnectionConfig,
        request: NatsSubscriptionRequest,
    ) -> Result<NatsSubscriptionInfo, String> {
        if connection_id.trim().is_empty() {
            return Err("NATS connection id is required".to_string());
        }
        let request = request.validate()?;
        let runtime = self.live_runtime(connection_id).await?;
        runtime
            .client
            .call(
                "start_subscription",
                json!({ "connection": config.agent_value(), "subscription": request }),
                Some(self.rpc_timeout(config)),
            )
            .await
    }

    pub async fn stop_subscription(&self, connection_id: &str, subscription_id: &str) -> Result<bool, String> {
        let subscription_id = subscription_id.trim();
        if subscription_id.is_empty() {
            return Err("NATS subscriptionId is required".to_string());
        }
        let runtime = self.live.runtimes.lock().await.get(connection_id).cloned();
        let Some(runtime) = runtime else {
            return Ok(true);
        };
        let result: StopSubscriptionResult = runtime
            .client
            .call("stop_subscription", json!({ "subscriptionId": subscription_id }), Some(Duration::from_secs(5)))
            .await?;
        if result.ok {
            // Do not retain an idle Agent process once its last live
            // subscription ends. A failed list is non-fatal because stop has
            // already succeeded; the process remains available for retry.
            let remaining: Result<Vec<NatsSubscriptionInfo>, String> =
                runtime.client.call("list_subscriptions", json!({}), Some(Duration::from_secs(5))).await;
            if remaining.is_ok_and(|subscriptions| subscriptions.is_empty()) {
                let removed = {
                    let mut runtimes = self.live.runtimes.lock().await;
                    match runtimes.get(connection_id) {
                        Some(current) if Arc::ptr_eq(current, &runtime) => runtimes.remove(connection_id),
                        _ => None,
                    }
                };
                if let Some(runtime) = removed {
                    runtime.client.kill();
                }
            }
        }
        Ok(result.ok)
    }

    pub async fn list_subscriptions(&self, connection_id: &str) -> Result<Vec<NatsSubscriptionInfo>, String> {
        let runtime = self.live.runtimes.lock().await.get(connection_id).cloned();
        let Some(runtime) = runtime else {
            return Ok(Vec::new());
        };
        runtime.client.call("list_subscriptions", json!({}), Some(Duration::from_secs(5))).await
    }

    /// Stop and remove the persistent Agent for a DBX connection. This is used
    /// when a console closes or a connection is deleted, so subscriptions do
    /// not survive without an owning UI/session.
    pub async fn close_connection(&self, connection_id: &str) {
        if let Some(runtime) = self.live.runtimes.lock().await.remove(connection_id) {
            runtime.client.kill();
        }
    }

    async fn spawn(&self) -> Result<AgentDriverClient, String> {
        AgentDriverClient::spawn(self.launch.clone()).await
    }

    async fn call<T: DeserializeOwned + Send + 'static>(
        &self,
        client: &mut AgentDriverClient,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<T, String> {
        let _: crate::db::agent_driver::AgentHandshake =
            client.call_with_timeout("handshake", agent_handshake_params("dbx"), timeout).await?;
        client.call_with_timeout(method, params, timeout).await
    }

    fn rpc_timeout(&self, config: &NatsConnectionConfig) -> Duration {
        Duration::from_secs(config.request_timeout_secs.max(config.connect_timeout_secs).max(1))
    }

    async fn live_runtime(&self, connection_id: &str) -> Result<Arc<NatsLiveRuntime>, String> {
        if let Some(runtime) =
            self.live.runtimes.lock().await.get(connection_id).cloned().filter(|runtime| !runtime.client.is_failed())
        {
            return Ok(runtime);
        }
        let client = AgentEventClient::spawn(self.launch.clone()).await?;
        let handshake: AgentHandshake =
            client.call("handshake", agent_handshake_params("dbx"), Some(Duration::from_secs(15))).await?;
        if handshake.protocol_version < 2
            || !handshake.capabilities.iter().any(|capability| capability == "nats_subscription_events")
        {
            client.kill();
            return Err("NATS Agent does not support persistent subscription events".to_string());
        }
        let runtime = Arc::new(NatsLiveRuntime { client: client.clone() });
        self.start_event_router(connection_id.to_string(), client);
        let mut runtimes = self.live.runtimes.lock().await;
        if let Some(existing) = runtimes.get(connection_id).filter(|runtime| !runtime.client.is_failed()) {
            runtime.client.kill();
            return Ok(existing.clone());
        }
        runtimes.insert(connection_id.to_string(), runtime.clone());
        Ok(runtime)
    }

    fn start_event_router(&self, connection_id: String, client: Arc<AgentEventClient>) {
        let mut notifications = client.subscribe();
        let events = self.live.events.clone();
        tokio::spawn(async move {
            loop {
                match notifications.recv().await {
                    Ok(notification) => {
                        if let Some(event) = subscription_event(&connection_id, notification) {
                            let _ = events.send(event);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }
}

fn subscription_event(connection_id: &str, notification: AgentNotification) -> Option<NatsSubscriptionEvent> {
    match notification.method.as_str() {
        "subscription_message" => {
            serde_json::from_value::<NatsSubscriptionMessageEvent>(notification.params).ok().map(|mut event| {
                event.connection_id = connection_id.to_string();
                NatsSubscriptionEvent::Message(event)
            })
        }
        "subscription_state" => {
            serde_json::from_value::<NatsSubscriptionStateEvent>(notification.params).ok().map(|mut event| {
                event.connection_id = connection_id.to_string();
                NatsSubscriptionEvent::State(event)
            })
        }
        "subscription_error" => {
            serde_json::from_value::<NatsSubscriptionErrorEvent>(notification.params).ok().map(|mut event| {
                event.connection_id = connection_id.to_string();
                NatsSubscriptionEvent::Error(event)
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_subscription_events_with_the_owning_connection() {
        let event = subscription_event(
            "nats-primary",
            AgentNotification {
                method: "subscription_state".to_string(),
                params: json!({ "subscriptionId": "sub-1", "sequence": 3, "state": "active" }),
            },
        );
        let Some(NatsSubscriptionEvent::State(state)) = event else {
            panic!("state notification must map to a NATS domain event");
        };
        assert_eq!(state.connection_id, "nats-primary");
        assert_eq!(state.subscription_id, "sub-1");
        assert_eq!(state.sequence, 3);
    }
}
