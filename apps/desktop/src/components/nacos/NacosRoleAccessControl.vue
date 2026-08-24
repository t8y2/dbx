<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, CircleAlert, KeyRound, Link2, Loader2, LockKeyhole, Pencil, Plus, RefreshCw, RotateCcw, Search, Shield, ShieldCheck, ShieldPlus, Trash2, UserPlus, UserRound, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { mergeNacosNamespacePermissionAssignments, type NacosNamespacePermissionAction } from "@/lib/nacos/nacosAdmin";
import { subscribeNacosNamespacesChanged, type NacosNamespacesChangedDetail } from "@/lib/nacos/nacosNamespaceCache";
import { useConnectionStore } from "@/stores/connectionStore";
import type { NacosAccessControlCapabilities, NacosAccessControlSnapshot, NacosAccessOperationRequest, NacosAccessOperationResult, NacosAdminConfig, NacosPermissionDraft, NacosPermissionInfo, NacosUserInfo } from "@/types/nacos";

const props = defineProps<{
  connectionId: string;
  capabilities: NacosAccessControlCapabilities;
  readOnly?: boolean;
  tab: "users" | "roles";
}>();
const emit = defineEmits<{
  (event: "select-user"): void;
  (event: "select-role"): void;
}>();

type PermissionAction = NacosNamespacePermissionAction;
type PermissionAssignment = { namespaceId: string; action: PermissionAction };

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const snapshot = ref<NacosAccessControlSnapshot | null>(null);
const loading = ref(false);
const error = ref("");
const search = ref("");
const page = ref(1);
const pageSize = 30;
const selectedUserName = ref("");
const selectedRoleName = ref("");

const userDialog = ref<"create" | "roles" | "password" | "delete" | null>(null);
const userForm = reactive({ username: "", password: "", roles: [] as string[], confirmation: "" });
const roleDialog = ref<"create" | "edit" | "delete" | null>(null);
const roleForm = reactive({
  role: "",
  members: [] as string[],
  newUsers: [] as Array<{ username: string; password: string }>,
  permissions: [] as PermissionAssignment[],
  confirmation: "",
});
const availableNamespaceSearch = ref("");
const grantedNamespaceSearch = ref("");
const selectedAvailableNamespaceIds = ref<string[]>([]);
const selectedGrantedNamespaceIds = ref<string[]>([]);
const formError = ref("");
const saving = ref(false);
const operationOpen = ref(false);
const operation = ref<NacosAccessOperationResult | null>(null);
const pendingAdvancedPermission = ref<NacosPermissionInfo | null>(null);
const advancedPermissionConfirmation = ref("");
const retryPasswords = reactive<Record<string, string>>({});
let latestSnapshotRequestId = 0;
let stopNacosNamespacesChangedListener: (() => void) | null = null;

const users = computed(() => snapshot.value?.users ?? []);
const roles = computed(() => snapshot.value?.roles ?? []);
const normalizedSearch = computed(() => search.value.trim().toLocaleLowerCase());
const filteredUsers = computed(() => users.value.filter((user) => user.username.toLocaleLowerCase().includes(normalizedSearch.value)));
const filteredRoles = computed(() => roles.value.filter((role) => role.role.toLocaleLowerCase().includes(normalizedSearch.value)));
const currentItems = computed(() => (props.tab === "users" ? filteredUsers.value : filteredRoles.value));
const totalPages = computed(() => Math.max(1, Math.ceil(currentItems.value.length / pageSize)));
const pagedUsers = computed(() => filteredUsers.value.slice((page.value - 1) * pageSize, page.value * pageSize));
const pagedRoles = computed(() => filteredRoles.value.slice((page.value - 1) * pageSize, page.value * pageSize));
const selectedUser = computed(() => users.value.find((user) => user.username === selectedUserName.value) ?? null);
const selectedRole = computed(() => roles.value.find((role) => role.role === selectedRoleName.value) ?? null);
const roleMembers = computed(() => (snapshot.value?.roleBindings ?? []).filter((binding) => binding.role === selectedRoleName.value).map((binding) => binding.username));
const rolePermissions = computed(() => (snapshot.value?.permissions ?? []).filter((permission) => permission.role === selectedRoleName.value));
const managedRolePermissions = computed(() => rolePermissions.value.filter(isManagedPermission));
const advancedRolePermissions = computed(() => rolePermissions.value.filter((permission) => !isManagedPermission(permission)));
const assignableRoles = computed(() => roles.value.filter((role) => role.administrator || role.permissionCount > 0));
const namespaceOptions = computed(() =>
  (snapshot.value?.namespaces ?? []).map((namespace) => ({
    id: namespace.namespace || "public",
    name: namespace.namespaceShowName || namespace.namespace || "public",
  })),
);
const grantedNamespaceIds = computed(() => new Set(roleForm.permissions.map((permission) => permission.namespaceId)));
const availableNamespaces = computed(() =>
  filterNamespaces(
    namespaceOptions.value.filter((namespace) => !grantedNamespaceIds.value.has(namespace.id)),
    availableNamespaceSearch.value,
  ),
);
const grantedNamespaces = computed(() =>
  filterNamespaces(
    roleForm.permissions.map((permission) => ({
      ...permission,
      name: namespaceOptions.value.find((namespace) => namespace.id === permission.namespaceId)?.name ?? permission.namespaceId,
    })),
    grantedNamespaceSearch.value,
  ),
);
const selectedUserPermissions = computed(() => effectivePermissions(selectedUser.value));
const operationNeedsPasswords = computed(() => operation.value?.steps.filter((step) => ["failed", "skipped"].includes(step.status) && step.needsPassword) ?? []);
const adminConfirmationTarget = computed(() => {
  if (!selectedRole.value?.administrator) return "";
  const current = snapshot.value?.currentUsername;
  if (current && roleMembers.value.includes(current) && !roleForm.members.includes(current)) return current;
  return "ROLE_ADMIN";
});
const adminMembersChanged = computed(() => {
  if (!selectedRole.value?.administrator) return false;
  const before = [...roleMembers.value].sort().join("\n");
  const after = [...roleForm.members].sort().join("\n");
  return before !== after || roleForm.newUsers.length > 0;
});
const canCreateUser = computed(() => !props.readOnly && props.capabilities.createUser.supported);
const canUpdateUser = computed(() => !props.readOnly && props.capabilities.updateUser.supported);
const canDeleteUser = computed(() => !props.readOnly && props.capabilities.deleteUser.supported);
const canAssignRole = computed(() => !props.readOnly && props.capabilities.assignRole.supported);
const canRemoveRole = computed(() => !props.readOnly && props.capabilities.removeRole.supported);
const canGrantPermission = computed(() => !props.readOnly && props.capabilities.grantPermission.supported);
const canRevokePermission = computed(() => !props.readOnly && props.capabilities.revokePermission.supported);
const canCreateRole = computed(() => canAssignRole.value && canGrantPermission.value);
const canEditUserRoles = computed(() => canAssignRole.value || canRemoveRole.value);
const canEditRole = computed(() => canAssignRole.value || canRemoveRole.value || canGrantPermission.value || canRevokePermission.value || canCreateUser.value);
const userDeleteConfirmed = computed(() => userForm.confirmation === userForm.username);
const roleDeleteConfirmed = computed(() => roleForm.confirmation === roleForm.role);

function setHasAdded(before: Iterable<string>, after: Iterable<string>) {
  const original = new Set(before);
  return [...after].some((value) => !original.has(value));
}

function permissionActions(assignments: PermissionAssignment[]) {
  return new Map(assignments.map((permission) => [permission.namespaceId, permission.action]));
}

const userOperationWritable = computed(() => {
  if (props.readOnly) return false;
  if (userDialog.value === "password") return canUpdateUser.value;
  if (userDialog.value === "create") {
    return canCreateUser.value && (!userForm.roles.length || canAssignRole.value);
  }
  if (userDialog.value === "roles") {
    const original = selectedUser.value?.roles ?? [];
    const addsRoles = setHasAdded(original, userForm.roles);
    const removesRoles = setHasAdded(userForm.roles, original);
    return (!addsRoles || canAssignRole.value) && (!removesRoles || canRemoveRole.value);
  }
  if (userDialog.value === "delete") {
    return canDeleteUser.value && (!(selectedUser.value?.roles.length ?? 0) || canRemoveRole.value);
  }
  return false;
});

const roleOperationWritable = computed(() => {
  if (props.readOnly) return false;
  if (roleDialog.value === "create") {
    return canAssignRole.value && canGrantPermission.value && (!roleForm.newUsers.length || canCreateUser.value);
  }
  if (roleDialog.value === "delete") {
    return (!roleMembers.value.length || canRemoveRole.value) && (!rolePermissions.value.length || canRevokePermission.value);
  }
  if (roleDialog.value !== "edit") return false;

  const nextMembers = [...roleForm.members, ...roleForm.newUsers.map((user) => user.username.trim()).filter(Boolean)];
  const addsMembers = setHasAdded(roleMembers.value, nextMembers);
  const removesMembers = setHasAdded(nextMembers, roleMembers.value);
  const beforePermissions = permissionActions(mergeNacosNamespacePermissionAssignments(managedRolePermissions.value));
  const afterPermissions = permissionActions(roleForm.permissions);
  let grantsPermissions = false;
  let revokesPermissions = false;
  for (const [namespaceId, action] of afterPermissions) {
    const previous = beforePermissions.get(namespaceId);
    if (previous !== action) grantsPermissions = true;
    if (previous && previous !== action) revokesPermissions = true;
  }
  for (const namespaceId of beforePermissions.keys()) {
    if (!afterPermissions.has(namespaceId)) revokesPermissions = true;
  }
  return (!roleForm.newUsers.length || canCreateUser.value) && (!addsMembers || canAssignRole.value) && (!removesMembers || canRemoveRole.value) && (!grantsPermissions || canGrantPermission.value) && (!revokesPermissions || canRevokePermission.value);
});

async function loadSnapshot(preserveSelection = true) {
  const requestId = ++latestSnapshotRequestId;
  const connectionId = props.connectionId;
  loading.value = true;
  error.value = "";
  try {
    const nextSnapshot = await api.nacosAccessSnapshot(connectionId);
    if (requestId !== latestSnapshotRequestId || connectionId !== props.connectionId) return;
    snapshot.value = nextSnapshot;
    if (!preserveSelection || !users.value.some((user) => user.username === selectedUserName.value)) {
      selectedUserName.value = users.value[0]?.username ?? "";
    }
    if (!preserveSelection || !roles.value.some((role) => role.role === selectedRoleName.value)) {
      selectedRoleName.value = roles.value[0]?.role ?? "";
    }
  } catch (cause) {
    if (requestId !== latestSnapshotRequestId || connectionId !== props.connectionId) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (requestId === latestSnapshotRequestId) loading.value = false;
  }
}

function handleNacosNamespacesChanged(detail: NacosNamespacesChangedDetail) {
  if (detail.connectionId === props.connectionId) void loadSnapshot();
}

function isManagedPermission(permission: NacosPermissionInfo) {
  return permission.parsedScope?.kind === "namespace" && ["r", "w", "rw"].includes(permission.actionRaw);
}

function namespaceName(permission: NacosPermissionInfo) {
  const id = permission.parsedScope?.namespaceId;
  if (!id) return permission.resourceRaw;
  const namespace = namespaceOptions.value.find((item) => item.id === id);
  return namespace ? namespace.name : `${id} (${t("nacos.accessDeletedNamespace")})`;
}

function actionLabel(action: string) {
  if (action === "r") return t("nacos.accessReadOnly");
  if (action === "w") return t("nacos.accessWriteOnly");
  if (action === "rw") return t("nacos.accessReadWrite");
  return action;
}

function mergeAction(left: string, right: string) {
  if (left === right) return left;
  const read = [left, right].some((value) => value === "r" || value === "rw");
  const write = [left, right].some((value) => value === "w" || value === "rw");
  return read && write ? "rw" : read ? "r" : write ? "w" : right;
}

function effectivePermissionKey(permission: NacosPermissionInfo) {
  if (permission.parsedScope?.kind === "namespace") return `namespace:${permission.parsedScope.namespaceId ?? ""}`;
  if (permission.resourceRaw === ":*:*" || permission.resourceRaw === "public:*:*") return "namespace:public";
  return `raw:${permission.resourceRaw}`;
}

function effectivePermissions(user: NacosUserInfo | null) {
  if (!user || !snapshot.value) return [];
  if (user.roles.includes("ROLE_ADMIN")) {
    return [{ resourceRaw: "*:*:*", action: "rw", name: t("nacos.accessAllResources"), sources: ["ROLE_ADMIN"], advanced: false }];
  }
  const grouped = new Map<string, { resourceRaw: string; action: string; name: string; sources: string[]; advanced: boolean }>();
  for (const permission of snapshot.value.permissions.filter((item) => user.roles.includes(item.role))) {
    const key = effectivePermissionKey(permission);
    const existing = grouped.get(key);
    if (existing) {
      if (existing.resourceRaw === ":*:*" && permission.resourceRaw === "public:*:*") existing.resourceRaw = permission.resourceRaw;
      existing.action = mergeAction(existing.action, permission.actionRaw);
      existing.sources.push(permission.role);
    } else {
      grouped.set(key, {
        resourceRaw: permission.resourceRaw,
        action: permission.actionRaw,
        name: namespaceName(permission),
        sources: [permission.role],
        advanced: !isManagedPermission(permission),
      });
    }
  }
  return [...grouped.values()].map((item) => ({ ...item, sources: [...new Set(item.sources)].sort() }));
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

function operationReviewText(request: NacosAccessOperationRequest) {
  switch (request.kind) {
    case "createUser":
      return `${t("nacos.createUser")}: ${request.username}`;
    case "updateUserRoles":
      return `${t("nacos.accessUserDialog.roles")}: ${request.username}`;
    case "deleteUser":
      return `${t("nacos.deleteUser")}: ${request.username}`;
    case "createRole":
      return `${t("nacos.accessCreateRole")}: ${request.role}`;
    case "updateRole":
      return `${t("nacos.accessRoleDialog.edit")}: ${request.role}`;
    case "deleteRole":
      return `${t("nacos.accessDeleteRole")}: ${request.role}`;
    case "revokePermission":
      return `${t("nacos.accessRevokeRawPermission")}: ${request.permission.role}`;
  }
}

function toggle(values: string[], value: string, checked: boolean) {
  const next = new Set(values);
  if (checked) next.add(value);
  else next.delete(value);
  return [...next];
}

function openCreateUser() {
  Object.assign(userForm, { username: "", password: "", roles: [], confirmation: "" });
  formError.value = "";
  userDialog.value = "create";
}

function openUserRoles() {
  if (!selectedUser.value) return;
  Object.assign(userForm, { username: selectedUser.value.username, password: "", roles: [...selectedUser.value.roles], confirmation: "" });
  formError.value = "";
  userDialog.value = "roles";
}

function openUserPassword() {
  if (!selectedUser.value) return;
  Object.assign(userForm, { username: selectedUser.value.username, password: "", roles: [], confirmation: "" });
  formError.value = "";
  userDialog.value = "password";
}

function openDeleteUser() {
  if (!selectedUser.value) return;
  Object.assign(userForm, { username: selectedUser.value.username, password: "", roles: [], confirmation: "" });
  formError.value = "";
  userDialog.value = "delete";
}

async function syncCurrentConnectionPassword(username: string, password: string) {
  if (snapshot.value?.currentUsername !== username) return;
  const config = connectionStore.getConfig(props.connectionId);
  if (!config || config.db_type !== "nacos") return;
  const hasExternalConfig = !!config.external_config && typeof config.external_config === "object";
  const externalConfig = (config.external_config || {}) as NacosAdminConfig;
  const primaryAuth = externalConfig.auth;
  const primaryMatches = (primaryAuth?.kind === "usernamePassword" && primaryAuth.username === username) || (!hasExternalConfig && config.username === username);
  const consoleAuth = externalConfig.rnacosConsoleAuth;
  const consoleMatches = consoleAuth?.kind === "usernamePassword" && consoleAuth.username === username;
  if (!primaryMatches && !consoleMatches) return;
  if (config.save_password === false) {
    try {
      await api.replaceNacosSessionCredential(props.connectionId, username, password);
      toast(t("nacos.currentSessionPasswordUpdated"), 4000);
    } catch {
      toast(t("nacos.currentPasswordNotSaved"), 5000);
    }
    return;
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
    toast(t("nacos.currentPasswordSaved"), 4000);
  } catch {
    toast(t("nacos.currentPasswordNotSaved"), 5000);
  }
}

function resetRoleForm(role = "") {
  Object.assign(roleForm, { role, members: [], newUsers: [], permissions: [], confirmation: "" });
  availableNamespaceSearch.value = "";
  grantedNamespaceSearch.value = "";
  selectedAvailableNamespaceIds.value = [];
  selectedGrantedNamespaceIds.value = [];
}

function openCreateRole() {
  resetRoleForm();
  formError.value = "";
  roleDialog.value = "create";
}

function openEditRole() {
  if (!selectedRole.value) return;
  resetRoleForm(selectedRole.value.role);
  roleForm.members = [...roleMembers.value];
  roleForm.permissions = mergeNacosNamespacePermissionAssignments(managedRolePermissions.value);
  formError.value = "";
  roleDialog.value = "edit";
}

function openDeleteRole() {
  if (!selectedRole.value) return;
  resetRoleForm(selectedRole.value.role);
  formError.value = "";
  roleDialog.value = "delete";
}

function openMemberUser(username: string) {
  selectedUserName.value = username;
  emit("select-user");
}

function openAssociatedRole(role: string) {
  selectedRoleName.value = role;
  emit("select-role");
}

function filterNamespaces<T extends { id?: string; namespaceId?: string; name: string }>(items: T[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return items;
  return items.filter((item) => {
    const id = item.id ?? item.namespaceId ?? "";
    return item.name.toLocaleLowerCase().includes(normalized) || id.toLocaleLowerCase().includes(normalized);
  });
}

function moveNamespacesToGranted() {
  const selected = new Set(selectedAvailableNamespaceIds.value);
  for (const namespace of namespaceOptions.value) {
    if (selected.has(namespace.id) && !grantedNamespaceIds.value.has(namespace.id)) {
      roleForm.permissions.push({ namespaceId: namespace.id, action: "rw" });
    }
  }
  selectedAvailableNamespaceIds.value = [];
}

function removeGrantedNamespaces() {
  const selected = new Set(selectedGrantedNamespaceIds.value);
  roleForm.permissions = roleForm.permissions.filter((permission) => !selected.has(permission.namespaceId));
  selectedGrantedNamespaceIds.value = [];
}

function setPermissionAction(namespaceId: string, action: PermissionAction) {
  const permission = roleForm.permissions.find((item) => item.namespaceId === namespaceId);
  if (permission) permission.action = action;
}

function addNewUser() {
  roleForm.newUsers.push({ username: "", password: "" });
}

async function submitUser() {
  formError.value = "";
  if (userDialog.value === "password") {
    if (!userForm.password) return void (formError.value = t("nacos.accessPasswordRequired"));
    if (!(await confirmAccessMutation(`${t("nacos.accessUserDialog.password")}: ${userForm.username}`))) return;
    const username = userForm.username;
    saving.value = true;
    try {
      await api.nacosUpdateUser(props.connectionId, { username, password: userForm.password });
      await syncCurrentConnectionPassword(username, userForm.password);
      userDialog.value = null;
      toast(t("nacos.passwordResetSucceeded", { username }), 2500);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      formError.value = message;
      toast(t("nacos.passwordResetFailed", { message }), 5000);
    } finally {
      saving.value = false;
    }
    return;
  }
  let req: NacosAccessOperationRequest;
  if (userDialog.value === "create") {
    if (!userForm.username.trim() || !userForm.password) return void (formError.value = t("nacos.accessCredentialsRequired"));
    req = { kind: "createUser", username: userForm.username.trim(), password: userForm.password, roles: userForm.roles, confirmation: userForm.confirmation || undefined };
  } else if (userDialog.value === "roles") {
    req = { kind: "updateUserRoles", username: userForm.username, roles: userForm.roles, confirmation: userForm.confirmation || undefined };
  } else {
    req = { kind: "deleteUser", username: userForm.username, confirmation: userForm.confirmation || undefined };
  }
  await runOperation(req, () => (userDialog.value = null));
}

async function submitRole() {
  formError.value = "";
  if (roleDialog.value === "delete") {
    await runOperation({ kind: "deleteRole", role: roleForm.role, confirmation: roleForm.confirmation || undefined }, () => (roleDialog.value = null));
    return;
  }
  const roleRequiresMember = roleDialog.value === "create" || selectedRole.value?.administrator;
  if (!roleForm.role.trim() || (roleRequiresMember && !roleForm.members.length && !roleForm.newUsers.length)) {
    formError.value = t("nacos.accessRoleMemberRequired");
    return;
  }
  const editingAdministrator = roleDialog.value === "edit" && selectedRole.value?.administrator;
  if (!editingAdministrator && !roleForm.permissions.length) {
    formError.value = t("nacos.accessRolePermissionRequired");
    return;
  }
  if (roleForm.newUsers.some((user) => !user.username.trim() || !user.password)) {
    formError.value = t("nacos.accessInlineUserRequired");
    return;
  }
  const permissions: NacosPermissionDraft[] = roleForm.permissions.map((permission) => ({ namespaceIds: [permission.namespaceId], action: permission.action }));
  const common = {
    role: roleForm.role.trim(),
    members: roleForm.members,
    newUsers: roleForm.newUsers.map((user) => ({ username: user.username.trim(), password: user.password })),
    permissions,
    confirmation: roleForm.confirmation || undefined,
  };
  const req: NacosAccessOperationRequest = roleDialog.value === "create" ? { kind: "createRole", ...common } : { kind: "updateRole", ...common };
  await runOperation(req, () => (roleDialog.value = null));
}

async function runOperation(req: NacosAccessOperationRequest, close: () => void) {
  if (!(await confirmAccessMutation(operationReviewText(req)))) return;
  saving.value = true;
  formError.value = "";
  try {
    operation.value = await api.nacosStartAccessOperation(props.connectionId, req);
    close();
    operationOpen.value = true;
    await loadSnapshot();
  } catch (cause) {
    formError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

async function retryOperation() {
  if (!operation.value) return;
  if (!(await confirmAccessMutation(`${t("nacos.accessRetryFailed")}: ${operation.value.operationId}`))) return;
  saving.value = true;
  try {
    operation.value = await api.nacosRetryAccessOperation(props.connectionId, {
      operationId: operation.value.operationId,
      credentials: operationNeedsPasswords.value.map((step) => ({ username: step.target, password: retryPasswords[step.target] ?? "" })),
    });
    await loadSnapshot();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

async function undoOperation() {
  if (!operation.value) return;
  if (!(await confirmAccessMutation(`${t("nacos.accessUndoCreated")}: ${operation.value.operationId}`))) return;
  saving.value = true;
  try {
    operation.value = await api.nacosUndoAccessOperation(props.connectionId, operation.value.operationId);
    await loadSnapshot();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

async function revokeAdvancedPermission() {
  if (!pendingAdvancedPermission.value) return;
  await runOperation(
    {
      kind: "revokePermission",
      permission: pendingAdvancedPermission.value,
      confirmation: advancedPermissionConfirmation.value || undefined,
    },
    () => (pendingAdvancedPermission.value = null),
  );
}

watch(
  () => props.connectionId,
  () => void loadSnapshot(false),
);
watch(
  () => props.tab,
  () => {
    search.value = "";
    page.value = 1;
  },
);
watch(normalizedSearch, () => (page.value = 1));
onMounted(() => {
  stopNacosNamespacesChangedListener = subscribeNacosNamespacesChanged(handleNacosNamespacesChanged);
  void loadSnapshot(false);
});
onBeforeUnmount(() => {
  latestSnapshotRequestId += 1;
  stopNacosNamespacesChangedListener?.();
  stopNacosNamespacesChangedListener = null;
});

defineExpose({ refresh: () => loadSnapshot() });
</script>

<template>
  <section class="flex min-h-0 flex-1 bg-background">
    <aside class="flex w-64 shrink-0 flex-col border-r bg-muted/10">
      <div class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <div class="relative min-w-0 flex-1">
          <Search class="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input v-model="search" class="h-8 pl-8" :placeholder="tab === 'users' ? t('nacos.searchUsers') : t('nacos.accessSearchRoles')" />
        </div>
        <Button
          size="sm"
          class="h-8 w-8 shrink-0 p-0"
          :title="tab === 'users' ? t('nacos.createUser') : t('nacos.accessCreateRole')"
          :aria-label="tab === 'users' ? t('nacos.createUser') : t('nacos.accessCreateRole')"
          :disabled="tab === 'users' ? !canCreateUser : !canCreateRole"
          @click="tab === 'users' ? openCreateUser() : openCreateRole()"
        >
          <UserPlus v-if="tab === 'users'" class="h-3.5 w-3.5" />
          <ShieldPlus v-else class="h-3.5 w-3.5" />
        </Button>
      </div>

      <div class="min-h-0 flex-1 overflow-auto p-2">
        <template v-if="tab === 'users'">
          <button v-for="user in pagedUsers" :key="user.username" class="mb-0.5 flex h-10 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-accent" :class="selectedUserName === user.username ? 'bg-accent text-accent-foreground' : ''" @click="selectedUserName = user.username">
            <UserRound class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate font-medium">{{ user.username }}</span>
            <Badge v-if="user.roles.includes('ROLE_ADMIN')" variant="secondary" class="h-5 px-1.5 text-[10px]">Admin</Badge>
          </button>
        </template>
        <template v-else>
          <button v-for="role in pagedRoles" :key="role.role" class="mb-0.5 flex min-h-11 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent" :class="selectedRoleName === role.role ? 'bg-accent text-accent-foreground' : ''" @click="selectedRoleName = role.role">
            <ShieldCheck class="h-4 w-4 shrink-0" :class="role.complete ? 'text-emerald-600' : 'text-amber-600'" />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium">{{ role.role }}</span>
              <span class="block text-[11px] text-muted-foreground">{{ t("nacos.accessRoleCounts", { members: role.memberCount, permissions: role.permissionCount }) }}</span>
            </span>
          </button>
        </template>
        <div v-if="!loading && !currentItems.length" class="flex h-32 items-center justify-center px-4 text-center text-xs text-muted-foreground">{{ tab === "users" ? t("nacos.noUsers") : t("nacos.accessNoRoles") }}</div>
      </div>

      <div class="shrink-0 border-t p-2">
        <div class="flex h-7 items-center justify-between px-1 text-xs text-muted-foreground">
          <span>{{ currentItems.length }}</span>
          <div class="flex items-center gap-1">
            <Button size="sm" variant="ghost" class="h-7 w-7 p-0" :disabled="page <= 1" @click="page--"><ChevronLeft class="h-3.5 w-3.5" /></Button><span class="w-10 text-center">{{ page }}/{{ totalPages }}</span
            ><Button size="sm" variant="ghost" class="h-7 w-7 p-0" :disabled="page >= totalPages" @click="page++"><ChevronRight class="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      </div>
    </aside>

    <main class="min-w-0 flex-1 overflow-auto">
      <div v-if="error" class="m-4 flex items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><CircleAlert class="mt-0.5 h-4 w-4 shrink-0" />{{ error }}</div>
      <div v-else-if="loading && !snapshot" class="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 h-4 w-4 animate-spin" />{{ t("nacos.loading") }}</div>

      <template v-else-if="tab === 'users' && selectedUser">
        <header class="flex min-h-16 items-center gap-3 border-b px-5 py-3">
          <div class="flex h-9 w-9 items-center justify-center rounded border bg-muted/30"><UserRound class="h-4 w-4" /></div>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-base font-semibold">{{ selectedUser.username }}</h2>
            <p class="text-xs text-muted-foreground">{{ t("nacos.accessUserSubtitle") }}</p>
          </div>
          <Button size="sm" variant="outline" :disabled="!canUpdateUser" @click="openUserPassword"><KeyRound class="mr-1.5 h-3.5 w-3.5" />{{ t("nacos.resetUserPassword") }}</Button>
          <Button size="sm" variant="ghost" class="text-destructive hover:text-destructive" :disabled="!canDeleteUser || (!!selectedUser.roles.length && !canRemoveRole)" @click="openDeleteUser"
            ><Trash2 class="h-4 w-4" /><span class="sr-only">{{ t("nacos.deleteUser") }}</span></Button
          >
        </header>
        <div class="mx-auto max-w-5xl px-5 py-5">
          <section class="mb-7">
            <div class="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 class="text-sm font-semibold">{{ t("nacos.accessAssociatedRoles") }}</h3>
                <p class="mt-0.5 text-xs text-muted-foreground">{{ t("nacos.accessAssociatedRolesHint") }}</p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <Badge variant="secondary" class="font-normal">{{ selectedUser.roles.length }}</Badge>
                <Button size="sm" variant="outline" :disabled="!canEditUserRoles" @click="openUserRoles"><Pencil class="mr-1.5 h-3.5 w-3.5" />{{ t("nacos.edit") }}</Button>
              </div>
            </div>
            <div v-if="selectedUser.roles.length" class="flex flex-wrap gap-1.5 rounded border bg-muted/20 p-1.5">
              <button
                v-for="role in selectedUser.roles"
                :key="role"
                type="button"
                class="group flex h-9 w-52 items-center gap-2 rounded border bg-background px-2 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :title="t('nacos.accessOpenRole', { role })"
                @click="openAssociatedRole(role)"
              >
                <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-muted/30"><Shield class="h-3.5 w-3.5" /></span>
                <span class="min-w-0 flex-1 truncate font-medium">{{ role }}</span>
                <Link2 class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
              </button>
            </div>
            <div v-else class="flex h-20 items-center justify-center rounded border text-sm text-muted-foreground">{{ t("nacos.accessNoAssociatedRoles") }}</div>
          </section>
          <section>
            <div class="mb-3">
              <h3 class="text-sm font-semibold">{{ t("nacos.accessEffectivePermissions") }}</h3>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ t("nacos.accessEffectivePermissionsHint") }}</p>
            </div>
            <div class="overflow-hidden rounded border">
              <table class="w-full text-sm">
                <thead class="bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th class="px-3 py-2 font-medium">{{ t("nacos.namespace") }}</th>
                    <th class="w-32 px-3 py-2 font-medium">{{ t("nacos.accessAction") }}</th>
                    <th class="px-3 py-2 font-medium">{{ t("nacos.accessSourceRole") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="permission in selectedUserPermissions" :key="permission.resourceRaw" class="border-t">
                    <td class="px-3 py-2.5">
                      <div class="font-medium">{{ permission.name }}</div>
                      <code v-if="permission.name !== permission.resourceRaw" class="mt-0.5 block text-xs font-normal text-muted-foreground">{{ permission.resourceRaw }}</code>
                    </td>
                    <td class="px-3 py-2.5">
                      <Badge variant="outline" class="font-normal">{{ actionLabel(permission.action) }}</Badge>
                    </td>
                    <td class="px-3 py-2.5">
                      <div class="flex flex-wrap gap-1">
                        <Badge v-for="source in permission.sources" :key="source" variant="secondary" class="font-normal">{{ source }}</Badge>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!selectedUserPermissions.length" class="flex h-24 items-center justify-center text-sm text-muted-foreground">{{ t("nacos.accessNoEffectivePermissions") }}</div>
            </div>
          </section>
        </div>
      </template>

      <template v-else-if="tab === 'roles' && selectedRole">
        <header class="flex min-h-16 items-center gap-3 border-b px-5 py-3">
          <div class="flex h-9 w-9 items-center justify-center rounded border bg-muted/30"><ShieldCheck class="h-4 w-4" /></div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <h2 class="truncate text-base font-semibold">{{ selectedRole.role }}</h2>
              <Badge v-if="selectedRole.administrator" variant="secondary">{{ t("nacos.accessGlobalAdministrator") }}</Badge
              ><Badge v-else-if="!selectedRole.complete" variant="outline" class="border-amber-400 text-amber-700">{{ t("nacos.accessNeedsRepair") }}</Badge>
            </div>
            <p class="text-xs text-muted-foreground">{{ t("nacos.accessRoleSubtitle", { members: selectedRole.memberCount }) }}</p>
          </div>
          <Button size="sm" variant="outline" :disabled="!canEditRole" @click="openEditRole"><Pencil class="mr-1.5 h-3.5 w-3.5" />{{ t("nacos.edit") }}</Button>
          <Button v-if="!selectedRole.administrator" size="sm" variant="ghost" class="text-destructive hover:text-destructive" :disabled="readOnly || (!!roleMembers.length && !canRemoveRole) || (!!rolePermissions.length && !canRevokePermission)" @click="openDeleteRole"
            ><Trash2 class="h-4 w-4" /><span class="sr-only">{{ t("nacos.accessDeleteRole") }}</span></Button
          >
        </header>
        <div class="mx-auto max-w-5xl px-5 py-5">
          <div v-if="!selectedRole.complete" class="mb-5 flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200"><AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />{{ t("nacos.accessIncompleteRoleHint") }}</div>
          <section class="mb-7">
            <div class="mb-3">
              <h3 class="text-sm font-semibold">{{ t("nacos.accessPermissionScope") }}</h3>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ t("nacos.accessPermissionScopeHint") }}</p>
            </div>
            <div v-if="selectedRole.administrator" class="flex items-center gap-3 border-y py-4">
              <LockKeyhole class="h-5 w-5 text-amber-600" />
              <div>
                <div class="text-sm font-medium">{{ t("nacos.accessAllResources") }}</div>
                <div class="text-xs text-muted-foreground">{{ t("nacos.accessAdminBypassHint") }}</div>
              </div>
            </div>
            <div v-else class="overflow-hidden rounded border">
              <table class="w-full text-sm">
                <thead class="bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th class="px-3 py-2 font-medium">{{ t("nacos.namespace") }}</th>
                    <th class="w-36 px-3 py-2 font-medium">{{ t("nacos.accessAction") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="permission in managedRolePermissions" :key="`${permission.resourceRaw}:${permission.actionRaw}`" class="border-t">
                    <td class="px-3 py-2.5">
                      <div class="font-medium">{{ namespaceName(permission) }}</div>
                      <code v-if="namespaceName(permission) !== permission.resourceRaw" class="mt-0.5 block text-xs font-normal text-muted-foreground">{{ permission.resourceRaw }}</code>
                    </td>
                    <td class="px-3 py-2.5">
                      <Badge variant="outline" class="font-normal">{{ actionLabel(permission.actionRaw) }}</Badge>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!managedRolePermissions.length" class="flex h-20 items-center justify-center text-sm text-muted-foreground">{{ t("nacos.accessNoRolePermissions") }}</div>
            </div>
          </section>
          <section class="mb-7">
            <div class="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 class="text-sm font-semibold">{{ t("nacos.accessMembers") }}</h3>
                <p class="mt-0.5 text-xs text-muted-foreground">{{ t("nacos.accessMembersHint") }}</p>
              </div>
              <Badge variant="secondary" class="shrink-0 font-normal">{{ roleMembers.length }}</Badge>
            </div>
            <div v-if="roleMembers.length" class="flex flex-wrap gap-1.5 rounded border bg-muted/20 p-1.5">
              <button
                v-for="member in roleMembers"
                :key="member"
                type="button"
                class="group flex h-9 w-52 items-center gap-2 rounded border bg-background px-2 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :title="t('nacos.accessOpenUser', { username: member })"
                @click="openMemberUser(member)"
              >
                <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-muted/30"><UserRound class="h-3.5 w-3.5" /></span>
                <span class="min-w-0 flex-1 truncate font-medium">{{ member }}</span>
                <Link2 class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
              </button>
            </div>
            <div v-else class="flex h-20 items-center justify-center rounded border text-sm text-muted-foreground">{{ t("nacos.accessNoMembers") }}</div>
          </section>
          <section v-if="advancedRolePermissions.length">
            <div class="mb-3">
              <h3 class="text-sm font-semibold">{{ t("nacos.accessAdvancedPermissions") }}</h3>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ t("nacos.accessAdvancedPermissionsHint") }}</p>
            </div>
            <div class="divide-y rounded border">
              <div v-for="permission in advancedRolePermissions" :key="`${permission.resourceRaw}:${permission.actionRaw}`" class="flex items-center gap-3 px-3 py-2.5 text-sm">
                <code class="min-w-0 flex-1 truncate">{{ permission.resourceRaw }}</code
                ><Badge variant="outline">{{ permission.actionRaw }}</Badge
                ><Button
                  size="sm"
                  variant="ghost"
                  class="h-7 w-7 p-0 text-destructive hover:text-destructive"
                  :disabled="!canRevokePermission"
                  :aria-label="t('nacos.accessRevokeRawPermission')"
                  @click="
                    pendingAdvancedPermission = permission;
                    advancedPermissionConfirmation = '';
                  "
                  ><Trash2 class="h-3.5 w-3.5"
                /></Button>
              </div>
            </div>
          </section>
        </div>
      </template>

      <div v-else-if="!loading" class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ t("nacos.accessSelectItem") }}</div>
    </main>
  </section>

  <Dialog :open="!!userDialog" @update:open="!$event && (userDialog = null)">
    <DialogContent class="max-h-[88vh] overflow-auto sm:max-w-lg">
      <DialogHeader
        ><DialogTitle>{{ t(`nacos.accessUserDialog.${userDialog}`) }}</DialogTitle
        ><DialogDescription>{{ t(`nacos.accessUserDialog.${userDialog}Hint`, { username: userForm.username }) }}</DialogDescription></DialogHeader
      >
      <div v-if="userDialog === 'create' || userDialog === 'password'" class="space-y-4">
        <div v-if="userDialog === 'create'" class="grid gap-1.5">
          <Label for="access-user-name">{{ t("nacos.username") }}</Label
          ><Input id="access-user-name" v-model="userForm.username" autocomplete="off" />
        </div>
        <div class="grid gap-1.5">
          <Label for="access-user-password">{{ t("nacos.password") }}</Label
          ><Input id="access-user-password" v-model="userForm.password" type="password" autocomplete="new-password" />
        </div>
      </div>
      <div v-if="userDialog === 'create' || userDialog === 'roles'" class="space-y-2">
        <Label>{{ t("nacos.accessAssociatedRoles") }}</Label>
        <div class="max-h-52 overflow-auto rounded border p-2">
          <label v-for="role in assignableRoles" :key="role.role" class="flex min-h-9 items-center gap-2 rounded px-2 text-sm hover:bg-muted/60"
            ><input
              type="checkbox"
              :checked="userForm.roles.includes(role.role)"
              :disabled="userDialog === 'roles' && (selectedUser?.roles.includes(role.role) ?? false) ? !canRemoveRole : !canAssignRole"
              @change="userForm.roles = toggle(userForm.roles, role.role, ($event.target as HTMLInputElement).checked)"
            /><Shield class="h-3.5 w-3.5 text-muted-foreground" /><span class="min-w-0 flex-1 truncate">{{ role.role }}</span
            ><span v-if="!role.complete" class="text-xs text-amber-600">{{ t("nacos.accessNeedsRepair") }}</span></label
          >
          <div v-if="!assignableRoles.length" class="p-3 text-center text-xs text-muted-foreground">{{ t("nacos.accessNoAssignableRoles") }}</div>
        </div>
      </div>
      <div v-if="userDialog === 'delete'" class="rounded border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{{ t("nacos.deleteUserDescription", { username: userForm.username }) }}</div>
      <div v-if="userDialog === 'delete'" class="grid gap-1.5">
        <Label for="access-delete-user-confirm">{{ t("nacos.accessDeleteUserConfirmationLabel") }}</Label>
        <p id="access-delete-user-confirm-hint" class="text-xs text-muted-foreground">
          {{ t("nacos.accessDeleteUserConfirmationHint") }} <code class="select-all rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{{ userForm.username }}</code>
        </p>
        <Input id="access-delete-user-confirm" v-model="userForm.confirmation" autocomplete="off" :placeholder="t('nacos.accessDeleteUserConfirmationPlaceholder')" aria-describedby="access-delete-user-confirm-hint" />
      </div>
      <div v-if="userDialog !== 'delete' && (userForm.roles.includes('ROLE_ADMIN') || (snapshot?.currentUsername === userForm.username && userDialog !== 'password'))" class="grid gap-1.5">
        <Label for="access-user-confirm">{{ t("nacos.accessTypeUsername", { value: userForm.username }) }}</Label
        ><Input id="access-user-confirm" v-model="userForm.confirmation" autocomplete="off" />
      </div>
      <p v-if="formError" class="text-sm text-destructive">{{ formError }}</p>
      <DialogFooter
        ><Button variant="outline" :disabled="saving" @click="userDialog = null">{{ t("nacos.cancel") }}</Button
        ><Button :variant="userDialog === 'delete' ? 'destructive' : 'default'" :disabled="saving || !userOperationWritable || (userDialog === 'delete' && !userDeleteConfirmed)" @click="submitUser"
          ><Loader2 v-if="saving" class="mr-2 h-4 w-4 animate-spin" />{{ userDialog === "delete" ? t("nacos.delete") : t("nacos.save") }}</Button
        ></DialogFooter
      >
    </DialogContent>
  </Dialog>

  <Dialog :open="!!roleDialog" @update:open="!$event && (roleDialog = null)">
    <DialogContent class="max-h-[90vh] overflow-auto sm:max-w-3xl">
      <DialogHeader
        ><DialogTitle>{{ t(`nacos.accessRoleDialog.${roleDialog}`) }}</DialogTitle
        ><DialogDescription>{{ t(`nacos.accessRoleDialog.${roleDialog}Hint`) }}</DialogDescription></DialogHeader
      >
      <template v-if="roleDialog !== 'delete'">
        <div class="space-y-5">
          <div class="grid gap-1.5">
            <Label for="access-role-name">{{ t("nacos.role") }}</Label
            ><Input id="access-role-name" v-model="roleForm.role" :disabled="roleDialog === 'edit'" placeholder="app_developer" />
          </div>
          <section>
            <div class="mb-2 flex items-end justify-between">
              <div>
                <Label>{{ t("nacos.accessMembers") }}</Label>
                <p class="mt-0.5 text-xs text-muted-foreground">
                  {{ t(roleDialog === "edit" && !selectedRole?.administrator ? "nacos.accessMembersOptionalHint" : "nacos.accessMembersRequiredHint") }}
                </p>
              </div>
              <Button size="sm" variant="outline" :disabled="!canCreateUser || !canAssignRole" @click="addNewUser"><Plus class="mr-1 h-3.5 w-3.5" />{{ t("nacos.accessInlineCreateUser") }}</Button>
            </div>
            <div class="max-h-44 overflow-auto rounded border p-2">
              <label v-for="user in users" :key="user.username" class="flex min-h-9 items-center gap-2 rounded px-2 text-sm hover:bg-muted/60"
                ><input
                  type="checkbox"
                  :checked="roleForm.members.includes(user.username)"
                  :disabled="roleDialog === 'edit' && roleMembers.includes(user.username) ? !canRemoveRole : !canAssignRole"
                  @change="roleForm.members = toggle(roleForm.members, user.username, ($event.target as HTMLInputElement).checked)"
                /><UserRound class="h-3.5 w-3.5 text-muted-foreground" />{{ user.username }}</label
              >
            </div>
            <div v-for="(user, index) in roleForm.newUsers" :key="index" class="mt-2 grid grid-cols-[1fr_1fr_32px] gap-2">
              <Input v-model="user.username" :placeholder="t('nacos.username')" /><Input v-model="user.password" type="password" :placeholder="t('nacos.password')" /><Button size="sm" variant="ghost" class="h-9 w-8 p-0" @click="roleForm.newUsers.splice(index, 1)"><X class="h-4 w-4" /></Button>
            </div>
          </section>
          <section v-if="selectedRole?.administrator && roleDialog === 'edit'" class="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
            <div class="flex gap-2"><LockKeyhole class="mt-0.5 h-4 w-4 shrink-0" />{{ t("nacos.accessAdminPermissionImmutable") }}</div>
          </section>
          <section v-else>
            <div class="mb-2">
              <div>
                <Label>{{ t("nacos.accessPermissionScope") }}</Label>
                <p class="mt-0.5 text-xs text-muted-foreground">{{ t("nacos.accessPermissionRequiredHint") }}</p>
              </div>
            </div>
            <div class="grid h-[min(28rem,45vh)] min-h-[17rem] grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,1.15fr)] gap-2 sm:gap-3">
              <div class="flex min-h-0 flex-col overflow-hidden rounded border">
                <div class="border-b bg-muted/30 px-3 py-2 text-sm font-medium">{{ t("nacos.accessUnassignedNamespaces") }}</div>
                <div class="border-b p-2">
                  <div class="relative">
                    <Search class="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" /><Input v-model="availableNamespaceSearch" class="h-8 pl-8 text-sm" :placeholder="t('nacos.accessSearchNamespaces')" :aria-label="t('nacos.accessSearchNamespaces')" />
                  </div>
                </div>
                <div class="min-h-0 flex-1 overflow-auto p-1.5">
                  <label v-for="namespace in availableNamespaces" :key="namespace.id" class="flex min-h-11 items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/60">
                    <input type="checkbox" :checked="selectedAvailableNamespaceIds.includes(namespace.id)" @change="selectedAvailableNamespaceIds = toggle(selectedAvailableNamespaceIds, namespace.id, ($event.target as HTMLInputElement).checked)" />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate font-medium" :title="namespace.name">{{ namespace.name }}</span>
                      <code v-if="namespace.name !== namespace.id" class="block break-all text-[10px] leading-4 text-muted-foreground" :title="namespace.id">{{ namespace.id }}</code>
                    </span>
                  </label>
                  <div v-if="!availableNamespaces.length" class="flex h-24 items-center justify-center px-3 text-center text-xs text-muted-foreground">{{ t("nacos.accessNoUnassignedNamespaces") }}</div>
                </div>
              </div>
              <div class="flex flex-col items-center justify-center gap-2">
                <Button size="sm" variant="outline" class="h-8 w-8 p-0" :disabled="!selectedAvailableNamespaceIds.length || !canGrantPermission" :aria-label="t('nacos.accessGrantNamespaces')" @click="moveNamespacesToGranted"><ChevronRight class="h-4 w-4" /></Button>
                <Button size="sm" variant="outline" class="h-8 w-8 p-0" :disabled="!selectedGrantedNamespaceIds.length || !canRevokePermission" :aria-label="t('nacos.accessRevokeNamespaces')" @click="removeGrantedNamespaces"><ChevronLeft class="h-4 w-4" /></Button>
              </div>
              <div class="flex min-h-0 flex-col overflow-hidden rounded border">
                <div class="border-b bg-muted/30 px-3 py-2 text-sm font-medium">{{ t("nacos.accessGrantedNamespaces") }}</div>
                <div class="border-b p-2">
                  <div class="relative">
                    <Search class="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" /><Input v-model="grantedNamespaceSearch" class="h-8 pl-8 text-sm" :placeholder="t('nacos.accessSearchNamespaces')" :aria-label="t('nacos.accessSearchNamespaces')" />
                  </div>
                </div>
                <div class="min-h-0 flex-1 overflow-auto p-1.5">
                  <div v-for="namespace in grantedNamespaces" :key="namespace.namespaceId" class="flex min-h-11 items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/60">
                    <input type="checkbox" :checked="selectedGrantedNamespaceIds.includes(namespace.namespaceId)" @change="selectedGrantedNamespaceIds = toggle(selectedGrantedNamespaceIds, namespace.namespaceId, ($event.target as HTMLInputElement).checked)" />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate font-medium" :title="namespace.name">{{ namespace.name }}</span>
                    </span>
                    <div class="flex shrink-0 items-center gap-2">
                      <label
                        v-for="action in ['r', 'w', 'rw'] as PermissionAction[]"
                        :key="action"
                        class="flex h-7 cursor-pointer items-center gap-1.5 rounded border px-2 text-xs transition-colors"
                        :class="namespace.action === action ? 'border-primary/40 bg-primary/5 font-medium text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted'"
                      >
                        <input
                          type="checkbox"
                          class="h-3.5 w-3.5 accent-primary"
                          :checked="namespace.action === action"
                          :disabled="!canGrantPermission || (roleDialog === 'edit' && managedRolePermissions.some((permission) => permission.parsedScope?.namespaceId === namespace.namespaceId) && !canRevokePermission)"
                          @change="setPermissionAction(namespace.namespaceId, action)"
                        />
                        {{ actionLabel(action) }}
                      </label>
                    </div>
                  </div>
                  <div v-if="!grantedNamespaces.length" class="flex h-24 items-center justify-center px-3 text-center text-xs text-muted-foreground">{{ t("nacos.accessNoGrantedNamespaces") }}</div>
                </div>
              </div>
            </div>
          </section>
          <div v-if="roleDialog === 'edit' && adminMembersChanged" class="grid gap-1.5">
            <Label for="access-role-confirm">{{ t("nacos.accessTypeUsername", { value: adminConfirmationTarget }) }}</Label
            ><Input id="access-role-confirm" v-model="roleForm.confirmation" />
          </div>
        </div>
      </template>
      <template v-else
        ><div class="rounded border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{{ t("nacos.accessDeleteRoleHint", { role: roleForm.role }) }}</div>
        <div class="grid gap-1.5">
          <Label for="access-delete-role-confirm">{{ t("nacos.accessDeleteRoleConfirmationLabel") }}</Label>
          <p id="access-delete-role-confirm-hint" class="text-xs text-muted-foreground">
            {{ t("nacos.accessDeleteRoleConfirmationHint") }} <code class="select-all rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{{ roleForm.role }}</code>
          </p>
          <Input id="access-delete-role-confirm" v-model="roleForm.confirmation" autocomplete="off" :placeholder="t('nacos.accessDeleteRoleConfirmationPlaceholder')" aria-describedby="access-delete-role-confirm-hint" /></div
      ></template>
      <p v-if="formError" class="text-sm text-destructive">{{ formError }}</p>
      <DialogFooter
        ><Button variant="outline" :disabled="saving" @click="roleDialog = null">{{ t("nacos.cancel") }}</Button
        ><Button :variant="roleDialog === 'delete' ? 'destructive' : 'default'" :disabled="saving || !roleOperationWritable || (roleDialog === 'delete' && !roleDeleteConfirmed)" @click="submitRole"
          ><Loader2 v-if="saving" class="mr-2 h-4 w-4 animate-spin" />{{ roleDialog === "delete" ? t("nacos.delete") : t("nacos.save") }}</Button
        ></DialogFooter
      >
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="operationOpen">
    <DialogContent class="sm:max-w-xl"
      ><DialogHeader
        ><DialogTitle>{{ t("nacos.accessOperationResult") }}</DialogTitle
        ><DialogDescription>{{ t(`nacos.accessOperationStatus.${operation?.status ?? "running"}`) }}</DialogDescription></DialogHeader
      >
      <div class="max-h-80 divide-y overflow-auto rounded border">
        <div v-for="step in operation?.steps" :key="step.id" class="flex items-start gap-3 px-3 py-2.5">
          <Check v-if="step.status === 'succeeded' || step.status === 'compensated'" class="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /><CircleAlert v-else-if="step.status === 'failed'" class="mt-0.5 h-4 w-4 shrink-0 text-destructive" /><Loader2
            v-else-if="step.status === 'running'"
            class="mt-0.5 h-4 w-4 shrink-0 animate-spin"
          />
          <div v-else class="mt-1 h-3 w-3 shrink-0 rounded-full border" />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium">{{ t(`nacos.accessStep.${step.action}`) }}</div>
            <div class="truncate text-xs text-muted-foreground">{{ step.target }}</div>
            <div v-if="step.message" class="mt-1 text-xs text-destructive">{{ step.message }}</div>
            <Input v-if="['failed', 'skipped'].includes(step.status) && step.needsPassword" v-model="retryPasswords[step.target]" type="password" class="mt-2 h-8" :placeholder="t('nacos.accessReenterPassword')" />
          </div>
        </div>
      </div>
      <DialogFooter
        ><Button v-if="operation?.canUndo" variant="outline" :disabled="saving" @click="undoOperation"><RotateCcw class="mr-1.5 h-3.5 w-3.5" />{{ t("nacos.accessUndoCreated") }}</Button
        ><Button v-if="operation?.canRetry" :disabled="saving" @click="retryOperation"><RefreshCw class="mr-1.5 h-3.5 w-3.5" />{{ t("nacos.accessRetryFailed") }}</Button
        ><Button v-else @click="operationOpen = false">{{ t("nacos.close") }}</Button></DialogFooter
      ></DialogContent
    >
  </Dialog>

  <Dialog :open="!!pendingAdvancedPermission" @update:open="!$event && (pendingAdvancedPermission = null)">
    <DialogContent class="sm:max-w-md"
      ><DialogHeader
        ><DialogTitle>{{ t("nacos.accessRevokeRawPermission") }}</DialogTitle
        ><DialogDescription>{{ t("nacos.accessRevokeRawPermissionHint") }}</DialogDescription></DialogHeader
      >
      <div class="rounded border bg-muted/30 p-3 text-sm">
        <code class="block break-all">{{ pendingAdvancedPermission?.resourceRaw }}</code>
        <div class="mt-2 text-xs text-muted-foreground">{{ pendingAdvancedPermission?.role }} · {{ pendingAdvancedPermission?.actionRaw }}</div>
      </div>
      <div class="grid gap-1.5">
        <Label for="access-raw-confirm">{{ t("nacos.accessTypeRole", { value: pendingAdvancedPermission?.role }) }}</Label
        ><Input id="access-raw-confirm" v-model="advancedPermissionConfirmation" />
      </div>
      <p v-if="formError" class="text-sm text-destructive">{{ formError }}</p>
      <DialogFooter
        ><Button variant="outline" :disabled="saving" @click="pendingAdvancedPermission = null">{{ t("nacos.cancel") }}</Button
        ><Button variant="destructive" :disabled="saving || !canRevokePermission" @click="revokeAdvancedPermission"><Loader2 v-if="saving" class="mr-2 h-4 w-4 animate-spin" />{{ t("nacos.accessRevokeRawPermission") }}</Button></DialogFooter
      ></DialogContent
    >
  </Dialog>
</template>
