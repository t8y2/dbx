import { isLosslessJsonNumber } from "./safeJsonFormat";

export type JsonTreeContainerKind = "array" | "object";
export type JsonTreeParentKind = JsonTreeContainerKind | "root";

export interface JsonTreeNode {
  key: string;
  label: string;
  value: unknown;
  /** RFC 6901 JSON Pointer. The root value is represented by an empty string. */
  path: string;
  /** Zero-based structural depth; the root value is at depth zero. */
  depth: number;
  parentKind: JsonTreeParentKind;
}

export type JsonTreeContainer = Record<string, unknown> | unknown[];

export function createJsonTreeRoot(value: unknown): JsonTreeNode {
  return {
    key: "$",
    label: "$",
    value,
    path: "",
    depth: 0,
    parentKind: "root",
  };
}

export function isJsonTreeContainer(value: unknown): value is JsonTreeContainer {
  // LosslessJsonNumber is an object wrapper, but represents a scalar JSON number.
  return value !== null && typeof value === "object" && !isLosslessJsonNumber(value);
}

export function jsonTreeContainerKind(value: JsonTreeContainer): JsonTreeContainerKind {
  return Array.isArray(value) ? "array" : "object";
}

export function jsonTreeContainerSummary(value: JsonTreeContainer, includeObjectLength = true): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  return includeObjectLength ? `Object(${Object.keys(value).length})` : "Object";
}

/** Escape a reference token according to RFC 6901. */
export function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function appendJsonPointer(path: string, segment: string | number): string {
  return `${path}/${escapeJsonPointerSegment(String(segment))}`;
}

/**
 * Create child nodes only for an already-expanded parent. Callers should not
 * invoke this while a container is collapsed so large JSON payloads stay lazy.
 */
export function getJsonTreeChildren(node: JsonTreeNode): JsonTreeNode[] {
  if (!isJsonTreeContainer(node.value)) return [];

  if (Array.isArray(node.value)) {
    return node.value.map((value, index) => ({
      key: String(index),
      label: String(index),
      value,
      path: appendJsonPointer(node.path, index),
      depth: node.depth + 1,
      parentKind: "array",
    }));
  }

  return Object.entries(node.value).map(([key, value]) => ({
    key,
    label: key,
    value,
    path: appendJsonPointer(node.path, key),
    depth: node.depth + 1,
    parentKind: "object",
  }));
}

/**
 * Flatten the currently expanded tree with an iterative traversal. This lets
 * virtual renderers keep every node logically expanded without recursive DOM
 * creation or deep-call-stack failures.
 */
export function getVisibleJsonTreeNodes(root: JsonTreeNode, isExpanded: (node: JsonTreeNode) => boolean): JsonTreeNode[] {
  const nodes: JsonTreeNode[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    nodes.push(node);

    if (!isJsonTreeContainer(node.value) || !isExpanded(node)) continue;
    const children = getJsonTreeChildren(node);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }

  return nodes;
}

/**
 * `initialExpandedDepth` counts container levels from the root. For example,
 * a value of 2 expands the root and its direct container children.
 */
export function isJsonTreeInitiallyExpanded(depth: number, initialExpandedDepth: number): boolean {
  if (initialExpandedDepth === Number.POSITIVE_INFINITY) return true;
  if (!Number.isFinite(initialExpandedDepth)) return false;
  return depth < Math.max(0, Math.floor(initialExpandedDepth));
}
