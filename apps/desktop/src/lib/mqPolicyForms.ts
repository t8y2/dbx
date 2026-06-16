import type { BacklogQuota, DispatchRate, PublishRate, RetentionPolicy, SubscribeRate } from "@/types/mq";

export interface MqPolicyForms {
  publishForm: PublishRate;
  dispatchForm: DispatchRate;
  subscribeForm: SubscribeRate;
  backlogForm: BacklogQuota;
  retentionForm: RetentionPolicy;
}

export function defaultMqPolicyForms(): MqPolicyForms {
  return {
    publishForm: {
      publishThrottlingRateInMsg: 0,
      publishThrottlingRateInByte: 0,
    },
    dispatchForm: {
      dispatchThrottlingRateInMsg: 0,
      dispatchThrottlingRateInByte: 0,
      ratePeriodInSecond: 1,
    },
    subscribeForm: {
      subscribeThrottlingRatePerConsumer: 0,
      ratePeriodInSecond: 1,
    },
    backlogForm: {
      limitSize: -1,
      limitTime: -1,
      policy: "producer_request_hold",
      quotaType: "destination_storage",
    },
    retentionForm: {
      retentionTimeInMinutes: -1,
      retentionSizeInMb: -1,
    },
  };
}

export function policyFormsFromEffectivePolicies(raw: unknown, fallback: MqPolicyForms): MqPolicyForms {
  const root = objectRecord(raw);
  const topicPolicies = objectRecord(root.topicPolicies);
  const namespacePolicies = objectRecord(root.namespacePolicies);
  const namespaceSource = Object.keys(namespacePolicies).length ? namespacePolicies : root;

  const publish = firstRecord(topicPolicies.publishRate, root.publishRate, namespaceSource.publishRate, namespaceSource.publishMaxMessageRate);
  const dispatch = firstRecord(topicPolicies.dispatchRate, root.dispatchRate, namespaceSource.dispatchRate);
  const subscribe = firstRecord(topicPolicies.subscribeRate, root.subscribeRate, namespaceSource.subscribeRate);
  const backlog = normalizeBacklogQuota(firstDefined(topicPolicies.backlogQuota, root.backlogQuota, namespaceSource.backlogQuota, namespaceSource.backlogQuotaMap, namespaceSource.backlog_quota_map));
  const retention = firstRecord(topicPolicies.retention, root.retention, namespaceSource.retention, namespaceSource.retentionPolicies, namespaceSource.retention_policies);

  return {
    publishForm: publish
      ? {
          publishThrottlingRateInMsg: numberField(publish.publishThrottlingRateInMsg) ?? fallback.publishForm.publishThrottlingRateInMsg,
          publishThrottlingRateInByte: numberField(publish.publishThrottlingRateInByte) ?? fallback.publishForm.publishThrottlingRateInByte,
        }
      : { ...fallback.publishForm },
    dispatchForm: dispatch
      ? {
          dispatchThrottlingRateInMsg: numberField(dispatch.dispatchThrottlingRateInMsg) ?? fallback.dispatchForm.dispatchThrottlingRateInMsg,
          dispatchThrottlingRateInByte: numberField(dispatch.dispatchThrottlingRateInByte) ?? fallback.dispatchForm.dispatchThrottlingRateInByte,
          ratePeriodInSecond: numberField(dispatch.ratePeriodInSecond) ?? fallback.dispatchForm.ratePeriodInSecond,
        }
      : { ...fallback.dispatchForm },
    subscribeForm: subscribe
      ? {
          subscribeThrottlingRatePerConsumer: numberField(subscribe.subscribeThrottlingRatePerConsumer) ?? fallback.subscribeForm.subscribeThrottlingRatePerConsumer,
          ratePeriodInSecond: numberField(subscribe.ratePeriodInSecond) ?? fallback.subscribeForm.ratePeriodInSecond,
        }
      : { ...fallback.subscribeForm },
    backlogForm: backlog
      ? {
          limitSize: numberField(backlog.limitSize) ?? numberField(backlog.limit) ?? fallback.backlogForm.limitSize,
          limitTime: numberField(backlog.limitTime) ?? fallback.backlogForm.limitTime,
          policy: stringField(backlog.policy) || fallback.backlogForm.policy,
          quotaType: stringField(backlog.quotaType) || fallback.backlogForm.quotaType,
        }
      : { ...fallback.backlogForm },
    retentionForm: retention
      ? {
          retentionTimeInMinutes: numberField(retention.retentionTimeInMinutes) ?? fallback.retentionForm.retentionTimeInMinutes,
          retentionSizeInMb: numberField(retention.retentionSizeInMb) ?? numberField(retention.retentionSizeInMB) ?? fallback.retentionForm.retentionSizeInMb,
        }
      : { ...fallback.retentionForm },
  };
}

function normalizeBacklogQuota(value: unknown): Record<string, unknown> | undefined {
  const quota = objectRecord(value);
  if (!Object.keys(quota).length) return undefined;
  if (hasQuotaFields(quota)) return quota;

  const entries = Object.entries(quota);
  for (const [quotaType, body] of entries) {
    const normalized = objectRecord(body);
    if (hasQuotaFields(normalized)) {
      return {
        ...normalized,
        quotaType: normalized.quotaType ?? quotaType,
      };
    }
  }
  return undefined;
}

function hasQuotaFields(value: Record<string, unknown>): boolean {
  return "limit" in value || "limitSize" in value || "limitTime" in value || "policy" in value;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    const record = objectRecord(value);
    if (Object.keys(record).length) return record;
  }
  return undefined;
}

function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
