<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, ChevronDown, Loader2, Search, Table2 } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as api from "@/lib/backend/api";
import { authorizationPrivileges, type AuthorizationPreset, type DatabaseAuthorizationSelection } from "@/lib/database/databaseAuthorizationPlan";
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
  databases: string[];
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
const search = ref("");
// 表列表按库懒加载并缓存，避免下拉展开时重复请求
const tables = ref<Record<string, string[]>>({});
const tablesLoading = ref<Record<string, boolean>>({});
const tableErrors = ref<Record<string, string>>({});
const tableSearch = ref<Record<string, string>>({});

const supportsTableGrants = computed(() => !!props.provider?.supportsTableGrantsOnCreate);
const filteredDatabases = computed(() => {
  const query = search.value.trim().toLowerCase();
  return query ? props.databases.filter((database) => database.toLowerCase().includes(query)) : props.databases;
});
// 紧凑模式（权限编辑面板）在列表顶部提供固定的「全局」入口，且不受库搜索影响；
// 新增用户弹窗保持只勾选真实数据库，不改变原有产品行为。
const visibleDatabases = computed(() => (props.compact ? [GLOBAL_SCOPE, ...filteredDatabases.value] : filteredDatabases.value));
const selectedDatabaseSet = computed(() => new Set(props.modelValue.map((selection) => selection.database)));

// 同一 tick 内连续触发多次选择变更时（例如连续点击多张表），父组件回流的 props 尚未更新，
// 这里用最近一次发出的值作为基准，避免后一次变更覆盖前一次导致选择丢失。
let pendingSelections: DatabaseAuthorizationSelection[] | null = null;
watch(
  () => props.modelValue,
  (value) => {
    pendingSelections = value;
  },
);

function currentSelections(): DatabaseAuthorizationSelection[] {
  return pendingSelections ?? props.modelValue;
}

function commitSelections(next: DatabaseAuthorizationSelection[]) {
  pendingSelections = next;
  emit("update:modelValue", next);
}

function selectionFor(database: string): DatabaseAuthorizationSelection | undefined {
  return props.modelValue.find((selection) => selection.database === database);
}

/**
 * 统一以“不可变更新”方式回写选中项：始终替换为新的数组与对象，
 * 避免直接修改 props 中的对象引用（v-model 单向数据流的约束）。
 */
function patchSelection(database: string, patch: (selection: DatabaseAuthorizationSelection) => DatabaseAuthorizationSelection | undefined) {
  const next: DatabaseAuthorizationSelection[] = [];
  for (const selection of currentSelections()) {
    if (selection.database !== database) {
      next.push(selection);
      continue;
    }
    const updated = patch({ ...selection });
    if (updated) next.push({ ...updated, tables: updated.tables ? [...updated.tables] : undefined, privileges: updated.privileges ? [...updated.privileges] : undefined });
  }
  commitSelections(next);
}

function toggleDatabase(database: string) {
  if (selectionFor(database)) {
    commitSelections(currentSelections().filter((selection) => selection.database !== database));
    return;
  }
  commitSelections([...currentSelections(), { database, preset: "readOnly", privileges: ["SELECT"] }]);
}

// 表范围下 MySQL 不支持 CREATE ROUTINE / EVENT 等库级权限，需要按目标作用域过滤可选权限
function privilegesForSelection(selection?: DatabaseAuthorizationSelection): string[] {
  const userProvider = props.provider;
  if (!userProvider) return [];
  return authorizationPrivileges(userProvider, selection?.tables === undefined ? "database" : "table");
}

function usesSelectedTables(database: string): boolean {
  return selectionFor(database)?.tables !== undefined;
}

function isTableSelected(database: string, table: string): boolean {
  return selectionFor(database)?.tables?.includes(table) ?? false;
}

function allTablesSelected(database: string): boolean {
  const available = tables.value[database] ?? [];
  return available.length > 0 && selectionFor(database)?.tables?.length === available.length;
}

function filteredTables(database: string): string[] {
  const query = (tableSearch.value[database] ?? "").trim().toLowerCase();
  const available = tables.value[database] ?? [];
  return query ? available.filter((table) => table.toLowerCase().includes(query)) : available;
}

async function loadTables(database: string) {
  if (tables.value[database] || tablesLoading.value[database]) return;
  tablesLoading.value = { ...tablesLoading.value, [database]: true };
  tableErrors.value = { ...tableErrors.value, [database]: "" };
  try {
    const result = await api.listTables(props.connectionId, database, "");
    tables.value = {
      ...tables.value,
      [database]: Array.from(new Set(result.map((table) => table.name.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right)),
    };
  } catch (error: any) {
    tableErrors.value = { ...tableErrors.value, [database]: error?.message || String(error) };
  } finally {
    tablesLoading.value = { ...tablesLoading.value, [database]: false };
  }
}

async function updateTableScope(database: string, selectTables: boolean) {
  if (!selectTables) {
    patchSelection(database, (selection) => {
      delete selection.tables;
      return selection;
    });
    return;
  }
  patchSelection(database, (selection) => {
    selection.tables = selection.tables ?? [];
    if (selection.preset === "custom") {
      const allowed = new Set(privilegesForSelection(selection));
      selection.privileges = (selection.privileges ?? []).filter((privilege) => allowed.has(privilege));
    }
    return selection;
  });
  await loadTables(database);
}

function toggleTable(database: string, table: string) {
  patchSelection(database, (selection) => {
    if (!selection.tables) return selection;
    const next = new Set(selection.tables);
    if (next.has(table)) next.delete(table);
    else next.add(table);
    selection.tables = Array.from(next);
    return selection;
  });
}

function toggleAllTables(database: string) {
  patchSelection(database, (selection) => {
    if (!selection.tables) return selection;
    const available = tables.value[database] ?? [];
    selection.tables = selection.tables.length === available.length ? [] : [...available];
    return selection;
  });
}

function updatePreset(database: string, preset: unknown) {
  if (typeof preset !== "string") return;
  patchSelection(database, (selection) => {
    selection.preset = preset as AuthorizationPreset;
    return selection;
  });
}

function togglePrivilege(database: string, privilege: string) {
  patchSelection(database, (selection) => {
    const next = new Set(selection.privileges ?? []);
    if (next.has(privilege)) next.delete(privilege);
    else next.add(privilege);
    selection.privileges = Array.from(next);
    return selection;
  });
}

function isPrivilegeSelected(database: string, privilege: string): boolean {
  return selectionFor(database)?.privileges?.includes(privilege) ?? false;
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
      <div v-for="database in visibleDatabases" :key="database" class="border-b p-2" :class="compact ? '' : 'last:border-b-0'">
        <div class="flex items-center gap-2">
          <input :checked="selectedDatabaseSet.has(database)" type="checkbox" class="h-3.5 w-3.5 accent-primary" @change="toggleDatabase(database)" />
          <button type="button" class="min-w-0 flex-1 truncate text-left text-xs font-medium" @click="toggleDatabase(database)">
            {{ database === GLOBAL_SCOPE ? t("userAdmin.globalScope") : database }}
          </button>
          <Select v-if="selectedDatabaseSet.has(database)" :model-value="selectionFor(database)?.preset" @update:model-value="updatePreset(database, $event)">
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
        <div v-if="supportsTableGrants && database !== GLOBAL_SCOPE && selectedDatabaseSet.has(database)" class="mt-2 flex gap-2" :class="compact ? 'flex-col gap-1.5' : 'items-center pl-5'">
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
                <Loader2 v-if="tablesLoading[database]" class="h-3.5 w-3.5 shrink-0 animate-spin" />
                <ChevronDown v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" class="w-72 p-0">
              <div class="flex items-center gap-2 border-b p-2">
                <div class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2">
                  <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input v-model="tableSearch[database]" class="min-w-0 flex-1 bg-transparent text-[11px] outline-none" :placeholder="t('userAdmin.searchTable')" />
                </div>
                <button type="button" class="shrink-0 text-[11px] text-primary disabled:text-muted-foreground" :disabled="!(tables[database]?.length > 0)" @click="toggleAllTables(database)">
                  {{ t(allTablesSelected(database) ? "userAdmin.clearAllTables" : "userAdmin.selectAllTables") }}
                </button>
              </div>
              <div class="max-h-56 overflow-auto p-1">
                <div v-if="tablesLoading[database]" class="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                  <Loader2 class="h-3.5 w-3.5 animate-spin" />
                  {{ t("userAdmin.loadingTables") }}
                </div>
                <div v-else-if="tableErrors[database]" class="px-3 py-4 text-center text-xs text-destructive">
                  <p class="break-words">{{ t("userAdmin.loadTablesFailed", { message: tableErrors[database] }) }}</p>
                  <button type="button" class="mt-2 text-primary" @click="loadTables(database)">{{ t("userAdmin.retry") }}</button>
                </div>
                <div v-else-if="filteredTables(database).length === 0" class="px-3 py-6 text-center text-xs text-muted-foreground">
                  {{ t("userAdmin.emptyTables") }}
                </div>
                <button v-for="table in filteredTables(database)" :key="table" type="button" class="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs hover:bg-accent" @click="toggleTable(database, table)">
                  <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border" :class="isTableSelected(database, table) ? 'border-primary bg-primary text-primary-foreground' : 'border-border'">
                    <Check v-if="isTableSelected(database, table)" class="h-2.5 w-2.5" />
                  </span>
                  <span class="min-w-0 flex-1 truncate">{{ table }}</span>
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
        <p v-if="provider?.dialect === 'postgres' && selectedDatabaseSet.has(database) && selectionFor(database)?.preset === 'ddl'" class="mt-2 text-[10px] text-muted-foreground" :class="compact ? '' : 'pl-5'">
          {{ t("userAdmin.postgresDdlHint") }}
        </p>
      </div>
    </div>
  </div>
</template>
