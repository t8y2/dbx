<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw, Trash2, Plus, Save, ChevronLeft, ChevronRight } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import * as api from "@/lib/tauri";
import JsonEditNode from "./JsonEditNode.vue";
import type { EditNode } from "@/types/editor";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";

const { t } = useI18n();

const props = defineProps<{
  connectionId: string;
  database: string;
  collection: string;
}>();

type JsonRecord = Record<string, unknown>;

const documents = ref<JsonRecord[]>([]);
const total = ref(0);
const loading = ref(false);
const page = ref(0);
const pageSize = 50;
const selectedIdx = ref<number | null>(null);
const editJson = ref("");
const isEditing = ref(false);
const isNew = ref(false);
const error = ref("");
const editFields = ref<EditNode[]>([]);

const selectedDoc = computed(() => {
  if (selectedIdx.value === null) return null;
  return documents.value[selectedIdx.value] ?? null;
});

const editKeyWidth = computed(() => {
  const longest = editFields.value.reduce((max, field) => {
    return Math.max(max, Array.from(field.keyName || "").length);
  }, 0);
  return `${Math.min(Math.max(longest + 4, 8), 36)}ch`;
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const result = await api.mongoFindDocuments(
      props.connectionId, props.database, props.collection,
      page.value * pageSize, pageSize
    );
    documents.value = result.documents.map(asRecord);
    total.value = result.total;
  } catch (e: unknown) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

function asRecord(value: unknown): JsonRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {};
}

function selectDoc(idx: number) {
  selectedIdx.value = idx;
  editJson.value = JSON.stringify(documents.value[idx], null, 2);
  isEditing.value = false;
  isNew.value = false;
  editFields.value = [];
}

function startNew() {
  selectedIdx.value = null;
  editJson.value = "";
  editFields.value = [createEditNode("", "", false, false)];
  isEditing.value = true;
  isNew.value = true;
}

function startEdit() {
  const doc = selectedDoc.value;
  if (!doc) return;
  editFields.value = Object.entries(doc).map(([name, value]) =>
    createEditNode(name, value, name === "_id", name === "_id")
  );
  isEditing.value = true;
  isNew.value = false;
}

function cancelEdit() {
  isEditing.value = false;
  if (isNew.value) {
    isNew.value = false;
    editFields.value = [];
    return;
  }
  if (selectedDoc.value) {
    editJson.value = JSON.stringify(selectedDoc.value, null, 2);
  }
  editFields.value = [];
  error.value = "";
}

function createEditNode(keyName: string, value: unknown, readonlyKey: boolean, readonlyValue: boolean): EditNode {
  if (Array.isArray(value)) {
    return {
      key: crypto.randomUUID(),
      keyName,
      kind: "array",
      valueText: "",
      readonlyKey,
      readonlyValue,
      children: value.map((child, idx) => createEditNode(String(idx), child, true, readonlyValue)),
    };
  }

  if (value && typeof value === "object") {
    return {
      key: crypto.randomUUID(),
      keyName,
      kind: "object",
      valueText: "",
      readonlyKey,
      readonlyValue,
      children: Object.entries(value as JsonRecord).map(([childName, child]) =>
        createEditNode(childName, child, readonlyValue, readonlyValue)
      ),
    };
  }

  return {
    key: crypto.randomUUID(),
    keyName,
    kind: "value",
    valueText: formatForEdit(value),
    readonlyKey,
    readonlyValue,
    children: [],
  };
}

function addField() {
  editFields.value.push(createEditNode("", "", false, false));
}

function removeField(idx: number) {
  if (editFields.value[idx]?.readonlyValue) return;
  editFields.value.splice(idx, 1);
}

function formatForEdit(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function parseFieldValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "NULL") return null;
  if (/^(true|false|null)$/i.test(trimmed)) return JSON.parse(trimmed.toLowerCase());
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
    return JSON.parse(trimmed);
  }
  return raw;
}

function buildObjectFromNodes(nodes: EditNode[], path: string): JsonRecord {
  const doc: JsonRecord = {};
  const seen = new Set<string>();

  for (const field of nodes) {
    const name = field.keyName.trim();
    if (!name || (!path && name === "_id")) continue;
    if (seen.has(name)) throw new Error(t("mongo.duplicateField", { field: name }));
    seen.add(name);
    doc[name] = buildValueFromNode(field, path ? `${path}.${name}` : name);
  }

  return doc;
}

function buildValueFromNode(node: EditNode, path: string): unknown {
  if (node.kind === "value") return parseFieldValue(node.valueText);
  if (node.kind === "array") {
    return node.children.map((child, idx) => buildValueFromNode(child, `${path}[${idx}]`));
  }
  return buildObjectFromNodes(node.children, path);
}

function buildDocumentFromFields(): JsonRecord {
  return buildObjectFromNodes(editFields.value, "");
}

async function saveDoc() {
  error.value = "";
  try {
    const doc = buildDocumentFromFields();
    if (isNew.value) {
      await api.mongoInsertDocument(props.connectionId, props.database, props.collection, JSON.stringify(doc));
    } else if (selectedIdx.value !== null) {
      const current = documents.value[selectedIdx.value];
      const id = current?._id;
      if (!id) { error.value = "No _id field"; return; }
      await api.mongoUpdateDocument(props.connectionId, props.database, props.collection, String(id), JSON.stringify(doc));
    }
    isEditing.value = false;
    isNew.value = false;
    editFields.value = [];
    await load();
  } catch (e: unknown) {
    error.value = String(e);
  }
}

async function deleteDoc(idx: number) {
  const doc = documents.value[idx];
  const id = doc._id;
  if (!id) return;
  error.value = "";
  try {
    await api.mongoDeleteDocument(props.connectionId, props.database, props.collection, String(id));
    if (selectedIdx.value === idx) { selectedIdx.value = null; editJson.value = ""; }
    await load();
  } catch (e: unknown) {
    error.value = String(e);
  }
}

function prevPage() {
  if (page.value <= 0) return;
  page.value--;
  load();
}

function nextPage() {
  if ((page.value + 1) * pageSize >= total.value) return;
  page.value++;
  load();
}

function docPreview(doc: JsonRecord): string {
  const id = doc._id || "";
  const keys = Object.keys(doc).filter(k => k !== "_id").slice(0, 3);
  const preview = keys.map(k => `${k}: ${JSON.stringify(doc[k]).substring(0, 30)}`).join(", ");
  return `${id} - ${preview}`;
}

function highlightedJson(json: string): string {
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "json-number";
      if (match.startsWith('"')) cls = match.endsWith(":") ? "json-key" : "json-string";
      else if (match === "true" || match === "false") cls = "json-boolean";
      else if (match === "null") cls = "json-null";
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

onMounted(load);
</script>

<template>
  <Splitpanes class="h-full">
    <!-- Document list (left) -->
    <Pane :size="30" :min-size="15" :max-size="50">
      <div class="h-full flex flex-col overflow-hidden">
      <div class="flex items-center gap-1 px-3 py-1.5 border-b shrink-0 text-xs text-muted-foreground">
        <span>{{ t('mongo.documents', { count: total }) }}</span>
        <span class="flex-1" />
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="startNew"><Plus class="h-3 w-3" /></Button>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="load"><RefreshCw class="h-3 w-3" :class="{ 'animate-spin': loading }" /></Button>
      </div>

      <div class="flex-1 overflow-y-auto">
        <div
          v-for="(doc, idx) in documents"
          :key="idx"
          class="px-3 py-1.5 border-b text-xs font-mono cursor-pointer hover:bg-accent/50 flex items-center gap-2 group"
          :class="{ 'bg-accent': selectedIdx === idx }"
          @click="selectDoc(idx)"
        >
          <span class="truncate flex-1">{{ docPreview(doc) }}</span>
          <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive shrink-0" @click.stop="deleteDoc(idx)">
            <Trash2 class="w-3 h-3" />
          </Button>
        </div>
        <div v-if="documents.length === 0 && !loading" class="px-3 py-8 text-center text-muted-foreground text-xs">
          {{ t('mongo.emptyCollection') }}
        </div>
      </div>

      <!-- Pagination -->
      <div class="flex items-center justify-center gap-2 px-3 py-1 border-t text-xs text-muted-foreground shrink-0">
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="page <= 0" @click="prevPage">
          <ChevronLeft class="h-3 w-3" />
        </Button>
        <span>{{ page + 1 }} / {{ Math.max(1, Math.ceil(total / pageSize)) }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="(page + 1) * pageSize >= total" @click="nextPage">
          <ChevronRight class="h-3 w-3" />
        </Button>
      </div>
    </div>
    </Pane>

    <!-- Document viewer/editor (right) -->
    <Pane :size="70">
    <div class="h-full flex flex-col min-w-0 overflow-hidden">
      <template v-if="selectedIdx !== null || isNew">
        <div class="flex items-center gap-2 px-4 py-2 border-b bg-muted/30 shrink-0">
          <Badge variant="secondary" class="text-xs">{{ isNew ? 'New' : selectedDoc?._id }}</Badge>
          <span class="flex-1" />
          <Button v-if="!isEditing" variant="ghost" size="sm" class="h-6 text-xs" @click="startEdit">Edit</Button>
          <template v-if="isEditing">
            <Button variant="ghost" size="sm" class="h-6 text-xs" @click="addField">
              <Plus class="w-3 h-3 mr-1" /> {{ t('mongo.addField') }}
            </Button>
            <Button variant="ghost" size="sm" class="h-6 text-xs" @click="cancelEdit">{{ t('grid.discard') }}</Button>
            <Button size="sm" class="h-6 text-xs" @click="saveDoc"><Save class="w-3 h-3 mr-1" />{{ t('grid.save') }}</Button>
          </template>
        </div>

        <div v-if="isEditing" class="flex-1 overflow-auto bg-muted/10">
          <div class="json-edit min-w-fit p-5 font-mono text-[13px] leading-6" :style="{ '--mongo-key-width': editKeyWidth }">
            <div class="json-edit-brace">{</div>

            <JsonEditNode
              v-for="(field, idx) in editFields"
              :key="field.key"
              :node="field"
              parent-kind="root"
              :removable="!field.readonlyValue"
              @remove="removeField(idx)"
            />

            <Button variant="ghost" size="sm" class="json-edit-add" @click="addField">
              <Plus class="w-3 h-3 mr-1" /> {{ t('mongo.addField') }}
            </Button>

            <div class="json-edit-brace">}</div>
          </div>
        </div>

        <div v-else class="flex-1 overflow-auto bg-muted/10">
          <pre
            class="json-viewer min-w-fit p-5 font-mono text-[13px] leading-6"
            v-html="highlightedJson(editJson)"
          />
        </div>
      </template>
      <div v-else class="h-full flex items-center justify-center text-muted-foreground text-sm">
        {{ t('mongo.selectDocument') }}
      </div>

      <div v-if="error" class="px-3 py-1.5 border-t bg-destructive/10 text-destructive text-xs shrink-0">
        {{ error }}
      </div>
    </div>
    </Pane>
  </Splitpanes>
</template>

<style scoped>
.json-viewer {
  tab-size: 2;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.json-edit {
  tab-size: 2;
  color: var(--foreground);
  white-space: pre-wrap;
}

.json-edit-brace {
  color: var(--muted-foreground);
  font-weight: 700;
}

.json-edit-add {
  margin: 6px 0 6px 2ch;
  font-family: ui-sans-serif, system-ui, sans-serif;
}

:deep(.json-key) {
  color: #7c3aed;
  font-weight: 600;
}

:deep(.json-string) {
  color: #15803d;
}

:deep(.json-number) {
  color: #b45309;
}

:deep(.json-boolean) {
  color: #2563eb;
  font-weight: 600;
}

:deep(.json-null) {
  color: #64748b;
  font-style: italic;
}

:global(.dark) :deep(.json-key) {
  color: #c4b5fd;
}

:global(.dark) :deep(.json-string) {
  color: #86efac;
}

:global(.dark) :deep(.json-number) {
  color: #fbbf24;
}

:global(.dark) :deep(.json-boolean) {
  color: #93c5fd;
}

:global(.dark) :deep(.json-null) {
  color: #94a3b8;
}

</style>
