<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  Play,
  Loader2,
  Square,
  Database,
  Check,
  Table2,
  AlignLeft,
  GitBranch,
  Save,
  FolderOpen,
  Layers,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import { useSchemaOptions } from "@/composables/useSchemaOptions";
import { connectionIconType } from "@/lib/connectionPresentation";
import { isDefaultDatabase } from "@/lib/defaultDatabase";
import { connectionDisplayName } from "@/lib/tabPresentation";
import { isSingleDatabase } from "@/lib/databaseCapabilities";
import { hexToRgba } from "@/lib/color";
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
  saveSql: [];
  openSql: [];
  changeConnection: [connectionId: string];
  changeDatabase: [database: string];
  changeSchema: [schema: string | undefined];
  setDefaultDatabase: [];
  clearDefaultDatabase: [];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const { databaseOptions, loadingDatabaseOptions, loadDatabaseOptions } = useDatabaseOptions();
const { loadSchemaOptions, getSchemaOptionsForDb, isLoadingSchemas, isSchemaAware } = useSchemaOptions();

const activeDatabaseOptions = computed(() => {
  const connection = props.activeConnection;
  return connection ? (databaseOptions.value[connection.id] ?? []) : [];
});

const activeDatabaseValue = computed(() => props.activeTab.database || "");
const activeConnectionValue = computed(() => props.activeConnection?.id || "");
const activeSchemaValue = computed(() => props.activeTab.schema || "");
const isSingleDb = computed(() => isSingleDatabase(props.activeConnection?.db_type));
const schemaDatabaseKey = computed(() => props.activeTab.database || (isSingleDb.value ? "_" : ""));

const showSchemaSelector = computed(() => {
  const connection = props.activeConnection;
  return connection && isSchemaAware(connection.id) && (props.activeTab.database || isSingleDb.value);
});

const activeSchemaOptions = computed(() => {
  const connection = props.activeConnection;
  if (!connection) return [];
  return getSchemaOptionsForDb(connection.id, schemaDatabaseKey.value);
});

const isActiveDatabaseDefault = computed(() => isDefaultDatabase(props.activeConnection, activeDatabaseValue.value));
const toolbarStyle = computed(() => {
  const color = props.activeConnection?.color;
  if (!color) return undefined;
  return {
    backgroundColor: hexToRgba(color, 0.1),
    boxShadow: `inset 0 1px 0 ${hexToRgba(color, 0.18)}`,
  };
});

function databaseDisplayName(database: string): string {
  const connection = props.activeConnection;
  if (connection?.db_type === "redis" && database !== "") return `db${database}`;
  return database || t("editor.noDatabase");
}
</script>

<template>
  <div
    class="h-9 shrink-0 border-b bg-background/80 px-3 flex items-center gap-1 text-xs text-muted-foreground relative z-10"
    :style="toolbarStyle"
  >
    <div class="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            :variant="activeTab.isExecuting ? 'destructive' : 'ghost'"
            size="icon"
            class="h-6 w-6"
            :class="
              activeTab.isExecuting
                ? ''
                : 'bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 hover:text-emerald-800 dark:text-emerald-300 dark:hover:text-emerald-200'
            "
            :disabled="
              activeTab.isCancelling || activeTab.isExplaining || (!activeTab.isExecuting && !executableSql.trim())
            "
            @click="activeTab.isExecuting ? emit('cancel') : emit('execute')"
          >
            <Loader2 v-if="activeTab.isCancelling" class="h-3.5 w-3.5 animate-spin" />
            <Square v-else-if="activeTab.isExecuting" class="h-3.5 w-3.5 fill-current" />
            <Play v-else class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{
          activeTab.isExecuting ? t("toolbar.stopQuery") : t("toolbar.executeShortcut")
        }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            :variant="activeTab.isExplaining ? 'destructive' : 'ghost'"
            size="icon"
            class="h-6 w-6"
            :class="
              activeTab.isExplaining
                ? ''
                : 'text-violet-600 hover:bg-violet-500/10 hover:text-violet-700 dark:text-violet-300 dark:hover:text-violet-200'
            "
            :disabled="activeTab.isExecuting || (!activeTab.isExplaining && !executableSql.trim())"
            @click="activeTab.isExplaining ? emit('cancel') : emit('explain')"
          >
            <Square v-if="activeTab.isExplaining" class="h-3.5 w-3.5 fill-current" />
            <GitBranch v-else class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{
          activeTab.isExplaining ? t("toolbar.stopExplain") : t("toolbar.explainPlan")
        }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="h-6 w-6 text-amber-600 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200"
            :disabled="activeTab.isExecuting || activeTab.isExplaining || !activeTab.sql.trim()"
            @click="emit('formatSql')"
          >
            <AlignLeft class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("toolbar.formatSql") }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="h-6 w-6 text-blue-600 hover:bg-blue-500/10 hover:text-blue-700 dark:text-blue-300 dark:hover:text-blue-200"
            :disabled="!activeTab.sql.trim()"
            @click="emit('saveSql')"
          >
            <Save class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("toolbar.saveSql") }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="h-6 w-6 text-sky-600 hover:bg-sky-500/10 hover:text-sky-700 dark:text-sky-300 dark:hover:text-sky-200"
            @click="emit('openSql')"
          >
            <FolderOpen class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("toolbar.openSql") }}</TooltipContent>
      </Tooltip>
    </div>
    <span class="flex-1 min-w-0" />
    <div class="flex items-center gap-2 shrink-0">
      <div class="flex items-center gap-1">
        <span
          v-if="activeConnection?.color"
          class="h-4 w-1 rounded-full shrink-0"
          :style="{ backgroundColor: activeConnection.color }"
        />
        <Select :model-value="activeConnectionValue" @update:model-value="(v: any) => emit('changeConnection', v)">
          <SelectTrigger
            class="h-6 w-auto max-w-56 border-0 bg-transparent px-1 text-xs font-medium text-foreground shadow-none focus:ring-0"
          >
            <div v-if="activeConnection" class="flex min-w-0 items-center gap-1.5">
              <DatabaseIcon :db-type="connectionIconType(activeConnection)" class="h-3.5 w-3.5 shrink-0" />
              <span class="truncate">{{ connectionDisplayName(activeConnectionValue) }}</span>
            </div>
            <SelectValue v-else :placeholder="t('editor.selectConnection')" />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem v-for="connection in connectionStore.connections" :key="connection.id" :value="connection.id">
              <div class="flex min-w-0 items-center gap-2">
                <DatabaseIcon :db-type="connectionIconType(connection)" class="h-3.5 w-3.5 shrink-0" />
                <span class="truncate">{{ connection.name }}</span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div v-if="activeConnection?.db_type !== 'elasticsearch' && !isSingleDb" class="flex items-center gap-1">
        <Database class="h-3.5 w-3.5 shrink-0" />
        <Select
          :model-value="activeDatabaseValue"
          @update:model-value="(v: any) => emit('changeDatabase', v)"
          @update:open="
            (open: boolean) => {
              if (open && activeConnection) loadDatabaseOptions(activeConnection.id).catch(() => {});
            }
          "
        >
          <SelectTrigger class="h-6 w-auto max-w-56 border-0 bg-transparent px-1 text-xs shadow-none focus:ring-0">
            <SelectValue
              :placeholder="
                loadingDatabaseOptions[activeConnection?.id || ''] ? t('common.loading') : t('editor.selectDatabase')
              "
            >
              {{ databaseDisplayName(activeDatabaseValue) }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem v-for="database in activeDatabaseOptions" :key="database" :value="database">
              {{ databaseDisplayName(database) }}
            </SelectItem>
            <SelectItem v-if="!activeDatabaseOptions.length && activeDatabaseValue" :value="activeDatabaseValue">
              {{ databaseDisplayName(activeDatabaseValue) }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          v-if="activeDatabaseValue"
          variant="ghost"
          size="sm"
          class="h-6 px-2 text-[11px]"
          @click="isActiveDatabaseDefault ? emit('clearDefaultDatabase') : emit('setDefaultDatabase')"
        >
          <Check v-if="isActiveDatabaseDefault" class="h-3 w-3" />
          {{ isActiveDatabaseDefault ? t("editor.defaultDatabase") : t("editor.setDefaultDatabase") }}
        </Button>
      </div>
      <div v-if="showSchemaSelector" class="flex items-center gap-1">
        <Layers class="h-3.5 w-3.5 shrink-0" />
        <Select
          :model-value="activeSchemaValue"
          @update:model-value="(v: any) => emit('changeSchema', v || undefined)"
          @update:open="
            (open: boolean) => {
              if (open && activeConnection) loadSchemaOptions(activeConnection.id, schemaDatabaseKey).catch(() => {});
            }
          "
        >
          <SelectTrigger class="h-6 w-auto max-w-56 border-0 bg-transparent px-1 text-xs shadow-none focus:ring-0">
            <SelectValue
              :placeholder="
                activeConnection && isLoadingSchemas(activeConnection.id, schemaDatabaseKey)
                  ? t('common.loading')
                  : t('editor.selectSchema')
              "
            >
              {{ activeSchemaValue || t("editor.selectSchema") }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem v-for="schema in activeSchemaOptions" :key="schema" :value="schema">
              {{ schema }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
    <div v-if="activeTab.tableMeta" class="flex min-w-0 items-center gap-1 ml-2">
      <Table2 class="h-3.5 w-3.5 shrink-0" />
      <span class="truncate">{{ activeTab.tableMeta.columns.length }} {{ t("tree.columns") }}</span>
    </div>
  </div>
</template>
