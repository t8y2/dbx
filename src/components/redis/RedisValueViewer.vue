<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, Trash2, Save, RefreshCw, Plus } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import * as api from "@/lib/tauri";
import type { RedisValue } from "@/lib/tauri";

const { t } = useI18n();

const props = defineProps<{
  connectionId: string;
  keyName: string;
}>();

const emit = defineEmits<{ deleted: [] }>();

const data = ref<RedisValue | null>(null);
const loading = ref(false);
const editValue = ref("");
const isEditing = ref(false);
const newField = ref("");
const newValue = ref("");
const showDeleteConfirm = ref(false);

type PendingDelete =
  | { kind: "key" }
  | { kind: "hash"; field: string }
  | { kind: "list"; index: number }
  | { kind: "set"; member: string };

const pendingDelete = ref<PendingDelete | null>(null);

const deleteDetails = computed(() => {
  const pending = pendingDelete.value;
  if (!pending) return "";
  if (pending.kind === "key") return t("dangerDialog.redisKeyDetails", { key: props.keyName });
  if (pending.kind === "hash") return t("dangerDialog.redisHashFieldDetails", { key: props.keyName, field: pending.field });
  if (pending.kind === "list") return t("dangerDialog.redisListItemDetails", { key: props.keyName, index: pending.index });
  return t("dangerDialog.redisSetMemberDetails", { key: props.keyName, member: pending.member });
});

async function load() {
  loading.value = true;
  try {
    data.value = await api.redisGetValue(props.connectionId, props.keyName);
    if (data.value.key_type === "string") {
      editValue.value = String(data.value.value);
    }
  } finally {
    loading.value = false;
  }
}

async function saveString() {
  await api.redisSetString(props.connectionId, props.keyName, editValue.value);
  isEditing.value = false;
  await load();
}

async function applyDeleteKey() {
  await api.redisDeleteKey(props.connectionId, props.keyName);
  emit("deleted");
}

function requestDeleteKey() {
  pendingDelete.value = { kind: "key" };
  showDeleteConfirm.value = true;
}

function copyValue() {
  if (!data.value) return;
  const text = typeof data.value.value === "string" ? data.value.value : JSON.stringify(data.value.value, null, 2);
  navigator.clipboard.writeText(text);
}

// Hash
async function hashSet() {
  if (!newField.value) return;
  await api.redisHashSet(props.connectionId, props.keyName, newField.value, newValue.value);
  newField.value = "";
  newValue.value = "";
  await load();
}
async function applyHashDel(field: string) {
  await api.redisHashDel(props.connectionId, props.keyName, field);
  await load();
}
function requestHashDel(field: string) {
  pendingDelete.value = { kind: "hash", field };
  showDeleteConfirm.value = true;
}

// List
async function listPush() {
  if (!newValue.value) return;
  await api.redisListPush(props.connectionId, props.keyName, newValue.value);
  newValue.value = "";
  await load();
}
async function applyListRemove(index: number) {
  await api.redisListRemove(props.connectionId, props.keyName, index);
  await load();
}
function requestListRemove(index: number) {
  pendingDelete.value = { kind: "list", index };
  showDeleteConfirm.value = true;
}

// Set
async function setAdd() {
  if (!newValue.value) return;
  await api.redisSetAdd(props.connectionId, props.keyName, newValue.value);
  newValue.value = "";
  await load();
}
async function applySetRemove(member: string) {
  await api.redisSetRemove(props.connectionId, props.keyName, member);
  await load();
}
function requestSetRemove(member: string) {
  pendingDelete.value = { kind: "set", member };
  showDeleteConfirm.value = true;
}

async function confirmDelete() {
  const pending = pendingDelete.value;
  if (!pending) return;
  if (pending.kind === "key") await applyDeleteKey();
  else if (pending.kind === "hash") await applyHashDel(pending.field);
  else if (pending.kind === "list") await applyListRemove(pending.index);
  else await applySetRemove(pending.member);
  pendingDelete.value = null;
}

function formatValue(val: any): string {
  if (typeof val === "string") return val;
  return JSON.stringify(val, null, 2);
}

onMounted(load);
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div v-if="loading" class="flex-1 flex items-center justify-center text-muted-foreground">
      {{ t('common.loading') }}
    </div>

    <template v-else-if="data">
      <!-- Header -->
      <div class="flex items-center gap-2 px-4 py-2 border-b bg-muted/30 shrink-0">
        <span class="font-mono text-sm font-medium truncate">{{ data.key }}</span>
        <Badge variant="secondary" class="text-xs">{{ data.key_type }}</Badge>
        <Badge v-if="data.ttl > 0" variant="outline" class="text-xs">TTL: {{ data.ttl }}s</Badge>
        <Badge v-else-if="data.ttl === -1" variant="outline" class="text-xs opacity-50">{{ t('redis.noExpiry') }}</Badge>
        <span class="flex-1" />
        <Button variant="ghost" size="icon" class="h-7 w-7" @click="load"><RefreshCw class="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="icon" class="h-7 w-7" @click="copyValue"><Copy class="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="icon" class="h-7 w-7 text-destructive" @click="requestDeleteKey"><Trash2 class="h-3.5 w-3.5" /></Button>
      </div>

      <!-- String -->
      <div v-if="data.key_type === 'string'" class="flex-1 flex flex-col overflow-hidden">
        <textarea v-model="editValue" class="flex-1 p-4 font-mono text-sm bg-background resize-none outline-none" @input="isEditing = true" />
        <div v-if="isEditing" class="px-4 py-2 border-t flex justify-end gap-2 shrink-0">
          <Button variant="ghost" size="sm" @click="isEditing = false; editValue = String(data.value)">{{ t('grid.discard') }}</Button>
          <Button size="sm" @click="saveString"><Save class="w-3 h-3 mr-1" /> {{ t('grid.save') }}</Button>
        </div>
      </div>

      <!-- List -->
      <div v-else-if="data.key_type === 'list'" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-1.5 border-b shrink-0">
          <span class="text-xs text-muted-foreground">{{ t('redis.items', { count: Array.isArray(data.value) ? data.value.length : 0 }) }}</span>
          <span class="flex-1" />
          <Input v-model="newValue" class="h-6 w-40 text-xs" placeholder="value" @keydown.enter="listPush" />
          <Button variant="ghost" size="sm" class="h-6 text-xs" @click="listPush"><Plus class="w-3 h-3 mr-1" />Push</Button>
        </div>
        <div class="flex-1 overflow-y-auto">
          <div v-for="(item, idx) in data.value" :key="idx" class="px-4 py-1.5 border-b text-sm font-mono hover:bg-accent/50 flex items-center gap-2 group">
            <span class="text-muted-foreground text-xs w-8 shrink-0">{{ idx }}</span>
            <span class="truncate flex-1">{{ item }}</span>
            <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive" @click="requestListRemove(Number(idx))"><Trash2 class="w-3 h-3" /></Button>
          </div>
        </div>
      </div>

      <!-- Set -->
      <div v-else-if="data.key_type === 'set'" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-1.5 border-b shrink-0">
          <span class="text-xs text-muted-foreground">{{ t('redis.items', { count: Array.isArray(data.value) ? data.value.length : 0 }) }}</span>
          <span class="flex-1" />
          <Input v-model="newValue" class="h-6 w-40 text-xs" placeholder="member" @keydown.enter="setAdd" />
          <Button variant="ghost" size="sm" class="h-6 text-xs" @click="setAdd"><Plus class="w-3 h-3 mr-1" />Add</Button>
        </div>
        <div class="flex-1 overflow-y-auto">
          <div v-for="(item, idx) in data.value" :key="idx" class="px-4 py-1.5 border-b text-sm font-mono hover:bg-accent/50 flex items-center gap-2 group">
            <span class="truncate flex-1">{{ item }}</span>
            <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive" @click="requestSetRemove(String(item))"><Trash2 class="w-3 h-3" /></Button>
          </div>
        </div>
      </div>

      <!-- Hash -->
      <div v-else-if="data.key_type === 'hash'" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-1.5 border-b shrink-0">
          <span class="text-xs text-muted-foreground">{{ t('redis.fields', { count: Object.keys(data.value || {}).length }) }}</span>
          <span class="flex-1" />
          <Input v-model="newField" class="h-6 w-24 text-xs" placeholder="field" />
          <Input v-model="newValue" class="h-6 w-32 text-xs" placeholder="value" @keydown.enter="hashSet" />
          <Button variant="ghost" size="sm" class="h-6 text-xs" @click="hashSet"><Plus class="w-3 h-3 mr-1" />Set</Button>
        </div>
        <div class="flex-1 overflow-y-auto">
          <div v-for="(val, field) in data.value" :key="String(field)" class="px-4 py-1.5 border-b text-sm font-mono hover:bg-accent/50 flex items-center gap-3 group">
            <span class="text-blue-500 shrink-0 min-w-24">{{ field }}</span>
            <span class="truncate text-muted-foreground flex-1">{{ val }}</span>
            <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive" @click="requestHashDel(String(field))"><Trash2 class="w-3 h-3" /></Button>
          </div>
        </div>
      </div>

      <!-- Sorted Set (readonly) -->
      <div v-else-if="data.key_type === 'zset'" class="flex-1 overflow-auto">
        <div class="px-4 py-1 text-xs text-muted-foreground border-b">
          {{ t('redis.members', { count: Array.isArray(data.value) ? data.value.length : 0 }) }}
        </div>
        <div v-for="(item, idx) in data.value" :key="idx" class="px-4 py-1.5 border-b text-sm font-mono hover:bg-accent/50 flex items-center gap-3">
          <span class="text-muted-foreground text-xs w-16 shrink-0">{{ item.score }}</span>
          <span class="truncate">{{ item.member }}</span>
        </div>
      </div>

      <!-- Stream (readonly) -->
      <div v-else-if="data.key_type === 'stream'" class="flex-1 overflow-auto">
        <div class="px-4 py-1 text-xs text-muted-foreground border-b">
          {{ t('redis.entries', { count: Array.isArray(data.value) ? data.value.length : 0 }) }}
        </div>
        <div v-for="entry in data.value" :key="entry.id" class="px-4 py-2 border-b text-sm font-mono hover:bg-accent/50">
          <div class="mb-1 text-xs text-muted-foreground">{{ entry.id }}</div>
          <div v-for="(val, field) in entry.fields" :key="String(field)" class="grid grid-cols-[minmax(6rem,0.35fr)_1fr] gap-3 py-0.5">
            <span class="truncate text-blue-500">{{ field }}</span>
            <span class="truncate text-muted-foreground">{{ val }}</span>
          </div>
        </div>
      </div>

      <!-- Unknown -->
      <div v-else class="flex-1 overflow-auto p-4">
        <pre class="font-mono text-sm whitespace-pre-wrap">{{ formatValue(data.value) }}</pre>
      </div>
    </template>

    <DangerConfirmDialog
      v-model:open="showDeleteConfirm"
      :message="t('dangerDialog.deleteMessage')"
      :details="deleteDetails"
      :confirm-label="t('dangerDialog.deleteConfirm')"
      @confirm="confirmDelete"
    />
  </div>
</template>
