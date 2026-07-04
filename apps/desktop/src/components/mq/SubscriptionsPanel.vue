<script setup lang="ts">
import { formatError } from "@/lib/backend/errorUtils";
import { ref, watch } from "vue";
import type { TopicRef, TopicInfo, SubscriptionInfo, ResetPosition, SkipCount, PeekedMessage } from "@/types/mq";
import { mqListSubscriptions, mqCreateSubscription, mqDeleteSubscription, mqResetCursor, mqSkipMessages, mqClearBacklog, mqPeekMessages, mqExpireMessages } from "@/lib/backend/api";

interface Props {
  connectionId: string;
  topic?: TopicInfo;
  tenant?: string;
  namespace?: string;
  readOnly?: boolean;
  supportsCreateSubscription?: boolean;
  supportsResetCursor?: boolean;
  supportsSkipMessages?: boolean;
  supportsClearBacklog?: boolean;
  supportsPeekMessages?: boolean;
  supportsExpireMessages?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  subscriptionSelected: [subscription: string];
}>();

const subscriptions = ref<SubscriptionInfo[]>([]);
const loading = ref(false);
const error = ref<string>();
const showCreateDialog = ref(false);
const showResetDialog = ref(false);
const showSkipDialog = ref(false);
const showPeekDialog = ref(false);
const showExpireDialog = ref(false);
const selectedSub = ref<SubscriptionInfo>();
const peekedMessages = ref<PeekedMessage[]>([]);
const peekLoading = ref(false);
const peekCount = ref(5);

const formData = ref({
  subName: "",
  startFrom: "latest" as "earliest" | "latest",
});

const resetFormData = ref({
  position: "latest" as "earliest" | "latest" | "timestamp",
  timestampMs: Date.now(),
});

const skipFormData = ref({
  mode: "count" as "count" | "all",
  count: 100,
});

const expireSeconds = ref(3600);
const readOnlyMessage = "当前连接为只读模式，不能执行写操作";

function guardWritable() {
  if (props.readOnly) {
    error.value = readOnlyMessage;
    return false;
  }
  return true;
}

function getTopicRef(): TopicRef | null {
  if (!props.topic || !props.tenant || !props.namespace) return null;
  return {
    tenant: props.tenant,
    namespace: props.namespace,
    topic: props.topic.shortName,
    persistent: props.topic.persistent,
    partitioned: props.topic.partitioned,
  };
}

async function loadSubscriptions() {
  const topicRef = getTopicRef();
  if (!topicRef) {
    subscriptions.value = [];
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    subscriptions.value = await mqListSubscriptions(props.connectionId, topicRef);
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function openCreateDialog() {
  if (!guardWritable()) return;
  formData.value = {
    subName: "",
    startFrom: "latest",
  };
  showCreateDialog.value = true;
}

function openResetDialog(sub: SubscriptionInfo) {
  if (!guardWritable()) return;
  selectedSub.value = sub;
  resetFormData.value = {
    position: "latest",
    timestampMs: Date.now(),
  };
  showResetDialog.value = true;
}

function openSkipDialog(sub: SubscriptionInfo) {
  if (!guardWritable()) return;
  selectedSub.value = sub;
  skipFormData.value = {
    mode: "count",
    count: 100,
  };
  showSkipDialog.value = true;
}

async function openPeekDialog(sub: SubscriptionInfo) {
  selectedSub.value = sub;
  peekCount.value = 5;
  peekedMessages.value = [];
  showPeekDialog.value = true;
  await handlePeekMessages();
}

function openExpireDialog(sub: SubscriptionInfo) {
  if (!guardWritable()) return;
  selectedSub.value = sub;
  expireSeconds.value = 3600;
  showExpireDialog.value = true;
}

function selectSubscription(sub: SubscriptionInfo) {
  selectedSub.value = sub;
  emit("subscriptionSelected", sub.name);
}

async function handleCreate() {
  if (!guardWritable()) return;
  const topicRef = getTopicRef();
  if (!formData.value.subName.trim() || !topicRef) {
    error.value = "Subscription name is required";
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    const pos: ResetPosition = { kind: formData.value.startFrom };
    await mqCreateSubscription(props.connectionId, topicRef, formData.value.subName, pos);
    showCreateDialog.value = false;
    await loadSubscriptions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleDelete(sub: SubscriptionInfo) {
  if (!guardWritable()) return;
  if (!confirm(`确定要删除订阅 "${sub.name}" 吗？此操作不可逆。`)) return;
  const topicRef = getTopicRef();
  if (!topicRef) return;
  loading.value = true;
  error.value = undefined;
  try {
    await mqDeleteSubscription(props.connectionId, topicRef, sub.name, false);
    await loadSubscriptions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleResetCursor() {
  if (!guardWritable()) return;
  const topicRef = getTopicRef();
  if (!selectedSub.value || !topicRef) return;
  loading.value = true;
  error.value = undefined;
  try {
    let pos: ResetPosition;
    if (resetFormData.value.position === "timestamp") {
      pos = { kind: "timestamp", timestampMs: resetFormData.value.timestampMs };
    } else {
      pos = { kind: resetFormData.value.position };
    }
    await mqResetCursor(props.connectionId, topicRef, selectedSub.value.name, pos);
    showResetDialog.value = false;
    await loadSubscriptions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleSkipMessages() {
  if (!guardWritable()) return;
  const topicRef = getTopicRef();
  if (!selectedSub.value || !topicRef) return;
  loading.value = true;
  error.value = undefined;
  try {
    const count: SkipCount = skipFormData.value.mode === "all" ? { kind: "all" } : { kind: "count", count: skipFormData.value.count };
    await mqSkipMessages(props.connectionId, topicRef, selectedSub.value.name, count);
    showSkipDialog.value = false;
    await loadSubscriptions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleClearBacklog(sub: SubscriptionInfo) {
  if (!guardWritable()) return;
  if (!confirm(`确定要清空订阅 "${sub.name}" 的所有积压消息吗？`)) return;
  const topicRef = getTopicRef();
  if (!topicRef) return;
  loading.value = true;
  error.value = undefined;
  try {
    await mqClearBacklog(props.connectionId, topicRef, sub.name);
    await loadSubscriptions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handlePeekMessages() {
  const topicRef = getTopicRef();
  if (!selectedSub.value || !topicRef) return;
  const count = Math.max(1, Math.min(100, Number(peekCount.value) || 1));
  peekCount.value = count;
  peekLoading.value = true;
  error.value = undefined;
  try {
    peekedMessages.value = await mqPeekMessages(props.connectionId, topicRef, selectedSub.value.name, count);
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    peekLoading.value = false;
  }
}

async function handleExpireMessages() {
  if (!guardWritable()) return;
  const topicRef = getTopicRef();
  if (!selectedSub.value || !topicRef) return;
  loading.value = true;
  error.value = undefined;
  try {
    await mqExpireMessages(props.connectionId, topicRef, selectedSub.value.name, expireSeconds.value);
    showExpireDialog.value = false;
    await loadSubscriptions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.topic,
  () => {
    selectedSub.value = undefined;
    loadSubscriptions();
  },
  { immediate: true },
);
</script>

<template>
  <div class="subscriptions-panel">
    <div class="panel-toolbar">
      <h3>订阅管理</h3>
      <button v-if="supportsCreateSubscription !== false" @click="openCreateDialog" :disabled="loading || readOnly || !topic" class="btn-primary">+ 创建订阅</button>
    </div>

    <div v-if="!topic" class="panel-placeholder">请先选择一个主题</div>

    <div v-else-if="error" class="panel-error">{{ error }}</div>

    <div v-else-if="loading && !subscriptions.length" class="panel-loading">加载中...</div>

    <div v-else-if="!subscriptions.length" class="panel-placeholder">该主题暂无订阅</div>

    <div v-else class="subscriptions-table">
      <table>
        <thead>
          <tr>
            <th>订阅名称</th>
            <th>类型</th>
            <th>积压消息</th>
            <th>消费速率</th>
            <th>消费者</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="sub in subscriptions" :key="sub.name" :class="{ selected: selectedSub?.name === sub.name }" @click="selectSubscription(sub)">
            <td class="sub-name">{{ sub.name }}</td>
            <td>
              <span class="badge">{{ sub.subType }}</span>
            </td>
            <td>
              <span :class="{ 'text-warning': sub.msgBacklog > 1000 }">
                {{ sub.msgBacklog.toLocaleString() }}
              </span>
            </td>
            <td>{{ sub.msgRateOut.toFixed(2) }} msg/s</td>
            <td>{{ sub.consumers.length }} 个</td>
            <td class="actions">
              <button v-if="supportsResetCursor !== false" @click.stop="openResetDialog(sub)" :disabled="readOnly" class="btn-sm">重置游标</button>
              <button v-if="supportsSkipMessages !== false" @click.stop="openSkipDialog(sub)" :disabled="readOnly" class="btn-sm">跳过消息</button>
              <button v-if="supportsClearBacklog !== false" @click.stop="handleClearBacklog(sub)" :disabled="readOnly" class="btn-sm">清空积压</button>
              <button v-if="supportsPeekMessages" @click.stop="openPeekDialog(sub)" class="btn-sm">Peek</button>
              <button v-if="supportsExpireMessages !== false" @click.stop="openExpireDialog(sub)" :disabled="readOnly" class="btn-sm">过期消息</button>
              <button @click.stop="handleDelete(sub)" :disabled="readOnly" class="btn-sm btn-danger">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create Dialog -->
    <div v-if="showCreateDialog" class="dialog-overlay" @click="showCreateDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>创建订阅</h3>
          <button @click="showCreateDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>主题</label>
            <input type="text" :value="topic?.shortName" disabled />
          </div>
          <div class="form-group">
            <label>订阅名称*</label>
            <input v-model="formData.subName" type="text" placeholder="例如: my-subscription" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label>起始位置</label>
            <div class="radio-group">
              <label class="radio-label">
                <input type="radio" v-model="formData.startFrom" value="earliest" :disabled="readOnly" />
                从最早消息开始（Earliest）
              </label>
              <label class="radio-label">
                <input type="radio" v-model="formData.startFrom" value="latest" :disabled="readOnly" />
                从最新消息开始（Latest）
              </label>
            </div>
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showCreateDialog = false" class="btn-secondary">取消</button>
          <button @click="handleCreate" :disabled="loading || readOnly" class="btn-primary">创建</button>
        </div>
      </div>
    </div>

    <!-- Reset Cursor Dialog -->
    <div v-if="showResetDialog" class="dialog-overlay" @click="showResetDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>重置游标: {{ selectedSub?.name }}</h3>
          <button @click="showResetDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>重置到</label>
            <div class="radio-group">
              <label class="radio-label">
                <input type="radio" v-model="resetFormData.position" value="earliest" :disabled="readOnly" />
                最早消息（Earliest）
              </label>
              <label class="radio-label">
                <input type="radio" v-model="resetFormData.position" value="latest" :disabled="readOnly" />
                最新消息（Latest）
              </label>
              <label class="radio-label">
                <input type="radio" v-model="resetFormData.position" value="timestamp" :disabled="readOnly" />
                指定时间戳
              </label>
            </div>
          </div>
          <div v-if="resetFormData.position === 'timestamp'" class="form-group">
            <label>时间戳（毫秒）</label>
            <input v-model.number="resetFormData.timestampMs" type="number" :disabled="readOnly" />
            <div class="form-hint">当前时间: {{ new Date(resetFormData.timestampMs).toLocaleString() }}</div>
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showResetDialog = false" class="btn-secondary">取消</button>
          <button @click="handleResetCursor" :disabled="loading || readOnly" class="btn-primary">重置</button>
        </div>
      </div>
    </div>

    <!-- Skip Messages Dialog -->
    <div v-if="showSkipDialog" class="dialog-overlay" @click="showSkipDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>跳过消息: {{ selectedSub?.name }}</h3>
          <button @click="showSkipDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>跳过模式</label>
            <div class="radio-group">
              <label class="radio-label">
                <input type="radio" v-model="skipFormData.mode" value="count" :disabled="readOnly" />
                跳过指定数量
              </label>
              <label class="radio-label">
                <input type="radio" v-model="skipFormData.mode" value="all" :disabled="readOnly" />
                跳过全部积压
              </label>
            </div>
          </div>
          <div v-if="skipFormData.mode === 'count'" class="form-group">
            <label>跳过数量</label>
            <input v-model.number="skipFormData.count" type="number" min="1" :disabled="readOnly" />
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showSkipDialog = false" class="btn-secondary">取消</button>
          <button @click="handleSkipMessages" :disabled="loading || readOnly" class="btn-primary">跳过</button>
        </div>
      </div>
    </div>

    <!-- Peek Messages Dialog -->
    <div v-if="showPeekDialog" class="dialog-overlay" @click="showPeekDialog = false">
      <div class="dialog dialog-wide" @click.stop>
        <div class="dialog-header">
          <h3>Peek 消息: {{ selectedSub?.name }}</h3>
          <button @click="showPeekDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="peek-toolbar">
            <label>
              数量
              <input v-model.number="peekCount" type="number" min="1" max="100" />
            </label>
            <button @click="handlePeekMessages" :disabled="peekLoading" class="btn-sm">
              {{ peekLoading ? "加载中..." : "刷新" }}
            </button>
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
          <div v-else-if="peekLoading && !peekedMessages.length" class="panel-loading">加载中...</div>
          <div v-else-if="!peekedMessages.length" class="panel-placeholder">没有可查看的消息</div>
          <div v-else class="peek-results">
            <div v-for="message in peekedMessages" :key="message.position" class="peek-message">
              <div class="peek-message-header">
                <span>#{{ message.position }}</span>
                <span v-if="message.messageId">{{ message.messageId }}</span>
                <span v-if="message.key">key={{ message.key }}</span>
              </div>
              <div v-if="Object.keys(message.properties).length" class="peek-properties">
                <span v-for="(value, key) in message.properties" :key="key">{{ key }}={{ value }}</span>
              </div>
              <pre class="peek-payload">{{ message.payloadText ?? message.payloadBase64 }}</pre>
            </div>
          </div>
        </div>
        <div class="dialog-footer">
          <button @click="showPeekDialog = false" class="btn-secondary">关闭</button>
        </div>
      </div>
    </div>

    <!-- Expire Messages Dialog -->
    <div v-if="showExpireDialog" class="dialog-overlay" @click="showExpireDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>过期消息: {{ selectedSub?.name }}</h3>
          <button @click="showExpireDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>过期时间（秒）</label>
            <input v-model.number="expireSeconds" type="number" min="1" :disabled="readOnly" />
            <div class="form-hint">将删除所有早于 {{ expireSeconds }} 秒的消息</div>
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showExpireDialog = false" class="btn-secondary">取消</button>
          <button @click="handleExpireMessages" :disabled="loading || readOnly" class="btn-primary">过期</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.subscriptions-panel {
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

.panel-placeholder,
.panel-error,
.panel-loading {
  padding: 24px;
  text-align: center;
  color: var(--color-text-secondary);
}

.panel-error {
  color: var(--color-error);
}

.subscriptions-table {
  flex: 1;
  overflow: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
}

thead {
  position: sticky;
  top: 0;
  background: var(--color-background-secondary);
  z-index: 1;
}

th {
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text-secondary);
  border-bottom: 1px solid var(--color-border);
}

tbody tr {
  cursor: pointer;
  transition: background 0.2s;
}

tbody tr:hover {
  background: var(--color-hover);
}

tbody tr.selected {
  background: var(--color-primary-alpha);
}

td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border-light);
}

.sub-name {
  font-weight: 500;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
}

.text-warning {
  color: var(--color-warning);
  font-weight: 500;
}

.actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.btn-primary,
.btn-secondary,
.btn-sm,
.btn-danger {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
  white-space: nowrap;
}

.btn-primary {
  background: var(--color-primary);
  color: white;
  border-color: var(--color-primary);
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-danger {
  color: var(--color-error);
  border-color: var(--color-error);
}

.btn-danger:hover:not(:disabled) {
  background: var(--color-error);
  color: white;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Dialog styles */
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--color-background);
  border-radius: 8px;
  width: 90%;
  max-width: 500px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.dialog-wide {
  max-width: 760px;
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.dialog-header h3 {
  margin: 0;
  font-size: 18px;
}

.btn-close {
  border: none;
  background: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--color-text-secondary);
  padding: 0;
  line-height: 1;
}

.dialog-body {
  padding: 20px;
  max-height: 60vh;
  overflow-y: auto;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  font-size: 13px;
}

.form-group input[type="text"],
.form-group input[type="number"] {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 14px;
  box-sizing: border-box;
}

.form-group input:disabled {
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  transition: background 0.2s;
}

.radio-label:hover {
  background: var(--color-hover);
}

.radio-label input[type="radio"] {
  cursor: pointer;
}

.form-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.form-error {
  margin-top: 12px;
  padding: 8px 12px;
  background: var(--color-error-bg);
  color: var(--color-error);
  border-radius: 4px;
  font-size: 13px;
}

.peek-toolbar {
  display: flex;
  align-items: end;
  gap: 12px;
  margin-bottom: 12px;
}

.peek-toolbar label {
  display: grid;
  gap: 6px;
  font-size: 13px;
}

.peek-toolbar input {
  width: 96px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
}

.peek-results {
  display: grid;
  gap: 12px;
}

.peek-message {
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background-secondary);
  overflow: hidden;
}

.peek-message-header,
.peek-properties {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.peek-message-header {
  border-bottom: 1px solid var(--color-border-light);
  font-weight: 600;
}

.peek-properties {
  border-bottom: 1px solid var(--color-border-light);
}

.peek-payload {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  padding: 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text);
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--color-border);
}
</style>
