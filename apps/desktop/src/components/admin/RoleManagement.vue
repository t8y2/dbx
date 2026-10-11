<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Loader2, Pencil, Plus, RefreshCcw, ShieldCheck, Trash2, UsersRound } from "@lucide/vue";
import GroupedConnectionScopeTree from "@/components/settings/GroupedConnectionScopeTree.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/composables/useToast";
import { PERMISSION_KEYS, type PermissionKey } from "@/lib/auth/permissions";
import { adminErrorCode, createAdminRole, deleteAdminRole, listAdminRoles, updateAdminRole, type AdminRole, type AdminScope } from "@/lib/admin/adminApi";
import { formatError } from "@/lib/backend/errorUtils";

const { t } = useI18n();
const { toast } = useToast();
const roles = ref<AdminRole[]>([]);
const loading = ref(false);
const saving = ref(false);
const formOpen = ref(false);
const deleteOpen = ref(false);
const editing = ref<AdminRole | null>(null);
const deleting = ref<AdminRole | null>(null);
const name = ref("");
const description = ref("");
const permissions = ref<PermissionKey[]>([]);
const scope = ref<AdminScope>({ allowed_group_ids: [], allowed_connection_ids: [] });
const formValid = computed(() => name.value.trim().length > 0);

async function loadRoles() {
  loading.value = true;
  try {
    roles.value = await listAdminRoles();
  } catch (error) {
    notifyError(error);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  name.value = "";
  description.value = "";
  permissions.value = [];
  scope.value = { allowed_group_ids: [], allowed_connection_ids: [] };
  formOpen.value = true;
}

function openEdit(role: AdminRole) {
  editing.value = role;
  name.value = role.name;
  description.value = role.description ?? "";
  permissions.value = [...role.permissions];
  scope.value = {
    allowed_group_ids: [...role.scope.allowed_group_ids],
    allowed_connection_ids: [...role.scope.allowed_connection_ids],
  };
  formOpen.value = true;
}

function togglePermission(key: PermissionKey) {
  permissions.value = permissions.value.includes(key) ? permissions.value.filter((item) => item !== key) : [...permissions.value, key];
}

async function submitForm() {
  if (!formValid.value) return;
  saving.value = true;
  try {
    const input = {
      name: name.value.trim(),
      description: description.value.trim(),
      permissions: permissions.value,
      scope: scope.value,
    };
    if (editing.value) await updateAdminRole(editing.value.id, input);
    else await createAdminRole(input);
    formOpen.value = false;
    await loadRoles();
    toast(t(editing.value ? "accessControl.roles.updated" : "accessControl.roles.created"));
  } catch (error) {
    notifyError(error);
  } finally {
    saving.value = false;
  }
}

function requestDelete(role: AdminRole) {
  deleting.value = role;
  deleteOpen.value = true;
}

async function confirmDelete() {
  if (!deleting.value) return;
  saving.value = true;
  try {
    await deleteAdminRole(deleting.value.id);
    deleteOpen.value = false;
    await loadRoles();
    toast(t("accessControl.roles.deleted"));
  } catch (error) {
    notifyError(error);
  } finally {
    saving.value = false;
  }
}

function notifyError(error: unknown) {
  const code = adminErrorCode(error);
  if (code === "in_use") toast(t("accessControl.roles.inUse"), 5000);
  else if (code === "already_exists") toast(t("accessControl.errors.already_exists"), 5000);
  else toast(t("accessControl.errors.requestFailed", { message: formatError(error) }), 5000);
}

onMounted(loadRoles);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <div class="text-sm font-semibold">{{ t("accessControl.roles.title") }}</div>
      <Badge variant="outline" class="rounded-md">{{ roles.length }}</Badge>
      <div class="ml-auto flex gap-2">
        <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="loading" @click="loadRoles">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCcw v-else class="h-3.5 w-3.5" />
          {{ t("accessControl.refresh") }}
        </Button>
        <Button size="sm" class="h-8 gap-1.5" @click="openCreate"><Plus class="h-3.5 w-3.5" />{{ t("accessControl.roles.new") }}</Button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-5">
      <div class="mx-auto grid max-w-6xl gap-3 md:grid-cols-2 xl:grid-cols-3">
        <article v-for="role in roles" :key="role.id" class="group flex min-h-40 flex-col rounded-lg border bg-card p-4 transition hover:border-primary/40 hover:shadow-sm">
          <div class="flex items-start gap-3">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><ShieldCheck class="h-4 w-4" /></div>
            <div class="min-w-0 flex-1">
              <h3 class="truncate text-sm font-semibold">{{ role.name }}</h3>
              <p class="mt-1 line-clamp-2 text-xs text-muted-foreground">{{ role.description || t("accessControl.roles.noDescription") }}</p>
            </div>
          </div>
          <div class="mt-3 flex flex-wrap gap-1">
            <Badge v-for="permission in role.permissions.slice(0, 3)" :key="permission" variant="secondary" class="h-5 rounded px-1.5 text-[9px]">{{ t(`accessControl.permissions.${permission}`) }}</Badge>
            <Badge v-if="role.permissions.length > 3" variant="outline" class="h-5 rounded px-1.5 text-[9px]">+{{ role.permissions.length - 3 }}</Badge>
          </div>
          <div class="mt-auto flex items-center gap-2 border-t pt-3">
            <Badge variant="secondary" class="gap-1 rounded-md"><UsersRound class="h-3 w-3" />{{ t("accessControl.roles.userCount", { count: role.user_count }) }}</Badge>
            <div class="ml-auto flex gap-1">
              <Button variant="ghost" size="icon-sm" :aria-label="t('accessControl.edit')" @click="openEdit(role)"><Pencil class="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon-sm" class="text-destructive hover:text-destructive" :aria-label="t('accessControl.delete')" @click="requestDelete(role)"><Trash2 class="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        </article>
      </div>
      <div v-if="!loading && roles.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ t("accessControl.roles.empty") }}</div>
    </div>

    <Dialog v-model:open="formOpen">
      <DialogContent class="max-h-[90vh] max-w-4xl overflow-hidden p-0">
        <DialogHeader class="border-b px-6 py-4"
          ><DialogTitle>{{ t(editing ? "accessControl.roles.editTitle" : "accessControl.roles.new") }}</DialogTitle></DialogHeader
        >
        <div class="grid min-h-0 gap-5 overflow-auto px-6 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
          <div class="space-y-5">
            <section class="grid gap-4 rounded-lg border p-4">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t("accessControl.roles.basicInfo") }}</h3>
              <label class="grid gap-1.5 text-xs"
                ><span class="font-medium">{{ t("accessControl.roles.name") }}</span
                ><Input v-model="name"
              /></label>
              <label class="grid gap-1.5 text-xs"
                ><span class="font-medium">{{ t("accessControl.roles.description") }}</span
                ><textarea v-model="description" rows="3" class="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" />
              </label>
            </section>
            <section class="rounded-lg border p-4">
              <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t("accessControl.roles.functionalPermissions") }}</h3>
              <p class="mb-3 text-xs text-muted-foreground">{{ t("accessControl.roles.permissionsHint") }}</p>
              <div class="grid gap-2 sm:grid-cols-2">
                <button
                  v-for="key in PERMISSION_KEYS"
                  :key="key"
                  type="button"
                  role="checkbox"
                  :aria-checked="permissions.includes(key)"
                  class="flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs hover:bg-accent"
                  :class="permissions.includes(key) ? 'border-primary bg-primary/5' : ''"
                  @click="togglePermission(key)"
                >
                  <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border" :class="permissions.includes(key) ? 'border-primary bg-primary text-primary-foreground' : 'border-border'"><Check v-if="permissions.includes(key)" class="h-3 w-3" /></span>
                  <span>{{ t(`accessControl.permissions.${key}`) }}</span>
                </button>
              </div>
            </section>
          </div>
          <GroupedConnectionScopeTree v-model="scope" />
        </div>
        <DialogFooter class="border-t px-6 py-4">
          <Button variant="outline" @click="formOpen = false">{{ t("accessControl.cancel") }}</Button>
          <Button :disabled="!formValid || saving" @click="submitForm"><Loader2 v-if="saving" class="mr-1.5 h-4 w-4 animate-spin" />{{ t(editing ? "accessControl.saveChanges" : "accessControl.create") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="deleteOpen">
      <DialogContent class="max-w-sm">
        <DialogHeader
          ><DialogTitle>{{ t("accessControl.roles.deleteTitle") }}</DialogTitle></DialogHeader
        >
        <p class="text-sm text-muted-foreground">{{ t("accessControl.roles.deleteConfirm", { name: deleting?.name ?? "" }) }}</p>
        <DialogFooter
          ><Button variant="outline" @click="deleteOpen = false">{{ t("accessControl.cancel") }}</Button
          ><Button variant="destructive" :disabled="saving" @click="confirmDelete">{{ t("accessControl.delete") }}</Button></DialogFooter
        >
      </DialogContent>
    </Dialog>
  </div>
</template>
