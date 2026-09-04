import { isLosslessJsonNumber, parseJsonPreservingLargeNumbers } from "@/lib/common/safeJsonFormat";
import { heatLevel as planHeatLevel } from "@/lib/diagram/planCanvas";
import { isElasticsearchCompatibleDatabaseType, type DatabaseType, type QueryResult } from "@/types/database";

/**
 * Visual Search Profiler for Elasticsearch `_search?profile=true` responses.
 *
 * Parses the `profile.shards[].searches[].query[]` timing tree so the frontend
 * can render it as a collapsible tree with cost-share progress bars. The
 * response body is preserved end-to-end by the REST-DSL query path
 * (`QueryResult.elasticsearch_raw_body` or the two-column status/response
 * result), so this is a pure-frontend feature — no Rust changes.
 *
 * `time_in_nanos` is cumulative over a node's subtree; `breakdown` is the
 * node's own per-phase time. `selfTimeInNanos = timeInNanos − Σ children`,
 * matching the self-cost accounting used by the SQL explain `planCanvas`.
 */

export type ElasticsearchProfileHeatLevel = "none" | "cool" | "warm" | "hot";

export interface ElasticsearchProfileNode {
  /** Lucene query type, e.g. "BooleanQuery" / "TermQuery". */
  type: string;
  /** Human-readable query description when Elasticsearch provides one. */
  description?: string;
  /** Cumulative time including children, in nanoseconds. */
  timeInNanos: number;
  /** The node's own per-phase timings (next_doc / build_scorer / score / …). */
  breakdown?: Record<string, number>;
  children: ElasticsearchProfileNode[];
  /** timeInNanos minus the children's cumulative time, clamped to ≥ 0. */
  selfTimeInNanos: number;
  /** selfTime / total self time of the shard's tree (planCanvas semantics). */
  costShare: number;
  heatLevel: ElasticsearchProfileHeatLevel;
  /** Marked along the single highest-cost child chain down to a leaf. */
  isCriticalPath: boolean;
}

export interface ElasticsearchProfileShard {
  id: string;
  tree: ElasticsearchProfileNode;
  totalTimeInNanos: number;
  /** Number of _search requests profiled on this shard (>1 when merged under a wrapper node). */
  searchCount?: number;
}

export interface ElasticsearchProfileData {
  /** Shards sorted by total time, highest first. */
  shards: ElasticsearchProfileShard[];
  /** The parsed `profile` section, kept for a potential raw view. */
  raw: unknown;
}

interface RawQueryNode {
  type?: unknown;
  description?: unknown;
  time_in_nanos?: unknown;
  breakdown?: unknown;
  children?: unknown;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Reads a numeric literal, including large numbers preserved by safeJsonFormat. */
function readProfileNumber(value: unknown): number {
  if (isLosslessJsonNumber(value)) {
    const parsed = Number(value.raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

function mapQueryNode(raw: RawQueryNode): ElasticsearchProfileNode {
  const childrenRaw = Array.isArray(raw.children) ? raw.children : [];
  const children: ElasticsearchProfileNode[] = [];
  for (const child of childrenRaw) {
    const record = readRecord(child);
    if (record) children.push(mapQueryNode(record as RawQueryNode));
  }

  const timeInNanos = Math.max(0, readProfileNumber(raw.time_in_nanos));
  const childrenTotal = children.reduce((sum, child) => sum + child.timeInNanos, 0);
  const selfTimeInNanos = Math.max(0, timeInNanos - childrenTotal);

  let breakdown: Record<string, number> | undefined;
  const breakdownRaw = readRecord(raw.breakdown);
  if (breakdownRaw) {
    const entries = Object.entries(breakdownRaw)
      .map(([name, value]) => [name, readProfileNumber(value)] as const)
      .filter(([, value]) => value > 0);
    if (entries.length > 0) breakdown = Object.fromEntries(entries);
  }

  return {
    type: typeof raw.type === "string" && raw.type ? raw.type : "Query",
    description: typeof raw.description === "string" && raw.description ? raw.description : undefined,
    timeInNanos,
    breakdown,
    children,
    selfTimeInNanos,
    costShare: 0,
    heatLevel: "none",
    isCriticalPath: false,
  };
}

function applyCostShares(node: ElasticsearchProfileNode, denominator: number): void {
  node.costShare = node.selfTimeInNanos / denominator;
  // Zero-cost nodes render a plain label, not a green "cool" bar.
  node.heatLevel = node.selfTimeInNanos > 0 ? planHeatLevel(node.costShare) : "none";
  for (const child of node.children) applyCostShares(child, denominator);
}

function markCriticalPath(node: ElasticsearchProfileNode): void {
  node.isCriticalPath = true;
  if (node.children.length === 0) return;
  let best = node.children[0];
  for (const child of node.children) {
    if (child.costShare > best.costShare) best = child;
  }
  markCriticalPath(best);
}

/**
 * Populates costShare/heatLevel/isCriticalPath for the tree. The total self
 * time telescopes to the tree root's cumulative time, so `root.timeInNanos`
 * is the same denominator planCanvas uses for SQL explain nodes.
 */
function finalizeTree(node: ElasticsearchProfileNode): void {
  if (node.timeInNanos > 0) applyCostShares(node, node.timeInNanos);
  markCriticalPath(node);
}

interface BuiltShard {
  tree: ElasticsearchProfileNode;
  total: number;
  searchCount: number;
}

/** Builds a single query tree for one shard from its `searches[]` array. */
function buildShard(searches: unknown): BuiltShard | null {
  const searchList = Array.isArray(searches) ? searches : [];
  const queryRoots: ElasticsearchProfileNode[] = [];
  for (const search of searchList) {
    const record = readRecord(search);
    if (!record) continue;
    const queryArray = Array.isArray(record.query) ? record.query : [];
    for (const query of queryArray) {
      const queryRecord = readRecord(query);
      if (queryRecord) queryRoots.push(mapQueryNode(queryRecord as RawQueryNode));
    }
  }
  if (queryRoots.length === 0) return null;

  const total = queryRoots.reduce((sum, root) => sum + root.timeInNanos, 0);
  // A single search keeps its real query root as the tree; multiple searches
  // are merged under a synthetic "search" container so cost shares stay on one
  // comparable scale.
  let tree: ElasticsearchProfileNode;
  if (queryRoots.length === 1) {
    tree = queryRoots[0];
  } else {
    tree = {
      type: "search",
      timeInNanos: total,
      children: queryRoots,
      selfTimeInNanos: 0,
      costShare: 0,
      heatLevel: "none",
      isCriticalPath: false,
    };
  }
  finalizeTree(tree);
  return { tree, total, searchCount: queryRoots.length };
}

/**
 * Parses an Elasticsearch `_search` response body into the profiler tree.
 * Returns `null` for malformed JSON, a missing/invalid `profile` section,
 * absent/empty `shards`, or searches with no query nodes — never throws.
 */
export function parseElasticsearchProfile(body: string): ElasticsearchProfileData | null {
  let parsed: unknown;
  try {
    parsed = parseJsonPreservingLargeNumbers(body);
  } catch {
    return null;
  }
  const root = readRecord(parsed);
  if (!root) return null;
  const profile = readRecord(root.profile);
  if (!profile) return null;

  const shardsRaw = profile.shards;
  if (!Array.isArray(shardsRaw) || shardsRaw.length === 0) return null;

  const shards: ElasticsearchProfileShard[] = [];
  for (const shardRaw of shardsRaw) {
    const record = readRecord(shardRaw);
    if (!record) continue;
    const id = typeof record.id === "string" && record.id ? record.id : String(shards.length + 1);
    const built = buildShard(record.searches);
    if (!built) continue;
    shards.push({ id, tree: built.tree, totalTimeInNanos: built.total, searchCount: built.searchCount });
  }
  if (shards.length === 0) return null;

  shards.sort((a, b) => b.totalTimeInNanos - a.totalTimeInNanos);
  return { shards, raw: profile };
}

/**
 * Extracts the ES response body from a query result, either the preserved raw
 * REST body (`elasticsearch_raw_body`) or the two-column status/response
 * single-row shape used for large/error responses. Non-ES databases return null.
 */
export function elasticsearchProfileBodyForResult(databaseType: DatabaseType | undefined, result: QueryResult | undefined): string | null {
  if (!isElasticsearchCompatibleDatabaseType(databaseType) || !result) return null;
  if (typeof result.elasticsearch_raw_body === "string" && result.elasticsearch_raw_body.length > 0) return result.elasticsearch_raw_body;

  if (result.columns.length === 2 && result.columns[0] === "status" && result.columns[1] === "response" && result.rows.length === 1) {
    const body = result.rows[0]?.[1];
    if (typeof body === "string" && body.length > 0) return body;
  }
  return null;
}

/** Counts every node in the tree, including the root. */
export function countProfileNodes(node: ElasticsearchProfileNode): number {
  let count = 1;
  for (const child of node.children) count += countProfileNodes(child);
  return count;
}

/** Maximum depth below the given node (leaf = 0). */
export function maxProfileDepth(node: ElasticsearchProfileNode): number {
  if (node.children.length === 0) return 0;
  let max = 0;
  for (const child of node.children) max = Math.max(max, maxProfileDepth(child));
  return 1 + max;
}

function trimZero(value: string): string {
  return value.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

/** Formats nanoseconds as ns / µs / ms / s with sensible rounding. */
export function formatProfileNanos(nanos: number): string {
  const value = Math.max(0, nanos);
  if (value >= 1e9) return `${trimZero((value / 1e9).toFixed(2))}s`;
  if (value >= 1e6) {
    const ms = value / 1e6;
    return `${trimZero(ms.toFixed(ms >= 100 ? 0 : 1))}ms`;
  }
  if (value >= 1e3) {
    const us = value / 1e3;
    return `${trimZero(us.toFixed(us >= 100 ? 0 : 1))}µs`;
  }
  return `${value}ns`;
}
