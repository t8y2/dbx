// Message queue admin API functions - Tauri invoke layer
import { invoke } from "@tauri-apps/api/core";
import type {
  MqClusterInfo,
  ClusterInfo,
  TenantInfo,
  TenantConfig,
  NamespaceRef,
  NamespaceInfo,
  NamespaceConfig,
  TopicRef,
  TopicInfo,
  ListTopicsOpts,
  TopicStats,
  SubscriptionInfo,
  ResetPosition,
  SkipCount,
  ConsumerInfo,
  ProducerInfo,
  PolicyScope,
  PublishRate,
  DispatchRate,
  SubscribeRate,
  BacklogQuota,
  RetentionPolicy,
  AuthAction,
  PermissionMap,
  MqTokenIssueRequest,
  MqTokenRecord,
  MqIssuedToken,
  BacklogStats,
  RocketMqConsumerGroupConfig,
  PeekedMessage,
  PeekMessagesOptions,
  MqRawRequest,
  MqRawResponse,
  SendMessageRequest,
  SendMessageResponse,
  MqExchangeInfo,
  MqExchangeCreateRequest,
  MqBindingInfo,
  MqBindingListFilter,
  MqClientConnectionInfo,
  MqChannelInfo,
  MqUserInfo,
  MqVhostPermission,
  MqUserPermissionListFilter,
  MqUserPermissionPatterns,
  MqPolicyInfo,
  MqPolicyListFilter,
  MqPolicyUpsertRequest,
  MqOverviewInfo,
  MqNodeInfo,
} from "@/types/mq";

// Connectivity
export async function mqTestConnection(connectionId: string): Promise<MqClusterInfo> {
  return invoke("mq_test_connection", { connectionId });
}

// Exchanges / Bindings (RabbitMQ)
export async function mqListExchanges(connectionId: string, ns: NamespaceRef): Promise<MqExchangeInfo[]> {
  return invoke("mq_list_exchanges", { connectionId, ns });
}

export async function mqCreateExchange(connectionId: string, ns: NamespaceRef, exchange: MqExchangeCreateRequest): Promise<void> {
  return invoke("mq_create_exchange", { connectionId, ns, name: exchange.name, exchangeType: exchange.type, durable: exchange.durable, autoDelete: exchange.autoDelete });
}

export async function mqDeleteExchange(connectionId: string, ns: NamespaceRef, name: string): Promise<void> {
  return invoke("mq_delete_exchange", { connectionId, ns, name });
}

export async function mqListBindings(connectionId: string, ns: NamespaceRef, filter?: MqBindingListFilter): Promise<MqBindingInfo[]> {
  return invoke("mq_list_bindings", { connectionId, ns, exchange: filter?.exchange, queue: filter?.queue });
}

export async function mqBind(connectionId: string, ns: NamespaceRef, binding: MqBindingInfo): Promise<void> {
  return invoke("mq_bind", { connectionId, ns, binding });
}

export async function mqUnbind(connectionId: string, ns: NamespaceRef, binding: MqBindingInfo): Promise<void> {
  return invoke("mq_unbind", { connectionId, ns, binding });
}

// Client connections / channels (RabbitMQ)
export async function mqListClientConnections(connectionId: string, ns: NamespaceRef): Promise<MqClientConnectionInfo[]> {
  return invoke("mq_list_client_connections", { connectionId, ns });
}

export async function mqListClientChannels(connectionId: string, ns: NamespaceRef, connection?: string): Promise<MqChannelInfo[]> {
  return invoke("mq_list_client_channels", { connectionId, ns, connection });
}

export async function mqCloseClientConnection(connectionId: string, ns: NamespaceRef, name: string): Promise<void> {
  return invoke("mq_close_client_connection", { connectionId, ns, name });
}

// Users & vhost permissions (RabbitMQ)
export async function mqListUsers(connectionId: string): Promise<MqUserInfo[]> {
  return invoke("mq_list_users", { connectionId });
}

export async function mqCreateUser(connectionId: string, name: string, password: string, tags?: string[]): Promise<void> {
  return invoke("mq_create_user", { connectionId, name, password, tags });
}

export async function mqDeleteUser(connectionId: string, name: string): Promise<void> {
  return invoke("mq_delete_user", { connectionId, name });
}

export async function mqListUserPermissions(connectionId: string, filter?: MqUserPermissionListFilter): Promise<MqVhostPermission[]> {
  return invoke("mq_list_user_permissions", { connectionId, virtualHost: filter?.virtualHost, user: filter?.user, allVhosts: filter?.allVhosts });
}

export async function mqGrantUserPermission(connectionId: string, user: string, virtualHost: string, patterns?: MqUserPermissionPatterns): Promise<void> {
  return invoke("mq_grant_user_permission", { connectionId, user, virtualHost, configure: patterns?.configure, write: patterns?.write, read: patterns?.read });
}

export async function mqRevokeUserPermission(connectionId: string, user: string, virtualHost: string): Promise<void> {
  return invoke("mq_revoke_user_permission", { connectionId, user, virtualHost });
}

// Policies (RabbitMQ)
export async function mqListPolicies(connectionId: string, filter?: MqPolicyListFilter): Promise<MqPolicyInfo[]> {
  return invoke("mq_list_policies", { connectionId, virtualHost: filter?.virtualHost, allVhosts: filter?.allVhosts });
}

export async function mqSetPolicy(connectionId: string, virtualHost: string, policy: MqPolicyUpsertRequest): Promise<void> {
  return invoke("mq_set_policy", { connectionId, virtualHost, name: policy.name, pattern: policy.pattern, applyTo: policy.applyTo, priority: policy.priority, definition: policy.definition });
}

export async function mqDeletePolicy(connectionId: string, virtualHost: string, name: string): Promise<void> {
  return invoke("mq_delete_policy", { connectionId, virtualHost, name });
}

// Cluster overview & nodes (RabbitMQ)
export async function mqGetOverview(connectionId: string): Promise<MqOverviewInfo> {
  return invoke("mq_get_overview", { connectionId });
}

export async function mqListNodes(connectionId: string): Promise<MqNodeInfo[]> {
  return invoke("mq_list_nodes", { connectionId });
}

// Tenants
export async function mqListTenants(connectionId: string): Promise<TenantInfo[]> {
  return invoke("mq_list_tenants", { connectionId });
}

export async function mqGetTenant(connectionId: string, name: string): Promise<TenantInfo> {
  return invoke("mq_get_tenant", { connectionId, name });
}

export async function mqCreateTenant(connectionId: string, name: string, config: TenantConfig): Promise<void> {
  return invoke("mq_create_tenant", { connectionId, name, config });
}

export async function mqUpdateTenant(connectionId: string, name: string, config: TenantConfig): Promise<void> {
  return invoke("mq_update_tenant", { connectionId, name, config });
}

export async function mqDeleteTenant(connectionId: string, name: string, force: boolean): Promise<void> {
  return invoke("mq_delete_tenant", { connectionId, name, force });
}

// Namespaces
export async function mqListNamespaces(connectionId: string, tenant: string): Promise<NamespaceInfo[]> {
  return invoke("mq_list_namespaces", { connectionId, tenant });
}

export async function mqCreateNamespace(connectionId: string, ns: NamespaceRef, config: NamespaceConfig): Promise<void> {
  return invoke("mq_create_namespace", { connectionId, ns, config });
}

export async function mqDeleteNamespace(connectionId: string, ns: NamespaceRef, force: boolean): Promise<void> {
  return invoke("mq_delete_namespace", { connectionId, ns, force });
}

export async function mqGetNamespacePolicies(connectionId: string, ns: NamespaceRef): Promise<unknown> {
  return invoke("mq_get_namespace_policies", { connectionId, ns });
}

// Topics
export async function mqListTopics(connectionId: string, ns: NamespaceRef, opts: ListTopicsOpts): Promise<TopicInfo[]> {
  return invoke("mq_list_topics", { connectionId, ns, opts });
}

export async function mqCreateTopic(connectionId: string, topic: TopicRef, partitions?: number): Promise<void> {
  return invoke("mq_create_topic", { connectionId, topic, partitions });
}

export async function mqDeleteTopic(connectionId: string, topic: TopicRef, force: boolean): Promise<void> {
  return invoke("mq_delete_topic", { connectionId, topic, force });
}

export async function mqUpdatePartitions(connectionId: string, topic: TopicRef, partitions: number): Promise<void> {
  return invoke("mq_update_partitions", { connectionId, topic, partitions });
}

export async function mqGetTopicStats(connectionId: string, topic: TopicRef): Promise<TopicStats> {
  return invoke("mq_get_topic_stats", { connectionId, topic });
}

export async function mqGetTopicInternalStats(connectionId: string, topic: TopicRef): Promise<unknown> {
  return invoke("mq_get_topic_internal_stats", { connectionId, topic });
}

// Subscriptions
export async function mqListSubscriptions(connectionId: string, topic: TopicRef): Promise<SubscriptionInfo[]> {
  return invoke("mq_list_subscriptions", { connectionId, topic });
}

export async function mqCreateSubscription(connectionId: string, topic: TopicRef, sub: string, pos: ResetPosition): Promise<void> {
  return invoke("mq_create_subscription", { connectionId, topic, sub, pos });
}

export async function mqDeleteSubscription(connectionId: string, topic: TopicRef, sub: string, force: boolean): Promise<void> {
  return invoke("mq_delete_subscription", { connectionId, topic, sub, force });
}

export async function mqSkipMessages(connectionId: string, topic: TopicRef, sub: string, count: SkipCount): Promise<void> {
  return invoke("mq_skip_messages", { connectionId, topic, sub, count });
}

export async function mqResetCursor(connectionId: string, topic: TopicRef, sub: string, pos: ResetPosition): Promise<void> {
  return invoke("mq_reset_cursor", { connectionId, topic, sub, pos });
}

export async function mqClearBacklog(connectionId: string, topic: TopicRef, sub: string): Promise<void> {
  return invoke("mq_clear_backlog", { connectionId, topic, sub });
}

export async function mqPeekMessages(connectionId: string, topic: TopicRef, sub: string, count: number, options?: PeekMessagesOptions): Promise<PeekedMessage[]> {
  return invoke("mq_peek_messages", { connectionId, topic, sub, count, options });
}

export async function mqExpireMessages(connectionId: string, topic: TopicRef, sub: string, expireSeconds: number): Promise<void> {
  return invoke("mq_expire_messages", { connectionId, topic, sub, expireSeconds });
}

// Producers / Consumers
export async function mqListProducers(connectionId: string, topic: TopicRef): Promise<ProducerInfo[]> {
  return invoke("mq_list_producers", { connectionId, topic });
}

export async function mqListConsumers(connectionId: string, topic: TopicRef, sub: string): Promise<ConsumerInfo[]> {
  return invoke("mq_list_consumers", { connectionId, topic, sub });
}

export async function mqUnloadTopic(connectionId: string, topic: TopicRef): Promise<void> {
  return invoke("mq_unload_topic", { connectionId, topic });
}

// Policies
export async function mqSetPublishRate(connectionId: string, scope: PolicyScope, rate: PublishRate): Promise<void> {
  return invoke("mq_set_publish_rate", { connectionId, scope, rate });
}

export async function mqSetDispatchRate(connectionId: string, scope: PolicyScope, rate: DispatchRate): Promise<void> {
  return invoke("mq_set_dispatch_rate", { connectionId, scope, rate });
}

export async function mqSetSubscribeRate(connectionId: string, scope: PolicyScope, rate: SubscribeRate): Promise<void> {
  return invoke("mq_set_subscribe_rate", { connectionId, scope, rate });
}

export async function mqSetBacklogQuota(connectionId: string, scope: PolicyScope, quota: BacklogQuota): Promise<void> {
  return invoke("mq_set_backlog_quota", { connectionId, scope, quota });
}

export async function mqSetRetention(connectionId: string, scope: PolicyScope, retention: RetentionPolicy): Promise<void> {
  return invoke("mq_set_retention", { connectionId, scope, retention });
}

export async function mqGetEffectivePolicies(connectionId: string, scope: PolicyScope): Promise<unknown> {
  return invoke("mq_get_effective_policies", { connectionId, scope });
}

// Permissions
export async function mqGrantPermission(connectionId: string, scope: PolicyScope, role: string, actions: AuthAction[]): Promise<void> {
  return invoke("mq_grant_permission", { connectionId, scope, role, actions });
}

export async function mqRevokePermission(connectionId: string, scope: PolicyScope, role: string): Promise<void> {
  return invoke("mq_revoke_permission", { connectionId, scope, role });
}

export async function mqListPermissions(connectionId: string, scope: PolicyScope): Promise<PermissionMap> {
  return invoke("mq_list_permissions", { connectionId, scope });
}

export async function mqIssueToken(connectionId: string, req: MqTokenIssueRequest): Promise<MqIssuedToken> {
  return invoke("mq_issue_token", { connectionId, req });
}

export async function mqListTokenRecords(connectionId: string, subject?: string): Promise<MqTokenRecord[]> {
  return invoke("mq_list_token_records", { connectionId, subject });
}

// Monitoring
export async function mqGetBacklog(connectionId: string, topic: TopicRef, sub?: string): Promise<BacklogStats> {
  return invoke("mq_get_backlog", { connectionId, topic, sub });
}

export async function mqGetConsumerGroupConfig(connectionId: string, groupId: string): Promise<RocketMqConsumerGroupConfig> {
  return invoke("mq_get_consumer_group_config", { connectionId, groupId });
}

export async function mqAlterConsumerGroupConfig(connectionId: string, groupId: string, config: Partial<RocketMqConsumerGroupConfig>): Promise<void> {
  return invoke("mq_alter_consumer_group_config", { connectionId, groupId, config });
}

export async function mqGetClusterInfo(connectionId: string): Promise<ClusterInfo> {
  return invoke("mq_get_cluster_info", { connectionId });
}

export async function mqGetTopicRoute(connectionId: string, topic: TopicRef): Promise<unknown> {
  return invoke("mq_get_topic_route", { connectionId, topic });
}

export async function mqAlterTopicConfig(connectionId: string, topic: TopicRef, configs: unknown): Promise<void> {
  return invoke("mq_alter_topic_config", { connectionId, topic, configs });
}

export async function mqSkipTopicAccumulation(connectionId: string, topic: TopicRef): Promise<unknown> {
  return invoke("mq_skip_topic_accumulation", { connectionId, topic });
}

export async function mqViewMessage(connectionId: string, topic: TopicRef, msgId: string): Promise<unknown> {
  return invoke("mq_view_message", { connectionId, topic, msgId });
}

export async function mqQueryMessagesByKey(connectionId: string, topic: TopicRef, key: string, begin: number, end: number, maxNum: number): Promise<unknown> {
  return invoke("mq_query_messages_by_key", { connectionId, topic, key, begin, end, maxNum });
}

export async function mqQueryMessagesByTopic(connectionId: string, topic: TopicRef, begin: number, end: number, maxNum: number): Promise<unknown> {
  return invoke("mq_query_messages_by_topic", { connectionId, topic, begin, end, maxNum });
}

export async function mqQueryMessageTrace(connectionId: string, msgId: string, traceTopic?: string): Promise<unknown> {
  return invoke("mq_query_message_trace", { connectionId, msgId, traceTopic });
}

// Raw request
export async function mqRawRequest(connectionId: string, req: MqRawRequest): Promise<MqRawResponse> {
  return invoke("mq_raw_request", { connectionId, req });
}

export async function mqSendMessage(connectionId: string, req: SendMessageRequest): Promise<SendMessageResponse> {
  return invoke("mq_send_message", { connectionId, req });
}
