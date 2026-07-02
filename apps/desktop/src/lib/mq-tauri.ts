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
  PeekedMessage,
  PeekMessagesOptions,
  MqRawRequest,
  MqRawResponse,
  SendMessageRequest,
  SendMessageResponse,
} from "@/types/mq";

// Connectivity
export async function mqTestConnection(connectionId: string): Promise<MqClusterInfo> {
  return invoke("mq_test_connection", { connectionId });
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

export async function mqGetClusterInfo(connectionId: string): Promise<ClusterInfo> {
  return invoke("mq_get_cluster_info", { connectionId });
}

// Raw request
export async function mqRawRequest(connectionId: string, req: MqRawRequest): Promise<MqRawResponse> {
  return invoke("mq_raw_request", { connectionId, req });
}

export async function mqSendMessage(connectionId: string, req: SendMessageRequest): Promise<SendMessageResponse> {
  return invoke("mq_send_message", { connectionId, req });
}
