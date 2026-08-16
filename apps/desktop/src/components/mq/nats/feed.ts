import type { NatsMessage } from "@/types/nats";

/**
 * A "feed" is one entry in the subscription rail: either a live Core NATS
 * subscription (backed by a server-side subscriptionId) or a bounded capture
 * sample. Both carry their own message buffer so multiple can run at once.
 */
export interface NatsFeed {
  id: string;
  /** Connection that owns the live Agent subscription. */
  connectionId: string;
  subject: string;
  kind: "live" | "capture";
  state: string;
  messages: NatsMessage[];
  receivedCount: number;
  droppedCount: number;
  /** Last Agent event accepted for this live feed. */
  lastEventSequence?: number;
  /** Teardown has begun; a late start result must be stopped immediately. */
  closing?: boolean;
  stopReason?: string;
}

/** Newest-message-wins buffer cap so a busy subject cannot grow unbounded. */
export const FEED_BUFFER_LIMIT = 1000;
/** Per-feed payload and header budget, independent of card count. */
export const FEED_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
