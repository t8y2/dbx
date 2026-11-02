import type { PgPartitionBound, PgPartitionKind, PgPartitionNode } from "@/types/database";

/** One flattened row of a partition tree, carrying what a renderer needs. */
export interface PgPartitionTreeRow {
  key: string;
  /** 0 for a top-level partition of the table; +1 per nesting level. */
  depth: number;
  node: PgPartitionNode;
  /** Direct parent identity, used by detach operations on nested partitions. */
  parentSchema?: string;
  parentName?: string;
  /** Keys of every ancestor above this row, outermost first (for collapse). */
  ancestorKeys: string[];
}

export interface PgPartitionParentIdentity {
  schema?: string;
  name?: string;
}

/**
 * Depth-first flatten of a partition tree so a renderer can show multi-level
 * hierarchies without recursive components. Nesting is conveyed by indentation
 * and the fold control; no tree guide lines are drawn.
 */
export function flattenPgPartitionNodes(nodes: PgPartitionNode[], rootParent: PgPartitionParentIdentity = {}): PgPartitionTreeRow[] {
  return flattenPgPartitionNodesAtDepth(nodes, rootParent, 0, "", []);
}

function flattenPgPartitionNodesAtDepth(nodes: PgPartitionNode[], parent: PgPartitionParentIdentity, depth: number, keyPrefix: string, ancestorKeys: string[]): PgPartitionTreeRow[] {
  const rows: PgPartitionTreeRow[] = [];
  for (const node of nodes) {
    const key = `${keyPrefix}${node.schema}.${node.name}`;
    rows.push({ key, depth, node, parentSchema: parent.schema, parentName: parent.name, ancestorKeys: [...ancestorKeys] });
    if (node.children.length > 0) {
      rows.push(...flattenPgPartitionNodesAtDepth(node.children, { schema: node.schema, name: node.name }, depth + 1, `${key}/`, [...ancestorKeys, key]));
    }
  }
  return rows;
}

/** Pixels of indentation added per nesting level. */
export const PARTITION_TREE_INDENT_PX = 16;

/**
 * Drops rows hidden behind a collapsed ancestor, so a renderer can show a
 * folded tree without re-walking it.
 */
export function visiblePgPartitionRows(rows: PgPartitionTreeRow[], collapsedKeys: ReadonlySet<string>): PgPartitionTreeRow[] {
  if (collapsedKeys.size === 0) return rows;
  return rows.filter((row) => !row.ancestorKeys.some((key) => collapsedKeys.has(key)));
}

export type PartitionTranslate = (key: string, params?: Record<string, unknown>) => string;

/**
 * Hover hint for a partition row. The estimated row count and size are kept out
 * of the row body (they doubled every row's height) and surfaced here instead.
 */
export function pgPartitionRowHint(node: PgPartitionNode, t: PartitionTranslate, formatBytes: (value: number) => string): string | undefined {
  const parts: string[] = [];
  if (node.rowEstimate != null) parts.push(t("structureEditor.partitionsRowEstimate", { count: node.rowEstimate }));
  if (node.totalBytes != null) parts.push(t("structureEditor.partitionsSize", { size: formatBytes(node.totalBytes) }));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Renders a parsed bound as the SQL fragment PostgreSQL uses in `CREATE TABLE ... PARTITION OF`. */
export function pgPartitionBoundText(bound?: PgPartitionBound): string {
  if (!bound) return "";
  if (bound.kind === "default") return "DEFAULT";
  if (bound.kind === "range") return `FROM (${bound.from.join(", ")}) TO (${bound.to.join(", ")})`;
  if (bound.kind === "list") return `IN (${bound.values.join(", ")})`;
  return `MODULUS ${bound.modulus} REMAINDER ${bound.remainder}`;
}

/**
 * Bound text for a tree node, falling back to the raw catalog definition when
 * the bound shape was not recognized by the backend parser.
 */
export function pgPartitionNodeBoundText(node: PgPartitionNode): string {
  return node.bound ? pgPartitionBoundText(node.bound) : node.boundDefinition || "";
}

/**
 * Splits user-entered partition bound values on top-level commas only. Commas
 * inside single quotes (with `''` escapes) or nested parentheses stay in the
 * value, so `lower('a,b'), 2` yields two values.
 */
export function splitPgPartitionBoundValues(input: string): string[] {
  const values: string[] = [];
  let current = "";
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (ch === "'" && !inDouble) {
      if (inSingle && input[index + 1] === "'") {
        current += "''";
        index += 1;
        continue;
      }
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble && ch === "(") depth += 1;
    if (!inSingle && !inDouble && ch === ")") depth -= 1;
    if (ch === "," && !inSingle && !inDouble && depth === 0) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  values.push(current.trim());
  return values.filter((value) => value.length > 0);
}

/** Translation key for a partition strategy label. */
export function pgPartitionKindLabelKey(kind?: PgPartitionKind): string | undefined {
  if (kind === "range") return "structureEditor.partitionKindRange";
  if (kind === "list") return "structureEditor.partitionKindList";
  if (kind === "hash") return "structureEditor.partitionKindHash";
  return undefined;
}
