import { apiUrl } from "@/lib/common/webPath";
import type {
  NatsCaptureRequest,
  NatsCaptureResult,
  NatsConsumerInfo,
  NatsConsumerList,
  NatsHistoryRequest,
  NatsHistoryResult,
  NatsJetStreamInfo,
  NatsPublishRequest,
  NatsPublishResult,
  NatsServerInfo,
  NatsStreamInfo,
  NatsStreamList,
  NatsSubscriptionInfo,
  NatsSubscriptionEventHandlers,
  NatsSubscriptionRequest,
} from "@/types/nats";

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${(await response.text().catch(() => "")).trim()}`);
  return response.json();
}

export const natsTestConnection = (connectionId: string) => post<NatsServerInfo>("/api/nats/mcp/test-connection", { connectionId });
export const natsCapture = (connectionId: string, request: NatsCaptureRequest) => post<NatsCaptureResult>("/api/nats/mcp/capture", { connectionId, capture: request });
export const natsPublish = (connectionId: string, request: NatsPublishRequest) => post<NatsPublishResult>("/api/nats/mcp/publish", { connectionId, publish: request });
export const natsJetstreamInfo = (connectionId: string) => post<NatsJetStreamInfo>("/api/nats/mcp/jetstream/info", { connectionId });
export const natsListStreams = (connectionId: string) => post<NatsStreamList>("/api/nats/mcp/jetstream/streams", { connectionId });
export const natsGetStream = (connectionId: string, stream: string) => post<NatsStreamInfo>("/api/nats/mcp/jetstream/stream", { connectionId, stream });
export const natsListConsumers = (connectionId: string, stream: string) => post<NatsConsumerList>("/api/nats/mcp/jetstream/consumers", { connectionId, stream });
export const natsGetConsumer = (connectionId: string, stream: string, consumer: string) => post<NatsConsumerInfo>("/api/nats/mcp/jetstream/consumer", { connectionId, stream, consumer });
export const natsFetchHistory = (connectionId: string, request: NatsHistoryRequest) => post<NatsHistoryResult>("/api/nats/mcp/jetstream/history", { connectionId, history: request });
export const natsStartSubscription = (connectionId: string, subscription: NatsSubscriptionRequest) => post<NatsSubscriptionInfo>("/api/nats/subscriptions/start", { connectionId, subscription });
export const natsStopSubscription = (connectionId: string, subscriptionId: string) => post<boolean>("/api/nats/subscriptions/stop", { connectionId, subscriptionId });
export const natsListSubscriptions = (connectionId: string) => post<NatsSubscriptionInfo[]>("/api/nats/subscriptions/list", { connectionId });
export const natsCloseConnection = async (connectionId: string): Promise<void> => {
  const subscriptions = await natsListSubscriptions(connectionId);
  await Promise.all(subscriptions.map((subscription) => natsStopSubscription(connectionId, subscription.subscriptionId)));
};

export function natsListenSubscription(connectionId: string, subscriptionId: string, handlers: NatsSubscriptionEventHandlers): Promise<() => void> {
  const events = new EventSource(apiUrl(`/api/nats/subscriptions/${encodeURIComponent(subscriptionId)}/events`));
  events.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as { kind?: string; data?: unknown };
      if (payload.kind === "message") {
        const data = payload.data as Parameters<NatsSubscriptionEventHandlers["onMessage"]>[0];
        if (data.connectionId === connectionId && data.subscriptionId === subscriptionId) handlers.onMessage(data);
      }
      if (payload.kind === "state") {
        const data = payload.data as Parameters<NatsSubscriptionEventHandlers["onState"]>[0];
        if (data.connectionId === connectionId && data.subscriptionId === subscriptionId) handlers.onState(data);
      }
      if (payload.kind === "error") {
        const data = payload.data as Parameters<NatsSubscriptionEventHandlers["onError"]>[0];
        if (data.connectionId === connectionId && data.subscriptionId === subscriptionId) handlers.onError(data);
      }
    } catch {
      // A malformed streamed item is isolated to this event; EventSource keeps
      // the subscription alive and the server-side bounded buffer remains intact.
    }
  };
  return Promise.resolve(() => events.close());
}
