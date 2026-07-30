<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { KeyRound, Loader2, LockKeyhole, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, UserPlus, UsersRound } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";

type AccessView = "users" | "roles";
type PermissionAccess = "read" | "write" | "readwrite";
type PermissionResource = "all" | "key" | "prefix";

const props = defineProps<{ connectionId: string }>();
const { t } = useI18n();
const connectionStore = useConnectionStore();
const view = ref<AccessView>("users");
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const users = ref<string[]>([]);
const roles = ref<string[]>([]);
const selectedUser = ref("");
const selectedRole = ref("");
const userDetail = ref<api.EtcdAuthUserDetail | null>(null);
const roleDetail = ref<api.EtcdAuthRoleDetail | null>(null);
const detailLoading = ref(false);
const createUserOpen = ref(false);
const createRoleOpen = ref(false);
const passwordOpen = ref(false);
const permissionOpen = ref(false);
const approvalOpen = ref(false);
const newUser = ref("");
const newUserPassword = ref("");
const newUserRoles = ref<string[]>([]);
const newRole = ref("");
const newRolePermissionKey = ref("");
const newRolePermissionResource = ref<PermissionResource>("prefix");
const newRolePermissionAccess = ref<PermissionAccess>("readwrite");
const newPassword = ref("");
const selectedGrantRole = ref("");
const permissionKey = ref("");
const permissionResource = ref<PermissionResource>("prefix");
const permissionAccess = ref<PermissionAccess>("readwrite");
const editingPermission = ref<api.EtcdAuthPermission | null>(null);
const permissionError = ref("");
const approvalText = ref("");
const approvalExpected = ref("");
let pendingApproval: (() => Promise<void>) | null = null;
let detailRequest = 0;

const readOnly = computed(() => Boolean(connectionStore.getConfig(props.connectionId)?.read_only));
const selectedUserRoles = computed(() => userDetail.value?.roles ?? []);
const grantableRoles = computed(() => roles.value.filter((role) => !selectedUserRoles.value.includes(role)));
const initialUserRoleLabel = computed(() => (newUserRoles.value.length ? t("etcd.access.createAndAssignRoles", { count: newUserRoles.value.length }) : t("etcd.access.createUserAction")));
const hasInitialRolePermission = computed(() => newRolePermissionResource.value === "all" || !!newRolePermissionKey.value);
const hasPermissionTarget = computed(() => permissionResource.value === "all" || !!permissionKey.value);

function reset(message = "") {
  error.value = "";
  notice.value = message;
}

function displayValue(value: api.KvValue): string {
  if (value.encoding === "utf8") return value.data;
  try {
    const bytes = Uint8Array.from(atob(value.data), (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return `base64:${value.data}`;
  }
}

function permissionResourceOf(permission: api.EtcdAuthPermission): PermissionResource {
  if (permission.resource) return permission.resource;
  if (permission.key.data === "" && permission.rangeEnd.encoding === "base64" && permission.rangeEnd.data === "AA==") return "all";
  return permission.rangeEnd.data ? "prefix" : "key";
}

function permissionLabel(access: PermissionAccess): string {
  return access === "readwrite" ? t("etcd.access.readWrite") : access === "read" ? t("etcd.access.read") : t("etcd.access.write");
}

function permissionParams(permission: api.EtcdAuthPermission) {
  return {
    role: selectedRole.value,
    key: displayValue(permission.key),
    keyBytes: permission.key,
    resource: permissionResourceOf(permission),
    access: permission.access,
  };
}

function errorMessage(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  if (message.includes("ETCD_PREFLIGHT_REQUIRED")) return t("etcd.access.preflightRequired");
  if (message.includes("ETCD_PREFLIGHT_EXPIRED")) return t("etcd.access.preflightExpired");
  if (message.includes("ETCD_PREFLIGHT_MISMATCH")) return t("etcd.access.preflightMismatch");
  return message;
}

async function run(action: () => Promise<void>) {
  busy.value = true;
  reset();
  try {
    await action();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}

async function requestApproval(action: string, params: Record<string, unknown>, execute: (approval: api.EtcdDangerousApproval) => Promise<void>) {
  if (readOnly.value) return;
  try {
    const preflight = await api.etcdPreflight(props.connectionId, action, params);
    approvalExpected.value = preflight.confirmationText;
    approvalText.value = "";
    pendingApproval = () => execute({ preflightToken: preflight.token, confirmationText: preflight.confirmationText });
    approvalOpen.value = true;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

async function confirmApproval() {
  if (approvalText.value !== approvalExpected.value || !pendingApproval) return;
  const execute = pendingApproval;
  pendingApproval = null;
  approvalOpen.value = false;
  await run(execute);
}

function closeApproval() {
  approvalOpen.value = false;
  pendingApproval = null;
  approvalText.value = "";
}

async function loadDirectory() {
  loading.value = true;
  reset();
  try {
    const [userResponse, roleResponse] = await Promise.all([api.etcdAuthCall<api.EtcdAuthUserListResponse>(props.connectionId, "user_list", {}), api.etcdAuthCall<api.EtcdAuthRoleListResponse>(props.connectionId, "role_list", {})]);
    users.value = userResponse.users ?? [];
    roles.value = roleResponse.roles ?? [];
    if (selectedUser.value && !users.value.includes(selectedUser.value)) {
      selectedUser.value = "";
      userDetail.value = null;
    }
    if (selectedRole.value && !roles.value.includes(selectedRole.value)) {
      selectedRole.value = "";
      roleDetail.value = null;
    }
    await ensureSelectedForView();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}

async function selectUser(user: string) {
  const request = ++detailRequest;
  selectedUser.value = user;
  userDetail.value = null;
  detailLoading.value = true;
  try {
    const detail = await api.etcdAuthCall<api.EtcdAuthUserDetail>(props.connectionId, "user_get", { user });
    if (request !== detailRequest || view.value !== "users" || selectedUser.value !== user) return;
    userDetail.value = detail;
  } catch (caught) {
    if (request !== detailRequest || view.value !== "users" || selectedUser.value !== user) return;
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

async function selectRole(role: string) {
  const request = ++detailRequest;
  selectedRole.value = role;
  roleDetail.value = null;
  detailLoading.value = true;
  try {
    const detail = await api.etcdAuthCall<api.EtcdAuthRoleDetail>(props.connectionId, "role_get", { role });
    if (request !== detailRequest || view.value !== "roles" || selectedRole.value !== role) return;
    roleDetail.value = detail;
  } catch (caught) {
    if (request !== detailRequest || view.value !== "roles" || selectedRole.value !== role) return;
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

async function ensureSelectedForView(targetView = view.value) {
  if (targetView === "users") {
    if (selectedUser.value && users.value.includes(selectedUser.value)) {
      if (userDetail.value?.user === selectedUser.value) return;
      await selectUser(selectedUser.value);
      return;
    }
    const firstUser = users.value[0];
    if (firstUser) await selectUser(firstUser);
    return;
  }

  if (selectedRole.value && roles.value.includes(selectedRole.value)) {
    if (roleDetail.value?.role === selectedRole.value) return;
    await selectRole(selectedRole.value);
    return;
  }
  const firstRole = roles.value[0];
  if (firstRole) await selectRole(firstRole);
}

async function selectView(targetView: AccessView) {
  if (view.value !== targetView) {
    detailRequest++;
    detailLoading.value = false;
  }
  view.value = targetView;
  await ensureSelectedForView(targetView);
}

async function createUser() {
  if (!newUser.value.trim() || !newUserPassword.value || readOnly.value) return;
  const user = newUser.value.trim();
  const password = newUserPassword.value;
  const initialRoles = [...newUserRoles.value];
  const create = async (approvals: api.EtcdDangerousApproval[]) => {
    await api.etcdAuthCall(props.connectionId, "user_add", { user, password }, approvals[0]);
    try {
      for (const [index, role] of initialRoles.entries()) {
        await api.etcdAuthCall(props.connectionId, "user_grant_role", { user, role }, approvals[index + 1]);
      }
    } catch (caught) {
      await loadDirectory();
      await selectUser(user);
      createUserOpen.value = false;
      throw new Error(t("etcd.access.createdUserRolesFailed", { error: errorMessage(caught) }));
    }
    newUser.value = "";
    newUserPassword.value = "";
    newUserRoles.value = [];
    createUserOpen.value = false;
    await loadDirectory();
    await selectUser(user);
    notice.value = initialRoles.length ? t("etcd.access.createdUserWithRoles", { user, count: initialRoles.length }) : t("etcd.access.createdUser", { user });
  };
  busy.value = true;
  reset();
  try {
    const preflights = await Promise.all([api.etcdPreflight(props.connectionId, "auth_user_add", { user, password }), ...initialRoles.map((role) => api.etcdPreflight(props.connectionId, "auth_user_grant_role", { user, role }))]);
    if (preflights.some((preflight) => preflight.confirmationText !== preflights[0].confirmationText)) {
      throw new Error(t("etcd.access.confirmationMismatch"));
    }
    approvalExpected.value = preflights[0].confirmationText;
    approvalText.value = "";
    pendingApproval = () => create(preflights.map((preflight) => ({ preflightToken: preflight.token, confirmationText: preflight.confirmationText })));
    approvalOpen.value = true;
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}

function openCreateUser() {
  newUser.value = "";
  newUserPassword.value = "";
  newUserRoles.value = [];
  createUserOpen.value = true;
}

async function createRole() {
  if (!newRole.value.trim() || readOnly.value) return;
  const role = newRole.value.trim();
  const initialPermission = hasInitialRolePermission.value ? { role, key: newRolePermissionResource.value === "all" ? "" : newRolePermissionKey.value, resource: newRolePermissionResource.value, access: newRolePermissionAccess.value } : null;
  const create = async (approvals: api.EtcdDangerousApproval[]) => {
    await api.etcdAuthCall(props.connectionId, "role_add", { role }, approvals[0]);
    if (initialPermission) {
      try {
        await api.etcdAuthCall(props.connectionId, "role_grant_permission", initialPermission, approvals[1]);
      } catch (caught) {
        await loadDirectory();
        await selectRole(role);
        createRoleOpen.value = false;
        throw new Error(t("etcd.access.createdRolePermissionFailed", { error: errorMessage(caught) }));
      }
    }
    newRole.value = "";
    newRolePermissionKey.value = "";
    newRolePermissionResource.value = "prefix";
    newRolePermissionAccess.value = "readwrite";
    createRoleOpen.value = false;
    await loadDirectory();
    await selectRole(role);
    notice.value = initialPermission ? t("etcd.access.createdRoleWithPermission", { role }) : t("etcd.access.createdRole", { role });
  };
  busy.value = true;
  reset();
  try {
    const preflights = await Promise.all([api.etcdPreflight(props.connectionId, "auth_role_add", { role }), ...(initialPermission ? [api.etcdPreflight(props.connectionId, "auth_role_grant_permission", initialPermission)] : [])]);
    if (preflights.some((preflight) => preflight.confirmationText !== preflights[0].confirmationText)) {
      throw new Error(t("etcd.access.confirmationMismatch"));
    }
    approvalExpected.value = preflights[0].confirmationText;
    approvalText.value = "";
    pendingApproval = () => create(preflights.map((preflight) => ({ preflightToken: preflight.token, confirmationText: preflight.confirmationText })));
    approvalOpen.value = true;
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}

function deleteUser(user: string) {
  const params = { user };
  void requestApproval("auth_user_delete", params, async (approval) => {
    await api.etcdAuthCall(props.connectionId, "user_delete", params, approval);
    await loadDirectory();
    notice.value = t("etcd.access.deletedUser", { user });
  });
}

function deleteRole(role: string) {
  const params = { role };
  void requestApproval("auth_role_delete", params, async (approval) => {
    await api.etcdAuthCall(props.connectionId, "role_delete", params, approval);
    await loadDirectory();
    notice.value = t("etcd.access.deletedRole", { role });
  });
}

function changePassword() {
  if (!selectedUser.value || !newPassword.value || readOnly.value) return;
  const params = { user: selectedUser.value, password: newPassword.value };
  void requestApproval("auth_user_change_password", params, async (approval) => {
    await api.etcdAuthCall(props.connectionId, "user_change_password", params, approval);
    newPassword.value = "";
    passwordOpen.value = false;
    notice.value = t("etcd.access.passwordUpdated", { user: selectedUser.value });
  });
}

function updateUserRole(grant: boolean, role: string) {
  if (!selectedUser.value || !role || readOnly.value) return;
  const params = { user: selectedUser.value, role };
  const operation = grant ? "user_grant_role" : "user_revoke_role";
  const action = grant ? "auth_user_grant_role" : "auth_user_revoke_role";
  void requestApproval(action, params, async (approval) => {
    await api.etcdAuthCall(props.connectionId, operation, params, approval);
    await selectUser(selectedUser.value);
    selectedGrantRole.value = "";
    notice.value = grant ? t("etcd.access.roleGranted", { role, user: params.user }) : t("etcd.access.roleRevoked", { role, user: params.user });
  });
}

function openGrantPermission() {
  editingPermission.value = null;
  permissionError.value = "";
  permissionKey.value = "";
  permissionResource.value = "prefix";
  permissionAccess.value = "readwrite";
  permissionOpen.value = true;
}

function openEditPermission(permission: api.EtcdAuthPermission) {
  editingPermission.value = permission;
  permissionError.value = "";
  permissionResource.value = permissionResourceOf(permission);
  permissionKey.value = permissionResource.value === "all" ? "" : displayValue(permission.key);
  permissionAccess.value = permission.access;
  permissionOpen.value = true;
}

function grantPermission() {
  if (!selectedRole.value || !hasPermissionTarget.value || readOnly.value) return;
  const params = { role: selectedRole.value, key: permissionResource.value === "all" ? "" : permissionKey.value, resource: permissionResource.value, access: permissionAccess.value };
  void requestApproval("auth_role_grant_permission", params, async (approval) => {
    await api.etcdAuthCall(props.connectionId, "role_grant_permission", params, approval);
    permissionKey.value = "";
    permissionOpen.value = false;
    await selectRole(selectedRole.value);
    notice.value = t("etcd.access.permissionGranted");
  });
}

function editPermission() {
  const previous = editingPermission.value;
  if (!previous || !selectedRole.value || !hasPermissionTarget.value || readOnly.value) return;
  const oldParams = permissionParams(previous);
  const newParams = { role: selectedRole.value, key: permissionResource.value === "all" ? "" : permissionKey.value, resource: permissionResource.value, access: permissionAccess.value };
  if (oldParams.key === newParams.key && oldParams.resource === newParams.resource && oldParams.access === newParams.access) {
    permissionOpen.value = false;
    return;
  }
  void requestPermissionReplacementApproval(oldParams, newParams);
}

async function requestPermissionReplacementApproval(oldParams: Record<string, unknown>, newParams: Record<string, unknown>) {
  permissionError.value = "";
  busy.value = true;
  try {
    const [revokePreflight, grantPreflight] = await Promise.all([api.etcdPreflight(props.connectionId, "auth_role_revoke_permission", oldParams), api.etcdPreflight(props.connectionId, "auth_role_grant_permission", newParams)]);
    if (revokePreflight.confirmationText !== grantPreflight.confirmationText) {
      throw new Error(t("etcd.access.confirmationMismatch"));
    }
    approvalExpected.value = revokePreflight.confirmationText;
    approvalText.value = "";
    pendingApproval = async () => {
      let revoked = false;
      try {
        await api.etcdAuthCall(props.connectionId, "role_revoke_permission", oldParams, {
          preflightToken: revokePreflight.token,
          confirmationText: revokePreflight.confirmationText,
        });
        revoked = true;
        await api.etcdAuthCall(props.connectionId, "role_grant_permission", newParams, {
          preflightToken: grantPreflight.token,
          confirmationText: grantPreflight.confirmationText,
        });
      } catch (caught) {
        permissionError.value = errorMessage(caught);
        if (revoked) {
          try {
            const restorePreflight = await api.etcdPreflight(props.connectionId, "auth_role_grant_permission", oldParams);
            await api.etcdAuthCall(props.connectionId, "role_grant_permission", oldParams, {
              preflightToken: restorePreflight.token,
              confirmationText: restorePreflight.confirmationText,
            });
          } catch {
            // Keep the actionable error. The next refresh exposes the actual
            // etcd permission state if a best-effort recovery also fails.
          }
        }
        throw caught;
      }
      editingPermission.value = null;
      permissionOpen.value = false;
      await selectRole(selectedRole.value);
      notice.value = t("etcd.access.permissionUpdated");
    };
    approvalOpen.value = true;
  } catch (caught) {
    permissionError.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}

function savePermission() {
  if (editingPermission.value) editPermission();
  else grantPermission();
}

function revokePermission(permission: api.EtcdAuthPermission) {
  if (!selectedRole.value || readOnly.value) return;
  const params = permissionParams(permission);
  void requestApproval("auth_role_revoke_permission", params, async (approval) => {
    await api.etcdAuthCall(props.connectionId, "role_revoke_permission", params, approval);
    await selectRole(selectedRole.value);
    notice.value = t("etcd.access.permissionRevoked");
  });
}

watch(
  () => props.connectionId,
  () => {
    detailRequest++;
    detailLoading.value = false;
    selectedUser.value = "";
    selectedRole.value = "";
    userDetail.value = null;
    roleDetail.value = null;
    void loadDirectory();
  },
);

watch(permissionResource, (resource) => {
  if (resource === "all") permissionKey.value = "";
});

watch(newRolePermissionResource, (resource) => {
  if (resource === "all") newRolePermissionKey.value = "";
});

onMounted(() => void loadDirectory());
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <header class="flex h-14 shrink-0 flex-wrap items-center gap-3 border-b px-4">
      <div class="flex rounded-md border p-0.5 shadow-sm">
        <Button size="sm" class="h-8 gap-1.5 px-3 text-sm" :variant="view === 'users' ? 'secondary' : 'ghost'" @click="void selectView('users')"><UsersRound class="h-4 w-4" />{{ t("etcd.access.users") }}</Button>
        <Button size="sm" class="h-8 gap-1.5 px-3 text-sm" :variant="view === 'roles' ? 'secondary' : 'ghost'" @click="void selectView('roles')"><KeyRound class="h-4 w-4" />{{ t("etcd.access.roles") }}</Button>
      </div>
      <div class="hidden h-5 w-px bg-border sm:block" />
      <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck class="h-3.5 w-3.5 text-sky-600" />
        <span class="font-medium text-foreground/75">{{ t("etcd.access.title") }}</span>
        <span>{{ t("etcd.access.description") }}</span>
      </div>
      <div class="flex-1" />
      <Badge v-if="readOnly" variant="outline">{{ t("etcd.access.readOnly") }}</Badge>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loading" @click="loadDirectory"><RefreshCw class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" />{{ t("etcd.access.refresh") }}</Button>
    </header>

    <div v-if="error" class="mx-4 mt-3 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{{ error }}</div>
    <div v-if="notice" class="mx-4 mt-3 rounded border bg-muted/40 px-3 py-2 text-sm">{{ notice }}</div>

    <div v-if="view === 'users'" class="grid min-h-0 flex-1 md:grid-cols-[16rem_minmax(0,1fr)]">
      <aside class="min-h-0 border-b md:border-b-0 md:border-r">
        <div class="flex items-center justify-between border-b px-3 py-2">
          <span class="text-sm font-medium">{{ t("etcd.access.userCount", { count: users.length }) }}</span>
          <Button size="icon-xs" :disabled="readOnly" :title="t('etcd.access.createUser')" @click="openCreateUser"><UserPlus class="h-3.5 w-3.5" /></Button>
        </div>
        <div class="max-h-52 overflow-auto p-1 md:max-h-none md:h-[calc(100%-41px)]">
          <button v-for="user in users" :key="user" type="button" class="flex w-full items-center rounded px-2 py-2 text-left text-sm hover:bg-accent" :class="selectedUser === user ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground'" @click="selectUser(user)">{{ user }}</button>
          <p v-if="!loading && users.length === 0" class="p-3 text-xs text-muted-foreground">{{ t("etcd.access.noUsers") }}</p>
        </div>
      </aside>

      <main class="min-h-0 overflow-auto p-4">
        <div v-if="!selectedUser" class="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">{{ t("etcd.access.selectUser") }}</div>
        <div v-else-if="detailLoading" class="flex h-32 items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 h-4 w-4 animate-spin" />{{ t("etcd.access.loadingUser") }}</div>
        <template v-else-if="userDetail">
          <div class="mb-5 flex flex-wrap items-center gap-2 border-b pb-4">
            <div class="mr-auto">
              <h3 class="font-mono text-base font-semibold">{{ userDetail.user }}</h3>
              <p class="mt-1 text-xs text-muted-foreground">{{ t("etcd.access.userRolesSummary", { count: userDetail.roles.length }) }}</p>
            </div>
            <Button size="sm" variant="outline" class="gap-1.5" :disabled="readOnly" @click="passwordOpen = true"><LockKeyhole class="h-3.5 w-3.5" />{{ t("etcd.access.changePassword") }}</Button>
            <Button size="sm" variant="destructive" class="gap-1.5" :disabled="readOnly" @click="deleteUser(userDetail.user)"><Trash2 class="h-3.5 w-3.5" />{{ t("etcd.access.deleteUser") }}</Button>
          </div>
          <section class="max-w-3xl space-y-5">
            <div>
              <div class="mb-3 flex items-center gap-2">
                <h4 class="text-sm font-medium">{{ t("etcd.access.roleAssignments") }}</h4>
                <Badge variant="secondary">{{ userDetail.roles.length }}</Badge>
              </div>
              <p class="mb-3 text-xs text-muted-foreground">{{ t("etcd.access.roleAssignmentHint") }}</p>
              <div v-if="userDetail.roles.length" class="divide-y rounded border">
                <div v-for="role in userDetail.roles" :key="role" class="flex items-center gap-3 px-3 py-2.5">
                  <KeyRound class="h-4 w-4 text-muted-foreground" /><code class="flex-1 text-sm">{{ role }}</code
                  ><Button size="sm" variant="ghost" class="text-destructive hover:text-destructive" :disabled="readOnly || busy" @click="updateUserRole(false, role)">{{ t("etcd.access.revokeAssociation") }}</Button>
                </div>
              </div>
              <p v-else class="rounded border border-dashed px-3 py-5 text-sm text-muted-foreground">{{ t("etcd.access.noAssignedRoles") }}</p>
            </div>
            <div class="border-t pt-4">
              <h5 class="text-sm font-medium">{{ t("etcd.access.assignRole") }}</h5>
              <p class="mt-1 text-xs text-muted-foreground">{{ t("etcd.access.assignRoleHint") }}</p>
              <div class="mt-3 flex max-w-xl flex-wrap gap-2">
                <select v-model="selectedGrantRole" class="h-9 min-w-52 rounded-md border bg-background px-3 text-sm" :disabled="readOnly || grantableRoles.length === 0">
                  <option value="">{{ grantableRoles.length ? t("etcd.access.selectRoleOption") : t("etcd.access.noAssignableRoles") }}</option>
                  <option v-for="role in grantableRoles" :key="role" :value="role">{{ role }}</option>
                </select>
                <Button size="sm" class="h-9 gap-1.5" :disabled="readOnly || busy || !selectedGrantRole" @click="updateUserRole(true, selectedGrantRole)"><Plus class="h-3.5 w-3.5" />{{ t("etcd.access.grantRole") }}</Button>
              </div>
            </div>
          </section>
        </template>
      </main>
    </div>

    <div v-else class="grid min-h-0 flex-1 md:grid-cols-[16rem_minmax(0,1fr)]">
      <aside class="min-h-0 border-b md:border-b-0 md:border-r">
        <div class="flex items-center justify-between border-b px-3 py-2">
          <span class="text-sm font-medium">{{ t("etcd.access.roleCount", { count: roles.length }) }}</span>
          <Button size="icon-xs" :disabled="readOnly" :title="t('etcd.access.createRole')" @click="createRoleOpen = true"><Plus class="h-3.5 w-3.5" /></Button>
        </div>
        <div class="max-h-52 overflow-auto p-1 md:max-h-none md:h-[calc(100%-41px)]">
          <button v-for="role in roles" :key="role" type="button" class="flex w-full items-center rounded px-2 py-2 text-left text-sm hover:bg-accent" :class="selectedRole === role ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground'" @click="selectRole(role)">{{ role }}</button>
          <p v-if="!loading && roles.length === 0" class="p-3 text-xs text-muted-foreground">{{ t("etcd.access.noRoles") }}</p>
        </div>
      </aside>

      <main class="min-h-0 overflow-auto p-4">
        <div v-if="!selectedRole" class="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">{{ t("etcd.access.selectRole") }}</div>
        <div v-else-if="detailLoading" class="flex h-32 items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 h-4 w-4 animate-spin" />{{ t("etcd.access.loadingRole") }}</div>
        <template v-else-if="roleDetail">
          <div class="mb-5 flex flex-wrap items-center gap-2 border-b pb-4">
            <div class="mr-auto">
              <h3 class="font-mono text-base font-semibold">{{ roleDetail.role }}</h3>
              <p class="mt-1 text-xs text-muted-foreground">{{ t("etcd.access.rolePermissionHint") }}</p>
            </div>
            <Button size="sm" class="gap-1.5" :disabled="readOnly" @click="openGrantPermission"><Plus class="h-3.5 w-3.5" />{{ t("etcd.access.grantPermission") }}</Button>
            <Button size="sm" variant="destructive" class="gap-1.5" :disabled="readOnly" @click="deleteRole(roleDetail.role)"><Trash2 class="h-3.5 w-3.5" />{{ t("etcd.access.deleteRole") }}</Button>
          </div>
          <div class="overflow-auto rounded border">
            <table class="w-full min-w-[580px] text-left text-sm">
              <thead class="bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th class="px-3 py-2 font-medium">{{ t("etcd.access.resource") }}</th>
                  <th class="px-3 py-2 font-medium">Key / Prefix</th>
                  <th class="px-3 py-2 font-medium">{{ t("etcd.access.permission") }}</th>
                  <th class="w-32 px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="permission in roleDetail.permissions" :key="`${permission.key.encoding}:${permission.key.data}:${permission.rangeEnd.data}`" class="border-t">
                  <td class="px-3 py-2">
                    <Badge variant="outline">{{ permissionResourceOf(permission) === "all" ? t("etcd.access.allKeys") : permissionResourceOf(permission) === "prefix" ? t("etcd.admin.prefix") : t("etcd.access.exactKey") }}</Badge>
                  </td>
                  <td class="max-w-md truncate px-3 py-2 font-mono text-xs">{{ permissionResourceOf(permission) === "all" ? t("etcd.access.allKeyspace") : displayValue(permission.key) }}</td>
                  <td class="px-3 py-2">
                    <Badge variant="secondary">{{ permissionLabel(permission.access) }}</Badge>
                  </td>
                  <td class="px-3 py-2">
                    <div class="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" class="gap-1" :disabled="readOnly || busy" @click="openEditPermission(permission)"><Pencil class="h-3.5 w-3.5" />{{ t("etcd.access.edit") }}</Button
                      ><Button size="sm" variant="ghost" class="text-destructive hover:text-destructive" :disabled="readOnly || busy" @click="revokePermission(permission)">{{ t("etcd.access.revoke") }}</Button>
                    </div>
                  </td>
                </tr>
                <tr v-if="roleDetail.permissions.length === 0">
                  <td colspan="4" class="px-3 py-8 text-center text-sm text-muted-foreground">{{ t("etcd.access.noPermissions") }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </main>
    </div>

    <Dialog v-model:open="createUserOpen"
      ><DialogContent class="sm:max-w-lg"
        ><DialogHeader
          ><DialogTitle>{{ t("etcd.access.createEtcdUser") }}</DialogTitle></DialogHeader
        >
        <div class="space-y-5 py-2">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="space-y-1.5"
              ><span class="text-sm font-medium">{{ t("etcd.access.username") }}</span
              ><Input v-model="newUser" :placeholder="t('etcd.access.username')" autocomplete="off" /></label
            ><label class="space-y-1.5"
              ><span class="text-sm font-medium">{{ t("etcd.access.password") }}</span
              ><Input v-model="newUserPassword" type="password" :placeholder="t('etcd.access.password')" autocomplete="new-password"
            /></label>
          </div>
          <div class="border-t pt-4">
            <div class="flex items-baseline justify-between gap-3">
              <div>
                <h4 class="text-sm font-medium">
                  {{ t("etcd.access.initialRoles") }} <span class="text-xs font-normal text-muted-foreground">{{ t("etcd.access.optional") }}</span>
                </h4>
                <p class="mt-1 text-xs text-muted-foreground">{{ t("etcd.access.initialRolesHint") }}</p>
              </div>
              <Badge v-if="newUserRoles.length" variant="secondary">{{ t("etcd.access.selectedCount", { count: newUserRoles.length }) }}</Badge>
            </div>
            <div v-if="roles.length" class="mt-3 max-h-44 divide-y overflow-auto rounded border">
              <label v-for="role in roles" :key="role" class="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/40"
                ><input v-model="newUserRoles" type="checkbox" :value="role" class="h-4 w-4 accent-primary" /><KeyRound class="h-4 w-4 text-muted-foreground" /><code class="text-sm">{{ role }}</code></label
              >
            </div>
            <p v-else class="mt-3 rounded border border-dashed px-3 py-4 text-sm text-muted-foreground">{{ t("etcd.access.noRolesForNewUser") }}</p>
          </div>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="createUserOpen = false">{{ t("etcd.access.cancel") }}</Button
          ><Button :disabled="busy || readOnly || !newUser.trim() || !newUserPassword" @click="createUser">{{ initialUserRoleLabel }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
    <Dialog v-model:open="createRoleOpen"
      ><DialogContent class="sm:max-w-lg"
        ><DialogHeader
          ><DialogTitle>{{ t("etcd.access.createEtcdRole") }}</DialogTitle></DialogHeader
        >
        <div class="space-y-4 py-2">
          <Input v-model="newRole" :placeholder="t('etcd.access.roleName')" autocomplete="off" />
          <div class="space-y-3 rounded-md border bg-muted/20 p-3">
            <div>
              <div class="text-sm font-medium">
                {{ t("etcd.access.initialPermission") }} <span class="text-xs font-normal text-muted-foreground">{{ t("etcd.access.optional") }}</span>
              </div>
              <p class="mt-1 text-xs text-muted-foreground">{{ t("etcd.access.initialPermissionHint") }}</p>
            </div>
            <Input v-if="newRolePermissionResource !== 'all'" v-model="newRolePermissionKey" :placeholder="t('etcd.access.keyOrPrefixPlaceholder')" autocomplete="off" />
            <p v-else class="rounded border border-dashed bg-background px-3 py-2 text-xs text-muted-foreground">{{ t("etcd.access.allKeysHint") }}</p>
            <div class="grid grid-cols-2 gap-3">
              <select v-model="newRolePermissionResource" class="h-9 rounded-md border bg-background px-3 text-sm">
                <option value="all">{{ t("etcd.access.allKeys") }}</option>
                <option value="prefix">{{ t("etcd.admin.prefix") }}</option>
                <option value="key">{{ t("etcd.access.exactKey") }}</option></select
              ><select v-model="newRolePermissionAccess" class="h-9 rounded-md border bg-background px-3 text-sm">
                <option value="read">{{ t("etcd.access.read") }}</option>
                <option value="write">{{ t("etcd.access.write") }}</option>
                <option value="readwrite">{{ t("etcd.access.readWrite") }}</option>
              </select>
            </div>
          </div>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="createRoleOpen = false">{{ t("etcd.access.cancel") }}</Button
          ><Button :disabled="busy || readOnly || !newRole.trim()" @click="createRole">{{ hasInitialRolePermission ? t("etcd.access.createAndGrantPermission") : t("etcd.access.createRole") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
    <Dialog v-model:open="passwordOpen"
      ><DialogContent class="sm:max-w-md"
        ><DialogHeader
          ><DialogTitle>{{ t("etcd.access.changePassword") }}</DialogTitle></DialogHeader
        >
        <div class="space-y-2 py-2">
          <p class="text-sm text-muted-foreground">{{ t("etcd.access.passwordHint") }}</p>
          <Input v-model="newPassword" type="password" :placeholder="t('etcd.access.newPassword')" autocomplete="new-password" />
        </div>
        <DialogFooter
          ><Button variant="outline" @click="passwordOpen = false">{{ t("etcd.access.cancel") }}</Button
          ><Button :disabled="busy || readOnly || !newPassword" @click="changePassword">{{ t("etcd.access.continue") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
    <Dialog v-model:open="permissionOpen"
      ><DialogContent class="sm:max-w-lg"
        ><DialogHeader
          ><DialogTitle>{{ editingPermission ? t("etcd.access.editPermission") : t("etcd.access.grantPermission") }}</DialogTitle></DialogHeader
        >
        <div class="space-y-3 py-2">
          <p v-if="editingPermission" class="text-xs leading-5 text-muted-foreground">{{ t("etcd.access.permissionUpdateHint") }}</p>
          <div v-if="permissionError" class="rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{{ permissionError }}</div>
          <Input v-if="permissionResource !== 'all'" v-model="permissionKey" :placeholder="t('etcd.access.keyOrPrefixPlaceholder')" autocomplete="off" />
          <p v-else class="rounded border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">{{ t("etcd.access.allKeysHint") }}</p>
          <div class="grid grid-cols-2 gap-3">
            <select v-model="permissionResource" class="h-9 rounded-md border bg-background px-3 text-sm">
              <option value="all">{{ t("etcd.access.allKeys") }}</option>
              <option value="prefix">{{ t("etcd.admin.prefix") }}</option>
              <option value="key">{{ t("etcd.access.exactKey") }}</option></select
            ><select v-model="permissionAccess" class="h-9 rounded-md border bg-background px-3 text-sm">
              <option value="read">{{ t("etcd.access.read") }}</option>
              <option value="write">{{ t("etcd.access.write") }}</option>
              <option value="readwrite">{{ t("etcd.access.readWrite") }}</option>
            </select>
          </div>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="permissionOpen = false">{{ t("etcd.access.cancel") }}</Button
          ><Button :disabled="busy || readOnly || !hasPermissionTarget" @click="savePermission">{{ editingPermission ? t("etcd.access.saveChanges") : t("etcd.access.continue") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
    <Dialog :open="approvalOpen" @update:open="(open) => !open && closeApproval()"
      ><DialogContent class="sm:max-w-md"
        ><DialogHeader
          ><DialogTitle class="text-destructive">{{ t("etcd.access.dangerousTitle") }}</DialogTitle></DialogHeader
        >
        <div class="space-y-3 py-2">
          <p class="text-sm text-muted-foreground">{{ t("etcd.access.dangerousHint") }}</p>
          <code class="block rounded border bg-muted px-3 py-2 text-xs break-all">{{ approvalExpected }}</code
          ><Input v-model="approvalText" :placeholder="t('etcd.access.confirmationPlaceholder')" autocomplete="off" />
        </div>
        <DialogFooter
          ><Button variant="outline" :disabled="busy" @click="closeApproval">{{ t("etcd.access.cancel") }}</Button
          ><Button variant="destructive" :disabled="busy || approvalText !== approvalExpected" @click="confirmApproval">{{ t("etcd.access.confirmExecute") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
  </div>
</template>
