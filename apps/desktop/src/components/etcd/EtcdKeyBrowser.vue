<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Activity, AlertTriangle, ArrowRightLeft, ChevronDown, ChevronLeft, ChevronRight, Download, Eraser, KeyRound, Loader2, Search, Trash2, Upload, Wrench } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import KvKeyBrowser from "@/components/kv/KvKeyBrowser.vue";
import EtcdAdminConsole from "@/components/etcd/EtcdAdminConsole.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { isKeyInKvExportScope, kvExportFilenameStem, kvValueByteIdentity, type KvExportScopeKind, type KvExportScopeRequest } from "@/lib/kv/kvExportScope";
import { detectKvValueFormat } from "@/lib/kv/kvValueFormat";
import { useConnectionStore } from "@/stores/connectionStore";

type WorkbenchMode = "keys" | "search" | "maintenance" | "watch" | "lease";
type SearchScope = "key" | "value" | "all";
type TransferOperation = "create" | "update" | "unchanged" | "skipped" | "applied";
type EtcdExportFormat = "json" | "csv" | "markdown";
type EtcdSyncScope = "prefix" | "all";
type EtcdConflictPolicy = "ABORT" | "SKIP" | "OVERWRITE";

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

interface EtcdExportFile {
  content: string;
  filename: string;
  format: EtcdExportFormat;
}

interface SearchResult {
  id: string;
  displayKey: string;
  keyIdentity: string;
  summary: api.KvKeySummary;
  matchesKey: boolean;
  matchesValue: boolean;
  selected: boolean;
}

interface EtcdWatchPreset {
  key: string;
  keyBytes?: api.KvValue | null;
  scope: "key" | "prefix";
}

interface EtcdMultiSelection {
  key: string;
  keyIdentity?: string | null;
  keyBytes?: api.KvValue | null;
  modRevision?: api.KvInt64 | null;
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

interface ScanOptions {
  onPage?: (scanned: number) => void;
  maxEntries?: number;
  maxEntriesMessage?: string;
}

const DEFAULT_SCAN_MAX_ENTRIES = 50_000;
const SYNC_PREVIEW_MAX_ENTRIES = 10_000;
const TRANSFER_PREVIEW_PAGE_SIZE = 100;
const TARGET_LOOKUP_CONCURRENCY = 8;

const props = defineProps<{ connectionId: string }>();
const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const browserRef = ref<InstanceType<typeof KvKeyBrowser> | null>(null);
const supportsTtl = ref(false);
const ttlCapabilityKnown = ref(false);
const leaseOptions = ref<Array<{ id: api.KvInt64; ttl: number; grantedTtl?: number }>>([]);
const ttlCapabilityRefreshIntervalMs = 5000;
let ttlCapabilityRequest = 0;
let ttlCapabilityInFlightConnection: string | null = null;
let ttlCapabilityRefreshTimer: ReturnType<typeof setInterval> | null = null;
const mode = ref<WorkbenchMode>("keys");
const operationsStatus = ref<api.KvStatusResponse | null>(null);
const operationsLoading = ref(false);
const watchPreset = ref<EtcdWatchPreset | null>(null);
const activeOperation = ref<"maintenance" | "watch" | "lease">("maintenance");
const isOperationsMode = computed(() => mode.value === "maintenance" || mode.value === "watch" || mode.value === "lease");
const keyBytesByDisplay = new Map<string, Map<string, api.KvValue>>();
const keySuggestionVersion = ref(0);
const watchKeySuggestions = computed(() => {
  keySuggestionVersion.value;
  return [...keyBytesByDisplay.entries()].flatMap(([key, values]) => [...values.values()].map((keyBytes) => ({ key, keyBytes })));
});
const fileInput = ref<HTMLInputElement>();
const selectedTreeKeys = ref<EtcdMultiSelection[]>([]);
const batchDeleteOpen = ref(false);
const batchDeleting = ref(false);

const searchQuery = ref("");
const searchPrefix = ref("");
const searchScope = ref<SearchScope>("all");
const searchResults = ref<SearchResult[]>([]);
const searchRunning = ref(false);
const searchScanned = ref(0);
const searchMatched = ref(0);
const searchHasRun = ref(false);
const searchResultLimitReached = ref(false);
const searchSubmittedQuery = ref("");
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
const transferKeyFilter = ref("");
const syncPrefix = ref("");
const syncScope = ref<EtcdSyncScope>("prefix");
const transferConflictPolicy = ref<EtcdConflictPolicy>("ABORT");
const transferCurrentPage = ref(1);
const transferLoadingDetail = ref("");
const transferPreviewLoaded = ref(false);
const syncConfigurationExpanded = ref(true);

const readOnly = computed(() => Boolean(connectionStore.getConfig(props.connectionId)?.read_only));
const etcdConnections = computed(() => connectionStore.connections.filter((connection) => connection.db_type === "etcd"));
const targetReadOnly = computed(() => Boolean(connectionStore.getConfig(targetConnectionId.value)?.read_only));
const selectedTransferRows = computed(() => transferRows.value.filter((row) => row.selected && isTransferRowSelectable(row)));
const selectableTransferRows = computed(() => transferRows.value.filter(isTransferRowSelectable));
const filteredTransferRows = computed(() => {
  const query = transferKeyFilter.value.trim().toLocaleLowerCase();
  return query ? transferRows.value.filter((row) => row.displayKey.toLocaleLowerCase().includes(query)) : transferRows.value;
});
const transferPageCount = computed(() => Math.max(1, Math.ceil(filteredTransferRows.value.length / TRANSFER_PREVIEW_PAGE_SIZE)));
const pagedTransferRows = computed(() => {
  const start = (transferCurrentPage.value - 1) * TRANSFER_PREVIEW_PAGE_SIZE;
  return filteredTransferRows.value.slice(start, start + TRANSFER_PREVIEW_PAGE_SIZE);
});
const selectablePagedTransferRows = computed(() => pagedTransferRows.value.filter(isTransferRowSelectable));
const allPagedTransferRowsSelected = computed(() => selectablePagedTransferRows.value.length > 0 && selectablePagedTransferRows.value.every((row) => row.selected));
const somePagedTransferRowsSelected = computed(() => !allPagedTransferRowsSelected.value && selectablePagedTransferRows.value.some((row) => row.selected));
const selectedSearchResults = computed(() => searchResults.value.filter((result) => result.selected));
const transferCreateCount = computed(() => transferRows.value.filter((row) => row.operation === "create").length);
const transferConflictCount = computed(() => transferRows.value.filter((row) => row.operation === "update").length);
const transferUnchangedCount = computed(() => transferRows.value.filter((row) => row.operation === "unchanged").length);
const transferSkippedCount = computed(() => transferRows.value.filter((row) => row.operation === "skipped").length);
const transferHasBlockingConflicts = computed(() => transferMode.value === "sync" && transferConflictPolicy.value === "ABORT" && transferConflictCount.value > 0);
const canLoadSyncPreview = computed(() => Boolean(targetConnectionId.value) && (syncScope.value === "all" || syncPrefix.value.length > 0));
const selectedTargetConnectionName = computed(() => etcdConnections.value.find((connection) => connection.id === targetConnectionId.value)?.name || "未选择");
const syncScopeSummary = computed(() => (syncScope.value === "all" ? "全部 Key" : `Prefix: ${syncPrefix.value}`));

watch(transferKeyFilter, () => {
  transferCurrentPage.value = 1;
});

watch(syncPrefix, () => {
  if (transferMode.value !== "sync" || !transferBundle.value) return;
  transferPreviewGeneration++;
  transferBundle.value = null;
  transferRows.value = [];
  transferError.value = "";
  transferPreviewLoaded.value = false;
  transferCurrentPage.value = 1;
});

watch(syncScope, () => {
  if (transferMode.value !== "sync") return;
  transferPreviewGeneration++;
  transferBundle.value = null;
  transferRows.value = [];
  transferError.value = "";
  transferPreviewLoaded.value = false;
  transferCurrentPage.value = 1;
});

watch(transferConflictPolicy, () => {
  if (transferMode.value !== "sync" || !transferPreviewLoaded.value) return;
  for (const row of transferRows.value) {
    if (row.operation === "create") row.selected = true;
    else if (row.operation === "update") row.selected = transferConflictPolicy.value === "OVERWRITE";
    else if (row.operation !== "applied") row.selected = false;
  }
});

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function displayKey(key: api.KvValue): string {
  if (key.encoding === "utf8") return key.data;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(key.data));
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
  const isNewKey = !bytesByIdentity.has(identity);
  bytesByIdentity.set(identity, bytes);
  keyBytesByDisplay.set(display, bytesByIdentity);
  if (isNewKey) keySuggestionVersion.value++;
  return identity;
}

function rememberSummary(summary: api.KvKeySummary): api.KvKeySummary {
  const bytes = keyValue(summary);
  const shown = displayKey(bytes);
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
    const shown = displayKey(result.keyBytes);
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
  keyLabel: t("etcd.key"),
  keyPlaceholder: t("etcd.keyPlaceholder"),
  keyRequired: t("etcd.keyRequired"),
  saved: t("etcd.saved"),
  deleted: t("etcd.deleted"),
  base64Readonly: t("etcd.base64Readonly"),
  rename: t("etcd.rename"),
  clone: t("etcd.clone"),
  copyKey: t("etcd.copyKey"),
  copy: t("grid.copy"),
  copied: t("grid.copied"),
  copyFailed: t("grid.copyFailed"),
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
  watch: t("etcd.watch"),
  selectExistingLease: t("etcd.selectExistingLease"),
  enterLeaseId: t("etcd.enterLeaseId"),
  leasePickerHint: t("etcd.leasePickerHint"),
  noLeasePickerHint: t("etcd.noLeasePickerHint"),
  registryWarning: t("etcd.registryWarning"),
  selectAll: t("etcd.selectAllLoaded"),
  deselectAll: t("etcd.deselectAll"),
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

function isTransferRowSelectable(row: TransferRow): boolean {
  if (["unchanged", "skipped", "applied"].includes(row.operation)) return false;
  if (transferMode.value !== "sync" || row.operation !== "update") return true;
  return transferConflictPolicy.value === "OVERWRITE";
}

function transferOperationLabel(row: TransferRow): string {
  if (row.operation === "create") return "新增";
  if (row.operation === "update") return transferConflictPolicy.value === "OVERWRITE" ? "覆盖" : "冲突";
  if (row.operation === "unchanged") return "无变化";
  if (row.operation === "skipped") return "已跳过";
  return "已应用";
}

function conflictPolicyLabel(policy: EtcdConflictPolicy): string {
  if (policy === "ABORT") return "遇冲突终止";
  if (policy === "SKIP") return "跳过冲突";
  return "覆盖目标";
}

function transferOperationVariant(row: TransferRow): "default" | "secondary" | "destructive" | "outline" {
  if (row.operation === "create" || row.operation === "applied") return "secondary";
  return "outline";
}

async function scanConnection(connectionId: string, prefix: string, options: ScanOptions = {}): Promise<{ entries: api.KvKeySummary[]; revision: string | null }> {
  const maxEntries = options.maxEntries ?? DEFAULT_SCAN_MAX_ENTRIES;
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
    options.onPage?.(entries.length);
    if (entries.length >= maxEntries && continuation) {
      throw new Error(options.maxEntriesMessage ?? `Safety limit reached: scan is limited to ${maxEntries.toLocaleString()} keys.`);
    }
    if (searchCancelled) break;
  } while (continuation);
  return { entries, revision };
}

function syncScanLimitMessage(prefix: string): string {
  const scope = prefix || "整个 Keyspace";
  return `同步预览最多支持 ${SYNC_PREVIEW_MAX_ENTRIES.toLocaleString()} 个 Key；“${scope}”范围过大，请使用更具体的 Prefix 后重试。`;
}

async function scanSyncScope(connectionId: string, prefix: string, onPage?: (scanned: number) => void) {
  return scanConnection(connectionId, prefix, {
    onPage,
    maxEntries: SYNC_PREVIEW_MAX_ENTRIES,
    maxEntriesMessage: syncScanLimitMessage(prefix),
  });
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
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

function updateTreeSelection(selection: EtcdMultiSelection[]) {
  selectedTreeKeys.value = selection;
}

async function exportTreeSelection(format: EtcdExportFormat) {
  const selected = [...selectedTreeKeys.value];
  if (!selected.length) return;
  try {
    const entries = await mapWithConcurrency(selected, TARGET_LOOKUP_CONCURRENCY, async (item) => {
      const result = await api.etcdGet(props.connectionId, item.key, { keyBytes: item.keyBytes ?? undefined });
      if (!result.found || !result.value) throw new Error(t("etcd.notFound"));
      return {
        key: result.key || item.key,
        keyBytes: result.keyBytes ?? item.keyBytes ?? { encoding: "utf8", data: item.key },
        value: result.value,
        ...result.metadata,
      };
    });
    const file = buildEtcdExportFile(entries, "", null, "selection", `dbx-etcd-selection-${Date.now()}`, format);
    const exported = await downloadExport(file);
    if (exported) toast(t("etcd.exported", { count: entries.length }), 2500);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 4000);
  }
}

function selectedTreeKeyDetails(): string {
  return selectedTreeKeys.value.map((item) => item.key).join("\n");
}

async function deleteSelectedTreeKeys() {
  const selected = [...selectedTreeKeys.value];
  if (!selected.length || readOnly.value) return;
  batchDeleting.value = true;
  const completed: EtcdMultiSelection[] = [];
  let deleted = 0;
  let failed = false;
  try {
    for (const item of selected) {
      const result = await api.etcdDelete(props.connectionId, item.key, {
        keyBytes: item.keyBytes ?? undefined,
        expectedModRevision: item.modRevision ?? undefined,
      });
      deleted += result.deleted;
      completed.push(item);
    }
    toast(t("etcd.batchDeleteSuccess", { count: deleted }), 3000);
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    toast(t("etcd.batchDeletePartial", { count: deleted, error: message }), 5000);
  } finally {
    if (failed) browserRef.value?.clearMultiSelection();
    else browserRef.value?.removeMultiSelection(completed);
    batchDeleteOpen.value = false;
    batchDeleting.value = false;
    if (completed.length || failed) browserRef.value?.refresh();
  }
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function markdownCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\r\n", "<br>").replaceAll("\n", "<br>");
}

function summaryValue(entry: api.KvKeySummary): api.KvValue {
  if (!entry.value) throw new Error(`Value data is unavailable for Key "${entry.key}". Update the etcd Agent, reconnect, and retry.`);
  return entry.value;
}

function buildEtcdExportFile(entries: api.KvKeySummary[], prefix: string, revision: string | null, scopeKind: KvExportScopeKind | "selection", stem: string, format: EtcdExportFormat): EtcdExportFile {
  if (format === "json") {
    return {
      content: JSON.stringify(bundleFromSummaries(entries, prefix, revision, scopeKind), null, 2),
      filename: `${stem}.json`,
      format,
    };
  }

  const headers = ["Key", "Value", "Value Encoding", "Revision", "Version", "Lease"];
  const rows = entries.map((entry) => {
    const value = summaryValue(entry);
    return [displayKey(keyValue(entry)), value.data, value.encoding, String(entry.modRevision ?? ""), String(entry.version ?? ""), String(entry.lease ?? "")];
  });
  if (format === "csv") {
    return {
      content: [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n"),
      filename: `${stem}.csv`,
      format,
    };
  }
  return {
    content: [headers, ["---", "---", "---", "---", "---", "---"], ...rows].map((row) => `| ${row.map(markdownCell).join(" | ")} |`).join("\n"),
    filename: `${stem}.md`,
    format,
  };
}

function exportFileFilter(format: EtcdExportFormat) {
  return format === "json" ? { name: "DBX etcd Bundle", extensions: ["json"] } : format === "csv" ? { name: "CSV Table", extensions: ["csv"] } : { name: "Markdown", extensions: ["md"] };
}

function exportMimeType(format: EtcdExportFormat): string {
  return format === "json" ? "application/json" : format === "csv" ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8";
}

async function downloadExport(file: EtcdExportFile): Promise<boolean> {
  if (isTauriRuntime()) {
    const [{ save }, { writeTextFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const path = await save({
      defaultPath: file.filename,
      filters: [exportFileFilter(file.format)],
    });
    if (!path) return false;
    await writeTextFile(path, file.content);
    return true;
  }
  const url = URL.createObjectURL(new Blob([file.content], { type: exportMimeType(file.format) }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

async function exportAll(format: EtcdExportFormat) {
  try {
    searchCancelled = false;
    const scan = await scanConnection(props.connectionId, "");
    const file = buildEtcdExportFile(scan.entries, "", scan.revision, "prefix", `dbx-etcd-${Date.now()}`, format);
    const exported = await downloadExport(file);
    if (exported) toast(t("etcd.exported", { count: scan.entries.length }), 2500);
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
      entries = scan.entries.filter((entry) => isKeyInKvExportScope(displayKey(keyValue(entry)), request));
      revision = scan.revision;
    }

    const file = buildEtcdExportFile(entries, request.path, revision, request.kind, `dbx-etcd-${kvExportFilenameStem(request.path)}-${Date.now()}`, "json");
    const exported = await downloadExport(file);
    if (exported) toast(t("etcd.exported", { count: entries.length }), 2500);
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
    transferKeyFilter.value = "";
    transferCurrentPage.value = 1;
    transferPreviewLoaded.value = false;
    transferOpen.value = true;
    await previewTransfer();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 4000);
  }
}

async function openSync() {
  transferMode.value = "sync";
  targetConnectionId.value = etcdConnections.value.find((connection) => connection.id !== props.connectionId)?.id || "";
  transferKeyFilter.value = "";
  syncPrefix.value = "";
  syncScope.value = "prefix";
  transferConflictPolicy.value = "ABORT";
  transferBundle.value = null;
  transferRows.value = [];
  transferError.value = "";
  transferCurrentPage.value = 1;
  transferLoadingDetail.value = "";
  transferPreviewLoaded.value = false;
  syncConfigurationExpanded.value = true;
  transferOpen.value = true;
}

async function loadSyncPreview() {
  const targetId = targetConnectionId.value;
  if (!targetId) {
    transferError.value = "请选择目标 etcd 连接后再加载预览。";
    return;
  }
  if (syncScope.value === "prefix" && syncPrefix.value.length === 0) {
    transferError.value = "请输入要同步的 Prefix，或选择“全部 Key”。";
    return;
  }
  const prefix = syncScope.value === "all" ? "" : syncPrefix.value;
  transferPreviewGeneration++;
  transferBundle.value = null;
  transferRows.value = [];
  transferCurrentPage.value = 1;
  transferPreviewLoaded.value = false;
  transferLoading.value = true;
  transferLoadingDetail.value = "正在读取源端 Key...";
  transferError.value = "";
  try {
    searchCancelled = false;
    const scan = await scanSyncScope(props.connectionId, prefix, (scanned) => {
      transferLoadingDetail.value = `正在读取源端 Key：${scanned.toLocaleString()} 项`;
    });
    transferBundle.value = bundleFromSummaries(scan.entries, prefix, scan.revision);
    await previewTransfer();
  } catch (error) {
    transferError.value = error instanceof Error ? error.message : String(error);
  } finally {
    transferLoading.value = false;
    transferLoadingDetail.value = "";
  }
}

async function previewTransfer() {
  const bundle = transferBundle.value;
  const targetId = targetConnectionId.value;
  if (!bundle || !targetId) return;
  const generation = ++transferPreviewGeneration;
  transferLoading.value = true;
  transferLoadingDetail.value = "正在比较目标端 Key...";
  transferError.value = "";
  transferPreviewLoaded.value = false;
  try {
    let compared = 0;
    const sourceRows = await mapWithConcurrency(bundle.entries, TARGET_LOOKUP_CONCURRENCY, async (source) => {
      const shown = displayKey(source.key);
      if (normalizedLease(source.metadata) !== "0") {
        return { id: `source:${kvValueByteIdentity(source.key)}`, displayKey: shown, source, operation: "skipped" as const, reason: "Leased keys are skipped by default.", selected: false };
      }
      const target = await api.etcdGet(targetId, shown, { keyBytes: source.key });
      if (generation !== transferPreviewGeneration) throw new Error("同步预览已被新的请求替换。");
      compared++;
      if (compared % 100 === 0 || compared === bundle.entries.length) {
        transferLoadingDetail.value = `正在比较目标端 Key：${compared.toLocaleString()} / ${bundle.entries.length.toLocaleString()} 项`;
      }
      const operation: TransferOperation = !target.found ? "create" : valuesEqual(source.value, target.value) ? "unchanged" : "update";
      const selected = operation === "create" || (operation === "update" && (transferMode.value !== "sync" || transferConflictPolicy.value === "OVERWRITE"));
      return { id: `source:${kvValueByteIdentity(source.key)}`, displayKey: shown, source, target, operation, selected };
    });
    if (generation !== transferPreviewGeneration) return;
    transferRows.value = sourceRows;
    transferCurrentPage.value = 1;
    transferPreviewLoaded.value = true;
    if (transferMode.value === "sync") syncConfigurationExpanded.value = false;
  } catch (error) {
    if (generation !== transferPreviewGeneration) return;
    transferError.value = error instanceof Error ? error.message : String(error);
    transferPreviewLoaded.value = false;
  } finally {
    if (generation === transferPreviewGeneration) {
      transferLoading.value = false;
      transferLoadingDetail.value = "";
    }
  }
}

async function applyTransfer() {
  if (transferHasBlockingConflicts.value) {
    transferError.value = `检测到 ${transferConflictCount.value} 个冲突。当前策略为“遇冲突终止”，未执行任何写入。`;
    return;
  }
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
      if (!row.source) continue;
      await api.etcdPut(targetId, row.displayKey, row.source.value, {
        keyBytes: row.source.key,
        expectedCreateRevision: row.operation === "create" ? "0" : undefined,
        expectedModRevision: row.operation === "update" && row.target?.metadata?.modRevision != null ? String(row.target.metadata.modRevision) : undefined,
      });
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
  transferCurrentPage.value = 1;
  transferPreviewLoaded.value = false;
  if (transferMode.value === "sync") {
    transferBundle.value = null;
  } else if (targetConnectionId.value && transferBundle.value) {
    void previewTransfer();
  }
}

function toggleTransferSelection() {
  const selected = !allPagedTransferRowsSelected.value;
  for (const row of selectablePagedTransferRows.value) row.selected = selected;
}

function clearTransferSelection() {
  for (const row of selectableTransferRows.value) row.selected = false;
}

function searchValueDisplay(value?: api.KvValue | null): string {
  if (!value) return "";
  if (value.encoding === "utf8") return value.data;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(value.data));
  } catch {
    return `[base64:${value.data}]`;
  }
}

function searchSegments(value: string) {
  const query = searchSubmittedQuery.value;
  if (!query) return [{ text: value, matched: false }];
  const normalizedValue = value.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  const segments: Array<{ text: string; matched: boolean }> = [];
  let from = 0;
  let index = normalizedValue.indexOf(normalizedQuery, from);
  while (index >= 0) {
    if (index > from) segments.push({ text: value.slice(from, index), matched: false });
    segments.push({ text: value.slice(index, index + query.length), matched: true });
    from = index + query.length;
    index = normalizedValue.indexOf(normalizedQuery, from);
  }
  if (from < value.length) segments.push({ text: value.slice(from), matched: false });
  return segments.length ? segments : [{ text: value, matched: false }];
}

function toggleSearchSelection() {
  const next = selectedSearchResults.value.length !== searchResults.value.length;
  for (const result of searchResults.value) result.selected = next;
}

function clearSearchResults() {
  searchResults.value = [];
  searchScanned.value = 0;
  searchMatched.value = 0;
  searchHasRun.value = false;
  searchResultLimitReached.value = false;
  searchSubmittedQuery.value = "";
  searchError.value = "";
  searchCancelled = false;
}

async function runSearch() {
  const query = searchQuery.value.trim();
  if (!query) return;
  searchRunning.value = true;
  searchCancelled = false;
  searchScanned.value = 0;
  searchMatched.value = 0;
  searchHasRun.value = true;
  searchResultLimitReached.value = false;
  searchSubmittedQuery.value = query;
  searchError.value = "";
  searchResults.value = [];
  try {
    const scan = await scanConnection(props.connectionId, searchPrefix.value, { onPage: (count) => (searchScanned.value = count) });
    const normalized = query.toLocaleLowerCase();
    const matches = scan.entries
      .map((entry) => {
        const shown = displayKey(keyValue(entry)).toLocaleLowerCase();
        const value = searchValueDisplay(entry.value).toLocaleLowerCase();
        const matchesKey = searchScope.value !== "value" && shown.includes(normalized);
        const matchesValue = searchScope.value !== "key" && value.includes(normalized);
        return { entry, matchesKey, matchesValue };
      })
      .filter((match) => match.matchesKey || match.matchesValue);
    searchMatched.value = matches.length;
    searchResultLimitReached.value = matches.length > 1000;
    searchResults.value = matches.slice(0, 1000).map(({ entry: summary, matchesKey, matchesValue }) => {
      const bytes = keyValue(summary);
      const shown = displayKey(bytes);
      const identity = rememberKeyBytes(shown, bytes);
      return { id: `${identity}:${summary.modRevision || ""}`, displayKey: shown, keyIdentity: identity, summary: { ...summary, key: shown, keyBytes: bytes, keyIdentity: identity }, matchesKey, matchesValue, selected: true };
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

async function openOperations(nextMode: Extract<WorkbenchMode, "maintenance" | "watch" | "lease">) {
  activeOperation.value = nextMode;
  mode.value = nextMode;
  operationsLoading.value = true;
  try {
    operationsStatus.value = await api.etcdStatus(props.connectionId);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  } finally {
    operationsLoading.value = false;
  }
}

function openWatchForKey(route: { key: string; keyBytes?: api.KvValue | null }) {
  watchPreset.value = { key: route.key, keyBytes: route.keyBytes ?? null, scope: "key" };
}

function openWatchWorkspaceAfterCreate() {
  watchPreset.value = null;
  void openOperations("watch");
}

async function refreshLeaseOptions() {
  try {
    leaseOptions.value = (await api.etcdLeaseList(props.connectionId)).leases;
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 4000);
  }
}

function refreshOperations() {
  void openOperations(activeOperation.value);
}

async function exportSearchResults(format: EtcdExportFormat) {
  const selected = selectedSearchResults.value.map((result) => result.summary);
  if (!selected.length) return;
  try {
    const file = buildEtcdExportFile(selected, searchPrefix.value, null, "selection", `dbx-etcd-search-${Date.now()}`, format);
    const exported = await downloadExport(file);
    if (exported) toast(t("etcd.exported", { count: selected.length }), 2500);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 4000);
  }
}

function focusSearch(): boolean {
  if (mode.value === "keys") return browserRef.value?.focusSearch() ?? false;
  mode.value = "search";
  return true;
}

function refresh(): boolean {
  if (mode.value === "keys") return browserRef.value?.refresh() ?? false;
  if (mode.value === "search") void runSearch();
  if (isOperationsMode.value) void openOperations(activeOperation.value);
  return true;
}

defineExpose({ focusSearch, refresh });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-14 shrink-0 items-center gap-3 border-b px-4">
      <div class="flex rounded-md border p-0.5">
        <Button size="sm" :variant="mode === 'keys' ? 'secondary' : 'ghost'" class="h-8 gap-1.5 px-3 text-sm" @click="mode = 'keys'"><KeyRound class="h-4 w-4" /> {{ t("etcd.key") }}</Button>
        <Button size="sm" :variant="mode === 'search' ? 'secondary' : 'ghost'" class="h-8 gap-1.5 px-3 text-sm" @click="mode = 'search'"><Search class="h-4 w-4" /> {{ t("etcd.globalSearch") }}</Button>
      </div>
      <Button size="sm" :variant="mode === 'maintenance' ? 'secondary' : 'ghost'" class="h-8 gap-1.5 px-2.5 text-sm" @click="openOperations('maintenance')"><Wrench class="h-4 w-4" />{{ t("etcd.admin.maintenance") }}</Button>
      <Button
        size="sm"
        :variant="mode === 'watch' ? 'secondary' : 'ghost'"
        class="h-8 gap-1.5 px-2.5 text-sm"
        @click="
          watchPreset = null;
          void openOperations('watch');
        "
        ><Activity class="h-4 w-4" />{{ t("etcd.admin.watch") }}</Button
      >
      <Button size="sm" :variant="mode === 'lease' ? 'secondary' : 'ghost'" class="h-8 gap-1.5 px-2.5 text-sm" @click="openOperations('lease')"><KeyRound class="h-4 w-4" />{{ t("etcd.admin.lease") }}</Button>
      <div class="flex-1" />
      <Badge v-if="readOnly" variant="outline">{{ t("connection.readOnly") }}</Badge>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button size="sm" variant="outline" class="h-8 gap-1.5"><Download class="h-3.5 w-3.5" /> {{ t("etcd.export") }} <ChevronDown class="h-3.5 w-3.5" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-auto whitespace-nowrap">
          <DropdownMenuItem @select="void exportAll('json')">{{ t("etcd.exportAllJson") }}</DropdownMenuItem>
          <DropdownMenuItem @select="void exportAll('csv')">{{ t("etcd.exportAllCsv") }}</DropdownMenuItem>
          <DropdownMenuItem @select="void exportAll('markdown')">{{ t("etcd.exportAllMarkdown") }}</DropdownMenuItem>
          <template v-if="selectedTreeKeys.length">
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="void exportTreeSelection('json')">{{ t("etcd.exportSelectionJson") }}</DropdownMenuItem>
            <DropdownMenuItem @select="void exportTreeSelection('csv')">{{ t("etcd.exportSelectionCsv") }}</DropdownMenuItem>
            <DropdownMenuItem @select="void exportTreeSelection('markdown')">{{ t("etcd.exportSelectionMarkdown") }}</DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="sm" variant="destructive" class="h-8 gap-1.5" :disabled="readOnly || selectedTreeKeys.length === 0 || batchDeleting" @click="batchDeleteOpen = true"><Trash2 class="h-3.5 w-3.5" />{{ t("etcd.delete") }}</Button>
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
      :enable-multi-select="true"
      :on-watch-key="openWatchForKey"
      export-format="dbx-etcd-bundle"
      export-file-extension=".dbx-etcd.json"
      export-fallback-name="etcd-key"
      :lease-options="leaseOptions"
      :on-lease-options-requested="refreshLeaseOptions"
      @refresh-requested="refreshTtlCapability"
      @selection-change="updateTreeSelection"
    />

    <div v-if="mode === 'search'" class="flex min-h-0 flex-1 flex-col">
      <form class="grid shrink-0 gap-2 border-b p-3 md:grid-cols-[minmax(160px,240px)_140px_minmax(0,1fr)_auto]" @submit.prevent="runSearch">
        <Input v-model="searchPrefix" :placeholder="t('etcd.searchPrefix')" autocomplete="off" />
        <Select v-model="searchScope" :disabled="searchRunning">
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{{ t("etcd.searchAll") }}</SelectItem>
            <SelectItem value="key">Key</SelectItem>
            <SelectItem value="value">Value</SelectItem>
          </SelectContent>
        </Select>
        <Input v-model="searchQuery" :placeholder="t('etcd.searchPlaceholder')" autocomplete="off" />
        <div class="flex gap-2">
          <Button type="submit" :disabled="searchRunning || !searchQuery.trim()"><Loader2 v-if="searchRunning" class="mr-2 h-4 w-4 animate-spin" />{{ t("etcd.globalSearch") }}</Button>
          <Button v-if="searchRunning" type="button" variant="outline" @click="cancelSearch">{{ t("common.cancel") }}</Button>
        </div>
      </form>
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <Badge variant="outline">已扫描 {{ searchScanned }} 个 Key</Badge>
        <Badge variant="outline">命中 {{ searchMatched }} 个</Badge>
        <Badge v-if="searchResults.length" variant="outline">已选 {{ selectedSearchResults.length }} 个</Badge>
        <Badge v-if="searchRunning" variant="outline" class="gap-1.5"><Loader2 class="h-3 w-3 animate-spin" />扫描中</Badge>
        <Badge v-else-if="searchCancelled && searchHasRun" variant="outline" class="border-amber-500/50 text-amber-700 dark:text-amber-300">已取消，结果可能不完整</Badge>
        <Badge v-if="searchResultLimitReached" variant="outline" class="border-amber-500/50 text-amber-700 dark:text-amber-300">仅显示前 1,000 个结果</Badge>
        <div class="flex-1" />
        <Button v-if="searchResults.length" size="sm" variant="ghost" class="h-7 px-2" @click="toggleSearchSelection">{{ selectedSearchResults.length === searchResults.length ? "取消全选" : "全选结果" }}</Button>
        <Button v-if="searchHasRun || searchError" size="sm" variant="ghost" class="h-7 gap-1.5 px-2" :disabled="searchRunning" :title="t('etcd.clearSearchResults')" @click="clearSearchResults"><Eraser class="h-3.5 w-3.5" />{{ t("etcd.clearSearchResults") }}</Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button size="sm" variant="outline" class="h-7 gap-1.5" :disabled="selectedSearchResults.length === 0"><Download class="h-3.5 w-3.5" /> {{ t("etcd.exportResults") }} <ChevronDown class="h-3.5 w-3.5" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-40">
            <DropdownMenuItem @select="void exportSearchResults('json')">JSON（可导入）</DropdownMenuItem>
            <DropdownMenuItem @select="void exportSearchResults('csv')">表格（CSV）</DropdownMenuItem>
            <DropdownMenuItem @select="void exportSearchResults('markdown')">Markdown</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div v-if="searchError" class="border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{{ searchError }}</div>
      <div v-if="searchResultLimitReached" class="border-b border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">结果过多，已保留前 1,000 项用于查看和导出。请使用 Prefix 缩小范围。</div>
      <div class="min-h-0 flex-1 overflow-auto">
        <div v-if="searchResults.length" class="divide-y">
          <div v-for="result in searchResults" :key="result.id" class="flex min-w-0 gap-3 px-3 py-3 transition-colors hover:bg-accent/50">
            <div class="flex w-5 shrink-0 items-start pt-1"><input v-model="result.selected" type="checkbox" class="h-4 w-4 accent-primary" :aria-label="`选择 ${result.displayKey}`" /></div>
            <button type="button" class="min-w-0 flex-1 text-left" @click="openSearchResult(result)">
              <div class="flex min-w-0 items-center gap-2">
                <code class="min-w-0 flex-1 truncate text-sm font-medium text-primary"
                  ><template v-for="(segment, index) in searchSegments(result.displayKey)" :key="index"
                    ><mark v-if="segment.matched && result.matchesKey" class="rounded-sm bg-amber-300/80 px-0.5 text-foreground dark:bg-amber-500/40">{{ segment.text }}</mark
                    ><span v-else>{{ segment.text }}</span></template
                  ></code
                >
                <Badge v-if="result.matchesKey" variant="secondary" class="shrink-0">Key</Badge>
                <Badge v-if="result.matchesValue" variant="outline" class="shrink-0">Value</Badge>
                <span class="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">rev {{ result.summary.modRevision || "-" }}</span>
                <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground" />
              </div>
              <pre
                class="mt-1.5 max-h-14 overflow-hidden text-ellipsis whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground"
              ><template v-for="(segment, index) in searchSegments(searchValueDisplay(result.summary.value) || '(空值)')" :key="index"><mark v-if="segment.matched && result.matchesValue" class="rounded-sm bg-amber-300/80 px-0.5 text-foreground dark:bg-amber-500/40">{{ segment.text }}</mark><span v-else>{{ segment.text }}</span></template></pre>
              <span class="mt-1 block font-mono text-[11px] text-muted-foreground sm:hidden">rev {{ result.summary.modRevision || "-" }}</span>
            </button>
          </div>
        </div>
        <div v-else-if="searchRunning" class="flex h-52 items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 h-4 w-4 animate-spin" />正在扫描 Key...</div>
        <div v-else-if="searchHasRun" class="flex h-52 items-center justify-center px-6 text-center text-sm text-muted-foreground">{{ searchCancelled ? "搜索已取消，未找到可显示的结果。" : "未找到匹配的 Key 或 Value。" }}</div>
        <div v-else class="flex h-52 items-center justify-center px-6 text-center text-sm text-muted-foreground">输入关键词后开始搜索。可使用 Prefix 限定扫描范围。</div>
      </div>
    </div>
    <div v-if="operationsStatus || operationsLoading || watchPreset" v-show="isOperationsMode" class="min-h-0 flex-1 overflow-auto p-4">
      <div v-if="operationsLoading && !operationsStatus" class="flex h-32 items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 h-4 w-4 animate-spin" />加载集群状态...</div>
      <EtcdAdminConsole
        v-else-if="operationsStatus || watchPreset"
        :connection-id="connectionId"
        :status="operationsStatus"
        :sections="[activeOperation]"
        :initial-section="activeOperation"
        :watch-preset="watchPreset"
        :watch-key-suggestions="watchKeySuggestions"
        @refresh="refreshOperations"
        @watch-created="openWatchWorkspaceAfterCreate"
        @watch-dialog-dismissed="watchPreset = null"
      />
    </div>

    <Dialog v-model:open="transferOpen">
      <DialogContent class="flex h-[min(86vh,820px)] max-w-[min(96vw,1180px)] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader class="shrink-0 gap-0 border-b px-5 py-3">
          <DialogTitle>{{ transferMode === "sync" ? "同步 Key 到其他连接" : t("etcd.importPreview") }}</DialogTitle>
          <p v-if="transferMode === 'sync'" class="mt-1 text-xs leading-4 text-muted-foreground">单向复制源端 Key，不会删除源端或目标端数据。</p>

          <template v-if="transferMode === 'sync'">
            <div v-if="transferPreviewLoaded && !syncConfigurationExpanded" class="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border bg-muted/20 px-3 py-2 text-xs">
              <span class="text-muted-foreground"
                >目标 <strong class="ml-1 font-medium text-foreground">{{ selectedTargetConnectionName }}</strong></span
              >
              <span class="min-w-0 text-muted-foreground"
                >范围 <strong class="ml-1 font-mono font-medium text-foreground">{{ syncScopeSummary }}</strong></span
              >
              <span class="text-muted-foreground"
                >策略 <strong class="ml-1 font-medium text-foreground">{{ conflictPolicyLabel(transferConflictPolicy) }}</strong></span
              >
              <Button size="sm" variant="ghost" class="ml-auto h-7 px-2 text-xs" @click="syncConfigurationExpanded = true">调整设置</Button>
            </div>

            <div v-else class="mt-3 rounded-md border bg-muted/10 p-3">
              <div class="grid gap-3 lg:grid-cols-[minmax(180px,0.75fr)_auto_minmax(260px,1.35fr)]">
                <div class="flex min-w-0 flex-col gap-1.5">
                  <span class="text-xs font-medium text-foreground">目标连接</span>
                  <Select :model-value="targetConnectionId" :disabled="transferLoading || transferApplying" @update:model-value="onTransferTargetChange">
                    <SelectTrigger class="h-9"><SelectValue :placeholder="t('etcd.targetConnection')" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="connection in etcdConnections.filter((connection) => connection.id !== props.connectionId)" :key="connection.id" :value="connection.id">{{ connection.name }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div class="flex min-w-0 flex-col gap-1.5">
                  <span class="text-xs font-medium text-foreground">同步范围</span>
                  <div class="flex h-9 w-fit max-w-full rounded-md border bg-background p-0.5">
                    <label class="cursor-pointer">
                      <input v-model="syncScope" type="radio" name="etcd-sync-scope" value="prefix" class="sr-only" :disabled="transferLoading || transferApplying" />
                      <span class="flex h-8 items-center rounded px-3 text-xs" :class="syncScope === 'prefix' ? 'bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'">Prefix</span>
                    </label>
                    <label class="cursor-pointer">
                      <input v-model="syncScope" type="radio" name="etcd-sync-scope" value="all" class="sr-only" :disabled="transferLoading || transferApplying" />
                      <span class="flex h-8 items-center rounded px-3 text-xs" :class="syncScope === 'all' ? 'bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'">全部 Key</span>
                    </label>
                  </div>
                </div>

                <label v-if="syncScope === 'prefix'" class="flex min-w-0 flex-col gap-1.5">
                  <span class="text-xs font-medium text-foreground">Prefix</span>
                  <span class="relative">
                    <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input v-model="syncPrefix" class="h-9 w-full pl-9 font-mono text-sm" :disabled="transferLoading || transferApplying" autocomplete="off" placeholder="例如 /apps/ 或 test/" @keyup.enter="void loadSyncPreview()" />
                  </span>
                </label>
                <div v-else class="flex min-w-0 flex-col gap-1.5">
                  <span class="text-xs font-medium text-foreground">扫描范围</span>
                  <div class="flex h-9 items-center rounded-md bg-muted/50 px-3 text-xs text-muted-foreground">整个 Keyspace，最多预览 10,000 个 Key</div>
                </div>
              </div>

              <div class="mt-3 grid gap-2 border-t pt-3 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="mr-1 text-xs font-medium text-foreground">冲突策略</span>
                  <div class="flex h-9 rounded-md border bg-background p-0.5">
                    <label v-for="policy in ['ABORT', 'SKIP', 'OVERWRITE'] as EtcdConflictPolicy[]" :key="policy" class="cursor-pointer">
                      <input v-model="transferConflictPolicy" type="radio" name="etcd-conflict-policy" :value="policy" class="sr-only" :disabled="transferLoading || transferApplying" />
                      <span class="flex h-8 items-center rounded px-3 text-xs" :class="transferConflictPolicy === policy ? 'bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'">{{ conflictPolicyLabel(policy) }}</span>
                    </label>
                  </div>
                </div>
                <p class="min-w-0 text-xs leading-5" :class="transferConflictPolicy === 'OVERWRITE' ? 'text-destructive' : 'text-muted-foreground'">
                  <AlertTriangle v-if="transferConflictPolicy === 'OVERWRITE'" class="mr-1 inline h-3.5 w-3.5 -translate-y-px" />{{
                    transferConflictPolicy === "ABORT" ? "发现同名异值 Key 时停止，不执行任何写入。" : transferConflictPolicy === "SKIP" ? "跳过同名异值 Key，只创建目标端不存在的 Key。" : "以源端值覆盖目标端同名 Key，请在执行前核对冲突项。"
                  }}
                </p>
                <Button v-if="transferPreviewLoaded" size="sm" variant="ghost" class="h-7 px-2 text-xs" @click="syncConfigurationExpanded = false">收起设置</Button>
              </div>
            </div>
          </template>

          <div v-else class="mt-3">
            <Select :model-value="targetConnectionId" :disabled="transferLoading || transferApplying" @update:model-value="onTransferTargetChange">
              <SelectTrigger><SelectValue :placeholder="t('etcd.targetConnection')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="connection in etcdConnections" :key="connection.id" :value="connection.id">{{ connection.name }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </DialogHeader>
        <div v-if="transferError" class="border-b px-5 py-2 text-sm text-destructive">{{ transferError }}</div>
        <div v-if="targetReadOnly" class="border-b bg-amber-500/10 px-5 py-2 text-xs text-amber-700 dark:text-amber-300">{{ t("connection.readOnly") }}: {{ t("etcd.targetReadOnly") }}</div>
        <div class="min-h-0 flex-1">
          <div v-if="transferLoading" class="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <span class="flex items-center"><Loader2 class="mr-2 h-4 w-4 animate-spin" />{{ t("etcd.preparingPreview") }}</span
            ><span v-if="transferLoadingDetail" class="text-xs">{{ transferLoadingDetail }}</span>
          </div>
          <div v-else-if="transferMode === 'sync' && !transferPreviewLoaded" class="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">选择同步范围、目标连接和冲突策略后生成预览。Prefix 会在服务端限制扫描范围，结果不会在输入过程中自动加载。</div>
          <div v-else class="flex h-full min-h-0 flex-col">
            <div v-if="transferMode === 'sync'" class="flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2.5 text-xs text-muted-foreground">
              <Badge variant="outline">共 {{ transferRows.length }} 项</Badge>
              <Badge variant="outline" class="text-emerald-700 dark:text-emerald-300">新增 {{ transferCreateCount }}</Badge>
              <Badge v-if="transferConflictCount" variant="outline" class="text-amber-700 dark:text-amber-300">冲突 {{ transferConflictCount }}</Badge>
              <Badge v-if="transferUnchangedCount" variant="outline">无变化 {{ transferUnchangedCount }}</Badge>
              <Badge v-if="transferSkippedCount" variant="outline">跳过 {{ transferSkippedCount }}</Badge>
              <span v-if="transferHasBlockingConflicts" class="ml-auto text-destructive">当前策略要求解决冲突后才能执行</span>
            </div>
            <div class="flex shrink-0 items-center gap-2 border-b px-5 py-2.5">
              <div class="relative min-w-0 flex-1">
                <Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input v-model="transferKeyFilter" class="h-8 pl-8 text-sm" autocomplete="off" placeholder="筛选 Key" />
              </div>
              <span class="shrink-0 text-xs text-muted-foreground">{{ filteredTransferRows.length }} / {{ transferRows.length }}</span>
              <div v-if="filteredTransferRows.length > TRANSFER_PREVIEW_PAGE_SIZE" class="flex items-center gap-1 text-xs text-muted-foreground">
                <Button size="sm" variant="ghost" class="h-8 w-8 p-0" title="上一页" :disabled="transferCurrentPage <= 1" @click="transferCurrentPage--"><ChevronLeft class="h-4 w-4" /></Button>
                <span class="min-w-16 text-center">{{ transferCurrentPage }} / {{ transferPageCount }}</span>
                <Button size="sm" variant="ghost" class="h-8 w-8 p-0" title="下一页" :disabled="transferCurrentPage >= transferPageCount" @click="transferCurrentPage++"><ChevronRight class="h-4 w-4" /></Button>
              </div>
              <Button size="sm" variant="ghost" class="h-8 shrink-0 px-2.5 text-xs" :disabled="transferApplying || selectedTransferRows.length === 0" @click="clearTransferSelection">清空选择</Button>
            </div>
            <div class="min-h-0 flex-1 overflow-auto">
              <table class="w-full text-left text-sm">
                <thead class="sticky top-0 bg-muted/90 text-xs text-muted-foreground">
                  <tr>
                    <th class="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        class="h-4 w-4 accent-primary"
                        aria-label="全选当前页中可执行的操作"
                        :checked="allPagedTransferRowsSelected"
                        :indeterminate="somePagedTransferRowsSelected"
                        :disabled="transferApplying || selectablePagedTransferRows.length === 0"
                        @change="toggleTransferSelection"
                      />
                    </th>
                    <th class="px-3 py-2">Key</th>
                    <th class="px-3 py-2">{{ t("etcd.operation") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in pagedTransferRows" :key="row.id" class="border-b">
                    <td class="px-3 py-2"><input v-model="row.selected" type="checkbox" class="h-4 w-4 accent-primary" :disabled="!isTransferRowSelectable(row)" /></td>
                    <td class="max-w-xl truncate px-3 py-2 font-mono text-xs">{{ row.displayKey }}</td>
                    <td class="px-3 py-2">
                      <Badge :variant="transferOperationVariant(row)" :class="row.operation === 'update' && transferConflictPolicy !== 'OVERWRITE' ? 'border-amber-500/50 text-amber-700 dark:text-amber-300' : ''">{{ transferOperationLabel(row) }}</Badge>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="filteredTransferRows.length === 0" class="flex h-32 items-center justify-center text-sm text-muted-foreground">未找到匹配的 Key</div>
            </div>
          </div>
        </div>
        <DialogFooter class="shrink-0 !mx-0 !mb-0 rounded-b-xl border-t !px-5 !py-3">
          <span class="mr-auto text-xs text-muted-foreground">{{ t("etcd.selectedOperations", { count: selectedTransferRows.length }) }}</span>
          <Button variant="outline" :disabled="transferApplying" @click="transferOpen = false">{{ t("common.cancel") }}</Button>
          <Button v-if="transferMode === 'sync' && !transferPreviewLoaded" :disabled="transferLoading || transferApplying || !canLoadSyncPreview" @click="void loadSyncPreview()"><Loader2 v-if="transferLoading" class="mr-2 h-4 w-4 animate-spin" />预览</Button>
          <Button
            v-else
            :variant="transferMode === 'sync' && transferConflictPolicy === 'OVERWRITE' && transferConflictCount > 0 ? 'destructive' : 'default'"
            :disabled="targetReadOnly || transferLoading || transferApplying || transferHasBlockingConflicts || selectedTransferRows.length === 0"
            @click="applyTransfer"
          >
            <Loader2 v-if="transferApplying" class="mr-2 h-4 w-4 animate-spin" />
            {{ t("etcd.applyOperations") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <DangerConfirmDialog
      v-model:open="batchDeleteOpen"
      :title="t('etcd.batchDeleteTitle')"
      :message="t('etcd.batchDeleteConfirm', { count: selectedTreeKeys.length })"
      :details="selectedTreeKeyDetails()"
      :confirm-label="t('etcd.batchDelete')"
      :loading="batchDeleting"
      :close-on-confirm="false"
      @confirm="deleteSelectedTreeKeys"
    />
  </div>
</template>
