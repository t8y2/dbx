<script setup lang="ts">
// PR-A4/P2 global bottom panel dock (HOST_PLUGIN_UI_SPEC §8.3) — a generic host container:
// it only provides the panel frame (tab strip, drag-resize height, collapse/maximize/hide) and hosts any plugin's
// panel webviews, with zero plugin business inside; multi-terminal/shell selection/connection switching all live in the plugin
// the plugin's own panel page via the bridge openWorkbench, which adds another dock entry).
// Each entry owns a host-stable workbenchId; v-show keeps sessions alive while switching tabs.
import { computed, nextTick, onScopeDispose, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronUp, Maximize2, Minimize2, Plus, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import PluginIcon from "@/components/plugins/PluginIcon.vue";
import PluginWorkbenchHost from "@/components/plugins/PluginWorkbenchHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import {
  activatePluginDockEntry,
  addPluginDockEntry,
  closePluginDockEntry,
  DOCK_MAX_VIEWPORT_RATIO,
  DOCK_MIN_HEIGHT_PX,
  movePluginDockEntry,
  persistDockHeight,
  renamePluginDockEntry,
  restoreDockHeight,
  setDockMaximized,
  setDockVisible,
  usePluginBottomDock,
  type PluginDockEntry,
} from "@/lib/plugins/pluginBottomDock";
import { useDockResize } from "@/composables/useDockResize";
import { executePluginCommand } from "@/lib/plugins/pluginCommandRegistry";
import { createFrontendPluginRegistry } from "@/lib/plugins/frontendPlugin";
import { useQueryStore } from "@/stores/queryStore";
import * as api from "@/lib/backend/api";
import type { InstalledPlugin, PluginWorkbenchContribution } from "@/types/database";

const { t } = useI18n();
// Tab strip interactions (drag reorder + double-click rename).
const dragEntryId = ref<string | null>(null);
const renamingEntryId = ref<string | null>(null);
const renameDraft = ref("");
const renameInput = ref<HTMLInputElement | null>(null);
function setRenameInputRef(element: unknown) {
  renameInput.value = element as HTMLInputElement | null;
}
watch(renamingEntryId, async (id) => {
  if (!id) return;
  await nextTick();
  renameInput.value?.select();
});
function startRename(entry: PluginDockEntry) {
  renamingEntryId.value = entry.id;
  renameDraft.value = entry.title;
}
function commitRename() {
  if (!renamingEntryId.value) return;
  renamePluginDockEntry(renamingEntryId.value, renameDraft.value);
  renamingEntryId.value = null;
}
function cancelRename() {
  renamingEntryId.value = null;
}
function onTabDragStart(entry: PluginDockEntry, event: DragEvent) {
  dragEntryId.value = entry.id;
  if (event.dataTransfer) {
    event.dataTransfer.setData("text/plain", entry.id);
    event.dataTransfer.effectAllowed = "move";
  }
}
// Live reorder while hovering the target tab: the dragged entry jumps to the
// target's slot immediately, which keeps the gesture simple and predictable.
function onTabDragOver(entry: PluginDockEntry) {
  if (!dragEntryId.value || dragEntryId.value === entry.id) return;
  const toIndex = entries.value.findIndex((candidate) => candidate.id === entry.id);
  if (toIndex < 0) return;
  movePluginDockEntry(dragEntryId.value, toIndex);
}
function onTabDragEnd() {
  dragEntryId.value = null;
}
const queryStore = useQueryStore();
const { entries, activeEntryId, visible, maximized } = usePluginBottomDock();
const collapsed = ref(false);
// The dragged height persists as UI chrome (§8.4 is untouched: dock entries
// themselves are never restored across restarts).
const dockHeight = ref(restoreDockHeight(window.innerHeight));
watch(dockHeight, (height) => persistDockHeight(height));
const plugins = ref<InstalledPlugin[]>([]);

const activeEntry = computed(() => entries.value.find((entry) => entry.id === activeEntryId.value) ?? null);
const activeCommand = computed(() => {
  const entry = activeEntry.value;
  // Connection entries carry their source commandId too, so the "+" picker
  // (replay / launch options / connection targets) is available on every panel.
  if (!entry || !entry.commandId) return null;
  return createFrontendPluginRegistry(plugins.value).findCommand(entry.pluginId, entry.commandId)?.contribution ?? null;
});

watch(entries, () => void loadPluginData(), { deep: true, immediate: true });
watch([activeEntry, activeCommand], () => void loadLaunchOptions());
const onPluginsChanged = () => void loadPluginData();
window.addEventListener("dbx:plugins-changed", onPluginsChanged);
onScopeDispose(() => window.removeEventListener("dbx:plugins-changed", onPluginsChanged));

async function loadPluginData() {
  if (!entries.value.length) {
    plugins.value = [];
    return;
  }
  try {
    plugins.value = await api.listPlugins();
  } catch {
    plugins.value = [];
  }
}

function definitionFor(pluginId: string): InstalledPlugin | undefined {
  return plugins.value.find((candidate) => candidate.manifest.id === pluginId);
}

// A live entry can outlive its contribution (plugin upgrade/downgrade changed
// the workbench id, or dropped the contribution entirely). The host renders
// props.contribution.label unconditionally, so return null and let the v-if
// degrade the panel to an empty frame instead of crashing — same degradation
// as the missing-plugin case; the tab (and its close button) stays available.
function workbenchContributionFor(entry: PluginDockEntry): PluginWorkbenchContribution | null {
  const definition = definitionFor(entry.pluginId);
  if (!definition) return null;
  return (definition.manifest.contributions || []).find((candidate): candidate is PluginWorkbenchContribution => candidate.type === "workbench" && candidate.id === entry.workbenchContributionId) ?? null;
}

// Generic "+" picker (extension-point driven, zero business in the host):
// - the command itself (replay),
// - dynamic entries from the declared sidecar options_action (e.g. shell types),
// - when connection_targets is on, the plugin's own saved connections.
const connectionStore = useConnectionStore();
const launchOptionEntries = ref<Array<{ key: string; label: string; description?: string; context?: Record<string, unknown> }>>([]);
const launchOptionsLoading = ref(false);

const activeAction = computed(() => (activeCommand.value?.action.type === "open-workbench" ? activeCommand.value.action : null));
const activePluginProviders = computed(() => {
  const pluginId = activeEntry.value?.pluginId;
  const plugin = pluginId ? definitionFor(pluginId) : undefined;
  return new Set((plugin?.manifest.contributions || []).filter((candidate) => candidate.type === "connection-provider").map((candidate) => candidate.id));
});

async function loadLaunchOptions() {
  const action = activeAction.value;
  const pluginId = activeEntry.value?.pluginId;
  launchOptionEntries.value = [];
  if (!action || !pluginId || !action.options_action) return;
  launchOptionsLoading.value = true;
  try {
    const result = await api.invokePlugin<{ entries?: Array<{ label: string; description?: string; context?: Record<string, unknown> }> }>(pluginId, action.options_action, {});
    launchOptionEntries.value = (result?.entries ?? []).map((entry, index) => ({ key: `opt:${index}`, label: entry.label, description: entry.description, context: entry.context }));
  } catch (cause) {
    console.warn("[DBX][plugin:dock] launch options unavailable", cause);
    launchOptionEntries.value = [];
  } finally {
    launchOptionsLoading.value = false;
  }
}

const connectionTargets = computed(() => {
  if (!activeAction.value?.connection_targets) return [];
  const providers = activePluginProviders.value;
  return connectionStore.connections.filter((connection) => providers.has(connection.plugin_connection_provider ?? "")).map((connection) => ({ key: `conn:${connection.id}`, label: connection.name || connection.id, connection }));
});

function onPlusAction(value: string) {
  if (value === "replay") {
    rerunActiveCommand();
    return;
  }
  if (value.startsWith("opt:")) {
    const index = Number(value.slice(4));
    const option = launchOptionEntries.value[index];
    if (!option) return;
    const entry = activeEntry.value;
    const command = activeCommand.value;
    if (!entry || !command) return;
    const id = addPluginDockEntry({
      pluginId: entry.pluginId,
      workbenchContributionId: entry.workbenchContributionId,
      kind: "command",
      commandId: command.id,
      title: option.label,
      icon: command.icon,
      commandContext: option.context ?? {},
    });
    activatePluginDockEntry(id);
    return;
  }
  if (value.startsWith("conn:")) {
    const connectionId = value.slice("conn:".length);
    const target = connectionTargets.value.find((candidate) => candidate.key === `conn:${connectionId}`);
    const connection = target?.connection;
    const entry = activeEntry.value;
    const command = activeCommand.value;
    if (!connection || !entry || !command) return;
    const id = addPluginDockEntry({
      pluginId: entry.pluginId,
      workbenchContributionId: entry.workbenchContributionId,
      kind: "connection",
      commandId: command.id,
      title: connection.name || connection.id,
      icon: activeCommand.value?.icon,
      commandContext: {
        connectionId: connection.id,
        providerId: connection.plugin_connection_provider,
        connectionType: connection.plugin_connection_type,
        // §8.3 面板加载生命周期：标记宿主已在点击时预拨号，插件面板就绪后
        // 跳过 force 重开、直接开会话。
        connectionPreconnected: true,
        connection: {
          id: connection.id,
          name: connection.name,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          readOnly: connection.read_only === true,
        },
      },
    });
    // 点击即拨号：SSH 握手与面板 webview 引导（数秒）并行，面板就绪即会话就绪。
    // 无 force：同连接已有存活会话时这是健康检查级 no-op，不会打断它。
    void useConnectionStore()
      .ensureConnected(connection.id, { activate: false })
      .catch(() => undefined);
    activatePluginDockEntry(id);
  }
}

function rerunActiveCommand() {
  const entry = activeEntry.value;
  const command = activeCommand.value;
  if (!entry || !command) return;
  const result = executePluginCommand(createFrontendPluginRegistry(plugins.value), queryStore, entry.pluginId, command.id);
  if (result.error) console.warn("[DBX][plugin:dock]", result.error);
}

// A dock-hosted webview asking for another panel via the bridge openWorkbench: the host rebuilds the authoritative
// context (dropping plugin-supplied reserved fields) and adds one generic panel entry.
function onPanelOpenWorkbench(entry: (typeof entries.value)[number], _contributionId: string, childContext?: Record<string, unknown>) {
  const payload = childContext && typeof childContext === "object" && !Array.isArray(childContext) ? { ...childContext } : {};
  delete payload.workbenchId;
  delete payload.restored;
  delete payload.surface;
  const id = addPluginDockEntry({
    pluginId: entry.pluginId,
    workbenchContributionId: entry.workbenchContributionId,
    kind: "command",
    title: entry.title,
    commandContext: payload,
  });
  activatePluginDockEntry(id);
}

// §8.3/§7.4 two-phase close: removing an entry first asks its panel webview to
// release the workbench scope (PTY sessions, subscriptions) and waits for the
// bridge-bounded handshake before the iframe is unmounted.
const workbenchHosts = new Map<string, { requestClose: () => Promise<boolean> }>();
function setWorkbenchHostRef(entryId: string) {
  return (element: unknown) => {
    const host = element as { requestClose: () => Promise<boolean> } | null;
    if (host) workbenchHosts.set(entryId, host);
    else workbenchHosts.delete(entryId);
  };
}

async function closeEntry(entryId: string) {
  try {
    await workbenchHosts.get(entryId)?.requestClose();
  } catch {
    // Teardown proceeds regardless of a broken handshake.
  }
  closePluginDockEntry(entryId);
}

// Hide the panel: terminal sessions survive (VS Code semantics); the toolbar icon restores it.
function hideDock() {
  collapsed.value = false;
  setDockMaximized(false);
  setDockVisible(false);
}

// Drag the top edge to resize the height (min 140px, up to the shared maximize
// bound). Dragging always exits maximized/collapsed: the start height is the
// currently rendered pixel height, so the transition is seamless. The
// composable owns pointer capture, rAF coalescing and listener cleanup — see
// useDockResize for why capture is load-bearing over the plugin iframes.
const dockRoot = ref<HTMLElement>();
const { startResize } = useDockResize({
  dockHeight,
  minHeight: DOCK_MIN_HEIGHT_PX,
  maxHeightRatio: DOCK_MAX_VIEWPORT_RATIO,
  dockElement: () => dockRoot.value ?? null,
});

function onResizeHandlePointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  // Leave maximized/collapsed before the drag measures the rendered height:
  // the composable starts from the currently rendered px height, so the
  // transition stays seamless.
  setDockMaximized(false);
  collapsed.value = false;
  startResize(event);
}

// "+" picker menu: anchored below the + button, bottom-stuck inside the dock,
// growing upward with content (capped by the dock body), closed by selecting
// an item or clicking anywhere else.
const plusOpen = ref(false);
// Generic list filter for the "+" picker: purely client-side label matching so
// any plugin's long option/target list stays usable without the host knowing
// what the entries mean.
const plusFilter = ref("");
const PLUS_FILTER_THRESHOLD = 8;
const plusItemCount = computed(() => 1 + launchOptionEntries.value.length + connectionTargets.value.length);
const plusQuery = computed(() => plusFilter.value.trim().toLowerCase());
function plusMatches(label: string): boolean {
  return !plusQuery.value || label.toLowerCase().includes(plusQuery.value);
}
const visibleLaunchOptions = computed(() => launchOptionEntries.value.filter((option) => plusMatches(option.label)));
const visibleConnectionTargets = computed(() => connectionTargets.value.filter((target) => plusMatches(target.label)));
const plusRoot = ref<HTMLElement>();
function togglePlusMenu() {
  plusOpen.value = !plusOpen.value;
  plusFilter.value = "";
  if (plusOpen.value) void loadLaunchOptions();
}
function closePlusMenu() {
  plusOpen.value = false;
}
const onPlusMenuOutsidePointerDown = (event: PointerEvent) => {
  const root = plusRoot.value;
  if (plusOpen.value && root && !root.contains(event.target as Node)) closePlusMenu();
};
window.addEventListener("pointerdown", onPlusMenuOutsidePointerDown, true);
onScopeDispose(() => window.removeEventListener("pointerdown", onPlusMenuOutsidePointerDown, true));
</script>

<template>
  <!-- v-show, not v-if (HOST_PLUGIN_UI_SPEC §8.3): hiding the panel must only
       hide the UI — the entry webviews (and the user's dragged height) stay
       mounted and alive across hide/show. -->
  <div v-show="visible" ref="dockRoot" data-plugin-bottom-dock class="relative z-10 flex shrink-0 flex-col overflow-hidden border-t bg-background" :style="{ height: maximized ? `${DOCK_MAX_VIEWPORT_RATIO * 100}vh` : collapsed ? '2.25rem' : `${dockHeight}px` }">
    <div data-plugin-dock-resize-handle class="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize hover:bg-primary/30" @pointerdown="onResizeHandlePointerDown" />
    <div class="flex h-9 shrink-0 items-center gap-1 border-b bg-muted/30 pl-2 pr-3">
      <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" data-plugin-dock-tabs>
        <button
          v-for="entry in entries"
          :key="entry.id"
          class="group flex h-7 min-w-0 max-w-40 shrink items-center gap-1 overflow-hidden rounded-md px-2 text-xs"
          :class="[entry.id === activeEntryId ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground', dragEntryId && dragEntryId !== entry.id ? 'opacity-60' : '']"
          :title="entry.title"
          :draggable="renamingEntryId !== entry.id"
          @click="activatePluginDockEntry(entry.id)"
          @dblclick="startRename(entry)"
          @dragstart="onTabDragStart(entry, $event)"
          @dragover.prevent="onTabDragOver(entry)"
          @dragend="onTabDragEnd"
          @drop.prevent="onTabDragEnd"
        >
          <PluginIcon :plugin-id="entry.pluginId" :icon="entry.icon" class="h-3.5 w-3.5 shrink-0" />
          <input
            v-if="renamingEntryId === entry.id"
            :ref="setRenameInputRef"
            v-model="renameDraft"
            class="min-w-0 flex-1 bg-transparent text-xs outline-none"
            spellcheck="false"
            @click.stop
            @dblclick.stop
            @keydown.enter.prevent="commitRename"
            @keydown.escape.prevent="cancelRename"
            @blur="commitRename"
          />
          <span v-else class="min-w-0 flex-1 truncate text-left">{{ entry.title }}</span>
          <span v-if="renamingEntryId !== entry.id" class="ml-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-background/80 group-hover:opacity-100" role="button" :aria-label="t('pluginDock.close')" @click.stop="closeEntry(entry.id)">
            <X class="h-3 w-3" />
          </span>
        </button>
      </div>
      <div v-if="activeCommand" ref="plusRoot" class="relative">
        <Tooltip :delay-duration="200">
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" :aria-label="t('pluginDock.newTerminal')" :aria-expanded="plusOpen" @click="togglePlusMenu">
              <Plus class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t("pluginDock.newTerminal") }}</TooltipContent>
        </Tooltip>
        <div v-if="plusOpen" data-plugin-dock-plus-menu class="absolute right-0 top-full z-30 mt-1 max-h-[50vh] w-64 overflow-y-auto rounded-md border bg-background p-1 shadow-lg" role="menu">
          <!-- Generic list filter (appears only for long lists): the host filters
               by label without knowing what the entries mean. -->
          <input v-if="plusItemCount > PLUS_FILTER_THRESHOLD" v-model="plusFilter" class="mb-1 w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/40" :placeholder="t('pluginDock.filter')" spellcheck="false" @keydown.stop />
          <button v-if="plusMatches(t('pluginDock.newTerminal'))" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted" role="menuitem" @click="onPlusAction('replay')">
            <Plus class="h-3.5 w-3.5 shrink-0" />
            <span class="truncate">{{ t("pluginDock.newTerminal") }}</span>
          </button>
          <button v-for="option in visibleLaunchOptions" :key="option.key" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted" role="menuitem" @click="onPlusAction(option.key)">
            <span class="truncate">{{ option.label }}</span>
          </button>
          <button v-for="target in visibleConnectionTargets" :key="target.key" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted" role="menuitem" :title="target.connection.name" @click="onPlusAction(target.key)">
            <span class="truncate">{{ t("pluginDock.connectionTerminal") }} · {{ target.label }}</span>
          </button>
          <div v-if="plusQuery && !plusMatches(t('pluginDock.newTerminal')) && !visibleLaunchOptions.length && !visibleConnectionTargets.length" class="px-2 py-1.5 text-xs text-muted-foreground">
            {{ t("pluginDock.noMatch") }}
          </div>
        </div>
      </div>
      <Tooltip :delay-duration="200">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-7 w-7" :title="maximized ? t('pluginDock.restore') : t('pluginDock.maximize')" :aria-label="maximized ? t('pluginDock.restore') : t('pluginDock.maximize')" @click="setDockMaximized(!maximized)">
            <Minimize2 v-if="maximized" class="h-3.5 w-3.5" />
            <Maximize2 v-else class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ maximized ? t("pluginDock.restore") : t("pluginDock.maximize") }}</TooltipContent>
      </Tooltip>
      <Button variant="ghost" size="icon" class="h-7 w-7" :title="collapsed ? t('pluginDock.expand') : t('pluginDock.collapse')" :aria-label="collapsed ? t('pluginDock.expand') : t('pluginDock.collapse')" @click="collapsed = !collapsed">
        <ChevronUp v-if="collapsed" class="h-3.5 w-3.5" />
        <ChevronDown v-else class="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('pluginDock.hide')" :aria-label="t('pluginDock.hide')" @click="hideDock">
        <X class="h-3.5 w-3.5" />
      </Button>
    </div>
    <div class="min-h-0 flex-1 overflow-hidden">
      <div v-for="entry in entries" v-show="entry.id === activeEntryId && !collapsed" :key="entry.id" class="h-full w-full">
        <PluginWorkbenchHost
          v-if="workbenchContributionFor(entry)"
          :ref="setWorkbenchHostRef(entry.id)"
          :plugin="definitionFor(entry.pluginId)!"
          :contribution="workbenchContributionFor(entry)!"
          :context="entry.context"
          @close-tab="closeEntry(entry.id)"
          @open-workbench="(_pluginId, contributionId, context) => onPanelOpenWorkbench(entry, contributionId, context)"
        />
      </div>
    </div>
  </div>
</template>
