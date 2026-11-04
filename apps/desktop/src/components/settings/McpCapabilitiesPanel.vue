<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronRight, Loader2, Minus, Search } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { McpAccessLevel, McpToolCatalog, McpToolCatalogTool, McpToolCatalogToolset } from "@/types/mcpCatalog";
import { mcpToolsetTitle } from "@/lib/mcp/mcpCapabilitySearch";
import {
  groupMcpDatabaseTypesByCategory,
  mcpCoverageByCategory,
  mcpDatabaseTypeLabel,
  mcpToolAllowed,
  mcpToolLabelKey,
  mcpToolsetAccessLevels,
  mcpToolsetHasCoverage,
  mcpToolsetMessageKey,
  mcpToolsetScopeKinds,
  mcpToolsetState,
  summarizeMcpToolsetCoverage,
  type McpCoverageConnection,
} from "@/lib/mcp/mcpToolCatalog";

/**
 * MCP capability tab: built-in toolsets as cards, each with its applicable
 * database coverage. Toolset and tool switches only edit the flat
 * `allowedToolNames` allowlist owned by the settings dialog.
 */
const props = withDefaults(
  defineProps<{
    catalog: McpToolCatalog | null;
    loading?: boolean;
    loadError?: string;
    allowedToolNames: readonly string[] | null;
    savedToolNames?: readonly string[] | null;
    saveToolset?: (toolsetId: string) => Promise<void>;
    connections: readonly McpCoverageConnection[];
    disabled?: boolean;
    filterKind?: "all" | "builtin" | "plugin";
    onlyEnabled?: boolean;
    visibleToolsetIds?: readonly string[];
    titlePath?: string;
    listHidden?: boolean;
    focusFallback?: () => void;
  }>(),
  { loading: false, loadError: "", disabled: false, filterKind: "all", onlyEnabled: false },
);

const emit = defineEmits<{
  "set:toolset": [toolset: McpToolCatalogToolset, enabled: boolean];
  "set:tool": [toolName: string, enabled: boolean];
  retry: [];
}>();

const { t } = useI18n();
const detailToolsetId = ref<string | null>(null);
const detailTitlePath = ref("");
const detailView = ref<"tools" | "coverage">("tools");
const coverageSearch = ref("");
const expandedToolNames = ref(new Set<string>());
const detailSaving = ref(false);
const detailSaveError = ref("");
let detailTrigger: HTMLElement | null = null;

const userConnectionTypes = computed(() => new Set(props.connections.map((connection) => connection.dbType)));

function toolLabel(tool: McpToolCatalogTool): string {
  const key = mcpToolLabelKey(tool.name);
  return key ? t(key) : tool.name;
}

// Keep the complete view model separate from navigation filters. An open detail
// must survive category changes and switching off its final enabled tool.
const allCards = computed(() =>
  (props.catalog?.toolsets ?? []).map((toolset) => ({
    toolset,
    title: mcpToolsetTitle(toolset.id, t),
    description: toolsetDescription(toolset.id),
    scopeKinds: mcpToolsetScopeKinds(toolset),
    state: mcpToolsetState(props.allowedToolNames, toolset),
    enabledCount: toolset.tools.filter((tool) => mcpToolAllowed(props.allowedToolNames, tool.name)).length,
    levels: mcpToolsetAccessLevels(toolset),
    hasCoverage: mcpToolsetHasCoverage(toolset),
    coverage: summarizeMcpToolsetCoverage(toolset, props.connections),
  })),
);

const cards = computed(() =>
  allCards.value
    .filter(({ toolset }) => props.visibleToolsetIds === undefined || props.visibleToolsetIds.includes(toolset.id))
    .filter(() => props.filterKind !== "plugin")
    .filter(({ state }) => !props.onlyEnabled || state !== "off"),
);

function toolsetDescription(id: string) {
  const key = mcpToolsetMessageKey(id, "description");
  const text = t(key);
  return text === key ? "" : text;
}

const detail = computed(() => allCards.value.find((card) => card.toolset.id === detailToolsetId.value) ?? null);
const detailChangedCount = computed(() => detail.value?.toolset.tools.filter((tool) => mcpToolAllowed(props.allowedToolNames, tool.name) !== mcpToolAllowed(props.savedToolNames ?? null, tool.name)).length ?? 0);

async function applyDetail() {
  if (!detail.value || !props.saveToolset || props.disabled || detailSaving.value || !detailChangedCount.value) return;
  detailSaving.value = true;
  detailSaveError.value = "";
  try {
    await props.saveToolset(detail.value.toolset.id);
  } catch (error) {
    detailSaveError.value = error instanceof Error ? error.message : String(error);
  } finally {
    detailSaving.value = false;
  }
}
const detailCoverageRows = computed(() => {
  if (!detail.value) return [];
  const rows = mcpCoverageByCategory(detail.value.toolset);
  const needle = coverageSearch.value.trim().toLowerCase();
  if (!needle) return rows;
  return rows
    .map((row) => {
      const types = row.types.filter((type) => mcpDatabaseTypeLabel(type).toLowerCase().includes(needle) || type.includes(needle));
      return { ...row, types, tools: row.tools.map((entry) => ({ ...entry, supported: new Set(types.filter((type) => entry.supported.has(type))) })) };
    })
    .filter((row) => row.types.length > 0);
});

function openDetail(toolsetId: string, view: "tools" | "coverage" = "tools", toolName?: string, trigger?: EventTarget | null) {
  if (detailSaving.value) return;
  const card = allCards.value.find((entry) => entry.toolset.id === toolsetId);
  if (!card) return;
  const source = trigger ?? (typeof document === "undefined" ? null : document.activeElement);
  detailTrigger = source && "focus" in source && typeof source.focus === "function" ? (source as HTMLElement) : null;
  detailTitlePath.value = props.titlePath ?? "";
  detailToolsetId.value = toolsetId;
  detailSaveError.value = "";
  detailView.value = view === "coverage" && !card.hasCoverage ? "tools" : view;
  coverageSearch.value = "";
  expandedToolNames.value = new Set(card.toolset.tools.some((tool) => tool.name === toolName) ? [toolName!] : []);
  if (toolName)
    void nextTick(() => {
      if (typeof document === "undefined") return;
      const rows = document.querySelectorAll<HTMLElement>("[data-mcp-toolset-detail] [data-mcp-tool]");
      const row = [...rows].find((element) => element.dataset.mcpTool === toolName);
      row?.scrollIntoView?.({ block: "nearest" });
      row?.querySelector<HTMLButtonElement>("[data-mcp-tool-toggle]")?.focus();
    });
}

defineExpose({ openDetail });

function toggleToolExpanded(name: string) {
  const next = new Set(expandedToolNames.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  expandedToolNames.value = next;
}

/** Your connections this tool cannot run on, although its toolset reaches them. */
function toolSkippedConnections(tool: McpToolCatalogTool) {
  return detail.value?.coverage.partialConnections.filter((entry) => entry.unsupportedTools.some((unsupported) => unsupported.name === tool.name)).map((entry) => entry.connection) ?? [];
}

function toolCoverageGroups(tool: McpToolCatalogTool) {
  return groupMcpDatabaseTypesByCategory(tool.databaseTypes);
}

function parameterDefault(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function closeDetail(open: boolean) {
  if (open || detailSaving.value) return;
  detailToolsetId.value = null;
  void nextTick(restoreDetailFocus);
}

function restoreDetailFocus(event?: Event) {
  // Search results may be DOM elements outside this panel. A vanished trigger
  // cannot receive focus, so leave the enclosing dialog's focus handling intact.
  if (detailTrigger && detailTrigger.isConnected !== false) {
    event?.preventDefault();
    detailTrigger.focus({ preventScroll: true });
  } else if (props.focusFallback) {
    event?.preventDefault();
    props.focusFallback();
  }
}

function scopeLabel(kind: string): string {
  const knownKinds = ["database", "dbIndex", "topic", "queue", "org", "namespace"];
  return knownKinds.includes(kind) ? t(`settings.mcpBrowser.resourceKind.${kind}`) : kind;
}

const levelClass: Record<McpAccessLevel, string> = {
  read: "border-border text-muted-foreground",
  write: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  full: "border-red-500/40 text-red-600 dark:text-red-400",
};

function coverageSummaryText(card: (typeof cards.value)[number]): string {
  const { coverage } = card;
  if (!card.hasCoverage) return t("settings.mcpCoverageNotBound");
  if (!coverage.usableConnections.length) return t("settings.mcpBrowser.noMatchingConnections");
  const parts = [t("settings.mcpBrowser.coverageConnections", { count: coverage.usableConnections.length })];
  if (coverage.partialConnections.length) parts.push(t("settings.mcpBrowser.coveragePartialConnections", { count: coverage.partialConnections.length }));
  return parts.join(" · ");
}

function toolCoverageText(tool: McpToolCatalogTool): string {
  if (tool.coverageKind === "none") return t("settings.mcpCoverageNotBound");
  return t("settings.mcpCoverageTypes", { count: tool.databaseTypes.length });
}

/** Tools that reach only some of a row's types; tools that reach none are omitted. */
function partialTools(row: (typeof detailCoverageRows.value)[number]) {
  return row.tools.filter((entry) => entry.supported.size > 0 && entry.supported.size < row.types.length);
}
</script>

<template>
  <div class="space-y-4" data-mcp-capabilities>
    <div v-if="!listHidden" data-mcp-capability-list>
      <div v-if="loadError" class="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400" role="alert">
        <p>{{ t("settings.mcpCapabilitiesLoadFailed", { error: loadError }) }}</p>
        <Button variant="outline" size="sm" :disabled="loading" data-mcp-catalog-retry @click="emit('retry')">{{ t("settings.mcpBrowser.retry") }}</Button>
      </div>
      <div v-else-if="loading && !catalog" class="flex items-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 class="size-3.5 animate-spin" />{{ t("settings.mcpCapabilitiesLoading") }}</div>

      <template v-else-if="catalog">
        <ul class="divide-y rounded-md border">
          <li v-for="card in cards" :key="card.toolset.id" class="flex items-start gap-3 px-3 py-3" :data-mcp-toolset="card.toolset.id">
            <div class="min-w-0 flex-1">
              <button type="button" class="w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]" data-mcp-toolset-open @click="openDetail(card.toolset.id, 'tools', undefined, $event.currentTarget)">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span class="text-sm font-medium">{{ card.title }}</span>
                  <span class="text-xs text-muted-foreground">{{ t("settings.mcpBrowser.enabledToolCount", { enabled: card.enabledCount, total: card.toolset.tools.length }) }}</span>
                  <span v-if="card.state === 'partial'" class="rounded border border-amber-500/40 px-1.5 text-[11px] text-amber-700 dark:text-amber-300" data-mcp-toolset-partial>{{ t("settings.mcpBrowser.partialEnabled") }}</span>
                  <span v-for="level in card.levels" :key="level" class="rounded border px-1.5 text-[10px] leading-4" :class="levelClass[level]">{{ t(`settings.mcpAccessLevel.${level}`) }}</span>
                </div>
                <p class="mt-0.5 text-xs text-muted-foreground">{{ card.description }}</p>
              </button>
              <button
                v-if="card.hasCoverage"
                type="button"
                class="mt-1 inline-flex items-center gap-0.5 rounded-sm text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-mcp-coverage-link
                @click="openDetail(card.toolset.id, 'coverage', undefined, $event.currentTarget)"
              >
                {{ coverageSummaryText(card) }}<ChevronRight class="size-3" />
              </button>
              <p v-else class="mt-1 text-xs text-muted-foreground">{{ coverageSummaryText(card) }}</p>
            </div>
            <Switch class="mt-0.5 shrink-0" :model-value="card.state !== 'off'" :disabled="disabled" :aria-label="card.title" @update:model-value="emit('set:toolset', card.toolset, $event === true)" />
          </li>
          <li v-if="cards.length === 0" class="px-3 py-6 text-center text-xs text-muted-foreground">{{ t(onlyEnabled ? "settings.mcpBrowser.emptyEnabled" : "settings.mcpCapabilitiesSearchEmpty") }}</li>
        </ul>
      </template>
    </div>

    <Dialog :open="!!detail" @update:open="closeDetail">
      <DialogContent
        v-if="detail"
        class="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl"
        :show-close-button="!detailSaving"
        data-mcp-toolset-detail
        @close-auto-focus="restoreDetailFocus"
        @escape-key-down="detailSaving && $event.preventDefault()"
        @interact-outside="detailSaving && $event.preventDefault()"
      >
        <DialogHeader class="shrink-0">
          <DialogTitle>{{ detailTitlePath ? `${detailTitlePath} / ${detail.title}` : detail.title }}</DialogTitle>
          <DialogDescription>{{ detail.description }}</DialogDescription>
        </DialogHeader>
        <p v-if="detail.scopeKinds.length" class="shrink-0 text-xs text-muted-foreground" data-mcp-scope-kinds>{{ t("settings.mcpBrowser.resourceScopes") }}：{{ detail.scopeKinds.map(scopeLabel).join(" / ") }}</p>

        <div class="flex shrink-0 gap-1 border-b">
          <button type="button" class="-mb-px border-b-2 px-3 py-1.5 text-xs font-medium" :class="detailView === 'tools' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'" @click="detailView = 'tools'">{{ t("settings.mcpToolsetDetailTools") }}</button>
          <button v-if="detail.hasCoverage" type="button" class="-mb-px border-b-2 px-3 py-1.5 text-xs font-medium" :class="detailView === 'coverage' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'" @click="detailView = 'coverage'">
            {{ t("settings.mcpToolsetDetailCoverage") }}
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto" data-mcp-toolset-scroll>
          <ul v-if="detailView === 'tools'" class="divide-y rounded-md border">
            <li v-for="tool in detail.toolset.tools" :key="tool.name" :data-mcp-tool="tool.name">
              <div class="flex items-center gap-3 px-3 py-2">
                <button type="button" class="flex min-w-0 flex-1 items-start gap-1.5 text-left" :aria-expanded="expandedToolNames.has(tool.name)" data-mcp-tool-toggle @click="toggleToolExpanded(tool.name)">
                  <ChevronDown v-if="expandedToolNames.has(tool.name)" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <ChevronRight v-else class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 flex-1">
                    <span class="flex flex-wrap items-center gap-2">
                      <span class="text-xs font-medium">{{ toolLabel(tool) }}</span>
                      <span class="rounded border px-1.5 text-[10px] leading-4" :class="levelClass[tool.accessMode === 'classified' ? 'full' : tool.access]">{{ tool.accessMode === "classified" ? t("settings.mcpAccessLevelClassified") : t(`settings.mcpAccessLevel.${tool.access}`) }}</span>
                    </span>
                    <span class="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                      <span class="font-mono">{{ tool.name }}</span>
                      <span>{{ toolCoverageText(tool) }}</span>
                      <span v-if="toolSkippedConnections(tool).length" class="text-amber-700 dark:text-amber-300">{{ t("settings.mcpToolSkippedConnections", { count: toolSkippedConnections(tool).length }) }}</span>
                    </span>
                  </span>
                </button>
                <Switch size="sm" class="shrink-0" :model-value="mcpToolAllowed(allowedToolNames, tool.name)" :disabled="disabled || detailSaving" :aria-label="toolLabel(tool)" @update:model-value="emit('set:tool', tool.name, $event === true)" />
              </div>

              <div v-if="expandedToolNames.has(tool.name)" class="space-y-3 border-t bg-muted/30 px-3 py-3 pl-8 text-xs" data-mcp-tool-detail>
                <dl class="grid gap-x-4 gap-y-1.5 sm:grid-cols-[6rem_minmax(0,1fr)]">
                  <dt class="text-muted-foreground">{{ t("settings.mcpToolDetailId") }}</dt>
                  <dd class="font-mono">{{ tool.name }}</dd>
                  <dt class="text-muted-foreground">{{ t("settings.mcpToolDetailSummary") }}</dt>
                  <dd>{{ toolLabel(tool) }}</dd>
                  <dt class="text-muted-foreground">{{ t("settings.mcpToolDetailAccess") }}</dt>
                  <dd>{{ tool.accessMode === "classified" ? t("settings.mcpToolDetailAccessClassified") : t(`settings.mcpAccessLevel.${tool.access}`) }}</dd>
                  <template v-if="tool.description">
                    <dt class="text-muted-foreground">{{ t("settings.mcpToolDetailDescription") }}</dt>
                    <dd class="whitespace-pre-wrap break-words text-muted-foreground">{{ tool.description }}</dd>
                  </template>
                </dl>

                <section class="space-y-1.5">
                  <p class="font-medium">{{ t("settings.mcpToolDetailParameters") }}</p>
                  <p v-if="tool.parameters.length === 0" class="text-muted-foreground">{{ t("settings.mcpToolDetailNoParameters") }}</p>
                  <div v-else class="overflow-x-auto rounded border bg-background">
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
                          <td class="whitespace-nowrap px-2 py-1">
                            <span v-if="parameter.required" class="text-foreground">{{ t("settings.mcpToolDetailParameterRequiredYes") }}</span>
                            <span v-else class="text-muted-foreground">{{ t("settings.mcpToolDetailParameterRequiredNo") }}</span>
                          </td>
                          <td class="px-2 py-1 text-muted-foreground">
                            {{ parameter.description }}
                            <span v-if="parameter.default !== undefined" class="whitespace-nowrap">（{{ t("settings.mcpToolDetailParameterDefault", { value: parameterDefault(parameter.default) }) }}）</span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </section>

                <section v-if="tool.coverageKind !== 'none'" class="space-y-1.5" data-mcp-tool-coverage>
                  <p class="font-medium">{{ t("settings.mcpToolDetailCoverage", { count: tool.databaseTypes.length }) }}</p>
                  <div v-for="group in toolCoverageGroups(tool)" :key="group.category" class="flex flex-wrap items-baseline gap-1.5">
                    <span class="w-full text-[11px] text-muted-foreground sm:w-24 sm:shrink-0">{{ t(group.titleKey) }}</span>
                    <span v-for="type in group.types" :key="type" class="rounded border px-1.5 text-[11px] leading-5" :class="userConnectionTypes.has(type) ? 'border-primary/50 bg-primary/5' : 'bg-background'">{{ mcpDatabaseTypeLabel(type) }}</span>
                  </div>
                  <p v-if="toolSkippedConnections(tool).length" class="text-[11px] text-amber-700 dark:text-amber-300">
                    {{
                      t("settings.mcpToolDetailSkippedConnections", {
                        names: toolSkippedConnections(tool)
                          .map((connection) => connection.name)
                          .join("、"),
                      })
                    }}
                  </p>
                </section>
                <p v-else class="text-muted-foreground">{{ t("settings.mcpCoverageNotBound") }}</p>
              </div>
            </li>
          </ul>

          <div v-else class="space-y-3" data-mcp-coverage-detail>
            <div class="relative">
              <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="coverageSearch" class="h-8 pl-8 text-xs" :placeholder="t('settings.mcpCoverageSearchPlaceholder')" />
            </div>
            <p class="text-[11px] text-muted-foreground">{{ t("settings.mcpCoverageLegend") }}</p>
            <section v-for="row in detailCoverageRows" :key="row.category" class="space-y-2 rounded-md border p-3">
              <p class="text-xs font-semibold">
                {{ t(row.titleKey) }} <span class="font-normal text-muted-foreground">({{ row.types.length }})</span>
              </p>
              <div class="flex flex-wrap gap-1.5">
                <Badge
                  v-for="type in row.types"
                  :key="type"
                  variant="outline"
                  class="gap-1 text-[11px] font-normal"
                  :class="userConnectionTypes.has(type) ? 'border-primary/50 bg-primary/5' : ''"
                  :title="
                    row.tools
                      .filter((entry) => !entry.supported.has(type))
                      .map((entry) => t('settings.mcpCoverageTypeUnsupportedTool', { tool: toolLabel(entry.tool) }))
                      .join('\n') || undefined
                  "
                >
                  {{ mcpDatabaseTypeLabel(type) }}
                  <span v-if="row.tools.some((entry) => !entry.supported.has(type))" class="text-amber-600">*</span>
                </Badge>
              </div>
              <p v-for="entry in partialTools(row)" :key="entry.tool.name" class="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Minus class="size-3 text-amber-600" />
                {{ t("settings.mcpCoveragePartialTool", { tool: toolLabel(entry.tool), count: entry.supported.size, total: row.types.length }) }}
              </p>
            </section>
            <p v-if="detailCoverageRows.length === 0" class="py-6 text-center text-xs text-muted-foreground">{{ t("settings.mcpCoverageSearchEmpty") }}</p>
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t pt-3" data-mcp-toolset-footer :aria-busy="detailSaving">
          <div v-if="saveToolset" class="min-w-0 flex-1 basis-52 space-y-1 text-xs text-muted-foreground">
            <p role="status" aria-live="polite" data-mcp-toolset-save-status>{{ detailSaving ? t("settings.mcpToolsetApplying") : detailChangedCount ? t("settings.mcpToolsetPending", { count: detailChangedCount }) : t("settings.mcpToolsetApplied") }}</p>
            <p v-if="detailChangedCount">{{ t("settings.mcpToolsetCloseKeepsDraft") }}</p>
            <p v-if="detailSaveError" role="alert" class="break-words text-destructive" data-mcp-toolset-save-error>{{ t("settings.mcpToolsetApplyFailed", { error: detailSaveError }) }}</p>
          </div>
          <div class="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" :disabled="detailSaving" data-mcp-toolset-close @click="closeDetail(false)">{{ t("settings.mcpToolsetDetailClose") }}</Button>
            <Button v-if="saveToolset" size="sm" :disabled="disabled || detailSaving || !detailChangedCount" data-mcp-toolset-apply @click="applyDetail">
              <Loader2 v-if="detailSaving" class="mr-1 size-3.5 animate-spin" />
              {{ t(detailSaving ? "settings.mcpToolsetApplying" : "settings.mcpToolsetApply") }}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
