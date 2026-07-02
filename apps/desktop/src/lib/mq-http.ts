// HTTP fetch API for message queue admin (web mode)
import { apiUrl } from "@/lib/webPath";
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

async function post<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => "")).trim();
    throw new Error(detail ? `${path} returned ${resp.status}: ${detail}` : `${path} returned ${resp.status}`);
  }
  return resp.json();
}

export async function mqTestConnection(connectionId: string): Promise<MqClusterInfo> {
  return post("/api/mq/test-connection", { connectionId });
}

export async function mqListTenants(connectionId: string): Promise<TenantInfo[]> {
  return post("/api/mq/tenants/list", { connectionId });
}

export async function mqGetTenant(connectionId: string, name: string): Promise<TenantInfo> {
  return post("/api/mq/tenants/get", { connectionId, name });
}

export async function mqCreateTenant(connectionId: string, name: string, config: TenantConfig): Promise<void> {
  return post("/api/mq/tenants/create", { connectionId, name, config });
}

export async function mqUpdateTenant(connectionId: string, name: string, config: TenantConfig): Promise<void> {
  return post("/api/mq/tenants/update", { connectionId, name, config });
}

export async function mqDeleteTenant(connectionId: string, name: string, force: boolean): Promise<void> {
  return post("/api/mq/tenants/delete", { connectionId, name, force });
}

export async function mqListNamespaces(connectionId: string, tenant: string): Promise<NamespaceInfo[]> {
  return post("/api/mq/namespaces/list", { connectionId, tenant });
}

export async function mqCreateNamespace(connectionId: string, ns: NamespaceRef, config: NamespaceConfig): Promise<void> {
  return post("/api/mq/namespaces/create", { connectionId, ns, config });
}

export async function mqDeleteNamespace(connectionId: string, ns: NamespaceRef, force: boolean): Promise<void> {
  return post("/api/mq/namespaces/delete", { connectionId, ns, force });
}

export async function mqGetNamespacePolicies(connectionId: string, ns: NamespaceRef): Promise<unknown> {
  return post("/api/mq/namespaces/policies", { connectionId, ns });
}

export async function mqListTopics(connectionId: string, ns: NamespaceRef, opts: ListTopicsOpts): Promise<TopicInfo[]> {
  return post("/api/mq/topics/list", { connectionId, ns, opts });
}

export async function mqCreateTopic(connectionId: string, topic: TopicRef, partitions?: number): Promise<void> {
  return post("/api/mq/topics/create", { connectionId, topic, partitions });
}

export async function mqDeleteTopic(connectionId: string, topic: TopicRef, force: boolean): Promise<void> {
  return post("/api/mq/topics/delete", { connectionId, topic, force });
}

export async function mqUpdatePartitions(connectionId: string, topic: TopicRef, partitions: number): Promise<void> {
  return post("/api/mq/topics/update-partitions", { connectionId, topic, partitions });
}

export async function mqGetTopicStats(connectionId: string, topic: TopicRef): Promise<TopicStats> {
  return post("/api/mq/topics/stats", { connectionId, topic });
}

export async function mqGetTopicInternalStats(connectionId: string, topic: TopicRef): Promise<unknown> {
  return post("/api/mq/topics/internal-stats", { connectionId, topic });
}

export async function mqListSubscriptions(connectionId: string, topic: TopicRef): Promise<SubscriptionInfo[]> {
  return post("/api/mq/subscriptions/list", { connectionId, topic });
}

export async function mqCreateSubscription(connectionId: string, topic: TopicRef, sub: string, pos: ResetPosition): Promise<void> {
  return post("/api/mq/subscriptions/create", { connectionId, topic, sub, pos });
}

export async function mqDeleteSubscription(connectionId: string, topic: TopicRef, sub: string, force: boolean): Promise<void> {
  return post("/api/mq/subscriptions/delete", { connectionId, topic, sub, force });
}

export async function mqSkipMessages(connectionId: string, topic: TopicRef, sub: string, count: SkipCount): Promise<void> {
  return post("/api/mq/subscriptions/skip-messages", { connectionId, topic, sub, count });
}

export async function mqResetCursor(connectionId: string, topic: TopicRef, sub: string, pos: ResetPosition): Promise<void> {
  return post("/api/mq/subscriptions/reset-cursor", { connectionId, topic, sub, pos });
}

export async function mqClearBacklog(connectionId: string, topic: TopicRef, sub: string): Promise<void> {
  return post("/api/mq/subscriptions/clear-backlog", { connectionId, topic, sub });
}

export async function mqPeekMessages(connectionId: string, topic: TopicRef, sub: string, count: number, options?: PeekMessagesOptions): Promise<PeekedMessage[]> {
  return post("/api/mq/subscriptions/peek-messages", { connectionId, topic, sub, count, options });
}

export async function mqExpireMessages(connectionId: string, topic: TopicRef, sub: string, expireSeconds: number): Promise<void> {
  return post("/api/mq/subscriptions/expire-messages", { connectionId, topic, sub, expireSeconds });
}

export async function mqListProducers(connectionId: string, topic: TopicRef): Promise<ProducerInfo[]> {
  return post("/api/mq/producers/list", { connectionId, topic });
}

export async function mqListConsumers(connectionId: string, topic: TopicRef, sub: string): Promise<ConsumerInfo[]> {
  return post("/api/mq/consumers/list", { connectionId, topic, sub });
}

export async function mqUnloadTopic(connectionId: string, topic: TopicRef): Promise<void> {
  return post("/api/mq/topics/unload", { connectionId, topic });
}

export async function mqSetPublishRate(connectionId: string, scope: PolicyScope, rate: PublishRate): Promise<void> {
  return post("/api/mq/policies/publish-rate", { connectionId, scope, rate });
}

export async function mqSetDispatchRate(connectionId: string, scope: PolicyScope, rate: DispatchRate): Promise<void> {
  return post("/api/mq/policies/dispatch-rate", { connectionId, scope, rate });
}

export async function mqSetSubscribeRate(connectionId: string, scope: PolicyScope, rate: SubscribeRate): Promise<void> {
  return post("/api/mq/policies/subscribe-rate", { connectionId, scope, rate });
}

export async function mqSetBacklogQuota(connectionId: string, scope: PolicyScope, quota: BacklogQuota): Promise<void> {
  return post("/api/mq/policies/backlog-quota", { connectionId, scope, quota });
}

export async function mqSetRetention(connectionId: string, scope: PolicyScope, retention: RetentionPolicy): Promise<void> {
  return post("/api/mq/policies/retention", { connectionId, scope, retention });
}

export async function mqGetEffectivePolicies(connectionId: string, scope: PolicyScope): Promise<unknown> {
  return post("/api/mq/policies/effective", { connectionId, scope });
}

export async function mqGrantPermission(connectionId: string, scope: PolicyScope, role: string, actions: AuthAction[]): Promise<void> {
  return post("/api/mq/permissions/grant", { connectionId, scope, role, actions });
}

export async function mqRevokePermission(connectionId: string, scope: PolicyScope, role: string): Promise<void> {
  return post("/api/mq/permissions/revoke", { connectionId, scope, role });
}

export async function mqListPermissions(connectionId: string, scope: PolicyScope): Promise<PermissionMap> {
  return post("/api/mq/permissions/list", { connectionId, scope });
}

export async function mqIssueToken(connectionId: string, req: MqTokenIssueRequest): Promise<MqIssuedToken> {
  return post("/api/mq/tokens/issue", { connectionId, req });
}

export async function mqListTokenRecords(connectionId: string, subject?: string): Promise<MqTokenRecord[]> {
  return post("/api/mq/tokens/list", { connectionId, subject });
}

export async function mqGetBacklog(connectionId: string, topic: TopicRef, sub?: string): Promise<BacklogStats> {
  return post("/api/mq/monitoring/backlog", { connectionId, topic, sub });
}

export async function mqGetClusterInfo(connectionId: string): Promise<ClusterInfo> {
  return post("/api/mq/monitoring/cluster-info", { connectionId });
}

export async function mqRawRequest(connectionId: string, req: MqRawRequest): Promise<MqRawResponse> {
  return post("/api/mq/raw", { connectionId, req });
}

export async function mqSendMessage(connectionId: string, req: SendMessageRequest): Promise<SendMessageResponse> {
  return post("/api/mq/send-message", { connectionId, req });
}
