<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Check, KeyRound, Lock, Loader2, Plus, RefreshCcw, Search, ShieldCheck, Trash2, Unlock, UserRound } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { grantsFromQueryResult, resolveDatabaseUserAdminProviderForConnection, type DatabaseUserIdentity, type PrivilegeScope } from "@/lib/database/databaseUserAdmin";
import {
  authorizationPlanSql,
  authorizationPlanStatus,
  authorizationPrivileges,
  buildCreateUserAuthorizationPlan,
  executeAuthorizationPlan,
  type AuthorizationAccountType,
  type AuthorizationPlan,
  type AuthorizationPreset,
  type AuthorizationStepResult,
  type DatabaseAuthorizationSelection,
} from "@/lib/database/databaseAuthorizationPlan";

const props = defineProps<{
  connection: ConnectionConfig;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();

const users = ref<DatabaseUserIdentity[]>([]);
const selectedUserKey = ref("");
const grants = ref<string[]>([]);
const grantsLoaded = ref(false);
const search = ref("");
const loadingUsers = ref(false);
const loadingGrants = ref(false);
const applying = ref(false);
const preparingCreatePlan = ref(false);
const loadError = ref("");
const grantError = ref("");

const createDialogOpen = ref(false);
const passwordDialogOpen = ref(false);
const sqlDialogOpen = ref(false);
const pendingSql = ref("");
const pendingPlan = ref<AuthorizationPlan>();
const pendingResults = ref<AuthorizationStepResult[]>([]);
const pendingDanger = ref(false);
const pendingAfterApply = ref<(() => Promise<void>) | undefined>();

const createUser = ref("app_user");
const createHost = ref("%");
const createPassword = ref("");
const newPassword = ref("");
const privilegeDatabase = ref(props.connection.database || "*");
const privilegeTable = ref("*");
const privilegeScope = ref<PrivilegeScope>("mysql");
const privilegeRole = ref("");
const grantOption = ref(false);
const selectedPrivileges = ref<string[]>(["SELECT"]);
const createCanLogin = ref(true);
const createAccountType = ref<AuthorizationAccountType>("standard");
const createDatabases = ref<string[]>([]);
const createDatabasesLoading = ref(false);
const createDatabaseSearch = ref("");
const createDatabaseAuthorizations = ref<DatabaseAuthorizationSelection[]>([]);
let createPlanRequestId = 0;

const provider = computed(() => resolveDatabaseUserAdminProviderForConnection(props.connection));
const supported = computed(() => provider.value !== null);
const isPostgres = computed(() => provider.value?.dialect === "postgres");
const canCreateUser = computed(() => !!provider.value?.createUserSql);
const canAlterPassword = computed(() => !!provider.value?.alterPasswordSql);
const canAlterLogin = computed(() => !!provider.value?.alterLoginSql);
const canDropUser = computed(() => !!provider.value?.dropUserSql);
const canGrantPrivileges = computed(() => !!provider.value?.grantPrivilegesSql);
const canRevokePrivileges = computed(() => !!provider.value?.revokePrivilegesSql);
const canEditPrivileges = computed(() => canGrantPrivileges.value || canRevokePrivileges.value);
const selectedUser = computed(() => users.value.find((user) => userKey(user) === selectedUserKey.value));
const filteredUsers = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return users.value;
  return users.value.filter((user) => userLabel(user).toLowerCase().includes(query));
});
const selectedPrivilegeSet = computed(() => new Set(selectedPrivileges.value));
const availablePrivileges = computed(() => provider.value?.privilegesForScope?.(privilegeScope.value) ?? []);
const hasPrivilegePicker = computed(() => privilegeScope.value !== "role");
const loginDisableLabel = computed(() => (isPostgres.value ? t("userAdmin.disableLogin") : t("userAdmin.lock")));
const loginEnableLabel = computed(() => (isPostgres.value ? t("userAdmin.enableLogin") : t("userAdmin.unlock")));
const createNameLabel = computed(() => (isPostgres.value ? t("userAdmin.roleName") : t("userAdmin.username")));
const selectedDetail = computed(() => {
  const user = selectedUser.value;
  return user ? provider.value?.detail(user) || "" : "";
});
const grantsSqlText = computed(() => grants.value.join("\n") || t("userAdmin.noGrants"));
const highlightedGrantsSql = computed(() => highlight(grantsSqlText.value));
const highlightedPendingSql = computed(() => highlight(pendingSql.value));
const createAuthorizationPrivileges = computed(() => (provider.value ? authorizationPrivileges(provider.value) : []));
const filteredCreateDatabases = computed(() => {
  const query = createDatabaseSearch.value.trim().toLowerCase();
  return query ? createDatabases.value.filter((database) => database.toLowerCase().includes(query)) : createDatabases.value;
});
const selectedCreateDatabaseSet = computed(() => new Set(createDatabaseAuthorizations.value.map((selection) => selection.database)));
const createDatabaseAuthorizationsValid = computed(() => createDatabaseAuthorizations.value.every((selection) => selection.preset !== "custom" || (selection.privileges?.length ?? 0) > 0));
const pendingStatus = computed(() => (pendingResults.value.length > 0 ? authorizationPlanStatus(pendingResults.value) : undefined));

function syncPrivilegeSelectionFromGrants() {
  const selectionFromGrants = provider.value?.privilegeSelectionFromGrants;
  if (!grantsLoaded.value || !selectionFromGrants) return;
  const selection = selectionFromGrants({
    grants: grants.value,
    database: privilegeDatabase.value,
    table: privilegeTable.value,
    availablePrivileges: availablePrivileges.value,
  });
  selectedPrivileges.value = selection.privileges;
  grantOption.value = selection.grantOption;
}

function userKey(user: DatabaseUserIdentity): string {
  return `${user.user}\u0000${user.host}`;
}

function userLabel(user: DatabaseUserIdentity): string {
  return provider.value?.label(user) ?? user.user;
}

function userDetail(user: DatabaseUserIdentity): string {
  return provider.value?.detail(user) || "";
}

async function ensureConnection() {
  await connectionStore.ensureConnected(props.connection.id);
}

async function loadUsers() {
  const userProvider = provider.value;
  if (!userProvider) return;
  loadingUsers.value = true;
  loadError.value = "";
  try {
    await ensureConnection();
    let nextUsers: DatabaseUserIdentity[] = [];
    try {
      const result = await api.executeQuery(props.connection.id, "", userProvider.listUsersSql(), undefined, undefined, {
        maxRows: 5000,
      });
      nextUsers = userProvider.parseUsers(result);
    } catch (error) {
      if (!userProvider.fallbackListUsersSql || !userProvider.parseFallbackUsers) throw error;
      const fallback = await api.executeQuery(props.connection.id, "", userProvider.fallbackListUsersSql(), undefined, undefined, {
        maxRows: 5000,
      });
      nextUsers = userProvider.parseFallbackUsers(fallback);
    }
    users.value = nextUsers;
    if (!selectedUser.value) selectedUserKey.value = nextUsers[0] ? userKey(nextUsers[0]) : "";
  } catch (error: any) {
    loadError.value = error?.message || String(error);
  } finally {
    loadingUsers.value = false;
  }
}

async function loadGrants() {
  const user = selectedUser.value;
  const userProvider = provider.value;
  if (!user || !userProvider) {
    grants.value = [];
    grantsLoaded.value = false;
    return;
  }
  loadingGrants.value = true;
  grantsLoaded.value = false;
  grantError.value = "";
  try {
    const result = await api.executeQuery(props.connection.id, "", userProvider.showGrantsSql(user), undefined, undefined, {
      maxRows: 1000,
    });
    grants.value = (userProvider.parseGrants ?? grantsFromQueryResult)(result);
    grantsLoaded.value = true;
    // Existing-user editing reflects the exact SHOW GRANTS scope; create-user defaults stay independent.
    syncPrivilegeSelectionFromGrants();
  } catch (error: any) {
    grantError.value = error?.message || String(error);
    grants.value = [];
    grantsLoaded.value = false;
  } finally {
    loadingGrants.value = false;
  }
}

function selectUser(user: DatabaseUserIdentity) {
  selectedUserKey.value = userKey(user);
}

function togglePrivilege(privilege: string) {
  const set = new Set(selectedPrivileges.value);
  if (set.has(privilege)) set.delete(privilege);
  else set.add(privilege);
  selectedPrivileges.value = Array.from(set);
}

async function openCreateUserDialog() {
  createDialogOpen.value = true;
  createAccountType.value = "standard";
  createCanLogin.value = true;
  createPassword.value = "";
  createDatabaseSearch.value = "";
  createDatabaseAuthorizations.value = [];
  if (createDatabasesLoading.value) return;
  createDatabases.value = [];
  createDatabasesLoading.value = true;
  try {
    await ensureConnection();
    createDatabases.value = (await api.listDatabases(props.connection.id)).map((database) => database.name);
  } catch (error: any) {
    toast(t("userAdmin.loadDatabasesFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    createDatabasesLoading.value = false;
  }
}

function createAuthorization(database: string): DatabaseAuthorizationSelection | undefined {
  return createDatabaseAuthorizations.value.find((selection) => selection.database === database);
}

function toggleCreateDatabase(database: string) {
  const existing = createAuthorization(database);
  if (existing) {
    createDatabaseAuthorizations.value = createDatabaseAuthorizations.value.filter((selection) => selection.database !== database);
  } else {
    createDatabaseAuthorizations.value = [...createDatabaseAuthorizations.value, { database, preset: "readOnly", privileges: ["SELECT"] }];
  }
}

function updateCreateDatabasePreset(database: string, preset: unknown) {
  const selection = createAuthorization(database);
  if (!selection || typeof preset !== "string") return;
  selection.preset = preset as AuthorizationPreset;
}

function toggleCreateDatabasePrivilege(database: string, privilege: string) {
  const selection = createAuthorization(database);
  if (!selection) return;
  const privileges = new Set(selection.privileges ?? []);
  if (privileges.has(privilege)) privileges.delete(privilege);
  else privileges.add(privilege);
  selection.privileges = Array.from(privileges);
}

function previewSql(sql: string, options: { danger?: boolean; afterApply?: () => Promise<void> } = {}) {
  pendingSql.value = sql;
  pendingPlan.value = undefined;
  pendingResults.value = [];
  pendingDanger.value = !!options.danger;
  pendingAfterApply.value = options.afterApply;
  sqlDialogOpen.value = true;
}

async function applyPendingSql() {
  if (!pendingSql.value.trim()) return;
  applying.value = true;
  try {
    const result = await executeWithProductionSqlGuard({
      connection: props.connection,
      database: "",
      sql: pendingSql.value,
      source: t("production.sourceAdmin"),
      execute: async () => {
        if (pendingPlan.value) {
          return executeAuthorizationPlan(pendingPlan.value, (step) => api.executeMulti(props.connection.id, step.database, step.sql, undefined, undefined, { maxRows: 1000, continueOnError: true }));
        }
        const queryResults = await api.executeMulti(props.connection.id, "", pendingSql.value, undefined, undefined, { maxRows: 1000, continueOnError: true });
        const failed = queryResults.find((item) => item.execution_error === true);
        if (failed) throw new Error(String(failed.rows[0]?.[0] ?? t("userAdmin.applyFailedUnknown")));
        return [] as AuthorizationStepResult[];
      },
    });
    if (!result) return;
    pendingResults.value = result;
    const status = result.length > 0 ? authorizationPlanStatus(result) : "success";
    toast(t(status === "success" ? "userAdmin.applySuccess" : status === "partial" ? "userAdmin.applyPartial" : "userAdmin.applyFailedSummary"), status === "success" ? 2500 : 5000);
    const createSucceeded = !pendingPlan.value || result.some((item) => item.step.id === "create-user" && item.status === "success");
    if (createSucceeded) await (pendingAfterApply.value?.() ?? Promise.resolve());
    if (!pendingPlan.value) sqlDialogOpen.value = false;
    await loadUsers();
    await loadGrants();
  } catch (error: any) {
    toast(t("userAdmin.applyFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    applying.value = false;
  }
}

async function previewCreateUser() {
  const userProvider = provider.value;
  if (!userProvider?.createUserSql || preparingCreatePlan.value) return;
  if (!createUser.value.trim() || !createPassword.value || !createDatabaseAuthorizationsValid.value) return;
  const requestId = ++createPlanRequestId;
  preparingCreatePlan.value = true;
  try {
    const principal = {
      user: createUser.value.trim(),
      host: createHost.value.trim() || "%",
      password: createPassword.value,
      canLogin: createCanLogin.value,
    };
    const databases =
      createAccountType.value === "standard" && userProvider.dialect === "postgres"
        ? await Promise.all(
            createDatabaseAuthorizations.value.map(async (selection) => ({
              ...selection,
              schemas: await api.listSchemas(props.connection.id, selection.database),
            })),
          )
        : createAccountType.value === "standard"
          ? createDatabaseAuthorizations.value
          : [];
    if (requestId !== createPlanRequestId || !createDialogOpen.value) return;
    const plan = buildCreateUserAuthorizationPlan({
      provider: userProvider,
      principal,
      accountType: createAccountType.value,
      databases,
    });
    pendingPlan.value = plan;
    pendingSql.value = authorizationPlanSql(plan);
    pendingResults.value = [];
    pendingDanger.value = createAccountType.value === "admin";
    pendingAfterApply.value = async () => {
      createDialogOpen.value = false;
      createPassword.value = "";
      selectedUserKey.value = userKey({ user: principal.user, host: isPostgres.value ? (principal.canLogin ? "LOGIN" : "ROLE") : principal.host });
    };
    sqlDialogOpen.value = true;
  } catch (error: any) {
    if (requestId === createPlanRequestId) toast(t("userAdmin.prepareAuthorizationFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    if (requestId === createPlanRequestId) preparingCreatePlan.value = false;
  }
}

function authorizationStepLabel(result: AuthorizationStepResult): string {
  const step = result.step;
  if (step.operation === "createUser") return t("userAdmin.stepCreateUser");
  if (step.operation === "grantAdmin") return t("userAdmin.stepGrantAdmin", { user: step.subject });
  if (step.operation === "grantDatabase") return t("userAdmin.stepGrantDatabase", { user: step.subject, database: step.targetDatabase });
  if (step.operation === "grantCurrentObjects") {
    return t("userAdmin.stepGrantCurrentObjects", {
      user: step.subject,
      database: step.targetDatabase,
      schema: step.schema,
      scope: authorizationObjectScopeLabel(step.objectScope),
    });
  }
  if (step.operation === "grantFutureObjects") {
    return step.owner
      ? t("userAdmin.stepGrantFutureObjectsForOwner", { user: step.subject, database: step.targetDatabase, owner: step.owner, scope: authorizationObjectScopeLabel(step.objectScope) })
      : t("userAdmin.stepGrantFutureObjects", { user: step.subject, database: step.targetDatabase, scope: authorizationObjectScopeLabel(step.objectScope) });
  }
  return step.label;
}

function authorizationObjectScopeLabel(scope: AuthorizationStepResult["step"]["objectScope"]): string {
  if (scope === "schemas") return t("userAdmin.scopeSchemas");
  if (scope === "tables") return t("userAdmin.scopeTables");
  if (scope === "sequences") return t("userAdmin.scopeSequences");
  if (scope === "functions") return t("userAdmin.scopeFunctions");
  return "";
}

function previewPasswordChange() {
  const user = selectedUser.value;
  const userProvider = provider.value;
  const alterPasswordSql = userProvider?.alterPasswordSql;
  if (!user || !alterPasswordSql || !newPassword.value) return;
  previewSql(alterPasswordSql(user, newPassword.value), {
    danger: true,
    afterApply: async () => {
      passwordDialogOpen.value = false;
      newPassword.value = "";
    },
  });
}

function previewDropUser() {
  const user = selectedUser.value;
  const userProvider = provider.value;
  const dropUserSql = userProvider?.dropUserSql;
  if (!user || !dropUserSql) return;
  previewSql(dropUserSql(user), { danger: true });
}

function previewLoginChange(enabled: boolean) {
  const user = selectedUser.value;
  const userProvider = provider.value;
  const alterLoginSql = userProvider?.alterLoginSql;
  if (!user || !alterLoginSql) return;
  previewSql(alterLoginSql(user, enabled), { danger: true });
}

function previewGrant() {
  const user = selectedUser.value;
  const userProvider = provider.value;
  const grantPrivilegesSql = userProvider?.grantPrivilegesSql;
  if (!user || !grantPrivilegesSql || (privilegeScope.value === "role" && !privilegeRole.value.trim())) return;
  previewSql(
    grantPrivilegesSql({
      user,
      privileges: selectedPrivileges.value,
      database: privilegeDatabase.value,
      table: privilegeTable.value,
      grantOption: grantOption.value,
      scope: privilegeScope.value,
      role: privilegeRole.value,
    }),
  );
}

function previewRevoke() {
  const user = selectedUser.value;
  const userProvider = provider.value;
  const revokePrivilegesSql = userProvider?.revokePrivilegesSql;
  if (!user || !revokePrivilegesSql || (privilegeScope.value === "role" && !privilegeRole.value.trim())) return;
  previewSql(
    revokePrivilegesSql({
      user,
      privileges: selectedPrivileges.value,
      database: privilegeDatabase.value,
      table: privilegeTable.value,
      scope: privilegeScope.value,
      role: privilegeRole.value,
    }),
    { danger: true },
  );
}

function resetPrivilegeDefaults(scope: PrivilegeScope) {
  const userProvider = provider.value;
  if (!userProvider) return;
  selectedPrivileges.value = userProvider.defaultPrivilegesForScope?.(scope) ?? [];
  if (userProvider.dialect === "postgres") {
    if (scope === "database") privilegeDatabase.value = props.connection.database || "postgres";
    if (scope === "schema" || scope === "table") privilegeDatabase.value = "public";
    if (scope === "table") privilegeTable.value = "*";
  }
}

watch(
  () => createDialogOpen.value,
  (open) => {
    if (open) return;
    createPlanRequestId += 1;
    preparingCreatePlan.value = false;
  },
);

watch(
  () => selectedUserKey.value,
  () => {
    grantsLoaded.value = false;
    void loadGrants();
  },
);

watch(
  () => props.connection.id,
  () => {
    users.value = [];
    createDatabases.value = [];
    createDatabaseAuthorizations.value = [];
    selectedUserKey.value = "";
    grants.value = [];
    grantsLoaded.value = false;
    privilegeScope.value = provider.value?.defaultScope ?? "mysql";
    resetPrivilegeDefaults(privilegeScope.value);
    void loadUsers();
  },
);

watch(
  () => provider.value,
  () => {
    privilegeScope.value = provider.value?.defaultScope ?? "mysql";
    resetPrivilegeDefaults(privilegeScope.value);
  },
  { immediate: true },
);

watch(
  () => privilegeScope.value,
  (scope) => {
    resetPrivilegeDefaults(scope);
    syncPrivilegeSelectionFromGrants();
  },
);

watch([privilegeDatabase, privilegeTable], syncPrivilegeSelectionFromGrants);

onMounted(loadUsers);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-11 shrink-0 items-center gap-2 border-b bg-muted/20 px-3">
      <div class="flex min-w-0 items-center gap-2">
        <ShieldCheck class="h-4 w-4 text-primary" />
        <div class="truncate text-sm font-semibold">{{ t("userAdmin.title") }}</div>
        <Badge variant="outline" class="h-5 rounded-md px-1.5 text-[11px]">{{ connection.name }}</Badge>
      </div>
      <div class="ml-auto flex items-center gap-1.5">
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="loadUsers">
          <Loader2 v-if="loadingUsers" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCcw v-else class="h-3.5 w-3.5" />
          {{ t("grid.refresh") }}
        </Button>
        <Button v-if="canCreateUser" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="openCreateUserDialog">
          <Plus class="h-3.5 w-3.5" />
          {{ t("userAdmin.newUser") }}
        </Button>
      </div>
    </div>

    <div v-if="!supported" class="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {{ t("userAdmin.unsupported") }}
    </div>

    <div v-else class="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
      <aside class="flex min-h-0 flex-col border-r bg-muted/10">
        <div class="flex h-12 items-center border-b px-2">
          <div class="flex h-8 items-center gap-2 rounded-md border bg-background px-2">
            <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input v-model="search" class="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" :placeholder="t('userAdmin.searchUser')" />
          </div>
        </div>
        <div class="min-h-0 flex-1 overflow-auto">
          <div v-if="loadingUsers" class="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
            <Loader2 class="h-3.5 w-3.5 animate-spin" />
            {{ t("userAdmin.loadingUsers") }}
          </div>
          <div v-else-if="loadError" class="px-3 py-4 text-xs text-destructive">{{ loadError }}</div>
          <button
            v-for="user in filteredUsers"
            :key="userKey(user)"
            type="button"
            class="grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-2 border-b px-3 py-2 text-left text-xs hover:bg-accent"
            :class="{ 'bg-primary/10 text-primary': userKey(user) === selectedUserKey }"
            @click="selectUser(user)"
          >
            <UserRound class="h-4 w-4" />
            <span class="min-w-0">
              <span class="block truncate font-medium">{{ userLabel(user) || t("userAdmin.anonymous") }}</span>
              <span v-if="userDetail(user)" class="mt-1 inline-flex max-w-full rounded-full border bg-muted/40 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                <span class="truncate">{{ userDetail(user) }}</span>
              </span>
            </span>
          </button>
          <div v-if="!loadingUsers && !loadError && filteredUsers.length === 0" class="px-3 py-8 text-center text-xs text-muted-foreground">
            {{ t("grid.noSearchResults") }}
          </div>
        </div>
      </aside>

      <main class="flex min-h-0 flex-col">
        <div v-if="selectedUser" class="flex h-12 shrink-0 items-center gap-3 border-b px-4">
          <div class="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
            <UserRound class="h-4 w-4" />
          </div>
          <div class="flex min-w-0 items-center gap-2">
            <div class="truncate text-sm font-semibold">{{ userLabel(selectedUser) }}</div>
            <Badge v-if="selectedDetail" variant="outline" class="h-5 max-w-[180px] rounded-full px-2 py-0 text-[10px] font-normal">
              <span class="truncate">{{ selectedDetail }}</span>
            </Badge>
          </div>
          <div class="ml-auto flex items-center gap-1.5">
            <Button v-if="canAlterPassword" variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="passwordDialogOpen = true">
              <KeyRound class="h-3.5 w-3.5" />
              {{ t("userAdmin.changePassword") }}
            </Button>
            <Button v-if="canAlterLogin" variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="previewLoginChange(false)">
              <Lock class="h-3.5 w-3.5" />
              {{ loginDisableLabel }}
            </Button>
            <Button v-if="canAlterLogin" variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="previewLoginChange(true)">
              <Unlock class="h-3.5 w-3.5" />
              {{ loginEnableLabel }}
            </Button>
            <Button v-if="canDropUser" variant="destructive" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="previewDropUser">
              <Trash2 class="h-3.5 w-3.5" />
              {{ t("userAdmin.dropUser") }}
            </Button>
          </div>
        </div>

        <div v-if="selectedUser" class="grid min-h-0 flex-1" :class="canEditPrivileges ? 'grid-cols-[minmax(0,1fr)_320px]' : 'grid-cols-1'">
          <section class="flex min-h-0 flex-col" :class="{ 'border-r': canEditPrivileges }">
            <div class="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/20 px-3 text-xs font-medium">
              <ShieldCheck class="h-3.5 w-3.5" />
              {{ t("userAdmin.grants") }}
            </div>
            <div class="min-h-0 flex-1 overflow-auto p-3">
              <div v-if="loadingGrants" class="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 class="h-3.5 w-3.5 animate-spin" />
                {{ t("userAdmin.loadingGrants") }}
              </div>
              <div v-else-if="grantError" class="text-xs text-destructive">{{ grantError }}</div>
              <pre v-else class="min-h-full whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-mono text-xs leading-5 text-foreground" v-html="highlightedGrantsSql" />
            </div>
          </section>

          <aside v-if="canEditPrivileges" class="flex min-h-0 flex-col bg-muted/10">
            <div class="border-b p-3">
              <div class="text-xs font-semibold">{{ t("userAdmin.privilegeEditor") }}</div>
              <div class="mt-1 text-[11px] leading-4 text-muted-foreground">{{ t("userAdmin.privilegeHint") }}</div>
            </div>
            <div class="min-h-0 flex-1 overflow-auto p-3">
              <template v-if="isPostgres">
                <label class="mb-2 block text-xs font-medium">{{ t("userAdmin.scope") }}</label>
                <Select v-model="privilegeScope">
                  <SelectTrigger class="mb-3 h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="database">{{ t("userAdmin.scopeDatabase") }}</SelectItem>
                    <SelectItem value="schema">{{ t("userAdmin.scopeSchema") }}</SelectItem>
                    <SelectItem value="table">{{ t("userAdmin.scopeTable") }}</SelectItem>
                    <SelectItem value="role">{{ t("userAdmin.scopeRole") }}</SelectItem>
                  </SelectContent>
                </Select>
              </template>

              <template v-if="privilegeScope === 'role'">
                <label class="mb-2 block text-xs font-medium">{{ t("userAdmin.memberRole") }}</label>
                <Input v-model="privilegeRole" class="mb-3 h-8 text-xs" :placeholder="t('userAdmin.memberRole')" />
              </template>
              <template v-else>
                <label class="mb-2 block text-xs font-medium">
                  {{ isPostgres && privilegeScope !== "database" ? t("userAdmin.schema") : t("userAdmin.database") }}
                </label>
                <Input v-model="privilegeDatabase" class="mb-3 h-8 text-xs" :placeholder="isPostgres ? 'public' : '*'" />
                <template v-if="!isPostgres || privilegeScope === 'table'">
                  <label class="mb-2 block text-xs font-medium">{{ t("userAdmin.table") }}</label>
                  <Input v-model="privilegeTable" class="mb-3 h-8 text-xs" placeholder="*" />
                </template>
              </template>

              <div v-if="hasPrivilegePicker" class="mb-2 text-xs font-medium">{{ t("userAdmin.privileges") }}</div>
              <div v-if="hasPrivilegePicker" class="grid grid-cols-2 gap-1.5">
                <button
                  v-for="privilege in availablePrivileges"
                  :key="privilege"
                  type="button"
                  class="flex h-7 items-center gap-1.5 rounded-md border px-2 text-left text-[11px] hover:bg-accent"
                  :class="selectedPrivilegeSet.has(privilege) ? 'border-primary bg-primary/10 text-primary' : 'bg-background'"
                  @click="togglePrivilege(privilege)"
                >
                  <span class="flex h-3.5 w-3.5 items-center justify-center rounded border" :class="selectedPrivilegeSet.has(privilege) ? 'border-primary bg-primary text-primary-foreground' : 'border-border'">
                    <Check v-if="selectedPrivilegeSet.has(privilege)" class="h-2.5 w-2.5" />
                  </span>
                  <span class="truncate">{{ privilege }}</span>
                </button>
              </div>
              <label class="mt-3 flex items-center gap-2 text-xs">
                <input v-model="grantOption" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
                {{ privilegeScope === "role" ? t("userAdmin.adminOption") : t("userAdmin.grantOption") }}
              </label>
            </div>
            <div class="flex shrink-0 items-center justify-end gap-2 border-t p-3">
              <Button v-if="canRevokePrivileges" variant="outline" size="sm" class="h-7 px-2 text-xs" @click="previewRevoke">
                {{ t("userAdmin.revoke") }}
              </Button>
              <Button v-if="canGrantPrivileges" size="sm" class="h-7 px-2 text-xs" @click="previewGrant">
                {{ t("userAdmin.grant") }}
              </Button>
            </div>
          </aside>
        </div>

        <div v-else class="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {{ t("userAdmin.emptyUsers") }}
        </div>
      </main>
    </div>

    <Dialog v-model:open="createDialogOpen">
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ t("userAdmin.newUser") }}</DialogTitle>
        </DialogHeader>
        <div class="grid max-h-[70vh] gap-4 overflow-auto pr-1">
          <div class="grid grid-cols-2 gap-2">
            <button type="button" class="rounded-md border p-3 text-left" :class="createAccountType === 'standard' ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'" @click="createAccountType = 'standard'">
              <span class="block text-sm font-medium">{{ t("userAdmin.standardUser") }}</span>
              <span class="mt-1 block text-xs text-muted-foreground">{{ t("userAdmin.standardUserHint") }}</span>
            </button>
            <button type="button" class="rounded-md border p-3 text-left" :class="createAccountType === 'admin' ? 'border-destructive bg-destructive/5' : 'hover:bg-muted/40'" @click="createAccountType = 'admin'">
              <span class="block text-sm font-medium">{{ t("userAdmin.adminUser") }}</span>
              <span class="mt-1 block text-xs text-muted-foreground">{{ t("userAdmin.adminUserHint") }}</span>
            </button>
          </div>
          <label class="block text-xs font-medium">{{ createNameLabel }}</label>
          <Input v-model="createUser" />
          <template v-if="!isPostgres">
            <label class="block text-xs font-medium">{{ t("userAdmin.host") }}</label>
            <Input v-model="createHost" />
          </template>
          <label v-else class="flex items-center gap-2 text-xs">
            <input v-model="createCanLogin" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
            {{ t("userAdmin.allowLogin") }}
          </label>
          <label class="block text-xs font-medium">{{ t("connection.password") }}</label>
          <PasswordInput v-model="createPassword" />

          <div v-if="createAccountType === 'admin'" class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            {{ t("userAdmin.adminUserWarning") }}
          </div>

          <div v-else class="grid gap-2">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-xs font-medium">{{ t("userAdmin.databaseAccess") }}</div>
                <div class="mt-1 text-[11px] text-muted-foreground">{{ t("userAdmin.databaseAccessHint") }}</div>
              </div>
              <Badge variant="outline">{{ t("userAdmin.selectedDatabaseCount", { count: createDatabaseAuthorizations.length }) }}</Badge>
            </div>
            <div class="flex h-8 items-center gap-2 rounded-md border px-2">
              <Search class="h-3.5 w-3.5 text-muted-foreground" />
              <input v-model="createDatabaseSearch" class="min-w-0 flex-1 bg-transparent text-xs outline-none" :placeholder="t('userAdmin.searchDatabase')" />
            </div>
            <div class="max-h-64 overflow-auto rounded-md border">
              <div v-if="createDatabasesLoading" class="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <Loader2 class="h-3.5 w-3.5 animate-spin" />
                {{ t("userAdmin.loadingDatabases") }}
              </div>
              <div v-else-if="filteredCreateDatabases.length === 0" class="p-3 text-center text-xs text-muted-foreground">{{ t("userAdmin.emptyDatabases") }}</div>
              <div v-for="database in filteredCreateDatabases" :key="database" class="border-b p-2 last:border-b-0">
                <div class="flex items-center gap-2">
                  <input :checked="selectedCreateDatabaseSet.has(database)" type="checkbox" class="h-3.5 w-3.5 accent-primary" @change="toggleCreateDatabase(database)" />
                  <button type="button" class="min-w-0 flex-1 truncate text-left text-xs font-medium" @click="toggleCreateDatabase(database)">{{ database }}</button>
                  <Select v-if="selectedCreateDatabaseSet.has(database)" :model-value="createAuthorization(database)?.preset" @update:model-value="updateCreateDatabasePreset(database, $event)">
                    <SelectTrigger class="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="readWrite">{{ t("userAdmin.presetReadWrite") }}</SelectItem>
                      <SelectItem value="readOnly">{{ t("userAdmin.presetReadOnly") }}</SelectItem>
                      <SelectItem value="ddl">{{ t("userAdmin.presetDdl") }}</SelectItem>
                      <SelectItem value="dml">{{ t("userAdmin.presetDml") }}</SelectItem>
                      <SelectItem value="custom">{{ t("userAdmin.presetCustom") }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div v-if="createAuthorization(database)?.preset === 'custom'" class="mt-2 grid grid-cols-3 gap-1.5 pl-5">
                  <button
                    v-for="privilege in createAuthorizationPrivileges"
                    :key="privilege"
                    type="button"
                    class="flex h-7 items-center gap-1.5 rounded border px-2 text-[10px]"
                    :class="createAuthorization(database)?.privileges?.includes(privilege) ? 'border-primary bg-primary/10 text-primary' : 'bg-background'"
                    @click="toggleCreateDatabasePrivilege(database, privilege)"
                  >
                    <Check v-if="createAuthorization(database)?.privileges?.includes(privilege)" class="h-3 w-3" />
                    <span class="truncate">{{ privilege }}</span>
                  </button>
                  <p v-if="!createAuthorization(database)?.privileges?.length" class="col-span-3 text-[10px] text-destructive">
                    {{ t("userAdmin.customPrivilegeRequired") }}
                  </p>
                </div>
                <p v-if="isPostgres && selectedCreateDatabaseSet.has(database) && createAuthorization(database)?.preset === 'ddl'" class="mt-2 pl-5 text-[10px] text-muted-foreground">
                  {{ t("userAdmin.postgresDdlHint") }}
                </p>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="createDialogOpen = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button :disabled="!createUser.trim() || !createPassword || !createDatabaseAuthorizationsValid || preparingCreatePlan" @click="previewCreateUser">
            <Loader2 v-if="preparingCreatePlan" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ t("userAdmin.previewSql") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="passwordDialogOpen">
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle>{{ t("userAdmin.changePassword") }}</DialogTitle>
        </DialogHeader>
        <PasswordInput v-model="newPassword" :placeholder="t('userAdmin.newPassword')" />
        <DialogFooter>
          <Button variant="outline" @click="passwordDialogOpen = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button :disabled="!newPassword" @click="previewPasswordChange">{{ t("userAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="sqlDialogOpen">
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <AlertTriangle v-if="pendingDanger" class="h-4 w-4 text-destructive" />
            {{ t("userAdmin.sqlPreview") }}
          </DialogTitle>
        </DialogHeader>
        <pre class="max-h-[50vh] min-h-44 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5" v-html="highlightedPendingSql" />
        <div v-if="pendingResults.length > 0" class="grid gap-2 rounded-md border p-3">
          <div class="text-xs font-semibold" :class="pendingStatus === 'success' ? 'text-green-600' : pendingStatus === 'partial' ? 'text-amber-600' : 'text-destructive'">
            {{ t(pendingStatus === "success" ? "userAdmin.resultSuccess" : pendingStatus === "partial" ? "userAdmin.resultPartial" : "userAdmin.resultFailed") }}
          </div>
          <div v-for="result in pendingResults" :key="result.step.id" class="flex items-start gap-2 text-xs">
            <Check v-if="result.status === 'success'" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />
            <AlertTriangle v-else-if="result.status === 'failed'" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <span v-else class="mt-1 h-2 w-2 shrink-0 rounded-full bg-muted-foreground" />
            <span class="min-w-0">
              <span class="block">{{ authorizationStepLabel(result) }}</span>
              <span v-if="result.message" class="mt-0.5 block break-all text-destructive">{{ result.message }}</span>
              <span v-else-if="result.status === 'skipped'" class="mt-0.5 block text-muted-foreground">{{ t("userAdmin.stepSkipped") }}</span>
            </span>
          </div>
        </div>
        <DialogFooter>
          <template v-if="pendingResults.length === 0">
            <Button variant="outline" @click="sqlDialogOpen = false">{{ t("dangerDialog.cancel") }}</Button>
            <Button :variant="pendingDanger ? 'destructive' : 'default'" :disabled="applying" @click="applyPendingSql">
              <Loader2 v-if="applying" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {{ t("userAdmin.applySql") }}
            </Button>
          </template>
          <Button v-else @click="sqlDialogOpen = false">{{ t("userAdmin.closeResult") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
