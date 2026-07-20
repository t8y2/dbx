import { normalizeVisibleSchemaSelection } from "@/lib/database/visibleDatabases";

export type VisibleSchemaSaveAction = { type: "none" } | { type: "clear" } | { type: "set"; schemaNames: string[] };

export function initialVisibleSchemaSelection(schemaNames: string[], configured: string[] | undefined, emptySelectionMeansAll = false): Set<string> {
  if (configured === undefined || (emptySelectionMeansAll && configured.length === 0)) return new Set(schemaNames);
  return new Set(normalizeVisibleSchemaSelection(configured, schemaNames));
}

export function selectVisibleSchemas(schemaNames: string[]): Set<string> {
  return new Set(schemaNames);
}

export function addVisibleSchemas(selection: Set<string>, schemaNames: string[]): Set<string> {
  const next = new Set(selection);
  for (const name of schemaNames) next.add(name);
  return next;
}

export function resolveVisibleSchemaSaveAction(selection: Set<string>, schemaNames: string[], configured: string[] | undefined): VisibleSchemaSaveAction {
  const normalized = normalizeSelectionInSchemaOrder(selection, schemaNames);
  const availableCount = new Set(schemaNames).size;

  if (normalized.length === availableCount) {
    return configured ? { type: "clear" } : { type: "none" };
  }
  if (configured && sameSelection(normalized, normalizeVisibleSchemaSelection(configured, schemaNames))) {
    return { type: "none" };
  }
  return { type: "set", schemaNames: normalized };
}

function normalizeSelectionInSchemaOrder(selection: Set<string>, schemaNames: string[]): string[] {
  return normalizeVisibleSchemaSelection(
    schemaNames.filter((name) => selection.has(name)),
    schemaNames,
  );
}

function sameSelection(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((name) => rightSet.has(name));
}
