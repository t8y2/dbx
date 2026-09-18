import { computed, ref } from "vue";
import * as api from "@/lib/backend/api";
import { currentLocale } from "@/i18n";
import { buildMarketplacePluginListings, type MarketplacePluginListing } from "@/lib/plugins/pluginMarketplace";
import { mcpUpdateAvailability } from "@/lib/mcp/mcpUpdateStatus";
import { useSettingsStore } from "@/stores/settingsStore";
import { isUpdatePreviewMockEnabled, previewDriverUpdates, previewJdbcUpdate, previewMcpUpdate, previewPluginUpdates } from "@/lib/updates/updatePreviewMock";
import type { ComponentUpdateCategory } from "@/lib/updates/componentUpdateOrchestration";
import type { AgentDriverInfo, McpServerStatus } from "@/lib/backend/tauri";
import type { JdbcPluginStatus } from "@/types/database";

export type { ComponentUpdateCategory } from "@/lib/updates/componentUpdateOrchestration";

export interface ComponentUpdateResult {
  drivers: number;
  jdbc: boolean;
  mcp: boolean;
  plugins: number;
  skippedDrivers: number;
  failed: string[];
}

function emptyResult(): ComponentUpdateResult {
  return { drivers: 0, jdbc: false, mcp: false, plugins: 0, skippedDrivers: 0, failed: [] };
}

export function useComponentUpdates(options: { isDesktop: boolean }) {
  const settingsStore = useSettingsStore();
  const drivers = ref<AgentDriverInfo[]>([]);
  const jdbcPluginStatus = ref<JdbcPluginStatus | null>(null);
  const mcpStatus = ref<McpServerStatus | null>(null);
  const pluginListings = ref<MarketplacePluginListing[]>([]);
  const loading = ref(false);
  const updating = ref(false);
  const updatingCategory = ref<ComponentUpdateCategory | null>(null);
  const lastError = ref("");

  const driverUpdates = computed(() => drivers.value.filter((driver) => driver.update_available));
  const pluginUpdates = computed(() => pluginListings.value.filter((listing) => listing.status === "update"));
  const driverUpdateCount = computed(() => driverUpdates.value.length);
  const jdbcUpdateAvailable = computed(() => jdbcPluginStatus.value?.update_available === true);
  const mcpUpdateAvailable = computed(() => (mcpStatus.value ? mcpUpdateAvailability(mcpStatus.value) === true : false));
  const pluginUpdateCount = computed(() => pluginUpdates.value.length);
  const totalUpdateCount = computed(() => driverUpdateCount.value + (jdbcUpdateAvailable.value ? 1 : 0) + (mcpUpdateAvailable.value ? 1 : 0) + pluginUpdateCount.value);

  let refreshPromise: Promise<boolean> | null = null;
  let activeUpdatePromise: Promise<ComponentUpdateResult> | null = null;

  function refresh() {
    if (!options.isDesktop) return Promise.resolve(false);
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      loading.value = true;
      lastError.value = "";
      try {
        if (isUpdatePreviewMockEnabled()) {
          drivers.value = previewDriverUpdates();
          jdbcPluginStatus.value = previewJdbcUpdate();
          mcpStatus.value = previewMcpUpdate();
          pluginListings.value = previewPluginUpdates();
          return true;
        }
        const [agentResult, jdbcResult, mcpResult, installedPluginsResult, catalogsResult] = await Promise.allSettled([api.listInstalledAgents(), api.jdbcPluginStatus(), api.checkMcpServerStatus(), api.listPlugins(), api.fetchPluginMarketplaceCatalogs()]);
        const errors: string[] = [];
        if (agentResult.status === "fulfilled") drivers.value = agentResult.value;
        else {
          drivers.value = [];
          errors.push(`drivers: ${agentResult.reason instanceof Error ? agentResult.reason.message : String(agentResult.reason)}`);
        }
        if (jdbcResult.status === "fulfilled") jdbcPluginStatus.value = jdbcResult.value;
        else {
          jdbcPluginStatus.value = null;
          errors.push(`JDBC: ${jdbcResult.reason instanceof Error ? jdbcResult.reason.message : String(jdbcResult.reason)}`);
        }
        if (mcpResult.status === "fulfilled") mcpStatus.value = mcpResult.value;
        else {
          mcpStatus.value = null;
          errors.push(`MCP: ${mcpResult.reason instanceof Error ? mcpResult.reason.message : String(mcpResult.reason)}`);
        }
        if (installedPluginsResult.status === "fulfilled" && catalogsResult.status === "fulfilled") {
          pluginListings.value = buildMarketplacePluginListings(catalogsResult.value, installedPluginsResult.value, currentLocale());
        } else {
          pluginListings.value = [];
          if (installedPluginsResult.status === "rejected") errors.push(`plugins: ${installedPluginsResult.reason instanceof Error ? installedPluginsResult.reason.message : String(installedPluginsResult.reason)}`);
          if (catalogsResult.status === "rejected") errors.push(`plugin catalog: ${catalogsResult.reason instanceof Error ? catalogsResult.reason.message : String(catalogsResult.reason)}`);
        }
        lastError.value = errors.join("; ");
        return errors.length === 0;
      } catch (error) {
        lastError.value = error instanceof Error ? error.message : String(error);
        return false;
      } finally {
        loading.value = false;
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  async function updateDrivers(result: ComponentUpdateResult) {
    const updatable = driverUpdates.value.map((driver) => driver.db_type);
    if (!updatable.length) return;
    if (isUpdatePreviewMockEnabled()) {
      result.drivers += updatable.length;
      return;
    }
    const blockers = await api.checkAgentUpdateBlockers(updatable);
    if (blockers.length) {
      result.skippedDrivers = blockers.length;
      return;
    }
    const upgraded = await api.upgradeAllAgents();
    result.drivers += upgraded.upgraded;
    if (upgraded.failed.length) result.failed.push(...upgraded.failed.map((item) => `${item.db_type}: ${item.error}`));
  }

  async function updateJdbc(result: ComponentUpdateResult) {
    if (!jdbcUpdateAvailable.value) return;
    if (isUpdatePreviewMockEnabled()) {
      result.jdbc = true;
      return;
    }
    await api.installJdbcPlugin();
    result.jdbc = true;
  }

  async function updateMcp(result: ComponentUpdateResult) {
    if (!mcpUpdateAvailable.value) return;
    if (isUpdatePreviewMockEnabled()) {
      result.mcp = true;
      return;
    }
    await api.installMcpServer();
    result.mcp = true;
  }

  async function updatePlugins(result: ComponentUpdateResult) {
    const updatable = pluginUpdates.value.filter((item) => item.artifact);
    if (isUpdatePreviewMockEnabled()) {
      result.plugins += updatable.length;
      return;
    }
    for (const listing of updatable) {
      try {
        await api.installMarketplacePlugin({
          repositoryId: listing.repository.id,
          pluginId: listing.plugin.id,
          version: listing.plugin.latestVersion,
        });
        result.plugins += 1;
      } catch (error) {
        result.failed.push(`${listing.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function categoryLabel(category: ComponentUpdateCategory): string {
    return category === "jdbc" ? "JDBC" : category === "mcp" ? "MCP" : category;
  }

  async function runCategory(category: ComponentUpdateCategory, result: ComponentUpdateResult) {
    updatingCategory.value = category;
    try {
      if (category === "drivers") await updateDrivers(result);
      else if (category === "jdbc") await updateJdbc(result);
      else if (category === "mcp") await updateMcp(result);
      else await updatePlugins(result);
    } catch (error) {
      result.failed.push(`${categoryLabel(category)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function runUpdateOperation(categories: ComponentUpdateCategory[]): Promise<ComponentUpdateResult> {
    const result = emptyResult();
    if (!options.isDesktop) return result;
    if (activeUpdatePromise) return activeUpdatePromise;
    updating.value = true;
    const operation = (async () => {
      await refresh();
      const initialCheckError = lastError.value;
      if (initialCheckError) result.failed.push(initialCheckError);
      for (const category of categories) await runCategory(category, result);
      await refresh();
      if (lastError.value && lastError.value !== initialCheckError) result.failed.push(lastError.value);
      return result;
    })();
    activeUpdatePromise = operation;
    try {
      return await operation;
    } finally {
      if (activeUpdatePromise === operation) activeUpdatePromise = null;
      updating.value = false;
      updatingCategory.value = null;
    }
  }

  function installCategory(category: ComponentUpdateCategory): Promise<ComponentUpdateResult> {
    return runUpdateOperation([category]);
  }

  function installCategories(categories: ComponentUpdateCategory[]): Promise<ComponentUpdateResult> {
    return runUpdateOperation([...new Set(categories)]);
  }

  function autoUpdateEnabledComponents(): Promise<ComponentUpdateResult> {
    const categories: ComponentUpdateCategory[] = [];
    if (settingsStore.editorSettings.autoUpdateDrivers) categories.push("drivers");
    if (settingsStore.editorSettings.autoUpdateJdbc) categories.push("jdbc");
    if (settingsStore.editorSettings.autoUpdateMcp) categories.push("mcp");
    if (settingsStore.editorSettings.autoUpdatePlugins) categories.push("plugins");
    return runUpdateOperation(categories);
  }

  return {
    drivers,
    driverUpdates,
    jdbcPluginStatus,
    mcpStatus,
    pluginListings,
    pluginUpdates,
    loading,
    updating,
    updatingCategory,
    lastError,
    driverUpdateCount,
    jdbcUpdateAvailable,
    mcpUpdateAvailable,
    pluginUpdateCount,
    totalUpdateCount,
    refresh,
    installCategory,
    installCategories,
    autoUpdateEnabledComponents,
  };
}
