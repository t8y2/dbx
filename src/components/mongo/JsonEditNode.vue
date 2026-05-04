<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, Trash2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import type { EditNode, EditNodeKind } from "@/types/editor";

defineOptions({ name: "JsonEditNode" });

const props = withDefaults(defineProps<{
  node: EditNode;
  removable?: boolean;
  parentKind?: EditNodeKind | "root";
}>(), {
  removable: true,
  parentKind: "root",
});

const emit = defineEmits<{
  (e: "remove"): void;
}>();

const { t } = useI18n();

const isContainer = computed(() => props.node.kind !== "value");
const showChildDeleteConfirm = ref(false);
const pendingChildDeleteIdx = ref<number | null>(null);

const childKeyWidth = computed(() => {
  const longest = props.node.children.reduce((max, child) => {
    return Math.max(max, Array.from(child.keyName || "").length);
  }, 0);
  return `${Math.min(Math.max(longest + 4, 8), 36)}ch`;
});

const childDeleteDetails = computed(() => {
  const idx = pendingChildDeleteIdx.value;
  if (idx === null) return "";
  const child = props.node.children[idx];
  if (!child) return "";
  if (props.node.kind === "array") {
    return t("dangerDialog.mongoArrayItemDetails", { index: child.keyName });
  }
  return t("dangerDialog.mongoFieldDetails", { field: child.keyName || t("mongo.field") });
});

function fieldRows(value: string): number {
  const estimatedRows = value.split(/\r?\n/).reduce((sum, line) => {
    return sum + Math.max(1, Math.ceil(Array.from(line).length / 110));
  }, 0);
  return Math.min(Math.max(estimatedRows, 2), 14);
}

function fieldValueTone(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"")) return "is-string";
  if (/^(true|false)$/i.test(trimmed)) return "is-boolean";
  if (/^(null|NULL)$/i.test(trimmed)) return "is-null";
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return "is-number";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "is-complex";
  return "is-string";
}

function createBlankNode(keyName: string, readonlyKey: boolean): EditNode {
  return {
    key: crypto.randomUUID(),
    keyName,
    kind: "value",
    valueText: "",
    readonlyKey,
    readonlyValue: false,
    children: [],
  };
}

function addChild() {
  if (props.node.kind === "array") {
    props.node.children.push(createBlankNode(String(props.node.children.length), true));
    return;
  }
  props.node.children.push(createBlankNode("", false));
}

function removeChild(idx: number) {
  props.node.children.splice(idx, 1);
  if (props.node.kind === "array") {
    props.node.children.forEach((child, childIdx) => {
      child.keyName = String(childIdx);
    });
  }
}

function requestRemoveChild(idx: number) {
  pendingChildDeleteIdx.value = idx;
  showChildDeleteConfirm.value = true;
}

function confirmRemoveChild() {
  if (pendingChildDeleteIdx.value === null) return;
  removeChild(pendingChildDeleteIdx.value);
  pendingChildDeleteIdx.value = null;
}
</script>

<template>
  <div class="json-node">
    <div class="json-edit-row" :class="{ 'is-container': isContainer }">
      <div class="json-edit-key">
        <template v-if="parentKind === 'array'">
          <span class="json-edit-index">[{{ node.keyName }}]</span>
        </template>
        <template v-else>
          <span class="json-edit-quote">"</span>
          <input
            v-model="node.keyName"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            class="json-edit-key-input"
            :disabled="node.readonlyKey"
            :placeholder="t('mongo.fieldPlaceholder')"
          />
          <span class="json-edit-quote">"</span>
        </template>
        <span class="json-edit-colon">:</span>
      </div>

      <textarea
        v-if="node.kind === 'value'"
        v-model="node.valueText"
        class="json-edit-value"
        :class="[fieldValueTone(node.valueText), { 'is-readonly': node.readonlyValue }]"
        :disabled="node.readonlyValue"
        :rows="fieldRows(node.valueText)"
        wrap="soft"
      />
      <div v-else class="json-edit-container-open">
        <span>{{ node.kind === 'array' ? '[' : '{' }}</span>
        <span class="json-edit-count">{{ node.children.length }}</span>
      </div>

      <span class="json-edit-comma">{{ node.kind === 'value' ? ',' : '' }}</span>

      <Button
        v-if="removable"
        variant="ghost"
        size="icon"
        class="json-edit-remove"
        :title="t('mongo.deleteField')"
        @click="emit('remove')"
      >
        <Trash2 class="w-3 h-3" />
      </Button>
      <span v-else-if="node.readonlyValue" class="json-edit-lock">{{ t('mongo.readonlyId') }}</span>
    </div>

    <div
      v-if="isContainer"
      class="json-edit-children"
      :style="{ '--mongo-key-width': childKeyWidth }"
    >
      <JsonEditNode
        v-for="(child, idx) in node.children"
        :key="child.key"
        :node="child"
        :parent-kind="node.kind"
        :removable="!child.readonlyValue || node.kind === 'array'"
        @remove="requestRemoveChild(idx)"
      />

      <Button variant="ghost" size="sm" class="json-edit-add" @click="addChild">
        <Plus class="w-3 h-3 mr-1" /> {{ t('mongo.addField') }}
      </Button>

      <div class="json-edit-close">
        {{ node.kind === 'array' ? ']' : '}' }}<span class="json-edit-comma">,</span>
      </div>
    </div>

    <DangerConfirmDialog
      v-model:open="showChildDeleteConfirm"
      :message="t('dangerDialog.deleteMessage')"
      :details="childDeleteDetails"
      :confirm-label="t('mongo.deleteField')"
      @confirm="confirmRemoveChild"
    />
  </div>
</template>

<style scoped>
.json-edit-row {
  display: grid;
  grid-template-columns: var(--mongo-key-width) minmax(380px, 1fr) 14px minmax(32px, auto);
  gap: 8px;
  align-items: start;
  margin: 4px 0 4px 2ch;
  padding: 7px 8px;
  border: 1px solid color-mix(in oklab, var(--border) 82%, transparent);
  border-left-width: 3px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--background) 76%, var(--muted));
}

.json-edit-row:hover {
  background: color-mix(in oklab, var(--background) 58%, var(--muted));
}

.json-edit-row.is-container {
  border-bottom-left-radius: 4px;
  border-bottom-right-radius: 4px;
}

.json-edit-key {
  display: flex;
  align-items: center;
  min-height: 34px;
  color: #7c3aed;
  font-weight: 600;
}

.json-edit-key-input {
  width: 100%;
  min-width: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  outline: none;
}

.json-edit-key-input:focus {
  background: var(--background);
  box-shadow: 0 0 0 1px var(--ring);
}

.json-edit-key-input:disabled {
  color: var(--muted-foreground);
  cursor: not-allowed;
}

.json-edit-quote,
.json-edit-colon,
.json-edit-comma,
.json-edit-close {
  color: var(--muted-foreground);
}

.json-edit-colon {
  margin-left: 2px;
}

.json-edit-index {
  color: var(--muted-foreground);
}

.json-edit-value {
  width: 100%;
  min-height: 42px;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--background);
  padding: 5px 8px;
  font: inherit;
  line-height: 1.55;
  outline: none;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.json-edit-value:focus {
  border-color: var(--ring);
  box-shadow: 0 0 0 2px color-mix(in oklab, var(--ring) 28%, transparent);
}

.json-edit-value.is-readonly {
  color: var(--muted-foreground);
  cursor: not-allowed;
}

.json-edit-value.is-string {
  color: #15803d;
}

.json-edit-value.is-number {
  color: #b45309;
}

.json-edit-value.is-boolean {
  color: #2563eb;
  font-weight: 600;
}

.json-edit-value.is-null {
  color: #64748b;
  font-style: italic;
}

.json-edit-value.is-complex,
.json-edit-container-open {
  color: var(--foreground);
}

.json-edit-count {
  margin-left: 8px;
  color: var(--muted-foreground);
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 11px;
}

.json-edit-remove {
  height: 28px;
  width: 28px;
  color: var(--destructive);
}

.json-edit-lock {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  color: var(--muted-foreground);
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 11px;
  white-space: nowrap;
}

.json-edit-children {
  margin: -4px 0 6px calc(2ch + 12px);
  padding: 4px 0 4px 10px;
  border-left: 1px solid var(--border);
}

.json-edit-close {
  margin: 4px 0 4px 2ch;
  font-weight: 700;
}

.json-edit-add {
  margin: 6px 0 6px 2ch;
  font-family: ui-sans-serif, system-ui, sans-serif;
}

:global(.dark) .json-edit-key {
  color: #c4b5fd;
}

:global(.dark) .json-edit-value.is-string {
  color: #86efac;
}

:global(.dark) .json-edit-value.is-number {
  color: #fbbf24;
}

:global(.dark) .json-edit-value.is-boolean {
  color: #93c5fd;
}

:global(.dark) .json-edit-value.is-null {
  color: #94a3b8;
}
</style>
