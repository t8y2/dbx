<script setup lang="ts">
import { ArrowUpRight } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import type { CellValue } from "@/lib/dataGrid/cellValue";

export interface ForeignKeyRowPreviewState {
  status: "idle" | "loading" | "ready" | "empty" | "error";
  /** Referenced table, schema-qualified when the foreign key names a schema. */
  table: string;
  columns: string[];
  row: CellValue[];
  message: string;
}

interface DataGridCellDetailForeignKeyProps {
  preview: ForeignKeyRowPreviewState;
}

const props = defineProps<DataGridCellDetailForeignKeyProps>();

const emit = defineEmits<{ open: [] }>();

const { t } = useI18n();
</script>

<template>
  <TabsContent value="foreignKey" class="m-0 min-h-0 min-w-0 flex-1 flex flex-col p-3 text-xs">
    <div class="mb-2 flex min-w-0 shrink-0 items-center gap-2">
      <div class="min-w-0 flex-1">
        <div class="font-medium">{{ t("grid.foreignKeyPreview") }}</div>
        <div v-if="props.preview.table" class="truncate text-[11px] text-muted-foreground" :title="props.preview.table">{{ props.preview.table }}</div>
      </div>
      <Button variant="outline" size="sm" class="h-6 shrink-0 gap-1 text-xs" @click="emit('open')">
        <ArrowUpRight class="h-3 w-3" />
        {{ t("grid.foreignKeyPreviewOpen") }}
      </Button>
    </div>
    <div v-if="props.preview.status === 'loading'" class="py-6 text-center text-muted-foreground">{{ t("grid.foreignKeyPreviewLoading") }}</div>
    <div v-else-if="props.preview.status === 'error'" class="break-words py-2 text-destructive">{{ t("grid.foreignKeyPreviewFailed", { message: props.preview.message }) }}</div>
    <div v-else-if="props.preview.status === 'empty'" class="py-6 text-center text-muted-foreground">{{ t("grid.foreignKeyPreviewEmpty", { table: props.preview.table }) }}</div>
    <div v-else-if="props.preview.status === 'ready'" class="min-h-0 flex-1 overflow-auto rounded border bg-muted/20 text-[11px]">
      <div v-for="(column, index) in props.preview.columns" :key="`${index}:${column}`" class="grid grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)] gap-3 border-b border-border/50 px-2 py-1 last:border-b-0">
        <div class="truncate font-medium text-muted-foreground" :title="column">{{ column }}</div>
        <div v-if="props.preview.row[index] === null || props.preview.row[index] === undefined" class="font-mono italic text-muted-foreground">NULL</div>
        <div v-else class="select-all whitespace-pre-wrap break-all font-mono">{{ String(props.preview.row[index]) }}</div>
      </div>
    </div>
  </TabsContent>
</template>
