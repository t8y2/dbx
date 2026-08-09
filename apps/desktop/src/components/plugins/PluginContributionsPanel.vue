<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Check, ChevronRight, CircleAlert, Download, ExternalLink, FileUp, FolderTree, Loader2, PackageCheck, Pencil, Plus, RefreshCw, RotateCcw, Search, Settings2, ShieldCheck, Store, Trash2 } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/composables/useToast";
import PluginIcon from "@/components/plugins/PluginIcon.vue";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { createFrontendPluginRegistry, pluginConnectionProviderIcon } from "@/lib/plugins/frontendPlugin";
import { buildMarketplacePluginListings, filterMarketplacePluginListings, type MarketplacePluginListing } from "@/lib/plugins/pluginMarketplace";
import type { PluginCenterFocus } from "@/lib/plugins/pluginCenterNavigation";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import type { InstalledPlugin, PluginRepository, PluginRepositoryCatalogResult, PluginTrustedKey } from "@/types/database";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  focusTarget?: PluginCenterFocus | null;
}>();

const emit = defineEmits<{
  newConnection: [pluginId: string, providerId: string];
}>();

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
const marketplaceInstallingKey = ref("");
const operating = ref(false);
const error = ref("");
const selectedPluginId = ref("");
const selectedContributionId = ref("");
const selectedConnectionId = ref("");
const allowUnsigned = ref(false);
const trustedKeyId = ref("");
const trustedPublicKey = ref("");
const repositoryId = ref("");
const repositoryName = ref("");
const repositoryCatalogUrl = ref("");
const marketplaceQuery = ref("");
const marketplaceRepositoryId = ref("all");
const webFileInput = ref<HTMLInputElement | null>(null);

const registry = computed(() => createFrontendPluginRegistry(installedPlugins.value, appLocale.value));
const definitions = computed(() => registry.value.listPlugins());
const connectionProviders = computed(() => registry.value.listConnectionProviders());
const selectedEntry = computed(() => connectionProviders.value.find((entry) => entry.plugin.manifest.id === selectedPluginId.value && entry.contribution.id === selectedContributionId.value) || null);
const selectedDefinition = computed(() => definitions.value.find((definition) => definition.plugin.manifest.id === selectedPluginId.value) || null);
const selectedWorkbenches = computed(() => registry.value.listWorkbenches().filter((entry) => entry.plugin.manifest.id === selectedPluginId.value));
const selectedFilesystems = computed(() => registry.value.listFilesystemProviders().filter((entry) => entry.plugin.manifest.id === selectedPluginId.value));
const providerConnections = computed(() => {
  const entry = selectedEntry.value;
  if (!entry) return [];
  return connectionStore.connections.filter((connection) => connection.db_type === "plugin" && connection.plugin_id === entry.plugin.manifest.id && connection.plugin_connection_provider === entry.contribution.id);
});
const selectedConnection = computed(() => providerConnections.value.find((connection) => connection.id === selectedConnectionId.value));
const marketplaceListings = computed(() => buildMarketplacePluginListings(catalogResults.value, installedPlugins.value, appLocale.value));
const filteredMarketplaceListings = computed(() => filterMarketplacePluginListings(marketplaceListings.value, marketplaceQuery.value, marketplaceRepositoryId.value));
const catalogErrors = computed(() => catalogResults.value.filter((result) => result.error));
const customRepositories = computed(() => repositories.value.filter((repository) => !repository.managed));
const showCustomRepositoryTrustSettings = computed(() => customRepositories.value.length > 0 || trustedKeys.value.length > 0);

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
  } catch (cause) {
    catalogResults.value = [];
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

async function installMarketplaceListing(listing: MarketplacePluginListing) {
  if (!listing.artifact || listing.status === "installed") return;
  marketplaceInstallingKey.value = listing.key;
  try {
    const result = await api.installMarketplacePlugin({
      repositoryId: listing.repository.id,
      pluginId: listing.plugin.id,
      version: listing.plugin.latestVersion,
    });
    toast(t(listing.status === "update" ? "pluginPlatform.updateSuccess" : "pluginPlatform.installSuccess", { name: result.plugin.manifest.name, version: result.plugin.manifest.version }));
    installedPlugins.value = await api.listPlugins();
    selectPlugin(result.plugin.manifest.id);
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : String(cause), 8000);
  } finally {
    marketplaceInstallingKey.value = "";
  }
}

async function saveRepository() {
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
  if (repository.managed) return;
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
  if (repository.managed || !window.confirm(t("pluginPlatform.removeRepositoryConfirm", { name: repository.name }))) return;
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
  if (!window.confirm(t("pluginPlatform.removeRepositoryKeyConfirm", { keyId }))) return;
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
      title: connection ? `${connection.name} · ${label}` : label,
      connectionId: connection?.id,
      rootUri,
    });
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : String(cause), 5000);
  }
}

function openWorkbench(pluginId: string, contributionId: string, label: string) {
  const connection = selectedConnection.value;
  queryStore.openPluginWorkbench(pluginId, contributionId, {
    title: connection ? `${connection.name} · ${label}` : label,
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

async function installPlugin(source: string | File) {
  installing.value = true;
  try {
    const result = await api.installPluginPackage(source, allowUnsigned.value);
    toast(t("pluginPlatform.installSuccess", { name: result.plugin.manifest.name, version: result.plugin.manifest.version }));
    installedPlugins.value = await api.listPlugins();
    selectPlugin(result.plugin.manifest.id);
    activeSection.value = "installed";
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : String(cause), 8000);
  } finally {
    installing.value = false;
  }
}

async function rollbackSelectedPlugin() {
  if (!selectedPluginId.value || !window.confirm(t("pluginPlatform.rollbackConfirm"))) return;
  operating.value = true;
  try {
    const result = await api.rollbackPlugin(selectedPluginId.value);
    toast(t("pluginPlatform.rollbackSuccess", { version: result.plugin.manifest.version }));
    installedPlugins.value = await api.listPlugins();
    selectPlugin(result.plugin.manifest.id);
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : String(cause), 5000);
  } finally {
    operating.value = false;
  }
}

async function uninstallSelectedPlugin() {
  const definition = selectedDefinition.value;
  if (!definition || !window.confirm(t("pluginPlatform.uninstallConfirm", { name: definition.plugin.manifest.name }))) return;
  operating.value = true;
  try {
    installedPlugins.value = await api.uninstallPlugin(definition.plugin.manifest.id);
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
onMounted(() => void refresh());
</script>

<template>
  <div class="plugin-center-view mx-auto flex h-full w-full max-w-6xl flex-col gap-4 overflow-hidden px-6 py-6">
    <input ref="webFileInput" type="file" accept=".dbxp" class="hidden" @change="handleWebPackage" />
    <div v-if="error" class="shrink-0 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{{ error }}</div>

    <Tabs v-model="activeSection" class="min-h-0 flex-1 gap-3">
      <TabsList class="grid h-9 w-full grid-cols-3">
        <TabsTrigger value="marketplace" class="gap-1.5 text-xs"><Store class="size-3.5" />{{ t("pluginPlatform.marketplace") }}</TabsTrigger>
        <TabsTrigger value="installed" class="gap-1.5 text-xs"><PackageCheck class="size-3.5" />{{ t("pluginPlatform.installed") }}</TabsTrigger>
        <TabsTrigger value="settings" class="gap-1.5 text-xs"><Settings2 class="size-3.5" />{{ t("pluginPlatform.settings") }}</TabsTrigger>
      </TabsList>

      <TabsContent value="marketplace" class="m-0 min-h-0 flex-1 overflow-y-auto">
        <div class="flex min-h-full w-full flex-col gap-4 pb-2">
          <div class="grid w-full gap-2 rounded-lg border bg-muted/10 p-3 md:grid-cols-[minmax(220px,1fr)_220px]">
            <div class="relative">
              <Search class="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
              <Input v-model="marketplaceQuery" class="h-8 pl-8 text-xs" :placeholder="t('pluginPlatform.searchMarketplace')" />
            </div>
            <Select v-model="marketplaceRepositoryId">
              <SelectTrigger class="h-8 text-xs"><SelectValue :placeholder="t('pluginPlatform.allRepositories')" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{{ t("pluginPlatform.allRepositories") }}</SelectItem>
                <SelectItem v-for="repository in repositories.filter((entry) => entry.enabled)" :key="repository.id" :value="repository.id">{{ repository.name }}</SelectItem>
              </SelectContent>
            </Select>
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
          <div v-else class="grid w-full grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] gap-3">
            <article v-for="listing in filteredMarketplaceListings" :key="listing.key" class="flex min-h-44 flex-col rounded-xl border bg-card p-4 shadow-sm transition-colors hover:border-primary/30">
              <div class="flex items-start gap-3">
                <PluginIcon :plugin-id="listing.plugin.id" :icon="listing.plugin.icon" class="size-11 rounded-xl border bg-background p-2" />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="truncate text-sm font-semibold">{{ listing.name }}</span>
                    <Badge v-if="listing.verified" variant="secondary" class="h-5 gap-1 px-1.5 text-[10px]"><ShieldCheck class="size-3" />{{ t("pluginPlatform.verified") }}</Badge>
                  </div>
                  <div class="mt-1 truncate text-[11px] text-muted-foreground">{{ listing.plugin.publisher }} · {{ listing.repository.name }}</div>
                </div>
                <Badge variant="outline" class="h-5 px-1.5 text-[10px]">v{{ listing.plugin.latestVersion }}</Badge>
              </div>
              <p class="mt-3 line-clamp-3 text-xs leading-5 text-muted-foreground">{{ listing.description || t("pluginPlatform.noDescription") }}</p>
              <div class="mt-3 flex flex-wrap gap-1.5">
                <Badge v-if="listing.plugin.permissions.length" variant="outline" class="h-5 px-1.5 text-[10px]">{{ t("pluginPlatform.permissionsCount", { count: listing.plugin.permissions.length }) }}</Badge>
              </div>
              <div class="mt-auto flex items-end justify-between gap-3 pt-4">
                <div class="text-[10px] text-muted-foreground">
                  <span v-if="listing.status === 'unsupported'">{{ t("pluginPlatform.unsupportedTarget", { target: listing.target }) }}</span>
                  <span v-else-if="listing.installed">{{ t("pluginPlatform.installedVersion", { version: listing.installed.manifest.version }) }}</span>
                  <span v-else>{{ listing.plugin.license || t("pluginPlatform.licenseUnknown") }}</span>
                </div>
                <Button
                  size="sm"
                  :variant="listing.status === 'installed' || listing.status === 'unsupported' ? 'outline' : 'default'"
                  class="h-8 gap-1.5"
                  :disabled="listing.status === 'installed' || listing.status === 'unsupported' || !!marketplaceInstallingKey"
                  @click="installMarketplaceListing(listing)"
                >
                  <Loader2 v-if="marketplaceInstallingKey === listing.key" class="size-3.5 animate-spin" />
                  <Check v-else-if="listing.status === 'installed'" class="size-3.5" />
                  <CircleAlert v-else-if="listing.status === 'unsupported'" class="size-3.5" />
                  <RefreshCw v-else-if="listing.status === 'update'" class="size-3.5" />
                  <Download v-else class="size-3.5" />
                  {{ t(`pluginPlatform.marketplaceStatus.${listing.status}`) }}
                </Button>
              </div>
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
        <div v-else class="grid min-h-[440px] gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div class="space-y-1 rounded-lg border bg-muted/10 p-2">
            <button
              v-for="definition in definitions"
              :key="definition.plugin.manifest.id"
              type="button"
              class="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted"
              :class="selectedPluginId === definition.plugin.manifest.id ? 'bg-muted ring-1 ring-primary/30' : ''"
              @click="selectPlugin(definition.plugin.manifest.id)"
            >
              <Check v-if="selectedPluginId === definition.plugin.manifest.id" class="mt-0.5 size-3.5 shrink-0 text-primary" /><span v-else class="mt-0.5 size-3.5 shrink-0" />
              <PluginIcon :plugin-id="definition.plugin.manifest.id" :icon="definition.plugin.manifest.icon" class="size-8 rounded-md border bg-background p-1" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium">{{ definition.plugin.manifest.name }}</span>
                <span class="mt-1 flex flex-wrap gap-1">
                  <Badge variant="outline" class="h-4 px-1.5 text-[10px]">v{{ definition.plugin.manifest.version || "-" }}</Badge>
                  <Badge :variant="definition.plugin.compatibility.compatible ? 'secondary' : 'destructive'" class="h-4 px-1.5 text-[10px]">{{ definition.plugin.compatibility.compatible ? t("pluginPlatform.compatible") : t("pluginPlatform.blocked") }}</Badge>
                </span>
              </span>
            </button>
          </div>

          <div class="space-y-4 rounded-lg border p-4">
            <template v-if="selectedDefinition">
              <div class="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
                <div class="flex min-w-0 items-start gap-3">
                  <PluginIcon :plugin-id="selectedDefinition.plugin.manifest.id" :icon="selectedDefinition.plugin.manifest.icon" class="size-10 rounded-lg border bg-background p-1.5" />
                  <div class="min-w-0">
                    <div class="text-sm font-medium">{{ selectedDefinition.plugin.manifest.name }}</div>
                    <div class="mt-1 text-xs leading-5 text-muted-foreground">{{ selectedDefinition.plugin.manifest.description }}</div>
                    <div class="mt-1 font-mono text-[10px] text-muted-foreground">{{ selectedDefinition.plugin.manifest.id }}</div>
                  </div>
                </div>
                <div class="flex gap-2">
                  <Button size="sm" variant="outline" class="gap-1.5" :disabled="operating" @click="rollbackSelectedPlugin"><RotateCcw class="size-3.5" />{{ t("pluginPlatform.rollback") }}</Button>
                  <Button size="sm" variant="outline" class="gap-1.5 text-destructive" :disabled="operating" @click="uninstallSelectedPlugin"><Trash2 class="size-3.5" />{{ t("pluginPlatform.uninstall") }}</Button>
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
                      <Button size="icon" variant="outline" class="h-8 w-8 rounded-l-none border-l-0" :title="t('common.edit')" :aria-label="t('common.edit')" @click="editConnection(connection.id)"><Pencil class="size-3.5" /></Button>
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

              <div v-if="selectedFilesystems.length" class="space-y-2">
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
              <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="installing" @click="choosePluginPackage"><Loader2 v-if="installing" class="size-3.5 animate-spin" /><FileUp v-else class="size-3.5" />{{ t("pluginPlatform.installPackage") }}</Button>
              <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground"><ShieldCheck class="size-3.5 text-emerald-600 dark:text-emerald-400" />{{ t("pluginPlatform.signedPackagesVerifiedAutomatically") }}</div>
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
                <Button v-if="!repository.managed" size="sm" variant="ghost" class="h-7" :disabled="operating" @click="toggleRepository(repository)">{{ repository.enabled ? t("pluginPlatform.disable") : t("pluginPlatform.enable") }}</Button>
                <Button v-if="!repository.managed" size="icon" variant="ghost" class="size-7 text-destructive" :disabled="operating" @click="removeRepository(repository)"><Trash2 class="size-3.5" /></Button>
              </div>
            </div>
            <div class="grid gap-2 lg:grid-cols-[180px_220px_minmax(260px,1fr)_auto]">
              <Input v-model="repositoryId" class="h-8 text-xs" :placeholder="t('pluginPlatform.repositoryIdPlaceholder')" />
              <Input v-model="repositoryName" class="h-8 text-xs" :placeholder="t('pluginPlatform.repositoryNamePlaceholder')" />
              <Input v-model="repositoryCatalogUrl" class="h-8 text-xs" :placeholder="t('pluginPlatform.repositoryCatalogUrlPlaceholder')" />
              <Button size="sm" class="h-8 gap-1.5" :disabled="operating" @click="saveRepository"><Plus class="size-3.5" />{{ t("pluginPlatform.addRepository") }}</Button>
            </div>
          </section>

          <details class="group rounded-xl border bg-muted/15">
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
                    <Button size="icon" variant="ghost" class="size-7 text-destructive" :disabled="operating" @click="removeTrustedKey(key.keyId)"><Trash2 class="size-3.5" /></Button>
                  </div>
                </div>
                <div class="grid gap-2 md:grid-cols-[180px_minmax(260px,1fr)_auto]">
                  <Input v-model="trustedKeyId" class="h-8 text-xs" :placeholder="t('pluginPlatform.repositoryKeyIdPlaceholder')" />
                  <Input v-model="trustedPublicKey" class="h-8 font-mono text-xs" :placeholder="t('pluginPlatform.repositoryPublicKeyPlaceholder')" />
                  <Button size="sm" class="h-8 gap-1.5" :disabled="operating" @click="saveTrustedKey"><ShieldCheck class="size-3.5" />{{ t("pluginPlatform.trustRepository") }}</Button>
                </div>
              </template>
            </div>
          </details>
        </div>
      </TabsContent>
    </Tabs>
  </div>
</template>
