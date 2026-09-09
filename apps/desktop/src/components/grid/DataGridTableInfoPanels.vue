<script setup lang="ts">
import { KeyRound, Loader2, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { tableColumnDefaultDisplayValue } from "@/lib/table/tableColumnDefaultPresentation";
import type { ColumnInfo, ConstraintInfo, ForeignKeyInfo, IndexInfo, TableInfoTab, TriggerInfo } from "@/types/database";

interface DataGridTableInfoPanelsProps {
  activeTab: TableInfoTab;
  searchQuery: string;
  columns: ColumnInfo[];
  columnsLoading: boolean;
  indexes: IndexInfo[];
  indexesLoading: boolean;
  indexesError: string;
  canManageMongoIndexes: boolean;
  foreignKeys: ForeignKeyInfo[];
  foreignKeysLoading: boolean;
  foreignKeysError: string;
  triggers: TriggerInfo[];
  triggersLoading: boolean;
  triggersError: string;
  constraints: ConstraintInfo[];
  constraintsLoading: boolean;
  constraintsError: string;
  isProtectedMongoIndex: (index: IndexInfo) => boolean;
  formatColumnType: (dataType: string) => string;
}

const props = defineProps<DataGridTableInfoPanelsProps>();

const emit = defineEmits<{
  tableInfoColumnClick: [columnName: string];
  scrollToTableInfoColumn: [columnName: string];
  requestDropMongoIndex: [index: IndexInfo];
}>();

const { t } = useI18n();
</script>

<template>
  <div v-if="props.activeTab === 'columns'" class="flex-1 min-h-0 overflow-auto">
    <div v-if="props.columnsLoading" class="h-full flex items-center justify-center">
      <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
    </div>
    <div v-else-if="props.searchQuery && props.columns.length === 0" class="p-6 text-center text-xs text-muted-foreground">
      {{ t("grid.tableInfoNoResults") }}
    </div>
    <table v-else class="w-full text-xs">
      <thead class="sticky top-0 bg-muted text-muted-foreground">
        <tr class="border-b">
          <th class="text-left text-nowrap font-medium px-3 py-2 w-8">#</th>
          <th class="text-left text-nowrap font-medium px-3 py-2">
            {{ t("grid.columnName") }}
          </th>
          <th class="text-left text-nowrap font-medium px-3 py-2">
            {{ t("grid.columnType") }}
          </th>
          <th class="text-left text-nowrap font-medium px-3 py-2">
            {{ t("grid.tableInfoNullable") }}
          </th>
          <th class="text-left text-nowrap font-medium px-3 py-2">
            {{ t("structureEditor.defaultValue") }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(column, index) in props.columns"
          :key="column.name"
          class="border-b cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-800/30"
          role="button"
          tabindex="0"
          :title="column.name"
          @click="emit('tableInfoColumnClick', column.name)"
          @keydown.enter.prevent="emit('scrollToTableInfoColumn', column.name)"
          @keydown.space.prevent="emit('scrollToTableInfoColumn', column.name)"
        >
          <td class="px-3 py-2 text-muted-foreground w-8">
            {{ index + 1 }}
          </td>
          <td class="cursor-text select-text px-3 py-2 font-medium">
            <span class="inline-flex items-center gap-1.5">
              <KeyRound v-if="column.is_primary_key" class="h-3 w-3 text-amber-500" />
              {{ column.name }}
            </span>
            <div v-if="column.comment" class="mt-0.5 text-[11px] text-muted-foreground truncate">
              {{ column.comment }}
            </div>
          </td>
          <td class="px-3 py-2 font-mono text-[11px] text-muted-foreground">
            {{ props.formatColumnType(column.data_type) }}
          </td>
          <td class="px-3 py-2">
            {{ column.is_nullable ? "YES" : "NO" }}
          </td>
          <td
            data-table-info-column-default
            class="max-w-56 px-3 py-2 font-mono text-[11px]"
            :class="{
              'text-muted-foreground/70': column.column_default == null,
            }"
            :title="column.column_default ?? undefined"
          >
            <span class="block max-w-56 truncate">{{ tableColumnDefaultDisplayValue(column.column_default) }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-else-if="props.activeTab === 'indexes'" class="flex-1 min-h-0 overflow-auto">
    <div v-if="props.indexesLoading" class="h-full flex items-center justify-center">
      <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
    </div>
    <div v-else-if="props.indexesError" class="p-3 text-xs text-destructive">
      {{ props.indexesError }}
    </div>
    <div v-else-if="props.searchQuery && props.indexes.length === 0" class="p-6 text-center text-xs text-muted-foreground">
      {{ t("grid.tableInfoNoResults") }}
    </div>
    <div v-else-if="props.indexes.length === 0" class="p-6 text-center text-xs text-muted-foreground">
      {{ t("grid.tableInfoEmpty") }}
    </div>
    <div v-else class="divide-y">
      <div v-for="index in props.indexes" :key="index.name" class="p-3 text-xs">
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="font-medium truncate">{{ index.name }}</div>
            <div class="mt-1 flex flex-wrap gap-1">
              <span v-if="index.is_primary" class="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600">PK</span>
              <span v-if="index.is_unique" class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600">UNIQUE</span>
              <span v-if="index.index_type" class="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{{ index.index_type }}</span>
            </div>
            <div class="mt-2 font-mono text-[11px] text-muted-foreground break-all">
              {{ index.columns.join(", ") }}
            </div>
          </div>
          <Button v-if="props.canManageMongoIndexes && !props.isProtectedMongoIndex(index)" variant="ghost" size="sm" class="h-7 shrink-0 px-2 text-[11px] text-destructive hover:text-destructive" @click="emit('requestDropMongoIndex', index)">
            <Trash2 class="mr-1 h-3 w-3" />
            {{ t("contextMenu.dropIndex") }}
          </Button>
        </div>
      </div>
    </div>
  </div>

  <div v-else-if="props.activeTab === 'foreignKeys'" class="flex-1 min-h-0 overflow-auto">
    <div v-if="props.foreignKeysLoading" class="h-full flex items-center justify-center">
      <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
    </div>
    <div v-else-if="props.foreignKeysError" class="p-3 text-xs text-destructive">
      {{ props.foreignKeysError }}
    </div>
    <div v-else-if="props.searchQuery && props.foreignKeys.length === 0" class="p-6 text-center text-xs text-muted-foreground">
      {{ t("grid.tableInfoNoResults") }}
    </div>
    <div v-else-if="props.foreignKeys.length === 0" class="p-6 text-center text-xs text-muted-foreground">
      {{ t("grid.tableInfoEmpty") }}
    </div>
    <div v-else class="divide-y">
      <div v-for="foreignKey in props.foreignKeys" :key="`${foreignKey.name}:${foreignKey.column}`" class="p-3 text-xs">
        <div class="font-medium truncate">{{ foreignKey.name }}</div>
        <div class="mt-1 font-mono text-[11px] text-muted-foreground break-all">{{ foreignKey.column }} -> {{ foreignKey.ref_table }}.{{ foreignKey.ref_column }}</div>
      </div>
    </div>
  </div>

  <div v-else-if="props.activeTab === 'triggers'" class="flex-1 min-h-0 overflow-auto">
    <div v-if="props.triggersLoading" class="h-full flex items-center justify-center">
      <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
    </div>
    <div v-else-if="props.triggersError" class="p-3 text-xs text-destructive">
      {{ props.triggersError }}
    </div>
    <div v-else-if="props.searchQuery && props.triggers.length === 0" class="p-6 text-center text-xs text-muted-foreground">
      {{ t("grid.tableInfoNoResults") }}
    </div>
    <div v-else-if="props.triggers.length === 0" class="p-6 text-center text-xs text-muted-foreground">
      {{ t("grid.tableInfoEmpty") }}
    </div>
    <div v-else class="divide-y">
      <div v-for="trigger in props.triggers" :key="trigger.name" class="p-3 text-xs">
        <div class="font-medium truncate">{{ trigger.name }}</div>
        <div class="mt-1 text-[11px] text-muted-foreground">{{ trigger.timing }} {{ trigger.event }}</div>
      </div>
    </div>
  </div>

  <div v-else-if="props.activeTab === 'constraints'" class="flex-1 min-h-0 overflow-auto">
    <div v-if="props.constraintsLoading" class="h-full flex items-center justify-center">
      <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
    </div>
    <div v-else-if="props.constraintsError" class="p-3 text-xs text-destructive">
      {{ props.constraintsError }}
    </div>
    <div v-else-if="props.searchQuery && props.constraints.length === 0" class="p-6 text-center text-xs text-muted-foreground">
      {{ t("grid.tableInfoNoResults") }}
    </div>
    <div v-else-if="props.constraints.length === 0" class="p-6 text-center text-xs text-muted-foreground">
      {{ t("grid.tableInfoEmpty") }}
    </div>
    <div v-else class="divide-y">
      <div v-for="constraint in props.constraints" :key="constraint.name" class="p-3 text-xs" :class="constraint.enabled ? '' : 'opacity-60'">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="font-medium truncate">{{ constraint.name }}</span>
          <span class="rounded border px-1 py-px text-[10px] text-muted-foreground">{{ constraint.constraint_type }}</span>
          <span v-if="!constraint.enabled" class="rounded border px-1 py-px text-[10px] text-muted-foreground">{{ t("grid.tableInfoConstraintDisabled") }}</span>
          <span v-else-if="!constraint.valid" class="rounded border px-1 py-px text-[10px] text-muted-foreground">{{ t("grid.tableInfoConstraintNotValidated") }}</span>
        </div>
        <div v-if="constraint.columns.length" class="mt-1 font-mono text-[11px] text-muted-foreground break-all">{{ constraint.columns.join(", ") }}</div>
        <div v-if="constraint.ref_table" class="mt-1 font-mono text-[11px] text-muted-foreground break-all">-> {{ constraint.ref_schema ? `${constraint.ref_schema}.` : "" }}{{ constraint.ref_table }}{{ constraint.ref_columns.length ? `(${constraint.ref_columns.join(", ")})` : "" }}</div>
        <div v-if="constraint.definition" class="mt-1 font-mono text-[11px] text-muted-foreground break-all whitespace-pre-wrap">{{ constraint.definition }}</div>
      </div>
    </div>
  </div>
</template>
