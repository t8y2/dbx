<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, KeyRound, Loader2, Plus, RefreshCcw, Search, Trash2, UserRound } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/composables/useToast";
import { formatError } from "@/lib/backend/errorUtils";
import { adminErrorCode, createAdminUser, deleteAdminUser, listAdminDepartments, listAdminRoles, listAdminUsers, resetAdminUserPassword, updateAdminUser, type AdminDepartment, type AdminRole, type AdminUser } from "@/lib/admin/adminApi";

const { t } = useI18n();
const { toast } = useToast();
const NONE = "__none__";
const users = ref<AdminUser[]>([]);
const departments = ref<AdminDepartment[]>([]);
const roles = ref<AdminRole[]>([]);
const selectedUserId = ref<number | null>(null);
const search = ref("");
const loading = ref(false);
const saving = ref(false);

const createOpen = ref(false);
const resetOpen = ref(false);
const deleteOpen = ref(false);
const createUsername = ref("");
const createPassword = ref("");
const createDisplayName = ref("");
const createDepartmentId = ref(NONE);
const createRoleIds = ref<number[]>([]);
const createIsAdmin = ref(false);
const editDisplayName = ref("");
const editDepartmentId = ref(NONE);
const editRoleIds = ref<number[]>([]);
const editStatus = ref("1");
const editIsAdmin = ref(false);
const resetPassword = ref("");

const selectedUser = computed(() => users.value.find((user) => user.id === selectedUserId.value) ?? null);
const filteredUsers = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  if (!query) return users.value;
  return users.value.filter((user) => [user.username, user.display_name, user.department_name, ...user.roles.map((role) => role.name)].some((value) => value?.toLocaleLowerCase().includes(query)));
});
const usernameValid = computed(() => /^[a-z0-9_.-]{3,64}$/.test(createUsername.value));
const createValid = computed(() => usernameValid.value && createPassword.value.length >= 6);

watch(createUsername, (value) => {
  const normalized = value.toLocaleLowerCase();
  if (normalized !== value) createUsername.value = normalized;
});

watch(
  selectedUser,
  (user) => {
    if (!user) return;
    editDisplayName.value = user.display_name ?? "";
    editDepartmentId.value = user.department_id === null ? NONE : String(user.department_id);
    editRoleIds.value = user.roles.map((role) => role.id);
    editStatus.value = String(user.status);
    editIsAdmin.value = user.is_admin;
  },
  { immediate: true },
);

async function loadData() {
  loading.value = true;
  try {
    const [nextUsers, nextDepartments, nextRoles] = await Promise.all([listAdminUsers(), listAdminDepartments(), listAdminRoles()]);
    users.value = nextUsers;
    departments.value = nextDepartments;
    roles.value = nextRoles;
    if (!selectedUser.value) selectedUserId.value = nextUsers[0]?.id ?? null;
  } catch (error) {
    notifyError(error);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  createUsername.value = "";
  createPassword.value = "";
  createDisplayName.value = "";
  createDepartmentId.value = NONE;
  createRoleIds.value = [];
  createIsAdmin.value = false;
  createOpen.value = true;
}

function toggleRole(target: number[], id: number): number[] {
  return target.includes(id) ? target.filter((roleId) => roleId !== id) : [...target, id];
}

async function submitCreate() {
  if (!createValid.value) return;
  saving.value = true;
  try {
    const created = await createAdminUser({
      username: createUsername.value,
      password: createPassword.value,
      ...(createDisplayName.value.trim() ? { display_name: createDisplayName.value.trim() } : {}),
      ...(createDepartmentId.value !== NONE ? { department_id: Number(createDepartmentId.value) } : {}),
      role_ids: createRoleIds.value,
      is_admin: createIsAdmin.value,
    });
    createOpen.value = false;
    await loadData();
    selectedUserId.value = created.id;
    toast(t("accessControl.users.created"));
  } catch (error) {
    notifyError(error);
  } finally {
    saving.value = false;
  }
}

async function saveUser() {
  const user = selectedUser.value;
  if (!user) return;
  saving.value = true;
  try {
    await updateAdminUser(user.id, {
      display_name: editDisplayName.value.trim(),
      department_id: editDepartmentId.value === NONE ? null : Number(editDepartmentId.value),
      role_ids: editRoleIds.value,
      status: Number(editStatus.value),
      is_admin: editIsAdmin.value,
    });
    await loadData();
    toast(t("accessControl.users.updated"));
  } catch (error) {
    notifyError(error);
  } finally {
    saving.value = false;
  }
}

async function submitResetPassword() {
  if (!selectedUser.value || resetPassword.value.length < 6) return;
  saving.value = true;
  try {
    await resetAdminUserPassword(selectedUser.value.id, resetPassword.value);
    resetOpen.value = false;
    resetPassword.value = "";
    toast(t("accessControl.users.passwordReset"));
  } catch (error) {
    notifyError(error);
  } finally {
    saving.value = false;
  }
}

async function confirmDelete() {
  if (!selectedUser.value) return;
  saving.value = true;
  try {
    await deleteAdminUser(selectedUser.value.id);
    deleteOpen.value = false;
    selectedUserId.value = null;
    await loadData();
    toast(t("accessControl.users.deleted"));
  } catch (error) {
    notifyError(error);
  } finally {
    saving.value = false;
  }
}

function notifyError(error: unknown) {
  const code = adminErrorCode(error);
  const known = ["already_exists", "self_forbidden", "weak_password", "invalid_username"];
  toast(code && known.includes(code) ? t(`accessControl.errors.${code}`) : t("accessControl.errors.requestFailed", { message: formatError(error) }), 5000);
}

onMounted(loadData);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <div class="text-sm font-semibold">{{ t("accessControl.users.title") }}</div>
      <Badge variant="outline" class="rounded-md">{{ users.length }}</Badge>
      <div class="ml-auto flex gap-2">
        <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="loading" @click="loadData"> <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" /><RefreshCcw v-else class="h-3.5 w-3.5" />{{ t("accessControl.refresh") }} </Button>
        <Button size="sm" class="h-8 gap-1.5" @click="openCreate"><Plus class="h-3.5 w-3.5" />{{ t("accessControl.users.new") }}</Button>
      </div>
    </div>

    <div class="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
      <aside class="flex min-h-0 flex-col border-r bg-muted/10">
        <div class="border-b p-2">
          <div class="relative"><Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input v-model="search" class="h-8 pl-8 text-xs" :placeholder="t('accessControl.users.search')" /></div>
        </div>
        <div class="min-h-0 flex-1 overflow-auto p-1.5">
          <button v-for="user in filteredUsers" :key="user.id" type="button" class="mb-1 w-full rounded-md border border-transparent p-2 text-left transition hover:bg-accent" :class="selectedUserId === user.id ? 'border-primary/50 bg-primary/10' : ''" @click="selectedUserId = user.id">
            <div class="flex items-center gap-2">
              <UserRound class="h-4 w-4 shrink-0" />
              <span class="min-w-0 flex-1 truncate text-xs font-semibold">{{ user.display_name || user.username }}</span>
              <span class="h-2 w-2 shrink-0 rounded-full" :class="user.status === 1 ? 'bg-emerald-500' : 'bg-muted-foreground/40'" />
            </div>
            <div class="mt-1 truncate pl-6 font-mono text-[10px] text-muted-foreground">@{{ user.username }} · {{ user.department_name || t("accessControl.users.noDepartment") }}</div>
            <div v-if="user.is_admin || user.roles.length" class="mt-1.5 flex flex-wrap gap-1 pl-6">
              <Badge v-if="user.is_admin" class="h-4 px-1 text-[9px]">{{ t("accessControl.users.admin") }}</Badge>
              <Badge v-for="role in user.roles" :key="role.id" variant="secondary" class="h-4 px-1 text-[9px]">{{ role.name }}</Badge>
            </div>
          </button>
          <div v-if="!loading && filteredUsers.length === 0" class="py-10 text-center text-xs text-muted-foreground">{{ t("accessControl.empty") }}</div>
        </div>
      </aside>

      <main v-if="selectedUser" class="min-h-0 overflow-auto p-5">
        <div class="mx-auto max-w-3xl space-y-5">
          <div class="flex items-start gap-3">
            <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary"><UserRound class="h-5 w-5" /></div>
            <div class="min-w-0 flex-1">
              <h2 class="truncate text-base font-semibold">{{ selectedUser.display_name || selectedUser.username }}</h2>
              <p class="font-mono text-xs text-muted-foreground">@{{ selectedUser.username }}</p>
            </div>
            <Button variant="outline" size="sm" class="gap-1.5" @click="resetOpen = true"><KeyRound class="h-3.5 w-3.5" />{{ t("accessControl.users.resetPassword") }}</Button>
            <Button variant="destructive" size="sm" class="gap-1.5" @click="deleteOpen = true"><Trash2 class="h-3.5 w-3.5" />{{ t("accessControl.delete") }}</Button>
          </div>

          <section class="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
            <label class="grid gap-1.5 text-xs"
              ><span class="font-medium">{{ t("accessControl.users.displayName") }}</span
              ><Input v-model="editDisplayName"
            /></label>
            <label class="grid gap-1.5 text-xs"
              ><span class="font-medium">{{ t("accessControl.users.department") }}</span
              ><Select v-model="editDepartmentId"
                ><SelectTrigger><SelectValue /></SelectTrigger
                ><SelectContent
                  ><SelectItem :value="NONE">{{ t("accessControl.users.noDepartment") }}</SelectItem
                  ><SelectItem v-for="department in departments" :key="department.id" :value="String(department.id)">{{ department.name }}</SelectItem></SelectContent
                ></Select
              ></label
            >
            <label class="grid gap-1.5 text-xs"
              ><span class="font-medium">{{ t("accessControl.users.status") }}</span
              ><Select v-model="editStatus"
                ><SelectTrigger><SelectValue /></SelectTrigger
                ><SelectContent
                  ><SelectItem value="1">{{ t("accessControl.users.active") }}</SelectItem
                  ><SelectItem value="0">{{ t("accessControl.users.disabled") }}</SelectItem></SelectContent
                ></Select
              ></label
            >
            <label class="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs"
              ><span
                ><span class="block font-medium">{{ t("accessControl.users.admin") }}</span
                ><span class="text-[11px] text-muted-foreground">{{ t("accessControl.users.adminHint") }}</span></span
              ><Switch v-model="editIsAdmin"
            /></label>
            <div class="grid gap-2 sm:col-span-2">
              <span class="text-xs font-medium">{{ t("accessControl.users.roles") }}</span>
              <div class="grid gap-2 sm:grid-cols-2">
                <button
                  v-for="role in roles"
                  :key="role.id"
                  type="button"
                  class="flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs hover:bg-accent"
                  :class="editRoleIds.includes(role.id) ? 'border-primary bg-primary/5' : ''"
                  @click="editRoleIds = toggleRole(editRoleIds, role.id)"
                >
                  <span class="flex h-4 w-4 items-center justify-center rounded border" :class="editRoleIds.includes(role.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-border'"><Check v-if="editRoleIds.includes(role.id)" class="h-3 w-3" /></span
                  ><span class="truncate">{{ role.name }}</span>
                </button>
              </div>
            </div>
          </section>
          <div class="flex justify-end">
            <Button :disabled="saving" @click="saveUser"><Loader2 v-if="saving" class="mr-1.5 h-4 w-4 animate-spin" />{{ t("accessControl.saveChanges") }}</Button>
          </div>
        </div>
      </main>
      <main v-else class="flex items-center justify-center text-sm text-muted-foreground">{{ t("accessControl.users.select") }}</main>
    </div>

    <Dialog v-model:open="createOpen"
      ><DialogContent class="max-w-2xl"
        ><DialogHeader
          ><DialogTitle>{{ t("accessControl.users.new") }}</DialogTitle></DialogHeader
        >
        <div class="grid max-h-[70vh] gap-4 overflow-auto pr-1 sm:grid-cols-2">
          <label class="grid gap-1.5 text-xs"
            ><span class="font-medium">{{ t("accessControl.users.username") }}</span
            ><Input v-model="createUsername" autocomplete="off" /><span v-if="createUsername && !usernameValid" class="text-[11px] text-destructive">{{ t("accessControl.users.usernameHint") }}</span></label
          >
          <label class="grid gap-1.5 text-xs"
            ><span class="font-medium">{{ t("accessControl.users.password") }}</span
            ><PasswordInput v-model="createPassword" autocomplete="new-password" /><span v-if="createPassword && createPassword.length < 6" class="text-[11px] text-destructive">{{ t("accessControl.users.passwordHint") }}</span></label
          >
          <label class="grid gap-1.5 text-xs"
            ><span class="font-medium">{{ t("accessControl.users.displayName") }}</span
            ><Input v-model="createDisplayName"
          /></label>
          <label class="grid gap-1.5 text-xs"
            ><span class="font-medium">{{ t("accessControl.users.department") }}</span
            ><Select v-model="createDepartmentId"
              ><SelectTrigger><SelectValue /></SelectTrigger
              ><SelectContent
                ><SelectItem :value="NONE">{{ t("accessControl.users.noDepartment") }}</SelectItem
                ><SelectItem v-for="department in departments" :key="department.id" :value="String(department.id)">{{ department.name }}</SelectItem></SelectContent
              ></Select
            ></label
          >
          <div class="grid gap-2 sm:col-span-2">
            <span class="text-xs font-medium">{{ t("accessControl.users.roles") }}</span>
            <div class="grid gap-2 sm:grid-cols-2">
              <button
                v-for="role in roles"
                :key="role.id"
                type="button"
                class="flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs hover:bg-accent"
                :class="createRoleIds.includes(role.id) ? 'border-primary bg-primary/5' : ''"
                @click="createRoleIds = toggleRole(createRoleIds, role.id)"
              >
                <span class="flex h-4 w-4 items-center justify-center rounded border" :class="createRoleIds.includes(role.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-border'"><Check v-if="createRoleIds.includes(role.id)" class="h-3 w-3" /></span>{{ role.name }}
              </button>
            </div>
          </div>
          <label class="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs sm:col-span-2"
            ><span
              ><span class="block font-medium">{{ t("accessControl.users.admin") }}</span
              ><span class="text-[11px] text-muted-foreground">{{ t("accessControl.users.adminHint") }}</span></span
            ><Switch v-model="createIsAdmin"
          /></label>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="createOpen = false">{{ t("accessControl.cancel") }}</Button
          ><Button :disabled="!createValid || saving" @click="submitCreate">{{ t("accessControl.create") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >

    <Dialog v-model:open="resetOpen"
      ><DialogContent class="max-w-sm"
        ><DialogHeader
          ><DialogTitle>{{ t("accessControl.users.resetPassword") }}</DialogTitle></DialogHeader
        ><label class="grid gap-2 text-xs"
          ><span>{{ t("accessControl.users.newPassword") }}</span
          ><PasswordInput v-model="resetPassword" autocomplete="new-password" /></label
        ><DialogFooter
          ><Button variant="outline" @click="resetOpen = false">{{ t("accessControl.cancel") }}</Button
          ><Button :disabled="resetPassword.length < 6 || saving" @click="submitResetPassword">{{ t("accessControl.confirm") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
    <Dialog v-model:open="deleteOpen"
      ><DialogContent class="max-w-sm"
        ><DialogHeader
          ><DialogTitle>{{ t("accessControl.users.deleteTitle") }}</DialogTitle></DialogHeader
        >
        <p class="text-sm text-muted-foreground">{{ t("accessControl.users.deleteConfirm", { name: selectedUser?.username ?? "" }) }}</p>
        <DialogFooter
          ><Button variant="outline" @click="deleteOpen = false">{{ t("accessControl.cancel") }}</Button
          ><Button variant="destructive" :disabled="saving" @click="confirmDelete">{{ t("accessControl.delete") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
  </div>
</template>
