<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { connectionDriverLabel, connectionEndpointLabel, connectionIconType } from "@/lib/connection/connectionPresentation";
import type { ConnectionConfig } from "@/types/database";

const props = defineProps<{
  open: boolean;
  mode: "export" | "import";
  busy?: boolean;
  connections: ConnectionConfig[];
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  confirm: [connectionIds: string[]];
}>();

const { t } = useI18n();
const selectedIds = ref<string[]>([]);

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

watch(
  () => [props.open, props.connections] as const,
  ([open]) => {
    if (open) selectedIds.value = [...connectionIds.value];
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
          <label v-for="connection in connections" :key="connection.id" class="flex cursor-pointer items-start gap-3 border-b px-3 py-2 last:border-b-0 hover:bg-muted/50">
            <input type="checkbox" class="mt-1 accent-primary shrink-0" :checked="isSelected(connection.id)" :disabled="busy" @change="toggle(connection.id, ($event.target as HTMLInputElement).checked)" />
            <DatabaseIcon :db-type="connectionIconType(connection)" class="mt-0.5 h-4 w-4 shrink-0" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ connection.name }}</span>
              <span class="block truncate text-xs text-muted-foreground">{{ connectionMeta(connection) }}</span>
            </span>
          </label>
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
