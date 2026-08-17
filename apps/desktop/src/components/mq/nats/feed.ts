import type { NatsMessage } from "@/types/nats";

/**
 * A "feed" is one entry in the subscription rail: either a live Core NATS
 * subscription (backed by a server-side subscriptionId) or a bounded capture
 * sample. Both carry their own message buffer so multiple can run at once.
 */
export interface NatsFeed {
  id: string;
  connectionId: string;
  subject: string;
  kind: "live" | "capture";
  state: string;
  messages: NatsMessage[];
  receivedCount: number;
  droppedCount: number;
  runtimeId?: number;
  stopReason?: string;
}

/** Newest-message-wins buffer cap so a busy subject cannot grow unbounded. */
export const FEED_BUFFER_LIMIT = 1000;
