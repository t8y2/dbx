<script setup lang="ts">
import { formatError } from "@/lib/backend/errorUtils";
import { computed, ref } from "vue";
import type { MqRawResponse, TopicInfo } from "@/types/mq";
import { mqRawRequest } from "@/lib/backend/api";
import { safeJsonFormat } from "@/lib/common/safeJsonFormat";

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  topic?: TopicInfo;
  readOnly?: boolean;
}

const props = defineProps<Props>();

const methods = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];
type RawApiPreset = {
  label: string;
  description: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  unavailable?: boolean;
};

const method = ref("GET");
const path = ref("/admin/v2/");
const queryText = ref("");
const bodyText = ref("");
const response = ref<MqRawResponse>();
const loading = ref(false);
const error = ref<string>();
const presetsCollapsed = ref(true);
const readOnlyMessage = "当前连接为只读模式，不能执行写操作";

const isReadMethod = computed(() => method.value === "GET" || method.value === "HEAD" || method.value === "OPTIONS");
const requestDisabled = computed(() => loading.value || (props.readOnly && !isReadMethod.value));
const formattedBody = computed(() => JSON.stringify(response.value?.body ?? null, null, 2));
const bodyTextareaRows = computed(() => Math.min(24, Math.max(8, bodyText.value.split(/\r?\n/).length + 1)));
const topicDomain = computed(() => (props.topic?.persistent === false ? "non-persistent" : "persistent"));
const topicPath = computed(() => {
  if (!props.tenant || !props.namespace || !props.topic) return undefined;
  return `/admin/v2/${topicDomain.value}/${pathSegment(props.tenant)}/${pathSegment(props.namespace)}/${pathSegment(props.topic.shortName)}`;
});
const namespacePath = computed(() => {
  if (!props.tenant || !props.namespace) return undefined;
  return `/admin/v2/namespaces/${pathSegment(props.tenant)}/${pathSegment(props.namespace)}`;
});
const tenantPath = computed(() => {
  if (!props.tenant) return undefined;
  return `/admin/v2/tenants/${pathSegment(props.tenant)}`;
});
const presets = computed<RawApiPreset[]>(() => {
  const tenant = tenantPath.value;
  const namespace = namespacePath.value;
  const topic = topicPath.value;
  return [
    {
      label: "Broker 版本",
      description: "查看 broker 暴露的版本字符串",
      method: "GET",
      path: "/admin/v2/brokers/version",
    },
    {
      label: "集群列表",
      description: "列出 Pulsar 已配置的 clusters",
      method: "GET",
      path: "/admin/v2/clusters",
    },
    {
      label: "租户详情",
      description: "查看 adminRoles / allowedClusters",
      method: "GET",
      path: tenant ?? "/admin/v2/tenants/{tenant}",
      unavailable: !tenant,
    },
    {
      label: "命名空间策略",
      description: "查看 namespace policies 原始结构",
      method: "GET",
      path: namespace ?? "/admin/v2/namespaces/{tenant}/{namespace}",
      unavailable: !namespace,
    },
    {
      label: "Bundle 列表",
      description: "查看 namespace bundle 分布",
      method: "GET",
      path: namespace ? `${namespace}/bundles` : "/admin/v2/namespaces/{tenant}/{namespace}/bundles",
      unavailable: !namespace,
    },
    {
      label: "Topic 内部状态",
      description: "查看 ledger / cursor / backlog 细节",
      method: "GET",
      path: topic ? `${topic}/internalStats` : "/admin/v2/persistent/{tenant}/{namespace}/{topic}/internalStats",
      unavailable: !topic,
    },
    {
      label: "分区明细指标",
      description: "按分区返回速率、生产者和消费者指标",
      method: "GET",
      path: topic ? `${topic}/partitioned-stats` : "/admin/v2/persistent/{tenant}/{namespace}/{topic}/partitioned-stats",
      query: { perPartition: "true" },
      unavailable: !topic,
    },
    {
      label: "Schema 最新版本",
      description: "查看 topic 当前 schema 定义",
      method: "GET",
      path: props.tenant && props.namespace && props.topic ? `/admin/v2/schemas/${pathSegment(props.tenant)}/${pathSegment(props.namespace)}/${pathSegment(props.topic.shortName)}/schema` : "/admin/v2/schemas/{tenant}/{namespace}/{topic}/schema",
      unavailable: !topic,
    },
  ];
});

function pathSegment(value: string) {
  return encodeURIComponent(value);
}

function parseQuery() {
  const query: Record<string, string> = {};
  for (const rawLine of queryText.value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator === -1) {
      query[line] = "";
      continue;
    }
    query[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return Object.keys(query).length ? query : undefined;
}

function parseBody() {
  const text = bodyText.value.trim();
  if (!text) return undefined;
  return JSON.parse(text);
}

function formatQuery(query?: Record<string, string>) {
  return query
    ? Object.entries(query)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")
    : "";
}

function formatBody(body?: unknown) {
  return body === undefined ? "" : JSON.stringify(body, null, 2);
}

function formatJsonBody() {
  const text = bodyText.value.trim();
  if (!text) return;
  try {
    bodyText.value = safeJsonFormat(text, 2);
    error.value = undefined;
  } catch (e: unknown) {
    error.value = `JSON Body 格式错误: ${formatError(e)}`;
  }
}

function applyPreset(preset: RawApiPreset) {
  if (preset.unavailable) return;
  method.value = preset.method;
  path.value = preset.path;
  queryText.value = formatQuery(preset.query);
  bodyText.value = formatBody(preset.body);
  response.value = undefined;
  error.value = undefined;
}

async function executeRequest() {
  error.value = undefined;
  response.value = undefined;

  if (props.readOnly && !isReadMethod.value) {
    error.value = readOnlyMessage;
    return;
  }
  if (!path.value.trim()) {
    error.value = "请输入请求路径";
    return;
  }

  loading.value = true;
  try {
    response.value = await mqRawRequest(props.connectionId, {
      method: method.value,
      path: path.value.trim(),
      query: parseQuery(),
      body: isReadMethod.value ? undefined : parseBody(),
    });
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="raw-api-panel">
    <div class="panel-toolbar">
      <h3>Raw API</h3>
      <button @click="executeRequest" :disabled="requestDisabled" class="btn-primary">
        {{ loading ? "请求中..." : "发送请求" }}
      </button>
    </div>

    <div class="raw-content">
      <div v-if="readOnly" class="readonly-hint">当前连接为只读模式，仅允许 GET、HEAD 和 OPTIONS 请求。</div>
      <div v-if="error" class="panel-error">{{ error }}</div>

      <section class="preset-panel" :class="{ collapsed: presetsCollapsed }">
        <button type="button" class="preset-header" @click="presetsCollapsed = !presetsCollapsed">
          <h4>常用端点</h4>
          <span>按当前选择填充请求</span>
          <span class="preset-toggle">{{ presetsCollapsed ? "展开" : "收起" }}</span>
        </button>
        <div v-if="!presetsCollapsed" class="preset-grid">
          <button v-for="preset in presets" :key="preset.label" type="button" class="preset-button" :disabled="preset.unavailable" @click="applyPreset(preset)">
            <span class="preset-method">{{ preset.method }}</span>
            <span class="preset-copy">
              <strong>{{ preset.label }}</strong>
              <small>{{ preset.description }}</small>
            </span>
          </button>
        </div>
      </section>

      <section class="request-panel">
        <div class="request-line">
          <label>
            方法
            <select v-model="method">
              <option v-for="item in methods" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label class="path-field">
            路径
            <input v-model="path" type="text" placeholder="/admin/v2/..." />
          </label>
        </div>

        <label>
          查询参数
          <textarea v-model="queryText" rows="4" placeholder="key=value，每行一个"></textarea>
        </label>

        <label>
          <span class="field-header">
            <span>JSON Body</span>
            <button type="button" class="btn-secondary compact" :disabled="isReadMethod || !bodyText.trim()" @click="formatJsonBody">格式化</button>
          </span>
          <textarea v-model="bodyText" class="json-body-textarea" :rows="bodyTextareaRows" placeholder='例如: {"key":"value"}' :disabled="isReadMethod"></textarea>
        </label>
      </section>

      <section class="response-panel">
        <h4>响应</h4>
        <div v-if="response" class="response-meta">
          <span>HTTP {{ response.status }}</span>
          <span v-if="response.text">文本响应</span>
        </div>
        <pre v-if="response">{{ response.text || formattedBody }}</pre>
        <div v-else class="empty-state">尚未发送请求</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.raw-api-panel {
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

.raw-content {
  flex: 1;
  overflow: auto;
  padding: 16px;
}

.request-panel,
.preset-panel,
.response-panel {
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-secondary);
}

.request-panel {
  margin-top: 16px;
}

.response-panel {
  margin-top: 16px;
}

.preset-header {
  display: flex;
  width: 100%;
  gap: 12px;
  align-items: center;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}

.preset-panel:not(.collapsed) .preset-header {
  margin-bottom: 12px;
}

.preset-header h4 {
  margin: 0;
}

.preset-header span {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.preset-header span:nth-child(2) {
  margin-left: auto;
}

.preset-toggle {
  color: var(--color-primary) !important;
  font-size: 12px;
}

.preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 8px;
}

.preset-button {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  min-height: 58px;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}

.preset-button:hover:not(:disabled) {
  border-color: var(--color-primary);
}

.preset-method {
  display: inline-flex;
  justify-content: center;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--color-primary-alpha);
  color: var(--color-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 11px;
  font-weight: 600;
}

.preset-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.preset-copy strong {
  font-size: 13px;
  font-weight: 600;
}

.preset-copy small {
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.35;
}

.request-line {
  display: grid;
  grid-template-columns: 140px minmax(260px, 1fr);
  gap: 12px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.field-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

input,
select,
textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
  box-sizing: border-box;
  font: inherit;
}

textarea,
pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
}

textarea {
  resize: vertical;
}

.json-body-textarea {
  min-height: 180px;
  max-height: 56vh;
}

textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

h4 {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}

.response-meta {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

pre {
  margin: 0;
  padding: 12px;
  max-height: 420px;
  overflow: auto;
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
}

.empty-state {
  padding: 24px;
  color: var(--color-text-secondary);
  text-align: center;
}

.panel-error,
.readonly-hint {
  padding: 12px 16px;
  margin-bottom: 12px;
  border-radius: 6px;
  font-size: 13px;
}

.panel-error {
  background: var(--color-error-bg);
  color: var(--color-error);
}

.readonly-hint {
  background: var(--color-warning-alpha);
  color: var(--color-warning);
}

.btn-primary {
  padding: 6px 12px;
  border: 1px solid var(--color-primary);
  border-radius: 4px;
  background: var(--color-primary);
  color: white;
  cursor: pointer;
  font-size: 13px;
}

.btn-secondary {
  padding: 5px 10px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 12px;
}

.btn-secondary:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.btn-secondary.compact {
  padding: 3px 8px;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 700px) {
  .request-line {
    grid-template-columns: 1fr;
  }
}
</style>
