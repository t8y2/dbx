<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { KeyRound, Loader2, Pencil, Plus, RefreshCw, Search, ShieldCheck, ShieldPlus, Trash2, UserRound } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import NacosNamespaceMultiSelect from "@/components/nacos/NacosNamespaceMultiSelect.vue";
import * as api from "@/lib/backend/api";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { subscribeNacosNamespacesChanged, type NacosNamespacesChangedDetail } from "@/lib/nacos/nacosNamespaceCache";
import { normalizeNacosNamespacesForDisplay } from "@/lib/nacos/nacosNamespaceVisibility";
import { useConnectionStore } from "@/stores/connectionStore";
import type { NacosAdminConfig, NacosConnectionInfo, NacosNamespaceInfo, NacosNamespacePrivilege, NacosOperationCapability, NacosRoleBinding, NacosUserInfo } from "@/types/nacos";

const props = defineProps<{
  connectionId: string;
  connectionInfo: NacosConnectionInfo | null;
  readOnly?: boolean;
  tab: "users" | "roles";
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();

type UserDialogMode = "create" | "edit" | "reset";

const users = ref<NacosUserInfo[]>([]);
const usersLoading = ref(false);
const usersError = ref("");
const userOperationNotice = ref<{ kind: "success" | "error"; message: string } | null>(null);
const userSearch = ref("");
const userPageNo = ref(1);
const userPageSize = ref(20);
const userTotal = ref(0);

const roles = ref<NacosRoleBinding[]>([]);
const rolesLoading = ref(false);
const rolesError = ref("");
const roleUsername = ref("");
const roleName = ref("");
const rolePageNo = ref(1);
const rolePageSize = ref(20);
const roleTotal = ref(0);

const userDialogOpen = ref(false);
const userDialogMode = ref<UserDialogMode>("create");
const userDialogError = ref("");
const userSaving = ref(false);
const userForm = ref(createUserForm());
const userFormNamespaces = ref<NacosNamespaceInfo[]>([]);
const userFormNamespacesLoading = ref(false);
const userFormNamespacesError = ref("");
const pendingUserDelete = ref<NacosUserInfo | null>(null);
const userDeleteConfirmation = ref("");
const deletingUser = ref(false);
const roleDialogOpen = ref(false);
const roleDialogError = ref("");
const roleSaving = ref(false);
const roleForm = ref({ username: "", role: "" });
const pendingRoleDelete = ref<NacosRoleBinding | null>(null);
const deletingRole = ref(false);

const rnacosAuthOpen = ref(false);
const rnacosAuthLoading = ref(false);
const rnacosCaptchaImage = ref("");
const rnacosCaptcha = ref("");
const rnacosAuthError = ref("");
let rnacosRetry: (() => Promise<void>) | null = null;
let latestUserFormNamespacesRequestId = 0;
let stopNacosNamespacesChangedListener: (() => void) | null = null;

const accessControl = computed(() => props.connectionInfo?.capabilities.accessControl);
const mode = computed(() => accessControl.value?.mode ?? "unavailable");
const isRNacos = computed(() => mode.value === "embeddedRoles");
const userTotalPages = computed(() => Math.max(1, Math.ceil(userTotal.value / Math.max(1, userPageSize.value))));
const roleTotalPages = computed(() => Math.max(1, Math.ceil(roleTotal.value / Math.max(1, rolePageSize.value))));
const userDeleteConfirmed = computed(() => userDeleteConfirmation.value === pendingUserDelete.value?.username);

function createUserForm() {
  return {
    username: "",
    password: "",
    nickname: "",
    enabled: true,
    roles: [] as string[],
    whitelistIsAll: true,
    whitelist: [] as string[],
    blacklistIsAll: false,
    blacklist: [] as string[],
  };
}

function operationCapability(value: NacosOperationCapability | undefined): NacosOperationCapability {
  return value ?? { supported: false, reason: "notVerified" };
}

function capabilityReason(capability: NacosOperationCapability) {
  if (props.readOnly) return t("nacos.capabilityReadOnly");
  switch (capability.reason) {
    case "implementationReadOnly":
      return t("nacos.capabilityReadOnlyWrite");
    case "versionUnsupported":
      return t("nacos.capabilityVersionUnsupported");
    case "endpointUnavailable":
      return t("nacos.capabilityEndpointUnavailable");
    default:
      return t("nacos.capabilityNotVerified");
  }
}

function isWritable(capability: NacosOperationCapability | undefined) {
  return !props.readOnly && operationCapability(capability).supported;
}

async function confirmAccessMutation(reviewText: string) {
  const confirmed = await executeWithProductionContextGuard({
    connection: connectionStore.getConfig(props.connectionId),
    database: "",
    reviewText,
    source: t("production.sourceAdmin"),
    execute: async () => true,
  });
  return confirmed === true;
}

function listUsersCapability() {
  return operationCapability(accessControl.value?.listUsers);
}

function createUserCapability() {
  return operationCapability(accessControl.value?.createUser);
}

function updateUserCapability() {
  return operationCapability(accessControl.value?.updateUser);
}

function deleteUserCapability() {
  return operationCapability(accessControl.value?.deleteUser);
}

function listRolesCapability() {
  return operationCapability(accessControl.value?.listRoleBindings);
}

function assignRoleCapability() {
  return operationCapability(accessControl.value?.assignRole);
}

function removeRoleCapability() {
  return operationCapability(accessControl.value?.removeRole);
}

function privilegeFromForm(): NacosNamespacePrivilege {
  return {
    // r-nacos derives this read-only state from its privilege flags; its
    // update API accepts only the whitelist and blacklist options below.
    enabled: true,
    whitelistIsAll: userForm.value.whitelistIsAll,
    whitelist: [...userForm.value.whitelist],
    blacklistIsAll: userForm.value.blacklistIsAll,
    blacklist: [...userForm.value.blacklist],
  };
}

function captchaImageSource(image: string) {
  return image.startsWith("data:") ? image : `data:image/png;base64,${image}`;
}

async function withRNacosAuthentication(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("[rnacosConsoleCaptchaRequired]")) throw error;
    rnacosRetry = action;
    await requestRNacosAuthentication();
  }
}

async function requestRNacosAuthentication() {
  rnacosAuthLoading.value = true;
  rnacosAuthError.value = "";
  rnacosCaptcha.value = "";
  try {
    const challenge = await api.nacosGetRNacosConsoleCaptcha(props.connectionId);
    if (!challenge.required) {
      await api.nacosLoginRNacosConsole(props.connectionId);
      const retry = rnacosRetry;
      rnacosRetry = null;
      if (retry) await retry();
      return;
    }
    if (!challenge.image) throw new Error(t("nacos.rnacosCaptchaUnavailable"));
    rnacosCaptchaImage.value = captchaImageSource(challenge.image);
    rnacosAuthOpen.value = true;
  } catch (error) {
    rnacosAuthError.value = error instanceof Error ? error.message : String(error);
  } finally {
    rnacosAuthLoading.value = false;
  }
}

async function submitRNacosAuthentication() {
  if (!rnacosCaptcha.value.trim()) {
    rnacosAuthError.value = t("nacos.rnacosCaptchaRequired");
    return;
  }
  rnacosAuthLoading.value = true;
  rnacosAuthError.value = "";
  try {
    await api.nacosLoginRNacosConsole(props.connectionId, rnacosCaptcha.value);
    rnacosAuthOpen.value = false;
    const retry = rnacosRetry;
    rnacosRetry = null;
    if (retry) await retry();
  } catch (error) {
    rnacosAuthError.value = error instanceof Error ? error.message : String(error);
  } finally {
    rnacosAuthLoading.value = false;
  }
}

async function loadUsers(page = userPageNo.value) {
  if (!listUsersCapability().supported) return;
  usersLoading.value = true;
  usersError.value = "";
  userPageNo.value = page;
  try {
    await withRNacosAuthentication(async () => {
      const result = await api.nacosListUsers(props.connectionId, {
        username: userSearch.value.trim() || undefined,
        pageNo: userPageNo.value,
        pageSize: userPageSize.value,
      });
      users.value = result.items;
      userTotal.value = result.totalCount;
    });
  } catch (error) {
    usersError.value = error instanceof Error ? error.message : String(error);
  } finally {
    usersLoading.value = false;
  }
}

async function loadRoles(page = rolePageNo.value) {
  if (!listRolesCapability().supported) return;
  rolesLoading.value = true;
  rolesError.value = "";
  rolePageNo.value = page;
  try {
    const result = await api.nacosListRoleBindings(props.connectionId, {
      username: roleUsername.value.trim() || undefined,
      role: roleName.value.trim() || undefined,
      pageNo: rolePageNo.value,
      pageSize: rolePageSize.value,
    });
    roles.value = result.items;
    roleTotal.value = result.totalCount;
  } catch (error) {
    rolesError.value = error instanceof Error ? error.message : String(error);
  } finally {
    rolesLoading.value = false;
  }
}

async function loadUserFormNamespaces(force = false) {
  if (!isRNacos.value || userFormNamespacesLoading.value || (userFormNamespaces.value.length && !force)) return;
  const connectionId = props.connectionId;
  const requestId = ++latestUserFormNamespacesRequestId;
  userFormNamespacesLoading.value = true;
  userFormNamespacesError.value = "";
  try {
    const namespaces = normalizeNacosNamespacesForDisplay(await api.nacosListNamespaces(connectionId));
    if (requestId !== latestUserFormNamespacesRequestId || connectionId !== props.connectionId) return;
    userFormNamespaces.value = namespaces;
  } catch (error) {
    if (requestId !== latestUserFormNamespacesRequestId || connectionId !== props.connectionId) return;
    userFormNamespacesError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestId === latestUserFormNamespacesRequestId) userFormNamespacesLoading.value = false;
  }
}

function handleNacosNamespacesChanged(detail: NacosNamespacesChangedDetail) {
  if (detail.connectionId !== props.connectionId) return;
  latestUserFormNamespacesRequestId += 1;
  userFormNamespaces.value = [];
  userFormNamespacesError.value = "";
  userFormNamespacesLoading.value = false;
  if (userDialogOpen.value && isRNacos.value) void loadUserFormNamespaces(true);
}

function openCreateUser() {
  userDialogMode.value = "create";
  userDialogError.value = "";
  userOperationNotice.value = null;
  userForm.value = createUserForm();
  userDialogOpen.value = true;
  void loadUserFormNamespaces();
}

function openEditUser(user: NacosUserInfo) {
  userDialogMode.value = isRNacos.value ? "edit" : "reset";
  userDialogError.value = "";
  userOperationNotice.value = null;
  const privilege = user.namespacePrivilege;
  userForm.value = {
    username: user.username,
    password: "",
    nickname: user.nickname ?? "",
    enabled: user.enabled ?? true,
    roles: [...user.roles],
    whitelistIsAll: privilege?.whitelistIsAll ?? true,
    whitelist: [...(privilege?.whitelist ?? [])],
    blacklistIsAll: privilege?.blacklistIsAll ?? false,
    blacklist: [...(privilege?.blacklist ?? [])],
  };
  userDialogOpen.value = true;
  void loadUserFormNamespaces();
}

watch(
  () => props.connectionId,
  () => {
    latestUserFormNamespacesRequestId += 1;
    userFormNamespaces.value = [];
    userFormNamespacesError.value = "";
    userFormNamespacesLoading.value = false;
  },
);

function toggleRNacosRole(role: string, checked: boolean) {
  const next = new Set(userForm.value.roles);
  if (checked) next.add(role);
  else next.delete(role);
  userForm.value.roles = [...next];
}

async function saveUser() {
  if (userSaving.value) return;
  const username = userForm.value.username.trim();
  const resettingPassword = userDialogMode.value === "reset";
  if (!username || (userDialogMode.value !== "edit" && !userForm.value.password)) {
    userDialogError.value = t("nacos.userCredentialsRequired");
    return;
  }
  if (!(await confirmAccessMutation(`${userDialogMode.value === "create" ? t("nacos.createUser") : t("nacos.save")}: ${username}`))) return;
  userSaving.value = true;
  userDialogError.value = "";
  try {
    await withRNacosAuthentication(async () => {
      if (userDialogMode.value === "create") {
        await api.nacosCreateUser(props.connectionId, {
          username,
          password: userForm.value.password,
          nickname: isRNacos.value ? userForm.value.nickname.trim() || undefined : undefined,
          enabled: isRNacos.value ? userForm.value.enabled : undefined,
          roles: isRNacos.value ? userForm.value.roles : [],
          namespacePrivilege: isRNacos.value ? privilegeFromForm() : undefined,
        });
      } else {
        await api.nacosUpdateUser(props.connectionId, {
          username,
          password: userForm.value.password,
          nickname: isRNacos.value ? userForm.value.nickname.trim() || undefined : undefined,
          enabled: isRNacos.value ? userForm.value.enabled : undefined,
          roles: isRNacos.value ? userForm.value.roles : undefined,
          namespacePrivilege: isRNacos.value ? privilegeFromForm() : undefined,
        });
      }
      userDialogOpen.value = false;
      await loadUsers(1);
      if (resettingPassword) {
        const handledConnectionCredential = await syncCurrentConnectionPassword(username, userForm.value.password);
        if (!handledConnectionCredential) {
          userOperationNotice.value = { kind: "success", message: t("nacos.passwordResetSucceeded", { username }) };
        }
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    userDialogError.value = message;
    if (resettingPassword) userOperationNotice.value = { kind: "error", message: t("nacos.passwordResetFailed", { message }) };
  } finally {
    userSaving.value = false;
  }
}

async function syncCurrentConnectionPassword(username: string, password: string): Promise<boolean> {
  const config = connectionStore.getConfig(props.connectionId);
  if (!config || config.db_type !== "nacos") return false;
  const hasExternalConfig = !!config.external_config && typeof config.external_config === "object";
  const externalConfig = (config.external_config || {}) as NacosAdminConfig;
  const primaryAuth = externalConfig.auth;
  const primaryMatches = (primaryAuth?.kind === "usernamePassword" && primaryAuth.username === username) || (!hasExternalConfig && config.username === username);
  const consoleAuth = externalConfig.rnacosConsoleAuth;
  const consoleMatches = consoleAuth?.kind === "usernamePassword" && consoleAuth.username === username;
  if (!primaryMatches && !consoleMatches) return false;
  if (config.save_password === false) {
    try {
      await api.replaceNacosSessionCredential(props.connectionId, username, password);
      userOperationNotice.value = { kind: "success", message: `${t("nacos.passwordResetSucceeded", { username })} ${t("nacos.currentSessionPasswordUpdated")}` };
    } catch {
      userOperationNotice.value = { kind: "success", message: `${t("nacos.passwordResetSucceeded", { username })} ${t("nacos.currentPasswordNotSaved")}` };
    }
    return true;
  }
  const nextExternal: NacosAdminConfig | undefined = hasExternalConfig
    ? {
        ...externalConfig,
        auth: primaryMatches ? { kind: "usernamePassword", username, password } : primaryAuth,
        rnacosConsoleAuth: consoleMatches ? { kind: "usernamePassword", username, password } : consoleAuth,
      }
    : undefined;
  try {
    await connectionStore.updateConnection({
      ...config,
      password: primaryMatches ? password : config.password,
      external_config: nextExternal,
    });
    userOperationNotice.value = { kind: "success", message: `${t("nacos.passwordResetSucceeded", { username })} ${t("nacos.currentPasswordSaved")}` };
  } catch {
    userOperationNotice.value = { kind: "success", message: `${t("nacos.passwordResetSucceeded", { username })} ${t("nacos.currentPasswordNotSaved")}` };
  }
  return true;
}

async function deleteUser() {
  const user = pendingUserDelete.value;
  if (!user || deletingUser.value) return;
  if (!(await confirmAccessMutation(`${t("nacos.deleteUser")}: ${user.username}`))) return;
  deletingUser.value = true;
  try {
    await withRNacosAuthentication(async () => {
      await api.nacosDeleteUser(props.connectionId, user.username);
      pendingUserDelete.value = null;
      userDeleteConfirmation.value = "";
      await loadUsers(Math.min(userPageNo.value, userTotalPages.value));
    });
  } catch (error) {
    usersError.value = error instanceof Error ? error.message : String(error);
  } finally {
    deletingUser.value = false;
  }
}

function openDeleteUser(user: NacosUserInfo) {
  pendingUserDelete.value = user;
  userDeleteConfirmation.value = "";
}

function closeDeleteUser() {
  pendingUserDelete.value = null;
  userDeleteConfirmation.value = "";
}

function openAssignRole() {
  roleDialogError.value = "";
  roleForm.value = { username: roleUsername.value.trim(), role: "" };
  roleDialogOpen.value = true;
}

async function assignRole() {
  if (roleSaving.value) return;
  if (!roleForm.value.username.trim() || !roleForm.value.role.trim()) {
    roleDialogError.value = t("nacos.roleBindingRequired");
    return;
  }
  if (!(await confirmAccessMutation(`${t("nacos.assignRole")}: ${roleForm.value.username.trim()} · ${roleForm.value.role.trim()}`))) return;
  roleSaving.value = true;
  roleDialogError.value = "";
  try {
    await api.nacosAssignRole(props.connectionId, { username: roleForm.value.username.trim(), role: roleForm.value.role.trim() });
    roleDialogOpen.value = false;
    await loadRoles(1);
  } catch (error) {
    roleDialogError.value = error instanceof Error ? error.message : String(error);
  } finally {
    roleSaving.value = false;
  }
}

async function removeRole() {
  const binding = pendingRoleDelete.value;
  if (!binding || deletingRole.value) return;
  if (!(await confirmAccessMutation(`${t("nacos.removeRole")}: ${binding.username} · ${binding.role}`))) return;
  deletingRole.value = true;
  try {
    await api.nacosRemoveRole(props.connectionId, binding);
    pendingRoleDelete.value = null;
    await loadRoles(Math.min(rolePageNo.value, roleTotalPages.value));
  } catch (error) {
    rolesError.value = error instanceof Error ? error.message : String(error);
  } finally {
    deletingRole.value = false;
  }
}

watch(
  () => props.tab,
  (tab) => {
    if (tab === "users") void loadUsers(1);
    else void loadRoles(1);
  },
);

watch(
  () => props.connectionId,
  () => {
    users.value = [];
    roles.value = [];
    userPageNo.value = 1;
    rolePageNo.value = 1;
    if (props.tab === "users") void loadUsers(1);
    else void loadRoles(1);
  },
);

onMounted(() => {
  stopNacosNamespacesChangedListener = subscribeNacosNamespacesChanged(handleNacosNamespacesChanged);
  if (props.tab === "users") void loadUsers(1);
  else void loadRoles(1);
});

onBeforeUnmount(() => {
  latestUserFormNamespacesRequestId += 1;
  stopNacosNamespacesChangedListener?.();
  stopNacosNamespacesChangedListener = null;
});

defineExpose({
  refresh: () => (props.tab === "users" ? loadUsers() : loadRoles()),
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-background">
    <template v-if="tab === 'users'">
      <header class="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-2.5">
        <div class="relative min-w-48 max-w-xl flex-1">
          <Input v-model="userSearch" class="h-8 pr-8" :placeholder="t('nacos.searchUsers')" @keyup.enter="loadUsers(1)" />
          <Search class="pointer-events-none absolute right-2.5 top-2 h-4 w-4 text-muted-foreground" />
        </div>
        <div class="flex-1" />
        <Button size="sm" variant="outline" class="h-8 w-8 px-0" :disabled="usersLoading || !listUsersCapability().supported" :title="!listUsersCapability().supported ? capabilityReason(listUsersCapability()) : t('nacos.refresh')" :aria-label="t('nacos.refresh')" @click="loadUsers(1)">
          <Loader2 v-if="usersLoading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCw v-else class="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" class="h-8 gap-1.5" :disabled="!isWritable(createUserCapability())" :title="!isWritable(createUserCapability()) ? capabilityReason(createUserCapability()) : undefined" @click="openCreateUser">
          <Plus class="h-3.5 w-3.5" />
          {{ t("nacos.createUser") }}
        </Button>
      </header>
      <div v-if="!listUsersCapability().supported" class="border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">{{ capabilityReason(listUsersCapability()) }}</div>
      <div v-if="usersError" class="border-b px-3 py-2 text-xs text-destructive">{{ usersError }}</div>
      <div v-if="userOperationNotice" class="border-b px-3 py-2 text-xs" :class="userOperationNotice.kind === 'success' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-destructive/10 text-destructive'" role="status" aria-live="polite">
        {{ userOperationNotice.message }}
      </div>
      <div class="min-h-0 flex-1 overflow-auto">
        <table class="w-full min-w-[680px] text-sm">
          <thead class="sticky top-0 z-10 bg-muted/70 text-left text-xs text-muted-foreground">
            <tr class="border-b">
              <th class="px-3 py-2 font-medium">{{ t("nacos.username") }}</th>
              <th class="px-3 py-2 font-medium">{{ t("nacos.nickname") }}</th>
              <th class="px-3 py-2 font-medium">{{ t("nacos.roles") }}</th>
              <th class="px-3 py-2 font-medium">{{ t("nacos.state") }}</th>
              <th class="w-32 px-3 py-2 text-right font-medium">{{ t("nacos.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.username" class="border-b hover:bg-accent/40">
              <td class="px-3 py-2 font-medium">{{ user.username }}</td>
              <td class="px-3 py-2 text-muted-foreground">{{ user.nickname || "-" }}</td>
              <td class="px-3 py-2">
                <div class="flex flex-wrap gap-1">
                  <Badge v-for="role in user.roles" :key="role" variant="outline" class="font-normal">{{ isRNacos ? t(`nacos.rnacosRole${role}`) : role }}</Badge
                  ><span v-if="!user.roles.length" class="text-muted-foreground">-</span>
                </div>
              </td>
              <td class="px-3 py-2">
                <Badge v-if="isRNacos" :variant="user.enabled === false ? 'outline' : 'secondary'" :class="user.enabled === false ? 'text-muted-foreground' : 'text-emerald-700 dark:text-emerald-300'">{{ user.enabled === false ? t("nacos.disabled") : t("nacos.enabled") }}</Badge
                ><span v-else class="text-muted-foreground">-</span>
              </td>
              <td class="px-3 py-2">
                <div class="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" class="h-7 w-7 p-0" :disabled="!isWritable(updateUserCapability())" :title="isRNacos ? t('nacos.editUser') : t('nacos.resetUserPassword')" @click="openEditUser(user)"
                    ><Pencil v-if="isRNacos" class="h-3.5 w-3.5" /><KeyRound v-else class="h-3.5 w-3.5" /></Button
                  ><Button size="sm" variant="ghost" class="h-7 w-7 p-0 text-destructive hover:text-destructive" :disabled="!isWritable(deleteUserCapability())" :title="t('nacos.deleteUser')" @click="openDeleteUser(user)"><Trash2 class="h-3.5 w-3.5" /></Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!usersLoading && !users.length" class="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground"><UserRound class="mr-2 h-4 w-4" />{{ t("nacos.noUsers") }}</div>
      </div>
      <footer class="flex shrink-0 items-center justify-between border-t bg-muted/10 px-4 py-2 text-xs text-muted-foreground">
        <span>{{ t("nacos.total", { count: userTotal }) }}</span>
        <div class="flex items-center gap-2">
          <Button size="sm" variant="outline" class="h-7" :disabled="userPageNo <= 1 || usersLoading" @click="loadUsers(userPageNo - 1)">{{ t("nacos.prev") }}</Button
          ><span>{{ userPageNo }} / {{ userTotalPages }}</span
          ><Button size="sm" variant="outline" class="h-7" :disabled="userPageNo >= userTotalPages || usersLoading" @click="loadUsers(userPageNo + 1)">{{ t("nacos.next") }}</Button>
        </div>
      </footer>
    </template>

    <template v-else>
      <header class="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-2.5">
        <Input v-model="roleUsername" class="h-8 min-w-44 max-w-sm flex-1" :placeholder="t('nacos.filterUsername')" @keyup.enter="loadRoles(1)" />
        <Input v-model="roleName" class="h-8 min-w-44 max-w-sm flex-1" :placeholder="t('nacos.filterRole')" @keyup.enter="loadRoles(1)" />
        <div class="flex-1" />
        <Button size="sm" variant="outline" class="h-8 w-8 px-0" :disabled="rolesLoading || !listRolesCapability().supported" :title="!listRolesCapability().supported ? capabilityReason(listRolesCapability()) : t('nacos.refresh')" :aria-label="t('nacos.refresh')" @click="loadRoles(1)"
          ><Loader2 v-if="rolesLoading" class="h-3.5 w-3.5 animate-spin" /><RefreshCw v-else class="h-3.5 w-3.5"
        /></Button>
        <Button size="sm" class="h-8 gap-1.5" :disabled="!isWritable(assignRoleCapability())" :title="!isWritable(assignRoleCapability()) ? capabilityReason(assignRoleCapability()) : undefined" @click="openAssignRole"><ShieldPlus class="h-3.5 w-3.5" />{{ t("nacos.assignRole") }}</Button>
      </header>
      <div v-if="rolesError" class="border-b px-3 py-2 text-xs text-destructive">{{ rolesError }}</div>
      <div class="min-h-0 flex-1 overflow-auto">
        <table class="w-full min-w-[520px] text-sm">
          <thead class="sticky top-0 z-10 bg-muted/70 text-left text-xs text-muted-foreground">
            <tr class="border-b">
              <th class="px-3 py-2 font-medium">{{ t("nacos.username") }}</th>
              <th class="px-3 py-2 font-medium">{{ t("nacos.role") }}</th>
              <th class="w-24 px-3 py-2 text-right font-medium">{{ t("nacos.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="binding in roles" :key="`${binding.username}:${binding.role}`" class="border-b hover:bg-accent/40">
              <td class="px-3 py-2 font-medium">{{ binding.username }}</td>
              <td class="px-3 py-2">
                <Badge variant="outline" class="font-normal">{{ binding.role }}</Badge>
              </td>
              <td class="px-3 py-2 text-right">
                <span :title="binding.role === 'ROLE_ADMIN' ? t('nacos.protectedRole') : undefined"
                  ><Button size="sm" variant="ghost" class="h-7 w-7 p-0 text-destructive hover:text-destructive" :disabled="binding.role === 'ROLE_ADMIN' || !isWritable(removeRoleCapability())" :aria-label="t('nacos.removeRole')" @click="pendingRoleDelete = binding"
                    ><Trash2 class="h-3.5 w-3.5" /></Button
                ></span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!rolesLoading && !roles.length" class="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground"><ShieldCheck class="mr-2 h-4 w-4" />{{ t("nacos.noRoleBindings") }}</div>
      </div>
      <footer class="flex shrink-0 items-center justify-between border-t bg-muted/10 px-4 py-2 text-xs text-muted-foreground">
        <span>{{ t("nacos.total", { count: roleTotal }) }}</span>
        <div class="flex items-center gap-2">
          <Button size="sm" variant="outline" class="h-7" :disabled="rolePageNo <= 1 || rolesLoading" @click="loadRoles(rolePageNo - 1)">{{ t("nacos.prev") }}</Button
          ><span>{{ rolePageNo }} / {{ roleTotalPages }}</span
          ><Button size="sm" variant="outline" class="h-7" :disabled="rolePageNo >= roleTotalPages || rolesLoading" @click="loadRoles(rolePageNo + 1)">{{ t("nacos.next") }}</Button>
        </div>
      </footer>
    </template>
  </section>

  <Dialog v-model:open="userDialogOpen"
    ><DialogContent class="max-h-[88vh] overflow-auto sm:max-w-xl"
      ><DialogHeader
        ><DialogTitle>{{ t(`nacos.${userDialogMode}UserTitle`) }}</DialogTitle
        ><DialogDescription>{{ t(`nacos.${userDialogMode}UserDescription`) }}</DialogDescription></DialogHeader
      >
      <div class="space-y-4">
        <div class="grid gap-1.5">
          <Label for="nacos-user-name">{{ t("nacos.username") }}</Label
          ><Input id="nacos-user-name" v-model="userForm.username" :disabled="userDialogMode !== 'create'" autocomplete="off" />
        </div>
        <div class="grid gap-1.5">
          <Label for="nacos-user-password">{{ t("nacos.password") }}</Label
          ><Input id="nacos-user-password" v-model="userForm.password" type="password" autocomplete="new-password" :placeholder="userDialogMode === 'edit' ? t('nacos.passwordUnchanged') : undefined" />
        </div>
        <template v-if="isRNacos && userDialogMode !== 'reset'"
          ><div class="grid gap-1.5">
            <Label for="nacos-user-nickname">{{ t("nacos.nickname") }}</Label
            ><Input id="nacos-user-nickname" v-model="userForm.nickname" />
          </div>
          <div class="flex items-center justify-between rounded-md border px-3 py-2">
            <div>
              <div class="text-sm font-medium">{{ t("nacos.enabled") }}</div>
              <div class="text-xs text-muted-foreground">{{ t("nacos.rnacosUserEnabledHint") }}</div>
            </div>
            <Switch v-model="userForm.enabled" />
          </div>
          <fieldset class="space-y-2 rounded-md border p-3">
            <legend class="px-1 text-sm font-medium">{{ t("nacos.roles") }}</legend>
            <label v-for="role in ['0', '1', '2']" :key="role" class="flex items-start gap-2 text-sm"
              ><input type="checkbox" :checked="userForm.roles.includes(role)" @change="toggleRNacosRole(role, ($event.target as HTMLInputElement).checked)" /><span
                ><span class="font-medium">{{ t(`nacos.rnacosRole${role}`) }}</span
                ><span class="ml-2 text-xs text-muted-foreground">{{ t(`nacos.rnacosRole${role}Hint`) }}</span></span
              ></label
            >
          </fieldset>
          <fieldset class="space-y-3 rounded-md border p-3">
            <legend class="px-1 text-sm font-medium">{{ t("nacos.namespacePrivileges") }}</legend>
            <div class="space-y-1.5">
              <div class="flex items-center justify-between">
                <Label>{{ t("nacos.namespaceWhitelist") }}</Label
                ><label class="flex items-center gap-2 text-xs text-muted-foreground"><Switch v-model="userForm.whitelistIsAll" size="sm" />{{ t("nacos.allNamespaces") }}</label>
              </div>
              <NacosNamespaceMultiSelect v-if="!userForm.whitelistIsAll" v-model="userForm.whitelist" :namespaces="userFormNamespaces" :loading="userFormNamespacesLoading" :error="userFormNamespacesError" @retry="loadUserFormNamespaces(true)" />
            </div>
            <div class="space-y-1.5">
              <div class="flex items-center justify-between">
                <Label>{{ t("nacos.namespaceBlacklist") }}</Label
                ><label class="flex items-center gap-2 text-xs text-muted-foreground"><Switch v-model="userForm.blacklistIsAll" size="sm" />{{ t("nacos.allNamespaces") }}</label>
              </div>
              <NacosNamespaceMultiSelect v-if="!userForm.blacklistIsAll" v-model="userForm.blacklist" :namespaces="userFormNamespaces" :loading="userFormNamespacesLoading" :error="userFormNamespacesError" @retry="loadUserFormNamespaces(true)" />
            </div></fieldset
        ></template>
        <p v-if="userDialogError" class="text-sm text-destructive">{{ userDialogError }}</p>
      </div>
      <DialogFooter
        ><Button variant="outline" :disabled="userSaving" @click="userDialogOpen = false">{{ t("nacos.cancel") }}</Button
        ><Button :disabled="userSaving" @click="saveUser"><Loader2 v-if="userSaving" class="mr-2 h-4 w-4 animate-spin" />{{ t("nacos.save") }}</Button></DialogFooter
      ></DialogContent
    ></Dialog
  >

  <Dialog v-model:open="roleDialogOpen"
    ><DialogContent class="sm:max-w-md"
      ><DialogHeader
        ><DialogTitle>{{ t("nacos.assignRoleTitle") }}</DialogTitle
        ><DialogDescription>{{ t("nacos.assignRoleDescription") }}</DialogDescription></DialogHeader
      >
      <div class="space-y-4">
        <div class="grid gap-1.5">
          <Label for="nacos-role-user">{{ t("nacos.username") }}</Label
          ><Input id="nacos-role-user" v-model="roleForm.username" />
        </div>
        <div class="grid gap-1.5">
          <Label for="nacos-role-name">{{ t("nacos.role") }}</Label
          ><Input id="nacos-role-name" v-model="roleForm.role" placeholder="ROLE_USER" />
        </div>
        <p v-if="roleDialogError" class="text-sm text-destructive">{{ roleDialogError }}</p>
      </div>
      <DialogFooter
        ><Button variant="outline" :disabled="roleSaving" @click="roleDialogOpen = false">{{ t("nacos.cancel") }}</Button
        ><Button :disabled="roleSaving" @click="assignRole"><Loader2 v-if="roleSaving" class="mr-2 h-4 w-4 animate-spin" />{{ t("nacos.assignRole") }}</Button></DialogFooter
      ></DialogContent
    ></Dialog
  >

  <Dialog :open="!!pendingUserDelete" @update:open="!$event && closeDeleteUser()"
    ><DialogContent class="sm:max-w-md"
      ><DialogHeader
        ><DialogTitle>{{ t("nacos.deleteUserTitle") }}</DialogTitle
        ><DialogDescription>{{ t("nacos.deleteUserDescription", { username: pendingUserDelete?.username }) }}</DialogDescription></DialogHeader
      >
      <div class="grid gap-1.5">
        <Label for="legacy-delete-user-confirm">{{ t("nacos.accessDeleteUserConfirmationLabel") }}</Label>
        <p id="legacy-delete-user-confirm-hint" class="text-xs text-muted-foreground">
          {{ t("nacos.accessDeleteUserConfirmationHint") }} <code class="select-all rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{{ pendingUserDelete?.username }}</code>
        </p>
        <Input id="legacy-delete-user-confirm" v-model="userDeleteConfirmation" autocomplete="off" :placeholder="t('nacos.accessDeleteUserConfirmationPlaceholder')" aria-describedby="legacy-delete-user-confirm-hint" />
      </div>
      <DialogFooter
        ><Button variant="outline" :disabled="deletingUser" @click="closeDeleteUser">{{ t("nacos.cancel") }}</Button
        ><Button variant="destructive" :disabled="deletingUser || !userDeleteConfirmed" @click="deleteUser"><Loader2 v-if="deletingUser" class="mr-2 h-4 w-4 animate-spin" />{{ t("nacos.delete") }}</Button></DialogFooter
      ></DialogContent
    ></Dialog
  >
  <Dialog :open="!!pendingRoleDelete" @update:open="!$event && (pendingRoleDelete = null)"
    ><DialogContent class="sm:max-w-md"
      ><DialogHeader
        ><DialogTitle>{{ t("nacos.removeRoleTitle") }}</DialogTitle
        ><DialogDescription>{{ t("nacos.removeRoleDescription", pendingRoleDelete ?? {}) }}</DialogDescription></DialogHeader
      ><DialogFooter
        ><Button variant="outline" :disabled="deletingRole" @click="pendingRoleDelete = null">{{ t("nacos.cancel") }}</Button
        ><Button variant="destructive" :disabled="deletingRole" @click="removeRole"><Loader2 v-if="deletingRole" class="mr-2 h-4 w-4 animate-spin" />{{ t("nacos.removeRole") }}</Button></DialogFooter
      ></DialogContent
    ></Dialog
  >
  <Dialog v-model:open="rnacosAuthOpen"
    ><DialogContent class="sm:max-w-sm"
      ><DialogHeader
        ><DialogTitle>{{ t("nacos.rnacosConsoleAuthTitle") }}</DialogTitle
        ><DialogDescription>{{ t("nacos.rnacosAccessControlAuthDescription") }}</DialogDescription></DialogHeader
      >
      <div class="space-y-3">
        <img v-if="rnacosCaptchaImage" :src="rnacosCaptchaImage" class="h-16 w-full rounded border object-contain" :alt="t('nacos.rnacosCaptchaLabel')" /><Input v-model="rnacosCaptcha" :placeholder="t('nacos.rnacosCaptchaPlaceholder')" @keyup.enter="submitRNacosAuthentication" />
        <p v-if="rnacosAuthError" class="text-sm text-destructive">{{ rnacosAuthError }}</p>
      </div>
      <DialogFooter
        ><Button variant="outline" :disabled="rnacosAuthLoading" @click="requestRNacosAuthentication">{{ t("nacos.rnacosRefreshCaptcha") }}</Button
        ><Button :disabled="rnacosAuthLoading" @click="submitRNacosAuthentication"><Loader2 v-if="rnacosAuthLoading" class="mr-2 h-4 w-4 animate-spin" />{{ t("nacos.rnacosConsoleAuthSubmit") }}</Button></DialogFooter
      ></DialogContent
    ></Dialog
  >
</template>
