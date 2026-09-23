<script setup lang="ts">
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowUp, BadgeCheck, Check, ChevronRight, CircleAlert, Download, ExternalLink, FileUp, FolderTree, Globe, Info, LayoutGrid, Link2, List, Loader2, PackageCheck, Pencil, Pin, PinOff, Plus, RefreshCw, RotateCcw, Search, Settings2, ShieldCheck, Store, Trash2 } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/composables/useToast";
import PluginIcon from "@/components/plugins/PluginIcon.vue";
import * as api from "@/lib/backend/api";
import { clearPluginIconCache } from "@/lib/plugins/pluginIconResolver";
import { loadPinnedPluginIds, savePinnedPluginIds, sortPluginsPinnedFirst } from "@/lib/plugins/pluginPinning";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { physicalDropPositionInsideRect } from "@/lib/ai/aiAttachments";
import { createFrontendPluginRegistry, pluginConnectionProviderIcon } from "@/lib/plugins/frontendPlugin";
import { executePluginCommand } from "@/lib/plugins/pluginCommandRegistry";
import {
  beaconPluginInstall,
  buildInstalledUpdateIndex,
  buildMarketplacePluginListings,
  filterMarketplacePluginListings,
  listingRepositoryCanVerify,
  marketplaceHomepageUrl,
  pluginSourceChange,
  type InstalledPluginUpdateEntry,
  type MarketplacePluginListing,
  type PluginSourceChange,
} from "@/lib/plugins/pluginMarketplace";
import { isBatchSelectableListing, runBatch } from "@/lib/plugins/pluginBatch";
import { COMPONENT_PLUGINS_UPDATED_EVENT, notifyComponentPluginsUpdated, notifyComponentUpdatesChanged } from "@/lib/updates/componentUpdateEvents";
import { formatBytes } from "@/lib/database/serverMetrics";
import type { PluginCenterFocus } from "@/lib/plugins/pluginCenterNavigation";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import type { InstalledPlugin, PluginInstallResult, PluginRepository, PluginRepositoryCatalogResult, PluginTrustedKey } from "@/types/database";
import { useI18n } from "vue-i18n";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { translateBackendError } from "@/i18n/backend-errors";

const props = defineProps<{
  focusTarget?: PluginCenterFocus | null;
  installUrlRequest?: { id: number; url: string } | null;
}>();

const emit = defineEmits<{
  newConnection: [pluginId: string, providerId: string];
  pluginRuntimeReplaced: [pluginId: string];
}>();

// lucide no longer ships brand icons; mirror the inline glyph used in AppToolbar.
const GithubIcon = defineComponent({
  props: {
    iconClass: { type: String, default: "size-3" },
  },
  render() {
    return h("svg", { class: this.iconClass, viewBox: "0 0 24 24", fill: "currentColor" }, [
      h("path", {
        d: "M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12 24 5.37 18.627 0 12 0z",
      }),
    ]);
  },
});

const PLUGIN_ALLOW_UNSIGNED_STORAGE_KEY = "dbx-plugin-allow-unsigned";
const MARKETPLACE_VIEW_MODE_STORAGE_KEY = "dbx-plugin-marketplace-view-mode";

type TauriFileDropPayload = { type: "enter"; paths: string[]; position: { x: number; y: number } } | { type: "over"; position: { x: number; y: number } } | { type: "drop"; paths: string[]; position: { x: number; y: number } } | { type: "leave" };

const { t, locale: appLocale } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const activeSection = ref<"marketplace" | "installed" | "settings">("marketplace");
const installedPlugins = ref<InstalledPlugin[]>([]);
const trustedKeys = ref<PluginTrustedKey[]>([]);
const repositories = ref<PluginRepository[]>([]);
const catalogResults = ref<PluginRepositoryCatalogResult[]>([]);
const loading = ref(false);
const marketplaceLoading = ref(false);
const installing = ref(false);
const installUrl = ref("");
const urlInstalling = ref(false);
const urlDownloadProgress = ref<{ downloaded: number; total: number | null } | null>(null);
const marketplaceInstallingKey = ref("");
const marketplaceUnavailable = ref(false);
const installedUpdateProgress = ref<{ current: number; total: number } | null>(null);
const operating = ref(false);
const error = ref("");
const selectedPluginId = ref("");
const selectedContributionId = ref("");
const selectedConnectionId = ref("");
const allowUnsigned = ref(
  ((): boolean => {
    try {
      return localStorage.getItem(PLUGIN_ALLOW_UNSIGNED_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  })(),
);
const trustedKeyId = ref("");
const trustedPublicKey = ref("");
const repositoryId = ref("");
const repositoryName = ref("");
const repositoryCatalogUrl = ref("");
const marketplaceQuery = ref("");
const marketplaceRepositoryId = ref("all");
const marketplaceViewMode = ref<"grid" | "list">(safeLocalStorageGet(MARKETPLACE_VIEW_MODE_STORAGE_KEY) === "list" ? "list" : "grid");
const webFileInput = ref<HTMLInputElement | null>(null);
const panelRootRef = ref<HTMLElement | null>(null);
const draggingPackage = ref(false);
let webDragDepth = 0;

// Batch operations (install / update on the marketplace tab, uninstall on the installed tab).
const batchMode = ref(false);
const selectedListingKeys = ref<Set<string>>(new Set());
const selectedInstalledIds = ref<Set<string>>(new Set());
const batchRunning = ref(false);
const mutationRunning = computed(() => batchRunning.value || !!marketplaceInstallingKey.value || installing.value || urlInstalling.value || operating.value);

const registry = computed(() => createFrontendPluginRegistry(installedPlugins.value, appLocale.value));
const pinnedPluginIds = ref<string[]>(loadPinnedPluginIds());
const definitions = computed(() => sortPluginsPinnedFirst(registry.value.listPlugins(), pinnedPluginIds.value));
const isPluginPinned = (pluginId: string) => pinnedPluginIds.value.includes(pluginId);
const togglePluginPinned = (pluginId: string) => {
  pinnedPluginIds.value = isPluginPinned(pluginId) ? pinnedPluginIds.value.filter((id) => id !== pluginId) : [...pinnedPluginIds.value, pluginId];
  savePinnedPluginIds(pinnedPluginIds.value);
};
const connectionProviders = computed(() => registry.value.listConnectionProviders());
const selectedEntry = computed(() => connectionProviders.value.find((entry) => entry.plugin.manifest.id === selectedPluginId.value && entry.contribution.id === selectedContributionId.value) || null);
const selectedDefinition = computed(() => definitions.value.find((definition) => definition.plugin.manifest.id === selectedPluginId.value) || null);
const selectedWorkbenches = computed(() => registry.value.listWorkbenches().filter((entry) => entry.plugin.manifest.id === selectedPluginId.value));
const selectedFilesystems = computed(() => registry.value.listFilesystemProviders().filter((entry) => entry.plugin.manifest.id === selectedPluginId.value));
// PR-A4: plugins declaring commands drive their quick entries via commands (workbench opens route to the command; the SFTP browse entry is retired).
const selectedHasCommands = computed(() => registry.value.listCommands().some((entry) => entry.plugin.manifest.id === selectedPluginId.value));
const providerConnections = computed(() => {
  const entry = selectedEntry.value;
  if (!entry) return [];
  return connectionStore.connections.filter((connection) => connection.db_type === "plugin" && connection.plugin_id === entry.plugin.manifest.id && connection.plugin_connection_provider === entry.contribution.id);
});
const selectedConnection = computed(() => providerConnections.value.find((connection) => connection.id === selectedConnectionId.value));
const marketplaceListings = computed(() => buildMarketplacePluginListings(catalogResults.value, installedPlugins.value, appLocale.value));
const filteredMarketplaceListings = computed(() => filterMarketplacePluginListings(marketplaceListings.value, marketplaceQuery.value, marketplaceRepositoryId.value));
const batchUpdatableListings = computed(() => filteredMarketplaceListings.value.filter((listing) => listing.status === "update"));
const batchSelectedListings = computed(() => filteredMarketplaceListings.value.filter((listing) => isBatchSelectableListing(listing.status) && selectedListingKeys.value.has(listing.key)));
const batchSelectedInstalled = computed(() => definitions.value.filter((definition) => selectedInstalledIds.value.has(definition.plugin.manifest.id)));
const catalogErrors = computed(() => catalogResults.value.filter((result) => result.error));
// Installed-tab update join: the same marketplace listings the store tab renders, indexed by
// plugin id so installed rows/detail can show "update available" without a second fetch.
const installedUpdateIndex = computed(() => buildInstalledUpdateIndex(marketplaceListings.value));
const installedUpdateCount = computed(() => installedUpdateIndex.value.size);
const installedUpdateEntries = computed(() => definitions.value.map((definition) => installedUpdateIndex.value.get(definition.plugin.manifest.id)).filter((entry): entry is InstalledPluginUpdateEntry => !!entry));
const selectedUpdateEntry = computed(() => (selectedDefinition.value && installedUpdateIndex.value.get(selectedDefinition.value.plugin.manifest.id)) || null);
const repositoriesEnabled = computed(() => repositories.value.some((repository) => repository.enabled));
// "Checked" means a catalog actually loaded: a failed/missing fetch must never read as up to date.
const catalogChecked = computed(() => !marketplaceLoading.value && !marketplaceUnavailable.value && repositoriesEnabled.value && catalogResults.value.some((result) => result.catalog));
// The backend answers a mixed fetch with successful catalogs AND per-repository errors, so
// "some catalog loaded" is not enough: one failing enabled repository makes the whole check
// incomplete (plugins whose only source is that repo would read as "not in repositories" /
// "all up to date").
const catalogPartialFailure = computed(() => repositoriesEnabled.value && catalogResults.value.some((result) => result.error));
function installedUpdateEntryFor(pluginId: string): InstalledPluginUpdateEntry | null {
  return installedUpdateIndex.value.get(pluginId) || null;
}
function pluginInCatalog(pluginId: string): boolean {
  return marketplaceListings.value.some((listing) => listing.plugin.id === pluginId);
}
// Catalog listings that do exist for an installed plugin but ship no artifact for this platform:
// their update status cannot be checked either, so it gets the same visible treatment as the
// "not in any catalog" case instead of reading as up to date.
const installedUnsupportedListings = computed(() => {
  const byId = new Map<string, MarketplacePluginListing>();
  for (const listing of marketplaceListings.value) {
    if (listing.status !== "unsupported" || !listing.installed) continue;
    if (!byId.has(listing.plugin.id)) byId.set(listing.plugin.id, listing);
  }
  return byId;
});
function installedUnsupportedListingFor(pluginId: string): MarketplacePluginListing | null {
  if (installedUpdateIndex.value.has(pluginId)) return null;
  return installedUnsupportedListings.value.get(pluginId) || null;
}
const customRepositories = computed(() => repositories.value.filter((repository) => !repository.managed));
const showCustomRepositoryTrustSettings = computed(() => customRepositories.value.length > 0 || trustedKeys.value.length > 0);
const pluginDevelopmentDocsUrl = computed(() => `https://dbxio.com/${appLocale.value.startsWith("zh") ? "cn" : "en"}/docs/plugin-development`);

function marketplaceActionClass(listing: MarketplacePluginListing): string {
  if (listing.status === "update") return "text-blue-600 hover:bg-gray-200 dark:text-blue-400 dark:hover:bg-gray-700";
  if (listing.status === "install") return "text-foreground hover:bg-gray-200 dark:hover:bg-gray-700";
  return "cursor-default text-gray-600 dark:text-gray-400";
}

function openExternal(url?: string) {
  const target = url?.trim();
  if (!target) return;
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  } catch {
    return;
  }
  if (isTauriRuntime()) void import("@tauri-apps/plugin-shell").then(({ open }) => open(target));
  else window.open(target, "_blank", "noopener,noreferrer");
}

async function refresh(preferredPluginId = props.focusTarget?.pluginId || selectedPluginId.value) {
  loading.value = true;
  error.value = "";
  try {
    [installedPlugins.value, trustedKeys.value, repositories.value] = await Promise.all([api.listPlugins(), api.listPluginTrustedKeys(), api.listPluginRepositories()]);
    await refreshMarketplace();
    if (props.focusTarget) applyFocusTarget(props.focusTarget);
    else selectFirstProvider(preferredPluginId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

async function refreshMarketplace() {
  marketplaceLoading.value = true;
  try {
    catalogResults.value = await api.fetchPluginMarketplaceCatalogs();
    marketplaceUnavailable.value = false;
  } catch (cause) {
    catalogResults.value = [];
    // Track total failure separately: catalogErrors is derived from catalogResults, which is
    // empty here, so without this flag the installed tab would silently read as "up to date".
    marketplaceUnavailable.value = true;
    toast(cause instanceof Error ? cause.message : String(cause), 5000);
  } finally {
    marketplaceLoading.value = false;
  }
}

function applyFocusTarget(focus: PluginCenterFocus) {
  activeSection.value = "installed";
  if (!focus.pluginId) return selectFirstProvider();
  const provider = connectionProviders.value.find((entry) => entry.plugin.manifest.id === focus.pluginId && (!focus.providerId || entry.contribution.id === focus.providerId));
  if (!provider) {
    selectPlugin(focus.pluginId);
    return;
  }
  selectProvider(focus.pluginId, provider.contribution.id);
}

function notifyPluginRuntimeReplaced(pluginId: string) {
  if (!isTauriRuntime()) emit("pluginRuntimeReplaced", pluginId);
}

// A recorded provenance that differs from the candidate listing (repository / publisher / signing
// key) requires an explicit confirmation before the plugin may be replaced. The backend enforces
// the same rule and rejects the install without allowSourceChange; this pre-check keeps that
// rejection out of the user's way by asking up front.
const pendingSourceChange = ref<{ listing: MarketplacePluginListing; change: PluginSourceChange } | null>(null);
function confirmUpdateSourceChange(listing: MarketplacePluginListing): boolean {
  const change = pluginSourceChange(listing);
  if (!change) return true;
  pendingSourceChange.value = { listing, change };
  return false;
}
function proceedUpdateSourceChange() {
  const pending = pendingSourceChange.value;
  pendingSourceChange.value = null;
  if (pending) void installMarketplaceListing(pending.listing, { allowSourceChange: true, skipSourceConfirmation: true });
}
function cancelUpdateSourceChange() {
  pendingSourceChange.value = null;
}

async function installListing(listing: MarketplacePluginListing, allowSourceChange = false): Promise<PluginInstallResult> {
  const result = await api.installMarketplacePlugin({
    repositoryId: listing.repository.id,
    pluginId: listing.plugin.id,
    version: listing.plugin.latestVersion,
    allowSourceChange: allowSourceChange || undefined,
  });
  notifyPluginRuntimeReplaced(result.plugin.manifest.id);
  beaconPluginInstall(listing.plugin.id, listing.plugin.latestVersion, listing.status === "update" ? "update" : "install");
  return result;
}

async function installMarketplaceListing(listing: MarketplacePluginListing, options: { allowSourceChange?: boolean; skipSourceConfirmation?: boolean } = {}) {
  if (mutationRunning.value || !listing.artifact || !isBatchSelectableListing(listing.status)) return;
  if (!options.skipSourceConfirmation && !confirmUpdateSourceChange(listing)) return;
  marketplaceInstallingKey.value = listing.key;
  try {
    const result = await installListing(listing, options.allowSourceChange === true);
    toast(t(listing.status === "update" ? "pluginPlatform.updateSuccess" : "pluginPlatform.installSuccess", { name: result.plugin.manifest.name, version: result.plugin.manifest.version }));
    // The COMPONENT_PLUGINS_UPDATED_EVENT handler does the panel-side refresh (icon cache +
    // installed list); notifyComponentUpdatesChanged drives the App-level update-center badge.
    notifyComponentPluginsUpdated();
    notifyComponentUpdatesChanged();
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    selectPlugin(result.plugin.manifest.id);
  } catch (cause) {
    toast(translateBackendError(t, cause), 8000);
    // A failed install can still have mutated the store (a partially replaced version directory, for
    // instance), so re-read the installed list instead of leaving the card on state it may no longer
    // describe.
    installedPlugins.value = await api.listPlugins().catch(() => installedPlugins.value);
    notifyComponentUpdatesChanged();
  } finally {
    marketplaceInstallingKey.value = "";
  }
}

function batchSummaryKey(outcome: { succeeded: unknown[]; failed: { name: string }[] }): string {
  return outcome.failed.length ? "pluginPlatform.batchSummaryWithFailures" : "pluginPlatform.batchSummary";
}

function reportBatchSummary(outcome: { succeeded: unknown[]; failed: { name: string; error: string }[] }) {
  const failedNames = outcome.failed.map((failure) => failure.name).join("、");
  error.value = outcome.failed.map((failure) => `${failure.name}: ${translateBackendError(t, failure.error)}`).join("\n");
  toast(t(batchSummaryKey(outcome), { success: outcome.succeeded.length, failed: outcome.failed.length, names: failedNames }), outcome.failed.length ? 8000 : 4000);
}

async function refreshAfterBatch() {
  try {
    installedPlugins.value = await api.listPlugins();
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
  } catch (cause) {
    error.value = [error.value, t("pluginPlatform.batchRefreshFailed", { error: cause instanceof Error ? cause.message : String(cause) })].filter(Boolean).join("\n");
  }
}

async function updateInstalledPlugin(pluginId: string) {
  const entry = installedUpdateEntryFor(pluginId);
  if (!entry || mutationRunning.value) return;
  await installMarketplaceListing(entry.listing);
}

async function runUpdateAllInstalled() {
  const entries = installedUpdateEntries.value.filter((entry) => !pluginSourceChange(entry.listing));
  const sourceChanged = installedUpdateEntries.value.filter((entry) => pluginSourceChange(entry.listing));
  if (sourceChanged.length) toast(t("pluginPlatform.batchSourceChangeSkipped", { names: sourceChanged.map((entry) => entry.listing.name).join("、") }), 8000);
  if (!entries.length || mutationRunning.value) return;
  batchRunning.value = true;
  error.value = "";
  installedUpdateProgress.value = { current: 0, total: entries.length };
  try {
    const outcome = await runBatch(
      entries,
      (entry) => entry.listing.name,
      async (entry) => {
        await installListing(entry.listing);
      },
      (current, total) => {
        installedUpdateProgress.value = { current, total };
      },
    );
    if (outcome.succeeded.length) {
      clearPluginIconCache();
      notifyComponentPluginsUpdated();
      notifyComponentUpdatesChanged();
    }
    reportBatchSummary(outcome);
    await refreshAfterBatch();
  } finally {
    batchRunning.value = false;
    installedUpdateProgress.value = null;
  }
}

async function refreshAfterExternalPluginUpdate() {
  clearPluginIconCache();
  try {
    installedPlugins.value = await api.listPlugins();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function handleComponentPluginsUpdated() {
  void refreshAfterExternalPluginUpdate();
}

function toggleBatchMode() {
  if (batchRunning.value) return;
  batchMode.value = !batchMode.value;
  if (!batchMode.value) clearBatchSelection();
}

function clearBatchSelection() {
  selectedListingKeys.value = new Set();
  selectedInstalledIds.value = new Set();
}

function isListingSelected(listing: MarketplacePluginListing): boolean {
  return selectedListingKeys.value.has(listing.key);
}

function toggleListingSelection(listing: MarketplacePluginListing) {
  if (batchRunning.value || !isBatchSelectableListing(listing.status)) return;
  const next = new Set(selectedListingKeys.value);
  if (next.has(listing.key)) next.delete(listing.key);
  else next.add(listing.key);
  selectedListingKeys.value = next;
}

function selectAllUpdatable() {
  if (batchRunning.value) return;
  const next = new Set(selectedListingKeys.value);
  for (const listing of batchUpdatableListings.value) next.add(listing.key);
  selectedListingKeys.value = next;
}

function isInstalledSelected(pluginId: string): boolean {
  return selectedInstalledIds.value.has(pluginId);
}

function toggleInstalledSelection(pluginId: string) {
  if (batchRunning.value) return;
  const next = new Set(selectedInstalledIds.value);
  if (next.has(pluginId)) next.delete(pluginId);
  else next.add(pluginId);
  selectedInstalledIds.value = next;
}

async function runBatchInstallUpdate() {
  const targets = batchSelectedListings.value;
  if (!targets.length || mutationRunning.value) return;
  const pluginIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const listing of marketplaceListings.value) {
    if (!selectedListingKeys.value.has(listing.key) || !isBatchSelectableListing(listing.status)) continue;
    if (pluginIds.has(listing.plugin.id)) duplicateIds.add(listing.plugin.id);
    pluginIds.add(listing.plugin.id);
  }
  if (duplicateIds.size) return toast(t("pluginPlatform.batchDuplicateSources", { names: [...duplicateIds].join("、") }), 8000);
  const sourceChangedListings = targets.filter((listing) => pluginSourceChange(listing));
  if (sourceChangedListings.length) return toast(t("pluginPlatform.batchSourceChangeSkipped", { names: sourceChangedListings.map((listing) => listing.name).join("、") }), 8000);
  batchRunning.value = true;
  error.value = "";
  try {
    const outcome = await runBatch(
      targets,
      (listing) => listing.name,
      async (listing) => {
        await installListing(listing);
      },
    );
    clearBatchSelection();
    reportBatchSummary(outcome);
    await refreshAfterBatch();
    notifyComponentUpdatesChanged();
  } finally {
    batchRunning.value = false;
  }
}

async function runBatchUninstall() {
  const targets = batchSelectedInstalled.value;
  if (!targets.length || mutationRunning.value) return;
  const names = targets.map((definition) => definition.plugin.manifest.name).join("、");
  if (!window.confirm(t("pluginPlatform.batchUninstallConfirm", { count: targets.length, names }))) return;
  batchRunning.value = true;
  error.value = "";
  try {
    const outcome = await runBatch(
      targets,
      (definition) => definition.plugin.manifest.name,
      async (definition) => {
        await api.uninstallPlugin(definition.plugin.manifest.id);
      },
    );
    clearBatchSelection();
    reportBatchSummary(outcome);
    await refreshAfterBatch();
    notifyComponentUpdatesChanged();
  } finally {
    batchRunning.value = false;
  }
}

async function saveRepository() {
  if (mutationRunning.value) return;
  const id = repositoryId.value.trim();
  const name = repositoryName.value.trim();
  const catalogUrl = repositoryCatalogUrl.value.trim();
  if (!id || !name || !catalogUrl) return toast(t("pluginPlatform.repositoryFieldsRequired"));
  operating.value = true;
  try {
    repositories.value = await api.savePluginRepository({ id, name, catalogUrl, kind: "custom", enabled: true, managed: false });
    repositoryId.value = "";
    repositoryName.value = "";
    repositoryCatalogUrl.value = "";
    toast(t("pluginPlatform.repositorySaved", { name }));
    await refreshMarketplace();
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : String(cause), 5000);
  } finally {
    operating.value = false;
  }
}

async function toggleRepository(repository: PluginRepository) {
  if (mutationRunning.value || repository.managed) return;
  operating.value = true;
  try {
    repositories.value = await api.savePluginRepository({ ...repository, enabled: !repository.enabled });
    await refreshMarketplace();
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : String(cause), 5000);
  } finally {
    operating.value = false;
  }
}

async function removeRepository(repository: PluginRepository) {
  if (mutationRunning.value || repository.managed || !window.confirm(t("pluginPlatform.removeRepositoryConfirm", { name: repository.name }))) return;
  operating.value = true;
  try {
    repositories.value = await api.removePluginRepository(repository.id);
    if (marketplaceRepositoryId.value === repository.id) marketplaceRepositoryId.value = "all";
    toast(t("pluginPlatform.repositoryRemoved", { name: repository.name }));
    await refreshMarketplace();
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : String(cause), 5000);
  } finally {
    operating.value = false;
  }
}

async function saveTrustedKey() {
  if (mutationRunning.value) return;
  const keyId = trustedKeyId.value.trim();
  const publicKey = trustedPublicKey.value.trim();
  if (!keyId || !publicKey) return;
  operating.value = true;
  try {
    trustedKeys.value = await api.savePluginTrustedKey(keyId, publicKey);
    trustedKeyId.value = "";
    trustedPublicKey.value = "";
    toast(t("pluginPlatform.repositoryKeyAdded", { keyId }));
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : String(cause), 5000);
  } finally {
    operating.value = false;
  }
}

async function removeTrustedKey(keyId: string) {
  if (mutationRunning.value || !window.confirm(t("pluginPlatform.removeRepositoryKeyConfirm", { keyId }))) return;
  operating.value = true;
  try {
    trustedKeys.value = await api.removePluginTrustedKey(keyId);
    toast(t("pluginPlatform.repositoryKeyRemoved", { keyId }));
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : String(cause), 5000);
  } finally {
    operating.value = false;
  }
}

function abbreviatedPublicKey(publicKey: string): string {
  return publicKey.length <= 24 ? publicKey : `${publicKey.slice(0, 12)}…${publicKey.slice(-8)}`;
}

function selectFirstProvider(preferredPluginId = "") {
  const first = connectionProviders.value.find((entry) => entry.plugin.manifest.id === preferredPluginId) || connectionProviders.value[0];
  if (first) return selectProvider(first.plugin.manifest.id, first.contribution.id);
  selectedPluginId.value = definitions.value.find((definition) => definition.plugin.manifest.id === preferredPluginId)?.plugin.manifest.id || definitions.value[0]?.plugin.manifest.id || "";
  selectedContributionId.value = "";
  selectedConnectionId.value = "";
}

function selectProvider(pluginId: string, contributionId: string) {
  selectedPluginId.value = pluginId;
  selectedContributionId.value = contributionId;
  const existing = connectionStore.connections.find((connection) => connection.db_type === "plugin" && connection.plugin_id === pluginId && connection.plugin_connection_provider === contributionId);
  selectedConnectionId.value = existing?.id || "";
}

function selectPlugin(pluginId: string) {
  const first = connectionProviders.value.find((entry) => entry.plugin.manifest.id === pluginId);
  if (first) return selectProvider(pluginId, first.contribution.id);
  selectedPluginId.value = pluginId;
  selectedContributionId.value = "";
  selectedConnectionId.value = "";
}

function selectConnection(connectionId: string) {
  selectedConnectionId.value = connectionId;
}

function editConnection(connectionId: string) {
  connectionStore.startEditing(connectionId);
}

function createConnection() {
  const entry = selectedEntry.value;
  if (!entry) return toast(t("pluginPlatform.selectConnectionProvider"));
  emit("newConnection", entry.plugin.manifest.id, entry.contribution.id);
}

async function openFilesystem(pluginId: string, providerId: string, label: string, rootUri?: string) {
  const connection = selectedConnection.value;
  try {
    if (connection) await connectionStore.ensureConnected(connection.id);
    queryStore.openPluginFilesystem(pluginId, providerId, {
      title: connection?.name || label,
      connectionId: connection?.id,
      rootUri,
    });
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : String(cause), 5000);
  }
}

function openWorkbench(pluginId: string, contributionId: string, label: string) {
  // PR-A4: when the plugin declares a command targeting this workbench, the entry opens through it
  // host-authored context — the SSH plugin lands directly in the local terminal); otherwise the legacy behavior applies.
  const command = registry.value.findCommandTargetingWorkbench(pluginId, contributionId);
  if (command) {
    const result = executePluginCommand(registry.value, queryStore, pluginId, command.id);
    if (result.error) toast(result.error, 5000);
    return;
  }
  const connection = selectedConnection.value;
  queryStore.openPluginWorkbench(pluginId, contributionId, {
    title: connection?.name || label,
    connectionId: connection?.id,
    context: connection
      ? {
          connectionId: connection.id,
          providerId: connection.plugin_connection_provider,
          connectionType: connection.plugin_connection_type,
        }
      : undefined,
  });
}

async function choosePluginPackage() {
  if (mutationRunning.value) return;
  if (!isTauriRuntime()) {
    webFileInput.value?.click();
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, filters: [{ name: t("pluginPlatform.packageFileType"), extensions: ["dbxp"] }] });
  if (typeof path === "string") await installPlugin(path);
}

async function handleWebPackage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) await installPlugin(file);
}

// Fire-and-forget install beacon for the marketplace stats worker
// (deploy/plugin-stats-worker, POST dbxio.com/api/plugins/install).
// Decorative counters only: no auth, no PII, failures are never surfaced.
function reportInstallBeacon(result: PluginInstallResult) {
  try {
    void fetch("https://dbxio.com/api/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: result.plugin.manifest.id, version: result.plugin.manifest.version }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // stats only — ignore beacon failures
  }
}

async function finishInstall(result: PluginInstallResult) {
  notifyPluginRuntimeReplaced(result.plugin.manifest.id);
  reportInstallBeacon(result);
  toast(t("pluginPlatform.installSuccess", { name: result.plugin.manifest.name, version: result.plugin.manifest.version }));
  clearPluginIconCache();
  notifyComponentPluginsUpdated();
  installedPlugins.value = await api.listPlugins();
  notifyComponentUpdatesChanged();
  window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
  selectPlugin(result.plugin.manifest.id);
  activeSection.value = "installed";
}

async function installPlugin(source: string | File) {
  if (mutationRunning.value) return;
  installing.value = true;
  try {
    const result = await api.installPluginPackage(source, allowUnsigned.value);
    await finishInstall(result);
  } catch (cause) {
    toast(translateBackendError(t, cause), 8000);
  } finally {
    installing.value = false;
  }
}

function isHttpPackageUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function installPluginFromUrl() {
  const url = installUrl.value.trim();
  if (!url || mutationRunning.value) return;
  if (!isHttpPackageUrl(url)) return toast(t("pluginPlatform.invalidPackageUrl"));
  urlInstalling.value = true;
  urlDownloadProgress.value = { downloaded: 0, total: null };
  let unlisten: (() => void) | undefined;
  try {
    if (isTauriRuntime()) {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ downloaded: number; total: number | null }>("plugin-url-download-progress", ({ payload }) => {
        urlDownloadProgress.value = payload;
      });
    }
    const result = await api.installPluginPackageFromUrl(url, allowUnsigned.value);
    installUrl.value = "";
    await finishInstall(result);
  } catch (cause) {
    toast(translateBackendError(t, cause), 8000);
  } finally {
    unlisten?.();
    urlInstalling.value = false;
    urlDownloadProgress.value = null;
  }
}

const urlProgressPercent = computed(() => {
  const progress = urlDownloadProgress.value;
  if (!progress?.total) return null;
  return Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
});

const urlProgressLabel = computed(() => {
  const progress = urlDownloadProgress.value;
  if (!progress) return "";
  const downloaded = formatBytes(progress.downloaded);
  return progress.total ? t("pluginPlatform.downloadProgress", { downloaded, total: formatBytes(progress.total) }) : t("pluginPlatform.downloadProgressUnknown", { downloaded });
});

function isPluginPackagePath(path: string): boolean {
  return /\.dbxp$/i.test(path);
}

function webDropPluginPackage(event: DragEvent): File | null {
  const files = event.dataTransfer?.files;
  if (!files) return null;
  for (let i = 0; i < files.length; i++) {
    if (isPluginPackagePath(files[i].name)) return files[i];
  }
  return null;
}

function onWebDragEnter(event: DragEvent) {
  if (!webDropPluginPackage(event)) return;
  event.preventDefault();
  webDragDepth++;
  draggingPackage.value = true;
}

function onWebDragOver(event: DragEvent) {
  if (!webDropPluginPackage(event)) return;
  event.preventDefault();
}

function onWebDragLeave() {
  if (webDragDepth > 0 && --webDragDepth === 0) draggingPackage.value = false;
}

function onWebDrop(event: DragEvent) {
  const claimed = draggingPackage.value;
  webDragDepth = 0;
  draggingPackage.value = false;
  const file = webDropPluginPackage(event);
  if (!file) {
    if (claimed) event.preventDefault();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (mutationRunning.value) return;
  void installPlugin(file);
}

function dropInsidePanel(payload: Exclude<TauriFileDropPayload, { type: "leave" }>): boolean {
  const root = panelRootRef.value;
  if (!root) return false;
  return physicalDropPositionInsideRect(payload.position, root.getBoundingClientRect(), window.devicePixelRatio);
}

function onTauriPluginDrop(event: Event) {
  const routedEvent = event as CustomEvent<TauriFileDropPayload>;
  const payload = routedEvent.detail;
  if (!payload) return;
  if (payload.type === "leave") {
    draggingPackage.value = false;
    return;
  }
  const inside = dropInsidePanel(payload);
  if (payload.type === "enter" || payload.type === "over") {
    const relevant = payload.type === "enter" ? inside && payload.paths.some(isPluginPackagePath) : inside;
    if (relevant) routedEvent.preventDefault();
    draggingPackage.value = relevant;
    return;
  }
  draggingPackage.value = false;
  const path = payload.paths.find(isPluginPackagePath);
  if (!inside || !path || mutationRunning.value) return;
  routedEvent.preventDefault();
  void installPlugin(path);
}

async function rollbackSelectedPlugin() {
  if (mutationRunning.value || !selectedPluginId.value || !window.confirm(t("pluginPlatform.rollbackConfirm"))) return;
  operating.value = true;
  try {
    const result = await api.rollbackPlugin(selectedPluginId.value);
    notifyPluginRuntimeReplaced(result.plugin.manifest.id);
    toast(t("pluginPlatform.rollbackSuccess", { version: result.plugin.manifest.version }));
    clearPluginIconCache();
    installedPlugins.value = await api.listPlugins();
    notifyComponentUpdatesChanged();
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    selectPlugin(result.plugin.manifest.id);
  } catch (cause) {
    toast(translateBackendError(t, cause), 8000);
  } finally {
    operating.value = false;
  }
}

async function uninstallSelectedPlugin() {
  const definition = selectedDefinition.value;
  if (mutationRunning.value || !definition || !window.confirm(t("pluginPlatform.uninstallConfirm", { name: definition.plugin.manifest.name }))) return;
  operating.value = true;
  try {
    installedPlugins.value = await api.uninstallPlugin(definition.plugin.manifest.id);
    notifyComponentUpdatesChanged();
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    clearPluginIconCache();
    toast(t("pluginPlatform.uninstallSuccess", { name: definition.plugin.manifest.name }));
    selectFirstProvider();
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : String(cause), 5000);
  } finally {
    operating.value = false;
  }
}

watch(connectionProviders, (providers) => {
  if (!providers.some((entry) => entry.plugin.manifest.id === selectedPluginId.value && entry.contribution.id === selectedContributionId.value)) selectFirstProvider(selectedPluginId.value);
});
watch(providerConnections, (connections) => {
  if (selectedConnectionId.value && connections.some((connection) => connection.id === selectedConnectionId.value)) return;
  selectedConnectionId.value = connections[0]?.id || "";
});
watch(
  () => props.focusTarget,
  (focus) => {
    if (focus && installedPlugins.value.length) applyFocusTarget(focus);
  },
  { deep: true },
);
let lastHandledInstallRequestId = 0;
watch(
  () => props.installUrlRequest,
  async (request) => {
    // immediate so a deep link that just opened the Plugin Center is consumed on
    // mount; the id guard keeps already-handled requests from replaying.
    if (!request || request.id <= lastHandledInstallRequestId) return;
    lastHandledInstallRequestId = request.id;
    installUrl.value = request.url;
    if (window.confirm(t("pluginPlatform.deepLinkInstallConfirm", { url: request.url }))) {
      await installPluginFromUrl();
    }
  },
  { immediate: true },
);
watch(allowUnsigned, (value) => {
  try {
    localStorage.setItem(PLUGIN_ALLOW_UNSIGNED_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // storage unavailable (private mode); the flag stays session-only
  }
});
onMounted(() => {
  void refresh();
  window.addEventListener(COMPONENT_PLUGINS_UPDATED_EVENT, handleComponentPluginsUpdated);
  if (isTauriRuntime()) document.addEventListener("dbx:tauri-file-drop", onTauriPluginDrop);
});
watch(marketplaceViewMode, (mode) => safeLocalStorageSet(MARKETPLACE_VIEW_MODE_STORAGE_KEY, mode));
onBeforeUnmount(() => {
  window.removeEventListener(COMPONENT_PLUGINS_UPDATED_EVENT, handleComponentPluginsUpdated);
  if (isTauriRuntime()) document.removeEventListener("dbx:tauri-file-drop", onTauriPluginDrop);
});
</script>

<template>
  <div ref="panelRootRef" class="plugin-center-view relative mx-auto flex h-full w-full max-w-6xl flex-col gap-4 overflow-hidden px-6 py-6" @dragenter="onWebDragEnter" @dragover="onWebDragOver" @dragleave="onWebDragLeave" @drop="onWebDrop">
    <input ref="webFileInput" type="file" accept=".dbxp" class="hidden" @change="handleWebPackage" />
    <div v-if="error" class="shrink-0 whitespace-pre-wrap rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{{ error }}</div>

    <Tabs v-model="activeSection" class="min-h-0 flex-1 gap-3">
      <TabsList class="grid h-9 w-full grid-cols-3">
        <TabsTrigger value="marketplace" class="gap-1.5 text-xs"><Store class="size-3.5" />{{ t("pluginPlatform.marketplace") }}</TabsTrigger>
        <TabsTrigger value="installed" class="gap-1.5 text-xs">
          <PackageCheck class="size-3.5" />{{ t("pluginPlatform.installed") }}
          <span v-if="installedUpdateCount" class="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-amber-950 dark:text-amber-950">{{ installedUpdateCount > 99 ? "99+" : installedUpdateCount }}</span>
        </TabsTrigger>
        <TabsTrigger value="settings" class="gap-1.5 text-xs"><Settings2 class="size-3.5" />{{ t("pluginPlatform.settings") }}</TabsTrigger>
      </TabsList>

      <TabsContent value="marketplace" class="m-0 min-h-0 flex-1 overflow-y-auto">
        <div class="flex min-h-full w-full flex-col gap-4 pb-2">
          <div class="flex items-start gap-2.5 rounded-xl border bg-card/70 px-4 py-3">
            <Info class="mt-0.5 size-3.5 shrink-0 text-primary" />
            <div class="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
              <span class="font-medium text-foreground">{{ t("pluginPlatform.marketplaceGuideTitle") }}</span>
              <span class="mx-1.5 text-border">·</span>{{ t("pluginPlatform.marketplaceGuideDescription") }}
            </div>
          </div>
          <div class="flex w-full flex-col gap-2 rounded-xl border bg-card/70 p-3 sm:flex-row sm:items-center">
            <div class="relative">
              <Search class="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
              <Input data-plugin-marketplace-search v-model="marketplaceQuery" class="h-8 min-w-0 pl-8 text-xs sm:w-[min(100%,28rem)]" :placeholder="t('pluginPlatform.searchMarketplace')" />
            </div>
            <div class="flex min-w-0 items-center gap-2 sm:ml-auto">
              <Select v-model="marketplaceRepositoryId">
                <SelectTrigger class="h-8 min-w-0 flex-1 text-xs sm:w-52 sm:flex-none"><SelectValue :placeholder="t('pluginPlatform.allRepositories')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{{ t("pluginPlatform.allRepositories") }}</SelectItem>
                  <SelectItem v-for="repository in repositories.filter((entry) => entry.enabled)" :key="repository.id" :value="repository.id">{{ repository.name }}</SelectItem>
                </SelectContent>
              </Select>
              <div class="flex shrink-0 items-center rounded-md border bg-muted/20 p-0.5">
                <button
                  type="button"
                  class="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                  :class="marketplaceViewMode === 'grid' ? 'bg-background text-foreground shadow-sm' : ''"
                  :aria-label="t('structure.viewGrid')"
                  :aria-pressed="marketplaceViewMode === 'grid'"
                  @click="marketplaceViewMode = 'grid'"
                >
                  <LayoutGrid class="size-3.5" />
                </button>
                <button
                  type="button"
                  class="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                  :class="marketplaceViewMode === 'list' ? 'bg-background text-foreground shadow-sm' : ''"
                  :aria-label="t('structure.viewList')"
                  :aria-pressed="marketplaceViewMode === 'list'"
                  @click="marketplaceViewMode = 'list'"
                >
                  <List class="size-3.5" />
                </button>
              </div>
              <Button variant="outline" size="sm" class="h-8 shrink-0 gap-1.5 text-xs" :pressed="batchMode" :disabled="batchRunning" @click="toggleBatchMode"> <Check class="size-3.5" />{{ batchMode ? t("pluginPlatform.batchDone") : t("pluginPlatform.batchManage") }} </Button>
              <Button variant="ghost" size="icon-sm" class="shrink-0" :disabled="marketplaceLoading" :title="t('common.refresh')" :aria-label="t('common.refresh')" @click="refreshMarketplace"><RefreshCw class="size-3.5" :class="marketplaceLoading ? 'animate-spin' : ''" /></Button>
            </div>
          </div>

          <div v-if="batchMode" class="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/20 px-3 py-2 text-xs">
            <span class="font-medium text-foreground">{{ t("pluginPlatform.batchSelected", { count: batchSelectedListings.length }) }}</span>
            <div class="ml-auto flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" class="h-7 gap-1.5 text-xs" :disabled="!batchUpdatableListings.length || batchRunning" @click="selectAllUpdatable"><Download class="size-3.5" />{{ t("pluginPlatform.batchSelectAllUpdatable") }}</Button>
              <Button size="sm" class="h-7 gap-1.5 text-xs" :disabled="!batchSelectedListings.length || mutationRunning" @click="runBatchInstallUpdate"> <Loader2 v-if="batchRunning" class="size-3.5 animate-spin" />{{ t("pluginPlatform.batchInstallUpdate") }} </Button>
              <Button variant="ghost" size="sm" class="h-7 text-xs" :disabled="batchRunning" @click="toggleBatchMode">{{ t("common.cancel") }}</Button>
            </div>
          </div>

          <div v-for="result in catalogErrors" :key="result.repository.id" class="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            <CircleAlert class="mt-0.5 size-3.5 shrink-0" />
            <div>
              <span class="font-medium">{{ result.repository.name }}:</span> {{ result.error }}
            </div>
          </div>

          <div v-if="marketplaceLoading" class="flex min-h-[440px] flex-1 items-center justify-center gap-2 rounded-lg border border-dashed p-12 text-xs text-muted-foreground"><Loader2 class="size-4 animate-spin" />{{ t("pluginPlatform.loadingMarketplace") }}</div>
          <div v-else-if="!filteredMarketplaceListings.length" class="flex min-h-[440px] flex-1 flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
            <Store class="size-7 text-muted-foreground" />
            <div class="mt-3 text-sm font-medium">{{ t("pluginPlatform.noMarketplacePlugins") }}</div>
            <div class="mt-1 text-xs text-muted-foreground">{{ t("pluginPlatform.noMarketplacePluginsDescription") }}</div>
          </div>
          <div v-else-if="marketplaceViewMode === 'grid'" class="grid w-full grid-cols-1 gap-3 md:grid-cols-3">
            <article v-for="listing in filteredMarketplaceListings" :key="listing.key" class="group flex min-w-0 min-h-48 flex-col rounded-xl border bg-card p-4 transition-colors hover:border-primary/40">
              <div class="flex items-start gap-3">
                <button
                  v-if="batchMode && isBatchSelectableListing(listing.status)"
                  type="button"
                  class="mt-1 inline-flex size-4 shrink-0 items-center justify-center rounded border transition-colors"
                  :class="isListingSelected(listing) ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40 bg-background'"
                  :aria-pressed="isListingSelected(listing)"
                  :aria-label="listing.name"
                  :disabled="batchRunning"
                  @click.stop="toggleListingSelection(listing)"
                >
                  <Check v-if="isListingSelected(listing)" class="size-3" />
                </button>
                <PluginIcon :plugin-id="listing.plugin.id" :icon="listing.plugin.icon" class="size-11 rounded-xl border bg-background p-1.5" />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="truncate text-sm font-semibold">{{ listing.name }}</span>
                  </div>
                  <div class="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <BadgeCheck v-if="listingRepositoryCanVerify(listing.repository)" class="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" :title="t('pluginPlatform.verified')" :aria-label="t('pluginPlatform.verified')" />
                    <span class="truncate">{{ listing.plugin.publisher }} · {{ listing.repository.name }}</span>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  <button
                    v-if="listing.plugin.source"
                    type="button"
                    class="rounded p-0.5 opacity-60 transition-opacity [will-change:opacity] hover:opacity-100"
                    :title="t('pluginPlatform.sourceRepository')"
                    :aria-label="t('pluginPlatform.sourceRepository')"
                    @click.stop="openExternal(listing.plugin.source)"
                  >
                    <GithubIcon icon-class="size-3.5" />
                  </button>
                  <button
                    v-if="marketplaceHomepageUrl(listing.plugin.source, listing.plugin.homepage)"
                    type="button"
                    class="rounded p-0.5 opacity-60 transition-opacity [will-change:opacity] hover:opacity-100"
                    :title="t('pluginPlatform.pluginHomepage')"
                    :aria-label="t('pluginPlatform.pluginHomepage')"
                    @click.stop="openExternal(marketplaceHomepageUrl(listing.plugin.source, listing.plugin.homepage))"
                  >
                    <Globe class="size-3.5" />
                  </button>
                  <Badge variant="outline" class="h-5 px-1.5 text-[10px]">v{{ listing.plugin.latestVersion }}</Badge>
                </div>
              </div>
              <div class="mt-3 flex flex-wrap gap-1.5">
                <Badge v-for="tag in listing.plugin.tags.slice(0, 3)" :key="tag" variant="outline" class="h-5 px-1.5 text-[10px]">{{ tag }}</Badge>
                <Badge v-if="listing.plugin.permissions.length" variant="outline" class="h-5 px-1.5 text-[10px]">{{ t("pluginPlatform.permissionsCount", { count: listing.plugin.permissions.length }) }}</Badge>
              </div>
              <Tooltip :delay-duration="700">
                <TooltipTrigger as-child>
                  <p class="mt-3 line-clamp-3 cursor-help text-xs leading-5 text-muted-foreground">{{ listing.description || t("pluginPlatform.noDescription") }}</p>
                </TooltipTrigger>
                <TooltipContent side="bottom" class="max-w-md whitespace-pre-wrap break-words">{{ listing.description || t("pluginPlatform.noDescription") }}</TooltipContent>
              </Tooltip>
              <div class="mt-auto flex items-center justify-between gap-3 pt-4">
                <div class="text-[11px] text-muted-foreground">
                  <span v-if="listing.status === 'unsupported'">{{ t("pluginPlatform.unsupportedTarget", { target: listing.target }) }}</span>
                  <!-- In the update state the left line states both versions: the badge above shows the
                       catalog latest version, which otherwise reads as the installed one. -->
                  <span v-else-if="listing.installed && listing.status === 'update'">{{ t("pluginPlatform.installedVersionUpdatable", { installed: listing.installed.manifest.version, latest: listing.plugin.latestVersion }) }}</span>
                  <span v-else-if="listing.installed">{{ t("pluginPlatform.installedVersion", { version: listing.installed.manifest.version }) }}</span>
                  <span v-else>{{ listing.plugin.license || t("pluginPlatform.licenseUnknown") }}</span>
                </div>
                <button
                  type="button"
                  class="inline-flex h-7 items-center justify-center gap-1.5 rounded-full border-0 bg-gray-100 px-4 py-1 text-xs font-semibold transition-colors disabled:opacity-50 dark:bg-gray-800"
                  :class="marketplaceActionClass(listing)"
                  :disabled="listing.status === 'installed' || listing.status === 'unsupported' || mutationRunning"
                  @click="installMarketplaceListing(listing)"
                >
                  <Loader2 v-if="marketplaceInstallingKey === listing.key" class="size-3.5 animate-spin" />
                  {{ t(`pluginPlatform.marketplaceStatus.${listing.status}`) }}
                </button>
              </div>
            </article>
          </div>
          <div v-else class="flex w-full flex-col gap-2">
            <article v-for="listing in filteredMarketplaceListings" :key="listing.key" class="flex items-center gap-3 rounded-xl border bg-card p-3 transition-colors hover:border-primary/40">
              <button
                v-if="batchMode && isBatchSelectableListing(listing.status)"
                type="button"
                class="inline-flex size-4 shrink-0 items-center justify-center rounded border transition-colors"
                :class="isListingSelected(listing) ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40 bg-background'"
                :aria-pressed="isListingSelected(listing)"
                :aria-label="listing.name"
                :disabled="batchRunning"
                @click.stop="toggleListingSelection(listing)"
              >
                <Check v-if="isListingSelected(listing)" class="size-3" />
              </button>
              <PluginIcon :plugin-id="listing.plugin.id" :icon="listing.plugin.icon" class="size-10 rounded-lg border bg-background p-1.5" />
              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="truncate text-sm font-semibold">{{ listing.name }}</span>
                  <button
                    v-if="listing.plugin.source"
                    type="button"
                    class="shrink-0 rounded p-0.5 opacity-60 transition-opacity [will-change:opacity] hover:opacity-100"
                    :title="t('pluginPlatform.sourceRepository')"
                    :aria-label="t('pluginPlatform.sourceRepository')"
                    @click.stop="openExternal(listing.plugin.source)"
                  >
                    <GithubIcon icon-class="size-3.5" />
                  </button>
                  <button
                    v-if="marketplaceHomepageUrl(listing.plugin.source, listing.plugin.homepage)"
                    type="button"
                    class="shrink-0 rounded p-0.5 opacity-60 transition-opacity [will-change:opacity] hover:opacity-100"
                    :title="t('pluginPlatform.pluginHomepage')"
                    :aria-label="t('pluginPlatform.pluginHomepage')"
                    @click.stop="openExternal(marketplaceHomepageUrl(listing.plugin.source, listing.plugin.homepage))"
                  >
                    <Globe class="size-3.5" />
                  </button>
                  <Badge variant="outline" class="h-5 shrink-0 px-1.5 text-[10px]">v{{ listing.plugin.latestVersion }}</Badge>
                </div>
                <div class="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                  <BadgeCheck v-if="listingRepositoryCanVerify(listing.repository)" class="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" :title="t('pluginPlatform.verified')" :aria-label="t('pluginPlatform.verified')" />
                  <span class="truncate">{{ listing.plugin.publisher }} · {{ listing.repository.name }}</span>
                </div>
                <Tooltip :delay-duration="700">
                  <TooltipTrigger as-child>
                    <p class="mt-1 cursor-help truncate text-xs text-muted-foreground">{{ listing.description || t("pluginPlatform.noDescription") }}</p>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" class="max-w-md whitespace-pre-wrap break-words">{{ listing.description || t("pluginPlatform.noDescription") }}</TooltipContent>
                </Tooltip>
              </div>
              <div class="hidden max-w-52 shrink-0 gap-1.5 lg:flex">
                <Badge v-for="tag in listing.plugin.tags.slice(0, 3)" :key="tag" variant="outline" class="h-5 px-1.5 text-[10px]">{{ tag }}</Badge>
              </div>
              <button
                type="button"
                class="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-full border-0 bg-gray-100 px-4 py-1 text-xs font-semibold transition-colors disabled:opacity-50 dark:bg-gray-800"
                :class="marketplaceActionClass(listing)"
                :disabled="listing.status === 'installed' || listing.status === 'unsupported' || mutationRunning"
                @click="installMarketplaceListing(listing)"
              >
                <Loader2 v-if="marketplaceInstallingKey === listing.key" class="size-3.5 animate-spin" />
                <span class="hidden sm:inline">{{ t(`pluginPlatform.marketplaceStatus.${listing.status}`) }}</span>
              </button>
            </article>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="installed" class="m-0 min-h-0 flex-1 overflow-y-auto">
        <div v-if="loading && !installedPlugins.length" class="py-10 text-center text-xs text-muted-foreground">{{ t("common.loading") }}</div>
        <div v-else-if="!installedPlugins.length" class="rounded-lg border border-dashed p-10 text-center">
          <PackageCheck class="mx-auto size-7 text-muted-foreground" />
          <div class="mt-3 text-sm font-medium">{{ t("pluginPlatform.noInstalledPlugins") }}</div>
          <div class="mt-1 text-xs text-muted-foreground">{{ t("pluginPlatform.noInstalledPluginsDescription") }}</div>
          <Button class="mt-4 gap-1.5" size="sm" @click="activeSection = 'marketplace'"><Store class="size-3.5" />{{ t("pluginPlatform.browseMarketplace") }}</Button>
        </div>
        <div v-else class="flex min-h-[440px] flex-col gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" class="h-8 gap-1.5 text-xs" :pressed="batchMode" :disabled="batchRunning" @click="toggleBatchMode"> <Check class="size-3.5" />{{ batchMode ? t("pluginPlatform.batchDone") : t("pluginPlatform.batchManage") }} </Button>
            <template v-if="batchMode">
              <span class="text-xs font-medium text-foreground">{{ t("pluginPlatform.batchSelected", { count: batchSelectedInstalled.length }) }}</span>
              <Button size="sm" variant="outline" class="ml-auto h-8 gap-1.5 text-xs text-destructive" :disabled="!batchSelectedInstalled.length || mutationRunning" @click="runBatchUninstall">
                <Loader2 v-if="batchRunning" class="size-3.5 animate-spin" /><Trash2 class="size-3.5" />{{ t("pluginPlatform.batchUninstall") }}
              </Button>
              <Button variant="ghost" size="sm" class="h-8 text-xs" :disabled="batchRunning" @click="toggleBatchMode">{{ t("common.cancel") }}</Button>
            </template>
            <Button variant="ghost" size="icon-sm" class="shrink-0" :class="batchMode ? '' : 'ml-auto'" :disabled="marketplaceLoading" :title="t('pluginPlatform.refresh')" :aria-label="t('pluginPlatform.refresh')" @click="refreshMarketplace"
              ><RefreshCw class="size-3.5" :class="marketplaceLoading ? 'animate-spin' : ''"
            /></Button>
          </div>

          <!-- Partial catalog failure (some enabled repositories errored): the check is incomplete,
               so it is surfaced on its own and must never degrade into "all up to date". -->
          <div v-if="catalogPartialFailure" class="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            <CircleAlert class="mt-0.5 size-3.5 shrink-0" />
            <div>{{ t("pluginPlatform.updateCheckPartialFailure") }}</div>
          </div>
          <div v-for="result in catalogErrors" :key="`installed-${result.repository.id}`" class="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            <CircleAlert class="mt-0.5 size-3.5 shrink-0" />
            <div>
              <span class="font-medium">{{ result.repository.name }}:</span> {{ result.error }}
            </div>
          </div>
          <!-- Honest update-check states: a failed or missing catalog must never read as "up to date". -->
          <div v-if="marketplaceUnavailable" class="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            <CircleAlert class="mt-0.5 size-3.5 shrink-0" />
            <div class="min-w-0 flex-1">
              <span class="font-medium">{{ t("pluginPlatform.updateCheckUnavailable") }}</span> · {{ t("pluginPlatform.updateCheckUnavailableDescription") }}
            </div>
            <Button variant="outline" size="sm" class="h-6 shrink-0 text-xs" :disabled="marketplaceLoading" @click="refreshMarketplace"><RefreshCw class="size-3" :class="marketplaceLoading ? 'animate-spin' : ''" />{{ t("pluginPlatform.refresh") }}</Button>
          </div>
          <div v-else-if="!repositoriesEnabled && installedPlugins.length" class="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs text-muted-foreground">
            <CircleAlert class="mt-0.5 size-3.5 shrink-0" />
            <div>{{ t("pluginPlatform.noRepositoriesEnabled") }}</div>
          </div>
          <div v-else-if="installedUpdateCount" class="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
            <div class="min-w-0">
              <div class="text-sm font-semibold">{{ t("pluginPlatform.installedUpdatesAvailableTitle", { count: installedUpdateCount }) }}</div>
              <p class="text-xs text-muted-foreground">{{ t("pluginPlatform.installedUpdatesAvailableDescription") }}</p>
            </div>
            <div class="ml-auto flex shrink-0 items-center gap-2">
              <Button size="sm" class="h-7 text-xs" :disabled="mutationRunning" @click="runUpdateAllInstalled">
                <Loader2 v-if="installedUpdateProgress" class="size-3 animate-spin" />
                <Download v-else class="size-3" />
                {{ installedUpdateProgress ? t("pluginPlatform.updatingProgress", installedUpdateProgress) : t("pluginPlatform.updateAll") }}
              </Button>
            </div>
          </div>
          <div v-else-if="catalogChecked && !catalogPartialFailure && installedPlugins.length" class="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs text-muted-foreground">
            <BadgeCheck class="size-3.5 text-emerald-600 dark:text-emerald-400" />
            <div>{{ t("pluginPlatform.allPluginsUpToDate") }}</div>
          </div>
          <div v-else-if="marketplaceLoading && installedPlugins.length" class="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs text-muted-foreground">
            <Loader2 class="size-3.5 animate-spin" />
            <div>{{ t("pluginPlatform.checkingForUpdates") }}</div>
          </div>
          <div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div class="space-y-1 rounded-lg border bg-muted/10 p-2">
              <div
                v-for="definition in definitions"
                :key="definition.plugin.manifest.id"
                :data-plugin-id="definition.plugin.manifest.id"
                class="group/plugin-row flex w-full items-start rounded-md hover:bg-muted"
                :class="batchMode ? (isInstalledSelected(definition.plugin.manifest.id) ? 'bg-muted ring-1 ring-primary/30' : '') : selectedPluginId === definition.plugin.manifest.id ? 'bg-muted ring-1 ring-primary/30' : ''"
              >
                <button type="button" class="flex min-w-0 flex-1 items-start gap-2 px-2 py-2 text-left" :disabled="batchMode && batchRunning" @click="batchMode ? toggleInstalledSelection(definition.plugin.manifest.id) : selectPlugin(definition.plugin.manifest.id)">
                  <span
                    v-if="batchMode"
                    class="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded border transition-colors"
                    :class="isInstalledSelected(definition.plugin.manifest.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40 bg-background'"
                    ><Check v-if="isInstalledSelected(definition.plugin.manifest.id)" class="size-3"
                  /></span>
                  <Check v-else-if="selectedPluginId === definition.plugin.manifest.id" class="mt-0.5 size-3.5 shrink-0 text-primary" /><span v-else class="mt-0.5 size-3.5 shrink-0" />
                  <PluginIcon :plugin-id="definition.plugin.manifest.id" :icon="definition.plugin.manifest.icon" class="size-8 rounded-md border bg-background p-1" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium">{{ definition.plugin.manifest.name }}</span>
                    <span class="mt-1 flex flex-wrap gap-1">
                      <Badge variant="outline" class="h-4 px-1.5 text-[10px]">v{{ definition.plugin.manifest.version || "-" }}</Badge>
                      <span
                        v-if="installedUpdateEntryFor(definition.plugin.manifest.id)"
                        class="inline-flex h-4 items-center gap-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                        :title="t('pluginPlatform.installedVersionUpdatable', { installed: definition.plugin.manifest.version || '0.0.0', latest: installedUpdateEntryFor(definition.plugin.manifest.id)?.listing.plugin.latestVersion })"
                      >
                        <ArrowUp class="size-2.5" />v{{ installedUpdateEntryFor(definition.plugin.manifest.id)?.listing.plugin.latestVersion }}
                      </span>
                      <Badge :variant="definition.plugin.compatibility.compatible ? 'secondary' : 'destructive'" class="h-4 px-1.5 text-[10px]">{{ definition.plugin.compatibility.compatible ? t("pluginPlatform.compatible") : t("pluginPlatform.blocked") }}</Badge>
                      <Badge v-if="catalogChecked && !catalogPartialFailure && !pluginInCatalog(definition.plugin.manifest.id)" variant="outline" class="h-4 border-dashed px-1.5 text-[10px] text-muted-foreground" :title="t('pluginPlatform.notInRepositoriesHint')">{{
                        t("pluginPlatform.notInRepositories")
                      }}</Badge>
                      <Badge
                        v-else-if="installedUnsupportedListingFor(definition.plugin.manifest.id)"
                        variant="outline"
                        class="h-4 border-dashed px-1.5 text-[10px] text-muted-foreground"
                        :title="t('pluginPlatform.unsupportedTarget', { target: installedUnsupportedListingFor(definition.plugin.manifest.id)?.target })"
                        >{{ t("pluginPlatform.marketplaceStatus.unsupported") }}</Badge
                      >
                    </span>
                  </span>
                </button>
                <button
                  v-if="!batchMode"
                  type="button"
                  class="mr-2 mt-2 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  :class="isPluginPinned(definition.plugin.manifest.id) ? 'text-primary' : 'opacity-0 group-hover/plugin-row:opacity-100 focus-visible:opacity-100'"
                  :aria-pressed="isPluginPinned(definition.plugin.manifest.id)"
                  :aria-label="isPluginPinned(definition.plugin.manifest.id) ? t('pluginPlatform.unpinPlugin') : t('pluginPlatform.pinPlugin')"
                  :title="isPluginPinned(definition.plugin.manifest.id) ? t('pluginPlatform.unpinPlugin') : t('pluginPlatform.pinPlugin')"
                  @click.stop="togglePluginPinned(definition.plugin.manifest.id)"
                  @keydown.enter.stop.prevent="togglePluginPinned(definition.plugin.manifest.id)"
                  @keydown.space.stop.prevent="togglePluginPinned(definition.plugin.manifest.id)"
                >
                  <Pin v-if="isPluginPinned(definition.plugin.manifest.id)" class="size-3.5" />
                  <PinOff v-else class="size-3.5" />
                </button>
                <span v-else class="mr-2 mt-2 size-6 shrink-0" aria-hidden="true" />
              </div>
            </div>

            <div class="space-y-4 rounded-lg border p-4">
              <template v-if="selectedDefinition">
                <div class="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
                  <div class="flex min-w-0 items-start gap-3">
                    <PluginIcon :plugin-id="selectedDefinition.plugin.manifest.id" :icon="selectedDefinition.plugin.manifest.icon" class="size-10 rounded-lg border bg-background p-1.5" />
                    <div class="min-w-0">
                      <div class="text-sm font-medium">{{ selectedDefinition.plugin.manifest.name }}</div>
                      <div class="mt-1 text-xs leading-5 text-muted-foreground">{{ selectedDefinition.plugin.manifest.description }}</div>
                      <div class="mt-1 flex flex-wrap items-center gap-1.5">
                        <span class="font-mono text-[10px] text-muted-foreground">{{ selectedDefinition.plugin.manifest.id }}</span>
                        <button
                          v-if="selectedDefinition.plugin.manifest.source"
                          type="button"
                          class="rounded p-0.5 text-muted-foreground opacity-70 transition-opacity hover:text-foreground hover:opacity-100"
                          :title="t('pluginPlatform.sourceRepository')"
                          :aria-label="t('pluginPlatform.sourceRepository')"
                          @click="openExternal(selectedDefinition.plugin.manifest.source)"
                        >
                          <GithubIcon />
                        </button>
                        <button
                          v-if="marketplaceHomepageUrl(selectedDefinition.plugin.manifest.source, selectedDefinition.plugin.manifest.homepage)"
                          type="button"
                          class="rounded p-0.5 text-muted-foreground opacity-70 transition-opacity hover:text-foreground hover:opacity-100"
                          :title="t('pluginPlatform.pluginHomepage')"
                          :aria-label="t('pluginPlatform.pluginHomepage')"
                          @click="openExternal(marketplaceHomepageUrl(selectedDefinition.plugin.manifest.source, selectedDefinition.plugin.manifest.homepage))"
                        >
                          <Globe class="size-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div class="flex flex-col items-end gap-1.5">
                    <div class="flex gap-2">
                      <Button v-if="selectedUpdateEntry" size="sm" class="gap-1.5" :disabled="mutationRunning" @click="updateInstalledPlugin(selectedUpdateEntry.listing.plugin.id)">
                        <Loader2 v-if="marketplaceInstallingKey === selectedUpdateEntry.listing.key" class="size-3.5 animate-spin" />
                        <Download v-else class="size-3.5" />{{ t("pluginPlatform.updateToVersion", { version: selectedUpdateEntry.listing.plugin.latestVersion }) }}
                      </Button>
                      <Button size="sm" variant="outline" class="gap-1.5" :disabled="mutationRunning" @click="rollbackSelectedPlugin"><RotateCcw class="size-3.5" />{{ t("pluginPlatform.rollback") }}</Button>
                      <Button size="sm" variant="outline" class="gap-1.5 text-destructive" :disabled="mutationRunning" @click="uninstallSelectedPlugin"><Trash2 class="size-3.5" />{{ t("pluginPlatform.uninstall") }}</Button>
                    </div>
                    <span v-if="selectedUpdateEntry" class="text-[11px] text-muted-foreground"
                      >{{ t("pluginPlatform.installedVersionUpdatable", { installed: selectedDefinition?.plugin.manifest.version || "0.0.0", latest: selectedUpdateEntry.listing.plugin.latestVersion }) }} · {{ selectedUpdateEntry.repositoryName }}</span
                    >
                  </div>
                </div>

                <div v-if="connectionProviders.some((entry) => entry.plugin.manifest.id === selectedPluginId)" class="space-y-3">
                  <div class="flex flex-wrap gap-2">
                    <Button
                      v-for="entry in connectionProviders.filter((candidate) => candidate.plugin.manifest.id === selectedPluginId)"
                      :key="entry.contribution.id"
                      size="sm"
                      :variant="selectedContributionId === entry.contribution.id ? 'secondary' : 'outline'"
                      @click="selectProvider(entry.plugin.manifest.id, entry.contribution.id)"
                      ><PluginIcon :plugin-id="entry.plugin.manifest.id" :icon="pluginConnectionProviderIcon(entry)" class="mr-1 size-3.5" />{{ entry.contribution.label }}</Button
                    >
                  </div>
                  <div v-if="selectedEntry" class="space-y-4 rounded-lg border p-4">
                    <div class="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div class="text-sm font-medium">{{ selectedEntry.contribution.label }}</div>
                        <div class="mt-1 text-xs text-muted-foreground">{{ selectedEntry.contribution.description || selectedEntry.contribution.database_type }}</div>
                      </div>
                      <Badge variant="outline">{{ t("pluginPlatform.connectionProvider") }}</Badge>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <Button size="sm" class="gap-1.5" @click="createConnection"><Plus class="size-3.5" />{{ t("pluginPlatform.newConnection") }}</Button>
                      <div v-for="connection in providerConnections" :key="connection.id" class="inline-flex items-center">
                        <Button size="sm" class="rounded-r-none" :variant="selectedConnectionId === connection.id ? 'secondary' : 'outline'" @click="selectConnection(connection.id)">{{ connection.name }}</Button>
                        <Button size="icon-sm" class="rounded-l-none border-l-0" :variant="selectedConnectionId === connection.id ? 'secondary' : 'outline'" :title="t('common.edit')" :aria-label="t('common.edit')" @click="editConnection(connection.id)"><Pencil class="size-3.5" /></Button>
                      </div>
                    </div>
                    <div class="rounded-md border border-dashed bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">{{ t("pluginPlatform.connectionManagedInDialog") }}</div>
                  </div>
                </div>

                <div v-if="selectedWorkbenches.length" class="space-y-2">
                  <div class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t("pluginPlatform.workbenches") }}</div>
                  <div v-for="entry in selectedWorkbenches" :key="entry.contribution.id" class="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div>
                      <div class="text-sm font-medium">{{ entry.contribution.label }}</div>
                      <div class="text-xs text-muted-foreground">{{ entry.contribution.description || entry.contribution.id }}</div>
                    </div>
                    <Button size="sm" variant="outline" class="gap-1.5" @click="openWorkbench(entry.plugin.manifest.id, entry.contribution.id, entry.contribution.label)"><ExternalLink class="size-3.5" />{{ t("pluginPlatform.open") }}</Button>
                  </div>
                </div>

                <div v-if="selectedFilesystems.length && !selectedHasCommands" class="space-y-2">
                  <div class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t("pluginPlatform.filesystemProviders") }}</div>
                  <div v-for="entry in selectedFilesystems" :key="entry.contribution.id" class="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div>
                      <div class="text-sm font-medium">{{ entry.contribution.label }}</div>
                      <div class="mt-1 text-xs text-muted-foreground">{{ entry.contribution.schemes.join(", ") }} · {{ (entry.contribution.capabilities || []).join(", ") }}</div>
                    </div>
                    <Button size="sm" variant="outline" class="gap-1.5" @click="openFilesystem(entry.plugin.manifest.id, entry.contribution.id, entry.contribution.label, entry.contribution.root_uri)"><FolderTree class="size-3.5" />{{ t("pluginPlatform.browse") }}</Button>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="settings" class="m-0 min-h-0 flex-1 overflow-y-auto">
        <div class="space-y-4 pb-2">
          <section class="space-y-3 rounded-xl border p-4">
            <div class="flex items-start gap-3">
              <div class="rounded-md bg-primary/10 p-2 text-primary"><FileUp class="size-4" /></div>
              <div>
                <div class="text-sm font-medium">{{ t("pluginPlatform.localInstallTitle") }}</div>
                <div class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("pluginPlatform.localInstallDescription") }}</div>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-3">
              <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="mutationRunning" @click="choosePluginPackage"><Loader2 v-if="installing" class="size-3.5 animate-spin" /><FileUp v-else class="size-3.5" />{{ t("pluginPlatform.installPackage") }}</Button>
              <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground"><ShieldCheck class="size-3.5 text-emerald-600 dark:text-emerald-400" />{{ t("pluginPlatform.signedPackagesVerifiedAutomatically") }}</div>
              <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground"><FileUp class="size-3.5" />{{ t("pluginPlatform.dropInstallHint") }}</div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <div class="relative min-w-0 flex-1 sm:max-w-md">
                <Link2 class="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
                <Input v-model="installUrl" class="h-8 pl-8 font-mono text-xs" type="url" :disabled="urlInstalling" :placeholder="t('pluginPlatform.installUrlPlaceholder')" @keyup.enter="installPluginFromUrl" />
              </div>
              <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="mutationRunning || !installUrl.trim()" @click="installPluginFromUrl"><Loader2 v-if="urlInstalling" class="size-3.5 animate-spin" /><Download v-else class="size-3.5" />{{ t("pluginPlatform.installFromUrl") }}</Button>
            </div>
            <div v-if="urlInstalling" class="space-y-1.5">
              <div class="h-1.5 overflow-hidden rounded-full bg-muted">
                <div class="h-full rounded-full bg-primary transition-[width]" :class="urlProgressPercent === null ? 'w-1/3 animate-pulse' : ''" :style="{ width: urlProgressPercent === null ? undefined : `${urlProgressPercent}%` }" />
              </div>
              <div class="text-[10px] text-muted-foreground">{{ urlProgressLabel }}</div>
            </div>
          </section>

          <section class="space-y-3 rounded-xl border p-4">
            <div class="flex items-start gap-3">
              <div class="rounded-md bg-primary/10 p-2 text-primary"><Store class="size-4" /></div>
              <div>
                <div class="text-sm font-medium">{{ t("pluginPlatform.repositoriesTitle") }}</div>
                <div class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("pluginPlatform.repositoriesDescription") }}</div>
              </div>
            </div>
            <div class="divide-y rounded-md border">
              <div v-for="repository in repositories" :key="repository.id" class="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 text-xs font-medium">
                    <span>{{ repository.name }}</span
                    ><Badge variant="outline" class="h-4 px-1.5 text-[9px]">{{ t(`pluginPlatform.repositoryKind.${repository.kind}`) }}</Badge>
                  </div>
                  <div class="mt-1 truncate font-mono text-[10px] text-muted-foreground">{{ repository.catalogUrl || t("pluginPlatform.repositoryNotConfigured") }}</div>
                </div>
                <Badge :variant="repository.enabled ? 'secondary' : 'outline'" class="h-5 px-1.5 text-[10px]">{{ repository.enabled ? t("pluginPlatform.enabled") : t("pluginPlatform.disabled") }}</Badge>
                <Button v-if="!repository.managed" size="sm" variant="ghost" class="h-7" :disabled="mutationRunning" @click="toggleRepository(repository)">{{ repository.enabled ? t("pluginPlatform.disable") : t("pluginPlatform.enable") }}</Button>
                <Button v-if="!repository.managed" size="icon" variant="ghost" class="size-7 text-destructive" :disabled="mutationRunning" @click="removeRepository(repository)"><Trash2 class="size-3.5" /></Button>
              </div>
            </div>
            <div class="grid gap-2 lg:grid-cols-[180px_220px_minmax(260px,1fr)_auto]">
              <Input v-model="repositoryId" class="h-8 text-xs" :placeholder="t('pluginPlatform.repositoryIdPlaceholder')" />
              <Input v-model="repositoryName" class="h-8 text-xs" :placeholder="t('pluginPlatform.repositoryNamePlaceholder')" />
              <Input v-model="repositoryCatalogUrl" class="h-8 text-xs" :placeholder="t('pluginPlatform.repositoryCatalogUrlPlaceholder')" />
              <Button size="sm" class="h-8 gap-1.5" :disabled="mutationRunning" @click="saveRepository"><Plus class="size-3.5" />{{ t("pluginPlatform.addRepository") }}</Button>
            </div>
          </section>

          <details class="group rounded-xl border bg-muted/15" open>
            <summary class="flex cursor-pointer list-none items-start gap-3 p-4 marker:content-none">
              <div class="rounded-md bg-muted p-2 text-muted-foreground"><Settings2 class="size-4" /></div>
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium">{{ t("pluginPlatform.developerOptionsTitle") }}</div>
                <div class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("pluginPlatform.developerOptionsDescription") }}</div>
              </div>
              <ChevronRight class="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
            </summary>
            <div class="space-y-4 border-t p-4">
              <div class="flex gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-amber-800 dark:text-amber-200">
                <CircleAlert class="mt-0.5 size-4 shrink-0" />
                <div class="text-xs leading-5">{{ t("pluginPlatform.developerOptionsWarning") }}</div>
              </div>

              <div class="flex items-center justify-between gap-4 rounded-lg border bg-background p-3">
                <div class="min-w-0">
                  <div class="text-xs font-medium">{{ t("pluginPlatform.pluginDevelopmentDocsTitle") }}</div>
                  <div class="mt-1 text-[11px] leading-5 text-muted-foreground">{{ t("pluginPlatform.pluginDevelopmentDocsDescription") }}</div>
                </div>
                <Button size="sm" variant="outline" class="shrink-0 gap-1.5" @click="openExternal(pluginDevelopmentDocsUrl)"><ExternalLink class="size-3.5" />{{ t("pluginPlatform.pluginDevelopmentDocsOpen") }}</Button>
              </div>

              <div class="flex items-start justify-between gap-4 rounded-lg border bg-background p-3">
                <div class="min-w-0">
                  <Label for="allow-unsigned-plugin-package" class="text-xs font-medium">{{ t("pluginPlatform.allowUnsignedDevelopmentPackage") }}</Label>
                  <div class="mt-1 text-[11px] leading-5 text-muted-foreground">{{ t("pluginPlatform.allowUnsignedDevelopmentPackageDescription") }}</div>
                </div>
                <Switch id="allow-unsigned-plugin-package" v-model="allowUnsigned" size="sm" class="mt-0.5 shrink-0" />
              </div>

              <template v-if="showCustomRepositoryTrustSettings">
                <div>
                  <div class="text-sm font-medium">{{ t("pluginPlatform.repositoryTrustTitle") }}</div>
                  <div class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("pluginPlatform.repositoryTrustDescription") }}</div>
                </div>
                <div v-if="trustedKeys.length" class="divide-y rounded-md border bg-background">
                  <div v-for="key in trustedKeys" :key="key.keyId" class="flex items-center gap-3 px-3 py-2">
                    <div class="min-w-0 flex-1">
                      <div class="text-xs font-medium">{{ key.keyId }}</div>
                      <div class="truncate font-mono text-[10px] text-muted-foreground" :title="key.publicKey">{{ abbreviatedPublicKey(key.publicKey) }}</div>
                    </div>
                    <Button size="icon" variant="ghost" class="size-7 text-destructive" :disabled="mutationRunning" @click="removeTrustedKey(key.keyId)"><Trash2 class="size-3.5" /></Button>
                  </div>
                </div>
                <div class="grid gap-2 md:grid-cols-[180px_minmax(260px,1fr)_auto]">
                  <Input v-model="trustedKeyId" class="h-8 text-xs" :placeholder="t('pluginPlatform.repositoryKeyIdPlaceholder')" />
                  <Input v-model="trustedPublicKey" class="h-8 font-mono text-xs" :placeholder="t('pluginPlatform.repositoryPublicKeyPlaceholder')" />
                  <Button size="sm" class="h-8 gap-1.5" :disabled="mutationRunning" @click="saveTrustedKey"><ShieldCheck class="size-3.5" />{{ t("pluginPlatform.trustRepository") }}</Button>
                </div>
              </template>
            </div>
          </details>
        </div>
      </TabsContent>
    </Tabs>

    <Dialog
      :open="!!pendingSourceChange"
      @update:open="
        (open: boolean) => {
          if (!open) cancelUpdateSourceChange();
        }
      "
    >
      <DialogContent class="max-w-md gap-4">
        <DialogHeader>
          <DialogTitle class="text-sm">{{ t("pluginPlatform.updateSourceChangeTitle") }}</DialogTitle>
          <DialogDescription class="text-xs leading-5">{{ t("pluginPlatform.updateSourceChangeBody") }}</DialogDescription>
        </DialogHeader>
        <div v-if="pendingSourceChange" class="grid grid-cols-2 gap-2 text-xs">
          <div class="rounded-lg border p-3">
            <div class="mb-2 text-[11px] font-semibold text-muted-foreground">{{ t("pluginPlatform.provenanceCurrentInstall") }}</div>
            <dl class="space-y-1">
              <div class="flex justify-between gap-2">
                <dt class="shrink-0 text-muted-foreground">{{ t("pluginPlatform.provenanceRepository") }}</dt>
                <dd class="truncate">{{ pendingSourceChange.listing.installed?.provenance?.repositoryId || "-" }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="shrink-0 text-muted-foreground">{{ t("pluginPlatform.provenancePublisher") }}</dt>
                <dd class="truncate">{{ pendingSourceChange.listing.installed?.provenance?.publisher || "-" }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="shrink-0 text-muted-foreground">{{ t("pluginPlatform.provenanceSigningKey") }}</dt>
                <dd class="truncate font-mono text-[10px]">{{ pendingSourceChange.listing.installed?.provenance?.signingKeyId || "-" }}</dd>
              </div>
            </dl>
          </div>
          <div class="rounded-lg border border-amber-500/40 p-3">
            <div class="mb-2 text-[11px] font-semibold text-amber-700 dark:text-amber-300">{{ t("pluginPlatform.provenanceCandidate") }}</div>
            <dl class="space-y-1">
              <div class="flex justify-between gap-2">
                <dt class="shrink-0 text-muted-foreground">{{ t("pluginPlatform.provenanceRepository") }}</dt>
                <dd class="truncate">{{ pendingSourceChange.listing.repository.id }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="shrink-0 text-muted-foreground">{{ t("pluginPlatform.provenancePublisher") }}</dt>
                <dd class="truncate">{{ pendingSourceChange.listing.plugin.publisher }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="shrink-0 text-muted-foreground">{{ t("pluginPlatform.provenanceSigningKey") }}</dt>
                <dd class="truncate font-mono text-[10px]">{{ pendingSourceChange.listing.artifact?.signingKeyId || "-" }}</dd>
              </div>
            </dl>
          </div>
        </div>
        <DialogFooter class="gap-2">
          <Button variant="outline" size="sm" @click="cancelUpdateSourceChange">{{ t("common.cancel") }}</Button>
          <Button size="sm" :disabled="mutationRunning" @click="proceedUpdateSourceChange">{{ t("pluginPlatform.updateSourceChangeConfirm") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <div v-if="draggingPackage" class="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/60 bg-primary/5">
      <FileUp class="size-8 text-primary" />
      <div class="text-sm font-medium text-primary">{{ t("pluginPlatform.dropToInstall") }}</div>
    </div>
  </div>
</template>
