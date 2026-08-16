export interface NatsHeader {
  key: string;
  value: string;
}

export interface NatsMessage {
  subject: string;
  reply?: string;
  headers: NatsHeader[];
  payloadBase64: string;
  payloadText?: string;
  receivedAtMs: number;
  sizeBytes: number;
}

export interface NatsServerInfo {
  ok: boolean;
  serverName?: string;
  serverVersion?: string;
  headersSupported: boolean;
  jetstreamEnabled: boolean;
  maxPayload: number;
  connectedUrl: string;
  roundTripMs: number;
}

export interface NatsCaptureRequest {
  subject: string;
  durationMs?: number;
  maxMessages?: number;
  maxBytes?: number;
  includeHeaders?: boolean;
}

export interface NatsCaptureResult {
  subject: string;
  messages: NatsMessage[];
  receivedCount: number;
  droppedCount: number;
  truncated: boolean;
  stopReason: string;
}

export interface NatsPublishRequest {
  subject: string;
  reply?: string;
  headers?: NatsHeader[];
  payloadBase64: string;
}

export interface NatsPublishResult {
  acceptedByClient: boolean;
  payloadBytes: number;
}

export interface NatsJetStreamInfo {
  enabled: boolean;
  memoryBytes: number;
  storageBytes: number;
  streams: number;
  consumers: number;
}

export interface NatsStreamInfo {
  name: string;
  subjects: string[];
  storage: string;
  retention: string;
  messages: number;
  bytes: number;
  firstSequence: number;
  lastSequence: number;
  consumers: number;
}

export interface NatsStreamList {
  streams: NatsStreamInfo[];
  truncated: boolean;
}

export interface NatsConsumerInfo {
  stream: string;
  name: string;
  filterSubject: string;
  ackPolicy: string;
  deliveredConsumerSequence: number;
  deliveredStreamSequence: number;
  ackFloorConsumerSequence: number;
  ackFloorStreamSequence: number;
  pending: number;
  ackPending: number;
  redelivered: number;
}

export interface NatsConsumerList {
  stream: string;
  consumers: NatsConsumerInfo[];
  truncated: boolean;
}

export interface NatsHistoryRequest {
  stream: string;
  startSequence?: number;
  maxMessages?: number;
  maxBytes?: number;
}

export interface NatsHistoryResult {
  stream: string;
  messages: NatsMessage[];
  receivedCount: number;
  skippedCount: number;
  truncated: boolean;
  nextSequence?: number;
  ackMode: string;
  consumerKind: string;
}

export interface NatsSubscriptionRequest {
  subscriptionId: string;
  subject: string;
  queueGroup?: string;
}

export interface NatsSubscriptionInfo {
  subscriptionId: string;
  subject: string;
  queueGroup?: string;
  state: string;
  receivedCount: number;
  droppedCount: number;
}

export interface NatsSubscriptionMessageEvent {
  connectionId: string;
  subscriptionId: string;
  sequence: number;
  droppedCount?: number;
  message: NatsMessage;
}

export interface NatsSubscriptionStateEvent {
  connectionId: string;
  subscriptionId: string;
  sequence: number;
  state: string;
  droppedCount?: number;
  detail?: string;
}

export interface NatsSubscriptionErrorEvent {
  connectionId: string;
  subscriptionId: string;
  sequence: number;
  message: string;
}

export interface NatsSubscriptionEventHandlers {
  onMessage(event: NatsSubscriptionMessageEvent): void;
  onState(event: NatsSubscriptionStateEvent): void;
  onError(event: NatsSubscriptionErrorEvent): void;
}
