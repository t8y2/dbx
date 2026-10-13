import { createJsonTreeRoot, getJsonTreeChildren, isJsonTreeContainer, type JsonTreeNode } from "./jsonTree";
import { isLosslessJsonNumber } from "./safeJsonFormat";
import { findTextContentMatches, TEXT_CONTENT_SEARCH_MATCH_LIMIT, type TextContentSearchOptions } from "./textContentSearch";

export function jsonTreeScalarText(value: unknown): string {
  if (isLosslessJsonNumber(value)) return value.raw;
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}

export interface JsonTreeSearchMatch {
  path: string;
  part: "key" | "value";
  start: number;
  end: number;
}

export interface JsonTreeSearchPart {
  path: string;
  part: "key" | "value";
  text: string;
}

/** Render before crossing the worker boundary: lossless numbers use symbol tags. */
export function* jsonTreeSearchParts(value: unknown): Generator<JsonTreeSearchPart> {
  const pending = [createJsonTreeRoot(value)];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.parentKind !== "root") yield { path: node.path, part: "key", text: jsonTreeKeyText(node) };
    if (!isJsonTreeContainer(node.value)) yield { path: node.path, part: "value", text: jsonTreeScalarText(node.value) };
    const children = getJsonTreeChildren(node);
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
}

export function findJsonTreePartMatches(parts: Iterable<JsonTreeSearchPart>, query: string, options: TextContentSearchOptions = {}): JsonTreeSearchMatch[] {
  if (!query) return [];
  const result: JsonTreeSearchMatch[] = [];
  for (const { path, part, text } of parts) {
    for (const match of findTextContentMatches(text, query, TEXT_CONTENT_SEARCH_MATCH_LIMIT - result.length, options)) result.push({ ...match, path, part });
    if (result.length >= TEXT_CONTENT_SEARCH_MATCH_LIMIT) break;
  }
  return result;
}

/** Search the tree's rendered labels and scalars, including collapsed nodes. */
export function findJsonTreeMatches(value: unknown, query: string, options: TextContentSearchOptions = {}): JsonTreeSearchMatch[] {
  return findJsonTreePartMatches(jsonTreeSearchParts(value), query, options);
}

export function jsonTreeKeyText(node: JsonTreeNode): string {
  return node.parentKind === "array" ? `[${node.label}]` : JSON.stringify(node.label);
}
