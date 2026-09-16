<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { mqttPublish } from "@/lib/backend/api";
import { Button } from "@/components/ui/button";
import { PAYLOAD_ENCODINGS, PAYLOAD_ENCODING_LABELS, encodePayload, type PayloadEncoding } from "@/lib/mqtt/mqttPayloadCodec";

interface Props {
  connectionId: string;
  initialTopic?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  published: [];
}>();
const { t } = useI18n();

const topic = ref(props.initialTopic || "");
const qos = ref<0 | 1 | 2>(0);
const retain = ref(false);
const payloadText = ref("");
const encoding = ref<PayloadEncoding>("plaintext");
const loading = ref(false);
const error = ref<string | null>(null);
const success = ref(false);
const publishPanelRef = ref<HTMLElement | null>(null);
const payloadTextareaRef = ref<HTMLTextAreaElement | null>(null);
const payloadHeight = ref(80);
const resizing = ref(false);

const MQTT_PAYLOAD_MIN_HEIGHT_PX = 60;
const MQTT_PAYLOAD_MAX_PANEL_RATIO = 0.5;
const MQTT_PAYLOAD_KEYBOARD_STEP_PX = 10;
const MQTT_PAYLOAD_HEIGHT_STORAGE_KEY = "dbx-mqtt-payload-height";
let resizeStartY = 0;
let resizeStartHeight = 0;
let panelResizeObserver: ResizeObserver | undefined;

const qosLabels = ["QoS 0", "QoS 1", "QoS 2"];
const qosHints = computed(() => [t("connection.mqttQosAtMostOnce"), t("connection.mqttQosAtLeastOnce"), t("connection.mqttQosExactlyOnce")]);

/* 根据编码格式调整输入提示和占位符 */
const payloadPlaceholder = computed(() => {
  switch (encoding.value) {
    case "json":
      return t("connection.mqttPayloadPlaceholderJson", { example: '{"key": "value"}' });
    case "base64":
      return t("connection.mqttPayloadPlaceholderBase64");
    case "hex":
      return t("connection.mqttPayloadPlaceholderHex");
    case "cbor":
    case "msgpack":
      return t("connection.mqttPayloadPlaceholderStructured", { encoding: encoding.value.toUpperCase() });
    default:
      return t("connection.mqttPayloadPlaceholderPlaintext");
  }
});

/* 监听 topic prop 变化 */
watch(
  () => props.initialTopic,
  (val) => {
    if (val !== undefined && val !== topic.value) {
      topic.value = val;
    }
  },
);

/** 计算消息输入框允许使用的最大高度，避免挤占全部消息列表区域 */
function maxPayloadHeight() {
  const containerHeight = publishPanelRef.value?.parentElement?.clientHeight || window.innerHeight || 0;
  const panelHeight = publishPanelRef.value?.offsetHeight || 0;
  const currentTextareaHeight = payloadTextareaRef.value?.offsetHeight || payloadHeight.value;
  const panelChromeHeight = Math.max(0, panelHeight - currentTextareaHeight);
  return Math.max(MQTT_PAYLOAD_MIN_HEIGHT_PX, Math.floor(containerHeight * MQTT_PAYLOAD_MAX_PANEL_RATIO - panelChromeHeight));
}

/** 将消息输入框高度限制在可用区域内 */
function clampPayloadHeight(height: number) {
  return Math.max(MQTT_PAYLOAD_MIN_HEIGHT_PX, Math.min(maxPayloadHeight(), Math.round(height)));
}

function persistPayloadHeight(height: number) {
  payloadHeight.value = clampPayloadHeight(height);
  localStorage.setItem(MQTT_PAYLOAD_HEIGHT_STORAGE_KEY, payloadHeight.value.toString());
}

/** 容器尺寸变化时同步收缩输入框，保证消息列表仍可见 */
function handlePanelResize() {
  payloadHeight.value = clampPayloadHeight(payloadHeight.value);
}

/** 开始拖动消息输入框顶部的高度调节条 */
function startResize(event: MouseEvent) {
  event.preventDefault();
  resizing.value = true;
  resizeStartY = event.clientY;
  resizeStartHeight = payloadHeight.value;

  document.addEventListener("mousemove", handleResize);
  document.addEventListener("mouseup", stopResize);
  document.body.style.userSelect = "none";
  document.body.style.cursor = "ns-resize";
}

/** 根据向上拖动的距离实时调整消息输入框高度 */
function handleResize(event: MouseEvent) {
  if (!resizing.value) return;
  payloadHeight.value = clampPayloadHeight(resizeStartHeight + resizeStartY - event.clientY);
}

function handleResizeKeydown(event: KeyboardEvent) {
  const direction = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
  if (direction === 0) return;
  event.preventDefault();
  persistPayloadHeight(payloadHeight.value + direction * MQTT_PAYLOAD_KEYBOARD_STEP_PX);
}

/** 结束拖动并记住用户设置的高度 */
function stopResize() {
  if (!resizing.value) return;
  resizing.value = false;
  document.removeEventListener("mousemove", handleResize);
  document.removeEventListener("mouseup", stopResize);
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
  persistPayloadHeight(payloadHeight.value);
}

onMounted(() => {
  const savedHeight = Number.parseInt(localStorage.getItem(MQTT_PAYLOAD_HEIGHT_STORAGE_KEY) ?? "", 10);
  if (Number.isFinite(savedHeight)) payloadHeight.value = clampPayloadHeight(savedHeight);

  window.addEventListener("resize", handlePanelResize);
  if (typeof ResizeObserver !== "undefined" && publishPanelRef.value?.parentElement) {
    panelResizeObserver = new ResizeObserver(handlePanelResize);
    panelResizeObserver.observe(publishPanelRef.value.parentElement);
  }
});

onUnmounted(() => {
  document.removeEventListener("mousemove", handleResize);
  document.removeEventListener("mouseup", stopResize);
  window.removeEventListener("resize", handlePanelResize);
  panelResizeObserver?.disconnect();
  if (resizing.value) {
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }
});

async function publish() {
  const publishTopic = topic.value.trim();
  if (!publishTopic) {
    error.value = t("connection.mqttPublishTopicRequired");
    return;
  }
  if (publishTopic.includes("#") || publishTopic.includes("+")) {
    error.value = t("connection.mqttPublishTopicWildcard");
    return;
  }
  loading.value = true;
  error.value = null;
  success.value = false;
  try {
    const payloadBase64 = encodePayload(payloadText.value, encoding.value);
    await mqttPublish(props.connectionId, {
      topic: publishTopic,
      payloadBase64,
      payloadText: encoding.value === "plaintext" ? payloadText.value : null,
      qos: qos.value === 0 ? "atmostonce" : qos.value === 1 ? "atleastonce" : "exactlyonce",
      retain: retain.value,
    });
    success.value = true;
    emit("published");
    /* 成功后保留表单内容便于连续测试，1.5 秒后清除成功提示 */
    setTimeout(() => {
      success.value = false;
    }, 1500);
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

function clearForm() {
  topic.value = "";
  payloadText.value = "";
  qos.value = 0;
  retain.value = false;
  encoding.value = "plaintext";
  error.value = null;
  success.value = false;
}
</script>

<template>
  <div ref="publishPanelRef" class="publish-panel">
    <div
      class="payload-resize-handle"
      role="separator"
      tabindex="0"
      aria-orientation="horizontal"
      :aria-label="t('connection.mqttResizePayload')"
      :aria-valuemin="MQTT_PAYLOAD_MIN_HEIGHT_PX"
      :aria-valuemax="maxPayloadHeight()"
      :aria-valuenow="payloadHeight"
      :title="t('connection.mqttResizePayload')"
      @mousedown="startResize"
      @keydown="handleResizeKeydown"
    />
    <div class="panel-header">
      <span class="panel-title">{{ t("connection.mqttPublish") }}</span>
      <Button size="sm" variant="ghost" class="h-6 text-xs" @click="clearForm">{{ t("common.clear") }}</Button>
    </div>

    <!-- Topic + QoS + Retain 行 -->
    <div class="form-row">
      <div class="form-group flex-1">
        <label class="form-label">{{ t("connection.mqttTopic") }}</label>
        <input v-model="topic" class="form-input font-mono text-xs" :placeholder="t('connection.mqttTopicExample')" @keydown.enter="publish()" />
      </div>
    </div>

    <div class="form-row form-row-wrap">
      <!-- QoS -->
      <div class="form-group">
        <label class="form-label">QoS</label>
        <div class="segmented-control">
          <button v-for="(label, i) in qosLabels" :key="i" class="segment-item" :class="{ active: qos === i }" :title="qosHints[i]" @click="qos = i as 0 | 1 | 2">
            {{ label }}
          </button>
        </div>
      </div>

      <!-- Retain -->
      <div class="form-group form-group-check">
        <label class="form-label">&nbsp;</label>
        <label class="checkbox-label">
          <input type="checkbox" :checked="retain" @change="retain = !retain" class="form-checkbox" />
          <span class="text-xs">{{ t("connection.mqttRetainMessage") }}</span>
        </label>
      </div>

      <!-- 编码格式 -->
      <div class="form-group">
        <label class="form-label">{{ t("connection.mqttPayloadEncoding") }}</label>
        <select v-model="encoding" class="form-select text-xs">
          <option v-for="enc in PAYLOAD_ENCODINGS" :key="enc" :value="enc">
            {{ PAYLOAD_ENCODING_LABELS[enc] }}
          </option>
        </select>
      </div>
    </div>

    <!-- Payload -->
    <div class="form-group flex-1 flex flex-col min-h-0">
      <label class="form-label">{{ t("connection.mqttPayload") }}</label>
      <textarea ref="payloadTextareaRef" v-model="payloadText" class="form-textarea font-mono text-xs" :style="{ height: `${payloadHeight}px`, maxHeight: `${maxPayloadHeight()}px` }" :placeholder="payloadPlaceholder" @keydown.ctrl.enter="publish()" />
      <span class="form-hint">{{ t("connection.mqttPublishShortcut") }}</span>
    </div>

    <!-- 状态提示 -->
    <div v-if="error" class="publish-error">{{ error }}</div>
    <div v-if="success" class="publish-success">✓ {{ t("connection.mqttPublishSuccess") }}</div>

    <!-- 操作按钮 -->
    <div class="form-actions">
      <Button size="sm" class="publish-btn" :disabled="loading || !topic.trim()" @click="publish">
        {{ loading ? t("connection.mqttPublishing") : t("connection.mqttPublish") }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.publish-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--color-border);
  background: var(--color-background);
}

.payload-resize-handle {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  z-index: 1;
  height: 9px;
  cursor: ns-resize;
}

.payload-resize-handle::before {
  content: "";
  position: absolute;
  top: 3px;
  left: 0;
  right: 0;
  height: 1px;
  background-color: var(--color-border);
  transition: background-color 0.15s ease;
}

.payload-resize-handle:hover::before,
.payload-resize-handle:focus-visible::before {
  background-color: color-mix(in srgb, var(--color-text) 20%, transparent);
}

.payload-resize-handle:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  letter-spacing: 0.5px;
}

.form-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}

.form-row-wrap {
  flex-wrap: wrap;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.form-group-check {
  justify-content: flex-end;
}

.form-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.form-input {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
  outline: none;
  box-sizing: border-box;
}

.form-input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 1px var(--color-primary-alpha);
}

.form-textarea {
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
  outline: none;
  resize: none;
  min-height: 60px;
  box-sizing: border-box;
  line-height: 1.4;
}

.form-textarea:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 1px var(--color-primary-alpha);
}

.form-select {
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
  font-size: 12px;
  outline: none;
  cursor: pointer;
}

.form-select:focus {
  border-color: var(--color-primary);
}

.form-checkbox {
  width: 14px;
  height: 14px;
  cursor: pointer;
  accent-color: var(--color-primary);
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
}

.form-hint {
  font-size: 10px;
  color: var(--color-text-tertiary);
  margin-top: 2px;
}

.segmented-control {
  display: flex;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  overflow: hidden;
}

.segment-item {
  padding: 2px 10px;
  font-size: 11px;
  font-weight: 500;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  border-right: 1px solid var(--color-border);
  white-space: nowrap;
}

.segment-item:last-child {
  border-right: none;
}

.segment-item:hover {
  background: var(--color-background-secondary);
}

.segment-item.active {
  background: var(--color-primary);
  color: white;
}

.publish-error {
  font-size: 12px;
  color: var(--color-error);
  padding: 4px 8px;
  background: var(--color-error-bg);
  border-radius: 4px;
}

.publish-success {
  font-size: 12px;
  color: var(--color-success);
  padding: 4px 8px;
  background: color-mix(in srgb, var(--color-success) 12%, transparent);
  border-radius: 4px;
  font-weight: 500;
}

.form-actions {
  display: flex;
  gap: 8px;
}

.publish-btn {
  flex: 1;
  height: 30px;
  font-size: 13px;
  font-weight: 500;
}
</style>
