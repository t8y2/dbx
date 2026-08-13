<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Loader2, Plus, RefreshCcw, ShieldCheck, Trash2, UserRoundPlus, UsersRound } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { translateBackendError } from "@/i18n/backend-errors";
import {
  DAMENG_SYSTEM_PRIVILEGES,
  damengCreateRoleSql,
  damengDropRoleSql,
  damengGrantRoleSql,
  damengGrantSystemPrivilegeSql,
  damengListRoleMembersSql,
  damengListRoleSysPrivsSql,
  damengListRolesSql,
  damengListUsersSql,
  damengRevokeRoleSql,
  damengRevokeSystemPrivilegeSql,
  damengSystemPrivilegeMapSql,
  damengEnableDdlAnyPrivSql,
  isDamengAnyPrivilege,
  parseDamengEnableDdlAnyPriv,
  isDamengSystemUser,
  isDamengPredefinedRole,
  parseDamengRolePrivs,
  parseDamengRoles,
  parseDamengSysPrivs,
  parseDamengUsers,
  parseDamengSystemPrivilegeMap,
  damengAvailableSystemPrivileges,
  type DamengGrant,
  type DamengRole,
  type DamengSysPrivilege,
  type DamengUser,
} from "@/lib/database/damengPrincipalAdmin";

const props = defineProps<{
  connection: ConnectionConfig;
}>();

type DetailTab = "members" | "privileges";

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();

const roles = ref<DamengRole[]>([]);
const allUsers = ref<DamengUser[]>([]);
const selectedRoleName = ref("");
const search = ref("");
const loadingRoles = ref(false);
const loadingDetails = ref(false);
const applying = ref(false);
const loadError = ref("");
const detailError = ref("");
const detailTab = ref<DetailTab>("members");
const members = ref<DamengGrant[]>([]);
const grantedPrivileges = ref<DamengSysPrivilege[]>([]);
const systemPrivilegeMap = ref<Set<string> | null>(null);
const enableDdlAnyPriv = ref(true);

const createDialogOpen = ref(false);
const createRoleName = ref("");

const grantUserDialogOpen = ref(false);
const grantUserValue = ref("");
const grantPrivilegeDialogOpen = ref(false);
const grantPrivilegeValue = ref("");

const previewDialogOpen = ref(false);
const pendingSql = ref("");
const pendingAfterApply = ref<(() => void | Promise<void>) | undefined>();
const pendingDanger = ref(false);

const supported = computed(() => props.connection.db_type === "dameng");
const executionDatabase = computed(() => (props.connection.db_type === "dameng" ? "" : props.connection.database || ""));
const selectedRole = computed(() => roles.value.find((role) => role.role === selectedRoleName.value));
const selectedIsBuiltinRole = computed(() => !!selectedRole.value && isDamengPredefinedRole(selectedRole.value.role));
const filteredRoles = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return roles.value;
  return roles.value.filter((role) => role.role.toLowerCase().includes(query));
});
const availableUsersForGrant = computed(() => {
  const granted = new Set(members.value.map((member) => member.grantee.toUpperCase()));
  // System users are protected: not offered for grant.
  return allUsers.value.filter((user) => !granted.has(user.username.toUpperCase()) && !isDamengSystemUser(user.username));
});
const availablePrivilegesForGrant = computed(() => {
  const granted = new Set(grantedPrivileges.value.map((grant) => grant.privilege.toUpperCase()));
  const catalog = systemPrivilegeMap.value ? damengAvailableSystemPrivileges(DAMENG_SYSTEM_PRIVILEGES, systemPrivilegeMap.value) : DAMENG_SYSTEM_PRIVILEGES;
  return catalog.filter((privilege) => !granted.has(privilege.toUpperCase()));
});
const canCreateRole = computed(() => createRoleName.value.trim() !== "");

async function ensureConnection() {
  await connectionStore.ensureConnected(props.connection.id);
}

function isDdlAnyPrivDenied(message: string): boolean {
  // DM8 error -5567: "Grantor has no granted privilege" / "授权者没有此授权权限",
  // typically because ENABLE_DDL_ANY_PRIV=0 blocks granting ANY-type privileges.
  return /授权者没有此授权权限|Grantor no granted privilege|[-]?5567/i.test(message);
}

function formatApplyFailedMessage(message: string): string {
  return isDdlAnyPrivDenied(message) ? `${message}\n${t("damengRoleAdmin.enableDdlAnyPrivHint")}` : message;
}

function isPrivilegeGrantDisabled(privilege: string): boolean {
  return !enableDdlAnyPriv.value && isDamengAnyPrivilege(privilege);
}

async function loadRoles() {
  if (!supported.value) return;
  loadingRoles.value = true;
  loadError.value = "";
  try {
    await ensureConnection();
    const [rolesResult, usersResult, privilegeMapResult, ddlAnyPrivResult] = await Promise.all([
      api.executeQuery(props.connection.id, executionDatabase.value, damengListRolesSql(), undefined, undefined, { maxRows: 5000 }),
      api.executeQuery(props.connection.id, executionDatabase.value, damengListUsersSql(), undefined, undefined, { maxRows: 5000 }),
      // SYSTEM_PRIVILEGE_MAP may be unreadable for non-privileged accounts; fall back to the full catalog.
      api.executeQuery(props.connection.id, executionDatabase.value, damengSystemPrivilegeMapSql(), undefined, undefined, { maxRows: 5000 }).catch(() => undefined),
      // DM8 default disables ANY-type privilege grants (ENABLE_DDL_ANY_PRIV=0); keep the default enabled on failure.
      api.executeQuery(props.connection.id, executionDatabase.value, damengEnableDdlAnyPrivSql(), undefined, undefined, { maxRows: 10 }).catch(() => undefined),
    ]);
    roles.value = parseDamengRoles(rolesResult);
    allUsers.value = parseDamengUsers(usersResult);
    systemPrivilegeMap.value = privilegeMapResult ? parseDamengSystemPrivilegeMap(privilegeMapResult) : null;
    enableDdlAnyPriv.value = ddlAnyPrivResult ? parseDamengEnableDdlAnyPriv(ddlAnyPrivResult) : true;
    if (!selectedRole.value) selectedRoleName.value = roles.value[0]?.role || "";
    await loadDetails();
  } catch (error: any) {
    loadError.value = error?.message || String(error);
    roles.value = [];
    members.value = [];
    grantedPrivileges.value = [];
  } finally {
    loadingRoles.value = false;
  }
}

let detailRequestSeq = 0;

async function loadDetails() {
  const role = selectedRole.value;
  if (!role) {
    members.value = [];
    grantedPrivileges.value = [];
    return;
  }
  const seq = ++detailRequestSeq;
  loadingDetails.value = true;
  detailError.value = "";
  try {
    await ensureConnection();
    const [membersResult, privsResult] = await Promise.all([
      api.executeQuery(props.connection.id, executionDatabase.value, damengListRoleMembersSql(role.role), undefined, undefined, { maxRows: 1000 }),
      api.executeQuery(props.connection.id, executionDatabase.value, damengListRoleSysPrivsSql(role.role), undefined, undefined, { maxRows: 1000 }),
    ]);
    if (seq !== detailRequestSeq) return; // stale response for a previous selection
    members.value = parseDamengRolePrivs(membersResult);
    grantedPrivileges.value = parseDamengSysPrivs(privsResult);
  } catch (error: any) {
    if (seq !== detailRequestSeq) return; // stale response for a previous selection
    detailError.value = error?.message || String(error);
    members.value = [];
    grantedPrivileges.value = [];
  } finally {
    if (seq === detailRequestSeq) loadingDetails.value = false;
  }
}

function selectRole(role: DamengRole) {
  selectedRoleName.value = role.role;
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
      toast(t("damengRoleAdmin.applyFailed", { message: formatApplyFailedMessage(translateBackendError(t, failed.error)) }), 5000);
      // Statements before the error may already be committed, so refresh regardless.
      await loadRoles();
      return;
    }
    toast(t("damengRoleAdmin.applySuccess"), 2500);
    previewDialogOpen.value = false;
    await (pendingAfterApply.value?.() ?? Promise.resolve());
    await loadRoles();
  } catch (error: any) {
    toast(t("damengRoleAdmin.applyFailed", { message: formatApplyFailedMessage(error?.message || String(error)) }), 5000);
  } finally {
    applying.value = false;
  }
}

function openCreateDialog() {
  createRoleName.value = "";
  createDialogOpen.value = true;
}

function previewCreateRole() {
  if (!canCreateRole.value) return;
  previewSql(damengCreateRoleSql(createRoleName.value), {
    afterApply: () => {
      createDialogOpen.value = false;
    },
  });
}

function previewDropRole() {
  const role = selectedRole.value;
  if (!role || selectedIsBuiltinRole.value) return;
  previewSql(damengDropRoleSql(role.role), { danger: true });
}

function openGrantUserDialog() {
  grantUserValue.value = "";
  grantUserDialogOpen.value = true;
}

function previewGrantUser() {
  const role = selectedRole.value;
  if (!role || !grantUserValue.value) return;
  previewSql(damengGrantRoleSql(grantUserValue.value, role.role), {
    afterApply: () => {
      grantUserDialogOpen.value = false;
    },
  });
}

function previewRevokeMember(member: DamengGrant) {
  const role = selectedRole.value;
  if (!role) return;
  previewSql(damengRevokeRoleSql(member.grantee, role.role), { danger: true });
}

function openGrantPrivilegeDialog() {
  grantPrivilegeValue.value = "";
  grantPrivilegeDialogOpen.value = true;
}

function previewGrantPrivilege() {
  const role = selectedRole.value;
  if (!role || !grantPrivilegeValue.value) return;
  previewSql(damengGrantSystemPrivilegeSql(role.role, grantPrivilegeValue.value), {
    afterApply: () => {
      grantPrivilegeDialogOpen.value = false;
    },
  });
}

function previewRevokePrivilege(grant: DamengSysPrivilege) {
  const role = selectedRole.value;
  if (!role) return;
  previewSql(damengRevokeSystemPrivilegeSql(role.role, grant.privilege), { danger: true });
}

function isSystemMember(grantee: string): boolean {
  return isDamengSystemUser(grantee);
}

onMounted(() => {
  void loadRoles();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <ShieldCheck class="h-4 w-4 text-primary" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold">{{ t("damengRoleAdmin.title") }}</div>
        <div class="truncate text-[11px] text-muted-foreground">{{ connection.name }}</div>
      </div>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loadingRoles" @click="loadRoles">
        <Loader2 v-if="loadingRoles" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCcw v-else class="h-3.5 w-3.5" />
        {{ t("contextMenu.refreshChildren") }}
      </Button>
      <Button size="sm" class="h-8 gap-1.5" @click="openCreateDialog">
        <Plus class="h-3.5 w-3.5" />
        {{ t("damengRoleAdmin.newRole") }}
      </Button>
    </div>

    <div v-if="!supported" class="m-4 rounded border border-dashed p-4 text-sm text-muted-foreground">
      {{ t("damengRoleAdmin.unsupported") }}
    </div>

    <div v-else class="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
      <aside class="flex min-h-0 flex-col border-r">
        <div class="border-b p-2">
          <Input v-model="search" class="h-8 text-xs" :placeholder="t('damengRoleAdmin.searchRole')" />
        </div>
        <div v-if="loadError" class="m-2 rounded border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <div class="mb-1 flex items-center gap-1 font-medium"><AlertTriangle class="h-3.5 w-3.5" />{{ t("damengRoleAdmin.loadFailed") }}</div>
          <div class="break-all">{{ loadError }}</div>
        </div>
        <div class="min-h-0 flex-1 overflow-auto p-2">
          <button v-for="role in filteredRoles" :key="role.role" type="button" class="mb-1 w-full rounded border px-2 py-2 text-left text-xs transition hover:bg-accent" :class="selectedRoleName === role.role ? 'border-primary bg-primary/10' : 'border-transparent'" @click="selectRole(role)">
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate font-medium">{{ role.role }}</span>
              <Badge v-if="role.passwordRequired === 'YES'" variant="outline" class="h-5 px-1.5 text-[10px]">PWD</Badge>
              <Badge v-if="isDamengPredefinedRole(role.role)" variant="outline" class="h-5 border-amber-500/50 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">{{ t("damengRoleAdmin.builtinRole") }}</Badge>
            </div>
          </button>
          <div v-if="!loadingRoles && filteredRoles.length === 0" class="p-6 text-center text-xs text-muted-foreground">
            {{ t("damengRoleAdmin.emptyRoles") }}
          </div>
        </div>
      </aside>

      <main class="flex min-h-0 flex-col">
        <div v-if="selectedRole" class="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
          <ShieldCheck class="h-4 w-4 text-primary" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-semibold">{{ selectedRole.role }}</span>
            </div>
          </div>
          <Button size="sm" variant="destructive" class="h-8 gap-1.5" :disabled="selectedIsBuiltinRole" :title="selectedIsBuiltinRole ? t('damengRoleAdmin.builtinRoleProtected') : ''" @click="previewDropRole">
            <Trash2 class="h-3.5 w-3.5" />
            {{ t("damengRoleAdmin.dropRole") }}
          </Button>
        </div>

        <div v-if="selectedRole" class="flex h-10 shrink-0 items-center gap-1 border-b px-3">
          <Button size="sm" :variant="detailTab === 'members' ? 'secondary' : 'ghost'" class="h-7 px-2 text-xs" @click="detailTab = 'members'">{{ t("damengRoleAdmin.members") }}</Button>
          <Button size="sm" :variant="detailTab === 'privileges' ? 'secondary' : 'ghost'" class="h-7 px-2 text-xs" @click="detailTab = 'privileges'">{{ t("damengRoleAdmin.systemPrivileges") }}</Button>
          <Loader2 v-if="loadingDetails" class="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
        </div>

        <div class="min-h-0 flex-1 overflow-auto p-3">
          <div v-if="!selectedRole" class="flex h-full items-center justify-center text-sm text-muted-foreground">
            {{ t("damengRoleAdmin.selectRole") }}
          </div>
          <div v-else-if="detailError" class="rounded border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <div class="mb-1 flex items-center gap-1 font-medium"><AlertTriangle class="h-3.5 w-3.5" />{{ t("damengRoleAdmin.loadFailed") }}</div>
            <div class="break-all">{{ detailError }}</div>
          </div>

          <div v-else-if="detailTab === 'members'">
            <div class="mb-2 flex items-center gap-2">
              <span class="text-xs font-medium">{{ t("damengRoleAdmin.grantedToUsers") }} ({{ members.length }})</span>
              <Button size="sm" variant="outline" class="ml-auto h-7 gap-1 px-2 text-xs" :disabled="availableUsersForGrant.length === 0" :title="availableUsersForGrant.length === 0 ? t('damengRoleAdmin.noUsersToGrant') : ''" @click="openGrantUserDialog">
                <UserRoundPlus class="h-3.5 w-3.5" />
                {{ t("damengRoleAdmin.grantToUser") }}
              </Button>
            </div>
            <div class="grid gap-1.5">
              <div v-for="member in members" :key="member.grantee" class="flex items-center gap-2 rounded border bg-muted/20 px-3 py-2">
                <UsersRound class="h-3.5 w-3.5 shrink-0 text-primary" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ member.grantee }}</span>
                <Badge v-if="isSystemMember(member.grantee)" variant="outline" class="h-5 border-amber-500/50 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">{{ t("damengRoleAdmin.systemUser") }}</Badge>
                <Badge v-if="isDamengPredefinedRole(member.grantee)" variant="outline" class="h-5 border-amber-500/50 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">{{ t("damengRoleAdmin.builtinRole") }}</Badge>
                <Badge v-if="member.adminOption" variant="outline" class="h-5 px-1.5 text-[10px]">ADMIN OPTION</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  class="h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
                  :disabled="isSystemMember(member.grantee) || (selectedIsBuiltinRole && isDamengPredefinedRole(member.grantee))"
                  :title="isSystemMember(member.grantee) ? t('damengRoleAdmin.systemUserProtected') : selectedIsBuiltinRole && isDamengPredefinedRole(member.grantee) ? t('damengRoleAdmin.builtinRoleProtected') : ''"
                  @click="previewRevokeMember(member)"
                >
                  <Trash2 class="h-3 w-3" />
                  {{ t("damengRoleAdmin.revokeFromUser") }}
                </Button>
              </div>
              <div v-if="members.length === 0" class="rounded border border-dashed p-6 text-center text-xs text-muted-foreground">
                {{ t("damengRoleAdmin.noMembers") }}
              </div>
            </div>
          </div>

          <div v-else>
            <div class="mb-2 flex items-center gap-2">
              <span class="text-xs font-medium">{{ t("damengRoleAdmin.grantedPrivileges") }} ({{ grantedPrivileges.length }})</span>
              <Button
                size="sm"
                variant="outline"
                class="ml-auto h-7 gap-1 px-2 text-xs"
                :disabled="selectedIsBuiltinRole || availablePrivilegesForGrant.length === 0"
                :title="selectedIsBuiltinRole ? t('damengRoleAdmin.builtinRoleProtected') : availablePrivilegesForGrant.length === 0 ? t('damengRoleAdmin.noPrivilegesToGrant') : ''"
                @click="openGrantPrivilegeDialog"
              >
                <UserRoundPlus class="h-3.5 w-3.5" />
                {{ t("damengRoleAdmin.grantPrivilege") }}
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
                  :disabled="selectedIsBuiltinRole || isPrivilegeGrantDisabled(grant.privilege)"
                  :title="selectedIsBuiltinRole ? t('damengRoleAdmin.builtinRoleProtected') : isPrivilegeGrantDisabled(grant.privilege) ? t('damengRoleAdmin.anyPrivilegeDisabled') : ''"
                  @click="previewRevokePrivilege(grant)"
                >
                  <Trash2 class="h-3 w-3" />
                  {{ t("damengRoleAdmin.revokePrivilege") }}
                </Button>
              </div>
              <div v-if="grantedPrivileges.length === 0" class="rounded border border-dashed p-6 text-center text-xs text-muted-foreground">
                {{ t("damengRoleAdmin.noGrantedPrivileges") }}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>

    <Dialog v-model:open="createDialogOpen">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t("damengRoleAdmin.newRole") }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-3 text-xs">
          <label class="grid gap-1">
            <span>{{ t("damengRoleAdmin.roleName") }}</span>
            <Input v-model="createRoleName" class="h-8 text-xs" :placeholder="t('damengRoleAdmin.roleNamePlaceholder')" />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="createDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="!canCreateRole" @click="previewCreateRole">{{ t("damengRoleAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="grantUserDialogOpen">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t("damengRoleAdmin.grantToUser") }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-3 text-xs">
          <label class="grid gap-1">
            <span>{{ t("damengRoleAdmin.userToGrant") }}</span>
            <Select v-model="grantUserValue">
              <SelectTrigger class="h-8 text-xs"><SelectValue :placeholder="t('damengRoleAdmin.selectUser')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="user in availableUsersForGrant" :key="user.username" :value="user.username">{{ user.username }}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <p class="text-[11px] text-muted-foreground">{{ t("damengRoleAdmin.grantUserHint", { role: selectedRole?.role ?? "" }) }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="grantUserDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="!grantUserValue" @click="previewGrantUser">{{ t("damengRoleAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="grantPrivilegeDialogOpen">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t("damengRoleAdmin.grantPrivilege") }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-3 text-xs">
          <label class="grid gap-1">
            <span>{{ t("damengRoleAdmin.privilegeToGrant") }}</span>
            <Select v-model="grantPrivilegeValue">
              <SelectTrigger class="h-8 text-xs"><SelectValue :placeholder="t('damengRoleAdmin.selectPrivilege')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="privilege in availablePrivilegesForGrant" :key="privilege" :value="privilege" :disabled="isPrivilegeGrantDisabled(privilege)">{{ privilege }}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <p v-if="!enableDdlAnyPriv" class="text-[11px] text-amber-600 dark:text-amber-400">{{ t("damengRoleAdmin.anyPrivilegeDisabled") }}</p>
          <p class="text-[11px] text-muted-foreground">{{ t("damengRoleAdmin.grantPrivilegeHint", { role: selectedRole?.role ?? "" }) }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="grantPrivilegeDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="!grantPrivilegeValue" @click="previewGrantPrivilege">{{ t("damengRoleAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="previewDialogOpen">
      <DialogContent class="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{{ t("damengRoleAdmin.sqlPreview") }}</DialogTitle>
        </DialogHeader>
        <pre class="max-h-[50vh] overflow-auto rounded-md border bg-muted/30 p-3 text-xs"><code>{{ pendingSql }}</code></pre>
        <DialogFooter>
          <Button variant="outline" @click="previewDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :variant="pendingDanger ? 'destructive' : 'default'" :disabled="applying" @click="applyPendingSql">
            <Loader2 v-if="applying" class="mr-1 h-3.5 w-3.5 animate-spin" />
            {{ t("damengRoleAdmin.applySql") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
