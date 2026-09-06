<script setup lang="ts">
import { computed } from "vue";
import { Check, ChevronDown, Copy, Eye, Loader2, Map, Plus, RefreshCcw, RotateCcw, Rows3, Save, TableProperties, Timer, Trash2, Upload } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DATA_GRID_TOOLBAR_ACTION_COLLAPSE_ORDER,
  dataGridToolbarIntervalOptions,
  isDataGridToolbarActionCompact,
  isDataGridToolbarCapabilityDisabled,
  isDataGridToolbarCapabilityVisible,
  selectDataGridToolbarAddRowItem,
  selectDataGridToolbarAutoRefreshInterval,
  selectDataGridToolbarCopyItem,
  selectDataGridToolbarExportItem,
  toggleDataGridToolbarAutoRefresh,
  triggerDataGridToolbarCopy,
  triggerDataGridToolbarAction,
  type DataGridToolbarActionCapability,
  type DataGridToolbarActionKey,
  type DataGridToolbarAddRowCapability,
  type DataGridToolbarAutoRefreshCapability,
  type DataGridToolbarCopyCapability,
  type DataGridToolbarExportCapability,
  type DataGridToolbarSaveCapability,
} from "@/lib/dataGrid/dataGridToolbar";

const props = defineProps<{
  compact?: boolean;
  compactActionCount?: number;
  navigationVisible?: boolean;
  refresh: DataGridToolbarActionCapability;
  autoRefresh?: DataGridToolbarAutoRefreshCapability;
  addRow?: DataGridToolbarAddRowCapability;
  deleteRow?: DataGridToolbarActionCapability;
  copyData?: DataGridToolbarCopyCapability;
  exportData?: DataGridToolbarExportCapability;
  transpose?: DataGridToolbarActionCapability;
  tableInfo?: DataGridToolbarActionCapability;
  layerPreview?: DataGridToolbarActionCapability;
  preview?: DataGridToolbarActionCapability;
  save?: DataGridToolbarSaveCapability;
  rollback?: DataGridToolbarActionCapability;
}>();

const autoRefreshIntervals = computed(() => (props.autoRefresh ? dataGridToolbarIntervalOptions(props.autoRefresh.intervalOptions, props.autoRefresh.intervalSeconds) : []));
const visibleActionOrder = computed<DataGridToolbarActionKey[]>(() => {
  const visibility: Record<DataGridToolbarActionKey, boolean> = {
    refresh: isDataGridToolbarCapabilityVisible(props.refresh),
    autoRefresh: isDataGridToolbarCapabilityVisible(props.autoRefresh),
    navigation: props.navigationVisible === true,
    copyData: isDataGridToolbarCapabilityVisible(props.copyData),
    addRow: isDataGridToolbarCapabilityVisible(props.addRow),
    deleteRow: isDataGridToolbarCapabilityVisible(props.deleteRow),
    exportData: isDataGridToolbarCapabilityVisible(props.exportData),
    transpose: isDataGridToolbarCapabilityVisible(props.transpose),
    tableInfo: isDataGridToolbarCapabilityVisible(props.tableInfo),
    layerPreview: isDataGridToolbarCapabilityVisible(props.layerPreview),
    preview: isDataGridToolbarCapabilityVisible(props.preview),
    save: isDataGridToolbarCapabilityVisible(props.save),
    rollback: isDataGridToolbarCapabilityVisible(props.rollback),
  };
  return DATA_GRID_TOOLBAR_ACTION_COLLAPSE_ORDER.filter((action) => visibility[action]);
});

function actionIsCompact(action: DataGridToolbarActionKey): boolean {
  return isDataGridToolbarActionCompact(action, visibleActionOrder.value, props.compactActionCount ?? 0, props.compact === true);
}

function actionButtonClass(action: DataGridToolbarActionKey) {
  return ["data-grid-topbar-action-button h-5 shrink-0 px-1.5 text-xs", actionIsCompact(action) ? "data-grid-topbar-action-button--compact" : ""];
}

function actionLabelClass(action: DataGridToolbarActionKey) {
  return { "data-grid-topbar-action-label--compact": actionIsCompact(action) };
}
</script>

<template>
  <div class="flex shrink-0 items-center gap-1 px-1">
    <slot name="leading" />

    <Tooltip v-if="isDataGridToolbarCapabilityVisible(refresh)">
      <TooltipTrigger as-child>
        <Button data-toolbar-action="refresh" variant="ghost" size="sm" :class="actionButtonClass('refresh')" :disabled="isDataGridToolbarCapabilityDisabled(refresh)" @click="void triggerDataGridToolbarAction(refresh)">
          <Loader2 v-if="refresh.loading" class="data-grid-topbar-action-icon h-3 w-3 animate-spin" />
          <RefreshCcw v-else class="data-grid-topbar-action-icon h-3 w-3" />
          <span class="data-grid-topbar-action-label" :class="actionLabelClass('refresh')">{{ refresh.label }}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{{ refresh.tooltip ?? refresh.label }}</TooltipContent>
    </Tooltip>

    <DropdownMenu v-if="isDataGridToolbarCapabilityVisible(autoRefresh)">
      <DropdownMenuTrigger as-child>
        <Button
          variant="ghost"
          size="sm"
          data-toolbar-action="autoRefresh"
          :class="[...actionButtonClass('autoRefresh'), autoRefresh?.enabled ? 'bg-primary/10 text-primary hover:bg-primary/15' : 'text-muted-foreground hover:text-foreground']"
          :disabled="isDataGridToolbarCapabilityDisabled(autoRefresh)"
          :title="autoRefresh?.label"
          :aria-label="autoRefresh?.label"
          :aria-pressed="autoRefresh?.enabled"
        >
          <Timer class="data-grid-topbar-action-icon h-3 w-3" />
          <span class="data-grid-topbar-action-label" :class="actionLabelClass('autoRefresh')">{{ autoRefresh?.enabled ? `${autoRefresh.intervalSeconds}s` : autoRefresh?.shortLabel }}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-40">
        <DropdownMenuItem class="gap-2" :disabled="autoRefresh?.disabled" @select="void toggleDataGridToolbarAutoRefresh(autoRefresh)">
          <Check v-if="autoRefresh?.enabled" class="h-3.5 w-3.5" />
          <span v-else class="h-3.5 w-3.5" />
          {{ autoRefresh?.enabled ? autoRefresh.stopLabel : autoRefresh?.startLabel }}
        </DropdownMenuItem>
        <DropdownMenuItem v-for="seconds in autoRefreshIntervals" :key="seconds" class="gap-2" :disabled="autoRefresh?.disabled" @select="void selectDataGridToolbarAutoRefreshInterval(autoRefresh, seconds)">
          <Check v-if="autoRefresh?.intervalSeconds === seconds" class="h-3.5 w-3.5" />
          <span v-else class="h-3.5 w-3.5" />
          {{ autoRefresh?.intervalLabel(seconds) }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <slot name="navigation" :compact="actionIsCompact('navigation')" />

    <div v-if="isDataGridToolbarCapabilityVisible(copyData)" class="flex h-5 shrink-0 items-stretch overflow-hidden rounded-md border border-border">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button data-toolbar-action="copyData" variant="ghost" size="sm" :class="[...actionButtonClass('copyData'), 'rounded-none border-0']" :disabled="copyData?.disabled" @click="void triggerDataGridToolbarCopy(copyData)">
            <Copy class="data-grid-topbar-action-icon h-3 w-3" />
            <span class="data-grid-topbar-action-label" :class="actionLabelClass('copyData')">{{ copyData?.label }}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{{ copyData?.tooltip ?? copyData?.label }}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="h-5 w-5 rounded-none border-0 border-l border-border" :aria-label="copyData?.label">
            <ChevronDown class="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-52">
          <template v-for="item in copyData?.items ?? []" :key="item.value">
            <DropdownMenuSeparator v-if="item.separatorBefore" />
            <DropdownMenuItem class="gap-2" :disabled="item.disabled" @select="void selectDataGridToolbarCopyItem(copyData, item.value)">
              <span class="flex-1">{{ item.label }}</span>
              <Check v-if="copyData?.currentValue === item.value" class="h-3.5 w-3.5 shrink-0 text-primary" />
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div v-if="isDataGridToolbarCapabilityVisible(addRow)" class="flex h-5 shrink-0 items-stretch overflow-hidden rounded-md border border-border">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button data-toolbar-action="addRow" variant="ghost" size="sm" :class="[...actionButtonClass('addRow'), 'rounded-none border-0']" :disabled="isDataGridToolbarCapabilityDisabled(addRow)" @click="void triggerDataGridToolbarAction(addRow)">
            <Plus class="data-grid-topbar-action-icon h-3 w-3" />
            <span class="data-grid-topbar-action-label" :class="actionLabelClass('addRow')">{{ addRow?.label }}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{{ addRow?.tooltip ?? addRow?.label }}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="h-5 w-5 rounded-none border-0 border-l border-border" :aria-label="addRow?.label" :disabled="isDataGridToolbarCapabilityDisabled(addRow)">
            <ChevronDown class="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-52">
          <template v-for="item in addRow?.items ?? []" :key="item.value">
            <DropdownMenuSeparator v-if="item.separatorBefore" />
            <DropdownMenuItem class="gap-2" :disabled="item.disabled" @select="void selectDataGridToolbarAddRowItem(addRow, item.value)">
              <Check v-if="item.selected" class="h-3.5 w-3.5 shrink-0 text-primary" />
              <span v-else class="h-3.5 w-3.5 shrink-0" />
              <span class="flex-1">{{ item.label }}</span>
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <Tooltip v-if="isDataGridToolbarCapabilityVisible(deleteRow)">
      <TooltipTrigger as-child>
        <Button data-toolbar-action="deleteRow" variant="ghost" size="sm" :class="actionButtonClass('deleteRow')" :disabled="isDataGridToolbarCapabilityDisabled(deleteRow)" @click="void triggerDataGridToolbarAction(deleteRow)">
          <Trash2 class="data-grid-topbar-action-icon h-3 w-3" />
          <span class="data-grid-topbar-action-label" :class="actionLabelClass('deleteRow')">{{ deleteRow?.label }}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{{ deleteRow?.tooltip ?? deleteRow?.label }}</TooltipContent>
    </Tooltip>

    <DropdownMenu v-if="isDataGridToolbarCapabilityVisible(exportData)">
      <Tooltip>
        <TooltipTrigger as-child>
          <DropdownMenuTrigger as-child>
            <Button data-toolbar-action="exportData" variant="ghost" size="sm" :class="actionButtonClass('exportData')" :disabled="exportData?.disabled || !exportData?.items.length">
              <Upload class="data-grid-topbar-action-icon h-3 w-3" />
              <span class="data-grid-topbar-action-label" :class="actionLabelClass('exportData')">{{ exportData?.label }}</span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{{ exportData?.label }}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" class="min-w-52">
        <template v-for="item in exportData?.items ?? []" :key="item.value">
          <DropdownMenuSeparator v-if="item.separatorBefore" />
          <DropdownMenuItem :disabled="item.disabled" @select="void selectDataGridToolbarExportItem(exportData, item.value)">
            {{ item.label }}
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>

    <Tooltip v-if="isDataGridToolbarCapabilityVisible(transpose)">
      <TooltipTrigger as-child>
        <Button
          data-toolbar-action="transpose"
          variant="ghost"
          size="sm"
          :class="[...actionButtonClass('transpose'), transpose?.active ? 'bg-primary/10 text-primary hover:bg-primary/15' : '']"
          :disabled="isDataGridToolbarCapabilityDisabled(transpose)"
          :aria-pressed="transpose?.active"
          @click="void triggerDataGridToolbarAction(transpose)"
        >
          <Rows3 class="data-grid-topbar-action-icon h-3 w-3" />
          <span class="data-grid-topbar-action-label" :class="actionLabelClass('transpose')">{{ transpose?.label }}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{{ transpose?.tooltip ?? transpose?.label }}</TooltipContent>
    </Tooltip>

    <Tooltip v-if="isDataGridToolbarCapabilityVisible(tableInfo)">
      <TooltipTrigger as-child>
        <Button
          data-toolbar-action="tableInfo"
          variant="ghost"
          size="sm"
          :class="[...actionButtonClass('tableInfo'), tableInfo?.active ? 'bg-primary/10 text-primary hover:bg-primary/15' : '']"
          :disabled="isDataGridToolbarCapabilityDisabled(tableInfo)"
          :aria-pressed="tableInfo?.active"
          @click="void triggerDataGridToolbarAction(tableInfo)"
        >
          <TableProperties class="data-grid-topbar-action-icon h-3 w-3" />
          <span class="data-grid-topbar-action-label" :class="actionLabelClass('tableInfo')">{{ tableInfo?.label }}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{{ tableInfo?.tooltip ?? tableInfo?.label }}</TooltipContent>
    </Tooltip>

    <Tooltip v-if="isDataGridToolbarCapabilityVisible(layerPreview)">
      <TooltipTrigger as-child>
        <Button data-toolbar-action="layerPreview" variant="ghost" size="sm" :class="actionButtonClass('layerPreview')" :disabled="isDataGridToolbarCapabilityDisabled(layerPreview)" @click="void triggerDataGridToolbarAction(layerPreview)">
          <Map class="data-grid-topbar-action-icon h-3 w-3" />
          <span class="data-grid-topbar-action-label" :class="actionLabelClass('layerPreview')">{{ layerPreview?.label }}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{{ layerPreview?.tooltip ?? layerPreview?.label }}</TooltipContent>
    </Tooltip>

    <Tooltip v-if="isDataGridToolbarCapabilityVisible(preview)">
      <TooltipTrigger as-child>
        <Button data-toolbar-action="preview" variant="ghost" size="sm" :class="[...actionButtonClass('preview'), 'text-sky-600 hover:bg-sky-500/10 hover:text-sky-700']" :disabled="isDataGridToolbarCapabilityDisabled(preview)" @click="void triggerDataGridToolbarAction(preview)">
          <Loader2 v-if="preview?.loading" class="data-grid-topbar-action-icon h-3 w-3 animate-spin" />
          <Eye v-else class="data-grid-topbar-action-icon h-3 w-3" />
          <span class="data-grid-topbar-action-label" :class="actionLabelClass('preview')">{{ preview?.label }}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" class="max-w-sm">{{ preview?.tooltip ?? preview?.label }}</TooltipContent>
    </Tooltip>

    <Tooltip v-if="isDataGridToolbarCapabilityVisible(save)">
      <TooltipTrigger as-child>
        <Button data-toolbar-action="save" variant="default" size="sm" :class="[...actionButtonClass('save'), 'data-grid-topbar-action-button--commit relative']" :disabled="isDataGridToolbarCapabilityDisabled(save)" @click="void triggerDataGridToolbarAction(save)">
          <Loader2 v-if="save?.loading" class="data-grid-topbar-action-icon h-3 w-3 animate-spin" />
          <Save v-else-if="actionIsCompact('save') || !save?.pendingCount" class="data-grid-topbar-action-icon h-3 w-3" />
          <span
            v-if="save && save.pendingCount > 0"
            :class="
              actionIsCompact('save')
                ? 'absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-300 px-1 text-[9px] font-semibold leading-none text-amber-950 shadow-[0_0_0_1px_rgba(120,53,15,0.16)] dark:bg-amber-400'
                : 'mr-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-300 px-1 text-[9px] font-semibold leading-none text-amber-950 shadow-[0_0_0_1px_rgba(120,53,15,0.16)] dark:bg-amber-400'
            "
          >
            {{ save.pendingCount }}
          </span>
          <span class="data-grid-topbar-action-label" :class="actionLabelClass('save')">{{ save?.label }}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" class="max-w-sm"
        >{{ save?.tooltip ?? save?.label }}<template v-if="save?.shortcutLabel"> ({{ save.shortcutLabel }})</template></TooltipContent
      >
    </Tooltip>

    <Tooltip v-if="isDataGridToolbarCapabilityVisible(rollback)">
      <TooltipTrigger as-child>
        <Button data-toolbar-action="rollback" variant="outline" size="sm" :class="actionButtonClass('rollback')" :disabled="isDataGridToolbarCapabilityDisabled(rollback)" @click="void triggerDataGridToolbarAction(rollback)">
          <RotateCcw class="data-grid-topbar-action-icon h-3 w-3" />
          <span class="data-grid-topbar-action-label" :class="actionLabelClass('rollback')">{{ rollback?.label }}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{{ rollback?.tooltip ?? rollback?.label }}</TooltipContent>
    </Tooltip>

    <slot name="trailing" />
  </div>
</template>

<style>
.data-grid-topbar-action-button {
  align-items: center;
  justify-content: center;
  max-width: 9rem;
  min-width: 1.25rem;
  gap: 0;
  line-height: 1;
  overflow: hidden;
  transition:
    max-width var(--data-grid-topbar-transition-duration, 340ms) var(--data-grid-topbar-transition-easing, cubic-bezier(0.22, 1, 0.36, 1)),
    min-width var(--data-grid-topbar-transition-duration, 340ms) var(--data-grid-topbar-transition-easing, cubic-bezier(0.22, 1, 0.36, 1)),
    padding-inline var(--data-grid-topbar-transition-duration, 340ms) var(--data-grid-topbar-transition-easing, cubic-bezier(0.22, 1, 0.36, 1)),
    color 220ms ease,
    background-color 220ms ease,
    border-color 220ms ease;
}

.data-grid-topbar-action-button--compact {
  max-width: 1.25rem;
  min-width: 1.25rem;
  padding-inline: 0;
}

.data-grid-topbar-action-button--commit.data-grid-topbar-action-button--compact {
  overflow: visible;
}

.data-grid-topbar-action-icon {
  display: block;
  align-self: center;
  flex-shrink: 0;
  transition:
    margin-inline-end var(--data-grid-topbar-transition-duration, 340ms) var(--data-grid-topbar-transition-easing, cubic-bezier(0.22, 1, 0.36, 1)),
    transform var(--data-grid-topbar-transition-duration, 340ms) var(--data-grid-topbar-transition-easing, cubic-bezier(0.22, 1, 0.36, 1));
}

.data-grid-topbar-action-button:not(.data-grid-topbar-action-button--compact) .data-grid-topbar-action-icon {
  margin-inline-end: 0.25rem;
}

.data-grid-topbar-action-button--compact .data-grid-topbar-action-icon {
  margin-inline-end: 0;
  transform: scale(0.96);
}

.data-grid-topbar-action-label {
  display: inline-flex;
  align-items: center;
  height: 1rem;
  max-width: 8rem;
  overflow: hidden;
  white-space: nowrap;
  line-height: 1;
  opacity: 1;
  transform: translateX(0);
  transition:
    max-width var(--data-grid-topbar-transition-duration, 340ms) var(--data-grid-topbar-transition-easing, cubic-bezier(0.22, 1, 0.36, 1)),
    opacity 240ms ease 60ms,
    transform var(--data-grid-topbar-transition-duration, 340ms) var(--data-grid-topbar-transition-easing, cubic-bezier(0.22, 1, 0.36, 1));
}

.data-grid-topbar-action-label--compact {
  max-width: 0;
  opacity: 0;
  transform: translateX(-4px);
}
</style>
