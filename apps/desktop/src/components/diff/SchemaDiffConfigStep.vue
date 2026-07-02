<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import SearchableSelect from "@/components/ui/searchable-select/SearchableSelect.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import * as api from "@/lib/api";
import { isSchemaAware } from "@/lib/databaseCapabilities";
import { ArrowLeftRight, GitCompareArrows, Save, FolderOpen, Settings, X } from "@lucide/vue";
import type { SchemaDiffConfig, SchemaDiffCompareOptions } from "@/types/schemaDiff";

const { t } = useI18n();
const store = useConnectionStore();

const props = defineProps<{
  configs: SchemaDiffConfig[];
  activeConfigId: string;
  sourceConnectionId: string;
  sourceDatabase: string;
  sourceSchema: string;
  targetConnectionId: string;
  targetDatabase: string;
  targetSchema: string;
  ignoreComments: boolean;
  options: SchemaDiffCompareOptions;
  loading: boolean;
  recentConfigs: SchemaDiffConfig[];
}>();

const emit = defineEmits<{
  (e: "update:sourceConnectionId", value: string): void;
  (e: "update:sourceDatabase", value: string): void;
  (e: "update:sourceSchema", value: string): void;
  (e: "update:targetConnectionId", value: string): void;
  (e: "update:targetDatabase", value: string): void;
  (e: "update:targetSchema", value: string): void;
  (e: "update:ignoreComments", value: boolean): void;
  (e: "compare"): void;
  (e: "saveConfig"): void;
  (e: "loadConfig"): void;
  (e: "showOptions"): void;
  (e: "swap"): void;
  (e: "loadHistoryConfig", config: SchemaDiffConfig): void;
  (e: "deleteHistoryConfig", configId: string): void;
}>();

const sourceDatabases = ref<string[]>([]);
const sourceSchemas = ref<string[]>([]);
const targetDatabases = ref<string[]>([]);
const targetSchemas = ref<string[]>([]);
const sourceDbVersion = ref<string | null>(null);
const targetDbVersion = ref<string | null>(null);

const sqlConnections = computed(() => store.connections.filter((c: any) => !["mongodb", "redis", "elasticsearch", "etcd", "mq", "nacos"].includes(c.db_type)));

const sourceConfig = computed(() => store.getConfig(props.sourceConnectionId));
const targetConfig = computed(() => store.getConfig(props.targetConnectionId));

const canCompare = computed(() => {
  return props.sourceConnectionId && props.targetConnectionId && props.sourceDatabase && props.targetDatabase && (!isSchemaAware(sourceConfig.value?.db_type) || props.sourceSchema) && (!isSchemaAware(targetConfig.value?.db_type) || props.targetSchema);
});

async function loadDatabases(connectionId: string, side: "source" | "target") {
  if (!connectionId) return;
  try {
    await store.ensureConnected(connectionId);
    const dbs = await api.listDatabases(connectionId);
    const dbNames = Array.isArray(dbs) ? dbs.map((db: any) => (typeof db === "string" ? db : db.name || db.database)) : [];
    if (side === "source") {
      sourceDatabases.value = dbNames;
      if (props.sourceDatabase) {
        await fetchDbVersion(connectionId, props.sourceDatabase, props.sourceSchema, "source");
        // Ensure schema list is loaded after databases are available (handles race with sourceDatabase watcher)
        if (isSchemaAware(sourceConfig.value?.db_type)) {
          await loadSchemas("source");
        }
      }
    } else {
      targetDatabases.value = dbNames;
      if (props.targetDatabase) {
        await fetchDbVersion(connectionId, props.targetDatabase, props.targetSchema, "target");
        // Ensure schema list is loaded after databases are available (handles race with targetDatabase watcher)
        if (isSchemaAware(targetConfig.value?.db_type)) {
          await loadSchemas("target");
        }
      }
    }
  } catch {
    if (side === "source") {
      sourceDatabases.value = [];
      sourceDbVersion.value = null;
    } else {
      targetDatabases.value = [];
      targetDbVersion.value = null;
    }
  }
}

async function loadSchemas(side: "source" | "target") {
  const connectionId = side === "source" ? props.sourceConnectionId : props.targetConnectionId;
  const database = side === "source" ? props.sourceDatabase : props.targetDatabase;
  const schema = side === "source" ? props.sourceSchema : props.targetSchema;
  if (!connectionId || !database) return;

  try {
    await store.ensureConnected(connectionId);
    const schemas = await api.listSchemas(connectionId, database);
    if (side === "source") {
      sourceSchemas.value = schemas;
    } else {
      targetSchemas.value = schemas;
    }
    await fetchDbVersion(connectionId, database, schema, side);
  } catch {
    if (side === "source") {
      sourceSchemas.value = [];
    } else {
      targetSchemas.value = [];
    }
  }
}

watch(
  () => props.sourceConnectionId,
  async (id) => {
    if (id) {
      await loadDatabases(id, "source");
    } else {
      sourceDatabases.value = [];
    }
  },
  { immediate: true },
);

watch(
  () => props.sourceDatabase,
  async (db) => {
    if (db && props.sourceConnectionId) {
      await loadSchemas("source");
    } else {
      sourceSchemas.value = [];
    }
  },
  { immediate: true },
);

watch(
  () => props.targetConnectionId,
  async (id) => {
    if (id) {
      await loadDatabases(id, "target");
    } else {
      targetDatabases.value = [];
    }
  },
  { immediate: true },
);

watch(
  () => props.targetDatabase,
  async (db) => {
    if (db && props.targetConnectionId) {
      await loadSchemas("target");
    } else {
      targetSchemas.value = [];
    }
  },
  { immediate: true },
);

function connectionIconType(connectionId: string) {
  const c = store.getConfig(connectionId);
  return c?.driver_profile || c?.db_type || "mysql";
}

function getConnectionInfo(connectionId: string) {
  const c = store.getConfig(connectionId);
  if (!c) return null;
  return {
    name: c.name,
    dbType: c.db_type,
    host: c.host,
    port: c.port,
  };
}

async function fetchDbVersion(connectionId: string, database: string, schema: string, side: "source" | "target") {
  try {
    await store.ensureConnected(connectionId);
    const config = store.getConfig(connectionId);
    const dbType = config?.db_type;
    let sql = "";
    switch (dbType) {
      case "postgres":
      case "opengauss":
        sql = "SELECT version()";
        break;
      case "mysql":
        sql = "SELECT VERSION()";
        break;
      case "sqlite":
        sql = "SELECT sqlite_version()";
        break;
      default:
        return;
    }
    const result = await api.executeQuery(connectionId, database, sql, schema || undefined);
    if (result.rows && result.rows.length > 0) {
      const version = String(result.rows[0][0]);
      if (side === "source") {
        sourceDbVersion.value = version;
      } else {
        targetDbVersion.value = version;
      }
    }
  } catch (e) {
    console.error(`[fetchDbVersion] Failed to fetch version for ${side}:`, e);
    if (side === "source") {
      sourceDbVersion.value = null;
    } else {
      targetDbVersion.value = null;
    }
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- Header -->
    <div class="flex items-center justify-center gap-4 py-2">
      <div class="text-center">
        <div class="text-xs text-muted-foreground">{{ sourceConfig?.name || t("diff.source") }}</div>
        <div class="text-xs font-medium">{{ sourceDatabase }}{{ sourceSchema ? `.${sourceSchema}` : "" }}</div>
      </div>
      <div class="flex items-center gap-2">
        <DatabaseIcon v-if="sourceConnectionId" :db-type="connectionIconType(sourceConnectionId)" class="w-5 h-5" />
        <ArrowLeftRight class="w-4 h-4 text-muted-foreground" />
        <DatabaseIcon v-if="targetConnectionId" :db-type="connectionIconType(targetConnectionId)" class="w-5 h-5" />
      </div>
      <div class="text-center">
        <div class="text-xs text-muted-foreground">{{ targetConfig?.name || t("diff.target") }}</div>
        <div class="text-xs font-medium">{{ targetDatabase }}{{ targetSchema ? `.${targetSchema}` : "" }}</div>
      </div>
    </div>

    <!-- Source / Target Selection -->
    <div class="grid grid-cols-[1fr_auto_1fr] gap-4 items-start">
      <!-- Source Side -->
      <div class="space-y-3">
        <div class="text-sm font-medium text-blue-500">{{ t("diff.source") }}</div>

        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("diff.connection") }}</Label>
          <SearchableSelect
            :model-value="sourceConnectionId"
            @update:model-value="(v: string) => $emit('update:sourceConnectionId', v)"
            :options="sqlConnections.map((c) => c.id)"
            :placeholder="t('diff.selectConnection')"
            :search-placeholder="t('diff.searchConnection')"
            :empty-text="t('common.noResults')"
            :display-name="(id) => sqlConnections.find((c) => c.id === id)?.name ?? id"
            trigger-variant="outline"
            trigger-class="h-8 w-full justify-between text-xs"
            content-class="w-[var(--reka-popover-trigger-width)]"
          >
            <template #option-label="{ option, label }">
              <div class="flex items-center gap-2">
                <DatabaseIcon :db-type="sqlConnections.find((c) => c.id === option)?.driver_profile || sqlConnections.find((c) => c.id === option)?.db_type || 'mysql'" class="w-3.5 h-3.5" />
                {{ label }}
              </div>
            </template>
          </SearchableSelect>
        </div>

        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("diff.database") }}</Label>
          <SearchableSelect
            :model-value="sourceDatabase"
            @update:model-value="(v: string) => $emit('update:sourceDatabase', v)"
            :options="sourceDatabases"
            :placeholder="t('diff.selectDatabase')"
            :search-placeholder="t('diff.searchDatabase')"
            :empty-text="t('common.noResults')"
            :disabled="!sourceDatabases.length"
            trigger-variant="outline"
            trigger-class="h-8 w-full justify-between text-xs"
            content-class="w-[var(--reka-popover-trigger-width)]"
          />
        </div>

        <div v-if="isSchemaAware(sourceConfig?.db_type)" class="space-y-1.5">
          <Label class="text-xs">{{ t("diff.schema") }}</Label>
          <SearchableSelect
            :model-value="sourceSchema"
            @update:model-value="(v: string) => $emit('update:sourceSchema', v)"
            :options="sourceSchemas"
            :placeholder="t('diff.selectSchema')"
            :search-placeholder="t('diff.searchSchema')"
            :empty-text="t('common.noResults')"
            :disabled="!sourceSchemas.length"
            trigger-variant="outline"
            trigger-class="h-8 w-full justify-between text-xs"
            content-class="w-[var(--reka-popover-trigger-width)]"
          />
        </div>

        <!-- Source Info -->
        <div v-if="getConnectionInfo(sourceConnectionId)" class="mt-4 p-3 rounded-lg bg-muted/30 border space-y-1.5">
          <div class="text-xs font-medium text-blue-500">{{ t("diff.info") }}</div>
          <div class="grid grid-cols-[80px_1fr] gap-x-2 gap-y-0.5 text-xs">
            <span class="text-muted-foreground">{{ t("diff.connType") }}</span>
            <span>{{ getConnectionInfo(sourceConnectionId)?.dbType }}</span>
            <span class="text-muted-foreground">{{ t("diff.connName") }}</span>
            <span>{{ getConnectionInfo(sourceConnectionId)?.name }}</span>
            <span class="text-muted-foreground">{{ t("diff.host") }}</span>
            <span>{{ getConnectionInfo(sourceConnectionId)?.host }}</span>
            <span class="text-muted-foreground">{{ t("diff.port") }}</span>
            <span>{{ getConnectionInfo(sourceConnectionId)?.port }}</span>
            <span class="text-muted-foreground">{{ t("diff.serverVersion") }}</span>
            <span>{{ sourceDbVersion || "--" }}</span>
          </div>
        </div>
      </div>

      <!-- Swap Button -->
      <div class="pt-8">
        <Button variant="ghost" size="icon" class="h-8 w-8" @click="$emit('swap')">
          <ArrowLeftRight class="w-4 h-4" />
        </Button>
      </div>

      <!-- Target Side -->
      <div class="space-y-3">
        <div class="text-sm font-medium text-green-500">{{ t("diff.target") }}</div>

        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("diff.connection") }}</Label>
          <SearchableSelect
            :model-value="targetConnectionId"
            @update:model-value="(v: string) => $emit('update:targetConnectionId', v)"
            :options="sqlConnections.map((c) => c.id)"
            :placeholder="t('diff.selectConnection')"
            :search-placeholder="t('diff.searchConnection')"
            :empty-text="t('common.noResults')"
            :display-name="(id) => sqlConnections.find((c) => c.id === id)?.name ?? id"
            trigger-variant="outline"
            trigger-class="h-8 w-full justify-between text-xs"
            content-class="w-[var(--reka-popover-trigger-width)]"
          >
            <template #option-label="{ option, label }">
              <div class="flex items-center gap-2">
                <DatabaseIcon :db-type="sqlConnections.find((c) => c.id === option)?.driver_profile || sqlConnections.find((c) => c.id === option)?.db_type || 'mysql'" class="w-3.5 h-3.5" />
                {{ label }}
              </div>
            </template>
          </SearchableSelect>
        </div>

        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("diff.database") }}</Label>
          <SearchableSelect
            :model-value="targetDatabase"
            @update:model-value="(v: string) => $emit('update:targetDatabase', v)"
            :options="targetDatabases"
            :placeholder="t('diff.selectDatabase')"
            :search-placeholder="t('diff.searchDatabase')"
            :empty-text="t('common.noResults')"
            :disabled="!targetDatabases.length"
            trigger-variant="outline"
            trigger-class="h-8 w-full justify-between text-xs"
            content-class="w-[var(--reka-popover-trigger-width)]"
          />
        </div>

        <div v-if="isSchemaAware(targetConfig?.db_type)" class="space-y-1.5">
          <Label class="text-xs">{{ t("diff.schema") }}</Label>
          <SearchableSelect
            :model-value="targetSchema"
            @update:model-value="(v: string) => $emit('update:targetSchema', v)"
            :options="targetSchemas"
            :placeholder="t('diff.selectSchema')"
            :search-placeholder="t('diff.searchSchema')"
            :empty-text="t('common.noResults')"
            :disabled="!targetSchemas.length"
            trigger-variant="outline"
            trigger-class="h-8 w-full justify-between text-xs"
            content-class="w-[var(--reka-popover-trigger-width)]"
          />
        </div>

        <!-- Target Info -->
        <div v-if="getConnectionInfo(targetConnectionId)" class="mt-4 p-3 rounded-lg bg-muted/30 border space-y-1.5">
          <div class="text-xs font-medium text-green-500">{{ t("diff.info") }}</div>
          <div class="grid grid-cols-[80px_1fr] gap-x-2 gap-y-0.5 text-xs">
            <span class="text-muted-foreground">{{ t("diff.connType") }}</span>
            <span>{{ getConnectionInfo(targetConnectionId)?.dbType }}</span>
            <span class="text-muted-foreground">{{ t("diff.connName") }}</span>
            <span>{{ getConnectionInfo(targetConnectionId)?.name }}</span>
            <span class="text-muted-foreground">{{ t("diff.host") }}</span>
            <span>{{ getConnectionInfo(targetConnectionId)?.host }}</span>
            <span class="text-muted-foreground">{{ t("diff.port") }}</span>
            <span>{{ getConnectionInfo(targetConnectionId)?.port }}</span>
            <span class="text-muted-foreground">{{ t("diff.serverVersion") }}</span>
            <span>{{ targetDbVersion || "--" }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Options -->
    <div class="flex items-center gap-2 p-3 rounded-lg border bg-muted/20">
      <input id="schema-diff-ignore-comments" :checked="ignoreComments" type="checkbox" class="accent-primary" @change="$emit('update:ignoreComments', ($event.target as HTMLInputElement).checked)" />
      <Label for="schema-diff-ignore-comments" class="cursor-pointer text-xs">
        {{ t("diff.ignoreComments") }}
      </Label>
    </div>

    <!-- Recent Configs Dropdown -->
    <div v-if="recentConfigs.length > 0" class="flex items-center gap-2">
      <Label class="text-xs text-muted-foreground">{{ t("diff.recentConfigs") }}</Label>
      <Select
        :model-value="''"
        @update:model-value="
          (v: any) => {
            const config = recentConfigs.find((c) => c.id === v);
            if (config) $emit('loadHistoryConfig', config);
          }
        "
      >
        <SelectTrigger class="h-8 text-xs w-[280px]">
          <SelectValue :placeholder="t('diff.selectRecentConfig')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="config in recentConfigs" :key="config.id" :value="config.id" class="pr-8">
            <div class="flex items-center justify-between w-full gap-2">
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-xs font-medium truncate">{{ config.name }}</span>
                <span class="text-[10px] text-muted-foreground truncate">
                  {{ store.getConfig(config.sourceConnectionId)?.name || config.sourceConnectionId }}
                  /{{ config.sourceDatabase }}{{ config.sourceSchema ? `.${config.sourceSchema}` : "" }}
                  →
                  {{ store.getConfig(config.targetConnectionId)?.name || config.targetConnectionId }}
                  /{{ config.targetDatabase }}{{ config.targetSchema ? `.${config.targetSchema}` : "" }}
                </span>
              </div>
              <button class="shrink-0 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-colors" @click.stop="$emit('deleteHistoryConfig', config.id)">
                <X class="w-3 h-3" />
              </button>
            </div>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <!-- Bottom Actions -->
    <div class="flex items-center justify-between pt-2">
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" @click="$emit('saveConfig')">
          <Save class="w-3.5 h-3.5 mr-1" />
          {{ t("diff.saveConfig") }}
        </Button>
        <Button variant="outline" size="sm" @click="$emit('loadConfig')">
          <FolderOpen class="w-3.5 h-3.5 mr-1" />
          {{ t("diff.loadConfig") }}
        </Button>
        <Button variant="outline" size="sm" @click="$emit('showOptions')">
          <Settings class="w-3.5 h-3.5 mr-1" />
          {{ t("diff.options") }}
        </Button>
      </div>
      <Button size="sm" :disabled="!canCompare || loading" @click="$emit('compare')">
        <GitCompareArrows class="w-3.5 h-3.5 mr-1" />
        {{ loading ? t("common.loading") : t("diff.compare") }}
      </Button>
    </div>
  </div>
</template>
