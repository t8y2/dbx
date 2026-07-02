<script setup lang="ts">
import { formatError } from "@/lib/errorUtils";
import { computed, ref, watch } from "vue";
import type { BacklogQuota, DispatchRate, PolicyScope, PublishRate, RetentionPolicy, SubscribeRate, TopicInfo } from "@/types/mq";
import { mqGetEffectivePolicies, mqSetBacklogQuota, mqSetDispatchRate, mqSetPublishRate, mqSetRetention, mqSetSubscribeRate } from "@/lib/api";
import { defaultMqPolicyForms, policyFormsFromEffectivePolicies } from "@/lib/mqPolicyForms";

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  topic?: TopicInfo;
  readOnly?: boolean;
  isKafkaCluster?: boolean;
  supportsRateLimits?: boolean;
  supportsBacklogQuota?: boolean;
  supportsRetention?: boolean;
}

const props = defineProps<Props>();

const policies = ref<unknown>();
const loading = ref(false);
const error = ref<string>();
const notice = ref<string>();
const readOnlyMessage = "当前连接为只读模式，不能执行写操作";
const defaultForms = defaultMqPolicyForms();

const publishForm = ref<PublishRate>({ ...defaultForms.publishForm });

const dispatchForm = ref<DispatchRate>({ ...defaultForms.dispatchForm });

const subscribeForm = ref<SubscribeRate>({ ...defaultForms.subscribeForm });

const backlogForm = ref<BacklogQuota>({ ...defaultForms.backlogForm });

const retentionForm = ref<RetentionPolicy>({ ...defaultForms.retentionForm });

const scope = computed<PolicyScope | null>(() => {
  if (!props.tenant || !props.namespace) return null;
  if (props.isKafkaCluster && !props.topic) return null;
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

const scopePlaceholderMessage = computed(() => (props.isKafkaCluster ? "请先选择主题" : "请选择命名空间或主题"));

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
    error.value = readOnlyMessage;
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
    notice.value = `${kind}已保存`;
    await loadPolicies();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function savePublishRate() {
  return applyPolicy("发布限速", (scope) => mqSetPublishRate(props.connectionId, scope, { ...publishForm.value }));
}

function saveDispatchRate() {
  return applyPolicy("派发限速", (scope) => mqSetDispatchRate(props.connectionId, scope, { ...dispatchForm.value }));
}

function saveSubscribeRate() {
  return applyPolicy("订阅限速", (scope) => mqSetSubscribeRate(props.connectionId, scope, { ...subscribeForm.value }));
}

function saveBacklogQuota() {
  return applyPolicy("积压配额", (scope) => mqSetBacklogQuota(props.connectionId, scope, { ...backlogForm.value }));
}

function saveRetention() {
  return applyPolicy("保留策略", (scope) => mqSetRetention(props.connectionId, scope, { ...retentionForm.value }));
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
        <h3>策略管理</h3>
        <div v-if="scopeLabel" class="scope-label">{{ scopeLabel }}</div>
      </div>
      <button @click="loadPolicies" :disabled="loading || !scope" class="btn-sm">
        {{ loading ? "刷新中..." : "刷新" }}
      </button>
    </div>

    <div v-if="!scope" class="panel-placeholder">{{ scopePlaceholderMessage }}</div>

    <div v-else class="policies-content">
      <div v-if="readOnly" class="readonly-hint">当前连接为只读模式，策略编辑已禁用。</div>
      <div v-if="error" class="panel-error">{{ error }}</div>
      <div v-if="notice" class="panel-notice">{{ notice }}</div>

      <div class="policy-grid">
        <section v-if="supportsRateLimits !== false" class="policy-section">
          <h4>发布限速</h4>
          <label>
            消息数 / 秒
            <input v-model.number="publishForm.publishThrottlingRateInMsg" type="number" :disabled="readOnly" />
          </label>
          <label>
            字节数 / 秒
            <input v-model.number="publishForm.publishThrottlingRateInByte" type="number" :disabled="readOnly" />
          </label>
          <button @click="savePublishRate" :disabled="loading || readOnly" class="btn-primary">保存</button>
        </section>

        <section v-if="supportsRateLimits !== false" class="policy-section">
          <h4>派发限速</h4>
          <label>
            消息数 / 周期
            <input v-model.number="dispatchForm.dispatchThrottlingRateInMsg" type="number" :disabled="readOnly" />
          </label>
          <label>
            字节数 / 周期
            <input v-model.number="dispatchForm.dispatchThrottlingRateInByte" type="number" :disabled="readOnly" />
          </label>
          <label>
            周期（秒）
            <input v-model.number="dispatchForm.ratePeriodInSecond" type="number" min="1" :disabled="readOnly" />
          </label>
          <button @click="saveDispatchRate" :disabled="loading || readOnly" class="btn-primary">保存</button>
        </section>

        <section v-if="supportsRateLimits !== false" class="policy-section">
          <h4>订阅限速</h4>
          <label>
            每消费者消息数 / 周期
            <input v-model.number="subscribeForm.subscribeThrottlingRatePerConsumer" type="number" :disabled="readOnly" />
          </label>
          <label>
            周期（秒）
            <input v-model.number="subscribeForm.ratePeriodInSecond" type="number" min="1" :disabled="readOnly" />
          </label>
          <button @click="saveSubscribeRate" :disabled="loading || readOnly" class="btn-primary">保存</button>
        </section>

        <section v-if="supportsBacklogQuota !== false" class="policy-section">
          <h4>积压配额</h4>
          <label>
            大小限制（字节）
            <input v-model.number="backlogForm.limitSize" type="number" :disabled="readOnly" />
          </label>
          <label>
            时间限制（秒）
            <input v-model.number="backlogForm.limitTime" type="number" :disabled="readOnly" />
          </label>
          <label>
            策略
            <select v-model="backlogForm.policy" :disabled="readOnly">
              <option value="producer_request_hold">producer_request_hold</option>
              <option value="producer_exception">producer_exception</option>
              <option value="consumer_backlog_eviction">consumer_backlog_eviction</option>
            </select>
          </label>
          <label>
            类型
            <input v-model="backlogForm.quotaType" type="text" :disabled="readOnly" />
          </label>
          <button @click="saveBacklogQuota" :disabled="loading || readOnly" class="btn-primary">保存</button>
        </section>

        <section v-if="supportsRetention !== false" class="policy-section">
          <h4>消息保留</h4>
          <label>
            保留时间（分钟）
            <input v-model.number="retentionForm.retentionTimeInMinutes" type="number" :disabled="readOnly" />
          </label>
          <label>
            保留大小（MB）
            <input v-model.number="retentionForm.retentionSizeInMb" type="number" :disabled="readOnly" />
          </label>
          <button @click="saveRetention" :disabled="loading || readOnly" class="btn-primary">保存</button>
        </section>
      </div>

      <section class="json-section">
        <h4>当前有效策略</h4>
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
  border-radius: 8px;
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
  border-radius: 4px;
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
  border-radius: 6px;
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
  border-radius: 6px;
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
  border-radius: 4px;
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
