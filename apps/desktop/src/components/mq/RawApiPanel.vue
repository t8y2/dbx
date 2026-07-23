<script setup lang="ts">
import { formatError } from "@/lib/backend/errorUtils";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
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
const { t } = useI18n();

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
const readOnlyMessage = computed(() => t("mqRaw.readOnly"));

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
      label: t("mqRaw.presetBrokerVersion"),
      description: t("mqRaw.presetBrokerVersionDesc"),
      method: "GET",
      path: "/admin/v2/brokers/version",
    },
    {
      label: t("mqRaw.presetClusters"),
      description: t("mqRaw.presetClustersDesc"),
      method: "GET",
      path: "/admin/v2/clusters",
    },
    {
      label: t("mqRaw.presetTenant"),
      description: t("mqRaw.presetTenantDesc"),
      method: "GET",
      path: tenant ?? "/admin/v2/tenants/{tenant}",
      unavailable: !tenant,
    },
    {
      label: t("mqRaw.presetNamespacePolicies"),
      description: t("mqRaw.presetNamespacePoliciesDesc"),
      method: "GET",
      path: namespace ?? "/admin/v2/namespaces/{tenant}/{namespace}",
      unavailable: !namespace,
    },
    {
      label: t("mqRaw.presetBundles"),
      description: t("mqRaw.presetBundlesDesc"),
      method: "GET",
      path: namespace ? `${namespace}/bundles` : "/admin/v2/namespaces/{tenant}/{namespace}/bundles",
      unavailable: !namespace,
    },
    {
      label: t("mqRaw.presetTopicInternalStats"),
      description: t("mqRaw.presetTopicInternalStatsDesc"),
      method: "GET",
      path: topic ? `${topic}/internalStats` : "/admin/v2/persistent/{tenant}/{namespace}/{topic}/internalStats",
      unavailable: !topic,
    },
    {
      label: t("mqRaw.presetPartitionedStats"),
      description: t("mqRaw.presetPartitionedStatsDesc"),
      method: "GET",
      path: topic ? `${topic}/partitioned-stats` : "/admin/v2/persistent/{tenant}/{namespace}/{topic}/partitioned-stats",
      query: { perPartition: "true" },
      unavailable: !topic,
    },
    {
      label: t("mqRaw.presetSchema"),
      description: t("mqRaw.presetSchemaDesc"),
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
    error.value = t("mqRaw.jsonBodyInvalid", { error: formatError(e) });
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
    error.value = readOnlyMessage.value;
    return;
  }
  if (!path.value.trim()) {
    error.value = t("mqRaw.pathRequired");
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
      <h3>{{ t("mqRaw.title") }}</h3>
      <button @click="executeRequest" :disabled="requestDisabled" class="btn-primary">
        {{ loading ? t("mqRaw.sending") : t("mqRaw.sendRequest") }}
      </button>
    </div>

    <div class="raw-content">
      <div v-if="readOnly" class="readonly-hint">{{ t("mqRaw.readOnlyHint") }}</div>
      <div v-if="error" class="panel-error">{{ error }}</div>

      <section class="preset-panel" :class="{ collapsed: presetsCollapsed }">
        <button type="button" class="preset-header" @click="presetsCollapsed = !presetsCollapsed">
          <h4>{{ t("mqRaw.commonEndpoints") }}</h4>
          <span>{{ t("mqRaw.fillFromSelection") }}</span>
          <span class="preset-toggle">{{ presetsCollapsed ? t("mqRaw.expand") : t("mqRaw.collapse") }}</span>
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
            {{ t("mqRaw.method") }}
            <select v-model="method">
              <option v-for="item in methods" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label class="path-field">
            {{ t("mqRaw.path") }}
            <input v-model="path" type="text" :placeholder="t('mqRaw.pathPlaceholder')" />
          </label>
        </div>

        <label>
          {{ t("mqRaw.queryParams") }}
          <textarea v-model="queryText" rows="4" :placeholder="t('mqRaw.queryPlaceholder')"></textarea>
        </label>

        <label>
          <span class="field-header">
            <span>{{ t("mqRaw.jsonBody") }}</span>
            <button type="button" class="btn-secondary compact" :disabled="isReadMethod || !bodyText.trim()" @click="formatJsonBody">{{ t("mqRaw.format") }}</button>
          </span>
          <textarea v-model="bodyText" class="json-body-textarea" :rows="bodyTextareaRows" :placeholder="t('mqRaw.bodyPlaceholder')" :disabled="isReadMethod"></textarea>
        </label>
      </section>

      <section class="response-panel">
        <h4>{{ t("mqRaw.response") }}</h4>
        <div v-if="response" class="response-meta">
          <span>HTTP {{ response.status }}</span>
          <span v-if="response.text">{{ t("mqRaw.textResponse") }}</span>
        </div>
        <pre v-if="response">{{ response.text || formattedBody }}</pre>
        <div v-else class="empty-state">{{ t("mqRaw.noRequestYet") }}</div>
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
  border-radius: var(--dbx-radius-fixed-6);
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
  border-radius: var(--dbx-radius-fixed-6);
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
  border-radius: var(--dbx-radius-fixed-4);
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
  border-radius: var(--dbx-radius-fixed-4);
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
  border-radius: var(--dbx-radius-fixed-6);
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
  border-radius: var(--dbx-radius-fixed-6);
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
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-primary);
  color: white;
  cursor: pointer;
  font-size: 13px;
}

.btn-secondary {
  padding: 5px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
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
