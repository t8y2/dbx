<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue";
import { AlertTriangle, Minus, Plus, Search } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import TruncatedTextTooltip from "@/components/ui/TruncatedTextTooltip.vue";
import { groupMcpScopeConnections, matchesMcpSearchQuery, updateMcpAllowedConnectionIds } from "@/lib/mcp/mcpPolicySelection";
import type { ConnectionConfig } from "@/types/database";

type ScopePane = "available" | "allowed";
type ScopeMode = "all" | "selected";

const props = withDefaults(
  defineProps<{
    connections: readonly ConnectionConfig[];
    allowedConnectionIds: readonly string[] | null;
    disabled?: boolean;
    busy?: boolean;
  }>(),
  {
    disabled: false,
    busy: false,
  },
);

const emit = defineEmits<{
  "update:allowedConnectionIds": [value: string[] | null];
}>();

const { t } = useI18n();
const pickerId = useId();
const rootRef = ref<HTMLElement>();
const searchQuery = ref("");
const compactPane = ref<ScopePane>("allowed");
const announcement = ref("");
const pendingFocus = ref<{ pane: ScopePane; index: number } | null>(null);

const connectionIds = computed(() => props.connections.map((connection) => connection.id));
const groups = computed(() => groupMcpScopeConnections(props.connections, props.allowedConnectionIds));
const scopeMode = computed<ScopeMode>(() => (props.allowedConnectionIds === null ? "all" : "selected"));
const searchActive = computed(() => searchQuery.value.trim().length > 0);

function connectionMatchesSearch(connection: ConnectionConfig): boolean {
  return matchesMcpSearchQuery(searchQuery.value, [connection.name, connection.db_type, connection.host, connection.port, connection.database, connection.id]);
}

const filteredAvailableConnections = computed(() => groups.value.available.filter(connectionMatchesSearch));
const filteredAllowedConnections = computed(() => groups.value.allowed.filter(connectionMatchesSearch));
const filteredUnavailableAllowedIds = computed(() => groups.value.unavailableAllowedIds.filter((id) => matchesMcpSearchQuery(searchQuery.value, [id, t("settings.mcpScopeConnectionUnavailable")])));
const allowedVisibleCount = computed(() => filteredAllowedConnections.value.length + filteredUnavailableAllowedIds.value.length);
const allowedTotalCount = computed(() => groups.value.allowed.length + groups.value.unavailableAllowedIds.length);
const availableVisibleCount = computed(() => filteredAvailableConnections.value.length);
const availableTotalCount = computed(() => groups.value.available.length);
const allowedSummary = computed(() => (props.allowedConnectionIds === null ? t("settings.mcpScopeAllSummary", { count: props.connections.length }) : t("settings.mcpScopeSelectedSummary", { selected: groups.value.allowed.length, total: props.connections.length })));
const policyKey = computed(() => (props.allowedConnectionIds === null ? "*" : props.allowedConnectionIds.join("\u0000")));

function paneCount(visible: number, total: number): string {
  return searchActive.value ? `${visible}/${total}` : String(total);
}

function connectionAddress(connection: ConnectionConfig): string {
  const address = connection.host ? `${connection.host}:${connection.port}` : "";
  return [address, connection.database].filter(Boolean).join(" · ") || connection.id;
}

function emitAllowedConnectionIds(value: string[] | null) {
  if (props.disabled) return;
  emit("update:allowedConnectionIds", value);
}

function setScopeMode(mode: ScopeMode) {
  if (mode === scopeMode.value || props.disabled) return;
  emitAllowedConnectionIds(mode === "all" ? null : [...connectionIds.value]);
}

function onScopeModeKeydown(event: KeyboardEvent, mode: ScopeMode) {
  if (props.disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const nextMode: ScopeMode = event.key === "Home" || event.key === "ArrowLeft" || event.key === "ArrowUp" ? "all" : "selected";
  if (nextMode === mode) return;
  // These cards visually replace native radios, so preserve the radio-group keyboard contract.
  const currentTarget = event.currentTarget;
  const group = currentTarget instanceof HTMLElement ? currentTarget.closest<HTMLElement>('[role="radiogroup"]') : null;
  group?.querySelector<HTMLElement>(`[data-scope-mode="${nextMode}"]`)?.focus();
  setScopeMode(nextMode);
}

function restorePendingFocus() {
  const pending = pendingFocus.value;
  if (!pending || props.busy) return;
  void nextTick(() => {
    if (props.busy) return;
    const pane = rootRef.value?.querySelector<HTMLElement>(`[data-scope-pane="${pending.pane}"]`);
    const actions = [...(pane?.querySelectorAll<HTMLButtonElement>("[data-scope-action]") ?? [])];
    const target = actions[Math.min(pending.index, Math.max(0, actions.length - 1))];
    if (target) target.focus();
    else rootRef.value?.focus();
    pendingFocus.value = null;
  });
}

function updateConnections(connectionIdsToUpdate: readonly string[], allowed: boolean, event?: MouseEvent) {
  if (props.disabled || connectionIdsToUpdate.length === 0) return;
  const sourcePane: ScopePane = allowed ? "available" : "allowed";
  if (event?.currentTarget instanceof HTMLElement) {
    const pane = event.currentTarget.closest<HTMLElement>("[data-scope-pane]");
    const actions = [...(pane?.querySelectorAll<HTMLButtonElement>("[data-scope-action]") ?? [])];
    pendingFocus.value = { pane: sourcePane, index: Math.max(0, actions.indexOf(event.currentTarget as HTMLButtonElement)) };
  }
  emitAllowedConnectionIds(updateMcpAllowedConnectionIds(props.allowedConnectionIds, connectionIds.value, connectionIdsToUpdate, allowed));
  restorePendingFocus();
}

function addVisibleConnections() {
  updateConnections(
    filteredAvailableConnections.value.map((connection) => connection.id),
    true,
  );
}

function removeVisibleConnections() {
  updateConnections([...filteredAllowedConnections.value.map((connection) => connection.id), ...filteredUnavailableAllowedIds.value], false);
}

watch(
  () => props.busy,
  (busy) => {
    if (!busy) restorePendingFocus();
  },
);

watch([policyKey, () => groups.value.allowed.length], () => {
  announcement.value = t("settings.mcpScopeUpdatedAnnouncement", { selected: groups.value.allowed.length, total: props.connections.length });
});
</script>

<template>
  <div ref="rootRef" tabindex="-1" class="mcp-scope-picker space-y-3 rounded-md border bg-muted/20 p-3 outline-none" :aria-busy="busy">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <div :id="`${pickerId}-mode-label`" class="text-sm font-medium">{{ t("settings.mcpScopeConnection") }}</div>
          <Badge variant="outline" class="rounded-md font-normal">{{ allowedSummary }}</Badge>
        </div>
        <p class="text-xs text-muted-foreground">{{ t("settings.mcpScopeConnectionDescription") }}</p>
      </div>
    </div>

    <div class="grid grid-cols-1 p-1 sm:grid-cols-2 gap-2.5" role="radiogroup" :aria-labelledby="`${pickerId}-mode-label`">
      <Button
        :disabled="disabled"
        type="button"
        role="radio"
        data-scope-mode="all"
        :aria-checked="scopeMode === 'all'"
        :tabindex="scopeMode === 'all' ? 0 : -1"
        variant="outline"
        class="settings-choice-card h-auto justify-center border p-3"
        :class="[scopeMode === 'all' ? 'settings-choice-card--selected border-blue-300 ring-2 ring-blue-300/50' : '', disabled ? 'cursor-not-allowed opacity-50' : '']"
        @click="setScopeMode('all')"
        @keydown="onScopeModeKeydown($event, 'all')"
      >
        <div class="w-full min-w-0 text-center">
          <div class="text-sm font-medium">{{ t("settings.mcpScopeModeAll") }}</div>
          <div class="text-xs text-muted-foreground truncate">{{ t("settings.mcpScopeModeAllDescription") }}</div>
        </div>
      </Button>
      <Button
        :disabled="disabled"
        type="button"
        role="radio"
        data-scope-mode="selected"
        :aria-checked="scopeMode === 'selected'"
        :tabindex="scopeMode === 'selected' ? 0 : -1"
        variant="outline"
        class="settings-choice-card h-auto justify-center border p-3"
        :class="[scopeMode === 'selected' ? 'settings-choice-card--selected border-blue-300 ring-2 ring-blue-300/50' : '', disabled ? 'cursor-not-allowed opacity-50' : '']"
        @click="setScopeMode('selected')"
        @keydown="onScopeModeKeydown($event, 'selected')"
      >
        <div class="w-full min-w-0 text-center">
          <div class="text-sm font-medium">{{ t("settings.mcpScopeModeSelected") }}</div>
          <div class="text-xs text-muted-foreground truncate">{{ t("settings.mcpScopeModeSelectedDescription") }}</div>
        </div>
      </Button>
    </div>

    <div class="relative">
      <Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input v-model="searchQuery" class="h-9 pl-8" :disabled="disabled" :aria-label="t('settings.mcpConnectionSearchPlaceholder')" :placeholder="t('settings.mcpConnectionSearchPlaceholder')" />
    </div>

    <div class="mcp-scope-mobile-tabs grid grid-cols-2 rounded-md bg-muted p-1" role="tablist" :aria-label="t('settings.mcpScopeConnection')">
      <button
        :id="`${pickerId}-allowed-tab`"
        type="button"
        role="tab"
        data-scope-tab="allowed"
        class="min-w-0 rounded px-2 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        :class="compactPane === 'allowed' ? 'bg-background text-foreground shadow-sm dark:bg-input/30' : 'text-muted-foreground'"
        :aria-selected="compactPane === 'allowed'"
        :aria-controls="`${pickerId}-allowed-pane`"
        @click="compactPane = 'allowed'"
      >
        {{ t("settings.mcpScopeAllowedPane") }} {{ allowedTotalCount }}
      </button>
      <button
        :id="`${pickerId}-available-tab`"
        type="button"
        role="tab"
        data-scope-tab="available"
        class="min-w-0 rounded px-2 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        :class="compactPane === 'available' ? 'bg-background text-foreground shadow-sm dark:bg-input/30' : 'text-muted-foreground'"
        :aria-selected="compactPane === 'available'"
        :aria-controls="`${pickerId}-available-pane`"
        @click="compactPane = 'available'"
      >
        {{ t("settings.mcpScopeAvailablePane") }} {{ availableTotalCount }}
      </button>
    </div>

    <div class="mcp-scope-transfer overflow-hidden rounded-md border bg-background">
      <section :id="`${pickerId}-available-pane`" data-scope-pane="available" class="mcp-scope-pane min-w-0 flex-col" :class="{ 'mcp-scope-pane--active': compactPane === 'available' }" role="region" :aria-label="t('settings.mcpScopeAvailablePane')">
        <div class="flex min-h-10 items-center justify-between gap-2 border-b px-2.5 py-1.5">
          <div class="flex min-w-0 items-center gap-2 text-sm font-medium">
            <span class="truncate">{{ t("settings.mcpScopeAvailablePane") }}</span>
            <Badge variant="secondary" class="rounded-md font-normal">{{ paneCount(availableVisibleCount, availableTotalCount) }}</Badge>
          </div>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-scope-batch="available"
            :title="t(searchActive ? 'settings.mcpScopeAddMatches' : 'settings.mcpScopeAddAll', { count: availableVisibleCount })"
            :aria-label="t(searchActive ? 'settings.mcpScopeAddMatches' : 'settings.mcpScopeAddAll', { count: availableVisibleCount })"
            :disabled="disabled || availableVisibleCount === 0"
            @click="addVisibleConnections"
          >
            <Plus />
            <span class="mcp-scope-batch-label">{{ t(searchActive ? "settings.mcpScopeAddMatches" : "settings.mcpScopeAddAll", { count: availableVisibleCount }) }}</span>
          </Button>
        </div>
        <div class="h-64 overflow-y-auto p-1.5">
          <div v-if="filteredAvailableConnections.length === 0" class="flex h-full items-center justify-center px-3 text-center text-sm text-muted-foreground">
            {{ searchActive ? t("settings.mcpConnectionSearchEmpty") : t("settings.mcpScopeAvailableEmpty") }}
          </div>
          <div v-for="connection in filteredAvailableConnections" :key="connection.id" class="mcp-scope-connection-row grid min-h-12 items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/60">
            <div class="min-w-0">
              <TruncatedTextTooltip :text="connection.name" class="block text-sm font-medium" />
              <TruncatedTextTooltip :text="connectionAddress(connection)" class="mt-0.5 block font-mono text-[11px] text-muted-foreground" />
            </div>
            <div class="flex min-w-0 items-center justify-center">
              <Badge :title="connection.db_type.toUpperCase()" variant="outline" class="max-w-full justify-center rounded px-1.5 py-0 text-[10px] font-normal uppercase">
                <span class="truncate">{{ connection.db_type }}</span>
              </Badge>
            </div>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              class="justify-self-end"
              data-scope-action
              :data-connection-id="connection.id"
              :title="t('settings.mcpScopeAddConnection', { name: connection.name })"
              :aria-label="t('settings.mcpScopeAddConnection', { name: connection.name })"
              :disabled="disabled"
              @click="updateConnections([connection.id], true, $event)"
            >
              <Plus />
            </Button>
          </div>
        </div>
      </section>

      <section :id="`${pickerId}-allowed-pane`" data-scope-pane="allowed" class="mcp-scope-pane min-w-0 flex-col" :class="{ 'mcp-scope-pane--active': compactPane === 'allowed' }" role="region" :aria-label="t('settings.mcpScopeAllowedPane')">
        <div class="flex min-h-10 items-center justify-between gap-2 border-b px-2.5 py-1.5">
          <div class="flex min-w-0 items-center gap-2 text-sm font-medium">
            <span class="truncate">{{ t("settings.mcpScopeAllowedPane") }}</span>
            <Badge variant="secondary" class="rounded-md font-normal">{{ paneCount(allowedVisibleCount, allowedTotalCount) }}</Badge>
          </div>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-scope-batch="allowed"
            :title="t(searchActive ? 'settings.mcpScopeRemoveMatches' : 'settings.mcpScopeRemoveAll', { count: allowedVisibleCount })"
            :aria-label="t(searchActive ? 'settings.mcpScopeRemoveMatches' : 'settings.mcpScopeRemoveAll', { count: allowedVisibleCount })"
            :disabled="disabled || allowedVisibleCount === 0"
            @click="removeVisibleConnections"
          >
            <Minus />
            <span class="mcp-scope-batch-label">{{ t(searchActive ? "settings.mcpScopeRemoveMatches" : "settings.mcpScopeRemoveAll", { count: allowedVisibleCount }) }}</span>
          </Button>
        </div>
        <div class="h-64 overflow-y-auto p-1.5">
          <div v-if="filteredAllowedConnections.length === 0 && filteredUnavailableAllowedIds.length === 0" class="flex h-full items-center justify-center px-3 text-center text-sm text-muted-foreground">
            {{ searchActive ? t("settings.mcpConnectionSearchEmpty") : t("settings.mcpScopeAllowedEmpty") }}
          </div>
          <div v-for="connection in filteredAllowedConnections" :key="connection.id" class="mcp-scope-connection-row grid min-h-12 items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/60">
            <div class="min-w-0">
              <TruncatedTextTooltip :text="connection.name" class="block text-sm font-medium" />
              <TruncatedTextTooltip :text="connectionAddress(connection)" class="mt-0.5 block font-mono text-[11px] text-muted-foreground" />
            </div>
            <div class="flex min-w-0 items-center justify-center">
              <Badge :title="connection.db_type.toUpperCase()" variant="outline" class="max-w-full justify-center rounded px-1.5 py-0 text-[10px] font-normal uppercase">
                <span class="truncate">{{ connection.db_type }}</span>
              </Badge>
            </div>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              class="justify-self-end"
              data-scope-action
              :data-connection-id="connection.id"
              :title="t('settings.mcpScopeRemoveConnection', { name: connection.name })"
              :aria-label="t('settings.mcpScopeRemoveConnection', { name: connection.name })"
              :disabled="disabled"
              @click="updateConnections([connection.id], false, $event)"
            >
              <Minus />
            </Button>
          </div>

          <div v-if="filteredUnavailableAllowedIds.length > 0" class="mt-1 border-t border-amber-500/20 pt-1">
            <div class="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle class="h-3.5 w-3.5" />
              {{ t("settings.mcpScopeUnavailableGroup", { count: filteredUnavailableAllowedIds.length }) }}
            </div>
            <div v-for="connectionId in filteredUnavailableAllowedIds" :key="connectionId" class="flex min-h-10 items-center gap-2 rounded px-2 py-1.5 text-amber-600 hover:bg-muted/60 dark:text-amber-400">
              <TruncatedTextTooltip :text="connectionId" class="min-w-0 flex-1 font-mono text-xs" />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                data-scope-action
                :data-connection-id="connectionId"
                :title="t('settings.mcpScopeRemoveUnavailableConnection', { id: connectionId })"
                :aria-label="t('settings.mcpScopeRemoveUnavailableConnection', { id: connectionId })"
                :disabled="disabled"
                @click="updateConnections([connectionId], false, $event)"
              >
                <Minus />
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <p v-if="groups.unavailableAllowedIds.length > 0" class="text-xs text-amber-600 dark:text-amber-400">
      {{ t("settings.mcpScopeConnectionUnavailableDescription", { count: groups.unavailableAllowedIds.length }) }}
    </p>
    <span class="sr-only" aria-live="polite">{{ announcement }}</span>
  </div>
</template>

<style scoped>
.mcp-scope-picker {
  container: mcp-scope / inline-size;
}

.mcp-scope-pane {
  display: none;
}

.mcp-scope-pane--active {
  display: flex;
}

.mcp-scope-connection-row {
  grid-template-columns: minmax(0, 1fr) 6.75rem 1.75rem;
}

@container mcp-scope (min-width: 42rem) {
  .mcp-scope-mobile-tabs {
    display: none;
  }

  .mcp-scope-transfer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .mcp-scope-pane {
    display: flex;
  }

  .mcp-scope-pane + .mcp-scope-pane {
    border-inline-start: 1px solid var(--border);
  }
}

@container mcp-scope (max-width: 28rem) {
  .mcp-scope-mode-description,
  .mcp-scope-batch-label {
    display: none;
  }

  .mcp-scope-connection-row {
    grid-template-columns: minmax(0, 1fr) 5.5rem 1.75rem;
  }
}
</style>
