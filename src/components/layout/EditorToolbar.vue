<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Play, Loader2, Square, Database, Table2, AlignLeft, GitBranch } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import { connectionIconType } from "@/lib/connectionPresentation";
import { connectionDisplayName } from "@/lib/tabPresentation";
import type { QueryTab, ConnectionConfig } from "@/types/database";

const props = defineProps<{
  activeTab: QueryTab;
  activeConnection?: ConnectionConfig;
  executableSql: string;
}>();

const emit = defineEmits<{
  execute: [];
  cancel: [];
  explain: [];
  formatSql: [];
  changeConnection: [connectionId: string];
  changeDatabase: [database: string];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const { databaseOptions, loadingDatabaseOptions, loadDatabaseOptions } = useDatabaseOptions();

const activeDatabaseOptions = computed(() => {
  const connection = props.activeConnection;
  return connection ? databaseOptions.value[connection.id] ?? [] : [];
});

const activeDatabaseValue = computed(() => props.activeTab.database || "");
const activeConnectionValue = computed(() => props.activeConnection?.id || "");

function databaseDisplayName(database: string): string {
  const connection = props.activeConnection;
  if (connection?.db_type === "redis" && database !== "") return `db${database}`;
  return database || t("editor.noDatabase");
}
</script>

<template>
  <div class="h-9 shrink-0 border-b bg-background/80 px-3 flex items-center gap-1 text-xs text-muted-foreground relative z-10">
    <div class="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            :variant="activeTab.isExecuting ? 'destructive' : 'ghost'"
            size="icon"
            class="h-6 w-6"
            :disabled="activeTab.isCancelling || activeTab.isExplaining || (!activeTab.isExecuting && !executableSql.trim())"
            @click="activeTab.isExecuting ? emit('cancel') : emit('execute')"
          >
            <Loader2 v-if="activeTab.isCancelling" class="h-3.5 w-3.5 animate-spin" />
            <Square v-else-if="activeTab.isExecuting" class="h-3.5 w-3.5 fill-current" />
            <Play v-else class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ activeTab.isExecuting ? t('toolbar.stopQuery') : t('toolbar.executeShortcut') }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            :variant="activeTab.isExplaining ? 'destructive' : 'ghost'"
            size="icon"
            class="h-6 w-6"
            :disabled="activeTab.isExecuting || (!activeTab.isExplaining && !executableSql.trim())"
            @click="activeTab.isExplaining ? emit('cancel') : emit('explain')"
          >
            <Square v-if="activeTab.isExplaining" class="h-3.5 w-3.5 fill-current" />
            <GitBranch v-else class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ activeTab.isExplaining ? t('toolbar.stopExplain') : t('toolbar.explainPlan') }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="activeTab.isExecuting || activeTab.isExplaining || !activeTab.sql.trim()" @click="emit('formatSql')">
            <AlignLeft class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t('toolbar.formatSql') }}</TooltipContent>
      </Tooltip>
    </div>
    <span class="flex-1 min-w-0" />
    <div class="flex items-center gap-2 shrink-0">
      <div class="flex items-center gap-1">
        <span v-if="activeConnection?.color" class="h-4 w-1 rounded-full shrink-0" :style="{ backgroundColor: activeConnection.color }" />
        <Select
          :model-value="activeConnectionValue"
          @update:model-value="(v: any) => emit('changeConnection', v)"
        >
          <SelectTrigger class="h-6 w-auto max-w-56 border-0 bg-transparent px-1 text-xs font-medium text-foreground shadow-none focus:ring-0">
            <div v-if="activeConnection" class="flex min-w-0 items-center gap-1.5">
              <DatabaseIcon :db-type="connectionIconType(activeConnection)" class="h-3.5 w-3.5 shrink-0" />
              <span class="truncate">{{ connectionDisplayName(activeConnectionValue) }}</span>
            </div>
            <SelectValue v-else :placeholder="t('editor.selectConnection')" />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem
              v-for="connection in connectionStore.connections"
              :key="connection.id"
              :value="connection.id"
            >
              <div class="flex min-w-0 items-center gap-2">
                <DatabaseIcon :db-type="connectionIconType(connection)" class="h-3.5 w-3.5 shrink-0" />
                <span class="truncate">{{ connection.name }}</span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="flex items-center gap-1">
        <Database class="h-3.5 w-3.5 shrink-0" />
        <Select
          :model-value="activeDatabaseValue"
          @update:model-value="(v: any) => emit('changeDatabase', v)"
          @update:open="(open: boolean) => { if (open && activeConnection) loadDatabaseOptions(activeConnection.id).catch(() => {}) }"
        >
          <SelectTrigger class="h-6 w-auto max-w-56 border-0 bg-transparent px-1 text-xs shadow-none focus:ring-0">
            <SelectValue :placeholder="loadingDatabaseOptions[activeConnection?.id || ''] ? t('common.loading') : t('editor.selectDatabase')">
              {{ databaseDisplayName(activeDatabaseValue) }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem
              v-for="database in activeDatabaseOptions"
              :key="database"
              :value="database"
            >
              {{ databaseDisplayName(database) }}
            </SelectItem>
            <SelectItem v-if="!activeDatabaseOptions.length && activeDatabaseValue" :value="activeDatabaseValue">
              {{ databaseDisplayName(activeDatabaseValue) }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
    <div v-if="activeTab.tableMeta" class="flex min-w-0 items-center gap-1 ml-2">
      <Table2 class="h-3.5 w-3.5 shrink-0" />
      <span class="truncate">{{ activeTab.tableMeta.columns.length }} {{ t('tree.columns') }}</span>
    </div>
  </div>
</template>
