import type { BacklogQuota, DispatchRate, PublishRate, SubscribeRate } from "@/types/mq";

/** 保留策略表单值；null 表示 broker 没有返回该项（未设置），与 0 严格区分。 */
export interface MqRetentionForm {
  /** 保留时间（分钟）；Kafka 由 retention.ms 整除 60000 得出。 */
  retentionTimeInMinutes: number | null;
  /** 保留大小（MB）；Kafka 由 retention.bytes 按 1024×1024 换算得出。 */
  retentionSizeInMb: number | null;
}

export interface MqPolicyForms {
  publishForm: PublishRate;
  dispatchForm: DispatchRate;
  subscribeForm: SubscribeRate;
  backlogForm: BacklogQuota;
  retentionForm: MqRetentionForm;
}

export interface MqPolicyAccess {
  readable: boolean;
  unsupportedReason?: string;
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

export function policyAccessFromEffectivePolicies(raw: unknown): MqPolicyAccess {
  const root = objectRecord(raw);
  const readable = root.configSupported !== false;
  return {
    readable,
    unsupportedReason: readable ? undefined : stringField(root.unsupportedReason),
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
  // Kafka 的 DescribeConfigs 结果是 configs 键值表，与 Pulsar 的 retention 对象形状不同。
  const kafkaRetention = extractKafkaRetentionConfigs(raw);

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
    retentionForm: kafkaRetention
      ? {
          retentionTimeInMinutes: kafkaRetention.timeMs === undefined ? null : minutesFromRetentionMs(kafkaRetention.timeMs),
          retentionSizeInMb: kafkaRetention.sizeBytes === undefined ? null : megabytesFromRetentionBytes(kafkaRetention.sizeBytes),
        }
      : retention
        ? {
            retentionTimeInMinutes: numberField(retention.retentionTimeInMinutes) ?? fallback.retentionForm.retentionTimeInMinutes,
            retentionSizeInMb: numberField(retention.retentionSizeInMb) ?? numberField(retention.retentionSizeInMB) ?? fallback.retentionForm.retentionSizeInMb,
          }
        : { ...fallback.retentionForm },
  };
}

export interface KafkaRetentionConfigs {
  timeMs?: number;
  sizeBytes?: number;
}

/**
 * 从 Kafka DescribeConfigs 响应中提取 retention.ms / retention.bytes 的原始值。
 * 两个键都不存在时返回 undefined，交由调用方沿用旧的回退逻辑。
 */
export function extractKafkaRetentionConfigs(raw: unknown): KafkaRetentionConfigs | undefined {
  const configs = objectRecord(objectRecord(raw).configs);
  if (!Object.keys(configs).length) return undefined;
  const timeMs = numberField(configEntryValue(configs["retention.ms"]));
  const sizeBytes = numberField(configEntryValue(configs["retention.bytes"]));
  if (timeMs === undefined && sizeBytes === undefined) return undefined;
  return { timeMs, sizeBytes };
}

function configEntryValue(entry: unknown): unknown {
  const record = objectRecord(entry);
  return Object.keys(record).length && "value" in record ? record.value : entry;
}

/** retention.ms 换算为分钟：负数（-1）表示不限，其余向下取整，余数由 UI 以毫秒副文本展示。 */
export function minutesFromRetentionMs(ms: number): number {
  if (ms < 0) return -1;
  return Math.floor(ms / 60000);
}

/**
 * retention.bytes 换算为 MB：负数（-1）表示不限，其余按 1 MB = 1024×1024 字节向下取整。
 * 真实字节数由 UI 以副文本展示，避免静默取整。
 */
export function megabytesFromRetentionBytes(bytes: number): number {
  if (bytes < 0) return -1;
  return Math.floor(bytes / (1024 * 1024));
}

export interface RetentionBaseline {
  time: number | null;
  size: number | null;
}

/** 对比当前表单与加载快照，决定哪些字段需要下发；null 与 0 是不同的值。 */
export function retentionWriteFlags(current: RetentionBaseline, baseline: RetentionBaseline | null): { writeTime: boolean; writeSize: boolean } {
  if (!baseline) return { writeTime: current.time !== null, writeSize: current.size !== null };
  return { writeTime: current.time !== baseline.time, writeSize: current.size !== baseline.size };
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
