import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  NatsSubscriptionMessageEvent,
  NatsSubscriptionStateEvent,
  NatsSubscriptionErrorEvent,
  NatsSubscriptionRequest,
} from "@/types/nats";

export const natsTestConnection = (connectionId: string) => invoke<NatsServerInfo>("nats_test_connection", { connectionId });
export const natsCapture = (connectionId: string, request: NatsCaptureRequest) => invoke<NatsCaptureResult>("nats_capture", { connectionId, request });
export const natsPublish = (connectionId: string, request: NatsPublishRequest) => invoke<NatsPublishResult>("nats_publish", { connectionId, request });
export const natsJetstreamInfo = (connectionId: string) => invoke<NatsJetStreamInfo>("nats_jetstream_info", { connectionId });
export const natsListStreams = (connectionId: string) => invoke<NatsStreamList>("nats_list_streams", { connectionId });
export const natsGetStream = (connectionId: string, stream: string) => invoke<NatsStreamInfo>("nats_get_stream", { connectionId, stream });
export const natsListConsumers = (connectionId: string, stream: string) => invoke<NatsConsumerList>("nats_list_consumers", { connectionId, stream });
export const natsGetConsumer = (connectionId: string, stream: string, consumer: string) => invoke<NatsConsumerInfo>("nats_get_consumer", { connectionId, stream, consumer });
export const natsFetchHistory = (connectionId: string, request: NatsHistoryRequest) => invoke<NatsHistoryResult>("nats_fetch_history", { connectionId, request });
export const natsStartSubscription = (connectionId: string, request: NatsSubscriptionRequest) => invoke<NatsSubscriptionInfo>("nats_start_subscription", { connectionId, request });
export const natsStopSubscription = (connectionId: string, subscriptionId: string) => invoke<boolean>("nats_stop_subscription", { connectionId, subscriptionId });
export const natsListSubscriptions = (connectionId: string) => invoke<NatsSubscriptionInfo[]>("nats_list_subscriptions", { connectionId });
export const natsCloseConnection = (connectionId: string) => invoke<void>("nats_close_connection", { connectionId });

export async function natsListenSubscription(connectionId: string, subscriptionId: string, handlers: NatsSubscriptionEventHandlers): Promise<() => void> {
  const listeners = await Promise.all([
    listen<NatsSubscriptionMessageEvent>("nats://message", ({ payload }) => {
      if (payload.connectionId === connectionId && payload.subscriptionId === subscriptionId) handlers.onMessage(payload);
    }),
    listen<NatsSubscriptionStateEvent>("nats://state", ({ payload }) => {
      if (payload.connectionId === connectionId && payload.subscriptionId === subscriptionId) handlers.onState(payload);
    }),
    listen<NatsSubscriptionErrorEvent>("nats://error", ({ payload }) => {
      if (payload.connectionId === connectionId && payload.subscriptionId === subscriptionId) handlers.onError(payload);
    }),
  ]);
  return () => listeners.forEach((stop) => stop());
}
