<script setup lang="ts">
import { computed } from "vue";
import { Cable, FileCode, Layers3, Search, Server, Table2, Terminal } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { QuickOpenItem } from "@/composables/useQuickOpen";

const props = defineProps<{
  items: QuickOpenItem[];
  selectedId?: string;
}>();

const emit = defineEmits<{
  open: [item: QuickOpenItem];
  hover: [item: QuickOpenItem];
  token: [value: string];
  content: [];
}>();

const { t } = useI18n();

const groups = computed(() =>
  [
    { id: "connections", label: t("quickOpen.homeConnections"), items: props.items.filter((item) => item.type === "connection") },
    { id: "files", label: t("quickOpen.homeRecentFiles"), items: props.items.filter((item) => item.type === "sql_file" || item.type === "sql_library_file") },
    { id: "objects", label: t("quickOpen.homeRecentObjects"), items: props.items.filter((item) => !["connection", "sql_file", "sql_library_file", "plugin_command", "plugin_workbench"].includes(item.type)) },
    { id: "commands", label: t("quickOpen.homeRecentCommands"), items: props.items.filter((item) => item.type === "plugin_command" || item.type === "plugin_workbench") },
  ].filter((group) => group.items.length > 0),
);

function iconFor(item: QuickOpenItem): typeof Table2 {
  if (item.type === "connection") return Cable;
  if (item.type === "sql_file" || item.type === "sql_library_file") return FileCode;
  if (item.type === "column") return Layers3;
  if (item.type === "plugin_command" || item.type === "plugin_workbench") return Terminal;
  return Table2;
}
</script>

<template>
  <div class="space-y-5 p-5">
    <div>
      <div class="flex items-center gap-2 text-lg font-semibold text-foreground"><Search class="h-5 w-5 text-muted-foreground" />{{ t("quickOpen.homeTitle") }}</div>
      <div class="mt-1 text-xs text-muted-foreground">{{ t("quickOpen.homeDescription") }}</div>
    </div>

    <div class="grid gap-2 sm:grid-cols-2">
      <button class="rounded-lg border bg-background p-3 text-left hover:border-foreground/30 hover:bg-muted/40" @click="emit('token', 'kind:column')">
        <div class="flex items-center gap-2 text-sm font-medium"><Layers3 class="h-4 w-4 text-muted-foreground" />{{ t("quickOpen.homeSearchFields") }}</div>
        <div class="mt-1 text-xs text-muted-foreground">{{ t("quickOpen.homeSearchFieldsHint") }}</div>
      </button>
      <button class="rounded-lg border bg-background p-3 text-left hover:border-foreground/30 hover:bg-muted/40" @click="emit('token', 'kind:object')">
        <div class="flex items-center gap-2 text-sm font-medium"><Table2 class="h-4 w-4 text-muted-foreground" />{{ t("quickOpen.homeSearchObjects") }}</div>
        <div class="mt-1 text-xs text-muted-foreground">{{ t("quickOpen.homeSearchObjectsHint") }}</div>
      </button>
      <button class="rounded-lg border bg-background p-3 text-left hover:border-foreground/30 hover:bg-muted/40" @click="emit('content')">
        <div class="flex items-center gap-2 text-sm font-medium"><FileCode class="h-4 w-4 text-muted-foreground" />{{ t("quickOpen.homeSearchContent") }}</div>
        <div class="mt-1 text-xs text-muted-foreground">{{ t("quickOpen.homeSearchContentHint") }}</div>
      </button>
      <button class="rounded-lg border bg-background p-3 text-left hover:border-foreground/30 hover:bg-muted/40" @click="emit('token', 'source:remote')">
        <div class="flex items-center gap-2 text-sm font-medium"><Server class="h-4 w-4 text-muted-foreground" />{{ t("quickOpen.homeSearchRemote") }}</div>
        <div class="mt-1 text-xs text-muted-foreground">{{ t("quickOpen.homeSearchRemoteHint") }}</div>
      </button>
    </div>

    <div v-if="groups.length > 0" class="space-y-4">
      <div class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{{ t("quickOpen.homeRecentWork") }}</div>
      <section v-for="group in groups" :key="group.id">
        <div class="mb-1.5 flex items-center justify-between px-1 text-[11px] font-medium text-muted-foreground">
          <span>{{ group.label }}</span
          ><span>{{ group.items.length }}</span>
        </div>
        <div class="grid gap-1 sm:grid-cols-2">
          <button
            v-for="item in group.items"
            :key="item.id"
            :data-selected="item.id === props.selectedId"
            class="flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-muted"
            :class="item.id === props.selectedId ? 'bg-accent' : ''"
            @click="emit('open', item)"
            @mouseenter="emit('hover', item)"
          >
            <component :is="iconFor(item)" class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ item.label }}</span>
            <span class="max-w-[45%] truncate text-[10px] text-muted-foreground">{{ item.connectionName || item.description }}</span>
          </button>
        </div>
      </section>
    </div>
    <div v-else class="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">{{ t("quickOpen.homeNoRecentWork") }}</div>
  </div>
</template>
