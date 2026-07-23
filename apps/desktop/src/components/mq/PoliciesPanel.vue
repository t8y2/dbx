<script setup lang="ts">
import { formatError } from "@/lib/backend/errorUtils";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { BacklogQuota, DispatchRate, PolicyScope, PublishRate, RetentionPolicy, SubscribeRate, TopicInfo } from "@/types/mq";
import { mqGetEffectivePolicies, mqSetBacklogQuota, mqSetDispatchRate, mqSetPublishRate, mqSetRetention, mqSetSubscribeRate } from "@/lib/backend/api";
import { defaultMqPolicyForms, policyFormsFromEffectivePolicies } from "@/lib/mq/mqPolicyForms";

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
}

const props = defineProps<Props>();
const { t } = useI18n();

const policies = ref<unknown>();
const loading = ref(false);
const error = ref<string>();
const notice = ref<string>();
const readOnlyMessage = computed(() => t("mqPolicies.readOnly"));
const defaultForms = defaultMqPolicyForms();

const publishForm = ref<PublishRate>({ ...defaultForms.publishForm });

const dispatchForm = ref<DispatchRate>({ ...defaultForms.dispatchForm });

const subscribeForm = ref<SubscribeRate>({ ...defaultForms.subscribeForm });

const backlogForm = ref<BacklogQuota>({ ...defaultForms.backlogForm });

const retentionForm = ref<RetentionPolicy>({ ...defaultForms.retentionForm });

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

function guardWritable() {
  if (props.readOnly) {
    error.value = readOnlyMessage.value;
    notice.value = undefined;
    return false;
  }
  return true;
}

async function loadPolicies() {
  const current = scope.value;
  policies.value = undefined;
  notice.value = undefined;
  error.value = undefined;
  if (!current) return;

  loading.value = true;
  try {
    const loaded = await mqGetEffectivePolicies(props.connectionId, current);
    policies.value = loaded;
    const hydrated = policyFormsFromEffectivePolicies(loaded, defaultMqPolicyForms());
    applyPolicyForms(hydrated);
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function applyPolicy(kind: string, action: (current: PolicyScope) => Promise<void>) {
  if (!guardWritable()) return;
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
  return applyPolicy(t("mqPolicies.retention"), (scope) => mqSetRetention(props.connectionId, scope, { ...retentionForm.value }));
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

      <div class="policy-grid">
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
          </label>
          <label>
            {{ t("mqPolicies.retentionSizeMb") }}
            <input v-model.number="retentionForm.retentionSizeInMb" type="number" :disabled="readOnly" />
          </label>
          <button @click="saveRetention" :disabled="loading || readOnly" class="btn-primary">{{ t("mqPolicies.save") }}</button>
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

.btn-primary,
.btn-sm {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
}

.btn-primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
