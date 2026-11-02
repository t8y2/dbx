<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { TabsContent } from "@/components/ui/tabs";
import type { BinaryHexViewRow } from "@/lib/dataGrid/binaryHexViewer";

interface DataGridCellDetailHexViewerProps {
  rows: BinaryHexViewRow[];
  byteCount: number;
}

const props = defineProps<DataGridCellDetailHexViewerProps>();

const { t } = useI18n();
</script>

<template>
  <TabsContent value="hexViewer" class="m-0 min-h-0 min-w-0 flex-1 flex flex-col p-3 text-xs">
    <div class="mb-2 min-w-0 shrink-0">
      <div class="font-medium">{{ t("grid.hexViewer") }}</div>
      <div class="text-[11px] text-muted-foreground">
        {{ t("grid.hexViewerByteCount", { count: props.byteCount }) }}
      </div>
    </div>
    <div class="min-h-0 flex-1 overflow-auto rounded border bg-muted/20 font-mono text-[11px]">
      <div class="sticky top-0 grid grid-cols-[5.5rem_minmax(24rem,1fr)_8rem] gap-3 border-b bg-muted px-2 py-1 font-semibold text-muted-foreground">
        <div>{{ t("grid.hexViewerOffset") }}</div>
        <div>{{ t("grid.hexViewerHex") }}</div>
        <div>{{ t("grid.hexViewerAscii") }}</div>
      </div>
      <div v-for="row in props.rows" :key="row.offset" class="grid grid-cols-[5.5rem_minmax(24rem,1fr)_8rem] gap-3 border-b border-border/50 px-2 py-1 last:border-b-0">
        <div class="select-all text-muted-foreground">{{ row.offset }}</div>
        <div class="select-all whitespace-pre">{{ row.hex }}</div>
        <div class="select-all whitespace-pre">{{ row.ascii }}</div>
      </div>
      <div v-if="props.rows.length === 0" class="px-2 py-6 text-center font-sans text-muted-foreground">
        {{ t("grid.hexViewerEmpty") }}
      </div>
    </div>
  </TabsContent>
</template>
