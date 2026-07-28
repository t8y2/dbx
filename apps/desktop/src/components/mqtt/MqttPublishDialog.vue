<script setup lang="ts">
import { ref, watch } from "vue";
import { mqttPublish } from "@/lib/backend/api";
import { Button } from "@/components/ui/button";
import {
  PAYLOAD_ENCODINGS,
  PAYLOAD_ENCODING_LABELS,
  encodePayload,
  type PayloadEncoding,
} from "@/lib/mqtt/mqttPayloadCodec";

interface Props {
  connectionId: string;
  initialTopic?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  published: [];
}>();

const topic = ref(props.initialTopic || "");
const qos = ref<0 | 1 | 2>(0);
const retain = ref(false);
const payloadText = ref("");
const encoding = ref<PayloadEncoding>("plaintext");
const loading = ref(false);
const error = ref<string | null>(null);
const success = ref(false);

const qosLabels = ["QoS 0", "QoS 1", "QoS 2"];
const qosHints = ["最多一次", "至少一次", "精确一次"];

/* 根据编码格式调整输入提示和占位符 */
const payloadPlaceholder = ref("输入消息内容...");
watch(encoding, (enc) => {
  switch (enc) {
    case "json":
      payloadPlaceholder.value = '输入 JSON，例如 {"key": "value"}';
      break;
    case "base64":
      payloadPlaceholder.value = "输入 Base64 编码的数据";
      break;
    case "hex":
      payloadPlaceholder.value = "输入十六进制数据，例如 48 65 6C 6C 6F";
      break;
    case "cbor":
    case "msgpack":
      payloadPlaceholder.value = '输入 JSON 对象，发送时将自动编码为 ' + enc.toUpperCase();
      break;
    default:
      payloadPlaceholder.value = "输入消息内容...";
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

async function publish() {
  if (!topic.value.trim()) {
    error.value = "主题不能为空";
    return;
  }
  loading.value = true;
  error.value = null;
  success.value = false;
  try {
    const payloadBase64 = encodePayload(payloadText.value, encoding.value);
    await mqttPublish(props.connectionId, {
      topic: topic.value.trim(),
      payloadBase64,
      payloadText: encoding.value === "plaintext" || encoding.value === "json" ? payloadText.value : null,
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
  <div class="publish-panel">
    <div class="panel-header">
      <span class="panel-title">发布消息</span>
      <Button size="sm" variant="ghost" class="h-6 text-xs" @click="clearForm">清空</Button>
    </div>

    <!-- Topic + QoS + Retain 行 -->
    <div class="form-row">
      <div class="form-group flex-1">
        <label class="form-label">主题 (Topic)</label>
        <input
          v-model="topic"
          class="form-input font-mono text-xs"
          placeholder="例如 sensors/temperature"
          @keydown.enter="publish()"
        />
      </div>
    </div>

    <div class="form-row form-row-wrap">
      <!-- QoS -->
      <div class="form-group">
        <label class="form-label">QoS</label>
        <div class="segmented-control">
          <button
            v-for="(label, i) in qosLabels"
            :key="i"
            class="segment-item"
            :class="{ active: qos === i }"
            :title="qosHints[i]"
            @click="qos = i as 0 | 1 | 2"
          >
            {{ label }}
          </button>
        </div>
      </div>

      <!-- Retain -->
      <div class="form-group form-group-check">
        <label class="form-label">&nbsp;</label>
        <label class="checkbox-label">
          <input type="checkbox" :checked="retain" @change="retain = !retain" class="form-checkbox" />
          <span class="text-xs">保留消息</span>
        </label>
      </div>

      <!-- 编码格式 -->
      <div class="form-group">
        <label class="form-label">编码格式</label>
        <select v-model="encoding" class="form-select text-xs">
          <option v-for="enc in PAYLOAD_ENCODINGS" :key="enc" :value="enc">
            {{ PAYLOAD_ENCODING_LABELS[enc] }}
          </option>
        </select>
      </div>
    </div>

    <!-- Payload -->
    <div class="form-group flex-1 flex flex-col min-h-0">
      <label class="form-label">消息内容 (Payload)</label>
      <textarea
        v-model="payloadText"
        class="form-textarea flex-1 font-mono text-xs"
        :placeholder="payloadPlaceholder"
        rows="4"
        @keydown.ctrl.enter="publish()"
      />
      <span class="form-hint">Ctrl+Enter 发送</span>
    </div>

    <!-- 状态提示 -->
    <div v-if="error" class="publish-error">{{ error }}</div>
    <div v-if="success" class="publish-success">✓ 消息已发送</div>

    <!-- 操作按钮 -->
    <div class="form-actions">
      <Button size="sm" class="publish-btn" :disabled="loading || !topic.trim()" @click="publish">
        {{ loading ? "发送中..." : "发送消息" }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.publish-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--color-border);
  background: var(--color-background);
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
  resize: vertical;
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
