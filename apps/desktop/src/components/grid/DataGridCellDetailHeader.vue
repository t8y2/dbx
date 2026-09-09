<script setup lang="ts">
import { ChevronDown, ChevronRight, ListTree, Maximize2, PanelBottom, PanelRight, TableProperties, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CellDetailTab } from "@/lib/dataGrid/cellDetailPresentation";

interface DataGridCellDetailHeaderProps {
  metadataCollapsed: boolean;
  panelIsBottom: boolean;
  activeTabs: CellDetailTab[];
}

const props = defineProps<DataGridCellDetailHeaderProps>();

const emit = defineEmits<{
  toggleMetadata: [];
  toggleLayout: [];
  openCellDetails: [];
  openRowDetails: [];
  openColumnDetails: [];
  close: [];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="h-9 flex min-w-0 items-center gap-2 overflow-hidden border-b bg-muted/20 px-3 shrink-0">
    <Button
      variant="ghost"
      size="icon"
      class="h-5 w-5 shrink-0"
      :title="props.metadataCollapsed ? t('grid.expandCellDetailMetadata') : t('grid.collapseCellDetailMetadata')"
      :aria-label="props.metadataCollapsed ? t('grid.expandCellDetailMetadata') : t('grid.collapseCellDetailMetadata')"
      :aria-expanded="!props.metadataCollapsed"
      @click="emit('toggleMetadata')"
    >
      <ChevronRight v-if="props.metadataCollapsed" class="w-3 h-3" />
      <ChevronDown v-else class="w-3 h-3" />
    </Button>
    <div class="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain">
      <TabsList class="flex h-7 w-max min-w-full justify-start p-0.5">
        <TabsTrigger value="details" class="h-6 min-w-max flex-1 shrink-0 text-xs">{{ t("grid.cellDetails") }}</TabsTrigger>
        <TabsTrigger v-if="props.activeTabs.includes('hexViewer')" value="hexViewer" class="h-6 min-w-max flex-1 shrink-0 text-xs">
          {{ t("grid.hexViewer") }}
        </TabsTrigger>
        <TabsTrigger v-if="props.activeTabs.includes('valueEditor')" value="valueEditor" class="h-6 min-w-max flex-1 shrink-0 text-xs">
          {{ t("grid.valueEditor") }}
        </TabsTrigger>
      </TabsList>
    </div>
    <div class="ml-auto flex shrink-0 items-center gap-1">
      <Button variant="ghost" size="icon" class="h-5 w-5" :title="props.panelIsBottom ? t('grid.cellDetailLayoutRight') : t('grid.cellDetailLayoutBottom')" @click="emit('toggleLayout')">
        <PanelRight v-if="props.panelIsBottom" class="w-3 h-3" />
        <PanelBottom v-else class="w-3 h-3" />
      </Button>
      <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.openCellDetailsDialog')" @click="emit('openCellDetails')">
        <Maximize2 class="w-3 h-3" />
      </Button>
      <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.openRowDetailsDialog')" @click="emit('openRowDetails')">
        <ListTree class="w-3 h-3" />
      </Button>
      <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.openColumnDetailsDialog')" @click="emit('openColumnDetails')">
        <TableProperties class="w-3 h-3" />
      </Button>
      <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('close')">
        <X class="w-3 h-3" />
      </Button>
    </div>
  </div>
</template>
