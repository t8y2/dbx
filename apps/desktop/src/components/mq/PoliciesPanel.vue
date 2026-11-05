<script setup lang="ts">
import { formatError } from "@/lib/backend/errorUtils";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { BacklogQuota, DispatchRate, MqSystemKind, PolicyScope, PublishRate, RetentionPolicy, SubscribeRate, TopicInfo } from "@/types/mq";
import { mqGetEffectivePolicies, mqSetBacklogQuota, mqSetDispatchRate, mqSetPublishRate, mqSetRetention, mqSetSubscribeRate } from "@/lib/backend/api";
import { defaultMqPolicyForms, extractKafkaRetentionConfigs, policyAccessFromEffectivePolicies, policyFormsFromEffectivePolicies, retentionWriteFlags, type MqRetentionForm, type RetentionBaseline } from "@/lib/mq/mqPolicyForms";
import { useMqMutationGuard } from "@/composables/useMqMutationGuard";

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  topic?: TopicInfo;
  readOnly?: boolean;
  isFlatMqCluster?: boolean;
  supportsRateLimits?: boolean;
  supportsBacklogQuota?: boolean;
  supportsRetention?: boolean;
  /** 后端类型：Kafka 的保留大小按字节展示，标签与 Pulsar/RocketMQ 不同。 */
  systemKind?: MqSystemKind;
}

const props = defineProps<Props>();
const { t } = useI18n();
const { confirmMqWrite } = useMqMutationGuard(() => props.connectionId);

const policies = ref<unknown>();
const loading = ref(false);
const error = ref<string>();
const notice = ref<string>();
const readOnlyMessage = computed(() => t("mqPolicies.readOnly"));
const defaultForms = defaultMqPolicyForms();
const policyAccess = ref(policyAccessFromEffectivePolicies(undefined));
const isKafka = computed(() => props.systemKind === "kafka");

const publishForm = ref<PublishRate>({ ...defaultForms.publishForm });

const dispatchForm = ref<DispatchRate>({ ...defaultForms.dispatchForm });

const subscribeForm = ref<SubscribeRate>({ ...defaultForms.subscribeForm });

const backlogForm = ref<BacklogQuota>({ ...defaultForms.backlogForm });

const retentionForm = ref<MqRetentionForm>({ ...defaultForms.retentionForm });

/** 加载完成后的表单快照，Kafka 保存时据此判断哪些字段被用户改过。 */
const retentionBaseline = ref<RetentionBaseline | null>(null);
/** Kafka broker 返回的 retention.ms / retention.bytes 原始值，用于展示取整前的副文本。 */
const retentionTimeSourceMs = ref<number>();
const retentionSizeSourceBytes = ref<number>();

const scope = computed<PolicyScope | null>(() => {
  if (!props.tenant || !props.namespace) return null;
  if (props.isFlatMqCluster && !props.topic) return null;
  if (props.topic) {
    return {
      level: "topic",
      tenant: props.tenant,
      namespace: props.namespace,
      topic: props.topic.shortName,
      persistent: props.topic.persistent,
    };
  }
  return {
    level: "namespace",
    tenant: props.tenant,
    namespace: props.namespace,
  };
});

const scopePlaceholderMessage = computed(() => (props.isFlatMqCluster ? t("mqPolicies.selectTopicFirst") : t("mqPolicies.selectNamespaceOrTopic")));

const scopeLabel = computed(() => {
  const current = scope.value;
  if (!current) return "";
  if (current.level === "topic") {
    return `${current.tenant}/${current.namespace}/${current.topic}`;
  }
  return `${current.tenant}/${current.namespace}`;
});

const formattedPolicies = computed(() => JSON.stringify(policies.value ?? {}, null, 2));

/** 输入框清空时 v-model.number 会给出空串，统一归一成 null。 */
function numericOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const retentionTimeHint = computed(() => {
  if (!isKafka.value) return "";
  const minutes = numericOrNull(retentionForm.value.retentionTimeInMinutes);
  if (minutes === null) return t("mqPolicies.retentionUnset");
  if (minutes === -1) return t("mqPolicies.retentionUnlimited");
  if (minutes === 0) return t("mqPolicies.retentionZero");
  const sourceMs = retentionTimeSourceMs.value;
  // 仅当展示值仍对应原始毫秒值时才提示，用户改动后不再误导。
  if (sourceMs !== undefined && sourceMs >= 0 && sourceMs % 60000 !== 0 && minutes === Math.floor(sourceMs / 60000)) {
    return t("mqPolicies.retentionExactMs", { ms: sourceMs });
  }
  return "";
});

const retentionSizeHint = computed(() => {
  if (!isKafka.value) return "";
  const megabytes = numericOrNull(retentionForm.value.retentionSizeInMb);
  if (megabytes === null) return t("mqPolicies.retentionUnset");
  if (megabytes === -1) return t("mqPolicies.retentionUnlimited");
  if (megabytes === 0) {
    // 0 可能是 broker 的真实 0，也可能是小于 1 MB 的非零值被向下取整，需靠原始字节区分。
    const sourceBytes = retentionSizeSourceBytes.value;
    if (sourceBytes !== undefined && sourceBytes > 0 && sourceBytes < 1024 * 1024 && megabytes === Math.floor(sourceBytes / (1024 * 1024))) {
      return t("mqPolicies.retentionLessThanOneMb", { bytes: sourceBytes });
    }
    return t("mqPolicies.retentionZero");
  }
  const sourceBytes = retentionSizeSourceBytes.value;
  if (sourceBytes !== undefined && sourceBytes >= 0 && sourceBytes % (1024 * 1024) !== 0 && megabytes === Math.floor(sourceBytes / (1024 * 1024))) {
    return t("mqPolicies.retentionExactBytes", { bytes: sourceBytes });
  }
  return "";
});

/** 加载失败时没有基线，禁止 Kafka 保存，避免把未知字段覆盖成默认值。 */
const retentionSaveDisabled = computed(() => isKafka.value && retentionBaseline.value === null);

async function guardWritable(operation: string): Promise<boolean> {
  if (props.readOnly) {
    error.value = readOnlyMessage.value;
    notice.value = undefined;
    return false;
  }
  return confirmMqWrite(operation);
}

async function loadPolicies() {
  const current = scope.value;
  policies.value = undefined;
  policyAccess.value = policyAccessFromEffectivePolicies(undefined);
  retentionBaseline.value = null;
  retentionTimeSourceMs.value = undefined;
  retentionSizeSourceBytes.value = undefined;
  notice.value = undefined;
  error.value = undefined;
  if (!current) return;

  loading.value = true;
  try {
    const loaded = await mqGetEffectivePolicies(props.connectionId, current);
    policies.value = loaded;
    policyAccess.value = policyAccessFromEffectivePolicies(loaded);
    const hydrated = policyFormsFromEffectivePolicies(loaded, defaultMqPolicyForms());
    applyPolicyForms(hydrated);
    const kafkaRetention = extractKafkaRetentionConfigs(loaded);
    retentionTimeSourceMs.value = kafkaRetention?.timeMs;
    retentionSizeSourceBytes.value = kafkaRetention?.sizeBytes;
    retentionBaseline.value = {
      time: hydrated.retentionForm.retentionTimeInMinutes,
      size: hydrated.retentionForm.retentionSizeInMb,
    };
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function applyPolicy(kind: string, action: (current: PolicyScope) => Promise<void>) {
  if (!(await guardWritable(kind))) return;
  const current = scope.value;
  if (!current) {
    error.value = scopePlaceholderMessage.value;
    return;
  }

  loading.value = true;
  error.value = undefined;
  notice.value = undefined;
  try {
    await action(current);
    notice.value = t("mqPolicies.savedNotice", { policy: kind });
    await loadPolicies();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function savePublishRate() {
  return applyPolicy(t("mqPolicies.publishRate"), (scope) => mqSetPublishRate(props.connectionId, scope, { ...publishForm.value }));
}

function saveDispatchRate() {
  return applyPolicy(t("mqPolicies.dispatchRate"), (scope) => mqSetDispatchRate(props.connectionId, scope, { ...dispatchForm.value }));
}

function saveSubscribeRate() {
  return applyPolicy(t("mqPolicies.subscribeRate"), (scope) => mqSetSubscribeRate(props.connectionId, scope, { ...subscribeForm.value }));
}

function saveBacklogQuota() {
  return applyPolicy(t("mqPolicies.backlogQuota"), (scope) => mqSetBacklogQuota(props.connectionId, scope, { ...backlogForm.value }));
}

function saveRetention() {
  if (!isKafka.value) {
    // Pulsar/RocketMQ 维持原行为：两个字段整体提交。
    return applyPolicy(t("mqPolicies.retention"), (scope) =>
      mqSetRetention(props.connectionId, scope, {
        retentionTimeInMinutes: numericOrNull(retentionForm.value.retentionTimeInMinutes) ?? -1,
        retentionSizeInMb: numericOrNull(retentionForm.value.retentionSizeInMb) ?? -1,
      }),
    );
  }

  // Kafka：以加载快照为基线，只提交用户改过的字段，避免未回显的字段被 -1 覆盖。
  const minutes = numericOrNull(retentionForm.value.retentionTimeInMinutes);
  const megabytes = numericOrNull(retentionForm.value.retentionSizeInMb);
  const { writeTime, writeSize } = retentionWriteFlags({ time: minutes, size: megabytes }, retentionBaseline.value);
  if (!writeTime && !writeSize) {
    notice.value = t("mqPolicies.retentionUnchanged");
    return;
  }

  const payload: RetentionPolicy = {
    retentionTimeInMinutes: minutes ?? -1,
    retentionSizeInMb: megabytes ?? -1,
    writeRetentionTime: writeTime,
    writeRetentionSize: writeSize,
  };
  return applyPolicy(t("mqPolicies.retention"), (scope) => mqSetRetention(props.connectionId, scope, { ...payload }));
}

function currentPolicyForms() {
  return {
    publishForm: { ...publishForm.value },
    dispatchForm: { ...dispatchForm.value },
    subscribeForm: { ...subscribeForm.value },
    backlogForm: { ...backlogForm.value },
    retentionForm: { ...retentionForm.value },
  };
}

function applyPolicyForms(forms: ReturnType<typeof currentPolicyForms>) {
  publishForm.value = forms.publishForm;
  dispatchForm.value = forms.dispatchForm;
  subscribeForm.value = forms.subscribeForm;
  backlogForm.value = forms.backlogForm;
  retentionForm.value = forms.retentionForm;
}

watch(
  () => [props.tenant, props.namespace, props.topic?.name, props.topic?.persistent],
  () => {
    loadPolicies();
  },
  { immediate: true },
);
</script>

<template>
  <div class="policies-panel">
    <div class="panel-toolbar">
      <div>
        <h3>{{ t("mqPolicies.title") }}</h3>
        <div v-if="scopeLabel" class="scope-label">{{ scopeLabel }}</div>
      </div>
      <button @click="loadPolicies" :disabled="loading || !scope" class="btn-sm">
        {{ loading ? t("mqPolicies.refreshing") : t("mqPolicies.refresh") }}
      </button>
    </div>

    <div v-if="!scope" class="panel-placeholder">{{ scopePlaceholderMessage }}</div>

    <div v-else class="policies-content">
      <div v-if="readOnly" class="readonly-hint">{{ t("mqPolicies.readonlyHint") }}</div>
      <div v-if="error" class="panel-error">{{ error }}</div>
      <div v-if="notice" class="panel-notice">{{ notice }}</div>

      <div v-if="!policyAccess.readable" class="readonly-hint">{{ policyAccess.unsupportedReason }}</div>
      <div v-else class="policy-grid">
        <section v-if="supportsRateLimits !== false" class="policy-section">
          <h4>{{ t("mqPolicies.publishRate") }}</h4>
          <label>
            {{ t("mqPolicies.msgsPerSecond") }}
            <input v-model.number="publishForm.publishThrottlingRateInMsg" type="number" :disabled="readOnly" />
          </label>
          <label>
            {{ t("mqPolicies.bytesPerSecond") }}
            <input v-model.number="publishForm.publishThrottlingRateInByte" type="number" :disabled="readOnly" />
          </label>
          <button @click="savePublishRate" :disabled="loading || readOnly" class="btn-primary">{{ t("mqPolicies.save") }}</button>
        </section>

        <section v-if="supportsRateLimits !== false" class="policy-section">
          <h4>{{ t("mqPolicies.dispatchRate") }}</h4>
          <label>
            {{ t("mqPolicies.msgsPerPeriod") }}
            <input v-model.number="dispatchForm.dispatchThrottlingRateInMsg" type="number" :disabled="readOnly" />
          </label>
          <label>
            {{ t("mqPolicies.bytesPerPeriod") }}
            <input v-model.number="dispatchForm.dispatchThrottlingRateInByte" type="number" :disabled="readOnly" />
          </label>
          <label>
            {{ t("mqPolicies.periodSeconds") }}
            <input v-model.number="dispatchForm.ratePeriodInSecond" type="number" min="1" :disabled="readOnly" />
          </label>
          <button @click="saveDispatchRate" :disabled="loading || readOnly" class="btn-primary">{{ t("mqPolicies.save") }}</button>
        </section>

        <section v-if="supportsRateLimits !== false" class="policy-section">
          <h4>{{ t("mqPolicies.subscribeRate") }}</h4>
          <label>
            {{ t("mqPolicies.msgsPerConsumerPerPeriod") }}
            <input v-model.number="subscribeForm.subscribeThrottlingRatePerConsumer" type="number" :disabled="readOnly" />
          </label>
          <label>
            {{ t("mqPolicies.periodSeconds") }}
            <input v-model.number="subscribeForm.ratePeriodInSecond" type="number" min="1" :disabled="readOnly" />
          </label>
          <button @click="saveSubscribeRate" :disabled="loading || readOnly" class="btn-primary">{{ t("mqPolicies.save") }}</button>
        </section>

        <section v-if="supportsBacklogQuota !== false" class="policy-section">
          <h4>{{ t("mqPolicies.backlogQuota") }}</h4>
          <label>
            {{ t("mqPolicies.sizeLimitBytes") }}
            <input v-model.number="backlogForm.limitSize" type="number" :disabled="readOnly" />
          </label>
          <label>
            {{ t("mqPolicies.timeLimitSeconds") }}
            <input v-model.number="backlogForm.limitTime" type="number" :disabled="readOnly" />
          </label>
          <label>
            {{ t("mqPolicies.policy") }}
            <select v-model="backlogForm.policy" :disabled="readOnly">
              <option value="producer_request_hold">{{ t("mqPolicies.backlogPolicyProducerRequestHold") }}</option>
              <option value="producer_exception">{{ t("mqPolicies.backlogPolicyProducerException") }}</option>
              <option value="consumer_backlog_eviction">{{ t("mqPolicies.backlogPolicyConsumerBacklogEviction") }}</option>
            </select>
          </label>
          <label>
            {{ t("mqPolicies.type") }}
            <input v-model="backlogForm.quotaType" type="text" :disabled="readOnly" />
          </label>
          <button @click="saveBacklogQuota" :disabled="loading || readOnly" class="btn-primary">{{ t("mqPolicies.save") }}</button>
        </section>

        <section v-if="supportsRetention !== false" class="policy-section">
          <h4>{{ t("mqPolicies.retention") }}</h4>
          <label>
            {{ t("mqPolicies.retentionTimeMinutes") }}
            <input v-model.number="retentionForm.retentionTimeInMinutes" type="number" :disabled="readOnly" />
            <span v-if="isKafka && retentionTimeHint" class="field-hint">{{ retentionTimeHint }}</span>
          </label>
          <label>
            {{ t("mqPolicies.retentionSizeMb") }}
            <input v-model.number="retentionForm.retentionSizeInMb" type="number" :disabled="readOnly" />
            <span v-if="isKafka && retentionSizeHint" class="field-hint">{{ retentionSizeHint }}</span>
          </label>
          <button @click="saveRetention" :disabled="loading || readOnly || retentionSaveDisabled" class="btn-primary">{{ t("mqPolicies.save") }}</button>
        </section>
      </div>

      <section class="json-section">
        <h4>{{ t("mqPolicies.effectivePolicies") }}</h4>
        <pre>{{ formattedPolicies }}</pre>
      </section>
    </div>
  </div>
</template>

<style scoped>
@import "./shared/mqPanel.css";

.policies-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.panel-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}

.panel-toolbar h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.scope-label {
  margin-top: 4px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.policies-content {
  flex: 1;
  overflow: auto;
  padding: 16px;
}

.policy-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}

.policy-section,
.json-section {
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background-secondary);
}

.policy-section h4,
.json-section h4 {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.field-hint {
  color: var(--color-text-secondary);
  font-size: 12px;
}

input,
select {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background);
  color: var(--color-text);
  box-sizing: border-box;
}

input:disabled,
select:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.json-section {
  margin-top: 16px;
}

pre {
  margin: 0;
  padding: 12px;
  max-height: 360px;
  overflow: auto;
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  color: var(--color-text);
  font-size: 12px;
}

.panel-placeholder,
.panel-error,
.panel-notice,
.readonly-hint {
  padding: 12px 16px;
  margin-bottom: 12px;
  border-radius: var(--dbx-radius-fixed-6);
  font-size: 13px;
}

.panel-placeholder {
  margin: 24px;
  color: var(--color-text-secondary);
  text-align: center;
}

.panel-error {
  background: var(--color-error-bg);
  color: var(--color-error);
}

.panel-notice {
  background: var(--color-success-alpha);
  color: var(--color-success);
}

.readonly-hint {
  background: var(--color-warning-alpha);
  color: var(--color-warning);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
