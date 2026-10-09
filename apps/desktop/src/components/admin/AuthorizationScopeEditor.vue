<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, ChevronDown, Loader2, Search, Table2 } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as api from "@/lib/backend/api";
import { authorizationPresetPrivileges, authorizationPrivileges, type AuthorizationDatabaseOption, type AuthorizationPreset, type AuthorizationTableSelection, type DatabaseAuthorizationSelection } from "@/lib/database/databaseAuthorizationPlan";
import type { DatabaseUserAdminProvider } from "@/lib/database/databaseUserAdmin";

/**
 * 数据库授权范围编辑器：数据库多选 + 每库权限预设 + 表级(全部表/指定表)选择 + 自定义权限勾选。
 * 该组件同时被“新增用户”弹窗与“权限编辑”面板复用，保证两处交互一致。
 * 组件内部只负责收集选择结果（DatabaseAuthorizationSelection[]），不生成或执行 SQL，
 * 授权语句由调用方交给 databaseAuthorizationPlan 中的计划构造器生成。
 */
const props = defineProps<{
  /** 已选中的数据库授权配置，由调用方通过 v-model 持有 */
  modelValue: DatabaseAuthorizationSelection[];
  /** 当前连接的权限提供者，用于判断是否支持表级授权以及表级可用权限 */
  provider: DatabaseUserAdminProvider | null;
  /** 当前连接下的数据库名列表 */
  databases: AuthorizationDatabaseOption[];
  /** 数据库列表是否正在加载 */
  databasesLoading?: boolean;
  /** 连接 ID，用于按库懒加载表列表 */
  connectionId: string;
  /** 紧凑布局：用于右侧权限编辑面板，隐藏标题区、压缩列表高度并让表范围控件换行显示 */
  compact?: boolean;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: DatabaseAuthorizationSelection[]): void;
}>();

const { t } = useI18n();
// 全局作用域标识：MySQL 的 GRANT/REVOKE 支持 ON *.*，权限编辑面板需要保留这一能力
const GLOBAL_SCOPE = "*";
const GLOBAL_OPTION: AuthorizationDatabaseOption = { database: GLOBAL_SCOPE };
const search = ref("");
// 表列表按库懒加载并缓存，避免下拉展开时重复请求
const tables = ref<Record<string, AuthorizationTableSelection[]>>({});
const tablesLoading = ref<Record<string, boolean>>({});
const tableErrors = ref<Record<string, string>>({});
const tableSearch = ref<Record<string, string>>({});

const supportsTableGrants = computed(() => !!props.provider?.supportsTableGrantsOnCreate);
const filteredDatabases = computed(() => {
  const query = search.value.trim().toLowerCase();
  return query ? props.databases.filter((database) => databaseLabel(database).toLowerCase().includes(query)) : props.databases;
});
// 紧凑模式（权限编辑面板）在列表顶部提供固定的「全局」入口，且不受库搜索影响；
// 新增用户弹窗保持只勾选真实数据库，不改变原有产品行为。
const visibleDatabases = computed(() => (props.compact && props.provider?.authorizationModel === "mysql" ? [GLOBAL_OPTION, ...filteredDatabases.value] : filteredDatabases.value));
const selectedDatabaseSet = computed(() => new Set(props.modelValue.map(authorizationSelectionKey)));

// 同一 tick 内连续触发多次选择变更时（例如连续点击多张表），父组件回流的 props 尚未更新，
// 这里用最近一次发出的值作为基准，避免后一次变更覆盖前一次导致选择丢失。
let pendingSelections: DatabaseAuthorizationSelection[] | null = null;
watch(
  () => props.modelValue,
  (value) => {
    pendingSelections = value;
    for (const selection of value) {
      if (selection.tables !== undefined) void loadTables({ database: selection.database, ...(selection.catalog ? { catalog: selection.catalog } : {}) });
    }
  },
  { immediate: true },
);

watch(
  () => props.databases,
  () => {
    for (const selection of props.modelValue) {
      if (selection.tables !== undefined) void loadTables({ database: selection.database, ...(selection.catalog ? { catalog: selection.catalog } : {}) });
    }
  },
);

function currentSelections(): DatabaseAuthorizationSelection[] {
  return pendingSelections ?? props.modelValue;
}

function commitSelections(next: DatabaseAuthorizationSelection[]) {
  pendingSelections = next;
  emit("update:modelValue", next);
}

function selectionFor(database: AuthorizationDatabaseOption): DatabaseAuthorizationSelection | undefined {
  const key = authorizationOptionKey(database);
  return props.modelValue.find((selection) => authorizationSelectionKey(selection) === key);
}

/**
 * 统一以“不可变更新”方式回写选中项：始终替换为新的数组与对象，
 * 避免直接修改 props 中的对象引用（v-model 单向数据流的约束）。
 */
function patchSelection(database: AuthorizationDatabaseOption, patch: (selection: DatabaseAuthorizationSelection) => DatabaseAuthorizationSelection | undefined) {
  const next: DatabaseAuthorizationSelection[] = [];
  for (const selection of currentSelections()) {
    if (authorizationSelectionKey(selection) !== authorizationOptionKey(database)) {
      next.push(selection);
      continue;
    }
    const updated = patch({ ...selection });
    if (updated) next.push({ ...updated, tables: updated.tables?.map((table) => ({ ...table })), privileges: updated.privileges ? [...updated.privileges] : undefined });
  }
  commitSelections(next);
}

function toggleDatabase(database: AuthorizationDatabaseOption) {
  if (selectionFor(database)) {
    commitSelections(currentSelections().filter((selection) => authorizationSelectionKey(selection) !== authorizationOptionKey(database)));
    return;
  }
  commitSelections([...currentSelections(), { database: database.database, ...(database.catalog ? { catalog: database.catalog } : {}), preset: "readOnly", privileges: ["SELECT"] }]);
}

// 表范围下 MySQL 不支持 CREATE ROUTINE / EVENT 等库级权限，需要按目标作用域过滤可选权限
function privilegesForSelection(selection?: DatabaseAuthorizationSelection): string[] {
  const userProvider = props.provider;
  if (!userProvider) return [];
  return authorizationPrivileges(userProvider, selection?.tables === undefined ? "database" : "table");
}

function usesSelectedTables(database: AuthorizationDatabaseOption): boolean {
  return selectionFor(database)?.tables !== undefined;
}

function isTableSelected(database: AuthorizationDatabaseOption, table: AuthorizationTableSelection): boolean {
  return selectionFor(database)?.tables?.some((selected) => authorizationTableKey(selected) === authorizationTableKey(table)) ?? false;
}

function allTablesSelected(database: AuthorizationDatabaseOption): boolean {
  const key = authorizationOptionKey(database);
  const available = tables.value[key] ?? [];
  const selected = new Set(selectionFor(database)?.tables?.map(authorizationTableKey) ?? []);
  return available.length > 0 && available.every((table) => selected.has(authorizationTableKey(table)));
}

function filteredTables(database: AuthorizationDatabaseOption): AuthorizationTableSelection[] {
  const key = authorizationOptionKey(database);
  const query = (tableSearch.value[key] ?? "").trim().toLowerCase();
  const available = tables.value[key] ?? [];
  return query ? available.filter((table) => tableLabel(table).toLowerCase().includes(query)) : available;
}

async function loadTables(database: AuthorizationDatabaseOption) {
  const key = authorizationOptionKey(database);
  if (tables.value[key] || tablesLoading.value[key]) return;
  tablesLoading.value = { ...tablesLoading.value, [key]: true };
  tableErrors.value = { ...tableErrors.value, [key]: "" };
  try {
    let result: AuthorizationTableSelection[];
    if (props.provider?.authorizationModel === "postgres") {
      const schemas = (await api.listSchemas(props.connectionId, database.database)).filter(isPostgresGrantSchema);
      const schemaTables = await Promise.all(
        schemas.map(async (schema) => {
          const items = await api.listTables(props.connectionId, database.database, schema, undefined, undefined, undefined, ["TABLE"]);
          return items.map((table) => ({ name: table.name, schema }));
        }),
      );
      result = schemaTables.flat();
    } else if (props.provider?.authorizationModel === "starrocks") {
      const items = await api.listTables(props.connectionId, database.database, "", undefined, undefined, undefined, ["TABLE"], database.catalog);
      result = items.map((table) => ({ name: table.name }));
    } else {
      const items = await api.listTables(props.connectionId, database.database, "");
      result = items.map((table) => ({ name: table.name }));
    }
    tables.value = {
      ...tables.value,
      [key]: uniqueTableOptions(result).sort((left, right) => tableLabel(left).localeCompare(tableLabel(right))),
    };
  } catch (error: any) {
    tableErrors.value = { ...tableErrors.value, [key]: error?.message || String(error) };
  } finally {
    tablesLoading.value = { ...tablesLoading.value, [key]: false };
  }
}

async function updateTableScope(database: AuthorizationDatabaseOption, selectTables: boolean) {
  if (!selectTables) {
    patchSelection(database, (selection) => {
      delete selection.tables;
      return selection;
    });
    return;
  }
  patchSelection(database, (selection) => {
    selection.tables = selection.tables ?? [];
    if (authorizationPresetPrivileges(props.provider!, selection.preset, selection.privileges, "table").length === 0) selection.preset = "readOnly";
    if (selection.preset === "custom") {
      const allowed = new Set(privilegesForSelection(selection));
      selection.privileges = (selection.privileges ?? []).filter((privilege) => allowed.has(privilege));
    }
    return selection;
  });
  await loadTables(database);
}

function toggleTable(database: AuthorizationDatabaseOption, table: AuthorizationTableSelection) {
  patchSelection(database, (selection) => {
    if (!selection.tables) return selection;
    const key = authorizationTableKey(table);
    selection.tables = selection.tables.some((selected) => authorizationTableKey(selected) === key) ? selection.tables.filter((selected) => authorizationTableKey(selected) !== key) : [...selection.tables, table];
    return selection;
  });
}

function toggleAllTables(database: AuthorizationDatabaseOption) {
  patchSelection(database, (selection) => {
    if (!selection.tables) return selection;
    const available = tables.value[authorizationOptionKey(database)] ?? [];
    selection.tables = allTablesSelected(database) ? [] : [...available];
    return selection;
  });
}

function updatePreset(database: AuthorizationDatabaseOption, preset: unknown) {
  if (typeof preset !== "string") return;
  patchSelection(database, (selection) => {
    selection.preset = preset as AuthorizationPreset;
    return selection;
  });
}

function togglePrivilege(database: AuthorizationDatabaseOption, privilege: string) {
  patchSelection(database, (selection) => {
    const next = new Set(selection.privileges ?? []);
    if (next.has(privilege)) next.delete(privilege);
    else next.add(privilege);
    selection.privileges = Array.from(next);
    return selection;
  });
}

function isPrivilegeSelected(database: AuthorizationDatabaseOption, privilege: string): boolean {
  return selectionFor(database)?.privileges?.includes(privilege) ?? false;
}

function authorizationOptionKey(option: AuthorizationDatabaseOption): string {
  return JSON.stringify([option.catalog ?? "", option.database]);
}

function authorizationSelectionKey(selection: Pick<DatabaseAuthorizationSelection, "catalog" | "database">): string {
  return authorizationOptionKey(selection);
}

function databaseLabel(option: AuthorizationDatabaseOption): string {
  return option.catalog ? `${option.catalog} / ${option.database}` : option.database;
}

function authorizationTableKey(table: AuthorizationTableSelection): string {
  return JSON.stringify([table.schema ?? "", table.name]);
}

function tableLabel(table: AuthorizationTableSelection): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function uniqueTableOptions(options: AuthorizationTableSelection[]): AuthorizationTableSelection[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (!option.name.trim()) return false;
    const key = authorizationTableKey(option);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPostgresGrantSchema(schema: string): boolean {
  const normalized = schema.toLowerCase();
  return !!schema.trim() && normalized !== "information_schema" && normalized !== "sys_catalog" && !normalized.startsWith("pg_");
}
</script>

<template>
  <div class="flex flex-col gap-2" :class="compact ? 'h-full min-h-0' : ''">
    <div v-if="!compact" class="flex items-center justify-between gap-3">
      <div>
        <div class="text-xs font-medium">{{ t("userAdmin.databaseAccess") }}</div>
        <div class="mt-1 text-[11px] text-muted-foreground">{{ t("userAdmin.databaseAccessHint") }}</div>
      </div>
      <Badge variant="outline">{{ t("userAdmin.selectedDatabaseCount", { count: modelValue.length }) }}</Badge>
    </div>
    <div class="flex h-8 shrink-0 items-center gap-2 rounded-md border px-2">
      <Search class="h-3.5 w-3.5 text-muted-foreground" />
      <input v-model="search" class="min-w-0 flex-1 bg-transparent text-xs outline-none" :placeholder="t('userAdmin.searchDatabase')" />
    </div>
    <!-- 紧凑模式下面板高度有限，数据库列表占满剩余高度并自行滚动，避免多个库挤在一起 -->
    <div class="overflow-auto rounded-md border" :class="compact ? 'min-h-0 flex-1' : 'max-h-64'">
      <div v-if="databasesLoading" class="flex items-center gap-2 p-3 text-xs text-muted-foreground">
        <Loader2 class="h-3.5 w-3.5 animate-spin" />
        {{ t("userAdmin.loadingDatabases") }}
      </div>
      <div v-else-if="visibleDatabases.length === 0" class="p-3 text-center text-xs text-muted-foreground">{{ t("userAdmin.emptyDatabases") }}</div>
      <div v-for="database in visibleDatabases" :key="authorizationOptionKey(database)" class="border-b p-2" :class="compact ? '' : 'last:border-b-0'">
        <div class="flex items-center gap-2">
          <input :checked="selectedDatabaseSet.has(authorizationOptionKey(database))" type="checkbox" class="h-3.5 w-3.5 accent-primary" @change="toggleDatabase(database)" />
          <button type="button" class="min-w-0 flex-1 truncate text-left text-xs font-medium" @click="toggleDatabase(database)">
            {{ database.database === GLOBAL_SCOPE ? t("userAdmin.globalScope") : databaseLabel(database) }}
          </button>
          <Select v-if="selectedDatabaseSet.has(authorizationOptionKey(database))" :model-value="selectionFor(database)?.preset" @update:model-value="updatePreset(database, $event)">
            <SelectTrigger class="h-7 text-xs" :class="compact ? 'w-28' : 'w-32'"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="readWrite">{{ t("userAdmin.presetReadWrite") }}</SelectItem>
              <SelectItem value="readOnly">{{ t("userAdmin.presetReadOnly") }}</SelectItem>
              <SelectItem value="ddl">{{ t("userAdmin.presetDdl") }}</SelectItem>
              <SelectItem value="dml">{{ t("userAdmin.presetDml") }}</SelectItem>
              <SelectItem value="custom">{{ t("userAdmin.presetCustom") }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div v-if="supportsTableGrants && database.database !== GLOBAL_SCOPE && selectedDatabaseSet.has(authorizationOptionKey(database))" class="mt-2 flex gap-2" :class="compact ? 'flex-col gap-1.5' : 'items-center pl-5'">
          <div class="flex items-center gap-2">
            <span v-if="!compact" class="shrink-0 text-[11px] text-muted-foreground">{{ t("userAdmin.tableScope") }}</span>
            <div class="flex h-7 shrink-0 items-center rounded-md border bg-muted/30 p-0.5">
              <button type="button" class="h-5 rounded px-2 text-[10px]" :class="!usesSelectedTables(database) ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground'" @click="updateTableScope(database, false)">
                {{ t("userAdmin.allTables") }}
              </button>
              <button type="button" class="h-5 rounded px-2 text-[10px]" :class="usesSelectedTables(database) ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground'" @click="updateTableScope(database, true)">
                {{ t("userAdmin.specificTables") }}
              </button>
            </div>
          </div>
          <Popover v-if="usesSelectedTables(database)">
            <PopoverTrigger as-child>
              <button type="button" class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-background px-2 text-left hover:bg-accent" :class="compact ? 'h-9 text-xs' : 'h-7 text-[11px]'">
                <Table2 class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span class="min-w-0 flex-1 truncate">
                  {{ selectionFor(database)?.tables?.length ? t("userAdmin.selectedTableCount", { count: selectionFor(database)?.tables?.length }) : t("userAdmin.chooseTables") }}
                </span>
                <Loader2 v-if="tablesLoading[authorizationOptionKey(database)]" class="h-3.5 w-3.5 shrink-0 animate-spin" />
                <ChevronDown v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" class="w-72 p-0">
              <div class="flex items-center gap-2 border-b p-2">
                <div class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2">
                  <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input v-model="tableSearch[authorizationOptionKey(database)]" class="min-w-0 flex-1 bg-transparent text-[11px] outline-none" :placeholder="t('userAdmin.searchTable')" />
                </div>
                <button type="button" class="shrink-0 text-[11px] text-primary disabled:text-muted-foreground" :disabled="!(tables[authorizationOptionKey(database)]?.length > 0)" @click="toggleAllTables(database)">
                  {{ t(allTablesSelected(database) ? "userAdmin.clearAllTables" : "userAdmin.selectAllTables") }}
                </button>
              </div>
              <div class="max-h-56 overflow-auto p-1">
                <div v-if="tablesLoading[authorizationOptionKey(database)]" class="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                  <Loader2 class="h-3.5 w-3.5 animate-spin" />
                  {{ t("userAdmin.loadingTables") }}
                </div>
                <div v-else-if="tableErrors[authorizationOptionKey(database)]" class="px-3 py-4 text-center text-xs text-destructive">
                  <p class="break-words">{{ t("userAdmin.loadTablesFailed", { message: tableErrors[authorizationOptionKey(database)] }) }}</p>
                  <button type="button" class="mt-2 text-primary" @click="loadTables(database)">{{ t("userAdmin.retry") }}</button>
                </div>
                <div v-else-if="filteredTables(database).length === 0" class="px-3 py-6 text-center text-xs text-muted-foreground">
                  {{ t("userAdmin.emptyTables") }}
                </div>
                <button v-for="table in filteredTables(database)" :key="authorizationTableKey(table)" type="button" class="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs hover:bg-accent" @click="toggleTable(database, table)">
                  <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border" :class="isTableSelected(database, table) ? 'border-primary bg-primary text-primary-foreground' : 'border-border'">
                    <Check v-if="isTableSelected(database, table)" class="h-2.5 w-2.5" />
                  </span>
                  <span class="min-w-0 flex-1 truncate">{{ tableLabel(table) }}</span>
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <p v-if="usesSelectedTables(database) && !selectionFor(database)?.tables?.length" class="mt-1 text-[10px] text-destructive" :class="compact ? '' : 'pl-5'">
          {{ t("userAdmin.tableSelectionRequired") }}
        </p>
        <div v-if="selectionFor(database)?.preset === 'custom'" class="mt-2 grid gap-1.5" :class="compact ? 'grid-cols-2' : 'grid-cols-3 pl-5'">
          <button
            v-for="privilege in privilegesForSelection(selectionFor(database))"
            :key="privilege"
            type="button"
            :title="privilege"
            class="flex h-7 min-w-0 items-center gap-1.5 rounded border px-2 text-[10px]"
            :class="isPrivilegeSelected(database, privilege) ? 'border-primary bg-primary/10 text-primary' : 'bg-background'"
            @click="togglePrivilege(database, privilege)"
          >
            <Check v-if="isPrivilegeSelected(database, privilege)" class="h-3 w-3 shrink-0" />
            <span class="min-w-0 flex-1 truncate text-left">{{ privilege }}</span>
          </button>
          <p v-if="!selectionFor(database)?.privileges?.length" class="text-[10px] text-destructive" :class="compact ? 'col-span-2' : 'col-span-3'">
            {{ t("userAdmin.customPrivilegeRequired") }}
          </p>
        </div>
        <p v-if="provider?.dialect === 'postgres' && selectedDatabaseSet.has(authorizationOptionKey(database)) && selectionFor(database)?.preset === 'ddl'" class="mt-2 text-[10px] text-muted-foreground" :class="compact ? '' : 'pl-5'">
          {{ t("userAdmin.postgresDdlHint") }}
        </p>
      </div>
    </div>
  </div>
</template>
