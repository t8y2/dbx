<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { CalendarDateTime } from "@internationalized/date";
import { useI18n } from "vue-i18n";
import { AlertTriangle, CalendarClock, Copy, Eye, Loader2, Pencil, Plus, RefreshCcw, Settings2, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import DateTimePicker from "@/components/ui/date-time-picker/DateTimePicker.vue";
import { calendarDateTimeToUnixSeconds, unixSecondsToCalendarDateTime } from "@/components/ui/date-time-picker/dateTimePicker";
import ErrorBanner from "@/components/ui/ErrorBanner.vue";
import QueryLoadingState from "@/components/common/QueryLoadingState.vue";
import MeilisearchMultiSelect from "@/components/meilisearch/MeilisearchMultiSelect.vue";
import * as api from "@/lib/backend/api";
import { copyToClipboard } from "@/lib/common/clipboard";
import { loadMeilisearchKeyColumns, saveMeilisearchKeyColumns, type MeilisearchKeyColumnKey } from "@/lib/meilisearch/meilisearchKeyColumns";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { useToast } from "@/composables/useToast";
import type { KeyCreateInput, KeyListItem } from "@/types/meilisearchManagement";

const KEY_ACTION_OPTIONS = [
  "search",
  "documents.add",
  "documents.get",
  "documents.delete",
  "indexes.create",
  "indexes.get",
  "indexes.update",
  "indexes.delete",
  "tasks.get",
  "settings.get",
  "settings.update",
  "stats.get",
  "dumps.create",
  "version",
  "keys.get",
  "keys.create",
  "keys.update",
  "keys.delete",
] as const;

interface KeyFormState {
  uid: string;
  name: string;
  description: string;
  actions: string[];
  indexes: string[];
  expiresAt: string;
}

const props = defineProps<{ connectionId: string }>();
const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const readOnly = computed(() => connectionIsEffectivelyReadOnly(connectionStore.getConfig(props.connectionId)));

const rows = ref<KeyListItem[]>([]);
const offset = ref(0);
const limit = 20;
const total = ref(0);
const loading = ref(false);
const error = ref("");
const working = ref(false);
const indexOptions = ref<string[]>(["*"]);
const indexesLoading = ref(false);
const indexLoadError = ref("");
const visibleColumns = ref<MeilisearchKeyColumnKey[]>(loadMeilisearchKeyColumns());
const formOpen = ref(false);
const editing = ref<KeyListItem | null>(null);
const form = ref<KeyFormState>(emptyForm());
const formError = ref("");
const detailOpen = ref(false);
const detail = ref<KeyListItem | null>(null);
const deleteOpen = ref(false);
const deleting = ref<KeyListItem | null>(null);
const deleteConfirmation = ref("");
const secretOpen = ref(false);
const createdSecret = ref("");
const createdUid = ref("");

const hasPrevious = computed(() => offset.value > 0);
const hasNext = computed(() => offset.value + rows.value.length < total.value);
const canConfirmDelete = computed(() => Boolean(deleting.value) && deleteConfirmation.value === deleting.value?.uid);
const expirationDateTime = computed<CalendarDateTime | null>(() => {
  const value = form.value.expiresAt.trim();
  if (!value) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  return unixSecondsToCalendarDateTime(Math.floor(instant.getTime() / 1_000));
});
const columnOptions = computed<Array<{ key: MeilisearchKeyColumnKey; label: string }>>(() => [
  { key: "name", label: t("meilisearch.name") },
  { key: "key", label: t("meilisearch.key") },
  { key: "uid", label: "UID" },
  { key: "actions", label: t("meilisearch.actions") },
  { key: "indexes", label: t("meilisearch.indexes") },
  { key: "expiresAt", label: t("meilisearch.expiresAt") },
]);

function emptyForm(): KeyFormState {
  return { uid: "", name: "", description: "", actions: ["search"], indexes: ["*"], expiresAt: "" };
}

function isColumnVisible(key: MeilisearchKeyColumnKey): boolean {
  return visibleColumns.value.includes(key);
}

function toggleColumn(key: MeilisearchKeyColumnKey) {
  if (isColumnVisible(key) && visibleColumns.value.length === 1) return;
  visibleColumns.value = isColumnVisible(key) ? visibleColumns.value.filter((column) => column !== key) : columnOptions.value.map((option) => option.key).filter((column) => column === key || visibleColumns.value.includes(column));
  saveMeilisearchKeyColumns(visibleColumns.value);
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const page = await api.meilisearchListKeys(props.connectionId, offset.value, limit);
    rows.value = page.results;
    total.value = page.total;
  } catch (cause: any) {
    error.value = cause?.message || String(cause);
  } finally {
    loading.value = false;
  }
}

async function loadIndexes() {
  indexesLoading.value = true;
  indexLoadError.value = "";
  try {
    const indexes = await api.meilisearchListIndexes(props.connectionId);
    indexOptions.value = ["*", ...new Set(indexes.filter(Boolean).sort((left, right) => left.localeCompare(right)))];
  } catch (cause: any) {
    indexLoadError.value = cause?.message || String(cause);
    indexOptions.value = ["*"];
  } finally {
    indexesLoading.value = false;
  }
}

function refresh() {
  void load();
  void loadIndexes();
}

function openCreate() {
  editing.value = null;
  form.value = emptyForm();
  formError.value = "";
  formOpen.value = true;
}

function openEdit(item: KeyListItem) {
  editing.value = item;
  form.value = { uid: item.uid, name: item.name || "", description: item.description || "", actions: [...item.actions], indexes: [...item.indexes], expiresAt: item.expiresAt || "" };
  formError.value = "";
  formOpen.value = true;
}

function normalizeExpiration(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) throw new Error(t("meilisearch.invalidExpiresAt"));
  return date.toISOString();
}

function updateExpirationFromPicker(value: CalendarDateTime) {
  form.value.expiresAt = new Date(calendarDateTimeToUnixSeconds(value) * 1_000).toISOString();
}

async function save() {
  if (readOnly.value) return;
  working.value = true;
  formError.value = "";
  try {
    if (editing.value) {
      await api.meilisearchUpdateKey(props.connectionId, editing.value.uid, { name: form.value.name.trim() || null, description: form.value.description.trim() || null });
      toast(t("meilisearch.keyUpdated"));
    } else {
      const input: KeyCreateInput = {
        uid: form.value.uid.trim() || null,
        name: form.value.name.trim() || null,
        description: form.value.description.trim() || null,
        actions: [...form.value.actions],
        indexes: [...form.value.indexes],
        expiresAt: normalizeExpiration(form.value.expiresAt),
      };
      if (!input.actions.length || !input.indexes.length) throw new Error(t("meilisearch.actionsIndexesRequired"));
      const created = await api.meilisearchCreateKey(props.connectionId, input);
      createdSecret.value = created.key;
      createdUid.value = created.uid;
      secretOpen.value = true;
    }
    formOpen.value = false;
    await load();
  } catch (cause: any) {
    formError.value = cause?.message || String(cause);
  } finally {
    working.value = false;
  }
}

async function showDetail(item: KeyListItem) {
  detailOpen.value = true;
  detail.value = null;
  try {
    detail.value = await api.meilisearchGetKey(props.connectionId, item.uid);
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
    detailOpen.value = false;
  }
}

function requestDelete(item: KeyListItem) {
  deleting.value = item;
  deleteConfirmation.value = "";
  deleteOpen.value = true;
}

async function confirmDelete() {
  if (!deleting.value || !canConfirmDelete.value || readOnly.value) return;
  working.value = true;
  try {
    await api.meilisearchDeleteKey(props.connectionId, deleting.value.uid);
    deleteOpen.value = false;
    deleting.value = null;
    deleteConfirmation.value = "";
    toast(t("meilisearch.keyDeleted"));
    if (rows.value.length === 1 && offset.value > 0) offset.value = Math.max(0, offset.value - limit);
    await load();
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
  } finally {
    working.value = false;
  }
}

async function copyKey(value: string) {
  if (!value) return;
  await copyToClipboard(value);
  toast(t("meilisearch.copied"));
}

watch(secretOpen, (open) => {
  if (!open) {
    createdSecret.value = "";
    createdUid.value = "";
  }
});
watch(deleteOpen, (open) => {
  if (!open && !working.value) {
    deleting.value = null;
    deleteConfirmation.value = "";
  }
});

onMounted(() => {
  void load();
  void loadIndexes();
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden p-4">
    <div class="mb-3 flex items-center justify-between gap-3">
      <div>
        <h2 class="text-base font-semibold">{{ t("meilisearch.apiKeys") }}</h2>
        <p class="text-xs text-muted-foreground">{{ t("meilisearch.keysDescription") }}</p>
      </div>
      <div class="flex gap-2">
        <Button size="sm" variant="outline" :disabled="loading" @click="refresh"><RefreshCcw class="mr-1 h-3.5 w-3.5" />{{ t("meilisearch.refresh") }}</Button
        ><Button size="sm" :disabled="readOnly" :title="readOnly ? t('meilisearch.readOnlyDisabled') : undefined" @click="openCreate"><Plus class="mr-1 h-3.5 w-3.5" />{{ t("meilisearch.createKey") }}</Button>
      </div>
    </div>
    <ErrorBanner v-if="error" class="mb-3" :message="error" />
    <div class="min-h-0 flex-1 overflow-auto rounded-lg border">
      <QueryLoadingState v-if="loading && !rows.length" class="py-12" />
      <table v-else class="w-full table-auto text-left text-xs">
        <thead class="sticky top-0 z-10 bg-muted">
          <tr>
            <th v-if="isColumnVisible('name')" class="px-3 py-2">{{ t("meilisearch.name") }}</th>
            <th v-if="isColumnVisible('key')" class="px-3 py-2">{{ t("meilisearch.key") }}</th>
            <th v-if="isColumnVisible('uid')" class="px-3 py-2">UID</th>
            <th v-if="isColumnVisible('actions')" class="px-3 py-2">{{ t("meilisearch.actions") }}</th>
            <th v-if="isColumnVisible('indexes')" class="px-3 py-2">{{ t("meilisearch.indexes") }}</th>
            <th v-if="isColumnVisible('expiresAt')" class="px-3 py-2">{{ t("meilisearch.expiresAt") }}</th>
            <th class="w-px whitespace-nowrap px-2 py-1.5">
              <div class="flex items-center justify-end gap-1">
                <span>{{ t("meilisearch.rowActions") }}</span
                ><Popover
                  ><PopoverTrigger as-child
                    ><Button size="icon-xs" variant="ghost" :title="t('meilisearch.columnSettings')" :aria-label="t('meilisearch.columnSettings')"><Settings2 class="h-3.5 w-3.5" /></Button></PopoverTrigger
                  ><PopoverContent align="end" class="w-56 p-2"
                    ><div class="px-2 pb-2 text-xs font-semibold">{{ t("meilisearch.columnSettings") }}</div>
                    <label v-for="option in columnOptions" :key="option.key" class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted"
                      ><input type="checkbox" :checked="isColumnVisible(option.key)" :disabled="isColumnVisible(option.key) && visibleColumns.length === 1" @change="toggleColumn(option.key)" /><span>{{ option.label }}</span></label
                    ></PopoverContent
                  ></Popover
                >
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in rows" :key="item.uid" class="border-t">
            <td v-if="isColumnVisible('name')" class="px-3 py-2">
              <div class="font-medium">{{ item.name || "-" }}</div>
              <div class="max-w-48 truncate text-muted-foreground">{{ item.description }}</div>
            </td>
            <td v-if="isColumnVisible('key')" class="px-3 py-2">
              <div class="flex items-center gap-1">
                <span class="font-mono">{{ item.maskedKey }}</span
                ><Button size="icon-xs" variant="ghost" :title="t('meilisearch.copyKeyValue')" @click="copyKey(item.key)"><Copy class="h-3.5 w-3.5" /></Button>
              </div>
            </td>
            <td v-if="isColumnVisible('uid')" class="max-w-64 truncate px-3 py-2 font-mono" :title="item.uid">{{ item.uid }}</td>
            <td v-if="isColumnVisible('actions')" class="max-w-52 px-3 py-2">{{ item.actions.join(", ") }}</td>
            <td v-if="isColumnVisible('indexes')" class="max-w-52 px-3 py-2">{{ item.indexes.join(", ") }}</td>
            <td v-if="isColumnVisible('expiresAt')" class="px-3 py-2">{{ item.expiresAt || t("meilisearch.never") }}</td>
            <td class="w-px whitespace-nowrap px-2 py-2">
              <div class="flex justify-end gap-1">
                <Button size="icon-xs" variant="ghost" :title="t('common.view')" @click="showDetail(item)"><Eye class="h-3.5 w-3.5" /></Button><Button size="icon-xs" variant="ghost" :disabled="readOnly" :title="t('common.edit')" @click="openEdit(item)"><Pencil class="h-3.5 w-3.5" /></Button
                ><Button size="icon-xs" variant="ghost" class="text-destructive" :disabled="readOnly" :title="t('common.delete')" @click="requestDelete(item)"><Trash2 class="h-3.5 w-3.5" /></Button>
              </div>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="visibleColumns.length + 1" class="p-10 text-center text-muted-foreground">{{ t("meilisearch.noKeys") }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="mt-3 flex items-center justify-between text-xs text-muted-foreground">
      <span>{{ t("meilisearch.paginationSummary", { start: total ? offset + 1 : 0, end: Math.min(offset + rows.length, total), total }) }}</span>
      <div class="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          :disabled="!hasPrevious || loading"
          @click="
            offset = Math.max(0, offset - limit);
            load();
          "
          >{{ t("meilisearch.previous") }}</Button
        ><Button
          size="sm"
          variant="outline"
          :disabled="!hasNext || loading"
          @click="
            offset += limit;
            load();
          "
          >{{ t("meilisearch.next") }}</Button
        >
      </div>
    </div>

    <Dialog v-model:open="formOpen"
      ><DialogContent class="max-w-2xl"
        ><DialogHeader
          ><DialogTitle>{{ editing ? t("meilisearch.editKey") : t("meilisearch.createKey") }}</DialogTitle></DialogHeader
        ><ErrorBanner v-if="formError" :message="formError" />
        <div class="grid max-h-[68vh] gap-4 overflow-y-auto pr-1 text-xs">
          <label class="grid gap-1"
            ><span class="font-medium">UID</span><Input v-model="form.uid" :disabled="Boolean(editing)" :placeholder="t('meilisearch.uidPlaceholder')" /><span class="text-[11px] leading-4 text-muted-foreground">{{ t("meilisearch.uidHelp") }}</span></label
          >
          <label class="grid gap-1"
            ><span class="font-medium">{{ t("meilisearch.name") }}</span
            ><Input v-model="form.name" :placeholder="t('meilisearch.namePlaceholder')" /><span class="text-[11px] leading-4 text-muted-foreground">{{ t("meilisearch.nameHelp") }}</span></label
          >
          <label class="grid gap-1"
            ><span class="font-medium">{{ t("meilisearch.description") }}</span
            ><Input v-model="form.description" :placeholder="t('meilisearch.descriptionPlaceholder')" /><span class="text-[11px] leading-4 text-muted-foreground">{{ t("meilisearch.descriptionHelp") }}</span></label
          >
          <div class="grid gap-1">
            <span class="font-medium">{{ t("meilisearch.indexes") }}</span
            ><MeilisearchMultiSelect v-model="form.indexes" :options="indexOptions" :disabled="Boolean(editing)" :loading="indexesLoading" :error="indexLoadError" :placeholder="t('meilisearch.indexesPlaceholder')" /><span class="text-[11px] leading-4 text-muted-foreground">{{
              t("meilisearch.indexesHelp")
            }}</span>
          </div>
          <div class="grid gap-1">
            <span class="font-medium">{{ t("meilisearch.actions") }}</span
            ><MeilisearchMultiSelect v-model="form.actions" :options="[...KEY_ACTION_OPTIONS]" :disabled="Boolean(editing)" :placeholder="t('meilisearch.actionsPlaceholder')" /><span class="text-[11px] leading-4 text-muted-foreground">{{ t("meilisearch.actionsHelp") }}</span>
          </div>
          <label class="grid gap-1"
            ><span class="font-medium">{{ t("meilisearch.expiresAt") }}</span>
            <div class="flex gap-2">
              <Input v-model="form.expiresAt" :disabled="Boolean(editing)" :placeholder="t('meilisearch.expiresAtPlaceholder')" /><DateTimePicker
                :model-value="expirationDateTime"
                :disabled="Boolean(editing)"
                :placeholder="t('meilisearch.expiresAtPlaceholder')"
                @update:model-value="updateExpirationFromPicker"
                ><template #trigger
                  ><button
                    type="button"
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    :disabled="Boolean(editing)"
                    :title="t('meilisearch.openDateTimePicker')"
                  >
                    <CalendarClock class="h-4 w-4" /></button></template
              ></DateTimePicker>
            </div>
            <span class="text-[11px] leading-4 text-muted-foreground">{{ t("meilisearch.expiresAtHelp") }}</span></label
          >
          <p v-if="editing" class="rounded-md border bg-muted/30 px-3 py-2 text-muted-foreground">{{ t("meilisearch.immutableKeyFields") }}</p>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="formOpen = false">{{ t("common.cancel") }}</Button
          ><Button :disabled="working || readOnly" @click="save"><Loader2 v-if="working" class="mr-1 h-3.5 w-3.5 animate-spin" />{{ t("common.save") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >

    <Dialog v-model:open="detailOpen"
      ><DialogContent class="max-w-2xl"
        ><DialogHeader
          ><DialogTitle>{{ t("meilisearch.keyDetails") }}</DialogTitle></DialogHeader
        >
        <div v-if="detail" class="grid gap-2 text-xs">
          <div>
            <span class="text-muted-foreground">UID: </span><span class="font-mono">{{ detail.uid }}</span>
          </div>
          <div>
            <span class="text-muted-foreground">{{ t("meilisearch.key") }}: </span><span class="font-mono">{{ detail.maskedKey }}</span>
          </div>
          <div>
            <span class="text-muted-foreground">{{ t("meilisearch.name") }}: </span>{{ detail.name || "-" }}
          </div>
          <div>
            <span class="text-muted-foreground">{{ t("meilisearch.description") }}: </span>{{ detail.description || "-" }}
          </div>
          <div>
            <span class="text-muted-foreground">{{ t("meilisearch.actions") }}: </span>{{ detail.actions.join(", ") }}
          </div>
          <div>
            <span class="text-muted-foreground">{{ t("meilisearch.indexes") }}: </span>{{ detail.indexes.join(", ") }}
          </div>
          <div>
            <span class="text-muted-foreground">{{ t("meilisearch.expiresAt") }}: </span>{{ detail.expiresAt || t("meilisearch.never") }}
          </div>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="detailOpen = false">{{ t("common.close") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >

    <Dialog v-model:open="secretOpen"
      ><DialogContent class="max-w-xl"
        ><DialogHeader
          ><DialogTitle>{{ t("meilisearch.keyCreated") }}</DialogTitle></DialogHeader
        >
        <p class="text-sm text-muted-foreground">{{ t("meilisearch.secretShownOnce") }}</p>
        <div class="rounded-md border bg-muted p-3">
          <div class="mb-1 text-xs text-muted-foreground">{{ createdUid }}</div>
          <div class="break-all font-mono text-sm">{{ createdSecret }}</div>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="copyKey(createdSecret)"><Copy class="mr-1 h-3.5 w-3.5" />{{ t("common.copy") }}</Button
          ><Button @click="secretOpen = false">{{ t("common.close") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >

    <Dialog v-model:open="deleteOpen"
      ><DialogContent class="sm:max-w-[480px]"
        ><DialogHeader
          ><DialogTitle class="flex items-center gap-2 text-destructive"><AlertTriangle class="h-5 w-5" />{{ t("meilisearch.deleteKey") }}</DialogTitle></DialogHeader
        >
        <div class="grid gap-3 py-3 text-sm">
          <p class="text-muted-foreground">{{ t("meilisearch.deleteKeyConfirm", { uid: deleting?.uid || "" }) }}</p>
          <code class="rounded border bg-muted px-3 py-2 text-xs break-all">{{ deleting?.uid }}</code
          ><label class="grid gap-1.5"
            ><span class="text-xs text-muted-foreground">{{ t("meilisearch.deleteKeyTypePrompt") }}</span
            ><Input v-model="deleteConfirmation" autocomplete="off" :placeholder="t('meilisearch.deleteKeyTypePlaceholder')" @keyup.enter="canConfirmDelete && confirmDelete()"
          /></label>
        </div>
        <DialogFooter
          ><Button variant="outline" :disabled="working" @click="deleteOpen = false">{{ t("common.cancel") }}</Button
          ><Button variant="destructive" :disabled="working || !canConfirmDelete" @click="confirmDelete"><Loader2 v-if="working" class="mr-1 h-3.5 w-3.5 animate-spin" />{{ t("meilisearch.deleteKey") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
  </div>
</template>
