<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FolderOpen, Loader2 } from "@lucide/vue";
import type { DatabaseBackupExecutionConfig } from "@/lib/backup/scheduledDatabaseBackup";
import type { ConnectionConfig } from "@/types/database";

withDefaults(
  defineProps<{
    draft: DatabaseBackupExecutionConfig;
    connections: Array<Pick<ConnectionConfig, "id" | "name">>;
    allDatabases: boolean;
    selectedDatabases: string[];
    databaseOptions: string[];
    tablePatternsInput: string;
    loadingDatabases: boolean;
  }>(),
  { connections: () => [], selectedDatabases: () => [], databaseOptions: () => [] },
);

const emit = defineEmits<{
  changeConnection: [connectionId: string];
  chooseDestination: [];
  toggleDatabase: [database: string];
  "update:allDatabases": [value: boolean];
  "update:tablePatternsInput": [value: string];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="grid gap-5 py-1">
    <div class="space-y-2">
      <Label>{{ t("databaseBackup.connection") }}</Label>
      <Select :model-value="draft.connectionId" @update:model-value="(value: any) => emit('changeConnection', String(value))">
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.name }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="space-y-2">
      <Label>{{ t("databaseBackup.destination") }}</Label>
      <div class="flex gap-2">
        <Input v-model="draft.destinationDirectory" readonly class="min-w-0" />
        <Button variant="outline" size="icon" class="shrink-0" :title="t('databaseBackup.selectDestination')" @click="emit('chooseDestination')">
          <FolderOpen class="h-4 w-4" />
        </Button>
      </div>
    </div>

    <div class="space-y-3">
      <div class="flex items-center justify-between gap-4">
        <Label>{{ t("databaseBackup.databases") }}</Label>
        <label class="flex items-center gap-2 text-sm">
          <input :checked="allDatabases" type="checkbox" class="h-4 w-4 rounded border-border accent-primary" @change="emit('update:allDatabases', ($event.target as HTMLInputElement).checked)" />
          {{ t("databaseBackup.allDatabases") }}
        </label>
      </div>
      <div v-if="!allDatabases" class="max-h-40 overflow-y-auto rounded-md border border-border/70 p-2">
        <div v-if="loadingDatabases" class="flex items-center justify-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("common.loading") }}</div>
        <label v-for="database in databaseOptions" v-else :key="database" class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60">
          <input type="checkbox" class="h-4 w-4 rounded border-border accent-primary" :checked="selectedDatabases.includes(database)" @change="emit('toggleDatabase', database)" />
          <span class="truncate">{{ database }}</span>
        </label>
      </div>
    </div>

    <div class="space-y-3">
      <div class="grid gap-4 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
        <div class="space-y-2">
          <Label>{{ t("databaseBackup.tableScope") }}</Label>
          <Select v-model="draft.tableFilterMode">
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{{ t("databaseBackup.allTables") }}</SelectItem>
              <SelectItem value="include">{{ t("databaseBackup.includeTables") }}</SelectItem>
              <SelectItem value="exclude">{{ t("databaseBackup.excludeTables") }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div v-if="draft.tableFilterMode !== 'all'" class="space-y-2">
          <Label>{{ t("databaseBackup.tablePatterns") }}</Label>
          <Input :model-value="tablePatternsInput" :placeholder="t('databaseBackup.tablePatternsPlaceholder')" @update:model-value="(value: any) => emit('update:tablePatternsInput', String(value))" />
        </div>
      </div>
      <p v-if="draft.tableFilterMode !== 'all'" class="text-xs text-muted-foreground">{{ t("databaseBackup.tablePatternsHint") }}</p>
    </div>

    <div class="space-y-3">
      <Label>{{ t("databaseBackup.contents") }}</Label>
      <div class="grid gap-2 sm:grid-cols-2">
        <label class="flex items-center gap-2 text-sm"><input v-model="draft.includeStructure" type="checkbox" class="h-4 w-4 accent-primary" />{{ t("databaseExport.includeStructure") }}</label>
        <label class="flex items-center gap-2 text-sm"><input v-model="draft.includeData" type="checkbox" class="h-4 w-4 accent-primary" />{{ t("databaseExport.includeData") }}</label>
        <label class="flex items-center gap-2 text-sm"><input v-model="draft.includeObjects" type="checkbox" class="h-4 w-4 accent-primary" />{{ t("databaseExport.includeObjects") }}</label>
        <label class="flex items-center gap-2 text-sm"><input v-model="draft.dropTableIfExists" type="checkbox" class="h-4 w-4 accent-primary" />{{ t("databaseExport.dropTableIfExists") }}</label>
      </div>
    </div>
  </div>
</template>
