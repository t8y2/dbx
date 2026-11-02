<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Search, X, RefreshCw, Loader2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import McpCapabilitiesPanel from "./McpCapabilitiesPanel.vue";
import McpPluginCapabilities from "./McpPluginCapabilities.vue";
import type { McpToolCatalog, McpToolCatalogToolset, PluginMcpGrant, PluginMcpView } from "@/types/mcpCatalog";
import { mcpCapabilityCategories, mcpCapabilityCategoryId, mcpToolAllowed, mcpToolsetAccessLevels, mcpToolsetHasCoverage, mcpToolsetState, summarizeMcpToolsetCoverage, type McpCoverageConnection, type McpCapabilityCategoryId } from "@/lib/mcp/mcpToolCatalog";
import { initialMcpCapabilityBrowserState, mcpCategoryTitle, mcpToolsetTitle, searchMcpCapabilities, type McpCapabilityBrowserState, type McpCapabilityNavigationTarget, type McpCapabilityNavigator, type McpCapabilitySearchItem } from "@/lib/mcp/mcpCapabilitySearch";
import { pluginMcpEnabled, pluginMcpExposedCount, pluginMcpPendingTools } from "@/lib/mcp/pluginMcpGrant";

const props = withDefaults(
  defineProps<{
    catalog: McpToolCatalog | null;
    loading?: boolean;
    loadError?: string;
    allowedToolNames: string[] | null;
    savedToolNames?: readonly string[] | null;
    saveToolset?: (toolsetId: string) => Promise<void>;
    connections: McpCoverageConnection[];
    disabled?: boolean;
    plugins: PluginMcpView[] | null;
    pluginsLoading?: boolean;
    pluginsError?: string;
    pendingPluginIds?: readonly string[];
    showPlugins?: boolean;
    savePlugin: (pluginId: string, grant: PluginMcpGrant, approveCurrent: boolean) => Promise<PluginMcpView>;
  }>(),
  { showPlugins: true },
);

const emit = defineEmits<{
  "set:toolset": [toolset: McpToolCatalogToolset, enabled: boolean];
  "set:tool": [name: string, enabled: boolean];
  "set:category": [category: McpCapabilityCategoryId, enabled: boolean];
  retry: [];
  "refresh:plugins": [];
  "saved:plugin": [view: PluginMcpView];
}>();
const state = defineModel<McpCapabilityBrowserState>({ default: initialMcpCapabilityBrowserState });
const { t } = useI18n();
const rootElement = ref<HTMLElement>();
const builtinPanel = ref<InstanceType<typeof McpCapabilitiesPanel>>();
const pluginPanel = ref<InstanceType<typeof McpPluginCapabilities>>();
const batchChanged = ref(false);
const detailPath = ref("");
const categories = computed(() => mcpCapabilityCategories(props.catalog));
const searching = computed(() => !!state.value.search.trim());
const selectedCategory = computed(() => categories.value.find((category) => category.id === state.value.selected));
const selectedPluginId = computed(() => (state.value.selected.startsWith("plugin:") ? state.value.selected.slice(7) : undefined));
const viewMode = computed(() => state.value.viewMode ?? "manage");
const showBuiltin = computed(() => viewMode.value === "manage" && !searching.value && !!selectedCategory.value);
const title = computed(() => (selectedCategory.value ? mcpCategoryTitle(selectedCategory.value.id, t) : ""));
const categoryTools = computed(() => selectedCategory.value?.toolsets.flatMap((toolset) => toolset.tools) ?? []);
const enabledCount = computed(() => categoryTools.value.filter((tool) => mcpToolAllowed(props.allowedToolNames, tool.name)).length);
const editable = computed(() => !!props.catalog && !props.loading && !props.loadError && !props.disabled);
const overviewCategories = computed(() =>
  categories.value.map((category) => {
    const tools = category.toolsets.flatMap((toolset) => toolset.tools);
    const visibleToolsets = state.value.onlyEnabled ? category.toolsets.filter((toolset) => mcpToolsetState(props.allowedToolNames, toolset) !== "off") : category.toolsets;
    return {
      ...category,
      visibleToolsets,
      tools,
      enabled: tools.filter((tool) => mcpToolAllowed(props.allowedToolNames, tool.name)).length,
    };
  }),
);
const overviewPlugins = computed(() => (props.plugins ?? []).filter((plugin) => !state.value.onlyEnabled || pluginMcpEnabled(plugin)));
const overviewHasContent = computed(() => overviewCategories.value.some((category) => category.visibleToolsets.length > 0) || (props.showPlugins && overviewPlugins.value.length > 0));
const collapsedOverviewCategories = ref(new Set<McpCapabilityCategoryId>());
const builtinFilter = ref("");
const pluginFilter = ref("");
const pendingToolNavigation = ref<{ toolName: string } | null>(null);
const filteredCategories = computed(() => {
  const query = builtinFilter.value.trim().toLocaleLowerCase();
  if (!query) return categories.value;
  return categories.value.filter((category) => {
    const title = mcpCategoryTitle(category.id, t).toLocaleLowerCase();
    return title.includes(query) || category.id.toLocaleLowerCase().includes(query);
  });
});
const filteredPlugins = computed(() => {
  const query = pluginFilter.value.trim().toLocaleLowerCase();
  if (!query) return props.plugins ?? [];
  return (props.plugins ?? []).filter((plugin) => plugin.pluginName.toLocaleLowerCase().includes(query) || plugin.pluginId.toLocaleLowerCase().includes(query));
});
const results = computed(() =>
  searchMcpCapabilities({
    query: state.value.search,
    catalog: props.loadError ? null : props.catalog,
    plugins: props.showPlugins ? props.plugins : null,
    allowedToolNames: props.allowedToolNames,
    onlyEnabled: state.value.onlyEnabled,
    t,
  }),
);

function focusSearch() {
  rootElement.value?.querySelector?.<HTMLInputElement>("[data-mcp-global-search]")?.focus();
}

function revealSearchTarget(target?: McpCapabilityNavigationTarget) {
  pendingToolNavigation.value = null;
  if (!target) return;
  builtinFilter.value = "";
  pluginFilter.value = "";
  batchChanged.value = false;
  state.value = {
    ...initialMcpCapabilityBrowserState(),
    ...(target.kind === "advanced" ? { selected: "advanced" as const } : { search: target.toolName }),
  };
  pendingToolNavigation.value = target.kind === "tool" ? { toolName: target.toolName } : null;
}

// A settings result can arrive before the catalog. Keep the exact-name search
// visible during loading/errors, then reveal the tool without changing grants.
watch(
  [pendingToolNavigation, () => props.catalog, () => props.loading, () => props.loadError],
  async ([target, catalog, loading, loadError], _previous, onCleanup) => {
    if (!target || !catalog || loading || loadError) return;
    const toolset = catalog.toolsets.find((entry) => entry.tools.some((tool) => tool.name === target.toolName));
    if (!toolset) return;
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    state.value = { ...state.value, selected: mcpCapabilityCategoryId(toolset.id), search: "", onlyEnabled: false, viewMode: "manage" };
    await nextTick();
    if (cancelled || pendingToolNavigation.value !== target) return;
    builtinPanel.value?.openDetail(toolset.id, "tools", target.toolName);
    pendingToolNavigation.value = null;
  },
  { flush: "post" },
);

defineExpose<McpCapabilityNavigator>({ revealSearchTarget });

function focusNavigationFilter(event: MouseEvent) {
  const target = event.currentTarget as HTMLElement | null;
  const eventTarget = event.target as HTMLElement | null;
  if (!target || (eventTarget && typeof eventTarget.closest === "function" && eventTarget.closest("input,button"))) return;
  if (typeof target.querySelector !== "function") return;
  target.querySelector<HTMLInputElement>("input")?.focus();
}

function select(value: unknown) {
  if (typeof value !== "string") return;
  pendingToolNavigation.value = null;
  state.value = {
    ...state.value,
    selected: value as McpCapabilityBrowserState["selected"],
    search: "",
    ...(searching.value ? { viewMode: "manage" as const } : {}),
  };
  batchChanged.value = false;
}

function setViewMode(mode: "manage" | "overview") {
  pendingToolNavigation.value = null;
  if (viewMode.value === mode) return;
  state.value = { ...state.value, viewMode: mode };
  batchChanged.value = false;
}

function toggleOverviewCategory(categoryId: McpCapabilityCategoryId) {
  const next = new Set(collapsedOverviewCategories.value);
  if (next.has(categoryId)) next.delete(categoryId);
  else next.add(categoryId);
  collapsedOverviewCategories.value = next;
}

function overviewCategoryExpanded(categoryId: McpCapabilityCategoryId) {
  return !collapsedOverviewCategories.value.has(categoryId);
}

function updateSearch(value: string | number) {
  pendingToolNavigation.value = null;
  const clearing = state.value.search.length > 0 && String(value).length === 0;
  state.value = { ...state.value, search: String(value) };
  batchChanged.value = false;
  if (clearing) void nextTick(focusSearch);
}

function batch(enabled: boolean) {
  if (!editable.value || !selectedCategory.value || searching.value || !categoryTools.value.length) return;
  if (enabled ? enabledCount.value === categoryTools.value.length : enabledCount.value === 0) return;
  emit("set:category", selectedCategory.value.id, enabled);
  batchChanged.value = true;
}

function batchCategory(categoryId: McpCapabilityCategoryId, enabled: boolean) {
  const category = categories.value.find((entry) => entry.id === categoryId);
  if (!editable.value || !category || !category.toolsets.flatMap((toolset) => toolset.tools).length) return;
  const tools = category.toolsets.flatMap((toolset) => toolset.tools);
  const enabledTools = tools.filter((tool) => mcpToolAllowed(props.allowedToolNames, tool.name)).length;
  if (enabled ? enabledTools === tools.length : enabledTools === 0) return;
  emit("set:category", categoryId, enabled);
  batchChanged.value = true;
}

async function openOverviewToolset(categoryId: McpCapabilityCategoryId, toolset: McpToolCatalogToolset, event: Event) {
  const trigger = event.currentTarget;
  detailPath.value = mcpCategoryTitle(categoryId, t);
  await nextTick();
  builtinPanel.value?.openDetail(toolset.id, "tools", undefined, trigger);
}

function openOverviewPlugin(plugin: PluginMcpView, event: Event) {
  pluginPanel.value?.openDetail(plugin.pluginId, event.currentTarget as HTMLElement);
}

function overviewToolsetDescription(toolset: McpToolCatalogToolset) {
  const key = `settings.mcpToolset.${toolset.id.replace(/\.(\w)/g, (_, letter: string) => letter.toUpperCase())}.description`;
  const text = t(key);
  return text === key ? "" : text;
}

function overviewToolsetCoverage(toolset: McpToolCatalogToolset) {
  if (!mcpToolsetHasCoverage(toolset)) return t("settings.mcpCoverageNotBound");
  const coverage = summarizeMcpToolsetCoverage(toolset, props.connections);
  if (!coverage.usableConnections.length) return t("settings.mcpBrowser.noMatchingConnections");
  const parts = [t("settings.mcpBrowser.coverageConnections", { count: coverage.usableConnections.length })];
  if (coverage.partialConnections.length) parts.push(t("settings.mcpBrowser.coveragePartialConnections", { count: coverage.partialConnections.length }));
  return parts.join(" · ");
}

function overviewPluginSummary(plugin: PluginMcpView) {
  if (!plugin.authorAllowsExternal) return t("settings.mcpPluginAuthorClosed");
  if (plugin.discoveryError) return t("settings.mcpPluginDiscoveryError", { error: plugin.discoveryError });
  if (!pluginMcpEnabled(plugin)) return t("settings.mcpPluginToolCountOff", { total: plugin.tools.length });
  return [t("settings.mcpPluginToolCount", { exposed: pluginMcpExposedCount(plugin), total: plugin.tools.length }), t("settings.mcpPluginCeilingSummary", { level: t(`settings.mcpAccessLevel.${plugin.grant.ceiling}`) })].join(" · ");
}

async function openResult(item: McpCapabilitySearchItem, event: Event) {
  const trigger = event.currentTarget as HTMLElement;
  if (item.pluginId) {
    if (item.toolName) pluginPanel.value?.openTool(item.pluginId, item.toolName, trigger);
    else pluginPanel.value?.openDetail(item.pluginId, trigger);
  } else if (item.toolsetId) {
    detailPath.value = mcpCategoryTitle(mcpCapabilityCategoryId(item.toolsetId), t);
    await nextTick();
    builtinPanel.value?.openDetail(item.toolsetId, "tools", item.toolName, trigger);
  }
}
</script>

<template>
  <section ref="rootElement" class="mcp-capability-browser min-w-0 space-y-3" data-mcp-capability-browser>
    <div class="flex flex-wrap items-center gap-3">
      <div class="relative min-w-48 flex-1">
        <Search class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input :model-value="state.search" class="h-9 pl-8 pr-9 text-sm" :placeholder="t('settings.mcpBrowser.searchPlaceholder')" :aria-label="t('settings.mcpBrowser.searchPlaceholder')" data-mcp-global-search @update:model-value="updateSearch" />
        <Button v-if="state.search" variant="ghost" size="icon-sm" class="absolute right-1 top-1" :aria-label="t('settings.mcpBrowser.clearSearch')" data-mcp-clear-search @click="updateSearch('')"><X class="size-3.5" /></Button>
      </div>
      <div class="flex shrink-0 rounded-md border p-0.5" role="group" :aria-label="t('settings.mcpBrowser.viewMode')" data-mcp-view-toggle>
        <button type="button" class="rounded px-2.5 py-1 text-xs" :class="viewMode === 'manage' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'" :aria-pressed="viewMode === 'manage'" data-mcp-view-mode="manage" @click="setViewMode('manage')">
          {{ t("settings.mcpBrowser.viewManage") }}
        </button>
        <button type="button" class="rounded px-2.5 py-1 text-xs" :class="viewMode === 'overview' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'" :aria-pressed="viewMode === 'overview'" data-mcp-view-mode="overview" @click="setViewMode('overview')">
          {{ t("settings.mcpBrowser.viewOverview") }}
        </button>
      </div>
      <label class="flex shrink-0 items-center gap-2 text-xs">
        <input type="checkbox" :checked="state.onlyEnabled" class="accent-primary" data-mcp-only-enabled @change="state = { ...state, onlyEnabled: ($event.target as HTMLInputElement).checked }" />
        {{ t("settings.mcpCapabilitiesOnlyEnabled") }}
      </label>
    </div>

    <div v-if="viewMode === 'manage' || searching" class="mcp-category-select flex items-center gap-2">
      <Select :model-value="state.selected" @update:model-value="select">
        <SelectTrigger class="min-w-0 flex-1" :aria-label="t('settings.mcpBrowser.navigation')"><SelectValue /></SelectTrigger>
        <SelectContent>
          <!-- Sidebar filters are hidden in compact layouts, so keep every destination available here. -->
          <SelectGroup>
            <SelectLabel>{{ t("settings.mcpBrowser.builtin") }}</SelectLabel>
            <SelectItem v-for="category in categories" :key="category.id" :value="category.id">{{ mcpCategoryTitle(category.id, t) }} · {{ t("settings.mcpBrowser.categoryCount", { count: category.toolsets.length }) }}</SelectItem>
          </SelectGroup>
          <SelectGroup v-if="showPlugins">
            <SelectLabel>{{ t("settings.mcpBrowser.plugins") }}</SelectLabel>
            <SelectItem v-for="plugin in plugins ?? []" :key="plugin.pluginId" :value="`plugin:${plugin.pluginId}`">
              {{ plugin.pluginName }} · {{ t("settings.mcpCapabilitiesFilterPlugin") }}
              <span v-if="pluginMcpPendingTools(plugin).length"> · {{ t("settings.mcpPluginPendingTools", { count: pluginMcpPendingTools(plugin).length }) }}</span>
            </SelectItem>
          </SelectGroup>
          <SelectItem value="advanced">{{ t("settings.mcpBrowser.advanced") }}</SelectItem>
        </SelectContent>
      </Select>
      <Button v-if="showPlugins" variant="ghost" size="icon-sm" :disabled="pluginsLoading" :aria-label="`${t('settings.mcpBrowser.plugins')} · ${t('settings.mcpPluginsRefresh')}`" :title="`${t('settings.mcpBrowser.plugins')} · ${t('settings.mcpPluginsRefresh')}`" @click="emit('refresh:plugins')"
        ><RefreshCw class="size-3.5" :class="{ 'animate-spin': pluginsLoading }"
      /></Button>
    </div>

    <section v-if="viewMode === 'overview' && !searching" class="space-y-4" data-mcp-overview>
      <div v-if="loading && !catalog" role="status" class="py-6 text-xs text-muted-foreground">{{ t("settings.mcpCapabilitiesLoading") }}</div>
      <div v-else-if="loadError" role="alert" class="space-y-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
        <p>{{ t("settings.mcpCapabilitiesLoadFailed", { error: loadError }) }}</p>
        <Button variant="outline" size="sm" :disabled="loading" data-mcp-overview-retry @click="emit('retry')">{{ t("settings.mcpBrowser.retry") }}</Button>
      </div>
      <p v-else-if="!catalog" class="rounded-md border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">{{ t("settings.mcpCapabilitiesLoading") }}</p>
      <template v-else>
        <p v-if="!overviewHasContent" class="rounded-md border border-dashed px-4 py-8 text-center text-xs text-muted-foreground" data-mcp-overview-empty>{{ t(state.onlyEnabled ? "settings.mcpBrowser.emptyEnabled" : "settings.mcpCapabilitiesSearchEmpty") }}</p>
        <section v-for="category in overviewCategories" :key="category.id" class="overflow-hidden rounded-md border" :data-mcp-overview-category="category.id">
          <header class="flex flex-wrap items-start gap-3 bg-muted/20 px-3 py-3">
            <button
              type="button"
              class="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :aria-expanded="overviewCategoryExpanded(category.id)"
              :aria-label="`${overviewCategoryExpanded(category.id) ? t('settings.mcpBrowser.collapseCategory') : t('settings.mcpBrowser.expandCategory')}: ${mcpCategoryTitle(category.id, t)}`"
              data-mcp-overview-category-toggle
              @click="toggleOverviewCategory(category.id)"
            >
              <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span aria-hidden="true" class="text-muted-foreground">{{ overviewCategoryExpanded(category.id) ? "▾" : "▸" }}</span>
                <span class="text-sm font-semibold">{{ mcpCategoryTitle(category.id, t) }}</span>
                <span class="text-xs text-muted-foreground">{{ t("settings.mcpBrowser.overviewSummary", { toolsets: category.toolsets.length, total: category.tools.length, enabled: category.enabled }) }}</span>
              </span>
              <span class="mt-1 block text-xs text-muted-foreground">{{ t(`settings.mcpBrowser.category.${category.id}.description`) }}</span>
            </button>
            <div class="flex shrink-0 flex-wrap gap-1.5">
              <Button variant="outline" size="sm" class="h-7 text-[11px]" :disabled="!editable || !category.tools.length || category.enabled === category.tools.length" :data-mcp-overview-category-enable="category.id" @click="batchCategory(category.id, true)">{{
                t("settings.mcpBrowser.enableCategory")
              }}</Button>
              <Button variant="outline" size="sm" class="h-7 text-[11px]" :disabled="!editable || !category.tools.length || category.enabled === 0" :data-mcp-overview-category-disable="category.id" @click="batchCategory(category.id, false)">{{ t("settings.mcpBrowser.disableCategory") }}</Button>
            </div>
          </header>
          <ul v-if="overviewCategoryExpanded(category.id)" class="divide-y">
            <li v-for="toolset in category.visibleToolsets" :key="toolset.id" class="flex items-start gap-3 px-3 py-3" :data-mcp-overview-toolset="toolset.id">
              <button type="button" class="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-mcp-overview-toolset-open @click="openOverviewToolset(category.id, toolset, $event)">
                <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span class="break-words text-sm font-medium">{{ mcpToolsetTitle(toolset.id, t) }}</span>
                  <span class="text-xs text-muted-foreground">{{ t("settings.mcpBrowser.enabledToolCount", { enabled: toolset.tools.filter((tool) => mcpToolAllowed(allowedToolNames, tool.name)).length, total: toolset.tools.length }) }}</span>
                  <span v-if="mcpToolsetState(allowedToolNames, toolset) === 'partial'" class="rounded border border-amber-500/40 px-1.5 text-[11px] text-amber-700 dark:text-amber-300" data-mcp-overview-partial>{{ t("settings.mcpBrowser.partialEnabled") }}</span>
                  <span v-for="level in mcpToolsetAccessLevels(toolset)" :key="level" class="rounded border px-1.5 text-[10px] leading-4">{{ t(`settings.mcpAccessLevel.${level}`) }}</span>
                </span>
                <span v-if="overviewToolsetDescription(toolset)" class="mt-0.5 block break-words text-xs text-muted-foreground">{{ overviewToolsetDescription(toolset) }}</span>
                <span class="mt-1 block text-xs text-muted-foreground">{{ overviewToolsetCoverage(toolset) }}</span>
              </button>
              <input
                type="checkbox"
                class="mt-1 size-4 shrink-0 accent-primary"
                :checked="mcpToolsetState(allowedToolNames, toolset) !== 'off'"
                :disabled="!editable"
                :aria-label="mcpToolsetTitle(toolset.id, t)"
                :data-mcp-overview-toolset-switch="toolset.id"
                @change="emit('set:toolset', toolset, ($event.target as HTMLInputElement).checked)"
              />
            </li>
            <li v-if="category.visibleToolsets.length === 0" class="px-3 py-5 text-center text-xs text-muted-foreground" data-mcp-overview-category-empty>{{ t("settings.mcpBrowser.emptyEnabled") }}</li>
          </ul>
        </section>

        <slot v-if="showPlugins" name="plugin-warning" />
        <section v-if="showPlugins" class="overflow-hidden rounded-md border" data-mcp-overview-plugins>
          <header class="flex items-center justify-between gap-3 bg-muted/20 px-3 py-3">
            <div>
              <h3 class="text-sm font-semibold">{{ t("settings.mcpBrowser.plugins") }}</h3>
              <p class="text-xs text-muted-foreground">{{ t("settings.mcpBrowser.overviewPluginsHint") }}</p>
            </div>
            <Button variant="ghost" size="sm" class="h-7 text-[11px]" :disabled="pluginsLoading" data-mcp-overview-plugins-refresh @click="emit('refresh:plugins')">{{ t("settings.mcpPluginsRefresh") }}</Button>
          </header>
          <ul v-if="overviewPlugins.length" class="divide-y">
            <li v-for="plugin in overviewPlugins" :key="plugin.pluginId" class="flex items-start gap-3 px-3 py-3" :data-mcp-overview-plugin="plugin.pluginId">
              <button type="button" class="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-mcp-overview-plugin-open @click="openOverviewPlugin(plugin, $event)">
                <span class="flex flex-wrap items-center gap-x-2 gap-y-1"
                  ><span class="break-words text-sm font-medium">{{ plugin.pluginName }}</span
                  ><span class="rounded border px-1.5 text-[10px] text-muted-foreground">{{ t("settings.mcpCapabilitiesFilterPlugin") }}</span></span
                >
                <span class="mt-0.5 block break-words text-xs text-muted-foreground">{{ overviewPluginSummary(plugin) }}</span>
                <span v-if="pluginMcpPendingTools(plugin).length" class="mt-1 block text-[11px] text-amber-700 dark:text-amber-300">{{ t("settings.mcpPluginPendingTools", { count: pluginMcpPendingTools(plugin).length }) }}</span>
              </button>
              <span class="mt-1 text-xs text-muted-foreground">{{ t("settings.mcpBrowser.overviewOpenDetails") }}</span>
            </li>
          </ul>
          <p v-else class="px-3 py-5 text-center text-xs text-muted-foreground">
            {{ pluginsLoading ? t("settings.mcpPluginsLoading") : pluginsError ? t("settings.mcpPluginsLoadFailed", { error: pluginsError }) : state.onlyEnabled && plugins?.length ? t("settings.mcpBrowser.emptyEnabled") : t("settings.mcpPluginsEmpty") }}
          </p>
        </section>
        <p v-if="batchChanged" role="status" class="text-xs" data-mcp-batch-feedback>{{ t("settings.mcpBrowser.batchChanged") }}</p>
      </template>
    </section>

    <div class="mcp-capability-layout" :class="{ hidden: viewMode === 'overview' && !searching }">
      <aside v-if="viewMode === 'manage' || searching" class="mcp-category-sidebar min-w-0">
        <nav :aria-label="t('settings.mcpBrowser.navigation')" class="mcp-navigation-rail" data-mcp-navigation>
          <div class="mcp-nav-section" data-mcp-nav-section="builtin">
            <div class="mcp-nav-section-header">
              <p class="mcp-nav-section-title">
                <span>{{ t("settings.mcpBrowser.builtin") }}</span>
                <span class="mcp-nav-section-count">{{ categories.length }}</span>
              </p>
              <div class="mcp-nav-filter-control" :class="{ active: builtinFilter }" :title="`${t('settings.mcpCapabilitiesFilterLabel')}: ${t('settings.mcpBrowser.builtin')}`" @click="focusNavigationFilter">
                <Search class="mcp-nav-filter-icon" aria-hidden="true" />
                <Input v-model="builtinFilter" class="mcp-nav-filter-input h-6 border-0 bg-transparent px-0 text-[11px] shadow-none focus-visible:ring-0" :placeholder="''" :aria-label="`${t('settings.mcpCapabilitiesFilterLabel')}: ${t('settings.mcpBrowser.builtin')}`" data-mcp-builtin-filter />
                <Button v-if="builtinFilter" variant="ghost" size="icon-sm" class="mcp-nav-filter-action size-6 shrink-0" :aria-label="t('settings.mcpBrowser.clearSearch')" data-mcp-clear-builtin-filter @click="builtinFilter = ''"><X class="size-3" /></Button>
              </div>
            </div>
            <button
              v-for="category in filteredCategories"
              :key="category.id"
              type="button"
              class="mcp-category-button"
              :class="state.selected === category.id && !searching ? 'mcp-category-button-selected font-semibold text-foreground' : 'text-muted-foreground'"
              :aria-current="state.selected === category.id && !searching ? 'page' : undefined"
              :data-mcp-category="category.id"
              @click="select(category.id)"
            >
              <span class="min-w-0 break-words [overflow-wrap:anywhere]">{{ mcpCategoryTitle(category.id, t) }}</span
              ><span class="shrink-0 text-xs tabular-nums" :aria-label="t('settings.mcpBrowser.categoryCount', { count: category.toolsets.length })">{{ category.toolsets.length }}</span>
            </button>
            <p v-if="filteredCategories.length === 0" class="px-2 py-2 text-[11px] text-muted-foreground">{{ t("settings.mcpCapabilitiesSearchEmpty") }}</p>
          </div>
          <div v-if="showPlugins" class="mcp-nav-section" data-mcp-nav-section="plugins">
            <div class="mcp-nav-section-header">
              <p class="mcp-nav-section-title">
                <span>{{ t("settings.mcpBrowser.plugins") }}</span>
                <span class="mcp-nav-section-count">{{ props.plugins?.length ?? 0 }}</span>
              </p>
              <div class="mcp-nav-filter-control mcp-nav-filter-control-with-refresh" :class="{ active: pluginFilter }" :title="`${t('settings.mcpCapabilitiesFilterLabel')}: ${t('settings.mcpBrowser.plugins')}`" @click="focusNavigationFilter">
                <Search class="mcp-nav-filter-icon" aria-hidden="true" />
                <Input v-model="pluginFilter" class="mcp-nav-filter-input h-6 border-0 bg-transparent px-0 text-[11px] shadow-none focus-visible:ring-0" :placeholder="''" :aria-label="`${t('settings.mcpCapabilitiesFilterLabel')}: ${t('settings.mcpBrowser.plugins')}`" data-mcp-plugin-filter />
                <Button v-if="pluginFilter" variant="ghost" size="icon-sm" class="mcp-nav-filter-action size-6 shrink-0" :aria-label="t('settings.mcpBrowser.clearSearch')" data-mcp-clear-plugin-filter @click="pluginFilter = ''"><X class="size-3" /></Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="mcp-nav-filter-action mcp-nav-refresh-action size-6 shrink-0"
                  :disabled="pluginsLoading"
                  :aria-label="`${t('settings.mcpBrowser.plugins')} · ${t('settings.mcpPluginsRefresh')}`"
                  :title="t('settings.mcpPluginsRefresh')"
                  data-mcp-plugins-refresh-nav
                  @click="emit('refresh:plugins')"
                  ><RefreshCw class="size-3" :class="{ 'animate-spin': pluginsLoading }"
                /></Button>
              </div>
            </div>
            <button
              v-for="plugin in filteredPlugins"
              :key="plugin.pluginId"
              type="button"
              class="mcp-category-button flex-wrap"
              :class="selectedPluginId === plugin.pluginId && !searching ? 'mcp-category-button-selected font-semibold text-foreground' : 'text-muted-foreground'"
              :aria-current="selectedPluginId === plugin.pluginId && !searching ? 'page' : undefined"
              :data-mcp-category="`plugin:${plugin.pluginId}`"
              @click="select(`plugin:${plugin.pluginId}`)"
            >
              <span class="min-w-0 break-words [overflow-wrap:anywhere]">{{ plugin.pluginName }}</span>
              <span class="rounded border px-1 text-[10px] font-normal">{{ t("settings.mcpCapabilitiesFilterPlugin") }}</span>
              <span v-if="pluginMcpPendingTools(plugin).length" class="max-w-full truncate text-[11px] font-normal text-amber-700 dark:text-amber-300">{{ t("settings.mcpPluginPendingTools", { count: pluginMcpPendingTools(plugin).length }) }}</span>
            </button>
            <p v-if="filteredPlugins.length === 0" class="px-2 py-2 text-[11px] text-muted-foreground">{{ t(plugins?.length ? "settings.mcpCapabilitiesSearchEmpty" : "settings.mcpPluginsEmpty") }}</p>
          </div>
          <button
            type="button"
            class="mcp-category-button mcp-advanced-category-button"
            :class="state.selected === 'advanced' && !searching ? 'mcp-category-button-selected font-semibold text-foreground' : 'text-muted-foreground'"
            :aria-current="state.selected === 'advanced' && !searching ? 'page' : undefined"
            data-mcp-category="advanced"
            @click="select('advanced')"
          >
            {{ t("settings.mcpBrowser.advanced") }}
          </button>
        </nav>
      </aside>

      <div class="min-w-0 space-y-4" data-mcp-category-content>
        <div v-if="(viewMode === 'manage' || searching) && showPlugins && (!selectedPluginId || searching) && (pluginsLoading || pluginsError || !plugins?.length)" class="space-y-2 text-xs text-muted-foreground" data-mcp-plugin-source-status>
          <p v-if="pluginsLoading" role="status" class="flex items-center gap-2"><Loader2 class="size-3.5 shrink-0 animate-spin" />{{ t("settings.mcpPluginsLoading") }}</p>
          <p v-else-if="pluginsError" role="alert" class="break-words text-destructive">{{ t("settings.mcpPluginsLoadFailed", { error: pluginsError }) }}</p>
          <p v-else-if="plugins">{{ t("settings.mcpPluginsEmpty") }}</p>
          <Button v-if="!pluginsLoading" variant="outline" size="sm" class="h-7 gap-1.5 text-xs" data-mcp-plugin-source-retry @click="emit('refresh:plugins')"><RefreshCw class="size-3.5" />{{ t("settings.mcpPluginsRefresh") }}</Button>
        </div>

        <template v-if="searching">
          <h3 class="text-base font-semibold">{{ t("settings.mcpBrowser.searchResults") }}</h3>
          <p v-if="loading" role="status" class="text-xs text-muted-foreground">{{ t("settings.mcpCapabilitiesLoading") }}</p>
          <div v-if="loadError" role="alert" class="space-y-2 text-xs">
            <p class="text-destructive">{{ t("settings.mcpCapabilitiesLoadFailed", { error: loadError }) }}</p>
            <Button variant="outline" size="sm" :disabled="loading" @click="emit('retry')">{{ t("settings.mcpBrowser.retry") }}</Button>
          </div>
          <section v-for="group in results" :key="group.id" class="space-y-2" :data-mcp-search-group="group.id">
            <h4 class="flex flex-wrap items-center gap-2 text-sm font-medium">
              {{ group.title }}<span class="rounded border px-1.5 text-[10px] font-normal text-muted-foreground">{{ t(group.source === "plugin" ? "settings.mcpBrowser.plugins" : "settings.mcpBrowser.builtin") }}</span>
            </h4>
            <ul class="divide-y rounded-md border">
              <li v-for="item in group.items" :key="item.key">
                <button type="button" class="w-full space-y-1 px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :data-mcp-search-result="item.key" @click="openResult(item, $event)">
                  <span class="block break-words text-sm font-medium">{{ item.title }}</span>
                  <span class="block break-words text-xs text-muted-foreground">{{ item.path }}</span>
                  <span v-if="item.toolName && item.toolName !== item.title" class="block break-all font-mono text-xs text-muted-foreground">{{ item.toolName }}</span>
                </button>
              </li>
            </ul>
          </section>
          <p v-if="!results.length && !loading && !pluginsLoading" class="rounded-md border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">{{ t("settings.mcpCapabilitiesSearchEmpty") }}</p>
        </template>

        <div v-if="showBuiltin && selectedCategory" class="space-y-3">
          <header class="space-y-1">
            <h3 class="text-base font-semibold">{{ title }}</h3>
            <p class="text-xs leading-relaxed text-muted-foreground">{{ t(`settings.mcpBrowser.category.${selectedCategory.id}.description`) }}</p>
            <p v-if="catalog && !loading && !loadError" class="text-xs text-muted-foreground" data-mcp-category-summary>{{ t("settings.mcpBrowser.summary", { toolsets: selectedCategory.toolsets.length, total: categoryTools.length, enabled: enabledCount }) }}</p>
          </header>
          <div class="flex flex-wrap gap-2" data-mcp-category-batch>
            <Button variant="outline" size="sm" class="h-auto min-h-7 whitespace-normal py-1 text-xs" :disabled="!editable || enabledCount === categoryTools.length" data-mcp-category-enable @click="batch(true)">{{ t("settings.mcpBrowser.enableCategory") }}</Button>
            <Button variant="outline" size="sm" class="h-auto min-h-7 whitespace-normal py-1 text-xs" :disabled="!editable || enabledCount === 0" data-mcp-category-disable @click="batch(false)">{{ t("settings.mcpBrowser.disableCategory") }}</Button>
          </div>
          <p class="text-xs text-muted-foreground">{{ t("settings.mcpBrowser.coverageHint") }}</p>
          <p v-if="batchChanged" role="status" class="text-xs" data-mcp-batch-feedback>{{ t("settings.mcpBrowser.batchChanged") }}</p>
        </div>

        <!-- Keep these instances mounted so a detail stays open as filters change. -->
        <McpCapabilitiesPanel
          ref="builtinPanel"
          :focus-fallback="focusSearch"
          :catalog="catalog"
          :loading="loading"
          :load-error="loadError"
          :allowed-tool-names="allowedToolNames"
          :saved-tool-names="savedToolNames"
          :save-toolset="saveToolset"
          :connections="connections"
          :disabled="!editable"
          :visible-toolset-ids="viewMode === 'overview' || searching ? undefined : (selectedCategory?.toolsets.map((toolset) => toolset.id) ?? [])"
          :title-path="searching || viewMode === 'overview' ? detailPath : title"
          :list-hidden="viewMode !== 'manage' || !showBuiltin"
          :only-enabled="state.onlyEnabled"
          @set:toolset="(toolset, enabled) => emit('set:toolset', toolset, enabled)"
          @set:tool="(name, enabled) => emit('set:tool', name, enabled)"
          @retry="emit('retry')"
        />
        <p v-if="showBuiltin" class="text-xs text-muted-foreground">{{ t("settings.mcpBrowser.draftHint") }}</p>

        <slot v-if="(viewMode === 'manage' || searching) && showPlugins && ((!searching && selectedPluginId) || (searching && results.some((group) => group.source === 'plugin')))" name="plugin-warning" />
        <McpPluginCapabilities
          v-if="showPlugins"
          ref="pluginPanel"
          :focus-fallback="focusSearch"
          :plugins="plugins"
          :loading="pluginsLoading"
          :load-error="pluginsError"
          :selected-plugin-id="viewMode === 'manage' && !searching ? selectedPluginId : undefined"
          :pending-plugin-ids="pendingPluginIds"
          :list-hidden="viewMode !== 'manage' || searching || !selectedPluginId"
          :only-enabled="state.onlyEnabled"
          :save="savePlugin"
          @refresh="emit('refresh:plugins')"
          @saved="(view) => emit('saved:plugin', view)"
        />

        <section v-if="viewMode === 'manage' && state.selected === 'advanced' && !searching" class="space-y-3" data-mcp-advanced>
          <h3 class="text-base font-semibold">{{ t("settings.mcpBrowser.advanced") }}</h3>
          <p v-if="loading" role="status" class="text-xs text-muted-foreground">{{ t("settings.mcpCapabilitiesLoading") }}</p>
          <div v-if="loadError" role="alert" class="space-y-2 text-xs">
            <p class="text-destructive">{{ t("settings.mcpCapabilitiesLoadFailed", { error: loadError }) }}</p>
            <Button variant="outline" size="sm" :disabled="loading" @click="emit('retry')">{{ t("settings.mcpBrowser.retry") }}</Button>
          </div>
          <slot name="advanced" />
          <p class="text-xs text-muted-foreground">{{ t("settings.mcpBrowser.draftHint") }}</p>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.mcp-capability-browser {
  container-type: inline-size;
}
.mcp-category-sidebar {
  display: none;
  align-self: start;
}
.mcp-navigation-rail {
  border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
  border-radius: calc(var(--radius-md) + 2px);
  padding: 7px;
  background: color-mix(in srgb, var(--background) 94%, var(--muted));
  box-shadow: 0 1px 2px color-mix(in srgb, var(--foreground) 5%, transparent);
}
.mcp-nav-section {
  padding: 0 1px;
}
.mcp-nav-section + .mcp-nav-section {
  margin-top: 9px;
  padding-top: 9px;
  border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
}
.mcp-nav-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  min-height: 26px;
  padding: 0 4px 5px;
}
.mcp-nav-section-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  margin: 0;
  line-height: 1.2;
  letter-spacing: 0.015em;
  color: var(--foreground);
  font-size: 11px;
  font-weight: 650;
}
.mcp-nav-section-count {
  color: var(--muted-foreground);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.mcp-nav-filter-control {
  display: flex;
  min-width: 0;
  width: 32px;
  height: 26px;
  align-items: center;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border) 84%, transparent);
  border-radius: var(--radius-sm);
  background: var(--background);
  cursor: text;
  transition:
    width 150ms ease,
    border-color 140ms ease,
    box-shadow 140ms ease;
}
.mcp-nav-filter-control.active,
.mcp-nav-filter-control:focus-within {
  width: 128px;
}
.mcp-nav-filter-icon {
  width: 13px;
  height: 13px;
  flex: 0 0 13px;
  margin: 0 8px;
  pointer-events: none;
  color: var(--muted-foreground);
}
.mcp-nav-filter-input {
  min-width: 0;
  flex: 1 1 auto;
  opacity: 1;
}
.mcp-nav-filter-action {
  margin-right: 2px;
}
.mcp-nav-refresh-action {
  margin: 0;
  border-left: 1px solid color-mix(in srgb, var(--border) 84%, transparent);
  border-radius: 0;
  padding-right: 5px;
  padding-left: 5px;
}
.mcp-nav-filter-control-with-refresh {
  width: 62px;
}
.mcp-nav-filter-control-with-refresh.active,
.mcp-nav-filter-control-with-refresh:focus-within {
  width: 132px;
}
.mcp-nav-filter-control-with-refresh .mcp-nav-filter-input {
  width: auto;
}
.mcp-capability-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
}
.mcp-category-button {
  position: relative;
  display: flex;
  width: 100%;
  min-height: 30px;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  text-align: left;
  font-size: 12px;
  line-height: 1.25;
  transition:
    background-color 140ms ease,
    color 140ms ease,
    box-shadow 140ms ease;
}
.mcp-category-button-selected {
  background: color-mix(in srgb, var(--primary) 8%, var(--background));
  box-shadow: inset 2px 0 var(--primary);
}
.mcp-category-button:hover {
  background: color-mix(in srgb, var(--muted) 70%, var(--background));
}
.mcp-category-button-selected:hover {
  background: color-mix(in srgb, var(--primary) 12%, var(--background));
}
.mcp-category-button:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
.mcp-advanced-category-button {
  margin-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  border-radius: 0;
  padding-top: 11px;
}
.mcp-nav-filter-control:focus-within {
  border-color: var(--ring);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ring) 25%, transparent);
}
@container (min-width: 600px) {
  .mcp-category-select {
    display: none;
  }
  .mcp-category-sidebar {
    display: block;
  }
  .mcp-capability-layout {
    grid-template-columns: 144px minmax(0, 1fr);
  }
  .mcp-nav-section-header {
    flex-wrap: wrap;
  }
  .mcp-nav-filter-control {
    width: 32px;
  }
  .mcp-nav-filter-control-with-refresh {
    width: 62px;
  }
  .mcp-nav-filter-control.active,
  .mcp-nav-filter-control:focus-within {
    width: 104px;
  }
  .mcp-nav-filter-control-with-refresh.active,
  .mcp-nav-filter-control-with-refresh:focus-within {
    width: 116px;
  }
}
@container (min-width: 760px) {
  .mcp-capability-layout {
    grid-template-columns: 184px minmax(0, 1fr);
    gap: 16px;
  }
  .mcp-nav-section-header {
    flex-wrap: nowrap;
  }
  .mcp-nav-filter-control {
    width: 32px;
  }
  .mcp-nav-filter-control-with-refresh {
    width: 62px;
  }
  .mcp-nav-filter-control.active,
  .mcp-nav-filter-control:focus-within {
    width: 116px;
  }
  .mcp-nav-filter-control-with-refresh.active,
  .mcp-nav-filter-control-with-refresh:focus-within {
    width: 124px;
  }
}
</style>
