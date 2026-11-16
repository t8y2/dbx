<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronRight, Folder, Loader2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { connectionDriverLabel, connectionEndpointLabel, connectionIconType } from "@/lib/connection/connectionPresentation";
import type { ConnectionConfig, SidebarLayout, SidebarOrderEntry } from "@/types/database";

const props = defineProps<{
  open: boolean;
  mode: "export" | "import";
  busy?: boolean;
  connections: ConnectionConfig[];
  layout?: SidebarLayout | null;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  confirm: [connectionIds: string[]];
}>();

const { t } = useI18n();
const selectedIds = ref<string[]>([]);
const expandedGroupIds = ref<Set<string>>(new Set());

const dialogOpen = computed({
  get: () => props.open,
  set: (value) => {
    if (props.busy && !value) return;
    emit("update:open", value);
  },
});

const connectionIds = computed(() => props.connections.map((connection) => connection.id).filter((id) => id.length > 0));
const selectedCount = computed(() => selectedIds.value.length);
const canConfirm = computed(() => selectedCount.value > 0);

type TreeRow = { type: "group"; id: string; name: string; depth: number } | { type: "connection"; id: string; depth: number };

function entryChildren(entry: Extract<SidebarOrderEntry, { type: "group" }>): SidebarOrderEntry[] {
  return entry.children ?? entry.connectionIds?.map((id) => ({ type: "connection" as const, id })) ?? [];
}

const connectionIdSet = computed(() => new Set(connectionIds.value));
const groupNames = computed(() => new Map((props.layout?.groups ?? []).map((group) => [group.id, group.name])));

const groupConnectionIds = computed(() => {
  const result = new Map<string, string[]>();
  const collect = (entry: SidebarOrderEntry): string[] => {
    if (entry.type === "connection") return connectionIdSet.value.has(entry.id) ? [entry.id] : [];
    const ids = entryChildren(entry).flatMap(collect);
    result.set(entry.id, ids);
    return ids;
  };
  for (const entry of props.layout?.order ?? []) collect(entry);
  return result;
});

const treeRows = computed<TreeRow[]>(() => {
  if (!props.layout?.order?.length) return props.connections.map((connection) => ({ type: "connection", id: connection.id, depth: 0 }));
  const rows: TreeRow[] = [];
  const coveredConnections = new Set<string>();
  const renderedConnections = new Set<string>();
  const visit = (entries: SidebarOrderEntry[], depth: number) => {
    for (const entry of entries) {
      if (entry.type === "connection") {
        if (!connectionIdSet.value.has(entry.id) || renderedConnections.has(entry.id)) continue;
        renderedConnections.add(entry.id);
        rows.push({ type: "connection", id: entry.id, depth });
        continue;
      }
      const ids = groupConnectionIds.value.get(entry.id) ?? [];
      const name = groupNames.value.get(entry.id);
      if (!name || ids.length === 0) continue;
      rows.push({ type: "group", id: entry.id, name, depth });
      for (const connectionId of ids) coveredConnections.add(connectionId);
      if (expandedGroupIds.value.has(entry.id)) visit(entryChildren(entry), depth + 1);
    }
  };
  visit(props.layout.order, 0);
  for (const connection of props.connections) {
    if (!coveredConnections.has(connection.id) && !renderedConnections.has(connection.id)) rows.push({ type: "connection", id: connection.id, depth: 0 });
  }
  return rows;
});

watch(
  () => [props.open, props.connections] as const,
  ([open]) => {
    if (open) {
      selectedIds.value = [...connectionIds.value];
      expandedGroupIds.value = new Set(props.layout?.groups.map((group) => group.id) ?? []);
    }
  },
  { immediate: true },
);

function isSelected(id: string) {
  return selectedIds.value.includes(id);
}

function toggle(id: string, checked: boolean) {
  if (checked) {
    if (!selectedIds.value.includes(id)) selectedIds.value = [...selectedIds.value, id];
    return;
  }
  selectedIds.value = selectedIds.value.filter((selectedId) => selectedId !== id);
}

function selectAll() {
  selectedIds.value = [...connectionIds.value];
}

function deselectAll() {
  selectedIds.value = [];
}

function toggleGroupExpanded(id: string) {
  const expanded = new Set(expandedGroupIds.value);
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  expandedGroupIds.value = expanded;
}

function groupSelectionState(id: string) {
  const ids = groupConnectionIds.value.get(id) ?? [];
  const selected = ids.filter((connectionId) => selectedIds.value.includes(connectionId)).length;
  return { checked: ids.length > 0 && selected === ids.length, indeterminate: selected > 0 && selected < ids.length, disabled: ids.length === 0 };
}

function toggleGroup(id: string, checked: boolean) {
  const descendants = groupConnectionIds.value.get(id) ?? [];
  const selected = new Set(selectedIds.value);
  for (const connectionId of descendants) {
    if (checked) selected.add(connectionId);
    else selected.delete(connectionId);
  }
  selectedIds.value = connectionIds.value.filter((connectionId) => selected.has(connectionId));
}

function connectionById(id: string) {
  return props.connections.find((connection) => connection.id === id);
}

function confirm() {
  if (!canConfirm.value || props.busy) return;
  emit("confirm", [...selectedIds.value]);
}

function connectionMeta(connection: ConnectionConfig) {
  const parts = [connectionDriverLabel(connection), connectionEndpointLabel(connection), connection.database].filter((part) => !!part && String(part).trim().length > 0);
  return parts.join(" · ");
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle class="flex items-center justify-between gap-3 pr-8">
          <span>{{ mode === "export" ? t("configExport.selectExportTitle") : t("configExport.selectImportTitle") }}</span>
          <span class="text-sm font-normal text-muted-foreground">{{ t("configExport.selectedCount", { selected: selectedCount, total: connections.length }) }}</span>
        </DialogTitle>
      </DialogHeader>

      <div class="grid gap-3 py-2">
        <div class="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" :disabled="busy" @click="selectAll">{{ t("configExport.selectAll") }}</Button>
          <Button type="button" variant="outline" size="sm" :disabled="busy" @click="deselectAll">{{ t("configExport.deselectAll") }}</Button>
        </div>

        <ScrollArea class="h-72 min-w-0 rounded-md border">
          <div v-if="connections.length === 0" class="px-3 py-8 text-center text-sm text-muted-foreground">
            {{ t("configExport.noConnections") }}
          </div>
          <template v-for="row in treeRows" :key="`${row.type}:${row.id}`">
            <div v-if="row.type === 'group'" class="flex items-center gap-2 border-b px-3 py-2 hover:bg-muted/50" :style="{ paddingLeft: `${12 + row.depth * 20}px` }">
              <button type="button" class="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground" :disabled="busy" :aria-label="row.name" :aria-expanded="expandedGroupIds.has(row.id)" @click="toggleGroupExpanded(row.id)">
                <ChevronDown v-if="expandedGroupIds.has(row.id)" class="h-3.5 w-3.5" />
                <ChevronRight v-else class="h-3.5 w-3.5" />
              </button>
              <input
                type="checkbox"
                class="accent-primary shrink-0"
                :checked="groupSelectionState(row.id).checked"
                :indeterminate="groupSelectionState(row.id).indeterminate"
                :disabled="busy || groupSelectionState(row.id).disabled"
                @change="toggleGroup(row.id, ($event.target as HTMLInputElement).checked)"
              />
              <Folder class="h-4 w-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ row.name }}</span>
            </div>
            <label v-else-if="connectionById(row.id)" class="flex cursor-pointer items-start gap-3 border-b px-3 py-2 last:border-b-0 hover:bg-muted/50" :style="{ paddingLeft: `${48 + row.depth * 20}px` }">
              <input type="checkbox" class="mt-1 accent-primary shrink-0" :checked="isSelected(row.id)" :disabled="busy" @change="toggle(row.id, ($event.target as HTMLInputElement).checked)" />
              <DatabaseIcon :db-type="connectionIconType(connectionById(row.id)!)" class="mt-0.5 h-4 w-4 shrink-0" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium">{{ connectionById(row.id)!.name }}</span>
                <span class="block truncate text-xs text-muted-foreground">{{ connectionMeta(connectionById(row.id)!) }}</span>
              </span>
            </label>
          </template>
        </ScrollArea>
      </div>

      <DialogFooter>
        <Button type="button" :disabled="!canConfirm || busy" @click="confirm">
          <Loader2 v-if="busy" class="mr-1.5 h-4 w-4 animate-spin" />
          {{ mode === "export" ? t("configExport.next") : t("configExport.importSelected", { count: selectedCount }) }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
