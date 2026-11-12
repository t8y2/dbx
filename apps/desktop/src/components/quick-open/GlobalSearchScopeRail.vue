<script setup lang="ts">
import { ChevronRight, Circle, Server } from "@lucide/vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "vue-i18n";
import type { ConnectionConfig } from "@/types/database";

const props = defineProps<{
  contentMode: boolean;
  previewEditing: boolean;
  scopeSelection: string;
  scopeAllValue: string;
  connections: ConnectionConfig[];
  connectedIds?: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  "update:scopeSelection": [value: string];
  token: [value: string];
}>();

const { t } = useI18n();
const quickFilters = ["kind:column", "kind:table", "kind:file", "source:remote"];
</script>

<template>
  <aside class="min-h-0 overflow-y-auto border-b bg-muted/10 p-3 md:border-b-0 md:border-r" :class="props.contentMode ? 'hidden md:block' : 'block'">
    <div class="mb-2 hidden items-center justify-between px-1 md:flex">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{{ t("quickOpen.scopePanel") }}</span>
      <Server class="h-3.5 w-3.5 text-muted-foreground" />
    </div>
    <Select v-if="!props.contentMode" :model-value="props.scopeSelection" :disabled="props.previewEditing" @update:model-value="emit('update:scopeSelection', $event)">
      <SelectTrigger class="mb-3 h-8 w-full gap-1 px-2 text-xs" :title="t('quickOpen.scope')"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem :value="props.scopeAllValue">{{ t("quickOpen.scopeAll") }}</SelectItem>
        <SelectItem v-for="connection in props.connections" :key="connection.id" :value="connection.id">{{ connection.name }}</SelectItem>
      </SelectContent>
    </Select>
    <div class="hidden md:block">
      <div class="mb-2 px-1 text-[11px] font-medium text-muted-foreground">{{ t("quickOpen.currentConnections") }}</div>
      <button v-for="connection in props.connections.slice(0, 8)" :key="connection.id" class="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted" :disabled="props.previewEditing || props.contentMode" @click="emit('update:scopeSelection', connection.id)">
        <Circle class="h-2.5 w-2.5 shrink-0" :class="props.connectedIds?.has(connection.id) ? 'fill-emerald-500 text-emerald-500' : 'text-muted-foreground'" />
        <span class="min-w-0 flex-1 truncate">{{ connection.name }}</span>
        <ChevronRight class="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>
      <div v-if="props.connections.length === 0" class="px-1 py-4 text-xs text-muted-foreground">{{ t("quickOpen.noConnections") }}</div>
      <div class="mt-5 border-t pt-3">
        <div class="mb-2 px-1 text-[11px] font-medium text-muted-foreground">{{ t("quickOpen.quickFilters") }}</div>
        <button v-for="token in quickFilters" :key="token" class="mb-1 flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground" :disabled="props.previewEditing" @click="emit('token', token)">
          {{ token }}
        </button>
      </div>
    </div>
  </aside>
</template>
