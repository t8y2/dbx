<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Puzzle, RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { PluginMcpAccessLevel, PluginMcpGrant, PluginMcpToolView, PluginMcpView } from "@/types/mcpCatalog";
import {
  PLUGIN_MCP_ACCESS_LEVELS,
  pluginMcpAccessLevels,
  pluginMcpAuthorizedGrant,
  pluginMcpBaseGrant,
  pluginMcpDeclaredTools,
  pluginMcpDefaultCeiling,
  pluginMcpEnabled,
  pluginMcpExposedCount,
  pluginMcpLevelAtMost,
  pluginMcpNeedsAuthorization,
  pluginMcpPendingTools,
  pluginMcpSetCeiling,
  pluginMcpSetEnabled,
  pluginMcpSetToolEnabled,
  pluginMcpToolsByToolset,
  pluginMcpUndeclaredTools,
} from "@/lib/mcp/pluginMcpGrant";

/**
 * Plugin cards of the MCP capability tab: one card per MCP-capable plugin,
 * managed per plugin (switch, access ceiling, per-tool opt-outs, confirming
 * new tools). Grants save immediately through `save`, independent of the
 * settings dialog's Apply button, because they live outside the MCP policy.
 */
const props = withDefaults(
  defineProps<{
    plugins: readonly PluginMcpView[] | null;
    loading?: boolean;
    loadError?: string;
    search?: string;
    disabled?: boolean;
    filterKind?: "all" | "builtin" | "plugin";
    onlyEnabled?: boolean;
    selectedPluginId?: string;
    listHidden?: boolean;
    focusFallback?: () => void;
    pendingPluginIds?: readonly string[];
    save: (pluginId: string, grant: PluginMcpGrant, approveCurrent: boolean) => Promise<PluginMcpView>;
  }>(),
  { loading: false, loadError: "", search: "", disabled: false, filterKind: "all", onlyEnabled: false, listHidden: false },
);

const emit = defineEmits<{ refresh: []; saved: [view: PluginMcpView] }>();

const { t } = useI18n();
const rootElement = ref<HTMLElement | null>(null);
const inline = computed(() => props.selectedPluginId !== undefined && !props.listHidden);
let detailTrigger: HTMLElement | null = null;
let authorizeTrigger: HTMLElement | null = null;
const detailPluginId = ref<string | null>(null);
const expandedToolNames = ref(new Set<string>());
const authorizePluginId = ref<string | null>(null);
const authorizeCeiling = ref<PluginMcpAccessLevel>("write");
const localSavingPluginIds = ref(new Set<string>());
const savingPluginIds = computed(() => new Set([...localSavingPluginIds.value, ...(props.pendingPluginIds ?? [])]));
const savedPluginIds = ref(new Set<string>());
const saveErrors = ref(new Map<string, string>());
const saveError = computed(() => (inline.value ? (saveErrors.value.get(props.selectedPluginId!) ?? "") : [...saveErrors.value.values()].join(" ")));

const cards = computed(() => {
  const needle = props.search.trim().toLowerCase();
  return (props.plugins ?? []).filter((view) => {
    if (props.filterKind === "builtin" || (props.onlyEnabled && !pluginMcpEnabled(view))) return false;
    if (!needle) return true;
    return [view.pluginName, view.pluginId, ...view.tools.flatMap((tool) => [tool.name, tool.description])].some((text) => text.toLowerCase().includes(needle));
  });
});

const detail = computed(() => props.plugins?.find((view) => view.pluginId === (inline.value ? props.selectedPluginId : detailPluginId.value)) ?? null);
const authorizing = computed(() => props.plugins?.find((view) => view.pluginId === authorizePluginId.value) ?? null);
const detailGroups = computed(() => {
  if (!detail.value) return [];
  const view = detail.value;
  return pluginMcpToolsByToolset(view)
    .map((group) => ({ ...group, tools: group.tools.filter((tool) => !props.onlyEnabled || expandedToolNames.value.has(tool.name) || (pluginMcpEnabled(view) && tool.access !== null && !view.grant.disabledTools.includes(tool.name))) }))
    .filter((group) => group.tools.length > 0);
});

watch(
  () => props.selectedPluginId,
  () => {
    expandedToolNames.value = new Set();
  },
);

const levelClass: Record<PluginMcpAccessLevel, string> = {
  read: "border-border text-muted-foreground",
  write: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  full: "border-red-500/40 text-red-600 dark:text-red-400",
};

async function persist(view: PluginMcpView, grant: PluginMcpGrant, approveCurrent = false) {
  if (props.disabled || !view.authorAllowsExternal || savingPluginIds.value.has(view.pluginId)) return false;
  localSavingPluginIds.value.add(view.pluginId);
  savedPluginIds.value.delete(view.pluginId);
  saveErrors.value.delete(view.pluginId);
  try {
    emit("saved", await props.save(view.pluginId, grant, approveCurrent));
    savedPluginIds.value.add(view.pluginId);
    return true;
  } catch (error) {
    saveErrors.value.set(view.pluginId, t("settings.mcpPluginSaveFailed", { name: view.pluginName, message: error instanceof Error ? error.message : String(error) }));
    return false;
  } finally {
    localSavingPluginIds.value.delete(view.pluginId);
  }
}

function onPluginSwitch(view: PluginMcpView, enabled: boolean) {
  if (props.disabled || !view.authorAllowsExternal || savingPluginIds.value.has(view.pluginId)) return;
  if (enabled && pluginMcpNeedsAuthorization(view)) {
    openAuthorize(view);
    return;
  }
  void persist(view, pluginMcpSetEnabled(pluginMcpBaseGrant(view), enabled));
}

function openAuthorize(view: PluginMcpView, trigger?: HTMLElement | null) {
  if (props.disabled || !view.authorAllowsExternal || savingPluginIds.value.has(view.pluginId)) return;
  authorizeTrigger = trigger ?? activeFocusTarget();
  authorizePluginId.value = view.pluginId;
  authorizeCeiling.value = view.hasSavedGrant && view.grant.external ? view.grant.ceiling : pluginMcpDefaultCeiling(view);
}

async function confirmAuthorize() {
  const view = authorizing.value;
  if (!view) return;
  if (await persist(view, pluginMcpAuthorizedGrant(view, authorizeCeiling.value), true)) authorizePluginId.value = null;
}

function closeAuthorize(open: boolean) {
  if (!open && (!authorizing.value || !savingPluginIds.value.has(authorizing.value.pluginId))) authorizePluginId.value = null;
}

function onCeilingChange(view: PluginMcpView, ceiling: PluginMcpAccessLevel) {
  if (!pluginMcpEnabled(view)) return;
  void persist(view, pluginMcpSetCeiling(pluginMcpBaseGrant(view), ceiling));
}

function onToolSwitch(view: PluginMcpView, tool: PluginMcpToolView, enabled: boolean) {
  if (!pluginMcpEnabled(view) || tool.access === null) return;
  void persist(view, pluginMcpSetToolEnabled(pluginMcpBaseGrant(view), tool.name, enabled));
}

function openDetail(plugin: PluginMcpView | string, trigger?: HTMLElement | null) {
  const pluginId = typeof plugin === "string" ? plugin : plugin.pluginId;
  if (!props.plugins?.some((view) => view.pluginId === pluginId)) return;
  detailTrigger = trigger ?? activeFocusTarget();
  detailPluginId.value = pluginId;
  expandedToolNames.value = new Set();
}

async function openTool(pluginId: string, toolName: string, trigger?: HTMLElement | null) {
  const view = props.plugins?.find((plugin) => plugin.pluginId === pluginId);
  if (!view?.tools.some((tool) => tool.name === toolName)) return;
  openDetail(pluginId, trigger);
  await nextTick();
  if (detail.value?.pluginId !== pluginId) return;
  expandedToolNames.value = new Set([toolName]);
  await nextTick();
  const rows = rootElement.value?.querySelectorAll?.<HTMLElement>("[data-mcp-plugin-tool]") ?? [];
  const dialogRows = typeof document === "undefined" ? [] : document.querySelectorAll<HTMLElement>("[data-mcp-plugin-detail] [data-mcp-plugin-tool]");
  const row = [...rows, ...dialogRows].find((element) => element.dataset.mcpPluginTool === toolName);
  row?.scrollIntoView?.({ block: "nearest" });
  row?.querySelector<HTMLButtonElement>("[data-mcp-plugin-tool-toggle]")?.focus();
}

function activeFocusTarget(): HTMLElement | null {
  if (typeof document === "undefined" || document.activeElement === document.body || document.activeElement === document.documentElement) return null;
  return document.activeElement as HTMLElement | null;
}

function restoreFocus(event: Event, trigger: HTMLElement | null) {
  if (trigger?.isConnected) {
    event.preventDefault();
    trigger.focus();
  } else if (props.focusFallback) {
    event.preventDefault();
    props.focusFallback();
  }
}

function restoreDetailFocus(event: Event) {
  restoreFocus(event, detailTrigger);
}

function restoreAuthorizeFocus(event: Event) {
  restoreFocus(event, authorizeTrigger);
}

defineExpose({ openDetail, openTool });

function toggleTool(name: string) {
  const next = new Set(expandedToolNames.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  expandedToolNames.value = next;
}

function toolsetTitle(title: string | null): string {
  return title ?? t("settings.mcpPluginDefaultToolset");
}

function exposureText(tool: PluginMcpToolView): string {
  return t(`settings.mcpPluginExposure.${tool.exposure}`);
}

function parameterDefault(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function cardSummary(view: PluginMcpView): string {
  if (!view.authorAllowsExternal) return t("settings.mcpPluginAuthorClosed");
  if (view.discoveryError) return t("settings.mcpPluginDiscoveryFailed");
  if (!pluginMcpEnabled(view)) return t("settings.mcpPluginToolCountOff", { total: view.tools.length });
  return t("settings.mcpPluginToolCount", { exposed: pluginMcpExposedCount(view), total: view.tools.length });
}
</script>

<template>
  <section ref="rootElement" class="min-w-0 space-y-2" data-mcp-plugins>
    <div v-if="!inline && !listHidden" class="flex items-center justify-between gap-2">
      <div>
        <p class="text-sm font-semibold">{{ t("settings.mcpPluginsTitle") }}</p>
        <p class="text-xs text-muted-foreground">{{ t("settings.mcpPluginsDescription") }}</p>
      </div>
      <Button variant="outline" size="sm" class="h-7 shrink-0 gap-1.5 text-xs" :disabled="loading" data-mcp-plugins-refresh @click="emit('refresh')">
        <Loader2 v-if="loading" class="size-3.5 animate-spin" />
        <RefreshCw v-else class="size-3.5" />
        {{ t("settings.mcpPluginsRefresh") }}
      </Button>
    </div>

    <p v-if="loadError && !listHidden" class="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">{{ t("settings.mcpPluginsLoadFailed", { error: loadError }) }}</p>
    <p v-if="saveError && !listHidden && !inline" role="alert" class="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400" data-mcp-plugin-save-error>{{ saveError }}</p>

    <div v-if="loading && !plugins && !listHidden" class="flex items-center gap-2 py-4 text-xs text-muted-foreground"><Loader2 class="size-3.5 animate-spin" />{{ t("settings.mcpPluginsLoading") }}</div>
    <div v-else-if="inline && plugins && !detail" class="space-y-3 rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground" data-mcp-plugin-unavailable>
      <p>{{ t("settings.mcpBrowser.pluginUnavailable") }}</p>
      <Button variant="outline" size="sm" :disabled="loading" data-mcp-plugins-refresh @click="emit('refresh')">
        <Loader2 v-if="loading" class="size-3.5 animate-spin" />
        <RefreshCw v-else class="size-3.5" />
        {{ t("settings.mcpPluginsRefresh") }}
      </Button>
    </div>
    <p v-else-if="!listHidden && !inline && plugins && plugins.length === 0" class="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground" data-mcp-plugins-empty>{{ t("settings.mcpPluginsEmpty") }}</p>

    <ul v-else-if="!inline && !listHidden && cards.length" class="divide-y rounded-md border">
      <li v-for="view in cards" :key="view.pluginId" class="flex items-start gap-3 px-3 py-2.5" :class="{ 'opacity-60': !view.authorAllowsExternal }" :data-mcp-plugin="view.pluginId">
        <Puzzle class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <button type="button" class="min-w-0 flex-1 rounded-sm text-left focus-visible:ring-3 focus-visible:ring-ring/50" data-mcp-plugin-open @click="openDetail(view)">
          <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="break-words text-sm font-medium [overflow-wrap:anywhere]">{{ view.pluginName }}</span>
            <span class="text-[11px] text-muted-foreground">v{{ view.version }}</span>
            <span v-for="level in pluginMcpAccessLevels(view.tools)" :key="level" class="rounded border px-1.5 text-[10px] leading-4" :class="levelClass[level]">{{ t(`settings.mcpAccessLevel.${level}`) }}</span>
          </span>
          <span class="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
            <span class="font-mono">{{ view.pluginId }}</span>
            <span>{{ cardSummary(view) }}</span>
            <span v-if="pluginMcpEnabled(view)">{{ t("settings.mcpPluginCeilingSummary", { level: t(`settings.mcpAccessLevel.${view.grant.ceiling}`) }) }}</span>
          </span>
          <span v-if="view.authorAllowsExternal && pluginMcpUndeclaredTools(view.tools).length" class="mt-1 block text-[11px] text-muted-foreground" data-mcp-plugin-undeclared>{{ t("settings.mcpPluginUndeclaredCount", { count: pluginMcpUndeclaredTools(view.tools).length }) }}</span>
          <span v-if="pluginMcpEnabled(view) && pluginMcpPendingTools(view).length" class="mt-1 inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300" data-mcp-plugin-pending>
            <AlertTriangle class="size-3" />{{ t("settings.mcpPluginPendingTools", { count: pluginMcpPendingTools(view).length }) }}
          </span>
        </button>
        <Button v-if="pluginMcpEnabled(view) && pluginMcpPendingTools(view).length" variant="outline" size="sm" class="h-7 shrink-0 text-xs" :disabled="disabled || savingPluginIds.has(view.pluginId)" data-mcp-plugin-review @click="openAuthorize(view, $event.currentTarget as HTMLElement)">
          {{ t("settings.mcpPluginReview") }}
        </Button>
        <Switch class="mt-0.5 shrink-0" :model-value="pluginMcpEnabled(view)" :disabled="disabled || !view.authorAllowsExternal || savingPluginIds.has(view.pluginId)" :aria-label="view.pluginName" @update:model-value="onPluginSwitch(view, $event === true)" />
      </li>
    </ul>
    <p v-else-if="!inline && !listHidden && plugins && plugins.length" class="px-3 py-4 text-center text-xs text-muted-foreground">{{ t("settings.mcpCapabilitiesSearchEmpty") }}</p>

    <!-- One shared detail view supports category navigation and search dialogs. -->
    <component :is="inline ? 'div' : Dialog" v-bind="inline ? {} : { open: !!detail }" @update:open="(open: boolean) => !open && (detailPluginId = null)">
      <component :is="inline ? 'div' : DialogContent" v-if="detail" :class="inline ? 'min-w-0 space-y-3' : 'max-h-[85vh] overflow-hidden sm:max-w-3xl'" :data-mcp-plugin-inline="inline ? detail.pluginId : undefined" data-mcp-plugin-detail @close-auto-focus="restoreDetailFocus">
        <component :is="inline ? 'header' : DialogHeader" class="min-w-0 space-y-2">
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <span class="mb-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Puzzle class="size-3.5" />{{ t("settings.mcpCapabilitiesFilterPlugin") }}</span>
              <component :is="inline ? 'h2' : DialogTitle" class="break-words text-base font-semibold [overflow-wrap:anywhere]">{{ detail.pluginName }}</component>
              <component :is="inline ? 'p' : DialogDescription" class="break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{{ t("settings.mcpPluginDetailDescription", { id: detail.pluginId, version: detail.version }) }}</component>
            </div>
            <Switch class="mt-1 shrink-0" :model-value="pluginMcpEnabled(detail)" :disabled="disabled || !detail.authorAllowsExternal || savingPluginIds.has(detail.pluginId)" :aria-label="detail.pluginName" data-mcp-plugin-master @update:model-value="onPluginSwitch(detail, $event === true)" />
          </div>
          <p class="text-xs text-muted-foreground" data-mcp-plugin-summary>{{ cardSummary(detail) }}</p>
          <p class="text-[11px] text-muted-foreground">{{ t("settings.mcpBrowser.pluginImmediate") }}</p>
          <p v-if="savingPluginIds.has(detail.pluginId)" role="status" class="flex items-center gap-1.5 text-xs text-muted-foreground" data-mcp-plugin-saving><Loader2 class="size-3.5 animate-spin" />{{ t("settings.mcpBrowser.pluginSaving") }}</p>
          <p v-else-if="savedPluginIds.has(detail.pluginId)" role="status" class="text-xs text-muted-foreground" data-mcp-plugin-saved>{{ t("settings.mcpBrowser.pluginSaved") }}</p>
          <div v-if="pluginMcpEnabled(detail) && pluginMcpPendingTools(detail).length" class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2" data-mcp-plugin-pending>
            <p class="text-xs text-amber-700 dark:text-amber-300">{{ t("settings.mcpPluginPendingTools", { count: pluginMcpPendingTools(detail).length }) }}</p>
            <Button variant="outline" size="sm" :disabled="disabled || savingPluginIds.has(detail.pluginId)" data-mcp-plugin-review @click="openAuthorize(detail, $event.currentTarget as HTMLElement)">{{ t("settings.mcpPluginReview") }}</Button>
          </div>
        </component>

        <div :class="inline ? 'min-w-0 space-y-3' : 'max-h-[62vh] space-y-3 overflow-y-auto'">
          <p v-if="saveErrors.get(detail.pluginId)" role="alert" class="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400" data-mcp-plugin-save-error>{{ saveErrors.get(detail.pluginId) }}</p>
          <p v-if="detail.discoveryError" class="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">{{ t("settings.mcpPluginDiscoveryError", { error: detail.discoveryError }) }}</p>

          <section class="space-y-1.5 rounded-md border p-3" data-mcp-plugin-ceiling>
            <p class="text-xs font-medium">{{ t("settings.mcpPluginCeilingTitle") }}</p>
            <p class="text-[11px] text-muted-foreground">{{ t("settings.mcpPluginCeilingDescription") }}</p>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="level in PLUGIN_MCP_ACCESS_LEVELS"
                :key="level"
                type="button"
                class="rounded border px-2.5 py-1 text-xs focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                :class="detail.grant.ceiling === level ? 'border-primary bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'"
                :aria-pressed="detail.grant.ceiling === level"
                :disabled="disabled || !pluginMcpEnabled(detail) || savingPluginIds.has(detail.pluginId)"
                :data-mcp-plugin-ceiling-level="level"
                @click="onCeilingChange(detail, level)"
              >
                {{ t(`settings.mcpPluginCeilingLevel.${level}`) }}
              </button>
            </div>
            <p v-if="!pluginMcpEnabled(detail)" class="text-[11px] text-muted-foreground">{{ t("settings.mcpPluginEnableFirst") }}</p>
          </section>

          <section v-for="group in detailGroups" :key="group.id" class="min-w-0 space-y-1.5">
            <div>
              <p class="break-words text-xs font-semibold [overflow-wrap:anywhere]">{{ toolsetTitle(group.title) }}</p>
              <p v-if="group.description" class="text-[11px] text-muted-foreground">{{ group.description }}</p>
            </div>
            <ul class="divide-y rounded-md border">
              <li v-for="tool in group.tools" :key="tool.name" :data-mcp-plugin-tool="tool.name">
                <div class="flex items-center gap-3 px-3 py-2">
                  <button type="button" class="flex min-w-0 flex-1 items-start gap-1.5 rounded-sm text-left focus-visible:ring-3 focus-visible:ring-ring/50" :aria-expanded="expandedToolNames.has(tool.name)" data-mcp-plugin-tool-toggle @click="toggleTool(tool.name)">
                    <ChevronDown v-if="expandedToolNames.has(tool.name)" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <ChevronRight v-else class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span class="min-w-0 flex-1">
                      <span class="flex flex-wrap items-center gap-2">
                        <span class="break-words font-mono text-xs font-medium [overflow-wrap:anywhere]">{{ tool.name }}</span>
                        <span v-if="tool.access" class="rounded border px-1.5 text-[10px] leading-4" :class="levelClass[tool.access]">{{ t(`settings.mcpAccessLevel.${tool.access}`) }}</span>
                        <span v-if="tool.exposure !== 'exposed'" class="text-[11px]" :class="tool.exposure === 'pendingApproval' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'">{{ exposureText(tool) }}</span>
                      </span>
                      <span v-if="tool.description" class="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">{{ tool.description }}</span>
                    </span>
                  </button>
                  <Switch
                    size="sm"
                    class="shrink-0"
                    :model-value="tool.access !== null && !detail.grant.disabledTools.includes(tool.name)"
                    :disabled="disabled || tool.access === null || !pluginMcpEnabled(detail) || savingPluginIds.has(detail.pluginId)"
                    :aria-label="tool.name"
                    @update:model-value="onToolSwitch(detail, tool, $event === true)"
                  />
                </div>
                <div v-if="expandedToolNames.has(tool.name)" class="space-y-2 border-t bg-muted/30 px-3 py-3 pl-8 text-xs" data-mcp-plugin-tool-detail>
                  <dl class="grid gap-x-4 gap-y-1.5 sm:grid-cols-[6rem_minmax(0,1fr)]">
                    <dt class="text-muted-foreground">{{ t("settings.mcpToolDetailId") }}</dt>
                    <dd class="break-words font-mono [overflow-wrap:anywhere]">{{ tool.name }}</dd>
                    <dt class="text-muted-foreground">{{ t("settings.mcpToolDetailAccess") }}</dt>
                    <dd>{{ tool.access ? t(`settings.mcpAccessLevel.${tool.access}`) : t("settings.mcpPluginAccessUndeclared") }}</dd>
                    <template v-if="tool.description">
                      <dt class="text-muted-foreground">{{ t("settings.mcpToolDetailDescription") }}</dt>
                      <dd class="whitespace-pre-wrap break-words text-muted-foreground">{{ tool.description }}</dd>
                    </template>
                  </dl>
                  <p class="font-medium">{{ t("settings.mcpToolDetailParameters") }}</p>
                  <p v-if="tool.parameters.length === 0" class="text-muted-foreground">{{ t("settings.mcpToolDetailNoParameters") }}</p>
                  <div v-else class="max-w-full overflow-x-auto rounded border bg-background">
                    <table class="w-full text-left text-[11px]">
                      <thead class="bg-muted/50 text-muted-foreground">
                        <tr>
                          <th class="px-2 py-1 font-medium">{{ t("settings.mcpToolDetailParameterName") }}</th>
                          <th class="px-2 py-1 font-medium">{{ t("settings.mcpToolDetailParameterType") }}</th>
                          <th class="px-2 py-1 font-medium">{{ t("settings.mcpToolDetailParameterRequired") }}</th>
                          <th class="px-2 py-1 font-medium">{{ t("settings.mcpToolDetailParameterDescription") }}</th>
                        </tr>
                      </thead>
                      <tbody class="divide-y">
                        <tr v-for="parameter in tool.parameters" :key="parameter.name" class="align-top">
                          <td class="whitespace-nowrap px-2 py-1 font-mono">{{ parameter.name }}</td>
                          <td class="px-2 py-1 font-mono text-muted-foreground">{{ parameter.valueType }}</td>
                          <td class="whitespace-nowrap px-2 py-1">{{ parameter.required ? t("settings.mcpToolDetailParameterRequiredYes") : t("settings.mcpToolDetailParameterRequiredNo") }}</td>
                          <td class="px-2 py-1 text-muted-foreground">
                            {{ parameter.description }}
                            <span v-if="parameter.default !== undefined" class="whitespace-nowrap">（{{ t("settings.mcpToolDetailParameterDefault", { value: parameterDefault(parameter.default) }) }}）</span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </li>
            </ul>
          </section>
          <p v-if="detail.tools.length === 0 && !detail.discoveryError" class="py-6 text-center text-xs text-muted-foreground">{{ t("settings.mcpPluginNoTools") }}</p>
          <p v-else-if="onlyEnabled && detail.tools.length && detailGroups.length === 0" class="py-6 text-center text-xs text-muted-foreground" data-mcp-plugin-filter-empty>{{ t("settings.mcpBrowser.pluginOnlyEnabledEmpty") }}</p>
        </div>
        <div v-if="!inline" class="flex justify-end">
          <Button variant="outline" size="sm" @click="detailPluginId = null">{{ t("settings.mcpToolsetDetailClose") }}</Button>
        </div>
      </component>
    </component>

    <!-- Authorization: first enable, re-enable, or confirming new tools. -->
    <Dialog :open="!!authorizing" @update:open="closeAuthorize">
      <DialogContent v-if="authorizing" class="max-h-[85vh] overflow-hidden sm:max-w-xl" data-mcp-plugin-authorize @close-auto-focus="restoreAuthorizeFocus">
        <DialogHeader>
          <DialogTitle>{{ t("settings.mcpPluginAuthorizeTitle", { name: authorizing.pluginName }) }}</DialogTitle>
          <DialogDescription>{{ t("settings.mcpPluginAuthorizeDescription") }}</DialogDescription>
        </DialogHeader>
        <div class="max-h-[55vh] space-y-3 overflow-y-auto text-xs">
          <p v-if="saveErrors.get(authorizing.pluginId)" role="alert" class="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400" data-mcp-plugin-authorize-error>{{ saveErrors.get(authorizing.pluginId) }}</p>
          <p v-if="authorizing.discoveryError" class="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-800 dark:text-amber-200">{{ t("settings.mcpPluginDiscoveryError", { error: authorizing.discoveryError }) }}</p>
          <section class="space-y-1.5">
            <p class="font-medium">{{ t("settings.mcpPluginCeilingTitle") }}</p>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="level in PLUGIN_MCP_ACCESS_LEVELS"
                :key="level"
                type="button"
                class="rounded border px-2.5 py-1 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                :class="authorizeCeiling === level ? 'border-primary bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'"
                :aria-pressed="authorizeCeiling === level"
                :disabled="disabled || savingPluginIds.has(authorizing.pluginId)"
                :data-mcp-plugin-authorize-level="level"
                @click="authorizeCeiling = level"
              >
                {{ t(`settings.mcpPluginCeilingLevel.${level}`) }}
              </button>
            </div>
          </section>
          <section class="space-y-1.5">
            <p class="font-medium">{{ t("settings.mcpPluginAuthorizeTools", { count: pluginMcpDeclaredTools(authorizing.tools).length }) }}</p>
            <ul class="divide-y rounded-md border">
              <li v-for="tool in pluginMcpDeclaredTools(authorizing.tools)" :key="tool.name" class="flex items-center gap-2 px-3 py-1.5" :data-mcp-plugin-authorize-tool="tool.name">
                <span class="min-w-0 flex-1 truncate font-mono">{{ tool.name }}</span>
                <span v-if="tool.exposure === 'pendingApproval'" class="text-[11px] text-amber-700 dark:text-amber-300">{{ t("settings.mcpPluginExposure.pendingApproval") }}</span>
                <span class="rounded border px-1.5 text-[10px] leading-4" :class="levelClass[tool.access]">{{ t(`settings.mcpAccessLevel.${tool.access}`) }}</span>
                <span class="w-16 text-right text-[11px]" :class="pluginMcpLevelAtMost(tool.access, authorizeCeiling) ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'">
                  {{ pluginMcpLevelAtMost(tool.access, authorizeCeiling) ? t("settings.mcpPluginAuthorizeIncluded") : t("settings.mcpPluginAuthorizeExcluded") }}
                </span>
              </li>
            </ul>
          </section>
          <p v-if="pluginMcpUndeclaredTools(authorizing.tools).length" class="rounded-md border border-dashed px-3 py-2 text-[11px] text-muted-foreground" data-mcp-plugin-authorize-undeclared>
            {{
              t("settings.mcpPluginUndeclaredTools", {
                count: pluginMcpUndeclaredTools(authorizing.tools).length,
                names: pluginMcpUndeclaredTools(authorizing.tools)
                  .map((tool) => tool.name)
                  .join(", "),
              })
            }}
          </p>
          <p class="text-[11px] text-muted-foreground">{{ t("settings.mcpPluginAuthorizeFootnote") }}</p>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="outline" size="sm" :disabled="savingPluginIds.has(authorizing.pluginId)" @click="closeAuthorize(false)">{{ t("settings.mcpPluginAuthorizeCancel") }}</Button>
          <Button size="sm" :disabled="disabled || !authorizing.authorAllowsExternal || savingPluginIds.has(authorizing.pluginId)" data-mcp-plugin-authorize-confirm @click="confirmAuthorize">
            <Loader2 v-if="savingPluginIds.has(authorizing.pluginId)" class="mr-1.5 size-3.5 animate-spin" />
            {{ t("settings.mcpPluginAuthorizeConfirm") }}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </section>
</template>
