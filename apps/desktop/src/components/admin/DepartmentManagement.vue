<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Building2, Loader2, Pencil, Plus, RefreshCcw, Trash2, UsersRound } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/composables/useToast";
import { formatError } from "@/lib/backend/errorUtils";
import { adminErrorCode, createAdminDepartment, deleteAdminDepartment, listAdminDepartments, updateAdminDepartment, type AdminDepartment } from "@/lib/admin/adminApi";

const { t } = useI18n();
const { toast } = useToast();
const departments = ref<AdminDepartment[]>([]);
const loading = ref(false);
const saving = ref(false);
const formOpen = ref(false);
const deleteOpen = ref(false);
const editing = ref<AdminDepartment | null>(null);
const deleting = ref<AdminDepartment | null>(null);
const name = ref("");
const sort = ref("0");

async function loadDepartments() {
  loading.value = true;
  try {
    departments.value = await listAdminDepartments();
  } catch (error) {
    notifyError(error);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  name.value = "";
  sort.value = "0";
  formOpen.value = true;
}

function openEdit(department: AdminDepartment) {
  editing.value = department;
  name.value = department.name;
  sort.value = String(department.sort);
  formOpen.value = true;
}

async function submitForm() {
  if (!name.value.trim()) return;
  saving.value = true;
  try {
    if (editing.value) await updateAdminDepartment(editing.value.id, { name: name.value.trim(), sort: Number(sort.value) || 0 });
    else await createAdminDepartment({ name: name.value.trim(), sort: Number(sort.value) || 0 });
    formOpen.value = false;
    await loadDepartments();
    toast(t(editing.value ? "accessControl.departments.updated" : "accessControl.departments.created"));
  } catch (error) {
    notifyError(error);
  } finally {
    saving.value = false;
  }
}

async function confirmDelete() {
  if (!deleting.value) return;
  saving.value = true;
  try {
    await deleteAdminDepartment(deleting.value.id);
    deleteOpen.value = false;
    await loadDepartments();
    toast(t("accessControl.departments.deleted"));
  } catch (error) {
    notifyError(error);
  } finally {
    saving.value = false;
  }
}

function requestDelete(department: AdminDepartment) {
  deleting.value = department;
  deleteOpen.value = true;
}

function notifyError(error: unknown) {
  const code = adminErrorCode(error);
  if (code === "in_use") toast(t("accessControl.departments.inUse"), 5000);
  else if (code === "already_exists") toast(t("accessControl.errors.already_exists"), 5000);
  else toast(t("accessControl.errors.requestFailed", { message: formatError(error) }), 5000);
}

onMounted(loadDepartments);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <div class="text-sm font-semibold">{{ t("accessControl.departments.title") }}</div>
      <Badge variant="outline" class="rounded-md">{{ departments.length }}</Badge>
      <div class="ml-auto flex gap-2">
        <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="loading" @click="loadDepartments"><Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" /><RefreshCcw v-else class="h-3.5 w-3.5" />{{ t("accessControl.refresh") }}</Button>
        <Button size="sm" class="h-8 gap-1.5" @click="openCreate"><Plus class="h-3.5 w-3.5" />{{ t("accessControl.departments.new") }}</Button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-5">
      <div class="mx-auto grid max-w-5xl gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <article v-for="department in departments" :key="department.id" class="group rounded-lg border bg-card p-4 transition hover:border-primary/40 hover:shadow-sm">
          <div class="flex items-start gap-3">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Building2 class="h-4 w-4" /></div>
            <div class="min-w-0 flex-1">
              <h3 class="truncate text-sm font-semibold">{{ department.name }}</h3>
              <p class="mt-1 text-[11px] text-muted-foreground">{{ t("accessControl.departments.sort") }} · {{ department.sort }}</p>
            </div>
          </div>
          <div class="mt-4 flex items-center gap-2 border-t pt-3">
            <Badge variant="secondary" class="gap-1 rounded-md"><UsersRound class="h-3 w-3" />{{ t("accessControl.departments.userCount", { count: department.user_count }) }}</Badge>
            <div class="ml-auto flex gap-1">
              <Button variant="ghost" size="icon-sm" :aria-label="t('accessControl.edit')" @click="openEdit(department)"><Pencil class="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon-sm" class="text-destructive hover:text-destructive" :aria-label="t('accessControl.delete')" @click="requestDelete(department)"><Trash2 class="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        </article>
      </div>
      <div v-if="!loading && departments.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ t("accessControl.departments.empty") }}</div>
    </div>

    <Dialog v-model:open="formOpen"
      ><DialogContent class="max-w-md"
        ><DialogHeader
          ><DialogTitle>{{ t(editing ? "accessControl.departments.editTitle" : "accessControl.departments.new") }}</DialogTitle></DialogHeader
        >
        <div class="grid gap-4">
          <label class="grid gap-1.5 text-xs"
            ><span class="font-medium">{{ t("accessControl.departments.name") }}</span
            ><Input v-model="name" /></label
          ><label class="grid gap-1.5 text-xs"
            ><span class="font-medium">{{ t("accessControl.departments.sort") }}</span
            ><Input v-model="sort" type="number"
          /></label>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="formOpen = false">{{ t("accessControl.cancel") }}</Button
          ><Button :disabled="!name.trim() || saving" @click="submitForm">{{ t(editing ? "accessControl.saveChanges" : "accessControl.create") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
    <Dialog v-model:open="deleteOpen"
      ><DialogContent class="max-w-sm"
        ><DialogHeader
          ><DialogTitle>{{ t("accessControl.departments.deleteTitle") }}</DialogTitle></DialogHeader
        >
        <p class="text-sm text-muted-foreground">{{ t("accessControl.departments.deleteConfirm", { name: deleting?.name ?? "" }) }}</p>
        <DialogFooter
          ><Button variant="outline" @click="deleteOpen = false">{{ t("accessControl.cancel") }}</Button
          ><Button variant="destructive" :disabled="saving" @click="confirmDelete">{{ t("accessControl.delete") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
  </div>
</template>
