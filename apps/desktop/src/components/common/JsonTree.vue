<script setup lang="ts">
import { computed, defineComponent, h, nextTick, ref, shallowRef, watch, type VNodeChild } from "vue";
import { DynamicScroller, DynamicScrollerItem } from "vue-virtual-scroller";
import { ChevronDown, ChevronRight } from "@lucide/vue";
import { createJsonTreeRoot, getJsonTreeChildren, getVisibleJsonTreeNodes, isJsonTreeContainer, isJsonTreeInitiallyExpanded, jsonTreeContainerKind, jsonTreeContainerSummary, type JsonTreeNode } from "@/lib/common/jsonTree";
import { isLosslessJsonNumber } from "@/lib/common/safeJsonFormat";

defineOptions({ name: "JsonTree" });

const props = withDefaults(
  defineProps<{
    value: unknown;
    wordWrap?: boolean;
    /** Optional Shiki-style inline highlighter retained for Redis value views. */
    highlightJson?: (json: string) => string;
    /** Number of expanded container levels, with the root counted as level one. */
    initialExpandedDepth?: number;
    /** Render only viewport rows for large, scrollable JSON responses. */
    virtualized?: boolean;
  }>(),
  {
    wordWrap: true,
    highlightJson: undefined,
    initialExpandedDepth: Number.POSITIVE_INFINITY,
    virtualized: false,
  },
);

type ExpansionMode = "default" | "all" | "none";
type DynamicScrollerHandle = {
  forceUpdate: (clear?: boolean) => void;
  scrollToPosition?: (position: number) => void;
};

const expansionMode = ref<ExpansionMode>("default");
const expansionOverrides = shallowRef(new Map<string, boolean>());
const virtualScroller = ref<DynamicScrollerHandle>();

const rootNode = computed(() => createJsonTreeRoot(props.value));

function resetExpansion() {
  expansionMode.value = "default";
  expansionOverrides.value = new Map();
}

function expandAll() {
  expansionMode.value = "all";
  expansionOverrides.value = new Map();
}

function collapseAll() {
  expansionMode.value = "none";
  expansionOverrides.value = new Map();
}

function isNodeExpanded(node: JsonTreeNode): boolean {
  const override = expansionOverrides.value.get(node.path);
  if (override !== undefined) return override;

  if (expansionMode.value === "all") return true;
  if (expansionMode.value === "none") return false;
  return isJsonTreeInitiallyExpanded(node.depth, props.initialExpandedDepth);
}

function setNodeExpanded(path: string, expanded: boolean) {
  const next = new Map(expansionOverrides.value);
  next.set(path, expanded);
  expansionOverrides.value = next;
}

function toggleNode(node: JsonTreeNode) {
  setNodeExpanded(node.path, !isNodeExpanded(node));
}

function scalarClass(value: unknown): string {
  if (isLosslessJsonNumber(value) || typeof value === "number") return "json-tree-number";
  if (typeof value === "string") return "json-tree-string";
  if (typeof value === "boolean") return "json-tree-boolean";
  if (value === null) return "json-tree-null";
  return "json-tree-string";
}

function scalarText(value: unknown): string {
  if (isLosslessJsonNumber(value)) return value.raw;
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}

function highlightedJson(value: string): string {
  return props.highlightJson?.(value) ?? escapeHtml(value);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function nodeAccessibleLabel(node: JsonTreeNode): string {
  // JSON Pointer paths are language-neutral and uniquely identify each toggle.
  return node.path || "$";
}

function highlightedJsonSpan(className: string, json: string): VNodeChild {
  if (!props.highlightJson) return h("span", { class: className }, json);
  return h("span", { class: className, innerHTML: props.highlightJson(json) });
}

function renderJsonNode(node: JsonTreeNode): VNodeChild {
  const containerValue = isJsonTreeContainer(node.value) ? node.value : undefined;
  const expanded = containerValue !== undefined && isNodeExpanded(node);
  const indent = `${node.depth * 16}px`;
  const rowChildren: VNodeChild[] = [];

  if (containerValue !== undefined) {
    const accessibleLabel = nodeAccessibleLabel(node);
    rowChildren.push(
      h(
        "button",
        {
          type: "button",
          class: "json-tree-toggle",
          "aria-expanded": expanded,
          "aria-label": accessibleLabel,
          title: accessibleLabel,
          onClick: () => toggleNode(node),
        },
        [expanded ? h(ChevronDown, { class: "h-3.5 w-3.5", "aria-hidden": "true" }) : h(ChevronRight, { class: "h-3.5 w-3.5", "aria-hidden": "true" })],
      ),
    );
  } else {
    rowChildren.push(h("span", { class: "json-tree-spacer", "aria-hidden": "true" }));
  }

  if (node.parentKind !== "root") {
    rowChildren.push(node.parentKind === "array" ? h("span", { class: "json-tree-index" }, `[${node.label}]`) : highlightedJsonSpan("json-tree-key", JSON.stringify(node.label)), h("span", { class: "json-tree-punctuation" }, ":"));
  }

  if (containerValue !== undefined) {
    const kind = jsonTreeContainerKind(containerValue);
    rowChildren.push(h("span", { class: `json-tree-bracket is-${kind}` }, kind === "array" ? "[" : "{"), h("span", { class: "json-tree-summary" }, jsonTreeContainerSummary(containerValue, expanded)), h("span", { class: `json-tree-bracket is-${kind}` }, kind === "array" ? "]" : "}"));
  } else {
    rowChildren.push(highlightedJsonSpan(scalarClass(node.value), scalarText(node.value)));
  }

  const children = containerValue !== undefined && expanded ? h("div", { class: "json-tree-children" }, getJsonTreeChildren(node).map(renderJsonNode)) : null;

  return h("div", { key: node.path, class: "json-tree-node", "data-json-path": node.path }, [h("div", { class: "json-tree-row", style: { paddingInlineStart: indent } }, rowChildren), children]);
}

const JsonTreeRoot = defineComponent({
  name: "JsonTreeRoot",
  setup() {
    return () => renderJsonNode(rootNode.value);
  },
});

const visibleNodes = computed(() => getVisibleJsonTreeNodes(rootNode.value, isNodeExpanded));

function refresh(resetScroll = false) {
  if (!props.virtualized) return;
  void nextTick(() => {
    virtualScroller.value?.forceUpdate(true);
    if (resetScroll) virtualScroller.value?.scrollToPosition?.(0);
  });
}

watch([() => props.value, () => props.initialExpandedDepth], () => {
  resetExpansion();
  refresh(true);
});

defineExpose({ expandAll, collapseAll, resetExpansion, refresh });
</script>

<template>
  <div class="json-tree" :class="{ 'is-nowrap': !wordWrap, 'is-virtualized': virtualized }">
    <!-- Virtual rows keep a fully expanded response responsive even when it has thousands of nodes. -->
    <DynamicScroller v-if="virtualized" ref="virtualScroller" :items="visibleNodes" :min-item-size="24" :buffer="600" key-field="path" class="json-tree-scroller">
      <template #default="{ item: node, active, index }">
        <DynamicScrollerItem :item="node" :active="active" :size-dependencies="[wordWrap, node.path, node.label, scalarText(node.value), isNodeExpanded(node)]" :data-index="index">
          <div class="json-tree-node" :data-json-path="node.path">
            <div class="json-tree-row" :style="{ paddingInlineStart: `${node.depth * 16}px` }">
              <button v-if="isJsonTreeContainer(node.value)" type="button" class="json-tree-toggle" :aria-expanded="isNodeExpanded(node)" :aria-label="nodeAccessibleLabel(node)" :title="nodeAccessibleLabel(node)" @click="toggleNode(node)">
                <ChevronDown v-if="isNodeExpanded(node)" class="h-3.5 w-3.5" aria-hidden="true" />
                <ChevronRight v-else class="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <span v-else class="json-tree-spacer" aria-hidden="true" />

              <template v-if="node.parentKind !== 'root'">
                <span v-if="node.parentKind === 'array'" class="json-tree-index">[{{ node.label }}]</span>
                <span v-else class="json-tree-key" v-html="highlightedJson(JSON.stringify(node.label))" />
                <span class="json-tree-punctuation">:</span>
              </template>

              <template v-if="isJsonTreeContainer(node.value)">
                <span class="json-tree-bracket" :class="`is-${jsonTreeContainerKind(node.value)}`">{{ jsonTreeContainerKind(node.value) === "array" ? "[" : "{" }}</span>
                <span class="json-tree-summary">{{ jsonTreeContainerSummary(node.value, isNodeExpanded(node)) }}</span>
                <span class="json-tree-bracket" :class="`is-${jsonTreeContainerKind(node.value)}`">{{ jsonTreeContainerKind(node.value) === "array" ? "]" : "}" }}</span>
              </template>
              <span v-else :class="scalarClass(node.value)" v-html="highlightedJson(scalarText(node.value))" />
            </div>
          </div>
        </DynamicScrollerItem>
      </template>
    </DynamicScroller>
    <JsonTreeRoot v-else />
  </div>
</template>

<style>
.json-tree {
  --json-tree-key: #1d4ed8;
  --json-tree-string: #15803d;
  --json-tree-number: #b45309;
  --json-tree-boolean: #7c3aed;
  --json-tree-null: #64748b;

  color: hsl(var(--foreground));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.json-tree.is-virtualized {
  height: 100%;
  min-height: 0;
}

.json-tree-scroller {
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.json-tree.is-nowrap {
  white-space: pre;
  overflow-wrap: normal;
}

.json-tree-row {
  display: flex;
  min-height: 24px;
  align-items: flex-start;
  gap: 4px;
  border-radius: 4px;
}

.json-tree-row:hover {
  background: hsl(var(--muted) / 0.5);
}

.json-tree-toggle {
  margin-top: 1px;
  display: inline-flex;
  height: 18px;
  width: 18px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  color: hsl(var(--muted-foreground));
}

.json-tree-toggle:hover {
  background: hsl(var(--accent));
  color: hsl(var(--foreground));
}

.json-tree-toggle:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 1px;
}

.json-tree-spacer {
  width: 18px;
  flex: 0 0 auto;
}

.json-tree-key {
  color: var(--json-tree-key);
}

.json-tree-string {
  color: var(--json-tree-string);
}

.json-tree-number {
  color: var(--json-tree-number);
}

.json-tree-boolean {
  color: var(--json-tree-boolean);
}

.json-tree-null {
  color: var(--json-tree-null);
  font-style: italic;
}

.json-tree-index,
.json-tree-punctuation,
.json-tree-summary {
  color: hsl(var(--muted-foreground));
}

.json-tree-bracket {
  color: hsl(var(--foreground));
  font-weight: 650;
}

.dark .json-tree {
  --json-tree-key: #93c5fd;
  --json-tree-string: #86efac;
  --json-tree-number: #fbbf24;
  --json-tree-boolean: #c4b5fd;
  --json-tree-null: #94a3b8;
}
</style>
