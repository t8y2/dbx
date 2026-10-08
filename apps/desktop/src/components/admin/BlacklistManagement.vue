<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Ban, Loader2, Plus, RefreshCcw, Trash2 } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/composables/useToast";
import { adminErrorCode, createBlacklistEntry, deleteBlacklistEntry, listBlacklistEntries, type BlacklistEntry, type BlacklistKind } from "@/lib/admin/adminApi";
import { formatError } from "@/lib/backend/errorUtils";

const { t } = useI18n();
const { toast } = useToast();
const entries = ref<BlacklistEntry[]>([]);
const loading = ref(false);
const saving = ref(false);
const formOpen = ref(false);
const deleteOpen = ref(false);
const deleting = ref<BlacklistEntry | null>(null);
const kind = ref<BlacklistKind>("ip");
const value = ref("");
const reason = ref("");

async function loadEntries() {
  loading.value = true;
  try {
    entries.value = await listBlacklistEntries();
  } catch (error) {
    notifyError(error);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  kind.value = "ip";
  value.value = "";
  reason.value = "";
  formOpen.value = true;
}

async function submitCreate() {
  if (!value.value.trim()) return;
  saving.value = true;
  try {
    await createBlacklistEntry({
      kind: kind.value,
      value: value.value.trim(),
      ...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
    });
    formOpen.value = false;
    await loadEntries();
    toast(t("accessControl.blacklist.created"));
  } catch (error) {
    notifyError(error);
  } finally {
    saving.value = false;
  }
}

function requestDelete(entry: BlacklistEntry) {
  deleting.value = entry;
  deleteOpen.value = true;
}

async function confirmDelete() {
  if (!deleting.value) return;
  saving.value = true;
  try {
    await deleteBlacklistEntry(deleting.value.id);
    deleteOpen.value = false;
    await loadEntries();
    toast(t("accessControl.blacklist.deleted"));
  } catch (error) {
    notifyError(error);
  } finally {
    saving.value = false;
  }
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function notifyError(error: unknown) {
  const code = adminErrorCode(error);
  if (code === "already_exists") toast(t("accessControl.errors.already_exists"), 5000);
  else toast(t("accessControl.errors.requestFailed", { message: formatError(error) }), 5000);
}

onMounted(loadEntries);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <div class="text-sm font-semibold">{{ t("accessControl.blacklist.title") }}</div>
      <Badge variant="outline" class="rounded-md">{{ entries.length }}</Badge>
      <div class="ml-auto flex gap-2">
        <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="loading" @click="loadEntries"><Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" /><RefreshCcw v-else class="h-3.5 w-3.5" />{{ t("accessControl.refresh") }}</Button>
        <Button size="sm" class="h-8 gap-1.5" @click="openCreate"><Plus class="h-3.5 w-3.5" />{{ t("accessControl.blacklist.add") }}</Button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-5">
      <div class="mx-auto max-w-6xl overflow-hidden rounded-lg border bg-card">
        <div class="grid grid-cols-[110px_minmax(140px,1fr)_minmax(160px,1.5fr)_130px_180px_44px] gap-3 border-b bg-muted/35 px-4 py-2 text-[11px] font-semibold text-muted-foreground">
          <span>{{ t("accessControl.blacklist.kind") }}</span
          ><span>{{ t("accessControl.blacklist.value") }}</span
          ><span>{{ t("accessControl.blacklist.reason") }}</span
          ><span>{{ t("accessControl.blacklist.createdBy") }}</span
          ><span>{{ t("accessControl.blacklist.createdAt") }}</span
          ><span />
        </div>
        <div v-for="entry in entries" :key="entry.id" class="grid grid-cols-[110px_minmax(140px,1fr)_minmax(160px,1.5fr)_130px_180px_44px] items-center gap-3 border-b px-4 py-3 text-xs last:border-b-0 hover:bg-muted/20">
          <Badge :variant="entry.kind === 'ip' ? 'default' : 'secondary'" class="w-fit gap-1 rounded-md"><Ban class="h-3 w-3" />{{ t(`accessControl.blacklist.kinds.${entry.kind}`) }}</Badge>
          <span class="truncate font-mono" :title="entry.value">{{ entry.value }}</span>
          <span class="truncate text-muted-foreground" :title="entry.reason ?? ''">{{ entry.reason || t("accessControl.blacklist.noReason") }}</span>
          <span class="truncate">{{ entry.created_by ?? "-" }}</span>
          <span class="text-muted-foreground">{{ formatDate(entry.created_at) }}</span>
          <Button variant="ghost" size="icon-sm" class="text-destructive hover:text-destructive" :aria-label="t('accessControl.delete')" @click="requestDelete(entry)"><Trash2 class="h-3.5 w-3.5" /></Button>
        </div>
        <div v-if="loading && entries.length === 0" class="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("accessControl.loading") }}</div>
        <div v-else-if="entries.length === 0" class="py-16 text-center text-sm text-muted-foreground">{{ t("accessControl.blacklist.empty") }}</div>
      </div>
    </div>

    <Dialog v-model:open="formOpen">
      <DialogContent class="max-w-md">
        <DialogHeader
          ><DialogTitle>{{ t("accessControl.blacklist.add") }}</DialogTitle></DialogHeader
        >
        <div class="grid gap-4">
          <label class="grid gap-1.5 text-xs"
            ><span class="font-medium">{{ t("accessControl.blacklist.kind") }}</span
            ><Select v-model="kind"
              ><SelectTrigger><SelectValue /></SelectTrigger
              ><SelectContent
                ><SelectItem value="ip">{{ t("accessControl.blacklist.kinds.ip") }}</SelectItem
                ><SelectItem value="user">{{ t("accessControl.blacklist.kinds.user") }}</SelectItem></SelectContent
              ></Select
            ></label
          >
          <label class="grid gap-1.5 text-xs"
            ><span class="font-medium">{{ t("accessControl.blacklist.value") }}</span
            ><Input v-model="value"
          /></label>
          <label class="grid gap-1.5 text-xs"
            ><span class="font-medium">{{ t("accessControl.blacklist.reason") }}</span
            ><textarea v-model="reason" rows="3" class="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" />
          </label>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="formOpen = false">{{ t("accessControl.cancel") }}</Button
          ><Button :disabled="!value.trim() || saving" @click="submitCreate">{{ t("accessControl.create") }}</Button></DialogFooter
        >
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="deleteOpen">
      <DialogContent class="max-w-sm">
        <DialogHeader
          ><DialogTitle>{{ t("accessControl.blacklist.deleteTitle") }}</DialogTitle></DialogHeader
        >
        <p class="text-sm text-muted-foreground">{{ t("accessControl.blacklist.deleteConfirm", { value: deleting?.value ?? "" }) }}</p>
        <DialogFooter
          ><Button variant="outline" @click="deleteOpen = false">{{ t("accessControl.cancel") }}</Button
          ><Button variant="destructive" :disabled="saving" @click="confirmDelete">{{ t("accessControl.delete") }}</Button></DialogFooter
        >
      </DialogContent>
    </Dialog>
  </div>
</template>
