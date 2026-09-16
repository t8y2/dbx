<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onDeactivated, ref, watch } from "vue";
import { ArrowRightLeft, Download, FileUp, Loader2, Search, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import KvKeyBrowser from "@/components/kv/KvKeyBrowser.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { kvExportFilenameStem, type KvExportScopeRequest } from "@/lib/kv/kvExportScope";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { useConsulStore } from "@/stores/consulStore";
import { isCurrentWatchEvent, nextWatchIndex } from "@/lib/consul/watchState";
import type { ConsulDeletePrefixPreview, ConsulDeletePrefixReport, ConsulImportConflictPolicy, ConsulImportPreview, ConsulImportReport, ConsulKvBundle, ConsulSearchMatch, ConsulScope, ConsulWatchEvent } from "@/types/consul";

const props = defineProps<{ connectionId: string }>();
const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const consulStore = useConsulStore();
const browserRef = ref<InstanceType<typeof KvKeyBrowser> | null>(null);
const fileInputRef = ref<HTMLInputElement>();
const readOnly = computed(() => connectionIsEffectivelyReadOnly(connectionStore.getConfig(props.connectionId)));
const consulConnections = computed(() => connectionStore.connections.filter((connection) => connection.db_type === "consul"));
const transferTargetConnections = computed(() => (transferMode.value === "migration" ? consulConnections.value.filter((connection) => connection.id !== props.connectionId) : consulConnections.value));

const searchOpen = ref(false);
const searchQuery = ref("");
const searchPrefix = ref("");
const searchScope = ref<"all" | "key" | "value">("all");
const searchCaseSensitive = ref(false);
const searchRunning = ref(false);
const searchScanned = ref(0);
const searchMatched = ref(0);
const searchLimited = ref(false);
const searchFiltered = ref(false);
const searchResults = ref<ConsulSearchMatch[]>([]);
const searchError = ref("");
const exportingSearchResults = ref(false);
const searchHighlight = ref<{ key: string; query: string; caseSensitive: boolean; matchesKey: boolean; matchesValue: boolean } | null>(null);
let searchRequestId = "";
let searchConnectionId = "";
let searchScopeAtStart: ConsulScope = { datacenter: "", namespace: "", partition: "" };
let searchGeneration = 0;
let searchProgressTimer: ReturnType<typeof setTimeout> | null = null;
let searchProgressSequence = 0;

const exportOpen = ref(false);
const exportPrefix = ref("");
const exporting = ref(false);

const transferOpen = ref(false);
const transferMode = ref<"import" | "migration">("import");
const transferBundle = ref<ConsulKvBundle | null>(null);
const transferTargetId = ref("");
const transferSourcePrefix = ref("");
const transferPolicy = ref<ConsulImportConflictPolicy>("abort");
const transferPreview = ref<ConsulImportPreview | null>(null);
const transferReport = ref<ConsulImportReport | null>(null);
const transferLoading = ref(false);
const transferApplying = ref(false);
const transferError = ref("");
const transferTargetReadOnly = computed(() => connectionIsEffectivelyReadOnly(connectionStore.getConfig(transferTargetId.value)));

const deleteOpen = ref(false);
const deletePrefix = ref("");
const deletePreview = ref<ConsulDeletePrefixPreview | null>(null);
const deleteReport = ref<ConsulDeletePrefixReport | null>(null);
const deleteLoading = ref(false);
const deleteExecuting = ref(false);
const deleteError = ref("");
type PrefixSuggestionTarget = "export" | "migration" | "delete";
const prefixSuggestionTarget = ref<PrefixSuggestionTarget | null>(null);
const prefixSuggestions = ref<Array<{ key: string }>>([]);
const prefixSuggestionIndex = ref(-1);
const prefixSuggestionDebounceMs = 300;
let prefixSuggestionTimer: ReturnType<typeof setTimeout> | null = null;
let prefixSuggestionRequestId = 0;
const watchPrefix = ref("");
const watchMode = ref<"key" | "prefix">("prefix");
const watchRunning = ref(false);
const watchIndex = ref<string | null>(null);
const watchError = ref("");
let watchOperationId = "";
let watchUnlisten: (() => void) | null = null;
let watchConnectionId = "";
let watchScope: ConsulScope = { datacenter: "", namespace: "", partition: "" };
let watchGeneration = 0;

function currentScope() {
  const external = connectionStore.getConfig(props.connectionId)?.external_config;
  const config = external && typeof external === "object" && !Array.isArray(external) ? (external as Record<string, unknown>) : {};
  return {
    datacenter: String(config.datacenter || config.consulDatacenter || config.consul_datacenter || ""),
    namespace: String(config.namespace || config.consulNamespace || config.consul_namespace || ""),
    partition: String(config.partition || config.consulPartition || config.consul_partition || ""),
  };
}

async function startWatch() {
  if (watchRunning.value) return;
  watchError.value = "";
  watchIndex.value = null;
  watchConnectionId = props.connectionId;
  watchScope = currentScope();
  consulStore.bindConnection(watchConnectionId, watchScope);
  watchGeneration = consulStore.generation;
  watchOperationId = globalThis.crypto?.randomUUID?.() || `watch-${Date.now()}`;
  consulStore.registerOperation(watchOperationId);
  watchRunning.value = true;
  if (isTauriRuntime()) {
    const { listen } = await import("@tauri-apps/api/event");
    try {
      watchUnlisten = await listen<ConsulWatchEvent>("consul-watch", (event) => {
        const payload = event.payload;
        if (!isCurrentWatchEvent({ connectionId: watchConnectionId, operationId: watchOperationId, generation: watchGeneration }, payload)) return;
        if (payload.error) {
          if (watchRunning.value && !payload.error.includes("CANCELLED")) toast(payload.error, 5000);
          void stopWatch();
          return;
        }
        if (payload.result) applyWatchResult(payload.result);
        if (watchRunning.value) void startTauriWatchRequest();
      });
      await startTauriWatchRequest();
    } catch (error) {
      if (watchRunning.value) toast(error instanceof Error ? error.message : String(error), 5000);
      await stopWatch();
    }
    return;
  }
  while (watchRunning.value) {
    try {
      const result = await api.consulBlockingQuery(watchConnectionId, {
        operationId: watchOperationId,
        generation: watchGeneration,
        key: watchPrefix.value,
        prefix: watchMode.value === "prefix",
        index: watchIndex.value,
        waitSeconds: 300,
      });
      applyWatchResult(result);
    } catch (error) {
      if (watchRunning.value && !String(error).includes("CANCELLED")) {
        watchError.value = error instanceof Error ? error.message : String(error);
        toast(watchError.value, 5000);
      }
      break;
    }
  }
  watchRunning.value = false;
  consulStore.completeOperation(watchOperationId);
}

function watchRequest() {
  return {
    operationId: watchOperationId,
    generation: watchGeneration,
    key: watchPrefix.value,
    prefix: watchMode.value === "prefix",
    index: watchIndex.value,
    waitSeconds: 300,
  };
}

async function watchSelectedKey(route: { key: string }) {
  if (watchRunning.value && watchMode.value === "key" && watchPrefix.value === route.key) {
    await stopWatch();
    return;
  }
  if (watchRunning.value) await stopWatch();
  watchMode.value = "key";
  watchPrefix.value = route.key;
  await startWatch();
}

async function startTauriWatchRequest() {
  await api.consulWatchStart(watchConnectionId, watchRequest());
}

function applyWatchResult(result: import("@/types/consul").ConsulBlockingResponse) {
  const next = nextWatchIndex(watchIndex.value, result.metadata.index);
  watchIndex.value = next.index;
  if (result.changed) browserRef.value?.refresh();
}

async function stopWatch() {
  if (!watchRunning.value) return;
  watchRunning.value = false;
  await api.consulCancelBlocking(watchConnectionId, watchScope, watchGeneration, watchOperationId).catch(() => false);
  watchUnlisten?.();
  watchUnlisten = null;
  consulStore.completeOperation(watchOperationId);
}

const consulApi = {
  listPrefix: api.consulListPrefix,
  get: api.consulGet,
  put: api.consulPut,
  deleteKey: api.consulDelete,
  rename: renameConsulKey,
  copy: copyConsulKey,
  exportScope: exportConsulScope,
};

async function mutateConsulKey(connectionId: string, request: { key: string; newKey: string; expectedModRevision?: api.KvInt64 | null }, copy: boolean) {
  if (!request.expectedModRevision) throw new Error(`CONSUL_CAS_REQUIRED: ${t("consul.ui.sourceKeyMissingModifyIndex")}`);
  const result = await api.consulRenameKey(connectionId, request.key, request.newKey, request.expectedModRevision, copy);
  if (!result.committed) {
    const detail = result.errors.map((error) => `[${error.opIndex}] ${error.message}`).join("; ");
    throw new Error(`CONSUL_TXN_CONFLICT: ${detail || t("consul.ui.transactionRejected")}`);
  }
  return result;
}

async function renameConsulKey(connectionId: string, request: { key: string; newKey: string; expectedModRevision?: api.KvInt64 | null }) {
  await mutateConsulKey(connectionId, request, false);
  return { renamed: true };
}

async function copyConsulKey(connectionId: string, request: { key: string; newKey: string; expectedModRevision?: api.KvInt64 | null }) {
  await mutateConsulKey(connectionId, request, true);
  return { copied: true };
}

const labels = computed(() => ({
  prefixPlaceholder: t("consul.prefixPlaceholder"),
  newKey: t("consul.newKey"),
  loadingKeys: t("consul.loadingKeys"),
  empty: t("consul.empty"),
  loadMore: t("consul.loadMore"),
  selectKey: t("consul.selectKey"),
  loadingValue: t("consul.loadingValue"),
  notFound: t("consul.notFound"),
  edit: t("consul.edit"),
  editKey: t("consul.editKey"),
  delete: t("consul.delete"),
  deleteTitle: t("consul.deleteTitle"),
  keyLabel: t("consul.keyLabel"),
  keyPlaceholder: t("consul.keyPlaceholder"),
  keyRequired: t("consul.keyRequired"),
  rootReadonly: t("consul.rootReadonly"),
  saved: t("consul.saved"),
  deleted: t("consul.deleted"),
  base64Readonly: t("consul.base64Readonly"),
  rename: t("consul.rename"),
  clone: t("consul.clone"),
  copyKey: t("consul.copyKey"),
  export: t("consul.export"),
  value: t("consul.value"),
  valueContent: t("consul.valueContent"),
  format: t("consul.format"),
  metadata: t("consul.metadata"),
  prettyJson: t("consul.prettyJson"),
  invalidJson: t("consul.invalidJson"),
  summarySize: t("consul.summarySize"),
  conflict: t("consul.conflict"),
  keyAlreadyExists: t("consul.keyAlreadyExists"),
  aclFiltered: t("consul.aclFiltered"),
  locked: t("consul.locked"),
  sessionProtected: t("consul.ui.sessionProtected"),
  sessionProtectedHint: t("consul.ui.sessionProtectedHint"),
  sessionId: t("consul.ui.sessionId"),
  copy: t("consul.ui.copy"),
  copied: t("consul.ui.copied"),
  copyFailed: t("consul.ui.copyFailed"),
  valueTooLarge: t("consul.valueTooLarge"),
  deletePrefix: t("consul.tools.deletePrefix"),
  watch: t("consul.watchKey"),
  stopWatching: t("consul.stopWatching"),
}));

async function exportConsulScope(connectionId: string, request: KvExportScopeRequest) {
  exporting.value = true;
  try {
    const bundle = await api.consulExportBundle(connectionId, { path: request.path, kind: request.kind });
    const filename = `dbx-consul-${kvExportFilenameStem(request.path)}-${Date.now()}.json`;
    const saved = await saveBundle(bundle, filename);
    if (saved) toast(t("consul.tools.exported", { count: bundle.entries.length }), 2500);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  } finally {
    exporting.value = false;
  }
}

async function saveJsonFile(payload: unknown, filename: string, fileType: string): Promise<boolean> {
  const content = JSON.stringify(payload, null, 2);
  if (isTauriRuntime()) {
    const [{ save }, { writeTextFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const path = await save({ defaultPath: filename, filters: [{ name: fileType, extensions: ["json"] }] });
    if (!path) return false;
    await writeTextFile(path, content);
    return true;
  }
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

async function saveBundle(bundle: ConsulKvBundle, filename: string): Promise<boolean> {
  return saveJsonFile(bundle, filename, t("consul.ui.bundleFileType"));
}

async function exportPrefixBundle() {
  await exportConsulScope(props.connectionId, { path: exportPrefix.value, kind: "prefix" });
  exportOpen.value = false;
}

function openSearch() {
  searchOpen.value = true;
  searchError.value = "";
}

async function runSearch() {
  const query = searchQuery.value.trim();
  if (!query || searchRunning.value) return;
  consulStore.bindConnection(props.connectionId, currentScope());
  searchConnectionId = props.connectionId;
  searchScopeAtStart = currentScope();
  searchGeneration = consulStore.generation;
  searchRequestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  searchRunning.value = true;
  searchScanned.value = 0;
  searchMatched.value = 0;
  searchLimited.value = false;
  searchFiltered.value = false;
  searchResults.value = [];
  searchError.value = "";
  startSearchProgress();
  try {
    const result = await api.consulSearch(props.connectionId, {
      requestId: searchRequestId,
      prefix: searchPrefix.value,
      query,
      searchKeys: searchScope.value !== "value",
      searchValues: searchScope.value !== "key",
      caseSensitive: searchCaseSensitive.value,
      limit: 1000,
      maxScan: 10_000,
      generation: searchGeneration,
    });
    if (props.connectionId !== searchConnectionId || consulStore.generation !== searchGeneration) return;
    searchResults.value = result.matches;
    searchScanned.value = result.scanned;
    searchMatched.value = result.matched;
    searchLimited.value = result.limited;
    searchFiltered.value = Boolean(result.filteredByAcls);
  } catch (error) {
    if (props.connectionId !== searchConnectionId || consulStore.generation !== searchGeneration) return;
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("CONSUL_SEARCH_CANCELLED")) searchError.value = message;
  } finally {
    stopSearchProgress();
    searchRunning.value = false;
  }
}

async function exportSearchResults() {
  if (!searchResults.value.length || exportingSearchResults.value) return;
  exportingSearchResults.value = true;
  try {
    const report = {
      format: "dbx-consul-kv-search-results",
      version: 1,
      exportedAtUnixMs: Date.now(),
      source: currentScope(),
      search: {
        query: searchQuery.value.trim(),
        prefix: searchPrefix.value.trim(),
        scope: searchScope.value,
        caseSensitive: searchCaseSensitive.value,
        scanned: searchScanned.value,
        matched: searchMatched.value,
        limited: searchLimited.value,
        filteredByAcls: searchFiltered.value,
      },
      results: searchResults.value,
    };
    const saved = await saveJsonFile(report, `dbx-consul-search-${Date.now()}.json`, t("consul.tools.searchResultsFileType"));
    if (saved) toast(t("consul.tools.searchResultsExported", { count: searchResults.value.length }), 2500);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  } finally {
    exportingSearchResults.value = false;
  }
}

function startSearchProgress() {
  stopSearchProgress();
  const sequence = ++searchProgressSequence;
  const poll = async () => {
    if (sequence !== searchProgressSequence || !searchRequestId) {
      searchProgressTimer = null;
      return;
    }
    try {
      const progress = await api.consulSearchProgress(searchConnectionId, searchRequestId, searchScopeAtStart, searchGeneration);
      if (progress.running) searchScanned.value = progress.scanned;
    } catch {
      // Progress is best-effort; the search result carries the authoritative count.
    }
    if (sequence === searchProgressSequence && searchRequestId)
      searchProgressTimer = setTimeout(() => {
        void poll();
      }, 250);
    else searchProgressTimer = null;
  };
  searchProgressTimer = setTimeout(() => {
    void poll();
  }, 250);
}

function stopSearchProgress() {
  searchProgressSequence += 1;
  if (searchProgressTimer) clearTimeout(searchProgressTimer);
  searchProgressTimer = null;
}

async function cancelSearch() {
  if (!searchRequestId) return;
  await api.consulCancelSearch(searchConnectionId, searchRequestId, searchScopeAtStart, searchGeneration);
}

async function openSearchResult(result: ConsulSearchMatch) {
  searchHighlight.value = {
    key: result.key,
    query: searchQuery.value.trim(),
    caseSensitive: searchCaseSensitive.value,
    matchesKey: result.matchesKey,
    matchesValue: result.matchesValue,
  };
  searchOpen.value = false;
  await nextTick();
  await browserRef.value?.selectKey(result.key);
}

function validateBundle(value: unknown): ConsulKvBundle {
  const bundle = value as Partial<ConsulKvBundle>;
  if (bundle.format !== "dbx-consul-kv-bundle" || bundle.version !== 1 || !Array.isArray(bundle.entries)) {
    throw new Error(t("consul.tools.invalidBundle"));
  }
  return bundle as ConsulKvBundle;
}

async function chooseImportFile() {
  if (isTauriRuntime()) {
    const [{ open }, { readTextFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const path = await open({ multiple: false, filters: [{ name: t("consul.ui.bundleFileType"), extensions: ["json"] }] });
    if (!path || Array.isArray(path)) return;
    await loadImportText(await readTextFile(path));
    return;
  }
  fileInputRef.value?.click();
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) await loadImportText(await file.text());
}

async function loadImportText(text: string) {
  try {
    transferMode.value = "import";
    transferBundle.value = validateBundle(JSON.parse(text));
    transferTargetId.value = props.connectionId;
    transferPolicy.value = "abort";
    transferPreview.value = null;
    transferReport.value = null;
    transferError.value = "";
    transferOpen.value = true;
    await previewTransfer();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}

function openMigration() {
  closePrefixSuggestions();
  transferMode.value = "migration";
  transferBundle.value = null;
  transferTargetId.value = consulConnections.value.find((connection) => connection.id !== props.connectionId)?.id || "";
  transferSourcePrefix.value = "";
  transferPolicy.value = "abort";
  transferPreview.value = null;
  transferReport.value = null;
  transferError.value = "";
  transferOpen.value = true;
}

async function loadMigrationPreview() {
  if (!transferTargetId.value) return;
  transferLoading.value = true;
  transferError.value = "";
  try {
    transferBundle.value = await api.consulExportBundle(props.connectionId, { path: transferSourcePrefix.value, kind: "prefix" });
    await previewTransfer();
  } catch (error) {
    transferError.value = error instanceof Error ? error.message : String(error);
  } finally {
    transferLoading.value = false;
  }
}

async function previewTransfer() {
  if (!transferBundle.value || !transferTargetId.value) return;
  transferLoading.value = true;
  transferPreview.value = null;
  transferReport.value = null;
  transferError.value = "";
  try {
    transferPreview.value = await api.consulImportPreview(transferTargetId.value, {
      bundle: transferBundle.value,
      policy: transferPolicy.value,
    });
  } catch (error) {
    transferError.value = error instanceof Error ? error.message : String(error);
  } finally {
    transferLoading.value = false;
  }
}

async function executeTransfer() {
  if (!transferBundle.value || !transferTargetId.value || !transferPreview.value?.canApply) return;
  transferApplying.value = true;
  transferError.value = "";
  try {
    transferReport.value = await api.consulImportExecute(transferTargetId.value, {
      bundle: transferBundle.value,
      policy: transferPolicy.value,
      previewId: transferPreview.value.previewId,
    });
    toast(t("consul.tools.importApplied", { count: transferReport.value.succeeded }), 3000);
    if (transferTargetId.value === props.connectionId) browserRef.value?.refresh();
  } catch (error) {
    transferError.value = error instanceof Error ? error.message : String(error);
  } finally {
    transferApplying.value = false;
  }
}

function resetTransferPreview() {
  transferPreview.value = null;
  transferReport.value = null;
  if (transferMode.value === "import") void previewTransfer();
}

function openDeletePrefix(prefix = "") {
  closePrefixSuggestions();
  deletePrefix.value = prefix;
  deletePreview.value = null;
  deleteReport.value = null;
  deleteError.value = "";
  deleteOpen.value = true;
}

function closePrefixSuggestions() {
  prefixSuggestionRequestId++;
  if (prefixSuggestionTimer) {
    clearTimeout(prefixSuggestionTimer);
    prefixSuggestionTimer = null;
  }
  prefixSuggestionTarget.value = null;
  prefixSuggestionIndex.value = -1;
  prefixSuggestions.value = [];
}

function prefixValue(target: PrefixSuggestionTarget): string {
  if (target === "export") return exportPrefix.value;
  if (target === "migration") return transferSourcePrefix.value;
  return deletePrefix.value;
}

function setPrefixValue(target: PrefixSuggestionTarget, value: string) {
  if (target === "export") exportPrefix.value = value;
  else if (target === "migration") transferSourcePrefix.value = value;
  else deletePrefix.value = value;
}

function schedulePrefixSuggestions(target: PrefixSuggestionTarget, value: string) {
  closePrefixSuggestions();
  const query = value.trim();
  if (!query) {
    prefixSuggestions.value = [];
    return;
  }

  const requestId = ++prefixSuggestionRequestId;
  const connectionId = props.connectionId;
  prefixSuggestionTarget.value = target;
  prefixSuggestionTimer = setTimeout(() => {
    void api
      .consulListPrefix(connectionId, query, 8, null)
      .then((result) => {
        if (requestId !== prefixSuggestionRequestId || connectionId !== props.connectionId || prefixValue(target).trim() !== query) return;
        prefixSuggestions.value = result.keys;
      })
      .catch(() => {
        if (requestId === prefixSuggestionRequestId) prefixSuggestions.value = [];
      });
  }, prefixSuggestionDebounceMs);
}

function acceptPrefixSuggestion(target: PrefixSuggestionTarget, index: number) {
  const suggestion = prefixSuggestions.value[index];
  if (!suggestion) return;
  setPrefixValue(target, suggestion.key);
  // A directory suggestion ends with `/`. Immediately query that accepted
  // prefix so the user can continue completing the next path segment without
  // deleting and retyping the slash.
  schedulePrefixSuggestions(target, suggestion.key);
}

function movePrefixSuggestion(target: PrefixSuggestionTarget, delta: number) {
  if (prefixSuggestionTarget.value !== target || !prefixSuggestions.value.length) return;
  prefixSuggestionIndex.value = (prefixSuggestionIndex.value + delta + prefixSuggestions.value.length) % prefixSuggestions.value.length;
}

function onPrefixSuggestionKeydown(target: PrefixSuggestionTarget, event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    closePrefixSuggestions();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (prefixSuggestionTarget.value !== target || !prefixSuggestions.value.length) return;
    event.preventDefault();
    movePrefixSuggestion(target, event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key !== "Enter" && event.key !== "Tab") return;
  if (prefixSuggestionTarget.value === target && prefixSuggestions.value.length > 0) {
    event.preventDefault();
    acceptPrefixSuggestion(target, prefixSuggestionIndex.value >= 0 ? prefixSuggestionIndex.value : 0);
    return;
  }
  // With no active completion, Tab keeps its native focus-navigation behavior.
  if (event.key === "Tab") return;
  if (target === "delete" && deletePrefix.value.trim() && !deletePreview.value) {
    event.preventDefault();
    void previewDeletePrefix();
  }
}

async function previewDeletePrefix() {
  if (!deletePrefix.value.trim()) return;
  deleteLoading.value = true;
  deletePreview.value = null;
  deleteReport.value = null;
  deleteError.value = "";
  try {
    deletePreview.value = await api.consulDeletePrefixPreview(props.connectionId, deletePrefix.value.trim());
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : String(error);
  } finally {
    deleteLoading.value = false;
  }
}

async function executeDeletePrefix() {
  if (!deletePreview.value?.canExecute) return;
  deleteExecuting.value = true;
  deleteError.value = "";
  try {
    deleteReport.value = await api.consulDeletePrefixExecute(props.connectionId, {
      prefix: deletePreview.value.prefix,
      expected: deletePreview.value.candidates,
    });
    toast(t("consul.tools.prefixDeleted", { count: deleteReport.value.succeeded }), 3000);
    browserRef.value?.refresh();
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : String(error);
    deletePreview.value = null;
  } finally {
    deleteExecuting.value = false;
  }
}

function operationVariant(operation: string): "default" | "secondary" | "destructive" | "outline" {
  if (operation === "create" || operation === "succeeded") return "secondary";
  if (operation === "conflict" || operation === "locked" || operation === "failed" || operation === "conflicted") return "destructive";
  return "outline";
}

function reportBatchCount(items: Array<{ batch: number | null }>): number {
  return items.reduce((count, item) => Math.max(count, item.batch ?? 0), 0);
}

function focusSearch(): boolean {
  return browserRef.value?.focusSearch() ?? false;
}

function refresh(): boolean {
  return browserRef.value?.refresh() ?? false;
}

watch(
  () => `${props.connectionId}\u0000${currentScope().datacenter}\u0000${currentScope().partition}\u0000${currentScope().namespace}`,
  () => {
    void stopWatch();
    watchIndex.value = null;
    if (searchRunning.value && searchRequestId) void cancelSearch();
    stopSearchProgress();
  },
);

function stopBackgroundWork() {
  void stopWatch();
  if (searchRunning.value && searchRequestId) void cancelSearch();
  stopSearchProgress();
}

onDeactivated(stopBackgroundWork);
onBeforeUnmount(() => {
  closePrefixSuggestions();
  stopBackgroundWork();
});

defineExpose({ focusSearch, refresh });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <input ref="fileInputRef" type="file" accept="application/json,.json" class="hidden" @change="onImportFile" />
    <KvKeyBrowser
      ref="browserRef"
      class="min-h-0 flex-1"
      :connection-id="props.connectionId"
      :api="consulApi"
      :labels="labels"
      metadata-style="consul"
      lazy-hierarchy
      lazy-path-style="relative"
      safe-write
      allow-binary-edit
      enable-node-actions
      supports-flags
      :read-only="readOnly"
      :max-value-bytes="512 * 1024"
      :on-watch-key="watchSelectedKey"
      :on-delete-prefix="openDeletePrefix"
      :watch-active-key="watchRunning && watchMode === 'key' ? watchPrefix : null"
      :search-highlight="searchHighlight"
      export-format="dbx-consul-kv-bundle"
      export-file-extension=".dbx-consul.json"
      export-fallback-name="consul-key"
    >
      <template #toolbar-trailing>
        <Button variant="ghost" size="sm" class="h-9 gap-1.5 whitespace-nowrap" @click="openSearch"> <Search class="h-3.5 w-3.5" />{{ t("consul.tools.search") }} </Button>
        <Button variant="ghost" size="sm" class="h-9 gap-1.5 whitespace-nowrap" :disabled="exporting" @click="exportOpen = true"> <Download class="h-3.5 w-3.5" />{{ t("consul.tools.exportPrefix") }} </Button>
        <Button variant="ghost" size="sm" class="h-9 gap-1.5 whitespace-nowrap" :disabled="readOnly" @click="chooseImportFile"> <FileUp class="h-3.5 w-3.5" />{{ t("consul.tools.import") }} </Button>
        <Button variant="ghost" size="sm" class="h-9 gap-1.5 whitespace-nowrap" @click="openMigration"> <ArrowRightLeft class="h-3.5 w-3.5" />{{ t("consul.tools.migrate") }} </Button>
      </template>
    </KvKeyBrowser>

    <Dialog v-model:open="searchOpen">
      <DialogContent class="flex max-h-[82vh] flex-col sm:max-w-4xl">
        <DialogHeader
          ><DialogTitle>{{ t("consul.tools.searchTitle") }}</DialogTitle></DialogHeader
        >
        <div class="grid shrink-0 gap-3 sm:grid-cols-[1fr_1fr_160px_auto]">
          <Input v-model="searchQuery" :placeholder="t('consul.tools.searchQuery')" @keydown.enter="runSearch" />
          <Input v-model="searchPrefix" :placeholder="t('consul.tools.prefixOptional')" @keydown.enter="runSearch" />
          <Select v-model="searchScope">
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{{ t("consul.tools.searchAll") }}</SelectItem>
              <SelectItem value="key">{{ t("consul.tools.searchKeys") }}</SelectItem>
              <SelectItem value="value">{{ t("consul.tools.searchValues") }}</SelectItem>
            </SelectContent>
          </Select>
          <Button :disabled="searchRunning || !searchQuery.trim()" @click="runSearch"> <Loader2 v-if="searchRunning" class="mr-2 h-4 w-4 animate-spin" />{{ t("consul.tools.search") }} </Button>
        </div>
        <label class="flex items-center gap-2 text-xs text-muted-foreground"> <input v-model="searchCaseSensitive" type="checkbox" class="h-4 w-4" />{{ t("consul.tools.caseSensitive") }} </label>
        <div v-if="searchRunning" class="flex items-center justify-between border-y py-2 text-xs text-muted-foreground">
          <span>{{ t("consul.tools.scanned", { count: searchScanned }) }}</span>
          <Button variant="ghost" size="sm" class="h-7 gap-1.5" @click="cancelSearch"><X class="h-3.5 w-3.5" />{{ t("common.cancel") }}</Button>
        </div>
        <div v-if="searchError" class="border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{{ searchError }}</div>
        <div v-if="searchFiltered" class="border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{{ t("consul.aclFiltered") }}</div>
        <div v-if="searchLimited" class="text-xs text-amber-700 dark:text-amber-300">{{ t("consul.tools.searchLimited") }}</div>
        <div class="min-h-0 flex-1 overflow-auto border">
          <button v-for="result in searchResults" :key="`${result.key}:${result.modifyIndex}`" class="flex w-full items-center gap-3 border-b px-3 py-2 text-left hover:bg-muted/50" @click="openSearchResult(result)">
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ result.key }}</span>
            <Badge v-if="result.matchesKey" variant="outline">{{ t("consul.ui.key") }}</Badge>
            <Badge v-if="result.matchesValue" variant="outline">{{ t("consul.ui.value") }}</Badge>
          </button>
          <div v-if="!searchRunning && !searchResults.length" class="flex h-24 items-center justify-center text-sm text-muted-foreground">{{ t("consul.tools.noSearchResults") }}</div>
        </div>
        <div class="flex shrink-0 items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{{ t("consul.tools.searchSummary", { matched: searchMatched, scanned: searchScanned }) }}</span>
          <Button v-if="searchResults.length" size="sm" variant="outline" class="h-8 gap-1.5" :disabled="exportingSearchResults" @click="exportSearchResults">
            <Loader2 v-if="exportingSearchResults" class="h-3.5 w-3.5 animate-spin" />
            <Download v-else class="h-3.5 w-3.5" />
            {{ t("consul.tools.exportSearchResults") }}
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="exportOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader
          ><DialogTitle>{{ t("consul.tools.exportPrefix") }}</DialogTitle></DialogHeader
        >
        <div class="grid gap-2">
          <Label>{{ t("consul.tools.prefix") }}</Label>
          <Popover :open="prefixSuggestionTarget === 'export' && prefixSuggestions.length > 0">
            <PopoverAnchor as-child>
              <Input
                v-model="exportPrefix"
                autocomplete="off"
                :placeholder="t('consul.tools.emptyPrefixAll')"
                @input="schedulePrefixSuggestions('export', ($event.target as HTMLInputElement).value)"
                @focus="schedulePrefixSuggestions('export', exportPrefix)"
                @blur="closePrefixSuggestions"
                @keydown="onPrefixSuggestionKeydown('export', $event)"
              />
            </PopoverAnchor>
            <PopoverContent align="start" side="bottom" :collision-padding="12" class="z-[60] max-h-[var(--reka-popover-content-available-height)] w-[var(--reka-popover-trigger-width)] gap-0 overflow-y-auto p-1" @open-auto-focus.prevent>
              <button
                v-for="(suggestion, index) in prefixSuggestions"
                :key="suggestion.key"
                type="button"
                role="option"
                :aria-selected="prefixSuggestionIndex === index"
                class="flex w-full items-center px-3 py-1.5 text-left font-mono text-xs"
                :class="prefixSuggestionIndex === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/70'"
                @mouseenter="prefixSuggestionIndex = index"
                @mousedown.prevent="acceptPrefixSuggestion('export', index)"
              >
                {{ suggestion.key }}
              </button>
            </PopoverContent>
          </Popover>
          <p class="text-xs text-muted-foreground">{{ t("consul.tools.exportLimitHint") }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="exportOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="exporting" @click="exportPrefixBundle"><Loader2 v-if="exporting" class="mr-2 h-4 w-4 animate-spin" />{{ t("consul.export") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="transferOpen">
      <DialogContent class="flex max-h-[86vh] flex-col sm:max-w-5xl">
        <DialogHeader
          ><DialogTitle>{{ transferMode === "migration" ? t("consul.tools.migrateTitle") : t("consul.tools.importTitle") }}</DialogTitle></DialogHeader
        >
        <div class="grid shrink-0 gap-3 sm:grid-cols-3">
          <div v-if="transferMode === 'migration'" class="grid gap-2">
            <Label>{{ t("consul.tools.sourcePrefix") }}</Label>
            <Popover :open="prefixSuggestionTarget === 'migration' && prefixSuggestions.length > 0">
              <PopoverAnchor as-child>
                <Input
                  v-model="transferSourcePrefix"
                  autocomplete="off"
                  :placeholder="t('consul.tools.emptyPrefixAll')"
                  @input="schedulePrefixSuggestions('migration', ($event.target as HTMLInputElement).value)"
                  @focus="schedulePrefixSuggestions('migration', transferSourcePrefix)"
                  @blur="closePrefixSuggestions"
                  @keydown="onPrefixSuggestionKeydown('migration', $event)"
                />
              </PopoverAnchor>
              <PopoverContent align="start" side="bottom" :collision-padding="12" class="z-[60] max-h-[var(--reka-popover-content-available-height)] w-[var(--reka-popover-trigger-width)] gap-0 overflow-y-auto p-1" @open-auto-focus.prevent>
                <button
                  v-for="(suggestion, index) in prefixSuggestions"
                  :key="suggestion.key"
                  type="button"
                  role="option"
                  :aria-selected="prefixSuggestionIndex === index"
                  class="flex w-full items-center px-3 py-1.5 text-left font-mono text-xs"
                  :class="prefixSuggestionIndex === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/70'"
                  @mouseenter="prefixSuggestionIndex = index"
                  @mousedown.prevent="acceptPrefixSuggestion('migration', index)"
                >
                  {{ suggestion.key }}
                </button>
              </PopoverContent>
            </Popover>
          </div>
          <div class="grid gap-2">
            <Label>{{ t("consul.tools.targetConnection") }}</Label>
            <Select v-model="transferTargetId" @update:model-value="resetTransferPreview">
              <SelectTrigger><SelectValue :placeholder="t('consul.tools.selectTarget')" /></SelectTrigger>
              <SelectContent
                ><SelectItem v-for="connection in transferTargetConnections" :key="connection.id" :value="connection.id">{{ connection.name }}</SelectItem></SelectContent
              >
            </Select>
          </div>
          <div class="grid gap-2">
            <Label>{{ t("consul.tools.conflictPolicy") }}</Label>
            <Select v-model="transferPolicy" @update:model-value="resetTransferPreview">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="abort">{{ t("consul.tools.policyAbort") }}</SelectItem>
                <SelectItem value="skip">{{ t("consul.tools.policySkip") }}</SelectItem>
                <SelectItem value="cas">{{ t("consul.tools.policyCas") }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div v-if="transferBundle" class="text-xs text-muted-foreground">
          {{ t("consul.tools.bundleSummary", { count: transferBundle.entries.length, dc: transferBundle.source.datacenter || "-", ns: transferBundle.source.namespace || "-", partition: transferBundle.source.partition || "-" }) }}
        </div>
        <div v-if="transferMode === 'migration'" class="border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{{ t("consul.ui.clientSideMigration") }}</div>
        <div v-if="transferTargetReadOnly" class="border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{{ t("consul.tools.targetReadOnly") }}</div>
        <div v-if="transferError" class="border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{{ transferError }}</div>
        <div v-if="transferPreview" class="flex flex-wrap gap-2 text-xs">
          <Badge variant="secondary">{{ t("consul.tools.creates", { count: transferPreview.creates }) }}</Badge>
          <Badge variant="secondary">{{ t("consul.tools.updates", { count: transferPreview.updates }) }}</Badge>
          <Badge variant="outline">{{ t("consul.tools.unchanged", { count: transferPreview.unchanged }) }}</Badge>
          <Badge variant="outline">{{ t("consul.tools.skipped", { count: transferPreview.skipped }) }}</Badge>
          <Badge :variant="transferPreview.conflicts ? 'destructive' : 'outline'">{{ t("consul.tools.conflicts", { count: transferPreview.conflicts }) }}</Badge>
        </div>
        <div v-if="transferReport" class="flex flex-wrap gap-2 text-xs">
          <Badge :variant="transferReport.atomic ? 'default' : 'destructive'">{{ transferReport.atomic ? t("consul.ui.atomicTransaction") : t("consul.ui.nonAtomicBatches", { count: reportBatchCount(transferReport.items) }) }}</Badge>
          <Badge variant="outline">{{ t("consul.ui.operationTotals", { succeeded: transferReport.succeeded, conflicted: transferReport.conflicted, skipped: transferReport.skipped, failed: transferReport.failed }) }}</Badge>
        </div>
        <div class="min-h-0 flex-1 overflow-auto border">
          <div v-for="row in transferReport?.items || transferPreview?.rows || []" :key="row.key" class="grid grid-cols-[minmax(0,1fr)_120px] gap-3 border-b px-3 py-2 text-xs">
            <div class="min-w-0">
              <div class="truncate font-mono">{{ row.key }}</div>
              <div v-if="'batch' in row && row.batch" class="mt-1 text-muted-foreground">{{ t("consul.ui.batchOperation", { batch: row.batch, op: row.opIndex ?? "-" }) }}</div>
              <div v-if="('message' in row && row.message) || ('reason' in row && row.reason)" class="mt-1 text-muted-foreground">{{ "message" in row ? row.message : "reason" in row ? row.reason : "" }}</div>
            </div>
            <Badge :variant="operationVariant('outcome' in row ? row.outcome : row.operation)" class="justify-center">{{ t(`consul.tools.operation.${"outcome" in row ? row.outcome : row.operation}`) }}</Badge>
          </div>
          <div v-if="transferLoading" class="flex h-24 items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 h-4 w-4 animate-spin" />{{ t("consul.tools.loadingPreview") }}</div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="transferOpen = false">{{ t("common.close") }}</Button>
          <Button v-if="transferMode === 'migration' && !transferPreview" variant="outline" :disabled="transferLoading || !transferTargetId" @click="loadMigrationPreview">{{ t("consul.tools.loadPreview") }}</Button>
          <Button v-else-if="transferMode === 'import' && !transferPreview" variant="outline" :disabled="transferLoading || !transferTargetId" @click="previewTransfer">{{ t("consul.tools.loadPreview") }}</Button>
          <Button v-if="transferPreview && !transferReport" :disabled="transferApplying || transferTargetReadOnly || !transferPreview.canApply" @click="executeTransfer"><Loader2 v-if="transferApplying" class="mr-2 h-4 w-4 animate-spin" />{{ t("consul.tools.apply") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="deleteOpen">
      <DialogContent class="flex max-h-[82vh] flex-col sm:max-w-3xl">
        <DialogHeader
          ><DialogTitle>{{ t("consul.tools.deletePrefixTitle") }}</DialogTitle></DialogHeader
        >
        <div class="flex shrink-0 gap-2">
          <div class="min-w-0 flex-1">
            <Popover :open="prefixSuggestionTarget === 'delete' && prefixSuggestions.length > 0">
              <PopoverAnchor as-child>
                <Input
                  v-model="deletePrefix"
                  autocomplete="off"
                  :placeholder="t('consul.tools.deletePrefixPlaceholder')"
                  :disabled="Boolean(deletePreview)"
                  @input="schedulePrefixSuggestions('delete', ($event.target as HTMLInputElement).value)"
                  @focus="schedulePrefixSuggestions('delete', deletePrefix)"
                  @blur="closePrefixSuggestions"
                  @keydown="onPrefixSuggestionKeydown('delete', $event)"
                />
              </PopoverAnchor>
              <PopoverContent align="start" side="bottom" :collision-padding="12" class="z-[60] max-h-[var(--reka-popover-content-available-height)] w-[var(--reka-popover-trigger-width)] gap-0 overflow-y-auto p-1" @open-auto-focus.prevent>
                <button
                  v-for="(suggestion, index) in prefixSuggestions"
                  :key="suggestion.key"
                  type="button"
                  role="option"
                  :aria-selected="prefixSuggestionIndex === index"
                  class="flex w-full items-center px-3 py-1.5 text-left font-mono text-xs"
                  :class="prefixSuggestionIndex === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/70'"
                  @mouseenter="prefixSuggestionIndex = index"
                  @mousedown.prevent="acceptPrefixSuggestion('delete', index)"
                >
                  {{ suggestion.key }}
                </button>
              </PopoverContent>
            </Popover>
          </div>
          <Button variant="outline" :disabled="deleteLoading || !deletePrefix.trim() || Boolean(deletePreview)" @click="previewDeletePrefix"><Loader2 v-if="deleteLoading" class="mr-2 h-4 w-4 animate-spin" />{{ t("consul.tools.preview") }}</Button>
        </div>
        <div class="border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{{ t("consul.tools.deletePrefixWarning") }}</div>
        <div v-if="deleteError" class="border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{{ deleteError }}</div>
        <div v-if="deletePreview" class="flex flex-wrap gap-2 text-xs">
          <Badge variant="secondary">{{ t("consul.tools.candidates", { count: deletePreview.candidates.length }) }}</Badge>
          <Badge :variant="deletePreview.locked ? 'destructive' : 'outline'">{{ t("consul.tools.lockedCount", { count: deletePreview.locked }) }}</Badge>
          <Badge :variant="deletePreview.filteredByAcls ? 'destructive' : 'outline'">ACL {{ deletePreview.filteredByAcls ? t("consul.tools.filtered") : t("consul.tools.complete") }}</Badge>
        </div>
        <div v-if="deleteReport" class="flex flex-wrap gap-2 text-xs">
          <Badge :variant="deleteReport.atomic ? 'default' : 'destructive'">{{ deleteReport.atomic ? t("consul.ui.atomicTransaction") : t("consul.ui.nonAtomicBatches", { count: reportBatchCount(deleteReport.items) }) }}</Badge>
          <Badge variant="outline">{{ t("consul.ui.deleteOperationTotals", { succeeded: deleteReport.succeeded, conflicted: deleteReport.conflicted, failed: deleteReport.failed }) }}</Badge>
        </div>
        <div class="min-h-0 flex-1 overflow-auto border">
          <div v-for="row in deleteReport?.items || deletePreview?.candidates || []" :key="row.key" class="grid grid-cols-[minmax(0,1fr)_140px] gap-3 border-b px-3 py-2 text-xs" :class="'session' in row && row.session ? 'bg-destructive/5' : ''">
            <span class="min-w-0">
              <span class="flex min-w-0 items-center gap-2"
                ><span class="truncate font-mono">{{ row.key }}</span
                ><Badge v-if="'session' in row && row.session" variant="destructive" class="shrink-0">{{ t("consul.ui.locked") }}</Badge></span
              >
              <span v-if="'session' in row && row.session" class="mt-1 block truncate font-mono text-muted-foreground">{{ t("consul.ui.sessionValue", { id: row.session }) }}</span>
              <span v-if="'batch' in row && row.batch" class="block truncate text-muted-foreground">{{ t("consul.ui.batchOperation", { batch: row.batch, op: row.opIndex ?? "-" }) }}</span>
              <span v-if="'message' in row && row.message" class="mt-1 block truncate text-destructive" :title="row.message">{{ row.message }}</span>
            </span>
            <Badge v-if="'outcome' in row" :variant="operationVariant(row.outcome)" class="justify-center">{{ t(`consul.tools.operation.${row.outcome}`) }}</Badge>
            <span v-else class="truncate text-right font-mono text-muted-foreground">{{ row.modifyIndex }}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="deleteOpen = false">{{ t("common.close") }}</Button>
          <Button v-if="deletePreview && !deleteReport" variant="destructive" :disabled="deleteExecuting || !deletePreview.canExecute" @click="executeDeletePrefix"><Loader2 v-if="deleteExecuting" class="mr-2 h-4 w-4 animate-spin" />{{ t("consul.tools.confirmDeletePrefix") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
