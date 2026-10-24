<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HelpTooltip } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ConnectionConfig } from "@/types/database";
import type { McpTreeSetting } from "@/lib/mcp/mcpAccessTree";
import { databaseAccess, databaseAccessEqual, type McpDatabaseAccess } from "@/lib/mcp/mcpDatabaseAccess";

const props = defineProps<{
  open: boolean;
  connection: ConnectionConfig;
  value: McpDatabaseAccess;
  savedValue: McpDatabaseAccess;
  inheritedLabel: string;
  savedInheritedLabel: string;
  savedVisible: boolean;
  disabled?: boolean;
  loadDatabases?: (connection: ConnectionConfig) => Promise<string[]>;
  save?: (connectionId: string) => Promise<void>;
}>();
const emit = defineEmits<{ "update:open": [open: boolean]; change: [value: McpDatabaseAccess]; "return-focus": [] }>();
const { t } = useI18n();
const names = ref<string[]>([]);
const knownNames = ref<string[]>([...props.value.allowedDatabases]);
const loaded = ref(false);
const loading = ref(false);
const loadError = ref("");
const saveError = ref("");
const saving = ref(false);
const applied = ref(false);
const leftSearch = ref("");
const rightSearch = ref("");
const leftChecked = ref<string[]>([]);
const rightChecked = ref<string[]>([]);
const leftLimit = ref(100);
const rightLimit = ref(100);
const manualName = ref("");
const selectedDraft = ref<McpDatabaseAccess | null>(null);
const confirmation = ref<{ message: string; value: McpDatabaseAccess } | null>(null);
let loadRevision = 0;
const dirty = computed(() => !databaseAccessEqual(props.value, props.savedValue));
const locked = computed(() => props.disabled || saving.value || !!confirmation.value);
const selected = computed(() => new Set(props.value.allowedDatabases));
const available = computed(() => [...new Set([...names.value, ...knownNames.value])].sort((a, b) => a.localeCompare(b)).filter((name) => !selected.value.has(name) && name.toLocaleLowerCase().includes(leftSearch.value.trim().toLocaleLowerCase())));
const chosen = computed(() => props.value.allowedDatabases.filter((name) => name.toLocaleLowerCase().includes(rightSearch.value.trim().toLocaleLowerCase())));
const checkedDatabases = computed(() => {
  const checked = new Set(rightChecked.value);
  return chosen.value.filter((name) => checked.has(name));
});
const candidates = computed(
  () =>
    [
      { side: "left", names: available.value, checked: leftChecked.value, limit: leftLimit.value, search: leftSearch.value },
      { side: "right", names: chosen.value, checked: rightChecked.value, limit: rightLimit.value, search: rightSearch.value },
    ] as const,
);
watch(leftSearch, () => {
  leftChecked.value = [];
  leftLimit.value = 100;
});
watch(rightSearch, () => {
  rightChecked.value = [];
  rightLimit.value = 100;
});
watch(
  () => props.value,
  () => {
    knownNames.value = [...new Set([...knownNames.value, ...props.value.allowedDatabases])];
    applied.value = false;
    saveError.value = "";
  },
);
watch(
  [() => props.open, () => props.connection.id],
  ([open, id], previous) => {
    ++loadRevision;
    if (!open) {
      selectedDraft.value = null;
      return;
    }
    if (previous?.[1] !== id) {
      names.value = [];
      selectedDraft.value = null;
      knownNames.value = [...props.value.allowedDatabases];
      loaded.value = false;
    }
    leftSearch.value = rightSearch.value = manualName.value = saveError.value = "";
    leftChecked.value = [];
    rightChecked.value = [];
    confirmation.value = null;
    applied.value = false;
    leftLimit.value = rightLimit.value = 100;
    void refresh();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ++loadRevision;
});

async function refresh() {
  const revision = ++loadRevision;
  loadError.value = "";
  if (!props.loadDatabases) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    // These metadata APIs return every database visible to the account. Local
    // rendering limits never truncate discovery, search, or the saved selection.
    const result = await props.loadDatabases(props.connection);
    if (revision !== loadRevision) return;
    names.value = [...new Set(result.filter((name) => name.trim().length > 0))].sort((a, b) => a.localeCompare(b));
    loaded.value = true;
  } catch (error) {
    if (revision === loadRevision) loadError.value = String(error instanceof Error ? error.message : error);
  } finally {
    if (revision === loadRevision) loading.value = false;
  }
}
function levelLabel(setting: McpTreeSetting) {
  return t(setting === "inherit" ? "settings.mcpAccessTreeInherit" : setting === "read_only" ? "settings.mcpExecutionModeReadOnly" : setting === "safe_write" ? "settings.mcpExecutionModeSafeWrite" : "settings.mcpExecutionModeHighRiskWrite");
}
function settingFor(name: string): McpTreeSetting {
  const rule = props.value.databasePolicies.find((entry) => entry.databaseName === name);
  return !rule ? "inherit" : rule.readOnly ? "read_only" : rule.allowDangerousSql ? "high_risk_write" : "safe_write";
}
function permissionDescription(name: string) {
  const permission = settingFor(name) === "inherit" ? t("settings.mcpDatabaseInherited", { level: props.inheritedLabel }) : t("settings.mcpAccessTreeSourceDatabase");
  return loaded.value && !loading.value && !loadError.value && !names.value.includes(name) ? `${permission} · ${t("settings.mcpDatabaseNotDiscovered")}` : permission;
}
function change(value: McpDatabaseAccess, message?: string) {
  if (locked.value) return;
  if (message) confirmation.value = { message, value: databaseAccess(value) };
  else emit("change", databaseAccess(value));
}
function confirmChange() {
  if (!confirmation.value || props.disabled || saving.value) return;
  const value = confirmation.value.value;
  confirmation.value = null;
  emit("change", value);
}
function changeScope(scope: McpDatabaseAccess["databaseScope"]) {
  if (scope === props.value.databaseScope) return;
  if (props.value.databaseScope === "selected") selectedDraft.value = databaseAccess(props.value);
  const value = scope === "selected" && selectedDraft.value ? selectedDraft.value : { ...props.value, databaseScope: scope };
  change(value, scope !== "selected" && props.value.databasePolicies.length ? t("settings.mcpDatabaseScopeClearsPermissionExceptions") : undefined);
}
function check(side: string, name: string, checked: boolean) {
  if (locked.value) return;
  const target = side === "left" ? leftChecked : rightChecked;
  target.value = checked ? [...new Set([...target.value, name])] : target.value.filter((item) => item !== name);
}
function checkResults(side: string, checked: boolean) {
  if (locked.value) return;
  if (side === "left") leftChecked.value = checked ? [...available.value] : [];
  else rightChecked.value = checked ? [...chosen.value] : [];
}
function add(namesToAdd: string[]) {
  if (locked.value || !namesToAdd.length) return;
  change({ ...props.value, databaseScope: "selected", allowedDatabases: [...props.value.allowedDatabases, ...namesToAdd] });
  leftChecked.value = [];
  manualName.value = "";
}
function remove() {
  const removed = new Set(rightChecked.value);
  if (!removed.size) return;
  change({ ...props.value, allowedDatabases: props.value.allowedDatabases.filter((name) => !removed.has(name)) }, props.value.databasePolicies.some((entry) => removed.has(entry.databaseName)) ? t("settings.mcpDatabaseRemoveConfirm") : undefined);
  rightChecked.value = [];
}
function setLevels(namesToChange: string[], setting: McpTreeSetting, batch = false) {
  if (locked.value || props.value.databaseScope !== "selected") return;
  const targets = new Set(namesToChange.filter((name) => selected.value.has(name) && settingFor(name) !== setting));
  if (!targets.size) return;
  const databasePolicies = props.value.databasePolicies.filter((entry) => !targets.has(entry.databaseName));
  if (setting !== "inherit") {
    for (const name of targets) databasePolicies.push({ databaseName: name, readOnly: setting === "read_only", allowDangerousSql: setting === "high_risk_write" });
  }
  change({ ...props.value, databasePolicies }, setting === "high_risk_write" ? (batch ? t("settings.mcpDatabaseBatchHighRiskConfirm", { count: targets.size }) : t("settings.mcpDatabasePolicyHighRiskConfirm")) : undefined);
}
function close() {
  if (!saving.value) emit("update:open", false);
}
async function apply() {
  if (locked.value || !dirty.value || !props.save) return;
  saving.value = true;
  saveError.value = "";
  try {
    await props.save(props.connection.id);
    selectedDraft.value = null;
    applied.value = true;
  } catch (error) {
    saveError.value = t("settings.mcpToolsetApplyFailed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="!$event && close()">
    <DialogContent
      class="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-5xl"
      :show-close-button="!saving"
      data-mcp-database-dialog
      @close-auto-focus="
        $event.preventDefault();
        emit('return-focus');
      "
      @escape-key-down="saving && $event.preventDefault()"
      @interact-outside="$event.preventDefault()"
    >
      <DialogHeader class="shrink-0">
        <DialogTitle class="break-all">{{ t("settings.mcpDatabaseDialogTitle", { name: connection.name }) }}</DialogTitle>
        <DialogDescription>{{ t("settings.mcpDatabaseDialogDescription") }}</DialogDescription>
      </DialogHeader>
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto">
        <p class="text-xs text-muted-foreground">{{ t("settings.mcpDatabaseInherited", { level: inheritedLabel }) }}</p>
        <p v-if="inheritedLabel !== savedInheritedLabel" class="text-xs text-amber-700 dark:text-amber-300" data-mcp-database-parent-draft>{{ t("settings.mcpDatabaseSavedInherited", { level: savedInheritedLabel }) }}</p>
        <p v-if="!savedVisible" class="text-xs text-amber-700 dark:text-amber-300">{{ t("settings.mcpDatabaseHiddenConnection") }}</p>
        <Select :model-value="value.databaseScope" :disabled="locked" @update:model-value="changeScope($event as McpDatabaseAccess['databaseScope'])">
          <SelectTrigger class="w-full sm:w-64" :aria-label="t('settings.mcpAccessTreeDatabases')" data-mcp-database-mode
            ><SelectValue>{{
              t(value.databaseScope === "all" ? "settings.mcpAccessTreeDatabaseScopeAll" : value.databaseScope === "none" ? "settings.mcpAccessTreeDatabaseScopeNone" : "settings.mcpAccessTreeDatabaseScopeSelected", { count: value.allowedDatabases.length })
            }}</SelectValue></SelectTrigger
          >
          <SelectContent
            ><SelectItem value="all">{{ t("settings.mcpAccessTreeDatabaseScopeAll") }}</SelectItem
            ><SelectItem value="selected">{{ t("settings.mcpAccessTreeDatabaseScopeSelected", { count: value.allowedDatabases.length }) }}</SelectItem
            ><SelectItem value="none">{{ t("settings.mcpAccessTreeDatabaseScopeNone") }}</SelectItem></SelectContent
          >
        </Select>
        <p v-if="value.databaseScope === 'all'" class="text-xs text-muted-foreground">{{ t("settings.mcpDatabaseAllHint") }}</p>
        <p v-else-if="value.databaseScope === 'none' || !value.allowedDatabases.length" class="text-xs text-muted-foreground">{{ t("settings.mcpDatabaseNoneHint") }}</p>
        <template v-if="value.databaseScope === 'selected'">
          <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span role="status">{{ loading ? t("settings.mcpAccessTreeLoadingDatabases") : t("settings.mcpDatabaseLoaded", { count: names.length }) }}</span>
            <Button variant="outline" size="sm" :disabled="loading || locked" data-mcp-database-refresh @click="refresh">{{ t("settings.mcpDatabaseRefresh") }}</Button>
          </div>
          <p v-if="loadError" role="alert" class="text-xs text-destructive">{{ t("settings.mcpAccessTreeLoadDatabasesFailed", { error: loadError }) }}</p>
          <div class="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.5fr)]">
            <template v-for="pane in candidates" :key="pane.side">
              <div v-if="pane.side === 'right'" class="flex items-center justify-center gap-2 md:flex-col">
                <Button variant="outline" size="sm" :disabled="locked || !leftChecked.length" data-mcp-database-add @click="add(leftChecked)">{{ t("settings.mcpDatabaseAddSelected") }}</Button>
                <Button variant="outline" size="sm" :disabled="locked || !rightChecked.length" data-mcp-database-remove @click="remove">{{ t("settings.mcpDatabaseRemoveSelected") }}</Button>
              </div>
              <section class="flex min-w-0 flex-col rounded-md border" :data-mcp-database-pane="pane.side" :aria-label="t(pane.side === 'left' ? 'settings.mcpDatabaseAvailable' : 'settings.mcpDatabaseSelected', { count: pane.names.length })">
                <div class="space-y-2 border-b bg-muted/30 p-3">
                  <p class="text-sm font-medium">{{ t(pane.side === "left" ? "settings.mcpDatabaseAvailable" : "settings.mcpDatabaseSelected", { count: pane.side === "left" ? new Set([...names, ...knownNames].filter((name) => !selected.has(name))).size : value.allowedDatabases.length }) }}</p>
                  <Input :model-value="pane.search" :placeholder="t('settings.mcpDatabaseSearch')" :aria-label="t('settings.mcpDatabaseSearch')" :data-mcp-database-search="pane.side" @update:model-value="pane.side === 'left' ? (leftSearch = String($event)) : (rightSearch = String($event))" />
                  <div class="flex min-h-7 flex-wrap items-center justify-between gap-2">
                    <label class="flex items-center gap-2 text-xs"
                      ><input
                        type="checkbox"
                        class="m-0 size-3.5 shrink-0"
                        :disabled="locked || !pane.names.length"
                        :checked="!!pane.names.length && pane.names.every((name) => pane.checked.includes(name))"
                        :data-mcp-database-check-results="pane.side"
                        @change="checkResults(pane.side, ($event.target as HTMLInputElement).checked)"
                      />{{ t("settings.mcpDatabaseSelectResults", { count: pane.names.length }) }}</label
                    >
                    <Select v-if="pane.side === 'right'" model-value="" :disabled="locked || !checkedDatabases.length" @update:model-value="setLevels(checkedDatabases, $event as McpTreeSetting, true)">
                      <SelectTrigger size="sm" class="max-w-full text-xs" :aria-label="t('settings.mcpDatabaseBatchLevel', { count: checkedDatabases.length })" data-mcp-database-batch-level>
                        <SelectValue :placeholder="t('settings.mcpDatabaseBatchLevel', { count: checkedDatabases.length })" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="level in ['inherit', 'read_only', 'safe_write', 'high_risk_write'] as const" :key="level" :value="level">{{ levelLabel(level) }}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div class="h-64 overflow-y-auto p-1 md:h-[min(40vh,24rem)]">
                  <div v-for="name in pane.names.slice(0, pane.limit)" :key="name" class="grid min-h-8 min-w-0 items-center gap-x-2 rounded px-2 py-0.5 hover:bg-muted/50" :class="pane.side === 'right' ? 'grid-cols-[minmax(0,1fr)_9rem]' : 'grid-cols-1'" :data-mcp-database-name="name">
                    <label class="flex min-h-6 min-w-0 items-center gap-2 text-sm leading-5"
                      ><input class="m-0 size-3.5 shrink-0" type="checkbox" :checked="pane.checked.includes(name)" :disabled="locked" :data-mcp-database-check="`${pane.side}:${name}`" @change="check(pane.side, name, ($event.target as HTMLInputElement).checked)" /><span
                        class="min-w-0 truncate"
                        :title="name"
                        >{{ name }}</span
                      ></label
                    >
                    <div v-if="pane.side === 'right'" class="flex min-w-0 items-center gap-1.5">
                      <Select :model-value="settingFor(name)" :disabled="locked" @update:model-value="setLevels([name], $event as McpTreeSetting)">
                        <SelectTrigger size="sm" class="min-w-0 flex-1 text-xs" :aria-label="`${name} / ${t('settings.mcpAccessTreeColumnSetting')}`" :aria-description="permissionDescription(name)" :data-mcp-database-level="name"
                          ><SelectValue>{{ levelLabel(settingFor(name)) }}</SelectValue></SelectTrigger
                        >
                        <SelectContent
                          ><SelectItem v-for="level in ['inherit', 'read_only', 'safe_write', 'high_risk_write'] as const" :key="level" :value="level">{{ levelLabel(level) }}</SelectItem></SelectContent
                        >
                      </Select>
                      <HelpTooltip :label="`${name} / ${permissionDescription(name)}`" />
                    </div>
                  </div>
                  <p v-if="!pane.names.length" class="p-4 text-center text-xs text-muted-foreground">{{ t("settings.mcpAccessTreeNoMatch") }}</p>
                  <Button v-if="pane.names.length > pane.limit" variant="outline" size="sm" class="w-full" :data-mcp-database-more="pane.side" @click="pane.side === 'left' ? (leftLimit += 100) : (rightLimit += 100)">{{
                    t("settings.mcpDatabaseShowMore", { shown: Math.min(pane.limit, pane.names.length), total: pane.names.length })
                  }}</Button>
                </div>
              </section>
            </template>
          </div>
          <div class="flex gap-2">
            <Input v-model="manualName" :disabled="locked" :placeholder="t('settings.mcpAccessTreeManualDatabase')" :aria-label="t('settings.mcpAccessTreeManualDatabase')" data-mcp-database-manual @keydown.enter.prevent="manualName.trim() && add([manualName.trim()])" /><Button
              variant="outline"
              :disabled="locked || !manualName.trim()"
              data-mcp-database-manual-add
              @click="add([manualName.trim()])"
              >{{ t("settings.mcpToolCustomAdd") }}</Button
            >
          </div>
        </template>
      </div>
      <div class="shrink-0 space-y-3 border-t pt-3">
        <div v-if="confirmation" role="alert" class="space-y-2 rounded border p-3 text-sm">
          <p>{{ confirmation.message }}</p>
          <div class="flex justify-end gap-2">
            <Button variant="outline" data-mcp-database-confirm-cancel @click="confirmation = null">{{ t("common.cancel") }}</Button
            ><Button :disabled="disabled" data-mcp-database-confirm @click="confirmChange">{{ t("common.confirm") }}</Button>
          </div>
        </div>
        <p v-if="saveError" role="alert" class="text-xs text-destructive">{{ saveError }}</p>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <div class="min-w-0 flex-1 basis-64 space-y-1 text-xs text-muted-foreground">
            <p>{{ t("settings.mcpDatabaseSaveHint") }}</p>
            <p role="status" aria-live="polite">{{ saving ? t("settings.mcpToolsetApplying") : dirty ? t("settings.mcpToolsetCloseKeepsDraft") : applied ? t("settings.mcpToolsetApplied") : "" }}</p>
          </div>
          <Button variant="outline" :disabled="saving" data-mcp-database-close @click="close">{{ t("settings.mcpToolsetDetailClose") }}</Button>
          <Button :disabled="locked || !dirty || !save" data-mcp-database-apply @click="apply">{{ t("settings.mcpDatabaseApply") }}</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
