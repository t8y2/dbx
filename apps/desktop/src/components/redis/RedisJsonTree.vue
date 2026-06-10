<script setup lang="ts">
import { computed, defineComponent, h, ref, type VNodeChild } from "vue";
import { ChevronDown, ChevronRight } from "@lucide/vue";
import { Button } from "@/components/ui/button";

defineOptions({ name: "RedisJsonTree" });

const props = withDefaults(
  defineProps<{
    value: unknown;
    wordWrap?: boolean;
    highlightJson?: (json: string) => string;
  }>(),
  {
    wordWrap: true,
    highlightJson: undefined,
  },
);

const collapsedPaths = ref(new Set<string>());

type JsonNode = {
  key: string;
  label: string;
  value: unknown;
  path: string;
  depth: number;
  parentKind: "object" | "array" | "root";
};

const rootNode = computed<JsonNode>(() => ({
  key: "$",
  label: "$",
  value: props.value,
  path: "$",
  depth: 0,
  parentKind: "root",
}));

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

function containerKind(value: unknown): "array" | "object" {
  return Array.isArray(value) ? "array" : "object";
}

function childNodes(node: JsonNode): JsonNode[] {
  if (!isContainer(node.value)) return [];
  if (Array.isArray(node.value)) {
    return node.value.map((value, index) => ({
      key: String(index),
      label: String(index),
      value,
      path: `${node.path}[${index}]`,
      depth: node.depth + 1,
      parentKind: "array",
    }));
  }
  return Object.entries(node.value).map(([key, value]) => ({
    key,
    label: key,
    value,
    path: `${node.path}.${key}`,
    depth: node.depth + 1,
    parentKind: "object",
  }));
}

function nodeSummary(value: unknown): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (isContainer(value)) return `Object(${Object.keys(value).length})`;
  return "";
}

function scalarClass(value: unknown): string {
  if (typeof value === "string") return "json-tree-string";
  if (typeof value === "number") return "json-tree-number";
  if (typeof value === "boolean") return "json-tree-boolean";
  if (value === null) return "json-tree-null";
  return "json-tree-string";
}

function scalarText(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}

function highlightedJsonSpan(className: string, json: string): VNodeChild {
  if (!props.highlightJson) return h("span", { class: className }, json);
  return h("span", { class: className, innerHTML: props.highlightJson(json) });
}

function isCollapsed(path: string): boolean {
  return collapsedPaths.value.has(path);
}

function toggleCollapsed(path: string) {
  const next = new Set(collapsedPaths.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsedPaths.value = next;
}

function renderJsonNode(node: JsonNode): VNodeChild {
  const children = childNodes(node);
  const container = isContainer(node.value);
  const collapsed = isCollapsed(node.path);
  const indent = `${node.depth * 16}px`;
  const rowChildren: VNodeChild[] = [];

  if (container) {
    rowChildren.push(
      h(
        Button,
        {
          variant: "ghost",
          size: "icon",
          class: "redis-json-toggle",
          onClick: () => toggleCollapsed(node.path),
        },
        () => (collapsed ? h(ChevronRight, { class: "h-3.5 w-3.5" }) : h(ChevronDown, { class: "h-3.5 w-3.5" })),
      ),
    );
  } else {
    rowChildren.push(h("span", { class: "redis-json-spacer" }));
  }

  if (node.parentKind !== "root") {
    rowChildren.push(node.parentKind === "array" ? h("span", { class: "redis-json-index" }, `[${node.label}]`) : highlightedJsonSpan("redis-json-key", JSON.stringify(node.label)), h("span", { class: "redis-json-colon" }, ":"));
  }

  if (container) {
    rowChildren.push(
      h("span", { class: `redis-json-bracket is-${containerKind(node.value)}` }, Array.isArray(node.value) ? "[" : "{"),
      h("span", { class: "redis-json-summary" }, nodeSummary(node.value)),
      h("span", { class: `redis-json-bracket is-${containerKind(node.value)}` }, Array.isArray(node.value) ? "]" : "}"),
    );
  } else {
    rowChildren.push(highlightedJsonSpan(scalarClass(node.value), scalarText(node.value)));
  }

  return h("div", { class: "redis-json-node" }, [h("div", { class: "redis-json-row", style: { paddingLeft: indent } }, rowChildren), container && !collapsed ? h("div", { class: "redis-json-children" }, children.map(renderJsonNode)) : null]);
}

const JsonTreeNode = defineComponent({
  name: "JsonTreeNode",
  setup() {
    return () => renderJsonNode(rootNode.value);
  },
});
</script>

<template>
  <div class="redis-json-tree" :class="{ 'is-nowrap': !wordWrap }">
    <JsonTreeNode />
  </div>
</template>

<style scoped>
.redis-json-tree {
  color: hsl(var(--foreground));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.redis-json-tree.is-nowrap {
  white-space: pre;
  overflow-wrap: normal;
}

.redis-json-row {
  display: flex;
  min-height: 24px;
  align-items: flex-start;
  gap: 4px;
}

.redis-json-toggle {
  margin-top: 1px;
  height: 18px;
  width: 18px;
  flex: 0 0 auto;
  color: hsl(var(--muted-foreground));
}

.redis-json-spacer {
  width: 18px;
  flex: 0 0 auto;
}

.redis-json-key {
  color: #1d4ed8;
}

.redis-json-index,
.redis-json-colon,
.redis-json-summary {
  color: hsl(var(--muted-foreground));
}

.redis-json-string {
  color: #15803d;
}

.redis-json-number {
  color: #b45309;
}

.redis-json-boolean {
  color: #7c3aed;
}

.redis-json-null {
  color: #64748b;
  font-style: italic;
}

.redis-json-bracket {
  color: hsl(var(--foreground));
  font-weight: 650;
}

:global(.dark) .redis-json-key {
  color: #93c5fd;
}

:global(.dark) .redis-json-string {
  color: #86efac;
}

:global(.dark) .redis-json-number {
  color: #fbbf24;
}

:global(.dark) .redis-json-boolean {
  color: #c4b5fd;
}

:global(.dark) .redis-json-null {
  color: #94a3b8;
}
</style>
