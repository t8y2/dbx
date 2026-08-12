<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, ChevronRight, Folder, KeyRound, Loader2, Lock, LockOpen, Plus, RefreshCcw, ShieldCheck, Trash2, UserRound, UserRoundPlus, UsersRound } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { translateBackendError } from "@/i18n/backend-errors";
import {
  DAMENG_USER_GROUPS,
  DAMENG_SYSTEM_PRIVILEGES,
  damengAlterUserPasswordSql,
  damengCreateUserSql,
  damengDropUserSql,
  damengGrantRoleSql,
  damengGrantSystemPrivilegeSql,
  damengListRolesSql,
  damengListTablespacesSql,
  damengListUserRolesSql,
  damengListUserSysPrivsSql,
  damengListUsersSql,
  damengLockUserSql,
  damengRevokeRoleSql,
  damengRevokeSystemPrivilegeSql,
  damengSystemPrivilegeMapSql,
  damengRoleGraphSql,
  damengRolesClosure,
  damengUnlockUserSql,
  damengUserTypeGrantSqls,
  canDamengAlterUserPassword,
  canDamengRevokeRoleGrant,
  isDamengSystemUser,
  isDamengPredefinedRole,
  DAMENG_HIDDEN_ROLES,
  damengUserGroup,
  damengSystemUserCategory,
  parseDamengRoles,
  parseDamengRoleGraph,
  parseDamengRolePrivs,
  parseDamengSysPrivs,
  parseDamengTablespaces,
  parseDamengSystemPrivilegeMap,
  damengAvailableSystemPrivileges,
  parseDamengRoleGrants,
  parseDamengUsers,
  type DamengGrant,
  type DamengRole,
  type DamengSysPrivilege,
  type DamengUser,
  type DamengUserGroup,
  damengEnableDdlAnyPrivSql,
  isDamengAnyPrivilege,
  parseDamengEnableDdlAnyPriv,
} from "@/lib/database/damengPrincipalAdmin";

const props = defineProps<{
  connection: ConnectionConfig;
}>();

type DetailTab = "roles" | "privileges";

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();

const users = ref<DamengUser[]>([]);
const allRoles = ref<DamengRole[]>([]);
const tablespaces = ref<string[]>([]);
const selectedUsername = ref("");
const search = ref("");
const loadingUsers = ref(false);
const loadingRoles = ref(false);
const loadingDetails = ref(false);
const applying = ref(false);
const loadError = ref("");
const detailError = ref("");
const detailTab = ref<DetailTab>("roles");
const grantedRoles = ref<DamengGrant[]>([]);
const grantedPrivileges = ref<DamengSysPrivilege[]>([]);
const systemPrivilegeMap = ref<Set<string> | null>(null);
const enableDdlAnyPriv = ref(true);

const createDialogOpen = ref(false);
const createUsername = ref("");
const createPassword = ref("");
const createTablespace = ref("");
const createLocked = ref(false);
const createUserType = ref<Exclude<DamengUserGroup, "other">>("admin");
const createdUsername = ref("");
const userRoleGrants = ref<Map<string, Set<string>>>(new Map());
const collapsedGroups = ref<Record<string, boolean>>({});

function groupLabel(group: DamengUserGroup): string {
  if (group === "other") return t("damengUserAdmin.groupOther");
  const key = "damengUserAdmin.systemUser" + group.charAt(0).toUpperCase() + group.slice(1);
  return t(key);
}

function usersInGroup(group: DamengUserGroup): DamengUser[] {
  return filteredUsers.value.filter((user) => damengUserGroup(user.username, userRoleGrants.value.get(user.username.trim().toUpperCase())) === group);
}

function toggleGroup(group: DamengUserGroup) {
  collapsedGroups.value[group] = !collapsedGroups.value[group];
}

const passwordDialogOpen = ref(false);
const passwordValue = ref("");
const passwordConfirm = ref("");

const grantRoleDialogOpen = ref(false);
const grantRoleValue = ref("");
const grantPrivilegeDialogOpen = ref(false);
const grantPrivilegeValue = ref("");

const previewDialogOpen = ref(false);
const pendingSql = ref("");
const pendingAfterApply = ref<(() => void | Promise<void>) | undefined>();
const pendingDanger = ref(false);

const supported = computed(() => props.connection.db_type === "dameng");
const executionDatabase = computed(() => (props.connection.db_type === "dameng" ? "" : props.connection.database || ""));
const selectedUser = computed(() => users.value.find((user) => user.username === selectedUsername.value));
const filteredUsers = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return users.value;
  return users.value.filter((user) => `${user.username} ${user.defaultTablespace}`.toLowerCase().includes(query));
});
const selectedIsSystemUser = computed(() => !!selectedUser.value && isDamengSystemUser(selectedUser.value.username));

/**
 * Whether the current connection user is allowed to change the selected
 * user's password, following the DM security model (see canDamengAlterUserPassword).
 */
const canAlterPasswordForSelected = computed(() => canDamengAlterUserPassword(props.connection.username, selectedUser.value?.username));

const selectedUserCategory = computed(() => (selectedUser.value ? damengSystemUserCategory(selectedUser.value.username) : undefined));
const selectedUserCategoryLabel = computed(() => {
  if (!selectedUserCategory.value) return "";
  const key = "damengUserAdmin.systemUser" + selectedUserCategory.value.charAt(0).toUpperCase() + selectedUserCategory.value.slice(1);
  return t(key);
});

function userCategoryLabel(username: string): string {
  const category = damengSystemUserCategory(username);
  if (!category) return "";
  const key = "damengUserAdmin.systemUser" + category.charAt(0).toUpperCase() + category.slice(1);
  return t(key);
}
const availableRolesForGrant = computed(() => {
  // Roles already held (directly or via nesting) plus hidden internal roles
  // that cannot be granted (e.g. SYS_ADMIN) are not offered.
  const owned = new Set(grantedRoles.value.map((grant) => grant.grantedRole.toUpperCase()));
  const hidden = DAMENG_HIDDEN_ROLES.map((role) => role.toUpperCase());
  return allRoles.value.filter((role) => !owned.has(role.role.toUpperCase()) && !hidden.includes(role.role.toUpperCase()));
});
const availablePrivilegesForGrant = computed(() => {
  const granted = new Set(grantedPrivileges.value.map((grant) => grant.privilege.toUpperCase()));
  const catalog = systemPrivilegeMap.value ? damengAvailableSystemPrivileges(DAMENG_SYSTEM_PRIVILEGES, systemPrivilegeMap.value) : DAMENG_SYSTEM_PRIVILEGES;
  return catalog.filter((privilege) => !granted.has(privilege.toUpperCase()));
});
const canCreateUser = computed(() => createUsername.value.trim() !== "" && createPassword.value !== "");
const canChangePassword = computed(() => passwordValue.value !== "" && passwordValue.value === passwordConfirm.value);

async function ensureConnection() {
  await connectionStore.ensureConnected(props.connection.id);
}

async function refreshConnectionTree() {
  try {
    // DM users map 1:1 to schemas, so reload the sidebar database/schema tree
    // after user DDL. Best-effort: the in-page user list is already refreshed.
    await connectionStore.loadDatabases(props.connection.id, { force: true });
  } catch {
    // ignore tree refresh failures
  }
}

function isDdlAnyPrivDenied(message: string): boolean {
  // DM8 error -5567: "Grantor has no granted privilege" / "授权者没有此授权权限",
  // typically because ENABLE_DDL_ANY_PRIV=0 blocks granting ANY-type privileges.
  return /授权者没有此授权权限|Grantor no granted privilege|[-]?5567/i.test(message);
}

function formatApplyFailedMessage(message: string): string {
  return isDdlAnyPrivDenied(message) ? `${message}\n${t("damengUserAdmin.enableDdlAnyPrivHint")}` : message;
}

function isPrivilegeGrantDisabled(privilege: string): boolean {
  return !enableDdlAnyPriv.value && isDamengAnyPrivilege(privilege);
}

async function loadUsers() {
  if (!supported.value) return;
  loadingUsers.value = true;
  loadError.value = "";
  try {
    await ensureConnection();
    // Load the full role-grant map once so list grouping can place regular users
    // holding management roles (DBA/DB_AUDIT_ADMIN/DB_POLICY_ADMIN) into the
    // matching category. Falls back to an empty map when the view is unreadable.
    const [result, roleGrantsResult] = await Promise.all([
      api.executeQuery(props.connection.id, executionDatabase.value, damengListUsersSql(), undefined, undefined, { maxRows: 5000 }),
      api.executeQuery(props.connection.id, executionDatabase.value, damengRoleGraphSql(), undefined, undefined, { maxRows: 5000 }).catch(() => undefined),
    ]);
    users.value = parseDamengUsers(result);
    userRoleGrants.value = roleGrantsResult ? parseDamengRoleGrants(roleGrantsResult) : new Map();
    // Auto-select a user just created through the dialog.
    if (createdUsername.value) {
      const created = users.value.find((user) => user.username.toLowerCase() === createdUsername.value.toLowerCase());
      if (created) {
        selectedUsername.value = created.username;
        createdUsername.value = "";
      }
    }
    if (!selectedUser.value) selectedUsername.value = users.value[0]?.username || "";
    await loadDetails();
  } catch (error: any) {
    loadError.value = error?.message || String(error);
    users.value = [];
    grantedRoles.value = [];
    grantedPrivileges.value = [];
  } finally {
    loadingUsers.value = false;
  }
}

async function loadRolesAndTablespaces() {
  if (!supported.value) return;
  loadingRoles.value = true;
  try {
    await ensureConnection();
    const [rolesResult, tablespaceResult, privilegeMapResult, ddlAnyPrivResult] = await Promise.all([
      api.executeQuery(props.connection.id, executionDatabase.value, damengListRolesSql(), undefined, undefined, { maxRows: 5000 }),
      api.executeQuery(props.connection.id, executionDatabase.value, damengListTablespacesSql(), undefined, undefined, { maxRows: 1000 }),
      // SYSTEM_PRIVILEGE_MAP may be unreadable for non-privileged accounts; fall back to the full catalog.
      api.executeQuery(props.connection.id, executionDatabase.value, damengSystemPrivilegeMapSql(), undefined, undefined, { maxRows: 5000 }).catch(() => undefined),
      // DM8 default disables ANY-type privilege grants (ENABLE_DDL_ANY_PRIV=0); keep the default enabled on failure.
      api.executeQuery(props.connection.id, executionDatabase.value, damengEnableDdlAnyPrivSql(), undefined, undefined, { maxRows: 10 }).catch(() => undefined),
    ]);
    allRoles.value = parseDamengRoles(rolesResult);
    tablespaces.value = parseDamengTablespaces(tablespaceResult);
    systemPrivilegeMap.value = privilegeMapResult ? parseDamengSystemPrivilegeMap(privilegeMapResult) : null;
    enableDdlAnyPriv.value = ddlAnyPrivResult ? parseDamengEnableDdlAnyPriv(ddlAnyPrivResult) : true;
  } catch {
    allRoles.value = [];
    tablespaces.value = [];
    systemPrivilegeMap.value = null;
  } finally {
    loadingRoles.value = false;
  }
}

let detailRequestSeq = 0;

async function loadDetails() {
  const user = selectedUser.value;
  if (!user) {
    grantedRoles.value = [];
    grantedPrivileges.value = [];
    return;
  }
  const seq = ++detailRequestSeq;
  loadingDetails.value = true;
  detailError.value = "";
  try {
    await ensureConnection();
    const [rolesResult, privsResult, graphResult] = await Promise.all([
      api.executeQuery(props.connection.id, executionDatabase.value, damengListUserRolesSql(user.username), undefined, undefined, { maxRows: 1000 }),
      api.executeQuery(props.connection.id, executionDatabase.value, damengListUserSysPrivsSql(user.username), undefined, undefined, { maxRows: 1000 }),
      api.executeQuery(props.connection.id, executionDatabase.value, damengRoleGraphSql(), undefined, undefined, { maxRows: 5000 }),
    ]);
    if (seq !== detailRequestSeq) return; // stale response for a previous selection
    const directRoles = parseDamengRolePrivs(rolesResult);
    const graph = parseDamengRoleGraph(graphResult);
    // Official DM tool shows the transitive closure of roles (e.g. SYSDBA also
    // has SVI via PUBLIC and VTI via DBA), excluding hidden internal roles.
    grantedRoles.value = damengRolesClosure(user.username, graph).map((entry) => {
      const direct = directRoles.find((grant) => grant.grantedRole.toUpperCase() === entry.role);
      return direct ?? { grantee: user.username, grantedRole: entry.role, adminOption: false, defaultRole: false, inherited: !entry.direct, via: entry.via };
    });
    grantedPrivileges.value = parseDamengSysPrivs(privsResult);
  } catch (error: any) {
    if (seq !== detailRequestSeq) return; // stale response for a previous selection
    detailError.value = error?.message || String(error);
    grantedRoles.value = [];
    grantedPrivileges.value = [];
  } finally {
    if (seq === detailRequestSeq) loadingDetails.value = false;
  }
}

function selectUser(user: DamengUser) {
  selectedUsername.value = user.username;
  void loadDetails();
}

function previewSql(sql: string, options: { danger?: boolean; afterApply?: () => void | Promise<void> } = {}) {
  pendingSql.value = sql;
  pendingDanger.value = !!options.danger;
  pendingAfterApply.value = options.afterApply;
  previewDialogOpen.value = true;
}

async function applyPendingSql() {
  if (!pendingSql.value.trim()) return;
  applying.value = true;
  try {
    await ensureConnection();
    const results = await executeWithProductionSqlGuard({
      connection: props.connection,
      database: executionDatabase.value,
      sql: pendingSql.value,
      source: t("production.sourceAdmin"),
      execute: () =>
        api.executeMulti(props.connection.id, executionDatabase.value, pendingSql.value, undefined, undefined, {
          maxRows: 1000,
          useTransaction: true,
        }),
    });
    if (!results) return;
    // Per-statement errors are returned inside the result array (HTTP 200), so
    // they must be surfaced explicitly instead of being treated as success.
    const failed = results.find((result) => !!result.error);
    if (failed) {
      toast(t("damengUserAdmin.applyFailed", { message: formatApplyFailedMessage(translateBackendError(t, failed.error)) }), 5000);
      // Statements before the error may already be committed, so refresh regardless.
      await loadUsers();
      // Some statements may already be committed (per-statement autocommit), so keep the sidebar tree in sync too.
      await refreshConnectionTree();
      return;
    }
    toast(t("damengUserAdmin.applySuccess"), 2500);
    previewDialogOpen.value = false;
    await (pendingAfterApply.value?.() ?? Promise.resolve());
    await loadUsers();
    // Users map 1:1 to schemas on DM; keep the sidebar connection tree in sync after create/drop/etc.
    await refreshConnectionTree();
  } catch (error: any) {
    toast(t("damengUserAdmin.applyFailed", { message: formatApplyFailedMessage(error?.message || String(error)) }), 5000);
  } finally {
    applying.value = false;
  }
}

function openCreateDialog() {
  createUsername.value = "";
  createPassword.value = "";
  createTablespace.value = tablespaces.value[0] ?? "";
  createLocked.value = false;
  createDialogOpen.value = true;
}

function previewCreateUser() {
  if (!canCreateUser.value) return;
  const statements = [
    damengCreateUserSql({
      username: createUsername.value,
      password: createPassword.value,
      tablespace: createTablespace.value,
      locked: createLocked.value,
    }),
    ...damengUserTypeGrantSqls(createUserType.value, createUsername.value),
  ];
  previewSql(statements.join("\n"), {
    afterApply: () => {
      createDialogOpen.value = false;
      createdUsername.value = createUsername.value.trim();
    },
  });
}

function openChangePasswordDialog() {
  passwordValue.value = "";
  passwordConfirm.value = "";
  passwordDialogOpen.value = true;
}

function previewChangePassword() {
  const user = selectedUser.value;
  if (!user || !canAlterPasswordForSelected.value || !canChangePassword.value) return;
  previewSql(damengAlterUserPasswordSql(user.username, passwordValue.value), {
    afterApply: () => {
      passwordDialogOpen.value = false;
    },
  });
}

function previewLockUser(locked: boolean) {
  const user = selectedUser.value;
  if (!user) return;
  previewSql(locked ? damengLockUserSql(user.username) : damengUnlockUserSql(user.username));
}

function previewDropUser() {
  const user = selectedUser.value;
  if (!user) return;
  previewSql(damengDropUserSql(user.username), { danger: true });
}

function openGrantRoleDialog() {
  grantRoleValue.value = "";
  grantRoleDialogOpen.value = true;
}

function previewGrantRole() {
  const user = selectedUser.value;
  if (!user || !grantRoleValue.value) return;
  previewSql(damengGrantRoleSql(user.username, grantRoleValue.value), {
    afterApply: () => {
      grantRoleDialogOpen.value = false;
    },
  });
}

function previewRevokeRole(grant: DamengGrant) {
  const user = selectedUser.value;
  if (!user || !canDamengRevokeRoleGrant(user.username, grant)) return;
  previewSql(damengRevokeRoleSql(user.username, grant.grantedRole), { danger: true });
}

function openGrantPrivilegeDialog() {
  grantPrivilegeValue.value = "";
  grantPrivilegeDialogOpen.value = true;
}

function previewGrantPrivilege() {
  const user = selectedUser.value;
  if (!user || !grantPrivilegeValue.value) return;
  previewSql(damengGrantSystemPrivilegeSql(user.username, grantPrivilegeValue.value), {
    afterApply: () => {
      grantPrivilegeDialogOpen.value = false;
    },
  });
}

function previewRevokePrivilege(grant: DamengSysPrivilege) {
  const user = selectedUser.value;
  if (!user) return;
  previewSql(damengRevokeSystemPrivilegeSql(user.username, grant.privilege), { danger: true });
}

function accountStatusBadgeVariant(user: DamengUser): "default" | "secondary" | "destructive" | "outline" {
  if (!user.locked) return "default";
  return /EXPIRED/i.test(user.accountStatus) ? "destructive" : "secondary";
}

onMounted(() => {
  void loadUsers();
  void loadRolesAndTablespaces();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <UsersRound class="h-4 w-4 text-primary" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold">{{ t("damengUserAdmin.title") }}</div>
        <div class="truncate text-[11px] text-muted-foreground">{{ connection.name }}</div>
      </div>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loadingUsers" @click="loadUsers">
        <Loader2 v-if="loadingUsers" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCcw v-else class="h-3.5 w-3.5" />
        {{ t("contextMenu.refreshChildren") }}
      </Button>
      <Button size="sm" class="h-8 gap-1.5" @click="openCreateDialog">
        <Plus class="h-3.5 w-3.5" />
        {{ t("damengUserAdmin.newUser") }}
      </Button>
    </div>

    <div v-if="!supported" class="m-4 rounded border border-dashed p-4 text-sm text-muted-foreground">
      {{ t("damengUserAdmin.unsupported") }}
    </div>

    <div v-else class="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
      <aside class="flex min-h-0 flex-col border-r">
        <div class="border-b p-2">
          <Input v-model="search" class="h-8 text-xs" :placeholder="t('damengUserAdmin.searchUser')" />
        </div>
        <div v-if="loadError" class="m-2 rounded border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <div class="mb-1 flex items-center gap-1 font-medium"><AlertTriangle class="h-3.5 w-3.5" />{{ t("damengUserAdmin.loadFailed") }}</div>
          <div class="break-all">{{ loadError }}</div>
        </div>
        <div class="min-h-0 flex-1 overflow-auto p-2">
          <template v-for="group in DAMENG_USER_GROUPS" :key="group">
            <div v-if="usersInGroup(group).length > 0" class="mb-0.5 mt-1 first:mt-0">
              <button type="button" class="flex w-full items-center gap-1 rounded px-1 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent" @click="toggleGroup(group)">
                <ChevronRight class="h-3 w-3 transition-transform" :class="collapsedGroups[group] ? '' : 'rotate-90'" />
                <Folder class="h-3 w-3" />
                <span class="truncate">{{ groupLabel(group) }}</span>
                <span class="ml-auto text-[10px] opacity-70">{{ usersInGroup(group).length }}</span>
              </button>
              <div v-if="!collapsedGroups[group]">
                <button
                  v-for="user in usersInGroup(group)"
                  :key="user.username"
                  type="button"
                  class="mb-1 w-full rounded border px-2 py-2 text-left text-xs transition hover:bg-accent"
                  :class="selectedUsername === user.username ? 'border-primary bg-primary/10' : 'border-transparent'"
                  @click="selectUser(user)"
                >
                  <div class="flex items-center gap-2">
                    <span class="min-w-0 flex-1 truncate font-medium">{{ user.username }}</span>
                    <Badge v-if="userCategoryLabel(user.username)" variant="outline" class="h-5 border-amber-500/50 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">{{ userCategoryLabel(user.username) }}</Badge>
                    <Badge v-if="user.locked" :variant="accountStatusBadgeVariant(user)" class="h-5 px-1.5 text-[10px]">{{ user.accountStatus }}</Badge>
                  </div>
                  <div class="mt-1 truncate text-[11px] text-muted-foreground">{{ user.defaultTablespace || "-" }}</div>
                </button>
              </div>
            </div>
          </template>
          <div v-if="!loadingUsers && filteredUsers.length === 0" class="p-6 text-center text-xs text-muted-foreground">
            {{ t("damengUserAdmin.emptyUsers") }}
          </div>
        </div>
      </aside>

      <main class="flex min-h-0 flex-col">
        <div v-if="selectedUser" class="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
          <UserRound class="h-4 w-4 text-primary" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-semibold">{{ selectedUser.username }}</span>
              <Badge v-if="selectedUser.locked" :variant="accountStatusBadgeVariant(selectedUser)" class="h-5 px-1.5 text-[10px]">{{ selectedUser.accountStatus }}</Badge>
              <Badge v-else variant="outline" class="h-5 px-1.5 text-[10px]">{{ t("damengUserAdmin.open") }}</Badge>
              <Badge v-if="selectedUserCategoryLabel" variant="outline" class="h-5 border-amber-500/50 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">{{ selectedUserCategoryLabel }}</Badge>
            </div>
            <div class="truncate text-xs text-muted-foreground">{{ t("damengUserAdmin.defaultTablespace") }}: {{ selectedUser.defaultTablespace || "-" }} · {{ t("damengUserAdmin.created") }}: {{ selectedUser.created || "-" }}</div>
          </div>
          <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="!canAlterPasswordForSelected" :title="canAlterPasswordForSelected ? '' : t('damengUserAdmin.cannotChangePassword')" @click="openChangePasswordDialog">
            <KeyRound class="h-3.5 w-3.5" />
            {{ t("damengUserAdmin.changePassword") }}
          </Button>
          <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="selectedIsSystemUser" :title="selectedIsSystemUser ? t('damengUserAdmin.systemUserProtected') : ''" @click="previewLockUser(!selectedUser.locked)">
            <LockOpen v-if="selectedUser.locked" class="h-3.5 w-3.5" />
            <Lock v-else class="h-3.5 w-3.5" />
            {{ selectedUser.locked ? t("damengUserAdmin.unlock") : t("damengUserAdmin.lock") }}
          </Button>
          <Button size="sm" variant="destructive" class="h-8 gap-1.5" :disabled="selectedIsSystemUser" :title="selectedIsSystemUser ? t('damengUserAdmin.systemUserProtected') : ''" @click="previewDropUser">
            <Trash2 class="h-3.5 w-3.5" />
            {{ t("damengUserAdmin.dropUser") }}
          </Button>
        </div>

        <div v-if="selectedUser" class="flex h-10 shrink-0 items-center gap-1 border-b px-3">
          <Button size="sm" :variant="detailTab === 'roles' ? 'secondary' : 'ghost'" class="h-7 px-2 text-xs" @click="detailTab = 'roles'">{{ t("damengUserAdmin.roles") }}</Button>
          <Button size="sm" :variant="detailTab === 'privileges' ? 'secondary' : 'ghost'" class="h-7 px-2 text-xs" @click="detailTab = 'privileges'">{{ t("damengUserAdmin.systemPrivileges") }}</Button>
          <Loader2 v-if="loadingDetails" class="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
        </div>

        <div class="min-h-0 flex-1 overflow-auto p-3">
          <div v-if="!selectedUser" class="flex h-full items-center justify-center text-sm text-muted-foreground">
            {{ t("damengUserAdmin.selectUser") }}
          </div>
          <div v-else-if="detailError" class="rounded border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <div class="mb-1 flex items-center gap-1 font-medium"><AlertTriangle class="h-3.5 w-3.5" />{{ t("damengUserAdmin.loadFailed") }}</div>
            <div class="break-all">{{ detailError }}</div>
          </div>

          <div v-else-if="detailTab === 'roles'">
            <div class="mb-2 flex items-center gap-2">
              <span class="text-xs font-medium">{{ t("damengUserAdmin.grantedRoles") }} ({{ grantedRoles.length }})</span>
              <Button
                size="sm"
                variant="outline"
                class="ml-auto h-7 gap-1 px-2 text-xs"
                :disabled="selectedIsSystemUser || availableRolesForGrant.length === 0"
                :title="selectedIsSystemUser ? t('damengUserAdmin.systemUserProtected') : availableRolesForGrant.length === 0 ? t('damengUserAdmin.noRolesToGrant') : ''"
                @click="openGrantRoleDialog"
              >
                <UserRoundPlus class="h-3.5 w-3.5" />
                {{ t("damengUserAdmin.grantRole") }}
              </Button>
            </div>
            <div class="grid gap-1.5">
              <div v-for="grant in grantedRoles" :key="grant.grantedRole" class="flex items-center gap-2 rounded border bg-muted/20 px-3 py-2">
                <ShieldCheck class="h-3.5 w-3.5 shrink-0 text-primary" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ grant.grantedRole }}</span>
                <Badge v-if="grant.adminOption" variant="outline" class="h-5 px-1.5 text-[10px]">ADMIN OPTION</Badge>
                <Badge v-if="isDamengPredefinedRole(grant.grantedRole)" variant="outline" class="h-5 border-amber-500/50 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">{{ t("damengUserAdmin.builtinRole") }}</Badge>
                <Badge v-if="grant.inherited" variant="secondary" class="h-5 px-1.5 text-[10px]" :title="grant.via">{{ t("damengUserAdmin.inheritedFrom", { via: grant.via ?? "" }) }}</Badge>
                <Button
                  v-if="!grant.inherited"
                  size="sm"
                  variant="ghost"
                  class="h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
                  :disabled="!canDamengRevokeRoleGrant(selectedUser.username, grant)"
                  :title="selectedIsSystemUser ? t('damengUserAdmin.systemUserProtected') : ''"
                  @click="previewRevokeRole(grant)"
                >
                  <Trash2 class="h-3 w-3" />
                  {{ t("damengUserAdmin.revokeRole") }}
                </Button>
              </div>
              <div v-if="grantedRoles.length === 0" class="rounded border border-dashed p-6 text-center text-xs text-muted-foreground">
                {{ t("damengUserAdmin.noGrantedRoles") }}
              </div>
            </div>
          </div>

          <div v-else>
            <div class="mb-2 flex items-center gap-2">
              <span class="text-xs font-medium">{{ t("damengUserAdmin.grantedPrivileges") }} ({{ grantedPrivileges.length }})</span>
              <Button
                size="sm"
                variant="outline"
                class="ml-auto h-7 gap-1 px-2 text-xs"
                :disabled="selectedIsSystemUser || availablePrivilegesForGrant.length === 0"
                :title="selectedIsSystemUser ? t('damengUserAdmin.systemUserProtected') : availablePrivilegesForGrant.length === 0 ? t('damengUserAdmin.noPrivilegesToGrant') : ''"
                @click="openGrantPrivilegeDialog"
              >
                <UserRoundPlus class="h-3.5 w-3.5" />
                {{ t("damengUserAdmin.grantPrivilege") }}
              </Button>
            </div>
            <div class="grid gap-1.5">
              <div v-for="grant in grantedPrivileges" :key="grant.privilege" class="flex items-center gap-2 rounded border bg-muted/20 px-3 py-2">
                <ShieldCheck class="h-3.5 w-3.5 shrink-0 text-primary" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ grant.privilege }}</span>
                <Badge v-if="grant.adminOption" variant="outline" class="h-5 px-1.5 text-[10px]">ADMIN OPTION</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  class="h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
                  :disabled="selectedIsSystemUser || isPrivilegeGrantDisabled(grant.privilege)"
                  :title="selectedIsSystemUser ? t('damengUserAdmin.systemUserProtected') : isPrivilegeGrantDisabled(grant.privilege) ? t('damengUserAdmin.anyPrivilegeDisabled') : ''"
                  @click="previewRevokePrivilege(grant)"
                >
                  <Trash2 class="h-3 w-3" />
                  {{ t("damengUserAdmin.revokePrivilege") }}
                </Button>
              </div>
              <div v-if="grantedPrivileges.length === 0" class="rounded border border-dashed p-6 text-center text-xs text-muted-foreground">
                {{ t("damengUserAdmin.noGrantedPrivileges") }}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>

    <Dialog v-model:open="createDialogOpen">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t("damengUserAdmin.newUser") }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-3 text-xs">
          <label class="grid gap-1">
            <span>{{ t("damengUserAdmin.username") }}</span>
            <Input v-model="createUsername" class="h-8 text-xs" :placeholder="t('damengUserAdmin.usernamePlaceholder')" />
          </label>
          <label class="grid gap-1">
            <span>{{ t("damengUserAdmin.userType") }}</span>
            <Select v-model="createUserType">
              <SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="group in DAMENG_USER_GROUPS.slice(0, 3)" :key="group" :value="group">{{ groupLabel(group) }}</SelectItem>
              </SelectContent>
            </Select>
            <span class="text-[10px] text-muted-foreground">{{ t("damengUserAdmin.userTypeHint") }}</span>
          </label>
          <label class="grid gap-1">
            <span>{{ t("damengUserAdmin.password") }}</span>
            <PasswordInput v-model="createPassword" class="h-8 text-xs" />
            <span :class="createPassword.length > 0 && createPassword.length < 9 ? 'text-[10px] text-amber-600 dark:text-amber-400' : 'text-[10px] text-muted-foreground'">{{ t("damengUserAdmin.passwordPolicyHint") }}</span>
          </label>
          <label class="grid gap-1">
            <span>{{ t("damengUserAdmin.tablespace") }}</span>
            <Select v-if="tablespaces.length > 0" v-model="createTablespace">
              <SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="space in tablespaces" :key="space" :value="space">{{ space }}</SelectItem>
              </SelectContent>
            </Select>
            <Input v-else v-model="createTablespace" class="h-8 text-xs" :placeholder="t('damengUserAdmin.tablespacePlaceholder')" />
          </label>
          <label class="flex items-center gap-2">
            <input v-model="createLocked" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
            <span>{{ t("damengUserAdmin.locked") }}</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="createDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="!canCreateUser" @click="previewCreateUser">{{ t("damengUserAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="passwordDialogOpen">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t("damengUserAdmin.changePassword") }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-3 text-xs">
          <label class="grid gap-1">
            <span>{{ t("damengUserAdmin.newPassword") }}</span>
            <PasswordInput v-model="passwordValue" class="h-8 text-xs" />
            <span :class="passwordValue.length > 0 && passwordValue.length < 9 ? 'text-[10px] text-amber-600 dark:text-amber-400' : 'text-[10px] text-muted-foreground'">{{ t("damengUserAdmin.passwordPolicyHint") }}</span>
          </label>
          <label class="grid gap-1">
            <span>{{ t("damengUserAdmin.confirmPassword") }}</span>
            <PasswordInput v-model="passwordConfirm" class="h-8 text-xs" />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="passwordDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="!canChangePassword" @click="previewChangePassword">{{ t("damengUserAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="grantRoleDialogOpen">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t("damengUserAdmin.grantRole") }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-3 text-xs">
          <label class="grid gap-1">
            <span>{{ t("damengUserAdmin.roleToGrant") }}</span>
            <Select v-model="grantRoleValue">
              <SelectTrigger class="h-8 text-xs"><SelectValue :placeholder="t('damengUserAdmin.selectRole')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="role in availableRolesForGrant" :key="role.role" :value="role.role">{{ role.role }}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <p class="text-[11px] text-muted-foreground">{{ t("damengUserAdmin.grantRoleHint", { user: selectedUser?.username ?? "" }) }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="grantRoleDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="!grantRoleValue" @click="previewGrantRole">{{ t("damengUserAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="grantPrivilegeDialogOpen">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t("damengUserAdmin.grantPrivilege") }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-3 text-xs">
          <label class="grid gap-1">
            <span>{{ t("damengUserAdmin.privilegeToGrant") }}</span>
            <Select v-model="grantPrivilegeValue">
              <SelectTrigger class="h-8 text-xs"><SelectValue :placeholder="t('damengUserAdmin.selectPrivilege')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="privilege in availablePrivilegesForGrant" :key="privilege" :value="privilege" :disabled="isPrivilegeGrantDisabled(privilege)">{{ privilege }}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <p v-if="!enableDdlAnyPriv" class="text-[11px] text-amber-600 dark:text-amber-400">{{ t("damengUserAdmin.anyPrivilegeDisabled") }}</p>
          <p class="text-[11px] text-muted-foreground">{{ t("damengUserAdmin.grantPrivilegeHint", { user: selectedUser?.username ?? "" }) }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="grantPrivilegeDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="!grantPrivilegeValue" @click="previewGrantPrivilege">{{ t("damengUserAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="previewDialogOpen">
      <DialogContent class="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{{ t("damengUserAdmin.sqlPreview") }}</DialogTitle>
        </DialogHeader>
        <pre class="max-h-[50vh] overflow-auto rounded-md border bg-muted/30 p-3 text-xs"><code>{{ pendingSql }}</code></pre>
        <DialogFooter>
          <Button variant="outline" @click="previewDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :variant="pendingDanger ? 'destructive' : 'default'" :disabled="applying" @click="applyPendingSql">
            <Loader2 v-if="applying" class="mr-1 h-3.5 w-3.5 animate-spin" />
            {{ t("damengUserAdmin.applySql") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
