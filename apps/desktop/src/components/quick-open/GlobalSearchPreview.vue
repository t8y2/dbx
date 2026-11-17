<script setup lang="ts">
import { ChevronRight, Server, Table2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { QuickOpenItem } from "@/composables/useQuickOpen";

const props = defineProps<{
  item: QuickOpenItem | null;
  typeBadge: (item: QuickOpenItem) => string;
  sourceLabel: (item: QuickOpenItem) => string;
  context: (item: QuickOpenItem) => string;
  primaryAction: (item: QuickOpenItem) => string;
  secondaryAction: (item: QuickOpenItem) => string;
  secondaryShortcut: string;
  primaryActionHint: (item: QuickOpenItem) => string;
}>();

const { t } = useI18n();

const emit = defineEmits<{ open: []; secondary: [] }>();
</script>

<template>
  <div v-if="props.item" class="space-y-4">
    <div>
      <div class="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Table2 class="h-3.5 w-3.5" />
        {{ props.typeBadge(props.item) }}
      </div>
      <h2 class="break-words text-lg font-semibold text-foreground">{{ props.item.label }}</h2>
      <p class="mt-1 break-words text-xs text-muted-foreground">{{ props.context(props.item) || props.item.description }}</p>
    </div>
    <div class="space-y-2 rounded-lg border bg-background/70 p-3 text-xs">
      <div v-if="props.item.columnName || props.item.columnComment">
        <div class="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{{ t("quickOpen.fieldInfo") }}</div>
        <div v-if="props.item.columnName" class="font-medium">{{ props.item.columnName }}</div>
        <div v-if="props.item.columnComment" class="mt-1 text-muted-foreground">{{ props.item.columnComment }}</div>
      </div>
      <div v-if="props.item.database || props.item.schema || props.item.tableName" class="space-y-1 border-t pt-2">
        <div v-if="props.item.database" class="flex justify-between gap-2">
          <span class="text-muted-foreground">{{ t("quickOpen.database") }}</span
          ><span class="truncate font-medium">{{ props.item.database }}</span>
        </div>
        <div v-if="props.item.schema" class="flex justify-between gap-2">
          <span class="text-muted-foreground">{{ t("quickOpen.schema") }}</span
          ><span class="truncate font-medium">{{ props.item.schema }}</span>
        </div>
        <div v-if="props.item.tableName" class="flex justify-between gap-2">
          <span class="text-muted-foreground">{{ t("quickOpen.table") }}</span
          ><span class="truncate font-medium">{{ props.item.tableName }}</span>
        </div>
      </div>
      <div class="border-t pt-2">
        <span class="text-muted-foreground">{{ t("quickOpen.source") }}</span
        ><span class="ml-2 font-medium">{{ props.sourceLabel(props.item) }}</span>
      </div>
    </div>
    <div class="space-y-2">
      <button class="flex w-full items-center justify-between rounded-md bg-foreground px-3 py-2 text-xs font-medium text-background hover:opacity-90" @click="emit('open')">
        <span>{{ props.primaryAction(props.item) }}</span
        ><ChevronRight class="h-3.5 w-3.5" />
      </button>
      <button v-if="props.item.type === 'column' || props.item.type === 'table' || props.item.type === 'view'" class="flex w-full items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground hover:bg-muted" @click="emit('secondary')">
        {{ props.secondaryAction(props.item) }}
        <span class="text-[10px] opacity-70">{{ props.secondaryShortcut }}</span>
      </button>
      <div class="text-center text-[10px] text-muted-foreground">{{ props.primaryActionHint(props.item) }}</div>
    </div>
  </div>
  <div v-else class="flex h-full min-h-[260px] flex-col items-center justify-center text-center text-xs text-muted-foreground">
    <Server class="mb-3 h-8 w-8 opacity-30" />
    <p>{{ t("quickOpen.previewEmptyTitle") }}</p>
    <p class="mt-1 opacity-70">{{ t("quickOpen.previewEmptyHint") }}</p>
  </div>
</template>
