// Message queue admin types, matching dbx-core/src/mq/types.rs

export type MqSystemKind = "pulsar" | "kafka" | "rocketmq";

export interface MqCapabilities {
  supportsTenants: boolean;
  supportsNamespaces: boolean;
  supportsPartitionedTopics: boolean;
  supportsSubscriptions: boolean;
  supportsCreateSubscription: boolean;
  supportsResetCursor: boolean;
  supportsSkipMessages: boolean;
  supportsClearBacklog: boolean;
  supportsPeekMessages: boolean;
  supportsExpireMessages: boolean;
  supportsRateLimits: boolean;
  supportsBacklogQuota: boolean;
  supportsRetention: boolean;
  supportsPermissions: boolean;
  supportsGeoReplication: boolean;
  supportsTokenManagement: boolean;
  supportsRawAdminApi: boolean;
  supportsSendMessage?: boolean;
  supportsMessageQuery?: boolean;
  supportsDlq?: boolean;
  supportsMessageTrace?: boolean;
}

export interface MqClusterInfo {
  systemKind: MqSystemKind;
  serverVersion?: string;
  resolvedProfile: string;
  versionDetection: string;
  capabilities: MqCapabilities;
  extra?: unknown;
}

export interface MqAuth {
  kind: "none" | "token" | "basic" | "apiKey" | "oauth2";
  token?: string;
  username?: string;
  password?: string;
  header?: string;
  value?: string;
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
  audience?: string;
  scope?: string;
}

export interface MqAdminConfig {
  systemKind: MqSystemKind;
  adminUrl: string;
  auth?: MqAuth;
  tlsSkipVerify?: boolean;
  pinnedVersion?: string;
  tokenSigning?: MqTokenSigningConfig;
  extra?: unknown;
}

export type MqTokenSigningAlgorithm = "hs256" | "rs256";

export interface MqTokenSigningConfig {
  algorithm: MqTokenSigningAlgorithm;
  key: string;
}

export interface MqTokenIssueRequest {
  subject: string;
  expiresInSeconds?: number;
  scope?: PolicyScope;
  actions: AuthAction[];
  note?: string;
}

export interface MqTokenRecord {
  id: string;
  connectionId: string;
  subject: string;
  algorithm: MqTokenSigningAlgorithm;
  tokenFingerprint: string;
  scope?: PolicyScope;
  actions: AuthAction[];
  expiresAt?: string;
  createdAt: string;
  note: string;
}

export interface MqIssuedToken {
  token: string;
  record: MqTokenRecord;
}

// Tenant
export interface TenantInfo {
  name: string;
  adminRoles: string[];
  allowedClusters: string[];
}

export interface TenantConfig {
  adminRoles: string[];
  allowedClusters: string[];
}

// Namespace
export interface NamespaceRef {
  tenant: string;
  namespace: string;
}

export interface NamespaceInfo {
  tenant: string;
  namespace: string;
  adminRoles: string[];
}

export interface NamespaceConfig {
  clusters?: string[];
  bundles?: number;
}

// Topic
export interface TopicRef {
  tenant: string;
  namespace: string;
  topic: string;
  persistent: boolean;
  partitioned?: boolean;
  /** RocketMQ create hint: NORMAL / DELAY / FIFO / TRANSACTION */
  messageType?: string;
  brokerName?: string;
  readQueueNums?: number;
  writeQueueNums?: number;
  perm?: number;
}

export type RocketMqTopicMessageType = "NORMAL" | "DELAY" | "FIFO" | "TRANSACTION" | "UNSPECIFIED" | "RETRY" | "DLQ" | "SYSTEM";

export interface TopicInfo {
  name: string;
  shortName: string;
  partitioned: boolean;
  partitions?: number;
  persistent: boolean;
  internal?: boolean;
  messageType?: RocketMqTopicMessageType | string;
}

export interface ListTopicsOpts {
  includeNonPersistent?: boolean;
}

export interface TopicStats {
  msgRateIn: number;
  msgRateOut: number;
  msgThroughputIn: number;
  msgThroughputOut: number;
  storageSize: number;
  backlogSize: number;
  msgInCounter: number;
  msgOutCounter: number;
  subscriptionCount: number;
  producerCount: number;
  raw?: unknown;
}

// Subscription
export interface SubscriptionInfo {
  name: string;
  subType: string;
  msgBacklog: number;
  msgRateOut: number;
  msgThroughputOut: number;
  consumers: ConsumerInfo[];
  /** RocketMQ subscribed topics (cluster-wide listing). */
  topics?: string[];
  /** RocketMQ online consumer client count. */
  onlineMembers?: number;
  /** RocketMQ consumer group delivery type: NORMAL / FIFO / SYSTEM. */
  consumerGroupType?: string;
  /** RocketMQ consumer group message model: CLUSTERING / BROADCASTING. */
  messageModel?: string;
}

export interface RocketMqConsumerGroupConfig {
  groupName: string;
  consumeEnable: boolean;
  consumeFromMinEnable?: boolean;
  consumeBroadcastEnable: boolean;
  consumeMessageOrderly?: boolean;
  retryQueueNums: number;
  retryMaxTimes?: number;
  brokerId: number;
  whichBrokerWhenConsumeSlowly?: number;
}

export interface ConsumerInfo {
  consumerName: string;
  msgRateOut: number;
  msgThroughputOut: number;
  availablePermits: number;
  address: string;
  clientVersion: string;
}

export interface ProducerInfo {
  producerId: number;
  producerName: string;
  msgRateIn: number;
  msgThroughputIn: number;
  address: string;
  clientVersion: string;
}

export type ResetPosition = { kind: "earliest" } | { kind: "latest" } | { kind: "timestamp"; timestampMs: number } | { kind: "messageId"; ledgerId: number; entryId: number };

export type SkipCount = { kind: "all" } | { kind: "count"; count: number };

export interface BacklogStats {
  msgBacklog: number;
  backlogSize: number;
}

export interface ClusterInfo {
  clusterId?: string;
  brokerCount: number;
  controllerId?: number;
  controllerHost?: string;
  brokers: BrokerNode[];
  raw?: Record<string, unknown>;
}

export interface BrokerNode {
  id: number;
  host: string;
  port: number;
  rack?: string;
  brokerName?: string;
  role?: string;
}

export interface PeekedMessage {
  position: number;
  messageId?: string;
  key?: string;
  publishTime?: string;
  eventTime?: string;
  properties: Record<string, string>;
  headers: Record<string, string>;
  payloadBase64: string;
  payloadText?: string;
}

export interface PeekMessagesOptions {
  partition?: number;
  offset?: number;
}

// Policy scope
export type PolicyScope = { level: "namespace"; tenant: string; namespace: string } | { level: "topic"; tenant: string; namespace: string; topic: string; persistent: boolean };

export interface PublishRate {
  publishThrottlingRateInMsg: number;
  publishThrottlingRateInByte: number;
}

export interface DispatchRate {
  dispatchThrottlingRateInMsg: number;
  dispatchThrottlingRateInByte: number;
  ratePeriodInSecond: number;
}

export interface SubscribeRate {
  subscribeThrottlingRatePerConsumer: number;
  ratePeriodInSecond: number;
}

export interface BacklogQuota {
  limitSize: number;
  limitTime: number;
  policy: string;
  quotaType: string;
}

export interface RetentionPolicy {
  retentionTimeInMinutes: number;
  retentionSizeInMb: number;
}

export type AuthAction = "produce" | "consume" | "functions" | "sources" | "sinks" | "packages";

export type PermissionMap = Record<string, AuthAction[]>;

// Raw request
export interface MqRawRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface MqRawResponse {
  status: number;
  body: unknown;
  text?: string;
}

// Send message (produce)
export interface SendMessageRequest {
  topic: string;
  key?: string;
  payloadBase64: string;
  payloadText?: string;
  headers: Record<string, string>;
  partition?: number;
}

export interface SendMessageResponse {
  topic: string;
  partition: number;
  offset: number;
  timestamp?: string;
}
