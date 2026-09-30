<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, Unlock, UserRound, UsersRound } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import type { ConnectionConfig, QueryResult } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import {
  xuguAclAuthorityLabels,
  parseXuguAclRows,
  parseXuguMemberships,
  parseXuguPrincipals,
  xuguAclRowsFallbackSql,
  xuguAclRowsSql,
  xuguAclColumnTargetsSql,
  xuguAlterLockSql,
  xuguAlterAccountSql,
  xuguAlterPasswordSql,
  xuguCreatePrincipalSql,
  xuguEnrichAclColumnTargets,
  xuguDatabaseOptions,
  xuguDropPrincipalSql,
  xuguFallbackListRolesSql,
  xuguFallbackListUsersSql,
  xuguGrantSql,
  xuguInheritedRoleIds,
  xuguListRolesSql,
  xuguListUsersSql,
  xuguListSchemasSql,
  xuguListObjectNamesSql,
  xuguListColumnNamesSql,
  xuguRevokeSql,
  xuguRoleMembershipsFallbackSql,
  xuguRoleMembershipsSql,
  xuguPrivilegesForScope,
  xuguPrincipalIsProtected,
  XUGU_OBJECT_TYPES,
  type XuguAclRow,
  type XuguAdminAuthority,
  type XuguPrincipal,
  type XuguPrivilegeScope,
} from "@/lib/database/xuguUserPermissions";

const props = defineProps<{ connection: ConnectionConfig }>();
const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();

const users = ref<XuguPrincipal[]>([]);
const roles = ref<XuguPrincipal[]>([]);
const databaseNames = ref<string[]>([]);
const selectedDatabase = ref(props.connection.database?.trim() ?? "");
const databaseListLimited = ref(false);
const databaseContextUnknown = ref(false);
const schemas = ref<string[]>([]);
const objectNames = ref<string[]>([]);
const columnNames = ref<string[]>([]);
const targetLookupIncomplete = ref(false);
const targetLookupFailed = ref(false);
const memberships = ref<Array<{ userId: string; roleId: string }>>([]);
const aclRows = ref<XuguAclRow[]>([]);
const kind = ref<"user" | "role">("user");
const selectedId = ref("");
const search = ref("");
const loading = ref(false);
const loadingAcl = ref(false);
const mutating = ref(false);
const loadError = ref("");
const aclError = ref("");
const dbaCatalogAvailable = ref(false);
const aclCatalogAvailable = ref(false);
const roleMembershipsAvailable = ref(false);
const currentDatabaseIsSystem = ref(false);
const createDialogOpen = ref(false);
const passwordDialogOpen = ref(false);
const accountDialogOpen = ref(false);

const principalName = ref("");
const principalPassword = ref("");
const defaultRoleNames = ref<string[]>([]);
const createValidUntil = ref("");
const createLocked = ref(false);
const createPasswordExpired = ref(false);
const passwordToSet = ref("");
const validUntilToSet = ref("");
const expirePassword = ref(false);
const grantScope = ref<XuguPrivilegeScope>("database");
const objectType = ref("TABLE");
const schemaName = ref("");
const objectName = ref("");
const columnName = ref("");
const roleName = ref("");
const adminAuthority = ref<XuguAdminAuthority>("DBA");
const selectedPrivileges = ref<string[]>([]);
const grantOption = ref(false);
const revokeGrantOptionOnly = ref(false);
const pendingSql = ref("");
const pendingLabel = ref("");
const pendingSystemWide = ref(false);
const sqlDialogOpen = ref(false);
let targetLookupTimer: ReturnType<typeof setTimeout> | undefined;
let targetLookupRequestId = 0;
let permissionsRequestId = 0;
let principalsRequestId = 0;
let databaseContextReady = false;
let pauseDatabaseWatcher = false;

const principals = computed(() => (kind.value === "user" ? users.value : roles.value));
const selectedPrincipal = computed(() => principals.value.find((principal) => principal.id === selectedId.value));
const selectedPrincipalProtected = computed(() => (selectedPrincipal.value ? xuguPrincipalIsProtected(selectedPrincipal.value) : true));
const visiblePrincipals = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return query ? principals.value.filter((principal) => principal.name.toLocaleLowerCase().includes(query)) : principals.value;
});
const canMutate = computed(() => !props.connection.read_only && !!selectedDatabase.value && dbaCatalogAvailable.value && aclCatalogAvailable.value && roleMembershipsAvailable.value);
const availablePrivileges = computed(() => xuguPrivilegesForScope(grantScope.value, objectType.value, currentDatabaseIsSystem.value));
const selectedPrivilegeSet = computed(() => new Set(selectedPrivileges.value));
const rolePrincipalMap = computed(() => new Map([...users.value, ...roles.value].map((principal) => [principal.id, principal])));
const inheritedRoleIds = computed(() => (selectedPrincipal.value ? xuguInheritedRoleIds(selectedPrincipal.value.id, memberships.value) : []));
const effectiveRoleNames = computed(() => inheritedRoleIds.value.map((id) => rolePrincipalMap.value.get(id)?.name ?? `#${id}`));
const permissionRows = computed(() =>
  aclRows.value.flatMap((row) => {
    const names = xuguAclAuthorityLabels(row.authority, row.objectType, row.scope, t("xuguUserPermissions.unmappedAuthority"));
    return names.map((name) => ({ ...row, name }));
  }),
);
const previewSql = computed(() => pendingSql.value.replace(/(IDENTIFIED BY\s+)('(?:''|[^'])*')/i, "$1'••••••'"));
const scopeOptions = computed(() => {
  const options: Array<{ value: XuguPrivilegeScope; label: string }> = [
    { value: "database", label: "xuguUserPermissions.scopeDatabase" },
    { value: "schema", label: "xuguUserPermissions.scopeSchema" },
    { value: "object", label: "xuguUserPermissions.scopeObject" },
    { value: "column", label: "xuguUserPermissions.scopeColumn" },
    { value: "role", label: "xuguUserPermissions.scopeRole" },
    { value: "admin", label: "xuguUserPermissions.scopeAdmin" },
  ];
  if (currentDatabaseIsSystem.value) options.unshift({ value: "system", label: "xuguUserPermissions.scopeSystem" });
  return options;
});

function resultError(result: QueryResult): Error | undefined {
  if (!result.execution_error) return undefined;
  return new Error(String(result.rows[0]?.[0] ?? "Query failed"));
}

function requireColumns(result: QueryResult, required: string[], catalogName: string) {
  const columns = new Set(result.columns.map((column) => column.toLowerCase()));
  const missing = required.filter((column) => !columns.has(column.toLowerCase()));
  if (missing.length) throw new Error(`${catalogName} returned an unexpected shape (missing ${missing.join(", ")}).`);
}

async function query(sql: string, maxRows = 5000): Promise<QueryResult> {
  const result = await api.executeQuery(props.connection.id, selectedDatabase.value, sql, undefined, undefined, { maxRows });
  const error = resultError(result);
  if (error) throw error;
  return result;
}

async function queryEither(primary: string, fallback: string): Promise<{ result: QueryResult; privileged: boolean }> {
  try {
    return { result: await query(primary), privileged: true };
  } catch (primaryError) {
    try {
      return { result: await query(fallback), privileged: false };
    } catch {
      throw primaryError;
    }
  }
}

async function ensureConnection() {
  await connectionStore.ensureConnected(props.connection.id);
}

async function loadDatabaseContext() {
  await ensureConnection();
  let currentDatabase = selectedDatabase.value.trim() || props.connection.database?.trim() || "";
  let names: string[] = [];
  databaseListLimited.value = false;
  try {
    names = (await api.listDatabases(props.connection.id)).map((database) => database.name);
  } catch {
    databaseListLimited.value = true;
  }
  if (!currentDatabase) {
    try {
      const result = await api.executeQuery(props.connection.id, "", "SELECT DATABASE() AS DATABASE_NAME;");
      const error = resultError(result);
      if (error) throw error;
      const index = result.columns.findIndex((column) => column.toLowerCase() === "database_name");
      currentDatabase = index < 0 ? "" : String(result.rows[0]?.[index] ?? "").trim();
    } catch {
      // Keep the database unknown and disable mutations rather than guess which
      // database-scoped user catalog an empty connection context will address.
    }
  }
  const options = xuguDatabaseOptions(names, currentDatabase);
  pauseDatabaseWatcher = true;
  databaseNames.value = options;
  selectedDatabase.value = currentDatabase;
  databaseContextUnknown.value = !currentDatabase;
  pauseDatabaseWatcher = false;
  databaseContextReady = true;
}

async function loadPrincipals() {
  const requestId = ++principalsRequestId;
  loading.value = true;
  loadError.value = "";
  dbaCatalogAvailable.value = false;
  aclCatalogAvailable.value = false;
  roleMembershipsAvailable.value = false;
  try {
    await ensureConnection();
    if (!databaseContextReady) await loadDatabaseContext();
    if (requestId !== principalsRequestId) return;
    currentDatabaseIsSystem.value = false;
    try {
      const databaseResult = await query("SELECT DATABASE() AS DATABASE_NAME;");
      const databaseIndex = databaseResult.columns.findIndex((column) => column.toLowerCase() === "database_name");
      currentDatabaseIsSystem.value =
        databaseIndex >= 0 &&
        String(databaseResult.rows[0]?.[databaseIndex] ?? "")
          .trim()
          .toUpperCase() === "SYSTEM";
    } catch {
      // Fail closed: system-wide database lifecycle grants stay unavailable
      // when the current database cannot be identified.
    }
    if (!currentDatabaseIsSystem.value && grantScope.value === "system") grantScope.value = "database";
    const [userResult, roleResult] = await Promise.all([queryEither(xuguListUsersSql(), xuguFallbackListUsersSql()), queryEither(xuguListRolesSql(), xuguFallbackListRolesSql())]);
    if (requestId !== principalsRequestId) return;
    requireColumns(userResult.result, ["USER_ID", "USER_NAME"], "User catalog");
    requireColumns(roleResult.result, ["USER_ID", "USER_NAME"], "Role catalog");
    users.value = parseXuguPrincipals(userResult.result, false);
    roles.value = parseXuguPrincipals(roleResult.result, true);
    dbaCatalogAvailable.value = userResult.privileged && roleResult.privileged;
    try {
      const schemaResult = await query(xuguListSchemasSql(dbaCatalogAvailable.value));
      requireColumns(schemaResult, ["SCHEMA_NAME"], "Schema catalog");
      const schemaIndex = schemaResult.columns.findIndex((column) => column.toLowerCase() === "schema_name");
      schemas.value = schemaIndex < 0 ? [] : schemaResult.rows.map((row) => String(row[schemaIndex] ?? "")).filter(Boolean);
    } catch {
      schemas.value = [];
    }
    roleMembershipsAvailable.value = false;
    try {
      const result = await query(xuguRoleMembershipsSql());
      requireColumns(result, ["USER_ID", "ROLE_ID"], "Role membership catalog");
      memberships.value = parseXuguMemberships(result);
      roleMembershipsAvailable.value = true;
    } catch {
      try {
        const result = await query(xuguRoleMembershipsFallbackSql());
        requireColumns(result, ["USER_ID", "ROLE_ID"], "Role membership catalog");
        memberships.value = parseXuguMemberships(result);
        roleMembershipsAvailable.value = false;
      } catch {
        memberships.value = [];
        roleMembershipsAvailable.value = false;
      }
    }
    const nextList = kind.value === "user" ? users.value : roles.value;
    const nextSelectedId = nextList.some((principal) => principal.id === selectedId.value) ? selectedId.value : (nextList[0]?.id ?? "");
    if (nextSelectedId === selectedId.value) {
      if (selectedId.value) await loadPermissions();
    } else {
      selectedId.value = nextSelectedId;
    }
  } catch (error: any) {
    users.value = [];
    roles.value = [];
    memberships.value = [];
    aclRows.value = [];
    loadError.value = error?.message || String(error);
  } finally {
    if (requestId === principalsRequestId) loading.value = false;
  }
}

async function refreshPermissions() {
  if (loading.value || mutating.value) return;
  loading.value = true;
  try {
    await loadDatabaseContext();
    await loadPrincipals();
  } catch (error: any) {
    loadError.value = error?.message || String(error);
  } finally {
    loading.value = false;
  }
}

async function loadPermissions() {
  const requestId = ++permissionsRequestId;
  const principal = selectedPrincipal.value;
  if (!principal) {
    aclRows.value = [];
    aclCatalogAvailable.value = false;
    loadingAcl.value = false;
    aclError.value = "";
    return;
  }
  loadingAcl.value = true;
  aclCatalogAvailable.value = false;
  aclError.value = "";
  try {
    const ids = [principal.id, ...xuguInheritedRoleIds(principal.id, memberships.value)];
    let useDbaCatalog = true;
    try {
      const result = await query(xuguAclRowsSql(ids));
      if (requestId !== permissionsRequestId) return;
      requireColumns(result, ["GRANTOR_ID", "GRANTEE_ID", "OBJECT_ID", "OBJECT_TYPE", "AUTHORITY", "REGRANT", "TARGET_NAME"], "ACL catalog");
      aclRows.value = parseXuguAclRows(result, [...users.value, ...roles.value], principal.id, currentDatabaseIsSystem.value);
      aclCatalogAvailable.value = true;
    } catch (primaryError: any) {
      try {
        useDbaCatalog = false;
        const result = await query(xuguAclRowsFallbackSql(ids));
        if (requestId !== permissionsRequestId) return;
        requireColumns(result, ["GRANTOR_ID", "GRANTEE_ID", "OBJECT_ID", "OBJECT_TYPE", "AUTHORITY", "REGRANT", "TARGET_NAME"], "ACL catalog");
        aclRows.value = parseXuguAclRows(result, [...users.value, ...roles.value], principal.id, currentDatabaseIsSystem.value);
        aclCatalogAvailable.value = false;
      } catch {
        if (requestId !== permissionsRequestId) return;
        throw primaryError;
      }
    }
    if (aclRows.value.some((row) => row.scope === "column")) {
      try {
        const result = await query(xuguAclColumnTargetsSql(ids, useDbaCatalog));
        if (requestId !== permissionsRequestId) return;
        requireColumns(result, ["GRANTEE_ID", "OBJECT_ID", "OBJECT_TYPE", "TARGET_NAME"], "Column ACL target catalog");
        aclRows.value = xuguEnrichAclColumnTargets(aclRows.value, result);
      } catch {
        // Keep the base ACL rows visible with their explicit object-ID fallback
        // when a server version or restricted catalog cannot resolve columns.
      }
    }
  } catch (error: any) {
    if (requestId !== permissionsRequestId) return;
    aclRows.value = [];
    aclError.value = error?.message || String(error);
  } finally {
    if (requestId === permissionsRequestId) loadingAcl.value = false;
  }
}

async function loadTargetOptions(requestId: number) {
  objectNames.value = [];
  columnNames.value = [];
  targetLookupIncomplete.value = false;
  targetLookupFailed.value = false;
  if (!schemaName.value.trim()) return;
  try {
    if (grantScope.value === "object") {
      const result = await query(xuguListObjectNamesSql(schemaName.value, objectType.value, dbaCatalogAvailable.value), 1000);
      if (requestId !== targetLookupRequestId) return;
      const nameIndex = result.columns.findIndex((column) => column.toLowerCase() === "obj_name");
      objectNames.value = nameIndex < 0 ? [] : result.rows.map((row) => String(row[nameIndex] ?? "")).filter(Boolean);
      targetLookupIncomplete.value = result.truncated === true || result.rows.length >= 1000;
    } else if (grantScope.value === "column" && objectName.value.trim() && ["TABLE", "VIEW"].includes(objectType.value)) {
      const result = await query(xuguListColumnNamesSql(schemaName.value, objectName.value, objectType.value, dbaCatalogAvailable.value), 1000);
      if (requestId !== targetLookupRequestId) return;
      const nameIndex = result.columns.findIndex((column) => column.toLowerCase() === "col_name");
      columnNames.value = nameIndex < 0 ? [] : result.rows.map((row) => String(row[nameIndex] ?? "")).filter(Boolean);
      targetLookupIncomplete.value = result.truncated === true || result.rows.length >= 1000;
    }
  } catch {
    if (requestId === targetLookupRequestId) targetLookupFailed.value = true;
  }
}

function scheduleTargetLookup() {
  const requestId = ++targetLookupRequestId;
  if (targetLookupTimer) clearTimeout(targetLookupTimer);
  objectNames.value = [];
  columnNames.value = [];
  targetLookupIncomplete.value = false;
  targetLookupFailed.value = false;
  targetLookupTimer = setTimeout(() => void loadTargetOptions(requestId), 250);
}

function selectKind(nextKind: "user" | "role") {
  const previousId = selectedId.value;
  kind.value = nextKind;
  selectedId.value = (nextKind === "user" ? users.value : roles.value)[0]?.id ?? "";
  if (selectedId.value && selectedId.value === previousId) {
    aclCatalogAvailable.value = false;
    void loadPermissions();
  }
}

function togglePrivilege(privilege: string) {
  if (grantScope.value === "column") {
    selectedPrivileges.value = selectedPrivilegeSet.value.has(privilege) ? [] : [privilege];
    return;
  }
  if (grantScope.value === "object" && privilege === "ALL PRIVILEGES") {
    selectedPrivileges.value = selectedPrivilegeSet.value.has(privilege) ? [] : [privilege];
    return;
  }
  const next = new Set(selectedPrivileges.value);
  if (grantScope.value === "object") next.delete("ALL PRIVILEGES");
  if (next.has(privilege)) next.delete(privilege);
  else next.add(privilege);
  selectedPrivileges.value = [...next];
}

function preview(sql: string, label: string, systemWide = false) {
  pendingSql.value = sql;
  pendingLabel.value = label;
  pendingSystemWide.value = systemWide;
  sqlDialogOpen.value = true;
}

function buildPermissionSql(revoke: boolean): string {
  const principal = selectedPrincipal.value;
  if (!principal) throw new Error("Select a user or role first.");
  const input = {
    principal,
    scope: grantScope.value,
    privileges: selectedPrivileges.value,
    schema: schemaName.value,
    objectType: objectType.value,
    object: objectName.value,
    column: columnName.value,
    role: roleName.value,
    adminAuthority: adminAuthority.value,
    grantOption: grantOption.value,
    revokeGrantOptionOnly: revokeGrantOptionOnly.value,
    systemDatabase: currentDatabaseIsSystem.value,
  };
  return revoke ? xuguRevokeSql(input) : xuguGrantSql(input);
}

function previewPermission(revoke: boolean) {
  if (!canMutate.value || selectedPrincipalProtected.value) return;
  try {
    preview(buildPermissionSql(revoke), revoke ? t("xuguUserPermissions.revoke") : t("xuguUserPermissions.grant"), grantScope.value === "system");
  } catch (error: any) {
    toast(error?.message || String(error), 5000);
  }
}

function createPrincipal(): boolean {
  try {
    const isRole = kind.value === "role";
    const sql = xuguCreatePrincipalSql(principalName.value, isRole, principalPassword.value, {
      defaultRoles: defaultRoleNames.value,
      validUntil: createValidUntil.value,
      locked: createLocked.value,
      passwordExpired: createPasswordExpired.value,
    });
    preview(sql, t(isRole ? "xuguUserPermissions.createRole" : "xuguUserPermissions.createUser"));
    principalPassword.value = "";
    return true;
  } catch (error: any) {
    toast(error?.message || String(error), 5000);
    return false;
  }
}

function changePassword(): boolean {
  const principal = selectedPrincipal.value;
  if (!principal) return false;
  try {
    preview(xuguAlterPasswordSql(principal, passwordToSet.value), t("xuguUserPermissions.changePassword"));
    passwordToSet.value = "";
    return true;
  } catch (error: any) {
    toast(error?.message || String(error), 5000);
    return false;
  }
}

function previewNewPrincipal() {
  if (createPrincipal()) createDialogOpen.value = false;
}

function previewPasswordChange() {
  if (changePassword()) passwordDialogOpen.value = false;
}

function previewAccountChanges(): boolean {
  const principal = selectedPrincipal.value;
  if (!principal) return false;
  try {
    preview(xuguAlterAccountSql(principal, { validUntil: validUntilToSet.value, passwordExpired: expirePassword.value }), t("xuguUserPermissions.accountSettings"));
    accountDialogOpen.value = false;
    return true;
  } catch (error: any) {
    toast(error?.message || String(error), 5000);
    return false;
  }
}

function openAccountSettings() {
  validUntilToSet.value = "";
  expirePassword.value = false;
  accountDialogOpen.value = true;
}

async function applyPendingSql() {
  if (!pendingSql.value || !canMutate.value) return;
  mutating.value = true;
  try {
    const result = await executeWithProductionSqlGuard({
      connection: props.connection,
      database: selectedDatabase.value,
      sql: pendingSql.value,
      source: t("production.sourceAdmin"),
      execute: async () => {
        const results = await api.executeMulti(props.connection.id, selectedDatabase.value, pendingSql.value, undefined, undefined, { maxRows: 1000 });
        const failed = results.find((item) => item.execution_error === true);
        if (failed) throw new Error(String(failed.rows[0]?.[0] ?? t("xuguUserPermissions.operationFailed")));
        return true;
      },
    });
    if (!result) return;
    sqlDialogOpen.value = false;
    principalName.value = "";
    principalPassword.value = "";
    defaultRoleNames.value = [];
    createValidUntil.value = "";
    createLocked.value = false;
    createPasswordExpired.value = false;
    passwordToSet.value = "";
    validUntilToSet.value = "";
    expirePassword.value = false;
    toast(t("xuguUserPermissions.operationSuccess"), 2500);
    await loadPrincipals();
  } catch (error: any) {
    toast(t("xuguUserPermissions.operationFailedWithMessage", { message: error?.message || String(error) }), 6000);
  } finally {
    mutating.value = false;
  }
}

function lockPrincipal(locked: boolean) {
  const principal = selectedPrincipal.value;
  if (!principal) return;
  try {
    preview(xuguAlterLockSql(principal, locked), t(locked ? "xuguUserPermissions.lock" : "xuguUserPermissions.unlock"));
  } catch (error: any) {
    toast(error?.message || String(error), 5000);
  }
}

function dropPrincipal() {
  const principal = selectedPrincipal.value;
  if (!principal) return;
  try {
    preview(xuguDropPrincipalSql(principal), t(principal.isRole ? "xuguUserPermissions.dropRole" : "xuguUserPermissions.dropUser"));
  } catch (error: any) {
    toast(error?.message || String(error), 5000);
  }
}

watch(selectedId, () => {
  aclCatalogAvailable.value = false;
  void loadPermissions();
});
watch(
  selectedDatabase,
  (database, previousDatabase) => {
    if (!databaseContextReady || pauseDatabaseWatcher || database === previousDatabase) return;
    databaseContextUnknown.value = !database;
    users.value = [];
    roles.value = [];
    memberships.value = [];
    aclRows.value = [];
    selectedId.value = "";
    currentDatabaseIsSystem.value = false;
    void loadPrincipals();
  },
  { flush: "sync" },
);
watch(sqlDialogOpen, (open) => {
  if (!open) {
    pendingSql.value = "";
    pendingLabel.value = "";
    pendingSystemWide.value = false;
    principalPassword.value = "";
    passwordToSet.value = "";
  }
});
watch(grantScope, () => {
  selectedPrivileges.value = [];
  grantOption.value = false;
  revokeGrantOptionOnly.value = false;
});
watch(objectType, () => {
  selectedPrivileges.value = [];
});
watch([grantScope, schemaName, objectType, objectName], scheduleTargetLookup);
onMounted(() => void loadPrincipals());
onBeforeUnmount(() => {
  targetLookupRequestId += 1;
  if (targetLookupTimer) clearTimeout(targetLookupTimer);
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3 p-4">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <ShieldCheck class="size-5 text-primary" />
        <h1 class="text-lg font-semibold">{{ t("xuguUserPermissions.title") }}</h1>
        <Badge variant="outline">XuguDB</Badge>
      </div>
      <div class="flex items-center gap-2">
        <Badge v-if="connection.read_only" variant="secondary">{{ t("xuguUserPermissions.readOnly") }}</Badge>
        <label v-if="databaseNames.length" class="flex items-center gap-2 text-xs text-muted-foreground">
          {{ t("xuguUserPermissions.databaseContext") }}
          <select v-model="selectedDatabase" class="h-8 max-w-56 rounded-md border bg-background px-2 text-sm text-foreground" :disabled="loading || mutating || sqlDialogOpen">
            <option v-if="databaseContextUnknown" value="" disabled>{{ t("xuguUserPermissions.chooseDatabase") }}</option>
            <option v-for="database in databaseNames" :key="database" :value="database">{{ database }}</option>
          </select>
        </label>
        <Button variant="outline" size="sm" :disabled="loading || mutating" @click="refreshPermissions">
          <Loader2 v-if="loading" class="mr-2 size-4 animate-spin" />
          <RefreshCw v-else class="mr-2 size-4" />{{ t("xuguUserPermissions.refresh") }}
        </Button>
        <Button
          size="sm"
          :disabled="!canMutate"
          @click="
            principalName = '';
            principalPassword = '';
            defaultRoleNames = [];
            createValidUntil = '';
            createLocked = false;
            createPasswordExpired = false;
            sqlDialogOpen = false;
            createDialogOpen = true;
          "
        >
          <Plus class="mr-2 size-4" />{{ t("xuguUserPermissions.newPrincipal") }}
        </Button>
      </div>
    </header>

    <div v-if="loadError" class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{{ loadError }}</div>
    <div v-else-if="databaseContextUnknown" class="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-200">{{ t("xuguUserPermissions.databaseContextUnknown") }}</div>
    <div v-else-if="databaseListLimited" class="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-200">{{ t("xuguUserPermissions.databaseListLimited") }}</div>
    <div v-else-if="!dbaCatalogAvailable" class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <AlertTriangle class="mt-0.5 size-4 shrink-0 text-amber-600" />
      <span>{{ t("xuguUserPermissions.limitedCatalog") }}</span>
    </div>

    <div class="grid min-h-0 flex-1 grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)] gap-3">
      <aside class="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
        <div class="flex gap-1 border-b p-2">
          <Button class="flex-1" size="sm" :variant="kind === 'user' ? 'secondary' : 'ghost'" @click="selectKind('user')"
            ><UserRound class="mr-2 size-4" />{{ t("xuguUserPermissions.users") }} <span class="ml-1 text-muted-foreground">{{ users.length }}</span></Button
          >
          <Button class="flex-1" size="sm" :variant="kind === 'role' ? 'secondary' : 'ghost'" @click="selectKind('role')"
            ><UsersRound class="mr-2 size-4" />{{ t("xuguUserPermissions.roles") }} <span class="ml-1 text-muted-foreground">{{ roles.length }}</span></Button
          >
        </div>
        <div class="border-b p-2"><Input v-model="search" :placeholder="t('xuguUserPermissions.search')" /></div>
        <div class="min-h-0 flex-1 overflow-auto p-1">
          <button v-for="principal in visiblePrincipals" :key="principal.id" class="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-muted" :class="selectedId === principal.id ? 'bg-muted font-medium' : ''" @click="selectedId = principal.id">
            <span class="flex min-w-0 items-center gap-2"
              ><UserRound v-if="!principal.isRole" class="size-4 shrink-0 text-muted-foreground" /><UsersRound v-else class="size-4 shrink-0 text-muted-foreground" /><span class="truncate">{{ principal.name }}</span></span
            >
            <span class="flex gap-1"
              ><Badge v-if="principal.isSystem" variant="outline" class="px-1.5 py-0 text-[10px]">{{ t("xuguUserPermissions.system") }}</Badge
              ><Badge v-else-if="!principal.isRole && principal.locked" variant="destructive" class="px-1.5 py-0 text-[10px]">{{ t("xuguUserPermissions.locked") }}</Badge></span
            >
          </button>
          <div v-if="!loading && visiblePrincipals.length === 0" class="p-4 text-sm text-muted-foreground">{{ t("xuguUserPermissions.empty") }}</div>
        </div>
      </aside>

      <main class="flex min-h-0 flex-col gap-3 overflow-auto">
        <section v-if="selectedPrincipal" class="rounded-lg border bg-card p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-base font-semibold">{{ selectedPrincipal.name }}</h2>
                <Badge variant="outline">{{ selectedPrincipal.isRole ? t("xuguUserPermissions.role") : t("xuguUserPermissions.user") }}</Badge
                ><Badge v-if="selectedPrincipal.isSystem" variant="secondary">{{ t("xuguUserPermissions.systemPrincipal") }}</Badge
                ><Badge v-else-if="!selectedPrincipal.isRole" :variant="selectedPrincipal.locked ? 'destructive' : 'outline'">{{ selectedPrincipal.locked ? t("xuguUserPermissions.locked") : t("xuguUserPermissions.active") }}</Badge
                ><Badge v-if="selectedPrincipal.expired" variant="destructive">{{ t("xuguUserPermissions.expired") }}</Badge>
              </div>
              <p v-if="selectedPrincipal.validUntil" class="mt-1 text-xs text-muted-foreground">{{ t("xuguUserPermissions.validUntil", { value: selectedPrincipal.validUntil }) }}</p>
              <p v-if="effectiveRoleNames.length" class="mt-2 text-xs text-muted-foreground">{{ t("xuguUserPermissions.inheritedRoles", { roles: effectiveRoleNames.join(", ") }) }}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <Button
                v-if="!selectedPrincipal.isRole"
                size="sm"
                variant="outline"
                :disabled="!canMutate || selectedPrincipalProtected"
                @click="
                  passwordToSet = '';
                  passwordDialogOpen = true;
                "
                ><KeyRound class="mr-1.5 size-4" />{{ t("xuguUserPermissions.changePassword") }}</Button
              >
              <Button v-if="!selectedPrincipal.isRole" size="sm" variant="outline" :disabled="!canMutate || selectedPrincipalProtected" @click="openAccountSettings">{{ t("xuguUserPermissions.accountSettings") }}</Button>
              <Button v-if="!selectedPrincipal.isRole" size="sm" variant="outline" :disabled="!canMutate || selectedPrincipalProtected" @click="lockPrincipal(!selectedPrincipal.locked)"
                ><Unlock class="mr-1.5 size-4" />{{ selectedPrincipal.locked ? t("xuguUserPermissions.unlock") : t("xuguUserPermissions.lock") }}</Button
              >
              <Button size="sm" variant="destructive" :disabled="!canMutate || selectedPrincipalProtected" @click="dropPrincipal"><Trash2 class="mr-1.5 size-4" />{{ t(selectedPrincipal.isRole ? "xuguUserPermissions.dropRole" : "xuguUserPermissions.dropUser") }}</Button>
            </div>
          </div>
          <p v-if="!canMutate" class="mt-3 text-xs text-muted-foreground">{{ connection.read_only ? t("xuguUserPermissions.readOnlyHint") : t("xuguUserPermissions.managementRequiresDba") }}</p>
        </section>

        <section class="rounded-lg border bg-card">
          <div class="flex items-center justify-between border-b px-4 py-3">
            <div>
              <h2 class="font-medium">{{ t("xuguUserPermissions.grantsTitle") }}</h2>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ t("xuguUserPermissions.grantsHint") }}</p>
            </div>
            <Badge variant="outline">{{ permissionRows.length }}</Badge>
          </div>
          <div v-if="aclError" class="p-4 text-sm text-destructive">{{ aclError }}</div>
          <div v-else-if="loadingAcl" class="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 class="size-4 animate-spin" />{{ t("xuguUserPermissions.loading") }}</div>
          <div v-else-if="!aclCatalogAvailable" class="border-b px-4 py-2 text-xs text-amber-700 dark:text-amber-300">{{ t("xuguUserPermissions.limitedAcl") }}</div>
          <div v-else-if="permissionRows.length === 0" class="p-4 text-sm text-muted-foreground">{{ t("xuguUserPermissions.noGrants") }}</div>
          <div v-else class="max-h-72 overflow-auto">
            <table class="w-full text-left text-sm">
              <thead class="sticky top-0 bg-muted/80 text-xs text-muted-foreground">
                <tr>
                  <th class="px-4 py-2">{{ t("xuguUserPermissions.privilege") }}</th>
                  <th class="px-4 py-2">{{ t("xuguUserPermissions.scope") }}</th>
                  <th class="px-4 py-2">{{ t("xuguUserPermissions.target") }}</th>
                  <th class="px-4 py-2">{{ t("xuguUserPermissions.source") }}</th>
                  <th class="px-4 py-2">{{ t("xuguUserPermissions.grantable") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, index) in permissionRows" :key="`${row.granteeId}:${row.objectId}:${row.objectType}:${row.name}:${index}`" class="border-t">
                  <td class="px-4 py-2 font-medium">{{ row.name }}</td>
                  <td class="px-4 py-2 text-muted-foreground">{{ t(`xuguUserPermissions.scope${row.scope.charAt(0).toUpperCase()}${row.scope.slice(1)}`) }}</td>
                  <td class="px-4 py-2 font-mono text-xs">{{ row.target }}</td>
                  <td class="px-4 py-2">{{ row.inheritedFrom ? t("xuguUserPermissions.viaRole", { role: row.inheritedFrom }) : t("xuguUserPermissions.direct") }}</td>
                  <td class="px-4 py-2">{{ row.regrant ? t("xuguUserPermissions.yes") : t("xuguUserPermissions.no") }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="rounded-lg border bg-card p-4">
          <div class="mb-3">
            <h2 class="font-medium">{{ t("xuguUserPermissions.editorTitle") }}</h2>
            <p class="mt-0.5 text-xs text-muted-foreground">{{ t("xuguUserPermissions.editorHint") }}</p>
          </div>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <label class="space-y-1 text-xs text-muted-foreground"
              >{{ t("xuguUserPermissions.scope")
              }}<select v-model="grantScope" class="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground">
                <option v-for="option in scopeOptions" :key="option.value" :value="option.value">{{ t(option.label) }}</option>
              </select></label
            >
            <label v-if="grantScope === 'schema' || grantScope === 'object' || grantScope === 'column'" class="space-y-1 text-xs text-muted-foreground"
              >{{ t("xuguUserPermissions.schema") }}<Input v-model="schemaName" list="xugu-permission-schemas" /><datalist id="xugu-permission-schemas"><option v-for="schema in schemas" :key="schema" :value="schema" /></datalist
            ></label>
            <label v-if="grantScope === 'object' || grantScope === 'column'" class="space-y-1 text-xs text-muted-foreground"
              >{{ t("xuguUserPermissions.objectType")
              }}<select v-model="objectType" class="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground">
                <template v-if="grantScope === 'column'"
                  ><option value="TABLE">{{ t("xuguUserPermissions.tableColumn") }}</option>
                  <option value="VIEW">{{ t("xuguUserPermissions.viewColumn") }}</option></template
                ><template v-else
                  ><option v-for="item in XUGU_OBJECT_TYPES" :key="item.sql" :value="item.sql">{{ item.label }}</option></template
                >
              </select></label
            >
            <label v-if="grantScope === 'object' || grantScope === 'column'" class="space-y-1 text-xs text-muted-foreground"
              >{{ t("xuguUserPermissions.object") }}<Input v-model="objectName" list="xugu-permission-objects" /><datalist id="xugu-permission-objects"><option v-for="name in objectNames" :key="name" :value="name" /></datalist
            ></label>
            <label v-if="grantScope === 'column'" class="space-y-1 text-xs text-muted-foreground"
              >{{ t("xuguUserPermissions.column") }}<Input v-model="columnName" list="xugu-permission-columns" /><datalist id="xugu-permission-columns"><option v-for="name in columnNames" :key="name" :value="name" /></datalist
            ></label>
            <label v-if="grantScope === 'role'" class="space-y-1 text-xs text-muted-foreground"
              >{{ t("xuguUserPermissions.roleToGrant") }}<Input v-model="roleName" list="xugu-permission-roles" /><datalist id="xugu-permission-roles"><option v-for="role in roles" :key="role.id" :value="role.name" /></datalist
            ></label>
            <label v-if="grantScope === 'admin'" class="space-y-1 text-xs text-muted-foreground"
              >{{ t("xuguUserPermissions.adminAuthority")
              }}<select v-model="adminAuthority" class="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground">
                <option value="DBA">DBA</option>
                <option value="AUDITOR">AUDITOR</option>
                <option value="SSO">SSO</option>
              </select></label
            >
          </div>
          <p v-if="targetLookupFailed" class="mt-2 text-xs text-muted-foreground">{{ t("xuguUserPermissions.targetLookupFailed") }}</p>
          <p v-else-if="targetLookupIncomplete" class="mt-2 text-xs text-muted-foreground">{{ t("xuguUserPermissions.targetLookupIncomplete") }}</p>
          <p v-if="grantScope === 'system'" class="mt-2 text-xs text-muted-foreground">{{ t("xuguUserPermissions.systemScopeHint") }}</p>
          <div v-if="availablePrivileges.length" class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <label v-for="privilege in availablePrivileges" :key="privilege.name" class="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"><input type="checkbox" :checked="selectedPrivilegeSet.has(privilege.name)" @change="togglePrivilege(privilege.name)" />{{ privilege.name }}</label>
          </div>
          <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div v-if="grantScope === 'object'" class="flex flex-wrap gap-4">
              <label class="flex items-center gap-2 text-sm"><input v-model="grantOption" type="checkbox" />{{ t("xuguUserPermissions.grantOption") }}</label>
              <label class="flex items-center gap-2 text-sm"><input v-model="revokeGrantOptionOnly" type="checkbox" />{{ t("xuguUserPermissions.revokeGrantOptionOnly") }}</label>
            </div>
            <div v-else-if="grantScope === 'column'" class="text-xs text-muted-foreground">
              {{ t("xuguUserPermissions.columnGrantOptionUnsupported") }}
            </div>
            <span v-else class="text-xs text-muted-foreground">{{ t("xuguUserPermissions.grantOptionScope") }}</span>
            <div class="ml-auto flex gap-2">
              <Button variant="outline" :disabled="!canMutate || !selectedPrincipal || selectedPrincipalProtected" @click="previewPermission(true)">{{ t("xuguUserPermissions.revoke") }}</Button
              ><Button :disabled="!canMutate || !selectedPrincipal || selectedPrincipalProtected" @click="previewPermission(false)">{{ t("xuguUserPermissions.grant") }}</Button>
            </div>
          </div>
        </section>
      </main>
    </div>

    <Dialog v-model:open="createDialogOpen">
      <DialogContent>
        <DialogHeader
          ><DialogTitle>{{ t("xuguUserPermissions.newPrincipal") }}</DialogTitle></DialogHeader
        >
        <div class="space-y-3">
          <div class="flex gap-2">
            <Button size="sm" :variant="kind === 'user' ? 'secondary' : 'outline'" @click="kind = 'user'">{{ t("xuguUserPermissions.createUser") }}</Button
            ><Button size="sm" :variant="kind === 'role' ? 'secondary' : 'outline'" @click="kind = 'role'">{{ t("xuguUserPermissions.createRole") }}</Button>
          </div>
          <label class="block space-y-1 text-sm">{{ t("xuguUserPermissions.name") }}<Input v-model="principalName" autocomplete="off" /></label>
          <label v-if="kind === 'user'" class="block space-y-1 text-sm">{{ t("xuguUserPermissions.initialPassword") }}<Input v-model="principalPassword" type="password" autocomplete="new-password" /></label>
          <template v-if="kind === 'user'">
            <label class="block space-y-1 text-sm"
              >{{ t("xuguUserPermissions.defaultRoles") }}
              <select v-model="defaultRoleNames" multiple size="4" class="w-full rounded-md border bg-background px-2 py-1 text-sm text-foreground">
                <option v-for="role in roles" :key="role.id" :value="role.name">{{ role.name }}</option>
              </select>
            </label>
            <label class="block space-y-1 text-sm">{{ t("xuguUserPermissions.validUntil") }}<Input v-model="createValidUntil" type="datetime-local" step="1" /></label>
            <label class="flex items-center gap-2 text-sm"><input v-model="createLocked" type="checkbox" />{{ t("xuguUserPermissions.createLocked") }}</label>
            <label class="flex items-center gap-2 text-sm"><input v-model="createPasswordExpired" type="checkbox" />{{ t("xuguUserPermissions.createPasswordExpired") }}</label>
            <p class="text-xs text-muted-foreground">{{ t("xuguUserPermissions.accountCreateHint") }}</p>
          </template>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="createDialogOpen = false">{{ t("common.cancel") }}</Button
          ><Button :disabled="!principalName.trim() || (kind === 'user' && !principalPassword)" @click="previewNewPrincipal">{{ t("xuguUserPermissions.preview") }}</Button></DialogFooter
        >
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="accountDialogOpen">
      <DialogContent>
        <DialogHeader
          ><DialogTitle>{{ t("xuguUserPermissions.accountSettings") }}</DialogTitle></DialogHeader
        >
        <div class="space-y-3">
          <label class="block space-y-1 text-sm">{{ t("xuguUserPermissions.setValidUntil") }}<Input v-model="validUntilToSet" type="datetime-local" step="1" /></label>
          <label v-if="!selectedPrincipal?.expired" class="flex items-center gap-2 text-sm"><input v-model="expirePassword" type="checkbox" />{{ t("xuguUserPermissions.markPasswordExpired") }}</label>
          <p v-else class="text-xs text-muted-foreground">{{ t("xuguUserPermissions.passwordAlreadyExpiredHint") }}</p>
          <p class="text-xs text-muted-foreground">{{ t("xuguUserPermissions.accountSettingsHint") }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="accountDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="!validUntilToSet && !expirePassword" @click="previewAccountChanges">{{ t("xuguUserPermissions.preview") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="passwordDialogOpen">
      <DialogContent>
        <DialogHeader
          ><DialogTitle>{{ t("xuguUserPermissions.changePassword") }}</DialogTitle></DialogHeader
        >
        <Input v-model="passwordToSet" type="password" autocomplete="new-password" :placeholder="t('xuguUserPermissions.newPassword')" />
        <DialogFooter
          ><Button variant="outline" @click="passwordDialogOpen = false">{{ t("common.cancel") }}</Button
          ><Button :disabled="!passwordToSet" @click="previewPasswordChange">{{ t("xuguUserPermissions.preview") }}</Button></DialogFooter
        >
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="sqlDialogOpen">
      <DialogContent class="sm:max-w-2xl">
        <DialogHeader
          ><DialogTitle>{{ t("xuguUserPermissions.review", { action: pendingLabel }) }}</DialogTitle></DialogHeader
        >
        <div class="rounded-md border bg-muted/40 p-3">
          <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{{ previewSql }}</pre>
        </div>
        <p class="text-xs text-muted-foreground">{{ t(pendingSystemWide ? "xuguUserPermissions.systemWide" : "xuguUserPermissions.currentDatabaseOnly") }}</p>
        <DialogFooter
          ><Button variant="outline" :disabled="mutating" @click="sqlDialogOpen = false">{{ t("common.cancel") }}</Button
          ><Button :disabled="mutating || !canMutate" @click="applyPendingSql"><Loader2 v-if="mutating" class="mr-2 size-4 animate-spin" />{{ t("xuguUserPermissions.execute") }}</Button></DialogFooter
        >
      </DialogContent>
    </Dialog>
  </div>
</template>
