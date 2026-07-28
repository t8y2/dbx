<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ArrowRightLeft, Download, KeyRound, Loader2, Search, Upload } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import KvKeyBrowser from "@/components/kv/KvKeyBrowser.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import { isKeyInKvExportScope, kvExportFilenameStem, kvValueByteIdentity, type KvExportScopeKind, type KvExportScopeRequest } from "@/lib/kv/kvExportScope";
import { detectKvValueFormat } from "@/lib/kv/kvValueFormat";
import { useConnectionStore } from "@/stores/connectionStore";

type WorkbenchMode = "keys" | "search";
type SearchScope = "key" | "value" | "all";
type TransferOperation = "create" | "update" | "delete" | "unchanged" | "skipped" | "applied";

interface EtcdBundleEntry {
  key: api.KvValue;
  value: api.KvValue;
  metadata?: api.KvKeyMetadata | null;
  formatHint?: string;
}

interface EtcdBundle {
  format: "dbx-etcd-bundle";
  version: 1;
  exportedAt: string;
  clusterId?: string | null;
  readRevision?: string | null;
  prefix: string;
  scopeKind?: KvExportScopeKind | "selection";
  entries: EtcdBundleEntry[];
}

interface SearchResult {
  id: string;
  displayKey: string;
  keyIdentity: string;
  summary: api.KvKeySummary;
  selected: boolean;
}

interface TransferRow {
  id: string;
  displayKey: string;
  source?: EtcdBundleEntry;
  target?: api.KvGetResponse;
  operation: TransferOperation;
  reason?: string;
  selected: boolean;
}

const props = defineProps<{ connectionId: string }>();
const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const browserRef = ref<InstanceType<typeof KvKeyBrowser> | null>(null);
const supportsTtl = ref(false);
const ttlCapabilityKnown = ref(false);
const ttlCapabilityRefreshIntervalMs = 5000;
let ttlCapabilityRequest = 0;
let ttlCapabilityInFlightConnection: string | null = null;
let ttlCapabilityRefreshTimer: ReturnType<typeof setInterval> | null = null;
const mode = ref<WorkbenchMode>("keys");
const keyBytesByDisplay = new Map<string, Map<string, api.KvValue>>();
const fileInput = ref<HTMLInputElement>();

const searchQuery = ref("");
const searchPrefix = ref("");
const searchScope = ref<SearchScope>("all");
const searchResults = ref<SearchResult[]>([]);
const searchRunning = ref(false);
const searchScanned = ref(0);
const searchError = ref("");
let searchCancelled = false;
let transferPreviewGeneration = 0;

const transferOpen = ref(false);
const transferMode = ref<"import" | "sync">("import");
const transferBundle = ref<EtcdBundle | null>(null);
const targetConnectionId = ref("");
const transferRows = ref<TransferRow[]>([]);
const transferLoading = ref(false);
const transferApplying = ref(false);
const transferError = ref("");
const mirrorDeletes = ref(false);

const readOnly = computed(() => Boolean(connectionStore.getConfig(props.connectionId)?.read_only));
const etcdConnections = computed(() => connectionStore.connections.filter((connection) => connection.db_type === "etcd"));
const targetReadOnly = computed(() => Boolean(connectionStore.getConfig(targetConnectionId.value)?.read_only));
const mirrorDeleteAvailable = computed(() => transferBundle.value?.scopeKind === "prefix");
const selectedTransferRows = computed(() => transferRows.value.filter((row) => row.selected && !["unchanged", "skipped", "applied"].includes(row.operation)));

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function displayKey(key: api.KvValue, fallback = ""): string {
  if (key.encoding === "utf8") return key.data;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(key.data));
    if (decoded === fallback) return decoded;
  } catch {
    // Binary key: show a reversible, explicit representation.
  }
  return `[base64:${key.data}]`;
}

function keyValue(summary: api.KvKeySummary): api.KvValue {
  return summary.keyBytes ?? { encoding: "utf8", data: summary.key };
}

function keyIdentity(key: api.KvValue): string {
  return kvValueByteIdentity(key);
}

function rememberKeyBytes(display: string, bytes: api.KvValue) {
  const identity = keyIdentity(bytes);
  const bytesByIdentity = keyBytesByDisplay.get(display) ?? new Map<string, api.KvValue>();
  bytesByIdentity.set(identity, bytes);
  keyBytesByDisplay.set(display, bytesByIdentity);
  return identity;
}

function rememberSummary(summary: api.KvKeySummary): api.KvKeySummary {
  const bytes = keyValue(summary);
  const shown = displayKey(bytes, summary.key);
  const identity = rememberKeyBytes(shown, bytes);
  return { ...summary, key: shown, keyBytes: bytes, keyIdentity: identity };
}

function keyOptions(key: string): api.KvGetOptions {
  const candidates = keyBytesByDisplay.get(key);
  return { keyBytes: candidates?.size === 1 ? [...candidates.values()][0] : undefined };
}

const etcdApi = {
  async listPrefix(connectionId: string, prefix: string, limit: number, continuation?: string | null, options?: api.KvListPrefixOptions | null) {
    const response = await api.etcdListPrefix(connectionId, prefix, limit, continuation, options);
    return { ...response, keys: response.keys.map(rememberSummary) };
  },
  async get(connectionId: string, key: string, options?: api.KvGetOptions | null) {
    const result = await api.etcdGet(connectionId, key, { ...keyOptions(key), ...options });
    if (!result.found || !result.keyBytes) return result;
    const shown = displayKey(result.keyBytes, result.key ?? key);
    const identity = rememberKeyBytes(shown, result.keyBytes);
    return { ...result, key: shown, keyIdentity: identity };
  },
  getMetadata: (connectionId: string, key: string, options?: api.KvGetOptions | null) => api.etcdGet(connectionId, key, { ...keyOptions(key), ...options, metadataOnly: true }),
  put: (connectionId: string, key: string, value: api.KvValue, options?: api.KvPutOptions | null) =>
    api.etcdPut(connectionId, key, value, {
      ...options,
      keyBytes: options?.keyBytes ?? (options?.expectedCreateRevision === "0" ? undefined : keyOptions(key).keyBytes),
    }),
  deleteKey: (connectionId: string, key: string, options?: api.KvDeleteOptions | null) => api.etcdDelete(connectionId, key, { ...options, keyBytes: options?.keyBytes ?? keyOptions(key).keyBytes }),
  rename: api.etcdRename,
  history: api.etcdHistory,
  exportScope: exportEtcdNodeScope,
};

const labels = computed(() => ({
  prefixPlaceholder: t("etcd.prefixPlaceholder"),
  newKey: t("etcd.newKey"),
  loadingKeys: t("etcd.loadingKeys"),
  empty: t("etcd.empty"),
  loadMore: t("etcd.loadMore"),
  selectKey: t("etcd.selectKey"),
  loadingValue: t("etcd.loadingValue"),
  notFound: t("etcd.notFound"),
  edit: t("etcd.edit"),
  editKey: t("etcd.editKey"),
  delete: t("etcd.delete"),
  deleteTitle: t("etcd.deleteTitle"),
  keyPlaceholder: t("etcd.keyPlaceholder"),
  keyRequired: t("etcd.keyRequired"),
  saved: t("etcd.saved"),
  deleted: t("etcd.deleted"),
  base64Readonly: t("etcd.base64Readonly"),
  rename: t("etcd.rename"),
  clone: t("etcd.clone"),
  copyKey: t("etcd.copyKey"),
  export: t("etcd.export"),
  history: t("etcd.history"),
  restore: t("etcd.restore"),
  compare: t("etcd.compare"),
  format: t("etcd.format"),
  expiryMode: t("etcd.expiryMode"),
  expiryPermanent: t("etcd.expiryPermanent"),
  expiryPermanentHint: t("etcd.expiryPermanentHint"),
  expiryTtl: t("etcd.expiryTtl"),
  expiryTtlHint: t("etcd.expiryTtlHint"),
  expiryLease: t("etcd.expiryLease"),
  expiryLeaseHint: t("etcd.expiryLeaseHint"),
  leaseId: t("etcd.leaseId"),
  leasePlaceholder: t("etcd.leasePlaceholder"),
  leaseInvalid: t("etcd.leaseInvalid"),
  valueContent: t("etcd.valueContent"),
  savePreview: t("etcd.savePreview"),
  keyAlreadyExists: t("etcd.keyAlreadyExists"),
  conflict: t("etcd.conflict"),
  prettyJson: t("zookeeper.prettyJson"),
  invalidJson: t("zookeeper.invalidJson"),
}));

async function refreshTtlCapability() {
  const connectionId = props.connectionId;
  if (ttlCapabilityInFlightConnection === connectionId) return;
  const request = ++ttlCapabilityRequest;
  ttlCapabilityInFlightConnection = connectionId;
  try {
    const supported = await api.etcdSupportsTtl(connectionId);
    if (request !== ttlCapabilityRequest || props.connectionId !== connectionId) return;
    supportsTtl.value = supported;
    ttlCapabilityKnown.value = true;
  } catch {
    if (request !== ttlCapabilityRequest || props.connectionId !== connectionId) return;
    // Keep an unknown capability unknown, and preserve the last confirmed result
    // across transient Agent reconnects.
  } finally {
    if (request === ttlCapabilityRequest) ttlCapabilityInFlightConnection = null;
  }
}

function stopTtlCapabilityRefresh() {
  ttlCapabilityRequest++;
  ttlCapabilityInFlightConnection = null;
  if (ttlCapabilityRefreshTimer !== null) {
    clearInterval(ttlCapabilityRefreshTimer);
    ttlCapabilityRefreshTimer = null;
  }
}

function startTtlCapabilityRefresh() {
  stopTtlCapabilityRefresh();
  void refreshTtlCapability();
  ttlCapabilityRefreshTimer = setInterval(() => void refreshTtlCapability(), ttlCapabilityRefreshIntervalMs);
}

watch(
  () => props.connectionId,
  () => {
    keyBytesByDisplay.clear();
    supportsTtl.value = false;
    ttlCapabilityKnown.value = false;
    startTtlCapabilityRefresh();
  },
  { immediate: true },
);

onBeforeUnmount(stopTtlCapabilityRefresh);

function valuesEqual(left?: api.KvValue | null, right?: api.KvValue | null) {
  return left?.encoding === right?.encoding && left?.data === right?.data;
}

function normalizedLease(metadata?: api.KvKeyMetadata | null) {
  return metadata?.lease == null ? "0" : String(metadata.lease);
}

async function scanConnection(connectionId: string, prefix: string, onPage?: (scanned: number) => void): Promise<{ entries: api.KvKeySummary[]; revision: string | null }> {
  const entries: api.KvKeySummary[] = [];
  let continuation: string | null = null;
  let revision: string | null = null;
  do {
    const response = await api.etcdListPrefix(connectionId, prefix, 500, continuation, {
      revision,
      includeValues: true,
    });
    if (!revision && response.revision != null) revision = String(response.revision);
    entries.push(...response.keys);
    continuation = response.continuation || null;
    onPage?.(entries.length);
    if (entries.length >= 50_000) throw new Error("Safety limit reached: scan is limited to 50,000 keys.");
    if (searchCancelled) break;
  } while (continuation);
  return { entries, revision };
}

function bundleFromSummaries(entries: api.KvKeySummary[], prefix: string, revision: string | null, scopeKind: KvExportScopeKind | "selection" = "prefix"): EtcdBundle {
  const missingValue = entries.find((entry) => !entry.value);
  if (missingValue) {
    throw new Error(`Value data is unavailable for Key "${missingValue.key}". Update the etcd Agent, reconnect, and retry.`);
  }
  return {
    format: "dbx-etcd-bundle",
    version: 1,
    exportedAt: new Date().toISOString(),
    readRevision: revision,
    prefix,
    scopeKind,
    entries: entries.map((entry) => {
      const value = entry.value as api.KvValue;
      return {
        key: keyValue(entry),
        value,
        metadata: {
          createRevision: entry.createRevision,
          modRevision: entry.modRevision,
          version: entry.version,
          lease: entry.lease,
          valueSize: entry.valueSize,
        },
        formatHint: detectKvValueFormat(value.data, value.encoding),
      };
    }),
  };
}

function downloadBundle(bundle: EtcdBundle, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportAll() {
  try {
    searchCancelled = false;
    const scan = await scanConnection(props.connectionId, "");
    downloadBundle(bundleFromSummaries(scan.entries, "", scan.revision), `dbx-etcd-${Date.now()}.json`);
    toast(t("etcd.exported", { count: scan.entries.length }), 2500);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 4000);
  }
}

async function exportEtcdNodeScope(connectionId: string, request: KvExportScopeRequest) {
  try {
    let entries: api.KvKeySummary[];
    let revision: string | null;

    if (request.kind === "key") {
      const options = keyOptions(request.path);
      const result = await api.etcdGet(connectionId, request.path, { ...options, keyBytes: request.keyBytes ?? options.keyBytes });
      if (!result.found || !result.value) throw new Error(t("etcd.notFound"));
      entries = [
        {
          key: result.key || request.path,
          keyBytes: result.keyBytes ?? keyOptions(request.path).keyBytes,
          value: result.value,
          ...result.metadata,
        },
      ];
      revision = result.metadata?.modRevision == null ? null : String(result.metadata.modRevision);
    } else {
      searchCancelled = false;
      const scan = await scanConnection(connectionId, request.path);
      entries = scan.entries.filter((entry) => isKeyInKvExportScope(displayKey(keyValue(entry), entry.key), request));
      revision = scan.revision;
    }

    const bundle = bundleFromSummaries(entries, request.path, revision, request.kind);
    downloadBundle(bundle, `dbx-etcd-${kvExportFilenameStem(request.path)}-${Date.now()}.json`);
    toast(t("etcd.exported", { count: bundle.entries.length }), 2500);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 4000);
  }
}

function validateBundle(input: unknown): EtcdBundle {
  const candidate = input as Partial<EtcdBundle>;
  if (candidate.format !== "dbx-etcd-bundle" || candidate.version !== 1 || !Array.isArray(candidate.entries)) {
    throw new Error("Unsupported etcd bundle. Expected DBX etcd bundle v1.");
  }
  for (const entry of candidate.entries) {
    if (!entry || !["utf8", "base64"].includes(entry.key?.encoding) || !["utf8", "base64"].includes(entry.value?.encoding) || typeof entry.key.data !== "string" || typeof entry.value.data !== "string") {
      throw new Error("Invalid etcd bundle entry.");
    }
  }
  return candidate as EtcdBundle;
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    transferBundle.value = validateBundle(JSON.parse(await file.text()));
    transferMode.value = "import";
    targetConnectionId.value = props.connectionId;
    mirrorDeletes.value = false;
    transferOpen.value = true;
    await previewTransfer();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 4000);
  }
}

async function openSync() {
  transferMode.value = "sync";
  targetConnectionId.value = etcdConnections.value.find((connection) => connection.id !== props.connectionId)?.id || "";
  mirrorDeletes.value = false;
  transferRows.value = [];
  transferError.value = "";
  transferOpen.value = true;
  transferLoading.value = true;
  try {
    searchCancelled = false;
    const scan = await scanConnection(props.connectionId, "");
    transferBundle.value = bundleFromSummaries(scan.entries, "", scan.revision);
    if (targetConnectionId.value) await previewTransfer();
  } catch (error) {
    transferError.value = error instanceof Error ? error.message : String(error);
  } finally {
    transferLoading.value = false;
  }
}

async function previewTransfer() {
  const bundle = transferBundle.value;
  const targetId = targetConnectionId.value;
  const includeMirrorDeletes = mirrorDeletes.value && bundle?.scopeKind === "prefix";
  if (!bundle || !targetId) return;
  const generation = ++transferPreviewGeneration;
  transferLoading.value = true;
  transferError.value = "";
  const rows: TransferRow[] = [];
  try {
    for (const source of bundle.entries) {
      const shown = displayKey(source.key);
      if (normalizedLease(source.metadata) !== "0") {
        rows.push({ id: `source:${kvValueByteIdentity(source.key)}`, displayKey: shown, source, operation: "skipped", reason: "Leased keys are skipped by default.", selected: false });
        continue;
      }
      const target = await api.etcdGet(targetId, shown, { keyBytes: source.key });
      if (generation !== transferPreviewGeneration) return;
      const operation: TransferOperation = !target.found ? "create" : valuesEqual(source.value, target.value) ? "unchanged" : "update";
      rows.push({ id: `source:${kvValueByteIdentity(source.key)}`, displayKey: shown, source, target, operation, selected: operation === "create" || operation === "update" });
    }
    if (includeMirrorDeletes) {
      searchCancelled = false;
      const mirrorScope: KvExportScopeRequest = {
        path: bundle.prefix || "",
        kind: "prefix",
      };
      const targetScan = await scanConnection(targetId, mirrorScope.path);
      if (generation !== transferPreviewGeneration) return;
      const sourceKeys = new Set(bundle.entries.map((entry) => kvValueByteIdentity(entry.key)));
      for (const target of targetScan.entries) {
        const bytes = keyValue(target);
        const shown = displayKey(bytes, target.key);
        if (!isKeyInKvExportScope(shown, mirrorScope) || sourceKeys.has(kvValueByteIdentity(bytes))) continue;
        rows.push({
          id: `delete:${kvValueByteIdentity(bytes)}`,
          displayKey: shown,
          target: { found: true, key: target.key, keyBytes: bytes, value: target.value, metadata: target },
          operation: "delete",
          reason: "Mirror mode: key is absent from source.",
          selected: true,
        });
      }
    }
    if (generation !== transferPreviewGeneration) return;
    transferRows.value = rows;
  } catch (error) {
    if (generation !== transferPreviewGeneration) return;
    transferError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (generation === transferPreviewGeneration) transferLoading.value = false;
  }
}

async function applyTransfer() {
  const targetId = targetConnectionId.value;
  const rows = [...selectedTransferRows.value];
  if (!targetId || rows.length === 0) return;
  // Invalidate any preview that is still resolving before writes begin.
  transferPreviewGeneration++;
  transferApplying.value = true;
  transferLoading.value = false;
  transferError.value = "";
  let appliedCount = 0;
  try {
    for (const row of rows) {
      if (row.operation === "delete") {
        await api.etcdDelete(targetId, row.displayKey, {
          keyBytes: row.target?.keyBytes,
          expectedModRevision: row.target?.metadata?.modRevision == null ? undefined : String(row.target.metadata.modRevision),
        });
      } else if (row.source) {
        await api.etcdPut(targetId, row.displayKey, row.source.value, {
          keyBytes: row.source.key,
          expectedCreateRevision: row.operation === "create" ? "0" : undefined,
          expectedModRevision: row.operation === "update" && row.target?.metadata?.modRevision != null ? String(row.target.metadata.modRevision) : undefined,
        });
      } else {
        continue;
      }
      appliedCount++;
      row.operation = "applied";
      row.selected = false;
      row.reason = t("etcd.operationApplied");
    }
    toast(t("etcd.transferApplied", { count: appliedCount }), 3000);
    transferOpen.value = false;
    if (targetId === props.connectionId) browserRef.value?.refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Rebuild the preview so an ambiguous network failure or a successful
    // prefix of the batch is reflected before the user retries.
    let previewError = "";
    let previewRefreshed = false;
    if (targetConnectionId.value === targetId) {
      await previewTransfer();
      previewError = transferError.value;
      previewRefreshed = !previewError;
    } else {
      previewError = t("etcd.targetChangedDuringTransfer");
    }
    transferError.value = previewRefreshed ? t("etcd.transferPartiallyApplied", { count: appliedCount, error: message }) : t("etcd.transferPartialRefreshFailed", { count: appliedCount, error: message, previewError });
  } finally {
    transferApplying.value = false;
  }
}

function onTransferTargetChange(value: unknown) {
  transferPreviewGeneration++;
  targetConnectionId.value = String(value ?? "");
  transferRows.value = [];
  if (targetConnectionId.value) void previewTransfer();
}

function onMirrorDeleteChange() {
  transferPreviewGeneration++;
  void previewTransfer();
}

async function runSearch() {
  const query = searchQuery.value;
  if (!query) return;
  searchRunning.value = true;
  searchCancelled = false;
  searchScanned.value = 0;
  searchError.value = "";
  searchResults.value = [];
  try {
    const scan = await scanConnection(props.connectionId, searchPrefix.value, (count) => (searchScanned.value = count));
    const normalized = query.toLocaleLowerCase();
    searchResults.value = scan.entries
      .filter((entry) => {
        const shown = displayKey(keyValue(entry), entry.key).toLocaleLowerCase();
        const value = entry.value?.data.toLocaleLowerCase() || "";
        return (searchScope.value !== "value" && shown.includes(normalized)) || (searchScope.value !== "key" && value.includes(normalized));
      })
      .slice(0, 1000)
      .map((summary) => {
        const bytes = keyValue(summary);
        const shown = displayKey(bytes, summary.key);
        const identity = rememberKeyBytes(shown, bytes);
        return { id: `${identity}:${summary.modRevision || ""}`, displayKey: shown, keyIdentity: identity, summary: { ...summary, key: shown, keyBytes: bytes, keyIdentity: identity }, selected: true };
      });
  } catch (error) {
    searchError.value = error instanceof Error ? error.message : String(error);
  } finally {
    searchRunning.value = false;
  }
}

function cancelSearch() {
  searchCancelled = true;
}

async function openSearchResult(result: SearchResult) {
  mode.value = "keys";
  await nextTick();
  await (browserRef.value as any)?.selectKey({ key: result.displayKey, keyIdentity: result.keyIdentity, keyBytes: keyValue(result.summary) });
}

function exportSearchResults() {
  const selected = searchResults.value.filter((result) => result.selected).map((result) => result.summary);
  downloadBundle(bundleFromSummaries(selected, searchPrefix.value, null, "selection"), `dbx-etcd-search-${Date.now()}.json`);
}

function focusSearch(): boolean {
  if (mode.value === "keys") return browserRef.value?.focusSearch() ?? false;
  mode.value = "search";
  return true;
}

function refresh(): boolean {
  if (mode.value === "keys") return browserRef.value?.refresh() ?? false;
  if (mode.value === "search") void runSearch();
  return true;
}

defineExpose({ focusSearch, refresh });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <div class="flex rounded-md border p-0.5">
        <Button size="sm" :variant="mode === 'keys' ? 'secondary' : 'ghost'" class="h-7 gap-1.5" @click="mode = 'keys'"><KeyRound class="h-3.5 w-3.5" /> Keys</Button>
        <Button size="sm" :variant="mode === 'search' ? 'secondary' : 'ghost'" class="h-7 gap-1.5" @click="mode = 'search'"><Search class="h-3.5 w-3.5" /> {{ t("etcd.globalSearch") }}</Button>
      </div>
      <div class="flex-1" />
      <Badge v-if="readOnly" variant="outline">{{ t("connection.readOnly") }}</Badge>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" @click="exportAll"><Download class="h-3.5 w-3.5" /> {{ t("etcd.export") }}</Button>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="readOnly" @click="fileInput?.click()"><Upload class="h-3.5 w-3.5" /> {{ t("etcd.import") }}</Button>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="etcdConnections.length < 2" @click="openSync"><ArrowRightLeft class="h-3.5 w-3.5" /> {{ t("etcd.sync") }}</Button>
      <input ref="fileInput" type="file" accept="application/json,.json" class="hidden" @change="onImportFile" />
    </div>

    <KvKeyBrowser
      v-if="mode === 'keys'"
      ref="browserRef"
      class="min-h-0 flex-1"
      :connection-id="props.connectionId"
      :api="etcdApi"
      :labels="labels"
      :supports-ttl="supportsTtl"
      :supports-lease-binding="true"
      :ttl-capability-known="ttlCapabilityKnown"
      :enable-node-actions="true"
      :safe-write="true"
      :allow-binary-edit="true"
      :read-only="readOnly"
      @refresh-requested="refreshTtlCapability"
    />

    <div v-else-if="mode === 'search'" class="flex min-h-0 flex-1 flex-col">
      <div class="grid shrink-0 gap-2 border-b p-3 md:grid-cols-[minmax(160px,240px)_140px_1fr_auto]">
        <Input v-model="searchPrefix" :placeholder="t('etcd.searchPrefix')" @keyup.enter="runSearch" />
        <Select v-model="searchScope">
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{{ t("etcd.searchAll") }}</SelectItem>
            <SelectItem value="key">Key</SelectItem>
            <SelectItem value="value">Value</SelectItem>
          </SelectContent>
        </Select>
        <Input v-model="searchQuery" :placeholder="t('etcd.searchPlaceholder')" @keyup.enter="runSearch" />
        <div class="flex gap-2">
          <Button :disabled="searchRunning || !searchQuery" @click="runSearch"><Loader2 v-if="searchRunning" class="mr-2 h-4 w-4 animate-spin" />{{ t("etcd.globalSearch") }}</Button>
          <Button v-if="searchRunning" variant="outline" @click="cancelSearch">{{ t("common.cancel") }}</Button>
        </div>
      </div>
      <div class="flex shrink-0 items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
        <span>{{ t("etcd.searchProgress", { scanned: searchScanned, matched: searchResults.length }) }}</span>
        <Button size="sm" variant="outline" class="h-7 gap-1.5" :disabled="searchResults.length === 0" @click="exportSearchResults"><Download class="h-3.5 w-3.5" /> {{ t("etcd.exportResults") }}</Button>
      </div>
      <div v-if="searchError" class="border-b px-3 py-2 text-sm text-destructive">{{ searchError }}</div>
      <div class="min-h-0 flex-1 overflow-auto">
        <table class="w-full text-left text-sm">
          <thead class="sticky top-0 bg-muted/90 text-xs text-muted-foreground">
            <tr>
              <th class="w-10 px-3 py-2"></th>
              <th class="px-3 py-2">Key</th>
              <th class="px-3 py-2">Value</th>
              <th class="px-3 py-2">Revision</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="result in searchResults" :key="result.id" class="cursor-pointer border-b hover:bg-accent/50" @dblclick="openSearchResult(result)">
              <td class="px-3 py-2"><input v-model="result.selected" type="checkbox" @click.stop /></td>
              <td class="max-w-md truncate px-3 py-2 font-mono text-xs text-primary" @click="openSearchResult(result)">{{ result.displayKey }}</td>
              <td class="max-w-xl truncate px-3 py-2 font-mono text-xs">{{ result.summary.value?.data || "" }}</td>
              <td class="px-3 py-2 font-mono text-xs">{{ result.summary.modRevision || "-" }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="!searchRunning && searchResults.length === 0" class="flex h-52 items-center justify-center text-sm text-muted-foreground">{{ t("etcd.empty") }}</div>
      </div>
    </div>

    <Dialog v-model:open="transferOpen">
      <DialogContent class="flex h-[min(86vh,820px)] max-w-[min(96vw,1180px)] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader class="shrink-0 border-b px-5 py-4">
          <DialogTitle>{{ transferMode === "sync" ? t("etcd.syncPreview") : t("etcd.importPreview") }}</DialogTitle>
          <div class="mt-3 grid gap-3 md:grid-cols-[1fr_auto]">
            <Select :model-value="targetConnectionId" :disabled="transferLoading || transferApplying" @update:model-value="onTransferTargetChange">
              <SelectTrigger><SelectValue :placeholder="t('etcd.targetConnection')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="connection in etcdConnections.filter((connection) => transferMode === 'import' || connection.id !== props.connectionId)" :key="connection.id" :value="connection.id">
                  {{ connection.name }}
                </SelectItem>
              </SelectContent>
            </Select>
            <label class="inline-flex items-center gap-2 rounded-md border px-3 text-sm" :class="{ 'cursor-not-allowed opacity-50': !mirrorDeleteAvailable }" :title="mirrorDeleteAvailable ? undefined : 'Mirror delete is available only for complete prefix bundles.'">
              <input v-model="mirrorDeletes" type="checkbox" :disabled="!mirrorDeleteAvailable || transferLoading || transferApplying" @change="onMirrorDeleteChange" />
              {{ t("etcd.mirrorDelete") }}
            </label>
          </div>
        </DialogHeader>
        <div v-if="transferError" class="border-b px-5 py-2 text-sm text-destructive">{{ transferError }}</div>
        <div v-if="mirrorDeletes" class="border-b bg-destructive/5 px-5 py-2 text-xs text-destructive">{{ t("etcd.mirrorDeleteWarning") }}</div>
        <div v-if="targetReadOnly" class="border-b bg-amber-500/10 px-5 py-2 text-xs text-amber-700 dark:text-amber-300">{{ t("connection.readOnly") }}: {{ t("etcd.targetReadOnly") }}</div>
        <div class="min-h-0 flex-1 overflow-auto">
          <div v-if="transferLoading" class="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 h-4 w-4 animate-spin" />{{ t("etcd.preparingPreview") }}</div>
          <table v-else class="w-full text-left text-sm">
            <thead class="sticky top-0 bg-muted/90 text-xs text-muted-foreground">
              <tr>
                <th class="w-10 px-3 py-2"></th>
                <th class="px-3 py-2">Key</th>
                <th class="px-3 py-2">{{ t("etcd.operation") }}</th>
                <th class="px-3 py-2">{{ t("etcd.reason") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in transferRows" :key="row.id" class="border-b">
                <td class="px-3 py-2"><input v-model="row.selected" type="checkbox" :disabled="row.operation === 'unchanged' || row.operation === 'skipped' || row.operation === 'applied'" /></td>
                <td class="max-w-xl truncate px-3 py-2 font-mono text-xs">{{ row.displayKey }}</td>
                <td class="px-3 py-2">
                  <Badge :variant="row.operation === 'delete' ? 'destructive' : 'outline'">{{ row.operation }}</Badge>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">{{ row.reason || "-" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <DialogFooter class="shrink-0 border-t px-5 py-4">
          <span class="mr-auto text-xs text-muted-foreground">{{ t("etcd.selectedOperations", { count: selectedTransferRows.length }) }}</span>
          <Button variant="outline" :disabled="transferApplying" @click="transferOpen = false">{{ t("common.cancel") }}</Button>
          <Button :variant="mirrorDeletes ? 'destructive' : 'default'" :disabled="targetReadOnly || transferLoading || transferApplying || selectedTransferRows.length === 0" @click="applyTransfer">
            <Loader2 v-if="transferApplying" class="mr-2 h-4 w-4 animate-spin" />
            {{ t("etcd.applyOperations") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
